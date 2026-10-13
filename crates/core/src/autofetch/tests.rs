//! Tests for auto-fetch against a local bare remote that receives new commits in between.
//! "One minute" takes 300 ms here (`FetchTiming.minute`).

use std::io::{Read, Write};
use std::path::Path;
use std::sync::Arc;

use serde_json::json;

use super::*;
use crate::git::compose_ssh_command;
use crate::app::CoreConfig;
use crate::commands::settings::{repo_settings_set, settings_set};
use crate::events::EventCollector;
use crate::testkit::{git_isolation_env, TestCore, TestRemote, TestRepo};

const PATIENCE: Duration = Duration::from_secs(30);
const MINUTE: Duration = Duration::from_millis(300);

fn fast(core: &Core) {
    set_enabled(core, true);
    set_timing(core, FetchTiming { minute: MINUTE, poll: Duration::from_millis(40) });
}

/// SHA of the remote-tracking branch `origin/<name>`, if it exists.
fn tracking(repo: &TestRepo, name: &str) -> Option<String> {
    let out = repo.git_output(&["rev-parse", "--verify", "--quiet", &format!("refs/remotes/origin/{name}")]);
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

async fn wait_until(what: &str, mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + PATIENCE;
    while !check() {
        assert!(Instant::now() < deadline, "did not happen: {what}");
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

/// A colleague pushes a new commit to `main` of the remote.
fn push_commit(colleague: &TestRepo, file: &str) -> String {
    let sha = colleague.commit_file(file, "inhalt\n", &format!("Kollege: {file}"));
    colleague.git(&["push", "-q", "origin", "HEAD:main"]);
    sha
}

fn refs_events(tc: &TestCore, id: &str) -> usize {
    tc.events.named(names::REPO_CHANGED).iter().filter(|e| **e == json!({ "repoId": id, "what": ["refs"] })).count()
}

fn setup_remote() -> (TestRepo, TestRemote, TestRepo) {
    let repo = TestRepo::with_commit();
    let remote = repo.add_remote();
    let colleague = TestRepo::clone_of(&remote);
    (repo, remote, colleague)
}

#[tokio::test]
async fn fetches_new_commits_on_schedule_and_reports_changed_refs() {
    let (repo, _remote, colleague) = setup_remote();
    let tc = TestCore::new().await;
    fast(&tc);
    let id = tc.open(&repo).await.repo.id;
    assert!(is_running(&tc, &id));
    start(&tc, &id).unwrap();
    assert_eq!(tc.state::<AutoFetchers>().running.lock().len(), 1);
    let local_head = repo.head();
    repo.write_file("lokal.txt", "nicht committet\n");
    tc.events.clear();

    let first = push_commit(&colleague, "eins.txt");
    wait_until("origin/main folgt dem Remote", || tracking(&repo, "main").as_deref() == Some(first.as_str())).await;
    wait_until("repo:changed refs", || refs_events(&tc, &id) == 1).await;
    // Only the remote-tracking refs move; branch and working directory stay.
    assert_eq!(repo.head(), local_head);
    assert_eq!(repo.read_file("lokal.txt"), b"nicht committet\n");
    assert!(!repo.path().join("eins.txt").exists());

    // One log entry for the fetch that brought something.
    let logs = tc.events.named(names::LOG_APPENDED);
    assert_eq!(logs.len(), 1, "{logs:?}");
    assert_eq!((&logs[0]["repoId"], &logs[0]["scope"], &logs[0]["exitCode"]), (&json!(id), &json!("repo"), &json!(0)));
    let command = logs[0]["command"].as_str().unwrap();
    assert!(command.contains("fetch --all") && command.ends_with("--prune"), "{command}");
    assert!(logs[0]["output"].as_str().unwrap().contains("origin/main"), "{}", logs[0]["output"]);

    // Nothing new on the remote: further runs, but no event and no log.
    tokio::time::sleep(MINUTE * 5).await;
    assert_eq!(refs_events(&tc, &id), 1);
    assert_eq!(tc.events.count(names::LOG_APPENDED), 1);
    assert_eq!(tc.events.count(names::JOB_PROGRESS) + tc.events.count(names::JOB_DONE), 0);

    // The next commit is fetched again.
    let second = push_commit(&colleague, "zwei.txt");
    wait_until("zweiter Commit", || tracking(&repo, "main").as_deref() == Some(second.as_str())).await;
    wait_until("zweites Event", || refs_events(&tc, &id) == 2).await;

    // After stopping nothing happens any more.
    stop(&tc, &id).unwrap();
    stop(&tc, &id).unwrap();
    stop(&tc, "unbekannt").unwrap();
    assert!(!is_running(&tc, &id));
    push_commit(&colleague, "drei.txt");
    tokio::time::sleep(MINUTE * 5).await;
    assert_eq!(tracking(&repo, "main"), Some(second));
}

#[tokio::test]
async fn off_by_default_in_tests_and_stopped_with_the_last_tab() {
    let (repo, _remote, _colleague) = setup_remote();
    let tc = TestCore::new().await;
    let id = tc.open(&repo).await.repo.id;
    assert!(!is_running(&tc, &id));

    fast(&tc);
    assert_eq!(start(&tc, "unbekannt").unwrap_err().code, ErrorCode::NotFound);
    start(&tc, &id).unwrap();
    assert!(is_running(&tc, &id));
    let tabs = crate::commands::repos::tabs_list(&tc).await.unwrap();
    let tab = tabs.iter().find(|t| t.repo_id.as_deref() == Some(id.as_str())).unwrap();
    crate::commands::repos::tab_close(&tc, tab.id.clone()).await.unwrap();
    assert!(!is_running(&tc, &id));

    // If the repository is forgotten, a running task also ends by itself.
    start(&tc, &id).unwrap();
    crate::commands::repos::repo_forget(&tc, id.clone()).await.unwrap();
    assert!(!is_running(&tc, &id));
}

#[tokio::test]
async fn interval_and_repo_switch_take_effect_without_restart() {
    let (repo, _remote, colleague) = setup_remote();
    let tc = TestCore::new().await;
    settings_set(&tc, json!({ "autoFetchMinutes": 0 })).await.unwrap();
    fast(&tc);
    let id = tc.open(&repo).await.repo.id;
    let before = tracking(&repo, "main");

    // 0 minutes = off.
    let first = push_commit(&colleague, "eins.txt");
    tokio::time::sleep(MINUTE * 5).await;
    assert_eq!(tracking(&repo, "main"), before);
    // Switching on takes effect without a restart.
    settings_set(&tc, json!({ "autoFetchMinutes": 1 })).await.unwrap();
    wait_until("Fetch nach dem Einschalten", || tracking(&repo, "main").as_deref() == Some(first.as_str())).await;

    // Switch off for this repository.
    repo_settings_set(&tc, id.clone(), json!({ "autoFetch": false })).await.unwrap();
    // A fetch that is currently running may still finish before the colleague pushes.
    tokio::time::sleep(MINUTE * 2).await;
    let second = push_commit(&colleague, "zwei.txt");
    tokio::time::sleep(MINUTE * 5).await;
    assert_eq!(tracking(&repo, "main"), Some(first));
    repo_settings_set(&tc, id.clone(), json!({ "autoFetch": true })).await.unwrap();
    wait_until("Fetch nach dem Wiedereinschalten", || tracking(&repo, "main").as_deref() == Some(second.as_str())).await;
    stop(&tc, &id).unwrap();
}

#[tokio::test]
async fn prune_follows_the_setting() {
    let (repo, remote, colleague) = setup_remote();
    colleague.git(&["push", "-q", "origin", "HEAD:alt"]);
    let tc = TestCore::new().await;
    let id = tc.open(&repo).await.repo.id;
    assert_eq!(run_once(&tc, &id).await, FetchOutcome::Fetched { refs_changed: true });
    assert!(tracking(&repo, "alt").is_some());
    remote.git(&["update-ref", "-d", "refs/heads/alt"]);

    settings_set(&tc, json!({ "autoPrune": false })).await.unwrap();
    assert_eq!(run_once(&tc, &id).await, FetchOutcome::Fetched { refs_changed: false });
    assert!(tracking(&repo, "alt").is_some());

    settings_set(&tc, json!({ "autoPrune": true })).await.unwrap();
    tc.events.clear();
    assert_eq!(run_once(&tc, &id).await, FetchOutcome::Fetched { refs_changed: true });
    assert!(tracking(&repo, "alt").is_none());
    assert_eq!(refs_events(&tc, &id), 1);
}

#[tokio::test]
async fn skips_repositories_without_remote_and_busy_ones() {
    let lonely = TestRepo::with_commit();
    let (repo, _remote, colleague) = setup_remote();
    let tc = TestCore::new().await;
    let lonely_id = tc.open(&lonely).await.repo.id;
    let id = tc.open(&repo).await.repo.id;
    tc.events.clear();

    assert_eq!(run_once(&tc, &lonely_id).await, FetchOutcome::Skipped(SkipReason::NoRemote));
    assert!(tc.events.all().is_empty(), "{:?}", tc.events.all());

    // A write action is running: skip instead of waiting.
    let new = push_commit(&colleague, "neu.txt");
    let guard = tc.write_lock(&id).await;
    let started = Instant::now();
    assert_eq!(run_once(&tc, &id).await, FetchOutcome::Skipped(SkipReason::Busy));
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_ne!(tracking(&repo, "main"), Some(new.clone()));

    // Also on schedule: as long as the action runs, nothing is fetched – soon after it ends.
    fast(&tc);
    start(&tc, &id).unwrap();
    tokio::time::sleep(MINUTE * 5).await;
    assert_ne!(tracking(&repo, "main"), Some(new.clone()));
    drop(guard);
    wait_until("Fetch nach Ende der Aktion", || tracking(&repo, "main").as_deref() == Some(new.as_str())).await;
    stop(&tc, &id).unwrap();

    // The fetch itself does not hold on to the write lock.
    assert!(!tc.write_lock_held(&id));

    // A running transfer also (a manual fetch, pull or push holds the network lock,
    // not the write lock) counts as "busy".
    let newer = push_commit(&colleague, "noch-neuer.txt");
    let transfer = tc.network_lock(&id).await;
    assert_eq!(run_once(&tc, &id).await, FetchOutcome::Skipped(SkipReason::Busy));
    assert_ne!(tracking(&repo, "main"), Some(newer.clone()));
    drop(transfer);
    assert_eq!(run_once(&tc, &id).await, FetchOutcome::Fetched { refs_changed: true });
    assert_eq!(tracking(&repo, "main"), Some(newer));
    assert!(tc.try_network_lock(&id).is_some(), "after the auto-fetch the network lock is free again");
}

#[tokio::test]
async fn failures_go_to_the_log_once_and_nowhere_else() {
    let (repo, remote, colleague) = setup_remote();
    let tc = TestCore::new().await;
    let id = tc.open(&repo).await.repo.id;
    let missing = repo.temp_dir().join("gibt-es-nicht.git").to_string_lossy().replace('\\', "/");
    repo.git(&["remote", "set-url", "origin", &missing]);
    tc.events.clear();

    let FetchOutcome::Failed(error) = run_once(&tc, &id).await else { panic!("the fetch should have failed") };
    assert!(!error.message.is_empty());
    let logs = tc.events.named(names::LOG_APPENDED);
    assert_eq!(logs.len(), 1, "{logs:?}");
    let output = logs[0]["output"].as_str().unwrap();
    assert!(output.starts_with("Auto-fetch failed: "), "{output}");
    assert!(output.contains(&error.message));
    assert_eq!(logs[0]["repoId"], json!(id));
    assert!(logs[0]["exitCode"].as_i64().is_some_and(|c| c != 0), "{}", logs[0]);
    // The error code is in the entry: the UI does not have to guess it from the text.
    assert_eq!(logs[0]["code"], json!(error.code.as_str()));
    // No event apart from the log: no toast, no job, no change.
    assert_eq!(tc.events.all().len(), 1, "{:?}", tc.events.all());

    // The same error does not show up in the log again every minute.
    assert!(matches!(run_once(&tc, &id).await, FetchOutcome::Failed(_)));
    assert!(matches!(run_once(&tc, &id).await, FetchOutcome::Failed(_)));
    assert_eq!(tc.events.count(names::LOG_APPENDED), 1);

    // After a success, a new failure is recorded again.
    repo.git(&["remote", "set-url", "origin", &remote.url()]);
    push_commit(&colleague, "neu.txt");
    assert_eq!(run_once(&tc, &id).await, FetchOutcome::Fetched { refs_changed: true });
    repo.git(&["remote", "set-url", "origin", &missing]);
    assert!(matches!(run_once(&tc, &id).await, FetchOutcome::Failed(_)));
    assert_eq!(tc.events.count(names::LOG_APPENDED), 3);
    assert!(matches!(run_once(&tc, "unbekannt").await, FetchOutcome::Failed(e) if e.code == ErrorCode::NotFound));
}

#[tokio::test]
async fn empty_repository_foreign_index_lock_and_detached_head() {
    // Empty repository without a commit whose remote already has commits.
    let (_source, remote, colleague) = setup_remote();
    let empty = TestRepo::new();
    empty.git(&["remote", "add", "origin", &remote.url()]);
    let tc = TestCore::new().await;
    let id = tc.open(&empty).await.repo.id;
    assert_eq!(run_once(&tc, &id).await, FetchOutcome::Fetched { refs_changed: true });
    assert!(tracking(&empty, "main").is_some());
    assert!(!empty.git_output(&["rev-parse", "--verify", "--quiet", "HEAD"]).status.success());

    // Detached HEAD and a foreign index.lock do not disturb the fetch; the lock stays untouched.
    let repo = TestRepo::clone_of(&remote);
    repo.git(&["checkout", "-q", "--detach"]);
    let lock = repo.path().join(".git").join("index.lock");
    std::fs::write(&lock, "fremd").unwrap();
    let id = tc.open(&repo).await.repo.id;
    let new = push_commit(&colleague, "neu.txt");
    assert_eq!(run_once(&tc, &id).await, FetchOutcome::Fetched { refs_changed: true });
    assert_eq!(tracking(&repo, "main"), Some(new));
    assert_eq!(std::fs::read(&lock).unwrap(), b"fremd");

    // Likewise in the middle of a merge conflict.
    std::fs::remove_file(&lock).unwrap();
    repo.git(&["checkout", "-q", "-b", "lokal"]);
    repo.commit_file("neu.txt", "anders\n", "Lokal");
    assert!(!repo.merge("origin/main"));
    push_commit(&colleague, "noch eins.txt");
    assert_eq!(run_once(&tc, &id).await, FetchOutcome::Fetched { refs_changed: true });
    assert!(repo.path().join(".git").join("MERGE_HEAD").exists());
}

/// Answers every request with "401 – please sign in" and returns the port.
fn unauthorized_server() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
            let mut request = Vec::new();
            let mut chunk = [0u8; 1024];
            while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => request.extend_from_slice(&chunk[..n]),
                }
            }
            let _ = stream.write_all(
                b"HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"test\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
        }
    });
    port
}

#[tokio::test]
async fn never_asks_for_credentials() {
    let repo = TestRepo::with_commit();
    let port = unauthorized_server();
    repo.git(&["remote", "add", "origin", &format!("http://127.0.0.1:{port}/repo.git")]);

    // An askpass program that leaves traces, registered in all three ways:
    // GIT_ASKPASS, core.askPass and SSH_ASKPASS.
    let dir = tempfile::tempdir().unwrap();
    let marker = dir.path().join("gefragt.txt");
    let script = dir.path().join("askpass.sh");
    let slashes = |p: &Path| p.to_string_lossy().replace('\\', "/");
    std::fs::write(&script, format!("#!/bin/sh\necho gefragt >> '{}'\necho geheim\n", slashes(&marker))).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    repo.git(&["config", "core.askPass", &slashes(&script)]);
    let global = dir.path().join("gitconfig");
    std::fs::write(&global, "").unwrap();
    let events = Arc::new(EventCollector::new());
    let mut config = CoreConfig::new(dir.path().join("data"), "0.0.0-test", events.clone());
    config.git_env = git_isolation_env(&global);
    for (key, value) in [("GIT_ASKPASS", slashes(&script)), ("SSH_ASKPASS", slashes(&script)), ("NO_PROXY", "*".to_string())] {
        config.git_env.push((key.into(), value.into()));
    }
    let core = Core::open(config).await.unwrap();
    let opened = crate::commands::repos::repo_open(&core, repo.path().to_string_lossy().into_owned()).await.unwrap().repo;
    // `core.askPass` in the repository's config is exactly such an entry that the user first
    // has to agree to; the test does so in their place.
    assert!(!opened.trusted, "a registered askpass program is noticed on opening");
    let id = opened.id;
    crate::commands::trust::repo_trust_set(&core, id.clone(), true).await.unwrap();

    // Cross-check: a normal fetch calls the askpass program – so the setup can detect prompts.
    let plain = core.git_for(&id).unwrap().args(["fetch", "--all"]).timeout(PATIENCE).run_raw().await.unwrap();
    assert!(!plain.success());
    assert!(marker.exists(), "the cross-check did not prompt: {}", plain.stderr_text());
    std::fs::remove_file(&marker).unwrap();
    events.clear();

    // Auto-fetch: fails silently at sign-in, without asking anyone.
    let FetchOutcome::Failed(error) = run_once(&core, &id).await else { panic!("without credentials the fetch must fail") };
    assert_eq!(error.code, ErrorCode::AuthFailed, "{error:?}");
    assert!(!marker.exists(), "auto-fetch asked for credentials");
    let logs = events.named(names::LOG_APPENDED);
    assert_eq!(logs.len(), 1);
    assert!(logs[0]["output"].as_str().unwrap().contains("Signing in"), "{}", logs[0]["output"]);
    assert_eq!(events.all().len(), 1);
}

// --- pure functions ---------------------------------------------------------------

#[test]
fn ssh_command_gets_the_no_questions_switch() {
    assert_eq!(compose_ssh_command(None, None, None), "ssh -o BatchMode=yes");
    assert_eq!(compose_ssh_command(Some("ssh -i ~/.ssh/arbeit"), Some("anderes"), Some("drittes")), "ssh -i ~/.ssh/arbeit -o BatchMode=yes");
    assert_eq!(compose_ssh_command(None, Some(" ssh -p 2222 "), Some("drittes")), "ssh -p 2222 -o BatchMode=yes");
    assert_eq!(compose_ssh_command(None, None, Some("/usr/local/bin/mein ssh")), "'/usr/local/bin/mein ssh' -o BatchMode=yes");
    assert_eq!(compose_ssh_command(None, None, Some("/opt/it's/ssh")), r"'/opt/it'\''s/ssh' -o BatchMode=yes");
    // PuTTY does not know "-o".
    assert_eq!(compose_ssh_command(None, None, Some(r"C:\Program Files\PuTTY\plink.exe")), r"'C:\Program Files\PuTTY\plink.exe' -batch");
    assert_eq!(compose_ssh_command(Some(r#""C:\Tools\TortoiseGitPlink.exe" -v"#), None, None), r#""C:\Tools\TortoiseGitPlink.exe" -v -batch"#);
}

#[test]
fn progress_noise_is_removed_from_the_log_text() {
    let stderr = b"Fetching origin\nremote: Counting objects:  50% (1/2)\rremote: Counting objects: 100% (2/2), done.\nReceiving objects:  10% (1/10)\rReceiving objects: 100% (10/10), done.\r\nFrom https://bob:geheim@example.com/r\n   abc..def  main       -> origin/main\n\n";
    let text = clean_progress(stderr);
    assert_eq!(text, "Fetching origin\nFrom https://***@example.com/r\n   abc..def  main       -> origin/main");
    assert_eq!(clean_progress(b""), "");
}

