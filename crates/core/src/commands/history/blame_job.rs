//! Blame as a cancellable job: `git blame --incremental`, streamed to the UI as `blame:chunk`
//! (all lines first, then the spans as Git finds them) and kept in an LRU cache.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use super::*;
use crate::events::names;
use crate::git::blame::{IncrementalParser, IncrementalSpan};
use crate::jobs::Job;
use crate::model::{BlameChunkEvent, BlameSpan};

/// `job:progress` phase of a blame job.
pub const PHASE_BLAME: &str = "blame";
/// Number of blame results kept (the least recently used goes first).
pub const BLAME_CACHE_SIZE: usize = 32;
/// After the first span, spans are sent at most this often …
const FLUSH_INTERVAL: Duration = Duration::from_millis(50);
/// … or once this many lines are waiting.
const FLUSH_LINES: u32 = 5_000;

/// Like `file_blame`, as a job under `job_id`: cancellable (`job_cancel` → `cancelled`, nothing is
/// cached), with `blame:chunk` and `job:progress` (phase `blame`). Same errors as `file_blame`;
/// the result equals `file_blame`'s lines. A result from the cache sends no `blame:chunk`.
pub async fn file_blame_job(
    core: &Core,
    repo_id: String,
    job_id: String,
    path: String,
    sha: Option<String>,
    encoding: Option<String>,
) -> CoreResult<Vec<BlameLine>> {
    let job = core.start_job(&job_id, Some(&repo_id))?;
    let result = blame_job(core, &job, &repo_id, &path, sha.as_deref(), encoding.as_deref()).await;
    job.finish(&result);
    result
}

async fn blame_job(
    core: &Core,
    job: &Job,
    repo_id: &str,
    path: &str,
    sha: Option<&str>,
    encoding: Option<&str>,
) -> CoreResult<Vec<BlameLine>> {
    job.token().check()?;
    let target = match blame_source(core, repo_id, path, sha, encoding).await? {
        BlameSource::Ready(lines) => return Ok(lines),
        BlameSource::Git(target) => target,
    };
    let rel = target.rel.as_str();
    // The commit (resolved once, so a moving branch can't mix two states), the blob and – for the
    // working directory – the bytes already read.
    let (commit, rev_key, blob, bytes) = match &target.file {
        Some(file) => {
            let head = rev::resolve_commit(core, repo_id, "HEAD").await?;
            let bytes = tokio::fs::read(file).await?;
            // Exactly the bytes shown, without filters: two files that clean to the same blob differ.
            let blob = core.git_for(repo_id)?.args(["hash-object", "--stdin", "--no-filters"]).stdin(bytes.clone()).read().run().await?;
            (None, format!("worktree@{head}"), blob.stdout_text(), Some(bytes))
        }
        None => {
            let commit = rev::resolve_commit(core, repo_id, target.rev.as_deref().unwrap_or("HEAD")).await?;
            let blob = core.git_for(repo_id)?.args(["rev-parse", "--verify", "-q", &format!("{commit}:{rel}")]).read().run().await?;
            (Some(commit.clone()), commit, blob.stdout_text(), None)
        }
    };
    let key = BlameKey {
        repo_id: repo_id.to_string(),
        rev_key,
        rel: rel.to_string(),
        blob,
        encoding: format!("{}/{}", target.forced.map_or("", |e| e.name()), target.preferred),
    };
    let cache = core.state::<BlameCache>();
    if let Some(lines) = cache.get(&key) {
        let n = lines.len();
        job.progress(PHASE_BLAME, Some(100), &format!("{n}/{n}"));
        return Ok(lines.to_vec());
    }
    let bytes = match bytes {
        Some(bytes) => bytes,
        None => core.git_for(repo_id)?.args(["cat-file", "blob", &key.blob]).read().run().await?.stdout,
    };

    let mut raw: Vec<&[u8]> = bytes.split(|&b| b == b'\n').collect();
    if raw.last().is_some_and(|line| line.is_empty()) {
        raw.pop();
    }
    let text: Vec<String> =
        raw.iter().map(|line| decode_blame_line(line.strip_suffix(b"\r").unwrap_or(line), &target.preferred, target.forced)).collect();
    let mut chunks = Chunks::new(core, job, repo_id, text.len());
    chunks.emit(Some(text.clone()), Vec::new());

    let mut parser = IncrementalParser::default();
    let mut cmd = core.git_for(repo_id)?.args(["blame", "--incremental"]);
    if let Some(commit) = &commit {
        cmd = cmd.arg(commit);
    }
    cmd.args(["--", rel])
        .read_only()
        .run_records(b'\n', Some(job.token()), &mut |line| {
            if let Some(span) = parser.feed(line) {
                chunks.add(&span);
            }
            true
        })
        .await?;
    chunks.flush();
    job.token().check()?;

    let lines = match chunks.owners() {
        Some(owners) => text
            .into_iter()
            .zip(owners)
            .enumerate()
            .map(|(i, (text, span))| BlameLine {
                line_no: i as u32 + 1,
                text,
                sha: span.sha.clone(),
                author: span.author.clone(),
                authored_at: span.authored_at.clone(),
                summary: span.summary.clone(),
                uncommitted: span.uncommitted,
            })
            .collect(),
        // Git blamed other lines than the ones read (e.g. a clean filter changed them): Git's own text.
        None => file_blame(core, repo_id.to_string(), path.to_string(), sha.map(str::to_string), encoding.map(str::to_string)).await?,
    };
    // The fallback `file_blame` does not watch the token.
    job.token().check()?;
    let n = lines.len();
    job.progress(PHASE_BLAME, Some(100), &format!("{n}/{n}"));
    cache.put(key, Arc::new(lines.clone()));
    Ok(lines)
}

/// The spans found so far, which line belongs to which, and what still has to be sent.
struct Chunks<'a> {
    core: &'a Core,
    job: &'a Job,
    repo_id: &'a str,
    spans: Vec<BlameSpan>,
    /// Per line the index of its span; `None` = not assigned yet.
    owner: Vec<Option<usize>>,
    /// A line was assigned twice or lies beyond the end.
    gap: bool,
    done: u32,
    /// Spans before this index have been sent.
    sent: usize,
    pending_lines: u32,
    last_flush: Option<Instant>,
}

impl<'a> Chunks<'a> {
    fn new(core: &'a Core, job: &'a Job, repo_id: &'a str, total: usize) -> Self {
        let owner = vec![None; total];
        Chunks { core, job, repo_id, spans: Vec::new(), owner, gap: false, done: 0, sent: 0, pending_lines: 0, last_flush: None }
    }

    fn total(&self) -> u32 {
        self.owner.len() as u32
    }

    fn add(&mut self, span: &IncrementalSpan<'_>) {
        for line in span.final_start..span.final_start.saturating_add(span.count) {
            match line.checked_sub(1).and_then(|i| self.owner.get_mut(i as usize)) {
                Some(slot @ None) => *slot = Some(self.spans.len()),
                _ => self.gap = true,
            }
        }
        let uncommitted = span.sha.bytes().all(|b| b == b'0');
        let (author, summary) = if uncommitted {
            (Person { name: ZERO_AUTHOR.into(), email: String::new() }, ZERO_SUMMARY.to_string())
        } else {
            (Person { name: span.info.author.clone(), email: span.info.email.clone() }, span.info.summary.clone())
        };
        self.spans.push(BlameSpan {
            sha: span.sha.to_string(),
            start_line: span.final_start,
            count: span.count,
            author,
            authored_at: util::unix_to_iso(span.info.time),
            summary,
            uncommitted,
        });
        self.done = self.done.saturating_add(span.count).min(self.total());
        self.pending_lines = self.pending_lines.saturating_add(span.count);
        if self.last_flush.map_or(true, |t| t.elapsed() >= FLUSH_INTERVAL) || self.pending_lines >= FLUSH_LINES {
            self.flush();
        }
    }

    /// Sends the spans not sent yet, and the progress.
    fn flush(&mut self) {
        if self.sent == self.spans.len() {
            return;
        }
        let spans = self.spans[self.sent..].to_vec();
        self.sent = self.spans.len();
        self.pending_lines = 0;
        self.last_flush = Some(Instant::now());
        self.emit(None, spans);
        let (done, total) = (self.done, self.total());
        let percent = if total == 0 { 100 } else { (u64::from(done) * 100 / u64::from(total)) as u32 };
        self.job.progress(PHASE_BLAME, Some(percent), &format!("{done}/{total}"));
    }

    fn emit(&self, text: Option<Vec<String>>, spans: Vec<BlameSpan>) {
        let event = BlameChunkEvent {
            job_id: self.job.id().to_string(),
            repo_id: self.repo_id.to_string(),
            total: self.total(),
            done: self.done,
            text,
            spans,
        };
        if let Ok(v) = serde_json::to_value(event) {
            self.core.events.emit(names::BLAME_CHUNK, v);
        }
    }

    /// Each line's span, if Git assigned every line exactly once.
    fn owners(&self) -> Option<Vec<&BlameSpan>> {
        if self.gap {
            return None;
        }
        self.owner.iter().map(|o| o.map(|i| &self.spans[i])).collect()
    }
}

/// What a blame result depends on: the commit (or `worktree@<HEAD>`), the file's blob and the
/// encoding (forced / repository default), which changes the decoded text.
#[derive(PartialEq, Eq)]
struct BlameKey {
    repo_id: String,
    rev_key: String,
    rel: String,
    blob: String,
    encoding: String,
}

/// The last `BLAME_CACHE_SIZE` blame results, the most recently used last.
#[derive(Default)]
pub(crate) struct BlameCache {
    entries: Mutex<VecDeque<(BlameKey, Arc<Vec<BlameLine>>)>>,
}

impl BlameCache {
    fn get(&self, key: &BlameKey) -> Option<Arc<Vec<BlameLine>>> {
        let mut entries = self.entries.lock();
        let index = entries.iter().position(|(k, _)| k == key)?;
        let entry = entries.remove(index)?;
        let lines = entry.1.clone();
        entries.push_back(entry);
        Some(lines)
    }

    fn put(&self, key: BlameKey, lines: Arc<Vec<BlameLine>>) {
        let mut entries = self.entries.lock();
        entries.retain(|(k, _)| k != &key);
        entries.push_back((key, lines));
        while entries.len() > BLAME_CACHE_SIZE {
            entries.pop_front();
        }
    }
}
