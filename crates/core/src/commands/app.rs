//! App information.

use crate::app::Core;
use crate::error::CoreResult;
use crate::git::MIN_VERSION_TEXT;
use crate::model::{AppInfo, Platform};
use crate::util;

pub async fn app_info(core: &Core) -> CoreResult<AppInfo> {
    // A Git that is too old is reported as well; the UI compares against `git_min_version`.
    let git = core.git_found();
    let git = git.as_ref();
    Ok(AppInfo {
        version: core.app_version.clone(),
        platform: Platform::current(),
        git_version: git.map(|g| g.version_text.clone()),
        git_path: git.map(|g| util::display_path(&g.path)),
        git_min_version: MIN_VERSION_TEXT.to_string(),
        data_dir: util::display_path(core.data_dir()),
        keyring_available: core.keyring_available().await,
    })
}

/// Looks for Git again ("Check again" on the "Git was not found" page) and returns the new
/// state. A Git installed in the meantime takes effect without a restart.
pub async fn app_recheck_git(core: &Core) -> CoreResult<AppInfo> {
    core.recheck_git().await;
    app_info(core).await
}

// ---------------------------------------------------------------------------
// Closing the window
// ---------------------------------------------------------------------------

/// What applies when the window is closed. The UI reports via `app_close_guard` whether something
/// would be lost (unsaved text in the editor, a running action); the window (src-tauri) asks here
/// before it closes and otherwise sends `app:close_requested`.
#[derive(Default)]
pub struct CloseGuard {
    state: parking_lot::Mutex<CloseState>,
}

#[derive(Default)]
struct CloseState {
    /// The UI has something to lose.
    active: bool,
    /// The user confirmed quitting (`app_quit`).
    quitting: bool,
    /// When the UI was last asked without having reported back since.
    asked: Option<std::time::Instant>,
}

/// How long the UI has to react to `app:close_requested`. If it does not answer (it hangs or has
/// crashed), the next close closes the window anyway.
const CLOSE_ANSWER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);

impl CloseGuard {
    /// For the window: `true` = do not close, let the UI ask instead.
    pub fn intercept(&self) -> bool {
        let mut state = self.state.lock();
        if state.quitting || !state.active {
            return false;
        }
        if state.asked.is_some_and(|at| at.elapsed() > CLOSE_ANSWER_TIMEOUT) {
            // Already asked once, no reaction: the user can always get out of the app.
            return false;
        }
        state.asked.get_or_insert_with(std::time::Instant::now);
        true
    }

    /// Whether quitting is confirmed.
    pub fn quitting(&self) -> bool {
        self.state.lock().quitting
    }
}

/// The UI reports whether something would be lost when the window is closed. Every call also
/// counts as a sign of life for an open request from the window.
pub async fn app_close_guard(core: &Core, active: bool) -> CoreResult<()> {
    let guard = core.state::<CloseGuard>();
    let mut state = guard.state.lock();
    state.active = active;
    state.asked = None;
    Ok(())
}

/// Quitting is confirmed (or there is nothing to lose): running actions are cancelled so that no
/// Git process keeps running without the app and a half-finished clone gets cleaned up; then
/// the window closes without another prompt.
pub async fn app_quit(core: &Core) -> CoreResult<()> {
    core.state::<CloseGuard>().state.lock().quitting = true;
    stop_running_jobs(core).await;
    Ok(())
}

/// Cancels all running jobs and waits briefly until they have cleaned up.
pub async fn stop_running_jobs(core: &Core) {
    if core.jobs.cancel_all() == 0 {
        return;
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
    while core.jobs.running() > 0 && std::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::TestCore;

    /// The window closes without a prompt only when there is nothing to lose; a UI that does not
    /// answer does not hold the user captive.
    #[tokio::test]
    async fn close_guard_asks_only_when_there_is_something_to_lose() {
        let tc = TestCore::new().await;
        let guard = tc.state::<CloseGuard>();
        assert!(!guard.intercept(), "without a report from the UI the window closes");
        app_close_guard(&tc, true).await.unwrap();
        assert!(guard.intercept(), "with unsaved work it asks");
        assert!(guard.intercept(), "also on a second close right after");
        // The UI does not react: after the timeout the window closes anyway.
        guard.state.lock().asked = Some(std::time::Instant::now() - CLOSE_ANSWER_TIMEOUT - std::time::Duration::from_secs(1));
        assert!(!guard.intercept());
        // A sign of life from the UI restores the protection.
        app_close_guard(&tc, true).await.unwrap();
        assert!(guard.intercept());
        app_quit(&tc).await.unwrap();
        assert!(!guard.intercept() && guard.quitting(), "after confirmation it closes");
    }

    #[tokio::test]
    async fn reports_git_and_data_dir() {
        let tc = TestCore::new().await;
        let info = app_info(&tc).await.unwrap();
        assert_eq!(info.version, "0.0.0-test");
        assert_eq!(info.git_min_version, "2.39");
        assert!(info.git_version.is_some());
        assert!(info.git_path.is_some());
        assert_eq!(info.platform, Platform::current());
        assert!(!info.data_dir.is_empty());
    }

    #[tokio::test]
    async fn without_git() {
        let tc = TestCore::with_git_path(std::path::PathBuf::from("/nicht/vorhanden/git")).await;
        let info = app_info(&tc).await.unwrap();
        assert!(info.git_version.is_none());
        let err = tc.git_at(tc.data_dir()).args(["status"]).run().await.unwrap_err();
        assert_eq!(err.code, crate::ErrorCode::GitMissing);
    }

    /// A program that pretends to be an old Git.
    fn fake_git(dir: &std::path::Path, version: &str) -> std::path::PathBuf {
        #[cfg(windows)]
        {
            let path = dir.join("git.cmd");
            std::fs::write(&path, format!("@echo git version {version}\r\n")).unwrap();
            path
        }
        #[cfg(not(windows))]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = dir.join("git");
            std::fs::write(&path, format!("#!/bin/sh\necho git version {version}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        }
    }

    #[tokio::test]
    async fn recheck_finds_git_installed_after_the_start() {
        let dir = tempfile::tempdir().unwrap();
        let later = dir.path().join("später");
        std::fs::create_dir_all(&later).unwrap();
        let name = if cfg!(windows) { "git.cmd" } else { "git" };
        let tc = TestCore::with_git_path(later.join(name)).await;
        let info = app_recheck_git(&tc).await.unwrap();
        assert!(info.git_version.is_none(), "not installed yet");
        assert_eq!(tc.git_at(tc.data_dir()).args(["status"]).run().await.unwrap_err().code, crate::ErrorCode::GitMissing);

        // "Installed": first too old, then suitable.
        let old = fake_git(&later, "2.30.0");
        let info = app_recheck_git(&tc).await.unwrap();
        assert_eq!(info.git_version.as_deref(), Some("2.30.0"));
        assert_eq!(tc.git_at(tc.data_dir()).args(["status"]).run().await.unwrap_err().code, crate::ErrorCode::GitTooOld);
        std::fs::remove_file(old).unwrap();
        fake_git(&later, "2.50.1");
        // Linux: if a parallel test is forking right now, its child holds the write descriptor of
        // the script just written until exec, and starting it briefly fails with ETXTBSY.
        let mut info = app_recheck_git(&tc).await.unwrap();
        for _ in 0..20 {
            if info.git_version.is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            info = app_recheck_git(&tc).await.unwrap();
        }
        assert_eq!(info.git_version.as_deref(), Some("2.50.1"));
        assert_eq!(tc.git.info().unwrap().version_text, "2.50.1", "the following calls use the new Git");
        assert_eq!(app_info(&tc).await.unwrap(), info);
    }

    #[tokio::test]
    async fn too_old_git_is_reported_with_its_version() {
        let dir = tempfile::tempdir().unwrap();
        let tc = TestCore::with_git_path(fake_git(dir.path(), "2.30.1.windows.1")).await;
        let info = app_info(&tc).await.unwrap();
        assert_eq!(info.git_version.as_deref(), Some("2.30.1"));
        assert!(info.git_path.is_some());
        let err = tc.git_at(tc.data_dir()).args(["status"]).run().await.unwrap_err();
        assert_eq!(err.code, crate::ErrorCode::GitTooOld);
    }
}
