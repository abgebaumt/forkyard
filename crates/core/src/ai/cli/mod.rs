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
use serde_json::Value;

use crate::ai::provider::{BoxFuture, Completion, CompletionRequest, Finish, Provider, ProviderCaps, Usage};
use crate::app::Core;
use crate::db;
use crate::error::{CoreError, CoreResult};
use crate::git::redact;
use crate::jobs::CancelToken;
use crate::model::{AiLoginState, AiModelInfo, AiProviderKind, Settings};
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

// --- Where the program is ---------------------------------------------------------------------

/// `app_settings` key of the programs the search found, per provider (`{"claude_code": "/…/claude"}`).
pub const FOUND_KEY: &str = "ai.cliFound";

fn not_a_tool(kind: AiProviderKind) -> CoreError {
    CoreError::not_allowed(format!("{} is not a command-line tool.", kind.label()))
}

/// The own path from Settings › AI.
pub fn configured_path(settings: &Settings, kind: AiProviderKind) -> Option<PathBuf> {
    settings.ai_cli_paths.get(kind).map(PathBuf::from)
}

fn found_map(conn: &rusqlite::Connection) -> CoreResult<serde_json::Map<String, Value>> {
    Ok(db::app_settings::get_all(conn)?.into_iter().find(|(key, _)| key == FOUND_KEY).and_then(|(_, value)| value.as_object().cloned()).unwrap_or_default())
}

/// The program the last search found (it may be gone since).
pub fn remembered(core: &Core, kind: AiProviderKind) -> Option<PathBuf> {
    let map = core.db.with(found_map).ok()?;
    map.get(kind.as_str()).and_then(Value::as_str).map(PathBuf::from)
}

pub fn remember(core: &Core, kind: AiProviderKind, path: &Path) -> CoreResult<()> {
    let text = path.to_string_lossy().into_owned();
    core.db.with(|conn| {
        let mut map = found_map(conn)?;
        if map.get(kind.as_str()).and_then(Value::as_str) == Some(text.as_str()) {
            return Ok(());
        }
        map.insert(kind.as_str().to_string(), Value::String(text.clone()));
        db::app_settings::set(conn, FOUND_KEY, &Value::Object(map))
    })
}

/// The program as far as it is known without starting anything: the own path, else the remembered
/// one – if the file exists.
pub fn known_path(core: &Core, settings: &Settings, kind: AiProviderKind) -> Option<PathBuf> {
    if let Some(own) = configured_path(settings, kind) {
        return own.is_file().then_some(own);
    }
    remembered(core, kind).filter(|path| path.is_file())
}

/// Searches the tool: only in the search folder if one is set, else PATH → install folders → login shell.
pub async fn locate_cli(core: &Core, kind: AiProviderKind, configured: Option<&Path>) -> Option<locate::ToolInfo> {
    let name = kind.tool_name()?;
    match search_dir(core) {
        Some(dir) => {
            let spec = locate::SearchSpec { configured: configured.map(Path::to_path_buf), path_var: Some(dir.into_os_string()), known: Vec::new(), login_path: None };
            locate::locate_in(core, name, &spec).await
        }
        None => locate::locate(core, name, configured).await,
    }
}

/// The program to start: the own path (it must exist), else the remembered one if it still exists,
/// else a new search (remembered from then on).
pub async fn program_for(core: &Core, kind: AiProviderKind, settings: &Settings) -> CoreResult<PathBuf> {
    if !kind.is_cli() {
        return Err(not_a_tool(kind));
    }
    if let Some(own) = configured_path(settings, kind) {
        return if own.is_file() {
            Ok(own)
        } else {
            Err(CoreError::ai_not_configured(format!("The program set for {} in Settings › AI does not exist: {}", kind.label(), util::display_path(&own))))
        };
    }
    if let Some(path) = remembered(core, kind).filter(|path| path.is_file()) {
        return Ok(path);
    }
    let found = locate_cli(core, kind, None)
        .await
        .ok_or_else(|| CoreError::ai_not_configured(format!("{} was not found on this computer. Install it, or set its path in Settings › AI.", kind.label())))?;
    remember(core, kind, &found.path)?;
    Ok(found.path)
}

// --- Failures ---------------------------------------------------------------------------------

/// Phrases with which the tools say that they are not signed in.
const SIGNED_OUT: [&str; 9] = ["not logged in", "not signed in", "please run /login", "codex login", "providers login", "unauthorized", "invalid api key", "authentication", "providerautherror"];

pub fn looks_signed_out(text: &str) -> bool {
    let lower = text.to_lowercase();
    SIGNED_OUT.iter().any(|phrase| lower.contains(phrase))
}

/// Spec Fehlerbehandlung: „Claude Code ist nicht angemeldet – im Terminal … anmelden“.
pub fn not_logged_in(kind: AiProviderKind) -> CoreError {
    CoreError::ai_not_logged_in(format!("{} is not signed in. Sign in in the terminal: {}", kind.label(), login_command(kind)))
}

/// A tool's own error text for a message: redacted, at most 300 characters.
fn reported(text: &str) -> String {
    util::truncate_str(&redact::redact(text.trim()), 300)
}

/// The last 1 000 characters of stderr, redacted – for `gitOutput`; stdout never goes into an error.
fn stderr_tail(out: &ProcOutput) -> String {
    let text = redact::redact(String::from_utf8_lossy(&out.stderr).trim());
    let start = text.char_indices().rev().nth(999).map(|(at, _)| at).unwrap_or(0);
    text[start..].to_string()
}

/// A non-zero exit without a readable answer.
pub fn exit_failure(kind: AiProviderKind, out: &ProcOutput) -> CoreError {
    if looks_signed_out(&String::from_utf8_lossy(&out.stderr)) || looks_signed_out(&String::from_utf8_lossy(&out.stdout)) {
        return not_logged_in(kind);
    }
    let how = match out.code {
        Some(code) => format!("ended with exit code {code}"),
        None => "was ended by a signal".to_string(),
    };
    CoreError::ai_provider_unavailable(format!("{} {how}.", kind.label())).with_git_output(stderr_tail(out))
}

fn count(value: &Value, pointer: &str) -> u64 {
    value.pointer(pointer).and_then(Value::as_u64).unwrap_or(0)
}

/// What a tool answered: the answer text (JSON, validated by `ai::run`), tokens, reported cost.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CliAnswer {
    pub text: String,
    pub usage: Usage,
    pub cost_micros: Option<i64>,
}

/// Model choices offered in the settings; free text otherwise, empty = the tool's default.
pub fn model_suggestions(kind: AiProviderKind) -> Vec<AiModelInfo> {
    match kind {
        AiProviderKind::ClaudeCode => ["sonnet", "opus", "haiku"].iter().map(|id| AiModelInfo { id: id.to_string(), label: id.to_string(), context_tokens: None }).collect(),
        _ => Vec::new(),
    }
}

// --- The provider -----------------------------------------------------------------------------

pub struct CliProvider {
    kind: AiProviderKind,
    program: PathBuf,
    model: Option<String>,
    caps: CliCaps,
    context_tokens: u64,
    path_env: Option<OsString>,
    /// Cost the tool reported for the requests of this instance (micro-USD).
    cost_micros: Mutex<Option<i64>>,
}

impl CliProvider {
    pub fn program(&self) -> &Path {
        &self.program
    }

    /// The schema goes as a switch (Claude Code: the JSON text, Codex: a file) – not for a batch
    /// shim of Claude Code, whose command line can't carry `"` (Paket 0, `batch_command_line`).
    pub fn schema_as_switch(&self) -> bool {
        self.caps.schema && !(self.kind == AiProviderKind::ClaudeCode && crate::proc::is_batch(&self.program))
    }

    async fn call(&self, core: &Core, request: &CompletionRequest, cancel: &CancelToken) -> CoreResult<CliAnswer> {
        let scratch = ScratchDir::new(core)?;
        let dir = scratch.path();
        let switch = self.schema_as_switch();
        let model = self.model.as_deref();
        let out_file = dir.join("out.json");
        let args = match self.kind {
            AiProviderKind::ClaudeCode => claude::args(switch.then(|| request.schema.to_string()).as_deref(), model),
            AiProviderKind::Codex => {
                let schema_file = dir.join("schema.json");
                if switch {
                    let text = serde_json::to_vec_pretty(&request.schema).map_err(|e| CoreError::unknown(format!("Internal error: the answer schema can't be written ({e}).")))?;
                    std::fs::write(&schema_file, text).map_err(|e| CoreError::io(format!("The answer schema for Codex could not be written: {e}")))?;
                }
                codex::args(dir, switch.then_some(schema_file.as_path()), &out_file, model)
            }
            AiProviderKind::Opencode => opencode::args(dir, model),
            other => return Err(not_a_tool(other)),
        };
        let stdin = stdin_text(&request.system, &request.user, (!switch).then_some(&request.schema));
        let mut proc = Proc::new(&self.program).args(&args).cwd(dir).stdin(stdin.into_bytes()).timeout(cli_timeout(request.timeout));
        if self.kind == AiProviderKind::Opencode {
            proc = proc.env(opencode::CONFIG_ENV, opencode::CONFIG);
        }
        if let Some(path) = &self.path_env {
            proc = proc.env("PATH", path);
        }
        let out = proc.run(cancel).await?;
        // Read before `scratch` is dropped: the answer file of Codex lives in it.
        match self.kind {
            AiProviderKind::Codex => codex::parse_answer(&out, &out_file),
            AiProviderKind::Opencode => opencode::parse_answer(&out),
            _ => claude::parse_answer(&out),
        }
    }
}

impl Provider for CliProvider {
    fn id(&self) -> AiProviderKind {
        self.kind
    }

    fn label(&self) -> String {
        self.kind.label().to_string()
    }

    fn capabilities(&self) -> ProviderCaps {
        ProviderCaps { structured_output: self.schema_as_switch(), embeddings: false, max_context_tokens: Some(self.context_tokens), pricing: None }
    }

    fn complete<'a>(&'a self, core: &'a Core, request: &'a CompletionRequest, cancel: &'a CancelToken) -> BoxFuture<'a, CoreResult<Completion>> {
        Box::pin(async move {
            let answer = self.call(core, request, cancel).await?;
            if let Some(micros) = answer.cost_micros {
                let mut cost = self.cost_micros.lock();
                *cost = Some(cost.unwrap_or(0) + micros);
            }
            Ok(Completion { text: answer.text, finish: Finish::Complete, usage: answer.usage })
        })
    }

    fn models<'a>(&'a self, _core: &'a Core, _cancel: &'a CancelToken) -> BoxFuture<'a, CoreResult<Vec<AiModelInfo>>> {
        Box::pin(async move { Ok(model_suggestions(self.kind)) })
    }

    fn take_reported_cost_micros(&self) -> Option<i64> {
        self.cost_micros.lock().take()
    }
}

/// Finds the program, checks the model name and the safety switches – before anything is sent.
async fn prepare(core: &Core, kind: AiProviderKind, settings: &Settings) -> CoreResult<CliProvider> {
    if !kind.is_cli() {
        return Err(not_a_tool(kind));
    }
    let model = settings.ai_model.clone();
    if let Some(model) = model.as_deref() {
        check_model(model)?;
    }
    let program = program_for(core, kind, settings).await?;
    let version = locate::version_of(core, &program).await;
    let caps = caps(core, kind, &program, version.as_deref(), PROBE_TIMEOUT).await;
    if let Some(problem) = caps.problem(kind) {
        return Err(CoreError::ai_unsupported_version(problem));
    }
    if model.is_some() && !caps.model {
        return Err(CoreError::ai_unsupported_version(format!("This {0} version can’t choose a model. Clear the model in Settings › AI or update {0}.", kind.label())));
    }
    let context_tokens = crate::ai::providers::context_tokens(core, kind, model.as_deref().unwrap_or_default());
    Ok(CliProvider { kind, program, model, caps, context_tokens, path_env: child_path(core).await, cost_micros: Mutex::new(None) })
}

/// The provider for `ai::providers::active` (the command-line tools are not built by `providers::build`).
pub async fn provider(core: &Core, kind: AiProviderKind, settings: &Settings) -> CoreResult<Box<dyn Provider>> {
    Ok(Box::new(prepare(core, kind, settings).await?))
}
#[cfg(test)]
mod tests;
