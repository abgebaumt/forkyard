//! The test server's responses, in the shape of the public API documentation of GitHub, GitLab,
//! Gitea/Forgejo, Bitbucket Cloud and Azure DevOps. All names, numbers and texts are made up.
//!
//! The data set: 45 pull requests / merge requests (numbers 1 to 45). Numbers ending in 0
//! are merged; those ending in 5 are closed; the rest are open. No. 3 is a draft,
//! no. 7 comes from the branch `feature/login`, no. 8 from a fork, no. 13 cannot be merged.

use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{json, Value};

use super::{MockState, TOKEN, WEAK_TOKEN};
use crate::testkit::{MockRequest, MockResponse};

const TOTAL: u64 = 45;

fn origin(request: &MockRequest) -> String {
    format!("http://{}", request.header("host").unwrap_or("127.0.0.1"))
}

fn bearer(request: &MockRequest) -> String {
    request.header("authorization").and_then(|value| value.strip_prefix("Bearer ")).unwrap_or_default().to_string()
}

fn not_found(message: &str) -> MockResponse {
    MockResponse::json(404, json!({ "message": message }))
}

fn sha(number: u64) -> String {
    format!("{number:040x}")
}

fn updated(number: u64) -> String {
    format!("2026-09-{:02}T08:{:02}:00Z", 1 + number % 28, number % 60)
}

fn pr_state(number: u64, state: &MockState) -> &'static str {
    if state.merged.contains(&number) || number % 10 == 0 {
        "merged"
    } else if state.closed.contains(&number) || number % 10 == 5 {
        "closed"
    } else {
        "open"
    }
}

fn source_branch(number: u64) -> String {
    match number {
        7 => "feature/login".to_string(),
        8 => "korrektur".to_string(),
        n => format!("feature/thema-{n}"),
    }
}

/// Pages through `numbers` (page size from the parameter `size_key`) and returns the page with
/// the address and number of the next one.
pub(crate) fn page_by(request: &MockRequest, numbers: Vec<u64>, size_key: &str) -> (Vec<u64>, Option<(String, u64)>) {
    let per_page: usize = request.query(size_key).and_then(|v| v.parse().ok()).unwrap_or(30);
    let page: usize = request.query("page").and_then(|v| v.parse().ok()).unwrap_or(1).max(1);
    let start = (page - 1) * per_page;
    let items: Vec<u64> = numbers.iter().copied().skip(start).take(per_page).collect();
    let more = start + per_page < numbers.len();
    let next = more.then(|| {
        let mut query: Vec<String> = request.target.split_once('?').map(|(_, q)| q).unwrap_or("").split('&').filter(|p| !p.is_empty() && !p.starts_with("page=")).map(str::to_string).collect();
        query.push(format!("page={}", page + 1));
        (format!("{}{}?{}", origin(request), request.path(), query.join("&")), page as u64 + 1)
    });
    (items, next)
}

/// Pages through `numbers` and returns the page with a `Link` header for the next one.
fn paginate(request: &MockRequest, numbers: Vec<u64>) -> (Vec<u64>, Option<(String, u64)>) {
    let (items, next) = page_by(request, numbers, "per_page");
    (items, next.map(|(url, page)| (format!("<{url}>; rel=\"next\""), page)))
}

/// Shared error modes; `None` = continue normally.
fn forced(mode: &str, rate: MockResponse) -> Option<MockResponse> {
    match mode {
        "401" => Some(MockResponse::json(401, json!({ "message": format!("Bad credentials (token {TOKEN} was rejected)") }))),
        "rate" => Some(rate),
        "404" => Some(not_found("Not Found")),
        "403" => Some(MockResponse::json(403, json!({ "message": "Resource not accessible by personal access token" }))),
        "broken" => Some(MockResponse::raw(200, "[{\"number\": 1, \"title\": \"abgeschn")),
        "slow" => Some(MockResponse::json(200, json!([])).delay(Duration::from_millis(1200))),
        "500" => Some(MockResponse::json(500, json!({ "message": "Server Error" }))),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

fn gh_user(login: &str) -> Value {
    json!({ "login": login, "id": login.len(), "avatar_url": format!("https://avatars.example/{login}.png"), "type": "User" })
}

fn gh_pr(base: &str, number: u64, state: &MockState) -> Value {
    let status = pr_state(number, state);
    let head_repo = if number == 8 { "fremd/demo" } else { "octo/demo" };
    json!({
        "number": number,
        "title": if number == 1 { "Anmeldung: Fehlermeldung bei leerem Passwort".to_string() } else { format!("Thema {number} umsetzen") },
        "state": if status == "open" { "open" } else { "closed" },
        "merged_at": if status == "merged" { json!("2026-09-20T10:00:00Z") } else { Value::Null },
        "draft": number == 3,
        "user": gh_user("jonas"),
        "body": format!("Beschreibung zu **Thema {number}**.\n\n- [x] Tests"),
        "head": { "ref": source_branch(number), "sha": sha(number), "repo": { "full_name": head_repo } },
        "base": { "ref": "main", "sha": sha(1000), "repo": { "full_name": "octo/demo" } },
        "updated_at": updated(number),
        "html_url": format!("{base}/octo/demo/pull/{number}"),
        "labels": if number == 1 { json!([{ "name": "bug", "color": "D73A4A" }]) } else { json!([]) },
        "requested_reviewers": if number == 2 { json!([gh_user("mira")]) } else { json!([]) },
        "mergeable": if number == 13 { json!(false) } else { json!(true) },
    })
}

fn gh_issue(base: &str, number: u64) -> Value {
    let mut issue = json!({
        "number": number,
        "title": format!("Problem {number}"),
        "state": if number % 4 == 0 { "closed" } else { "open" },
        "user": gh_user("mira"),
        "assignees": if number == 2 { json!([gh_user("lena-hartmann")]) } else { json!([]) },
        "labels": [{ "name": "frage", "color": "0e8a16" }],
        "updated_at": updated(number),
        "html_url": format!("{base}/octo/demo/issues/{number}"),
        "body": format!("Text zu Problem {number}"),
    });
    // GitHub's issue list also contains pull requests; they carry this key.
    if number % 3 == 0 {
        issue["pull_request"] = json!({ "url": format!("{base}/api/v3/repos/octo/demo/pulls/{number}") });
    }
    issue
}

/// GitHub's GraphQL endpoint (`POST /api/graphql`): the review threads of pull request 9, two per page
/// (cursor `seite-<n>`); unknown repositories and pull requests answer with GraphQL errors (status 200).
fn gh_graphql(request: &MockRequest) -> MockResponse {
    let body = request.json();
    let vars = &body["variables"];
    if request.method != "POST" || !body["query"].as_str().unwrap_or("").contains("reviewThreads") || vars["owner"] != "octo" || vars["name"] != "demo" {
        return MockResponse::json(200, json!({ "data": Value::Null, "errors": [{ "type": "NOT_FOUND", "message": "Could not resolve to a Repository with the name 'demo'." }] }));
    }
    let number = vars["number"].as_u64().unwrap_or(0);
    if number == 0 || number > 200 {
        return MockResponse::json(
            200,
            json!({ "data": { "repository": { "pullRequest": Value::Null } }, "errors": [{ "type": "NOT_FOUND", "path": ["repository", "pullRequest"], "message": format!("Could not resolve to a PullRequest with the number of {number}.") }] }),
        );
    }
    let comment = |id: u64, login: &str, body: &str, at: &str| {
        json!({ "databaseId": id, "author": { "login": login, "avatarUrl": format!("https://avatars.example/{login}.png") }, "body": body, "createdAt": at, "originalCommit": { "oid": sha(9) } })
    };
    let threads: Vec<Value> = if number == 9 {
        vec![
            json!({ "isResolved": false, "isOutdated": false, "path": "src/anmeldung.rs", "line": 42, "startLine": 40, "originalLine": 42, "originalStartLine": 40, "diffSide": "RIGHT",
                "comments": { "nodes": [comment(9001, "mira", "Hier fehlt die Prüfung auf leer.", "2026-09-02T09:30:00Z"), comment(9002, "jonas", "Stimmt, mache ich.", "2026-09-02T10:00:00Z")] } }),
            json!({ "isResolved": true, "isOutdated": false, "path": "src/meldung.rs", "line": 7, "startLine": Value::Null, "originalLine": 7, "originalStartLine": Value::Null, "diffSide": "RIGHT",
                "comments": { "nodes": [comment(9011, "mira", "Tippfehler: „Fehler“.", "2026-09-02T09:40:00Z")] } }),
            json!({ "isResolved": false, "isOutdated": true, "path": "src/alt.rs", "line": Value::Null, "startLine": Value::Null, "originalLine": 12, "originalStartLine": Value::Null, "diffSide": "RIGHT",
                "comments": { "nodes": [comment(9021, "mira", "Diese Zeile gibt es so nicht mehr.", "2026-09-02T09:50:00Z")] } }),
        ]
    } else {
        Vec::new()
    };
    let after: usize = vars["after"].as_str().and_then(|cursor| cursor.strip_prefix("seite-")).and_then(|n| n.parse().ok()).unwrap_or(0);
    let page: Vec<Value> = threads.iter().skip(after).take(2).cloned().collect();
    let more = after + 2 < threads.len();
    let cursor = if more { json!(format!("seite-{}", after + 2)) } else { Value::Null };
    MockResponse::json(200, json!({ "data": { "repository": { "pullRequest": { "reviewThreads": { "pageInfo": { "hasNextPage": more, "endCursor": cursor }, "nodes": page } } } } }))
}

pub(crate) fn github(request: &MockRequest, state: &Mutex<MockState>) -> MockResponse {
    let base = origin(request);
    let token = bearer(request);
    if token != TOKEN && token != WEAK_TOKEN {
        return MockResponse::json(401, json!({ "message": "Bad credentials", "documentation_url": "https://docs.github.com/rest" }));
    }
    let mut state = state.lock();
    let path = request.path().strip_prefix("/api/v3").unwrap_or("").to_string();
    let method = request.method.as_str();
    if path == "/user" && state.mode != "401" && state.mode != "slow" {
        let scopes = if token == WEAK_TOKEN { "gist, read:org" } else { "repo, read:org" };
        return MockResponse::json(200, json!({ "login": "lena-hartmann", "name": "Lena Hartmann", "avatar_url": "https://avatars.example/lena-hartmann.png" })).header("x-oauth-scopes", scopes);
    }
    let rate = MockResponse::json(403, json!({ "message": "API rate limit exceeded for user ID 1." })).header("x-ratelimit-remaining", "0").header("x-ratelimit-reset", "1791720000");
    if let Some(response) = forced(state.mode, rate) {
        return response;
    }
    if request.path() == "/api/graphql" {
        return gh_graphql(request);
    }
    if path == "/search/issues" {
        let q = request.query("q").unwrap_or_default();
        let items: Vec<Value> = [1u64, 2].iter().map(|n| gh_issue(&base, *n)).collect();
        return MockResponse::json(200, json!({ "total_count": items.len(), "incomplete_results": false, "items": items, "q": q }));
    }
    let Some(rest) = path.strip_prefix("/repos/octo/demo") else {
        return not_found("Not Found");
    };
    let segments: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
    let number = segments.get(1).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
    match (method, segments.as_slice()) {
        ("GET", []) => MockResponse::json(
            200,
            json!({
                "name": "demo", "full_name": "octo/demo", "default_branch": "main", "html_url": format!("{base}/octo/demo"),
                "permissions": { "admin": false, "push": true, "pull": true },
                "fork": true,
                "parent": { "name": "demo", "owner": { "login": "ursprung" }, "html_url": format!("{base}/ursprung/demo") },
            }),
        ),
        ("GET", ["pulls"]) => {
            let wanted = request.query("state").unwrap_or_else(|| "open".into());
            let numbers: Vec<u64> = (1..=TOTAL)
                .rev()
                .filter(|n| match wanted.as_str() {
                    "open" => pr_state(*n, &state) == "open",
                    "closed" => pr_state(*n, &state) != "open",
                    _ => true,
                })
                .collect();
            let (page, next) = paginate(request, numbers);
            let body: Vec<Value> = page.iter().map(|n| gh_pr(&base, *n, &state)).collect();
            let response = MockResponse::json(200, json!(body));
            match next {
                Some((link, _)) => response.header("link", link),
                None => response,
            }
        }
        ("POST", ["releases"]) => {
            let body = request.json();
            if body["tag_name"] == "schon-da" {
                return MockResponse::json(422, json!({ "message": "Validation Failed", "errors": [{ "resource": "Release", "code": "already_exists", "field": "tag_name" }] }));
            }
            let tag = body["tag_name"].as_str().unwrap_or_default().to_string();
            MockResponse::json(201, json!({ "id": 7001, "tag_name": tag, "name": body["name"], "body": body["body"], "draft": false, "prerelease": body["prerelease"], "html_url": format!("{base}/octo/demo/releases/tag/{tag}") }))
        }
        ("POST", ["pulls"]) => {
            let body = request.json();
            if body["head"] == "schon-da" {
                return MockResponse::json(422, json!({ "message": "Validation Failed", "errors": [{ "resource": "PullRequest", "code": "custom", "message": "A pull request already exists for octo:schon-da." }] }));
            }
            let mut created = gh_pr(&base, 101, &state);
            created["title"] = body["title"].clone();
            created["body"] = body["body"].clone();
            created["draft"] = body["draft"].clone();
            created["head"]["ref"] = body["head"].clone();
            created["base"]["ref"] = body["base"].clone();
            MockResponse::json(201, created)
        }
        ("GET", ["pulls", _]) if number == 0 || number > 200 => not_found("Not Found"),
        ("GET", ["pulls", _]) => MockResponse::json(200, gh_pr(&base, number, &state)),
        ("PATCH", ["pulls", _]) => {
            let body = request.json();
            match body["state"].as_str() {
                Some("closed") => state.closed.push(number),
                Some("open") => state.closed.retain(|n| *n != number),
                _ => {}
            }
            let mut pr = gh_pr(&base, number, &state);
            for key in ["title", "body"] {
                if !body[key].is_null() {
                    pr[key] = body[key].clone();
                }
            }
            if !body["base"].is_null() {
                pr["base"]["ref"] = body["base"].clone();
            }
            MockResponse::json(200, pr)
        }
        ("GET", ["pulls", _, "reviews"]) => MockResponse::json(
            200,
            match number {
                1 => json!([
                    { "id": 11, "user": gh_user("mira"), "state": "COMMENTED", "body": "Erster Blick: sieht gut aus.", "submitted_at": "2026-09-02T09:00:00Z" },
                    { "id": 12, "user": gh_user("mira"), "state": "APPROVED", "body": "", "submitted_at": "2026-09-02T10:00:00Z" }
                ]),
                4 => json!([{ "id": 41, "user": gh_user("jonas"), "state": "CHANGES_REQUESTED", "body": "Bitte die Tests ergänzen.", "submitted_at": "2026-09-03T10:00:00Z" }]),
                _ => json!([]),
            },
        ),
        ("GET", ["pulls", _, "comments"]) => MockResponse::json(
            200,
            if number == 1 {
                json!([{ "id": 31, "user": gh_user("mira"), "body": "Hier fehlt die Prüfung auf leer.", "created_at": "2026-09-02T09:30:00Z", "path": "src/anmeldung.rs", "line": 42 }])
            } else {
                json!([])
            },
        ),
        ("GET", ["pulls", _, "commits"]) => MockResponse::json(
            200,
            json!([
                { "sha": sha(number * 100 + 1), "commit": { "message": "Prüfung ergänzt\n\nLängere Erklärung.", "author": { "name": "Jonas Weber", "date": "2026-09-01T12:00:00Z" } } },
                { "sha": sha(number), "commit": { "message": "Meldung übersetzt", "author": { "name": "Jonas Weber", "date": "2026-09-01T13:00:00Z" } } }
            ]),
        ),
        ("POST", ["pulls", _, "comments", id, "replies"]) if *id == "9001" => MockResponse::json(
            201,
            json!({ "id": 9003, "user": gh_user("lena-hartmann"), "body": request.json()["body"], "created_at": "2026-09-05T08:00:00Z", "path": "src/anmeldung.rs", "line": 42, "in_reply_to_id": 9001 }),
        ),
        ("POST", ["pulls", _, "comments", _, "replies"]) => not_found("Not Found"),
        ("POST" | "DELETE", ["pulls", _, "requested_reviewers"]) => MockResponse::json(if method == "POST" { 201 } else { 200 }, gh_pr(&base, number, &state)),
        ("PUT", ["pulls", _, "merge"]) => {
            if number == 13 {
                return MockResponse::json(405, json!({ "message": "Pull Request is not mergeable" }));
            }
            state.merged.push(number);
            MockResponse::json(200, json!({ "sha": sha(number + 5000), "merged": true, "message": "Pull Request successfully merged" }))
        }
        ("GET", ["commits", sha_text, "check-runs"]) => {
            let runs = match u64::from_str_radix(sha_text, 16).unwrap_or(0) {
                1 => json!([
                    { "name": "build", "status": "completed", "conclusion": "success", "html_url": format!("{base}/octo/demo/runs/1") },
                    { "name": "docs", "status": "completed", "conclusion": "skipped", "html_url": Value::Null, "details_url": "https://ci.example/docs" }
                ]),
                2 => json!([{ "name": "build", "status": "in_progress", "conclusion": Value::Null, "html_url": format!("{base}/octo/demo/runs/2") }]),
                4 => json!([{ "name": "build", "status": "completed", "conclusion": "failure", "html_url": format!("{base}/octo/demo/runs/4") }]),
                _ => json!([]),
            };
            MockResponse::json(200, json!({ "total_count": runs.as_array().map(Vec::len).unwrap_or(0), "check_runs": runs }))
        }
        ("GET", ["commits", sha_text, "status"]) => {
            let statuses = if u64::from_str_radix(sha_text, 16).unwrap_or(0) == 1 { json!([{ "context": "lizenz/cla", "state": "success", "target_url": "https://cla.example/1" }]) } else { json!([]) };
            MockResponse::json(200, json!({ "state": "pending", "statuses": statuses }))
        }
        ("GET", ["issues"]) => {
            let wanted = request.query("state").unwrap_or_else(|| "open".into());
            let numbers: Vec<u64> = (1..=12).rev().filter(|n| wanted == "all" || (wanted == "closed") == (n % 4 == 0)).collect();
            let (page, next) = paginate(request, numbers);
            let body: Vec<Value> = page.iter().map(|n| gh_issue(&base, *n)).collect();
            let response = MockResponse::json(200, json!(body));
            match next {
                Some((link, _)) => response.header("link", link),
                None => response,
            }
        }
        ("GET", ["issues", _]) if number == 0 || number > 200 => not_found("Not Found"),
        ("GET", ["issues", _]) => MockResponse::json(200, gh_issue(&base, number)),
        ("GET", ["issues", _, "comments"]) => MockResponse::json(200, json!([{ "id": 21, "user": gh_user("jonas"), "body": "Danke fürs Ansehen!", "created_at": "2026-09-02T09:45:00Z" }])),
        ("POST", ["issues", _, "comments"]) => MockResponse::json(201, json!({ "id": 99, "user": gh_user("lena-hartmann"), "body": request.json()["body"], "created_at": "2026-09-05T08:00:00Z" })),
        ("POST" | "PUT", ["issues", _, "labels"]) => MockResponse::json(200, json!([])),
        ("DELETE", ["git", "refs", "heads", ..]) => MockResponse::empty(204),
        _ => not_found("Not Found"),
    }
}

// ---------------------------------------------------------------------------
// GitLab
// ---------------------------------------------------------------------------

const PROJECT: &str = "/projects/gruppe%2Funter%2Fdemo";

fn gl_user(username: &str) -> Value {
    json!({ "id": 40 + username.len(), "username": username, "name": format!("{} (Name)", username), "avatar_url": format!("https://avatars.example/{username}.png"), "state": "active" })
}

fn gl_mr(base: &str, number: u64, state: &MockState, single: bool) -> Value {
    let status = match pr_state(number, state) {
        "open" => "opened",
        other => other,
    };
    let pipeline = match number {
        1 => Some("success"),
        2 => Some("running"),
        4 => Some("failed"),
        _ => None,
    };
    let mut mr = json!({
        "iid": number,
        "id": 9000 + number,
        "title": if number == 3 { "Draft: Thema 3 umsetzen".to_string() } else { format!("Thema {number} umsetzen") },
        "description": format!("Beschreibung zu **Thema {number}**."),
        "state": status,
        "draft": number == 3,
        "work_in_progress": number == 3,
        "author": gl_user("jonas"),
        "source_branch": source_branch(number),
        "target_branch": "main",
        "source_project_id": if number == 8 { 99 } else { 7 },
        "target_project_id": 7,
        "updated_at": updated(number),
        "web_url": format!("{base}/gruppe/unter/demo/-/merge_requests/{number}"),
        "labels": if number == 1 { json!(["bug"]) } else { json!([]) },
        "reviewers": if number == 2 { json!([gl_user("mira")]) } else { json!([]) },
        "sha": sha(number),
        "detailed_merge_status": if number == 13 { "conflict" } else { "mergeable" },
    });
    if single {
        mr["head_pipeline"] = match pipeline {
            Some(status) => json!({ "id": 500 + number, "project_id": 7, "status": status, "web_url": format!("{base}/gruppe/unter/demo/-/pipelines/{}", 500 + number) }),
            None => Value::Null,
        };
    }
    mr
}

fn gl_issue(base: &str, number: u64) -> Value {
    json!({
        "iid": number,
        "title": format!("Problem {number}"),
        "state": if number % 4 == 0 { "closed" } else { "opened" },
        "author": gl_user("mira"),
        "assignees": if number == 2 { json!([gl_user("lena.hartmann")]) } else { json!([]) },
        "labels": ["frage"],
        "updated_at": updated(number),
        "web_url": format!("{base}/gruppe/unter/demo/-/issues/{number}"),
        "description": format!("Text zu Problem {number}"),
    })
}

fn gl_page(request: &MockRequest, body: Vec<Value>, next: Option<(String, u64)>) -> MockResponse {
    let response = MockResponse::json(200, json!(body));
    match next {
        Some((link, page)) => response.header("link", link).header("x-next-page", page.to_string()),
        None => response.header("x-next-page", ""),
    }
    .header("x-page", request.query("page").unwrap_or_else(|| "1".into()))
}

pub(crate) fn gitlab(request: &MockRequest, state: &Mutex<MockState>) -> MockResponse {
    let base = origin(request);
    let token = bearer(request);
    if token != TOKEN && token != WEAK_TOKEN {
        return MockResponse::json(401, json!({ "message": "401 Unauthorized" }));
    }
    let mut state = state.lock();
    let path = request.path().strip_prefix("/api/v4").unwrap_or("").to_string();
    let method = request.method.as_str();
    if state.mode != "401" && state.mode != "slow" {
        match path.as_str() {
            "/user" => return MockResponse::json(200, json!({ "id": 1, "username": "lena.hartmann", "name": "Lena Hartmann", "avatar_url": "https://avatars.example/lena.png" })),
            "/personal_access_tokens/self" => {
                let scopes = if token == WEAK_TOKEN { json!(["read_api"]) } else { json!(["api", "read_user"]) };
                return MockResponse::json(200, json!({ "id": 3, "name": "forkyard", "scopes": scopes, "active": true }));
            }
            _ => {}
        }
    }
    // When the limit is reached, GitLab responds with 429 and plain text.
    let rate = MockResponse::raw(429, "Retry later").header("retry-after", "30").header("ratelimit-remaining", "0").header("ratelimit-reset", "1791720000");
    if let Some(response) = forced(state.mode, rate) {
        return response;
    }
    if path == "/users" {
        return MockResponse::json(200, if request.query("username").as_deref() == Some("mira") { json!([gl_user("mira")]) } else { json!([]) });
    }
    if path == "/projects/7/pipelines/501/jobs" {
        return MockResponse::json(
            200,
            json!([
                { "id": 1, "name": "build", "status": "success", "web_url": format!("{base}/gruppe/unter/demo/-/jobs/1") },
                { "id": 2, "name": "lint", "status": "skipped", "web_url": format!("{base}/gruppe/unter/demo/-/jobs/2") }
            ]),
        );
    }
    let Some(rest) = path.strip_prefix(PROJECT) else {
        return not_found("404 Project Not Found");
    };
    let segments: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
    let number = segments.get(1).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
    match (method, segments.as_slice()) {
        ("GET", []) => MockResponse::json(
            200,
            json!({
                "id": 7, "path_with_namespace": "gruppe/unter/demo", "default_branch": "main", "web_url": format!("{base}/gruppe/unter/demo"),
                "permissions": { "project_access": { "access_level": 40 }, "group_access": Value::Null },
                "forked_from_project": { "id": 3, "path_with_namespace": "quelle/gruppe/demo", "web_url": format!("{base}/quelle/gruppe/demo") },
            }),
        ),
        ("GET", ["merge_requests"]) => {
            let wanted = request.query("state").unwrap_or_else(|| "all".into());
            let numbers: Vec<u64> = (1..=TOTAL)
                .rev()
                .filter(|n| {
                    let status = pr_state(*n, &state);
                    wanted == "all" || wanted == status || (wanted == "opened" && status == "open")
                })
                .collect();
            let (page, next) = paginate(request, numbers);
            let body: Vec<Value> = page.iter().map(|n| gl_mr(&base, *n, &state, false)).collect();
            gl_page(request, body, next)
        }
        ("POST", ["releases"]) => {
            let body = request.json();
            if body["tag_name"] == "schon-da" {
                return MockResponse::json(409, json!({ "message": "Release already exists" }));
            }
            let tag = body["tag_name"].as_str().unwrap_or_default().to_string();
            MockResponse::json(201, json!({ "tag_name": tag, "name": body["name"], "description": body["description"], "_links": { "self": format!("{base}/gruppe/unter/demo/-/releases/{tag}") } }))
        }
        ("POST", ["merge_requests"]) => {
            let body = request.json();
            if body["source_branch"] == "schon-da" {
                return MockResponse::json(409, json!({ "message": ["Another open merge request already exists for this source branch: !5"] }));
            }
            let mut created = gl_mr(&base, 101, &state, true);
            created["title"] = body["title"].clone();
            created["draft"] = json!(body["title"].as_str().unwrap_or("").starts_with("Draft:"));
            created["description"] = body["description"].clone();
            created["source_branch"] = body["source_branch"].clone();
            created["target_branch"] = body["target_branch"].clone();
            MockResponse::json(201, created)
        }
        ("GET", ["merge_requests", _]) if number == 0 || number > 200 => not_found("404 Not found"),
        ("GET", ["merge_requests", _]) => MockResponse::json(200, gl_mr(&base, number, &state, true)),
        ("PUT", ["merge_requests", _]) => {
            let body = request.json();
            match body["state_event"].as_str() {
                Some("close") => state.closed.push(number),
                Some("reopen") => state.closed.retain(|n| *n != number),
                _ => {}
            }
            let mut mr = gl_mr(&base, number, &state, true);
            if let Some(title) = body["title"].as_str() {
                mr["title"] = json!(title);
                mr["draft"] = json!(title.starts_with("Draft:"));
                mr["work_in_progress"] = mr["draft"].clone();
            }
            if !body["target_branch"].is_null() {
                mr["target_branch"] = body["target_branch"].clone();
            }
            MockResponse::json(200, mr)
        }
        ("PUT", ["merge_requests", _, "merge"]) => {
            if number == 13 {
                return MockResponse::json(405, json!({ "message": "405 Method Not Allowed" }));
            }
            state.merged.push(number);
            MockResponse::json(200, gl_mr(&base, number, &state, true))
        }
        ("GET", ["merge_requests", _, "approvals"]) => MockResponse::json(
            200,
            if number == 1 { json!({ "approved": true, "approvals_left": 0, "approved_by": [{ "user": gl_user("mira") }] }) } else { json!({ "approved": false, "approvals_left": 0, "approved_by": [] }) },
        ),
        ("GET", ["merge_requests" | "issues", _, "notes"]) => gl_page(
            request,
            vec![
                json!({ "id": 1, "system": true, "body": "changed title from A to B", "author": gl_user("jonas"), "created_at": "2026-09-02T08:00:00Z" }),
                json!({ "id": 2, "system": false, "body": "Sieht gut aus.", "author": gl_user("mira"), "created_at": "2026-09-02T09:00:00Z" }),
                json!({ "id": 3, "system": false, "body": "Hier bitte prüfen.", "author": gl_user("mira"), "created_at": "2026-09-02T09:30:00Z", "position": { "new_path": "src/anmeldung.rs", "new_line": 42, "old_path": "src/anmeldung.rs", "old_line": Value::Null } }),
            ],
            None,
        ),
        ("POST", ["merge_requests", _, "notes"]) => MockResponse::json(201, json!({ "id": 99, "system": false, "body": request.json()["body"], "author": gl_user("lena.hartmann"), "created_at": "2026-09-05T08:00:00Z" })),
        ("GET", ["merge_requests", _, "discussions"]) if state.no_review_threads => not_found("404 Not Found"),
        ("GET", ["merge_requests", _, "discussions"]) if number == 0 || number > 200 => not_found("404 Not found"),
        ("GET", ["merge_requests", _, "discussions"]) => {
            let position = |path: &str, old: Option<u64>, new: Option<u64>, start: Option<u64>| {
                json!({ "base_sha": sha(1000), "start_sha": sha(1000), "head_sha": sha(9), "position_type": "text", "old_path": path, "new_path": path, "old_line": old, "new_line": new,
                    "line_range": start.map(|s| json!({ "start": { "line_code": format!("x_{s}"), "type": "new", "old_line": Value::Null, "new_line": s }, "end": { "line_code": "x_end", "type": "new", "old_line": Value::Null, "new_line": new } })) })
            };
            let diff_note = |id: u64, who: &str, body: &str, at: &str, resolved: bool, pos: Value| {
                json!({ "id": id, "type": "DiffNote", "body": body, "author": gl_user(who), "created_at": at, "system": false, "resolvable": true, "resolved": resolved, "position": pos })
            };
            let body = if number == 9 {
                vec![
                    json!({ "id": "6a9c1750b37d513a43987b574953fceb50b03ce7", "individual_note": false, "notes": [
                        diff_note(901, "mira", "Hier fehlt die Prüfung auf leer.", "2026-09-02T09:30:00Z", false, position("src/anmeldung.rs", None, Some(42), Some(40))),
                        diff_note(902, "jonas", "Stimmt, mache ich.", "2026-09-02T10:00:00Z", false, position("src/anmeldung.rs", None, Some(42), Some(40))),
                    ] }),
                    json!({ "id": "2b7e0c11d0aa6e4c3f9a59a2b1e5c7d8e9f01234", "individual_note": false, "notes": [
                        diff_note(911, "mira", "Tippfehler: „Fehler“.", "2026-09-02T09:40:00Z", true, position("src/meldung.rs", None, Some(7), None)),
                    ] }),
                    json!({ "id": "3c8f1d22e1bb7f5d4a0b6ab3c2f6d8e9fa012345", "individual_note": false, "notes": [
                        diff_note(921, "mira", "Diese Zeile gibt es so nicht mehr.", "2026-09-02T09:50:00Z", false, position("src/alt.rs", Some(12), None, None)),
                    ] }),
                    json!({ "id": "4d9a2e33f2cc8a6e5b1c7bc4d3a7e9f0ab123456", "individual_note": true, "notes": [
                        { "id": 931, "type": Value::Null, "body": "Allgemeiner Kommentar", "author": gl_user("mira"), "created_at": "2026-09-02T11:00:00Z", "system": false, "resolvable": false }
                    ] }),
                    json!({ "id": "5e0b3f44a3dd9b7f6c2d8cd5e4b8fa01bc234567", "individual_note": true, "notes": [
                        { "id": 941, "type": Value::Null, "body": "added 1 commit", "author": gl_user("jonas"), "created_at": "2026-09-02T12:00:00Z", "system": true }
                    ] }),
                ]
            } else {
                Vec::new()
            };
            gl_page(request, body, None)
        }
        ("POST", ["merge_requests", _, "discussions", id, "notes"]) if *id == "6a9c1750b37d513a43987b574953fceb50b03ce7" => MockResponse::json(
            201,
            json!({ "id": 903, "type": "DiffNote", "system": false, "body": request.json()["body"], "author": gl_user("lena.hartmann"), "created_at": "2026-09-05T08:00:00Z" }),
        ),
        ("POST", ["merge_requests", _, "discussions", _, "notes"]) => not_found("404 Discussion Not Found"),
        ("GET", ["merge_requests", _, "commits"]) => gl_page(
            request,
            vec![
                json!({ "id": sha(number), "title": "Meldung übersetzt", "author_name": "Jonas Weber", "authored_date": "2026-09-01T13:00:00Z" }),
                json!({ "id": sha(number * 100 + 1), "title": "Prüfung ergänzt", "author_name": "Jonas Weber", "authored_date": "2026-09-01T12:00:00Z" }),
            ],
            None,
        ),
        ("GET", ["issues"]) => {
            let wanted = request.query("state").unwrap_or_else(|| "all".into());
            let search = request.query("search");
            let numbers: Vec<u64> = (1..=12).rev().filter(|n| wanted == "all" || (wanted == "closed") == (n % 4 == 0)).filter(|n| search.is_none() || *n <= 2).collect();
            let (page, next) = paginate(request, numbers);
            let body: Vec<Value> = page.iter().map(|n| gl_issue(&base, *n)).collect();
            gl_page(request, body, next)
        }
        ("GET", ["issues", _]) if number == 0 || number > 200 => not_found("404 Not found"),
        ("GET", ["issues", _]) => MockResponse::json(200, gl_issue(&base, number)),
        _ => not_found("404 Not Found"),
    }
}

// ---------------------------------------------------------------------------
// Gitea / Forgejo
// ---------------------------------------------------------------------------

fn gt_user(login: &str) -> Value {
    json!({ "id": login.len(), "login": login, "full_name": format!("{login} (Name)"), "avatar_url": format!("https://avatars.example/{login}.png") })
}

fn gt_pr(base: &str, number: u64, state: &MockState) -> Value {
    let status = pr_state(number, state);
    let head_repo = if number == 8 { "fremd/demo" } else { "octo/demo" };
    json!({
        "number": number,
        "title": if number == 3 { "WIP: Thema 3 umsetzen".to_string() } else { format!("Thema {number} umsetzen") },
        "state": if status == "open" { "open" } else { "closed" },
        "merged": status == "merged",
        "user": gt_user("jonas"),
        "body": format!("Beschreibung zu **Thema {number}**."),
        "head": { "ref": source_branch(number), "sha": sha(number), "repo": { "full_name": head_repo } },
        "base": { "ref": "main", "sha": sha(1000), "repo": { "full_name": "octo/demo" } },
        "updated_at": updated(number),
        "html_url": format!("{base}/octo/demo/pulls/{number}"),
        "labels": if number == 1 { json!([{ "id": 11, "name": "bug", "color": "ee0701" }]) } else { json!([]) },
        "requested_reviewers": if number == 2 { json!([gt_user("mira")]) } else { json!([]) },
        "mergeable": number != 13,
    })
}

fn gt_issue(base: &str, number: u64) -> Value {
    json!({
        "number": number,
        "title": format!("Problem {number}"),
        "state": if number % 4 == 0 { "closed" } else { "open" },
        "user": gt_user("mira"),
        "assignees": if number == 2 { json!([gt_user("lena")]) } else { Value::Null },
        "labels": [{ "id": 12, "name": "frage", "color": "0e8a16" }],
        "updated_at": updated(number),
        "html_url": format!("{base}/octo/demo/issues/{number}"),
        "body": format!("Text zu Problem {number}"),
        // The issue endpoint knows pull requests too; no. 3 is one when asked for directly.
        "pull_request": if number == 3 { json!({ "merged": false }) } else { Value::Null },
    })
}

fn with_link(response: MockResponse, next: Option<(String, u64)>) -> MockResponse {
    match next {
        Some((url, _)) => response.header("link", format!("<{url}>; rel=\"next\"")),
        None => response,
    }
}

pub(crate) fn gitea(request: &MockRequest, state: &Mutex<MockState>) -> MockResponse {
    let base = origin(request);
    let token = request.header("authorization").and_then(|value| value.strip_prefix("token ")).unwrap_or_default().to_string();
    if token != TOKEN && token != WEAK_TOKEN {
        return MockResponse::json(401, json!({ "message": "user does not exist [uid: 0, name: ]", "url": format!("{base}/api/swagger") }));
    }
    let mut state = state.lock();
    let path = request.path().strip_prefix("/api/v1").unwrap_or("").to_string();
    let method = request.method.as_str();
    if path == "/user" && state.mode != "401" && state.mode != "slow" {
        return MockResponse::json(200, json!({ "id": 1, "login": "lena", "full_name": "Lena Hartmann", "avatar_url": "https://avatars.example/lena.png" }));
    }
    let rate = MockResponse::json(429, json!({ "message": "rate limit exceeded" })).header("retry-after", "30");
    if let Some(response) = forced(state.mode, rate) {
        return response;
    }
    let Some(rest) = path.strip_prefix("/repos/octo/demo") else {
        return not_found("The target couldn't be found.");
    };
    let segments: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
    let number = segments.get(1).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
    match (method, segments.as_slice()) {
        ("GET", []) => MockResponse::json(
            200,
            json!({
                "name": "demo", "full_name": "octo/demo", "default_branch": "main", "html_url": format!("{base}/octo/demo"),
                "permissions": { "admin": false, "push": true, "pull": true },
                "has_issues": !state.issues_off, "fork": true,
                "parent": { "name": "demo", "owner": { "login": "ursprung" }, "html_url": format!("{base}/ursprung/demo") },
            }),
        ),
        ("GET", ["labels"]) => MockResponse::json(200, json!([{ "id": 11, "name": "bug" }, { "id": 12, "name": "frage" }, { "id": 13, "name": "ui" }])),
        ("GET", ["pulls"]) => {
            let wanted = request.query("state").unwrap_or_else(|| "open".into());
            let numbers: Vec<u64> = (1..=TOTAL)
                .rev()
                .filter(|n| match wanted.as_str() {
                    "open" => pr_state(*n, &state) == "open",
                    "closed" => pr_state(*n, &state) != "open",
                    _ => true,
                })
                .collect();
            let (page, next) = page_by(request, numbers, "limit");
            let body: Vec<Value> = page.iter().map(|n| gt_pr(&base, *n, &state)).collect();
            with_link(MockResponse::json(200, json!(body)), next)
        }
        ("POST", ["releases"]) => {
            let body = request.json();
            if body["tag_name"] == "schon-da" {
                return MockResponse::json(409, json!({ "message": "release tag already exists" }));
            }
            let tag = body["tag_name"].as_str().unwrap_or_default().to_string();
            MockResponse::json(201, json!({ "id": 5, "tag_name": tag, "name": body["name"], "body": body["body"], "html_url": format!("{base}/octo/demo/releases/tag/{tag}") }))
        }
        ("POST", ["pulls"]) => {
            let body = request.json();
            if body["head"] == "schon-da" {
                return MockResponse::json(409, json!({ "message": "pull request already exists for these targets [id: 5, issue_id: 5, head_repo_id: 1, base_repo_id: 1, head_branch: schon-da, base_branch: main]" }));
            }
            let mut created = gt_pr(&base, 101, &state);
            for key in ["title", "body"] {
                created[key] = body[key].clone();
            }
            created["head"]["ref"] = body["head"].clone();
            created["base"]["ref"] = body["base"].clone();
            MockResponse::json(201, created)
        }
        ("GET", ["pulls", _]) if number == 0 || number > 200 => not_found("pull request does not exist [repo_id: 1, index: 999]"),
        ("GET", ["pulls", _]) => MockResponse::json(200, gt_pr(&base, number, &state)),
        ("PATCH", ["pulls", _]) => {
            let body = request.json();
            match body["state"].as_str() {
                Some("closed") => state.closed.push(number),
                Some("open") => state.closed.retain(|n| *n != number),
                _ => {}
            }
            let mut pr = gt_pr(&base, number, &state);
            for key in ["title", "body"] {
                if !body[key].is_null() {
                    pr[key] = body[key].clone();
                }
            }
            if !body["base"].is_null() {
                pr["base"]["ref"] = body["base"].clone();
            }
            MockResponse::json(201, pr)
        }
        ("GET", ["pulls", _, "reviews"]) if number == 9 => MockResponse::json(
            200,
            json!([
                { "id": 91, "user": gt_user("mira"), "state": "COMMENT", "body": "", "submitted_at": "2026-09-02T09:30:00Z", "dismissed": false, "comments_count": 3 },
                { "id": 92, "user": gt_user("jonas"), "state": "COMMENT", "body": "", "submitted_at": "2026-09-02T10:00:00Z", "dismissed": false, "comments_count": 1 },
                { "id": 93, "user": gt_user("lena"), "state": "PENDING", "body": "", "submitted_at": Value::Null, "dismissed": false, "comments_count": 1 },
                { "id": 94, "user": gt_user("mira"), "state": "APPROVED", "body": "", "submitted_at": "2026-09-02T11:00:00Z", "dismissed": false, "comments_count": 0 }
            ]),
        ),
        ("GET", ["pulls", _, "reviews", id, "comments"]) => {
            let review_comment = |id: u64, review: u64, who: &str, body: &str, path: &str, position: u64, original: u64, at: &str, resolver: Value| {
                json!({ "id": id, "pull_request_review_id": review, "user": gt_user(who), "body": body, "path": path, "position": position, "original_position": original,
                    "commit_id": sha(9), "original_commit_id": sha(9), "created_at": at, "updated_at": at, "resolver": resolver, "diff_hunk": "@@ -40,3 +40,3 @@" })
            };
            match *id {
                "91" => MockResponse::json(200, json!([
                    review_comment(9101, 91, "mira", "Hier fehlt die Prüfung auf leer.", "src/anmeldung.rs", 42, 0, "2026-09-02T09:30:00Z", Value::Null),
                    review_comment(9102, 91, "mira", "Tippfehler: „Fehler“.", "src/meldung.rs", 7, 0, "2026-09-02T09:31:00Z", gt_user("mira")),
                    review_comment(9103, 91, "mira", "Diese Zeile gibt es so nicht mehr.", "src/alt.rs", 0, 12, "2026-09-02T09:32:00Z", Value::Null),
                ])),
                "92" => MockResponse::json(200, json!([review_comment(9201, 92, "jonas", "Stimmt, mache ich.", "src/anmeldung.rs", 42, 0, "2026-09-02T10:00:00Z", Value::Null)])),
                "95" => {
                    let body = state.review_bodies.last().cloned().unwrap_or_default();
                    MockResponse::json(200, json!([review_comment(9501, 95, "lena", &body, "src/anmeldung.rs", 42, 0, "2026-09-05T08:00:00Z", Value::Null)]))
                }
                _ => MockResponse::json(200, json!([])),
            }
        }
        ("POST", ["pulls", _, "reviews"]) => {
            let body = request.json();
            if let Some(text) = body["comments"][0]["body"].as_str() {
                state.review_bodies.push(text.to_string());
            }
            MockResponse::json(200, json!({ "id": 95, "user": gt_user("lena"), "state": "COMMENT", "body": "", "submitted_at": "2026-09-05T08:00:00Z", "dismissed": false, "comments_count": 1 }))
        }
        ("GET", ["pulls", _, "reviews"]) => MockResponse::json(
            200,
            match number {
                1 => json!([
                    { "id": 11, "user": gt_user("mira"), "state": "COMMENT", "body": "Erster Blick: sieht gut aus.", "submitted_at": "2026-09-02T09:00:00Z", "dismissed": false },
                    { "id": 12, "user": gt_user("mira"), "state": "APPROVED", "body": "", "submitted_at": "2026-09-02T10:00:00Z", "dismissed": false }
                ]),
                4 => json!([{ "id": 41, "user": gt_user("jonas"), "state": "REQUEST_CHANGES", "body": "Bitte die Tests ergänzen.", "submitted_at": "2026-09-03T10:00:00Z", "dismissed": false }]),
                _ => json!([]),
            },
        ),
        ("GET", ["pulls", _, "commits"]) => MockResponse::json(
            200,
            json!([
                { "sha": sha(number * 100 + 1), "commit": { "message": "Prüfung ergänzt\n\nLängere Erklärung.", "author": { "name": "Jonas Weber", "date": "2026-09-01T12:00:00Z" } } },
                { "sha": sha(number), "commit": { "message": "Meldung übersetzt", "author": { "name": "Jonas Weber", "date": "2026-09-01T13:00:00Z" } } }
            ]),
        ),
        ("POST", ["pulls", _, "requested_reviewers"]) => MockResponse::json(201, json!([])),
        ("DELETE", ["pulls", _, "requested_reviewers"]) => MockResponse::empty(204),
        ("POST", ["pulls", _, "merge"]) => {
            if number == 13 {
                return MockResponse::json(405, json!({ "message": "The pull request cannot be merged: there are merge conflicts." }));
            }
            state.merged.push(number);
            MockResponse::empty(200)
        }
        ("GET", ["commits", sha_text, "status"]) => {
            let statuses = match u64::from_str_radix(sha_text, 16).unwrap_or(0) {
                1 => json!([
                    { "context": "build", "status": "success", "target_url": format!("{base}/octo/demo/actions/runs/1") },
                    { "context": "docs", "status": "warning", "target_url": "https://ci.example/docs" }
                ]),
                2 => json!([{ "context": "build", "status": "pending", "target_url": format!("{base}/octo/demo/actions/runs/2") }]),
                4 => json!([{ "context": "build", "status": "failure", "target_url": format!("{base}/octo/demo/actions/runs/4") }]),
                _ => json!([]),
            };
            MockResponse::json(200, json!({ "state": "", "statuses": statuses }))
        }
        ("GET", ["issues"]) if state.issues_off => not_found("repo has no issue tracker"),
        ("GET", ["issues"]) => {
            let wanted = request.query("state").unwrap_or_else(|| "open".into());
            let search = request.query("q");
            let numbers: Vec<u64> = (1..=12).rev().filter(|n| wanted == "all" || (wanted == "closed") == (n % 4 == 0)).filter(|n| search.is_none() || *n <= 2).collect();
            let (page, next) = page_by(request, numbers, "limit");
            // `type=issues`: the list holds no pull requests.
            let body: Vec<Value> = page
                .iter()
                .map(|n| {
                    let mut issue = gt_issue(&base, *n);
                    issue["pull_request"] = Value::Null;
                    issue
                })
                .collect();
            with_link(MockResponse::json(200, json!(body)), next)
        }
        ("GET", ["issues", _]) if number == 0 || number > 200 => not_found("issue does not exist [repo_id: 1, index: 999]"),
        ("GET", ["issues", _]) => MockResponse::json(200, gt_issue(&base, number)),
        ("GET", ["issues", _, "comments"]) => MockResponse::json(200, json!([{ "id": 21, "user": gt_user("jonas"), "body": "Danke fürs Ansehen!", "created_at": "2026-09-02T09:45:00Z" }])),
        ("POST", ["issues", _, "comments"]) => MockResponse::json(201, json!({ "id": 99, "user": gt_user("lena"), "body": request.json()["body"], "created_at": "2026-09-05T08:00:00Z" })),
        _ => not_found("The target couldn't be found."),
    }
}

// ---------------------------------------------------------------------------
// Bitbucket Cloud
// ---------------------------------------------------------------------------

/// User name and token from `Authorization: Basic …`.
fn basic(request: &MockRequest) -> Option<(String, String)> {
    use base64::Engine;
    let encoded = request.header("authorization")?.strip_prefix("Basic ")?;
    let decoded = String::from_utf8(base64::engine::general_purpose::STANDARD.decode(encoded).ok()?).ok()?;
    let (user, token) = decoded.split_once(':')?;
    Some((user.to_string(), token.to_string()))
}

fn bb_error(status: u16, message: &str) -> MockResponse {
    MockResponse::json(status, json!({ "type": "error", "error": { "message": message } }))
}

fn bb_user(nick: &str) -> Value {
    json!({ "type": "user", "display_name": format!("{nick} (Name)"), "nickname": nick, "account_id": format!("557058:{nick}"), "links": { "avatar": { "href": format!("https://avatars.example/{nick}.png") } } })
}

fn bb_state(number: u64, state: &MockState) -> &'static str {
    match pr_state(number, state) {
        "merged" => "MERGED",
        "closed" => "DECLINED",
        _ => "OPEN",
    }
}

fn bb_pr(base: &str, number: u64, state: &MockState, single: bool) -> Value {
    let source_repo = if number == 8 { "fremd/demo" } else { "team/demo" };
    let mut pr = json!({
        "type": "pullrequest",
        "id": number,
        "title": format!("Thema {number} umsetzen"),
        "description": format!("Beschreibung zu **Thema {number}**."),
        "state": bb_state(number, state),
        "draft": number == 3,
        "author": bb_user("jonas"),
        "source": { "branch": { "name": source_branch(number) }, "commit": { "hash": sha(number)[..12].to_string() }, "repository": { "full_name": source_repo } },
        "destination": { "branch": { "name": "main" }, "commit": { "hash": sha(1000)[..12].to_string() }, "repository": { "full_name": "team/demo" } },
        "updated_on": updated(number),
        "links": { "html": { "href": format!("{base}/team/demo/pull-requests/{number}") } },
    });
    // Participants and reviewers only come with the single pull request.
    if single {
        pr["participants"] = match number {
            1 => json!([
                { "user": bb_user("mira"), "role": "REVIEWER", "approved": true, "state": "approved" },
                { "user": bb_user("jonas"), "role": "PARTICIPANT", "approved": false, "state": Value::Null }
            ]),
            4 => json!([{ "user": bb_user("jonas"), "role": "REVIEWER", "approved": false, "state": "changes_requested" }]),
            _ => json!([]),
        };
        pr["reviewers"] = if number == 2 { json!([bb_user("mira")]) } else { json!([]) };
    }
    pr
}

fn bb_issue(base: &str, number: u64) -> Value {
    let status = if number % 4 == 0 {
        "resolved"
    } else if number % 3 == 0 {
        "new"
    } else {
        "open"
    };
    json!({
        "type": "issue", "id": number, "title": format!("Problem {number}"), "state": status, "kind": "bug",
        "reporter": bb_user("mira"), "assignee": if number == 2 { bb_user("lena") } else { Value::Null },
        "updated_on": updated(number), "links": { "html": { "href": format!("{base}/team/demo/issues/{number}") } },
        "content": { "raw": format!("Text zu Problem {number}") },
    })
}

/// `{ values, page, next }` like Bitbucket's lists.
fn bb_list(request: &MockRequest, numbers: Vec<u64>, item: impl Fn(u64) -> Value) -> MockResponse {
    let (page, next) = page_by(request, numbers, "pagelen");
    let mut body = json!({ "values": page.into_iter().map(item).collect::<Vec<_>>(), "page": request.query("page").and_then(|p| p.parse::<u64>().ok()).unwrap_or(1) });
    if let Some((url, _)) = next {
        body["next"] = json!(url);
    }
    MockResponse::json(200, body)
}

fn bb_values(values: Value) -> MockResponse {
    MockResponse::json(200, json!({ "values": values, "page": 1 }))
}

/// The values of a parameter that may come several times (`state=OPEN&state=MERGED`).
fn all_query(request: &MockRequest, name: &str) -> Vec<String> {
    let prefix = format!("{name}=");
    request.target.split_once('?').map(|(_, q)| q).unwrap_or("").split('&').filter_map(|pair| pair.strip_prefix(prefix.as_str())).map(str::to_string).collect()
}

pub(crate) fn bitbucket(request: &MockRequest, state: &Mutex<MockState>) -> MockResponse {
    let base = origin(request);
    let Some((user, token)) = basic(request).filter(|(user, token)| !user.is_empty() && (token == TOKEN || token == WEAK_TOKEN)) else {
        return bb_error(401, "Invalid credentials");
    };
    let mut state = state.lock();
    let path = request.path().strip_prefix("/2.0").unwrap_or("").to_string();
    let method = request.method.as_str();
    if path == "/user" && state.mode != "401" && state.mode != "slow" {
        let scopes = if token == WEAK_TOKEN { "account, repository" } else { "account, repository, pullrequest:write, issue" };
        return MockResponse::json(
            200,
            json!({ "type": "user", "display_name": "Lena Hartmann", "nickname": "lena", "account_id": "557058:lena", "links": { "avatar": { "href": "https://avatars.example/lena.png" } }, "signed_in_with": user }),
        )
        .header("x-oauth-scopes", scopes);
    }
    let rate = bb_error(429, "Rate limit for this resource has been exceeded").header("retry-after", "30");
    if let Some(response) = forced(state.mode, rate) {
        return response;
    }
    if path == "/user/permissions/repositories" {
        return bb_values(json!([{ "type": "repository_permission", "permission": "write", "repository": { "full_name": "team/demo" } }]));
    }
    let Some(rest) = path.strip_prefix("/repositories/team/demo") else {
        return bb_error(404, "Repository not found");
    };
    let segments: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
    let number = segments.get(1).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
    match (method, segments.as_slice()) {
        ("GET", []) => MockResponse::json(
            200,
            json!({
                "type": "repository", "full_name": "team/demo", "mainbranch": { "name": "main" }, "has_issues": !state.issues_off,
                "links": { "html": { "href": format!("{base}/team/demo") } },
                "parent": { "full_name": "quelle/demo", "links": { "html": { "href": format!("{base}/quelle/demo") } } },
            }),
        ),
        ("GET", ["pullrequests"]) => {
            let wanted = all_query(request, "state");
            let numbers: Vec<u64> = (1..=TOTAL).rev().filter(|n| wanted.is_empty() || wanted.iter().any(|w| w == bb_state(*n, &state))).collect();
            bb_list(request, numbers, |n| bb_pr(&base, n, &state, false))
        }
        ("POST", ["pullrequests"]) => {
            let body = request.json();
            if body["source"]["branch"]["name"] == "schon-da" {
                return bb_error(400, "Only one pull request may be open for a given source and target branch");
            }
            let mut created = bb_pr(&base, 101, &state, true);
            for key in ["title", "description", "draft"] {
                created[key] = body[key].clone();
            }
            created["source"]["branch"] = body["source"]["branch"].clone();
            created["destination"]["branch"] = body["destination"]["branch"].clone();
            MockResponse::json(201, created)
        }
        ("GET", ["pullrequests", _]) if number == 0 || number > 200 => bb_error(404, "Pull request not found"),
        ("GET", ["pullrequests", _]) => MockResponse::json(200, bb_pr(&base, number, &state, true)),
        ("PUT", ["pullrequests", _]) => {
            let body = request.json();
            let mut pr = bb_pr(&base, number, &state, true);
            for key in ["title", "description", "draft"] {
                if !body[key].is_null() {
                    pr[key] = body[key].clone();
                }
            }
            if !body["destination"].is_null() {
                pr["destination"]["branch"] = body["destination"]["branch"].clone();
            }
            MockResponse::json(200, pr)
        }
        ("POST", ["pullrequests", _, "merge"]) => {
            if number == 13 {
                return bb_error(400, "You can't merge until you resolve all merge conflicts.");
            }
            state.merged.push(number);
            MockResponse::json(200, bb_pr(&base, number, &state, true))
        }
        ("POST", ["pullrequests", _, "decline"]) => {
            state.closed.push(number);
            MockResponse::json(200, bb_pr(&base, number, &state, true))
        }
        ("GET", ["pullrequests", _, "statuses"]) => bb_values(match number {
            1 => json!([
                { "key": "build", "name": "build", "state": "SUCCESSFUL", "url": format!("{base}/team/demo/pipelines/1") },
                { "key": "docs", "name": "docs", "state": "STOPPED", "url": "https://ci.example/docs" }
            ]),
            2 => json!([{ "key": "build", "name": "build", "state": "INPROGRESS", "url": format!("{base}/team/demo/pipelines/2") }]),
            4 => json!([{ "key": "build", "name": "build", "state": "FAILED", "url": format!("{base}/team/demo/pipelines/4") }]),
            _ => json!([]),
        }),
        ("GET", ["pullrequests", _, "diffstat"]) => bb_values(json!([{ "status": if number == 13 { "merge conflict" } else { "modified" }, "new": { "path": "src/anmeldung.rs" } }])),
        ("GET", ["pullrequests", _, "comments"]) if number == 9 => bb_values(json!([
            { "id": 901, "user": bb_user("mira"), "content": { "raw": "Hier fehlt die Prüfung auf leer." }, "created_on": "2026-09-02T09:30:00Z", "deleted": false,
              "inline": { "path": "src/anmeldung.rs", "to": 42, "from": Value::Null, "start_to": 40 } },
            { "id": 902, "user": bb_user("jonas"), "content": { "raw": "Stimmt, mache ich." }, "created_on": "2026-09-02T10:00:00Z", "deleted": false, "parent": { "id": 901 },
              "inline": { "path": "src/anmeldung.rs", "to": 42, "from": Value::Null } },
            { "id": 903, "user": bb_user("mira"), "content": { "raw": "Danke!" }, "created_on": "2026-09-02T10:10:00Z", "deleted": false, "parent": { "id": 902 } },
            { "id": 911, "user": bb_user("mira"), "content": { "raw": "Tippfehler: „Fehler“." }, "created_on": "2026-09-02T09:40:00Z", "deleted": false,
              "inline": { "path": "src/meldung.rs", "to": 7, "from": Value::Null }, "resolution": { "type": "comment_resolution", "user": bb_user("mira"), "created_on": "2026-09-03T08:00:00Z" } },
            { "id": 921, "user": bb_user("mira"), "content": { "raw": "Diese Zeile gibt es so nicht mehr." }, "created_on": "2026-09-02T09:50:00Z", "deleted": false,
              "inline": { "path": "src/alt.rs", "to": Value::Null, "from": 12 } },
            { "id": 931, "user": bb_user("mira"), "content": { "raw": "Allgemeiner Kommentar" }, "created_on": "2026-09-02T11:00:00Z", "deleted": false },
            { "id": 941, "user": bb_user("jonas"), "content": { "raw": "" }, "created_on": "2026-09-02T11:10:00Z", "deleted": true, "inline": { "path": "src/x.rs", "to": 1 } }
        ])),
        ("GET", ["pullrequests", _, "comments"]) => bb_values(json!([
            { "id": 2, "user": bb_user("mira"), "content": { "raw": "Sieht gut aus." }, "created_on": "2026-09-02T09:00:00Z", "deleted": false },
            { "id": 3, "user": bb_user("mira"), "content": { "raw": "Hier bitte prüfen." }, "created_on": "2026-09-02T09:30:00Z", "deleted": false, "inline": { "path": "src/anmeldung.rs", "to": 42, "from": Value::Null } },
            { "id": 4, "user": bb_user("jonas"), "content": { "raw": "" }, "created_on": "2026-09-02T09:40:00Z", "deleted": true }
        ])),
        ("POST", ["pullrequests", _, "comments"]) if !request.json()["parent"].is_null() => {
            let body = request.json();
            if body["parent"]["id"].as_u64() != Some(901) {
                return bb_error(404, "Comment not found");
            }
            MockResponse::json(
                201,
                json!({ "id": 904, "user": bb_user("lena"), "content": { "raw": body["content"]["raw"] }, "created_on": "2026-09-05T08:00:00Z", "parent": { "id": 901 },
                    "inline": { "path": "src/anmeldung.rs", "to": 42, "from": Value::Null } }),
            )
        }
        ("POST", ["pullrequests", _, "comments"]) => {
            MockResponse::json(201, json!({ "id": 99, "user": bb_user("lena"), "content": { "raw": request.json()["content"]["raw"] }, "created_on": "2026-09-05T08:00:00Z" }))
        }
        ("GET", ["pullrequests", _, "commits"]) => bb_values(json!([
            { "hash": sha(number), "message": "Meldung übersetzt\n", "author": { "raw": "Jonas Weber <jonas@example.org>", "user": bb_user("jonas") }, "date": "2026-09-01T13:00:00Z" },
            { "hash": sha(number * 100 + 1), "message": "Prüfung ergänzt\n\nLängere Erklärung.", "author": { "raw": "Jonas Weber <jonas@example.org>" }, "date": "2026-09-01T12:00:00Z" }
        ])),
        ("GET", ["issues", ..]) if state.issues_off => bb_error(404, "Repository has no issue tracker."),
        ("GET", ["issues"]) => {
            let q = request.query("q").unwrap_or_default();
            let numbers: Vec<u64> = (1..=12)
                .rev()
                .filter(|n| {
                    if q.contains("state!=\"new\"") {
                        n % 4 == 0
                    } else if q.contains("state=\"new\"") {
                        n % 4 != 0
                    } else {
                        true
                    }
                })
                .filter(|n| !q.contains("title ~") || *n <= 2)
                .collect();
            bb_list(request, numbers, |n| bb_issue(&base, n))
        }
        ("GET", ["issues", _]) if number == 0 || number > 200 => bb_error(404, "Issue not found"),
        ("GET", ["issues", _]) => MockResponse::json(200, bb_issue(&base, number)),
        ("GET", ["issues", _, "comments"]) => bb_values(json!([
            { "id": 21, "user": bb_user("jonas"), "content": { "raw": "Danke fürs Ansehen!" }, "created_on": "2026-09-02T09:45:00Z" },
            { "id": 22, "user": bb_user("jonas"), "content": { "raw": "" }, "created_on": "2026-09-02T09:50:00Z" }
        ])),
        _ => bb_error(404, "Resource not found"),
    }
}

// ---------------------------------------------------------------------------
// Azure DevOps
// ---------------------------------------------------------------------------

const AZ_REPO: &str = "/firma/projekt/_apis/git/repositories/demo";
const AZ_WIT: &str = "/firma/projekt/_apis/wit";

fn az_error(status: u16, message: &str) -> MockResponse {
    MockResponse::json(status, json!({ "$id": "1", "message": message, "typeKey": "MockException", "errorCode": 0 }))
}

fn az_user(name: &str) -> Value {
    json!({ "displayName": format!("{name} (Name)"), "uniqueName": format!("{name}@example.org"), "imageUrl": format!("https://avatars.example/{name}.png") })
}

fn az_list(values: Vec<Value>) -> MockResponse {
    MockResponse::json(200, json!({ "count": values.len(), "value": values }))
}

fn az_status(number: u64, state: &MockState) -> &'static str {
    match pr_state(number, state) {
        "merged" => "completed",
        "closed" => "abandoned",
        _ => "active",
    }
}

fn az_pr(number: u64, state: &MockState) -> Value {
    let status = az_status(number, state);
    let mut pr = json!({
        "pullRequestId": number,
        "title": format!("Thema {number} umsetzen"),
        "description": format!("Beschreibung zu **Thema {number}**."),
        "status": status,
        "isDraft": number == 3,
        "createdBy": az_user("jonas"),
        "creationDate": updated(number),
        "closedDate": if status == "active" { Value::Null } else { json!(updated(number)) },
        "sourceRefName": format!("refs/heads/{}", source_branch(number)),
        "targetRefName": "refs/heads/main",
        "repository": { "name": "demo", "project": { "name": "projekt" } },
        "labels": if number == 1 { json!([{ "name": "bug", "active": true }]) } else { json!([]) },
        "reviewers": match number {
            1 => json!([{ "vote": 10, "displayName": "mira (Name)", "uniqueName": "mira@example.org" }]),
            2 => json!([{ "vote": 0, "displayName": "mira (Name)", "uniqueName": "mira@example.org" }]),
            4 => json!([{ "vote": -10, "displayName": "jonas (Name)", "uniqueName": "jonas@example.org" }]),
            _ => json!([]),
        },
        "mergeStatus": if number == 13 { "conflicts" } else { "succeeded" },
        "lastMergeSourceCommit": { "commitId": sha(number) },
    });
    if number == 8 {
        pr["forkSource"] = json!({ "repository": { "name": "demo", "project": { "name": "fremd" } } });
    }
    pr
}

fn az_work_item(number: u64) -> Value {
    json!({
        "id": number,
        "fields": {
            "System.Title": format!("Problem {number}"),
            "System.State": if number % 4 == 0 { "Closed" } else { "Active" },
            "System.CreatedBy": az_user("mira"),
            "System.AssignedTo": if number == 2 { az_user("lena") } else { Value::Null },
            "System.ChangedDate": updated(number),
            "System.Tags": if number == 1 { "frage; ui" } else { "" },
            "System.WorkItemType": "Issue",
            "System.Description": format!("<p>Text zu Problem {number}</p>"),
        }
    })
}

fn azure_work_items(request: &MockRequest, state: &MockState, rest: &str) -> MockResponse {
    let segments: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
    match (request.method.as_str(), segments.as_slice()) {
        ("POST", ["wiql"]) => {
            let query = request.json()["query"].as_str().unwrap_or_default().to_string();
            let top: usize = request.query("$top").and_then(|v| v.parse().ok()).unwrap_or(20_000);
            let ids: Vec<Value> = (1..=12u64)
                .rev()
                .filter(|n| {
                    if query.contains("NOT IN") {
                        n % 4 != 0
                    } else if query.contains("] IN (") {
                        n % 4 == 0
                    } else {
                        true
                    }
                })
                .filter(|n| !query.contains("CONTAINS") || *n <= 2)
                .take(top)
                .map(|n| json!({ "id": n, "url": format!("https://example.invalid/_apis/wit/workItems/{n}") }))
                .collect();
            MockResponse::json(200, json!({ "queryType": "flat", "workItems": ids }))
        }
        ("GET", ["workitems"]) => {
            let mut ids: Vec<u64> = request.query("ids").unwrap_or_default().split(',').filter_map(|id| id.trim().parse().ok()).collect();
            // In the host's own order, not in the one asked for.
            ids.sort_unstable();
            az_list(ids.into_iter().map(az_work_item).collect())
        }
        ("GET", ["workitems", id]) => match id.parse::<u64>() {
            Ok(n) if (1..=200).contains(&n) => MockResponse::json(200, az_work_item(n)),
            _ => az_error(404, "TF401232: Work item 999 does not exist, or you do not have permissions to read it."),
        },
        ("GET", ["workItems", _, "comments"]) => MockResponse::json(
            200,
            json!({ "totalCount": 1, "count": 1, "comments": [{ "id": 5, "text": "Danke fürs Ansehen!", "createdBy": az_user("jonas"), "createdDate": "2026-09-02T09:45:00Z" }] }),
        ),
        ("POST", ["workitems", kind]) if kind.starts_with('$') => {
            if *kind == "$Issue" && state.no_issue_type {
                return az_error(404, "VS402323: Work item type Issue does not exist in project projekt or you do not have permission to access it.");
            }
            let patch = request.json();
            let field = |name: &str| patch.as_array().and_then(|ops| ops.iter().find(|op| op["path"] == format!("/fields/{name}"))).map(|op| op["value"].clone()).unwrap_or(Value::Null);
            MockResponse::json(
                200,
                json!({ "id": 77, "fields": {
                    "System.Title": field("System.Title"), "System.State": "New", "System.CreatedBy": az_user("lena"),
                    "System.ChangedDate": "2026-09-05T08:00:00Z", "System.WorkItemType": kind.trim_start_matches('$'), "System.Description": field("System.Description"),
                } }),
            )
        }
        _ => az_error(404, "The resource cannot be found."),
    }
}

/// The review threads of pull request 9 (Azure DevOps).
fn az_review_threads() -> Vec<Value> {
    let text = |id: u64, parent: u64, who: &str, body: &str, at: &str| json!({ "id": id, "parentCommentId": parent, "author": az_user(who), "content": body, "publishedDate": at, "commentType": "text" });
    vec![
        json!({ "id": 91, "status": "active", "threadContext": { "filePath": "/src/anmeldung.rs", "rightFileStart": { "line": 40, "offset": 1 }, "rightFileEnd": { "line": 42, "offset": 20 } },
            "comments": [text(1, 0, "mira", "Hier fehlt die Prüfung auf leer.", "2026-09-02T09:30:00Z"), text(2, 1, "jonas", "Stimmt, mache ich.", "2026-09-02T10:00:00Z")] }),
        json!({ "id": 92, "status": "fixed", "threadContext": { "filePath": "/src/meldung.rs", "rightFileStart": { "line": 7, "offset": 1 }, "rightFileEnd": { "line": 7, "offset": 9 } },
            "comments": [text(1, 0, "mira", "Tippfehler: „Fehler“.", "2026-09-02T09:40:00Z")] }),
        json!({ "id": 93, "status": "active", "threadContext": { "filePath": "/src/alt.rs", "leftFileStart": { "line": 12, "offset": 1 }, "leftFileEnd": { "line": 12, "offset": 30 } },
            "comments": [text(1, 0, "mira", "Diese Zeile gibt es so nicht mehr.", "2026-09-02T09:50:00Z")] }),
        json!({ "id": 94, "status": "active", "comments": [text(1, 0, "mira", "Allgemeiner Kommentar", "2026-09-02T11:00:00Z")] }),
        json!({ "id": 95, "status": "active", "isDeleted": true, "threadContext": { "filePath": "/src/x.rs", "rightFileStart": { "line": 1 } }, "comments": [text(1, 0, "jonas", "weg", "2026-09-02T11:10:00Z")] }),
        json!({ "id": 96, "status": "active", "threadContext": { "filePath": "/src/y.rs", "rightFileStart": { "line": 2 } },
            "comments": [{ "id": 1, "author": az_user("jonas"), "content": "Policy status has been updated", "publishedDate": "2026-09-02T12:00:00Z", "commentType": "system" }] }),
        json!({ "id": 97, "status": "active", "threadContext": { "filePath": "/src/neu.rs", "rightFileStart": { "line": 5, "offset": 1 }, "rightFileEnd": { "line": 5, "offset": 9 } },
            "comments": [{ "id": 1, "parentCommentId": 0, "author": az_user("mira"), "content": "", "publishedDate": "2026-09-02T12:10:00Z", "commentType": "text", "isDeleted": true },
                text(2, 1, "jonas", "Bitte umbenennen.", "2026-09-02T12:20:00Z")] }),
    ]
}

pub(crate) fn azure(request: &MockRequest, state: &Mutex<MockState>) -> MockResponse {
    let base = origin(request);
    if !basic(request).is_some_and(|(_, token)| token == TOKEN || token == WEAK_TOKEN) {
        return az_error(401, "TF400813: The user is not authorized to access this resource.");
    }
    let mut state = state.lock();
    let path = request.path().to_string();
    let method = request.method.as_str();
    if state.mode != "401" && state.mode != "slow" {
        match path.as_str() {
            "/firma/_apis/connectionData" => {
                return MockResponse::json(
                    200,
                    json!({ "authenticatedUser": { "id": "6f1c0de2", "providerDisplayName": "Lena Hartmann", "isActive": true, "properties": { "Account": { "$type": "System.String", "$value": "lena@example.org" } } } }),
                )
            }
            "/firma/_apis/projects" => return az_list(vec![json!({ "id": "p1", "name": "projekt" })]),
            _ => {}
        }
    }
    let rate = az_error(429, "TF400733: The request has been throttled.").header("retry-after", "30");
    if let Some(response) = forced(state.mode, rate) {
        return response;
    }
    if let Some(rest) = path.strip_prefix(AZ_WIT) {
        return azure_work_items(request, &state, rest);
    }
    let Some(rest) = path.strip_prefix(AZ_REPO) else {
        return az_error(404, "TF401019: The Git repository with name or identifier demo does not exist or you do not have permissions for the operation you are attempting.");
    };
    let segments: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
    let number = segments.get(1).and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
    match (method, segments.as_slice()) {
        ("GET", []) => MockResponse::json(
            200,
            json!({ "id": "r1", "name": "demo", "defaultBranch": "refs/heads/main", "webUrl": format!("{base}/firma/projekt/_git/demo"), "project": { "name": "projekt" }, "isFork": true, "parentRepository": { "name": "demo", "project": { "name": "quelle" } } }),
        ),
        ("GET", ["pullrequests"]) => {
            let wanted = request.query("searchCriteria.status").unwrap_or_else(|| "active".into());
            let skip: usize = request.query("$skip").and_then(|v| v.parse().ok()).unwrap_or(0);
            let top: usize = request.query("$top").and_then(|v| v.parse().ok()).unwrap_or(101);
            let values: Vec<Value> = (1..=TOTAL).rev().filter(|n| wanted == "all" || wanted == az_status(*n, &state)).skip(skip).take(top).map(|n| az_pr(n, &state)).collect();
            az_list(values)
        }
        ("POST", ["pullrequests"]) => {
            let body = request.json();
            if body["sourceRefName"] == "refs/heads/schon-da" {
                return az_error(409, "TF401179: An active pull request for the source and target branch already exists.");
            }
            let mut created = az_pr(101, &state);
            for key in ["title", "description", "isDraft", "sourceRefName", "targetRefName"] {
                created[key] = body[key].clone();
            }
            if !body["labels"].is_null() {
                created["labels"] = body["labels"].clone();
            }
            MockResponse::json(201, created)
        }
        ("GET", ["pullrequests", _]) if number == 0 || number > 200 => az_error(404, "TF401180: The requested pull request was not found."),
        ("GET", ["pullrequests", _]) => MockResponse::json(200, az_pr(number, &state)),
        ("PATCH", ["pullrequests", _]) => {
            let body = request.json();
            match body["status"].as_str() {
                Some("completed") if number == 13 => return az_error(409, "TF401181: The pull request cannot be completed because it has merge conflicts."),
                Some("completed") => state.merged.push(number),
                Some("abandoned") => state.closed.push(number),
                Some("active") => state.closed.retain(|n| *n != number),
                _ => {}
            }
            let mut pr = az_pr(number, &state);
            for key in ["title", "description", "isDraft", "targetRefName"] {
                if !body[key].is_null() {
                    pr[key] = body[key].clone();
                }
            }
            MockResponse::json(200, pr)
        }
        ("GET", ["pullrequests", _, "statuses"]) => az_list(match number {
            1 => vec![
                json!({ "id": 1, "state": "succeeded", "context": { "name": "build", "genre": "ci" }, "targetUrl": "https://ci.example/1" }),
                json!({ "id": 2, "state": "notApplicable", "context": { "name": "docs", "genre": "ci" } }),
            ],
            2 => vec![json!({ "id": 1, "state": "pending", "context": { "name": "build", "genre": "ci" } })],
            4 => vec![json!({ "id": 1, "state": "failed", "context": { "name": "build", "genre": "ci" } })],
            _ => Vec::new(),
        }),
        ("GET", ["pullrequests", _, "threads"]) if number == 9 => az_list(az_review_threads()),
        ("GET", ["pullrequests", _, "threads", id]) => match az_review_threads().into_iter().find(|t| t["id"].as_u64().is_some() && t["id"].as_u64() == id.parse::<u64>().ok()) {
            Some(thread) if number == 9 => MockResponse::json(200, thread),
            _ => az_error(404, "TF401181: The requested pull request thread was not found."),
        },
        ("POST", ["pullrequests", _, "threads", id, "comments"]) if number == 9 && (*id == "91" || *id == "97") => MockResponse::json(
            200,
            json!({ "id": 3, "parentCommentId": request.json()["parentCommentId"], "author": az_user("lena"), "content": request.json()["content"], "publishedDate": "2026-09-05T08:00:00Z", "commentType": "text" }),
        ),
        ("POST", ["pullrequests", _, "threads", _, "comments"]) => az_error(404, "TF401181: The requested pull request thread was not found."),
        ("GET", ["pullrequests", _, "threads"]) => az_list(vec![
            json!({ "id": 1, "comments": [{ "id": 1, "author": az_user("jonas"), "content": "Policy status has been updated", "publishedDate": "2026-09-02T08:00:00Z", "commentType": "system" }] }),
            json!({ "id": 2, "comments": [{ "id": 1, "author": az_user("mira"), "content": "Sieht gut aus.", "publishedDate": "2026-09-02T09:00:00Z", "commentType": "text" }] }),
            json!({ "id": 3, "threadContext": { "filePath": "/src/anmeldung.rs", "rightFileStart": { "line": 42, "offset": 1 } }, "comments": [{ "id": 1, "author": az_user("mira"), "content": "Hier bitte prüfen.", "publishedDate": "2026-09-02T09:30:00Z", "commentType": "text" }] }),
        ]),
        ("POST", ["pullrequests", _, "threads"]) => MockResponse::json(
            200,
            json!({ "id": 7, "comments": [{ "id": 1, "author": az_user("lena"), "content": request.json()["comments"][0]["content"], "publishedDate": "2026-09-05T08:00:00Z", "commentType": "text" }] }),
        ),
        ("GET", ["pullrequests", _, "commits"]) => az_list(vec![
            json!({ "commitId": sha(number), "comment": "Meldung übersetzt", "author": { "name": "Jonas Weber", "date": "2026-09-01T13:00:00Z" } }),
            json!({ "commitId": sha(number * 100 + 1), "comment": "Prüfung ergänzt\n\nLängere Erklärung.", "author": { "name": "Jonas Weber", "date": "2026-09-01T12:00:00Z" } }),
        ]),
        ("POST", ["pullrequests", _, "labels"]) => MockResponse::json(200, json!({ "name": request.json()["name"], "active": true })),
        ("DELETE", ["pullrequests", _, "labels", _]) => MockResponse::empty(204),
        _ => az_error(404, "The resource cannot be found."),
    }
}
