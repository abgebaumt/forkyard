//! Backing up the working directory and index as commits, and restoring them. This is the one
//! snapshot every destructive action uses (directly or through `Pending`).

use std::path::{Path, PathBuf};

use super::create_backup_ref;
use crate::app::Core;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::index::TempIndex;
use crate::git::rev;
use crate::git::{errors, GitCmd, GitOutput};
use crate::util;

/// Message of the backup commits.
pub const SNAPSHOT_MESSAGE: &str = "forkyard: backup";

/// Fixed identity of the app's own commits (backups, previews, stashes it builds): they can be
/// created even without user.name/user.email.
pub(crate) const BACKUP_IDENTITY: [(&str, &str); 4] = [
    ("GIT_AUTHOR_NAME", "forkyard"),
    ("GIT_AUTHOR_EMAIL", "forkyard@localhost"),
    ("GIT_COMMITTER_NAME", "forkyard"),
    ("GIT_COMMITTER_EMAIL", "forkyard@localhost"),
];

/// `git commit-tree` with [`BACKUP_IDENTITY`] and without signing (a backup must not wait for a
/// key or fail on one). Not logged.
pub(crate) async fn commit_tree(core: &Core, repo_id: &str, tree: &str, parents: &[&str], message: &str) -> CoreResult<String> {
    let mut cmd = core.git_for(repo_id)?.args(["commit-tree", "--no-gpg-sign", tree]).no_log();
    for parent in parents {
        cmd = cmd.args(["-p", parent]);
    }
    for (key, value) in BACKUP_IDENTITY {
        cmd = cmd.env(key, value);
    }
    let sha = cmd.args(["-m", message]).run_text().await?;
    if sha.is_empty() {
        return Err(CoreError::unknown("Couldn’t create a backup of the working directory."));
    }
    Ok(sha)
}

/// Git call in `root` (the repository or one of its worktrees), logged under `repo_id`.
fn git_in(core: &Core, repo_id: &str, root: &Path) -> GitCmd {
    core.git.cmd(root).repo(repo_id)
}

fn add_all(core: &Core, repo_id: &str, root: &Path, index: &TempIndex) -> GitCmd {
    git_in(core, repo_id, root)
        .args(["-c", "core.safecrlf=false", "add", "-A"])
        .env("GIT_INDEX_FILE", index.path())
        .literal_paths()
        .no_log()
}

fn pathspec_missing(out: &GitOutput) -> bool {
    out.stderr_text().to_lowercase().contains("did not match any file")
}

fn as_bytes(paths: Option<&[String]>) -> Option<Vec<Vec<u8>>> {
    paths.map(|list| list.iter().map(|path| path.as_bytes().to_vec()).collect())
}

/// What goes into a snapshot besides `git add -A`.
#[derive(Clone, Copy)]
struct Scope<'a> {
    /// `None` = everything; otherwise only these paths (literal, raw bytes).
    paths: Option<&'a [Vec<u8>]>,
    /// Commit that is about to be hard-reset to: files tracked there but untracked and ignored
    /// here are overwritten by Git without a prompt – they are included even though `add -A`
    /// leaves them out.
    overwrites: Option<&'a str>,
}

/// `git add -A` into the temporary index file, then `git write-tree`.
async fn add_and_write_tree(core: &Core, repo_id: &str, root: &Path, index: &TempIndex, scope: Scope<'_>) -> CoreResult<String> {
    // Many new files: the fast pre-step (only in the repository itself, it reads from there).
    if core.repo_path(repo_id).is_ok_and(|own| own == root) {
        crate::git::bulk::prestage(core, repo_id, Some(index.path()), scope.paths).await?;
    }
    match scope.paths {
        None => {
            add_all(core, repo_id, root, index).run().await?;
        }
        Some(paths) => {
            let out = add_all(core, repo_id, root, index)
                .args(["--pathspec-from-file=-", "--pathspec-file-nul"])
                .stdin(util::nul_join(paths))
                .run_raw()
                .await?;
            if !out.success() {
                if !pathspec_missing(&out) {
                    return Err(errors::classify("add", out.code, &out.stdout, &out.stderr));
                }
                // A path exists neither in the index nor on disk: add the remaining ones one by one.
                for path in paths {
                    let one = add_all(core, repo_id, root, index).arg("--").arg_bytes(path).run_raw().await?;
                    if !one.success() && !pathspec_missing(&one) {
                        return Err(errors::classify("add", one.code, &one.stdout, &one.stderr));
                    }
                }
            }
        }
    }
    if let Some(target) = scope.overwrites {
        // Tracked in the target, now not in the index but on disk: untracked. Whatever of it is
        // ignored is still missing after `add -A` and is added with force.
        let listed = git_in(core, repo_id, root)
            .env("GIT_INDEX_FILE", index.path())
            .read()
            .args(["diff-index", "--cached", "-z", "--name-only", "--no-renames", "--diff-filter=D", target])
            .run()
            .await?;
        let mut input = Vec::new();
        for path in listed.stdout_z() {
            if std::fs::symlink_metadata(util::join_from_git(root, path)).is_ok_and(|meta| meta.is_file()) {
                input.extend_from_slice(path);
                input.push(0);
            }
        }
        if !input.is_empty() {
            add_all(core, repo_id, root, index).args(["-f", "--pathspec-from-file=-", "--pathspec-file-nul"]).stdin(input).run().await?;
        }
    }
    git_in(core, repo_id, root).arg("write-tree").env("GIT_INDEX_FILE", index.path()).no_log().run_text().await
}

/// Tree of the current working directory: tracked and untracked (not ignored) files as
/// they are on disk. With `paths` this only applies to those paths; the rest of the tree
/// is then unspecified (index or HEAD state) and is not touched when restoring. The real
/// index stays untouched.
pub async fn worktree_tree(core: &Core, repo_id: &str, paths: Option<&[String]>) -> CoreResult<String> {
    let root = core.repo_path(repo_id)?;
    let git_dir = crate::git::repo::git_dir_at(core, &root, repo_id).await?;
    let copy = copy_index(core, &git_dir)?;
    let paths = as_bytes(paths);
    tree_from(core, repo_id, &root, copy, Scope { paths: paths.as_deref(), overwrites: None }).await
}

/// Copy of the real index as a starting point, so Git doesn't have to rehash unchanged
/// files. `None` if there is no index (yet) or copying fails.
fn copy_index(core: &Core, git_dir: &Path) -> CoreResult<Option<TempIndex>> {
    let real_index = git_dir.join("index");
    if !real_index.is_file() {
        return Ok(None);
    }
    let index = TempIndex::create(core)?;
    Ok(util::copy_index_file(&real_index, index.path()).ok().map(|_| index))
}

async fn tree_from(core: &Core, repo_id: &str, root: &Path, copy: Option<TempIndex>, scope: Scope<'_>) -> CoreResult<String> {
    if let Some(index) = copy {
        match add_and_write_tree(core, repo_id, root, &index, scope).await {
            Ok(tree) => return Ok(tree),
            // A foreign lock stays an error; nothing is backed up around it.
            Err(e) if e.is(ErrorCode::Locked) => return Err(e),
            Err(_) => {}
        }
    }
    // The documented way: index from HEAD (without a commit: empty index).
    let index = TempIndex::create(core)?;
    if head_commit(core, repo_id, root).await?.is_some() {
        git_in(core, repo_id, root).args(["read-tree", "HEAD"]).env("GIT_INDEX_FILE", index.path()).no_log().run().await?;
    }
    add_and_write_tree(core, repo_id, root, &index, scope).await
}

/// HEAD's commit in `root`; `None` without a commit.
async fn head_commit(core: &Core, repo_id: &str, root: &Path) -> CoreResult<Option<String>> {
    let out =
        git_in(core, repo_id, root).read().args(["rev-parse", "-q", "--verify", "--end-of-options", "HEAD^{commit}"]).run_raw().await?;
    Ok(Some(out.stdout_text()).filter(|sha| out.success() && !sha.is_empty()))
}

/// Tree of the real index; `None` while conflicts are open (then there is no tree).
pub async fn index_tree(core: &Core, repo_id: &str) -> CoreResult<Option<String>> {
    index_tree_in(core, repo_id, &core.repo_path(repo_id)?).await
}

async fn index_tree_in(core: &Core, repo_id: &str, root: &Path) -> CoreResult<Option<String>> {
    let unmerged = git_in(core, repo_id, root).args(["ls-files", "--unmerged", "-z"]).read().run().await?;
    if !unmerged.stdout.is_empty() {
        return Ok(None);
    }
    // `write-tree` takes the index lock: a foreign index.lock shows up here, before anything is destroyed.
    Ok(Some(git_in(core, repo_id, root).arg("write-tree").no_log().run_text().await?))
}

/// Backs up the working directory as a commit (parent HEAD, if any) and returns
/// `(worktree_sha, index_tree)`: the backup commit and the tree of the real index
/// (`None` while conflicts are open). `paths: None` backs up everything, otherwise only
/// these paths (literal, no patterns).
///
/// The commit is not on any ref: the caller keeps it with
/// `create_backup_ref(core, repo_id, &id, "worktree", &worktree_sha)` – or uses `Pending`.
/// Does NOT take the write lock itself.
pub async fn snapshot_worktree(core: &Core, repo_id: &str, paths: Option<&[String]>) -> CoreResult<(String, Option<String>)> {
    let snapshot = snapshot(core, repo_id, paths).await?;
    Ok((snapshot.commit, snapshot.index_tree))
}

/// Result of `snapshot`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    /// The backup commit.
    pub commit: String,
    /// Its tree: the state of the working directory.
    pub tree: String,
    /// Tree of the real index; `None` while conflicts are open.
    pub index_tree: Option<String>,
}

/// Like `snapshot_worktree`, additionally returns the backup's tree.
pub async fn snapshot(core: &Core, repo_id: &str, paths: Option<&[String]>) -> CoreResult<Snapshot> {
    let paths = as_bytes(paths);
    take(core, repo_id, &core.repo_path(repo_id)?, Scope { paths: paths.as_deref(), overwrites: None }).await
}

/// `snapshot` of raw paths (names that are not UTF-8 stay as they are).
pub(crate) async fn snapshot_paths(core: &Core, repo_id: &str, paths: Option<&[Vec<u8>]>) -> CoreResult<Snapshot> {
    take(core, repo_id, &core.repo_path(repo_id)?, Scope { paths, overwrites: None }).await
}

/// `snapshot` before `reset --hard <target>`: also the ignored files the reset would overwrite.
pub(crate) async fn snapshot_before_reset(core: &Core, repo_id: &str, target: &str) -> CoreResult<Snapshot> {
    take(core, repo_id, &core.repo_path(repo_id)?, Scope { paths: None, overwrites: Some(target) }).await
}

/// `snapshot` of the working directory `root` – one of the repository's worktrees (logged under
/// `repo_id`).
pub async fn snapshot_at(core: &Core, repo_id: &str, root: &Path) -> CoreResult<Snapshot> {
    take(core, repo_id, root, Scope { paths: None, overwrites: None }).await
}

async fn take(core: &Core, repo_id: &str, root: &Path, scope: Scope<'_>) -> CoreResult<Snapshot> {
    let git_dir = crate::git::repo::git_dir_at(core, root, repo_id).await?;
    // Copy first, then continue in parallel: `write-tree` may rewrite the real index meanwhile.
    let copy = copy_index(core, &git_dir)?;
    let (tree, head, index_tree) =
        tokio::join!(tree_from(core, repo_id, root, copy, scope), head_commit(core, repo_id, root), index_tree_in(core, repo_id, root),);
    let (tree, head, index_tree) = (tree?, head?, index_tree?);
    let mut parents: Vec<String> = Vec::new();
    if let Some(head) = head {
        let raw = raw_overlay(core, repo_id, root, &head, &tree, scope.paths).await;
        parents.push(head);
        parents.extend(raw);
    }
    let parents: Vec<&str> = parents.iter().map(String::as_str).collect();
    let commit = commit_tree(core, repo_id, &tree, &parents, SNAPSHOT_MESSAGE).await?;
    Ok(Snapshot { commit, tree, index_tree })
}

/// Message of the commit that carries a backup's raw versions (its second parent).
const RAW_MESSAGE: &str = "forkyard: raw versions";
/// Larger files get no raw version (they would otherwise end up twice in the object database).
const RAW_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// The backup is created via `git add` and written back via `checkout-index` – the repository's
/// filters apply in both directions. With `core.autocrlf` (or `eol` attributes) a file with pure LF
/// or mixed line endings would therefore come back normalised. For the files that differ between
/// the backup `tree` and `head`, this commit records the bytes as they are on disk (hashed without
/// filters); it becomes the second parent of the backup commit and so lives as long as that one.
///
/// `None` if there is nothing to record: no changed files, or their bytes are exactly those of the
/// backup and a checkout would not change them. Errors are no reason to give up the backup – it
/// then applies without raw versions.
async fn raw_overlay(core: &Core, repo_id: &str, root: &Path, head: &str, tree: &str, paths: Option<&[Vec<u8>]>) -> Option<String> {
    match raw_overlay_commit(core, repo_id, root, head, tree, paths).await {
        Ok(commit) => commit,
        Err(e) => {
            log::warn!("Raw versions for the backup not recorded: {}", e.message);
            None
        }
    }
}

async fn raw_overlay_commit(
    core: &Core,
    repo_id: &str,
    root: &Path,
    head: &str,
    tree: &str,
    paths: Option<&[Vec<u8>]>,
) -> CoreResult<Option<String>> {
    let changed = diff_raw(core, repo_id, head, tree, paths).await?;
    // Regular files of the backup that exist as a file on disk. (`--stdin-paths` splits at
    // newlines: names containing a newline are left out.)
    let candidates: Vec<&(Vec<u8>, RawChange)> = changed
        .iter()
        .filter(|(path, change)| {
            !is_zero(&change.new) && regular_file(&change.new_mode) && !path.contains(&b'\n') && !path.contains(&b'\r')
        })
        .filter(|(path, _)| {
            std::fs::symlink_metadata(util::join_from_git(root, path)).is_ok_and(|meta| meta.is_file() && meta.len() <= RAW_MAX_BYTES)
        })
        .collect();
    if candidates.is_empty() {
        return Ok(None);
    }
    let mut input = Vec::new();
    for (path, _) in &candidates {
        input.extend_from_slice(path);
        input.push(b'\n');
    }
    // With -w: new objects are only created where the raw bytes differ from the backup's version.
    let hashed =
        git_in(core, repo_id, root).args(["hash-object", "-w", "--no-filters", "--stdin-paths"]).stdin(input).no_log().run().await?;
    let ids: Vec<String> =
        hashed.stdout_lines().into_iter().map(util::decode_lossy).map(|id| id.trim().to_string()).filter(|id| !id.is_empty()).collect();
    if ids.len() != candidates.len() {
        return Ok(None);
    }
    let differs = candidates.iter().zip(&ids).any(|((_, change), id)| *id != change.new);
    // Even byte-identical versions would come back changed if a checkout rewrites line endings.
    let checkout_converts = if differs { true } else { checkout_rewrites_line_endings(core, repo_id).await };
    if !checkout_converts {
        return Ok(None);
    }
    let index = TempIndex::create(core)?;
    let mut info = Vec::new();
    for ((path, change), id) in candidates.iter().zip(&ids) {
        info.extend_from_slice(format!("{} {id}\t", change.new_mode).as_bytes());
        info.extend_from_slice(path);
        info.push(0);
    }
    core.git_for(repo_id)?
        .args(["update-index", "-z", "--index-info"])
        .env("GIT_INDEX_FILE", index.path())
        .stdin(info)
        .no_log()
        .run()
        .await?;
    let raw_tree = core.git_for(repo_id)?.arg("write-tree").env("GIT_INDEX_FILE", index.path()).no_log().run_text().await?;
    commit_tree(core, repo_id, &raw_tree, &[], RAW_MESSAGE).await.map(Some)
}

/// Whether a checkout would write files with LF line endings as CRLF (`core.autocrlf=true`).
async fn checkout_rewrites_line_endings(core: &Core, repo_id: &str) -> bool {
    let Ok(cmd) = core.git_for(repo_id) else { return false };
    match cmd.args(["config", "--get", "core.autocrlf"]).read().run_raw().await {
        Ok(out) => out.success() && out.stdout_text().trim().eq_ignore_ascii_case("true"),
        Err(_) => false,
    }
}

/// Tree of a backup's raw versions (see [`raw_overlay`]); `None` if `target` has none.
async fn raw_tree_of(core: &Core, repo_id: &str, target: &str) -> Option<String> {
    let parent = rev::rev_parse(core, repo_id, &format!("{target}^2")).await.ok()??;
    // A real merge commit also has a second parent: only our own counts.
    let subject = core
        .git_for(repo_id)
        .ok()?
        .args(["log", "-1", "--format=%s%n%P"])
        .args(crate::git::log::LOG_SAFE)
        .arg(&parent)
        .read()
        .run_raw()
        .await
        .ok()?;
    let text = subject.stdout_text();
    let mut lines = text.lines();
    if !subject.success() || lines.next() != Some(RAW_MESSAGE) || lines.next().is_some_and(|parents| !parents.trim().is_empty()) {
        return None;
    }
    rev::rev_parse(core, repo_id, &format!("{parent}^{{tree}}")).await.ok()?
}

/// Output of `git cat-file --batch`: per object `<id> <type> <size>\n<content>\n`, missing ones as `<id> missing\n`.
fn parse_cat_file_batch(out: &[u8]) -> Vec<Option<&[u8]>> {
    let mut contents = Vec::new();
    let mut at = 0;
    while at < out.len() {
        let Some(end) = out[at..].iter().position(|byte| *byte == b'\n') else { break };
        let header = String::from_utf8_lossy(&out[at..at + end]).into_owned();
        at += end + 1;
        if header.ends_with(" missing") || header.ends_with(" ambiguous") {
            contents.push(None);
            continue;
        }
        let Some(size) = header.rsplit(' ').next().and_then(|size| size.parse::<usize>().ok()) else { break };
        if at + size > out.len() {
            break;
        }
        contents.push(Some(&out[at..at + size]));
        at += size + 1;
    }
    contents
}

#[cfg(test)]
pub(crate) fn parse_cat_file_batch_for_tests(out: &[u8]) -> Vec<Option<&[u8]>> {
    parse_cat_file_batch(out)
}

/// For the just restored files `written`, writes back the raw version from `raw_tree` where
/// `checkout-index` left different bytes (line endings).
async fn restore_raw(core: &Core, repo_id: &str, raw_tree: &str, written: &[&Vec<u8>]) -> CoreResult<()> {
    if written.is_empty() {
        return Ok(());
    }
    let root = core.repo_path(repo_id)?;
    let listed = core.git_for(repo_id)?.args(["ls-tree", "-r", "-z", raw_tree]).read().run().await?;
    let mut raw: std::collections::HashMap<&[u8], String> = std::collections::HashMap::new();
    for record in listed.stdout_z() {
        let Some(tab) = record.iter().position(|byte| *byte == b'\t') else { continue };
        let meta = String::from_utf8_lossy(&record[..tab]).into_owned();
        if let Some(id) = meta.split(' ').nth(2) {
            raw.insert(&record[tab + 1..], id.to_string());
        }
    }
    let wanted: Vec<(&Vec<u8>, &String)> = written
        .iter()
        .filter_map(|path| raw.get(path.as_slice()).map(|id| (*path, id)))
        .filter(|(path, _)| std::fs::symlink_metadata(util::join_from_git(&root, path)).is_ok_and(|meta| meta.is_file()))
        .collect();
    if wanted.is_empty() {
        return Ok(());
    }
    let mut input = Vec::new();
    for (path, _) in &wanted {
        input.extend_from_slice(path);
        input.push(b'\n');
    }
    let hashed = core.git_for(repo_id)?.args(["hash-object", "--no-filters", "--stdin-paths"]).stdin(input).read().run().await?;
    let now: Vec<String> =
        hashed.stdout_lines().into_iter().map(util::decode_lossy).map(|id| id.trim().to_string()).filter(|id| !id.is_empty()).collect();
    if now.len() != wanted.len() {
        return Ok(());
    }
    let differing: Vec<&(&Vec<u8>, &String)> =
        wanted.iter().zip(&now).filter(|((_, id), current)| *id != *current).map(|(item, _)| item).collect();
    if differing.is_empty() {
        return Ok(());
    }
    let ids: Vec<u8> = differing.iter().flat_map(|(_, id)| id.bytes().chain(std::iter::once(b'\n'))).collect();
    let blobs = core.git_for(repo_id)?.args(["cat-file", "--batch"]).stdin(ids).read().run().await?;
    let contents = parse_cat_file_batch(&blobs.stdout);
    if contents.len() != differing.len() {
        return Ok(());
    }
    for ((path, _), content) in differing.iter().zip(contents) {
        let Some(content) = content else { continue };
        if let Err(e) = std::fs::write(util::join_from_git(&root, path), content) {
            log::warn!("Raw version of {} not written back: {e}", util::decode_lossy(path));
        }
    }
    Ok(())
}

fn in_paths<P: AsRef<[u8]>>(path: &[u8], paths: &[P]) -> bool {
    paths.iter().any(|p| {
        let mut p = p.as_ref();
        while let Some(rest) = p.strip_suffix(b"/") {
            p = rest;
        }
        p.is_empty() || path == p || (path.len() > p.len() && path.starts_with(p) && path[p.len()] == b'/')
    })
}

/// Paths from Git are relative and without `..`; still, never delete outside the working
/// directory or inside the Git directory.
fn safe_relative(rel: &Path) -> bool {
    use std::path::Component;
    let mut count = 0;
    for part in rel.components() {
        match part {
            Component::Normal(name) => {
                if count == 0 && name.eq_ignore_ascii_case(".git") {
                    return false;
                }
            }
            _ => return false,
        }
        count += 1;
    }
    count > 0
}

/// Deletes a file of the working directory and then folders that became empty.
/// Directories (e.g. embedded repositories) are left alone.
fn remove_worktree_file(root: &Path, rel: &[u8]) -> CoreResult<()> {
    let rel = util::bytes_to_path(rel);
    if !safe_relative(&rel) {
        return Ok(());
    }
    let full = root.join(&rel);
    let Ok(meta) = std::fs::symlink_metadata(&full) else {
        return Ok(());
    };
    if meta.is_dir() {
        return Ok(());
    }
    if let Err(first) = std::fs::remove_file(&full) {
        // Windows: read-only files and directory links need a second attempt.
        let mut perms = meta.permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        let _ = std::fs::set_permissions(&full, perms);
        if std::fs::remove_file(&full).is_err() && std::fs::remove_dir(&full).is_err() {
            return Err(CoreError::new(ErrorCode::Io, format!("The file “{}” couldn’t be removed: {first}", util::display_path(&rel))));
        }
    }
    let mut dir = full.parent();
    while let Some(d) = dir {
        if d == root || std::fs::remove_dir(d).is_err() {
            break;
        }
        dir = d.parent();
    }
    Ok(())
}

/// Brings the working directory to the state of `target` (backup commit, commit or tree):
/// changed and missing files are written from it, files that don't exist there are
/// deleted – untracked ones too, but never ignored ones. With `paths` only within those
/// paths. HEAD and the real index stay untouched (use `restore_index` for that).
/// Does NOT take the write lock itself.
pub async fn restore_worktree(core: &Core, repo_id: &str, target: &str, paths: Option<&[String]>) -> CoreResult<()> {
    let current = worktree_tree(core, repo_id, paths).await?;
    restore_worktree_from(core, repo_id, &current, target, paths).await
}

/// Like `restore_worktree`, when the tree of the current working directory is already known
/// (`Snapshot::tree` of a backup just created with the same `paths`).
pub async fn restore_worktree_from(core: &Core, repo_id: &str, current: &str, target: &str, paths: Option<&[String]>) -> CoreResult<()> {
    match plan_restore(core, repo_id, None, current, target, paths).await? {
        Ok(plan) => apply_restore(core, repo_id, &plan).await,
        // Without a base there are no files that could have been “changed since”.
        Err(_) => Ok(()),
    }
}

/// One line of `git diff-tree --raw`: mode and blob before and after.
#[derive(Debug, Clone)]
struct RawChange {
    old_mode: String,
    new_mode: String,
    old: String,
    new: String,
    status: u8,
}

fn is_zero(sha: &str) -> bool {
    sha.bytes().all(|b| b == b'0')
}

fn regular_file(mode: &str) -> bool {
    mode == "100644" || mode == "100755"
}

/// Per-path differences of two trees (without rename detection), limited to `paths`.
async fn diff_raw<P: AsRef<[u8]>>(
    core: &Core,
    repo_id: &str,
    from: &str,
    to: &str,
    paths: Option<&[P]>,
) -> CoreResult<Vec<(Vec<u8>, RawChange)>> {
    let out = core.git_for(repo_id)?.args(["diff-tree", "-r", "-z", "--raw", "--no-abbrev", "--no-renames", from, to]).read().run().await?;
    let records = out.stdout_z();
    let mut changes = Vec::new();
    for pair in records.chunks(2) {
        let [meta, path] = pair else { continue };
        if paths.is_some_and(|p| !in_paths(path, p)) {
            continue;
        }
        let text = String::from_utf8_lossy(meta);
        let mut parts = text.trim_start_matches(':').split(' ');
        let (Some(old_mode), Some(new_mode), Some(old), Some(new), Some(status)) =
            (parts.next(), parts.next(), parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        changes.push((
            path.to_vec(),
            RawChange {
                old_mode: old_mode.into(),
                new_mode: new_mode.into(),
                old: old.into(),
                new: new.into(),
                status: status.bytes().next().unwrap_or(b'M'),
            },
        ));
    }
    Ok(changes)
}

/// What `apply_restore` does to the working directory.
#[derive(Debug, Default)]
pub struct RestorePlan {
    target_tree: String,
    /// Tree with the backup's raw versions (bytes as on disk), if it has any.
    raw_tree: Option<String>,
    /// Files that don't exist in the target.
    delete: Vec<Vec<u8>>,
    /// Files whose type changes (file ↔ link ↔ submodule): removed first, then recreated.
    retype: Vec<Vec<u8>>,
    /// Files written from the target.
    write: Vec<Vec<u8>>,
    /// Files edited further since the action: (mode, blob, path) of the merged version.
    merged: Vec<(String, String, Vec<u8>)>,
}

impl RestorePlan {
    pub fn is_empty(&self) -> bool {
        self.delete.is_empty() && self.retype.is_empty() && self.write.is_empty() && self.merged.is_empty()
    }
}

/// Plans how the working directory (tree `current`) gets to the backed-up state `target`
/// without destroying work created since the action.
///
/// `base` is the state right after the action being undone (or after the undo being redone).
/// With it, only what the action itself changed is played back (`base` → `target`);
/// everything the user created or changed since stays:
/// - file not touched by the action → stays as it is;
/// - file unchanged since the action → is written from `target` or deleted;
/// - file changed by both → three-way merge of the content. If it doesn't merge cleanly,
///   the path is in the error list (`Err`) and nothing is changed.
///
/// Without `base` (entries from older versions) the whole difference `current` → `target` applies.
/// Only reads (and at most creates blobs); only `apply_restore` touches the working directory.
pub async fn plan_restore(
    core: &Core,
    repo_id: &str,
    base: Option<&str>,
    current: &str,
    target: &str,
    paths: Option<&[String]>,
) -> CoreResult<Result<RestorePlan, Vec<String>>> {
    let Some(target_tree) = rev::rev_parse(core, repo_id, &format!("{target}^{{tree}}")).await? else {
        return Err(CoreError::not_found("The backup for this action no longer exists."));
    };
    let mut plan = RestorePlan { target_tree: target_tree.clone(), ..RestorePlan::default() };
    if current == target_tree {
        return Ok(Ok(plan));
    }
    plan.raw_tree = raw_tree_of(core, repo_id, target).await;
    let base_tree = match base {
        Some(base) => rev::rev_parse(core, repo_id, &format!("{base}^{{tree}}")).await?,
        None => None,
    };
    // (changed since the action, changed by the action) – only with a known base.
    let known = match &base_tree {
        Some(base_tree) => {
            let since: std::collections::HashMap<Vec<u8>, RawChange> = if base_tree == current {
                Default::default()
            } else {
                diff_raw(core, repo_id, base_tree, current, paths).await?.into_iter().collect()
            };
            let wanted: std::collections::HashSet<Vec<u8>> =
                diff_raw(core, repo_id, base_tree, &target_tree, paths).await?.into_iter().map(|(path, _)| path).collect();
            Some((since, wanted))
        }
        None => None,
    };
    let mut blocked: Vec<String> = Vec::new();
    let git_dir = crate::git::repo::git_dir(core, repo_id).await?;
    for (path, change) in diff_raw(core, repo_id, current, &target_tree, paths).await? {
        if let Some((since, wanted)) = &known {
            if !wanted.contains(&path) {
                // Only the user has touched this file since: it stays.
                continue;
            }
            if let Some(mine) = since.get(&path) {
                match merge_content(core, repo_id, &git_dir, mine, &change).await? {
                    Some(blob) => plan.merged.push((mine.new_mode.clone(), blob, path)),
                    None => blocked.push(util::decode_lossy(&path)),
                }
                continue;
            }
        }
        if is_zero(&change.new) {
            plan.delete.push(path);
        } else if change.status == b'T' {
            plan.retype.push(path);
        } else {
            plan.write.push(path);
        }
    }
    if blocked.is_empty() {
        Ok(Ok(plan))
    } else {
        Ok(Err(blocked))
    }
}

/// Temporary file in the Git directory; deleted on drop.
struct TempFile(PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Three-way merge of a file: `mine` is base → now, `theirs` is now → target.
/// Returns the blob of the merged version; `None` if the changes overlap or the file is
/// not a regular text file (deleted, binary, link).
async fn merge_content(core: &Core, repo_id: &str, git_dir: &Path, mine: &RawChange, theirs: &RawChange) -> CoreResult<Option<String>> {
    let blobs = [&mine.new, &mine.old, &theirs.new];
    let modes = [&mine.new_mode, &mine.old_mode, &theirs.new_mode];
    if blobs.iter().any(|sha| is_zero(sha)) || modes.iter().any(|mode| !regular_file(mode)) {
        return Ok(None);
    }
    let id = util::new_id();
    let mut files = Vec::new();
    for (name, sha) in ["jetzt", "basis", "ziel"].iter().zip(blobs) {
        let out = core.git_for(repo_id)?.args(["cat-file", "blob", sha]).read().run_raw().await?;
        if !out.success() || util::looks_binary(&out.stdout) {
            return Ok(None);
        }
        let file = TempFile(git_dir.join(format!("forkyard-merge-{id}-{name}")));
        std::fs::write(&file.0, &out.stdout)?;
        files.push(file);
    }
    let out =
        core.git_for(repo_id)?.args(["merge-file", "-p", "-q"]).arg(&files[0].0).arg(&files[1].0).arg(&files[2].0).read().run_raw().await?;
    // Exit code = number of conflicts; anything but 0 means: not mergeable.
    if out.code != Some(0) {
        return Ok(None);
    }
    let blob = core.git_for(repo_id)?.args(["hash-object", "-w", "--stdin"]).stdin(out.stdout).no_log().run_text().await?;
    Ok(Some(blob).filter(|sha| !sha.is_empty()))
}

/// Those of `paths` that are ignored by the rules now in effect (tracked ones too).
async fn ignored_among(core: &Core, repo_id: &str, paths: &[Vec<u8>]) -> std::collections::HashSet<Vec<u8>> {
    if paths.is_empty() {
        return Default::default();
    }
    let checked = match core.git_for(repo_id) {
        Ok(cmd) => cmd.args(["check-ignore", "--no-index", "-z", "--stdin"]).stdin(util::nul_join(paths)).read().run_raw().await,
        Err(e) => Err(e),
    };
    match checked {
        Ok(out) if out.code == Some(0) => out.stdout_z().into_iter().map(<[u8]>::to_vec).collect(),
        _ => Default::default(),
    }
}

fn is_ignore_file(path: &[u8]) -> bool {
    path == b".gitignore" || path.ends_with(b"/.gitignore")
}

/// Executes a plan from `plan_restore`. HEAD and the real index stay untouched.
/// Files that don't exist in the target are deleted – unless they are ignored by the
/// target's rules: there was never a backup of them, so they are not part of what the
/// action changed. Does NOT take the write lock itself.
pub async fn apply_restore(core: &Core, repo_id: &str, plan: &RestorePlan) -> CoreResult<()> {
    if plan.is_empty() {
        return Ok(());
    }
    let root = core.repo_path(repo_id)?;
    // Where a file changes its type, the spot must be free.
    for path in &plan.retype {
        remove_worktree_file(&root, path)?;
    }
    let index = TempIndex::create(core)?;
    core.git_for(repo_id)?.args(["read-tree", &plan.target_tree]).env("GIT_INDEX_FILE", index.path()).no_log().run().await?;
    if !plan.merged.is_empty() {
        let mut info = Vec::new();
        for (mode, blob, path) in &plan.merged {
            info.extend_from_slice(format!("{mode} {blob}\t").as_bytes());
            info.extend_from_slice(path);
            info.push(0);
        }
        core.git_for(repo_id)?
            .args(["update-index", "-z", "--index-info"])
            .env("GIT_INDEX_FILE", index.path())
            .stdin(info)
            .no_log()
            .run()
            .await?;
    }
    let all_writes = || plan.write.iter().chain(&plan.retype).chain(plan.merged.iter().map(|(_, _, path)| path));
    // First restore the target's ignore rules: they decide what gets deleted.
    let rules: Vec<&Vec<u8>> = all_writes().filter(|path| is_ignore_file(path)).collect();
    checkout_from(core, repo_id, &index, &rules).await?;
    let ignored = ignored_among(core, repo_id, &plan.delete).await;
    // Then delete: where a file gives way to a folder (or vice versa), the spot must be free.
    for path in plan.delete.iter().filter(|path| !ignored.contains(*path)) {
        remove_worktree_file(&root, path)?;
    }
    let rest: Vec<&Vec<u8>> = all_writes().filter(|path| !is_ignore_file(path)).collect();
    checkout_from(core, repo_id, &index, &rest).await?;
    // Merged files are new versions; for all others, what was on disk applies.
    if let Some(raw_tree) = &plan.raw_tree {
        let verbatim: Vec<&Vec<u8>> = plan.write.iter().chain(&plan.retype).collect();
        if let Err(e) = restore_raw(core, repo_id, raw_tree, &verbatim).await {
            log::warn!("Raw versions not written back: {}", e.message);
        }
    }
    Ok(())
}

/// Writes `paths` from the temporary index file into the working directory.
async fn checkout_from(core: &Core, repo_id: &str, index: &TempIndex, paths: &[&Vec<u8>]) -> CoreResult<()> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut input = Vec::new();
    for path in paths {
        input.extend_from_slice(path);
        input.push(0);
    }
    core.git_for(repo_id)?
        .args(["checkout-index", "-f", "-z", "--stdin"])
        .env("GIT_INDEX_FILE", index.path())
        .stdin(input)
        .no_log()
        .run()
        .await?;
    Ok(())
}

/// Records the current state of the working directory as a commit under
/// `refs/forkyard/undo/<entry_id>/<name>` and returns its SHA: the state `plan_restore` later
/// uses to tell what has been added since. Does NOT take the write lock itself.
pub async fn keep_result(core: &Core, repo_id: &str, entry_id: &str, name: &str, paths: Option<&[String]>) -> CoreResult<String> {
    let tree = worktree_tree(core, repo_id, paths).await?;
    let commit = commit_tree(core, repo_id, &tree, &[], "forkyard: state after the action").await?;
    create_backup_ref(core, repo_id, entry_id, name, &commit).await?;
    Ok(commit)
}

/// Writes the state after the action into an already stored undo entry
/// (`payload.resultSnapshot`). If that fails, the provisional value stays.
pub async fn record_result(core: &Core, repo_id: &str, entry_id: &str, paths: Option<&[String]>) {
    let result: CoreResult<()> = async {
        let commit = keep_result(core, repo_id, entry_id, "result", paths).await?;
        core.db.with(|c| {
            c.execute(
                "update undo_entries set payload = json_set(payload, '$.resultSnapshot', ?2) where id = ?1",
                rusqlite::params![entry_id, commit],
            )?;
            Ok(())
        })
    }
    .await;
    if let Err(e) = result {
        log::warn!("State after action {entry_id} not recorded: {}", e.message);
    }
}

/// The empty tree – the state “after the action” when there is no commit yet.
pub const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/// Sets the real index to `tree` (tree or commit) without touching the working directory.
/// Does NOT take the write lock itself.
pub async fn restore_index(core: &Core, repo_id: &str, tree: &str) -> CoreResult<()> {
    core.git_for(repo_id)?.args(["read-tree", "--reset", tree]).run().await?;
    // Refresh timestamps so the next status doesn't have to rehash everything.
    core.git_for(repo_id)?.args(["update-index", "-q", "--refresh"]).no_log().run_raw().await?;
    Ok(())
}
