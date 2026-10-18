//! Azure DevOps: success and error cases per command against the test server (organization
//! `firma`, project `projekt`, repository `demo`; PAT via Basic authentication).

use base64::Engine;
use serde_json::json;

use super::github_tests::back_origin_with_a_real_repository;
use super::*;
use crate::host::detect::normalize_base_url;
use crate::model::{CheckRunState, ChecksState, HostRepoRef, IssueListState, IssueState, PrListState, PrMergeMethod, PrReviewState, PrState, ReviewSide};

const KIND: HostKind = HostKind::AzureDevops;
const LABEL: &str = "Azure DevOps";

#[tokio::test]
async fn account_and_repository_are_recognised() {
    let fx = Fixture::new(KIND).await;
    let account = fx.account.clone();
    assert_eq!((account.kind, account.base_url.clone()), (KIND, format!("{}/firma", fx.server.url())));
    let user = account.user.clone().unwrap();
    assert_eq!((user.login.as_str(), user.name.as_deref(), account.username.as_deref()), ("lena@example.org", Some("Lena Hartmann"), None));
    assert_eq!(serde_json::to_value(&account).unwrap()["kind"], json!("azure_devops"));
    cmd::host_check(&fx.tc, account.id.clone()).await.unwrap();
    let seen = &fx.sent("GET", "/firma/_apis/connectionData")[0];
    let expected = format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!(":{TOKEN}")));
    assert_eq!(seen.header("authorization"), Some(expected.as_str()));
    assert_eq!(seen.header("x-tfs-fedauthredirect"), Some("Suppress"), "a 401 instead of a sign-in page");
    assert_eq!(fx.sent("GET", "/firma/_apis/projects")[0].query("api-version").as_deref(), Some("7.1"));
    let error = cmd::host_connect(&fx.tc, KIND, Some(format!("{}/firma", fx.server.url())), "ErfundenUndFalsch0000000000".into(), None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::HostAuthFailed);
    assert!(error.message.contains(LABEL), "{}", error.message);
    // The organization is part of the address.
    assert_eq!(normalize_base_url(KIND, Some("https://dev.azure.com/Firma/")).unwrap(), "https://dev.azure.com/firma");
    assert_eq!(normalize_base_url(KIND, Some("dev.azure.com/firma/projekt/_git/demo")).unwrap(), "https://dev.azure.com/firma");
    assert_eq!(normalize_base_url(KIND, Some("https://firma.visualstudio.com/DefaultCollection")).unwrap(), "https://dev.azure.com/firma");
    for bad in [None, Some("https://dev.azure.com"), Some("https://tfs.firma.example/tfs")] {
        assert_eq!(normalize_base_url(KIND, bad).unwrap_err().code, ErrorCode::NotAllowed, "{bad:?}");
    }

    let info = cmd::host_repo_info(&fx.tc, fx.id(), None).await.unwrap().unwrap();
    assert_eq!((info.kind, info.owner.as_str(), info.name.as_str()), (KIND, "projekt", "demo"), "owner = project");
    assert_eq!(info.web_url, format!("{}/firma/projekt/_git/demo", fx.server.url()));
    assert_eq!((info.default_branch.as_deref(), info.can_push), (Some("main"), None));
    assert_eq!(info.fork_parent, Some(HostRepoRef { owner: "quelle".into(), name: "demo".into(), web_url: format!("{}/firma/quelle/_git/demo", fx.server.url()) }));
    let caps = &info.capabilities;
    assert!(caps.issues && caps.pr_labels && !caps.pr_reviewers && !caps.fork_checkout && caps.draft_toggle && caps.pr_reopen);
    assert_eq!(caps.merge_methods, vec![PrMergeMethod::Merge, PrMergeMethod::Squash, PrMergeMethod::Rebase]);
    fx.mode("rate");
    assert_eq!(cmd::host_repo_info(&fx.tc, fx.id(), None).await.unwrap().unwrap().error.map(|e| e.code), Some(ErrorCode::HostRateLimited));
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
        (call.query("api-version"), call.query("searchCriteria.status"), call.query("$top"), call.query("$skip")),
        (Some("7.1".into()), Some("active".into()), Some("21".into()), Some("0".into())),
        "one more than the page to know whether another follows"
    );
    let second = cmd::pr_list(&fx.tc, fx.id(), PrListState::Open, Some(2), None, None).await.unwrap();
    assert_eq!((second.items.len(), second.next_page), (16, None));
    let by_number = |n: u64| second.items.iter().find(|pr| pr.number == n).unwrap_or_else(|| panic!("#{n}")).clone();
    assert_eq!((by_number(1).checks, by_number(1).review_state), (Some(ChecksState::Passing), Some(PrReviewState::Approved)));
    assert_eq!((by_number(2).checks, by_number(2).review_state), (Some(ChecksState::Pending), Some(PrReviewState::ReviewRequired)));
    assert_eq!((by_number(4).checks, by_number(4).review_state), (Some(ChecksState::Failing), Some(PrReviewState::ChangesRequested)));
    assert_eq!((by_number(6).checks, by_number(6).review_state), (None, None));
    assert!(by_number(3).is_draft && by_number(8).is_fork && !by_number(7).is_fork);
    assert_eq!((by_number(7).source_branch.as_str(), by_number(7).target_branch.as_str()), ("feature/login", "main"), "without refs/heads/");
    assert_eq!(by_number(1).labels.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(), vec!["bug"]);
    assert_eq!(by_number(1).web_url, format!("{}/firma/projekt/_git/demo/pullrequest/1", fx.server.url()));
    let merged = cmd::pr_list(&fx.tc, fx.id(), PrListState::Merged, None, None, None).await.unwrap();
    assert_eq!(merged.items.iter().map(|pr| (pr.number, pr.state)).collect::<Vec<_>>(), vec![(40, PrState::Merged), (30, PrState::Merged), (20, PrState::Merged), (10, PrState::Merged)]);
    let closed = cmd::pr_list(&fx.tc, fx.id(), PrListState::Closed, None, None, None).await.unwrap();
    assert_eq!(closed.items.iter().map(|pr| pr.number).collect::<Vec<_>>(), vec![45, 35, 25, 15, 5]);
    let all = cmd::pr_list(&fx.tc, fx.id(), PrListState::All, None, Some(100), None).await.unwrap();
    assert_eq!((all.items.len(), all.next_page), (45, None));

    let pr = cmd::pr_get(&fx.tc, fx.id(), 1, None).await.unwrap();
    assert!(pr.body.contains("**Thema 1**"));
    assert_eq!(pr.reviewers.iter().map(|r| (r.user.login.as_str(), r.state)).collect::<Vec<_>>(), vec![("mira@example.org", Some(PrReviewState::Approved))]);
    assert_eq!(pr.comments.iter().map(|c| (c.id.as_str(), c.body.as_str())).collect::<Vec<_>>(), vec![("2-1", "Sieht gut aus."), ("3-1", "Hier bitte prüfen.")], "system comments are left out");
    assert_eq!((pr.comments[1].path.as_deref(), pr.comments[1].line), (Some("src/anmeldung.rs"), Some(42)));
    assert_eq!((pr.commits.len(), pr.commits[0].summary.as_str(), pr.commits[0].author_name.as_str()), (2, "Meldung übersetzt", "Jonas Weber"));
    assert_eq!(pr.check_runs.iter().map(|c| (c.name.as_str(), c.state)).collect::<Vec<_>>(), vec![("ci/build", CheckRunState::Passing), ("ci/docs", CheckRunState::Skipped)]);
    assert_eq!((pr.summary.checks, pr.mergeable, pr.head_sha.as_str()), (Some(ChecksState::Passing), Some(true), format!("{:040x}", 1).as_str()));
    assert_eq!(cmd::pr_get(&fx.tc, fx.id(), 13, None).await.unwrap().mergeable, Some(false));
    assert_eq!(cmd::pr_get(&fx.tc, fx.id(), 999, None).await.unwrap_err().message, "Pull request #999 does not exist in projekt/demo.");

    check_error_modes(&fx, LABEL, "pr_list", || cmd::pr_list(&fx.tc, fx.id(), PrListState::Open, None, None, None)).await;
    check_error_modes(&fx, LABEL, "pr_get", || cmd::pr_get(&fx.tc, fx.id(), 1, None)).await;
    check_broken_json(&fx, LABEL, "pr_list", || cmd::pr_list(&fx.tc, fx.id(), PrListState::Open, None, None, None)).await;
    check_broken_json(&fx, LABEL, "pr_get", || cmd::pr_get(&fx.tc, fx.id(), 1, None)).await;
    fx.assert_token_stays_secret();
}

#[tokio::test]
async fn work_items_are_listed_searched_and_read() {
    let fx = Fixture::new(KIND).await;
    let open = cmd::issue_list(&fx.tc, fx.id(), IssueListState::Open, None, None, None, None).await.unwrap();
    assert_eq!(open.items.iter().map(|i| i.number).collect::<Vec<_>>(), vec![11, 10, 9, 7, 6, 5, 3, 2, 1], "in the order of the query, not of the batch");
    assert_eq!((open.items[0].key.as_str(), open.items[0].state, open.next_page), ("#11", IssueState::Open, None));
    assert_eq!(open.items[0].web_url, format!("{}/firma/projekt/_workitems/edit/11", fx.server.url()));
    let one = open.items.iter().find(|i| i.number == 1).unwrap();
    assert_eq!(one.labels.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(), vec!["Issue", "frage", "ui"], "type, then tags");
    let query = fx.sent("POST", "/_apis/wit/wiql")[0].json()["query"].as_str().unwrap().to_string();
    assert!(
        query.contains("[System.TeamProject] = @project")
            && query.contains("[System.State] NOT IN ('Closed', 'Done', 'Removed', 'Resolved', 'Completed')")
            && query.ends_with("ORDER BY [System.ChangedDate] DESC"),
        "{query}"
    );
    assert_eq!(fx.sent("GET", "/_apis/wit/workitems")[0].query("ids").as_deref(), Some("11,10,9,7,6,5,3,2,1"), "one batch for the page");
    let closed = cmd::issue_list(&fx.tc, fx.id(), IssueListState::Closed, None, None, None, None).await.unwrap();
    assert_eq!(closed.items.iter().map(|i| (i.number, i.state)).collect::<Vec<_>>(), vec![(12, IssueState::Closed), (8, IssueState::Closed), (4, IssueState::Closed)]);
    // A quote in the search text stays inside the WIQL literal.
    fx.server.clear();
    let found = cmd::issue_list(&fx.tc, fx.id(), IssueListState::All, Some("o'brien".into()), None, None, None).await.unwrap();
    assert_eq!(found.items.iter().map(|i| i.number).collect::<Vec<_>>(), vec![2, 1]);
    let query = fx.sent("POST", "/_apis/wit/wiql")[0].json()["query"].as_str().unwrap().to_string();
    assert!(query.contains("[System.Title] CONTAINS 'o''brien'") && !query.contains("'o'brien'"), "{query}");
    let paged = cmd::issue_list(&fx.tc, fx.id(), IssueListState::All, None, Some(2), Some(5), None).await.unwrap();
    assert_eq!((paged.items.iter().map(|i| i.number).collect::<Vec<_>>(), paged.next_page), (vec![7, 6, 5, 4, 3], Some(3)));
    assert_eq!(fx.sent("POST", "/_apis/wit/wiql").last().unwrap().query("$top").as_deref(), Some("11"), "the page plus one");

    let issue = cmd::issue_get(&fx.tc, fx.id(), 2, None).await.unwrap();
    assert_eq!((issue.body.as_str(), issue.summary.assignees[0].login.as_str()), ("<p>Text zu Problem 2</p>", "lena@example.org"));
    assert_eq!(issue.comments.iter().map(|c| (c.id.as_str(), c.body.as_str())).collect::<Vec<_>>(), vec![("5", "Danke fürs Ansehen!")]);
    assert_eq!(fx.sent("GET", "/comments")[0].query("api-version").as_deref(), Some("7.1-preview.4"));
    let error = cmd::issue_get(&fx.tc, fx.id(), 999, None).await.unwrap_err();
    assert_eq!((error.code, error.message.as_str()), (ErrorCode::HostNotFound, "Work item #999 does not exist in projekt."));
    check_error_modes(&fx, LABEL, "issue_list", || cmd::issue_list(&fx.tc, fx.id(), IssueListState::Open, None, None, None, None)).await;
    check_error_modes(&fx, LABEL, "issue_get", || cmd::issue_get(&fx.tc, fx.id(), 2, None)).await;
    check_broken_json(&fx, LABEL, "issue_list", || cmd::issue_list(&fx.tc, fx.id(), IssueListState::Open, None, None, None, None)).await;
    fx.assert_token_stays_secret();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checkout_works_for_branches_of_the_repository_but_not_from_forks() {
    let fx = Fixture::new(KIND).await;
    let repo = &fx.repo;
    let _bare = back_origin_with_a_real_repository(&fx, "firma/projekt/_git/demo");
    repo.checkout_new("feature/login");
    let login = repo.commit_file("login.txt", "anmeldung\n", "Anmeldung gebaut");
    repo.git(&["push", "-q", "origin", "feature/login"]);
    repo.checkout("main");
    repo.git(&["branch", "-D", "feature/login"]);
    repo.git(&["update-ref", "-d", "refs/remotes/origin/feature/login"]);
    cmd::pr_checkout(&fx.tc, fx.id(), 7, None).await.unwrap();
    assert_eq!((repo.current_branch(), repo.head()), ("feature/login".to_string(), login));
    repo.checkout("main");
    let error = cmd::pr_checkout(&fx.tc, fx.id(), 8, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::HostUnsupported, "{error:?}");
    assert!(error.message.contains("forks"), "{}", error.message);
    fx.assert_token_stays_secret();
}

#[tokio::test]
async fn pull_requests_are_created_changed_commented_completed_and_abandoned() {
    let fx = Fixture::new(KIND).await;
    let created = cmd::pr_create(&fx.tc, fx.id(), "Neue Anmeldung".into(), "Text".into(), "feature/neu".into(), "main".into(), true, None, Some(vec!["bug".into()]), None).await.unwrap();
    assert_eq!((created.number, created.title.as_str(), created.is_draft, created.source_branch.as_str()), (101, "Neue Anmeldung", true, "feature/neu"));
    let sent = &fx.sent("POST", "/pullrequests")[0];
    assert_eq!(
        sent.json(),
        json!({ "sourceRefName": "refs/heads/feature/neu", "targetRefName": "refs/heads/main", "title": "Neue Anmeldung", "description": "Text", "isDraft": true, "labels": [{ "name": "bug" }] })
    );
    assert_eq!(sent.query("api-version").as_deref(), Some("7.1"));
    fx.server.clear();
    let error = cmd::pr_create(&fx.tc, fx.id(), "x".into(), String::new(), "feature/neu".into(), "main".into(), false, Some(vec!["mira".into()]), None, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::HostUnsupported);
    assert!(fx.server.requests().is_empty(), "reviewers need identity IDs – refused before anything goes out");
    let error = cmd::pr_create(&fx.tc, fx.id(), "Doppelt".into(), String::new(), "schon-da".into(), "main".into(), false, None, None, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::NameExists);
    assert!(error.message.contains("already an open pull request"), "{}", error.message);
    check_error_modes(&fx, LABEL, "pr_create", || cmd::pr_create(&fx.tc, fx.id(), "Titel".into(), String::new(), "feature/neu".into(), "main".into(), false, None, None, None)).await;

    fx.server.clear();
    cmd::pr_update(&fx.tc, fx.id(), 3, Some("Neuer Titel".into()), Some("Neuer Text".into()), Some("develop".into()), Some(false), None, Some(vec!["ui".into()]), None).await.unwrap();
    assert_eq!(fx.sent("PATCH", "/pullrequests/3")[0].json(), json!({ "title": "Neuer Titel", "description": "Neuer Text", "targetRefName": "refs/heads/develop", "isDraft": false }));
    assert_eq!(fx.sent("POST", "/pullrequests/3/labels")[0].json(), json!({ "name": "ui" }));
    fx.server.clear();
    cmd::pr_update(&fx.tc, fx.id(), 1, None, None, None, None, None, Some(Vec::new()), None).await.unwrap();
    assert!(fx.sent("PATCH", "/pullrequests/1").is_empty(), "only labels: no PATCH");
    assert_eq!(fx.sent("DELETE", "/pullrequests/1/labels/bug").len(), 1);
    assert_eq!(cmd::pr_update(&fx.tc, fx.id(), 1, None, None, None, None, Some(vec!["mira".into()]), None, None).await.unwrap_err().code, ErrorCode::HostUnsupported);

    let comment = cmd::pr_comment(&fx.tc, fx.id(), 1, "Passt so.".into(), None).await.unwrap();
    assert_eq!((comment.id.as_str(), comment.body.as_str()), ("7-1", "Passt so."));
    assert_eq!(fx.sent("POST", "/pullrequests/1/threads")[0].json(), json!({ "comments": [{ "parentCommentId": 0, "content": "Passt so.", "commentType": 1 }], "status": 1 }));

    let merged = cmd::pr_merge(&fx.tc, fx.id(), 1, PrMergeMethod::Squash, true, None).await.unwrap();
    assert_eq!(merged.state, PrState::Merged);
    assert_eq!(
        fx.sent("PATCH", "/pullrequests/1")[0].json(),
        json!({ "status": "completed", "lastMergeSourceCommit": { "commitId": format!("{:040x}", 1) }, "completionOptions": { "mergeStrategy": "squash", "deleteSourceBranch": true } })
    );
    cmd::pr_merge(&fx.tc, fx.id(), 2, PrMergeMethod::Merge, false, None).await.unwrap();
    assert_eq!(fx.sent("PATCH", "/pullrequests/2")[0].json()["completionOptions"]["mergeStrategy"], json!("noFastForward"));
    cmd::pr_merge(&fx.tc, fx.id(), 4, PrMergeMethod::Rebase, false, None).await.unwrap();
    assert_eq!(fx.sent("PATCH", "/pullrequests/4")[0].json()["completionOptions"]["mergeStrategy"], json!("rebase"));
    let error = cmd::pr_merge(&fx.tc, fx.id(), 13, PrMergeMethod::Merge, false, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::HostRejected);
    assert!(error.message.contains("merge conflicts"), "{}", error.message);

    assert_eq!(cmd::pr_close(&fx.tc, fx.id(), 6, None).await.unwrap().state, PrState::Closed);
    assert_eq!(cmd::pr_reopen(&fx.tc, fx.id(), 6, None).await.unwrap().state, PrState::Open);
    let patches: Vec<_> = fx.sent("PATCH", "/pullrequests/6").iter().map(|r| r.json()).collect();
    assert_eq!(patches, vec![json!({ "status": "abandoned" }), json!({ "status": "active" })]);
    check_error_modes(&fx, LABEL, "pr_merge", || cmd::pr_merge(&fx.tc, fx.id(), 7, PrMergeMethod::Merge, false, None)).await;
    check_error_modes(&fx, LABEL, "pr_comment", || cmd::pr_comment(&fx.tc, fx.id(), 7, "Text".into(), None)).await;
    fx.assert_token_stays_secret();
}

#[tokio::test]
async fn work_items_are_created_as_issue_or_as_bug() {
    let fx = Fixture::new(KIND).await;
    assert!(cmd::host_repo_info(&fx.tc, fx.id(), None).await.unwrap().unwrap().capabilities.issue_create);
    fx.server.clear();
    let created = cmd::issue_create(&fx.tc, fx.id(), " Neuer Fehler ".into(), "Zeile 1\nZeile 2 <b>".into(), None).await.unwrap();
    assert_eq!((created.number, created.key.as_str(), created.title.as_str(), created.state), (77, "#77", "Neuer Fehler", IssueState::Open));
    assert_eq!(created.web_url, format!("{}/firma/projekt/_workitems/edit/77", fx.server.url()));
    let sent = &fx.sent("POST", "/_apis/wit/workitems/$Issue")[0];
    assert_eq!(sent.header("content-type"), Some("application/json-patch+json"));
    assert_eq!(
        sent.json(),
        json!([
            { "op": "add", "path": "/fields/System.Title", "value": "Neuer Fehler" },
            { "op": "add", "path": "/fields/System.Description", "value": "Zeile 1<br>Zeile 2 &lt;b&gt;" }
        ]),
        "plain text becomes escaped HTML"
    );
    // A process without the type "Issue" (Scrum): it becomes a "Bug".
    fx.state.lock().no_issue_type = true;
    let bug = cmd::issue_create(&fx.tc, fx.id(), "Absturz".into(), String::new(), None).await.unwrap();
    assert_eq!(bug.labels.first().map(|l| l.name.as_str()), Some("Bug"));
    assert_eq!(fx.sent("POST", "/_apis/wit/workitems/$Bug").len(), 1);
    fx.server.clear();
    for (title, code) in [("  ", ErrorCode::EmptyMessage), ("zwei\nZeilen", ErrorCode::NotAllowed)] {
        assert_eq!(cmd::issue_create(&fx.tc, fx.id(), title.into(), String::new(), None).await.unwrap_err().code, code, "{title:?}");
    }
    assert!(fx.server.requests().is_empty(), "invalid titles never go out");
    check_error_modes(&fx, LABEL, "issue_create", || cmd::issue_create(&fx.tc, fx.id(), "Titel".into(), String::new(), None)).await;
    fx.assert_token_stays_secret();
}

#[tokio::test]
async fn review_threads_are_the_threads_with_a_file_position() {
    let fx = Fixture::new(KIND).await;
    let threads = cmd::pr_review_threads(&fx.tc, fx.id(), 9, None).await.unwrap();
    let rows: Vec<_> = threads.iter().map(|t| (t.id.as_str(), t.path.as_str(), t.line, t.start_line, t.side, t.resolved)).collect();
    assert_eq!(
        rows,
        vec![
            ("91", "src/anmeldung.rs", Some(42), Some(40), ReviewSide::New, false),
            ("92", "src/meldung.rs", Some(7), None, ReviewSide::New, true),
            ("93", "src/alt.rs", Some(12), None, ReviewSide::Old, false),
            ("97", "src/neu.rs", Some(5), None, ReviewSide::New, false),
        ],
        "general, deleted and system-only threads are no review threads"
    );
    let comments: Vec<_> = threads[0].comments.iter().map(|c| (c.id.as_str(), c.author.as_ref().map(|a| a.login.as_str()), c.body.as_str())).collect();
    assert_eq!(comments, vec![("91-1", Some("mira@example.org"), "Hier fehlt die Prüfung auf leer."), ("91-2", Some("jonas@example.org"), "Stimmt, mache ich.")]);
    assert_eq!(fx.sent("GET", "/pullrequests/9/threads")[0].query("api-version").as_deref(), Some("7.1"));
    check_error_modes(&fx, "Azure DevOps", "review threads", || cmd::pr_review_threads(&fx.tc, fx.id(), 9, None)).await;
    check_broken_json(&fx, "Azure DevOps", "review threads", || cmd::pr_review_threads(&fx.tc, fx.id(), 9, None)).await;
    fx.assert_token_stays_secret();
}

#[tokio::test]
async fn a_reply_answers_the_first_comment_of_the_thread() {
    let fx = Fixture::new(KIND).await;
    let reply = cmd::pr_review_reply(&fx.tc, fx.id(), 9, "91".into(), "Erledigt.".into(), None).await.unwrap();
    assert!(!reply.quoted);
    assert_eq!((reply.comment.id.as_str(), reply.comment.body.as_str(), reply.comment.path.as_deref(), reply.comment.line), ("91-3", "Erledigt.", Some("src/anmeldung.rs"), Some(42)));
    let sent = fx.sent("POST", "/pullrequests/9/threads/91/comments");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].json(), json!({ "content": "Erledigt.", "parentCommentId": 1, "commentType": 1 }));
    assert_eq!(sent[0].query("api-version").as_deref(), Some("7.1"));
    // A thread whose first comment was deleted: the answer goes to the first comment still there.
    cmd::pr_review_reply(&fx.tc, fx.id(), 9, "97".into(), "Umbenannt.".into(), None).await.unwrap();
    assert_eq!(fx.sent("POST", "/pullrequests/9/threads/97/comments")[0].json(), json!({ "content": "Umbenannt.", "parentCommentId": 2, "commentType": 1 }));
    let error = cmd::pr_review_reply(&fx.tc, fx.id(), 9, "4711".into(), "Danke".into(), None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::HostNotFound);
    let caps = cmd::host_repo_info(&fx.tc, fx.id(), None).await.unwrap().unwrap().capabilities;
    assert!(caps.review_threads && caps.review_reply && !caps.review_reply_quotes);
    fx.assert_token_stays_secret();
}
