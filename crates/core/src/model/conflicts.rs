//! Conflicts with intent

use super::*;

/// One conflict block of the conflict tool as line ranges of the current side (index stage 2)
/// and the incoming side (stage 3): 0-based first line and number of lines. The core cuts the
/// text itself from the versions in the index.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "conflicts.ts"))]
#[serde(rename_all = "camelCase")]
pub struct ConflictBlockRange {
    pub ours_start: u32,
    pub ours_count: u32,
    pub theirs_start: u32,
    pub theirs_count: u32,
}

/// How a conflict block went to the AI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "conflicts.ts"))]
#[serde(rename_all = "snake_case")]
pub enum IntentSent {
    /// Completely: explanation and proposal.
    Full,
    /// Start and end only, to stay within the size limit: explanation only.
    Shortened,
    /// Values in the block were masked before sending: explanation only.
    Redacted,
    /// Not sent, to stay within the size limit.
    LeftOut,
}

/// The answer for one conflict block.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "conflicts.ts"))]
#[serde(rename_all = "camelCase")]
pub struct ConflictIntentBlock {
    /// Index among the conflicts of the file (0-based, the order of the ranges sent).
    pub block: u32,
    pub sent: IntentSent,
    /// What the current side wanted; `None` for `left_out`.
    pub ours_why: Option<String>,
    pub theirs_why: Option<String>,
    /// Text that replaces the block's range in the result, every line ending in `\n`; only for `full`.
    pub text: Option<String>,
}

/// `ai_conflict_intent`: one entry per conflict block, in order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "conflicts.ts"))]
#[serde(rename_all = "camelCase")]
pub struct ConflictIntent {
    pub path: String,
    pub blocks: Vec<ConflictIntentBlock>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "conflicts.ts"))]
#[serde(rename_all = "snake_case")]
pub enum ConflictSide {
    Ours,
    Theirs,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "conflicts.ts"))]
#[serde(rename_all = "snake_case")]
pub enum RebaseAction {
    Pick,
    Reword,
    Squash,
    /// Folds into the row above like `Squash`, but its message is dropped (Git's `fixup`).
    Fixup,
    Drop,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "conflicts.ts"))]
#[serde(rename_all = "camelCase")]
pub struct RebasePlanRow {
    pub sha: Sha,
    pub summary: String,
    pub description: String,
    pub author: Person,
    pub authored_at: IsoTime,
    pub action: RebaseAction,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "conflicts.ts"))]
#[serde(rename_all = "snake_case")]
pub enum RebaseRefusal {
    MergeCommits,
    NoCommonAncestor,
    NothingToRebase,
    DirtyWorktree,
    Detached,
    /// A merge, rebase, cherry-pick or revert is already running.
    OperationInProgress,
}

/// Exact reason for `RebaseRefusal::NoCommonAncestor`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "conflicts.ts"))]
#[serde(rename_all = "snake_case")]
pub enum RebaseRefusalDetail {
    /// The base is related to the branch, but not an ancestor (rebasing onto it first helps).
    NotAncestor,
    /// Base and branch have no common history at all.
    UnrelatedHistory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "conflicts.ts"))]
#[serde(tag = "status", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum RebasePlan {
    Ok {
        branch: String,
        base: Sha,
        /// Oldest commit first, as in Git's todo file.
        rows: Vec<RebasePlanRow>,
        rewrites_pushed: bool,
        /// Local branches (except this one, and none checked out in a worktree) whose tip is one of
        /// the commits – `update_refs` moves them along.
        dependent_branches: Vec<String>,
    },
    Refused {
        reason: RebaseRefusal,
        /// Only set for `no_common_ancestor`.
        detail: Option<RebaseRefusalDetail>,
        message: String,
    },
}

/// What `conflict_preview` simulates (see `commands::preview`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "conflicts.ts"))]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum PreviewOp {
    /// `theirs` (branch, remote branch, tag or SHA) merged into HEAD.
    Merge { theirs: String },
    /// Applied onto HEAD in this order.
    CherryPick { commits: Vec<Sha> },
    /// Reverted on top of HEAD in this order.
    Revert { commits: Vec<Sha> },
    /// `branch` (default: HEAD) rebased onto `onto`. `upstream` limits the range (default: `onto`);
    /// `commits` is an explicit order (interactive plan without the dropped rows).
    Rebase { onto: String, upstream: Option<String>, branch: Option<String>, commits: Option<Vec<Sha>> },
    /// Patch text as for `patch_apply`, checked against the working directory.
    Patch { text: String },
}

/// Result of `conflict_preview`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "conflicts.ts"))]
#[serde(tag = "status", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ConflictPreview {
    Clean,
    /// `at_commit`: in a series, the first commit that conflicts.
    Conflicts {
        files: Vec<String>,
        at_commit: Option<Sha>,
    },
    /// Could not be simulated (too many commits, merge commit, unrelated history, invalid patch …).
    Unknown {
        reason: String,
    },
}
