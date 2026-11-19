//! The plan for editing the history in the graph: which commits of the checked-out branch.

use super::*;
use crate::commands::{branch_cleanup, refs};

/// The plan for editing the history in the graph. `from: None` = the commits of the checked-out
/// branch that are neither in the default branch nor in its upstream; `Some(sha)` = from that commit
/// (included) to HEAD. Refusals as `rebase_plan`.
pub async fn rebase_branch_plan(core: &Core, repo_id: String, from: Option<String>) -> CoreResult<RebasePlan> {
    if let Some(refusal) = refusal_before_base(core, &repo_id).await? {
        return Ok(refusal);
    }
    let refused = |reason, detail, message: &str| Ok(RebasePlan::Refused { reason, detail, message: message.to_string() });
    let base = match from {
        Some(from) => {
            let sha = rev::resolve_commit(core, &repo_id, &from).await?;
            match rev::rev_parse(core, &repo_id, &format!("{sha}^")).await? {
                Some(parent) => parent,
                None => {
                    return refused(
                        RebaseRefusal::NothingToRebase,
                        None,
                        "The first commit of the repository can't be the start of the edit.",
                    )
                }
            }
        }
        None => {
            let snapshot = refs::read_refs(core, &repo_id).await?;
            let default = branch_cleanup::default_branch(core, &repo_id, &snapshot.locals).await;
            let default = default.and_then(|name| snapshot.locals.into_iter().find(|r| r.name == name));
            // shortcut: an upstream that is a local branch (`branch.<b>.remote = .`) is looked for under refs/remotes and not found.
            let references: Vec<String> = default
                .iter()
                .flat_map(|branch| {
                    let own = (!branch.is_head).then(|| branch.full_name.clone());
                    let upstream = branch.upstream.as_ref().filter(|_| !branch.upstream_gone).map(|u| format!("refs/remotes/{u}"));
                    own.into_iter().chain(upstream)
                })
                .collect();
            if references.is_empty() {
                return refused(
                    RebaseRefusal::NothingToRebase,
                    None,
                    "There is no default branch or upstream to compare with. Use “Edit history from here” on an older commit.",
                );
            }
            let out = core.git_for(&repo_id)?.read().arg("merge-base").arg("HEAD").args(&references).run_raw().await?;
            let base = out.stdout_text();
            if !out.success() || !rev::is_sha(&base) {
                return refused(RebaseRefusal::NoCommonAncestor, Some(RebaseRefusalDetail::UnrelatedHistory), UNRELATED_HISTORY);
            }
            base
        }
    };
    rebase_plan(core, repo_id, base).await
}
