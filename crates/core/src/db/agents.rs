//! Table `agents`: metadata of the coding agents started from the cockpit. Git stays the truth
//! for branch and worktree (checked on every read); the session itself is not stored.

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::int_bool;
use crate::error::{CoreError, CoreResult};

/// Why a session ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EndReason {
    /// The program ended by itself (exit code recorded).
    Exited,
    /// The user stopped it.
    Stopped,
    /// The app was closed while it ran.
    AppClosed,
}

impl EndReason {
    pub fn as_str(self) -> &'static str {
        match self {
            EndReason::Exited => "exited",
            EndReason::Stopped => "stopped",
            EndReason::AppClosed => "app_closed",
        }
    }

    pub fn parse(value: &str) -> Option<EndReason> {
        [EndReason::Exited, EndReason::Stopped, EndReason::AppClosed].into_iter().find(|r| r.as_str() == value)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRow {
    pub id: String,
    pub repo_id: String,
    pub short_name: String,
    pub template_id: String,
    pub task: String,
    pub branch: String,
    pub worktree_path: String,
    pub base: String,
    pub base_sha: String,
    pub unattended: bool,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub exit_code: Option<i32>,
    pub end_reason: Option<EndReason>,
}

const COLUMNS: &str = "id, repository_id, short_name, template_id, task, branch, worktree_path, base, base_sha, unattended, started_at, ended_at, exit_code, end_reason";

fn from_row(r: &Row) -> rusqlite::Result<AgentRow> {
    let reason: Option<String> = r.get("end_reason")?;
    Ok(AgentRow {
        id: r.get("id")?,
        repo_id: r.get("repository_id")?,
        short_name: r.get("short_name")?,
        template_id: r.get("template_id")?,
        task: r.get("task")?,
        branch: r.get("branch")?,
        worktree_path: r.get("worktree_path")?,
        base: r.get("base")?,
        base_sha: r.get("base_sha")?,
        unattended: int_bool(r.get("unattended")?),
        started_at: r.get("started_at")?,
        ended_at: r.get("ended_at")?,
        exit_code: r.get("exit_code")?,
        end_reason: reason.as_deref().and_then(EndReason::parse),
    })
}

/// Stores a new agent. A short name already used in the repository: `name_exists`.
pub fn insert(conn: &Connection, row: &AgentRow) -> CoreResult<()> {
    let result = conn.execute(
        &format!("insert into agents ({COLUMNS}) values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)"),
        params![
            row.id,
            row.repo_id,
            row.short_name,
            row.template_id,
            row.task,
            row.branch,
            row.worktree_path,
            row.base,
            row.base_sha,
            i64::from(row.unattended),
            row.started_at,
            row.ended_at,
            row.exit_code,
            row.end_reason.map(EndReason::as_str),
        ],
    );
    match result {
        Ok(_) => Ok(()),
        Err(e) if super::is_unique_violation(&e) => Err(CoreError::name_exists(format!("An agent named “{}” already exists in this repository.", row.short_name))),
        Err(e) => Err(e.into()),
    }
}

pub fn get(conn: &Connection, id: &str) -> CoreResult<Option<AgentRow>> {
    Ok(conn.query_row(&format!("select {COLUMNS} from agents where id = ?1"), [id], from_row).optional()?)
}

pub fn require(conn: &Connection, id: &str) -> CoreResult<AgentRow> {
    get(conn, id)?.ok_or_else(|| CoreError::not_found("This coding agent no longer exists."))
}

/// The repository's agents, most recently started first.
pub fn list_for_repo(conn: &Connection, repo_id: &str) -> CoreResult<Vec<AgentRow>> {
    let mut stmt = conn.prepare(&format!("select {COLUMNS} from agents where repository_id = ?1 order by started_at desc, rowid desc"))?;
    let rows = stmt.query_map([repo_id], from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Agents whose session has not ended according to the database (running, or the app ended
/// without recording it).
pub fn list_open(conn: &Connection) -> CoreResult<Vec<AgentRow>> {
    let mut stmt = conn.prepare(&format!("select {COLUMNS} from agents where ended_at is null order by id"))?;
    let rows = stmt.query_map([], from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn set_ended(conn: &Connection, id: &str, ended_at: &str, exit_code: Option<i32>, reason: EndReason) -> CoreResult<()> {
    conn.execute(
        "update agents set ended_at = ?2, exit_code = ?3, end_reason = ?4 where id = ?1",
        params![id, ended_at, exit_code, reason.as_str()],
    )?;
    Ok(())
}

/// A new session in the same worktree ("Resume").
pub fn set_restarted(conn: &Connection, id: &str, started_at: &str) -> CoreResult<()> {
    conn.execute(
        "update agents set started_at = ?2, ended_at = null, exit_code = null, end_reason = null where id = ?1",
        params![id, started_at],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> CoreResult<()> {
    conn.execute("delete from agents where id = ?1", [id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{self, Db};
    use std::path::Path;

    fn row(id: &str, repo: &str, short: &str, started: &str) -> AgentRow {
        AgentRow {
            id: id.into(),
            repo_id: repo.into(),
            short_name: short.into(),
            template_id: "claude".into(),
            task: "Größe der Übersicht anpassen\nmit zweiter Zeile".into(),
            branch: format!("agent/{short}"),
            worktree_path: format!("/home/anna/Mein Projekt.agents/{short}"),
            base: "main".into(),
            base_sha: "0123456789abcdef0123456789abcdef01234567".into(),
            unattended: false,
            started_at: started.into(),
            ended_at: None,
            exit_code: None,
            end_reason: None,
        }
    }

    #[test]
    fn rows_roundtrip_end_restart_and_go_with_their_repository() {
        let db = Db::open_in_memory().unwrap();
        let (repo, other) = db
            .with(|c| Ok((db::repos::upsert(c, Path::new("/home/anna/Mein Projekt"))?.id, db::repos::upsert(c, Path::new("/srv/andere"))?.id)))
            .unwrap();
        let first = row("a1", &repo, "fix-login", "2026-10-16T08:00:00.000Z");
        let mut second = row("a2", &repo, "groesse-anpassen", "2026-10-16T09:30:00.000Z");
        second.unattended = true;
        db.with(|c| {
            insert(c, &first)?;
            insert(c, &second)?;
            insert(c, &row("b1", &other, "fix-login", "2026-10-16T07:00:00.000Z"))
        })
        .unwrap();
        // The same short name in the same repository is refused; in another repository it is fine (above).
        let err = db.with(|c| insert(c, &row("a3", &repo, "fix-login", "2026-10-16T10:00:00.000Z"))).unwrap_err();
        assert_eq!(err.code, crate::ErrorCode::NameExists);

        let listed = db.with(|c| list_for_repo(c, &repo)).unwrap();
        assert_eq!(listed.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["a2", "a1"], "newest first");
        assert_eq!(listed[1], first, "every field survives, including the multi-line task with umlauts");
        assert!(listed[0].unattended);

        db.with(|c| set_ended(c, "a1", "2026-10-16T08:45:00.000Z", Some(3), EndReason::Exited)).unwrap();
        let ended = db.with(|c| require(c, "a1")).unwrap();
        assert_eq!((ended.ended_at.as_deref(), ended.exit_code, ended.end_reason), (Some("2026-10-16T08:45:00.000Z"), Some(3), Some(EndReason::Exited)));
        assert_eq!(db.with(list_open).unwrap().iter().map(|r| r.id.clone()).collect::<Vec<_>>(), vec!["a2".to_string(), "b1".to_string()]);
        db.with(|c| set_restarted(c, "a1", "2026-10-16T11:00:00.000Z")).unwrap();
        let again = db.with(|c| require(c, "a1")).unwrap();
        assert_eq!((again.started_at.as_str(), again.ended_at, again.exit_code, again.end_reason), ("2026-10-16T11:00:00.000Z", None, None, None));

        db.with(|c| delete(c, "a2")).unwrap();
        assert!(db.with(|c| get(c, "a2")).unwrap().is_none());
        assert_eq!(db.with(|c| require(c, "a2")).unwrap_err().code, crate::ErrorCode::NotFound);
        // Forgetting the repository removes its agents.
        db.with(|c| db::repos::delete(c, &repo)).unwrap();
        assert!(db.with(|c| list_for_repo(c, &repo)).unwrap().is_empty());
        assert_eq!(db.with(|c| list_for_repo(c, &other)).unwrap().len(), 1);
        assert_eq!(EndReason::parse("app_closed"), Some(EndReason::AppClosed));
        assert_eq!(EndReason::parse("crashed"), None);
        for reason in [EndReason::Exited, EndReason::Stopped, EndReason::AppClosed] {
            assert_eq!(EndReason::parse(reason.as_str()), Some(reason));
        }
    }
}
