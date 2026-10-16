//! Stacked pull requests (Paket 8.1): a branch is split at commit boundaries into branches that
//! build on each other – `<branch>-1-<name>`, `<branch>-2-<name>` … – without a checkout, with one
//! undo step, optionally checked part by part in a temporary worktree, pushed in one atomic push
//! and opened as pull requests in stack order (each one targets the part below it).
//!
//! Which branches form a stack is Git's own config: `branch.<part>.forkyardStackParent` names the
//! full ref of the part below (part 1: the base). Nothing about a stack is kept in the database.

pub mod plan;

use std::collections::HashSet;

use crate::app::Core;
use crate::commands::graph::{read_cmd, resolve_commit, LOG_SAFE};
use crate::commands::remotes;
use crate::error::{CoreError, CoreResult};
use crate::model::{StackCommit, StackCut, StackPart, StackPlan};
use crate::util;

use plan::{SourceCommit, MAX_COMMITS};

/// The branch being split, its base and its commits (oldest first).
#[derive(Debug, Clone)]
pub(crate) struct Source {
    pub branch: String,
    pub base: String,
    pub base_sha: String,
    pub tip: String,
    pub commits: Vec<SourceCommit>,
}

/// A local branch with its tip and the worktree it is checked out in.
#[derive(Debug, Clone)]
pub(crate) struct LocalBranch {
    pub name: String,
    pub sha: String,
    pub worktree: Option<String>,
}

/// `refs/heads/x` or `x` → `x`, checked like every branch name.
pub(crate) fn branch_name_of(branch: &str) -> CoreResult<String> {
    let name = branch.trim();
    let name = name.strip_prefix("refs/heads/").unwrap_or(name);
    util::check_ref_name(name).map_err(|reason| CoreError::invalid_name(format!("Invalid branch name “{name}”: {reason}")))?;
    Ok(name.to_string())
}

/// The commits of `branch` that `base` (a full branch ref) does not have, oldest first – only a
/// straight history, at most `MAX_COMMITS`.
pub(crate) async fn read_source(core: &Core, repo_id: &str, branch: &str, base: &str) -> CoreResult<Source> {
    let branch = branch_name_of(branch)?;
    let base = base.trim().to_string();
    if !(base.starts_with("refs/heads/") || base.starts_with("refs/remotes/")) {
        return Err(CoreError::not_allowed("Choose the base as a branch (refs/heads/… or refs/remotes/…)."));
    }
    if base == format!("refs/heads/{branch}") {
        return Err(CoreError::not_allowed(format!("“{branch}” can't be stacked onto itself.")));
    }
    let tip = resolve_commit(core, repo_id, &format!("refs/heads/{branch}")).await?;
    let base_sha = resolve_commit(core, repo_id, &base).await?;
    let path = core.repo_path(repo_id)?;
    let range = format!("{base_sha}..{tip}");
    let shown_base = plan::short_ref(&base).to_string();
    let merges = read_cmd(core, &path, repo_id).args(["rev-list", "--count", "--merges", range.as_str(), "--"]).run().await?;
    if merges.stdout_text().trim() != "0" {
        return Err(CoreError::not_allowed(format!(
            "“{branch}” contains merge commits since “{shown_base}”. A stack is cut at commit boundaries of a straight history; rebase the branch onto its base first."
        )));
    }
    let count = read_cmd(core, &path, repo_id).args(["rev-list", "--count", range.as_str(), "--"]).run().await?;
    let total: usize = count.stdout_text().trim().parse().unwrap_or(0);
    if total == 0 {
        return Err(CoreError::not_allowed(format!("“{branch}” has no commits that “{shown_base}” does not have.")));
    }
    if total > MAX_COMMITS {
        return Err(CoreError::not_allowed(format!("“{branch}” has {total} commits; a stack is cut from at most {MAX_COMMITS}.")));
    }
    let out = read_cmd(core, &path, repo_id)
        .args(["log", "--reverse", "--topo-order", "-z", "-M", "--numstat", "--no-color"])
        .args(LOG_SAFE)
        .args(["--format=%x1e%H%x00%s%x00%b", range.as_str(), "--"])
        .run()
        .await?;
    let commits = plan::parse_log(&out.stdout);
    if commits.len() != total {
        return Err(CoreError::unknown("Git listed the commits of the branch differently twice; reload and try again."));
    }
    Ok(Source { branch, base, base_sha, tip, commits })
}

/// All local branches with tip and worktree.
pub(crate) async fn local_branches(core: &Core, repo_id: &str) -> CoreResult<Vec<LocalBranch>> {
    let path = core.repo_path(repo_id)?;
    let out = read_cmd(core, &path, repo_id).args(["for-each-ref", "--format=%(refname)%00%(objectname)%00%(worktreepath)", "refs/heads"]).run().await?;
    Ok(out
        .stdout_lines()
        .into_iter()
        .filter_map(|line| {
            let mut fields = line.split(|&b| b == 0);
            let name = util::decode_lossy(fields.next()?).strip_prefix("refs/heads/")?.to_string();
            let sha = util::decode_lossy(fields.next()?);
            let worktree = fields.next().map(util::decode_lossy).filter(|path| !path.is_empty());
            Some(LocalBranch { name, sha, worktree })
        })
        .collect())
}

fn commit_view(commit: &SourceCommit) -> StackCommit {
    StackCommit {
        sha: commit.sha.clone(),
        subject: commit.subject.clone(),
        files: commit.files.len() as u32,
        added: commit.files.iter().filter_map(|f| f.added).sum(),
        deleted: commit.files.iter().filter_map(|f| f.deleted).sum(),
    }
}

/// The plan for `cuts` (empty = one part with every commit): branch names and their problems.
pub(crate) async fn plan_for(core: &Core, repo_id: &str, source: &Source, cuts: &[StackCut]) -> CoreResult<StackPlan> {
    let total = source.commits.len();
    let cuts: Vec<StackCut> = if cuts.is_empty() { vec![StackCut { end: total as u32, name: String::new() }] } else { cuts.to_vec() };
    plan::validate_cuts(&cuts, total).map_err(CoreError::not_allowed)?;
    let existing: HashSet<String> = local_branches(core, repo_id).await?.into_iter().map(|b| b.name).collect();
    let remotes: Vec<String> = remotes::read_remotes(core, repo_id).await?.into_iter().map(|r| r.name).collect();
    let mut parts = Vec::with_capacity(cuts.len());
    let mut first = 1u32;
    for (index, cut) in cuts.iter().enumerate() {
        let commit = &source.commits[first as usize - 1];
        let words = if cut.name.trim().is_empty() { commit.subject.as_str() } else { cut.name.as_str() };
        let branch = plan::branch_name(&source.branch, index + 1, cuts.len(), &plan::slug(words));
        let problem = util::check_ref_name(&branch).err().or_else(|| plan::ref_conflict(&existing, &branch));
        parts.push(StackPart { number: index as u32 + 1, branch, first, end: cut.end, tip: source.commits[cut.end as usize - 1].sha.clone(), problem });
        first = cut.end + 1;
    }
    Ok(StackPlan {
        branch: source.branch.clone(),
        base: source.base.clone(),
        base_name: plan::target_name(&source.base, &remotes),
        base_sha: source.base_sha.clone(),
        tip: source.tip.clone(),
        commits: source.commits.iter().map(commit_view).collect(),
        parts,
    })
}

/// The commits of `branch` that `base` (full ref of a branch) does not have, and the parts that
/// `cuts` makes of them (empty = one part). Creates nothing.
pub async fn stack_plan(core: &Core, repo_id: String, branch: String, base: String, cuts: Vec<StackCut>) -> CoreResult<StackPlan> {
    let source = read_source(core, &repo_id, &branch, &base).await?;
    plan_for(core, &repo_id, &source, &cuts).await
}

#[cfg(test)]
mod tests;
