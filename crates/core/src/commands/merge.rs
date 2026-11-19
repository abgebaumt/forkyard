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
// conflict_get
// ---------------------------------------------------------------------------

/// The three versions of a conflicted file from index stages 1 (base), 2 (ours) and
/// 3 (theirs), plus the content in the working directory with markers. Read-only command.
pub async fn conflict_get(core: &Core, repo_id: String, path: String) -> CoreResult<ConflictFile> {
    let repo_id = repo_id.as_str();
    let entry = unmerged_entry(core, repo_id, &path).await?;
    let root = core.repo_path(repo_id)?;
    let versions = Versions::read(core, repo_id, &root, &entry).await?;
    let head = read_head(core, repo_id).await?;
    let operation = read_operation(core, repo_id).await?;
    let (ours_label, theirs_label) = side_labels(operation.as_ref(), &head);

    let is_binary = versions.is_binary(&entry);
    let text = |bytes: &Option<Vec<u8>>| bytes.as_deref().filter(|_| !is_binary).map(|b| util::decode_text(b).0);
    Ok(ConflictFile {
        path,
        kind: kind_of(&entry),
        base: text(&versions.base),
        ours: text(&versions.ours),
        theirs: text(&versions.theirs),
        merged: text(&versions.worktree),
        is_binary,
        ours_label,
        theirs_label,
        // A binary file has no encoding.
        encoding: (!is_binary).then(|| versions.format().encoding.to_string()),
    })
}

/// Names of the two sides, matching index stages 2 and 3 (see the top of the file).
fn side_labels(operation: Option<&Operation>, head: &Head) -> (String, String) {
    let current = head.label();
    let Some(op) = operation else {
        // Conflict without a running operation: squash merge or applied stash.
        return (current, "Incoming change".to_string());
    };
    let ours = op.target.clone().unwrap_or(current);
    let source = op.source.clone();
    let theirs = match op.kind {
        OperationKind::Merge | OperationKind::Rebase => source.unwrap_or_else(|| "Incoming change".to_string()),
        OperationKind::CherryPick => source.map_or_else(|| "Cherry-pick".to_string(), |s| format!("Cherry-pick {s}")),
        // In a revert, stage 3 is the state before the reverted commit.
        OperationKind::Revert => source.map_or_else(|| "Revert".to_string(), |s| format!("State before {s}")),
    };
    (ours, theirs)
}

// ---------------------------------------------------------------------------
// conflict_resolve
// ---------------------------------------------------------------------------

/// Resolves the conflict of one file: either with `content` (written in the file's encoding
/// and line endings, then staged) or with a whole side. If the chosen side does not exist
/// (e.g. `ours` for "deleted by us"), that means: delete the file.
pub async fn conflict_resolve(
    core: &Core,
    repo_id: String,
    path: String,
    content: Option<String>,
    side: Option<ConflictSide>,
) -> CoreResult<Status> {
    if content.is_some() == side.is_some() {
        return Err(CoreError::not_allowed(
            "To resolve a conflict, provide either content or a side (ours/theirs) – exactly one of the two.",
        ));
    }
    let repo_id = repo_id.as_str();
    core.with_write_lock(repo_id, &[RepoChange::Worktree, RepoChange::Index], async {
        let entry = unmerged_entry(core, repo_id, &path).await?;
        let root = core.repo_path(repo_id)?;
        // Check first, then write: with a foreign lock file, a modified but unstaged file would otherwise be left behind.
        ensure_index_unlocked(core, repo_id).await?;
        match (&content, side) {
            (Some(content), _) => resolve_with_content(core, repo_id, &root, &path, &entry, content).await?,
            (None, Some(side)) => resolve_with_side(core, repo_id, &entry, side).await?,
            (None, None) => {}
        }
        // Only the backup of a merge tool the app started for this file: an `.orig` file the
        // user placed next to it themselves stays.
        let rel = crate::util::normalize_rel_path(&path).unwrap_or_else(|_| path.clone());
        let tool_ran = core.state::<crate::commands::external::MergeToolRuns>().take(repo_id, &rel);
        if tool_ran && core.settings()?.delete_orig_files {
            remove_orig_file(core, repo_id, &root, &entry.path).await;
        }
        read_status(core, repo_id).await
    })
    .await
}

async fn resolve_with_content(core: &Core, repo_id: &str, root: &Path, path: &str, entry: &Unmerged, content: &str) -> CoreResult<()> {
    if entry.stages.iter().flatten().any(|s| special_mode(&s.mode)) {
        return Err(CoreError::not_allowed(format!(
            "“{path}” is a symlink or submodule and can’t be resolved as text. Take one of the two sides instead."
        )));
    }
    let versions = Versions::read(core, repo_id, root, entry).await?;
    if versions.is_binary(entry) {
        return Err(CoreError::not_allowed(format!(
            "“{path}” is a binary file and can’t be resolved as text. Take one of the two sides instead."
        )));
    }
    // Lines that already look like a marker in one of the versions (e.g. a heading with
    // "=======") belong to the content and do not count.
    let mut known = HashSet::new();
    for bytes in [&versions.ours, &versions.theirs].into_iter().flatten() {
        let (text, _) = util::decode_text(bytes);
        known.extend(text.lines().filter(|l| is_marker_line(l)).map(|l| l.trim_end_matches('\r').to_string()));
    }
    if let Some(line) = leftover_marker(content, &known) {
        return Err(CoreError::not_allowed(format!(
            "The content still contains conflict markers (line {line}). Resolve all conflicts in the file first."
        )));
    }
    let bytes = encode_content(content, &versions.format())?;
    let full = util::join_from_git(root, &entry.path);
    // Via a temp file and with patience: a Git reading at the same time (status refresh)
    // briefly holds the file on Windows (os error 1224, 32, 5).
    tokio::task::spawn_blocking(move || util::write_file_atomic(&full, &bytes))
        .await
        .map_err(|e| CoreError::io(format!("Saving was aborted: {e}")))?
        .map_err(|e| {
            let e = CoreError::from(e);
            CoreError::new(e.code, format!("Couldn’t write “{path}”. {}", e.message))
        })?;
    path_cmd(core, repo_id)?.args(["add", "--"]).arg_bytes(&entry.path).run().await?;
    Ok(())
}

async fn resolve_with_side(core: &Core, repo_id: &str, entry: &Unmerged, side: ConflictSide) -> CoreResult<()> {
    let (stage, flag) = match side {
        ConflictSide::Ours => (&entry.stages[1], "--ours"),
        ConflictSide::Theirs => (&entry.stages[2], "--theirs"),
    };
    if stage.is_some() {
        path_cmd(core, repo_id)?.args(["checkout", flag, "--"]).arg_bytes(&entry.path).run().await?;
        path_cmd(core, repo_id)?.args(["add", "--"]).arg_bytes(&entry.path).run().await?;
    } else {
        // The chosen side does not have the file: taking it means deleting.
        path_cmd(core, repo_id)?.args(["rm", "-f", "-q", "--"]).arg_bytes(&entry.path).run().await?;
    }
    Ok(())
}

/// Removes `<path>.orig` (created by `git mergetool`), as long as the file is not tracked.
/// Only call this if the app started the merge tool for this file.
async fn remove_orig_file(core: &Core, repo_id: &str, root: &Path, rel: &[u8]) {
    let mut orig = rel.to_vec();
    orig.extend_from_slice(b".orig");
    let full = util::join_from_git(root, &orig);
    if !std::fs::symlink_metadata(&full).is_ok_and(|m| m.is_file()) {
        return;
    }
    let listed = match core.git_for(repo_id).map(GitCmd::read) {
        Ok(cmd) => cmd.literal_paths().args(["ls-files", "-z", "--"]).arg_bytes(&orig).run_raw().await,
        Err(e) => Err(e),
    };
    if matches!(&listed, Ok(out) if out.success() && out.stdout.is_empty()) {
        if let Err(e) = std::fs::remove_file(&full) {
            log::warn!("{} not removed: {e}", util::display_path(&full));
        }
    }
}

// ---------------------------------------------------------------------------
// operation_continue / operation_abort
// ---------------------------------------------------------------------------

/// Continues the running operation: merge → commit (with `message`, otherwise MERGE_MSG),
/// rebase, cherry-pick and revert → `--continue`. If conflicts are still open, `conflict`
/// comes back with the file list without calling Git; a rebase may stop on a conflict
/// again at the next commit.
///
/// `skip_hooks`: the merge commit is created with `--no-verify` (like "Skip Git hooks" for an
/// ordinary commit). Git has no such option for rebase, cherry-pick and revert; there it has no effect.
pub async fn operation_continue(core: &Core, repo_id: String, message: Option<String>, skip_hooks: Option<bool>) -> CoreResult<OpResult> {
    auto::follow_operation(
        core,
        &repo_id,
        core.with_write_lock(&repo_id, &ALL_CHANGES, continue_locked(core, &repo_id, message, skip_hooks.unwrap_or(false))),
    )
    .await
}

async fn continue_locked(core: &Core, repo_id: &str, message: Option<String>, skip_hooks: bool) -> CoreResult<OpResult> {
    let Some(op) = read_operation(core, repo_id).await? else { return Err(no_operation(core, repo_id).await) };
    let unmerged = ls_unmerged(core, repo_id).await?;
    if !unmerged.is_empty() {
        return Ok(OpResult::Conflict { files: display_paths(&unmerged), operation: Some(op), note: None });
    }
    let dir = crate::git::repo::git_dir(core, repo_id).await?;
    let head = read_head(core, repo_id).await?;
    let start = OperationStart::read(core, repo_id, &dir, &op, &head).await;
    // Rebase and cherry-pick started from the app left an open undo entry on the conflict.
    // If it belongs to this operation, it is completed at the end; if it is orphaned
    // (finished or aborted in the terminal), it is closed now.
    let pending = rebase::pending_undo(core, repo_id)?;
    let adopted =
        pending.as_ref().is_some_and(|entry| rebase::pending_belongs_to(entry, op.kind, start.ref_name.as_deref(), &start.before));
    if let Some(orphan) = pending.as_ref().filter(|_| !adopted) {
        if let Err(e) = rebase::settle_entry(core, repo_id, orphan).await {
            log::warn!("Orphaned undo entry not closed: {}", e.message);
        }
    }

    let hooks = Hooks::start(core, repo_id).await;
    let git = hooks.wrap(core.git_for(repo_id)?);
    let result: CoreResult<(&str, GitOutput)> = async {
        Ok(match op.kind {
            OperationKind::Merge => {
                let git = if skip_hooks { git.arg("commit").arg("--no-verify") } else { git.arg("commit") };
                let out = match util::non_empty(message) {
                    Some(text) => git.args(["--cleanup=whitespace", "-F", "-"]).stdin(text).run_raw().await?,
                    // MERGE_MSG contains the conflict list as a comment; without an editor it would otherwise stay.
                    None => git.args(["--no-edit", "--cleanup=strip"]).run_raw().await?,
                };
                ("commit", out)
            }
            OperationKind::Rebase => ("rebase", git.args(["rebase", "--continue"]).run_raw().await?),
            OperationKind::CherryPick | OperationKind::Revert => {
                let (subcommand, marker) =
                    if op.kind == OperationKind::CherryPick { ("cherry-pick", "CHERRY_PICK_HEAD") } else { ("revert", "REVERT_HEAD") };
                // If the resolution left nothing over, `--continue` would fail with "now empty":
                // the step is skipped then.
                let empty = dir.join(marker).exists() && index_matches_head(core, repo_id).await?;
                let flag = if empty { "--skip" } else { "--continue" };
                (subcommand, git.args([subcommand, flag]).run_raw().await?)
            }
        })
    }
    .await;
    let ran = hooks.finish(core, repo_id);
    let (subcommand, out) = result?;
    if !out.success() {
        if ls_unmerged(core, repo_id).await?.is_empty() {
            if let Some(error) = hook_failure(&ran, &ABORTING_HOOKS, &out, "the commit") {
                return Err(error);
            }
        }
        return stopped_or_failed(core, repo_id, subcommand, &out).await;
    }
    if let Some(still) = read_operation(core, repo_id).await? {
        // Exit 0 but not done: a rebase stopped at an "edit" or "break".
        return Ok(OpResult::Conflict { files: Vec::new(), operation: Some(still), note: None });
    }

    let new_head = read_head(core, repo_id).await?;
    let new = new_head.sha().map(str::to_string);
    let source = op.source.clone().unwrap_or_else(|| "?".to_string());
    let target = op.target.clone().unwrap_or_else(|| new_head.label());
    let (action, undo_label, summary) = match op.kind {
        OperationKind::Merge => {
            (UndoAction::Merge, format!("Undo merge of {source} into {target}"), format!("Merged {source} into {target}"))
        }
        OperationKind::Rebase => (
            UndoAction::Rebase,
            format!("Undo rebase of {source} onto {target}"),
            format!("Moved {source} onto {target} (rebase complete)"),
        ),
        OperationKind::CherryPick => (UndoAction::CherryPick, "Undo cherry-pick".to_string(), "Cherry-pick complete".to_string()),
        OperationKind::Revert => (UndoAction::Revert, "Undo revert".to_string(), "Revert complete".to_string()),
    };
    if let Some(entry) = pending.as_ref().filter(|_| adopted) {
        // The entry from the start of the operation gets its final state (or disappears if
        // nothing changed).
        if let Err(e) = rebase::settle_entry(core, repo_id, entry).await {
            log::warn!("Undo entry not completed: {}", e.message);
        }
    } else if let Some(new) = new.as_ref().filter(|new| **new != start.before) {
        let pending = Pending::new(repo_id);
        if op.kind == OperationKind::Rebase {
            // The branch's old commits are afterwards only reachable through this backup.
            keep_ref(core, repo_id, pending.id(), "before", &start.before).await;
        }
        let head_after = start.ref_name.clone().unwrap_or_else(|| new.clone());
        let subject = commit_meta(core, repo_id, new).await.map(|m| m.subject).unwrap_or_default();
        let id = pending.id().to_string();
        pending
            .record(
                core,
                UndoRecord {
                    id,
                    repo_id: repo_id.to_string(),
                    worktree_path: String::new(),
                    action,
                    label: undo_label,
                    ref_name: start.ref_name.clone(),
                    ref_before: Some(start.before.clone()),
                    ref_after: Some(new.clone()),
                    head_before: start.ref_name.clone().unwrap_or_else(|| start.before.clone()),
                    head_after: Some(head_after),
                    payload: json!({
                        "branch": start.ref_name.as_deref().map(short_ref_name),
                        "source": op.source,
                        "summary": subject,
                    }),
                },
            )
            .await;
    }
    Ok(OpResult::Done { sha: new, fast_forward: false, summary })
}

/// Where the branch stood before the operation – read before `--continue` removes the state files.
struct OperationStart {
    /// Moved branch as full ref name; `None` for detached HEAD.
    ref_name: Option<String>,
    before: String,
}

impl OperationStart {
    async fn read(core: &Core, repo_id: &str, dir: &Path, op: &Operation, head: &Head) -> OperationStart {
        let current = head.sha().unwrap_or_default().to_string();
        let first_line = |path: PathBuf| {
            std::fs::read_to_string(path).ok().and_then(|t| t.lines().next().map(|l| l.trim().to_string())).filter(|l| !l.is_empty())
        };
        match op.kind {
            OperationKind::Rebase => {
                // During the rebase HEAD is detached; branch and old tip are in the state folder.
                let state = if dir.join("rebase-merge").is_dir() { dir.join("rebase-merge") } else { dir.join("rebase-apply") };
                OperationStart {
                    ref_name: first_line(state.join("head-name")).filter(|n| n.starts_with("refs/")),
                    before: first_line(state.join("orig-head")).unwrap_or(current),
                }
            }
            OperationKind::Merge => OperationStart { ref_name: branch_ref(head), before: current },
            OperationKind::CherryPick | OperationKind::Revert => {
                // For a sequence the state before the first step, otherwise the current one.
                let before = match first_line(dir.join("sequencer").join("head")) {
                    Some(start) => rev::rev_parse(core, repo_id, &format!("{}^{{commit}}", start)).await.ok().flatten().unwrap_or(current),
                    None => current,
                };
                OperationStart { ref_name: branch_ref(head), before }
            }
        }
    }
}

/// Aborts the running operation and restores the state before it. The state comes from
/// the Git directory – it does not matter whether the operation was started here, before a
/// restart or in the terminal.
pub async fn operation_abort(core: &Core, repo_id: String) -> CoreResult<Status> {
    let repo_id = repo_id.as_str();
    core.with_write_lock(repo_id, &ALL_CHANGES, async {
        let Some(op) = read_operation(core, repo_id).await? else { return Err(no_operation(core, repo_id).await) };
        let subcommand = match op.kind {
            OperationKind::Merge => "merge",
            OperationKind::Rebase => "rebase",
            OperationKind::CherryPick => "cherry-pick",
            OperationKind::Revert => "revert",
        };
        // `--abort` of merge and cherry-pick runs as `reset --merge`, and that refuses files whose
        // timestamps in the index are stale ("not uptodate. Cannot merge") – even if their content
        // has not changed (copied repository, tools that merely touch files). The read commands
        // never refresh the index; hence here.
        core.git_for(repo_id)?.args(["update-index", "-q", "--refresh"]).no_log().run_raw().await?;
        // What the user did to UNRELATED files during the operation does not belong to the
        // operation: `rebase --abort` resets hard, `merge --abort` discards staged changes.
        // Without its backup (kept under a backup ref until it is written back) there is no abort.
        let extra = ExtraWork::find(core, repo_id, &op).await?;
        let backup = match &extra {
            Some(extra) => Pending::new(repo_id).keep(core, "worktree", &extra.snapshot.commit).await?,
            None => Pending::new(repo_id),
        };
        let aborted = async {
            let out = core.git_for(repo_id)?.args([subcommand, "--abort"]).run_raw().await?;
            if !out.success() {
                abort_past_leftovers(core, repo_id, subcommand, &out).await?;
            }
            Ok::<_, CoreError>(())
        }
        .await;
        let restored = match (&aborted, extra) {
            (Ok(()), Some(extra)) => extra.restore(core, repo_id).await,
            _ => Ok(()),
        };
        match restored {
            Ok(()) => backup.forget(core).await,
            Err(e) => log::warn!(
                "Extra work not restored after the abort; it stays in {}: {}",
                undo::backup_ref_name(backup.id(), "worktree"),
                e.message
            ),
        }
        aborted?;
        // An open undo entry of the aborted operation disappears (the branch is back at the
        // start); an orphaned one is closed.
        if let Err(e) = rebase::settle_pending_undo(core, repo_id).await {
            log::warn!("Open undo entry not cleaned up after the abort: {}", e.message);
        }
        read_status(core, repo_id).await
    })
    .await
}

/// `rebase --abort` refuses to overwrite untracked files that the pre-rebase state contains
/// as tracked files. Such files are left behind when Git was terminated in the middle of a
/// checkout (crash, power failure): the rebase could then never be aborted again. If their
/// content matches byte for byte what the abort writes anyway, they are leftovers – they
/// go, and the abort runs once more. If even one differs, nothing is touched and the
/// message names the files.
async fn abort_past_leftovers(core: &Core, repo_id: &str, subcommand: &str, failed: &GitOutput) -> CoreResult<()> {
    let text = failed.stderr_text();
    let plain = || crate::git::errors::classify(subcommand, failed.code, &failed.stdout, &failed.stderr);
    if !text.contains("untracked working tree files would be overwritten") {
        return Err(plain());
    }
    let files: Vec<String> = text
        .lines()
        .filter_map(|line| line.strip_prefix('\t'))
        .map(|file| file.trim().to_string())
        .filter(|file| !file.is_empty())
        .collect();
    let dir = crate::git::repo::git_dir(core, repo_id).await?;
    let target = ["rebase-merge/orig-head", "rebase-apply/orig-head"]
        .iter()
        .find_map(|name| std::fs::read_to_string(dir.join(name)).ok())
        .map(|sha| sha.trim().to_string())
        .filter(|sha| !sha.is_empty());
    let root = core.repo_path(repo_id)?;
    let mut differing: Vec<String> = Vec::new();
    if let Some(target) = &target {
        for file in &files {
            let wanted =
                core.git_for(repo_id)?.read().args(["rev-parse", "-q", "--verify"]).arg(format!("{target}:{file}")).run_raw().await?;
            let found = core.git_for(repo_id)?.read().args(["hash-object", "--"]).arg(file).run_raw().await?;
            let same =
                wanted.success() && found.success() && !wanted.stdout_text().is_empty() && wanted.stdout_text() == found.stdout_text();
            if !same {
                differing.push(file.clone());
            }
        }
    }
    if files.is_empty() || target.is_none() || !differing.is_empty() {
        let named = if differing.is_empty() { &files } else { &differing };
        let list = named.iter().take(5).map(|file| format!("“{file}”")).collect::<Vec<_>>().join(", ");
        let more = if named.len() > 5 { format!(" and {} more", named.len() - 5) } else { String::new() };
        let mut error = CoreError::new(
            ErrorCode::DirtyWorktree,
            format!(
                "Aborting would overwrite untracked files that exist as tracked files in the previous state: {list}{more}. Git won’t touch them. Move or delete them, then you can abort the operation."
            ),
        );
        error.git_output = Some(text);
        return Err(error);
    }
    for file in &files {
        let path = util::join_from_git(&root, file.as_bytes());
        if let Err(e) = std::fs::remove_file(&path) {
            log::warn!("Leftover of an interrupted checkout not removed ({file}): {e}");
        }
    }
    log::info!("{} leftovers of an interrupted checkout removed (identical to the pre-rebase state)", files.len());
    core.git_for(repo_id)?.args([subcommand, "--abort"]).run().await?;
    Ok(())
}

/// Work on files the running operation has nothing to do with: backed up before the abort,
/// written back afterwards where the abort reset them.
struct ExtraWork {
    /// The working directory before the abort.
    snapshot: undo::Snapshot,
    /// HEAD before the abort.
    head: String,
    /// Files changed relative to HEAD that are neither conflicted nor touched by the commit
    /// being applied or by the incoming side.
    paths: Vec<Vec<u8>>,
}

impl ExtraWork {
    async fn find(core: &Core, repo_id: &str, op: &Operation) -> CoreResult<Option<ExtraWork>> {
        let Some(head) = rev::rev_parse(core, repo_id, "HEAD^{commit}").await? else { return Ok(None) };
        let snapshot = undo::snapshot(core, repo_id, None).await?;
        let changed =
            changed_names(core, repo_id, &["diff-tree", "-r", "-z", "--name-only", "--no-renames", &head, &snapshot.tree]).await?;
        if changed.is_empty() {
            return Ok(None);
        }
        let mut touched: HashSet<Vec<u8>> = ls_unmerged(core, repo_id).await?.into_iter().map(|entry| entry.path).collect();
        let dir = crate::git::repo::git_dir(core, repo_id).await?;
        let lines = |name: &str| -> Vec<String> {
            std::fs::read_to_string(dir.join(name))
                .map(|text| text.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
                .unwrap_or_default()
        };
        match op.kind {
            OperationKind::Merge => {
                // What the incoming side changed since the merge base.
                for other in lines("MERGE_HEAD") {
                    let range = format!("{head}...{other}");
                    touched.extend(
                        changed_names(core, repo_id, &["diff", "--no-ext-diff", "-z", "--name-only", "--no-renames", &range])
                            .await
                            .unwrap_or_default(),
                    );
                }
            }
            OperationKind::Rebase | OperationKind::CherryPick | OperationKind::Revert => {
                // The commit the operation is currently at.
                let stopped = match op.kind {
                    OperationKind::Rebase => lines("rebase-merge/stopped-sha").into_iter().chain(lines("REBASE_HEAD")).next(),
                    OperationKind::CherryPick => lines("CHERRY_PICK_HEAD").into_iter().next(),
                    _ => lines("REVERT_HEAD").into_iter().next(),
                };
                match stopped {
                    Some(sha) => touched.extend(
                        changed_names(
                            core,
                            repo_id,
                            &["diff-tree", "-r", "-z", "--name-only", "--no-renames", "--no-commit-id", "--root", "-m", &sha],
                        )
                        .await
                        .unwrap_or_default(),
                    ),
                    // Without the commit, "unrelated" cannot be determined: then touch nothing.
                    None => return Ok(None),
                }
            }
        }
        let paths: Vec<Vec<u8>> = changed.into_iter().filter(|path| !touched.contains(path)).collect();
        Ok(if paths.is_empty() { None } else { Some(ExtraWork { snapshot, head, paths }) })
    }

    async fn restore(self, core: &Core, repo_id: &str) -> CoreResult<()> {
        let Some(now) = rev::rev_parse(core, repo_id, "HEAD^{commit}").await? else { return Ok(()) };
        // Files that differ between the state in the middle of the operation and the state after the
        // abort were already changed by the operation itself: they stay as the abort leaves them.
        let moved: HashSet<Vec<u8>> = if now == self.head {
            HashSet::new()
        } else {
            changed_names(core, repo_id, &["diff-tree", "-r", "-z", "--name-only", "--no-renames", &self.head, &now])
                .await?
                .into_iter()
                .collect()
        };
        let keep: Vec<String> = self.paths.iter().filter(|path| !moved.contains(*path)).map(|path| util::decode_lossy(path)).collect();
        if keep.is_empty() {
            return Ok(());
        }
        let current = undo::worktree_tree(core, repo_id, Some(&keep)).await?;
        if let Ok(plan) = undo::plan_restore(core, repo_id, None, &current, &self.snapshot.commit, Some(&keep)).await? {
            undo::apply_restore(core, repo_id, &plan).await?;
        }
        Ok(())
    }
}

/// NUL-separated paths from the output of a Git command.
async fn changed_names(core: &Core, repo_id: &str, args: &[&str]) -> CoreResult<Vec<Vec<u8>>> {
    let out = core.git_for(repo_id)?.args(args).read().run().await?;
    Ok(out.stdout_z().into_iter().filter(|path| !path.is_empty()).map(<[u8]>::to_vec).collect())
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
// Index stages of a conflicted file
// ---------------------------------------------------------------------------

/// The conflict entry of exactly this path, or `not_found`.
async fn unmerged_entry(core: &Core, repo_id: &str, path: &str) -> CoreResult<Unmerged> {
    let missing = || CoreError::not_found(format!("“{path}” has no open conflict."));
    if path.is_empty() {
        return Err(missing());
    }
    if path.contains(char::REPLACEMENT_CHARACTER) {
        // Possibly a name that is not UTF-8: find its raw bytes among all conflicts.
        let all = ls_unmerged(core, repo_id).await?;
        let raw = util::raw_path(path, &all.iter().map(|u| &u.path[..]).collect::<Vec<_>>())?;
        return all.into_iter().find(|u| u.path == raw).ok_or_else(missing);
    }
    let out = core
        .git_for(repo_id)?
        .read()
        .literal_paths()
        .args(["ls-files", "--unmerged", "-z", "--"])
        .arg_bytes(path.as_bytes())
        .run_raw()
        .await?;
    if !out.success() {
        return Err(missing());
    }
    parse_unmerged(&out.stdout).into_iter().find(|u| u.path == path.as_bytes()).ok_or_else(missing)
}

fn display_paths(unmerged: &[Unmerged]) -> Vec<String> {
    unmerged.iter().map(|u| util::decode_lossy(&u.path)).collect()
}

/// Kind of conflict from the stages present (same mapping as in the status).
fn kind_of(entry: &Unmerged) -> ConflictKind {
    let has = |i: usize| entry.stages[i].is_some();
    let (x, y) = match (has(0), has(1), has(2)) {
        (true, false, false) => (b'D', b'D'),
        (false, true, false) => (b'A', b'U'),
        (true, true, false) => (b'U', b'D'),
        (false, false, true) => (b'U', b'A'),
        (true, false, true) => (b'D', b'U'),
        (false, true, true) => (b'A', b'A'),
        _ => (b'U', b'U'),
    };
    status::conflict_kind(x, y)
}

/// Symlink (120000) or submodule (160000): not text.
fn special_mode(mode: &str) -> bool {
    mode == "120000" || mode == "160000"
}

/// Contents of the three stages and of the file in the working directory, as raw bytes.
struct Versions {
    base: Option<Vec<u8>>,
    ours: Option<Vec<u8>>,
    theirs: Option<Vec<u8>>,
    worktree: Option<Vec<u8>>,
}

impl Versions {
    async fn read(core: &Core, repo_id: &str, root: &Path, entry: &Unmerged) -> CoreResult<Versions> {
        let (base, ours, theirs) = tokio::join!(
            stage_blob(core, repo_id, entry.stages[0].as_ref()),
            stage_blob(core, repo_id, entry.stages[1].as_ref()),
            stage_blob(core, repo_id, entry.stages[2].as_ref()),
        );
        let full = util::join_from_git(root, &entry.path);
        let worktree = match std::fs::symlink_metadata(&full) {
            Ok(meta) if meta.is_file() => std::fs::read(&full).ok(),
            _ => None,
        };
        Ok(Versions { base: base?, ours: ours?, theirs: theirs?, worktree })
    }

    fn all(&self) -> impl Iterator<Item = &[u8]> {
        [&self.base, &self.ours, &self.theirs, &self.worktree].into_iter().filter_map(|v| v.as_deref())
    }

    /// The file is binary if one version is. UTF-16 counts as binary, as in Git.
    fn is_binary(&self, entry: &Unmerged) -> bool {
        entry.stages.iter().flatten().any(|s| special_mode(&s.mode))
            || self.all().any(|b| util::looks_binary(b) || b.starts_with(b"\xFF\xFE") || b.starts_with(b"\xFE\xFF"))
    }

    /// Encoding and line endings in which the file is written.
    fn format(&self) -> TextFormat {
        let primary = self.ours.as_deref().or(self.theirs.as_deref());
        // The first version with non-ASCII characters decides; pure ASCII fits any encoding.
        let encoding = [&self.ours, &self.theirs, &self.base]
            .into_iter()
            .filter_map(|v| v.as_deref())
            .find(|b| !b.is_ascii())
            .map_or("utf-8", |b| util::decode_text(b).1);
        // If "ours" has CRLF, CRLF is written. With `core.autocrlf` the index has LF and only the
        // working directory has CRLF; then the file there decides.
        let crlf = primary.is_some_and(|b| {
            let (crlf, lf) = eol_counts(b);
            crlf > 0 && crlf >= lf
        }) || self.worktree.as_deref().is_some_and(|b| {
            let (crlf, lf) = eol_counts(b);
            crlf > 0 && lf == 0
        });
        TextFormat { encoding, bom: primary.is_some_and(|b| b.starts_with(UTF8_BOM)), crlf }
    }
}

async fn stage_blob(core: &Core, repo_id: &str, stage: Option<&StageEntry>) -> CoreResult<Option<Vec<u8>>> {
    let Some(stage) = stage.filter(|s| !special_mode(&s.mode)) else { return Ok(None) };
    let out = core.git_for(repo_id)?.read().args(["cat-file", "blob", &stage.sha]).run().await?;
    Ok(Some(out.stdout))
}

// ---------------------------------------------------------------------------
// Text: encoding, line endings, conflict markers
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TextFormat {
    /// "utf-8" or "windows-1252" (as in `util::decode_text`).
    encoding: &'static str,
    bom: bool,
    crlf: bool,
}

/// Number of line endings: (CRLF, lone LF).
fn eol_counts(bytes: &[u8]) -> (usize, usize) {
    let (mut crlf, mut lf, mut previous) = (0, 0, 0u8);
    for &b in bytes {
        if b == b'\n' {
            if previous == b'\r' {
                crlf += 1;
            } else {
                lf += 1;
            }
        }
        previous = b;
    }
    (crlf, lf)
}

/// Brings the UI's text into the file's form. A missing newline at the end stays
/// missing.
fn encode_content(content: &str, format: &TextFormat) -> CoreResult<Vec<u8>> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut text = content.replace("\r\n", "\n");
    if format.crlf {
        text = text.replace('\n', "\r\n");
    }
    let mut out = Vec::with_capacity(text.len() + 3);
    if format.bom {
        out.extend_from_slice(UTF8_BOM);
    }
    if format.encoding == "windows-1252" {
        let (bytes, _, unmappable) = encoding_rs::WINDOWS_1252.encode(&text);
        if unmappable {
            return Err(CoreError::not_allowed(
                "The content contains characters that can’t be saved in the file’s encoding (windows-1252).",
            ));
        }
        out.extend_from_slice(&bytes);
    } else {
        out.extend_from_slice(text.as_bytes());
    }
    Ok(out)
}

/// Line that looks like a conflict marker: seven identical characters from `<`, `=`, `>`,
/// `|` at the start of the line, followed by end of line or whitespace.
pub(crate) fn is_marker_line(line: &str) -> bool {
    let line = line.trim_end_matches('\r');
    let bytes = line.as_bytes();
    bytes.len() >= 7
        && matches!(bytes[0], b'<' | b'=' | b'>' | b'|')
        && bytes[..7].iter().all(|&b| b == bytes[0])
        && matches!(bytes.get(7), None | Some(b' ') | Some(b'\t'))
}

/// First line (counted from 1) with a leftover marker. Lines from `known` were already in
/// one of the versions and are content.
fn leftover_marker(content: &str, known: &HashSet<String>) -> Option<usize> {
    content.lines().position(|line| is_marker_line(line) && !known.contains(line.trim_end_matches('\r'))).map(|i| i + 1)
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
