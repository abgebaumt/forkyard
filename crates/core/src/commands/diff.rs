//! Diff of a single file.
//!
//! `diff_file` is a pure read command: no lock, no event, no log entry.
//! Steps: first work out what is compared (`resolve` → `Target`), then look at the sizes and
//! contents of both sides (LFS pointer, image, binary, too large) and finally parse the
//! output of `git diff` itself (`patch::parse_diff`).
//!
//! For staging individual lines, `patch_basis` returns the same diff again in raw form,
//! together with the token the UI sends back as `expect`.

use std::path::{Path, PathBuf};

use base64::Engine;

use crate::app::Core;
use crate::commands::status;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::GitCmd;
use crate::model::{DiffLine, DiffLineKind, DiffSource, FileDiff, FileStatus, Hunk, TextDiff};
use crate::util;

pub mod patch;
#[cfg(test)]
mod tests;

use patch::{FilePatch, LineKind, PatchHunk};

/// Without `force`, text diffs are only loaded up to this size per side; full
/// versions (`oldText`/`newText`) are only available up to this size, even with `force`.
pub const MAX_TEXT_BYTES: u64 = 1024 * 1024;
/// Without `force`, at most this many lines per side.
pub const MAX_TEXT_LINES: u64 = 20_000;
/// Images up to this size per side are returned as a data: URL, larger ones as binary.
pub const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
/// Nothing larger is loaded into memory, even with `force`.
pub const MAX_FORCED_BYTES: u64 = 64 * 1024 * 1024;

const STALE_TEMP_AGE: std::time::Duration = std::time::Duration::from_secs(3600);
const LFS_POINTER_MAX_BYTES: usize = 1024;
const LFS_POINTER_PREFIX: &[u8] = b"version https://git-lfs.github.com/spec/v1";
/// The empty tree. Git always knows it, even when no object for it is stored; as the
/// `from` of a range it stands for "from the empty state on" (e.g. a series starting at the root commit).
pub(crate) const EMPTY_TREE_SHA1: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
pub(crate) const EMPTY_TREE_SHA256: &str = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";

/// Whether `rev` is the (fully spelled out) SHA of the empty tree.
pub(crate) fn is_empty_tree(rev: &str) -> bool {
    let rev = rev.trim();
    rev.eq_ignore_ascii_case(EMPTY_TREE_SHA1) || rev.eq_ignore_ascii_case(EMPTY_TREE_SHA256)
}
const ABSENT_MODE: &str = "000000";
const GITLINK_MODE: &str = "160000";

/// Fixed options for every `git diff`, so the user's settings (prefixes,
/// external diff, textconv, colours) do not change the output. Without
/// `diff.autoRefreshIndex=false` a reading diff would write the index back.
const DIFF_COMMAND: [&str; 12] = [
    "-c",
    "diff.autoRefreshIndex=false",
    "-c",
    "diff.suppressBlankEmpty=false",
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--submodule=short",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--full-index",
];

/// Diff of one file; detects binary, image, LFS and very large files. `encoding` sets the
/// encoding of both sides for this one call (otherwise it is guessed per side);
/// unknown name → `not_allowed`.
#[allow(clippy::too_many_arguments)]
pub async fn diff_file(
    core: &Core,
    repo_id: String,
    path: String,
    source: DiffSource,
    force: Option<bool>,
    ignore_whitespace: Option<bool>,
    encoding: Option<String>,
) -> CoreResult<FileDiff> {
    let forced = crate::commands::history::forced_encoding(encoding.as_deref())?;
    let ctx = Ctx::new(core, &repo_id)?;
    let target = resolve(&ctx, &path, &source).await?;
    build(&ctx, target, force.unwrap_or(false), ignore_whitespace.unwrap_or(false), forced).await
}

/// Encoding given by the caller (`None` = guess).
type Forced = Option<&'static encoding_rs::Encoding>;

// ---------------------------------------------------------------------------
// Basics
// ---------------------------------------------------------------------------

struct Ctx<'a> {
    core: &'a Core,
    repo_id: &'a str,
    root: PathBuf,
}

impl<'a> Ctx<'a> {
    fn new(core: &'a Core, repo_id: &'a str) -> CoreResult<Self> {
        Ok(Ctx { core, repo_id, root: core.repo_path(repo_id)? })
    }

    /// Read call: never blocks a write action, no log entry, paths taken literally
    /// (no wildcards such as `*` or `[a]`).
    fn git(&self) -> GitCmd {
        self.core.git.cmd(&self.root).repo(self.repo_id).read_only().no_log().env("GIT_LITERAL_PATHSPECS", "1")
    }

    fn worktree_path(&self, path: &[u8]) -> PathBuf {
        util::join_from_git(&self.root, path)
    }
}

/// Separate index file (for `GIT_INDEX_FILE`) that is removed again when the value is
/// dropped. The real index stays untouched. The file lives in the app's data directory,
/// not in the repository: that way a mere read command does not trigger the file
/// watcher.
pub(crate) struct TempIndex {
    path: PathBuf,
}

impl TempIndex {
    pub(crate) fn create(core: &Core) -> CoreResult<TempIndex> {
        let dir = core.data_dir().join("tmp");
        std::fs::create_dir_all(&dir)?;
        remove_stale_temp_files(&dir);
        Ok(TempIndex { path: dir.join(format!("index-{}", util::new_id())) })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let mut lock = self.path.clone().into_os_string();
        lock.push(".lock");
        let _ = std::fs::remove_file(lock);
    }
}

/// Removes index files left behind by a crash (older than one hour).
fn remove_stale_temp_files(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let old = entry.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).is_some_and(|age| age > STALE_TEMP_AGE);
        if old && entry.file_name().to_string_lossy().starts_with("index-") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// The two sides of a comparison.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Endpoints {
    /// Index ↔ working directory.
    IndexWorktree,
    /// HEAD ↔ index (without a commit: empty tree ↔ index).
    HeadIndex,
    /// Commit ↔ working directory.
    TreeWorktree(String),
    /// Two commits or trees.
    Trees(String, String),
}

impl Endpoints {
    fn args(&self) -> Vec<&str> {
        match self {
            Endpoints::IndexWorktree => vec![],
            Endpoints::HeadIndex => vec!["--cached"],
            Endpoints::TreeWorktree(from) => vec![from],
            Endpoints::Trees(from, to) => vec![from, to],
        }
    }

    fn new_side_is_worktree(&self) -> bool {
        matches!(self, Endpoints::IndexWorktree | Endpoints::TreeWorktree(_))
    }
}

fn diff_cmd(ctx: &Ctx<'_>, endpoints: &Endpoints, index_file: Option<&Path>, options: &[&str], paths: &[&[u8]]) -> GitCmd {
    let mut cmd = ctx.git().args(DIFF_COMMAND).args(options).args(endpoints.args()).arg("--");
    for path in paths {
        cmd = cmd.arg_bytes(path);
    }
    if let Some(index) = index_file {
        cmd = cmd.env("GIT_INDEX_FILE", index);
    }
    cmd
}

/// One entry from `git diff --raw -z`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct RawEntry {
    old_mode: String,
    new_mode: String,
    old_id: String,
    new_id: String,
    /// A, D, M, R, T, U …
    status: u8,
    path: Vec<u8>,
    old_path: Option<Vec<u8>>,
}

/// `:<mode> <mode> <id> <id> <status>NUL<path>NUL[<target path>NUL]`
fn parse_raw_z(stdout: &[u8]) -> Vec<RawEntry> {
    let mut out = Vec::new();
    let mut records = util::split_z(stdout);
    while let Some(record) = records.next() {
        let Some(meta) = record.strip_prefix(b":") else { continue };
        let meta = util::decode_lossy(meta);
        let mut fields = meta.split(' ');
        let (Some(old_mode), Some(new_mode), Some(old_id), Some(new_id), Some(state)) = (fields.next(), fields.next(), fields.next(), fields.next(), fields.next()) else {
            continue;
        };
        let status = state.bytes().next().unwrap_or(b'M');
        let Some(first) = records.next() else { break };
        let (path, old_path) = if matches!(status, b'R' | b'C') {
            match records.next() {
                Some(dest) => (dest.to_vec(), Some(first.to_vec())),
                None => break,
            }
        } else {
            (first.to_vec(), None)
        };
        out.push(RawEntry { old_mode: old_mode.into(), new_mode: new_mode.into(), old_id: old_id.into(), new_id: new_id.into(), status, path, old_path });
    }
    out
}

async fn raw(ctx: &Ctx<'_>, endpoints: &Endpoints, index_file: Option<&Path>, options: &[&str], path: Option<&[u8]>) -> CoreResult<Vec<RawEntry>> {
    let mut all = vec!["--raw", "-z", "--no-abbrev"];
    all.extend_from_slice(options);
    let paths: Vec<&[u8]> = path.into_iter().collect();
    let out = diff_cmd(ctx, endpoints, index_file, &all, &paths).run().await?;
    Ok(parse_raw_z(&out.stdout))
}

fn status_of(letter: u8) -> FileStatus {
    match letter {
        b'A' | b'C' => FileStatus::Added,
        b'D' => FileStatus::Deleted,
        b'R' => FileStatus::Renamed,
        b'U' => FileStatus::Conflicted,
        _ => FileStatus::Modified,
    }
}

fn missing(path: &[u8]) -> CoreError {
    CoreError::not_found(format!("The file “{}” isn't part of this comparison.", util::decode_lossy(path)))
}

// ---------------------------------------------------------------------------
// What is being compared?
// ---------------------------------------------------------------------------

/// The resolved comparison of one file.
struct Target {
    endpoints: Endpoints,
    /// The file is a detected rename: diff with `-M` over both paths.
    renames: bool,
    /// Conflicted file: comparison against "our" version (`--ours`).
    ours: bool,
    /// Untracked file: separate index in which it is marked as "to be added".
    temp_index: Option<TempIndex>,
    /// `None`: the file is unchanged.
    entry: Option<RawEntry>,
    status: FileStatus,
    path: Vec<u8>,
    /// "unstaged" or "staged" – a token exists only for these.
    tag: Option<&'static str>,
}

impl Target {
    fn index_file(&self) -> Option<&Path> {
        self.temp_index.as_ref().map(TempIndex::path)
    }

    fn has_gitlink(&self) -> bool {
        self.entry.as_ref().is_some_and(|e| e.old_mode == GITLINK_MODE || e.new_mode == GITLINK_MODE)
    }
}

async fn resolve(ctx: &Ctx<'_>, path: &str, source: &DiffSource) -> CoreResult<Target> {
    if path.is_empty() {
        return Err(CoreError::not_found("No file was specified."));
    }
    let path = path.as_bytes().to_vec();
    match source {
        DiffSource::Unstaged => resolve_against_worktree(ctx, path, Endpoints::IndexWorktree, Some("unstaged")).await,
        DiffSource::Staged => resolve_stored(ctx, path, Endpoints::HeadIndex, Some("staged")).await,
        DiffSource::Commit { sha } => {
            check_rev(sha)?;
            let (commit, parents) = commit_parents(ctx, sha).await.map_err(|e| unknown_commit(sha, e))?;
            let from = parents.into_iter().next().unwrap_or_else(|| empty_tree(&commit).to_string());
            resolve_stored(ctx, path, Endpoints::Trees(from, commit), None).await
        }
        DiffSource::Range { from, to: Some(to) } => {
            check_rev(from)?;
            check_rev(to)?;
            resolve_stored(ctx, path, Endpoints::Trees(from.clone(), to.clone()), None).await
        }
        DiffSource::Range { from, to: None } => {
            check_rev(from)?;
            resolve_against_worktree(ctx, path, Endpoints::TreeWorktree(from.clone()), None).await
        }
        DiffSource::Stash { index } => {
            let not_found = |e: CoreError| {
                let mut err = CoreError::not_found(format!("There is no stash number {index}."));
                err.git_output = e.git_output;
                err
            };
            let (stash, parents) = commit_parents(ctx, &format!("stash@{{{index}}}")).await.map_err(not_found)?;
            let base = parents.first().cloned().unwrap_or_else(|| empty_tree(&stash).to_string());
            let tracked = resolve_stored(ctx, path.clone(), Endpoints::Trees(base, stash.clone()), None).await;
            // Untracked files of a stash live in a separate third parent.
            match (tracked, parents.get(2)) {
                (Err(e), Some(untracked)) if e.is(ErrorCode::NotFound) => {
                    resolve_stored(ctx, path, Endpoints::Trees(empty_tree(&stash).to_string(), untracked.clone()), None).await
                }
                (other, _) => other,
            }
        }
    }
}

/// Only SHAs (abbreviated too) – nothing Git could read as an option or expression.
fn check_rev(rev: &str) -> CoreResult<()> {
    if (4..=64).contains(&rev.len()) && rev.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(CoreError::not_found(format!("The commit “{rev}” wasn't found.")))
    }
}

fn unknown_commit(rev: &str, cause: CoreError) -> CoreError {
    let mut err = CoreError::not_found(format!("The commit “{rev}” wasn't found."));
    err.git_output = cause.git_output;
    err
}

/// The empty tree in the object format of `sha` (SHA-1 or SHA-256).
pub(crate) fn empty_tree(sha: &str) -> &'static str {
    if sha.len() > 40 {
        EMPTY_TREE_SHA256
    } else {
        EMPTY_TREE_SHA1
    }
}

/// Full SHA of a commit and its parents.
async fn commit_parents(ctx: &Ctx<'_>, rev: &str) -> CoreResult<(String, Vec<String>)> {
    let out = ctx.git().args(["rev-list", "--parents", "-n", "1", rev, "--"]).run().await?;
    let text = out.stdout_text();
    let mut ids = text.split_whitespace().map(str::to_string);
    let commit = ids.next().ok_or_else(|| CoreError::not_found("The commit wasn't found."))?;
    Ok((commit, ids.collect()))
}

async fn in_index(ctx: &Ctx<'_>, path: &[u8]) -> CoreResult<bool> {
    let out = ctx.git().args(["ls-files", "--stage", "-z", "--"]).arg_bytes(path).run().await?;
    Ok(!out.stdout.is_empty())
}

async fn in_tree(ctx: &Ctx<'_>, tree: &str, path: &[u8]) -> CoreResult<bool> {
    let out = ctx.git().args(["ls-tree", "-z", tree, "--"]).arg_bytes(path).run().await?;
    Ok(!out.stdout.is_empty())
}

/// Looks for `path` as the target of a rename. That needs the whole comparison (without a
/// pathspec), so it is only done for files that look "new" at first sight.
async fn find_rename(ctx: &Ctx<'_>, endpoints: &Endpoints, path: &[u8]) -> CoreResult<Option<RawEntry>> {
    let entries = raw(ctx, endpoints, None, &["-M", "--diff-filter=R"], None).await?;
    Ok(entries.into_iter().find(|e| e.status == b'R' && e.path == path))
}

/// Comparisons whose new side lives in Git (index or commit).
async fn resolve_stored(ctx: &Ctx<'_>, path: Vec<u8>, endpoints: Endpoints, tag: Option<&'static str>) -> CoreResult<Target> {
    let entries = raw(ctx, &endpoints, None, &["--no-renames"], Some(&path)).await?;
    let conflicted = entries.iter().any(|e| e.status == b'U');
    let mut entry = entries.into_iter().find(|e| e.status != b'U' && e.path == path);
    let mut target = Target { endpoints, renames: false, ours: false, temp_index: None, entry: None, status: FileStatus::Modified, path, tag };
    if conflicted {
        target.status = FileStatus::Conflicted;
        return Ok(target);
    }
    if entry.as_ref().is_some_and(|e| e.status == b'A') {
        if let Some(renamed) = find_rename(ctx, &target.endpoints, &target.path).await? {
            entry = Some(renamed);
            target.renames = true;
        }
    }
    match entry {
        Some(entry) => {
            target.status = status_of(entry.status);
            target.entry = Some(entry);
        }
        None => {
            let exists = match &target.endpoints {
                Endpoints::Trees(_, to) => in_tree(ctx, to, &target.path).await?,
                _ => in_index(ctx, &target.path).await?,
            };
            if !exists {
                return Err(missing(&target.path));
            }
        }
    }
    Ok(target)
}

/// Comparisons whose new side is the working directory.
async fn resolve_against_worktree(ctx: &Ctx<'_>, path: Vec<u8>, endpoints: Endpoints, tag: Option<&'static str>) -> CoreResult<Target> {
    let against_index = endpoints == Endpoints::IndexWorktree;
    let entries = raw(ctx, &endpoints, None, &["--no-renames"], Some(&path)).await?;
    let conflicted = entries.iter().any(|e| e.status == b'U');
    let mut entry = entries.into_iter().find(|e| e.status != b'U' && e.path == path);
    let mut target = Target { endpoints, renames: false, ours: false, temp_index: None, entry: None, status: FileStatus::Modified, path, tag };
    if conflicted {
        target.status = FileStatus::Conflicted;
        target.ours = against_index;
        target.entry = entry;
        return Ok(target);
    }
    // Between index and working directory there are no renames: the new file is
    // untracked there. Against a commit there are.
    if !against_index && entry.as_ref().is_some_and(|e| e.status == b'A') {
        if let Some(renamed) = find_rename(ctx, &target.endpoints, &target.path).await? {
            entry = Some(renamed);
            target.renames = true;
        }
    }
    match entry {
        Some(entry) => {
            target.status = status_of(entry.status);
            target.entry = Some(entry);
            Ok(target)
        }
        // Tracked and unchanged.
        None if in_index(ctx, &target.path).await? => Ok(target),
        None => untracked_target(ctx, target.path, tag.filter(|_| against_index)).await,
    }
}

/// Untracked file: everything is added. So that Git applies the filters (line endings, LFS)
/// exactly as with `git add`, the file is marked as "to be added" (`git add -N`) in a
/// separate index; the diff, on the other hand, is that of a new file.
async fn untracked_target(ctx: &Ctx<'_>, path: Vec<u8>, tag: Option<&'static str>) -> CoreResult<Target> {
    let meta = std::fs::symlink_metadata(ctx.worktree_path(&path)).map_err(|_| missing(&path))?;
    if meta.is_dir() {
        return Err(CoreError::unsupported(format!("“{}” is a folder; diffs are only available for files.", util::decode_lossy(&path))));
    }
    let temp = TempIndex::create(ctx.core)?;
    ctx.git().env("GIT_INDEX_FILE", temp.path()).args(["add", "-N", "-f", "--"]).arg_bytes(&path).run().await?;
    let entries = raw(ctx, &Endpoints::IndexWorktree, Some(temp.path()), &["--no-renames"], Some(&path)).await?;
    let entry = entries.into_iter().find(|e| e.path == path).ok_or_else(|| missing(&path))?;
    Ok(Target { endpoints: Endpoints::IndexWorktree, renames: false, ours: false, temp_index: Some(temp), entry: Some(entry), status: FileStatus::Untracked, path, tag })
}

// ---------------------------------------------------------------------------
// Git calls for the resolved comparison
// ---------------------------------------------------------------------------

fn target_cmd(ctx: &Ctx<'_>, target: &Target, extra: &[&str]) -> GitCmd {
    let mut options = vec![if target.renames { "-M" } else { "--no-renames" }];
    if target.ours {
        options.push("--ours");
    }
    options.extend_from_slice(extra);
    let mut paths: Vec<&[u8]> = vec![target.path.as_slice()];
    if let Some(old) = target.entry.as_ref().and_then(|e| e.old_path.as_deref()) {
        paths.push(old);
    }
    diff_cmd(ctx, &target.endpoints, target.index_file(), &options, &paths)
}

/// The raw output of `git diff -U3` for the file. The token is computed over exactly these bytes.
async fn run_patch(ctx: &Ctx<'_>, target: &Target, ignore_whitespace: bool) -> CoreResult<Vec<u8>> {
    let extra: &[&str] = if ignore_whitespace { &["-U3", "-w"] } else { &["-U3"] };
    let patch = target_cmd(ctx, target, extra).run().await?.stdout;
    let old_path = target.entry.as_ref().and_then(|entry| entry.old_path.as_deref());
    Ok(only_this_file(patch, &target.path, old_path))
}

/// As a pathspec, the path of a file also matches everything below a FOLDER of the same name. If
/// the file `ding` became a folder `ding/` (or vice versa), `git diff -- ding` therefore also returns
/// the sections of the files inside it – the diff of the one file showed foreign lines.
/// What remains is the section with exactly this path; if there is none (Git puts paths with
/// special characters in quotes), the output stays as it is.
fn only_this_file(patch: Vec<u8>, path: &[u8], old_path: Option<&[u8]>) -> Vec<u8> {
    let mut starts: Vec<usize> = Vec::new();
    let mut at = 0;
    while at < patch.len() {
        if patch[at..].starts_with(b"diff --git ") {
            starts.push(at);
        }
        match patch[at..].iter().position(|byte| *byte == b'\n') {
            Some(end) => at += end + 1,
            None => break,
        }
    }
    if starts.len() <= 1 {
        return patch;
    }
    let header = [b"diff --git a/".as_slice(), old_path.unwrap_or(path), b" b/", path].concat();
    let mut kept: Vec<u8> = Vec::new();
    for (index, start) in starts.iter().enumerate() {
        let end = starts.get(index + 1).copied().unwrap_or(patch.len());
        let section = &patch[*start..end];
        let line_end = section.iter().position(|byte| *byte == b'\n').unwrap_or(section.len());
        let line = section[..line_end].strip_suffix(b"\r").unwrap_or(&section[..line_end]);
        if line == header.as_slice() {
            kept.extend_from_slice(section);
        }
    }
    if kept.is_empty() {
        patch
    } else {
        kept
    }
}

/// Does Git consider the file binary? (`--numstat` then reports `-` instead of numbers.)
async fn binary_by_numstat(ctx: &Ctx<'_>, target: &Target) -> CoreResult<bool> {
    let out = target_cmd(ctx, target, &["--numstat", "-z"]).run().await?;
    Ok(status::parse_numstat_z(&out.stdout).values().any(|counts| counts.binary))
}

/// Fingerprint (FNV-1a, 128 bit) over the kind of diff and its raw output. With
/// `--full-index` it contains the blob IDs of both sides (for the working directory the
/// hash of the content), plus every line of the hunks: if the file changes in the index
/// or in the working directory, the token changes.
fn token_of(tag: &str, patch: &[u8]) -> String {
    const OFFSET: u128 = 0x6c62272e07bb014262b821756295c58d;
    const PRIME: u128 = 0x0000000001000000000000000000013b;
    let mut hash = OFFSET;
    for &byte in tag.as_bytes().iter().chain(&[0u8]).chain(patch) {
        hash ^= u128::from(byte);
        hash = hash.wrapping_mul(PRIME);
    }
    format!("{hash:032x}")
}

// ---------------------------------------------------------------------------
// The two sides: sizes and contents
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
enum Side {
    Absent,
    Blob(String),
    Worktree,
}

fn side_of(mode: &str, id: &str, worktree: bool) -> Side {
    if mode == ABSENT_MODE {
        Side::Absent
    } else if worktree {
        Side::Worktree
    } else {
        Side::Blob(id.to_string())
    }
}

async fn worktree_size(full: &Path) -> Option<u64> {
    let meta = tokio::fs::symlink_metadata(full).await.ok()?;
    (!meta.is_dir()).then_some(meta.len())
}

async fn worktree_bytes(full: &Path) -> Option<Vec<u8>> {
    let meta = tokio::fs::symlink_metadata(full).await.ok()?;
    if meta.file_type().is_symlink() {
        // For symbolic links Git stores the target as the content.
        return tokio::fs::read_link(full).await.ok().map(|link| util::path_to_bytes(&link));
    }
    if !meta.is_file() {
        return None;
    }
    tokio::fs::read(full).await.ok()
}

/// Sizes of the blobs via a single `git cat-file --batch-check`.
async fn blob_sizes(ctx: &Ctx<'_>, ids: &[&str]) -> CoreResult<Vec<Option<u64>>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let stdin = ids.iter().map(|id| format!("{id}\n")).collect::<String>();
    let out = ctx.git().args(["cat-file", "--batch-check=%(objecttype) %(objectsize)"]).stdin(stdin).run().await?;
    let mut sizes: Vec<Option<u64>> = out
        .stdout_lines()
        .into_iter()
        .map(|line| {
            let text = util::decode_lossy(line);
            text.strip_prefix("blob ").and_then(|size| size.trim().parse().ok())
        })
        .collect();
    sizes.resize(ids.len(), None);
    Ok(sizes)
}

/// Contents of the blobs via a single `git cat-file --batch`.
async fn blob_contents(ctx: &Ctx<'_>, ids: &[&str]) -> CoreResult<Vec<Option<Vec<u8>>>> {
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let stdin = ids.iter().map(|id| format!("{id}\n")).collect::<String>();
    let out = ctx.git().args(["cat-file", "--batch"]).stdin(stdin).run().await?;
    let mut rest: &[u8] = &out.stdout;
    let mut contents = Vec::with_capacity(ids.len());
    for _ in ids {
        // Header: `<id> <type> <size>` or `<id> missing`, then the content and a newline.
        let Some(end) = rest.iter().position(|&b| b == b'\n') else { break };
        let header = util::decode_lossy(&rest[..end]);
        rest = &rest[end + 1..];
        let size = header.rsplit(' ').next().and_then(|s| s.parse::<usize>().ok());
        match size {
            Some(size) if rest.len() >= size => {
                contents.push(Some(rest[..size].to_vec()));
                rest = rest.get(size + 1..).unwrap_or_default();
            }
            _ => contents.push(None),
        }
    }
    contents.resize(ids.len(), None);
    Ok(contents)
}

async fn side_sizes(ctx: &Ctx<'_>, old: &Side, new: &Side, path: &[u8]) -> CoreResult<(Option<u64>, Option<u64>)> {
    let ids: Vec<&str> = [old, new].into_iter().filter_map(|s| if let Side::Blob(id) = s { Some(id.as_str()) } else { None }).collect();
    let mut sizes = blob_sizes(ctx, &ids).await?.into_iter();
    let mut size = Vec::with_capacity(2);
    for side in [old, new] {
        size.push(match side {
            Side::Absent => None,
            Side::Blob(_) => sizes.next().flatten(),
            Side::Worktree => worktree_size(&ctx.worktree_path(path)).await,
        });
    }
    Ok((size[0], size[1]))
}

async fn side_contents(ctx: &Ctx<'_>, old: &Side, new: &Side, path: &[u8]) -> CoreResult<(Option<Vec<u8>>, Option<Vec<u8>>)> {
    let ids: Vec<&str> = [old, new].into_iter().filter_map(|s| if let Side::Blob(id) = s { Some(id.as_str()) } else { None }).collect();
    let mut blobs = blob_contents(ctx, &ids).await?.into_iter();
    let mut content = Vec::with_capacity(2);
    for side in [old, new] {
        content.push(match side {
            Side::Absent => None,
            Side::Blob(_) => blobs.next().flatten(),
            Side::Worktree => worktree_bytes(&ctx.worktree_path(path)).await,
        });
    }
    let new_content = content.pop().flatten();
    let old_content = content.pop().flatten();
    Ok((old_content, new_content))
}

/// The two versions of a file in a comparison – for external diff tools.
pub(crate) struct FileSides {
    /// `None`: the side does not exist (new or deleted file).
    pub old: Option<Vec<u8>>,
    pub new: Option<Vec<u8>>,
    /// The new side is the file in the working directory.
    pub new_is_worktree: bool,
    /// Old path for a rename.
    pub old_path: Option<String>,
}

/// Contents of both sides of `path` in the comparison `source`. Unchanged files → `not_found`,
/// conflicted files and submodules → `not_allowed`, more than `MAX_FORCED_BYTES` → `not_allowed`.
pub(crate) async fn file_sides(core: &Core, repo_id: &str, path: &str, source: &DiffSource) -> CoreResult<FileSides> {
    let ctx = Ctx::new(core, repo_id)?;
    let target = resolve(&ctx, path, source).await?;
    if target.status == FileStatus::Conflicted {
        return Err(CoreError::not_allowed(format!("“{path}” has a conflict. Use the merge tool for that.")));
    }
    if target.has_gitlink() {
        return Err(CoreError::not_allowed(format!("“{path}” is a submodule; there's no file comparison for it.")));
    }
    let Some(entry) = target.entry.as_ref() else {
        return Err(CoreError::not_found(format!("“{path}” is unchanged in this comparison; there's nothing to compare.")));
    };
    let new_is_worktree = target.endpoints.new_side_is_worktree();
    let old = side_of(&entry.old_mode, &entry.old_id, false);
    let new = side_of(&entry.new_mode, &entry.new_id, new_is_worktree);
    let (old_size, new_size) = side_sizes(&ctx, &old, &new, &target.path).await?;
    if old_size.unwrap_or(0).max(new_size.unwrap_or(0)) > MAX_FORCED_BYTES {
        return Err(CoreError::not_allowed(format!("“{path}” is too large for the external diff tool.")));
    }
    let (old, new) = side_contents(&ctx, &old, &new, &target.path).await?;
    Ok(FileSides { old, new, new_is_worktree, old_path: entry.old_path.as_deref().map(util::decode_lossy) })
}

// ---------------------------------------------------------------------------
// Detection: LFS, image, binary, too large
// ---------------------------------------------------------------------------

/// `oid` (without `sha256:`) and size from an LFS pointer.
fn parse_lfs_pointer(bytes: &[u8]) -> Option<(String, u64)> {
    if bytes.len() > LFS_POINTER_MAX_BYTES || !bytes.starts_with(LFS_POINTER_PREFIX) {
        return None;
    }
    let text = std::str::from_utf8(bytes).ok()?;
    let (mut oid, mut size) = (None, None);
    for line in text.lines() {
        if let Some(value) = line.strip_prefix("oid ") {
            let value = value.trim();
            oid = Some(value.split_once(':').map_or(value, |(_, hex)| hex).to_string());
        } else if let Some(value) = line.strip_prefix("size ") {
            size = value.trim().parse::<u64>().ok();
        }
    }
    Some((oid?, size?))
}

/// With an LFS filter set up, the working directory holds the real content; the
/// pointer is then only visible in the diff. A pointer has few lines and always fits
/// into one hunk.
fn lfs_pointer_in_patch(files: &[FilePatch], new_side: bool) -> Option<(String, u64)> {
    let [file] = files else { return None };
    let [hunk] = file.hunks.as_slice() else { return None };
    if hunk.lines.len() > 16 {
        return None;
    }
    let bytes = if new_side { FilePatch::new_side(hunk) } else { FilePatch::old_side(hunk) };
    parse_lfs_pointer(&bytes)
}

fn image_mime(path: &[u8]) -> Option<&'static str> {
    let name = util::decode_lossy(path).to_lowercase();
    let (_, extension) = name.rsplit_once('.')?;
    Some(match extension {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

fn data_url(mime: &str, bytes: &[u8]) -> String {
    format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes))
}

fn count_lines(bytes: &[u8]) -> u64 {
    let newlines = bytes.iter().filter(|&&b| b == b'\n').count() as u64;
    newlines + u64::from(bytes.last().is_some_and(|&b| b != b'\n'))
}

async fn build(ctx: &Ctx<'_>, target: Target, force: bool, ignore_whitespace: bool, forced: Forced) -> CoreResult<FileDiff> {
    let path = util::decode_lossy(&target.path);
    let status = target.status;
    let Some(entry) = target.entry.clone().filter(|_| status != FileStatus::Conflicted && !target.has_gitlink()) else {
        return plain_text(ctx, &target, ignore_whitespace, forced).await;
    };
    let old_path = entry.old_path.as_deref().map(util::decode_lossy);
    let old = side_of(&entry.old_mode, &entry.old_id, false);
    let new = side_of(&entry.new_mode, &entry.new_id, target.endpoints.new_side_is_worktree());

    let (old_size, new_size) = side_sizes(ctx, &old, &new, &target.path).await?;
    let largest = old_size.unwrap_or(0).max(new_size.unwrap_or(0));
    let mime = image_mime(&target.path);
    let limit = if mime.is_some() {
        MAX_IMAGE_BYTES
    } else if force {
        MAX_FORCED_BYTES
    } else {
        MAX_TEXT_BYTES
    };
    let binary = |path: String, old_path: Option<String>| FileDiff::Binary { path, old_path, status, old_size, new_size };
    if largest > limit {
        // Too large to load. Whether it is binary, Git tells us without the content coming here.
        if mime.is_some() || binary_by_numstat(ctx, &target).await? {
            return Ok(binary(path, old_path));
        }
        return Ok(FileDiff::TooLarge { path, old_path, status, bytes: largest, lines: None });
    }

    // Load contents; for text the diff is already running alongside.
    let ((old_bytes, new_bytes), mut raw_patch) = if mime.is_some() {
        (side_contents(ctx, &old, &new, &target.path).await?, None)
    } else {
        let (contents, patch) = tokio::join!(side_contents(ctx, &old, &new, &target.path), run_patch(ctx, &target, ignore_whitespace));
        (contents?, Some(patch?))
    };
    let mut old_pointer = old_bytes.as_deref().and_then(parse_lfs_pointer);
    let mut new_pointer = new_bytes.as_deref().and_then(parse_lfs_pointer);

    if let (Some(mime), None, None) = (mime, &old_pointer, &new_pointer) {
        let old_mime = old_path.as_deref().and_then(|p| image_mime(p.as_bytes())).unwrap_or(mime);
        return Ok(FileDiff::Image {
            path,
            old_path,
            status,
            old_data_url: old_bytes.as_deref().map(|b| data_url(old_mime, b)),
            new_data_url: new_bytes.as_deref().map(|b| data_url(mime, b)),
            old_size,
            new_size,
        });
    }
    let raw_patch = match raw_patch.take() {
        Some(patch) => patch,
        None => run_patch(ctx, &target, ignore_whitespace).await?,
    };
    let files = patch::parse_diff(&raw_patch);

    old_pointer = old_pointer.or_else(|| lfs_pointer_in_patch(&files, false));
    new_pointer = new_pointer.or_else(|| lfs_pointer_in_patch(&files, true));
    if old_pointer.is_some() || new_pointer.is_some() {
        return Ok(FileDiff::Lfs {
            path,
            old_path,
            status,
            old_size: old_pointer.as_ref().map(|p| p.1).or(old_size),
            new_size: new_pointer.as_ref().map(|p| p.1).or(new_size),
            old_oid: old_pointer.map(|p| p.0),
            new_oid: new_pointer.map(|p| p.0),
        });
    }

    // With `working-tree-encoding=UTF-16` the file in the working directory is UTF-16 (full of
    // NUL bytes), but Git compares the converted version and returns a text diff: then the
    // file is text, even if its raw bytes look binary.
    let git_made_text = !files.is_empty() && files.iter().all(|f| !f.binary && !f.hunks.is_empty());
    let looks_binary = |bytes: &Option<Vec<u8>>| {
        bytes.as_deref().is_some_and(|b| if git_made_text { crate::commands::history::is_binary_content(b) } else { util::looks_binary(b) })
    };
    if files.iter().any(|f| f.binary) || looks_binary(&old_bytes) || looks_binary(&new_bytes) {
        return Ok(binary(path, old_path));
    }
    if !force {
        let lines = old_bytes.as_deref().map_or(0, count_lines).max(new_bytes.as_deref().map_or(0, count_lines));
        if lines > MAX_TEXT_LINES {
            return Ok(FileDiff::TooLarge { path, old_path, status, bytes: largest, lines: Some(lines) });
        }
    }

    // Token only if the selection from this view also matches the real diff: with
    // "ignore whitespace" that only holds when both outputs are equal.
    let token = match target.tag {
        Some(tag) if files.len() <= 1 => {
            if ignore_whitespace {
                let real = run_patch(ctx, &target, false).await?;
                (real == raw_patch).then(|| token_of(tag, &real))
            } else {
                Some(token_of(tag, &raw_patch))
            }
        }
        _ => None,
    };
    Ok(FileDiff::Text(text_diff(path, old_path, status, &files, old_bytes.as_deref(), new_bytes.as_deref(), token, forced)))
}

/// Conflicted files, submodule entries and unchanged files: only the hunks, without
/// full versions and without a token (there is no line staging there).
async fn plain_text(ctx: &Ctx<'_>, target: &Target, ignore_whitespace: bool, forced: Forced) -> CoreResult<FileDiff> {
    let path = util::decode_lossy(&target.path);
    let old_path = target.entry.as_ref().and_then(|e| e.old_path.as_deref()).map(util::decode_lossy);
    let special = target.status == FileStatus::Conflicted || target.has_gitlink();
    let raw_patch = if special { run_patch(ctx, target, ignore_whitespace).await? } else { Vec::new() };
    let files = patch::parse_diff(&raw_patch);
    if files.iter().any(|f| f.binary) {
        return Ok(FileDiff::Binary { path, old_path, status: target.status, old_size: None, new_size: None });
    }
    let token = target.tag.filter(|_| !special).map(|tag| token_of(tag, &raw_patch));
    Ok(FileDiff::Text(text_diff(path, old_path, target.status, &files, None, None, token, forced)))
}

// ---------------------------------------------------------------------------
// From the parsed patch to the UI model
// ---------------------------------------------------------------------------

fn decode_line(bytes: &[u8], encoding: &str, forced: Forced) -> String {
    let bytes = bytes.strip_suffix(b"\r").unwrap_or(bytes);
    if let Some(enc) = forced {
        enc.decode_without_bom_handling(bytes).0.into_owned()
    } else if encoding == "windows-1252" {
        encoding_rs::WINDOWS_1252.decode(bytes).0.into_owned()
    } else {
        util::decode_lossy(bytes)
    }
}

#[allow(clippy::too_many_arguments)]
fn text_diff(
    path: String,
    old_path: Option<String>,
    status: FileStatus,
    files: &[FilePatch],
    old_bytes: Option<&[u8]>,
    new_bytes: Option<&[u8]>,
    token: Option<String>,
    forced: Forced,
) -> TextDiff {
    let hunks: Vec<&PatchHunk> = files.iter().flat_map(|f| &f.hunks).collect();
    // Guess the encoding per side; without loaded contents, from the lines of the diff.
    let from_lines = |kind: LineKind| -> &'static str {
        let mut sample = Vec::new();
        for line in hunks.iter().flat_map(|h| &h.lines).filter(|l| l.kind == LineKind::Context || l.kind == kind) {
            sample.extend_from_slice(&line.content);
            sample.push(b'\n');
        }
        util::decode_text(&sample).1
    };
    let old_encoding = old_bytes.map(|b| util::decode_text(b).1).unwrap_or_else(|| from_lines(LineKind::Remove));
    let new_encoding = new_bytes.map(|b| util::decode_text(b).1).unwrap_or_else(|| from_lines(LineKind::Add));
    let whole = |bytes: Option<&[u8]>| {
        bytes.filter(|b| b.len() as u64 <= MAX_TEXT_BYTES).map(|b| match forced {
            Some(enc) => crate::commands::history::decode_forced(b, enc).0,
            None => util::decode_text(b).0,
        })
    };

    let mut out = Vec::with_capacity(hunks.len());
    for (index, hunk) in hunks.iter().enumerate() {
        let (mut old_no, mut new_no) = (hunk.old_start, hunk.new_start);
        // With length 0 the header names the line before.
        if hunk.old_lines == 0 {
            old_no += 1;
        }
        if hunk.new_lines == 0 {
            new_no += 1;
        }
        let mut lines = Vec::with_capacity(hunk.lines.len());
        for line in &hunk.lines {
            let (kind, old, new, encoding) = match line.kind {
                LineKind::Context => (DiffLineKind::Context, Some(old_no), Some(new_no), new_encoding),
                LineKind::Remove => (DiffLineKind::Remove, Some(old_no), None, old_encoding),
                LineKind::Add => (DiffLineKind::Add, None, Some(new_no), new_encoding),
            };
            if old.is_some() {
                old_no += 1;
            }
            if new.is_some() {
                new_no += 1;
            }
            lines.push(DiffLine { kind, old_no: old, new_no: new, text: decode_line(&line.content, encoding, forced), no_newline: line.no_newline });
        }
        out.push(Hunk {
            index: index as u32,
            old_start: hunk.old_start,
            old_lines: hunk.old_lines,
            new_start: hunk.new_start,
            new_lines: hunk.new_lines,
            section: decode_line(&hunk.section, new_encoding, forced),
            lines,
        });
    }
    let encoding = match forced {
        Some(enc) => enc.name().to_ascii_lowercase(),
        None if new_bytes.is_some() || old_bytes.is_none() => new_encoding.to_string(),
        None => old_encoding.to_string(),
    };
    TextDiff { path, old_path, status, hunks: out, old_text: whole(old_bytes), new_text: whole(new_bytes), encoding, token }
}

// ---------------------------------------------------------------------------
// Basis for stage_patch, unstage_patch and discard_patch
// ---------------------------------------------------------------------------

/// The raw diff of one file (unstaged or staged), as `diff_file` showed it.
pub(crate) struct PatchBasis {
    /// The same value as `TextDiff.token` for this state.
    pub token: String,
    /// Path in raw bytes, for the patch header.
    pub path: Vec<u8>,
    files: Vec<FilePatch>,
}

impl PatchBasis {
    /// The diff as exactly one text file; otherwise no line can be selected.
    pub(crate) fn file(&self) -> CoreResult<&FilePatch> {
        match self.files.as_slice() {
            [file] if !file.binary => Ok(file),
            _ => Err(CoreError::not_allowed("You can't select individual lines in this file.")),
        }
    }
}

/// Re-reads the diff a selection refers to – call inside the
/// write lock and compare `token` with `PatchSelection.expect`.
pub(crate) async fn patch_basis(core: &Core, repo_id: &str, path: &str, staged: bool) -> CoreResult<PatchBasis> {
    let ctx = Ctx::new(core, repo_id)?;
    let (source, tag) = if staged { (DiffSource::Staged, "staged") } else { (DiffSource::Unstaged, "unstaged") };
    let target = resolve(&ctx, path, &source).await?;
    if target.status == FileStatus::Conflicted {
        return Err(CoreError::new(ErrorCode::Conflict, format!("“{path}” has a conflict. Resolve the conflict first.")));
    }
    if target.has_gitlink() {
        return Err(CoreError::not_allowed("You can't select individual lines in a submodule."));
    }
    let raw_patch = if target.entry.is_some() { run_patch(&ctx, &target, false).await? } else { Vec::new() };
    Ok(PatchBasis { token: token_of(tag, &raw_patch), path: target.path.clone(), files: patch::parse_diff(&raw_patch) })
}
