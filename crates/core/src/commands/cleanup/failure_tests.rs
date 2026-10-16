//! Failures and cancel: another gc, foreign lock files, a full disk, cancel during gc.

use super::test_support::*;
use super::*;
use crate::error::ErrorCode;
use crate::events::names;
use crate::model::CleanupStep::{Gc, Lfs, Reflog, Undo, Worktrees};
use crate::model::CleanupStepStatus::{Done, Failed, NotRun, Skipped};
use crate::model::{CleanupMode, CleanupOptions, CleanupStep, CleanupStepStatus};
use crate::testkit::{TestCore, TestRepo};

/// Writes `gc.pid` like a running `git gc` and checks the run stops at its gc step with `locked`.
async fn assert_gc_refused(tc: &TestCore, repo: &TestRepo, id: &str, content: String, pid: u32) {
    let gc_pid = repo.path().join(".git").join("gc.pid");
    std::fs::write(&gc_pid, content).unwrap();
    let result = run_cleanup(tc, id, CleanupOptions { worktrees: true, ..only_gc(CleanupMode::Normal) }).await.unwrap();
    let failure = result.failure.clone().expect("gc refused");
    assert_eq!((failure.step, failure.error.code, failure.gc_pid, failure.disk_full), (CleanupStep::Gc, ErrorCode::Locked, Some(pid), false));
    assert_eq!(status_of(&result, CleanupStep::Worktrees), CleanupStepStatus::Done, "the step before gc ran");
    assert!(gc_pid.exists(), "Forkyard never removes Git's gc.pid");
    let done = tc.events.named(names::JOB_DONE);
    assert_eq!((done.last().unwrap()["ok"].as_bool(), done.last().unwrap()["cancelled"].as_bool()), (Some(false), Some(false)));
}

/// This machine's host name, as Git compares it in gc.pid.
#[cfg(unix)]
fn own_host_name() -> String {
    let mut buffer = [0u8; 256];
    // SAFETY: the buffer is writable for its whole length, and gethostname writes at most that much.
    let rc = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) };
    assert_eq!(rc, 0, "gethostname");
    let end = buffer.iter().position(|&b| b == 0).unwrap_or(buffer.len());
    String::from_utf8_lossy(&buffer[..end]).into_owned()
}

#[cfg(unix)]
#[tokio::test]
async fn a_running_gc_on_this_machine_is_reported_with_its_process() {
    let (tc, repo, id) = setup().await;
    // This test process is alive: Git takes its PID as the running gc.
    let pid = std::process::id();
    assert_gc_refused(&tc, &repo, &id, format!("{pid} {}", own_host_name()), pid).await;
}

#[tokio::test]
async fn a_gc_running_on_another_machine_is_respected() {
    let (tc, repo, id) = setup().await;
    assert_gc_refused(&tc, &repo, &id, "4711 forkyard-test-other-host".into(), 4711).await;
}

#[cfg(unix)]
#[tokio::test]
async fn a_stale_gc_pid_of_this_machine_does_not_block() {
    let (tc, repo, id) = setup().await;
    let mut child = std::process::Command::new("true").spawn().unwrap();
    let dead = child.id();
    child.wait().unwrap();
    std::fs::write(repo.path().join(".git").join("gc.pid"), format!("{dead} {}", own_host_name())).unwrap();
    let result = run_cleanup(&tc, &id, only_gc(CleanupMode::Normal)).await.unwrap();
    assert!(result.failure.is_none(), "Git sees the gc.pid of an ended process as stale: {:?}", result.failure);
}

#[tokio::test]
async fn a_foreign_ref_lock_stops_the_run_and_stays() {
    let (tc, repo, id) = setup().await;
    repo.commit_file("lose.txt", "noch lose\n", "Lose Objekte");
    undo_fixture(&tc, &repo, &id).await;
    let lock = repo.path().join(".git").join("refs").join("heads").join("main.lock");
    std::fs::write(&lock, "").unwrap();
    let loose = git_count_objects(&repo)["count"];
    let options = CleanupOptions { mode: CleanupMode::Thorough, lfs: false, worktrees: true, undo_older_than_days: Some(14), reflog: true };
    let result = run_cleanup(&tc, &id, options).await.unwrap();
    let statuses: Vec<_> = result.steps.iter().map(|entry| (entry.step, entry.status)).collect();
    assert_eq!(statuses, [(Worktrees, Done), (Undo, Done), (Reflog, Failed), (Lfs, Skipped), (Gc, NotRun)]);
    let failure = result.failure.expect("the reflog step failed");
    assert_eq!((failure.step, failure.error.code, failure.gc_pid), (CleanupStep::Reflog, ErrorCode::Locked, None));
    assert!(lock.exists(), "the foreign lock file is never deleted");
    assert_eq!(git_count_objects(&repo)["count"], loose, "gc did not run after the failed step");
    assert!(!result.cancelled);
}

#[tokio::test]
async fn a_foreign_index_lock_survives_a_normal_run() {
    let (tc, repo, id) = setup().await;
    repo.commit_file("lose.txt", "lose\n", "Lose Objekte");
    let lock = repo.path().join(".git").join("index.lock");
    std::fs::write(&lock, "von einem Editor").unwrap();
    let result = run_cleanup(&tc, &id, only_gc(CleanupMode::Normal)).await.unwrap();
    assert!(result.failure.is_none(), "gc does not need the index lock: {:?}", result.failure);
    assert_eq!(std::fs::read(&lock).unwrap(), b"von einem Editor", "the lock file is untouched");
    assert_eq!(git_count_objects(&repo)["count"], 0);
}

#[test]
fn a_full_disk_is_marked_for_the_dialog() {
    let error = crate::git::errors::classify("gc", Some(128), b"", b"fatal: write error: No space left on device\nerror: failed to run repack");
    let failure = run::failure_of(CleanupStep::Gc, error);
    assert!(failure.disk_full && failure.gc_pid.is_none());
    let other = run::failure_of(CleanupStep::Gc, crate::error::CoreError::io("Access denied."));
    assert!(!other.disk_full);
}

/// Git is a wrapper script that marks the start of `gc` and then sleeps 30 s; the cancel must end
/// it (process group) long before that.
#[cfg(unix)]
#[tokio::test]
async fn cancel_during_gc_ends_the_process_and_leaves_a_valid_repository() {
    use std::os::unix::fs::PermissionsExt;
    let bin = crate::testkit::temp_folder();
    let marker = bin.path().join("gc-gestartet");
    let real = which::which("git").expect("git on PATH");
    let script = bin.path().join("git");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nfor arg in \"$@\"; do\n  if [ \"$arg\" = gc ]; then\n    : > '{}'\n    sleep 30\n  fi\ndone\nexec '{}' \"$@\"\n",
            marker.display(),
            real.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    let tc = TestCore::with_git_path(script).await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    repo.commit_file("lose.txt", "lose\n", "Lose Objekte");
    record_plain_entry(&tc, &id, &repo.head(), &repo.head()).await;

    let core = tc.core.clone();
    let repo_id = id.clone();
    let running = tokio::spawn(async move { repo_cleanup_run(&core, repo_id, "job-gc-abbruch".into(), only_gc(CleanupMode::Thorough)).await });
    eventually("gc started", || marker.exists()).await;
    assert_ne!(repo.git(&["for-each-ref", "refs/forkyard/keep/"]), "", "keep refs are in place while gc runs");
    crate::commands::sync::job_cancel(&tc, "job-gc-abbruch".into()).await.unwrap();
    let result = tokio::time::timeout(std::time::Duration::from_secs(20), running).await.expect("the cancel ended gc").unwrap().unwrap();
    assert!(result.cancelled);
    assert_eq!(status_of(&result, CleanupStep::Gc), CleanupStepStatus::Cancelled);
    assert!(result.failure.is_none());
    assert_eq!(repo.git(&["for-each-ref", "refs/forkyard/keep/"]), "", "keep refs removed after the cancel");
    repo.git(&["fsck", "--no-progress"]);
    let done = tc.events.named(names::JOB_DONE);
    assert_eq!(done.last().unwrap()["cancelled"].as_bool(), Some(true));
}
