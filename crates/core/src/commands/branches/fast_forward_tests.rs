//! Tests for `branch_fast_forward` against real repositories with a remote.

use serde_json::json;

use super::*;
use crate::commands::undo::{redo, undo, undo_peek};
use crate::events::names;
use crate::testkit::{TestCore, TestRemote, TestRepo};

/// Repository on the branch `arbeit`; `main` follows `origin/main` and is `behind` commits behind.
fn repo_behind(behind: usize) -> (TestRepo, TestRemote, String, String) {
    let repo = TestRepo::with_commit();
    let remote = repo.add_remote();
    let old = repo.head();
    let other = TestRepo::clone_of(&remote);
    let mut new = old.clone();
    for n in 0..behind {
        new = other.commit_file(&format!("neu-{n}.txt"), "x\n", &format!("Im Klon {n}"));
    }
    if behind > 0 {
        other.git(&["push", "-q", "origin", "main"]);
    }
    repo.checkout_new("arbeit");
    repo.git(&["fetch", "-q", "origin"]);
    (repo, remote, old, new)
}

#[tokio::test]
async fn moves_only_the_ref_and_can_be_undone() {
    let tc = TestCore::new().await;
    let (repo, _remote, old, new) = repo_behind(2);
    // Local work that must not be touched.
    repo.write_file("README.md", "# Geändert\n");
    repo.write_file("unverfolgt.txt", "u\n");
    let id = tc.open(&repo).await.repo.id;
    tc.events.clear();

    let result = branch_fast_forward(&tc, id.clone(), "main".into()).await.unwrap();
    let OpResult::Done { sha, fast_forward, summary } = result else { panic!("{result:?}") };
    assert_eq!(sha.as_deref(), Some(new.as_str()));
    assert!(fast_forward);
    assert_eq!(summary, "Fast-forwarded main to origin/main (2 commits)");
    assert_eq!(repo.git(&["rev-parse", "main"]), new);
    assert_eq!(repo.current_branch(), "arbeit", "HEAD stays");
    assert_eq!(repo.read_file("README.md"), b"# Ge\xC3\xA4ndert\n");
    assert_eq!(repo.read_file("unverfolgt.txt"), b"u\n");
    assert!(!repo.path().join("neu-0.txt").exists(), "the working directory belongs to the other branch");
    assert_eq!(tc.events.named(names::REPO_CHANGED)[0]["what"], json!(["refs"]));
    assert!(repo.git(&["reflog", "show", "main", "-1"]).contains("fast-forward to origin/main"));

    let state = undo_peek(&tc, id.clone()).await.unwrap();
    assert_eq!(state.undo.unwrap().label, "Undo fast-forward of ‘main’ to origin/main");

    // Undo despite local changes: the branch is not checked out.
    let state = undo(&tc, id.clone()).await.unwrap();
    assert_eq!(repo.git(&["rev-parse", "main"]), old);
    assert_eq!(repo.read_file("README.md"), b"# Ge\xC3\xA4ndert\n");
    assert_eq!(state.redo.unwrap().label, "Redo fast-forward of ‘main’ to origin/main");
    redo(&tc, id.clone()).await.unwrap();
    assert_eq!(repo.git(&["rev-parse", "main"]), new);

    // Second call: nothing left to do, no further undo step.
    let before: i64 = tc.db.with(|c| Ok(c.query_row("select count(*) from undo_entries", [], |r| r.get(0))?)).unwrap();
    assert_eq!(branch_fast_forward(&tc, id.clone(), "refs/heads/main".into()).await.unwrap(), OpResult::UpToDate);
    let after: i64 = tc.db.with(|c| Ok(c.query_row("select count(*) from undo_entries", [], |r| r.get(0))?)).unwrap();
    assert_eq!(before, after);
}

#[tokio::test]
async fn undo_still_works_after_switching_branches() {
    let tc = TestCore::new().await;
    let (repo, _remote, old, new) = repo_behind(1);
    let id = tc.open(&repo).await.repo.id;
    branch_fast_forward(&tc, id.clone(), "main".into()).await.unwrap();
    // The branch itself is now checked out: undo resets it together with the working directory.
    branch_checkout(&tc, id.clone(), "main".into()).await.unwrap();
    assert!(repo.path().join("neu-0.txt").exists());
    // The checkout is on top; first it, then the fast-forward.
    undo(&tc, id.clone()).await.unwrap();
    assert_eq!(repo.current_branch(), "arbeit");
    undo(&tc, id.clone()).await.unwrap();
    assert_eq!(repo.git(&["rev-parse", "main"]), old);
    assert_ne!(old, new);
}

#[tokio::test]
async fn ahead_only_is_up_to_date_and_own_commits_are_refused() {
    let tc = TestCore::new().await;
    let (repo, _remote, _old, new) = repo_behind(1);
    // `voraus` follows origin/main and only has its own commits on top.
    repo.git(&["branch", "--track", "voraus", "origin/main"]);
    repo.checkout("voraus");
    let ahead = repo.commit_file("eigen.txt", "e\n", "Eigener Commit");
    // `main` gets a commit of its own: diverged.
    repo.checkout("main");
    let diverged = repo.commit_file("lokal.txt", "l\n", "Lokaler Commit");
    repo.checkout("arbeit");
    let id = tc.open(&repo).await.repo.id;

    assert_eq!(branch_fast_forward(&tc, id.clone(), "voraus".into()).await.unwrap(), OpResult::UpToDate);
    assert_eq!(repo.git(&["rev-parse", "voraus"]), ahead);

    let err = branch_fast_forward(&tc, id.clone(), "main".into()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    assert!(err.message.contains("“main”") && err.message.contains("a commit of its own"), "{}", err.message);
    assert!(err.message.contains("origin/main"), "{}", err.message);
    assert_eq!(repo.git(&["rev-parse", "main"]), diverged, "nothing changed");
    assert_ne!(diverged, new);
    assert!(undo_peek(&tc, id).await.unwrap().undo.is_none());
}

#[tokio::test]
async fn refuses_without_upstream_checked_out_or_missing() {
    let tc = TestCore::new().await;
    let (repo, _remote, _old, _new) = repo_behind(1);
    repo.branch("ohne");
    repo.git(&["branch", "--track", "verwaist", "origin/main"]);
    let id = tc.open(&repo).await.repo.id;

    let err = branch_fast_forward(&tc, id.clone(), "ohne".into()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NoUpstream);
    assert!(err.message.contains("“ohne”"), "{}", err.message);

    let err = branch_fast_forward(&tc, id.clone(), "arbeit".into()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    assert!(err.message.contains("checked out") && err.message.contains("Pull"), "{}", err.message);

    let err = branch_fast_forward(&tc, id.clone(), "gibt-es-nicht".into()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);

    // Upstream set, but the remote branch is gone.
    repo.git(&["update-ref", "-d", "refs/remotes/origin/main"]);
    let err = branch_fast_forward(&tc, id.clone(), "verwaist".into()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NoUpstream);
    assert!(err.message.contains("origin/main"), "{}", err.message);
}

#[tokio::test]
async fn refuses_a_branch_checked_out_in_another_worktree() {
    let tc = TestCore::new().await;
    let (repo, _remote, old, _new) = repo_behind(1);
    let other = repo.temp_dir().join("zweiter");
    repo.git(&["worktree", "add", "-q", &other.to_string_lossy(), "main"]);
    let id = tc.open(&repo).await.repo.id;

    let err = branch_fast_forward(&tc, id.clone(), "main".into()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    assert!(err.message.contains("worktree") && err.message.contains("zweiter"), "{}", err.message);
    assert_eq!(repo.git(&["rev-parse", "main"]), old);
}

#[tokio::test]
async fn follows_a_local_upstream_too() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    repo.git(&["branch", "--track", "folgt", "main"]);
    let new = repo.commit_file("a.txt", "a\n", "Weiter auf main");
    let id = tc.open(&repo).await.repo.id;
    let result = branch_fast_forward(&tc, id, "folgt".into()).await.unwrap();
    assert!(matches!(result, OpResult::Done { fast_forward: true, .. }), "{result:?}");
    assert_eq!(repo.git(&["rev-parse", "folgt"]), new);
}
