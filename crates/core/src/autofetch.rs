//! Auto-fetch per open repository.
//!
//! Each repository runs a task that executes `git fetch --all` every
//! `Settings.auto_fetch_minutes` minutes (with `--prune` if `Settings.auto_prune`). The settings
//! are re-read continuously: 0 minutes or `RepoSettings.auto_fetch = false` switch it off, a
//! change takes effect without a restart (at the latest after `FetchTiming.poll`).
//!
//! The fetch always runs without a prompt (`GitCmd::network().no_prompt()`): credentials from
//! credential helpers, the keychain and the SSH agent are used, the enforced default SSH key
//! applies as with every network call, but nothing may ask (no prompt to the UI, no window
//! of the Git Credential Manager). If anything is missing, the fetch fails silently.
//!
//! - "Busy": if a write action (write lock) or another transfer (network lock: fetch, pull,
//!   push) is currently running on the same repository, it is skipped and retried on the
//!   next tick. The auto-fetch itself only holds the network lock.
//! - Repositories without a remote are not fetched.
//! - If refs changed: `repo:changed` with `refs` and a log entry.
//! - Failures only appear in the log – one entry per kind of error, not one per attempt.
//!
//! Callers as with `watcher`: `start` on the first tab of a repository, `stop` on the
//! last; src-tauri at startup for all open repo tabs. In tests (and with the feature
//! `testkit`) auto-fetch is switched off; `set_enabled(core, true)` switches it on.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use tokio::time::Instant;

use crate::app::Core;
use crate::db;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::events::names;
use crate::git::{errors, redact};
use crate::jobs::CancelToken;
use crate::model::RepoChange;
use crate::util;

/// Total time of an auto-fetch; after that it is terminated.
const FETCH_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// How long Git may stay silent (hanging connection) before the auto-fetch is terminated.
const FETCH_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// At most this much output ends up in the log.
const MAX_LOG_OUTPUT: usize = 8 * 1024;

/// Timings of the auto-fetch (can be shortened in tests via `set_timing`).
#[derive(Debug, Clone, Copy)]
pub struct FetchTiming {
    /// How long "one minute" from `Settings.auto_fetch_minutes` is.
    pub minute: Duration,
    /// Interval at which the settings are re-read (and retried after "busy").
    pub poll: Duration,
}

impl Default for FetchTiming {
    fn default() -> Self {
        FetchTiming { minute: Duration::from_secs(60), poll: Duration::from_secs(5) }
    }
}

/// Running auto-fetch tasks; stored via `core.state::<AutoFetchers>()`.
pub struct AutoFetchers {
    enabled: AtomicBool,
    next_generation: AtomicU64,
    timing: Mutex<FetchTiming>,
    running: Mutex<HashMap<String, (u64, CancelToken)>>,
    /// Last logged error per repository, so the same error does not appear in the log again every minute.
    last_failure: Mutex<HashMap<String, ErrorCode>>,
}

impl Default for AutoFetchers {
    fn default() -> Self {
        AutoFetchers {
            enabled: AtomicBool::new(!cfg!(any(test, feature = "testkit"))),
            next_generation: AtomicU64::new(1),
            timing: Mutex::new(FetchTiming::default()),
            running: Mutex::new(HashMap::new()),
            last_failure: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    /// The repository has no remote.
    NoRemote,
    /// A write action or another transfer is currently running on the repository.
    Busy,
}

/// Result of a single auto-fetch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FetchOutcome {
    Skipped(SkipReason),
    /// Fetch succeeded; `refs_changed`: something new arrived (then `repo:changed` was reported).
    Fetched { refs_changed: bool },
    /// Fetch failed (recorded in the log, nowhere else).
    Failed(CoreError),
}

/// Switches auto-fetch on or off for future `start` calls. On in the program, off in tests.
pub fn set_enabled(core: &Core, enabled: bool) {
    core.state::<AutoFetchers>().enabled.store(enabled, Ordering::SeqCst);
}

/// Changes the timings; also affects tasks already running (on the next tick).
pub fn set_timing(core: &Core, timing: FetchTiming) {
    *core.state::<AutoFetchers>().timing.lock() = timing;
}

/// Whether an auto-fetch task is running for the repository.
pub fn is_running(core: &Core, repo_id: &str) -> bool {
    core.state::<AutoFetchers>().running.lock().contains_key(repo_id)
}

/// Starts auto-fetch for the repository. Calling it more than once is allowed.
/// Must be called from within a Tokio runtime.
pub fn start(core: &Core, repo_id: &str) -> CoreResult<()> {
    let state = core.state::<AutoFetchers>();
    if !state.enabled.load(Ordering::SeqCst) {
        return Ok(());
    }
    core.repo_row(repo_id)?;
    let runtime = tokio::runtime::Handle::try_current()
        .map_err(|_| CoreError::unknown("Auto-fetch can only be started from the running app."))?;
    let (generation, stop) = {
        let mut running = state.running.lock();
        if running.contains_key(repo_id) {
            return Ok(());
        }
        let generation = state.next_generation.fetch_add(1, Ordering::SeqCst);
        let stop = CancelToken::new();
        running.insert(repo_id.to_string(), (generation, stop.clone()));
        (generation, stop)
    };
    let core = core.clone();
    let repo_id = repo_id.to_string();
    runtime.spawn(async move {
        fetch_loop(&core, &repo_id, &stop).await;
        let state = core.state::<AutoFetchers>();
        let mut running = state.running.lock();
        if running.get(&repo_id).is_some_and(|(g, _)| *g == generation) {
            running.remove(&repo_id);
        }
    });
    Ok(())
}

/// Stops auto-fetch; a fetch currently running is aborted. Unknown IDs are not an error.
pub fn stop(core: &Core, repo_id: &str) -> CoreResult<()> {
    let state = core.state::<AutoFetchers>();
    if let Some((_, stop)) = state.running.lock().remove(repo_id) {
        stop.cancel();
    }
    state.last_failure.lock().remove(repo_id);
    Ok(())
}

/// The interval between two fetches according to the settings; `None` = switched off.
fn interval(core: &Core, repo_id: &str, timing: FetchTiming) -> Option<Duration> {
    let settings = core.settings().ok()?;
    if settings.auto_fetch_minutes == 0 || !repo_auto_fetch(core, repo_id) {
        return None;
    }
    Some(timing.minute * settings.auto_fetch_minutes)
}

/// `RepoSettings.auto_fetch` (default: on).
fn repo_auto_fetch(core: &Core, repo_id: &str) -> bool {
    core.db
        .with(|c| db::repo_settings::get_all(c, repo_id))
        .ok()
        .and_then(|all| all.into_iter().find(|(key, _)| key == "autoFetch"))
        .and_then(|(_, value)| value.as_bool())
        .unwrap_or(true)
}

async fn fetch_loop(core: &Core, repo_id: &str, stop: &CancelToken) {
    let state = core.state::<AutoFetchers>();
    let mut last = Instant::now();
    loop {
        let timing = *state.timing.lock();
        let wait = match interval(core, repo_id, timing) {
            Some(every) => every.saturating_sub(last.elapsed()).min(timing.poll),
            None => timing.poll,
        };
        let wait = wait.max(Duration::from_millis(10));
        tokio::select! {
            _ = stop.cancelled() => return,
            _ = tokio::time::sleep(wait) => {}
        }
        // The repository was removed from the list: stop.
        if matches!(core.repo_row(repo_id), Err(e) if e.code == ErrorCode::NotFound) {
            return;
        }
        let timing = *state.timing.lock();
        let Some(every) = interval(core, repo_id, timing) else {
            // Switched off: the time only counts from switching it on again.
            last = Instant::now();
            continue;
        };
        if last.elapsed() < every {
            continue;
        }
        match fetch_with(core, repo_id, stop).await {
            // Busy: retry on the next tick instead of waiting a whole interval.
            FetchOutcome::Skipped(SkipReason::Busy) => {}
            _ => last = Instant::now(),
        }
    }
}

/// One auto-fetch right away, independent of the schedule and of the interval settings
/// (`Settings.auto_prune` applies). Reports and logs like the scheduled one.
pub async fn run_once(core: &Core, repo_id: &str) -> FetchOutcome {
    fetch_with(core, repo_id, &CancelToken::new()).await
}

async fn fetch_with(core: &Core, repo_id: &str, stop: &CancelToken) -> FetchOutcome {
    match try_fetch(core, repo_id, stop).await {
        Ok(outcome) => outcome,
        Err(e) => FetchOutcome::Failed(e),
    }
}

/// State of the refs a fetch can move.
async fn remote_refs(core: &Core, repo_id: &str) -> CoreResult<Vec<u8>> {
    let out = core
        .git_for(repo_id)?
        .args(["for-each-ref", "--format=%(objectname) %(refname)", "refs/remotes", "refs/tags"])
        .read_only()
        .no_log()
        .run()
        .await?;
    Ok(out.stdout)
}

async fn try_fetch(core: &Core, repo_id: &str, stop: &CancelToken) -> CoreResult<FetchOutcome> {
    // Busy: a write action is running, or already a transfer (also a manual fetch, which
    // does not hold the write lock at all).
    if core.write_lock_held(repo_id) {
        return Ok(FetchOutcome::Skipped(SkipReason::Busy));
    }
    let Some(_network) = core.try_network_lock(repo_id) else {
        return Ok(FetchOutcome::Skipped(SkipReason::Busy));
    };
    let remotes = core.git_for(repo_id)?.arg("remote").read_only().no_log().run().await?;
    if remotes.stdout_lines().iter().all(|line| line.is_empty()) {
        return Ok(FetchOutcome::Skipped(SkipReason::NoRemote));
    }
    let prune = core.settings()?.auto_prune;
    let before = remote_refs(core, repo_id).await?;

    let mut cmd = core.git_for(repo_id)?.args(["fetch", "--all", "--progress", "--no-auto-maintenance"]);
    if prune {
        cmd = cmd.arg("--prune");
    }
    let command = cmd.command_line();
    let started_at = util::now_iso();
    let started = std::time::Instant::now();
    // No logging by the runner: only what is worth knowing is logged (see `record`).
    let result = cmd
        .network()
        .no_prompt()
        .read_only()
        .no_log()
        .check(false)
        .timeout(FETCH_TIMEOUT)
        .idle_timeout(FETCH_IDLE_TIMEOUT)
        .run_stream(stop, &mut |_| {})
        .await;
    let duration_ms = started.elapsed().as_millis() as u64;
    // With an enforced default key the entry names its path (as with a manual fetch).
    let key_note = core.git.forced_ssh_key_note(Some(repo_id));
    let entry = |exit_code: Option<i32>, output: String, code: Option<ErrorCode>| {
        let mut output = util::truncate_str(output.trim_end(), MAX_LOG_OUTPUT);
        if let Some(note) = &key_note {
            if !output.is_empty() {
                output.push('\n');
            }
            output.push_str(note);
        }
        db::activity::NewActivity {
            repo_id: Some(repo_id.to_string()),
            description: "Auto-fetch".into(),
            command: command.clone(),
            exit_code,
            duration_ms,
            output,
            started_at: started_at.clone(),
            code,
        }
    };
    let state = core.state::<AutoFetchers>();

    let failure = match result {
        Ok(out) if out.success() => {
            state.last_failure.lock().remove(repo_id);
            let refs_changed = remote_refs(core, repo_id).await? != before;
            if refs_changed {
                record(core, &entry(Some(0), clean_progress(&out.stderr), None));
                core.emit_repo_changed(repo_id, &[RepoChange::Refs]);
            }
            return Ok(FetchOutcome::Fetched { refs_changed });
        }
        Ok(out) => {
            let error = errors::classify("fetch", out.code, &out.stdout, &out.stderr);
            (error, out.code, clean_progress(&out.stderr))
        }
        // Stopped (tab closed): not an error, nothing to log.
        Err(e) if e.code == ErrorCode::Cancelled => return Err(e),
        Err(e) => (e, None, String::new()),
    };
    let (error, exit_code, output) = failure;
    // A failed fetch may also have updated individual remotes.
    if remote_refs(core, repo_id).await.is_ok_and(|after| after != before) {
        core.emit_repo_changed(repo_id, &[RepoChange::Refs]);
    }
    let repeated = state.last_failure.lock().insert(repo_id.to_string(), error.code) == Some(error.code);
    if !repeated {
        let text = format!("Auto-fetch failed: {}\n{output}", error.message);
        record(core, &entry(exit_code, text, Some(error.code)));
    }
    Ok(FetchOutcome::Failed(error))
}

/// Writes a log entry and reports `log:appended`.
fn record(core: &Core, entry: &db::activity::NewActivity) {
    match core.db.with(|c| db::activity::insert(c, entry)) {
        Ok(saved) => core.emit(names::LOG_APPENDED, &saved),
        Err(e) => log::warn!("Log entry not saved: {}", e.message),
    }
}

/// stderr of `git fetch --progress` for the log: without the progress lines that keep
/// getting overwritten, without credentials.
fn clean_progress(stderr: &[u8]) -> String {
    let text = redact::redact_bytes(stderr);
    let mut lines: Vec<&str> = Vec::new();
    for line in text.split('\n') {
        // Of states overwritten with "\r", keep only the last one.
        let last = line.trim_end_matches('\r').rsplit('\r').next().unwrap_or("").trim_end();
        let progress = last.contains('%') && last.contains(':') && !last.contains("->");
        if !last.is_empty() && !progress {
            lines.push(last);
        }
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests;
