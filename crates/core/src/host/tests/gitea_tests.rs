//! Gitea/Forgejo: success and error cases per command against the test server (`octo/demo`
//! under `/api/v1`, token as `Authorization: token …`).

use serde_json::json;

use super::github_tests::back_origin_with_a_real_repository;
use super::*;
use crate::host::detect::normalize_base_url;
use crate::model::{CheckRunState, ChecksState, HostRepoRef, IssueListState, IssueState, PrListState, PrMergeMethod, PrReviewState, PrState};

const KIND: HostKind = HostKind::Gitea;
const LABEL: &str = "Gitea/Forgejo";

#[tokio::test]
async fn account_and_repository_are_recognised() {
    let fx = Fixture::new(KIND).await;
    let account = fx.account.clone();
    let user = account.user.clone().unwrap();
    assert_eq!((account.kind, user.login.as_str(), user.name.as_deref()), (KIND, "lena", Some("Lena Hartmann")));
    assert!(account.scopes_ok && account.missing_scopes.is_empty() && account.username.is_none());
    assert_eq!(fx.tc.secrets.snapshot(), vec![(format!("hoster:{}", account.id), TOKEN.to_string())]);
    assert_eq!(serde_json::to_value(&account).unwrap()["kind"], json!("gitea"));

    cmd::host_check(&fx.tc, account.id.clone()).await.unwrap();
    let seen = fx.sent("GET", "/api/v1/user");
    assert_eq!(seen[0].header("authorization"), Some(format!("token {TOKEN}").as_str()));
    assert_eq!(seen[0].header("accept"), Some("application/json"));
    let error = cmd::host_connect(&fx.tc, KIND, Some(fx.server.url()), "ErfundenUndFalsch0000000000".into(), None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::HostAuthFailed);
    assert!(error.message.contains(LABEL), "{}", error.message);
    // Codeberg is the public instance; API paths are not part of an address.
    assert_eq!(normalize_base_url(KIND, None).unwrap(), "https://codeberg.org");
    assert_eq!(normalize_base_url(KIND, Some("https://Codeberg.org/api/v1/")).unwrap(), "https://codeberg.org");
    assert_eq!(normalize_base_url(KIND, Some("git.firma.example/forgejo/api/v1")).unwrap(), "https://git.firma.example/forgejo");

    let info = cmd::host_repo_info(&fx.tc, fx.id(), None).await.unwrap().unwrap();
    assert_eq!((info.kind, info.owner.as_str(), info.name.as_str()), (KIND, "octo", "demo"));
    assert_eq!(info.web_url, format!("{}/octo/demo", fx.server.url()));
    assert_eq!((info.default_branch.as_deref(), info.can_push), (Some("main"), Some(true)));
    assert_eq!(info.fork_parent, Some(HostRepoRef { owner: "ursprung".into(), name: "demo".into(), web_url: format!("{}/ursprung/demo", fx.server.url()) }));
    assert!(info.capabilities.issues && info.capabilities.draft_toggle && info.capabilities.fork_checkout);
    // The repository has its issue tracker switched off: the UI hides issues.
    fx.state.lock().issues_off = true;
    fx.mode("ok");
    assert!(!cmd::host_repo_info(&fx.tc, fx.id(), None).await.unwrap().unwrap().capabilities.issues);
    fx.state.lock().issues_off = false;

    fx.mode("rate");
    let limited = cmd::host_repo_info(&fx.tc, fx.id(), None).await.unwrap().unwrap();
    assert_eq!(limited.error.map(|e| e.code), Some(ErrorCode::HostRateLimited));
    fx.mode("ok");
    fx.assert_token_stays_secret();
}

#[tokio::test]
async fn pull_requests_are_listed_and_read() {
    let fx = Fixture::new(KIND).await;
    let first = cmd::pr_list(&fx.tc, fx.id(), PrListState::Open, None, None, None).await.unwrap();
    assert_eq!((first.items.len(), first.next_page, first.items[0].number), (20, Some(2), 44));
    let call = &fx.sent("GET", "/pulls")[0];
    assert_eq!(
        (call.query("state"), call.query("sort"), call.query("limit"), call.query("page")),
        (Some("open".into()), Some("recentupdate".into()), Some("20".into()), Some("1".into()))
    );
    let second = cmd::pr_list(&fx.tc, fx.id(), PrListState::Open, Some(2), None, None).await.unwrap();
    assert_eq!((second.items.len(), second.next_page), (16, None));
    let by_number = |n: u64| second.items.iter().find(|pr| pr.number == n).unwrap_or_else(|| panic!("#{n}")).clone();
    assert_eq!((by_number(1).checks, by_number(1).review_state), (Some(ChecksState::Passing), Some(PrReviewState::Approved)));
    assert_eq!((by_number(2).checks, by_number(2).review_state), (Some(ChecksState::Pending), Some(PrReviewState::ReviewRequired)));
    assert_eq!((by_number(4).checks, by_number(4).review_state), (Some(ChecksState::Failing), Some(PrReviewState::ChangesRequested)));
    assert_eq!((by_number(6).checks, by_number(6).review_state), (None, None));
    assert!(by_number(3).is_draft, "WIP: in the title");
    assert!(by_number(8).is_fork && !by_number(7).is_fork);
    assert_eq!(by_number(1).labels.iter().map(|l| (l.name.as_str(), l.color.clone())).collect::<Vec<_>>(), vec![("bug", Some("#ee0701".to_string()))]);
    assert_eq!(by_number(1).web_url, format!("{}/octo/demo/pulls/1", fx.server.url()));
    // Gitea lists merged ones under "closed"; they are separated here.
    let merged = cmd::pr_list(&fx.tc, fx.id(), PrListState::Merged, None, None, None).await.unwrap();
    assert_eq!(merged.items.iter().map(|pr| (pr.number, pr.state)).collect::<Vec<_>>(), vec![(40, PrState::Merged), (30, PrState::Merged), (20, PrState::Merged), (10, PrState::Merged)]);
    let closed = cmd::pr_list(&fx.tc, fx.id(), PrListState::Closed, None, None, None).await.unwrap();
    assert_eq!(closed.items.iter().map(|pr| pr.number).collect::<Vec<_>>(), vec![45, 35, 25, 15, 5]);
    fx.server.clear();
    cmd::pr_list(&fx.tc, fx.id(), PrListState::All, None, Some(100), None).await.unwrap();
    assert_eq!(fx.sent("GET", "/pulls")[0].query("limit").as_deref(), Some("50"), "Gitea's largest page");

    let pr = cmd::pr_get(&fx.tc, fx.id(), 1, None).await.unwrap();
    assert!(pr.body.contains("**Thema 1**"));
    assert_eq!(pr.reviewers.iter().map(|r| (r.user.login.as_str(), r.state)).collect::<Vec<_>>(), vec![("mira", Some(PrReviewState::Approved))]);
    assert_eq!(pr.comments.iter().map(|c| (c.id.as_str(), c.body.as_str())).collect::<Vec<_>>(), vec![("r11", "Erster Blick: sieht gut aus."), ("c21", "Danke fürs Ansehen!")]);
    assert_eq!((pr.commits.len(), pr.commits[0].summary.as_str(), pr.commits[0].author_name.as_str()), (2, "Prüfung ergänzt", "Jonas Weber"));
    assert_eq!(pr.check_runs.iter().map(|c| (c.name.as_str(), c.state)).collect::<Vec<_>>(), vec![("build", CheckRunState::Passing), ("docs", CheckRunState::Passing)]);
    assert_eq!((pr.summary.checks, pr.mergeable, pr.head_sha.as_str()), (Some(ChecksState::Passing), Some(true), format!("{:040x}", 1).as_str()));
    assert_eq!(cmd::pr_get(&fx.tc, fx.id(), 13, None).await.unwrap().mergeable, Some(false));
    assert_eq!(cmd::pr_get(&fx.tc, fx.id(), 999, None).await.unwrap_err().message, "Pull request #999 does not exist in octo/demo.");

    check_error_modes(&fx, LABEL, "pr_list", || cmd::pr_list(&fx.tc, fx.id(), PrListState::Open, None, None, None)).await;
    check_error_modes(&fx, LABEL, "pr_get", || cmd::pr_get(&fx.tc, fx.id(), 1, None)).await;
    check_broken_json(&fx, LABEL, "pr_list", || cmd::pr_list(&fx.tc, fx.id(), PrListState::Open, None, None, None)).await;
    check_broken_json(&fx, LABEL, "pr_get", || cmd::pr_get(&fx.tc, fx.id(), 1, None)).await;
    fx.assert_token_stays_secret();
}

#[tokio::test]
async fn issues_are_listed_searched_and_read() {
    let fx = Fixture::new(KIND).await;
    let open = cmd::issue_list(&fx.tc, fx.id(), IssueListState::Open, None, None, None, None).await.unwrap();
    assert_eq!(open.items.iter().map(|i| i.number).collect::<Vec<_>>(), vec![11, 10, 9, 7, 6, 5, 3, 2, 1]);
    assert_eq!((open.items[0].key.as_str(), open.items[0].state, open.next_page), ("#11", IssueState::Open, None));
    let call = &fx.sent("GET", "/issues")[0];
    assert_eq!((call.query("state"), call.query("type")), (Some("open".into()), Some("issues".into())), "pull requests are filtered by the host");
    let found = cmd::issue_list(&fx.tc, fx.id(), IssueListState::All, Some(" anmeldung ".into()), None, None, None).await.unwrap();
    assert_eq!(found.items.iter().map(|i| i.number).collect::<Vec<_>>(), vec![2, 1]);
    assert_eq!(fx.sent("GET", "/issues")[1].query("q").as_deref(), Some("anmeldung"));
    let paged = cmd::issue_list(&fx.tc, fx.id(), IssueListState::All, None, Some(2), Some(5), None).await.unwrap();
    assert_eq!((paged.items.iter().map(|i| i.number).collect::<Vec<_>>(), paged.next_page), (vec![7, 6, 5, 4, 3], Some(3)));

    let issue = cmd::issue_get(&fx.tc, fx.id(), 2, None).await.unwrap();
    assert_eq!((issue.body.as_str(), issue.summary.assignees[0].login.as_str()), ("Text zu Problem 2", "lena"));
    assert_eq!(issue.summary.labels.iter().map(|l| (l.name.as_str(), l.color.clone())).collect::<Vec<_>>(), vec![("frage", Some("#0e8a16".to_string()))]);
    assert_eq!(issue.comments.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec!["c21"]);
    let error = cmd::issue_get(&fx.tc, fx.id(), 3, None).await.unwrap_err();
    assert!(error.message.contains("is a pull request"), "{}", error.message);
    assert_eq!(cmd::issue_get(&fx.tc, fx.id(), 999, None).await.unwrap_err().message, "Issue #999 does not exist in octo/demo.");
    check_error_modes(&fx, LABEL, "issue_list", || cmd::issue_list(&fx.tc, fx.id(), IssueListState::Open, None, None, None, None)).await;
    check_error_modes(&fx, LABEL, "issue_get", || cmd::issue_get(&fx.tc, fx.id(), 2, None)).await;
    check_broken_json(&fx, LABEL, "issue_list", || cmd::issue_list(&fx.tc, fx.id(), IssueListState::Open, None, None, None, None)).await;
    fx.assert_token_stays_secret();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checkout_fetches_the_branch_of_a_pull_request() {
    let fx = Fixture::new(KIND).await;
    let repo = &fx.repo;
    let _bare = back_origin_with_a_real_repository(&fx, "octo/demo");
    repo.checkout_new("feature/login");
    let login = repo.commit_file("login.txt", "anmeldung\n", "Anmeldung gebaut");
    repo.git(&["push", "-q", "origin", "feature/login"]);
    repo.checkout("main");
    repo.checkout_new("fremd");
    let from_fork = repo.commit_file("fork.txt", "aus dem fork\n", "Korrektur aus dem Fork");
    repo.git(&["push", "-q", "origin", "HEAD:refs/pull/8/head"]);
    repo.checkout("main");
    repo.git(&["branch", "-D", "feature/login", "fremd"]);
    repo.git(&["update-ref", "-d", "refs/remotes/origin/feature/login"]);

    cmd::pr_checkout(&fx.tc, fx.id(), 7, None).await.unwrap();
    assert_eq!((repo.current_branch(), repo.head()), ("feature/login".to_string(), login));
    assert_eq!(repo.git(&["rev-parse", "--abbrev-ref", "feature/login@{upstream}"]), "origin/feature/login");
    cmd::pr_checkout(&fx.tc, fx.id(), 8, None).await.unwrap();
    assert_eq!((repo.current_branch(), repo.head()), ("pr-8".to_string(), from_fork));
    assert_eq!(repo.git(&["for-each-ref", "refs/forkyard/pull"]), "", "the helper ref is not left behind");
    assert_eq!(cmd::pr_checkout(&fx.tc, fx.id(), 999, None).await.unwrap_err().code, ErrorCode::HostNotFound);
    fx.assert_token_stays_secret();
}

#[tokio::test]
async fn pull_requests_are_created_changed_commented_merged_and_closed() {
    let fx = Fixture::new(KIND).await;
    let created = cmd::pr_create(&fx.tc, fx.id(), "Neue Anmeldung".into(), "Text".into(), "feature/neu".into(), "main".into(), true, Some(vec!["mira".into()]), Some(vec!["bug".into(), "UI".into()]), None)
        .await
        .unwrap();
    assert_eq!(created.number, 101);
    assert_eq!(fx.sent("POST", "/pulls")[0].json(), json!({ "title": "WIP: Neue Anmeldung", "body": "Text", "head": "feature/neu", "base": "main", "labels": [11, 13] }), "labels by ID, the draft in the title");
    assert_eq!(fx.sent("POST", "/pulls/101/requested_reviewers")[0].json(), json!({ "reviewers": ["mira"] }));
    // A label the repository doesn't have: nothing is created.
    fx.server.clear();
    let error = cmd::pr_create(&fx.tc, fx.id(), "x".into(), String::new(), "feature/neu".into(), "main".into(), false, None, Some(vec!["fehlt".into()]), None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::HostRejected);
    assert!(error.message.contains("“fehlt”"), "{}", error.message);
    assert!(fx.sent("POST", "/pulls").is_empty());
    let error = cmd::pr_create(&fx.tc, fx.id(), "Doppelt".into(), String::new(), "schon-da".into(), "main".into(), false, None, None, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::NameExists);
    assert!(error.message.contains("already an open pull request"), "{}", error.message);
    check_error_modes(&fx, LABEL, "pr_create", || cmd::pr_create(&fx.tc, fx.id(), "Titel".into(), String::new(), "feature/neu".into(), "main".into(), false, None, None, None)).await;

    // Update: the draft state lives in the title.
    fx.server.clear();
    cmd::pr_update(&fx.tc, fx.id(), 3, None, None, None, Some(false), None, None, None).await.unwrap();
    assert_eq!(fx.sent("PATCH", "/pulls/3")[0].json(), json!({ "title": "Thema 3 umsetzen" }));
    fx.server.clear();
    cmd::pr_update(&fx.tc, fx.id(), 3, Some("Neuer Titel".into()), Some("Neuer Text".into()), Some("develop".into()), None, None, Some(vec!["frage".into()]), None).await.unwrap();
    assert_eq!(fx.sent("PATCH", "/pulls/3")[0].json(), json!({ "title": "WIP: Neuer Titel", "body": "Neuer Text", "base": "develop", "labels": [12] }), "a draft stays a draft when renamed");
    fx.server.clear();
    cmd::pr_update(&fx.tc, fx.id(), 1, None, None, None, None, Some(vec!["jonas".into()]), None, None).await.unwrap();
    assert_eq!(fx.sent("POST", "/pulls/1/requested_reviewers")[0].json(), json!({ "reviewers": ["jonas"] }));
    assert!(fx.sent("PATCH", "/pulls/1").is_empty(), "no PATCH without title, body, target, labels or draft");
    fx.server.clear();
    cmd::pr_update(&fx.tc, fx.id(), 2, None, None, None, None, Some(Vec::new()), None, None).await.unwrap();
    assert_eq!(fx.sent("DELETE", "/pulls/2/requested_reviewers")[0].json(), json!({ "reviewers": ["mira"] }));

    let comment = cmd::pr_comment(&fx.tc, fx.id(), 1, "Passt so.".into(), None).await.unwrap();
    assert_eq!((comment.id.as_str(), comment.body.as_str()), ("c99", "Passt so."));
    assert_eq!(fx.sent("POST", "/issues/1/comments")[0].json(), json!({ "body": "Passt so." }));

    let merged = cmd::pr_merge(&fx.tc, fx.id(), 1, PrMergeMethod::Squash, true, None).await.unwrap();
    assert_eq!(merged.state, PrState::Merged);
    assert_eq!(fx.sent("POST", "/pulls/1/merge")[0].json(), json!({ "Do": "squash", "delete_branch_after_merge": true }));
    cmd::pr_merge(&fx.tc, fx.id(), 2, PrMergeMethod::Rebase, false, None).await.unwrap();
    assert_eq!(fx.sent("POST", "/pulls/2/merge")[0].json(), json!({ "Do": "rebase", "delete_branch_after_merge": false }));
    let error = cmd::pr_merge(&fx.tc, fx.id(), 13, PrMergeMethod::Merge, false, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::HostRejected);
    assert!(error.message.contains("merge conflicts"), "{}", error.message);

    assert_eq!(cmd::pr_close(&fx.tc, fx.id(), 6, None).await.unwrap().state, PrState::Closed);
    assert_eq!(cmd::pr_reopen(&fx.tc, fx.id(), 6, None).await.unwrap().state, PrState::Open);
    let patches: Vec<_> = fx.sent("PATCH", "/pulls/6").iter().map(|r| r.json()).collect();
    assert_eq!(patches, vec![json!({ "state": "closed" }), json!({ "state": "open" })]);
    check_error_modes(&fx, LABEL, "pr_merge", || cmd::pr_merge(&fx.tc, fx.id(), 7, PrMergeMethod::Merge, false, None)).await;
    check_error_modes(&fx, LABEL, "pr_comment", || cmd::pr_comment(&fx.tc, fx.id(), 7, "Text".into(), None)).await;
    check_error_modes(&fx, LABEL, "pr_close", || cmd::pr_close(&fx.tc, fx.id(), 7, None)).await;
    fx.assert_token_stays_secret();
}
