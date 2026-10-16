//! Reading what the repository occupies. Read-only; nothing here takes a lock.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::app::Core;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::model::ObjectStats;
use crate::util;

/// `git count-objects -v` (values in KiB) as bytes. Unknown or missing fields count as 0.
pub(super) fn parse_count_objects(text: &str) -> ObjectStats {
    let mut fields: HashMap<&str, u64> = HashMap::new();
    for line in text.lines() {
        if let Some((key, value)) = line.split_once(':') {
            if let Ok(number) = value.trim().parse::<u64>() {
                fields.insert(key.trim(), number);
            }
        }
    }
    let get = |key: &str| fields.get(key).copied().unwrap_or(0);
    let loose_bytes = get("size").saturating_mul(1024);
    let pack_bytes = get("size-pack").saturating_mul(1024);
    let garbage_bytes = get("size-garbage").saturating_mul(1024);
    ObjectStats {
        loose_count: get("count"),
        loose_bytes,
        in_pack: get("in-pack"),
        packs: get("packs"),
        pack_bytes,
        garbage_count: get("garbage"),
        garbage_bytes,
        total_bytes: loose_bytes.saturating_add(pack_bytes).saturating_add(garbage_bytes),
    }
}

/// The repository's object numbers (for a worktree: those of the shared object folder).
pub(super) async fn count_objects(core: &Core, repo_id: &str) -> CoreResult<ObjectStats> {
    let out = core.git_for(repo_id)?.args(["count-objects", "-v"]).read_only().no_log().run().await?;
    Ok(parse_count_objects(&out.stdout_text()))
}

/// The common Git directory (for a worktree: the one of the main repository).
pub(super) async fn common_dir(core: &Core, repo_id: &str) -> CoreResult<PathBuf> {
    let root = core.repo_path(repo_id)?;
    crate::commands::trust::common_dir(core, &root).await.ok_or_else(|| CoreError::not_a_repo(util::display_path(&root)))
}

/// Age from which the preview counts reflog entries and „Reflog kürzen“ removes them.
pub(super) const REFLOG_DAYS: i64 = 90;
/// Time the preview may spend counting reflog entries.
pub(super) const REFLOG_BUDGET: Duration = Duration::from_secs(2);

/// Time of a reflog line `<old> <new> <name> <<email>> <seconds> <zone>\t<message>`.
pub(super) fn reflog_time(line: &[u8]) -> Option<i64> {
    let head = line.split(|&b| b == b'\t').next()?;
    let close = head.iter().rposition(|&b| b == b'>')?;
    let rest = std::str::from_utf8(&head[close + 1..]).ok()?;
    rest.split_whitespace().next()?.parse().ok()
}

/// `refs/heads/main@{1767225600}` (from `git log -g --date=unix --format=%gd`) → 1767225600.
pub(super) fn selector_time(record: &[u8]) -> Option<i64> {
    let text = std::str::from_utf8(record).ok()?.trim();
    let start = text.rfind("@{")? + 2;
    text[start..].strip_suffix('}')?.parse().ok()
}

/// All regular files below `dir` (none if it is missing). Symlinks are not followed.
fn files_below(dir: &Path, out: &mut Vec<PathBuf>) {
    let mut pending = vec![dir.to_path_buf()];
    while let Some(current) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&current) else { continue };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            if kind.is_dir() {
                pending.push(entry.path());
            } else if kind.is_file() {
                out.push(entry.path());
            }
        }
    }
}

/// Files backend: lines older than `cutoff` in `<common>/logs/**` and in every worktree's
/// `worktrees/<name>/logs/HEAD`. `None` once `deadline` has passed.
fn count_old_reflog_files(common: &Path, cutoff: i64, deadline: Instant) -> Option<u64> {
    let mut files = Vec::new();
    files_below(&common.join("logs"), &mut files);
    if let Ok(entries) = std::fs::read_dir(common.join("worktrees")) {
        for entry in entries.flatten() {
            let head = entry.path().join("logs").join("HEAD");
            if head.is_file() {
                files.push(head);
            }
        }
    }
    let mut old = 0u64;
    for file in files {
        if Instant::now() >= deadline {
            return None;
        }
        let Ok(bytes) = std::fs::read(&file) else { continue };
        old += bytes.split(|&b| b == b'\n').filter(|line| reflog_time(line).is_some_and(|time| time < cutoff)).count() as u64;
    }
    Some(old)
}

/// Whether the refs live in a reftable (Git 2.45+) instead of files.
async fn uses_reftable(core: &Core, repo_id: &str) -> CoreResult<bool> {
    let out = core.git_for(repo_id)?.args(["config", "--get", "extensions.refStorage"]).read_only().no_log().run_raw().await?;
    Ok(out.success() && out.stdout_text().trim().eq_ignore_ascii_case("reftable"))
}

/// Reftable backend: `git reflog list`, then the entry times of each ref. `None` past `deadline`.
async fn count_old_reflog_reftable(core: &Core, repo_id: &str, cutoff: i64, deadline: Instant) -> CoreResult<Option<u64>> {
    let listed = core.git_for(repo_id)?.args(["reflog", "list"]).read_only().no_log().run_raw().await?;
    if !listed.success() {
        return Ok(None);
    }
    let mut old = 0u64;
    for name in listed.stdout_lines() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Ok(None);
        }
        let name = util::decode_lossy(name);
        if name.is_empty() || name.starts_with('-') {
            continue;
        }
        let out = core
            .git_for(repo_id)?
            .args(["log", "-g", "--date=unix", "--format=%gd", "-z", "--end-of-options"])
            .arg(&name)
            .arg("--")
            .read_only()
            .no_log()
            .timeout(remaining)
            .run_raw()
            .await;
        match out {
            Ok(out) if out.success() => {
                old += out.stdout_z().iter().filter_map(|record| selector_time(record)).filter(|time| *time < cutoff).count() as u64;
            }
            Err(e) if e.code == ErrorCode::Timeout => return Ok(None),
            // A ref whose history cannot be walked (missing objects) is left out.
            _ => {}
        }
    }
    Ok(Some(old))
}

/// Reflog entries older than 90 days across all refs and worktrees; `None` = not counted within `budget`.
pub(super) async fn count_old_reflog(core: &Core, repo_id: &str, common: &Path, budget: Duration) -> CoreResult<Option<u64>> {
    let cutoff = chrono::Utc::now().timestamp() - REFLOG_DAYS * 86_400;
    let deadline = Instant::now() + budget;
    if uses_reftable(core, repo_id).await? {
        return count_old_reflog_reftable(core, repo_id, cutoff, deadline).await;
    }
    let common = common.to_path_buf();
    Ok(tokio::task::spawn_blocking(move || count_old_reflog_files(&common, cutoff, deadline)).await.unwrap_or(None))
}
