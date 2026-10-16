//! Reading what the repository occupies. Read-only; nothing here takes a lock.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use crate::app::Core;
use crate::db::{self, undo::UndoEntry};
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::model::{CleanupLfsEstimate, ObjectStats};
use crate::undo::BACKUP_REF_PREFIX;
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

/// An undo backup as the clean-up handles it.
#[derive(Debug, Clone)]
pub(super) struct Backup {
    pub entry_id: String,
    /// `undo_entries.created_at`, or for an orphaned group the newest committer date of its refs.
    pub created_at: Option<String>,
    pub orphaned: bool,
    /// Its refs below `refs/forkyard/undo/<id>/`.
    pub refs: Vec<String>,
}

/// Older than `cutoff` (ISO time in the format of `util::iso_days_ago`); an unknown age counts as older.
pub(super) fn is_older(created_at: Option<&str>, cutoff: &str) -> bool {
    created_at.map_or(true, |at| at < cutoff)
}

/// The undo entries of the repository and its listed worktrees.
pub(super) fn undo_entries(core: &Core, ids: &[String]) -> CoreResult<Vec<UndoEntry>> {
    core.db.with(|c| {
        let mut all = Vec::new();
        for id in ids {
            all.extend(db::undo::all_for_repo(c, id)?);
        }
        Ok(all)
    })
}

/// Undo backups of the repository and its listed worktrees (`ids`), plus orphaned groups of
/// `refs/forkyard/undo/<id>/…` whose id has no row in any repository; oldest first. Groups whose
/// id belongs to a repository outside `ids` are left out.
pub(super) async fn undo_backups(core: &Core, repo_id: &str, ids: &[String]) -> CoreResult<Vec<Backup>> {
    let out = core
        .git_for(repo_id)?
        .args(["for-each-ref", "--format=%(refname)%00%(committerdate:unix)", BACKUP_REF_PREFIX])
        .read_only()
        .no_log()
        .run()
        .await?;
    // id → (refs, newest commit time)
    let mut groups: BTreeMap<String, (Vec<String>, Option<i64>)> = BTreeMap::new();
    for line in out.stdout_lines() {
        let mut fields = line.split(|&b| b == 0);
        let name = util::decode_lossy(fields.next().unwrap_or_default());
        let time = fields.next().and_then(|field| std::str::from_utf8(field).ok()).and_then(|field| field.trim().parse::<i64>().ok());
        let Some(id) = name.strip_prefix(BACKUP_REF_PREFIX).and_then(|rest| rest.split('/').next()).filter(|id| !id.is_empty()) else {
            continue;
        };
        let group = groups.entry(id.to_string()).or_default();
        group.0.push(name.clone());
        group.1 = group.1.max(time);
    }
    let mut backups = Vec::new();
    let mut listed = HashSet::new();
    for entry in undo_entries(core, ids)? {
        let refs = groups.get(&entry.id).map(|group| group.0.clone()).unwrap_or_default();
        listed.insert(entry.id.clone());
        backups.push(Backup { entry_id: entry.id, created_at: Some(entry.created_at), orphaned: false, refs });
    }
    for (id, (refs, time)) in groups {
        if listed.contains(&id) || core.db.with(|c| db::undo::get(c, &id))?.is_some() {
            continue;
        }
        backups.push(Backup { entry_id: id, created_at: time.map(util::unix_to_iso), orphaned: true, refs });
    }
    backups.sort_by(|a, b| a.created_at.cmp(&b.created_at).then_with(|| a.entry_id.cmp(&b.entry_id)));
    Ok(backups)
}

/// The LFS object folder: `lfs.storage` (relative paths below the common directory) or `<common>/lfs`, then `objects`.
pub(super) async fn lfs_objects_dir(core: &Core, repo_id: &str, common: &Path) -> CoreResult<PathBuf> {
    let out = core.git_for(repo_id)?.args(["config", "--get", "lfs.storage"]).read_only().no_log().run_raw().await?;
    let configured = if out.success() { out.stdout_text().trim().to_string() } else { String::new() };
    let storage = if configured.is_empty() {
        common.join("lfs")
    } else {
        let path = PathBuf::from(&configured);
        if path.is_absolute() {
            path
        } else {
            common.join(path)
        }
    };
    Ok(storage.join("objects"))
}

/// Bytes of all files below `dir` (0 if it is missing), off the async threads.
pub(super) async fn dir_size(dir: PathBuf) -> u64 {
    tokio::task::spawn_blocking(move || {
        let mut files = Vec::new();
        files_below(&dir, &mut files);
        files.iter().filter_map(|file| std::fs::metadata(file).ok()).map(|meta| meta.len()).sum()
    })
    .await
    .unwrap_or(0)
}

/// LFS cache size when Git LFS is installed and the repository uses it (patterns in
/// `.gitattributes` or files in the cache); `None` otherwise – the dialog then hides LFS.
pub(super) async fn lfs_cache(core: &Core, repo_id: &str, common: &Path) -> CoreResult<Option<u64>> {
    let status = crate::commands::lfs::lfs_status(core, repo_id.to_string()).await?;
    if !status.installed {
        return Ok(None);
    }
    let bytes = dir_size(lfs_objects_dir(core, repo_id, common).await?).await;
    if status.patterns.is_empty() && bytes == 0 {
        return Ok(None);
    }
    Ok(Some(bytes))
}

/// Count and bytes from Git LFS's summary “2 files would be pruned (12 KB), done.” (decimal
/// units, as Git LFS prints them). Without such a line nothing would be pruned.
pub(super) fn parse_lfs_dry_run(text: &str) -> CleanupLfsEstimate {
    const MARKER: &str = " would be pruned (";
    for line in text.split(['\n', '\r']) {
        let Some(at) = line.find(MARKER) else { continue };
        let files = line[..at].split_whitespace().rev().nth(1).and_then(|count| count.parse().ok()).unwrap_or(0);
        let size = line[at + MARKER.len()..].split(')').next().unwrap_or_default();
        let mut parts = size.split_whitespace();
        let number: f64 = parts.next().and_then(|value| value.parse().ok()).unwrap_or(0.0);
        let factor = match parts.next().unwrap_or("B") {
            "KB" => 1e3,
            "MB" => 1e6,
            "GB" => 1e9,
            "TB" => 1e12,
            "PB" => 1e15,
            _ => 1.0,
        };
        return CleanupLfsEstimate { files, bytes: (number * factor).round() as u64 };
    }
    CleanupLfsEstimate { files: 0, bytes: 0 }
}

/// `git lfs prune --dry-run`: what the LFS step would free. `unsupported` without Git LFS.
pub(super) async fn lfs_estimate(core: &Core, repo_id: &str) -> CoreResult<CleanupLfsEstimate> {
    if !crate::commands::lfs::lfs_status(core, repo_id.to_string()).await?.installed {
        return Err(crate::commands::lfs::not_installed());
    }
    let out = core.git_for(repo_id)?.args(["lfs", "prune", "--dry-run"]).read_only().run().await?;
    Ok(parse_lfs_dry_run(&format!("{}\n{}", util::decode_lossy(&out.stdout), util::decode_lossy(&out.stderr))))
}
