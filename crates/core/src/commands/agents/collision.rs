//! Collision warning between coding agents (cockpit, package 2b).
//!
//! After a change in an agent's worktree (debounced), the core takes a snapshot of every agent's
//! worktree as a tree (temporary `GIT_INDEX_FILE`, `add -A`, `write-tree` – `undo::worktree_tree`)
//! and wraps it in a loose commit (`commit-tree`, parent = the worktree's HEAD, no ref). Every pair
//! of agents whose changed files intersect is merged with `git merge-tree --write-tree`; so is each
//! agent with the current tip of its base. Conflicts carry the line ranges of the conflict markers.
//! Nothing in a working directory, an index or the refs changes; every Git call is a background
//! read (`GIT_OPTIONAL_LOCKS=0`, not in the activity log).

use std::collections::{BTreeSet, HashMap};

use crate::app::Core;
use crate::commands::preview::{self, Merged, MergedConflict};
use crate::db;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::GitCmd;
use crate::jobs::CancelToken;
use crate::model::{Agent, AgentCollision, AgentStatus, CollisionFile, CollisionKind, CollisionSkip};
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
pub(crate) async fn changed_paths(core: &Core, repo_id: &str, from: &str, to: &str) -> CoreResult<BTreeSet<Vec<u8>>> {
    let out = read(core, repo_id)?.args(["diff-tree", "-r", "-z", "--name-only", "--no-renames", from, to]).run().await?;
    Ok(util::split_z(&out.stdout).filter(|path| !path.is_empty()).map(<[u8]>::to_vec).collect())
}

/// Second half of the id of a collision with the base tip: `<agent>+base`.
pub const BASE_SUFFIX: &str = "base";

/// Result tree of a conflict and its files (display path → bytes); the preview reads from it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct StoredConflict {
    pub tree: String,
    pub files: Vec<(String, Vec<u8>)>,
}

/// What one check found.
#[derive(Debug, Default)]
pub(crate) struct Computed {
    pub collisions: Vec<AgentCollision>,
    pub skipped: Vec<CollisionSkip>,
    /// By collision id, only for conflicts.
    pub stored: HashMap<String, StoredConflict>,
}

/// An agent ready for comparing.
struct Prepared {
    agent: Agent,
    commit: String,
    fork: String,
    tip: Option<String>,
    changed: BTreeSet<Vec<u8>>,
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(7)]
}

async fn prepare(core: &Core, repo_id: &str, agent: Agent) -> CoreResult<Prepared> {
    let Some(worktree) = agent.worktree_repo_id.clone() else {
        return Err(CoreError::not_found("The agent's worktree is missing."));
    };
    if undo::rev_parse(core, repo_id, &format!("{}^{{commit}}", agent.base_sha)).await?.is_none() {
        return Err(CoreError::not_found(format!("The base commit {} of the agent no longer exists.", short(&agent.base_sha))));
    }
    let (commit, tree) = snapshot_commit(core, &worktree).await?;
    let head = undo::rev_parse(core, &worktree, "HEAD^{commit}").await?.unwrap_or_else(|| agent.base_sha.clone());
    let (fork, tip) = fork_point(core, repo_id, &head, &agent.base, &agent.base_sha).await?;
    let changed = changed_paths(core, repo_id, &fork, &tree).await?;
    Ok(Prepared { agent, commit, fork, tip, changed })
}

impl Computed {
    fn add(&mut self, id: String, agent_id: &str, other: Option<&str>, base: Option<&str>, merged: Merged, shared: &[Vec<u8>]) {
        let (kind, files): (CollisionKind, Vec<CollisionFile>) = match merged {
            Merged::Tree(_) => (
                CollisionKind::Overlap,
                shared.iter().map(|path| CollisionFile { path: util::decode_lossy(path), conflict: false, ranges: Vec::new() }).collect(),
            ),
            Merged::Conflicts { tree, files } => {
                // Git names no file (only messages): the shared files stand for the conflict.
                let files: Vec<MergedConflict> = if files.is_empty() {
                    shared.iter().map(|path| MergedConflict { path: util::decode_lossy(path), raw_path: path.clone(), ranges: Vec::new() }).collect()
                } else {
                    files
                };
                self.stored.insert(id.clone(), StoredConflict { tree, files: files.iter().map(|file| (file.path.clone(), file.raw_path.clone())).collect() });
                (CollisionKind::Conflict, files.into_iter().map(|file| CollisionFile { path: file.path, conflict: true, ranges: file.ranges }).collect())
            }
        };
        self.collisions.push(AgentCollision { id, kind, agent_id: agent_id.to_string(), other_agent_id: other.map(str::to_string), base: base.map(str::to_string), files });
    }
}

/// Compares the repository's present agents with each other (pairs whose changed files intersect)
/// and each with the current tip of its base. Orphaned agents are left out; an agent whose
/// worktree or base cannot be read is named in `skipped`. Conflicts come first.
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) async fn compute(core: &Core, repo_id: &str, cancel: &CancelToken) -> CoreResult<Computed> {
    core.repo_path(repo_id)?;
    let rows = core.db.with(|c| db::agents::list_for_repo(c, repo_id))?;
    let mut agents = Vec::with_capacity(rows.len());
    for row in &rows {
        agents.push(super::describe(core, row).await);
    }
    agents.retain(|agent| agent.status != AgentStatus::Orphaned && agent.worktree_repo_id.is_some());
    agents.sort_by(|a, b| a.started_at.cmp(&b.started_at).then_with(|| a.id.cmp(&b.id)));

    let mut computed = Computed::default();
    let mut ready: Vec<Prepared> = Vec::with_capacity(agents.len());
    for agent in agents {
        cancel.check()?;
        let agent_id = agent.id.clone();
        match prepare(core, repo_id, agent).await {
            Ok(prepared) => ready.push(prepared),
            Err(e) if matches!(e.code, ErrorCode::Cancelled | ErrorCode::RepoUntrusted) => return Err(e),
            // The reason goes to the UI and into events: redacted like every error text.
            Err(e) => computed.skipped.push(CollisionSkip { agent_id, reason: crate::git::redact::redact(&e.message) }),
        }
    }

    let explicit_base = core.git.info()?.version >= preview::MERGE_BASE_OPTION;
    for (index, first) in ready.iter().enumerate() {
        for second in &ready[index + 1..] {
            let shared: Vec<Vec<u8>> = first.changed.intersection(&second.changed).cloned().collect();
            if shared.is_empty() {
                continue;
            }
            cancel.check()?;
            let base = (explicit_base && first.fork == second.fork).then_some(first.fork.as_str());
            let merged = preview::merge_tree(core, repo_id, cancel, base, &first.commit, &second.commit, true).await?;
            computed.add(format!("{}+{}", first.agent.id, second.agent.id), &first.agent.id, Some(&second.agent.id), None, merged, &shared);
        }
    }

    let mut base_changes: HashMap<(String, String), BTreeSet<Vec<u8>>> = HashMap::new();
    for prepared in &ready {
        let Some(tip) = prepared.tip.as_deref().filter(|tip| *tip != prepared.fork) else {
            continue;
        };
        let key = (prepared.fork.clone(), tip.to_string());
        let changed = match base_changes.get(&key) {
            Some(changed) => changed.clone(),
            None => {
                let changed = changed_paths(core, repo_id, &prepared.fork, tip).await?;
                base_changes.insert(key, changed.clone());
                changed
            }
        };
        let shared: Vec<Vec<u8>> = prepared.changed.intersection(&changed).cloned().collect();
        if shared.is_empty() {
            continue;
        }
        cancel.check()?;
        let base = explicit_base.then_some(prepared.fork.as_str());
        let merged = preview::merge_tree(core, repo_id, cancel, base, &prepared.commit, tip, true).await?;
        computed.add(format!("{}+{BASE_SUFFIX}", prepared.agent.id), &prepared.agent.id, None, Some(&prepared.agent.base), merged, &shared);
    }
    computed.collisions.sort_by_key(|collision| collision.kind == CollisionKind::Overlap);
    Ok(computed)
}

#[cfg(test)]
mod tests;
