//! Local workspaces: named groups of repositories from the repository list, and fetch or
//! pull across all their repositories in one job.
//!
//! A run processes the repositories one after another. If one fails (folder missing, no
//! network, conflict), the rest continue; the result says per repository what happened.
//! Progress: `job:progress` under the run's jobId, with the `repoId` of the repository whose
//! turn it is – `phase: "start"` at the beginning, then Git's phases, and at the end the
//! status (`done`, `up_to_date`, `conflict`, `failed`, `skipped`) with the finished sentence.

use crate::app::Core;
use crate::commands::sync;
use crate::db;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::jobs::Job;
use crate::model::{AppChange, OpResult, PullMode, Workspace, WorkspaceRepoResult, WorkspaceRepoStatus, WorkspaceRunResult};

const MAX_NAME_CHARS: usize = 80;

pub async fn workspace_list(core: &Core) -> CoreResult<Vec<Workspace>> {
    core.db.with(|c| {
        let profile_id = db::profiles::active_id(c)?;
        db::workspaces::list(c, &profile_id)
    })
}

/// Creates a workspace (`id: None`) or replaces the name and repositories of an existing one.
/// `repo_ids` in the desired order; duplicates count once. Errors: `invalid_name`
/// (empty, too long), `name_exists`, `not_found` (unknown workspace or repository).
pub async fn workspace_save(core: &Core, id: Option<String>, name: String, repo_ids: Vec<String>) -> CoreResult<Vec<Workspace>> {
    let name = name.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err(CoreError::invalid_name("The workspace needs a name."));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(CoreError::invalid_name(format!("The name is too long (at most {MAX_NAME_CHARS} characters).")));
    }
    let mut unique: Vec<String> = Vec::new();
    for repo_id in repo_ids {
        if !repo_id.trim().is_empty() && !unique.contains(&repo_id) {
            unique.push(repo_id);
        }
    }
    let id = id.filter(|id| !id.trim().is_empty());
    let list = core.db.tx(|tx| {
        let profile_id = db::profiles::active_id(tx)?;
        db::workspaces::save(tx, &profile_id, id.as_deref(), &name, &unique)?;
        db::workspaces::list(tx, &profile_id)
    })?;
    core.emit_app_changed(&[AppChange::Workspaces]);
    Ok(list)
}

/// Deletes the workspace (the repositories stay in the list and on disk).
pub async fn workspace_delete(core: &Core, id: String) -> CoreResult<Vec<Workspace>> {
    let list = core.db.tx(|tx| {
        let profile_id = db::profiles::active_id(tx)?;
        if !db::workspaces::delete(tx, &profile_id, &id)? {
            return Err(CoreError::not_found("This workspace does not exist (anymore)."));
        }
        db::workspaces::list(tx, &profile_id)
    })?;
    core.emit_app_changed(&[AppChange::Workspaces]);
    Ok(list)
}

/// Fetches all remotes in every repository of the workspace (with prune per `settings.autoPrune`).
pub async fn workspace_fetch(core: &Core, job_id: String, workspace_id: String) -> CoreResult<WorkspaceRunResult> {
    run(core, &job_id, &workspace_id, Action::Fetch).await
}

/// Pulls in every repository of the workspace; `mode: None` uses each repository's default.
pub async fn workspace_pull(core: &Core, job_id: String, workspace_id: String, mode: Option<PullMode>) -> CoreResult<WorkspaceRunResult> {
    run(core, &job_id, &workspace_id, Action::Pull(mode)).await
}

#[derive(Clone, Copy)]
enum Action {
    Fetch,
    Pull(Option<PullMode>),
}

async fn run(core: &Core, job_id: &str, workspace_id: &str, action: Action) -> CoreResult<WorkspaceRunResult> {
    let workspace = core
        .db
        .with(|c| {
            let profile_id = db::profiles::active_id(c)?;
            db::workspaces::get(c, &profile_id, workspace_id)
        })?
        .ok_or_else(|| CoreError::not_found("This workspace does not exist (anymore)."))?;
    let job = core.start_job(job_id, None)?;
    let result = run_all(core, &job, &workspace, action).await;
    job.finish(&result);
    result
}

async fn run_all(core: &Core, job: &Job, workspace: &Workspace, action: Action) -> CoreResult<WorkspaceRunResult> {
    let prune = core.settings()?.auto_prune;
    let total = workspace.repo_ids.len();
    let mut results = Vec::with_capacity(total);
    for (index, repo_id) in workspace.repo_ids.iter().enumerate() {
        // Cancelling ends the whole run; whatever is already finished was reported by the progress events.
        job.token().check()?;
        let name = core.repo_row(repo_id).map(|row| row.title()).unwrap_or_else(|_| repo_id.clone());
        let scoped = job.scoped(repo_id);
        let verb = match action {
            Action::Fetch => "Fetch",
            Action::Pull(_) => "Pull",
        };
        scoped.progress("start", Some((index * 100 / total.max(1)) as u32), &format!("{verb} in {name} ({} of {total}) …", index + 1));
        let outcome = match action {
            Action::Fetch => sync::fetch_with_job(core, repo_id, &scoped, None, prune).await.map(|fetched| {
                if let Some(first) = fetched.failed.first() {
                    let message = match fetched.failed.len() {
                        1 => format!("Fetch from “{}” failed: {}", first.remote, first.message),
                        n => format!("Fetch from {n} remotes failed, first “{}”: {}", first.remote, first.message),
                    };
                    (WorkspaceRepoStatus::Failed, message, None)
                } else if fetched.updated_refs + fetched.pruned_refs == 0 {
                    (WorkspaceRepoStatus::UpToDate, "Nothing new on the remotes".to_string(), None)
                } else {
                    let mut parts = Vec::new();
                    if fetched.updated_refs > 0 {
                        parts.push(format!("{} updated", counted(fetched.updated_refs, "ref", "refs")));
                    }
                    if fetched.pruned_refs > 0 {
                        parts.push(format!("{} pruned", counted(fetched.pruned_refs, "ref", "refs")));
                    }
                    (WorkspaceRepoStatus::Done, parts.join(", "), None)
                }
            }),
            Action::Pull(mode) => sync::pull_with_job(core, repo_id, &scoped, mode).await.map(|pulled| match pulled {
                OpResult::Done { summary, .. } => (WorkspaceRepoStatus::Done, summary, None),
                OpResult::UpToDate => (WorkspaceRepoStatus::UpToDate, "Already up to date".to_string(), None),
                OpResult::Conflict { files, .. } => (
                    WorkspaceRepoStatus::Conflict,
                    format!("Conflicts in {} – resolve them in the repository", counted(files.len() as u32, "file", "files")),
                    Some(ErrorCode::Conflict),
                ),
            }),
        };
        let (status, message, code) = match outcome {
            Ok(done) => done,
            Err(e) if e.code == ErrorCode::Cancelled => return Err(e),
            // Nothing to fetch is not a failure: no remote, no upstream, no branch checked out.
            Err(e) if matches!(e.code, ErrorCode::NoRemote | ErrorCode::NoUpstream) => (WorkspaceRepoStatus::Skipped, e.message, Some(e.code)),
            Err(e) => (WorkspaceRepoStatus::Failed, e.message, Some(e.code)),
        };
        scoped.progress(status.as_str(), Some(100), &message);
        results.push(WorkspaceRepoResult { repo_id: repo_id.clone(), name, status, message, code });
    }
    let failed = results.iter().filter(|r| matches!(r.status, WorkspaceRepoStatus::Failed | WorkspaceRepoStatus::Conflict)).count() as u32;
    Ok(WorkspaceRunResult { results, failed })
}

fn counted(n: u32, one: &str, many: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {many}")
    }
}

#[cfg(test)]
#[path = "workspace_tests.rs"]
mod tests;
