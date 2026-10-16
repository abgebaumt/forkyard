//! `repo_cleanup_run`: the steps in their fixed order – worktrees, undo backups and the reflog
//! first, so `git gc` can remove the objects they kept alive.

use std::time::Instant;

use crate::app::Core;
use crate::commands::{lfs, worktree};
use crate::db;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::jobs::Job;
use crate::model::{CleanupFailure, CleanupMode, CleanupOptions, CleanupResult, CleanupStep, CleanupStepResult, CleanupStepStatus, RepoChange};
use crate::util;

use super::measure;

/// The order of the steps (spec Paket 10, „Kern“).
pub(super) const ORDER: [CleanupStep; 5] = [CleanupStep::Worktrees, CleanupStep::Undo, CleanupStep::Reflog, CleanupStep::Lfs, CleanupStep::Gc];
/// Largest age the undo option accepts, in days.
pub(super) const MAX_UNDO_DAYS: u32 = 3650;
/// `job:progress.line` while the run waits for the locks.
pub(super) const WAITING: &str = "waiting";
/// Temporary refs that keep the objects of open undo entries alive during `git gc`.
pub(super) const KEEP_REF_PREFIX: &str = "refs/forkyard/keep/";

/// Refuses options the dialog never sends.
pub(super) fn check_options(options: &CleanupOptions) -> CoreResult<()> {
    match options.undo_older_than_days {
        Some(days) if !(1..=MAX_UNDO_DAYS).contains(&days) => {
            Err(CoreError::not_allowed(format!("Old undo backups: choose between 1 and {MAX_UNDO_DAYS} days.")))
        }
        _ => Ok(()),
    }
}

fn chosen(options: &CleanupOptions, step: CleanupStep) -> bool {
    match step {
        CleanupStep::Worktrees => options.worktrees,
        CleanupStep::Undo => options.undo_older_than_days.is_some(),
        CleanupStep::Reflog => options.reflog,
        CleanupStep::Lfs => options.lfs,
        CleanupStep::Gc => true,
    }
}

/// Key of a step in `job:progress.line`; the dialog shows its own words for it.
fn key(step: CleanupStep) -> &'static str {
    match step {
        CleanupStep::Worktrees => "worktrees",
        CleanupStep::Undo => "undo",
        CleanupStep::Reflog => "reflog",
        CleanupStep::Lfs => "lfs",
        CleanupStep::Gc => "gc",
    }
}

/// English text for the status bar (`job:progress.phase`), like Git's own phases there.
fn phase(step: CleanupStep) -> &'static str {
    match step {
        CleanupStep::Worktrees => "Removing orphaned worktrees",
        CleanupStep::Undo => "Removing old undo backups",
        CleanupStep::Reflog => "Shortening the reflog",
        CleanupStep::Lfs => "Git LFS clears its cache",
        CleanupStep::Gc => "Git packs objects",
    }
}

/// What a step did.
enum Ran {
    Done(Option<u64>),
    Skipped,
}

fn entry(step: CleanupStep, status: CleanupStepStatus, removed: Option<u64>) -> CleanupStepResult {
    CleanupStepResult { step, status, removed }
}

/// The run under the locks of the whole group. A cancel or a failed step ends it with `Ok`
/// (see `CleanupResult`); `Err` only before the first step.
pub(super) async fn run(core: &Core, repo_id: &str, job: &Job, options: &CleanupOptions) -> CoreResult<CleanupResult> {
    let worktrees = worktree::entries(core, repo_id).await?;
    let ids = super::sharing_ids(core, repo_id, &worktrees)?;
    job.progress("Waiting for other actions in this repository", None, WAITING);
    let _held = super::lock_all(core, &ids, job.token()).await?;
    let started = Instant::now();
    let common = measure::common_dir(core, repo_id).await?;
    // Keep refs of a run that was interrupted (crash, power loss) must not protect objects forever.
    delete_refs_under(core, repo_id, KEEP_REF_PREFIX).await?;
    let before = measure::count_objects(core, repo_id).await?;
    let lfs_dir = if options.lfs { Some(measure::lfs_objects_dir(core, repo_id, &common).await?) } else { None };
    let lfs_before = match &lfs_dir {
        Some(dir) => Some(measure::dir_size(dir.clone()).await),
        None => None,
    };
    let mut steps = Vec::with_capacity(ORDER.len());
    let mut cancelled = false;
    let mut failure: Option<CleanupFailure> = None;
    for step in ORDER {
        if !chosen(options, step) {
            steps.push(entry(step, CleanupStepStatus::Skipped, None));
            continue;
        }
        if cancelled || failure.is_some() {
            steps.push(entry(step, CleanupStepStatus::NotRun, None));
            continue;
        }
        if job.token().is_cancelled() {
            cancelled = true;
            steps.push(entry(step, CleanupStepStatus::NotRun, None));
            continue;
        }
        job.progress(phase(step), None, key(step));
        match run_step(core, repo_id, &ids, job, options, step).await {
            Ok(Ran::Done(removed)) => steps.push(entry(step, CleanupStepStatus::Done, removed)),
            Ok(Ran::Skipped) => steps.push(entry(step, CleanupStepStatus::Skipped, None)),
            Err(error) if error.code == ErrorCode::Cancelled => {
                cancelled = true;
                steps.push(entry(step, CleanupStepStatus::Cancelled, None));
            }
            Err(error) => {
                failure = Some(CleanupFailure { step, error, gc_pid: None, disk_full: false });
                steps.push(entry(step, CleanupStepStatus::Failed, None));
            }
        }
    }
    let after = measure::count_objects(core, repo_id).await.unwrap_or(before);
    let lfs_after = match lfs_dir {
        Some(dir) => Some(measure::dir_size(dir).await),
        None => None,
    };
    for id in &ids {
        core.emit_repo_changed(id, &[RepoChange::Refs]);
    }
    Ok(CleanupResult {
        before,
        after,
        lfs_before,
        lfs_after,
        steps,
        duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        cancelled,
        failure,
    })
}

async fn run_step(core: &Core, repo_id: &str, ids: &[String], job: &Job, options: &CleanupOptions, step: CleanupStep) -> CoreResult<Ran> {
    match step {
        CleanupStep::Worktrees => prune_worktrees(core, repo_id, job).await,
        CleanupStep::Undo => match options.undo_older_than_days {
            Some(days) => remove_undo_backups(core, repo_id, ids, days).await,
            None => Ok(Ran::Skipped),
        },
        CleanupStep::Reflog => trim_reflog(core, repo_id, job).await,
        CleanupStep::Lfs => prune_lfs(core, repo_id, job).await,
        CleanupStep::Gc => gc(core, repo_id, ids, job, options.mode).await,
    }
}

/// `git worktree prune`; reports how many orphaned entries went away.
async fn prune_worktrees(core: &Core, repo_id: &str, job: &Job) -> CoreResult<Ran> {
    let prunable = |list: &[worktree::WorktreeEntry]| list.iter().filter(|entry| entry.prunable).count();
    let before = prunable(&worktree::entries(core, repo_id).await?);
    core.git_for(repo_id)?.args(["worktree", "prune"]).run_stream(job.token(), &mut |_: &str| {}).await?;
    let after = prunable(&worktree::entries(core, repo_id).await?);
    Ok(Ran::Done(Some(before.saturating_sub(after) as u64)))
}

/// Removes undo backups older than `days` – their refs in one transaction, then their rows.
async fn remove_undo_backups(core: &Core, repo_id: &str, ids: &[String], days: u32) -> CoreResult<Ran> {
    let cutoff = util::iso_days_ago(i64::from(days));
    let old: Vec<measure::Backup> =
        measure::undo_backups(core, repo_id, ids).await?.into_iter().filter(|backup| measure::is_older(backup.created_at.as_deref(), &cutoff)).collect();
    let script: String = old.iter().flat_map(|backup| backup.refs.iter()).map(|name| format!("delete {name}\n")).collect();
    if !script.is_empty() {
        core.git_for(repo_id)?.args(["update-ref", "--stdin"]).stdin(script).run().await?;
    }
    core.db.tx(|tx| {
        for backup in &old {
            db::undo::delete(tx, &backup.entry_id)?;
        }
        Ok(())
    })?;
    Ok(Ran::Done(Some(old.len() as u64)))
}

/// Reflog entries older than 90 days for all refs and worktrees – reachable or not.
async fn trim_reflog(core: &Core, repo_id: &str, job: &Job) -> CoreResult<Ran> {
    let expire = format!("--expire={}.days.ago", measure::REFLOG_DAYS);
    let unreachable = format!("--expire-unreachable={}.days.ago", measure::REFLOG_DAYS);
    core.git_for(repo_id)?
        .args(["reflog", "expire"])
        .arg(&expire)
        .arg(&unreachable)
        .arg("--all")
        .run_stream(job.token(), &mut |_: &str| {})
        .await?;
    Ok(Ran::Done(None))
}

/// `git lfs prune`; skipped when Git LFS is not installed (the dialog hides the option then).
async fn prune_lfs(core: &Core, repo_id: &str, job: &Job) -> CoreResult<Ran> {
    if !lfs::lfs_status(core, repo_id.to_string()).await?.installed {
        return Ok(Ran::Skipped);
    }
    core.git_for(repo_id)?.args(["lfs", "prune"]).run_stream(job.token(), &mut |_: &str| {}).await?;
    Ok(Ran::Done(None))
}

/// `git gc`, or `git gc --aggressive --prune=now`; never `--force`. Meanwhile every object an open
/// undo entry names is held by a keep ref, so `--prune=now` cannot take the undo history of the
/// last 14 days. The keep refs go away afterwards, also after an error or a cancel.
async fn gc(core: &Core, repo_id: &str, ids: &[String], job: &Job, mode: CleanupMode) -> CoreResult<Ran> {
    keep_undo_objects(core, repo_id, ids).await?;
    let mut cmd = core.git_for(repo_id)?.arg("gc");
    if mode == CleanupMode::Thorough {
        cmd = cmd.args(["--aggressive", "--prune=now"]);
    }
    let ran = cmd.run_stream(job.token(), &mut |_: &str| {}).await;
    if let Err(error) = delete_refs_under(core, repo_id, KEEP_REF_PREFIX).await {
        log::warn!("keep refs not removed after gc (the next clean-up removes them): {}", error.message);
    }
    ran?;
    Ok(Ran::Done(None))
}

/// A full object ID (SHA-1 or SHA-256) rather than a ref name like `refs/heads/main`.
fn is_object_id(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Puts `refs/forkyard/keep/<sha>` on every existing object that `head_before`, `ref_before` or
/// `ref_after` of a remaining undo entry of the group names. Objects that are gone are skipped.
async fn keep_undo_objects(core: &Core, repo_id: &str, ids: &[String]) -> CoreResult<()> {
    let entries = measure::undo_entries(core, ids)?;
    let mut shas: Vec<&str> = entries
        .iter()
        .flat_map(|entry| [Some(entry.head_before.as_str()), entry.ref_before.as_deref(), entry.ref_after.as_deref()])
        .flatten()
        .filter(|value| is_object_id(value))
        .collect();
    shas.sort_unstable();
    shas.dedup();
    if shas.is_empty() {
        return Ok(());
    }
    let mut query = shas.join("\n");
    query.push('\n');
    let out = core
        .git_for(repo_id)?
        .args(["cat-file", "--batch-check=%(objectname) %(objecttype)"])
        .stdin(query)
        .read_only()
        .no_log()
        .run()
        .await?;
    let script: String = out
        .stdout_lines()
        .iter()
        .map(|line| util::decode_lossy(line))
        .filter_map(|line| {
            let (sha, kind) = line.split_once(' ')?;
            (kind != "missing" && is_object_id(sha)).then(|| format!("update {KEEP_REF_PREFIX}{sha} {sha}\n"))
        })
        .collect();
    if !script.is_empty() {
        core.git_for(repo_id)?.args(["update-ref", "--stdin"]).stdin(script).run().await?;
    }
    Ok(())
}

/// Deletes every ref below `prefix` in one transaction; returns how many.
async fn delete_refs_under(core: &Core, repo_id: &str, prefix: &str) -> CoreResult<usize> {
    let out = core.git_for(repo_id)?.args(["for-each-ref", "--format=%(refname)", prefix]).read_only().no_log().run().await?;
    let names: Vec<String> = out.stdout_lines().iter().map(|line| util::decode_lossy(line)).filter(|name| !name.is_empty()).collect();
    if names.is_empty() {
        return Ok(0);
    }
    let script: String = names.iter().map(|name| format!("delete {name}\n")).collect();
    core.git_for(repo_id)?.args(["update-ref", "--stdin"]).stdin(script).run().await?;
    Ok(names.len())
}

/// What `job:done` reports: a run that stopped at a failed step or was cancelled is not “ok”,
/// although the command returns its result.
pub(super) fn job_outcome(result: &CoreResult<CleanupResult>) -> CoreResult<()> {
    match result {
        Err(error) => Err(error.clone()),
        Ok(done) if done.cancelled => Err(CoreError::cancelled()),
        Ok(done) => match &done.failure {
            Some(failure) => Err(failure.error.clone()),
            None => Ok(()),
        },
    }
}
