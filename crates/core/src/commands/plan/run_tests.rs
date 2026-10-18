//! `ai_plan_run` against real repositories and a bare remote: one Mod+Z for the whole plan,
//! expired plans, the first failing step, outward steps confirmed one by one, the lease of a force
//! push, and cancelling. Expected values come from Git (rev-parse, for-each-ref, the remote).

use serde_json::json;

use super::check_tests::step;
use super::*;
use crate::commands::undo::{redo, undo, undo_peek};
use crate::error::ErrorCode;
use crate::model::{PlanClass, PlanCommand as C, PlanStepStatus};
use crate::testkit::{TestCore, TestRepo};

async fn setup() -> (TestCore, TestRepo, String) {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    (tc, repo, id)
}

async fn plan(tc: &TestCore, id: &str, steps: Vec<PlanStep>) -> PlanPreview {
    ai_plan_check(tc, id.to_string(), crate::util::new_id(), steps).await.unwrap()
}

fn steps_of(preview: &PlanPreview) -> Vec<PlanStep> {
    preview.steps.iter().map(|s| PlanStep { command: s.command, args: s.args.clone(), why: s.why.clone() }).collect()
}

async fn run(tc: &TestCore, id: &str, text: &str, preview: &PlanPreview, confirmed: Vec<u32>) -> CoreResult<PlanRunResult> {
    ai_plan_run(tc, id.to_string(), crate::util::new_id(), text.to_string(), steps_of(preview), preview.expect.clone(), confirmed).await
}

fn statuses(result: &PlanRunResult) -> Vec<PlanStepStatus> {
    result.steps.iter().map(|s| s.status).collect()
}

fn refs(repo: &TestRepo) -> String {
    repo.git(&["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags"])
}

fn has_ref(repo: &TestRepo, name: &str) -> bool {
    repo.git_output(&["rev-parse", "--verify", "-q", name]).status.success()
}

#[tokio::test]
async fn one_undo_takes_the_whole_plan_back() {
    let (tc, repo, id) = setup().await;
    repo.checkout_new("seite");
    let pick = repo.commit_file("g.txt", "neu\n", "Neue Datei g");
    repo.checkout("main");
    // Untracked work with CRLF, Latin-1 and no final newline: it must come back byte for byte.
    repo.write_file("notiz.txt", b"meine Notiz\r\nohne Schluss \xe4");
    let (head, before) = (repo.head(), refs(&repo));
    let preview = plan(
        &tc,
        &id,
        vec![
            step(C::BranchCreate, json!({"name": "fix/größe", "start": null, "checkout": true})),
            step(C::CherryPick, json!({"commits": [&pick[..7]]})),
            step(C::TagCreate, json!({"name": "probe-1", "commit": null, "message": null})),
        ],
    )
    .await;
    assert!(preview.runnable, "{preview:?}");
    let result = run(&tc, &id, "Fix-Branch mit g und Tag", &preview, vec![]).await.unwrap();
    assert!(result.completed && result.undo_recorded && !result.cancelled);
    assert_eq!(statuses(&result), vec![PlanStepStatus::Done; 3]);
    assert_eq!(repo.current_branch(), "fix/größe");
    assert!(repo.path().join("g.txt").exists());
    assert_eq!(repo.git(&["rev-parse", "probe-1"]), repo.head());

    let entries = tc.db.with(|c| crate::db::undo::list_done(c, &id, "")).unwrap();
    assert_eq!(entries.len(), 1, "one entry for the whole plan: {entries:?}");
    assert_eq!(entries[0].action, "plan");
    assert_eq!(undo_peek(&tc, id.clone()).await.unwrap().undo.unwrap().label, "Undo plan “Fix-Branch mit g und Tag”");

    undo(&tc, id.clone()).await.unwrap();
    assert_eq!(repo.head(), head);
    assert_eq!(repo.current_branch(), "main");
    assert_eq!(refs(&repo), before, "branches and tags exactly as before step 1");
    assert_eq!(repo.read_file("notiz.txt"), b"meine Notiz\r\nohne Schluss \xe4", "untracked work stays, byte for byte");
    assert!(!repo.path().join("g.txt").exists());
    assert!(undo_peek(&tc, id.clone()).await.unwrap().undo.is_none(), "nothing else to undo");

    redo(&tc, id.clone()).await.unwrap();
    assert_eq!(repo.current_branch(), "fix/größe");
    assert!(repo.path().join("g.txt").exists());
    assert!(has_ref(&repo, "refs/tags/probe-1"));
}

#[tokio::test]
async fn a_plan_expires_when_the_repository_changes_after_the_preview() {
    let (tc, repo, id) = setup().await;
    let preview = plan(&tc, &id, vec![step(C::BranchCreate, json!({"name": "spät", "start": null, "checkout": false}))]).await;
    repo.commit_file("dazwischen.txt", "x\n", "Dazwischen committet");
    let err = run(&tc, &id, "Branch spät", &preview, vec![]).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::StaleState);
    assert!(err.message.contains("expired"), "{}", err.message);
    assert!(!has_ref(&repo, "refs/heads/spät"), "nothing ran");

    // An edited step that was not checked again expires as well.
    let fresh = plan(&tc, &id, vec![step(C::BranchCreate, json!({"name": "spät", "start": null, "checkout": false}))]).await;
    let mut edited = steps_of(&fresh);
    edited[0].args.insert("name".into(), json!("anders"));
    let err = ai_plan_run(&tc, id.clone(), crate::util::new_id(), "t".into(), edited, fresh.expect.clone(), vec![]).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::StaleState);
    assert!(!has_ref(&repo, "refs/heads/anders"));
}

#[tokio::test]
async fn the_first_failing_step_ends_the_plan_and_the_done_steps_stay_one_undo() {
    let (tc, repo, id) = setup().await;
    let head = repo.head();
    // Nothing to stash: step 2 fails only when it runs.
    let preview = plan(
        &tc,
        &id,
        vec![
            step(C::BranchCreate, json!({"name": "a", "start": null, "checkout": true})),
            step(C::StashCreate, json!({"message": null, "includeUntracked": false, "paths": []})),
            step(C::TagCreate, json!({"name": "t", "commit": null, "message": null})),
        ],
    )
    .await;
    let result = run(&tc, &id, "a, stash, tag", &preview, vec![]).await.unwrap();
    assert_eq!(statuses(&result), vec![PlanStepStatus::Done, PlanStepStatus::Failed, PlanStepStatus::NotRun]);
    assert!(!result.completed && !result.cancelled && result.undo_recorded);
    assert_eq!(result.steps[1].error.as_ref().map(|e| e.code), Some(ErrorCode::NothingToCommit));
    assert!(!has_ref(&repo, "refs/tags/t"), "nothing after the failing step");
    undo(&tc, id.clone()).await.unwrap();
    assert_eq!(repo.current_branch(), "main");
    assert_eq!(repo.head(), head);
    assert!(!has_ref(&repo, "refs/heads/a"));

    let invalid = plan(&tc, &id, vec![step(C::BranchDelete, json!({"name": "gibt-es-nicht", "force": false}))]).await;
    assert_eq!(run(&tc, &id, "x", &invalid, vec![]).await.unwrap_err().code, ErrorCode::NotAllowed, "a plan that is not runnable never starts");
}

#[tokio::test]
async fn outward_steps_run_only_when_confirmed_one_by_one_and_stay_pushed_after_undo() {
    let (tc, repo, id) = setup().await;
    let remote = repo.add_remote();
    let preview = plan(
        &tc,
        &id,
        vec![
            step(C::BranchCreate, json!({"name": "export-fix", "start": null, "checkout": true})),
            step(C::Push, json!({"branch": "export-fix", "remote": "origin", "force": false})),
        ],
    )
    .await;
    assert_eq!(preview.steps[1].class, PlanClass::Outward);
    let on_remote = || remote.git_output(&["rev-parse", "--verify", "-q", "refs/heads/export-fix"]).status.success();
    for confirmed in [vec![], vec![0]] {
        let err = run(&tc, &id, "export-fix pushen", &preview, confirmed.clone()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed, "{confirmed:?}");
        assert!(err.message.contains("Step 2"), "{}", err.message);
    }
    assert!(!has_ref(&repo, "refs/heads/export-fix") && !on_remote(), "nothing ran");

    let result = run(&tc, &id, "export-fix pushen", &preview, vec![1]).await.unwrap();
    assert!(result.completed);
    assert!(on_remote());
    let label = undo_peek(&tc, id.clone()).await.unwrap().undo.unwrap().label;
    assert_eq!(label, "Undo plan “export-fix pushen” – pushed refs stay pushed");
    undo(&tc, id.clone()).await.unwrap();
    assert_eq!(repo.current_branch(), "main");
    assert!(!has_ref(&repo, "refs/heads/export-fix"), "locally taken back");
    assert!(on_remote(), "the push cannot be undone");
}

#[tokio::test]
async fn a_force_push_from_the_plan_uses_the_lease_it_was_shown() {
    let (tc, repo, id) = setup().await;
    let remote = repo.add_remote();
    repo.git(&["commit", "--amend", "-q", "-m", "Umgeschrieben"]);
    let preview = plan(&tc, &id, vec![step(C::Push, json!({"branch": null, "remote": null, "force": true}))]).await;
    assert!(preview.runnable);
    // Someone else pushes after the preview; this repository does not fetch, so `expect` still holds.
    let other = TestRepo::clone_of(&remote);
    let theirs = other.commit_file("fremd.txt", "fremd\n", "Von jemand anderem");
    other.git(&["push", "-q", "origin", "main"]);
    let result = run(&tc, &id, "force pushen", &preview, vec![0]).await.unwrap();
    assert_eq!(statuses(&result), vec![PlanStepStatus::Failed]);
    assert!(!result.completed);
    assert_eq!(remote.git(&["rev-parse", "refs/heads/main"]), theirs, "the lease protects the other commit");
}

#[tokio::test]
async fn a_cancelled_run_changes_nothing() {
    let (tc, repo, id) = setup().await;
    let preview = plan(
        &tc,
        &id,
        vec![
            step(C::BranchCreate, json!({"name": "eins", "start": null, "checkout": false})),
            step(C::BranchCreate, json!({"name": "zwei", "start": null, "checkout": false})),
        ],
    )
    .await;
    let job = tc.start_job("plan-abbruch", Some(&id)).unwrap();
    job.token().cancel();
    let err = crate::ai::plan_run::run(&tc, &id, &job, "zwei Branches", &steps_of(&preview), &preview.expect, &[]).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Cancelled);
    job.finish(&Err::<(), _>(err));
    assert!(!has_ref(&repo, "refs/heads/eins") && !has_ref(&repo, "refs/heads/zwei"));
    assert!(undo_peek(&tc, id).await.unwrap().undo.is_none());
}

/// The app polls commands on Tauri's Tokio workers, which have Tokio's default stack of 2 MiB. A
/// future that large is copied onto that stack more than once while it starts; a real plan run
/// once overflowed it (SIGSEGV in the app). Whatever a step does belongs on the heap.
#[tokio::test]
async fn a_plan_run_future_stays_small() {
    let (tc, _repo, id) = setup().await;
    let preview = plan(&tc, &id, vec![step(C::TagCreate, json!({"name": "probe", "commit": null, "message": null}))]).await;
    let future = run(&tc, &id, "Tag", &preview, vec![]);
    let size = std::mem::size_of_val(&future);
    assert!(size <= 64 * 1024, "the plan run's future takes {size} bytes");
    drop(future);
}
