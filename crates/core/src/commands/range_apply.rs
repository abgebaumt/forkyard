//! `range_apply`: takes selected hunks or lines of the diff between two commits (`from..to`) into
//! the working directory, the index or both – e.g. a coding agent's changes into the user's own
//! working directory.
//!
//! Under the write lock:
//! 1. resolve `from` and `to` to SHAs (refs allowed; `from` may be the empty tree),
//! 2. per selection: re-read that file's range diff, compare its token with `expect`, build the
//!    partial patch byte-exact (`diff::patch`) with the preimage blob (`index` line) for `--3way`,
//! 3. `git apply --check`; if the patch does not apply as is, `git apply --3way --check` – a
//!    conflict ends with `conflict` and the files, nothing is touched. For `worktree` the three-way
//!    merge runs on a copy of the index (the touched files staged as on disk), the real index stays,
//! 4. back up working directory and index, apply, record one undo entry `range_apply`.

use serde_json::{json, Map};

use crate::app::Core;
use crate::commands::diff::patch::{self, Direction};
use crate::commands::diff::{self, TempIndex};
use crate::commands::graph;
use crate::commands::history::normalize_rel_path;
use crate::commands::refs::read_head;
use crate::commands::status::{self, read_status};
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::{errors, GitCmd};
use crate::model::{PatchSelection, RangeApplyTarget, RepoChange, Status};
use crate::undo::{self, GroupRecord, UndoAction};
use crate::util;

#[cfg(test)]
mod tests;

/// How the patch applies.
enum Mode {
    Plain,
    /// Only with a three-way merge; for `worktree` on this copy of the index.
    ThreeWay(Option<TempIndex>),
}

/// Selected hunks or lines of the diff `from..to` into the working directory, the index or both.
/// `selections[].expect` is `TextDiff.range_token` of that file. Conflicts → `conflict` (nothing
/// changed); a range that changed for a selected file → `stale_state`.
pub async fn range_apply(core: &Core, repo_id: String, from: String, to: String, selections: Vec<PatchSelection>, target: RangeApplyTarget) -> CoreResult<Status> {
    core.with_write_lock(&repo_id, &[RepoChange::Worktree, RepoChange::Index], async {
        let from_sha = resolve_from(core, &repo_id, &from).await?;
        let to_sha = graph::resolve_commit(core, &repo_id, &to).await?;
        let (patch, paths) = build(core, &repo_id, &from_sha, &to_sha, &selections).await?;
        if patch.is_empty() {
            return read_status(core, &repo_id).await;
        }
        let mode = check(core, &repo_id, &patch, target, &paths).await?;
        let head = read_head(core, &repo_id).await?;
        let id = undo::new_id();
        let snapshot = undo::snapshot_for_group(core, &repo_id, &id).await?;
        if let Err(e) = apply(core, &repo_id, &patch, target, &mode).await {
            // `git apply` checks everything before it writes: nothing changed, the backup can go.
            if let Err(cleanup) = undo::delete_backup_refs(core, &repo_id, &id).await {
                log::warn!("Backup refs of {id} not removed: {}", cleanup.message);
            }
            return Err(e);
        }
        let head_token = undo::head_token(&head);
        let mut extra = Map::new();
        extra.insert("from".into(), json!(from_sha));
        extra.insert("to".into(), json!(to_sha));
        extra.insert("target".into(), json!(target));
        extra.insert("paths".into(), json!(paths));
        undo::record_group(
            core,
            GroupRecord {
                id,
                repo_id: repo_id.clone(),
                action: UndoAction::RangeApply,
                label: label(&from_sha, &to_sha, &paths),
                refs: Vec::new(),
                head_before: head_token.clone(),
                head_after: Some(head_token),
                snapshot: Some(snapshot),
                extra,
            },
        )
        .await?;
        read_status(core, &repo_id).await
    })
    .await
}

async fn resolve_from(core: &Core, repo_id: &str, from: &str) -> CoreResult<String> {
    if diff::is_empty_tree(from) {
        return Ok(from.trim().to_ascii_lowercase());
    }
    graph::resolve_commit(core, repo_id, from).await
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(7)]
}

fn label(from: &str, to: &str, paths: &[String]) -> String {
    let what = match paths {
        [one] => format!("‘{one}’"),
        many => format!("{} files", many.len()),
    };
    format!("Undo taking over {what} from {}..{}", short(from), short(to))
}

/// The partial patches of all selections, concatenated, and the touched paths.
async fn build(core: &Core, repo_id: &str, from: &str, to: &str, selections: &[PatchSelection]) -> CoreResult<(Vec<u8>, Vec<String>)> {
    let mut patch = Vec::new();
    let mut paths: Vec<String> = Vec::new();
    for selection in selections {
        let rel = normalize_rel_path(&selection.path)?;
        if paths.contains(&rel) {
            return Err(CoreError::not_allowed(format!("“{rel}” is selected twice.")));
        }
        let basis = diff::range_patch_basis(core, repo_id, &rel, from, to).await?;
        if basis.token != selection.expect {
            return Err(CoreError::stale_state());
        }
        let file = basis.file()?;
        let Some(bytes) = patch::build_patch(file, &basis.path, &selection.hunks, Direction::Forward)? else { continue };
        patch.extend_from_slice(&with_preimage(bytes, file.old_id.as_deref(), file.new_id.as_deref()));
        paths.push(rel);
    }
    Ok((patch, paths))
}

/// Adds `index <old>..<new>` in front of the `---` line: without the preimage blob `git apply --3way`
/// cannot merge. The new ID describes the whole change, not the selection – `git apply` computes the
/// result itself and does not compare it.
fn with_preimage(patch: Vec<u8>, old_id: Option<&str>, new_id: Option<&str>) -> Vec<u8> {
    let (Some(old), Some(new)) = (old_id, new_id) else { return patch };
    if old.bytes().all(|b| b == b'0') {
        return patch;
    }
    let Some(at) = patch.windows(5).position(|window| window == b"\n--- ") else { return patch };
    let mut out = Vec::with_capacity(patch.len() + old.len() + new.len() + 8);
    out.extend_from_slice(&patch[..=at]);
    out.extend_from_slice(format!("index {old}..{new}\n").as_bytes());
    out.extend_from_slice(&patch[at + 1..]);
    out
}

fn apply_cmd(core: &Core, repo_id: &str, target: RangeApplyTarget, three_way: bool, check: bool) -> CoreResult<GitCmd> {
    let mut cmd = core.git_for(repo_id)?.args(["-c", "apply.whitespace=nowarn", "-c", "apply.ignoreWhitespace=no", "apply", "--whitespace=nowarn"]);
    match (target, three_way) {
        (RangeApplyTarget::Index, _) => cmd = cmd.arg("--cached"),
        (RangeApplyTarget::Both, _) | (RangeApplyTarget::Worktree, true) => cmd = cmd.arg("--index"),
        (RangeApplyTarget::Worktree, false) => {}
    }
    if three_way {
        cmd = cmd.arg("--3way");
    }
    if check {
        cmd = cmd.arg("--check").no_log();
    }
    Ok(cmd)
}

/// For `worktree`: a copy of the index in which the touched files are staged as they are on disk –
/// `--3way` needs index and file to agree, and the real index must stay untouched.
async fn worktree_index(core: &Core, repo_id: &str, paths: &[String]) -> CoreResult<TempIndex> {
    let temp = TempIndex::create(core)?;
    let real = status::git_dir(core, repo_id).await?.join("index");
    if real.is_file() {
        util::copy_index_file(&real, temp.path())?;
    }
    let mut list = Vec::new();
    for path in paths {
        list.extend_from_slice(path.as_bytes());
        list.push(0);
    }
    // Paths that exist neither on disk nor in the index are no error here: the check reports them.
    core.git_for(repo_id)?
        .env("GIT_INDEX_FILE", temp.path())
        .env("GIT_LITERAL_PATHSPECS", "1")
        .args(["update-index", "--add", "--remove", "-z", "--stdin"])
        .stdin(list)
        .no_log()
        .run_raw()
        .await?;
    Ok(temp)
}

async fn check(core: &Core, repo_id: &str, patch: &[u8], target: RangeApplyTarget, paths: &[String]) -> CoreResult<Mode> {
    let plain = apply_cmd(core, repo_id, target, false, true)?.stdin(patch.to_vec()).run_raw().await?;
    if plain.success() {
        return Ok(Mode::Plain);
    }
    let index = if target == RangeApplyTarget::Worktree { Some(worktree_index(core, repo_id, paths).await?) } else { None };
    let mut merge = apply_cmd(core, repo_id, target, true, true)?;
    if let Some(index) = &index {
        merge = merge.env("GIT_INDEX_FILE", index.path());
    }
    let merged = merge.stdin(patch.to_vec()).run_raw().await?;
    // `--3way --check` exits with 0 even when it would leave conflicts: the message tells.
    let conflicts = conflicted_files(&merged.stderr_text());
    if merged.success() && conflicts.is_empty() {
        return Ok(Mode::ThreeWay(index));
    }
    let files = if conflicts.is_empty() { failed_files(&plain.stderr_text()) } else { conflicts };
    Err(conflict_error(&files, target).with_git_output(format!("{}\n{}", plain.stderr_text(), merged.stderr_text())))
}

async fn apply(core: &Core, repo_id: &str, patch: &[u8], target: RangeApplyTarget, mode: &Mode) -> CoreResult<()> {
    let mut cmd = apply_cmd(core, repo_id, target, matches!(mode, Mode::ThreeWay(_)), false)?;
    if let Mode::ThreeWay(Some(index)) = mode {
        cmd = cmd.env("GIT_INDEX_FILE", index.path());
    }
    let out = cmd.stdin(patch.to_vec()).run_raw().await?;
    if out.success() {
        return Ok(());
    }
    let conflicts = conflicted_files(&out.stderr_text());
    Err(if conflicts.is_empty() { errors::classify("apply", out.code, &out.stdout, &out.stderr) } else { conflict_error(&conflicts, target) })
}

fn push_unique(list: &mut Vec<String>, path: &str) {
    if !path.is_empty() && !list.iter().any(|known| known == path) {
        list.push(path.to_string());
    }
}

/// `Applied patch to '<path>' with conflicts.` (LC_ALL=C).
fn conflicted_files(stderr: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in stderr.lines() {
        if let Some(path) = line.strip_prefix("Applied patch to '").and_then(|rest| rest.strip_suffix("' with conflicts.")) {
            push_unique(&mut out, path);
        }
    }
    out
}

/// The files `git apply --check` names: `error: patch failed: <path>:<line>`, `error: <path>: …`.
fn failed_files(stderr: &str) -> Vec<String> {
    const ENDINGS: [&str; 5] = [": patch does not apply", ": does not match index", ": does not exist in index", ": No such file or directory", ": already exists in working directory"];
    let mut out = Vec::new();
    for line in stderr.lines() {
        let Some(rest) = line.strip_prefix("error: ") else { continue };
        if let Some(path) = rest.strip_prefix("patch failed: ") {
            push_unique(&mut out, path.rsplit_once(':').map_or(path, |(path, _)| path));
            continue;
        }
        for ending in ENDINGS {
            if let Some(path) = rest.strip_suffix(ending) {
                push_unique(&mut out, path);
            }
        }
    }
    out
}

fn conflict_error(files: &[String], target: RangeApplyTarget) -> CoreError {
    let place = match target {
        RangeApplyTarget::Worktree => "your working directory",
        RangeApplyTarget::Index => "the staging area",
        RangeApplyTarget::Both => "your working directory and the staging area",
    };
    let list = if files.is_empty() { "the selected files".to_string() } else { files.iter().map(|file| format!("“{file}”")).collect::<Vec<_>>().join(", ") };
    CoreError::new(ErrorCode::Conflict, format!("The selection conflicts with {place} in {list}. Nothing was changed."))
}
