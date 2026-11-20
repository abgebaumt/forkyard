//! PR review: local drafts of the own review, kept per pull request until they are sent.

use super::Fixture;
use crate::commands::pr_review::{pr_review_draft_delete, pr_review_draft_save, pr_review_drafts};
use crate::db;
use crate::error::ErrorCode;
use crate::model::{HostKind, NewReviewComment, ReviewDraft, ReviewDraftOrigin, ReviewSide};

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
    assert_eq!(saved.body, "Doch lieber anders.");
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
