//! Table `tabs`: open tabs per profile and window (`window_id`, see `db::windows`). In the database the management tab is
//! called `repo_management`, in the model `management`.

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::{int_bool, windows};
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
        (TabKind::Repo, Some(p)) => alias
            .filter(|a| !a.trim().is_empty())
            .unwrap_or_else(|| std::path::Path::new(p).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| p.clone())),
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
        window: r.get("window_id")?,
    })
}

const SELECT: &str = "select t.id, t.kind, t.repository_id, t.position, t.is_active, t.window_id, r.path, r.alias
     from tabs t left join repositories r on r.id = t.repository_id";

/// Tabs of the window in their order.
pub fn list(conn: &Connection, profile_id: &str, window: &str) -> CoreResult<Vec<Tab>> {
    let mut stmt = conn.prepare(&format!("{SELECT} where t.profile_id = ?1 and t.window_id = ?2 order by t.position, t.created_at"))?;
    let rows = stmt.query_map(params![profile_id, window], from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Tabs of every window of the profile, grouped by window, each group in its order.
pub fn list_all(conn: &Connection, profile_id: &str) -> CoreResult<Vec<Tab>> {
    let mut stmt = conn.prepare(&format!("{SELECT} where t.profile_id = ?1 order by t.window_id, t.position, t.created_at"))?;
    let rows = stmt.query_map([profile_id], from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, profile_id: &str, tab_id: &str) -> CoreResult<Option<Tab>> {
    Ok(conn.query_row(&format!("{SELECT} where t.profile_id = ?1 and t.id = ?2"), params![profile_id, tab_id], from_row).optional()?)
}

pub fn require(conn: &Connection, profile_id: &str, tab_id: &str) -> CoreResult<Tab> {
    get(conn, profile_id, tab_id)?.ok_or_else(|| CoreError::not_found("The tab no longer exists."))
}

/// First tab of the window for this repository.
pub fn find_by_repo(conn: &Connection, profile_id: &str, window: &str, repo_id: &str) -> CoreResult<Option<Tab>> {
    Ok(conn
        .query_row(
            &format!("{SELECT} where t.profile_id = ?1 and t.window_id = ?2 and t.repository_id = ?3 order by t.position limit 1"),
            params![profile_id, window, repo_id],
            from_row,
        )
        .optional()?)
}

/// A tab of the profile for this repository, in whichever window.
pub fn find_by_repo_any(conn: &Connection, profile_id: &str, repo_id: &str) -> CoreResult<Option<Tab>> {
    Ok(conn
        .query_row(
            &format!("{SELECT} where t.profile_id = ?1 and t.repository_id = ?2 order by t.window_id, t.position limit 1"),
            params![profile_id, repo_id],
            from_row,
        )
        .optional()?)
}

/// New tab at the end of the window (not active). Returns the ID.
pub fn append(conn: &Connection, profile_id: &str, window: &str, kind: TabKind, repo_id: Option<&str>) -> CoreResult<String> {
    let next: i64 = conn.query_row(
        "select coalesce(max(position) + 1, 0) from tabs where profile_id = ?1 and window_id = ?2",
        params![profile_id, window],
        |r| r.get(0),
    )?;
    let id = util::new_id();
    let now = util::now_iso();
    conn.execute(
        "insert into tabs (id, profile_id, kind, repository_id, position, is_active, created_at, updated_at, window_id)
         values (?1, ?2, ?3, ?4, ?5, 0, ?6, ?6, ?7)",
        params![id, profile_id, kind_to_db(kind), repo_id, next, now, window],
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

/// Makes `tab_id` the only active tab of its window.
pub fn activate(conn: &Connection, profile_id: &str, tab_id: &str) -> CoreResult<()> {
    conn.execute(
        "update tabs set is_active = 0 where profile_id = ?1 and is_active = 1 and id <> ?2
           and window_id = (select window_id from tabs where profile_id = ?1 and id = ?2)",
        params![profile_id, tab_id],
    )?;
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

/// Closes all tabs of the profile on this repository, in every window (then `ensure_all`).
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

/// Makes sure that the window has at least one tab (otherwise a management tab),
/// exactly one is active and the positions have no gaps.
pub fn ensure_consistent(conn: &Connection, profile_id: &str, window: &str) -> CoreResult<()> {
    let mut tabs = list(conn, profile_id, window)?;
    if tabs.is_empty() {
        let id = append(conn, profile_id, window, TabKind::Management, None)?;
        activate(conn, profile_id, &id)?;
        tabs = list(conn, profile_id, window)?;
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

/// `ensure_consistent` for every window of the profile: the windows exist (`windows::ensure`),
/// tabs of a window without a row move to the end of `main`.
pub fn ensure_all(conn: &Connection, profile_id: &str) -> CoreResult<()> {
    windows::ensure(conn, profile_id)?;
    let offset: i64 = conn.query_row(
        "select coalesce(max(position) + 1, 0) from tabs where profile_id = ?1 and window_id = ?2",
        params![profile_id, windows::MAIN],
        |r| r.get(0),
    )?;
    // Inactive: `main` may already have its active tab.
    conn.execute(
        "update tabs set window_id = ?2, is_active = 0, position = position + ?3
         where profile_id = ?1 and window_id not in (select label from profile_windows where profile_id = ?1)",
        params![profile_id, windows::MAIN, offset],
    )?;
    for window in windows::list(conn, profile_id)? {
        ensure_consistent(conn, profile_id, &window.label)?;
    }
    Ok(())
}

/// Moves a tab into `window` at `position` (0 = far left; too large = far right) and renumbers both
/// windows. The tab arrives inactive; activating it and settling an emptied window is up to the caller.
pub fn move_to_window(conn: &Connection, profile_id: &str, tab_id: &str, window: &str, position: i64) -> CoreResult<()> {
    let tab = require(conn, profile_id, tab_id)?;
    if !windows::exists(conn, profile_id, window)? {
        return Err(CoreError::not_found("The window no longer exists."));
    }
    conn.execute(
        "update tabs set window_id = ?3, is_active = 0, updated_at = ?4 where profile_id = ?1 and id = ?2",
        params![profile_id, tab_id, window, util::now_iso()],
    )?;
    let source: Vec<String> = list(conn, profile_id, &tab.window)?.into_iter().map(|t| t.id).filter(|id| id != tab_id).collect();
    reorder(conn, profile_id, &source)?;
    let mut target: Vec<String> = list(conn, profile_id, window)?.into_iter().map(|t| t.id).filter(|id| id != tab_id).collect();
    target.insert((position.max(0) as usize).min(target.len()), tab_id.to_string());
    reorder(conn, profile_id, &target)
}

/// IDs of the repositories for which the profile has tabs open.
pub fn open_repo_ids(conn: &Connection, profile_id: &str) -> CoreResult<Vec<String>> {
    let mut stmt = conn.prepare("select distinct repository_id from tabs where profile_id = ?1 and repository_id is not null")?;
    let rows = stmt.query_map([profile_id], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    /// Profile `p` with the windows `main` and `w-x`, and a repository `r`.
    fn setup() -> Db {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            c.execute("insert into profiles (id, name, author_name, author_email, is_active) values ('p', 'P', '', '', 1)", [])?;
            c.execute("insert into repositories (id, path, path_key) values ('r', '/repo', '/repo')", [])?;
            windows::ensure(c, "p")?;
            windows::insert(c, "p", "w-x", None)
        })
        .unwrap();
        db
    }

    fn mgmt(c: &Connection, window: &str) -> CoreResult<String> {
        append(c, "p", window, TabKind::Management, None)
    }

    #[test]
    fn one_active_tab_per_window() {
        let db = setup();
        let (a, b, c2) = db
            .with(|c| {
                let a = mgmt(c, "main")?;
                let b = mgmt(c, "w-x")?;
                let c2 = mgmt(c, "main")?;
                activate(c, "p", &a)?;
                activate(c, "p", &b)?;
                Ok((a, b, c2))
            })
            .unwrap();
        let active = |id: &str| db.with(|c| require(c, "p", id)).unwrap().is_active;
        assert!(active(&a) && active(&b));
        db.with(|c| activate(c, "p", &c2)).unwrap();
        assert!(!active(&a) && active(&b) && active(&c2), "only the own window loses its active tab");
    }

    #[test]
    fn find_by_repo_looks_only_in_the_window() {
        let db = setup();
        let (in_x, any) = db
            .with(|c| {
                let id = append(c, "p", "main", TabKind::Repo, Some("r"))?;
                Ok((find_by_repo(c, "p", "w-x", "r")?, find_by_repo_any(c, "p", "r")?.map(|t| t.id == id)))
            })
            .unwrap();
        assert_eq!(in_x, None);
        assert_eq!(any, Some(true));
    }

    #[test]
    fn move_to_window_renumbers_both_windows() {
        let db = setup();
        let ([a, b, c3, d], main, x) = db
            .with(|c| {
                let ids = [mgmt(c, "main")?, mgmt(c, "main")?, mgmt(c, "main")?, mgmt(c, "w-x")?];
                move_to_window(c, "p", &ids[1], "w-x", 0)?;
                Ok((ids, list(c, "p", "main")?, list(c, "p", "w-x")?))
            })
            .unwrap();
        let order = |tabs: &[Tab]| tabs.iter().map(|t| (t.id.clone(), t.position, t.window.clone())).collect::<Vec<_>>();
        assert_eq!(order(&main), vec![(a, 0, "main".into()), (c3, 1, "main".into())]);
        assert_eq!(order(&x), vec![(b.clone(), 0, "w-x".into()), (d, 1, "w-x".into())]);
        let err = db.with(|c| move_to_window(c, "p", &b, "w-gone", 0)).unwrap_err();
        assert_eq!(err.code, crate::ErrorCode::NotFound);
    }

    #[test]
    fn ensure_all_moves_orphaned_tabs_into_main() {
        let db = setup();
        let (main, orphan) = db
            .with(|c| {
                let main = mgmt(c, "main")?;
                activate(c, "p", &main)?;
                let orphan = mgmt(c, "w-gone")?;
                activate(c, "p", &orphan)?;
                ensure_all(c, "p")?;
                Ok((main, orphan))
            })
            .unwrap();
        let tabs = db.with(|c| list(c, "p", "main")).unwrap();
        let got: Vec<(&str, u32, bool)> = tabs.iter().map(|t| (t.id.as_str(), t.position, t.is_active)).collect();
        assert_eq!(got, vec![(main.as_str(), 0, true), (orphan.as_str(), 1, false)]);
        let x = db.with(|c| list(c, "p", "w-x")).unwrap();
        assert_eq!((x.len(), x[0].kind, x[0].is_active), (1, TabKind::Management, true), "an empty window gets a management tab");
    }
}
