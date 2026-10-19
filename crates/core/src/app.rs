//! The core state: database, Git runner, event sink, jobs, write locks.
//!
//! `Core` is cheap to clone (everything is behind an `Arc`); background tasks
//! (file watching, auto-fetch) simply get a clone.

use std::any::{Any, TypeId};
use std::collections::HashMap;
use std::ffi::OsString;
use std::future::Future;
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::Serialize;

use crate::db::{self, Db};
use crate::error::{CoreError, CoreResult};
use crate::events::{names, EventSink};
use crate::git::{locate, GitCmd, GitRunner};
use crate::jobs::{Job, JobRegistry};
use crate::model::{AppChange, AppChangedEvent, RepoChange, RepoChangedEvent, Settings};
use crate::util;

/// Name of the database file in the data directory.
pub const DB_FILE: &str = "forkyard.db";
/// Name of the database file before the rename to Forkyard.
const LEGACY_DB_FILE: &str = "gitclient.db";
/// Always-empty folder in the data directory; target of `core.hooksPath` for guarded calls.
pub const GUARD_HOOKS_DIR: &str = "no-hooks";
/// Renames a database from before Forkyard, as long as there is no new one yet.
fn adopt_legacy_db(data_dir: &std::path::Path) {
    if data_dir.join(DB_FILE).exists() || !data_dir.join(LEGACY_DB_FILE).exists() {
        return;
    }
    for suffix in ["", "-wal", "-shm"] {
        let old = data_dir.join(format!("{LEGACY_DB_FILE}{suffix}"));
        if old.exists() {
            if let Err(e) = std::fs::rename(&old, data_dir.join(format!("{DB_FILE}{suffix}"))) {
                log::warn!("Old database not adopted: {e}");
            }
        }
    }
}

/// How long an operation ID (op_id) counts as “already seen”.
const OP_ID_TTL: Duration = Duration::from_secs(10 * 60);
/// Cleanup at startup.
const ACTIVITY_MAX_DAYS: i64 = 30;
const ACTIVITY_MAX_PER_REPO: u32 = 10_000;
const UNDO_MAX_DAYS: i64 = 14;
/// From this age on, temporary folders (hook wrappers) count as left over at startup.
const STALE_TEMP_AGE: Duration = Duration::from_secs(10 * 60);

/// Settings for creating the core.
pub struct CoreConfig {
    /// App data directory (database etc.); created if missing.
    pub data_dir: PathBuf,
    /// App version for `app_info`.
    pub app_version: String,
    pub events: Arc<dyn EventSink>,
    /// Extra environment for every Git call (tests: `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM`).
    pub git_env: Vec<(OsString, OsString)>,
    /// Fixed path to Git; `None` = search automatically.
    pub git_path: Option<PathBuf>,
    /// Tests only: secrets in memory instead of the OS keychain.
    pub memory_secrets: Option<Arc<crate::secrets::MemorySecrets>>,
    /// Service name in the keychain; `None` = `forkyard`.
    pub keyring_service: Option<String>,
}

impl CoreConfig {
    pub fn new(data_dir: impl Into<PathBuf>, app_version: impl Into<String>, events: Arc<dyn EventSink>) -> Self {
        CoreConfig { data_dir: data_dir.into(), app_version: app_version.into(), events, git_env: Vec::new(), git_path: None, memory_secrets: None, keyring_service: None }
    }
}

#[derive(Clone)]
pub struct Core {
    inner: Arc<CoreInner>,
}

pub struct CoreInner {
    pub data_dir: PathBuf,
    pub app_version: String,
    pub db: Db,
    pub git: GitRunner,
    /// The Git that was found, even if it is too old and `git` therefore rejects every call.
    /// Read via `Core::git_found()`; `Core::recheck_git` searches again.
    git_found: parking_lot::RwLock<Option<locate::GitInfo>>,
    /// Fixed path to Git from `CoreConfig::git_path` (for searching again).
    git_path: Option<PathBuf>,
    pub events: Arc<dyn EventSink>,
    pub jobs: Arc<JobRegistry>,
    locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    ops: Mutex<HashMap<String, Instant>>,
    keyring: OnceLock<bool>,
    memory_secrets: Option<Arc<crate::secrets::MemorySecrets>>,
    states: Mutex<HashMap<TypeId, Arc<dyn Any + Send + Sync>>>,
}

impl Deref for Core {
    type Target = CoreInner;
    fn deref(&self) -> &CoreInner {
        &self.inner
    }
}

/// Holds a repository's write lock until it is dropped.
pub type WriteGuard = tokio::sync::OwnedMutexGuard<()>;

impl Core {
    /// Opens the database and Git, creates the default profile on first start and
    /// ensures a valid tab state. Cleanup runs separately via `startup_cleanup`.
    pub async fn open(config: CoreConfig) -> CoreResult<Core> {
        // The data directory (database with log and accounts, temp files) belongs to the current
        // user only – explicitly on Unix, even if it is still more open from earlier.
        util::create_private_dir(&config.data_dir)?;
        if let Err(e) = util::restrict_to_owner(&config.data_dir) {
            log::warn!("Permissions of the data directory not restricted: {e}");
        }
        let db_path = config.data_dir.join(DB_FILE);
        adopt_legacy_db(&config.data_dir);
        // SQLite creates -wal and -shm with the permissions of the database file – already when
        // opening (WAL mode). The file therefore has to be private BEFORE opening.
        if let Err(e) = util::create_private_file(&db_path).and_then(|()| util::restrict_to_owner(&db_path)) {
            log::warn!("Permissions of the database not restricted: {e}");
        }
        let db = crate::startup::timed("database open and migrations", || Db::open(&db_path))?;
        // Created more openly by an earlier version: tighten them.
        for extra in ["-wal", "-shm"] {
            let mut name = db_path.clone().into_os_string();
            name.push(extra);
            let path = PathBuf::from(name);
            if path.exists() {
                if let Err(e) = util::restrict_to_owner(&path) {
                    log::warn!("Permissions of {} not restricted: {e}", path.display());
                }
            }
        }
        let (git_found, git_info) = crate::startup::timed("finding Git", || Self::find_git(config.git_path.as_deref()));
        let git = GitRunner::new(git_info, config.git_env, db.clone(), config.events.clone());
        // Empty folder for guarded calls (`GitCmd::guarded`): `core.hooksPath` points there as long
        // as a folder is not trusted yet.
        let guard_hooks = config.data_dir.join(GUARD_HOOKS_DIR);
        match util::create_private_dir(&guard_hooks) {
            Ok(()) => git.set_guard_hooks_dir(guard_hooks),
            Err(e) => log::warn!("Guard folder for hooks not created: {e}"),
        }
        let core = Core {
            inner: Arc::new(CoreInner {
                data_dir: config.data_dir,
                app_version: config.app_version,
                db,
                git,
                git_found: parking_lot::RwLock::new(git_found),
                git_path: config.git_path,
                events: config.events,
                jobs: Arc::new(JobRegistry::new()),
                locks: Mutex::new(HashMap::new()),
                ops: Mutex::new(HashMap::new()),
                keyring: OnceLock::new(),
                memory_secrets: config.memory_secrets,
                states: Mutex::new(HashMap::new()),
            }),
        };
        if let Some(service) = config.keyring_service.filter(|name| !name.trim().is_empty()) {
            crate::commands::auth::configure(&core, |auth| auth.keyring_service = Some(service));
        }
        crate::startup::timed_async("profile", core.ensure_profile()).await?;
        crate::startup::timed("tabs", || core.ensure_tabs_on_start())?;
        // Proxy passwords belong in the keychain: move old plain-text values, then load.
        crate::startup::timed_async("proxy passwords", async {
            crate::commands::settings::migrate_proxy_passwords(&core).await;
            crate::commands::settings::load_proxy_passwords(&core).await;
        })
        .await;
        crate::startup::timed_async("removed AI keys", crate::commands::settings::forget_removed_ai_keys(&core)).await;
        Ok(core)
    }

    /// Searches for Git (or checks the fixed path): (found, even if too old; usable).
    fn find_git(fixed: Option<&Path>) -> (Option<locate::GitInfo>, CoreResult<locate::GitInfo>) {
        let found = match fixed {
            Some(path) => locate::probe_any(path),
            None => locate::detect_any(),
        };
        let git_found = found.as_ref().ok().cloned();
        let git_info = found.and_then(locate::require_min_version);
        if let Err(e) = &git_info {
            log::warn!("Git not usable: {}", e.message);
        }
        (git_found, git_info)
    }

    /// The Git that was found, even if it is too old; `None` if none was found.
    pub fn git_found(&self) -> Option<locate::GitInfo> {
        self.git_found.read().clone()
    }

    /// Searches for Git again (e.g. after an installation) without restarting the app. Applies to
    /// all following Git calls.
    pub async fn recheck_git(&self) -> Option<locate::GitInfo> {
        let fixed = self.git_path.clone();
        let found = tokio::task::spawn_blocking(move || Self::find_git(fixed.as_deref())).await;
        let (git_found, git_info) = match found {
            Ok(found) => found,
            Err(e) => (None, Err(CoreError::unknown(format!("The search for Git was aborted: {e}")))),
        };
        *self.git_found.write() = git_found.clone();
        self.git.set_git(git_info);
        git_found
    }

    async fn ensure_profile(&self) -> CoreResult<()> {
        if self.db.with(db::profiles::count)? == 0 {
            let name = self.global_git_config("user.name").await;
            let email = self.global_git_config("user.email").await;
            self.db.tx(|tx| {
                let id = db::profiles::insert(tx, "Default", &name, &email, false)?;
                db::profiles::set_active(tx, &id)
            })?;
        }
        self.db.tx(|tx| {
            if db::profiles::active(tx).is_err() {
                if let Some(first) = db::profiles::list(tx)?.first() {
                    db::profiles::set_active(tx, &first.id)?;
                }
            }
            Ok(())
        })
    }

    fn ensure_tabs_on_start(&self) -> CoreResult<()> {
        let settings = self.settings()?;
        self.db.tx(|tx| {
            let profile_id = db::profiles::active_id(tx)?;
            if !settings.remember_tabs {
                db::tabs::delete_all(tx, &profile_id)?;
            }
            db::tabs::ensure_consistent(tx, &profile_id)
        })
    }

    /// Value from the global gitconfig; empty if not set or Git is missing.
    pub async fn global_git_config(&self, key: &str) -> String {
        let cwd = self.data_dir.clone();
        match self.git.cmd(&cwd).args(["config", "--global", "--get", key]).read_only().run_raw().await {
            Ok(out) if out.success() => out.stdout_text(),
            _ => String::new(),
        }
    }

    /// Cleanup at startup: log (older than 30 days, more than 10,000 per repo) and undo
    /// entries older than 14 days together with their backup refs.
    pub async fn startup_cleanup(&self) -> CoreResult<()> {
        let removed = crate::commands::commit::cleanup_hook_dirs(self.data_dir(), STALE_TEMP_AGE);
        if removed > 0 {
            log::info!("cleaned up {removed} left-over hook folders");
        }
        let before = util::iso_days_ago(ACTIVITY_MAX_DAYS);
        self.db.with(|c| db::activity::cleanup(c, &before, ACTIVITY_MAX_PER_REPO))?;
        if let Err(e) = crate::commands::agents::reconcile_on_start(self) {
            log::warn!("agent sessions of the last run not recorded as ended: {}", e.message);
        }
        crate::undo::cleanup_older_than(self, UNDO_MAX_DAYS).await
    }

    pub fn data_dir(&self) -> &Path {
        &self.inner.data_dir
    }

    /// The tests' substitute keychain, if one is set (see `secrets`).
    pub fn memory_secrets(&self) -> Option<&Arc<crate::secrets::MemorySecrets>> {
        self.inner.memory_secrets.as_ref()
    }

    // --- Events -----------------------------------------------------------

    /// Sends an event; `payload` becomes JSON.
    pub fn emit<T: Serialize>(&self, event: &str, payload: &T) {
        match serde_json::to_value(payload) {
            Ok(v) => self.events.emit(event, v),
            Err(e) => log::warn!("Event {event} not serializable: {e}"),
        }
    }

    /// `repo:changed` with the affected areas (duplicates are removed).
    pub fn emit_repo_changed(&self, repo_id: &str, what: &[RepoChange]) {
        let mut what = what.to_vec();
        what.sort();
        what.dedup();
        // Coding agents: a change in an agent's worktree (or of the base's refs) schedules the collision check.
        crate::commands::agents::collision::note_change(self, repo_id, &what);
        self.emit(names::REPO_CHANGED, &RepoChangedEvent { repo_id: repo_id.to_string(), what });
    }

    /// `app:changed` (tabs, repository list, settings, profiles).
    pub fn emit_app_changed(&self, what: &[AppChange]) {
        let mut what = what.to_vec();
        what.sort();
        what.dedup();
        self.emit(names::APP_CHANGED, &AppChangedEvent { what });
    }

    // --- Repositories -----------------------------------------------------

    /// The repository's database row, or `not_found`.
    pub fn repo_row(&self, repo_id: &str) -> CoreResult<db::repos::RepoRow> {
        self.db.with(|c| db::repos::require(c, repo_id))
    }

    /// Path of the repository. `not_found` if the ID is unknown; `path_not_found` if the folder
    /// no longer exists; `repo_untrusted` as long as the user has not agreed to a repository
    /// that runs its own commands (see `commands::trust`).
    ///
    /// Every command that does something in a repository – run Git, read or write files, start
    /// a terminal or a program – gets the path here. That is why the lock sits in this one
    /// place.
    pub fn repo_path(&self, repo_id: &str) -> CoreResult<PathBuf> {
        let row = self.repo_row(repo_id)?;
        let path = PathBuf::from(&row.path);
        if !path.is_dir() {
            return Err(CoreError::path_not_found(&row.path));
        }
        if !row.trusted {
            return Err(CoreError::repo_untrusted());
        }
        Ok(path)
    }

    /// Git call in an arbitrary folder (app log).
    pub fn git_at(&self, cwd: impl AsRef<Path>) -> GitCmd {
        self.git.cmd(cwd)
    }

    /// Git call in the repository (working directory = root, log with repo_id).
    pub fn git_for(&self, repo_id: &str) -> CoreResult<GitCmd> {
        let path = self.repo_path(repo_id)?;
        Ok(self.git.cmd(path).repo(repo_id))
    }

    // --- Write lock -------------------------------------------------------

    fn lock_for(&self, key: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.locks.lock();
        locks.entry(key.to_string()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))).clone()
    }

    fn network_key(repo_id: &str) -> String {
        format!("netz\0{repo_id}")
    }

    /// Waits for the repository's write lock. Not reentrant: don't call it again for the
    /// same repo while holding the lock.
    pub async fn write_lock(&self, repo_id: &str) -> WriteGuard {
        self.lock_for(repo_id).lock_owned().await
    }

    /// Whether someone currently holds the write lock. Does not wait.
    pub fn write_lock_held(&self, repo_id: &str) -> bool {
        self.lock_for(repo_id).try_lock().is_err()
    }

    /// Waits for the repository's network lock: one transfer (fetch, pull, push, auto-fetch)
    /// runs per repository at a time. It is independent of the write lock – a long fetch
    /// doesn't block a commit. Whoever needs both takes the network lock first, and the write
    /// lock only for the part that changes something locally.
    pub async fn network_lock(&self, repo_id: &str) -> WriteGuard {
        self.lock_for(&Self::network_key(repo_id)).lock_owned().await
    }

    /// The network lock, if it is free. Does not wait (auto-fetch skips otherwise).
    pub fn try_network_lock(&self, repo_id: &str) -> Option<WriteGuard> {
        self.lock_for(&Self::network_key(repo_id)).try_lock_owned().ok()
    }

    /// Runs `action` under the write lock and then reports `repo:changed` with
    /// `changes` – even on an error, because Git may already have changed something
    /// (e.g. a conflict). Empty `changes` = no event.
    ///
    /// ```ignore
    /// core.with_write_lock(&repo_id, &[RepoChange::Refs, RepoChange::Head], async {
    ///     core.git_for(&repo_id)?.args(["branch", &name]).run().await?;
    ///     Ok(())
    /// }).await?;
    /// ```
    pub async fn with_write_lock<T, F>(&self, repo_id: &str, changes: &[RepoChange], action: F) -> CoreResult<T>
    where
        F: Future<Output = CoreResult<T>>,
    {
        let guard = self.write_lock(repo_id).await;
        let result = action.await;
        drop(guard);
        if !changes.is_empty() {
            self.emit_repo_changed(repo_id, changes);
        }
        result
    }

    // --- Idempotency -----------------------------------------------------

    /// Remembers `op_id`. If it was already used in the last 10 minutes: `duplicate`.
    pub fn claim_op(&self, op_id: &str) -> CoreResult<()> {
        let mut ops = self.ops.lock();
        ops.retain(|_, t| t.elapsed() < OP_ID_TTL);
        if ops.contains_key(op_id) {
            return Err(CoreError::duplicate());
        }
        ops.insert(op_id.to_string(), Instant::now());
        Ok(())
    }

    /// Releases `op_id` again (e.g. after an error, so “Retry” works).
    pub fn release_op(&self, op_id: &str) {
        self.ops.lock().remove(op_id);
    }

    /// Runs `action` at most once per `op_id`. A repetition yields `duplicate`;
    /// after an error the op_id is released.
    pub async fn idempotent<T, F>(&self, op_id: &str, action: F) -> CoreResult<T>
    where
        F: Future<Output = CoreResult<T>>,
    {
        self.claim_op(op_id)?;
        let result = action.await;
        if result.is_err() {
            self.release_op(op_id);
        }
        result
    }

    // --- Jobs -------------------------------------------------------------

    /// Registers a cancellable job under the UI's jobId.
    pub fn start_job(&self, job_id: &str, repo_id: Option<&str>) -> CoreResult<Job> {
        Job::new(job_id, repo_id, self.jobs.clone(), self.events.clone())
    }

    // --- Profile and settings ---------------------------------------------

    pub fn active_profile_id(&self) -> CoreResult<String> {
        self.db.with(db::profiles::active_id)
    }

    /// Settings of the active profile (with defaults).
    pub fn settings(&self) -> CoreResult<Settings> {
        crate::commands::settings::load_settings(self)
    }

    /// Whether the OS keychain is reachable (checked once, then remembered).
    pub async fn keyring_available(&self) -> bool {
        if let Some(v) = self.keyring.get() {
            return *v;
        }
        let available = tokio::task::spawn_blocking(probe_keyring).await.unwrap_or(false);
        let _ = self.keyring.set(available);
        available
    }

    /// Tests: whether the keychain has been probed in this run.
    #[cfg(any(test, feature = "testkit"))]
    pub fn keyring_probed(&self) -> bool {
        self.keyring.get().is_some()
    }

    // --- State for other modules ------------------------------------------

    /// Shared state of a module (e.g. file watching, open prompts), created with `Default`
    /// on first access. Exactly one instance per type.
    pub fn state<T: Default + Send + Sync + 'static>(&self) -> Arc<T> {
        let mut states = self.states.lock();
        let entry = states.entry(TypeId::of::<T>()).or_insert_with(|| Arc::new(T::default()));
        match entry.clone().downcast::<T>() {
            Ok(state) => state,
            Err(_) => {
                // Cannot happen (the key is the TypeId); still without a panic.
                let fresh = Arc::new(T::default());
                *entry = fresh.clone();
                fresh
            }
        }
    }
}

fn probe_keyring() -> bool {
    crate::commands::auth::keychain::use_shared_connection();
    match keyring::Entry::new("forkyard", "__probe__") {
        Ok(entry) => matches!(entry.get_password(), Ok(_) | Err(keyring::Error::NoEntry)),
        Err(_) => false,
    }
}
