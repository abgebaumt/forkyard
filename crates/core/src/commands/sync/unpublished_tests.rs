//! A branch that is not on its remote under a name a plain push reaches – no upstream, upstream gone,
//! or an upstream of another name – reports how many of its commits are on no remote-tracking ref
//! (`unpublished`), in the refs list and in the status. 0 still means "to push" (the branch itself is
//! missing there). Oracle: `git rev-list --count` after a fetch from the real bare remote.

use super::*;
use crate::testkit::{TestCore, TestRemote, TestRepo};

struct Fixture {
    tc: TestCore,
    repo: TestRepo,
    remote: TestRemote,
    id: String,
}

async fn fixture() -> Fixture {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let remote = repo.add_remote();
    let id = tc.open(&repo).await.repo.id;
    Fixture { tc, repo, remote, id }
}

/// Git's own count of commits on `branch` that no branch of `remote` (all remotes: `None`) has – after
/// a fetch, so the remote-tracking refs are what the bare remote holds.
fn oracle(repo: &TestRepo, branch: &str, remote: Option<&str>) -> u32 {
    repo.git(&["fetch", "-q", "--all", "--prune"]);
    let not = match remote {
        Some(name) => format!("--remotes={name}"),
        None => "--remotes".to_string(),
    };
    repo.git(&["rev-list", "--count", &format!("refs/heads/{branch}"), "--not", &not]).parse().unwrap()
}

async fn in_refs(f: &Fixture, branch: &str) -> Option<u32> {
    let refs = refs::read_refs(&f.tc, &f.id).await.unwrap();
    refs.locals.iter().find(|r| r.name == branch).unwrap_or_else(|| panic!("no branch {branch}")).unpublished
}

async fn in_status(f: &Fixture) -> Option<u32> {
    status::read_status(&f.tc, &f.id).await.unwrap().unpublished
}

#[tokio::test]
async fn a_fresh_branch_with_commits_counts_them() {
    let f = fixture().await;
    f.repo.checkout_new("feature/größe");
    f.repo.commit_file("a.txt", "a\n", "A");
    f.repo.commit_file("b.txt", "b\n", "B");
    assert_eq!(oracle(&f.repo, "feature/größe", None), 2);
    assert_eq!(in_refs(&f, "feature/größe").await, Some(2));
    assert_eq!(in_status(&f).await, Some(2));
    // The published main: nothing of that kind.
    assert_eq!(in_refs(&f, "main").await, None);
    f.repo.checkout("main");
    assert_eq!(in_status(&f).await, None);
}

#[tokio::test]
async fn a_fresh_branch_without_own_commits_is_still_to_push() {
    let f = fixture().await;
    f.repo.checkout_new("leer");
    assert_eq!(oracle(&f.repo, "leer", None), 0);
    assert_eq!(in_refs(&f, "leer").await, Some(0));
    assert_eq!(in_status(&f).await, Some(0));
}

#[tokio::test]
async fn a_branch_following_another_name_counts_against_its_remote() {
    let f = fixture().await;
    f.repo.checkout_new("develop");
    f.repo.commit_file("d.txt", "d\n", "Develop");
    f.repo.git(&["push", "-q", "-u", "origin", "develop"]);
    f.repo.checkout("main");
    f.repo.git(&["checkout", "-q", "-b", "qa/blackbox", "origin/develop"]);
    f.repo.commit_file("qa.txt", "qa\n", "QA");
    assert_eq!(oracle(&f.repo, "qa/blackbox", Some("origin")), 1);
    assert_eq!(in_refs(&f, "qa/blackbox").await, Some(1));
    assert_eq!(in_status(&f).await, Some(1));

    // On another remote it is no help: what counts is origin, the remote of its upstream.
    let fork = TestRemote::new();
    f.repo.git(&["remote", "add", "fork", &fork.url()]);
    f.repo.git(&["push", "-q", "fork", "HEAD:refs/heads/qa-copy"]);
    assert_eq!(oracle(&f.repo, "qa/blackbox", Some("origin")), 1);
    assert_eq!(oracle(&f.repo, "qa/blackbox", None), 0, "the fork has it");
    assert_eq!(in_refs(&f, "qa/blackbox").await, Some(1));
    assert_eq!(in_status(&f).await, Some(1));

    // Pushed under its own name: published, no count any more.
    push(&f.tc, f.id.clone(), util::new_id(), None, Some("origin".into()), None, false, None).await.unwrap();
    assert_eq!(in_refs(&f, "qa/blackbox").await, None);
    assert_eq!(in_status(&f).await, None);
    assert_eq!(f.remote.git(&["rev-parse", "refs/heads/qa/blackbox"]), f.repo.head());
}

#[tokio::test]
async fn a_gone_upstream_counts_what_no_remote_branch_has() {
    let f = fixture().await;
    f.repo.checkout_new("kurz");
    f.repo.commit_file("k.txt", "k\n", "Kurz");
    f.repo.commit_file("k2.txt", "k2\n", "Kurz 2");
    f.repo.git(&["push", "-q", "-u", "origin", "kurz"]);
    assert_eq!(in_refs(&f, "kurz").await, None, "published");
    // Deleted on the remote (merged and removed elsewhere), pruned here.
    f.remote.git(&["update-ref", "-d", "refs/heads/kurz"]);
    assert_eq!(oracle(&f.repo, "kurz", Some("origin")), 2);
    let refs = refs::read_refs(&f.tc, &f.id).await.unwrap();
    let kurz = refs.locals.iter().find(|r| r.name == "kurz").unwrap();
    assert!(kurz.upstream_gone);
    assert_eq!(kurz.unpublished, Some(2));
    assert_eq!(in_status(&f).await, Some(2));
}

#[tokio::test]
async fn without_a_remote_nothing_is_counted() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    let refs = refs::read_refs(&tc, &id).await.unwrap();
    assert_eq!(refs.locals[0].unpublished, None);
    assert_eq!(status::read_status(&tc, &id).await.unwrap().unpublished, None);
}
