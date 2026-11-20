//! Committing exactly the selected lines of the unstaged diffs, without touching the staging area.
//!
//! Inside the write lock HEAD and every file token are checked, then a temporary index
//! (`GIT_INDEX_FILE`) is built: HEAD plus the selected lines. The patches of the unstaged diffs
//! apply onto the index, so where staged changes sit in their context they go in with a 3-way
//! merge (`git apply -3`); a real overlap refuses the whole commit (`selection_conflicts_with_index`).
//! `git commit` then runs on that index, so hooks and signing behave as in the terminal. Afterwards
//! the real index takes the same patches: old index + selection = new HEAD + what was staged. The
//! working directory is never written. Bytes stay bytes: everything goes through `git apply`.

use serde_json::json;

use super::{build_message, check_committable, operation_error, quoted, run_commit_on};
use crate::app::Core;
use crate::commands::stash::partial::{parts, Part};
use crate::commands::status::read_status;
use crate::db;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::index::TempIndex;
use crate::git::rev;
use crate::git::GitCmd;
use crate::model::{CommitDraft, CommitResult, Head, HookOutput, PatchSelection, RepoChange};
use crate::undo::{self, UndoAction, UndoRecord};
use crate::util;

/// What committing a selection can change.
const CHANGES: [RepoChange; 3] = [RepoChange::Index, RepoChange::Refs, RepoChange::Head];
/// Reflog message when a commit is taken back.
const TAKE_BACK_MESSAGE: &str = "forkyard: commit of a selection taken back";

/// Commits exactly the selected unstaged lines (`selections[].expect` = the unstaged `TextDiff.token`)
/// on HEAD. Working directory unchanged; staged changes stay staged.
#[allow(clippy::too_many_arguments)]
pub async fn commit_selection(
    core: &Core,
    repo_id: String,
    op_id: String,
    selections: Vec<PatchSelection>,
    summary: String,
    description: String,
    skip_hooks: bool,
    expect_head: String,
) -> CoreResult<CommitResult> {
    core.idempotent(&op_id, async {
        let message = build_message(&summary, &description)?;
        core.with_write_lock(&repo_id, &CHANGES, async {
            let prepared = prepare(core, &repo_id, &selections, &expect_head).await?;
            let forward: Vec<u8> = prepared.parts.iter().flat_map(|part| part.forward.iter().copied()).collect();
            if let Err(e) = apply_cached(core.git_for(&repo_id)?, &forward, &["--check"]).await {
                return Err(CoreError::stale_state().with_git_output(e.git_output.unwrap_or(e.message)));
            }
            let (sha, hooks) = commit_on_temp(core, &repo_id, &prepared, &message, skip_hooks).await?;
            if let Err(e) = apply_cached(core.git_for(&repo_id)?, &forward, &[]).await {
                take_back(core, &repo_id, &prepared, &sha).await;
                return Err(e);
            }
            if let Err(e) = core.db.with(|c| db::drafts::set(c, &repo_id, "", &CommitDraft::default())) {
                log::warn!("Commit draft not cleared: {}", e.message);
            }
            let token = prepared.head.token();
            let on_branch = prepared.branch_ref.is_some();
            undo::record(
                core,
                UndoRecord {
                    id: undo::new_id(),
                    repo_id: repo_id.clone(),
                    worktree_path: String::new(),
                    action: UndoAction::Commit,
                    label: format!("Undo commit {}", quoted(&summary)),
                    ref_name: prepared.branch_ref.clone(),
                    ref_before: Some(prepared.head_sha.clone()),
                    ref_after: Some(sha.clone()),
                    head_before: if on_branch { token.clone() } else { prepared.head_sha.clone() },
                    head_after: Some(if on_branch { token } else { sha.clone() }),
                    payload: json!({ "summary": summary.trim(), "merge": false, "selection": true }),
                },
            )
            .await?;
            Ok(CommitResult { sha, push: None, hooks })
        })
        .await
    })
    .await
}

/// Checked state shared with `selection_to_branch`: HEAD, the parts, the temporary index holding
/// HEAD + selection, its tree, the working-directory tree before (for the hook check).
pub(super) struct Prepared {
    pub head: Head,
    pub head_sha: String,
    pub branch_ref: Option<String>,
    pub parts: Vec<Part>,
    // Read by `selection_to_branch`.
    #[allow(dead_code)]
    pub paths: Vec<String>,
    pub index: TempIndex,
    pub tree: String,
    pub worktree_before: String,
}

/// Checks HEAD, the operation, conflicts and every token, then builds HEAD + selection on a
/// temporary index. Call inside the write lock; writes nothing but the temporary index.
pub(super) async fn prepare(core: &Core, repo_id: &str, selections: &[PatchSelection], expect_head: &str) -> CoreResult<Prepared> {
    let status = read_status(core, repo_id).await?;
    let (head_sha, branch_ref) = match &status.head {
        Head::Branch { branch, sha } => (sha.clone(), Some(format!("refs/heads/{branch}"))),
        Head::Detached { sha } => (sha.clone(), None),
        Head::Unborn { .. } => return Err(CoreError::not_allowed("Commit only this needs a first commit.")),
    };
    if !head_sha.eq_ignore_ascii_case(expect_head.trim()) {
        return Err(CoreError::stale_state());
    }
    if let Some(op) = &status.operation {
        return Err(operation_error(op.kind, "commit a selection"));
    }
    check_committable(&status)?;
    let parts = parts(core, repo_id, selections, false).await?;
    if parts.is_empty() {
        return Err(CoreError::new(ErrorCode::NothingToCommit, "No lines are selected."));
    }
    let paths: Vec<String> = parts.iter().map(|part| util::decode_lossy(&part.path)).collect();
    let worktree_before = undo::worktree_tree(core, repo_id, None).await?;

    let index = TempIndex::create(core)?;
    let on_temp = || -> CoreResult<GitCmd> { Ok(core.git_for(repo_id)?.no_log().env("GIT_INDEX_FILE", index.path())) };
    on_temp()?.args(["read-tree", head_sha.as_str()]).run().await?;
    for part in &parts {
        // `-3`: staged changes in the patch's context merge in; only a real overlap fails.
        if let Err(e) = apply_cached(on_temp()?, &with_preimage(part), &["-3"]).await {
            let file = util::decode_lossy(&part.path);
            return Err(CoreError::new(
                ErrorCode::SelectionConflictsWithIndex,
                format!("The selected lines of ‘{file}’ build on staged changes. Commit or unstage the staged changes of ‘{file}’ first."),
            )
            .with_git_output(e.git_output.unwrap_or(e.message)));
        }
    }
    let tree = on_temp()?.arg("write-tree").run_text().await?;
    Ok(Prepared { head: status.head, head_sha, branch_ref, parts, paths, index, tree, worktree_before })
}

/// `git commit` on `prepared.index`; checks parent, tree and working directory afterwards and moves
/// the branch back on a mismatch (`hook_failed`). Returns the new SHA and the hook output.
pub(super) async fn commit_on_temp(
    core: &Core,
    repo_id: &str,
    prepared: &Prepared,
    message: &str,
    skip_hooks: bool,
) -> CoreResult<(String, Vec<HookOutput>)> {
    let mut args = vec!["commit", "--cleanup=verbatim", "-F", "-"];
    if skip_hooks {
        args.push("--no-verify");
    }
    let hooks = run_commit_on(core, repo_id, &args, message, Some(prepared.index.path())).await?;
    let Some(sha) = rev::rev_parse(core, repo_id, "HEAD").await? else {
        return Err(hook_changed(&hooks, "HEAD"));
    };
    let changed = if rev::rev_parse(core, repo_id, &format!("{sha}^1")).await?.as_deref() != Some(prepared.head_sha.as_str()) {
        Some("the branch")
    } else if rev::rev_parse(core, repo_id, &format!("{sha}^{{tree}}")).await?.as_deref() != Some(prepared.tree.as_str()) {
        Some("the content of the commit")
    } else if undo::worktree_tree(core, repo_id, None).await? != prepared.worktree_before {
        Some("files in the working directory")
    } else {
        None
    };
    if let Some(what) = changed {
        take_back(core, repo_id, prepared, &sha).await;
        return Err(hook_changed(&hooks, what));
    }
    Ok((sha, hooks))
}

/// Moves the branch (or a detached HEAD) from `sha` back to the old HEAD; compare-and-swap, so a
/// ref someone else moved stays where it is.
async fn take_back(core: &Core, repo_id: &str, prepared: &Prepared, sha: &str) {
    let cmd = match core.git_for(repo_id) {
        Ok(cmd) => cmd.args(["update-ref", "-m", TAKE_BACK_MESSAGE]),
        Err(e) => return log::error!("Commit {sha} not taken back: {}", e.message),
    };
    let cmd = match &prepared.branch_ref {
        Some(branch_ref) => cmd.arg(branch_ref),
        None => cmd.args(["--no-deref", "HEAD"]),
    };
    if let Err(e) = cmd.args([prepared.head_sha.as_str(), sha]).run().await {
        log::error!("Commit {sha} not taken back to {}: {}", prepared.head_sha, e.message);
    }
}

/// The forward patch with an `index <old>..<zeros>` line: `git apply -3` needs the blob the patch
/// was made against (the index side) for the 3-way merge; the built patches carry no such line.
fn with_preimage(part: &Part) -> Vec<u8> {
    let Some(old) = part.old_id.as_deref().filter(|id| id.bytes().any(|b| b != b'0')) else { return part.forward.clone() };
    let Some(end) = part.forward.iter().position(|&b| b == b'\n') else { return part.forward.clone() };
    let mut out = part.forward[..=end].to_vec();
    out.extend_from_slice(format!("index {old}..{}\n", "0".repeat(old.len())).as_bytes());
    out.extend_from_slice(&part.forward[end + 1..]);
    out
}

/// `git apply --cached` with the patches on stdin; never complains about or "fixes" whitespace.
/// `rerere` stays out of it: a 3-way conflict on a temporary index must not record anything.
async fn apply_cached(cmd: GitCmd, patch: &[u8], extra: &[&str]) -> CoreResult<()> {
    cmd.args(["-c", "rerere.enabled=false"]).args(crate::git::GIT_APPLY).arg("--cached").args(extra).stdin(patch.to_vec()).run().await?;
    Ok(())
}

/// `hook_failed` for a hook that changed HEAD, the index or files; the hooks' output goes along.
fn hook_changed(hooks: &[HookOutput], what: &str) -> CoreError {
    let output = hooks
        .iter()
        .filter(|hook| !hook.output.is_empty())
        .map(|hook| format!("{}:\n{}", hook.hook, hook.output))
        .collect::<Vec<_>>()
        .join("\n\n");
    let error = CoreError::new(
        ErrorCode::HookFailed,
        format!(
            "A Git hook changed {what} while the commit was being created. The commit was taken back; HEAD and the index are as before, changes the hook made to files stay."
        ),
    );
    if output.is_empty() {
        error
    } else {
        error.with_git_output(output)
    }
}
