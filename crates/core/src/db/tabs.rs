//! Table `tabs`: open tabs per profile. In the database the management tab is
//! called `repo_management`, in the model `management`.

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::int_bool;
use crate::error::{CoreError, CoreResult};
use crate::model::{Tab, TabKind};
use crate::util;

fn kind_to_db(kind: TabKind) -> &'static str {
    match kind {
        TabKind::Repo => "repo",
        TabKind::Management => "repo_management",
    }
}

fn from_row(r: &Row) -> rusqlite::Result<Tab> {
    let kind: String = r.get("kind")?;
    let kind = if kind == "repo" { TabKind::Repo } else { TabKind::Management };
    let path: Option<String> = r.get("path")?;
    let alias: Option<String> = r.get("alias")?;
    let title = match (&kind, &path) {
        (TabKind::Repo, Some(p)) => alias.filter(|a| !a.trim().is_empty()).unwrap_or_else(|| {
            std::path::Path::new(p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.clone())
        }),
        _ => String::new(),
    };
    let position: i64 = r.get("position")?;
    Ok(Tab {
        id: r.get("id")?,
        kind,
        repo_id: r.get("repository_id")?,
        position: position.max(0) as u32,
        is_active: int_bool(r.get("is_active")?),
        title,
        path,
    })
}

const SELECT: &str = "select t.id, t.kind, t.repository_id, t.position, t.is_active, r.path, r.alias
     from tabs t left join repositories r on r.id = t.repository_id";

/// Tabs of the profile in their order.
pub fn list(conn: &Connection, profile_id: &str) -> CoreResult<Vec<Tab>> {
    let mut stmt = conn.prepare(&format!("{SELECT} where t.profile_id = ?1 order by t.position, t.created_at"))?;
    let rows = stmt.query_map([profile_id], from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, profile_id: &str, tab_id: &str) -> CoreResult<Option<Tab>> {
    Ok(conn
        .query_row(&format!("{SELECT} where t.profile_id = ?1 and t.id = ?2"), params![profile_id, tab_id], from_row)
        .optional()?)
}

pub fn require(conn: &Connection, profile_id: &str, tab_id: &str) -> CoreResult<Tab> {
    get(conn, profile_id, tab_id)?.ok_or_else(|| CoreError::not_found("The tab no longer exists."))
}

/// First tab of the profile for this repository.
pub fn find_by_repo(conn: &Connection, profile_id: &str, repo_id: &str) -> CoreResult<Option<Tab>> {
    Ok(conn
        .query_row(
            &format!("{SELECT} where t.profile_id = ?1 and t.repository_id = ?2 order by t.position limit 1"),
            params![profile_id, repo_id],
            from_row,
        )
        .optional()?)
}

/// New tab at the end (not active). Returns the ID.
pub fn append(conn: &Connection, profile_id: &str, kind: TabKind, repo_id: Option<&str>) -> CoreResult<String> {
    let next: i64 = conn.query_row(
        "select coalesce(max(position) + 1, 0) from tabs where profile_id = ?1",
        [profile_id],
        |r| r.get(0),
    )?;
    let id = util::new_id();
    let now = util::now_iso();
    conn.execute(
        "insert into tabs (id, profile_id, kind, repository_id, position, is_active, created_at, updated_at)
         values (?1, ?2, ?3, ?4, ?5, 0, ?6, ?6)",
        params![id, profile_id, kind_to_db(kind), repo_id, next, now],
    )?;
    Ok(id)
}

/// Turns a tab into a repo tab for `repo_id` (e.g. the management tab on opening).
pub fn set_repo(conn: &Connection, tab_id: &str, repo_id: &str) -> CoreResult<()> {
    conn.execute(
        "update tabs set kind = 'repo', repository_id = ?2, updated_at = ?3 where id = ?1",
        params![tab_id, repo_id, util::now_iso()],
    )?;
    Ok(())
}

/// Makes `tab_id` the only active tab of the profile.
pub fn activate(conn: &Connection, profile_id: &str, tab_id: &str) -> CoreResult<()> {
    conn.execute("update tabs set is_active = 0 where profile_id = ?1 and is_active = 1 and id <> ?2", params![profile_id, tab_id])?;
    let n = conn.execute(
        "update tabs set is_active = 1, updated_at = ?3 where profile_id = ?1 and id = ?2",
        params![profile_id, tab_id, util::now_iso()],
    )?;
    if n == 0 {
        return Err(CoreError::not_found("The tab no longer exists."));
    }
    Ok(())
}

pub fn delete(conn: &Connection, profile_id: &str, tab_id: &str) -> CoreResult<()> {
    conn.execute("delete from tabs where profile_id = ?1 and id = ?2", params![profile_id, tab_id])?;
    Ok(())
}

/// Closes all tabs of the profile on this repository (then `ensure_consistent`).
pub fn close_repo(conn: &Connection, profile_id: &str, repo_id: &str) -> CoreResult<()> {
    conn.execute("delete from tabs where profile_id = ?1 and repository_id = ?2", params![profile_id, repo_id])?;
    Ok(())
}

pub fn delete_all(conn: &Connection, profile_id: &str) -> CoreResult<()> {
    conn.execute("delete from tabs where profile_id = ?1", [profile_id])?;
    Ok(())
}

/// Sets the positions 0..n in the order of `ordered_ids`.
pub fn reorder(conn: &Connection, profile_id: &str, ordered_ids: &[String]) -> CoreResult<()> {
    let now = util::now_iso();
    for (pos, id) in ordered_ids.iter().enumerate() {
        conn.execute(
            "update tabs set position = ?3, updated_at = ?4 where profile_id = ?1 and id = ?2",
            params![profile_id, id, pos as i64, now],
        )?;
    }
    Ok(())
}

/// Makes sure that the profile has at least one tab (otherwise a management tab),
/// exactly one is active and the positions have no gaps.
pub fn ensure_consistent(conn: &Connection, profile_id: &str) -> CoreResult<()> {
    let mut tabs = list(conn, profile_id)?;
    if tabs.is_empty() {
        let id = append(conn, profile_id, TabKind::Management, None)?;
        activate(conn, profile_id, &id)?;
        tabs = list(conn, profile_id)?;
    }
    let ids: Vec<String> = tabs.iter().map(|t| t.id.clone()).collect();
    if tabs.iter().enumerate().any(|(i, t)| t.position != i as u32) {
        reorder(conn, profile_id, &ids)?;
    }
    if !tabs.iter().any(|t| t.is_active) {
        if let Some(first) = ids.first() {
            activate(conn, profile_id, first)?;
        }
    }
    Ok(())
}

/// IDs of the repositories for which the profile has tabs open.
pub fn open_repo_ids(conn: &Connection, profile_id: &str) -> CoreResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "select distinct repository_id from tabs where profile_id = ?1 and repository_id is not null",
    )?;
    let rows = stmt.query_map([profile_id], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(rows)
}
