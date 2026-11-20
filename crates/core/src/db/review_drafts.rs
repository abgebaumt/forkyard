//! Table `pr_review_drafts`: comments of the own pull request review that have not been sent yet,
//! per repository, repository at the host (`owner/name`) and pull request number.

use rusqlite::{params, Connection, OptionalExtension, Row};

use crate::error::{CoreError, CoreResult};
use crate::model::{NewReviewComment, ReviewDraft, ReviewDraftOrigin, ReviewSide};
use crate::util;

const COLUMNS: &str = "id, path, line, start_line, side, old_line, commit_sha, body, error";

fn side_text(side: ReviewSide) -> &'static str {
    match side {
        ReviewSide::New => "new",
        ReviewSide::Old => "old",
    }
}

fn from_row(r: &Row) -> rusqlite::Result<ReviewDraft> {
    let side: String = r.get(4)?;
    Ok(ReviewDraft {
        id: r.get::<_, i64>(0)?.to_string(),
        origin: ReviewDraftOrigin::Local,
        path: r.get(1)?,
        line: Some(r.get(2)?),
        start_line: r.get(3)?,
        side: if side == "old" { ReviewSide::Old } else { ReviewSide::New },
        old_line: r.get(5)?,
        commit: Some(r.get(6)?),
        body: r.get(7)?,
        error: r.get(8)?,
    })
}

fn get(conn: &Connection, repo_id: &str, host_repo: &str, number: u64, id: i64) -> CoreResult<Option<ReviewDraft>> {
    Ok(conn
        .query_row(
            &format!("select {COLUMNS} from pr_review_drafts where id = ?1 and repository_id = ?2 and host_repo = ?3 and number = ?4"),
            params![id, repo_id, host_repo, number as i64],
            from_row,
        )
        .optional()?)
}

fn gone() -> CoreError {
    CoreError::not_found("This review draft no longer exists. Reload the pull request.")
}

/// The local drafts of a pull request, oldest first.
pub fn list(conn: &Connection, repo_id: &str, host_repo: &str, number: u64) -> CoreResult<Vec<ReviewDraft>> {
    let mut stmt = conn.prepare(&format!(
        "select {COLUMNS} from pr_review_drafts where repository_id = ?1 and host_repo = ?2 and number = ?3 order by id"
    ))?;
    let rows = stmt.query_map(params![repo_id, host_repo, number as i64], from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn insert(conn: &Connection, repo_id: &str, host_repo: &str, number: u64, draft: &NewReviewComment) -> CoreResult<ReviewDraft> {
    conn.execute(
        "insert into pr_review_drafts (repository_id, host_repo, number, commit_sha, path, line, start_line, side, old_line, body)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            repo_id,
            host_repo,
            number as i64,
            draft.commit,
            draft.path,
            draft.line,
            draft.start_line,
            side_text(draft.side),
            draft.old_line,
            draft.body
        ],
    )?;
    get(conn, repo_id, host_repo, number, conn.last_insert_rowid())?.ok_or_else(gone)
}

/// Replaces the draft's content and clears its error; `not_found` if the pull request has no such draft.
pub fn update(
    conn: &Connection,
    repo_id: &str,
    host_repo: &str,
    number: u64,
    id: i64,
    draft: &NewReviewComment,
) -> CoreResult<ReviewDraft> {
    let changed = conn.execute(
        "update pr_review_drafts set commit_sha = ?5, path = ?6, line = ?7, start_line = ?8, side = ?9, old_line = ?10, body = ?11,
           error = null, updated_at = ?12
         where id = ?1 and repository_id = ?2 and host_repo = ?3 and number = ?4",
        params![
            id,
            repo_id,
            host_repo,
            number as i64,
            draft.commit,
            draft.path,
            draft.line,
            draft.start_line,
            side_text(draft.side),
            draft.old_line,
            draft.body,
            util::now_iso()
        ],
    )?;
    if changed == 0 {
        return Err(gone());
    }
    get(conn, repo_id, host_repo, number, id)?.ok_or_else(gone)
}

/// Whether the draft existed.
pub fn delete(conn: &Connection, repo_id: &str, host_repo: &str, number: u64, id: i64) -> CoreResult<bool> {
    let n = conn.execute(
        "delete from pr_review_drafts where id = ?1 and repository_id = ?2 and host_repo = ?3 and number = ?4",
        params![id, repo_id, host_repo, number as i64],
    )?;
    Ok(n > 0)
}

/// Why the last send of the draft failed.
pub fn set_error(conn: &Connection, id: i64, error: &str) -> CoreResult<()> {
    conn.execute("update pr_review_drafts set error = ?2 where id = ?1", params![id, error])?;
    Ok(())
}
