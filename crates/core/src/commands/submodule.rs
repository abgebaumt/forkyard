//! Submodules: list, add, update, remove.
//!
//! The list comes from the index (entries with mode 160000), the `.gitmodules` (name, URL,
//! configured branch) and a `git status` of the repository, which says per submodule whether
//! a different commit is checked out or there are changes in it.
//!
//! Adding and updating go to the network: cancellable jobs with `job:progress` and
//! `job:done`. Removing means: `deinit`, `git rm` and deleting the Git directory under
//! `.git/modules/` – afterwards the removal is staged and wants to be committed.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::app::Core;
use crate::commands::history::{is_inside_git_dir, normalize_rel_path};
use crate::commands::{remotes, status};
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::GitCmd;
use crate::jobs::Job;
use crate::model::{RepoChange, Submodule, SubmoduleState};
use crate::util;

const GITLINK_MODE: &[u8] = b"160000";
const LITERAL: &str = "GIT_LITERAL_PATHSPECS";

fn read(core: &Core, repo_id: &str) -> CoreResult<GitCmd> {
    Ok(core.git_for(repo_id)?.read_only().no_log())
}

/// An entry of the `.gitmodules`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Declared {
    name: String,
    path: Option<String>,
    url: Option<String>,
    branch: Option<String>,
}

/// Parses `git config -z --file .gitmodules --list`: `submodule.<name>.<key>\n<value>\0`.
/// The name may contain dots; the key is the last piece.
fn parse_gitmodules(stdout: &[u8]) -> Vec<Declared> {
    let mut out: Vec<Declared> = Vec::new();
    for entry in util::split_z(stdout) {
        let text = util::decode_lossy(entry);
        let (key, value) = text.split_once('\n').unwrap_or((text.as_str(), ""));
        let Some(rest) = key.strip_prefix("submodule.") else { continue };
        let Some((name, field)) = rest.rsplit_once('.') else { continue };
        let position = match out.iter().position(|d| d.name == name) {
            Some(position) => position,
            None => {
                out.push(Declared { name: name.to_string(), ..Declared::default() });
                out.len() - 1
            }
        };
        let declared = &mut out[position];
        match field.to_ascii_lowercase().as_str() {
            "path" => declared.path = Some(value.to_string()),
            "url" => declared.url = Some(value.to_string()),
            "branch" => declared.branch = Some(value.to_string()),
            _ => {}
        }
    }
    out
}

async fn declared(core: &Core, repo_id: &str) -> CoreResult<Vec<Declared>> {
    let root = core.repo_path(repo_id)?;
    if !root.join(".gitmodules").is_file() {
        return Ok(Vec::new());
    }
    let out = read(core, repo_id)?.args(["config", "-z", "--file", ".gitmodules", "--list"]).run_raw().await?;
    Ok(if out.success() { parse_gitmodules(&out.stdout) } else { Vec::new() })
}

/// Submodule entries in the index: (path, recorded commit, in conflict).
async fn gitlinks(core: &Core, repo_id: &str) -> CoreResult<Vec<(Vec<u8>, String, bool)>> {
    let out = read(core, repo_id)?.args(["ls-files", "--stage", "-z"]).run().await?;
    let mut links: Vec<(Vec<u8>, String, bool)> = Vec::new();
    for record in util::split_z(&out.stdout) {
        // `<mode> <object> <stage>TAB<path>`
        if !record.starts_with(GITLINK_MODE) {
            continue;
        }
        let Some(tab) = record.iter().position(|&b| b == b'\t') else { continue };
        let meta = util::decode_lossy(&record[..tab]);
        let mut fields = meta.split(' ');
        let (Some(_), Some(sha), Some(stage)) = (fields.next(), fields.next(), fields.next()) else { continue };
        let path = record[tab + 1..].to_vec();
        match links.iter_mut().find(|(known, _, _)| *known == path) {
            // Several stages: a conflict; "our" version (stage 2) counts, otherwise the first.
            Some(existing) => {
                existing.2 = true;
                if stage == "2" {
                    existing.1 = sha.to_string();
                }
            }
            None => links.push((path, sha.to_string(), stage != "0")),
        }
    }
    Ok(links)
}

/// What `git status` says about a submodule (field `S<c><m><u>`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct SubFlags {
    commit_changed: bool,
    modified: bool,
    untracked: bool,
}

/// Reads the submodule data per path from `git status --porcelain=v2 -z`.
fn parse_sub_flags(stdout: &[u8]) -> HashMap<Vec<u8>, SubFlags> {
    let mut out = HashMap::new();
    let mut records = util::split_z(stdout);
    while let Some(record) = records.next() {
        let (kind, fields_before_path) = match record.first() {
            Some(b'1') => (b'1', 8),
            Some(b'2') => (b'2', 9),
            Some(b'u') => (b'u', 10),
            _ => continue,
        };
        if kind == b'2' {
            // For renames the old path follows as a record of its own.
            records.next();
        }
        let mut parts = record.splitn(fields_before_path + 1, |&b| b == b' ');
        let sub = parts.nth(2).unwrap_or_default();
        let Some(path) = parts.nth(fields_before_path - 3) else { continue };
        if sub.first() != Some(&b'S') || sub.len() < 4 {
            continue;
        }
        out.insert(path.to_vec(), SubFlags { commit_changed: sub[1] == b'C', modified: sub[2] == b'M', untracked: sub[3] == b'U' });
    }
    out
}

/// Git directory of a checked-out submodule (`<path>/.git` is usually a file that
/// points to `.git/modules/<name>`). `None`: not initialised.
fn sub_git_dir(sub_root: &Path) -> Option<PathBuf> {
    let dot_git = sub_root.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git);
    }
    let content = std::fs::read(&dot_git).ok()?;
    let target = content.strip_prefix(b"gitdir:")?;
    let target = util::bytes_to_path(target.trim_ascii());
    let resolved = if target.is_absolute() { target } else { sub_root.join(target) };
    resolved.is_dir().then_some(resolved)
}

/// HEAD of a submodule from its HEAD file: (branch, SHA if detached).
fn read_sub_head(git_dir: &Path) -> (Option<String>, Option<String>) {
    let Ok(text) = std::fs::read_to_string(git_dir.join("HEAD")) else { return (None, None) };
    let text = text.trim();
    match text.strip_prefix("ref:") {
        Some(reference) => {
            let reference = reference.trim();
            (Some(reference.strip_prefix("refs/heads/").unwrap_or(reference).to_string()), None)
        }
        None => (None, (text.len() >= 40 && text.bytes().all(|b| b.is_ascii_hexdigit())).then(|| text.to_string())),
    }
}

async fn list(core: &Core, repo_id: &str) -> CoreResult<Vec<Submodule>> {
    let root = core.repo_path(repo_id)?;
    let links = gitlinks(core, repo_id).await?;
    if links.is_empty() {
        return Ok(Vec::new());
    }
    let declared = declared(core, repo_id).await?;
    let flags = {
        let out = read(core, repo_id)?.args(["status", "--porcelain=v2", "-z", "--untracked-files=no", "--ignore-submodules=none"]).run().await?;
        parse_sub_flags(&out.stdout)
    };
    let mut out = Vec::with_capacity(links.len());
    for (raw_path, sha, conflicted) in links {
        let path = util::decode_lossy(&raw_path);
        let entry = declared.iter().find(|d| d.path.as_deref() == Some(path.as_str()));
        let sub_root = util::join_from_git(&root, &raw_path);
        let git_dir = sub_git_dir(&sub_root);
        let (branch, mut head_sha) = git_dir.as_deref().map(read_sub_head).unwrap_or((None, None));
        let sub = flags.get(&raw_path).copied().unwrap_or_default();
        let state = if git_dir.is_none() {
            SubmoduleState::Uninitialized
        } else if sub.commit_changed || conflicted {
            SubmoduleState::OutOfSync
        } else if sub.modified || sub.untracked {
            SubmoduleState::Modified
        } else {
            SubmoduleState::Initialized
        };
        if git_dir.is_some() && head_sha.is_none() {
            head_sha = if state == SubmoduleState::OutOfSync || branch.is_some() {
                // On a branch (or when in doubt): ask Git.
                let asked = core.git.cmd(&sub_root).repo(repo_id).read_only().no_log().args(["rev-parse", "--verify", "--quiet", "HEAD"]).run_raw().await;
                asked.ok().filter(|o| o.success()).map(|o| o.stdout_text()).filter(|s| !s.is_empty())
            } else {
                Some(sha.clone())
            };
        }
        out.push(Submodule {
            name: entry.map_or_else(|| path.clone(), |d| d.name.clone()),
            path,
            url: entry.and_then(|d| d.url.clone()).map(|url| remotes::display_url(&url)),
            sha,
            head_sha,
            state,
            branch,
            tracking_branch: entry.and_then(|d| d.branch.clone()),
        });
    }
    Ok(out)
}

/// The repository's submodules, in index order (by path).
pub async fn submodule_list(core: &Core, repo_id: String) -> CoreResult<Vec<Submodule>> {
    list(core, &repo_id).await
}

/// Errors from `git submodule`, with more precise sentences for what is typical here.
fn submodule_error(error: CoreError) -> CoreError {
    let text = error.git_output.clone().unwrap_or_default().to_lowercase();
    if text.contains("transport 'file' not allowed") {
        let mut better = CoreError::not_allowed(
            "Git only allows submodules from local paths if “protocol.file.allow” is set to “always” (protection against manipulated repositories).",
        );
        better.git_output = error.git_output;
        return better;
    }
    if text.contains("a git directory for") && text.contains("is found locally") {
        let mut better = CoreError::path_exists("The Git directory");
        better.message = "A Git directory from an earlier submodule at this path is still in .git/modules. Forkyard leaves it untouched because it may contain unpushed commits. Choose a different path, or remove the folder under .git/modules by hand if you no longer need it.".to_string();
        better.git_output = error.git_output;
        return better;
    }
    if text.contains("already exists in the index") {
        let mut better = CoreError::path_exists("The path");
        better.message = "Something already exists at this path in the repository.".to_string();
        better.git_output = error.git_output;
        return better;
    }
    error
}

/// Adds a submodule (`git submodule add`): clones `url` to `path` and records it in
/// `.gitmodules` and the index. Job with progress, cancellable. Afterwards it is staged.
///
/// Errors: `not_allowed` (invalid URL; path outside or in `.git`; local URL without
/// `protocol.file.allow`), `path_exists` (something already exists at the path), plus the
/// network errors (`offline`, `auth_failed`, `not_found`, `timeout`, `cancelled`). After a
/// failure or cancellation nothing half-cloned is left behind.
pub async fn submodule_add(core: &Core, repo_id: String, job_id: String, url: String, path: String) -> CoreResult<Vec<Submodule>> {
    core.repo_path(&repo_id)?;
    let job = core.start_job(&job_id, Some(&repo_id))?;
    let result = add_job(core, &repo_id, &job, url.trim(), &path).await;
    job.finish(&result);
    result
}

async fn add_job(core: &Core, repo_id: &str, job: &Job, url: &str, path: &str) -> CoreResult<Vec<Submodule>> {
    remotes::check_url(url)?;
    let rel = normalize_rel_path(path)?;
    if is_inside_git_dir(&rel) {
        return Err(CoreError::not_allowed("A submodule can't be inside the Git directory (.git)."));
    }
    let root = core.repo_path(repo_id)?;
    let target = root.join(util::bytes_to_path(rel.as_bytes()));
    let existed = target.symlink_metadata().is_ok();
    // The topmost directory on the way to the target that does not exist yet: after a failure
    // it disappears again, together with everything Git created below it.
    let created_root = {
        let mut top = target.clone();
        while let Some(parent) = top.parent() {
            if parent == root || parent.exists() {
                break;
            }
            top = parent.to_path_buf();
        }
        top
    };
    if existed {
        let empty_dir = target.is_dir() && std::fs::read_dir(&target).map(|mut entries| entries.next().is_none()).unwrap_or(false);
        if !empty_dir {
            return Err(CoreError::path_exists(util::display_path(&target)));
        }
    }
    let known = !read(core, repo_id)?.env(LITERAL, "1").args(["ls-files", "-z", "--"]).arg(&rel).run().await?.stdout.is_empty();
    if known {
        return Err(CoreError::path_exists(&rel));
    }
    let _network = tokio::select! {
        guard = core.network_lock(repo_id) => guard,
        _ = job.token().cancelled() => return Err(CoreError::cancelled()),
    };
    let changes = [RepoChange::Worktree, RepoChange::Index, RepoChange::Config];
    core.with_write_lock(repo_id, &changes, async {
        job.token().check()?;
        let git_dir = status::git_dir(core, repo_id).await?;
        let gitmodules = root.join(".gitmodules");
        let before = std::fs::read(&gitmodules).ok();
        // If a Git directory of this name already existed under .git/modules (Git deliberately leaves it
        // behind when removing a submodule), it does not belong to this attempt:
        // it may contain commits that were never pushed.
        let module_existed = util::join_from_git(&git_dir.join("modules"), rel.as_bytes()).exists();
        let added = core
            .git_for(repo_id)?
            .args(["submodule", "add", "--progress", "--"])
            .arg(url)
            .arg(&rel)
            .network()
            .run_stream(job.token(), &mut |line| job.progress_line(line))
            .await;
        if let Err(error) = added {
            // Clean up: half-cloned directory, Git directory of the submodule, .gitmodules.
            let staged = !read(core, repo_id)?.env(LITERAL, "1").args(["ls-files", "-z", "--"]).arg(&rel).run().await.map(|o| o.stdout.is_empty()).unwrap_or(true);
            if !staged {
                if existed {
                    // The (empty) directory already existed: only remove its content.
                    remove_dir_writable(&target);
                    let _ = std::fs::create_dir_all(&target);
                } else {
                    remove_dir_writable(&created_root);
                }
                if !module_existed {
                    remove_module_dir(&git_dir, &rel);
                }
                match &before {
                    Some(content) => {
                        let _ = std::fs::write(&gitmodules, content);
                    }
                    None => {
                        let _ = std::fs::remove_file(&gitmodules);
                    }
                }
                let _ = core.git_for(repo_id)?.no_log().args(["config", "--remove-section", &format!("submodule.{rel}")]).run_raw().await;
            }
            return Err(submodule_error(error));
        }
        list(core, repo_id).await
    })
    .await
}

/// Deletes the Git directory of a submodule (`.git/modules/<name>`) and the directories above it
/// that have become empty as a result (for names like `libs/werkzeug`).
fn remove_module_dir(git_dir: &Path, name: &str) {
    let modules = git_dir.join("modules");
    let dir = util::join_from_git(&modules, name.as_bytes());
    remove_dir_writable(&dir);
    let mut parent = dir.parent();
    while let Some(current) = parent {
        if current == modules || std::fs::remove_dir(current).is_err() {
            break;
        }
        parent = current.parent();
    }
}

/// Deletes a directory including read-only files (Git objects are read-only on Windows).
fn remove_dir_writable(dir: &Path) {
    if !dir.exists() {
        return;
    }
    if std::fs::remove_dir_all(dir).is_ok() {
        return;
    }
    fn make_writable(dir: &Path) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                make_writable(&path);
            } else if meta.permissions().readonly() {
                let mut permissions = meta.permissions();
                #[allow(clippy::permissions_set_readonly_false)]
                permissions.set_readonly(false);
                let _ = std::fs::set_permissions(&path, permissions);
            }
        }
    }
    make_writable(dir);
    if let Err(e) = std::fs::remove_dir_all(dir) {
        log::warn!("Directory {} not removed: {e}", util::display_path(dir));
    }
}

/// Fetches and checks out the recorded commits (`git submodule update --recursive`), for
/// all (`paths: None`) or the named submodules; `init` first initialises those not yet
/// initialised. Job with progress, cancellable.
///
/// Errors: `not_found` (no submodule at one of the paths), `dirty_worktree` (local
/// changes in the submodule are in the way), plus the network errors.
pub async fn submodule_update(core: &Core, repo_id: String, job_id: String, paths: Option<Vec<String>>, init: bool) -> CoreResult<Vec<Submodule>> {
    core.repo_path(&repo_id)?;
    let job = core.start_job(&job_id, Some(&repo_id))?;
    let result = update_job(core, &repo_id, &job, paths, init).await;
    job.finish(&result);
    result
}

async fn update_job(core: &Core, repo_id: &str, job: &Job, paths: Option<Vec<String>>, init: bool) -> CoreResult<Vec<Submodule>> {
    let known = list(core, repo_id).await?;
    let mut wanted: Vec<String> = Vec::new();
    if let Some(paths) = paths {
        for path in paths {
            let rel = normalize_rel_path(&path)?;
            if !known.iter().any(|s| s.path == rel) {
                return Err(CoreError::not_found(format!("There is no submodule at “{rel}”.")));
            }
            if !wanted.contains(&rel) {
                wanted.push(rel);
            }
        }
        if wanted.is_empty() {
            return Ok(known);
        }
    }
    if known.is_empty() {
        return Ok(known);
    }
    let _network = tokio::select! {
        guard = core.network_lock(repo_id) => guard,
        _ = job.token().cancelled() => return Err(CoreError::cancelled()),
    };
    let mut cmd = core.git_for(repo_id)?.env(LITERAL, "1").args(["submodule", "update", "--progress", "--recursive"]);
    if init {
        cmd = cmd.arg("--init");
    }
    cmd = cmd.arg("--").args(&wanted);
    let updated = cmd.network().run_stream(job.token(), &mut |line| job.progress_line(line)).await;
    // Even after an error midway, part of it may already be checked out.
    core.emit_repo_changed(repo_id, &[RepoChange::Worktree, RepoChange::Config]);
    if let Err(error) = updated {
        let text = error.git_output.clone().unwrap_or_default().to_lowercase();
        if text.contains("would be overwritten by checkout") || text.contains("unable to checkout") {
            let mut dirty = CoreError::new(
                ErrorCode::DirtyWorktree,
                "Local changes in a submodule are in the way. Commit, stash or discard them there first.",
            );
            dirty.git_output = error.git_output;
            return Err(dirty);
        }
        return Err(submodule_error(error));
    }
    list(core, repo_id).await
}

/// Number of commits in the submodule that hang off a local ref (branch, tag, stash, HEAD) but off
/// no remote branch. 0 if the submodule is not initialised or cannot be read.
async fn unpushed_commits(core: &Core, repo_id: &str, sub_root: &Path) -> usize {
    if sub_git_dir(sub_root).is_none() {
        return 0;
    }
    let counted = core
        .git
        .cmd(sub_root)
        .repo(repo_id)
        .read_only()
        .no_log()
        .args(["rev-list", "--count", "HEAD", "--branches", "--tags", "--glob=refs/stash", "--not", "--remotes"])
        .run_raw()
        .await;
    counted.ok().filter(|out| out.success()).and_then(|out| out.stdout_text().trim().parse().ok()).unwrap_or(0)
}

/// Removes a submodule: `git submodule deinit`, `git rm` (entry in the index and
/// `.gitmodules`, directory) and the Git directory under `.git/modules/`. The removal is
/// staged afterwards and wants to be committed.
///
/// If the submodule has changes of its own (`modified`) or a different commit checked out
/// (`out_of_sync`), or contains commits that hang off no remote branch, it needs
/// `force` – otherwise `dirty_worktree`: local work in it would be gone afterwards.
pub async fn submodule_remove(core: &Core, repo_id: String, path: String, force: Option<bool>) -> CoreResult<Vec<Submodule>> {
    let repo_id = repo_id.as_str();
    let rel = normalize_rel_path(&path)?;
    let force = force.unwrap_or(false);
    let changes = [RepoChange::Worktree, RepoChange::Index, RepoChange::Config];
    core.with_write_lock(repo_id, &changes, async {
        let known = list(core, repo_id).await?;
        let Some(sub) = known.iter().find(|s| s.path == rel) else {
            return Err(CoreError::not_found(format!("There is no submodule at “{rel}”.")));
        };
        if !force && matches!(sub.state, SubmoduleState::Modified | SubmoduleState::OutOfSync) {
            return Err(CoreError::new(
                ErrorCode::DirtyWorktree,
                format!("The submodule “{rel}” has its own changes or a different commit checked out. Removing it would lose that."),
            ));
        }
        if !force {
            // Commits that only exist in the submodule: they would be gone with the Git directory.
            let sub_root = util::join_from_git(&core.repo_path(repo_id)?, rel.as_bytes());
            let unpushed = unpushed_commits(core, repo_id, &sub_root).await;
            if unpushed > 0 {
                let what = if unpushed == 1 { "has 1 commit that is not pushed".to_string() } else { format!("has {unpushed} commits that are not pushed") };
                return Err(CoreError::new(
                    ErrorCode::DirtyWorktree,
                    format!("The submodule “{rel}” {what} (on no remote branch). Removing it would lose them."),
                ));
            }
        }
        let name = sub.name.clone();
        let git_dir = status::git_dir(core, repo_id).await?;
        let git = || -> CoreResult<GitCmd> { Ok(core.git_for(repo_id)?.env(LITERAL, "1")) };
        // deinit does not fail for an uninitialised submodule; `-f` also takes local changes.
        git()?.args(["submodule", "deinit", "-f", "--"]).arg(&rel).run().await?;
        git()?.args(["rm", "-f", "-q", "--"]).arg(&rel).run().await?;
        remove_module_dir(&git_dir, &name);
        // Leftovers in the local configuration (deinit usually removes them already).
        let _ = core.git_for(repo_id)?.no_log().args(["config", "--remove-section", &format!("submodule.{name}")]).run_raw().await;
        let root = core.repo_path(repo_id)?;
        let leftover = root.join(util::bytes_to_path(rel.as_bytes()));
        if leftover.is_dir() {
            remove_dir_writable(&leftover);
        }
        list(core, repo_id).await
    })
    .await
}

/// Moves a submodule to `new_path` (`git mv`; Git updates `.gitmodules` and the submodule's
/// gitfile). The move is staged afterwards. The target must not exist yet; missing parent folders
/// are created.
///
/// Errors: `not_found` (no submodule at `path`), `path_exists` (target exists), `not_allowed`
/// (path outside the repository or in `.git`, target inside the submodule itself).
pub async fn submodule_move(core: &Core, repo_id: String, path: String, new_path: String) -> CoreResult<Vec<Submodule>> {
    let repo_id = repo_id.as_str();
    let rel = normalize_rel_path(&path)?;
    let target = normalize_rel_path(&new_path)?;
    if is_inside_git_dir(&target) {
        return Err(CoreError::not_allowed(format!("“{target}” is inside the Git directory.")));
    }
    if target == rel {
        return list(core, repo_id).await;
    }
    if target.starts_with(&format!("{rel}/")) {
        return Err(CoreError::not_allowed("A submodule can't be moved into itself."));
    }
    let changes = [RepoChange::Worktree, RepoChange::Index, RepoChange::Config];
    core.with_write_lock(repo_id, &changes, async {
        let known = list(core, repo_id).await?;
        if !known.iter().any(|s| s.path == rel) {
            return Err(CoreError::not_found(format!("There is no submodule at “{rel}”.")));
        }
        let root = core.repo_path(repo_id)?;
        let destination = util::join_from_git(&root, target.as_bytes());
        if std::fs::symlink_metadata(&destination).is_ok() {
            return Err(CoreError::path_exists(&target));
        }
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)?;
        }
        core.git_for(repo_id)?.env(LITERAL, "1").args(["mv", "--"]).arg(&rel).arg(&target).run().await?;
        list(core, repo_id).await
    })
    .await
}

#[cfg(test)]
mod tests;
