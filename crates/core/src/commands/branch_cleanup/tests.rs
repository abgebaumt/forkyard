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
    assert_eq!(geteilt.upstream_sha.as_deref(), Some(repo.git(&["rev-parse", "origin/geteilt"]).as_str()), "the lease for the deletion");

    // A colleague's commit on the remote branch (fetched, in no default branch): no remote option.
    repo.checkout("geteilt");
    repo.git(&["checkout", "-q", "--detach"]);
    let theirs = repo.commit_file("h.txt", "h\n", "Von Kollegin");
    repo.checkout("main");
    repo.git(&["update-ref", "refs/remotes/origin/geteilt", &theirs]);
    let list = candidates_at(&tc, &id, NOW).await.unwrap();
    let geteilt = list.candidates.iter().find(|c| c.name == "geteilt").unwrap();
    assert_eq!(geteilt.class, Safe, "the local branch is still merged");
    assert_eq!((geteilt.upstream_remote.as_deref(), geteilt.upstream_sha.as_deref()), (None, None));

    // Once the default branch has it, the remote branch may go again.
    repo.git(&["merge", "-q", "--no-edit", &theirs]);
    let list = candidates_at(&tc, &id, NOW).await.unwrap();
    let geteilt = list.candidates.iter().find(|c| c.name == "geteilt").unwrap();
    assert_eq!(geteilt.upstream_sha.as_deref(), Some(theirs.as_str()));
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

// ---------------------------------------------------------------------------
// Deleting
// ---------------------------------------------------------------------------

use crate::commands::undo::{undo, undo_peek};
use crate::error::ErrorCode;
use crate::model::BranchCleanupTarget;

/// Name and current SHA of each branch.
fn targets_of(repo: &TestRepo, names: &[&str]) -> Vec<BranchCleanupTarget> {
    names.iter().map(|name| BranchCleanupTarget { name: name.to_string(), sha: repo.git(&["rev-parse", name]) }).collect()
}

fn branch_exists(repo: &TestRepo, name: &str) -> bool {
    repo.git_output(&["rev-parse", "--verify", "-q", &format!("refs/heads/{name}")]).status.success()
}

#[tokio::test]
async fn deleting_several_branches_is_one_undo_entry_and_undo_brings_all_back() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    merged_branch(&repo, "fertig");
    repo.checkout_new("feature/thema-20");
    repo.commit_file("t1.txt", "1\n", "Eins");
    repo.commit_file("t2.txt", "2\n", "Zwei");
    repo.checkout("main");
    branch_with_commit(&repo, "alt");
    let id = tc.open(&repo).await.repo.id;
    let names = ["fertig", "feature/thema-20", "alt"];
    let before: Vec<(String, String)> = names.iter().map(|n| (n.to_string(), repo.git(&["rev-parse", n]))).collect();
    let undo_before_delete = undo_peek(&tc, id.clone()).await.unwrap().undo.map(|step| step.label);

    branch_cleanup_delete(&tc, id.clone(), targets_of(&repo, &names)).await.unwrap();
    for name in names {
        assert!(!branch_exists(&repo, name), "{name} is gone");
    }
    let peek = undo_peek(&tc, id.clone()).await.unwrap();
    assert_eq!(peek.undo.unwrap().label, "Undo deletion of 3 branches");

    undo(&tc, id.clone()).await.unwrap();
    for (name, sha) in &before {
        assert_eq!(&repo.git(&["rev-parse", name]), sha, "{name} is back at the same commit");
    }
    // One step brought all three back: the undo stack is where it was before the delete.
    assert_eq!(undo_peek(&tc, id).await.unwrap().undo.map(|step| step.label), undo_before_delete);
}

#[tokio::test]
async fn a_moved_branch_is_not_deleted() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    merged_branch(&repo, "fertig");
    branch_with_commit(&repo, "alt");
    let id = tc.open(&repo).await.repo.id;
    let targets = targets_of(&repo, &["alt", "fertig"]);
    repo.checkout("fertig");
    repo.commit_file("neu.txt", "neu\n", "Neu");
    repo.checkout("main");

    let err = branch_cleanup_delete(&tc, id, targets).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::StaleState);
    assert!(branch_exists(&repo, "fertig") && branch_exists(&repo, "alt"), "nothing is deleted");
}

#[tokio::test]
async fn checked_out_default_and_protected_branches_are_refused() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    merged_branch(&repo, "fertig");
    merged_branch(&repo, "release/2026.1");
    merged_branch(&repo, "team/übung");
    merged_branch(&repo, "in-arbeit");
    let linked = repo.temp_dir().join("in-arbeit-wt");
    repo.git(&["worktree", "add", "-q", linked.to_str().unwrap(), "in-arbeit"]);
    repo.checkout_new("aktiv");
    let id = tc.open(&repo).await.repo.id;
    repo_settings_set(&tc, id.clone(), serde_json::json!({ "protectedBranchPatterns": ["team/*"] })).await.unwrap();

    let missing = BranchCleanupTarget { name: "weg".into(), sha: repo.git(&["rev-parse", "main"]) };
    let cases = [
        ("aktiv", ErrorCode::NotAllowed),
        ("main", ErrorCode::NotAllowed),
        ("release/2026.1", ErrorCode::NotAllowed),
        ("team/übung", ErrorCode::NotAllowed),
        ("in-arbeit", ErrorCode::NotAllowed),
        ("weg", ErrorCode::NotFound),
    ];
    for (name, code) in cases {
        let target = if name == "weg" { missing.clone() } else { targets_of(&repo, &[name]).remove(0) };
        let targets = vec![targets_of(&repo, &["fertig"]).remove(0), target];
        let err = branch_cleanup_delete(&tc, id.clone(), targets).await.unwrap_err();
        assert_eq!(err.code, code, "{name}: {}", err.message);
        assert!(err.message.contains(&format!("‘{name}’")), "{name}: the message names the branch: {}", err.message);
        assert!(branch_exists(&repo, "fertig"), "{name}: the other target stays");
        if name != "weg" {
            assert!(branch_exists(&repo, name), "{name} stays");
        }
    }
}

#[tokio::test]
async fn an_empty_selection_changes_nothing() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    merged_branch(&repo, "fertig");
    let id = tc.open(&repo).await.repo.id;
    let before = undo_peek(&tc, id.clone()).await.unwrap().undo.map(|step| step.label);

    let refs = branch_cleanup_delete(&tc, id.clone(), Vec::new()).await.unwrap();
    assert!(refs.locals.iter().any(|r| r.name == "fertig"));
    assert_eq!(undo_peek(&tc, id).await.unwrap().undo.map(|step| step.label), before);
}

fn pr(number: u64, branch: &str, state: crate::model::PrState) -> PrSummary {
    PrSummary {
        number,
        title: String::new(),
        state,
        is_draft: false,
        author: None,
        source_branch: branch.into(),
        target_branch: "main".into(),
        updated_at: String::new(),
        web_url: String::new(),
        checks: None,
        review_state: None,
        labels: Vec::new(),
        is_fork: false,
    }
}

#[test]
fn the_pr_list_decides_the_fact_before_any_detail() {
    use crate::model::PrState::{Merged as M, Open as O};
    let prs = vec![pr(9, "neu", O), pr(5, "neu", M), pr(4, "fertig", M), PrSummary { is_fork: true, ..pr(3, "fremd", M) }];
    assert_eq!(listed_fact(&prs, "neu", false, false), PrFact::Open, "the newest PR counts");
    assert_eq!(
        listed_fact(&prs, "fertig", false, false),
        PrFact::Merged { number: 4, commits_after_head: true },
        "until the head is checked"
    );
    assert_eq!(listed_fact(&prs, "fertig", false, true), PrFact::Merged { number: 4, commits_after_head: false }, "settled: no check");
    assert_eq!(listed_fact(&prs, "fremd", false, false), PrFact::None, "a fork's PR is not this branch's");
    assert_eq!(listed_fact(&prs, "ohne", false, false), PrFact::None);
    assert_eq!(listed_fact(&prs, "ohne", true, false), PrFact::Unknown, "cut-off list: an older PR may exist");
    assert_eq!(
        listed_fact(&prs, "fertig", true, false),
        PrFact::Merged { number: 4, commits_after_head: true },
        "a match counts even when cut off"
    );
}
