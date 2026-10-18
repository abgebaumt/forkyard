//! Paket 8.1: the AI proposes where to cut a branch into stacked pull requests.
//!
//! Context: per commit (numbered from 1, oldest first) the subject, up to six body lines and the
//! changed files with their line counts – never file contents. Secret and ignored paths (built-in
//! rules, `.forkyard/ai-ignore`, the global list, also as a rename's source) are not named and show
//! up once in "What is sent?". Everything is redacted and sent between the markers of
//! `ai::prompt`. The answer is data: its meaning is checked (`check_answer`) inside the one repair
//! attempt, names are turned into slugs by the core when planning.

use std::collections::BTreeMap;

use serde_json::{json, Value};

use crate::ai::context::{self, Built, Exclusions};
use crate::ai::prompt::{self, Section};
use crate::app::Core;
use crate::commands::stack::plan::{self as stack_plan, FileStat, SourceCommit, MAX_PARTS};
use crate::commands::stack::read_source;
use crate::error::{CoreError, CoreResult};
use crate::model::{AiOmitReason, AiOmitted, AiStackPart, AiStackSplit, Settings};

/// Body lines per commit while the budget allows.
pub const BODY_LINES: usize = 6;
pub const MAX_TITLE: usize = 300;
pub const COMMITS_TITLE: &str = "Commits of the branch (oldest first, numbered)";
/// Rough size of a section's title line and markers beyond title and body.
const SECTION_OVERHEAD: usize = 96;

pub const INSTRUCTION: &str = "Split the commits of a branch into a stack of pull requests that build on each other, so that each one is small and can be reviewed on its own. \
Cut only between commits and keep their order; never split, merge or reorder commits. The commits are numbered from 1 (the oldest). \
Return the parts in order. For each part, `end` is the number of its last commit, `name` is two to four words for its branch, `title` is the title of its pull request (one line, ideally at most 72 characters) and `why` is one sentence saying why this part stands on its own. \
The last part ends with the last commit. \
Write `name` and `title` in the language most of the commit subjects use and `why` in the user's language. \
If the branch is a single topic, return a single part.";

/// What `build` hands to the command and to `ai_preview`.
#[derive(Debug, Clone)]
pub struct StackBuilt {
    pub built: Built,
    /// Number of commits the answer's `end` values refer to.
    pub commits: usize,
}

pub fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "parts": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "end": { "type": "integer" },
                        "name": { "type": "string" },
                        "title": { "type": "string" },
                        "why": { "type": "string" }
                    },
                    "required": ["end", "name", "title", "why"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["parts"],
        "additionalProperties": false
    })
}

/// The meaning of an answer the schema already accepted: rising ends that finish with the last
/// commit, at most `MAX_PARTS` parts, usable one-line titles.
pub fn check_answer(value: &Value, commits: usize) -> Result<(), String> {
    let parts = value.get("parts").and_then(Value::as_array).ok_or("parts is missing")?;
    if parts.is_empty() {
        return Err("parts is empty; return at least one part".into());
    }
    if parts.len() > MAX_PARTS {
        return Err(format!("{} parts; at most {MAX_PARTS} are allowed", parts.len()));
    }
    let mut previous = 0u64;
    for (index, part) in parts.iter().enumerate() {
        let number = index + 1;
        let end = part.get("end").and_then(Value::as_u64).ok_or_else(|| format!("part {number}: end is not a positive whole number"))?;
        if end <= previous {
            return Err(format!("part {number}: end {end} must be greater than {previous}"));
        }
        if end as usize > commits {
            return Err(format!("part {number}: end {end} is beyond the last commit ({commits})"));
        }
        let title = part.get("title").and_then(Value::as_str).unwrap_or("").trim();
        if title.is_empty() {
            return Err(format!("part {number}: the title is empty"));
        }
        if title.contains(['\n', '\r']) {
            return Err(format!("part {number}: the title must be one line"));
        }
        if title.chars().count() > MAX_TITLE {
            return Err(format!("part {number}: the title has more than {MAX_TITLE} characters"));
        }
        previous = end;
    }
    if previous as usize != commits {
        return Err(format!("the last part ends at commit {previous}, but the branch has {commits} commits"));
    }
    Ok(())
}

/// The checked answer as the contract type, texts trimmed.
pub fn finish(value: &Value) -> AiStackSplit {
    let text = |part: &Value, key: &str| part.get(key).and_then(Value::as_str).unwrap_or_default().trim().to_string();
    let parts = value
        .get("parts")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
        .iter()
        .map(|part| AiStackPart { end: part.get("end").and_then(Value::as_u64).unwrap_or(0) as u32, name: text(part, "name"), title: text(part, "title"), why: text(part, "why") })
        .collect();
    AiStackSplit { parts }
}

enum Shown {
    Hidden(AiOmitReason),
    Visible { generated: bool },
}

fn shown(exclusions: &Exclusions, file: &FileStat) -> Shown {
    let hidden = |path: &str| exclusions.reason(path).filter(|reason| matches!(reason, AiOmitReason::Secret | AiOmitReason::Ignored));
    // A renamed secret stays a secret under its new name.
    if let Some(reason) = hidden(&file.path).or_else(|| file.old_path.as_deref().and_then(hidden)) {
        return Shown::Hidden(reason);
    }
    Shown::Visible { generated: exclusions.reason(&file.path) == Some(AiOmitReason::Generated) }
}

fn file_text(file: &FileStat, generated: bool) -> String {
    let mut notes = Vec::new();
    if let Some(old) = &file.old_path {
        notes.push(format!("renamed from {old}"));
    }
    match (file.added, file.deleted) {
        (Some(added), Some(deleted)) => notes.push(format!("+{added} -{deleted}")),
        _ => notes.push("binary".to_string()),
    }
    if generated {
        notes.push("generated or lock file".to_string());
    }
    format!("{} ({})", file.path, notes.join(", "))
}

fn render(commits: &[SourceCommit], exclusions: &Exclusions, body_lines: usize, with_files: bool) -> String {
    let mut out = String::new();
    for (index, commit) in commits.iter().enumerate() {
        out.push_str(&format!("{}. {}\n", index + 1, commit.subject));
        for line in commit.body.lines().take(body_lines) {
            out.push_str("   ");
            out.push_str(line);
            out.push('\n');
        }
        if with_files {
            let files: Vec<String> = commit
                .files
                .iter()
                .filter_map(|file| match shown(exclusions, file) {
                    Shown::Hidden(_) => None,
                    Shown::Visible { generated } => Some(file_text(file, generated)),
                })
                .collect();
            if !files.is_empty() {
                out.push_str(&format!("   files: {}\n", files.join(", ")));
            }
        }
    }
    out
}

fn size(sections: &[Section]) -> usize {
    sections.iter().map(|section| section.title.chars().count() + section.body.chars().count() + SECTION_OVERHEAD).sum()
}

/// The prompt for splitting `branch` above `base` (full ref of a branch). `secrets`: values known
/// to be secret (the provider key), scrubbed literally. Budget order: full → no bodies → no files.
#[allow(clippy::too_many_arguments)]
pub async fn build(core: &Core, repo_id: &str, settings: &Settings, branch: &str, base: &str, budget_tokens: u64, locale: &str, secrets: &[String]) -> CoreResult<StackBuilt> {
    let source = read_source(core, repo_id, branch, base).await?;
    let exclusions = Exclusions::load(core, repo_id, &settings.ai_exclude).await?;
    let mut hidden: BTreeMap<String, AiOmitReason> = BTreeMap::new();
    let mut visible: Vec<String> = Vec::new();
    for file in source.commits.iter().flat_map(|commit| commit.files.iter()) {
        match shown(&exclusions, file) {
            Shown::Hidden(reason) => {
                hidden.entry(file.path.clone()).or_insert(reason);
            }
            Shown::Visible { .. } => {
                if !visible.contains(&file.path) {
                    visible.push(file.path.clone());
                }
            }
        }
    }
    let budget_chars = (budget_tokens as f64 * context::CHARS_PER_TOKEN) as usize;
    let sections_for = |body_lines: usize, with_files: bool| -> Vec<Section> {
        vec![
            Section { title: "Branch".into(), body: format!("Branch: {}\nBase: {}\nCommits: {}", source.branch, stack_plan::short_ref(&source.base), source.commits.len()) },
            Section { title: COMMITS_TITLE.into(), body: render(&source.commits, &exclusions, body_lines, with_files) },
        ]
        .into_iter()
        .map(|mut section| {
            section.body = context::redact_for_ai(&section.body, secrets);
            section
        })
        .collect()
    };
    let chosen = [(BODY_LINES, true), (0, true), (0, false)].into_iter().find_map(|(body_lines, with_files)| {
        let sections = sections_for(body_lines, with_files);
        (size(&sections) <= budget_chars).then_some((sections, with_files))
    });
    let Some((sections, with_files)) = chosen else {
        return Err(CoreError::ai_too_large(format!(
            "The {} commits of “{}” do not fit into the model's context even without their files; split the branch by hand.",
            source.commits.len(),
            source.branch
        )));
    };
    let mut omitted: Vec<AiOmitted> = hidden.into_iter().map(|(path, reason)| AiOmitted { path, reason, size: 0 }).collect();
    if !with_files {
        omitted.extend(visible.into_iter().map(|path| AiOmitted { path, reason: AiOmitReason::Budget, size: 0 }));
    }
    let prompt = prompt::build(INSTRUCTION, locale, &sections);
    Ok(StackBuilt { built: Built { prompt, omitted, shortened: Vec::new() }, commits: source.commits.len() })
}

#[cfg(test)]
mod tests;
