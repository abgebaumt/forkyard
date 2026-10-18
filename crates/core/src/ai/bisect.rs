//! Bisect autopilot (9.1): the AI request that writes a test script.
//!
//! The answer is only text: it is checked against the schema, normalised and shown in the editor.
//! Nothing here runs it – `bisect_autopilot_run` does, after the user pressed "Run".
//!
//! The user's description and test command go into the instruction (they are the user's own
//! words, redacted). What comes from the repository goes into delimited sections, filled in a fixed
//! order while the budget allows: commit subjects good..bad (newest first), the top-level names of
//! the bad commit, a few build files, the changed paths. Secret and ignored paths are not mentioned
//! at all; build files that do not fit are named in the preview (reason `budget`).

use serde_json::{json, Value};

use crate::ai::context::{self, Built, Exclusions, CHARS_PER_TOKEN};
use crate::ai::prompt::{self, Section};
use crate::app::Core;
use crate::commands::graph::resolve_commit;
use crate::error::{CoreError, CoreResult};
use crate::git::GitCmd;
use crate::model::{AiOmitReason, AiOmitted, BisectScript, BisectScriptRequest, BisectShell, Settings};
use crate::util;

/// Larger scripts are refused (the editor shows the same limit).
pub const MAX_SCRIPT_BYTES: usize = 64 * 1024;
const MAX_SUMMARY: usize = 300;

impl BisectShell {
    /// The shell of this system.
    pub fn current() -> BisectShell {
        if cfg!(windows) {
            BisectShell::Powershell
        } else {
            BisectShell::Sh
        }
    }

    /// How the prompt names the shell and its call.
    pub fn prompt_name(self) -> &'static str {
        match self {
            BisectShell::Sh => "POSIX sh (run as `/bin/sh test.sh`)",
            BisectShell::Powershell => "Windows PowerShell 5.1 (run as `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File test.ps1`)",
        }
    }

    pub fn file_name(self) -> &'static str {
        match self {
            BisectShell::Sh => "test.sh",
            BisectShell::Powershell => "test.ps1",
        }
    }
}

/// The answer: the whole script and one sentence about what it checks (dialect of `ai::schema`).
pub fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "script": { "type": "string", "description": "The whole test script." },
            "summary": { "type": "string", "description": "One sentence: what the script checks." }
        },
        "required": ["script", "summary"],
        "additionalProperties": false
    })
}

/// One line ending for the shell (`exit 0\r` breaks `sh`), without a Markdown fence around the
/// whole script, with a final newline. An empty result stays empty.
pub fn normalize_script(script: &str, shell: BisectShell) -> String {
    let unified = script.replace("\r\n", "\n").replace('\r', "\n");
    let trimmed = unified.trim();
    let body = match trimmed.strip_prefix("```") {
        Some(rest) if trimmed.len() >= 6 && trimmed.ends_with("```") => {
            let inner = &rest[..rest.len() - 3];
            // The opening line may name the language (```sh).
            inner.split_once('\n').map(|(_, code)| code).unwrap_or("")
        }
        _ => trimmed,
    };
    let body = body.trim_matches('\n');
    if body.trim().is_empty() {
        return String::new();
    }
    let text = format!("{body}\n");
    match shell {
        BisectShell::Sh => text,
        BisectShell::Powershell => text.replace('\n', "\r\n"),
    }
}

/// Why a script cannot run, in words for errors; `None` = fine.
pub fn script_problem(script: &str) -> Option<&'static str> {
    if script.trim().is_empty() {
        Some("the script is empty")
    } else if script.len() > MAX_SCRIPT_BYTES {
        Some("the script is longer than 64 KiB")
    } else if script.contains('\0') {
        Some("the script contains a NUL byte")
    } else {
        None
    }
}

/// The checked answer of `complete_json` as a script for `shell`.
pub fn parse_answer(value: &Value, shell: BisectShell) -> CoreResult<BisectScript> {
    let script = normalize_script(value.get("script").and_then(Value::as_str).unwrap_or_default(), shell);
    if let Some(problem) = script_problem(&script) {
        return Err(CoreError::ai_invalid_answer(problem));
    }
    let summary: String = value.get("summary").and_then(Value::as_str).unwrap_or_default().trim().chars().take(MAX_SUMMARY).collect();
    Ok(BisectScript { script, summary, shell })
}

pub const MAX_DESCRIPTION: usize = 4_000;
pub const MAX_TEST_COMMAND: usize = 1_000;
/// Build files whose content tells how the project is built and tested, in this order.
pub const BUILD_FILES: [&str; 16] = [
    "package.json", "Cargo.toml", "pyproject.toml", "setup.py", "go.mod", "Makefile", "CMakeLists.txt", "pom.xml",
    "build.gradle", "build.gradle.kts", "composer.json", "Gemfile", "mix.exs", "deno.json", "justfile", "Taskfile.yml",
];
const MAX_COMMITS: usize = 50;
const MAX_TOP_LEVEL: usize = 200;
const MAX_CHANGED: usize = 200;
/// Commits whose paths are read for "changed between good and bad".
const MAX_NAME_COMMITS: usize = 500;
const MAX_BUILD_FILES: usize = 4;
const MAX_BUILD_FILE_BYTES: usize = 3_000;
/// As long as `prompt::new_token()`: the prompt is measured with it before the real token exists.
const MEASURE_TOKEN: &str = "00000000000000000000000000000000";

/// A checked request: texts trimmed, commits resolved to full SHAs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checked {
    pub description: String,
    pub test_command: Option<String>,
    pub bad: String,
    pub good: Vec<String>,
}

/// Bad and good commits as full SHAs: at least one good commit, none equal to the bad one, each an
/// ancestor of the bad one.
pub async fn check_range(core: &Core, repo_id: &str, bad: &str, good: &[String]) -> CoreResult<(String, Vec<String>)> {
    if good.is_empty() {
        return Err(CoreError::not_allowed("A bisect needs at least one good commit."));
    }
    let bad = resolve_commit(core, repo_id, bad).await?;
    let mut goods: Vec<String> = Vec::with_capacity(good.len());
    for rev in good {
        let sha = resolve_commit(core, repo_id, rev).await?;
        if !goods.contains(&sha) {
            goods.push(sha);
        }
    }
    if goods.contains(&bad) {
        return Err(CoreError::not_allowed("The same commit can’t be both good and bad."));
    }
    for sha in &goods {
        let out = core.git_for(repo_id)?.read_only().no_log().args(["merge-base", "--is-ancestor"]).arg(sha).arg(&bad).run_raw().await?;
        match out.code {
            Some(0) => {}
            Some(1) => return Err(CoreError::not_allowed("Every good commit must be an ancestor of the bad one.")),
            _ => return Err(crate::git::errors::classify("merge-base", out.code, &out.stdout, &out.stderr)),
        }
    }
    Ok((bad, goods))
}

/// Checks a request from the UI before anything is read or sent.
pub async fn check(core: &Core, repo_id: &str, request: &BisectScriptRequest) -> CoreResult<Checked> {
    let description = request.description.trim().to_string();
    if description.is_empty() {
        return Err(CoreError::not_allowed("Describe the problem first."));
    }
    if description.chars().count() > MAX_DESCRIPTION {
        return Err(CoreError::not_allowed(format!("The description is longer than {MAX_DESCRIPTION} characters.")));
    }
    let test_command = request.test_command.as_deref().map(str::trim).filter(|command| !command.is_empty()).map(str::to_string);
    if let Some(command) = &test_command {
        if command.contains(['\n', '\r']) || command.chars().count() > MAX_TEST_COMMAND {
            return Err(CoreError::not_allowed(format!("The test command must be one line of at most {MAX_TEST_COMMAND} characters.")));
        }
    }
    let (bad, good) = check_range(core, repo_id, &request.bad, &request.good).await?;
    Ok(Checked { description, test_command, bad, good })
}

/// What the repository gives the prompt, before the budget.
#[derive(Debug, Default)]
struct Gathered {
    commits: Vec<String>,
    total_commits: usize,
    top_level: Vec<String>,
    total_top_level: usize,
    /// Name, text (cut at `MAX_BUILD_FILE_BYTES`), whether it was cut.
    build_files: Vec<(String, String, bool)>,
    changed: Vec<String>,
    total_changed: usize,
    omitted: Vec<AiOmitted>,
}

fn note(omitted: &mut Vec<AiOmitted>, path: &str, reason: AiOmitReason, size: u64) {
    if !omitted.iter().any(|entry| entry.path == path) {
        omitted.push(AiOmitted { path: path.to_string(), reason, size });
    }
}

/// Secret and ignored paths are not mentioned at all (Grundregel 5); generated files and binaries
/// only appear as names here anyway.
fn hidden(exclusions: &Exclusions, path: &str) -> Option<AiOmitReason> {
    exclusions.reason(path).filter(|reason| matches!(reason, AiOmitReason::Secret | AiOmitReason::Ignored))
}

fn read(core: &Core, repo_id: &str) -> CoreResult<GitCmd> {
    Ok(core.git_for(repo_id)?.read_only().no_log())
}

async fn gather(core: &Core, repo_id: &str, checked: &Checked, exclusions: &Exclusions) -> CoreResult<Gathered> {
    let not_good: Vec<String> = checked.good.iter().map(|sha| format!("^{sha}")).collect();
    let mut gathered = Gathered::default();

    let count = read(core, repo_id)?.args(["rev-list", "--count"]).arg(&checked.bad).args(&not_good).arg("--").run().await?;
    gathered.total_commits = count.stdout_text().trim().parse().unwrap_or(0);
    let log = read(core, repo_id)?.args(["log", "-z", "--format=%h %s"]).arg(format!("--max-count={MAX_COMMITS}")).arg(&checked.bad).args(&not_good).arg("--").run().await?;
    gathered.commits = util::split_z(&log.stdout).map(util::decode_lossy).collect();

    let tree = read(core, repo_id)?.args(["ls-tree", "-z", "-l"]).arg(&checked.bad).arg("--").run().await?;
    let mut build_names: Vec<String> = Vec::new();
    for entry in util::split_z(&tree.stdout) {
        // "<mode> <type> <object> <size>\t<name>"; trees have "-" as size.
        let Some(tab) = entry.iter().position(|&b| b == b'\t') else { continue };
        let meta = util::decode_lossy(&entry[..tab]);
        let fields: Vec<&str> = meta.split_whitespace().collect();
        let kind = fields.get(1).copied().unwrap_or_default();
        let size: u64 = fields.get(3).and_then(|size| size.parse().ok()).unwrap_or(0);
        let name = util::decode_lossy(&entry[tab + 1..]);
        let is_tree = kind == "tree";
        let shown = if is_tree { format!("{name}/") } else { name.clone() };
        // A folder counts as excluded when a file directly inside it would be.
        let probe = if is_tree { format!("{name}/_") } else { name.clone() };
        if let Some(reason) = hidden(exclusions, &probe) {
            note(&mut gathered.omitted, &shown, reason, size);
            continue;
        }
        gathered.total_top_level += 1;
        if gathered.top_level.len() < MAX_TOP_LEVEL {
            gathered.top_level.push(shown);
        }
        if kind == "blob" && BUILD_FILES.contains(&name.as_str()) {
            build_names.push(name);
        }
    }
    build_names.sort_by_key(|name| BUILD_FILES.iter().position(|known| known == name));
    for name in build_names.into_iter().take(MAX_BUILD_FILES) {
        let blob = read(core, repo_id)?.args(["cat-file", "blob"]).arg(format!("{}:{name}", checked.bad)).run_raw().await?;
        if !blob.success() || util::looks_binary(&blob.stdout) {
            continue;
        }
        let text = util::decode_lossy(&blob.stdout);
        let cut = text.len() > MAX_BUILD_FILE_BYTES;
        gathered.build_files.push((name, util::truncate_str(&text, MAX_BUILD_FILE_BYTES), cut));
    }

    let names = read(core, repo_id)?
        .args(["log", "-z", "--format=", "--name-only", "--no-renames"])
        .arg(format!("--max-count={MAX_NAME_COMMITS}"))
        .arg(&checked.bad)
        .args(&not_good)
        .arg("--")
        .run()
        .await?;
    let mut seen: Vec<String> = Vec::new();
    for raw in util::split_z(&names.stdout) {
        let path = util::decode_lossy(raw).trim_matches('\n').to_string();
        if path.is_empty() || seen.contains(&path) {
            continue;
        }
        seen.push(path.clone());
        if let Some(reason) = hidden(exclusions, &path) {
            note(&mut gathered.omitted, &path, reason, 0);
            continue;
        }
        gathered.total_changed += 1;
        if gathered.changed.len() < MAX_CHANGED {
            gathered.changed.push(path);
        }
    }
    Ok(gathered)
}

/// The instruction: what the script must do, in which shell, and the user's own words.
fn instruction(checked: &Checked, shell: BisectShell, secrets: &[String]) -> String {
    let description = context::redact_for_ai(&checked.description, secrets);
    let command = match &checked.test_command {
        Some(command) => format!("The user's test command: {}\nBuild the script around this command.", context::redact_for_ai(command, secrets)),
        None => "The user gave no test command; derive one from the build files below, or check the problem directly.".to_string(),
    };
    format!(
        "Write a test script for an automatic `git bisect` that finds the commit which introduced a problem.\n\
         The script runs with {shell} in the root of a temporary checkout of the commit under test; the commit's full SHA is in the environment variable FORKYARD_BISECT_COMMIT.\n\
         Exit codes: 0 = good (the problem does not occur), 1 = bad (the problem occurs), 125 = this commit cannot be tested (for example, it does not build). Use no other exit code.\n\
         Keep the output short: send build and test output to the null device unless it decides the result. Do not change anything outside the current directory, do not move HEAD, create commits or change refs, and do not install anything globally.\n\
         The problem as the user describes it: {description}\n\
         {command}\n\
         Answer with the whole script in `script` and one sentence in `summary` that says what the script checks.",
        shell = shell.prompt_name(),
    )
}

fn measure(instruction: &str, locale: &str, sections: &[Section]) -> usize {
    prompt::build_with_token(instruction, locale, sections, MEASURE_TOKEN).chars() as usize
}

/// Adds a list section with as many lines as fit, the rest as "… and n more"; nothing if not even that fits.
fn push_list(sections: &mut Vec<Section>, fits: &dyn Fn(&[Section]) -> bool, title: &str, lines: &[String], total: usize) {
    if lines.is_empty() {
        return;
    }
    let mut taken = lines.len();
    loop {
        let mut body = lines[..taken].join("\n");
        let rest = total.saturating_sub(taken);
        if rest > 0 {
            if !body.is_empty() {
                body.push('\n');
            }
            body.push_str(&format!("… and {rest} more"));
        }
        sections.push(Section { title: title.to_string(), body });
        if fits(sections) {
            return;
        }
        sections.pop();
        if taken == 0 {
            return;
        }
        taken -= 1;
    }
}

fn compose(instruction: &str, locale: &str, gathered: Gathered, budget_chars: usize, secrets: &[String]) -> CoreResult<Built> {
    let fits = |sections: &[Section]| measure(instruction, locale, sections) <= budget_chars;
    let mut sections: Vec<Section> = Vec::new();
    if !fits(&sections) {
        return Err(CoreError::ai_too_large("The description and the test command alone exceed what this model accepts. Shorten them or choose a model with a larger context."));
    }
    let redacted = |lines: &[String]| -> Vec<String> { lines.iter().map(|line| context::redact_for_ai(line, secrets)).collect() };
    let mut omitted = gathered.omitted;
    // Spec 1.4: every cut is named in the preview.
    let mut shortened: Vec<String> = Vec::new();
    push_list(&mut sections, &fits, "Commits from good to bad, newest first", &redacted(&gathered.commits), gathered.total_commits.max(gathered.commits.len()));
    push_list(&mut sections, &fits, "Top-level files and folders of the bad commit", &redacted(&gathered.top_level), gathered.total_top_level);
    for (name, text, cut) in &gathered.build_files {
        sections.push(Section { title: format!("Build file {name} of the bad commit"), body: context::redact_for_ai(text, secrets) });
        if !fits(&sections) {
            sections.pop();
            note(&mut omitted, name, AiOmitReason::Budget, text.len() as u64);
        } else if *cut {
            shortened.push(name.clone());
        }
    }
    push_list(&mut sections, &fits, "Files changed between good and bad", &redacted(&gathered.changed), gathered.total_changed);
    Ok(Built { prompt: prompt::build(instruction, locale, &sections), omitted, shortened })
}

/// The prompt for `AiInput::BisectScript` – the same text for "What is sent?" and the request.
pub async fn build(core: &Core, repo_id: &str, checked: &Checked, settings: &Settings, budget_tokens: u64, locale: &str, secrets: &[String]) -> CoreResult<Built> {
    let exclusions = Exclusions::load(core, repo_id, &settings.ai_exclude).await?;
    let gathered = gather(core, repo_id, checked, &exclusions).await?;
    let instruction = instruction(checked, BisectShell::current(), secrets);
    compose(&instruction, locale, gathered, (budget_tokens as f64 * CHARS_PER_TOKEN) as usize, secrets)
}

#[cfg(test)]
mod tests;
