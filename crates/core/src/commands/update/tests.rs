//! Tests of the update check against the local test server (`testkit::MockServer`). No call
//! leaves this computer: `TestCore` turns the check off, every test points it at its own server.

use std::time::Duration;

use serde_json::{json, Value};

use super::*;
use crate::commands::settings::settings_set;
use crate::db;
use crate::error::ErrorCode;
use crate::http;
use crate::testkit::{MockResponse, MockServer, TestCore};

const ROUTE: &str = "GET /repos/abgebaumt/forkyard/releases/latest";

fn current() -> semver::Version {
    semver::Version::parse(current_version()).unwrap()
}

/// A version above the current one.
fn newer() -> String {
    let v = current();
    format!("{}.{}.0", v.major, v.minor + 1)
}

fn page(version: &str) -> String {
    format!("https://github.com/abgebaumt/forkyard/releases/tag/v{version}")
}

fn release(tag: &str, url: &str) -> Value {
    json!({
        "tag_name": tag,
        "name": format!("Forkyard {tag}"),
        "html_url": url,
        "body": "## What's new\n\n- **Faster** graph\n- Update check",
        "published_at": "2026-11-02T09:30:00Z",
        "draft": false,
        "prerelease": false,
    })
}

/// Server that always answers with `response`; the core of `tc` asks it.
fn serve(tc: &TestCore, response: MockResponse) -> MockServer {
    let server = MockServer::start(move |request| match request.route().as_str() {
        ROUTE => response.clone(),
        _ => MockResponse::json(404, json!({ "message": "Not Found" })),
    });
    point_at(tc, &server);
    server
}

fn point_at(tc: &TestCore, server: &MockServer) {
    configure(tc, Some(server.url()));
    http::configure(tc, |options| {
        options.backoff = Duration::from_millis(5);
        options.timeout = Duration::from_secs(5);
    });
}

fn stored(tc: &TestCore) -> StoredState {
    tc.db
        .with(|c| Ok(db::app_settings::get_all(c)?.into_iter().find(|(key, _)| key == STATE_KEY).map(|(_, value)| value)))
        .unwrap()
        .map(|value| serde_json::from_value(value).unwrap())
        .unwrap_or_default()
}

fn store(tc: &TestCore, state: &StoredState) {
    tc.db.with(|c| db::app_settings::set(c, STATE_KEY, &serde_json::to_value(state).unwrap())).unwrap();
}

#[tokio::test]
async fn a_newer_stable_release_is_reported() {
    let tc = TestCore::new().await;
    let version = newer();
    let server = serve(&tc, MockResponse::json(200, release(&format!("v{version}"), &page(&version))));
    let info = update_check(&tc, false).await.unwrap();
    assert_eq!(info.current, current_version());
    let latest = info.latest.expect("newer release");
    assert_eq!(latest.version, version);
    assert_eq!(latest.url, page(&version));
    assert!(latest.notes.contains("Faster"), "{}", latest.notes);
    assert_eq!(latest.published_at.as_deref(), Some("2026-11-02T09:30:00Z"));
    assert!(info.checked_at.is_some());
    assert_eq!(server.count(ROUTE), 1);
}

#[tokio::test]
async fn a_tag_without_v_prefix_counts_too() {
    let tc = TestCore::new().await;
    let version = newer();
    let _server = serve(&tc, MockResponse::json(200, release(&version, &page(&version))));
    assert_eq!(update_check(&tc, true).await.unwrap().latest.map(|r| r.version), Some(version));
}

#[tokio::test]
async fn the_same_or_an_older_version_is_up_to_date() {
    for tag in [format!("v{}", current_version()), current_version().to_string(), "v0.0.1".to_string()] {
        let tc = TestCore::new().await;
        let _server = serve(&tc, MockResponse::json(200, release(&tag, &page(&tag))));
        let info = update_check(&tc, true).await.unwrap();
        assert_eq!(info.latest, None, "{tag}");
        assert!(info.checked_at.is_some());
    }
}

#[tokio::test]
async fn unparsable_and_prerelease_tags_are_ignored() {
    let next = newer();
    for tag in ["nightly", "v1.2", "release-9", "v99.0.0-rc.1", "99.0.0-beta", ""] {
        let tc = TestCore::new().await;
        let _server = serve(&tc, MockResponse::json(200, release(tag, &page(&next))));
        assert_eq!(update_check(&tc, true).await.unwrap().latest, None, "{tag:?}");
    }
}

#[tokio::test]
async fn releases_marked_as_draft_or_prerelease_are_ignored() {
    let version = newer();
    for flag in ["draft", "prerelease"] {
        let tc = TestCore::new().await;
        let mut body = release(&format!("v{version}"), &page(&version));
        body[flag] = json!(true);
        let _server = serve(&tc, MockResponse::json(200, body));
        assert_eq!(update_check(&tc, true).await.unwrap().latest, None, "{flag}");
    }
}

#[tokio::test]
async fn no_release_yet_is_up_to_date() {
    let tc = TestCore::new().await;
    let server = serve(&tc, MockResponse::json(404, json!({ "message": "Not Found" })));
    let info = update_check(&tc, true).await.unwrap();
    assert_eq!(info.latest, None);
    assert!(info.checked_at.is_some());
    assert_eq!(server.count(ROUTE), 1);
}

#[tokio::test]
async fn the_rate_limit_is_its_own_error_code() {
    for response in [
        MockResponse::json(403, json!({ "message": "API rate limit exceeded" })).header("x-ratelimit-remaining", "0").header("x-ratelimit-reset", "1900000000"),
        MockResponse::json(403, json!({ "message": "Forbidden" })),
        MockResponse::json(429, json!({ "message": "Too many requests" })).header("retry-after", "60"),
    ] {
        let tc = TestCore::new().await;
        let _server = serve(&tc, response.clone());
        let error = update_check(&tc, false).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::HostRateLimited, "{} {error:?}", response.status);
        // The attempt counts: the automatic check does not ask again the same day.
        assert!(stored(&tc).checked_at.is_some());
    }
}

#[tokio::test]
async fn server_errors_and_no_connection_are_errors() {
    let tc = TestCore::new().await;
    let _server = serve(&tc, MockResponse::json(500, json!({ "message": "boom" })));
    assert_eq!(update_check(&tc, true).await.unwrap_err().code, ErrorCode::Unknown);

    let tc = TestCore::new().await;
    let server = serve(&tc, MockResponse::empty(200));
    let url = server.url();
    drop(server);
    configure(&tc, Some(url));
    let error = update_check(&tc, true).await.unwrap_err();
    assert!(matches!(error.code, ErrorCode::Offline | ErrorCode::Timeout), "{error:?}");
}

#[tokio::test]
async fn a_release_page_outside_the_project_is_rejected() {
    let version = newer();
    for url in [
        "https://evil.example/abgebaumt/forkyard/releases/tag/v9.0.0".to_string(),
        "https://github.com/abgebaumt/forkyard-evil/releases/tag/v9.0.0".to_string(),
        "https://github.com/someone/forkyard/releases/tag/v9.0.0".to_string(),
        "http://github.com/abgebaumt/forkyard/releases/tag/v9.0.0".to_string(),
        "https://github.com.evil.example/abgebaumt/forkyard/releases/tag/v9.0.0".to_string(),
        "https://github.com/abgebaumt/forkyard/releases/tag/v9 0".to_string(),
        "javascript:alert(1)".to_string(),
        "https://github.com/abgebaumt/forkyard/../evil/releases".to_string(),
        "https://github.com/abgebaumt/forkyard/%2e%2e/evil/releases".to_string(),
    ] {
        let tc = TestCore::new().await;
        let _server = serve(&tc, MockResponse::json(200, release(&format!("v{version}"), &url)));
        let result = update_check(&tc, true).await;
        assert!(result.is_err(), "{url} must be rejected: {result:?}");
        assert_eq!(stored(&tc).release, None, "{url} is not remembered");
    }
}

#[tokio::test]
async fn the_request_carries_only_the_version() {
    let tc = TestCore::new().await;
    let server = serve(&tc, MockResponse::json(404, json!({ "message": "Not Found" })));
    update_check(&tc, true).await.unwrap();
    let requests = server.requests();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert_eq!(request.target, "/repos/abgebaumt/forkyard/releases/latest", "no parameters");
    assert_eq!(request.header("user-agent"), Some(format!("Forkyard/{}", current_version()).as_str()));
    assert_eq!(request.header("accept"), Some("application/vnd.github+json"));
    assert_eq!(request.header("authorization"), None);
    assert_eq!(request.header("cookie"), None);
    assert!(request.body.is_empty());
}

#[tokio::test]
async fn no_request_when_the_setting_is_off_unless_manual() {
    let tc = TestCore::new().await;
    let version = newer();
    let server = serve(&tc, MockResponse::json(200, release(&format!("v{version}"), &page(&version))));
    settings_set(&tc, json!({ "checkForUpdates": false })).await.unwrap();
    let info = update_check(&tc, false).await.unwrap();
    assert_eq!(server.count(ROUTE), 0, "automatic check with the setting off");
    assert_eq!(info.latest, None);
    assert_eq!(info.current, current_version());

    let info = update_check(&tc, true).await.unwrap();
    assert_eq!(server.count(ROUTE), 1, "a manual check always asks");
    assert_eq!(info.latest.map(|r| r.version), Some(version));
}

#[tokio::test]
async fn the_automatic_check_runs_once_a_day_across_restarts() {
    let tc = TestCore::new().await;
    let version = newer();
    let response = MockResponse::json(200, release(&format!("v{version}"), &page(&version)));
    let server = serve(&tc, response);
    assert!(update_check(&tc, false).await.unwrap().latest.is_some());
    assert_eq!(server.count(ROUTE), 1);
    let again = update_check(&tc, false).await.unwrap();
    assert_eq!(server.count(ROUTE), 1, "the same day: no second request");
    assert_eq!(again.latest.map(|r| r.version), Some(version.clone()), "the remembered result counts");

    let tc = tc.restart().await;
    point_at(&tc, &server);
    let after_restart = update_check(&tc, false).await.unwrap();
    assert_eq!(server.count(ROUTE), 1, "a restart does not ask again");
    assert_eq!(after_restart.latest.map(|r| r.version), Some(version.clone()));

    // A day later it asks again.
    let mut state = stored(&tc);
    state.checked_at = Some(crate::util::unix_to_iso(chrono::Utc::now().timestamp() - 25 * 3600));
    store(&tc, &state);
    update_check(&tc, false).await.unwrap();
    assert_eq!(server.count(ROUTE), 2);

    // A manual check always asks.
    update_check(&tc, true).await.unwrap();
    assert_eq!(server.count(ROUTE), 3);
}

#[tokio::test]
async fn simultaneous_automatic_checks_ask_only_once() {
    let tc = TestCore::new().await;
    let server = serve(&tc, MockResponse::json(404, json!({ "message": "Not Found" })).delay(Duration::from_millis(200)));
    let (a, b) = tokio::join!(update_check(&tc, false), update_check(&tc, false));
    a.unwrap();
    b.unwrap();
    assert_eq!(server.count(ROUTE), 1);
}

#[tokio::test]
async fn seen_and_skipped_versions_are_remembered() {
    let tc = TestCore::new().await;
    let version = newer();
    let server = serve(&tc, MockResponse::json(200, release(&format!("v{version}"), &page(&version))));
    update_check(&tc, false).await.unwrap();

    let info = update_dismiss(&tc, version.clone(), false).await.unwrap();
    assert_eq!(info.notified_version.as_deref(), Some(version.as_str()));
    assert_eq!(info.skipped_version, None);
    assert!(info.latest.is_some(), "seen is not skipped");

    let info = update_dismiss(&tc, version.clone(), true).await.unwrap();
    assert_eq!(info.skipped_version.as_deref(), Some(version.as_str()));

    let tc = tc.restart().await;
    point_at(&tc, &server);
    let info = update_check(&tc, false).await.unwrap();
    assert_eq!(info.notified_version.as_deref(), Some(version.as_str()));
    assert_eq!(info.skipped_version.as_deref(), Some(version.as_str()));

    for junk in ["", "latest", "1.2", "../1.2.0"] {
        assert_eq!(update_dismiss(&tc, junk.to_string(), true).await.unwrap_err().code, ErrorCode::NotAllowed, "{junk:?}");
    }
}

#[tokio::test]
async fn long_release_notes_are_shortened() {
    let tc = TestCore::new().await;
    let version = newer();
    let mut body = release(&format!("v{version}"), &page(&version));
    body["body"] = json!("ä".repeat(10_000));
    let _server = serve(&tc, MockResponse::json(200, body));
    let notes = update_check(&tc, true).await.unwrap().latest.unwrap().notes;
    assert!(notes.len() <= NOTES_MAX + 8, "{}", notes.len());
    assert!(notes.starts_with("ää"));
}

#[tokio::test]
async fn test_cores_never_ask_github() {
    let tc = TestCore::new().await;
    let info = update_check(&tc, true).await.unwrap();
    assert_eq!(info.latest, None);
    assert_eq!(info.checked_at, None, "turned off: nothing was asked");
}
