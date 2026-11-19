//! Status and running operations

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationKind {
    Merge,
    Rebase,
    CherryPick,
    Revert,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub kind: OperationKind,
    pub source: Option<String>,
    pub target: Option<String>,
    pub step: Option<u32>,
    pub total_steps: Option<u32>,
    pub message: Option<String>,
}

/// Verdict on a commit during a bisect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "spike.ts"))]
#[serde(rename_all = "snake_case")]
pub enum BisectVerdict {
    Good,
    Bad,
    Skip,
}

/// State of a bisect, read from the Git directory (`active: false` = none running).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BisectStatus {
    pub active: bool,
    pub bad: Option<Sha>,
    pub good: Vec<Sha>,
    pub skipped: Vec<Sha>,
    /// The commit to test now (HEAD; with `--no-checkout` BISECT_HEAD).
    pub current: Option<Sha>,
    /// Git's estimate of the steps after this one; `None` until a bad and a good commit are known.
    pub remaining_steps: Option<u32>,
    /// Commits marked since the start.
    pub steps_done: u32,
    /// The first bad commit, as soon as it is certain.
    pub result: Option<Sha>,
    /// Only skipped commits are left between good and bad: the first bad one is among them.
    pub only_skipped_left: bool,
}

/// What the AI writes a bisect test script from (`bisect_autopilot_script`, `AiInput::BisectScript`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BisectScriptRequest {
    /// The problem in the user's words.
    pub description: String,
    /// A command that shows the problem (`npm test`), if the user knows one.
    pub test_command: Option<String>,
    pub bad: String,
    pub good: Vec<String>,
}

/// The shell a bisect test script runs with: `/bin/sh` on Linux and macOS, Windows PowerShell on Windows.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BisectShell {
    Sh,
    Powershell,
}

/// The AI's test script – shown and editable; `bisect_autopilot_script` never runs it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BisectScript {
    pub script: String,
    /// One sentence in the UI language: what the script checks.
    pub summary: String,
    pub shell: BisectShell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BisectAutopilotPhase {
    /// Worktree and bisect are being set up.
    Preparing,
    /// The script runs commit by commit.
    Testing,
    /// The first bad commit is certain (`result`).
    Found,
    /// Only skipped commits are left; the first bad one is among `candidates`.
    OnlySkipped,
    /// The script ended with an exit code above 127 or by a signal (`message`).
    Failed,
}

/// One tested commit of an autopilot run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "spike.ts"))]
#[serde(rename_all = "camelCase")]
pub struct BisectAutopilotStep {
    pub sha: Sha,
    pub verdict: BisectVerdict,
    /// `None` when the step hit its time limit.
    pub exit_code: Option<i32>,
    /// Over the time limit: counted as skipped.
    pub timed_out: bool,
    pub duration_ms: u64,
    /// The end of the script's output (stdout, then stderr), redacted.
    pub output_tail: String,
}

/// The bisect autopilot run of a repository. Kept in memory as job state; the bisect itself lives in
/// the temporary worktree's own Git directory and is read from there after every mark.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BisectAutopilot {
    pub job_id: String,
    pub phase: BisectAutopilotPhase,
    /// `<parent>/<repo>.agents/bisect-<n>`; empty until the folder is chosen.
    pub worktree_path: String,
    pub bad: Sha,
    pub good: Vec<Sha>,
    /// The commit under test.
    pub current: Option<Sha>,
    /// Git's estimate of the steps after the current one.
    pub remaining_steps: Option<u32>,
    pub steps: Vec<BisectAutopilotStep>,
    pub result: Option<Sha>,
    pub candidates: Vec<Sha>,
    pub step_timeout_secs: u64,
    pub message: Option<String>,
    pub started_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamState {
    pub name: String,
    pub ahead: u32,
    pub behind: u32,
    pub gone: bool,
    /// A push without a named remote goes to this upstream (same branch name, `push.default`
    /// `upstream`/`tracking`, or Forkyard recorded it after an explicit push). Otherwise the
    /// branch counts as not published: a push asks where to.
    pub pushes_to_upstream: bool,
}

/// Commits that after a checkout are only reachable by their SHA.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeftBehind {
    /// The commit that was left (HEAD before the switch).
    pub sha: Sha,
    /// This many commits are not attached to any ref.
    pub count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub head: Head,
    pub upstream: Option<UpstreamState>,
    pub unstaged: Vec<FileChange>,
    pub staged: Vec<FileChange>,
    pub conflicted: Vec<FileChange>,
    pub operation: Option<Operation>,
    /// Paths whose conflict in the running operation is already resolved (read from the index,
    /// `git ls-files --resolve-undo`) – for "N of M conflicts resolved", also after a restart.
    #[serde(default)]
    pub resolved_conflicts: Vec<String>,
    /// An operation the app does not control holds the repository in an intermediate state:
    /// `"am"` = a `git am` (applying patches) started outside waits to be continued or
    /// aborted. `operation` is then `None`.
    #[serde(default)]
    pub foreign_operation: Option<String>,
    /// Only in the response of `branch_checkout`: the switch left a detached HEAD whose
    /// commits are not attached to any branch, tag or remote branch.
    #[serde(default)]
    pub left_behind: Option<LeftBehind>,
    /// The checked-out branch is not on its remote under a name a plain push reaches (no upstream,
    /// upstream gone, or an upstream of another name): the number of its commits on no
    /// remote-tracking ref of that remote (all remotes without an upstream). `Some(0)` is still
    /// "to push" – the branch itself is missing there. `None`: published, detached, or no remote.
    pub unpublished: Option<u32>,
    pub identity_set: bool,
    /// Fingerprint of HEAD and index (for `stale_state` checks).
    pub token: String,
}
