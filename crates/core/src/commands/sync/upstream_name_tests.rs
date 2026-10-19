//! A push without a named remote goes to the upstream only when it has the branch's own name,
//! when `push.default` is `upstream`/`tracking`, or when Forkyard recorded that destination itself
//! (`branch.<b>.forkyardPushToUpstream`). Otherwise – like Git's `push.default=simple` – it is
//! `no_upstream`, and nothing is sent. Oracle: the bare remote, read with Git itself.

use super::*;
use crate::commands::branches;
use crate::model::PushExtra;
use crate::testkit::{TestCore, TestRemote, TestRepo};

struct Fixture {
    tc: TestCore,
    repo: TestRepo,
    remote: TestRemote,
    id: String,
}

/// `main` and `develop` on the remote; checked out: `qa/blackbox`, created the way a terminal user
/// does it (`git checkout -b qa/blackbox origin/develop`), with one commit of its own.
async fn qa_fixture() -> Fixture {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let remote = repo.add_remote();
    repo.checkout_new("develop");
    repo.commit_file("d.txt", "d\n", "Develop");
    repo.git(&["push", "-q", "-u", "origin", "develop"]);
    repo.checkout("main");
    repo.git(&["checkout", "-q", "-b", "qa/blackbox", "origin/develop"]);
    repo.commit_file("qa.txt", "qa\n", "QA only");
    let id = tc.open(&repo).await.repo.id;
    tc.events.clear();
    Fixture { tc, repo, remote, id }
}

fn remote_sha(remote: &TestRemote, name: &str) -> Option<String> {
    let out = remote.git_output(&["rev-parse", "--verify", "-q", name]);
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn remote_branches(remote: &TestRemote) -> Vec<String> {
    remote.git(&["for-each-ref", "--format=%(refname)", "refs/heads"]).lines().map(str::to_string).collect()
}

fn marker(repo: &TestRepo, branch: &str) -> Option<String> {
    let out = repo.git_output(&["config", "--get", &format!("branch.{branch}.forkyardPushToUpstream")]);
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

async fn plain_push(f: &Fixture) -> CoreResult<PushResult> {
    push(&f.tc, f.id.clone(), util::new_id(), None, None, None, false, None).await
}

async fn push_to(f: &Fixture, remote: &str, remote_branch: Option<&str>) -> CoreResult<PushResult> {
    push(&f.tc, f.id.clone(), util::new_id(), None, Some(remote.into()), remote_branch.map(String::from), false, None).await
}

async fn pushes_to_upstream_in_refs(f: &Fixture, branch: &str) -> bool {
    let refs = refs::read_refs(&f.tc, &f.id).await.unwrap();
    refs.locals.iter().find(|r| r.name == branch).unwrap_or_else(|| panic!("no branch {branch}")).pushes_to_upstream
}

async fn pushes_to_upstream_in_status(f: &Fixture) -> bool {
    status::read_status(&f.tc, &f.id).await.unwrap().upstream.expect("upstream").pushes_to_upstream
}

#[tokio::test]
async fn plain_push_of_a_branch_following_another_name_pushes_nothing() {
    let f = qa_fixture().await;
    let develop_before = remote_sha(&f.remote, "refs/heads/develop").unwrap();
    // Git itself (push.default=simple) refuses this push too.
    assert!(!f.repo.git_output(&["push", "--dry-run"]).status.success(), "git refuses the plain push");

    let err = plain_push(&f).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NoUpstream, "{err:?}");
    assert!(err.message.contains("“qa/blackbox”") && err.message.contains("origin/develop"), "{}", err.message);
    assert_eq!(remote_sha(&f.remote, "refs/heads/develop"), Some(develop_before.clone()), "develop is untouched");
    assert_eq!(remote_branches(&f.remote), ["refs/heads/develop", "refs/heads/main"], "nothing was pushed");

    // With extra refs (one `git push` with several refspecs) the same.
    f.repo.git(&["tag", "qa-tag"]);
    let extra = vec![PushExtra { local: "refs/tags/qa-tag".into(), remote_name: None, force: false }];
    let err = push_with(&f.tc, f.id.clone(), util::new_id(), None, None, None, false, None, Some(extra), Some(true), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NoUpstream, "{err:?}");
    assert_eq!(remote_sha(&f.remote, "refs/tags/qa-tag"), None);
    assert_eq!(remote_sha(&f.remote, "refs/heads/develop"), Some(develop_before.clone()));

    // The answer of the "Push where?" dialog: an explicit remote. The branch is created there
    // under its own name and becomes the upstream.
    let result = push_to(&f, "origin", None).await.unwrap();
    assert_eq!(result, PushResult::Done { remote: "origin".into(), branch: "qa/blackbox".into(), created_upstream: true, forced: false });
    assert_eq!(remote_sha(&f.remote, "refs/heads/qa/blackbox"), Some(f.repo.head()));
    assert_eq!(remote_sha(&f.remote, "refs/heads/develop"), Some(develop_before), "develop is still untouched");
    assert_eq!(f.repo.git(&["rev-parse", "--abbrev-ref", "qa/blackbox@{upstream}"]), "origin/qa/blackbox");
    assert_eq!(marker(&f.repo, "qa/blackbox"), None, "same name: no marker");
    // From now on the plain push is enough.
    f.repo.commit_file("qa2.txt", "qa2\n", "QA 2");
    assert!(matches!(plain_push(&f).await.unwrap(), PushResult::Done { .. }));
    assert_eq!(remote_sha(&f.remote, "refs/heads/qa/blackbox"), Some(f.repo.head()));
}

#[tokio::test]
async fn push_default_upstream_or_tracking_pushes_to_the_upstream_like_git() {
    for mode in ["upstream", "tracking"] {
        let f = qa_fixture().await;
        f.repo.git(&["config", "push.default", mode]);
        // Git's own answer for the same configuration.
        let dry = f.repo.git_output(&["push", "--dry-run", "--porcelain"]);
        assert!(String::from_utf8_lossy(&dry.stdout).contains("refs/heads/qa/blackbox:refs/heads/develop"), "git pushes to develop with {mode}");

        let result = plain_push(&f).await.unwrap();
        assert_eq!(result, PushResult::Done { remote: "origin".into(), branch: "develop".into(), created_upstream: false, forced: false }, "{mode}");
        assert_eq!(remote_sha(&f.remote, "refs/heads/develop"), Some(f.repo.head()), "{mode}");
        assert_eq!(remote_sha(&f.remote, "refs/heads/qa/blackbox"), None, "{mode}");
    }
}

#[tokio::test]
async fn an_explicit_push_under_another_name_is_remembered() {
    let f = qa_fixture().await;
    let develop_before = remote_sha(&f.remote, "refs/heads/develop").unwrap();
    let result = push_to(&f, "origin", Some("qa-remote")).await.unwrap();
    assert_eq!(result, PushResult::Done { remote: "origin".into(), branch: "qa-remote".into(), created_upstream: true, forced: false });
    assert_eq!(f.repo.git(&["rev-parse", "--abbrev-ref", "qa/blackbox@{upstream}"]), "origin/qa-remote");
    assert_eq!(marker(&f.repo, "qa/blackbox").as_deref(), Some("true"));
    assert!(pushes_to_upstream_in_refs(&f, "qa/blackbox").await);
    assert!(pushes_to_upstream_in_status(&f).await);

    // The next plain push goes where the user chose.
    f.repo.commit_file("qa2.txt", "qa2\n", "QA 2");
    assert_eq!(plain_push(&f).await.unwrap(), PushResult::Done { remote: "origin".into(), branch: "qa-remote".into(), created_upstream: false, forced: false });
    assert_eq!(remote_sha(&f.remote, "refs/heads/qa-remote"), Some(f.repo.head()));
    assert_eq!(remote_sha(&f.remote, "refs/heads/develop"), Some(develop_before.clone()));

    // Pushing under its own name again drops the marker.
    push_to(&f, "origin", None).await.unwrap();
    assert_eq!(marker(&f.repo, "qa/blackbox"), None);
    assert_eq!(f.repo.git(&["rev-parse", "--abbrev-ref", "qa/blackbox@{upstream}"]), "origin/qa/blackbox");

    // Pointing the upstream elsewhere by hand never makes it a push destination.
    push_to(&f, "origin", Some("qa-remote")).await.unwrap();
    assert_eq!(marker(&f.repo, "qa/blackbox").as_deref(), Some("true"));
    branches::branch_set_upstream(&f.tc, f.id.clone(), "qa/blackbox".into(), Some("origin/develop".into())).await.unwrap();
    assert_eq!(marker(&f.repo, "qa/blackbox"), None);
    assert_eq!(plain_push(&f).await.unwrap_err().code, ErrorCode::NoUpstream);
    assert_eq!(remote_sha(&f.remote, "refs/heads/develop"), Some(develop_before));
}

#[tokio::test]
async fn status_and_refs_report_where_a_plain_push_goes() {
    let f = qa_fixture().await;
    assert!(pushes_to_upstream_in_refs(&f, "main").await, "same name");
    assert!(pushes_to_upstream_in_refs(&f, "develop").await, "same name");
    assert!(!pushes_to_upstream_in_refs(&f, "qa/blackbox").await, "follows develop");
    assert!(!pushes_to_upstream_in_status(&f).await, "follows develop");

    f.repo.git(&["config", "push.default", "upstream"]);
    assert!(pushes_to_upstream_in_refs(&f, "qa/blackbox").await);
    assert!(pushes_to_upstream_in_status(&f).await);
    f.repo.git(&["config", "push.default", "simple"]);
    assert!(!pushes_to_upstream_in_status(&f).await);
    f.repo.git(&["config", "branch.qa/blackbox.forkyardPushToUpstream", "yes"]);
    assert!(pushes_to_upstream_in_refs(&f, "qa/blackbox").await);
    assert!(pushes_to_upstream_in_status(&f).await);
    f.repo.git(&["config", "branch.qa/blackbox.forkyardPushToUpstream", "false"]);
    assert!(!pushes_to_upstream_in_refs(&f, "qa/blackbox").await);
    assert!(!pushes_to_upstream_in_status(&f).await);

    // A remote name with a slash: "team/fork/c" is remote "team/fork" + branch "c".
    let url = f.remote.url();
    f.repo.git(&["remote", "add", "team/fork", &url]);
    f.repo.git(&["push", "-q", "team/fork", "HEAD:refs/heads/c"]);
    f.repo.git(&["fetch", "-q", "team/fork"]);
    f.repo.git(&["branch", "-q", "--track", "c", "team/fork/c"]);
    f.repo.git(&["branch", "-q", "--track", "fork/c", "team/fork/c"]);
    // Oracle: Git's own reading of the upstreams.
    assert_eq!(f.repo.git(&["rev-parse", "--symbolic-full-name", "c@{upstream}"]), "refs/remotes/team/fork/c");
    assert_eq!(f.repo.git(&["config", "branch.fork/c.merge"]), "refs/heads/c");
    assert!(pushes_to_upstream_in_refs(&f, "c").await, "remote team/fork, branch c");
    // "team/fork/c" ends with "/fork/c", but the branch there is "c".
    assert!(!pushes_to_upstream_in_refs(&f, "fork/c").await, "fork/c follows c");
    f.repo.checkout("fork/c");
    assert_eq!(status::read_status(&f.tc, &f.id).await.unwrap().upstream.unwrap().name, "team/fork/c");
    assert!(!pushes_to_upstream_in_status(&f).await, "fork/c follows c");
    assert_eq!(plain_push(&f).await.unwrap_err().code, ErrorCode::NoUpstream);
    f.repo.checkout("c");
    assert!(pushes_to_upstream_in_status(&f).await, "c on team/fork");

    // Ends with "/c" but is another branch: "c" following origin's "b/c".
    f.repo.git(&["push", "-q", "origin", "HEAD:refs/heads/b/c"]);
    f.repo.git(&["fetch", "-q", "origin"]);
    f.repo.git(&["branch", "-q", "--set-upstream-to=origin/b/c", "c"]);
    assert_eq!(f.repo.git(&["rev-parse", "--symbolic-full-name", "c@{upstream}"]), "refs/remotes/origin/b/c");
    assert!(!pushes_to_upstream_in_status(&f).await, "c follows b/c");
    assert!(!pushes_to_upstream_in_refs(&f, "c").await, "c follows b/c");
    f.repo.commit_file("c.txt", "c\n", "C");
    let before = remote_sha(&f.remote, "refs/heads/b/c");
    assert_eq!(plain_push(&f).await.unwrap_err().code, ErrorCode::NoUpstream);
    assert_eq!(remote_sha(&f.remote, "refs/heads/b/c"), before, "b/c is untouched");
}
