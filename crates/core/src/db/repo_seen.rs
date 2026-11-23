//! Table `repo_seen`: what the "What's new" dialog was last based on, per profile and repository.
//! A historical snapshot of the remote branches and tags (full ref name → SHA as Git stores it),
//! never read back as the current state. The PR columns of older versions stay unused.

use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::CoreResult;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeenRow {
    /// When the dialog was last shown.
    pub seen_at: String,
    pub refs: BTreeMap<String, String>,
}

pub fn get(conn: &Connection, profile_id: &str, repo_id: &str) -> CoreResult<Option<SeenRow>> {
    let row: Option<(String, String)> = conn
        .query_row("select seen_at, refs from repo_seen where profile_id = ?1 and repository_id = ?2", params![profile_id, repo_id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .optional()?;
    Ok(row.map(|(seen_at, refs)| SeenRow {
        seen_at,
        refs: serde_json::from_str(&refs).unwrap_or_else(|e| {
            log::warn!("Seen state of {repo_id} unreadable, treated as empty: {e}");
            BTreeMap::new()
        }),
    }))
}

/// Writes the row (insert or replace).
pub fn put(conn: &Connection, profile_id: &str, repo_id: &str, row: &SeenRow) -> CoreResult<()> {
    let refs = serde_json::to_string(&row.refs).unwrap_or_else(|_| "{}".to_string());
    conn.execute(
        "insert into repo_seen (profile_id, repository_id, seen_at, refs) values (?1, ?2, ?3, ?4)
         on conflict (profile_id, repository_id) do update set seen_at = excluded.seen_at, refs = excluded.refs",
        params![profile_id, repo_id, row.seen_at, refs],
    )?;
    Ok(())
}
