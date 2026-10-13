//! Cloning and creating repositories.
//!
//! `repo_clone` runs as a job (progress, cancellable); a failed or cancelled clone leaves no
//! half-finished folder behind. `repo_init` creates a new repository with README, .gitignore
//! and license from the built-in templates.

mod templates;

use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::app::Core;
use crate::commands::remotes;
use crate::db;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::jobs::Job;
use crate::model::{CloneOptions, InitOptions, InitTemplates, OpenedRepo, TemplateOption};
use crate::util;

/// Message of the first commit of a newly created repository.
pub const INITIAL_COMMIT_MESSAGE: &str = "Initial commit";
/// Appears in the license when no name is known.
const UNKNOWN_HOLDER: &str = "<copyright holder>";

// ---------------------------------------------------------------------------
// Target folder
// ---------------------------------------------------------------------------

/// Checks a folder name for a new repository (`invalid_name`). The Windows rules apply
/// everywhere so that the name works on every system.
/// A single file or folder name must not be longer than this.
pub const MAX_NAME_LENGTH: usize = 255;
/// On Windows a path ends at 260 characters without special settings; below that a repository
/// still needs room for `.git/objects/…` and its files.
pub const MAX_REPO_PATH_LENGTH: usize = 240;

/// The path of the future repository must leave room for its content (Windows only).
pub fn check_repo_path_length(target: &Path) -> CoreResult<()> {
    let length = target.as_os_str().to_string_lossy().encode_utf16().count();
    if cfg!(windows) && length > MAX_REPO_PATH_LENGTH {
        return Err(CoreError::invalid_name(format!(
            "At {length} characters, the folder path would be too long: Windows allows about {MAX_REPO_PATH_LENGTH} at most for a repository. Choose a shorter name or a location with a shorter path."
        )));
    }
    Ok(())
}

pub fn check_folder_name(name: &str) -> CoreResult<()> {
    let invalid = |reason: &str| Err(CoreError::invalid_name(format!("Invalid folder name: {reason}")));
    if name.is_empty() {
        return invalid("The name must not be empty.");
    }
    if name == "." || name == ".." {
        return invalid("“.” and “..” are not folder names.");
    }
    if name.contains(['/', '\\']) {
        return invalid("The name must not contain a slash.");
    }
    if let Some(c) = name.chars().find(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*')) {
        return invalid(&format!("The character “{c}” is not allowed."));
    }
    if name.chars().any(|c| c.is_control()) {
        return invalid("Control characters are not allowed.");
    }
    if name.ends_with('.') || name.ends_with(' ') || name.starts_with(' ') {
        return invalid("The name must not start with a space or end with a period or space.");
    }
    // No common file system allows more than 255 characters per name.
    let length = name.encode_utf16().count();
    if length > MAX_NAME_LENGTH {
        return invalid(&format!("At {length} characters, the name is too long (at most {MAX_NAME_LENGTH})."));
    }
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    let reserved = matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.ends_with(|c: char| c.is_ascii_digit()));
    if reserved {
        return invalid("This name is reserved on Windows.");
    }
    Ok(())
}

/// Target `parent_path/name`: the parent folder must exist (`path_not_found`), the target may
/// at most be an empty folder (`path_exists`). Returns the target and whether it already existed.
fn target_dir(parent_path: &str, name: &str) -> CoreResult<(PathBuf, bool)> {
    check_folder_name(name)?;
    let parent = PathBuf::from(parent_path.trim());
    if parent_path.trim().is_empty() || !parent.is_absolute() || !parent.is_dir() {
        return Err(CoreError::path_not_found(parent_path.trim()));
    }
    let target = parent.join(name);
    check_repo_path_length(&target)?;
    let shown = util::display_path(&target);
    match std::fs::symlink_metadata(&target) {
        Err(_) => Ok((target, false)),
        Ok(meta) if meta.is_dir() => {
            if std::fs::read_dir(&target)?.next().is_some() {
                return Err(CoreError::new(
                    ErrorCode::PathExists,
                    format!("The folder “{shown}” already exists and is not empty."),
                ));
            }
            Ok((target, true))
        }
        Ok(_) => Err(CoreError::path_exists(shown)),
    }
}

/// Removes what a failed clone or a failed create left behind. If the folder existed before
/// (empty), it stays as an empty folder. On Windows, processes that just ended still hold on
/// to files briefly, hence the retries.
async fn remove_partial(target: &Path, existed: bool) {
    for attempt in 0..30 {
        let done = if existed { clear_dir(target) } else { std::fs::remove_dir_all(target).is_ok() || !target.exists() };
        if done {
            return;
        }
        if attempt > 0 {
            make_writable(target);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    log::warn!("Could not remove incomplete folder: {}", util::display_path(target));
}

fn clear_dir(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else { return !dir.exists() };
    let mut ok = true;
    for entry in entries.flatten() {
        let path = entry.path();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let removed = if is_dir { std::fs::remove_dir_all(&path) } else { std::fs::remove_file(&path) };
        ok &= removed.is_ok();
    }
    ok
}

/// On Unix, deleting does not need write permission on the file itself.
#[cfg(not(windows))]
fn make_writable(_dir: &Path) {}

/// Removes write protection (pack files are read-only on Windows).
#[cfg(windows)]
fn make_writable(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            make_writable(&path);
        } else if meta.permissions().readonly() {
            let mut perms = meta.permissions();
            #[allow(clippy::permissions_set_readonly_false)]
            perms.set_readonly(false);
            let _ = std::fs::set_permissions(&path, perms);
        }
    }
}

// ---------------------------------------------------------------------------
// Cloning
// ---------------------------------------------------------------------------

/// Paths for sparse checkout: forward slashes, without a leading `./` or `/`, without empties.
fn sparse_paths(options: &CloneOptions) -> CoreResult<Vec<String>> {
    let mut paths = Vec::new();
    for raw in &options.sparse_paths {
        let path = raw.trim().replace('\\', "/");
        let path = path.trim_start_matches("./").trim_matches('/').to_string();
        if path.is_empty() {
            continue;
        }
        if path.chars().any(|c| c.is_control()) || path.split('/').any(|part| part == "..") {
            return Err(CoreError::not_allowed(format!("Invalid path for sparse checkout: “{}”.", raw.trim())));
        }
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    Ok(paths)
}

/// Clones into `parent_path/name`. Progress via `job:progress` under `job_id`.
pub async fn repo_clone(core: &Core, job_id: String, url: String, parent_path: String, name: String, options: CloneOptions) -> CoreResult<OpenedRepo> {
    let job = core.start_job(&job_id, None)?;
    let result = clone_job(core, &job, url.trim(), &parent_path, name.trim(), &options).await;
    job.finish(&result);
    result
}

/// Value for `--shallow-since`. A plain date (`2026-02-01`) means the whole day from 00:00 local
/// time: otherwise Git fills a missing time of day with the CURRENT one – which commits of the
/// cutoff day were included would then depend on the time of day the clone runs.
fn shallow_since_arg(since: &str) -> String {
    let bytes = since.as_bytes();
    let plain_date = bytes.len() == 10 && bytes.iter().enumerate().all(|(i, b)| if i == 4 || i == 7 { *b == b'-' } else { b.is_ascii_digit() });
    if plain_date {
        format!("{since}T00:00:00")
    } else {
        since.to_string()
    }
}

async fn clone_job(core: &Core, job: &Job, url: &str, parent_path: &str, name: &str, options: &CloneOptions) -> CoreResult<OpenedRepo> {
    remotes::check_url(url)?;
    let sparse = sparse_paths(options)?;
    let branch = util::non_empty(options.branch.clone()).map(|b| b.trim().to_string());
    if let Some(branch) = &branch {
        util::check_ref_name(branch).map_err(|reason| CoreError::invalid_name(format!("Invalid branch name: {reason}")))?;
    }
    if options.depth == Some(0) {
        return Err(CoreError::not_allowed("The depth of a shallow clone must be at least 1."));
    }
    let since = util::non_empty(options.shallow_since.clone()).map(|s| shallow_since_arg(s.trim()));
    if since.as_ref().is_some_and(|s| s.starts_with('-') || s.chars().any(|c| c.is_control())) {
        return Err(CoreError::not_allowed("The date for the shallow clone is invalid."));
    }
    let (target, existed) = target_dir(parent_path, name)?;
    let parent = target.parent().map(Path::to_path_buf).unwrap_or_else(|| target.clone());

    let mut cmd = core.git_at(&parent).args(["clone", "--progress"]);
    if let Some(depth) = options.depth {
        cmd = cmd.arg("--depth").arg(depth.to_string());
    }
    if let Some(since) = &since {
        cmd = cmd.arg(format!("--shallow-since={since}"));
    }
    if let Some(branch) = &branch {
        cmd = cmd.arg("--branch").arg(branch);
    }
    if !sparse.is_empty() {
        cmd = cmd.args(["--sparse", "--filter=blob:none"]);
    }
    if options.depth.is_some() || since.is_some() || !sparse.is_empty() {
        // Otherwise Git simply copies everything for local paths and ignores depth and filter.
        cmd = cmd.arg("--no-local");
    }
    if options.recurse_submodules {
        cmd = cmd.arg("--recurse-submodules");
    }
    let run = cmd.arg("--").arg(url).arg(&target).network().run_stream(job.token(), &mut |line| job.progress_line(line)).await;
    if let Err(e) = run {
        remove_partial(&target, existed).await;
        return Err(clone_error(e));
    }

    if !sparse.is_empty() {
        job.progress("Sparse Checkout", None, "Checking out the selected folders …");
        let list = sparse.join("\n") + "\n";
        let set = core
            .git_at(&target)
            .args(["sparse-checkout", "set", "--cone", "--stdin"])
            .stdin(list)
            .network()
            .run_stream(job.token(), &mut |line| job.progress_line(line))
            .await;
        if let Err(e) = set {
            remove_partial(&target, existed).await;
            return Err(e);
        }
    }
    if let Err(e) = job.token().check() {
        remove_partial(&target, existed).await;
        return Err(e);
    }
    // The configuration of this clone was just created on this machine.
    crate::commands::trust::open_created(core, &target).await
}

/// "No remote" does not fit when cloning: there the same Git message means that there is no
/// repository at the address.
fn clone_error(mut error: CoreError) -> CoreError {
    if error.code == ErrorCode::NoRemote {
        error.code = ErrorCode::NotFound;
        error.message = "No Git repository was found at this address.".into();
    }
    error
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

/// Creates `parent_path/name` as a new repository (README, templates, first commit).
///
/// The first commit only exists if an identity is known (Git configuration, otherwise name
/// and email of the active profile). Without an identity the files stay staged and the
/// repository opens without a commit.
pub async fn repo_init(core: &Core, options: InitOptions) -> CoreResult<OpenedRepo> {
    let name = options.name.trim().to_string();
    let branch = match util::non_empty(options.default_branch.clone()) {
        Some(branch) => branch.trim().to_string(),
        None => core.settings()?.default_branch_name,
    };
    util::check_ref_name(&branch).map_err(|reason| CoreError::invalid_name(format!("Invalid branch name: {reason}")))?;
    let gitignore = match util::non_empty(options.gitignore_template.clone()) {
        Some(key) => Some(
            templates::find(templates::GITIGNORE, &key)
                .ok_or_else(|| CoreError::not_found(format!("The .gitignore template “{}” does not exist.", key.trim())))?,
        ),
        None => None,
    };
    let license = match util::non_empty(options.license_template.clone()) {
        Some(key) => Some(
            templates::find(templates::LICENSES, &key)
                .ok_or_else(|| CoreError::not_found(format!("The license template “{}” does not exist.", key.trim())))?,
        ),
        None => None,
    };
    let (target, existed) = target_dir(&options.parent_path, &name)?;
    if !existed {
        std::fs::create_dir(&target)?;
    }
    let result = init_in(core, &target, &name, &branch, options.create_readme, gitignore, license).await;
    if result.is_err() {
        remove_partial(&target, existed).await;
    }
    result
}

async fn init_in(
    core: &Core,
    target: &Path,
    name: &str,
    branch: &str,
    create_readme: bool,
    gitignore: Option<&templates::Template>,
    license: Option<&templates::Template>,
) -> CoreResult<OpenedRepo> {
    core.git_at(target).args(["init", "-b", branch]).run().await?;
    let config = |key: &'static str| async move {
        match core.git_at(target).args(["config", "--get", key]).read_only().no_log().run_raw().await {
            Ok(out) if out.success() => out.stdout_text().trim().to_string(),
            _ => String::new(),
        }
    };
    let (git_name, git_email) = (config("user.name").await, config("user.email").await);
    let profile = core.db.with(db::profiles::active)?;

    let mut files: Vec<&str> = Vec::new();
    if create_readme {
        std::fs::write(target.join("README.md"), format!("# {name}\n"))?;
        files.push("README.md");
    }
    if let Some(template) = gitignore {
        std::fs::write(target.join(".gitignore"), templates::text(template))?;
        files.push(".gitignore");
    }
    if let Some(template) = license {
        let year = chrono::Utc::now().format("%Y").to_string();
        let holder = [profile.author_name.trim(), git_name.as_str()].into_iter().find(|n| !n.is_empty()).unwrap_or(UNKNOWN_HOLDER);
        std::fs::write(target.join("LICENSE"), templates::license_text(template, &year, holder))?;
        files.push("LICENSE");
    }

    let mut notice: Option<crate::model::OpenNotice> = None;
    if !files.is_empty() {
        core.git_at(target).arg("add").arg("--").args(&files).run().await?;
        let from_git = !git_name.is_empty() && !git_email.is_empty();
        let from_profile = !profile.author_name.trim().is_empty() && !profile.author_email.trim().is_empty();
        if from_git || from_profile {
            let mut cmd = core.git_at(target);
            if !from_git {
                cmd = cmd
                    .arg("-c")
                    .arg(format!("user.name={}", profile.author_name.trim()))
                    .arg("-c")
                    .arg(format!("user.email={}", profile.author_email.trim()));
            }
            // If the commit fails (hook, signing), the repository is still usable: the files
            // are staged. But the user learns about it right away, including the output – not
            // only on their own first commit.
            if let Err(e) = cmd.args(["commit", "-m", INITIAL_COMMIT_MESSAGE]).run().await {
                log::warn!("First commit in {} not created: {}", util::display_path(target), e.message);
                let output = e.git_output.clone().map(|text| text.trim().to_string()).filter(|text| !text.is_empty());
                let hook = e.is(ErrorCode::HookFailed) || output.as_deref().is_some_and(|text| text.to_lowercase().contains("hook"));
                let why = if hook { "A Git hook rejected it.".to_string() } else { e.message.clone() };
                notice = Some(crate::model::OpenNotice {
                    message: format!("The first commit was not created: {why} The files are staged – commit them yourself once the cause is fixed."),
                    output,
                });
            }
        }
    }
    // Created by the app itself: nothing in it comes from anyone else.
    let mut opened = crate::commands::trust::open_created(core, target).await?;
    opened.notice = notice;
    Ok(opened)
}

/// Available .gitignore and license templates.
pub async fn init_templates(core: &Core) -> CoreResult<InitTemplates> {
    let _ = core;
    let options = |list: &[templates::Template]| {
        list.iter().map(|t| TemplateOption { key: t.key.to_string(), label: t.label.to_string() }).collect::<Vec<_>>()
    };
    Ok(InitTemplates { gitignore: options(templates::GITIGNORE), licenses: options(templates::LICENSES) })
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;
    use crate::commands::sync::job_cancel;
    use crate::events::names;
    use crate::model::{Head, TabKind};
    use crate::testkit::{TestCore, TestRemote, TestRepo};

    /// `file://` URL of a test remote (with a local path Git would ignore depth and filter).
    fn file_url(remote: &TestRemote) -> String {
        let path = remote.url();
        if path.starts_with('/') {
            format!("file://{path}")
        } else {
            format!("file:///{path}")
        }
    }

    /// Remote with three commits on `main`, a branch `feature` and files in subfolders.
    fn seeded_remote() -> (TestRepo, TestRemote) {
        let repo = TestRepo::with_commit();
        repo.write_file("docs/anleitung.md", "# Anleitung\n");
        repo.write_file("src/haupt.rs", "fn main() {}\n");
        repo.write_file("src/tief/mit leerzeichen/ümlaut.txt", "ä\r\nö");
        repo.write_file("src/daneben/x.txt", "x\n");
        repo.commit("Ordner");
        repo.commit_file("docs/zweite.md", "zwei\n", "Dritter Commit");
        let remote = repo.add_remote();
        repo.checkout_new("feature");
        repo.commit_file("feature.txt", "f\n", "Feature");
        repo.git(&["push", "-q", "origin", "feature"]);
        repo.checkout("main");
        (repo, remote)
    }

    fn parent_of(dir: &tempfile::TempDir) -> String {
        dir.path().to_string_lossy().into_owned()
    }

    fn git_in(dir: &Path, args: &[&str]) -> String {
        let out = std::process::Command::new("git").args(["-c", "core.autocrlf=false"]).args(args).current_dir(dir).output().unwrap();
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim_end().to_string()
    }

    #[tokio::test]
    async fn clone_opens_the_repository_and_reports_progress() {
        let tc = TestCore::new().await;
        let (source, remote) = seeded_remote();
        let dest = tempfile::tempdir().unwrap();
        tc.events.clear();
        let opened = repo_clone(&tc, "klon-1".into(), remote.url(), parent_of(&dest), "Mein Klon".into(), CloneOptions::default()).await.unwrap();
        let target = dest.path().join("Mein Klon");
        assert_eq!(opened.repo.name, "Mein Klon");
        assert_eq!(opened.tab.kind, TabKind::Repo);
        assert!(opened.tab.is_active);
        assert_eq!(git_in(&target, &["rev-parse", "HEAD"]), source.head());
        assert_eq!(std::fs::read(target.join("src/tief/mit leerzeichen/ümlaut.txt")).unwrap(), b"\xc3\xa4\r\n\xc3\xb6");
        assert_eq!(git_in(&target, &["remote", "get-url", "origin"]), remote.url());

        assert!(tc.events.count(names::JOB_PROGRESS) >= 1);
        let done = tc.events.named(names::JOB_DONE);
        assert_eq!(done.len(), 1);
        assert_eq!(done[0]["ok"], true);
        assert_eq!(done[0]["jobId"], "klon-1");
        assert!(done[0]["repoId"].is_null());
        assert!(!tc.jobs.is_running("klon-1"));
        // The new repository is in the list.
        let repos = crate::commands::repos::repo_list(&tc).await.unwrap();
        assert!(repos.iter().any(|r| r.id == opened.repo.id));
    }

    #[tokio::test]
    async fn clone_with_depth_branch_and_shallow_since() {
        let tc = TestCore::new().await;
        let (source, remote) = seeded_remote();
        let dest = tempfile::tempdir().unwrap();

        let options = CloneOptions { depth: Some(1), ..Default::default() };
        repo_clone(&tc, "j1".into(), file_url(&remote), parent_of(&dest), "flach".into(), options).await.unwrap();
        let flat = dest.path().join("flach");
        assert_eq!(git_in(&flat, &["rev-list", "--count", "HEAD"]), "1");
        assert_eq!(git_in(&flat, &["rev-parse", "--is-shallow-repository"]), "true");

        // Depth also applies with a local path as URL.
        let options = CloneOptions { depth: Some(2), branch: Some("feature".into()), ..Default::default() };
        repo_clone(&tc, "j2".into(), remote.url(), parent_of(&dest), "zweig".into(), options).await.unwrap();
        let branch = dest.path().join("zweig");
        assert_eq!(git_in(&branch, &["symbolic-ref", "--short", "HEAD"]), "feature");
        assert_eq!(git_in(&branch, &["rev-list", "--count", "HEAD"]), "2");
        assert!(branch.join("feature.txt").exists());

        // A plain date means the whole day; everything else goes to Git unchanged.
        assert_eq!(shallow_since_arg("2026-02-01"), "2026-02-01T00:00:00");
        for other in ["1772434800", "2026-02-01T12:30:00", "2 weeks ago", "2026-2-1", "abcd-ef-gh"] {
            assert_eq!(shallow_since_arg(other), other);
        }

        // Only commits from the time of the second one.
        let second = source.git(&["log", "--reverse", "--format=%at", "main"]).lines().nth(1).unwrap().to_string();
        let options = CloneOptions { shallow_since: Some(second), ..Default::default() };
        repo_clone(&tc, "j3".into(), file_url(&remote), parent_of(&dest), "seit".into(), options).await.unwrap();
        assert_eq!(git_in(&dest.path().join("seit"), &["rev-list", "--count", "HEAD"]), "2");

        let err = repo_clone(&tc, "j4".into(), remote.url(), parent_of(&dest), "null".into(), CloneOptions { depth: Some(0), ..Default::default() })
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
        assert!(!dest.path().join("null").exists());
    }

    #[tokio::test]
    async fn sparse_clone_checks_out_only_the_chosen_folders() {
        let tc = TestCore::new().await;
        let (_source, remote) = seeded_remote();
        let dest = tempfile::tempdir().unwrap();
        let options = CloneOptions { sparse_paths: vec!["./src/tief/mit leerzeichen/".into(), "  ".into()], ..Default::default() };
        repo_clone(&tc, "j1".into(), file_url(&remote), parent_of(&dest), "teil".into(), options).await.unwrap();
        let target = dest.path().join("teil");
        assert!(target.join("src/tief/mit leerzeichen/ümlaut.txt").exists());
        // Cone mode: files in the root directory and directly in the folders along the way
        // are always included, other folders are not.
        assert!(target.join("README.md").exists());
        assert!(target.join("src/haupt.rs").exists());
        assert!(!target.join("docs").exists());
        assert!(!target.join("src/daneben").exists());
        assert_eq!(git_in(&target, &["sparse-checkout", "list"]), "src/tief/mit leerzeichen");
        // The history is complete, the status clean.
        assert_eq!(git_in(&target, &["rev-list", "--count", "HEAD"]), "3");
        assert_eq!(git_in(&target, &["status", "--porcelain"]), "");

        let options = CloneOptions { sparse_paths: vec!["../raus".into()], ..Default::default() };
        let err = repo_clone(&tc, "j2".into(), file_url(&remote), parent_of(&dest), "raus".into(), options).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
    }

    #[tokio::test]
    async fn clone_checks_target_and_url_before_starting() {
        let tc = TestCore::new().await;
        let (_source, remote) = seeded_remote();
        let dest = tempfile::tempdir().unwrap();
        let clone = |job: &str, url: String, parent: String, name: &str| {
            repo_clone(&tc, job.to_string(), url, parent, name.to_string(), CloneOptions::default())
        };

        // Target folder exists and is not empty – nothing is touched.
        std::fs::create_dir(dest.path().join("voll")).unwrap();
        std::fs::write(dest.path().join("voll").join("wichtig.txt"), "bleibt").unwrap();
        let err = clone("a", remote.url(), parent_of(&dest), "voll").await.unwrap_err();
        assert_eq!(err.code, ErrorCode::PathExists);
        assert_eq!(std::fs::read(dest.path().join("voll").join("wichtig.txt")).unwrap(), b"bleibt");
        // A file with that name
        std::fs::write(dest.path().join("datei"), "x").unwrap();
        assert_eq!(clone("b", remote.url(), parent_of(&dest), "datei").await.unwrap_err().code, ErrorCode::PathExists);
        // An empty folder is fine.
        std::fs::create_dir(dest.path().join("leer")).unwrap();
        clone("c", remote.url(), parent_of(&dest), "leer").await.unwrap();
        assert!(dest.path().join("leer").join("README.md").exists());

        // Parent folder missing
        let missing = dest.path().join("gibt").join("es nicht").to_string_lossy().into_owned();
        assert_eq!(clone("d", remote.url(), missing, "x").await.unwrap_err().code, ErrorCode::PathNotFound);
        assert_eq!(clone("e", remote.url(), "relativ".into(), "x").await.unwrap_err().code, ErrorCode::PathNotFound);
        // Invalid names
        for bad in ["", "a/b", "..", "a:b", "NUL", "punkt."] {
            assert_eq!(clone("f", remote.url(), parent_of(&dest), bad).await.unwrap_err().code, ErrorCode::InvalidName, "{bad:?}");
        }
        // Invalid URLs
        for bad in ["", "htp://x/y", "https://", "ext::sh -c boese", "-u boese"] {
            assert_eq!(clone("g", bad.to_string(), parent_of(&dest), "url").await.unwrap_err().code, ErrorCode::NotAllowed, "{bad:?}");
        }
        assert!(!dest.path().join("url").exists());
        // Every attempt finished its job cleanly.
        assert_eq!(tc.events.count(names::JOB_DONE), 16);
    }

    #[tokio::test]
    async fn failed_clone_leaves_no_folder_behind() {
        let tc = TestCore::new().await;
        let dest = tempfile::tempdir().unwrap();
        // Source does not exist
        let missing = dest.path().join("quelle fehlt.git").to_string_lossy().replace('\\', "/");
        let err = repo_clone(&tc, "a".into(), missing, parent_of(&dest), "ziel".into(), CloneOptions::default()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound, "{err:?}");
        assert!(!dest.path().join("ziel").exists());
        // Branch does not exist; the empty folder that existed before stays empty.
        let (_source, remote) = seeded_remote();
        std::fs::create_dir(dest.path().join("leer")).unwrap();
        let options = CloneOptions { branch: Some("gibt-es-nicht".into()), ..Default::default() };
        let err = repo_clone(&tc, "b".into(), remote.url(), parent_of(&dest), "leer".into(), options).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound, "{err:?}");
        assert!(dest.path().join("leer").is_dir());
        assert_eq!(std::fs::read_dir(dest.path().join("leer")).unwrap().count(), 0);
        let done = tc.events.named(names::JOB_DONE);
        assert_eq!(done.len(), 2);
        assert!(done.iter().all(|d| d["ok"] == false && d["cancelled"] == false));
    }

    #[tokio::test]
    async fn unreachable_server_is_reported_as_offline_without_leaking_credentials() {
        let tc = TestCore::new().await;
        let dest = tempfile::tempdir().unwrap();
        // Port 9 on the local machine: nothing listens there, the connection is refused immediately.
        let url = "http://anna:supergeheim@127.0.0.1:9/team/repo.git";
        let err = repo_clone(&tc, "a".into(), url.into(), parent_of(&dest), "ziel".into(), CloneOptions::default()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Offline, "{err:?}");
        assert!(!dest.path().join("ziel").exists());
        let everything = format!("{err:?} {:?}", tc.events.all());
        assert!(!everything.contains("supergeheim"), "{everything}");
    }

    #[tokio::test]
    async fn cancelled_clone_removes_the_half_cloned_folder() {
        // Artificially slowed down: a post-checkout hook holds the clone at the end.
        let hooks = tempfile::tempdir().unwrap();
        std::fs::write(hooks.path().join("post-checkout"), "#!/bin/sh\nsleep 60\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(hooks.path().join("post-checkout"), std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let config = format!("[core]\n\thooksPath = {}\n", hooks.path().to_string_lossy().replace('\\', "/"));
        let tc = TestCore::with_global_config(&config).await;
        let (_source, remote) = seeded_remote();
        let dest = tempfile::tempdir().unwrap();
        let target = dest.path().join("abgebrochen");

        let core = tc.core.clone();
        let watched = target.clone();
        let canceller = tokio::spawn(async move {
            // Wait until the clone has really written files, then cancel.
            let started = Instant::now();
            while !watched.join("README.md").exists() && started.elapsed() < Duration::from_secs(30) {
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            assert!(watched.join("README.md").exists(), "the clone had not checked anything out yet");
            assert!(core.jobs.is_running("klon-x"));
            job_cancel(&core, "klon-x".into()).await.unwrap();
            Instant::now()
        });
        let err = repo_clone(&tc, "klon-x".into(), remote.url(), parent_of(&dest), "abgebrochen".into(), CloneOptions::default())
            .await
            .unwrap_err();
        let cancelled_at = canceller.await.unwrap();
        assert_eq!(err.code, ErrorCode::Cancelled);
        // The hook was really terminated, not waited for.
        assert!(cancelled_at.elapsed() < Duration::from_secs(15), "cancel came too late: {:?}", cancelled_at.elapsed());
        assert!(!target.exists(), "the half-cloned folder is still there");
        let done = tc.events.named(names::JOB_DONE);
        assert_eq!(done.len(), 1);
        assert_eq!(done[0]["cancelled"], true);
        assert_eq!(done[0]["ok"], false);
        assert!(!tc.jobs.is_running("klon-x"));
        // Nothing was registered as a repository.
        assert!(crate::commands::repos::repo_list(&tc).await.unwrap().is_empty());
    }

    // --- Creating -------------------------------------------------------------

    const IDENTITY: &str = "[user]\n\tname = Erika Müller\n\temail = erika@example.com\n";

    fn init_options(parent: &tempfile::TempDir, name: &str) -> InitOptions {
        InitOptions { parent_path: parent_of(parent), name: name.into(), default_branch: None, gitignore_template: None, license_template: None, create_readme: true }
    }

    #[tokio::test]
    async fn init_with_templates_creates_the_first_commit() {
        let tc = TestCore::with_global_config(IDENTITY).await;
        let dest = tempfile::tempdir().unwrap();
        let options = InitOptions {
            default_branch: Some("trunk".into()),
            gitignore_template: Some("rust".into()),
            license_template: Some("MIT".into()),
            ..init_options(&dest, "Neues Projekt")
        };
        let opened = repo_init(&tc, options).await.unwrap();
        let target = dest.path().join("Neues Projekt");
        assert_eq!(opened.repo.name, "Neues Projekt");
        assert_eq!(opened.tab.kind, TabKind::Repo);
        assert_eq!(git_in(&target, &["symbolic-ref", "--short", "HEAD"]), "trunk");
        assert_eq!(std::fs::read_to_string(target.join("README.md")).unwrap(), "# Neues Projekt\n");
        let ignore = std::fs::read_to_string(target.join(".gitignore")).unwrap();
        assert!(ignore.contains("target/") && !ignore.contains('\r'));
        let license = std::fs::read_to_string(target.join("LICENSE")).unwrap();
        let year = chrono::Utc::now().format("%Y").to_string();
        assert!(license.starts_with(&format!("MIT License\n\nCopyright (c) {year} Erika Müller\n\nPermission is hereby granted")), "{license}");
        assert!(!license.contains("{{"));

        assert_eq!(git_in(&target, &["log", "--format=%s|%an|%ae"]), format!("{INITIAL_COMMIT_MESSAGE}|Erika Müller|erika@example.com"));
        assert_eq!(git_in(&target, &["ls-tree", "--name-only", "HEAD"]), ".gitignore\nLICENSE\nREADME.md");
        assert_eq!(git_in(&target, &["status", "--porcelain"]), "");
        let head = crate::commands::refs::read_head(&tc, &opened.repo.id).await.unwrap();
        assert!(matches!(head, Head::Branch { ref branch, .. } if branch == "trunk"), "{head:?}");
    }

    #[tokio::test]
    async fn init_without_identity_stages_files_but_does_not_commit() {
        let tc = TestCore::new().await;
        let dest = tempfile::tempdir().unwrap();
        let options = InitOptions { license_template: Some("apache-2.0".into()), ..init_options(&dest, "ohne-identität") };
        let opened = repo_init(&tc, options).await.unwrap();
        let target = dest.path().join("ohne-identität");
        // The branch name comes from the settings.
        assert_eq!(git_in(&target, &["symbolic-ref", "--short", "HEAD"]), "main");
        assert!(!std::process::Command::new("git").args(["rev-parse", "--verify", "-q", "HEAD"]).current_dir(&target).output().unwrap().status.success());
        assert_eq!(git_in(&target, &["status", "--porcelain"]), "A  LICENSE\nA  README.md");
        let status = crate::commands::status::status_get(&tc, opened.repo.id.clone()).await.unwrap();
        assert!(matches!(status.head, Head::Unborn { ref branch } if branch == "main"));
        assert_eq!(status.staged.len(), 2);
        // Apache-2.0 is written unchanged.
        let license = std::fs::read_to_string(target.join("LICENSE")).unwrap();
        assert!(license.contains("Apache License") && license.contains("Copyright [yyyy] [name of copyright owner]"));
    }

    #[tokio::test]
    async fn init_uses_the_profile_identity_and_the_default_branch_setting() {
        let tc = TestCore::new().await;
        let profile = tc.db.with(crate::db::profiles::active).unwrap();
        crate::commands::settings::profile_save(&tc, Some(profile.id), profile.name, "Profil Person".into(), "profil@example.com".into(), false, None)
            .await
            .unwrap();
        crate::commands::settings::settings_set(&tc, serde_json::json!({ "defaultBranchName": "entwicklung" })).await.unwrap();
        let dest = tempfile::tempdir().unwrap();
        let options = InitOptions { license_template: Some("BSD-3-Clause".into()), ..init_options(&dest, "profil") };
        repo_init(&tc, options).await.unwrap();
        let target = dest.path().join("profil");
        assert_eq!(git_in(&target, &["symbolic-ref", "--short", "HEAD"]), "entwicklung");
        assert_eq!(git_in(&target, &["log", "--format=%an <%ae>"]), "Profil Person <profil@example.com>");
        let license = std::fs::read_to_string(target.join("LICENSE")).unwrap();
        assert!(license.contains(", Profil Person\n"), "{license}");
    }

    #[tokio::test]
    async fn init_without_any_files_gives_an_empty_repository() {
        let tc = TestCore::with_global_config(IDENTITY).await;
        let dest = tempfile::tempdir().unwrap();
        // Into an existing empty folder.
        std::fs::create_dir(dest.path().join("leer")).unwrap();
        let options = InitOptions { create_readme: false, ..init_options(&dest, "leer") };
        let opened = repo_init(&tc, options).await.unwrap();
        let target = dest.path().join("leer");
        assert!(target.join(".git").is_dir());
        assert_eq!(std::fs::read_dir(&target).unwrap().count(), 1);
        let status = crate::commands::status::status_get(&tc, opened.repo.id).await.unwrap();
        assert!(matches!(status.head, Head::Unborn { .. }));
        assert!(status.staged.is_empty() && status.unstaged.is_empty());
    }

    #[tokio::test]
    async fn init_error_cases_leave_nothing_behind() {
        let tc = TestCore::new().await;
        let dest = tempfile::tempdir().unwrap();
        std::fs::create_dir(dest.path().join("voll")).unwrap();
        std::fs::write(dest.path().join("voll").join("x.txt"), "x").unwrap();
        assert_eq!(repo_init(&tc, init_options(&dest, "voll")).await.unwrap_err().code, ErrorCode::PathExists);
        assert!(!dest.path().join("voll").join(".git").exists());

        let mut options = init_options(&dest, "x");
        options.parent_path = dest.path().join("fehlt").to_string_lossy().into_owned();
        assert_eq!(repo_init(&tc, options).await.unwrap_err().code, ErrorCode::PathNotFound);
        assert_eq!(repo_init(&tc, init_options(&dest, "a/b")).await.unwrap_err().code, ErrorCode::InvalidName);
        let options = InitOptions { default_branch: Some("a..b".into()), ..init_options(&dest, "zweig") };
        assert_eq!(repo_init(&tc, options).await.unwrap_err().code, ErrorCode::InvalidName);
        let options = InitOptions { gitignore_template: Some("gibt-es-nicht".into()), ..init_options(&dest, "vorlage") };
        assert_eq!(repo_init(&tc, options).await.unwrap_err().code, ErrorCode::NotFound);
        let options = InitOptions { license_template: Some("GPL-99".into()), ..init_options(&dest, "lizenz") };
        assert_eq!(repo_init(&tc, options).await.unwrap_err().code, ErrorCode::NotFound);
        for name in ["zweig", "vorlage", "lizenz"] {
            assert!(!dest.path().join(name).exists(), "{name}");
        }
    }

    #[tokio::test]
    async fn templates_are_complete_and_well_formed() {
        let tc = TestCore::new().await;
        let all = init_templates(&tc).await.unwrap();
        let keys: Vec<&str> = all.gitignore.iter().map(|t| t.key.as_str()).collect();
        assert_eq!(keys, ["node", "python", "rust", "java", "go", "cpp", "dotnet", "unity", "macos", "windows", "linux", "jetbrains", "vscode"]);
        let keys: Vec<&str> = all.licenses.iter().map(|t| t.key.as_str()).collect();
        assert_eq!(keys, ["MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "Unlicense"]);
        assert!(all.gitignore.iter().chain(&all.licenses).all(|t| !t.label.is_empty()));

        for template in templates::GITIGNORE {
            let text = templates::text(template);
            assert!(text.ends_with('\n') && !text.contains('\r'), "{}", template.key);
            assert!(text.lines().any(|l| !l.is_empty() && !l.starts_with('#')), "{}", template.key);
            assert!(text.lines().all(|l| l == l.trim_end()), "{}: Leerzeichen am Zeilenende", template.key);
        }
        for template in templates::LICENSES {
            let text = templates::license_text(template, "2026", "Erika Müller");
            assert!(!text.contains("{{") && !text.contains('\r') && text.ends_with('\n'), "{}", template.key);
            let has_holder = template.text.contains(templates::HOLDER);
            assert_eq!(has_holder, text.contains("2026") && text.contains("Erika Müller"), "{}", template.key);
            assert_eq!(has_holder, !matches!(template.key, "Apache-2.0" | "Unlicense"), "{}", template.key);
        }
        // Spot checks of the wording.
        let text = |key: &str| templates::text(templates::find(templates::LICENSES, key).unwrap());
        assert!(text("Apache-2.0").contains("Version 2.0, January 2004") && text("Apache-2.0").contains("END OF TERMS AND CONDITIONS"));
        assert!(text("BSD-3-Clause").contains("3. Neither the name of the copyright holder"));
        assert!(!text("BSD-2-Clause").contains("Neither the name"));
        assert!(text("ISC").contains("Permission to use, copy, modify, and/or distribute this software"));
        assert!(text("Unlicense").starts_with("This is free and unencumbered software released into the public domain."));
    }

    #[test]
    fn folder_names_are_checked() {
        for good in ["projekt", "Mein Projekt", "größe", "a.b", ".versteckt", "-strich", "com", "COM10"] {
            assert!(check_folder_name(good).is_ok(), "{good}");
        }
        for bad in ["", ".", "..", "a/b", "a\\b", "a:b", "a*b", "ende.", "ende ", " anfang", "CON", "nul.txt", "COM1", "lpt9", "a\tb"] {
            assert_eq!(check_folder_name(bad).unwrap_err().code, ErrorCode::InvalidName, "{bad:?}");
        }
    }
}
