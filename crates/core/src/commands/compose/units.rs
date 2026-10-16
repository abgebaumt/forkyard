//! What "Compose commits" works on (v1.2, Teilpaket 3.2): every change between HEAD and the
//! working directory – staged, unstaged and untracked (not ignored) – as units. A modified text
//! file gives one unit per hunk; new, deleted, renamed, binary, LFS, submodule, symlink and mode
//! changes are one unit for the whole file.
//!
//! The working directory is read as a tree (`undo::worktree_tree`: `git add -A` into a copy of the
//! index), so Git's filters apply exactly as when committing and the real index stays untouched.
//! A unit ID carries a token over the file's raw diff; the state token covers HEAD, the index and
//! the working-directory tree – `compose_apply` refuses with `stale_state` when it differs.

use std::collections::HashMap;

use crate::app::Core;
use crate::commands::commit::operation_error;
use crate::commands::diff::patch::{self, FilePatch, LineKind, PatchHunk};
use crate::commands::diff::{only_this_file, parse_raw_z, token_of, RawEntry, TempIndex, DIFF_COMMAND};
use crate::commands::status::{self, read_status};
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::GitCmd;
use crate::model::{ComposeState, ComposeUnit, ComposeUnitKind, DiffLine, DiffLineKind, Head};
use crate::{undo, util};

/// At most this many diff lines of one unit go to the UI (the commit always takes all of them).
pub(crate) const MAX_UNIT_LINES: usize = 400;
/// Modified text files beyond this count are units as a whole; their patch is not read.
pub(crate) const MAX_SPLIT_FILES: usize = 400;
const GITLINK_MODE: &str = "160000";
const SYMLINK_MODE: &str = "120000";
const TOKEN_TAG: &str = "compose";

/// One changed file and how it is composed.
#[derive(Debug, Clone)]
pub(crate) struct ChangedFile {
    pub(crate) entry: RawEntry,
    pub(crate) path: String,
    pub(crate) old_path: Option<String>,
    pub(crate) kind: ComposeUnitKind,
    /// `git diff <HEAD> <worktree tree>` of this file, parsed (split text files and new text files).
    pub(crate) patch: Option<FilePatch>,
    pub(crate) token: String,
    pub(crate) added: u32,
    pub(crate) removed: u32,
}

impl ChangedFile {
    /// `None` for a whole-file unit, otherwise the number of hunks.
    pub(crate) fn hunk_count(&self) -> Option<usize> {
        (self.kind == ComposeUnitKind::Hunk).then(|| self.patch.as_ref().map_or(0, |patch| patch.hunks.len()))
    }

    pub(crate) fn unit_id(&self, hunk: Option<usize>) -> String {
        match hunk {
            Some(index) => format!("{}#{index}@{}", self.path, self.token),
            None => format!("{}#file@{}", self.path, self.token),
        }
    }

    /// Every unit ID of the file, in file order.
    pub(crate) fn unit_ids(&self) -> Vec<String> {
        match self.hunk_count() {
            Some(count) => (0..count).map(|index| self.unit_id(Some(index))).collect(),
            None => vec![self.unit_id(None)],
        }
    }
}

/// The state compose works on, read inside or outside the write lock.
#[derive(Debug, Clone)]
pub(crate) struct ComposeRead {
    pub(crate) head: String,
    pub(crate) branch: String,
    pub(crate) worktree_tree: String,
    pub(crate) token: String,
    pub(crate) signing: bool,
    pub(crate) files: Vec<ChangedFile>,
}

impl ComposeRead {
    pub(crate) fn state(&self) -> ComposeState {
        ComposeState {
            token: self.token.clone(),
            branch: self.branch.clone(),
            head: self.head.clone(),
            units: self.files.iter().flat_map(file_units).collect(),
            signing: self.signing,
        }
    }

    /// Unit ID → (index into `files`, hunk index; `None` = whole file).
    pub(crate) fn index(&self) -> HashMap<String, (usize, Option<usize>)> {
        let mut map = HashMap::new();
        for (file_index, file) in self.files.iter().enumerate() {
            match file.hunk_count() {
                Some(count) => {
                    for hunk in 0..count {
                        map.insert(file.unit_id(Some(hunk)), (file_index, Some(hunk)));
                    }
                }
                None => {
                    map.insert(file.unit_id(None), (file_index, None));
                }
            }
        }
        map
    }
}

/// Reads the units. Refuses untrusted repositories, conflicts, running operations, a detached
/// HEAD and an unborn branch.
pub(crate) async fn read(core: &Core, repo_id: &str) -> CoreResult<ComposeRead> {
    if !core.repo_row(repo_id)?.trusted {
        return Err(CoreError::repo_untrusted());
    }
    let status = read_status(core, repo_id).await?;
    if !status.conflicted.is_empty() {
        return Err(CoreError::new(ErrorCode::Conflict, "There are unresolved conflicts. Resolve them before composing commits."));
    }
    if let Some(op) = &status.operation {
        return Err(operation_error(op.kind, "compose commits"));
    }
    let (branch, head) = match &status.head {
        Head::Branch { branch, sha } => (branch.clone(), sha.clone()),
        Head::Detached { .. } => return Err(CoreError::not_allowed("Commits can only be composed on a branch. Check out a branch first.")),
        Head::Unborn { .. } => {
            return Err(CoreError::not_allowed("Composing needs a first commit on this branch. Create it with a normal commit first."))
        }
    };
    let worktree_tree = undo::worktree_tree(core, repo_id, None).await?;
    let index_tree = index_tree_of_copy(core, repo_id).await?;
    let token = token_of(TOKEN_TAG, format!("{head}\0{index_tree}\0{worktree_tree}").as_bytes());
    let signing = signing_on(core, repo_id).await?;
    let files = changed_files(core, repo_id, &head, &worktree_tree).await?;
    Ok(ComposeRead { head, branch, worktree_tree, token, signing, files })
}

/// Tree of the real index, written from a copy: `write-tree` on the real index would store its
/// cache tree there and wake the file watcher.
pub(crate) async fn index_tree_of_copy(core: &Core, repo_id: &str) -> CoreResult<String> {
    let real = status::git_dir(core, repo_id).await?.join("index");
    let temp = TempIndex::create(core)?;
    if real.is_file() {
        util::copy_index_file(&real, temp.path())?;
    }
    core.git_for(repo_id)?.env("GIT_INDEX_FILE", temp.path()).arg("write-tree").no_log().run_text().await
}

async fn signing_on(core: &Core, repo_id: &str) -> CoreResult<bool> {
    let out = core.git_for(repo_id)?.args(["config", "--bool", "--get", "commit.gpgsign"]).read_only().no_log().run_raw().await?;
    Ok(out.success() && out.stdout_text() == "true")
}

/// Reads carry file contents: no log entry, never blocking a writer, paths taken literally.
fn read_git(core: &Core, repo_id: &str) -> CoreResult<GitCmd> {
    Ok(core.git_for(repo_id)?.read_only().no_log().env("GIT_LITERAL_PATHSPECS", "1"))
}

async fn changed_files(core: &Core, repo_id: &str, head: &str, tree: &str) -> CoreResult<Vec<ChangedFile>> {
    let raw = read_git(core, repo_id)?.args(DIFF_COMMAND).args(["--raw", "-z", "--no-abbrev", "-M", head, tree]).run().await?;
    let entries = parse_raw_z(&raw.stdout);
    if entries.is_empty() {
        return Ok(Vec::new());
    }
    let numstat = read_git(core, repo_id)?.args(DIFF_COMMAND).args(["--numstat", "-z", "-M", head, tree]).run().await?;
    let counts = status::parse_numstat_z(&numstat.stdout);
    let root = core.repo_path(repo_id)?;
    let paths: Vec<&[u8]> = entries.iter().map(|entry| entry.path.as_slice()).collect();
    let lfs = status::lfs_paths(core, &root, repo_id, &paths).await?;

    let mut files = Vec::with_capacity(entries.len());
    let mut split = 0usize;
    for entry in entries {
        let line_counts = counts.get(&entry.path);
        let binary = line_counts.is_some_and(|c| c.binary);
        let (added, removed) = line_counts.map_or((0, 0), |c| (c.added.unwrap_or(0), c.removed.unwrap_or(0)));
        let mut kind = kind_of(&entry, binary, lfs.contains(&entry.path));
        let mut patch = None;
        let mut raw_patch = Vec::new();
        if matches!(kind, ComposeUnitKind::Hunk | ComposeUnitKind::Added) && split < MAX_SPLIT_FILES {
            raw_patch = file_patch(core, repo_id, head, tree, &entry.path).await?;
            patch = patch::parse_diff(&raw_patch).into_iter().next().filter(|parsed| !parsed.binary);
            split += 1;
        }
        if kind == ComposeUnitKind::Hunk && !patch.as_ref().is_some_and(|parsed: &FilePatch| !parsed.hunks.is_empty()) {
            kind = ComposeUnitKind::File;
        }
        let token = if raw_patch.is_empty() { token_of(TOKEN_TAG, &raw_record(&entry)) } else { token_of(TOKEN_TAG, &raw_patch) };
        files.push(ChangedFile {
            path: util::decode_lossy(&entry.path),
            old_path: entry.old_path.as_deref().map(util::decode_lossy),
            kind,
            patch,
            token,
            added,
            removed,
            entry,
        });
    }
    Ok(files)
}

fn kind_of(entry: &RawEntry, binary: bool, lfs: bool) -> ComposeUnitKind {
    let either = |mode: &str| entry.old_mode == mode || entry.new_mode == mode;
    if either(GITLINK_MODE) {
        return ComposeUnitKind::Submodule;
    }
    if either(SYMLINK_MODE) {
        return ComposeUnitKind::Link;
    }
    if lfs {
        return ComposeUnitKind::Lfs;
    }
    match entry.status {
        b'R' => ComposeUnitKind::Renamed,
        b'D' => ComposeUnitKind::Deleted,
        b'A' if binary => ComposeUnitKind::Binary,
        b'A' => ComposeUnitKind::Added,
        b'T' => ComposeUnitKind::Mode,
        _ if entry.old_mode != entry.new_mode => ComposeUnitKind::Mode,
        _ if binary => ComposeUnitKind::Binary,
        _ => ComposeUnitKind::Hunk,
    }
}

async fn file_patch(core: &Core, repo_id: &str, head: &str, tree: &str, path: &[u8]) -> CoreResult<Vec<u8>> {
    let out = read_git(core, repo_id)?.args(DIFF_COMMAND).args(["-U3", "--no-renames", head, tree, "--"]).arg_bytes(path).run().await?;
    Ok(only_this_file(out.stdout, path, None))
}

/// The raw line of a file without a patch (modes, blob IDs, status, paths) – for its token.
fn raw_record(entry: &RawEntry) -> Vec<u8> {
    let mut out = format!("{} {} {} {} {}", entry.old_mode, entry.new_mode, entry.old_id, entry.new_id, entry.status as char).into_bytes();
    out.push(0);
    out.extend_from_slice(&entry.path);
    if let Some(old) = &entry.old_path {
        out.push(0);
        out.extend_from_slice(old);
    }
    out
}

/// `@@ -a,b +c,d @@ section` exactly as `git diff` prints it (a count of 1 is left out).
pub(crate) fn hunk_header(hunk: &PatchHunk) -> String {
    let range = |start: u32, count: u32| if count == 1 { start.to_string() } else { format!("{start},{count}") };
    let head = format!("@@ -{} +{} @@", range(hunk.old_start, hunk.old_lines), range(hunk.new_start, hunk.new_lines));
    let section = util::decode_lossy(&hunk.section);
    let section = section.trim_end();
    if section.is_empty() {
        head
    } else {
        format!("{head} {section}")
    }
}

fn hunk_counts(hunk: &PatchHunk) -> (u32, u32) {
    let count = |kind: LineKind| hunk.lines.iter().filter(|line| line.kind == kind).count() as u32;
    (count(LineKind::Add), count(LineKind::Remove))
}

/// The lines for display with their numbers; `true` = cut at `MAX_UNIT_LINES`.
fn display_lines(hunks: &[&PatchHunk]) -> (Vec<DiffLine>, bool) {
    let mut lines = Vec::new();
    for hunk in hunks {
        let (mut old_no, mut new_no) = (hunk.old_start, hunk.new_start);
        for line in &hunk.lines {
            if lines.len() == MAX_UNIT_LINES {
                return (lines, true);
            }
            let text = util::decode_lossy(line.content.strip_suffix(b"\r").unwrap_or(&line.content));
            let (kind, old, new) = match line.kind {
                LineKind::Context => (DiffLineKind::Context, Some(old_no), Some(new_no)),
                LineKind::Remove => (DiffLineKind::Remove, Some(old_no), None),
                LineKind::Add => (DiffLineKind::Add, None, Some(new_no)),
            };
            if old.is_some() {
                old_no += 1;
            }
            if new.is_some() {
                new_no += 1;
            }
            lines.push(DiffLine { kind, old_no: old, new_no: new, text, no_newline: line.no_newline });
        }
    }
    (lines, false)
}

fn unit(file: &ChangedFile, hunk: Option<(usize, &PatchHunk)>) -> ComposeUnit {
    let (id, hunk_index, header, (added, removed), hunks) = match hunk {
        Some((index, hunk)) => (file.unit_id(Some(index)), Some(index as u32), hunk_header(hunk), hunk_counts(hunk), vec![hunk]),
        None => (
            file.unit_id(None),
            None,
            String::new(),
            (file.added, file.removed),
            file.patch.as_ref().map(|patch| patch.hunks.iter().collect()).unwrap_or_default(),
        ),
    };
    let (lines, lines_cut) = display_lines(&hunks);
    ComposeUnit { id, path: file.path.clone(), old_path: file.old_path.clone(), kind: file.kind, hunk_index, header, added, removed, lines, lines_cut }
}

fn file_units(file: &ChangedFile) -> Vec<ComposeUnit> {
    match (file.hunk_count(), &file.patch) {
        (Some(_), Some(patch)) => patch.hunks.iter().enumerate().map(|(index, hunk)| unit(file, Some((index, hunk)))).collect(),
        _ => vec![unit(file, None)],
    }
}
