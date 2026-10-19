//! Fetch, pull, push and cancelling jobs.
//!
//! Every command registers as a job (`job:progress`, `job:done`, cancellable via
//! `job_cancel`). Network calls run with `.network()` (time limits, prompts for
//! credentials).
//!
//! Locks: the transfer itself runs under the repository's network lock
//! (`Core::network_lock`, one transfer at a time), NOT under the write lock – a
//! long fetch or push doesn't block a commit. The write lock only applies to the
//! part that changes something locally: for pull the integration (merge, rebase), for push
//! recording the upstream. Even waiting for one of the locks can be cancelled.
//!
//! For other parts of the core:
//! - `fetch_remotes`: fetch without job registration, without a lock and without an event.
//! - `fetch_background`: without prompts, for background calls.
//! - `branch_upstream`: upstream of a branch from the configuration.
//! - `push` takes its locks itself: never call it while holding the write lock.

use std::collections::HashMap;
use std::future::Future;
use std::path::PathBuf;

use serde_json::json;

use crate::app::Core;
use crate::commands::commit::{hook_failure, Hooks};
use crate::commands::remotes::{self, head_marker};
use crate::commands::{refs, status};
use crate::commands::submodule::auto;
use crate::db;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::{errors, GitCmd};
use crate::jobs::{CancelToken, Job};
use crate::model::{FetchFailure, FetchResult, Head, OpResult, PullMode, PushExtra, PushRefResult, PushRefStatus, PushResult, RepoChange};
use crate::secret_scan;
use crate::undo::{self, UndoAction, UndoRecord};
use crate::util;

/// What a pull can change.
const PULL_CHANGES: [RepoChange; 5] =
    [RepoChange::Refs, RepoChange::Head, RepoChange::Worktree, RepoChange::Index, RepoChange::Operation];

fn no_remote() -> CoreError {
    CoreError::new(ErrorCode::NoRemote, "This repository has no remote set up.")
}

fn no_upstream(branch: &str) -> CoreError {
    CoreError::new(ErrorCode::NoUpstream, format!("The branch “{branch}” has no upstream."))
}

fn missing_remote(name: &str) -> CoreError {
    CoreError::not_found(format!("The remote “{name}” does not exist (anymore)."))
}

fn commits(n: u32) -> String {
    if n == 1 {
        "1 commit".into()
    } else {
        format!("{n} commits")
    }
}

/// Like `Core::with_write_lock`, except that even waiting for the lock can be cancelled.
/// Callers report `repo:changed` themselves, because it depends on the result.
async fn with_lock_cancellable<T, F>(core: &Core, repo_id: &str, cancel: &CancelToken, action: F) -> CoreResult<T>
where
    F: Future<Output = CoreResult<T>>,
{
    let guard = tokio::select! {
        guard = core.write_lock(repo_id) => guard,
        _ = cancel.cancelled() => return Err(CoreError::cancelled()),
    };
    let result = action.await;
    drop(guard);
    result
}

/// Like `with_lock_cancellable`, for the network lock: one transfer per repository at a time.
pub(crate) async fn with_network_lock<T, F>(core: &Core, repo_id: &str, cancel: &CancelToken, action: F) -> CoreResult<T>
where
    F: Future<Output = CoreResult<T>>,
{
    let guard = tokio::select! {
        guard = core.network_lock(repo_id) => guard,
        _ = cancel.cancelled() => return Err(CoreError::cancelled()),
    };
    let result = action.await;
    drop(guard);
    result
}

/// Small read call without a log entry.
fn probe(core: &Core, repo_id: &str) -> CoreResult<GitCmd> {
    Ok(core.git_for(repo_id)?.read_only().no_log())
}

/// Value from the Git configuration; `None` if not set or empty.
async fn config_get(core: &Core, repo_id: &str, key: &str) -> CoreResult<Option<String>> {
    let out = probe(core, repo_id)?.args(["config", "--get", key]).run_raw().await?;
    Ok(if out.success() { util::non_empty(Some(out.stdout_text())) } else { None })
}

/// SHA of the commit `rev` points to; `None` if it doesn't exist.
async fn resolve_commit(core: &Core, repo_id: &str, rev: &str) -> CoreResult<Option<String>> {
    let spec = format!("{rev}^{{commit}}");
    let out = probe(core, repo_id)?.args(["rev-parse", "--verify", "--quiet", &spec]).run_raw().await?;
    Ok(if out.success() { util::non_empty(Some(out.stdout_text())) } else { None })
}

/// Upstream of a local branch from the configuration: (remote name, ref on the
/// remote like `refs/heads/main`). The remote name "." stands for a local upstream.
pub async fn branch_upstream(core: &Core, repo_id: &str, branch: &str) -> CoreResult<Option<(String, String)>> {
    let remote = config_get(core, repo_id, &format!("branch.{branch}.remote")).await?;
    let merge = config_get(core, repo_id, &format!("branch.{branch}.merge")).await?;
    Ok(remote.zip(merge))
}

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------

/// State of all remote branches and tags (without symbolic refs like `origin/HEAD`).
async fn remote_ref_snapshot(core: &Core, repo_id: &str) -> CoreResult<HashMap<String, String>> {
    let out = probe(core, repo_id)?
        .args(["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)", "refs/remotes", "refs/tags"])
        .run()
        .await?;
    let mut map = HashMap::new();
    for line in out.stdout_lines() {
        let mut parts = line.split(|&b| b == 0);
        let (Some(name), Some(sha), symref) = (parts.next(), parts.next(), parts.next()) else { continue };
        if symref.is_some_and(|s| !s.is_empty()) {
            continue;
        }
        map.insert(util::decode_lossy(name), util::decode_lossy(sha));
    }
    Ok(map)
}

/// Fetch of one or all remotes, each remote separately. Takes no lock and reports
/// no `repo:changed`; `job` receives the progress, `interactive: false` prevents
/// prompts for credentials (`GitCmd::no_prompt`).
///
/// An explicitly named remote that fails yields the error itself. For "all",
/// a failed remote ends up in `failed`, the others are fetched anyway.
pub async fn fetch_remotes(
    core: &Core,
    repo_id: &str,
    cancel: &CancelToken,
    job: Option<&Job>,
    remote: Option<&str>,
    prune: bool,
    interactive: bool,
) -> CoreResult<FetchResult> {
    let known = remotes::read_remotes(core, repo_id).await?;
    if known.is_empty() {
        return Err(no_remote());
    }
    let targets: Vec<String> = match remote {
        Some(name) => {
            if !known.iter().any(|r| r.name == name) {
                return Err(missing_remote(name));
            }
            vec![name.to_string()]
        }
        None => known.iter().filter(|r| !r.fetch_url.is_empty()).map(|r| r.name.clone()).collect(),
    };
    let before = remote_ref_snapshot(core, repo_id).await?;
    let mut failed = Vec::new();
    for name in &targets {
        cancel.check()?;
        if let Some(job) = job {
            job.progress(&format!("Fetch {name}"), None, &format!("Fetching from {name} …"));
        }
        let mut cmd = core.git_for(repo_id)?.args(["fetch", "--progress"]);
        if prune {
            cmd = cmd.arg("--prune");
        }
        cmd = cmd.arg("--").arg(name);
        let cmd = if interactive { cmd.network() } else { cmd.network().no_prompt().read_only() };
        let result = cmd
            .run_stream(cancel, &mut |line| {
                if let Some(job) = job {
                    job.progress_line(line);
                }
            })
            .await;
        match result {
            Ok(_) => {}
            Err(e) if e.code == ErrorCode::Cancelled || remote.is_some() => return Err(e),
            Err(e) => failed.push(FetchFailure { remote: name.clone(), message: e.message }),
        }
    }
    let after = remote_ref_snapshot(core, repo_id).await?;
    let updated = after.iter().filter(|(name, sha)| before.get(*name) != Some(*sha)).count();
    let pruned = before.keys().filter(|name| name.starts_with("refs/remotes/") && !after.contains_key(*name)).count();
    Ok(FetchResult { updated_refs: updated as u32, pruned_refs: pruned as u32, failed })
}

/// Fetch of one or all remotes (`remote: None`), optionally with prune.
pub async fn fetch(core: &Core, repo_id: String, job_id: String, remote: Option<String>, prune: bool) -> CoreResult<FetchResult> {
    let job = core.start_job(&job_id, Some(&repo_id))?;
    let remote = util::non_empty(remote);
    let result = fetch_with_job(core, &repo_id, &job, remote.as_deref(), prune).await;
    job.finish(&result);
    result
}

/// The fetch of `fetch` under an already running job (also for runs across several
/// repositories): network lock, progress to `job`, `repo:changed` on changes.
pub(crate) async fn fetch_with_job(core: &Core, repo_id: &str, job: &Job, remote: Option<&str>, prune: bool) -> CoreResult<FetchResult> {
    // Only the network lock: a long fetch doesn't block any of the user's write actions.
    let result = with_network_lock(core, repo_id, job.token(), fetch_remotes(core, repo_id, job.token(), Some(job), remote, prune, true)).await;
    // Only report if something has changed (or could have after an error).
    let unchanged = matches!(&result, Ok(r) if r.updated_refs == 0 && r.pruned_refs == 0);
    let never_started = matches!(&result, Err(e) if matches!(e.code, ErrorCode::NoRemote | ErrorCode::NotFound | ErrorCode::PathNotFound));
    if !unchanged && !never_started {
        core.emit_repo_changed(repo_id, &[RepoChange::Refs]);
    }
    if result.is_ok() {
        crate::commands::lfs::locks_after_fetch(core, repo_id);
    }
    result
}

/// For background calls: fetch all remotes, without a job, without prompts and without a lock
/// (so it never blocks a user action). Reports `repo:changed` with `refs` if
/// something has changed. The timed auto-fetch lives in `crate::autofetch`.
pub async fn fetch_background(core: &Core, repo_id: &str, prune: bool, cancel: &CancelToken) -> CoreResult<FetchResult> {
    let result = fetch_remotes(core, repo_id, cancel, None, None, prune, false).await?;
    if result.updated_refs > 0 || result.pruned_refs > 0 {
        core.emit_repo_changed(repo_id, &[RepoChange::Refs]);
    }
    crate::commands::lfs::locks_after_fetch(core, repo_id);
    Ok(result)
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

/// Default for the pull mode: the repository's setting, otherwise the global one.
pub fn default_pull_mode(core: &Core, repo_id: &str) -> CoreResult<PullMode> {
    let stored = core.db.with(|c| db::repo_settings::get_all(c, repo_id))?;
    for (key, value) in stored {
        if key == "defaultPullMode" {
            if let Ok(Some(mode)) = serde_json::from_value::<Option<PullMode>>(value) {
                return Ok(mode);
            }
        }
    }
    Ok(core.settings()?.default_pull_mode)
}

fn pull_mode_key(mode: PullMode) -> &'static str {
    match mode {
        PullMode::Ff => "ff",
        PullMode::FfOnly => "ff_only",
        PullMode::Rebase => "rebase",
    }
}

/// Pull; `mode: None` takes the default from the settings.
pub async fn pull(core: &Core, repo_id: String, job_id: String, mode: Option<PullMode>) -> CoreResult<OpResult> {
    let job = core.start_job(&job_id, Some(&repo_id))?;
    let result = auto::follow(core, &repo_id, pull_with_job(core, &repo_id, &job, mode)).await;
    job.finish(&result);
    result
}

/// The pull of `pull` under an already running job (also for runs across several
/// repositories): locks, progress to `job`, `repo:changed` matching the result.
pub(crate) async fn pull_with_job(core: &Core, repo_id: &str, job: &Job, mode: Option<PullMode>) -> CoreResult<OpResult> {
    let mut fetched = false;
    let result = async {
        let mode = match mode {
            Some(mode) => mode,
            None => default_pull_mode(core, repo_id)?,
        };
        // Fetch first (network lock), then integrate (write lock).
        let plan = with_network_lock(core, repo_id, job.token(), pull_fetch(core, repo_id, job, &mut fetched)).await?;
        with_lock_cancellable(core, repo_id, job.token(), pull_integrate(core, repo_id, job, mode, plan)).await
    }
    .await;
    match &result {
        Ok(OpResult::UpToDate) => core.emit_repo_changed(repo_id, &[RepoChange::Refs]),
        Ok(_) => core.emit_repo_changed(repo_id, &PULL_CHANGES),
        // After the fetch the remote branches may have changed, even if the rest fails.
        Err(_) if fetched => core.emit_repo_changed(repo_id, &PULL_CHANGES),
        Err(_) => {}
    }
    if fetched {
        crate::commands::lfs::locks_after_fetch(core, repo_id);
    }
    result
}

/// What the first part of the pull (fetch) records for the second (integration).
struct PullPlan {
    branch: String,
    remote: String,
    merge_ref: String,
}

fn operation_running() -> CoreError {
    CoreError::new(
        ErrorCode::OperationInProgress,
        "A merge, rebase, cherry-pick or revert is already in progress. Finish or abort it first.",
    )
}

/// The checked-out branch and its commit (`None` without a commit); a detached HEAD is an error.
fn pull_branch(head: &Head) -> CoreResult<(String, Option<String>)> {
    match head {
        Head::Branch { branch, sha } => Ok((branch.clone(), Some(sha.clone()))),
        Head::Unborn { branch } => Ok((branch.clone(), None)),
        Head::Detached { .. } => Err(CoreError::not_allowed("HEAD is detached. To pull, a branch must be checked out.")),
    }
}

/// First part of the pull: check the preconditions and fetch from the upstream remote. Runs
/// under the network lock, without the write lock.
async fn pull_fetch(core: &Core, repo_id: &str, job: &Job, fetched: &mut bool) -> CoreResult<PullPlan> {
    let cancel = job.token();
    if status::read_operation(core, repo_id).await?.is_some() {
        return Err(operation_running());
    }
    let head = refs::read_head(core, repo_id).await?;
    let (branch, _) = pull_branch(&head)?;
    let known = remotes::read_remotes(core, repo_id).await?;
    if known.is_empty() {
        return Err(no_remote());
    }
    let Some((remote, merge_ref)) = branch_upstream(core, repo_id, &branch).await? else {
        return Err(no_upstream(&branch));
    };
    let local_upstream = remote == ".";
    if !local_upstream {
        if !known.iter().any(|r| r.name == remote) {
            return Err(CoreError::not_found(format!(
                "The upstream of “{branch}” is on the remote “{remote}”, which does not exist (anymore)."
            )));
        }
        job.progress("Fetch", None, &format!("Fetching from {remote} …"));
        *fetched = true;
        core.git_for(repo_id)?
            .args(["fetch", "--progress", "--", &remote])
            .network()
            .run_stream(cancel, &mut |line| job.progress_line(line))
            .await?;
        cancel.check()?;
    }
    Ok(PullPlan { branch, remote, merge_ref })
}

/// Second part of the pull: integrate the fetched state (fast-forward, merge or
/// rebase). Runs under the write lock; whatever may have changed since the fetch
/// is read again.
async fn pull_integrate(core: &Core, repo_id: &str, job: &Job, mode: PullMode, plan: PullPlan) -> CoreResult<OpResult> {
    if status::read_operation(core, repo_id).await?.is_some() {
        return Err(operation_running());
    }
    let head = refs::read_head(core, repo_id).await?;
    let (branch, old_sha) = pull_branch(&head)?;
    if branch != plan.branch {
        return Err(CoreError::new(
            ErrorCode::StaleState,
            format!("The branch was switched from “{}” to “{branch}” during the fetch, so the pull was not applied. Please pull again.", plan.branch),
        ));
    }
    let PullPlan { remote, merge_ref, .. } = plan;
    let local_upstream = remote == ".";

    // The remote branch as it is called locally (refs/remotes/origin/main).
    let tracking = if local_upstream {
        merge_ref.clone()
    } else {
        let spec = format!("{branch}@{{upstream}}");
        let out = probe(core, repo_id)?.args(["rev-parse", "--symbolic-full-name", "--verify", "--quiet", &spec]).run_raw().await?;
        match util::non_empty(Some(out.stdout_text())).filter(|_| out.success()) {
            Some(name) => name,
            None => format!("refs/remotes/{remote}/{}", merge_ref.strip_prefix("refs/heads/").unwrap_or(&merge_ref)),
        }
    };
    let upstream_name = refs::short_ref_name(&tracking).to_string();
    // The name `git merge` gets ends up verbatim in the merge commit's message ("Merge
    // remote-tracking branch '…'"). The short name reads as with a manual `git pull` – but only
    // if it unambiguously means the remote branch (no tag or local branch of the same name).
    let merge_arg = {
        let resolved = probe(core, repo_id)?.args(["rev-parse", "--symbolic-full-name", "--verify", "--quiet", &upstream_name]).run_raw().await?;
        if resolved.success() && resolved.stdout_text() == tracking {
            upstream_name.clone()
        } else {
            tracking.clone()
        }
    };
    let Some(upstream_sha) = resolve_commit(core, repo_id, &tracking).await? else {
        return Err(CoreError::new(
            ErrorCode::NoUpstream,
            format!("The upstream branch “{upstream_name}” does not exist (anymore)."),
        ));
    };

    let (ahead, behind) = match &old_sha {
        Some(old) => {
            let range = format!("{old}...{upstream_sha}");
            let text = probe(core, repo_id)?.args(["rev-list", "--left-right", "--count", &range]).run_text().await?;
            let mut numbers = text.split_whitespace().map(|n| n.parse::<u32>().unwrap_or(0));
            (numbers.next().unwrap_or(0), numbers.next().unwrap_or(0))
        }
        None => {
            let text = probe(core, repo_id)?.args(["rev-list", "--count", &upstream_sha]).run_text().await?;
            (0, text.trim().parse::<u32>().unwrap_or(1).max(1))
        }
    };
    if behind == 0 {
        return Ok(OpResult::UpToDate);
    }
    let fast_forward = ahead == 0;
    if !fast_forward && mode == PullMode::FfOnly {
        return Err(CoreError::not_allowed(format!(
            "A fast-forward is not possible because “{branch}” and “{upstream_name}” have diverged ({} ahead locally, {} behind). Pull with merge or rebase instead.",
            commits(ahead),
            commits(behind),
        )));
    }
    let rebase = !fast_forward && mode == PullMode::Rebase;

    let undo_id = undo::new_id();
    if let Some(old) = &old_sha {
        undo::create_backup_ref(core, repo_id, &undo_id, "before", old).await?;
    }
    let (subcommand, args): (&str, Vec<&str>) = if fast_forward {
        ("merge", vec!["merge", "--ff-only", &merge_arg])
    } else if rebase {
        ("rebase", vec!["rebase", &tracking])
    } else {
        ("merge", vec!["merge", "--ff", "--no-edit", &merge_arg])
    };
    job.progress(if rebase { "Rebase" } else { "Merge" }, None, &format!("Integrating {upstream_name} …"));
    let out = match core.git_for(repo_id)?.args(args).run_raw().await {
        Ok(out) => out,
        Err(e) => {
            let _ = undo::delete_backup_refs(core, repo_id, &undo_id).await;
            return Err(e);
        }
    };
    if !out.success() {
        let _ = undo::delete_backup_refs(core, repo_id, &undo_id).await;
        let state = status::read_status(core, repo_id).await?;
        if state.operation.is_some() || !state.conflicted.is_empty() {
            return Ok(OpResult::Conflict {
                files: state.conflicted.iter().map(|f| f.path.clone()).collect(),
                operation: state.operation,
                note: None,
            });
        }
        return Err(errors::classify(subcommand, out.code, &out.stdout, &out.stderr));
    }

    let new_sha = resolve_commit(core, repo_id, "HEAD").await?;
    let summary = if fast_forward {
        format!("Fast-forwarded to {upstream_name} ({}).", commits(behind))
    } else if rebase {
        format!("Rebased {} onto {upstream_name}.", if ahead == 1 { "1 local commit".to_string() } else { format!("{ahead} local commits") })
    } else {
        format!("Merged {upstream_name} ({} new).", commits(behind))
    };
    let head_ref = head_marker(&head);
    undo::record(
        core,
        UndoRecord {
            id: undo_id,
            repo_id: repo_id.to_string(),
            worktree_path: String::new(),
            action: if rebase { UndoAction::Rebase } else { UndoAction::Merge },
            label: format!("Undo pull from {upstream_name}"),
            ref_name: Some(format!("refs/heads/{branch}")),
            ref_before: old_sha,
            ref_after: new_sha.clone(),
            head_before: head_ref.clone(),
            head_after: Some(head_ref),
            payload: json!({
                "branch": branch,
                "upstream": upstream_name,
                "summary": summary,
                "pullMode": pull_mode_key(mode),
                "fastForward": fast_forward,
            }),
        },
    )
    .await?;
    Ok(OpResult::Done { sha: new_sha, fast_forward, summary })
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

/// What is to be pushed (see `push`).
#[derive(Debug, Clone, Copy, Default)]
pub struct PushRequest<'a> {
    /// `None` = the checked-out branch.
    pub branch: Option<&'a str>,
    /// `None` = the branch's upstream.
    pub remote: Option<&'a str>,
    /// Only with `remote`; `None` = same name as locally.
    pub remote_branch: Option<&'a str>,
    pub force: bool,
    /// Only with `force`: the state of the remote branch that the prompt showed the user
    /// (SHA). If something else is there by now – even after a background fetch –,
    /// nothing is overwritten. `None` = the state of the tracking ref at the time of the push.
    pub expected: Option<&'a str>,
    /// IDs of secret-scan findings the user saw and pushes anyway (`PushResult::SecretsFound`).
    /// `None` = nothing accepted: any finding stops the push.
    pub accepted_secrets: Option<&'a [String]>,
}

/// Push; without an upstream `remote` must be set. `force` uses `--force-with-lease`. Runs the
/// secret scan with nothing accepted (commit-and-push, PR push).
#[allow(clippy::too_many_arguments)]
pub async fn push(
    core: &Core,
    repo_id: String,
    job_id: String,
    branch: Option<String>,
    remote: Option<String>,
    remote_branch: Option<String>,
    force: bool,
    expected: Option<String>,
) -> CoreResult<PushResult> {
    push_checked(core, repo_id, job_id, branch, remote, remote_branch, force, expected, None).await
}

/// `push` with the IDs of secret-scan findings the user saw and pushes anyway. Any finding
/// outside `accepted_secrets` stops the push again (`PushResult::SecretsFound`, nothing sent).
#[allow(clippy::too_many_arguments)]
pub async fn push_checked(
    core: &Core,
    repo_id: String,
    job_id: String,
    branch: Option<String>,
    remote: Option<String>,
    remote_branch: Option<String>,
    force: bool,
    expected: Option<String>,
    accepted_secrets: Option<Vec<String>>,
) -> CoreResult<PushResult> {
    let job = core.start_job(&job_id, Some(&repo_id))?;
    let request = PushRequest {
        branch: branch.as_deref(),
        remote: remote.as_deref(),
        remote_branch: remote_branch.as_deref(),
        force,
        expected: expected.as_deref(),
        accepted_secrets: accepted_secrets.as_deref(),
    };
    // The transfer runs under the network lock; `push_transfer` takes the write lock
    // only briefly, to record the upstream.
    let result = with_network_lock(core, &repo_id, job.token(), push_transfer(core, &repo_id, job.token(), Some(&job), request)).await;
    if let Ok(PushResult::Done { created_upstream, .. }) = &result {
        let changes: &[RepoChange] = if *created_upstream { &[RepoChange::Refs, RepoChange::Config] } else { &[RepoChange::Refs] };
        core.emit_repo_changed(&repo_id, changes);
    }
    job.finish(&result);
    result
}

/// `push` with further branches and tags: `extra` goes along in the same `git push` (each force
/// only as `--force-with-lease=<ref>:<expected>`), with `atomic` (default on) as `--atomic`. The
/// result is `PushResult::Multi` with one line per ref; without `extra` it is exactly `push`.
#[allow(clippy::too_many_arguments)]
pub async fn push_with(
    core: &Core,
    repo_id: String,
    job_id: String,
    branch: Option<String>,
    remote: Option<String>,
    remote_branch: Option<String>,
    force: bool,
    expected: Option<String>,
    extra: Option<Vec<PushExtra>>,
    atomic: Option<bool>,
    accepted_secrets: Option<Vec<String>>,
) -> CoreResult<PushResult> {
    let extra = extra.unwrap_or_default();
    if extra.is_empty() {
        return push_checked(core, repo_id, job_id, branch, remote, remote_branch, force, expected, accepted_secrets).await;
    }
    let job = core.start_job(&job_id, Some(&repo_id))?;
    let request = PushRequest {
        branch: branch.as_deref(),
        remote: remote.as_deref(),
        remote_branch: remote_branch.as_deref(),
        force,
        expected: expected.as_deref(),
        accepted_secrets: accepted_secrets.as_deref(),
    };
    let result = with_network_lock(core, &repo_id, job.token(), push_many(core, &repo_id, &job, request, &extra, atomic.unwrap_or(true))).await;
    if let Ok(PushResult::Multi { refs, .. }) = &result {
        if refs.iter().any(|item| item.status == PushRefStatus::Ok) {
            core.emit_repo_changed(&repo_id, &[RepoChange::Refs, RepoChange::Config]);
        }
    }
    job.finish(&result);
    result
}

/// Where the primary branch goes (see `push_transfer`).
struct PushTarget {
    branch: String,
    local_ref: String,
    remote: String,
    remote_ref: String,
    remote_branch: String,
    /// The core records the upstream after a successful push.
    set_upstream: bool,
    created_upstream: bool,
}

async fn push_target(core: &Core, repo_id: &str, request: &PushRequest<'_>) -> CoreResult<PushTarget> {
    let known = remotes::read_remotes(core, repo_id).await?;
    if known.is_empty() {
        return Err(no_remote());
    }
    let branch = match request.branch.map(str::trim).filter(|b| !b.is_empty()) {
        Some(name) => name.to_string(),
        None => match refs::read_head(core, repo_id).await? {
            Head::Branch { branch, .. } => branch,
            Head::Unborn { .. } => {
                return Err(CoreError::not_allowed("There is no commit to push yet."));
            }
            Head::Detached { .. } => {
                return Err(CoreError::not_allowed("HEAD is detached. To push, a branch must be checked out."));
            }
        },
    };
    let local_ref = format!("refs/heads/{branch}");
    if resolve_commit(core, repo_id, &local_ref).await?.is_none() {
        return Err(CoreError::not_found(format!("The branch “{branch}” does not exist.")));
    }
    let configured = branch_upstream(core, repo_id, &branch).await?;
    let (remote, remote_ref, set_upstream) = match request.remote.map(str::trim).filter(|r| !r.is_empty()) {
        Some(name) => {
            if !known.iter().any(|r| r.name == name) {
                return Err(missing_remote(name));
            }
            let target = request.remote_branch.map(str::trim).filter(|b| !b.is_empty()).unwrap_or(&branch);
            util::check_ref_name(target)
                .map_err(|reason| CoreError::invalid_name(format!("Invalid name for the remote branch: {reason}")))?;
            (name.to_string(), format!("refs/heads/{target}"), true)
        }
        None => match &configured {
            Some((name, _)) if name == "." => {
                return Err(CoreError::not_allowed(format!(
                    "The upstream of “{branch}” is a local branch; you can't push to it."
                )));
            }
            Some((name, merge)) => (name.clone(), merge.clone(), false),
            None => return Err(no_upstream(&branch)),
        },
    };
    let created_upstream = set_upstream && configured.as_ref() != Some(&(remote.clone(), remote_ref.clone()));
    let remote_branch = remote_ref.strip_prefix("refs/heads/").unwrap_or(&remote_ref).to_string();
    Ok(PushTarget { branch, local_ref, remote, remote_ref, remote_branch, set_upstream, created_upstream })
}

/// Where a push with these arguments would go: (local ref, remote, branch on the remote). Same
/// rules and errors as `push` (`no_remote`, `no_upstream`, `not_found`, `not_allowed`) – for the
/// AI review of what the push sends.
pub(crate) async fn push_destination(core: &Core, repo_id: &str, request: &PushRequest<'_>) -> CoreResult<(String, String, String)> {
    let target = push_target(core, repo_id, request).await?;
    Ok((target.local_ref, target.remote, target.remote_branch))
}

/// `--force-with-lease=<remote_ref>:<expected>` for one branch: only the state we know from the
/// tracking ref (or the one the prompt showed, `expected`) may be overwritten; if we don't know the
/// branch there, it must not exist. `Err(Rejected)` if the tracking ref moved away from what the
/// prompt showed.
async fn lease(core: &Core, repo_id: &str, remote: &str, remote_ref: &str, expected: Option<&str>) -> CoreResult<Result<String, PushResult>> {
    let remote_branch = remote_ref.strip_prefix("refs/heads/").unwrap_or(remote_ref);
    let tracking = format!("refs/remotes/{remote}/{remote_branch}");
    let known_tip = resolve_commit(core, repo_id, &tracking).await?.unwrap_or_default();
    let expected = match expected.map(str::trim).filter(|sha| sha.len() >= 7 && sha.bytes().all(|b| b.is_ascii_hexdigit())) {
        Some(shown) => {
            if !known_tip.eq_ignore_ascii_case(shown) {
                return Ok(Err(PushResult::Rejected {
                    reason: format!(
                        "The remote branch “{remote}/{remote_branch}” changed while the confirmation was open. Nothing was overwritten. Choose “Force push” again and check which commits would be lost now."
                    ),
                }));
            }
            shown.to_string()
        }
        None => known_tip,
    };
    Ok(Ok(format!("--force-with-lease={remote_ref}:{expected}")))
}

/// Source and target of an extra ref: `refs/heads/<b>` or `refs/tags/<t>` locally, the same kind on
/// the remote under `remote_name` (default: the same name). Tags are never forced.
async fn extra_refspec(core: &Core, repo_id: &str, item: &PushExtra) -> CoreResult<(String, String)> {
    let local = item.local.trim();
    let (kind, name) = if let Some(name) = local.strip_prefix("refs/heads/") {
        ("refs/heads/", name)
    } else if let Some(name) = local.strip_prefix("refs/tags/") {
        ("refs/tags/", name)
    } else {
        return Err(CoreError::invalid_name(format!("“{local}” is neither a local branch nor a tag (expected refs/heads/… or refs/tags/…).")));
    };
    util::check_ref_name(name).map_err(|reason| CoreError::invalid_name(format!("Invalid name “{name}”: {reason}")))?;
    if resolve_commit(core, repo_id, local).await?.is_none() {
        return Err(CoreError::not_found(format!("“{name}” does not exist.")));
    }
    if item.force && kind == "refs/tags/" {
        return Err(CoreError::not_allowed(format!("The tag “{name}” can't be forced; tags are only pushed when they are new on the remote.")));
    }
    let target = item.remote_name.as_deref().map(str::trim).filter(|n| !n.is_empty()).unwrap_or(name);
    util::check_ref_name(target).map_err(|reason| CoreError::invalid_name(format!("Invalid name on the remote: {reason}")))?;
    Ok((local.to_string(), format!("{kind}{target}")))
}

/// The primary branch plus `extra` in one `git push`. The caller holds the network lock.
async fn push_many(core: &Core, repo_id: &str, job: &Job, request: PushRequest<'_>, extra: &[PushExtra], atomic: bool) -> CoreResult<PushResult> {
    let cancel = job.token();
    let target = push_target(core, repo_id, &request).await?;
    let mut specs: Vec<(String, String)> = vec![(target.local_ref.clone(), target.remote_ref.clone())];
    let mut leases: Vec<String> = Vec::new();
    if request.force {
        match lease(core, repo_id, &target.remote, &target.remote_ref, request.expected).await? {
            Ok(arg) => leases.push(arg),
            Err(rejected) => return Ok(rejected),
        }
    }
    for item in extra {
        let (local, remote_ref) = extra_refspec(core, repo_id, item).await?;
        if specs.iter().any(|(_, known)| *known == remote_ref) {
            return Err(CoreError::not_allowed(format!("“{remote_ref}” is named twice in the push.")));
        }
        if item.force {
            match lease(core, repo_id, &target.remote, &remote_ref, None).await? {
                Ok(arg) => leases.push(arg),
                Err(rejected) => return Ok(rejected),
            }
        }
        specs.push((local, remote_ref));
    }

    // The local secret scan (spec 6.2) runs before hooks and before anything is sent.
    let tips: Vec<String> = specs.iter().map(|(local, _)| local.clone()).collect();
    if let Some(stop) = secret_scan::check_push(core, repo_id, &tips, &target.remote, request.accepted_secrets, Some(job), cancel).await? {
        return Ok(stop);
    }
    let hooks = Hooks::start(core, repo_id).await;
    let mut cmd = hooks.wrap(core.git_for(repo_id)?).args(["push", "--porcelain", "--progress"]);
    if atomic {
        cmd = cmd.arg("--atomic");
    }
    cmd = cmd.args(&leases).arg("--").arg(&target.remote);
    for (local, remote_ref) in &specs {
        cmd = cmd.arg(format!("{local}:{remote_ref}"));
    }
    let out = cmd.check(false).network().run_stream(cancel, &mut |line| job.progress_line(line)).await;
    let ran = hooks.finish(core, repo_id);
    let out = out?;
    if !out.success() {
        if let Some(error) = hook_failure(&ran, &["pre-push"], &out, "the push") {
            return Err(error);
        }
    }

    let mut refs: Vec<PushRefResult> = Vec::with_capacity(specs.len());
    let mut reported = false;
    for (local, remote_ref) in &specs {
        let line = exact_push_line(&out.stdout, remote_ref);
        reported |= line.is_some();
        let (status, forced, reason) = match line {
            Some((' ' | '*' | '-', _)) => (PushRefStatus::Ok, false, None),
            Some(('+', _)) => (PushRefStatus::Ok, true, None),
            Some(('=', _)) => (PushRefStatus::UpToDate, false, None),
            Some((_, summary)) => (PushRefStatus::Rejected, false, Some(rejection_reason(&summary))),
            None => (PushRefStatus::Rejected, false, Some("Git reported nothing for this ref.".to_string())),
        };
        refs.push(PushRefResult { local: local.clone(), remote_ref: remote_ref.clone(), status, forced, reason });
    }
    if !reported {
        return Err(push_error(core, repo_id, &out).await);
    }
    if target.set_upstream && refs[0].status != PushRefStatus::Rejected {
        with_lock_cancellable(core, repo_id, cancel, async {
            core.git_for(repo_id)?.args(["config", &format!("branch.{}.remote", target.branch), &target.remote]).run().await?;
            core.git_for(repo_id)?.args(["config", &format!("branch.{}.merge", target.branch), &target.remote_ref]).run().await?;
            Ok(())
        })
        .await?;
    }
    Ok(PushResult::Multi { remote: target.remote, atomic, refs })
}

/// The `--porcelain` line for exactly `remote_ref` (unlike `parse_push_porcelain`, no fallback to
/// the first line): flag and summary.
fn exact_push_line(stdout: &[u8], remote_ref: &str) -> Option<(char, String)> {
    for line in util::split_records(stdout, b'\n') {
        let line = util::decode_lossy(line.strip_suffix(b"\r").unwrap_or(line));
        let mut parts = line.splitn(3, '\t');
        let (Some(flag), Some(refs), Some(summary)) = (parts.next(), parts.next(), parts.next()) else { continue };
        let mut chars = flag.chars();
        let (Some(flag), None) = (chars.next(), chars.next()) else { continue };
        if refs.rsplit_once(':').is_some_and(|(_, to)| to == remote_ref) {
            return Some((flag, summary.trim().to_string()));
        }
    }
    None
}

/// "[rejected] (non-fast-forward)" → "non-fast-forward"; without parentheses the whole summary.
fn rejection_reason(summary: &str) -> String {
    match (summary.rfind('('), summary.rfind(')')) {
        (Some(open), Some(close)) if close > open => summary[open + 1..close].trim().to_string(),
        _ => summary.trim().to_string(),
    }
}

/// The actual push. The caller holds the network lock, NOT the write lock: it is
/// only taken here briefly, to record the upstream after a successful transfer.
/// Does not report `repo:changed`: after `Done`, `refs` are affected, with `created_upstream`
/// also `config`.
///
/// A rejected push (the remote has foreign commits, or the state there has changed since the
/// last fetch) is not an error but `PushResult::Rejected`.
pub(crate) async fn push_transfer(core: &Core, repo_id: &str, cancel: &CancelToken, job: Option<&Job>, request: PushRequest<'_>) -> CoreResult<PushResult> {
    let PushTarget { branch, local_ref, remote, remote_ref, remote_branch, set_upstream, created_upstream } = push_target(core, repo_id, &request).await?;
    // The local secret scan (spec 6.2) runs before hooks and before anything is sent.
    if let Some(stop) = secret_scan::check_push(core, repo_id, std::slice::from_ref(&local_ref), &remote, request.accepted_secrets, job, cancel).await? {
        return Ok(stop);
    }

    // Without `--set-upstream`: the core writes the configuration itself afterwards, under the write lock.
    let hooks = Hooks::start(core, repo_id).await;
    let mut cmd = hooks.wrap(core.git_for(repo_id)?).args(["push", "--porcelain", "--progress"]);
    if request.force {
        match lease(core, repo_id, &remote, &remote_ref, request.expected).await? {
            Ok(arg) => cmd = cmd.arg(arg),
            Err(rejected) => return Ok(rejected),
        }
    }
    let out = cmd
        .arg("--")
        .arg(&remote)
        .arg(format!("{local_ref}:{remote_ref}"))
        .check(false)
        .network()
        .run_stream(cancel, &mut |line| {
            if let Some(job) = job {
                job.progress_line(line);
            }
        })
        .await;
    let ran = hooks.finish(core, repo_id);
    let out = out?;
    if !out.success() {
        if let Some(error) = hook_failure(&ran, &["pre-push"], &out, "the push") {
            return Err(error);
        }
    }

    let outcome = parse_push_porcelain(&out.stdout, &remote_ref);
    if set_upstream && out.success() && matches!(outcome, Some((flag, _)) if flag != '!') {
        with_lock_cancellable(core, repo_id, cancel, async {
            core.git_for(repo_id)?.args(["config", &format!("branch.{branch}.remote"), &remote]).run().await?;
            core.git_for(repo_id)?.args(["config", &format!("branch.{branch}.merge"), &remote_ref]).run().await?;
            Ok(())
        })
        .await?;
    }
    match outcome {
        Some(('!', detail)) => {
            let lower = detail.to_lowercase();
            let target = format!("{remote}/{remote_branch}");
            if lower.contains("remote rejected") {
                let all = format!("{}\n{}", out.stderr_text(), util::decode_lossy(&out.stdout));
                // What the server wrote about it (hook, policy) belongs in the message.
                let said = server_said(&out.stderr_text());
                let message = if said.is_empty() {
                    format!("The server rejected the push: {detail}")
                } else {
                    format!("The server rejected the push: {detail}. The server said: “{said}”")
                };
                return Err(CoreError::not_allowed(message).with_git_output(all));
            }
            let reason = if lower.contains("stale info") {
                format!(
                    "The remote branch “{target}” has changed since the last fetch. Fetch first and review the new state; then you can force the push."
                )
            } else if lower.contains("non-fast-forward") || lower.contains("fetch first") {
                format!(
                    "The remote branch “{target}” contains commits you don't have locally. Pull first – or force the push if they should be overwritten there."
                )
            } else {
                format!("The push to “{target}” was rejected: {detail}")
            };
            Ok(PushResult::Rejected { reason })
        }
        Some(('=', _)) if out.success() && !created_upstream => Ok(PushResult::UpToDate),
        Some((flag, _)) if out.success() => {
            Ok(PushResult::Done { remote, branch: remote_branch, created_upstream, forced: flag == '+' })
        }
        _ => Err(push_error(core, repo_id, &out).await),
    }
}

/// The lines the server wrote during the push (`remote: …`), without Git's own
/// error line about the rejecting hook; at most 400 characters.
fn server_said(stderr: &str) -> String {
    let lines: Vec<&str> = stderr
        .lines()
        .filter_map(|line| line.trim_start().strip_prefix("remote:"))
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.to_lowercase().starts_with("error: hook declined"))
        .collect();
    crate::undo::shorten(&lines.join(" "), 400)
}

/// Deletes a branch on the remote (`git push <remote> --delete <name>`). `done`: deleted
/// (`branch` = name on the remote); `up_to_date`: the branch no longer existed there –
/// the stale remote branch in the own repository is then removed. If the server
/// refuses (protected branch), that is the error `not_allowed`.
pub async fn branch_delete_remote(core: &Core, repo_id: String, job_id: String, remote: String, name: String) -> CoreResult<PushResult> {
    let job = core.start_job(&job_id, Some(&repo_id))?;
    let result = with_network_lock(core, &repo_id, job.token(), delete_remote_branch(core, &repo_id, &job, remote.trim(), name.trim())).await;
    if result.is_ok() {
        core.emit_repo_changed(&repo_id, &[RepoChange::Refs]);
    }
    job.finish(&result);
    result
}

async fn delete_remote_branch(core: &Core, repo_id: &str, job: &Job, remote: &str, name: &str) -> CoreResult<PushResult> {
    let known = remotes::read_remotes(core, repo_id).await?;
    if known.is_empty() {
        return Err(no_remote());
    }
    if !known.iter().any(|r| r.name == remote) {
        return Err(missing_remote(remote));
    }
    // "origin/x" or the full name of the remote branch are fine too.
    let name = name.strip_prefix(&format!("refs/remotes/{remote}/")).or_else(|| name.strip_prefix(&format!("{remote}/"))).unwrap_or(name);
    let name = name.strip_prefix("refs/heads/").unwrap_or(name);
    util::check_ref_name(name).map_err(|reason| CoreError::invalid_name(format!("Invalid name for the remote branch: {reason}")))?;
    let remote_ref = format!("refs/heads/{name}");
    let tracking = format!("refs/remotes/{remote}/{name}");
    job.progress("Push", None, &format!("Deleting {remote}/{name} …"));
    let out = core
        .git_for(repo_id)?
        .args(["push", "--porcelain", "--progress", "--"])
        .arg(remote)
        .arg(format!(":{remote_ref}"))
        .check(false)
        .network()
        .run_stream(job.token(), &mut |line| job.progress_line(line))
        .await?;
    // Newer Git versions report deleting a branch that doesn't exist (any more) there
    // as success with a warning; older ones as an error.
    let stderr = out.stderr_text().to_lowercase();
    let missing = stderr.contains("non-existent ref") || stderr.contains("remote ref does not exist");
    match parse_push_porcelain(&out.stdout, &remote_ref) {
        Some(('-', _)) if out.success() && !missing => Ok(PushResult::Done { remote: remote.to_string(), branch: name.to_string(), created_upstream: false, forced: false }),
        Some(('!', detail)) if detail.to_lowercase().contains("remote rejected") => {
            let all = format!("{}\n{}", out.stderr_text(), util::decode_lossy(&out.stdout));
            Err(CoreError::not_allowed(format!("The server refused to delete “{remote}/{name}”: {detail}")).with_git_output(all))
        }
        _ if missing => {
            // Already gone on the remote: the stale remote branch here is cleaned up.
            if resolve_commit(core, repo_id, &tracking).await?.is_some() {
                with_lock_cancellable(core, repo_id, job.token(), async {
                    core.git_for(repo_id)?.args(["update-ref", "-d", &tracking]).run().await?;
                    Ok(())
                })
                .await?;
            }
            Ok(PushResult::UpToDate)
        }
        _ => Err(push_error(core, repo_id, &out).await),
    }
}

/// Result for `wanted` (ref on the remote) from `git push --porcelain`:
/// one line per ref `<flag>\t<from>:<to>\t<summary>`.
/// Flags: ' ' fast-forward, '+' forced, '*' new, '=' up to date, '!' rejected, '-' deleted.
pub fn parse_push_porcelain(stdout: &[u8], wanted: &str) -> Option<(char, String)> {
    let mut first = None;
    for line in util::split_records(stdout, b'\n') {
        let line = util::decode_lossy(line.strip_suffix(b"\r").unwrap_or(line));
        let mut parts = line.splitn(3, '\t');
        let (Some(flag), Some(refs), Some(summary)) = (parts.next(), parts.next(), parts.next()) else { continue };
        let mut chars = flag.chars();
        let (Some(flag), None) = (chars.next(), chars.next()) else { continue };
        let entry = (flag, summary.trim().to_string());
        if refs.rsplit_once(':').is_some_and(|(_, to)| to == wanted) {
            return Some(entry);
        }
        first.get_or_insert(entry);
    }
    first
}

/// Error of a push for which Git did not report a result per ref.
async fn push_error(core: &Core, repo_id: &str, out: &crate::git::GitOutput) -> CoreError {
    let stderr = out.stderr_text();
    // A failed pre-push hook leaves only its own output and this line.
    if stderr.to_lowercase().contains("failed to push some refs") && hook_exists(core, repo_id, "pre-push").await {
        return CoreError::new(ErrorCode::HookFailed, "The “pre-push” hook rejected the push.").with_git_output(stderr);
    }
    errors::classify("push", out.code, &out.stdout, &out.stderr)
}

/// Whether the hook exists (respects `core.hooksPath`).
pub(crate) async fn hook_exists(core: &Core, repo_id: &str, hook: &str) -> bool {
    let Ok(root) = core.repo_path(repo_id) else { return false };
    let Ok(cmd) = probe(core, repo_id) else { return false };
    match cmd.args(["rev-parse", "--git-path", &format!("hooks/{hook}")]).run_raw().await {
        Ok(out) if out.success() => {
            let path = PathBuf::from(out.stdout_text());
            let path = if path.is_absolute() { path } else { root.join(path) };
            path.is_file()
        }
        _ => false,
    }
}

/// Cancels a running job. An unknown or already finished jobId is not an error.
pub async fn job_cancel(core: &Core, job_id: String) -> CoreResult<()> {
    core.jobs.cancel(&job_id);
    Ok(())
}

/// "Don't report again" for secret-scan findings: stores the IDs (hashes of path + line, never the
/// value) for this repository. Returns how many findings it no longer reports.
pub async fn push_scan_ignore(core: &Core, repo_id: String, ids: Vec<String>) -> CoreResult<u32> {
    core.repo_path(&repo_id)?;
    let count = core.db.tx(|tx| secret_scan::ignore_ids(tx, &repo_id, &ids))?;
    Ok(u32::try_from(count).unwrap_or(u32::MAX))
}

/// Settings › Project › Git "Report again": forgets every "Don't report again" of this repository.
pub async fn push_scan_forget(core: &Core, repo_id: String) -> CoreResult<crate::model::RepoSettings> {
    core.repo_path(&repo_id)?;
    core.db.with(|c| secret_scan::forget_ignored(c, &repo_id))?;
    crate::commands::settings::repo_settings_get(core, repo_id).await
}

#[cfg(test)]
mod push_many_tests;

#[cfg(test)]
mod secret_scan_tests;

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use super::*;
    use crate::commands::settings;
    use crate::events::names;
    use crate::model::OperationKind;
    use crate::testkit::{TestCore, TestRemote, TestRepo};

    struct Fixture {
        tc: TestCore,
        repo: TestRepo,
        remote: TestRemote,
        id: String,
    }

    impl Fixture {
        /// Output of a Git call in the remote; `None` if it fails.
        fn remote_output(&self, args: &[&str]) -> Option<String> {
            let out = self.remote.git_output(args);
            out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
        }
    }

    /// Repository with one commit, pushed as `origin/main` and opened in the core.
    async fn fixture() -> Fixture {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let remote = repo.add_remote();
        let id = tc.open(&repo).await.repo.id;
        tc.events.clear();
        Fixture { tc, repo, remote, id }
    }

    /// A second clone that changes `rel` and pushes to `origin/main`; returns the new SHA.
    fn push_from_elsewhere(remote: &TestRemote, rel: &str, content: &str) -> String {
        let other = TestRepo::clone_of(remote);
        let sha = other.commit_file(rel, content, &format!("Anderswo: {rel}"));
        other.git(&["push", "-q", "origin", "main"]);
        sha
    }

    fn changes(tc: &TestCore) -> Vec<serde_json::Value> {
        tc.events.named(names::REPO_CHANGED).into_iter().map(|e| e["what"].clone()).collect()
    }

    async fn do_fetch(f: &Fixture, remote: Option<&str>, prune: bool) -> CoreResult<FetchResult> {
        fetch(&f.tc, f.id.clone(), util::new_id(), remote.map(String::from), prune).await
    }

    async fn do_pull(f: &Fixture, mode: Option<PullMode>) -> CoreResult<OpResult> {
        pull(&f.tc, f.id.clone(), util::new_id(), mode).await
    }

    async fn do_push(f: &Fixture, branch: Option<&str>, remote: Option<&str>, remote_branch: Option<&str>, force: bool) -> CoreResult<PushResult> {
        push(&f.tc, f.id.clone(), util::new_id(), branch.map(String::from), remote.map(String::from), remote_branch.map(String::from), force, None).await
    }

    // --- Fetch ---------------------------------------------------------------

    #[tokio::test]
    async fn fetch_counts_new_commits_and_prunes_deleted_branches() {
        let f = fixture().await;
        let other = TestRepo::clone_of(&f.remote);
        let new_main = other.commit_file("neu.txt", "x\n", "Neu auf main");
        other.git(&["push", "-q", "origin", "main"]);
        other.checkout_new("kurzlebig");
        other.commit_file("k.txt", "k\n", "Kurzlebig");
        other.git(&["push", "-q", "origin", "kurzlebig"]);
        other.git(&["tag", "v1"]);
        other.git(&["push", "-q", "origin", "v1"]);

        let result = do_fetch(&f, None, false).await.unwrap();
        assert_eq!(result, FetchResult { updated_refs: 3, pruned_refs: 0, failed: vec![] });
        assert_eq!(f.repo.git(&["rev-parse", "refs/remotes/origin/main"]), new_main);
        assert_eq!(changes(&f.tc), vec![json!(["refs"])]);
        // The local branch stays where it was.
        assert_ne!(f.repo.head(), new_main);
        let done = f.tc.events.named(names::JOB_DONE);
        assert_eq!(done.len(), 1);
        assert_eq!(done[0]["ok"], true);
        assert_eq!(done[0]["repoId"], f.id.as_str());
        assert!(f.tc.events.count(names::JOB_PROGRESS) >= 1);

        // Nothing new: no repo:changed.
        f.tc.events.clear();
        assert_eq!(do_fetch(&f, Some("origin"), false).await.unwrap(), FetchResult::default());
        assert!(changes(&f.tc).is_empty());

        // Remote branch deleted: without prune it stays, with prune it disappears.
        other.git(&["push", "-q", "origin", "--delete", "kurzlebig"]);
        assert_eq!(do_fetch(&f, None, false).await.unwrap().pruned_refs, 0);
        assert!(f.repo.git_output(&["rev-parse", "--verify", "-q", "refs/remotes/origin/kurzlebig"]).status.success());
        let result = do_fetch(&f, None, true).await.unwrap();
        assert_eq!(result, FetchResult { updated_refs: 0, pruned_refs: 1, failed: vec![] });
        assert!(!f.repo.git_output(&["rev-parse", "--verify", "-q", "refs/remotes/origin/kurzlebig"]).status.success());
    }

    #[tokio::test]
    async fn fetch_without_remote_or_with_unknown_remote() {
        let tc = TestCore::new().await;
        let repo = TestRepo::new();
        let id = tc.open(&repo).await.repo.id;
        tc.events.clear();
        let err = fetch(&tc, id.clone(), "job-a".into(), None, true).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NoRemote);
        let done = tc.events.named(names::JOB_DONE);
        assert_eq!(done.len(), 1);
        assert_eq!(done[0]["ok"], false);
        assert_eq!(done[0]["cancelled"], false);
        assert!(!tc.jobs.is_running("job-a"));
        assert!(tc.events.named(names::REPO_CHANGED).is_empty());

        repo.git(&["remote", "add", "origin", "https://example.invalid/r.git"]);
        let err = fetch(&tc, id.clone(), "job-b".into(), Some("gibt-es-nicht".into()), false).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn fetch_all_keeps_going_when_one_remote_is_unreachable() {
        let f = fixture().await;
        let missing = f.repo.temp_dir().join("nicht da.git").to_string_lossy().replace('\\', "/");
        f.repo.git(&["remote", "add", "kaputt", &missing]);
        let new_main = push_from_elsewhere(&f.remote, "neu.txt", "x\n");

        let result = do_fetch(&f, None, false).await.unwrap();
        assert_eq!(result.updated_refs, 1);
        assert_eq!(result.failed.len(), 1);
        assert_eq!(result.failed[0].remote, "kaputt");
        assert!(!result.failed[0].message.is_empty());
        assert_eq!(f.repo.git(&["rev-parse", "refs/remotes/origin/main"]), new_main);

        // Named explicitly, the same remote is an error.
        let err = do_fetch(&f, Some("kaputt"), false).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NoRemote, "{err:?}");
        assert!(err.git_output.is_some());
    }

    #[tokio::test]
    async fn fetch_can_be_cancelled_and_reports_job_done() {
        let f = fixture().await;
        push_from_elsewhere(&f.remote, "neu.txt", "x\n");
        // Artificially slowed down: the "server" waits before it answers.
        f.repo.git(&["config", "remote.origin.uploadpack", "sleep 30; git-upload-pack"]);
        let core = f.tc.core.clone();
        let canceller = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(600)).await;
            assert!(core.jobs.is_running("job-langsam"));
            job_cancel(&core, "job-langsam".into()).await.unwrap();
            Instant::now()
        });
        let err = fetch(&f.tc, f.id.clone(), "job-langsam".into(), None, false).await.unwrap_err();
        let cancelled_at = canceller.await.unwrap();
        assert_eq!(err.code, ErrorCode::Cancelled);
        // The child process (the waiting shell) was really terminated, not waited for.
        assert!(cancelled_at.elapsed() < Duration::from_secs(10), "cancellation came too late: {:?}", cancelled_at.elapsed());
        let done = f.tc.events.named(names::JOB_DONE);
        assert_eq!(done.len(), 1);
        assert_eq!(done[0]["cancelled"], true);
        assert_eq!(done[0]["ok"], false);
        assert!(!f.tc.jobs.is_running("job-langsam"));
        // The write lock is free again.
        f.repo.git(&["config", "--unset", "remote.origin.uploadpack"]);
        assert_eq!(do_fetch(&f, None, false).await.unwrap().updated_refs, 1);
    }

    #[tokio::test]
    async fn waiting_for_a_lock_can_be_cancelled() {
        let f = fixture().await;
        // Fetch waits for the network lock (another transfer is running) …
        let guard = f.tc.network_lock(&f.id).await;
        let core = f.tc.core.clone();
        let canceller = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            job_cancel(&core, "job-wartet".into()).await.unwrap();
        });
        let err = fetch(&f.tc, f.id.clone(), "job-wartet".into(), None, false).await.unwrap_err();
        canceller.await.unwrap();
        assert_eq!(err.code, ErrorCode::Cancelled);
        drop(guard);
        // The same jobId is free again afterwards.
        fetch(&f.tc, f.id.clone(), "job-wartet".into(), None, false).await.unwrap();

        // … and pull, after the fetch, for the write lock (a write action is running).
        push_from_elsewhere(&f.remote, "neu.txt", "x\n");
        let before = f.repo.head();
        let guard = f.tc.write_lock(&f.id).await;
        let core = f.tc.core.clone();
        let repo_path = f.repo.path().to_path_buf();
        let canceller = tokio::spawn(async move {
            // Only cancel once the fetch part is through and only the lock is missing.
            for _ in 0..600 {
                if !core.jobs.is_running("job-pull") || repo_path.join(".git").join("FETCH_HEAD").exists() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            tokio::time::sleep(Duration::from_millis(300)).await;
            job_cancel(&core, "job-pull".into()).await.unwrap();
        });
        let err = pull(&f.tc, f.id.clone(), "job-pull".into(), None).await.unwrap_err();
        canceller.await.unwrap();
        assert_eq!(err.code, ErrorCode::Cancelled);
        drop(guard);
        assert_eq!(f.repo.head(), before, "nothing was integrated");
    }

    /// Waits until `check` holds (at most 30 s).
    async fn eventually(what: &str, mut check: impl FnMut() -> bool) {
        let started = Instant::now();
        while !check() {
            assert!(started.elapsed() < Duration::from_secs(30), "did not happen: {what}");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    fn tracking(repo: &TestRepo, branch: &str) -> Option<String> {
        let out = repo.git_output(&["rev-parse", "--verify", "-q", &format!("refs/remotes/origin/{branch}")]);
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    #[tokio::test]
    async fn a_long_fetch_does_not_block_a_commit() {
        let f = fixture().await;
        push_from_elsewhere(&f.remote, "neu.txt", "x\n");
        // Artificially slowed down: the "server" waits before it answers.
        f.repo.git(&["config", "remote.origin.uploadpack", "sleep 30; git-upload-pack"]);
        let (core, id) = (f.tc.core.clone(), f.id.clone());
        let fetching = tokio::spawn(async move { fetch(&core, id, "job-lang".into(), None, false).await });
        eventually("the fetch holds the network lock", || f.tc.try_network_lock(&f.id).is_none()).await;

        // Meanwhile the write lock is free: a commit goes through right away.
        assert!(!f.tc.write_lock_held(&f.id), "the fetch holds the write lock");
        f.repo.write_file("lokal.txt", "l\n");
        f.repo.git(&["add", "-A"]);
        let commit = crate::commands::commit::commit_create(&f.tc, f.id.clone(), util::new_id(), "Während des Fetch".into(), String::new(), false, false, false, false, None);
        let committed = tokio::time::timeout(Duration::from_secs(20), commit).await.expect("the commit hung on the running fetch").unwrap();
        assert_eq!(committed.sha, f.repo.head());
        assert!(f.tc.jobs.is_running("job-lang"), "the fetch is still running");
        assert!(!fetching.is_finished());

        // A second transfer, on the other hand, queues up: one per repository at a time.
        assert!(f.tc.try_network_lock(&f.id).is_none());
        job_cancel(&f.tc, "job-lang".into()).await.unwrap();
        assert_eq!(fetching.await.unwrap().unwrap_err().code, ErrorCode::Cancelled);
        assert!(f.tc.try_network_lock(&f.id).is_some(), "after the cancellation the network lock is free");
    }

    #[tokio::test]
    async fn pull_holds_the_write_lock_only_while_integrating() {
        let f = fixture().await;
        let theirs = push_from_elsewhere(&f.remote, "neu.txt", "x\n");
        let before = f.repo.head();

        // A write action is running: the fetch part of the pull still makes progress …
        let guard = f.tc.write_lock(&f.id).await;
        let (core, id) = (f.tc.core.clone(), f.id.clone());
        let pulling = tokio::spawn(async move { pull(&core, id, "job-pull".into(), None).await });
        eventually("the remote branch is fetched", || tracking(&f.repo, "main").as_deref() == Some(theirs.as_str())).await;
        // … the integration waits for the write lock.
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(f.repo.head(), before);
        assert!(!pulling.is_finished());
        drop(guard);
        let result = pulling.await.unwrap().unwrap();
        assert!(matches!(result, OpResult::Done { fast_forward: true, .. }), "{result:?}");
        assert_eq!(f.repo.head(), theirs);

        // If the branch was switched during the fetch, nothing is integrated.
        let newer = push_from_elsewhere(&f.remote, "noch-neuer.txt", "y\n");
        let guard = f.tc.write_lock(&f.id).await;
        let (core, id) = (f.tc.core.clone(), f.id.clone());
        let pulling = tokio::spawn(async move { pull(&core, id, "job-pull-2".into(), None).await });
        eventually("the remote branch is fetched", || tracking(&f.repo, "main").as_deref() == Some(newer.as_str())).await;
        f.repo.checkout_new("anders");
        drop(guard);
        let err = pulling.await.unwrap().unwrap_err();
        assert_eq!(err.code, ErrorCode::StaleState, "{err:?}");
        assert!(err.message.contains("anders"), "{}", err.message);
        assert_eq!(f.repo.git(&["rev-parse", "refs/heads/main"]), theirs, "main stayed put");
        assert_eq!(f.repo.head(), theirs);
    }

    #[tokio::test]
    async fn push_holds_the_write_lock_only_to_record_the_upstream() {
        let f = fixture().await;
        let first = f.repo.commit_file("a.txt", "a\n", "Lokal");

        // Pushing to the existing upstream doesn't need the write lock at all.
        let guard = f.tc.write_lock(&f.id).await;
        let pushed = tokio::time::timeout(Duration::from_secs(20), do_push(&f, None, None, None, false)).await.expect("the push hung on the write lock").unwrap();
        assert!(matches!(pushed, PushResult::Done { created_upstream: false, .. }), "{pushed:?}");
        assert_eq!(f.remote.git(&["rev-parse", "refs/heads/main"]), first);

        // New upstream: the transfer goes through, only recording the upstream waits.
        f.repo.checkout_new("feature");
        let second = f.repo.commit_file("b.txt", "b\n", "Feature");
        let (core, id) = (f.tc.core.clone(), f.id.clone());
        let pushing = tokio::spawn(async move { push(&core, id, "job-push".into(), Some("feature".into()), Some("origin".into()), None, false, None).await });
        eventually("the branch is on the remote", || {
            let out = f.remote_output(&["rev-parse", "--verify", "-q", "refs/heads/feature"]);
            out.as_deref() == Some(second.as_str())
        })
        .await;
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(!pushing.is_finished(), "the upstream is only recorded under the write lock");
        assert!(f.repo.git_output(&["config", "branch.feature.remote"]).stdout.is_empty());
        drop(guard);
        let result = pushing.await.unwrap().unwrap();
        assert_eq!(result, PushResult::Done { remote: "origin".into(), branch: "feature".into(), created_upstream: true, forced: false });
        assert_eq!(f.repo.git(&["rev-parse", "--abbrev-ref", "feature@{upstream}"]), "origin/feature");
        assert_eq!(f.repo.git(&["config", "branch.feature.merge"]), "refs/heads/feature");
    }

    #[tokio::test]
    async fn remote_branch_is_deleted_or_cleaned_up() {
        let f = fixture().await;
        f.repo.checkout_new("feature/alt");
        f.repo.commit_file("f.txt", "f\n", "Feature");
        f.repo.git(&["push", "-q", "-u", "origin", "feature/alt"]);
        f.repo.checkout("main");
        f.tc.events.clear();

        let delete = |remote: &str, name: &str| branch_delete_remote(&f.tc, f.id.clone(), util::new_id(), remote.to_string(), name.to_string());
        let result = delete("origin", "feature/alt").await.unwrap();
        assert_eq!(result, PushResult::Done { remote: "origin".into(), branch: "feature/alt".into(), created_upstream: false, forced: false });
        assert_eq!(f.remote_output(&["rev-parse", "--verify", "-q", "refs/heads/feature/alt"]), None, "deleted on the remote");
        assert_eq!(tracking(&f.repo, "feature/alt"), None, "the remote branch is gone locally too");
        assert!(f.repo.git_output(&["rev-parse", "--verify", "-q", "refs/heads/feature/alt"]).status.success(), "the local branch stays");
        assert_eq!(changes(&f.tc), vec![json!(["refs"])]);
        let done = f.tc.events.named(names::JOB_DONE);
        assert_eq!((done.len(), &done[0]["ok"]), (1, &json!(true)));

        // Already deleted elsewhere: the stale remote branch is cleaned up.
        let other = TestRepo::clone_of(&f.remote);
        other.checkout_new("kurz");
        other.commit_file("k.txt", "k\n", "Kurz");
        other.git(&["push", "-q", "origin", "kurz"]);
        do_fetch(&f, None, false).await.unwrap();
        assert!(tracking(&f.repo, "kurz").is_some());
        other.git(&["push", "-q", "origin", "--delete", "kurz"]);
        // "origin/kurz" as a name is fine too.
        assert_eq!(delete("origin", "origin/kurz").await.unwrap(), PushResult::UpToDate);
        assert_eq!(tracking(&f.repo, "kurz"), None);

        // Error cases
        assert_eq!(delete("gibt-es-nicht", "main").await.unwrap_err().code, ErrorCode::NotFound);
        assert_eq!(delete("origin", "schlechter..name").await.unwrap_err().code, ErrorCode::InvalidName);
        assert_eq!(delete("origin", "nie-dagewesen").await.unwrap(), PushResult::UpToDate);
        assert_eq!(f.remote.git(&["rev-parse", "refs/heads/main"]), f.repo.head(), "main is untouched");
    }

    #[tokio::test]
    async fn deleting_a_protected_remote_branch_is_not_allowed() {
        let f = fixture().await;
        f.repo.checkout_new("release");
        f.repo.git(&["push", "-q", "-u", "origin", "release"]);
        f.repo.checkout("main");
        // The server refuses deletions (as a protected branch does).
        f.remote.git(&["config", "receive.denyDeletes", "true"]);
        let before = f.remote.git(&["rev-parse", "refs/heads/release"]);
        f.tc.events.clear();

        let err = branch_delete_remote(&f.tc, f.id.clone(), util::new_id(), "origin".into(), "release".into()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed, "{err:?}");
        assert!(err.message.contains("origin/release"), "{}", err.message);
        assert!(err.git_output.unwrap_or_default().contains("deletion prohibited"));
        assert_eq!(f.remote_output(&["rev-parse", "--verify", "-q", "refs/heads/release"]), Some(before), "still on the remote");
        assert!(tracking(&f.repo, "release").is_some(), "the remote branch stays locally too");
        assert!(changes(&f.tc).is_empty(), "nothing changed");
        let done = f.tc.events.named(names::JOB_DONE);
        assert_eq!((done.len(), &done[0]["ok"]), (1, &json!(false)));
    }

    #[tokio::test]
    async fn background_fetch_needs_no_lock_and_reports_changes() {
        let f = fixture().await;
        let new_main = push_from_elsewhere(&f.remote, "neu.txt", "x\n");
        // A user action holds the write lock: auto-fetch runs anyway.
        let guard = f.tc.write_lock(&f.id).await;
        let result = fetch_background(&f.tc, &f.id, true, &CancelToken::new()).await.unwrap();
        drop(guard);
        assert_eq!(result.updated_refs, 1);
        assert_eq!(f.repo.git(&["rev-parse", "refs/remotes/origin/main"]), new_main);
        assert_eq!(changes(&f.tc), vec![json!(["refs"])]);
        assert_eq!(f.tc.events.count(names::JOB_DONE), 0);
        f.tc.events.clear();
        fetch_background(&f.tc, &f.id, true, &CancelToken::new()).await.unwrap();
        assert!(changes(&f.tc).is_empty());
    }

    // --- Pull ----------------------------------------------------------------

    #[tokio::test]
    async fn pull_fast_forwards_and_records_undo() {
        let f = fixture().await;
        let before = f.repo.head();
        push_from_elsewhere(&f.remote, "mit leerzeichen/größe.txt", "eins\r\nzwei");
        let new_main = push_from_elsewhere(&f.remote, "zwei.txt", "2\n");

        let result = do_pull(&f, None).await.unwrap();
        let OpResult::Done { sha, fast_forward, summary } = result else { panic!("{result:?}") };
        assert_eq!(sha.as_deref(), Some(new_main.as_str()));
        assert!(fast_forward);
        assert_eq!(summary, "Fast-forwarded to origin/main (2 commits).");
        assert_eq!(f.repo.head(), new_main);
        assert_eq!(f.repo.read_file("mit leerzeichen/größe.txt"), b"eins\r\nzwei");
        assert_eq!(changes(&f.tc), vec![json!(["worktree", "index", "refs", "head", "operation"])]);
        assert_eq!(f.tc.events.named(names::JOB_DONE)[0]["ok"], true);

        let entry = undo::next_undo(&f.tc, &f.id, "").unwrap().unwrap();
        assert_eq!(entry.action, "merge");
        assert_eq!(entry.label, "Undo pull from origin/main");
        assert_eq!(entry.ref_name.as_deref(), Some("refs/heads/main"));
        assert_eq!(entry.ref_before.as_deref(), Some(before.as_str()));
        assert_eq!(entry.ref_after.as_deref(), Some(new_main.as_str()));
        assert_eq!(entry.head_before, "refs/heads/main");
        assert_eq!(entry.head_after.as_deref(), Some("refs/heads/main"));
        assert_eq!(entry.payload["branch"], "main");
        assert_eq!(entry.payload["fastForward"], true);
        assert_eq!(f.repo.git(&["rev-parse", &undo::backup_ref_name(&entry.id, "before")]), before);

        // Once more: nothing to do, no further undo entry.
        f.tc.events.clear();
        assert_eq!(do_pull(&f, None).await.unwrap(), OpResult::UpToDate);
        assert_eq!(changes(&f.tc), vec![json!(["refs"])]);
        assert_eq!(undo::next_undo(&f.tc, &f.id, "").unwrap().unwrap().id, entry.id);
        // Ahead locally, remote unchanged: nothing to fetch either.
        f.repo.commit_file("lokal.txt", "l\n", "Lokal");
        assert_eq!(do_pull(&f, Some(PullMode::FfOnly)).await.unwrap(), OpResult::UpToDate);
    }

    /// A commit of its own locally, a different one on the remote: (local SHA, remote SHA).
    fn diverge(f: &Fixture) -> (String, String) {
        let theirs = push_from_elsewhere(&f.remote, "remote.txt", "r\n");
        let ours = f.repo.commit_file("lokal.txt", "l\n", "Lokal");
        (ours, theirs)
    }

    #[tokio::test]
    async fn pull_merges_when_branches_diverged() {
        let f = fixture().await;
        let (ours, theirs) = diverge(&f);
        let result = do_pull(&f, Some(PullMode::Ff)).await.unwrap();
        let OpResult::Done { sha, fast_forward, summary } = result else { panic!("{result:?}") };
        assert!(!fast_forward);
        assert_eq!(summary, "Merged origin/main (1 commit new).");
        let head = f.repo.head();
        assert_eq!(sha.as_deref(), Some(head.as_str()));
        assert_eq!(f.repo.git(&["rev-parse", "HEAD^1"]), ours);
        assert_eq!(f.repo.git(&["rev-parse", "HEAD^2"]), theirs);
        assert!(f.repo.path().join("remote.txt").exists() && f.repo.path().join("lokal.txt").exists());
        let entry = undo::next_undo(&f.tc, &f.id, "").unwrap().unwrap();
        assert_eq!(entry.action, "merge");
        assert_eq!(entry.ref_before.as_deref(), Some(ours.as_str()));
        assert_eq!(entry.ref_after.as_deref(), Some(head.as_str()));
    }

    #[tokio::test]
    async fn pull_ff_only_refuses_diverged_branches() {
        let f = fixture().await;
        let (ours, theirs) = diverge(&f);
        let err = do_pull(&f, Some(PullMode::FfOnly)).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
        assert!(err.message.contains("1 commit"), "{}", err.message);
        assert_eq!(f.repo.head(), ours);
        // The fetch happened anyway and is reported.
        assert_eq!(f.repo.git(&["rev-parse", "refs/remotes/origin/main"]), theirs);
        assert_eq!(changes(&f.tc).len(), 1);
        assert!(undo::next_undo(&f.tc, &f.id, "").unwrap().is_none());
        assert!(f.repo.git(&["for-each-ref", "refs/forkyard"]).is_empty());
        assert_eq!(f.tc.events.named(names::JOB_DONE)[0]["ok"], false);
    }

    #[tokio::test]
    async fn pull_rebases_local_commits() {
        let f = fixture().await;
        let (ours, theirs) = diverge(&f);
        f.repo.commit_file("lokal2.txt", "l2\n", "Lokal 2");
        let before = f.repo.head();
        let result = do_pull(&f, Some(PullMode::Rebase)).await.unwrap();
        let OpResult::Done { sha, fast_forward, summary } = result else { panic!("{result:?}") };
        assert!(!fast_forward);
        assert_eq!(summary, "Rebased 2 local commits onto origin/main.");
        let head = f.repo.head();
        assert_eq!(sha.as_deref(), Some(head.as_str()));
        assert_ne!(head, before);
        // Linear: the own commits sit on top of the remote's state.
        assert_eq!(f.repo.git(&["rev-parse", "HEAD~2"]), theirs);
        assert_eq!(f.repo.git(&["rev-list", "--merges", "--count", "HEAD"]), "0");
        assert_eq!(f.repo.current_branch(), "main");
        let entry = undo::next_undo(&f.tc, &f.id, "").unwrap().unwrap();
        assert_eq!(entry.action, "rebase");
        assert_eq!(entry.ref_before.as_deref(), Some(before.as_str()));
        assert_eq!(entry.payload["pullMode"], "rebase");
        // The old commits stay reachable through the backup.
        assert_eq!(f.repo.git(&["rev-parse", &undo::backup_ref_name(&entry.id, "before")]), before);
        assert_eq!(f.repo.git(&["rev-parse", &format!("{before}~1")]), ours);
    }

    #[tokio::test]
    async fn pull_uses_the_mode_from_repo_and_global_settings() {
        let f = fixture().await;
        diverge(&f);
        settings::settings_set(&f.tc, json!({ "defaultPullMode": "ff_only" })).await.unwrap();
        assert_eq!(default_pull_mode(&f.tc, &f.id).unwrap(), PullMode::FfOnly);
        assert_eq!(do_pull(&f, None).await.unwrap_err().code, ErrorCode::NotAllowed);
        // The repository's setting takes precedence.
        settings::repo_settings_set(&f.tc, f.id.clone(), json!({ "defaultPullMode": "rebase" })).await.unwrap();
        assert_eq!(default_pull_mode(&f.tc, &f.id).unwrap(), PullMode::Rebase);
        assert!(matches!(do_pull(&f, None).await.unwrap(), OpResult::Done { fast_forward: false, .. }));
        assert_eq!(f.repo.git(&["rev-list", "--merges", "--count", "HEAD"]), "0");
    }

    #[tokio::test]
    async fn pull_reports_merge_conflicts_as_result() {
        let f = fixture().await;
        push_from_elsewhere(&f.remote, "ä ö.txt", "von dort\n");
        f.repo.commit_file("ä ö.txt", "von hier\n", "Lokal dieselbe Datei");
        let result = do_pull(&f, Some(PullMode::Ff)).await.unwrap();
        let OpResult::Conflict { files, operation, .. } = result else { panic!("{result:?}") };
        assert_eq!(files, vec!["ä ö.txt".to_string()]);
        assert_eq!(operation.unwrap().kind, OperationKind::Merge);
        assert!(f.repo.path().join(".git").join("MERGE_HEAD").exists());
        assert!(undo::next_undo(&f.tc, &f.id, "").unwrap().is_none());
        assert!(f.repo.git(&["for-each-ref", "refs/forkyard"]).is_empty());
        assert_eq!(f.tc.events.named(names::JOB_DONE)[0]["ok"], true);

        // As long as the merge is open, no further pull is possible – a fetch is, though.
        let err = do_pull(&f, None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::OperationInProgress);
        push_from_elsewhere(&f.remote, "später.txt", "s\n");
        assert_eq!(do_fetch(&f, None, false).await.unwrap().updated_refs, 1);
    }

    #[tokio::test]
    async fn pull_reports_rebase_conflicts_as_result() {
        let f = fixture().await;
        push_from_elsewhere(&f.remote, "README.md", "# Dort\n");
        f.repo.commit_file("README.md", "# Hier\n", "Lokal dieselbe Datei");
        let result = do_pull(&f, Some(PullMode::Rebase)).await.unwrap();
        let OpResult::Conflict { files, operation, .. } = result else { panic!("{result:?}") };
        assert_eq!(files, vec!["README.md".to_string()]);
        assert_eq!(operation.unwrap().kind, OperationKind::Rebase);
        assert!(f.repo.path().join(".git").join("rebase-merge").exists());
        let err = do_pull(&f, Some(PullMode::Rebase)).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::OperationInProgress);
    }

    #[tokio::test]
    async fn pull_is_blocked_by_uncommitted_changes_and_foreign_locks() {
        let f = fixture().await;
        let before = f.repo.head();
        push_from_elsewhere(&f.remote, "README.md", "# Dort\n");
        f.repo.write_file("README.md", "# Ungesichert\n");
        for mode in [PullMode::Ff, PullMode::FfOnly, PullMode::Rebase] {
            let err = do_pull(&f, Some(mode)).await.unwrap_err();
            assert_eq!(err.code, ErrorCode::DirtyWorktree, "{mode:?}: {err:?}");
            assert_eq!(f.repo.head(), before);
            assert_eq!(f.repo.read_file("README.md"), b"# Ungesichert\n");
        }
        assert!(undo::next_undo(&f.tc, &f.id, "").unwrap().is_none());
        assert!(f.repo.git(&["for-each-ref", "refs/forkyard"]).is_empty());

        // Foreign index.lock: understandable error, the lock stays in place.
        f.repo.git(&["checkout", "-q", "--", "README.md"]);
        let lock = f.repo.path().join(".git").join("index.lock");
        std::fs::write(&lock, "").unwrap();
        let err = do_pull(&f, Some(PullMode::Ff)).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Locked, "{err:?}");
        assert!(lock.exists());
        assert_eq!(f.repo.head(), before);
    }

    #[tokio::test]
    async fn pull_needs_branch_upstream_and_remote() {
        let f = fixture().await;
        // New branch without an upstream
        f.repo.checkout_new("ohne-upstream");
        let err = do_pull(&f, None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NoUpstream);
        assert!(changes(&f.tc).is_empty(), "no fetch, no repo:changed");
        // Detached HEAD
        f.repo.git(&["checkout", "-q", "--detach"]);
        assert_eq!(do_pull(&f, None).await.unwrap_err().code, ErrorCode::NotAllowed);
        // Upstream deleted on the remote
        f.repo.checkout("main");
        let other = TestRepo::clone_of(&f.remote);
        other.checkout_new("weg");
        other.git(&["push", "-q", "origin", "weg"]);
        f.repo.git(&["fetch", "-q", "origin"]);
        f.repo.git(&["checkout", "-q", "weg"]);
        other.git(&["push", "-q", "origin", "--delete", "weg"]);
        f.repo.git(&["fetch", "-q", "--prune", "origin"]);
        let err = do_pull(&f, None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NoUpstream, "{err:?}");

        // No remote at all
        let tc = TestCore::new().await;
        let lonely = TestRepo::with_commit();
        let id = tc.open(&lonely).await.repo.id;
        assert_eq!(pull(&tc, id, "j".into(), None).await.unwrap_err().code, ErrorCode::NoRemote);
    }

    #[tokio::test]
    async fn pull_into_a_repo_without_commits() {
        // Clone of an empty remote: branch without a commit, but with an upstream.
        let remote = TestRemote::new();
        let repo = TestRepo::clone_of(&remote);
        let branch = repo.current_branch();
        let source = TestRepo::with_commit();
        source.git(&["remote", "add", "origin", &remote.url()]);
        source.git(&["push", "-q", "origin", &format!("main:{branch}")]);
        let tc = TestCore::new().await;
        let id = tc.open(&repo).await.repo.id;
        let result = pull(&tc, id.clone(), "j".into(), None).await.unwrap();
        assert!(matches!(result, OpResult::Done { fast_forward: true, .. }), "{result:?}");
        assert_eq!(repo.head(), source.head());
        assert_eq!(repo.read_file("README.md"), b"# Test\n");
        let entry = undo::next_undo(&tc, &id, "").unwrap().unwrap();
        assert_eq!(entry.ref_before, None);
        assert_eq!(entry.head_before, format!("refs/heads/{branch}"));
    }

    // --- Push ----------------------------------------------------------------

    #[tokio::test]
    async fn push_to_upstream_and_up_to_date() {
        let f = fixture().await;
        let sha = f.repo.commit_file("mit leerzeichen/ümlaut.txt", "x\n", "Lokal");
        let result = do_push(&f, None, None, None, false).await.unwrap();
        assert_eq!(result, PushResult::Done { remote: "origin".into(), branch: "main".into(), created_upstream: false, forced: false });
        assert_eq!(f.remote.git(&["rev-parse", "refs/heads/main"]), sha);
        assert_eq!(f.repo.git(&["rev-parse", "refs/remotes/origin/main"]), sha);
        assert_eq!(changes(&f.tc), vec![json!(["refs"])]);
        let done = f.tc.events.named(names::JOB_DONE);
        assert_eq!(done.len(), 1);
        assert_eq!(done[0]["ok"], true);

        f.tc.events.clear();
        assert_eq!(do_push(&f, None, None, None, false).await.unwrap(), PushResult::UpToDate);
        assert!(changes(&f.tc).is_empty());
        // Forcing without a difference is "up to date" as well.
        assert_eq!(do_push(&f, None, None, None, true).await.unwrap(), PushResult::UpToDate);
    }

    #[tokio::test]
    async fn push_without_upstream_asks_for_a_remote_and_then_creates_it() {
        let f = fixture().await;
        f.repo.checkout_new("feature/größe");
        let sha = f.repo.commit_file("f.txt", "f\n", "Feature");
        let err = do_push(&f, None, None, None, false).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NoUpstream);
        assert!(changes(&f.tc).is_empty());

        let result = do_push(&f, None, Some("origin"), None, false).await.unwrap();
        assert_eq!(
            result,
            PushResult::Done { remote: "origin".into(), branch: "feature/größe".into(), created_upstream: true, forced: false }
        );
        assert_eq!(f.remote.git(&["rev-parse", "refs/heads/feature/größe"]), sha);
        assert_eq!(f.repo.git(&["rev-parse", "--abbrev-ref", "feature/größe@{upstream}"]), "origin/feature/größe");
        assert_eq!(changes(&f.tc), vec![json!(["refs", "config"])]);
        // Now a push without arguments is enough.
        assert_eq!(do_push(&f, None, None, None, false).await.unwrap(), PushResult::UpToDate);

        // Different name on the remote, branch not checked out.
        f.repo.checkout("main");
        f.repo.branch("lokal");
        let result = do_push(&f, Some("lokal"), Some("origin"), Some("dort/anders"), false).await.unwrap();
        assert_eq!(result, PushResult::Done { remote: "origin".into(), branch: "dort/anders".into(), created_upstream: true, forced: false });
        assert_eq!(f.remote.git(&["rev-parse", "refs/heads/dort/anders"]), f.repo.head());
        assert_eq!(f.repo.git(&["rev-parse", "--abbrev-ref", "lokal@{upstream}"]), "origin/dort/anders");
        // Upstream newly set although there was nothing to transfer: "done" anyway.
        f.repo.branch("zweiter");
        let result = do_push(&f, Some("zweiter"), Some("origin"), Some("dort/anders"), false).await.unwrap();
        assert!(matches!(result, PushResult::Done { created_upstream: true, .. }), "{result:?}");
    }

    #[tokio::test]
    async fn rejected_push_is_a_result_and_force_uses_a_lease() {
        let f = fixture().await;
        let theirs = push_from_elsewhere(&f.remote, "remote.txt", "r\n");
        let ours = f.repo.commit_file("lokal.txt", "l\n", "Lokal");

        // Rejected: not an error, the job ends "ok".
        let result = do_push(&f, None, None, None, false).await.unwrap();
        let PushResult::Rejected { reason } = result else { panic!("{result:?}") };
        assert!(reason.contains("origin/main") && reason.contains("Pull first"), "{reason}");
        assert_eq!(f.remote.git(&["rev-parse", "refs/heads/main"]), theirs);
        assert_eq!(f.tc.events.named(names::JOB_DONE)[0]["ok"], true);
        assert!(changes(&f.tc).is_empty());

        // Forcing without ever having seen the new state: the lease protects the foreign commits.
        let result = do_push(&f, None, None, None, true).await.unwrap();
        let PushResult::Rejected { reason } = result else { panic!("{result:?}") };
        assert!(reason.contains("Fetch first"), "{reason}");
        assert_eq!(f.remote.git(&["rev-parse", "refs/heads/main"]), theirs);

        // After a fetch the state is known; now the forced push overwrites.
        do_fetch(&f, None, false).await.unwrap();
        let result = do_push(&f, None, None, None, true).await.unwrap();
        assert_eq!(result, PushResult::Done { remote: "origin".into(), branch: "main".into(), created_upstream: false, forced: true });
        assert_eq!(f.remote.git(&["rev-parse", "refs/heads/main"]), ours);

        // The command line in the log carries the lease, never a bare --force.
        let commands: Vec<String> = f
            .tc
            .events
            .named(names::LOG_APPENDED)
            .iter()
            .filter_map(|e| e["command"].as_str().map(String::from))
            .filter(|c| c.starts_with("git push"))
            .collect();
        assert!(commands.iter().any(|c| c.contains("--force-with-lease=refs/heads/main:")), "{commands:?}");
        assert!(!commands.iter().any(|c| c.split(' ').any(|a| a == "--force" || a == "-f")), "{commands:?}");
    }

    #[tokio::test]
    async fn force_push_after_amend_and_to_an_unknown_remote_branch() {
        let f = fixture().await;
        f.repo.commit_file("a.txt", "a\n", "Mit Tippfehler");
        do_push(&f, None, None, None, false).await.unwrap();
        f.repo.git(&["commit", "-q", "--amend", "-m", "Ohne Tippfehler"]);
        let amended = f.repo.head();
        let result = do_push(&f, None, None, None, false).await.unwrap();
        assert!(matches!(result, PushResult::Rejected { .. }), "{result:?}");
        let result = do_push(&f, None, None, None, true).await.unwrap();
        assert!(matches!(result, PushResult::Done { forced: true, .. }), "{result:?}");
        assert_eq!(f.remote.git(&["rev-parse", "refs/heads/main"]), amended);

        // Forced onto a branch that already exists there but that we never fetched: rejected.
        let other = TestRepo::clone_of(&f.remote);
        other.checkout_new("fremd");
        let foreign = other.commit_file("fremd.txt", "f\n", "Fremd");
        other.git(&["push", "-q", "origin", "fremd"]);
        let result = do_push(&f, None, Some("origin"), Some("fremd"), true).await.unwrap();
        assert!(matches!(result, PushResult::Rejected { .. }), "{result:?}");
        assert_eq!(f.remote.git(&["rev-parse", "refs/heads/fremd"]), foreign);
        // Onto a completely new name it works forced, too.
        let result = do_push(&f, None, Some("origin"), Some("ganz-neu"), true).await.unwrap();
        assert!(matches!(result, PushResult::Done { created_upstream: true, forced: false, .. }), "{result:?}");
    }

    #[tokio::test]
    async fn push_error_cases() {
        let f = fixture().await;
        assert_eq!(do_push(&f, Some("gibt-es-nicht"), None, None, false).await.unwrap_err().code, ErrorCode::NotFound);
        assert_eq!(do_push(&f, None, Some("unbekannt"), None, false).await.unwrap_err().code, ErrorCode::NotFound);
        assert_eq!(do_push(&f, None, Some("origin"), Some("a..b"), false).await.unwrap_err().code, ErrorCode::InvalidName);
        f.repo.git(&["checkout", "-q", "--detach"]);
        assert_eq!(do_push(&f, None, None, None, false).await.unwrap_err().code, ErrorCode::NotAllowed);
        // An explicitly named branch works with a detached HEAD too.
        assert_eq!(do_push(&f, Some("main"), None, None, false).await.unwrap(), PushResult::UpToDate);
        assert_eq!(f.tc.events.count(names::JOB_DONE), 5);

        // No remote, and a repository without a commit.
        let tc = TestCore::new().await;
        let lonely = TestRepo::with_commit();
        let id = tc.open(&lonely).await.repo.id;
        assert_eq!(push(&tc, id, "j1".into(), None, None, None, false, None).await.unwrap_err().code, ErrorCode::NoRemote);
        let empty = TestRepo::new();
        empty.git(&["remote", "add", "origin", &f.remote.url()]);
        let id = tc.open(&empty).await.repo.id;
        assert_eq!(push(&tc, id, "j2".into(), None, Some("origin".into()), None, false, None).await.unwrap_err().code, ErrorCode::NotAllowed);

        // Remote not reachable.
        let missing = f.repo.temp_dir().join("weg.git").to_string_lossy().replace('\\', "/");
        f.repo.git(&["remote", "set-url", "origin", &missing]);
        let err = do_push(&f, Some("main"), None, None, false).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NoRemote, "{err:?}");
    }

    #[tokio::test]
    async fn failing_pre_push_hook_is_reported_as_hook_failed() {
        let f = fixture().await;
        let before = f.remote.git(&["rev-parse", "refs/heads/main"]);
        f.repo.commit_file("a.txt", "a\n", "Lokal");
        let hook = f.repo.path().join(".git").join("hooks").join("pre-push");
        std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
        std::fs::write(&hook, "#!/bin/sh\necho 'Tests sind rot, kein Push' >&2\nexit 1\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        f.tc.events.clear();
        let err = do_push(&f, None, None, None, false).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::HookFailed, "{err:?}");
        assert!(err.message.contains("pre-push"), "{}", err.message);
        assert!(err.git_output.unwrap_or_default().contains("Tests sind rot"));
        // The hook's output also appears as hook:output.
        let hooks = f.tc.events.named(names::HOOK_OUTPUT);
        assert_eq!(hooks.len(), 1, "{hooks:?}");
        assert_eq!(hooks[0]["hook"], "pre-push");
        assert_eq!(hooks[0]["output"], "Tests sind rot, kein Push");
        assert_eq!(hooks[0]["exitCode"], 1);
        assert_eq!(hooks[0]["repoId"], f.id.as_str());
        assert_eq!(f.remote.git(&["rev-parse", "refs/heads/main"]), before);
        assert_eq!(f.tc.events.named(names::JOB_DONE)[0]["ok"], false);

        // A hook that lets it through doesn't interfere.
        std::fs::write(&hook, "#!/bin/sh\nexit 0\n").unwrap();
        assert!(matches!(do_push(&f, None, None, None, false).await.unwrap(), PushResult::Done { .. }));
    }

    #[test]
    fn porcelain_lines_are_parsed() {
        let out = b"To C:/x/remote.git\n \trefs/heads/main:refs/heads/main\t5c5d2a8..a1b2c3d\nDone\n";
        assert_eq!(parse_push_porcelain(out, "refs/heads/main"), Some((' ', "5c5d2a8..a1b2c3d".into())));
        let out = b"To r\n=\trefs/heads/a:refs/heads/a\t[up to date]\n!\trefs/heads/main:refs/heads/main\t[rejected] (fetch first)\nDone\n";
        assert_eq!(parse_push_porcelain(out, "refs/heads/main"), Some(('!', "[rejected] (fetch first)".into())));
        assert_eq!(parse_push_porcelain(out, "refs/heads/andere"), Some(('=', "[up to date]".into())));
        let out = b"To r\r\n*\trefs/heads/x:refs/heads/y\t[new branch]\r\nbranch 'x' set up to track 'origin/y'.\r\nDone\r\n";
        assert_eq!(parse_push_porcelain(out, "refs/heads/y"), Some(('*', "[new branch]".into())));
        assert_eq!(parse_push_porcelain(b"", "refs/heads/y"), None);
        assert_eq!(parse_push_porcelain(b"fatal: irgendwas\n", "refs/heads/y"), None);
    }

    // --- Jobs ----------------------------------------------------------------

    #[tokio::test]
    async fn job_cancel_reaches_running_job() {
        let tc = TestCore::new().await;
        let job = tc.start_job("job-1", None).unwrap();
        assert!(!job.token().is_cancelled());
        job_cancel(&tc, "job-1".into()).await.unwrap();
        assert!(job.token().is_cancelled());
        job.finish::<()>(&Err(CoreError::cancelled()));
        let done = tc.events.named(names::JOB_DONE);
        assert_eq!(done.len(), 1);
        assert_eq!(done[0]["cancelled"], true);
        assert_eq!(done[0]["ok"], false);
        // Unknown ID: not an error.
        job_cancel(&tc, "gibt-es-nicht".into()).await.unwrap();
    }

    #[tokio::test]
    async fn a_running_job_id_cannot_be_used_twice() {
        let f = fixture().await;
        let _running = f.tc.start_job("doppelt", Some(&f.id)).unwrap();
        let err = fetch(&f.tc, f.id.clone(), "doppelt".into(), None, false).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Duplicate);
    }
}
