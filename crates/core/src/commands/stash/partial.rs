//! Partial stash: only selected hunks and lines go into the stash.
//!
//! `git stash push` only knows whole files, so the stash commits are built with plumbing: a
//! temporary index (`GIT_INDEX_FILE`) starts at HEAD; the selected staged parts give the index
//! commit, the selected staged and unstaged parts together the worktree commit, whose parents are
//! HEAD and the index commit – the shape `git stash` itself produces. `git stash store` puts it on
//! the list. Then exactly the selection is taken out of the working directory and the index with
//! reverse patches. Before that, the selected files and the whole index are backed up under
//! `refs/forkyard/undo/<id>/`; if taking the selection out fails, the stash is dropped again and
//! files and index come back from the backup. Bytes stay bytes (CRLF, missing final newline,
//! Latin-1): everything goes through `git apply`, never through text.

use serde_json::json;

use crate::app::Core;
use crate::commands::diff::patch::{self, Direction};
use crate::commands::diff::{patch_basis, TempIndex};
use crate::commands::refs;
use crate::commands::stage::keep_line_endings;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::GitCmd;
use crate::model::{Head, PatchSelection, StashSelection};
use crate::undo::{self, UndoAction, UndoRecord};
use crate::util;

use super::{drop_stash, read_rows, store_stash, unmerged_paths};

/// Identity of the backup commit for the index (never on the stash list).
const BACKUP_IDENTITY: [(&str, &str); 4] = [
    ("GIT_AUTHOR_NAME", "forkyard"),
    ("GIT_AUTHOR_EMAIL", "forkyard@localhost"),
    ("GIT_COMMITTER_NAME", "forkyard"),
    ("GIT_COMMITTER_EMAIL", "forkyard@localhost"),
];
/// Up to this size the line endings of a file are kept exactly when lines are taken out.
const KEEP_EOL_MAX_BYTES: u64 = 64 * 1024 * 1024;

/// Tests only: makes taking the selection out fail after the unstaged parts (rollback test).
#[cfg(test)]
#[derive(Default)]
pub(crate) struct FailRemoval(pub(crate) std::sync::atomic::AtomicBool);

/// The selected part of one file, as a patch in both directions.
struct Part {
    path: Vec<u8>,
    /// Applies onto the old side (HEAD for staged parts, the index for unstaged ones).
    forward: Vec<u8>,
    /// Takes the selection out of the new side with `git apply -R`.
    reverse: Vec<u8>,
}

/// Stashes the selection and takes exactly it out of index and working directory. Call within the
/// write lock. Returns the SHA of the new stash.
pub(crate) async fn stash_selection(core: &Core, repo_id: &str, message: Option<&str>, selection: &StashSelection, undoable: bool) -> CoreResult<String> {
    let head = refs::read_head(core, repo_id).await?;
    let (head_sha, on) = match &head {
        Head::Branch { branch, sha } => (sha.clone(), branch.clone()),
        Head::Detached { sha } => (sha.clone(), "(no branch)".to_string()),
        Head::Unborn { .. } => return Err(CoreError::not_allowed("A stash needs at least one commit. Commit first.")),
    };
    if !head_sha.eq_ignore_ascii_case(selection.expect_head.trim()) {
        return Err(CoreError::stale_state());
    }
    if !unmerged_paths(core, repo_id).await?.is_empty() {
        return Err(CoreError::new(
            ErrorCode::Conflict,
            "Nothing can be stashed while there are unresolved conflicts. Resolve the conflicts or abort the operation first.",
        ));
    }
    let staged = parts(core, repo_id, &selection.staged, true).await?;
    let unstaged = parts(core, repo_id, &selection.unstaged, false).await?;
    if staged.is_empty() && unstaged.is_empty() {
        return Err(CoreError::new(ErrorCode::NothingToCommit, "No lines are selected for stashing."));
    }
    let mut paths: Vec<String> = Vec::new();
    for part in staged.iter().chain(unstaged.iter()) {
        let path = util::decode_lossy(&part.path);
        if !paths.contains(&path) {
            paths.push(path);
        }
    }

    // The stash commits – the real index stays untouched.
    let (index_tree, worktree_tree) = build_trees(core, repo_id, &head_sha, &staged, &unstaged).await?;
    let head_subject = core.git_for(repo_id)?.args(["log", "-1", "--format=%s", &head_sha]).read_only().no_log().run_text().await?;
    let short = &head_sha[..head_sha.len().min(7)];
    let subject = match message {
        Some(text) => format!("On {on}: {text}"),
        None => format!("WIP on {on}: {short} {head_subject}"),
    };
    let index_commit = commit_tree(core, repo_id, &index_tree, &[&head_sha], &format!("index on {on}: {short} {head_subject}"), false).await?;
    let stash_commit = commit_tree(core, repo_id, &worktree_tree, &[&head_sha, &index_commit], &subject, false).await?;

    // Backup of the selected files and the whole index before anything is taken out.
    let entry_id = undo::new_id();
    let snapshot = undo::snapshot(core, repo_id, Some(paths.as_slice())).await?;
    let Some(index_before) = snapshot.index_tree.clone() else {
        return Err(CoreError::new(ErrorCode::Conflict, "The index has unresolved conflicts."));
    };
    let index_keep = commit_tree(core, repo_id, &index_before, &[&head_sha], "forkyard: backup (index)", true).await?;
    for (name, sha) in [("worktree", snapshot.commit.as_str()), ("index", index_keep.as_str()), ("stash", stash_commit.as_str())] {
        if let Err(e) = undo::create_backup_ref(core, repo_id, &entry_id, name, sha).await {
            forget(core, repo_id, &entry_id).await;
            return Err(e);
        }
    }

    if let Err(e) = store_stash(core, repo_id, &stash_commit, &subject).await {
        forget(core, repo_id, &entry_id).await;
        return Err(e);
    }
    if let Err(e) = remove_selection(core, repo_id, &staged, &unstaged).await {
        roll_back(core, repo_id, &entry_id, &snapshot.commit, &index_before, &paths, &stash_commit).await;
        return Err(removal_error(e));
    }

    if !undoable {
        forget(core, repo_id, &entry_id).await;
        return Ok(stash_commit);
    }
    let token = undo::head_token(&head);
    let label = match message {
        Some(text) => format!("Undo stash “{}”", undo::shorten(text, 60)),
        None => "Undo stash of the selected lines".to_string(),
    };
    undo::record(
        core,
        UndoRecord {
            id: entry_id.clone(),
            repo_id: repo_id.to_string(),
            worktree_path: String::new(),
            action: UndoAction::Stash,
            label,
            ref_name: None,
            ref_before: None,
            ref_after: None,
            head_before: token.clone(),
            head_after: Some(token),
            payload: json!({
                "partial": true,
                "stashSha": stash_commit,
                "stashSubject": subject,
                "headSha": head_sha,
                "worktreeSnapshot": snapshot.commit,
                "indexTree": index_before,
                "paths": paths,
            }),
        },
    )
    .await?;
    // The state right after: against it, undo detects what the user changed since.
    undo::record_result(core, repo_id, &entry_id, Some(paths.as_slice())).await;
    Ok(stash_commit)
}

/// Reads the diffs again, checks the tokens and builds the patches of the selection.
async fn parts(core: &Core, repo_id: &str, list: &[PatchSelection], staged: bool) -> CoreResult<Vec<Part>> {
    let mut out: Vec<Part> = Vec::new();
    for selection in list {
        let basis = patch_basis(core, repo_id, &selection.path, staged).await?;
        if basis.token != selection.expect {
            return Err(CoreError::stale_state());
        }
        if selection.hunks.is_empty() {
            continue;
        }
        let file = basis.file()?;
        let forward = patch::build_patch(file, &basis.path, &selection.hunks, Direction::Forward)?;
        let reverse = patch::build_patch(file, &basis.path, &selection.hunks, Direction::Reverse)?;
        if let (Some(forward), Some(reverse)) = (forward, reverse) {
            if out.iter().any(|part| part.path == basis.path) {
                return Err(CoreError::not_allowed(format!("“{}” is selected twice.", selection.path)));
            }
            out.push(Part { path: basis.path.clone(), forward, reverse });
        }
    }
    Ok(out)
}

/// Index tree (HEAD + selected staged parts) and worktree tree (+ selected unstaged parts),
/// built on a temporary index.
async fn build_trees(core: &Core, repo_id: &str, head: &str, staged: &[Part], unstaged: &[Part]) -> CoreResult<(String, String)> {
    let temp = TempIndex::create(core)?;
    let on_temp = || -> CoreResult<GitCmd> { Ok(core.git_for(repo_id)?.no_log().env("GIT_INDEX_FILE", temp.path())) };
    on_temp()?.args(["read-tree", head]).run().await?;
    for part in staged {
        apply(on_temp()?, &part.forward, true, false).await?;
    }
    let index_tree = on_temp()?.arg("write-tree").run_text().await?;
    for part in unstaged {
        if let Err(e) = apply(on_temp()?, &part.forward, true, false).await {
            let file = util::decode_lossy(&part.path);
            return Err(CoreError::not_allowed(format!(
                "The selected unstaged lines of “{file}” build on staged changes that aren't selected. Select those staged lines as well, or stash the whole file."
            ))
            .with_git_output(e.git_output.unwrap_or(e.message)));
        }
    }
    let worktree_tree = on_temp()?.arg("write-tree").run_text().await?;
    Ok((index_tree, worktree_tree))
}

/// `git apply` with the patch on stdin; never complains about or "fixes" whitespace.
async fn apply(cmd: GitCmd, patch: &[u8], cached: bool, reverse: bool) -> CoreResult<()> {
    let mut cmd = cmd.args(["-c", "apply.whitespace=nowarn", "-c", "apply.ignoreWhitespace=no", "apply", "--whitespace=nowarn"]);
    if cached {
        cmd = cmd.arg("--cached");
    }
    if reverse {
        cmd = cmd.arg("-R");
    }
    cmd.stdin(patch.to_vec()).run().await?;
    Ok(())
}

async fn commit_tree(core: &Core, repo_id: &str, tree: &str, parents: &[&str], message: &str, fixed_identity: bool) -> CoreResult<String> {
    let mut cmd = core.git_for(repo_id)?.no_log().args(["commit-tree", "--no-gpg-sign", tree]);
    for parent in parents {
        cmd = cmd.args(["-p", parent]);
    }
    if fixed_identity {
        for (key, value) in BACKUP_IDENTITY {
            cmd = cmd.env(key, value);
        }
    }
    Ok(cmd.args(["-m", message]).run().await?.stdout_text())
}

/// Takes the selection out: unstaged parts from the working directory, staged parts from the
/// working directory and the index.
async fn remove_selection(core: &Core, repo_id: &str, staged: &[Part], unstaged: &[Part]) -> CoreResult<()> {
    for part in unstaged {
        reverse_in_worktree(core, repo_id, part).await?;
    }
    #[cfg(test)]
    {
        if core.state::<FailRemoval>().0.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(CoreError::io("Injected failure while taking the selection out."));
        }
    }
    for part in staged {
        reverse_in_worktree(core, repo_id, part).await?;
    }
    for part in staged {
        apply(core.git_for(repo_id)?, &part.reverse, true, true).await?;
    }
    Ok(())
}

/// Reverse patch in the working directory; with `core.autocrlf` the untouched lines keep their
/// line endings (as when discarding lines).
async fn reverse_in_worktree(core: &Core, repo_id: &str, part: &Part) -> CoreResult<()> {
    let file = util::join_from_git(&core.repo_path(repo_id)?, &part.path);
    let before = std::fs::metadata(&file).ok().filter(|meta| meta.is_file() && meta.len() <= KEEP_EOL_MAX_BYTES).and_then(|_| std::fs::read(&file).ok());
    let hunks = patch::parse_diff(&part.reverse).into_iter().next().map(|parsed| parsed.hunks).unwrap_or_default();
    apply(core.git_for(repo_id)?, &part.reverse, false, true).await?;
    if let (Some(before), Ok(after)) = (before, std::fs::read(&file)) {
        if let Some(exact) = keep_line_endings(&before, &after, &hunks) {
            std::fs::write(&file, exact)?;
        }
    }
    Ok(())
}

fn removal_error(cause: CoreError) -> CoreError {
    let mut error = CoreError::new(
        cause.code,
        "The selection couldn't be taken out of the working directory – later changes probably overlap it. Nothing was stashed; files and index are as before.",
    );
    error.git_output = cause.git_output.or(Some(cause.message));
    error
}

async fn forget(core: &Core, repo_id: &str, entry_id: &str) {
    if let Err(e) = undo::delete_backup_refs(core, repo_id, entry_id).await {
        log::warn!("Backup refs of the partial stash {entry_id} not removed: {}", e.message);
    }
}

/// After a failure: files and index back from the backup, the stash off the list. The backup refs
/// stay if restoring failed, so nothing is lost.
async fn roll_back(core: &Core, repo_id: &str, entry_id: &str, snapshot: &str, index_tree: &str, paths: &[String], stash_commit: &str) {
    let restored: CoreResult<()> = async {
        undo::restore_worktree(core, repo_id, snapshot, Some(paths)).await?;
        undo::restore_index(core, repo_id, index_tree).await
    }
    .await;
    match read_rows(core, repo_id).await {
        Ok(rows) => {
            if let Some(index) = rows.iter().position(|row| row.sha == stash_commit) {
                if let Err(e) = drop_stash(core, repo_id, index).await {
                    log::error!("Partial stash {stash_commit} not dropped after the failure: {}", e.message);
                }
            }
        }
        Err(e) => log::error!("Stash list not read after the failure: {}", e.message),
    }
    match restored {
        Ok(()) => forget(core, repo_id, entry_id).await,
        Err(e) => log::error!("Selection not restored after the failure (backup {snapshot}, index {index_tree}): {}", e.message),
    }
}
