//! Repository clean-up: what takes space, and freeing it on request (`git gc` and friends).
//!
//! Nothing here runs on its own (spec Paket 10: no automatism, no AI). The preview only reads
//! (`GIT_OPTIONAL_LOCKS=0`). The run is a cancellable job under the network lock and then the
//! write lock of the repository and of every listed worktree that shares its Git directory, so no
//! fetch, commit or agent clean-up from Forkyard writes objects meanwhile. It never passes
//! `--force` to `git gc` and never deletes a lock file.

use std::collections::HashSet;
use std::path::Path;

use crate::app::{Core, WriteGuard};
use crate::commands::worktree::{self, WorktreeEntry};
use crate::db;
use crate::error::{CoreError, CoreResult};
use crate::jobs::CancelToken;
use crate::model::{CleanupLfsEstimate, CleanupOptions, CleanupPreview, CleanupResult, CleanupUndoBackup};
use crate::util;

mod disk;
mod measure;
mod run;

#[cfg(test)]
mod measure_tests;
#[cfg(test)]
mod preview_tests;
#[cfg(test)]
mod run_tests;
#[cfg(test)]
mod test_support;

/// The repository and every listed repository (any profile) that is one of its worktrees, sorted
/// by ID – the order in which a run takes the locks, so two runs never wait on each other crosswise.
fn sharing_ids(core: &Core, repo_id: &str, worktrees: &[WorktreeEntry]) -> CoreResult<Vec<String>> {
    let keys: HashSet<String> = worktrees.iter().map(|entry| util::path_key(&entry.path)).collect();
    let mut ids: Vec<String> = core
        .db
        .with(db::repos::list_all)?
        .into_iter()
        .filter(|row| row.id == repo_id || keys.contains(&util::path_key(Path::new(&row.path))))
        .map(|row| row.id)
        .collect();
    ids.push(repo_id.to_string());
    ids.sort();
    ids.dedup();
    Ok(ids)
}

/// What takes space now (spec „Jetzt“): `git count-objects -v`, LFS cache, undo backups, orphaned
/// and linked worktrees, reflog entries older than 90 days (2 s budget), free space. Only reads.
pub async fn repo_cleanup_preview(core: &Core, repo_id: String) -> CoreResult<CleanupPreview> {
    let repo_id = repo_id.as_str();
    let common = measure::common_dir(core, repo_id).await?;
    let objects = measure::count_objects(core, repo_id).await?;
    let worktrees = worktree::entries(core, repo_id).await?;
    let ids = sharing_ids(core, repo_id, &worktrees)?;
    let undo_backups = measure::undo_backups(core, repo_id, &ids)
        .await?
        .into_iter()
        .map(|backup| CleanupUndoBackup { entry_id: backup.entry_id, created_at: backup.created_at, orphaned: backup.orphaned })
        .collect();
    Ok(CleanupPreview {
        objects,
        lfs_bytes: measure::lfs_cache(core, repo_id, &common).await?,
        undo_backups,
        orphaned_worktrees: worktrees.iter().filter(|entry| entry.prunable).count() as u32,
        linked_worktrees: worktrees.iter().filter(|entry| !entry.is_main && !entry.prunable).count() as u32,
        old_reflog_entries: measure::count_old_reflog(core, repo_id, &common, measure::REFLOG_BUDGET).await?,
        free_bytes: disk::free_bytes(&common),
    })
}

/// What `git lfs prune` would free (`git lfs prune --dry-run`). `unsupported` without Git LFS.
pub async fn repo_cleanup_lfs_estimate(core: &Core, repo_id: String) -> CoreResult<CleanupLfsEstimate> {
    measure::lfs_estimate(core, &repo_id).await
}

/// The locks of a run: first every network lock, then every write lock, in id order (the order
/// documented in `app.rs`). Dropped together at the end of the run.
struct Held {
    _write: Vec<WriteGuard>,
    _network: Vec<WriteGuard>,
}

/// Takes the locks of all `ids`; each wait can be cancelled.
async fn lock_all(core: &Core, ids: &[String], cancel: &CancelToken) -> CoreResult<Held> {
    let mut network = Vec::with_capacity(ids.len());
    for id in ids {
        tokio::select! {
            guard = core.network_lock(id) => network.push(guard),
            _ = cancel.cancelled() => return Err(CoreError::cancelled()),
        }
    }
    let mut write = Vec::with_capacity(ids.len());
    for id in ids {
        tokio::select! {
            guard = core.write_lock(id) => write.push(guard),
            _ = cancel.cancelled() => return Err(CoreError::cancelled()),
        }
    }
    Ok(Held { _write: write, _network: network })
}

/// Cleans up as job `job_id` (`job:progress`, `job:done`, cancellable with `job_cancel`): checks
/// trust and options, waits for the locks of the repository and all its listed worktrees, then runs
/// the chosen steps in order – worktrees, undo backups, reflog, LFS, `git gc` – and reports
/// `repo:changed` (refs). The result also describes a cancelled or failed run.
pub async fn repo_cleanup_run(core: &Core, repo_id: String, job_id: String, options: CleanupOptions) -> CoreResult<CleanupResult> {
    core.repo_path(&repo_id)?;
    run::check_options(&options)?;
    let job = core.start_job(&job_id, Some(&repo_id))?;
    let result = run::run(core, &repo_id, &job, &options).await;
    job.finish(&run::job_outcome(&result));
    result
}
