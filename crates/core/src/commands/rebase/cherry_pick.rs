//! Cherry-pick and revert: applying single commits (or their inverse) onto the checked-out branch.

use super::*;
use crate::commands::merge;
use crate::git::index::ls_unmerged;
use crate::git::repo::{read_head, read_operation};
use crate::undo::Pending;

// ---------------------------------------------------------------------------
// Cherry-Pick
// ---------------------------------------------------------------------------

pub(super) async fn pick_commits(
    core: &Core,
    repo_id: &str,
    shas: &[String],
    empty_drop: bool,
    touched: &AtomicBool,
) -> CoreResult<OpResult> {
    require_shas(shas)?;
    ensure_no_operation(core, repo_id).await?;
    settle_pending_undo(core, repo_id).await?;
    let head = crate::git::repo::read_head(core, repo_id).await?;
    let (branch, old_head) = match &head {
        Head::Branch { branch, sha } => (Some(branch.clone()), sha.clone()),
        Head::Detached { sha } => (None, sha.clone()),
        Head::Unborn { .. } => {
            return Err(CoreError::not_allowed("The repository doesn't have any commits yet; a cherry-pick needs a commit to build on."))
        }
    };
    let mut listing = core.git_for(repo_id)?.read().args(["log", "--no-walk=unsorted"]).args(LOG_SAFE).args(["-z", &commit_format()]);
    for sha in shas {
        listing = listing.arg(sha.trim());
    }
    let listed = listing.run_raw().await?;
    if !listed.success() {
        return Err(
            CoreError::not_found("At least one of the selected commits doesn't exist (anymore).").with_git_output(listed.stderr_text())
        );
    }
    let commits = parse_commits(&listed.stdout);
    let Some(first) = commits.first() else {
        return Err(CoreError::not_found("The selected commits weren't found."));
    };
    ensure_clean(core, repo_id).await?;

    let hooks = Hooks::start(core, repo_id).await;
    let mut cmd = hooks.wrap(core.git_for(repo_id)?).args(["cherry-pick", "--allow-empty"]);
    if empty_drop {
        cmd = cmd.arg("--empty=drop");
    }
    if commits.iter().any(|c| c.parents.len() > 1) {
        cmd = cmd.args(["-m", "1"]);
    }
    cmd = cmd.args(commits.iter().map(|c| c.sha.as_str()));
    touched.store(true, Ordering::SeqCst);
    let first_run = cmd.run_raw().await;
    // A skipped step (`--skip`) also runs with hooks; they are reported at the end.
    let mut ran = hooks.finish(core, repo_id);
    let mut out = first_run?;

    enum Stop {
        Conflict(Vec<String>, Operation),
        /// Applied but not committed (e.g. a hook): continuing commits it.
        Halted,
        /// Git could not even apply this commit (SHA from the list of remaining steps).
        Unstarted(Option<String>),
        Failed,
    }
    let mut skips = 0;
    let stop = loop {
        if out.success() {
            break None;
        }
        let operation = crate::git::repo::read_operation(core, repo_id).await?.filter(|op| op.kind == OperationKind::CherryPick);
        let Some(operation) = operation else {
            break Some(Stop::Failed);
        };
        let state = worktree_state(core, repo_id).await?;
        if !state.unmerged.is_empty() {
            break Some(Stop::Conflict(state.unmerged, operation));
        }
        // Git only writes CHERRY_PICK_HEAD if it could apply the commit.
        let git_dir = crate::git::repo::git_dir(core, repo_id).await?;
        if !git_dir.join("CHERRY_PICK_HEAD").exists() {
            // The step at which Git failed is at the top of the list.
            let todo = std::fs::read_to_string(git_dir.join("sequencer").join("todo")).unwrap_or_default();
            let failed = todo.lines().find(|l| !l.trim().is_empty() && !l.starts_with('#')).and_then(|l| l.split_whitespace().nth(1));
            break Some(Stop::Unstarted(failed.map(str::to_string)));
        }
        // Empty pick: applied, but nothing was left to commit.
        if state.dirty || skips >= commits.len() {
            break Some(Stop::Halted);
        }
        // A hook refused the commit: don't skip, halt instead.
        if hook_failure(&ran, &REWRITE_ABORTING_HOOKS, &out, "the cherry-pick").is_some() {
            break Some(Stop::Halted);
        }
        skips += 1;
        let hooks = Hooks::start(core, repo_id).await;
        let skipped = hooks.wrap(core.git_for(repo_id)?).args(["cherry-pick", "--skip"]).run_raw().await;
        ran = hooks.finish(core, repo_id);
        out = skipped?;
    };
    if matches!(stop, Some(Stop::Unstarted(_))) {
        // In this state `git cherry-pick --continue` silently skips the commit.
        // So end the sequence; whatever has already been applied stays.
        core.git_for(repo_id)?.args(["cherry-pick", "--quit"]).run_raw().await?;
    }

    let new_head = rev::rev_parse(core, repo_id, "HEAD").await?.unwrap_or_else(|| old_head.clone());
    let pending = matches!(stop, Some(Stop::Conflict(..) | Stop::Halted));
    let applied = count_commits(core, repo_id, &old_head, &new_head).await?;
    if pending || new_head != old_head {
        let label = match commits.as_slice() {
            [one] => format!("Undo cherry-pick of {}", quoted(&one.summary)),
            many => format!("Undo cherry-pick of {}", commits_label(many.len())),
        };
        let shas: Vec<&str> = commits.iter().map(|c| c.sha.as_str()).collect();
        let record = UndoRecord {
            id: undo::new_id(),
            repo_id: repo_id.to_string(),
            worktree_path: String::new(),
            action: UndoAction::CherryPick,
            label,
            ref_name: branch.as_ref().map(|b| format!("refs/heads/{b}")),
            ref_before: branch.as_ref().map(|_| old_head.clone()),
            ref_after: branch.as_ref().filter(|_| !pending).map(|_| new_head.clone()),
            head_before: head.token(),
            head_after: (!pending).then(|| branch.as_ref().map_or(new_head.clone(), |b| format!("refs/heads/{b}"))),
            payload: json!({ "branch": branch, "summary": first.summary, "shas": shas, "count": applied, "pending": pending }),
        };
        if let Err(e) = undo::record(core, record).await {
            log::warn!("Undo entry not saved: {}", e.message);
        }
    }

    match stop {
        Some(Stop::Conflict(files, operation)) => Ok(OpResult::Conflict { files, operation: Some(operation), note: None }),
        Some(Stop::Halted) => {
            let halted: CoreResult<OpResult> = Err(stopped_error("cherry-pick", "cherry-pick", &out));
            prefer_hook_failure(core, repo_id, halted, &ran, &out, "the cherry-pick").await
        }
        Some(Stop::Unstarted(failed)) => {
            let base = classify("cherry-pick", &out);
            let (code, reason) = match base.code {
                ErrorCode::Conflict | ErrorCode::Unknown => (ErrorCode::Unknown, "Git couldn't apply a commit.".to_string()),
                code => (code, base.message.clone()),
            };
            let failed = failed.as_deref().and_then(|sha| commits.iter().find(|c| c.sha.starts_with(sha)));
            let which = failed.map_or_else(|| "A commit".to_string(), |c| quoted(&c.summary));
            let mut error = CoreError::new(
                code,
                format!("{reason} {which} wasn't applied; the cherry-pick stopped there ({applied} of {} applied).", commits.len()),
            );
            error.git_output = base.git_output;
            Err(error)
        }
        Some(Stop::Failed) => Err(classify("cherry-pick", &out)),
        None if new_head == old_head => Ok(OpResult::UpToDate),
        None => {
            let skipped = commits.len().saturating_sub(applied);
            let mut summary = format!("Cherry-picked {}.", commits_label(applied));
            if skipped > 0 {
                summary.push_str(&format!(" Skipped {skipped} because the change is already included."));
            }
            Ok(OpResult::Done { sha: Some(new_head), fast_forward: false, summary })
        }
    }
}

// ---------------------------------------------------------------------------
// revert_commit
// ---------------------------------------------------------------------------

/// `git revert --no-edit`. For a merge commit the revert is against the first parent
/// (`-m 1`): the branch that was merged into stays, the incoming changes disappear. If
/// there is nothing to revert, `up_to_date` comes back.
pub async fn revert_commit(core: &Core, repo_id: String, sha: String) -> CoreResult<OpResult> {
    auto::follow(core, &repo_id, core.with_write_lock(&repo_id, &merge::ALL_CHANGES, revert_locked(core, &repo_id, &sha))).await
}

pub(super) async fn revert_locked(core: &Core, repo_id: &str, sha: &str) -> CoreResult<OpResult> {
    merge::ensure_no_operation(core, repo_id).await?;
    merge::ensure_no_unmerged(core, repo_id).await?;
    let head = read_head(core, repo_id).await?;
    let Some(old) = head.sha().map(str::to_string) else {
        return Err(CoreError::not_allowed("There’s nothing to revert in a repository without commits."));
    };
    let target = rev::resolve_commit(core, repo_id, sha).await?;
    if !status::identity_set(core, repo_id).await? {
        return Err(merge::identity_missing());
    }
    let meta = merge::commit_meta(core, repo_id, &target).await?;

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
            return merge::conflict_result(core, repo_id, &unmerged).await;
        }
        // A hook refused the revert commit. Git then leaves the reverted change staged without a
        // running operation (it only writes REVERT_HEAD on a conflict) – that could not be
        // continued. Hence back to the state before: `reset --merge` only takes what the revert
        // touched; other local changes stay.
        if hook_failure(&ran, &super::REWRITE_ABORTING_HOOKS, &out, "the revert").is_some()
            && read_operation(core, repo_id).await?.is_none()
        {
            core.git_for(repo_id)?.args(["update-index", "-q", "--refresh"]).no_log().run_raw().await?;
            let reset = core.git_for(repo_id)?.args(["reset", "--merge", "-q", "HEAD"]).run_raw().await?;
            if !reset.success() {
                log::warn!("Refused revert not rolled back: {}", reset.stderr_text());
            }
        }
        let failed: CoreResult<OpResult> = Err(crate::git::errors::classify("revert", out.code, &out.stdout, &out.stderr));
        if let Err(error) = super::prefer_hook_failure(core, repo_id, failed, &ran, &out, "the revert").await {
            if error.is(ErrorCode::HookFailed) {
                return Err(error);
            }
        }
        let error = crate::git::errors::classify("revert", out.code, &out.stdout, &out.stderr);
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

    let new = merge::current_sha(core, repo_id).await?;
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
                ref_name: merge::branch_ref(&head),
                ref_before: Some(old.clone()),
                ref_after: Some(new.clone()),
                head_before: merge::head_value(&head, &old),
                head_after: Some(merge::head_value(&head, &new)),
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
