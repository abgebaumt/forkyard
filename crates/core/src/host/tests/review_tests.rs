//! PR review: local drafts of the own review, kept per pull request until they are sent.

use serde_json::json;

use super::mocks::{MOCK_GL_BASE, MOCK_GL_HEAD, MOCK_GL_START};
use super::{cmd, Fixture};
use crate::commands::pr_review::{
    self as cmd_review, pr_review_comment_create, pr_review_draft_delete, pr_review_draft_save, pr_review_drafts, pr_review_submit,
    pr_review_thread_resolve,
};
use crate::db;
use crate::error::ErrorCode;
use crate::model::{HostKind, NewReviewComment, ReviewDraft, ReviewDraftOrigin, ReviewSide, ReviewVote};

fn comment(path: &str, line: u32) -> NewReviewComment {
    NewReviewComment {
        commit: "a".repeat(40),
        path: path.into(),
        line,
        start_line: None,
        side: ReviewSide::New,
        old_line: None,
        body: "Hier fehlt die Prüfung auf leer.".into(),
    }
}

async fn save(fx: &Fixture, c: NewReviewComment) -> ReviewDraft {
    pr_review_draft_save(&fx.tc, fx.id(), 9, c, None, None).await.unwrap()
}

#[tokio::test]
async fn drafts_survive_reopen_and_go_with_the_repository() {
    let fx = Fixture::new(HostKind::Github).await;
    let saved = save(&fx, comment("src/größe.rs", 42)).await;
    assert_eq!((saved.origin, saved.line, saved.error.clone()), (ReviewDraftOrigin::Local, Some(42), None));
    assert_eq!(saved.path, "src/größe.rs");
    let again = pr_review_drafts(&fx.tc, fx.id(), 9, None).await.unwrap();
    assert_eq!(again.drafts, vec![saved.clone()]);
    assert!(!again.host_unreadable);
    assert!(pr_review_drafts(&fx.tc, fx.id(), 10, None).await.unwrap().drafts.is_empty(), "per pull request");
    fx.tc.db.with(|c| Ok(c.execute("delete from repositories where id = ?1", [fx.id()])?)).unwrap();
    let left: i64 = fx.tc.db.with(|c| Ok(c.query_row("select count(*) from pr_review_drafts", [], |r| r.get(0))?)).unwrap();
    assert_eq!(left, 0);
}

#[tokio::test]
async fn editing_a_draft_keeps_its_id_and_clears_the_error() {
    let fx = Fixture::new(HostKind::Github).await;
    let first = save(&fx, comment("a.rs", 3)).await;
    let other = save(&fx, comment("b.rs", 7)).await;
    let rowid: i64 = first.id.parse().unwrap();
    fx.tc.db.with(|c| db::review_drafts::set_error(c, rowid, "Die Zeile gibt es nicht mehr.")).unwrap();
    let listed = pr_review_drafts(&fx.tc, fx.id(), 9, None).await.unwrap().drafts;
    assert_eq!(listed[0].error.as_deref(), Some("Die Zeile gibt es nicht mehr."));
    assert_eq!(listed[1], other, "oldest first");
    let edited = NewReviewComment { body: "  Doch lieber anders.  ".into(), ..comment("a.rs", 4) };
    let saved = pr_review_draft_save(&fx.tc, fx.id(), 9, edited, Some(first.id.clone()), None).await.unwrap();
    assert_eq!((saved.id.as_str(), saved.line, saved.error.as_deref()), (first.id.as_str(), Some(4), None));
    assert_eq!(saved.body, "  Doch lieber anders.  ", "stored as typed (Markdown indentation)");
    assert_eq!(pr_review_drafts(&fx.tc, fx.id(), 9, None).await.unwrap().drafts, vec![saved, other]);
}

#[tokio::test]
async fn invalid_comments_are_refused_before_storing() {
    let fx = Fixture::new(HostKind::Github).await;
    let cases = [
        (NewReviewComment { body: "  ".into(), ..comment("a.rs", 1) }, ErrorCode::EmptyMessage),
        (NewReviewComment { path: "../aus.rs".into(), ..comment("a.rs", 1) }, ErrorCode::NotAllowed),
        (comment("a.rs", 0), ErrorCode::NotAllowed),
        (NewReviewComment { start_line: Some(5), ..comment("a.rs", 5) }, ErrorCode::NotAllowed),
        (NewReviewComment { start_line: Some(0), ..comment("a.rs", 5) }, ErrorCode::NotAllowed),
        (NewReviewComment { old_line: Some(0), ..comment("a.rs", 5) }, ErrorCode::NotAllowed),
        (NewReviewComment { body: "x".repeat(65_537), ..comment("a.rs", 1) }, ErrorCode::NotAllowed),
        (NewReviewComment { commit: "main".into(), ..comment("a.rs", 1) }, ErrorCode::NotAllowed),
    ];
    for (bad, code) in cases {
        assert_eq!(pr_review_draft_save(&fx.tc, fx.id(), 9, bad, None, None).await.unwrap_err().code, code);
    }
    assert!(pr_review_drafts(&fx.tc, fx.id(), 9, None).await.unwrap().drafts.is_empty(), "nothing stored");
    assert!(fx.server.requests().iter().all(|r| r.method == "GET"), "nothing sent (listing reads the pending review)");
    // Exactly at the limit is fine; a range only where the host takes one (Gitea/Forgejo never does).
    save(&fx, NewReviewComment { body: "x".repeat(65_536), ..comment("a.rs", 1) }).await;
    let gitea = Fixture::new(HostKind::Gitea).await;
    let range = NewReviewComment { start_line: Some(2), ..comment("a.rs", 5) };
    let error = pr_review_draft_save(&gitea.tc, gitea.id(), 9, range, None, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::NotAllowed);
}

#[tokio::test]
async fn deleting_an_unknown_or_foreign_draft_is_not_found() {
    let fx = Fixture::new(HostKind::Github).await;
    for bad in ["999", "abc"] {
        assert_eq!(pr_review_draft_delete(&fx.tc, fx.id(), 9, bad.into(), None).await.unwrap_err().code, ErrorCode::NotFound);
    }
    let saved = save(&fx, comment("a.rs", 1)).await;
    let error = pr_review_draft_delete(&fx.tc, fx.id(), 10, saved.id.clone(), None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::NotFound);
    let error = pr_review_draft_save(&fx.tc, fx.id(), 10, comment("a.rs", 2), Some(saved.id.clone()), None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::NotFound, "editing through another pull request");
    pr_review_draft_delete(&fx.tc, fx.id(), 9, saved.id.clone(), None).await.unwrap();
    assert!(pr_review_drafts(&fx.tc, fx.id(), 9, None).await.unwrap().drafts.is_empty());
}

#[tokio::test]
async fn pull_request_zero_is_refused() {
    let fx = Fixture::new(HostKind::Github).await;
    for err in [
        pr_review_drafts(&fx.tc, fx.id(), 0, None).await.unwrap_err(),
        pr_review_draft_save(&fx.tc, fx.id(), 0, comment("a.rs", 3), None, None).await.unwrap_err(),
        pr_review_draft_delete(&fx.tc, fx.id(), 0, "1".into(), None).await.unwrap_err(),
        pr_review_comment_create(&fx.tc, fx.id(), 0, comment("a.rs", 3), None).await.unwrap_err(),
        pr_review_thread_resolve(&fx.tc, fx.id(), 0, "PRRT_kwDOAbc".into(), true, None).await.unwrap_err(),
        pr_review_submit(&fx.tc, fx.id(), 0, ReviewVote::Approve, String::new(), "a".repeat(40), None).await.unwrap_err(),
    ] {
        assert_eq!(err.code, ErrorCode::NotAllowed);
    }
    let left: i64 = fx.tc.db.with(|c| Ok(c.query_row("select count(*) from pr_review_drafts", [], |r| r.get(0))?)).unwrap();
    assert_eq!(left, 0);
    assert!(fx.server.requests().is_empty());
}

#[tokio::test]
async fn without_the_capability_nothing_is_sent() {
    // shortcut: Bitbucket has none of these yet; Task 6 gives it comments and votes, then pick per flag.
    let fx = Fixture::new(HostKind::Bitbucket).await;
    for err in [
        pr_review_comment_create(&fx.tc, fx.id(), 9, comment("a.rs", 3), None).await.unwrap_err(),
        pr_review_thread_resolve(&fx.tc, fx.id(), 9, "PRRT_kwDOAbc".into(), true, None).await.unwrap_err(),
        pr_review_submit(&fx.tc, fx.id(), 9, ReviewVote::Approve, String::new(), "a".repeat(40), None).await.unwrap_err(),
    ] {
        assert_eq!(err.code, ErrorCode::HostUnsupported);
    }
    assert!(fx.server.requests().is_empty());
}

#[test]
fn a_review_needs_text_or_drafts_and_request_changes_needs_text() {
    use cmd_review::check_submission;
    assert_eq!(check_submission(ReviewVote::Comment, "", 0).unwrap_err().code, ErrorCode::EmptyMessage);
    assert!(check_submission(ReviewVote::Comment, "", 1).is_ok());
    assert_eq!(check_submission(ReviewVote::RequestChanges, " ", 2).unwrap_err().code, ErrorCode::EmptyMessage);
    assert!(check_submission(ReviewVote::Approve, "", 0).is_ok());
}

#[test]
fn a_failing_vote_after_sent_comments_says_they_were_sent() {
    use crate::error::CoreError;
    let error = CoreError::new(ErrorCode::HostRateLimited, "GitHub refused the request: too many requests.");
    let error = cmd_review::vote_failed_after(2, error);
    assert_eq!(error.code, ErrorCode::HostRateLimited, "the code stays");
    assert_eq!(
        error.message,
        "The 2 line comments were sent; the review itself was not: GitHub refused the request: too many requests. Send the review again."
    );
    let one = cmd_review::vote_failed_after(1, CoreError::new(ErrorCode::Offline, "No connection"));
    assert_eq!(one.message, "The line comment was sent; the review itself was not: No connection. Send the review again.");
}

#[tokio::test]
async fn a_range_draft_is_stored_on_github() {
    let fx = Fixture::new(HostKind::Github).await;
    let saved = save(&fx, NewReviewComment { start_line: Some(40), ..comment("src/größe.rs", 42) }).await;
    assert_eq!((saved.start_line, saved.line), (Some(40), Some(42)));
    assert_eq!(pr_review_drafts(&fx.tc, fx.id(), 9, None).await.unwrap().drafts, vec![saved]);
    assert!(fx.server.requests().iter().all(|r| r.method == "GET"), "nothing sent (listing reads the pending review)");
}

#[tokio::test]
async fn github_comment_on_a_range_sends_the_documented_body() {
    let fx = Fixture::new(HostKind::Github).await;
    let c = NewReviewComment { start_line: Some(40), ..comment("src/größe.rs", 42) };
    cmd_review::pr_review_comment_create(&fx.tc, fx.id(), 9, c, None).await.unwrap();
    let sent = fx.sent("POST", "/pulls/9/comments");
    assert_eq!(sent.len(), 1);
    assert_eq!(
        sent[0].json(),
        json!({ "body": "Hier fehlt die Prüfung auf leer.", "commit_id": "a".repeat(40),
        "path": "src/größe.rs", "line": 42, "side": "RIGHT", "start_line": 40, "start_side": "RIGHT" })
    );
}

#[tokio::test]
async fn github_fresh_review_sends_drafts_and_vote_in_one_request() {
    let fx = Fixture::new(HostKind::Github).await;
    save(&fx, comment("a.rs", 3)).await;
    save(&fx, NewReviewComment { side: ReviewSide::Old, ..comment("b.rs", 7) }).await;
    let result =
        cmd_review::pr_review_submit(&fx.tc, fx.id(), 9, ReviewVote::RequestChanges, "Bitte noch anpassen.".into(), "a".repeat(40), None)
            .await
            .unwrap();
    assert_eq!((result.submitted, result.sent, result.failed.len()), (true, 2, 0));
    let body = fx.sent("POST", "/pulls/9/reviews")[0].json();
    assert_eq!(body["event"], "REQUEST_CHANGES");
    assert_eq!(body["body"], "Bitte noch anpassen.");
    assert_eq!(body["commit_id"], "a".repeat(40));
    assert_eq!(
        body["comments"],
        json!([
        { "path": "a.rs", "body": "Hier fehlt die Prüfung auf leer.", "line": 3, "side": "RIGHT" },
        { "path": "b.rs", "body": "Hier fehlt die Prüfung auf leer.", "line": 7, "side": "LEFT" }])
    );
    assert!(cmd_review::pr_review_drafts(&fx.tc, fx.id(), 9, None).await.unwrap().drafts.is_empty());
}

#[tokio::test]
async fn local_drafts_join_the_pending_review_instead_of_a_new_one() {
    let fx = Fixture::new(HostKind::Github).await;
    fx.state.lock().gh_pending_review = true;
    save(&fx, comment("a.rs", 3)).await;
    save(&fx, comment("c.rs", 9)).await;
    let listed = cmd_review::pr_review_drafts(&fx.tc, fx.id(), 9, None).await.unwrap();
    assert_eq!(
        listed.drafts.iter().map(|d| (d.origin, d.body.as_str())).collect::<Vec<_>>()[0],
        (ReviewDraftOrigin::Host, "Im Browser begonnen.")
    );
    let host = &listed.drafts[0];
    assert_eq!((host.id.as_str(), host.path.as_str(), host.line, host.side), ("7701", "src/anmeldung.rs", Some(12), ReviewSide::New));
    let result = cmd_review::pr_review_submit(&fx.tc, fx.id(), 9, ReviewVote::Approve, String::new(), "a".repeat(40), None).await.unwrap();
    assert!(result.submitted);
    let mutations: Vec<_> =
        fx.sent("POST", "/api/graphql").into_iter().filter(|r| r.body_text().contains("addPullRequestReviewThread")).collect();
    assert_eq!(mutations.len(), 2);
    assert_eq!(mutations[0].json()["variables"]["input"]["pullRequestReviewId"], "PRR_kwDOpending");
    assert_eq!(fx.sent("POST", "/pulls/9/reviews/77/events")[0].json(), json!({ "body": "", "event": "APPROVE" }));
    assert!(fx.sent("POST", "/pulls/9/reviews").is_empty(), "no second review");
}

#[tokio::test]
async fn a_failing_vote_after_joining_the_pending_review_still_drops_the_sent_drafts() {
    let fx = Fixture::new(HostKind::Github).await;
    fx.state.lock().gh_pending_review = true;
    save(&fx, comment("a.rs", 3)).await;
    save(&fx, comment("c.rs", 9)).await;
    fx.mode("422");
    let error =
        cmd_review::pr_review_submit(&fx.tc, fx.id(), 9, ReviewVote::Approve, String::new(), "a".repeat(40), None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::HostRejected);
    assert!(error.message.starts_with("The 2 line comments were sent; the review itself was not:"), "{}", error.message);
    assert_eq!(fx.sent("POST", "/pulls/9/reviews/77/events").len(), 1);
    let left = cmd_review::pr_review_drafts(&fx.tc, fx.id(), 9, None).await.unwrap().drafts;
    assert!(left.iter().all(|d| d.origin == ReviewDraftOrigin::Host), "sent drafts are gone locally: {left:?}");
}

#[tokio::test]
async fn github_threads_resolve_through_graphql_with_the_thread_node_id() {
    let fx = Fixture::new(HostKind::Github).await;
    let threads = cmd::pr_review_threads(&fx.tc, fx.id(), 9, None).await.unwrap();
    let id = threads[0].resolve_id.clone().expect("node id");
    cmd_review::pr_review_thread_resolve(&fx.tc, fx.id(), 9, id.clone(), true, None).await.unwrap();
    cmd_review::pr_review_thread_resolve(&fx.tc, fx.id(), 9, id.clone(), false, None).await.unwrap();
    let bodies: Vec<String> = fx.sent("POST", "/api/graphql").iter().map(|r| r.body_text()).collect();
    assert!(bodies.iter().any(|b| b.contains("resolveReviewThread") && b.contains(&id)));
    assert!(bodies.iter().any(|b| b.contains("unresolveReviewThread")));
    fx.server.clear();
    let bad = cmd_review::pr_review_thread_resolve(&fx.tc, fx.id(), 9, "../x".into(), true, None).await.unwrap_err();
    assert_eq!(bad.code, ErrorCode::NotAllowed);
    assert!(fx.server.requests().is_empty());
}

#[tokio::test]
async fn github_rejection_keeps_all_drafts() {
    let fx = Fixture::new(HostKind::Github).await;
    save(&fx, comment("a.rs", 3)).await;
    save(&fx, comment("b.rs", 7)).await;
    fx.mode("422");
    let error =
        cmd_review::pr_review_submit(&fx.tc, fx.id(), 9, ReviewVote::Comment, String::new(), "a".repeat(40), None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::HostRejected);
    assert!(!error.message.contains("were sent"), "{}", error.message);
    let left = cmd_review::pr_review_drafts(&fx.tc, fx.id(), 9, None).await.unwrap().drafts;
    assert_eq!(left.len(), 2);
    assert!(left.iter().all(|d| d.error.is_none()), "one request: nothing was sent, no draft is marked");
}

#[test]
fn review_capabilities_match_the_matrix() {
    let row = |k| {
        let c = crate::host::host(k).capabilities();
        [
            c.review_comment,
            c.review_comment_range,
            c.review_resolve,
            c.review_submit_batch,
            c.review_approve,
            c.review_request_changes,
            c.review_vote_own_pr,
        ]
    };
    assert_eq!(row(HostKind::Github), [true, true, true, true, true, true, false]);
    assert_eq!(row(HostKind::Gitlab), [true, false, true, true, true, false, false]);
    assert_eq!(row(HostKind::Gitea), [true, false, false, true, true, true, false]);
    // Task 6 appends its rows here, exactly as in the plan's matrix.
}

fn gl_comment(path: &str, line: u32) -> NewReviewComment {
    NewReviewComment { commit: MOCK_GL_HEAD.into(), ..comment(path, line) }
}

/// Method and path (after the project) of every request that changes something, in order.
fn gl_writes(fx: &Fixture) -> Vec<String> {
    fx.server
        .requests()
        .iter()
        .filter(|r| r.method != "GET")
        .map(|r| format!("{} {}", r.method, r.path().split_once("/merge_requests/").map_or("", |(_, rest)| rest)))
        .collect()
}

#[tokio::test]
async fn gitlab_comment_on_an_unchanged_line_sends_both_numbers() {
    let fx = Fixture::new(HostKind::Gitlab).await;
    let c = NewReviewComment { old_line: Some(40), ..gl_comment("src/größe.rs", 42) };
    cmd_review::pr_review_comment_create(&fx.tc, fx.id(), 9, c, None).await.unwrap();
    assert_eq!(
        fx.sent("POST", "/merge_requests/9/discussions")[0].json(),
        json!({ "body": "Hier fehlt die Prüfung auf leer.",
        "position": { "position_type": "text", "base_sha": MOCK_GL_BASE, "start_sha": MOCK_GL_START, "head_sha": MOCK_GL_HEAD,
                      "old_path": "src/größe.rs", "new_path": "src/größe.rs", "new_line": 42, "old_line": 40 } })
    );
}

#[tokio::test]
async fn gitlab_comment_on_the_old_side_sends_only_the_old_number() {
    let fx = Fixture::new(HostKind::Gitlab).await;
    let c = NewReviewComment { side: ReviewSide::Old, ..gl_comment("src/alt.rs", 12) };
    cmd_review::pr_review_comment_create(&fx.tc, fx.id(), 9, c, None).await.unwrap();
    let position = fx.sent("POST", "/merge_requests/9/discussions")[0].json()["position"].clone();
    assert_eq!((position["old_line"].clone(), position.get("new_line")), (json!(12), None));
}

#[tokio::test]
async fn gitlab_refuses_a_comment_on_an_old_head() {
    let fx = Fixture::new(HostKind::Gitlab).await;
    let c = NewReviewComment { commit: "b".repeat(40), ..comment("src/größe.rs", 42) };
    let error = cmd_review::pr_review_comment_create(&fx.tc, fx.id(), 9, c, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::StaleState);
    assert_eq!(error.message, "The merge request has new commits. Reload and comment again.");
    assert!(gl_writes(&fx).is_empty(), "no POST: {:?}", gl_writes(&fx));
}

#[tokio::test]
async fn gitlab_submit_publishes_draft_notes_then_body_then_approval() {
    let fx = Fixture::new(HostKind::Gitlab).await;
    fx.state.lock().gl_draft_note = true;
    save(&fx, NewReviewComment { old_line: Some(2), ..gl_comment("a.rs", 3) }).await;
    let listed = cmd_review::pr_review_drafts(&fx.tc, fx.id(), 9, None).await.unwrap().drafts;
    let host = &listed[0];
    assert_eq!(
        (host.origin, host.id.as_str(), host.path.as_str(), host.line, host.side, host.body.as_str()),
        (ReviewDraftOrigin::Host, "5501", "src/anmeldung.rs", Some(12), ReviewSide::New, "Im Browser begonnen.")
    );
    assert_eq!(listed[1].origin, ReviewDraftOrigin::Local);
    fx.server.clear();
    let result = cmd_review::pr_review_submit(&fx.tc, fx.id(), 9, ReviewVote::Approve, "Sieht gut aus.".into(), MOCK_GL_HEAD.into(), None)
        .await
        .unwrap();
    assert_eq!((result.submitted, result.sent, result.failed.len()), (true, 1, 0));
    assert_eq!(gl_writes(&fx), ["POST 9/draft_notes", "POST 9/draft_notes/bulk_publish", "POST 9/notes", "POST 9/approve"]);
    let note = fx.sent("POST", "/merge_requests/9/draft_notes")[0].json();
    assert_eq!(note["note"], "Hier fehlt die Prüfung auf leer.");
    assert_eq!((note["position"]["new_line"].clone(), note["position"]["old_line"].clone()), (json!(3), json!(2)));
    assert_eq!(note["position"]["head_sha"], MOCK_GL_HEAD);
    assert_eq!(fx.sent("POST", "/merge_requests/9/notes")[0].json(), json!({ "body": "Sieht gut aus." }));
    assert_eq!(fx.sent("POST", "/merge_requests/9/approve")[0].json(), json!({ "sha": MOCK_GL_HEAD }));
    let left = cmd_review::pr_review_drafts(&fx.tc, fx.id(), 9, None).await.unwrap().drafts;
    assert!(left.iter().all(|d| d.origin == ReviewDraftOrigin::Host), "local drafts are gone: {left:?}");
}

#[tokio::test]
async fn gitlab_failing_draft_note_keeps_it_and_publishes_nothing() {
    let fx = Fixture::new(HostKind::Gitlab).await;
    let fine = save(&fx, gl_comment("a.rs", 3)).await;
    let broken = save(&fx, NewReviewComment { body: "kaputt".into(), ..gl_comment("b.rs", 7) }).await;
    let result =
        cmd_review::pr_review_submit(&fx.tc, fx.id(), 9, ReviewVote::Approve, String::new(), MOCK_GL_HEAD.into(), None).await.unwrap();
    assert!(!result.submitted);
    assert_eq!((result.sent, result.failed.len()), (1, 1));
    assert_eq!(result.failed[0].id, broken.id);
    assert!(result.failed[0].error.is_some());
    assert_eq!(gl_writes(&fx), ["POST 9/draft_notes", "POST 9/draft_notes"], "no bulk_publish, no approve");
    let left = cmd_review::pr_review_drafts(&fx.tc, fx.id(), 9, None).await.unwrap().drafts;
    assert!(left.iter().all(|d| d.id != fine.id), "the sent one is a draft note at GitLab now");
}

#[tokio::test]
async fn gitlab_draft_from_an_older_head_is_not_sent() {
    let fx = Fixture::new(HostKind::Gitlab).await;
    let old = save(&fx, comment("a.rs", 3)).await;
    let result =
        cmd_review::pr_review_submit(&fx.tc, fx.id(), 9, ReviewVote::Comment, String::new(), MOCK_GL_HEAD.into(), None).await.unwrap();
    assert_eq!((result.submitted, result.sent), (false, 0));
    assert_eq!(result.failed[0].id, old.id);
    assert!(gl_writes(&fx).is_empty(), "{:?}", gl_writes(&fx));
}

#[tokio::test]
async fn gitlab_refuses_a_review_on_an_old_head() {
    let fx = Fixture::new(HostKind::Gitlab).await;
    save(&fx, gl_comment("a.rs", 3)).await;
    let error =
        cmd_review::pr_review_submit(&fx.tc, fx.id(), 9, ReviewVote::Approve, String::new(), "b".repeat(40), None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::StaleState);
    assert!(gl_writes(&fx).is_empty());
    let left = cmd_review::pr_review_drafts(&fx.tc, fx.id(), 9, None).await.unwrap().drafts;
    assert_eq!((left.len(), left[0].error.clone()), (1, None));
}

#[tokio::test]
async fn gitlab_failing_approval_after_publishing_says_what_went_out() {
    let fx = Fixture::new(HostKind::Gitlab).await;
    fx.state.lock().gl_approve_fails = true;
    save(&fx, gl_comment("a.rs", 3)).await;
    save(&fx, gl_comment("c.rs", 9)).await;
    let error = cmd_review::pr_review_submit(&fx.tc, fx.id(), 9, ReviewVote::Approve, "Sieht gut aus.".into(), MOCK_GL_HEAD.into(), None)
        .await
        .unwrap_err();
    assert!(
        error.message.starts_with("The line comments and the review text were posted on GitLab; only the approval failed:"),
        "{}",
        error.message
    );
    assert!(
        error.message.ends_with("Approve the merge request on GitLab, or send an Approve review here without text."),
        "{}",
        error.message
    );
    assert_eq!(
        gl_writes(&fx),
        ["POST 9/draft_notes", "POST 9/draft_notes", "POST 9/draft_notes/bulk_publish", "POST 9/notes", "POST 9/approve"]
    );
    let left = cmd_review::pr_review_drafts(&fx.tc, fx.id(), 9, None).await.unwrap().drafts;
    assert!(left.is_empty(), "sent drafts are gone locally: {left:?}");
    // The advised retry: an Approve without text posts nothing again.
    fx.state.lock().gl_approve_fails = false;
    fx.server.clear();
    cmd_review::pr_review_submit(&fx.tc, fx.id(), 9, ReviewVote::Approve, String::new(), MOCK_GL_HEAD.into(), None).await.unwrap();
    assert_eq!(gl_writes(&fx), ["POST 9/draft_notes/bulk_publish", "POST 9/approve"]);
}

#[tokio::test]
async fn gitlab_already_approved_skips_the_approval_and_succeeds() {
    let fx = Fixture::new(HostKind::Gitlab).await;
    fx.state.lock().gl_already_approved = true;
    save(&fx, gl_comment("a.rs", 3)).await;
    let result = cmd_review::pr_review_submit(&fx.tc, fx.id(), 9, ReviewVote::Approve, "Sieht gut aus.".into(), MOCK_GL_HEAD.into(), None)
        .await
        .unwrap();
    assert!(result.submitted);
    assert_eq!(gl_writes(&fx), ["POST 9/draft_notes", "POST 9/draft_notes/bulk_publish", "POST 9/notes"], "no second approval");
    let flagged: i64 =
        fx.tc.db.with(|c| Ok(c.query_row("select count(*) from hoster_accounts where last_error is not null", [], |r| r.get(0))?)).unwrap();
    assert_eq!(flagged, 0, "the account is not flagged");
}

#[tokio::test]
async fn gitlab_refuses_an_approval_it_would_not_take_before_anything_is_sent() {
    let fx = Fixture::new(HostKind::Gitlab).await;
    fx.state.lock().gl_cannot_approve = true;
    let draft = save(&fx, gl_comment("a.rs", 3)).await;
    let error = cmd_review::pr_review_submit(&fx.tc, fx.id(), 9, ReviewVote::Approve, "Sieht gut aus.".into(), MOCK_GL_HEAD.into(), None)
        .await
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::NotAllowed);
    assert!(error.message.contains("does not let you approve merge request !9"), "{}", error.message);
    assert!(gl_writes(&fx).is_empty(), "{:?}", gl_writes(&fx));
    assert_eq!(cmd_review::pr_review_drafts(&fx.tc, fx.id(), 9, None).await.unwrap().drafts, vec![draft]);
}

#[tokio::test]
async fn gitlab_request_changes_is_unsupported_without_a_request() {
    let fx = Fixture::new(HostKind::Gitlab).await;
    let error =
        cmd_review::pr_review_submit(&fx.tc, fx.id(), 9, ReviewVote::RequestChanges, "Bitte ändern.".into(), MOCK_GL_HEAD.into(), None)
            .await
            .unwrap_err();
    assert_eq!(error.code, ErrorCode::HostUnsupported);
    assert!(fx.server.requests().is_empty());
}

#[tokio::test]
async fn gitlab_discussions_resolve_with_put() {
    let fx = Fixture::new(HostKind::Gitlab).await;
    let threads = cmd::pr_review_threads(&fx.tc, fx.id(), 9, None).await.unwrap();
    let id = threads[0].resolve_id.clone().expect("resolvable discussion");
    assert_eq!(id, threads[0].id, "the discussion id");
    cmd_review::pr_review_thread_resolve(&fx.tc, fx.id(), 9, id.clone(), true, None).await.unwrap();
    cmd_review::pr_review_thread_resolve(&fx.tc, fx.id(), 9, id.clone(), false, None).await.unwrap();
    let sent = fx.sent("PUT", &format!("/merge_requests/9/discussions/{id}"));
    assert_eq!(sent.iter().map(|r| r.json()).collect::<Vec<_>>(), [json!({ "resolved": true }), json!({ "resolved": false })]);
}

/// Gitea's mock pull request no. 9 has the head `MOCK_GL_HEAD` (`sha(9)`).
fn gt_comment(path: &str, line: u32) -> NewReviewComment {
    NewReviewComment { commit: MOCK_GL_HEAD.into(), ..comment(path, line) }
}

fn gt_writes(fx: &Fixture) -> usize {
    fx.server.requests().iter().filter(|r| r.method != "GET").count()
}

#[tokio::test]
async fn gitea_review_carries_line_numbers_as_positions() {
    let fx = Fixture::new(HostKind::Gitea).await;
    save(&fx, gt_comment("a.rs", 3)).await;
    save(&fx, NewReviewComment { side: ReviewSide::Old, ..gt_comment("b.rs", 7) }).await;
    let result =
        cmd_review::pr_review_submit(&fx.tc, fx.id(), 9, ReviewVote::Approve, "Passt.".into(), MOCK_GL_HEAD.into(), None).await.unwrap();
    assert_eq!((result.submitted, result.sent), (true, 2));
    assert_eq!(
        fx.sent("POST", "/pulls/9/reviews")[0].json(),
        json!({ "body": "Passt.", "commit_id": MOCK_GL_HEAD, "event": "APPROVED",
        "comments": [{ "path": "a.rs", "body": "Hier fehlt die Prüfung auf leer.", "new_position": 3 },
                     { "path": "b.rs", "body": "Hier fehlt die Prüfung auf leer.", "old_position": 7 }] })
    );
    assert!(cmd_review::pr_review_drafts(&fx.tc, fx.id(), 9, None).await.unwrap().drafts.is_empty());
}

#[tokio::test]
async fn gitea_request_changes_uses_its_event() {
    let fx = Fixture::new(HostKind::Gitea).await;
    cmd_review::pr_review_submit(&fx.tc, fx.id(), 9, ReviewVote::RequestChanges, "Bitte ändern.".into(), MOCK_GL_HEAD.into(), None)
        .await
        .unwrap();
    let sent = fx.sent("POST", "/pulls/9/reviews")[0].json();
    assert_eq!((sent["event"].clone(), sent["comments"].clone()), (json!("REQUEST_CHANGES"), json!([])));
}

#[tokio::test]
async fn gitea_comment_now_is_a_comment_review_with_one_comment() {
    let fx = Fixture::new(HostKind::Gitea).await;
    cmd_review::pr_review_comment_create(&fx.tc, fx.id(), 9, gt_comment("a.rs", 3), None).await.unwrap();
    assert_eq!(
        fx.sent("POST", "/pulls/9/reviews")[0].json(),
        json!({ "body": "", "commit_id": MOCK_GL_HEAD, "event": "COMMENT",
        "comments": [{ "path": "a.rs", "body": "Hier fehlt die Prüfung auf leer.", "new_position": 3 }] })
    );
}

#[tokio::test]
async fn gitea_refuses_a_comment_and_a_review_on_an_old_head() {
    let fx = Fixture::new(HostKind::Gitea).await;
    let old = NewReviewComment { commit: "b".repeat(40), ..comment("a.rs", 3) };
    let error = cmd_review::pr_review_comment_create(&fx.tc, fx.id(), 9, old, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::StaleState);
    save(&fx, gt_comment("a.rs", 3)).await;
    let error =
        cmd_review::pr_review_submit(&fx.tc, fx.id(), 9, ReviewVote::Approve, String::new(), "b".repeat(40), None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::StaleState);
    assert_eq!(gt_writes(&fx), 0);
}

#[tokio::test]
async fn gitea_draft_from_an_older_head_is_not_sent() {
    let fx = Fixture::new(HostKind::Gitea).await;
    let old = save(&fx, comment("a.rs", 3)).await;
    let result =
        cmd_review::pr_review_submit(&fx.tc, fx.id(), 9, ReviewVote::Comment, String::new(), MOCK_GL_HEAD.into(), None).await.unwrap();
    assert_eq!((result.submitted, result.sent, result.failed[0].id.clone()), (false, 0, old.id));
    assert_eq!(gt_writes(&fx), 0);
}

#[tokio::test]
async fn gitea_has_no_resolve() {
    let fx = Fixture::new(HostKind::Gitea).await;
    let error = pr_review_thread_resolve(&fx.tc, fx.id(), 9, "91".into(), true, None).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::HostUnsupported);
    assert!(fx.server.requests().is_empty());
}
