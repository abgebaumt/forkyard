//! Test helpers (feature `testkit`, always on in the crate's own tests).
//!
//! - `TestRepo`: real repository in a temp folder, fixed identity and fixed,
//!   sequential timestamps; helpers for files, commits, branches, merge, remote.
//! - `TestRemote`: bare repository as a remote.
//! - `TestCore`: `Core` with a temp data directory, event collector and isolated
//!   Git configuration (no system config, its own global config) – tests never
//!   modify the real ~/.gitconfig. Secrets (tokens, proxy passwords) end up in
//!   memory instead of the machine's keychain.
//! - `MockServer`: local HTTP server for tests of the host integration.
//!
//! Panics are allowed here: this is test code.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::ffi::OsString;
use std::ops::Deref;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;

use tempfile::TempDir;

pub mod mock_http;

pub use mock_http::{MockRequest, MockResponse, MockServer, TunnelProxy};

use crate::app::{Core, CoreConfig};
use crate::events::EventCollector;
use crate::model::OpenedRepo;

/// 2026-01-01T00:00:00Z – base of the fixed commit timestamps.
pub const BASE_TIME: i64 = 1_767_225_600;
pub const AUTHOR_NAME: &str = "Test Person";
pub const AUTHOR_EMAIL: &str = "test@example.com";

/// Environment that isolates Git from the machine's configuration.
pub fn git_isolation_env(global_config: &Path) -> Vec<(OsString, OsString)> {
    vec![
        ("GIT_CONFIG_NOSYSTEM".into(), "1".into()),
        ("GIT_CONFIG_GLOBAL".into(), global_config.as_os_str().to_os_string()),
        ("GIT_TERMINAL_PROMPT".into(), "0".into()),
        ("LC_ALL".into(), "C".into()),
    ]
}

/// A new temp folder. On macOS under the resolved path (`/private/var/…` instead of the
/// symlink `/var/…`), as Git reports it – otherwise paths from Git and from the tests differ.
pub fn temp_folder() -> TempDir {
    #[cfg(target_os = "macos")]
    if let Ok(base) = std::env::temp_dir().canonicalize() {
        return tempfile::Builder::new().tempdir_in(base).expect("temp folder");
    }
    // Windows runners point TEMP at an 8.3 short path (C:\Users\RUNNER~1\…), while Git reports the
    // long one. Canonicalizing expands it; the verbatim prefix it adds is dropped again.
    #[cfg(windows)]
    if let Ok(base) = std::env::temp_dir().canonicalize() {
        let text = base.to_string_lossy();
        let base = text.strip_prefix(r"\\?\").map(PathBuf::from).unwrap_or_else(|| base.clone());
        return tempfile::Builder::new().tempdir_in(base).expect("temp folder");
    }
    tempfile::tempdir().expect("temp folder")
}

fn git_command(cwd: &Path, global_config: &Path, args: &[&str], time: Option<i64>) -> Command {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(cwd).stdin(Stdio::null());
    for (k, v) in git_isolation_env(global_config) {
        cmd.env(k, v);
    }
    if let Some(t) = time {
        let stamp = format!("@{t} +0000");
        cmd.env("GIT_AUTHOR_DATE", &stamp).env("GIT_COMMITTER_DATE", &stamp);
    }
    cmd
}

fn check(output: Output, what: &str) -> String {
    if !output.status.success() {
        panic!(
            "git {what} failed:\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    String::from_utf8_lossy(&output.stdout).trim_end().to_string()
}

/// Real repository in a temp folder (branch `main`).
pub struct TestRepo {
    dir: TempDir,
    root: PathBuf,
    global_config: PathBuf,
    tick: AtomicI64,
}

impl TestRepo {
    /// Empty repository with identity `Test Person <test@example.com>`, without a commit.
    pub fn new() -> Self {
        let repo = Self::bare_init();
        repo.git(&["config", "user.name", AUTHOR_NAME]);
        repo.git(&["config", "user.email", AUTHOR_EMAIL]);
        repo
    }

    /// Repository without a configured identity (for `identity_missing`).
    pub fn without_identity() -> Self {
        let repo = Self::bare_init();
        // Otherwise Git guesses an identity from the account and host name (macOS, some Linux setups).
        repo.git(&["config", "user.useConfigOnly", "true"]);
        repo
    }

    /// Repository with a first commit (README.md).
    pub fn with_commit() -> Self {
        let repo = Self::new();
        repo.commit_file("README.md", "# Test\n", "Erster Commit");
        repo
    }

    fn bare_init() -> Self {
        let dir = temp_folder();
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root).expect("repo folder");
        let global_config = dir.path().join("gitconfig");
        std::fs::write(&global_config, "").expect("global config");
        let repo = TestRepo { dir, root, global_config, tick: AtomicI64::new(0) };
        repo.git(&["init", "-q", "-b", "main"]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        repo.git(&["config", "core.autocrlf", "false"]);
        repo
    }

    /// Root directory of the repository.
    pub fn path(&self) -> &Path {
        &self.root
    }

    /// Temp folder that contains the repository (for sibling folders).
    pub fn temp_dir(&self) -> &Path {
        self.dir.path()
    }

    /// Next fixed timestamp (one minute later per call).
    pub fn next_time(&self) -> i64 {
        BASE_TIME + 60 * self.tick.fetch_add(1, Ordering::SeqCst)
    }

    /// git in the repository; panics on error, returns stdout without the trailing newline.
    pub fn git(&self, args: &[&str]) -> String {
        check(self.git_output(args), &args.join(" "))
    }

    /// git in the repository without checking the exit code.
    pub fn git_output(&self, args: &[&str]) -> Output {
        git_command(&self.root, &self.global_config, args, Some(self.next_time())).output().expect("start git")
    }

    pub fn write_file(&self, rel: &str, content: impl AsRef<[u8]>) {
        let path = self.root.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("create folder");
        }
        std::fs::write(path, content).expect("write file");
    }

    pub fn read_file(&self, rel: &str) -> Vec<u8> {
        std::fs::read(self.root.join(rel)).expect("read file")
    }

    pub fn remove_file(&self, rel: &str) {
        std::fs::remove_file(self.root.join(rel)).expect("delete file");
    }

    /// Creates a subfolder and returns its path.
    pub fn subdir(&self, rel: &str) -> PathBuf {
        let path = self.root.join(rel);
        std::fs::create_dir_all(&path).expect("subfolder");
        path
    }

    /// Stages and commits everything; returns the SHA.
    pub fn commit(&self, message: &str) -> String {
        self.git(&["add", "-A"]);
        self.git(&["commit", "-q", "-m", message]);
        self.head()
    }

    pub fn commit_file(&self, rel: &str, content: impl AsRef<[u8]>, message: &str) -> String {
        self.write_file(rel, content);
        self.commit(message)
    }

    pub fn empty_commit(&self, message: &str) -> String {
        self.git(&["commit", "-q", "--allow-empty", "-m", message]);
        self.head()
    }

    /// Stages everything and commits as `name <email>` with author and committer date `date`
    /// (Git's raw format, e.g. "@1750615200 +0200"); returns the SHA. For tests that need exact
    /// times and several authors (statistics).
    pub fn commit_as(&self, message: &str, name: &str, email: &str, date: &str) -> String {
        self.git(&["add", "-A"]);
        let mut cmd = git_command(&self.root, &self.global_config, &["commit", "-q", "--allow-empty", "-m", message], None);
        cmd.env("GIT_AUTHOR_NAME", name).env("GIT_AUTHOR_EMAIL", email).env("GIT_AUTHOR_DATE", date);
        cmd.env("GIT_COMMITTER_NAME", name).env("GIT_COMMITTER_EMAIL", email).env("GIT_COMMITTER_DATE", date);
        check(cmd.output().expect("start git"), "commit");
        self.head()
    }

    pub fn head(&self) -> String {
        self.git(&["rev-parse", "HEAD"])
    }

    pub fn current_branch(&self) -> String {
        self.git(&["symbolic-ref", "--short", "HEAD"])
    }

    pub fn branch(&self, name: &str) {
        self.git(&["branch", name]);
    }

    pub fn branch_at(&self, name: &str, start: &str) {
        self.git(&["branch", name, start]);
    }

    pub fn checkout(&self, name: &str) {
        self.git(&["checkout", "-q", name]);
    }

    /// Creates a new branch and checks it out.
    pub fn checkout_new(&self, name: &str) {
        self.git(&["checkout", "-q", "-b", name]);
    }

    /// `git merge --no-edit <name>`; `false` on conflict (the merge then stays in progress).
    pub fn merge(&self, name: &str) -> bool {
        self.git_output(&["merge", "--no-edit", name]).status.success()
    }

    pub fn tag(&self, name: &str) {
        self.git(&["tag", name]);
    }

    /// Creates a bare remote, registers it as `origin` and pushes the current branch with upstream.
    pub fn add_remote(&self) -> TestRemote {
        let remote = TestRemote::new();
        self.git(&["remote", "add", "origin", &remote.url()]);
        let branch = self.current_branch();
        self.git(&["push", "-q", "-u", "origin", &branch]);
        remote
    }

    /// Clones `remote` into a new TestRepo (with identity).
    pub fn clone_of(remote: &TestRemote) -> TestRepo {
        let dir = temp_folder();
        let root = dir.path().join("repo");
        let global_config = dir.path().join("gitconfig");
        std::fs::write(&global_config, "").expect("global config");
        let out = git_command(dir.path(), &global_config, &["clone", "-q", &remote.url(), "repo"], None)
            .output()
            .expect("git clone");
        check(out, "clone");
        let repo = TestRepo { dir, root, global_config, tick: AtomicI64::new(1000) };
        repo.git(&["config", "user.name", AUTHOR_NAME]);
        repo.git(&["config", "user.email", AUTHOR_EMAIL]);
        repo.git(&["config", "commit.gpgsign", "false"]);
        repo.git(&["config", "core.autocrlf", "false"]);
        repo
    }
}

impl Default for TestRepo {
    fn default() -> Self {
        Self::new()
    }
}

/// Bare repository as a remote.
pub struct TestRemote {
    _dir: TempDir,
    path: PathBuf,
    global_config: PathBuf,
}

impl TestRemote {
    pub fn new() -> Self {
        let dir = temp_folder();
        let path = dir.path().join("remote.git");
        let global_config = dir.path().join("gitconfig");
        std::fs::write(&global_config, "").expect("global config");
        let out = git_command(dir.path(), &global_config, &["init", "-q", "--bare", "-b", "main", "remote.git"], None)
            .output()
            .expect("git init --bare");
        check(out, "init --bare");
        TestRemote { _dir: dir, path, global_config }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// URL for `git remote add` / `git clone` (local path with forward slashes).
    pub fn url(&self) -> String {
        self.path.to_string_lossy().replace('\\', "/")
    }

    /// git in the bare repository.
    pub fn git(&self, args: &[&str]) -> String {
        check(git_command(&self.path, &self.global_config, args, None).output().expect("git"), &args.join(" "))
    }

    /// Like `git`, but an error is not a panic: the caller evaluates the output itself.
    pub fn git_output(&self, args: &[&str]) -> Output {
        git_command(&self.path, &self.global_config, args, None).output().expect("git")
    }
}

impl Default for TestRemote {
    fn default() -> Self {
        Self::new()
    }
}

/// Core with a temp data directory and event collector.
pub struct TestCore {
    pub core: Core,
    pub events: Arc<EventCollector>,
    /// Secrets of this core (instead of the keychain); survive `restart`.
    pub secrets: Arc<crate::secrets::MemorySecrets>,
    dir: TempDir,
}

impl TestCore {
    pub async fn new() -> Self {
        Self::build(temp_folder(), None, None, None).await
    }

    /// With a fixed Git path (e.g. a non-existent one, to check `git_missing`).
    pub async fn with_git_path(path: PathBuf) -> Self {
        Self::build(temp_folder(), Some(path), None, None).await
    }

    /// With a pre-filled global Git configuration (contents of a .gitconfig).
    pub async fn with_global_config(content: &str) -> Self {
        Self::build(temp_folder(), None, Some(content), None).await
    }

    async fn build(dir: TempDir, git_path: Option<PathBuf>, global: Option<&str>, secrets: Option<Arc<crate::secrets::MemorySecrets>>) -> Self {
        let global_config = dir.path().join("gitconfig");
        if !global_config.exists() || global.is_some() {
            std::fs::write(&global_config, global.unwrap_or("")).expect("global config");
        }
        let events = Arc::new(EventCollector::new());
        let mut config = CoreConfig::new(dir.path().join("data"), "0.0.0-test", events.clone());
        config.git_env = git_isolation_env(&global_config);
        config.git_path = git_path;
        let secrets = secrets.unwrap_or_default();
        config.memory_secrets = Some(secrets.clone());
        let core = Core::open(config).await.expect("open core");
        // Tests do not call real services: avatars only if a test sets up a mock.
        crate::commands::avatars::configure(&core, Some(String::new()));
        TestCore { core, events, secrets, dir }
    }

    /// Simulates a restart of the app on the same data directory.
    pub async fn restart(self) -> Self {
        let TestCore { core, dir, secrets, .. } = self;
        drop(core);
        Self::build(dir, None, None, Some(secrets)).await
    }

    /// Path of this core's global Git configuration (instead of ~/.gitconfig).
    pub fn global_config_path(&self) -> PathBuf {
        self.dir.path().join("gitconfig")
    }

    /// Opens a TestRepo via `repo_open` – as the user's own repository: if it brings
    /// hooks or suspicious entries along (many tests set them up beforehand), the test
    /// agrees, as the user would in the dialog. Tests about trust itself call
    /// `repo_open` directly.
    pub async fn open(&self, repo: &TestRepo) -> OpenedRepo {
        let mut opened = crate::commands::repos::repo_open(&self.core, repo.path().to_string_lossy().into_owned())
            .await
            .expect("repo_open");
        if !opened.repo.trusted {
            crate::commands::trust::repo_trust_set(&self.core, opened.repo.id.clone(), true).await.expect("repo_trust_set");
            opened.repo.trusted = true;
        }
        opened
    }
}

impl Deref for TestCore {
    type Target = Core;
    fn deref(&self) -> &Core {
        &self.core
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repo_helpers_produce_deterministic_history() {
        let repo = TestRepo::new();
        let first = repo.commit_file("a.txt", "eins\n", "Erster");
        let second = repo.commit_file("a.txt", "zwei\n", "Zweiter");
        assert_ne!(first, second);
        assert_eq!(repo.head(), second);
        assert_eq!(repo.current_branch(), "main");
        assert_eq!(repo.git(&["log", "-1", "--format=%an <%ae>"]), format!("{AUTHOR_NAME} <{AUTHOR_EMAIL}>"));
        // Fixed, sequential timestamps: identical steps produce identical SHAs.
        let other = TestRepo::new();
        assert_eq!(other.commit_file("a.txt", "eins\n", "Erster"), first);
        let time: i64 = repo.git(&["log", "-1", "--format=%at", &first]).parse().unwrap();
        assert!((BASE_TIME..BASE_TIME + 3600).contains(&time));
    }

    #[test]
    fn branch_merge_conflict_and_remote_clone() {
        let repo = TestRepo::with_commit();
        repo.checkout_new("feature");
        repo.commit_file("README.md", "# Feature\n", "Feature ändert README");
        repo.checkout("main");
        repo.branch("ohne-konflikt");
        repo.commit_file("README.md", "# Main\n", "Main ändert README");
        assert!(!repo.merge("feature"), "the merge must end in a conflict");
        assert!(repo.path().join(".git").join("MERGE_HEAD").exists());
        repo.git(&["merge", "--abort"]);
        assert!(repo.merge("ohne-konflikt"));

        let remote = repo.add_remote();
        assert_eq!(remote.git(&["rev-parse", "refs/heads/main"]), repo.head());
        assert_eq!(repo.git(&["rev-parse", "--abbrev-ref", "main@{upstream}"]), "origin/main");
        let clone = TestRepo::clone_of(&remote);
        assert_eq!(clone.head(), repo.head());
        assert_eq!(clone.read_file("README.md"), b"# Main\n");
        clone.commit_file("neu.txt", "x", "Im Klon");
        clone.git(&["push", "-q", "origin", "main"]);
        assert_eq!(remote.git(&["rev-parse", "refs/heads/main"]), clone.head());
    }

    #[tokio::test]
    async fn core_is_isolated_from_the_machine_config() {
        let tc = TestCore::new().await;
        assert!(tc.global_config_path().exists());
        assert_eq!(tc.global_git_config("user.name").await, "");
        let events_before = tc.events.all().len();
        tc.emit_app_changed(&[crate::model::AppChange::Tabs]);
        assert_eq!(tc.events.all().len(), events_before + 1);
    }
}
