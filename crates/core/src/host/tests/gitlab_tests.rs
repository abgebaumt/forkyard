//! GitLab: success and error cases per command against the test server. The project lives in a
//! subgroup (`gruppe/unter/demo`) – the API addresses contain its path encoded.

use serde_json::json;

use super::github_tests::back_origin_with_a_real_repository;
use super::*;
use crate::model::{CheckRunState, ChecksState, HostRepoRef, IssueListState, IssueState, PrListState, PrMergeMethod, PrReviewState, PrState};

const KIND: HostKind = HostKind::Gitlab;
const PROJECT: &str = "/api/v4/projects/gruppe%2Funter%2Fdemo";

#[tokio::test]
async fn account_and_repository_are_recognised() {
    let fx = Fixture::new(KIND).await;
    let account = fx.account.clone();
    let user = account.user.clone().unwrap();
    assert_eq!((account.kind, user.login.as_str(), user.name.as_deref()), (KIND, "lena.hartmann", Some("Lena Hartmann")));
    assert!(account.scopes_ok && account.missing_scopes.is_empty());
    assert_eq!(fx.tc.secrets.snapshot(), vec![(format!("hoster:{}", account.id), TOKEN.to_string())]);

    // Check again: `/user` and the token's permissions.
    cmd::host_check(&fx.tc, account.id.clone()).await.unwrap();
    assert_eq!(fx.sent("GET", "/api/v4/user")[0].header("authorization"), Some(format!("Bearer {TOKEN}").as_str()));
    assert_eq!(fx.sent("GET", "/api/v4/personal_access_tokens/self").len(), 1);
    // A token without `api`.
    let weak = cmd::host_connect(&fx.tc, KIND, Some(fx.server.url()), WEAK_TOKEN.into(), None).await.unwrap();
    assert_eq!((weak.id.as_str(), weak.scopes_ok, weak.missing_scopes.clone()), (account.id.as_str(), false, vec!["api".to_string()]));
    cmd::host_connect(&fx.tc, KIND, Some(fx.server.url()), TOKEN.into(), None).await.unwrap();
    let error = cmd::host_connect(&fx.tc, KIND, Some(fx.server.url()), format!("glpat-{}", "ErfundenUndFalsch000"), None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::HostAuthFailed);
    assert!(error.message.contains("GitLab"), "{}", error.message);

    let info = cmd::host_repo_info(&fx.tc, fx.id(), None).await.unwrap().unwrap();
    assert_eq!((info.kind, info.owner.as_str(), info.name.as_str()), (KIND, "gruppe/unter", "demo"));
    assert_eq!(info.web_url, format!("{}/gruppe/unter/demo", fx.server.url()));
    assert_eq!((info.default_branch.as_deref(), info.can_push), (Some("main"), Some(true)));
    assert_eq!(info.fork_parent, Some(HostRepoRef { owner: "quelle/gruppe".into(), name: "demo".into(), web_url: format!("{}/quelle/gruppe/demo", fx.server.url()) }));
    assert_eq!(fx.sent("GET", PROJECT).len(), 1, "the project is addressed by its encoded path");

    fx.mode("rate");
    let limited = cmd::host_repo_info(&fx.tc, fx.id(), None).await.unwrap().unwrap();
    assert_eq!(limited.error.map(|e| e.code), Some(ErrorCode::HostRateLimited));
    fx.mode("ok");
    fx.assert_token_stays_secret();
}

#[tokio::test]
async fn merge_requests_are_listed_and_read() {
    let fx = Fixture::new(KIND).await;
    let first = cmd::pr_list(&fx.tc, fx.id(), PrListState::Open, None, None, None).await.unwrap();
    assert_eq!((first.items.len(), first.next_page, first.items[0].number), (20, Some(2), 44));
    let call = &fx.sent("GET", "/merge_requests")[0];
    assert_eq!((call.query("state"), call.query("order_by"), call.query("sort"), call.query("per_page")), (Some("opened".into()), Some("updated_at".into()), Some("desc".into()), Some("20".into())));
    let second = cmd::pr_list(&fx.tc, fx.id(), PrListState::Open, Some(2), None, None).await.unwrap();
    assert_eq!((second.items.len(), second.next_page), (16, None));
    let by_number = |n: u64| second.items.iter().find(|mr| mr.number == n).unwrap_or_else(|| panic!("!{n}")).clone();
    assert_eq!((by_number(1).checks, by_number(1).review_state), (Some(ChecksState::Passing), Some(PrReviewState::Approved)));
    assert_eq!((by_number(2).checks, by_number(2).review_state), (Some(ChecksState::Pending), Some(PrReviewState::ReviewRequired)));
    assert_eq!((by_number(4).checks, by_number(4).review_state), (Some(ChecksState::Failing), None));
    assert_eq!((by_number(6).checks, by_number(6).review_state), (None, None));
    assert!(by_number(3).is_draft && by_number(8).is_fork && !by_number(7).is_fork);
    assert_eq!(by_number(1).labels.iter().map(|l| (l.name.as_str(), l.color.clone())).collect::<Vec<_>>(), vec![("bug", None)]);
    assert_eq!(by_number(1).author.as_ref().map(|a| a.login.as_str()), Some("jonas"));
    // GitLab itself filters by "merged" and "closed".
    let merged = cmd::pr_list(&fx.tc, fx.id(), PrListState::Merged, None, None, None).await.unwrap();
    assert_eq!(merged.items.iter().map(|mr| (mr.number, mr.state)).collect::<Vec<_>>(), vec![(40, PrState::Merged), (30, PrState::Merged), (20, PrState::Merged), (10, PrState::Merged)]);
    let closed = cmd::pr_list(&fx.tc, fx.id(), PrListState::Closed, None, None, None).await.unwrap();
    assert_eq!(closed.items.iter().map(|mr| mr.number).collect::<Vec<_>>(), vec![45, 35, 25, 15, 5]);
    let all = cmd::pr_list(&fx.tc, fx.id(), PrListState::All, None, Some(100), None).await.unwrap();
    assert_eq!((all.items.len(), all.next_page), (45, None));

    let mr = cmd::pr_get(&fx.tc, fx.id(), 1, None).await.unwrap();
    assert!(mr.body.contains("**Thema 1**"));
    assert_eq!(mr.reviewers.iter().map(|r| (r.user.login.as_str(), r.state)).collect::<Vec<_>>(), vec![("mira", Some(PrReviewState::Approved))]);
    // System notes ("changed the title") are not comments.
    assert_eq!(mr.comments.iter().map(|c| (c.id.as_str(), c.body.as_str())).collect::<Vec<_>>(), vec![("2", "Sieht gut aus."), ("3", "Hier bitte prüfen.")]);
    assert_eq!((mr.comments[1].path.as_deref(), mr.comments[1].line), (Some("src/anmeldung.rs"), Some(42)));
    assert_eq!(mr.commits.len(), 2);
    assert_eq!((mr.commits[0].summary.as_str(), mr.commits[0].author_name.as_str()), ("Meldung übersetzt", "Jonas Weber"));
    assert_eq!(mr.mergeable, Some(true));
    // The individual jobs of the pipeline.
    assert_eq!(mr.check_runs.iter().map(|c| (c.name.as_str(), c.state)).collect::<Vec<_>>(), vec![("build", CheckRunState::Passing), ("lint", CheckRunState::Skipped)]);
    assert_eq!((mr.summary.checks, mr.head_sha.as_str()), (Some(ChecksState::Passing), format!("{:040x}", 1).as_str()));
    // Jobs not readable: the pipeline stays as one entry.
    let running = cmd::pr_get(&fx.tc, fx.id(), 2, None).await.unwrap();
    assert_eq!(running.check_runs.iter().map(|c| (c.name.as_str(), c.state)).collect::<Vec<_>>(), vec![("Pipeline", CheckRunState::Pending)]);
    assert_eq!(cmd::pr_get(&fx.tc, fx.id(), 13, None).await.unwrap().mergeable, Some(false));
    assert_eq!(cmd::pr_get(&fx.tc, fx.id(), 999, None).await.unwrap_err().message, "Merge request !999 does not exist in gruppe/unter/demo.");

    check_error_modes(&fx, "GitLab", "pr_list", || cmd::pr_list(&fx.tc, fx.id(), PrListState::Open, None, None, None)).await;
    check_error_modes(&fx, "GitLab", "pr_get", || cmd::pr_get(&fx.tc, fx.id(), 1, None)).await;
    check_broken_json(&fx, "GitLab", "pr_list", || cmd::pr_list(&fx.tc, fx.id(), PrListState::Open, None, None, None)).await;
    check_broken_json(&fx, "GitLab", "pr_get", || cmd::pr_get(&fx.tc, fx.id(), 1, None)).await;
    fx.assert_token_stays_secret();
}

#[tokio::test]
async fn merge_requests_are_created_changed_commented_merged_and_closed() {
    let fx = Fixture::new(KIND).await;
    let created = cmd::pr_create(&fx.tc, fx.id(), "Neue Anmeldung".into(), "Text".into(), "feature/neu".into(), "main".into(), true, Some(vec!["mira".into()]), Some(vec!["bug".into(), "ui".into()]), None).await.unwrap();
    assert_eq!((created.number, created.title.as_str(), created.is_draft), (101, "Draft: Neue Anmeldung", true));
    assert_eq!(
        fx.sent("POST", "/merge_requests")[0].json(),
        json!({ "source_branch": "feature/neu", "target_branch": "main", "title": "Draft: Neue Anmeldung", "description": "Text", "labels": "bug,ui", "reviewer_ids": [44] })
    );
    assert_eq!(fx.sent("GET", "/api/v4/users")[0].query("username").as_deref(), Some("mira"));
    // A reviewer who doesn't exist: nothing is created.
    fx.server.clear();
    let error = cmd::pr_create(&fx.tc, fx.id(), "x".into(), String::new(), "feature/neu".into(), "main".into(), false, Some(vec!["niemand".into()]), None, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::HostRejected);
    assert!(error.message.contains("“niemand”"), "{}", error.message);
    assert!(fx.sent("POST", "/merge_requests").is_empty());
    // 409: one already exists for the branch.
    let error = cmd::pr_create(&fx.tc, fx.id(), "Doppelt".into(), String::new(), "schon-da".into(), "main".into(), false, None, None, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::NameExists);
    assert!(error.message.contains("already an open merge request"), "{}", error.message);
    check_error_modes(&fx, "GitLab", "pr_create", || cmd::pr_create(&fx.tc, fx.id(), "Titel".into(), String::new(), "feature/neu".into(), "main".into(), false, None, None, None)).await;

    // Update: the draft state lives in the title.
    fx.server.clear();
    let ready = cmd::pr_update(&fx.tc, fx.id(), 3, None, None, None, Some(false), None, None, None).await.unwrap();
    assert_eq!((ready.title.as_str(), ready.is_draft), ("Thema 3 umsetzen", false));
    assert_eq!(fx.sent("PUT", "/merge_requests/3")[0].json(), json!({ "title": "Thema 3 umsetzen" }));
    fx.server.clear();
    cmd::pr_update(&fx.tc, fx.id(), 3, Some("Neuer Titel".into()), Some("Neuer Text".into()), Some("develop".into()), None, Some(vec!["mira".into()]), Some(Vec::new()), None).await.unwrap();
    assert_eq!(
        fx.sent("PUT", "/merge_requests/3")[0].json(),
        json!({ "title": "Draft: Neuer Titel", "description": "Neuer Text", "target_branch": "develop", "labels": "", "reviewer_ids": [44] }),
        "ein Entwurf bleibt beim Umbenennen ein Entwurf"
    );
    fx.server.clear();
    cmd::pr_update(&fx.tc, fx.id(), 4, None, None, None, None, None, None, None).await.unwrap();
    assert!(fx.sent("PUT", "/merge_requests/4").is_empty(), "no write call without a change");

    let note = cmd::pr_comment(&fx.tc, fx.id(), 1, "Passt so.".into(), None).await.unwrap();
    assert_eq!((note.id.as_str(), note.body.as_str()), ("99", "Passt so."));
    assert_eq!(fx.sent("POST", "/merge_requests/1/notes")[0].json(), json!({ "body": "Passt so." }));

    let merged = cmd::pr_merge(&fx.tc, fx.id(), 1, PrMergeMethod::Squash, true, None).await.unwrap();
    assert_eq!(merged.state, PrState::Merged);
    assert_eq!(fx.sent("PUT", "/merge_requests/1/merge")[0].json(), json!({ "squash": true, "should_remove_source_branch": true }));
    cmd::pr_merge(&fx.tc, fx.id(), 2, PrMergeMethod::Merge, false, None).await.unwrap();
    assert_eq!(fx.sent("PUT", "/merge_requests/2/merge")[0].json(), json!({ "squash": false, "should_remove_source_branch": false }));
    // GitLab has no rebase merge method here; nothing goes out.
    fx.server.clear();
    assert_eq!(cmd::pr_merge(&fx.tc, fx.id(), 4, PrMergeMethod::Rebase, false, None).await.unwrap_err().code, ErrorCode::HostUnsupported);
    assert!(fx.server.requests().iter().all(|r| r.method == "GET"));
    let error = cmd::pr_merge(&fx.tc, fx.id(), 13, PrMergeMethod::Merge, false, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::HostRejected);
    assert!(error.message.contains("405 Method Not Allowed"), "{}", error.message);

    assert_eq!(cmd::pr_close(&fx.tc, fx.id(), 6, None).await.unwrap().state, PrState::Closed);
    assert_eq!(cmd::pr_reopen(&fx.tc, fx.id(), 6, None).await.unwrap().state, PrState::Open);
    let events: Vec<_> = fx.sent("PUT", "/merge_requests/6").iter().map(|r| r.json()).collect();
    assert_eq!(events, vec![json!({ "state_event": "close" }), json!({ "state_event": "reopen" })]);
    check_error_modes(&fx, "GitLab", "pr_merge", || cmd::pr_merge(&fx.tc, fx.id(), 7, PrMergeMethod::Merge, false, None)).await;
    check_error_modes(&fx, "GitLab", "pr_comment", || cmd::pr_comment(&fx.tc, fx.id(), 7, "Text".into(), None)).await;
    fx.assert_token_stays_secret();
}

#[tokio::test]
async fn issues_are_listed_searched_and_read() {
    let fx = Fixture::new(KIND).await;
    let open = cmd::issue_list(&fx.tc, fx.id(), IssueListState::Open, None, None, None, None).await.unwrap();
    assert_eq!(open.items.iter().map(|i| i.number).collect::<Vec<_>>(), vec![11, 10, 9, 7, 6, 5, 3, 2, 1]);
    assert_eq!((open.items[0].key.as_str(), open.items[0].state, open.next_page), ("#11", IssueState::Open, None));
    assert_eq!(fx.sent("GET", "/issues")[0].query("state").as_deref(), Some("opened"));
    let found = cmd::issue_list(&fx.tc, fx.id(), IssueListState::All, Some("anmeldung".into()), None, None, None).await.unwrap();
    assert_eq!(found.items.iter().map(|i| i.number).collect::<Vec<_>>(), vec![2, 1]);
    assert_eq!(fx.sent("GET", "/issues")[1].query("search").as_deref(), Some("anmeldung"));
    let paged = cmd::issue_list(&fx.tc, fx.id(), IssueListState::All, None, Some(2), Some(5), None).await.unwrap();
    assert_eq!((paged.items.iter().map(|i| i.number).collect::<Vec<_>>(), paged.next_page), (vec![7, 6, 5, 4, 3], Some(3)));

    let issue = cmd::issue_get(&fx.tc, fx.id(), 2, None).await.unwrap();
    assert_eq!((issue.body.as_str(), issue.summary.assignees[0].login.as_str()), ("Text zu Problem 2", "lena.hartmann"));
    assert_eq!(issue.comments.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec!["2", "3"]);
    assert_eq!(cmd::issue_get(&fx.tc, fx.id(), 999, None).await.unwrap_err().code, ErrorCode::HostNotFound);
    check_error_modes(&fx, "GitLab", "issue_list", || cmd::issue_list(&fx.tc, fx.id(), IssueListState::Open, None, None, None, None)).await;
    check_broken_json(&fx, "GitLab", "issue_list", || cmd::issue_list(&fx.tc, fx.id(), IssueListState::Open, None, None, None, None)).await;
    fx.assert_token_stays_secret();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checkout_fetches_the_branch_of_a_merge_request() {
    let fx = Fixture::new(KIND).await;
    let repo = &fx.repo;
    let _bare = back_origin_with_a_real_repository(&fx, "gruppe/unter/demo");
    repo.checkout_new("fremd");
    let from_fork = repo.commit_file("fork.txt", "aus dem fork\n", "Korrektur aus dem Fork");
    repo.git(&["push", "-q", "origin", "HEAD:refs/merge-requests/8/head"]);
    repo.checkout("main");
    repo.git(&["branch", "-D", "fremd"]);
    cmd::pr_checkout(&fx.tc, fx.id(), 8, None).await.unwrap();
    assert_eq!((repo.current_branch(), repo.head()), ("mr-8".to_string(), from_fork));
    assert_eq!(repo.git(&["for-each-ref", "refs/forkyard/pull"]), "");
    fx.assert_token_stays_secret();
}

#[tokio::test]
async fn releases_are_created_with_the_tag_commit_as_ref() {
    use crate::model::HostRelease;
    let fx = Fixture::new(KIND).await;
    fx.repo.git(&["tag", "-a", "v2.0.0", "-m", "Version 2"]);
    let commit = fx.repo.git(&["rev-parse", "v2.0.0^{commit}"]);
    let notes = "### Added\n\n- Merge requests for „Süd“";
    let release = cmd::release_create(&fx.tc, fx.id(), "v2.0.0".into(), "Version 2".into(), notes.into(), true, None).await.unwrap();
    assert_eq!(release, HostRelease { tag: "v2.0.0".into(), name: "Version 2".into(), web_url: Some(format!("{}/gruppe/unter/demo/-/releases/v2.0.0", fx.server.url())) });
    let sent = fx.sent("POST", "/releases");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].path(), "/api/v4/projects/gruppe%2Funter%2Fdemo/releases");
    assert_eq!(sent[0].json(), json!({"tag_name": "v2.0.0", "ref": commit, "name": "Version 2", "description": notes}), "GitLab has no prerelease flag");
    fx.repo.tag("schon-da");
    assert_eq!(cmd::release_create(&fx.tc, fx.id(), "schon-da".into(), String::new(), "x".into(), false, None).await.unwrap_err().code, ErrorCode::NameExists);
    fx.assert_token_stays_secret();
}
