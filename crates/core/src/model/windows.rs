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
