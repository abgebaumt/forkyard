//! GitHub: success and error cases per command against the test server.

use serde_json::json;

use super::*;
use crate::model::{
    CheckRunState, ChecksState, HostRepoRef, IssueListState, IssueState, PrListState, PrMergeMethod, PrReviewState, PrState, ReviewSide,
};
use crate::testkit::{MockResponse, TestRemote};

const KIND: HostKind = HostKind::Github;

#[tokio::test]
async fn account_is_checked_stored_in_the_keyring_and_never_leaks() {
    let fx = Fixture::new(KIND).await;
    let account = fx.account.clone();
    assert_eq!((account.kind, account.base_url.as_str()), (KIND, fx.server.url().as_str()));
    let user = account.user.clone().unwrap();
    assert_eq!((user.login.as_str(), user.name.as_deref()), ("lena-hartmann", Some("Lena Hartmann")));
    assert_eq!(account.token_hint.as_deref(), Some("…abcd"));
    assert!(account.scopes_ok && account.missing_scopes.is_empty() && account.last_error.is_none());
    // This is how the account reaches the UI – without the token.
    let shape = serde_json::to_value(&account).unwrap();
    for key in ["id", "kind", "baseUrl", "user", "tokenHint", "scopesOk", "missingScopes", "lastError"] {
        assert!(shape.get(key).is_some(), "{key} missing: {shape}");
    }
    assert_eq!((shape["kind"].clone(), shape["user"]["avatarUrl"].clone()), (json!("github"), json!("https://avatars.example/lena-hartmann.png")));
    assert!(!shape.to_string().contains(TOKEN));
    // The token is stored in exactly one place.
    assert_eq!(fx.tc.secrets.snapshot(), vec![(format!("hoster:{}", account.id), TOKEN.to_string())]);
    assert_eq!(cmd::host_accounts(&fx.tc).await.unwrap(), vec![account.clone()]);

    // Check again: `GET /user` with the documented headers.
    assert_eq!(cmd::host_check(&fx.tc, account.id.clone()).await.unwrap(), account);
    let seen = fx.sent("GET", "/api/v3/user");
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].header("authorization"), Some(format!("Bearer {TOKEN}").as_str()));
    assert_eq!(seen[0].header("accept"), Some("application/vnd.github+json"));
    assert_eq!(seen[0].header("x-github-api-version"), Some("2022-11-28"));
    assert_eq!(seen[0].header("user-agent"), Some("forkyard"));

    // Reconnect with a token lacking the required permission: same account, new state.
    let weak = cmd::host_connect(&fx.tc, KIND, Some(format!("{}/", fx.server.url())), format!("  {WEAK_TOKEN}\n"), None).await.unwrap();
    assert_eq!(weak.id, account.id);
    assert_eq!((weak.scopes_ok, weak.missing_scopes.clone(), weak.token_hint.as_deref()), (false, vec!["repo".to_string()], Some("…wxyz")));
    assert_eq!(fx.tc.secrets.snapshot(), vec![(format!("hoster:{}", account.id), WEAK_TOKEN.to_string())]);
    assert!(fx.tc.events.named(names::APP_CHANGED).iter().any(|e| e["what"] == json!(["host_accounts"])));

    // A rejected token leaves nothing behind.
    let error = cmd::host_connect(&fx.tc, KIND, Some(fx.server.url()), "ghp_ErfundenUndFalsch0000000000".into(), None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::HostAuthFailed);
    assert!(!error.message.contains("ghp_ErfundenUndFalsch"));
    assert_eq!(fx.tc.secrets.snapshot()[0].1, WEAK_TOKEN);
    assert_eq!(cmd::host_accounts(&fx.tc).await.unwrap().len(), 1);
    // Invalid input never goes out in the first place.
    fx.server.clear();
    for (base, token) in [(Some("http://github.firma.example".to_string()), TOKEN), (Some(fx.server.url()), "   "), (Some(fx.server.url()), "mit leer zeichen"), (Some("ftp://x".to_string()), TOKEN)] {
        let error = cmd::host_connect(&fx.tc, KIND, base.clone(), token.to_string(), None).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::NotAllowed, "{base:?}");
        assert_clean(&error);
    }
    assert!(fx.server.requests().is_empty());
    // No API responds at the address.
    let elsewhere = MockServer::start(|_| MockResponse::json(404, json!({ "message": "Not Found" })));
    let error = cmd::host_connect(&fx.tc, KIND, Some(elsewhere.url()), TOKEN.into(), None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::HostNotFound);
    assert!(error.message.contains("No GitHub API responds"), "{}", error.message);
    assert_eq!(cmd::host_accounts(&fx.tc).await.unwrap().len(), 1, "no second account created");

    // Checking with a token that has become invalid: no error, but `lastError`.
    cmd::host_connect(&fx.tc, KIND, Some(fx.server.url()), TOKEN.into(), None).await.unwrap();
    fx.mode("401");
    let rejected = cmd::host_check(&fx.tc, account.id.clone()).await.unwrap();
    assert!(rejected.last_error.as_deref().is_some_and(|e| e.contains("rejects the token") && !e.contains(TOKEN)), "{:?}", rejected.last_error);
    fx.mode("ok");
    assert_eq!(cmd::host_check(&fx.tc, account.id.clone()).await.unwrap().last_error, None);
    fx.assert_token_stays_secret();

    // Disconnecting deletes entry and token.
    assert!(cmd::host_disconnect(&fx.tc, account.id.clone()).await.unwrap().is_empty());
    assert!(fx.tc.secrets.snapshot().is_empty());
    assert!(cmd::host_disconnect(&fx.tc, account.id.clone()).await.unwrap().is_empty(), "disconnecting twice is not an error");
    assert_eq!(cmd::host_check(&fx.tc, account.id.clone()).await.unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(cmd::pr_get(&fx.tc, fx.id(), 1, None).await.unwrap_err().code, ErrorCode::HostUnsupported, "without an account the self-hosted instance is no longer recognised");
}

#[tokio::test]
async fn repo_info_combines_the_remote_with_what_the_hoster_says() {
    let fx = Fixture::new(KIND).await;
    let info = cmd::host_repo_info(&fx.tc, fx.id(), None).await.unwrap().unwrap();
    assert_eq!((info.remote.as_str(), info.kind, info.owner.as_str(), info.name.as_str()), ("origin", KIND, "octo", "demo"));
    assert_eq!(info.web_url, format!("{}/octo/demo", fx.server.url()));
    assert_eq!((info.default_branch.as_deref(), info.can_push), (Some("main"), Some(true)));
    assert_eq!(info.fork_parent, Some(HostRepoRef { owner: "ursprung".into(), name: "demo".into(), web_url: format!("{}/ursprung/demo", fx.server.url()) }));
    assert_eq!(info.account.as_ref().map(|a| a.id.as_str()), Some(fx.account.id.as_str()));
    assert_eq!(info.error, None);
    let shape = serde_json::to_value(&info).unwrap();
    assert_eq!((shape["defaultBranch"].clone(), shape["canPush"].clone(), shape["forkParent"]["owner"].clone()), (json!("main"), json!(true), json!("ursprung")));

    // A second remote in SSH form on the same instance.
    fx.repo.git(&["remote", "add", "per-ssh", "git@127.0.0.1:octo/demo.git"]);
    let ssh = cmd::host_repo_info(&fx.tc, fx.id(), Some("per-ssh".into())).await.unwrap().unwrap();
    assert_eq!((ssh.remote.as_str(), ssh.owner.as_str(), ssh.default_branch.as_deref()), ("per-ssh", "octo", Some("main")));

    // The host rejects: the detection stays, the reason is in `error`, the account is flagged.
    fx.mode("401");
    let rejected = cmd::host_repo_info(&fx.tc, fx.id(), None).await.unwrap().unwrap();
    assert_eq!(rejected.error.as_ref().map(|e| e.code), Some(ErrorCode::HostAuthFailed));
    assert_eq!((rejected.owner.as_str(), rejected.default_branch.clone()), ("octo", None));
    assert!(rejected.account.as_ref().is_some_and(|a| a.last_error.is_some()));
    fx.mode("404");
    let missing = cmd::host_repo_info(&fx.tc, fx.id(), None).await.unwrap().unwrap();
    let error = missing.error.unwrap();
    assert_eq!(error.code, ErrorCode::HostNotFound);
    assert!(error.message.contains("octo/demo"), "{}", error.message);
    // Reachable again: the error on the account is gone.
    fx.mode("ok");
    let again = cmd::host_repo_info(&fx.tc, fx.id(), None).await.unwrap().unwrap();
    assert!(again.error.is_none() && again.account.as_ref().is_some_and(|a| a.last_error.is_none()));
    // The token is missing from the keychain (deleted externally).
    crate::secrets::delete(&fx.tc, &crate::host::secret_account(&fx.account.id)).await.unwrap();
    assert_eq!(cmd::host_repo_info(&fx.tc, fx.id(), None).await.unwrap().unwrap().error.map(|e| e.code), Some(ErrorCode::HostAuthFailed));
    assert_eq!(cmd::pr_get(&fx.tc, fx.id(), 1, None).await.unwrap_err().code, ErrorCode::HostAuthFailed);
    fx.assert_token_stays_secret();
}

#[tokio::test]
async fn pull_requests_are_listed_page_by_page_with_checks_and_reviews() {
    let fx = Fixture::new(KIND).await;
    let first = cmd::pr_list(&fx.tc, fx.id(), PrListState::Open, None, None, None).await.unwrap();
    assert_eq!((first.items.len(), first.next_page), (20, Some(2)));
    assert!(first.items.iter().all(|pr| pr.state == PrState::Open));
    assert!(first.items.windows(2).all(|pair| pair[0].number > pair[1].number), "most recently updated first, as the host returns them");
    assert_eq!(first.items[0].number, 44);
    let list_call = &fx.sent("GET", "/pulls")[0];
    assert_eq!(
        (list_call.query("state"), list_call.query("sort"), list_call.query("direction"), list_call.query("per_page"), list_call.query("page")),
        (Some("open".into()), Some("updated".into()), Some("desc".into()), Some("20".into()), Some("1".into()))
    );

    let second = cmd::pr_list(&fx.tc, fx.id(), PrListState::Open, Some(2), None, None).await.unwrap();
    assert_eq!((second.items.len(), second.next_page), (16, None));
    let by_number = |n: u64| second.items.iter().find(|pr| pr.number == n).unwrap_or_else(|| panic!("#{n}")).clone();
    let one = by_number(1);
    assert_eq!(one.title, "Anmeldung: Fehlermeldung bei leerem Passwort");
    assert_eq!((one.checks, one.review_state), (Some(ChecksState::Passing), Some(PrReviewState::Approved)));
    assert_eq!((one.source_branch.as_str(), one.target_branch.as_str(), one.is_fork, one.is_draft), ("feature/thema-1", "main", false, false));
    assert_eq!(one.author.as_ref().map(|a| a.login.as_str()), Some("jonas"));
    assert_eq!(one.labels.iter().map(|l| (l.name.as_str(), l.color.as_deref())).collect::<Vec<_>>(), vec![("bug", Some("#d73a4a"))]);
    assert_eq!(one.web_url, format!("{}/octo/demo/pull/1", fx.server.url()));
    assert_eq!((by_number(2).checks, by_number(2).review_state), (Some(ChecksState::Pending), Some(PrReviewState::ReviewRequired)));
    assert_eq!((by_number(4).checks, by_number(4).review_state), (Some(ChecksState::Failing), Some(PrReviewState::ChangesRequested)));
    assert!(by_number(3).is_draft);
    assert!(by_number(8).is_fork);
    assert_eq!((by_number(6).checks, by_number(6).review_state), (None, None), "without checks and reviews both stay empty");

    // The core separates "merged" and "closed" – GitHub returns both as closed.
    let merged = cmd::pr_list(&fx.tc, fx.id(), PrListState::Merged, None, None, None).await.unwrap();
    assert_eq!(merged.items.iter().map(|pr| (pr.number, pr.state)).collect::<Vec<_>>(), vec![(40, PrState::Merged), (30, PrState::Merged), (20, PrState::Merged), (10, PrState::Merged)]);
    let closed = cmd::pr_list(&fx.tc, fx.id(), PrListState::Closed, None, None, None).await.unwrap();
    assert_eq!(closed.items.iter().map(|pr| pr.number).collect::<Vec<_>>(), vec![45, 35, 25, 15, 5]);
    assert!(closed.items.iter().all(|pr| pr.state == PrState::Closed));
    // Very long list at once; the page size is capped.
    fx.server.clear();
    let all = cmd::pr_list(&fx.tc, fx.id(), PrListState::All, Some(1), Some(500), None).await.unwrap();
    assert_eq!((all.items.len(), all.next_page), (45, None));
    assert_eq!(fx.sent("GET", "/pulls")[0].query("per_page").as_deref(), Some("100"));
    let small = cmd::pr_list(&fx.tc, fx.id(), PrListState::All, Some(3), Some(10), None).await.unwrap();
    assert_eq!((small.items.len(), small.next_page, small.items[0].number), (10, Some(4), 25));

    check_error_modes(&fx, "GitHub", "pr_list", || cmd::pr_list(&fx.tc, fx.id(), PrListState::Open, None, None, None)).await;
    check_broken_json(&fx, "GitHub", "pr_list", || cmd::pr_list(&fx.tc, fx.id(), PrListState::Open, None, None, None)).await;
    fx.assert_token_stays_secret();
}

#[tokio::test]
async fn pull_request_details_bring_body_reviews_comments_commits_and_checks() {
    let fx = Fixture::new(KIND).await;
    let pr = cmd::pr_get(&fx.tc, fx.id(), 1, None).await.unwrap();
    assert_eq!((pr.summary.number, pr.summary.state), (1, PrState::Open));
    assert!(pr.body.contains("**Thema 1**"));
    assert_eq!(pr.reviewers.iter().map(|r| (r.user.login.as_str(), r.state)).collect::<Vec<_>>(), vec![("mira", Some(PrReviewState::Approved))]);
    assert_eq!(pr.summary.review_state, Some(PrReviewState::Approved));
    // Review text, comment on a line, general comment – by time. The empty approval is not a comment.
    assert_eq!(pr.comments.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec!["r11", "d31", "c21"]);
    assert_eq!((pr.comments[1].path.as_deref(), pr.comments[1].line), (Some("src/anmeldung.rs"), Some(42)));
    assert_eq!((pr.comments[2].path.clone(), pr.comments[2].author.as_ref().map(|a| a.login.as_str())), (None, Some("jonas")));
    assert_eq!(pr.commits.iter().map(|c| (c.summary.as_str(), c.author_name.as_str())).collect::<Vec<_>>(), vec![("Prüfung ergänzt", "Jonas Weber"), ("Meldung übersetzt", "Jonas Weber")]);
    assert_eq!(pr.mergeable, Some(true));
    assert_eq!(
        pr.check_runs.iter().map(|c| (c.name.as_str(), c.state, c.url.is_some())).collect::<Vec<_>>(),
        vec![("build", CheckRunState::Passing, true), ("docs", CheckRunState::Skipped, true), ("lizenz/cla", CheckRunState::Passing, true)]
    );
    assert_eq!(pr.summary.checks, Some(ChecksState::Passing));
    assert_eq!(pr.head_sha, format!("{:040x}", 1));
    // In the UI, the list fields and the details sit side by side.
    let shape = serde_json::to_value(&pr).unwrap();
    assert_eq!((shape["number"].clone(), shape["reviewState"].clone(), shape["checkRuns"][1]["state"].clone()), (json!(1), json!("approved"), json!("skipped")));
    assert_eq!((shape["comments"][1]["line"].clone(), shape["commits"][0]["authorName"].clone(), shape["headSha"].clone()), (json!(42), json!("Jonas Weber"), json!(pr.head_sha)));

    let waiting = cmd::pr_get(&fx.tc, fx.id(), 2, None).await.unwrap();
    assert_eq!(waiting.reviewers.iter().map(|r| (r.user.login.as_str(), r.state)).collect::<Vec<_>>(), vec![("mira", None)]);
    assert_eq!((waiting.summary.review_state, waiting.summary.checks), (Some(PrReviewState::ReviewRequired), Some(ChecksState::Pending)));
    assert_eq!(cmd::pr_get(&fx.tc, fx.id(), 13, None).await.unwrap().mergeable, Some(false));

    let error = cmd::pr_get(&fx.tc, fx.id(), 999, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::HostNotFound);
    assert_eq!(error.message, "Pull request #999 does not exist in octo/demo.");
    check_error_modes(&fx, "GitHub", "pr_get", || cmd::pr_get(&fx.tc, fx.id(), 1, None)).await;
    check_broken_json(&fx, "GitHub", "pr_get", || cmd::pr_get(&fx.tc, fx.id(), 1, None)).await;
    fx.assert_token_stays_secret();
}

#[tokio::test]
async fn pull_requests_are_created_changed_commented_merged_and_closed() {
    let fx = Fixture::new(KIND).await;
    // Create, with reviewers and labels.
    let created = cmd::pr_create(&fx.tc, fx.id(), "  Neue Anmeldung ".into(), "Text\n\nmit Absatz".into(), "feature/neu".into(), "main".into(), true, Some(vec!["@mira".into(), "mira".into(), " ".into()]), Some(vec!["bug".into()]), None)
        .await
        .unwrap();
    assert_eq!(created.number, 101);
    assert_eq!(fx.sent("POST", "/pulls")[0].json(), json!({ "title": "Neue Anmeldung", "body": "Text\n\nmit Absatz", "head": "feature/neu", "base": "main", "draft": true }));
    assert_eq!(fx.sent("POST", "/pulls/101/requested_reviewers")[0].json(), json!({ "reviewers": ["mira"] }));
    assert_eq!(fx.sent("POST", "/issues/101/labels")[0].json(), json!({ "labels": ["bug"] }));
    let plain = cmd::pr_create(&fx.tc, fx.id(), "Ohne Zusätze".into(), String::new(), "feature/neu".into(), "main".into(), false, None, None, None).await.unwrap();
    assert_eq!((plain.title.as_str(), plain.source_branch.as_str(), plain.is_draft), ("Ohne Zusätze", "feature/neu", false));
    // 422: one already exists for the branch.
    let error = cmd::pr_create(&fx.tc, fx.id(), "Doppelt".into(), String::new(), "schon-da".into(), "main".into(), false, None, None, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::NameExists);
    assert!(error.message.contains("“schon-da”") && error.message.contains("already an open pull request"), "{}", error.message);
    assert!(error.git_output.as_deref().is_some_and(|o| o.contains("already exists")));
    // Invalid input doesn't go out.
    fx.server.clear();
    assert_eq!(cmd::pr_create(&fx.tc, fx.id(), "  ".into(), String::new(), "a".into(), "main".into(), false, None, None, None).await.unwrap_err().code, ErrorCode::EmptyMessage);
    assert_eq!(cmd::pr_create(&fx.tc, fx.id(), "x".into(), String::new(), "main".into(), " main ".into(), false, None, None, None).await.unwrap_err().code, ErrorCode::NotAllowed);
    assert_eq!(cmd::pr_create(&fx.tc, fx.id(), "x".into(), String::new(), "".into(), "main".into(), false, None, None, None).await.unwrap_err().code, ErrorCode::NotAllowed);
    assert!(fx.server.requests().is_empty());
    check_error_modes(&fx, "GitHub", "pr_create", || cmd::pr_create(&fx.tc, fx.id(), "Titel".into(), String::new(), "feature/neu".into(), "main".into(), false, None, None, None)).await;

    // Update: only what is given; replace labels, add or remove reviewers.
    fx.server.clear();
    let updated = cmd::pr_update(&fx.tc, fx.id(), 1, Some("Neuer Titel".into()), None, Some("develop".into()), None, Some(vec!["jonas".into()]), Some(vec!["a".into(), "b".into()]), None).await.unwrap();
    assert_eq!(updated.number, 1);
    assert_eq!(fx.sent("PATCH", "/pulls/1")[0].json(), json!({ "title": "Neuer Titel", "base": "develop" }));
    assert_eq!(fx.sent("PUT", "/issues/1/labels")[0].json(), json!({ "labels": ["a", "b"] }));
    assert_eq!(fx.sent("POST", "/pulls/1/requested_reviewers")[0].json(), json!({ "reviewers": ["jonas"] }));
    assert!(fx.sent("DELETE", "/pulls/1/requested_reviewers").is_empty());
    fx.server.clear();
    cmd::pr_update(&fx.tc, fx.id(), 2, None, None, None, None, Some(Vec::new()), None, None).await.unwrap();
    assert_eq!(fx.sent("DELETE", "/pulls/2/requested_reviewers")[0].json(), json!({ "reviewers": ["mira"] }));
    assert!(fx.sent("PATCH", "/pulls/2").is_empty(), "no PATCH without title, body or target");
    // GitHub's REST API can't toggle draft; unchanged it is not an error.
    let error = cmd::pr_update(&fx.tc, fx.id(), 1, None, None, None, Some(true), None, None, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::HostUnsupported);
    cmd::pr_update(&fx.tc, fx.id(), 3, None, None, None, Some(true), None, None, None).await.unwrap();

    // Comment.
    let comment = cmd::pr_comment(&fx.tc, fx.id(), 1, "Passt so. 👍".into(), None).await.unwrap();
    assert_eq!((comment.id.as_str(), comment.body.as_str(), comment.author.as_ref().map(|a| a.login.as_str())), ("c99", "Passt so. 👍", Some("lena-hartmann")));
    assert_eq!(fx.sent("POST", "/issues/1/comments")[0].json(), json!({ "body": "Passt so. 👍" }));
    assert_eq!(cmd::pr_comment(&fx.tc, fx.id(), 1, " \n".into(), None).await.unwrap_err().code, ErrorCode::EmptyMessage);

    // Merge, deleting the source branch (the slash in the name stays a slash).
    fx.server.clear();
    let merged = cmd::pr_merge(&fx.tc, fx.id(), 1, PrMergeMethod::Squash, true, None).await.unwrap();
    assert_eq!(merged.state, PrState::Merged);
    assert_eq!(fx.sent("PUT", "/pulls/1/merge")[0].json(), json!({ "merge_method": "squash" }));
    assert_eq!(fx.sent("DELETE", "/git/refs/heads/feature/thema-1").len(), 1);
    // From a fork: the branch there is not touched.
    fx.server.clear();
    cmd::pr_merge(&fx.tc, fx.id(), 8, PrMergeMethod::Merge, true, None).await.unwrap();
    assert_eq!(fx.sent("PUT", "/pulls/8/merge")[0].json(), json!({ "merge_method": "merge" }));
    assert!(fx.server.requests().iter().all(|r| r.method != "DELETE"));
    // Not mergeable: the host's reason is in the message.
    let error = cmd::pr_merge(&fx.tc, fx.id(), 13, PrMergeMethod::Rebase, false, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::HostRejected);
    assert!(error.message.contains("Pull Request is not mergeable"), "{}", error.message);
    check_error_modes(&fx, "GitHub", "pr_merge", || cmd::pr_merge(&fx.tc, fx.id(), 2, PrMergeMethod::Merge, false, None)).await;

    // Close and reopen.
    fx.server.clear();
    assert_eq!(cmd::pr_close(&fx.tc, fx.id(), 2, None).await.unwrap().state, PrState::Closed);
    assert_eq!(cmd::pr_get(&fx.tc, fx.id(), 2, None).await.unwrap().summary.state, PrState::Closed);
    assert_eq!(cmd::pr_reopen(&fx.tc, fx.id(), 2, None).await.unwrap().state, PrState::Open);
    let patches: Vec<_> = fx.sent("PATCH", "/pulls/2").iter().map(|r| r.json()).collect();
    assert_eq!(patches, vec![json!({ "state": "closed" }), json!({ "state": "open" })]);
    check_error_modes(&fx, "GitHub", "pr_close", || cmd::pr_close(&fx.tc, fx.id(), 2, None)).await;
    check_error_modes(&fx, "GitHub", "pr_comment", || cmd::pr_comment(&fx.tc, fx.id(), 2, "Text".into(), None)).await;
    fx.assert_token_stays_secret();
}

#[tokio::test]
async fn issues_are_listed_searched_and_read() {
    let fx = Fixture::new(KIND).await;
    let open = cmd::issue_list(&fx.tc, fx.id(), IssueListState::Open, None, None, None, None).await.unwrap();
    // GitHub's issue list also contains pull requests (here 3, 6, 9): they are dropped.
    assert_eq!(open.items.iter().map(|i| i.number).collect::<Vec<_>>(), vec![11, 10, 7, 5, 2, 1]);
    assert_eq!(open.next_page, None);
    let two = open.items.iter().find(|i| i.number == 2).unwrap();
    assert_eq!((two.key.as_str(), two.title.as_str(), two.state), ("#2", "Problem 2", IssueState::Open));
    assert_eq!(two.assignees.iter().map(|a| a.login.as_str()).collect::<Vec<_>>(), vec!["lena-hartmann"]);
    assert_eq!(two.labels[0].color.as_deref(), Some("#0e8a16"));
    assert_eq!(two.web_url, format!("{}/octo/demo/issues/2", fx.server.url()));
    let closed = cmd::issue_list(&fx.tc, fx.id(), IssueListState::Closed, Some("  ".into()), None, None, None).await.unwrap();
    assert_eq!(closed.items.iter().map(|i| (i.number, i.state)).collect::<Vec<_>>(), vec![(8, IssueState::Closed), (4, IssueState::Closed)]);
    let paged = cmd::issue_list(&fx.tc, fx.id(), IssueListState::All, None, Some(1), Some(5), None).await.unwrap();
    assert_eq!((paged.items.iter().map(|i| i.number).collect::<Vec<_>>(), paged.next_page), (vec![11, 10, 8], Some(2)));

    // With search text through the search, limited to this repository and issues.
    fx.server.clear();
    let found = cmd::issue_list(&fx.tc, fx.id(), IssueListState::Open, Some(" anmeldung fehler ".into()), None, None, None).await.unwrap();
    assert_eq!(found.items.iter().map(|i| i.number).collect::<Vec<_>>(), vec![1, 2]);
    let search = &fx.sent("GET", "/search/issues")[0];
    assert_eq!(search.query("q").as_deref(), Some("anmeldung fehler repo:octo/demo is:issue is:open"));

    let issue = cmd::issue_get(&fx.tc, fx.id(), 2, None).await.unwrap();
    assert_eq!((issue.summary.number, issue.body.as_str()), (2, "Text zu Problem 2"));
    assert_eq!(issue.comments.iter().map(|c| (c.id.as_str(), c.body.as_str())).collect::<Vec<_>>(), vec![("c21", "Danke fürs Ansehen!")]);
    let shape = serde_json::to_value(&issue).unwrap();
    assert_eq!((shape["key"].clone(), shape["body"].clone(), shape["comments"][0]["createdAt"].clone()), (json!("#2"), json!("Text zu Problem 2"), json!("2026-09-02T09:45:00Z")));
    let error = cmd::issue_get(&fx.tc, fx.id(), 3, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::HostNotFound);
    assert!(error.message.contains("a pull request, not an issue"), "{}", error.message);
    assert_eq!(cmd::issue_get(&fx.tc, fx.id(), 999, None).await.unwrap_err().message, "Issue #999 does not exist in octo/demo.");

    check_error_modes(&fx, "GitHub", "issue_list", || cmd::issue_list(&fx.tc, fx.id(), IssueListState::Open, None, None, None, None)).await;
    check_error_modes(&fx, "GitHub", "issue_list mit Suche", || cmd::issue_list(&fx.tc, fx.id(), IssueListState::Open, Some("x".into()), None, None, None)).await;
    check_error_modes(&fx, "GitHub", "issue_get", || cmd::issue_get(&fx.tc, fx.id(), 2, None)).await;
    check_broken_json(&fx, "GitHub", "issue_list", || cmd::issue_list(&fx.tc, fx.id(), IssueListState::Open, None, None, None, None)).await;
    fx.assert_token_stays_secret();
}

/// Gives `origin` a real counterpart: a bare repository. The remote's URL still points to the
/// host (that's how it is recognised); Git itself redirects it to the local path.
pub(super) fn back_origin_with_a_real_repository(fx: &Fixture, path: &str) -> TestRemote {
    let bare = TestRemote::new();
    let shown = format!("{}/{path}.git", fx.server.url());
    fx.repo.git(&["config", &format!("url.{}.insteadOf", bare.url()), &shown]);
    fx.repo.git(&["push", "-q", "origin", "main"]);
    bare
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checkout_fetches_the_branch_of_a_pull_request() {
    let fx = Fixture::new(KIND).await;
    let repo = &fx.repo;
    let _bare = back_origin_with_a_real_repository(&fx, "octo/demo");
    // No. 7 comes from the branch feature/login in the same repository, no. 8 from a fork.
    repo.checkout_new("feature/login");
    let login = repo.commit_file("login.txt", "anmeldung\n", "Anmeldung gebaut");
    repo.git(&["push", "-q", "origin", "feature/login"]);
    repo.checkout("main");
    repo.checkout_new("fremd");
    let fork_first = repo.commit_file("fork.txt", "aus dem fork\n", "Korrektur aus dem Fork");
    repo.git(&["push", "-q", "origin", "HEAD:refs/pull/8/head"]);
    repo.checkout("main");
    repo.git(&["branch", "-D", "feature/login", "fremd"]);
    repo.git(&["update-ref", "-d", "refs/remotes/origin/feature/login"]);

    // Same repository: the branch is named as on the host and tracks it.
    cmd::pr_checkout(&fx.tc, fx.id(), 7, None).await.unwrap();
    assert_eq!((repo.current_branch(), repo.head()), ("feature/login".to_string(), login.clone()));
    assert_eq!(repo.git(&["rev-parse", "--abbrev-ref", "feature/login@{upstream}"]), "origin/feature/login");
    // Once more while it is checked out: nothing to do.
    cmd::pr_checkout(&fx.tc, fx.id(), 7, None).await.unwrap();
    assert_eq!(repo.head(), login);

    // Fork: local branch pr-8 from the pull request's ref.
    cmd::pr_checkout(&fx.tc, fx.id(), 8, None).await.unwrap();
    assert_eq!((repo.current_branch(), repo.head()), ("pr-8".to_string(), fork_first.clone()));
    // The pull request gets another commit; it is fast-forwarded from another branch.
    let fork_second = repo.commit_file("fork.txt", "aus dem fork, verbessert\n", "Nachgebessert");
    repo.git(&["push", "-q", "origin", "HEAD:refs/pull/8/head"]);
    repo.git(&["reset", "-q", "--hard", &fork_first]);
    repo.checkout("main");
    cmd::pr_checkout(&fx.tc, fx.id(), 8, None).await.unwrap();
    assert_eq!((repo.current_branch(), repo.head()), ("pr-8".to_string(), fork_second.clone()));
    // Own commits on top are kept (the fetched state is already contained).
    let own = repo.commit_file("eigenes.txt", "x\n", "Eigener Commit");
    cmd::pr_checkout(&fx.tc, fx.id(), 8, None).await.unwrap();
    assert_eq!(repo.head(), own);
    // Rewritten on the host, own commits locally: refused, nothing is lost.
    repo.checkout("main");
    repo.checkout_new("umgeschrieben");
    repo.commit_file("fork.txt", "ganz anders\n", "Neu geschrieben");
    repo.git(&["push", "-q", "origin", "+HEAD:refs/pull/8/head"]);
    repo.checkout("main");
    let error = cmd::pr_checkout(&fx.tc, fx.id(), 8, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::NotAllowed, "{error:?}");
    assert!(error.message.contains("“pr-8”") && error.message.contains("has commits"), "{}", error.message);
    assert_eq!(repo.git(&["rev-parse", "pr-8"]), own);
    assert_eq!(repo.git(&["for-each-ref", "refs/forkyard/pull"]), "", "the helper ref is not left behind");

    // The pull request doesn't exist; and one whose branch the remote doesn't have (anymore).
    assert_eq!(cmd::pr_checkout(&fx.tc, fx.id(), 999, None).await.unwrap_err().code, ErrorCode::HostNotFound);
    let error = cmd::pr_checkout(&fx.tc, fx.id(), 9, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::HostNotFound, "{error:?}");
    assert!(error.message.contains("does not offer the branch"), "{}", error.message);
    fx.assert_token_stays_secret();
}

#[tokio::test]
async fn releases_are_created_for_the_commit_of_the_local_tag() {
    use crate::model::HostRelease;
    let fx = Fixture::new(KIND).await;
    fx.repo.git(&["tag", "-a", "v2.0.0-beta.1", "-m", "Beta für die Schulen"]);
    let commit = fx.repo.git(&["rev-parse", "v2.0.0-beta.1^{commit}"]);
    assert_ne!(commit, fx.repo.git(&["rev-parse", "v2.0.0-beta.1"]), "an annotated tag is an object of its own");
    let notes = "### Neu\n\n- Export als CSV für „Süd“\n\n### Behoben\n\n- Absturz bei leerem Namen";
    let release = cmd::release_create(&fx.tc, fx.id(), "v2.0.0-beta.1".into(), "  ".into(), notes.into(), true, None).await.unwrap();
    assert_eq!(
        release,
        HostRelease { tag: "v2.0.0-beta.1".into(), name: "v2.0.0-beta.1".into(), web_url: Some(format!("{}/octo/demo/releases/tag/v2.0.0-beta.1", fx.server.url())) }
    );
    let sent = fx.sent("POST", "/api/v3/repos/octo/demo/releases");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].json(), json!({"tag_name": "v2.0.0-beta.1", "target_commitish": commit, "name": "v2.0.0-beta.1", "body": notes, "draft": false, "prerelease": true}));
    assert_eq!(serde_json::to_value(&release).unwrap()["webUrl"], json!(format!("{}/octo/demo/releases/tag/v2.0.0-beta.1", fx.server.url())));

    // GitHub answers 422 "already_exists" for a second release of the same tag.
    fx.repo.tag("schon-da");
    let error = cmd::release_create(&fx.tc, fx.id(), "schon-da".into(), String::new(), "x".into(), false, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::NameExists);
    assert!(error.message.contains("schon-da"), "{}", error.message);
    assert_clean(&error);

    // Invalid input and a tag that does not exist locally never reach the host.
    fx.server.clear();
    for (tag, name) in [("v9.9.9", ""), ("-v1", ""), ("v2.0.0-beta.1", "zwei\nZeilen"), ("mit leer", "")] {
        let error = cmd::release_create(&fx.tc, fx.id(), tag.into(), name.into(), "x".into(), false, None).await.unwrap_err();
        let expected = if tag == "v9.9.9" { ErrorCode::NotFound } else { ErrorCode::NotAllowed };
        assert_eq!(error.code, expected, "{tag:?} {name:?}");
    }
    let too_long = "ä".repeat(125_001);
    assert_eq!(cmd::release_create(&fx.tc, fx.id(), "v2.0.0-beta.1".into(), String::new(), too_long, false, None).await.unwrap_err().code, ErrorCode::NotAllowed);
    assert!(fx.server.requests().is_empty());

    check_error_modes(&fx, "GitHub", "release_create", || cmd::release_create(&fx.tc, fx.id(), "v2.0.0-beta.1".into(), String::new(), "x".into(), false, None)).await;
    fx.assert_token_stays_secret();
}

#[test]
fn the_graphql_endpoint_belongs_to_the_api() {
    assert_eq!(crate::host::github::graphql_url("https://api.github.com"), "https://api.github.com/graphql");
    assert_eq!(crate::host::github::graphql_url("https://git.firma.example/api/v3"), "https://git.firma.example/api/graphql");
}

#[tokio::test]
async fn graphql_never_sends_the_token_to_another_server() {
    let fx = Fixture::new(KIND).await;
    let api = crate::host::api_for_repo(&fx.tc, &fx.id(), None).await.unwrap().api;
    for elsewhere in ["https://evil.example/api/graphql", "ftp://127.0.0.1/api/graphql", "graphql"] {
        let error = api.graphql(&fx.tc, elsewhere, "query { viewer { login } }", json!({})).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::Unknown, "{elsewhere}");
    }
    assert!(fx.server.requests().is_empty(), "nothing was sent");
}

#[tokio::test]
async fn review_threads_come_from_graphql_with_resolved_and_outdated_state() {
    let fx = Fixture::new(KIND).await;
    let threads = cmd::pr_review_threads(&fx.tc, fx.id(), 9, None).await.unwrap();
    let rows: Vec<_> = threads.iter().map(|t| (t.id.as_str(), t.path.as_str(), t.line, t.start_line, t.side, t.resolved, t.outdated)).collect();
    assert_eq!(
        rows,
        vec![
            ("9001", "src/anmeldung.rs", Some(42), Some(40), ReviewSide::New, false, false),
            ("9011", "src/meldung.rs", Some(7), None, ReviewSide::New, true, false),
            ("9021", "src/alt.rs", None, None, ReviewSide::New, false, true),
        ]
    );
    let first = &threads[0];
    assert_eq!(first.commit.as_deref(), Some(format!("{:040x}", 9).as_str()));
    let comments: Vec<_> = first.comments.iter().map(|c| (c.id.as_str(), c.author.as_ref().map(|a| a.login.as_str()), c.body.as_str(), c.path.as_deref(), c.line)).collect();
    assert_eq!(
        comments,
        vec![
            ("9001", Some("mira"), "Hier fehlt die Prüfung auf leer.", Some("src/anmeldung.rs"), Some(42)),
            ("9002", Some("jonas"), "Stimmt, mache ich.", Some("src/anmeldung.rs"), Some(42)),
        ]
    );
    assert_eq!(threads[2].comments[0].line, Some(12), "an outdated comment still names its original line");
    // Two pages of two threads: the cursor of the first answer comes back as `after`.
    let calls = fx.sent("POST", "/api/graphql");
    assert_eq!(calls.len(), 2);
    assert_eq!(calls[0].json()["variables"], json!({ "owner": "octo", "name": "demo", "number": 9, "after": null }));
    assert_eq!(calls[1].json()["variables"]["after"], "seite-2");
    assert!(calls[0].json()["query"].as_str().unwrap().contains("reviewThreads"));
    assert_eq!(calls[0].header("authorization"), Some(format!("Bearer {TOKEN}").as_str()));
    // A pull request that does not exist.
    let error = cmd::pr_review_threads(&fx.tc, fx.id(), 999, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::HostNotFound);
    assert!(error.message.contains("#999"), "{}", error.message);
    check_error_modes(&fx, "GitHub", "review threads", || cmd::pr_review_threads(&fx.tc, fx.id(), 9, None)).await;
    check_broken_json(&fx, "GitHub", "review threads", || cmd::pr_review_threads(&fx.tc, fx.id(), 9, None)).await;
    fx.assert_token_stays_secret();
}

#[tokio::test]
async fn a_reply_goes_into_the_thread_of_its_first_comment() {
    let fx = Fixture::new(KIND).await;
    let reply = cmd::pr_review_reply(&fx.tc, fx.id(), 9, "9001".into(), "Erledigt in abc1234 – „leer“ wird geprüft.".into(), None).await.unwrap();
    assert!(!reply.quoted);
    let comment = &reply.comment;
    assert_eq!((comment.id.as_str(), comment.body.as_str(), comment.path.as_deref(), comment.line), ("9003", "Erledigt in abc1234 – „leer“ wird geprüft.", Some("src/anmeldung.rs"), Some(42)));
    let sent = fx.sent("POST", "/pulls/9/comments/9001/replies");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].json(), json!({ "body": "Erledigt in abc1234 – „leer“ wird geprüft." }));
    let error = cmd::pr_review_reply(&fx.tc, fx.id(), 9, "4711".into(), "Danke".into(), None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::HostNotFound);
    assert!(error.message.contains("review thread"), "{}", error.message);
    let caps = cmd::host_repo_info(&fx.tc, fx.id(), None).await.unwrap().unwrap().capabilities;
    assert!(caps.review_threads && caps.review_reply && !caps.review_reply_quotes);
    check_error_modes(&fx, "GitHub", "review reply", || cmd::pr_review_reply(&fx.tc, fx.id(), 9, "9001".into(), "Danke".into(), None)).await;
    fx.assert_token_stays_secret();
}
