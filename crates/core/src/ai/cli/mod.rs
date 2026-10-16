//! Command-line AI providers (Teilpaket 1b): Claude Code, Codex and opencode with the sign-in the
//! user already has – Forkyard stores nothing of it.
//!
//! - Every call runs through `proc::Proc` in a fresh, empty folder under the data folder (never in
//!   a repository: the tools would load its configuration and could read files such as `.env`
//!   themselves), without a shell; prompt and context only on stdin, the schema as Forkyard's own
//!   argument (Claude Code), as a file in that folder (Codex) or in the prompt. The folder is removed
//!   afterwards, also on error and cancel.
//! - What a tool can is read from its `--help` once per path and version. A missing safety switch
//!   (tools off, setting sources, sandbox, permissions, no stored sessions) refuses the tool
//!   (`ai_unsupported_version`); only the schema may fall back into the prompt.
//! - Time limit: the function's limit plus 30 s for the start. Cancel ends the process tree.

pub mod claude;
pub mod codex;
pub mod opencode;

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use parking_lot::Mutex;

use crate::app::Core;
use crate::error::{CoreError, CoreResult};
use crate::jobs::CancelToken;
use crate::model::{AiLoginState, AiProviderKind};
use crate::proc::{Proc, ProcOutput};
use crate::tools::locate;
use crate::util;

/// Time limit of `--help` and of the sign-in question outside the detection.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
const PROBE_OUTPUT: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Tool {
    Claude,
    Codex,
    Opencode,
}

fn tool(kind: AiProviderKind) -> Option<Tool> {
    match kind {
        AiProviderKind::ClaudeCode => Some(Tool::Claude),
        AiProviderKind::Codex => Some(Tool::Codex),
        AiProviderKind::Opencode => Some(Tool::Opencode),
        _ => None,
    }
}

#[derive(Default)]
struct SearchDir {
    dir: Mutex<Option<PathBuf>>,
}

/// Search the tools only in `dir`: no PATH, no install folders, no login shell (tests; the debug
/// switch `FORKYARD_AI_CLI_DIR`). `None` = the normal search.
pub fn configure_dir(core: &Core, dir: Option<PathBuf>) {
    *core.state::<SearchDir>().dir.lock() = dir;
}

pub fn search_dir(core: &Core) -> Option<PathBuf> {
    core.state::<SearchDir>().dir.lock().clone()
}

/// A fresh empty folder `<data>/tmp/ai-<id>` for one call; removed when the guard is dropped.
pub struct ScratchDir {
    path: PathBuf,
}

impl ScratchDir {
    pub fn new(core: &Core) -> CoreResult<ScratchDir> {
        let path = core.data_dir().join("tmp").join(format!("ai-{}", util::new_id()));
        std::fs::create_dir_all(&path).map_err(|e| CoreError::io(format!("The temporary folder for the AI tool could not be created: {e}")))?;
        Ok(ScratchDir { path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

// --- Command lines and stdin ------------------------------------------------------------------

/// Extra time for a tool to start (spec 1.2: „Zeitlimit wie API-Anbieter + 30 s Start“).
pub const CLI_START_GRACE: Duration = Duration::from_secs(30);
const MAX_MODEL_LEN: usize = 200;

pub fn cli_timeout(limit: Duration) -> Duration {
    limit + CLI_START_GRACE
}

/// The model name is the only chosen value on a command line: no switch, no shell or cmd.exe
/// character, nothing but the characters model IDs use.
pub fn check_model(model: &str) -> CoreResult<()> {
    let fine = !model.is_empty()
        && model.len() <= MAX_MODEL_LEN
        && !model.starts_with('-')
        && model.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '/' | '@' | '+' | '-' | '[' | ']'));
    if fine {
        Ok(())
    } else {
        Err(CoreError::not_allowed("A model name for a command-line tool may only contain letters, digits and . _ : / @ + - [ ] and must not start with “-”."))
    }
}

/// What the tool reads on stdin: exactly the text of “What is sent?” (`Prompt::text`), with the
/// schema after the system text when it can't go as a switch.
pub fn stdin_text(system: &str, user: &str, schema_in_prompt: Option<&serde_json::Value>) -> String {
    match schema_in_prompt {
        Some(schema) => format!("{system}\n\nThe JSON must match this JSON schema exactly:\n{schema}\n\n{user}"),
        None => format!("{system}\n\n{user}"),
    }
}

/// Claude Code uses `ANTHROPIC_API_KEY` from the environment instead of the sign-in when it is set;
/// detection says so. Only the presence is looked at, never the value.
pub fn env_key_present(kind: AiProviderKind, lookup: impl Fn(&str) -> Option<OsString>) -> bool {
    kind == AiProviderKind::ClaudeCode && lookup("ANTHROPIC_API_KEY").is_some_and(|value| !value.is_empty())
}

// --- What a tool can (`--help`) ---------------------------------------------------------------

/// A command-line switch and the spellings `--help` shows for it.
#[derive(Debug, Clone, Copy)]
pub struct Flag {
    pub name: &'static str,
    pub tokens: &'static [&'static str],
}

/// The switch is listed as a whole word (an option line, not a mention inside a description).
pub fn help_has(help: &str, flag: &Flag) -> bool {
    help.split(|c: char| c.is_whitespace() || matches!(c, ',' | '[' | ']' | '=' | '<' | '>' | '|')).any(|word| flag.tokens.contains(&word))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliCaps {
    pub version: Option<String>,
    /// Safety switches the tool lacks; not empty = refused.
    pub missing: Vec<String>,
    /// The schema can go as a switch (otherwise into the prompt).
    pub schema: bool,
    pub model: bool,
}

impl CliCaps {
    pub fn supported(&self) -> bool {
        self.missing.is_empty()
    }

    /// The message of `ai_unsupported_version`, or `None` if nothing is missing.
    pub fn problem(&self, kind: AiProviderKind) -> Option<String> {
        if self.missing.is_empty() {
            return None;
        }
        let label = kind.label();
        let version = self.version.as_deref().unwrap_or("unknown");
        Some(format!("This {label} version ({version}) lacks the safety switches Forkyard needs: {}. Please update {label}.", self.missing.join(", ")))
    }

    fn unanswered(version: Option<&str>) -> CliCaps {
        CliCaps { version: version.map(str::to_string), missing: vec!["--help (no answer)".to_string()], schema: false, model: false }
    }
}

pub fn parse_caps(kind: AiProviderKind, help: &str, version: Option<&str>) -> CliCaps {
    let Some(tool) = tool(kind) else {
        return CliCaps::unanswered(version);
    };
    let (safety, schema, model): (&[Flag], Option<&Flag>, &Flag) = match tool {
        Tool::Claude => (&claude::SAFETY, Some(&claude::SCHEMA), &claude::MODEL),
        Tool::Codex => (&codex::SAFETY, Some(&codex::SCHEMA), &codex::MODEL),
        Tool::Opencode => (&opencode::SAFETY, None, &opencode::MODEL),
    };
    let mut missing: Vec<String> = safety.iter().filter(|flag| !help_has(help, flag)).map(|flag| flag.name.to_string()).collect();
    if tool == Tool::Opencode && !opencode::version_ok(version) {
        missing.push(format!("{} (opencode {} or newer)", opencode::CONFIG_ENV, opencode::MIN_VERSION));
    }
    CliCaps { version: version.map(str::to_string), missing, schema: schema.is_some_and(|flag| help_has(help, flag)), model: help_has(help, model) }
}

#[derive(Default)]
struct CapsCache {
    map: Mutex<HashMap<(PathBuf, Option<String>), CliCaps>>,
}

/// `--help` of the program, read once per path and version (spec 1.2). A tool that does not answer
/// within `limit` counts as unsupported for now and is asked again next time.
pub async fn caps(core: &Core, kind: AiProviderKind, program: &Path, version: Option<&str>, limit: Duration) -> CliCaps {
    let key = (program.to_path_buf(), version.map(str::to_string));
    if let Some(known) = core.state::<CapsCache>().map.lock().get(&key).cloned() {
        return known;
    }
    let Some(tool) = tool(kind) else {
        return CliCaps::unanswered(version);
    };
    let args: &[&str] = match tool {
        Tool::Claude => &claude::HELP_ARGS,
        Tool::Codex => &codex::HELP_ARGS,
        Tool::Opencode => &opencode::HELP_ARGS,
    };
    let Ok(out) = probe(core, program, args, limit).await else {
        return CliCaps::unanswered(version);
    };
    let help = format!("{}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if help.trim().is_empty() {
        return CliCaps::unanswered(version);
    }
    let found = parse_caps(kind, &help, version);
    core.state::<CapsCache>().map.lock().insert(key, found.clone());
    found
}

// --- Sign-in ----------------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LoginInfo {
    pub state: AiLoginState,
    /// "claude.ai", "ChatGPT", "an API key" … – never an account name or a part of a key.
    pub method: Option<String>,
}

impl LoginInfo {
    pub fn unknown() -> LoginInfo {
        LoginInfo { state: AiLoginState::Unknown, method: None }
    }
}

pub fn parse_login(kind: AiProviderKind, out: &ProcOutput) -> LoginInfo {
    match tool(kind) {
        Some(Tool::Claude) => claude::parse_login(out),
        Some(Tool::Codex) => codex::parse_login(out),
        Some(Tool::Opencode) => opencode::parse_login(out),
        None => LoginInfo::unknown(),
    }
}

/// Asks the tool whether it is signed in; no answer within `limit` = unknown.
pub async fn login_status(core: &Core, kind: AiProviderKind, program: &Path, limit: Duration) -> LoginInfo {
    let args: &[&str] = match tool(kind) {
        Some(Tool::Claude) => &claude::STATUS_ARGS,
        Some(Tool::Codex) => &codex::STATUS_ARGS,
        Some(Tool::Opencode) => &opencode::STATUS_ARGS,
        None => return LoginInfo::unknown(),
    };
    match probe(core, program, args, limit).await {
        Ok(out) => parse_login(kind, &out),
        Err(_) => LoginInfo::unknown(),
    }
}

/// Arguments of the tool's own sign-in (`claude auth login` …), for the terminal.
pub fn login_args(kind: AiProviderKind) -> Vec<OsString> {
    let args: &[&str] = match tool(kind) {
        Some(Tool::Claude) => &claude::LOGIN_ARGS,
        Some(Tool::Codex) => &codex::LOGIN_ARGS,
        Some(Tool::Opencode) => &opencode::LOGIN_ARGS,
        None => &[],
    };
    args.iter().map(OsString::from).collect()
}

/// The sign-in as text, for hints ("claude auth login"). Only shown, never run from this text.
pub fn login_command(kind: AiProviderKind) -> String {
    let mut parts = vec![kind.tool_name().unwrap_or_default().to_string()];
    parts.extend(login_args(kind).iter().map(|arg| arg.to_string_lossy().into_owned()));
    parts.join(" ")
}

// --- Running a probe --------------------------------------------------------------------------

/// PATH for the tools: the login shell's PATH before the app's (npm-installed tools need `node`).
/// `None` (inherit the app's PATH) when a search folder is set (tests, E2E) or on Windows.
pub async fn child_path(core: &Core) -> Option<OsString> {
    if search_dir(core).is_some() {
        return None;
    }
    let login = locate::login_shell_path(core).await?;
    let mut folders: Vec<PathBuf> = std::env::split_paths(&login).collect();
    if let Some(current) = std::env::var_os("PATH") {
        folders.extend(std::env::split_paths(&current));
    }
    std::env::join_paths(folders).ok()
}

/// A short run of the tool (`--help`, sign-in status) in its own empty folder.
async fn probe(core: &Core, program: &Path, args: &[&str], limit: Duration) -> CoreResult<ProcOutput> {
    let scratch = ScratchDir::new(core)?;
    let mut proc = Proc::new(program).args(args).cwd(scratch.path()).timeout(limit).max_output(PROBE_OUTPUT, PROBE_OUTPUT);
    if let Some(path) = child_path(core).await {
        proc = proc.env("PATH", path);
    }
    proc.run(&CancelToken::new()).await
}

#[cfg(test)]
mod tests;
