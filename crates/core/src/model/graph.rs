//! Graph

use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefLabelInfo {
    pub kind: RefKind,
    pub name: String,
    pub full_name: String,
    pub is_head: bool,
}

/// Line segment in the vertical band of a row; `None` = starts/ends at the node.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub top: Option<u32>,
    pub bottom: Option<u32>,
    pub color: u32,
    pub dashed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GraphRowKind {
    Commit,
    Merge,
    Wip,
    Stash,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRow {
    pub id: String,
    pub kind: GraphRowKind,
    pub sha: Option<Sha>,
    pub lane: u32,
    pub color: u32,
    pub edges: Vec<GraphEdge>,
    pub parents: Vec<Sha>,
    pub summary: String,
    pub author_name: String,
    pub author_email: String,
    pub authored_at: Option<IsoTime>,
    pub refs: Vec<RefLabelInfo>,
    pub is_head: bool,
    pub stash_index: Option<u32>,
    pub wip_count: Option<u32>,
    /// Only for merges: collapsed, with this many commits hidden below it; `None` = expanded.
    pub collapsed_count: Option<u32>,
    /// The merge is meant to be collapsed but brings in more than 20 000 commits: it stays expanded.
    pub collapse_too_large: bool,
    /// Only for merges: collapsing hides at least one commit – not so when every commit it brought in
    /// is also on a visible branch or tag. The UI shows the arrow only then.
    pub collapsible: bool,
    /// Commit of the checked-out branch not pushed yet, or of its upstream not pulled yet.
    pub sync: SyncMark,
}

/// Position of a commit relative to the checked-out branch and its upstream.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncMark {
    #[default]
    None,
    /// In the branch, not in its upstream (not pushed yet).
    Ahead,
    /// In the upstream, not in the branch (not pulled yet).
    Behind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphPage {
    pub rows: Vec<GraphRow>,
    pub next_cursor: Option<String>,
    pub max_lane: u32,
}

/// What a reflog entry records, from the start of its message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReflogAction {
    Checkout,
    Commit,
    Reset,
    Rebase,
    Merge,
    Pull,
    CherryPick,
    Amend,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflogEntry {
    /// Where the ref pointed after the change.
    pub sha: Sha,
    /// `HEAD@{3}`, `main@{0}` …
    pub selector: String,
    pub action: ReflogAction,
    /// Git's text, without credentials.
    pub message: String,
    pub time: IsoTime,
    /// The commit still exists (Git may have removed it, e.g. after `gc`).
    pub exists: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflogPage {
    pub entries: Vec<ReflogEntry>,
    /// null when the reflog has ended.
    pub next_cursor: Option<String>,
}
