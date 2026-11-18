//! Hooks on the merge commit, on continue, and cleanup of the wrapper folders.

use super::*;
use crate::events::names;
use crate::testkit::{TestCore, TestRepo};

fn write_hook(repo: &TestRepo, name: &str, body: &str) {
    let dir = repo.path().join(".git").join("hooks");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join(name);
    std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

fn hook_events(tc: &TestCore) -> Vec<(String, String, i64)> {
    tc.events
        .named(names::HOOK_OUTPUT)
        .iter()
        .map(|e| (e["hook"].as_str().unwrap().to_string(), e["output"].as_str().unwrap().to_string(), e["exitCode"].as_i64().unwrap()))
        .collect()
}

fn ran(name: &str, output: &str, code: i64) -> (String, String, i64) {
    (name.to_string(), output.to_string(), code)
}

fn done_sha(result: &OpResult) -> String {
    match result {
        OpResult::Done { sha: Some(sha), .. } => sha.clone(),
        other => panic!("expected done with SHA, got: {other:?}"),
    }
}

fn merge_head(repo: &TestRepo) -> bool {
    repo.path().join(".git").join("MERGE_HEAD").exists()
}

fn hook_dirs(tc: &TestCore) -> usize {
    tc.data_dir().join(crate::commands::commit::HOOKS_TMP_DIR).read_dir().map(|d| d.count()).unwrap_or(0)
}

#[tokio::test]
async fn hooks_of_the_merge_commit_are_reported_and_can_refuse_it() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    repo.checkout_new("feature");
    repo.commit_file("f.txt", "f\n", "Feature");
    repo.checkout("main");
    let main = repo.commit_file("m.txt", "m\n", "Main");
    let id = tc.open(&repo).await.repo.id;
    write_hook(&repo, "pre-merge-commit", "echo 'Prüfung vor dem Merge' >&2\nexit 1");
    write_hook(&repo, "post-merge", "echo 'nach dem Merge'");
    tc.events.clear();

    let err = merge_start(&tc, id.clone(), "feature".into(), MergeMode::NoFf).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::HookFailed, "{err:?}");
    assert!(err.message.contains("pre-merge-commit") && err.message.contains("merge commit"), "{}", err.message);
    assert!(err.git_output.clone().unwrap_or_default().contains("Prüfung vor dem Merge"), "{err:?}");
    assert_eq!(hook_events(&tc), [ran("pre-merge-commit", "Prüfung vor dem Merge", 1)]);
    assert_eq!(repo.head(), main, "no merge commit");
    // Git leaves the merge pending without a conflict: continue commits it, the hooks run again.
    assert!(merge_head(&repo));
    write_hook(&repo, "pre-merge-commit", "exit 0");
    write_hook(&repo, "commit-msg", "echo 'Message geprüft'");
    tc.events.clear();
    let merged = done_sha(&operation_continue(&tc, id.clone(), None, None).await.unwrap());
    assert_eq!(repo.git(&["rev-list", "--parents", "-n", "1", &merged]).split_whitespace().count(), 3);
    assert!(hook_events(&tc).contains(&ran("commit-msg", "Message geprüft", 0)), "{:?}", hook_events(&tc));
    assert_eq!(undo::next_undo(&tc, &id, "").unwrap().unwrap().action, "merge");

    // A successful merge reports its hooks as well.
    repo.git(&["reset", "-q", "--hard", &main]);
    tc.events.clear();
    merge_start(&tc, id.clone(), "feature".into(), MergeMode::NoFf).await.unwrap();
    let events = hook_events(&tc);
    assert!(events.contains(&ran("commit-msg", "Message geprüft", 0)), "{events:?}");
    assert!(events.contains(&ran("post-merge", "nach dem Merge", 0)), "{events:?}");
    assert_eq!(hook_dirs(&tc), 0, "the wrappers are cleaned up");
}

#[tokio::test]
async fn a_hook_refusing_the_continue_commit_is_hook_failed() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    repo.checkout_new("feature");
    repo.commit_file("README.md", "# Feature\n", "Feature");
    repo.checkout("main");
    repo.commit_file("README.md", "# Main\n", "Main");
    let id = tc.open(&repo).await.repo.id;
    assert!(matches!(merge_start(&tc, id.clone(), "feature".into(), MergeMode::Default).await.unwrap(), OpResult::Conflict { .. }));
    conflict_resolve(&tc, id.clone(), "README.md".into(), None, Some(ConflictSide::Theirs)).await.unwrap();
    write_hook(&repo, "pre-commit", "echo 'Linter: Fehler' >&2\nexit 3");
    tc.events.clear();

    let err = operation_continue(&tc, id.clone(), None, None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::HookFailed, "{err:?}");
    assert!(err.message.contains("pre-commit") && err.message.contains("exit code 3"), "{}", err.message);
    assert_eq!(hook_events(&tc), [ran("pre-commit", "Linter: Fehler", 3)]);
    assert!(merge_head(&repo), "the merge is still in progress");
    assert!(undo::next_undo(&tc, &id, "").unwrap().is_none());

    write_hook(&repo, "pre-commit", "exit 0");
    done_sha(&operation_continue(&tc, id.clone(), None, None).await.unwrap());
    assert_eq!(hook_dirs(&tc), 0);
}

#[tokio::test]
async fn abort_works_with_stale_timestamps_in_the_index() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    repo.checkout_new("feature");
    repo.commit_file("a.txt", "feature\n", "Feature a");
    repo.commit_file("b.txt", "neu\n", "Feature b");
    repo.checkout("main");
    let main = repo.commit_file("a.txt", "main\n", "Main a");
    let id = tc.open(&repo).await.repo.id;
    assert!(matches!(merge_start(&tc, id.clone(), "feature".into(), MergeMode::Default).await.unwrap(), OpResult::Conflict { .. }));
    // Cleanly merged and staged: b.txt. Its content stays, only the timestamp changes – as after
    // copying the repository or when a tool merely touches the file.
    let file = std::fs::File::options().write(true).open(repo.path().join("b.txt")).unwrap();
    file.set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(120)).unwrap();
    drop(file);

    let status = operation_abort(&tc, id.clone()).await.unwrap();
    assert!(status.operation.is_none() && status.conflicted.is_empty(), "{status:?}");
    assert_eq!(repo.head(), main);
    assert!(!merge_head(&repo));
    assert!(!repo.path().join("b.txt").exists());
}

#[tokio::test]
async fn leftover_hook_folders_are_removed_at_startup() {
    let tc = TestCore::new().await;
    let root = tc.data_dir().join(crate::commands::commit::HOOKS_TMP_DIR);
    let old = root.join("alt");
    std::fs::create_dir_all(old.join("log")).unwrap();
    std::fs::write(old.join("log").join("order"), "pre-commit 0\n").unwrap();
    let fresh = root.join("frisch");
    std::fs::create_dir_all(&fresh).unwrap();
    // Only leftover folders go; a fresh one may belong to another instance.
    assert_eq!(crate::commands::commit::cleanup_hook_dirs(tc.data_dir(), std::time::Duration::from_secs(3600)), 0);
    assert!(old.exists() && fresh.exists());
    tc.startup_cleanup().await.unwrap();
    assert!(old.exists() && fresh.exists(), "fresh folders survive startup");
    assert_eq!(crate::commands::commit::cleanup_hook_dirs(tc.data_dir(), std::time::Duration::ZERO), 2);
    assert!(!old.exists() && !fresh.exists());
}
