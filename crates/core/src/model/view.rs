//! View, drafts, settings

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GraphColumnId {
    Refs,
    Graph,
    Message,
    Author,
    Date,
    Sha,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SectionId {
    Local,
    Remote,
    Tags,
    Stashes,
    Worktrees,
    Submodules,
    /// The coding agents of the cockpit (left panel).
    Agents,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnState {
    pub id: GraphColumnId,
    pub visible: bool,
    pub width: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionState {
    pub id: SectionId,
    pub collapsed: bool,
    pub hidden: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoViewState {
    pub hidden_refs: Vec<String>,
    pub solo_refs: Vec<String>,
    pub pinned_refs: Vec<String>,
    pub collapsed_folders: Vec<String>,
    pub columns: Vec<ColumnState>,
    pub sections: Vec<SectionState>,
    /// Merge commits whose side branch the graph hides (full SHAs).
    #[serde(default)]
    pub collapsed_merges: Vec<String>,
    /// Every merge is collapsed – also those on pages loaded later.
    #[serde(default)]
    pub collapse_all_merges: bool,
}

impl Default for RepoViewState {
    fn default() -> Self {
        let col = |id, visible| ColumnState { id, visible, width: None };
        // Tags, stashes and submodules are secondary to the branches: they start collapsed.
        let sec = |id, collapsed| SectionState { id, collapsed, hidden: false };
        RepoViewState {
            hidden_refs: Vec::new(),
            solo_refs: Vec::new(),
            pinned_refs: Vec::new(),
            collapsed_folders: Vec::new(),
            columns: vec![
                col(GraphColumnId::Refs, true),
                col(GraphColumnId::Graph, true),
                col(GraphColumnId::Message, true),
                col(GraphColumnId::Author, true),
                col(GraphColumnId::Date, true),
                col(GraphColumnId::Sha, false),
            ],
            sections: vec![
                sec(SectionId::Local, false),
                sec(SectionId::Remote, false),
                sec(SectionId::Tags, true),
                sec(SectionId::Stashes, true),
                sec(SectionId::Worktrees, false),
                sec(SectionId::Submodules, true),
                sec(SectionId::Agents, false),
            ],
            collapsed_merges: Vec::new(),
            collapse_all_merges: false,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDraft {
    pub summary: String,
    pub description: String,
    pub amend: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Theme {
    Dark,
    Light,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DateFormat {
    Relative,
    Local,
    Iso,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffMode {
    Hunks,
    Inline,
    Split,
}

/// Own proxy for a host (`Settings.proxy_by_host`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProxy {
    /// `https://host[:port]`; the input may also be just `host` or `host:port`.
    pub host: String,
    /// Proxy address; empty = no proxy for this host.
    pub proxy: String,
}
