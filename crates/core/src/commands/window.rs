//! App windows of the active profile and their tabs.

use std::collections::{BTreeSet, HashMap};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use rusqlite::Connection;

use crate::app::Core;
use crate::commands::repos;
use crate::db;
use crate::error::{CoreError, CoreResult};
use crate::events::names;
use crate::model::{
    AppChange, ScreenPoint, ScreenRect, StripReport, Tab, WindowFrame, WindowFrameInput, WindowGeometry, WindowInfo, WindowLayout,
    WindowState,
};
use crate::windowing;

/// Largest view state a tab carries from one window to another.
pub const HANDOFF_MAX_BYTES: usize = 4 * 1024 * 1024;
/// A hand-over nobody took is dropped after this.
pub const HANDOFF_TTL: Duration = Duration::from_secs(120);
/// Size of a torn-out window when the source window has none remembered.
const DEFAULT_SIZE: (f64, f64) = (1440.0, 900.0);
/// How far a window torn out without a point sits from its source window.
const CASCADE: f64 = 30.0;

/// What the core keeps in memory about open windows (by label).
#[derive(Default)]
struct Windows {
    /// Last reported geometry, written to the database by `save_geometry`.
    geometry: Mutex<HashMap<String, WindowGeometry>>,
    /// Tab strips in client coordinates.
    strips: Mutex<HashMap<String, StripReport>>,
    /// View state of a tab on its way to another window: (JSON, stored at).
    handoffs: Mutex<HashMap<String, (String, Instant)>>,
}

/// Tabs left `window` (closed, moved out, window closed, profile switched). Background work stops
/// for the repositories that no window shows any more.
pub fn tabs_left(core: &Core, window: &str, tabs: &[Tab]) {
    let _ = window;
    for repo_id in tabs.iter().filter_map(|t| t.repo_id.as_deref()).collect::<BTreeSet<_>>() {
        repos::stop_background_if_closed(core, repo_id);
    }
}

/// Windows of the active profile in their order.
pub async fn window_list(core: &Core) -> CoreResult<Vec<WindowInfo>> {
    core.db.with(|c| {
        let profile_id = db::profiles::active_id(c)?;
        let focused = db::windows::focus_order(c, &profile_id)?.into_iter().next();
        let tabs = db::tabs::list_all(c, &profile_id)?;
        let windows = db::windows::list(c, &profile_id)?;
        Ok(windows
            .into_iter()
            .map(|w| {
                let own: Vec<&Tab> = tabs.iter().filter(|t| t.window == w.label).collect();
                WindowInfo {
                    title: own.iter().find(|t| t.is_active).map(|t| t.title.clone()).unwrap_or_default(),
                    tabs: own.len() as u32,
                    focused: focused.as_deref() == Some(w.label.as_str()),
                    label: w.label,
                }
            })
            .collect())
    })
}

/// A new window with a management tab. Returns its label.
pub async fn window_new(core: &Core) -> CoreResult<String> {
    let label = windowing::new_label();
    let windows = core.db.tx(|tx| {
        let profile_id = db::profiles::active_id(tx)?;
        db::windows::insert(tx, &profile_id, &label, None)?;
        db::tabs::ensure_consistent(tx, &profile_id, &label)?;
        db::windows::list(tx, &profile_id)
    })?;
    core.events.sync_windows(&windows, false);
    core.emit_app_changed(&[AppChange::Windows]);
    Ok(label)
}

/// Moves `tab` from its window into `target` at `position` and makes it active there. In the source the
/// right neighbour takes over (as on closing); an emptied source loses its row. Returns whether it did.
fn move_tab(tx: &Connection, profile_id: &str, tab: &Tab, target: &str, position: i64) -> CoreResult<bool> {
    let mut source: Vec<String> = db::tabs::list(tx, profile_id, &tab.window)?.into_iter().map(|t| t.id).collect();
    let index = source.iter().position(|id| *id == tab.id).unwrap_or(0);
    source.retain(|id| *id != tab.id);
    db::tabs::move_to_window(tx, profile_id, &tab.id, target, position)?;
    db::tabs::activate(tx, profile_id, &tab.id)?;
    if source.is_empty() {
        db::windows::delete(tx, profile_id, &tab.window)?;
        return Ok(true);
    }
    if tab.is_active {
        db::tabs::activate(tx, profile_id, &source[index.min(source.len() - 1)])?;
    }
    Ok(false)
}

/// Moves a tab of the calling window into `window` at `position`. Returns the caller's tabs.
pub async fn tab_move_to_window(core: &Core, tab_id: String, window: String, position: i64) -> CoreResult<Vec<Tab>> {
    let source = windowing::caller_or_main();
    if window == source {
        return repos::tab_move(core, tab_id, position).await;
    }
    let (tabs, moved, windows) = core.db.tx(|tx| {
        let profile_id = db::profiles::active_id(tx)?;
        let tab = db::tabs::require_in(tx, &profile_id, &source, &tab_id)?;
        let emptied = move_tab(tx, &profile_id, &tab, &window, position)?;
        let windows = if emptied { Some(db::windows::list(tx, &profile_id)?) } else { None };
        Ok((db::tabs::list(tx, &profile_id, &source)?, tab, windows))
    })?;
    if let Some(windows) = windows {
        core.events.sync_windows(&windows, false);
    }
    tabs_left(core, &source, &[moved]);
    core.emit_to(&window, names::APP_FOCUS_REQUEST, &serde_json::Value::Null);
    core.emit_app_changed(&[AppChange::Tabs, AppChange::Windows]);
    Ok(tabs)
}

/// Tears a tab of the calling window out into a new window at `at` (screen, logical). Returns the label.
pub async fn tab_move_to_new_window(core: &Core, tab_id: String, at: Option<ScreenPoint>) -> CoreResult<String> {
    let source = windowing::caller_or_main();
    let label = windowing::new_label();
    let remembered = core.state::<Windows>().geometry.lock().get(&source).copied();
    let (moved, windows) = core.db.tx(|tx| {
        let profile_id = db::profiles::active_id(tx)?;
        let tab = db::tabs::require_in(tx, &profile_id, &source, &tab_id)?;
        if db::tabs::list(tx, &profile_id, &source)?.len() < 2 {
            return Err(CoreError::not_allowed("The tab is already alone in its window."));
        }
        let stored = db::windows::list(tx, &profile_id)?.into_iter().find(|w| w.label == source).and_then(|w| w.geometry);
        let source_geometry = remembered.or(stored);
        let (width, height) = source_geometry.map_or(DEFAULT_SIZE, |g| (g.width, g.height));
        // Without a point (keyboard): offset from the source window; with neither the system places it.
        let place = at.map(|p| (p.x, p.y)).or(source_geometry.map(|g| (g.x + CASCADE, g.y + CASCADE)));
        let geometry = place.map(|(x, y)| WindowGeometry { x, y, width, height, maximized: false });
        db::windows::insert(tx, &profile_id, &label, geometry.as_ref())?;
        move_tab(tx, &profile_id, &tab, &label, 0)?;
        Ok((tab, db::windows::list(tx, &profile_id)?))
    })?;
    core.events.sync_windows(&windows, false);
    tabs_left(core, &source, &[moved]);
    core.emit_app_changed(&[AppChange::Tabs, AppChange::Windows]);
    Ok(label)
}

/// Keeps a tab's view state for the window it moves to; replaces an earlier one.
pub async fn tab_handoff_put(core: &Core, tab_id: String, handoff: String) -> CoreResult<()> {
    if handoff.len() > HANDOFF_MAX_BYTES {
        return Err(CoreError::not_allowed("The tab's view state is too large to move along."));
    }
    core.db.with(|c| db::tabs::require(c, &db::profiles::active_id(c)?, &tab_id))?;
    let state = core.state::<Windows>();
    let mut handoffs = state.handoffs.lock();
    handoffs.retain(|_, (_, at)| at.elapsed() < HANDOFF_TTL);
    handoffs.insert(tab_id, (handoff, Instant::now()));
    Ok(())
}

/// The view state left for this tab, once.
pub async fn tab_handoff_take(core: &Core, tab_id: String) -> CoreResult<Option<String>> {
    let state = core.state::<Windows>();
    let mut handoffs = state.handoffs.lock();
    handoffs.retain(|_, (_, at)| at.elapsed() < HANDOFF_TTL);
    Ok(handoffs.remove(&tab_id).map(|(h, _)| h))
}

/// The calling window's tab strip (client coordinates); `None` forgets it.
pub async fn window_strip_report(core: &Core, strip: Option<StripReport>) -> CoreResult<()> {
    let window = windowing::caller_or_main();
    let state = core.state::<Windows>();
    let mut strips = state.strips.lock();
    match strip {
        Some(s) => strips.insert(window, s),
        None => strips.remove(&window),
    };
    Ok(())
}

/// The windows for a drop decision: strips and tab middles in screen coordinates, ranked by focus.
/// Frames of windows without a row are dropped.
pub async fn window_layout(core: &Core, frames: Vec<WindowFrameInput>, cursor: Option<ScreenPoint>) -> CoreResult<WindowLayout> {
    let order = core.db.with(|c| db::windows::focus_order(c, &db::profiles::active_id(c)?))?;
    let state = core.state::<Windows>();
    let strips = state.strips.lock();
    let frames: Vec<WindowFrame> = frames
        .into_iter()
        .filter_map(|f| {
            let focus_rank = order.iter().position(|l| *l == f.label)? as u32;
            let placed = f.inner.zip(strips.get(&f.label));
            Some(WindowFrame {
                strip: placed.map(|(inner, s)| ScreenRect { x: inner.x + s.strip.x, y: inner.y + s.strip.y, ..s.strip }),
                tab_mids: placed.map(|(inner, s)| s.tab_mids.iter().map(|m| inner.x + m).collect()).unwrap_or_default(),
                inner: f.inner,
                label: f.label,
                focus_rank,
            })
        })
        .collect();
    let positions_known = frames.iter().all(|f| f.inner.is_some());
    Ok(WindowLayout { frames, cursor, positions_known })
}

// --- For the binding ---------------------------------------------------------

/// The windows of the active profile to open at start.
pub fn restore(core: &Core) -> CoreResult<Vec<WindowState>> {
    core.db.with(|c| db::windows::list(c, &db::profiles::active_id(c)?))
}

/// The window got the focus.
pub fn note_focus(core: &Core, label: &str) {
    if let Err(e) = core.db.with(|c| db::windows::note_focus(c, &db::profiles::active_id(c)?, label)) {
        log::warn!("Focus of window {label} not recorded: {}", e.message);
    }
}

/// The window moved or was resized (memory only; see `save_geometry`).
pub fn note_geometry(core: &Core, label: &str, geometry: WindowGeometry) {
    core.state::<Windows>().geometry.lock().insert(label.to_string(), geometry);
}

/// Writes the remembered geometry of the window to the database.
pub fn save_geometry(core: &Core, label: &str) {
    let Some(g) = core.state::<Windows>().geometry.lock().get(label).copied() else { return };
    if let Err(e) = core.db.with(|c| db::windows::set_geometry(c, &db::profiles::active_id(c)?, label, &g)) {
        log::warn!("Geometry of window {label} not saved: {}", e.message);
    }
}

/// The window is gone. Unless the app is quitting or it was the last window, its row and tabs go too.
pub fn window_closed(core: &Core, label: &str) {
    core.state::<Windows>().strips.lock().remove(label);
    if core.state::<crate::commands::app::CloseGuard>().quitting() {
        return;
    }
    let closed = core.db.tx(|tx| {
        let profile_id = db::profiles::active_id(tx)?;
        let windows = db::windows::list(tx, &profile_id)?;
        if windows.len() < 2 || !windows.iter().any(|w| w.label == label) {
            return Ok(None);
        }
        let tabs = db::tabs::list(tx, &profile_id, label)?;
        db::windows::delete(tx, &profile_id, label)?;
        Ok(Some(tabs))
    });
    match closed {
        Ok(Some(tabs)) => {
            core.state::<Windows>().geometry.lock().remove(label);
            tabs_left(core, label, &tabs);
            core.emit_app_changed(&[AppChange::Tabs, AppChange::Windows]);
        }
        Ok(None) => {}
        Err(e) => log::warn!("Window {label} not removed: {}", e.message),
    }
}

/// Profile switch: the remembered geometry belongs to the old profile's windows; it is saved and forgotten.
pub(crate) fn save_all_geometry(core: &Core, tx: &Connection, profile_id: &str) -> CoreResult<()> {
    for (label, g) in core.state::<Windows>().geometry.lock().drain() {
        db::windows::set_geometry(tx, profile_id, &label, &g)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests;
