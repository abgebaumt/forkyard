//! Linux: watching the working directory folder by folder.
//!
//! notify's recursive inotify watch walks the whole tree with symlinks followed and puts one
//! watch on every folder – node_modules, build output and nested checkouts included. In a large
//! repository that takes many seconds of CPU and can use up `max_user_watches`. Here only the
//! folders Git can see get a (non-recursive) watch: symlinks, `.git`, nested repositories and
//! ignored folders are skipped. Folders that appear later are added as their events arrive.

use std::collections::HashSet;
use std::path::Path;

use crate::app::Core;
use crate::util;

/// Folders (relative, with `/`, no trailing slash) that Git ignores as a whole. Empty if Git
/// can't answer: then everything is watched, as before.
pub(super) async fn ignored_dirs(core: &Core, root: &Path) -> HashSet<Vec<u8>> {
    // Lists ignored folders as `dir/`, but also folders that merely hold nothing but ignored
    // files (`src/` with only `debug.log`) – those must stay watched, so check-ignore confirms.
    let mut candidates: Vec<u8> = Vec::new();
    let listing = core
        .git_at(root)
        .args(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"])
        .read()
        .run_records(0, None, &mut |entry| {
            if let Some(dir) = entry.strip_suffix(b"/") {
                // A leading `:` would be taken by check-ignore as pathspec magic.
                if dir.first() == Some(&b':') {
                    candidates.extend_from_slice(b"./");
                }
                candidates.extend_from_slice(dir);
                candidates.push(0);
            }
            true
        })
        .await;
    if listing.is_err() || candidates.is_empty() {
        return HashSet::new();
    }
    match core.git_at(root).args(["check-ignore", "-z", "--stdin"]).stdin(candidates).read().run_raw().await {
        Ok(out) if out.code == Some(0) => util::split_z(&out.stdout).map(|p| p.strip_prefix(b"./").unwrap_or(p).to_vec()).collect(),
        _ => HashSet::new(),
    }
}

/// Calls `add` for `dir` and every folder below it that Git can see (see the module docs).
/// `ignored` is relative to `root`. Folders that vanish during the walk are skipped; any other
/// failure (watch limit reached) ends the walk.
pub(super) fn watch_tree(
    root: &Path,
    dir: &Path,
    ignored: &HashSet<Vec<u8>>,
    add: &mut dyn FnMut(&Path) -> notify::Result<()>,
) -> notify::Result<()> {
    if in_nested_repo(root, dir) {
        return Ok(());
    }
    let mut stack = vec![dir.to_path_buf()];
    while let Some(dir) = stack.pop() {
        // Watch first, then list: a folder created in between still reports itself.
        if let Err(e) = add(&dir) {
            if dir.is_dir() {
                return Err(e);
            }
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            // `file_type` doesn't follow symlinks.
            if !entry.file_type().is_ok_and(|t| t.is_dir()) || entry.file_name() == ".git" {
                continue;
            }
            let path = entry.path();
            let ignored_here = super::rel_bytes(root, &path).is_some_and(|rel| ignored.contains(&rel));
            if !ignored_here && !has_git(&path) {
                stack.push(path);
            }
        }
    }
    Ok(())
}

/// A folder with its own `.git` (nested repository, submodule, worktree) is not ours to watch.
fn has_git(dir: &Path) -> bool {
    dir.join(".git").symlink_metadata().is_ok()
}

/// Whether `dir` or a folder between it and `root` is a nested repository.
fn in_nested_repo(root: &Path, dir: &Path) -> bool {
    dir.ancestors().take_while(|a| *a != root && a.starts_with(root)).any(has_git)
}
