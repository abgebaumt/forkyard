//! Staging, unstaging, discarding, ignoring, restoring.
//!
//! Every command runs under the repository's write lock and returns the fresh status
//! at the end. Paths are never passed to Git as arguments but NUL-separated
//! via stdin (`--pathspec-from-file`): that way there is no limit on the length of the
//! command line, and names with `*` or `[` are taken literally.
//!
//! Hunks and single lines: the diff is read again inside the lock
//! (`diff::patch_basis`), its token compared with `PatchSelection.expect`, the
//! partial patch built byte-exact (`diff::patch`) and applied with `git apply`.
//!
//! Discarding destroys work: beforehand a backup is created as a commit
//! (`refs/forkyard/undo/<id>/worktree`) together with an undo entry.

use std::collections::HashMap;
use std::path::Path;

use serde_json::json;

use crate::app::Core;
use crate::commands::diff::patch::{self, Direction};
use crate::commands::diff::{patch_basis, TempIndex};
use crate::commands::refs::read_head;
use crate::commands::status::{self, parse_porcelain_v2, read_status, EntryKind, StatusEntry};
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::GitCmd;
use crate::model::{Head, PatchSelection, RepoChange, Status};
use crate::undo::{self, UndoAction, UndoRecord};
use crate::util;

pub(crate) mod bulk;
#[cfg(test)]
mod bulk_tests;
#[cfg(test)]
mod tests;

/// Paths NUL-separated via stdin instead of as arguments.
const PATHS_FROM_STDIN: [&str; 2] = ["--pathspec-from-file=-", "--pathspec-file-nul"];

/// Identity of the backup commits; that way the backup works even without user.name/user.email.
const BACKUP_IDENTITY: [(&str, &str); 4] = [
    ("GIT_AUTHOR_NAME", "forkyard"),
    ("GIT_AUTHOR_EMAIL", "forkyard@localhost"),
    ("GIT_COMMITTER_NAME", "forkyard"),
    ("GIT_COMMITTER_EMAIL", "forkyard@localhost"),
];

/// Git invocation in the repository; paths are taken literally.
fn git(core: &Core, repo_id: &str) -> CoreResult<GitCmd> {
    Ok(core.git_for(repo_id)?.env("GIT_LITERAL_PATHSPECS", "1"))
}

/// Helper invocation that should not appear in the activity log.
fn quiet(core: &Core, repo_id: &str) -> CoreResult<GitCmd> {
    Ok(git(core, repo_id)?.no_log())
}

fn nul_separated<P: AsRef<[u8]>>(paths: &[P]) -> Vec<u8> {
    let mut out = Vec::new();
    for path in paths {
        out.extend_from_slice(path.as_ref());
        out.push(0);
    }
    out
}

// ---------------------------------------------------------------------------
// Staging and unstaging whole files
// ---------------------------------------------------------------------------

/// Stage whole files; `paths: None` = all. Deleted and untracked files too;
/// a conflicted file counts as resolved afterwards.
pub async fn stage_paths(core: &Core, repo_id: String, paths: Option<Vec<String>>) -> CoreResult<Status> {
    core.with_write_lock(&repo_id, &[RepoChange::Index], async {
        match &paths {
            None => {
                bulk::prestage(core, &repo_id, None, None).await?;
                git(core, &repo_id)?.args(["add", "-A"]).run().await?;
            }
            Some(list) if list.is_empty() => {}
            Some(list) => {
                let raw: Vec<Vec<u8>> = list.iter().map(|p| p.as_bytes().to_vec()).collect();
                bulk::prestage(core, &repo_id, None, Some(&raw)).await?;
                git(core, &repo_id)?.args(["add", "-A"]).args(PATHS_FROM_STDIN).stdin(nul_separated(list)).run().await?;
            }
        }
        read_status(core, &repo_id).await
    })
    .await
}

/// Take whole files out of the index; `paths: None` = all. For a rename
/// both sides belong to it. Conflicted files stay as they are.
pub async fn unstage_paths(core: &Core, repo_id: String, paths: Option<Vec<String>>) -> CoreResult<Status> {
    core.with_write_lock(&repo_id, &[RepoChange::Index], async {
        let unborn = matches!(read_head(core, &repo_id).await?, Head::Unborn { .. });
        let unmerged = unmerged_paths(core, &repo_id).await?;
        let targets: Vec<Vec<u8>> = match &paths {
            None => {
                let out = diff_cached(core, &repo_id, &["--name-only", "--no-renames"]).await?;
                util::split_z(&out).filter(|p| !unmerged.iter().any(|u| u == p)).map(<[u8]>::to_vec).collect()
            }
            Some(list) => {
                if let Some(path) = list.iter().find(|p| unmerged.iter().any(|u| u == p.as_bytes())) {
                    return Err(conflicted(path));
                }
                let mut targets: Vec<Vec<u8>> = list.iter().map(|p| p.as_bytes().to_vec()).collect();
                if !targets.is_empty() {
                    for (new, old) in staged_renames(core, &repo_id).await? {
                        if targets.contains(&new) && !targets.contains(&old) {
                            targets.push(old);
                        }
                    }
                }
                targets
            }
        };
        if !targets.is_empty() {
            let cmd = if unborn {
                // Without a commit there is nothing `restore` could reset to.
                git(core, &repo_id)?.args(["rm", "--cached", "-r", "-f", "-q"])
            } else {
                // `core.protectNTFS` rejects names that cannot exist on Windows – even here, where
                // no file is created at all. A staged deletion of such a file (repository from Linux)
                // could otherwise never be unstaged and would drag "Unstage all" down with it.
                git(core, &repo_id)?.args(["-c", "core.protectNTFS=false", "restore", "--staged"])
            };
            cmd.args(PATHS_FROM_STDIN).stdin(nul_separated(&targets)).run().await?;
        }
        read_status(core, &repo_id).await
    })
    .await
}

fn conflicted(path: &str) -> CoreError {
    CoreError::new(ErrorCode::Conflict, format!("“{path}” has a conflict. Resolve the conflict first or abort the operation."))
}

/// `git diff --cached … -z`: HEAD ↔ index, without touching the index.
async fn diff_cached(core: &Core, repo_id: &str, options: &[&str]) -> CoreResult<Vec<u8>> {
    let out = quiet(core, repo_id)?
        .read_only()
        .args(["-c", "diff.autoRefreshIndex=false", "diff", "--cached", "--no-ext-diff", "-z"])
        .args(options)
        .run()
        .await?;
    Ok(out.stdout)
}

/// Staged renames as (new path, old path).
async fn staged_renames(core: &Core, repo_id: &str) -> CoreResult<Vec<(Vec<u8>, Vec<u8>)>> {
    let out = diff_cached(core, repo_id, &["--name-status", "-M", "--diff-filter=R"]).await?;
    // Three records per rename: `R<similarity>`, old path, new path.
    let records: Vec<&[u8]> = util::split_z(&out).collect();
    Ok(records.chunks(3).filter(|c| c.len() == 3 && c[0].starts_with(b"R")).map(|c| (c[2].to_vec(), c[1].to_vec())).collect())
}

/// Paths with an open conflict (index entries of stages 1 to 3).
async fn unmerged_paths(core: &Core, repo_id: &str) -> CoreResult<Vec<Vec<u8>>> {
    let out = quiet(core, repo_id)?.read_only().args(["ls-files", "--unmerged", "-z"]).run().await?;
    let mut paths: Vec<Vec<u8>> = Vec::new();
    for record in util::split_z(&out.stdout) {
        // `<mode> <blob> <stage>TAB<path>`
        if let Some(tab) = record.iter().position(|&b| b == b'\t') {
            let path = &record[tab + 1..];
            if paths.last().map(Vec::as_slice) != Some(path) {
                paths.push(path.to_vec());
            }
        }
    }
    Ok(paths)
}

// ---------------------------------------------------------------------------
// Hunks and single lines
// ---------------------------------------------------------------------------

/// Hunks or lines from the `unstaged` diff into the index.
pub async fn stage_patch(core: &Core, repo_id: String, selection: PatchSelection) -> CoreResult<Status> {
    core.with_write_lock(&repo_id, &[RepoChange::Index], async {
        if let Some(patch) = selected_patch(core, &repo_id, &selection, false, Direction::Forward).await? {
            apply(core, &repo_id, patch.bytes, true, false).await?;
        }
        read_status(core, &repo_id).await
    })
    .await
}

/// Take hunks or lines from the `staged` diff out of the index again.
pub async fn unstage_patch(core: &Core, repo_id: String, selection: PatchSelection) -> CoreResult<Status> {
    core.with_write_lock(&repo_id, &[RepoChange::Index], async {
        if let Some(patch) = selected_patch(core, &repo_id, &selection, true, Direction::Reverse).await? {
            apply(core, &repo_id, patch.bytes, true, true).await?;
        }
        read_status(core, &repo_id).await
    })
    .await
}

/// Discard hunks or lines in the working directory (reversible via undo).
pub async fn discard_patch(core: &Core, repo_id: String, selection: PatchSelection) -> CoreResult<Status> {
    core.with_write_lock(&repo_id, &[RepoChange::Worktree], async {
        let Some(patch) = selected_patch(core, &repo_id, &selection, false, Direction::Reverse).await? else {
            return read_status(core, &repo_id).await;
        };
        let head = read_head(core, &repo_id).await?;
        let backup = Backup::create(core, &repo_id, &head, Some(std::slice::from_ref(&patch.path))).await?;
        // With `core.autocrlf` (or `eol` attributes) `git apply` rewrites the WHOLE file with the
        // line endings a checkout would give it – including lines nobody touched.
        // The state before is recorded so that they keep their line endings.
        let file = util::join_from_git(&core.repo_path(&repo_id)?, &patch.path);
        let before = std::fs::metadata(&file).ok().filter(|meta| meta.is_file() && meta.len() <= KEEP_EOL_MAX_BYTES).and_then(|_| std::fs::read(&file).ok());
        let hunks = patch::parse_diff(&patch.bytes).into_iter().next().map(|parsed| parsed.hunks).unwrap_or_default();
        // `git apply` checks everything first and then writes: after an error nothing has changed.
        if let Err(e) = apply(core, &repo_id, patch.bytes, false, true).await {
            backup.forget(core, &repo_id).await;
            return Err(e);
        }
        if let (Some(before), Ok(after)) = (before, std::fs::read(&file)) {
            if let Some(exact) = keep_line_endings(&before, &after, &hunks) {
                if let Err(e) = std::fs::write(&file, exact) {
                    log::warn!("Line endings not restored after discarding: {e}");
                }
            }
        }
        let label = format!("Undo discarding changes in ‘{}’", selection.path);
        backup.record(core, &repo_id, &head, label, Some(vec![selection.path.clone()])).await?;
        read_status(core, &repo_id).await
    })
    .await
}

/// Up to this size the file's line endings are preserved after discarding lines.
const KEEP_EOL_MAX_BYTES: u64 = 64 * 1024 * 1024;

/// Lines of a file including their line ending (`\n`, `\r\n` or none at the end of the file).
fn lines_with_endings(bytes: &[u8]) -> Vec<&[u8]> {
    bytes.split_inclusive(|byte| *byte == b'\n').collect()
}

/// The line ending of a line from [`lines_with_endings`].
fn ending_of(line: &[u8]) -> &'static [u8] {
    if line.ends_with(b"\r\n") {
        b"\r\n"
    } else if line.ends_with(b"\n") {
        b"\n"
    } else {
        b""
    }
}

/// Content of a line without its line ending (also without the `\r` before it).
fn without_ending(line: &[u8]) -> &[u8] {
    let line = line.strip_suffix(b"\n").unwrap_or(line);
    line.strip_suffix(b"\r").unwrap_or(line)
}

/// `\r\n` → `\n`: two versions are "equal except for line endings" if this matches.
fn unified_endings(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'\r' && bytes.get(index + 1) == Some(&b'\n') {
            continue;
        }
        out.push(*byte);
    }
    out
}

/// The file after a patch applied in reverse (`hunks`, new side = `before`), but with the
/// line endings of `before`: untouched lines stay byte for byte, a restored line
/// gets the line ending of the line it replaces (otherwise that of its neighbour).
///
/// `Some` only if Git has rewritten the line endings of untouched lines (without conversion
/// it writes the restored lines exactly as they are in the index – then its version
/// applies) and the result matches what Git wrote exactly except for line endings.
pub(crate) fn keep_line_endings(before: &[u8], after: &[u8], hunks: &[patch::PatchHunk]) -> Option<Vec<u8>> {
    if hunks.is_empty() || !before.contains(&b'\n') {
        return None;
    }
    let old = lines_with_endings(before);
    // Most frequent line ending of the file – for restored lines without a neighbour.
    let crlf = old.iter().filter(|line| line.ends_with(b"\r\n")).count();
    let usual: &[u8] = if crlf * 2 > old.len() { b"\r\n" } else { b"\n" };
    let mut out: Vec<u8> = Vec::with_capacity(after.len() + old.len());
    // What would come out without any conversion: untouched lines as before, restored ones as in the index.
    let mut plain: Vec<u8> = Vec::with_capacity(after.len() + old.len());
    let mut at = 0usize;
    for hunk in hunks {
        // Without lines on the new side the header names the line BEFORE.
        let start = if hunk.new_lines == 0 { hunk.new_start as usize } else { (hunk.new_start as usize).checked_sub(1)? };
        if start < at || start > old.len() {
            return None;
        }
        for line in &old[at..start] {
            out.extend_from_slice(line);
            plain.extend_from_slice(line);
        }
        at = start;
        // Line endings of the lines this block removes – in order, for the restored ones.
        let mut freed: std::collections::VecDeque<&[u8]> = std::collections::VecDeque::new();
        // A "−" line already came in the current block: it has taken the line endings of the "+" lines after it.
        let mut paired = false;
        let mut last: Option<&[u8]> = None;
        let mut index = 0;
        while index < hunk.lines.len() {
            let line = &hunk.lines[index];
            match line.kind {
                patch::LineKind::Context => {
                    let current = old.get(at)?;
                    if without_ending(current) != without_ending(&line.content) {
                        return None;
                    }
                    out.extend_from_slice(current);
                    plain.extend_from_slice(current);
                    last = Some(ending_of(current)).filter(|ending| !ending.is_empty());
                    freed.clear();
                    paired = false;
                    at += 1;
                }
                patch::LineKind::Add => {
                    let current = old.get(at)?;
                    if without_ending(current) != without_ending(&line.content) {
                        return None;
                    }
                    if !paired {
                        freed.push_back(ending_of(current));
                    } else if hunk.lines.get(index + 1).is_some_and(|next| next.kind == patch::LineKind::Remove) {
                        // Block written in pairs ("−a +A −b +B"): the next pair begins.
                        paired = false;
                        freed.clear();
                    }
                    at += 1;
                }
                patch::LineKind::Remove => {
                    // Git writes first all "−" lines, then all "+" lines of a block: the line endings
                    // of the "+" lines after it belong to these lines.
                    if freed.is_empty() && !paired {
                        paired = true;
                        let mut ahead = index + 1;
                        while ahead < hunk.lines.len() && hunk.lines[ahead].kind == patch::LineKind::Remove {
                            ahead += 1;
                        }
                        let mut position = at;
                        while ahead < hunk.lines.len() && hunk.lines[ahead].kind == patch::LineKind::Add {
                            if let Some(current) = old.get(position) {
                                freed.push_back(ending_of(current));
                            }
                            position += 1;
                            ahead += 1;
                        }
                    }
                    plain.extend_from_slice(&line.content);
                    if !line.no_newline {
                        plain.push(b'\n');
                    }
                    let content = line.content.strip_suffix(b"\r").unwrap_or(&line.content);
                    out.extend_from_slice(content);
                    if !line.no_newline {
                        let ending = freed.pop_front().filter(|ending| !ending.is_empty()).or(last).or_else(|| old.get(at).map(|next| ending_of(next)).filter(|ending| !ending.is_empty())).unwrap_or(usual);
                        // If the `\r` is already in the content from the index, it belongs to the line.
                        out.extend_from_slice(if line.content.ends_with(b"\r") { b"\r\n" } else { ending });
                        last = Some(ending);
                    }
                }
            }
            index += 1;
        }
    }
    for line in old.get(at..)? {
        out.extend_from_slice(line);
        plain.extend_from_slice(line);
    }
    if plain == after {
        // No conversion involved: Git wrote byte for byte what was in the index.
        return None;
    }
    (out != after && unified_endings(&out) == unified_endings(after)).then_some(out)
}

struct SelectedPatch {
    bytes: Vec<u8>,
    /// Path of the file in raw bytes.
    path: Vec<u8>,
}

/// Reads the diff again, checks the token and builds the patch for the selection.
/// `None`: no changed line is selected.
async fn selected_patch(core: &Core, repo_id: &str, selection: &PatchSelection, staged: bool, direction: Direction) -> CoreResult<Option<SelectedPatch>> {
    let basis = patch_basis(core, repo_id, &selection.path, staged).await?;
    if basis.token != selection.expect {
        return Err(CoreError::stale_state());
    }
    if selection.hunks.is_empty() {
        return Ok(None);
    }
    let bytes = patch::build_patch(basis.file()?, &basis.path, &selection.hunks, direction)?;
    Ok(bytes.map(|bytes| SelectedPatch { bytes, path: basis.path }))
}

/// `git apply` with the patch on stdin: in the index (`cached`) or in the working directory,
/// forwards or in reverse. Whitespace is neither complained about nor "fixed" – not even
/// when the user's configuration asks for that from `git apply`.
async fn apply(core: &Core, repo_id: &str, patch: Vec<u8>, cached: bool, reverse: bool) -> CoreResult<()> {
    let mut cmd = git(core, repo_id)?.args(["-c", "apply.whitespace=nowarn", "-c", "apply.ignoreWhitespace=no", "apply", "--whitespace=nowarn"]);
    if cached {
        cmd = cmd.arg("--cached");
    }
    if reverse {
        cmd = cmd.arg("-R");
    }
    cmd.stdin(patch).run().await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Backup before discarding (undo)
// ---------------------------------------------------------------------------

/// Backup of the working directory before a destructive action.
pub(crate) struct Backup {
    /// ID of the future undo entry; the backup refs live under it.
    id: String,
    /// Commit whose tree records the working directory (or the selected paths).
    snapshot: String,
    /// Tree of the index before the action; `None` if it contains open conflicts.
    index_tree: Option<String>,
}

impl Backup {
    /// Creates the backup: its own index outside the repository (copy of the real one, reset to HEAD),
    /// `git add -A` for everything or the paths, `write-tree`, `commit-tree`. The real
    /// index, HEAD and the working directory stay untouched.
    pub(crate) async fn create(core: &Core, repo_id: &str, head: &Head, paths: Option<&[Vec<u8>]>) -> CoreResult<Backup> {
        let head_sha = match head {
            Head::Branch { sha, .. } | Head::Detached { sha } => Some(sha.as_str()),
            Head::Unborn { .. } => None,
        };
        // `write-tree` takes the index lock: a foreign index.lock shows up here
        // before anything is destroyed.
        let index_tree = match quiet(core, repo_id)?.args(["write-tree"]).run().await {
            Ok(out) => Some(out.stdout_text()),
            // Locked or not writable: without a backup nothing is discarded.
            Err(e) if e.is(ErrorCode::Locked) || e.is(ErrorCode::Io) => return Err(e),
            Err(_) => None,
        };

        let temp = TempIndex::create(core)?;
        // The copy keeps the stat data of the real index; `git add` then only has to
        // re-read changed files instead of the whole working directory.
        let real_index = status::git_dir(core, repo_id).await?.join("index");
        if real_index.is_file() {
            tokio::fs::copy(&real_index, temp.path()).await?;
        }
        let on_temp = |args: &[&str]| -> CoreResult<GitCmd> { Ok(quiet(core, repo_id)?.env("GIT_INDEX_FILE", temp.path()).args(args)) };
        let reset: &[&str] = if head_sha.is_some() { &["read-tree", "--reset", "HEAD"] } else { &["read-tree", "--empty"] };
        on_temp(reset)?.run().await?;
        match paths {
            None => {
                bulk::prestage(core, repo_id, Some(temp.path()), None).await?;
                on_temp(&["add", "-A"])?.run().await?;
            }
            Some(list) => {
                let present = paths_to_snapshot(core, repo_id, head_sha.is_some(), list).await?;
                if !present.is_empty() {
                    bulk::prestage(core, repo_id, Some(temp.path()), Some(&present)).await?;
                    on_temp(&["add", "-A"])?.args(PATHS_FROM_STDIN).stdin(nul_separated(&present)).run().await?;
                }
            }
        }
        let tree = on_temp(&["write-tree"])?.run().await?.stdout_text();
        let parents: Vec<&str> = head_sha.into_iter().collect();
        // The bytes as they are on disk (line endings): second parent of the backup.
        let scope: Option<Vec<String>> = paths.map(|list| list.iter().map(|path| util::decode_lossy(path)).collect());
        let raw = match head_sha {
            Some(head) => undo::raw_overlay(core, repo_id, head, &tree, scope.as_deref()).await,
            None => None,
        };
        let snapshot_parents: Vec<&str> = parents.iter().copied().chain(raw.as_deref()).collect();
        let snapshot = commit_tree(core, repo_id, &tree, &snapshot_parents, "forkyard: backup").await?;

        // A commit of its own keeps the index tree alive as long as the undo entry exists.
        let index_commit = match &index_tree {
            Some(index_tree) => Some(commit_tree(core, repo_id, index_tree, &parents, "forkyard: backup (index)").await?),
            None => None,
        };

        let backup = Backup { id: undo::new_id(), snapshot, index_tree };
        let mut refs = vec![("worktree", backup.snapshot.as_str())];
        if let Some(index_commit) = &index_commit {
            refs.push(("index", index_commit));
        }
        for (name, sha) in refs {
            if let Err(e) = undo::create_backup_ref(core, repo_id, &backup.id, name, sha).await {
                backup.forget(core, repo_id).await;
                return Err(e);
            }
        }
        Ok(backup)
    }

    /// The action did not happen: remove the backup refs again.
    pub(crate) async fn forget(self, core: &Core, repo_id: &str) {
        if let Err(e) = undo::delete_backup_refs(core, repo_id, &self.id).await {
            log::warn!("Backup refs of {} not removed: {}", self.id, e.message);
        }
    }

    /// Undo entry following the undo convention; `paths: None` = everything.
    pub(crate) async fn record(self, core: &Core, repo_id: &str, head: &Head, label: String, paths: Option<Vec<String>>) -> CoreResult<()> {
        self.record_with(core, repo_id, head, label, paths, None).await
    }

    /// Like `record`; `restored_from` names the commit from which `file_restore` took the files.
    async fn record_with(
        self,
        core: &Core,
        repo_id: &str,
        head: &Head,
        label: String,
        paths: Option<Vec<String>>,
        restored_from: Option<&str>,
    ) -> CoreResult<()> {
        let recorded = self.store(core, repo_id, head, label, paths, restored_from, None).await?;
        // The action has already run: its result is the state against which undo later
        // detects what the user has added since.
        recorded.finish(core, repo_id).await;
        Ok(())
    }

    /// Stores the undo entry BEFORE the action destroys anything: if the app ends midway,
    /// undo still offers the backup after the restart. `expected` is the state that
    /// the action will produce (tree or commit); `Recorded::finish` replaces it with the
    /// real one, `Recorded::cancel` withdraws the entry if nothing happened.
    pub(crate) async fn record_before(
        self,
        core: &Core,
        repo_id: &str,
        head: &Head,
        label: String,
        paths: Option<Vec<String>>,
        expected: Option<String>,
    ) -> CoreResult<Recorded> {
        self.store(core, repo_id, head, label, paths, None, expected).await
    }

    /// The index tree before the action: discarded tracked files fall back to it.
    pub(crate) fn index_tree(&self) -> Option<String> {
        self.index_tree.clone()
    }

    #[allow(clippy::too_many_arguments)]
    async fn store(
        self,
        core: &Core,
        repo_id: &str,
        head: &Head,
        label: String,
        paths: Option<Vec<String>>,
        restored_from: Option<&str>,
        expected: Option<String>,
    ) -> CoreResult<Recorded> {
        let head_name = match head {
            Head::Branch { branch, .. } | Head::Unborn { branch } => format!("refs/heads/{branch}"),
            Head::Detached { sha } => sha.clone(),
        };
        let mut payload = json!({ "worktreeSnapshot": self.snapshot, "indexTree": self.index_tree, "paths": paths });
        if let Some(commit) = restored_from {
            payload["restoredFrom"] = json!(commit);
        }
        if let Some(expected) = expected {
            payload["resultSnapshot"] = json!(expected);
        }
        let id = self.id.clone();
        undo::record(
            core,
            UndoRecord {
                id: self.id,
                repo_id: repo_id.to_string(),
                worktree_path: String::new(),
                action: UndoAction::Discard,
                label,
                ref_name: None,
                ref_before: None,
                ref_after: None,
                head_before: head_name.clone(),
                head_after: Some(head_name),
                payload,
            },
        )
        .await?;
        Ok(Recorded { id, paths })
    }
}

/// An already stored undo entry of a destructive action.
pub(crate) struct Recorded {
    id: String,
    paths: Option<Vec<String>>,
}

impl Recorded {
    /// The action has run (fully or partially): record the real state afterwards.
    pub(crate) async fn finish(self, core: &Core, repo_id: &str) {
        undo::record_result(core, repo_id, &self.id, self.paths.as_deref()).await;
    }

    /// The action changed nothing: the entry disappears together with the backup.
    pub(crate) async fn cancel(self, core: &Core, repo_id: &str) {
        crate::commands::undo::discard_entry(core, repo_id, &self.id).await;
    }
}

async fn commit_tree(core: &Core, repo_id: &str, tree: &str, parents: &[&str], message: &str) -> CoreResult<String> {
    let mut cmd = quiet(core, repo_id)?.args(["commit-tree", "--no-gpg-sign", tree]);
    for parent in parents {
        cmd = cmd.args(["-p", parent]);
    }
    for (key, value) in BACKUP_IDENTITY {
        cmd = cmd.env(key, value);
    }
    Ok(cmd.args(["-m", message]).run().await?.stdout_text())
}

/// `git add -A -- <path>` fails on paths that exist neither in the working directory nor
/// in the index (reset to HEAD) – such as a staged new file that was deleted
/// again. Such paths have no place in the backup.
async fn paths_to_snapshot(core: &Core, repo_id: &str, has_head: bool, paths: &[Vec<u8>]) -> CoreResult<Vec<Vec<u8>>> {
    let root = core.repo_path(repo_id)?;
    let (mut present, mut gone): (Vec<Vec<u8>>, Vec<Vec<u8>>) = (Vec::new(), Vec::new());
    for path in paths {
        if std::fs::symlink_metadata(util::join_from_git(&root, path)).is_ok() {
            present.push(path.clone());
        } else {
            gone.push(path.clone());
        }
    }
    if has_head && !gone.is_empty() {
        let mut stdin = Vec::new();
        for path in &gone {
            stdin.extend_from_slice(b"HEAD:");
            stdin.extend_from_slice(path);
            stdin.push(0);
        }
        let out = quiet(core, repo_id)?.read_only().args(["cat-file", "--batch-check=%(objecttype)", "-z"]).stdin(stdin).run().await?;
        for (path, answer) in gone.iter().zip(out.stdout_lines()) {
            if !answer.ends_with(b"missing") {
                present.push(path.clone());
            }
        }
    }
    Ok(present)
}

// ---------------------------------------------------------------------------
// Discarding files
// ---------------------------------------------------------------------------

/// Discard files; `paths: None` = everything, including untracked ones. Creates a backup first.
///
/// - With paths: tracked files go back to the index state (staged changes
///   stay), untracked ones are deleted.
/// - Without paths: index and working directory go back to HEAD, untracked
///   files are deleted (ignored ones stay).
pub async fn discard_paths(core: &Core, repo_id: String, paths: Option<Vec<String>>) -> CoreResult<Status> {
    let changes: &[RepoChange] = match paths {
        None => &[RepoChange::Worktree, RepoChange::Index],
        Some(_) => &[RepoChange::Worktree],
    };
    core.with_write_lock(&repo_id, changes, async {
        match paths {
            None => discard_all(core, &repo_id).await?,
            Some(list) => discard_some(core, &repo_id, &list).await?,
        }
        read_status(core, &repo_id).await
    })
    .await
}

/// Entries from `git status --porcelain=v2`, paths in raw bytes.
async fn status_entries(core: &Core, repo_id: &str) -> CoreResult<Vec<StatusEntry>> {
    let out = quiet(core, repo_id)?.read_only().args(["status", "--porcelain=v2", "-z", "--untracked-files=all", "--find-renames"]).run().await?;
    Ok(parse_porcelain_v2(&out.stdout).entries)
}

fn discard_label(names: &[String]) -> String {
    match names {
        [one] => format!("Undo discarding ‘{one}’"),
        _ => format!("Undo discarding {} files", names.len()),
    }
}

async fn discard_all(core: &Core, repo_id: &str) -> CoreResult<()> {
    if status::read_operation(core, repo_id).await?.is_some() {
        return Err(CoreError::new(
            ErrorCode::OperationInProgress,
            "A merge, rebase, cherry-pick or revert is in progress. Discarding everything would break it – abort the operation or discard individual files instead.",
        ));
    }
    let entries = status_entries(core, repo_id).await?;
    if entries.is_empty() {
        return Ok(());
    }
    let names: Vec<String> = entries.iter().map(|e| util::decode_lossy(&e.path)).collect();
    let head = read_head(core, repo_id).await?;
    let backup = Backup::create(core, repo_id, &head, None).await?;
    // The undo entry exists before anything is discarded: even after a crash midway
    // undo offers the backup. Afterwards everything is at the state of HEAD.
    let expected = match &head {
        Head::Branch { sha, .. } | Head::Detached { sha } => sha.clone(),
        Head::Unborn { .. } => undo::EMPTY_TREE.to_string(),
    };
    let recorded = backup.record_before(core, repo_id, &head, discard_label(&names), None, Some(expected)).await?;

    let outcome = match head {
        // Without a commit, "back to HEAD" is an empty index; `clean` removes the files.
        Head::Unborn { .. } => match git(core, repo_id)?.args(["read-tree", "--empty"]).run().await {
            Err(e) if e.is(ErrorCode::Locked) => {
                recorded.cancel(core, repo_id).await;
                return Err(e);
            }
            Err(e) => Err(e),
            Ok(_) => git(core, repo_id)?.args(["clean", "-f", "-d", "-q"]).run().await.map(|_| ()),
        },
        // Untracked files first, then the rest: that way `clean` applies with the ignore rules
        // the user is seeing right now. After `reset --hard` a not yet committed line
        // of the .gitignore would be gone, and the file ignored a moment ago would be deleted too –
        // without being in the backup.
        _ => match git(core, repo_id)?.args(["clean", "-f", "-d", "-q"]).run().await {
            Err(e) => Err(e),
            Ok(_) => git(core, repo_id)?.args(["reset", "--hard", "-q", "HEAD"]).run().await.map(|_| ()),
        },
    };
    // Even after an error midway, work may already have been discarded: the entry stays.
    recorded.finish(core, repo_id).await;
    outcome
}

async fn discard_some(core: &Core, repo_id: &str, requested: &[String]) -> CoreResult<()> {
    let entries = status_entries(core, repo_id).await?;
    // The UI only knows decoded paths; the entries provide the raw bytes for them.
    let by_name: HashMap<String, &StatusEntry> = entries.iter().map(|e| (util::decode_lossy(&e.path), e)).collect();
    // Back to the index state, delete, take out of the index (only "to be added" entries).
    let mut restore: Vec<Vec<u8>> = Vec::new();
    let mut delete: Vec<Vec<u8>> = Vec::new();
    let mut forget: Vec<Vec<u8>> = Vec::new();
    let mut names: Vec<String> = Vec::new();
    for wanted in requested {
        let Some(entry) = by_name.get(wanted).copied() else { continue };
        if names.contains(wanted) {
            continue;
        }
        match (entry.kind, entry.y) {
            (EntryKind::Unmerged, _) => return Err(conflicted(wanted)),
            // Untracked directories are embedded repositories: don't touch them.
            (EntryKind::Untracked, _) if entry.path.ends_with(b"/") => continue,
            (EntryKind::Untracked, _) => delete.push(entry.path.clone()),
            // Nothing changed in the working directory (only staged).
            (EntryKind::Tracked, b'.') => continue,
            // New file marked with `git add -N`, also as the target of a rename.
            (EntryKind::Tracked, b'A' | b'R' | b'C') => {
                delete.push(entry.path.clone());
                forget.push(entry.path.clone());
                if let Some(origin) = entry.orig_path.as_ref().filter(|_| entry.y == b'R') {
                    restore.push(origin.clone());
                }
            }
            (EntryKind::Tracked, _) => restore.push(entry.path.clone()),
        }
        names.push(wanted.clone());
    }
    if names.is_empty() {
        return Ok(());
    }
    let affected: Vec<Vec<u8>> = restore.iter().chain(&delete).cloned().collect();
    let head = read_head(core, repo_id).await?;
    let backup = Backup::create(core, repo_id, &head, Some(&affected)).await?;
    // The undo entry exists before anything is discarded (crash midway). Discarded
    // files fall back to the index state, untracked ones disappear.
    let expected = backup.index_tree();
    let recorded = backup.record_before(core, repo_id, &head, discard_label(&names), Some(names), expected).await?;

    let mut failure: Option<CoreError> = None;
    if !restore.is_empty() {
        let restored = git(core, repo_id)?.args(["restore", "--worktree"]).args(PATHS_FROM_STDIN).stdin(nul_separated(&restore)).run().await;
        match restored {
            // Failed on the lock: nothing is discarded, nobody needs the backup.
            Err(e) if e.is(ErrorCode::Locked) => {
                recorded.cancel(core, repo_id).await;
                return Err(e);
            }
            Err(e) => failure = Some(e),
            Ok(_) => {}
        }
    }
    if failure.is_none() {
        let root = core.repo_path(repo_id)?;
        for path in &delete {
            if let Err(e) = remove_file_and_empty_parents(&root, path) {
                failure.get_or_insert(CoreError::io(format!("“{}” could not be deleted: {e}", util::decode_lossy(path))));
            }
        }
        if !forget.is_empty() {
            let forgotten = git(core, repo_id)?.args(["update-index", "--force-remove", "-z", "--stdin"]).stdin(nul_separated(&forget)).run().await;
            if let Err(e) = forgotten {
                failure.get_or_insert(e);
            }
        }
    }
    // Even after an error midway, work may already have been discarded: the entry stays.
    recorded.finish(core, repo_id).await;
    match failure {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

/// Deletes a file and afterwards parent directories that have become empty as a result.
fn remove_file_and_empty_parents(root: &Path, relative: &[u8]) -> std::io::Result<()> {
    let full = util::join_from_git(root, relative);
    match std::fs::symlink_metadata(&full) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e),
        Ok(meta) if meta.is_dir() => return Ok(()),
        Ok(meta) => {
            if let Err(first) = std::fs::remove_file(&full) {
                // On Windows a read-only file cannot be deleted.
                let mut permissions = meta.permissions();
                if !permissions.readonly() {
                    return Err(first);
                }
                #[allow(clippy::permissions_set_readonly_false)]
                permissions.set_readonly(false);
                std::fs::set_permissions(&full, permissions)?;
                std::fs::remove_file(&full)?;
            }
        }
    }
    let mut dir = full.parent();
    while let Some(current) = dir {
        if current == root || std::fs::remove_dir(current).is_err() {
            break;
        }
        dir = current.parent();
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Deleting a file
// ---------------------------------------------------------------------------

/// Deletes a file in the working directory (tracked or untracked); the index stays
/// untouched, a tracked file then shows up as "deleted" among the unstaged
/// changes. A backup is created first: undo brings the file back, redo deletes
/// it again. Directories that become empty go as well.
///
/// Errors: file missing → `not_found`; directory, path outside the repository or in
/// `.git`, ignored file (there would be no backup of it) → `not_allowed`; conflicted file
/// → `conflict`; foreign index.lock → `locked` (then nothing is deleted).
pub async fn file_delete(core: &Core, repo_id: String, path: String) -> CoreResult<Status> {
    let rel = crate::commands::history::normalize_rel_path(&path)?;
    if crate::commands::history::is_inside_git_dir(&rel) {
        return Err(CoreError::not_allowed("Nothing is deleted inside the Git directory (.git)."));
    }
    core.with_write_lock(&repo_id, &[RepoChange::Worktree], async {
        let root = core.repo_path(&repo_id)?;
        let full = crate::commands::history::join_rel(&root, &rel);
        let meta = match std::fs::symlink_metadata(&full) {
            Ok(meta) => meta,
            Err(_) => return Err(CoreError::not_found(format!("The file “{rel}” does not exist in the working directory."))),
        };
        if meta.is_dir() {
            return Err(CoreError::not_allowed(format!("“{rel}” is a folder; only files can be deleted here.")));
        }
        // The file's directory must really be inside the repository (no link to the outside).
        let inside = match (root.canonicalize(), full.parent().map(Path::canonicalize)) {
            (Ok(real_root), Some(Ok(real_parent))) => real_parent.starts_with(&real_root),
            _ => false,
        };
        if !inside {
            return Err(CoreError::not_allowed(format!("“{rel}” points to a location outside the repository.")));
        }
        let raw = rel.as_bytes().to_vec();
        if unmerged_paths(core, &repo_id).await?.contains(&raw) {
            return Err(conflicted(&rel));
        }
        let tracked = !quiet(core, &repo_id)?.read_only().args(["ls-files", "-z", "--"]).arg(&rel).run().await?.stdout.is_empty();
        if !tracked {
            // Without GIT_LITERAL_PATHSPECS: `check-ignore` rejects that setting and takes paths literally anyway.
            let ignored = core.git_for(&repo_id)?.no_log().read_only().args(["check-ignore", "-q", "--"]).arg(&rel).run_raw().await?;
            if ignored.code == Some(0) {
                return Err(CoreError::not_allowed(format!(
                    "“{rel}” is ignored by Git. Ignored files have no backup; please delete it in your file manager."
                )));
            }
        }
        let head = read_head(core, &repo_id).await?;
        let backup = Backup::create(core, &repo_id, &head, Some(std::slice::from_ref(&raw))).await?;
        if let Err(e) = remove_file_and_empty_parents(&root, &raw) {
            backup.forget(core, &repo_id).await;
            return Err(CoreError::io(format!("“{rel}” could not be deleted: {e}")));
        }
        backup.record(core, &repo_id, &head, format!("Undo deleting ‘{rel}’"), Some(vec![rel.clone()])).await?;
        read_status(core, &repo_id).await
    })
    .await
}

// ---------------------------------------------------------------------------
// Ignoring
// ---------------------------------------------------------------------------

/// Pattern into the .gitignore in the root directory; optionally `git rm --cached`.
///
/// The file is created if it is missing; its line endings are preserved; a pattern
/// that is already in it is not added twice. With `stop_tracking`, tracked files
/// matching the pattern leave the index (they stay on disk).
pub async fn ignore_add(core: &Core, repo_id: String, pattern: String, stop_tracking: bool) -> CoreResult<Status> {
    let pattern = pattern.trim().to_string();
    if pattern.is_empty() {
        return Err(CoreError::not_allowed("The pattern must not be empty."));
    }
    if pattern.contains(['\n', '\r', '\0']) {
        return Err(CoreError::not_allowed("The pattern must not contain a line break."));
    }
    let changes: &[RepoChange] = if stop_tracking { &[RepoChange::Worktree, RepoChange::Index] } else { &[RepoChange::Worktree] };
    core.with_write_lock(&repo_id, changes, async {
        let file = core.repo_path(&repo_id)?.join(".gitignore");
        // A repository can bring `.gitignore` as a symbolic link to a file outside –
        // nothing is written there.
        if std::fs::symlink_metadata(&file).is_ok_and(|meta| !meta.is_file()) {
            return Err(CoreError::not_allowed(
                "This repository’s .gitignore is a symbolic link or not a regular file. Forkyard does not write through it; please add the pattern by hand.",
            ));
        }
        let mut content = match tokio::fs::read(&file).await {
            Ok(bytes) => bytes,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(e) => return Err(e.into()),
        };
        let known = content.split(|&b| b == b'\n').any(|line| line.trim_ascii() == pattern.as_bytes());
        if !known {
            let eol: &[u8] = if content.windows(2).any(|w| w == b"\r\n") { b"\r\n" } else { b"\n" };
            if !content.is_empty() && !content.ends_with(b"\n") {
                content.extend_from_slice(eol);
            }
            content.extend_from_slice(pattern.as_bytes());
            content.extend_from_slice(eol);
            let target = file.clone();
            tokio::task::spawn_blocking(move || util::write_file_atomic(&target, &content))
                .await
                .map_err(|e| CoreError::io(format!("Writing the .gitignore was aborted: {e}")))??;
        }
        if stop_tracking {
            // Tracked files matched by exactly this pattern (read like a line of the .gitignore in the root directory).
            let tracked = quiet(core, &repo_id)?.read_only().args(["ls-files", "-z", "--cached", "--ignored"]).arg(format!("--exclude={pattern}")).run().await?;
            if !tracked.stdout.is_empty() {
                git(core, &repo_id)?.args(["rm", "--cached", "-r", "-q"]).args(PATHS_FROM_STDIN).stdin(tracked.stdout).run().await?;
            }
        }
        read_status(core, &repo_id).await
    })
    .await
}

// ---------------------------------------------------------------------------
// Restoring
// ---------------------------------------------------------------------------

/// Restore files from a commit; they end up staged. If one of the files does not exist in
/// the commit, nothing happens and the error is `not_found`.
///
/// Whatever gets overwritten in the working directory and in the index is backed up first:
/// an undo entry is created (action `discard`, `payload.restoredFrom` = commit) that
/// brings back the state before. If restoring changes nothing, none is created.
pub async fn file_restore(core: &Core, repo_id: String, sha: String, paths: Vec<String>) -> CoreResult<Status> {
    let unknown_commit = || CoreError::not_found(format!("Commit “{sha}” was not found."));
    // Only SHAs (abbreviated too) – nothing Git could read as an option or expression.
    if !(4..=64).contains(&sha.len()) || !sha.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(unknown_commit());
    }
    let resolved = quiet(core, &repo_id)?.read_only().args(["rev-parse", "--verify", "--quiet", &format!("{sha}^{{commit}}")]).run_raw().await?;
    if !resolved.success() {
        return Err(unknown_commit());
    }
    let commit = resolved.stdout_text();
    if paths.is_empty() {
        return read_status(core, &repo_id).await;
    }
    // `git restore` would delete a file that doesn't exist in the commit instead of reporting it.
    let mut stdin = Vec::new();
    for path in &paths {
        stdin.extend_from_slice(format!("{commit}:{path}").as_bytes());
        stdin.push(0);
    }
    let found = quiet(core, &repo_id)?.read_only().args(["cat-file", "--batch-check=%(objecttype)", "-z"]).stdin(stdin).run().await?;
    let kinds: Vec<String> = found.stdout_lines().into_iter().map(util::decode_lossy).collect();
    for (i, path) in paths.iter().enumerate() {
        match kinds.get(i).map(String::as_str) {
            Some("blob") => {}
            Some("tree") => return Err(CoreError::not_allowed(format!("“{path}” is a folder in this commit; only files can be restored."))),
            _ => return Err(CoreError::not_found(format!("The file “{path}” does not exist in this commit."))),
        }
    }
    core.with_write_lock(&repo_id, &[RepoChange::Worktree, RepoChange::Index], async {
        if !differs_from_commit(core, &repo_id, &commit, &paths).await? {
            return read_status(core, &repo_id).await;
        }
        let head = read_head(core, &repo_id).await?;
        let raw: Vec<Vec<u8>> = paths.iter().map(|p| p.as_bytes().to_vec()).collect();
        let backup = Backup::create(core, &repo_id, &head, Some(&raw)).await?;
        let restored = git(core, &repo_id)?
            .args(["restore", "--staged", "--worktree"])
            .arg(format!("--source={commit}"))
            .args(PATHS_FROM_STDIN)
            .stdin(nul_separated(&paths))
            .run()
            .await;
        if let Err(e) = restored {
            // `git restore` checks first and then writes; failed on the lock, nothing has changed.
            if e.is(ErrorCode::Locked) {
                backup.forget(core, &repo_id).await;
                return Err(e);
            }
            // Otherwise something may already be overwritten: the undo entry is created anyway.
            backup.record_with(core, &repo_id, &head, restore_label(&paths, &commit), Some(paths.clone()), Some(&commit)).await?;
            return Err(e);
        }
        backup.record_with(core, &repo_id, &head, restore_label(&paths, &commit), Some(paths.clone()), Some(&commit)).await?;
        read_status(core, &repo_id).await
    })
    .await
}

fn restore_label(paths: &[String], commit: &str) -> String {
    let short: String = commit.chars().take(7).collect();
    match paths {
        [one] => format!("Undo restoring ‘{one}’ from {short}"),
        many => format!("Undo restoring {} files from {short}", many.len()),
    }
}

/// Whether one of the files in the working directory or in the index differs from `commit`.
/// When in doubt (very many paths, file only with a new timestamp) rather "yes": then there is
/// one backup too many, never one too few.
async fn differs_from_commit(core: &Core, repo_id: &str, commit: &str, paths: &[String]) -> CoreResult<bool> {
    const MAX_PATHS_AS_ARGUMENTS: usize = 200;
    if paths.len() > MAX_PATHS_AS_ARGUMENTS {
        return Ok(true);
    }
    for cached in [false, true] {
        let mut cmd = quiet(core, repo_id)?.read_only().args(["-c", "diff.autoRefreshIndex=false", "diff", "--quiet", "--no-ext-diff"]);
        if cached {
            cmd = cmd.arg("--cached");
        }
        cmd = cmd.arg(commit).arg("--");
        for path in paths {
            cmd = cmd.arg_bytes(path.as_bytes());
        }
        if cmd.run_raw().await?.code != Some(0) {
            return Ok(true);
        }
    }
    // An untracked file at that location counts as well: the path is then missing in the index.
    Ok(false)
}

#[cfg(test)]
mod eol_tests {
    use super::*;

    fn hunks(patch_text: &str) -> Vec<patch::PatchHunk> {
        patch::parse_diff(patch_text.as_bytes()).into_iter().next().unwrap().hunks
    }

    /// A discarded hunk leaves the line endings of all other lines as they were.
    #[test]
    fn discarded_hunk_keeps_the_line_endings_of_the_file() {
        // Working directory: mixed line endings; line 3 is changed (CRLF), line 5 is new (LF).
        let before = b"eins\r\nzwei\ndrei NEU\r\nvier\nneu\nfuenf\r\n";
        let patch_text = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,5 +1,6 @@\n eins\n zwei\n-drei\n+drei NEU\n vier\n+neu\n fuenf\n";
        // Git has (autocrlf=input) normalised everything to LF.
        let after = b"eins\nzwei\ndrei\nvier\nfuenf\n";
        let exact = keep_line_endings(before, after, &hunks(patch_text)).expect("line endings can be preserved");
        assert_eq!(exact, b"eins\r\nzwei\ndrei\r\nvier\nfuenf\r\n", "the restored line keeps the line ending of the replaced one");
    }

    /// Without conversion (no autocrlf) Git writes the restored line exactly as it is in the
    /// index – even if the replaced line had a different line ending. Then Git's version applies.
    #[test]
    fn restored_lines_keep_the_ending_from_the_index_when_nothing_is_converted() {
        let before = b"a\r\nB\nc\r\nD\r\ne\n";
        let patch_text = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,4 +1,5 @@\n a\r\n B\n c\r\n-d\n+D\r\n e\n";
        let after = b"a\r\nB\nc\r\nd\ne\n";
        assert_eq!(keep_line_endings(before, after, &hunks(patch_text)), None);
    }

    #[test]
    fn nothing_to_repair_when_git_already_wrote_the_same_bytes() {
        let before = b"eins\nzwei NEU\ndrei\n";
        let patch_text = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n eins\n-zwei\n+zwei NEU\n drei\n";
        assert_eq!(keep_line_endings(before, b"eins\nzwei\ndrei\n", &hunks(patch_text)), None);
    }

    #[test]
    fn a_patch_that_does_not_fit_is_left_to_git() {
        let before = b"ganz\r\nanders\r\n";
        let patch_text = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n eins\n-zwei\n+zwei NEU\n drei\n";
        assert_eq!(keep_line_endings(before, b"eins\nzwei\ndrei\n", &hunks(patch_text)), None);
        // If the patch fits but the result differs in content from Git's version: Git's version applies.
        let before = b"eins\r\nzwei NEU\r\ndrei\r\n";
        assert_eq!(keep_line_endings(before, b"eins\nETWAS ANDERES\ndrei\n", &hunks(patch_text)), None);
    }

    #[test]
    fn restored_lines_at_the_end_and_without_final_newline() {
        // Only deleted lines come back (no "+" line whose line ending would be taken over).
        let before = b"eins\r\nvier\r\n";
        let patch_text = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,4 +1,2 @@\n eins\n-zwei\n-drei\n vier\n";
        let exact = keep_line_endings(before, b"eins\nzwei\ndrei\nvier\n", &hunks(patch_text)).unwrap();
        assert_eq!(exact, b"eins\r\nzwei\r\ndrei\r\nvier\r\n");
        // The last line had no line ending and gets none.
        let before = b"eins\r\nzwei NEU";
        let patch_text = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n eins\n-zwei\n\\ No newline at end of file\n+zwei NEU\n\\ No newline at end of file\n";
        let exact = keep_line_endings(before, b"eins\nzwei", &hunks(patch_text)).unwrap();
        assert_eq!(exact, b"eins\r\nzwei");
    }
}
