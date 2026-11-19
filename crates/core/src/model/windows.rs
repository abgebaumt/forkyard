//! Windows of a profile (several app windows, each with its own tabs)

use super::*;

/// Where a window sits: logical pixels, outer position, inner size.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "windows.ts"))]
#[serde(rename_all = "camelCase")]
pub struct WindowGeometry {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
}

/// A stored window of a profile. `label` is `main` or `w-…`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "windows.ts"))]
#[serde(rename_all = "camelCase")]
pub struct WindowState {
    pub label: String,
    pub position: u32,
    /// `None` until the window was placed once.
    pub geometry: Option<WindowGeometry>,
}

/// A window of the active profile for "Move to window ›".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "windows.ts"))]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub label: String,
    /// Title of the active tab; empty for a management tab.
    pub title: String,
    pub tabs: u32,
    /// The most recently focused window.
    pub focused: bool,
}

/// A point on the screen (logical pixels).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "windows.ts"))]
#[serde(rename_all = "camelCase")]
pub struct ScreenPoint {
    pub x: f64,
    pub y: f64,
}

/// A rectangle in logical pixels (screen or client coordinates, as the field says).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "windows.ts"))]
#[serde(rename_all = "camelCase")]
pub struct ScreenRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Where a window's tab strip is, in client coordinates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "windows.ts"))]
#[serde(rename_all = "camelCase")]
pub struct StripReport {
    pub strip: ScreenRect,
    /// Horizontal middle of each tab, client x.
    pub tab_mids: Vec<f64>,
}

/// A window's inner rectangle as the binding knows it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "windows.ts"))]
#[serde(rename_all = "camelCase")]
pub struct WindowFrameInput {
    pub label: String,
    /// Screen, logical pixels; `None` when unknown (Wayland).
    pub inner: Option<ScreenRect>,
}

/// A window for the drop decision, everything in screen coordinates.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "windows.ts"))]
#[serde(rename_all = "camelCase")]
pub struct WindowFrame {
    pub label: String,
    pub inner: Option<ScreenRect>,
    pub strip: Option<ScreenRect>,
    /// Screen x.
    pub tab_mids: Vec<f64>,
    /// 0 = most recently focused.
    pub focus_rank: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "windows.ts"))]
#[serde(rename_all = "camelCase")]
pub struct WindowLayout {
    pub frames: Vec<WindowFrame>,
    pub cursor: Option<ScreenPoint>,
    /// False when a window's position is unknown (Wayland): drops between windows are not decidable.
    pub positions_known: bool,
}
