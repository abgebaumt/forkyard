//! A GitHub-shaped stand-in for the review-fix tests (8.2): pull request #7 whose head is a real local
//! commit and review threads given by the test, at a self-hosted address on 127.0.0.1. Nothing leaves
//! this computer.

use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{json, Value};

use crate::model::HostKind;
use crate::testkit::{MockRequest, MockResponse, MockServer, TestCore, TestRepo};

/// Made up – it only looks like a token.
pub(crate) const TOKEN: &str = "ghp_ErfundenFuerReviewFixes0123456789ab";
pub(crate) const BRANCH: &str = "feature/anmeldung";
pub(crate) const FILE: &str = "src/anmeldung.rs";
pub(crate) const MAIN_FILE: &str = "pub fn anmelden(name: &str, passwort: &str) -> bool {\n    let name = name.trim();\n    if name.is_empty() {\n        return false;\n    }\n    pruefen(name, passwort)\n}\n";
pub(crate) const P1_FILE: &str = "pub fn anmelden(name: &str, passwort: &str) -> bool {\n    let name = name.trim();\n    if name.is_empty() || passwort.len() < 4 {\n        return false; // zu kurz\n    }\n    pruefen(name, passwort)\n}\n";
pub(crate) const P1_SUBJECT: &str = "Anmeldung: kurze Passwörter ablehnen";
pub(crate) const P2_SUBJECT: &str = "Hinweis zur Anmeldung";
/// The replacement for lines 3–4 of `P1_FILE` the tests let the AI suggest.
pub(crate) const FIX: &str = "    if name.is_empty() || passwort.is_empty() || passwort.len() < 4 {\n        return false; // leer oder zu kurz";
/// `P1_FILE` with `FIX` in lines 3–4.
pub(crate) const FIXED_FILE: &str = "pub fn anmelden(name: &str, passwort: &str) -> bool {\n    let name = name.trim();\n    if name.is_empty() || passwort.is_empty() || passwort.len() < 4 {\n        return false; // leer oder zu kurz\n    }\n    pruefen(name, passwort)\n}\n";

/// What the stand-in answers; a test may change it.
pub(crate) struct PrState {
    pub head: String,
    pub target: String,
    pub threads: Vec<Value>,
}

pub(crate) struct PrRepo {
    pub tc: TestCore,
    pub repo: TestRepo,
    pub id: String,
    /// Only held so the stand-in keeps answering until the test ends.
    pub _server: MockServer,
    pub state: Arc<Mutex<PrState>>,
    pub main: String,
    pub p1: String,
    pub p2: String,
}

/// A `PullRequestReviewThread` as GitHub's GraphQL returns it, with one comment `id` by mira.
pub(crate) fn thread(id: u64, path: &str, start: Option<u32>, line: Option<u32>, outdated: bool, body: &str) -> Value {
    json!({ "isResolved": false, "isOutdated": outdated, "path": path, "line": line, "startLine": start, "originalLine": line.unwrap_or(1), "originalStartLine": start, "diffSide": "RIGHT",
        "comments": { "nodes": [{ "databaseId": id, "author": { "login": "mira", "avatarUrl": Value::Null }, "body": body, "createdAt": "2026-09-02T09:30:00Z", "originalCommit": { "oid": Value::Null } }] } })
}

fn answer(request: &MockRequest, state: &PrState) -> MockResponse {
    let route = request.route();
    let pr = json!({ "number": 7, "title": "Anmeldung prüft Passwörter", "state": "open", "draft": false, "user": { "login": "jonas" }, "body": "",
        "head": { "ref": BRANCH, "sha": state.head, "repo": { "full_name": "octo/demo" } }, "base": { "ref": state.target, "sha": "", "repo": { "full_name": "octo/demo" } },
        "updated_at": "2026-09-02T10:00:00Z", "html_url": "http://127.0.0.1/octo/demo/pull/7", "labels": [], "requested_reviewers": [], "mergeable": true });
    match route.as_str() {
        "GET /api/v3/user" => MockResponse::json(200, json!({ "login": "lena", "name": "Lena" })),
        "GET /api/v3/repos/octo/demo/pulls/7" => MockResponse::json(200, pr),
        "GET /api/v3/repos/octo/demo/pulls/7/reviews" | "GET /api/v3/repos/octo/demo/pulls/7/comments" | "GET /api/v3/repos/octo/demo/issues/7/comments" | "GET /api/v3/repos/octo/demo/pulls/7/commits" => {
            MockResponse::json(200, json!([]))
        }
        "POST /api/graphql" => MockResponse::json(
            200,
            json!({ "data": { "repository": { "pullRequest": { "reviewThreads": { "pageInfo": { "hasNextPage": false, "endCursor": Value::Null }, "nodes": state.threads } } } } }),
        ),
        _ if route.ends_with("/check-runs") => MockResponse::json(200, json!({ "total_count": 0, "check_runs": [] })),
        _ if route.ends_with("/status") => MockResponse::json(200, json!({ "state": "pending", "statuses": [] })),
        _ => MockResponse::json(404, json!({ "message": "Not Found" })),
    }
}

/// `main` with README.md and `src/anmeldung.rs`; `feature/anmeldung` with P1 (changes lines 3–4 of
/// `src/anmeldung.rs`) and P2 (adds `docs/hinweis.md` and a `.env`), checked out. `origin` points at the
/// stand-in, `refs/remotes/origin/main` at `main` – as after a fetch; the GitHub account is connected.
pub(crate) async fn pr_repo(threads: Vec<Value>) -> PrRepo {
    let repo = TestRepo::with_commit();
    repo.write_file(FILE, MAIN_FILE);
    let main = repo.commit("Anmeldung angelegt");
    repo.checkout_new(BRANCH);
    let p1 = repo.commit_file(FILE, P1_FILE, P1_SUBJECT);
    repo.write_file("docs/hinweis.md", "# Hinweis\n\nPasswörter brauchen vier Zeichen.\n");
    repo.write_file(".env", "API_TOKEN=geheim-0123456789abcdef\n");
    let p2 = repo.commit(P2_SUBJECT);
    let state = Arc::new(Mutex::new(PrState { head: p2.clone(), target: "main".into(), threads }));
    let server = {
        let state = state.clone();
        MockServer::start(move |request| answer(request, &state.lock()))
    };
    repo.git(&["remote", "add", "origin", &format!("{}/octo/demo.git", server.url())]);
    repo.git(&["update-ref", "refs/remotes/origin/main", &main]);
    let tc = TestCore::new().await;
    crate::host::connect(&tc, HostKind::Github, Some(server.url()), TOKEN.to_string()).await.expect("connect the stand-in");
    let id = tc.open(&repo).await.repo.id;
    server.clear();
    PrRepo { tc, repo, id, _server: server, state, main, p1, p2 }
}
