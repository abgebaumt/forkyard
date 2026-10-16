//! Whatever stops a compose run after its first commit – a hook that rejects, a hook that edits
//! files, a cancel – HEAD and the index end up as before and no backup refs are left.

use std::time::Duration;

use super::apply_tests::{apply, backup_refs, commit, unit};
use super::units_tests::{open, twenty, two_hunks, write_hook};
use super::*;
use crate::commands::undo::undo_peek;
use crate::error::ErrorCode;
use crate::model::ComposePlan;
use crate::testkit::TestRepo;
use crate::util;

/// a.txt with two hunks and b.txt changed; the hook is written before the repository is opened.
fn repo_with(hook: Option<(&str, &str)>) -> TestRepo {
    let repo = TestRepo::with_commit();
    repo.commit_file("a.txt", twenty(), "Zwanzig");
    repo.commit_file("b.txt", "b\n", "B");
    repo.write_file("a.txt", two_hunks());
    repo.write_file("b.txt", "B\n");
    if let Some((name, body)) = hook {
        write_hook(&repo, name, body);
    }
    repo
}

#[tokio::test]
async fn a_failing_hook_in_the_second_commit_restores_head_and_index() {
    let repo = repo_with(Some(("pre-commit", "if git diff --cached --name-only | grep -q '^b.txt$'; then echo 'b.txt ist gesperrt'; exit 1; fi")));
    repo.git(&["add", "a.txt"]);
    let (base, index) = (repo.head(), repo.git(&["ls-files", "-s"]));
    let (tc, id) = open(&repo).await;
    let state = compose_units(&tc, id.clone()).await.unwrap();

    let err = apply(
        &tc,
        &id,
        &state,
        vec![
            commit("Zeilen in a", "", &[unit(&state, "a.txt", Some(0)), unit(&state, "a.txt", Some(1))]),
            commit("b groß", "", &[unit(&state, "b.txt", Some(0))]),
        ],
    )
    .await
    .unwrap_err();

    assert_eq!(err.code, ErrorCode::HookFailed);
    assert!(err.git_output.as_deref().unwrap_or("").contains("b.txt ist gesperrt"), "{err:?}");
    assert_eq!(repo.head(), base, "the first commit is taken back");
    assert_eq!(repo.git(&["ls-files", "-s"]), index, "the index is as before (a.txt still staged)");
    assert_eq!(repo.read_file("a.txt"), two_hunks().as_bytes());
    assert_eq!(backup_refs(&repo), "");
    assert!(undo_peek(&tc, id).await.unwrap().undo.is_none(), "no undo entry for a run that did not happen");
}

#[tokio::test]
async fn a_hook_that_edits_files_stops_and_takes_the_commits_back() {
    let repo = repo_with(Some(("pre-commit", "echo 'vom Hook' >> b.txt")));
    let base = repo.head();
    let (tc, id) = open(&repo).await;
    let state = compose_units(&tc, id.clone()).await.unwrap();

    let err = apply(&tc, &id, &state, vec![commit("Nur a", "", &[unit(&state, "a.txt", Some(0))])]).await.unwrap_err();

    assert_eq!(err.code, ErrorCode::HookFailed);
    assert!(err.message.contains("changed files in the working directory"), "{}", err.message);
    assert_eq!(repo.head(), base);
    assert_eq!(repo.read_file("b.txt"), b"B\nvom Hook\n", "what the hook wrote stays – Forkyard never touches the working directory");
    assert_eq!(repo.git(&["diff", "--cached", "--name-only"]), "");
    assert_eq!(backup_refs(&repo), "");
}

#[tokio::test]
async fn cancelling_between_two_commits_takes_the_first_ones_back() {
    let hook = "dir=$(git rev-parse --git-dir)\n\
                n=$(cat \"$dir/runs\" 2>/dev/null || echo 0)\n\
                n=$((n+1))\n\
                echo $n > \"$dir/runs\"\n\
                if [ $n = 2 ]; then while [ ! -f \"$dir/go\" ]; do sleep 0.05; done; fi";
    let repo = repo_with(Some(("pre-commit", hook)));
    let base = repo.head();
    let (tc, id) = open(&repo).await;
    let state = compose_units(&tc, id.clone()).await.unwrap();
    let plan = ComposePlan {
        commits: vec![
            commit("Eins", "", &[unit(&state, "a.txt", Some(0))]),
            commit("Zwei", "", &[unit(&state, "a.txt", Some(1))]),
            commit("Drei", "", &[unit(&state, "b.txt", Some(0))]),
        ],
        skip_hooks: false,
    };
    let job_id = util::new_id();
    let git_dir = repo.path().join(".git");

    let run = compose_apply(&tc, id.clone(), job_id.clone(), plan, state.token.clone());
    let control = async {
        // The second commit's hook waits for "go": cancel exactly then.
        while std::fs::read_to_string(git_dir.join("runs")).map(|n| n.trim() != "2").unwrap_or(true) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(tc.jobs.cancel(&job_id), "the compose job is running");
        std::fs::write(git_dir.join("go"), "").unwrap();
    };
    let (result, ()) = tokio::join!(run, control);

    assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
    assert_eq!(std::fs::read_to_string(git_dir.join("runs")).unwrap().trim(), "2", "the third commit never started");
    assert_eq!(repo.head(), base, "both created commits are taken back");
    assert_eq!(repo.git(&["diff", "--cached", "--name-only"]), "");
    assert_eq!(backup_refs(&repo), "");
}

/// Hook body: on run `n`, commit like a terminal would (`commit-tree` + `update-ref` on HEAD's
/// branch, not through the run's index) and remember the SHA in `.git/foreign`.
fn foreign_commit_on_run(n: u32) -> String {
    format!(
        "dir=$(git rev-parse --git-dir)\n\
         n=$(cat \"$dir/runs\" 2>/dev/null || echo 0)\n\
         n=$((n+1))\n\
         echo $n > \"$dir/runs\"\n\
         if [ $n = {n} ]; then\n\
           sha=$(git commit-tree 'HEAD^{{tree}}' -p HEAD -m 'Fremder Commit aus dem Terminal')\n\
           git update-ref HEAD \"$sha\"\n\
           echo $sha > \"$dir/foreign\"\n\
         fi"
    )
}

/// What every moved-branch case must leave: the foreign commit still on the branch, the backup
/// refs kept, and an error that does not claim the commits were taken back.
fn assert_branch_left_alone(repo: &TestRepo, err: &crate::error::CoreError) {
    let foreign = std::fs::read_to_string(repo.path().join(".git/foreign")).expect("the hook made its commit");
    let foreign = foreign.trim();
    assert_eq!(err.code, ErrorCode::StaleState, "{err:?}");
    assert!(
        repo.git(&["merge-base", "--is-ancestor", foreign, "HEAD"]).is_empty(),
        "the foreign commit stays on the branch"
    );
    assert!(repo.git(&["log", "--format=%s", "HEAD"]).contains("Fremder Commit aus dem Terminal"));
    assert!(!err.message.contains("taken back"), "{}", err.message);
    assert!(err.message.contains("left"), "{}", err.message);
    assert_ne!(backup_refs(repo), "", "the backup refs stay so nothing is lost");
}

#[tokio::test]
async fn a_commit_from_elsewhere_right_after_ours_leaves_the_branch_where_it_is() {
    // post-commit of the first commit: someone commits on top of it before the run checks it.
    let repo = repo_with(Some(("post-commit", &foreign_commit_on_run(1))));
    let base = repo.head();
    let (tc, id) = open(&repo).await;
    let state = compose_units(&tc, id.clone()).await.unwrap();

    let err = apply(
        &tc,
        &id,
        &state,
        vec![commit("Eins", "", &[unit(&state, "a.txt", Some(0))]), commit("Zwei", "", &[unit(&state, "b.txt", Some(0))])],
    )
    .await
    .unwrap_err();

    assert_branch_left_alone(&repo, &err);
    assert_ne!(repo.head(), base, "the branch is not reset to the old HEAD");
    assert_eq!(repo.git(&["rev-parse", "HEAD"]).trim(), std::fs::read_to_string(repo.path().join(".git/foreign")).unwrap().trim());
}

#[tokio::test]
async fn a_commit_from_elsewhere_during_a_slow_hook_leaves_the_branch_where_it_is() {
    // pre-commit of the second commit: a terminal commit lands while the hook runs.
    let repo = repo_with(Some(("pre-commit", &foreign_commit_on_run(2))));
    let base = repo.head();
    let (tc, id) = open(&repo).await;
    let state = compose_units(&tc, id.clone()).await.unwrap();

    let err = apply(
        &tc,
        &id,
        &state,
        vec![commit("Eins", "", &[unit(&state, "a.txt", Some(0))]), commit("Zwei", "", &[unit(&state, "b.txt", Some(0))])],
    )
    .await
    .unwrap_err();

    // Depending on the Git version the second `git commit` fails on its ref lock or lands on top
    // of the foreign commit; either way the foreign commit must not be dropped.
    let foreign = std::fs::read_to_string(repo.path().join(".git/foreign")).unwrap();
    assert!(repo.git(&["merge-base", "--is-ancestor", foreign.trim(), "HEAD"]).is_empty());
    assert!(repo.git(&["log", "--format=%s", "HEAD"]).contains("Fremder Commit aus dem Terminal"));
    assert_ne!(repo.head(), base);
    assert!(!err.message.contains("taken back"), "{}", err.message);
    assert_ne!(backup_refs(&repo), "");
}
