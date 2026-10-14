//! Bitbucket Cloud: success and error cases per command against the test server (`team/demo`
//! under `/2.0`, Basic authentication with account e-mail and token).

use base64::Engine;

use super::github_tests::back_origin_with_a_real_repository;
use super::*;
use crate::host::detect::normalize_base_url;
use crate::model::{CheckRunState, ChecksState, HostRepoRef, IssueListState, IssueState, PrListState, PrMergeMethod, PrReviewState, PrState};

const KIND: HostKind = HostKind::Bitbucket;
const LABEL: &str = "Bitbucket";

#[tokio::test]
async fn account_needs_a_user_name_and_signs_in_with_basic_auth() {
    let fx = Fixture::new(KIND).await;
    let account = fx.account.clone();
    assert_eq!((account.kind, account.username.as_deref(), account.user.as_ref().map(|u| u.login.as_str())), (KIND, Some(USERNAME), Some("lena")));
    assert_eq!(account.user.as_ref().and_then(|u| u.name.as_deref()), Some("Lena Hartmann"));
    assert!(account.scopes_ok);
    assert_eq!(fx.tc.secrets.snapshot(), vec![(format!("hoster:{}", account.id), TOKEN.to_string())], "only the token is secret");
    cmd::host_check(&fx.tc, account.id.clone()).await.unwrap();
    let expected = format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{USERNAME}:{TOKEN}")));
    assert_eq!(fx.sent("GET", "/2.0/user")[0].header("authorization"), Some(expected.as_str()));
    // Without a user name – or with a colon or space in it – nothing goes out.
    fx.server.clear();
    for name in [None, Some("  ".to_string()), Some("lena:x".to_string()), Some("le na".to_string())] {
        let error = cmd::host_connect(&fx.tc, KIND, Some(fx.server.url()), TOKEN.into(), name.clone()).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::NotAllowed, "{name:?}");
        assert_clean(&error);
    }
    assert!(fx.server.requests().is_empty());
    // A token without permission to write pull requests.
    let weak = cmd::host_connect(&fx.tc, KIND, Some(fx.server.url()), WEAK_TOKEN.into(), Some(USERNAME.into())).await.unwrap();
    assert_eq!((weak.id.as_str(), weak.scopes_ok, weak.missing_scopes.clone()), (account.id.as_str(), false, vec!["pullrequest:write".to_string()]));
    cmd::host_connect(&fx.tc, KIND, Some(fx.server.url()), TOKEN.into(), Some(USERNAME.into())).await.unwrap();
    let error = cmd::host_connect(&fx.tc, KIND, Some(fx.server.url()), "ATBBErfundenUndFalsch000000000000000".into(), Some(USERNAME.into())).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::HostAuthFailed);
    assert!(error.message.contains(LABEL), "{}", error.message);
    // Only Bitbucket Cloud: another address is refused before anything is sent.
    assert_eq!(normalize_base_url(KIND, None).unwrap(), "https://bitbucket.org");
    assert_eq!(normalize_base_url(KIND, Some("https://api.bitbucket.org/2.0")).unwrap(), "https://bitbucket.org");
    assert_eq!(normalize_base_url(KIND, Some("https://bitbucket.firma.example")).unwrap_err().code, ErrorCode::NotAllowed);

    let info = cmd::host_repo_info(&fx.tc, fx.id(), None).await.unwrap().unwrap();
    assert_eq!((info.kind, info.owner.as_str(), info.name.as_str()), (KIND, "team", "demo"));
    assert_eq!(info.web_url, format!("{}/team/demo", fx.server.url()));
    assert_eq!((info.default_branch.as_deref(), info.can_push), (Some("main"), Some(true)));
    assert_eq!(info.fork_parent, Some(HostRepoRef { owner: "quelle".into(), name: "demo".into(), web_url: format!("{}/quelle/demo", fx.server.url()) }));
    assert_eq!(fx.sent("GET", "/2.0/user/permissions/repositories")[0].query("q").as_deref(), Some("repository.full_name=\"team/demo\""));
    let caps = &info.capabilities;
    assert!(caps.issues && !caps.pr_labels && !caps.pr_reviewers && !caps.pr_reopen && !caps.fork_checkout && caps.draft_toggle);
    assert_eq!(caps.merge_methods, vec![PrMergeMethod::Merge, PrMergeMethod::Squash]);
    fx.state.lock().issues_off = true;
    fx.mode("ok");
    assert!(!cmd::host_repo_info(&fx.tc, fx.id(), None).await.unwrap().unwrap().capabilities.issues);
    fx.state.lock().issues_off = false;
    fx.mode("ok");
    fx.assert_token_stays_secret();
}

#[tokio::test]
async fn pull_requests_are_listed_and_read() {
    let fx = Fixture::new(KIND).await;
    let first = cmd::pr_list(&fx.tc, fx.id(), PrListState::Open, None, None, None).await.unwrap();
    assert_eq!((first.items.len(), first.next_page, first.items[0].number), (20, Some(2), 44));
    let call = &fx.sent("GET", "/pullrequests")[0];
    assert_eq!(
        (call.query("state"), call.query("sort"), call.query("pagelen"), call.query("page")),
        (Some("OPEN".into()), Some("-updated_on".into()), Some("20".into()), Some("1".into()))
    );
    let second = cmd::pr_list(&fx.tc, fx.id(), PrListState::Open, Some(2), None, None).await.unwrap();
    assert_eq!((second.items.len(), second.next_page), (16, None));
    let by_number = |n: u64| second.items.iter().find(|pr| pr.number == n).unwrap_or_else(|| panic!("#{n}")).clone();
    assert_eq!((by_number(1).checks, by_number(1).review_state), (Some(ChecksState::Passing), Some(PrReviewState::Approved)));
    assert_eq!((by_number(2).checks, by_number(2).review_state), (Some(ChecksState::Pending), Some(PrReviewState::ReviewRequired)));
    assert_eq!((by_number(4).checks, by_number(4).review_state), (Some(ChecksState::Failing), Some(PrReviewState::ChangesRequested)));
    assert_eq!((by_number(6).checks, by_number(6).review_state), (None, None));
    assert!(by_number(3).is_draft && by_number(8).is_fork && !by_number(7).is_fork);
    assert!(by_number(1).labels.is_empty(), "Bitbucket has no labels");
    assert_eq!((by_number(7).source_branch.as_str(), by_number(7).target_branch.as_str()), ("feature/login", "main"));
    let merged = cmd::pr_list(&fx.tc, fx.id(), PrListState::Merged, None, None, None).await.unwrap();
    assert_eq!(merged.items.iter().map(|pr| (pr.number, pr.state)).collect::<Vec<_>>(), vec![(40, PrState::Merged), (30, PrState::Merged), (20, PrState::Merged), (10, PrState::Merged)]);
    fx.server.clear();
    let closed = cmd::pr_list(&fx.tc, fx.id(), PrListState::Closed, None, None, None).await.unwrap();
    assert_eq!(closed.items.iter().map(|pr| (pr.number, pr.state)).collect::<Vec<_>>(), vec![(45, PrState::Closed), (35, PrState::Closed), (25, PrState::Closed), (15, PrState::Closed), (5, PrState::Closed)]);
    assert!(fx.sent("GET", "/pullrequests")[0].target.contains("state=DECLINED&state=SUPERSEDED"), "declined and superseded count as closed");
    fx.server.clear();
    let all = cmd::pr_list(&fx.tc, fx.id(), PrListState::All, None, Some(100), None).await.unwrap();
    assert_eq!((all.items.len(), all.next_page), (45, None));
    assert_eq!(fx.sent("GET", "/pullrequests")[0].query("pagelen").as_deref(), Some("50"), "Bitbucket's largest page");

    let pr = cmd::pr_get(&fx.tc, fx.id(), 1, None).await.unwrap();
    assert!(pr.body.contains("**Thema 1**"));
    assert_eq!(pr.reviewers.iter().map(|r| (r.user.login.as_str(), r.state)).collect::<Vec<_>>(), vec![("mira", Some(PrReviewState::Approved))], "a participant without a decision is no reviewer");
    assert_eq!(pr.comments.iter().map(|c| (c.id.as_str(), c.body.as_str())).collect::<Vec<_>>(), vec![("2", "Sieht gut aus."), ("3", "Hier bitte prüfen.")], "deleted comments are gone");
    assert_eq!((pr.comments[1].path.as_deref(), pr.comments[1].line), (Some("src/anmeldung.rs"), Some(42)));
    assert_eq!((pr.commits.len(), pr.commits[0].summary.as_str(), pr.commits[0].author_name.as_str()), (2, "Meldung übersetzt", "Jonas Weber"));
    assert_eq!(pr.check_runs.iter().map(|c| (c.name.as_str(), c.state)).collect::<Vec<_>>(), vec![("build", CheckRunState::Passing), ("docs", CheckRunState::Skipped)]);
    assert_eq!((pr.summary.checks, pr.mergeable), (Some(ChecksState::Passing), Some(true)));
    assert_eq!(pr.head_sha.as_str(), &format!("{:040x}", 1)[..12]);
    assert_eq!(cmd::pr_get(&fx.tc, fx.id(), 13, None).await.unwrap().mergeable, Some(false), "a conflict in the diffstat");
    assert_eq!(cmd::pr_get(&fx.tc, fx.id(), 999, None).await.unwrap_err().message, "Pull request #999 does not exist in team/demo.");

    check_error_modes(&fx, LABEL, "pr_list", || cmd::pr_list(&fx.tc, fx.id(), PrListState::Open, None, None, None)).await;
    check_error_modes(&fx, LABEL, "pr_get", || cmd::pr_get(&fx.tc, fx.id(), 1, None)).await;
    check_broken_json(&fx, LABEL, "pr_list", || cmd::pr_list(&fx.tc, fx.id(), PrListState::Open, None, None, None)).await;
    check_broken_json(&fx, LABEL, "pr_get", || cmd::pr_get(&fx.tc, fx.id(), 1, None)).await;
    fx.assert_token_stays_secret();
}

#[tokio::test]
async fn issues_are_listed_searched_read_and_may_be_switched_off() {
    let fx = Fixture::new(KIND).await;
    let open = cmd::issue_list(&fx.tc, fx.id(), IssueListState::Open, None, None, None, None).await.unwrap();
    assert_eq!(open.items.iter().map(|i| i.number).collect::<Vec<_>>(), vec![11, 10, 9, 7, 6, 5, 3, 2, 1]);
    assert_eq!((open.items[0].key.as_str(), open.items[0].state), ("#11", IssueState::Open));
    assert_eq!(open.items.iter().find(|i| i.number == 3).map(|i| i.state), Some(IssueState::Open), "“new” counts as open");
    assert_eq!(fx.sent("GET", "/issues")[0].query("q").as_deref(), Some("(state=\"new\" OR state=\"open\" OR state=\"on hold\")"));
    let closed = cmd::issue_list(&fx.tc, fx.id(), IssueListState::Closed, None, None, None, None).await.unwrap();
    assert_eq!(closed.items.iter().map(|i| (i.number, i.state)).collect::<Vec<_>>(), vec![(12, IssueState::Closed), (8, IssueState::Closed), (4, IssueState::Closed)]);
    fx.server.clear();
    let found = cmd::issue_list(&fx.tc, fx.id(), IssueListState::All, Some("anmeldung".into()), None, None, None).await.unwrap();
    assert_eq!(found.items.iter().map(|i| i.number).collect::<Vec<_>>(), vec![2, 1]);
    assert_eq!(fx.sent("GET", "/issues")[0].query("q").as_deref(), Some("(title ~ \"anmeldung\" OR content.raw ~ \"anmeldung\")"));
    // Quotes in the search text stay text – they cannot change the query.
    fx.server.clear();
    cmd::issue_list(&fx.tc, fx.id(), IssueListState::All, Some("x\" OR state=\"resolved".into()), None, None, None).await.unwrap();
    assert_eq!(
        fx.sent("GET", "/issues")[0].query("q").as_deref(),
        Some("(title ~ \"x\\\" OR state=\\\"resolved\" OR content.raw ~ \"x\\\" OR state=\\\"resolved\")")
    );
    let paged = cmd::issue_list(&fx.tc, fx.id(), IssueListState::All, None, Some(2), Some(5), None).await.unwrap();
    assert_eq!((paged.items.iter().map(|i| i.number).collect::<Vec<_>>(), paged.next_page), (vec![7, 6, 5, 4, 3], Some(3)));

    let issue = cmd::issue_get(&fx.tc, fx.id(), 2, None).await.unwrap();
    assert_eq!((issue.body.as_str(), issue.summary.assignees[0].login.as_str()), ("Text zu Problem 2", "lena"));
    assert_eq!(issue.summary.labels.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(), vec!["bug"], "the kind of the issue");
    assert_eq!(issue.comments.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec!["21"], "empty status changes are no comments");
    assert_eq!(cmd::issue_get(&fx.tc, fx.id(), 999, None).await.unwrap_err().message, "Issue #999 does not exist in team/demo.");
    check_error_modes(&fx, LABEL, "issue_list", || cmd::issue_list(&fx.tc, fx.id(), IssueListState::Open, None, None, None, None)).await;
    check_broken_json(&fx, LABEL, "issue_list", || cmd::issue_list(&fx.tc, fx.id(), IssueListState::Open, None, None, None, None)).await;

    fx.state.lock().issues_off = true;
    fx.mode("ok");
    let error = cmd::issue_list(&fx.tc, fx.id(), IssueListState::Open, None, None, None, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::HostUnsupported);
    assert!(error.message.contains("switched off"), "{}", error.message);
    fx.assert_token_stays_secret();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checkout_works_for_branches_of_the_repository_but_not_from_forks() {
    let fx = Fixture::new(KIND).await;
    let repo = &fx.repo;
    let _bare = back_origin_with_a_real_repository(&fx, "team/demo");
    repo.checkout_new("feature/login");
    let login = repo.commit_file("login.txt", "anmeldung\n", "Anmeldung gebaut");
    repo.git(&["push", "-q", "origin", "feature/login"]);
    repo.checkout("main");
    repo.git(&["branch", "-D", "feature/login"]);
    repo.git(&["update-ref", "-d", "refs/remotes/origin/feature/login"]);
    cmd::pr_checkout(&fx.tc, fx.id(), 7, None).await.unwrap();
    assert_eq!((repo.current_branch(), repo.head()), ("feature/login".to_string(), login));
    // Bitbucket offers no ref for pull requests from forks: refused before anything is fetched.
    repo.checkout("main");
    let before = repo.git(&["for-each-ref"]);
    let error = cmd::pr_checkout(&fx.tc, fx.id(), 8, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::HostUnsupported, "{error:?}");
    assert!(error.message.contains("forks"), "{}", error.message);
    assert_eq!(repo.git(&["for-each-ref"]), before);
    fx.assert_token_stays_secret();
}
