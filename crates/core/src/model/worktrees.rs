//! Worktrees, submodules, LFS, patches, signing

use super::*;

/// A working directory of the repository (`git worktree`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "worktrees.ts"))]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    /// Short name of the checked-out branch; `None` for a detached HEAD.
    pub branch: Option<String>,
    pub head: Option<Sha>,
    /// The main worktree (the repository itself).
    pub is_main: bool,
    /// The worktree that is open under this `repoId`.
    pub is_current: bool,
    pub is_locked: bool,
    pub lock_reason: Option<String>,
    /// The folder is missing; `worktree_prune` removes the entry.
    pub is_prunable: bool,
    /// Uncommitted changes or untracked files (removing then needs `force`).
    pub has_changes: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "worktrees.ts"))]
#[serde(rename_all = "snake_case")]
pub enum SubmoduleState {
    /// Checked out, at the recorded commit, without own changes.
    Initialized,
    /// Recorded, but not fetched yet.
    Uninitialized,
    /// A different commit is checked out than recorded (or the entry has a conflict).
    OutOfSync,
    /// At the recorded commit, but with own changes or untracked files.
    Modified,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "worktrees.ts"))]
#[serde(rename_all = "camelCase")]
pub struct Submodule {
    /// Name in `.gitmodules` (usually the same as the path).
    pub name: String,
    pub path: String,
    /// URL from `.gitmodules`, without credentials; `None` if nothing is there.
    pub url: Option<String>,
    /// The commit recorded in the repository.
    pub sha: Sha,
    /// The commit checked out in the submodule; `None` if it is not initialized.
    pub head_sha: Option<Sha>,
    pub state: SubmoduleState,
    /// Branch checked out in the submodule; `None` for a detached HEAD (the normal case) or without a checkout.
    pub branch: Option<String>,
    /// Branch recorded in `.gitmodules` (`submodule.<name>.branch`).
    pub tracking_branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "worktrees.ts"))]
#[serde(rename_all = "camelCase")]
pub struct LfsStatus {
    pub installed: bool,
    /// e.g. "3.7.1"; `None` without Git LFS.
    pub version: Option<String>,
    /// Patterns tracked via LFS, sorted.
    pub patterns: Vec<String>,
}
