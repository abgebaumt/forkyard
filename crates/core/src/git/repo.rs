//! Repository state read straight from Git and `.git`: HEAD, the Git directory and a running
//! merge, rebase, cherry-pick or revert. Pure reads (`GIT_OPTIONAL_LOCKS=0`, no log).

use std::path::{Path, PathBuf};

use crate::app::Core;
use crate::git::rev;
use crate::git::rev::short_ref_name;

use crate::error::{CoreError, CoreResult};
use crate::model::{Head, Operation, OperationKind};
use crate::util;

/// HEAD alone: branch, detached or without a commit.
pub async fn read_head(core: &Core, repo_id: &str) -> CoreResult<Head> {
    let path = core.repo_path(repo_id)?;
    head_at(core, &path, repo_id).await
}

pub(crate) async fn head_at(core: &Core, path: &Path, repo_id: &str) -> CoreResult<Head> {
    let (symref, commit) = tokio::join!(
        core.git.cmd(path).repo(repo_id).read().args(["symbolic-ref", "-q", "HEAD"]).run_raw(),
        core.git.cmd(path).repo(repo_id).read().args(["rev-parse", "-q", "--verify", "HEAD^{commit}"]).run_raw(),
    );
    let (symref, commit) = (symref?, commit?);
    let branch = if symref.success() {
        let full = symref.stdout_text();
        Some(full.strip_prefix("refs/heads/").unwrap_or(&full).to_string()).filter(|b| !b.is_empty())
    } else {
        None
    };
    let sha = if commit.success() { Some(commit.stdout_text()).filter(|s| !s.is_empty()) } else { None };
    match (branch, sha) {
        (Some(branch), Some(sha)) => Ok(Head::Branch { branch, sha }),
        (None, Some(sha)) => Ok(Head::Detached { sha }),
        (Some(branch), None) => Ok(Head::Unborn { branch }),
        (None, None) => {
            // Neither branch nor commit: not a repository, or HEAD is broken.
            let err = crate::git::errors::classify("rev-parse", commit.code, &symref.stderr, &commit.stderr);
            if err.is(crate::error::ErrorCode::Unknown) {
                Err(CoreError::unknown("Could not read the repository's HEAD.").with_git_output(commit.stderr_text()))
            } else {
                Err(err)
            }
        }
    }
}

/// The Git directory of the working directory. In a worktree `.git` is a
/// file pointing to `<main>/.git/worktrees/<name>`; MERGE_HEAD etc. live there.
pub async fn git_dir(core: &Core, repo_id: &str) -> CoreResult<PathBuf> {
    let path = core.repo_path(repo_id)?;
    git_dir_at(core, &path, repo_id).await
}

pub(crate) async fn git_dir_at(core: &Core, path: &Path, repo_id: &str) -> CoreResult<PathBuf> {
    let dot_git = path.join(".git");
    if dot_git.is_dir() {
        return Ok(dot_git);
    }
    if let Ok(content) = std::fs::read(&dot_git) {
        if let Some(target) = content.strip_prefix(b"gitdir:") {
            let target = util::bytes_to_path(trim_bytes(target));
            let resolved = if target.is_absolute() { target } else { path.join(target) };
            if resolved.is_dir() {
                return Ok(resolved);
            }
        }
    }
    let out = core.git.cmd(path).repo(repo_id).read().args(["rev-parse", "--absolute-git-dir"]).run().await?;
    Ok(util::native_path(&util::bytes_to_path(trim_bytes(&out.stdout))))
}

/// Whether a `git am` (applying patches) is in progress: `rebase-apply/applying` in the Git directory.
pub(crate) async fn am_in_progress(core: &Core, path: &Path, repo_id: &str) -> bool {
    match git_dir_at(core, path, repo_id).await {
        Ok(dir) => dir.join("rebase-apply").join("applying").exists(),
        Err(_) => false,
    }
}

/// Like [`am_in_progress`], for commands that only have the repo ID.
pub async fn foreign_am(core: &Core, repo_id: &str) -> bool {
    match core.repo_path(repo_id) {
        Ok(path) => am_in_progress(core, &path, repo_id).await,
        Err(_) => false,
    }
}

/// Running merge, rebase, cherry-pick or revert, read from the Git directory.
pub async fn read_operation(core: &Core, repo_id: &str) -> CoreResult<Option<Operation>> {
    let path = core.repo_path(repo_id)?;
    let head = read_head(core, repo_id).await?;
    operation_at(core, &path, repo_id, &head).await
}

pub(crate) async fn operation_at(core: &Core, path: &Path, repo_id: &str, head: &Head) -> CoreResult<Option<Operation>> {
    let dir = git_dir_at(core, path, repo_id).await?;
    let current_branch = head.branch().map(str::to_string);
    let merge_msg = || read_text(&dir.join("MERGE_MSG")).and_then(|m| clean_message(&m));

    // Rebase first: during a rebase conflict CHERRY_PICK_HEAD is there as well.
    let rebase_merge = dir.join("rebase-merge");
    let rebase_apply = dir.join("rebase-apply");
    let rebase = if rebase_merge.is_dir() {
        Some((rebase_merge.clone(), "msgnum", "end"))
    } else if rebase_apply.is_dir() && !rebase_apply.join("applying").exists() {
        // With "applying" it is `git am`, not a rebase.
        Some((rebase_apply, "next", "last"))
    } else {
        None
    };
    if let Some((state, step_file, total_file)) = rebase {
        let head_name = read_line(&state.join("head-name")).filter(|n| n.starts_with("refs/"));
        let source = match &head_name {
            Some(full) => Some(short_ref_name(full).to_string()),
            None => read_line(&state.join("orig-head")).map(|sha| rev::short(&sha).to_string()),
        };
        let target = match read_line(&state.join("onto")) {
            Some(onto) => Some(name_for_commit(core, path, repo_id, &onto, source.as_deref()).await),
            None => None,
        };
        let message = read_text(&state.join("message")).and_then(|m| clean_message(&m)).or_else(merge_msg);
        let (step, total_steps) = rebase_commit_steps(&state).unwrap_or_else(|| {
            (
                read_line(&state.join(step_file)).and_then(|n| n.parse().ok()),
                read_line(&state.join(total_file)).and_then(|n| n.parse().ok()),
            )
        });
        return Ok(Some(Operation { kind: OperationKind::Rebase, source, target, step, total_steps, message }));
    }

    if let Some(merge_head) = read_line(&dir.join("MERGE_HEAD")) {
        let source = name_for_commit(core, path, repo_id, &merge_head, current_branch.as_deref()).await;
        return Ok(Some(Operation {
            kind: OperationKind::Merge,
            source: Some(source),
            target: current_branch,
            step: None,
            total_steps: None,
            message: merge_msg(),
        }));
    }

    let cherry_pick = read_line(&dir.join("CHERRY_PICK_HEAD"));
    let revert = read_line(&dir.join("REVERT_HEAD"));
    let todo = read_text(&dir.join("sequencer").join("todo")).map(|t| todo_lines(&t)).unwrap_or_default();
    // Between two steps of a sequence there is no *_HEAD, only the list of open steps.
    let kind = if cherry_pick.is_some() {
        OperationKind::CherryPick
    } else if revert.is_some() {
        OperationKind::Revert
    } else {
        match todo.first().map(|(command, _)| command.as_str()) {
            Some("pick" | "p") => OperationKind::CherryPick,
            Some("revert") => OperationKind::Revert,
            _ => return Ok(None),
        }
    };
    let stopped_at = cherry_pick.or(revert);
    // The step at which Git stopped is still at the top of the list. If *_HEAD is missing,
    // it has already been committed by hand and counts as done.
    let open = if stopped_at.is_some() { &todo[..] } else { todo.get(1..).unwrap_or_default() };
    let source =
        stopped_at.as_deref().map(|sha| rev::short(sha).to_string()).or_else(|| open.first().map(|(_, sha)| rev::short(sha).to_string()));
    let (step, total_steps) = if todo.is_empty() {
        (None, None)
    } else {
        // Done are the commits since the start of the sequence.
        let done = match read_line(&dir.join("sequencer").join("head")) {
            Some(start) => count_commits_since(core, path, repo_id, &start).await,
            None => None,
        };
        let open_count = u32::try_from(open.len()).unwrap_or(u32::MAX);
        match done {
            Some(done) => (Some(done.saturating_add(open_count.min(1))), Some(done.saturating_add(open_count))),
            None => (None, None),
        }
    };
    Ok(Some(Operation { kind, source, target: current_branch, step, total_steps, message: merge_msg() }))
}

/// Readable name for a commit: local branch, otherwise remote branch, otherwise short SHA.
/// `exclude` is a branch that cannot be meant (e.g. the current one).
async fn name_for_commit(core: &Core, path: &Path, repo_id: &str, sha: &str, exclude: Option<&str>) -> String {
    let listed = core
        .git
        .cmd(path)
        .repo(repo_id)
        .read()
        .args(["for-each-ref", "--format=%(refname)", "--points-at", sha, "refs/heads", "refs/remotes"])
        .run_raw()
        .await;
    let names: Vec<String> = match &listed {
        Ok(out) if out.success() => out.stdout_lines().into_iter().map(util::decode_lossy).collect(),
        _ => Vec::new(),
    };
    let pick = |prefix: &str| {
        names
            .iter()
            .filter_map(|full| full.strip_prefix(prefix))
            .find(|short| Some(*short) != exclude && !short.ends_with("/HEAD"))
            .map(str::to_string)
    };
    pick("refs/heads/").or_else(|| pick("refs/remotes/")).unwrap_or_else(|| rev::short(sha).to_string())
}

async fn count_commits_since(core: &Core, path: &Path, repo_id: &str, start: &str) -> Option<u32> {
    let range = format!("{start}..HEAD");
    let out = core.git.cmd(path).repo(repo_id).read().args(["rev-list", "--count", &range]).run_raw().await.ok()?;
    if !out.success() {
        return None;
    }
    out.stdout_text().trim().parse().ok()
}

/// Lines of the sequencer list as (command, SHA); comments and empty lines are dropped.
/// Step and total of an interactive or merge rebase, counting only the commits it replays.
/// Git's `msgnum`/`end` also count `update-ref` (`--update-refs`), `exec`, `label`, `reset` and
/// `break` lines, so the third of three commits would read "4 of 4". `None` without `done` or
/// `git-rebase-todo` (then Git's own counters apply).
fn rebase_commit_steps(state: &Path) -> Option<(Option<u32>, Option<u32>)> {
    let done = read_text(&state.join("done"))?;
    let todo = read_text(&state.join("git-rebase-todo"))?;
    let commits = |list: &str| -> u32 { todo_lines(list).iter().filter(|(command, _)| is_commit_command(command)).count() as u32 };
    let step = commits(&done);
    let total = step + commits(&todo);
    Some((Some(step), Some(total)))
}

/// Todo commands that replay or create a commit (long and short forms).
fn is_commit_command(command: &str) -> bool {
    matches!(command, "pick" | "p" | "reword" | "r" | "edit" | "e" | "squash" | "s" | "fixup" | "f" | "merge" | "m")
}

fn todo_lines(todo: &str) -> Vec<(String, String)> {
    todo.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| {
            let mut parts = l.split_whitespace();
            Some((parts.next()?.to_string(), parts.next()?.to_string()))
        })
        .collect()
}

fn trim_bytes(bytes: &[u8]) -> &[u8] {
    let start = bytes.iter().position(|b| !b.is_ascii_whitespace()).unwrap_or(bytes.len());
    let end = bytes.iter().rposition(|b| !b.is_ascii_whitespace()).map_or(start, |i| i + 1);
    &bytes[start..end]
}

fn read_text(path: &Path) -> Option<String> {
    std::fs::read(path).ok().map(|bytes| util::decode_lossy(&bytes))
}

/// First line of a state file, without whitespace; `None` if it is missing or empty.
fn read_line(path: &Path) -> Option<String> {
    let text = read_text(path)?;
    let line = text.lines().next()?.trim();
    (!line.is_empty()).then(|| line.to_string())
}

/// Prepared message without the comment lines Git appends (e.g. the conflict list).
fn clean_message(raw: &str) -> Option<String> {
    let kept: Vec<&str> = raw.lines().filter(|l| !l.starts_with('#')).collect();
    let text = kept.join("\n").trim().to_string();
    (!text.is_empty()).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_helpers() {
        assert_eq!(clean_message("Merge branch 'x'\n\n# Conflicts:\n#\ta.txt\n").as_deref(), Some("Merge branch 'x'"));
        assert_eq!(clean_message("# nur Kommentar\n"), None);
        assert_eq!(
            todo_lines("pick abc123 Eins\n\n# Kommentar\nrevert def456 Zwei\n"),
            vec![("pick".to_string(), "abc123".to_string()), ("revert".to_string(), "def456".to_string())]
        );
        assert_eq!(trim_bytes(b"  a b \n"), b"a b");
        assert_eq!(trim_bytes(b" \n"), b"");
    }
}
