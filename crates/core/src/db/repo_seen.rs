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
}

pub fn get(conn: &Connection, profile_id: &str, repo_id: &str) -> CoreResult<Option<SeenRow>> {
    let row: Option<(String, String, Option<i64>)> = conn
        .query_row(
            "select seen_at, refs, pr_max_number from repo_seen where profile_id = ?1 and repository_id = ?2",
            params![profile_id, repo_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    Ok(row.map(|(seen_at, refs, pr)| SeenRow {
        seen_at,
        refs: serde_json::from_str(&refs).unwrap_or_default(),
        pr_max_number: pr.and_then(|n| u64::try_from(n).ok()),
    }))
}

/// Writes the row (insert or replace).
pub fn put(conn: &Connection, profile_id: &str, repo_id: &str, row: &SeenRow) -> CoreResult<()> {
    let refs = serde_json::to_string(&row.refs).unwrap_or_else(|_| "{}".to_string());
    conn.execute(
        "insert into repo_seen (profile_id, repository_id, seen_at, refs, pr_max_number) values (?1, ?2, ?3, ?4, ?5)
         on conflict (profile_id, repository_id) do update
         set seen_at = excluded.seen_at, refs = excluded.refs, pr_max_number = excluded.pr_max_number",
        params![profile_id, repo_id, row.seen_at, refs, row.pr_max_number.and_then(|n| i64::try_from(n).ok())],
    )?;
    Ok(())
}
