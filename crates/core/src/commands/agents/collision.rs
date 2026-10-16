//! Collision warning between coding agents (cockpit, package 2b).
//!
//! After a change in an agent's worktree (debounced), the core takes a snapshot of every agent's
//! worktree as a tree (temporary `GIT_INDEX_FILE`, `add -A`, `write-tree` – `undo::worktree_tree`)
//! and wraps it in a loose commit (`commit-tree`, parent = the worktree's HEAD, no ref). Every pair
//! of agents whose changed files intersect is merged with `git merge-tree --write-tree`; so is each
//! agent with the current tip of its base. Conflicts carry the line ranges of the conflict markers.
//! Nothing in a working directory, an index or the refs changes; every Git call is a background
//! read (`GIT_OPTIONAL_LOCKS=0`, not in the activity log).

use std::collections::BTreeSet;

use crate::app::Core;
use crate::error::CoreResult;
use crate::git::GitCmd;
use crate::undo;
use crate::util;

/// Message of the snapshot commits (never on a ref, never shown).
pub const SNAPSHOT_MESSAGE: &str = "forkyard: collision check";
/// Identity of the snapshot commits, so they work without user.name/user.email.
const SNAPSHOT_IDENTITY: [(&str, &str); 4] = [
    ("GIT_AUTHOR_NAME", "forkyard"),
    ("GIT_AUTHOR_EMAIL", "forkyard@localhost"),
    ("GIT_COMMITTER_NAME", "forkyard"),
    ("GIT_COMMITTER_EMAIL", "forkyard@localhost"),
];

/// A background read in `repo_id` (the main repository or an agent's worktree).
fn read(core: &Core, repo_id: &str) -> CoreResult<GitCmd> {
    Ok(core.git_for(repo_id)?.read_only().no_log())
}

/// Snapshot of an agent's worktree: the tree of its files as they are on disk (tracked and
/// untracked, not ignored; built on a temporary index, the real one stays untouched) and a loose
/// commit around it whose parent is the worktree's HEAD. Returns `(commit, tree)`.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) async fn snapshot_commit(core: &Core, worktree_repo_id: &str) -> CoreResult<(String, String)> {
    let tree = undo::worktree_tree(core, worktree_repo_id, None).await?;
    let head = undo::rev_parse(core, worktree_repo_id, "HEAD^{commit}").await?;
    let mut cmd = read(core, worktree_repo_id)?.args(["commit-tree", "--no-gpg-sign", &tree]);
    if let Some(head) = &head {
        cmd = cmd.args(["-p", head]);
    }
    for (key, value) in SNAPSHOT_IDENTITY {
        cmd = cmd.env(key, value);
    }
    let commit = cmd.args(["-m", SNAPSHOT_MESSAGE]).run_text().await?;
    Ok((commit, tree))
}

/// Where the agent's work starts, and the current tip of its base. The fork is the merge base of
/// the worktree's HEAD and the base tip (a rebase onto a newer base moves it along); without a
/// resolvable base, or without a merge base, it is the recorded `base_sha`. `(fork, tip)`.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) async fn fork_point(core: &Core, repo_id: &str, head: &str, base: &str, base_sha: &str) -> CoreResult<(String, Option<String>)> {
    let base = base.trim();
    let tip = if base.is_empty() { None } else { undo::rev_parse(core, repo_id, &format!("{base}^{{commit}}")).await? };
    let Some(tip) = tip else {
        return Ok((base_sha.to_string(), None));
    };
    let out = read(core, repo_id)?.args(["merge-base", head, &tip]).run_raw().await?;
    let fork = if out.success() { out.stdout_text().trim().to_string() } else { String::new() };
    Ok((if fork.is_empty() { base_sha.to_string() } else { fork }, Some(tip)))
}

/// Paths that differ between two trees (or commits), renames as delete + add, byte for byte.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) async fn changed_paths(core: &Core, repo_id: &str, from: &str, to: &str) -> CoreResult<BTreeSet<Vec<u8>>> {
    let out = read(core, repo_id)?.args(["diff-tree", "-r", "-z", "--name-only", "--no-renames", from, to]).run().await?;
    Ok(util::split_z(&out.stdout).filter(|path| !path.is_empty()).map(<[u8]>::to_vec).collect())
}

#[cfg(test)]
mod tests;
