//! Group undo entries (`undo::record_group`): several refs and optionally a snapshot of working
//! directory and index, undone and redone together. The "actions" are done with plain Git here; the
//! packages that create such entries (compose, plan, stacks …) come later.

use serde_json::Map;

use super::*;
use crate::testkit::{TestCore, TestRepo};
use crate::undo::{GroupRecord, GroupSnapshot, RefMove};

async fn setup() -> (TestCore, TestRepo, String) {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    (tc, repo, id)
}

fn sha(repo: &TestRepo, rev: &str) -> String {
    repo.git(&["rev-parse", rev])
}

fn has_ref(repo: &TestRepo, name: &str) -> bool {
    repo.git_output(&["rev-parse", "--verify", "-q", name]).status.success()
}

fn group(id: &str, entry: &str, action: UndoAction, label: &str, refs: Vec<RefMove>, snapshot: Option<GroupSnapshot>) -> GroupRecord {
    GroupRecord {
        id: entry.to_string(),
        repo_id: id.to_string(),
        action,
        label: label.to_string(),
        refs,
        head_before: "refs/heads/main".into(),
        head_after: Some("refs/heads/main".into()),
        snapshot,
        extra: Map::new(),
    }
}

/// `feature` with two commits; then the "action": two stack branches appear and `feature` moves.
async fn stacked(tc: &TestCore, repo: &TestRepo, id: &str) -> (String, String, String, String) {
    let base = repo.head();
    repo.checkout_new("feature");
    let one = repo.commit_file("a.txt", "eins\n", "Teil 1");
    let two = repo.commit_file("b.txt", "zwei\n", "Teil 2");
    repo.checkout("main");
    repo.git(&["update-ref", "refs/heads/stack/1", &one]);
    repo.git(&["update-ref", "refs/heads/stack/2", &two]);
    repo.git(&["update-ref", "refs/heads/feature", &one]);
    let entry = u::new_id();
    let refs = vec![
        RefMove::new("refs/heads/stack/1", None, Some(&one)),
        RefMove::new("refs/heads/stack/2", None, Some(&two)),
        RefMove::new("refs/heads/feature", Some(&two), Some(&one)),
    ];
    u::record_group(tc, group(id, &entry, UndoAction::StackCreate, "Undo splitting “feature” into 2 pull requests", refs, None)).await.unwrap();
    (base, one, two, entry)
}

#[tokio::test]
async fn three_refs_go_back_and_forth_together() {
    let (tc, repo, id) = setup().await;
    let (_, one, two, entry) = stacked(&tc, &repo, &id).await;
    let peek = undo_peek(&tc, id.clone()).await.unwrap();
    let step = peek.undo.expect("offered");
    assert_eq!(step.label, "Undo splitting “feature” into 2 pull requests");
    assert_eq!(step.action, "stack_create");

    undo(&tc, id.clone()).await.unwrap();
    assert!(!has_ref(&repo, "refs/heads/stack/1") && !has_ref(&repo, "refs/heads/stack/2"), "the created refs are gone");
    assert_eq!(sha(&repo, "refs/heads/feature"), two, "the moved ref is back");
    assert_eq!(repo.current_branch(), "main");
    assert_eq!(sha(&repo, &u::backup_ref_name(&entry, "after-1")), two, "the commits stay reachable for redo");
    assert_eq!(repo.git(&["reflog", "-1", "--format=%gs", "refs/heads/feature"]), "forkyard: Undo");

    redo(&tc, id.clone()).await.unwrap();
    assert_eq!(sha(&repo, "refs/heads/stack/1"), one);
    assert_eq!(sha(&repo, "refs/heads/stack/2"), two);
    assert_eq!(sha(&repo, "refs/heads/feature"), one);
}

#[tokio::test]
async fn a_moved_ref_keeps_the_whole_group_in_place() {
    let (tc, repo, id) = setup().await;
    let (base, one, two, _) = stacked(&tc, &repo, &id).await;
    repo.git(&["update-ref", "refs/heads/stack/2", &base]);
    assert!(undo_peek(&tc, id.clone()).await.unwrap().undo.is_none(), "not offered once a ref moved");
    assert_eq!(undo(&tc, id.clone()).await.unwrap_err().code, ErrorCode::NothingToUndo);
    assert_eq!(sha(&repo, "refs/heads/stack/1"), one, "nothing moved");
    assert_eq!(sha(&repo, "refs/heads/feature"), one);

    // The transaction itself: one wrong expectation and no ref moves at all.
    let moves = [RefMove::new("refs/heads/stack/1", Some(&one), None), RefMove::new("refs/heads/stack/2", Some(&two), None)];
    let err = u::apply_ref_moves(&tc, &id, &moves, "test").await.unwrap_err();
    assert_eq!(err.code, ErrorCode::StaleState, "{err:?}");
    assert_eq!(sha(&repo, "refs/heads/stack/1"), one);
    let err = u::apply_ref_moves(&tc, &id, &[RefMove::new("refs/heads/stack/1", None, Some(&two))], "test").await.unwrap_err();
    assert_eq!(err.code, ErrorCode::StaleState, "create on an existing ref: {err:?}");
}

#[tokio::test]
async fn a_group_with_a_snapshot_restores_index_and_head_byte_exact() {
    let (tc, repo, id) = setup().await;
    let base = repo.head();
    let crlf: &[u8] = b"zeile 1\r\nGr\xfc\xdfe\r\nende";
    repo.write_file("a.txt", crlf);
    repo.write_file("b b.txt", "zweite Datei\n");
    repo.write_file("frei.txt", "nicht gestagt\n");
    repo.git(&["add", "a.txt", "b b.txt"]);
    let entry = u::new_id();
    let snapshot = u::snapshot_for_group(&tc, &id, &entry).await.unwrap();
    repo.git(&["commit", "-q", "-m", "Teil A", "--", "a.txt"]);
    repo.git(&["commit", "-q", "-m", "Teil B", "--", "b b.txt"]);
    let after = repo.head();
    let refs = vec![RefMove::new("refs/heads/main", Some(&base), Some(&after))];
    u::record_group(&tc, group(&id, &entry, UndoAction::Compose, "Undo creating 2 commits", refs, Some(snapshot))).await.unwrap();

    undo(&tc, id.clone()).await.unwrap();
    assert_eq!(repo.head(), base);
    assert_eq!(repo.git(&["-c", "core.quotepath=false", "diff", "--cached", "--name-only"]), "a.txt\nb b.txt", "both files staged again");
    assert_eq!(repo.git_output(&["show", ":a.txt"]).stdout, crlf, "index bytes unchanged (CRLF, Latin-1, no final newline)");
    assert_eq!(repo.read_file("a.txt"), crlf);
    assert_eq!(repo.read_file("frei.txt"), b"nicht gestagt\n", "untracked work stays");

    redo(&tc, id.clone()).await.unwrap();
    assert_eq!(repo.head(), after);
    assert_eq!(repo.git(&["diff", "--cached", "--name-only"]), "");
    assert_eq!(repo.read_file("frei.txt"), b"nicht gestagt\n");
}

#[tokio::test]
async fn group_undo_refuses_a_ref_checked_out_in_another_worktree() {
    let (tc, repo, id) = setup().await;
    let base = repo.head();
    repo.branch("side");
    repo.checkout("side");
    let moved = repo.commit_file("s.txt", "s\n", "Auf side");
    repo.checkout("main");
    let entry = u::new_id();
    u::record_group(&tc, group(&id, &entry, UndoAction::ReviewFixups, "Undo 1 fixup commit", vec![RefMove::new("refs/heads/side", Some(&base), Some(&moved))], None)).await.unwrap();
    let other = repo.temp_dir().join("anderer ort");
    repo.git(&["worktree", "add", "-q", other.to_str().unwrap(), "side"]);

    let err = undo(&tc, id.clone()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::StaleState, "{err:?}");
    assert_eq!(sha(&repo, "refs/heads/side"), moved, "the branch of the other worktree stays");
    assert_eq!(repo.git(&["-C", other.to_str().unwrap(), "status", "--porcelain"]), "", "the other worktree is untouched");
}

#[tokio::test]
async fn a_group_without_refs_swaps_the_files_and_checks_head() {
    let (tc, repo, id) = setup().await;
    repo.write_file("README.md", "lokal\n");
    let entry = u::new_id();
    let snapshot = u::snapshot_for_group(&tc, &id, &entry).await.unwrap();
    repo.write_file("README.md", "übernommen\n");
    u::record_group(&tc, group(&id, &entry, UndoAction::RangeApply, "Undo taking over ‘README.md’", Vec::new(), Some(snapshot))).await.unwrap();

    undo(&tc, id.clone()).await.unwrap();
    assert_eq!(repo.read_file("README.md"), "lokal\n".as_bytes());
    redo(&tc, id.clone()).await.unwrap();
    assert_eq!(repo.read_file("README.md"), "übernommen\n".as_bytes());
    // A new commit moves HEAD: the entry no longer fits.
    repo.commit("Weiter");
    assert!(undo_peek(&tc, id.clone()).await.unwrap().undo.is_none());
}

/// Without a snapshot the checked-out branch must take index and files along (like `reset --keep`),
/// otherwise the undone commits would reappear as uncommitted changes.
#[tokio::test]
async fn a_group_without_snapshot_moves_the_checked_out_branch_with_its_files() {
    let (tc, repo, id) = setup().await;
    let base = repo.head();
    let fixup = repo.commit_file("README.md", "fixup!\n", "fixup! Erster Commit");
    let entry = u::new_id();
    u::record_group(&tc, group(&id, &entry, UndoAction::ReviewFixups, "Undo 1 fixup commit", vec![RefMove::new("refs/heads/main", Some(&base), Some(&fixup))], None)).await.unwrap();

    repo.write_file("README.md", "lokal\n");
    assert_eq!(undo(&tc, id.clone()).await.unwrap_err().code, ErrorCode::DirtyWorktree);
    assert_eq!(repo.head(), fixup, "nothing moved");
    assert_eq!(repo.read_file("README.md"), b"lokal\n", "the own change stays");
    repo.git(&["checkout", "--", "README.md"]);

    undo(&tc, id.clone()).await.unwrap();
    assert_eq!(repo.head(), base);
    assert_eq!(repo.git(&["status", "--porcelain"]), "", "index and files follow the branch");
    assert_eq!(repo.read_file("README.md"), b"# Test\n");
    redo(&tc, id.clone()).await.unwrap();
    assert_eq!(repo.head(), fixup);
    assert_eq!(repo.read_file("README.md"), b"fixup!\n");
    assert_eq!(repo.git(&["status", "--porcelain"]), "");
}

#[tokio::test]
async fn record_group_checks_action_and_refs() {
    let (tc, repo, id) = setup().await;
    let head = repo.head();
    let bad = [
        (UndoAction::Commit, vec![RefMove::new("refs/heads/main", Some(&head), Some(&head))]),
        (UndoAction::Plan, vec![RefMove::new("refs/forkyard/undo/x/y", None, Some(&head))]),
        (UndoAction::Plan, vec![RefMove::new("refs/heads/a b", None, Some(&head))]),
        (UndoAction::Plan, vec![RefMove::new("main", None, Some(&head))]),
        (UndoAction::Plan, vec![RefMove::new("refs/heads/a", None, Some(&head)), RefMove::new("refs/heads/a", None, Some(&head))]),
    ];
    for (action, refs) in bad {
        let err = u::record_group(&tc, group(&id, &u::new_id(), action, "x", refs.clone(), None)).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed, "{action:?} {refs:?}");
    }
    assert!(undo_peek(&tc, id.clone()).await.unwrap().undo.is_none(), "nothing was recorded");
}
