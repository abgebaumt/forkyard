//! The Git runner: the only way the core invokes Git.
//!
//! Every call runs with a fixed environment (`LC_ALL=C`, no pager, no
//! terminal prompts, no editor), returns bytes and is recorded in the
//! activity log (plus event `log:appended`).
//!
//! ```ignore
//! let out = core.git_for(&repo_id)?            // cwd = repository, logged with repo_id
//!     .args(["rev-parse", "--verify", "HEAD"])
//!     .read_only()                              // GIT_OPTIONAL_LOCKS=0
//!     .run()                                    // exit != 0 → CoreError (see errors.rs)
//!     .await?;
//! let sha = out.stdout_text();
//! ```
//!
//! Network calls (`.network()`: clone, fetch, pull, push, ls-remote) additionally get the
//! askpass environment: when Git or SSH asks for a user name, password, passphrase or an
//! unknown host key, the question goes through the helper program to the broker
//! (`commands::auth::broker`) and from there as `credential:request` to the UI. If the user
//! cancels the prompt, the call ends with `cancelled`; if it stays unanswered, with `timeout`.
//! With `.no_prompt()` nothing is ever asked.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Notify;

use crate::commands::auth::broker::{self, Broker, SessionMode};
use crate::db::{self, Db};
use crate::error::{CoreError, CoreResult};
use crate::events::{names, EventSink};
use crate::git::locate::GitInfo;
use crate::git::netconfig::{self, NetConfig};
use crate::git::{errors, redact};
use crate::model::Settings;
use crate::jobs::CancelToken;
use crate::util;

/// Windows: no console window for child processes.
pub const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// Total time for network actions (`GitCmd::network`).
pub const NETWORK_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// Network actions abort when Git prints nothing for this long.
pub const NETWORK_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
/// Interval at which silence (idle_timeout, PIPE_GRACE) is checked.
const TICK: Duration = Duration::from_millis(100);
/// Once Git has exited, wait at most this long for end of file on stdout/stderr.
const PIPE_GRACE: Duration = Duration::from_millis(300);
/// At most this much stderr is collected.
const MAX_STDERR: usize = 1024 * 1024;
/// At most this much output goes into the log.
const MAX_LOG_OUTPUT: usize = 8 * 1024;
/// If a write command fails on a foreign `index.lock`, wait this long to see whether the lock
/// disappears on its own (an editor's `git status` holds it only for milliseconds).
pub const LOCK_RETRY_WINDOW: Duration = Duration::from_secs(2);
const LOCK_RETRY_PAUSE: Duration = Duration::from_millis(40);
/// Subcommands that take the index lock BEFORE they change anything: if they fail on it,
/// nothing has happened and the same call may be repeated. Multi-step commands (rebase,
/// cherry-pick, revert, stash, pull) only count with `--abort`.
const LOCK_RETRY_SUBCOMMANDS: [&str; 13] =
    ["add", "rm", "mv", "reset", "restore", "checkout", "switch", "update-index", "read-tree", "write-tree", "apply", "commit", "merge"];
const LOCK_RETRY_ABORTS: [&str; 3] = ["rebase", "cherry-pick", "revert"];

/// Start of the log line that names the forced SSH key.
pub const SSH_KEY_NOTE_PREFIX: &str = "SSH key: ";

/// Result of a Git call. Output is raw bytes.
#[derive(Debug, Clone, Default)]
pub struct GitOutput {
    /// Exit code; `None` if the process was killed (cancel, early stop in `run_records`).
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub duration: Duration,
}

impl GitOutput {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }
    /// stdout decoded lossily, without trailing line breaks.
    pub fn stdout_text(&self) -> String {
        util::decode_lossy(&self.stdout).trim_end_matches(['\n', '\r']).to_string()
    }
    /// stderr decoded lossily, without credentials.
    pub fn stderr_text(&self) -> String {
        redact::redact_bytes(&self.stderr).trim_end().to_string()
    }
    /// stdout split at NUL bytes (for `-z` output).
    pub fn stdout_z(&self) -> Vec<&[u8]> {
        util::split_z(&self.stdout).collect()
    }
    /// stdout line by line (`\n`), without `\r` at the end of the line.
    pub fn stdout_lines(&self) -> Vec<&[u8]> {
        util::split_records(&self.stdout, b'\n').map(|l| l.strip_suffix(b"\r").unwrap_or(l)).collect()
    }
}

#[derive(Clone)]
pub struct GitRunner {
    inner: Arc<RunnerInner>,
}

struct RunnerInner {
    /// Result of locating Git; `GitRunner::set_git` replaces it (re-check without restart).
    git: parking_lot::RwLock<Result<GitInfo, CoreError>>,
    env: Vec<(OsString, OsString)>,
    db: Db,
    events: Arc<dyn EventSink>,
    /// Broker for credential prompts (only used with `.network()`).
    broker: Arc<Broker>,
    /// Proxy passwords from the keychain, per profile and slot (see `network_settings`).
    proxy_passwords: parking_lot::Mutex<std::collections::HashMap<String, String>>,
    /// Empty folder that `core.hooksPath` points to for guarded calls (`GitCmd::guarded`).
    guard_hooks: parking_lot::RwLock<Option<PathBuf>>,
    /// Per SSH program: whether it passes server questions on unmarked (OpenSSH before 8.5).
    legacy_ssh: parking_lot::Mutex<std::collections::HashMap<String, bool>>,
}

impl GitRunner {
    /// `git`: result of `locate::detect()`. `env`: additional environment for every
    /// call (tests set e.g. `GIT_CONFIG_GLOBAL` here).
    pub fn new(git: CoreResult<GitInfo>, env: Vec<(OsString, OsString)>, db: Db, events: Arc<dyn EventSink>) -> Self {
        let broker = Broker::new(db.clone(), events.clone());
        GitRunner {
            inner: Arc::new(RunnerInner {
                git: parking_lot::RwLock::new(git),
                env,
                db,
                events,
                broker,
                proxy_passwords: parking_lot::Mutex::new(std::collections::HashMap::new()),
                guard_hooks: parking_lot::RwLock::new(None),
                legacy_ssh: parking_lot::Mutex::new(std::collections::HashMap::new()),
            }),
        }
    }

    /// Sets the (empty) folder that guarded calls redirect `core.hooksPath` to.
    pub fn set_guard_hooks_dir(&self, dir: PathBuf) {
        *self.inner.guard_hooks.write() = Some(dir);
    }

    /// Removes secrets the runner itself knows (proxy passwords) literally from a text.
    fn scrub_known(&self, text: &str) -> String {
        let secrets: Vec<String> = self.inner.proxy_passwords.lock().values().cloned().collect();
        if secrets.is_empty() {
            return text.to_string();
        }
        crate::secrets::scrub(text, &secrets)
    }

    /// Replaces the located Git (after a new search). Running calls are not affected.
    pub fn set_git(&self, git: CoreResult<GitInfo>) {
        *self.inner.git.write() = git;
    }

    /// The broker for prompts from Git and SSH (credentials, host keys).
    pub fn broker(&self) -> &Arc<Broker> {
        &self.inner.broker
    }

    /// Located Git, or `git_missing` / `git_too_old`.
    pub fn info(&self) -> CoreResult<GitInfo> {
        self.inner.git.read().clone()
    }

    /// The network settings of the active profile as `-c` entries (see `netconfig`).
    /// Read on every network call: a change takes effect immediately, without a restart.
    pub fn network_config(&self) -> NetConfig {
        netconfig::from_settings(&self.network_settings())
    }

    /// The network fields of the active profile's settings (everything else is at its default),
    /// normalized and with the proxy passwords from the keychain put back in.
    /// The result therefore contains secrets and only goes to Git or the HTTP client –
    /// never to the UI, never into the log.
    pub fn network_settings(&self) -> Settings {
        let stored = self.inner.db.with(|c| {
            let profile_id = db::profiles::active_id(c)?;
            let all = db::settings::get_all(c, &profile_id)?;
            Ok((profile_id, all))
        });
        let (profile_id, stored) = stored.unwrap_or_default();
        let mut settings = Settings::default();
        for (key, value) in stored {
            // Each field on its own: one unreadable value leaves the others in effect.
            match key.as_str() {
                "proxyUrl" => settings.proxy_url = serde_json::from_value(value).unwrap_or_default(),
                "proxyByHost" => settings.proxy_by_host = serde_json::from_value(value).unwrap_or_default(),
                "sslCaFile" => settings.ssl_ca_file = serde_json::from_value(value).unwrap_or_default(),
                "sslNoVerifyHosts" => settings.ssl_no_verify_hosts = serde_json::from_value(value).unwrap_or_default(),
                _ => {}
            }
        }
        netconfig::normalize_lenient(&mut settings);
        let passwords = self.inner.proxy_passwords.lock();
        let lookup = |slot: &str| passwords.get(&netconfig::proxy_cache_key(&profile_id, slot));
        if let Some(proxy) = settings.proxy_url.as_mut() {
            if let Some(password) = lookup(netconfig::PROXY_SLOT_GLOBAL) {
                *proxy = netconfig::with_proxy_password(proxy, password);
            }
        }
        for entry in settings.proxy_by_host.iter_mut() {
            if let Some(password) = lookup(&entry.host) {
                entry.proxy = netconfig::with_proxy_password(&entry.proxy, password);
            }
        }
        settings
    }

    /// Remembers (or forgets) a proxy password for the current session. The source is the
    /// keychain; `commands::settings` fills this cache at startup and on every change.
    /// `slot`: `netconfig::PROXY_SLOT_GLOBAL` or the host entry.
    pub fn set_proxy_password(&self, profile_id: &str, slot: &str, password: Option<String>) {
        let key = netconfig::proxy_cache_key(profile_id, slot);
        let mut passwords = self.inner.proxy_passwords.lock();
        match password {
            Some(password) => {
                crate::crash::remember_secret(&password);
                passwords.insert(key, password);
            }
            None => {
                passwords.remove(&key);
            }
        }
    }

    /// Log line when network calls (in repository `repo_id`) force an SSH key – the project's
    /// key, or the default key when `sshUseAgent` is off:
    /// `SSH key: <path>` – only the path, never a secret.
    pub fn forced_ssh_key_note(&self, repo_id: Option<&str>) -> Option<String> {
        self.inner.broker.forced_ssh_key(repo_id).ok().flatten().map(|path| format!("{SSH_KEY_NOTE_PREFIX}{}", util::display_path(&path)))
    }

    /// The additional environment of every Git call (from `CoreConfig::git_env`) – for programs
    /// that are started detached and should see the same Git configuration.
    pub fn base_env(&self) -> Vec<(OsString, OsString)> {
        self.inner.env.clone()
    }

    /// New call with working directory `cwd`. Without `.repo(..)` it goes to the app log.
    pub fn cmd(&self, cwd: impl AsRef<Path>) -> GitCmd {
        GitCmd {
            runner: self.clone(),
            cwd: cwd.as_ref().to_path_buf(),
            repo_id: None,
            args: Vec::new(),
            env: Vec::new(),
            stdin: None,
            read_only: false,
            check: true,
            timeout: None,
            idle_timeout: None,
            log: true,
            network: false,
            prompt: true,
            guarded: false,
        }
    }
}

/// Callback for stderr lines (`run_stream`).
pub type LineFn<'a> = dyn FnMut(&str) + Send + 'a;
/// Callback for stdout records (`run_records`); `false` stops early.
pub type RecordFn<'a> = dyn FnMut(&[u8]) -> bool + Send + 'a;

/// A prepared Git call (builder). Run it with `run`, `run_stream` or `run_records`.
pub struct GitCmd {
    runner: GitRunner,
    cwd: PathBuf,
    repo_id: Option<String>,
    args: Vec<OsString>,
    env: Vec<(OsString, OsString)>,
    stdin: Option<Vec<u8>>,
    read_only: bool,
    check: bool,
    timeout: Option<Duration>,
    idle_timeout: Option<Duration>,
    log: bool,
    network: bool,
    prompt: bool,
    guarded: bool,
}

impl GitCmd {
    /// Assigns the call to a repository (logged with scope `repo`).
    /// The ID must exist in the database, otherwise the entry goes to the app log.
    pub fn repo(mut self, repo_id: &str) -> Self {
        self.repo_id = Some(repo_id.to_string());
        self
    }
    pub fn arg(mut self, arg: impl AsRef<OsStr>) -> Self {
        self.args.push(arg.as_ref().to_os_string());
        self
    }
    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.args.extend(args.into_iter().map(|a| a.as_ref().to_os_string()));
        self
    }
    /// Argument from raw bytes (e.g. a path from `-z` output), byte-exact on Unix.
    pub fn arg_bytes(mut self, arg: &[u8]) -> Self {
        self.args.push(util::bytes_to_os(arg));
        self
    }
    pub fn env(mut self, key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) -> Self {
        self.env.push((key.as_ref().to_os_string(), value.as_ref().to_os_string()));
        self
    }
    /// Read command: sets `GIT_OPTIONAL_LOCKS=0` so it never blocks a write action.
    pub fn read_only(mut self) -> Self {
        self.read_only = true;
        self
    }
    /// Data for stdin.
    pub fn stdin(mut self, data: impl Into<Vec<u8>>) -> Self {
        self.stdin = Some(data.into());
        self
    }
    /// `false`: exit code != 0 is not an error; the caller evaluates `GitOutput.code` itself.
    pub fn check(mut self, check: bool) -> Self {
        self.check = check;
        self
    }
    /// Overall time limit; after it the process is killed and `timeout` is reported.
    pub fn timeout(mut self, limit: Duration) -> Self {
        self.timeout = Some(limit);
        self
    }
    /// Abort when Git prints nothing on either stdout or stderr for this long.
    pub fn idle_timeout(mut self, limit: Duration) -> Self {
        self.idle_timeout = Some(limit);
        self
    }
    /// Network action: default time limits (`NETWORK_TIMEOUT`, `NETWORK_IDLE_TIMEOUT`) and
    /// credential prompts through the UI (`GIT_ASKPASS`, `SSH_ASKPASS`).
    /// While a prompt is open, Git's silence does not count as a hang.
    /// The default SSH key is forced when `settings.sshUseAgent` is off.
    pub fn network(mut self) -> Self {
        self.network = true;
        self.timeout(NETWORK_TIMEOUT).idle_timeout(NETWORK_IDLE_TIMEOUT)
    }
    /// Never prompt (auto-fetch). Only effective together with `.network()`. Remembered
    /// credentials from the keychain are used; if something is missing or a host key is
    /// unknown, the call fails immediately (`auth_failed` or `host_key_unknown`) – without
    /// `credential:request` and without a Git Credential Manager window. The forced default
    /// SSH key applies as with every network call. If the prompt helper program is missing,
    /// askpass and ssh are silenced hard (`BatchMode`).
    pub fn no_prompt(mut self) -> Self {
        self.prompt = false;
        self
    }
    /// Don't log. Only for very frequent read calls (e.g. from the file watcher).
    pub fn no_log(mut self) -> Self {
        self.log = false;
        self
    }
    /// Guarded: for calls in a folder that is not trusted yet (detecting and checking a
    /// repository when opening it). `core.fsmonitor` is off and `core.hooksPath` points to an
    /// empty folder – whatever the folder's configuration registers there does not run. Only
    /// meant for read calls that execute nothing else (`rev-parse`, `config --list`).
    pub fn guarded(mut self) -> Self {
        self.guarded = true;
        self
    }

    /// The switches that come before our own arguments (without those for silent network calls).
    fn switches(&self) -> Vec<OsString> {
        let mut switches: Vec<OsString> = ["--no-pager", "-c", "core.quotepath=false", "-c", "color.ui=never"].iter().map(OsString::from).collect();
        if self.guarded {
            switches.extend(["-c", "core.fsmonitor=false"].iter().map(OsString::from));
            if let Some(dir) = self.runner.inner.guard_hooks.read().as_ref() {
                let mut hooks_path = OsString::from("core.hooksPath=");
                hooks_path.push(dir);
                switches.push("-c".into());
                switches.push(hooks_path);
            }
        }
        switches
    }

    /// Everything after the program name on Git's command line (for tests: a secret must never
    /// appear there).
    #[cfg(test)]
    pub(crate) fn argv(&self) -> Vec<String> {
        self.switches().iter().chain(self.args.iter()).map(|a| a.to_string_lossy().into_owned()).collect()
    }

    /// Value of an environment variable as the call will see it: our own entry, otherwise the
    /// runner's, otherwise the process's.
    fn env_seen(&self, name: &str) -> Option<OsString> {
        let own = self.env.iter().rev().chain(self.runner.inner.env.iter().rev()).find(|(k, _)| k == name);
        own.map(|(_, v)| v.clone()).or_else(|| std::env::var_os(name))
    }

    /// Command line for log and display: `git <args>`, without credentials.
    pub fn command_line(&self) -> String {
        command_line(&self.args)
    }

    /// Run and collect all of stdout/stderr.
    pub async fn run(self) -> CoreResult<GitOutput> {
        self.execute_patiently().await
    }

    /// Like `run`, but an exit code != 0 is not an error.
    pub async fn run_raw(self) -> CoreResult<GitOutput> {
        self.check(false).execute_patiently().await
    }

    /// Whether this call may be repeated on a short-lived foreign `index.lock`.
    pub(crate) fn retries_on_lock(&self) -> bool {
        if self.read_only || self.network {
            return false;
        }
        let subcommand = subcommand(&self.args);
        LOCK_RETRY_SUBCOMMANDS.contains(&subcommand.as_str())
            || (LOCK_RETRY_ABORTS.contains(&subcommand.as_str()) && self.args.iter().any(|a| a == "--abort"))
    }

    /// Like `execute`, but patient with a foreign `index.lock`: if another program (editor,
    /// terminal) holds the lock only briefly, wait until it is gone and repeat the same call –
    /// for at most `LOCK_RETRY_WINDOW`. If the lock file stays, the `locked` error comes as
    /// before. The lock file is never touched.
    async fn execute_patiently(&self) -> CoreResult<GitOutput> {
        if !self.retries_on_lock() {
            return self.execute(None, None, None).await;
        }
        let deadline = Instant::now() + LOCK_RETRY_WINDOW;
        loop {
            let result = self.execute(None, None, None).await;
            let Some(lock) = foreign_index_lock(&result, &self.cwd) else { return result };
            loop {
                if Instant::now() >= deadline {
                    return result;
                }
                if !lock.exists() {
                    break;
                }
                tokio::time::sleep(LOCK_RETRY_PAUSE).await;
            }
        }
    }

    /// Run; stdout decoded lossily and without the trailing line break.
    pub async fn run_text(self) -> CoreResult<String> {
        Ok(self.run().await?.stdout_text())
    }

    /// For clone, fetch, pull, push: stderr is passed to `on_line` line by line (split at `\r`
    /// and `\n`, without credentials); `cancel` aborts and kills the process including its
    /// child processes. Cancel → `cancelled`, time limit → `timeout`.
    pub async fn run_stream(self, cancel: &CancelToken, on_line: &mut LineFn<'_>) -> CoreResult<GitOutput> {
        self.execute(Some(cancel), Some(on_line), None).await
    }

    /// stdout as a stream of records separated by `sep` (e.g. `0` with `-z`).
    /// `on_record` returns `false` to stop early; Git is then killed and the result counts
    /// as success (`code: None`). `stdout` stays empty in this mode.
    pub async fn run_records(
        self,
        sep: u8,
        cancel: Option<&CancelToken>,
        on_record: &mut RecordFn<'_>,
    ) -> CoreResult<GitOutput> {
        self.execute(cancel, None, Some((sep, on_record))).await
    }

    async fn execute(
        &self,
        cancel: Option<&CancelToken>,
        mut on_line: Option<&mut LineFn<'_>>,
        mut on_record: Option<(u8, &mut RecordFn<'_>)>,
    ) -> CoreResult<GitOutput> {
        let info = self.runner.info()?;
        let display = self.command_line();
        let subcommand = subcommand(&self.args);
        if !self.cwd.is_dir() {
            return Err(CoreError::path_not_found(util::display_path(&self.cwd)));
        }

        let silent = self.network && !self.prompt;
        let session = if self.network {
            let mode = if self.prompt { SessionMode::Interactive } else { SessionMode::Silent };
            Some(self.runner.inner.broker.begin(mode).await)
        } else {
            None
        };
        // Without the helper program there is nobody to quietly say "no" for Git: then every
        // prompt is switched off. With the helper program it answers the questions from the
        // keychain (and rejects the rest) – but for that Git must be allowed to ask.
        let hard_silent = silent && !session.as_ref().is_some_and(|s| s.is_active());
        let mut cmd = tokio::process::Command::new(&info.path);
        cmd.args(self.switches());
        if hard_silent {
            // Credential helpers (e.g. the Git Credential Manager) must not prompt either,
            // and an askpass program set in the configuration does not count.
            cmd.args(["-c", "credential.interactive=false", "-c", "core.askPass="]);
        }
        // The app's network settings (proxy, CA bundle, per-host exceptions) only apply here.
        // Further down they reach Git through the environment – not through the command line,
        // which other processes can read (the proxy password is in it).
        let net = if self.network { self.runner.network_config() } else { NetConfig::default() };
        cmd.args(&self.args)
            .current_dir(&self.cwd)
            .env("LC_ALL", "C")
            .env("LANG", "C")
            .env_remove("LANGUAGE")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_PAGER", "cat")
            .env("PAGER", "cat")
            .env("GIT_EDITOR", ":")
            .env("GIT_SEQUENCE_EDITOR", ":")
            .env("GIT_MERGE_AUTOEDIT", "no")
            .stdin(if self.stdin.is_some() { Stdio::piped() } else { Stdio::null() })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        if self.read_only {
            cmd.env("GIT_OPTIONAL_LOCKS", "0");
        }
        for (k, v) in self.runner.inner.env.iter().chain(self.env.iter()) {
            cmd.env(k, v);
        }
        if !net.settings.is_empty() {
            // After whatever the user sets via GIT_CONFIG_COUNT themselves.
            let already = self.env_seen("GIT_CONFIG_COUNT").and_then(|v| v.to_string_lossy().trim().parse::<usize>().ok()).unwrap_or(0);
            for (k, v) in net.env(already) {
                cmd.env(k, v);
            }
        }
        // Log line when this call forces the default SSH key (only the path).
        let mut ssh_key_note: Option<String> = None;
        if let Some(session) = &session {
            for (k, v) in session.env() {
                cmd.env(k, v);
            }
            let forced = self.forced_ssh_command().await?;
            if forced.is_some() {
                ssh_key_note = self.runner.forced_ssh_key_note(self.repo_id.as_deref());
            }
            if silent {
                cmd.env("GCM_INTERACTIVE", "never");
            }
            if hard_silent {
                // Askpass off, ssh in BatchMode. The key choice stays: the switch comes after
                // the forced command.
                cmd.env("GIT_ASKPASS", "").env("SSH_ASKPASS", "").env("SSH_ASKPASS_REQUIRE", "never");
                cmd.env("GIT_SSH_COMMAND", self.batch_ssh_command(forced).await);
            } else if session.is_active() {
                // The helper program answers questions from the keychain. An OpenSSH before 8.5
                // passes server questions (keyboard-interactive) on without a marker – the server
                // could fake a passphrase or password question that way. There this login
                // method stays off.
                // The common case costs nothing: if the `ssh` on the search path is already new
                // enough, the user's command line isn't even read.
                let legacy = if ssh_is_legacy(&self.runner, "ssh").await {
                    let base = match &forced {
                        Some(command) => command.clone(),
                        None => self.user_ssh_command().await,
                    };
                    ssh_is_legacy(&self.runner, &base).await.then_some(base)
                } else {
                    None
                };
                if let Some(base) = legacy {
                    cmd.env("GIT_SSH_COMMAND", format!("{base} {SSH_NO_SERVER_PROMPTS}"));
                } else if let Some(ssh) = forced {
                    cmd.env("GIT_SSH_COMMAND", ssh);
                }
            } else if let Some(ssh) = forced {
                cmd.env("GIT_SSH_COMMAND", ssh);
            }
        }
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        #[cfg(unix)]
        cmd.process_group(0);

        let started_at = util::now_iso();
        let start = Instant::now();
        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(CoreError::git_missing()),
            Err(e) => {
                // Usually caused by the working directory (path too long, no access), not by Git.
                let (code, reason) = crate::error::describe_io(&e);
                return Err(CoreError::new(code, format!("Git couldn’t be started in this folder. {reason}")).with_git_output(e.to_string()));
            }
        };

        let tree = ProcessTree::attach(&child);
        let records_mode = on_record.is_some();
        let stdin_pipe = child.stdin.take();
        let stdin_data = self.stdin.clone();
        let stdout_pipe = child.stdout.take();
        let stderr_pipe = child.stderr.take();
        let last_activity = AtomicU64::new(0);
        let stop = Notify::new();
        let elapsed_ms = |start: Instant| start.elapsed().as_millis() as u64;
        // The buffers live outside the read futures so their contents are kept when reading
        // is aborted (see PIPE_GRACE).
        let mut out_buf: Vec<u8> = Vec::new();
        let mut err_buf: Vec<u8> = Vec::new();
        let stopped_early = AtomicBool::new(false);

        let stdin_fut = async {
            if let (Some(mut pipe), Some(data)) = (stdin_pipe, stdin_data) {
                // Write errors (Git closed stdin early) show up in the exit code.
                let _ = pipe.write_all(&data).await;
                let _ = pipe.shutdown().await;
            }
        };

        let stdout_fut = async {
            let collected = &mut out_buf;
            let mut stopped = false;
            if let Some(mut out) = stdout_pipe {
                let mut chunk = vec![0u8; 64 * 1024];
                let mut buf: Vec<u8> = Vec::new();
                loop {
                    let n = match out.read(&mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    last_activity.store(elapsed_ms(start), Ordering::Relaxed);
                    match on_record.as_mut() {
                        Some((sep, f)) => {
                            buf.extend_from_slice(&chunk[..n]);
                            let mut pos = 0;
                            while let Some(rel) = buf[pos..].iter().position(|b| b == sep) {
                                let end = pos + rel;
                                if !f(&buf[pos..end]) {
                                    stopped = true;
                                    break;
                                }
                                pos = end + 1;
                            }
                            buf.drain(..pos);
                            if stopped {
                                stopped_early.store(true, Ordering::SeqCst);
                                stop.notify_one();
                                break;
                            }
                        }
                        None => collected.extend_from_slice(&chunk[..n]),
                    }
                    // After processing too: "quiet" only counts the time actually spent waiting.
                    last_activity.store(elapsed_ms(start), Ordering::Relaxed);
                }
                if !stopped && !buf.is_empty() {
                    if let Some((_, f)) = on_record.as_mut() {
                        f(&buf);
                    }
                }
            }
        };

        let stderr_fut = async {
            let all = &mut err_buf;
            if let Some(mut err) = stderr_pipe {
                let mut chunk = vec![0u8; 16 * 1024];
                let mut line: Vec<u8> = Vec::new();
                loop {
                    let n = match err.read(&mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    last_activity.store(elapsed_ms(start), Ordering::Relaxed);
                    if all.len() < MAX_STDERR {
                        all.extend_from_slice(&chunk[..n]);
                    }
                    if let Some(f) = on_line.as_mut() {
                        for &b in &chunk[..n] {
                            if b == b'\r' || b == b'\n' {
                                if !line.is_empty() {
                                    f(&redact::redact_bytes(&line));
                                    line.clear();
                                }
                            } else {
                                line.push(b);
                            }
                        }
                    }
                    last_activity.store(elapsed_ms(start), Ordering::Relaxed);
                }
                if let Some(f) = on_line.as_mut() {
                    if !line.is_empty() {
                        f(&redact::redact_bytes(&line));
                    }
                }
            }
        };

        enum End {
            Done,
            Cancelled,
            TimedOut,
        }

        let mut io = Box::pin(async move {
            tokio::join!(stdin_fut, stdout_fut, stderr_fut);
        });
        let deadline = self.timeout.map(|d| tokio::time::Instant::now() + d);
        let mut killed = false;
        let mut exit_status: Option<std::process::ExitStatus> = None;
        let mut exited = false;
        let end = loop {
            tokio::select! {
                _ = &mut io => break End::Done,
                status = child.wait(), if !exited => {
                    exited = true;
                    exit_status = status.ok();
                    last_activity.store(elapsed_ms(start), Ordering::Relaxed);
                }
                _ = wait_cancel(cancel) => break End::Cancelled,
                _ = sleep_until_opt(deadline) => break End::TimedOut,
                _ = tokio::time::sleep(TICK) => {
                    if session.as_ref().is_some_and(|s| s.is_waiting()) {
                        // Git is waiting for the user's answer: that is not a hang.
                        last_activity.store(elapsed_ms(start), Ordering::Relaxed);
                    }
                    let quiet =elapsed_ms(start).saturating_sub(last_activity.load(Ordering::Relaxed));
                    if exited {
                        // Git is done, but a background process (gc, credential cache, hook with "&")
                        // keeps the pipes open: don't wait forever for end of file.
                        if quiet >= PIPE_GRACE.as_millis() as u64 {
                            break End::Done;
                        }
                    } else if let Some(idle) = self.idle_timeout {
                        if quiet >= idle.as_millis() as u64 {
                            break End::TimedOut;
                        }
                    }
                }
                _ = stop.notified(), if !killed => {
                    // Record mode has enough: kill Git, discard the rest of the output.
                    killed = true;
                    kill_tree(&mut child, tree.as_ref()).await;
                }
            }
        };
        // Releases the borrows of the buffers and callbacks.
        drop(io);
        let stopped = stopped_early.load(Ordering::SeqCst);

        let (result, code) = match end {
            End::Done => {
                if !exited {
                    exit_status = child.wait().await.ok();
                }
                let code = if stopped { None } else { exit_status.and_then(|s| s.code()) };
                (Ok(stopped), code)
            }
            End::Cancelled => {
                kill_tree(&mut child, tree.as_ref()).await;
                let _ = child.wait().await;
                (Err(CoreError::cancelled()), None)
            }
            End::TimedOut => {
                kill_tree(&mut child, tree.as_ref()).await;
                let _ = child.wait().await;
                (Err(CoreError::timeout()), None)
            }
        };
        let (stdout, stderr) = (out_buf, err_buf);
        let duration = start.elapsed();

        let failure = match &result {
            Err(e) => Some(e.clone()),
            Ok(stopped) if !*stopped && code != Some(0) => {
                let mut error = errors::classify(&subcommand, code, &stdout, &stderr);
                // Git's output may repeat a secret of the app (proxy URL with password).
                error.git_output = error.git_output.map(|text| self.runner.scrub_known(&text));
                Some(error)
            }
            Ok(_) => None,
        };
        // Save remembered answers or delete rejected entries; the user cancelling the prompt
        // replaces Git's error.
        let replaced = match session {
            Some(session) => session.finish(failure.as_ref()).await,
            None => None,
        };

        if self.log {
            let mut log_text = redact::redact_bytes(&stderr);
            if !records_mode && !stdout.is_empty() {
                if !log_text.trim().is_empty() {
                    log_text.push('\n');
                }
                log_text.push_str(&redact::redact_bytes(&stdout[..stdout.len().min(MAX_LOG_OUTPUT)]));
            }
            if let Err(e) = &result {
                if log_text.trim().is_empty() {
                    log_text = e.message.clone();
                }
            }
            let mut log_text = self.runner.scrub_known(&util::truncate_str(log_text.trim_end(), MAX_LOG_OUTPUT));
            for note in net.notes.iter().chain(ssh_key_note.iter()) {
                if !log_text.is_empty() {
                    log_text.push('\n');
                }
                log_text.push_str(note);
            }
            let entry = db::activity::NewActivity {
                repo_id: self.repo_id.clone(),
                description: format!("git {subcommand}"),
                command: display.clone(),
                exit_code: code,
                duration_ms: duration.as_millis() as u64,
                output: log_text,
                started_at,
                code: replaced.as_ref().or(failure.as_ref()).map(|e| e.code),
            };
            match self.runner.inner.db.with(|c| db::activity::insert(c, &entry)) {
                Ok(saved) => {
                    if let Ok(payload) = serde_json::to_value(&saved) {
                        self.runner.inner.events.emit(names::LOG_APPENDED, payload);
                    }
                }
                Err(e) => log::warn!("Log entry not saved: {e}"),
            }
        }

        if let Some(replaced) = replaced {
            return Err(replaced);
        }
        let stopped = result?;
        let output = GitOutput { code, stdout, stderr, duration };
        if self.check && !stopped {
            if let Some(error) = failure {
                return Err(error);
            }
        }
        Ok(output)
    }

    /// This Git call's SSH invocation with the switch that forbids prompts: the forced
    /// command (`forced`), otherwise the user's (`GIT_SSH_COMMAND`, `core.sshCommand`,
    /// `GIT_SSH`), otherwise `ssh`.
    async fn batch_ssh_command(&self, forced: Option<String>) -> String {
        if let Some(command) = forced {
            return compose_ssh_command(Some(&command), None, None);
        }
        let from_env = |name: &str| self.env_seen(name).map(|v| v.to_string_lossy().into_owned()).filter(|v| !v.trim().is_empty());
        let configured = config_value(&self.runner, &self.cwd, "core.sshCommand").await;
        compose_ssh_command(from_env("GIT_SSH_COMMAND").as_deref(), configured.as_deref(), from_env("GIT_SSH").as_deref())
    }

    /// The SSH invocation Git would use without our involvement, as a command line:
    /// `GIT_SSH_COMMAND`, otherwise `core.sshCommand`, otherwise `GIT_SSH` (quoted), otherwise `ssh`.
    async fn user_ssh_command(&self) -> String {
        let from_env = |name: &str| self.env_seen(name).map(|v| v.to_string_lossy().into_owned()).filter(|v| !v.trim().is_empty());
        if let Some(command) = from_env("GIT_SSH_COMMAND") {
            return command.trim().to_string();
        }
        if let Some(command) = config_value(&self.runner, &self.cwd, "core.sshCommand").await {
            return command.trim().to_string();
        }
        match from_env("GIT_SSH") {
            Some(program) => broker::shell_quote(program.trim()),
            None => "ssh".to_string(),
        }
    }


    /// `GIT_SSH_COMMAND` that forces the project's key or the default key – or `None` when the
    /// SSH agent or the user's configuration should decide. Builds on what the user has set
    /// themselves (`GIT_SSH_COMMAND`, `core.sshCommand`).
    /// Error: the project key's file is missing (`path_not_found`).
    async fn forced_ssh_command(&self) -> CoreResult<Option<String>> {
        let Some(key) = self.runner.inner.broker.forced_ssh_key(self.repo_id.as_deref())? else {
            return Ok(None);
        };
        let from_env = |name: &str| self.env_seen(name).filter(|v| !v.is_empty());
        let base = match from_env("GIT_SSH_COMMAND") {
            Some(command) => command.to_string_lossy().into_owned(),
            None => match config_value(&self.runner, &self.cwd, "core.sshCommand").await {
                Some(command) => command,
                // A custom SSH program (e.g. plink) does not understand our options.
                None if from_env("GIT_SSH").is_some() => return Ok(None),
                None => "ssh".to_string(),
            },
        };
        Ok(Some(broker::ssh_command_with_key(&base, &key)))
    }
}

/// First OpenSSH version that marks server questions with `(user@host) `.
const SSH_MARKS_SERVER_PROMPTS: (u32, u32) = (8, 5);
/// Switches off login via server questions for an older OpenSSH.
const SSH_NO_SERVER_PROMPTS: &str = "-o KbdInteractiveAuthentication=no";

/// Whether the SSH program of this command line is an OpenSSH before 8.5. From 8.5 on, OpenSSH
/// prefixes every server question with `(user@host) `; older ones pass the server's text
/// unchanged to the askpass program. The result is determined once per program
/// (`<program> -V`, started through a Git alias so that the same program answers that Git
/// finds – on Windows the bundled one). If the version can't be read (another program, e.g.
/// plink, or no ssh at all): `false`.
///
/// As a boxed future because the call uses `execute` again from within `execute`.
fn ssh_is_legacy(runner: &GitRunner, command: &str) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>> {
    let program = ssh_program(command);
    let known = runner.inner.legacy_ssh.lock().get(&program).copied();
    if program.is_empty() || known.is_some() {
        return Box::pin(std::future::ready(known.unwrap_or(false)));
    }
    // Outside any repository (in the data directory) and guarded: the alias exists only on
    // the command line of this one call.
    let cwd = runner.inner.guard_hooks.read().as_ref().and_then(|dir| dir.parent().map(Path::to_path_buf)).unwrap_or_else(std::env::temp_dir);
    let probe = runner
        .cmd(&cwd)
        .arg("-c")
        .arg(format!("alias.forkyard-ssh-version=!{program} -V"))
        .arg("forkyard-ssh-version")
        .no_log()
        .guarded()
        .timeout(Duration::from_secs(10));
    let runner = runner.clone();
    Box::pin(async move {
        let legacy = match probe.run_raw().await {
            Ok(out) => {
                let text = format!("{}\n{}", util::decode_lossy(&out.stderr), util::decode_lossy(&out.stdout));
                openssh_version(&text).is_some_and(|version| version < SSH_MARKS_SERVER_PROMPTS)
            }
            Err(_) => false,
        };
        runner.inner.legacy_ssh.lock().insert(program, legacy);
        legacy
    })
}

/// The program of an SSH command line (first word, with its quotes).
fn ssh_program(command: &str) -> String {
    let command = command.trim();
    let end = match command.chars().next() {
        Some(quote @ ('\'' | '"')) => command[1..].find(quote).map(|at| at + 2),
        _ => command.find(char::is_whitespace),
    };
    command[..end.unwrap_or(command.len())].to_string()
}

/// Reads "OpenSSH_9.5p1" or "OpenSSH_for_Windows_9.5p1" from the output of `ssh -V`.
fn openssh_version(text: &str) -> Option<(u32, u32)> {
    let start = text.find("OpenSSH_")? + "OpenSSH_".len();
    let rest = &text[start..];
    let digits = rest.find(|c: char| c.is_ascii_digit())?;
    // Between "OpenSSH_" and the number there are only letters and underscores.
    if !rest[..digits].chars().all(|c| c.is_ascii_alphabetic() || c == '_') {
        return None;
    }
    let mut numbers = rest[digits..].split(|c: char| !c.is_ascii_digit());
    let major = numbers.next()?.parse().ok()?;
    let minor = numbers.next()?.parse().ok()?;
    Some((major, minor))
}

/// SSH invocation with the switch that forbids prompts. Precedence as in Git:
/// `GIT_SSH_COMMAND`, then `core.sshCommand` (both complete command lines), then `GIT_SSH`
/// (a program path; put in single quotes for the shell), otherwise `ssh`.
pub fn compose_ssh_command(env_command: Option<&str>, config_command: Option<&str>, env_program: Option<&str>) -> String {
    let (base, program) = match (env_command, config_command, env_program) {
        (Some(command), _, _) | (None, Some(command), _) => {
            let command = command.trim();
            (command.to_string(), command.split_whitespace().next().unwrap_or(command).to_string())
        }
        (None, None, Some(program)) => {
            let program = program.trim();
            (format!("'{}'", program.replace('\'', r"'\''")), program.to_string())
        }
        (None, None, None) => ("ssh".to_string(), "ssh".to_string()),
    };
    let name = program.trim_matches(['"', '\'']).rsplit(['/', '\\']).next().unwrap_or("").to_lowercase();
    // PuTTY (plink, TortoisePlink) doesn't know "-o", but "-batch".
    let flag = if name.contains("plink") { "-batch" } else { "-o BatchMode=yes" };
    format!("{base} {flag}")
}

/// The lock file a call failed on – only if it is the index lock
/// ("Unable to create '…/index.lock': File exists").
fn foreign_index_lock(result: &CoreResult<GitOutput>, cwd: &Path) -> Option<PathBuf> {
    let text = match result {
        Err(e) if e.is(crate::error::ErrorCode::Locked) => e.git_output.clone()?,
        Ok(out) if !out.success() => util::decode_lossy(&out.stderr),
        _ => return None,
    };
    index_lock_path(&text, cwd)
}

fn index_lock_path(text: &str, cwd: &Path) -> Option<PathBuf> {
    const NAME: &str = "index.lock";
    let end = text.find("index.lock': File exists")? + NAME.len();
    let start = text[..end].rfind('\'')? + 1;
    let path = PathBuf::from(&text[start..end]);
    Some(if path.is_absolute() { path } else { cwd.join(path) })
}

/// Value from the folder's Git configuration, `None` if not set. As a boxed future because
/// the call uses `execute` again from within `execute`.
fn config_value(
    runner: &GitRunner,
    cwd: &Path,
    key: &str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Option<String>> + Send>> {
    // Guarded: the call only reads, but must not trigger anything in a foreign folder either.
    let cmd = runner.cmd(cwd).args(["config", "--get", key]).read_only().no_log().guarded();
    Box::pin(async move {
        match cmd.run_raw().await {
            Ok(out) if out.success() => Some(out.stdout_text()).filter(|v| !v.is_empty()),
            _ => None,
        }
    })
}

async fn wait_cancel(cancel: Option<&CancelToken>) {
    match cancel {
        Some(token) => token.cancelled().await,
        None => std::future::pending().await,
    }
}

async fn sleep_until_opt(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(d) => tokio::time::sleep_until(d).await,
        None => std::future::pending().await,
    }
}

/// Windows: a job object around Git and all its child processes so that a cancel ends the
/// whole tree at once (taskkill needs seconds for that under load).
#[cfg(windows)]
pub(crate) struct ProcessTree(windows_sys::Win32::Foundation::HANDLE);

// SAFETY: The handle is owned by this value alone; job objects may be used from any thread.
#[cfg(windows)]
unsafe impl Send for ProcessTree {}
#[cfg(windows)]
unsafe impl Sync for ProcessTree {}

#[cfg(windows)]
impl ProcessTree {
    /// Puts the just-started process into a new job object; `None` if Windows refuses.
    pub(crate) fn attach(child: &tokio::process::Child) -> Option<ProcessTree> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW};
        let process = child.raw_handle()?;
        // SAFETY: valid arguments (no name, no security attributes); the process handle lives
        // as long as `child`. No KILL_ON_JOB_CLOSE: Git's background services (credential
        // cache, maintenance) should survive a normal exit.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            if AssignProcessToJobObject(job, process as _) == 0 {
                CloseHandle(job);
                return None;
            }
            Some(ProcessTree(job))
        }
    }

    fn terminate(&self) {
        // SAFETY: `self.0` is an open job handle.
        unsafe {
            windows_sys::Win32::System::JobObjects::TerminateJobObject(self.0, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for ProcessTree {
    fn drop(&mut self) {
        // SAFETY: `self.0` is an open handle and is closed only here.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

/// Unix needs no object of its own: there `kill_tree` kills the process group.
#[cfg(not(windows))]
#[allow(dead_code)]
pub(crate) struct ProcessTree;

#[cfg(not(windows))]
impl ProcessTree {
    pub(crate) fn attach(_child: &tokio::process::Child) -> Option<ProcessTree> {
        None
    }
}

/// Kills Git including its child processes (git-remote-https, ssh, hooks).
pub(crate) async fn kill_tree(child: &mut tokio::process::Child, tree: Option<&ProcessTree>) {
    #[cfg(windows)]
    if let Some(tree) = tree {
        tree.terminate();
        let _ = child.start_kill();
        return;
    }
    #[cfg(not(windows))]
    let _ = tree;
    if let Some(pid) = child.id() {
        #[cfg(windows)]
        {
            // Fallback in case the job object couldn't be created.
            let mut kill = tokio::process::Command::new("taskkill");
            kill.args(["/T", "/F", "/PID", &pid.to_string()])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .creation_flags(CREATE_NO_WINDOW);
            let _ = kill.status().await;
        }
        #[cfg(unix)]
        {
            // Git runs in its own process group (process_group(0)); kill the whole group.
            if let Ok(pgid) = i32::try_from(pid) {
                // SAFETY: kill(2) with a negative PID addresses only this child's process group.
                unsafe {
                    libc::kill(-pgid, libc::SIGKILL);
                }
            }
        }
    }
    let _ = child.start_kill();
}

/// First argument that is not a switch (`fetch` in `git -c x=y fetch --all`).
fn subcommand(args: &[OsString]) -> String {
    let mut skip_next = false;
    for a in args {
        let s = a.to_string_lossy();
        if skip_next {
            skip_next = false;
            continue;
        }
        if s == "-c" || s == "-C" {
            skip_next = true;
            continue;
        }
        if !s.starts_with('-') {
            return s.into_owned();
        }
    }
    String::new()
}

/// `git <args>` with quotes around arguments containing spaces, without credentials.
pub fn command_line(args: &[OsString]) -> String {
    let mut line = String::from("git");
    for a in args {
        let s = a.to_string_lossy();
        line.push(' ');
        if s.is_empty() || s.chars().any(|c| c.is_whitespace() || c == '"') {
            line.push('"');
            line.push_str(&s.replace('"', "\\\""));
            line.push('"');
        } else {
            line.push_str(&s);
        }
    }
    util::truncate_str(&redact::redact(&line), 2000)
}

/// Splits a Git progress line: "Receiving objects:  45% (450/1000)" → ("Receiving objects", Some(45)).
pub fn parse_progress(line: &str) -> Option<(String, Option<u32>)> {
    let line = line.trim().trim_start_matches("remote:").trim();
    let colon = line.find(':')?;
    let phase = line[..colon].trim();
    if phase.is_empty() || phase.len() > 60 {
        return None;
    }
    let rest = &line[colon + 1..];
    let percent = rest.split_whitespace().find_map(|t| t.strip_suffix('%')).and_then(|p| p.parse::<u32>().ok());
    Some((phase.to_string(), percent.map(|p| p.min(100))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_lines() {
        assert_eq!(
            parse_progress("Receiving objects:  45% (450/1000), 1.2 MiB | 1.0 MiB/s"),
            Some(("Receiving objects".into(), Some(45)))
        );
        assert_eq!(parse_progress("remote: Counting objects: 100% (5/5), done."), Some(("Counting objects".into(), Some(100))));
        assert_eq!(parse_progress("Cloning into 'x'..."), None);
    }

    /// Only an OpenSSH from 8.5 on marks server questions.
    #[test]
    fn openssh_versions_and_programs_are_read() {
        assert_eq!(openssh_version("OpenSSH_9.5p1, LibreSSL 3.8.2"), Some((9, 5)));
        assert_eq!(openssh_version("OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2"), Some((9, 5)));
        assert_eq!(openssh_version("OpenSSH_8.2p1 Ubuntu-4ubuntu0.11, OpenSSL 1.1.1f  31 Mar 2020"), Some((8, 2)));
        assert_eq!(openssh_version("OpenSSH_10.0p2, OpenSSL 3.5.0"), Some((10, 0)));
        assert!(openssh_version("OpenSSH_8.2p1").is_some_and(|v| v < SSH_MARKS_SERVER_PROMPTS));
        assert!(openssh_version("OpenSSH_8.5p1").is_some_and(|v| v >= SSH_MARKS_SERVER_PROMPTS));
        assert_eq!(openssh_version("plink: Release 0.78"), None);
        assert_eq!(openssh_version(""), None);
        assert_eq!(openssh_version("OpenSSH_ 9.5"), None);
        assert_eq!(ssh_program("ssh"), "ssh");
        assert_eq!(ssh_program("  ssh -i '/k/id' -o IdentitiesOnly=yes"), "ssh");
        assert_eq!(ssh_program("'C:/Program Files/OpenSSH/ssh.exe' -v"), "'C:/Program Files/OpenSSH/ssh.exe'");
        assert_eq!(ssh_program("\"C:/Program Files/x/ssh.exe\""), "\"C:/Program Files/x/ssh.exe\"");
        assert_eq!(ssh_program(""), "");
    }

    #[test]
    fn lock_paths_are_read_from_the_message() {
        let cwd = Path::new("/arbeit");
        // What counts as absolute differs per platform: "C:/…" is relative on Unix.
        let absolute = if cfg!(windows) { "C:/r/mit leer/.git/index.lock" } else { "/r/mit leer/.git/index.lock" };
        let text = format!("fatal: Unable to create '{absolute}': File exists.\n\nAnother git process seems to be running");
        assert_eq!(index_lock_path(&text, cwd), Some(PathBuf::from(absolute)));
        assert_eq!(index_lock_path("fatal: Unable to create '.git/index.lock': File exists.", cwd), Some(cwd.join(".git/index.lock")));
        // Other locks (refs, custom index files) don't count.
        assert_eq!(index_lock_path("fatal: Unable to create 'C:/r/.git/refs/heads/x.lock': File exists.", cwd), None);
        assert_eq!(index_lock_path("fatal: Unable to create 'C:/t/index-1234.lock': File exists.", cwd), None);
        assert_eq!(index_lock_path("etwas anderes", cwd), None);
    }

    #[test]
    fn command_lines() {
        let args: Vec<OsString> = ["fetch", "https://u:p@h/r", "a b"].iter().map(OsString::from).collect();
        assert_eq!(command_line(&args), "git fetch https://***@h/r \"a b\"");
        let args: Vec<OsString> = ["-c", "x=y", "commit", "-m", "x"].iter().map(OsString::from).collect();
        assert_eq!(subcommand(&args), "commit");
    }
}
