//! The undo log: storing entries, reading the stacks, labels, cleanup, group entries.

use std::collections::HashSet;

use serde_json::{json, Map, Value};

use super::{commit_tree, create_backup_ref, delete_backup_refs, record_result, snapshot, UndoAction, UndoRecord};
use crate::app::Core;
use crate::db::{self, undo::UndoEntry, undo::UndoEntryState};
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::errors;
use crate::git::rev;
use crate::model::{UndoState, UndoStep};
use crate::util;

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
/// Takes the write lock per repository. An entry whose refs could not be removed stays (the
/// next cleanup tries again); only a repository removed from the app takes its entries along.
pub async fn cleanup_older_than(core: &Core, days: i64) -> CoreResult<()> {
    let before = util::iso_days_ago(days);
    let old = core.db.with(|c| db::undo::older_than(c, &before))?;
    for (id, repo_id) in old {
        let removed = match core.repo_path(&repo_id) {
            Ok(_) => core.with_write_lock(&repo_id, &[], async { delete_backup_refs(core, &repo_id, &id).await }).await,
            // The repository row is gone; a missing folder (unplugged drive) may come back.
            Err(e) if e.is(ErrorCode::NotFound) => Ok(()),
            Err(e) => Err(e),
        };
        match removed {
            Ok(()) => core.db.with(|c| db::undo::delete(c, &id))?,
            Err(e) => log::warn!("Backup refs of {id} not removed, entry kept: {}", e.message),
        }
    }
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
        let commit = commit_tree(core, repo_id, tree, &[], "forkyard: backup (index)").await?;
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
    payload
        .insert("steps".into(), Value::Array(rec.refs.iter().map(|m| json!({ "ref": m.name, "before": m.from, "after": m.to })).collect()));
    if let Some(snap) = &rec.snapshot {
        payload.insert("worktreeSnapshot".into(), json!(snap.worktree));
        payload.insert("indexTree".into(), json!(snap.index_tree));
    }
    if rec.refs.is_empty() {
        // Nothing marks the state but HEAD: undo only fits on the same commit.
        if let Some(head) = rev::rev_parse(core, &rec.repo_id, "HEAD^{commit}").await? {
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

/// Deletes an entry along with its backup refs. Call within the write lock.
pub(crate) async fn discard_entry(core: &Core, repo_id: &str, entry_id: &str) {
    if let Err(e) = core.db.with(|c| db::undo::delete(c, entry_id)) {
        log::warn!("undo entry {entry_id} not deleted: {}", e.message);
    }
    if let Err(e) = delete_backup_refs(core, repo_id, entry_id).await {
        log::warn!("backup refs of {entry_id} not removed: {}", e.message);
    }
}
