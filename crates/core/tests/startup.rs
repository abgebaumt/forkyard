//! What the UI asks for at startup must never wait for slow outside programs: the keychain, an AI
//! command-line tool that takes its time over `--version`, a login shell with a heavy profile. The
//! oracle is ordering, not a stopwatch: the startup reads have all answered while the slow work is
//! demonstrably still running.

use std::path::Path;
use std::time::Duration;

use gitcore::commands::{ai, app, repos, settings};
use gitcore::testkit::{FakeCli, TestCore};
use serde_json::json;

const FAKE: &str = env!("CARGO_BIN_EXE_forkyard-fake-cli");
/// Far longer than the reads may take, far shorter than a test timeout.
const SLOW_MS: u64 = 8_000;

/// The reads the UI makes before it can draw the shell (src/app/App.tsx, queries.ts).
async fn startup_reads(tc: &TestCore) {
    let info = app::app_info(tc).await.expect("app_info");
    assert!(info.git_version.is_some(), "Git found");
    repos::tabs_list(tc).await.expect("tabs_list");
    repos::repo_list(tc).await.expect("repo_list");
    settings::settings_get(tc).await.expect("settings_get");
    ai::ai_status(tc).await.expect("ai_status");
}

/// `app_info` gates the whole UI (StartupScreen). It must not touch the keychain: Secret Service may
/// first have to be started or may hang, and only the screens that store secrets need to know.
#[tokio::test]
async fn app_info_does_not_probe_the_keychain() {
    let tc = TestCore::new().await;
    app::app_info(&tc).await.unwrap();
    assert!(!tc.keyring_probed(), "app_info asked the keychain");
    // The separate command does (and remembers the answer for this run).
    let _ = app::app_keyring_available(&tc).await.unwrap();
    assert!(tc.keyring_probed());
}

/// An AI command-line tool that hangs on every call (8 s; Forkyard gives up on `--version` after 2 s)
/// – the startup reads answer while the AI setup's detection still waits for it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_slow_ai_tool_does_not_delay_the_startup_reads() {
    let tc = TestCore::new().await;
    std::fs::create_dir_all(tc.cli_dir()).unwrap();
    let slow = json!({ "rules": [], "fallback": { "exit": 0, "stdout": "2.1.301 (Claude Code)\n", "sleepMs": SLOW_MS } });
    let claude = FakeCli::install(Path::new(FAKE), &tc.cli_dir(), "claude", &slow);

    let core = (*tc).clone();
    let detection = tokio::spawn(async move { ai::ai_detect(&core).await });
    // Until the tool has really been started, "still running" would prove nothing.
    let started = tokio::time::timeout(Duration::from_secs(20), async {
        while claude.calls().is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert!(started.is_ok(), "the detection never started the tool");

    startup_reads(&tc).await;
    assert!(!detection.is_finished(), "the reads only answered after the slow tool");
    detection.abort();
}

/// The login shell's PATH (read once per start in the background) with a profile that takes 8 s
/// (Forkyard waits at most 2 s): the startup reads don't wait for it.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_slow_login_shell_does_not_delay_the_startup_reads() {
    use std::os::unix::fs::PermissionsExt;
    let tc = TestCore::new().await;
    let dir = tempfile::tempdir().unwrap();
    let shell = dir.path().join("slow-sh");
    let marker = dir.path().join("started");
    std::fs::write(&shell, format!("#!/bin/sh\ntouch '{}'\nsleep {}\n", marker.display(), SLOW_MS / 1000)).unwrap();
    std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();

    let core = (*tc).clone();
    let path = shell.clone();
    let warm_up = tokio::spawn(async move { gitcore::tools::locate::login_shell_path_from(&core, &path).await });
    let started = tokio::time::timeout(Duration::from_secs(20), async {
        while !marker.exists() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    assert!(started.is_ok(), "the shell never ran");

    startup_reads(&tc).await;
    assert!(!warm_up.is_finished(), "the reads only answered after the login shell");
    warm_up.abort();
}
