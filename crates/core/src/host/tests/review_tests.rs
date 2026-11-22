//! PR review: local drafts of the own review, kept per pull request until they are sent.

use super::Fixture;
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
    assert!(fx.server.requests().is_empty(), "nothing sent");
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
    let fx = Fixture::new(HostKind::Github).await;
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
// The invalid-ID case (`"../x"` → `not_allowed`, no request) is asserted in Task 3 once GitHub resolves.

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
