//! Git LFS: status, tracking and untracking patterns, fetching contents, cleaning up.
//!
//! Everything runs through `git lfs …`, so only when Git LFS is installed. `lfs_status` says so
//! (`installed`); otherwise the other commands answer with `unsupported` and an explanation.
//! The patterns live in the `.gitattributes`; without LFS the core reads them there itself.

use std::sync::atomic::{AtomicBool, Ordering};

use serde::Deserialize;

use crate::app::Core;
use crate::error::{CoreError, CoreResult};
use crate::jobs::Job;
use crate::model::{LfsLockFailure, LfsLockList, LfsLockOutcome, LfsStatus, RepoChange};
use crate::util;

mod locks;

#[cfg(test)]
mod lock_tests;

/// For tests: pretend Git LFS is not installed (`core.state::<LfsState>()`).
#[derive(Default)]
pub struct LfsState {
    pretend_missing: AtomicBool,
}

impl LfsState {
    pub fn set_pretend_missing(&self, on: bool) {
        self.pretend_missing.store(on, Ordering::SeqCst);
    }
}

/// "git-lfs/3.7.1 (GitHub; windows amd64; go 1.25.1)" → "3.7.1".
fn parse_version(text: &str) -> Option<String> {
    let rest = text.trim().strip_prefix("git-lfs/")?;
    let version: String = rest.chars().take_while(|c| !c.is_whitespace()).collect();
    (!version.is_empty()).then_some(version)
}

/// Version of Git LFS, or `None` if it is not installed.
async fn installed_version(core: &Core, repo_id: &str) -> CoreResult<Option<String>> {
    if core.state::<LfsState>().pretend_missing.load(Ordering::SeqCst) {
        return Ok(None);
    }
    let out = core.git_for(repo_id)?.args(["lfs", "version"]).read_only().no_log().run_raw().await?;
    if !out.success() {
        return Ok(None);
    }
    Ok(parse_version(&out.stdout_text()).or_else(|| Some(out.stdout_text())).filter(|v| !v.is_empty()))
}

fn not_installed() -> CoreError {
    CoreError::unsupported("Git LFS is not installed. Install Git LFS (https://git-lfs.com); it becomes available without a restart.")
}

async fn require_installed(core: &Core, repo_id: &str) -> CoreResult<String> {
    installed_version(core, repo_id).await?.ok_or_else(not_installed)
}

#[derive(Deserialize)]
struct TrackJson {
    #[serde(default)]
    patterns: Vec<TrackedPattern>,
}

#[derive(Deserialize)]
struct TrackedPattern {
    pattern: String,
    #[serde(default = "yes")]
    tracked: bool,
}

fn yes() -> bool {
    true
}

/// Patterns with `filter=lfs` from the text of a `.gitattributes` (read without Git LFS).
/// A pattern in quotes or with `[[:space:]]` stands for one containing spaces.
fn patterns_in_attributes(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (pattern, attributes) = if let Some(rest) = line.strip_prefix('"') {
            match rest.split_once('"') {
                Some((pattern, attributes)) => (pattern.to_string(), attributes),
                None => continue,
            }
        } else {
            match line.split_once(char::is_whitespace) {
                Some((pattern, attributes)) => (pattern.replace("[[:space:]]", " "), attributes),
                None => continue,
            }
        };
        if attributes.split_whitespace().any(|a| a == "filter=lfs") && !out.contains(&pattern) {
            out.push(pattern);
        }
    }
    out
}

async fn patterns(core: &Core, repo_id: &str, installed: bool) -> CoreResult<Vec<String>> {
    if installed {
        let out = core.git_for(repo_id)?.args(["lfs", "track", "--json"]).read_only().no_log().run_raw().await?;
        if out.success() {
            if let Ok(parsed) = serde_json::from_slice::<TrackJson>(&out.stdout) {
                let mut list: Vec<String> = Vec::new();
                for entry in parsed.patterns.into_iter().filter(|p| p.tracked) {
                    // In the .gitattributes a space is written as "[[:space:]]".
                    let pattern = entry.pattern.replace("[[:space:]]", " ");
                    if !list.contains(&pattern) {
                        list.push(pattern);
                    }
                }
                list.sort();
                return Ok(list);
            }
        }
    }
    // Without Git LFS (or with an old version without `--json`): the .gitattributes in the root directory.
    let root = core.repo_path(repo_id)?;
    let text = match tokio::fs::read(root.join(".gitattributes")).await {
        Ok(bytes) => util::decode_text(&bytes).0,
        Err(_) => String::new(),
    };
    let mut list = patterns_in_attributes(&text);
    list.sort();
    Ok(list)
}

async fn status(core: &Core, repo_id: &str) -> CoreResult<LfsStatus> {
    let version = installed_version(core, repo_id).await?;
    let patterns = patterns(core, repo_id, version.is_some()).await?;
    Ok(LfsStatus { installed: version.is_some(), version, patterns })
}

/// Whether Git LFS is installed, in which version, and which patterns the repository tracks via LFS.
pub async fn lfs_status(core: &Core, repo_id: String) -> CoreResult<LfsStatus> {
    status(core, &repo_id).await
}

fn check_pattern(pattern: &str) -> CoreResult<String> {
    let pattern = pattern.trim();
    if pattern.is_empty() {
        return Err(CoreError::not_allowed("The pattern must not be empty."));
    }
    if pattern.contains(['\n', '\r', '\0']) {
        return Err(CoreError::not_allowed("The pattern must not contain a line break."));
    }
    if pattern.starts_with('-') {
        return Err(CoreError::not_allowed("The pattern must not start with “-”."));
    }
    Ok(pattern.to_string())
}

/// Sets up Git LFS in the repository if it is not set up yet (filters and hooks): without the
/// filters the files would be committed normally, without `pre-push` they would never be uploaded.
async fn ensure_installed_in_repo(core: &Core, repo_id: &str) -> CoreResult<()> {
    let filter = core.git_for(repo_id)?.args(["config", "--get", "filter.lfs.process"]).read_only().no_log().run_raw().await?;
    let hook = crate::commands::status::git_dir(core, repo_id).await.map(|dir| dir.join("hooks").join("pre-push").is_file()).unwrap_or(false);
    if filter.success() && hook {
        return Ok(());
    }
    let installed = core.git_for(repo_id)?.args(["lfs", "install", "--local"]).run_raw().await?;
    if !installed.success() {
        // Custom hooks in the way: at least set up the filters; Git LFS names the hooks in its message.
        log::warn!("git lfs install --local: {}", installed.stderr_text());
        core.git_for(repo_id)?.args(["lfs", "install", "--local", "--skip-repo"]).run().await?;
    }
    Ok(())
}

/// Tracks `pattern` (e.g. `*.psd`) via LFS: an entry in the `.gitattributes` in the root
/// directory; the first time, Git LFS is set up in the repository. The changed `.gitattributes`
/// is afterwards an ordinary, unstaged change.
pub async fn lfs_track(core: &Core, repo_id: String, pattern: String) -> CoreResult<LfsStatus> {
    let repo_id = repo_id.as_str();
    let pattern = check_pattern(&pattern)?;
    require_installed(core, repo_id).await?;
    core.with_write_lock(repo_id, &[RepoChange::Worktree, RepoChange::Config], async {
        ensure_installed_in_repo(core, repo_id).await?;
        core.git_for(repo_id)?.args(["lfs", "track", "--"]).arg(&pattern).run().await?;
        status(core, repo_id).await
    })
    .await
}

/// Removes `pattern` from LFS tracking. A pattern that is not tracked → `not_found`.
pub async fn lfs_untrack(core: &Core, repo_id: String, pattern: String) -> CoreResult<LfsStatus> {
    let repo_id = repo_id.as_str();
    let pattern = check_pattern(&pattern)?;
    require_installed(core, repo_id).await?;
    core.with_write_lock(repo_id, &[RepoChange::Worktree], async {
        if !patterns(core, repo_id, true).await?.contains(&pattern) {
            return Err(CoreError::not_found(format!("The pattern “{pattern}” is not tracked by LFS.")));
        }
        core.git_for(repo_id)?.args(["lfs", "untrack", "--"]).arg(&pattern).run().await?;
        status(core, repo_id).await
    })
    .await
}

/// Fetches the LFS contents of the checked-out state (`git lfs pull`): a job with progress, cancellable.
pub async fn lfs_pull(core: &Core, repo_id: String, job_id: String) -> CoreResult<()> {
    core.repo_path(&repo_id)?;
    let job = core.start_job(&job_id, Some(&repo_id))?;
    let result = pull_job(core, &repo_id, &job).await;
    job.finish(&result);
    result
}

async fn pull_job(core: &Core, repo_id: &str, job: &Job) -> CoreResult<()> {
    require_installed(core, repo_id).await?;
    let _network = tokio::select! {
        guard = core.network_lock(repo_id) => guard,
        _ = job.token().cancelled() => return Err(CoreError::cancelled()),
    };
    let pulled = core.git_for(repo_id)?.args(["lfs", "pull"]).network().run_stream(job.token(), &mut |line| job.progress_line(line)).await;
    // Even after a cancellation some of the files may already have been replaced.
    core.emit_repo_changed(repo_id, &[RepoChange::Worktree]);
    pulled.map(|_| ())
}

/// Deletes local LFS objects that no current state needs any more (`git lfs prune`).
/// Returns Git LFS's summary (one line, in English).
pub async fn lfs_prune(core: &Core, repo_id: String) -> CoreResult<String> {
    let repo_id = repo_id.as_str();
    require_installed(core, repo_id).await?;
    core.with_write_lock(repo_id, &[], async {
        let out = core.git_for(repo_id)?.args(["lfs", "prune"]).run().await?;
        let text = format!("{}\n{}", out.stdout_text(), out.stderr_text());
        // Git LFS overwrites its progress line with `\r`; the last version counts.
        let summary = text.split(['\n', '\r']).map(str::trim).rfind(|line| !line.is_empty()).unwrap_or_default().to_string();
        Ok(summary)
    })
    .await
}

/// LFS file locks of the repository at the LFS server (`git lfs locks --verify`): path, owner,
/// time and whether it is our own, sorted by path. Served from the cache unless `refresh` is set
/// or a fetch has marked it stale; `filter` narrows by path or owner. Without Git LFS or on a
/// server without the locking API → `unsupported`. Only `refresh` may ask for credentials.
pub async fn lfs_locks(core: &Core, repo_id: String, filter: Option<String>, refresh: Option<bool>) -> CoreResult<LfsLockList> {
    let repo_id = repo_id.as_str();
    core.repo_path(repo_id)?;
    require_installed(core, repo_id).await?;
    let refresh = refresh.unwrap_or(false);
    let cached = if refresh { None } else { core.state::<locks::LockCache>().fresh(repo_id) };
    let list = match cached {
        Some(list) => list,
        None => locks::read(core, repo_id, refresh).await?,
    };
    Ok(locks::filtered(list, filter.as_deref()))
}

/// Locks `paths` at the LFS server (`git lfs lock`). Paths that could not be locked (someone
/// else holds the lock, …) are in `failed`; if none could be locked because the server has no
/// locking API → `unsupported`. Under the write lock: Git LFS changes the file permissions of
/// `lockable` files. Afterwards `repo:changed` with `locks`.
pub async fn lfs_lock(core: &Core, repo_id: String, paths: Vec<String>) -> CoreResult<LfsLockOutcome> {
    let repo_id = repo_id.as_str();
    let paths = locks::check_paths(&paths)?;
    require_installed(core, repo_id).await?;
    core.with_write_lock(repo_id, &[RepoChange::Locks], async {
        let out = core.git_for(repo_id)?.args(["lfs", "lock", "--json", "--"]).args(&paths).network().run_raw().await?;
        let failed = locks::lock_failures(&paths, &out);
        finish_lock_change(core, repo_id, &paths, failed).await
    })
    .await
}

/// Unlocks `paths` (`git lfs unlock`). `force` also removes other people's locks and own locks on
/// files with uncommitted changes (the server decides whether forcing is allowed). Failures per
/// path in `failed`. Afterwards `repo:changed` with `locks`.
pub async fn lfs_unlock(core: &Core, repo_id: String, paths: Vec<String>, force: bool) -> CoreResult<LfsLockOutcome> {
    let repo_id = repo_id.as_str();
    let paths = locks::check_paths(&paths)?;
    require_installed(core, repo_id).await?;
    core.with_write_lock(repo_id, &[RepoChange::Locks], async {
        let mut cmd = core.git_for(repo_id)?.args(["lfs", "unlock", "--json"]);
        if force {
            cmd = cmd.arg("--force");
        }
        let out = cmd.arg("--").args(&paths).network().run_raw().await?;
        let failed = locks::unlock_failures(&paths, &out);
        finish_lock_change(core, repo_id, &paths, failed).await
    })
    .await
}

/// After lock/unlock: every path failed for lack of a locking API → `unsupported`; otherwise the
/// fresh list from the server (now in the cache) plus the failures.
async fn finish_lock_change(core: &Core, repo_id: &str, paths: &[String], failed: Vec<LfsLockFailure>) -> CoreResult<LfsLockOutcome> {
    if failed.len() == paths.len() && failed.iter().all(|failure| locks::lacks_locking(&failure.reason)) {
        core.state::<locks::LockCache>().forget(repo_id);
        let reason = failed.first().map(|failure| failure.reason.as_str()).unwrap_or_default();
        return Err(CoreError::unsupported(locks::NO_LOCKING).with_git_output(reason));
    }
    let list = locks::read(core, repo_id, true).await?;
    Ok(LfsLockOutcome { locks: list, failed })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use crate::events::names;
    use crate::testkit::{TestCore, TestRemote, TestRepo};

    async fn setup() -> (TestCore, TestRepo, String) {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let id = tc.open(&repo).await.repo.id;
        (tc, repo, id)
    }

    async fn lfs_available(tc: &TestCore, id: &str) -> bool {
        installed_version(tc, id).await.unwrap().is_some()
    }

    #[test]
    fn versions_and_attribute_lines_are_parsed() {
        assert_eq!(parse_version("git-lfs/3.7.1 (GitHub; windows amd64; go 1.25.1; git b84b3384)\n").as_deref(), Some("3.7.1"));
        assert_eq!(parse_version("git-lfs/2.13.0-pre").as_deref(), Some("2.13.0-pre"));
        assert_eq!(parse_version("git: 'lfs' is not a git command."), None);

        let text = "# Kommentar\n*.psd filter=lfs diff=lfs merge=lfs -text\n*.txt text eol=lf\n\
\"mit leer/*.bin\" filter=lfs diff=lfs merge=lfs -text\nGro[[:space:]]ß/** filter=lfs\n*.psd filter=lfs\nnur-muster\n*.x -filter\n";
        assert_eq!(patterns_in_attributes(text), ["*.psd", "mit leer/*.bin", "Gro ß/**"]);
        assert!(patterns_in_attributes("").is_empty());
    }

    /// Without Git LFS: the status says so, the patterns still come from the .gitattributes,
    /// and everything else answers with an explanation.
    #[tokio::test]
    async fn without_git_lfs_everything_but_the_status_is_unsupported() {
        let (tc, repo, id) = setup().await;
        tc.state::<LfsState>().set_pretend_missing(true);
        repo.write_file(".gitattributes", "*.psd filter=lfs diff=lfs merge=lfs -text\n*.md text\n");

        let status = lfs_status(&tc, id.clone()).await.unwrap();
        assert_eq!(status, LfsStatus { installed: false, version: None, patterns: vec!["*.psd".into()] });
        for error in [
            lfs_track(&tc, id.clone(), "*.bin".into()).await.unwrap_err(),
            lfs_untrack(&tc, id.clone(), "*.psd".into()).await.unwrap_err(),
            lfs_pull(&tc, id.clone(), "job-lfs".into()).await.unwrap_err(),
            lfs_prune(&tc, id.clone()).await.unwrap_err(),
        ] {
            assert_eq!(error.code, ErrorCode::Unsupported, "{error:?}");
            assert!(error.message.contains("Git LFS is not installed"), "{}", error.message);
        }
        assert_eq!(repo.read_file(".gitattributes"), b"*.psd filter=lfs diff=lfs merge=lfs -text\n*.md text\n");
        // The failed job also reports its end.
        let done = tc.events.named(names::JOB_DONE);
        assert_eq!((done.len(), done[0]["ok"].as_bool()), (1, Some(false)));
        assert_eq!(lfs_status(&tc, "unbekannt".into()).await.unwrap_err().code, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn track_and_untrack_patterns() {
        let (tc, repo, id) = setup().await;
        if !lfs_available(&tc, &id).await {
            eprintln!("Git LFS is not installed – test skipped.");
            return;
        }
        let status = lfs_status(&tc, id.clone()).await.unwrap();
        assert!(status.installed && status.patterns.is_empty());
        let version = status.version.clone().unwrap_or_default();
        assert!(version.split('.').count() >= 2 && version.chars().next().is_some_and(|c| c.is_ascii_digit()), "{version}");

        tc.events.clear();
        let status = lfs_track(&tc, id.clone(), " *.psd ".into()).await.unwrap();
        assert_eq!(status.patterns, ["*.psd"]);
        assert!(String::from_utf8_lossy(&repo.read_file(".gitattributes")).contains("*.psd filter=lfs diff=lfs merge=lfs -text"));
        // The first time, Git LFS is set up in the repository (filters and hooks).
        assert_eq!(repo.git(&["config", "--local", "--get", "filter.lfs.clean"]), "git-lfs clean -- %f");
        assert!(repo.path().join(".git").join("hooks").join("pre-push").is_file());
        assert_eq!(tc.events.named(names::REPO_CHANGED)[0]["what"], serde_json::json!(["worktree", "config"]));

        let status = lfs_track(&tc, id.clone(), "bilder/große dateien/**".into()).await.unwrap();
        assert_eq!(status.patterns, ["*.psd", "bilder/große dateien/**"]);
        // Tracking the same pattern twice changes nothing.
        assert_eq!(lfs_track(&tc, id.clone(), "*.psd".into()).await.unwrap().patterns.len(), 2);

        // A new file matching the pattern ends up in the index as a pointer.
        repo.write_file("entwurf.psd", vec![7u8; 4096]);
        repo.git(&["add", "entwurf.psd", ".gitattributes"]);
        let pointer = repo.git(&["cat-file", "blob", ":entwurf.psd"]);
        assert!(pointer.starts_with("version https://git-lfs.github.com/spec/v1"), "{pointer}");

        let status = lfs_untrack(&tc, id.clone(), "*.psd".into()).await.unwrap();
        assert_eq!(status.patterns, ["bilder/große dateien/**"]);
        assert!(!String::from_utf8_lossy(&repo.read_file(".gitattributes")).contains("*.psd"));
        assert_eq!(lfs_untrack(&tc, id.clone(), "*.psd".into()).await.unwrap_err().code, ErrorCode::NotFound);
        for bad in ["", "  ", "a\nb", "--all"] {
            assert_eq!(lfs_track(&tc, id.clone(), bad.into()).await.unwrap_err().code, ErrorCode::NotAllowed, "{bad:?}");
        }
        // Cleaning up runs and returns a summary.
        let summary = lfs_prune(&tc, id.clone()).await.unwrap();
        assert!(summary.contains("local object") && !summary.contains('\r'), "{summary}");
    }

    /// Fetching contents: a clone containing only the pointers gets the real files.
    #[tokio::test]
    async fn pull_replaces_pointers_with_the_real_content() {
        let (tc, repo, id) = setup().await;
        if !lfs_available(&tc, &id).await {
            eprintln!("Git LFS is not installed – test skipped.");
            return;
        }
        let content: Vec<u8> = (0..20_000u32).map(|i| (i % 251) as u8).collect();
        lfs_track(&tc, id.clone(), "*.bin".into()).await.unwrap();
        repo.write_file("daten.bin", &content);
        repo.commit("Große Datei");
        let server = TestRemote::new();
        let url = format!("file:///{}", server.url().trim_start_matches('/'));
        repo.git(&["remote", "add", "origin", &url]);
        repo.git(&["push", "-q", "-u", "origin", "main"]);

        // Clone without the contents (only pointers in the working directory).
        let clone_dir = tempfile::tempdir().unwrap();
        let clone_path = clone_dir.path().join("klon");
        let cloned = std::process::Command::new("git")
            .args(["clone", "-q", &url, &clone_path.to_string_lossy()])
            .env("GIT_LFS_SKIP_SMUDGE", "1")
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", tc.global_config_path())
            .output()
            .unwrap();
        assert!(cloned.status.success(), "{}", String::from_utf8_lossy(&cloned.stderr));
        let pointer = std::fs::read(clone_path.join("daten.bin")).unwrap();
        assert!(pointer.starts_with(b"version https://git-lfs.github.com/spec/v1"), "at first the clone only has the pointer");
        let clone_id = crate::commands::repos::repo_open(&tc, clone_path.to_string_lossy().into_owned()).await.unwrap().repo.id;
        // LFS is not set up in the clone yet (no system configuration in the test): tracking a pattern sets it up.
        lfs_track(&tc, clone_id.clone(), "*.bin".into()).await.unwrap();

        tc.events.clear();
        lfs_pull(&tc, clone_id.clone(), "job-lfs-pull".into()).await.unwrap();
        assert_eq!(std::fs::read(clone_path.join("daten.bin")).unwrap(), content);
        let done = tc.events.named(names::JOB_DONE);
        assert_eq!((done.len(), done[0]["jobId"].as_str(), done[0]["ok"].as_bool()), (1, Some("job-lfs-pull"), Some(true)));
        assert!(tc.events.named(names::REPO_CHANGED).iter().any(|e| e["what"] == serde_json::json!(["worktree"])));
        let status = lfs_status(&tc, clone_id).await.unwrap();
        assert_eq!(status.patterns, ["*.bin"]);
    }
}
