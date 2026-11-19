//! The list command against real repositories, without a host (PR data: see `host/tests/branch_cleanup_tests.rs`).

use super::*;
use crate::commands::settings::repo_settings_set;
use crate::model::{BranchCleanupClass, BranchCleanupClass::*, BranchCleanupReason, BranchCleanupReason::*};
use crate::testkit::{TestCore, TestRemote, TestRepo, BASE_TIME};

const DAY: i64 = 86_400;
const NOW: i64 = BASE_TIME + 30 * DAY;

type Row<'a> = (&'a str, BranchCleanupClass, Vec<BranchCleanupReason>);

fn classes(list: &BranchCleanupList) -> Vec<Row<'_>> {
    list.candidates.iter().map(|c| (c.name.as_str(), c.class, c.reasons.clone())).collect()
}

/// A branch off `main` with one commit; back on `main` afterwards.
fn branch_with_commit(repo: &TestRepo, name: &str) -> String {
    repo.checkout_new(name);
    let sha = repo.commit_file(&format!("{}.txt", name.replace('/', "-")), "x\n", name);
    repo.checkout("main");
    sha
}

/// Like `branch_with_commit`, then merged into `main` with a merge commit.
fn merged_branch(repo: &TestRepo, name: &str) {
    branch_with_commit(repo, name);
    repo.git(&["merge", "-q", "--no-ff", "--no-edit", name]);
}

#[tokio::test]
async fn candidates_are_classified_from_git_alone() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let remote = TestRemote::new();
    repo.git(&["remote", "add", "origin", &remote.url()]);
    merged_branch(&repo, "fertig");
    branch_with_commit(&repo, "verwaist");
    repo.git(&["config", "branch.verwaist.remote", "origin"]);
    repo.git(&["config", "branch.verwaist.merge", "refs/heads/verwaist"]);
    repo.checkout_new("alt");
    let old = format!("@{} +0000", BASE_TIME - 100 * DAY);
    repo.write_file("alt.txt", "alt\n");
    repo.commit_as("Alt", "Test Person", "test@example.com", &old);
    repo.checkout("main");
    merged_branch(&repo, "in-arbeit");
    let linked = repo.temp_dir().join("in-arbeit-wt");
    repo.git(&["worktree", "add", "-q", linked.to_str().unwrap(), "in-arbeit"]);
    merged_branch(&repo, "release/2026.1");
    branch_with_commit(&repo, "aktiv");
    merged_branch(&repo, "team/übung");
    repo.git(&["update-ref", "refs/remotes/origin/main", "main"]);
    let id = tc.open(&repo).await.repo.id;
    repo_settings_set(&tc, id.clone(), serde_json::json!({ "protectedBranchPatterns": ["team/*"] })).await.unwrap();

    let list = candidates_at(&tc, &id, NOW).await.unwrap();
    assert_eq!(list.default_branch.as_deref(), Some("main"));
    assert_eq!(list.pr_data_missing, None, "no host remote: nothing is missing");
    assert_eq!(
        classes(&list),
        vec![
            ("alt", Review, vec![Stale, Unmerged { count: 1 }, Unpushed { count: 1 }]),
            ("fertig", Safe, vec![Merged]),
            ("in-arbeit", Blocked, vec![Merged, Worktree]),
            ("release/2026.1", Blocked, vec![Merged, Protected]),
            ("team/übung", Blocked, vec![Merged, Protected]),
            ("verwaist", Review, vec![UpstreamGone, Unmerged { count: 1 }, Unpushed { count: 1 }]),
        ],
        "aktiv and main are not listed; sorted by name"
    );
    let fertig = list.candidates.iter().find(|c| c.name == "fertig").unwrap();
    assert_eq!(fertig.sha, repo.git(&["rev-parse", "fertig"]));
    let committed: i64 = repo.git(&["log", "-1", "--format=%ct", "fertig"]).parse().unwrap();
    assert_eq!(fertig.committed_at, util::unix_to_iso(committed));
    assert_eq!((fertig.upstream_remote.as_deref(), fertig.upstream_branch.as_deref()), (None, None));
    let verwaist = list.candidates.iter().find(|c| c.name == "verwaist").unwrap();
    assert_eq!(verwaist.upstream_remote, None, "a gone upstream is no remote option");
}

#[tokio::test]
async fn the_default_branch_follows_the_remote_head() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let remote = TestRemote::new();
    repo.git(&["remote", "add", "origin", &remote.url()]);
    repo.checkout_new("develop");
    repo.commit_file("d.txt", "d\n", "Entwicklung");
    // Current branch, merged into develop: would be safe, but HEAD is never listed.
    merged_into(&repo, "aktuell", "develop");
    repo.git(&["update-ref", "refs/remotes/origin/develop", "develop"]);
    repo.git(&["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"]);
    repo.checkout("aktuell");
    let id = tc.open(&repo).await.repo.id;

    let list = candidates_at(&tc, &id, NOW).await.unwrap();
    assert_eq!(list.default_branch.as_deref(), Some("develop"));
    assert_eq!(
        classes(&list),
        vec![("main", Blocked, vec![Merged, Protected])],
        "develop (default, merged into itself) and aktuell (checked out) are not listed; main only by its own reasons"
    );
}

/// A branch off `target` with one commit, merged into `target` with a merge commit; `target` stays checked out.
fn merged_into(repo: &TestRepo, name: &str, target: &str) {
    repo.checkout_new(name);
    repo.commit_file(&format!("{name}.txt"), "x\n", name);
    repo.checkout(target);
    repo.git(&["merge", "-q", "--no-ff", "--no-edit", name]);
}

#[tokio::test]
async fn without_a_remote_head_main_then_master_then_the_current_branch_is_the_default() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    let locals = |names: &[&str], head: &str| -> Vec<Ref> {
        names.iter().map(|n| Ref { name: n.to_string(), is_head: *n == head, ..ref_stub() }).collect()
    };
    assert_eq!(default_branch(&tc, &id, &locals(&["a", "master", "main"], "a")).await.as_deref(), Some("main"));
    assert_eq!(default_branch(&tc, &id, &locals(&["a", "master"], "a")).await.as_deref(), Some("master"));
    assert_eq!(default_branch(&tc, &id, &locals(&["a", "b"], "b")).await.as_deref(), Some("b"));
    assert_eq!(default_branch(&tc, &id, &[]).await, None);
}

fn ref_stub() -> Ref {
    Ref {
        name: String::new(),
        full_name: String::new(),
        kind: crate::model::RefKind::Local,
        sha: String::new(),
        is_head: false,
        upstream: None,
        upstream_gone: false,
        pushes_to_upstream: false,
        unpublished: None,
        ahead: 0,
        behind: 0,
        remote: None,
        annotation: None,
        is_annotated: false,
        worktree_path: None,
    }
}

#[tokio::test]
async fn an_upstream_that_exists_is_reported_for_the_remote_option() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let _remote = repo.add_remote();
    repo.checkout_new("geteilt");
    repo.commit_file("g.txt", "g\n", "Geteilt");
    repo.git(&["push", "-q", "-u", "origin", "geteilt"]);
    repo.checkout("main");
    repo.git(&["merge", "-q", "--no-ff", "--no-edit", "geteilt"]);
    let id = tc.open(&repo).await.repo.id;

    let list = candidates_at(&tc, &id, NOW).await.unwrap();
    let geteilt = list.candidates.iter().find(|c| c.name == "geteilt").unwrap();
    assert_eq!((geteilt.class, geteilt.reasons.clone()), (Safe, vec![Merged]));
    assert_eq!((geteilt.upstream_remote.as_deref(), geteilt.upstream_branch.as_deref()), (Some("origin"), Some("geteilt")));
}

#[tokio::test]
async fn a_merge_only_in_the_upstream_of_the_default_branch_counts_as_merged() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let _remote = repo.add_remote();
    branch_with_commit(&repo, "auf-dem-server");
    // Merged on the host, not pulled yet: only origin/main contains it.
    repo.git(&["update-ref", "refs/remotes/origin/main", "auf-dem-server"]);
    let id = tc.open(&repo).await.repo.id;

    let list = candidates_at(&tc, &id, NOW).await.unwrap();
    assert_eq!(classes(&list), vec![("auf-dem-server", Safe, vec![Merged])]);
}
