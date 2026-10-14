//! Stash.
//!
//! The list comes from `git stash list` with a fixed NUL format, the file counts from a
//! single `git diff-tree --stdin`. Applying always runs as `git stash apply`; the
//! core removes the entry on pop itself, so that the backup for undo exists beforehand.

use std::collections::{HashMap, HashSet};

use serde_json::json;

use crate::app::Core;
use crate::commands::refs;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::{errors, GitOutput};
use crate::model::{Head, OpResult, RepoChange, Stash, StashSelection, Status};
use crate::undo::{self, UndoAction, UndoRecord};
use crate::util;

mod partial;

/// SHA, parents, commit time, reflog text – four NUL-separated fields per stash.
const LIST_FORMAT: &str = "--format=%H%x00%P%x00%ct%x00%gs";
/// Under this prefix `rewrite_top` holds on to stash commits while they are not in the list.
const REBUILD_REF_PREFIX: &str = "refs/forkyard/stash-rebuild/";

/// An entry of the stash list as Git returns it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StashRow {
    pub sha: String,
    /// Base commit, index commit and – for stashed untracked files – their commit.
    pub parents: Vec<String>,
    pub time: i64,
    /// Reflog text, e.g. "WIP on main: 1a2b3c4 Subject" or "On main: Message".
    pub subject: String,
}

pub(crate) enum ApplyOutcome {
    Done,
    Conflict(Vec<String>),
}

pub(crate) fn stash_selector(index: usize) -> String {
    format!("stash@{{{index}}}")
}

fn parse_rows(stdout: &[u8]) -> Vec<StashRow> {
    let fields: Vec<&[u8]> = util::split_z(stdout).collect();
    fields
        .chunks_exact(4)
        .map(|f| StashRow {
            sha: util::decode_lossy(f[0]).trim().to_string(),
            parents: util::decode_lossy(f[1]).split_whitespace().map(str::to_string).collect(),
            time: util::decode_lossy(f[2]).trim().parse().unwrap_or(0),
            subject: util::decode_lossy(f[3]),
        })
        .filter(|row| !row.sha.is_empty())
        .collect()
}

/// Splits the reflog text into branch and message: "On main: Text" → (main, Text),
/// "WIP on main: 1a2b3c4 Subject" → (main, "1a2b3c4 Subject"). Without this prefix
/// (e.g. after `git stash store`) the whole text is the message.
pub fn split_subject(subject: &str) -> (Option<String>, String) {
    for prefix in ["WIP on ", "On "] {
        let Some(rest) = subject.strip_prefix(prefix) else { continue };
        let Some((branch, message)) = rest.split_once(": ") else { continue };
        if branch == "(no branch)" {
            return (None, message.to_string());
        }
        if !branch.is_empty() && !branch.contains(char::is_whitespace) {
            return (Some(branch.to_string()), message.to_string());
        }
    }
    (None, subject.to_string())
}

pub(crate) async fn read_rows(core: &Core, repo_id: &str) -> CoreResult<Vec<StashRow>> {
    let out = core
        .git_for(repo_id)?
        .args(["stash", "list", "-z", "--no-show-signature", LIST_FORMAT])
        .read_only()
        .no_log()
        .run()
        .await?;
    Ok(parse_rows(&out.stdout))
}

/// Number of files per stash: changes against the base commit plus the untracked
/// files from the third parent.
async fn file_counts(core: &Core, repo_id: &str, rows: &[StashRow]) -> CoreResult<Vec<u32>> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let mut input = String::new();
    let mut known: HashSet<&str> = HashSet::new();
    for row in rows {
        let Some(base) = row.parents.first() else { continue };
        if known.insert(&row.sha) {
            input.push_str(&format!("{} {}\n", row.sha, base));
        }
        if let Some(untracked) = row.parents.get(2) {
            if known.insert(untracked) {
                input.push_str(&format!("{untracked}\n"));
            }
        }
    }
    let out = core
        .git_for(repo_id)?
        .args(["diff-tree", "--stdin", "--root", "-r", "-z", "--name-only", "-M"])
        .stdin(input)
        .read_only()
        .no_log()
        .run()
        .await?;
    // Output: per commit a header line with its SHA, then the paths.
    let mut per_commit: HashMap<&str, u32> = HashMap::new();
    let mut current: Option<&str> = None;
    for record in out.stdout_z() {
        let (head, rest) = match record.iter().position(|b| *b == b'\n') {
            Some(pos) => (&record[..pos], Some(&record[pos + 1..])),
            None => (record, None),
        };
        let header = std::str::from_utf8(head).ok().and_then(|h| known.get(h).copied());
        match header {
            Some(sha) => {
                current = Some(sha);
                if rest.is_some_and(|r| !r.is_empty()) {
                    *per_commit.entry(sha).or_default() += 1;
                }
            }
            None => {
                if let Some(sha) = current {
                    *per_commit.entry(sha).or_default() += 1;
                }
            }
        }
    }
    Ok(rows
        .iter()
        .map(|row| {
            let own = per_commit.get(row.sha.as_str()).copied().unwrap_or(0);
            let untracked = row.parents.get(2).and_then(|p| per_commit.get(p.as_str())).copied().unwrap_or(0);
            own + untracked
        })
        .collect())
}

/// Reads all stashes. Pure read command: no lock, no event, no log entry.
pub async fn read_stashes(core: &Core, repo_id: &str) -> CoreResult<Vec<Stash>> {
    let rows = read_rows(core, repo_id).await?;
    let counts = file_counts(core, repo_id, &rows).await?;
    Ok(rows
        .into_iter()
        .zip(counts)
        .enumerate()
        .map(|(index, (row, file_count))| {
            let (branch, message) = split_subject(&row.subject);
            Stash {
                index: index as u32,
                base_sha: row.parents.first().cloned().unwrap_or_default(),
                sha: row.sha,
                message,
                branch,
                created_at: util::unix_to_iso(row.time),
                file_count,
            }
        })
        .collect())
}

/// Paths with open conflicts in the index (each path once).
pub(crate) async fn unmerged_paths(core: &Core, repo_id: &str) -> CoreResult<Vec<String>> {
    let out = core.git_for(repo_id)?.args(["ls-files", "--unmerged", "-z"]).read_only().no_log().run().await?;
    let mut paths: Vec<String> = Vec::new();
    for record in out.stdout_z() {
        let Some(tab) = record.iter().position(|b| *b == b'\t') else { continue };
        let path = util::decode_lossy(&record[tab + 1..]);
        if paths.last() != Some(&path) {
            paths.push(path);
        }
    }
    Ok(paths)
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn quoted_list(paths: &[String]) -> String {
    let mut text = paths.iter().take(5).map(|p| format!("“{p}”")).collect::<Vec<_>>().join(", ");
    if paths.len() > 5 {
        text.push_str(&format!(" and {} more", paths.len() - 5));
    }
    text
}

/// `git stash push`. Returns the SHA of the new stash or `None` if there was nothing to stash.
/// Does NOT take the write lock itself.
pub(crate) async fn push_stash(
    core: &Core,
    repo_id: &str,
    message: Option<&str>,
    paths: Option<&[String]>,
    include_untracked: bool,
) -> CoreResult<Option<String>> {
    let before = undo::rev_parse(core, repo_id, "refs/stash").await?;
    // `git stash push -- <paths>` still puts the WHOLE index into the stash: staged changes outside the
    // selection went along, undo lost the staging, and a later pop put conflict markers
    // into files that were never selected. So they step out of the index for the duration
    // of stashing and come back in exactly as they were afterwards.
    let aside = match paths {
        Some(selected) => {
            let chosen = |path: &[u8]| {
                selected.iter().any(|sel| {
                    let sel = sel.trim_end_matches('/').as_bytes();
                    path == sel || (path.len() > sel.len() && path.starts_with(sel) && path[sel.len()] == b'/')
                })
            };
            StagedAside::take(core, repo_id, &chosen).await?
        }
        None => None,
    };
    let result = push_stash_now(core, repo_id, message, paths, include_untracked, before).await;
    if let Some(aside) = aside {
        if let Err(e) = aside.put_back(core, repo_id).await {
            log::error!("Staging outside the partial stash not restored (index tree {}): {}", aside.tree, e.message);
            if result.is_ok() {
                core.emit_repo_changed(repo_id, &[RepoChange::Stash, RepoChange::Worktree, RepoChange::Index]);
                return Err(CoreError::io(
                    "The stash was created, but the changes staged outside the selection could not be staged again. The changes themselves are untouched in the working directory – stage them again.",
                )
                .with_git_output(e.git_output.unwrap_or(e.message)));
            }
        }
    }
    result
}

/// Staged changes outside the selection of a partial stash, taken out of the index for stashing.
struct StagedAside {
    /// Index tree before.
    tree: String,
    /// The paths set aside (raw bytes).
    paths: Vec<Vec<u8>>,
}

impl StagedAside {
    /// Takes staged changes out of the index, except at paths for which `stays` holds (the files
    /// in the working directory stay as they are). `None` if there are none.
    async fn take(core: &Core, repo_id: &str, stays: &(dyn Fn(&[u8]) -> bool + Sync)) -> CoreResult<Option<StagedAside>> {
        let staged = core.git_for(repo_id)?.args(["diff", "--cached", "--name-only", "-z", "--no-renames", "--no-ext-diff"]).read_only().no_log().run_raw().await?;
        if !staged.success() {
            // Without a commit (or with conflicts) there is no stash; `git stash` reports that.
            return Ok(None);
        }
        let paths: Vec<Vec<u8>> = staged.stdout_z().into_iter().filter(|path| !path.is_empty() && !stays(path)).map(<[u8]>::to_vec).collect();
        if paths.is_empty() {
            return Ok(None);
        }
        let tree = core.git_for(repo_id)?.args(["write-tree"]).no_log().run().await?.stdout_text();
        let mut cmd = core.git_for(repo_id)?.args(["reset", "-q", "HEAD", "--pathspec-from-file=-", "--pathspec-file-nul"]).no_log();
        cmd = cmd.stdin(literal_pathspecs(&paths));
        cmd.run().await?;
        Ok(Some(StagedAside { tree, paths }))
    }

    /// Puts the entries of the set-aside paths back into the index exactly as they were before.
    async fn put_back(&self, core: &Core, repo_id: &str) -> CoreResult<()> {
        let listed = core.git_for(repo_id)?.args(["ls-tree", "-r", "-z", &self.tree]).read_only().no_log().run().await?;
        let wanted: std::collections::HashSet<&[u8]> = self.paths.iter().map(Vec::as_slice).collect();
        let mut present: std::collections::HashSet<&[u8]> = std::collections::HashSet::new();
        let mut info: Vec<u8> = Vec::new();
        for record in listed.stdout_z() {
            let Some(tab) = record.iter().position(|byte| *byte == b'\t') else { continue };
            let path = &record[tab + 1..];
            if wanted.contains(path) {
                present.insert(path);
                info.extend_from_slice(record);
                info.push(0);
            }
        }
        if !info.is_empty() {
            core.git_for(repo_id)?.args(["update-index", "-z", "--index-info"]).no_log().stdin(info).run().await?;
        }
        // What was missing from the index before was a staged deletion.
        let gone: Vec<u8> = self.paths.iter().filter(|path| !present.contains(path.as_slice())).flat_map(|path| path.iter().copied().chain(std::iter::once(0))).collect();
        if !gone.is_empty() {
            core.git_for(repo_id)?.args(["update-index", "-z", "--force-remove", "--stdin"]).no_log().stdin(gone).run().await?;
        }
        Ok(())
    }
}

/// NUL-separated, literal pathspecs (file names with *, ? or [ are not patterns).
fn literal_pathspecs(paths: &[Vec<u8>]) -> Vec<u8> {
    let mut input = Vec::new();
    for path in paths {
        input.extend_from_slice(b":(literal)");
        input.extend_from_slice(path);
        input.push(0);
    }
    input
}

async fn push_stash_now(
    core: &Core,
    repo_id: &str,
    message: Option<&str>,
    paths: Option<&[String]>,
    include_untracked: bool,
    before: Option<String>,
) -> CoreResult<Option<String>> {
    let mut cmd = core.git_for(repo_id)?.args(["stash", "push"]);
    if include_untracked {
        cmd = cmd.arg("--include-untracked");
    }
    if let Some(message) = message {
        cmd = cmd.arg(format!("--message={message}"));
    }
    if let Some(paths) = paths {
        // Literal paths: file names with *, ? or [ are not patterns.
        let mut input = Vec::new();
        for path in paths {
            input.extend_from_slice(b":(literal)");
            input.extend_from_slice(path.as_bytes());
            input.push(0);
        }
        cmd = cmd.args(["--pathspec-from-file=-", "--pathspec-file-nul"]).stdin(input);
    }
    let out = cmd.run_raw().await?;
    if !out.success() {
        let text = out.stderr_text().to_lowercase();
        if paths.is_some() && text.contains("did not match any file") {
            return Err(CoreError::not_found(
                "At least one of the selected files is untracked or no longer exists. Untracked files can only be stashed with the “Include untracked files” option.",
            )
            .with_git_output(out.stderr_text()));
        }
        // `git stash push` first creates the stash and then resets the working directory.
        // If the reset fails on a file (another program holds it open), the stash
        // exists anyway – the message must say so, otherwise one stashes a second time.
        let created = undo::rev_parse(core, repo_id, "refs/stash").await?;
        if created.is_some() && created != before {
            let stderr = out.stderr_text();
            let lower = stderr.to_ascii_lowercase();
            let file = ["unable to unlink old '", "unable to create file ", "could not open '", "cannot open '"].iter().find_map(|marker| {
                let start = lower.find(marker)? + marker.len();
                let rest = stderr.get(start..)?;
                let end = rest.find(['\'', ':', '\n'])?;
                Some(rest[..end].trim().to_string()).filter(|name| !name.is_empty())
            });
            let which = match &file {
                Some(file) => format!("“{file}”"),
                None => "at least one file".to_string(),
            };
            core.emit_repo_changed(repo_id, &[RepoChange::Stash, RepoChange::Worktree, RepoChange::Index]);
            return Err(CoreError::io(format!(
                "The stash was created, but {which} could not be reset afterwards – another program probably has the file open. The change is therefore in the stash AND still in the working directory. Don't stash again: close the other program and then discard the change to the file, or bring the stash back with Pop."
            ))
            .with_git_output(stderr));
        }
        return Err(errors::classify("stash", out.code, &out.stdout, &out.stderr));
    }
    let after = undo::rev_parse(core, repo_id, "refs/stash").await?;
    Ok(if after != before { after } else { None })
}

fn apply_error(out: &GitOutput) -> CoreError {
    let text = out.stderr_text().to_lowercase();
    let blocked = ["would be overwritten", "already exists, no checkout", "could not restore untracked files", "local changes"];
    if blocked.iter().any(|needle| text.contains(needle)) {
        // Git lists the files indented below the message.
        let files: Vec<String> = out.stderr_text().lines().filter_map(|line| line.strip_prefix('\t')).map(|file| file.trim().to_string()).filter(|file| !file.is_empty()).collect();
        let what = match files.len() {
            0 => "uncommitted changes".to_string(),
            1 => format!("uncommitted changes to {}", quoted_list(&files)),
            _ => format!("uncommitted changes to these files: {}", quoted_list(&files)),
        };
        return CoreError::new(
            ErrorCode::DirtyWorktree,
            format!("The stash can't be applied because {what} are in the way. Commit, stash or discard them first."),
        )
        .with_git_output(out.stderr_text());
    }
    errors::classify("stash", out.code, &out.stdout, &out.stderr)
}

/// `git stash apply` for the entry `index` (with `--index`, so that staged changes come back
/// staged; if that fails, without). The stash stays in the list in any case.
/// Does NOT take the write lock itself.
pub(crate) async fn apply_stash(core: &Core, repo_id: &str, index: usize, row: &StashRow) -> CoreResult<ApplyOutcome> {
    if !unmerged_paths(core, repo_id).await?.is_empty() {
        return Err(CoreError::new(
            ErrorCode::Conflict,
            "A stash can't be applied while there are unresolved conflicts. Resolve the conflicts first.",
        ));
    }
    // Git first applies the tracked files and then fails on existing
    // untracked ones – that would be a half-applied stash. So check beforehand.
    if let Some(untracked) = row.parents.get(2) {
        let root = core.repo_path(repo_id)?;
        let out = core.git_for(repo_id)?.args(["ls-tree", "-r", "-z", "--name-only", untracked]).read_only().no_log().run().await?;
        let blocking: Vec<String> = out
            .stdout_z()
            .into_iter()
            .filter(|path| std::fs::symlink_metadata(util::join_from_git(&root, path)).is_ok())
            .map(util::decode_lossy)
            .collect();
        if !blocking.is_empty() {
            return Err(CoreError::new(
                ErrorCode::DirtyWorktree,
                format!(
                    "The stash contains untracked files that already exist in the working directory: {}. Move, commit or delete them first.",
                    quoted_list(&blocking)
                ),
            ));
        }
    }
    let selector = stash_selector(index);
    // If the stash brings staged changes, `git stash apply --index` requires an index without other
    // staged changes ("would be overwritten by merge … Index was not unstashed") – even if
    // the stash doesn't touch these files at all. So they step aside for applying and
    // come back into the index exactly as they were afterwards.
    let aside = match staged_untouched_by(core, repo_id, row).await {
        Ok(aside) => aside,
        Err(e) => {
            log::warn!("Staged changes not set aside before applying the stash: {}", e.message);
            None
        }
    };
    let mut out = core.git_for(repo_id)?.args(["stash", "apply", "--index", &selector]).run_raw().await?;
    if !out.success() && out.stderr_text().to_lowercase().contains("try without --index") {
        out = core.git_for(repo_id)?.args(["stash", "apply", &selector]).run_raw().await?;
    }
    if let Some(aside) = aside {
        if let Err(e) = aside.put_back(core, repo_id).await {
            log::error!("Staging not restored after applying the stash (index tree {}): {}", aside.tree, e.message);
        }
    }
    if out.success() {
        return Ok(ApplyOutcome::Done);
    }
    let conflicts = unmerged_paths(core, repo_id).await?;
    if !conflicts.is_empty() {
        return Ok(ApplyOutcome::Conflict(conflicts));
    }
    Err(apply_error(&out))
}

/// Staged changes to files that the stash `row` does not touch – taken out of the index if
/// the stash itself brings staged changes (only then do they get in the way). `None`: nothing to set aside.
async fn staged_untouched_by(core: &Core, repo_id: &str, row: &StashRow) -> CoreResult<Option<StagedAside>> {
    let (Some(base), Some(staged)) = (row.parents.first(), row.parents.get(1)) else { return Ok(None) };
    let tree_of = |rev: String| async move { undo::rev_parse(core, repo_id, &format!("{rev}^{{tree}}")).await };
    if tree_of(base.clone()).await? == tree_of(staged.clone()).await? {
        return Ok(None);
    }
    let mut touched: std::collections::HashSet<Vec<u8>> = std::collections::HashSet::new();
    for other in [staged.as_str(), row.sha.as_str()] {
        let out = core.git_for(repo_id)?.args(["diff-tree", "-r", "-z", "--name-only", "--no-renames", base, other]).read_only().no_log().run().await?;
        touched.extend(out.stdout_z().into_iter().filter(|path| !path.is_empty()).map(<[u8]>::to_vec));
    }
    StagedAside::take(core, repo_id, &|path: &[u8]| touched.contains(path)).await
}

pub(crate) async fn drop_stash(core: &Core, repo_id: &str, index: usize) -> CoreResult<()> {
    core.git_for(repo_id)?.args(["stash", "drop", "-q", &stash_selector(index)]).run().await?;
    Ok(())
}

pub(crate) async fn store_stash(core: &Core, repo_id: &str, sha: &str, subject: &str) -> CoreResult<()> {
    let subject = one_line(subject);
    core.git_for(repo_id)?.args(["stash", "store", "-q"]).arg(format!("--message={subject}")).arg(sha).run().await?;
    Ok(())
}

/// Rebuilds the top of the stash list: removes the topmost `drop_count` entries and
/// puts `new_top` (SHA, reflog text; topmost first) in their place. Entries below
/// stay untouched. Git can only add a stash on top; this way the order is
/// preserved anyway. While entries are not in the list, refs under
/// `refs/forkyard/stash-rebuild/` hold on to their commits.
/// Does NOT take the write lock itself.
pub(crate) async fn rewrite_top(core: &Core, repo_id: &str, rows: &[StashRow], drop_count: usize, new_top: &[(String, String)]) -> CoreResult<()> {
    let drop_count = drop_count.min(rows.len());
    let prefix = format!("{REBUILD_REF_PREFIX}{}/", util::new_id());
    let mut held: Vec<&str> = Vec::new();
    for sha in rows[..drop_count].iter().map(|r| r.sha.as_str()).chain(new_top.iter().map(|(sha, _)| sha.as_str())) {
        if !held.contains(&sha) {
            held.push(sha);
        }
    }
    let hold: String = held.iter().enumerate().map(|(i, sha)| format!("update {prefix}{i} {sha}\n")).collect();
    let release: String = (0..held.len()).map(|i| format!("delete {prefix}{i}\n")).collect();
    if !hold.is_empty() {
        core.git_for(repo_id)?.args(["update-ref", "--stdin"]).stdin(hold).no_log().run().await?;
    }

    let mut dropped = 0;
    let mut failure: Option<CoreError> = None;
    while dropped < drop_count {
        match drop_stash(core, repo_id, 0).await {
            Ok(()) => dropped += 1,
            Err(e) => {
                failure = Some(e);
                break;
            }
        }
    }
    // After an error while removing: put the entries already removed back unchanged.
    let restore: Vec<(String, String)> = match failure {
        Some(_) => rows[..dropped].iter().map(|r| (r.sha.clone(), r.subject.clone())).collect(),
        None => new_top.to_vec(),
    };
    let mut stored_all = true;
    for (sha, subject) in restore.iter().rev() {
        if let Err(e) = store_stash(core, repo_id, sha, subject).await {
            stored_all = false;
            failure.get_or_insert(e);
        }
    }
    // The holding refs stay if an entry did not make it back into the list.
    if stored_all && !release.is_empty() {
        core.git_for(repo_id)?.args(["update-ref", "--stdin"]).stdin(release).no_log().run().await?;
    }
    match failure {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

fn row_at(rows: &[StashRow], index: u32) -> CoreResult<&StashRow> {
    rows.get(index as usize).ok_or_else(|| {
        CoreError::not_found(format!("The stash stash@{{{index}}} no longer exists. The list will be reloaded."))
    })
}

fn display_message(row: &StashRow) -> String {
    undo::shorten(&split_subject(&row.subject).1, 60)
}

/// All stashes.
pub async fn stash_list(core: &Core, repo_id: String) -> CoreResult<Vec<Stash>> {
    read_stashes(core, &repo_id).await
}

/// Create a stash (optionally only paths, with untracked). Idempotent via `op_id`.
///
/// `undoable: Some(false)`: no undo entry. The UI stashes this way when changes are in the way
/// of an undo step ("Stash and undo"): with an entry of its own, the following undo would
/// only take back the stash just created instead of the intended action.
pub async fn stash_create(
    core: &Core,
    repo_id: String,
    op_id: String,
    message: Option<String>,
    paths: Option<Vec<String>>,
    include_untracked: bool,
    undoable: Option<bool>,
) -> CoreResult<Vec<Stash>> {
    core.repo_path(&repo_id)?;
    let message = message.map(|m| one_line(&m)).filter(|m| !m.is_empty());
    core.idempotent(&op_id, async {
        core.with_write_lock(&repo_id, &[RepoChange::Stash, RepoChange::Worktree, RepoChange::Index], async {
            let head = refs::read_head(core, &repo_id).await?;
            if matches!(head, Head::Unborn { .. }) {
                return Err(CoreError::not_allowed("A stash needs at least one commit. Commit first."));
            }
            if !unmerged_paths(core, &repo_id).await?.is_empty() {
                return Err(CoreError::new(
                    ErrorCode::Conflict,
                    "Nothing can be stashed while there are unresolved conflicts. Resolve the conflicts or abort the operation first.",
                ));
            }
            if paths.as_ref().is_some_and(|p| p.is_empty()) {
                return Err(CoreError::new(ErrorCode::NothingToCommit, "No files are selected for stashing."));
            }
            let Some(sha) = push_stash(core, &repo_id, message.as_deref(), paths.as_deref(), include_untracked).await? else {
                return Err(nothing_to_stash(core, &repo_id, include_untracked).await);
            };
            if undoable == Some(false) {
                return read_stashes(core, &repo_id).await;
            }
            let label = match &message {
                Some(m) => format!("Undo stash “{}”", undo::shorten(m, 60)),
                None => "Undo stash".to_string(),
            };
            let token = undo::head_token(&head);
            undo::record(
                core,
                UndoRecord {
                    id: undo::new_id(),
                    repo_id: repo_id.clone(),
                    worktree_path: String::new(),
                    action: UndoAction::Stash,
                    label,
                    ref_name: None,
                    ref_before: None,
                    ref_after: None,
                    head_before: token.clone(),
                    head_after: Some(token),
                    payload: json!({
                        "stashSha": sha,
                        "headSha": undo::head_sha(&head),
                        "message": message,
                        "paths": paths,
                        "includeUntracked": include_untracked,
                    }),
                },
            )
            .await?;
            read_stashes(core, &repo_id).await
        })
        .await
    })
    .await
}

/// `stash_create` with an optional `selection`: then only these hunks and lines are stashed
/// (`partial::stash_selection`); `paths` and `include_untracked` don't apply and `paths` together
/// with a selection is `not_allowed`. Idempotent via `op_id` like `stash_create`.
#[allow(clippy::too_many_arguments)]
pub async fn stash_create_with(
    core: &Core,
    repo_id: String,
    op_id: String,
    message: Option<String>,
    paths: Option<Vec<String>>,
    include_untracked: bool,
    undoable: Option<bool>,
    selection: Option<StashSelection>,
) -> CoreResult<Vec<Stash>> {
    let Some(selection) = selection else {
        return stash_create(core, repo_id, op_id, message, paths, include_untracked, undoable).await;
    };
    if paths.is_some() {
        return Err(CoreError::not_allowed("A stash takes either whole files or selected lines, not both."));
    }
    core.repo_path(&repo_id)?;
    let message = message.map(|m| one_line(&m)).filter(|m| !m.is_empty());
    core.idempotent(&op_id, async {
        core.with_write_lock(&repo_id, &[RepoChange::Stash, RepoChange::Worktree, RepoChange::Index], async {
            partial::stash_selection(core, &repo_id, message.as_deref(), &selection, undoable != Some(false)).await?;
            read_stashes(core, &repo_id).await
        })
        .await
    })
    .await
}

async fn nothing_to_stash(core: &Core, repo_id: &str, include_untracked: bool) -> CoreError {
    let mut message = "There are no changes to stash.".to_string();
    if !include_untracked {
        let untracked = match core.git_for(repo_id) {
            Ok(cmd) => cmd.args(["ls-files", "--others", "--exclude-standard", "-z"]).read_only().no_log().run_raw().await,
            Err(e) => Err(e),
        };
        if untracked.is_ok_and(|out| !out.stdout.is_empty()) {
            message.push_str(" There are only untracked files, which are not stashed without the “Include untracked files” option.");
        }
    }
    CoreError::new(ErrorCode::NothingToCommit, message)
}

async fn apply_or_pop(core: &Core, repo_id: &str, index: u32, pop: bool) -> CoreResult<OpResult> {
    let (rows, head) = tokio::join!(read_rows(core, repo_id), refs::read_head(core, repo_id));
    let (rows, head) = (rows?, head?);
    let row = row_at(&rows, index)?;
    // State before the pop, so that undo finds its way back exactly there.
    let before = if pop { Some(undo::snapshot_worktree(core, repo_id, None).await?) } else { None };
    match apply_stash(core, repo_id, index as usize, row).await? {
        ApplyOutcome::Conflict(files) => Ok(OpResult::Conflict { files, operation: None, note: Some(conflict_note(pop)) }),
        ApplyOutcome::Done => {
            let message = display_message(row);
            let Some((worktree_sha, index_tree)) = before else {
                return Ok(OpResult::Done { sha: None, fast_forward: false, summary: format!("Applied stash “{message}”. It stays in the list.") });
            };
            let id = undo::new_id();
            // First hold on to it, then take it out of the list: the stash commit is never without a ref.
            undo::create_backup_ref(core, repo_id, &id, "stash", &row.sha).await?;
            undo::create_backup_ref(core, repo_id, &id, "worktree", &worktree_sha).await?;
            if let Err(e) = drop_stash(core, repo_id, index as usize).await {
                let _ = undo::delete_backup_refs(core, repo_id, &id).await;
                return Err(e);
            }
            // The files are back and the stash is gone: the UI should show that right away, not
            // only once the undo entry including the backup is written as well (a "Commit" right
            // after the pop would otherwise briefly find "Nothing to commit").
            core.emit_repo_changed(repo_id, &[RepoChange::Stash, RepoChange::Worktree, RepoChange::Index]);
            let token = undo::head_token(&head);
            // The state after the pop: against it undo detects what the user has added since.
            let result = undo::keep_result(core, repo_id, &id, "result", None).await.ok();
            undo::record(
                core,
                UndoRecord {
                    id,
                    repo_id: repo_id.to_string(),
                    worktree_path: String::new(),
                    action: UndoAction::StashPop,
                    label: format!("Undo stash pop of “{message}”"),
                    ref_name: None,
                    ref_before: None,
                    ref_after: None,
                    head_before: token.clone(),
                    head_after: Some(token),
                    payload: json!({
                        "stashSha": row.sha,
                        "stashSubject": row.subject,
                        "stashIndex": index,
                        "headSha": undo::head_sha(&head),
                        "worktreeSnapshot": worktree_sha,
                        "indexTree": index_tree,
                        "resultSnapshot": result,
                    }),
                },
            )
            .await?;
            Ok(OpResult::Done { sha: None, fast_forward: false, summary: format!("Applied stash “{message}” and removed it from the list.") })
        }
    }
}

/// Note on a stash that was applied with conflicts: no operation is running
/// that could be continued or aborted, and the stash is still there.
fn conflict_note(pop: bool) -> String {
    let kept = if pop { "The stash therefore stays in the list" } else { "The stash stays in the list" };
    format!("{kept}. Resolve the conflicts in the files; afterwards you can delete the stash manually.")
}

/// Apply a stash without deleting it.
pub async fn stash_apply(core: &Core, repo_id: String, index: u32) -> CoreResult<OpResult> {
    core.with_write_lock(&repo_id, &[RepoChange::Worktree, RepoChange::Index], apply_or_pop(core, &repo_id, index, false)).await
}

/// Apply and delete a stash. On a conflict the stash stays in the list.
pub async fn stash_pop(core: &Core, repo_id: String, index: u32) -> CoreResult<OpResult> {
    core.with_write_lock(&repo_id, &[RepoChange::Worktree, RepoChange::Index, RepoChange::Stash], apply_or_pop(core, &repo_id, index, true)).await
}

/// Applies only the named files of a stash to the working directory (the index
/// stays, and so does the stash). For tracked files the change from the stash is applied as a
/// patch; untracked files of the stash are created. All or nothing.
///
/// Errors: `not_found` (stash, or the file does not occur in it), `conflict` (the file has
/// changed since in a way that the change no longer fits – then apply the whole stash,
/// which merges), `dirty_worktree` (an untracked file already exists). The files
/// are backed up first: undo entry `discard`.
pub async fn stash_apply_paths(core: &Core, repo_id: String, index: u32, paths: Vec<String>) -> CoreResult<Status> {
    let mut wanted: Vec<String> = Vec::new();
    for path in &paths {
        let rel = crate::commands::history::normalize_rel_path(path)?;
        if !wanted.contains(&rel) {
            wanted.push(rel);
        }
    }
    if wanted.is_empty() {
        return Err(CoreError::not_allowed("No file is selected."));
    }
    let repo_id = repo_id.as_str();
    core.with_write_lock(repo_id, &[RepoChange::Worktree], async {
        let rows = read_rows(core, repo_id).await?;
        let row = row_at(&rows, index)?;
        let Some(base) = row.parents.first() else {
            return Err(CoreError::not_found("This stash is incomplete and can't be applied."));
        };
        let quiet = || -> CoreResult<crate::git::GitCmd> { Ok(core.git_for(repo_id)?.env("GIT_LITERAL_PATHSPECS", "1").no_log()) };
        let listed = |out: GitOutput| -> HashSet<Vec<u8>> { out.stdout_z().into_iter().map(<[u8]>::to_vec).collect() };
        let changed = listed(quiet()?.args(["diff-tree", "-r", "-z", "--name-only", "--no-renames", base, &row.sha]).read_only().run().await?);
        let untracked = match row.parents.get(2) {
            Some(commit) => listed(quiet()?.args(["ls-tree", "-r", "-z", "--name-only", commit]).read_only().run().await?),
            None => HashSet::new(),
        };
        let (mut tracked_paths, mut untracked_paths) = (Vec::new(), Vec::new());
        for rel in &wanted {
            if changed.contains(rel.as_bytes()) {
                tracked_paths.push(rel.clone());
            } else if untracked.contains(rel.as_bytes()) {
                untracked_paths.push(rel.clone());
            } else {
                return Err(CoreError::not_found(format!("The file “{rel}” is not part of this stash.")));
            }
        }
        // Check everything first, then change.
        let root = core.repo_path(repo_id)?;
        let blocking: Vec<String> =
            untracked_paths.iter().filter(|rel| std::fs::symlink_metadata(util::join_from_git(&root, rel.as_bytes())).is_ok()).cloned().collect();
        if !blocking.is_empty() {
            return Err(CoreError::new(
                ErrorCode::DirtyWorktree,
                format!("These untracked files from the stash already exist in the working directory: {}. Move or delete them first.", quoted_list(&blocking)),
            ));
        }
        let apply = || -> CoreResult<crate::git::GitCmd> {
            Ok(quiet()?.args(["-c", "apply.whitespace=nowarn", "-c", "apply.ignoreWhitespace=no", "apply", "--whitespace=nowarn"]))
        };
        let patch = if tracked_paths.is_empty() {
            Vec::new()
        } else {
            let diff = quiet()?
                .args(["diff", "--binary", "--full-index", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", base, &row.sha, "--"])
                .args(&tracked_paths)
                .read_only()
                .run()
                .await?;
            let check = apply()?.arg("--check").read_only().stdin(diff.stdout.clone()).run_raw().await?;
            if !check.success() {
                return Err(CoreError::new(
                    ErrorCode::Conflict,
                    format!(
                        "The changes from the stash no longer fit {}: something has changed there since the stash was created. Applying the whole stash merges both versions.",
                        quoted_list(&tracked_paths)
                    ),
                )
                .with_git_output(check.stderr_text()));
            }
            diff.stdout
        };

        let head = refs::read_head(core, repo_id).await?;
        let raw: Vec<Vec<u8>> = wanted.iter().map(|rel| rel.as_bytes().to_vec()).collect();
        let backup = crate::commands::stage::Backup::create(core, repo_id, &head, Some(&raw)).await?;
        let written: CoreResult<()> = async {
            if !patch.is_empty() {
                core.git_for(repo_id)?
                    .env("GIT_LITERAL_PATHSPECS", "1")
                    .args(["-c", "apply.whitespace=nowarn", "-c", "apply.ignoreWhitespace=no", "apply", "--whitespace=nowarn"])
                    .stdin(patch)
                    .run()
                    .await?;
            }
            if let (Some(commit), false) = (row.parents.get(2), untracked_paths.is_empty()) {
                // Via an index of its own, so that line endings and filters apply as in a checkout.
                let temp = crate::commands::diff::TempIndex::create(core)?;
                quiet()?.args(["read-tree", commit]).env("GIT_INDEX_FILE", temp.path()).run().await?;
                let mut input = Vec::new();
                for rel in &untracked_paths {
                    input.extend_from_slice(rel.as_bytes());
                    input.push(0);
                }
                quiet()?.args(["checkout-index", "-z", "--stdin"]).env("GIT_INDEX_FILE", temp.path()).stdin(input).run().await?;
            }
            Ok(())
        }
        .await;
        if let Err(e) = written {
            backup.forget(core, repo_id).await;
            return Err(e);
        }
        let label = match wanted.as_slice() {
            [one] => format!("Undo applying ‘{one}’ from the stash"),
            many => format!("Undo applying {} files from the stash", many.len()),
        };
        backup.record(core, repo_id, &head, label, Some(wanted.clone())).await?;
        crate::commands::status::read_status(core, repo_id).await
    })
    .await
}

/// Delete a stash. Not reversible.
pub async fn stash_drop(core: &Core, repo_id: String, index: u32) -> CoreResult<Vec<Stash>> {
    core.with_write_lock(&repo_id, &[RepoChange::Stash], async {
        let rows = read_rows(core, &repo_id).await?;
        let sha = row_at(&rows, index)?.sha.clone();
        drop_stash(core, &repo_id, index as usize).await?;
        // "Undo stash" can no longer exist for this stash.
        if let Err(e) = crate::commands::undo::forget_stash(core, &repo_id, &sha).await {
            log::warn!("Undo entry for the deleted stash not invalidated: {}", e.message);
        }
        read_stashes(core, &repo_id).await
    })
    .await
}

/// Change a stash message. Position and SHA of the stash stay the same; what changes is the
/// text in the stash list (reflog), the branch reference ("On main: …") is preserved.
pub async fn stash_rename(core: &Core, repo_id: String, index: u32, message: String) -> CoreResult<Vec<Stash>> {
    let message = one_line(&message);
    if message.is_empty() {
        return Err(CoreError::new(ErrorCode::EmptyMessage, "The stash description can't be empty."));
    }
    core.with_write_lock(&repo_id, &[RepoChange::Stash], async {
        let rows = read_rows(core, &repo_id).await?;
        let row = row_at(&rows, index)?;
        let (branch, old) = split_subject(&row.subject);
        if old != message {
            let subject = match branch {
                Some(branch) => format!("On {branch}: {message}"),
                None => message.clone(),
            };
            let position = index as usize;
            let mut new_top: Vec<(String, String)> = rows[..position].iter().map(|r| (r.sha.clone(), r.subject.clone())).collect();
            new_top.push((row.sha.clone(), subject));
            rewrite_top(core, &repo_id, &rows, position + 1, &new_top).await?;
        }
        read_stashes(core, &repo_id).await
    })
    .await
}

#[cfg(test)]
mod partial_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::status::read_status;
    use crate::commands::undo::undo_peek;
    use crate::events::names;
    use crate::testkit::{TestCore, TestRepo};

    async fn setup() -> (TestCore, TestRepo, String) {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let id = tc.open(&repo).await.repo.id;
        (tc, repo, id)
    }

    #[tokio::test]
    async fn single_files_of_a_stash_can_be_applied() {
        use crate::commands::undo::{redo, undo, undo_peek};
        let (tc, repo, id) = setup().await;
        repo.commit_file("a.txt", "eins\nzwei\ndrei\n", "a");
        let lines = |first: &str, eighth: &str| format!("{first}\n2\n3\n4\n5\n6\n7\n{eighth}\n9\n10\n11\n12\n");
        repo.commit_file("ordner/b größe.txt", lines("1", "8"), "b");
        repo.write_file("a.txt", "eins\nZWEI\ndrei\n");
        repo.write_file("ordner/b größe.txt", lines("1", "ACHT"));
        repo.write_file("neu/unverfolgt.txt", "frisch\n");
        let stashes = stash(&tc, &id, Some("Halbfertig")).await;
        assert_eq!(stashes.len(), 1);
        assert_eq!(repo.read_file("a.txt"), b"eins\nzwei\ndrei\n");
        tc.events.clear();

        // Only one tracked file: the other one and the untracked one stay in the stash.
        let status = stash_apply_paths(&tc, id.clone(), 0, vec!["a.txt".into()]).await.unwrap();
        assert_eq!(repo.read_file("a.txt"), b"eins\nZWEI\ndrei\n");
        assert_eq!(repo.read_file("ordner/b größe.txt"), lines("1", "8").as_bytes());
        assert!(!repo.path().join("neu").exists());
        assert_eq!(status.unstaged.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["a.txt"]);
        assert!(status.staged.is_empty(), "the index stays as it is");
        assert_eq!(stash_list(&tc, id.clone()).await.unwrap().len(), 1, "the stash stays");
        assert_eq!(tc.events.named(names::REPO_CHANGED)[0]["what"], json!(["worktree"]));
        assert_eq!(undo_peek(&tc, id.clone()).await.unwrap().undo.unwrap().label, "Undo applying ‘a.txt’ from the stash");

        // A local change at another place in the same file doesn't interfere …
        repo.write_file("ordner/b größe.txt", lines("EINS", "8"));
        repo.git(&["add", "ordner/b größe.txt"]);
        repo.git(&["commit", "-q", "-m", "Zeile davor"]);
        stash_apply_paths(&tc, id.clone(), 0, vec!["ordner\\b größe.txt".replace('\\', if cfg!(windows) { "\\" } else { "/" }), "neu/unverfolgt.txt".into()]).await.unwrap();
        assert_eq!(repo.read_file("ordner/b größe.txt"), lines("EINS", "ACHT").as_bytes());
        assert_eq!(repo.read_file("neu/unverfolgt.txt"), b"frisch\n");
        // … and undo takes back exactly this step, redo repeats it.
        undo(&tc, id.clone()).await.unwrap();
        assert_eq!(repo.read_file("ordner/b größe.txt"), lines("EINS", "8").as_bytes());
        assert!(!repo.path().join("neu").exists());
        assert_eq!(repo.read_file("a.txt"), b"eins\nZWEI\ndrei\n", "the earlier step stays");
        redo(&tc, id.clone()).await.unwrap();
        assert_eq!(repo.read_file("neu/unverfolgt.txt"), b"frisch\n");

        // Errors change nothing: untracked file already there, change no longer fits, file or stash unknown.
        let err = stash_apply_paths(&tc, id.clone(), 0, vec!["neu/unverfolgt.txt".into()]).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::DirtyWorktree);
        let err = stash_apply_paths(&tc, id.clone(), 0, vec!["a.txt".into()]).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Conflict, "already applied: does not fit a second time");
        assert!(err.message.contains("a.txt") && err.git_output.is_some(), "{err:?}");
        assert_eq!(repo.read_file("a.txt"), b"eins\nZWEI\ndrei\n");
        assert_eq!(stash_apply_paths(&tc, id.clone(), 0, vec!["README.md".into()]).await.unwrap_err().code, ErrorCode::NotFound);
        assert_eq!(stash_apply_paths(&tc, id.clone(), 5, vec!["a.txt".into()]).await.unwrap_err().code, ErrorCode::NotFound);
        assert_eq!(stash_apply_paths(&tc, id.clone(), 0, vec![]).await.unwrap_err().code, ErrorCode::NotAllowed);
        assert_eq!(stash_apply_paths(&tc, id, 0, vec!["../draußen.txt".into()]).await.unwrap_err().code, ErrorCode::NotAllowed);
    }

    fn op() -> String {
        util::new_id()
    }

    async fn stash(tc: &TestCore, id: &str, message: Option<&str>) -> Vec<Stash> {
        stash_create(tc, id.to_string(), op(), message.map(str::to_string), None, true, None).await.unwrap()
    }

    fn changed(tc: &TestCore) -> Vec<String> {
        let mut what: Vec<String> = tc
            .events
            .named(names::REPO_CHANGED)
            .iter()
            .flat_map(|e| e["what"].as_array().cloned().unwrap_or_default())
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();
        what.sort();
        what.dedup();
        what
    }

    #[test]
    fn subjects_are_split() {
        assert_eq!(split_subject("On main: Meine Arbeit"), (Some("main".into()), "Meine Arbeit".into()));
        assert_eq!(split_subject("WIP on feature/x: 1a2b3c4 Erster Commit"), (Some("feature/x".into()), "1a2b3c4 Erster Commit".into()));
        assert_eq!(split_subject("WIP on (no branch): 1a2b3c4 Erster Commit"), (None, "1a2b3c4 Erster Commit".into()));
        assert_eq!(split_subject("On (no branch): x: y"), (None, "x: y".into()));
        assert_eq!(split_subject("frei gewählt"), (None, "frei gewählt".into()));
        assert_eq!(split_subject("On the road: unterwegs"), (None, "On the road: unterwegs".into()));
    }

    #[tokio::test]
    async fn list_is_empty_without_stashes_and_without_commits() {
        let (tc, _repo, id) = setup().await;
        assert!(stash_list(&tc, id).await.unwrap().is_empty());
        let unborn = TestRepo::new();
        let unborn_id = tc.open(&unborn).await.repo.id;
        assert!(stash_list(&tc, unborn_id.clone()).await.unwrap().is_empty());
        unborn.write_file("a.txt", "x\n");
        let err = stash_create(&tc, unborn_id, op(), None, None, true, None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
        assert_eq!(unborn.read_file("a.txt"), b"x\n");
        assert_eq!(stash_list(&tc, "unbekannt".into()).await.unwrap_err().code, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn create_lists_message_branch_base_and_file_count() {
        let (tc, repo, id) = setup().await;
        let head = repo.head();
        repo.write_file("README.md", "# Geändert\n");
        repo.write_file("neu gestaged.txt", "a\n");
        repo.git(&["add", "neu gestaged.txt"]);
        repo.write_file("ordner/unverfolgt ü.txt", "b\n");
        tc.events.clear();

        let list = stash(&tc, &id, Some("  Meine\nArbeit  ")).await;
        assert_eq!(list.len(), 1);
        let s = &list[0];
        assert_eq!(s.index, 0);
        assert_eq!(s.message, "Meine Arbeit");
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.base_sha, head);
        assert_eq!(s.sha, repo.git(&["rev-parse", "refs/stash"]));
        assert_eq!(s.file_count, 3, "modified + newly staged + untracked");
        assert!(s.created_at.ends_with('Z') && s.created_at.len() == 24, "{}", s.created_at);
        assert_eq!(changed(&tc), ["index", "stash", "worktree"]);

        // The working directory is clean, the untracked file is gone too.
        let status = read_status(&tc, &id).await.unwrap();
        assert!(status.unstaged.is_empty() && status.staged.is_empty());
        assert!(!repo.path().join("ordner").exists());

        // Second stash without a message: Git text without "WIP on main:", newest first.
        repo.write_file("README.md", "# Nochmal\n");
        let list = stash(&tc, &id, None).await;
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].index, 0);
        assert_eq!(list[0].message, format!("{} Erster Commit", &head[..7]));
        assert_eq!(list[0].branch.as_deref(), Some("main"));
        assert_eq!(list[0].file_count, 1);
        assert_eq!(list[1].index, 1);
        assert_eq!(list[1].message, "Meine Arbeit");
        assert_eq!(stash_list(&tc, id.clone()).await.unwrap(), list);

        let peek = undo_peek(&tc, id).await.unwrap();
        assert_eq!(peek.undo.as_ref().unwrap().action, "stash");
        assert_eq!(peek.undo.unwrap().label, "Undo stash");
    }

    #[tokio::test]
    async fn create_without_changes_is_nothing_to_commit_and_op_id_is_idempotent() {
        let (tc, repo, id) = setup().await;
        let op_id = op();
        let err = stash_create(&tc, id.clone(), op_id.clone(), None, None, true, None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NothingToCommit);
        assert!(err.message.contains("no changes"), "{}", err.message);
        assert!(undo_peek(&tc, id.clone()).await.unwrap().undo.is_none());

        // Only untracked files, but without "include": nothing to stash, with a hint.
        repo.write_file("neu.txt", "x\n");
        let err = stash_create(&tc, id.clone(), op(), None, None, false, None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NothingToCommit);
        assert!(err.message.contains("untracked"), "{}", err.message);
        assert_eq!(repo.read_file("neu.txt"), b"x\n");

        // After the error the op_id is free again; after success it is used up.
        let list = stash_create(&tc, id.clone(), op_id.clone(), None, None, true, None).await.unwrap();
        assert_eq!(list.len(), 1);
        repo.write_file("neu.txt", "y\n");
        let err = stash_create(&tc, id.clone(), op_id, None, None, true, None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Duplicate);
        assert_eq!(stash_list(&tc, id.clone()).await.unwrap().len(), 1);

        let err = stash_create(&tc, id, op(), None, Some(Vec::new()), true, None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NothingToCommit);
    }

    #[tokio::test]
    async fn partial_stash_takes_only_the_chosen_paths() {
        let (tc, repo, id) = setup().await;
        repo.commit_file("mit leerzeichen ä.txt", "alt\n", "Datei mit Leerzeichen");
        repo.commit_file("muster[1].txt", "alt\n", "Datei mit Klammern");
        repo.commit_file("muster1.txt", "alt\n", "Datei, auf die das Muster passen würde");
        repo.write_file("README.md", "# bleibt geändert\n");
        repo.write_file("mit leerzeichen ä.txt", "neu\n");
        repo.write_file("muster[1].txt", "neu\n");
        repo.write_file("muster1.txt", "neu\n");
        repo.write_file("unverfolgt neu.txt", "u\n");

        let paths = vec!["mit leerzeichen ä.txt".to_string(), "muster[1].txt".to_string(), "unverfolgt neu.txt".to_string()];
        let list = stash_create(&tc, id.clone(), op(), Some("Teil".into()), Some(paths), true, None).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].message, "Teil");
        assert_eq!(list[0].file_count, 3);

        assert_eq!(repo.read_file("mit leerzeichen ä.txt"), b"alt\n");
        assert_eq!(repo.read_file("muster[1].txt"), b"alt\n");
        assert!(!repo.path().join("unverfolgt neu.txt").exists());
        // Not selected: stays, including the file that "muster[1].txt" would match as a pattern.
        assert_eq!(repo.read_file("README.md"), "# bleibt geändert\n".as_bytes());
        assert_eq!(repo.read_file("muster1.txt"), b"neu\n");

        // Untracked file without "include": understandable error, nothing changed.
        repo.write_file("noch eine.txt", "u\n");
        let err = stash_create(&tc, id.clone(), op(), None, Some(vec!["noch eine.txt".into()]), false, None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        assert!(err.message.contains("untracked"), "{}", err.message);
        assert_eq!(repo.read_file("noch eine.txt"), b"u\n");
        assert_eq!(stash_list(&tc, id).await.unwrap().len(), 1);
    }

    /// What is staged outside the selection does not belong in the partial stash – and is
    /// staged exactly as before afterwards (new file, deletion, partly staged file).
    #[tokio::test]
    async fn partial_stash_leaves_staging_outside_the_selection_alone() {
        let (tc, repo, id) = setup().await;
        repo.commit_file("teils.txt", "eins\nzwei\ndrei\n", "Teils");
        repo.commit_file("weg.txt", "weg\n", "Wird gelöscht");
        repo.commit_file("gewaehlt.txt", "alt\n", "Gewählt");
        // Outside the selection: new file staged, deletion staged, one file partly staged.
        repo.write_file("neu.txt", "gestagte neue Datei\n");
        repo.git(&["add", "neu.txt"]);
        repo.git(&["rm", "-q", "weg.txt"]);
        repo.write_file("teils.txt", "EINS\nzwei\ndrei\n");
        repo.git(&["add", "teils.txt"]);
        repo.write_file("teils.txt", "EINS\nzwei\nDREI\n");
        // The selection: staged and unstaged part.
        repo.write_file("gewaehlt.txt", "gestaged\n");
        repo.git(&["add", "gewaehlt.txt"]);
        repo.write_file("gewaehlt.txt", "gestaged\nund weiter\n");
        let status_before = repo.git(&["status", "--porcelain"]);
        let index_before = repo.git(&["ls-files", "--stage"]);

        stash_create(&tc, id.clone(), op(), Some("nur gewählt".into()), Some(vec!["gewaehlt.txt".into()]), false, None).await.unwrap();
        assert_eq!(repo.git(&["stash", "show", "--name-only", "stash@{0}"]), "gewaehlt.txt", "the stash contains exactly the selected file");
        assert_eq!(repo.read_file("gewaehlt.txt"), b"alt\n");
        assert_eq!(repo.git(&["status", "--porcelain"]), "D  weg.txt\nA  neu.txt\nMM teils.txt".lines().collect::<Vec<_>>().join("\n").replace("D  weg.txt\nA  neu.txt\nMM teils.txt", "A  neu.txt\nMM teils.txt\nD  weg.txt"));
        assert_eq!(repo.git(&["show", ":teils.txt"]), "EINS\nzwei\ndrei");
        assert_eq!(repo.read_file("teils.txt"), b"EINS\nzwei\nDREI\n");

        // Undo: files AND staging as before.
        crate::commands::undo::undo(&tc, id.clone()).await.unwrap();
        assert_eq!(repo.git(&["status", "--porcelain"]), status_before);
        assert_eq!(repo.git(&["ls-files", "--stage"]), index_before);
        assert_eq!(repo.read_file("gewaehlt.txt"), b"gestaged\nund weiter\n");
        assert!(stash_list(&tc, id).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn stash_on_detached_head_has_no_branch() {
        let (tc, repo, id) = setup().await;
        let head = repo.head();
        repo.git(&["checkout", "-q", "--detach"]);
        repo.write_file("README.md", "# detached\n");
        let list = stash(&tc, &id, Some("ohne Branch")).await;
        assert_eq!(list[0].branch, None);
        assert_eq!(list[0].message, "ohne Branch");
        assert_eq!(list[0].base_sha, head);
        repo.write_file("README.md", "# detached 2\n");
        let list = stash(&tc, &id, None).await;
        assert_eq!(list[0].branch, None);
        assert_eq!(list[0].message, format!("{} Erster Commit", &head[..7]));
    }

    #[tokio::test]
    async fn apply_keeps_the_stash_and_restores_bytes_and_staging() {
        let (tc, repo, id) = setup().await;
        repo.commit_file("crlf.txt", "eins\r\nzwei\r\n", "CRLF-Datei");
        repo.commit_file("ohne ende.txt", "eins\nzwei", "Datei ohne Zeilenumbruch am Ende");
        repo.write_file("crlf.txt", "eins\r\nZWEI\r\ndrei\r\n");
        repo.write_file("ohne ende.txt", "eins\nzwei\ndrei");
        repo.write_file("gestaged.txt", "neu\n");
        repo.git(&["add", "gestaged.txt"]);
        repo.write_file("unverfolgt/tief/datei.bin", [0u8, 1, 2, 255]);
        stash(&tc, &id, Some("Bytes")).await;
        assert_eq!(repo.read_file("crlf.txt"), b"eins\r\nzwei\r\n");
        tc.events.clear();

        let result = stash_apply(&tc, id.clone(), 0).await.unwrap();
        match &result {
            OpResult::Done { sha, summary, .. } => {
                assert!(sha.is_none());
                assert!(summary.contains("stays in the list"), "{summary}");
            }
            other => panic!("unexpected: {other:?}"),
        }
        assert_eq!(changed(&tc), ["index", "worktree"]);
        assert_eq!(repo.read_file("crlf.txt"), b"eins\r\nZWEI\r\ndrei\r\n");
        assert_eq!(repo.read_file("ohne ende.txt"), b"eins\nzwei\ndrei");
        assert_eq!(repo.read_file("unverfolgt/tief/datei.bin"), [0u8, 1, 2, 255]);
        let status = read_status(&tc, &id).await.unwrap();
        assert_eq!(status.staged.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["gestaged.txt"]);
        assert_eq!(stash_list(&tc, id.clone()).await.unwrap().len(), 1, "apply does not delete");
        // No undo entry for apply: the stash itself is still on top.
        assert_eq!(undo_peek(&tc, id.clone()).await.unwrap().undo.unwrap().action, "stash");

        assert_eq!(stash_apply(&tc, id.clone(), 7).await.unwrap_err().code, ErrorCode::NotFound);
        assert_eq!(stash_pop(&tc, id, 7).await.unwrap_err().code, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn apply_falls_back_when_the_staged_part_no_longer_fits() {
        let (tc, repo, id) = setup().await;
        // Staged: README modified; in the working directory the old content again.
        repo.write_file("README.md", "# gestaged\n");
        repo.git(&["add", "README.md"]);
        repo.write_file("README.md", "# Test\n");
        repo.write_file("daneben.txt", "d\n");
        stash(&tc, &id, Some("Index und Arbeit")).await;
        // Meanwhile a commit changes the same line: the staged part no longer fits.
        repo.commit_file("README.md", "# committet\n", "README anders");

        let result = stash_apply(&tc, id.clone(), 0).await.unwrap();
        assert!(matches!(result, OpResult::Done { .. }), "{result:?}");
        assert_eq!(repo.read_file("README.md"), b"# committet\n");
        assert_eq!(repo.read_file("daneben.txt"), b"d\n");
        let status = read_status(&tc, &id).await.unwrap();
        assert!(status.conflicted.is_empty());
        assert!(status.staged.is_empty(), "without --index nothing comes back staged");
    }

    #[tokio::test]
    async fn pop_removes_the_stash_and_records_undo() {
        let (tc, repo, id) = setup().await;
        repo.write_file("README.md", "# eins\n");
        stash(&tc, &id, Some("eins")).await;
        repo.write_file("README.md", "# zwei\n");
        let list = stash(&tc, &id, Some("zwei")).await;
        let older = list[1].sha.clone();
        tc.events.clear();

        // Get the older stash (index 1).
        let result = stash_pop(&tc, id.clone(), 1).await.unwrap();
        assert!(matches!(&result, OpResult::Done { summary, .. } if summary.contains("removed")), "{result:?}");
        assert_eq!(changed(&tc), ["index", "stash", "worktree"]);
        assert_eq!(repo.read_file("README.md"), b"# eins\n");
        let list = stash_list(&tc, id.clone()).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].message, "zwei");

        let peek = undo_peek(&tc, id.clone()).await.unwrap();
        let step = peek.undo.unwrap();
        assert_eq!(step.action, "stash_pop");
        assert_eq!(step.label, "Undo stash pop of “eins”");
        // The stash commit stays reachable through a backup ref.
        let entry = undo::next_undo(&tc, &id, "").unwrap().unwrap();
        assert_eq!(repo.git(&["rev-parse", &undo::backup_ref_name(&entry.id, "stash")]), older);
        assert_eq!(entry.payload["stashSha"], older);
        assert_eq!(entry.payload["stashIndex"], 1);
    }

    #[tokio::test]
    async fn pop_with_conflict_reports_files_and_keeps_the_stash() {
        let (tc, repo, id) = setup().await;
        repo.write_file("README.md", "# aus dem Stash\n");
        repo.write_file("ohne konflikt.txt", "x\n");
        stash(&tc, &id, Some("kollidiert")).await;
        repo.commit_file("README.md", "# inzwischen committet\n", "README geändert");
        let undo_before = undo_peek(&tc, id.clone()).await.unwrap();

        let result = stash_pop(&tc, id.clone(), 0).await.unwrap();
        match result {
            OpResult::Conflict { files, operation, note } => {
                assert_eq!(files, ["README.md"]);
                assert!(operation.is_none(), "a stash conflict is not a running operation");
                assert!(note.as_deref().is_some_and(|n| n.contains("stays in the list")), "{note:?}");
            }
            other => panic!("unexpected: {other:?}"),
        }
        assert_eq!(stash_list(&tc, id.clone()).await.unwrap().len(), 1, "on a conflict the stash is kept");
        let status = read_status(&tc, &id).await.unwrap();
        assert_eq!(status.conflicted.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["README.md"]);
        assert_eq!(undo_peek(&tc, id.clone()).await.unwrap(), undo_before, "no undo entry for a pop with a conflict");

        // As long as the conflict is open, no further stash and no applying is possible.
        assert_eq!(stash_apply(&tc, id.clone(), 0).await.unwrap_err().code, ErrorCode::Conflict);
        assert_eq!(stash_create(&tc, id, op(), None, None, true, None).await.unwrap_err().code, ErrorCode::Conflict);
    }

    #[tokio::test]
    async fn pop_is_blocked_by_uncommitted_changes() {
        let (tc, repo, id) = setup().await;
        repo.write_file("README.md", "# aus dem Stash\n");
        stash(&tc, &id, Some("tracked")).await;
        repo.write_file("README.md", "# lokal geändert\n");
        let err = stash_pop(&tc, id.clone(), 0).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::DirtyWorktree);
        assert!(err.git_output.is_some());
        assert_eq!(repo.read_file("README.md"), "# lokal geändert\n".as_bytes());
        assert_eq!(stash_list(&tc, id.clone()).await.unwrap().len(), 1);
        repo.git(&["checkout", "-q", "--", "README.md"]);

        // Untracked file from the stash already exists: nothing is half-applied.
        repo.write_file("README.md", "# zweiter Stash\n");
        repo.write_file("neu ü.txt", "aus dem Stash\n");
        stash(&tc, &id, Some("mit unverfolgter")).await;
        repo.write_file("neu ü.txt", "liegt schon da\n");
        let err = stash_pop(&tc, id.clone(), 0).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::DirtyWorktree);
        assert!(err.message.contains("neu ü.txt"), "{}", err.message);
        assert_eq!(repo.read_file("README.md"), b"# Test\n", "the tracked file was not applied");
        assert_eq!(repo.read_file("neu ü.txt"), b"liegt schon da\n");
        assert_eq!(stash_list(&tc, id).await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn drop_checks_the_index_and_keeps_the_order() {
        let (tc, repo, id) = setup().await;
        for name in ["eins", "zwei", "drei"] {
            repo.write_file("README.md", format!("# {name}\n"));
            stash(&tc, &id, Some(name)).await;
        }
        assert_eq!(stash_drop(&tc, id.clone(), 3).await.unwrap_err().code, ErrorCode::NotFound);
        tc.events.clear();
        let list = stash_drop(&tc, id.clone(), 1).await.unwrap();
        assert_eq!(list.iter().map(|s| s.message.as_str()).collect::<Vec<_>>(), ["drei", "eins"]);
        assert_eq!(list.iter().map(|s| s.index).collect::<Vec<_>>(), [0, 1]);
        assert_eq!(changed(&tc), ["stash"]);
        // Deleting is not reversible: no new undo entry (the last stash is on top).
        assert_eq!(undo_peek(&tc, id.clone()).await.unwrap().undo.unwrap().label, "Undo stash “drei”");
        stash_drop(&tc, id.clone(), 0).await.unwrap();
        let list = stash_drop(&tc, id.clone(), 0).await.unwrap();
        assert!(list.is_empty());
        assert_eq!(stash_drop(&tc, id, 0).await.unwrap_err().code, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn rename_keeps_position_sha_and_branch() {
        let (tc, repo, id) = setup().await;
        repo.write_file("README.md", "# eins\n");
        stash(&tc, &id, Some("eins")).await;
        repo.write_file("README.md", "# zwei\n");
        repo.write_file("extra.txt", "x\n");
        stash(&tc, &id, None).await;
        repo.write_file("README.md", "# drei\n");
        let before = stash(&tc, &id, Some("drei")).await;
        tc.events.clear();

        let after = stash_rename(&tc, id.clone(), 1, "  Mitte\numbenannt ".into()).await.unwrap();
        assert_eq!(after.iter().map(|s| s.sha.as_str()).collect::<Vec<_>>(), before.iter().map(|s| s.sha.as_str()).collect::<Vec<_>>());
        assert_eq!(after.iter().map(|s| s.message.as_str()).collect::<Vec<_>>(), ["drei", "Mitte umbenannt", "eins"]);
        assert_eq!(after[1].branch.as_deref(), Some("main"));
        assert_eq!(after[1].file_count, 2);
        assert_eq!(after[1].created_at, before[1].created_at);
        assert_eq!(changed(&tc), ["stash"]);
        assert_eq!(repo.git(&["for-each-ref", REBUILD_REF_PREFIX]), "", "holding refs are gone again");

        // Topmost and bottommost entry; the same text is not an error.
        let after = stash_rename(&tc, id.clone(), 0, "oben".into()).await.unwrap();
        let after2 = stash_rename(&tc, id.clone(), 2, "unten".into()).await.unwrap();
        assert_eq!(after2.iter().map(|s| s.message.as_str()).collect::<Vec<_>>(), ["oben", "Mitte umbenannt", "unten"]);
        assert_eq!(after2.iter().map(|s| s.sha.as_str()).collect::<Vec<_>>(), after.iter().map(|s| s.sha.as_str()).collect::<Vec<_>>());
        assert_eq!(stash_rename(&tc, id.clone(), 2, "unten".into()).await.unwrap(), after2);

        assert_eq!(stash_rename(&tc, id.clone(), 0, "  \n ".into()).await.unwrap_err().code, ErrorCode::EmptyMessage);
        assert_eq!(stash_rename(&tc, id.clone(), 3, "x".into()).await.unwrap_err().code, ErrorCode::NotFound);

        // The renamed stash can still be applied.
        repo.git(&["checkout", "-q", "--", "."]);
        assert!(matches!(stash_pop(&tc, id, 1).await.unwrap(), OpResult::Done { .. }));
        assert_eq!(repo.read_file("README.md"), b"# zwei\n");
        assert_eq!(repo.read_file("extra.txt"), b"x\n");
    }

    #[tokio::test]
    async fn foreign_index_lock_is_reported_as_locked() {
        let (tc, repo, id) = setup().await;
        repo.write_file("README.md", "# geändert\n");
        let lock = repo.path().join(".git").join("index.lock");
        std::fs::write(&lock, "").unwrap();
        let op_id = op();
        let err = stash_create(&tc, id.clone(), op_id.clone(), None, None, true, None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Locked);
        assert!(lock.exists(), "the foreign lock file is never deleted");
        assert_eq!(repo.read_file("README.md"), "# geändert\n".as_bytes());
        std::fs::remove_file(&lock).unwrap();
        assert_eq!(stash_create(&tc, id.clone(), op_id, None, None, true, None).await.unwrap().len(), 1);

        std::fs::write(&lock, "").unwrap();
        let err = stash_pop(&tc, id.clone(), 0).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Locked);
        std::fs::remove_file(&lock).unwrap();
        assert_eq!(stash_list(&tc, id).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn stash_during_a_merge_conflict_is_refused() {
        let (tc, repo, id) = setup().await;
        repo.checkout_new("feature");
        repo.commit_file("README.md", "# Feature\n", "Feature");
        repo.checkout("main");
        repo.commit_file("README.md", "# Main\n", "Main");
        assert!(!repo.merge("feature"));
        let err = stash_create(&tc, id.clone(), op(), None, None, true, None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Conflict);
        assert!(repo.path().join(".git").join("MERGE_HEAD").exists());
        assert!(stash_list(&tc, id).await.unwrap().is_empty());
    }
}
