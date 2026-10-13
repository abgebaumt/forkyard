//! The test server's responses, in the shape of the public API documentation of GitHub
//! and GitLab. All names, numbers and texts are made up.
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

/// Pages through `numbers` and returns the page with a `Link` header for the next one.
fn paginate(request: &MockRequest, numbers: Vec<u64>) -> (Vec<u64>, Option<(String, u64)>) {
    let per_page: usize = request.query("per_page").and_then(|v| v.parse().ok()).unwrap_or(30);
    let page: usize = request.query("page").and_then(|v| v.parse().ok()).unwrap_or(1).max(1);
    let start = (page - 1) * per_page;
    let items: Vec<u64> = numbers.iter().copied().skip(start).take(per_page).collect();
    let more = start + per_page < numbers.len();
    let next = more.then(|| {
        let mut query: Vec<String> = request.target.split_once('?').map(|(_, q)| q).unwrap_or("").split('&').filter(|p| !p.is_empty() && !p.starts_with("page=")).map(str::to_string).collect();
        query.push(format!("page={}", page + 1));
        (format!("<{}{}?{}>; rel=\"next\"", origin(request), request.path(), query.join("&")), page as u64 + 1)
    });
    (items, next)
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
