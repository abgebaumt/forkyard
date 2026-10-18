//! The run: Normal and Thorough, the extra steps, the locks, cancel while waiting, trust, events.

use std::time::Duration;

use super::test_support::*;
use super::*;
use crate::app::WriteGuard;
use crate::error::ErrorCode;
use crate::events::names;
use crate::model::CleanupStep::{Gc, Lfs, Reflog, Undo, Worktrees};
use crate::model::CleanupStepStatus::{Done, Skipped};
use crate::model::{CleanupMode, CleanupOptions, CleanupStep, CleanupStepResult, CleanupStepStatus};
use crate::testkit::{TestCore, TestRepo};
use crate::util;

#[tokio::test]
async fn normal_packs_loose_objects_and_keeps_young_unreachable_ones() {
    let (tc, repo, id) = setup().await;
    // Unreachable objects go into a cruft pack (Git's default from 2.40 on; set for older Gits).
    repo.git(&["config", "gc.cruftPacks", "true"]);
    for n in 0..4 {
        repo.commit_file(&format!("Messwerte/Station {n}.csv"), format!("tag;mittel\n1;{n}\n"), "Messwerte");
    }
    let dangling = dangling_blob(&repo, "noch jung und unerreichbar\n");
    let before = git_count_objects(&repo);
    assert!(before["count"] > 0);
    let result = run_cleanup(&tc, &id, only_gc(CleanupMode::Normal)).await.unwrap();
    assert_eq!((result.before.loose_count, result.before.loose_bytes), (before["count"], before["size"] * 1024));
    assert_eq!(git_count_objects(&repo)["count"], 0, "git count-objects: no loose objects left");
    assert_eq!(result.after.loose_count, 0);
    assert!(object_exists(&repo, &dangling), "unreachable objects younger than two weeks stay");
    let statuses: Vec<_> = result.steps.iter().map(|entry| (entry.step, entry.status)).collect();
    assert_eq!(statuses, [(Worktrees, Skipped), (Undo, Skipped), (Reflog, Skipped), (Lfs, Skipped), (Gc, Done)]);
    assert!(!result.cancelled && result.failure.is_none());
}

#[tokio::test]
async fn thorough_removes_unreachable_loose_objects_at_once() {
    let (tc, repo, id) = setup().await;
    let dangling = dangling_blob(&repo, "sofort weg\n");
    let reachable = repo.commit_file("bleibt.txt", "bleibt\n", "Bleibt");
    let result = run_cleanup(&tc, &id, only_gc(CleanupMode::Thorough)).await.unwrap();
    assert_eq!(status_of(&result, CleanupStep::Gc), CleanupStepStatus::Done);
    assert!(!object_exists(&repo, &dangling), "--prune=now removes it right away");
    assert!(object_exists(&repo, &reachable));
    assert_eq!(git_count_objects(&repo)["count"], 0);
    repo.git(&["fsck", "--no-progress"]);
}

/// A coding agent may be writing objects in its worktree (same object store): `--prune=now` could
/// remove the loose objects of its commit in progress. Thorough refuses while one runs and leaves
/// everything as it was; Normal (two weeks of grace) still runs.
#[tokio::test]
async fn thorough_waits_until_no_coding_agent_runs() {
    let (tc, repo, id) = setup().await;
    let dangling = dangling_blob(&repo, "Objekt eines Agenten in Arbeit\n");
    tc.state::<crate::commands::agents::registry::AgentRegistry>().insert_running_for_test("agent-läuft", &id);
    let error = run_cleanup(&tc, &id, only_gc(CleanupMode::Thorough)).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::NotAllowed, "{error:?}");
    assert!(error.message.contains("coding agent"), "{}", error.message);
    assert!(object_exists(&repo, &dangling), "nothing was pruned");
    let normal = run_cleanup(&tc, &id, only_gc(CleanupMode::Normal)).await.unwrap();
    assert_eq!(status_of(&normal, CleanupStep::Gc), CleanupStepStatus::Done);
    assert!(object_exists(&repo, &dangling), "Normal keeps young unreachable objects");

    tc.state::<crate::commands::agents::registry::AgentRegistry>().remove("agent-läuft");
    run_cleanup(&tc, &id, only_gc(CleanupMode::Thorough)).await.unwrap();
    assert!(!object_exists(&repo, &dangling));
}

#[tokio::test]
async fn orphaned_worktrees_are_pruned_only_when_asked() {
    let (tc, repo, id) = setup().await;
    let gone = repo.temp_dir().join("weg mit Ümlaut");
    repo.git(&["worktree", "add", "-q", "-b", "verwaist", &gone.to_string_lossy()]);
    std::fs::remove_dir_all(&gone).unwrap();
    let normal = run_cleanup(&tc, &id, only_gc(CleanupMode::Normal)).await.unwrap();
    assert_eq!(status_of(&normal, CleanupStep::Worktrees), CleanupStepStatus::Skipped);
    assert!(repo.git(&["worktree", "list", "--porcelain"]).contains("\nprunable"), "Normal alone keeps the young entry");
    let result = run_cleanup(&tc, &id, CleanupOptions { worktrees: true, ..only_gc(CleanupMode::Normal) }).await.unwrap();
    assert_eq!(result.steps[0], CleanupStepResult { step: CleanupStep::Worktrees, status: CleanupStepStatus::Done, removed: Some(1) });
    assert!(!repo.git(&["worktree", "list", "--porcelain"]).contains("prunable"));
    repo.git(&["checkout", "-q", "verwaist"]);
    assert_eq!(repo.current_branch(), "verwaist", "the branch can be checked out again");
}

/// Commits around the 90-day line in four time zones, in a repository that keeps its reflog forever.
#[tokio::test]
async fn shorten_reflog_removes_only_entries_older_than_90_days() {
    let tc = TestCore::new().await;
    let repo = TestRepo::new();
    repo.git(&["config", "gc.reflogExpire", "never"]);
    repo.git(&["config", "gc.reflogExpireUnreachable", "never"]);
    let now = now();
    for (days, zone) in [(400, "+0200"), (91, "+0545"), (89, "-0930"), (2, "+1300")] {
        git_dated(&repo, repo.path(), now - days * DAY, zone, &["commit", "-q", "--allow-empty", "-m", &format!("vor {days} Tagen")]);
    }
    let id = tc.open(&repo).await.repo.id;
    let reflog = |name: &str| repo.git(&["log", "-g", "--format=%s", name]).lines().map(str::to_string).collect::<Vec<_>>();
    assert_eq!(reflog("refs/heads/main").len(), 4);
    run_cleanup(&tc, &id, only_gc(CleanupMode::Normal)).await.unwrap();
    assert_eq!(reflog("refs/heads/main").len(), 4, "Normal follows gc.reflogExpire=never");
    let result = run_cleanup(&tc, &id, CleanupOptions { reflog: true, ..only_gc(CleanupMode::Normal) }).await.unwrap();
    assert_eq!(status_of(&result, CleanupStep::Reflog), CleanupStepStatus::Done);
    assert_eq!(reflog("refs/heads/main"), ["vor 2 Tagen", "vor 89 Tagen"]);
    assert_eq!(reflog("HEAD"), ["vor 2 Tagen", "vor 89 Tagen"]);
}

#[tokio::test]
async fn old_and_orphaned_undo_backups_go_with_their_rows_young_ones_stay() {
    let (tc, repo, id) = setup().await;
    let f = undo_fixture(&tc, &repo, &id).await;
    let result = run_cleanup(&tc, &id, CleanupOptions { undo_older_than_days: Some(14), ..only_gc(CleanupMode::Normal) }).await.unwrap();
    assert_eq!(result.steps[1], CleanupStepResult { step: CleanupStep::Undo, status: CleanupStepStatus::Done, removed: Some(3) });
    let mut kept = vec![f.young_entry.clone(), f.young_orphan.clone()];
    kept.sort();
    assert_eq!(backup_ref_ids(&repo), kept, "the 30-day entry, the 400-day orphan and the tree orphan are gone");
    let row = |entry: &str| tc.db.with(|c| crate::db::undo::get(c, entry)).unwrap().is_some();
    assert!(!row(&f.old_entry) && row(&f.young_entry));
}

#[tokio::test]
async fn lfs_prune_runs_as_a_step_and_reports_the_cache_sizes() {
    let (tc, repo, id) = setup().await;
    let Some(_remote) = lfs_fixture(&tc, &repo, &id).await else { return };
    let result = run_cleanup(&tc, &id, CleanupOptions { lfs: true, ..only_gc(CleanupMode::Normal) }).await.unwrap();
    assert_eq!(status_of(&result, CleanupStep::Lfs), CleanupStepStatus::Done);
    assert_eq!((result.lfs_before, result.lfs_after), (Some(15_000), Some(3_000)));
    assert_eq!(repo.read_file("daten/modell.bin"), vec![3u8; 3000], "the working file stays");
}

/// Starts a Normal run while `guard` is held, checks it waits and packs nothing, then lets it go.
async fn assert_waits_for(tc: &TestCore, repo: &TestRepo, id: &str, guard: WriteGuard, what: &str) {
    repo.commit_file(&format!("wartet {}.txt", util::new_id()), "lose\n", "Lose Objekte");
    let loose = git_count_objects(repo)["count"];
    let core = tc.core.clone();
    let repo_id = id.to_string();
    let running = tokio::spawn(async move { run_cleanup(&core, &repo_id, only_gc(CleanupMode::Normal)).await });
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(!running.is_finished(), "the run did not wait for the {what}");
    assert_eq!(git_count_objects(repo)["count"], loose, "nothing was packed while the {what} is held");
    drop(guard);
    let result = tokio::time::timeout(Duration::from_secs(60), running).await.expect("the run ends once the lock is free").unwrap().unwrap();
    assert_eq!(status_of(&result, CleanupStep::Gc), CleanupStepStatus::Done);
}

#[tokio::test]
async fn run_waits_for_the_network_lock_and_for_a_worktree_write_lock() {
    let (tc, repo, id) = setup().await;
    let worktree = repo.temp_dir().join("Baum zwei");
    repo.git(&["worktree", "add", "-q", "-b", "zwei", &worktree.to_string_lossy()]);
    let worktree_id = crate::commands::repos::repo_open(&tc, worktree.to_string_lossy().into_owned()).await.unwrap().repo.id;
    assert_ne!(worktree_id, id);
    let network = tc.network_lock(&id).await;
    assert_waits_for(&tc, &repo, &id, network, "network lock of the repository").await;
    let write = tc.write_lock(&worktree_id).await;
    assert_waits_for(&tc, &repo, &id, write, "write lock of the worktree").await;
    assert!(tc.try_network_lock(&id).is_some() && !tc.write_lock_held(&worktree_id), "all locks are free after the run");
}

#[tokio::test]
async fn cancelling_while_waiting_for_the_locks_changes_nothing() {
    let (tc, repo, id) = setup().await;
    repo.commit_file("lose.txt", "lose\n", "Lose Objekte");
    let before = repo.git(&["count-objects", "-v"]);
    let guard = tc.network_lock(&id).await;
    let core = tc.core.clone();
    let canceller = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        crate::commands::sync::job_cancel(&core, "job-wartet".into()).await.unwrap();
    });
    let err = repo_cleanup_run(&tc, id.clone(), "job-wartet".into(), only_gc(CleanupMode::Thorough)).await.unwrap_err();
    canceller.await.unwrap();
    drop(guard);
    assert_eq!(err.code, ErrorCode::Cancelled);
    assert_eq!(repo.git(&["count-objects", "-v"]), before);
    // Spec: a cancel before gc leaves a valid repository.
    repo.git(&["fsck", "--no-progress"]);
    let done = tc.events.named(names::JOB_DONE);
    assert_eq!((done.len(), done[0]["cancelled"].as_bool()), (1, Some(true)));
}

#[tokio::test]
async fn an_untrusted_repository_and_bad_options_are_refused_before_any_job() {
    let (tc, _repo, id) = setup().await;
    let bad = CleanupOptions { undo_older_than_days: Some(0), ..only_gc(CleanupMode::Normal) };
    assert_eq!(repo_cleanup_run(&tc, id.clone(), "job-a".into(), bad).await.unwrap_err().code, ErrorCode::NotAllowed);
    let too_long = CleanupOptions { undo_older_than_days: Some(3651), ..only_gc(CleanupMode::Normal) };
    assert_eq!(repo_cleanup_run(&tc, id.clone(), "job-b".into(), too_long).await.unwrap_err().code, ErrorCode::NotAllowed);
    tc.db.with(|c| crate::db::repos::set_trusted(c, &id, false)).unwrap();
    assert_eq!(repo_cleanup_run(&tc, id.clone(), "job-c".into(), only_gc(CleanupMode::Normal)).await.unwrap_err().code, ErrorCode::RepoUntrusted);
    assert_eq!(repo_cleanup_preview(&tc, id.clone()).await.unwrap_err().code, ErrorCode::RepoUntrusted);
    assert!(tc.events.named(names::JOB_DONE).is_empty(), "no job was started");
}

#[tokio::test]
async fn the_job_reports_waiting_each_step_and_done() {
    let (tc, repo, id) = setup().await;
    repo.commit_file("lose.txt", "lose\n", "Lose Objekte");
    tc.events.clear();
    run_cleanup(&tc, &id, CleanupOptions { reflog: true, ..only_gc(CleanupMode::Normal) }).await.unwrap();
    let lines: Vec<String> = tc.events.named(names::JOB_PROGRESS).iter().map(|event| event["line"].as_str().unwrap_or_default().to_string()).collect();
    assert_eq!(lines, ["waiting", "reflog", "gc"]);
    let done = tc.events.named(names::JOB_DONE);
    assert_eq!((done.len(), done[0]["ok"].as_bool()), (1, Some(true)));
    assert!(tc.events.named(names::REPO_CHANGED).iter().any(|event| event["repoId"] == id.as_str() && event["what"] == serde_json::json!(["refs"])));
}
