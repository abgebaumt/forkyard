//! Tests of the host integration against the local test server. The responses are hand-written,
//! in the shape of the public documentation of GitHub (REST) and GitLab (REST v4) – no real
//! data, no call leaves this computer.

mod github_tests;
mod gitlab_tests;
mod mocks;

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;

use crate::commands::host as cmd;
use crate::db;
use crate::error::{CoreError, ErrorCode};
use crate::events::names;
use crate::http;
use crate::model::{ActivityScope, HostKind, HosterAccount};
use crate::testkit::{MockRequest, MockServer, TestCore, TestRepo};

/// A token as it might look – entirely made up.
pub(crate) const TOKEN: &str = "ghp_FreiErfundenesTestToken0123456789abcd";
/// Valid, but with too few permissions.
pub(crate) const WEAK_TOKEN: &str = "ghp_FreiErfundenOhneRechte0123456789wxyz";

/// What the test server should currently do, and what it has remembered.
#[derive(Default)]
pub(crate) struct MockState {
    /// `ok`, `401`, `rate`, `404`, `broken`, `slow`, `500`
    pub mode: &'static str,
    pub merged: Vec<u64>,
    pub closed: Vec<u64>,
}

pub(crate) struct Fixture {
    pub tc: TestCore,
    pub server: MockServer,
    pub state: Arc<Mutex<MockState>>,
    pub repo: TestRepo,
    pub repo_id: String,
    pub account: HosterAccount,
}

impl Fixture {
    /// Connected account on the test server and a repository whose `origin` points there.
    pub async fn new(kind: HostKind) -> Fixture {
        let state = Arc::new(Mutex::new(MockState { mode: "ok", ..MockState::default() }));
        let server = {
            let state = state.clone();
            MockServer::start(move |request| match kind {
                HostKind::Github => mocks::github(request, &state),
                HostKind::Gitlab => mocks::gitlab(request, &state),
            })
        };
        let tc = TestCore::new().await;
        http::configure(&tc, |options| {
            options.backoff = Duration::from_millis(5);
            options.retries = 1;
        });
        let account = crate::host::connect(&tc, kind, Some(server.url()), TOKEN.to_string()).await.expect("connect account");
        let repo = TestRepo::with_commit();
        let path = match kind {
            HostKind::Github => "octo/demo",
            HostKind::Gitlab => "gruppe/unter/demo",
        };
        repo.git(&["remote", "add", "origin", &format!("{}/{path}.git", server.url())]);
        let repo_id = tc.open(&repo).await.repo.id;
        server.clear();
        tc.events.clear();
        Fixture { tc, server, state, repo, repo_id, account }
    }

    pub fn mode(&self, mode: &'static str) {
        self.state.lock().mode = mode;
        // Otherwise a cached response from before would come back.
        http::clear_cache(&self.tc);
    }

    pub fn id(&self) -> String {
        self.repo_id.clone()
    }

    /// The requests to the server with this method whose path ends like this.
    pub fn sent(&self, method: &str, path_end: &str) -> Vec<MockRequest> {
        self.server.requests().into_iter().filter(|r| r.method == method && r.path().ends_with(path_end)).collect()
    }

    /// The token appears nowhere except in the keychain and in the request header:
    /// not in the log, not in events, not in the database file.
    pub fn assert_token_stays_secret(&self) {
        for scope in [ActivityScope::App, ActivityScope::Repo] {
            let page = self.tc.db.with(|c| db::activity::page(c, scope, None, None, 500)).unwrap();
            for entry in page.entries {
                assert!(!entry.command.contains(TOKEN) && !entry.output.contains(TOKEN), "token in the log: {entry:?}");
            }
        }
        for (name, payload) in self.tc.events.all() {
            assert!(!payload.to_string().contains(TOKEN), "token in event {name}: {payload}");
        }
        let data = self.tc.data_dir();
        for file in std::fs::read_dir(data).unwrap().filter_map(|e| e.ok()) {
            let bytes = std::fs::read(file.path()).unwrap_or_default();
            let found = bytes.windows(TOKEN.len()).any(|window| window == TOKEN.as_bytes());
            assert!(!found, "token in file {}", file.path().display());
        }
        for request in self.server.requests() {
            assert!(!request.target.contains(TOKEN), "token in the address: {}", request.target);
        }
    }
}

/// An error never names the token – neither in the message nor in the output.
pub(crate) fn assert_clean(error: &CoreError) {
    assert!(!error.message.contains(TOKEN), "{}", error.message);
    assert!(!error.git_output.as_deref().unwrap_or("").contains(TOKEN), "{:?}", error.git_output);
}

/// Runs `call` in every error mode of the server and checks code and wording.
pub(crate) async fn check_error_modes<T, F, Fut>(fx: &Fixture, label: &str, what: &str, call: F)
where
    T: std::fmt::Debug,
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = crate::CoreResult<T>>,
{
    let call = &call;
    let expect = |mode: &'static str| async move {
        fx.mode(mode);
        let error = match call().await {
            Ok(value) => panic!("{what} in mode {mode}: expected an error, got {value:?}"),
            Err(error) => error,
        };
        assert_clean(&error);
        error
    };
    let error = expect("401").await;
    assert_eq!(error.code, ErrorCode::HostAuthFailed, "{what}: {error:?}");
    assert!(error.message.contains(label) && error.message.contains("rejects the token"), "{}", error.message);

    let error = expect("rate").await;
    assert_eq!(error.code, ErrorCode::HostRateLimited, "{what}: {error:?}");
    assert!(error.message.contains("rate limit") && error.message.contains("continue at 20"), "the time is in the message: {}", error.message);
    // … and as a separate field, so the UI doesn't have to parse it from the sentence.
    let at = error.retry_at.clone().expect("retryAt");
    assert!(error.message.contains(&at), "{at} / {}", error.message);
    assert_eq!(serde_json::to_value(&error).unwrap()["retryAt"], at);

    let error = expect("403").await;
    assert_eq!(error.code, ErrorCode::HostForbidden, "{what}: {error:?}");
    assert!(error.message.contains(label) && error.message.contains("lacks the permission"), "{}", error.message);
    assert_eq!(error.retry_at, None);

    let error = expect("404").await;
    assert_eq!(error.code, ErrorCode::HostNotFound, "{what}: {error:?}");

    let error = expect("500").await;
    assert_eq!(error.code, ErrorCode::Unknown, "{what}: {error:?}");
    assert!(error.message.contains("server error (500)"), "{}", error.message);

    http::configure(&fx.tc, |options| options.timeout = Duration::from_millis(250));
    let error = expect("slow").await;
    assert_eq!(error.code, ErrorCode::Timeout, "{what}: {error:?}");
    http::configure(&fx.tc, |options| options.timeout = Duration::from_secs(30));
    fx.mode("ok");
}

/// Like `check_error_modes`, plus a response that is not complete JSON (reading commands only).
pub(crate) async fn check_broken_json<T, F, Fut>(fx: &Fixture, label: &str, what: &str, call: F)
where
    T: std::fmt::Debug,
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = crate::CoreResult<T>>,
{
    fx.mode("broken");
    let error = call().await.expect_err(what);
    assert_eq!(error.code, ErrorCode::Unknown, "{what}: {error:?}");
    assert!(error.message.contains("could not be read") && error.message.contains(label), "{}", error.message);
    fx.mode("ok");
}

#[tokio::test]
async fn repositories_without_a_supported_hoster_or_account_fail_clearly() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    // No remote.
    assert_eq!(cmd::host_repo_info(&tc, id.clone(), None).await.unwrap(), None);
    let error = cmd::pr_list(&tc, id.clone(), crate::model::PrListState::Open, None, None, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::HostUnsupported);
    // Other hosts are not recognised.
    repo.git(&["remote", "add", "origin", "https://bitbucket.org/team/demo.git"]);
    repo.git(&["remote", "add", "azure", "https://dev.azure.com/firma/projekt/_git/demo"]);
    assert_eq!(cmd::host_repo_info(&tc, id.clone(), None).await.unwrap(), None);
    assert_eq!(cmd::issue_list(&tc, id.clone(), crate::model::IssueListState::Open, None, None, None, None).await.unwrap_err().code, ErrorCode::HostUnsupported);
    // github.com without an account: recognised but not connected – and no network call.
    repo.git(&["remote", "add", "hub", "git@github.com:octo/demo.git"]);
    let info = cmd::host_repo_info(&tc, id.clone(), None).await.unwrap().unwrap();
    assert_eq!((info.remote.as_str(), info.kind, info.owner.as_str(), info.name.as_str()), ("hub", HostKind::Github, "octo", "demo"));
    assert_eq!(info.web_url, "https://github.com/octo/demo");
    assert!(info.account.is_none() && info.default_branch.is_none() && info.error.is_none());
    let error = cmd::pr_get(&tc, id.clone(), 1, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::HostNotConnected);
    assert!(error.message.contains("https://github.com"), "{}", error.message);
    // A named remote that doesn't exist.
    assert_eq!(cmd::host_repo_info(&tc, id.clone(), Some("fehlt".into())).await.unwrap_err().code, ErrorCode::NotFound);
    // A named remote on another host.
    assert_eq!(cmd::host_repo_info(&tc, id.clone(), Some("azure".into())).await.unwrap(), None);
    assert!(tc.events.named(names::LOG_APPENDED).iter().all(|e| !e["command"].as_str().unwrap_or("").starts_with("GET ")), "no API call without an account");
}

#[tokio::test]
async fn pr_template_is_found_in_the_usual_places() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    assert_eq!(cmd::pr_template(&tc, id.clone()).await.unwrap(), None);
    // GitLab: folder with several templates, "Default.md" wins.
    repo.write_file(".gitlab/merge_request_templates/Bugfix.md", "Bugfix-Vorlage\n");
    assert_eq!(cmd::pr_template(&tc, id.clone()).await.unwrap().as_deref(), Some("Bugfix-Vorlage\n"));
    repo.write_file(".gitlab/merge_request_templates/Default.md", "## Was ändert sich?\n");
    assert_eq!(cmd::pr_template(&tc, id.clone()).await.unwrap().as_deref(), Some("## Was ändert sich?\n"));
    // In the root directory – `.github` and `.gitlab` take precedence.
    repo.write_file("PULL_REQUEST_TEMPLATE.md", "Wurzel\n");
    assert_eq!(cmd::pr_template(&tc, id.clone()).await.unwrap().as_deref(), Some("## Was ändert sich?\n"));
    // GitHub: case doesn't matter, non-ASCII characters are preserved.
    repo.write_file(".github/PULL_REQUEST_TEMPLATE.md", "## Änderung\n\n- [ ] Tests grün\n");
    assert_eq!(cmd::pr_template(&tc, id.clone()).await.unwrap().as_deref(), Some("## Änderung\n\n- [ ] Tests grün\n"));
    // Binary content and unknown repositories are skipped.
    repo.write_file(".github/PULL_REQUEST_TEMPLATE.md", [0u8, 159, 146, 150, 0, 1]);
    assert_eq!(cmd::pr_template(&tc, id.clone()).await.unwrap().as_deref(), Some("## Was ändert sich?\n"));
    assert_eq!(cmd::pr_template(&tc, "unbekannt".into()).await.unwrap_err().code, ErrorCode::NotFound);
}
