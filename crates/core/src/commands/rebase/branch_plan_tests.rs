//! `rebase_branch_plan`: the range of the checked-out branch, against real temp repositories.

use super::*;
use crate::testkit::{TestCore, TestRepo};

async fn open(repo: &TestRepo) -> (TestCore, String) {
    let tc = TestCore::new().await;
    let id = tc.open(repo).await.repo.id;
    (tc, id)
}

/// Base and summaries of an `Ok` plan; panics on a refusal.
fn ok(plan: &RebasePlan) -> (String, Vec<String>) {
    match plan {
        RebasePlan::Ok { base, rows, .. } => (base.clone(), rows.iter().map(|r| r.summary.clone()).collect()),
        refused => panic!("expected a plan, got {refused:?}"),
    }
}

fn reason(plan: &RebasePlan) -> (RebaseRefusal, Option<RebaseRefusalDetail>) {
    match plan {
        RebasePlan::Refused { reason, detail, .. } => (*reason, *detail),
        plan => panic!("expected a refusal, got {plan:?}"),
    }
}

/// main: m1 (root), m2; `feature/ä` from m1: f1, f2, f3; main moves on with m3. HEAD on `feature/ä`.
/// Returns (repo, m1, f1, f2).
fn feature_fixture() -> (TestRepo, String, String, String) {
    let repo = TestRepo::new();
    let m1 = repo.commit_file("m1.txt", "m1\n", "m1");
    repo.commit_file("m2.txt", "m2\n", "m2");
    repo.branch_at("feature/ä", &m1);
    repo.checkout("feature/ä");
    let f1 = repo.commit_file("Ordner/Größe ä.txt", "f1\n", "f1 Grüße");
    let f2 = repo.commit_file("f2.txt", "f2\n", "f2");
    repo.commit_file("f3.txt", "f3\n", "f3");
    repo.checkout("main");
    repo.commit_file("m3.txt", "m3\n", "m3");
    repo.checkout("feature/ä");
    (repo, m1, f1, f2)
}

#[tokio::test]
async fn default_range_is_the_branch_since_the_default_branch() {
    let (repo, m1, _, _) = feature_fixture();
    let (tc, id) = open(&repo).await;
    let plan = rebase_branch_plan(&tc, id.clone(), None).await.unwrap();
    assert_eq!(ok(&plan), (m1.clone(), vec!["f1 Grüße".into(), "f2".into(), "f3".into()]));
}

#[tokio::test]
async fn on_the_default_branch_only_its_upstream_counts() {
    let repo = TestRepo::new();
    repo.commit_file("m1.txt", "m1\n", "m1");
    let m2 = repo.commit_file("m2.txt", "m2\n", "m2");
    let _remote = repo.add_remote();
    repo.commit_file("l1.txt", "l1\n", "l1");
    repo.commit_file("l2 ü.txt", "l2\n", "l2");
    let (tc, id) = open(&repo).await;
    assert_eq!(ok(&rebase_branch_plan(&tc, id.clone(), None).await.unwrap()), (m2.clone(), vec!["l1".into(), "l2".into()]));
    // Without an upstream there is nothing to compare with.
    repo.git(&["branch", "--unset-upstream"]);
    let plan = rebase_branch_plan(&tc, id.clone(), None).await.unwrap();
    assert_eq!(reason(&plan), (RebaseRefusal::NothingToRebase, None));
}

#[tokio::test]
async fn the_upstream_of_the_default_branch_counts_too() {
    let repo = TestRepo::new();
    let m1 = repo.commit_file("m1.txt", "m1\n", "m1");
    let _remote = repo.add_remote();
    let m2 = repo.commit_file("m2.txt", "m2\n", "m2");
    repo.git(&["push", "-q", "origin", "main"]);
    // Local main stays at m1, origin/main is at m2.
    repo.git(&["reset", "-q", "--hard", &m1]);
    repo.branch_at("feature", &m2);
    repo.checkout("feature");
    repo.commit_file("f1 ü.txt", "f1\n", "f1");
    let (tc, id) = open(&repo).await;
    let plan = rebase_branch_plan(&tc, id.clone(), None).await.unwrap();
    assert_eq!(ok(&plan), (m2.clone(), vec!["f1".to_string()]));
}

#[tokio::test]
async fn from_a_commit_includes_it_and_the_root_is_refused() {
    let (repo, m1_root, f1, f2) = feature_fixture();
    let (tc, id) = open(&repo).await;
    let plan = rebase_branch_plan(&tc, id.clone(), Some(f2.clone())).await.unwrap();
    assert_eq!(ok(&plan), (f1.clone(), vec!["f2".into(), "f3".into()]));
    let plan = rebase_branch_plan(&tc, id.clone(), Some(m1_root.clone())).await.unwrap();
    assert_eq!(reason(&plan), (RebaseRefusal::NothingToRebase, None));
}

#[tokio::test]
async fn refusals_come_before_the_range() {
    let (repo, _, f1, _) = feature_fixture();
    let (tc, id) = open(&repo).await;
    let m3 = repo.git(&["rev-parse", "main"]);

    // A commit of another branch as the start.
    let plan = rebase_branch_plan(&tc, id.clone(), Some(m3.clone())).await.unwrap();
    assert_eq!(reason(&plan), (RebaseRefusal::NoCommonAncestor, Some(RebaseRefusalDetail::NotAncestor)));

    // A merge commit inside the range.
    repo.git(&["merge", "-q", "--no-ff", "-m", "Merge main", "main"]);
    let plan = rebase_branch_plan(&tc, id.clone(), Some(f1.clone())).await.unwrap();
    assert_eq!(reason(&plan), (RebaseRefusal::MergeCommits, None));
    repo.git(&["reset", "-q", "--hard", "HEAD^"]);

    // A running cherry-pick (conflict).
    repo.commit_file("m3.txt", "anders\n", "f4");
    assert!(!repo.git_output(&["cherry-pick", &m3]).status.success());
    let plan = rebase_branch_plan(&tc, id.clone(), None).await.unwrap();
    assert_eq!(reason(&plan), (RebaseRefusal::OperationInProgress, None));
    repo.git(&["cherry-pick", "--abort"]);

    // Detached HEAD.
    repo.git(&["checkout", "-q", "--detach"]);
    let plan = rebase_branch_plan(&tc, id.clone(), None).await.unwrap();
    assert_eq!(reason(&plan), (RebaseRefusal::Detached, None));
}
