//! Table `undo_entries`. Undo stack = entries with `state = 'done'` (newest first),
//! redo stack = entries with `state = 'undone'` (oldest first, because undo is LIFO).
//! Order by rowid, not by time (the same millisecond is possible).

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde_json::Value;

use crate::error::CoreResult;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UndoEntryState {
    Done,
    Undone,
}

impl UndoEntryState {
    pub fn as_str(self) -> &'static str {
        match self {
            UndoEntryState::Done => "done",
            UndoEntryState::Undone => "undone",
        }
    }
}

/// A stored undo entry.
#[derive(Debug, Clone, PartialEq)]
pub struct UndoEntry {
    pub id: String,
    pub repo_id: String,
    pub worktree_path: String,
    /// Value from the table's CHECK list, e.g. "commit", "discard".
    pub action: String,
    pub label: String,
    pub ref_name: Option<String>,
    pub ref_before: Option<String>,
    pub ref_after: Option<String>,
    pub head_before: String,
    pub head_after: Option<String>,
    pub payload: Value,
    pub state: UndoEntryState,
    pub created_at: String,
}

fn from_row(r: &Row) -> rusqlite::Result<UndoEntry> {
    let payload: String = r.get("payload")?;
    let state: String = r.get("state")?;
    Ok(UndoEntry {
        id: r.get("id")?,
        repo_id: r.get("repository_id")?,
        worktree_path: r.get("worktree_path")?,
        action: r.get("action")?,
        label: r.get("label")?,
        ref_name: r.get("ref_name")?,
        ref_before: r.get("ref_before")?,
        ref_after: r.get("ref_after")?,
        head_before: r.get("head_before")?,
        head_after: r.get("head_after")?,
        payload: serde_json::from_str(&payload).unwrap_or(Value::Null),
        state: if state == "undone" { UndoEntryState::Undone } else { UndoEntryState::Done },
        created_at: r.get("created_at")?,
    })
}

const COLUMNS: &str = "id, repository_id, worktree_path, action, label, ref_name, ref_before, ref_after,
    head_before, head_after, payload, state, created_at";

pub fn insert(conn: &Connection, e: &UndoEntry) -> CoreResult<()> {
    conn.execute(
        "insert into undo_entries (id, repository_id, worktree_path, action, label, ref_name, ref_before, ref_after,
           head_before, head_after, payload, state, created_at)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            e.id,
            e.repo_id,
            e.worktree_path,
            e.action,
            e.label,
            e.ref_name,
            e.ref_before,
            e.ref_after,
            e.head_before,
            e.head_after,
            e.payload.to_string(),
            e.state.as_str(),
            e.created_at
        ],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, id: &str) -> CoreResult<Option<UndoEntry>> {
    Ok(conn.query_row(&format!("select {COLUMNS} from undo_entries where id = ?1"), [id], from_row).optional()?)
}

/// Top entry of the undo stack.
pub fn top_done(conn: &Connection, repo_id: &str, worktree_path: &str) -> CoreResult<Option<UndoEntry>> {
    Ok(conn
        .query_row(
            &format!(
                "select {COLUMNS} from undo_entries where repository_id = ?1 and worktree_path = ?2 and state = 'done'
                 order by rowid desc limit 1"
            ),
            params![repo_id, worktree_path],
            from_row,
        )
        .optional()?)
}

/// Top entry of the redo stack.
pub fn top_undone(conn: &Connection, repo_id: &str, worktree_path: &str) -> CoreResult<Option<UndoEntry>> {
    Ok(conn
        .query_row(
            &format!(
                "select {COLUMNS} from undo_entries where repository_id = ?1 and worktree_path = ?2 and state = 'undone'
                 order by rowid asc limit 1"
            ),
            params![repo_id, worktree_path],
            from_row,
        )
        .optional()?)
}

/// All entries of the undo stack, the top (newest) first.
pub fn list_done(conn: &Connection, repo_id: &str, worktree_path: &str) -> CoreResult<Vec<UndoEntry>> {
    let mut stmt = conn.prepare(&format!(
        "select {COLUMNS} from undo_entries where repository_id = ?1 and worktree_path = ?2 and state = 'done' order by rowid desc"
    ))?;
    let rows = stmt.query_map(params![repo_id, worktree_path], from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// All entries of the redo stack, the top (oldest) first.
pub fn list_undone(conn: &Connection, repo_id: &str, worktree_path: &str) -> CoreResult<Vec<UndoEntry>> {
    let mut stmt = conn.prepare(&format!(
        "select {COLUMNS} from undo_entries where repository_id = ?1 and worktree_path = ?2 and state = 'undone' order by rowid"
    ))?;
    let rows = stmt.query_map(params![repo_id, worktree_path], from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn set_state(conn: &Connection, id: &str, state: UndoEntryState) -> CoreResult<()> {
    conn.execute("update undo_entries set state = ?2 where id = ?1", params![id, state.as_str()])?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> CoreResult<()> {
    conn.execute("delete from undo_entries where id = ?1", [id])?;
    Ok(())
}

/// Entries older than `before` (ISO time): (id, repo_id).
pub fn older_than(conn: &Connection, before: &str) -> CoreResult<Vec<(String, String)>> {
    let mut stmt = conn.prepare("select id, repository_id from undo_entries where created_at < ?1")?;
    let rows = stmt
        .query_map([before], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<Vec<(String, String)>>>()?;
    Ok(rows)
}

/// Every entry of a repository (all worktree paths, both stacks), oldest first.
pub fn all_for_repo(conn: &Connection, repo_id: &str) -> CoreResult<Vec<UndoEntry>> {
    let mut stmt = conn.prepare(&format!("select {COLUMNS} from undo_entries where repository_id = ?1 order by rowid"))?;
    let rows = stmt.query_map([repo_id], from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}
