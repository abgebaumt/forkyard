//! `--update-refs`: dependent branches in the plan, moving them along in a rebase and an
//! interactive rebase, recording them when a stopped rebase finishes, and undo/redo of all of them.

use super::*;
use crate::testkit::{TestCore, TestRepo};

async fn setup() -> (TestCore, TestRepo, String) {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    tc.events.clear();
    (tc, repo, id)
}

fn sha_of(repo: &TestRepo, rev: &str) -> String {
    repo.git(&["rev-parse", rev])
}

fn row(sha: &str, action: RebaseAction, message: Option<&str>) -> RebasePlanRow {
    RebasePlanRow {
        sha: sha.to_string(),
        summary: String::new(),
        description: String::new(),
        author: Person { name: String::new(), email: String::new() },
        authored_at: String::new(),
        action,
        message: message.map(str::to_string),
    }
}

/// `main` ← `part` ← `feature` (stacked), and `main` has moved on. HEAD on `feature`.
/// Returns (tip of `part`, tip of `feature`).
fn stacked(repo: &TestRepo) -> (String, String) {
    repo.checkout_new("feature");
    let part = repo.commit_file("a.txt", "a\n", "Teil 1");
    repo.branch("part");
    let tip = repo.commit_file("b.txt", "b\n", "Teil 2");
    repo.checkout("main");
    repo.commit_file("m.txt", "m\n", "Main geht weiter");
    repo.checkout("feature");
    (part, tip)
}

#[tokio::test]
async fn plan_and_dependents_list_branches_inside_the_range() {
    let (tc, repo, id) = setup().await;
    let base = repo.head();
    stacked(&repo);
    // Checked out in another worktree: Git would not move it, so it is not offered.
    repo.git(&["branch", "elsewhere", "part"]);
    let worktree = repo.temp_dir().join("zweiter ort");
    repo.git(&["worktree", "add", "-q", worktree.to_str().unwrap(), "elsewhere"]);

    match rebase_plan(&tc, id.clone(), base).await.unwrap() {
        RebasePlan::Ok { dependent_branches, .. } => assert_eq!(dependent_branches, ["part"]),
        other => panic!("{other:?}"),
    }
    assert_eq!(rebase_dependents(&tc, id.clone(), "main".into(), None).await.unwrap(), ["part"]);
    assert!(rebase_dependents(&tc, id.clone(), "main".into(), Some("part".into())).await.unwrap().is_empty());
}

#[tokio::test]
async fn rebase_with_update_refs_moves_dependent_branches_and_undo_resets_all() {
    let (tc, repo, id) = setup().await;
    let (old_part, old_tip) = stacked(&repo);

    let result = rebase_start_with(&tc, id.clone(), "main".into(), None, Some(true)).await.unwrap();
    assert!(matches!(result, OpResult::Done { .. }), "{result:?}");
    let new_tip = repo.head();
    let new_part = sha_of(&repo, "part");
    assert_ne!(new_part, old_part);
    assert_eq!(sha_of(&repo, "feature~1"), new_part, "part sits on the rebased commit");
    assert_eq!(sha_of(&repo, "part~1"), sha_of(&repo, "main"));

    let entry = undo::next_undo(&tc, &id, "").unwrap().expect("undo entry");
    assert_eq!(repo.git(&["rev-parse", &undo::backup_ref_name(&entry.id, "dep-0")]), old_part, "every dependent branch is backed up");
    assert_eq!(entry.payload["updatedRefs"], json!([{ "ref": "refs/heads/part", "before": old_part, "after": new_part }]));

    crate::commands::undo::undo(&tc, id.clone()).await.unwrap();
    assert_eq!(repo.head(), old_tip);
    assert_eq!(sha_of(&repo, "part"), old_part, "undo resets the dependent branch too");
    crate::commands::undo::redo(&tc, id.clone()).await.unwrap();
    assert_eq!(repo.head(), new_tip);
    assert_eq!(sha_of(&repo, "part"), new_part);

    // Without the option other branches stay where they are.
    crate::commands::undo::undo(&tc, id.clone()).await.unwrap();
    rebase_start(&tc, id.clone(), "main".into(), None).await.unwrap();
    assert_eq!(sha_of(&repo, "part"), old_part);
}

/// A dependent branch checked out in another worktree since the rebase: `update-ref` would move it
/// under that worktree's index and files, so neither undo nor redo offers the entry.
#[tokio::test]
async fn undo_skips_the_rebase_when_a_dependent_branch_is_checked_out_in_another_worktree() {
    let (tc, repo, id) = setup().await;
    let (_, old_tip) = stacked(&repo);
    rebase_start_with(&tc, id.clone(), "main".into(), None, Some(true)).await.unwrap();
    let new_tip = repo.head();
    let new_part = sha_of(&repo, "part");
    let worktree = repo.temp_dir().join("anderer ort");
    repo.git(&["worktree", "add", "-q", worktree.to_str().unwrap(), "part"]);

    assert!(crate::commands::undo::undo_peek(&tc, id.clone()).await.unwrap().undo.is_none(), "not offered");
    let _ = crate::commands::undo::undo(&tc, id.clone()).await;
    assert_eq!(sha_of(&repo, "part"), new_part, "the checked-out branch stays");
    assert_eq!(repo.head(), new_tip, "the rebase stays as well");
    let status = repo.git(&["-C", worktree.to_str().unwrap(), "status", "--porcelain"]);
    assert_eq!(status, "", "the other worktree is untouched");

    // Out of the other worktree again: undo goes through, redo is blocked the same way.
    repo.git(&["worktree", "remove", worktree.to_str().unwrap()]);
    crate::commands::undo::undo(&tc, id.clone()).await.unwrap();
    assert_eq!(repo.head(), old_tip);
    repo.git(&["worktree", "add", "-q", worktree.to_str().unwrap(), "part"]);
    assert!(crate::commands::undo::undo_peek(&tc, id.clone()).await.unwrap().redo.is_none(), "redo not offered");
}

#[tokio::test]
async fn interactive_rebase_with_update_refs_keeps_dependents_on_their_commits() {
    let (tc, repo, id) = setup().await;
    let base = repo.head();
    repo.checkout_new("feature");
    let a = repo.commit_file("a.txt", "a\n", "A");
    repo.branch("part");
    let b = repo.commit_file("b.txt", "b\n", "B");
    let c = repo.commit_file("c.txt", "c\n", "C");

    let rows = vec![row(&a, RebaseAction::Reword, Some("A neu")), row(&b, RebaseAction::Drop, None), row(&c, RebaseAction::Pick, None)];
    rebase_apply_with(&tc, id.clone(), base, rows, Some(true)).await.unwrap();
    assert_eq!(repo.git(&["log", "-1", "--format=%s", "part"]), "A neu", "part follows the reworded commit");
    assert_eq!(repo.git(&["log", "--format=%s", "feature"]).lines().collect::<Vec<_>>(), ["C", "A neu", "Erster Commit"]);

    crate::commands::undo::undo(&tc, id.clone()).await.unwrap();
    assert_eq!(sha_of(&repo, "part"), a);
}

#[tokio::test]
async fn dependents_of_a_stopped_rebase_are_recorded_when_it_finishes() {
    let (tc, repo, id) = setup().await;
    repo.commit_file("f.txt", "eins\n", "Basis");
    repo.checkout_new("feature");
    let old_part = repo.commit_file("g.txt", "g\n", "Teil");
    repo.branch("part");
    repo.commit_file("f.txt", "feature\n", "Konflikt");
    repo.checkout("main");
    repo.commit_file("f.txt", "main\n", "Main");
    repo.checkout("feature");

    let result = rebase_start_with(&tc, id.clone(), "main".into(), None, Some(true)).await.unwrap();
    assert!(matches!(result, OpResult::Conflict { .. }), "{result:?}");
    repo.write_file("f.txt", "beides\n");
    repo.git(&["add", "f.txt"]);
    crate::commands::merge::operation_continue(&tc, id.clone(), None, None).await.unwrap();
    let new_part = sha_of(&repo, "part");
    assert_ne!(new_part, old_part, "Git moved part at the end");
    let entry = undo::next_undo(&tc, &id, "").unwrap().expect("undo entry");
    assert_eq!(entry.payload["updatedRefs"][0]["after"], json!(new_part));

    crate::commands::undo::undo(&tc, id.clone()).await.unwrap();
    assert_eq!(sha_of(&repo, "part"), old_part);
}

/// A foreign lock on a dependent branch: nothing at all is undone – not the rebase either.
#[tokio::test]
async fn a_locked_dependent_branch_stops_the_whole_undo() {
    let (tc, repo, id) = setup().await;
    stacked(&repo);
    rebase_start_with(&tc, id.clone(), "main".into(), None, Some(true)).await.unwrap();
    let (new_tip, new_part) = (repo.head(), sha_of(&repo, "part"));
    let lock = repo.path().join(".git").join("refs").join("heads").join("part.lock");
    std::fs::write(&lock, b"").unwrap();
    let err = crate::commands::undo::undo(&tc, id.clone()).await.unwrap_err();
    std::fs::remove_file(&lock).unwrap();
    assert_eq!(err.code, ErrorCode::Locked, "{err:?}");
    assert_eq!(repo.head(), new_tip, "the rebase stays");
    assert_eq!(sha_of(&repo, "part"), new_part, "the dependent branch stays");
    // Without the lock the same entry works.
    crate::commands::undo::undo(&tc, id.clone()).await.unwrap();
    assert_ne!(repo.head(), new_tip);
    assert_ne!(sha_of(&repo, "part"), new_part);
}

/// The rebase cannot be undone (local changes): the dependent branches stay where the rebase put them.
#[tokio::test]
async fn a_dirty_working_directory_leaves_the_dependent_branches_in_place() {
    let (tc, repo, id) = setup().await;
    stacked(&repo);
    rebase_start_with(&tc, id.clone(), "main".into(), None, Some(true)).await.unwrap();
    let (new_tip, new_part) = (repo.head(), sha_of(&repo, "part"));
    repo.write_file("b.txt", "lokal geändert\n");
    let err = crate::commands::undo::undo(&tc, id.clone()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::DirtyWorktree, "{err:?}");
    assert_eq!(repo.head(), new_tip);
    assert_eq!(sha_of(&repo, "part"), new_part, "moved back after the failed undo");
    assert_eq!(repo.read_file("b.txt"), "lokal geändert\n".as_bytes());
}
