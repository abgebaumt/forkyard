//! `ai_plan_check` against real temp repositories: the virtual state the earlier steps leave,
//! arguments Git or the UI would refuse (leading `-`, `..`, taken names, foreign arguments),
//! conflict prediction compared with `git merge-tree` itself, the expected state and the blocks.
//! Checking never changes the repository.

use serde_json::{json, Value};

use super::*;
use crate::error::ErrorCode;
use crate::model::{PlanCheck, PlanCommand as C, PlanPreview, PlanStep};
use crate::testkit::{TestCore, TestRepo};

async fn setup() -> (TestCore, TestRepo, String) {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    (tc, repo, id)
}

pub(super) fn step(command: C, args: Value) -> PlanStep {
    PlanStep { command, args: args.as_object().cloned().expect("an object"), why: "Weil es verlangt wurde.".into() }
}

async fn check(tc: &TestCore, id: &str, steps: Vec<PlanStep>) -> PlanPreview {
    ai_plan_check(tc, id.to_string(), crate::util::new_id(), steps).await.unwrap()
}

fn invalid(check: &PlanCheck, needle: &str) -> bool {
    matches!(check, PlanCheck::Invalid { reason } if reason.contains(needle))
}

/// The files `git merge-tree` itself names as conflicted; `None` = merges cleanly.
fn git_conflicts(repo: &TestRepo, ours: &str, theirs: &str) -> Option<Vec<String>> {
    let out = repo.git_output(&["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", ours, theirs]);
    match out.status.code() {
        Some(0) => None,
        Some(1) => {
            let mut files: Vec<String> = Vec::new();
            for part in out.stdout.split(|b| *b == 0).skip(1) {
                let path = String::from_utf8_lossy(part).into_owned();
                if !path.is_empty() && !files.contains(&path) {
                    files.push(path);
                }
            }
            Some(files)
        }
        other => panic!("merge-tree failed ({other:?}): {}", String::from_utf8_lossy(&out.stderr)),
    }
}

/// main and `seite` change line 2 of f.txt differently; `sauber` only adds g.txt.
fn diverged(repo: &TestRepo) {
    repo.commit_file("f.txt", "eins\nzwei\ndrei\n", "Basis");
    repo.checkout_new("seite");
    repo.commit_file("f.txt", "eins\nZWEI seite\ndrei\n", "Seite ändert Zeile 2");
    repo.checkout("main");
    repo.checkout_new("sauber");
    repo.commit_file("g.txt", "neu\n", "Neue Datei g");
    repo.checkout("main");
    repo.commit_file("f.txt", "eins\nzwei main\ndrei\n", "Main ändert Zeile 2");
}

#[tokio::test]
async fn later_steps_see_what_earlier_steps_create_rename_and_delete() {
    let (tc, repo, id) = setup().await;
    repo.branch("feature/größe");
    let preview = check(
        &tc,
        &id,
        vec![
            step(C::BranchCreate, json!({"name": "hotfix", "start": null, "checkout": true})),
            step(C::BranchRename, json!({"name": "hotfix", "newName": "hotfix/übersicht"})),
            step(C::BranchCheckout, json!({"target": "feature/größe"})),
            step(C::BranchDelete, json!({"name": "hotfix/übersicht", "force": false})),
            step(C::TagCreate, json!({"name": "v1.0-größe", "commit": null, "message": "Größen"})),
        ],
    )
    .await;
    let checks: Vec<PlanCheck> = preview.steps.iter().map(|s| s.check.clone()).collect();
    assert_eq!(checks, vec![PlanCheck::NotNeeded; 5]);
    assert!(preview.runnable && !preview.blocked);
    assert_eq!(repo.git(&["branch", "--list", "hotfix*"]), "", "checking changes nothing");
    assert_eq!(repo.current_branch(), "main");

    let preview = check(
        &tc,
        &id,
        vec![
            step(C::BranchCreate, json!({"name": "hotfix", "start": null, "checkout": true})),
            step(C::BranchDelete, json!({"name": "hotfix", "force": true})),
            step(C::BranchCheckout, json!({"target": "gibt-es-nicht"})),
            step(C::BranchCheckout, json!({"target": "feature/größe"})),
            step(C::BranchDelete, json!({"name": "hotfix", "force": true})),
            step(C::BranchCreate, json!({"name": "danach", "start": "hotfix", "checkout": false})),
        ],
    )
    .await;
    assert_eq!(preview.steps[0].check, PlanCheck::NotNeeded);
    assert!(invalid(&preview.steps[1].check, "is checked out at that point"), "{:?}", preview.steps[1].check);
    assert!(invalid(&preview.steps[2].check, "gibt-es-nicht"), "{:?}", preview.steps[2].check);
    assert_eq!(preview.steps[4].check, PlanCheck::NotNeeded, "after switching away it may go");
    assert!(invalid(&preview.steps[5].check, "deleted by an earlier step"), "{:?}", preview.steps[5].check);
    assert!(!preview.runnable);
}

#[tokio::test]
async fn arguments_are_refused_like_git_and_the_ui_refuse_them() {
    let (tc, repo, id) = setup().await;
    repo.write_file("notizen/über uns.md", "Hallo\n");
    let preview = check(
        &tc,
        &id,
        vec![
            step(C::BranchCreate, json!({"name": "-rf", "start": null, "checkout": false})),
            step(C::BranchCreate, json!({"name": "main", "start": null, "checkout": false})),
            step(C::BranchCreate, json!({"name": "neu", "start": "--output=/tmp/x", "checkout": false})),
            step(C::StashCreate, json!({"message": null, "includeUntracked": true, "paths": ["../außen.txt"]})),
            step(C::StashCreate, json!({"message": "Notizen", "includeUntracked": true, "paths": ["notizen/über uns.md"]})),
            step(C::CherryPick, json!({"commits": []})),
            step(C::BranchCreate, json!({"name": "zweiter", "start": null, "checkout": false, "force": true})),
            step(C::Push, json!({"branch": null, "remote": null, "force": false})),
            step(C::TagPush, json!({"name": "v9", "remote": "origin"})),
            step(C::ResetBranch, json!({"target": "HEAD", "resetMode": "weich"})),
        ],
    )
    .await;
    let c: Vec<&PlanCheck> = preview.steps.iter().map(|s| &s.check).collect();
    assert!(matches!(c[0], PlanCheck::Invalid { .. }), "a leading dash is no branch name: {:?}", c[0]);
    assert!(matches!(c[1], PlanCheck::Invalid { .. }), "main exists: {:?}", c[1]);
    assert!(invalid(c[2], "--output"), "{:?}", c[2]);
    assert!(invalid(c[3], "outside the repository"), "{:?}", c[3]);
    assert_eq!(*c[4], PlanCheck::NotNeeded, "umlauts and spaces are a normal path");
    assert!(invalid(c[5], "at least one commit"), "{:?}", c[5]);
    assert!(invalid(c[6], "“force” is not an argument of branchCreate"), "{:?}", c[6]);
    assert!(invalid(c[7], "upstream"), "main has no upstream here: {:?}", c[7]);
    assert!(invalid(c[8], "v9"), "{:?}", c[8]);
    assert!(invalid(c[9], "resetMode"), "{:?}", c[9]);
    assert!(!preview.runnable);
    // A Windows-style separator is a valid relative path on every platform (normalised on Windows).
    let windows = check(&tc, &id, vec![step(C::StashCreate, json!({"message": null, "includeUntracked": false, "paths": ["notizen\\über uns.md"]}))]).await;
    assert_eq!(windows.steps[0].check, PlanCheck::NotNeeded);
}

#[tokio::test]
async fn branches_of_other_worktrees_are_left_alone() {
    let (tc, repo, id) = setup().await;
    repo.branch("agent/fix");
    let other = repo.temp_dir().join("agent fix");
    repo.git(&["worktree", "add", "-q", other.to_str().unwrap(), "agent/fix"]);
    let preview = check(
        &tc,
        &id,
        vec![
            step(C::BranchDelete, json!({"name": "agent/fix", "force": true})),
            step(C::BranchCheckout, json!({"target": "agent/fix"})),
            step(C::BranchRename, json!({"name": "agent/fix", "newName": "agent/fertig"})),
        ],
    )
    .await;
    for check in preview.steps.iter().map(|s| &s.check) {
        assert!(invalid(check, "another worktree"), "{check:?}");
    }
}

#[tokio::test]
async fn conflicts_are_predicted_from_the_state_the_earlier_steps_leave() {
    let (tc, repo, id) = setup().await;
    diverged(&repo);
    let expected = git_conflicts(&repo, "seite", "main").expect("git: seite and main conflict");
    assert_eq!(expected, vec!["f.txt".to_string()]);
    assert_eq!(git_conflicts(&repo, "main", "sauber"), None, "git: main and sauber merge cleanly");

    let clean = check(&tc, &id, vec![step(C::MergeStart, json!({"source": "sauber", "mergeMode": "default"}))]).await;
    assert_eq!(clean.steps[0].check, PlanCheck::Clean);
    assert!(clean.runnable);

    let preview = check(
        &tc,
        &id,
        vec![
            step(C::BranchCreate, json!({"name": "probe", "start": "seite", "checkout": true})),
            step(C::MergeStart, json!({"source": "main", "mergeMode": "no_ff"})),
            step(C::MergeStart, json!({"source": "sauber", "mergeMode": "default"})),
            step(C::CherryPick, json!({"commits": ["HEAD"]})),
        ],
    )
    .await;
    assert_eq!(preview.steps[1].check, PlanCheck::Conflicts { files: expected });
    assert!(matches!(&preview.steps[2].check, PlanCheck::Unknown { reason } if reason.contains("step 2")), "{:?}", preview.steps[2].check);
    assert!(invalid(&preview.steps[3].check, "depends on what step 3 does"), "{:?}", preview.steps[3].check);
    assert!(!preview.runnable, "a predicted conflict blocks the plan");

    if tc.git.info().unwrap().version >= (2, 40, 0) {
        let rebase = check(&tc, &id, vec![step(C::RebaseStart, json!({"onto": "main", "branch": "seite"}))]).await;
        assert_eq!(rebase.steps[0].check, PlanCheck::Conflicts { files: vec!["f.txt".into()] });
    }
    assert_eq!(repo.current_branch(), "main");
    assert_eq!(repo.git(&["branch", "--list", "probe"]), "");
    assert_eq!(repo.git(&["status", "--porcelain"]), "", "simulating changes nothing");
}

#[tokio::test]
async fn the_expected_state_follows_head_index_tips_named_refs_and_the_steps() {
    let (tc, repo, id) = setup().await;
    let _remote = repo.add_remote();
    let steps = || vec![step(C::MergeStart, json!({"source": "origin/main", "mergeMode": "default"}))];
    let first = check(&tc, &id, steps()).await.expect;
    assert_eq!(check(&tc, &id, steps()).await.expect, first, "same state and steps, same expectation");

    repo.write_file("README.md", "geändert\n");
    repo.git(&["add", "README.md"]);
    assert_ne!(check(&tc, &id, steps()).await.expect, first, "the index counts");
    repo.git(&["reset", "-q"]);
    repo.git(&["checkout", "--", "README.md"]);
    assert_eq!(check(&tc, &id, steps()).await.expect, first, "back to the same index");

    repo.git(&["update-ref", "refs/heads/nebenbei", "HEAD"]);
    assert_ne!(check(&tc, &id, steps()).await.expect, first, "every branch tip counts");
    repo.git(&["update-ref", "-d", "refs/heads/nebenbei"]);

    repo.git(&["update-ref", "refs/remotes/origin/nebenbei", "HEAD"]);
    assert_eq!(check(&tc, &id, steps()).await.expect, first, "a remote branch no step names may move (background fetch)");

    let mut other = steps();
    other[0].why = "Anders begründet".into();
    assert_ne!(check(&tc, &id, other).await.expect, first, "the steps themselves count");

    let foreign = repo.git(&["commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "Von woanders"]);
    repo.git(&["update-ref", "refs/remotes/origin/main", &foreign]);
    assert_ne!(check(&tc, &id, steps()).await.expect, first, "the remote branch a step names counts");
}

#[tokio::test]
async fn an_operation_in_progress_blocks_every_plan() {
    let (tc, repo, id) = setup().await;
    diverged(&repo);
    assert!(!repo.merge("seite"), "a conflict on purpose");
    let preview = check(&tc, &id, vec![step(C::BranchCreate, json!({"name": "danach", "start": null, "checkout": false}))]).await;
    assert!(preview.blocked);
    assert!(!preview.runnable);
}

#[tokio::test]
async fn too_long_plans_and_untrusted_repositories_are_refused() {
    let (tc, _repo, id) = setup().await;
    let many = |n: usize| (0..n).map(|k| step(C::BranchCreate, json!({"name": format!("zweig-{k}"), "start": null, "checkout": false}))).collect::<Vec<_>>();
    assert!(check(&tc, &id, many(10)).await.runnable, "ten steps are fine");
    let err = ai_plan_check(&tc, id.clone(), crate::util::new_id(), many(11)).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::AiInvalidAnswer);
    assert!(err.message.contains("plan too long"), "{}", err.message);
    crate::commands::trust::repo_trust_set(&tc, id.clone(), false).await.unwrap();
    let err = ai_plan_check(&tc, id, crate::util::new_id(), many(1)).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::RepoUntrusted);
}
