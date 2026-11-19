//! Diff

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffLineKind {
    Context,
    Add,
    Remove,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
    pub text: String,
    pub no_newline: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub index: u32,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub section: String,
    pub lines: Vec<DiffLine>,
}

/// Content of the variant `{ kind: "text" }` of `FileDiff` (without the field `kind`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub hunks: Vec<Hunk>,
    pub old_text: Option<String>,
    pub new_text: Option<String>,
    pub encoding: String,
    pub token: Option<String>,
    /// Only for a range between two commits (`DiffSource::Range` with `to`): fingerprint for
    /// `range_apply` (`PatchSelection.expect`). Kept apart from `token`, which enables line staging.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range_token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum FileDiff {
    Text(TextDiff),
    Binary {
        path: String,
        old_path: Option<String>,
        status: FileStatus,
        old_size: Option<u64>,
        new_size: Option<u64>,
    },
    Image {
        path: String,
        old_path: Option<String>,
        status: FileStatus,
        old_data_url: Option<String>,
        new_data_url: Option<String>,
        old_size: Option<u64>,
        new_size: Option<u64>,
    },
    Lfs {
        path: String,
        old_path: Option<String>,
        status: FileStatus,
        old_oid: Option<String>,
        new_oid: Option<String>,
        old_size: Option<u64>,
        new_size: Option<u64>,
    },
    /// Over 1 MB or 20,000 lines: only load with `force`.
    TooLarge {
        path: String,
        old_path: Option<String>,
        status: FileStatus,
        bytes: u64,
        lines: Option<u64>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HunkSelection {
    pub index: u32,
    /// Positions in `Hunk.lines` (add/remove only). `None` = the whole hunk.
    pub lines: Option<Vec<u32>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchSelection {
    pub path: String,
    pub hunks: Vec<HunkSelection>,
    pub expect: String,
}

/// Where `range_apply` puts the selected changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RangeApplyTarget {
    /// Unstaged, into the working directory.
    Worktree,
    /// Staged only; the working directory stays.
    Index,
    /// Working directory and index.
    Both,
}

/// Selected hunks and lines for a partial stash (`stash_create` with `selection`). Each entry is a
/// selection like `stage_patch` takes it, from the staged or the unstaged diff of one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashSelection {
    /// HEAD the UI made the selection on; anything else is `stale_state`.
    pub expect_head: Sha,
    pub staged: Vec<PatchSelection>,
    pub unstaged: Vec<PatchSelection>,
}
