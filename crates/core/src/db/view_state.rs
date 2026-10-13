//! Table `repo_view_state`: presentation per repository (hidden, solo, columns, sections).

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::CoreResult;
use crate::model::{ColumnState, RepoViewState, SectionState};
use crate::util;

fn parse_list<T: serde::de::DeserializeOwned>(text: &str) -> Option<Vec<T>> {
    serde_json::from_str::<Vec<T>>(text).ok()
}

/// Stored state or defaults. Empty column/section lists
/// (the table's default) count as "default".
pub fn get(conn: &Connection, repo_id: &str) -> CoreResult<RepoViewState> {
    let row = conn
        .query_row(
            "select hidden_refs, soloed_refs, pinned_refs, collapsed_folders, columns, section_visibility
             from repo_view_state where repository_id = ?1",
            [repo_id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                ))
            },
        )
        .optional()?;
    let mut state = RepoViewState::default();
    if let Some((hidden, solo, pinned, folders, columns, sections)) = row {
        state.hidden_refs = parse_list(&hidden).unwrap_or_default();
        state.solo_refs = parse_list(&solo).unwrap_or_default();
        state.pinned_refs = parse_list(&pinned).unwrap_or_default();
        state.collapsed_folders = parse_list(&folders).unwrap_or_default();
        if let Some(cols) = parse_list::<ColumnState>(&columns).filter(|c| !c.is_empty()) {
            state.columns = cols;
        }
        if let Some(secs) = parse_list::<SectionState>(&sections).filter(|s| !s.is_empty()) {
            state.sections = secs;
        }
    }
    Ok(state)
}

pub fn set(conn: &Connection, repo_id: &str, state: &RepoViewState) -> CoreResult<()> {
    conn.execute(
        "insert into repo_view_state
           (repository_id, hidden_refs, soloed_refs, pinned_refs, collapsed_folders, columns, section_visibility, updated_at)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         on conflict (repository_id) do update set
           hidden_refs = excluded.hidden_refs, soloed_refs = excluded.soloed_refs,
           pinned_refs = excluded.pinned_refs, collapsed_folders = excluded.collapsed_folders,
           columns = excluded.columns, section_visibility = excluded.section_visibility,
           updated_at = excluded.updated_at",
        params![
            repo_id,
            serde_json::to_string(&state.hidden_refs)?,
            serde_json::to_string(&state.solo_refs)?,
            serde_json::to_string(&state.pinned_refs)?,
            serde_json::to_string(&state.collapsed_folders)?,
            serde_json::to_string(&state.columns)?,
            serde_json::to_string(&state.sections)?,
            util::now_iso()
        ],
    )?;
    Ok(())
}
