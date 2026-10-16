//! Stacked pull requests (Paket 8.1): a branch is split at commit boundaries into branches that
//! build on each other – `<branch>-1-<name>`, `<branch>-2-<name>` … – without a checkout, with one
//! undo step, optionally checked part by part in a temporary worktree, pushed in one atomic push
//! and opened as pull requests in stack order (each one targets the part below it).
//!
//! Which branches form a stack is Git's own config: `branch.<part>.forkyardStackParent` names the
//! full ref of the part below (part 1: the base). Nothing about a stack is kept in the database.

pub mod plan;

use std::collections::{BTreeMap, HashSet};
use std::path::Path;

use serde_json::{json, Map};

use crate::app::Core;
use crate::commands::graph::{display_text, read_cmd, resolve_commit, LOG_SAFE};
use crate::commands::{host, rebase, refs, remotes, sync};
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::model::{
    OpResult, PushExtra, PushRefStatus, PushResult, RepoChange, StackCommit, StackCut, StackPart, StackPlan, StackPrCreated, StackPrFailed, StackPrOutcome, StackPrPart, StackRestack,
    StackStatus, StackStatusPart,
};
use crate::undo::{self as u, GroupRecord, RefMove, UndoAction};
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

/// Writes `branch.<part>.forkyardStackParent` for every part: part 1 → the base, part n → part n-1.
async fn set_parents(core: &Core, repo_id: &str, planned: &StackPlan) -> CoreResult<()> {
    let mut parent = planned.base.clone();
    for part in &planned.parts {
        core.git_for(repo_id)?.args(["config", "--local"]).arg(format!("branch.{}.{}", part.branch, plan::PARENT_KEY)).arg(&parent).run().await?;
        parent = format!("refs/heads/{}", part.branch);
    }
    Ok(())
}

/// Creates the branches of the plan for `cuts` – without a checkout, in one ref transaction, as one
/// undo step – and returns the new stack. `expected_base`/`expected_tip`: the tips the plan showed.
pub async fn stack_create(core: &Core, repo_id: String, branch: String, base: String, cuts: Vec<StackCut>, expected_base: String, expected_tip: String) -> CoreResult<StackStatus> {
    let id = repo_id.as_str();
    let top = core
        .with_write_lock(id, &[RepoChange::Refs, RepoChange::Config], async {
            let source = read_source(core, id, &branch, &base).await?;
            if source.tip != expected_tip.trim() || source.base_sha != expected_base.trim() {
                return Err(CoreError::new(
                    ErrorCode::StaleState,
                    format!("“{}” or its base has moved since the plan was shown. Nothing was created; check the plan again.", source.branch),
                ));
            }
            let planned = plan_for(core, id, &source, &cuts).await?;
            if let Some(part) = planned.parts.iter().find(|part| part.problem.is_some()) {
                let code = if util::check_ref_name(&part.branch).is_err() { ErrorCode::InvalidName } else { ErrorCode::NameExists };
                return Err(CoreError::new(code, part.problem.clone().unwrap_or_default()));
            }
            let moves: Vec<RefMove> = planned.parts.iter().map(|part| RefMove::new(&format!("refs/heads/{}", part.branch), None, Some(part.tip.as_str()))).collect();
            let head = refs::read_head(core, id).await?;
            let entry_id = u::new_id();
            u::apply_ref_moves(core, id, &moves, "forkyard: stacked branches").await?;
            if let Err(error) = set_parents(core, id, &planned).await {
                let back: Vec<RefMove> = moves.iter().map(RefMove::reversed).collect();
                let _ = u::apply_ref_moves(core, id, &back, "forkyard: stacked branches (rolled back)").await;
                return Err(error);
            }
            let mut extra = Map::new();
            extra.insert(
                "stack".into(),
                json!({ "branch": planned.branch, "base": planned.base, "parts": planned.parts.iter().map(|part| part.branch.clone()).collect::<Vec<_>>() }),
            );
            u::record_group(
                core,
                GroupRecord {
                    id: entry_id,
                    repo_id: id.to_string(),
                    action: UndoAction::StackCreate,
                    label: format!("Undo splitting “{}” into {} stacked branches", planned.branch, planned.parts.len()),
                    refs: moves,
                    head_before: u::head_token(&head),
                    head_after: Some(u::head_token(&head)),
                    snapshot: None,
                    extra,
                },
            )
            .await?;
            Ok(planned.parts.last().map(|part| part.branch.clone()).unwrap_or_default())
        })
        .await?;
    status_of(core, id, &top).await?.ok_or_else(|| CoreError::unknown("The new stack could not be read back."))
}

/// Subjects of the commits of `tip` that `parent` does not have, oldest first, at most 50
/// (without a parent: only the tip's own subject).
async fn subjects(core: &Core, repo_id: &str, parent: Option<&str>, tip: &str) -> CoreResult<Vec<String>> {
    let path = core.repo_path(repo_id)?;
    let limit = if parent.is_some() { "--max-count=50" } else { "--max-count=1" };
    let mut cmd = read_cmd(core, &path, repo_id).args(["log", "--reverse", "-z", limit, "--format=%s"]).args(LOG_SAFE).arg(tip);
    if let Some(parent) = parent {
        cmd = cmd.args(["--not", parent]);
    }
    let out = cmd.arg("--").run().await?;
    Ok(out.stdout_z().into_iter().map(display_text).collect())
}

async fn is_ancestor(core: &Core, repo_id: &str, ancestor: &str, of: &str) -> CoreResult<bool> {
    let path = core.repo_path(repo_id)?;
    Ok(read_cmd(core, &path, repo_id).args(["merge-base", "--is-ancestor", ancestor, of]).run_raw().await?.success())
}

fn same_place(a: &str, b: &Path) -> bool {
    let key = |p: &Path| std::fs::canonicalize(p).map(|c| util::path_key(&c)).unwrap_or_else(|_| util::path_key(p));
    key(Path::new(a)) == key(b)
}

/// The lowest part that no longer contains the part (or base) below it decides what to rebase.
async fn restack_for(core: &Core, repo_id: &str, parts: &[StackStatusPart]) -> CoreResult<Option<StackRestack>> {
    let Some(index) = parts.iter().position(|part| !part.contains_parent) else { return Ok(None) };
    let top = &parts[parts.len() - 1];
    let here = core.repo_path(repo_id)?;
    let blocked = top
        .worktree_path
        .as_deref()
        .filter(|path| !same_place(path, &here))
        .map(|path| format!("“{}” is checked out in another worktree ({path}); restack it there.", top.branch));
    let moves = rebase::rebase_dependents(core, repo_id.to_string(), parts[index].parent.clone(), Some(top.branch.clone())).await?;
    let left_behind = parts[index..parts.len() - 1].iter().filter(|part| part.worktree_path.is_some()).map(|part| part.branch.clone()).collect();
    Ok(Some(StackRestack { onto: parts[index].parent.clone(), top: top.branch.clone(), top_tip: top.tip.clone(), moves, left_behind, blocked }))
}

/// The stack `name` (short name) is a part of, from the parent links in the config.
pub(crate) async fn status_of(core: &Core, repo_id: &str, name: &str) -> CoreResult<Option<StackStatus>> {
    let pattern = format!(r"^branch\..*\.{}$", plan::PARENT_KEY.to_ascii_lowercase());
    let out = core.git_for(repo_id)?.args(["config", "--local", "-z", "--get-regexp", pattern.as_str()]).read_only().no_log().run_raw().await?;
    // Exit code 1: no such entry.
    let parents = if out.success() { plan::parse_parents(&out.stdout) } else { BTreeMap::new() };
    let branches = local_branches(core, repo_id).await?;
    let existing: HashSet<String> = branches.iter().map(|branch| branch.name.clone()).collect();
    let Some(chain) = plan::chain(&parents, &existing, name) else { return Ok(None) };
    let base = parents[&chain[0]].clone();
    let remotes: Vec<String> = remotes::read_remotes(core, repo_id).await?.into_iter().map(|r| r.name).collect();
    let mut parts = Vec::with_capacity(chain.len());
    let mut parent = base.clone();
    for part in &chain {
        let Some(info) = branches.iter().find(|branch| &branch.name == part) else { continue };
        // A base that is gone (pruned remote branch) can't be compared; the part counts as fine.
        let parent_sha = resolve_commit(core, repo_id, &parent).await.ok();
        let contains_parent = match &parent_sha {
            Some(sha) => is_ancestor(core, repo_id, sha, &info.sha).await?,
            None => true,
        };
        parts.push(StackStatusPart {
            branch: part.clone(),
            parent: parent.clone(),
            tip: info.sha.clone(),
            contains_parent,
            worktree_path: info.worktree.clone(),
            subjects: subjects(core, repo_id, parent_sha.as_deref(), &info.sha).await?,
        });
        parent = format!("refs/heads/{part}");
    }
    let restack = restack_for(core, repo_id, &parts).await?;
    Ok(Some(StackStatus { base_name: plan::target_name(&base, &remotes), base, parts, restack }))
}

/// The stack `branch` is a part of; `None` if it is no part.
pub async fn stack_status(core: &Core, repo_id: String, branch: String) -> CoreResult<Option<StackStatus>> {
    let name = branch_name_of(&branch)?;
    status_of(core, &repo_id, &name).await
}

/// "Restack": the lowest part that no longer contains the part below it – and everything above it –
/// is rebased onto that part with `--update-refs` (v1.1, checks the top part out here).
/// `expected_top`: the top part's tip the view showed.
pub async fn stack_restack(core: &Core, repo_id: String, branch: String, expected_top: String) -> CoreResult<OpResult> {
    let name = branch_name_of(&branch)?;
    let status = status_of(core, &repo_id, &name).await?.ok_or_else(|| CoreError::not_found(format!("“{name}” is not part of a stack.")))?;
    let restack = status.restack.ok_or_else(|| CoreError::not_allowed("Every part contains the part below it; there is nothing to restack."))?;
    if let Some(reason) = restack.blocked {
        return Err(CoreError::not_allowed(reason));
    }
    if restack.top_tip != expected_top.trim() {
        return Err(CoreError::new(ErrorCode::StaleState, "The stack has changed since it was shown. Nothing was rebased; check it again."));
    }
    rebase::rebase_start_with(core, repo_id, restack.onto, Some(restack.top), Some(true)).await
}

/// Pushes every part in one atomic push (v1.1 `push_with`: the first part as the primary branch,
/// the others as extra refs) and records the upstream of every part that arrived. `force`: each ref
/// only with `--force-with-lease` against its tracking ref (after a restack).
pub async fn stack_push(core: &Core, repo_id: String, job_id: String, branches: Vec<String>, remote: String, force: bool) -> CoreResult<PushResult> {
    let names: Vec<String> = branches.iter().map(|branch| branch_name_of(branch)).collect::<CoreResult<_>>()?;
    let Some((first, rest)) = names.split_first() else {
        return Err(CoreError::not_allowed("There is no part to push."));
    };
    let mut seen = HashSet::new();
    if let Some(twice) = names.iter().find(|name| !seen.insert(name.as_str())) {
        return Err(CoreError::not_allowed(format!("“{twice}” is named twice in the push.")));
    }
    let remote = remote.trim().to_string();
    if remote.is_empty() || remote.starts_with('-') || remote.chars().any(char::is_control) {
        return Err(CoreError::not_allowed("Choose the remote to push the stack to."));
    }
    let extra: Vec<PushExtra> = rest.iter().map(|name| PushExtra { local: format!("refs/heads/{name}"), remote_name: None, force }).collect();
    let result = sync::push_with(core, repo_id.clone(), job_id, Some(first.clone()), Some(remote.clone()), None, force, None, Some(extra), Some(true)).await?;
    if let PushResult::Multi { refs, .. } = &result {
        let arrived: Vec<&String> = rest.iter().filter(|name| refs.iter().any(|r| r.local == format!("refs/heads/{name}") && r.status != PushRefStatus::Rejected)).collect();
        if !arrived.is_empty() {
            core.with_write_lock(&repo_id, &[RepoChange::Config], async {
                for name in &arrived {
                    core.git_for(&repo_id)?.args(["config", "--local"]).arg(format!("branch.{name}.remote")).arg(&remote).run().await?;
                    core.git_for(&repo_id)?.args(["config", "--local"]).arg(format!("branch.{name}.merge")).arg(format!("refs/heads/{name}")).run().await?;
                }
                Ok(())
            })
            .await?;
        }
    }
    Ok(result)
}

/// Opens the pull requests of `parts[from..]` one after the other, each onto the part below it
/// (the first part onto `target`, the base's branch name on the host). Everything is checked before
/// the first request; the first failure stops the rest and is reported with its part.
pub async fn stack_prs_create(core: &Core, repo_id: String, target: String, parts: Vec<StackPrPart>, from: u32, remote: Option<String>) -> CoreResult<StackPrOutcome> {
    let target = target.trim().to_string();
    if target.is_empty() || target.starts_with('-') {
        return Err(CoreError::not_allowed("The stack needs the target branch of its first pull request."));
    }
    if parts.is_empty() {
        return Err(CoreError::not_allowed("There is no part to open a pull request for."));
    }
    let from = from as usize;
    if from >= parts.len() {
        return Err(CoreError::not_allowed(format!("Part {} does not exist; the stack has {} parts.", from + 1, parts.len())));
    }
    let names: Vec<String> = parts.iter().map(|part| branch_name_of(&part.branch)).collect::<CoreResult<_>>()?;
    let existing: HashSet<String> = local_branches(core, &repo_id).await?.into_iter().map(|branch| branch.name).collect();
    let mut seen = HashSet::new();
    for (index, name) in names.iter().enumerate() {
        if !existing.contains(name) {
            return Err(CoreError::not_found(format!("The branch “{name}” does not exist.")));
        }
        if *name == target || !seen.insert(name.as_str()) {
            return Err(CoreError::not_allowed(format!("“{name}” appears twice in the stack.")));
        }
        if index >= from {
            let title = parts[index].title.trim();
            if title.is_empty() {
                return Err(CoreError::new(ErrorCode::EmptyMessage, format!("The title of part {} must not be empty.", index + 1)));
            }
            if title.contains(['\n', '\r']) {
                return Err(CoreError::not_allowed(format!("The title of part {} must be a single line.", index + 1)));
            }
        }
    }
    let mut outcome = StackPrOutcome { created: Vec::new(), failed: None };
    for (index, part) in parts.iter().enumerate().skip(from) {
        let into = if index == 0 { target.clone() } else { names[index - 1].clone() };
        let number = index as u32 + 1;
        match host::pr_create(core, repo_id.clone(), part.title.clone(), part.body.clone(), names[index].clone(), into, part.draft, None, None, remote.clone()).await {
            Ok(pr) => outcome.created.push(StackPrCreated { part: number, pr }),
            Err(error) => {
                outcome.failed = Some(StackPrFailed { part: number, error });
                break;
            }
        }
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests;
