//! Tests of the host integration against the local test server. The responses are hand-written,
//! in the shape of the public documentation of GitHub (REST) and GitLab (REST v4) – no real
//! data, no call leaves this computer.

mod azure_tests;
mod github_tests;
mod gitlab_tests;
mod bitbucket_tests;
mod gitea_tests;
mod stack_tests;
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
/// The account e-mail Bitbucket signs in with (Basic authentication) – made up.
pub(crate) const USERNAME: &str = "lena@example.org";

/// What the test server should currently do, and what it has remembered.
#[derive(Default)]
pub(crate) struct MockState {
    /// `ok`, `401`, `rate`, `404`, `broken`, `slow`, `500`
    pub mode: &'static str,
    pub merged: Vec<u64>,
    pub closed: Vec<u64>,
    /// The repository has its issue tracker switched off.
    pub issues_off: bool,
    /// The project's process has no work item type "Issue" (Azure DevOps).
    pub no_issue_type: bool,
}

pub(crate) struct Fixture {
    pub tc: TestCore,
    pub server: MockServer,
    pub state: Arc<Mutex<MockState>>,
    pub repo: TestRepo,
    pub repo_id: String,
    pub account: HosterAccount,
}

/// Where the test server's repository lives, per host.
fn mock_repo_path(kind: HostKind) -> &'static str {
    match kind {
        HostKind::Github => "octo/demo",
        HostKind::Gitlab => "gruppe/unter/demo",
        HostKind::Gitea => "octo/demo",
        HostKind::Bitbucket => "team/demo",
        HostKind::AzureDevops => "firma/projekt/_git/demo",
    }
}

/// Address of the account on the test server: Azure DevOps keeps the organization in it.
fn mock_base(kind: HostKind, url: &str) -> String {
    match kind {
        HostKind::AzureDevops => format!("{url}/firma"),
        _ => url.to_string(),
    }
}

/// The user name the account signs in with (only Bitbucket needs one).
fn mock_username(kind: HostKind) -> Option<String> {
    (kind == HostKind::Bitbucket).then(|| USERNAME.to_string())
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
                HostKind::Gitea => mocks::gitea(request, &state),
                HostKind::Bitbucket => mocks::bitbucket(request, &state),
                HostKind::AzureDevops => mocks::azure(request, &state),
            })
        };
        let tc = TestCore::new().await;
        http::configure(&tc, |options| {
            options.backoff = Duration::from_millis(5);
            options.retries = 1;
        });
        let account = crate::host::connect_as(&tc, kind, Some(mock_base(kind, &server.url())), mock_username(kind), TOKEN.to_string()).await.expect("connect account");
        let repo = TestRepo::with_commit();
        repo.git(&["remote", "add", "origin", &format!("{}/{}.git", server.url(), mock_repo_path(kind))]);
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
    // Hosts the app doesn't know are not recognised.
    repo.git(&["remote", "add", "origin", "https://git.example.org/team/demo.git"]);
    repo.git(&["remote", "add", "azure", "https://code.example.net/firma/projekt/_git/demo"]);
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

#[tokio::test]
async fn the_template_is_found_with_its_path() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    assert_eq!(cmd::find_pr_template(&tc, &id).await.unwrap(), None);
    repo.write_file(".gitlab/merge_request_templates/Default.md", "## Was ändert sich?\n");
    assert_eq!(
        cmd::find_pr_template(&tc, &id).await.unwrap(),
        Some((".gitlab/merge_request_templates/Default.md".to_string(), "## Was ändert sich?\n".to_string()))
    );
    // The actual spelling of the name, `/` as separator on every system.
    repo.write_file(".github/PULL_REQUEST_TEMPLATE.md", "## Änderung\n");
    repo.write_file("docs/pull_request_template.md", "Docs\n");
    assert_eq!(cmd::find_pr_template(&tc, &id).await.unwrap(), Some((".github/PULL_REQUEST_TEMPLATE.md".to_string(), "## Änderung\n".to_string())));
    assert_eq!(cmd::pr_template(&tc, id.clone()).await.unwrap().as_deref(), Some("## Änderung\n"), "pr_template answers as before");
    assert_eq!(cmd::find_pr_template(&tc, "unbekannt").await.unwrap_err().code, ErrorCode::NotFound);
}

#[test]
fn every_kind_has_exactly_its_host_with_its_capabilities() {
    use crate::host::host;
    use crate::model::PrMergeMethod;
    for kind in HostKind::ALL.iter().copied() {
        let found = host(kind);
        assert_eq!(found.kind(), kind);
        assert!(!found.label().is_empty() && !found.pr_word().is_empty(), "{kind:?}");
        assert!(found.capabilities().merge_methods.contains(&PrMergeMethod::Merge), "{kind:?} can merge with a merge commit");
    }
    let hub = host(HostKind::Github);
    assert_eq!(hub.capabilities().merge_methods, vec![PrMergeMethod::Merge, PrMergeMethod::Squash, PrMergeMethod::Rebase]);
    assert!(!hub.capabilities().draft_toggle && hub.capabilities().pr_labels && !hub.capabilities().issue_create);
    assert_eq!((hub.pr_ref(8).as_deref(), hub.fork_branch(8).as_str()), (Some("refs/pull/8/head"), "pr-8"));
    assert_eq!(hub.authorization("t0k3n", Some("lena")), "Bearer t0k3n", "GitHub ignores a user name");
    let lab = host(HostKind::Gitlab);
    assert_eq!(lab.capabilities().merge_methods, vec![PrMergeMethod::Merge, PrMergeMethod::Squash]);
    assert!(lab.capabilities().draft_toggle);
    assert_eq!((lab.pr_ref(8).as_deref(), lab.fork_branch(8).as_str(), lab.pr_word()), (Some("refs/merge-requests/8/head"), "mr-8", "merge request"));
    let shape = serde_json::to_value(lab.capabilities()).unwrap();
    for key in ["issues", "issueCreate", "draftPrs", "draftToggle", "mergeMethods", "deleteSourceBranch", "prReopen", "prReviewers", "prLabels", "forkCheckout"] {
        assert!(shape.get(key).is_some(), "{key} missing: {shape}");
    }
    assert_eq!(shape["mergeMethods"], serde_json::json!(["merge", "squash"]));
}

#[test]
fn the_commands_only_talk_to_hosts_through_the_trait() {
    let source = include_str!("../commands/host.rs");
    for direct in ["github::", "gitlab::", "HostKind::"] {
        assert!(!source.contains(direct), "commands/host.rs calls {direct} directly instead of the Host trait");
    }
}

#[tokio::test]
async fn repo_info_names_what_the_host_can_do() {
    let fx = Fixture::new(HostKind::Gitlab).await;
    let info = cmd::host_repo_info(&fx.tc, fx.id(), None).await.unwrap().unwrap();
    assert_eq!(info.capabilities, crate::host::host(HostKind::Gitlab).capabilities());
    let shape = serde_json::to_value(&info).unwrap();
    assert_eq!(shape["capabilities"]["mergeMethods"], serde_json::json!(["merge", "squash"]));
    assert_eq!(shape["capabilities"]["draftToggle"], serde_json::json!(true));
    // Without an account the capabilities are there as well: they come from the host, not from a call.
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    repo.git(&["remote", "add", "origin", "git@github.com:octo/demo.git"]);
    let id = tc.open(&repo).await.repo.id;
    let hub = cmd::host_repo_info(&tc, id, None).await.unwrap().unwrap();
    assert_eq!(hub.capabilities.merge_methods.len(), 3);
    assert!(hub.account.is_none());
}

#[test]
fn host_messages_are_found_also_when_nested_and_never_carry_the_token() {
    let api = crate::host::Api::new(HostKind::Github, "a", "https://github.com", TOKEN.to_string());
    let nested = http::Response::for_test(400, r#"{"type":"error","error":{"message":"Only one pull request may be open"}}"#, "GitHub");
    assert_eq!(api.provider_message(&nested), "Only one pull request may be open");
    let flat = http::Response::for_test(409, &format!(r#"{{"$id":"1","message":"TF401179: already exists ({TOKEN})"}}"#), "GitHub");
    let text = api.provider_message(&flat);
    assert!(text.contains("TF401179") && !text.contains(TOKEN), "{text}");
    let fields = http::Response::for_test(400, r#"{"message":{"title":["is too long"]}}"#, "GitLab");
    assert_eq!(api.provider_message(&fields), "title: is too long");
}

#[tokio::test]
async fn hosts_that_only_need_a_token_ignore_a_user_name() {
    let fx = Fixture::new(HostKind::Github).await;
    let account = cmd::host_connect(&fx.tc, HostKind::Github, Some(fx.server.url()), TOKEN.into(), Some("lena".into())).await.unwrap();
    assert_eq!((account.id.as_str(), account.username.as_deref()), (fx.account.id.as_str(), None));
    assert_eq!(fx.sent("GET", "/api/v3/user")[0].header("authorization"), Some(format!("Bearer {TOKEN}").as_str()));
    assert!(serde_json::to_value(&account).unwrap()["username"].is_null());
    fx.assert_token_stays_secret();
}

#[tokio::test]
async fn hosts_without_issue_creation_refuse_it_before_any_request() {
    let fx = Fixture::new(HostKind::Github).await;
    let error = cmd::issue_create(&fx.tc, fx.id(), "Titel".into(), String::new(), None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::HostUnsupported);
    assert!(error.message.contains("GitHub") && error.message.contains("creating issues"), "{}", error.message);
    assert!(fx.server.requests().is_empty());
    assert!(!cmd::host_repo_info(&fx.tc, fx.id(), None).await.unwrap().unwrap().capabilities.issue_create);
}

#[tokio::test]
async fn the_new_public_services_are_recognised_without_an_account() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    repo.git(&["remote", "add", "origin", "git@ssh.dev.azure.com:v3/firma/Mein%20Projekt/app"]);
    repo.git(&["remote", "add", "bb", "git@bitbucket.org:team/demo.git"]);
    repo.git(&["remote", "add", "cb", "https://codeberg.org/lena/notizen.git"]);
    let id = tc.open(&repo).await.repo.id;
    let azure = cmd::host_repo_info(&tc, id.clone(), None).await.unwrap().unwrap();
    assert_eq!(
        (azure.kind, azure.owner.as_str(), azure.name.as_str(), azure.web_url.as_str()),
        (HostKind::AzureDevops, "Mein Projekt", "app", "https://dev.azure.com/firma/Mein%20Projekt/_git/app")
    );
    assert!(azure.capabilities.issue_create && azure.account.is_none());
    let error = cmd::pr_list(&tc, id.clone(), crate::model::PrListState::Open, None, None, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::HostNotConnected);
    assert!(error.message.contains("https://dev.azure.com/firma"), "{}", error.message);
    assert_eq!(cmd::host_repo_info(&tc, id.clone(), Some("bb".into())).await.unwrap().unwrap().kind, HostKind::Bitbucket);
    assert_eq!(cmd::host_repo_info(&tc, id.clone(), Some("cb".into())).await.unwrap().unwrap().web_url, "https://codeberg.org/lena/notizen");
    assert!(tc.events.named(names::LOG_APPENDED).iter().all(|e| !e["command"].as_str().unwrap_or("").starts_with("GET ")), "no API call without an account");
}

#[test]
fn review_threads_reach_the_ui_in_camel_case() {
    use crate::model::{HostComment, HostUser, ReviewReply, ReviewSide, ReviewThread};
    let comment = HostComment {
        id: "9001".into(),
        author: Some(HostUser { login: "mira".into(), name: None, avatar_url: None }),
        body: "Prüfen!".into(),
        created_at: "2026-09-02T09:30:00Z".into(),
        path: Some("src/ä b.rs".into()),
        line: Some(42),
    };
    let thread = ReviewThread {
        id: "9001".into(),
        path: "src/ä b.rs".into(),
        line: Some(42),
        start_line: Some(40),
        side: ReviewSide::New,
        commit: None,
        resolved: false,
        outdated: true,
        comments: vec![comment.clone()],
    };
    let shape = serde_json::to_value(&thread).unwrap();
    assert_eq!(shape["startLine"], 40);
    assert_eq!(shape["side"], "new");
    assert_eq!(shape["outdated"], true);
    assert_eq!(shape["commit"], serde_json::Value::Null);
    assert_eq!(shape["path"], "src/ä b.rs");
    assert_eq!(shape["comments"][0]["createdAt"], "2026-09-02T09:30:00Z");
    assert_eq!(serde_json::to_value(ReviewSide::Old).unwrap(), "old");
    assert_eq!(serde_json::to_value(ReviewReply { comment, quoted: true }).unwrap()["quoted"], true);
    for kind in HostKind::ALL.iter().copied() {
        let caps = serde_json::to_value(crate::host::host(kind).capabilities()).unwrap();
        for key in ["reviewThreads", "reviewReply", "reviewReplyQuotes"] {
            assert!(caps[key].is_boolean(), "{kind:?}: {key} missing in {caps}");
        }
    }
}

#[tokio::test]
async fn review_replies_check_their_input_before_any_request() {
    let fx = Fixture::new(HostKind::Github).await;
    let error = cmd::pr_review_reply(&fx.tc, fx.id(), 9, "9001".into(), " \n\t".into(), None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::EmptyMessage);
    let long = "9".repeat(129);
    for bad in ["", "-9001", "../9001", "9001/replies", "90 01", "9001?x=1", "ä", long.as_str()] {
        let error = cmd::pr_review_reply(&fx.tc, fx.id(), 9, bad.to_string(), "Danke".into(), None).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::NotAllowed, "{bad:?}");
        assert_clean(&error);
    }
    assert!(fx.server.requests().is_empty(), "nothing went out");
}
