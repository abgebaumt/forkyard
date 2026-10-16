//! Keep refs: the undo history survives `git gc --aggressive --prune=now`.

use super::test_support::*;
use crate::model::{CleanupMode, CleanupStep, CleanupStepStatus};

fn set_created_at(tc: &crate::testkit::TestCore, entry: &str, at: &str) {
    tc.db
        .with(|c| {
            c.execute("update undo_entries set created_at = ?2 where id = ?1", rusqlite::params![entry, at])?;
            Ok(())
        })
        .unwrap();
}

#[tokio::test]
async fn thorough_keeps_objects_of_open_undo_entries() {
    let (tc, repo, id) = setup().await;
    repo.git(&["config", "gc.reflogExpire", "now"]);
    repo.git(&["config", "gc.reflogExpireUnreachable", "now"]);
    let base = repo.head();
    let tree = repo.git(&["rev-parse", "HEAD^{tree}"]);
    // Two commits that no ref and no reflog reach; an open undo entry – without a backup ref, as a
    // reset records it – names the first one.
    let kept = repo.git(&["commit-tree", &tree, "-p", &base, "-m", "Verworfen, aber mit Undo"]);
    let lost = repo.git(&["commit-tree", &tree, "-p", &base, "-m", "Verworfen ohne Undo"]);
    record_plain_entry(&tc, &id, &kept, &base).await;
    // An entry naming an object that is gone already must not stop the run.
    record_plain_entry(&tc, &id, &"ab".repeat(20), &base).await;
    let result = run_cleanup(&tc, &id, only_gc(CleanupMode::Thorough)).await.unwrap();
    assert_eq!(status_of(&result, CleanupStep::Gc), CleanupStepStatus::Done, "{:?}", result.failure);
    assert!(!object_exists(&repo, &lost), "--prune=now really pruned an unreachable commit");
    assert!(object_exists(&repo, &kept), "the commit of the open undo entry is still there");
    assert_eq!(repo.git(&["for-each-ref", "refs/forkyard/keep/"]), "", "no keep ref outlives the run");
    repo.git(&["fsck", "--no-progress"]);
}

#[tokio::test]
async fn undo_entries_removed_by_the_same_run_get_no_keep_ref() {
    let (tc, repo, id) = setup().await;
    let base = repo.head();
    let tree = repo.git(&["rev-parse", "HEAD^{tree}"]);
    let old = repo.git(&["commit-tree", &tree, "-p", &base, "-m", "Alter Stand"]);
    let entry = record_plain_entry(&tc, &id, &old, &base).await;
    set_created_at(&tc, &entry, &crate::util::unix_to_iso(now() - 30 * DAY));
    let options = crate::model::CleanupOptions { undo_older_than_days: Some(14), ..only_gc(CleanupMode::Thorough) };
    let result = run_cleanup(&tc, &id, options).await.unwrap();
    assert_eq!(status_of(&result, CleanupStep::Undo), CleanupStepStatus::Done);
    assert!(!object_exists(&repo, &old), "the removed entry no longer keeps its commit");
}

#[tokio::test]
async fn keep_refs_left_by_an_interrupted_run_are_removed() {
    let (tc, repo, id) = setup().await;
    let head = repo.head();
    repo.git(&["update-ref", &format!("refs/forkyard/keep/{head}"), &head]);
    run_cleanup(&tc, &id, only_gc(CleanupMode::Normal)).await.unwrap();
    assert_eq!(repo.git(&["for-each-ref", "refs/forkyard/keep/"]), "");
}
