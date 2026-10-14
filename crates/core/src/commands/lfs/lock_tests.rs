//! LFS locks against a local stand-in for the LFS locking API (testkit `MockServer`): listing,
//! the cache, locking, unlocking, refresh after a fetch, servers without locking, redaction.
//! Tests that run `git lfs` are skipped when Git LFS is not installed.

use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{json, Value};

use super::*;
use crate::error::ErrorCode;
use crate::events::names;
use crate::model::LfsLock;
use crate::testkit::{MockRequest, MockResponse, MockServer, TestCore, TestRepo};

/// The server decides who "we" are: locks of this owner come back as `ours`.
const ME: &str = "Test Person";
const LOCKED_AT: &str = "2026-01-02T03:04:05Z";

/// LFS lock server in memory: `GET /locks`, `POST /locks`, `POST /locks/verify`,
/// `POST /locks/<id>/unlock` – as the Git LFS locking API describes them.
struct LockServer {
    server: MockServer,
    locks: Arc<Mutex<Vec<Value>>>,
}

impl LockServer {
    fn start() -> Self {
        let locks: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
        let state = locks.clone();
        let server = MockServer::start(move |request| answer(&state, request));
        LockServer { server, locks }
    }

    fn url(&self) -> String {
        self.server.url()
    }

    fn seed(&self, path: &str, owner: &str) {
        let mut locks = self.locks.lock();
        let id = (locks.len() + 1).to_string();
        locks.push(json!({ "id": id, "path": path, "owner": { "name": owner }, "locked_at": LOCKED_AT }));
    }

    fn paths(&self) -> Vec<String> {
        let mut paths: Vec<String> = self.locks.lock().iter().map(|lock| lock["path"].as_str().unwrap_or_default().to_string()).collect();
        paths.sort();
        paths
    }

    fn count(&self, route: &str) -> usize {
        self.server.count(route)
    }
}

fn answer(state: &Mutex<Vec<Value>>, request: &MockRequest) -> MockResponse {
    let mut locks = state.lock();
    let route = request.route();
    match route.as_str() {
        "GET /locks" => {
            let path = request.query("path");
            let id = request.query("id");
            let found: Vec<Value> = locks
                .iter()
                .filter(|lock| path.as_deref().is_none_or(|p| lock["path"] == p) && id.as_deref().is_none_or(|i| lock["id"] == i))
                .cloned()
                .collect();
            MockResponse::json(200, json!({ "locks": found }))
        }
        "POST /locks/verify" => {
            let (ours, theirs): (Vec<Value>, Vec<Value>) = locks.iter().cloned().partition(|lock| lock["owner"]["name"] == ME);
            MockResponse::json(200, json!({ "ours": ours, "theirs": theirs }))
        }
        "POST /locks" => {
            let path = request.json()["path"].as_str().unwrap_or_default().to_string();
            if let Some(existing) = locks.iter().find(|lock| lock["path"] == path.as_str()) {
                return MockResponse::json(409, json!({ "lock": existing, "message": "already created lock" }));
            }
            let lock = json!({ "id": (locks.len() + 100).to_string(), "path": path, "owner": { "name": ME }, "locked_at": LOCKED_AT });
            locks.push(lock.clone());
            MockResponse::json(201, json!({ "lock": lock }))
        }
        other if other.starts_with("POST /locks/") && other.ends_with("/unlock") => {
            let id = other.trim_start_matches("POST /locks/").trim_end_matches("/unlock").to_string();
            let force = request.json()["force"].as_bool().unwrap_or(false);
            let Some(index) = locks.iter().position(|lock| lock["id"] == id.as_str()) else {
                return MockResponse::json(404, json!({ "message": "Not Found" }));
            };
            if locks[index]["owner"]["name"] != ME && !force {
                return MockResponse::json(403, json!({ "message": "You must have admin access to force delete a lock" }));
            }
            let lock = locks.remove(index);
            MockResponse::json(200, json!({ "lock": lock }))
        }
        _ => MockResponse::json(404, json!({ "message": "Not Found" })),
    }
}

/// A repository with one commit whose LFS endpoint is `lfs_url`.
async fn setup(lfs_url: &str) -> (TestCore, TestRepo, String) {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    repo.git(&["config", "lfs.url", lfs_url]);
    let id = tc.open(&repo).await.repo.id;
    (tc, repo, id)
}

async fn lfs_missing(tc: &TestCore, id: &str) -> bool {
    if installed_version(tc, id).await.unwrap().is_some() {
        return false;
    }
    eprintln!("Git LFS is not installed – test skipped.");
    true
}

fn lock(id: &str, path: &str, owner: &str, ours: bool) -> LfsLock {
    LfsLock { id: id.into(), path: path.into(), owner: owner.into(), locked_at: Some(LOCKED_AT.into()), ours }
}

#[tokio::test]
async fn lists_locks_with_owner_time_and_ours() {
    let server = LockServer::start();
    server.seed("bilder/karte.psd", "Lena Berg");
    server.seed("mit leer/Größe.psd", ME);
    let (tc, _repo, id) = setup(&server.url()).await;
    if lfs_missing(&tc, &id).await {
        return;
    }
    let list = lfs_locks(&tc, id.clone(), None, None).await.unwrap();
    assert_eq!(list.locks, vec![lock("1", "bilder/karte.psd", "Lena Berg", false), lock("2", "mit leer/Größe.psd", ME, true)]);
    assert!(list.fetched_at.ends_with('Z'), "{}", list.fetched_at);

    // Filter by path or owner, from the cache: no new request.
    let asked = server.count("POST /locks/verify");
    let filtered = lfs_locks(&tc, id.clone(), Some("  LENA ".into()), None).await.unwrap();
    assert_eq!(filtered.locks.iter().map(|l| l.path.as_str()).collect::<Vec<_>>(), ["bilder/karte.psd"]);
    assert_eq!(lfs_locks(&tc, id.clone(), Some("größe".into()), None).await.unwrap().locks.len(), 1);
    assert_eq!(server.count("POST /locks/verify"), asked, "served from the cache");

    // A manual refresh asks the server again.
    server.seed("neu.bin", "Lena Berg");
    assert_eq!(lfs_locks(&tc, id.clone(), None, None).await.unwrap().locks.len(), 2, "still the cached list");
    assert_eq!(lfs_locks(&tc, id.clone(), None, Some(true)).await.unwrap().locks.len(), 3);
    assert_eq!(server.count("POST /locks/verify"), asked + 1);
}

/// Git LFS reports a failed request in `--json` mode as an empty list – an empty list is
/// therefore confirmed once in the text form.
#[tokio::test]
async fn an_empty_list_is_confirmed_once() {
    let server = LockServer::start();
    let (tc, _repo, id) = setup(&server.url()).await;
    if lfs_missing(&tc, &id).await {
        return;
    }
    assert!(lfs_locks(&tc, id.clone(), None, None).await.unwrap().locks.is_empty());
    assert_eq!(server.count("POST /locks/verify"), 2, "JSON request plus the check in the text form");
}

#[tokio::test]
async fn server_without_locking_api_is_unsupported() {
    let plain = MockServer::start(|_| MockResponse::json(404, json!({ "message": "Not Found" })));
    let (tc, repo, id) = setup(&plain.url()).await;
    if lfs_missing(&tc, &id).await {
        return;
    }
    let error = lfs_locks(&tc, id.clone(), None, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Unsupported, "{error:?}");
    assert!(error.message.contains("file locking"), "{}", error.message);
    // Without a body Git LFS names the status itself.
    for status in [404u16, 501] {
        let bare = MockServer::start(move |_| MockResponse::empty(status));
        repo.git(&["config", "lfs.url", &bare.url()]);
        let error = lfs_locks(&tc, id.clone(), None, Some(true)).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::Unsupported, "{status}: {error:?}");
    }
    repo.git(&["config", "lfs.url", &plain.url()]);
    assert_eq!(lfs_locks(&tc, id.clone(), Some("x".into()), Some(true)).await.unwrap_err().code, ErrorCode::Unsupported);
}

#[tokio::test]
async fn without_git_lfs_locks_are_unsupported() {
    let (tc, _repo, id) = setup("http://127.0.0.1:9/").await;
    tc.state::<LfsState>().set_pretend_missing(true);
    let error = lfs_locks(&tc, id.clone(), None, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Unsupported);
    assert!(error.message.contains("Git LFS is not installed"), "{}", error.message);
    assert_eq!(lfs_locks(&tc, "unbekannt".into(), None, None).await.unwrap_err().code, ErrorCode::NotFound);
}

#[tokio::test]
async fn credentials_in_the_lfs_url_never_reach_the_error() {
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let (tc, _repo, id) = setup(&format!("http://lena:geheim-token-1234@127.0.0.1:{port}/")).await;
    if lfs_missing(&tc, &id).await {
        return;
    }
    let error = lfs_locks(&tc, id.clone(), None, Some(true)).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Offline, "{error:?}");
    let shown = format!("{} {}", error.message, error.git_output.clone().unwrap_or_default());
    assert!(!shown.contains("geheim-token-1234"), "{shown}");
}

#[tokio::test]
async fn lock_and_unlock_own_files() {
    let server = LockServer::start();
    let (tc, _repo, id) = setup(&server.url()).await;
    if lfs_missing(&tc, &id).await {
        return;
    }
    tc.events.clear();
    let paths: Vec<String> = vec!["bilder/karte.psd".into(), "mit leer/Größe.psd".into(), "-strich.psd".into()];
    let outcome = lfs_lock(&tc, id.clone(), paths).await.unwrap();
    assert!(outcome.failed.is_empty(), "{:?}", outcome.failed);
    assert_eq!(server.paths(), ["-strich.psd", "bilder/karte.psd", "mit leer/Größe.psd"]);
    assert_eq!(outcome.locks.locks.len(), 3);
    assert!(outcome.locks.locks.iter().all(|l| l.ours && l.owner == ME), "{:?}", outcome.locks);
    assert!(tc.events.named(names::REPO_CHANGED).iter().any(|e| e["what"] == json!(["locks"])));

    // The cache holds the new state: listing needs no request.
    let asked = server.count("POST /locks/verify");
    assert_eq!(lfs_locks(&tc, id.clone(), None, None).await.unwrap(), outcome.locks);
    assert_eq!(server.count("POST /locks/verify"), asked);

    let outcome = lfs_unlock(&tc, id.clone(), vec!["bilder/karte.psd".into(), "-strich.psd".into()], false).await.unwrap();
    assert!(outcome.failed.is_empty(), "{:?}", outcome.failed);
    assert_eq!(server.paths(), ["mit leer/Größe.psd"]);
    assert_eq!(outcome.locks.locks.iter().map(|l| l.path.as_str()).collect::<Vec<_>>(), ["mit leer/Größe.psd"]);
}

#[tokio::test]
async fn partial_failures_are_reported_per_path() {
    let server = LockServer::start();
    server.seed("plan.psd", "Lena Berg");
    let (tc, _repo, id) = setup(&server.url()).await;
    if lfs_missing(&tc, &id).await {
        return;
    }
    let outcome = lfs_lock(&tc, id.clone(), vec!["plan.psd".into(), "frei.psd".into()]).await.unwrap();
    assert_eq!(outcome.failed, vec![LfsLockFailure { path: "plan.psd".into(), reason: "already created lock".into() }]);
    assert_eq!(server.paths(), ["frei.psd", "plan.psd"]);
    let plan = outcome.locks.locks.iter().find(|l| l.path == "plan.psd").unwrap();
    assert!(!plan.ours && plan.owner == "Lena Berg", "{plan:?}");
}

#[tokio::test]
async fn other_peoples_locks_need_force() {
    let server = LockServer::start();
    server.seed("plan.psd", "Lena Berg");
    let (tc, _repo, id) = setup(&server.url()).await;
    if lfs_missing(&tc, &id).await {
        return;
    }
    let outcome = lfs_unlock(&tc, id.clone(), vec!["plan.psd".into()], false).await.unwrap();
    assert_eq!(outcome.failed.len(), 1);
    assert!(outcome.failed[0].reason.contains("admin access"), "{:?}", outcome.failed);
    assert_eq!(server.paths(), ["plan.psd"]);

    let outcome = lfs_unlock(&tc, id.clone(), vec!["plan.psd".into()], true).await.unwrap();
    assert!(outcome.failed.is_empty(), "{:?}", outcome.failed);
    assert!(server.paths().is_empty());
    assert!(outcome.locks.locks.is_empty());
}

/// Git LFS refuses to unlock a file with uncommitted changes – also an own lock – unless forced.
#[tokio::test]
async fn own_lock_on_a_changed_file_needs_force() {
    let server = LockServer::start();
    let (tc, repo, id) = setup(&server.url()).await;
    if lfs_missing(&tc, &id).await {
        return;
    }
    repo.commit_file("plan.psd", "Fassung 1\n", "Plan angelegt");
    lfs_lock(&tc, id.clone(), vec!["plan.psd".into()]).await.unwrap();
    repo.write_file("plan.psd", "Fassung 2\n");
    let outcome = lfs_unlock(&tc, id.clone(), vec!["plan.psd".into()], false).await.unwrap();
    assert!(outcome.failed[0].reason.contains("uncommitted changes"), "{:?}", outcome.failed);
    assert_eq!(server.paths(), ["plan.psd"]);
    assert!(lfs_unlock(&tc, id.clone(), vec!["plan.psd".into()], true).await.unwrap().failed.is_empty());
    assert!(server.paths().is_empty());
}

#[tokio::test]
async fn locking_on_a_server_without_locking_is_unsupported() {
    let plain = MockServer::start(|_| MockResponse::json(404, json!({ "message": "Not Found" })));
    let (tc, _repo, id) = setup(&plain.url()).await;
    if lfs_missing(&tc, &id).await {
        return;
    }
    let error = lfs_lock(&tc, id.clone(), vec!["plan.psd".into(), "karte.psd".into()]).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Unsupported, "{error:?}");
    let error = lfs_unlock(&tc, id.clone(), vec!["plan.psd".into()], false).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Unsupported, "{error:?}");
}

#[tokio::test]
async fn lock_errors_keep_credentials_out() {
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let (tc, _repo, id) = setup(&format!("http://lena:geheim-token-1234@127.0.0.1:{port}/")).await;
    if lfs_missing(&tc, &id).await {
        return;
    }
    let error = lfs_lock(&tc, id.clone(), vec!["plan.psd".into()]).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Offline, "{error:?}");
    let shown = format!("{} {}", error.message, error.git_output.clone().unwrap_or_default());
    assert!(!shown.contains("geheim-token-1234"), "{shown}");
}

/// Paths are checked before Git runs – also without Git LFS.
#[tokio::test]
async fn invalid_paths_are_rejected_before_git_runs() {
    let (tc, _repo, id) = setup("http://127.0.0.1:9/").await;
    tc.state::<LfsState>().set_pretend_missing(true);
    let too_many: Vec<String> = (0..201).map(|i| format!("f{i}.psd")).collect();
    for paths in [vec![], vec!["../aussen.psd".to_string()], vec!["/etc/passwd".to_string()], vec!["a\0b".to_string()], vec![String::new()], too_many] {
        assert_eq!(lfs_lock(&tc, id.clone(), paths.clone()).await.unwrap_err().code, ErrorCode::NotAllowed, "{paths:?}");
        assert_eq!(lfs_unlock(&tc, id.clone(), paths.clone(), true).await.unwrap_err().code, ErrorCode::NotAllowed, "{paths:?}");
    }
    // Valid paths without Git LFS: unsupported.
    assert_eq!(lfs_lock(&tc, id.clone(), vec!["a.psd".into()]).await.unwrap_err().code, ErrorCode::Unsupported);
    assert_eq!(lfs_unlock(&tc, id.clone(), vec!["a.psd".into()], false).await.unwrap_err().code, ErrorCode::Unsupported);
}

fn locks_reported(tc: &TestCore) -> bool {
    tc.events.named(names::REPO_CHANGED).iter().any(|e| e["what"] == json!(["locks"]))
}

#[tokio::test]
async fn a_fetch_refreshes_cached_locks() {
    let server = LockServer::start();
    server.seed("plan.psd", "Lena Berg");
    let (tc, repo, id) = setup(&server.url()).await;
    if lfs_missing(&tc, &id).await {
        return;
    }
    let _remote = repo.add_remote();
    assert_eq!(lfs_locks(&tc, id.clone(), None, None).await.unwrap().locks.len(), 1);

    // Manual fetch (no new commits – the locks are refreshed anyway).
    server.seed("karte.psd", "Lena Berg");
    tc.events.clear();
    crate::commands::sync::fetch(&tc, id.clone(), "job-fetch".into(), None, false).await.unwrap();
    assert!(locks_reported(&tc), "{:?}", tc.events.named(names::REPO_CHANGED));
    assert_eq!(lfs_locks(&tc, id.clone(), None, None).await.unwrap().locks.len(), 2);

    // Pull.
    server.seed("drei.psd", "Lena Berg");
    tc.events.clear();
    crate::commands::sync::pull(&tc, id.clone(), "job-pull".into(), None).await.unwrap();
    assert!(locks_reported(&tc));
    assert_eq!(lfs_locks(&tc, id.clone(), None, None).await.unwrap().locks.len(), 3);

    // Auto-fetch.
    server.seed("vier.psd", "Lena Berg");
    tc.events.clear();
    let outcome = crate::autofetch::run_once(&tc, &id).await;
    assert!(matches!(outcome, crate::autofetch::FetchOutcome::Fetched { .. }), "{outcome:?}");
    assert!(locks_reported(&tc));
    assert_eq!(lfs_locks(&tc, id.clone(), None, None).await.unwrap().locks.len(), 4);
}

/// Repositories whose locks nobody has looked at: a fetch leaves the LFS server alone.
#[tokio::test]
async fn fetch_without_cached_locks_stays_quiet() {
    let server = LockServer::start();
    let (tc, repo, id) = setup(&server.url()).await;
    let _remote = repo.add_remote();
    tc.events.clear();
    crate::commands::sync::fetch(&tc, id.clone(), "job-fetch".into(), None, false).await.unwrap();
    crate::autofetch::run_once(&tc, &id).await;
    assert!(!locks_reported(&tc), "{:?}", tc.events.named(names::REPO_CHANGED));
    assert!(server.server.requests().is_empty(), "no request to the LFS server");
}
