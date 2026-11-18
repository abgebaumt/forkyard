//! Revisions: checking what the UI passes as a revision, resolving names to commits, ancestry.

use crate::app::Core;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::errors::classify;
use crate::git::GitOutput;

/// Full SHA (SHA-1 or SHA-256).
pub fn is_sha(text: &str) -> bool {
    matches!(text.len(), 40 | 64) && text.bytes().all(|b| b.is_ascii_hexdigit())
}

/// What could be an abbreviated or full SHA (4 to 64 hex digits).
pub fn is_sha_prefix(text: &str) -> bool {
    (4..=64).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_hexdigit())
}

/// The first seven characters: how a SHA is shown in messages.
pub fn short(sha: &str) -> &str {
    sha.char_indices().nth(7).map_or(sha, |(end, _)| &sha[..end])
}

/// A revision argument that may go to Git: not empty, no leading `-` (would be read as an
/// option) and no control characters.
pub fn is_rev_arg(rev: &str) -> bool {
    !rev.is_empty() && !rev.starts_with('-') && !rev.chars().any(char::is_control)
}

/// `refs/remotes/origin/main` → `origin/main`, `refs/heads/main` → `main`.
pub fn short_ref_name(full: &str) -> &str {
    for prefix in ["refs/heads/", "refs/remotes/", "refs/tags/"] {
        if let Some(rest) = full.strip_prefix(prefix) {
            return rest;
        }
    }
    full
}

/// Whether `rev` can be a short name (no full ref name, no expression like `HEAD~2` or `a..b`,
/// no `HEAD`/`FETCH_HEAD`/`ORIG_HEAD`/… – Git reads those from `$GIT_DIR` first).
pub(crate) fn could_be_branch_name(rev: &str) -> bool {
    let pseudo_ref = rev.ends_with("HEAD") && rev.bytes().all(|b| b.is_ascii_uppercase() || b == b'_');
    !rev.starts_with("refs/") && !pseudo_ref && !rev.contains(['~', '^', ':', '@', ' ']) && !rev.contains("..")
}

/// A failed call that does not mean "does not exist" but something else
/// (no repository any more, folder not trusted …): this error takes precedence.
pub(crate) fn other_failure(out: &GitOutput, subcommand: &str) -> Option<CoreError> {
    if out.success() {
        return None;
    }
    let err = classify(subcommand, out.code, &out.stdout, &out.stderr);
    (!matches!(err.code, ErrorCode::NotFound | ErrorCode::Unknown)).then_some(err)
}

pub(crate) fn commit_not_found(rev: &str) -> CoreError {
    let shown: String = rev.chars().filter(|c| !c.is_control()).take(40).collect();
    CoreError::not_found(format!("Commit “{shown}” was not found."))
}

/// The object `rev` names (`rev-parse --verify`, no peeling); `None` if it does not exist or
/// `rev` is no valid argument.
pub async fn rev_parse(core: &Core, repo_id: &str, rev: &str) -> CoreResult<Option<String>> {
    if !is_rev_arg(rev) {
        return Ok(None);
    }
    let out = core.git_for(repo_id)?.read().args(["rev-parse", "-q", "--verify", "--end-of-options", rev]).run_raw().await?;
    let sha = out.stdout_text();
    if out.success() && !sha.is_empty() {
        return Ok(Some(sha));
    }
    other_failure(&out, "rev-parse").map_or(Ok(None), Err)
}

/// SHA of the commit `rev` points to (tags are peeled); `None` if there is none.
///
/// A short name first means the local branch of that name: Git itself would silently take a tag
/// of the same name (`refs/tags` before `refs/heads`) – but the UI passes branch names from the
/// left panel, the drop menu and the command palette.
pub async fn try_resolve_commit(core: &Core, repo_id: &str, rev: &str) -> CoreResult<Option<String>> {
    let rev = rev.trim();
    if !is_rev_arg(rev) {
        return Ok(None);
    }
    if !is_sha(rev) && could_be_branch_name(rev) {
        if let Some(sha) = rev_parse(core, repo_id, &format!("refs/heads/{rev}^{{commit}}")).await? {
            return Ok(Some(sha));
        }
    }
    rev_parse(core, repo_id, &format!("{rev}^{{commit}}")).await
}

/// Like [`try_resolve_commit`], `not_found` if there is no such commit.
pub async fn resolve_commit(core: &Core, repo_id: &str, rev: &str) -> CoreResult<String> {
    try_resolve_commit(core, repo_id, rev).await?.ok_or_else(|| commit_not_found(rev.trim()))
}

/// Whether `ancestor` is reachable from `descendant`. `false` also if one of them does not
/// exist (any more); other failures (no repository, timeout …) are errors.
pub async fn is_ancestor(core: &Core, repo_id: &str, ancestor: &str, descendant: &str) -> CoreResult<bool> {
    if !is_rev_arg(ancestor) || !is_rev_arg(descendant) {
        return Ok(false);
    }
    let out =
        core.git_for(repo_id)?.read().args(["merge-base", "--is-ancestor", "--end-of-options", ancestor, descendant]).run_raw().await?;
    match out.code {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => other_failure(&out, "merge-base").map_or(Ok(false), Err),
    }
}

#[cfg(test)]
mod tests;
