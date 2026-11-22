//! Table `repo_seen`: what the user has seen per profile and repository ("What's new since …").
//! A historical snapshot of the remote branches and tags (full ref name → SHA as Git stores it),
//! never read back as the current state.

use std::collections::BTreeMap;

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::CoreResult;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeenRow {
    pub seen_at: String,
    pub refs: BTreeMap<String, String>,
    /// The highest PR number seen; `None` before the first look at the PRs.
    pub pr_max_number: Option<u64>,
    /// Numbers of the PRs open when last seen: only these can be merged or closed since.
    pub pr_open: Vec<u64>,
}

pub fn get(conn: &Connection, profile_id: &str, repo_id: &str) -> CoreResult<Option<SeenRow>> {
    let row: Option<(String, String, Option<i64>, String)> = conn
        .query_row(
            "select seen_at, refs, pr_max_number, pr_open from repo_seen where profile_id = ?1 and repository_id = ?2",
            params![profile_id, repo_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?;
    Ok(row.map(|(seen_at, refs, pr, pr_open)| SeenRow {
        seen_at,
        refs: serde_json::from_str(&refs).unwrap_or_else(|e| {
            log::warn!("Seen state of {repo_id} unreadable, treated as empty: {e}");
            BTreeMap::new()
        }),
        pr_max_number: pr.and_then(|n| u64::try_from(n).ok()),
        pr_open: serde_json::from_str(&pr_open).unwrap_or_default(),
    }))
}

/// Writes the row (insert or replace).
pub fn put(conn: &Connection, profile_id: &str, repo_id: &str, row: &SeenRow) -> CoreResult<()> {
    let refs = serde_json::to_string(&row.refs).unwrap_or_else(|_| "{}".to_string());
    let pr_open = serde_json::to_string(&row.pr_open).unwrap_or_else(|_| "[]".to_string());
    conn.execute(
        "insert into repo_seen (profile_id, repository_id, seen_at, refs, pr_max_number, pr_open) values (?1, ?2, ?3, ?4, ?5, ?6)
         on conflict (profile_id, repository_id) do update
         set seen_at = excluded.seen_at, refs = excluded.refs, pr_max_number = excluded.pr_max_number, pr_open = excluded.pr_open",
        params![profile_id, repo_id, row.seen_at, refs, row.pr_max_number.and_then(|n| i64::try_from(n).ok()), pr_open],
    )?;
    Ok(())
}
