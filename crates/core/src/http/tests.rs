//! Tests of the HTTP client against the local test server (`testkit::MockServer`). No call
//! leaves this computer.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use super::*;
use crate::commands::settings::settings_set;
use crate::model::{ActivityEntry, ActivityScope, HostProxy};
use crate::testkit::{MockResponse, MockServer, TestCore, TunnelProxy};

const SECRET: &str = "geheimes-token-0123456789";

/// The log entries of the HTTP calls (without the core's Git calls).
fn log(tc: &TestCore) -> Vec<ActivityEntry> {
    let all = tc.db.with(|c| db::activity::page(c, ActivityScope::App, None, None, 200)).unwrap().entries;
    all.into_iter().filter(|e| ["GET ", "POST ", "PUT ", "PATCH ", "DELETE "].iter().any(|method| e.command.starts_with(method))).collect()
}

/// Fast retries so the tests don't wait.
fn fast(tc: &TestCore) {
    configure(tc, |options| {
        options.backoff = Duration::from_millis(5);
        options.timeout = Duration::from_secs(5);
    });
}

#[tokio::test]
async fn sends_headers_reads_json_and_logs_without_secrets() {
    let tc = TestCore::new().await;
    fast(&tc);
    let server = MockServer::start(|request| match request.route().as_str() {
        "GET /api/ding" => MockResponse::json(200, json!({ "name": "Ding", "wert": 3 })).header("x-ratelimit-remaining", "4999"),
        _ => MockResponse::empty(404),
    });
    let url = with_query(&format!("{}/api/ding", server.url()), &[("suche", "a b&c".into())]);
    let request = Request::get(&url, "Testdienst").secret_header("authorization", format!("Bearer {SECRET}"), SECRET).header("accept", "application/json");
    let response = send(&tc, request).await.unwrap();
    assert_eq!(response.status, 200);
    assert!(response.is_success() && !response.from_cache);
    let value: serde_json::Value = response.json().unwrap();
    assert_eq!(value["wert"], 3);
    assert_eq!(response.rate_limit().remaining, Some(4999));

    let seen = server.requests();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].header("user-agent"), Some(USER_AGENT));
    assert_eq!(seen[0].header("authorization"), Some(format!("Bearer {SECRET}").as_str()));
    assert_eq!(seen[0].query("suche").as_deref(), Some("a b&c"), "parameters are encoded: {}", seen[0].target);

    // In the log: method, address, status – but neither headers nor the secret.
    let entries = log(&tc);
    let entry = entries.iter().find(|e| e.command.starts_with("GET ")).expect("log entry");
    assert_eq!(entry.command, format!("GET {url}"));
    assert_eq!(entry.exit_code, Some(0));
    assert!(entry.output.contains("HTTP 200") && entry.output.contains("Remaining requests: 4999"), "{}", entry.output);
    assert!(entries.iter().all(|e| !e.command.contains(SECRET) && !e.output.contains(SECRET)));
    assert!(tc.events.named(names::LOG_APPENDED).iter().any(|event| event["command"] == format!("GET {url}")), "the entry also arrives as an event");
}

#[tokio::test]
async fn only_reads_are_retried() {
    let tc = TestCore::new().await;
    fast(&tc);
    let hits = Arc::new(AtomicUsize::new(0));
    let server = {
        let hits = hits.clone();
        MockServer::start(move |request| {
            let n = hits.fetch_add(1, Ordering::SeqCst);
            match (request.method.as_str(), n) {
                // Twice "unavailable", then it works.
                ("GET", 0 | 1) => MockResponse::empty(503),
                ("GET", _) => MockResponse::json(200, json!({ "ok": true })),
                _ => MockResponse::json(503, json!({ "message": "später" })),
            }
        })
    };
    let response = send(&tc, Request::get(format!("{}/x", server.url()), "Testdienst")).await.unwrap();
    assert_eq!(response.status, 200);
    assert_eq!(server.count("GET /x"), 3);
    assert!(log(&tc).iter().any(|e| e.output.contains("Attempts: 3")));

    // Writing calls run exactly once – a duplicate POST could create things twice.
    for method in [Method::Post, Method::Put, Method::Patch, Method::Delete] {
        server.clear();
        let response = send(&tc, Request::new(method, format!("{}/schreiben", server.url()), "Testdienst").json(&json!({ "a": 1 }))).await.unwrap();
        assert_eq!(response.status, 503);
        let seen = server.requests();
        assert_eq!(seen.len(), 1, "{method:?}");
        assert_eq!(seen[0].json(), json!({ "a": 1 }), "{method:?} sends the body");
        assert_eq!(seen[0].header("content-type"), Some("application/json"));
    }
    // 4xx is never retried.
    let server = MockServer::start(|_| MockResponse::json(404, json!({ "message": "Not Found" })));
    assert_eq!(send(&tc, Request::get(format!("{}/fehlt", server.url()), "Testdienst")).await.unwrap().status, 404);
    assert_eq!(server.requests().len(), 1);
}

#[tokio::test]
async fn timeouts_and_unreachable_hosts_become_clear_errors() {
    let tc = TestCore::new().await;
    configure(&tc, |options| {
        options.timeout = Duration::from_millis(300);
        options.connect_timeout = Duration::from_millis(300);
        options.retries = 1;
        options.backoff = Duration::from_millis(5);
    });
    let server = MockServer::start(|_| MockResponse::json(200, json!({})).delay(Duration::from_millis(1500)));
    let error = send(&tc, Request::get(format!("{}/langsam", server.url()), "Testdienst").secret_header("authorization", SECRET, SECRET)).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Timeout);
    assert!(error.message.contains("Timeout") && error.message.contains("Testdienst"), "{}", error.message);
    assert_eq!(server.requests().len(), 2, "a reading call is retried once");
    let entry = log(&tc).into_iter().find(|e| e.command.contains("/langsam")).unwrap();
    assert_eq!((entry.exit_code, entry.code), (None, Some(ErrorCode::Timeout)));

    // A port nobody listens on (Windows needs about two seconds for the refusal).
    configure(&tc, |options| {
        options.timeout = Duration::from_secs(20);
        options.connect_timeout = Duration::from_secs(20);
        options.retries = 0;
    });
    let free = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let error = send(&tc, Request::get(format!("http://127.0.0.1:{free}/x"), "Testdienst")).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Offline, "{error:?}");
    assert!(error.message.contains("not reachable"), "{}", error.message);
}

#[tokio::test]
async fn oversized_and_broken_answers_are_refused() {
    let tc = TestCore::new().await;
    fast(&tc);
    configure(&tc, |options| options.max_body = 2000);
    let server = MockServer::start(|request| match request.path() {
        "/gross" => MockResponse::raw(200, vec![b'a'; 50_000]),
        "/kaputt" => MockResponse::raw(200, "{\"name\": \"abgeschnit"),
        "/html" => MockResponse::raw(200, "<html>Wartungsarbeiten</html>"),
        _ => MockResponse::json(200, json!([1, 2, 3])),
    });
    let error = send(&tc, Request::get(format!("{}/gross", server.url()), "Testdienst")).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Unknown);
    assert!(error.message.contains("too large"), "{}", error.message);
    assert_eq!(server.requests().len(), 1, "a response that is too large is not fetched again");

    for path in ["/kaputt", "/html"] {
        let response = send(&tc, Request::get(format!("{}{path}", server.url()), "Testdienst")).await.unwrap();
        let error = response.json::<serde_json::Value>().unwrap_err();
        assert_eq!(error.code, ErrorCode::Unknown, "{path}");
        assert!(error.message.contains("could not be read") && error.message.contains("Testdienst"), "{}", error.message);
        assert!(!error.message.contains("abgeschnit") && !error.message.contains("Wartung"), "the body is not quoted: {}", error.message);
    }
    // Readable, but structured differently than expected.
    #[derive(Debug, serde::Deserialize)]
    struct Ding {
        #[allow(dead_code)]
        name: String,
    }
    let response = send(&tc, Request::get(format!("{}/liste", server.url()), "Testdienst")).await.unwrap();
    assert!(response.json::<Ding>().unwrap_err().message.contains("unexpected structure"));
}

#[tokio::test]
async fn etags_turn_repeated_reads_into_conditional_requests() {
    let tc = TestCore::new().await;
    fast(&tc);
    let server = MockServer::start(|request| match request.header("if-none-match") {
        Some("\"v1\"") => MockResponse::empty(304).header("x-ratelimit-remaining", "58"),
        _ => MockResponse::json(200, json!({ "stand": 1 })).header("etag", "\"v1\"").header("x-ratelimit-remaining", "59").header("link", "<http://x/y?page=2>; rel=\"next\""),
    });
    let url = format!("{}/daten", server.url());
    let first = send(&tc, Request::get(&url, "Testdienst").cached("konto-a")).await.unwrap();
    assert!(!first.from_cache);
    let second = send(&tc, Request::get(&url, "Testdienst").cached("konto-a")).await.unwrap();
    assert!(second.from_cache);
    assert_eq!((second.status, second.body.clone()), (200, first.body.clone()));
    assert_eq!(second.rate_limit().remaining, Some(58), "limits come from the new response");
    assert_eq!(second.next_page(), Some(2), "cached headers (Link) are kept");
    let seen = server.requests();
    assert_eq!(seen[0].header("if-none-match"), None);
    assert_eq!(seen[1].header("if-none-match"), Some("\"v1\""));
    assert!(log(&tc).iter().any(|e| e.output.contains("not modified")));

    // Another account (different token) doesn't share the cache; without `cached` nothing is remembered.
    server.clear();
    assert!(!send(&tc, Request::get(&url, "Testdienst").cached("konto-b")).await.unwrap().from_cache);
    assert!(!send(&tc, Request::get(&url, "Testdienst")).await.unwrap().from_cache);
    assert!(server.requests().iter().all(|r| r.header("if-none-match").is_none()));
    // After clearing, the full response is fetched again.
    clear_cache(&tc);
    server.clear();
    assert!(!send(&tc, Request::get(&url, "Testdienst").cached("konto-a")).await.unwrap().from_cache);
}

fn response_with(status: u16, headers: &[(&str, &str)]) -> Response {
    Response { status, headers: headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), body: Vec::new(), from_cache: false, label: "Testdienst".into() }
}

#[test]
fn rate_limit_headers_of_both_hosters_are_understood() {
    // GitHub: 403 with an exhausted limit and the reset time.
    let hub = response_with(403, &[("x-ratelimit-remaining", "0"), ("x-ratelimit-reset", "1791720000")]);
    assert!(hub.is_rate_limited());
    assert_eq!(hub.rate_limit(), RateLimit { remaining: Some(0), reset_at: Some(1_791_720_000), retry_after: None });
    assert_eq!(hub.retry_at().as_deref(), Some(util::unix_to_iso(1_791_720_000).as_str()));
    // GitHub, secondary limit: 403 with a wait time.
    let secondary = response_with(403, &[("retry-after", "60"), ("x-ratelimit-remaining", "4000")]);
    assert!(secondary.is_rate_limited());
    assert!(secondary.retry_at().is_some());
    // GitLab: 429 with `RateLimit-*` (names arrive in lower case).
    let lab = response_with(429, &[("ratelimit-remaining", "0"), ("ratelimit-reset", "1791720600"), ("retry-after", "30")]);
    assert!(lab.is_rate_limited());
    assert_eq!(lab.rate_limit().reset_at, Some(1_791_720_600));
    // An ordinary 403 is not a limit.
    assert!(!response_with(403, &[("x-ratelimit-remaining", "4999")]).is_rate_limited());
    assert!(!response_with(403, &[]).is_rate_limited());
    assert_eq!(response_with(200, &[]).retry_at(), None);
}

#[test]
fn link_headers_give_the_next_page() {
    let both = response_with(
        200,
        &[("link", "<https://api.github.com/repositories/1/pulls?state=open&page=1>; rel=\"prev\", <https://api.github.com/repositories/1/pulls?state=open&page=3>; rel=\"next\", <https://api.github.com/repositories/1/pulls?page=9>; rel=\"last\"")],
    );
    assert_eq!(both.next_url().as_deref(), Some("https://api.github.com/repositories/1/pulls?state=open&page=3"));
    assert_eq!(both.next_page(), Some(3));
    let last = response_with(200, &[("link", "<https://x/y?page=1>; rel=\"first\", <https://x/y?page=2>; rel=\"prev\"")]);
    assert_eq!((last.next_url(), last.next_page()), (None, None));
    // GitLab additionally names the next page directly; empty means the end.
    assert_eq!(response_with(200, &[("x-next-page", "4")]).next_page(), Some(4));
    assert_eq!(response_with(200, &[("x-next-page", "")]).next_page(), None);
    assert_eq!(response_with(200, &[]).next_page(), None);
}

#[tokio::test]
async fn plain_http_is_only_allowed_to_this_machine() {
    let tc = TestCore::new().await;
    let error = send(&tc, Request::get("http://git.firma.example/api/v4/user", "GitLab").secret_header("authorization", SECRET, SECRET)).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::NotAllowed);
    assert!(error.message.contains("Unencrypted"), "{}", error.message);
    for bad in ["ftp://x/y", "kein-schema", "https://lena:pw@host/x", "https:///x"] {
        assert_eq!(send(&tc, Request::get(bad, "Testdienst")).await.unwrap_err().code, ErrorCode::NotAllowed, "{bad}");
    }
    assert!(log(&tc).is_empty(), "refused calls don't go out and are not in the log");
    assert!(Target::parse("http://localhost:8080/x").unwrap().loopback);
    assert!(Target::parse("http://[::1]:8080/x").unwrap().loopback);
    assert!(!Target::parse("https://api.github.com/user").unwrap().loopback);
    assert_eq!(Target::parse("HTTPS://API.GitHub.com:443/user?x=1").unwrap().base, "https://api.github.com:443");
}

#[test]
fn routes_follow_the_network_settings() {
    let api = Target::parse("https://api.github.com/user").unwrap();
    let local = Target::parse("http://127.0.0.1:8123/x").unwrap();
    let none = Settings::default();
    assert_eq!(Route::pick(&none, &api, &[]), Route { proxy: ProxyChoice::Environment, verify: true, ca_file: None });
    assert_eq!(Route::pick(&none, &local, &[]).proxy, ProxyChoice::Direct, "never through a proxy from the environment to this computer");

    let settings = Settings {
        proxy_url: Some("http://proxy.firma.example:8080".into()),
        proxy_by_host: vec![
            HostProxy { host: "https://github.com".into(), proxy: "socks5://127.0.0.1:1080".into() },
            HostProxy { host: "https://git.intern.example".into(), proxy: String::new() },
        ],
        ssl_ca_file: Some("C:/zertifikate/firma.pem".into()),
        ssl_no_verify_hosts: vec!["https://git.intern.example".into()],
        ..Settings::default()
    };
    // Through the alias, the entry for github.com also applies to api.github.com.
    let hub = Route::pick(&settings, &api, &["https://github.com".to_string()]);
    assert_eq!(hub.proxy, ProxyChoice::Url("socks5://127.0.0.1:1080".into()));
    assert!(hub.verify);
    assert_eq!(hub.ca_file.as_deref(), Some("C:/zertifikate/firma.pem"));
    // Without the alias the global proxy applies.
    assert_eq!(Route::pick(&settings, &api, &[]).proxy, ProxyChoice::Url("http://proxy.firma.example:8080".into()));
    // Per-host exception: no proxy, certificate verification off for exactly this host only.
    let intern = Route::pick(&settings, &Target::parse("https://git.intern.example/api/v4/user").unwrap(), &[]);
    assert_eq!((intern.proxy.clone(), intern.verify), (ProxyChoice::Direct, false));
    assert!(intern.notes().iter().any(|n| n.contains("Certificate verification")));
    assert!(Route::pick(&settings, &Target::parse("https://anderer.intern.example/x").unwrap(), &[]).verify);
    // The global proxy does not apply to this computer.
    assert_eq!(Route::pick(&settings, &local, &[]).proxy, ProxyChoice::Direct);
    // A proxy's credentials never appear in the log lines.
    let with_password = Route { proxy: ProxyChoice::Url("http://anna:geheim@proxy:8080".into()), verify: true, ca_file: None };
    assert_eq!(with_password.secrets(), vec!["geheim".to_string()]);
    assert!(with_password.notes().iter().all(|n| !n.contains("geheim") && !n.contains("anna")), "{:?}", with_password.notes());
}

#[tokio::test]
async fn proxy_from_the_settings_is_used_and_its_password_comes_from_the_keyring() {
    let tc = TestCore::new().await;
    fast(&tc);
    let target = MockServer::start(|_| MockResponse::json(200, json!({ "direkt": true })));
    // The test proxy accepts CONNECT and tunnels through – that's how ureq talks to any HTTP proxy.
    let proxy = TunnelProxy::start();
    let proxy_url = format!("http://anna:streng-geheim@127.0.0.1:{}", proxy.port());
    let settings = settings_set(&tc, json!({ "proxyByHost": [{ "host": target.url(), "proxy": proxy_url }] })).await.unwrap();
    // The UI gets the address without the password; it isn't in the database either.
    assert_eq!(settings.proxy_by_host[0].proxy, format!("http://anna@127.0.0.1:{}", proxy.port()));
    let profile_id = tc.active_profile_id().unwrap();
    let stored = tc.db.with(|c| db::settings::get_all(c, &profile_id)).unwrap();
    assert!(!format!("{stored:?}").contains("streng-geheim"));
    assert!(tc.secrets.snapshot().iter().any(|(account, secret)| account.starts_with("proxy:") && secret == "streng-geheim"));

    let response = send(&tc, Request::get(format!("{}/api/x", target.url()), "Testdienst")).await.unwrap();
    assert_eq!(response.json::<serde_json::Value>().unwrap()["direkt"], true);
    let seen = proxy.requests();
    assert_eq!(seen.len(), 1, "the call went through the proxy");
    assert_eq!((seen[0].method.as_str(), seen[0].target.clone()), ("CONNECT", format!("127.0.0.1:{}", target.port())));
    // base64("anna:streng-geheim")
    assert_eq!(seen[0].header("proxy-authorization"), Some("Basic YW5uYTpzdHJlbmctZ2VoZWlt"));
    assert_eq!(target.count("GET /api/x"), 1);
    let entries = log(&tc);
    assert!(entries.iter().any(|e| e.output.contains("Proxy: http://***@127.0.0.1")), "{entries:?}");
    assert!(entries.iter().all(|e| !e.output.contains("streng-geheim") && !e.command.contains("streng-geheim")));

    // Sent back unchanged (without password, as the core delivers the address): the stored one is kept.
    settings_set(&tc, json!({ "proxyByHost": [{ "host": target.url(), "proxy": format!("http://anna@127.0.0.1:{}", proxy.port()) }] })).await.unwrap();
    proxy.clear();
    send(&tc, Request::get(format!("{}/api/x", target.url()), "Testdienst")).await.unwrap();
    assert_eq!(proxy.requests()[0].header("proxy-authorization"), Some("Basic YW5uYTpzdHJlbmctZ2VoZWlt"));

    // Entry with an empty proxy: no proxy for this host – even if there is a global one.
    settings_set(&tc, json!({ "proxyUrl": format!("http://127.0.0.1:{}", proxy.port()), "proxyByHost": [{ "host": target.url(), "proxy": "" }] })).await.unwrap();
    proxy.clear();
    target.clear();
    send(&tc, Request::get(format!("{}/api/x", target.url()), "Testdienst")).await.unwrap();
    assert!(proxy.requests().is_empty());
    assert_eq!(target.count("GET /api/x"), 1);
    assert!(tc.secrets.snapshot().iter().all(|(account, _)| !account.starts_with("proxy:")), "the password of the removed entry is deleted");
}

/// A proxy password that an older version stored in plain text is moved on start.
#[tokio::test]
async fn stored_proxy_passwords_move_to_the_keyring_on_start() {
    let tc = TestCore::new().await;
    let profile_id = tc.active_profile_id().unwrap();
    tc.db
        .with(|c| {
            db::settings::set(c, &profile_id, "proxyUrl", &json!("http://anna:alt-geheim@proxy.firma.example:8080"))?;
            db::settings::set(c, &profile_id, "proxyByHost", &json!([{ "host": "https://git.intern.example", "proxy": "socks5://bob:auch-geheim@127.0.0.1:1080" }, { "host": "https://frei.example", "proxy": "" }]))
        })
        .unwrap();
    let tc = tc.restart().await;
    let stored = format!("{:?}", tc.db.with(|c| db::settings::get_all(c, &profile_id)).unwrap());
    assert!(!stored.contains("geheim"), "{stored}");
    assert!(stored.contains("http://anna@proxy.firma.example:8080") && stored.contains("socks5://bob@127.0.0.1:1080"), "{stored}");
    let secrets = tc.secrets.snapshot();
    assert!(secrets.contains(&(format!("proxy:{profile_id}:global"), "alt-geheim".to_string())), "{secrets:?}");
    assert!(secrets.contains(&(format!("proxy:{profile_id}:https://git.intern.example"), "auch-geheim".to_string())), "{secrets:?}");
    // The UI sees the addresses without the password …
    let shown = crate::commands::settings::settings_get(&tc).await.unwrap();
    assert_eq!(shown.proxy_url.as_deref(), Some("http://anna@proxy.firma.example:8080"));
    // … Git and the HTTP client get them with it.
    let effective = tc.git.network_settings();
    assert_eq!(effective.proxy_url.as_deref(), Some("http://anna:alt-geheim@proxy.firma.example:8080"));
    assert_eq!(effective.proxy_by_host[0].proxy, "socks5://bob:auch-geheim@127.0.0.1:1080");
    assert!(tc.git.network_config().notes.iter().all(|note| !note.contains("geheim")));
    // A second start changes nothing more and loads the passwords again.
    let tc = tc.restart().await;
    assert_eq!(tc.git.network_settings().proxy_url.as_deref(), Some("http://anna:alt-geheim@proxy.firma.example:8080"));
    // Deleting the profile removes its entries.
    let other = crate::commands::settings::profile_save(&tc, None, "Zweites".into(), "".into(), "".into(), false, None).await.unwrap();
    let other_id = other.iter().find(|p| p.name == "Zweites").unwrap().id.clone();
    crate::commands::settings::profile_activate(&tc, other_id).await.unwrap();
    crate::commands::settings::profile_delete(&tc, profile_id.clone()).await.unwrap();
    assert!(tc.secrets.snapshot().iter().all(|(account, _)| !account.contains(&profile_id)), "{:?}", tc.secrets.snapshot());
}

#[tokio::test]
async fn a_broken_ca_bundle_is_reported_before_anything_is_sent() {
    let tc = TestCore::new().await;
    let dir = tempfile::tempdir().unwrap();
    let empty = dir.path().join("leer.pem");
    std::fs::write(&empty, "kein Zertifikat\n").unwrap();
    settings_set(&tc, json!({ "sslCaFile": empty.to_string_lossy() })).await.unwrap();
    let server = MockServer::start(|_| MockResponse::json(200, json!({})));
    let error = send(&tc, Request::get(format!("{}/x", server.url()), "Testdienst")).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::NotAllowed);
    assert!(error.message.contains("no certificate"), "{}", error.message);
    std::fs::remove_file(&empty).unwrap();
    let error = send(&tc, Request::get(format!("{}/x", server.url()), "Testdienst")).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::PathNotFound);
    assert!(server.requests().is_empty());
}

#[test]
fn values_are_encoded_for_urls() {
    assert_eq!(encode("gruppe/unter gruppe/projekt"), "gruppe%2Funter%20gruppe%2Fprojekt");
    assert_eq!(encode("a-b_c.d~e"), "a-b_c.d~e");
    assert_eq!(encode("ä&=?#"), "%C3%A4%26%3D%3F%23");
    assert_eq!(with_query("https://x/y", &[]), "https://x/y");
    assert_eq!(with_query("https://x/y?a=1", &[("b", "2 3".into())]), "https://x/y?a=1&b=2%203");
}

#[tokio::test]
async fn a_body_can_carry_its_own_json_media_type() {
    let tc = TestCore::new().await;
    fast(&tc);
    let server = MockServer::start(|_| MockResponse::json(200, json!({ "id": 1 })));
    let patch = json!([{ "op": "add", "path": "/fields/System.Title", "value": "Neu" }]);
    send(&tc, Request::new(Method::Post, format!("{}/patch", server.url()), "Testdienst").json_with_type(&patch, "application/json-patch+json")).await.unwrap();
    let seen = server.requests();
    assert_eq!(seen[0].header("content-type"), Some("application/json-patch+json"));
    assert_eq!(seen[0].headers.iter().filter(|(name, _)| name == "content-type").count(), 1, "exactly one content type");
    assert_eq!(seen[0].json(), patch);
}

/// Basic authentication sends the token encoded (`user:token` in base64): that form must not reach
/// the log either.
#[tokio::test]
async fn extra_secrets_are_removed_from_the_log_as_well() {
    let tc = TestCore::new().await;
    fast(&tc);
    let server = MockServer::start(|_| MockResponse::json(200, json!({})));
    let encoded = "bGVuYTpnZWhlaW0tMDEyMzQ1Njc4OQ";
    send(&tc, Request::get(format!("{}/x?echo={encoded}", server.url()), "Testdienst").secret(encoded)).await.unwrap();
    let entries = log(&tc);
    assert_eq!(entries.len(), 1);
    assert!(!entries[0].command.contains(encoded) && !entries[0].output.contains(encoded), "{:?}", entries[0]);
    assert!(entries[0].command.contains("***"), "{}", entries[0].command);
}
