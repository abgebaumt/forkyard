//! Log

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "log.ts"))]
#[serde(rename_all = "snake_case")]
pub enum ActivityScope {
    App,
    Repo,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "log.ts"))]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    pub id: Id,
    pub scope: ActivityScope,
    pub repo_id: Option<Id>,
    pub started_at: IsoTime,
    pub duration_ms: u64,
    pub command: String,
    pub exit_code: Option<i32>,
    pub output: String,
    /// Error code of a failed call (as in `CoreError`), otherwise `None`.
    pub code: Option<crate::error::ErrorCode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "log.ts"))]
#[serde(rename_all = "camelCase")]
pub struct ActivityPage {
    pub entries: Vec<ActivityEntry>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "log.ts"))]
#[serde(rename_all = "snake_case")]
pub enum ExternalTarget {
    Editor,
    Terminal,
    FileManager,
    /// External diff tool for a file (`path` required, `source` selects the comparison).
    DiffTool,
    /// External merge tool for a conflicted file (`path` required).
    MergeTool,
}
