//! “Stop agent and clean up”: end the program, back up branch tip and uncommitted changes, remove
//! the worktree, delete the branch – one group undo entry `agent_cleanup` in the main repository
//! (Paket 0's group undo moves the branch; `commands::undo::Run::agent_cleanup` recreates the
//! worktree and writes the changes back).

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};

use super::registry::{emit_changed, AgentRegistry};
use crate::app::Core;
use crate::commands::{refs, worktree};
use crate::db::{self, agents::AgentRow};
use crate::error::{CoreError, CoreResult};
use crate::model::{AgentCleanupPreview, RepoChange, UndoState};
use crate::undo::{self as u, GroupRecord, RefMove, UndoAction};
use crate::util;

/// How long cleaning up waits for a running program to end.
const STOP_WAIT: Duration = Duration::from_secs(10);
/// Name of the backup ref of the uncommitted changes.
pub(crate) const WORKTREE_BACKUP: &str = "agent-worktree";

/// The agent's fields the undo needs to bring its entry back (payload `agent`).
pub(crate) fn row_to_payload(row: &AgentRow) -> Value {
    json!({
        "id": row.id, "shortName": row.short_name, "templateId": row.template_id, "task": row.task,
        "branch": row.branch, "worktreePath": row.worktree_path, "base": row.base, "baseSha": row.base_sha,
        "unattended": row.unattended, "startedAt": row.started_at,
    })
}

/// Inverse of `row_to_payload`; the agent comes back as ended by the user.
pub(crate) fn row_from_payload(repo_id: &str, value: &Value) -> Option<AgentRow> {
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_string);
    Some(AgentRow {
        id: text("id")?,
        repo_id: repo_id.to_string(),
        short_name: text("shortName")?,
        template_id: text("templateId")?,
        task: text("task").unwrap_or_default(),
        branch: text("branch")?,
        worktree_path: text("worktreePath")?,
        base: text("base").unwrap_or_default(),
        base_sha: text("baseSha")?,
        unattended: value.get("unattended").and_then(Value::as_bool).unwrap_or(false),
        started_at: text("startedAt").unwrap_or_else(util::now_iso),
        ended_at: Some(util::now_iso()),
        exit_code: None,
        end_reason: Some(db::agents::EndReason::Stopped),
    })
}

async fn locked(core: &Core, repo_id: &str, folder: &Path) -> CoreResult<bool> {
    let list = worktree::worktree_list(core, repo_id.to_string()).await?;
    Ok(list.iter().any(|w| util::path_key(Path::new(&w.path)) == util::path_key(folder) && w.is_locked))
}

async fn changed(core: &Core, repo_id: &str, folder: &Path) -> u32 {
    if !folder.is_dir() {
        return 0;
    }
    super::changed_files(core, repo_id, folder).await
}

/// What cleaning up would destroy: commits of the branch on no remote branch and not in the base,
/// uncommitted files, whether the program still runs, whether the worktree is locked.
pub async fn preview(core: &Core, agent_id: String) -> CoreResult<AgentCleanupPreview> {
    let row = core.db.with(|c| db::agents::require(c, &agent_id))?;
    core.repo_path(&row.repo_id)?;
    let folder = PathBuf::from(&row.worktree_path);
    let branch_ref = format!("refs/heads/{}", row.branch);
    let unpushed = core
        .git_for(&row.repo_id)?
        .read_only()
        .no_log()
        .args(["rev-list", "--count", &branch_ref, "--not", &row.base_sha, "--remotes"])
        .run_raw()
        .await?;
    let unpushed_commits = if unpushed.success() { unpushed.stdout_text().trim().parse().unwrap_or(0) } else { 0 };
    let running = core.state::<AgentRegistry>().get(&row.id).is_some_and(|s| !s.snapshot().finished);
    Ok(AgentCleanupPreview {
        unpushed_commits,
        changed_files: changed(core, &row.repo_id, &folder).await,
        running,
        locked: folder.is_dir() && locked(core, &row.repo_id, &folder).await?,
    })
}

/// Ends the program and waits until the session is over.
async fn stop_and_wait(core: &Core, agent_id: &str) -> CoreResult<()> {
    let Some(session) = core.state::<AgentRegistry>().get(agent_id) else { return Ok(()) };
    if session.snapshot().finished {
        return Ok(());
    }
    crate::commands::terminal::terminal_close(core, session.terminal_id().to_string()).await?;
    let deadline = Instant::now() + STOP_WAIT;
    while !session.snapshot().finished {
        if Instant::now() > deadline {
            return Err(CoreError::timeout());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Ok(())
}

/// Backs up the worktree's uncommitted changes as a commit (parent: its HEAD) under the entry;
/// `None` without changes.
pub(crate) async fn back_up_changes(core: &Core, repo_id: &str, folder: &Path, entry_id: &str) -> CoreResult<Option<String>> {
    if changed(core, repo_id, folder).await == 0 {
        return Ok(None);
    }
    let worktree_row = core.db.with(|c| db::repos::find_by_path(c, folder))?.ok_or_else(|| CoreError::not_found("The agent's worktree is not registered."))?;
    let snap = u::snapshot(core, &worktree_row.id, None).await?;
    u::create_backup_ref(core, repo_id, entry_id, WORKTREE_BACKUP, &snap.commit).await?;
    Ok(Some(snap.commit))
}

/// Removes the worktree folder (forced: its changes are backed up) and its repository row and tabs.
/// Call within the main repository's write lock.
pub(crate) async fn remove_worktree(core: &Core, repo_id: &str, folder: &Path) -> CoreResult<()> {
    worktree::stop_watching(core, folder);
    if folder.exists() {
        core.git_for(repo_id)?.args(["worktree", "remove", "--force"]).arg(folder).run().await?;
    } else {
        core.git_for(repo_id)?.args(["worktree", "prune"]).run().await?;
    }
    worktree::forget_listed(core, folder);
    if let Some(entry) = core.db.with(|c| db::repos::find_by_path(c, folder))? {
        core.db.with(|c| db::repos::delete(c, &entry.id))?;
    }
    Ok(())
}

/// “Stop agent and clean up”. Returns the main repository's undo state.
pub async fn run(core: &Core, agent_id: String) -> CoreResult<UndoState> {
    let row = core.db.with(|c| db::agents::require(c, &agent_id))?;
    core.repo_path(&row.repo_id)?;
    let folder = PathBuf::from(&row.worktree_path);
    if folder.is_dir() && locked(core, &row.repo_id, &folder).await? {
        return Err(CoreError::not_allowed(format!("The worktree “{}” is locked. Unlock it first.", row.worktree_path)));
    }
    stop_and_wait(core, &row.id).await?;
    let repo_id = row.repo_id.clone();
    core.with_write_lock(&repo_id, &[RepoChange::Refs, RepoChange::Worktree], async {
        let entry_id = u::new_id();
        let branch_ref = format!("refs/heads/{}", row.branch);
        let tip = u::rev_parse(core, &repo_id, &branch_ref).await?;
        let snapshot = if folder.is_dir() { back_up_changes(core, &repo_id, &folder, &entry_id).await? } else { None };
        let head = refs::read_head(core, &repo_id).await?;
        remove_worktree(core, &repo_id, &folder).await?;
        if let Some(tip) = &tip {
            let delete = RefMove::new(&branch_ref, Some(tip.as_str()), None);
            u::apply_ref_moves(core, &repo_id, std::slice::from_ref(&delete), "forkyard: agent cleanup").await?;
            let mut extra = Map::new();
            extra.insert("agent".into(), row_to_payload(&row));
            extra.insert("agentWorktree".into(), json!({ "path": row.worktree_path, "snapshot": snapshot }));
            u::record_group(
                core,
                GroupRecord {
                    id: entry_id,
                    repo_id: repo_id.clone(),
                    action: UndoAction::AgentCleanup,
                    label: format!("Undo cleaning up the agent “{}”", row.short_name),
                    refs: vec![delete],
                    head_before: u::head_token(&head),
                    head_after: Some(u::head_token(&head)),
                    snapshot: None,
                    extra,
                },
            )
            .await?;
        }
        core.db.with(|c| db::agents::delete(c, &row.id))?;
        Ok(())
    })
    .await?;
    core.state::<AgentRegistry>().remove(&row.id);
    let _ = std::fs::remove_dir_all(core.data_dir().join("agents").join(&row.id));
    emit_changed(core, &repo_id);
    crate::commands::undo::undo_peek(core, repo_id).await
}
