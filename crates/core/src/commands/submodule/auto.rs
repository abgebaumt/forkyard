//! Submodules follow along: after a checkout, pull, merge, cherry-pick, revert, hard reset or a
//! finished rebase, submodules whose recorded commit changed are brought to it
//! (`git submodule update --init --recursive`). This runs as a follow-up job in the same queue –
//! network lock, then write lock – so the main operation answers right away. A failure is a warning
//! (event `submodules:updated` with `ok: false`, plus the activity log of the Git call), never an
//! error of the main operation. Network access uses the usual credential prompts; Git's
//! `protocol.allow` defaults stay as they are. Repository setting `submodulesAutoUpdate` (default on).

use std::future::Future;

use crate::app::Core;
use crate::commands::status;
use crate::db;
use crate::error::CoreResult;
use crate::events::names;
use crate::git::redact;
use crate::model::{OpResult, RepoChange, Status, SubmodulesUpdatedEvent};
use crate::util;

use super::{gitlinks, run_update};

/// Results that mean "the operation went through" (a conflict or "nothing to do" doesn't).
pub(crate) trait Concluded {
    fn concluded(&self) -> bool;
}

impl Concluded for OpResult {
    fn concluded(&self) -> bool {
        matches!(self, OpResult::Done { .. })
    }
}

impl Concluded for Status {
    fn concluded(&self) -> bool {
        true
    }
}

/// Runs `action`; if it went through, the submodules whose recorded commit it changed follow in
/// the background.
pub(crate) async fn follow<T, F>(core: &Core, repo_id: &str, action: F) -> CoreResult<T>
where
    T: Concluded,
    F: Future<Output = CoreResult<T>>,
{
    let before = recorded(core, repo_id).await;
    let result = action.await;
    if matches!(&result, Ok(value) if value.concluded()) {
        schedule(core, repo_id, before);
    }
    result
}

/// Like `follow`, for `operation_continue`: the comparison base is the commit the stopped
/// operation started from (`rebase-merge/orig-head`, `rebase-apply/orig-head`, `sequencer/head`,
/// otherwise HEAD – a merge or a single pick has not committed yet). Commits applied before the stop
/// changed gitlinks without touching the submodules; the index at continue time already contains them.
pub(crate) async fn follow_operation<T, F>(core: &Core, repo_id: &str, action: F) -> CoreResult<T>
where
    T: Concluded,
    F: Future<Output = CoreResult<T>>,
{
    let start = operation_start(core, repo_id).await.unwrap_or_else(|| "HEAD".to_string());
    let before = recorded_at(core, repo_id, &start).await;
    let result = action.await;
    if matches!(&result, Ok(value) if value.concluded()) {
        schedule(core, repo_id, before);
    }
    result
}

/// The commit a running rebase or cherry-pick/revert sequence started from (a full SHA from
/// `.git`, never from memory); `None` = HEAD applies.
async fn operation_start(core: &Core, repo_id: &str) -> Option<String> {
    let dir = status::git_dir(core, repo_id).await.ok()?;
    ["rebase-merge/orig-head", "rebase-apply/orig-head", "sequencer/head"]
        .iter()
        .filter_map(|name| std::fs::read_to_string(dir.join(name)).ok())
        .map(|text| text.trim().to_string())
        .find(|sha| sha.len() >= 40 && sha.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

/// Recorded submodule commits in the tree of `rev` (`git ls-tree -r -z --full-tree`).
async fn recorded_at(core: &Core, repo_id: &str, rev: &str) -> Vec<(Vec<u8>, String)> {
    let listed = match core.git_for(repo_id) {
        Ok(cmd) => cmd.read_only().no_log().args(["ls-tree", "-r", "-z", "--full-tree", rev]).run_raw().await,
        Err(e) => Err(e),
    };
    match listed {
        Ok(out) if out.success() => tree_gitlinks(&out.stdout),
        Ok(_) => Vec::new(),
        Err(e) => {
            log::warn!("Submodules of {rev} not read before continuing: {}", e.message);
            Vec::new()
        }
    }
}

/// Gitlinks (mode 160000) from `ls-tree -z` records `<mode> SP <type> SP <object> TAB <path>`.
pub(crate) fn tree_gitlinks(stdout: &[u8]) -> Vec<(Vec<u8>, String)> {
    let mut links: Vec<(Vec<u8>, String)> = Vec::new();
    for record in util::split_z(stdout) {
        let Some(tab) = record.iter().position(|&byte| byte == b'\t') else { continue };
        let meta = util::decode_lossy(&record[..tab]);
        let mut fields = meta.split(' ');
        let (Some("160000"), Some(_), Some(sha)) = (fields.next(), fields.next(), fields.next()) else { continue };
        links.push((record[tab + 1..].to_vec(), sha.to_string()));
    }
    links
}

/// Paths whose recorded commit differs from `before` (new submodules included).
pub(crate) fn changed_paths(before: &[(Vec<u8>, String)], after: &[(Vec<u8>, String)]) -> Vec<String> {
    after
        .iter()
        .filter(|(path, sha)| !before.iter().any(|(old_path, old_sha)| old_path == path && old_sha == sha))
        .map(|(path, _)| util::decode_lossy(path))
        .collect()
}

/// Recorded commit per submodule path from the index (after the operations above it equals HEAD).
/// Empty without a `.gitmodules`.
async fn recorded(core: &Core, repo_id: &str) -> Vec<(Vec<u8>, String)> {
    let Ok(root) = core.repo_path(repo_id) else { return Vec::new() };
    if !root.join(".gitmodules").is_file() {
        return Vec::new();
    }
    match gitlinks(core, repo_id).await {
        Ok(links) => links.into_iter().filter(|(_, _, conflicted)| !conflicted).map(|(path, sha, _)| (path, sha)).collect(),
        Err(e) => {
            log::warn!("Submodules not read before the operation: {}", e.message);
            Vec::new()
        }
    }
}

/// `RepoSettings.submodules_auto_update` (default: on).
fn enabled(core: &Core, repo_id: &str) -> bool {
    core.db
        .with(|c| db::repo_settings::get_all(c, repo_id))
        .ok()
        .and_then(|all| all.into_iter().find(|(key, _)| key == "submodulesAutoUpdate"))
        .and_then(|(_, value)| value.as_bool())
        .unwrap_or(true)
}

fn schedule(core: &Core, repo_id: &str, before: Vec<(Vec<u8>, String)>) {
    let has_modules = core.repo_path(repo_id).map(|root| root.join(".gitmodules").is_file()).unwrap_or(false);
    if (before.is_empty() && !has_modules) || !enabled(core, repo_id) {
        return;
    }
    let core = core.clone();
    let repo_id = repo_id.to_string();
    tokio::spawn(async move { update_changed(&core, &repo_id, before).await });
}

async fn update_changed(core: &Core, repo_id: &str, before: Vec<(Vec<u8>, String)>) {
    let job_id = format!("job-submodules-{}", util::new_id());
    let Ok(job) = core.start_job(&job_id, Some(repo_id)) else { return };
    let network = tokio::select! {
        guard = core.network_lock(repo_id) => Some(guard),
        _ = job.token().cancelled() => None,
    };
    let Some(_network) = network else {
        job.finish::<()>(&Err(crate::error::CoreError::cancelled()));
        return;
    };
    let guard = core.write_lock(repo_id).await;
    let paths = changed_paths(&before, &recorded(core, repo_id).await);
    if paths.is_empty() {
        drop(guard);
        job.finish::<()>(&Ok(()));
        return;
    }
    job.progress("Submodules", None, &format!("Updating {} …", paths.join(", ")));
    let result = run_update(core, repo_id, &job, &paths, true).await;
    drop(guard);
    core.emit_repo_changed(repo_id, &[RepoChange::Worktree, RepoChange::Config]);
    let event = SubmodulesUpdatedEvent {
        repo_id: repo_id.to_string(),
        ok: result.is_ok(),
        paths,
        message: result.as_ref().err().map(|e| redact::redact(&e.message)),
    };
    core.emit(names::SUBMODULES_UPDATED, &event);
    job.finish(&result);
}
