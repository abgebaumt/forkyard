//! "What's new since …": what changed in a repository since the user's seen state.

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "digest.ts"))]
#[serde(rename_all = "snake_case")]
pub enum DigestRefChange {
    New,
    /// Moved forward (a branch) or moved at all (a tag).
    Updated,
    /// Force-pushed: the old commit is no longer in its history.
    Rewritten,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "digest.ts"))]
#[serde(rename_all = "camelCase")]
pub struct DigestCommit {
    pub sha: Sha,
    pub subject: String,
    /// The author's name only.
    pub author: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "digest.ts"))]
#[serde(rename_all = "camelCase")]
pub struct DigestRef {
    /// Short: "origin/main", "v1.0".
    pub name: String,
    /// `Remote` or `Tag`.
    pub kind: RefKind,
    pub change: DigestRefChange,
    /// For a tag the commit it pointed to.
    pub old_sha: Option<Sha>,
    /// For a tag the commit it points to.
    pub new_sha: Option<Sha>,
    /// Foreign commits not reachable from any seen ref. At most 500 commits are read per ref, own
    /// ones are dropped afterwards. 0 for a ref when the seen state had no ref still present in the repository.
    pub new_commits: u32,
    /// First 20, newest first.
    pub commits: Vec<DigestCommit>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "digest.ts"))]
#[serde(rename_all = "camelCase")]
pub struct DigestFile {
    pub path: String,
    /// Newest new commit touching it.
    pub sha: Sha,
    /// Changed in the working tree or index.
    pub local: bool,
    /// Changed on the current branch since its merge base with the base branch.
    pub on_branch: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "digest.ts"))]
#[serde(rename_all = "camelCase")]
pub struct DigestBehind {
    pub branch: String,
    /// Short name, e.g. "origin/main".
    pub base: String,
    pub behind: u32,
    pub ahead: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "digest.ts"))]
#[serde(rename_all = "snake_case")]
pub enum DigestPrChange {
    Opened,
    Merged,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "digest.ts"))]
#[serde(rename_all = "camelCase")]
pub struct DigestPr {
    pub number: u64,
    pub title: String,
    pub change: DigestPrChange,
    pub author: Option<String>,
    pub web_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "digest.ts"))]
#[serde(rename_all = "camelCase")]
pub struct DigestPrComments {
    pub number: u64,
    pub title: String,
    pub count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "digest.ts"))]
#[serde(rename_all = "camelCase")]
pub struct DigestPrs {
    pub changed: Vec<DigestPr>,
    pub comments: Vec<DigestPrComments>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "digest.ts"))]
#[serde(rename_all = "camelCase")]
pub struct Digest {
    /// When the user last looked.
    pub seen_at: IsoTime,
    /// Sorted by name.
    pub refs: Vec<DigestRef>,
    /// Distinct foreign commits across all refs.
    pub new_commits: u32,
    /// Sorted by path. Only from the commits read per ref (at most 500, see `DigestRef::new_commits`).
    pub your_files: Vec<DigestFile>,
    pub behind: Option<DigestBehind>,
    pub prs: Option<DigestPrs>,
    pub pr_data_missing: Option<HostKind>,
    /// What this digest compared; `digestMarkSeen` stores exactly this.
    pub mark: DigestMark,
    /// No refs and no PR changes (behind alone does not count).
    pub is_empty: bool,
}

/// The state a digest compared against, for `digestMarkSeen`: marking stores what the card showed,
/// so news that arrive while it is open stay news.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "digest.ts"))]
#[serde(rename_all = "camelCase")]
pub struct DigestMark {
    /// When the digest was composed: the next seen time.
    pub composed_at: IsoTime,
    /// Remote branches and tags compared (full ref name → object ID as Git stores it).
    pub refs: std::collections::BTreeMap<String, String>,
    /// Highest PR number read, never below the stored one.
    pub pr_max_number: Option<u64>,
    /// Numbers of the open PRs read; `None` without PR data (marking keeps the stored ones).
    pub pr_open: Option<Vec<u64>>,
}
