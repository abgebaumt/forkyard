//! Tests of the Git runner against real Git.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::error::ErrorCode;
use crate::events::names;
use crate::jobs::CancelToken;
use crate::model::{ActivityScope, RepoChange};
use crate::testkit::{TestCore, TestRemote, TestRepo};

#[tokio::test]
async fn run_returns_bytes_and_logs() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    tc.events.clear();

    let out = tc.git_for(&id).unwrap().args(["rev-parse", "HEAD"]).read_only().run().await.unwrap();
    assert!(out.success());
    assert_eq!(out.stdout_text(), repo.head());
    assert_eq!(out.stdout.last(), Some(&b'\n'));

    let logs = tc.events.named(names::LOG_APPENDED);
    assert_eq!(logs.len(), 1);
    assert_eq!(logs[0]["command"], "git rev-parse HEAD");
    assert_eq!(logs[0]["exitCode"], 0);
    assert_eq!(logs[0]["scope"], "repo");
    assert_eq!(logs[0]["repoId"], id.as_str());
    let page = tc.db.with(|c| crate::db::activity::page(c, ActivityScope::Repo, Some(&id), None, 10)).unwrap();
    assert_eq!(page.entries.len(), 1);
    assert_eq!(page.entries[0].id, logs[0]["id"].as_str().unwrap());

    // Without logging
    tc.events.clear();
    tc.git_for(&id).unwrap().args(["rev-parse", "HEAD"]).no_log().run().await.unwrap();
    assert_eq!(tc.events.count(names::LOG_APPENDED), 0);
}

#[tokio::test]
async fn output_is_independent_of_user_language_and_z_works() {
    let tc = TestCore::new().await;
    let repo = TestRepo::new();
    repo.write_file("mit leerzeichen.txt", "a");
    repo.write_file("ümlaut.txt", "b");
    repo.commit("Dateien");
    let id = tc.open(&repo).await.repo.id;
    let out = tc.git_for(&id).unwrap().args(["ls-files", "-z"]).read_only().run().await.unwrap();
    let names: Vec<String> = out.stdout_z().iter().map(|b| String::from_utf8_lossy(b).into_owned()).collect();
    assert_eq!(names, vec!["mit leerzeichen.txt", "ümlaut.txt"]);
}

#[tokio::test]
async fn failure_is_classified_and_raw_mode_is_not() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;

    let err = tc.git_for(&id).unwrap().args(["rev-parse", "--verify", "gibt-es-nicht"]).run().await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Unknown, "{err:?}");
    assert!(err.git_output.is_some());
    assert!(err.message.contains("rev-parse"));

    let err = tc.git_for(&id).unwrap().args(["branch", "main"]).run().await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NameExists);
    let err = tc.git_for(&id).unwrap().args(["branch", "a..b"]).run().await.unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidName);
    let err = tc.git_for(&id).unwrap().args(["checkout", "gibt-es-nicht"]).run().await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);

    let out = tc.git_for(&id).unwrap().args(["rev-parse", "--verify", "gibt-es-nicht"]).run_raw().await.unwrap();
    assert!(!out.success());
    assert!(!out.stderr.is_empty());

    // Not a repository
    let dir = tempfile::tempdir().unwrap();
    let err = tc.git_at(dir.path()).args(["status", "--porcelain=v2"]).run().await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotARepo);
    // Folder missing
    let err = tc.git_at(dir.path().join("weg")).args(["status"]).run().await.unwrap_err();
    assert_eq!(err.code, ErrorCode::PathNotFound);
    // Unknown repo ID
    assert_eq!(tc.git_for("unbekannt").err().map(|e| e.code), Some(ErrorCode::NotFound));
}

#[tokio::test]
async fn foreign_index_lock_is_reported_as_locked() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    repo.write_file("neu.txt", "x");
    std::fs::write(repo.path().join(".git").join("index.lock"), "").unwrap();
    let err = tc.git_for(&id).unwrap().args(["add", "neu.txt"]).run().await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Locked, "{err:?}");
    // The foreign lock is never deleted automatically.
    assert!(repo.path().join(".git").join("index.lock").exists());
}

#[tokio::test]
async fn identity_missing_is_detected() {
    let tc = TestCore::new().await;
    let repo = TestRepo::without_identity();
    repo.write_file("a.txt", "a");
    let id = tc.open(&repo).await.repo.id;
    tc.git_for(&id).unwrap().args(["add", "a.txt"]).run().await.unwrap();
    let err = tc
        .git_for(&id)
        .unwrap()
        .args(["-c", "user.useConfigOnly=true", "commit", "-m", "x"])
        .run()
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::IdentityMissing, "{err:?}");
}

#[tokio::test]
async fn stdin_is_passed_byte_exact() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    let data: Vec<u8> = vec![b'a', 0xff, 0x00, b'\r', b'\n', 0xfc];
    let sha = tc
        .git_for(&id)
        .unwrap()
        .args(["hash-object", "-w", "--stdin"])
        .stdin(data.clone())
        .run_text()
        .await
        .unwrap();
    let back = tc.git_for(&id).unwrap().args(["cat-file", "blob", &sha]).read_only().run().await.unwrap();
    assert_eq!(back.stdout, data);
}

#[tokio::test]
async fn records_stream_and_stop_early() {
    let tc = TestCore::new().await;
    let repo = TestRepo::new();
    for i in 0..6 {
        repo.commit_file("a.txt", format!("{i}"), &format!("Commit {i}"));
    }
    let id = tc.open(&repo).await.repo.id;

    let mut all = Vec::new();
    let out = tc
        .git_for(&id)
        .unwrap()
        .args(["log", "-z", "--format=%H"])
        .read_only()
        .run_records(0, None, &mut |rec| {
            all.push(String::from_utf8_lossy(rec).into_owned());
            true
        })
        .await
        .unwrap();
    assert!(out.success());
    assert!(out.stdout.is_empty());
    assert_eq!(all.len(), 6);
    assert_eq!(all[0], repo.head());

    let mut first_two = Vec::new();
    let out = tc
        .git_for(&id)
        .unwrap()
        .args(["log", "-z", "--format=%H"])
        .read_only()
        .run_records(0, None, &mut |rec| {
            first_two.push(String::from_utf8_lossy(rec).into_owned());
            first_two.len() < 2
        })
        .await
        .unwrap();
    assert_eq!(first_two, all[..2].to_vec());
    assert_eq!(out.code, None, "stopping early counts as success without an exit code");
}

#[tokio::test]
async fn stream_reports_progress_lines_of_a_real_clone() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let remote: TestRemote = repo.add_remote();
    let target = tempfile::tempdir().unwrap();
    let token = CancelToken::new();
    let mut lines: Vec<String> = Vec::new();
    let out = tc
        .git_at(target.path())
        .args(["clone", "--progress", &remote.url(), "ziel"])
        .network()
        .run_stream(&token, &mut |line| lines.push(line.to_string()))
        .await
        .unwrap();
    assert!(out.success());
    assert!(target.path().join("ziel").join("README.md").exists());
    assert!(lines.iter().any(|l| l.contains("Cloning into")), "{lines:?}");
}

#[tokio::test]
async fn cancel_kills_the_whole_process_tree() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    let marker = repo.path().join("fertig.txt");

    // Cross-check: without a cancel the child process writes the file.
    tc.git_for(&id)
        .unwrap()
        .args(["-c", "alias.warte=!sleep 0; echo fertig > fertig.txt", "warte"])
        .run_stream(&CancelToken::new(), &mut |_| {})
        .await
        .unwrap();
    assert!(marker.exists(), "cross-check: the alias wrote nothing");
    std::fs::remove_file(&marker).unwrap();

    let token = CancelToken::new();
    let t2 = token.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(400)).await;
        t2.cancel();
    });
    let started = Instant::now();
    // An alias with "!" starts a shell as a child process of Git – like a hook or ssh.
    let err = tc
        .git_for(&id)
        .unwrap()
        .args(["-c", "alias.warte=!sleep 3; echo fertig > fertig.txt", "warte"])
        .run_stream(&token, &mut |_| {})
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Cancelled);
    assert!(started.elapsed() < Duration::from_millis(2500), "cancel came too late: {:?}", started.elapsed());
    tokio::time::sleep(Duration::from_millis(3200)).await;
    assert!(!marker.exists(), "the child process kept running after the cancel");
}

#[tokio::test]
async fn background_child_holding_the_pipes_does_not_hang() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    // Baseline: the same alias without a background process. Under load (many parallel
    // tests, other builds) just starting Git and sh takes noticeable time; so what is measured
    // is the difference to that, not a fixed duration.
    let started = Instant::now();
    let plain = tc.git_for(&id).unwrap().args(["-c", "alias.vorn=!echo vorn", "vorn"]).run().await.unwrap();
    assert_eq!(plain.stdout_text(), "vorn");
    let baseline = started.elapsed();

    // The background process inherits stdout/stderr and lives much longer than Git (like
    // gc --auto or a hook with "&"). Without the runner's grace period the call would only
    // return after it ends, i.e. after 30 s.
    const BACKGROUND_SECS: u64 = 30;
    let started = Instant::now();
    let out = tc
        .git_for(&id)
        .unwrap()
        .args(["-c", &format!("alias.hintergrund=!(cd / && sleep {BACKGROUND_SECS} &) ; echo vorn"), "hintergrund"])
        .run()
        .await
        .unwrap();
    let elapsed = started.elapsed();
    assert_eq!(out.stdout_text(), "vorn");
    assert!(out.success());
    // Generous towards load, but far below the background process's lifetime.
    let limit = (baseline * 4 + Duration::from_secs(5)).min(Duration::from_secs(BACKGROUND_SECS / 2));
    assert!(elapsed < limit, "hung on the open pipes: {elapsed:?} (without background process: {baseline:?}, limit {limit:?})");
}

#[tokio::test]
async fn timeout_ends_the_process() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    let started = Instant::now();
    let err = tc
        .git_for(&id)
        .unwrap()
        .args(["-c", "alias.warte=!sleep 5", "warte"])
        .timeout(Duration::from_millis(300))
        .run()
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Timeout);
    assert!(started.elapsed() < Duration::from_secs(3));

    let started = Instant::now();
    let err = tc
        .git_for(&id)
        .unwrap()
        .args(["-c", "alias.warte=!sleep 5", "warte"])
        .idle_timeout(Duration::from_millis(300))
        .run()
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::Timeout);
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[tokio::test]
async fn credentials_never_reach_log_or_error() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    tc.events.clear();
    let url = "https://anna:supergeheim@invalid.invalid/x.git";
    let err = tc
        .git_for(&id)
        .unwrap()
        .args(["-c", "http.lowSpeedTime=1", "ls-remote", url])
        .timeout(Duration::from_secs(20))
        .run()
        .await
        .unwrap_err();
    let shown = format!("{} {}", err.message, err.git_output.clone().unwrap_or_default());
    assert!(!shown.contains("supergeheim"), "{shown}");
    let logs = tc.events.named(names::LOG_APPENDED);
    assert_eq!(logs.len(), 1);
    let text = logs[0].to_string();
    assert!(!text.contains("supergeheim"), "{text}");
    assert!(!text.contains("anna"), "{text}");
    assert!(logs[0]["command"].as_str().unwrap().contains("https://***@invalid.invalid/x.git"));
}

#[tokio::test]
async fn write_lock_serializes_per_repo_and_emits() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    tc.events.clear();

    let running = Arc::new(AtomicUsize::new(0));
    let max = Arc::new(AtomicUsize::new(0));
    let mut handles = Vec::new();
    for _ in 0..4 {
        let core = tc.core.clone();
        let id = id.clone();
        let running = running.clone();
        let max = max.clone();
        handles.push(tokio::spawn(async move {
            core.with_write_lock(&id, &[RepoChange::Index, RepoChange::Index, RepoChange::Worktree], async {
                let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                max.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(30)).await;
                running.fetch_sub(1, Ordering::SeqCst);
                Ok(())
            })
            .await
        }));
    }
    for h in handles {
        h.await.unwrap().unwrap();
    }
    assert_eq!(max.load(Ordering::SeqCst), 1, "two write actions ran at the same time");
    let changed = tc.events.named(names::REPO_CHANGED);
    assert_eq!(changed.len(), 4);
    assert_eq!(changed[0]["repoId"], id.as_str());
    assert_eq!(changed[0]["what"], serde_json::json!(["worktree", "index"]));

    // Different repos don't block each other.
    let guard = tc.write_lock(&id).await;
    let other = tokio::time::timeout(Duration::from_secs(1), tc.write_lock("anderes-repo")).await;
    assert!(other.is_ok());
    drop(guard);

    // repo:changed is reported even on an error.
    tc.events.clear();
    let r: crate::CoreResult<()> = tc
        .with_write_lock(&id, &[RepoChange::Refs], async { Err(crate::CoreError::unknown("x")) })
        .await;
    assert!(r.is_err());
    assert_eq!(tc.events.count(names::REPO_CHANGED), 1);
}

#[tokio::test]
async fn op_ids_are_idempotent() {
    let tc = TestCore::new().await;
    let counter = AtomicUsize::new(0);
    let first = tc
        .idempotent("op-1", async {
            counter.fetch_add(1, Ordering::SeqCst);
            Ok(1)
        })
        .await;
    assert_eq!(first.unwrap(), 1);
    let second: crate::CoreResult<i32> = tc
        .idempotent("op-1", async {
            counter.fetch_add(1, Ordering::SeqCst);
            Ok(2)
        })
        .await;
    assert_eq!(second.unwrap_err().code, ErrorCode::Duplicate);
    assert_eq!(counter.load(Ordering::SeqCst), 1);

    // After an error the same op_id is allowed again.
    let failed: crate::CoreResult<i32> = tc.idempotent("op-2", async { Err(crate::CoreError::unknown("x")) }).await;
    assert!(failed.is_err());
    assert_eq!(tc.idempotent("op-2", async { Ok(3) }).await.unwrap(), 3);
}

#[tokio::test]
async fn repo_path_errors() {
    let tc = TestCore::new().await;
    assert_eq!(tc.repo_path("unbekannt").unwrap_err().code, ErrorCode::NotFound);
    let repo = TestRepo::with_commit();
    let opened = tc.open(&repo).await;
    assert!(tc.repo_path(&opened.repo.id).is_ok());
    let moved = repo.temp_dir().join("verschoben");
    std::fs::rename(repo.path(), &moved).unwrap();
    assert_eq!(tc.repo_path(&opened.repo.id).unwrap_err().code, ErrorCode::PathNotFound);
    std::fs::rename(&moved, repo.path()).unwrap();
}

#[tokio::test]
async fn module_state_is_shared() {
    #[derive(Default)]
    struct Counter(AtomicUsize);
    let tc = TestCore::new().await;
    tc.state::<Counter>().0.fetch_add(2, Ordering::SeqCst);
    assert_eq!(tc.core.clone().state::<Counter>().0.load(Ordering::SeqCst), 2);
}

/// A foreign index.lock that disappears after a short time (a `git status` in the editor):
/// the write command waits and succeeds instead of reporting `locked` right away.
#[tokio::test]
async fn short_lived_foreign_index_lock_is_waited_out() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    repo.write_file("neu.txt", "x\n");
    let id = tc.open(&repo).await.repo.id;
    let lock = repo.path().join(".git").join("index.lock");
    std::fs::write(&lock, "").unwrap();
    let remover = {
        let lock = lock.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(400)).await;
            std::fs::remove_file(lock).unwrap();
        })
    };
    let started = Instant::now();
    tc.git_for(&id).unwrap().args(["add", "neu.txt"]).run().await.unwrap();
    assert!(started.elapsed() >= Duration::from_millis(300), "{:?}", started.elapsed());
    remover.await.unwrap();
    assert_eq!(repo.git(&["ls-files", "neu.txt"]), "neu.txt");

    // The same in raw mode (exit code is interpreted by the caller).
    repo.write_file("zwei.txt", "y\n");
    std::fs::write(&lock, "").unwrap();
    let remover = {
        let lock = lock.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            std::fs::remove_file(lock).unwrap();
        })
    };
    let out = tc.git_for(&id).unwrap().args(["add", "zwei.txt"]).run_raw().await.unwrap();
    remover.await.unwrap();
    assert!(out.success(), "{}", out.stderr_text());
}

/// If the lock stays, `locked` comes after the waiting time – and the file stays where it is.
#[tokio::test]
async fn lasting_foreign_index_lock_is_reported_and_never_removed() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    repo.write_file("neu.txt", "x\n");
    let id = tc.open(&repo).await.repo.id;
    let lock = repo.path().join(".git").join("index.lock");
    std::fs::write(&lock, "fremd").unwrap();

    let started = Instant::now();
    let err = tc.git_for(&id).unwrap().args(["add", "neu.txt"]).run().await.unwrap_err();
    let waited = started.elapsed();
    assert_eq!(err.code, ErrorCode::Locked);
    assert!(waited >= crate::git::runner::LOCK_RETRY_WINDOW, "{waited:?}");
    assert!(waited < crate::git::runner::LOCK_RETRY_WINDOW + Duration::from_secs(8), "{waited:?}");
    assert_eq!(std::fs::read(&lock).unwrap(), b"fremd");
    assert_eq!(repo.git(&["ls-files", "neu.txt"]), "");

    // Read commands never wait, and multi-step commands are not repeated. What is checked is the
    // decision itself and not the run time: when all tests run at once, two Git calls take
    // longer than the window even without any waiting (measured: 2.2 s).
    assert!(tc.git_for(&id).unwrap().args(["add", "neu.txt"]).retries_on_lock());
    let status = tc.git_for(&id).unwrap().args(["status", "--porcelain=v2"]).read_only();
    assert!(!status.retries_on_lock());
    status.run().await.unwrap();
    let stash = tc.git_for(&id).unwrap().args(["stash", "push", "-u"]);
    assert!(!stash.retries_on_lock());
    let err = stash.run().await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Locked, "{err:?}");
    assert_eq!(std::fs::read(&lock).unwrap(), b"fremd");
}

#[tokio::test]
async fn log_entries_carry_the_error_code_and_the_forced_ssh_key() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let _remote = repo.add_remote();
    let id = tc.open(&repo).await.repo.id;
    tc.events.clear();

    // Success: no code. Failure: the same code as in the error.
    tc.git_for(&id).unwrap().args(["rev-parse", "HEAD"]).run().await.unwrap();
    let err = tc.git_for(&id).unwrap().args(["checkout", "gibt-es-nicht"]).run().await.unwrap_err();
    // Even without checking the exit code the classification is in the log.
    tc.git_for(&id).unwrap().args(["checkout", "gibt-es-auch-nicht"]).run_raw().await.unwrap();
    let logs = tc.events.named(names::LOG_APPENDED);
    assert_eq!(logs.len(), 3);
    assert!(logs[0]["code"].is_null(), "{}", logs[0]);
    assert_eq!(logs[1]["code"], err.code.as_str());
    assert_eq!(logs[2]["code"], err.code.as_str());
    let page = tc.db.with(|c| crate::db::activity::page(c, ActivityScope::Repo, Some(&id), None, 10)).unwrap();
    assert_eq!(page.entries[1].code, Some(err.code), "also read from the database");
    assert_eq!(page.entries[2].code, None);

    // Without a forced key a network call names none.
    tc.events.clear();
    tc.git_for(&id).unwrap().args(["fetch", "origin"]).network().run().await.unwrap();
    let output = tc.events.named(names::LOG_APPENDED)[0]["output"].as_str().unwrap().to_string();
    assert!(!output.contains(crate::git::runner::SSH_KEY_NOTE_PREFIX), "{output}");

    // "Use SSH agent" off and a default key: the last line names its path –
    // only for network calls, and never anything other than the path.
    let key = repo.temp_dir().join("id_test");
    std::fs::write(&key, "kein echter Schlüssel").unwrap();
    let key_text = key.to_string_lossy().into_owned();
    tc.db
        .tx(|tx| {
            let profile = crate::db::profiles::active_id(tx)?;
            let key_id = crate::db::ssh_keys::insert(tx, &profile, "Test", &key_text, &format!("{key_text}.pub"))?;
            crate::db::ssh_keys::set_default(tx, &profile, Some(&key_id))
        })
        .unwrap();
    crate::commands::settings::settings_set(&tc, serde_json::json!({ "sshUseAgent": false })).await.unwrap();
    tc.events.clear();
    tc.git_for(&id).unwrap().args(["fetch", "origin"]).network().run().await.unwrap();
    tc.git_for(&id).unwrap().args(["rev-parse", "HEAD"]).run().await.unwrap();
    let logs = tc.events.named(names::LOG_APPENDED);
    let network = logs[0]["output"].as_str().unwrap();
    let expected = format!("{}{}", crate::git::runner::SSH_KEY_NOTE_PREFIX, crate::util::display_path(&key));
    assert_eq!(network.lines().last(), Some(expected.as_str()), "{network}");
    assert!(!network.contains("kein echter Schlüssel"));
    assert!(!logs[1]["output"].as_str().unwrap().contains(crate::git::runner::SSH_KEY_NOTE_PREFIX), "local calls name no key");
}

#[tokio::test]
async fn network_settings_are_validated_and_become_scoped_options() {
    use crate::commands::settings::{settings_get, settings_set};
    let tc = TestCore::new().await;
    assert!(tc.git.network_config().settings.is_empty(), "nothing out of the box");

    // A wildcard instead of a host, a broken proxy and a missing CA file are rejected – nothing is saved.
    for bad in [
        serde_json::json!({ "sslNoVerifyHosts": ["*"] }),
        serde_json::json!({ "sslNoVerifyHosts": ["*.example.com"] }),
        serde_json::json!({ "proxyUrl": "proxy:8080" }),
        serde_json::json!({ "proxyByHost": [{ "host": "", "proxy": "http://p:1" }] }),
    ] {
        let err = settings_set(&tc, bad.clone()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed, "{bad}");
    }
    let missing = tc.data_dir().join("fehlt.pem").to_string_lossy().into_owned();
    assert_eq!(settings_set(&tc, serde_json::json!({ "sslCaFile": missing })).await.unwrap_err().code, ErrorCode::PathNotFound);
    assert!(tc.git.network_config().settings.is_empty());

    let ca = tc.data_dir().join("firma.pem");
    std::fs::write(&ca, "-----BEGIN CERTIFICATE-----\n").unwrap();
    let ca_text = ca.to_string_lossy().into_owned();
    let saved = settings_set(
        &tc,
        serde_json::json!({
            "proxyUrl": " http://anna:geheim@proxy.example:8080 ",
            "proxyByHost": [{ "host": "Git.Intern.example:8443", "proxy": "" }],
            "sslCaFile": ca_text,
            "sslNoVerifyHosts": ["git.intern.example", "https://git.intern.example/pfad"],
        }),
    )
    .await
    .unwrap();
    // The UI and the settings table get the address without the password (that lives in the
    // keychain); Git gets it in full further down.
    assert_eq!(saved.proxy_url.as_deref(), Some("http://anna@proxy.example:8080"));
    assert_eq!(saved.proxy_by_host[0].host, "https://git.intern.example:8443");
    assert_eq!(saved.ssl_no_verify_hosts, vec!["https://git.intern.example"], "normalized and without duplicates");
    assert_eq!(settings_get(&tc).await.unwrap(), saved);
    let config = tc.git.network_config();
    assert_eq!(
        config.settings,
        vec![
            "http.proxy=http://anna:geheim@proxy.example:8080".to_string(),
            "http.https://git.intern.example:8443/.proxy=".to_string(),
            format!("http.sslCAInfo={ca_text}"),
            "http.schannelUseSSLCAInfo=true".to_string(),
            "http.https://git.intern.example/.sslVerify=false".to_string(),
        ]
    );
    assert!(!config.settings.iter().any(|s| s.to_lowercase().starts_with("http.sslverify")), "never global");

    // Reset: null or empty lists take everything away again.
    settings_set(&tc, serde_json::json!({ "proxyUrl": null, "proxyByHost": [], "sslCaFile": null, "sslNoVerifyHosts": [] })).await.unwrap();
    assert!(tc.git.network_config().settings.is_empty());
}

/// A bit of a proxy: accepts connections and remembers the head of every request. Without
/// authentication it demands some (407, Basic) – that shows whether Git really knows the proxy
/// password –, with authentication it answers with 502.
async fn fake_proxy() -> (u16, Arc<parking_lot::Mutex<Vec<String>>>, tokio::task::JoinHandle<()>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let seen = Arc::new(parking_lot::Mutex::new(Vec::<String>::new()));
    let seen_by_server = seen.clone();
    let server = tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let mut buffer = vec![0u8; 4096];
            let n = stream.read(&mut buffer).await.unwrap_or(0);
            let head = String::from_utf8_lossy(&buffer[..n]).split("\r\n\r\n").next().unwrap_or("").to_string();
            let reply: &[u8] = if head.to_ascii_lowercase().contains("proxy-authorization:") {
                b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            } else {
                b"HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"test\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            };
            seen_by_server.lock().push(head);
            let _ = stream.write_all(reply).await;
        }
    });
    (port, seen, server)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn proxy_setting_reaches_git_for_network_calls_only() {
    use crate::commands::settings::settings_set;
    let tc = TestCore::new().await;
    let (port, seen, server) = fake_proxy().await;
    let dir = tc.data_dir().to_path_buf();
    let via_proxy = |seen: &Arc<parking_lot::Mutex<Vec<String>>>| seen.lock().iter().filter(|line| line.contains("ueber-proxy.invalid")).count();

    // Without the setting nothing goes through the proxy.
    let call = || tc.git_at(&dir).args(["ls-remote", "http://ueber-proxy.invalid/x.git"]).network().no_prompt().timeout(Duration::from_secs(60));
    assert!(!call().run_raw().await.unwrap().success());
    assert_eq!(via_proxy(&seen), 0);

    settings_set(
        &tc,
        serde_json::json!({
            "proxyUrl": format!("http://anna:geheim@127.0.0.1:{port}"),
            // This host explicitly bypasses the proxy.
            "proxyByHost": [{ "host": "http://127.0.0.1:9", "proxy": "" }],
        }),
    )
    .await
    .unwrap();
    tc.events.clear();
    let out = call().run_raw().await.unwrap();
    assert!(!out.success(), "the fake proxy answers with 502");
    assert!(via_proxy(&seen) >= 1, "the request reached the proxy: {:?}", seen.lock());
    // Git knows the proxy password (anna:geheim) – even though it is no longer on the command
    // line but comes through the environment (GIT_CONFIG_COUNT/KEY/VALUE).
    assert!(seen.lock().iter().any(|head| head.contains("Proxy-Authorization: Basic YW5uYTpnZWhlaW0=")), "proxy authentication missing: {:?}", seen.lock());
    let argv = call().argv().join(" ");
    assert!(!argv.contains("geheim") && !argv.contains("http.proxy"), "{argv}");
    // The log says that a proxy applied – without its password, and not in the command line.
    let log = &tc.events.named(names::LOG_APPENDED)[0];
    assert_eq!(log["command"], "git ls-remote http://ueber-proxy.invalid/x.git");
    let output = log["output"].as_str().unwrap();
    assert!(output.contains(&format!("Proxy: http://***@127.0.0.1:{port}")), "{output}");
    assert!(!output.contains("geheim"), "{output}");

    // The per-host exception: direct, so nothing at the proxy.
    let before = seen.lock().len();
    let direct = tc.git_at(&dir).args(["ls-remote", "http://127.0.0.1:9/x.git"]).network().no_prompt().timeout(Duration::from_secs(60)).run_raw().await.unwrap();
    assert!(!direct.success());
    assert_eq!(seen.lock().len(), before, "{:?}", seen.lock());

    // Calls that don't run as network calls don't get the settings.
    tc.events.clear();
    tc.git_at(&dir).args(["version"]).run().await.unwrap();
    assert!(!tc.events.named(names::LOG_APPENDED)[0]["output"].as_str().unwrap().contains("Proxy"));
    server.abort();
}
