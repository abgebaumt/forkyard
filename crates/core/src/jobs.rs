//! Long network actions (clone, fetch, pull, push) as jobs: cancellable via the
//! `jobId` of the UI, with `job:progress` and `job:done`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tokio::sync::watch;

use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::events::{names, EventSink};
use crate::git::parse_progress;
use crate::model::{JobDoneEvent, JobProgressEvent};

/// Cancel signal that can be cloned and queried from several places.
#[derive(Clone, Debug)]
pub struct CancelToken {
    tx: Arc<watch::Sender<bool>>,
}

impl Default for CancelToken {
    fn default() -> Self {
        Self::new()
    }
}

impl CancelToken {
    pub fn new() -> Self {
        let (tx, _rx) = watch::channel(false);
        CancelToken { tx: Arc::new(tx) }
    }
    pub fn cancel(&self) {
        self.tx.send_replace(true);
    }
    pub fn is_cancelled(&self) -> bool {
        *self.tx.borrow()
    }
    /// Returns as soon as it was cancelled.
    pub async fn cancelled(&self) {
        let mut rx = self.tx.subscribe();
        loop {
            if *rx.borrow_and_update() {
                return;
            }
            if rx.changed().await.is_err() {
                std::future::pending::<()>().await;
            }
        }
    }
    /// `Err(cancelled)` if it was cancelled – for checks between two steps.
    pub fn check(&self) -> CoreResult<()> {
        if self.is_cancelled() {
            Err(CoreError::cancelled())
        } else {
            Ok(())
        }
    }
}

/// jobId → cancel signal of the running jobs.
#[derive(Default)]
pub struct JobRegistry {
    jobs: Mutex<HashMap<String, CancelToken>>,
}

impl JobRegistry {
    pub fn new() -> Self {
        Self::default()
    }
    /// Registers a job. A jobId that is already running yields `duplicate`.
    pub fn register(&self, job_id: &str) -> CoreResult<CancelToken> {
        let mut jobs = self.jobs.lock();
        if jobs.contains_key(job_id) {
            return Err(CoreError::duplicate());
        }
        let token = CancelToken::new();
        jobs.insert(job_id.to_string(), token.clone());
        Ok(token)
    }
    /// Cancels a job. `false` if the jobId is not running (any more).
    pub fn cancel(&self, job_id: &str) -> bool {
        match self.jobs.lock().get(job_id) {
            Some(token) => {
                token.cancel();
                true
            }
            None => false,
        }
    }
    pub fn is_running(&self, job_id: &str) -> bool {
        self.jobs.lock().contains_key(job_id)
    }
    /// Number of running jobs.
    pub fn running(&self) -> usize {
        self.jobs.lock().len()
    }
    /// Cancels all running jobs (the app is exiting) and returns their number.
    pub fn cancel_all(&self) -> usize {
        let jobs = self.jobs.lock();
        for token in jobs.values() {
            token.cancel();
        }
        jobs.len()
    }
    pub fn remove(&self, job_id: &str) {
        self.jobs.lock().remove(job_id);
    }
}

/// A running job. Created via `Core::start_job`. Call `finish` at the end;
/// if it is dropped without `finish`, it reports `job:done` with `ok: false`.
pub struct Job {
    id: String,
    repo_id: Option<String>,
    token: CancelToken,
    registry: Arc<JobRegistry>,
    events: Arc<dyn EventSink>,
    last: Mutex<(String, Option<u32>, Option<Instant>)>,
    finished: AtomicBool,
}

/// Minimum interval between two `job:progress` with the same phase and the same percentage.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

impl Job {
    pub(crate) fn new(job_id: &str, repo_id: Option<&str>, registry: Arc<JobRegistry>, events: Arc<dyn EventSink>) -> CoreResult<Job> {
        let token = registry.register(job_id)?;
        Ok(Job {
            id: job_id.to_string(),
            repo_id: repo_id.map(str::to_string),
            token,
            registry,
            events,
            last: Mutex::new((String::new(), None, None)),
            finished: AtomicBool::new(false),
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    /// The same job, but its progress carries `repo_id` – for runs across several
    /// repositories. Shares jobId and cancel signal; never reports `job:done` (the actual
    /// job does that).
    pub fn scoped(&self, repo_id: &str) -> Job {
        Job {
            id: self.id.clone(),
            repo_id: Some(repo_id.to_string()),
            token: self.token.clone(),
            registry: self.registry.clone(),
            events: self.events.clone(),
            last: Mutex::new((String::new(), None, None)),
            // Counts as finished: neither `finish` nor dropping reports anything.
            finished: AtomicBool::new(true),
        }
    }

    /// For `GitCmd::run_stream`.
    pub fn token(&self) -> &CancelToken {
        &self.token
    }

    /// Reports progress (throttled when nothing significant changes).
    pub fn progress(&self, phase: &str, percent: Option<u32>, line: &str) {
        {
            let mut last = self.last.lock();
            let same = last.0 == phase && last.1 == percent;
            if same && last.2.is_some_and(|t| t.elapsed() < PROGRESS_INTERVAL) {
                return;
            }
            *last = (phase.to_string(), percent, Some(Instant::now()));
        }
        let event = JobProgressEvent {
            job_id: self.id.clone(),
            repo_id: self.repo_id.clone(),
            phase: phase.to_string(),
            percent,
            line: line.to_string(),
        };
        if let Ok(v) = serde_json::to_value(event) {
            self.events.emit(names::JOB_PROGRESS, v);
        }
    }

    /// Report a stderr line from Git as progress (phase and percentage are recognized).
    pub fn progress_line(&self, line: &str) {
        match parse_progress(line) {
            Some((phase, percent)) => self.progress(&phase, percent, line),
            None => self.progress("", None, line),
        }
    }

    /// Reports `job:done` matching the result and unregisters the job.
    pub fn finish<T>(self, result: &CoreResult<T>) {
        let (ok, cancelled, message) = match result {
            Ok(_) => (true, false, None),
            Err(e) => (false, e.code == ErrorCode::Cancelled, Some(e.message.clone())),
        };
        self.done(ok, cancelled, message);
    }

    fn done(&self, ok: bool, cancelled: bool, message: Option<String>) {
        if self.finished.swap(true, Ordering::SeqCst) {
            return;
        }
        self.registry.remove(&self.id);
        let event = JobDoneEvent { job_id: self.id.clone(), repo_id: self.repo_id.clone(), ok, cancelled, message };
        if let Ok(v) = serde_json::to_value(event) {
            self.events.emit(names::JOB_DONE, v);
        }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        let cancelled = self.token.is_cancelled();
        self.done(false, cancelled, None);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::EventCollector;

    #[tokio::test]
    async fn cancel_token_wakes() {
        let t = CancelToken::new();
        let t2 = t.clone();
        let h = tokio::spawn(async move { t2.cancelled().await });
        tokio::time::sleep(Duration::from_millis(20)).await;
        t.cancel();
        tokio::time::timeout(Duration::from_secs(2), h).await.unwrap().unwrap();
        assert!(t.check().is_err());
    }

    #[test]
    fn registry_and_events() {
        let reg = Arc::new(JobRegistry::new());
        let events = Arc::new(EventCollector::new());
        let job = Job::new("j1", Some("r"), reg.clone(), events.clone()).unwrap();
        assert!(reg.is_running("j1"));
        assert_eq!(Job::new("j1", None, reg.clone(), events.clone()).err().map(|e| e.code), Some(ErrorCode::Duplicate));
        job.progress_line("Receiving objects:  10% (1/10)");
        job.progress_line("Receiving objects:  10% (1/10)");
        assert_eq!(events.count(names::JOB_PROGRESS), 1);
        assert!(reg.cancel("j1"));
        assert!(job.token().is_cancelled());
        job.finish::<()>(&Err(CoreError::cancelled()));
        assert!(!reg.is_running("j1"));
        let done = events.named(names::JOB_DONE);
        assert_eq!(done.len(), 1);
        assert_eq!(done[0]["cancelled"], true);
        assert_eq!(done[0]["jobId"], "j1");
        assert!(!reg.cancel("j1"));
    }
}
