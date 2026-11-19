//! Branch cleaner: local branches that can go, each with its reasons.

use super::*;

/// Why a branch is listed or what speaks against deleting it. Always in this order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "branch_cleanup.ts"))]
// camelCase: the kinds double as i18n keys `cleanupBranches.reason.<kind>`.
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum BranchCleanupReason {
    /// Fully contained in the default branch.
    Merged,
    /// Its pull request was merged (also squash or rebase merges).
    PrMerged { number: u64 },
    /// The upstream branch no longer exists on the remote.
    UpstreamGone,
    /// No commit for longer than the threshold (`Settings.branch_cleanup_stale_days`).
    Stale,
    /// The host knows no pull request for it.
    NoPr,
    /// Commits not in the default branch.
    Unmerged { count: u32 },
    /// Commits not on its upstream.
    Unpushed { count: u32 },
    /// Checked out in a worktree.
    Worktree,
    /// Matches a protected pattern.
    Protected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "branch_cleanup.ts"))]
#[serde(rename_all = "snake_case")]
pub enum BranchCleanupClass {
    Safe,
    Review,
    Blocked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "branch_cleanup.ts"))]
#[serde(rename_all = "camelCase")]
pub struct BranchCleanupCandidate {
    pub name: String,
    pub sha: Sha,
    pub class: BranchCleanupClass,
    /// In the fixed order of `BranchCleanupReason`.
    pub reasons: Vec<BranchCleanupReason>,
    pub committed_at: IsoTime,
    /// Only when the upstream exists (not gone) and holds no commit beyond this branch and the default
    /// branch, so deleting it there loses nothing the class doesn't name: remote name, branch name there
    /// and the tip known here (the lease for the deletion).
    pub upstream_remote: Option<String>,
    pub upstream_branch: Option<String>,
    pub upstream_sha: Option<Sha>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "branch_cleanup.ts"))]
#[serde(rename_all = "camelCase")]
pub struct BranchCleanupList {
    pub default_branch: Option<String>,
    pub candidates: Vec<BranchCleanupCandidate>,
    /// Host whose PR data could not be read; `None` = loaded or no host.
    pub pr_data_missing: Option<HostKind>,
}

/// A branch to delete and the commit it must still point to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "branch_cleanup.ts"))]
#[serde(rename_all = "camelCase")]
pub struct BranchCleanupTarget {
    pub name: String,
    pub sha: Sha,
}
