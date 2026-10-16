//! Collision warning between coding agents (cockpit, package 2b).
//!
//! After a change in an agent's worktree (debounced), the core takes a snapshot of every agent's
//! worktree as a tree (temporary `GIT_INDEX_FILE`, `add -A`, `write-tree` – `undo::worktree_tree`)
//! and wraps it in a loose commit (`commit-tree`, parent = the worktree's HEAD, no ref). Every pair
//! of agents whose changed files intersect is merged with `git merge-tree --write-tree`; so is each
//! agent with the current tip of its base. Conflicts carry the line ranges of the conflict markers.
//! Nothing in a working directory, an index or the refs changes; every Git call is a background
//! read (`GIT_OPTIONAL_LOCKS=0`, not in the activity log).

use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::time::Instant;

use crate::app::Core;
use crate::commands::preview::{self, Merged, MergedConflict};
use crate::db;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::events::names;
use crate::git::{redact, GitCmd};
use crate::jobs::CancelToken;
use crate::model::{Agent, AgentCollision, AgentStatus, CollisionCheckState, CollisionFile, CollisionKind, CollisionReport, CollisionSkip, RepoChange};
use crate::undo;
use crate::util;

/// Message of the snapshot commits (never on a ref, never shown).
pub const SNAPSHOT_MESSAGE: &str = "forkyard: collision check";
/// Identity of the snapshot commits, so they work without user.name/user.email.
const SNAPSHOT_IDENTITY: [(&str, &str); 4] = [
    ("GIT_AUTHOR_NAME", "forkyard"),
    ("GIT_AUTHOR_EMAIL", "forkyard@localhost"),
    ("GIT_COMMITTER_NAME", "forkyard"),
    ("GIT_COMMITTER_EMAIL", "forkyard@localhost"),
];

/// A background read in `repo_id` (the main repository or an agent's worktree).
fn read(core: &Core, repo_id: &str) -> CoreResult<GitCmd> {
    Ok(core.git_for(repo_id)?.read_only().no_log())
}

/// Snapshot of an agent's worktree: the tree of its files as they are on disk (tracked and
/// untracked, not ignored; built on a temporary index, the real one stays untouched) and a loose
/// commit around it whose parent is the worktree's HEAD. Returns `(commit, tree)`.
pub(crate) async fn snapshot_commit(core: &Core, worktree_repo_id: &str) -> CoreResult<(String, String)> {
    let tree = undo::worktree_tree(core, worktree_repo_id, None).await?;
    let head = undo::rev_parse(core, worktree_repo_id, "HEAD^{commit}").await?;
    let mut cmd = read(core, worktree_repo_id)?.args(["commit-tree", "--no-gpg-sign", &tree]);
    if let Some(head) = &head {
        cmd = cmd.args(["-p", head]);
    }
    for (key, value) in SNAPSHOT_IDENTITY {
        cmd = cmd.env(key, value);
    }
    let commit = cmd.args(["-m", SNAPSHOT_MESSAGE]).run_text().await?;
    Ok((commit, tree))
}

/// Where the agent's work starts, and the current tip of its base. The fork is the merge base of
/// the worktree's HEAD and the base tip (a rebase onto a newer base moves it along); without a
/// resolvable base, or without a merge base, it is the recorded `base_sha`. `(fork, tip)`.
pub(crate) async fn fork_point(core: &Core, repo_id: &str, head: &str, base: &str, base_sha: &str) -> CoreResult<(String, Option<String>)> {
    let base = base.trim();
    let tip = if base.is_empty() { None } else { undo::rev_parse(core, repo_id, &format!("{base}^{{commit}}")).await? };
    let Some(tip) = tip else {
        return Ok((base_sha.to_string(), None));
    };
    let out = read(core, repo_id)?.args(["merge-base", head, &tip]).run_raw().await?;
    let fork = if out.success() { out.stdout_text().trim().to_string() } else { String::new() };
    Ok((if fork.is_empty() { base_sha.to_string() } else { fork }, Some(tip)))
}

/// Paths that differ between two trees (or commits), renames as delete + add, byte for byte.
pub(crate) async fn changed_paths(core: &Core, repo_id: &str, from: &str, to: &str) -> CoreResult<BTreeSet<Vec<u8>>> {
    let out = read(core, repo_id)?.args(["diff-tree", "-r", "-z", "--name-only", "--no-renames", from, to]).run().await?;
    Ok(util::split_z(&out.stdout).filter(|path| !path.is_empty()).map(<[u8]>::to_vec).collect())
}

/// Second half of the id of a collision with the base tip: `<agent>+base`.
pub const BASE_SUFFIX: &str = "base";

/// Result tree of a conflict and its files (display path → bytes); the preview reads from it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct StoredConflict {
    pub tree: String,
    pub files: Vec<(String, Vec<u8>)>,
}

/// What one check found.
#[derive(Debug, Default)]
pub(crate) struct Computed {
    pub collisions: Vec<AgentCollision>,
    pub skipped: Vec<CollisionSkip>,
    /// By collision id, only for conflicts.
    pub stored: HashMap<String, StoredConflict>,
}

/// An agent ready for comparing.
struct Prepared {
    agent: Agent,
    commit: String,
    fork: String,
    tip: Option<String>,
    changed: BTreeSet<Vec<u8>>,
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(7)]
}

async fn prepare(core: &Core, repo_id: &str, agent: Agent) -> CoreResult<Prepared> {
    let Some(worktree) = agent.worktree_repo_id.clone() else {
        return Err(CoreError::not_found("The agent's worktree is missing."));
    };
    if undo::rev_parse(core, repo_id, &format!("{}^{{commit}}", agent.base_sha)).await?.is_none() {
        return Err(CoreError::not_found(format!("The base commit {} of the agent no longer exists.", short(&agent.base_sha))));
    }
    let (commit, tree) = snapshot_commit(core, &worktree).await?;
    let head = undo::rev_parse(core, &worktree, "HEAD^{commit}").await?.unwrap_or_else(|| agent.base_sha.clone());
    let (fork, tip) = fork_point(core, repo_id, &head, &agent.base, &agent.base_sha).await?;
    let changed = changed_paths(core, repo_id, &fork, &tree).await?;
    Ok(Prepared { agent, commit, fork, tip, changed })
}

impl Computed {
    fn add(&mut self, id: String, agent_id: &str, other: Option<&str>, base: Option<&str>, merged: Merged, shared: &[Vec<u8>]) {
        let (kind, files): (CollisionKind, Vec<CollisionFile>) = match merged {
            Merged::Tree(_) => (
                CollisionKind::Overlap,
                shared.iter().map(|path| CollisionFile { path: util::decode_lossy(path), conflict: false, ranges: Vec::new() }).collect(),
            ),
            Merged::Conflicts { tree, files } => {
                // Git names no file (only messages): the shared files stand for the conflict.
                let files: Vec<MergedConflict> = if files.is_empty() {
                    shared.iter().map(|path| MergedConflict { path: util::decode_lossy(path), raw_path: path.clone(), ranges: Vec::new() }).collect()
                } else {
                    files
                };
                self.stored.insert(id.clone(), StoredConflict { tree, files: files.iter().map(|file| (file.path.clone(), file.raw_path.clone())).collect() });
                (CollisionKind::Conflict, files.into_iter().map(|file| CollisionFile { path: file.path, conflict: true, ranges: file.ranges }).collect())
            }
        };
        self.collisions.push(AgentCollision { id, kind, agent_id: agent_id.to_string(), other_agent_id: other.map(str::to_string), base: base.map(str::to_string), files });
    }
}

/// Compares the repository's present agents with each other (pairs whose changed files intersect)
/// and each with the current tip of its base. Orphaned agents are left out; an agent whose
/// worktree or base cannot be read is named in `skipped`. Conflicts come first.
pub(crate) async fn compute(core: &Core, repo_id: &str, cancel: &CancelToken) -> CoreResult<Computed> {
    core.repo_path(repo_id)?;
    let rows = core.db.with(|c| db::agents::list_for_repo(c, repo_id))?;
    let mut agents = Vec::with_capacity(rows.len());
    for row in &rows {
        agents.push(super::describe(core, row).await);
    }
    agents.retain(|agent| agent.status != AgentStatus::Orphaned && agent.worktree_repo_id.is_some());
    agents.sort_by(|a, b| a.started_at.cmp(&b.started_at).then_with(|| a.id.cmp(&b.id)));

    let mut computed = Computed::default();
    let mut ready: Vec<Prepared> = Vec::with_capacity(agents.len());
    for agent in agents {
        cancel.check()?;
        let agent_id = agent.id.clone();
        match prepare(core, repo_id, agent).await {
            Ok(prepared) => ready.push(prepared),
            Err(e) if matches!(e.code, ErrorCode::Cancelled | ErrorCode::RepoUntrusted) => return Err(e),
            // The reason goes to the UI and into events: redacted like every error text.
            Err(e) => computed.skipped.push(CollisionSkip { agent_id, reason: crate::git::redact::redact(&e.message) }),
        }
    }

    let explicit_base = core.git.info()?.version >= preview::MERGE_BASE_OPTION;
    for (index, first) in ready.iter().enumerate() {
        for second in &ready[index + 1..] {
            let shared: Vec<Vec<u8>> = first.changed.intersection(&second.changed).cloned().collect();
            if shared.is_empty() {
                continue;
            }
            cancel.check()?;
            let base = (explicit_base && first.fork == second.fork).then_some(first.fork.as_str());
            let merged = preview::merge_tree(core, repo_id, cancel, base, &first.commit, &second.commit, true).await?;
            computed.add(format!("{}+{}", first.agent.id, second.agent.id), &first.agent.id, Some(&second.agent.id), None, merged, &shared);
        }
    }

    let mut base_changes: HashMap<(String, String), BTreeSet<Vec<u8>>> = HashMap::new();
    for prepared in &ready {
        let Some(tip) = prepared.tip.as_deref().filter(|tip| *tip != prepared.fork) else {
            continue;
        };
        let key = (prepared.fork.clone(), tip.to_string());
        let changed = match base_changes.get(&key) {
            Some(changed) => changed.clone(),
            None => {
                let changed = changed_paths(core, repo_id, &prepared.fork, tip).await?;
                base_changes.insert(key, changed.clone());
                changed
            }
        };
        let shared: Vec<Vec<u8>> = prepared.changed.intersection(&changed).cloned().collect();
        if shared.is_empty() {
            continue;
        }
        cancel.check()?;
        let base = explicit_base.then_some(prepared.fork.as_str());
        let merged = preview::merge_tree(core, repo_id, cancel, base, &prepared.commit, tip, true).await?;
        computed.add(format!("{}+{BASE_SUFFIX}", prepared.agent.id), &prepared.agent.id, None, Some(&prepared.agent.base), merged, &shared);
    }
    computed.collisions.sort_by_key(|collision| collision.kind == CollisionKind::Overlap);
    Ok(computed)
}

// ---------------------------------------------------------------------------
// When to check: debounce, one check at a time, the report
// ---------------------------------------------------------------------------

/// Timings of the collision check (shortened in tests with `set_timing`).
#[derive(Debug, Clone, Copy)]
pub struct CollisionTiming {
    /// Quiet period after the last change before the check runs.
    pub debounce: Duration,
    /// At the latest this long after the first change, even if changes keep coming.
    pub max_delay: Duration,
}

impl Default for CollisionTiming {
    fn default() -> Self {
        CollisionTiming { debounce: Duration::from_secs(10), max_delay: Duration::from_secs(60) }
    }
}

#[derive(Default)]
struct RepoState {
    report: CollisionReport,
    stored: HashMap<String, StoredConflict>,
    /// Present agents at the last `track` (a change of the set checks right away).
    agents: BTreeSet<String>,
    due: Option<Instant>,
    first: Option<Instant>,
    timer: bool,
}

/// State of the collision check, via `core.state::<CollisionWatch>()`. In memory only.
pub struct CollisionWatch {
    enabled: AtomicBool,
    timing: Mutex<CollisionTiming>,
    repos: Mutex<HashMap<String, RepoState>>,
    /// Agent worktree repository → the repository the agent belongs to.
    owners: Mutex<HashMap<String, String>>,
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    checks: AtomicU64,
    active: AtomicU32,
    peak: AtomicU32,
}

impl Default for CollisionWatch {
    fn default() -> Self {
        CollisionWatch {
            enabled: AtomicBool::new(!cfg!(any(test, feature = "testkit"))),
            timing: Mutex::new(CollisionTiming::default()),
            repos: Mutex::new(HashMap::new()),
            owners: Mutex::new(HashMap::new()),
            locks: Mutex::new(HashMap::new()),
            checks: AtomicU64::new(0),
            active: AtomicU32::new(0),
            peak: AtomicU32::new(0),
        }
    }
}

impl CollisionWatch {
    fn lock_for(&self, repo_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.locks.lock().entry(repo_id.to_string()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone()
    }

    fn update(&self, repo_id: &str, change: impl FnOnce(&mut RepoState)) -> CollisionReport {
        let mut repos = self.repos.lock();
        let state = repos.entry(repo_id.to_string()).or_default();
        change(state);
        state.report.repo_id = repo_id.to_string();
        state.report.clone()
    }

    fn has_agents(&self, repo_id: &str) -> bool {
        self.repos.lock().get(repo_id).is_some_and(|state| !state.agents.is_empty())
    }
}

/// Switches the automatic check on or off (on in the app, off in tests).
pub fn set_enabled(core: &Core, enabled: bool) {
    core.state::<CollisionWatch>().enabled.store(enabled, Ordering::SeqCst);
}

pub fn set_timing(core: &Core, timing: CollisionTiming) {
    *core.state::<CollisionWatch>().timing.lock() = timing;
}

/// Checks finished since the start (all repositories).
pub fn checks_run(core: &Core) -> u64 {
    core.state::<CollisionWatch>().checks.load(Ordering::SeqCst)
}

/// Most checks that ever ran at the same time, over all repositories (tests use one repository,
/// where it must stay 1).
pub fn peak_parallel(core: &Core) -> u32 {
    core.state::<CollisionWatch>().peak.load(Ordering::SeqCst)
}

/// The last report of the repository (`pending` before the first check).
pub fn report(core: &Core, repo_id: &str) -> CollisionReport {
    core.state::<CollisionWatch>().update(repo_id, |_| {})
}

/// Remembers which worktree belongs to which repository (from `agent_list`); a changed set of
/// present agents (started, cleaned up, brought back) is checked right away.
pub(crate) fn track(core: &Core, repo_id: &str, agents: &[Agent]) {
    let watch = core.state::<CollisionWatch>();
    let present: Vec<&Agent> = agents.iter().filter(|agent| agent.status != AgentStatus::Orphaned && agent.worktree_repo_id.is_some()).collect();
    {
        let mut owners = watch.owners.lock();
        owners.retain(|_, owner| owner != repo_id);
        for agent in &present {
            if let Some(worktree) = &agent.worktree_repo_id {
                owners.insert(worktree.clone(), repo_id.to_string());
            }
        }
    }
    let ids: BTreeSet<String> = present.iter().map(|agent| agent.id.clone()).collect();
    let changed = {
        let mut repos = watch.repos.lock();
        let state = repos.entry(repo_id.to_string()).or_default();
        let changed = state.agents != ids;
        state.agents = ids;
        changed
    };
    if changed {
        check_soon(core, repo_id);
    }
}

/// Called for every `repo:changed`: a change in an agent's worktree, or of the refs of a
/// repository with agents, schedules the check of that repository (debounced).
pub fn note_change(core: &Core, repo_id: &str, what: &[RepoChange]) {
    let watch = core.state::<CollisionWatch>();
    if !watch.enabled.load(Ordering::SeqCst) {
        return;
    }
    let tree_moved = what.iter().any(|change| matches!(change, RepoChange::Worktree | RepoChange::Index | RepoChange::Head | RepoChange::Refs));
    let refs_moved = what.iter().any(|change| matches!(change, RepoChange::Head | RepoChange::Refs));
    let owner = watch.owners.lock().get(repo_id).cloned();
    let target = match owner {
        Some(main) if tree_moved => main,
        None if refs_moved && watch.has_agents(repo_id) => repo_id.to_string(),
        _ => return,
    };
    let debounce = watch.timing.lock().debounce;
    schedule(core, &target, debounce);
}

/// Checks the repository as soon as possible (no debounce) – if the automatic check is on.
pub(crate) fn check_soon(core: &Core, repo_id: &str) {
    if core.state::<CollisionWatch>().enabled.load(Ordering::SeqCst) {
        schedule(core, repo_id, Duration::ZERO);
    }
}

fn schedule(core: &Core, repo_id: &str, delay: Duration) {
    let Ok(handle) = tokio::runtime::Handle::try_current() else { return };
    let watch = core.state::<CollisionWatch>();
    let now = Instant::now();
    let spawn = {
        let mut repos = watch.repos.lock();
        let state = repos.entry(repo_id.to_string()).or_default();
        state.due = Some(now + delay);
        state.first.get_or_insert(now);
        !std::mem::replace(&mut state.timer, true)
    };
    if spawn {
        handle.spawn(timer(core.clone(), repo_id.to_string()));
    }
}

/// One timer per repository: waits for the quiet period (at the latest `max_delay` after the
/// first change), checks, and goes on while changes came in during the check.
async fn timer(core: Core, repo_id: String) {
    let watch = core.state::<CollisionWatch>();
    loop {
        loop {
            let max_delay = watch.timing.lock().max_delay;
            let at = {
                let repos = watch.repos.lock();
                let Some(state) = repos.get(&repo_id) else { return };
                match (state.due, state.first) {
                    (Some(due), Some(first)) => due.min(first + max_delay),
                    _ => break,
                }
            };
            if Instant::now() >= at {
                break;
            }
            tokio::time::sleep_until(at).await;
        }
        if let Some(state) = watch.repos.lock().get_mut(&repo_id) {
            state.due = None;
            state.first = None;
        }
        if let Err(e) = run_check(&core, &repo_id).await {
            log::warn!("collision check of {repo_id} not run: {}", redact::redact(&e.message));
        }
        let again = match watch.repos.lock().get_mut(&repo_id) {
            Some(state) if state.due.is_some() => true,
            Some(state) => {
                state.timer = false;
                false
            }
            None => false,
        };
        if !again {
            return;
        }
    }
}

/// Runs one check now (waits for a running one of the same repository), stores and reports it.
/// A failure becomes the state `failed` of the report.
pub(crate) async fn run_check(core: &Core, repo_id: &str) -> CoreResult<CollisionReport> {
    let watch = core.state::<CollisionWatch>();
    let lock = watch.lock_for(repo_id);
    let _guard = lock.lock().await;
    let active = watch.active.fetch_add(1, Ordering::SeqCst) + 1;
    watch.peak.fetch_max(active, Ordering::SeqCst);
    let checking = watch.update(repo_id, |state| state.report.state = CollisionCheckState::Checking);
    core.emit(names::AGENT_COLLISIONS, &checking);
    let outcome = compute(core, repo_id, &CancelToken::new()).await;
    let report = watch.update(repo_id, |state| {
        state.report.checked_at = Some(util::now_iso());
        match outcome {
            Ok(computed) => {
                state.report.state = CollisionCheckState::Done;
                state.report.error = None;
                state.report.collisions = computed.collisions;
                state.report.skipped = computed.skipped;
                state.stored = computed.stored;
            }
            Err(e) => {
                state.report.state = CollisionCheckState::Failed;
                state.report.error = Some(redact::redact(&e.message));
                state.report.collisions.clear();
                state.report.skipped.clear();
                state.stored.clear();
            }
        }
    });
    watch.active.fetch_sub(1, Ordering::SeqCst);
    watch.checks.fetch_add(1, Ordering::SeqCst);
    core.emit(names::AGENT_COLLISIONS, &report);
    Ok(report)
}

/// Result tree and raw path of `path` in the conflict `collision_id` of the last report.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn stored_conflict(core: &Core, repo_id: &str, collision_id: &str, path: &str) -> Option<(String, Vec<u8>)> {
    let watch = core.state::<CollisionWatch>();
    let repos = watch.repos.lock();
    let stored = repos.get(repo_id)?.stored.get(collision_id)?;
    let raw = stored.files.iter().find(|(shown, _)| shown == path)?.1.clone();
    Some((stored.tree.clone(), raw))
}

#[cfg(test)]
mod tests;
