//! Review and takeover of a coding agent's work (package 2c).
//!
//! `review` names the two commits the review compares: the agent's state – a snapshot commit of its
//! worktree (commits plus uncommitted and new files) or only its branch tip – against the commit it
//! forked from. Taking a selection over is Paket 0's `range_apply` between exactly these two commits;
//! `commit_selection` commits such a selection on the user's own branch, `discard_rest` throws away
//! what is left uncommitted in the agent's worktree (with undo). Merging and rebasing the agent's
//! branch are the existing commands.

use super::describe;
use crate::app::Core;
use crate::commands::commit::commit_create;
use crate::commands::graph;
use crate::commands::range_apply::range_apply;
use crate::commands::stage::discard_paths;
use crate::commands::status::read_status;
use crate::db::{self, agents::AgentRow};
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::model::{AgentReview, AgentReviewSource, AgentStatus, CommitResult, PatchSelection, RangeApplyTarget, Status};
use crate::undo;
use crate::util;

#[cfg(test)]
mod tests;

/// Message of the snapshot commit of an agent's working state. No ref points to it; Git keeps it as
/// a loose object (two weeks by default), long enough for a review.
pub(crate) const SNAPSHOT_MESSAGE: &str = "forkyard: agent review snapshot";

/// Fixed identity: the snapshot works without `user.name` and gives the same SHA for the same state.
const SNAPSHOT_IDENTITY: [(&str, &str); 4] = [
    ("GIT_AUTHOR_NAME", "forkyard"),
    ("GIT_AUTHOR_EMAIL", "forkyard@localhost"),
    ("GIT_COMMITTER_NAME", "forkyard"),
    ("GIT_COMMITTER_EMAIL", "forkyard@localhost"),
];

pub(crate) const ORPHANED: &str = "The coding agent's worktree or branch no longer exists. Remove its entry in the cockpit.";
pub(crate) const STAGED: &str = "Your staging area already holds changes. Commit or unstage them first, so that the commit contains only the agent's selection.";
pub(crate) const OPERATION: &str = "A merge, rebase, cherry-pick or revert is in progress in your repository. Finish or abort it first, so that the commit contains only the agent's selection.";
pub(crate) const STAYS_STAGED: &str = "The selection stays staged: commit it in the commit panel or undo the takeover.";
pub(crate) const RUNNING: &str = "The coding agent is still running. Stop it first – otherwise it keeps writing into its worktree.";

/// The working state of an agent's worktree compared with its HEAD.
pub(crate) struct WorkingState {
    /// Snapshot commit (parent: the worktree's HEAD) if the state differs and one was asked for.
    pub(crate) snapshot: Option<String>,
    /// Files that differ from HEAD (uncommitted, including new ones; ignored ones do not count).
    pub(crate) changed: u32,
}

pub(crate) fn row_of(core: &Core, agent_id: &str) -> CoreResult<AgentRow> {
    core.db.with(|c| db::agents::require(c, agent_id))
}

/// Tree of the worktree as on disk (`undo::worktree_tree`: a copy of its index, the real one stays),
/// compared with its HEAD; with `snapshot` and a difference, a commit of it.
pub(crate) async fn working_state(core: &Core, worktree_id: &str, snapshot: bool) -> CoreResult<WorkingState> {
    let Some(head) = undo::rev_parse(core, worktree_id, "HEAD^{commit}").await? else {
        return Err(CoreError::not_allowed("The coding agent's worktree has no commit yet."));
    };
    let head_tree = undo::rev_parse(core, worktree_id, &format!("{head}^{{tree}}"))
        .await?
        .ok_or_else(|| CoreError::not_found("The tree of the agent's last commit is missing."))?;
    let tree = undo::worktree_tree(core, worktree_id, None).await?;
    if tree == head_tree {
        return Ok(WorkingState { snapshot: None, changed: 0 });
    }
    let diff = core
        .git_for(worktree_id)?
        .args(["diff-tree", "-r", "-z", "--name-only", "--no-renames", &head_tree, &tree])
        .read_only()
        .no_log()
        .run()
        .await?;
    let changed = u32::try_from(util::split_z(&diff.stdout).count()).unwrap_or(u32::MAX);
    if !snapshot {
        return Ok(WorkingState { snapshot: None, changed });
    }
    // The date of HEAD instead of "now": the same working state gives the same commit, so the
    // review only notices real changes of the agent.
    let when = core.git_for(worktree_id)?.args(["show", "-s", "--format=%ct", &head]).read_only().no_log().run_text().await?;
    let date = format!("@{when} +0000");
    let mut cmd = core
        .git_for(worktree_id)?
        .args(["commit-tree", "--no-gpg-sign", "-p", &head, "-m", SNAPSHOT_MESSAGE, &tree])
        .env("GIT_AUTHOR_DATE", &date)
        .env("GIT_COMMITTER_DATE", &date)
        .no_log();
    for (key, value) in SNAPSHOT_IDENTITY {
        cmd = cmd.env(key, value);
    }
    let commit = cmd.run_text().await?;
    Ok(WorkingState { snapshot: Some(commit), changed })
}

/// The commit the agent's state forked from: `merge-base` of its base as it is now (the recorded
/// base commit if the ref is gone) and `to`; without a common ancestor the recorded base commit.
async fn fork_point(core: &Core, row: &AgentRow, to: &str) -> CoreResult<String> {
    let base = graph::resolve_commit(core, &row.repo_id, &row.base).await.unwrap_or_else(|_| row.base_sha.clone());
    let out = core.git_for(&row.repo_id)?.args(["merge-base", &base, to]).read_only().no_log().run_raw().await?;
    let found = out.stdout_text();
    Ok(if out.success() && !found.is_empty() { found } else { row.base_sha.clone() })
}

pub(crate) async fn review(core: &Core, agent_id: &str, source: AgentReviewSource) -> CoreResult<AgentReview> {
    let row = row_of(core, agent_id)?;
    core.repo_path(&row.repo_id)?;
    let agent = describe(core, &row).await;
    if agent.status == AgentStatus::Orphaned {
        return Err(CoreError::not_allowed(ORPHANED));
    }
    let tip = graph::resolve_commit(core, &row.repo_id, &format!("refs/heads/{}", row.branch)).await?;
    let state = match agent.worktree_repo_id.as_deref() {
        Some(worktree) => working_state(core, worktree, source == AgentReviewSource::Snapshot).await?,
        None => WorkingState { snapshot: None, changed: 0 },
    };
    let (source, to) = match state.snapshot {
        Some(commit) => (AgentReviewSource::Snapshot, commit),
        None => (AgentReviewSource::Branch, tip.clone()),
    };
    let from = fork_point(core, &row, &to).await?;
    Ok(AgentReview {
        agent_id: row.id.clone(),
        repo_id: row.repo_id.clone(),
        worktree_repo_id: agent.worktree_repo_id.clone(),
        source,
        from,
        to,
        tip,
        base: row.base.clone(),
        uncommitted_files: state.changed,
        running: agent.terminal_id.is_some(),
    })
}

/// Commits a selection of the agent's changes (`from..to` as `review` named them) on the branch
/// checked out in the user's own working directory: nothing of the user's may be staged, then
/// `range_apply` stages and writes the selection, and the normal commit path commits it (hooks,
/// signing, undo). A failing commit leaves the selection staged.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn commit_selection(
    core: &Core,
    agent_id: &str,
    op_id: String,
    from: String,
    to: String,
    selections: Vec<PatchSelection>,
    summary: String,
    description: String,
    skip_hooks: bool,
) -> CoreResult<CommitResult> {
    let row = row_of(core, agent_id)?;
    let repo_id = row.repo_id.clone();
    core.repo_path(&repo_id)?;
    if summary.trim().is_empty() {
        return Err(CoreError::new(ErrorCode::EmptyMessage, "The commit message is empty. Enter a summary."));
    }
    if selections.is_empty() {
        return Err(CoreError::new(ErrorCode::NothingToCommit, "Nothing of the agent's changes is selected."));
    }
    let status = read_status(core, &repo_id).await?;
    // During a merge (or with open conflicts) the commit would become that operation's commit.
    if status.operation.is_some() || !status.conflicted.is_empty() {
        return Err(CoreError::new(ErrorCode::OperationInProgress, OPERATION));
    }
    if !status.staged.is_empty() {
        return Err(CoreError::not_allowed(STAGED));
    }
    let applied = range_apply(core, repo_id.clone(), from, to, selections, RangeApplyTarget::Both).await?;
    if applied.staged.is_empty() {
        return Err(CoreError::new(ErrorCode::NothingToCommit, "The selection changes nothing on your branch – it is already there."));
    }
    commit_create(core, repo_id, op_id, summary, description, false, skip_hooks, false, false, None).await.map_err(|mut e| {
        e.message = format!("{} {STAYS_STAGED}", e.message);
        e
    })
}

/// Discards every uncommitted change in the agent's worktree (tracked and untracked files; ignored
/// ones and the agent's commits stay) through the existing discard, which backs everything up first:
/// the undo entry belongs to the worktree's repository row. Refused while the agent's program runs.
pub(crate) async fn discard_rest(core: &Core, agent_id: &str) -> CoreResult<Status> {
    let row = row_of(core, agent_id)?;
    core.repo_path(&row.repo_id)?;
    let agent = describe(core, &row).await;
    if agent.status == AgentStatus::Orphaned {
        return Err(CoreError::not_allowed(ORPHANED));
    }
    if agent.terminal_id.is_some() {
        return Err(CoreError::not_allowed(RUNNING));
    }
    let Some(worktree) = agent.worktree_repo_id else {
        return Err(CoreError::not_allowed(ORPHANED));
    };
    discard_paths(core, worktree, None).await
}
