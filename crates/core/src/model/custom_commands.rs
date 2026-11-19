//! Custom commands and the command line

use super::*;

/// What a custom command does: start a program, run Git, or open a web address.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "custom_commands.ts"))]
#[serde(rename_all = "snake_case")]
pub enum CustomCommandKind {
    Shell,
    Url,
    Git,
}

/// Working directory of a `shell` command: the open folder (default) or the main working tree.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "custom_commands.ts"))]
#[serde(rename_all = "snake_case")]
pub enum CustomCommandCwd {
    Repo,
    #[default]
    Worktree,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "custom_commands.ts"))]
#[serde(rename_all = "snake_case")]
pub enum CustomInputType {
    Text,
    Choice,
    Checkbox,
    File,
}

/// Where a command appears: palette (`repo`) and the context menus of the other kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "custom_commands.ts"))]
#[serde(rename_all = "snake_case")]
pub enum CustomCommandScope {
    Repo,
    Commit,
    Branch,
    File,
    Submodule,
}

/// A field of the form that is shown before the command runs (`${input:<id>}`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "custom_commands.ts"))]
#[serde(rename_all = "camelCase")]
pub struct CustomCommandInput {
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub input_type: CustomInputType,
    /// Start value; for a checkbox `"true"` or `"false"`.
    #[serde(default)]
    pub default: Option<String>,
    /// `choice`: the choices; `checkbox`: at most one entry, the value when ticked.
    #[serde(default)]
    pub options: Vec<String>,
}

fn default_scope() -> Vec<CustomCommandScope> {
    vec![CustomCommandScope::Repo]
}

/// One custom command as it is stored (global) or written in `.forkyard/commands.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "custom_commands.ts"))]
#[serde(rename_all = "camelCase")]
pub struct CustomCommandDef {
    pub id: String,
    pub title: String,
    pub kind: CustomCommandKind,
    /// One line: program and arguments (`shell`), Git's arguments without `git` (`git`) or the
    /// address (`url`), with placeholders.
    pub run: String,
    #[serde(default)]
    pub cwd: CustomCommandCwd,
    /// Show the finished command before it runs.
    #[serde(default)]
    pub confirm: bool,
    /// Global `shell` commands only: run the line through the system shell; values arrive as
    /// environment variables, never as part of the line.
    #[serde(default)]
    pub shell: bool,
    #[serde(default)]
    pub inputs: Vec<CustomCommandInput>,
    #[serde(default = "default_scope")]
    pub scope: Vec<CustomCommandScope>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "custom_commands.ts"))]
#[serde(rename_all = "snake_case")]
pub enum CustomCommandSource {
    Global,
    Repo,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "custom_commands.ts"))]
#[serde(rename_all = "camelCase")]
pub struct CustomCommandEntry {
    /// `global:<id>` or `repo:<id>` – what `custom_command_run` takes.
    pub key: String,
    pub source: CustomCommandSource,
    pub command: CustomCommandDef,
    /// `false`: a repository command whose file is not approved in this version.
    pub runnable: bool,
}

/// Approval state of `.forkyard/commands.json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "custom_commands.ts"))]
#[serde(rename_all = "snake_case")]
pub enum RepoCommandsState {
    /// No file.
    Missing,
    /// Never approved (or the file cannot be used).
    Untrusted,
    /// Approved once, but the file has changed since.
    Changed,
    Trusted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "custom_commands.ts"))]
#[serde(rename_all = "snake_case")]
pub enum CustomCommandChangeKind {
    Added,
    Removed,
    Changed,
}

/// What changed in the repository file since the approval (by command id).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "custom_commands.ts"))]
#[serde(rename_all = "camelCase")]
pub struct CustomCommandChange {
    pub id: String,
    pub title: String,
    pub change: CustomCommandChangeKind,
    /// `run` before and after; `None` for added or removed commands.
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "custom_commands.ts"))]
#[serde(rename_all = "camelCase")]
pub struct RepoCommands {
    pub state: RepoCommandsState,
    /// SHA-256 of the file as it is now – what `custom_commands_trust` expects. `None` without a usable file.
    pub hash: Option<String>,
    /// `.forkyard/commands.json`
    pub path: String,
    /// One sentence per command (or file problem) that was rejected.
    pub problems: Vec<String>,
    /// Only for `changed`.
    pub changes: Vec<CustomCommandChange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "custom_commands.ts"))]
#[serde(rename_all = "camelCase")]
pub struct CustomCommandList {
    /// Global commands first, then those of the repository.
    pub commands: Vec<CustomCommandEntry>,
    /// `None` when listed without a repository.
    pub repo: Option<RepoCommands>,
}

/// Where a command was started: the selected commit, branch, file and remote. Missing values fall
/// back to HEAD, the current branch and the upstream remote.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "custom_commands.ts", optional_fields = nullable))]
#[serde(rename_all = "camelCase", default)]
pub struct CustomCommandContext {
    pub sha: Option<Sha>,
    pub branch: Option<String>,
    pub file: Option<String>,
    pub remote: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "custom_commands.ts"))]
#[serde(tag = "status", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum CustomCommandResult {
    /// `confirm: true` and not confirmed yet: what would run, nothing has run.
    Confirm { display: String, cwd: String },
    /// `shell` or `git` ran; `output` is stdout and stderr, redacted and shortened.
    Finished { exit_code: Option<i32>, output: String },
    /// `url`: the UI opens the address in the system browser.
    OpenUrl { url: String },
}

/// Whether the palette can link the `forkyard` command into a folder on the PATH.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "custom_commands.ts"))]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    /// AppImage or macOS app: the app can create the link itself.
    pub installable: bool,
    pub installed: bool,
    /// `~/.local/bin/forkyard` or `/usr/local/bin/forkyard`; `None` if not installable.
    pub link_path: Option<String>,
    /// The folder of the link is on the PATH of the running app.
    pub on_path: bool,
}
