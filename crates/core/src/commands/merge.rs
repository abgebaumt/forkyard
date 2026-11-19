//! Merge, conflicts, running operations, revert, reset.
//!
//! What "ours" and "theirs" mean: always index stages 2 and 3, the way Git creates them.
//! In a merge, stage 2 is the checked-out branch and stage 3 the incoming one. In a rebase
//! it is the reverse of what one expects: stage 2 is the target being replayed onto
//! (e.g. `main`), stage 3 the commit of one's own branch. The names in
//! `ConflictFile.oursLabel`/`theirsLabel` follow the stages, so "ours" = what is being
//! replayed onto.
//!
//! Whether Git stopped on a conflict is never read from the text of its output, but from
//! the index (`git ls-files --unmerged`) and the Git directory (`read_operation`).

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde_json::json;

use crate::app::Core;
use crate::commands::commit::{hook_failure, Hooks, ABORTING_HOOKS};
use crate::commands::rebase;
use crate::git::index::{ls_unmerged, parse_unmerged, StageEntry, Unmerged};
use crate::git::rev;
use crate::git::rev::short_ref_name;

use crate::commands::status::{self, read_status};
use crate::commands::submodule::auto;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::errors::classify;
use crate::git::repo::read_head;
use crate::git::repo::read_operation;
use crate::git::{GitCmd, GitOutput};
use crate::model::{
    ConflictFile, ConflictKind, ConflictSide, Head, MergeMode, OpResult, Operation, OperationKind, RepoChange, ResetMode, Status,
};
use crate::undo::{self, Pending, UndoAction, UndoRecord};
use crate::util;

/// Merge, rebase, cherry-pick, revert and their completion can change everything.
const ALL_CHANGES: [RepoChange; 5] = [RepoChange::Worktree, RepoChange::Index, RepoChange::Refs, RepoChange::Head, RepoChange::Operation];
const UTF8_BOM: &[u8] = b"\xEF\xBB\xBF";

mod conflict;
mod operation;
pub use conflict::*;
pub use operation::*;

// ---------------------------------------------------------------------------
// merge_start
// ---------------------------------------------------------------------------

/// `git merge` of `source` (local branch, remote branch or SHA) into the checked-out
/// branch. `default` = fast-forward if possible; `ff_only` fails with `not_allowed` if no
/// fast-forward is possible; `squash` leaves the result staged (no commit).
pub async fn merge_start(core: &Core, repo_id: String, source: String, mode: MergeMode) -> CoreResult<OpResult> {
    auto::follow(core, &repo_id, core.with_write_lock(&repo_id, &ALL_CHANGES, merge_locked(core, &repo_id, &source, mode))).await
}

async fn merge_locked(core: &Core, repo_id: &str, source: &str, mode: MergeMode) -> CoreResult<OpResult> {
    ensure_no_operation(core, repo_id).await?;
    ensure_no_unmerged(core, repo_id).await?;
    let head = read_head(core, repo_id).await?;
    let Some(old) = head.sha().map(str::to_string) else {
        return Err(CoreError::not_allowed("You can’t merge in a repository without commits. Create a commit first."));
    };
    let src = resolve_source(core, repo_id, source).await?;
    let target = head.label();

    if rev::is_ancestor(core, repo_id, &src.sha, &old).await? {
        return Ok(OpResult::UpToDate);
    }
    let can_ff = rev::is_ancestor(core, repo_id, &old, &src.sha).await?;
    if mode == MergeMode::FfOnly && !can_ff {
        return Err(CoreError::not_allowed(format!(
            "Fast-forward isn’t possible: {target} and {} have diverged. Merge normally or rebase instead.",
            src.label
        )));
    }
    // Without an identity Git only fails at the merge commit and leaves the result half done.
    let needs_commit = match mode {
        MergeMode::Default => !can_ff,
        MergeMode::NoFf => true,
        MergeMode::FfOnly | MergeMode::Squash => false,
    };
    if needs_commit && !status::identity_set(core, repo_id).await? {
        return Err(identity_missing());
    }
    // A squash moves no ref; it can only be undone via the state before it.
    let mut before_squash = if mode == MergeMode::Squash { Some(Pending::back_up(core, repo_id, None).await?) } else { None };

    let hooks = Hooks::start(core, repo_id).await;
    let cmd = hooks.wrap(core.git_for(repo_id)?).arg("merge");
    let cmd = match mode {
        // `--ff` explicitly, so that `merge.ff` from the user's configuration changes nothing.
        MergeMode::Default => cmd.args(["--ff", "--no-edit"]),
        MergeMode::FfOnly => cmd.arg("--ff-only"),
        MergeMode::NoFf => cmd.args(["--no-ff", "--no-edit"]),
        MergeMode::Squash => cmd.arg("--squash"),
    };
    let out = cmd.arg(&src.arg).run_raw().await;
    let ran = hooks.finish(core, repo_id);
    let out = match out {
        Ok(out) if out.success() => out,
        other => {
            if let Some(pending) = before_squash.take() {
                pending.forget(core).await;
            }
            other?
        }
    };
    if !out.success() {
        // A hook (pre-merge-commit, commit-msg) prevented the merge commit: the merge is then
        // pending without a conflict and can be continued or aborted.
        if let Some(error) = hook_failure(&ran, &ABORTING_HOOKS, &out, "the merge commit") {
            return Err(error);
        }
        return stopped_or_failed(core, repo_id, "merge", &out).await;
    }

    if let Some(pending) = before_squash {
        // The state after the squash: against it, undo detects what the user has added since.
        let result = undo::keep_result(core, repo_id, pending.id(), "result", None).await.ok();
        let (worktree, index_tree) = (pending.worktree().map(str::to_string), pending.index_tree());
        let id = pending.id().to_string();
        pending
            .record(
                core,
                UndoRecord {
                    id,
                    repo_id: repo_id.to_string(),
                    worktree_path: String::new(),
                    action: UndoAction::Merge,
                    label: format!("Undo squash merge of {} into {target}", src.label),
                    ref_name: branch_ref(&head),
                    ref_before: Some(old.clone()),
                    ref_after: Some(old.clone()),
                    head_before: head_value(&head, &old),
                    head_after: Some(head_value(&head, &old)),
                    payload: json!({
                        "squash": true,
                        "branch": head.branch(),
                        "source": src.label,
                        "worktreeSnapshot": worktree,
                        "indexTree": index_tree,
                        "resultSnapshot": result,
                        "paths": null,
                    }),
                },
            )
            .await;
        return Ok(OpResult::Done {
            sha: None,
            fast_forward: false,
            summary: format!("Squashed {} into {target} – the changes are staged but not committed yet", src.label),
        });
    }

    let new = current_sha(core, repo_id).await?;
    if new == old {
        return Ok(OpResult::UpToDate);
    }
    let fast_forward = new == src.sha;
    let subject = commit_meta(core, repo_id, &new).await.map(|m| m.subject).unwrap_or_default();
    let pending = Pending::new(repo_id);
    let id = pending.id().to_string();
    pending
        .record(
            core,
            UndoRecord {
                id,
                repo_id: repo_id.to_string(),
                worktree_path: String::new(),
                action: UndoAction::Merge,
                label: format!("Undo merge of {} into {target}", src.label),
                ref_name: branch_ref(&head),
                ref_before: Some(old.clone()),
                ref_after: Some(new.clone()),
                head_before: head_value(&head, &old),
                head_after: Some(head_value(&head, &new)),
                payload: json!({
                    "branch": head.branch(),
                    "source": src.label,
                    "fastForward": fast_forward,
                    "summary": subject,
                }),
            },
        )
        .await;
    let summary = if fast_forward {
        format!("Merged {} into {target} (fast-forward)", src.label)
    } else {
        format!("Merged {} into {target}", src.label)
    };
    Ok(OpResult::Done { sha: Some(new), fast_forward, summary })
}

/// What is being merged: SHA, name for messages and the argument for `git merge`.
struct MergeSource {
    sha: String,
    label: String,
    arg: String,
}

/// Resolves `source`: local branch before remote branch before everything else (tag, SHA, full ref name).
async fn resolve_source(core: &Core, repo_id: &str, source: &str) -> CoreResult<MergeSource> {
    let source = source.trim();
    if !rev::is_rev_arg(source) {
        return Err(commit_not_found(source));
    }
    let plain = rev::rev_parse(core, repo_id, &format!("{}^{{commit}}", source)).await?;
    for prefix in ["refs/heads/", "refs/remotes/"] {
        let full = format!("{prefix}{source}");
        if let Some(sha) = rev::rev_parse(core, repo_id, &format!("{}^{{commit}}", full)).await? {
            // The short name yields the usual message ("Merge branch 'x'"); only if it means
            // something else (a tag of the same name) does Git get the full name.
            let arg = if plain.as_deref() == Some(sha.as_str()) { source.to_string() } else { full };
            return Ok(MergeSource { sha, label: source.to_string(), arg });
        }
    }
    let Some(sha) = plain else { return Err(commit_not_found(source)) };
    let is_sha = source.len() >= 4 && source.chars().all(|c| c.is_ascii_hexdigit()) && sha.starts_with(&source.to_ascii_lowercase());
    let label = if is_sha { rev::short(&sha).to_string() } else { short_ref_name(source).to_string() };
    Ok(MergeSource { sha, label, arg: source.to_string() })
}

// ---------------------------------------------------------------------------
// revert_commit
// ---------------------------------------------------------------------------

/// `git revert --no-edit`. For a merge commit the revert is against the first parent
/// (`-m 1`): the branch that was merged into stays, the incoming changes disappear. If
/// there is nothing to revert, `up_to_date` comes back.
pub async fn revert_commit(core: &Core, repo_id: String, sha: String) -> CoreResult<OpResult> {
    auto::follow(core, &repo_id, core.with_write_lock(&repo_id, &ALL_CHANGES, revert_locked(core, &repo_id, &sha))).await
}

async fn revert_locked(core: &Core, repo_id: &str, sha: &str) -> CoreResult<OpResult> {
    ensure_no_operation(core, repo_id).await?;
    ensure_no_unmerged(core, repo_id).await?;
    let head = read_head(core, repo_id).await?;
    let Some(old) = head.sha().map(str::to_string) else {
        return Err(CoreError::not_allowed("There’s nothing to revert in a repository without commits."));
    };
    let target = rev::resolve_commit(core, repo_id, sha).await?;
    if !status::identity_set(core, repo_id).await? {
        return Err(identity_missing());
    }
    let meta = commit_meta(core, repo_id, &target).await?;

    let hooks = Hooks::start(core, repo_id).await;
    let mut cmd = hooks.wrap(core.git_for(repo_id)?).args(["revert", "--no-edit"]);
    if meta.parents > 1 {
        cmd = cmd.args(["-m", "1"]);
    }
    let out = cmd.arg(&target).run_raw().await;
    let ran = hooks.finish(core, repo_id);
    let out = out?;
    if !out.success() {
        let unmerged = ls_unmerged(core, repo_id).await?;
        if !unmerged.is_empty() {
            return conflict_result(core, repo_id, &unmerged).await;
        }
        // A hook refused the revert commit. Git then leaves the reverted change staged without a
        // running operation (it only writes REVERT_HEAD on a conflict) – that could not be
        // continued. Hence back to the state before: `reset --merge` only takes what the revert
        // touched; other local changes stay.
        if hook_failure(&ran, &rebase::REWRITE_ABORTING_HOOKS, &out, "the revert").is_some()
            && read_operation(core, repo_id).await?.is_none()
        {
            core.git_for(repo_id)?.args(["update-index", "-q", "--refresh"]).no_log().run_raw().await?;
            let reset = core.git_for(repo_id)?.args(["reset", "--merge", "-q", "HEAD"]).run_raw().await?;
            if !reset.success() {
                log::warn!("Refused revert not rolled back: {}", reset.stderr_text());
            }
        }
        let failed: CoreResult<OpResult> = Err(classify("revert", out.code, &out.stdout, &out.stderr));
        if let Err(error) = rebase::prefer_hook_failure(core, repo_id, failed, &ran, &out, "the revert").await {
            if error.is(ErrorCode::HookFailed) {
                return Err(error);
            }
        }
        let error = classify("revert", out.code, &out.stdout, &out.stderr);
        if error.is(ErrorCode::NothingToCommit) {
            // The change is already gone. Git then stops with an empty result and leaves
            // REVERT_HEAD in place; that is cleaned up.
            let pending = matches!(read_operation(core, repo_id).await?, Some(op) if op.kind == OperationKind::Revert);
            if pending {
                // As in `operation_abort`: `--abort` refuses stale timestamps in the index.
                core.git_for(repo_id)?.args(["update-index", "-q", "--refresh"]).no_log().run_raw().await?;
                core.git_for(repo_id)?.args(["revert", "--abort"]).run().await?;
            }
            return Ok(OpResult::UpToDate);
        }
        return Err(error);
    }

    let new = current_sha(core, repo_id).await?;
    if new == old {
        return Ok(OpResult::UpToDate);
    }
    let pending = Pending::new(repo_id);
    let id = pending.id().to_string();
    pending
        .record(
            core,
            UndoRecord {
                id,
                repo_id: repo_id.to_string(),
                worktree_path: String::new(),
                action: UndoAction::Revert,
                label: format!("Undo revert of ‘{}’", meta.subject),
                ref_name: branch_ref(&head),
                ref_before: Some(old.clone()),
                ref_after: Some(new.clone()),
                head_before: head_value(&head, &old),
                head_after: Some(head_value(&head, &new)),
                payload: json!({
                    "branch": head.branch(),
                    "source": rev::short(&target),
                    "summary": meta.subject,
                }),
            },
        )
        .await;
    Ok(OpResult::Done {
        sha: Some(new),
        fast_forward: false,
        summary: format!("Reverted commit {} with a new commit", rev::short(&target)),
    })
}

// ---------------------------------------------------------------------------
// reset_branch
// ---------------------------------------------------------------------------

/// Resets the checked-out branch (or a detached HEAD) to `sha`. Before `hard` the working
/// directory is backed up as a commit; the old tip always gets a backup ref.
pub async fn reset_branch(core: &Core, repo_id: String, sha: String, mode: ResetMode) -> CoreResult<Status> {
    let changes = [RepoChange::Worktree, RepoChange::Index, RepoChange::Refs, RepoChange::Head];
    let run = core.with_write_lock(&repo_id, &changes, reset_locked(core, &repo_id, &sha, mode));
    // Only a hard reset changes the working directory; soft and mixed leave submodules alone.
    if mode == ResetMode::Hard {
        auto::follow(core, &repo_id, run).await
    } else {
        run.await
    }
}

async fn reset_locked(core: &Core, repo_id: &str, sha: &str, mode: ResetMode) -> CoreResult<Status> {
    ensure_no_operation(core, repo_id).await?;
    let head = read_head(core, repo_id).await?;
    let Some(old) = head.sha().map(str::to_string) else {
        return Err(CoreError::not_allowed("There’s nothing to reset in a repository without commits."));
    };
    let target = rev::resolve_commit(core, repo_id, sha).await?;
    if mode == ResetMode::Soft && target == old {
        return read_status(core, repo_id).await;
    }
    let (flag, mode_name) = match mode {
        ResetMode::Soft => ("--soft", "soft"),
        ResetMode::Mixed => ("--mixed", "mixed"),
        ResetMode::Hard => ("--hard", "hard"),
    };
    // The backup and the undo entry must exist before anything can be lost; if either fails, nothing is reset.
    let pending = match mode {
        ResetMode::Soft => Pending::new(repo_id),
        ResetMode::Mixed => Pending::back_up_index(core, repo_id).await?,
        // `reset --hard` also overwrites ignored files that are tracked in the target:
        // they are therefore added to the backup explicitly.
        ResetMode::Hard => Pending::back_up_before_reset(core, repo_id, &target).await?,
    };
    let pending = pending.keep(core, "before", &old).await?;
    let (worktree, index_tree) = (pending.worktree().map(str::to_string), pending.index_tree());
    // The undo entry exists before anything can be lost: if the app ends in the middle of the
    // reset, undo still offers the backup after the restart.
    let record = UndoRecord {
        id: pending.id().to_string(),
        repo_id: repo_id.to_string(),
        worktree_path: String::new(),
        action: UndoAction::Reset,
        label: format!("Undo reset of {} to {}", head.label(), rev::short(&target)),
        ref_name: branch_ref(&head),
        ref_before: Some(old.clone()),
        ref_after: Some(target.clone()),
        head_before: head_value(&head, &old),
        head_after: Some(head_value(&head, &target)),
        payload: json!({
            "mode": mode_name,
            "branch": head.branch(),
            "worktreeSnapshot": worktree,
            "indexTree": index_tree,
            // Provisionally the target commit; after the reset the actual state.
            "resultSnapshot": if mode == ResetMode::Hard { Some(target.clone()) } else { None },
            "paths": null,
        }),
    };
    let recorded = pending.record_before(core, record, None).await?;

    if let Err(error) = core.git_for(repo_id)?.args(["reset", flag, &target, "--"]).run().await {
        // Failed on the lock: nothing has been reset, the entry disappears again.
        // After any other error something may already have been overwritten – the backup stays.
        if error.is(ErrorCode::Locked) && current_sha(core, repo_id).await.is_ok_and(|now| now == old) {
            recorded.cancel(core).await;
        }
        return Err(error);
    }
    if mode == ResetMode::Hard {
        recorded.finish(core).await;
    }
    read_status(core, repo_id).await
}

async fn keep_ref(core: &Core, repo_id: &str, id: &str, name: &str, sha: &str) {
    if let Err(e) = undo::create_backup_ref(core, repo_id, id, name, sha).await {
        log::warn!("Backup ref {name} for {id} not created: {}", e.message);
    }
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

/// Write call with a file name as argument.
fn path_cmd(core: &Core, repo_id: &str) -> CoreResult<GitCmd> {
    Ok(core.git_for(repo_id)?.literal_paths())
}

/// The checked-out branch as full ref name.
fn branch_ref(head: &Head) -> Option<String> {
    head.branch().map(|b| format!("refs/heads/{b}"))
}

/// HEAD for an undo entry: the ref name if HEAD is on a branch, otherwise `sha`.
fn head_value(head: &Head, sha: &str) -> String {
    branch_ref(head).unwrap_or_else(|| sha.to_string())
}

fn commit_not_found(rev: &str) -> CoreError {
    CoreError::not_found(format!("Commit or branch “{rev}” wasn’t found."))
}

fn identity_missing() -> CoreError {
    CoreError::new(ErrorCode::IdentityMissing, "Name and email for commits aren’t set.")
}

async fn no_operation(core: &Core, repo_id: &str) -> CoreError {
    // The app does not control a `git am` from the terminal – it says so instead of "nothing is running".
    if crate::git::repo::foreign_am(core, repo_id).await {
        return CoreError::not_allowed(
            "A “git am” (applying patches) started outside Forkyard is in progress. The app can’t continue or abort it. In a terminal, use “git am --continue” to continue or “git am --abort” to go back.",
        );
    }
    CoreError::new(ErrorCode::NoOperation, "No operation is in progress that could be continued or aborted.")
}

async fn current_sha(core: &Core, repo_id: &str) -> CoreResult<String> {
    rev::resolve_commit(core, repo_id, "HEAD").await
}

/// The index matches HEAD: nothing is staged.
async fn index_matches_head(core: &Core, repo_id: &str) -> CoreResult<bool> {
    let out = core.git_for(repo_id)?.read().args(["diff-index", "--cached", "--quiet", "HEAD", "--"]).run_raw().await?;
    Ok(out.success())
}

struct CommitMeta {
    parents: usize,
    subject: String,
}

/// Number of parents and first line of the message, from the raw commit object.
async fn commit_meta(core: &Core, repo_id: &str, sha: &str) -> CoreResult<CommitMeta> {
    let out = core.git_for(repo_id)?.read().args(["cat-file", "commit", sha]).run().await?;
    let text = util::decode_lossy(&out.stdout);
    let (headers, message) = text.split_once("\n\n").unwrap_or((text.as_str(), ""));
    Ok(CommitMeta {
        parents: headers.lines().filter(|l| l.starts_with("parent ")).count(),
        subject: message.lines().next().unwrap_or_default().trim().to_string(),
    })
}

async fn ensure_no_operation(core: &Core, repo_id: &str) -> CoreResult<()> {
    let Some(op) = read_operation(core, repo_id).await? else { return Ok(()) };
    Err(CoreError::operation_in_progress(Some(op.kind), "Finish or abort it first."))
}

/// Conflicts without a running operation (after squash merge or stash) would otherwise be reported as a new conflict.
async fn ensure_no_unmerged(core: &Core, repo_id: &str) -> CoreResult<()> {
    if ls_unmerged(core, repo_id).await?.is_empty() {
        return Ok(());
    }
    Err(CoreError::new(ErrorCode::Conflict, "There are still unresolved conflicts. Resolve them or discard the changes first."))
}

/// A foreign `index.lock` is reported, never deleted.
async fn ensure_index_unlocked(core: &Core, repo_id: &str) -> CoreResult<()> {
    let dir = crate::git::repo::git_dir(core, repo_id).await?;
    if dir.join("index.lock").exists() {
        return Err(CoreError::locked(
            "Another Git program is currently working in this repository (lock file present). Wait or close the other program.",
        ));
    }
    Ok(())
}

async fn conflict_result(core: &Core, repo_id: &str, unmerged: &[Unmerged]) -> CoreResult<OpResult> {
    Ok(OpResult::Conflict { files: display_paths(unmerged), operation: read_operation(core, repo_id).await?, note: None })
}

/// Git came back with an error: conflict (if the index has unresolved entries) or a real error.
/// Also usable for rebase, cherry-pick, pull and stash: `out` is the result of `run_raw()`.
pub(crate) async fn stopped_or_failed(core: &Core, repo_id: &str, subcommand: &str, out: &GitOutput) -> CoreResult<OpResult> {
    let unmerged = ls_unmerged(core, repo_id).await?;
    if unmerged.is_empty() {
        return Err(classify(subcommand, out.code, &out.stdout, &out.stderr));
    }
    conflict_result(core, repo_id, &unmerged).await
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod hook_tests;
