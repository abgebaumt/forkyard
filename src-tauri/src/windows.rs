//! The app windows as Tauri sees them: built, placed and destroyed to match the core's
//! `WindowState`s (`reconcile`), and their positions for the core's drop decisions.

use gitcore::model::{ScreenPoint, ScreenRect, WindowFrameInput, WindowGeometry, WindowState};
use gitcore::windowing::MAIN;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Height of the strip along a window's top edge that must stay on a monitor (the title bar).
const TITLE_BAR: f64 = 40.0;
/// Width of that strip that must be on one monitor to grab the window.
const GRAB_WIDTH: f64 = 100.0;

/// Opens the windows in `wanted` that are missing and destroys the open ones not in it. Windows that
/// stay open move to their stored geometry only with `place_existing` (profile switch).
pub fn reconcile(app: &AppHandle, wanted: &[WindowState], place_existing: bool) {
    let open = app.webview_windows();
    let monitors = monitors(app);
    for state in wanted {
        match open.get(&state.label) {
            Some(window) if place_existing => place(window, state, &monitors),
            Some(_) => {}
            None => match build(app, state) {
                Ok(window) => {
                    place(&window, state, &monitors);
                    crate::prepare_window(app, &window);
                }
                Err(e) => log::warn!("Window {} could not be opened: {e}", state.label),
            },
        }
    }
    // Last, so the app never has no window in between (that would end it).
    for (label, window) in open {
        if !wanted.iter().any(|w| w.label == label) {
            if let Err(e) = window.destroy() {
                log::warn!("Window {label} could not be closed: {e}");
            }
        }
    }
}

/// A further window like `main`: title, sizes and the hidden test switch from tauri.conf.json (see
/// `context`), the UI address of an open window. The caller applies `prepare_window`.
fn build(app: &AppHandle, state: &WindowState) -> tauri::Result<WebviewWindow> {
    let mut config = app.config().app.windows.iter().find(|w| w.label == MAIN).cloned().unwrap_or_default();
    config.label = state.label.clone();
    config.title = "Forkyard".into();
    if let Some(url) = app.webview_windows().values().find_map(|w| w.url().ok()) {
        config.url = WebviewUrl::External(new_window_url(&url));
    }
    WebviewWindowBuilder::from_config(app, &config)?.build()
}

/// Moves `window` to its stored geometry, unless that would hide its title bar.
fn place(window: &WebviewWindow, state: &WindowState, monitors: &[ScreenRect]) {
    let Some(g) = state.geometry.filter(|g| visible_enough(g, monitors)) else { return };
    let outcome = window
        .set_size(LogicalSize::new(g.width, g.height))
        .and_then(|()| window.set_position(LogicalPosition::new(g.x, g.y)))
        .and_then(|()| if g.maximized { window.maximize() } else { Ok(()) });
    if let Err(e) = outcome {
        log::warn!("Window {} could not be placed: {e}", state.label);
    }
}

/// The UI address for a new window: that of `current` without `scenario`, so a development scenario
/// does not run again in it.
fn new_window_url(current: &Url) -> Url {
    let mut url = current.clone();
    let kept: Vec<(String, String)> = current.query_pairs().filter(|(k, _)| k != "scenario").map(|(k, v)| (k.into(), v.into())).collect();
    if kept.is_empty() {
        url.set_query(None);
    } else {
        url.query_pairs_mut().clear().extend_pairs(kept);
    }
    url
}

/// Whether the title bar of a window at `g` can be grabbed: its top strip `(x, y, width, 40)` overlaps
/// one monitor by at least 100 × 40.
fn visible_enough(g: &WindowGeometry, monitors: &[ScreenRect]) -> bool {
    monitors.iter().any(|m| {
        let width = (g.x + g.width).min(m.x + m.width) - g.x.max(m.x);
        let height = (g.y + TITLE_BAR).min(m.y + m.height) - g.y.max(m.y);
        width >= GRAB_WIDTH && height >= TITLE_BAR
    })
}

/// The monitors in logical pixels.
fn monitors(app: &AppHandle) -> Vec<ScreenRect> {
    app.available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let (position, size) = (m.position().to_logical::<f64>(m.scale_factor()), m.size().to_logical::<f64>(m.scale_factor()));
            ScreenRect { x: position.x, y: position.y, width: size.width, height: size.height }
        })
        .collect()
}

/// Where `window` is: outer position and inner size in logical pixels.
pub fn geometry_of(window: &tauri::Window) -> Option<WindowGeometry> {
    if window.is_minimized().unwrap_or(false) {
        return None;
    }
    let scale = window.scale_factor().ok()?;
    let position = window.outer_position().ok()?.to_logical::<f64>(scale);
    let size = window.inner_size().ok()?.to_logical::<f64>(scale);
    // shortcut: a maximized window remembers its maximized size, so un-maximizing after a restart keeps it large; keep the previous size if users mind.
    let maximized = window.is_maximized().unwrap_or(false);
    Some(WindowGeometry { x: position.x, y: position.y, width: size.width, height: size.height, maximized })
}

/// Every open window's inner rectangle (logical pixels) and the cursor, for `window_layout`. Wayland
/// does not tell applications where their windows are: there `inner` is `None`.
pub fn layout_frames(app: &AppHandle) -> (Vec<WindowFrameInput>, Option<ScreenPoint>) {
    let positions_known = !wayland();
    let frames = app
        .webview_windows()
        .into_iter()
        .map(|(label, window)| {
            let inner = positions_known.then(|| inner_rect(&window)).flatten();
            WindowFrameInput { label, inner }
        })
        .collect();
    let cursor = app.cursor_position().ok().filter(|_| positions_known).map(|p| {
        let scale = app.monitor_from_point(p.x, p.y).ok().flatten().map_or(1.0, |m| m.scale_factor());
        ScreenPoint { x: p.x / scale, y: p.y / scale }
    });
    (frames, cursor)
}

fn inner_rect(window: &WebviewWindow) -> Option<ScreenRect> {
    let scale = window.scale_factor().ok()?;
    let position = window.inner_position().ok()?.to_logical::<f64>(scale);
    let size = window.inner_size().ok()?.to_logical::<f64>(scale);
    Some(ScreenRect { x: position.x, y: position.y, width: size.width, height: size.height })
}

fn wayland() -> bool {
    cfg!(target_os = "linux") && std::env::var_os("WAYLAND_DISPLAY").is_some() && std::env::var("GDK_BACKEND").map_or(true, |b| b != "x11")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A window is restored only where its title bar can be grabbed; a monitor left of the primary
    /// one has negative coordinates.
    #[test]
    fn restores_only_positions_that_show_the_title_bar() {
        let monitors = [
            ScreenRect { x: 0.0, y: 0.0, width: 1920.0, height: 1080.0 },
            ScreenRect { x: -1280.0, y: 0.0, width: 1280.0, height: 1024.0 },
        ];
        let g = |x, y| WindowGeometry { x, y, width: 1200.0, height: 800.0, maximized: false };
        assert!(visible_enough(&g(100.0, 100.0), &monitors));
        assert!(visible_enough(&g(-1200.0, 50.0), &monitors), "left monitor");
        assert!(!visible_enough(&g(3000.0, 100.0), &monitors), "monitor unplugged");
        assert!(!visible_enough(&g(1850.0, 100.0), &monitors), "only 70 px visible");
        assert!(!visible_enough(&g(100.0, 1060.0), &monitors), "title bar below the screen");
        assert!(!visible_enough(&g(-1300.0, -100.0), &monitors), "above the left monitor");
        assert!(visible_enough(&g(-1150.0, 984.0), &monitors), "exactly 40 px of title bar at the bottom of the left monitor");
        assert!(!visible_enough(&g(100.0, 100.0), &[]), "no monitor known");
    }

    #[test]
    fn new_windows_do_not_rerun_a_scenario() {
        let u = |s: &str| s.parse::<tauri::Url>().unwrap();
        assert_eq!(
            new_window_url(&u("http://127.0.0.1:1431/?lang=en&scenario=Showcase.graph&theme=dark")).as_str(),
            "http://127.0.0.1:1431/?lang=en&theme=dark"
        );
        assert_eq!(new_window_url(&u("tauri://localhost/")).as_str(), "tauri://localhost/");
        assert_eq!(new_window_url(&u("http://127.0.0.1:1420/?scenario=Showcase.graph")).as_str(), "http://127.0.0.1:1420/");
    }
}
