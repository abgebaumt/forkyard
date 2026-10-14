//! Push with several refs against a local bare remote: atomic with a rejected ref, without
//! `--atomic`, tags under another name, force per ref with lease, invalid input.

use super::*;
use crate::model::{PushExtra, PushRefStatus};
use crate::testkit::{TestCore, TestRemote, TestRepo};

struct Fixture {
    tc: TestCore,
    repo: TestRepo,
    remote: TestRemote,
    id: String,
}

/// Repository with one commit, pushed as `origin/main` (upstream) and opened in the core.
async fn fixture() -> Fixture {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let remote = repo.add_remote();
    let id = tc.open(&repo).await.repo.id;
    tc.events.clear();
    Fixture { tc, repo, remote, id }
}

fn remote_sha(remote: &TestRemote, name: &str) -> Option<String> {
    let out = remote.git_output(&["rev-parse", "--verify", "-q", name]);
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn extra(local: &str) -> PushExtra {
    PushExtra { local: local.into(), remote_name: None, force: false }
}

async fn push_refs(f: &Fixture, extra: Vec<PushExtra>, atomic: bool) -> CoreResult<PushResult> {
    push_with(&f.tc, f.id.clone(), util::new_id(), None, None, None, false, None, Some(extra), Some(atomic)).await
}

fn statuses(result: &PushResult) -> Vec<(String, PushRefStatus)> {
    let PushResult::Multi { refs, .. } = result else { panic!("expected multi, got {result:?}") };
    refs.iter().map(|r| (r.remote_ref.clone(), r.status)).collect()
}

/// `feature` exists on the remote and has moved on there; the local `feature` has its own commit,
/// so pushing it is rejected (non-fast-forward). HEAD back on `main` with one new commit and tag v1.
fn diverged_feature(f: &Fixture) {
    f.repo.checkout_new("feature");
    f.repo.commit_file("f.txt", "f\n", "Feature");
    f.repo.git(&["push", "-q", "-u", "origin", "feature"]);
    let other = TestRepo::clone_of(&f.remote);
    other.git(&["checkout", "-q", "feature"]);
    other.commit_file("f.txt", "anderswo\n", "Anderswo");
    other.git(&["push", "-q", "origin", "feature"]);
    f.repo.commit_file("f.txt", "hier\n", "Hier");
    f.repo.git(&["fetch", "-q", "origin"]);
    f.repo.checkout("main");
    f.repo.commit_file("m.txt", "m\n", "Main neu");
    f.repo.tag("v1");
}

#[tokio::test]
async fn atomic_push_with_a_rejected_ref_changes_nothing_on_the_remote() {
    let f = fixture().await;
    diverged_feature(&f);
    let main_before = remote_sha(&f.remote, "refs/heads/main");

    let result = push_refs(&f, vec![extra("refs/heads/feature"), extra("refs/tags/v1")], true).await.unwrap();
    let PushResult::Multi { remote, atomic, refs } = &result else { panic!("{result:?}") };
    assert_eq!((remote.as_str(), *atomic), ("origin", true));
    assert_eq!(
        statuses(&result),
        [
            ("refs/heads/main".to_string(), PushRefStatus::Rejected),
            ("refs/heads/feature".to_string(), PushRefStatus::Rejected),
            ("refs/tags/v1".to_string(), PushRefStatus::Rejected),
        ]
    );
    assert_eq!(refs[1].reason.as_deref(), Some("non-fast-forward"));
    assert_eq!(refs[0].reason.as_deref(), Some("atomic push failed"));
    assert_eq!(remote_sha(&f.remote, "refs/heads/main"), main_before, "nothing reached the remote");
    assert_eq!(remote_sha(&f.remote, "refs/tags/v1"), None);
}

#[tokio::test]
async fn without_atomic_the_other_refs_go_through_and_force_uses_a_lease() {
    let f = fixture().await;
    diverged_feature(&f);

    let result = push_refs(&f, vec![extra("refs/heads/feature"), extra("refs/tags/v1")], false).await.unwrap();
    assert_eq!(
        statuses(&result),
        [
            ("refs/heads/main".to_string(), PushRefStatus::Ok),
            ("refs/heads/feature".to_string(), PushRefStatus::Rejected),
            ("refs/tags/v1".to_string(), PushRefStatus::Ok),
        ]
    );
    assert_eq!(remote_sha(&f.remote, "refs/heads/main"), Some(f.repo.head()));
    assert!(remote_sha(&f.remote, "refs/tags/v1").is_some());

    // Forced branch (lease against origin/feature, which the fetch knows) and a tag under another name.
    f.repo.tag("v2");
    let forced = vec![
        PushExtra { local: "refs/heads/feature".into(), remote_name: None, force: true },
        PushExtra { local: "refs/tags/v2".into(), remote_name: Some("release-2".into()), force: false },
    ];
    let result = push_refs(&f, forced, true).await.unwrap();
    let PushResult::Multi { refs, .. } = &result else { panic!("{result:?}") };
    assert_eq!(
        statuses(&result),
        [
            ("refs/heads/main".to_string(), PushRefStatus::UpToDate),
            ("refs/heads/feature".to_string(), PushRefStatus::Ok),
            ("refs/tags/release-2".to_string(), PushRefStatus::Ok),
        ]
    );
    assert!(refs[1].forced);
    assert_eq!(remote_sha(&f.remote, "refs/heads/feature"), Some(f.repo.git(&["rev-parse", "feature"])));
    assert!(remote_sha(&f.remote, "refs/tags/release-2").is_some());
}

#[tokio::test]
async fn invalid_extra_refs_are_refused_before_anything_is_sent() {
    let f = fixture().await;
    f.repo.tag("v1");
    let code = |result: CoreResult<PushResult>| result.expect_err("expected an error").code;
    assert_eq!(code(push_refs(&f, vec![extra("feature")], true).await), ErrorCode::InvalidName);
    assert_eq!(code(push_refs(&f, vec![extra("refs/heads/-x")], true).await), ErrorCode::InvalidName);
    assert_eq!(code(push_refs(&f, vec![extra("refs/heads/gibt-es-nicht")], true).await), ErrorCode::NotFound);
    assert_eq!(code(push_refs(&f, vec![PushExtra { local: "refs/tags/v1".into(), remote_name: None, force: true }], true).await), ErrorCode::NotAllowed);
    assert_eq!(code(push_refs(&f, vec![extra("refs/heads/main")], true).await), ErrorCode::NotAllowed, "the same remote ref twice");
    assert_eq!(remote_sha(&f.remote, "refs/tags/v1"), None);
}
