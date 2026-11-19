//! Small inputs and outputs of individual commands

use super::*;

/// `kind` of `refNameCheck`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "small_io.ts"))]
#[serde(rename_all = "snake_case")]
pub enum RefNameKind {
    Branch,
    Tag,
}

/// Result of `refNameCheck`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "small_io.ts"))]
#[serde(rename_all = "camelCase")]
pub struct RefNameCheck {
    pub valid: bool,
    pub reason: Option<String>,
}
