//! File watching per open repository.
//!
//! Each repository gets a `notify` watcher (recursive on the working directory; for
//! worktrees and submodules also on the Git directory, which then lives elsewhere)
//! and a task that classifies the raw events, debounces them by 300 ms and reports them
//! as one `repo:changed` with the affected kinds:
//!
//! - working directory → `worktree`, but only for paths Git doesn't ignore
//!   (`git check-ignore --stdin -z`, batched per burst). Folders that turned out to be
//!   ignored (node_modules, target …) are remembered and from then on dropped right on
//!   arrival – so a build no longer triggers any Git calls at all. A new folder only
//!   counts if it contains something Git sees.
//! - `.git`: `index` → index, `HEAD` → head, `refs/**` and `packed-refs` → refs,
//!   `refs/stash` and `logs/refs/stash` → stash, `config` → config, MERGE_HEAD /
//!   CHERRY_PICK_HEAD / REVERT_HEAD / rebase-merge / rebase-apply / sequencer / BISECT_* →
//!   operation. A new folder there counts by its own path (its first files may come without
//!   events). Everything else there (objects, logs, lock files) is skipped.
//!
//! Callers: `commands::repos` calls `start_watching` as soon as a repository gets a tab,
//! and `stop_watching` when its last tab is closed or it is forgotten; src-tauri calls
//! `start_watching` for all open repo tabs at startup.
//!
//! In tests (and with the `testkit` feature) watching is switched off, so that not every
//! test that opens a repository gets background events. The watcher's own tests switch
//! it on with `set_enabled(core, true)` before opening.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use notify::{EventKind, RecursiveMode, Watcher};
use parking_lot::Mutex;
use tokio::sync::{mpsc, watch};
use tokio::time::Instant;

use crate::app::Core;
use crate::error::{CoreError, CoreResult};
use crate::jobs::CancelToken;
use crate::model::RepoChange;
use crate::util;

/// Once this many unchecked paths have piled up, they are checked against .gitignore right
/// away instead of after the quiet period. That way ignored folders are known early, and a
/// storm (build, package installation) doesn't pile up in the first place.
const EARLY_CHECK_PATHS: usize = 256;
/// If the watcher reports nothing but errors this many times in a row, watching stops
/// instead of flooding the UI with “everything might have changed”.
const MAX_ERRORS_IN_A_ROW: u32 = 20;

/// Watcher timings (can be shortened in tests via `set_timing`).
#[derive(Debug, Clone, Copy)]
pub struct WatchTiming {
    /// Quiet period after which collected changes are reported.
    pub debounce: Duration,
    /// Report at the latest this long after the first change, even if it doesn't quieten down.
    pub max_delay: Duration,
    /// Interval at which we check whether the folder still exists.
    pub liveness: Duration,
}

impl Default for WatchTiming {
    fn default() -> Self {
        WatchTiming { debounce: Duration::from_millis(300), max_delay: Duration::from_secs(2), liveness: Duration::from_secs(5) }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Phase {
    Starting,
    Watching,
    Stopped,
}

struct Running {
    generation: u64,
    stop: CancelToken,
    phase: watch::Receiver<Phase>,
}

/// Running watchers; stored via `core.state::<Watchers>()`.
pub struct Watchers {
    enabled: AtomicBool,
    next_generation: AtomicU64,
    timing: Mutex<WatchTiming>,
    running: Mutex<HashMap<String, Running>>,
}

impl Default for Watchers {
    fn default() -> Self {
        Watchers {
            enabled: AtomicBool::new(!cfg!(any(test, feature = "testkit"))),
            next_generation: AtomicU64::new(1),
            timing: Mutex::new(WatchTiming::default()),
            running: Mutex::new(HashMap::new()),
        }
    }
}

/// Switches watching on or off for future `start_watching` calls.
/// On in the app, off in tests.
pub fn set_enabled(core: &Core, enabled: bool) {
    core.state::<Watchers>().enabled.store(enabled, Ordering::SeqCst);
}

/// Changes the timings for watchers started afterwards.
pub fn set_timing(core: &Core, timing: WatchTiming) {
    *core.state::<Watchers>().timing.lock() = timing;
}

/// Whether the repository is being watched (or watching is just starting).
pub fn is_watching(core: &Core, repo_id: &str) -> bool {
    core.state::<Watchers>().running.lock().contains_key(repo_id)
}

/// Waits until watching really runs (the system's watcher is set up).
/// `false` if it wasn't started, failed, or `timeout` expires.
pub async fn wait_until_watching(core: &Core, repo_id: &str, timeout: Duration) -> bool {
    let Some(mut phase) = core.state::<Watchers>().running.lock().get(repo_id).map(|r| r.phase.clone()) else {
        return false;
    };
    let reached = tokio::time::timeout(timeout, async {
        loop {
            match *phase.borrow_and_update() {
                Phase::Watching => return true,
                Phase::Stopped => return false,
                Phase::Starting => {}
            }
            if phase.changed().await.is_err() {
                return false;
            }
        }
    })
    .await;
    reached.unwrap_or(false)
}

/// Starts watching the repository. Calling it repeatedly for the same ID is allowed.
/// Must be called from within a Tokio runtime.
pub fn start_watching(core: &Core, repo_id: &str) -> CoreResult<()> {
    let state = core.state::<Watchers>();
    if !state.enabled.load(Ordering::SeqCst) {
        return Ok(());
    }
    let root = core.repo_path(repo_id)?;
    let runtime = tokio::runtime::Handle::try_current()
        .map_err(|_| CoreError::unknown("File watching can only be started from the running app."))?;
    let timing = *state.timing.lock();
    let (generation, stop, phase_tx) = {
        let mut running = state.running.lock();
        if running.contains_key(repo_id) {
            return Ok(());
        }
        let generation = state.next_generation.fetch_add(1, Ordering::SeqCst);
        let stop = CancelToken::new();
        let (phase_tx, phase_rx) = watch::channel(Phase::Starting);
        running.insert(repo_id.to_string(), Running { generation, stop: stop.clone(), phase: phase_rx });
        (generation, stop, phase_tx)
    };
    let core = core.clone();
    let repo_id = repo_id.to_string();
    runtime.spawn(async move {
        if let Err(e) = watch_repo(&core, &repo_id, &root, timing, &stop, &phase_tx).await {
            log::warn!("File watching for {} stopped: {}", util::display_path(&root), e.message);
        }
        // Only remove our own entry: it may have been restarted in the meantime.
        let state = core.state::<Watchers>();
        let mut running = state.running.lock();
        if running.get(&repo_id).is_some_and(|r| r.generation == generation) {
            running.remove(&repo_id);
        }
        drop(running);
        phase_tx.send_replace(Phase::Stopped);
    });
    Ok(())
}

/// Stops watching. Unknown IDs are not an error.
pub fn stop_watching(core: &Core, repo_id: &str) -> CoreResult<()> {
    if let Some(running) = core.state::<Watchers>().running.lock().remove(repo_id) {
        running.stop.cancel();
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Classifying paths
// ---------------------------------------------------------------------------

/// Which files of a Git directory belong to this working directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum GitScope {
    /// Ordinary repository: everything lives in one `.git`.
    Whole,
    /// A worktree's own part (`<main>/.git/worktrees/<name>`): HEAD, index, state files.
    Private,
    /// Shared part (`<main>/.git`), as seen from a worktree: refs, config, stash.
    Shared,
}

/// What a change in the Git directory means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct GitHit {
    change: RepoChange,
    /// The change can affect what counts as ignored or tracked.
    affects_ignore: bool,
}

/// Classifies a path relative to the Git directory (with `/`); `None` = not of interest.
fn classify_git_path(rel: &str, scope: GitScope) -> Option<GitHit> {
    let hit = |change| Some(GitHit { change, affects_ignore: false });
    let name = rel.rsplit('/').next().unwrap_or(rel);
    if rel.is_empty() || name.ends_with(".lock") {
        return None;
    }
    let private = scope != GitScope::Shared;
    let shared = scope != GitScope::Private;
    let under = |dir: &str| rel == dir || rel.strip_prefix(dir).is_some_and(|rest| rest.starts_with('/'));
    match rel {
        "index" if private => return Some(GitHit { change: RepoChange::Index, affects_ignore: true }),
        "HEAD" if private => return hit(RepoChange::Head),
        "MERGE_HEAD" | "CHERRY_PICK_HEAD" | "REVERT_HEAD" if private => return hit(RepoChange::Operation),
        // A bisect (also one started in a terminal) lives in these files and in refs/bisect.
        "BISECT_START" | "BISECT_LOG" | "BISECT_TERMS" | "BISECT_NAMES" | "BISECT_EXPECTED_REV" | "BISECT_ANCESTORS_OK" if private => {
            return hit(RepoChange::Operation)
        }
        "packed-refs" if shared => return hit(RepoChange::Refs),
        "refs/stash" | "logs/refs/stash" if shared => return hit(RepoChange::Stash),
        "config" if shared => return Some(GitHit { change: RepoChange::Config, affects_ignore: true }),
        "info/exclude" if shared => return Some(GitHit { change: RepoChange::Worktree, affects_ignore: true }),
        _ => {}
    }
    if private && (under("rebase-merge") || under("rebase-apply") || under("sequencer")) {
        return hit(RepoChange::Operation);
    }
    // refs/bisect belongs to the worktree, not to the shared part.
    if private && under("refs/bisect") {
        return hit(RepoChange::Refs);
    }
    if shared && under("refs") && !under("refs/forkyard") {
        return hit(RepoChange::Refs);
    }
    // State of a submodule: shows up in the status of the enclosing repository.
    if shared && under("modules") && (name == "HEAD" || name == "index") {
        return hit(RepoChange::Worktree);
    }
    None
}

/// Path relative to `base` as bytes with `/`; `None` if it isn't below it.
fn rel_bytes(base: &Path, path: &Path) -> Option<Vec<u8>> {
    let rel = path.strip_prefix(base).ok()?;
    let mut out: Vec<u8> = Vec::new();
    for part in rel.components() {
        if let std::path::Component::Normal(name) = part {
            if !out.is_empty() {
                out.push(b'/');
            }
            out.extend_from_slice(&util::path_to_bytes(Path::new(name)));
        }
    }
    Some(out)
}

/// A Git directory outside the working directory (worktree, submodule).
#[derive(Debug, Clone)]
struct GitRoot {
    path: PathBuf,
    scope: GitScope,
}

/// What has accumulated since the last report.
#[derive(Default)]
struct Pending {
    kinds: BTreeSet<RepoChange>,
    /// Changed files in the working directory that still need to be checked against .gitignore.
    paths: BTreeSet<Vec<u8>>,
    /// Newly created or moved-in folders: only count if they contain something Git sees.
    new_dirs: BTreeSet<Vec<u8>>,
    /// The watcher lost events: anything may have changed.
    rescan: bool,
}

impl Pending {
    fn is_empty(&self) -> bool {
        self.kinds.is_empty() && self.unchecked() == 0 && !self.rescan
    }
    /// Number of paths that still need to be checked against .gitignore.
    fn unchecked(&self) -> usize {
        self.paths.len() + self.new_dirs.len()
    }
}

/// Classifies raw events and remembers ignored folders.
struct Intake {
    root: PathBuf,
    /// `false`: `.git` in the working directory is just a file, the Git directory lives elsewhere.
    git_inside: bool,
    git_roots: Vec<GitRoot>,
    /// Folders (relative, with `/`) that Git ignores. `git check-ignore` only reports a folder
    /// as ignored if nothing in it is tracked – so everything below it is of no interest.
    ignored_dirs: HashSet<Vec<u8>>,
    pending: Pending,
}

impl Intake {
    fn new(root: PathBuf, git_inside: bool, git_roots: Vec<GitRoot>) -> Self {
        Intake { root, git_inside, git_roots, ignored_dirs: HashSet::new(), pending: Pending::default() }
    }

    fn forget_ignore_cache(&mut self) {
        self.ignored_dirs.clear();
    }

    /// `path` is the full path: reports about changed folders (Windows also reports the folder
    /// when something is created in it) are skipped – the file inside comes as its own event.
    /// A folder that appears (`appears`) counts by its own path, though: the recursive watcher
    /// only starts watching it after its creation was reported, so files written into it right
    /// away (`refs/bisect/bad` from the first `git bisect bad`, the first `refs/heads/feature/x`)
    /// can come without an event of their own.
    fn git_change(&mut self, path: &Path, rel: &[u8], scope: GitScope, appears: bool) -> bool {
        if path.is_dir() && !appears {
            return false;
        }
        let Some(hit) = classify_git_path(&util::decode_lossy(rel), scope) else { return false };
        self.pending.kinds.insert(hit.change);
        if hit.affects_ignore {
            self.forget_ignore_cache();
        }
        true
    }

    /// Takes in a raw event. `true` if it contained something worth reporting (the quiet
    /// period then restarts); accesses, uninteresting and known-ignored paths don't count.
    fn absorb(&mut self, event: &notify::Event) -> bool {
        if matches!(event.kind, EventKind::Access(_)) {
            return false;
        }
        let mut relevant = false;
        if event.need_rescan() {
            self.pending.rescan = true;
            relevant = true;
        }
        // A folder can appear as a whole (created, renamed, moved in) without its files
        // getting events of their own.
        let appears = matches!(event.kind, EventKind::Create(_) | EventKind::Modify(notify::event::ModifyKind::Name(_)) | EventKind::Any | EventKind::Other);
        for path in &event.paths {
            relevant |= self.absorb_path(path, appears);
        }
        relevant
    }

    /// `appears`: the event can mean that the path is newly there.
    fn absorb_path(&mut self, path: &Path, appears: bool) -> bool {
        for i in 0..self.git_roots.len() {
            if let Some(rel) = rel_bytes(&self.git_roots[i].path, path) {
                let scope = self.git_roots[i].scope;
                return self.git_change(path, &rel, scope, appears);
            }
        }
        let Some(rel) = rel_bytes(&self.root, path) else { return false };
        if rel.is_empty() {
            return false;
        }
        let mut parts = rel.split(|&b| b == b'/');
        let first = parts.next().unwrap_or_default();
        if first == b".git" {
            return self.git_inside && rel.len() > 5 && self.git_change(path, &rel[5..], GitScope::Whole, appears);
        }
        // Nested repository (submodule, unrelated clone): only its HEAD, index and refs count,
        // namely as a change to the folder it lives in.
        if let Some(pos) = find_git_component(&rel) {
            let inner = util::decode_lossy(&rel[pos + 5..]);
            let relevant = matches!(classify_git_path(&inner, GitScope::Whole), Some(hit) if matches!(hit.change, RepoChange::Head | RepoChange::Index | RepoChange::Refs));
            let nested = rel[..pos - 1].to_vec();
            return relevant && !path.is_dir() && !self.is_known_ignored(&nested) && self.candidate(nested, false);
        }
        match rel.rsplit(|&b| b == b'/').next() {
            // The link file of a nested repository itself.
            Some(b".git") => return false,
            Some(b".gitignore") => self.forget_ignore_cache(),
            _ => {}
        }
        if self.is_known_ignored(&rel) {
            return false;
        }
        if path.is_dir() {
            // Changed folder: its files report themselves. Only a newly appeared one counts.
            return appears && self.candidate(rel, true);
        }
        self.candidate(rel, false)
    }

    fn is_known_ignored(&self, rel: &[u8]) -> bool {
        self.ignored_dirs.contains(rel) || ancestors(rel).any(|dir| self.ignored_dirs.contains(dir))
    }

    /// Queues a path in the working directory for checking. If `worktree` is already settled
    /// for this burst, nothing more is collected.
    fn candidate(&mut self, rel: Vec<u8>, is_new_dir: bool) -> bool {
        if !self.pending.kinds.contains(&RepoChange::Worktree) {
            if is_new_dir {
                self.pending.new_dirs.insert(rel);
            } else {
                self.pending.paths.insert(rel);
            }
        }
        true
    }
}

/// Position after a `/` where a path component `.git` starts (not at the start of the path).
fn find_git_component(rel: &[u8]) -> Option<usize> {
    let mut start = 0;
    for (i, part) in rel.split(|&b| b == b'/').enumerate() {
        if i > 0 && part == b".git" && rel.len() > start + 5 {
            return Some(start);
        }
        start += part.len() + 1;
    }
    None
}

/// All parent folders of a relative path, topmost first: `a/b/c` → `a`, `a/b`.
fn ancestors(rel: &[u8]) -> impl Iterator<Item = &[u8]> {
    rel.iter().enumerate().filter(|(_, &b)| b == b'/').map(move |(i, _)| &rel[..i])
}

// ---------------------------------------------------------------------------
// Watching one repository
// ---------------------------------------------------------------------------

/// Git directory and common Git directory as Git reports them (same spelling).
async fn git_dirs(core: &Core, root: &Path) -> CoreResult<(PathBuf, PathBuf)> {
    let out = core
        .git_at(root)
        .args(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"])
        .read_only()
        .no_log()
        .run()
        .await?;
    let lines = out.stdout_lines();
    let dir = |i: usize| lines.get(i).map(|l| util::native_path(&util::bytes_to_path(l)));
    match (dir(0), dir(1)) {
        (Some(git_dir), Some(common)) => Ok((git_dir, common)),
        _ => Err(CoreError::unknown("The Git directory couldn’t be determined.")),
    }
}

async fn watch_repo(
    core: &Core,
    repo_id: &str,
    root: &Path,
    timing: WatchTiming,
    stop: &CancelToken,
    phase: &watch::Sender<Phase>,
) -> CoreResult<()> {
    // macOS reports paths in their resolved form (/private/var instead of /var).
    let resolved = |path: &Path| if cfg!(target_os = "macos") { path.canonicalize().unwrap_or_else(|_| path.to_path_buf()) } else { path.to_path_buf() };
    let root = &resolved(root);
    let git_inside = root.join(".git").is_dir();
    let mut git_roots: Vec<GitRoot> = Vec::new();
    if !git_inside {
        let (git_dir, common) = git_dirs(core, root).await?;
        let (git_dir, common) = (resolved(&git_dir), resolved(&common));
        if git_dir == common {
            git_roots.push(GitRoot { path: git_dir, scope: GitScope::Whole });
        } else {
            // Own part first: it usually lives below the common one and must match first.
            git_roots.push(GitRoot { path: git_dir, scope: GitScope::Private });
            git_roots.push(GitRoot { path: common, scope: GitScope::Shared });
        }
    }

    let (tx, mut rx) = mpsc::unbounded_channel::<notify::Result<notify::Event>>();
    let failed = |e: notify::Error| CoreError::io(format!("File watching couldn’t be set up: {e}"));
    let mut watcher = notify::recommended_watcher(move |event| {
        let _ = tx.send(event);
    })
    .map_err(failed)?;
    watcher.watch(root, RecursiveMode::Recursive).map_err(failed)?;
    // Shortest paths first: if a directory lies below one already watched (a worktree's own
    // part below the common one), watching that one is enough.
    let mut outside: Vec<&Path> = git_roots.iter().map(|g| g.path.as_path()).collect();
    outside.sort_by_key(|path| path.components().count());
    let mut watched: Vec<&Path> = vec![root.as_path()];
    for path in outside {
        if !watched.iter().any(|w| path.starts_with(w)) {
            watcher.watch(path, RecursiveMode::Recursive).map_err(failed)?;
            watched.push(path);
        }
    }
    let mut intake = Intake::new(root.to_path_buf(), git_inside, git_roots.clone());
    phase.send_replace(Phase::Watching);

    let mut first_at: Option<Instant> = None;
    let mut last_at = Instant::now();
    let mut errors_in_a_row = 0u32;
    let mut liveness = tokio::time::interval(timing.liveness.max(Duration::from_millis(10)));
    liveness.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        let due = first_at.map(|first| (last_at + timing.debounce).min(first + timing.max_delay));
        tokio::select! {
            _ = stop.cancelled() => return Ok(()),
            message = rx.recv() => {
                let relevant = match message {
                    None => return Ok(()),
                    Some(Ok(event)) => {
                        errors_in_a_row = 0;
                        intake.absorb(&event)
                    }
                    // Watcher error (e.g. overflow): better to report once too often.
                    Some(Err(e)) => {
                        errors_in_a_row += 1;
                        if errors_in_a_row > MAX_ERRORS_IN_A_ROW {
                            return Err(CoreError::io(format!("The system’s file watcher keeps reporting errors: {e}")));
                        }
                        intake.pending.rescan = true;
                        true
                    }
                };
                if intake.pending.unchecked() >= EARLY_CHECK_PATHS {
                    check_paths(core, &mut intake).await;
                }
                if intake.pending.is_empty() {
                    // Nothing pending (everything was ignored): nothing to report.
                    first_at = None;
                } else if relevant {
                    last_at = Instant::now();
                    first_at.get_or_insert(last_at);
                }
            }
            _ = sleep_until_due(due) => {
                first_at = None;
                if !root.is_dir() {
                    break;
                }
                flush(core, repo_id, &mut intake).await;
            }
            _ = liveness.tick() => {
                if !root.is_dir() {
                    break;
                }
            }
        }
    }
    // The folder has disappeared: report once so the UI notices, then stop.
    core.emit_repo_changed(repo_id, &[RepoChange::Worktree]);
    Ok(())
}

async fn sleep_until_due(due: Option<Instant>) {
    match due {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

/// Checks the queued paths against .gitignore. Afterwards they are done: either `worktree`
/// is settled, or all of them were ignored.
async fn check_paths(core: &Core, intake: &mut Intake) {
    let paths = std::mem::take(&mut intake.pending.paths);
    let new_dirs = std::mem::take(&mut intake.pending.new_dirs);
    if (!paths.is_empty() || !new_dirs.is_empty()) && has_visible_change(core, intake, &paths, &new_dirs).await {
        intake.pending.kinds.insert(RepoChange::Worktree);
    }
}

/// Reports what has accumulated – one event for the whole burst.
async fn flush(core: &Core, repo_id: &str, intake: &mut Intake) {
    check_paths(core, intake).await;
    let pending = std::mem::take(&mut intake.pending);
    let mut kinds = pending.kinds;
    if pending.rescan {
        intake.forget_ignore_cache();
        kinds.extend([RepoChange::Worktree, RepoChange::Index, RepoChange::Refs, RepoChange::Head]);
    }
    if !kinds.is_empty() {
        let kinds: Vec<RepoChange> = kinds.into_iter().collect();
        core.emit_repo_changed(repo_id, &kinds);
    }
}

/// Asks Git which of the paths are ignored and remembers ignored folders.
/// `true` if something changed that Git sees: a non-ignored file, or a new folder with
/// visible content. If Git can't answer, the change counts as visible.
async fn has_visible_change(core: &Core, intake: &mut Intake, paths: &BTreeSet<Vec<u8>>, new_dirs: &BTreeSet<Vec<u8>>) -> bool {
    // The paths themselves and their parent folders in one request.
    let mut dirs: BTreeSet<&[u8]> = new_dirs.iter().map(Vec::as_slice).collect();
    for path in paths.iter().chain(new_dirs) {
        dirs.extend(ancestors(path));
    }
    let mut asked: BTreeSet<&[u8]> = paths.iter().map(Vec::as_slice).collect();
    asked.extend(dirs.iter().copied());
    let mut input: Vec<u8> = Vec::new();
    for path in &asked {
        // A leading `:` would be taken by Git as pathspec magic (and check-ignore doesn't know `literal`).
        if path.first() == Some(&b':') {
            input.extend_from_slice(b"./");
        }
        input.extend_from_slice(path);
        input.push(0);
    }
    let out = core.git_at(&intake.root).args(["check-ignore", "-z", "--stdin"]).stdin(input).read_only().no_log().run_raw().await;
    let out = match out {
        // Exit 0: at least one ignored; 1: none; anything else is an error.
        Ok(out) if matches!(out.code, Some(0) | Some(1)) => out,
        _ => return true,
    };
    let ignored: HashSet<&[u8]> = util::split_z(&out.stdout).map(|p| p.strip_prefix(b"./").unwrap_or(p)).collect();

    // Remember the topmost ignored folders. Git never reports a folder with tracked files as
    // ignored, so nothing visible can lie below a remembered folder.
    for dir in &dirs {
        if ignored.contains(dir) && !ancestors(dir).any(|up| ignored.contains(up)) {
            intake.ignored_dirs.insert(dir.to_vec());
        }
    }
    if paths.iter().any(|p| !ignored.contains(p.as_slice())) {
        return true;
    }
    let candidates: Vec<&Vec<u8>> = new_dirs.iter().filter(|dir| !ignored.contains(dir.as_slice())).collect();
    !candidates.is_empty() && dirs_have_visible_content(core, &intake.root, &candidates).await
}

/// Whether one of the folders contains something that shows up in the status: a tracked file
/// or an untracked one that isn't ignored. An empty folder, or one with only ignored content
/// (a build creates `target/`), is invisible to Git.
async fn dirs_have_visible_content(core: &Core, root: &Path, dirs: &[&Vec<u8>]) -> bool {
    let mut found = false;
    let listing = core
        .git_at(root)
        .env("GIT_LITERAL_PATHSPECS", "1")
        .args(["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--directory", "--no-empty-directory", "--"])
        .args(dirs.iter().map(|dir| util::bytes_to_os(dir)))
        .read_only()
        .no_log()
        .run_records(0, None, &mut |_| {
            found = true;
            false
        })
        .await;
    found || listing.is_err()
}

#[cfg(test)]
mod tests;
