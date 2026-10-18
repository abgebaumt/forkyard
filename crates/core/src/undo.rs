//! Undo/redo: storage, reading and the building blocks every reversible action needs
//! (backup refs, backing up and restoring the working directory).
//! Executing undo and redo lives in `commands::undo`.
//!
//! Flow inside a write action (within `with_write_lock`):
//! ```ignore
//! let id = undo::new_id();
//! // optional: backup, e.g. before a discard
//! let (worktree_sha, index_tree) = undo::snapshot_worktree(core, &repo_id, None).await?;
//! undo::create_backup_ref(core, &repo_id, &id, "worktree", &worktree_sha).await?;
//! undo::record(core, UndoRecord {
//!     id, repo_id: repo_id.clone(), worktree_path: String::new(),
//!     action: UndoAction::Discard, label: "Undo discarding 3 files".into(),
//!     ref_name: None, ref_before: None, ref_after: None,
//!     head_before: head.clone(), head_after: Some(head),
//!     payload: serde_json::json!({ "worktreeSnapshot": worktree_sha, "indexTree": index_tree, "paths": null }),
//! }).await?;
//! ```

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use crate::app::Core;
use crate::commands::status;
use crate::db::{self, undo::UndoEntry, undo::UndoEntryState};
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::{errors, GitCmd, GitOutput};
use crate::model::{Head, UndoState, UndoStep};
use crate::util;

/// Namespace of the backup refs.
pub const BACKUP_REF_PREFIX: &str = "refs/forkyard/undo/";

/// Reversible actions; values as in the CHECK list of `undo_entries.action`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UndoAction {
    Checkout,
    Commit,
    Amend,
    Discard,
    DeleteBranch,
    RemoveRemote,
    Reset,
    Rebase,
    CherryPick,
    Squash,
    Reword,
    Drop,
    Merge,
    Revert,
    Stash,
    StashPop,
    /// Several commits from the working directory at once (3.2).
    Compose,
    /// A plan of several Git steps (5).
    Plan,
    /// Coding agent ended and cleaned up: branch and worktree gone (2a).
    AgentCleanup,
    /// Lines taken over from a range of commits (`range_apply`).
    RangeApply,
    /// Branch split into stacked branches (8.1).
    StackCreate,
    /// Review comments taken over as `fixup!` commits (8.2).
    ReviewFixups,
}

impl UndoAction {
    pub const ALL: [UndoAction; 22] = [
        UndoAction::Checkout,
        UndoAction::Commit,
        UndoAction::Amend,
        UndoAction::Discard,
        UndoAction::DeleteBranch,
        UndoAction::RemoveRemote,
        UndoAction::Reset,
        UndoAction::Rebase,
        UndoAction::CherryPick,
        UndoAction::Squash,
        UndoAction::Reword,
        UndoAction::Drop,
        UndoAction::Merge,
        UndoAction::Revert,
        UndoAction::Stash,
        UndoAction::StashPop,
        UndoAction::Compose,
        UndoAction::Plan,
        UndoAction::AgentCleanup,
        UndoAction::RangeApply,
        UndoAction::StackCreate,
        UndoAction::ReviewFixups,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            UndoAction::Checkout => "checkout",
            UndoAction::Commit => "commit",
            UndoAction::Amend => "amend",
            UndoAction::Discard => "discard",
            UndoAction::DeleteBranch => "delete_branch",
            UndoAction::RemoveRemote => "remove_remote",
            UndoAction::Reset => "reset",
            UndoAction::Rebase => "rebase",
            UndoAction::CherryPick => "cherry_pick",
            UndoAction::Squash => "squash",
            UndoAction::Reword => "reword",
            UndoAction::Drop => "drop",
            UndoAction::Merge => "merge",
            UndoAction::Revert => "revert",
            UndoAction::Stash => "stash",
            UndoAction::StashPop => "stash_pop",
            UndoAction::Compose => "compose",
            UndoAction::Plan => "plan",
            UndoAction::AgentCleanup => "agent_cleanup",
            UndoAction::RangeApply => "range_apply",
            UndoAction::StackCreate => "stack_create",
            UndoAction::ReviewFixups => "review_fixups",
        }
    }

    /// Inverse of `as_str` (value from `undo_entries.action`).
    pub fn parse(value: &str) -> Option<UndoAction> {
        Self::ALL.into_iter().find(|a| a.as_str() == value)
    }

    /// Actions recorded with `record_group`: several refs and optionally a snapshot in one entry.
    pub fn is_group(self) -> bool {
        matches!(self, UndoAction::Compose | UndoAction::Plan | UndoAction::AgentCleanup | UndoAction::RangeApply | UndoAction::StackCreate | UndoAction::ReviewFixups)
    }
}

/// What an action records for undo.
#[derive(Debug, Clone)]
pub struct UndoRecord {
    /// From `new_id()`; create it beforehand when backup refs are created.
    pub id: String,
    pub repo_id: String,
    /// "" for the main working tree.
    pub worktree_path: String,
    pub action: UndoAction,
    /// Finished sentence for the tooltip, e.g. “Undo commit ‘Fix typo’”.
    pub label: String,
    /// Affected ref (e.g. `refs/heads/main`) with SHA before/after.
    pub ref_name: Option<String>,
    pub ref_before: Option<String>,
    pub ref_after: Option<String>,
    /// HEAD before (SHA or ref name); when unborn e.g. "refs/heads/main".
    pub head_before: String,
    pub head_after: Option<String>,
    /// Arbitrary payload of the action (JSON object).
    pub payload: Value,
}

pub fn new_id() -> String {
    util::new_id()
}

/// HEAD in the notation of the undo entries (`head_before`/`head_after`):
/// `refs/heads/<branch>` when HEAD is on a branch (even without a commit), otherwise the SHA.
pub fn head_token(head: &Head) -> String {
    match head {
        Head::Branch { branch, .. } | Head::Unborn { branch } => format!("refs/heads/{branch}"),
        Head::Detached { sha } => sha.clone(),
    }
}

/// The commit HEAD points to; `None` without a commit.
pub fn head_sha(head: &Head) -> Option<String> {
    match head {
        Head::Branch { sha, .. } | Head::Detached { sha } => Some(sha.clone()),
        Head::Unborn { .. } => None,
    }
}

/// Shortens a text for a label to at most `max` characters.
pub fn shorten(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut short: String = text.chars().take(max.saturating_sub(1)).collect();
    short.push('…');
    short
}

/// `refs/forkyard/undo/<entry_id>/<name>`
pub fn backup_ref_name(entry_id: &str, name: &str) -> String {
    format!("{BACKUP_REF_PREFIX}{entry_id}/{name}")
}

/// Creates a backup ref that protects `sha` from garbage collection; an existing one with
/// the same name is overwritten.
/// Does NOT take the write lock itself (runs inside the action).
pub async fn create_backup_ref(core: &Core, repo_id: &str, entry_id: &str, name: &str, sha: &str) -> CoreResult<String> {
    let refname = backup_ref_name(entry_id, name);
    core.git_for(repo_id)?.args(["update-ref", &refname, sha]).run().await?;
    Ok(refname)
}

/// Removes all backup refs of an entry. Does NOT take the write lock itself.
pub async fn delete_backup_refs(core: &Core, repo_id: &str, entry_id: &str) -> CoreResult<()> {
    let prefix = format!("{BACKUP_REF_PREFIX}{entry_id}/");
    let out = core.git_for(repo_id)?.args(["for-each-ref", "--format=%(refname)", &prefix]).read_only().run().await?;
    let mut script = String::new();
    for line in out.stdout_lines() {
        let name = util::decode_lossy(line);
        if !name.is_empty() {
            script.push_str(&format!("delete {name}\n"));
        }
    }
    if !script.is_empty() {
        core.git_for(repo_id)?.args(["update-ref", "--stdin"]).stdin(script).run().await?;
    }
    Ok(())
}

tokio::task_local! {
    /// Ids of the undo entries recorded inside a [`recording`] scope.
    static RECORDED: std::cell::RefCell<Vec<String>>;
}

/// Runs `work` and returns the ids of the undo entries it recorded – only its own, not those of
/// other actions that run meanwhile (a plan step's entries, for example).
pub async fn recording<T>(work: impl std::future::Future<Output = T>) -> (T, Vec<String>) {
    RECORDED
        .scope(std::cell::RefCell::new(Vec::new()), async move {
            let out = work.await;
            (out, RECORDED.with(|ids| ids.take()))
        })
        .await
}

/// Stores an undo entry and clears the repository's redo stack
/// (including its backup refs). Call within the write lock.
pub async fn record(core: &Core, rec: UndoRecord) -> CoreResult<UndoEntry> {
    let entry = UndoEntry {
        id: rec.id,
        repo_id: rec.repo_id,
        worktree_path: rec.worktree_path,
        action: rec.action.as_str().to_string(),
        label: rec.label,
        ref_name: rec.ref_name,
        ref_before: rec.ref_before,
        ref_after: rec.ref_after,
        head_before: rec.head_before,
        head_after: rec.head_after,
        payload: if rec.payload.is_null() { Value::Object(Default::default()) } else { rec.payload },
        state: UndoEntryState::Done,
        created_at: util::now_iso(),
    };
    let dropped = core.db.tx(|tx| {
        let redo = db::undo::list_undone(tx, &entry.repo_id, &entry.worktree_path)?;
        for e in &redo {
            db::undo::delete(tx, &e.id)?;
        }
        db::undo::insert(tx, &entry)?;
        Ok(redo)
    })?;
    let _ = RECORDED.try_with(|ids| ids.borrow_mut().push(entry.id.clone()));
    for old in dropped {
        if let Err(e) = delete_backup_refs(core, &old.repo_id, &old.id).await {
            log::warn!("Backup refs of {} not removed: {}", old.id, e.message);
        }
    }
    Ok(entry)
}

/// Next entry for undo (top of the undo stack).
pub fn next_undo(core: &Core, repo_id: &str, worktree_path: &str) -> CoreResult<Option<UndoEntry>> {
    core.db.with(|c| db::undo::top_done(c, repo_id, worktree_path))
}

/// Next entry for redo.
pub fn next_redo(core: &Core, repo_id: &str, worktree_path: &str) -> CoreResult<Option<UndoEntry>> {
    core.db.with(|c| db::undo::top_undone(c, repo_id, worktree_path))
}

/// Marks an entry as undone or redone.
pub fn set_state(core: &Core, entry_id: &str, state: UndoEntryState) -> CoreResult<()> {
    core.db.with(|c| db::undo::set_state(c, entry_id, state))
}

/// Replaces an entry's payload (undo and redo each record the other state there).
pub fn update_payload(core: &Core, entry_id: &str, payload: &Value) -> CoreResult<()> {
    core.db.with(|c| {
        c.execute("update undo_entries set payload = ?2 where id = ?1", rusqlite::params![entry_id, payload.to_string()])?;
        Ok(())
    })
}

/// What undo and redo would do right now (for the toolbar button). The stored label
/// describes the undo; for the redo step it is rephrased.
pub fn peek(core: &Core, repo_id: &str, worktree_path: &str) -> CoreResult<UndoState> {
    Ok(UndoState {
        undo: next_undo(core, repo_id, worktree_path)?.map(|e| UndoStep { label: undo_label(&e), action: e.action }),
        redo: next_redo(core, repo_id, worktree_path)?.map(|e| UndoStep { label: redo_label(&e.label), action: e.action }),
        undo_blocked: None,
    })
}

/// Note that must not be withheld when undoing “remove remote”.
pub const REMOTE_REFS_NOTE: &str = "remote branches only reappear after the next fetch";

/// Label of the undo step. For “remove remote” without recorded remote branches, the note
/// is added that only the next fetch brings them back.
pub fn undo_label(entry: &UndoEntry) -> String {
    let keeps_refs = entry.payload.get("refs").is_some_and(Value::is_array);
    if entry.action == UndoAction::RemoveRemote.as_str() && !keeps_refs && !entry.label.to_ascii_lowercase().contains("fetch") {
        format!("{} ({REMOTE_REFS_NOTE})", entry.label)
    } else {
        entry.label.clone()
    }
}

/// `Undo commit “x”` → `Redo commit “x”`.
pub fn redo_label(label: &str) -> String {
    match label.strip_prefix("Undo ") {
        Some(rest) => format!("Redo {rest}"),
        None => format!("Redo: {label}"),
    }
}

/// Deletes entries older than `days` days, including their backup refs.
/// Takes the write lock per repository.
pub async fn cleanup_older_than(core: &Core, days: i64) -> CoreResult<()> {
    let before = util::iso_days_ago(days);
    let old = core.db.with(|c| db::undo::older_than(c, &before))?;
    for (id, repo_id) in old {
        if core.repo_path(&repo_id).is_ok() {
            let result = core
                .with_write_lock(&repo_id, &[], async { delete_backup_refs(core, &repo_id, &id).await })
                .await;
            if let Err(e) = result {
                log::warn!("Backup refs of {id} not removed: {}", e.message);
            }
        }
        core.db.with(|c| db::undo::delete(c, &id))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Backing up and restoring the working directory
// ---------------------------------------------------------------------------

/// Message of the backup commits.
pub const SNAPSHOT_MESSAGE: &str = "forkyard: backup";

/// Fixed identity of the backup commits so they can be created even without user.name/user.email.
const SNAPSHOT_IDENTITY: [(&str, &str); 4] = [
    ("GIT_AUTHOR_NAME", "forkyard"),
    ("GIT_AUTHOR_EMAIL", "forkyard@localhost"),
    ("GIT_COMMITTER_NAME", "forkyard"),
    ("GIT_COMMITTER_EMAIL", "forkyard@localhost"),
];

/// Resolves a name to a SHA; `None` if it doesn't exist.
pub async fn rev_parse(core: &Core, repo_id: &str, rev: &str) -> CoreResult<Option<String>> {
    let out = core
        .git_for(repo_id)?
        .args(["rev-parse", "-q", "--verify", "--end-of-options", rev])
        .read_only()
        .no_log()
        .run_raw()
        .await?;
    Ok(if out.success() { Some(out.stdout_text()).filter(|s| !s.is_empty()) } else { None })
}

/// Temporary index file in the Git directory; deleted on drop.
struct TempIndex(PathBuf);

impl TempIndex {
    fn new(git_dir: &Path) -> Self {
        TempIndex(git_dir.join(format!("forkyard-{}.index", util::new_id())))
    }
}

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let mut lock = self.0.clone().into_os_string();
        lock.push(".lock");
        let _ = std::fs::remove_file(lock);
    }
}

fn join_z(paths: &[String]) -> Vec<u8> {
    let mut data = Vec::new();
    for p in paths {
        data.extend_from_slice(p.as_bytes());
        data.push(0);
    }
    data
}

fn add_all(core: &Core, repo_id: &str, index: &TempIndex) -> CoreResult<GitCmd> {
    Ok(core
        .git_for(repo_id)?
        .args(["-c", "core.safecrlf=false", "add", "-A"])
        .env("GIT_INDEX_FILE", &index.0)
        .env("GIT_LITERAL_PATHSPECS", "1")
        .no_log())
}

fn pathspec_missing(out: &GitOutput) -> bool {
    out.stderr_text().to_lowercase().contains("did not match any file")
}

/// `git add -A` into the temporary index file, then `git write-tree`.
async fn add_and_write_tree(core: &Core, repo_id: &str, index: &TempIndex, paths: Option<&[String]>) -> CoreResult<String> {
    match paths {
        None => {
            add_all(core, repo_id, index)?.run().await?;
        }
        Some(paths) => {
            let out = add_all(core, repo_id, index)?
                .args(["--pathspec-from-file=-", "--pathspec-file-nul"])
                .stdin(join_z(paths))
                .run_raw()
                .await?;
            if !out.success() {
                if !pathspec_missing(&out) {
                    return Err(errors::classify("add", out.code, &out.stdout, &out.stderr));
                }
                // A path exists neither in the index nor on disk: add the remaining ones one by one.
                for path in paths {
                    let one = add_all(core, repo_id, index)?.arg("--").arg(path).run_raw().await?;
                    if !one.success() && !pathspec_missing(&one) {
                        return Err(errors::classify("add", one.code, &one.stdout, &one.stderr));
                    }
                }
            }
        }
    }
    core.git_for(repo_id)?.arg("write-tree").env("GIT_INDEX_FILE", &index.0).no_log().run_text().await
}

/// Tree of the current working directory: tracked and untracked (not ignored) files as
/// they are on disk. With `paths` this only applies to those paths; the rest of the tree
/// is then unspecified (index or HEAD state) and is not touched when restoring. The real
/// index stays untouched.
pub async fn worktree_tree(core: &Core, repo_id: &str, paths: Option<&[String]>) -> CoreResult<String> {
    let git_dir = status::git_dir(core, repo_id).await?;
    let copy = copy_index(&git_dir);
    tree_from(core, repo_id, &git_dir, copy, paths).await
}

/// Copy of the real index as a starting point, so Git doesn't have to rehash unchanged
/// files. `None` if there is no index (yet) or copying fails.
fn copy_index(git_dir: &Path) -> Option<TempIndex> {
    let real_index = git_dir.join("index");
    if !real_index.is_file() {
        return None;
    }
    let index = TempIndex::new(git_dir);
    util::copy_index_file(&real_index, &index.0).ok().map(|_| index)
}

async fn tree_from(core: &Core, repo_id: &str, git_dir: &Path, copy: Option<TempIndex>, paths: Option<&[String]>) -> CoreResult<String> {
    if let Some(index) = copy {
        if let Ok(tree) = add_and_write_tree(core, repo_id, &index, paths).await {
            return Ok(tree);
        }
    }
    // The documented way: index from HEAD (without a commit: empty index).
    let index = TempIndex::new(git_dir);
    if rev_parse(core, repo_id, "HEAD^{commit}").await?.is_some() {
        core.git_for(repo_id)?.args(["read-tree", "HEAD"]).env("GIT_INDEX_FILE", &index.0).no_log().run().await?;
    }
    add_and_write_tree(core, repo_id, &index, paths).await
}

/// Tree of the real index; `None` while conflicts are open (then there is no tree).
pub async fn index_tree(core: &Core, repo_id: &str) -> CoreResult<Option<String>> {
    let unmerged = core.git_for(repo_id)?.args(["ls-files", "--unmerged", "-z"]).read_only().no_log().run().await?;
    if !unmerged.stdout.is_empty() {
        return Ok(None);
    }
    Ok(Some(core.git_for(repo_id)?.arg("write-tree").no_log().run_text().await?))
}

/// Backs up the working directory as a commit (parent HEAD, if any) and returns
/// `(worktree_sha, index_tree)`: the backup commit and the tree of the real index
/// (`None` while conflicts are open). `paths: None` backs up everything, otherwise only
/// these paths (literal, no patterns).
///
/// The commit is not on any ref: the caller keeps it with
/// `create_backup_ref(core, repo_id, &id, "worktree", &worktree_sha)`.
/// Does NOT take the write lock itself.
pub async fn snapshot_worktree(core: &Core, repo_id: &str, paths: Option<&[String]>) -> CoreResult<(String, Option<String>)> {
    let snapshot = snapshot(core, repo_id, paths).await?;
    Ok((snapshot.commit, snapshot.index_tree))
}

/// Result of `snapshot`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    /// The backup commit.
    pub commit: String,
    /// Its tree: the state of the working directory.
    pub tree: String,
    /// Tree of the real index; `None` while conflicts are open.
    pub index_tree: Option<String>,
}

/// Like `snapshot_worktree`, additionally returns the backup's tree.
pub async fn snapshot(core: &Core, repo_id: &str, paths: Option<&[String]>) -> CoreResult<Snapshot> {
    let git_dir = status::git_dir(core, repo_id).await?;
    // Copy first, then continue in parallel: `write-tree` may rewrite the real index meanwhile.
    let copy = copy_index(&git_dir);
    let (tree, head, index_tree) = tokio::join!(
        tree_from(core, repo_id, &git_dir, copy, paths),
        rev_parse(core, repo_id, "HEAD^{commit}"),
        index_tree(core, repo_id),
    );
    let (tree, head, index_tree) = (tree?, head?, index_tree?);
    let mut cmd = core.git_for(repo_id)?.args(["commit-tree", &tree]).no_log();
    if let Some(head) = &head {
        cmd = cmd.args(["-p", head]);
        if let Some(raw) = raw_overlay(core, repo_id, head, &tree, paths).await {
            cmd = cmd.args(["-p", &raw]);
        }
    }
    for (key, value) in SNAPSHOT_IDENTITY {
        cmd = cmd.env(key, value);
    }
    let commit = cmd.args(["-m", SNAPSHOT_MESSAGE]).run_text().await?;
    Ok(Snapshot { commit, tree, index_tree })
}

/// Message of the commit that carries a backup's raw versions (its second parent).
const RAW_MESSAGE: &str = "forkyard: raw versions";
/// Larger files get no raw version (they would otherwise end up twice in the object database).
const RAW_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// The backup is created via `git add` and written back via `checkout-index` – the repository's
/// filters apply in both directions. With `core.autocrlf` (or `eol` attributes) a file with pure LF
/// or mixed line endings would therefore come back normalised. For the files that differ between
/// the backup `tree` and `head`, this commit records the bytes as they are on disk (hashed without
/// filters); it becomes the second parent of the backup commit and so lives as long as that one.
///
/// `None` if there is nothing to record: no changed files, or their bytes are exactly those of the
/// backup and a checkout would not change them. Errors are no reason to give up the backup – it
/// then applies without raw versions.
pub(crate) async fn raw_overlay(core: &Core, repo_id: &str, head: &str, tree: &str, paths: Option<&[String]>) -> Option<String> {
    match raw_overlay_commit(core, repo_id, head, tree, paths).await {
        Ok(commit) => commit,
        Err(e) => {
            log::warn!("Raw versions for the backup not recorded: {}", e.message);
            None
        }
    }
}

async fn raw_overlay_commit(core: &Core, repo_id: &str, head: &str, tree: &str, paths: Option<&[String]>) -> CoreResult<Option<String>> {
    let root = core.repo_path(repo_id)?;
    let changed = diff_raw(core, repo_id, head, tree, paths).await?;
    // Regular files of the backup that exist as a file on disk. (`--stdin-paths` splits at
    // newlines: names containing a newline are left out.)
    let candidates: Vec<&(Vec<u8>, RawChange)> = changed
        .iter()
        .filter(|(path, change)| !is_zero(&change.new) && regular_file(&change.new_mode) && !path.contains(&b'\n') && !path.contains(&b'\r'))
        .filter(|(path, _)| std::fs::symlink_metadata(util::join_from_git(&root, path)).is_ok_and(|meta| meta.is_file() && meta.len() <= RAW_MAX_BYTES))
        .collect();
    if candidates.is_empty() {
        return Ok(None);
    }
    let mut input = Vec::new();
    for (path, _) in &candidates {
        input.extend_from_slice(path);
        input.push(b'\n');
    }
    // With -w: new objects are only created where the raw bytes differ from the backup's version.
    let hashed = core.git_for(repo_id)?.args(["hash-object", "-w", "--no-filters", "--stdin-paths"]).stdin(input).no_log().run().await?;
    let ids: Vec<String> = hashed.stdout_lines().into_iter().map(util::decode_lossy).map(|id| id.trim().to_string()).filter(|id| !id.is_empty()).collect();
    if ids.len() != candidates.len() {
        return Ok(None);
    }
    let differs = candidates.iter().zip(&ids).any(|((_, change), id)| *id != change.new);
    // Even byte-identical versions would come back changed if a checkout rewrites line endings.
    let checkout_converts = if differs { true } else { checkout_rewrites_line_endings(core, repo_id).await };
    if !checkout_converts {
        return Ok(None);
    }
    let git_dir = status::git_dir(core, repo_id).await?;
    let index = TempIndex::new(&git_dir);
    let mut info = Vec::new();
    for ((path, change), id) in candidates.iter().zip(&ids) {
        info.extend_from_slice(format!("{} {id}\t", change.new_mode).as_bytes());
        info.extend_from_slice(path);
        info.push(0);
    }
    core.git_for(repo_id)?.args(["update-index", "-z", "--index-info"]).env("GIT_INDEX_FILE", &index.0).stdin(info).no_log().run().await?;
    let raw_tree = core.git_for(repo_id)?.arg("write-tree").env("GIT_INDEX_FILE", &index.0).no_log().run_text().await?;
    let mut cmd = core.git_for(repo_id)?.args(["commit-tree", &raw_tree]).no_log();
    for (key, value) in SNAPSHOT_IDENTITY {
        cmd = cmd.env(key, value);
    }
    Ok(Some(cmd.args(["-m", RAW_MESSAGE]).run_text().await?).filter(|sha| !sha.is_empty()))
}

/// Whether a checkout would write files with LF line endings as CRLF (`core.autocrlf=true`).
async fn checkout_rewrites_line_endings(core: &Core, repo_id: &str) -> bool {
    let Ok(cmd) = core.git_for(repo_id) else { return false };
    match cmd.args(["config", "--get", "core.autocrlf"]).read_only().no_log().run_raw().await {
        Ok(out) => out.success() && out.stdout_text().trim().eq_ignore_ascii_case("true"),
        Err(_) => false,
    }
}

/// Tree of a backup's raw versions (see [`raw_overlay`]); `None` if `target` has none.
async fn raw_tree_of(core: &Core, repo_id: &str, target: &str) -> Option<String> {
    let parent = rev_parse(core, repo_id, &format!("{target}^2")).await.ok()??;
    // A real merge commit also has a second parent: only our own counts.
    let subject = core.git_for(repo_id).ok()?.args(["log", "-1", "--format=%s%n%P", &parent]).read_only().no_log().run_raw().await.ok()?;
    let text = subject.stdout_text();
    let mut lines = text.lines();
    if !subject.success() || lines.next() != Some(RAW_MESSAGE) || lines.next().is_some_and(|parents| !parents.trim().is_empty()) {
        return None;
    }
    rev_parse(core, repo_id, &format!("{parent}^{{tree}}")).await.ok()?
}

/// Output of `git cat-file --batch`: per object `<id> <type> <size>\n<content>\n`, missing ones as `<id> missing\n`.
fn parse_cat_file_batch(out: &[u8]) -> Vec<Option<&[u8]>> {
    let mut contents = Vec::new();
    let mut at = 0;
    while at < out.len() {
        let Some(end) = out[at..].iter().position(|byte| *byte == b'\n') else { break };
        let header = String::from_utf8_lossy(&out[at..at + end]).into_owned();
        at += end + 1;
        if header.ends_with(" missing") || header.ends_with(" ambiguous") {
            contents.push(None);
            continue;
        }
        let Some(size) = header.rsplit(' ').next().and_then(|size| size.parse::<usize>().ok()) else { break };
        if at + size > out.len() {
            break;
        }
        contents.push(Some(&out[at..at + size]));
        at += size + 1;
    }
    contents
}

#[cfg(test)]
pub(crate) fn parse_cat_file_batch_for_tests(out: &[u8]) -> Vec<Option<&[u8]>> {
    parse_cat_file_batch(out)
}

/// For the just restored files `written`, writes back the raw version from `raw_tree` where
/// `checkout-index` left different bytes (line endings).
async fn restore_raw(core: &Core, repo_id: &str, raw_tree: &str, written: &[&Vec<u8>]) -> CoreResult<()> {
    if written.is_empty() {
        return Ok(());
    }
    let root = core.repo_path(repo_id)?;
    let listed = core.git_for(repo_id)?.args(["ls-tree", "-r", "-z", raw_tree]).read_only().no_log().run().await?;
    let mut raw: std::collections::HashMap<&[u8], String> = std::collections::HashMap::new();
    for record in listed.stdout_z() {
        let Some(tab) = record.iter().position(|byte| *byte == b'\t') else { continue };
        let meta = String::from_utf8_lossy(&record[..tab]).into_owned();
        if let Some(id) = meta.split(' ').nth(2) {
            raw.insert(&record[tab + 1..], id.to_string());
        }
    }
    let wanted: Vec<(&Vec<u8>, &String)> = written
        .iter()
        .filter_map(|path| raw.get(path.as_slice()).map(|id| (*path, id)))
        .filter(|(path, _)| std::fs::symlink_metadata(util::join_from_git(&root, path)).is_ok_and(|meta| meta.is_file()))
        .collect();
    if wanted.is_empty() {
        return Ok(());
    }
    let mut input = Vec::new();
    for (path, _) in &wanted {
        input.extend_from_slice(path);
        input.push(b'\n');
    }
    let hashed = core.git_for(repo_id)?.args(["hash-object", "--no-filters", "--stdin-paths"]).stdin(input).read_only().no_log().run().await?;
    let now: Vec<String> = hashed.stdout_lines().into_iter().map(util::decode_lossy).map(|id| id.trim().to_string()).filter(|id| !id.is_empty()).collect();
    if now.len() != wanted.len() {
        return Ok(());
    }
    let differing: Vec<&(&Vec<u8>, &String)> = wanted.iter().zip(&now).filter(|((_, id), current)| *id != *current).map(|(item, _)| item).collect();
    if differing.is_empty() {
        return Ok(());
    }
    let ids: Vec<u8> = differing.iter().flat_map(|(_, id)| id.bytes().chain(std::iter::once(b'\n'))).collect();
    let blobs = core.git_for(repo_id)?.args(["cat-file", "--batch"]).stdin(ids).read_only().no_log().run().await?;
    let contents = parse_cat_file_batch(&blobs.stdout);
    if contents.len() != differing.len() {
        return Ok(());
    }
    for ((path, _), content) in differing.iter().zip(contents) {
        let Some(content) = content else { continue };
        if let Err(e) = std::fs::write(util::join_from_git(&root, path), content) {
            log::warn!("Raw version of {} not written back: {e}", util::decode_lossy(path));
        }
    }
    Ok(())
}

fn in_paths(path: &[u8], paths: &[String]) -> bool {
    paths.iter().any(|p| {
        let p = p.trim_end_matches('/').as_bytes();
        p.is_empty() || path == p || (path.len() > p.len() && path.starts_with(p) && path[p.len()] == b'/')
    })
}

/// Paths from Git are relative and without `..`; still, never delete outside the working
/// directory or inside the Git directory.
fn safe_relative(rel: &Path) -> bool {
    use std::path::Component;
    let mut count = 0;
    for part in rel.components() {
        match part {
            Component::Normal(name) => {
                if count == 0 && name.eq_ignore_ascii_case(".git") {
                    return false;
                }
            }
            _ => return false,
        }
        count += 1;
    }
    count > 0
}

/// Deletes a file of the working directory and then folders that became empty.
/// Directories (e.g. embedded repositories) are left alone.
fn remove_worktree_file(root: &Path, rel: &[u8]) -> CoreResult<()> {
    let rel = util::bytes_to_path(rel);
    if !safe_relative(&rel) {
        return Ok(());
    }
    let full = root.join(&rel);
    let Ok(meta) = std::fs::symlink_metadata(&full) else {
        return Ok(());
    };
    if meta.is_dir() {
        return Ok(());
    }
    if let Err(first) = std::fs::remove_file(&full) {
        // Windows: read-only files and directory links need a second attempt.
        let mut perms = meta.permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        let _ = std::fs::set_permissions(&full, perms);
        if std::fs::remove_file(&full).is_err() && std::fs::remove_dir(&full).is_err() {
            return Err(CoreError::new(
                ErrorCode::Io,
                format!("The file “{}” couldn’t be removed: {first}", util::display_path(&rel)),
            ));
        }
    }
    let mut dir = full.parent();
    while let Some(d) = dir {
        if d == root || std::fs::remove_dir(d).is_err() {
            break;
        }
        dir = d.parent();
    }
    Ok(())
}

/// Brings the working directory to the state of `target` (backup commit, commit or tree):
/// changed and missing files are written from it, files that don't exist there are
/// deleted – untracked ones too, but never ignored ones. With `paths` only within those
/// paths. HEAD and the real index stay untouched (use `restore_index` for that).
/// Does NOT take the write lock itself.
pub async fn restore_worktree(core: &Core, repo_id: &str, target: &str, paths: Option<&[String]>) -> CoreResult<()> {
    let current = worktree_tree(core, repo_id, paths).await?;
    restore_worktree_from(core, repo_id, &current, target, paths).await
}

/// Like `restore_worktree`, when the tree of the current working directory is already known
/// (`Snapshot::tree` of a backup just created with the same `paths`).
pub async fn restore_worktree_from(core: &Core, repo_id: &str, current: &str, target: &str, paths: Option<&[String]>) -> CoreResult<()> {
    match plan_restore(core, repo_id, None, current, target, paths).await? {
        Ok(plan) => apply_restore(core, repo_id, &plan).await,
        // Without a base there are no files that could have been “changed since”.
        Err(_) => Ok(()),
    }
}

/// One line of `git diff-tree --raw`: mode and blob before and after.
#[derive(Debug, Clone)]
struct RawChange {
    old_mode: String,
    new_mode: String,
    old: String,
    new: String,
    status: u8,
}

fn is_zero(sha: &str) -> bool {
    sha.bytes().all(|b| b == b'0')
}

fn regular_file(mode: &str) -> bool {
    mode == "100644" || mode == "100755"
}

/// Per-path differences of two trees (without rename detection), limited to `paths`.
async fn diff_raw(core: &Core, repo_id: &str, from: &str, to: &str, paths: Option<&[String]>) -> CoreResult<Vec<(Vec<u8>, RawChange)>> {
    let out = core
        .git_for(repo_id)?
        .args(["diff-tree", "-r", "-z", "--raw", "--no-abbrev", "--no-renames", from, to])
        .read_only()
        .no_log()
        .run()
        .await?;
    let records = out.stdout_z();
    let mut changes = Vec::new();
    for pair in records.chunks(2) {
        let [meta, path] = pair else { continue };
        if paths.is_some_and(|p| !in_paths(path, p)) {
            continue;
        }
        let text = String::from_utf8_lossy(meta);
        let mut parts = text.trim_start_matches(':').split(' ');
        let (Some(old_mode), Some(new_mode), Some(old), Some(new), Some(status)) = (parts.next(), parts.next(), parts.next(), parts.next(), parts.next()) else {
            continue;
        };
        changes.push((
            path.to_vec(),
            RawChange { old_mode: old_mode.into(), new_mode: new_mode.into(), old: old.into(), new: new.into(), status: status.bytes().next().unwrap_or(b'M') },
        ));
    }
    Ok(changes)
}

/// What `apply_restore` does to the working directory.
#[derive(Debug, Default)]
pub struct RestorePlan {
    target_tree: String,
    /// Tree with the backup's raw versions (bytes as on disk), if it has any.
    raw_tree: Option<String>,
    /// Files that don't exist in the target.
    delete: Vec<Vec<u8>>,
    /// Files whose type changes (file ↔ link ↔ submodule): removed first, then recreated.
    retype: Vec<Vec<u8>>,
    /// Files written from the target.
    write: Vec<Vec<u8>>,
    /// Files edited further since the action: (mode, blob, path) of the merged version.
    merged: Vec<(String, String, Vec<u8>)>,
}

impl RestorePlan {
    pub fn is_empty(&self) -> bool {
        self.delete.is_empty() && self.retype.is_empty() && self.write.is_empty() && self.merged.is_empty()
    }
}

/// Plans how the working directory (tree `current`) gets to the backed-up state `target`
/// without destroying work created since the action.
///
/// `base` is the state right after the action being undone (or after the undo being redone).
/// With it, only what the action itself changed is played back (`base` → `target`);
/// everything the user created or changed since stays:
/// - file not touched by the action → stays as it is;
/// - file unchanged since the action → is written from `target` or deleted;
/// - file changed by both → three-way merge of the content. If it doesn't merge cleanly,
///   the path is in the error list (`Err`) and nothing is changed.
///
/// Without `base` (entries from older versions) the whole difference `current` → `target` applies.
/// Only reads (and at most creates blobs); only `apply_restore` touches the working directory.
pub async fn plan_restore(
    core: &Core,
    repo_id: &str,
    base: Option<&str>,
    current: &str,
    target: &str,
    paths: Option<&[String]>,
) -> CoreResult<Result<RestorePlan, Vec<String>>> {
    let Some(target_tree) = rev_parse(core, repo_id, &format!("{target}^{{tree}}")).await? else {
        return Err(CoreError::not_found("The backup for this action no longer exists."));
    };
    let mut plan = RestorePlan { target_tree: target_tree.clone(), ..RestorePlan::default() };
    if current == target_tree {
        return Ok(Ok(plan));
    }
    plan.raw_tree = raw_tree_of(core, repo_id, target).await;
    let base_tree = match base {
        Some(base) => rev_parse(core, repo_id, &format!("{base}^{{tree}}")).await?,
        None => None,
    };
    // (changed since the action, changed by the action) – only with a known base.
    let known = match &base_tree {
        Some(base_tree) => {
            let since: std::collections::HashMap<Vec<u8>, RawChange> =
                if base_tree == current { Default::default() } else { diff_raw(core, repo_id, base_tree, current, paths).await?.into_iter().collect() };
            let wanted: std::collections::HashSet<Vec<u8>> = diff_raw(core, repo_id, base_tree, &target_tree, paths).await?.into_iter().map(|(path, _)| path).collect();
            Some((since, wanted))
        }
        None => None,
    };
    let mut blocked: Vec<String> = Vec::new();
    let git_dir = status::git_dir(core, repo_id).await?;
    for (path, change) in diff_raw(core, repo_id, current, &target_tree, paths).await? {
        if let Some((since, wanted)) = &known {
            if !wanted.contains(&path) {
                // Only the user has touched this file since: it stays.
                continue;
            }
            if let Some(mine) = since.get(&path) {
                match merge_content(core, repo_id, &git_dir, mine, &change).await? {
                    Some(blob) => plan.merged.push((mine.new_mode.clone(), blob, path)),
                    None => blocked.push(util::decode_lossy(&path)),
                }
                continue;
            }
        }
        if is_zero(&change.new) {
            plan.delete.push(path);
        } else if change.status == b'T' {
            plan.retype.push(path);
        } else {
            plan.write.push(path);
        }
    }
    if blocked.is_empty() {
        Ok(Ok(plan))
    } else {
        Ok(Err(blocked))
    }
}

/// Temporary file in the Git directory; deleted on drop.
struct TempFile(PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Three-way merge of a file: `mine` is base → now, `theirs` is now → target.
/// Returns the blob of the merged version; `None` if the changes overlap or the file is
/// not a regular text file (deleted, binary, link).
async fn merge_content(core: &Core, repo_id: &str, git_dir: &Path, mine: &RawChange, theirs: &RawChange) -> CoreResult<Option<String>> {
    let blobs = [&mine.new, &mine.old, &theirs.new];
    let modes = [&mine.new_mode, &mine.old_mode, &theirs.new_mode];
    if blobs.iter().any(|sha| is_zero(sha)) || modes.iter().any(|mode| !regular_file(mode)) {
        return Ok(None);
    }
    let id = util::new_id();
    let mut files = Vec::new();
    for (name, sha) in ["jetzt", "basis", "ziel"].iter().zip(blobs) {
        let out = core.git_for(repo_id)?.args(["cat-file", "blob", sha]).read_only().no_log().run_raw().await?;
        if !out.success() || util::looks_binary(&out.stdout) {
            return Ok(None);
        }
        let file = TempFile(git_dir.join(format!("forkyard-merge-{id}-{name}")));
        std::fs::write(&file.0, &out.stdout)?;
        files.push(file);
    }
    let out = core
        .git_for(repo_id)?
        .args(["merge-file", "-p", "-q"])
        .arg(&files[0].0)
        .arg(&files[1].0)
        .arg(&files[2].0)
        .read_only()
        .no_log()
        .run_raw()
        .await?;
    // Exit code = number of conflicts; anything but 0 means: not mergeable.
    if out.code != Some(0) {
        return Ok(None);
    }
    let blob = core.git_for(repo_id)?.args(["hash-object", "-w", "--stdin"]).stdin(out.stdout).no_log().run_text().await?;
    Ok(Some(blob).filter(|sha| !sha.is_empty()))
}

/// Those of `paths` that are ignored by the rules now in effect (tracked ones too).
async fn ignored_among(core: &Core, repo_id: &str, paths: &[Vec<u8>]) -> std::collections::HashSet<Vec<u8>> {
    if paths.is_empty() {
        return Default::default();
    }
    let checked = match core.git_for(repo_id) {
        Ok(cmd) => cmd.args(["check-ignore", "--no-index", "-z", "--stdin"]).stdin(join_z_bytes(paths)).read_only().no_log().run_raw().await,
        Err(e) => Err(e),
    };
    match checked {
        Ok(out) if out.code == Some(0) => out.stdout_z().into_iter().map(<[u8]>::to_vec).collect(),
        _ => Default::default(),
    }
}

fn join_z_bytes(paths: &[Vec<u8>]) -> Vec<u8> {
    let mut data = Vec::new();
    for path in paths {
        data.extend_from_slice(path);
        data.push(0);
    }
    data
}

fn is_ignore_file(path: &[u8]) -> bool {
    path == b".gitignore" || path.ends_with(b"/.gitignore")
}

/// Executes a plan from `plan_restore`. HEAD and the real index stay untouched.
/// Files that don't exist in the target are deleted – unless they are ignored by the
/// target's rules: there was never a backup of them, so they are not part of what the
/// action changed. Does NOT take the write lock itself.
pub async fn apply_restore(core: &Core, repo_id: &str, plan: &RestorePlan) -> CoreResult<()> {
    if plan.is_empty() {
        return Ok(());
    }
    let root = core.repo_path(repo_id)?;
    // Where a file changes its type, the spot must be free.
    for path in &plan.retype {
        remove_worktree_file(&root, path)?;
    }
    let git_dir = status::git_dir(core, repo_id).await?;
    let index = TempIndex::new(&git_dir);
    core.git_for(repo_id)?.args(["read-tree", &plan.target_tree]).env("GIT_INDEX_FILE", &index.0).no_log().run().await?;
    if !plan.merged.is_empty() {
        let mut info = Vec::new();
        for (mode, blob, path) in &plan.merged {
            info.extend_from_slice(format!("{mode} {blob}\t").as_bytes());
            info.extend_from_slice(path);
            info.push(0);
        }
        core.git_for(repo_id)?.args(["update-index", "-z", "--index-info"]).env("GIT_INDEX_FILE", &index.0).stdin(info).no_log().run().await?;
    }
    let all_writes = || plan.write.iter().chain(&plan.retype).chain(plan.merged.iter().map(|(_, _, path)| path));
    // First restore the target's ignore rules: they decide what gets deleted.
    let rules: Vec<&Vec<u8>> = all_writes().filter(|path| is_ignore_file(path)).collect();
    checkout_from(core, repo_id, &index, &rules).await?;
    let ignored = ignored_among(core, repo_id, &plan.delete).await;
    // Then delete: where a file gives way to a folder (or vice versa), the spot must be free.
    for path in plan.delete.iter().filter(|path| !ignored.contains(*path)) {
        remove_worktree_file(&root, path)?;
    }
    let rest: Vec<&Vec<u8>> = all_writes().filter(|path| !is_ignore_file(path)).collect();
    checkout_from(core, repo_id, &index, &rest).await?;
    // Merged files are new versions; for all others, what was on disk applies.
    if let Some(raw_tree) = &plan.raw_tree {
        let verbatim: Vec<&Vec<u8>> = plan.write.iter().chain(&plan.retype).collect();
        if let Err(e) = restore_raw(core, repo_id, raw_tree, &verbatim).await {
            log::warn!("Raw versions not written back: {}", e.message);
        }
    }
    Ok(())
}

/// Writes `paths` from the temporary index file into the working directory.
async fn checkout_from(core: &Core, repo_id: &str, index: &TempIndex, paths: &[&Vec<u8>]) -> CoreResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut input = Vec::new();
    for path in paths {
        input.extend_from_slice(path);
        input.push(0);
    }
    core.git_for(repo_id)?
        .args(["checkout-index", "-f", "-z", "--stdin"])
        .env("GIT_INDEX_FILE", &index.0)
        .stdin(input)
        .no_log()
        .run()
        .await?;
    Ok(())
}

/// Records the current state of the working directory as a commit under
/// `refs/forkyard/undo/<entry_id>/<name>` and returns its SHA: the state `plan_restore` later
/// uses to tell what has been added since. Does NOT take the write lock itself.
pub async fn keep_result(core: &Core, repo_id: &str, entry_id: &str, name: &str, paths: Option<&[String]>) -> CoreResult<String> {
    let tree = worktree_tree(core, repo_id, paths).await?;
    let mut cmd = core.git_for(repo_id)?.args(["commit-tree", &tree]).no_log();
    for (key, value) in SNAPSHOT_IDENTITY {
        cmd = cmd.env(key, value);
    }
    let commit = cmd.args(["-m", "forkyard: state after the action"]).run_text().await?;
    create_backup_ref(core, repo_id, entry_id, name, &commit).await?;
    Ok(commit)
}

/// Writes the state after the action into an already stored undo entry
/// (`payload.resultSnapshot`). If that fails, the provisional value stays.
pub async fn record_result(core: &Core, repo_id: &str, entry_id: &str, paths: Option<&[String]>) {
    let result: CoreResult<()> = async {
        let commit = keep_result(core, repo_id, entry_id, "result", paths).await?;
        core.db.with(|c| {
            c.execute(
                "update undo_entries set payload = json_set(payload, '$.resultSnapshot', ?2) where id = ?1",
                rusqlite::params![entry_id, commit],
            )?;
            Ok(())
        })
    }
    .await;
    if let Err(e) = result {
        log::warn!("State after action {entry_id} not recorded: {}", e.message);
    }
}

/// The empty tree – the state “after the action” when there is no commit yet.
pub const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// Sets the real index to `tree` (tree or commit) without touching the working directory.
/// Does NOT take the write lock itself.
pub async fn restore_index(core: &Core, repo_id: &str, tree: &str) -> CoreResult<()> {
    core.git_for(repo_id)?.args(["read-tree", "--reset", tree]).run().await?;
    // Refresh timestamps so the next status doesn't have to rehash everything.
    core.git_for(repo_id)?.args(["update-index", "-q", "--refresh"]).no_log().run_raw().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Group entries: several refs (and a snapshot) undone together
// ---------------------------------------------------------------------------

/// One ref of a group: where it was and where it is to go. `None` = the ref does not exist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefMove {
    pub name: String,
    pub from: Option<String>,
    pub to: Option<String>,
}

impl RefMove {
    pub fn new(name: &str, from: Option<&str>, to: Option<&str>) -> RefMove {
        RefMove { name: name.to_string(), from: from.map(str::to_string), to: to.map(str::to_string) }
    }

    /// The way back.
    pub fn reversed(&self) -> RefMove {
        RefMove { name: self.name.clone(), from: self.to.clone(), to: self.from.clone() }
    }
}

/// State of working directory and index before a group action (`snapshot_for_group`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupSnapshot {
    /// Backup commit of the working directory (`refs/forkyard/undo/<id>/worktree`).
    pub worktree: String,
    /// Tree of the index; `None` while conflicts are open.
    pub index_tree: Option<String>,
}

/// What a group action records; see `record_group`.
#[derive(Debug, Clone)]
pub struct GroupRecord {
    pub id: String,
    pub repo_id: String,
    pub action: UndoAction,
    pub label: String,
    /// `from` = before the action, `to` = after it.
    pub refs: Vec<RefMove>,
    pub head_before: String,
    pub head_after: Option<String>,
    pub snapshot: Option<GroupSnapshot>,
    /// Further payload fields of the action.
    pub extra: Map<String, Value>,
}

/// Refs a group entry may move: below `refs/` (not the app's own), no spaces, no `..`.
fn check_group_ref(name: &str) -> CoreResult<()> {
    let bad = !name.starts_with("refs/")
        || name.starts_with("refs/forkyard/")
        || name.chars().any(|c| c.is_whitespace() || c.is_control())
        || name.contains("..")
        || name.ends_with('/');
    if bad {
        return Err(CoreError::not_allowed(format!("“{name}” can’t be part of an undo entry.")));
    }
    Ok(())
}

/// Backs up working directory and index for a group action, under the entry's backup refs
/// `worktree` and `index`. Call BEFORE the action, inside the write lock.
pub async fn snapshot_for_group(core: &Core, repo_id: &str, entry_id: &str) -> CoreResult<GroupSnapshot> {
    let snap = snapshot(core, repo_id, None).await?;
    create_backup_ref(core, repo_id, entry_id, "worktree", &snap.commit).await?;
    if let Some(tree) = &snap.index_tree {
        // A commit of its own keeps the index tree alive as long as the entry exists.
        let mut cmd = core.git_for(repo_id)?.args(["commit-tree", "--no-gpg-sign", tree, "-m", "forkyard: backup (index)"]).no_log();
        for (key, value) in SNAPSHOT_IDENTITY {
            cmd = cmd.env(key, value);
        }
        let commit = cmd.run_text().await?;
        create_backup_ref(core, repo_id, entry_id, "index", &commit).await?;
    }
    Ok(GroupSnapshot { worktree: snap.commit, index_tree: snap.index_tree })
}

/// Stores a group entry (after the action, inside the write lock): backs up every `from`/`to`
/// (`before-<n>`/`after-<n>`) so the commits survive garbage collection, writes the composite payload
/// the undo probe checks, and – with a snapshot – records the state after the action.
pub async fn record_group(core: &Core, rec: GroupRecord) -> CoreResult<UndoEntry> {
    if !rec.action.is_group() {
        return Err(CoreError::not_allowed(format!("“{}” is not a group action.", rec.action.as_str())));
    }
    let mut seen = HashSet::new();
    for m in &rec.refs {
        check_group_ref(&m.name)?;
        if !seen.insert(m.name.as_str()) {
            return Err(CoreError::not_allowed(format!("“{}” appears twice in one undo entry.", m.name)));
        }
    }
    for (index, m) in rec.refs.iter().enumerate() {
        if let Some(sha) = &m.from {
            create_backup_ref(core, &rec.repo_id, &rec.id, &format!("before-{index}"), sha).await?;
        }
        if let Some(sha) = &m.to {
            create_backup_ref(core, &rec.repo_id, &rec.id, &format!("after-{index}"), sha).await?;
        }
    }
    let mut payload = rec.extra.clone();
    payload.insert("composite".into(), Value::Bool(true));
    payload.insert("group".into(), Value::Bool(true));
    payload.insert("steps".into(), Value::Array(rec.refs.iter().map(|m| json!({ "ref": m.name, "before": m.from, "after": m.to })).collect()));
    if let Some(snap) = &rec.snapshot {
        payload.insert("worktreeSnapshot".into(), json!(snap.worktree));
        payload.insert("indexTree".into(), json!(snap.index_tree));
    }
    if rec.refs.is_empty() {
        // Nothing marks the state but HEAD: undo only fits on the same commit.
        if let Some(head) = rev_parse(core, &rec.repo_id, "HEAD^{commit}").await? {
            payload.insert("headSha".into(), json!(head));
        }
    }
    let (id, repo_id, with_snapshot) = (rec.id.clone(), rec.repo_id.clone(), rec.snapshot.is_some());
    let entry = record(
        core,
        UndoRecord {
            id: rec.id,
            repo_id: rec.repo_id,
            worktree_path: String::new(),
            action: rec.action,
            label: rec.label,
            ref_name: None,
            ref_before: None,
            ref_after: None,
            head_before: rec.head_before,
            head_after: rec.head_after,
            payload: Value::Object(payload),
        },
    )
    .await?;
    if with_snapshot {
        record_result(core, &repo_id, &id, None).await;
    }
    Ok(entry)
}

/// Moves refs in ONE transaction (`git update-ref --stdin`): each only if it is still at `from`
/// (`None` = must not exist). If one does not match, none moves and the result is `stale_state`.
/// Moves with `from == to` are skipped. Does NOT take the write lock itself.
pub async fn apply_ref_moves(core: &Core, repo_id: &str, moves: &[RefMove], message: &str) -> CoreResult<()> {
    let mut script = String::new();
    for m in moves {
        check_group_ref(&m.name)?;
        match (&m.from, &m.to) {
            (from, to) if from == to => {}
            (Some(from), Some(to)) => script.push_str(&format!("update {} {to} {from}\n", m.name)),
            (None, Some(to)) => script.push_str(&format!("create {} {to}\n", m.name)),
            (Some(from), None) => script.push_str(&format!("delete {} {from}\n", m.name)),
            (None, None) => {}
        }
    }
    if script.is_empty() {
        return Ok(());
    }
    let out = core.git_for(repo_id)?.args(["update-ref", "-m", message, "--stdin"]).stdin(script).run_raw().await?;
    if out.success() {
        return Ok(());
    }
    let text = out.stderr_text().to_ascii_lowercase();
    if ["but expected", "reference already exists", "unable to resolve reference"].iter().any(|needle| text.contains(needle)) {
        return Err(CoreError::stale_state().with_git_output(out.stderr_text()));
    }
    Err(errors::classify("update-ref", out.code, &out.stdout, &out.stderr))
}

#[cfg(test)]
mod group_action_tests {
    use super::*;

    #[test]
    fn group_actions_have_their_database_names() {
        let names: Vec<&str> = UndoAction::ALL.iter().filter(|action| action.is_group()).map(|action| action.as_str()).collect();
        assert_eq!(names, ["compose", "plan", "agent_cleanup", "range_apply", "stack_create", "review_fixups"]);
        for action in UndoAction::ALL {
            assert_eq!(UndoAction::parse(action.as_str()), Some(action));
        }
    }
}
