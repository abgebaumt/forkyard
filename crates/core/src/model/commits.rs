//! Commits and files

use super::*;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "commits.ts"))]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "commits.ts"))]
#[serde(rename_all = "snake_case")]
pub enum SignatureStatus {
    None,
    Good,
    Bad,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "commits.ts"))]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub sha: Sha,
    pub parents: Vec<Sha>,
    pub author: Person,
    pub committer: Person,
    pub authored_at: IsoTime,
    pub committed_at: IsoTime,
    pub author_offset_minutes: i32,
    pub summary: String,
    pub description: String,
    pub co_authors: Vec<Person>,
    pub signature: SignatureStatus,
    pub refs: Vec<RefLabelInfo>,
    pub is_head: bool,
    pub is_pushed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "commits.ts"))]
#[serde(rename_all = "snake_case")]
pub enum FileStatus {
    Modified,
    Added,
    Deleted,
    Renamed,
    Conflicted,
    Untracked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "commits.ts"))]
#[serde(rename_all = "snake_case")]
pub enum FileArea {
    Unstaged,
    Staged,
    Commit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "commits.ts"))]
#[serde(rename_all = "snake_case")]
pub enum ConflictKind {
    BothModified,
    BothAdded,
    BothDeleted,
    DeletedByUs,
    DeletedByThem,
    AddedByUs,
    AddedByThem,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "commits.ts"))]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub area: FileArea,
    pub is_binary: bool,
    pub is_lfs: bool,
    pub added: Option<u32>,
    pub removed: Option<u32>,
    pub conflict: Option<ConflictKind>,
}

/// What `commit_details` and `diff_file` compare.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "commits.ts"))]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum DiffSource {
    Unstaged,
    Staged,
    /// A commit against its first parent.
    Commit {
        sha: Sha,
    },
    /// Two commits; `to: None` means working directory.
    Range {
        from: Sha,
        to: Option<Sha>,
    },
    Stash {
        index: u32,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "commits.ts"))]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub commit: Option<CommitInfo>,
    pub files: Vec<FileChange>,
    pub added: u32,
    pub removed: u32,
    pub not_combinable_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "commits.ts"))]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    pub sha: Sha,
    pub summary: String,
    pub author: Person,
    pub authored_at: IsoTime,
    pub parents: Vec<Sha>,
}

/// Narrowing for `commit_search`; every field is optional.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "commits.ts", optional_fields = nullable))]
#[serde(rename_all = "camelCase", default)]
pub struct CommitSearchFilters {
    /// Commits that add or remove this text in a file (`git log -S`, ignoring case).
    pub pickaxe: Option<String>,
    /// Committed at or after: `YYYY-MM-DD` (start of that day, local time) or ISO-8601 with time.
    pub since: Option<String>,
    /// Committed at or before: `YYYY-MM-DD` (end of that day, local time) or ISO-8601 with time.
    pub until: Option<String>,
    /// Only commits that touch these paths (files or folders, relative to the repository, literal).
    pub paths: Option<Vec<String>>,
}
