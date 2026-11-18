//! Tests for the findings of the security review (SEC-01 … SEC-13) that touch several
//! modules. Each test first shows the hole and then pins down the fix.
//! Tests for a single module live there (prompt.rs, launch.rs, tools.rs, external.rs,
//! redact.rs, netconfig.rs, auth/tests.rs).

use std::path::Path;

use crate::commands::repos::{repo_open, repo_readme};
use crate::commands::settings::{repo_settings_get, settings_set};
use crate::commands::stage::ignore_add;
use crate::commands::status::status_get;
use crate::events::names;
use crate::testkit::{TestCore, TestRepo};

fn file_contains(path: &Path, needle: &str) -> bool {
    match std::fs::read(path) {
        Ok(bytes) => bytes.windows(needle.len()).any(|w| w == needle.as_bytes()),
        Err(_) => false,
    }
}

fn database_contains(tc: &TestCore, needle: &str) -> bool {
    ["forkyard.db", "forkyard.db-wal"].iter().any(|file| file_contains(&tc.data_dir().join(file), needle))
}

/// SEC-01: a repository whose `.git/config` comes from someone else must not run anything
/// on opening. `core.fsmonitor` runs on every `git status`.
#[tokio::test]
async fn sec01_opening_a_foreign_repository_runs_nothing_from_its_config() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    repo.git(&["config", "core.fsmonitor", "touch FSMONITOR-LIEF;:"]);
    let marker = repo.path().join("FSMONITOR-LIEF");
    assert!(!marker.exists());

    let opened = repo_open(&tc, repo.path().to_string_lossy().into_owned()).await.unwrap();
    // The UI asks for the status right away; whether the core refuses that or answers it in
    // a defused way makes no difference here – the configured command must not run.
    let _ = status_get(&tc, opened.repo.id.clone()).await;
    assert!(!marker.exists(), "the command from core.fsmonitor ran");
}

/// SEC-07: the proxy password is neither stored in the database nor sent to the UI.
#[tokio::test]
async fn sec07_proxy_password_is_neither_stored_in_sqlite_nor_returned() {
    let tc = TestCore::new().await;
    let saved = settings_set(
        &tc,
        serde_json::json!({
            "proxyUrl": "http://anna:pr0xy-Geheimnis-7@proxy.firma.example:8080",
            "proxyByHost": [{ "host": "git.intern.example", "proxy": "http://bert:zw3ites-Geheimnis@proxy2.firma.example:3128" }],
        }),
    )
    .await
    .unwrap();
    let shown = serde_json::to_string(&saved).unwrap();
    assert!(!shown.contains("pr0xy-Geheimnis-7") && !shown.contains("zw3ites-Geheimnis"), "{shown}");
    let events = serde_json::to_string(&tc.events.all()).unwrap();
    assert!(!events.contains("pr0xy-Geheimnis-7") && !events.contains("zw3ites-Geheimnis"));
    for secret in ["pr0xy-Geheimnis-7", "zw3ites-Geheimnis"] {
        assert!(!database_contains(&tc, secret), "{secret} is in the database");
    }
    // Git still gets it – through the environment, not through the command line (which other
    // processes on the machine can read).
    let config = tc.git.network_config();
    let env = format!("{:?}", config.env(0));
    assert!(env.contains("pr0xy-Geheimnis-7") && env.contains("zw3ites-Geheimnis"), "{env}");
    let argv = tc.git_at(tc.data_dir()).args(["ls-remote", "https://git.intern.example/x.git"]).network().argv().join(" ");
    assert!(argv.ends_with("ls-remote https://git.intern.example/x.git"), "{argv}");
    assert!(!argv.contains("Geheimnis") && !argv.contains("proxy"), "proxy on the command line: {argv}");
}

/// SEC-08: reading a repository's settings must not write its `.git/config` into the
/// activity log (it may contain e.g. tokens of CI checkouts as extraheader).
#[tokio::test]
async fn sec08_reading_repo_settings_does_not_log_the_local_git_config() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    repo.git(&["config", "http.https://git.example.com/.extraheader", "AUTHORIZATION: basic Z2VoZWltOnRva2VuLTEyMw=="]);
    repo.git(&["config", "sendemail.smtppass", "smtp-Geheimnis-9"]);
    let opened = tc.open(&repo).await;
    tc.events.clear();
    repo_settings_get(&tc, opened.repo.id.clone()).await.unwrap();
    let events = serde_json::to_string(&tc.events.named(names::LOG_APPENDED)).unwrap();
    for secret in ["Z2VoZWltOnRva2VuLTEyMw", "smtp-Geheimnis-9"] {
        assert!(!events.contains(secret), "{secret} im Protokoll-Event: {events}");
        assert!(!database_contains(&tc, secret), "{secret} in the database");
    }
}

/// Creates a symbolic link; `false` if the system does not allow it (Windows without
/// developer mode) – the test is then skipped.
fn symlink_file(target: &Path, link: &Path) -> bool {
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(target, link).is_ok()
    }
    #[cfg(windows)]
    {
        std::os::windows::fs::symlink_file(target, link).is_ok()
    }
}

/// SEC-11: "Ignore" does not write outside through a link named `.gitignore`.
#[tokio::test]
async fn sec11_ignore_add_does_not_write_through_a_symlink() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let outside = repo.temp_dir().join("draussen.txt");
    std::fs::write(&outside, "unberührt\n").unwrap();
    if !symlink_file(&outside, &repo.path().join(".gitignore")) {
        eprintln!("skipped: symbolic links are not allowed here");
        return;
    }
    let opened = tc.open(&repo).await;
    let result = ignore_add(&tc, opened.repo.id.clone(), "build/".into(), false).await;
    assert!(result.is_err(), "a link as .gitignore is rejected");
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "unberührt\n", "the file outside was modified");
}

/// SEC-11: the README preview does not read out of the repository through a link.
#[tokio::test]
async fn sec11_readme_preview_does_not_follow_a_symlink_out_of_the_repository() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let outside = repo.temp_dir().join("geheim.txt");
    std::fs::write(&outside, "nur für mich\n").unwrap();
    repo.remove_file("README.md");
    if !symlink_file(&outside, &repo.path().join("README.md")) {
        eprintln!("skipped: symbolic links are not allowed here");
        return;
    }
    let opened = tc.open(&repo).await;
    let shown = repo_readme(&tc, opened.repo.id.clone()).await.unwrap_or(None);
    assert_ne!(shown.as_deref(), Some("nur für mich\n"), "content from outside in the preview");
}

/// SEC-12: on Unix the data directory and the database belong to the own user only – also
/// a directory that an earlier version created with looser permissions.
#[cfg(unix)]
#[tokio::test]
async fn sec12_data_directory_and_database_are_private() {
    use std::os::unix::fs::PermissionsExt;
    let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
    let tc = TestCore::new().await;
    assert_eq!(mode(tc.data_dir()), 0o700, "Datenverzeichnis");
    assert_eq!(mode(&tc.data_dir().join("forkyard.db")), 0o600, "Datenbank");
    assert_eq!(mode(&tc.data_dir().join(crate::app::GUARD_HOOKS_DIR)), 0o700, "Schutz-Ordner");
    for extra in ["forkyard.db-wal", "forkyard.db-shm"] {
        let path = tc.data_dir().join(extra);
        if path.exists() {
            assert_eq!(mode(&path) & 0o077, 0, "{extra} is not readable by others");
        }
    }
    std::fs::set_permissions(tc.data_dir(), std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::set_permissions(tc.data_dir().join("forkyard.db"), std::fs::Permissions::from_mode(0o644)).unwrap();
    let tc = tc.restart().await;
    assert_eq!(mode(tc.data_dir()), 0o700, "an open data directory is tightened at startup");
    assert_eq!(mode(&tc.data_dir().join("forkyard.db")), 0o600, "likewise the database");
}
