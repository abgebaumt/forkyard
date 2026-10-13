//! Table `commit_drafts`: unfinished commit message per working directory
//! (`worktree_path` = "" for the main working directory).

use rusqlite::{params, Connection, OptionalExtension};

use super::int_bool;
use crate::error::CoreResult;
use crate::model::CommitDraft;
use crate::util;

pub fn get(conn: &Connection, repo_id: &str, worktree_path: &str) -> CoreResult<CommitDraft> {
    let draft = conn
        .query_row(
            "select summary, description, is_amend from commit_drafts where repository_id = ?1 and worktree_path = ?2",
            params![repo_id, worktree_path],
            |r| Ok(CommitDraft { summary: r.get(0)?, description: r.get(1)?, amend: int_bool(r.get(2)?) }),
        )
        .optional()?;
    Ok(draft.unwrap_or_default())
}

/// Saves the draft; an empty draft without amend is deleted.
pub fn set(conn: &Connection, repo_id: &str, worktree_path: &str, draft: &CommitDraft) -> CoreResult<()> {
    if draft.summary.is_empty() && draft.description.is_empty() && !draft.amend {
        conn.execute(
            "delete from commit_drafts where repository_id = ?1 and worktree_path = ?2",
            params![repo_id, worktree_path],
        )?;
        return Ok(());
    }
    conn.execute(
        "insert into commit_drafts (repository_id, worktree_path, summary, description, is_amend, updated_at)
         values (?1, ?2, ?3, ?4, ?5, ?6)
         on conflict (repository_id, worktree_path) do update set
           summary = excluded.summary, description = excluded.description,
           is_amend = excluded.is_amend, updated_at = excluded.updated_at",
        params![repo_id, worktree_path, draft.summary, draft.description, draft.amend as i64, util::now_iso()],
    )?;
    Ok(())
}
