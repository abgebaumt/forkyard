//! Undo of "Compose commits": one step for all commits – refused once they are on a remote.

use super::apply_tests::{apply, commit, unit};
use super::units_tests::{open, twenty, two_hunks};
use super::*;
use crate::commands::undo::{undo, undo_peek};
use crate::error::ErrorCode;
use crate::testkit::TestRepo;

#[tokio::test]
async fn a_pushed_compose_is_no_longer_offered_for_undo() {
    let repo = TestRepo::with_commit();
    // Keep the remote alive: dropping `TestRemote` deletes its folder, and the push below needs it.
    let _remote = repo.add_remote();
    repo.commit_file("a.txt", twenty(), "Zwanzig");
    repo.write_file("a.txt", two_hunks());
    let (tc, id) = open(&repo).await;
    let state = compose_units(&tc, id.clone()).await.unwrap();
    let result = apply(
        &tc,
        &id,
        &state,
        vec![commit("Erster Teil", "", &[unit(&state, "a.txt", Some(0))]), commit("Zweiter Teil", "", &[unit(&state, "a.txt", Some(1))])],
    )
    .await
    .unwrap();
    assert!(undo_peek(&tc, id.clone()).await.unwrap().undo.is_some(), "offered while the commits are local");

    repo.git(&["push", "-q", "origin", "main"]);

    let peek = undo_peek(&tc, id.clone()).await.unwrap();
    assert!(peek.undo.is_none(), "{peek:?}");
    let reason = peek.undo_blocked.unwrap_or_default();
    assert!(reason.contains("already on the remote (origin/main)"), "{reason}");
    assert_eq!(undo(&tc, id).await.unwrap_err().code, ErrorCode::NothingToUndo);
    assert_eq!(repo.head(), result.commits[1], "nothing was rewritten");
}

#[tokio::test]
async fn a_compose_whose_first_commit_alone_was_pushed_is_no_longer_offered_for_undo() {
    let repo = TestRepo::with_commit();
    let _remote = repo.add_remote();
    repo.commit_file("a.txt", twenty(), "Zwanzig");
    repo.write_file("a.txt", two_hunks());
    let (tc, id) = open(&repo).await;
    let state = compose_units(&tc, id.clone()).await.unwrap();
    let result = apply(
        &tc,
        &id,
        &state,
        vec![commit("Erster Teil", "", &[unit(&state, "a.txt", Some(0))]), commit("Zweiter Teil", "", &[unit(&state, "a.txt", Some(1))])],
    )
    .await
    .unwrap();

    // Only the first of the two new commits reaches the remote; the second stays local.
    let first = result.commits[0].clone();
    repo.git(&["push", "-q", "origin", &format!("{first}:refs/heads/main")]);
    repo.git(&["fetch", "-q", "origin"]);

    let peek = undo_peek(&tc, id.clone()).await.unwrap();
    assert!(peek.undo.is_none(), "undoing would drop a commit the remote already has: {peek:?}");
    let reason = peek.undo_blocked.unwrap_or_default();
    assert!(reason.contains("already on the remote (origin/main)"), "{reason}");
    assert_eq!(undo(&tc, id).await.unwrap_err().code, ErrorCode::NothingToUndo);
    assert_eq!(repo.head(), result.commits[1], "nothing was rewritten");
}
