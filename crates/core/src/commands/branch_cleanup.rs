//! Branch cleaner: which local branches can go and why.
//!
//! The list is a pure read: no lock, no event. Git gives the facts; the host only adds what its pull
//! requests say, and without it the list comes without PR reasons (`pr_data_missing`). Deleting
//! checks every target against what the list showed, then deletes all as one undo step.

use std::collections::{HashMap, HashSet};

use crate::app::Core;
use crate::commands::{branches, host as host_cmd, refs, settings};
use crate::error::{CoreError, CoreResult};
use crate::git::rev;
use crate::host;
use crate::model::{
    BranchCleanupCandidate, BranchCleanupList, BranchCleanupTarget, HostKind, PrListState, PrState, PrSummary, Ref, RefsSnapshot,
    RepoChange,
};
use crate::util;

mod classify;

use classify::{classify, is_protected, BranchFacts, PrFact};

/// Local branches that can go, each with class and reasons.
pub async fn branch_cleanup_candidates(core: &Core, repo_id: String) -> CoreResult<BranchCleanupList> {
    candidates_at(core, &repo_id, chrono::Utc::now().timestamp()).await
}

/// `branch_cleanup_candidates` at the point in time `now` (Unix seconds).
pub(crate) async fn candidates_at(core: &Core, repo_id: &str, now: i64) -> CoreResult<BranchCleanupList> {
    let snapshot = refs::read_refs(core, repo_id).await?;
    let default = default_branch(core, repo_id, &snapshot.locals).await;
    let stale_days = settings::load_settings(core)?.branch_cleanup_stale_days;
    let own_patterns = core.repo_settings(repo_id).await?.protected_branch_patterns;

    // "In the default branch": reachable from it or from its upstream (merged on the host, not pulled yet).
    let default_ref = snapshot.locals.iter().find(|r| Some(&r.name) == default.as_ref());
    let mut bases: Vec<String> = default_ref.map(|r| r.sha.clone()).into_iter().collect();
    if let Some(upstream) = default_ref.filter(|r| !r.upstream_gone).and_then(|r| r.upstream.as_ref()) {
        bases.extend(snapshot.remotes.iter().chain(&snapshot.locals).find(|r| &r.name == upstream).map(|r| r.sha.clone()));
    }

    let path = core.repo_path(repo_id)?;
    let mut merged: HashSet<String> = HashSet::new();
    if !bases.is_empty() {
        // Several `--merged`: reachable from any of them.
        let options: Vec<String> = std::iter::once("--format=%(refname:lstrip=2)%00".to_string())
            .chain(bases.iter().map(|sha| format!("--merged={sha}")))
            .collect();
        let out = refs::for_each_ref(core, &path, repo_id, &options, &["refs/heads"]).await?;
        merged.extend(fields(&out.stdout, 1).into_iter().map(|mut f| f.remove(0)));
    }
    // Name → (committer date, upstream remote, upstream branch there).
    let options = ["--format=%(refname:lstrip=2)%00%(committerdate:unix)%00%(upstream:remotename)%00%(upstream:remoteref)%00".to_string()];
    let out = refs::for_each_ref(core, &path, repo_id, &options, &["refs/heads"]).await?;
    let details: HashMap<String, (i64, String, String)> =
        fields(&out.stdout, 4).into_iter().filter_map(|f| Some((f[0].clone(), (f[1].parse().ok()?, f[2].clone(), f[3].clone())))).collect();

    // Never the current or the default branch.
    let branches: Vec<&Ref> = snapshot.locals.iter().filter(|r| !r.is_head && Some(&r.name) != default.as_ref()).collect();
    // Merged in Git or blocked: a merged PR's head can't change the class, so its details aren't read.
    let settled: HashSet<String> = branches
        .iter()
        .filter(|r| merged.contains(&r.name) || r.worktree_path.is_some() || is_protected(&r.name, &own_patterns))
        .map(|r| r.name.clone())
        .collect();
    let (prs, pr_data_missing) = pr_facts(core, repo_id, &branches, &settled).await?;
    let heads = remote_heads(core, repo_id).await;

    let mut candidates = Vec::new();
    for branch in branches {
        // No row (created meanwhile) or no readable date: skip rather than call it stale since 1970.
        let Some((committed_at, remote, remote_ref)) = details.get(&branch.name).cloned() else { continue };
        let has_upstream = branch.upstream.is_some() && !branch.upstream_gone;
        let mut facts = BranchFacts {
            name: branch.name.clone(),
            merged: merged.contains(&branch.name),
            unmerged: 0,
            unpushed: if has_upstream { branch.ahead } else { branch.unpublished.unwrap_or(0) },
            upstream_gone: branch.upstream_gone,
            committed_at,
            worktree: branch.worktree_path.is_some(),
            protected: is_protected(&branch.name, &own_patterns),
            pr: prs.get(&branch.name).copied().unwrap_or(PrFact::Unknown),
        };
        // Whether a branch is listed never depends on the count: count only the listed ones.
        if classify(&facts, now, stale_days).is_none() {
            continue;
        }
        if !facts.merged && !bases.is_empty() {
            facts.unmerged = unmerged_count(core, repo_id, &branch.sha, &bases).await?;
        }
        let Some((class, reasons)) = classify(&facts, now, stale_days) else { continue };
        let upstream_sha = match snapshot.remotes.iter().find(|r| has_upstream && branch.upstream.as_ref() == Some(&r.name)) {
            // Behind: the remote branch has commits this one lacks; they may only go if the default branch has them.
            Some(up) if branch.behind == 0 || (!bases.is_empty() && unmerged_count(core, repo_id, &up.sha, &bases).await? == 0) => {
                Some(up.sha.clone())
            }
            _ => None,
        };
        let remote_branch = remote_ref.strip_prefix("refs/heads/").unwrap_or(&remote_ref).to_string();
        // Never offered: a protected or the default branch on the remote (e.g. a branch created from `origin/main`).
        let keeps_remote = is_protected(&remote_branch, &own_patterns)
            || default.as_ref() == Some(&remote_branch)
            || heads.iter().any(|(r, b)| r == &remote && b == &remote_branch);
        let upstream_remote = (upstream_sha.is_some() && !keeps_remote && !remote.is_empty() && remote != ".").then_some(remote);
        let upstream_branch = upstream_remote.as_ref().map(|_| remote_branch);
        let upstream_sha = upstream_sha.filter(|_| upstream_remote.is_some());
        candidates.push(BranchCleanupCandidate {
            name: facts.name,
            sha: branch.sha.clone(),
            class,
            reasons,
            committed_at: util::unix_to_iso(committed_at),
            upstream_remote,
            upstream_branch,
            upstream_sha,
        });
    }
    candidates.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(BranchCleanupList { default_branch: default, candidates, pr_data_missing })
}

/// Deletes the chosen branches as one undo step. Refuses all if one has moved, is gone, is checked
/// out, is the default branch or is protected; `delete_locked` adds the moved ones (against the SHAs
/// the list showed), worktrees and in-progress operations.
pub async fn branch_cleanup_delete(core: &Core, repo_id: String, targets: Vec<BranchCleanupTarget>) -> CoreResult<RefsSnapshot> {
    if targets.is_empty() {
        return refs::read_refs(core, &repo_id).await;
    }
    core.with_write_lock(&repo_id, &[RepoChange::Refs, RepoChange::Config], async {
        let mut names: Vec<String> = Vec::new();
        let mut unique: Vec<&BranchCleanupTarget> = Vec::new();
        for target in &targets {
            if !names.contains(&target.name) {
                names.push(target.name.clone());
                unique.push(target);
            }
        }
        let branches = branches::local_branches(core, &repo_id).await?;
        let default = default_branch(core, &repo_id, &refs::read_refs(core, &repo_id).await?.locals).await;
        let own_patterns = core.repo_settings(&repo_id).await?.protected_branch_patterns;
        // Check everything first, then delete: either all or none.
        for target in unique {
            let name = &target.name;
            let Some(info) = branches.iter().find(|b| &b.name == name) else {
                return Err(CoreError::not_found(format!("The branch ‘{name}’ doesn’t exist (anymore).")));
            };
            if info.is_head {
                return Err(CoreError::not_allowed(format!("The branch ‘{name}’ is checked out and can’t be cleaned up.")));
            }
            if default.as_ref() == Some(name) {
                return Err(CoreError::not_allowed(format!("The branch ‘{name}’ is the default branch and can’t be cleaned up.")));
            }
            if is_protected(name, &own_patterns) {
                return Err(CoreError::not_allowed(format!("The branch ‘{name}’ is protected and can’t be cleaned up.")));
            }
        }
        let expected: HashMap<String, String> = targets.iter().map(|t| (t.name.clone(), t.sha.clone())).collect();
        branches::delete_locked(core, &repo_id, &names, true, &expected).await?;
        refs::read_refs(core, &repo_id).await
    })
    .await
}

/// Records of `count` NUL-terminated fields; Git ends every record with a newline that sticks to the next one.
fn fields(stdout: &[u8], count: usize) -> Vec<Vec<String>> {
    let parts: Vec<&[u8]> = stdout.split(|&b| b == 0).collect();
    parts
        .chunks_exact(count)
        .map(|chunk| {
            let first = chunk[0].strip_prefix(b"\n").unwrap_or(chunk[0]);
            std::iter::once(first).chain(chunk[1..].iter().copied()).map(util::decode_lossy).collect()
        })
        .collect()
}

/// Commits of `tip` in none of `bases`.
async fn unmerged_count(core: &Core, repo_id: &str, tip: &str, bases: &[String]) -> CoreResult<u32> {
    let out = core.git_for(repo_id)?.read().args(["rev-list", "--count", tip, "--not"]).args(bases).arg("--").run().await?;
    Ok(out.stdout_text().trim().parse().unwrap_or(0))
}

/// The local branch `refs/remotes/<remote>/HEAD` points at (`origin` first), else `main`, else
/// `master`, else the checked-out branch.
pub(crate) async fn default_branch(core: &Core, repo_id: &str, locals: &[Ref]) -> Option<String> {
    let exists = |name: &str| locals.iter().any(|r| r.name == name);
    let mut heads = remote_heads(core, repo_id).await;
    heads.sort_by_key(|(remote, _)| remote != "origin");
    if let Some((_, branch)) = heads.into_iter().find(|(_, branch)| exists(branch)) {
        return Some(branch);
    }
    ["main", "master"]
        .into_iter()
        .find(|name| exists(name))
        .map(str::to_string)
        .or_else(|| locals.iter().find(|r| r.is_head).map(|r| r.name.clone()))
}

/// (remote, branch) for every `refs/remotes/<remote>/HEAD` that points at `refs/remotes/<remote>/<branch>`.
async fn remote_heads(core: &Core, repo_id: &str) -> Vec<(String, String)> {
    let Ok(path) = core.repo_path(repo_id) else { return Vec::new() };
    let options = ["--format=%(refname)%00%(symref)%00".to_string()];
    let Ok(out) = refs::for_each_ref(core, &path, repo_id, &options, &["refs/remotes"]).await else { return Vec::new() };
    fields(&out.stdout, 2)
        .into_iter()
        .filter_map(|f| {
            let remote = f[0].strip_prefix("refs/remotes/")?.strip_suffix("/HEAD")?;
            let branch = f[1].strip_prefix(&format!("refs/remotes/{remote}/"))?;
            Some((remote.to_string(), branch.to_string()))
        })
        .collect()
}

/// What the host says per branch name, and the host whose data is missing. For a `settled` branch a
/// merged PR's details are not read.
async fn pr_facts(
    core: &Core,
    repo_id: &str,
    branches: &[&Ref],
    settled: &HashSet<String>,
) -> CoreResult<(HashMap<String, PrFact>, Option<HostKind>)> {
    let Some(found) = host::resolve(core, repo_id, None).await? else {
        return Ok((HashMap::new(), None));
    };
    let missing = || Ok((HashMap::new(), Some(found.detected.kind)));
    if found.detected.account.is_none() {
        return missing();
    }
    let mut prs = Vec::new();
    // Still more pages after the last one read: a branch without a match may have an older PR.
    let mut cut_off = false;
    for page in 1..=2 {
        match host_cmd::pr_list(core, repo_id.to_string(), PrListState::All, Some(page), Some(100), Some(found.remote.clone())).await {
            Ok(list) => {
                prs.extend(list.items);
                cut_off = list.next_page.is_some();
                if !cut_off {
                    break;
                }
            }
            Err(e) => {
                log::info!("Branch cleaner without PR data: {}", e.message);
                return missing();
            }
        }
    }
    let mut facts = HashMap::new();
    for branch in branches {
        // A branch that tracks another name on the host remote has its PR under that name.
        let host_prefix = format!("{}/", found.remote);
        let source = branch.upstream.as_deref().and_then(|u| u.strip_prefix(&host_prefix)).unwrap_or(&branch.name);
        let mut fact = listed_fact(&prs, source, cut_off, settled.contains(&branch.name));
        if let PrFact::Merged { number, commits_after_head: true } = fact {
            // An unknown head (details fail, object missing locally) counts as commits after it.
            let contained = match host_cmd::pr_get(core, repo_id.to_string(), number, Some(found.remote.clone())).await {
                Ok(details) => {
                    details.head_sha == branch.sha || rev::is_ancestor(core, repo_id, &branch.sha, &details.head_sha).await.unwrap_or(false)
                }
                Err(_) => false,
            };
            fact = PrFact::Merged { number, commits_after_head: !contained };
        }
        facts.insert(branch.name.clone(), fact);
    }
    Ok((facts, None))
}

/// What the PR list (newest first) says about `branch`. A merged PR counts as having commits after
/// its head until the details show otherwise, unless the branch is `settled`. `cut_off`: older PRs
/// were not read, so no match means unknown.
fn listed_fact(prs: &[PrSummary], branch: &str, cut_off: bool, settled: bool) -> PrFact {
    match prs.iter().find(|pr| !pr.is_fork && pr.source_branch == branch) {
        None if cut_off => PrFact::Unknown,
        None => PrFact::None,
        Some(pr) if pr.state != PrState::Merged => PrFact::Open,
        Some(pr) => PrFact::Merged { number: pr.number, commits_after_head: !settled },
    }
}

#[cfg(test)]
mod tests;
