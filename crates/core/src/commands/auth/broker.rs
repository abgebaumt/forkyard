//! Broker for prompts from Git and SSH.
//!
//! Flow: the Git runner opens a session for every network call (`Broker::begin`) and sets its
//! environment (`GIT_ASKPASS`, `SSH_ASKPASS`, port, token). When Git or SSH asks something,
//! it starts the helper program; that connects over TCP to 127.0.0.1 and sends the token
//! and the question. The broker answers the question from the keychain or sends
//! `credential:request` to the UI and waits for `credential_answer`. At the end of the
//! call (`Session::finish`) remembered answers are stored or rejected entries are
//! deleted.
//!
//! Secrets live only in memory and in the keychain – never in SQLite, the log, events or
//! error messages.

use std::collections::HashMap;
use std::ffi::OsString;
use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Notify, OnceCell};

use super::keychain;
use super::prompt::{self, Question, StoreKey};
use crate::db::host_accounts::HostAccountRow;
use crate::db::{self, Db};
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::events::{names, EventSink};
use crate::git::redact;
use crate::model::{AppChange, AppChangedEvent, CredentialClosedEvent, CredentialKind, CredentialRequest, HostAccount, HostAccountKind, Settings};
use crate::util;

/// Environment variables through which the helper program finds the core.
pub const PORT_ENV: &str = "FORKYARD_ASKPASS_PORT";
pub const TOKEN_ENV: &str = "FORKYARD_ASKPASS_TOKEN";
/// Overrides the path of the helper program (otherwise: next to our own executable).
pub const HELPER_PATH_ENV: &str = "FORKYARD_ASKPASS_PATH";
/// File names of the helper program next to the app: the sidecar from the bundle, then the
/// binary that cargo builds from `crates/askpass`.
pub const HELPER_NAMES: [&str; 2] = ["forkyard-askpass", "askpass-helper"];
/// How long a prompt waits for the UI.
pub const DEFAULT_PROMPT_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// UI answer that accepts an unknown host key.
pub const HOST_KEY_ACCEPT: &str = "yes";

const MAX_REQUEST_LINE: u64 = 64 * 1024;
const REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(10);
/// The maximum number of questions a session answers. A session's token is in Git's
/// environment and is inherited by hooks, filters and helper programs; an ordinary call asks
/// only a few times (user name and password per remote or submodule).
pub const MAX_QUESTIONS_PER_SESSION: u32 = 256;
/// How many connections the channel serves at once; further ones are closed immediately.
const MAX_CONNECTIONS: usize = 32;

/// Settings for credentials and SSH. All `None` = default; tests use them to redirect the
/// SSH folder, keychain and helper program.
#[derive(Debug, Clone, Default)]
pub struct AuthConfig {
    /// Path of the helper program; `None` = `FORKYARD_ASKPASS_PATH`, otherwise next to our own executable.
    pub askpass_path: Option<PathBuf>,
    /// SSH folder; `None` = `FORKYARD_SSH_DIR`, otherwise `~/.ssh`.
    pub ssh_dir: Option<PathBuf>,
    /// Path of ssh-keygen; `None` = search for it.
    pub ssh_keygen_path: Option<PathBuf>,
    /// Service name in the keychain; `None` = `forkyard`.
    pub keyring_service: Option<String>,
    /// `Some(false)`: pretend there is no keychain. `None` = check.
    pub keyring_enabled: Option<bool>,
    /// Time to wait for the UI's answer; `None` = 5 minutes.
    pub prompt_timeout: Option<Duration>,
}

/// How a session handles prompts.
pub enum SessionMode {
    /// Keychain, otherwise ask the UI.
    Interactive,
    /// Keychain only; whatever is missing there fails immediately (auto-fetch).
    Silent,
    /// Every question gets this value (passphrase for ssh-keygen); no UI, no keychain.
    Scripted(String),
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Interactive,
    Silent,
    Scripted,
}

struct SessionState {
    mode: Mode,
    scripted: Option<String>,
    profile_id: String,
    /// Open prompts to the UI.
    waiting: u32,
    cancelled: bool,
    timed_out: bool,
    /// A question remained unanswered (Silent, connection gone).
    unanswered: bool,
    /// Entries supplied from the keychain.
    served: Vec<HostAccountRow>,
    /// Answers that should be stored after a success.
    remember: Vec<(StoreKey, String)>,
    /// Answers to Git's questions in this session (several Git processes, e.g. `fetch --all`).
    answered: Vec<(CredentialKind, StoreKey, String)>,
    /// Number of questions asked so far (see `MAX_QUESTIONS_PER_SESSION`).
    questions: u32,
}

struct Reply {
    value: Option<String>,
    remember: bool,
}

struct Pending {
    token: String,
    tx: oneshot::Sender<Reply>,
}

#[derive(Default)]
struct State {
    sessions: HashMap<String, SessionState>,
    pending: HashMap<String, Pending>,
}

enum Outcome {
    Answered(Reply),
    TimedOut,
    Gone,
}

pub struct Broker {
    me: Weak<Broker>,
    db: Db,
    events: Arc<dyn EventSink>,
    config: Mutex<AuthConfig>,
    state: Mutex<State>,
    /// Port of the listener; `None` if it could not be opened.
    server: OnceCell<Option<u16>>,
    shutdown: Arc<Notify>,
    /// Result of the keychain check per service name.
    keyring_probe: Mutex<Option<(String, bool)>>,
    /// Fingerprints by content of the public key.
    pub(super) fingerprints: Mutex<HashMap<String, Option<String>>>,
}

impl Drop for Broker {
    fn drop(&mut self) {
        self.shutdown.notify_one();
    }
}

impl Broker {
    pub fn new(db: Db, events: Arc<dyn EventSink>) -> Arc<Broker> {
        Arc::new_cyclic(|me| Broker {
            me: me.clone(),
            db,
            events,
            config: Mutex::new(AuthConfig::default()),
            state: Mutex::new(State::default()),
            server: OnceCell::new(),
            shutdown: Arc::new(Notify::new()),
            keyring_probe: Mutex::new(None),
            fingerprints: Mutex::new(HashMap::new()),
        })
    }

    /// Changes the settings (tests, embedded environments).
    pub fn configure(&self, change: impl FnOnce(&mut AuthConfig)) {
        change(&mut self.config.lock());
    }

    pub fn config(&self) -> AuthConfig {
        self.config.lock().clone()
    }

    fn service(&self) -> String {
        self.config.lock().keyring_service.clone().unwrap_or_else(|| keychain::DEFAULT_SERVICE.to_string())
    }

    fn prompt_timeout(&self) -> Duration {
        self.config.lock().prompt_timeout.unwrap_or(DEFAULT_PROMPT_TIMEOUT)
    }

    /// Whether answers can be remembered (keychain reachable).
    pub async fn keyring_available(&self) -> bool {
        let (forced, service) = {
            let config = self.config.lock();
            (config.keyring_enabled, config.keyring_service.clone().unwrap_or_else(|| keychain::DEFAULT_SERVICE.to_string()))
        };
        if let Some(enabled) = forced {
            return enabled;
        }
        if let Some((probed, ok)) = self.keyring_probe.lock().clone() {
            if probed == service {
                return ok;
            }
        }
        let ok = keychain::probe(&service).await;
        *self.keyring_probe.lock() = Some((service, ok));
        ok
    }

    /// Path of the helper program, if present.
    pub fn helper_path(&self) -> Option<PathBuf> {
        if let Some(path) = self.config.lock().askpass_path.clone() {
            return path.is_file().then_some(path);
        }
        if let Some(path) = util::dev_env(HELPER_PATH_ENV) {
            let path = PathBuf::from(path);
            return path.is_file().then_some(path);
        }
        let exe = std::env::current_exe().ok()?;
        let dir = exe.parent()?;
        HELPER_NAMES
            .iter()
            .map(|name| dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX)))
            .find(|candidate| candidate.is_file())
    }

    async fn port(&self) -> Option<u16> {
        *self
            .server
            .get_or_init(|| async {
                let listener = match TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await {
                    Ok(listener) => listener,
                    Err(e) => {
                        log::warn!("Channel for prompts not available: {e}");
                        return None;
                    }
                };
                let port = listener.local_addr().ok()?.port();
                tokio::spawn(serve(listener, self.me.clone(), self.shutdown.clone()));
                Some(port)
            })
            .await
    }

    // --- Sessions -----------------------------------------------------------

    /// Opens a session for a call of Git (or ssh-keygen). If the helper program is missing,
    /// the session is empty: no environment, Git behaves as without askpass.
    pub async fn begin(&self, mode: SessionMode) -> Session {
        let Some(broker) = self.me.upgrade() else {
            return Session { broker: None, token: String::new(), env: Vec::new() };
        };
        let Some(helper) = self.helper_path() else {
            // Reporting once is enough (auto-fetch runs every minute).
            static WARNED: std::sync::Once = std::sync::Once::new();
            WARNED.call_once(|| {
                log::warn!("Helper program for prompts not found; Git cannot ask for credentials.");
            });
            return Session { broker: None, token: String::new(), env: Vec::new() };
        };
        let Some(port) = self.port().await else {
            return Session { broker: None, token: String::new(), env: Vec::new() };
        };
        let token = format!("{}{}", uuid::Uuid::new_v4().simple(), uuid::Uuid::new_v4().simple());
        let (mode, scripted) = match mode {
            SessionMode::Interactive => (Mode::Interactive, None),
            SessionMode::Silent => (Mode::Silent, None),
            SessionMode::Scripted(value) => (Mode::Scripted, Some(value)),
        };
        let profile_id = self.db.with(db::profiles::active_id).unwrap_or_default();
        self.state.lock().sessions.insert(
            token.clone(),
            SessionState {
                mode,
                scripted,
                profile_id,
                waiting: 0,
                cancelled: false,
                timed_out: false,
                unanswered: false,
                served: Vec::new(),
                remember: Vec::new(),
                answered: Vec::new(),
                questions: 0,
            },
        );

        let helper = helper_env_value(&helper);
        let mut env: Vec<(OsString, OsString)> = vec![
            ("GIT_ASKPASS".into(), helper.clone()),
            ("SSH_ASKPASS".into(), helper),
            // OpenSSH 8.4 and later: askpass even when a terminal would be available.
            ("SSH_ASKPASS_REQUIRE".into(), "force".into()),
            (PORT_ENV.into(), port.to_string().into()),
            (TOKEN_ENV.into(), token.clone().into()),
        ];
        if std::env::var_os("DISPLAY").is_none() {
            // Older OpenSSH versions only use SSH_ASKPASS when DISPLAY is set.
            env.push(("DISPLAY".into(), ":0".into()));
        }
        if mode == Mode::Silent {
            // The Git Credential Manager should not open a window then either.
            env.push(("GCM_INTERACTIVE".into(), "never".into()));
        }
        Session { broker: Some(broker), token, env }
    }

    fn take_session(&self, token: &str) -> Option<SessionState> {
        let mut state = self.state.lock();
        // The session's open prompts end: the sender goes away, the helper program gets "NO".
        state.pending.retain(|_, p| p.token != token);
        state.sessions.remove(token)
    }

    fn waiting(&self, token: &str) -> bool {
        self.state.lock().sessions.get(token).is_some_and(|s| s.waiting > 0)
    }

    async fn finish(&self, token: &str, failure: Option<&CoreError>) -> Option<CoreError> {
        let session = self.take_session(token)?;
        let all_answered = !session.cancelled && !session.timed_out && !session.unanswered;
        if failure.is_some_and(rejects_credentials) {
            // Only if every question was answered was it down to the supplied entries.
            if all_answered {
                for row in &session.served {
                    self.forget_row(row).await;
                }
            }
        } else if failure.map_or(true, |e| !auth_unclear(e.code)) {
            for (key, secret) in &session.remember {
                self.remember(&session.profile_id, key, secret).await;
            }
        }
        failure?;
        if session.cancelled {
            return Some(CoreError::cancelled());
        }
        if session.timed_out {
            return Some(CoreError::new(ErrorCode::Timeout, "The credentials prompt was not answered in time."));
        }
        None
    }

    // --- Answers from the UI -------------------------------------------------

    /// Answer to a `credential:request`. `value: None` cancels.
    pub fn answer(&self, request_id: &str, value: Option<String>, remember: bool) -> CoreResult<()> {
        let pending = self.state.lock().pending.remove(request_id);
        match pending {
            Some(pending) => {
                // The receiver may already be gone (timeout at the same moment); then there is nothing to do.
                let _ = pending.tx.send(Reply { value, remember });
                Ok(())
            }
            None if value.is_none() => Ok(()),
            None => Err(CoreError::not_found(
                "This prompt is no longer open (expired or cancelled). Start the action again.",
            )),
        }
    }

    /// Number of prompts currently waiting for the UI.
    pub fn pending_count(&self) -> usize {
        self.state.lock().pending.len()
    }

    /// Number of open sessions (running network calls).
    pub fn session_count(&self) -> usize {
        self.state.lock().sessions.len()
    }

    // --- Connection of the helper program ------------------------------------

    async fn handle(self: Arc<Self>, stream: TcpStream) {
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        let read = tokio::time::timeout(REQUEST_READ_TIMEOUT, (&mut reader).take(MAX_REQUEST_LINE).read_line(&mut line)).await;
        let reply = match read {
            Ok(Ok(n)) if n > 0 && line.ends_with('\n') => match parse_request(&line) {
                Some((token, prompt)) => self.ask(&token, &prompt, &mut reader).await,
                None => None,
            },
            _ => None,
        };
        let out = match reply {
            Some(value) => format!("OK {}\n", to_hex(value.as_bytes())),
            None => "NO\n".to_string(),
        };
        let _ = write_half.write_all(out.as_bytes()).await;
        let _ = write_half.shutdown().await;
    }

    /// Answers a question: fixed value, keychain or UI. `None` = no answer.
    async fn ask<R: AsyncRead + Unpin>(&self, token: &str, prompt: &str, conn: &mut R) -> Option<String> {
        let (mode, scripted, profile_id) = {
            let mut state = self.state.lock();
            let session = state.sessions.get_mut(token)?;
            session.questions = session.questions.saturating_add(1);
            if session.questions > MAX_QUESTIONS_PER_SESSION {
                // No ordinary call asks this often: someone is probing with the session's token.
                session.unanswered = true;
                return None;
            }
            (session.mode, session.scripted.clone(), session.profile_id.clone())
        };
        if mode == Mode::Scripted {
            return scripted;
        }
        let question = prompt::classify(prompt);
        if let Some(value) = self.known_answer(token, &profile_id, &question).await {
            return Some(value);
        }
        if mode == Mode::Silent {
            if let Some(session) = self.state.lock().sessions.get_mut(token) {
                session.unanswered = true;
            }
            return None;
        }

        let can_remember =
            question.store.is_some() && question.kind != CredentialKind::Username && self.keyring_available().await;
        let request_id = util::new_id();
        let (tx, rx) = oneshot::channel();
        {
            let mut state = self.state.lock();
            state.sessions.get_mut(token)?.waiting += 1;
            state.pending.insert(request_id.clone(), Pending { token: token.to_string(), tx });
        }
        let request = CredentialRequest {
            request_id: request_id.clone(),
            kind: question.kind,
            host: question.host.clone(),
            username: question.username.clone(),
            detail: question.detail.clone(),
            prompt: display_prompt(prompt),
            can_remember,
        };
        match serde_json::to_value(&request) {
            Ok(payload) => self.events.emit(names::CREDENTIAL_REQUEST, payload),
            Err(e) => log::warn!("credential:request not serializable: {e}"),
        }

        let outcome = tokio::select! {
            reply = rx => match reply {
                Ok(reply) => Outcome::Answered(reply),
                Err(_) => Outcome::Gone,
            },
            _ = tokio::time::sleep(self.prompt_timeout()) => Outcome::TimedOut,
            _ = wait_closed(conn) => Outcome::Gone,
        };
        if !matches!(outcome, Outcome::Answered(_)) {
            // Orphaned (timeout, Git ended, action cancelled): the UI closes the dialog.
            self.emit_closed(&request_id);
        }

        let mut state = self.state.lock();
        state.pending.remove(&request_id);
        let session = state.sessions.get_mut(token)?;
        session.waiting = session.waiting.saturating_sub(1);
        match outcome {
            Outcome::Answered(Reply { value: Some(value), remember }) => match question.kind {
                CredentialKind::HostKey => {
                    if value.trim() == HOST_KEY_ACCEPT {
                        Some(HOST_KEY_ACCEPT.to_string())
                    } else {
                        // Rejecting is a cancel by the user; SSH gets a clear no.
                        session.cancelled = true;
                        Some("no".to_string())
                    }
                }
                _ => {
                    if let Some(key) = &question.store {
                        session.remember.retain(|(k, _)| k != key);
                        if remember && can_remember {
                            session.remember.push((key.clone(), value.clone()));
                        }
                        if question.from_git {
                            session.answered.retain(|(kind, k, _)| !(*kind == question.kind && k == key));
                            session.answered.push((question.kind, key.clone(), value.clone()));
                        }
                    }
                    Some(value)
                }
            },
            Outcome::Answered(Reply { value: None, .. }) => {
                session.cancelled = true;
                None
            }
            Outcome::TimedOut => {
                session.timed_out = true;
                None
            }
            Outcome::Gone => {
                session.unanswered = true;
                None
            }
        }
    }

    /// Answer without the UI: already given in this session, remembered user name or keychain.
    async fn known_answer(&self, token: &str, profile_id: &str, question: &Question) -> Option<String> {
        let key = question.store.as_ref()?;
        if question.from_git {
            let state = self.state.lock();
            let answered = &state.sessions.get(token)?.answered;
            if let Some((_, _, value)) = answered.iter().find(|(kind, k, _)| *kind == question.kind && k == key) {
                return Some(value.clone());
            }
        }
        match question.kind {
            CredentialKind::HostKey => None,
            CredentialKind::Username => {
                // Exactly one remembered account for this host: its user name.
                let rows = self.db.with(|c| db::host_accounts::list(c, profile_id)).ok()?;
                let mut matching = rows.into_iter().filter(|r| r.kind == HostAccountKind::Password && r.host == key.host);
                let first = matching.next()?;
                matching.next().is_none().then_some(first.username)
            }
            CredentialKind::Password | CredentialKind::Passphrase => {
                let row = self.find_row(profile_id, key)?;
                if !self.keyring_available().await {
                    return None;
                }
                match keychain::get(&self.service(), &row.keychain_ref).await {
                    Ok(Some(secret)) => {
                        let mut state = self.state.lock();
                        let session = state.sessions.get_mut(token)?;
                        if !session.served.iter().any(|r| r.id == row.id) {
                            session.served.push(row);
                        }
                        Some(secret)
                    }
                    Ok(None) => {
                        // The entry was deleted outside the app: update the index.
                        if self.db.with(|c| db::host_accounts::delete(c, &row.profile_id, &row.id)).is_ok() {
                            self.emit_credentials_changed();
                        }
                        None
                    }
                    Err(_) => None,
                }
            }
        }
    }

    fn emit_closed(&self, request_id: &str) {
        match serde_json::to_value(CredentialClosedEvent { request_id: request_id.to_string() }) {
            Ok(payload) => self.events.emit(names::CREDENTIAL_CLOSED, payload),
            Err(e) => log::warn!("credential:closed not serializable: {e}"),
        }
    }

    /// `app:changed` with `credentials`: remembered credentials have changed.
    pub(crate) fn emit_credentials_changed(&self) {
        match serde_json::to_value(AppChangedEvent { what: vec![AppChange::Credentials] }) {
            Ok(payload) => self.events.emit(names::APP_CHANGED, payload),
            Err(e) => log::warn!("app:changed not serializable: {e}"),
        }
    }

    // --- Keychain and index -------------------------------------------------

    fn find_row(&self, profile_id: &str, key: &StoreKey) -> Option<HostAccountRow> {
        self.db
            .with(|c| db::host_accounts::list(c, profile_id))
            .ok()?
            .into_iter()
            .find(|r| r.kind == key.kind && r.host == key.host && r.username == key.username)
    }

    async fn remember(&self, profile_id: &str, key: &StoreKey, secret: &str) {
        if profile_id.is_empty() || !self.keyring_available().await {
            return;
        }
        let service = self.service();
        let account = keychain_ref(profile_id, key);
        if let Err(e) = keychain::set(&service, &account, secret).await {
            log::warn!("Credentials not remembered: {}", e.message);
            return;
        }
        let saved = self.db.with(|c| db::host_accounts::upsert(c, profile_id, &key.host, &key.username, key.kind, &account));
        match saved {
            Ok(_) => self.emit_credentials_changed(),
            Err(e) => {
                // Without a row in the index the entry could no longer be deleted.
                log::warn!("Credentials not remembered: {}", e.message);
                let _ = keychain::delete(&service, &account).await;
            }
        }
    }

    async fn forget_row(&self, row: &HostAccountRow) -> bool {
        match keychain::delete(&self.service(), &row.keychain_ref).await {
            Ok(_) => {
                let deleted = self.db.with(|c| db::host_accounts::delete(c, &row.profile_id, &row.id)).is_ok();
                if deleted {
                    self.emit_credentials_changed();
                }
                deleted
            }
            Err(e) => {
                log::warn!("Keychain entry not deleted: {}", e.message);
                false
            }
        }
    }

    /// Remembered entries of the active profile (without the secret).
    pub fn accounts(&self) -> CoreResult<Vec<HostAccount>> {
        self.db.with(|c| {
            let profile_id = db::profiles::active_id(c)?;
            Ok(db::host_accounts::list(c, &profile_id)?.iter().map(HostAccountRow::to_model).collect())
        })
    }

    /// Deletes the keychain entries and rows of a profile; returns the count.
    /// If the keychain is not reachable, the affected rows stay (`io`).
    pub async fn forget_profile(&self, profile_id: &str) -> CoreResult<u32> {
        let rows = self.db.with(|c| db::host_accounts::list(c, profile_id))?;
        let mut removed = 0u32;
        let mut failed = 0u32;
        for row in &rows {
            if self.forget_row(row).await {
                removed += 1;
            } else {
                failed += 1;
            }
        }
        if failed > 0 {
            return Err(CoreError::io(format!(
                "{failed} entries could not be deleted from the keychain because it is not available."
            )));
        }
        Ok(removed)
    }

    /// Deletes only the keychain entries for rows already removed (profile deleted).
    pub async fn purge_keychain(&self, rows: &[HostAccountRow]) -> u32 {
        let service = self.service();
        let mut removed = 0u32;
        for row in rows {
            if matches!(keychain::delete(&service, &row.keychain_ref).await, Ok(true)) {
                removed += 1;
            }
        }
        removed
    }

    /// The SSH key that is forced for network calls: the project's (`repo_id`, always – even
    /// with an SSH agent, the choice is explicit), otherwise the default key of the active
    /// profile if `sshUseAgent` is off and the file exists. If the project key's file is
    /// missing, that is an error (`path_not_found`), not a silent fallback.
    pub fn forced_ssh_key(&self, repo_id: Option<&str>) -> CoreResult<Option<PathBuf>> {
        let (project, default) = self.db.with(|c| {
            let profile_id = db::profiles::active_id(c)?;
            let project = match repo_id {
                Some(repo_id) => match db::repo_settings::repo_ssh_key_id(c, repo_id, &profile_id)? {
                    // If the key does not (or no longer) belong to the active profile, the choice does not apply.
                    Some(key_id) => db::ssh_keys::get(c, &profile_id, &key_id)?.map(|k| PathBuf::from(k.private_key_path)),
                    None => None,
                },
                None => None,
            };
            let use_agent = db::settings::get_all(c, &profile_id)?
                .into_iter()
                .find(|(key, _)| key == "sshUseAgent")
                .and_then(|(_, value)| value.as_bool())
                .unwrap_or(Settings::default().ssh_use_agent);
            let default = if use_agent {
                None
            } else {
                db::ssh_keys::list(c, &profile_id)?.into_iter().find(|k| k.is_default).map(|k| PathBuf::from(k.private_key_path))
            };
            Ok((project, default))
        })?;
        if let Some(path) = project {
            if !path.is_file() {
                return Err(CoreError::new(
                    ErrorCode::PathNotFound,
                    format!("This repository's SSH key is missing: {}. You can change it in the project settings.", util::display_path(&path)),
                ));
            }
            return Ok(Some(path));
        }
        Ok(default.filter(|path| path.is_file()))
    }
}

/// A broker session for exactly one process call.
pub struct Session {
    broker: Option<Arc<Broker>>,
    token: String,
    env: Vec<(OsString, OsString)>,
}

impl Session {
    /// Environment for the child process; empty if the helper program is missing.
    pub fn env(&self) -> &[(OsString, OsString)] {
        &self.env
    }

    /// Whether the helper program is hooked in.
    pub fn is_active(&self) -> bool {
        self.broker.is_some()
    }

    /// Whether a prompt is currently waiting for the UI (then silence does not count as a hang).
    pub fn is_waiting(&self) -> bool {
        self.broker.as_ref().is_some_and(|b| b.waiting(&self.token))
    }

    /// Ends the session. `failure`: the error of the call, if it failed.
    /// Stores remembered answers (on success) or deletes rejected entries and returns the
    /// error that replaces the call's error: `cancelled` if the user cancelled a prompt,
    /// `timeout` if it remained unanswered.
    pub async fn finish(mut self, failure: Option<&CoreError>) -> Option<CoreError> {
        let broker = self.broker.take()?;
        broker.finish(&self.token, failure).await
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Some(broker) = self.broker.take() {
            broker.take_session(&self.token);
        }
    }
}

async fn serve(listener: TcpListener, broker: Weak<Broker>, shutdown: Arc<Notify>) {
    let slots = Arc::new(tokio::sync::Semaphore::new(MAX_CONNECTIONS));
    loop {
        tokio::select! {
            _ = shutdown.notified() => break,
            accepted = listener.accept() => {
                let Ok((stream, peer)) = accepted else {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                };
                if !peer.ip().is_loopback() {
                    continue;
                }
                // Each connection may cost up to 10 s and 64 KB (and stay open during a prompt):
                // there are never more than a handful at once in practice.
                let Ok(slot) = slots.clone().try_acquire_owned() else { continue };
                let Some(broker) = broker.upgrade() else { break };
                tokio::spawn(async move {
                    broker.handle(stream).await;
                    drop(slot);
                });
            }
        }
    }
}

/// Waits until the other side closes the connection (helper program ended).
async fn wait_closed<R: AsyncRead + Unpin>(conn: &mut R) {
    let mut buf = [0u8; 64];
    loop {
        match conn.read(&mut buf).await {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
    }
}

/// `GCAP1 <token> <hex(question)>` → (token, question).
fn parse_request(line: &str) -> Option<(String, String)> {
    let mut parts = line.trim_end_matches(['\r', '\n']).split(' ');
    if parts.next()? != "GCAP1" {
        return None;
    }
    let token = parts.next()?;
    let prompt = from_hex(parts.next().unwrap_or(""))?;
    if token.is_empty() || parts.next().is_some() {
        return None;
    }
    Some((token.to_string(), util::decode_lossy(&prompt)))
}

/// Git rejects the supplied credentials (not: no permission for this repository).
fn rejects_credentials(error: &CoreError) -> bool {
    error.code == ErrorCode::AuthFailed
        && !error.git_output.as_deref().unwrap_or("").to_lowercase().contains("returned error: 403")
}

/// With these errors it is not certain that the sign-in succeeded: remember nothing.
fn auth_unclear(code: ErrorCode) -> bool {
    matches!(
        code,
        ErrorCode::AuthFailed
            | ErrorCode::HostKeyUnknown
            | ErrorCode::Offline
            | ErrorCode::Timeout
            | ErrorCode::Cancelled
            | ErrorCode::Unknown
    )
}

pub(super) fn keychain_ref(profile_id: &str, key: &StoreKey) -> String {
    let kind = match key.kind {
        HostAccountKind::Password => "password",
        HostAccountKind::Passphrase => "passphrase",
    };
    format!("{profile_id}|{kind}|{}|{}", key.username, key.host)
}

/// Path of the helper program as Git and SSH can start it on all systems.
/// Windows: forward slashes, without `\\?\`, and for characters outside ASCII the short 8.3
/// path – Windows' OpenSSH (9.5) does not start an askpass with an umlaut in its path.
pub(super) fn helper_env_value(path: &Path) -> OsString {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        let text = text.strip_prefix(r"\\?\").unwrap_or(&text).to_string();
        let text = if text.is_ascii() {
            text
        } else {
            short_path(Path::new(&text)).map(|p| p.to_string_lossy().into_owned()).filter(|short| short.is_ascii()).unwrap_or(text)
        };
        OsString::from(text.replace('\\', "/"))
    }
    #[cfg(not(windows))]
    {
        path.as_os_str().to_os_string()
    }
}

/// Short 8.3 path of an existing file; `None` if the drive does not keep short names.
#[cfg(windows)]
fn short_path(path: &Path) -> Option<PathBuf> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut buf = vec![0u16; 1024];
    // SAFETY: `wide` ends with NUL; `buf` is as long as stated.
    let len = unsafe { GetShortPathNameW(wide.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) } as usize;
    if len == 0 || len >= buf.len() {
        return None;
    }
    Some(PathBuf::from(OsString::from_wide(&buf[..len])))
}

/// Text of the prompt for the UI. Git only names the user name in its questions; should a URL
/// ever contain `user:password@`, it is redacted.
pub(super) fn display_prompt(prompt: &str) -> String {
    let text = prompt.trim_end();
    let has_password = text.split("://").skip(1).any(|rest| {
        let authority = rest.split(['/', '\'', ' ']).next().unwrap_or("");
        authority.rsplit_once('@').is_some_and(|(userinfo, _)| userinfo.contains(':'))
    });
    if has_password {
        redact::redact(text)
    } else {
        text.to_string()
    }
}

/// `ssh` command line for `GIT_SSH_COMMAND` that uses exactly this key.
/// `base` is the user's previous command line (or `ssh`).
pub fn ssh_command_with_key(base: &str, key: &Path) -> String {
    let path = if cfg!(windows) { key.to_string_lossy().replace('\\', "/") } else { key.to_string_lossy().into_owned() };
    format!("{} -i {} -o IdentitiesOnly=yes", base.trim(), shell_quote(&path))
}

/// A word for the shell with which Git runs `GIT_SSH_COMMAND`.
pub fn shell_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

pub(super) fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[usize::from(b >> 4)] as char);
        out.push(DIGITS[usize::from(b & 0x0f)] as char);
    }
    out
}

pub(super) fn from_hex(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if bytes.len() % 2 != 0 {
        return None;
    }
    bytes
        .chunks(2)
        .map(|pair| {
            let hi = (pair[0] as char).to_digit(16)?;
            let lo = (pair[1] as char).to_digit(16)?;
            u8::try_from(hi * 16 + lo).ok()
        })
        .collect()
}
