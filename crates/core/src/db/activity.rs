//! Table `activity_log`: log of Git calls and app actions.
//! In the database the scopes are called `application`/`repository`, in the model `app`/`repo`.

use rusqlite::{params, Connection, Row};

use crate::error::{CoreError, CoreResult};
use crate::model::{ActivityEntry, ActivityPage, ActivityScope};

/// New entry. Credentials must have been removed beforehand (the Git runner does that).
#[derive(Debug, Clone)]
pub struct NewActivity {
    /// `None` = app log.
    pub repo_id: Option<String>,
    /// Short description, e.g. "git fetch".
    pub description: String,
    pub command: String,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub output: String,
    pub started_at: String,
    /// Error code of a failed call.
    pub code: Option<crate::error::ErrorCode>,
}

fn from_row(r: &Row) -> rusqlite::Result<ActivityEntry> {
    let id: i64 = r.get("id")?;
    let scope: String = r.get("scope")?;
    let duration: Option<i64> = r.get("duration_ms")?;
    Ok(ActivityEntry {
        id: id.to_string(),
        scope: if scope == "repository" { ActivityScope::Repo } else { ActivityScope::App },
        repo_id: r.get("repository_id")?,
        started_at: r.get("started_at")?,
        duration_ms: duration.unwrap_or(0).max(0) as u64,
        command: r.get::<_, Option<String>>("command")?.unwrap_or_default(),
        exit_code: r.get("exit_code")?,
        output: r.get::<_, Option<String>>("output")?.unwrap_or_default(),
        // Unknown values (from a newer version of the app) count as "no code".
        code: r.get::<_, Option<String>>("code")?.and_then(|code| serde_json::from_value(serde_json::Value::String(code)).ok()),
    })
}

const COLUMNS: &str = "id, scope, repository_id, started_at, duration_ms, command, exit_code, output, code";

/// Writes an entry. If the repo ID does not exist (yet), it ends up in the app log.
pub fn insert(conn: &Connection, e: &NewActivity) -> CoreResult<ActivityEntry> {
    let write = |repo_id: Option<&str>| {
        let scope = if repo_id.is_some() { "repository" } else { "application" };
        conn.execute(
            "insert into activity_log (scope, repository_id, description, command, exit_code, duration_ms, output, started_at, code)
             values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![scope, repo_id, e.description, e.command, e.exit_code, e.duration_ms as i64, e.output, e.started_at, e.code.map(|c| c.as_str())],
        )
    };
    match write(e.repo_id.as_deref()) {
        Ok(_) => {}
        Err(err) if e.repo_id.is_some() && super::is_foreign_key_violation(&err) => {
            write(None)?;
        }
        Err(err) => return Err(err.into()),
    }
    let id = conn.last_insert_rowid();
    Ok(conn.query_row(&format!("select {COLUMNS} from activity_log where id = ?1"), [id], from_row)?)
}

/// One page, newest first. `cursor` is the ID of the last entry of the previous page.
/// With `scope = Repo` and no `repo_id`, the entries of all repositories are returned.
pub fn page(
    conn: &Connection,
    scope: ActivityScope,
    repo_id: Option<&str>,
    cursor: Option<&str>,
    limit: u32,
) -> CoreResult<ActivityPage> {
    let limit = limit.clamp(1, 500) as i64;
    let before: i64 = match cursor {
        Some(c) => c.parse().map_err(|_| CoreError::not_allowed("Invalid cursor for the activity log."))?,
        None => i64::MAX,
    };
    let scope_db = match scope {
        ActivityScope::App => "application",
        ActivityScope::Repo => "repository",
    };
    let mut stmt = conn.prepare(&format!(
        "select {COLUMNS} from activity_log
         where scope = ?1 and (?2 is null or repository_id = ?2) and id < ?3
         order by id desc limit ?4"
    ))?;
    let mut entries = stmt
        .query_map(params![scope_db, repo_id, before, limit + 1], from_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let next_cursor = if entries.len() as i64 > limit {
        entries.truncate(limit as usize);
        entries.last().map(|e| e.id.clone())
    } else {
        None
    };
    Ok(ActivityPage { entries, next_cursor })
}

/// Clean-up: delete entries older than `before` and keep only the newest `keep` entries
/// per repository (or in the app log). Returns the number of deleted rows.
pub fn cleanup(conn: &Connection, before: &str, keep: u32) -> CoreResult<usize> {
    let mut removed = conn.execute("delete from activity_log where started_at < ?1", [before])?;
    removed += conn.execute(
        "delete from activity_log where id in (
           select id from (
             select id, row_number() over (partition by coalesce(repository_id, '') order by id desc) as n
             from activity_log
           ) where n > ?1
         )",
        [keep as i64],
    )?;
    Ok(removed)
}
