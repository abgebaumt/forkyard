//! The request of "Compose commits" (v1.2, Teilpaket 3.2): the units as the provider sees them,
//! the answer schema and the way back from the answer to unit IDs.
//!
//! Units go out under short aliases (`u1`, `u2` …, in the order of the units): the real IDs carry
//! paths and tokens that would cost tokens and that redaction could alter. Only units that appear
//! in the text get an alias, so an answer can name nothing the provider has not seen. Secret and
//! ignored files do not appear at all (Grundregel 5); generated files, binaries and files cut for
//! the budget appear by name with their aliases. The answer only assigns aliases to commits –
//! `compose_apply` builds every patch itself.

use std::collections::{HashMap, HashSet};

use serde_json::{json, Value};

use super::units::{self, ChangedFile, ComposeRead};
use crate::ai::context::{self, Built, DiffFile, Exclusions, Shown, CHARS_PER_TOKEN};
use crate::ai::language;
use crate::ai::prompt::{self, Section};
use crate::app::Core;
use crate::commands::diff::patch::{FilePatch, LineKind};
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::model::{AiOmitReason, AiOmitted, ComposeGroup, ComposeKeep, ComposeNote, ComposeUnitKind, Settings};
use crate::util;

pub(crate) const INSTRUCTION: &str = "Split the local changes below into a few focused commits that each make sense on their own. \
Every change carries a unit alias in square brackets, for example [unit u3]. Assign every alias at most once; leave out aliases \
that should not be committed (debug output, unrelated experiments) – they stay uncommitted. Order the commits so that each one \
builds on the ones before it. Give every commit a summary of at most 72 characters in the imperative mood and a body that may be \
empty. Write summary and body in the language and the style of the recent commit subjects of this repository. If one commit is \
enough, answer with exactly one commit. For every commit, reason says in one short sentence why its changes belong together. \
For every unit, reason says in one short sentence why it is in this commit, and unsure is true when another commit or not \
committing it would be about as plausible; otherwise false.";
/// Longest instruction for a new proposal.
pub(crate) const MAX_INSTRUCTION_CHARS: usize = 300;
/// Longest reason of a commit or a unit that reaches the UI; longer ones are cut.
pub(crate) const MAX_REASON_CHARS: usize = 200;
/// More commits than this are not a sensible proposal.
pub(crate) const MAX_COMMITS: usize = 20;
/// Recent subjects for style and language (Grundregel 6).
const SUBJECTS: usize = 50;

pub(crate) struct ComposePrompt {
    pub(crate) built: Built,
    pub(crate) read: ComposeRead,
    /// Alias → unit ID.
    pub(crate) aliases: HashMap<String, String>,
    /// Aliases of the units the user placed: dropped from the answer, the UI keeps them.
    pub(crate) kept: HashSet<String>,
}

/// `{ commits: [{ title, body, reason, units: [{ unit, reason, unsure }] }] }` in the dialect of `ai::schema`.
pub(crate) fn answer_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "commits": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "body": {"type": "string"},
                        "reason": {"type": "string"},
                        "units": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "unit": {"type": "string"},
                                    "reason": {"type": "string"},
                                    "unsure": {"type": "boolean"}
                                },
                                "required": ["unit", "reason", "unsure"],
                                "additionalProperties": false
                            }
                        }
                    },
                    "required": ["title", "body", "reason", "units"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["commits"],
        "additionalProperties": false
    })
}

/// The user's instruction as one line; empty → `None`, longer than `MAX_INSTRUCTION_CHARS` → `not_allowed`.
pub(crate) fn clean_instruction(text: Option<&str>) -> CoreResult<Option<String>> {
    let Some(text) = text else { return Ok(None) };
    let spaced: String = text.chars().map(|c| if c.is_control() || c.is_whitespace() { ' ' } else { c }).collect();
    let cleaned = spaced.split(' ').filter(|word| !word.is_empty()).collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() {
        return Ok(None);
    }
    if cleaned.chars().count() > MAX_INSTRUCTION_CHARS {
        return Err(CoreError::not_allowed(format!("The instruction is longer than {MAX_INSTRUCTION_CHARS} characters. Say it in fewer words.")));
    }
    Ok(Some(cleaned))
}

/// The instruction with the repository's language when Paket 3.1's detector recognises one from
/// the last 50 subjects (Grundregel 6); otherwise the model follows the example subjects. The
/// user's own instruction comes last, delimited like every request in the user's words.
pub(crate) fn instruction(language: Option<&str>, own: Option<&str>, kept: bool) -> String {
    let mut text = match language {
        Some(language) => format!("{INSTRUCTION} This repository writes its commit messages in {language}: write summary and body in {language}."),
        None => INSTRUCTION.to_string(),
    };
    if kept {
        text.push_str(" The user already placed the changes listed under \"Placed by the user\": leave their aliases out of your answer and group the other changes around them.");
    }
    if let Some(own) = own {
        text.push_str(&format!("\nThe user's instruction for this proposal, in their own words (follow it where the changes allow): «{own}»"));
    }
    text
}

/// What the user adds to a new proposal.
#[derive(Debug, Clone, Default)]
pub(crate) struct Steering {
    pub(crate) instruction: Option<String>,
    pub(crate) keep: Vec<ComposeKeep>,
}

pub(crate) async fn build(core: &Core, repo_id: &str, settings: &Settings, budget_tokens: u64, locale: &str, secrets: &[String], steering: &Steering) -> CoreResult<ComposePrompt> {
    let own = clean_instruction(steering.instruction.as_deref())?;
    let read = units::read(core, repo_id).await?;
    if read.files.is_empty() {
        return Err(CoreError::new(ErrorCode::NothingToCommit, "There are no local changes to compose."));
    }
    let exclusions = Exclusions::load(core, repo_id, &settings.ai_exclude).await?;
    let mut aliases = HashMap::new();
    let mut names: HashMap<String, Vec<String>> = HashMap::new();
    let mut omitted = Vec::new();
    let mut files = Vec::new();
    for file in &read.files {
        if let Some(reason) = file.protected {
            omitted.push(AiOmitted { path: file.path.clone(), reason, size: 0 });
            continue;
        }
        let list: Vec<String> = file
            .unit_ids()
            .into_iter()
            .map(|id| {
                let alias = format!("u{}", aliases.len() + 1);
                aliases.insert(alias.clone(), id);
                alias
            })
            .collect();
        files.push(diff_file(file, &list));
        names.insert(file.path.clone(), list);
    }
    let fitted = context::fit(files, &exclusions, (budget_tokens as f64 * CHARS_PER_TOKEN) as usize);
    omitted.extend(fitted.omitted.iter().cloned());
    let by_path: HashMap<&str, &ChangedFile> = read.files.iter().map(|file| (file.path.as_str(), file)).collect();
    let mut parts = Vec::new();
    for (entry, shown) in &fitted.entries {
        if let (Some(file), Some(list)) = (by_path.get(entry.path.as_str()), names.get(&entry.path)) {
            parts.push(render(file, entry, *shown, list));
        }
    }
    let changes = context::redact_for_ai(&parts.join("\n"), secrets);
    // Placed by the user: only units the text names by alias (a protected or unknown unit is not mentioned).
    let by_id: HashMap<&str, &str> = aliases.iter().map(|(alias, id)| (id.as_str(), alias.as_str())).collect();
    let mut kept = HashSet::new();
    let mut placed = Vec::new();
    for keep in &steering.keep {
        let Some(alias) = by_id.get(keep.unit.as_str()) else { continue };
        if !kept.insert(alias.to_string()) {
            continue;
        }
        placed.push(match &keep.commit {
            Some(subject) => format!("[unit {alias}] is in the commit “{}”", one_line(subject, 100)),
            None => format!("[unit {alias}] is not committed"),
        });
    }
    let subjects = recent_subjects(core, repo_id).await?;
    let own = own.map(|text| context::redact_for_ai(&text, secrets));
    let system_instruction = instruction(language::detect(&subjects), own.as_deref(), !placed.is_empty());
    let subjects = context::redact_for_ai(&subjects.join("\n"), secrets);
    let mut sections = vec![Section { title: "Local changes".into(), body: changes }];
    if !placed.is_empty() {
        sections.push(Section { title: "Placed by the user".into(), body: context::redact_for_ai(&placed.join("\n"), secrets) });
    }
    sections.push(Section { title: "Recent commit subjects of this repository".into(), body: subjects });
    let prompt = prompt::build(&system_instruction, locale, &sections);
    let shortened = fitted.shortened.clone();
    Ok(ComposePrompt { built: Built { prompt, omitted, shortened }, read, aliases, kept })
}

fn diff_file(file: &ChangedFile, names: &[String]) -> DiffFile {
    let mut out = match (file.kind, &file.patch) {
        (ComposeUnitKind::Binary | ComposeUnitKind::Lfs | ComposeUnitKind::Submodule, _) => DiffFile::binary(&file.path, 0),
        (kind, Some(patch)) => DiffFile::text(&file.path, &marked_patch(patch, kind == ComposeUnitKind::Hunk, names), u64::from(file.added), u64::from(file.removed)),
        (_, None) => DiffFile::text(&file.path, "", u64::from(file.added), u64::from(file.removed)),
    };
    out.old_path = file.old_path.clone();
    out
}

/// The patch as text; with `per_hunk` every `@@` line carries its alias (`shorten_patch` keeps
/// every `@@` line, so the aliases survive shortening).
fn marked_patch(patch: &FilePatch, per_hunk: bool, names: &[String]) -> String {
    let mut out = String::new();
    for (index, hunk) in patch.hunks.iter().enumerate() {
        out.push_str(&units::hunk_header(hunk));
        if let (true, Some(name)) = (per_hunk, names.get(index)) {
            out.push_str(&format!(" [unit {name}]"));
        }
        out.push('\n');
        for line in &hunk.lines {
            out.push(match line.kind {
                LineKind::Context => ' ',
                LineKind::Add => '+',
                LineKind::Remove => '-',
            });
            let content = line.content.strip_suffix(b"\r").unwrap_or(&line.content);
            out.push_str(&util::decode_text(content).0);
            out.push('\n');
            if line.no_newline {
                out.push_str("\\ No newline at end of file\n");
            }
        }
    }
    out
}

fn whole_note(file: &ChangedFile) -> String {
    match file.kind {
        ComposeUnitKind::Hunk | ComposeUnitKind::File => format!("whole file +{} -{}", file.added, file.removed),
        ComposeUnitKind::Added => format!("new file +{}", file.added),
        ComposeUnitKind::Deleted => format!("deleted file -{}", file.removed),
        ComposeUnitKind::Renamed => format!("renamed +{} -{}", file.added, file.removed),
        ComposeUnitKind::Binary => "binary file, content not sent".to_string(),
        ComposeUnitKind::Lfs => "Git LFS file, content not sent".to_string(),
        ComposeUnitKind::Submodule => "submodule".to_string(),
        ComposeUnitKind::Mode => format!("file mode {} → {}", file.entry.old_mode, file.entry.new_mode),
        ComposeUnitKind::Link => "symbolic link".to_string(),
    }
}

fn render(file: &ChangedFile, entry: &DiffFile, shown: Shown, names: &[String]) -> String {
    let split = file.kind == ComposeUnitKind::Hunk;
    let mut head = format!("File: {}", file.path);
    if let Some(old) = &file.old_path {
        head.push_str(&format!(" (renamed from {old})"));
    }
    if split {
        head.push_str(&format!(" +{} -{}", file.added, file.removed));
    } else {
        head.push_str(&format!(" – {}", whole_note(file)));
        for name in names {
            head.push_str(&format!(" [unit {name}]"));
        }
    }
    let tail = |note: &str| {
        let mut line = format!("{head} – {note}");
        if split {
            for name in names {
                line.push_str(&format!(" [unit {name}]"));
            }
        }
        format!("{line}\n")
    };
    match shown {
        Shown::Full => format!("{head}\n{}", entry.patch),
        Shown::Shortened => format!("{head} (shortened: start and end of each hunk)\n{}", context::shorten_patch(&entry.patch)),
        Shown::NameOnly(AiOmitReason::Binary) if !split => format!("{head}\n"),
        Shown::NameOnly(AiOmitReason::Generated) => tail("generated or lock file, content not sent"),
        Shown::NameOnly(AiOmitReason::Budget) => tail("content left out to stay within the size limit"),
        Shown::NameOnly(_) => tail("content not sent"),
    }
}

/// The last 50 commit subjects of HEAD, newest first (style examples and language detection).
async fn recent_subjects(core: &Core, repo_id: &str) -> CoreResult<Vec<String>> {
    let count = format!("--max-count={SUBJECTS}");
    let out = core.git_for(repo_id)?.args(["log", "-z", "--format=%s", count.as_str(), "HEAD", "--"]).read_only().no_log().run().await?;
    Ok(util::split_z(&out.stdout)
        .map(util::decode_lossy)
        .map(|subject| subject.trim().to_string())
        .filter(|subject| !subject.is_empty())
        .collect())
}

/// `text` as one line of at most `max` characters (cut with "…").
fn one_line(text: &str, max: usize) -> String {
    let text = text.replace(['\r', '\n'], " ");
    let text = text.trim();
    if text.chars().count() <= max {
        return text.to_string();
    }
    let cut: String = text.chars().take(max.saturating_sub(1)).collect();
    format!("{}…", cut.trim_end())
}

/// A reason of the answer: one line, at most `MAX_REASON_CHARS` characters.
fn reason_text(value: Option<&Value>) -> String {
    one_line(value.and_then(Value::as_str).unwrap_or(""), MAX_REASON_CHARS)
}

/// The provider's commits as unit IDs, and its note per unit. Unknown or doubled aliases, a commit
/// with units but without a summary, more than `MAX_COMMITS` commits or no commit at all:
/// `ai_invalid_answer`. Kept aliases are dropped – the user placed those units.
pub(crate) fn groups_from_answer(value: &Value, aliases: &HashMap<String, String>, kept: &HashSet<String>) -> CoreResult<(Vec<ComposeGroup>, Vec<ComposeNote>)> {
    let commits = value.get("commits").and_then(Value::as_array).ok_or_else(|| CoreError::ai_invalid_answer("no list of commits"))?;
    if commits.len() > MAX_COMMITS {
        return Err(CoreError::ai_invalid_answer(format!("more than {MAX_COMMITS} commits")));
    }
    let mut seen = HashSet::new();
    let mut groups = Vec::new();
    let mut notes = Vec::new();
    for commit in commits {
        let text = |key: &str| commit.get(key).and_then(Value::as_str).unwrap_or("").trim().to_string();
        let mut units = Vec::new();
        for entry in commit.get("units").and_then(Value::as_array).into_iter().flatten() {
            let alias = entry.get("unit").and_then(Value::as_str).unwrap_or("").trim();
            let Some(id) = aliases.get(alias) else {
                return Err(CoreError::ai_invalid_answer(format!("unknown unit “{}”", util::truncate_str(alias, 40))));
            };
            if !seen.insert(alias.to_string()) {
                return Err(CoreError::ai_invalid_answer(format!("unit “{alias}” is assigned twice")));
            }
            if kept.contains(alias) {
                continue;
            }
            units.push(id.clone());
            let unsure = entry.get("unsure").and_then(Value::as_bool).unwrap_or(false);
            notes.push(ComposeNote { unit: id.clone(), reason: reason_text(entry.get("reason")), unsure });
        }
        if units.is_empty() {
            continue;
        }
        let title = text("title").replace(['\r', '\n'], " ");
        if title.trim().is_empty() {
            return Err(CoreError::ai_invalid_answer("a commit without a summary"));
        }
        groups.push(ComposeGroup { title, body: text("body"), units, reason: reason_text(commit.get("reason")) });
    }
    if groups.is_empty() && kept.is_empty() {
        return Err(CoreError::ai_invalid_answer("no commit with changes"));
    }
    Ok((groups, notes))
}
