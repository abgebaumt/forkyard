//! Crash diagnostics: the app's log, the panic hook and the marker for hard crashes.
//!
//! - **Log:** every line (from the `log` facade) is scrubbed (`redact::redact`, the app's known
//!   secrets via `secrets::scrub`, the home directory shortened to `~`) and then kept in a ring of
//!   the last `RING_LINES` lines and appended to `<data_dir>/logs/forkyard.log` (rotated at
//!   `MAX_LOG_BYTES`, `LOG_FILES` files in all). Lines from before the data directory is known
//!   wait in the ring and are written once it is (`attach`).
//! - **Panic hook:** writes `<data_dir>/crash/<id>.json` with version, platform, thread, message,
//!   location, backtrace and the ring – scrubbed, with plain file I/O only (no SQLite; the ring is
//!   only taken with `try_lock`) – and then hands over to the previous hook.
//! - **Marker:** `<data_dir>/running` names the current run and is held with an OS file lock
//!   while it runs. It is removed on a clean exit. If it is still there on the next start, nobody
//!   holds its lock and that run left no panic report, the run ended hard (stack overflow, abort,
//!   killed): a report of kind `unexpected_exit` is made from the end of the log. A second
//!   instance with the same data directory does not get the lock and leaves the marker alone.
//! - At most `MAX_REPORTS` reports are kept; nothing is ever sent anywhere.
//!
//! The reports are read and handed to the UI by `commands::crash`.

use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, OnceLock, RwLock, TryLockError};

use serde::{Deserialize, Serialize};

use crate::git::redact;
use crate::util;

pub const LOG_DIR: &str = "logs";
pub const LOG_FILE: &str = "forkyard.log";
pub const CRASH_DIR: &str = "crash";
pub const MARKER_FILE: &str = "running";
/// Lines kept in memory (and put into a panic report).
pub const RING_LINES: usize = 500;
/// Size at which the log file is rotated.
pub const MAX_LOG_BYTES: u64 = 1024 * 1024;
/// Log files in all: `forkyard.log`, `forkyard.1.log`, `forkyard.2.log`.
pub const LOG_FILES: usize = 3;
/// Reports kept; older ones are deleted.
pub const MAX_REPORTS: usize = 10;
/// Lines from the end of the log that go into an `unexpected_exit` report.
const TAIL_LINES: usize = 200;
/// Longest single log line (a runaway message must not fill the file).
const MAX_LINE_BYTES: usize = 8 * 1024;

pub use crate::model::CrashReportKind as ReportKind;

/// A report as stored in `<data_dir>/crash/<id>.json`. All texts are already scrubbed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportFile {
    pub id: String,
    pub kind: ReportKind,
    pub time_ms: i64,
    pub app_version: String,
    pub os: String,
    pub arch: String,
    /// The run the report is about.
    pub run_id: String,
    pub thread: Option<String>,
    pub message: String,
    pub location: Option<String>,
    pub backtrace: Option<String>,
    pub log: Vec<String>,
}

impl ReportFile {
    pub fn new(kind: ReportKind, time_ms: i64, app_version: &str, run_id: &str, message: String) -> Self {
        ReportFile {
            id: report_id(time_ms),
            kind,
            time_ms,
            app_version: app_version.to_string(),
            os: std::env::consts::OS.to_string(),
            arch: std::env::consts::ARCH.to_string(),
            run_id: run_id.to_string(),
            thread: None,
            message,
            location: None,
            backtrace: None,
            log: Vec::new(),
        }
    }
}

/// What `attach` found.
#[derive(Debug, Default)]
pub struct AttachOutcome {
    /// This process holds the marker (`false`: another instance with this data directory runs).
    pub owns_marker: bool,
    /// ID of the `unexpected_exit` report made for the previous run.
    pub unexpected_report: Option<String>,
}

/// Contents of the marker file.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Marker {
    run_id: String,
    pid: u32,
    started_ms: i64,
    app_version: String,
}

struct Sink {
    dir: PathBuf,
    file: Option<File>,
    size: u64,
}

struct Attached {
    data_dir: PathBuf,
    version: String,
}

/// The log, the panic report writer and the marker of one process (`global()`); tests make their own.
pub struct CrashLog {
    /// Identifies this run in the marker and in its reports.
    pub run_id: String,
    started_ms: i64,
    home: Option<String>,
    max_log_bytes: u64,
    secrets: RwLock<Vec<String>>,
    ring: Mutex<VecDeque<String>>,
    /// Lines not yet written because the data directory is not known yet.
    pending: Mutex<Vec<String>>,
    sink: Mutex<Option<Sink>>,
    attached: OnceLock<Attached>,
    /// The locked marker file while this process owns it.
    marker: Mutex<Option<File>>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn try_lock<T>(mutex: &Mutex<T>) -> Option<MutexGuard<'_, T>> {
    match mutex.try_lock() {
        Ok(guard) => Some(guard),
        Err(TryLockError::Poisoned(poisoned)) => Some(poisoned.into_inner()),
        Err(TryLockError::WouldBlock) => None,
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn iso(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).unwrap_or_default().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// `20261014T120000123Z-1a2b3c4d`: sorts by time; the suffix keeps two reports in the same
/// millisecond apart.
fn report_id(ms: i64) -> String {
    let time = chrono::DateTime::from_timestamp_millis(ms).unwrap_or_default().format("%Y%m%dT%H%M%S%3fZ");
    let suffix: String = util::new_id().chars().filter(char::is_ascii_alphanumeric).take(8).collect();
    format!("{time}-{suffix}")
}

/// Only IDs as `report_id` makes them – nothing that could leave the crash folder.
pub fn valid_report_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Replaces `home` (also with the other kind of slash, and case-insensitively on Windows) by `~`.
fn shorten_home(text: &str, home: &str) -> String {
    if home.len() < 2 {
        return text.to_string();
    }
    let mut out = text.to_string();
    let mut variants = vec![home.to_string(), home.replace('\\', "/")];
    variants.dedup();
    for variant in variants {
        if cfg!(windows) {
            // ASCII lowercase keeps byte offsets, so positions carry over.
            let needle = variant.to_ascii_lowercase();
            let mut result = String::with_capacity(out.len());
            let mut rest = out.as_str();
            while let Some(at) = rest.to_ascii_lowercase().find(&needle) {
                result.push_str(&rest[..at]);
                result.push('~');
                rest = &rest[at + needle.len()..];
            }
            result.push_str(rest);
            out = result;
        } else {
            out = out.replace(&variant, "~");
        }
    }
    out
}

impl Default for CrashLog {
    fn default() -> Self {
        Self::new()
    }
}

impl CrashLog {
    pub fn new() -> Self {
        Self::with_options(dirs::home_dir(), MAX_LOG_BYTES)
    }

    /// `home`: the folder shortened to `~`; `max_log_bytes`: rotation size (small in tests).
    pub fn with_options(home: Option<PathBuf>, max_log_bytes: u64) -> Self {
        CrashLog {
            run_id: util::new_id(),
            started_ms: now_ms(),
            home: home.map(|h| h.to_string_lossy().trim_end_matches(['/', '\\']).to_string()).filter(|h| !h.is_empty()),
            max_log_bytes: max_log_bytes.max(256),
            secrets: RwLock::new(Vec::new()),
            ring: Mutex::new(VecDeque::with_capacity(RING_LINES)),
            pending: Mutex::new(Vec::new()),
            sink: Mutex::new(None),
            attached: OnceLock::new(),
            marker: Mutex::new(None),
        }
    }

    /// A secret the app handles (token, proxy password): from now on removed from every line.
    pub fn remember_secret(&self, secret: &str) {
        if secret.len() < 4 {
            return;
        }
        let mut secrets = self.secrets.write().unwrap_or_else(|p| p.into_inner());
        if !secrets.iter().any(|s| s == secret) {
            secrets.push(secret.to_string());
        }
    }

    /// Removes credentials, known secrets and the home directory from a text.
    pub fn scrub(&self, text: &str) -> String {
        let redacted = redact::redact(text);
        let scrubbed = match self.secrets.try_read() {
            Ok(secrets) => crate::secrets::scrub(&redacted, &secrets),
            Err(std::sync::TryLockError::Poisoned(p)) => crate::secrets::scrub(&redacted, &p.into_inner()),
            // Only a writer adding a secret holds it, briefly: wait for it rather than skip it.
            Err(std::sync::TryLockError::WouldBlock) => {
                let secrets = self.secrets.read().unwrap_or_else(|p| p.into_inner());
                crate::secrets::scrub(&redacted, &secrets)
            }
        };
        match &self.home {
            Some(home) => shorten_home(&scrubbed, home),
            None => scrubbed,
        }
    }

    /// Logs one line (with time stamp): scrubbed, into the ring and into the file.
    pub fn push_line(&self, line: &str) {
        let line = util::truncate_str(line, MAX_LINE_BYTES).replace(['\r', '\n'], " ");
        let line = format!("{} {}", iso(now_ms()), self.scrub(&line));
        {
            let mut ring = lock(&self.ring);
            if ring.len() == RING_LINES {
                ring.pop_front();
            }
            ring.push_back(line.clone());
        }
        let mut sink = lock(&self.sink);
        match sink.as_mut() {
            Some(sink) => self.write_line(sink, &line),
            None => {
                let mut pending = lock(&self.pending);
                if pending.len() == RING_LINES {
                    pending.remove(0);
                }
                pending.push(line);
            }
        }
    }

    /// The last `RING_LINES` lines, oldest first.
    pub fn recent_lines(&self) -> Vec<String> {
        lock(&self.ring).iter().cloned().collect()
    }

    fn write_line(&self, sink: &mut Sink, line: &str) {
        let bytes = line.len() as u64 + 1;
        if sink.size > 0 && sink.size + bytes > self.max_log_bytes {
            sink.file = None;
            rotate(&sink.dir);
            sink.size = 0;
        }
        if sink.file.is_none() {
            sink.file = OpenOptions::new().create(true).append(true).open(sink.dir.join(LOG_FILE)).ok();
            sink.size = sink.file.as_ref().and_then(|f| f.metadata().ok()).map_or(0, |m| m.len());
        }
        if let Some(file) = sink.file.as_mut() {
            if file.write_all(format!("{line}\n").as_bytes()).is_ok() {
                sink.size += bytes;
            }
        }
    }

    /// The data directory is known: take the marker (and report a previous hard crash), open
    /// the log file, write the lines collected so far. Only the first call counts.
    pub fn attach(&self, data_dir: &Path, version: &str) -> AttachOutcome {
        if self.attached.set(Attached { data_dir: data_dir.to_path_buf(), version: version.to_string() }).is_err() {
            return AttachOutcome { owns_marker: lock(&self.marker).is_some(), unexpected_report: None };
        }
        let logs = data_dir.join(LOG_DIR);
        let _ = std::fs::create_dir_all(&logs);
        let _ = std::fs::create_dir_all(data_dir.join(CRASH_DIR));
        // Before this run writes to the log: its end belongs to the previous run.
        let outcome = self.take_marker(data_dir, version);
        {
            let mut sink = lock(&self.sink);
            let mut new_sink = Sink { dir: logs, file: None, size: 0 };
            let header = format!("{} === Forkyard {version} started (run {}) ===", iso(now_ms()), self.run_id);
            self.write_line(&mut new_sink, &header);
            for line in lock(&self.pending).drain(..) {
                self.write_line(&mut new_sink, &line);
            }
            *sink = Some(new_sink);
        }
        prune_reports(data_dir, MAX_REPORTS);
        outcome
    }

    fn take_marker(&self, data_dir: &Path, version: &str) -> AttachOutcome {
        let path = data_dir.join(MARKER_FILE);
        // `None`: another instance holds it – it is running, not crashed.
        let Some(mut file) = open_marker_exclusively(&path) else {
            return AttachOutcome::default();
        };
        let mut previous = String::new();
        let _ = file.read_to_string(&mut previous);
        let mut unexpected_report = None;
        if let Ok(marker) = serde_json::from_str::<Marker>(&previous) {
            let reported = list_reports(data_dir).iter().any(|r| r.run_id == marker.run_id);
            if !reported {
                unexpected_report = self.report_unexpected_exit(data_dir, &marker);
            }
        }
        let own = Marker { run_id: self.run_id.clone(), pid: std::process::id(), started_ms: self.started_ms, app_version: version.to_string() };
        let written = serde_json::to_string(&own).ok().is_some_and(|text| {
            file.set_len(0).is_ok() && file.seek(SeekFrom::Start(0)).is_ok() && file.write_all(text.as_bytes()).is_ok() && file.sync_all().is_ok()
        });
        if !written {
            return AttachOutcome { owns_marker: false, unexpected_report };
        }
        *lock(&self.marker) = Some(file);
        AttachOutcome { owns_marker: true, unexpected_report }
    }

    fn report_unexpected_exit(&self, data_dir: &Path, marker: &Marker) -> Option<String> {
        let log_file = data_dir.join(LOG_DIR).join(LOG_FILE);
        let last_seen = std::fs::metadata(&log_file).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok());
        let time_ms = last_seen.map_or(marker.started_ms, |d| d.as_millis() as i64);
        let message = format!("Forkyard {} ended without shutting down (started {}).", marker.app_version, iso(marker.started_ms));
        let mut report = ReportFile::new(ReportKind::UnexpectedExit, time_ms, &marker.app_version, &marker.run_id, message);
        report.log = log_tail(&data_dir.join(LOG_DIR), TAIL_LINES).iter().map(|line| self.scrub(line)).collect();
        write_report(data_dir, &report).ok()?;
        Some(report.id)
    }

    /// Clean exit: give up and remove the marker (only if this process owns it).
    pub fn clean_exit(&self) {
        let Some(file) = lock(&self.marker).take() else { return };
        // Empty first: should the removal fail, an empty marker still means "ended cleanly".
        let _ = file.set_len(0);
        // Closing releases the lock (Windows: the file can only be deleted once it is closed).
        drop(file);
        if let Some(attached) = self.attached.get() {
            let _ = std::fs::remove_file(attached.data_dir.join(MARKER_FILE));
        }
        self.push_line("=== Forkyard exited cleanly ===");
    }

    /// Body of the panic hook (`payload` and `location` of the hook's argument). Never blocks
    /// on a lock another thread could hold forever.
    pub fn on_panic(&self, payload: &(dyn std::any::Any + Send), location: Option<&std::panic::Location<'_>>) {
        let Some(attached) = self.attached.get() else { return };
        let message = payload
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| payload.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "(panic without a message)".to_string());
        let message = self.scrub(&message);
        let mut report = ReportFile::new(ReportKind::Panic, now_ms(), &attached.version, &self.run_id, message.clone());
        report.thread = Some(self.scrub(std::thread::current().name().unwrap_or("(unnamed)")));
        report.location = location.map(|l| self.scrub(&format!("{}:{}:{}", l.file(), l.line(), l.column())));
        report.backtrace = Some(self.scrub(&std::backtrace::Backtrace::force_capture().to_string()));
        report.log = match try_lock(&self.ring) {
            Some(ring) => ring.iter().cloned().collect(),
            None => vec!["(the log was busy at the time of the panic)".to_string()],
        };
        let written = write_report(&attached.data_dir, &report).is_ok();
        prune_reports(&attached.data_dir, MAX_REPORTS);
        let line = format!(
            "{} PANIC in thread {}: {message} at {} (report {})",
            iso(now_ms()),
            report.thread.as_deref().unwrap_or(""),
            report.location.as_deref().unwrap_or("?"),
            if written { report.id.as_str() } else { "not written" }
        );
        if let Some(mut sink) = try_lock(&self.sink) {
            if let Some(sink) = sink.as_mut() {
                self.write_line(sink, &line);
            }
        }
    }
}

/// Opens the marker so that no other process can take it while this one runs; the OS lets go
/// when the process ends, however it ends. `None` if another process has it.
#[cfg(unix)]
fn open_marker_exclusively(path: &Path) -> Option<File> {
    use std::os::unix::io::AsRawFd;
    let file = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path).ok()?;
    // SAFETY: `flock` on a descriptor this function owns; no memory is passed.
    let locked = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0;
    locked.then_some(file)
}

/// Windows: opened without sharing – a second process gets a sharing violation until this
/// handle is closed (by `clean_exit` or by the end of the process).
#[cfg(windows)]
fn open_marker_exclusively(path: &Path) -> Option<File> {
    use std::os::windows::fs::OpenOptionsExt;
    OpenOptions::new().read(true).write(true).create(true).truncate(false).share_mode(0).open(path).ok()
}

#[cfg(not(any(unix, windows)))]
fn open_marker_exclusively(path: &Path) -> Option<File> {
    OpenOptions::new().read(true).write(true).create(true).truncate(false).open(path).ok()
}

/// `forkyard.log` → `forkyard.1.log` → `forkyard.2.log`; the oldest is dropped.
fn rotate(dir: &Path) {
    let name = |i: usize| if i == 0 { dir.join(LOG_FILE) } else { dir.join(format!("forkyard.{i}.log")) };
    let _ = std::fs::remove_file(name(LOG_FILES - 1));
    for i in (0..LOG_FILES - 1).rev() {
        let _ = std::fs::rename(name(i), name(i + 1));
    }
}

/// The last `count` lines across the current and the previous log file.
fn log_tail(dir: &Path, count: usize) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for name in ["forkyard.1.log", LOG_FILE] {
        if let Ok(bytes) = std::fs::read(dir.join(name)) {
            lines.extend(String::from_utf8_lossy(&bytes).lines().map(str::to_string));
        }
    }
    let skip = lines.len().saturating_sub(count);
    lines.split_off(skip)
}

fn report_path(data_dir: &Path, id: &str) -> std::io::Result<PathBuf> {
    if !valid_report_id(id) {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "invalid report id"));
    }
    Ok(data_dir.join(CRASH_DIR).join(format!("{id}.json")))
}

/// All readable reports, newest first.
pub fn list_reports(data_dir: &Path) -> Vec<ReportFile> {
    let Ok(entries) = std::fs::read_dir(data_dir.join(CRASH_DIR)) else { return Vec::new() };
    let mut reports: Vec<ReportFile> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().to_str().and_then(|n| n.strip_suffix(".json")).map(str::to_string))
        .filter_map(|id| read_report(data_dir, &id).ok())
        .collect();
    reports.sort_by(|a, b| b.time_ms.cmp(&a.time_ms).then_with(|| b.id.cmp(&a.id)));
    reports
}

pub fn read_report(data_dir: &Path, id: &str) -> std::io::Result<ReportFile> {
    let text = std::fs::read_to_string(report_path(data_dir, id)?)?;
    let mut report: ReportFile = serde_json::from_str(&text).map_err(std::io::Error::other)?;
    // The file name is what the commands use.
    report.id = id.to_string();
    Ok(report)
}

pub fn write_report(data_dir: &Path, report: &ReportFile) -> std::io::Result<()> {
    let path = report_path(data_dir, &report.id)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let text = serde_json::to_vec_pretty(report).map_err(std::io::Error::other)?;
    util::write_file_atomic(&path, &text)
}

pub fn discard_report(data_dir: &Path, id: &str) -> std::io::Result<()> {
    match std::fs::remove_file(report_path(data_dir, id)?) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// Keeps the newest `keep` reports.
pub fn prune_reports(data_dir: &Path, keep: usize) {
    for old in list_reports(data_dir).into_iter().skip(keep) {
        let _ = discard_report(data_dir, &old.id);
    }
}

/// The report as text, for reading and saving.
pub fn render_report(report: &ReportFile) -> String {
    let kind = match report.kind {
        ReportKind::Panic => "panic",
        ReportKind::UnexpectedExit => "unexpected exit",
    };
    let mut out = String::new();
    out.push_str("Forkyard crash report\n");
    out.push_str(&format!("Report:   {}\nKind:     {kind}\nTime:     {}\n", report.id, iso(report.time_ms)));
    out.push_str(&format!("Version:  {}\nPlatform: {} {}\nRun:      {}\n", report.app_version, report.os, report.arch, report.run_id));
    if let Some(thread) = &report.thread {
        out.push_str(&format!("Thread:   {thread}\n"));
    }
    if let Some(location) = &report.location {
        out.push_str(&format!("Location: {location}\n"));
    }
    out.push_str(&format!("\nMessage:\n{}\n", report.message));
    if let Some(backtrace) = &report.backtrace {
        out.push_str(&format!("\nBacktrace:\n{}\n", backtrace.trim_end()));
    }
    out.push_str(&format!("\nLog ({} lines):\n", report.log.len()));
    for line in &report.log {
        out.push_str(line);
        out.push('\n');
    }
    out
}

// ---------------------------------------------------------------------------
// The process-wide instance: `log` backend and panic hook
// ---------------------------------------------------------------------------

/// The log of this process.
pub fn global() -> &'static CrashLog {
    static GLOBAL: OnceLock<CrashLog> = OnceLock::new();
    GLOBAL.get_or_init(CrashLog::new)
}

/// Secrets the core handles are removed from the log (see `CrashLog::remember_secret`).
pub fn remember_secret(secret: &str) {
    global().remember_secret(secret);
}

struct Logger;

/// The app's own crates log from `info`, everything else (Tauri, WebView, HTTP) from `warn`.
fn own_target(target: &str) -> bool {
    ["gitcore", "forkyard"].iter().any(|own| target == *own || target.starts_with(&format!("{own}_")) || target.starts_with(&format!("{own}::")))
}

impl log::Log for Logger {
    fn enabled(&self, metadata: &log::Metadata<'_>) -> bool {
        metadata.level() <= if own_target(metadata.target()) { log::Level::Info } else { log::Level::Warn }
    }

    fn log(&self, record: &log::Record<'_>) {
        if self.enabled(record.metadata()) {
            global().push_line(&format!("{:<5} {}: {}", record.level(), record.target(), record.args()));
        }
    }

    fn flush(&self) {}
}

/// Installs the `log` backend and the panic hook. Call as early as possible; again is harmless.
pub fn install() {
    static INSTALLED: OnceLock<()> = OnceLock::new();
    INSTALLED.get_or_init(|| {
        if log::set_logger(&Logger).is_ok() {
            log::set_max_level(log::LevelFilter::Info);
        }
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            global().on_panic(info.payload(), info.location());
            previous(info);
        }));
    });
}

#[cfg(test)]
mod tests;
