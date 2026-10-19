//! Startup timing: how long the phases of an app start take, as INFO lines in the log
//! (`Startup: …`). The clock starts with `mark_process_start` (first thing in `run`); the core
//! logs its own phases (database, Git, profile, …), and the UI reports its milestones once with
//! `app_startup_report` (script loaded, shell drawn, first graph rows, the slowest calls).

use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use crate::model::StartupReport;

struct Clock {
    instant: Instant,
    wall: SystemTime,
}

static START: OnceLock<Clock> = OnceLock::new();
static REPORTED: OnceLock<()> = OnceLock::new();

/// Starts the startup clock (idempotent; the first call wins).
pub fn mark_process_start() {
    START.get_or_init(|| Clock { instant: Instant::now(), wall: SystemTime::now() });
}

/// Time since `mark_process_start` (since the first call of this module when it was never called).
pub fn since_start() -> Duration {
    mark_process_start();
    START.get().map(|clock| clock.instant.elapsed()).unwrap_or_default()
}

fn ms(duration: Duration) -> u128 {
    duration.as_millis()
}

/// Logs one finished phase: `Startup: <phase> took N ms (at M ms)`.
pub fn phase(name: &str, took: Duration) {
    log::info!("Startup: {name} took {} ms (at {} ms)", ms(took), ms(since_start()));
}

/// Runs `work`, logs it as a phase and returns its result.
pub fn timed<T>(name: &str, work: impl FnOnce() -> T) -> T {
    let started = Instant::now();
    let out = work();
    phase(name, started.elapsed());
    out
}

/// `timed` for async work.
pub async fn timed_async<T>(name: &str, work: impl std::future::Future<Output = T>) -> T {
    let started = Instant::now();
    let out = work.await;
    phase(name, started.elapsed());
    out
}

/// The first call of a command in this run, timed in the core: `Startup: first <name> took N ms
/// (at M ms)`. Later calls log nothing.
pub async fn first_call<T>(name: &'static str, work: impl std::future::Future<Output = T>) -> T {
    static SEEN: parking_lot::Mutex<Vec<&'static str>> = parking_lot::Mutex::new(Vec::new());
    let first = {
        let mut seen = SEEN.lock();
        let first = !seen.contains(&name);
        if first {
            seen.push(name);
        }
        first
    };
    if !first {
        return work.await;
    }
    let started = Instant::now();
    let out = work.await;
    log::info!("Startup: first {name} took {} ms in the core (at {} ms)", ms(started.elapsed()), ms(since_start()));
    out
}

/// A point in time: `Startup: <what> at M ms`.
pub fn reached(what: &str) {
    log::info!("Startup: {what} at {} ms", ms(since_start()));
}

/// Milliseconds since the process start for a moment the UI gives as Unix time in ms.
fn from_process_start(unix_ms: f64) -> Option<i64> {
    let wall = START.get()?.wall;
    let start_ms = wall.duration_since(UNIX_EPOCH).ok()?.as_millis() as f64;
    Some((unix_ms - start_ms).round() as i64)
}

/// The text of the UI's report (one line), or `None` after the first report of this run.
pub fn report_line(report: &StartupReport) -> Option<String> {
    REPORTED.set(()).ok()?;
    let origin = from_process_start(report.time_origin);
    let at = |offset: f64| match origin {
        Some(origin) => format!("{} ms", origin + offset.round() as i64),
        None => format!("+{} ms", offset.round() as i64),
    };
    let mut parts: Vec<String> = Vec::new();
    if let Some(origin) = origin {
        parts.push(format!("page started at {origin} ms"));
    }
    for mark in &report.marks {
        parts.push(format!("{} at {}", mark.name, at(mark.at)));
    }
    let mut calls = report.calls.clone();
    calls.sort_by(|a, b| b.ms.total_cmp(&a.ms));
    let slowest: Vec<String> = calls.iter().take(8).map(|call| format!("{} {} ms (from {})", call.command, call.ms.round() as i64, at(call.start))).collect();
    let mut line = format!("Startup (UI): {}", parts.join(", "));
    if !slowest.is_empty() {
        line.push_str(&format!("; slowest calls: {}", slowest.join(", ")));
    }
    Some(line)
}

/// `app_startup_report`: logs the UI's milestones once per run.
pub fn report(report: &StartupReport) {
    if let Some(line) = report_line(report) {
        log::info!("{line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{StartupCall, StartupMark};

    /// One line per run, with the UI's times converted to "since the process started" and the
    /// slowest calls first.
    #[test]
    fn the_ui_report_is_logged_once_in_process_time() {
        mark_process_start();
        let start_ms = START.get().unwrap().wall.duration_since(UNIX_EPOCH).unwrap().as_millis() as f64;
        let call = |command: &str, start: f64, ms: f64| StartupCall { command: command.to_string(), start, ms };
        let mut calls = vec![call("app_info", 200.0, 60.4), call("graph_page", 410.0, 280.0)];
        calls.extend((0..10).map(|n| call(&format!("quick_{n}"), 300.0, 1.0)));
        let report = StartupReport {
            time_origin: start_ms + 750.0,
            marks: vec![StartupMark { name: "script".into(), at: 180.0 }, StartupMark { name: "graph".into(), at: 702.6 }],
            calls,
        };
        let line = report_line(&report).expect("the first report is logged");
        assert!(
            line.starts_with("Startup (UI): page started at 750 ms, script at 930 ms, graph at 1453 ms; slowest calls: graph_page 280 ms (from 1160 ms), app_info 60 ms (from 950 ms), quick_"),
            "{line}"
        );
        assert_eq!(line.matches(" ms (from ").count(), 8, "at most eight calls: {line}");
        assert_eq!(report_line(&report), None, "a second report of the same run is dropped");
    }
}
