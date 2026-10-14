//! LFS file locks: what `git lfs locks/lock/unlock` print, the in-memory cache, the check of
//! the paths, and how a server without the locking API is recognised. The commands are in
//! `lfs.rs`.

use std::collections::{HashMap, HashSet};

use parking_lot::Mutex;
use serde::Deserialize;

use crate::app::Core;
use crate::commands::history::normalize_rel_path;
use crate::error::{CoreError, CoreResult};
use crate::git::{errors, redact, GitCmd, GitOutput};
use crate::model::{LfsLock, LfsLockFailure, LfsLockList};
use crate::util;

/// At most this many paths per call: the command line stays well below the Windows limit.
pub(super) const MAX_PATHS: usize = 200;

pub(super) const NO_LOCKING: &str = "The LFS server of this repository does not offer file locking (or you have no access to it). Locks are only available on servers with the Git LFS locking API.";

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/// The last list per repository. Locks live only on the LFS server – this is no mirror of Git
/// data. A fetch marks the entry stale (`mark_stale`), a failed read drops it (`forget`).
#[derive(Default)]
pub struct LockCache {
    entries: Mutex<HashMap<String, Cached>>,
}

struct Cached {
    list: LfsLockList,
    stale: bool,
}

impl LockCache {
    /// The cached list, if there is one and it is not stale.
    pub(super) fn fresh(&self, repo_id: &str) -> Option<LfsLockList> {
        self.entries.lock().get(repo_id).filter(|entry| !entry.stale).map(|entry| entry.list.clone())
    }

    pub(super) fn store(&self, repo_id: &str, list: LfsLockList) {
        self.entries.lock().insert(repo_id.to_string(), Cached { list, stale: false });
    }

    /// After a failed read: no old list may hide the problem.
    pub(super) fn forget(&self, repo_id: &str) {
        self.entries.lock().remove(repo_id);
    }

    /// Marks the entry stale; `false` if nobody has read the locks of this repository yet.
    pub(super) fn mark_stale(&self, repo_id: &str) -> bool {
        match self.entries.lock().get_mut(repo_id) {
            Some(entry) => {
                entry.stale = true;
                true
            }
            None => false,
        }
    }
}

// ---------------------------------------------------------------------------
// Output of Git LFS
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct RawLock {
    id: String,
    path: String,
    #[serde(default)]
    owner: Option<RawOwner>,
    #[serde(default)]
    locked_at: Option<String>,
}

#[derive(Deserialize)]
struct RawOwner {
    #[serde(default)]
    name: String,
}

impl RawLock {
    fn into_lock(self, ours: bool) -> LfsLock {
        LfsLock {
            id: self.id,
            path: self.path,
            owner: self.owner.map(|owner| owner.name).unwrap_or_default(),
            locked_at: self.locked_at.filter(|time| !time.is_empty()),
            ours,
        }
    }
}

#[derive(Deserialize)]
struct Verified {
    #[serde(default)]
    ours: Vec<RawLock>,
    #[serde(default)]
    theirs: Vec<RawLock>,
}

/// Git LFS 3.7 prints a list for `lock`/`unlock --json`; older 3.x versions print a single object
/// when one path is given. Both are accepted.
#[derive(Deserialize)]
#[serde(untagged)]
enum OneOrMany<T> {
    Many(Vec<T>),
    One(T),
}

impl<T> OneOrMany<T> {
    fn into_vec(self) -> Vec<T> {
        match self {
            OneOrMany::Many(items) => items,
            OneOrMany::One(item) => vec![item],
        }
    }
}

fn parse_entries<T: serde::de::DeserializeOwned>(stdout: &[u8]) -> Vec<T> {
    serde_json::from_slice::<OneOrMany<T>>(stdout).map(OneOrMany::into_vec).unwrap_or_default()
}

#[derive(Deserialize)]
struct UnlockEntry {
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    unlocked: bool,
    #[serde(default)]
    reason: Option<String>,
}

/// `git lfs locks --verify --json`: `{"ours":[…],"theirs":[…]}` → sorted by path.
pub(super) fn parse_verified(stdout: &[u8]) -> Option<Vec<LfsLock>> {
    let parsed: Verified = serde_json::from_slice(stdout).ok()?;
    let mut locks: Vec<LfsLock> =
        parsed.ours.into_iter().map(|lock| lock.into_lock(true)).chain(parsed.theirs.into_iter().map(|lock| lock.into_lock(false))).collect();
    locks.sort_by(|a, b| a.path.cmp(&b.path));
    Some(locks)
}

/// First non-empty line, trimmed; `fallback` if there is none.
fn first_line_or(text: &str, fallback: &str) -> String {
    text.lines().map(str::trim).find(|line| !line.is_empty()).unwrap_or(fallback).to_string()
}

/// A reason from Git LFS's JSON: without credentials, first line only.
fn clean_reason(text: &str, fallback: &str) -> String {
    first_line_or(&redact::redact(text), fallback)
}

/// Per requested path that `git lfs lock --json` did not report as locked: the reason from its
/// line "Locking <path> failed: <reason>" – or the first line of the error output.
pub(super) fn lock_failures(paths: &[String], out: &GitOutput) -> Vec<LfsLockFailure> {
    let locked: HashSet<String> = parse_entries::<RawLock>(&out.stdout).into_iter().map(|lock| lock.path).collect();
    let stderr = out.stderr_text();
    paths
        .iter()
        .filter(|path| !locked.contains(*path))
        .map(|path| {
            let prefix = format!("Locking {path} failed: ");
            let reason = stderr
                .lines()
                .find_map(|line| line.strip_prefix(prefix.as_str()))
                .map(|reason| reason.trim().to_string())
                .unwrap_or_else(|| first_line_or(&stderr, "Git LFS did not lock the file."));
            LfsLockFailure { path: path.clone(), reason }
        })
        .collect()
}

/// Per requested path that `git lfs unlock --json` did not unlock, with Git LFS's reason.
pub(super) fn unlock_failures(paths: &[String], out: &GitOutput) -> Vec<LfsLockFailure> {
    let entries: Vec<UnlockEntry> = parse_entries(&out.stdout);
    let stderr = out.stderr_text();
    let fallback = || first_line_or(&stderr, "Git LFS did not unlock the file.");
    paths
        .iter()
        .filter_map(|path| match entries.iter().find(|entry| entry.path.as_deref() == Some(path.as_str())) {
            Some(entry) if entry.unlocked => None,
            Some(entry) => Some(LfsLockFailure {
                path: path.clone(),
                reason: entry.reason.as_deref().map(|reason| clean_reason(reason, "Git LFS did not unlock the file.")).unwrap_or_else(fallback),
            }),
            None if out.success() => None,
            None => Some(LfsLockFailure { path: path.clone(), reason: fallback() }),
        })
        .collect()
}

/// Whether Git LFS's message means: this server has no locking API (404, 405, 501 or its own
/// message "Not Found"). Messages about missing credentials never count.
pub(super) fn lacks_locking(text: &str) -> bool {
    text.lines().any(|line| {
        let lower = line.trim().to_lowercase();
        if lower.is_empty() || lower.contains("git credentials for") {
            return false;
        }
        lower == "not found"
            || lower.ends_with(": not found")
            || lower.contains("repository or object not found")
            || lower.contains("not implemented")
            || ["from http 404", "from http 405", "from http 501"].iter().any(|status| lower.contains(status))
            || lower.contains("locking api")
    })
}

/// Error of a failed `git lfs locks`: a server without the locking API → `unsupported`,
/// otherwise the usual classification (offline, sign-in …). Output without credentials.
pub(super) fn read_error(out: &GitOutput) -> CoreError {
    let stderr = out.stderr_text();
    if lacks_locking(&stderr) {
        return CoreError::unsupported(NO_LOCKING).with_git_output(&stderr);
    }
    errors::classify("lfs", out.code, &out.stdout, &out.stderr)
}

/// Locks whose path or owner contains `filter` (case does not matter); empty filter = all.
pub(super) fn filtered(mut list: LfsLockList, filter: Option<&str>) -> LfsLockList {
    let needle = filter.map(str::trim).unwrap_or_default().to_lowercase();
    if !needle.is_empty() {
        list.locks.retain(|lock| lock.path.to_lowercase().contains(&needle) || lock.owner.to_lowercase().contains(&needle));
    }
    list
}

/// Paths for `git lfs lock/unlock`: inside the repository, with `/`, without duplicates, one line
/// each (the failures are read line by line), at most `MAX_PATHS`.
pub(super) fn check_paths(paths: &[String]) -> CoreResult<Vec<String>> {
    if paths.is_empty() {
        return Err(CoreError::not_allowed("No file was given."));
    }
    if paths.len() > MAX_PATHS {
        return Err(CoreError::not_allowed(format!("At most {MAX_PATHS} files can be locked or unlocked at once.")));
    }
    let mut out: Vec<String> = Vec::with_capacity(paths.len());
    for path in paths {
        if path.contains(['\n', '\r']) {
            return Err(CoreError::not_allowed("A path must not contain a line break."));
        }
        let path = normalize_rel_path(path)?;
        if !out.contains(&path) {
            out.push(path);
        }
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// Reading from the server
// ---------------------------------------------------------------------------

/// `git lfs locks --verify` plus `extra`. `interactive`: the user asked (manual refresh, after
/// lock/unlock) – Git may then ask for credentials; in the background never, and without log.
fn locks_cmd(core: &Core, repo_id: &str, interactive: bool, extra: &[&str]) -> CoreResult<GitCmd> {
    let cmd = core.git_for(repo_id)?.args(["lfs", "locks", "--verify"]).args(extra).read_only().network();
    Ok(if interactive { cmd } else { cmd.no_prompt().no_log() })
}

async fn read_uncached(core: &Core, repo_id: &str, interactive: bool) -> CoreResult<LfsLockList> {
    let out = locks_cmd(core, repo_id, interactive, &["--json"])?.run_raw().await?;
    if !out.success() {
        return Err(read_error(&out));
    }
    let locks = parse_verified(&out.stdout)
        .ok_or_else(|| CoreError::unknown("Git LFS returned a list of locks that cannot be read.").with_git_output(out.stdout_text()))?;
    if locks.is_empty() {
        // With `--json`, Git LFS 3.x reports a failed request as an empty list and exit code 0.
        // The text form fails properly – so an empty list is confirmed once that way.
        let probe = locks_cmd(core, repo_id, interactive, &["--limit", "1"])?.run_raw().await?;
        if !probe.success() {
            return Err(read_error(&probe));
        }
    }
    Ok(LfsLockList { locks, fetched_at: util::now_iso() })
}

/// Reads the locks from the server and caches them; after an error the cache forgets the
/// repository, so an old list never hides the problem.
pub(super) async fn read(core: &Core, repo_id: &str, interactive: bool) -> CoreResult<LfsLockList> {
    let result = read_uncached(core, repo_id, interactive).await;
    let cache = core.state::<LockCache>();
    match &result {
        Ok(list) => cache.store(repo_id, list.clone()),
        Err(_) => cache.forget(repo_id),
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    fn output(code: i32, stdout: &str, stderr: &str) -> GitOutput {
        GitOutput { code: Some(code), stdout: stdout.as_bytes().to_vec(), stderr: stderr.as_bytes().to_vec(), ..Default::default() }
    }

    fn lock(path: &str, owner: &str, ours: bool) -> LfsLock {
        LfsLock { id: path.into(), path: path.into(), owner: owner.into(), locked_at: None, ours }
    }

    #[test]
    fn verified_lists_are_parsed_and_sorted() {
        let json = r#"{"ours":[{"id":"2","path":"mit leer/Größe.psd","owner":{"name":"Test Person"},"locked_at":"2026-01-02T03:04:05Z"}],"theirs":[{"id":"1","path":"bilder/karte.psd","owner":{"name":"Lena Berg"},"locked_at":"2026-01-02T03:04:05Z"},{"id":"7","path":"ohne-besitzer.bin"}]}"#.as_bytes();
        let locks = parse_verified(json).unwrap();
        assert_eq!(
            locks.iter().map(|l| (l.path.as_str(), l.owner.as_str(), l.ours)).collect::<Vec<_>>(),
            [("bilder/karte.psd", "Lena Berg", false), ("mit leer/Größe.psd", "Test Person", true), ("ohne-besitzer.bin", "", false)]
        );
        assert_eq!(locks[0].id, "1");
        assert_eq!(locks[0].locked_at.as_deref(), Some("2026-01-02T03:04:05Z"));
        assert_eq!(locks[2].locked_at, None);
        assert_eq!(parse_verified(br#"{"ours":[],"theirs":[]}"#), Some(vec![]));
        assert_eq!(parse_verified(b"kaputt"), None);
    }

    /// Real output of git-lfs 3.7.1: successes as JSON on stdout, failures as lines on stderr.
    #[test]
    fn lock_failures_come_per_path() {
        let paths = vec!["plan.psd".to_string(), "frei.psd".to_string(), "mit leer/x.psd".to_string()];
        let out = output(
            2,
            r#"[{"id":"11","path":"frei.psd","owner":{"name":"Test Person"},"locked_at":"2026-01-02T03:04:05Z"}]"#,
            "Locking plan.psd failed: already created lock\nLocking mit leer/x.psd failed: Repository or object not found: http://127.0.0.1:1/locks\nCheck that it exists and that you have proper access to it\n",
        );
        assert_eq!(
            lock_failures(&paths, &out),
            vec![
                LfsLockFailure { path: "plan.psd".into(), reason: "already created lock".into() },
                LfsLockFailure { path: "mit leer/x.psd".into(), reason: "Repository or object not found: http://127.0.0.1:1/locks".into() },
            ]
        );
        // Without a line for the path: the first line of the error output.
        let failed = lock_failures(&["a.psd".to_string()], &output(2, "[]", "fatal: something else\n"));
        assert_eq!(failed[0].reason, "fatal: something else");
        assert!(lock_failures(&["a.psd".to_string()], &output(0, r#"[{"id":"1","path":"a.psd"}]"#, "")).is_empty());
        // Older Git LFS 3.x: a single object instead of a list.
        assert!(lock_failures(&["a.psd".to_string()], &output(0, r#"{"id":"1","path":"a.psd"}"#, "")).is_empty());
    }

    #[test]
    fn unlock_failures_come_from_the_json() {
        let paths = vec!["a.psd".to_string(), "b.psd".to_string(), "c.psd".to_string()];
        let out = output(
            2,
            r#"[{"path":"a.psd","unlocked":true},{"path":"b.psd","unlocked":false,"reason":"You must have admin access to force delete a lock"},{"path":"c.psd","unlocked":false,"reason":"unable to get lock ID: Repository or object not found: http://lena:geheim-token-1234@127.0.0.1:1/locks?path=c.psd\nCheck that it exists and that you have proper access to it"}]"#,
            "",
        );
        let failed = unlock_failures(&paths, &out);
        assert_eq!(failed.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["b.psd", "c.psd"]);
        assert_eq!(failed[0].reason, "You must have admin access to force delete a lock");
        let reason = &failed[1].reason;
        assert!(reason.starts_with("unable to get lock ID: Repository or object not found"), "{reason}");
        assert!(!reason.contains("geheim-token-1234") && !reason.contains("Check that"), "{reason}");
        // No JSON at all and a failure: every path fails with the error output.
        let failed = unlock_failures(&["a.psd".to_string()], &output(2, "", "Cannot unlock file with uncommitted changes\n"));
        assert_eq!(failed[0].reason, "Cannot unlock file with uncommitted changes");
        // Success without an entry counts as unlocked.
        assert!(unlock_failures(&["a.psd".to_string()], &output(0, "[]", "")).is_empty());
        // Older Git LFS 3.x: a single object instead of a list.
        let failed = unlock_failures(&["b.psd".to_string()], &output(2, r#"{"path":"b.psd","unlocked":false,"reason":"Lock not found"}"#, ""));
        assert_eq!(failed, vec![LfsLockFailure { path: "b.psd".into(), reason: "Lock not found".into() }]);
    }

    /// Messages of git-lfs 3.7.1 against a local server (404 with and without body, 501, 405).
    #[test]
    fn servers_without_locking_are_recognised() {
        for text in [
            "Error while retrieving locks: Not Found",
            "Error while retrieving locks: Repository or object not found: http://127.0.0.1:1/locks/verify\nCheck that it exists and that you have proper access to it",
            "Error while retrieving locks: Not Implemented: http://127.0.0.1:1/locks/verify",
            "Error while retrieving locks: Client error http://127.0.0.1:1/locks/verify from HTTP 405",
            "Remote \"origin\" does not support the Git LFS locking API. Consider disabling it with:",
            "unable to get lock ID: Not Found",
            "Not Found",
        ] {
            assert!(lacks_locking(text), "{text}");
        }
        for text in [
            "Error while retrieving locks: Git credentials for http://127.0.0.1:1/ not found:\ncredential fill errors:\nexit status 1",
            "unable to get lock ID: no matching locks found",
            "already created lock",
            "Error while retrieving locks: Post \"http://127.0.0.1:1/locks/verify\": dial tcp 127.0.0.1:1: connect: connection refused",
            "You must have admin access to force delete a lock",
            "",
        ] {
            assert!(!lacks_locking(text), "{text}");
        }
    }

    #[test]
    fn read_errors_are_classified() {
        let e = read_error(&output(2, "", "Error while retrieving locks: Not Found\n"));
        assert_eq!((e.code, e.message.as_str()), (ErrorCode::Unsupported, NO_LOCKING));
        assert!(e.git_output.as_deref().is_some_and(|o| o.contains("Not Found")), "{e:?}");
        let e = read_error(&output(
            2,
            "",
            "Error while retrieving locks: Post \"http://lena:geheim-token-1234@127.0.0.1:1/locks/verify\": dial tcp 127.0.0.1:1: connect: connection refused\n",
        ));
        assert_eq!(e.code, ErrorCode::Offline);
        assert!(!e.git_output.unwrap_or_default().contains("geheim-token-1234"));
    }

    #[test]
    fn paths_are_checked_and_deduplicated() {
        let paths: Vec<String> = vec!["./bilder//karte.psd".into(), "bilder/karte.psd".into(), "-strich.psd".into(), "mit leer/Größe.psd".into()];
        assert_eq!(check_paths(&paths).unwrap(), ["bilder/karte.psd", "-strich.psd", "mit leer/Größe.psd"]);
        let too_many: Vec<String> = (0..=MAX_PATHS).map(|i| format!("f{i}.psd")).collect();
        for bad in [vec![], vec!["../aussen.psd".to_string()], vec!["/etc/passwd".to_string()], vec![String::new()], vec!["a\nb.psd".to_string()], too_many] {
            assert_eq!(check_paths(&bad).unwrap_err().code, ErrorCode::NotAllowed, "{bad:?}");
        }
    }

    #[test]
    fn filter_matches_path_or_owner_without_case() {
        let list = LfsLockList { locks: vec![lock("bilder/Karte.psd", "Lena Berg", false), lock("ton/intro.wav", "Test Person", true)], fetched_at: "t".into() };
        let paths = |filter: Option<&str>| filtered(list.clone(), filter).locks.into_iter().map(|l| l.path).collect::<Vec<_>>();
        assert_eq!(paths(None), ["bilder/Karte.psd", "ton/intro.wav"]);
        assert_eq!(paths(Some("  ")), ["bilder/Karte.psd", "ton/intro.wav"]);
        assert_eq!(paths(Some(" KARTE ")), ["bilder/Karte.psd"]);
        assert_eq!(paths(Some("person")), ["ton/intro.wav"]);
        assert!(paths(Some("nichts")).is_empty());
    }

    #[test]
    fn the_cache_goes_stale_and_forgets() {
        let cache = LockCache::default();
        let list = LfsLockList { locks: vec![lock("a.psd", "Lena", false)], fetched_at: "t".into() };
        assert!(!cache.mark_stale("r1"), "nothing cached yet");
        cache.store("r1", list.clone());
        assert_eq!(cache.fresh("r1"), Some(list.clone()));
        assert!(cache.mark_stale("r1"));
        assert_eq!(cache.fresh("r1"), None);
        cache.store("r1", list.clone());
        cache.forget("r1");
        assert_eq!(cache.fresh("r1"), None);
        assert!(!cache.mark_stale("r1"));
        assert_eq!(cache.fresh("r2"), None);
    }
}
