//! Write commands in a repository whose index timestamps do not match the working directory –
//! as after copying or restoring a repository, or when a tool merely touches files. The
//! content is unchanged; no command may fail because of it.

use std::time::{Duration, SystemTime};

use crate::commands::branches::branch_checkout;
use crate::commands::merge::{merge_start, operation_abort, reset_branch, revert_commit};
use crate::commands::rebase::{cherry_pick, rebase_apply, rebase_plan, rebase_start, squash_commits};
use crate::commands::stash::{stash_apply, stash_create, stash_pop};
use crate::commands::status::read_status;
use crate::commands::sync::pull;
use crate::commands::undo::{redo, undo};
use crate::model::{MergeMode, OpResult, RebaseAction, RebasePlan, ResetMode};
use crate::testkit::{TestCore, TestRepo};

/// Gives every tracked file a different timestamp without changing its content.
fn make_stale(repo: &TestRepo) {
    let when = SystemTime::now() - Duration::from_secs(3 * 3600);
    for rel in repo.git(&["ls-files"]).lines() {
        let path = repo.path().join(rel);
        if let Ok(file) = std::fs::File::options().write(true).open(&path) {
            file.set_modified(when).unwrap();
        }
    }
}

async fn open(repo: &TestRepo) -> (TestCore, String) {
    let tc = TestCore::new().await;
    let id = tc.open(repo).await.repo.id;
    (tc, id)
}

fn done(result: &OpResult) -> bool {
    matches!(result, OpResult::Done { .. })
}

fn conflict(result: &OpResult) -> bool {
    matches!(result, OpResult::Conflict { .. })
}

/// main: README + a.txt ("main"), feature: a.txt ("feature") + b.txt, sauber: only c.txt.
fn branches() -> TestRepo {
    let repo = TestRepo::with_commit();
    repo.commit_file("a.txt", "basis\n", "Basis");
    repo.checkout_new("feature");
    repo.commit_file("a.txt", "feature\n", "Feature a");
    repo.commit_file("b.txt", "neu\n", "Feature b");
    repo.checkout("main");
    repo.checkout_new("sauber");
    repo.commit_file("c.txt", "c\n", "Sauber c");
    repo.checkout("main");
    repo.commit_file("a.txt", "main\n", "Main a");
    repo
}

async fn clean(tc: &TestCore, id: &str) {
    let status = read_status(tc, id).await.unwrap();
    assert!(status.unstaged.is_empty() && status.staged.is_empty() && status.conflicted.is_empty() && status.operation.is_none(), "{status:?}");
}

#[tokio::test]
async fn merge_and_its_abort() {
    let repo = branches();
    let (tc, id) = open(&repo).await;
    make_stale(&repo);
    assert!(done(&merge_start(&tc, id.clone(), "sauber".into(), MergeMode::NoFf).await.unwrap()));
    make_stale(&repo);
    undo(&tc, id.clone()).await.unwrap();
    make_stale(&repo);
    redo(&tc, id.clone()).await.unwrap();
    make_stale(&repo);
    assert!(conflict(&merge_start(&tc, id.clone(), "feature".into(), MergeMode::Default).await.unwrap()));
    make_stale(&repo);
    operation_abort(&tc, id.clone()).await.unwrap();
    clean(&tc, &id).await;
    // Fast-forward and squash.
    repo.checkout("sauber");
    make_stale(&repo);
    assert!(done(&merge_start(&tc, id.clone(), "main".into(), MergeMode::FfOnly).await.unwrap()));
    repo.git(&["reset", "-q", "--hard", "HEAD~2"]);
    make_stale(&repo);
    assert!(done(&merge_start(&tc, id.clone(), "main".into(), MergeMode::Squash).await.unwrap()));
    make_stale(&repo);
    undo(&tc, id.clone()).await.unwrap();
    clean(&tc, &id).await;
}

#[tokio::test]
async fn rebase_and_its_abort() {
    let repo = branches();
    repo.checkout("sauber");
    let (tc, id) = open(&repo).await;
    make_stale(&repo);
    assert!(done(&rebase_start(&tc, id.clone(), "main".into(), None).await.unwrap()));
    make_stale(&repo);
    undo(&tc, id.clone()).await.unwrap();
    repo.checkout("feature");
    make_stale(&repo);
    assert!(conflict(&rebase_start(&tc, id.clone(), "main".into(), None).await.unwrap()));
    make_stale(&repo);
    operation_abort(&tc, id.clone()).await.unwrap();
    clean(&tc, &id).await;
}

#[tokio::test]
async fn interactive_rebase_and_squash() {
    let repo = TestRepo::with_commit();
    let base = repo.head();
    let one = repo.commit_file("a.txt", "1\n", "Eins");
    let two = repo.commit_file("b.txt", "2\n", "Zwei");
    repo.commit_file("c.txt", "3\n", "Drei");
    let (tc, id) = open(&repo).await;
    make_stale(&repo);
    assert!(done(&squash_commits(&tc, id.clone(), vec![one, two], "Eins und zwei".into()).await.unwrap()));
    make_stale(&repo);
    undo(&tc, id.clone()).await.unwrap();
    make_stale(&repo);
    let RebasePlan::Ok { mut rows, .. } = rebase_plan(&tc, id.clone(), base.clone()).await.unwrap() else { panic!("expected a plan") };
    rows[1].action = RebaseAction::Drop;
    assert!(done(&rebase_apply(&tc, id.clone(), base, rows).await.unwrap()));
    assert!(!repo.path().join("b.txt").exists());
    clean(&tc, &id).await;
}

#[tokio::test]
async fn cherry_pick_revert_and_their_aborts() {
    let repo = branches();
    let feature_a = repo.git(&["rev-parse", "feature~1"]);
    let clean_c = repo.git(&["rev-parse", "sauber"]);
    let main_a = repo.head();
    let (tc, id) = open(&repo).await;
    make_stale(&repo);
    assert!(done(&cherry_pick(&tc, id.clone(), vec![clean_c.clone()]).await.unwrap()));
    make_stale(&repo);
    undo(&tc, id.clone()).await.unwrap();
    make_stale(&repo);
    assert!(conflict(&cherry_pick(&tc, id.clone(), vec![clean_c, feature_a]).await.unwrap()));
    make_stale(&repo);
    operation_abort(&tc, id.clone()).await.unwrap();
    clean(&tc, &id).await;
    assert_eq!(repo.head(), main_a);

    make_stale(&repo);
    assert!(done(&revert_commit(&tc, id.clone(), main_a.clone()).await.unwrap()));
    make_stale(&repo);
    undo(&tc, id.clone()).await.unwrap();
    // Revert with a conflict: change the file further first, then revert the older commit.
    repo.commit_file("a.txt", "main\nweiter\n", "Main a weiter");
    make_stale(&repo);
    assert!(conflict(&revert_commit(&tc, id.clone(), main_a).await.unwrap()));
    make_stale(&repo);
    operation_abort(&tc, id.clone()).await.unwrap();
    clean(&tc, &id).await;
}

#[tokio::test]
async fn reset_checkout_and_stash() {
    let repo = branches();
    let before = repo.git(&["rev-parse", "HEAD~1"]);
    let (tc, id) = open(&repo).await;
    for mode in [ResetMode::Soft, ResetMode::Mixed, ResetMode::Hard] {
        make_stale(&repo);
        reset_branch(&tc, id.clone(), before.clone(), mode).await.unwrap();
        make_stale(&repo);
        undo(&tc, id.clone()).await.unwrap();
        clean(&tc, &id).await;
    }
    make_stale(&repo);
    branch_checkout(&tc, id.clone(), "feature".into()).await.unwrap();
    make_stale(&repo);
    undo(&tc, id.clone()).await.unwrap();
    assert_eq!(repo.current_branch(), "main");

    repo.write_file("a.txt", "main\nlokal\n");
    repo.write_file("unverfolgt.txt", "u\n");
    make_stale(&repo);
    assert_eq!(stash_create(&tc, id.clone(), "op-1".into(), Some("Test".into()), None, true, None).await.unwrap().len(), 1);
    clean(&tc, &id).await;
    make_stale(&repo);
    assert!(done(&stash_apply(&tc, id.clone(), 0).await.unwrap()));
    repo.git(&["checkout", "-q", "--", "a.txt"]);
    repo.remove_file("unverfolgt.txt");
    make_stale(&repo);
    assert!(done(&stash_pop(&tc, id.clone(), 0).await.unwrap()));
    assert_eq!(repo.read_file("a.txt"), b"main\nlokal\n");
}

#[tokio::test]
async fn pull_in_all_modes() {
    for mode in [crate::model::PullMode::Ff, crate::model::PullMode::FfOnly, crate::model::PullMode::Rebase] {
        let repo = TestRepo::with_commit();
        let remote = repo.add_remote();
        let other = TestRepo::clone_of(&remote);
        other.commit_file("fern.txt", "f\n", "Vom Remote");
        other.git(&["push", "-q", "origin", "main"]);
        if mode != crate::model::PullMode::FfOnly {
            repo.commit_file("lokal.txt", "l\n", "Lokal");
        }
        let (tc, id) = open(&repo).await;
        make_stale(&repo);
        let result = pull(&tc, id.clone(), format!("job-{mode:?}"), Some(mode)).await.unwrap();
        assert!(done(&result), "{mode:?}: {result:?}");
        assert!(repo.path().join("fern.txt").exists());
        make_stale(&repo);
        undo(&tc, id.clone()).await.unwrap();
        assert!(!repo.path().join("fern.txt").exists(), "{mode:?}");
        clean(&tc, &id).await;
    }
}
