//! Table `profile_windows`: the app windows of a profile; the tabs of a window carry its label in
//! `tabs.window_id`. A profile always has at least one window. `main` can be closed during a session;
//! `ensure` (start, profile switch: no window open yet) makes the first window `main` again.

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::int_bool;
use crate::error::CoreResult;
use crate::model::{WindowGeometry, WindowState};
use crate::util;

pub use crate::windowing::MAIN;

fn from_row(r: &Row) -> rusqlite::Result<WindowState> {
    let position: i64 = r.get("position")?;
    let (x, y, width, height): (Option<f64>, Option<f64>, Option<f64>, Option<f64>) =
        (r.get("x")?, r.get("y")?, r.get("width")?, r.get("height")?);
    let geometry = match (x, y, width, height) {
        (Some(x), Some(y), Some(width), Some(height)) => {
            Some(WindowGeometry { x, y, width, height, maximized: int_bool(r.get("maximized")?) })
        }
        _ => None,
    };
    Ok(WindowState { label: r.get("label")?, position: position.max(0) as u32, geometry })
}

/// Windows of the profile, ordered by position.
pub fn list(conn: &Connection, profile_id: &str) -> CoreResult<Vec<WindowState>> {
    let mut stmt = conn.prepare(
        "select label, position, x, y, width, height, maximized from profile_windows where profile_id = ?1 order by position, label",
    )?;
    let rows = stmt.query_map([profile_id], from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// At least one window, and the one with the lowest position is `main`. When it is not, a `main`
/// further back swaps positions with it; without a `main` that window is relabelled, tabs included.
/// Only while none of the profile's windows is open (start, profile switch): it renames windows.
pub fn ensure(conn: &Connection, profile_id: &str) -> CoreResult<()> {
    let rows = list(conn, profile_id)?;
    let Some(first) = rows.first() else {
        conn.execute("insert into profile_windows (profile_id, label, position) values (?1, ?2, 0)", params![profile_id, MAIN])?;
        return Ok(());
    };
    if first.label == MAIN {
        return Ok(());
    }
    if let Some(main) = rows.iter().find(|w| w.label == MAIN) {
        let set = "update profile_windows set position = ?3 where profile_id = ?1 and label = ?2";
        conn.execute(set, params![profile_id, MAIN, first.position])?;
        conn.execute(set, params![profile_id, first.label, main.position])?;
        return Ok(());
    }
    // Stray `main` tabs (no row) must not collide with the relabelled window's active tab.
    conn.execute("update tabs set is_active = 0 where profile_id = ?1 and window_id = ?2", params![profile_id, MAIN])?;
    conn.execute("update profile_windows set label = ?3 where profile_id = ?1 and label = ?2", params![profile_id, first.label, MAIN])?;
    conn.execute("update tabs set window_id = ?3 where profile_id = ?1 and window_id = ?2", params![profile_id, first.label, MAIN])?;
    Ok(())
}

/// New window behind the others.
pub fn insert(conn: &Connection, profile_id: &str, label: &str, geometry: Option<&WindowGeometry>) -> CoreResult<()> {
    conn.execute(
        "insert into profile_windows (profile_id, label, position)
         values (?1, ?2, (select coalesce(max(position) + 1, 0) from profile_windows where profile_id = ?1))",
        params![profile_id, label],
    )?;
    if let Some(g) = geometry {
        set_geometry(conn, profile_id, label, g)?;
    }
    Ok(())
}

/// Removes the window and its tabs. The last window stays. Without `main` the next `ensure`
/// (start, profile switch) relabels the first remaining window to `main`.
pub fn delete(conn: &Connection, profile_id: &str, label: &str) -> CoreResult<()> {
    if list(conn, profile_id)?.iter().all(|w| w.label == label) {
        return Err(crate::error::CoreError::not_allowed("The last window cannot be removed."));
    }
    conn.execute("delete from tabs where profile_id = ?1 and window_id = ?2", params![profile_id, label])?;
    conn.execute("delete from profile_windows where profile_id = ?1 and label = ?2", params![profile_id, label])?;
    Ok(())
}

pub fn exists(conn: &Connection, profile_id: &str, label: &str) -> CoreResult<bool> {
    Ok(conn
        .query_row("select 1 from profile_windows where profile_id = ?1 and label = ?2", params![profile_id, label], |_| Ok(()))
        .optional()?
        .is_some())
}

pub fn set_geometry(conn: &Connection, profile_id: &str, label: &str, g: &WindowGeometry) -> CoreResult<()> {
    conn.execute(
        "update profile_windows set x = ?3, y = ?4, width = ?5, height = ?6, maximized = ?7 where profile_id = ?1 and label = ?2",
        params![profile_id, label, g.x, g.y, g.width, g.height, g.maximized as i64],
    )?;
    Ok(())
}

/// The window got the focus. Stamps stay strictly increasing, so two focus changes within one
/// millisecond keep their order.
pub fn note_focus(conn: &Connection, profile_id: &str, label: &str) -> CoreResult<()> {
    let mut at = util::now_iso();
    let latest: Option<String> =
        conn.query_row("select max(focused_at) from profile_windows where profile_id = ?1", [profile_id], |r| r.get(0))?;
    if let Some(latest) = latest.filter(|l| *l >= at) {
        if let Ok(t) = chrono::DateTime::parse_from_rfc3339(&latest) {
            at = (t + chrono::Duration::milliseconds(1)).with_timezone(&chrono::Utc).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        }
    }
    conn.execute("update profile_windows set focused_at = ?3 where profile_id = ?1 and label = ?2", params![profile_id, label, at])?;
    Ok(())
}

/// Labels, most recently focused first; never focused windows last, by position.
pub fn focus_order(conn: &Connection, profile_id: &str) -> CoreResult<Vec<String>> {
    let mut stmt = conn
        .prepare("select label from profile_windows where profile_id = ?1 order by focused_at is null, focused_at desc, position, label")?;
    let rows = stmt.query_map([profile_id], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(rows)
}

/// Whether any window of the profile ever had the focus.
pub fn ever_focused(conn: &Connection, profile_id: &str) -> CoreResult<bool> {
    let focused: Option<String> =
        conn.query_row("select max(focused_at) from profile_windows where profile_id = ?1", [profile_id], |r| r.get(0))?;
    Ok(focused.is_some())
}

/// The window an unscoped call acts in: the most recently focused one (never focused: the first by
/// position), `main` when the profile has none yet.
pub fn fallback(conn: &Connection, profile_id: &str) -> CoreResult<String> {
    Ok(focus_order(conn, profile_id)?.into_iter().next().unwrap_or_else(|| MAIN.to_string()))
}

/// Window that shows a prompt: the calling window while it exists, otherwise the last focused one.
pub fn prompt_target(conn: &Connection, profile_id: &str, origin: Option<&str>) -> CoreResult<Option<String>> {
    if let Some(origin) = origin {
        if exists(conn, profile_id, origin)? {
            return Ok(Some(origin.to_string()));
        }
    }
    Ok(focus_order(conn, profile_id)?.into_iter().next())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;

    fn db_with_profile() -> Db {
        let db = Db::open_in_memory().unwrap();
        db.with(|c| {
            c.execute("insert into profiles (id, name, author_name, author_email, is_active) values ('p', 'P', '', '', 1)", [])?;
            Ok(())
        })
        .unwrap();
        db
    }

    fn labels(db: &Db) -> Vec<(String, u32)> {
        db.with(|c| list(c, "p")).unwrap().into_iter().map(|w| (w.label, w.position)).collect()
    }

    #[test]
    fn ensure_creates_main_once() {
        let db = db_with_profile();
        db.with(|c| {
            ensure(c, "p")?;
            ensure(c, "p")
        })
        .unwrap();
        assert_eq!(labels(&db), vec![("main".to_string(), 0)]);
    }

    #[test]
    fn ensure_relabels_the_first_window_to_main_with_its_tabs() {
        let db = db_with_profile();
        let tab = db
            .with(|c| {
                insert(c, "p", "w-aaa111", None)?;
                insert(c, "p", "w-bbb222", None)?;
                let tab = crate::db::tabs::append(c, "p", "w-aaa111", crate::model::TabKind::Management, None)?;
                ensure(c, "p")?;
                Ok(tab)
            })
            .unwrap();
        assert_eq!(labels(&db), vec![("main".to_string(), 0), ("w-bbb222".to_string(), 1)]);
        let tab = db.with(|c| crate::db::tabs::require(c, "p", &tab)).unwrap();
        assert_eq!(tab.window, "main");
    }

    #[test]
    fn relabelling_deactivates_stray_main_tabs() {
        let db = db_with_profile();
        let (stray, own) = db
            .with(|c| {
                insert(c, "p", "w-aaa111", None)?;
                let stray = crate::db::tabs::append(c, "p", MAIN, crate::model::TabKind::Management, None)?;
                crate::db::tabs::activate(c, "p", &stray)?;
                let own = crate::db::tabs::append(c, "p", "w-aaa111", crate::model::TabKind::Management, None)?;
                crate::db::tabs::activate(c, "p", &own)?;
                ensure(c, "p")?;
                Ok((stray, own))
            })
            .unwrap();
        let active = |id: &str| db.with(|c| crate::db::tabs::require(c, "p", id)).unwrap();
        assert_eq!((active(&own).window.as_str(), active(&own).is_active), ("main", true));
        assert_eq!((active(&stray).window.as_str(), active(&stray).is_active), ("main", false));
    }

    #[test]
    fn ensure_moves_a_main_further_back_to_the_front() {
        let db = db_with_profile();
        db.with(|c| {
            insert(c, "p", "w-aaa111", None)?;
            insert(c, "p", "main", None)?;
            ensure(c, "p")
        })
        .unwrap();
        assert_eq!(labels(&db), vec![("main".to_string(), 0), ("w-aaa111".to_string(), 1)]);
    }

    #[test]
    fn delete_refuses_the_last_window() {
        let db = db_with_profile();
        let err = db.with(|c| {
            ensure(c, "p")?;
            delete(c, "p", MAIN)
        });
        assert_eq!(err.unwrap_err().code, crate::ErrorCode::NotAllowed);
        assert_eq!(labels(&db), vec![("main".to_string(), 0)]);
        db.with(|c| {
            insert(c, "p", "w-a", None)?;
            delete(c, "p", MAIN)
        })
        .unwrap();
        assert_eq!(labels(&db), vec![("w-a".to_string(), 1)], "main may go while another window stays");
    }

    #[test]
    fn geometry_round_trips_with_negative_coordinates() {
        let db = db_with_profile();
        let g = WindowGeometry { x: -1920.0, y: -40.5, width: 1280.0, height: 800.0, maximized: true };
        let windows = db
            .with(|c| {
                ensure(c, "p")?;
                insert(c, "p", "w-left", Some(&g))?;
                list(c, "p")
            })
            .unwrap();
        assert_eq!(windows[0].geometry, None);
        assert_eq!(windows[1], WindowState { label: "w-left".into(), position: 1, geometry: Some(g) });
    }

    #[test]
    fn focus_order_is_most_recent_first() {
        let db = db_with_profile();
        let order = db
            .with(|c| {
                ensure(c, "p")?;
                for label in ["w-a", "w-b", "w-c"] {
                    insert(c, "p", label, None)?;
                }
                note_focus(c, "p", "w-b")?;
                note_focus(c, "p", "w-a")?;
                focus_order(c, "p")
            })
            .unwrap();
        assert_eq!(order, vec!["w-a", "w-b", "main", "w-c"]);
    }

    #[test]
    fn prompt_target_prefers_an_open_origin() {
        let db = db_with_profile();
        assert_eq!(db.with(|c| prompt_target(c, "p", None)).unwrap(), None, "no windows");
        db.with(|c| {
            ensure(c, "p")?;
            insert(c, "p", "w-a", None)?;
            insert(c, "p", "w-b", None)?;
            note_focus(c, "p", "w-a")
        })
        .unwrap();
        assert_eq!(db.with(|c| prompt_target(c, "p", Some("w-b"))).unwrap().as_deref(), Some("w-b"));
        assert_eq!(db.with(|c| prompt_target(c, "p", Some("w-gone"))).unwrap().as_deref(), Some("w-a"));
        assert_eq!(db.with(|c| prompt_target(c, "p", None)).unwrap().as_deref(), Some("w-a"));
    }
}
