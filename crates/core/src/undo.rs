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

use serde_json::Value;

use crate::app::Core;
use crate::error::CoreResult;
use crate::util;

mod log;
mod snapshot;

pub use log::*;
pub use snapshot::*;

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
    StashDrop,
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
    pub const ALL: [UndoAction; 23] = [
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
        UndoAction::StashDrop,
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
            UndoAction::StashDrop => "stash_drop",
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
        matches!(
            self,
            UndoAction::Compose
                | UndoAction::Plan
                | UndoAction::AgentCleanup
                | UndoAction::RangeApply
                | UndoAction::StackCreate
                | UndoAction::ReviewFixups
        )
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
