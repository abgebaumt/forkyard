//! Submodules follow along: after a checkout, pull, merge, cherry-pick, revert, hard reset or a
//! finished rebase, submodules whose recorded commit changed are brought to it
//! (`git submodule update --init --recursive`). This runs as a follow-up job in the same queue –
//! network lock, then write lock – so the main operation answers right away. A failure is a warning
//! (event `submodules:updated` with `ok: false`, plus the activity log of the Git call), never an
//! error of the main operation. A submodule whose detached HEAD – or that of a submodule nested in
//! it – holds commits that no branch, tag or remote branch contains is left where it is and
//! reported the same way, so nothing is orphaned. Network access uses the usual credential prompts; Git's
//! `protocol.allow` defaults stay as they are. Repository setting `submodulesAutoUpdate` (default on).

use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;

use crate::app::Core;
use crate::commands::status;
use crate::db;
use crate::error::CoreResult;
use crate::events::names;
use crate::git::redact;
use crate::model::{BisectStatus, OpResult, RefsSnapshot, RepoChange, Status, SubmodulesUpdatedEvent, UndoState};
use crate::util;

use super::{gitlinks, read_sub_head, run_update, sub_git_dir};

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

impl Concluded for RefsSnapshot {
    fn concluded(&self) -> bool {
        true
    }
}

impl Concluded for BisectStatus {
    fn concluded(&self) -> bool {
        true
    }
}

impl Concluded for UndoState {
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

/// The submodule at `raw` – or one nested in it, which `submodule update --recursive` moves too –
/// has a detached HEAD that is neither the commit recorded before (`old`) nor the one recorded now
/// (`new`) and holds commits that no branch, tag or remote branch contains: the update would leave
/// them reachable only from the reflog. Unreadable counts as yes.
async fn leaves_commits_behind(core: &Core, repo_id: &str, raw: &[u8], old: Option<&str>, new: &str) -> bool {
    let Ok(root) = core.repo_path(repo_id) else { return true };
    orphans_below(core, repo_id, util::join_from_git(&root, raw), old.map(str::to_string), Some(new.to_string())).await
}

/// `leaves_commits_behind` for the submodule checked out at `sub_root` and, recursively, the
/// submodules inside it. `new` is `None` when the commit the parent moves to is not known locally
/// yet (still to be fetched): then only `old` exempts a detached HEAD.
fn orphans_below<'a>(
    core: &'a Core,
    repo_id: &'a str,
    sub_root: PathBuf,
    old: Option<String>,
    new: Option<String>,
) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
    Box::pin(async move {
        let Some(git_dir) = sub_git_dir(&sub_root) else { return false };
        if let (None, Some(head)) = read_sub_head(&git_dir) {
            let recorded = Some(&head) == new.as_ref() || Some(&head) == old.as_ref();
            if !recorded && !held_by_ref(core, repo_id, &sub_root, &head).await {
                return true;
            }
        }
        if !sub_root.join(".gitmodules").is_file() {
            return false;
        }
        let Some(current) = nested_links(core, repo_id, &sub_root).await else { return true };
        let next = match &new {
            Some(rev) => nested_links_at(core, repo_id, &sub_root, rev).await,
            None => None,
        };
        for (path, current_sha) in current {
            let next_sha = next.as_ref().and_then(|links| links.iter().find(|(known, _)| *known == path).map(|(_, sha)| sha.clone()));
            if orphans_below(core, repo_id, util::join_from_git(&sub_root, &path), Some(current_sha), next_sha).await {
                return true;
            }
        }
        false
    })
}

/// Every commit up to `head` is contained in a branch, tag or remote branch of the submodule.
async fn held_by_ref(core: &Core, repo_id: &str, sub_root: &Path, head: &str) -> bool {
    let counted = core
        .git
        .cmd(sub_root)
        .repo(repo_id)
        .read_only()
        .no_log()
        .args(["rev-list", "--count", head, "--not", "--branches", "--tags", "--remotes"])
        .run_raw()
        .await;
    counted.ok().filter(|out| out.success()).is_some_and(|out| out.stdout_text().trim() == "0")
}

/// Gitlinks in the index of the submodule at `sub_root` (`ls-files --stage -z`, stage 0 and the
/// first of a conflict). `None` = unreadable.
async fn nested_links(core: &Core, repo_id: &str, sub_root: &Path) -> Option<Vec<(Vec<u8>, String)>> {
    let out = core.git.cmd(sub_root).repo(repo_id).read_only().no_log().args(["ls-files", "--stage", "-z"]).run_raw().await.ok()?;
    if !out.success() {
        return None;
    }
    let mut links: Vec<(Vec<u8>, String)> = Vec::new();
    for record in util::split_z(&out.stdout) {
        // `<mode> <object> <stage>TAB<path>`
        let Some(tab) = record.iter().position(|&byte| byte == b'\t') else { continue };
        let meta = util::decode_lossy(&record[..tab]);
        let mut fields = meta.split(' ');
        let (Some("160000"), Some(sha)) = (fields.next(), fields.next()) else { continue };
        let path = record[tab + 1..].to_vec();
        if !links.iter().any(|(known, _)| *known == path) {
            links.push((path, sha.to_string()));
        }
    }
    Some(links)
}

/// Gitlinks recorded in the tree of `rev` inside the submodule; `None` if `rev` is not there yet.
async fn nested_links_at(core: &Core, repo_id: &str, sub_root: &Path, rev: &str) -> Option<Vec<(Vec<u8>, String)>> {
    let out = core
        .git
        .cmd(sub_root)
        .repo(repo_id)
        .read_only()
        .no_log()
        .args(["ls-tree", "-r", "-z", "--full-tree", rev])
        .run_raw()
        .await
        .ok()?;
    out.success().then(|| tree_gitlinks(&out.stdout))
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
    let after = recorded(core, repo_id).await;
    let paths = changed_paths(&before, &after);
    if paths.is_empty() {
        drop(guard);
        job.finish::<()>(&Ok(()));
        return;
    }
    // Never move a submodule away from commits of its own that nothing else holds (hard rule 6).
    let mut kept = Vec::new();
    let mut moved = Vec::new();
    for (raw, sha) in &after {
        let path = util::decode_lossy(raw);
        if !paths.contains(&path) {
            continue;
        }
        let old = before.iter().find(|(old_path, _)| old_path == raw).map(|(_, old_sha)| old_sha.as_str());
        if leaves_commits_behind(core, repo_id, raw, old, sha).await {
            kept.push(path);
        } else {
            moved.push(path);
        }
    }
    let result = if moved.is_empty() {
        Ok(())
    } else {
        job.progress("Submodules", None, &format!("Updating {} …", moved.join(", ")));
        run_update(core, repo_id, &job, &moved, true).await
    };
    drop(guard);
    core.emit_repo_changed(repo_id, &[RepoChange::Worktree, RepoChange::Config]);
    let mut message = result.as_ref().err().map(|e| redact::redact(&e.message));
    if !kept.is_empty() {
        let note = format!(
            "{} not updated: it or a submodule inside it has commits checked out that are not on any branch, tag or remote branch. Create a branch for them there, then update it.",
            kept.join(", ")
        );
        message = Some(message.map_or(note.clone(), |error| format!("{error} {note}")));
    }
    let event = SubmodulesUpdatedEvent {
        repo_id: repo_id.to_string(),
        ok: result.is_ok() && kept.is_empty(),
        paths,
        message,
    };
    core.emit(names::SUBMODULES_UPDATED, &event);
    job.finish(&result);
}
