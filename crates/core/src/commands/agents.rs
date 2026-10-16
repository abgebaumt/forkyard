//! Coding agents (cockpit, package 2a): templates, start in an own worktree, status, lifecycle,
//! cleanup. The cockpit needs no AI provider. Branch and worktree are Git's; the `agents` table
//! only keeps metadata, and the running session (terminal, status) lives in memory.

pub mod names;
pub mod templates;
#[cfg(test)]
mod tests;

use crate::app::Core;
use crate::commands::{graph, worktree};
use crate::db;
use crate::error::{CoreError, CoreResult};
use crate::model::AgentSuggestion;
use crate::util;

/// Agent configurations a CLI loads from its working directory; the repository trust check does
/// not know them, so the start dialog lists them.
pub(crate) const CONFIG_NAMES: [&str; 3] = [".claude", ".codex", "opencode.json"];

/// Which of `CONFIG_NAMES` the commit has (folders with a trailing `/`), in the order of `CONFIG_NAMES`.
async fn agent_configs(core: &Core, repo_id: &str, sha: &str) -> CoreResult<Vec<String>> {
    let out = core.git_for(repo_id)?.read_only().no_log().args(["ls-tree", "-z", sha, "--"]).args(CONFIG_NAMES).run().await?;
    let mut found: Vec<String> = Vec::new();
    for entry in util::split_z(&out.stdout) {
        // "<mode> <type> <object>\t<path>"
        let Some(tab) = entry.iter().position(|&b| b == b'\t') else { continue };
        let is_tree = entry[..tab].split(|&b| b == b' ').nth(1) == Some(&b"tree"[..]);
        let name = util::decode_lossy(&entry[tab + 1..]);
        found.push(if is_tree { format!("{name}/") } else { name });
    }
    found.sort_by_key(|name| CONFIG_NAMES.iter().position(|c| name.trim_end_matches('/') == *c));
    Ok(found)
}

/// Defaults for the start dialog and the live check of an edited branch. `branch: None` proposes
/// `agent/<short name from the task>` with the first suffix for which folder, branch and agent
/// name are all free; with a branch, only the folder gets a suffix and `branch_problem` says what
/// is wrong with it. `base`: default HEAD.
pub async fn agent_suggest(core: &Core, repo_id: String, task: String, branch: Option<String>, base: Option<String>) -> CoreResult<AgentSuggestion> {
    let main = worktree::main_worktree_path(core, &repo_id).await?;
    let dir = names::agents_dir(&main)?;
    let base = base.as_deref().map(str::trim).filter(|b| !b.is_empty()).unwrap_or("HEAD").to_string();
    let base_sha = graph::resolve_commit(core, &repo_id, &base).await?;
    let rows = core.db.with(|c| db::agents::list_for_repo(c, &repo_id))?;
    let taken = |name: &str| rows.iter().any(|row| row.short_name == name);
    let wanted = branch.as_deref().map(str::trim).filter(|b| !b.is_empty()).map(str::to_string);
    let (short_name, branch) = match wanted {
        Some(branch) => (names::free_name(&dir, &names::short_name_for_branch(&branch), &taken)?, branch),
        None => {
            let mut chosen = None;
            for candidate in names::candidates(&names::short_name_from_task(&task)) {
                if dir.join(&candidate).exists() || taken(&candidate) {
                    continue;
                }
                if worktree::local_branch_exists(core, &repo_id, &format!("{}{candidate}", names::BRANCH_PREFIX)).await? {
                    continue;
                }
                chosen = Some(candidate);
                break;
            }
            let short = chosen.ok_or_else(|| CoreError::name_exists("Every name for this task is taken. Type a branch name."))?;
            let branch = format!("{}{short}", names::BRANCH_PREFIX);
            (short, branch)
        }
    };
    let branch_problem = match util::check_ref_name(&branch) {
        Err(reason) => Some(reason),
        Ok(()) if worktree::local_branch_exists(core, &repo_id, &branch).await? => Some(format!("A branch “{branch}” already exists.")),
        Ok(()) => None,
    };
    let configs = agent_configs(core, &repo_id, &base_sha).await?;
    let running = rows.iter().filter(|row| row.ended_at.is_none()).count() as u32;
    let path = util::display_path(&dir.join(&short_name));
    Ok(AgentSuggestion { short_name, branch, branch_problem, path, base_sha, configs, running })
}
