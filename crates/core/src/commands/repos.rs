//! Repositories and tabs: open, list, alias/favourite, forget, README, tabs.

use std::path::{Path, PathBuf};

use crate::app::Core;
use crate::db;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::errors;
use crate::model::{AppChange, OpenedRepo, ProfileRef, Repo, Tab, TabKind};
use crate::util;
use crate::{autofetch, watcher};

/// Largest README read for the preview.
const README_MAX_BYTES: u64 = 1024 * 1024;

/// Determines the root directory of the repository `dir` is in. Hardened: the folder has not
/// been checked yet at this point.
pub async fn resolve_root(core: &Core, dir: &Path) -> CoreResult<PathBuf> {
    let shown = util::display_path(dir);
    let out = core.git_at(dir).args(["rev-parse", "--show-toplevel"]).read_only().guarded().run_raw().await?;
    if !out.success() {
        let err = errors::classify("rev-parse", out.code, &out.stdout, &out.stderr);
        // "Not a repository" is only correct if there really is none. A bare repository and a damaged
        // or unreadable repository are something else – and the advice to "create a new one there"
        // would be wrong in both cases (both used to be reported as "not a repository").
        let bare = core.git_at(dir).args(["rev-parse", "--is-bare-repository"]).read_only().guarded().no_log().run_raw().await;
        if bare.is_ok_and(|answer| answer.success() && answer.stdout_text() == "true") {
            return Err(CoreError::not_allowed(format!(
                "“{shown}” is a bare repository: a repository without a working directory, as found on servers. Forkyard needs a working directory. Clone it (“Clone …”, with this folder as the address) and open the clone."
            ))
            .with_git_output(err.git_output.clone().unwrap_or_default()));
        }
        let has_git_dir = std::fs::symlink_metadata(dir.join(".git")).is_ok();
        return Err(match err.code {
            ErrorCode::NotARepo | ErrorCode::Unknown if has_git_dir => CoreError::io(format!(
                "“{shown}” contains a Git directory (.git), but Git can't read it: it is damaged, or you lack read permission there. Check the folder's permissions; “git fsck” in a terminal shows whether the repository is damaged."
            ))
            .with_git_output(err.git_output.unwrap_or_default()),
            ErrorCode::NotARepo | ErrorCode::Unknown => {
                let mut e = CoreError::not_a_repo(&shown);
                e.git_output = err.git_output;
                e
            }
            _ => err,
        });
    }
    let raw = out.stdout.strip_suffix(b"\n").unwrap_or(&out.stdout);
    let raw = raw.strip_suffix(b"\r").unwrap_or(raw);
    if raw.is_empty() {
        return Err(CoreError::not_a_repo(&shown));
    }
    Ok(util::native_path(&util::bytes_to_path(raw)))
}

/// Starts file watching and auto-fetch for a repository with an open tab – not for one the user
/// has not agreed to yet (nothing runs on its own there).
pub fn start_background(core: &Core, repo_id: &str) {
    if !core.repo_row(repo_id).is_ok_and(|row| row.trusted) {
        return;
    }
    if let Err(e) = watcher::start_watching(core, repo_id) {
        log::warn!("File watching for {repo_id} not started: {}", e.message);
    }
    if let Err(e) = autofetch::start(core, repo_id) {
        log::warn!("Auto-fetch for {repo_id} not started: {}", e.message);
    }
}

/// Stops both when the repository no longer has a tab in the active profile.
pub fn stop_background_if_closed(core: &Core, repo_id: &str) {
    let still_open = core
        .db
        .with(|c| {
            let profile_id = db::profiles::active_id(c)?;
            Ok(db::tabs::find_by_repo(c, &profile_id, repo_id)?.is_some())
        })
        .unwrap_or(false);
    if !still_open {
        let _ = watcher::stop_watching(core, repo_id);
        let _ = autofetch::stop(core, repo_id);
    }
}

/// Checks the folder (also a subfolder of a repository), registers the repository and opens a
/// tab. If it already has a tab, that one is activated. If the active tab is a management tab,
/// it becomes the repo tab (like a "new tab" page in the browser).
///
/// A repository that is new to the list is checked in the process (`trust::settle_on_open`):
/// if it brings its own commands, it comes back with `trusted: false` and stays locked until the
/// user agrees (`repo_trust_set`).
///
/// If only another profile lists the repository, `repo_other_profile` is returned (see `repo_open_with`).
pub async fn repo_open(core: &Core, path: String) -> CoreResult<OpenedRepo> {
    repo_open_with(core, path, false).await
}

/// Like `repo_open`; with `add_to_profile` a repository that only other profiles list is also
/// added to the active one instead of reporting `repo_other_profile`.
pub async fn repo_open_with(core: &Core, path: String, add_to_profile: bool) -> CoreResult<OpenedRepo> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(CoreError::path_not_found(""));
    }
    let input = PathBuf::from(trimmed);
    if !input.exists() {
        return Err(CoreError::path_not_found(trimmed));
    }
    if !input.is_dir() {
        return Err(CoreError::not_a_repo(trimmed));
    }
    let root = resolve_root(core, &input).await?;
    let opened = core.db.tx(|tx| {
        let profile_id = db::profiles::active_id(tx)?;
        let row = db::repos::upsert(tx, &root)?;
        if !add_to_profile && !db::profile_repos::contains(tx, &profile_id, &row.id)? {
            let owners = db::profile_repos::profiles_of(tx, &row.id)?;
            if !owners.is_empty() {
                // The error rolls back the transaction: `upsert` has no effect either.
                let names = owners.iter().filter_map(|id| db::profiles::get(tx, id).ok().flatten()).map(|p| p.name).collect::<Vec<_>>();
                return Err(CoreError::repo_other_profile(&names));
            }
        }
        db::repos::touch_opened(tx, &row.id)?;
        let tab_id = match db::tabs::find_by_repo(tx, &profile_id, &row.id)? {
            Some(tab) => tab.id,
            None => {
                let active = db::tabs::list(tx, &profile_id)?.into_iter().find(|t| t.is_active);
                match active {
                    Some(t) if t.kind == TabKind::Management => {
                        db::tabs::set_repo(tx, &t.id, &row.id)?;
                        t.id
                    }
                    _ => db::tabs::append(tx, &profile_id, TabKind::Repo, Some(&row.id))?,
                }
            }
        };
        db::tabs::activate(tx, &profile_id, &tab_id)?;
        let repo = db::repos::require(tx, &row.id)?.to_model();
        let tab = db::tabs::require(tx, &profile_id, &tab_id)?;
        Ok(OpenedRepo { repo, tab, notice: None })
    })?;
    let mut opened = opened;
    // Before anything else: may Git work in this folder at all?
    opened.repo.trusted = crate::commands::trust::settle_on_open(core, &opened.repo.id, &root).await?;
    start_background(core, &opened.repo.id);
    core.emit_app_changed(&[AppChange::Tabs, AppChange::Repos]);
    Ok(opened)
}

/// The repositories of the active profile, most recently opened first; `missing` checked against the file system.
pub async fn repo_list(core: &Core) -> CoreResult<Vec<Repo>> {
    let rows = core.db.with(db::repos::list)?;
    Ok(rows.iter().map(|r| r.to_model()).collect())
}

/// The profiles other than the active one that list the repository at `path` (for the prompt on
/// `repo_other_profile`). An unknown folder yields an empty list.
pub async fn repo_profiles(core: &Core, path: String) -> CoreResult<Vec<ProfileRef>> {
    let input = PathBuf::from(path.trim());
    if !input.is_dir() {
        return Ok(Vec::new());
    }
    let root = resolve_root(core, &input).await?;
    core.db.with(|c| {
        let Some(row) = db::repos::find_by_path(c, &root)? else {
            return Ok(Vec::new());
        };
        let active = db::profiles::active_id(c)?;
        let mut owners = Vec::new();
        for id in db::profile_repos::profiles_of(c, &row.id)?.into_iter().filter(|id| *id != active) {
            if let Some(p) = db::profiles::get(c, &id)? {
                owners.push(ProfileRef { id: p.id, name: p.name, color: p.color });
            }
        }
        Ok(owners)
    })
}

/// Alias, favourite, group, colour. `None` = unchanged, `Some(None)` = clear.
pub async fn repo_update(
    core: &Core,
    repo_id: String,
    alias: Option<Option<String>>,
    is_favorite: Option<bool>,
    group_name: Option<Option<String>>,
    color: Option<Option<u8>>,
) -> CoreResult<Repo> {
    if let Some(Some(c)) = color {
        if !(1..=8).contains(&c) {
            return Err(CoreError::not_allowed("The color must be between 1 and 8."));
        }
    }
    let alias = alias.map(|a| util::non_empty(a.map(|s| s.trim().to_string())));
    let group_name = group_name.map(|g| util::non_empty(g.map(|s| s.trim().to_string())));
    let row = core.db.tx(|tx| {
        db::repos::require(tx, &repo_id)?;
        db::repos::update(tx, &repo_id, alias, is_favorite, group_name, color)
    })?;
    core.emit_app_changed(&[AppChange::Repos, AppChange::Tabs]);
    Ok(row.to_model())
}

/// Removes the repository from the active profile's list and closes its tabs there. If no profile
/// lists it any more, the entry is dropped too, including trust and view state. Deletes nothing
/// on disk.
pub async fn repo_forget(core: &Core, repo_id: String) -> CoreResult<()> {
    let gone = core.db.tx(|tx| {
        db::repos::require(tx, &repo_id)?;
        let profile_id = db::profiles::active_id(tx)?;
        db::profile_repos::remove(tx, &profile_id, &repo_id)?;
        db::tabs::close_repo(tx, &profile_id, &repo_id)?;
        db::workspaces::remove_repo(tx, &profile_id, &repo_id)?;
        let gone = db::profile_repos::profiles_of(tx, &repo_id)?.is_empty();
        if gone {
            db::repos::delete(tx, &repo_id)?;
        }
        db::tabs::ensure_consistent(tx, &profile_id)?;
        Ok(gone)
    })?;
    if gone {
        let _ = watcher::stop_watching(core, &repo_id);
        let _ = autofetch::stop(core, &repo_id);
    } else {
        stop_background_if_closed(core, &repo_id);
    }
    core.emit_app_changed(&[AppChange::Repos, AppChange::Tabs, AppChange::Workspaces]);
    Ok(())
}

/// README in the root directory for the preview; `None` if there is none.
pub async fn repo_readme(core: &Core, repo_id: String) -> CoreResult<Option<String>> {
    let root = core.repo_path(&repo_id)?;
    let preferred = ["readme.md", "readme.markdown", "readme.txt", "readme"];
    let mut found: Vec<(usize, PathBuf)> = Vec::new();
    let real_root = root.canonicalize()?;
    for entry in std::fs::read_dir(&root)?.flatten() {
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if let Some(rank) = preferred.iter().position(|p| *p == name) {
            // A link leading out of the repository is not read (as with `file_read`).
            let inside = entry.path().canonicalize().is_ok_and(|real| real.starts_with(&real_root));
            if inside && entry.path().is_file() {
                found.push((rank, entry.path()));
            }
        }
    }
    found.sort();
    let Some((_, path)) = found.into_iter().next() else {
        return Ok(None);
    };
    let size = std::fs::metadata(&path)?.len();
    let mut bytes = std::fs::read(&path)?;
    if size > README_MAX_BYTES {
        bytes.truncate(README_MAX_BYTES as usize);
    }
    if util::looks_binary(&bytes) {
        return Ok(None);
    }
    Ok(Some(util::decode_text(&bytes).0))
}

fn list_tabs(core: &Core) -> CoreResult<Vec<Tab>> {
    core.db.tx(|tx| {
        let profile_id = db::profiles::active_id(tx)?;
        db::tabs::ensure_consistent(tx, &profile_id)?;
        db::tabs::list(tx, &profile_id)
    })
}

/// Tabs of the active profile. There is always at least one (otherwise a management tab).
pub async fn tabs_list(core: &Core) -> CoreResult<Vec<Tab>> {
    list_tabs(core)
}

/// Opens a management tab (`repo_id: None`) or a repo tab; an existing tab of the same
/// repository is activated instead of duplicated.
pub async fn tab_open(core: &Core, repo_id: Option<String>) -> CoreResult<Vec<Tab>> {
    let tabs = core.db.tx(|tx| {
        let profile_id = db::profiles::active_id(tx)?;
        let tab_id = match &repo_id {
            None => db::tabs::append(tx, &profile_id, TabKind::Management, None)?,
            Some(id) => {
                db::repos::require(tx, id)?;
                db::repos::touch_opened(tx, id)?;
                match db::tabs::find_by_repo(tx, &profile_id, id)? {
                    Some(t) => t.id,
                    None => db::tabs::append(tx, &profile_id, TabKind::Repo, Some(id))?,
                }
            }
        };
        db::tabs::activate(tx, &profile_id, &tab_id)?;
        db::tabs::list(tx, &profile_id)
    })?;
    if let Some(id) = &repo_id {
        start_background(core, id);
        core.emit_app_changed(&[AppChange::Tabs, AppChange::Repos]);
    } else {
        core.emit_app_changed(&[AppChange::Tabs]);
    }
    Ok(tabs)
}

/// Closes a tab. If it was active, its right neighbour becomes active (otherwise the left one).
/// If the last tab is closed, a management tab remains.
pub async fn tab_close(core: &Core, tab_id: String) -> CoreResult<Vec<Tab>> {
    let (tabs, closed_repo) = core.db.tx(|tx| {
        let profile_id = db::profiles::active_id(tx)?;
        let tab = db::tabs::require(tx, &profile_id, &tab_id)?;
        let mut ids: Vec<String> = db::tabs::list(tx, &profile_id)?.into_iter().map(|t| t.id).collect();
        let index = ids.iter().position(|id| *id == tab_id).unwrap_or(0);
        ids.retain(|id| *id != tab_id);
        db::tabs::delete(tx, &profile_id, &tab_id)?;
        db::tabs::reorder(tx, &profile_id, &ids)?;
        if tab.is_active && !ids.is_empty() {
            let next = &ids[index.min(ids.len() - 1)];
            db::tabs::activate(tx, &profile_id, next)?;
        }
        db::tabs::ensure_consistent(tx, &profile_id)?;
        Ok((db::tabs::list(tx, &profile_id)?, tab.repo_id))
    })?;
    if let Some(repo_id) = closed_repo {
        stop_background_if_closed(core, &repo_id);
    }
    core.emit_app_changed(&[AppChange::Tabs]);
    Ok(tabs)
}

/// Moves a tab to `position` (0 = far left; too large = far right).
pub async fn tab_move(core: &Core, tab_id: String, position: i64) -> CoreResult<Vec<Tab>> {
    let tabs = core.db.tx(|tx| {
        let profile_id = db::profiles::active_id(tx)?;
        db::tabs::require(tx, &profile_id, &tab_id)?;
        let mut ids: Vec<String> = db::tabs::list(tx, &profile_id)?.into_iter().map(|t| t.id).collect();
        ids.retain(|id| *id != tab_id);
        let target = (position.max(0) as usize).min(ids.len());
        ids.insert(target, tab_id.clone());
        db::tabs::reorder(tx, &profile_id, &ids)?;
        db::tabs::list(tx, &profile_id)
    })?;
    core.emit_app_changed(&[AppChange::Tabs]);
    Ok(tabs)
}

pub async fn tab_activate(core: &Core, tab_id: String) -> CoreResult<Vec<Tab>> {
    let (tabs, repo_id) = core.db.tx(|tx| {
        let profile_id = db::profiles::active_id(tx)?;
        let tab = db::tabs::require(tx, &profile_id, &tab_id)?;
        db::tabs::activate(tx, &profile_id, &tab_id)?;
        if let Some(id) = &tab.repo_id {
            db::repos::touch_opened(tx, id)?;
        }
        Ok((db::tabs::list(tx, &profile_id)?, tab.repo_id))
    })?;
    if repo_id.is_some() {
        core.emit_app_changed(&[AppChange::Tabs, AppChange::Repos]);
    } else {
        core.emit_app_changed(&[AppChange::Tabs]);
    }
    Ok(tabs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::names;
    use crate::testkit::{TestCore, TestRepo};

    fn key(p: &str) -> String {
        util::path_key(Path::new(p))
    }

    async fn second_profile(tc: &TestCore) -> String {
        let list = crate::commands::settings::profile_save(tc, None, "Arbeit".into(), "".into(), "".into(), false, None).await.unwrap();
        list.iter().find(|p| p.name == "Arbeit").unwrap().id.clone()
    }

    fn path_of(repo: &TestRepo) -> String {
        repo.path().to_string_lossy().into_owned()
    }

    #[tokio::test]
    async fn each_profile_has_its_own_repo_list() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        tc.open(&repo).await;
        let work = second_profile(&tc).await;
        crate::commands::settings::profile_activate(&tc, work).await.unwrap();
        assert!(repo_list(&tc).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn opening_a_repo_of_another_profile_asks_first() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        tc.open(&repo).await;
        let first = tc.active_profile_id().unwrap();
        let work = second_profile(&tc).await;
        crate::commands::settings::profile_activate(&tc, work).await.unwrap();

        let err = repo_open(&tc, path_of(&repo)).await.unwrap_err();
        assert_eq!(err.code, crate::error::ErrorCode::RepoOtherProfile);
        assert!(err.message.contains("Default"), "names the profile: {}", err.message);
        assert!(repo_list(&tc).await.unwrap().is_empty(), "nothing registered");
        let owners = repo_profiles(&tc, path_of(&repo)).await.unwrap();
        assert_eq!(owners.iter().map(|p| p.id.clone()).collect::<Vec<_>>(), vec![first]);

        let opened = repo_open_with(&tc, path_of(&repo), true).await.unwrap();
        assert!(opened.repo.trusted, "trust applies to all profiles");
        assert_eq!(repo_list(&tc).await.unwrap().len(), 1);
        // Afterwards it belongs to both; opening it again no longer asks.
        repo_open(&tc, path_of(&repo)).await.unwrap();
        assert!(repo_profiles(&tc, path_of(&repo)).await.unwrap().len() == 1, "without the active profile");
    }

    #[tokio::test]
    async fn a_new_folder_opens_without_asking() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        second_profile(&tc).await;
        repo_open(&tc, path_of(&repo)).await.unwrap();
        assert!(repo_profiles(&tc, path_of(&repo)).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn forget_removes_only_from_active_profile() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let id = tc.open(&repo).await.repo.id;
        let first = tc.active_profile_id().unwrap();
        let work = second_profile(&tc).await;
        crate::commands::settings::profile_activate(&tc, work).await.unwrap();
        repo_open_with(&tc, path_of(&repo), true).await.unwrap();
        repo_forget(&tc, id.clone()).await.unwrap();
        assert!(repo_list(&tc).await.unwrap().is_empty());
        crate::commands::settings::profile_activate(&tc, first).await.unwrap();
        let list = repo_list(&tc).await.unwrap();
        assert_eq!(list.len(), 1);
        assert!(list[0].trusted, "trust stays");
        // If the last profile forgets it too, the row is gone.
        repo_forget(&tc, id.clone()).await.unwrap();
        assert!(tc.db.with(|c| db::repos::get(c, &id)).unwrap().is_none());
    }

    #[tokio::test]
    async fn forgetting_removes_the_repo_from_the_workspaces_of_the_profile() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let id = tc.open(&repo).await.repo.id;
        let work = second_profile(&tc).await;
        crate::commands::settings::profile_activate(&tc, work).await.unwrap();
        repo_open_with(&tc, path_of(&repo), true).await.unwrap();
        crate::commands::workspace::workspace_save(&tc, None, "Kunden".into(), vec![id.clone()]).await.unwrap();
        repo_forget(&tc, id.clone()).await.unwrap();
        let workspaces = crate::commands::workspace::workspace_list(&tc).await.unwrap();
        assert!(workspaces[0].repo_ids.is_empty(), "{workspaces:?}");
    }

    #[tokio::test]
    async fn favorites_are_per_profile() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let id = tc.open(&repo).await.repo.id;
        repo_update(&tc, id.clone(), None, Some(true), Some(Some("Kunden".into())), None).await.unwrap();
        let work = second_profile(&tc).await;
        crate::commands::settings::profile_activate(&tc, work).await.unwrap();
        repo_open_with(&tc, path_of(&repo), true).await.unwrap();
        let listed = repo_list(&tc).await.unwrap();
        assert!(!listed[0].is_favorite);
        assert_eq!(listed[0].group_name, None);
    }

    #[tokio::test]
    async fn marking_a_repo_of_another_profile_does_not_add_it_here() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let id = tc.open(&repo).await.repo.id;
        let work = second_profile(&tc).await;
        crate::commands::settings::profile_activate(&tc, work).await.unwrap();
        assert!(repo_update(&tc, id.clone(), None, Some(true), None, None).await.is_err());
        assert!(repo_list(&tc).await.unwrap().is_empty(), "not registered as a side effect");
    }

    #[tokio::test]
    async fn opens_repo_and_converts_management_tab() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let before = tabs_list(&tc).await.unwrap();
        assert_eq!(before.len(), 1);
        assert_eq!(before[0].kind, TabKind::Management);

        let opened = tc.open(&repo).await;
        assert_eq!(key(&opened.repo.path), util::path_key(repo.path()));
        assert_eq!(opened.repo.name, "repo");
        assert!(!opened.repo.missing);
        assert!(opened.repo.last_opened_at.is_some());
        assert_eq!(opened.tab.kind, TabKind::Repo);
        assert_eq!(opened.tab.title, "repo");
        assert!(opened.tab.is_active);
        // The management tab became the repo tab.
        let tabs = tabs_list(&tc).await.unwrap();
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[0].id, before[0].id);
        let app_changed = tc.events.named(names::APP_CHANGED);
        assert!(!app_changed.is_empty());
        // The rev-parse call is in the log.
        assert!(tc.events.count(names::LOG_APPENDED) >= 1);
    }

    #[tokio::test]
    async fn open_from_subfolder_finds_root() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let sub = repo.subdir("a/b");
        let opened = repo_open(&tc, sub.to_string_lossy().into_owned()).await.unwrap();
        assert_eq!(key(&opened.repo.path), util::path_key(repo.path()));
    }

    #[tokio::test]
    async fn reopening_activates_existing_tab() {
        let tc = TestCore::new().await;
        let a = TestRepo::with_commit();
        let b = TestRepo::with_commit();
        let first = tc.open(&a).await;
        tc.open(&b).await;
        let again = tc.open(&a).await;
        assert_eq!(again.tab.id, first.tab.id);
        assert_eq!(again.repo.id, first.repo.id);
        let tabs = tabs_list(&tc).await.unwrap();
        assert_eq!(tabs.len(), 2);
        assert!(tabs.iter().find(|t| t.id == first.tab.id).unwrap().is_active);
        assert_eq!(repo_list(&tc).await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn not_a_repo_and_missing_path() {
        let tc = TestCore::new().await;
        let dir = tempfile::tempdir().unwrap();
        let err = repo_open(&tc, dir.path().to_string_lossy().into_owned()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotARepo);
        let err = repo_open(&tc, dir.path().join("gibt-es-nicht").to_string_lossy().into_owned()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::PathNotFound);
        let err = repo_open(&tc, "  ".into()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::PathNotFound);
        // There is no working directory inside .git.
        let repo = TestRepo::with_commit();
        let err = repo_open(&tc, repo.path().join(".git").to_string_lossy().into_owned()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotARepo);
        assert!(repo_list(&tc).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn empty_repo_without_commits_opens() {
        let tc = TestCore::new().await;
        let repo = TestRepo::new();
        let opened = tc.open(&repo).await;
        assert_eq!(opened.repo.name, "repo");
    }

    #[tokio::test]
    async fn list_marks_missing_and_update_forget() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let opened = tc.open(&repo).await;
        let id = opened.repo.id.clone();

        let updated = repo_update(&tc, id.clone(), Some(Some("  Mein Repo ".into())), Some(true), Some(Some("Arbeit".into())), Some(Some(3)))
            .await
            .unwrap();
        assert_eq!(updated.alias.as_deref(), Some("Mein Repo"));
        assert!(updated.is_favorite);
        assert_eq!(updated.group_name.as_deref(), Some("Arbeit"));
        assert_eq!(updated.color, Some(3));
        let tabs = tabs_list(&tc).await.unwrap();
        assert_eq!(tabs[0].title, "Mein Repo");

        // None leaves fields unchanged, Some(None) clears them.
        let updated = repo_update(&tc, id.clone(), Some(None), None, None, None).await.unwrap();
        assert_eq!(updated.alias, None);
        assert!(updated.is_favorite);
        assert_eq!(updated.color, Some(3));
        let err = repo_update(&tc, id.clone(), None, None, None, Some(Some(9))).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);

        std::fs::rename(repo.path().join(".git"), repo.path().join(".git-weg")).unwrap();
        let list = repo_list(&tc).await.unwrap();
        assert!(list[0].missing);

        repo_forget(&tc, id.clone()).await.unwrap();
        assert!(repo_list(&tc).await.unwrap().is_empty());
        let tabs = tabs_list(&tc).await.unwrap();
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[0].kind, TabKind::Management);
        assert!(tabs[0].is_active);
        let err = repo_forget(&tc, id).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn readme_preview() {
        let tc = TestCore::new().await;
        let repo = TestRepo::new();
        repo.commit_file("ReadMe.md", "# Hallo Wörld\n", "init");
        let opened = tc.open(&repo).await;
        assert_eq!(repo_readme(&tc, opened.repo.id.clone()).await.unwrap().as_deref(), Some("# Hallo Wörld\n"));
        repo.remove_file("ReadMe.md");
        assert_eq!(repo_readme(&tc, opened.repo.id.clone()).await.unwrap(), None);
        let err = repo_readme(&tc, "unbekannt".into()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn tab_open_close_move_activate() {
        let tc = TestCore::new().await;
        let a = TestRepo::with_commit();
        let b = TestRepo::with_commit();
        let ra = tc.open(&a).await;
        let rb = tc.open(&b).await;

        // Second management tab
        let tabs = tab_open(&tc, None).await.unwrap();
        assert_eq!(tabs.len(), 3);
        assert_eq!(tabs[2].kind, TabKind::Management);
        assert!(tabs[2].is_active);

        // tab_open for a repo with a tab activates that tab
        let tabs = tab_open(&tc, Some(ra.repo.id.clone())).await.unwrap();
        assert_eq!(tabs.len(), 3);
        assert!(tabs.iter().find(|t| t.id == ra.tab.id).unwrap().is_active);
        let err = tab_open(&tc, Some("unbekannt".into())).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);

        // Move: a to the end
        let tabs = tab_move(&tc, ra.tab.id.clone(), 99).await.unwrap();
        assert_eq!(tabs.last().unwrap().id, ra.tab.id);
        assert_eq!(tabs.iter().map(|t| t.position).collect::<Vec<_>>(), vec![0, 1, 2]);
        let tabs = tab_move(&tc, ra.tab.id.clone(), 0).await.unwrap();
        assert_eq!(tabs[0].id, ra.tab.id);

        // Activate
        let tabs = tab_activate(&tc, rb.tab.id.clone()).await.unwrap();
        assert_eq!(tabs.iter().filter(|t| t.is_active).count(), 1);
        assert!(tabs.iter().find(|t| t.id == rb.tab.id).unwrap().is_active);

        // Closing the active tab activates the right neighbour
        let order: Vec<String> = tabs.iter().map(|t| t.id.clone()).collect();
        let idx = order.iter().position(|id| *id == rb.tab.id).unwrap();
        let tabs = tab_close(&tc, rb.tab.id.clone()).await.unwrap();
        assert_eq!(tabs.len(), 2);
        let expected = if idx < order.len() - 1 { order[idx + 1].clone() } else { order[idx - 1].clone() };
        assert!(tabs.iter().find(|t| t.id == expected).unwrap().is_active);

        // Close all: a management tab remains
        for t in tabs {
            tab_close(&tc, t.id).await.unwrap();
        }
        let tabs = tabs_list(&tc).await.unwrap();
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[0].kind, TabKind::Management);
        assert!(tabs[0].is_active);
        let err = tab_close(&tc, "unbekannt".into()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn tabs_are_dropped_on_restart_without_remember_tabs() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        tc.open(&repo).await;
        crate::commands::settings::settings_set(&tc, serde_json::json!({"rememberTabs": false})).await.unwrap();
        let tc = tc.restart().await;
        let tabs = tabs_list(&tc).await.unwrap();
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[0].kind, TabKind::Management);
        assert!(tabs[0].is_active);
        // The repository stays in the list.
        assert_eq!(repo_list(&tc).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn tabs_survive_restart() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let opened = tc.open(&repo).await;
        let tc = tc.restart().await;
        let tabs = tabs_list(&tc).await.unwrap();
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[0].id, opened.tab.id);
        assert_eq!(tabs[0].repo_id.as_deref(), Some(opened.repo.id.as_str()));
    }
}
