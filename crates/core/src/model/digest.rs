//! "What's new": what changed in a repository in the last 24 hours.

use super::*;

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
    /// `Remote` (a branch with commits in the window) or `Tag` (created in the window).
    pub kind: RefKind,
    /// For a tag the commit it points to.
    pub new_sha: Option<Sha>,
    /// Commits of the window not already listed under an earlier ref (at most 500 are read per ref);
    /// 0 for a tag.
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
    /// Open and active in the window (the host list has no creation date).
    Updated,
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
    /// Start of the window: 24 hours before the digest was composed.
    pub since: IsoTime,
    /// The default branch first, then by name.
    pub refs: Vec<DigestRef>,
    /// Distinct commits across all refs, own ones included.
    pub new_commits: u32,
    /// Sorted by path. Only from other people's commits (at most 500 per ref).
    pub your_files: Vec<DigestFile>,
    pub behind: Option<DigestBehind>,
    pub prs: Option<DigestPrs>,
    pub pr_data_missing: Option<HostKind>,
    /// No refs and no PR changes (behind alone does not count).
    pub is_empty: bool,
}
