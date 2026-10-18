//! Rebase, interactive rebase, cherry-pick, squash.
//!
//! Interactive rebase and squash run through `git rebase -i`: a helper program
//! (`editor_helper_entry`) serves as `GIT_SEQUENCE_EDITOR` and puts the finished
//! todo file in place. New commit messages are not written in an editor but in the
//! todo file itself: one prepared empty commit per message, which via `fixup -C`
//! only contributes its message. That way a later `git rebase --continue`
//! (after a conflict, from the app or the terminal) needs neither an editor nor an
//! environment from here.
//!
//! For other parts of the core: `settle_pending_undo` (finish an undo entry after continuing or
//! aborting), `editor_helper_entry` (entry point for the helper program).

use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{json, Value};

use crate::app::Core;
use crate::commands::commit::{hook_failure, Hooks};
use crate::commands::refs;
use crate::commands::status::{self, EntryKind};
use crate::commands::submodule::auto;
use crate::db::{self, undo::UndoEntry};
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::{errors, GitCmd, GitOutput};
use crate::model::{
    Head, HookOutput, OpResult, Operation, OperationKind, Person, RebaseAction, RebasePlan, RebasePlanRow, RebaseRefusal, RebaseRefusalDetail,
    RepoChange,
};
use crate::undo::{self, UndoAction, UndoRecord};
use crate::util;

/// What these actions can change.
const CHANGES: &[RepoChange] =
    &[RepoChange::Refs, RepoChange::Head, RepoChange::Worktree, RepoChange::Index, RepoChange::Operation];

/// Fixed settings for every rebase: stash nothing, reorder nothing, don't drag along
/// other branches – otherwise the undo entry is wrong.
const REBASE_CONFIG: [&str; 12] = [
    "-c",
    "rebase.autoStash=false",
    "-c",
    "rebase.autoSquash=false",
    "-c",
    "rebase.updateRefs=false",
    "-c",
    "rebase.rebaseMerges=false",
    "-c",
    "rebase.missingCommitsCheck=ignore",
    "-c",
    "rebase.abbreviateCommands=false",
];

/// `REBASE_CONFIG`, with `rebase.updateRefs=false` left out when the branches should move along
/// (`--update-refs` is passed then).
fn rebase_config(update_refs: bool) -> Vec<&'static str> {
    if !update_refs {
        return REBASE_CONFIG.to_vec();
    }
    REBASE_CONFIG.chunks(2).filter(|pair| pair[1] != "rebase.updateRefs=false").flatten().copied().collect()
}

/// Hooks whose failure refuses or halts a rebase, cherry-pick or revert.
pub(crate) const REWRITE_ABORTING_HOOKS: [&str; 5] = ["pre-rebase", "pre-commit", "pre-merge-commit", "prepare-commit-msg", "commit-msg"];

/// If a hook refused the operation, that is the error: `hook_failed` with the hook's name, exit
/// code and output instead of the generic Git error. A conflict result stays as it is. If the
/// operation is still running (paused), the message says so as well.
pub(crate) async fn prefer_hook_failure<T>(
    core: &Core,
    repo_id: &str,
    result: CoreResult<T>,
    ran: &[HookOutput],
    out: &GitOutput,
    what: &str,
) -> CoreResult<T> {
    let Err(error) = result else { return result };
    if out.success() {
        return Err(error);
    }
    let Some(mut hook_error) = hook_failure(ran, &REWRITE_ABORTING_HOOKS, out, what) else { return Err(error) };
    if matches!(status::read_operation(core, repo_id).await, Ok(Some(_))) {
        hook_error.message.push_str(" The operation is paused; you can continue or abort it.");
    }
    Err(hook_error)
}

/// Fields per commit, separated by NUL (`git log -z`).
const COMMIT_FORMAT: &str = "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00%b%x00%B";
const COMMIT_FIELDS: usize = 8;

/// From this version on, `git cherry-pick` knows the option `--empty=drop`.
const CHERRY_PICK_EMPTY_DROP: (u32, u32, u32) = (2, 45, 0);

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Rebases the checked-out branch (or `branch`) onto `onto`.
pub async fn rebase_start(core: &Core, repo_id: String, onto: String, branch: Option<String>) -> CoreResult<OpResult> {
    rebase_start_with(core, repo_id, onto, branch, None).await
}

/// Like `rebase_start`; `update_refs: Some(true)` moves dependent branches along (`--update-refs`),
/// backed up for undo.
pub async fn rebase_start_with(core: &Core, repo_id: String, onto: String, branch: Option<String>, update_refs: Option<bool>) -> CoreResult<OpResult> {
    let touched = AtomicBool::new(false);
    auto::follow(core, &repo_id, write_action(core, &repo_id, &touched, start_rebase(core, &repo_id, &onto, branch.as_deref(), update_refs.unwrap_or(false), &touched))).await
}

/// The local branches a rebase of `branch` (default: the checked-out one) onto `onto` would move
/// along with `update_refs`. Empty for a detached HEAD.
pub async fn rebase_dependents(core: &Core, repo_id: String, onto: String, branch: Option<String>) -> CoreResult<Vec<String>> {
    let repo_id = repo_id.as_str();
    let target = match branch.as_deref().map(|b| b.strip_prefix("refs/heads/").unwrap_or(b).trim()).filter(|b| !b.is_empty()) {
        Some(name) => name.to_string(),
        None => match refs::read_head(core, repo_id).await? {
            Head::Branch { branch, .. } => branch,
            _ => return Ok(Vec::new()),
        },
    };
    let Some(tip) = rev_parse(core, repo_id, &format!("refs/heads/{target}^{{commit}}")).await? else {
        return Ok(Vec::new());
    };
    let onto_sha = resolve_commit(core, repo_id, &onto).await?;
    Ok(dependent_refs(core, repo_id, &onto_sha, &tip, &target).await?.into_iter().map(|(name, _)| name).collect())
}

/// Commits between `base` and HEAD as a plan, with the preconditions checked.
pub async fn rebase_plan(core: &Core, repo_id: String, base: String) -> CoreResult<RebasePlan> {
    let repo_id = repo_id.as_str();
    let refused = |reason, message: &str| Ok(RebasePlan::Refused { reason, detail: None, message: message.to_string() });
    // A running operation is not an error of the call but a reason the UI can explain.
    if let Some(op) = status::read_operation(core, repo_id).await? {
        let name = match op.kind {
            OperationKind::Merge => "a merge",
            OperationKind::Rebase => "a rebase",
            OperationKind::CherryPick => "a cherry-pick",
            OperationKind::Revert => "a revert",
        };
        return refused(
            RebaseRefusal::OperationInProgress,
            &format!("There is still {name} in progress. Finish or abort it first – then you can plan an interactive rebase."),
        );
    }
    let (branch, head_sha) = match refs::read_head(core, repo_id).await? {
        Head::Branch { branch, sha } => (branch, sha),
        Head::Detached { .. } => {
            return refused(
                RebaseRefusal::Detached,
                "HEAD doesn't point to a branch (detached HEAD). Check out a branch first to start an interactive rebase.",
            )
        }
        Head::Unborn { .. } => return refused(RebaseRefusal::NothingToRebase, "The repository doesn't have any commits yet."),
    };
    let base_sha = resolve_commit(core, repo_id, &base).await?;
    if base_sha == head_sha {
        return refused(RebaseRefusal::NothingToRebase, "There are no commits between the selected commit and HEAD.");
    }
    if !is_ancestor(core, repo_id, &base_sha, &head_sha).await? {
        let related = read(core, repo_id)?.args(["merge-base", &base_sha, &head_sha]).run_raw().await?.success();
        let (detail, message) = if related {
            (
                RebaseRefusalDetail::NotAncestor,
                "The selected commit isn't an ancestor of the checked-out branch. An interactive rebase needs a commit from the branch's own history as its base.",
            )
        } else {
            (RebaseRefusalDetail::UnrelatedHistory, "The selected commit and the checked-out branch have no history in common.")
        };
        return Ok(RebasePlan::Refused { reason: RebaseRefusal::NoCommonAncestor, detail: Some(detail), message: message.to_string() });
    }
    let commits = read_range(core, repo_id, &base_sha).await?;
    let Some(oldest) = commits.first() else {
        return refused(RebaseRefusal::NothingToRebase, "There are no commits between the selected commit and HEAD.");
    };
    if let Some(merge) = commits.iter().find(|c| c.parents.len() > 1) {
        return Ok(RebasePlan::Refused {
            reason: RebaseRefusal::MergeCommits,
            detail: None,
            message: format!(
                "The range contains at least one merge commit ({}). An interactive rebase would flatten it, which isn't supported.",
                named(&merge.summary)
            ),
        });
    }
    if worktree_state(core, repo_id).await?.dirty {
        return refused(
            RebaseRefusal::DirtyWorktree,
            "There are uncommitted changes. Commit or stash them first.",
        );
    }
    // The range is linear: if any commit is on a remote, so is the oldest one.
    let pushed = read(core, repo_id)?
        .args(["for-each-ref", "--count=1", "--format=%(refname)", "--contains", &oldest.sha, "refs/remotes"])
        .run()
        .await?;
    let rows = commits
        .into_iter()
        .map(|c| RebasePlanRow {
            sha: c.sha,
            summary: c.summary,
            description: c.description,
            author: c.author,
            authored_at: c.authored_at,
            action: RebaseAction::Pick,
            message: None,
        })
        .collect();
    let dependent_branches = dependent_refs(core, repo_id, &base_sha, &head_sha, &branch).await?.into_iter().map(|(name, _)| name).collect();
    Ok(RebasePlan::Ok { branch, base: base_sha, rows, rewrites_pushed: !pushed.stdout_text().is_empty(), dependent_branches })
}


/// `rebase_plan`; with `autosquash: Some(true)` the rows come in Git's autosquash order (8.2): every
/// `fixup! <subject>` / `squash! <subject>` commit directly after the commit it names, with the action
/// `fixup` / `squash`.
pub async fn rebase_plan_with(core: &Core, repo_id: String, base: String, autosquash: Option<bool>) -> CoreResult<RebasePlan> {
    Ok(match rebase_plan(core, repo_id, base).await? {
        RebasePlan::Ok { branch, base, rows, rewrites_pushed, dependent_branches } if autosquash == Some(true) => {
            RebasePlan::Ok { branch, base, rows: autosquash_rows(rows), rewrites_pushed, dependent_branches }
        }
        other => other,
    })
}

/// The action a subject asks for and the subject it names: `fixup! X` → (`Fixup`, `X`), `squash! X` →
/// (`Squash`, `X`); repeated `fixup!` / `squash!` / `amend!` prefixes and the spaces after them are
/// stripped, the action comes from the first prefix (`amend!` first: no action – it stays a pick).
fn fixup_kind(subject: &str) -> (Option<RebaseAction>, &str) {
    let mut kind: Option<Option<RebaseAction>> = None;
    let mut rest = subject;
    loop {
        let (action, after) = if let Some(after) = rest.strip_prefix("fixup!") {
            (Some(RebaseAction::Fixup), after)
        } else if let Some(after) = rest.strip_prefix("squash!") {
            (Some(RebaseAction::Squash), after)
        } else if let Some(after) = rest.strip_prefix("amend!") {
            (None, after)
        } else {
            break;
        };
        kind.get_or_insert(action);
        rest = after.trim_start();
    }
    (kind.flatten(), rest)
}

/// Git's `--autosquash` on the rows of a plan (oldest first): a `fixup!`/`squash!` commit names the first
/// earlier row whose subject equals the rest, else an earlier row whose SHA starts with it (at least four
/// hex digits), else the first earlier row whose subject starts with it. It moves directly after its
/// target, after the ones already moved there; a commit that names nothing stays where it is.
pub(crate) fn autosquash_rows(rows: Vec<RebasePlanRow>) -> Vec<RebasePlanRow> {
    let count = rows.len();
    let mut next: Vec<Option<usize>> = vec![None; count];
    let mut tail: Vec<Option<usize>> = vec![None; count];
    let mut folded = vec![false; count];
    let mut actions: Vec<RebaseAction> = rows.iter().map(|row| row.action).collect();
    let mut first_with_subject: HashMap<&str, usize> = HashMap::new();
    for (index, row) in rows.iter().enumerate() {
        let (kind, rest) = fixup_kind(&row.summary);
        let target = kind.and_then(|_| {
            let hex = rest.len() >= 4 && rest.bytes().all(|b| b.is_ascii_hexdigit());
            first_with_subject
                .get(rest)
                .copied()
                .or_else(|| hex.then(|| rows[..index].iter().position(|r| r.sha.starts_with(&rest.to_ascii_lowercase()))).flatten())
                .or_else(|| rows[..index].iter().position(|r| r.summary.starts_with(rest)))
        });
        match (kind, target) {
            (Some(kind), Some(target)) => {
                actions[index] = kind;
                folded[index] = true;
                let after = tail[target].unwrap_or(target);
                next[index] = next[after];
                next[after] = Some(index);
                tail[target] = Some(index);
            }
            _ => {
                first_with_subject.entry(row.summary.as_str()).or_insert(index);
            }
        }
    }
    let mut slots: Vec<Option<RebasePlanRow>> = rows.into_iter().map(Some).collect();
    let mut ordered = Vec::with_capacity(count);
    for (start, &moved) in folded.iter().enumerate() {
        if moved {
            continue;
        }
        let mut current = Some(start);
        while let Some(index) = current {
            if let Some(mut row) = slots[index].take() {
                row.action = actions[index];
                ordered.push(row);
            }
            current = next[index];
        }
    }
    ordered
}

/// Execute a plan (pick, reword, squash, drop, order).
pub async fn rebase_apply(core: &Core, repo_id: String, base: String, rows: Vec<RebasePlanRow>) -> CoreResult<OpResult> {
    rebase_apply_with(core, repo_id, base, rows, None).await
}

/// Like `rebase_apply`; `update_refs: Some(true)` moves dependent branches along.
pub async fn rebase_apply_with(core: &Core, repo_id: String, base: String, rows: Vec<RebasePlanRow>, update_refs: Option<bool>) -> CoreResult<OpResult> {
    let touched = AtomicBool::new(false);
    auto::follow(core, &repo_id, write_action(core, &repo_id, &touched, apply_plan(core, &repo_id, &base, &rows, update_refs.unwrap_or(false), &touched))).await
}

/// Apply one or more commits.
pub async fn cherry_pick(core: &Core, repo_id: String, shas: Vec<String>) -> CoreResult<OpResult> {
    let touched = AtomicBool::new(false);
    // With `--empty=drop` Git remembers to skip empty picks for a later `--continue` as well;
    // older versions stop and are pushed on from here.
    let empty_drop = core.git.info()?.version >= CHERRY_PICK_EMPTY_DROP;
    auto::follow(core, &repo_id, write_action(core, &repo_id, &touched, pick_commits(core, &repo_id, &shas, empty_drop, &touched))).await
}

/// Combine consecutive commits of the checked-out branch.
pub async fn squash_commits(core: &Core, repo_id: String, shas: Vec<String>, message: String) -> CoreResult<OpResult> {
    let touched = AtomicBool::new(false);
    write_action(core, &repo_id, &touched, squash(core, &repo_id, &shas, &message, &touched)).await
}

/// Finishes an undo entry that was created as "open" on a conflict
/// (`payload.pending = true`, `ref_after = None`). Once no operation is running any more:
/// if the ref is back at `ref_before`, the operation was aborted and the entry disappears
/// together with its backup ref; otherwise the current state is recorded as `ref_after` and
/// `head_after`. Looks at the newest open entry of the undo stack.
/// Does NOT take the write lock itself: call it while the lock is held
/// (after `operation_continue`/`operation_abort`, before `undo`).
pub async fn settle_pending_undo(core: &Core, repo_id: &str) -> CoreResult<()> {
    let Some(entry) = pending_undo(core, repo_id)? else {
        return Ok(());
    };
    if status::read_operation(core, repo_id).await?.is_some() {
        return Ok(());
    }
    settle_entry(core, repo_id, &entry).await
}

/// The newest still open entry of the undo stack (`payload.pending = true`).
pub(crate) fn pending_undo(core: &Core, repo_id: &str) -> CoreResult<Option<UndoEntry>> {
    let done = core.db.with(|c| db::undo::list_done(c, repo_id, ""))?;
    Ok(done.into_iter().find(|entry| entry.payload.get("pending").and_then(Value::as_bool) == Some(true)))
}

/// Whether the open entry belongs to the operation that is running right now: same kind, same
/// branch, same state before (`before`: `orig-head` or the state before the sequence).
pub(crate) fn pending_belongs_to(entry: &UndoEntry, kind: OperationKind, ref_name: Option<&str>, before: &str) -> bool {
    let actions: &[UndoAction] = match kind {
        OperationKind::Rebase => &[UndoAction::Rebase, UndoAction::Squash, UndoAction::Reword, UndoAction::Drop],
        OperationKind::CherryPick => &[UndoAction::CherryPick],
        OperationKind::Merge | OperationKind::Revert => &[],
    };
    let started_at = match &entry.ref_name {
        Some(_) => entry.ref_before.as_deref(),
        None => Some(entry.head_before.as_str()),
    };
    actions.iter().any(|a| a.as_str() == entry.action) && entry.ref_name.as_deref() == ref_name && started_at == Some(before)
}

/// Finishes `entry` without asking about a running operation: either its operation has just
/// finished, or it is orphaned (finished or aborted in the terminal) and another one is
/// running. Does NOT take the write lock itself.
pub(crate) async fn settle_entry(core: &Core, repo_id: &str, entry: &UndoEntry) -> CoreResult<()> {
    let (current, before) = match &entry.ref_name {
        Some(name) => (rev_parse(core, repo_id, name).await?, entry.ref_before.clone()),
        None => (head_sha(&refs::read_head(core, repo_id).await?), Some(entry.head_before.clone())),
    };
    let Some(current) = current.filter(|sha| Some(sha) != before.as_ref()) else {
        core.db.with(|c| db::undo::delete(c, &entry.id))?;
        return undo::delete_backup_refs(core, repo_id, &entry.id).await;
    };
    let mut payload = entry.payload.clone();
    payload["pending"] = json!(false);
    fill_updated_refs(core, repo_id, &mut payload).await?;
    // After finishing, HEAD is attached to the branch again; without a branch it points at the new commit.
    let head_after = entry.ref_name.clone().unwrap_or_else(|| current.clone());
    let ref_after = entry.ref_name.as_ref().map(|_| current);
    core.db.with(|c| {
        c.execute(
            "update undo_entries set ref_after = ?2, head_after = ?3, payload = ?4 where id = ?1",
            rusqlite::params![entry.id, ref_after, head_after, payload.to_string()],
        )?;
        Ok(())
    })
}

/// Local branches other than `target` whose tip lies in `from..tip` – those `--update-refs`
/// moves along – as (short name, SHA), sorted by name. Branches checked out in a worktree are
/// left out: Git does not move them either.
pub(crate) async fn dependent_refs(core: &Core, repo_id: &str, from: &str, tip: &str, target: &str) -> CoreResult<Vec<(String, String)>> {
    let range = read(core, repo_id)?.args(["rev-list", &format!("{from}..{tip}")]).run().await?;
    let commits: HashSet<String> = range.stdout_lines().into_iter().map(util::decode_lossy).filter(|sha| !sha.is_empty()).collect();
    if commits.is_empty() {
        return Ok(Vec::new());
    }
    let listed = read(core, repo_id)?
        .args(["for-each-ref", "--format=%(refname:strip=2)%00%(objectname)%00%(worktreepath)", "refs/heads"])
        .run()
        .await?;
    let mut found: Vec<(String, String)> = Vec::new();
    for line in listed.stdout_lines() {
        let fields: Vec<&[u8]> = line.split(|&byte| byte == 0).collect();
        let [name, sha, worktree] = fields.as_slice() else { continue };
        let name = util::decode_lossy(name);
        let sha = util::decode_lossy(sha);
        if name != target && worktree.is_empty() && commits.contains(&sha) {
            found.push((name, sha));
        }
    }
    found.sort();
    Ok(found)
}

/// Backs up the dependent branches (`dep-<n>`) and returns `payload.updatedRefs` for them.
async fn back_up_dependents(core: &Core, repo_id: &str, undo_id: &str, dependents: &[(String, String)]) -> CoreResult<Value> {
    let mut list = Vec::with_capacity(dependents.len());
    for (index, (name, sha)) in dependents.iter().enumerate() {
        undo::create_backup_ref(core, repo_id, undo_id, &format!("dep-{index}"), sha).await?;
        list.push(json!({ "ref": format!("refs/heads/{name}"), "before": sha, "after": Value::Null }));
    }
    Ok(Value::Array(list))
}

/// Writes the current position of every ref in `payload.updatedRefs` as its `after`.
pub(crate) async fn fill_updated_refs(core: &Core, repo_id: &str, payload: &mut Value) -> CoreResult<()> {
    let Some(list) = payload.get_mut("updatedRefs").and_then(Value::as_array_mut) else { return Ok(()) };
    for item in list.iter_mut() {
        let Some(name) = item.get("ref").and_then(Value::as_str).map(str::to_string) else { continue };
        let now = rev_parse(core, repo_id, &name).await?;
        item["after"] = json!(now);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Rebase
// ---------------------------------------------------------------------------

async fn start_rebase(core: &Core, repo_id: &str, onto: &str, branch: Option<&str>, update_refs: bool, touched: &AtomicBool) -> CoreResult<OpResult> {
    ensure_no_operation(core, repo_id).await?;
    settle_pending_undo(core, repo_id).await?;
    let head = refs::read_head(core, repo_id).await?;
    let current = match &head {
        Head::Branch { branch, .. } => Some(branch.clone()),
        Head::Detached { .. } => None,
        Head::Unborn { .. } => return Err(CoreError::not_allowed("The repository doesn't have any commits yet, so there's nothing to rebase.")),
    };
    let wanted = branch.map(|b| b.strip_prefix("refs/heads/").unwrap_or(b).trim()).filter(|b| !b.is_empty());
    let target = match (wanted, &current) {
        (Some(b), _) => b.to_string(),
        (None, Some(b)) => b.clone(),
        (None, None) => {
            return Err(CoreError::not_allowed(
                "HEAD doesn't point to a branch (detached HEAD). Check out a branch first.",
            ))
        }
    };
    let branch_ref = format!("refs/heads/{target}");
    let Some(old_tip) = rev_parse(core, repo_id, &format!("{branch_ref}^{{commit}}")).await? else {
        return Err(CoreError::not_found(format!("The branch “{target}” doesn't exist.")));
    };
    let onto_sha = resolve_commit(core, repo_id, onto).await?;
    ensure_clean(core, repo_id).await?;

    // Already up to date: `onto` is an ancestor and there is no merge in between that Git would flatten.
    if is_ancestor(core, repo_id, &onto_sha, &old_tip).await? {
        let merges = read(core, repo_id)?
            .args(["rev-list", "--count", "--min-parents=2", &format!("{onto_sha}..{old_tip}")])
            .run_text()
            .await?;
        if merges.trim() == "0" {
            return Ok(OpResult::UpToDate);
        }
    }

    // What the rebase does along the way is stated in the message afterwards: Git flattens merge
    // commits in the range (their commits then lie there individually), and commits that are already
    // on a remote get new SHAs – the next push then has to be forced.
    let range = format!("{onto_sha}..{old_tip}");
    let count = |extra: &'static [&'static str]| {
        let range = range.clone();
        async move {
            let text = read(core, repo_id)?.args(["rev-list", "--count"]).args(extra).arg(&range).run_text().await?;
            Ok::<usize, CoreError>(text.trim().parse().unwrap_or(0))
        }
    };
    let merges = count(&["--min-parents=2"]).await?;
    let unpushed = {
        let text = read(core, repo_id)?.args(["rev-list", "--count", &old_tip, "--not", &onto_sha, "--remotes"]).run_text().await?;
        text.trim().parse::<usize>().unwrap_or(0)
    };
    let pushed = count(&[]).await?.saturating_sub(unpushed);

    let onto_name = display_rev(onto, &onto_sha);
    let mut ctx = Rewrite {
        undo_id: undo::new_id(),
        action: UndoAction::Rebase,
        label: format!("Undo rebase of {target} onto {onto_name}"),
        branch: target.clone(),
        old_tip: old_tip.clone(),
        head_before: head_key(&head),
        payload: json!({ "branch": target, "onto": onto_sha, "ontoName": onto_name, "summary": Value::Null }),
        what: "rebase",
    };
    undo::create_backup_ref(core, repo_id, &ctx.undo_id, "before", &old_tip).await?;
    let dependents = if update_refs { dependent_refs(core, repo_id, &onto_sha, &old_tip, &target).await? } else { Vec::new() };
    if !dependents.is_empty() {
        match back_up_dependents(core, repo_id, &ctx.undo_id, &dependents).await {
            Ok(list) => ctx.payload["updatedRefs"] = list,
            Err(e) => {
                undo::delete_backup_refs(core, repo_id, &ctx.undo_id).await?;
                return Err(e);
            }
        }
    }
    touched.store(true, Ordering::SeqCst);
    let hooks = Hooks::start(core, repo_id).await;
    let mut cmd = hooks
        .wrap(core.git_for(repo_id)?)
        .args(rebase_config(update_refs))
        .arg("rebase")
        .args(update_refs.then_some("--update-refs"))
        .args(["--no-autostash", &onto_sha]);
    if current.as_deref() != Some(target.as_str()) {
        // The short name: with `refs/heads/…` Git would rebase the commit without a branch.
        cmd = cmd.arg(&target);
    }
    let out = cmd.run_raw().await;
    let ran = hooks.finish(core, repo_id);
    let out = out?;
    let concluded = conclude_rebase(core, repo_id, &out, ctx).await;
    match prefer_hook_failure(core, repo_id, concluded, &ran, &out, "the rebase").await? {
        Finished::Stopped(result) => Ok(result),
        Finished::Unchanged => Ok(OpResult::UpToDate),
        Finished::Done(new_tip) => {
            let fast_forward = new_tip == onto_sha;
            let summary = if fast_forward {
                format!("{} was fast-forwarded to {}.", quoted(&target), quoted(&onto_name))
            } else {
                let count = count_commits(core, repo_id, &onto_sha, &new_tip).await?;
                let mut text = format!("Rebased {} of {} onto {}.", commits_label(count), quoted(&target), quoted(&onto_name));
                if merges > 0 {
                    text.push_str(&if merges == 1 {
                        " 1 merge commit was flattened in the process: the commits it brought in are now on the branch individually.".to_string()
                    } else {
                        format!(" {merges} merge commits were flattened in the process: the commits they brought in are now on the branch individually.")
                    });
                }
                if pushed > 0 {
                    text.push_str(&if pushed == 1 {
                        " 1 of these commits was already on the remote: the next push has to be forced (“Force push”).".to_string()
                    } else {
                        format!(" {pushed} of these commits were already on the remote: the next push has to be forced (“Force push”).")
                    });
                }
                text
            };
            Ok(OpResult::Done { sha: Some(new_tip), fast_forward, summary })
        }
    }
}

/// What a rewriting rebase records for undo.
struct Rewrite {
    undo_id: String,
    action: UndoAction,
    label: String,
    branch: String,
    old_tip: String,
    head_before: String,
    payload: Value,
    /// For error messages: "Rebase", "Interactive Rebase", "Squash".
    what: &'static str,
}

enum Finished {
    /// Done; the new tip of the branch.
    Done(String),
    /// Git changed nothing.
    Unchanged,
    /// Paused with conflicts.
    Stopped(OpResult),
}

/// Evaluates a finished `git rebase` and creates the undo entry. A rebase that paused gets
/// an open entry (see `settle_pending_undo`).
async fn conclude_rebase(core: &Core, repo_id: &str, out: &GitOutput, ctx: Rewrite) -> CoreResult<Finished> {
    let branch_ref = format!("refs/heads/{}", ctx.branch);
    if out.success() {
        let new_tip = rev_parse(core, repo_id, &branch_ref).await?.unwrap_or_else(|| ctx.old_tip.clone());
        if new_tip == ctx.old_tip {
            undo::delete_backup_refs(core, repo_id, &ctx.undo_id).await?;
            return Ok(Finished::Unchanged);
        }
        record_rewrite(core, repo_id, ctx, Some(new_tip.clone())).await;
        return Ok(Finished::Done(new_tip));
    }
    let operation = status::read_operation(core, repo_id).await?.filter(|op| op.kind == OperationKind::Rebase);
    let Some(operation) = operation else {
        undo::delete_backup_refs(core, repo_id, &ctx.undo_id).await?;
        return Err(rebase_error(out));
    };
    let what = ctx.what;
    record_rewrite(core, repo_id, ctx, None).await;
    let files = worktree_state(core, repo_id).await?.unmerged;
    if files.is_empty() {
        return Err(stopped_error(what, "rebase", out));
    }
    Ok(Finished::Stopped(OpResult::Conflict { files, operation: Some(operation), note: None }))
}

/// Undo entry for a rebase. `ref_after = None` means: not finished yet (conflict).
/// A failure to save does not make the action fail – it has already happened.
async fn record_rewrite(core: &Core, repo_id: &str, ctx: Rewrite, ref_after: Option<String>) {
    let pending = ref_after.is_none();
    let mut payload = ctx.payload;
    payload["pending"] = json!(pending);
    if !pending {
        if let Err(e) = fill_updated_refs(core, repo_id, &mut payload).await {
            log::warn!("Positions of the branches moved along not recorded: {}", e.message);
        }
    }
    let branch_ref = format!("refs/heads/{}", ctx.branch);
    let record = UndoRecord {
        id: ctx.undo_id,
        repo_id: repo_id.to_string(),
        worktree_path: String::new(),
        action: ctx.action,
        label: ctx.label,
        ref_name: Some(branch_ref.clone()),
        ref_before: Some(ctx.old_tip),
        ref_after,
        head_before: ctx.head_before,
        head_after: (!pending).then_some(branch_ref),
        payload,
    };
    if let Err(e) = undo::record(core, record).await {
        log::warn!("Undo entry not saved: {}", e.message);
    }
}

fn rebase_error(out: &GitOutput) -> CoreError {
    let text = format!("{}\n{}", out.stderr_text(), out.stdout_text()).to_lowercase();
    if text.contains("problem with the editor") || text.contains("unable to start editor") {
        return CoreError::io("The plan couldn't be passed to Git (the helper program for the todo file failed).")
            .with_git_output(out.stderr_text());
    }
    if text.contains("already checked out") || text.contains("already used by worktree") {
        return CoreError::not_allowed("The branch is checked out in another worktree and can't be rebased here.")
            .with_git_output(out.stderr_text());
    }
    classify("rebase", out)
}

/// Like `errors::classify`, with a more precise sentence for untracked files that are in the way.
fn classify(subcommand: &str, out: &GitOutput) -> CoreError {
    let mut error = errors::classify(subcommand, out.code, &out.stdout, &out.stderr);
    if error.git_output.as_deref().is_some_and(|text| text.contains("untracked working tree files would be overwritten")) {
        error.code = ErrorCode::DirtyWorktree;
        error.message =
            "Untracked files in the working directory would be overwritten. Move, delete or commit them first.".to_string();
    }
    error
}

/// Git stopped without any conflicted files (e.g. a hook).
fn stopped_error(what: &str, subcommand: &str, out: &GitOutput) -> CoreError {
    let base = classify(subcommand, out);
    let (code, reason) = match base.code {
        ErrorCode::Conflict | ErrorCode::Unknown => (ErrorCode::Unknown, format!("Git interrupted the operation ({what}).")),
        code => (code, base.message.clone()),
    };
    let mut error = CoreError::new(code, format!("{reason} The operation is paused; you can continue or abort it."));
    error.git_output = base.git_output;
    error
}

// ---------------------------------------------------------------------------
// Interactive Rebase
// ---------------------------------------------------------------------------

async fn apply_plan(core: &Core, repo_id: &str, base: &str, rows: &[RebasePlanRow], update_refs: bool, touched: &AtomicBool) -> CoreResult<OpResult> {
    ensure_no_operation(core, repo_id).await?;
    settle_pending_undo(core, repo_id).await?;
    let head = refs::read_head(core, repo_id).await?;
    let (branch, head_sha) = require_branch(&head, "An interactive rebase")?;
    let base_sha = resolve_commit(core, repo_id, base).await?;
    if base_sha == head_sha || !is_ancestor(core, repo_id, &base_sha, &head_sha).await? {
        return Err(CoreError::stale_state());
    }
    let commits = read_range(core, repo_id, &base_sha).await?;
    // The plan must contain exactly the commits base..HEAD, each one once.
    let known: HashSet<&str> = commits.iter().map(|c| c.sha.as_str()).collect();
    let steps: Vec<Step> = rows
        .iter()
        .map(|r| Step { sha: r.sha.trim().to_ascii_lowercase(), action: r.action, message: r.message.clone() })
        .collect();
    let planned: HashSet<&str> = steps.iter().map(|s| s.sha.as_str()).collect();
    if steps.len() != commits.len() || planned != known {
        return Err(CoreError::stale_state());
    }
    if commits.iter().any(|c| c.parents.len() > 1) {
        return Err(CoreError::not_allowed(
            "The range contains merge commits. An interactive rebase would flatten them, which isn't supported.",
        ));
    }
    let (entries, stats) = plan_entries(&steps, &commits)?;
    if stats.is_noop() {
        return Ok(OpResult::UpToDate);
    }
    ensure_clean(core, repo_id).await?;

    let (action, label) = stats.undo_label(&branch);
    let mut ctx = Rewrite {
        undo_id: undo::new_id(),
        action,
        label,
        branch: branch.clone(),
        old_tip: head_sha.clone(),
        head_before: head_key(&head),
        payload: json!({ "branch": branch, "base": base_sha, "summary": stats.single_summary() }),
        what: "interactive rebase",
    };
    let dependents = if update_refs { dependent_refs(core, repo_id, &base_sha, &head_sha, &branch).await? } else { Vec::new() };
    let updates: Vec<(String, String)> = dependents.iter().map(|(name, sha)| (format!("refs/heads/{name}"), sha.clone())).collect();
    let todo = render_todo(core, repo_id, &entries, &updates).await?;
    undo::create_backup_ref(core, repo_id, &ctx.undo_id, "before", &head_sha).await?;
    if !dependents.is_empty() {
        match back_up_dependents(core, repo_id, &ctx.undo_id, &dependents).await {
            Ok(list) => ctx.payload["updatedRefs"] = list,
            Err(e) => {
                undo::delete_backup_refs(core, repo_id, &ctx.undo_id).await?;
                return Err(e);
            }
        }
    }
    touched.store(true, Ordering::SeqCst);
    let out = run_interactive(core, repo_id, Some(&base_sha), &todo, update_refs).await;
    let (out, ran) = match out {
        Ok(out) => out,
        Err(e) => {
            undo::delete_backup_refs(core, repo_id, &ctx.undo_id).await?;
            return Err(e);
        }
    };
    let concluded = conclude_rebase(core, repo_id, &out, ctx).await;
    match prefer_hook_failure(core, repo_id, concluded, &ran, &out, "the rebase").await? {
        Finished::Stopped(result) => Ok(result),
        Finished::Unchanged => Ok(OpResult::UpToDate),
        Finished::Done(new_tip) => Ok(OpResult::Done { sha: Some(new_tip), fast_forward: false, summary: stats.summary() }),
    }
}

/// One row of the plan as the UI sends it.
#[derive(Debug, Clone)]
struct Step {
    sha: String,
    action: RebaseAction,
    message: Option<String>,
}

/// One entry of the todo file.
#[derive(Debug, Clone, PartialEq, Eq)]
enum TodoEntry {
    Drop(String),
    /// `pick target`, then the commits that are folded into it and – if set –
    /// the new message of the result.
    Group { target: String, fixups: Vec<String>, message: Option<String> },
}

/// What a plan does; the undo entry and the summary are derived from it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct PlanStats {
    /// Commits that are merged into another one.
    squashed: usize,
    /// Commits that take in others.
    squash_targets: usize,
    /// Summaries of the reworded commits (without squash targets).
    reworded: Vec<String>,
    /// Summaries of the removed commits.
    dropped: Vec<String>,
    reordered: bool,
}

impl PlanStats {
    fn is_noop(&self) -> bool {
        self.squashed == 0 && self.reworded.is_empty() && self.dropped.is_empty() && !self.reordered
    }

    fn kinds(&self) -> usize {
        [self.squashed > 0, !self.reworded.is_empty(), !self.dropped.is_empty()].iter().filter(|k| **k).count()
    }

    fn undo_label(&self, branch: &str) -> (UndoAction, String) {
        let several = |list: &[String], verb: &str| match list {
            [one] => format!("Undo {verb} of {}", quoted(one)),
            many => format!("Undo {verb} of {}", commits_label(many.len())),
        };
        if self.reordered || self.kinds() != 1 {
            (UndoAction::Rebase, format!("Undo interactive rebase of {branch}"))
        } else if self.squashed > 0 {
            (UndoAction::Squash, format!("Undo squash of {}", commits_label(self.squashed + self.squash_targets)))
        } else if !self.reworded.is_empty() {
            (UndoAction::Reword, several(&self.reworded, "reword"))
        } else {
            (UndoAction::Drop, several(&self.dropped, "drop"))
        }
    }

    /// Summary for `payload.summary` when exactly one commit is reworded or removed.
    fn single_summary(&self) -> Value {
        match (self.reworded.as_slice(), self.dropped.as_slice()) {
            ([one], []) | ([], [one]) if self.squashed == 0 => json!(one),
            _ => Value::Null,
        }
    }

    fn summary(&self) -> String {
        let mut parts = Vec::new();
        if self.squashed > 0 {
            parts.push(format!("{} squashed", commits_label(self.squashed + self.squash_targets)));
        }
        if !self.reworded.is_empty() {
            parts.push(format!("{} reworded", commits_label(self.reworded.len())));
        }
        if !self.dropped.is_empty() {
            parts.push(format!("{} dropped", commits_label(self.dropped.len())));
        }
        if self.reordered {
            parts.push("order changed".to_string());
        }
        format!("Interactive rebase complete: {}.", parts.join(", "))
    }
}

/// Turns the rows of the plan into the entries of the todo file and checks the rules:
/// squash needs a non-dropped commit before it, reword needs a message, and
/// at least one commit remains. `commits` are the commits of the range, oldest first.
fn plan_entries(steps: &[Step], commits: &[RangeCommit]) -> CoreResult<(Vec<TodoEntry>, PlanStats)> {
    struct Open {
        index: usize,
        action: RebaseAction,
        /// Message of the target row or of the last squash row that carries one.
        own: Option<String>,
        from_squash: Option<String>,
        /// The `squash` rows of the group (their messages join the result; `fixup` rows' do not).
        squashes: Vec<String>,
    }
    let by_sha: HashMap<&str, &RangeCommit> = commits.iter().map(|c| (c.sha.as_str(), c)).collect();
    let summary_of = |sha: &str| by_sha.get(sha).map(|c| c.summary.clone()).unwrap_or_else(|| short_sha(sha));
    let mut entries: Vec<TodoEntry> = Vec::new();
    let mut groups: Vec<Open> = Vec::new();
    let mut stats = PlanStats::default();
    let mut kept: Vec<&str> = Vec::new();

    for step in steps {
        let message = step.message.as_deref().and_then(normalize_message);
        match step.action {
            RebaseAction::Drop => {
                stats.dropped.push(summary_of(&step.sha));
                entries.push(TodoEntry::Drop(step.sha.clone()));
            }
            RebaseAction::Pick | RebaseAction::Reword => {
                if step.action == RebaseAction::Reword && message.is_none() {
                    return Err(CoreError::new(
                        ErrorCode::EmptyMessage,
                        format!("The new commit message for {} is empty.", quoted(&summary_of(&step.sha))),
                    ));
                }
                kept.push(&step.sha);
                groups.push(Open { index: entries.len(), action: step.action, own: message, from_squash: None, squashes: Vec::new() });
                entries.push(TodoEntry::Group { target: step.sha.clone(), fixups: Vec::new(), message: None });
            }
            RebaseAction::Squash | RebaseAction::Fixup => {
                let Some(open) = groups.last_mut() else {
                    return Err(CoreError::not_allowed(if step.action == RebaseAction::Squash {
                        "The first commit in the plan can't be “squash”: there has to be a commit before it to squash into."
                    } else {
                        "The first commit in the plan can't be “fixup”: there has to be a commit before it to fold it into."
                    }));
                };
                kept.push(&step.sha);
                if step.action == RebaseAction::Squash {
                    if message.is_some() {
                        open.from_squash = message;
                    }
                    open.squashes.push(step.sha.clone());
                }
                if let Some(TodoEntry::Group { fixups, .. }) = entries.get_mut(open.index) {
                    fixups.push(step.sha.clone());
                }
            }
        }
    }
    if groups.is_empty() {
        return Err(CoreError::not_allowed("At least one commit has to be kept."));
    }

    for open in groups {
        let Some(TodoEntry::Group { target, fixups, message }) = entries.get_mut(open.index) else {
            continue;
        };
        let original = by_sha.get(target.as_str()).and_then(|c| normalize_message(&c.message));
        if fixups.is_empty() {
            // Without squash only reword counts, and only if the message really changes.
            if open.action == RebaseAction::Reword && open.own != original {
                stats.reworded.push(summary_of(target));
                *message = open.own;
            }
            continue;
        }
        stats.squashed += fixups.len();
        stats.squash_targets += 1;
        if open.squashes.is_empty() {
            // Only `fixup` rows: the target keeps its message unless the result got its own.
            *message = open.own;
            continue;
        }
        let combined = || {
            let parts: Vec<String> = std::iter::once(target.as_str())
                .chain(open.squashes.iter().map(String::as_str))
                .filter_map(|sha| by_sha.get(sha).and_then(|c| normalize_message(&c.message)))
                .map(|m| m.trim_end().to_string())
                .collect();
            normalize_message(&parts.join("\n\n"))
        };
        *message = open.own.or(open.from_squash).or_else(combined);
        if message.is_none() {
            return Err(CoreError::new(ErrorCode::EmptyMessage, "The commit message for the squashed commits is empty."));
        }
    }

    let original_order: Vec<&str> = commits.iter().map(|c| c.sha.as_str()).filter(|sha| kept.contains(sha)).collect();
    stats.reordered = !commits.is_empty() && original_order != kept;
    Ok((entries, stats))
}

/// Writes the todo file. For every new message an empty commit is created on the
/// target, which `fixup -C` folds in: it changes nothing and only contributes its message.
/// `updates` (full ref name, SHA): after the entry that contains the SHA, an `update-ref` line
/// moves that branch to the result (`--update-refs`).
async fn render_todo(core: &Core, repo_id: &str, entries: &[TodoEntry], updates: &[(String, String)]) -> CoreResult<String> {
    let mut todo = String::new();
    for entry in entries {
        let shas: Vec<&str> = match entry {
            TodoEntry::Drop(sha) => {
                todo.push_str(&format!("drop {sha}\n"));
                vec![sha.as_str()]
            }
            TodoEntry::Group { target, fixups, message } => {
                todo.push_str(&format!("pick {target}\n"));
                for sha in fixups {
                    todo.push_str(&format!("fixup {sha}\n"));
                }
                if let Some(message) = message {
                    let carrier = message_commit(core, repo_id, target, message).await?;
                    todo.push_str(&format!("fixup -C {carrier}\n"));
                }
                std::iter::once(target.as_str()).chain(fixups.iter().map(String::as_str)).collect()
            }
        };
        for (name, sha) in updates {
            if shas.contains(&sha.as_str()) {
                todo.push_str(&format!("update-ref {name}\n"));
            }
        }
    }
    Ok(todo)
}

/// Empty commit on `target` that only carries a message. The header line "amend!" is
/// the form Git intends for this: Git discards it and takes the rest verbatim –
/// even if the message itself starts with "fixup!", "amend!" or "#".
async fn message_commit(core: &Core, repo_id: &str, target: &str, message: &str) -> CoreResult<String> {
    let Some(tree) = rev_parse(core, repo_id, &format!("{target}^{{tree}}")).await? else {
        return Err(CoreError::stale_state());
    };
    let out = core
        .git_for(repo_id)?
        .args(["commit-tree", "--no-gpg-sign", &tree, "-p", target])
        .stdin(format!("amend! forkyard\n\n{message}"))
        .no_log()
        .run()
        .await?;
    Ok(out.stdout_text())
}

/// `git rebase -i` with our todo file. `base = None` means `--root`. Also returns which
/// hooks ran along the way (already reported as `hook:output`).
async fn run_interactive(core: &Core, repo_id: &str, base: Option<&str>, todo: &str, update_refs: bool) -> CoreResult<(GitOutput, Vec<HookOutput>)> {
    let helper = find_editor_helper(core)?;
    let call = editor_call(&helper);
    let dir = core.data_dir().join("tmp");
    std::fs::create_dir_all(&dir)?;
    let file = dir.join(format!("rebase-todo-{}", util::new_id()));
    std::fs::write(&file, todo)?;
    // --empty=keep: the todo file is executed exactly as written. If a commit that became
    // empty were dropped, a following fixup would hit the wrong commit.
    let hooks = Hooks::start(core, repo_id).await;
    let mut cmd = hooks
        .wrap(core.git_for(repo_id)?)
        .args(rebase_config(update_refs))
        .args(["rebase", "--interactive", "--no-autostash", "--empty=keep"])
        .args(update_refs.then_some("--update-refs"))
        .env("GIT_SEQUENCE_EDITOR", &call.command)
        .env(SEQUENCE_TODO_ENV, &file);
    if let Some(path) = &call.path {
        cmd = cmd.env("PATH", path);
    }
    cmd = match base {
        Some(base) => cmd.arg(base),
        None => cmd.arg("--root"),
    };
    let out = cmd.run_raw().await;
    let ran = hooks.finish(core, repo_id);
    let _ = std::fs::remove_file(&file);
    Ok((out?, ran))
}

// ---------------------------------------------------------------------------
// Squash
// ---------------------------------------------------------------------------

async fn squash(core: &Core, repo_id: &str, shas: &[String], message: &str, touched: &AtomicBool) -> CoreResult<OpResult> {
    let Some(message) = normalize_message(message) else {
        return Err(CoreError::new(ErrorCode::EmptyMessage, "The commit message is empty."));
    };
    require_shas(shas)?;
    ensure_no_operation(core, repo_id).await?;
    settle_pending_undo(core, repo_id).await?;
    let head = refs::read_head(core, repo_id).await?;
    let (branch, head_sha) = require_branch(&head, "Squashing")?;

    let mut resolve = read(core, repo_id)?.arg("rev-parse");
    for sha in shas {
        resolve = resolve.arg(format!("{}^{{commit}}", sha.trim()));
    }
    let resolved = resolve.run_raw().await?;
    if !resolved.success() {
        return Err(CoreError::not_found("At least one of the selected commits doesn't exist (anymore).").with_git_output(resolved.stderr_text()));
    }
    let wanted: HashSet<String> = resolved.stdout_lines().into_iter().map(util::decode_lossy).filter(|l| !l.is_empty()).collect();
    if wanted.len() < 2 {
        return Err(CoreError::not_allowed("Select at least two commits to squash."));
    }

    // Read downwards from HEAD until all selected commits have been seen.
    let mut chain: Vec<(String, Vec<String>)> = Vec::new();
    let mut missing = wanted.len();
    read(core, repo_id)?
        .args(["rev-list", "--topo-order", "--parents", "HEAD"])
        .run_records(b'\n', None, &mut |line: &[u8]| {
            let text = util::decode_lossy(line);
            let mut parts = text.split_whitespace().map(str::to_string);
            let Some(sha) = parts.next() else {
                return true;
            };
            if wanted.contains(&sha) {
                missing -= 1;
            }
            chain.push((sha, parts.collect()));
            missing > 0
        })
        .await?;
    if missing > 0 {
        return Err(CoreError::not_allowed(
            "Not all of the selected commits are on the checked-out branch. You can only squash commits on the branch that's checked out.",
        ));
    }
    if chain.iter().any(|(sha, parents)| parents.len() > 1 && wanted.contains(sha)) {
        return Err(CoreError::not_allowed("Merge commits can't be squashed."));
    }
    if chain.iter().any(|(_, parents)| parents.len() > 1) {
        return Err(CoreError::not_allowed(
            "There's a merge commit above the selected commits. The commits above it would have to be reapplied, which would flatten the merge.",
        ));
    }
    // Without a merge, `chain` is the straight line from HEAD to the oldest selected commit.
    let newest = chain.iter().position(|(sha, _)| wanted.contains(sha)).unwrap_or(0);
    if chain.len() - newest != wanted.len() {
        return Err(CoreError::not_allowed(
            "The selected commits aren't consecutive. You can only squash consecutive commits.",
        ));
    }
    ensure_clean(core, repo_id).await?;

    let base = chain.last().and_then(|(_, parents)| parents.first().cloned());
    let steps: Vec<Step> = chain
        .iter()
        .rev()
        .enumerate()
        .map(|(i, (sha, _))| Step {
            sha: sha.clone(),
            action: if i > 0 && wanted.contains(sha) { RebaseAction::Squash } else { RebaseAction::Pick },
            message: (i == 0).then(|| message.clone()),
        })
        .collect();
    let (entries, _) = plan_entries(&steps, &[])?;
    let summary_line = message.lines().next().unwrap_or_default().to_string();
    let ctx = Rewrite {
        undo_id: undo::new_id(),
        action: UndoAction::Squash,
        label: format!("Undo squash of {}", commits_label(wanted.len())),
        branch: branch.clone(),
        old_tip: head_sha.clone(),
        head_before: head_key(&head),
        payload: json!({ "branch": branch, "base": base, "summary": summary_line, "count": wanted.len() }),
        what: "squash",
    };
    let todo = render_todo(core, repo_id, &entries, &[]).await?;
    undo::create_backup_ref(core, repo_id, &ctx.undo_id, "before", &head_sha).await?;
    touched.store(true, Ordering::SeqCst);
    let (out, ran) = match run_interactive(core, repo_id, base.as_deref(), &todo, false).await {
        Ok(out) => out,
        Err(e) => {
            undo::delete_backup_refs(core, repo_id, &ctx.undo_id).await?;
            return Err(e);
        }
    };
    let concluded = conclude_rebase(core, repo_id, &out, ctx).await;
    match prefer_hook_failure(core, repo_id, concluded, &ran, &out, "the squash").await? {
        Finished::Stopped(result) => Ok(result),
        Finished::Unchanged => Ok(OpResult::UpToDate),
        Finished::Done(new_tip) => {
            // The new commit sits as far below the tip as there were commits above the selection.
            let squashed = if newest == 0 { Some(new_tip) } else { rev_parse(core, repo_id, &format!("{new_tip}~{newest}")).await? };
            Ok(OpResult::Done {
                sha: squashed,
                fast_forward: false,
                summary: format!("Squashed {} into one.", commits_label(wanted.len())),
            })
        }
    }
}

// ---------------------------------------------------------------------------
// Cherry-Pick
// ---------------------------------------------------------------------------

async fn pick_commits(core: &Core, repo_id: &str, shas: &[String], empty_drop: bool, touched: &AtomicBool) -> CoreResult<OpResult> {
    require_shas(shas)?;
    ensure_no_operation(core, repo_id).await?;
    settle_pending_undo(core, repo_id).await?;
    let head = refs::read_head(core, repo_id).await?;
    let (branch, old_head) = match &head {
        Head::Branch { branch, sha } => (Some(branch.clone()), sha.clone()),
        Head::Detached { sha } => (None, sha.clone()),
        Head::Unborn { .. } => {
            return Err(CoreError::not_allowed("The repository doesn't have any commits yet; a cherry-pick needs a commit to build on."))
        }
    };
    let mut listing = read(core, repo_id)?.args(["log", "--no-walk=unsorted", "--no-show-signature", "--encoding=UTF-8", "-z", COMMIT_FORMAT]);
    for sha in shas {
        listing = listing.arg(sha.trim());
    }
    let listed = listing.run_raw().await?;
    if !listed.success() {
        return Err(CoreError::not_found("At least one of the selected commits doesn't exist (anymore).").with_git_output(listed.stderr_text()));
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
        let operation = status::read_operation(core, repo_id).await?.filter(|op| op.kind == OperationKind::CherryPick);
        let Some(operation) = operation else {
            break Some(Stop::Failed);
        };
        let state = worktree_state(core, repo_id).await?;
        if !state.unmerged.is_empty() {
            break Some(Stop::Conflict(state.unmerged, operation));
        }
        // Git only writes CHERRY_PICK_HEAD if it could apply the commit.
        let git_dir = status::git_dir(core, repo_id).await?;
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

    let new_head = rev_parse(core, repo_id, "HEAD").await?.unwrap_or_else(|| old_head.clone());
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
            head_before: head_key(&head),
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
                format!(
                    "{reason} {which} wasn't applied; the cherry-pick stopped there ({applied} of {} applied).",
                    commits.len()
                ),
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
// Helpers
// ---------------------------------------------------------------------------

/// Runs `action` under the write lock. `repo:changed` is only emitted if the
/// action really made Git write something – a refused precondition
/// (uncommitted changes, running operation) should not make the UI reload.
async fn write_action<T, F>(core: &Core, repo_id: &str, touched: &AtomicBool, action: F) -> CoreResult<T>
where
    F: Future<Output = CoreResult<T>>,
{
    let result = core.with_write_lock(repo_id, &[], action).await;
    if touched.load(Ordering::SeqCst) {
        core.emit_repo_changed(repo_id, CHANGES);
    }
    result
}

fn read(core: &Core, repo_id: &str) -> CoreResult<GitCmd> {
    Ok(core.git_for(repo_id)?.read_only().no_log())
}

fn operation_in_progress() -> CoreError {
    CoreError::new(
        ErrorCode::OperationInProgress,
        "A merge, rebase, cherry-pick or revert is already in progress. Finish or abort it first.",
    )
}

async fn ensure_no_operation(core: &Core, repo_id: &str) -> CoreResult<()> {
    match status::read_operation(core, repo_id).await? {
        Some(_) => Err(operation_in_progress()),
        None => Ok(()),
    }
}

struct WorktreeState {
    /// Tracked files are changed (staged or unstaged). Untracked ones don't count.
    dirty: bool,
    /// Paths with conflicts, decoded for display.
    unmerged: Vec<String>,
}

async fn worktree_state(core: &Core, repo_id: &str) -> CoreResult<WorktreeState> {
    let out = read(core, repo_id)?.args(["status", "--porcelain=v2", "-z", "--untracked-files=no"]).run().await?;
    let parsed = status::parse_porcelain_v2(&out.stdout);
    let unmerged = parsed.entries.iter().filter(|e| e.kind == EntryKind::Unmerged).map(|e| util::decode_lossy(&e.path)).collect();
    Ok(WorktreeState { dirty: !parsed.entries.is_empty(), unmerged })
}

/// No autostash without the user knowing: uncommitted changes abort.
async fn ensure_clean(core: &Core, repo_id: &str) -> CoreResult<()> {
    if worktree_state(core, repo_id).await?.dirty {
        return Err(CoreError::new(
            ErrorCode::DirtyWorktree,
            "There are uncommitted changes. Commit or stash them first; Forkyard won't stash anything for you here.",
        ));
    }
    Ok(())
}

fn require_branch(head: &Head, what: &str) -> CoreResult<(String, String)> {
    match head {
        Head::Branch { branch, sha } => Ok((branch.clone(), sha.clone())),
        Head::Detached { .. } => Err(CoreError::not_allowed(format!(
            "HEAD doesn't point to a branch (detached HEAD). {what} only works on a checked-out branch."
        ))),
        Head::Unborn { .. } => Err(CoreError::not_allowed("The repository doesn't have any commits yet.")),
    }
}

/// The UI sends SHAs; anything else (options, ranges) is not passed to Git.
fn require_shas(shas: &[String]) -> CoreResult<()> {
    if shas.is_empty() {
        return Err(CoreError::not_allowed("No commit is selected."));
    }
    for sha in shas {
        let sha = sha.trim();
        if !(4..=64).contains(&sha.len()) || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(CoreError::not_found(format!("“{sha}” isn't a valid commit.")));
        }
    }
    Ok(())
}

async fn rev_parse(core: &Core, repo_id: &str, rev: &str) -> CoreResult<Option<String>> {
    let out = read(core, repo_id)?.args(["rev-parse", "--verify", "--quiet", rev]).run_raw().await?;
    Ok(out.success().then(|| out.stdout_text()).filter(|sha| !sha.is_empty()))
}

/// Resolve a branch, remote branch or SHA to a commit.
async fn resolve_commit(core: &Core, repo_id: &str, rev: &str) -> CoreResult<String> {
    let rev = rev.trim();
    // A short name means the local branch first, not a tag of the same name.
    let found = crate::commands::branches::resolve_commit(core, repo_id, rev).await?;
    found.ok_or_else(|| CoreError::not_found(format!("“{rev}” wasn't found in the repository.")))
}

async fn is_ancestor(core: &Core, repo_id: &str, ancestor: &str, descendant: &str) -> CoreResult<bool> {
    let out = read(core, repo_id)?.args(["merge-base", "--is-ancestor", ancestor, descendant]).run_raw().await?;
    match out.code {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        code => Err(errors::classify("merge-base", code, &out.stdout, &out.stderr)),
    }
}

async fn count_commits(core: &Core, repo_id: &str, from: &str, to: &str) -> CoreResult<usize> {
    let text = read(core, repo_id)?.args(["rev-list", "--count", &format!("{from}..{to}")]).run_text().await?;
    Ok(text.trim().parse().unwrap_or(0))
}

/// A commit with everything the plan and the todo file need.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RangeCommit {
    sha: String,
    parents: Vec<String>,
    author: Person,
    authored_at: String,
    summary: String,
    description: String,
    /// The whole message as Git stored it.
    message: String,
}

/// Commits `base..HEAD`, oldest first (as in Git's todo file).
async fn read_range(core: &Core, repo_id: &str, base: &str) -> CoreResult<Vec<RangeCommit>> {
    let out = read(core, repo_id)?
        .args(["log", "--reverse", "--topo-order", "--no-show-signature", "--encoding=UTF-8", "-z", COMMIT_FORMAT])
        .arg(format!("{base}..HEAD"))
        .run()
        .await?;
    Ok(parse_commits(&out.stdout))
}

fn parse_commits(stdout: &[u8]) -> Vec<RangeCommit> {
    let fields: Vec<&[u8]> = util::split_z(stdout).collect();
    fields
        .chunks_exact(COMMIT_FIELDS)
        .map(|f| {
            let text = |i: usize| util::decode_lossy(f[i]);
            RangeCommit {
                sha: text(0).trim().to_string(),
                parents: text(1).split_whitespace().map(str::to_string).collect(),
                author: Person { name: text(2), email: text(3) },
                authored_at: util::unix_to_iso(text(4).trim().parse().unwrap_or(0)),
                summary: text(5),
                description: text(6).trim_end().to_string(),
                message: text(7),
            }
        })
        .collect()
}

/// Normalise a message: LF, no blank lines at the start, exactly one line ending at the
/// end. `None` if nothing is left.
fn normalize_message(text: &str) -> Option<String> {
    let text = text.replace("\r\n", "\n").replace(['\r', '\0'], "");
    let lines: Vec<&str> = text.lines().skip_while(|l| l.trim().is_empty()).collect();
    let body = lines.join("\n");
    let body = body.trim_end();
    (!body.is_empty()).then(|| format!("{body}\n"))
}

fn head_key(head: &Head) -> String {
    match head {
        Head::Branch { branch, .. } | Head::Unborn { branch } => format!("refs/heads/{branch}"),
        Head::Detached { sha } => sha.clone(),
    }
}

fn head_sha(head: &Head) -> Option<String> {
    match head {
        Head::Branch { sha, .. } | Head::Detached { sha } => Some(sha.clone()),
        Head::Unborn { .. } => None,
    }
}

fn short_sha(sha: &str) -> String {
    sha.chars().take(7).collect()
}

/// How the UI names the target: branch name, or the short SHA.
fn display_rev(given: &str, sha: &str) -> String {
    let given = given.trim();
    let is_sha = given.len() >= 4 && given.bytes().all(|b| b.is_ascii_hexdigit()) && sha.starts_with(&given.to_ascii_lowercase());
    if is_sha {
        return short_sha(sha);
    }
    refs::short_ref_name(given).to_string()
}

fn commits_label(count: usize) -> String {
    if count == 1 {
        "1 commit".to_string()
    } else {
        format!("{count} commits")
    }
}

/// Summary in "…", shortened for refusal texts (the way the UI writes names elsewhere too).
fn named(text: &str) -> String {
    let inner = quoted(text);
    format!("“{}”", inner.trim_start_matches('‘').trim_end_matches('’'))
}

/// Summary in single quotes, shortened for sentences.
fn quoted(text: &str) -> String {
    const MAX: usize = 60;
    let text = text.trim();
    if text.chars().count() > MAX {
        let short: String = text.chars().take(MAX).collect();
        format!("‘{}…’", short.trim_end())
    } else {
        format!("‘{text}’")
    }
}

// ---------------------------------------------------------------------------
// Helper program for the todo file
// ---------------------------------------------------------------------------

/// Environment variable with the path of the prepared todo file. If it is set,
/// the program works as a sequence editor (see `editor_helper_entry`).
pub const SEQUENCE_TODO_ENV: &str = "FORKYARD_SEQUENCE_TODO";
/// Fixed path to the helper program instead of searching for it.
pub const EDITOR_HELPER_ENV: &str = "FORKYARD_EDITOR_HELPER";
/// Name of the standalone helper program (without extension).
pub const EDITOR_HELPER_NAME: &str = "forkyard-editor";
/// Name of the file Git passes to the sequence editor.
const GIT_TODO_FILE: &str = "git-rebase-todo";

/// The running program calls `editor_helper_entry`, so it can be the sequence editor itself.
static HOST_IS_HELPER: AtomicBool = AtomicBool::new(false);

/// Fixed path to the helper program, per core (tests, special embeddings).
#[derive(Default)]
pub struct EditorHelper {
    program: parking_lot::Mutex<Option<PathBuf>>,
}

/// Sets the helper program for this core; `None` restores the search.
pub fn set_editor_helper(core: &Core, program: Option<PathBuf>) {
    *core.state::<EditorHelper>().program.lock() = program;
}

/// Entry point for every program that is meant to serve as a sequence editor – call it first
/// in `main`. Git starts it as `<program> <path of the todo file>`; if
/// `FORKYARD_SEQUENCE_TODO` is set, the prepared file is copied there and the
/// exit code is returned (the program then exits with it). Otherwise `None`: the
/// program starts normally and remembers that it can serve as the editor itself.
pub fn editor_helper_entry() -> Option<i32> {
    match std::env::var_os(SEQUENCE_TODO_ENV).filter(|v| !v.is_empty()) {
        Some(source) => Some(copy_todo(Path::new(&source), std::env::args_os().nth(1))),
        None => {
            HOST_IS_HELPER.store(true, Ordering::SeqCst);
            None
        }
    }
}

/// Copies the prepared todo file to the place Git names. Other files are not
/// touched: then the rebase fails instead of running the default plan.
fn copy_todo(source: &Path, target: Option<OsString>) -> i32 {
    let Some(target) = target.map(PathBuf::from) else {
        eprintln!("{EDITOR_HELPER_NAME}: Git didn't name a todo file.");
        return 2;
    };
    if target.file_name().and_then(|n| n.to_str()) != Some(GIT_TODO_FILE) {
        eprintln!("{EDITOR_HELPER_NAME}: unexpected file {}", target.display());
        return 1;
    }
    match std::fs::read(source).and_then(|content| std::fs::write(&target, content)) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("{EDITOR_HELPER_NAME}: {} -> {}: {e}", source.display(), target.display());
            1
        }
    }
}

/// Looks for the helper program: fixed path (core, then environment), the running program
/// itself, otherwise `forkyard-editor` next to the running program (one level up in tests).
fn find_editor_helper(core: &Core) -> CoreResult<PathBuf> {
    let fixed = core.state::<EditorHelper>().program.lock().clone();
    let fixed = fixed.or_else(|| util::dev_env(EDITOR_HELPER_ENV).map(PathBuf::from));
    if let Some(program) = fixed {
        // Without this check Git might find another program of the same name via PATH.
        return if program.is_file() { Ok(program) } else { Err(helper_missing(&util::display_path(&program))) };
    }
    let exe = std::env::current_exe().map_err(|e| CoreError::io(format!("Can't read the app's path: {e}")))?;
    if HOST_IS_HELPER.load(Ordering::SeqCst) {
        return Ok(exe);
    }
    let file = format!("{EDITOR_HELPER_NAME}{}", std::env::consts::EXE_SUFFIX);
    let dir = exe.parent().unwrap_or(Path::new("."));
    let mut places = vec![dir.join(&file)];
    if dir.file_name().is_some_and(|n| n == "deps") {
        if let Some(parent) = dir.parent() {
            places.push(parent.join(&file));
        }
    }
    places.into_iter().find(|p| p.is_file()).ok_or_else(|| helper_missing(&file))
}

fn helper_missing(program: &str) -> CoreError {
    CoreError::unsupported(format!(
        "The helper program “{program}” for interactive rebase wasn't found. It has to be next to the app."
    ))
}

/// How Git invokes the helper program.
struct EditorCall {
    /// Value for `GIT_SEQUENCE_EDITOR`.
    command: String,
    /// New `PATH` if the program is found by its bare name.
    path: Option<OsString>,
}

/// Git only starts an editor without a shell if the command contains no special
/// characters – a path with spaces or backslashes does. Hence the bare
/// program name, with its folder prepended to `PATH`. If that doesn't work (name with
/// special characters), the route via the shell that Git brings along remains.
fn editor_call(program: &Path) -> EditorCall {
    let file = program.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let name = if cfg!(windows) && file.to_ascii_lowercase().ends_with(".exe") { &file[..file.len() - 4] } else { file.as_str() };
    let dir = program.parent().filter(|d| !d.as_os_str().is_empty());
    if let (true, Some(dir)) = (is_plain_word(name), dir) {
        let mut dirs = vec![dir.to_path_buf()];
        if let Some(current) = std::env::var_os("PATH") {
            dirs.extend(std::env::split_paths(&current));
        }
        if let Ok(path) = std::env::join_paths(dirs) {
            return EditorCall { command: name.to_string(), path: Some(path) };
        }
    }
    EditorCall { command: sh_quote(&program.to_string_lossy().replace('\\', "/")), path: None }
}

fn is_plain_word(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+'))
}

/// Wrap in single quotes, for `sh`.
fn sh_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod update_refs_tests;

#[cfg(test)]
mod autosquash_tests;
