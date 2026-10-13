//! Worktrees: additional working directories of the same repository (`git worktree`).
//!
//! A worktree is opened via `repo_open` like any repository; these commands list, create,
//! remove, lock and prune. Writing commands run under the write lock and report
//! `repo:changed` with `refs` (the list hangs off the branches: `Ref.worktreePath`). All of
//! them return the new list.

use std::path::{Path, PathBuf};

use crate::app::Core;
use crate::db;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::GitCmd;
use crate::model::{AppChange, RepoChange, Worktree};
use crate::util;

/// One entry from `git worktree list --porcelain -z`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct RawWorktree {
    path: Vec<u8>,
    head: Option<String>,
    /// Full ref name of the checked-out branch.
    branch: Option<String>,
    bare: bool,
    locked: Option<String>,
    prunable: Option<String>,
}

/// Parses `git worktree list --porcelain -z`: lines end with NUL, an empty entry separates
/// the worktrees. The first entry is the main worktree.
fn parse_list(stdout: &[u8]) -> Vec<RawWorktree> {
    let mut out: Vec<RawWorktree> = Vec::new();
    let mut current: Option<RawWorktree> = None;
    for field in stdout.split(|&b| b == 0) {
        if field.is_empty() {
            out.extend(current.take());
            continue;
        }
        let (key, value) = match field.iter().position(|&b| b == b' ') {
            Some(space) => (&field[..space], &field[space + 1..]),
            None => (field, &field[field.len()..]),
        };
        if key == b"worktree" {
            out.extend(current.take());
            current = Some(RawWorktree { path: value.to_vec(), ..RawWorktree::default() });
            continue;
        }
        let Some(entry) = current.as_mut() else { continue };
        match key {
            b"HEAD" => entry.head = Some(util::decode_lossy(value)),
            b"branch" => entry.branch = Some(util::decode_lossy(value)),
            b"bare" => entry.bare = true,
            b"locked" => entry.locked = Some(util::decode_lossy(value).trim().to_string()),
            b"prunable" => entry.prunable = Some(util::decode_lossy(value).trim().to_string()),
            // "detached" and anything unknown.
            _ => {}
        }
    }
    out.extend(current);
    out
}

fn read(core: &Core, repo_id: &str) -> CoreResult<GitCmd> {
    Ok(core.git_for(repo_id)?.read_only().no_log())
}

async fn read_raw(core: &Core, repo_id: &str) -> CoreResult<Vec<RawWorktree>> {
    let out = read(core, repo_id)?.args(["worktree", "list", "--porcelain", "-z"]).run().await?;
    Ok(parse_list(&out.stdout))
}

/// Whether the working directory has changes or untracked files – exactly what makes Git
/// refuse removal without `--force`.
async fn has_changes(core: &Core, repo_id: &str, path: &Path) -> bool {
    if !path.is_dir() {
        return false;
    }
    let out = core
        .git
        .cmd(path)
        .repo(repo_id)
        .read_only()
        .no_log()
        .args(["status", "--porcelain=v2", "-z", "--untracked-files=normal"])
        .run_raw()
        .await;
    matches!(out, Ok(out) if out.success() && !out.stdout.is_empty())
}

async fn list(core: &Core, repo_id: &str) -> CoreResult<Vec<Worktree>> {
    let own = util::path_key(&core.repo_path(repo_id)?);
    let raw = read_raw(core, repo_id).await?;
    let mut out = Vec::with_capacity(raw.len());
    for (index, entry) in raw.into_iter().enumerate() {
        let path = util::native_path(&util::bytes_to_path(&entry.path));
        let prunable = entry.prunable.is_some();
        let changed = if entry.bare || prunable { false } else { has_changes(core, repo_id, &path).await };
        out.push(Worktree {
            is_current: util::path_key(&path) == own,
            path: util::display_path(&path),
            branch: entry.branch.as_deref().map(|full| full.strip_prefix("refs/heads/").unwrap_or(full).to_string()),
            head: entry.head.filter(|_| !entry.bare),
            is_main: index == 0,
            is_locked: entry.locked.is_some(),
            lock_reason: entry.locked.filter(|reason| !reason.is_empty()),
            is_prunable: prunable,
            has_changes: changed,
        });
    }
    Ok(out)
}

/// All worktrees of the repository; the main worktree comes first.
pub async fn worktree_list(core: &Core, repo_id: String) -> CoreResult<Vec<Worktree>> {
    list(core, &repo_id).await
}

fn same_path(a: &Path, b: &Path) -> bool {
    util::path_key(a) == util::path_key(b)
}

/// Finds the worktree at `path`; index 0 is the main worktree.
async fn find(core: &Core, repo_id: &str, path: &str) -> CoreResult<(usize, RawWorktree)> {
    let wanted = PathBuf::from(path.trim());
    let found = read_raw(core, repo_id).await?.into_iter().enumerate().find(|(_, w)| same_path(&util::bytes_to_path(&w.path), &wanted));
    found.ok_or_else(|| CoreError::not_found(format!("There’s no worktree of this repository at “{}”.", path.trim())))
}

async fn local_branch_exists(core: &Core, repo_id: &str, name: &str) -> CoreResult<bool> {
    let out = read(core, repo_id)?.args(["show-ref", "--verify", "--quiet", &format!("refs/heads/{name}")]).run_raw().await?;
    Ok(out.success())
}

/// Path of the worktree in which the branch is checked out.
async fn checked_out_at(core: &Core, repo_id: &str, branch: &str) -> CoreResult<Option<String>> {
    let full = format!("refs/heads/{branch}");
    Ok(read_raw(core, repo_id)
        .await?
        .into_iter()
        .find(|w| w.branch.as_deref() == Some(full.as_str()))
        .map(|w| util::display_path(&util::bytes_to_path(&w.path))))
}

async fn resolve_commit(core: &Core, repo_id: &str, rev: &str) -> CoreResult<String> {
    crate::commands::graph::resolve_commit(core, repo_id, rev).await
}

/// Creates a worktree at `path` (absolute path; the folder must not exist or must be
/// empty).
///
/// - `new_branch`: creates the branch `branch` from `start` (branch, tag or SHA; HEAD if not
///   given) and checks it out there.
/// - otherwise: checks out the existing local branch `branch`; if `branch` is not a local
///   branch but a remote branch, tag or SHA, the worktree is created detached
///   (detached HEAD) on that commit. `start` plays no role then.
///
/// Errors: `not_allowed` (path not absolute, branch already checked out in another worktree
/// – the message names it), `path_not_found` (parent folder missing), `path_exists`
/// (target is a file or not empty), `invalid_name`, `name_exists`, `not_found`
/// (branch or start point unknown).
pub async fn worktree_add(core: &Core, repo_id: String, path: String, branch: String, new_branch: bool, start: Option<String>) -> CoreResult<Vec<Worktree>> {
    let repo_id = repo_id.as_str();
    core.repo_path(repo_id)?;
    let target = PathBuf::from(path.trim());
    if path.trim().is_empty() || !target.is_absolute() {
        return Err(CoreError::not_allowed("Enter the full path of the new worktree."));
    }
    match target.parent() {
        Some(parent) if parent.is_dir() => {}
        _ => return Err(CoreError::path_not_found(util::display_path(target.parent().unwrap_or(&target)))),
    }
    if target.exists() {
        let empty_dir = target.is_dir() && std::fs::read_dir(&target).map(|mut entries| entries.next().is_none()).unwrap_or(false);
        if !empty_dir {
            return Err(CoreError::path_exists(util::display_path(&target)));
        }
    }
    let branch = branch.trim().to_string();
    let start = start.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());

    core.with_write_lock(repo_id, &[RepoChange::Refs], async {
        let mut cmd = core.git_for(repo_id)?.args(["worktree", "add"]);
        if new_branch {
            if let Err(reason) = util::check_ref_name(&branch) {
                return Err(CoreError::invalid_name(reason));
            }
            if local_branch_exists(core, repo_id, &branch).await? {
                return Err(CoreError::name_exists(format!("A branch “{branch}” already exists.")));
            }
            let from = match &start {
                Some(rev) => resolve_commit(core, repo_id, rev).await?,
                None => resolve_commit(core, repo_id, "HEAD")
                    .await
                    .map_err(|_| CoreError::not_allowed("The repository has no commits yet; a worktree needs a commit to start from."))?,
            };
            cmd = cmd.args(["-b", &branch]).arg(&target).arg(from);
        } else if branch.is_empty() {
            return Err(CoreError::not_found("No branch was specified."));
        } else if local_branch_exists(core, repo_id, &branch).await? {
            if let Some(elsewhere) = checked_out_at(core, repo_id, &branch).await? {
                return Err(CoreError::not_allowed(format!(
                    "The branch “{branch}” is already checked out in the worktree “{elsewhere}”. A branch can be checked out in only one worktree at a time."
                )));
            }
            cmd = cmd.arg(&target).arg(&branch);
        } else {
            // Not a local branch: remote branch, tag or SHA – detached on that commit.
            let commit = resolve_commit(core, repo_id, &branch)
                .await
                .map_err(|_| CoreError::not_found(format!("The branch or commit “{branch}” doesn’t exist.")))?;
            cmd = cmd.arg("--detach").arg(&target).arg(commit);
        }
        cmd.run().await?;
        list(core, repo_id).await
    })
    .await
}

/// The file watcher of a worktree opened as a repository keeps its folder open; it is
/// stopped before removal.
fn stop_watching(core: &Core, path: &Path) {
    let known = core.db.with(db::repos::list_all).unwrap_or_default();
    for row in known.iter().filter(|row| same_path(Path::new(&row.path), path)) {
        let _ = crate::watcher::stop_watching(core, &row.id);
        let _ = crate::autofetch::stop(core, &row.id);
    }
}

/// Removes repository list entries that point to a removed worktree (it was opened as a
/// repository of its own), closes their tabs and reports `app:changed`.
fn forget_listed(core: &Core, path: &Path) {
    let known = core.db.with(db::repos::list_all).unwrap_or_default();
    let ids: Vec<String> = known.iter().filter(|row| same_path(Path::new(&row.path), path)).map(|row| row.id.clone()).collect();
    if ids.is_empty() {
        return;
    }
    let removed = core.db.tx(|tx| {
        for id in &ids {
            db::repos::delete(tx, id)?;
        }
        let profile_id = db::profiles::active_id(tx)?;
        db::tabs::ensure_consistent(tx, &profile_id)
    });
    match removed {
        Ok(()) => core.emit_app_changed(&[AppChange::Repos, AppChange::Tabs]),
        Err(e) => log::warn!("entry of the removed worktree not taken off the repository list: {}", e.message),
    }
}

/// Removes the worktree at `path` (the branch stays). With changes or untracked files only
/// with `force` – they are lost then. If the worktree was opened as a repository of its own,
/// its repository list entry and its tabs disappear (`app:changed` with `repos` and `tabs`).
///
/// Errors: `not_found`; `not_allowed` (main worktree, the worktree currently open, or
/// locked – unlock first); `dirty_worktree` (changes, without `force`).
pub async fn worktree_remove(core: &Core, repo_id: String, path: String, force: bool) -> CoreResult<Vec<Worktree>> {
    let repo_id = repo_id.as_str();
    let own = core.repo_path(repo_id)?;
    core.with_write_lock(repo_id, &[RepoChange::Refs], async {
        let (index, entry) = find(core, repo_id, &path).await?;
        let target = util::native_path(&util::bytes_to_path(&entry.path));
        let shown = util::display_path(&target);
        if index == 0 {
            return Err(CoreError::not_allowed("The main worktree can’t be removed; it’s the repository itself."));
        }
        if same_path(&target, &own) {
            return Err(CoreError::not_allowed(
                "This worktree is currently open. Open the repository or another worktree and remove it from there.",
            ));
        }
        if entry.locked.is_some() {
            return Err(CoreError::not_allowed(format!("The worktree “{shown}” is locked. Unlock it first.")));
        }
        if !force && entry.prunable.is_none() && has_changes(core, repo_id, &target).await {
            return Err(CoreError::new(
                ErrorCode::DirtyWorktree,
                format!("The worktree “{shown}” contains uncommitted changes or untracked files. They would be lost on removal."),
            ));
        }
        stop_watching(core, &target);
        let mut cmd = core.git_for(repo_id)?.args(["worktree", "remove"]);
        if force {
            cmd = cmd.arg("--force");
        }
        let out = cmd.arg(&target).run_raw().await?;
        if !out.success() {
            let text = out.stderr_text().to_lowercase();
            if text.contains("contains modified or untracked files") {
                return Err(CoreError::new(
                    ErrorCode::DirtyWorktree,
                    format!("The worktree “{shown}” contains uncommitted changes or untracked files. They would be lost on removal."),
                )
                .with_git_output(out.stderr_text()));
            }
            return Err(crate::git::errors::classify("worktree", out.code, &out.stdout, &out.stderr));
        }
        forget_listed(core, &target);
        list(core, repo_id).await
    })
    .await
}

/// Locks the worktree against pruning and removal, optionally with a reason. If it is already
/// locked, the reason is replaced. The main worktree cannot be locked.
pub async fn worktree_lock(core: &Core, repo_id: String, path: String, reason: Option<String>) -> CoreResult<Vec<Worktree>> {
    let repo_id = repo_id.as_str();
    let reason = reason.map(|r| r.split_whitespace().collect::<Vec<_>>().join(" ")).filter(|r| !r.is_empty());
    core.with_write_lock(repo_id, &[RepoChange::Refs], async {
        let (index, entry) = find(core, repo_id, &path).await?;
        if index == 0 {
            return Err(CoreError::not_allowed("The main worktree can’t be locked."));
        }
        let target = util::bytes_to_path(&entry.path);
        if entry.locked.is_some() {
            core.git_for(repo_id)?.args(["worktree", "unlock"]).arg(&target).run().await?;
        }
        let mut cmd = core.git_for(repo_id)?.args(["worktree", "lock"]);
        if let Some(reason) = &reason {
            cmd = cmd.args(["--reason", reason.as_str()]);
        }
        cmd.arg(&target).run().await?;
        list(core, repo_id).await
    })
    .await
}

/// Removes the lock; a worktree that is not locked stays as it is.
pub async fn worktree_unlock(core: &Core, repo_id: String, path: String) -> CoreResult<Vec<Worktree>> {
    let repo_id = repo_id.as_str();
    core.with_write_lock(repo_id, &[RepoChange::Refs], async {
        let (_, entry) = find(core, repo_id, &path).await?;
        if entry.locked.is_some() {
            core.git_for(repo_id)?.args(["worktree", "unlock"]).arg(util::bytes_to_path(&entry.path)).run().await?;
        }
        list(core, repo_id).await
    })
    .await
}

/// Prunes entries of worktrees whose folder no longer exists (`isPrunable`).
/// Locked ones stay.
pub async fn worktree_prune(core: &Core, repo_id: String) -> CoreResult<Vec<Worktree>> {
    let repo_id = repo_id.as_str();
    core.with_write_lock(repo_id, &[RepoChange::Refs], async {
        core.git_for(repo_id)?.args(["worktree", "prune"]).run().await?;
        list(core, repo_id).await
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::names;
    use crate::testkit::{TestCore, TestRepo};

    async fn setup() -> (TestCore, TestRepo, String) {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let id = tc.open(&repo).await.repo.id;
        (tc, repo, id)
    }

    fn sibling(repo: &TestRepo, name: &str) -> String {
        repo.temp_dir().join(name).to_string_lossy().into_owned()
    }

    fn at<'a>(list: &'a [Worktree], path: &str) -> &'a Worktree {
        list.iter().find(|w| same_path(Path::new(&w.path), Path::new(path))).unwrap_or_else(|| panic!("worktree {path} missing in {list:?}"))
    }

    fn code<T: std::fmt::Debug>(result: CoreResult<T>) -> ErrorCode {
        result.expect_err("Fehler erwartet").code
    }

    #[test]
    fn porcelain_list_is_parsed() {
        let text = "worktree C:/r/haupt\0HEAD 1111111111111111111111111111111111111111\0branch refs/heads/main\0\0\
worktree C:/r/mit leer/zwei\0HEAD 2222222222222222222222222222222222222222\0detached\0locked wird noch gebraucht\nzweite Zeile\0\0\
worktree C:/r/weg\0HEAD 3333333333333333333333333333333333333333\0branch refs/heads/feature/x\0locked\0prunable gitdir file points to non-existent location\0\0";
        let parsed = parse_list(text.as_bytes());
        assert_eq!(parsed.len(), 3);
        assert_eq!((parsed[0].path.as_slice(), parsed[0].branch.as_deref(), parsed[0].locked.as_deref()), (&b"C:/r/haupt"[..], Some("refs/heads/main"), None));
        assert_eq!((parsed[1].path.as_slice(), parsed[1].branch.as_deref()), (&b"C:/r/mit leer/zwei"[..], None));
        assert_eq!(parsed[1].locked.as_deref(), Some("wird noch gebraucht\nzweite Zeile"));
        assert_eq!((parsed[2].locked.as_deref(), parsed[2].prunable.is_some()), (Some(""), true));
        assert_eq!(parsed[2].branch.as_deref(), Some("refs/heads/feature/x"));
        // Bare repository and truncated output.
        let bare = parse_list(b"worktree /srv/r.git\0bare\0\0worktree /srv/w\0HEAD 44");
        assert_eq!((bare.len(), bare[0].bare, bare[0].head.as_deref(), bare[1].head.as_deref()), (2, true, None, Some("44")));
        assert!(parse_list(b"").is_empty());
    }

    #[tokio::test]
    async fn list_add_and_open() {
        let (tc, repo, id) = setup().await;
        let first = repo.head();
        let second = repo.commit_file("a.txt", "a\n", "Zweiter");
        repo.git(&["tag", "v1", &first]);
        let list = worktree_list(&tc, id.clone()).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!((list[0].branch.as_deref(), list[0].head.as_deref()), (Some("main"), Some(second.as_str())));
        assert!(list[0].is_main && list[0].is_current && !list[0].is_locked && !list[0].is_prunable && !list[0].has_changes);
        assert!(same_path(Path::new(&list[0].path), repo.path()));

        // New branch from HEAD, in a folder with a space and an umlaut.
        tc.events.clear();
        let feature_path = sibling(&repo, "Zweig Größe");
        let list = worktree_add(&tc, id.clone(), feature_path.clone(), "feature/neu".into(), true, None).await.unwrap();
        assert_eq!(list.len(), 2);
        let feature = at(&list, &feature_path);
        assert_eq!((feature.branch.as_deref(), feature.head.as_deref()), (Some("feature/neu"), Some(second.as_str())));
        assert!(!feature.is_main && !feature.is_current && !feature.has_changes);
        assert!(Path::new(&feature_path).join("a.txt").exists());
        assert_eq!(repo.git(&["rev-parse", "feature/neu"]), second);
        let changed = tc.events.named(names::REPO_CHANGED);
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0]["what"], serde_json::json!(["refs"]));

        // New branch from a tag; existing branch; detached on a commit or tag.
        let old_path = sibling(&repo, "alt");
        let list = worktree_add(&tc, id.clone(), old_path.clone(), "von-v1".into(), true, Some("v1".into())).await.unwrap();
        assert_eq!(at(&list, &old_path).head.as_deref(), Some(first.as_str()));
        assert!(!Path::new(&old_path).join("a.txt").exists());
        repo.branch("vorhanden");
        let existing_path = sibling(&repo, "vorhanden");
        std::fs::create_dir_all(&existing_path).unwrap();
        let list = worktree_add(&tc, id.clone(), existing_path.clone(), "vorhanden".into(), false, Some("wird-ignoriert".into())).await.unwrap();
        assert_eq!(at(&list, &existing_path).branch.as_deref(), Some("vorhanden"));
        let detached_path = sibling(&repo, "losgelöst");
        let list = worktree_add(&tc, id.clone(), detached_path.clone(), first[..10].to_string(), false, None).await.unwrap();
        assert_eq!((at(&list, &detached_path).branch.as_deref(), at(&list, &detached_path).head.as_deref()), (None, Some(first.as_str())));
        assert_eq!(list.len(), 5);
        assert!(list[0].is_main);

        // Changes in a worktree: an untracked file counts.
        std::fs::write(Path::new(&feature_path).join("neu.txt"), "x").unwrap();
        let list = worktree_list(&tc, id.clone()).await.unwrap();
        assert!(at(&list, &feature_path).has_changes && !at(&list, &old_path).has_changes);

        // A worktree is opened like a repository; from there it is "the current one".
        let opened = crate::commands::repos::repo_open(&tc, feature_path.clone()).await.unwrap();
        assert!(same_path(Path::new(&opened.repo.path), Path::new(&feature_path)));
        let from_there = worktree_list(&tc, opened.repo.id.clone()).await.unwrap();
        assert_eq!(from_there.len(), 5);
        assert!(at(&from_there, &feature_path).is_current && !at(&from_there, &feature_path).is_main);
        assert!(from_there[0].is_main && !from_there[0].is_current);
        let status = crate::commands::status::read_status(&tc, &opened.repo.id).await.unwrap();
        assert_eq!(status.unstaged.len(), 1);
    }

    #[tokio::test]
    async fn add_rejects_bad_input() {
        let (tc, repo, id) = setup().await;
        repo.branch("frei");
        let taken = sibling(&repo, "belegt");
        std::fs::create_dir_all(&taken).unwrap();
        std::fs::write(Path::new(&taken).join("datei.txt"), "x").unwrap();
        let free = sibling(&repo, "frei");
        let add = |path: String, branch: &str, new_branch: bool, start: Option<&str>| {
            worktree_add(&tc, id.clone(), path, branch.to_string(), new_branch, start.map(str::to_string))
        };

        assert_eq!(code(add("relativ/pfad".into(), "x", true, None).await), ErrorCode::NotAllowed);
        assert_eq!(code(add("  ".into(), "x", true, None).await), ErrorCode::NotAllowed);
        assert_eq!(code(add(sibling(&repo, "gibt/es/nicht/tief"), "x", true, None).await), ErrorCode::PathNotFound);
        assert_eq!(code(add(taken.clone(), "x", true, None).await), ErrorCode::PathExists);
        assert_eq!(code(add(Path::new(&taken).join("datei.txt").to_string_lossy().into_owned(), "x", true, None).await), ErrorCode::PathExists);
        for bad in ["", "mit leer", "a..b", "-x"] {
            assert_eq!(code(add(free.clone(), bad, true, None).await), ErrorCode::InvalidName, "{bad:?}");
        }
        assert_eq!(code(add(free.clone(), "main", true, None).await), ErrorCode::NameExists);
        assert_eq!(code(add(free.clone(), "neu", true, Some("gibt-es-nicht")).await), ErrorCode::NotFound);
        assert_eq!(code(add(free.clone(), "gibt-es-nicht", false, None).await), ErrorCode::NotFound);
        assert_eq!(code(add(free.clone(), "", false, None).await), ErrorCode::NotFound);
        // `main` is checked out in the main worktree.
        let err = add(free.clone(), "main", false, None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
        assert!(err.message.contains("main") && err.message.contains("checked out"), "{}", err.message);
        // After all that, nothing has been created.
        assert!(!Path::new(&free).exists());
        assert_eq!(worktree_list(&tc, id.clone()).await.unwrap().len(), 1);
        assert_eq!(repo.git(&["branch", "--list", "neu", "x"]), "");
        assert_eq!(code(worktree_list(&tc, "unbekannt".into()).await), ErrorCode::NotFound);

        // Repository without a commit.
        let empty = TestRepo::new();
        let empty_id = tc.open(&empty).await.repo.id;
        assert_eq!(code(worktree_add(&tc, empty_id, sibling(&empty, "w"), "x".into(), true, None).await), ErrorCode::NotAllowed);
    }

    #[tokio::test]
    async fn remove_lock_unlock_and_prune() {
        let (tc, repo, id) = setup().await;
        let one = sibling(&repo, "eins");
        let two = sibling(&repo, "zwei");
        let three = sibling(&repo, "drei");
        for (path, branch) in [(&one, "b1"), (&two, "b2"), (&three, "b3")] {
            worktree_add(&tc, id.clone(), path.clone(), branch.into(), true, None).await.unwrap();
        }

        // Lock with a reason (multi-line becomes single-line), replace the reason, unlock.
        let list = worktree_lock(&tc, id.clone(), one.clone(), Some("liegt auf dem\nUSB-Stick für Jörg".into())).await.unwrap();
        assert_eq!((at(&list, &one).is_locked, at(&list, &one).lock_reason.as_deref()), (true, Some("liegt auf dem USB-Stick für Jörg")));
        let list = worktree_lock(&tc, id.clone(), one.clone(), None).await.unwrap();
        assert_eq!((at(&list, &one).is_locked, at(&list, &one).lock_reason.as_deref()), (true, None));
        assert_eq!(code(worktree_remove(&tc, id.clone(), one.clone(), true).await), ErrorCode::NotAllowed);
        assert!(Path::new(&one).exists());
        let list = worktree_unlock(&tc, id.clone(), one.clone()).await.unwrap();
        assert!(!at(&list, &one).is_locked);
        // Not locked: unlock changes nothing; the main worktree cannot be locked.
        worktree_unlock(&tc, id.clone(), one.clone()).await.unwrap();
        let main_path = repo.path().to_string_lossy().into_owned();
        assert_eq!(code(worktree_lock(&tc, id.clone(), main_path.clone(), None).await), ErrorCode::NotAllowed);
        assert_eq!(code(worktree_lock(&tc, id.clone(), sibling(&repo, "fremd"), None).await), ErrorCode::NotFound);

        // Removal: with changes only forced; the branch stays.
        std::fs::write(Path::new(&one).join("unverfolgt.txt"), "x").unwrap();
        let err = worktree_remove(&tc, id.clone(), one.clone(), false).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::DirtyWorktree);
        assert!(Path::new(&one).join("unverfolgt.txt").exists());
        tc.events.clear();
        let list = worktree_remove(&tc, id.clone(), one.clone(), true).await.unwrap();
        assert_eq!(list.len(), 3);
        assert!(!Path::new(&one).exists());
        assert_eq!(repo.git(&["branch", "--list", "b1"]).trim(), "b1");
        assert_eq!(tc.events.named(names::REPO_CHANGED)[0]["what"], serde_json::json!(["refs"]));
        let list = worktree_remove(&tc, id.clone(), two.clone(), false).await.unwrap();
        assert_eq!(list.len(), 2);

        // Main worktree, the one currently open, and unknown ones.
        assert_eq!(code(worktree_remove(&tc, id.clone(), main_path, true).await), ErrorCode::NotAllowed);
        assert_eq!(code(worktree_remove(&tc, id.clone(), two.clone(), false).await), ErrorCode::NotFound);
        let opened = crate::commands::repos::repo_open(&tc, three.clone()).await.unwrap();
        assert_eq!(code(worktree_remove(&tc, opened.repo.id.clone(), three.clone(), true).await), ErrorCode::NotAllowed);
        // From the main worktree it works, even if the worktree is open as a repository –
        // its repository list entry and its tab disappear along with it.
        tc.events.clear();
        let list = worktree_remove(&tc, id.clone(), three.clone(), false).await.unwrap();
        assert_eq!(list.len(), 1);
        assert!(!Path::new(&three).exists());
        let repos = crate::commands::repos::repo_list(&tc).await.unwrap();
        assert!(repos.iter().all(|r| r.id != opened.repo.id), "{repos:?}");
        let tabs = crate::commands::repos::tabs_list(&tc).await.unwrap();
        assert!(tabs.iter().all(|t| t.repo_id.as_deref() != Some(opened.repo.id.as_str())), "{tabs:?}");
        assert_eq!(tc.events.named(names::APP_CHANGED)[0]["what"], serde_json::json!(["tabs", "repos"]));

        // Pruning: the folder was deleted by hand.
        let gone = sibling(&repo, "verschwunden");
        let kept = sibling(&repo, "gesperrt-verschwunden");
        worktree_add(&tc, id.clone(), gone.clone(), "b4".into(), true, None).await.unwrap();
        worktree_add(&tc, id.clone(), kept.clone(), "b5".into(), true, None).await.unwrap();
        worktree_lock(&tc, id.clone(), kept.clone(), Some("bleibt".into())).await.unwrap();
        std::fs::remove_dir_all(&gone).unwrap();
        std::fs::remove_dir_all(&kept).unwrap();
        let list = worktree_list(&tc, id.clone()).await.unwrap();
        assert!(at(&list, &gone).is_prunable && !at(&list, &gone).has_changes);
        let list = worktree_prune(&tc, id.clone()).await.unwrap();
        assert_eq!(list.len(), 2, "{list:?}");
        assert!(at(&list, &kept).is_locked);
        // After unlocking, a vanished worktree can also be removed explicitly.
        worktree_unlock(&tc, id.clone(), kept.clone()).await.unwrap();
        let list = worktree_remove(&tc, id.clone(), kept, false).await.unwrap();
        assert_eq!(list.len(), 1);
    }
}
