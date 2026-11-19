//! Running `git log --date-order` walkers that follow-up pages of `graph_page` read on from.
//!
//! Every `--skip=<n>` call makes Git walk and sort the history up to `n` again, so deep pages got
//! slower the further down they were. A walker keeps the `git log` of a page sequence running
//! between pages; the cursor names it (`w`) and the next page takes it back if repository,
//! fingerprint and offset still match. A walker that is gone (evicted, idle, released, or taken
//! by a concurrent call with the same cursor) is no error: the page starts a new one with
//! `--skip=<offset>`, which gives the same rows.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use crate::app::Core;
use crate::error::CoreResult;
use crate::git::log::{Records, HEADER, HEADER_FIELDS, LOG_SAFE};
use crate::git::GitRecordStream;
use crate::util;

/// Walkers kept at most (over all repositories); beyond that the least recently used one ends.
pub const MAX_WALKERS: usize = 4;
/// A walker no page used for this long ends.
pub const WALKER_IDLE: Duration = Duration::from_secs(120);

/// A running `git log` over the starting points of one plan.
pub(super) struct Walker {
    pub id: String,
    pub repo_id: String,
    pub fingerprint: String,
    /// Commits handed out so far (including the `--skip` it started with).
    pub offset: u64,
    stream: GitRecordStream,
    records: Records,
    /// A record read past the page end, handed out first next time.
    unread: Option<Vec<Vec<u8>>>,
    touched: Instant,
}

impl Walker {
    /// `git log --date-order` over the starting points in `tips_stdin`, after the first `skip` commits.
    pub(super) async fn start(
        core: &Core,
        path: &Path,
        repo_id: &str,
        fingerprint: &str,
        tips_stdin: String,
        skip: u64,
    ) -> CoreResult<Walker> {
        let mut cmd = core.git.cmd(path).repo(repo_id).read().args(["log", "--date-order"]).args(LOG_SAFE).args([
            "--ignore-missing",
            "-z",
            &format!("--format={HEADER}"),
        ]);
        if skip > 0 {
            cmd = cmd.arg(format!("--skip={skip}"));
        }
        let stream = cmd.arg("--stdin").stdin(tips_stdin).spawn_records(0).await?;
        Ok(Walker {
            id: util::new_id(),
            repo_id: repo_id.to_string(),
            fingerprint: fingerprint.to_string(),
            offset: skip,
            stream,
            records: Records::new(HEADER_FIELDS),
            unread: None,
            touched: Instant::now(),
        })
    }

    /// The next commit (fields as in `log::HEADER`); `None` at the end of the history.
    pub(super) async fn next(&mut self) -> CoreResult<Option<Vec<Vec<u8>>>> {
        if let Some(record) = self.unread.take() {
            self.offset += 1;
            return Ok(Some(record));
        }
        while let Some(field) = self.stream.next_record().await? {
            if let Some(record) = self.records.push(&field) {
                self.offset += 1;
                return Ok(Some(record));
            }
        }
        Ok(None)
    }

    /// Gives back the record read past the page end; at most one is held.
    pub(super) fn unread(&mut self, record: Vec<Vec<u8>>) {
        debug_assert!(self.unread.is_none(), "at most one record is held back");
        self.unread = Some(record);
        self.offset -= 1;
    }
}

/// The walkers waiting for their next page; stored via `core.state::<GraphWalkers>()`.
pub(crate) struct GraphWalkers {
    /// Least recently used first.
    walkers: Mutex<Vec<Walker>>,
    idle: Mutex<Duration>,
}

impl Default for GraphWalkers {
    fn default() -> Self {
        GraphWalkers { walkers: Mutex::new(Vec::new()), idle: Mutex::new(WALKER_IDLE) }
    }
}

impl GraphWalkers {
    /// Removes and returns the walker if id, repository, fingerprint and offset all match; while a
    /// page holds it, no other call can read from it.
    pub(super) fn take(&self, repo_id: &str, id: &str, fingerprint: &str, offset: u64) -> Option<Walker> {
        let mut walkers = self.walkers.lock();
        let index =
            walkers.iter().position(|w| w.id == id && w.repo_id == repo_id && w.fingerprint == fingerprint && w.offset == offset)?;
        Some(walkers.remove(index))
    }

    /// Keeps the walker for the next page; ends the least recently used beyond `MAX_WALKERS`.
    pub(super) fn put(self: &Arc<Self>, mut walker: Walker) {
        walker.touched = Instant::now();
        let evicted: Vec<Walker> = {
            let mut walkers = self.walkers.lock();
            walkers.push(walker);
            let excess = walkers.len().saturating_sub(MAX_WALKERS);
            walkers.drain(..excess).collect()
        };
        drop(evicted);
        let idle = *self.idle.lock();
        let this = Arc::clone(self);
        tokio::spawn(async move {
            tokio::time::sleep(idle).await;
            this.sweep();
        });
    }

    /// Ends the walkers of `repo_id` built for another plan: a first page means the old pages are gone.
    pub(super) fn drop_other_fingerprints(&self, repo_id: &str, fingerprint: &str) {
        drop(self.remove(|w| w.repo_id == repo_id && w.fingerprint != fingerprint));
    }

    /// Ends the walkers no page used for the idle time.
    pub(super) fn sweep(&self) {
        let idle = *self.idle.lock();
        drop(self.remove(|w| w.touched.elapsed() >= idle));
    }

    /// Ends all walkers of the repository; returns how many there were.
    pub fn release(&self, repo_id: &str) -> usize {
        self.remove(|w| w.repo_id == repo_id).len()
    }

    /// Walkers waiting, for one repository or all.
    pub fn count(&self, repo_id: Option<&str>) -> usize {
        self.walkers.lock().iter().filter(|w| repo_id.map_or(true, |id| w.repo_id == id)).count()
    }

    #[cfg(test)]
    pub(super) fn set_idle(&self, idle: Duration) {
        *self.idle.lock() = idle;
    }

    /// Takes the matching walkers out; Git ends when the caller drops them, outside the lock.
    fn remove(&self, matches: impl Fn(&Walker) -> bool) -> Vec<Walker> {
        let mut walkers = self.walkers.lock();
        let (gone, kept) = std::mem::take(&mut *walkers).into_iter().partition(matches);
        *walkers = kept;
        gone
    }
}
