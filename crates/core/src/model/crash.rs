//! Crash reports

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "crash.ts"))]
#[serde(rename_all = "snake_case")]
pub enum CrashReportKind {
    /// A Rust panic, written by the panic hook.
    Panic,
    /// The previous run ended without a clean exit and without a panic report.
    UnexpectedExit,
}

/// A pending crash report as the list shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "crash.ts"))]
#[serde(rename_all = "camelCase")]
pub struct CrashReportSummary {
    pub id: Id,
    /// ISO 8601, UTC.
    pub time: String,
    pub kind: CrashReportKind,
    pub app_version: String,
    /// First line of the message, shortened.
    pub message: String,
}
