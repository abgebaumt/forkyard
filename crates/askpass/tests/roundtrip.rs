//! Round trip with the real helper program: Git or OpenSSH starts the binary, which
//! asks the core, the core asks the UI (here: the event collector), and the answer
//! travels the same way back.
//!
//! - via the Git runner with an alias that calls the helper the way Git itself does,
//! - via `git ls-remote` against a small HTTP server with Basic Auth,
//! - via ssh-keygen (real OpenSSH code for `SSH_ASKPASS`).
//!
//! The helper lives in a folder whose name contains a space and an umlaut.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use gitcore::commands::auth::{self, keychain, ssh, AuthConfig, SessionMode};
use gitcore::model::HostAccountKind;
use gitcore::testkit::{TestCore, TestRepo};
use gitcore::{Core, CoreError, ErrorCode};

const HELPER: &str = env!("CARGO_BIN_EXE_askpass-helper");
const CREDENTIAL_REQUEST: &str = "credential:request";
const SECRET: &str = "s3hr geheim mit Ümlaut";

struct Fixture {
    tc: TestCore,
    dir: tempfile::TempDir,
}

impl Fixture {
    async fn new() -> Fixture {
        let tc = TestCore::new().await;
        let dir = tempfile::tempdir().unwrap();
        // As after an installation under “C:\Program Files\…”: a space in the path.
        let helper_dir = dir.path().join("hilfs programm ü");
        std::fs::create_dir_all(&helper_dir).unwrap();
        let helper = helper_dir.join(format!("forkyard-askpass{}", std::env::consts::EXE_SUFFIX));
        // FORKYARD_TEST_HELPER tests a different binary instead of the cargo one, e.g. the sidecar
        // in src-tauri/binaries that src-tauri/build.rs compiles with rustc.
        let source = std::env::var_os("FORKYARD_TEST_HELPER").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(HELPER));
        std::fs::copy(source, &helper).unwrap();
        let ssh_dir = dir.path().join("ssh");
        auth::configure(&tc, |c| {
            c.askpass_path = Some(helper);
            c.ssh_dir = Some(ssh_dir);
            c.keyring_enabled = Some(false);
            c.prompt_timeout = Some(Duration::from_secs(30));
        });
        Fixture { tc, dir }
    }

    fn core(&self) -> Core {
        self.tc.core.clone()
    }

    /// Waits for the n-th `credential:request` (counted from 1).
    async fn request(&self, n: usize) -> serde_json::Value {
        for _ in 0..1500 {
            let all = self.tc.events.named(CREDENTIAL_REQUEST);
            if all.len() >= n {
                return all[n - 1].clone();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("no credential:request #{n}");
    }

    fn request_count(&self) -> usize {
        self.tc.events.count(CREDENTIAL_REQUEST)
    }

    async fn answer(&self, request: &serde_json::Value, value: Option<&str>, remember: bool) {
        let id = request["requestId"].as_str().unwrap().to_string();
        auth::credential_answer(&self.tc, id, value.map(str::to_string), remember).await.unwrap();
    }
}

// ---------------------------------------------------------------------------
// The binary on its own
// ---------------------------------------------------------------------------

#[test]
fn helper_without_a_running_app_fails_without_output() {
    let run = |port: Option<&str>, token: Option<&str>| {
        let mut cmd = std::process::Command::new(HELPER);
        cmd.arg("Password for 'https://anna@git.example.com': ")
            .env_remove("FORKYARD_ASKPASS_PORT")
            .env_remove("FORKYARD_ASKPASS_TOKEN")
            .stdin(Stdio::null());
        if let Some(port) = port {
            cmd.env("FORKYARD_ASKPASS_PORT", port);
        }
        if let Some(token) = token {
            cmd.env("FORKYARD_ASKPASS_TOKEN", token);
        }
        cmd.output().unwrap()
    };
    // A port nobody listens on.
    let free_port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port().to_string();
    for (port, token) in [
        (None, None),
        (Some("keine-zahl"), Some("abc")),
        (Some(free_port.as_str()), None),
        (Some(free_port.as_str()), Some("nicht alnum!")),
        (Some(free_port.as_str()), Some("abc123")),
    ] {
        let out = run(port, token);
        assert_eq!(out.status.code(), Some(1), "{port:?} {token:?}");
        assert!(out.stdout.is_empty(), "no answer on stdout: {port:?} {token:?}");
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(stderr.starts_with("forkyard-askpass: "), "{stderr}");
    }
}

// ---------------------------------------------------------------------------
// Via the Git runner
// ---------------------------------------------------------------------------

/// Git alias that starts the helper the way Git does for a prompt.
const ASK_ALIAS: &str = "alias.ask=!\"$GIT_ASKPASS\" \"Password for 'https://anna@git.example.com': \"";

fn spawn_ask(core: Core, repo_id: String, no_prompt: bool) -> tokio::task::JoinHandle<Result<String, CoreError>> {
    tokio::spawn(async move {
        // Short idle limit: the open prompt must still not count as a hang.
        let mut cmd = core.git_for(&repo_id)?.args(["-c", ASK_ALIAS, "ask"]).network().idle_timeout(Duration::from_secs(1));
        if no_prompt {
            cmd = cmd.no_prompt();
        }
        cmd.run_text().await
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn runner_roundtrip_answer_cancel_timeout() {
    let fx = Fixture::new().await;
    let repo = TestRepo::with_commit();
    let id = fx.tc.open(&repo).await.repo.id;

    // Answer: question → event → credential_answer → stdout of the helper.
    let call = spawn_ask(fx.core(), id.clone(), false);
    let request = fx.request(1).await;
    assert_eq!(request["kind"], "password");
    assert_eq!(request["host"], "git.example.com");
    assert_eq!(request["username"], "anna");
    assert_eq!(request["prompt"], "Password for 'https://anna@git.example.com':");
    assert_eq!(request["canRemember"], false);
    // Wait longer than the call's idle limit.
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert!(!call.is_finished(), "Git must not be killed for idleness while a prompt is open");
    fx.answer(&request, Some(SECRET), false).await;
    assert_eq!(call.await.unwrap().unwrap(), SECRET);
    assert_eq!(fx.tc.git.broker().session_count(), 0);

    // Cancel: the helper exits with an error, the caller gets `cancelled`.
    let call = spawn_ask(fx.core(), id.clone(), false);
    let request = fx.request(2).await;
    fx.answer(&request, None, false).await;
    let err = call.await.unwrap().unwrap_err();
    assert_eq!(err.code, ErrorCode::Cancelled);

    // Without prompts (auto-fetch): fails immediately, no event.
    let started = Instant::now();
    let err = spawn_ask(fx.core(), id.clone(), true).await.unwrap().unwrap_err();
    assert_ne!(err.code, ErrorCode::Cancelled);
    assert_ne!(err.code, ErrorCode::Timeout);
    assert!(started.elapsed() < Duration::from_secs(10));
    assert_eq!(fx.request_count(), 2);

    // Prompt timeout (shortened): `timeout` with its own message.
    auth::configure(&fx.tc, |c| c.prompt_timeout = Some(Duration::from_millis(400)));
    let err = spawn_ask(fx.core(), id.clone(), false).await.unwrap().unwrap_err();
    assert_eq!(err.code, ErrorCode::Timeout);
    assert!(err.message.contains("credentials prompt"), "{}", err.message);
    assert_eq!(fx.request_count(), 3);
    let stale = fx.request(3).await;
    let late = auth::credential_answer(&fx.tc, stale["requestId"].as_str().unwrap().into(), Some("zu spät".into()), false).await;
    assert_eq!(late.unwrap_err().code, ErrorCode::NotFound);

    // The answer appears in no prompt. (It only shows up in the log here because the test alias
    // passes the helper's output through; Git itself reads it internally – see the HTTP test,
    // which checks the log and the database.)
    let requests = serde_json::to_string(&fx.tc.events.named(CREDENTIAL_REQUEST)).unwrap();
    assert!(!requests.contains(SECRET));
    assert_eq!(fx.tc.git.broker().session_count(), 0);
    assert_eq!(fx.tc.git.broker().pending_count(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_the_job_closes_the_open_request() {
    let fx = Fixture::new().await;
    let repo = TestRepo::with_commit();
    let id = fx.tc.open(&repo).await.repo.id;
    let token = gitcore::jobs::CancelToken::new();
    let call = {
        let (core, id, token) = (fx.core(), id.clone(), token.clone());
        tokio::spawn(async move {
            core.git_for(&id)?.args(["-c", ASK_ALIAS, "ask"]).network().run_stream(&token, &mut |_| {}).await
        })
    };
    let request = fx.request(1).await;
    token.cancel();
    assert_eq!(call.await.unwrap().unwrap_err().code, ErrorCode::Cancelled);
    assert_eq!(fx.tc.git.broker().pending_count(), 0);
    let late = auth::credential_answer(&fx.tc, request["requestId"].as_str().unwrap().into(), Some("x".into()), false).await;
    assert_eq!(late.unwrap_err().code, ErrorCode::NotFound);
}

// ---------------------------------------------------------------------------
// HTTPS round trip: git ls-remote against an HTTP server with Basic Auth
// ---------------------------------------------------------------------------

/// Small HTTP server for the “dumb” Git protocol: serves files from a bare repository,
/// requires Basic Auth.
struct HttpRemote {
    port: u16,
    credentials: Arc<Mutex<(String, String)>>,
    /// Requests with valid credentials.
    authorized: Arc<AtomicUsize>,
    /// Requests without or with wrong credentials.
    rejected: Arc<AtomicUsize>,
}

impl HttpRemote {
    fn start(root: PathBuf, user: &str, password: &str) -> HttpRemote {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let credentials = Arc::new(Mutex::new((user.to_string(), password.to_string())));
        let authorized = Arc::new(AtomicUsize::new(0));
        let rejected = Arc::new(AtomicUsize::new(0));
        let (creds, ok, no) = (credentials.clone(), authorized.clone(), rejected.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (root, creds, ok, no) = (root.clone(), creds.clone(), ok.clone(), no.clone());
                std::thread::spawn(move || handle_http(stream, &root, &creds, &ok, &no));
            }
        });
        HttpRemote { port, credentials, authorized, rejected }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}/remote.git", self.port)
    }

    fn set_password(&self, password: &str) {
        self.credentials.lock().unwrap().1 = password.to_string();
    }
}

fn handle_http(mut stream: TcpStream, root: &Path, creds: &Mutex<(String, String)>, ok: &AtomicUsize, no: &AtomicUsize) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") && head.len() < 64 * 1024 {
        match stream.read(&mut byte) {
            Ok(1) => head.push(byte[0]),
            _ => return,
        }
    }
    let head = String::from_utf8_lossy(&head).into_owned();
    let mut lines = head.split("\r\n");
    let target = lines.next().unwrap_or("").split(' ').nth(1).unwrap_or("").to_string();
    let authorization = lines
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("authorization"))
        .map(|(_, value)| value.trim().to_string());
    let expected = {
        let (user, password) = &*creds.lock().unwrap();
        format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}")))
    };
    let respond = |stream: &mut TcpStream, status: &str, extra: &str, body: &[u8]| {
        let header = format!(
            "HTTP/1.1 {status}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n",
            body.len()
        );
        let _ = stream.write_all(header.as_bytes());
        let _ = stream.write_all(body);
        let _ = stream.flush();
    };
    if authorization.as_deref() != Some(expected.as_str()) {
        no.fetch_add(1, Ordering::SeqCst);
        respond(&mut stream, "401 Unauthorized", "WWW-Authenticate: Basic realm=\"Test\"\r\n", b"");
        return;
    }
    ok.fetch_add(1, Ordering::SeqCst);
    let path = target.split('?').next().unwrap_or("");
    let file = match path.strip_prefix("/remote.git/") {
        Some(rel) if !rel.split('/').any(|part| part == ".." || part.is_empty()) => root.join(rel),
        _ => {
            respond(&mut stream, "404 Not Found", "", b"");
            return;
        }
    };
    match std::fs::read(&file) {
        Ok(body) => respond(&mut stream, "200 OK", "", &body),
        Err(_) => respond(&mut stream, "404 Not Found", "", b""),
    }
}

async fn ls_remote(fx: &Fixture, url: &str, no_prompt: bool) -> tokio::task::JoinHandle<Result<String, CoreError>> {
    let (core, url, cwd) = (fx.core(), url.to_string(), fx.dir.path().to_path_buf());
    tokio::spawn(async move {
        let mut cmd = core
            .git_at(&cwd)
            .args(["ls-remote", url.as_str()])
            .env("NO_PROXY", "127.0.0.1")
            .env("no_proxy", "127.0.0.1")
            .network();
        if no_prompt {
            cmd = cmd.no_prompt();
        }
        cmd.run_text().await
    })
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn https_roundtrip_with_basic_auth() {
    let fx = Fixture::new().await;
    let repo = TestRepo::with_commit();
    let remote = repo.add_remote();
    remote.git(&["update-server-info"]);
    let head = repo.head();
    let server = HttpRemote::start(remote.path().to_path_buf(), "anna", SECRET);
    let url = server.url();
    let host = format!("127.0.0.1:{}", server.port);

    // Keychain with its own service name; without a writable keychain (none, or locked) the “remember” part is skipped.
    let service = format!("{}{}", keychain::TEST_SERVICE_PREFIX, uuid_like());
    let with_keyring = keychain::probe_writable(&service).await;
    // Even if the test fails midway, no entry is left behind in the machine's keychain.
    let _cleanup = KeyringCleanup { core: fx.core(), service: service.clone() };
    if with_keyring {
        let name = service.clone();
        auth::configure(&fx.tc, |c| {
            c.keyring_service = Some(name);
            c.keyring_enabled = None;
        });
    } else {
        eprintln!("no keychain reachable: skipping the “remember” part");
    }

    // 1. Git asks for username and password; both answers reach Git.
    let call = ls_remote(&fx, &url, false).await;
    let request = fx.request(1).await;
    assert_eq!(request["kind"], "username");
    assert_eq!(request["host"], host.as_str());
    assert_eq!(request["prompt"], format!("Username for 'http://{host}':"));
    fx.answer(&request, Some("anna"), false).await;
    let request = fx.request(2).await;
    assert_eq!(request["kind"], "password");
    assert_eq!(request["host"], host.as_str());
    assert_eq!(request["username"], "anna");
    assert_eq!(request["canRemember"], with_keyring);
    fx.answer(&request, Some(SECRET), true).await;
    let output = call.await.unwrap().unwrap();
    assert!(output.contains(&format!("{head}\trefs/heads/main")), "{output}");
    assert!(server.authorized.load(Ordering::SeqCst) >= 1);
    assert!(server.rejected.load(Ordering::SeqCst) >= 1, "Git only asked after the 401");

    if with_keyring {
        let accounts = auth::credentials_list(&fx.tc).await.unwrap();
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].host, format!("http://{host}"));
        assert_eq!(accounts[0].username, "anna");
        assert_eq!(accounts[0].kind, HostAccountKind::Password);

        // 2. Remembered: the next call needs no prompt – even when prompts are not allowed.
        for no_prompt in [false, true] {
            let output = ls_remote(&fx, &url, no_prompt).await.await.unwrap().unwrap();
            assert!(output.contains(&head), "{output}");
        }
        assert_eq!(fx.request_count(), 2);

        // 3. The password was changed on the server: Git rejects, the entry disappears.
        server.set_password("neues Passwort");
        let err = ls_remote(&fx, &url, false).await.await.unwrap().unwrap_err();
        assert_eq!(err.code, ErrorCode::AuthFailed);
        assert!(!err.git_output.clone().unwrap_or_default().contains(SECRET));
        assert_eq!(fx.request_count(), 2, "the remembered password was tried without a prompt");
        assert!(auth::credentials_list(&fx.tc).await.unwrap().is_empty());
    } else {
        server.set_password("neues Passwort");
    }

    // 4. After that it asks again; a wrong password is not remembered.
    let before = fx.request_count();
    let call = ls_remote(&fx, &url, false).await;
    let request = fx.request(before + 1).await;
    assert_eq!(request["kind"], "username");
    fx.answer(&request, Some("anna"), false).await;
    let request = fx.request(before + 2).await;
    fx.answer(&request, Some("falsch"), true).await;
    let err = call.await.unwrap().unwrap_err();
    assert_eq!(err.code, ErrorCode::AuthFailed);
    assert!(auth::credentials_list(&fx.tc).await.unwrap().is_empty());

    // 5. Cancelling the prompt: `cancelled`.
    let call = ls_remote(&fx, &url, false).await;
    let request = fx.request(before + 3).await;
    fx.answer(&request, None, false).await;
    assert_eq!(call.await.unwrap().unwrap_err().code, ErrorCode::Cancelled);

    // 6. Without prompts and without remembered data: immediately `auth_failed`, no event.
    let started = Instant::now();
    let err = ls_remote(&fx, &url, true).await.await.unwrap().unwrap_err();
    assert_eq!(err.code, ErrorCode::AuthFailed);
    assert!(started.elapsed() < Duration::from_secs(15));
    assert_eq!(fx.request_count(), before + 3);

    // 7. With the right password it works again; clean up at the end.
    let call = ls_remote(&fx, &url, false).await;
    let request = fx.request(before + 4).await;
    fx.answer(&request, Some("anna"), false).await;
    let request = fx.request(before + 5).await;
    fx.answer(&request, Some("neues Passwort"), true).await;
    assert!(call.await.unwrap().unwrap().contains(&head));
    let remembered = auth::credentials_forget_all(&fx.tc).await.unwrap();
    assert_eq!(remembered, u32::from(with_keyring));

    // No password in events (log, prompts) or in the database.
    let events = serde_json::to_string(&fx.tc.events.all()).unwrap();
    for secret in [SECRET, "neues Passwort", "falsch"] {
        assert!(!events.contains(secret), "{secret} in an event");
        for file in ["forkyard.db", "forkyard.db-wal"] {
            if let Ok(bytes) = std::fs::read(fx.tc.data_dir().join(file)) {
                assert!(!bytes.windows(secret.len()).any(|w| w == secret.as_bytes()), "{secret} in {file}");
            }
        }
    }
}

/// When the test is left (even after a panic), deletes everything it stored in the keychain
/// under its own service name.
struct KeyringCleanup {
    core: Core,
    service: String,
}

impl Drop for KeyringCleanup {
    fn drop(&mut self) {
        keychain::remove_test_entries(&self.core, &self.service);
    }
}

fn uuid_like() -> String {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    format!("{nanos:x}-{:x}", std::process::id())
}

// ---------------------------------------------------------------------------
// SSH_ASKPASS: real OpenSSH code via ssh-keygen
// ---------------------------------------------------------------------------

/// Every ssh-keygen on this machine: the one bundled with Git and, on Windows, the system one.
fn keygens(fx: &Fixture) -> Vec<PathBuf> {
    let mut found = vec![ssh::find_ssh_keygen(&AuthConfig::default(), fx.tc.git_found().as_ref()).expect("the tests need ssh-keygen")];
    if cfg!(windows) {
        if let Some(root) = std::env::var_os("SystemRoot") {
            let system = Path::new(&root).join("System32").join("OpenSSH").join("ssh-keygen.exe");
            if system.is_file() && !found.contains(&system) {
                found.push(system);
            }
        }
    }
    found
}

fn run_keygen(keygen: &Path, args: &[&str], file: &Path) -> std::process::Output {
    std::process::Command::new(keygen).args(args).arg(file).stdin(Stdio::null()).output().unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn key_with_passphrase_is_generated_through_askpass() {
    let fx = Fixture::new().await;
    for (n, keygen) in keygens(&fx).into_iter().enumerate() {
        eprintln!("ssh-keygen: {}", keygen.display());
        let path = keygen.clone();
        auth::configure(&fx.tc, |c| c.ssh_keygen_path = Some(path));
        let name = format!("id mit passphrase {n}");
        let keys = auth::ssh_key_generate(&fx.tc, format!("Gesperrt {n}"), name.clone(), Some(SECRET.into())).await.unwrap();
        let key = keys.iter().find(|k| k.label == format!("Gesperrt {n}")).unwrap();
        assert!(key.has_passphrase, "{}", keygen.display());
        assert!(key.public_key.starts_with("ssh-ed25519 "));
        assert!(key.fingerprint.as_deref().unwrap_or("").starts_with("SHA256:"));
        assert!(!key.missing);
        let private = PathBuf::from(&key.private_key_path);
        assert!(!ssh::loads_without_passphrase(&keygen, &private).await);
        // Exactly the given passphrase unlocks the key.
        assert!(run_keygen(&keygen, &["-y", "-P", SECRET, "-f"], &private).status.success());
        assert!(!run_keygen(&keygen, &["-y", "-P", "etwas anderes", "-f"], &private).status.success());
    }
    assert_eq!(fx.request_count(), 0, "the passphrase comes from the command, not from a prompt");
    assert_eq!(fx.tc.git.broker().session_count(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn openssh_asks_for_the_passphrase_through_the_helper() {
    let fx = Fixture::new().await;
    let broker = fx.tc.git.broker().clone();
    let mut asked = 0;
    for (n, keygen) in keygens(&fx).into_iter().enumerate() {
        eprintln!("ssh-keygen: {}", keygen.display());
        let key = fx.dir.path().join(format!("schlüssel {n}"));
        assert!(run_keygen(&keygen, &["-q", "-t", "ed25519", "-N", SECRET, "-C", "test", "-f"], &key).status.success());
        let public = std::fs::read_to_string(ssh::public_path_for(&key)).unwrap();

        // `ssh-keygen -y` needs the passphrase and asks for it via SSH_ASKPASS.
        let unlock = |session: &auth::Session| {
            let mut cmd = tokio::process::Command::new(&keygen);
            cmd.args(["-y", "-f"]).arg(&key).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
            for (k, v) in session.env() {
                cmd.env(k, v);
            }
            cmd.spawn().unwrap()
        };

        let session = broker.begin(SessionMode::Interactive).await;
        assert!(session.is_active());
        let child = unlock(&session);
        asked += 1;
        let request = fx.request(asked).await;
        assert_eq!(request["kind"], "passphrase", "{request}");
        assert!(request["prompt"].as_str().unwrap().contains("passphrase"), "{request}");
        assert!(session.is_waiting());
        fx.answer(&request, Some(SECRET), false).await;
        let out = child.wait_with_output().await.unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        let printed = String::from_utf8_lossy(&out.stdout);
        let key_part = |line: &str| line.split_whitespace().take(2).collect::<Vec<_>>().join(" ");
        assert_eq!(key_part(&printed), key_part(&public));
        assert!(session.finish(None).await.is_none());

        // Wrong passphrase and cancel: ssh-keygen fails, nothing hangs.
        for answer in [Some("falsch"), None] {
            let session = broker.begin(SessionMode::Interactive).await;
            let child = unlock(&session);
            asked += 1;
            let request = fx.request(asked).await;
            fx.answer(&request, answer, false).await;
            let out = tokio::time::timeout(Duration::from_secs(20), child.wait_with_output()).await.unwrap().unwrap();
            assert!(!out.status.success(), "{answer:?}");
            assert!(out.stdout.is_empty());
            drop(session);
        }
    }
    assert_eq!(broker.pending_count(), 0);
}
