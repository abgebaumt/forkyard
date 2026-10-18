//! Status of the working directory.
//!
//! Reusable by other commands: `read_status` (everything), plus the individual parts
//! `parse_porcelain_v2`, `parse_numstat_z`, `read_operation`, `git_dir`, `identity_set`
//! and `read_token`.

use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::app::Core;
use crate::commands::refs::short_ref_name;
use crate::error::{CoreError, CoreResult};
use crate::git::GitCmd;
use crate::model::{ConflictKind, FileArea, FileChange, FileStatus, Head, Operation, OperationKind, Status, UpstreamState};
use crate::util;

/// At most this many untracked files are opened (binary detection, line counting).
const MAX_UNTRACKED_INSPECTED: usize = 2000;
/// Up to this size the lines of an untracked file are counted.
const MAX_COUNTED_BYTES: u64 = 1024 * 1024;
/// An LFS pointer is never larger.
const LFS_POINTER_MAX_BYTES: u64 = 1024;
/// `git diff` writes the index back when it finds files with only a changed timestamp –
/// despite `GIT_OPTIONAL_LOCKS=0`. That could block a write action.
const NO_INDEX_REFRESH: [&str; 2] = ["-c", "diff.autoRefreshIndex=false"];
const LFS_POINTER_PREFIX: &[u8] = b"version https://git-lfs.github.com/spec/v1";

/// `git status --porcelain=v2 -z --branch` plus the running operation from `.git`.
pub async fn status_get(core: &Core, repo_id: String) -> CoreResult<Status> {
    read_status(core, &repo_id).await
}

/// Reads the whole status. Pure read command: takes no lock, does not write the index
/// back (`GIT_OPTIONAL_LOCKS=0`) and does not log.
pub async fn read_status(core: &Core, repo_id: &str) -> CoreResult<Status> {
    let path = core.repo_path(repo_id)?;
    let (status, unstaged, staged, index, identity_set) = tokio::join!(
        read_cmd(core, &path, repo_id)
            .args(["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--find-renames"])
            .run(),
        read_cmd(core, &path, repo_id).args(NO_INDEX_REFRESH).args(["diff", "--numstat", "-z", "--no-ext-diff"]).run(),
        read_cmd(core, &path, repo_id).args(NO_INDEX_REFRESH).args(["diff", "--cached", "--numstat", "-z", "-M", "--no-ext-diff"]).run(),
        read_cmd(core, &path, repo_id).args(["ls-files", "--stage", "-z"]).run(),
        identity_at(core, &path, repo_id),
    );
    let parsed = parse_porcelain_v2(&status?.stdout);
    // The line counts are an extra: if `git diff --numstat` fails on ONE file (locked by
    // another program, blob missing, invalid name on Windows), the list from `git status`
    // is still there – just without counts.
    let counts = |result: CoreResult<crate::git::GitOutput>, what: &str| match result {
        Ok(out) => parse_numstat_z(&out.stdout),
        Err(e) => {
            log::warn!("Line counts ({what}) not readable: {}", e.git_output.as_deref().unwrap_or(&e.message).trim());
            HashMap::new()
        }
    };
    let unstaged_counts = counts(unstaged, "nicht gestaged");
    let staged_counts = counts(staged, "gestaged");
    let head = parsed.head()?;
    let token = fingerprint(&head, &index?.stdout);

    let all_paths: Vec<&[u8]> = parsed.entries.iter().map(|e| e.path.as_slice()).collect();
    let untracked: Vec<Vec<u8>> = parsed
        .entries
        .iter()
        .filter(|e| e.kind == EntryKind::Untracked)
        .take(MAX_UNTRACKED_INSPECTED)
        .map(|e| e.path.clone())
        .collect();
    let (lfs_paths, untracked_info, operation) = tokio::join!(
        lfs_paths(core, &path, repo_id, &all_paths),
        inspect_untracked(path.clone(), untracked),
        operation_at(core, &path, repo_id, &head),
    );
    let lfs_paths = lfs_paths?;
    let operation = operation?;
    // What is already resolved in this operation is known to the index (the "resolve-undo" extension) – not
    // only to the UI's memory. Otherwise after a restart the banner would count "0 of 1" instead of
    // "1 of 2 conflicts resolved". It is only read while there is something to count.
    let has_conflicts = parsed.entries.iter().any(|e| e.kind == EntryKind::Unmerged);
    // A running `git am` is not an operation the app controls – but it must not keep quiet about it
    // either (otherwise the Commit panel would attribute the conflicts to a stash).
    let foreign_operation = if operation.is_none() && am_in_progress(core, &path, repo_id).await { Some("am".to_string()) } else { None };
    let resolved_conflicts = if operation.is_some() || has_conflicts {
        match read_cmd(core, &path, repo_id).args(["ls-files", "--resolve-undo", "-z"]).run().await {
            Ok(out) => parse_resolve_undo(&out.stdout),
            Err(e) => {
                log::warn!("Resolved conflicts not readable: {}", e.git_output.as_deref().unwrap_or(&e.message).trim());
                Vec::new()
            }
        }
    } else {
        Vec::new()
    };

    let mut out = Status {
        head,
        upstream: parsed.upstream.clone(),
        unstaged: Vec::new(),
        staged: Vec::new(),
        conflicted: Vec::new(),
        operation,
        resolved_conflicts,
        foreign_operation,
        left_behind: None,
        identity_set,
        token,
    };
    for entry in &parsed.entries {
        let is_lfs = lfs_paths.contains(&entry.path);
        let change = |status: FileStatus, area: FileArea, counts: Option<&LineCounts>, with_old_path: bool| FileChange {
            path: util::decode_lossy(&entry.path),
            old_path: entry.orig_path.as_deref().filter(|_| with_old_path).map(util::decode_lossy),
            status,
            area,
            is_binary: counts.is_some_and(|c| c.binary),
            is_lfs,
            added: counts.and_then(|c| c.added),
            removed: counts.and_then(|c| c.removed),
            conflict: None,
        };
        match entry.kind {
            EntryKind::Tracked => {
                if let Some(status) = status_from_code(entry.x) {
                    out.staged.push(change(status, FileArea::Staged, staged_counts.get(&entry.path), entry.x == b'R'));
                }
                if let Some(status) = status_from_code(entry.y) {
                    out.unstaged.push(change(status, FileArea::Unstaged, unstaged_counts.get(&entry.path), entry.y == b'R'));
                }
            }
            EntryKind::Unmerged => {
                let mut item = change(FileStatus::Conflicted, FileArea::Unstaged, None, false);
                item.conflict = Some(conflict_kind(entry.x, entry.y));
                out.conflicted.push(item);
            }
            EntryKind::Untracked => {
                let info = untracked_info.get(&entry.path);
                let mut item = change(FileStatus::Untracked, FileArea::Unstaged, None, false);
                item.is_binary = info.is_some_and(|i| i.binary);
                item.is_lfs = is_lfs || info.is_some_and(|i| i.lfs_pointer);
                item.added = info.and_then(|i| i.lines);
                item.removed = item.added.map(|_| 0);
                out.unstaged.push(item);
            }
        }
    }
    // Git returns tracked files sorted and untracked ones after them; the lists should be sorted throughout.
    out.unstaged.sort_by(|a, b| a.path.as_bytes().cmp(b.path.as_bytes()));
    Ok(out)
}

/// `git ls-files --resolve-undo -z`: one entry `<mode> <object> <stage>\t<path>\0` per resolved side.
/// Each path is returned once, in index order.
pub fn parse_resolve_undo(out: &[u8]) -> Vec<String> {
    let mut paths: Vec<String> = Vec::new();
    for record in out.split(|b| *b == 0).filter(|r| !r.is_empty()) {
        let Some(tab) = record.iter().position(|b| *b == b'\t') else { continue };
        let path = util::decode_lossy(&record[tab + 1..]);
        if paths.last() != Some(&path) && !paths.contains(&path) {
            paths.push(path);
        }
    }
    paths
}

fn read_cmd(core: &Core, path: &Path, repo_id: &str) -> GitCmd {
    core.git.cmd(path).repo(repo_id).read_only().no_log()
}

// ---------------------------------------------------------------------------
// Porcelain v2
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EntryKind {
    /// Lines `1` and `2`: modified, added, deleted, renamed.
    Tracked,
    /// Line `u`: conflict.
    Unmerged,
    /// Line `?`.
    Untracked,
}

/// An entry from `git status --porcelain=v2 -z`. Paths are Git's raw bytes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusEntry {
    pub kind: EntryKind,
    /// State in the index (`.` = unchanged); for conflicts "our" side.
    pub x: u8,
    /// State in the working directory; for conflicts "their" side.
    pub y: u8,
    pub path: Vec<u8>,
    /// For renames the old path.
    pub orig_path: Option<Vec<u8>>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedStatus {
    /// SHA of HEAD; `None` in a repository without a commit.
    pub oid: Option<String>,
    /// Current branch; `None` on a detached HEAD.
    pub branch: Option<String>,
    pub upstream: Option<UpstreamState>,
    pub entries: Vec<StatusEntry>,
}

impl ParsedStatus {
    pub fn head(&self) -> CoreResult<Head> {
        match (&self.branch, &self.oid) {
            (Some(branch), Some(sha)) => Ok(Head::Branch { branch: branch.clone(), sha: sha.clone() }),
            (None, Some(sha)) => Ok(Head::Detached { sha: sha.clone() }),
            (Some(branch), None) => Ok(Head::Unborn { branch: branch.clone() }),
            (None, None) => Err(CoreError::unknown("Could not read the repository's HEAD.")),
        }
    }
}

/// Parses the output of `git status --porcelain=v2 -z --branch`.
/// Unknown lines are skipped (the format may grow).
pub fn parse_porcelain_v2(stdout: &[u8]) -> ParsedStatus {
    let mut out = ParsedStatus::default();
    let mut upstream_name: Option<String> = None;
    let mut ahead_behind: Option<(u32, u32)> = None;
    let mut records = util::split_z(stdout);
    while let Some(record) = records.next() {
        if let Some(header) = record.strip_prefix(b"# ") {
            let text = util::decode_lossy(header);
            if let Some(oid) = text.strip_prefix("branch.oid ") {
                out.oid = (oid != "(initial)").then(|| oid.to_string());
            } else if let Some(name) = text.strip_prefix("branch.head ") {
                out.branch = (name != "(detached)").then(|| name.to_string());
            } else if let Some(name) = text.strip_prefix("branch.upstream ") {
                upstream_name = Some(name.to_string());
            } else if let Some(ab) = text.strip_prefix("branch.ab ") {
                let mut parts = ab.split(' ');
                let ahead = parts.next().and_then(|p| p.strip_prefix('+')).and_then(|p| p.parse().ok());
                let behind = parts.next().and_then(|p| p.strip_prefix('-')).and_then(|p| p.parse().ok());
                ahead_behind = ahead.zip(behind);
            }
            continue;
        }
        let Some((&tag, _)) = record.split_first() else { continue };
        match tag {
            b'1' => {
                // 1 XY sub mH mI mW hH hI path
                let fields: Vec<&[u8]> = record.splitn(9, |&b| b == b' ').collect();
                if let (Some(xy), Some(path)) = (fields.get(1).filter(|xy| xy.len() == 2), fields.get(8)) {
                    out.entries.push(StatusEntry { kind: EntryKind::Tracked, x: xy[0], y: xy[1], path: path.to_vec(), orig_path: None });
                }
            }
            b'2' => {
                // 2 XY sub mH mI mW hH hI Xscore path NUL origPath
                let fields: Vec<&[u8]> = record.splitn(10, |&b| b == b' ').collect();
                let orig = records.next();
                if let (Some(xy), Some(path)) = (fields.get(1).filter(|xy| xy.len() == 2), fields.get(9)) {
                    out.entries.push(StatusEntry {
                        kind: EntryKind::Tracked,
                        x: xy[0],
                        y: xy[1],
                        path: path.to_vec(),
                        orig_path: orig.map(<[u8]>::to_vec),
                    });
                }
            }
            b'u' => {
                // u XY sub m1 m2 m3 mW h1 h2 h3 path
                let fields: Vec<&[u8]> = record.splitn(11, |&b| b == b' ').collect();
                if let (Some(xy), Some(path)) = (fields.get(1).filter(|xy| xy.len() == 2), fields.get(10)) {
                    out.entries.push(StatusEntry { kind: EntryKind::Unmerged, x: xy[0], y: xy[1], path: path.to_vec(), orig_path: None });
                }
            }
            b'?' => {
                if let Some(path) = record.strip_prefix(b"? ") {
                    out.entries.push(StatusEntry { kind: EntryKind::Untracked, x: b'?', y: b'?', path: path.to_vec(), orig_path: None });
                }
            }
            _ => {}
        }
    }
    // If an upstream is set but gone, Git omits the branch.ab line.
    out.upstream = upstream_name.map(|name| {
        let (ahead, behind) = ahead_behind.unwrap_or((0, 0));
        UpstreamState { name, ahead, behind, gone: ahead_behind.is_none() }
    });
    out
}

/// Letter from XY → status; `.` (unchanged) yields `None`.
fn status_from_code(code: u8) -> Option<FileStatus> {
    match code {
        b'.' => None,
        b'A' | b'C' => Some(FileStatus::Added),
        b'D' => Some(FileStatus::Deleted),
        b'R' => Some(FileStatus::Renamed),
        // M, T (type change) and everything unknown.
        _ => Some(FileStatus::Modified),
    }
}

/// XY of a conflict entry → kind of conflict (X = us, Y = them).
pub fn conflict_kind(x: u8, y: u8) -> ConflictKind {
    match (x, y) {
        (b'D', b'D') => ConflictKind::BothDeleted,
        (b'A', b'U') => ConflictKind::AddedByUs,
        (b'U', b'D') => ConflictKind::DeletedByThem,
        (b'U', b'A') => ConflictKind::AddedByThem,
        (b'D', b'U') => ConflictKind::DeletedByUs,
        (b'A', b'A') => ConflictKind::BothAdded,
        _ => ConflictKind::BothModified,
    }
}

// ---------------------------------------------------------------------------
// numstat
// ---------------------------------------------------------------------------

/// Line counts of a file from `--numstat`. Git does not count binary files.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LineCounts {
    pub added: Option<u32>,
    pub removed: Option<u32>,
    pub binary: bool,
}

/// Parses `git diff --numstat -z`; the key is the (new) path in raw bytes.
pub fn parse_numstat_z(stdout: &[u8]) -> HashMap<Vec<u8>, LineCounts> {
    let mut out = HashMap::new();
    let mut records = util::split_z(stdout);
    while let Some(record) = records.next() {
        let mut fields = record.splitn(3, |&b| b == b'\t');
        let (Some(added), Some(removed), Some(path)) = (fields.next(), fields.next(), fields.next()) else { continue };
        // For renames the path field is empty; old and new path follow as records of their own.
        let path = if path.is_empty() {
            let _old = records.next();
            match records.next() {
                Some(new) => new,
                None => break,
            }
        } else {
            path
        };
        let number = |field: &[u8]| std::str::from_utf8(field).ok().and_then(|t| t.parse::<u32>().ok());
        out.insert(path.to_vec(), LineCounts { added: number(added), removed: number(removed), binary: added == b"-" && removed == b"-" });
    }
    out
}

// ---------------------------------------------------------------------------
// LFS and untracked files
// ---------------------------------------------------------------------------

/// Paths to which the attribute `filter=lfs` applies (`git check-attr`).
async fn lfs_paths(core: &Core, path: &Path, repo_id: &str, paths: &[&[u8]]) -> CoreResult<HashSet<Vec<u8>>> {
    let mut out = HashSet::new();
    if paths.is_empty() {
        return Ok(out);
    }
    let mut stdin = Vec::new();
    for p in paths {
        stdin.extend_from_slice(p);
        stdin.push(0);
    }
    let result = read_cmd(core, path, repo_id).args(["check-attr", "-z", "--stdin", "filter"]).stdin(stdin).run().await?;
    // Output: path NUL attribute NUL value NUL.
    let fields = result.stdout_z();
    for triple in fields.chunks(3) {
        if let [p, _, value] = triple {
            if *value == b"lfs" {
                out.insert(p.to_vec());
            }
        }
    }
    Ok(out)
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct UntrackedInfo {
    binary: bool,
    lfs_pointer: bool,
    /// `None`: not counted (binary, too large, not readable).
    lines: Option<u32>,
}

async fn inspect_untracked(root: PathBuf, paths: Vec<Vec<u8>>) -> HashMap<Vec<u8>, UntrackedInfo> {
    if paths.is_empty() {
        return HashMap::new();
    }
    tokio::task::spawn_blocking(move || {
        paths
            .into_iter()
            .map(|rel| {
                let info = inspect_file(&util::join_from_git(&root, &rel)).unwrap_or_default();
                (rel, info)
            })
            .collect()
    })
    .await
    .unwrap_or_default()
}

fn inspect_file(path: &Path) -> Option<UntrackedInfo> {
    let meta = std::fs::symlink_metadata(path).ok()?;
    if !meta.is_file() {
        return None;
    }
    let mut file = std::fs::File::open(path).ok()?;
    let limit = meta.len().min(MAX_COUNTED_BYTES);
    let mut data = Vec::with_capacity(limit as usize);
    file.by_ref().take(MAX_COUNTED_BYTES).read_to_end(&mut data).ok()?;
    let binary = util::looks_binary(&data);
    let complete = meta.len() <= MAX_COUNTED_BYTES;
    let lines = (!binary && complete).then(|| {
        let newlines = data.iter().filter(|&&b| b == b'\n').count();
        let open_last_line = data.last().is_some_and(|&b| b != b'\n');
        u32::try_from(newlines + usize::from(open_last_line)).unwrap_or(u32::MAX)
    });
    Some(UntrackedInfo { binary, lfs_pointer: meta.len() <= LFS_POINTER_MAX_BYTES && data.starts_with(LFS_POINTER_PREFIX), lines })
}

// ---------------------------------------------------------------------------
// Identity and fingerprint
// ---------------------------------------------------------------------------

/// `user.name` and `user.email` are set (local, global or system).
pub async fn identity_set(core: &Core, repo_id: &str) -> CoreResult<bool> {
    let path = core.repo_path(repo_id)?;
    Ok(identity_at(core, &path, repo_id).await)
}

async fn identity_at(core: &Core, path: &Path, repo_id: &str) -> bool {
    let (name, email) = tokio::join!(
        read_cmd(core, path, repo_id).args(["config", "--get", "user.name"]).run_raw(),
        read_cmd(core, path, repo_id).args(["config", "--get", "user.email"]).run_raw(),
    );
    let is_set = |out: &CoreResult<crate::git::GitOutput>| matches!(out, Ok(o) if o.success() && !o.stdout_text().trim().is_empty());
    is_set(&name) && is_set(&email)
}

/// Fingerprint of HEAD and index, as it is in `Status.token`. Write commands
/// compare it with the UI's `expect` and abort with `stale_state` if it
/// differs.
pub async fn read_token(core: &Core, repo_id: &str) -> CoreResult<String> {
    let path = core.repo_path(repo_id)?;
    let (head, index) = tokio::join!(
        crate::commands::refs::read_head(core, repo_id),
        read_cmd(core, &path, repo_id).args(["ls-files", "--stage", "-z"]).run(),
    );
    Ok(fingerprint(&head?, &index?.stdout))
}

/// 128-bit FNV-1a over HEAD (branch and SHA) and the index content
/// (`git ls-files --stage -z`: mode, blob, stage, path per entry). Index timestamps
/// are not included, so a mere refresh does not change the value.
fn fingerprint(head: &Head, index_listing: &[u8]) -> String {
    const OFFSET: u128 = 0x6c62272e07bb014262b821756295c58d;
    const PRIME: u128 = 0x0000000001000000000000000000013b;
    let head_line = match head {
        Head::Branch { branch, sha } => format!("branch\0{branch}\0{sha}\0"),
        Head::Detached { sha } => format!("detached\0{sha}\0"),
        Head::Unborn { branch } => format!("unborn\0{branch}\0"),
    };
    let mut hash = OFFSET;
    for &byte in head_line.as_bytes().iter().chain(index_listing) {
        hash ^= u128::from(byte);
        hash = hash.wrapping_mul(PRIME);
    }
    format!("{hash:032x}")
}

// ---------------------------------------------------------------------------
// Running operation
// ---------------------------------------------------------------------------

/// The Git directory of the working directory. In a worktree `.git` is a
/// file pointing to `<main>/.git/worktrees/<name>`; MERGE_HEAD etc. live there.
pub async fn git_dir(core: &Core, repo_id: &str) -> CoreResult<PathBuf> {
    let path = core.repo_path(repo_id)?;
    git_dir_at(core, &path, repo_id).await
}

pub(crate) async fn git_dir_at(core: &Core, path: &Path, repo_id: &str) -> CoreResult<PathBuf> {
    let dot_git = path.join(".git");
    if dot_git.is_dir() {
        return Ok(dot_git);
    }
    if let Ok(content) = std::fs::read(&dot_git) {
        if let Some(target) = content.strip_prefix(b"gitdir:") {
            let target = util::bytes_to_path(trim_bytes(target));
            let resolved = if target.is_absolute() { target } else { path.join(target) };
            if resolved.is_dir() {
                return Ok(resolved);
            }
        }
    }
    let out = read_cmd(core, path, repo_id).args(["rev-parse", "--absolute-git-dir"]).run().await?;
    Ok(util::native_path(&util::bytes_to_path(trim_bytes(&out.stdout))))
}

/// Whether a `git am` (applying patches) is in progress: `rebase-apply/applying` in the Git directory.
async fn am_in_progress(core: &Core, path: &Path, repo_id: &str) -> bool {
    match git_dir_at(core, path, repo_id).await {
        Ok(dir) => dir.join("rebase-apply").join("applying").exists(),
        Err(_) => false,
    }
}

/// Like [`am_in_progress`], for commands that only have the repo ID.
pub async fn foreign_am(core: &Core, repo_id: &str) -> bool {
    match core.repo_path(repo_id) {
        Ok(path) => am_in_progress(core, &path, repo_id).await,
        Err(_) => false,
    }
}

/// Running merge, rebase, cherry-pick or revert, read from the Git directory.
pub async fn read_operation(core: &Core, repo_id: &str) -> CoreResult<Option<Operation>> {
    let path = core.repo_path(repo_id)?;
    let head = crate::commands::refs::read_head(core, repo_id).await?;
    operation_at(core, &path, repo_id, &head).await
}

async fn operation_at(core: &Core, path: &Path, repo_id: &str, head: &Head) -> CoreResult<Option<Operation>> {
    let dir = git_dir_at(core, path, repo_id).await?;
    let current_branch = match head {
        Head::Branch { branch, .. } | Head::Unborn { branch } => Some(branch.clone()),
        Head::Detached { .. } => None,
    };
    let merge_msg = || read_text(&dir.join("MERGE_MSG")).and_then(|m| clean_message(&m));

    // Rebase first: during a rebase conflict CHERRY_PICK_HEAD is there as well.
    let rebase_merge = dir.join("rebase-merge");
    let rebase_apply = dir.join("rebase-apply");
    let rebase = if rebase_merge.is_dir() {
        Some((rebase_merge.clone(), "msgnum", "end"))
    } else if rebase_apply.is_dir() && !rebase_apply.join("applying").exists() {
        // With "applying" it is `git am`, not a rebase.
        Some((rebase_apply, "next", "last"))
    } else {
        None
    };
    if let Some((state, step_file, total_file)) = rebase {
        let head_name = read_line(&state.join("head-name")).filter(|n| n.starts_with("refs/"));
        let source = match &head_name {
            Some(full) => Some(short_ref_name(full).to_string()),
            None => read_line(&state.join("orig-head")).map(|sha| short_sha(&sha)),
        };
        let target = match read_line(&state.join("onto")) {
            Some(onto) => Some(name_for_commit(core, path, repo_id, &onto, source.as_deref()).await),
            None => None,
        };
        let message = read_text(&state.join("message")).and_then(|m| clean_message(&m)).or_else(merge_msg);
        let (step, total_steps) = rebase_commit_steps(&state).unwrap_or_else(|| {
            (
                read_line(&state.join(step_file)).and_then(|n| n.parse().ok()),
                read_line(&state.join(total_file)).and_then(|n| n.parse().ok()),
            )
        });
        return Ok(Some(Operation { kind: OperationKind::Rebase, source, target, step, total_steps, message }));
    }

    if let Some(merge_head) = read_line(&dir.join("MERGE_HEAD")) {
        let source = name_for_commit(core, path, repo_id, &merge_head, current_branch.as_deref()).await;
        return Ok(Some(Operation {
            kind: OperationKind::Merge,
            source: Some(source),
            target: current_branch,
            step: None,
            total_steps: None,
            message: merge_msg(),
        }));
    }

    let cherry_pick = read_line(&dir.join("CHERRY_PICK_HEAD"));
    let revert = read_line(&dir.join("REVERT_HEAD"));
    let todo = read_text(&dir.join("sequencer").join("todo")).map(|t| todo_lines(&t)).unwrap_or_default();
    // Between two steps of a sequence there is no *_HEAD, only the list of open steps.
    let kind = if cherry_pick.is_some() {
        OperationKind::CherryPick
    } else if revert.is_some() {
        OperationKind::Revert
    } else {
        match todo.first().map(|(command, _)| command.as_str()) {
            Some("pick" | "p") => OperationKind::CherryPick,
            Some("revert") => OperationKind::Revert,
            _ => return Ok(None),
        }
    };
    let stopped_at = cherry_pick.or(revert);
    // The step at which Git stopped is still at the top of the list. If *_HEAD is missing,
    // it has already been committed by hand and counts as done.
    let open = if stopped_at.is_some() { &todo[..] } else { todo.get(1..).unwrap_or_default() };
    let source = stopped_at.as_deref().map(short_sha).or_else(|| open.first().map(|(_, sha)| short_sha(sha)));
    let (step, total_steps) = if todo.is_empty() {
        (None, None)
    } else {
        // Done are the commits since the start of the sequence.
        let done = match read_line(&dir.join("sequencer").join("head")) {
            Some(start) => count_commits_since(core, path, repo_id, &start).await,
            None => None,
        };
        let open_count = u32::try_from(open.len()).unwrap_or(u32::MAX);
        match done {
            Some(done) => (Some(done.saturating_add(open_count.min(1))), Some(done.saturating_add(open_count))),
            None => (None, None),
        }
    };
    Ok(Some(Operation { kind, source, target: current_branch, step, total_steps, message: merge_msg() }))
}

/// Readable name for a commit: local branch, otherwise remote branch, otherwise short SHA.
/// `exclude` is a branch that cannot be meant (e.g. the current one).
async fn name_for_commit(core: &Core, path: &Path, repo_id: &str, sha: &str, exclude: Option<&str>) -> String {
    let listed = read_cmd(core, path, repo_id)
        .args(["for-each-ref", "--format=%(refname)", "--points-at", sha, "refs/heads", "refs/remotes"])
        .run_raw()
        .await;
    let names: Vec<String> = match &listed {
        Ok(out) if out.success() => out.stdout_lines().into_iter().map(util::decode_lossy).collect(),
        _ => Vec::new(),
    };
    let pick = |prefix: &str| {
        names
            .iter()
            .filter_map(|full| full.strip_prefix(prefix))
            .find(|short| Some(*short) != exclude && !short.ends_with("/HEAD"))
            .map(str::to_string)
    };
    pick("refs/heads/").or_else(|| pick("refs/remotes/")).unwrap_or_else(|| short_sha(sha))
}

async fn count_commits_since(core: &Core, path: &Path, repo_id: &str, start: &str) -> Option<u32> {
    let range = format!("{start}..HEAD");
    let out = read_cmd(core, path, repo_id).args(["rev-list", "--count", &range]).run_raw().await.ok()?;
    if !out.success() {
        return None;
    }
    out.stdout_text().trim().parse().ok()
}

/// Lines of the sequencer list as (command, SHA); comments and empty lines are dropped.
/// Step and total of an interactive or merge rebase, counting only the commits it replays.
/// Git's `msgnum`/`end` also count `update-ref` (`--update-refs`), `exec`, `label`, `reset` and
/// `break` lines, so the third of three commits would read "4 of 4". `None` without `done` or
/// `git-rebase-todo` (then Git's own counters apply).
fn rebase_commit_steps(state: &Path) -> Option<(Option<u32>, Option<u32>)> {
    let done = read_text(&state.join("done"))?;
    let todo = read_text(&state.join("git-rebase-todo"))?;
    let commits = |list: &str| -> u32 {
        todo_lines(list).iter().filter(|(command, _)| is_commit_command(command)).count() as u32
    };
    let step = commits(&done);
    let total = step + commits(&todo);
    Some((Some(step), Some(total)))
}

/// Todo commands that replay or create a commit (long and short forms).
fn is_commit_command(command: &str) -> bool {
    matches!(
        command,
        "pick" | "p" | "reword" | "r" | "edit" | "e" | "squash" | "s" | "fixup" | "f" | "merge" | "m"
    )
}

fn todo_lines(todo: &str) -> Vec<(String, String)> {
    todo.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(|l| {
            let mut parts = l.split_whitespace();
            Some((parts.next()?.to_string(), parts.next()?.to_string()))
        })
        .collect()
}

fn short_sha(sha: &str) -> String {
    sha.chars().take(7).collect()
}

fn trim_bytes(bytes: &[u8]) -> &[u8] {
    let start = bytes.iter().position(|b| !b.is_ascii_whitespace()).unwrap_or(bytes.len());
    let end = bytes.iter().rposition(|b| !b.is_ascii_whitespace()).map_or(start, |i| i + 1);
    &bytes[start..end]
}

fn read_text(path: &Path) -> Option<String> {
    std::fs::read(path).ok().map(|bytes| util::decode_lossy(&bytes))
}

/// First line of a state file, without whitespace; `None` if it is missing or empty.
fn read_line(path: &Path) -> Option<String> {
    let text = read_text(path)?;
    let line = text.lines().next()?.trim();
    (!line.is_empty()).then(|| line.to_string())
}

/// Prepared message without the comment lines Git appends (e.g. the conflict list).
fn clean_message(raw: &str) -> Option<String> {
    let kept: Vec<&str> = raw.lines().filter(|l| !l.starts_with('#')).collect();
    let text = kept.join("\n").trim().to_string();
    (!text.is_empty()).then_some(text)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use crate::events::names;
    use crate::testkit::{TestCore, TestRepo};

    async fn status_of(tc: &TestCore, repo: &TestRepo) -> Status {
        let id = tc.open(repo).await.repo.id;
        read_status(tc, &id).await.unwrap()
    }

    fn find<'a>(list: &'a [FileChange], path: &str) -> &'a FileChange {
        list.iter().find(|f| f.path == path).unwrap_or_else(|| panic!("{path} missing in {list:?}"))
    }

    fn paths(list: &[FileChange]) -> Vec<&str> {
        list.iter().map(|f| f.path.as_str()).collect()
    }

    #[tokio::test]
    async fn clean_repo() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let id = tc.open(&repo).await.repo.id;
        tc.events.clear();

        let status = status_get(&tc, id).await.unwrap();
        assert_eq!(status.head, Head::Branch { branch: "main".into(), sha: repo.head() });
        assert_eq!(status.upstream, None);
        assert!(status.unstaged.is_empty() && status.staged.is_empty() && status.conflicted.is_empty());
        assert_eq!(status.operation, None);
        assert!(status.identity_set);
        assert_eq!(status.token.len(), 32);
        // Reading does not log and reports no change.
        assert_eq!(tc.events.count(names::LOG_APPENDED), 0);
        assert_eq!(tc.events.count(names::REPO_CHANGED), 0);
    }

    #[tokio::test]
    async fn unstaged_staged_and_both() {
        let tc = TestCore::new().await;
        let repo = TestRepo::new();
        repo.write_file("nur-unstaged.txt", "a\nb\nc\n");
        repo.write_file("nur-staged.txt", "a\nb\nc\n");
        repo.write_file("beides.txt", "a\nb\nc\n");
        repo.commit("Basis");
        repo.write_file("nur-unstaged.txt", "a\nB\nc\nd\n");
        repo.write_file("nur-staged.txt", "a\nc\n");
        repo.git(&["add", "nur-staged.txt"]);
        repo.write_file("beides.txt", "a\nb\nc\nd\n");
        repo.git(&["add", "beides.txt"]);
        repo.write_file("beides.txt", "x\nb\nc\nd\ne\nf\n");
        repo.write_file("neu-staged.txt", "eins\nzwei\n");
        repo.git(&["add", "neu-staged.txt"]);

        let status = status_of(&tc, &repo).await;
        assert_eq!(paths(&status.unstaged), vec!["beides.txt", "nur-unstaged.txt"]);
        assert_eq!(paths(&status.staged), vec!["beides.txt", "neu-staged.txt", "nur-staged.txt"]);
        assert!(status.conflicted.is_empty());

        let f = find(&status.unstaged, "nur-unstaged.txt");
        assert_eq!((f.status, f.area), (FileStatus::Modified, FileArea::Unstaged));
        assert_eq!((f.added, f.removed), (Some(2), Some(1)));
        assert!(!f.is_binary && !f.is_lfs);
        assert_eq!((f.old_path.clone(), f.conflict), (None, None));

        let f = find(&status.staged, "nur-staged.txt");
        assert_eq!((f.status, f.area), (FileStatus::Modified, FileArea::Staged));
        assert_eq!((f.added, f.removed), (Some(0), Some(1)));

        // The same file in both lists, each with its own counts.
        let f = find(&status.staged, "beides.txt");
        assert_eq!((f.status, f.added, f.removed), (FileStatus::Modified, Some(1), Some(0)));
        let f = find(&status.unstaged, "beides.txt");
        assert_eq!((f.status, f.added, f.removed), (FileStatus::Modified, Some(3), Some(1)));

        let f = find(&status.staged, "neu-staged.txt");
        assert_eq!((f.status, f.added, f.removed), (FileStatus::Added, Some(2), Some(0)));
    }

    #[tokio::test]
    async fn untracked_files_including_nested_and_empty() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        repo.write_file("neu.txt", "eins\nzwei\ndrei");
        repo.write_file("ordner/tief/auch-neu.txt", "x\n");
        repo.write_file("leer.txt", "");
        repo.write_file(".gitignore", "ignoriert.log\n");
        repo.write_file("ignoriert.log", "weg\n");

        let status = status_of(&tc, &repo).await;
        assert_eq!(paths(&status.unstaged), vec![".gitignore", "leer.txt", "neu.txt", "ordner/tief/auch-neu.txt"]);
        assert!(status.staged.is_empty());
        let f = find(&status.unstaged, "neu.txt");
        assert_eq!((f.status, f.area), (FileStatus::Untracked, FileArea::Unstaged));
        // The last line without a line ending counts too.
        assert_eq!((f.added, f.removed), (Some(3), Some(0)));
        assert!(!f.is_binary);
        assert_eq!(find(&status.unstaged, "leer.txt").added, Some(0));
        assert_eq!(find(&status.unstaged, "ordner/tief/auch-neu.txt").added, Some(1));
    }

    #[tokio::test]
    async fn deleted_unstaged_and_staged() {
        let tc = TestCore::new().await;
        let repo = TestRepo::new();
        repo.write_file("weg-unstaged.txt", "a\nb\n");
        repo.write_file("weg-staged.txt", "a\nb\nc\n");
        repo.commit("Basis");
        repo.remove_file("weg-unstaged.txt");
        repo.git(&["rm", "-q", "weg-staged.txt"]);

        let status = status_of(&tc, &repo).await;
        assert_eq!(paths(&status.unstaged), vec!["weg-unstaged.txt"]);
        let f = &status.unstaged[0];
        assert_eq!((f.status, f.added, f.removed), (FileStatus::Deleted, Some(0), Some(2)));
        assert_eq!(paths(&status.staged), vec!["weg-staged.txt"]);
        let f = &status.staged[0];
        assert_eq!((f.status, f.area, f.added, f.removed), (FileStatus::Deleted, FileArea::Staged, Some(0), Some(3)));
    }

    #[tokio::test]
    async fn renamed_staged_with_later_edit() {
        let tc = TestCore::new().await;
        let repo = TestRepo::new();
        repo.write_file("alt.txt", "eins\nzwei\ndrei\nvier\nfünf\nsechs\n");
        repo.commit("Basis");
        repo.subdir("ordner");
        repo.git(&["mv", "alt.txt", "ordner/neu.txt"]);

        let status = status_of(&tc, &repo).await;
        assert!(status.unstaged.is_empty());
        assert_eq!(status.staged.len(), 1, "{:?}", status.staged);
        let f = &status.staged[0];
        assert_eq!(f.path, "ordner/neu.txt");
        assert_eq!(f.old_path.as_deref(), Some("alt.txt"));
        assert_eq!((f.status, f.area), (FileStatus::Renamed, FileArea::Staged));
        assert_eq!((f.added, f.removed), (Some(0), Some(0)));

        // Then changed in the working directory: staged stays "renamed", unstaged is "modified" without an old path.
        repo.write_file("ordner/neu.txt", "eins\nzwei\ndrei\nvier\nfünf\nsechs\nsieben\n");
        let id = tc.open(&repo).await.repo.id;
        let status = read_status(&tc, &id).await.unwrap();
        assert_eq!(status.staged[0].status, FileStatus::Renamed);
        let f = find(&status.unstaged, "ordner/neu.txt");
        assert_eq!((f.status, f.old_path.clone()), (FileStatus::Modified, None));
        assert_eq!((f.added, f.removed), (Some(1), Some(0)));
    }

    #[tokio::test]
    async fn binary_files() {
        let tc = TestCore::new().await;
        let repo = TestRepo::new();
        repo.write_file("bild.bin", [0u8, 1, 2, 3, 0, 255]);
        repo.write_file("staged.bin", [0u8, 9, 9]);
        repo.commit("Basis");
        repo.write_file("bild.bin", [0u8, 7, 7, 7, 0, 255, 1]);
        repo.write_file("staged.bin", [0u8, 8, 8, 8]);
        repo.git(&["add", "staged.bin"]);
        repo.write_file("neu.bin", [137u8, 80, 78, 71, 0, 0, 0]);

        let status = status_of(&tc, &repo).await;
        let f = find(&status.unstaged, "bild.bin");
        assert!(f.is_binary);
        assert_eq!((f.status, f.added, f.removed), (FileStatus::Modified, None, None));
        let f = find(&status.staged, "staged.bin");
        assert!(f.is_binary);
        assert_eq!((f.added, f.removed), (None, None));
        let f = find(&status.unstaged, "neu.bin");
        assert!(f.is_binary);
        assert_eq!((f.status, f.added, f.removed), (FileStatus::Untracked, None, None));
    }

    #[tokio::test]
    async fn names_with_spaces_and_umlauts() {
        let tc = TestCore::new().await;
        let repo = TestRepo::new();
        repo.write_file("Ordner mit Leerzeichen/Größe ändern.txt", "a\n");
        repo.write_file("Übersicht.md", "a\n");
        repo.write_file("um benennen.txt", "eins\nzwei\ndrei\nvier\n");
        repo.commit("Basis");
        repo.write_file("Ordner mit Leerzeichen/Größe ändern.txt", "a\nb\n");
        repo.write_file("Übersicht.md", "b\n");
        repo.git(&["add", "Übersicht.md"]);
        repo.git(&["mv", "um benennen.txt", "neuer Name ß.txt"]);
        repo.write_file("ganz neu ö.txt", "x\n");

        let status = status_of(&tc, &repo).await;
        let f = find(&status.unstaged, "Ordner mit Leerzeichen/Größe ändern.txt");
        assert_eq!((f.status, f.added, f.removed), (FileStatus::Modified, Some(1), Some(0)));
        let f = find(&status.staged, "Übersicht.md");
        assert_eq!((f.status, f.added, f.removed), (FileStatus::Modified, Some(1), Some(1)));
        let f = find(&status.staged, "neuer Name ß.txt");
        assert_eq!((f.status, f.old_path.as_deref()), (FileStatus::Renamed, Some("um benennen.txt")));
        assert_eq!((f.added, f.removed), (Some(0), Some(0)));
        let f = find(&status.unstaged, "ganz neu ö.txt");
        assert_eq!((f.status, f.added), (FileStatus::Untracked, Some(1)));
        assert_eq!(status.unstaged.len(), 2);
        assert_eq!(status.staged.len(), 2);
    }

    #[tokio::test]
    async fn lfs_attribute_and_pointer() {
        let tc = TestCore::new().await;
        let repo = TestRepo::new();
        repo.write_file(".gitattributes", "*.psd filter=lfs diff=lfs merge=lfs -text\n");
        repo.write_file("bild.psd", "alt\n");
        repo.write_file("text.txt", "alt\n");
        repo.commit("Basis");
        repo.write_file("bild.psd", "neu\n");
        repo.write_file("text.txt", "neu\n");
        repo.write_file("neu.psd", "x\n");
        repo.write_file(
            "zeiger.dat",
            "version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n",
        );

        let status = status_of(&tc, &repo).await;
        assert!(find(&status.unstaged, "bild.psd").is_lfs);
        assert!(!find(&status.unstaged, "text.txt").is_lfs);
        assert!(find(&status.unstaged, "neu.psd").is_lfs, "untracked, but covered by the attribute");
        assert!(find(&status.unstaged, "zeiger.dat").is_lfs, "untracked LFS pointer");
    }

    /// Creates all seven kinds of conflict in one merge.
    fn repo_with_all_conflicts() -> TestRepo {
        let repo = TestRepo::new();
        let body = "eins\nzwei\ndrei\nvier\nfünf\nsechs\nsieben\nacht\n";
        repo.write_file("beide-geaendert.txt", "basis\n");
        repo.write_file("von-uns-geloescht.txt", "basis\n");
        repo.write_file("von-denen-geloescht.txt", "basis\n");
        repo.write_file("umbenannt.txt", body);
        repo.commit("Basis");

        repo.checkout_new("feature");
        repo.write_file("beide-geaendert.txt", "feature\n");
        repo.write_file("von-uns-geloescht.txt", "feature\n");
        repo.remove_file("von-denen-geloescht.txt");
        repo.write_file("beide-neu.txt", "feature\n");
        repo.git(&["mv", "umbenannt.txt", "name-von-denen.txt"]);
        repo.commit("Feature");

        repo.checkout("main");
        repo.write_file("beide-geaendert.txt", "main\n");
        repo.remove_file("von-uns-geloescht.txt");
        repo.write_file("von-denen-geloescht.txt", "main\n");
        repo.write_file("beide-neu.txt", "main\n");
        repo.git(&["mv", "umbenannt.txt", "name-von-uns.txt"]);
        repo.commit("Main");
        assert!(!repo.merge("feature"), "the merge must end in a conflict");
        repo
    }

    #[tokio::test]
    async fn merge_conflict_with_every_conflict_kind() {
        let tc = TestCore::new().await;
        let repo = repo_with_all_conflicts();
        let status = status_of(&tc, &repo).await;

        let kinds: Vec<(&str, ConflictKind)> =
            status.conflicted.iter().map(|f| (f.path.as_str(), f.conflict.expect("conflict kind set"))).collect();
        assert_eq!(
            kinds,
            vec![
                ("beide-geaendert.txt", ConflictKind::BothModified),
                ("beide-neu.txt", ConflictKind::BothAdded),
                ("name-von-denen.txt", ConflictKind::AddedByThem),
                ("name-von-uns.txt", ConflictKind::AddedByUs),
                ("umbenannt.txt", ConflictKind::BothDeleted),
                ("von-denen-geloescht.txt", ConflictKind::DeletedByThem),
                ("von-uns-geloescht.txt", ConflictKind::DeletedByUs),
            ]
        );
        for f in &status.conflicted {
            assert_eq!((f.status, f.area), (FileStatus::Conflicted, FileArea::Unstaged), "{f:?}");
        }
        // Conflicts are only in their own list.
        assert!(status.unstaged.is_empty(), "{:?}", status.unstaged);
        assert!(status.staged.is_empty(), "{:?}", status.staged);

        let op = status.operation.expect("running merge");
        assert_eq!(op.kind, OperationKind::Merge);
        assert_eq!(op.source.as_deref(), Some("feature"));
        assert_eq!(op.target.as_deref(), Some("main"));
        assert_eq!((op.step, op.total_steps), (None, None));
        let message = op.message.expect("MERGE_MSG");
        assert!(message.starts_with("Merge branch 'feature'"), "{message}");
        assert!(!message.contains('#'), "comment lines don't belong in the message: {message}");
        assert_eq!(status.head, Head::Branch { branch: "main".into(), sha: repo.head() });
    }

    #[tokio::test]
    async fn merge_of_a_commit_without_branch_shows_short_sha() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        repo.checkout_new("feature");
        let theirs = repo.commit_file("README.md", "# Feature\n", "Feature");
        repo.checkout("main");
        repo.git(&["branch", "-q", "-D", "feature"]);
        repo.commit_file("README.md", "# Main\n", "Main");
        assert!(!repo.merge(&theirs));

        let status = status_of(&tc, &repo).await;
        let op = status.operation.expect("running merge");
        assert_eq!(op.source.as_deref(), Some(&theirs[..7]));
        assert_eq!(paths(&status.conflicted), vec!["README.md"]);
    }

    /// Which conflicts of the running operation are already resolved is in the status – read from the
    /// index, so also for an app that was restarted in the middle of the merge.
    #[tokio::test]
    async fn resolved_conflicts_of_the_running_merge_are_reported() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        repo.write_file("zweite.txt", "basis\n");
        repo.commit("Zweite Datei");
        repo.checkout_new("feature");
        repo.write_file("README.md", "# Feature\n");
        repo.write_file("zweite.txt", "feature\n");
        repo.commit("Feature ändert beide");
        repo.checkout("main");
        repo.write_file("README.md", "# Main\n");
        repo.write_file("zweite.txt", "main\n");
        repo.commit("Main ändert beide");
        // An old, resolved conflict does not count: without an operation the list is empty.
        assert_eq!(status_of(&tc, &repo).await.resolved_conflicts, Vec::<String>::new());
        assert!(!repo.merge("feature"));

        let status = status_of(&tc, &repo).await;
        assert_eq!(paths(&status.conflicted), vec!["README.md", "zweite.txt"]);
        assert_eq!(status.resolved_conflicts, Vec::<String>::new());

        repo.write_file("README.md", "# Beides\n");
        repo.git(&["add", "README.md"]);
        let status = status_of(&tc, &repo).await;
        assert_eq!(paths(&status.conflicted), vec!["zweite.txt"]);
        assert_eq!(status.resolved_conflicts, vec!["README.md"]);

        repo.write_file("zweite.txt", "beides\n");
        repo.git(&["add", "zweite.txt"]);
        let status = status_of(&tc, &repo).await;
        assert!(status.conflicted.is_empty() && status.operation.is_some());
        assert_eq!(status.resolved_conflicts, vec!["README.md", "zweite.txt"]);

        // Finished: Git keeps the data in the index, but there is nothing left to count.
        repo.git(&["commit", "-q", "--no-edit"]);
        let status = status_of(&tc, &repo).await;
        assert_eq!((status.operation, status.resolved_conflicts), (None, Vec::<String>::new()));
    }

    #[test]
    fn resolve_undo_output_lists_each_path_once() {
        let out = b"100644 78981922613b2afb6025042ff6bd878ac1994e85 1\ta.txt\x00100644 cd7386146a59c0cc7e7cf0c58547dccc96c53996 2\ta.txt\x00100644 e1f82f446287144d8bb8ec61c1721e4b4be51f86 3\ta.txt\x00100644 61780798228d17af2d34fce4cfbdf35556832472 1\tordner/b mit leer.txt\x00";
        assert_eq!(parse_resolve_undo(out), vec!["a.txt", "ordner/b mit leer.txt"]);
        assert_eq!(parse_resolve_undo(b""), Vec::<String>::new());
    }

    /// feature has two commits; the first one collides with main.
    fn repo_for_rebase() -> TestRepo {
        let repo = TestRepo::with_commit();
        repo.checkout_new("feature");
        repo.commit_file("README.md", "# Feature\n", "Feature ändert README");
        repo.commit_file("extra.txt", "x\n", "Feature ergänzt Datei");
        repo.checkout("main");
        repo.commit_file("README.md", "# Main\n", "Main ändert README");
        repo.checkout("feature");
        repo
    }

    #[tokio::test]
    async fn rebase_stopped_at_a_conflict() {
        let tc = TestCore::new().await;
        let repo = repo_for_rebase();
        let main_sha = repo.git(&["rev-parse", "main"]);
        assert!(!repo.git_output(&["rebase", "main"]).status.success());

        let status = status_of(&tc, &repo).await;
        // During the rebase HEAD is detached and points at the target.
        assert_eq!(status.head, Head::Detached { sha: main_sha });
        assert_eq!(status.upstream, None);
        let op = status.operation.expect("running rebase");
        assert_eq!(op.kind, OperationKind::Rebase);
        assert_eq!(op.source.as_deref(), Some("feature"));
        assert_eq!(op.target.as_deref(), Some("main"));
        assert_eq!((op.step, op.total_steps), (Some(1), Some(2)));
        assert_eq!(op.message.as_deref(), Some("Feature ändert README"));
        assert_eq!(status.conflicted.len(), 1);
        assert_eq!(status.conflicted[0].path, "README.md");
        assert_eq!(status.conflicted[0].conflict, Some(ConflictKind::BothModified));

        // Conflict resolved and continued: afterwards no operation is open any more.
        repo.write_file("README.md", "# Beides\n");
        repo.git(&["add", "README.md"]);
        // No editor for the message (CI has neither EDITOR nor a terminal).
        repo.git(&["-c", "core.editor=true", "rebase", "--continue"]);
        let id = tc.open(&repo).await.repo.id;
        let status = read_status(&tc, &id).await.unwrap();
        assert_eq!(status.operation, None);
        assert!(matches!(status.head, Head::Branch { ref branch, .. } if branch == "feature"));
    }

    #[tokio::test]
    async fn rebase_with_apply_backend() {
        let tc = TestCore::new().await;
        let repo = repo_for_rebase();
        assert!(!repo.git_output(&["rebase", "--apply", "main"]).status.success());

        let status = status_of(&tc, &repo).await;
        let op = status.operation.expect("running rebase");
        assert_eq!(op.kind, OperationKind::Rebase);
        assert_eq!(op.source.as_deref(), Some("feature"));
        assert_eq!(op.target.as_deref(), Some("main"));
        assert_eq!((op.step, op.total_steps), (Some(1), Some(2)));
        assert_eq!(paths(&status.conflicted), vec!["README.md"]);
    }

    #[tokio::test]
    async fn single_cherry_pick_and_revert_with_conflict() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        repo.checkout_new("feature");
        let picked = repo.commit_file("README.md", "# Feature\n", "Feature ändert README");
        repo.checkout("main");
        let main_change = repo.commit_file("README.md", "# Main\n", "Main ändert README");
        assert!(!repo.git_output(&["cherry-pick", &picked]).status.success());

        let id = tc.open(&repo).await.repo.id;
        let status = read_status(&tc, &id).await.unwrap();
        let op = status.operation.expect("running cherry-pick");
        assert_eq!(op.kind, OperationKind::CherryPick);
        assert_eq!(op.source.as_deref(), Some(&picked[..7]));
        assert_eq!(op.target.as_deref(), Some("main"));
        assert_eq!((op.step, op.total_steps), (None, None));
        assert_eq!(op.message.as_deref(), Some("Feature ändert README"));
        assert_eq!(paths(&status.conflicted), vec!["README.md"]);
        assert_eq!(read_operation(&tc, &id).await.unwrap().map(|o| o.kind), Some(OperationKind::CherryPick));

        repo.git(&["cherry-pick", "--abort"]);
        assert_eq!(read_status(&tc, &id).await.unwrap().operation, None);

        // Revert of the older commit collides with the newer one.
        repo.commit_file("README.md", "# Main, später\n", "Noch eine Änderung");
        assert!(!repo.git_output(&["revert", "--no-edit", &main_change]).status.success());
        let status = read_status(&tc, &id).await.unwrap();
        let op = status.operation.expect("running revert");
        assert_eq!(op.kind, OperationKind::Revert);
        assert_eq!(op.source.as_deref(), Some(&main_change[..7]));
        assert_eq!(op.target.as_deref(), Some("main"));
        assert!(op.message.is_some_and(|m| m.starts_with("Revert \"Main ändert README\"")));
    }

    #[tokio::test]
    async fn cherry_pick_sequence_reports_step_and_total() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        repo.checkout_new("feature");
        let a = repo.commit_file("a.txt", "a\n", "A");
        let b = repo.commit_file("README.md", "# Feature\n", "B kollidiert");
        let c = repo.commit_file("c.txt", "c\n", "C");
        repo.checkout("main");
        repo.commit_file("README.md", "# Main\n", "Main ändert README");
        assert!(!repo.git_output(&["cherry-pick", &a, &b, &c]).status.success());

        let id = tc.open(&repo).await.repo.id;
        let status = read_status(&tc, &id).await.unwrap();
        let op = status.operation.expect("running cherry-pick");
        assert_eq!(op.kind, OperationKind::CherryPick);
        assert_eq!(op.source.as_deref(), Some(&b[..7]));
        assert_eq!((op.step, op.total_steps), (Some(2), Some(3)));

        // Conflict resolved and committed by hand: the sequence is still open, C is missing.
        repo.write_file("README.md", "# Beides\n");
        repo.git(&["add", "README.md"]);
        repo.git(&["commit", "-q", "--no-edit"]);
        let status = read_status(&tc, &id).await.unwrap();
        let op = status.operation.expect("sequence still open");
        assert_eq!(op.kind, OperationKind::CherryPick);
        assert_eq!(op.source.as_deref(), Some(&c[..7]));
        assert_eq!((op.step, op.total_steps), (Some(3), Some(3)));

        repo.git(&["cherry-pick", "--continue"]);
        assert_eq!(read_status(&tc, &id).await.unwrap().operation, None);
    }

    /// `--update-refs` adds `update-ref` lines to the todo; the step counter only counts the
    /// commits being replayed.
    #[tokio::test]
    async fn rebase_step_counts_commits_not_update_ref_lines() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        repo.checkout_new("teil");
        repo.commit_file("t1.txt", "1\n", "Teil 1");
        repo.commit_file("t2.txt", "2\n", "Teil 2");
        repo.checkout_new("thema");
        repo.commit_file("README.md", "# Thema\n", "Thema kollidiert");
        repo.checkout("main");
        repo.commit_file("README.md", "# Main\n", "Main ändert README");
        repo.checkout("thema");
        assert!(!repo.git_output(&["rebase", "--update-refs", "main"]).status.success());
        let done = std::fs::read_to_string(repo.path().join(".git/rebase-merge/done")).unwrap();
        assert!(done.contains("update-ref refs/heads/teil"), "{done}");

        let id = tc.open(&repo).await.repo.id;
        let op = read_status(&tc, &id).await.unwrap().operation.expect("running rebase");
        assert_eq!(op.kind, OperationKind::Rebase);
        assert_eq!((op.step, op.total_steps), (Some(3), Some(3)));
        repo.git(&["rebase", "--abort"]);
    }

    #[tokio::test]
    async fn detached_head() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let first = repo.head();
        repo.commit_file("b.txt", "b\n", "Zweiter");
        repo.git(&["checkout", "-q", "--detach", &first]);
        repo.write_file("README.md", "# Geändert\n");

        let status = status_of(&tc, &repo).await;
        assert_eq!(status.head, Head::Detached { sha: first });
        assert_eq!(status.upstream, None);
        assert_eq!(status.operation, None);
        assert_eq!(paths(&status.unstaged), vec!["README.md"]);
    }

    #[tokio::test]
    async fn repo_without_commit() {
        let tc = TestCore::new().await;
        let repo = TestRepo::new();
        let status = status_of(&tc, &repo).await;
        assert_eq!(status.head, Head::Unborn { branch: "main".into() });
        assert!(status.unstaged.is_empty() && status.staged.is_empty());
        let empty_token = status.token;

        repo.write_file("staged.txt", "a\nb\n");
        repo.git(&["add", "staged.txt"]);
        repo.write_file("offen.txt", "x\n");
        let id = tc.open(&repo).await.repo.id;
        let status = read_status(&tc, &id).await.unwrap();
        assert_eq!(status.head, Head::Unborn { branch: "main".into() });
        assert_eq!(paths(&status.staged), vec!["staged.txt"]);
        let f = &status.staged[0];
        assert_eq!((f.status, f.added, f.removed), (FileStatus::Added, Some(2), Some(0)));
        assert_eq!(paths(&status.unstaged), vec!["offen.txt"]);
        assert_eq!(status.unstaged[0].status, FileStatus::Untracked);
        assert_ne!(status.token, empty_token);
    }

    #[tokio::test]
    async fn upstream_ahead_behind_and_gone() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let remote = repo.add_remote();
        let id = tc.open(&repo).await.repo.id;
        let status = read_status(&tc, &id).await.unwrap();
        assert_eq!(status.upstream, Some(UpstreamState { name: "origin/main".into(), ahead: 0, behind: 0, gone: false }));

        let other = TestRepo::clone_of(&remote);
        other.commit_file("fremd.txt", "x\n", "Fremder Commit");
        other.git(&["push", "-q", "origin", "main"]);
        repo.commit_file("eins.txt", "1\n", "Eins");
        repo.commit_file("zwei.txt", "2\n", "Zwei");
        repo.git(&["fetch", "-q", "origin"]);
        let status = read_status(&tc, &id).await.unwrap();
        assert_eq!(status.upstream, Some(UpstreamState { name: "origin/main".into(), ahead: 2, behind: 1, gone: false }));

        repo.git(&["update-ref", "-d", "refs/remotes/origin/main"]);
        let status = read_status(&tc, &id).await.unwrap();
        assert_eq!(status.upstream, Some(UpstreamState { name: "origin/main".into(), ahead: 0, behind: 0, gone: true }));

        repo.checkout_new("ohne-upstream");
        assert_eq!(read_status(&tc, &id).await.unwrap().upstream, None);
    }

    #[tokio::test]
    async fn token_follows_head_and_index_only() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let id = tc.open(&repo).await.repo.id;
        let start = read_status(&tc, &id).await.unwrap().token;
        // Pure reading changes nothing, not even a refresh of the index from outside.
        assert_eq!(read_status(&tc, &id).await.unwrap().token, start);
        repo.git(&["status"]);
        repo.git(&["update-index", "--refresh"]);
        assert_eq!(read_status(&tc, &id).await.unwrap().token, start);
        assert_eq!(read_token(&tc, &id).await.unwrap(), start);

        // The working directory alone does not count.
        repo.write_file("README.md", "# Geändert\n");
        repo.write_file("neu.txt", "x\n");
        assert_eq!(read_status(&tc, &id).await.unwrap().token, start);

        repo.git(&["add", "README.md"]);
        let after_add = read_status(&tc, &id).await.unwrap().token;
        assert_ne!(after_add, start);
        assert_eq!(read_token(&tc, &id).await.unwrap(), after_add);

        repo.git(&["commit", "-q", "-m", "README"]);
        let after_commit = read_status(&tc, &id).await.unwrap().token;
        assert_ne!(after_commit, after_add);
        assert_ne!(after_commit, start);

        // Switching branch to the same commit changes HEAD, and so the fingerprint.
        repo.git(&["checkout", "-q", "-b", "anderer"]);
        let after_switch = read_status(&tc, &id).await.unwrap().token;
        assert_ne!(after_switch, after_commit);

        repo.git(&["reset", "-q", "--soft", "HEAD~1"]);
        let after_reset = read_status(&tc, &id).await.unwrap().token;
        assert_ne!(after_reset, after_switch);
        assert_eq!(read_status(&tc, &id).await.unwrap().token, after_reset);
    }

    #[tokio::test]
    async fn reading_does_not_touch_the_index_file() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        // Changed timestamp with the same content: a normal `git status` would refresh the index.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        repo.write_file("README.md", "# Test\n");
        let index = repo.path().join(".git").join("index");
        let before = std::fs::read(&index).unwrap();
        let status = status_of(&tc, &repo).await;
        assert!(status.unstaged.is_empty(), "{:?}", status.unstaged);
        assert_eq!(std::fs::read(&index).unwrap(), before, "status_get must not write the index");
        assert!(!repo.path().join(".git").join("index.lock").exists());
    }

    #[tokio::test]
    async fn works_in_a_linked_worktree() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        repo.checkout_new("feature");
        repo.commit_file("README.md", "# Feature\n", "Feature");
        repo.checkout("main");
        repo.commit_file("README.md", "# Main\n", "Main");
        let other = repo.temp_dir().join("zweites");
        repo.git(&["worktree", "add", "-q", "-b", "anderswo", &other.to_string_lossy()]);
        assert!(other.join(".git").is_file());
        std::fs::write(other.join("neu.txt"), "x\n").unwrap();
        // Merge with a conflict in the second worktree: MERGE_HEAD is under .git/worktrees/zweites.
        let merged = std::process::Command::new("git")
            .args(["merge", "--no-edit", "feature"])
            .current_dir(&other)
            .envs(crate::testkit::git_isolation_env(&repo.temp_dir().join("gitconfig")))
            .output()
            .unwrap();
        assert!(!merged.status.success());

        let id = crate::commands::repos::repo_open(&tc, other.to_string_lossy().into_owned()).await.unwrap().repo.id;
        let status = read_status(&tc, &id).await.unwrap();
        assert!(matches!(status.head, Head::Branch { ref branch, .. } if branch == "anderswo"));
        assert_eq!(paths(&status.unstaged), vec!["neu.txt"]);
        assert_eq!(paths(&status.conflicted), vec!["README.md"]);
        let op = status.operation.expect("merge in the worktree");
        assert_eq!((op.kind, op.source.as_deref(), op.target.as_deref()), (OperationKind::Merge, Some("feature"), Some("anderswo")));
        assert!(status.identity_set);
        let dir = git_dir(&tc, &id).await.unwrap();
        assert!(dir.join("MERGE_HEAD").is_file(), "{dir:?}");

        // The first worktree notices nothing of it.
        let main_status = status_of(&tc, &repo).await;
        assert_eq!(main_status.operation, None);
        assert!(main_status.conflicted.is_empty());
    }

    #[tokio::test]
    async fn identity_missing_or_half_set() {
        let tc = TestCore::new().await;
        let repo = TestRepo::without_identity();
        let id = tc.open(&repo).await.repo.id;
        assert!(!read_status(&tc, &id).await.unwrap().identity_set);
        repo.git(&["config", "user.name", "Nur Name"]);
        assert!(!identity_set(&tc, &id).await.unwrap());
        repo.git(&["config", "user.email", "name@example.com"]);
        assert!(read_status(&tc, &id).await.unwrap().identity_set);

        // From the global configuration it counts just the same.
        let global = TestCore::with_global_config("[user]\n\tname = Global\n\temail = global@example.com\n").await;
        let other = TestRepo::without_identity();
        let id = global.open(&other).await.repo.id;
        assert!(read_status(&global, &id).await.unwrap().identity_set);
    }

    #[tokio::test]
    async fn unknown_repo_and_folder_that_is_no_repo() {
        let tc = TestCore::new().await;
        let err = read_status(&tc, "gibt-es-nicht").await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);

        let repo = TestRepo::with_commit();
        let id = tc.open(&repo).await.repo.id;
        std::fs::remove_dir_all(repo.path().join(".git")).unwrap();
        let err = read_status(&tc, &id).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotARepo, "{err:?}");
    }

    #[test]
    fn parses_porcelain_v2_records() {
        let zero = "0000000000000000000000000000000000000000";
        let raw = format!(
            "# branch.oid abc123\0# branch.head main\0# branch.upstream origin/main\0# branch.ab +3 -12\0# stash 2\0\
             1 .M N... 100644 100644 100644 {zero} {zero} mit leer zeichen.txt\0\
             2 R. N... 100644 100644 100644 {zero} {zero} R100 neu name.txt\0alt name.txt\0\
             u UD N... 100644 100644 000000 100644 {zero} {zero} {zero} konflikt datei.txt\0\
             1 AM S.M. 000000 160000 160000 {zero} {zero} modul\0\
             ? neu\ndatei.txt\0\
             x unbekannt\0"
        );
        let parsed = parse_porcelain_v2(raw.as_bytes());
        assert_eq!(parsed.oid.as_deref(), Some("abc123"));
        assert_eq!(parsed.branch.as_deref(), Some("main"));
        assert_eq!(parsed.upstream, Some(UpstreamState { name: "origin/main".into(), ahead: 3, behind: 12, gone: false }));
        let got: Vec<(EntryKind, char, char, String, Option<String>)> = parsed
            .entries
            .iter()
            .map(|e| (e.kind, e.x as char, e.y as char, util::decode_lossy(&e.path), e.orig_path.as_deref().map(util::decode_lossy)))
            .collect();
        assert_eq!(
            got,
            vec![
                (EntryKind::Tracked, '.', 'M', "mit leer zeichen.txt".to_string(), None),
                (EntryKind::Tracked, 'R', '.', "neu name.txt".to_string(), Some("alt name.txt".to_string())),
                (EntryKind::Unmerged, 'U', 'D', "konflikt datei.txt".to_string(), None),
                (EntryKind::Tracked, 'A', 'M', "modul".to_string(), None),
                (EntryKind::Untracked, '?', '?', "neu\ndatei.txt".to_string(), None),
            ]
        );

        let gone = parse_porcelain_v2(b"# branch.oid (initial)\0# branch.head main\0# branch.upstream origin/weg\0");
        assert_eq!(gone.oid, None);
        assert_eq!(gone.upstream, Some(UpstreamState { name: "origin/weg".into(), ahead: 0, behind: 0, gone: true }));
        assert_eq!(gone.head().unwrap(), Head::Unborn { branch: "main".into() });
        let detached = parse_porcelain_v2(b"# branch.oid abc\0# branch.head (detached)\0");
        assert_eq!(detached.head().unwrap(), Head::Detached { sha: "abc".into() });
        assert!(parse_porcelain_v2(b"").head().is_err());
    }

    #[test]
    fn parses_numstat_with_renames_and_binaries() {
        let map = parse_numstat_z(b"3\t1\tein pfad.txt\0-\t-\tbild.png\x000\t0\t\0alt.txt\0neu.txt\x0012\t0\tletzte\0");
        assert_eq!(map.len(), 4);
        assert_eq!(map[b"ein pfad.txt".as_slice()], LineCounts { added: Some(3), removed: Some(1), binary: false });
        assert_eq!(map[b"bild.png".as_slice()], LineCounts { added: None, removed: None, binary: true });
        assert_eq!(map[b"neu.txt".as_slice()], LineCounts { added: Some(0), removed: Some(0), binary: false });
        assert!(!map.contains_key(b"alt.txt".as_slice()));
        assert_eq!(map[b"letzte".as_slice()].added, Some(12));
        assert!(parse_numstat_z(b"").is_empty());
    }

    #[test]
    fn conflict_kinds_and_small_helpers() {
        assert_eq!(conflict_kind(b'U', b'U'), ConflictKind::BothModified);
        assert_eq!(conflict_kind(b'A', b'A'), ConflictKind::BothAdded);
        assert_eq!(conflict_kind(b'D', b'D'), ConflictKind::BothDeleted);
        assert_eq!(conflict_kind(b'A', b'U'), ConflictKind::AddedByUs);
        assert_eq!(conflict_kind(b'U', b'A'), ConflictKind::AddedByThem);
        assert_eq!(conflict_kind(b'D', b'U'), ConflictKind::DeletedByUs);
        assert_eq!(conflict_kind(b'U', b'D'), ConflictKind::DeletedByThem);
        assert_eq!(clean_message("Merge branch 'x'\n\n# Conflicts:\n#\ta.txt\n").as_deref(), Some("Merge branch 'x'"));
        assert_eq!(clean_message("# nur Kommentar\n"), None);
        assert_eq!(todo_lines("pick abc123 Eins\n\n# Kommentar\nrevert def456 Zwei\n"), vec![
            ("pick".to_string(), "abc123".to_string()),
            ("revert".to_string(), "def456".to_string())
        ]);
        assert_eq!(trim_bytes(b"  a b \n"), b"a b");
        assert_eq!(trim_bytes(b" \n"), b"");
        let head = Head::Detached { sha: "abc".into() };
        assert_eq!(fingerprint(&head, b"x"), fingerprint(&head, b"x"));
        assert_ne!(fingerprint(&head, b"x"), fingerprint(&head, b"y"));
        assert_ne!(fingerprint(&head, b""), fingerprint(&Head::Unborn { branch: "abc".into() }, b""));
    }
}
