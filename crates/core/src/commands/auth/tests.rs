//! Tests for prompts, keychain and SSH keys.
//!
//! The helper program is played here by a small TCP client that speaks the same protocol;
//! the round trip with the real binary is in `crates/askpass/tests`.
//! The SSH folder is always a temp folder; the keychain has a unique service name and is
//! cleaned up.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

use super::broker::{from_hex, keychain_ref, ssh_command_with_key, to_hex, PORT_ENV, TOKEN_ENV};
use super::prompt::StoreKey;
use super::*;
use crate::commands::settings;
use crate::events::names;
use crate::git::errors;
use crate::model::HostAccountKind;
use crate::testkit::{TestCore, TestRepo};

const SECRET: &str = "s3hr-geheim-Pässwort";

/// Core with a redirected SSH folder, an empty file as "helper program" (so that sessions get
/// a port and token) and without a keychain.
struct Fixture {
    tc: TestCore,
    dir: tempfile::TempDir,
}

impl Fixture {
    async fn new() -> Fixture {
        let tc = TestCore::new().await;
        let dir = tempfile::tempdir().unwrap();
        let helper = dir.path().join("helper-attrappe");
        std::fs::write(&helper, "").unwrap();
        let ssh_dir = dir.path().join("ssh ordner mit ü");
        configure(&tc, |c| {
            c.askpass_path = Some(helper);
            c.ssh_dir = Some(ssh_dir);
            c.keyring_enabled = Some(false);
            c.prompt_timeout = Some(Duration::from_secs(20));
        });
        Fixture { tc, dir }
    }

    fn ssh_dir(&self) -> PathBuf {
        self.dir.path().join("ssh ordner mit ü")
    }

    fn broker(&self) -> std::sync::Arc<Broker> {
        self.tc.git.broker().clone()
    }

    /// Waits for the n-th `credential:request` (counted from 1).
    async fn request(&self, n: usize) -> serde_json::Value {
        for _ in 0..500 {
            let all = self.tc.events.named(names::CREDENTIAL_REQUEST);
            if all.len() >= n {
                return all[n - 1].clone();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("no credential:request number {n}");
    }

    fn request_count(&self) -> usize {
        self.tc.events.count(names::CREDENTIAL_REQUEST)
    }

    /// Request IDs of all `credential:closed` so far.
    fn closed(&self) -> Vec<String> {
        self.tc.events.named(names::CREDENTIAL_CLOSED).iter().map(id_of).collect()
    }

    /// Waits until `credential:closed` arrived for `request_id` (at most 5 s).
    async fn wait_closed(&self, request_id: &str) {
        for _ in 0..500 {
            if self.closed().iter().any(|id| id == request_id) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("no credential:closed for {request_id}: {:?}", self.closed());
    }

    /// `what` of all `app:changed` so far, flattened.
    fn app_changes(&self) -> Vec<String> {
        self.tc
            .events
            .named(names::APP_CHANGED)
            .iter()
            .flat_map(|e| e["what"].as_array().cloned().unwrap_or_default())
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect()
    }
}

/// Keychain with its own service name; clears the named accounts at the end, even if the test
/// fails.
struct TestKeyring {
    service: String,
    accounts: Vec<String>,
    core: Core,
}

impl TestKeyring {
    /// `None` if no keychain on this machine accepts writes (none at all, or locked).
    async fn new(fx: &Fixture) -> Option<TestKeyring> {
        let service = format!("{}{}", keychain::TEST_SERVICE_PREFIX, util::new_id());
        if !keychain::probe_writable(&service).await {
            eprintln!("skipped: no writable keychain reachable");
            return None;
        }
        let name = service.clone();
        configure(&fx.tc, |c| {
            c.keyring_service = Some(name);
            c.keyring_enabled = None;
        });
        Some(TestKeyring { service, accounts: Vec::new(), core: fx.tc.core.clone() })
    }

    fn track(&mut self, profile_id: &str, key: &StoreKey) -> String {
        let account = keychain_ref(profile_id, key);
        self.accounts.push(account.clone());
        account
    }
}

impl Drop for TestKeyring {
    fn drop(&mut self) {
        for account in &self.accounts {
            if let Ok(entry) = keyring::Entry::new(&self.service, account) {
                let _ = entry.delete_credential();
            }
        }
        // And everything else the core has recorded under this service.
        keychain::remove_test_entries(&self.core, &self.service);
    }
}

fn env_value(env: &[(OsString, OsString)], name: &str) -> String {
    env.iter().find(|(k, _)| k == name).map(|(_, v)| v.to_string_lossy().into_owned()).unwrap_or_default()
}

/// Sends a line to the broker and reads the answer: `Some(value)` on "OK", `None` on "NO".
async fn raw_request(port: u16, line: String) -> Option<String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    stream.write_all(line.as_bytes()).await.unwrap();
    let mut reply = String::new();
    BufReader::new(stream).read_line(&mut reply).await.unwrap();
    let reply = reply.trim_end();
    assert!(reply == "NO" || reply.starts_with("OK"), "unerwartete Antwort: {reply}");
    reply.strip_prefix("OK").map(|hex| String::from_utf8(from_hex(hex.trim()).unwrap()).unwrap())
}

/// Plays the helper program: asks the question and returns the answer.
fn helper(session: &Session, prompt: &str) -> tokio::task::JoinHandle<Option<String>> {
    let port: u16 = env_value(session.env(), PORT_ENV).parse().unwrap();
    let token = env_value(session.env(), TOKEN_ENV);
    let line = format!("GCAP1 {token} {}\n", to_hex(prompt.as_bytes()));
    tokio::spawn(raw_request(port, line))
}

fn auth_failed() -> CoreError {
    errors::classify("fetch", Some(128), b"", b"fatal: Authentication failed for 'https://git.example.com/r.git/'")
}

fn id_of(request: &serde_json::Value) -> String {
    request["requestId"].as_str().unwrap().to_string()
}

fn password_key(host: &str, username: &str) -> StoreKey {
    StoreKey { kind: HostAccountKind::Password, host: host.into(), username: username.into() }
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

#[tokio::test]
async fn question_reaches_the_ui_and_the_answer_reaches_the_helper() {
    let fx = Fixture::new().await;
    let session = fx.broker().begin(SessionMode::Interactive).await;
    assert!(session.is_active());
    let env = session.env();
    assert!(env_value(env, "GIT_ASKPASS").ends_with("helper-attrappe"));
    assert_eq!(env_value(env, "GIT_ASKPASS"), env_value(env, "SSH_ASKPASS"));
    assert_eq!(env_value(env, "SSH_ASKPASS_REQUIRE"), "force");
    assert!(!env_value(env, "GIT_ASKPASS").contains('\\'), "path with forward slashes: {}", env_value(env, "GIT_ASKPASS"));
    assert_eq!(env_value(env, TOKEN_ENV).len(), 64);
    assert_eq!(env_value(env, "GCM_INTERACTIVE"), "");
    assert!(!session.is_waiting());

    let asking = helper(&session, "Username for 'https://git.example.com': ");
    let request = fx.request(1).await;
    assert_eq!(request["kind"], "username");
    assert_eq!(request["host"], "git.example.com");
    assert!(request["username"].is_null());
    assert!(request["detail"].is_null());
    assert_eq!(request["prompt"], "Username for 'https://git.example.com':");
    assert_eq!(request["canRemember"], false);
    assert!(session.is_waiting());
    assert_eq!(fx.broker().pending_count(), 1);

    credential_answer(&fx.tc, id_of(&request), Some("anna müller".into()), false).await.unwrap();
    assert_eq!(asking.await.unwrap().as_deref(), Some("anna müller"));
    assert!(!session.is_waiting());

    // Passphrase: key path as detail; without a keychain it cannot be remembered.
    let asking = helper(&session, "Enter passphrase for key '/home/anna/.ssh/id_ed25519': ");
    let request = fx.request(2).await;
    assert_eq!(request["kind"], "passphrase");
    assert_eq!(request["host"], "");
    assert_eq!(request["detail"], "/home/anna/.ssh/id_ed25519");
    assert_eq!(request["canRemember"], false);
    credential_answer(&fx.tc, id_of(&request), Some(String::new()), true).await.unwrap();
    assert_eq!(asking.await.unwrap().as_deref(), Some(""), "an empty answer is an answer too");

    // The same answer a second time: the prompt is done.
    let err = credential_answer(&fx.tc, id_of(&request), Some("x".into()), false).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    credential_answer(&fx.tc, id_of(&request), None, false).await.unwrap();

    assert!(session.finish(None).await.is_none());
    assert_eq!(fx.broker().session_count(), 0);
    assert!(fx.closed().is_empty(), "the UI closes answered prompts itself");
}

#[tokio::test]
async fn cancel_replaces_the_git_error_with_cancelled() {
    let fx = Fixture::new().await;
    let session = fx.broker().begin(SessionMode::Interactive).await;
    let asking = helper(&session, "Password for 'https://anna@git.example.com': ");
    let request = fx.request(1).await;
    assert_eq!(request["kind"], "password");
    assert_eq!(request["username"], "anna");
    credential_answer(&fx.tc, id_of(&request), None, true).await.unwrap();
    assert_eq!(asking.await.unwrap(), None);
    let replaced = session.finish(Some(&auth_failed())).await.unwrap();
    assert_eq!(replaced.code, ErrorCode::Cancelled);

    // If the call succeeds despite the cancel (e.g. via another key), the success stands.
    let session = fx.broker().begin(SessionMode::Interactive).await;
    let asking = helper(&session, "Enter passphrase for key '/k': ");
    let request = fx.request(2).await;
    credential_answer(&fx.tc, id_of(&request), None, false).await.unwrap();
    assert_eq!(asking.await.unwrap(), None);
    assert!(session.finish(None).await.is_none());
}

#[tokio::test]
async fn unanswered_question_times_out() {
    let fx = Fixture::new().await;
    configure(&fx.tc, |c| c.prompt_timeout = Some(Duration::from_millis(200)));
    let session = fx.broker().begin(SessionMode::Interactive).await;
    let started = std::time::Instant::now();
    let asking = helper(&session, "Username for 'https://git.example.com': ");
    assert_eq!(asking.await.unwrap(), None);
    assert!(started.elapsed() >= Duration::from_millis(200));
    assert!(started.elapsed() < Duration::from_secs(10));
    assert_eq!(fx.request_count(), 1);
    assert_eq!(fx.broker().pending_count(), 0);

    // The UI learns that its dialog is orphaned.
    let request = fx.request(1).await;
    assert_eq!(fx.closed(), [id_of(&request)]);
    assert_eq!(fx.tc.events.named(names::CREDENTIAL_CLOSED)[0], serde_json::json!({ "requestId": id_of(&request) }));

    // The UI's late answer: an understandable error; a cancel is silent.
    let late = credential_answer(&fx.tc, id_of(&request), Some("anna".into()), false).await.unwrap_err();
    assert_eq!(late.code, ErrorCode::NotFound);
    assert!(late.message.contains("no longer open"), "{}", late.message);
    credential_answer(&fx.tc, id_of(&request), None, false).await.unwrap();

    let replaced = session.finish(Some(&auth_failed())).await.unwrap();
    assert_eq!(replaced.code, ErrorCode::Timeout);
}

#[tokio::test]
async fn unknown_token_and_garbage_are_refused_without_event() {
    let fx = Fixture::new().await;
    let session = fx.broker().begin(SessionMode::Interactive).await;
    let port: u16 = env_value(session.env(), PORT_ENV).parse().unwrap();
    let prompt = to_hex(b"Password for 'https://anna@git.example.com': ");
    let wrong_token = "0".repeat(64);
    for line in [
        format!("GCAP1 {wrong_token} {prompt}\n"),
        format!("GCAP1  {prompt}\n"),
        format!("GCAP2 {} {prompt}\n", env_value(session.env(), TOKEN_ENV)),
        format!("GCAP1 {} keinhex\n", env_value(session.env(), TOKEN_ENV)),
        format!("GCAP1 {} {prompt} mehr\n", env_value(session.env(), TOKEN_ENV)),
        "GET / HTTP/1.1\n".to_string(),
        "\n".to_string(),
    ] {
        assert_eq!(raw_request(port, line.clone()).await, None, "{line:?}");
    }
    assert_eq!(fx.request_count(), 0);
    assert_eq!(fx.broker().pending_count(), 0);

    // After the session ends its token is no longer valid.
    let token = env_value(session.env(), TOKEN_ENV);
    assert!(session.finish(None).await.is_none());
    assert_eq!(raw_request(port, format!("GCAP1 {token} {prompt}\n")).await, None);
    assert_eq!(fx.request_count(), 0);
}

#[tokio::test]
async fn host_key_needs_an_explicit_yes() {
    let fx = Fixture::new().await;
    let prompt = "The authenticity of host 'git.example.com (203.0.113.7)' can't be established.\n\
                  ED25519 key fingerprint is SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU.\n\
                  This key is not known by any other names.\n\
                  Are you sure you want to continue connecting (yes/no/[fingerprint])? ";

    let session = fx.broker().begin(SessionMode::Interactive).await;
    let asking = helper(&session, prompt);
    let request = fx.request(1).await;
    assert_eq!(request["kind"], "host_key");
    assert_eq!(request["host"], "git.example.com");
    assert_eq!(request["detail"], "SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU");
    assert_eq!(request["canRemember"], false);
    assert!(request["prompt"].as_str().unwrap().contains("authenticity of host"));
    credential_answer(&fx.tc, id_of(&request), Some("yes".into()), true).await.unwrap();
    assert_eq!(asking.await.unwrap().as_deref(), Some("yes"));
    assert!(session.finish(None).await.is_none());

    // Everything except "yes" rejects: SSH gets "no", the caller `cancelled`.
    for (n, answer) in [Some("ja"), Some("y"), Some(""), None].into_iter().enumerate() {
        let session = fx.broker().begin(SessionMode::Interactive).await;
        let asking = helper(&session, prompt);
        let request = fx.request(n + 2).await;
        credential_answer(&fx.tc, id_of(&request), answer.map(str::to_string), false).await.unwrap();
        let got = asking.await.unwrap();
        assert_ne!(got.as_deref(), Some("yes"), "{answer:?}");
        assert_eq!(got.as_deref(), answer.map(|_| "no"), "{answer:?}");
        let host_key_error = errors::classify("fetch", Some(128), b"", b"Host key verification failed.\nfatal: Could not read from remote repository.");
        assert_eq!(host_key_error.code, ErrorCode::HostKeyUnknown);
        assert_eq!(session.finish(Some(&host_key_error)).await.unwrap().code, ErrorCode::Cancelled);
    }
}

/// An SSH server that spoofs a passphrase question via keyboard-interactive does not get the
/// remembered passphrase – neither silently nor through a prompt that looks like the real
/// one.
#[tokio::test]
async fn sec04_a_server_cannot_fish_a_remembered_passphrase() {
    let fx = Fixture::new().await;
    let Some(mut keyring) = TestKeyring::new(&fx).await else { return };
    let profile_id = fx.tc.active_profile_id().unwrap();
    let key = StoreKey { kind: HostAccountKind::Passphrase, host: "/home/anna/.ssh/id_ed25519".into(), username: String::new() };
    keyring.track(&profile_id, &key);

    // The user had the passphrase remembered on a real question.
    let session = fx.broker().begin(SessionMode::Interactive).await;
    let asking = helper(&session, "Enter passphrase for key '/home/anna/.ssh/id_ed25519': ");
    let request = fx.request(1).await;
    assert_eq!(request["kind"], "passphrase");
    credential_answer(&fx.tc, id_of(&request), Some(SECRET.into()), true).await.unwrap();
    assert_eq!(asking.await.unwrap().as_deref(), Some(SECRET));
    assert!(session.finish(None).await.is_none());

    // Auto-fetch to a hostile server: the spoofed question gets no answer.
    fx.tc.events.clear();
    let session = fx.broker().begin(SessionMode::Silent).await;
    for spoofed in [
        "(git@server.example) Enter passphrase for key '/home/anna/.ssh/id_ed25519': ",
        "(git@server.example) Bad passphrase, try again for /home/anna/.ssh/id_ed25519: ",
    ] {
        assert_eq!(helper(&session, spoofed).await.unwrap(), None, "{spoofed}");
    }
    // The real question is still answered silently.
    assert_eq!(helper(&session, "Enter passphrase for key '/home/anna/.ssh/id_ed25519': ").await.unwrap().as_deref(), Some(SECRET));
    drop(session);

    // Interactive: the prompt names the server and does not look like a passphrase question.
    let session = fx.broker().begin(SessionMode::Interactive).await;
    let asking = helper(&session, "(git@server.example) Enter passphrase for key '/home/anna/.ssh/id_ed25519': ");
    let request = fx.request(1).await;
    assert_eq!(request["kind"], "password");
    assert_eq!(request["host"], "server.example");
    assert!(request["detail"].is_null());
    assert_eq!(request["canRemember"], false);
    credential_answer(&fx.tc, id_of(&request), None, false).await.unwrap();
    assert_eq!(asking.await.unwrap(), None);
}

/// A session's token is inherited by hooks and helper programs. A session therefore answers
/// only a limited number of questions.
#[tokio::test]
async fn sec09_a_session_answers_only_a_limited_number_of_questions() {
    let fx = Fixture::new().await;
    let session = fx.broker().begin(SessionMode::Scripted("wert".into())).await;
    let mut answered = 0;
    for n in 0..1000 {
        match helper(&session, &format!("Frage {n}: ")).await.unwrap() {
            Some(_) => answered += 1,
            None => break,
        }
    }
    assert_eq!(answered, super::broker::MAX_QUESTIONS_PER_SESSION, "this many questions a session answers");
    // After that the session stays closed.
    assert_eq!(helper(&session, "noch eine: ").await.unwrap(), None);
}

#[tokio::test]
async fn silent_sessions_never_ask() {
    let fx = Fixture::new().await;
    let session = fx.broker().begin(SessionMode::Silent).await;
    assert_eq!(env_value(session.env(), "GCM_INTERACTIVE"), "never");
    for prompt in [
        "Username for 'https://git.example.com': ",
        "Password for 'https://anna@git.example.com': ",
        "Enter passphrase for key '/home/anna/.ssh/id_ed25519': ",
        "The authenticity of host 'h (1.2.3.4)' can't be established.\nED25519 key fingerprint is SHA256:abc.\nAre you sure you want to continue connecting (yes/no/[fingerprint])? ",
    ] {
        let started = std::time::Instant::now();
        assert_eq!(helper(&session, prompt).await.unwrap(), None, "{prompt}");
        assert!(started.elapsed() < Duration::from_secs(5), "muss sofort scheitern");
    }
    assert_eq!(fx.request_count(), 0);
    // Git's error stays as it is (auth_failed), no "cancelled".
    assert!(session.finish(Some(&auth_failed())).await.is_none());
}

#[tokio::test]
async fn scripted_sessions_answer_every_question_with_the_value() {
    let fx = Fixture::new().await;
    let session = fx.broker().begin(SessionMode::Scripted(SECRET.into())).await;
    for prompt in ["Enter passphrase (empty for no passphrase): ", "Enter same passphrase again: "] {
        assert_eq!(helper(&session, prompt).await.unwrap().as_deref(), Some(SECRET));
    }
    assert_eq!(fx.request_count(), 0);
    assert!(session.finish(None).await.is_none());
    assert!(credentials_list(&fx.tc).await.unwrap().is_empty());
}

#[tokio::test]
async fn helper_gone_or_session_dropped_closes_the_request() {
    let fx = Fixture::new().await;
    let session = fx.broker().begin(SessionMode::Interactive).await;

    // The helper program dies (Git was cancelled): the prompt is no longer open.
    let asking = helper(&session, "Username for 'https://git.example.com': ");
    let request = fx.request(1).await;
    asking.abort();
    let _ = asking.await;
    for _ in 0..500 {
        if fx.broker().pending_count() == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(fx.broker().pending_count(), 0);
    assert!(!session.is_waiting());
    assert_eq!(credential_answer(&fx.tc, id_of(&request), Some("anna".into()), false).await.unwrap_err().code, ErrorCode::NotFound);
    fx.wait_closed(&id_of(&request)).await;

    // The session goes away (Git ended or cancelled) while a question is open:
    // the helper program gets "NO", the UI `credential:closed`.
    let asking = helper(&session, "Username for 'https://git.example.com': ");
    let second = fx.request(2).await;
    drop(session);
    assert_eq!(asking.await.unwrap(), None);
    assert_eq!(fx.broker().session_count(), 0);
    assert_eq!(fx.broker().pending_count(), 0);
    fx.wait_closed(&id_of(&second)).await;
    assert_eq!(fx.closed().len(), 2, "exactly one event per orphaned prompt");
}

#[tokio::test]
async fn git_questions_are_asked_once_per_session_ssh_questions_every_time() {
    let fx = Fixture::new().await;
    let session = fx.broker().begin(SessionMode::Interactive).await;

    // `git fetch --all` with two remotes on the same host: two Git processes, one prompt.
    let asking = helper(&session, "Password for 'https://anna@git.example.com': ");
    let request = fx.request(1).await;
    credential_answer(&fx.tc, id_of(&request), Some(SECRET.into()), false).await.unwrap();
    assert_eq!(asking.await.unwrap().as_deref(), Some(SECRET));
    assert_eq!(helper(&session, "Password for 'https://anna@git.example.com': ").await.unwrap().as_deref(), Some(SECRET));
    assert_eq!(fx.request_count(), 1);

    // SSH repeats the question after a wrong input: ask again every time.
    for n in 2..=3 {
        let asking = helper(&session, "Enter passphrase for key '/k': ");
        let request = fx.request(n).await;
        credential_answer(&fx.tc, id_of(&request), Some(format!("versuch-{n}")), false).await.unwrap();
        assert_eq!(asking.await.unwrap(), Some(format!("versuch-{n}")));
    }
    assert_eq!(fx.request_count(), 3);
    assert!(session.finish(None).await.is_none());

    // A new session no longer knows about it.
    let session = fx.broker().begin(SessionMode::Interactive).await;
    let asking = helper(&session, "Password for 'https://anna@git.example.com': ");
    let request = fx.request(4).await;
    credential_answer(&fx.tc, id_of(&request), None, false).await.unwrap();
    assert_eq!(asking.await.unwrap(), None);
}

#[test]
fn prompt_for_the_ui_keeps_the_username_but_never_a_password() {
    use super::broker::display_prompt;
    assert_eq!(display_prompt("Password for 'https://anna@git.example.com': "), "Password for 'https://anna@git.example.com':");
    assert_eq!(display_prompt("Username for 'https://git.example.com': "), "Username for 'https://git.example.com':");
    assert_eq!(display_prompt("git@example.com's password: "), "git@example.com's password:");
    let shown = display_prompt("Password for 'https://anna:hunter2@git.example.com': ");
    assert!(!shown.contains("hunter2"), "{shown}");
    assert!(shown.contains("git.example.com"));
}

#[cfg(windows)]
#[test]
fn helper_path_is_plain_ascii_with_slashes_on_windows() {
    use super::broker::helper_env_value;
    let dir = tempfile::tempdir().unwrap();
    let folder = dir.path().join("Jörg Müller");
    std::fs::create_dir_all(&folder).unwrap();
    let helper = folder.join("forkyard-askpass.exe");
    std::fs::write(&helper, "").unwrap();
    let value = helper_env_value(&helper).to_string_lossy().into_owned();
    assert!(!value.contains('\\'), "{value}");
    // With short 8.3 names (default on the system drive) no umlaut remains.
    if value.is_ascii() {
        assert!(Path::new(&value).is_file(), "{value}");
    } else {
        eprintln!("Laufwerk ohne kurze Dateinamen: {value}");
        assert!(value.ends_with("Jörg Müller/forkyard-askpass.exe"));
    }
    let plain = dir.path().join("mit leerzeichen");
    std::fs::create_dir_all(&plain).unwrap();
    let value = helper_env_value(&plain.join("h.exe")).to_string_lossy().into_owned();
    assert!(value.ends_with("mit leerzeichen/h.exe"), "{value}");
}

#[test]
fn ssh_and_askpass_failures_are_auth_failed() {
    let code = |stderr: &str| errors::classify("fetch", Some(128), b"", stderr.as_bytes()).code;
    for stderr in [
        "git@example.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
        "git@example.com: Permission denied (password).",
        "git@example.com: Permission denied (publickey,password,keyboard-interactive).",
        "git@example.com: Permission denied (keyboard-interactive).",
        "Permission denied, please try again.",
        "Received disconnect from 203.0.113.7 port 22:2: Too many authentication failures",
        "error: unable to read askpass response from 'C:/Program Files/forkyard/forkyard-askpass.exe'\nfatal: could not read Username for 'https://git.example.com': terminal prompts disabled",
        "fatal: Authentication failed for 'https://git.example.com/r.git/'",
    ] {
        assert_eq!(code(stderr), ErrorCode::AuthFailed, "{stderr}");
    }
    // An unknown or changed host key remains a case of its own.
    assert_eq!(code("Host key verification failed.\nfatal: Could not read from remote repository."), ErrorCode::HostKeyUnknown);
    // A file without access permission is not a failed sign-in.
    assert_ne!(code("error: cannot open '.git/FETCH_HEAD': Permission denied"), ErrorCode::AuthFailed);
}

// ---------------------------------------------------------------------------
// Keychain
// ---------------------------------------------------------------------------

#[tokio::test]
async fn remembered_password_roundtrip_through_the_keyring() {
    let fx = Fixture::new().await;
    let Some(mut keyring) = TestKeyring::new(&fx).await else { return };
    let profile_id = fx.tc.active_profile_id().unwrap();
    let account = keyring.track(&profile_id, &password_key("git.example.com", "anna"));

    // 1. The user answers and has it remembered.
    let session = fx.broker().begin(SessionMode::Interactive).await;
    let asking = helper(&session, "Username for 'https://git.example.com': ");
    let request = fx.request(1).await;
    assert_eq!(request["canRemember"], false, "a user name alone is not remembered");
    credential_answer(&fx.tc, id_of(&request), Some("anna".into()), true).await.unwrap();
    assert_eq!(asking.await.unwrap().as_deref(), Some("anna"));
    let asking = helper(&session, "Password for 'https://anna@git.example.com': ");
    let request = fx.request(2).await;
    assert_eq!(request["canRemember"], true);
    credential_answer(&fx.tc, id_of(&request), Some(SECRET.into()), true).await.unwrap();
    assert_eq!(asking.await.unwrap().as_deref(), Some(SECRET));
    // It is stored only once Git succeeded with the data.
    assert!(credentials_list(&fx.tc).await.unwrap().is_empty());
    assert!(fx.app_changes().is_empty());
    assert!(session.finish(None).await.is_none());
    assert_eq!(fx.app_changes(), ["credentials"], "the credentials list reloads");

    let accounts = credentials_list(&fx.tc).await.unwrap();
    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0].host, "git.example.com");
    assert_eq!(accounts[0].username, "anna");
    assert_eq!(accounts[0].kind, HostAccountKind::Password);
    assert_eq!(keychain::get(&keyring.service, &account).await.unwrap().as_deref(), Some(SECRET));

    // The secret is only in the keychain: not in events, not in the database.
    let events = serde_json::to_string(&fx.tc.events.all()).unwrap();
    assert!(!events.contains(SECRET));
    for file in ["forkyard.db", "forkyard.db-wal"] {
        if let Ok(bytes) = std::fs::read(fx.tc.data_dir().join(file)) {
            let needle = SECRET.as_bytes();
            assert!(!bytes.windows(needle.len()).any(|w| w == needle), "Geheimnis in {file}");
        }
    }

    // 2. The next call needs no prompt – the user name included.
    fx.tc.events.clear();
    let session = fx.broker().begin(SessionMode::Silent).await;
    assert_eq!(helper(&session, "Username for 'https://git.example.com': ").await.unwrap().as_deref(), Some("anna"));
    assert_eq!(helper(&session, "Password for 'https://anna@git.example.com': ").await.unwrap().as_deref(), Some(SECRET));
    assert_eq!(fx.request_count(), 0);
    // Another host or user does not get the password.
    assert_eq!(helper(&session, "Password for 'https://anna@anders.example.com': ").await.unwrap(), None);
    assert_eq!(helper(&session, "Password for 'https://berta@git.example.com': ").await.unwrap(), None);
    assert_eq!(helper(&session, "Password for 'http://anna@git.example.com': ").await.unwrap(), None);
    drop(session);

    // 3. No access to this repository (403) does not mean the password is wrong.
    let session = fx.broker().begin(SessionMode::Interactive).await;
    assert_eq!(helper(&session, "Password for 'https://anna@git.example.com': ").await.unwrap().as_deref(), Some(SECRET));
    let forbidden = errors::classify("push", Some(128), b"", b"fatal: unable to access 'https://git.example.com/r.git/': The requested URL returned error: 403");
    assert_eq!(forbidden.code, ErrorCode::AuthFailed);
    assert!(session.finish(Some(&forbidden)).await.is_none());
    assert_eq!(credentials_list(&fx.tc).await.unwrap().len(), 1);

    // 4. Git rejects the remembered password: entry gone, next time it asks.
    let session = fx.broker().begin(SessionMode::Interactive).await;
    assert_eq!(helper(&session, "Password for 'https://anna@git.example.com': ").await.unwrap().as_deref(), Some(SECRET));
    fx.tc.events.clear();
    assert!(session.finish(Some(&auth_failed())).await.is_none(), "Git's error stays auth_failed");
    assert!(credentials_list(&fx.tc).await.unwrap().is_empty());
    assert_eq!(fx.app_changes(), ["credentials"], "deleting is reported too");
    assert_eq!(keychain::get(&keyring.service, &account).await.unwrap(), None);

    let session = fx.broker().begin(SessionMode::Interactive).await;
    let asking = helper(&session, "Username for 'https://git.example.com': ");
    let request = fx.request(1).await;
    assert_eq!(request["kind"], "username");
    credential_answer(&fx.tc, id_of(&request), None, false).await.unwrap();
    assert_eq!(asking.await.unwrap(), None);
}

#[tokio::test]
async fn remember_is_only_saved_when_the_login_worked() {
    let fx = Fixture::new().await;
    let Some(mut keyring) = TestKeyring::new(&fx).await else { return };
    let profile_id = fx.tc.active_profile_id().unwrap();
    let key = StoreKey { kind: HostAccountKind::Passphrase, host: "/home/anna/.ssh/id_ed25519".into(), username: String::new() };
    let account = keyring.track(&profile_id, &key);
    let prompt = "Enter passphrase for key '/home/anna/.ssh/id_ed25519': ";
    let mut asked = 0;

    // Wrong passphrase, SSH asks again, then it is right – and after that the server rejects.
    let session = fx.broker().begin(SessionMode::Interactive).await;
    for answer in ["falsch-1", "richtig-2"] {
        asked += 1;
        let asking = helper(&session, prompt);
        let request = fx.request(asked).await;
        assert_eq!(request["canRemember"], true);
        credential_answer(&fx.tc, id_of(&request), Some(answer.into()), true).await.unwrap();
        assert_eq!(asking.await.unwrap().as_deref(), Some(answer));
    }
    let denied = errors::classify("fetch", Some(128), b"", b"git@example.com: Permission denied (publickey).");
    assert!(session.finish(Some(&denied)).await.is_none());
    assert!(credentials_list(&fx.tc).await.unwrap().is_empty(), "nothing is remembered after auth_failed");
    assert_eq!(keychain::get(&keyring.service, &account).await.unwrap(), None);

    // The same with an error after signing in (push rejected): the last answer is remembered.
    let session = fx.broker().begin(SessionMode::Interactive).await;
    for answer in ["falsch-1", "richtig-2"] {
        asked += 1;
        let asking = helper(&session, prompt);
        let request = fx.request(asked).await;
        credential_answer(&fx.tc, id_of(&request), Some(answer.into()), true).await.unwrap();
        asking.await.unwrap();
    }
    let rejected = errors::classify("push", Some(1), b"", b" ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'r'");
    assert_eq!(rejected.code, ErrorCode::PushRejected);
    assert!(session.finish(Some(&rejected)).await.is_none());
    let accounts = credentials_list(&fx.tc).await.unwrap();
    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0].kind, HostAccountKind::Passphrase);
    assert_eq!(accounts[0].host, "/home/anna/.ssh/id_ed25519");
    assert_eq!(accounts[0].username, "");
    assert_eq!(keychain::get(&keyring.service, &account).await.unwrap().as_deref(), Some("richtig-2"));

    // A cancel elsewhere does not delete a supplied entry.
    let session = fx.broker().begin(SessionMode::Interactive).await;
    assert_eq!(helper(&session, prompt).await.unwrap().as_deref(), Some("richtig-2"));
    asked += 1;
    let asking = helper(&session, "Username for 'https://git.example.com': ");
    let request = fx.request(asked).await;
    credential_answer(&fx.tc, id_of(&request), None, false).await.unwrap();
    assert_eq!(asking.await.unwrap(), None);
    assert_eq!(session.finish(Some(&auth_failed())).await.unwrap().code, ErrorCode::Cancelled);
    assert_eq!(credentials_list(&fx.tc).await.unwrap().len(), 1);

    assert_eq!(credentials_forget_all(&fx.tc).await.unwrap(), 1);
    assert_eq!(keychain::get(&keyring.service, &account).await.unwrap(), None);
}

#[tokio::test]
async fn without_a_keyring_nothing_is_remembered() {
    let fx = Fixture::new().await;
    assert!(!fx.broker().keyring_available().await);
    let session = fx.broker().begin(SessionMode::Interactive).await;
    let asking = helper(&session, "Password for 'https://anna@git.example.com': ");
    let request = fx.request(1).await;
    assert_eq!(request["canRemember"], false);
    // Even if the UI sends "remember" anyway.
    credential_answer(&fx.tc, id_of(&request), Some(SECRET.into()), true).await.unwrap();
    assert_eq!(asking.await.unwrap().as_deref(), Some(SECRET));
    assert!(session.finish(None).await.is_none());
    assert!(credentials_list(&fx.tc).await.unwrap().is_empty());
    assert_eq!(credentials_forget_all(&fx.tc).await.unwrap(), 0);

    let session = fx.broker().begin(SessionMode::Interactive).await;
    let asking = helper(&session, "Password for 'https://anna@git.example.com': ");
    fx.request(2).await;
    drop(session);
    assert_eq!(asking.await.unwrap(), None);
    for file in ["forkyard.db", "forkyard.db-wal"] {
        if let Ok(bytes) = std::fs::read(fx.tc.data_dir().join(file)) {
            let needle = SECRET.as_bytes();
            assert!(!bytes.windows(needle.len()).any(|w| w == needle), "Geheimnis in {file}");
        }
    }
}

#[tokio::test]
async fn forget_all_and_profile_delete_clear_the_keyring() {
    let fx = Fixture::new().await;
    let Some(mut keyring) = TestKeyring::new(&fx).await else { return };
    let first = fx.tc.active_profile_id().unwrap();
    let profiles = settings::profile_save(&fx.tc, None, "Zweites".into(), "Berta".into(), "berta@example.com".into(), false, None).await.unwrap();
    let second = profiles.iter().find(|p| p.name == "Zweites").unwrap().id.clone();

    async fn remember(fx: &Fixture, n: usize, prompt: &str, secret: &str) {
        let session = fx.broker().begin(SessionMode::Interactive).await;
        let asking = helper(&session, prompt);
        let request = fx.request(n).await;
        credential_answer(&fx.tc, id_of(&request), Some(secret.into()), true).await.unwrap();
        asking.await.unwrap();
        assert!(session.finish(None).await.is_none());
    }

    let a = keyring.track(&first, &password_key("git.example.com", "anna"));
    let b = keyring.track(&first, &password_key("ssh://example.com", "git"));
    let c = keyring.track(&second, &password_key("git.example.com", "anna"));
    remember(&fx, 1, "Password for 'https://anna@git.example.com': ", "eins").await;
    remember(&fx, 2, "git@example.com's password: ", "zwei").await;
    settings::profile_activate(&fx.tc, second.clone()).await.unwrap();
    // Same host and user, different profile: separate entry, and the first profile is not visible.
    assert!(credentials_list(&fx.tc).await.unwrap().is_empty());
    remember(&fx, 3, "Password for 'https://anna@git.example.com': ", "drei").await;
    assert_eq!(credentials_list(&fx.tc).await.unwrap().len(), 1);
    assert_eq!(keychain::get(&keyring.service, &a).await.unwrap().as_deref(), Some("eins"));
    assert_eq!(keychain::get(&keyring.service, &b).await.unwrap().as_deref(), Some("zwei"));
    assert_eq!(keychain::get(&keyring.service, &c).await.unwrap().as_deref(), Some("drei"));

    // Deleting a profile clears its keychain entries as well; the others stay.
    settings::profile_activate(&fx.tc, first.clone()).await.unwrap();
    settings::profile_delete(&fx.tc, second).await.unwrap();
    assert_eq!(keychain::get(&keyring.service, &c).await.unwrap(), None);
    assert_eq!(keychain::get(&keyring.service, &a).await.unwrap().as_deref(), Some("eins"));

    let accounts = credentials_list(&fx.tc).await.unwrap();
    assert_eq!(accounts.iter().map(|a| a.host.as_str()).collect::<Vec<_>>(), vec!["git.example.com", "ssh://example.com"]);
    assert_eq!(credentials_forget_all(&fx.tc).await.unwrap(), 2);
    assert!(credentials_list(&fx.tc).await.unwrap().is_empty());
    assert_eq!(keychain::get(&keyring.service, &a).await.unwrap(), None);
    assert_eq!(keychain::get(&keyring.service, &b).await.unwrap(), None);
    assert_eq!(credentials_forget_all(&fx.tc).await.unwrap(), 0);
}

#[tokio::test]
async fn keyring_entry_deleted_outside_the_app_is_asked_again() {
    let fx = Fixture::new().await;
    let Some(mut keyring) = TestKeyring::new(&fx).await else { return };
    let profile_id = fx.tc.active_profile_id().unwrap();
    let account = keyring.track(&profile_id, &password_key("git.example.com", "anna"));

    let session = fx.broker().begin(SessionMode::Interactive).await;
    let asking = helper(&session, "Password for 'https://anna@git.example.com': ");
    let request = fx.request(1).await;
    credential_answer(&fx.tc, id_of(&request), Some(SECRET.into()), true).await.unwrap();
    asking.await.unwrap();
    session.finish(None).await;
    assert_eq!(credentials_list(&fx.tc).await.unwrap().len(), 1);

    // Someone deletes the entry in the keychain manager.
    assert!(keychain::delete(&keyring.service, &account).await.unwrap());
    let session = fx.broker().begin(SessionMode::Interactive).await;
    let asking = helper(&session, "Password for 'https://anna@git.example.com': ");
    let request = fx.request(2).await;
    credential_answer(&fx.tc, id_of(&request), None, false).await.unwrap();
    assert_eq!(asking.await.unwrap(), None);
    assert!(credentials_list(&fx.tc).await.unwrap().is_empty(), "the index follows the keychain");
}

// ---------------------------------------------------------------------------
// Hook point in the Git runner
// ---------------------------------------------------------------------------

const ENV_DUMP: &str = "alias.envdump=!echo \"A=$GIT_ASKPASS|S=$SSH_ASKPASS|R=$SSH_ASKPASS_REQUIRE|P=$FORKYARD_ASKPASS_PORT|T=$FORKYARD_ASKPASS_TOKEN|G=$GCM_INTERACTIVE|C=$GIT_SSH_COMMAND|\"";

fn field<'a>(dump: &'a str, name: &str) -> &'a str {
    let start = dump.find(&format!("{name}=")).unwrap() + name.len() + 1;
    &dump[start..start + dump[start..].find('|').unwrap()]
}

#[tokio::test]
async fn network_calls_get_the_askpass_environment() {
    let fx = Fixture::new().await;
    let repo = TestRepo::with_commit();
    let id = fx.tc.open(&repo).await.repo.id;

    let plain = fx.tc.git_for(&id).unwrap().args(["-c", ENV_DUMP, "envdump"]).run_text().await.unwrap();
    assert_eq!(field(&plain, "P"), "", "no askpass environment without .network(): {plain}");
    assert_eq!(field(&plain, "T"), "");

    let net = fx.tc.git_for(&id).unwrap().args(["-c", ENV_DUMP, "envdump"]).network().run_text().await.unwrap();
    assert!(field(&net, "A").ends_with("helper-attrappe"), "{net}");
    assert_eq!(field(&net, "A"), field(&net, "S"));
    assert_eq!(field(&net, "R"), "force");
    assert!(field(&net, "P").parse::<u16>().is_ok(), "{net}");
    assert_eq!(field(&net, "T").len(), 64);
    // Left as inherited (GitHub's Windows runners set GCM_INTERACTIVE=Never themselves).
    assert_eq!(field(&net, "G"), std::env::var("GCM_INTERACTIVE").unwrap_or_default());
    assert_eq!(field(&net, "C"), "", "without a default key SSH is left unchanged");

    let quiet = fx.tc.git_for(&id).unwrap().args(["-c", ENV_DUMP, "envdump"]).network().no_prompt().run_text().await.unwrap();
    assert_eq!(field(&quiet, "G"), "never");
    assert!(field(&quiet, "A").ends_with("helper-attrappe"), "the helper program answers silently from the keychain: {quiet}");
    assert_eq!(field(&quiet, "C"), "", "with the helper program SSH stays unchanged");
    assert_ne!(field(&quiet, "T"), field(&net, "T"), "jede Sitzung hat ihr eigenes Token");

    // After the call the session is gone; the token does not appear in the log.
    assert_eq!(fx.broker().session_count(), 0);
    let commands: Vec<String> =
        fx.tc.events.named(names::LOG_APPENDED).iter().map(|entry| entry["command"].as_str().unwrap_or("").to_string()).collect();
    assert!(commands.len() >= 3);
    assert!(commands.iter().all(|c| !c.contains(field(&net, "T")) && !c.contains(field(&quiet, "T"))), "{commands:?}");

    // If the helper program is missing, Git runs as before – just without prompts.
    configure(&fx.tc, |c| c.askpass_path = Some(PathBuf::from("gibt/es/nicht")));
    let none = fx.tc.git_for(&id).unwrap().args(["-c", ENV_DUMP, "envdump"]).network().run_text().await.unwrap();
    assert_eq!(field(&none, "P"), "");
    // … and `.no_prompt()` then hard-mutes askpass and ssh.
    let hard = fx.tc.git_for(&id).unwrap().args(["-c", ENV_DUMP, "envdump"]).network().no_prompt().run_text().await.unwrap();
    assert_eq!(field(&hard, "A"), "", "{hard}");
    assert_eq!(field(&hard, "S"), "");
    assert_eq!(field(&hard, "R"), "never");
    assert_eq!(field(&hard, "G"), "never");
    assert_eq!(field(&hard, "C"), "ssh -o BatchMode=yes");
}

#[tokio::test]
async fn default_key_is_forced_only_without_agent() {
    let fx = Fixture::new().await;
    let repo = TestRepo::with_commit();
    let id = fx.tc.open(&repo).await.repo.id;
    let keys = ssh_key_generate(&fx.tc, "Arbeit".into(), "id mit leerzeichen".into(), None).await.unwrap();
    let key_path = keys[0].private_key_path.replace('\\', "/");
    let dump = || async {
        let out = fx.tc.git_for(&id).unwrap().args(["-c", ENV_DUMP, "envdump"]).network().run_text().await.unwrap();
        field(&out, "C").to_string()
    };

    // Default: the SSH agent decides, even with a default key.
    ssh_key_set_default(&fx.tc, Some(keys[0].id.clone())).await.unwrap();
    assert!(fx.tc.settings().unwrap().ssh_use_agent);
    assert_eq!(dump().await, "");
    assert_eq!(fx.broker().forced_ssh_key(None).unwrap(), None);

    settings::settings_set(&fx.tc, serde_json::json!({ "sshUseAgent": false })).await.unwrap();
    assert_eq!(dump().await, format!("ssh -i '{key_path}' -o IdentitiesOnly=yes"));

    // The user's own SSH command line remains the basis.
    repo.git(&["config", "core.sshCommand", "ssh -v -o ConnectTimeout=5"]);
    assert_eq!(dump().await, format!("ssh -v -o ConnectTimeout=5 -i '{key_path}' -o IdentitiesOnly=yes"));
    let own = fx.tc.git_for(&id).unwrap().args(["-c", ENV_DUMP, "envdump"]).env("GIT_SSH_COMMAND", "meinssh").network().run_text().await.unwrap();
    assert_eq!(field(&own, "C"), format!("meinssh -i '{key_path}' -o IdentitiesOnly=yes"));

    // The key choice also applies without prompts (auto-fetch) – with and without the helper program.
    let quiet = fx.tc.git_for(&id).unwrap().args(["-c", ENV_DUMP, "envdump"]).network().no_prompt().run_text().await.unwrap();
    assert_eq!(field(&quiet, "C"), format!("ssh -v -o ConnectTimeout=5 -i '{key_path}' -o IdentitiesOnly=yes"));
    configure(&fx.tc, |c| c.askpass_path = Some(PathBuf::from("gibt/es/nicht")));
    let hard = fx.tc.git_for(&id).unwrap().args(["-c", ENV_DUMP, "envdump"]).network().no_prompt().run_text().await.unwrap();
    assert_eq!(field(&hard, "C"), format!("ssh -v -o ConnectTimeout=5 -i '{key_path}' -o IdentitiesOnly=yes -o BatchMode=yes"));
    assert_eq!(field(&hard, "A"), "");

    // No default key or file gone: force nothing.
    ssh_key_set_default(&fx.tc, None).await.unwrap();
    assert_eq!(dump().await, "");
    ssh_key_set_default(&fx.tc, Some(keys[0].id.clone())).await.unwrap();
    std::fs::remove_file(&keys[0].private_key_path).unwrap();
    assert_eq!(dump().await, "");
}

#[tokio::test]
async fn a_project_key_is_forced_for_that_repository_only() {
    let fx = Fixture::new().await;
    let a = TestRepo::with_commit();
    let b = TestRepo::with_commit();
    let a_id = fx.tc.open(&a).await.repo.id;
    let b_id = fx.tc.open(&b).await.repo.id;
    ssh_key_generate(&fx.tc, "Standard".into(), "id_standard".into(), None).await.unwrap();
    let keys = ssh_key_generate(&fx.tc, "Kunde".into(), "id kunde".into(), None).await.unwrap();
    let kunde = keys.iter().find(|k| k.label == "Kunde").unwrap().clone();
    let kunde_path = kunde.private_key_path.replace('\\', "/");
    let dump = |id: String| {
        let fx = &fx;
        async move {
            let out = fx.tc.git_for(&id).unwrap().args(["-c", ENV_DUMP, "envdump"]).network().run_text().await.unwrap();
            field(&out, "C").to_string()
        }
    };

    // Even with the SSH agent (default) the project's choice applies; the other repository stays with the agent.
    assert!(fx.tc.settings().unwrap().ssh_use_agent);
    settings::repo_settings_set(&fx.tc, a_id.clone(), serde_json::json!({ "sshKeyId": kunde.id })).await.unwrap();
    assert_eq!(settings::repo_settings_get(&fx.tc, a_id.clone()).await.unwrap().ssh_key_id.as_deref(), Some(kunde.id.as_str()));
    assert_eq!(dump(a_id.clone()).await, format!("ssh -i '{kunde_path}' -o IdentitiesOnly=yes"));
    assert_eq!(dump(b_id.clone()).await, "");

    // An SSH command line of its own in the repository remains the basis.
    a.git(&["config", "core.sshCommand", "ssh -v"]);
    assert_eq!(dump(a_id.clone()).await, format!("ssh -v -i '{kunde_path}' -o IdentitiesOnly=yes"));

    // `null` withdraws the choice.
    settings::repo_settings_set(&fx.tc, a_id.clone(), serde_json::json!({ "sshKeyId": null })).await.unwrap();
    assert_eq!(dump(a_id.clone()).await, "");
}

#[tokio::test]
async fn the_project_key_is_chosen_per_profile_for_a_shared_repository() {
    let fx = Fixture::new().await;
    let repo = TestRepo::with_commit();
    let id = fx.tc.open(&repo).await.repo.id;
    let first = fx.tc.active_profile_id().unwrap();
    let keys = ssh_key_generate(&fx.tc, "Kunde".into(), "id_kunde".into(), None).await.unwrap();
    settings::repo_settings_set(&fx.tc, id.clone(), serde_json::json!({ "sshKeyId": keys[0].id })).await.unwrap();

    // A second profile lists the same repository: the first one's choice does not apply there.
    let list = settings::profile_save(&fx.tc, None, "Privat".into(), "".into(), "".into(), false, None).await.unwrap();
    let other = list.iter().find(|p| p.name == "Privat").unwrap().id.clone();
    settings::profile_activate(&fx.tc, other).await.unwrap();
    crate::commands::repos::repo_open_with(&fx.tc, repo.path().to_string_lossy().into_owned(), true).await.unwrap();
    assert_eq!(settings::repo_settings_get(&fx.tc, id.clone()).await.unwrap().ssh_key_id, None);
    let out = fx.tc.git_for(&id).unwrap().args(["-c", ENV_DUMP, "envdump"]).network().run_text().await.unwrap();
    assert_eq!(field(&out, "C"), "", "no foreign key, no error");

    // A choice in the second profile leaves the first one's in place.
    let own = ssh_key_generate(&fx.tc, "Privat".into(), "id_privat".into(), None).await.unwrap();
    settings::repo_settings_set(&fx.tc, id.clone(), serde_json::json!({ "sshKeyId": own[0].id })).await.unwrap();
    settings::profile_activate(&fx.tc, first).await.unwrap();
    assert_eq!(settings::repo_settings_get(&fx.tc, id).await.unwrap().ssh_key_id.as_deref(), Some(keys[0].id.as_str()));
}

#[tokio::test]
async fn a_missing_project_key_file_is_an_error() {
    let fx = Fixture::new().await;
    let repo = TestRepo::with_commit();
    let id = fx.tc.open(&repo).await.repo.id;
    let keys = ssh_key_generate(&fx.tc, "Kunde".into(), "id_kunde".into(), None).await.unwrap();
    settings::repo_settings_set(&fx.tc, id.clone(), serde_json::json!({ "sshKeyId": keys[0].id })).await.unwrap();
    std::fs::remove_file(&keys[0].private_key_path).unwrap();
    let err = fx.tc.git_for(&id).unwrap().args(["-c", ENV_DUMP, "envdump"]).network().run_text().await.unwrap_err();
    assert_eq!(err.code, ErrorCode::PathNotFound, "{}", err.message);
    assert!(err.message.contains("project settings"), "{}", err.message);
}

#[tokio::test]
async fn removing_a_key_resets_the_project_choice() {
    let fx = Fixture::new().await;
    let repo = TestRepo::with_commit();
    let id = fx.tc.open(&repo).await.repo.id;
    let keys = ssh_key_generate(&fx.tc, "Kunde".into(), "id_kunde".into(), None).await.unwrap();
    settings::repo_settings_set(&fx.tc, id.clone(), serde_json::json!({ "sshKeyId": keys[0].id })).await.unwrap();
    ssh_key_remove(&fx.tc, keys[0].id.clone()).await.unwrap();
    assert_eq!(settings::repo_settings_get(&fx.tc, id).await.unwrap().ssh_key_id, None);
}

#[tokio::test]
async fn a_key_of_another_profile_is_rejected() {
    let fx = Fixture::new().await;
    let repo = TestRepo::with_commit();
    let id = fx.tc.open(&repo).await.repo.id;
    let first = fx.tc.active_profile_id().unwrap();
    let list = settings::profile_save(&fx.tc, None, "Privat".into(), "".into(), "".into(), false, None).await.unwrap();
    let other = list.iter().find(|p| p.name == "Privat").unwrap().id.clone();
    settings::profile_activate(&fx.tc, other).await.unwrap();
    let keys = ssh_key_generate(&fx.tc, "Privat".into(), "id_privat".into(), None).await.unwrap();
    settings::profile_activate(&fx.tc, first).await.unwrap();
    let err = settings::repo_settings_set(&fx.tc, id, serde_json::json!({ "sshKeyId": keys[0].id })).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
}

#[test]
fn ssh_command_quotes_the_key_path() {
    assert_eq!(ssh_command_with_key("ssh", Path::new("/home/anna/.ssh/id_ed25519")), "ssh -i '/home/anna/.ssh/id_ed25519' -o IdentitiesOnly=yes");
    assert_eq!(
        ssh_command_with_key(" ssh -v ", Path::new("/home/o'brien/my key")),
        r"ssh -v -i '/home/o'\''brien/my key' -o IdentitiesOnly=yes"
    );
    if cfg!(windows) {
        assert_eq!(
            ssh_command_with_key("ssh", Path::new(r"C:\Users\Anna Müller\.ssh\id_ed25519")),
            "ssh -i 'C:/Users/Anna Müller/.ssh/id_ed25519' -o IdentitiesOnly=yes"
        );
    }
}

// ---------------------------------------------------------------------------
// SSH keys
// ---------------------------------------------------------------------------

fn keygen(fx: &Fixture) -> PathBuf {
    ssh::find_ssh_keygen(&AuthConfig::default(), fx.tc.git_found().as_ref()).expect("the tests need ssh-keygen")
}

/// Creates a key pair outside the app (for the import).
fn make_key(fx: &Fixture, path: &Path, passphrase: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let out = std::process::Command::new(keygen(fx))
        .args(["-q", "-t", "ed25519", "-C", "fremd@example.com", "-N", passphrase, "-f"])
        .arg(path)
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
}

#[tokio::test]
async fn generate_creates_a_key_pair_in_the_redirected_ssh_dir() {
    let fx = Fixture::new().await;
    assert!(ssh_key_list(&fx.tc).await.unwrap().is_empty());
    assert!(!fx.ssh_dir().exists(), "the folder is created when needed");

    let keys = ssh_key_generate(&fx.tc, "  Arbeit  ".into(), "id_arbeit".into(), None).await.unwrap();
    assert_eq!(keys.len(), 1);
    let key = &keys[0];
    assert_eq!(key.label, "Arbeit");
    assert_eq!(PathBuf::from(&key.private_key_path), fx.ssh_dir().join("id_arbeit"));
    assert_eq!(PathBuf::from(&key.public_key_path), fx.ssh_dir().join("id_arbeit.pub"));
    assert!(key.public_key.starts_with("ssh-ed25519 AAAA"), "{}", key.public_key);
    assert!(!key.public_key.contains('\n'));
    let fingerprint = key.fingerprint.clone().expect("Fingerabdruck");
    assert!(fingerprint.starts_with("SHA256:") && fingerprint.len() == 50, "{fingerprint}");
    assert!(!key.has_passphrase);
    assert!(!key.is_default, "the first key does not become the default by itself");
    assert!(!key.missing);
    assert!(ssh::loads_without_passphrase(&keygen(&fx), Path::new(&key.private_key_path)).await);
    let private = std::fs::read_to_string(&key.private_key_path).unwrap();
    assert!(private.starts_with("-----BEGIN OPENSSH PRIVATE KEY-----"));

    // Without an email in the profile the label is the comment in the public key.
    assert!(key.public_key.ends_with(" Arbeit"), "{}", key.public_key);

    // File name with a space and an umlaut.
    let keys = ssh_key_generate(&fx.tc, "Privat".into(), "schlüssel für zuhause".into(), None).await.unwrap();
    assert_eq!(keys.len(), 2);
    let second = keys.iter().find(|k| k.label == "Privat").unwrap();
    assert!(fx.ssh_dir().join("schlüssel für zuhause.pub").is_file());
    assert!(second.fingerprint.is_some());
    assert_ne!(second.fingerprint, key.fingerprint);

    // Existing files are never overwritten.
    let before = std::fs::read(fx.ssh_dir().join("id_arbeit")).unwrap();
    let err = ssh_key_generate(&fx.tc, "Nochmal".into(), "id_arbeit".into(), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::PathExists);
    assert!(err.message.contains("id_arbeit"), "{}", err.message);
    assert_eq!(std::fs::read(fx.ssh_dir().join("id_arbeit")).unwrap(), before);
    // Even if only the .pub file is in the way.
    std::fs::write(fx.ssh_dir().join("halb.pub"), "x").unwrap();
    let err = ssh_key_generate(&fx.tc, "Halb".into(), "halb".into(), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::PathExists);
    assert!(!fx.ssh_dir().join("halb").exists());

    for (label, file) in [("", "x"), ("  ", "x"), ("L", ""), ("L", "../raus"), ("L", "a/b"), ("L", "id.pub")] {
        let err = ssh_key_generate(&fx.tc, label.into(), file.into(), None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidName, "{label:?} {file:?}");
    }
    assert_eq!(ssh_key_list(&fx.tc).await.unwrap().len(), 2);
    assert!(!fx.dir.path().join("raus").exists());
}

#[tokio::test]
async fn generate_reports_what_is_missing() {
    let fx = Fixture::new().await;

    // Passphrase too short for ssh-keygen.
    let err = ssh_key_generate(&fx.tc, "L".into(), "kurz".into(), Some("abcd".into())).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    assert!(err.message.contains("at least 5"), "{}", err.message);

    // With a passphrase it needs the helper program (the passphrase never appears on a command line).
    configure(&fx.tc, |c| c.askpass_path = Some(PathBuf::from("gibt/es/nicht")));
    let err = ssh_key_generate(&fx.tc, "L".into(), "mit-passphrase".into(), Some(SECRET.into())).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Unsupported);
    assert!(!err.message.contains(SECRET));
    assert!(!fx.ssh_dir().join("mit-passphrase").exists());
    // An empty passphrase means: none.
    let keys = ssh_key_generate(&fx.tc, "L".into(), "ohne".into(), Some(String::new())).await.unwrap();
    assert!(!keys[0].has_passphrase);

    // ssh-keygen is missing.
    configure(&fx.tc, |c| c.ssh_keygen_path = Some(PathBuf::from("gibt/es/nicht/ssh-keygen")));
    let err = ssh_key_generate(&fx.tc, "L".into(), "ohne-keygen".into(), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Unsupported);
    assert!(err.message.contains("ssh-keygen was not found"), "{}", err.message);
    assert!(!fx.ssh_dir().join("ohne-keygen").exists());
    // The list still works; only the fingerprint is missing for new keys.
    let keys = ssh_key_list(&fx.tc).await.unwrap();
    assert_eq!(keys.len(), 1);
    assert!(keys[0].public_key.starts_with("ssh-ed25519 "));
}

#[tokio::test]
async fn import_finds_the_public_key_and_detects_the_passphrase() {
    let fx = Fixture::new().await;
    let outside = fx.dir.path().join("anderswo");
    let plain = outside.join("id_plain");
    let locked = outside.join("id mit passphrase");
    make_key(&fx, &plain, "");
    make_key(&fx, &locked, "geheim-123");

    // Without one, the .pub file next to it is used.
    let keys = ssh_key_import(&fx.tc, "Offen".into(), plain.to_string_lossy().into_owned(), None).await.unwrap();
    assert_eq!(keys.len(), 1);
    assert_eq!(PathBuf::from(&keys[0].public_key_path), outside.join("id_plain.pub"));
    assert!(!keys[0].has_passphrase);
    assert!(keys[0].public_key.ends_with("fremd@example.com"));
    assert!(keys[0].fingerprint.as_deref().unwrap_or("").starts_with("SHA256:"));

    // With a passphrase: detected from the file, and ssh-keygen sees it the same way.
    let pub_elsewhere = fx.dir.path().join("kopie.pub");
    std::fs::copy(outside.join("id mit passphrase.pub"), &pub_elsewhere).unwrap();
    let keys = ssh_key_import(
        &fx.tc,
        "Gesperrt".into(),
        locked.to_string_lossy().into_owned(),
        Some(pub_elsewhere.to_string_lossy().into_owned()),
    )
    .await
    .unwrap();
    let key = keys.iter().find(|k| k.label == "Gesperrt").unwrap();
    assert!(key.has_passphrase);
    assert_eq!(PathBuf::from(&key.public_key_path), pub_elsewhere);
    assert!(!ssh::loads_without_passphrase(&keygen(&fx), &locked).await);
    assert!(ssh::loads_without_passphrase(&keygen(&fx), &plain).await);
    assert!(key.fingerprint.is_some());

    // The same key not twice.
    let err = ssh_key_import(&fx.tc, "Doppelt".into(), plain.to_string_lossy().into_owned(), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NameExists);

    // Missing files.
    let err = ssh_key_import(&fx.tc, "X".into(), outside.join("fehlt").to_string_lossy().into_owned(), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::PathNotFound);
    let err = ssh_key_import(&fx.tc, "X".into(), "relativ/id".into(), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::PathNotFound);
    let lonely = outside.join("id_ohne_pub");
    make_key(&fx, &lonely, "");
    std::fs::remove_file(outside.join("id_ohne_pub.pub")).unwrap();
    let err = ssh_key_import(&fx.tc, "X".into(), lonely.to_string_lossy().into_owned(), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::PathNotFound);
    assert!(err.message.contains("id_ohne_pub.pub"), "{}", err.message);
    let err = ssh_key_import(
        &fx.tc,
        "X".into(),
        lonely.to_string_lossy().into_owned(),
        Some(outside.join("gibt-es-nicht.pub").to_string_lossy().into_owned()),
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::PathNotFound);

    // Swapped: the .pub file as the private key, the private one as the public key.
    let err = ssh_key_import(&fx.tc, "X".into(), outside.join("id_plain.pub").to_string_lossy().into_owned(), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    let err = ssh_key_import(
        &fx.tc,
        "X".into(),
        lonely.to_string_lossy().into_owned(),
        Some(plain.to_string_lossy().into_owned()),
    )
    .await
    .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    assert_eq!(ssh_key_list(&fx.tc).await.unwrap().len(), 2);
}

#[tokio::test]
async fn remove_and_default_only_touch_the_entries() {
    let fx = Fixture::new().await;
    ssh_key_generate(&fx.tc, "Eins".into(), "id_eins".into(), None).await.unwrap();
    let keys = ssh_key_generate(&fx.tc, "Zwei".into(), "id_zwei".into(), None).await.unwrap();
    let one = keys.iter().find(|k| k.label == "Eins").unwrap().id.clone();
    let two = keys.iter().find(|k| k.label == "Zwei").unwrap().id.clone();
    let defaults = |keys: &[SshKey]| keys.iter().filter(|k| k.is_default).map(|k| k.label.clone()).collect::<Vec<_>>();

    assert_eq!(fx.app_changes(), ["ssh_keys", "ssh_keys"], "Erzeugen meldet sich");
    fx.tc.events.clear();
    assert_eq!(defaults(&ssh_key_set_default(&fx.tc, Some(one.clone())).await.unwrap()), vec!["Eins"]);
    assert_eq!(fx.app_changes(), ["ssh_keys"]);
    assert_eq!(defaults(&ssh_key_set_default(&fx.tc, Some(two.clone())).await.unwrap()), vec!["Zwei"]);
    assert!(defaults(&ssh_key_set_default(&fx.tc, None).await.unwrap()).is_empty());
    let err = ssh_key_set_default(&fx.tc, Some("gibt-es-nicht".into())).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    ssh_key_set_default(&fx.tc, Some(two.clone())).await.unwrap();

    // A missing file is shown, not concealed.
    std::fs::remove_file(fx.ssh_dir().join("id_eins.pub")).unwrap();
    let keys = ssh_key_list(&fx.tc).await.unwrap();
    let first = keys.iter().find(|k| k.id == one).unwrap();
    assert!(first.missing);
    assert_eq!(first.public_key, "");
    assert_eq!(first.fingerprint, None);
    assert!(!keys.iter().find(|k| k.id == two).unwrap().missing);

    // Removing only deletes the entry; the files stay where they are.
    fx.tc.events.clear();
    let keys = ssh_key_remove(&fx.tc, two.clone()).await.unwrap();
    assert_eq!(fx.app_changes(), ["ssh_keys"]);
    assert_eq!(keys.len(), 1);
    assert!(fx.ssh_dir().join("id_zwei").is_file() && fx.ssh_dir().join("id_zwei.pub").is_file());
    assert_eq!(ssh_key_remove(&fx.tc, two).await.unwrap_err().code, ErrorCode::NotFound);
    // The key left behind can be registered again.
    let keys = ssh_key_import(&fx.tc, "Zwei wieder".into(), fx.ssh_dir().join("id_zwei").to_string_lossy().into_owned(), None).await.unwrap();
    assert_eq!(keys.len(), 2);
    assert!(defaults(&keys).is_empty(), "the default went away with the removed entry");
    assert_eq!(fx.app_changes(), ["ssh_keys", "ssh_keys"], "removing and importing are reported");
    // A rejected call changes nothing and reports nothing.
    fx.tc.events.clear();
    assert!(ssh_key_set_default(&fx.tc, Some("gibt-es-nicht".into())).await.is_err());
    assert!(fx.app_changes().is_empty());

    // Keys belong to the profile.
    let profiles = settings::profile_save(&fx.tc, None, "Zweites".into(), String::new(), String::new(), false, None).await.unwrap();
    let second = profiles.iter().find(|p| p.name == "Zweites").unwrap().id.clone();
    fx.tc.events.clear();
    settings::profile_activate(&fx.tc, second).await.unwrap();
    let changed = fx.app_changes();
    assert!(changed.contains(&"ssh_keys".to_string()) && changed.contains(&"credentials".to_string()), "{changed:?}");
    assert!(ssh_key_list(&fx.tc).await.unwrap().is_empty());
    assert_eq!(ssh_key_remove(&fx.tc, one).await.unwrap_err().code, ErrorCode::NotFound);
}

#[tokio::test]
async fn unconfigured_tests_never_touch_the_real_ssh_dir() {
    let tc = TestCore::new().await;
    let err = ssh_key_generate(&tc, "L".into(), "forkyard-test-darf-nicht-entstehen".into(), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    assert!(err.message.contains("SSH folder"), "{}", err.message);
}
