//! `Pending`: an undo entry in the making. New id → backup refs → run the step → record or forget.
//!
//! One failure policy for every destructive action:
//! - a backup or an undo entry that fails BEFORE the destructive step aborts the step: `back_up`,
//!   `keep` and `record_before` return the error and leave no backup refs behind;
//! - after a step that succeeded, a failing undo entry is only logged (`record`): the step
//!   happened, and its backup refs stay (cleanup lists them as backups without an entry);
//! - a step that did not happen removes the backup again (`forget`, `Recorded::cancel`).

use serde_json::{json, Value};

use super::{
    commit_tree, create_backup_ref, delete_backup_refs, discard_entry, new_id, record, record_result, Snapshot, UndoAction, UndoRecord,
};
use crate::app::Core;
use crate::error::CoreResult;
use crate::model::Head;

/// The backups of one undo entry that is not stored yet.
#[must_use = "record or forget the backup"]
pub(crate) struct Pending {
    id: String,
    repo_id: String,
    /// Backup commit of the working directory (ref `worktree`).
    worktree: Option<String>,
    /// Tree of the index before the step; `None` with open conflicts or without a backup.
    index_tree: Option<String>,
}

impl Pending {
    /// Only the id: backup refs come with `keep`.
    pub(crate) fn new(repo_id: &str) -> Pending {
        Pending { id: new_id(), repo_id: repo_id.to_string(), worktree: None, index_tree: None }
    }

    /// Backs up the working directory (everything or `paths`, raw) and the index as refs `worktree`
    /// and `index`. The real index and the working directory stay untouched.
    pub(crate) async fn back_up(core: &Core, repo_id: &str, paths: Option<&[Vec<u8>]>) -> CoreResult<Pending> {
        let snapshot = super::snapshot_paths(core, repo_id, paths).await?;
        Pending::new(repo_id).with_snapshot(core, snapshot).await
    }

    /// `back_up` before `reset --hard <target>` (also the ignored files the reset overwrites).
    pub(crate) async fn back_up_before_reset(core: &Core, repo_id: &str, target: &str) -> CoreResult<Pending> {
        let snapshot = super::snapshot_before_reset(core, repo_id, target).await?;
        Pending::new(repo_id).with_snapshot(core, snapshot).await
    }

    /// Only the index (ref `index`), for steps that leave the working directory alone.
    pub(crate) async fn back_up_index(core: &Core, repo_id: &str) -> CoreResult<Pending> {
        let mut pending = Pending::new(repo_id);
        pending.index_tree = super::index_tree(core, repo_id).await?;
        pending.keep_index(core).await
    }

    async fn with_snapshot(mut self, core: &Core, snapshot: Snapshot) -> CoreResult<Pending> {
        self.index_tree = snapshot.index_tree;
        let worktree = snapshot.commit;
        let pending = self.keep(core, "worktree", &worktree).await?;
        Pending { worktree: Some(worktree), ..pending }.keep_index(core).await
    }

    /// A commit of its own keeps the index tree alive as long as the entry exists.
    async fn keep_index(self, core: &Core) -> CoreResult<Pending> {
        let Some(tree) = self.index_tree.clone() else { return Ok(self) };
        match commit_tree(core, &self.repo_id, &tree, &[], "forkyard: backup (index)").await {
            Ok(commit) => self.keep(core, "index", &commit).await,
            Err(e) => {
                self.forget(core).await;
                Err(e)
            }
        }
    }

    /// One more backup ref (`refs/forkyard/undo/<id>/<name>`). On failure the backup is gone and
    /// the step must not run.
    pub(crate) async fn keep(self, core: &Core, name: &str, sha: &str) -> CoreResult<Pending> {
        match create_backup_ref(core, &self.repo_id, &self.id, name, sha).await {
            Ok(_) => Ok(self),
            Err(e) => {
                self.forget(core).await;
                Err(e)
            }
        }
    }

    pub(crate) fn id(&self) -> &str {
        &self.id
    }

    /// The backup commit of the working directory, if there is one.
    pub(crate) fn worktree(&self) -> Option<&str> {
        self.worktree.as_deref()
    }

    /// The index tree before the step.
    pub(crate) fn index_tree(&self) -> Option<String> {
        self.index_tree.clone()
    }

    /// The pipeline of a step that moves no ref (apply a patch, discard lines, delete a file):
    /// backup of `paths` → `step` → undo entry (`record_discard` with `listed`). A failing step must
    /// have changed nothing (`git apply` checks everything first): its backup goes again. Checks
    /// that refuse the step belong before this call – then not even a backup is made.
    pub(crate) async fn around<T>(
        core: &Core,
        repo_id: &str,
        head: &Head,
        paths: &[Vec<u8>],
        label: String,
        listed: Vec<String>,
        step: impl std::future::Future<Output = CoreResult<T>>,
    ) -> CoreResult<T> {
        let backup = Pending::back_up(core, repo_id, Some(paths)).await?;
        match step.await {
            Ok(value) => {
                backup.record_discard(core, head, label, Some(listed), Value::Null).await;
                Ok(value)
            }
            Err(e) => {
                backup.forget(core).await;
                Err(e)
            }
        }
    }

    /// The step did not happen: the backup refs go again.
    pub(crate) async fn forget(self, core: &Core) {
        if let Err(e) = delete_backup_refs(core, &self.repo_id, &self.id).await {
            log::warn!("Backup refs of {} not removed: {}", self.id, e.message);
        }
    }

    /// Stores the entry BEFORE the step destroys anything: if the app ends midway, undo still
    /// offers the backup after the restart. If storing fails, the backup goes and the error comes
    /// back – the step must not run. `paths` is what `Recorded::finish` backs up as the result.
    pub(crate) async fn record_before(self, core: &Core, rec: UndoRecord, paths: Option<Vec<String>>) -> CoreResult<Recorded> {
        let (id, repo_id) = (self.id.clone(), self.repo_id.clone());
        match record(core, UndoRecord { id: id.clone(), ..rec }).await {
            Ok(_) => Ok(Recorded { id, repo_id, paths }),
            Err(e) => {
                self.forget(core).await;
                Err(e)
            }
        }
    }

    /// Stores the entry AFTER the step succeeded. A failure is only logged: the step has
    /// happened, and the backup refs stay.
    pub(crate) async fn record(self, core: &Core, rec: UndoRecord) {
        if let Err(e) = record(core, UndoRecord { id: self.id.clone(), ..rec }).await {
            log::warn!("Undo entry not saved (backup refs {} kept): {}", self.id, e.message);
        }
    }

    /// `record` for an action that moved no ref (discard, delete, restore, apply a patch): undo
    /// swaps the backed-up working directory and index back in. Afterwards the state after the
    /// step is recorded.
    pub(crate) async fn record_discard(self, core: &Core, head: &Head, label: String, paths: Option<Vec<String>>, extra: Value) {
        let repo_id = self.repo_id.clone();
        let rec = self.discard_record(head, label, &paths, extra);
        let id = self.id.clone();
        self.record(core, rec).await;
        record_result(core, &repo_id, &id, paths.as_deref()).await;
    }

    /// `record_before` for such an action; `expected` is the state the step will produce (tree or
    /// commit) – `Recorded::finish` replaces it with the real one.
    pub(crate) async fn record_discard_before(
        self,
        core: &Core,
        head: &Head,
        label: String,
        paths: Option<Vec<String>>,
        expected: Option<String>,
    ) -> CoreResult<Recorded> {
        let rec = self.discard_record(head, label, &paths, json!({ "resultSnapshot": expected }));
        self.record_before(core, rec, paths).await
    }

    fn discard_record(&self, head: &Head, label: String, paths: &Option<Vec<String>>, extra: Value) -> UndoRecord {
        let mut payload = json!({ "worktreeSnapshot": self.worktree, "indexTree": self.index_tree, "paths": paths });
        if let (Some(fields), Some(target)) = (extra.as_object(), payload.as_object_mut()) {
            target.extend(fields.iter().filter(|(_, value)| !value.is_null()).map(|(key, value)| (key.clone(), value.clone())));
        }
        UndoRecord {
            id: self.id.clone(),
            repo_id: self.repo_id.clone(),
            worktree_path: String::new(),
            action: UndoAction::Discard,
            label,
            ref_name: None,
            ref_before: None,
            ref_after: None,
            head_before: head.token(),
            head_after: Some(head.token()),
            payload,
        }
    }
}

/// An already stored undo entry of a step that is about to run.
pub(crate) struct Recorded {
    id: String,
    repo_id: String,
    paths: Option<Vec<String>>,
}

impl Recorded {
    /// The step has run (fully or partially): record the real state afterwards.
    pub(crate) async fn finish(self, core: &Core) {
        record_result(core, &self.repo_id, &self.id, self.paths.as_deref()).await;
    }

    /// The step changed nothing: the entry disappears together with the backup.
    pub(crate) async fn cancel(self, core: &Core) {
        discard_entry(core, &self.repo_id, &self.id).await;
    }
}
