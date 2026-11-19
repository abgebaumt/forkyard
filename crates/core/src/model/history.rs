//! Stash, undo, history, files

use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stash {
    pub index: u32,
    pub sha: Sha,
    pub message: String,
    pub branch: Option<String>,
    pub base_sha: Sha,
    pub created_at: IsoTime,
    pub file_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoStep {
    pub label: String,
    pub action: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoState {
    pub undo: Option<UndoStep>,
    pub redo: Option<UndoStep>,
    /// Why the last action cannot be undone (any more) although there was one –
    /// e.g. because its commit is already pushed. Only set when `undo` is empty.
    #[serde(default)]
    pub undo_blocked: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryEntry {
    pub commit: CommitSummary,
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub added: Option<u32>,
    pub removed: Option<u32>,
}

/// One step of `line_history`: a commit that changed the line, and where the line was in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineHistoryStep {
    pub commit: CommitSummary,
    /// Path of the file in this commit (follows renames).
    pub path: String,
    /// Line range in this commit's version of the file (1-based, inclusive).
    pub start_line: u32,
    pub end_line: u32,
}

/// What a reference in a commit message points to (line archaeology, v1.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchaeologyRefKind {
    /// `#12` on the repository's host (on GitHub and Gitea it may turn out to be a pull request).
    Issue,
    /// `!7` on GitLab and Azure DevOps, or a `#12` the host knows as a pull request.
    PullRequest,
    /// A ticket rule: presets, own rules, `.forkyard/links.json`.
    Ticket,
}

/// A pull request, issue or ticket a commit message names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchaeologyRef {
    /// As written in the message: `#12`, `!7`, `ABC-42`.
    pub text: String,
    pub url: String,
    pub kind: ArchaeologyRefKind,
    /// Title from the host; `None` for tickets, without an account, or when the host does not know it.
    pub title: Option<String>,
}

/// One commit that shaped the line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchaeologyStep {
    pub commit: CommitSummary,
    /// Path of the file in this commit (follows renames).
    pub path: String,
    /// Line range in this commit's version of the file (1-based, inclusive).
    pub start_line: u32,
    pub end_line: u32,
    /// Full commit message (at most 4 000 bytes).
    pub message: String,
    /// The change of the line range: ` `, `+`, `-` lines (at most 40, then one “… n more lines”).
    pub diff: Vec<String>,
    pub refs: Vec<ArchaeologyRef>,
}

/// Whether the titles of host references could be looked up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchaeologyHostLookup {
    /// No host reference in the messages.
    None,
    Done,
    /// No account for the repository's host, or no supported host.
    NotConnected,
    /// The host did not answer; the links stay without titles.
    Failed,
}

/// `line_archaeology`: the history of one line, newest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineArchaeology {
    /// Where the history starts: for a line of the working directory the commit that last changed it.
    pub path: String,
    pub line: u32,
    pub sha: Sha,
    /// First line number of `code`.
    pub code_start: u32,
    /// The line with up to three lines around it, at `sha`.
    pub code: Vec<String>,
    pub steps: Vec<ArchaeologyStep>,
    /// Exactly `LINE_HISTORY_STEPS` steps came back: older changes may exist.
    pub may_have_more: bool,
    pub host_lookup: ArchaeologyHostLookup,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchaeologyConfidence {
    High,
    Medium,
    Low,
}

/// The AI's sentence about one step of the timeline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchaeologyNote {
    pub sha: Sha,
    pub note: String,
}

/// `ai_archaeology`: the summary, checked against the timeline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchaeologyAnswer {
    pub summary: String,
    /// Only for commits of the timeline, in its order.
    pub notes: Vec<ArchaeologyNote>,
    pub confidence: ArchaeologyConfidence,
    /// Estimated cost (API providers with a known price).
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub line_no: u32,
    pub text: String,
    pub sha: Sha,
    pub author: Person,
    pub authored_at: IsoTime,
    pub summary: String,
    pub uncommitted: bool,
}

/// Line endings of a file that was read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Eol {
    Lf,
    Crlf,
    Mixed,
}

/// Line endings when writing (`fileWrite`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LineEnding {
    Lf,
    Crlf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub text: Option<String>,
    pub is_binary: bool,
    pub encoding: String,
    pub eol: Eol,
    pub size: u64,
}
