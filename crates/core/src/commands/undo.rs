//! Undo and redo (F10): executes the entries that undoable actions stored via
//! `crate::undo::record` according to the undo convention.
//!
//! Flow per step, always under the write lock:
//! 1. fetch the next entry (none → `nothing_to_undo`),
//! 2. check that the repository is still in the state the entry describes
//!    (undo: after state, redo: before state; otherwise `stale_state`, the entry stays),
//! 3. back up the state of the opposite direction (backup ref `after`, and for destroyed work
//!    additionally a backup commit of the working directory),
//! 4. reverse or repeat the action and flip the entry.
//!
//! Actions that affect uncommitted work (discard, hard reset, stash pop) swap two backed-up
//! states: `payload.worktreeSnapshot`/`indexTree` is the state before the action,
//! `payload.redo.worktreeSnapshot`/`indexTree` the one after. That way nothing is lost on
//! either path, even if work continued between undo and redo.

use std::collections::HashMap;

use serde_json::{json, Map, Value};

use crate::app::Core;
use crate::commands::{rebase, refs, stash, status};
use crate::db;
use crate::db::undo::{UndoEntry, UndoEntryState};
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::{errors, GitCmd};
use crate::model::{Head, RepoChange, UndoState, UndoStep};
use crate::undo::{self as u, UndoAction};
use crate::util;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Direction {
    Undo,
    Redo,
}

/// How a ref is set to another commit when it is checked out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    /// Index and working directory stay as they are.
    Soft,
    /// Index and working directory follow; local changes and untracked files are never
    /// overwritten in the process (`git reset --keep`).
    Keep,
}

/// Undoes the last undoable action.
pub async fn undo(core: &Core, repo_id: String) -> CoreResult<UndoState> {
    crate::commands::submodule::auto::follow(core, &repo_id, step(core, &repo_id, Direction::Undo)).await
}

/// Redoes the most recently undone action.
pub async fn redo(core: &Core, repo_id: String) -> CoreResult<UndoState> {
    crate::commands::submodule::auto::follow(core, &repo_id, step(core, &repo_id, Direction::Redo)).await
}

/// What undo and redo would do right now (tooltip and enabled state of the toolbar button).
///
/// Checked against Git: entries that no longer fit the repository's current state (branch
/// now elsewhere, commit already pushed, stash deleted …) are skipped – exactly as
/// `undo`/`redo` do. While an operation is running or conflicts are open, nothing can be
/// undone; then both steps are `None`.
/// Pure read command: no lock, no event, no activity log entry.
pub async fn undo_peek(core: &Core, repo_id: String) -> CoreResult<UndoState> {
    core.repo_row(&repo_id)?;
    // Without a readable repository (folder missing, no Git) only the stored state remains.
    let Ok((mut probe, blocked)) = Probe::new(core, &repo_id).await else {
        return u::peek(core, &repo_id, "");
    };
    if blocked.is_some() {
        return Ok(UndoState::default());
    }
    let undo = probe.first(Direction::Undo).await?;
    let redo = probe.first(Direction::Redo).await?;
    // Nothing to offer although something undoable happened last: state the reason.
    let undo_blocked = if undo.is_none() { probe.pushed_reason().await? } else { None };
    Ok(UndoState {
        undo: undo.map(|e| UndoStep { label: u::undo_label(&e), action: e.action }),
        redo: redo.map(|e| UndoStep { label: u::redo_label(&e.label), action: e.action }),
        undo_blocked,
    })
}

/// At most this many entries are searched for an applicable one.
const MAX_SCAN: usize = 50;

async fn step(core: &Core, repo_id: &str, dir: Direction) -> CoreResult<UndoState> {
    core.repo_path(repo_id)?;
    let guard = core.write_lock(repo_id).await;
    let mut touched: Option<Vec<RepoChange>> = None;
    let result = step_locked(core, repo_id, dir, &mut touched).await;
    drop(guard);
    // Even after an error: Git may already have changed something, and the UI should reload
    // the undo state.
    if let Some(changes) = touched {
        core.emit_repo_changed(repo_id, &changes);
    }
    result?;
    undo_peek(core, repo_id.to_string()).await
}

/// Finds the topmost entry that fits the current state and executes it.
/// `touched` receives what may have changed as soon as an entry was touched.
async fn step_locked(core: &Core, repo_id: &str, dir: Direction, touched: &mut Option<Vec<RepoChange>>) -> CoreResult<()> {
    // A rebase or cherry-pick that finished after conflicts outside of `operation_continue`
    // (terminal) still has an open entry.
    if let Err(e) = rebase::settle_pending_undo(core, repo_id).await {
        log::warn!("open undo entry not completed: {}", e.message);
    }
    let candidates = candidates(core, repo_id, dir)?;
    let nothing = || match dir {
        Direction::Undo => CoreError::nothing_to_undo(),
        Direction::Redo => CoreError::new(ErrorCode::NothingToUndo, "There is nothing to redo."),
    };
    let Some(top) = candidates.first() else { return Err(nothing()) };
    let (mut probe, blocked) = Probe::new(core, repo_id).await?;
    if let Some(blocked) = blocked {
        *touched = Some(changes_for(top));
        let verb = match dir {
            Direction::Undo => "be undone",
            Direction::Redo => "be redone",
        };
        return Err(match blocked {
            Blocked::Operation => CoreError::new(
                ErrorCode::OperationInProgress,
                format!("Nothing can {verb} while a merge, rebase, cherry-pick or revert is in progress. Finish or abort the operation first."),
            ),
            Blocked::Conflict => CoreError::new(
                ErrorCode::Conflict,
                format!("Nothing can {verb} while there are unresolved conflicts. Resolve the conflicts first."),
            ),
        });
    }
    for entry in candidates.iter().take(MAX_SCAN) {
        let entry = normalized(entry);
        let Some(action) = UndoAction::parse(&entry.action) else { continue };
        // Stale entries are skipped, not deleted: if the repository later returns to their
        // state, they apply again.
        let Some(ref_sha) = probe.applicable(&entry, dir).await? else { continue };
        *touched = Some(changes_for(&entry));
        let mut run = Run {
            core,
            repo_id,
            entry: &entry,
            dir,
            action,
            head: probe.head.clone(),
            ref_sha,
            payload: entry.payload.as_object().cloned().unwrap_or_default(),
        };
        return match run.execute().await {
            Ok(()) => u::set_state(core, &entry.id, match dir {
                Direction::Undo => UndoEntryState::Undone,
                Direction::Redo => UndoEntryState::Done,
            }),
            // The detailed check found that the entry is not (or no longer) executable –
            // for example because its backup is missing. It is invalidated so it blocks nothing.
            Err(e) if matches!(e.code, ErrorCode::StaleState | ErrorCode::NotFound) => {
                discard_entry(core, repo_id, &entry.id).await;
                Err(e)
            }
            Err(e) => Err(e),
        };
    }
    Err(nothing())
}

/// Entries in the order in which they would come up.
fn candidates(core: &Core, repo_id: &str, dir: Direction) -> CoreResult<Vec<UndoEntry>> {
    core.db.with(|c| match dir {
        Direction::Undo => db::undo::list_done(c, repo_id, ""),
        Direction::Redo => db::undo::list_undone(c, repo_id, ""),
    })
}

/// Deletes an entry along with its backup refs. Call within the write lock.
pub(crate) async fn discard_entry(core: &Core, repo_id: &str, entry_id: &str) {
    if let Err(e) = core.db.with(|c| db::undo::delete(c, entry_id)) {
        log::warn!("undo entry {entry_id} not deleted: {}", e.message);
    }
    if let Err(e) = u::delete_backup_refs(core, repo_id, entry_id).await {
        log::warn!("backup refs of {entry_id} not removed: {}", e.message);
    }
}

/// Invalidates the "stash" undo entries whose stash no longer exists (after `stash_drop`).
/// Call within the write lock.
pub(crate) async fn forget_stash(core: &Core, repo_id: &str, stash_sha: &str) -> CoreResult<()> {
    let entries = core.db.with(|c| db::undo::list_done(c, repo_id, ""))?;
    for entry in entries {
        let same = entry.payload.get("stashSha").and_then(Value::as_str) == Some(stash_sha);
        if same && entry.action == UndoAction::Stash.as_str() {
            discard_entry(core, repo_id, &entry.id).await;
        }
    }
    Ok(())
}

/// Everything that may have changed through undo or redo of this action.
fn changes_for(entry: &UndoEntry) -> Vec<RepoChange> {
    use RepoChange::*;
    let merge_commit = entry.payload.get("merge").and_then(Value::as_bool) == Some(true);
    if is_composite(&entry.payload) {
        return vec![Refs, Head, Index, Worktree, Config];
    }
    match UndoAction::parse(&entry.action) {
        // A commit that concluded a merge is undone hard.
        Some(UndoAction::Commit) if merge_commit => vec![Refs, Head, Index, Worktree],
        Some(UndoAction::Commit | UndoAction::Amend | UndoAction::Reword) => vec![Refs, Head, Index],
        Some(UndoAction::Discard) => vec![Worktree, Index],
        Some(UndoAction::DeleteBranch) => vec![Refs, Config],
        Some(UndoAction::RemoveRemote) => vec![Config, Refs],
        Some(UndoAction::Stash | UndoAction::StashPop) => vec![Stash, Worktree, Index],
        Some(UndoAction::Checkout) => vec![Refs, Head, Index, Worktree, Config],
        _ => vec![Refs, Head, Index, Worktree],
    }
}

/// Why nothing at all can be undone or redone right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Blocked {
    Operation,
    Conflict,
}

/// Checks entries against the repository's current state. What is read from Git for this
/// stays in memory for the following entries.
struct Probe<'a> {
    core: &'a Core,
    repo_id: &'a str,
    head: Head,
    refs: HashMap<String, Option<String>>,
    stashes: Option<Vec<String>>,
    remotes: Option<Vec<String>>,
}

impl<'a> Probe<'a> {
    async fn new(core: &'a Core, repo_id: &'a str) -> CoreResult<(Probe<'a>, Option<Blocked>)> {
        // The running operation is recorded in the Git directory. Without any of its traces
        // none is running for sure; only otherwise is a closer look worthwhile.
        let git_dir = status::git_dir(core, repo_id).await?;
        let operation =
            OPERATION_MARKERS.iter().any(|marker| git_dir.join(marker).exists()) && status::read_operation(core, repo_id).await?.is_some();
        let (head, unmerged) = tokio::join!(refs::read_head(core, repo_id), stash::unmerged_paths(core, repo_id));
        let (head, unmerged) = (head?, unmerged?);
        let blocked = if operation {
            Some(Blocked::Operation)
        } else if !unmerged.is_empty() {
            Some(Blocked::Conflict)
        } else {
            None
        };
        Ok((Probe { core, repo_id, head, refs: HashMap::new(), stashes: None, remotes: None }, blocked))
    }

    async fn ref_sha(&mut self, name: &str) -> CoreResult<Option<String>> {
        if let Some(known) = self.refs.get(name) {
            return Ok(known.clone());
        }
        let sha = u::rev_parse(self.core, self.repo_id, name).await?;
        self.refs.insert(name.to_string(), sha.clone());
        Ok(sha)
    }

    async fn stash_exists(&mut self, sha: &str) -> CoreResult<bool> {
        if self.stashes.is_none() {
            let rows = stash::read_rows(self.core, self.repo_id).await?;
            self.stashes = Some(rows.into_iter().map(|row| row.sha).collect());
        }
        Ok(self.stashes.as_ref().is_some_and(|list| list.iter().any(|s| s == sha)))
    }

    async fn remote_exists(&mut self, name: &str) -> CoreResult<bool> {
        if self.remotes.is_none() {
            let listed = self.core.git_for(self.repo_id)?.arg("remote").read_only().no_log().run().await?;
            self.remotes = Some(listed.stdout_lines().into_iter().map(util::decode_lossy).collect());
        }
        Ok(self.remotes.as_ref().is_some_and(|list| list.iter().any(|r| r == name)))
    }

    /// Whether the (normalised) entry fits the current state. `Some(ref_sha)`: yes, with the
    /// current position of its ref; `None`: stale.
    async fn applicable(&mut self, entry: &UndoEntry, dir: Direction) -> CoreResult<Option<Option<String>>> {
        let Some(action) = UndoAction::parse(&entry.action) else { return Ok(None) };
        let ref_sha = match &entry.ref_name {
            Some(name) => self.ref_sha(name).await?,
            None => None,
        };
        if !precondition(entry, action, dir, &self.head, ref_sha.as_deref()) {
            return Ok(None);
        }
        let text = |key: &str| entry.payload.get(key).and_then(Value::as_str).map(str::to_string);
        let fits = match (action, dir) {
            // Composite step: every ref involved must still be at the expected end.
            _ if is_composite(&entry.payload) => {
                let mut all = true;
                for step in composite_steps(&entry.payload) {
                    let expected = match dir {
                        Direction::Undo => step.after,
                        Direction::Redo => step.before,
                    };
                    if !same_sha(self.ref_sha(&step.name).await?.as_deref(), expected.as_deref()) {
                        all = false;
                        break;
                    }
                }
                all
            }
            (_, Direction::Undo) if creates_commit(action) => {
                let tip = if entry.ref_name.is_some() { ref_sha.clone() } else { u::head_sha(&self.head) };
                match tip {
                    Some(tip) => pushed_to(self.core, self.repo_id, &tip).await?.is_none(),
                    None => true,
                }
            }
            (UndoAction::Stash, Direction::Undo) => match text("stashSha") {
                Some(sha) => self.stash_exists(&sha).await?,
                None => true,
            },
            (UndoAction::StashPop, _) => match text("stashSha") {
                Some(sha) => self.stash_exists(&sha).await? == (dir == Direction::Redo),
                None => true,
            },
            (UndoAction::RemoveRemote, _) => match entry.payload.get("remote").and_then(|r| r.get("name")).and_then(Value::as_str) {
                Some(name) => self.remote_exists(name).await? == (dir == Direction::Redo),
                None => true,
            },
            _ if swaps_snapshots(action, &entry.payload) => match text("worktreeSnapshot") {
                // The backup is tied to the commit the action ran on; HEAD must still be there.
                Some(snapshot) => match u::rev_parse(self.core, self.repo_id, &format!("{snapshot}^1")).await? {
                    Some(parent) => same_sha(u::head_sha(&self.head).as_deref(), Some(&parent)),
                    None => true,
                },
                None => true,
            },
            _ => true,
        };
        let fits = fits && self.updated_refs_fit(entry, dir).await?;
        Ok(fits.then_some(ref_sha))
    }

    /// Branches a rebase moved along must still be where it left them (undo) or where they were
    /// before (redo); an unknown end (not settled yet) is not compared. One that would move must not
    /// be checked out in any worktree now: `update-ref` would shift it under that worktree's index
    /// and files.
    async fn updated_refs_fit(&mut self, entry: &UndoEntry, dir: Direction) -> CoreResult<bool> {
        for step in updated_refs(&entry.payload) {
            let (expected, target) = match dir {
                Direction::Undo => (step.after.as_deref(), step.before.as_deref()),
                Direction::Redo => (step.before.as_deref(), step.after.as_deref()),
            };
            let Some(expected) = expected else { continue };
            if !same_sha(self.ref_sha(&step.name).await?.as_deref(), Some(expected)) {
                return Ok(false);
            }
            let moves = target.is_some_and(|target| !same_sha(Some(expected), Some(target)));
            if moves && self.checked_out_in_worktree(&step.name).await? {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// Whether the branch `name` (`refs/heads/…`) is checked out in this or another worktree.
    async fn checked_out_in_worktree(&self, name: &str) -> CoreResult<bool> {
        let out = self
            .core
            .git_for(self.repo_id)?
            .args(["for-each-ref", "--format=%(worktreepath)", name])
            .read_only()
            .no_log()
            .run()
            .await?;
        Ok(out.stdout_lines().into_iter().any(|line| !line.is_empty()))
    }

    /// If the most recently recorded action is a commit (or amend, squash …) that is now on a
    /// remote branch, this says why undo no longer offers it.
    async fn pushed_reason(&mut self) -> CoreResult<Option<String>> {
        let Some(top) = candidates(self.core, self.repo_id, Direction::Undo)?.into_iter().next() else { return Ok(None) };
        let entry = normalized(&top);
        let Some(action) = UndoAction::parse(&entry.action) else { return Ok(None) };
        if !creates_commit(action) || is_composite(&entry.payload) {
            return Ok(None);
        }
        let ref_sha = match &entry.ref_name {
            Some(name) => self.ref_sha(name).await?,
            None => None,
        };
        if !precondition(&entry, action, Direction::Undo, &self.head, ref_sha.as_deref()) {
            return Ok(None);
        }
        let tip = if entry.ref_name.is_some() { ref_sha } else { u::head_sha(&self.head) };
        let Some(tip) = tip else { return Ok(None) };
        Ok(pushed_to(self.core, self.repo_id, &tip).await?.map(|remote| {
            format!("The last commit is already on the remote ({remote}), so it can no longer be undone locally. Use Revert instead.")
        }))
    }

    /// The topmost entry of this direction that fits the current state.
    async fn first(&mut self, dir: Direction) -> CoreResult<Option<UndoEntry>> {
        for entry in candidates(self.core, self.repo_id, dir)?.iter().take(MAX_SCAN) {
            let entry = normalized(entry);
            if self.applicable(&entry, dir).await?.is_some() {
                return Ok(Some(entry));
            }
        }
        Ok(None)
    }
}

/// Actions whose result is certainly a new commit. A fast-forward merge or a reset, by
/// contrast, rightly ends up on commits the remote already knows.
fn creates_commit(action: UndoAction) -> bool {
    matches!(
        action,
        UndoAction::Commit | UndoAction::Amend | UndoAction::Reword | UndoAction::Squash | UndoAction::CherryPick | UndoAction::Revert
    )
}

/// One step of a composite entry: a ref with its position before and after
/// (`None` = the ref did not exist or was deleted).
struct CompositeStep {
    name: String,
    before: Option<String>,
    after: Option<String>,
}

/// Composite entries (`payload.composite`, e.g. a Gitflow finish) move several refs and HEAD
/// in one step; their list is in `payload.steps`.
fn is_composite(payload: &Value) -> bool {
    payload.get("composite").and_then(Value::as_bool) == Some(true)
}

fn composite_steps(payload: &Value) -> Vec<CompositeStep> {
    let text = |item: &Value, key: &str| item.get(key).and_then(Value::as_str).map(str::to_string);
    let list = payload.get("steps").and_then(Value::as_array).cloned().unwrap_or_default();
    list.iter()
        .filter_map(|item| {
            let name = text(item, "ref").filter(|name| name.starts_with("refs/") && !name.contains(char::is_whitespace))?;
            Some(CompositeStep { name, before: text(item, "before"), after: text(item, "after") })
        })
        .collect()
}

/// Branches a rebase moved along with `--update-refs` (`payload.updatedRefs`), in the shape of
/// composite steps. `after: None` while a stopped rebase is not settled yet.
fn updated_refs(payload: &Value) -> Vec<CompositeStep> {
    let text = |item: &Value, key: &str| item.get(key).and_then(Value::as_str).map(str::to_string);
    let list = payload.get("updatedRefs").and_then(Value::as_array).cloned().unwrap_or_default();
    list.iter()
        .filter_map(|item| {
            let name = text(item, "ref").filter(|name| name.starts_with("refs/heads/") && !name.contains(char::is_whitespace))?;
            Some(CompositeStep { name, before: text(item, "before"), after: text(item, "after") })
        })
        .collect()
}

/// Actions that move no ref but swap two backed-up states of working directory and index:
/// discard (also "restore file") and squash merge.
fn swaps_snapshots(action: UndoAction, payload: &Value) -> bool {
    action == UndoAction::Discard || (action == UndoAction::Merge && payload.get("squash").and_then(Value::as_bool) == Some(true))
}

/// The first remote branch that contains `tip` – such a commit is no longer undone locally
/// (F10: "already pushed").
async fn pushed_to(core: &Core, repo_id: &str, tip: &str) -> CoreResult<Option<String>> {
    let out = core
        .git_for(repo_id)?
        .args(["for-each-ref", "--count=1", "--format=%(refname:short)", "--contains", tip, "refs/remotes"])
        .read_only()
        .no_log()
        .run_raw()
        .await?;
    Ok(Some(out.stdout_text()).filter(|name| out.success() && !name.is_empty()))
}

/// The state the UI based its decision on: ref and HEAD must still be where the entry
/// describes them for this direction.
fn precondition(entry: &UndoEntry, action: UndoAction, dir: Direction, head: &Head, ref_sha: Option<&str>) -> bool {
    let (expected_ref, expected_head) = match dir {
        Direction::Undo => (entry.ref_after.as_deref(), entry.head_after.as_deref()),
        Direction::Redo => (entry.ref_before.as_deref(), Some(entry.head_before.as_str())),
    };
    // An action that only finished after a conflict does not know its end state: then the
    // current tip applies (a running operation is already ruled out) – unless it is back at
    // the start: then it was aborted.
    let open_end = dir == Direction::Undo
        && entry.ref_after.is_none()
        && (action == UndoAction::Rebase || entry.payload.get("pending").and_then(Value::as_bool) == Some(true));
    if entry.ref_name.is_some() {
        let fits = if open_end { ref_sha.is_some() && !same_sha(ref_sha, entry.ref_before.as_deref()) } else { same_sha(ref_sha, expected_ref) };
        if !fits {
            return false;
        }
    } else if open_end && entry.head_after.is_none() && same_sha(u::head_sha(head).as_deref(), Some(entry.head_before.as_str())) {
        return false;
    }
    if let Some(expected) = expected_head.filter(|head| !head.is_empty()) {
        if !head_matches(expected, head) {
            return false;
        }
    }
    // Actions without a moved ref (stash, stash pop) record the commit separately.
    if let Some(expected) = entry.payload.get("headSha").and_then(Value::as_str) {
        if !same_sha(u::head_sha(head).as_deref(), Some(expected)) {
            return false;
        }
    }
    true
}

/// Files and folders in the Git directory that a running merge, rebase, cherry-pick or
/// revert leaves behind.
const OPERATION_MARKERS: [&str; 6] = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"];

fn sha_like(text: &str) -> bool {
    text.len() >= 7 && text.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The convention requires full ref names. A short branch name is understood anyway, so
/// that it never turns into a ref outside of `refs/heads/`.
fn normalized(entry: &UndoEntry) -> UndoEntry {
    let full_head = |value: String| {
        if value.is_empty() || value.starts_with("refs/") || sha_like(&value) {
            value
        } else {
            format!("refs/heads/{value}")
        }
    };
    let mut entry = entry.clone();
    entry.ref_name = entry.ref_name.map(|name| if name.starts_with("refs/") { name } else { format!("refs/heads/{name}") });
    entry.head_before = full_head(entry.head_before);
    entry.head_after = entry.head_after.map(full_head).filter(|head| !head.is_empty());
    entry
}

fn same_sha(a: Option<&str>, b: Option<&str>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a.eq_ignore_ascii_case(b),
        _ => false,
    }
}

/// Whether HEAD matches the value from `head_before`/`head_after`: for a ref name the
/// branch, for a SHA the commit (regardless of whether HEAD is now attached to a branch).
fn head_matches(expected: &str, head: &Head) -> bool {
    match expected.strip_prefix("refs/heads/") {
        Some(branch) => matches!(head, Head::Branch { branch: b, .. } | Head::Unborn { branch: b } if b == branch),
        None => u::head_sha(head).is_some_and(|sha| sha.eq_ignore_ascii_case(expected)),
    }
}

struct Run<'a> {
    core: &'a Core,
    repo_id: &'a str,
    entry: &'a UndoEntry,
    dir: Direction,
    action: UndoAction,
    /// HEAD before execution.
    head: Head,
    /// SHA of `entry.ref_name` before execution (`None`: the ref is missing or the entry names none).
    ref_sha: Option<String>,
    payload: Map<String, Value>,
}

impl Run<'_> {
    fn git(&self) -> CoreResult<GitCmd> {
        self.core.git_for(self.repo_id)
    }

    fn stale(&self) -> CoreError {
        CoreError::new(
            ErrorCode::StaleState,
            match self.dir {
                Direction::Undo => "The repository has changed since this action, so it can no longer be undone automatically.",
                Direction::Redo => "The repository has changed since the undo, so the action can no longer be redone automatically.",
            },
        )
    }

    fn lost(&self) -> CoreError {
        CoreError::not_found("The backup for this action no longer exists.")
    }

    fn text(&self, key: &str) -> Option<String> {
        self.payload.get(key).and_then(Value::as_str).map(str::to_string)
    }

    fn redo_text(&self, key: &str) -> Option<String> {
        self.payload.get("redo").and_then(|r| r.get(key)).and_then(Value::as_str).map(str::to_string)
    }

    /// `payload.paths`: `None` = everything.
    fn paths(&self) -> Option<Vec<String>> {
        let list = self.payload.get("paths")?.as_array()?;
        Some(list.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
    }

    fn save_payload(&self) -> CoreResult<()> {
        u::update_payload(self.core, &self.entry.id, &Value::Object(self.payload.clone()))
    }

    async fn backup(&self, name: &str, sha: &str) -> CoreResult<()> {
        u::create_backup_ref(self.core, self.repo_id, &self.entry.id, name, sha).await.map(|_| ())
    }

    async fn commit_exists(&self, sha: &str) -> CoreResult<bool> {
        Ok(u::rev_parse(self.core, self.repo_id, &format!("{sha}^{{commit}}")).await?.is_some())
    }

    /// Executes the entry in this direction, then moves the branches a rebase took along.
    async fn execute(&mut self) -> CoreResult<()> {
        self.execute_action().await?;
        self.move_updated_refs().await
    }

    /// Branches a rebase moved along with `--update-refs`: back to `before` on undo (their position
    /// after stays reachable for redo through `dep-after-<n>`), forward to `after` on redo. Never the
    /// checked-out branch, so the working directory is not touched.
    async fn move_updated_refs(&self) -> CoreResult<()> {
        let steps = updated_refs(&Value::Object(self.payload.clone()));
        for (index, step) in steps.iter().enumerate() {
            let (from, to) = match self.dir {
                Direction::Undo => (step.after.as_deref(), step.before.as_deref()),
                Direction::Redo => (step.before.as_deref(), step.after.as_deref()),
            };
            let (Some(from), Some(to)) = (from, to) else { continue };
            if same_sha(Some(from), Some(to)) {
                continue;
            }
            if !self.commit_exists(to).await? {
                return Err(self.lost());
            }
            if self.dir == Direction::Undo {
                self.backup(&format!("dep-after-{index}"), from).await?;
            }
            self.update_ref(&step.name, Some(to), Some(from)).await?;
        }
        Ok(())
    }

    /// Executes the entry's own action in this direction. `Probe::applicable` has checked the preconditions.
    async fn execute_action(&mut self) -> CoreResult<()> {
        let flag = |key: &str| self.payload.get(key).and_then(Value::as_bool) == Some(true);
        match self.action {
            UndoAction::Checkout => self.checkout().await,
            // A commit that concluded a merge is a merge: with `reset --soft` the merged
            // changes would remain staged, but without MERGE_HEAD.
            UndoAction::Commit if flag("merge") => self.hard().await,
            UndoAction::Commit | UndoAction::Amend | UndoAction::Reword => self.soft().await,
            // A squash merge moves no ref: the only way back is via the state before it.
            UndoAction::Merge if flag("squash") => self.swap_checked(None).await,
            // Several branches deleted at once are a composite step as well.
            UndoAction::Merge | UndoAction::DeleteBranch if flag("composite") => self.composite().await,
            UndoAction::Merge | UndoAction::Revert | UndoAction::CherryPick | UndoAction::Rebase | UndoAction::Squash | UndoAction::Drop => {
                self.hard().await
            }
            UndoAction::Reset => self.reset_branch().await,
            UndoAction::Discard => self.discard().await,
            UndoAction::DeleteBranch => self.delete_branch().await,
            UndoAction::RemoveRemote => self.remove_remote().await,
            UndoAction::Stash => self.stash().await,
            UndoAction::StashPop => self.stash_pop().await,
        }
    }

    /// Current position of the moved ref; without a ref name the commit of the detached HEAD.
    fn tip(&self) -> Option<String> {
        match &self.entry.ref_name {
            Some(_) => self.ref_sha.clone(),
            None => u::head_sha(&self.head),
        }
    }

    fn before(&self) -> Option<String> {
        match &self.entry.ref_name {
            Some(_) => self.entry.ref_before.clone(),
            None => Some(self.entry.head_before.clone()).filter(|h| sha_like(h)),
        }
    }

    async fn after(&self) -> CoreResult<Option<String>> {
        match (&self.entry.ref_name, &self.entry.ref_after) {
            (Some(_), Some(sha)) => Ok(Some(sha.clone())),
            // The end state was unknown when recording: undo backed it up as "after".
            (Some(_), None) => u::rev_parse(self.core, self.repo_id, &u::backup_ref_name(&self.entry.id, "after")).await,
            (None, _) => Ok(self.entry.head_after.clone().filter(|h| sha_like(h))),
        }
    }

    /// Where the ref should go in this direction.
    async fn target(&self) -> CoreResult<Option<String>> {
        match self.dir {
            Direction::Undo => Ok(self.before()),
            Direction::Redo => self.after().await,
        }
    }

    fn desired_head(&self) -> Option<&str> {
        match self.dir {
            Direction::Undo => Some(self.entry.head_before.as_str()),
            Direction::Redo => self.entry.head_after.as_deref(),
        }
    }

    /// Before undoing: record the after state so that redo finds it again.
    async fn keep_after(&self) -> CoreResult<()> {
        if self.dir == Direction::Undo {
            if let Some(tip) = self.tip() {
                self.backup("after", &tip).await?;
            }
        }
        Ok(())
    }

    async fn update_ref(&self, name: &str, new: Option<&str>, old: Option<&str>) -> CoreResult<()> {
        let cmd = self.git()?.args(["update-ref", "-m", "forkyard: Undo"]);
        match new {
            Some(sha) => cmd.args([name, sha, old.unwrap_or("")]).run().await?,
            None => match old {
                Some(old) => cmd.args(["-d", name, old]).run().await?,
                None => return Ok(()),
            },
        };
        Ok(())
    }

    /// Sets the entry's ref (or the detached HEAD) to `target`; `None` = the ref did not
    /// exist.
    async fn move_to(&self, target: Option<&str>, mode: Mode) -> CoreResult<()> {
        if let Some(sha) = target {
            if !self.commit_exists(sha).await? {
                return Err(self.lost());
            }
        }
        let tip = self.tip();
        if same_sha(tip.as_deref(), target) {
            return Ok(());
        }
        let checked_out = self.checked_out();
        match (&self.entry.ref_name, checked_out, target) {
            // Not checked out: only move the ref, the working directory is not affected.
            (Some(name), false, _) => self.update_ref(name, target, tip.as_deref()).await,
            // The branch only came into being through the action (first commit): back to "no commit".
            (Some(name), true, None) => self.update_ref(name, None, tip.as_deref()).await,
            (Some(name), true, Some(sha)) if matches!(self.head, Head::Unborn { .. }) => self.update_ref(name, Some(sha), None).await,
            (_, true, Some(sha)) => self.reset_to(mode, sha).await,
            (None, _, _) => Err(self.stale()),
        }
    }

    /// Whether the entry's ref (or the detached HEAD) is currently checked out – only then
    /// does moving it affect index and working directory.
    fn checked_out(&self) -> bool {
        match (&self.entry.ref_name, &self.head) {
            (Some(name), Head::Branch { branch, .. }) | (Some(name), Head::Unborn { branch }) => *name == format!("refs/heads/{branch}"),
            (None, Head::Detached { .. }) => true,
            _ => false,
        }
    }

    async fn reset_to(&self, mode: Mode, sha: &str) -> CoreResult<()> {
        match mode {
            Mode::Soft => {
                self.git()?.args(["reset", "--soft", "-q", sha]).run().await?;
            }
            Mode::Keep => {
                // Like `reset --merge`, `--keep` refuses files with a stale timestamp in the
                // index even if their content is unchanged; the read commands never refresh.
                self.git()?.args(["update-index", "-q", "--refresh"]).no_log().run_raw().await?;
                let out = self.git()?.args(["reset", "--keep", "-q", sha]).run_raw().await?;
                if !out.success() {
                    let error = errors::classify("reset", out.code, &out.stdout, &out.stderr);
                    if error.code == ErrorCode::Locked {
                        return Err(error);
                    }
                    return Err(self.dirty().with_git_output(out.stderr_text()));
                }
            }
        }
        Ok(())
    }

    fn dirty(&self) -> CoreError {
        CoreError::new(
            ErrorCode::DirtyWorktree,
            match self.dir {
                Direction::Undo => "This action can only be undone with a clean working directory. Commit, stash or discard your changes first.",
                Direction::Redo => "This action can only be redone with a clean working directory. Commit, stash or discard your changes first.",
            },
        )
    }

    /// No changes to tracked files (untracked ones do not matter; `reset --keep` additionally
    /// protects them from being overwritten).
    async fn require_clean(&self) -> CoreResult<()> {
        let out = self.git()?.args(["status", "--porcelain=v2", "-z", "--untracked-files=no"]).read_only().no_log().run().await?;
        if out.stdout.is_empty() {
            Ok(())
        } else {
            Err(self.dirty())
        }
    }

    /// Moves HEAD to `desired` (`refs/heads/<branch>` or SHA) if it is not there.
    async fn restore_head(&self, desired: Option<&str>) -> CoreResult<()> {
        let Some(desired) = desired.filter(|head| !head.is_empty()) else { return Ok(()) };
        // A reset moves the branch, not HEAD: if HEAD was already on the desired branch,
        // there is nothing to do. Only a detached HEAD has to be re-read.
        if !matches!(self.head, Head::Detached { .. }) && u::head_token(&self.head) == desired {
            return Ok(());
        }
        let now = refs::read_head(self.core, self.repo_id).await?;
        if u::head_token(&now).eq_ignore_ascii_case(desired) {
            return Ok(());
        }
        match desired.strip_prefix("refs/heads/") {
            Some(branch) => {
                if u::rev_parse(self.core, self.repo_id, desired).await?.is_none() {
                    return Err(self.stale());
                }
                self.git()?.args(["switch", "-q", "--no-guess", branch]).run().await?;
            }
            None => {
                if !sha_like(desired) || !self.commit_exists(desired).await? {
                    return Err(self.stale());
                }
                self.git()?.args(["switch", "-q", "--detach", desired]).run().await?;
            }
        }
        Ok(())
    }

    // --- Actions ----------------------------------------------------------

    /// Checkout: back to the previous HEAD. If the checkout created a branch (ref in the
    /// entry, not present before), it disappears again on undo.
    async fn checkout(&self) -> CoreResult<()> {
        let moved_ref = self.entry.ref_name.as_deref().filter(|_| !same_sha(self.entry.ref_before.as_deref(), self.entry.ref_after.as_deref()));
        match self.dir {
            Direction::Undo => {
                if moved_ref.is_some() {
                    self.keep_after().await?;
                }
                self.restore_head(Some(&self.entry.head_before)).await?;
                if let Some(name) = moved_ref.filter(|name| *name != self.entry.head_before) {
                    self.update_ref(name, self.entry.ref_before.as_deref(), self.ref_sha.as_deref()).await?;
                    if self.entry.ref_before.is_none() {
                        // The branch only came into being through the checkout: its settings (upstream) go with it.
                        let branch = name.strip_prefix("refs/heads/").unwrap_or(name);
                        let _ = self.git()?.args(["config", "--remove-section", &format!("branch.{branch}")]).no_log().run_raw().await;
                    }
                }
            }
            Direction::Redo => {
                if let Some(name) = moved_ref.filter(|name| *name != self.entry.head_before) {
                    let Some(after) = self.after().await? else { return Err(self.lost()) };
                    if !self.commit_exists(&after).await? {
                        return Err(self.lost());
                    }
                    self.update_ref(name, Some(&after), self.ref_sha.as_deref()).await?;
                    if let Some(upstream) = self.text("upstream") {
                        self.set_upstream(name.strip_prefix("refs/heads/").unwrap_or(name), &upstream).await;
                    }
                }
                self.restore_head(self.entry.head_after.as_deref()).await?;
            }
        }
        Ok(())
    }

    /// Commit, amend, reword: branch back, the changes stay staged.
    async fn soft(&self) -> CoreResult<()> {
        let target = self.target().await?;
        // "No target" only exists when undoing the very first commit.
        if target.is_none() && !(self.dir == Direction::Undo && self.action == UndoAction::Commit && self.entry.ref_name.is_some()) {
            return Err(self.lost());
        }
        self.keep_after().await?;
        self.move_to(target.as_deref(), Mode::Soft).await?;
        self.restore_head(self.desired_head()).await
    }

    /// Merge, revert, cherry-pick, rebase, squash, drop: branch back hard, only with a clean
    /// working directory.
    async fn hard(&self) -> CoreResult<()> {
        let Some(target) = self.target().await? else { return Err(self.lost()) };
        // A branch that is not checked out (fast-forward in the background) does not touch
        // the working directory: then local changes do not matter either.
        if self.checked_out() {
            self.require_clean().await?;
        }
        self.keep_after().await?;
        self.move_to(Some(&target), Mode::Keep).await?;
        self.restore_head(self.desired_head()).await
    }

    /// Composite step (Gitflow finish): all refs from `payload.steps` and HEAD to the state of
    /// the opposite direction. Order: create missing refs, move HEAD, then move and delete –
    /// that way the branch HEAD should go to already exists, and no ref is deleted while it is
    /// checked out. Only with a clean working directory.
    async fn composite(&self) -> CoreResult<()> {
        let payload = Value::Object(self.payload.clone());
        let steps = composite_steps(&payload);
        if steps.is_empty() {
            return Err(self.lost());
        }
        // A Gitflow finish moves HEAD and needs a clean working directory; recreating deleted
        // branches does not touch it.
        if self.action != UndoAction::DeleteBranch {
            self.require_clean().await?;
        }
        // (now, target) per ref.
        let moves: Vec<(&CompositeStep, Option<&str>, Option<&str>)> = steps
            .iter()
            .map(|step| match self.dir {
                Direction::Undo => (step, step.after.as_deref(), step.before.as_deref()),
                Direction::Redo => (step, step.before.as_deref(), step.after.as_deref()),
            })
            .collect();
        for (_, _, to) in &moves {
            if let Some(sha) = to {
                if !self.commit_exists(sha).await? {
                    return Err(self.lost());
                }
            }
        }
        if self.dir == Direction::Undo {
            // So that redo finds the commits (and tag objects) again.
            for (index, step) in steps.iter().enumerate() {
                if let Some(after) = &step.after {
                    self.backup(&format!("after-{index}"), after).await?;
                }
            }
        }
        for (step, from, to) in &moves {
            if let (None, Some(to)) = (from, to) {
                self.update_ref(&step.name, Some(to), None).await?;
            }
        }
        self.restore_head(self.desired_head()).await?;
        let head = refs::read_head(self.core, self.repo_id).await?;
        let current = match &head {
            Head::Branch { branch, .. } | Head::Unborn { branch } => Some(format!("refs/heads/{branch}")),
            Head::Detached { .. } => None,
        };
        for (step, from, to) in &moves {
            let Some(from) = from else { continue };
            if same_sha(Some(from), *to) {
                continue;
            }
            let checked_out = current.as_deref() == Some(step.name.as_str());
            match to {
                Some(to) if checked_out => self.reset_to(Mode::Keep, to).await?,
                // A checked-out branch cannot be deleted: the state does not match the entry.
                None if checked_out => return Err(self.stale()),
                _ => self.update_ref(&step.name, *to, Some(from)).await?,
            }
            if let (None, Some(branch)) = (to, step.name.strip_prefix("refs/heads/")) {
                let _ = self.git()?.args(["config", "--remove-section", &format!("branch.{branch}")]).no_log().run_raw().await;
            }
        }
        // Recreated branches get their upstream back.
        let upstreams = self.payload.get("upstreams").and_then(Value::as_array).cloned().unwrap_or_default();
        for item in upstreams {
            let (Some(branch), Some(upstream)) = (item.get("branch").and_then(Value::as_str), item.get("upstream").and_then(Value::as_str)) else {
                continue;
            };
            let recreated = moves.iter().any(|(step, from, to)| from.is_none() && to.is_some() && step.name == format!("refs/heads/{branch}"));
            if recreated {
                self.set_upstream(branch, upstream).await;
            }
        }
        Ok(())
    }

    /// Reset: back to the previous commit in the matching mode.
    async fn reset_branch(&mut self) -> CoreResult<()> {
        let Some(target) = self.target().await? else { return Err(self.lost()) };
        let mode = self.text("mode").unwrap_or_else(|| if self.text("worktreeSnapshot").is_some() { "hard".into() } else { "mixed".into() });
        match mode.as_str() {
            "soft" => {
                self.keep_after().await?;
                self.move_to(Some(&target), Mode::Soft).await?;
            }
            "hard" => self.swap_state(Some(&target), None).await?,
            _ => {
                // Mixed: the working directory stays, the index switches between both states.
                let current_index = u::index_tree(self.core, self.repo_id).await?;
                let wanted = match self.dir {
                    Direction::Undo => self.text("indexTree"),
                    Direction::Redo => self.redo_text("indexTree"),
                };
                match self.dir {
                    Direction::Undo => {
                        self.payload.insert("redo".into(), json!({ "indexTree": current_index }));
                    }
                    Direction::Redo => {
                        self.payload.insert("indexTree".into(), json!(current_index));
                    }
                }
                self.save_payload()?;
                self.keep_after().await?;
                self.move_to(Some(&target), Mode::Soft).await?;
                u::restore_index(self.core, self.repo_id, wanted.as_deref().unwrap_or(&target)).await?;
            }
        }
        self.restore_head(self.desired_head()).await
    }

    /// Swaps the state of working directory and index: backs up the current one for the
    /// opposite direction and restores the backed-up one of this direction. With `move_target`
    /// the ref moves along in between (hard reset); if a backup is missing, its tree applies.
    async fn swap_state(&mut self, move_target: Option<&str>, paths: Option<&[String]>) -> CoreResult<()> {
        let (wanted_tree, wanted_index) = match self.dir {
            Direction::Undo => (self.text("worktreeSnapshot"), self.text("indexTree")),
            Direction::Redo => (self.redo_text("worktreeSnapshot"), self.redo_text("indexTree")),
        };
        let Some(wanted_tree) = wanted_tree.or_else(|| move_target.map(str::to_string)) else {
            return Err(self.lost());
        };
        // The state right after the action (or after the undo): compared against it, it shows
        // what the user has created or changed since – that stays in place.
        let base = match self.dir {
            Direction::Undo => self.text("resultSnapshot"),
            Direction::Redo => self.redo_text("resultSnapshot"),
        };
        let now = u::snapshot(self.core, self.repo_id, paths).await?;
        // Plan first, then touch: if new work overlaps with what would come back, nothing is
        // changed.
        let plan = match u::plan_restore(self.core, self.repo_id, base.as_deref(), &now.tree, &wanted_tree, paths).await? {
            Ok(plan) => plan,
            Err(files) => return Err(self.changed_since(&files)),
        };
        match self.dir {
            Direction::Undo => {
                self.backup("after-worktree", &now.commit).await?;
                self.payload.insert("redo".into(), json!({ "worktreeSnapshot": now.commit, "indexTree": now.index_tree }));
            }
            Direction::Redo => {
                self.backup("worktree", &now.commit).await?;
                self.payload.insert("worktreeSnapshot".into(), json!(now.commit));
                self.payload.insert("indexTree".into(), json!(now.index_tree));
            }
        }
        self.save_payload()?;
        u::apply_restore(self.core, self.repo_id, &plan).await?;
        if let Some(target) = move_target {
            self.keep_after().await?;
            self.move_to(Some(target), Mode::Soft).await?;
        }
        if let Some(tree) = wanted_index.as_deref().or(move_target) {
            u::restore_index(self.core, self.repo_id, tree).await?;
        }
        // Record the new state for the opposite direction.
        let (name, slot) = match self.dir {
            Direction::Undo => ("redo-result", "redo"),
            Direction::Redo => ("result", ""),
        };
        match u::keep_result(self.core, self.repo_id, &self.entry.id, name, paths).await {
            Ok(commit) => {
                if slot.is_empty() {
                    self.payload.insert("resultSnapshot".into(), json!(commit));
                } else if let Some(redo) = self.payload.get_mut(slot).and_then(Value::as_object_mut) {
                    redo.insert("resultSnapshot".into(), json!(commit));
                }
                self.save_payload()?;
            }
            Err(e) => log::warn!("state after {} not recorded: {}", self.entry.id, e.message),
        }
        Ok(())
    }

    /// Files that were edited further since the action and overlap with what undo or redo
    /// would bring back: then nothing is touched.
    fn changed_since(&self, files: &[String]) -> CoreError {
        let mut list = files.iter().take(3).map(|file| format!("“{file}”")).collect::<Vec<_>>().join(", ");
        if files.len() > 3 {
            list.push_str(&format!(" and {} more", files.len() - 3));
        }
        let (verb, plural) = if files.len() == 1 { ("has", "this newer change") } else { ("have", "these newer changes") };
        let step = match self.dir {
            Direction::Undo => "Undo",
            Direction::Redo => "Redo",
        };
        CoreError::new(
            ErrorCode::DirtyWorktree,
            format!("{list} {verb} been changed since this action. {step} would overwrite {plural}, so it did nothing. Commit or stash your changes first."),
        )
    }

    /// Discard: files back from the backup (including deleted untracked ones), index as well.
    async fn discard(&mut self) -> CoreResult<()> {
        let paths = self.paths();
        self.swap_checked(paths.as_deref()).await
    }

    /// Swaps the backed-up states of an action that moved no ref (discard, restore file,
    /// squash merge). Without a backup this is not possible.
    async fn swap_checked(&mut self, paths: Option<&[String]>) -> CoreResult<()> {
        if self.text("worktreeSnapshot").is_none() {
            return Err(self.lost());
        }
        self.swap_state(None, paths).await
    }

    /// Delete branch: recreate it at the same place and set the upstream again.
    async fn delete_branch(&self) -> CoreResult<()> {
        let Some(name) = self.entry.ref_name.as_deref() else { return Err(self.lost()) };
        let branch = self.text("branch").unwrap_or_else(|| name.strip_prefix("refs/heads/").unwrap_or(name).to_string());
        match self.dir {
            Direction::Undo => {
                let Some(sha) = self.entry.ref_before.as_deref() else { return Err(self.lost()) };
                if !self.commit_exists(sha).await? {
                    return Err(self.lost());
                }
                self.git()?.args(["branch", "--no-track", &branch, sha]).run().await?;
                if let Some(upstream) = self.text("upstream") {
                    self.set_upstream(&branch, &upstream).await;
                }
            }
            Direction::Redo => {
                self.git()?.args(["branch", "-D", &branch]).run().await?;
            }
        }
        Ok(())
    }

    /// Sets the upstream again; if the remote branch does not exist (yet), directly in the
    /// configuration. If that fails too, the branch stays without an upstream.
    async fn set_upstream(&self, branch: &str, upstream: &str) {
        let result: CoreResult<()> = async {
            let direct = self.git()?.args(["branch", &format!("--set-upstream-to={upstream}"), branch]).run_raw().await?;
            if direct.success() {
                return Ok(());
            }
            let listed = self.git()?.arg("remote").read_only().no_log().run().await?;
            let remotes: Vec<String> = listed.stdout_lines().into_iter().map(util::decode_lossy).collect();
            let remote = remotes.iter().filter(|r| upstream.starts_with(&format!("{r}/"))).max_by_key(|r| r.len());
            let (remote, merge) = match remote {
                Some(r) => (r.as_str(), &upstream[r.len() + 1..]),
                None => (".", upstream),
            };
            self.git()?.args(["config", &format!("branch.{branch}.remote"), remote]).run().await?;
            self.git()?.args(["config", &format!("branch.{branch}.merge"), &format!("refs/heads/{merge}")]).run().await?;
            Ok(())
        }
        .await;
        if let Err(e) = result {
            log::warn!("upstream {upstream} of {branch} not restored: {}", e.message);
        }
    }

    /// Remove remote: add it again. If the entry recorded the remote branches and upstreams
    /// (`payload.refs`, `payload.upstreams`), they come back too; otherwise the remote
    /// branches only appear with the next fetch.
    async fn remove_remote(&self) -> CoreResult<()> {
        let remote = self.payload.get("remote").cloned().unwrap_or(Value::Null);
        let field = |key: &str| remote.get(key).and_then(Value::as_str).map(str::to_string).filter(|v| !v.is_empty());
        let (Some(name), Some(fetch_url)) = (field("name"), field("fetchUrl")) else { return Err(self.lost()) };
        if name.starts_with('-') || fetch_url.starts_with('-') {
            return Err(self.lost());
        }
        let listed = self.git()?.arg("remote").read_only().no_log().run().await?;
        let exists = listed.stdout_lines().into_iter().any(|line| line == name.as_bytes());
        match self.dir {
            Direction::Undo => {
                if exists {
                    return Err(self.stale());
                }
                self.git()?.args(["remote", "add", &name, &fetch_url]).run().await?;
                if let Some(push_url) = field("pushUrl").filter(|url| *url != fetch_url && !url.starts_with('-')) {
                    self.git()?.args(["remote", "set-url", "--push", &name, &push_url]).run().await?;
                }
                self.restore_remote_refs(&name).await;
            }
            Direction::Redo => {
                if !exists {
                    return Err(self.stale());
                }
                self.git()?.args(["remote", "remove", &name]).run().await?;
            }
        }
        Ok(())
    }

    /// Recreates the remote branches that disappeared with the remote and sets the upstreams
    /// of local branches again. Whatever fails is brought back by the next fetch or stays
    /// without an upstream – the remote itself is already back.
    async fn restore_remote_refs(&self, remote: &str) {
        let prefix = format!("refs/remotes/{remote}/");
        let list = |key: &str| self.payload.get(key).and_then(Value::as_array).cloned().unwrap_or_default();
        let result: CoreResult<()> = async {
            let mut script = String::new();
            for item in list("refs") {
                let (Some(name), Some(sha)) = (item.get("name").and_then(Value::as_str), item.get("sha").and_then(Value::as_str)) else { continue };
                let plain = name.starts_with(&prefix) && !name.contains(char::is_whitespace) && sha_like(sha);
                if plain && self.commit_exists(sha).await? {
                    script.push_str(&format!("update {name} {sha}\n"));
                }
            }
            if !script.is_empty() {
                self.git()?.args(["update-ref", "--stdin"]).stdin(script).run().await?;
            }
            for item in list("upstreams") {
                let (Some(branch), Some(merge)) = (item.get("branch").and_then(Value::as_str), item.get("merge").and_then(Value::as_str)) else { continue };
                if u::rev_parse(self.core, self.repo_id, &format!("refs/heads/{branch}")).await?.is_none() {
                    continue;
                }
                self.git()?.args(["config", &format!("branch.{branch}.remote"), remote]).run().await?;
                self.git()?.args(["config", &format!("branch.{branch}.merge"), merge]).run().await?;
            }
            Ok(())
        }
        .await;
        if let Err(e) = result {
            log::warn!("remote branches of {remote} not fully restored: {}", e.message);
        }
    }

    /// Stash: undo brings the changes back and removes the stash, redo stashes again.
    async fn stash(&mut self) -> CoreResult<()> {
        let Some(sha) = self.text("stashSha") else { return Err(self.lost()) };
        if self.payload.get("partial").and_then(Value::as_bool) == Some(true) {
            return self.partial_stash(&sha).await;
        }
        match self.dir {
            Direction::Undo => {
                let rows = stash::read_rows(self.core, self.repo_id).await?;
                let Some(index) = rows.iter().position(|row| row.sha == sha) else { return Err(self.stale()) };
                match stash::apply_stash(self.core, self.repo_id, index, &rows[index]).await? {
                    stash::ApplyOutcome::Done => stash::drop_stash(self.core, self.repo_id, index).await,
                    stash::ApplyOutcome::Conflict(_) => Err(CoreError::new(
                        ErrorCode::Conflict,
                        "Restoring the stash caused conflicts. The stash stays in the list; resolve the conflicts.",
                    )),
                }
            }
            Direction::Redo => {
                let message = self.text("message");
                let paths = self.paths();
                let include_untracked = self.payload.get("includeUntracked").and_then(Value::as_bool).unwrap_or(true);
                let Some(new_sha) = stash::push_stash(self.core, self.repo_id, message.as_deref(), paths.as_deref(), include_untracked).await? else {
                    return Err(self.stale());
                };
                // The new stash has a different SHA; the next undo must find it.
                self.payload.insert("stashSha".into(), json!(new_sha));
                self.save_payload()
            }
        }
    }

    /// Partial stash (selected lines): undo swaps the selected files and the index back to the
    /// backup and drops the stash; redo swaps forward again and puts the same stash commit back on
    /// the list (it stays reachable through the backup ref `stash`).
    async fn partial_stash(&mut self, sha: &str) -> CoreResult<()> {
        let paths = self.paths();
        match self.dir {
            Direction::Undo => {
                let rows = stash::read_rows(self.core, self.repo_id).await?;
                let Some(index) = rows.iter().position(|row| row.sha == sha) else { return Err(self.stale()) };
                self.swap_checked(paths.as_deref()).await?;
                stash::drop_stash(self.core, self.repo_id, index).await
            }
            Direction::Redo => {
                if !self.commit_exists(sha).await? {
                    return Err(self.lost());
                }
                self.swap_checked(paths.as_deref()).await?;
                let subject = self.text("stashSubject").unwrap_or_else(|| "Stash".to_string());
                stash::store_stash(self.core, self.repo_id, sha, &subject).await
            }
        }
    }

    /// Stash pop: undo restores the state before the pop and puts the stash back at its old
    /// place in the list; redo applies it again and removes it.
    async fn stash_pop(&mut self) -> CoreResult<()> {
        let Some(sha) = self.text("stashSha") else { return Err(self.lost()) };
        match self.dir {
            Direction::Undo => {
                if !self.commit_exists(&sha).await? {
                    return Err(self.lost());
                }
                let rows = stash::read_rows(self.core, self.repo_id).await?;
                if rows.iter().any(|row| row.sha == sha) {
                    return Err(self.stale());
                }
                self.swap_state(None, None).await?;
                let position = self.payload.get("stashIndex").and_then(Value::as_u64).unwrap_or(0) as usize;
                let position = position.min(rows.len());
                let subject = self.text("stashSubject").unwrap_or_else(|| "Stash".to_string());
                let mut top: Vec<(String, String)> = rows[..position].iter().map(|row| (row.sha.clone(), row.subject.clone())).collect();
                top.push((sha, subject));
                stash::rewrite_top(self.core, self.repo_id, &rows, position, &top).await
            }
            Direction::Redo => {
                let rows = stash::read_rows(self.core, self.repo_id).await?;
                let Some(index) = rows.iter().position(|row| row.sha == sha) else { return Err(self.stale()) };
                self.swap_state(None, None).await?;
                stash::drop_stash(self.core, self.repo_id, index).await
            }
        }
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod roundtrip_tests;
