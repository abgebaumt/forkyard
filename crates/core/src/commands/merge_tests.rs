//! Tests for merge.rs against real temp repositories.

use super::*;
use crate::db::undo::UndoEntry;
use crate::events::names;
use crate::model::{FileChange, FileStatus};
use crate::testkit::{TestCore, TestRepo};

async fn open(tc: &TestCore, repo: &TestRepo) -> String {
    tc.open(repo).await.repo.id
}

fn last_undo(tc: &TestCore, id: &str) -> UndoEntry {
    undo::next_undo(tc, id, "").unwrap().expect("undo entry missing")
}

fn no_undo(tc: &TestCore, id: &str) -> bool {
    undo::next_undo(tc, id, "").unwrap().is_none()
}

fn paths(list: &[FileChange]) -> Vec<&str> {
    list.iter().map(|f| f.path.as_str()).collect()
}

fn find<'a>(list: &'a [FileChange], path: &str) -> &'a FileChange {
    list.iter().find(|f| f.path == path).unwrap_or_else(|| panic!("{path} missing in {list:?}"))
}

fn exists(repo: &TestRepo, rel: &str) -> bool {
    repo.path().join(rel).exists()
}

fn git_file(repo: &TestRepo, name: &str) -> std::path::PathBuf {
    repo.path().join(".git").join(name)
}

fn parent_count(repo: &TestRepo, rev: &str) -> usize {
    repo.git(&["rev-list", "--parents", "-n", "1", rev]).split_whitespace().count() - 1
}

fn backup_ref(repo: &TestRepo, entry: &UndoEntry, name: &str) -> Option<String> {
    let refname = undo::backup_ref_name(&entry.id, name);
    let out = repo.git_output(&["rev-parse", "-q", "--verify", &refname]);
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn conflict_files(result: &OpResult) -> Vec<String> {
    match result {
        OpResult::Conflict { files, .. } => files.clone(),
        other => panic!("expected conflict, got: {other:?}"),
    }
}

fn done_sha(result: &OpResult) -> String {
    match result {
        OpResult::Done { sha: Some(sha), .. } => sha.clone(),
        other => panic!("expected done with SHA, got: {other:?}"),
    }
}

/// main and feature diverge without touching each other.
fn diverged_repo() -> TestRepo {
    let repo = TestRepo::with_commit();
    repo.commit_file("a.txt", "basis\n", "Basis");
    repo.checkout_new("feature");
    repo.commit_file("feature.txt", "f\n", "Feature ergänzt Datei");
    repo.checkout("main");
    repo.commit_file("main.txt", "m\n", "Main ergänzt Datei");
    repo
}

/// main and feature both change the same two files: one with CRLF and a name with an
/// umlaut and a space, one without a final newline.
fn repo_with_two_conflicts() -> TestRepo {
    let repo = TestRepo::new();
    repo.write_file("ä b.txt", "eins\r\nzwei\r\ndrei\r\n");
    repo.write_file("ohne-nl.txt", "alpha\nbeta");
    repo.commit("Basis");
    repo.checkout_new("feature");
    repo.write_file("ä b.txt", "eins\r\nFEATURE\r\ndrei\r\n");
    repo.write_file("ohne-nl.txt", "alpha\nfeature");
    repo.write_file("nur-feature.txt", "f\n");
    repo.commit("Feature");
    repo.checkout("main");
    repo.write_file("ä b.txt", "eins\r\nMAIN\r\ndrei\r\n");
    repo.write_file("ohne-nl.txt", "alpha\nmain");
    repo.commit("Main");
    repo
}

// ---------------------------------------------------------------------------
// merge_start
// ---------------------------------------------------------------------------

#[tokio::test]
async fn merge_fast_forward() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let before = repo.head();
    repo.checkout_new("feature/x");
    let tip = repo.commit_file("neu.txt", "x\n", "Feature");
    repo.checkout("main");
    let id = open(&tc, &repo).await;
    tc.events.clear();

    let result = merge_start(&tc, id.clone(), "feature/x".into(), MergeMode::Default).await.unwrap();
    assert_eq!(
        result,
        OpResult::Done { sha: Some(tip.clone()), fast_forward: true, summary: "Merged feature/x into main (fast-forward)".into() }
    );
    assert_eq!(repo.head(), tip);
    assert_eq!(repo.current_branch(), "main");
    assert_eq!(repo.read_file("neu.txt"), b"x\n");

    let changed = tc.events.named(names::REPO_CHANGED);
    assert_eq!(changed.len(), 1, "{changed:?}");
    assert_eq!(changed[0]["what"], serde_json::json!(["worktree", "index", "refs", "head", "operation"]));

    let entry = last_undo(&tc, &id);
    assert_eq!(entry.action, "merge");
    assert_eq!(entry.label, "Undo merge of feature/x into main");
    assert_eq!(entry.ref_name.as_deref(), Some("refs/heads/main"));
    assert_eq!((entry.ref_before.as_deref(), entry.ref_after.as_deref()), (Some(before.as_str()), Some(tip.as_str())));
    assert_eq!((entry.head_before.as_str(), entry.head_after.as_deref()), ("refs/heads/main", Some("refs/heads/main")));
    assert_eq!(entry.payload["branch"], "main");
    assert_eq!(entry.payload["fastForward"], true);
    assert_eq!(entry.payload["summary"], "Feature");

    // Once more: nothing left to do.
    assert_eq!(merge_start(&tc, id.clone(), "feature/x".into(), MergeMode::Default).await.unwrap(), OpResult::UpToDate);
    assert_eq!(merge_start(&tc, id, "main".into(), MergeMode::Squash).await.unwrap(), OpResult::UpToDate);
}

#[tokio::test]
async fn merge_creates_a_merge_commit_when_branches_diverged() {
    let tc = TestCore::new().await;
    let repo = diverged_repo();
    let before = repo.head();
    let theirs = repo.git(&["rev-parse", "feature"]);
    // An uncommitted change the merge does not touch stays.
    repo.write_file("a.txt", "lokal\n");
    let id = open(&tc, &repo).await;

    let result = merge_start(&tc, id.clone(), "feature".into(), MergeMode::Default).await.unwrap();
    let sha = done_sha(&result);
    assert!(matches!(&result, OpResult::Done { fast_forward: false, summary, .. } if summary == "Merged feature into main"), "{result:?}");
    assert_eq!(repo.head(), sha);
    assert_eq!(repo.git(&["rev-list", "--parents", "-n", "1", "HEAD"]), format!("{sha} {before} {theirs}"));
    assert_eq!(repo.git(&["log", "-1", "--format=%s"]), "Merge branch 'feature'");
    assert_eq!(repo.read_file("feature.txt"), b"f\n");
    assert_eq!(repo.read_file("a.txt"), b"lokal\n");

    let status = read_status(&tc, &id).await.unwrap();
    assert_eq!(status.operation, None);
    assert_eq!(paths(&status.unstaged), vec!["a.txt"]);
    let entry = last_undo(&tc, &id);
    assert_eq!((entry.action.as_str(), entry.ref_before.as_deref(), entry.ref_after.as_deref()), ("merge", Some(before.as_str()), Some(sha.as_str())));
    assert_eq!(entry.payload["fastForward"], false);
}

#[tokio::test]
async fn merge_modes_no_ff_and_ff_only() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let base = repo.head();
    repo.checkout_new("feature");
    let tip = repo.commit_file("neu.txt", "x\n", "Feature");
    repo.checkout("main");
    let id = open(&tc, &repo).await;

    // no_ff: merge commit even though a fast-forward would be possible.
    let result = merge_start(&tc, id.clone(), "feature".into(), MergeMode::NoFf).await.unwrap();
    assert!(matches!(result, OpResult::Done { fast_forward: false, .. }), "{result:?}");
    assert_eq!(parent_count(&repo, "HEAD"), 2);

    // ff_only: works as long as nothing has diverged.
    repo.git(&["reset", "-q", "--hard", &base]);
    let result = merge_start(&tc, id.clone(), "feature".into(), MergeMode::FfOnly).await.unwrap();
    assert!(matches!(result, OpResult::Done { fast_forward: true, .. }), "{result:?}");
    assert_eq!(repo.head(), tip);

    // … and is refused otherwise, without changing anything.
    repo.git(&["reset", "-q", "--hard", &base]);
    let main_tip = repo.commit_file("main.txt", "m\n", "Main");
    let err = merge_start(&tc, id.clone(), "feature".into(), MergeMode::FfOnly).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    assert!(err.message.contains("Fast-forward isn’t possible"), "{}", err.message);
    assert_eq!(repo.head(), main_tip);
    assert!(!git_file(&repo, "MERGE_HEAD").exists());
}

#[tokio::test]
async fn merge_squash_stages_the_result_without_commit() {
    let tc = TestCore::new().await;
    let repo = diverged_repo();
    let before = repo.head();
    repo.write_file("a.txt", "lokal\n");
    let id = open(&tc, &repo).await;

    let result = merge_start(&tc, id.clone(), "feature".into(), MergeMode::Squash).await.unwrap();
    assert!(matches!(&result, OpResult::Done { sha: None, fast_forward: false, summary } if summary.contains("Squash")), "{result:?}");
    assert_eq!(repo.head(), before);
    assert!(!git_file(&repo, "MERGE_HEAD").exists());

    let status = read_status(&tc, &id).await.unwrap();
    assert_eq!(status.operation, None);
    assert_eq!(paths(&status.staged), vec!["feature.txt"]);
    assert_eq!(find(&status.staged, "feature.txt").status, FileStatus::Added);
    assert_eq!(paths(&status.unstaged), vec!["a.txt"]);

    // The entry records the state before: the ref does not move.
    let entry = last_undo(&tc, &id);
    assert_eq!(entry.action, "merge");
    assert_eq!(entry.payload["squash"], true);
    assert_eq!((entry.ref_before.as_deref(), entry.ref_after.as_deref()), (Some(before.as_str()), Some(before.as_str())));
    let snapshot = entry.payload["worktreeSnapshot"].as_str().expect("backup").to_string();
    assert_eq!(backup_ref(&repo, &entry, "worktree"), Some(snapshot.clone()));
    assert_eq!(repo.git(&["show", &format!("{snapshot}:a.txt")]), "lokal");
    assert!(!repo.git_output(&["cat-file", "-e", &format!("{snapshot}:feature.txt")]).status.success());
    assert_eq!(repo.git(&["rev-parse", &format!("{snapshot}^")]), before);
}

#[tokio::test]
async fn merge_squash_conflict_has_no_operation() {
    let tc = TestCore::new().await;
    let repo = repo_with_two_conflicts();
    let id = open(&tc, &repo).await;

    let result = merge_start(&tc, id.clone(), "feature".into(), MergeMode::Squash).await.unwrap();
    assert_eq!(result, OpResult::Conflict { files: vec!["ohne-nl.txt".into(), "ä b.txt".into()], operation: None, note: None });
    let file = conflict_get(&tc, id.clone(), "ohne-nl.txt".into()).await.unwrap();
    assert_eq!((file.ours_label.as_str(), file.theirs_label.as_str()), ("main", "Incoming change"));
    // Without MERGE_HEAD there is nothing to continue, and a second merge is not reported as a new conflict.
    assert_eq!(operation_continue(&tc, id.clone(), None, None).await.unwrap_err().code, ErrorCode::NoOperation);
    assert_eq!(merge_start(&tc, id, "feature".into(), MergeMode::Default).await.unwrap_err().code, ErrorCode::Conflict);
}

#[tokio::test]
async fn merge_remote_branch_sha_and_detached_head() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let base = repo.head();
    repo.checkout_new("feature");
    let tip = repo.commit_file("neu.txt", "x\n", "Feature");
    repo.checkout("main");
    repo.git(&["update-ref", "refs/remotes/origin/feature", &tip]);
    repo.git(&["branch", "-q", "-D", "feature"]);
    let id = open(&tc, &repo).await;

    let result = merge_start(&tc, id.clone(), "origin/feature".into(), MergeMode::NoFf).await.unwrap();
    assert!(matches!(&result, OpResult::Done { summary, .. } if summary == "Merged origin/feature into main"), "{result:?}");
    assert_eq!(repo.git(&["log", "-1", "--format=%s"]), "Merge remote-tracking branch 'origin/feature'");

    // SHA as source: the message names the short SHA.
    repo.git(&["reset", "-q", "--hard", &base]);
    let result = merge_start(&tc, id.clone(), tip.clone(), MergeMode::Default).await.unwrap();
    assert!(
        matches!(&result, OpResult::Done { fast_forward: true, summary, .. } if summary.starts_with(&format!("Merged {} into main", &tip[..7]))),
        "{result:?}"
    );

    // Detached HEAD: the merge only moves HEAD.
    repo.git(&["checkout", "-q", "--detach", &base]);
    let result = merge_start(&tc, id.clone(), "origin/feature".into(), MergeMode::Default).await.unwrap();
    assert_eq!(done_sha(&result), tip);
    let entry = last_undo(&tc, &id);
    assert_eq!(entry.ref_name, None);
    assert_eq!((entry.head_before.as_str(), entry.head_after.as_deref()), (base.as_str(), Some(tip.as_str())));
    assert_eq!(entry.label, format!("Undo merge of origin/feature into {}", &base[..7]));
}

#[tokio::test]
async fn merge_prefers_the_branch_over_a_tag_of_the_same_name() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let base = repo.head();
    // A tag "feature" on the old state and a branch "feature" ahead of it.
    repo.tag("feature");
    repo.checkout_new("feature");
    let tip = repo.commit_file("neu.txt", "x\n", "Feature");
    repo.checkout("main");
    let id = open(&tc, &repo).await;

    let result = merge_start(&tc, id.clone(), "feature".into(), MergeMode::NoFf).await.unwrap();
    assert!(matches!(&result, OpResult::Done { summary, .. } if summary == "Merged feature into main"), "{result:?}");
    assert_eq!(repo.git(&["rev-parse", "HEAD^2"]), tip);

    // Full ref name and tag as source.
    repo.git(&["reset", "-q", "--hard", &base]);
    repo.git(&["tag", "v1.0", &tip]);
    let result = merge_start(&tc, id.clone(), "refs/heads/feature".into(), MergeMode::FfOnly).await.unwrap();
    assert!(matches!(&result, OpResult::Done { summary, .. } if summary.starts_with("Merged feature into main")), "{result:?}");
    repo.git(&["reset", "-q", "--hard", &base]);
    let result = merge_start(&tc, id, "v1.0".into(), MergeMode::Default).await.unwrap();
    assert!(matches!(&result, OpResult::Done { fast_forward: true, summary, .. } if summary.starts_with("Merged v1.0 into main")), "{result:?}");
    assert_eq!(repo.head(), tip);
}

#[tokio::test]
async fn merge_conflict_and_hard_reset_in_a_linked_worktree() {
    let tc = TestCore::new().await;
    let repo = repo_with_two_conflicts();
    let main_sha = repo.head();
    let other = repo.temp_dir().join("zweites");
    repo.git(&["worktree", "add", "-q", "-b", "anderswo", &other.to_string_lossy()]);
    let id = crate::commands::repos::repo_open(&tc, other.to_string_lossy().into_owned()).await.unwrap().repo.id;
    let state_dir = status::git_dir(&tc, &id).await.unwrap();
    assert!(state_dir.ends_with("zweites"), "{state_dir:?}");

    let result = merge_start(&tc, id.clone(), "feature".into(), MergeMode::Default).await.unwrap();
    assert_eq!(conflict_files(&result), vec!["ohne-nl.txt", "ä b.txt"]);
    assert!(state_dir.join("MERGE_HEAD").is_file());
    let status = operation_abort(&tc, id.clone()).await.unwrap();
    assert!(status.operation.is_none() && status.conflicted.is_empty());

    merge_start(&tc, id.clone(), "feature".into(), MergeMode::Default).await.unwrap();
    let file = conflict_get(&tc, id.clone(), "ohne-nl.txt".into()).await.unwrap();
    assert_eq!((file.ours_label.as_str(), file.theirs_label.as_str()), ("anderswo", "feature"));
    conflict_resolve(&tc, id.clone(), "ohne-nl.txt".into(), None, Some(ConflictSide::Ours)).await.unwrap();
    conflict_resolve(&tc, id.clone(), "ä b.txt".into(), Some("eins\nBEIDES\ndrei\n".into()), None).await.unwrap();
    assert_eq!(std::fs::read(other.join("ä b.txt")).unwrap(), b"eins\r\nBEIDES\r\ndrei\r\n");
    let merged = done_sha(&operation_continue(&tc, id.clone(), None, None).await.unwrap());
    assert_eq!(repo.git(&["rev-parse", "anderswo"]), merged);

    // Hard reset in the second worktree: the backup goes through its own index.
    std::fs::write(other.join("ohne-nl.txt"), "lokal").unwrap();
    let status = reset_branch(&tc, id.clone(), main_sha.clone(), ResetMode::Hard).await.unwrap();
    assert_eq!(status.head, Head::Branch { branch: "anderswo".into(), sha: main_sha.clone() });
    assert!(status.unstaged.is_empty() && status.staged.is_empty());
    let entry = last_undo(&tc, &id);
    assert_eq!(entry.ref_name.as_deref(), Some("refs/heads/anderswo"));
    assert_eq!(backup_ref(&repo, &entry, "before"), Some(merged));
    let snapshot = entry.payload["worktreeSnapshot"].as_str().unwrap().to_string();
    assert_eq!(repo.git(&["show", &format!("{snapshot}:ohne-nl.txt")]), "lokal");
    let leftovers = std::fs::read_dir(&state_dir).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().starts_with("forkyard")).count();
    assert_eq!(leftovers, 0);

    // The first worktree noticed none of it.
    assert_eq!(repo.head(), main_sha);
    assert_eq!(repo.read_file("ohne-nl.txt"), b"alpha\nmain");
    assert!(repo.git(&["status", "--porcelain"]).is_empty());
}

#[tokio::test]
async fn merge_refuses_when_local_changes_would_be_overwritten() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    repo.commit_file("a.txt", "basis\n", "Basis");
    repo.checkout_new("feature");
    repo.write_file("a.txt", "feature\n");
    repo.write_file("neu datei.txt", "feature\n");
    repo.commit("Feature");
    repo.checkout("main");
    let before = repo.head();
    let id = open(&tc, &repo).await;

    // Tracked file with an uncommitted change.
    repo.write_file("a.txt", "lokal\n");
    let err = merge_start(&tc, id.clone(), "feature".into(), MergeMode::Default).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::DirtyWorktree, "{err:?}");
    assert!(err.git_output.is_some());
    assert_eq!(repo.read_file("a.txt"), b"lokal\n");
    assert_eq!(repo.head(), before);
    assert!(no_undo(&tc, &id));

    // Untracked file the merge would create.
    repo.write_file("a.txt", "basis\n");
    repo.write_file("neu datei.txt", "meins\n");
    let err = merge_start(&tc, id.clone(), "feature".into(), MergeMode::Default).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::DirtyWorktree, "{err:?}");
    assert_eq!(repo.read_file("neu datei.txt"), b"meins\n");
    assert_eq!(repo.head(), before);

    // Also for a real merge (no fast-forward).
    repo.remove_file("neu datei.txt");
    repo.commit_file("main.txt", "m\n", "Main");
    repo.write_file("a.txt", "lokal\n");
    let err = merge_start(&tc, id.clone(), "feature".into(), MergeMode::Default).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::DirtyWorktree, "{err:?}");
    assert_eq!(read_status(&tc, &id).await.unwrap().operation, None);
}

#[tokio::test]
async fn merge_error_cases() {
    let tc = TestCore::new().await;

    // Repository without a commit.
    let empty = TestRepo::new();
    let id = open(&tc, &empty).await;
    assert_eq!(merge_start(&tc, id, "feature".into(), MergeMode::Default).await.unwrap_err().code, ErrorCode::NotAllowed);

    let repo = repo_with_two_conflicts();
    let id = open(&tc, &repo).await;
    for unknown in ["gibt-es-nicht", "", "--abort", "0000000000000000000000000000000000000000"] {
        let err = merge_start(&tc, id.clone(), unknown.into(), MergeMode::Default).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound, "{unknown}: {err:?}");
    }

    // Histories without a common ancestor.
    repo.git(&["checkout", "-q", "--orphan", "fremd"]);
    repo.git(&["rm", "-rf", "-q", "."]);
    repo.commit_file("fremd.txt", "x\n", "Fremde Historie");
    repo.checkout("main");
    let err = merge_start(&tc, id.clone(), "fremd".into(), MergeMode::Default).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed, "{err:?}");
    assert!(err.message.contains("common ancestor"));

    // Foreign index.lock: understandable error, the lock file stays.
    let before = repo.head();
    let lock = git_file(&repo, "index.lock");
    std::fs::write(&lock, "").unwrap();
    let err = merge_start(&tc, id.clone(), "feature".into(), MergeMode::Default).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Locked, "{err:?}");
    assert!(lock.exists());
    assert_eq!(repo.head(), before);
    std::fs::remove_file(&lock).unwrap();

    // Running operation.
    assert!(!repo.merge("feature"));
    for mode in [MergeMode::Default, MergeMode::Squash] {
        let err = merge_start(&tc, id.clone(), "feature".into(), mode).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::OperationInProgress);
        assert!(err.message.contains("a merge"), "{}", err.message);
    }
}

#[tokio::test]
async fn merge_without_identity() {
    let tc = TestCore::new().await;
    let repo = diverged_repo();
    repo.git(&["config", "--unset", "user.name"]);
    repo.git(&["config", "--unset", "user.email"]);
    let before = repo.head();
    let id = open(&tc, &repo).await;

    // A merge commit needs an identity; without one nothing is even started.
    let err = merge_start(&tc, id.clone(), "feature".into(), MergeMode::Default).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::IdentityMissing);
    assert_eq!(repo.head(), before);
    let status = read_status(&tc, &id).await.unwrap();
    assert!(status.staged.is_empty() && status.unstaged.is_empty() && status.operation.is_none());

    // Fast-forward works without one.
    repo.git(&["branch", "voraus", "feature"]);
    repo.checkout("feature");
    let result = merge_start(&tc, id, "voraus".into(), MergeMode::Default).await.unwrap();
    assert_eq!(result, OpResult::UpToDate);
    repo.checkout("main");
    repo.git(&["reset", "-q", "--hard", "HEAD~1"]);
    let id = open(&tc, &repo).await;
    let result = merge_start(&tc, id, "feature".into(), MergeMode::Default).await.unwrap();
    assert!(matches!(result, OpResult::Done { fast_forward: true, .. }), "{result:?}");
}

// ---------------------------------------------------------------------------
// Conflicts
// ---------------------------------------------------------------------------

#[tokio::test]
async fn conflict_in_two_files_resolved_by_content_and_side() {
    let tc = TestCore::new().await;
    let repo = repo_with_two_conflicts();
    let before = repo.head();
    let theirs = repo.git(&["rev-parse", "feature"]);
    let id = open(&tc, &repo).await;

    let result = merge_start(&tc, id.clone(), "feature".into(), MergeMode::Default).await.unwrap();
    assert_eq!(conflict_files(&result), vec!["ohne-nl.txt", "ä b.txt"]);
    let OpResult::Conflict { operation: Some(op), .. } = &result else { panic!("{result:?}") };
    assert_eq!((op.kind, op.source.as_deref(), op.target.as_deref()), (OperationKind::Merge, Some("feature"), Some("main")));
    assert!(no_undo(&tc, &id));

    let file = conflict_get(&tc, id.clone(), "ä b.txt".into()).await.unwrap();
    assert_eq!(file.path, "ä b.txt");
    assert_eq!(file.kind, ConflictKind::BothModified);
    assert_eq!(file.base.as_deref(), Some("eins\r\nzwei\r\ndrei\r\n"));
    assert_eq!(file.ours.as_deref(), Some("eins\r\nMAIN\r\ndrei\r\n"));
    assert_eq!(file.theirs.as_deref(), Some("eins\r\nFEATURE\r\ndrei\r\n"));
    let merged = file.merged.clone().expect("content with markers");
    assert!(merged.contains("<<<<<<< HEAD") && merged.contains("=======") && merged.contains(">>>>>>> feature"), "{merged}");
    assert!(!file.is_binary);
    assert_eq!((file.ours_label.as_str(), file.theirs_label.as_str()), ("main", "feature"));
    assert_eq!(file.encoding.as_deref(), Some("utf-8"));

    // Content with markers is refused and changes nothing.
    let err = conflict_resolve(&tc, id.clone(), "ä b.txt".into(), Some(merged.clone()), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    assert!(err.message.contains("conflict markers"), "{}", err.message);
    assert_eq!(read_status(&tc, &id).await.unwrap().conflicted.len(), 2);

    // Content with LF from the UI: it is written with the file's CRLF.
    tc.events.clear();
    let status = conflict_resolve(&tc, id.clone(), "ä b.txt".into(), Some("eins\nBEIDES\ndrei\n".into()), None).await.unwrap();
    assert_eq!(repo.read_file("ä b.txt"), b"eins\r\nBEIDES\r\ndrei\r\n");
    assert_eq!(paths(&status.conflicted), vec!["ohne-nl.txt"]);
    assert!(paths(&status.staged).contains(&"ä b.txt"), "{:?}", status.staged);
    assert_eq!(tc.events.named(names::REPO_CHANGED)[0]["what"], serde_json::json!(["worktree", "index"]));
    assert_eq!(conflict_get(&tc, id.clone(), "ä b.txt".into()).await.unwrap_err().code, ErrorCode::NotFound);

    // As long as a conflict is open, continue reports the list and does not commit.
    let result = operation_continue(&tc, id.clone(), None, None).await.unwrap();
    assert_eq!(conflict_files(&result), vec!["ohne-nl.txt"]);
    assert!(git_file(&repo, "MERGE_HEAD").exists());
    assert_eq!(repo.head(), before);

    let file = conflict_get(&tc, id.clone(), "ohne-nl.txt".into()).await.unwrap();
    assert_eq!((file.ours.as_deref(), file.theirs.as_deref()), (Some("alpha\nmain"), Some("alpha\nfeature")));
    let status = conflict_resolve(&tc, id.clone(), "ohne-nl.txt".into(), None, Some(ConflictSide::Theirs)).await.unwrap();
    assert_eq!(repo.read_file("ohne-nl.txt"), b"alpha\nfeature");
    assert!(status.conflicted.is_empty());
    assert_eq!(status.operation.as_ref().map(|o| o.kind), Some(OperationKind::Merge));

    tc.events.clear();
    let result = operation_continue(&tc, id.clone(), None, None).await.unwrap();
    let sha = done_sha(&result);
    assert!(matches!(&result, OpResult::Done { fast_forward: false, summary, .. } if summary == "Merged feature into main"), "{result:?}");
    assert_eq!(repo.git(&["rev-list", "--parents", "-n", "1", "HEAD"]), format!("{sha} {before} {theirs}"));
    let message = repo.git(&["log", "-1", "--format=%B"]);
    assert!(message.starts_with("Merge branch 'feature'"), "{message}");
    assert!(!message.contains('#') && !message.contains("Conflicts"), "{message}");
    assert_eq!(repo.read_file("nur-feature.txt"), b"f\n");
    assert!(tc.events.named(names::REPO_CHANGED)[0]["what"].as_array().unwrap().contains(&serde_json::json!("operation")));

    let status = read_status(&tc, &id).await.unwrap();
    assert!(status.operation.is_none() && status.conflicted.is_empty() && status.staged.is_empty() && status.unstaged.is_empty());
    let entry = last_undo(&tc, &id);
    assert_eq!(entry.action, "merge");
    assert_eq!(entry.label, "Undo merge of feature into main");
    assert_eq!(entry.ref_name.as_deref(), Some("refs/heads/main"));
    assert_eq!((entry.ref_before.as_deref(), entry.ref_after.as_deref()), (Some(before.as_str()), Some(sha.as_str())));
}

#[tokio::test]
async fn conflict_content_keeps_missing_final_newline_and_custom_message() {
    let tc = TestCore::new().await;
    let repo = repo_with_two_conflicts();
    let id = open(&tc, &repo).await;
    merge_start(&tc, id.clone(), "feature".into(), MergeMode::Default).await.unwrap();

    conflict_resolve(&tc, id.clone(), "ohne-nl.txt".into(), Some("alpha\nbeides".into()), None).await.unwrap();
    assert_eq!(repo.read_file("ohne-nl.txt"), b"alpha\nbeides");
    // The UI may also send CRLF already; it is not doubled.
    conflict_resolve(&tc, id.clone(), "ä b.txt".into(), Some("eins\r\nBEIDES\r\ndrei".into()), None).await.unwrap();
    assert_eq!(repo.read_file("ä b.txt"), b"eins\r\nBEIDES\r\ndrei");

    let message = "Zusammenführung von Hand\n\n#42 bleibt stehen\nzweite Zeile";
    let result = operation_continue(&tc, id.clone(), Some(message.into()), None).await.unwrap();
    assert!(matches!(result, OpResult::Done { .. }), "{result:?}");
    assert_eq!(repo.git(&["log", "-1", "--format=%B"]), message);
    assert_eq!(parent_count(&repo, "HEAD"), 2);
}

#[tokio::test]
async fn conflict_in_binary_file() {
    let tc = TestCore::new().await;
    let repo = TestRepo::new();
    repo.commit_file("bild.bin", [0u8, 1, 2, 3, 255], "Basis");
    repo.checkout_new("feature");
    repo.commit_file("bild.bin", [0u8, 9, 9, 9, 255, 7], "Feature");
    repo.checkout("main");
    repo.commit_file("bild.bin", [0u8, 5, 5, 5, 255], "Main");
    let id = open(&tc, &repo).await;

    let result = merge_start(&tc, id.clone(), "feature".into(), MergeMode::Default).await.unwrap();
    assert_eq!(conflict_files(&result), vec!["bild.bin"]);
    let file = conflict_get(&tc, id.clone(), "bild.bin".into()).await.unwrap();
    assert!(file.is_binary);
    assert_eq!(file.encoding, None, "a binary file has no encoding");
    assert_eq!(file.kind, ConflictKind::BothModified);
    assert_eq!((file.base, file.ours, file.theirs, file.merged), (None, None, None, None));

    let err = conflict_resolve(&tc, id.clone(), "bild.bin".into(), Some("text".into()), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    assert!(err.message.contains("binary file"), "{}", err.message);
    assert_eq!(repo.read_file("bild.bin"), [0u8, 5, 5, 5, 255]);

    let status = conflict_resolve(&tc, id.clone(), "bild.bin".into(), None, Some(ConflictSide::Theirs)).await.unwrap();
    assert!(status.conflicted.is_empty());
    assert_eq!(repo.read_file("bild.bin"), [0u8, 9, 9, 9, 255, 7]);
    assert!(matches!(operation_continue(&tc, id, None, None).await.unwrap(), OpResult::Done { .. }));
    assert_eq!(repo.read_file("bild.bin"), [0u8, 9, 9, 9, 255, 7]);
}

/// Conflicts where one side is missing: deleted/modified in both directions and a rename
/// to two different names.
fn repo_with_delete_conflicts() -> TestRepo {
    let repo = TestRepo::new();
    repo.write_file("von-uns-geloescht.txt", "basis\n");
    repo.write_file("von-denen-geloescht.txt", "basis\n");
    repo.write_file("umbenannt.txt", "eins\nzwei\ndrei\nvier\n");
    repo.commit("Basis");
    repo.checkout_new("feature");
    repo.write_file("von-uns-geloescht.txt", "feature\n");
    repo.remove_file("von-denen-geloescht.txt");
    repo.git(&["mv", "umbenannt.txt", "name-von-denen.txt"]);
    repo.commit("Feature");
    repo.checkout("main");
    repo.remove_file("von-uns-geloescht.txt");
    repo.write_file("von-denen-geloescht.txt", "main\n");
    repo.git(&["mv", "umbenannt.txt", "name-von-uns.txt"]);
    repo.commit("Main");
    repo
}

#[tokio::test]
async fn delete_modify_conflicts_taking_the_deleting_side() {
    let tc = TestCore::new().await;
    let repo = repo_with_delete_conflicts();
    let id = open(&tc, &repo).await;
    let result = merge_start(&tc, id.clone(), "feature".into(), MergeMode::Default).await.unwrap();
    assert_eq!(
        conflict_files(&result),
        vec!["name-von-denen.txt", "name-von-uns.txt", "umbenannt.txt", "von-denen-geloescht.txt", "von-uns-geloescht.txt"]
    );

    let file = conflict_get(&tc, id.clone(), "von-uns-geloescht.txt".into()).await.unwrap();
    assert_eq!(file.kind, ConflictKind::DeletedByUs);
    assert_eq!((file.base.as_deref(), file.ours.as_deref(), file.theirs.as_deref()), (Some("basis\n"), None, Some("feature\n")));
    assert_eq!(file.merged.as_deref(), Some("feature\n"));
    let file = conflict_get(&tc, id.clone(), "von-denen-geloescht.txt".into()).await.unwrap();
    assert_eq!(file.kind, ConflictKind::DeletedByThem);
    assert_eq!((file.ours.as_deref(), file.theirs.as_deref()), (Some("main\n"), None));
    let file = conflict_get(&tc, id.clone(), "umbenannt.txt".into()).await.unwrap();
    assert_eq!(file.kind, ConflictKind::BothDeleted);
    assert_eq!((file.ours, file.theirs, file.merged), (None, None, None));
    assert!(file.base.is_some());
    assert_eq!(conflict_get(&tc, id.clone(), "name-von-uns.txt".into()).await.unwrap().kind, ConflictKind::AddedByUs);
    assert_eq!(conflict_get(&tc, id.clone(), "name-von-denen.txt".into()).await.unwrap().kind, ConflictKind::AddedByThem);

    // Taking the side that deleted means: delete the file.
    conflict_resolve(&tc, id.clone(), "von-uns-geloescht.txt".into(), None, Some(ConflictSide::Ours)).await.unwrap();
    assert!(!exists(&repo, "von-uns-geloescht.txt"));
    conflict_resolve(&tc, id.clone(), "von-denen-geloescht.txt".into(), None, Some(ConflictSide::Theirs)).await.unwrap();
    assert!(!exists(&repo, "von-denen-geloescht.txt"));
    conflict_resolve(&tc, id.clone(), "umbenannt.txt".into(), None, Some(ConflictSide::Ours)).await.unwrap();
    // Rename: the other side's name wins.
    conflict_resolve(&tc, id.clone(), "name-von-uns.txt".into(), None, Some(ConflictSide::Theirs)).await.unwrap();
    let status = conflict_resolve(&tc, id.clone(), "name-von-denen.txt".into(), None, Some(ConflictSide::Theirs)).await.unwrap();
    assert!(status.conflicted.is_empty(), "{:?}", status.conflicted);
    assert!(!exists(&repo, "name-von-uns.txt") && !exists(&repo, "umbenannt.txt"));
    assert_eq!(repo.read_file("name-von-denen.txt"), b"eins\nzwei\ndrei\nvier\n");

    assert!(matches!(operation_continue(&tc, id, None, None).await.unwrap(), OpResult::Done { .. }));
    assert_eq!(repo.git(&["ls-tree", "-r", "--name-only", "HEAD"]), "name-von-denen.txt");
}

#[tokio::test]
async fn delete_modify_conflicts_keeping_the_file() {
    let tc = TestCore::new().await;
    let repo = repo_with_delete_conflicts();
    let id = open(&tc, &repo).await;
    merge_start(&tc, id.clone(), "feature".into(), MergeMode::Default).await.unwrap();

    conflict_resolve(&tc, id.clone(), "von-uns-geloescht.txt".into(), None, Some(ConflictSide::Theirs)).await.unwrap();
    assert_eq!(repo.read_file("von-uns-geloescht.txt"), b"feature\n");
    conflict_resolve(&tc, id.clone(), "von-denen-geloescht.txt".into(), None, Some(ConflictSide::Ours)).await.unwrap();
    assert_eq!(repo.read_file("von-denen-geloescht.txt"), b"main\n");
    conflict_resolve(&tc, id.clone(), "umbenannt.txt".into(), None, Some(ConflictSide::Theirs)).await.unwrap();
    conflict_resolve(&tc, id.clone(), "name-von-denen.txt".into(), None, Some(ConflictSide::Ours)).await.unwrap();
    assert!(!exists(&repo, "name-von-denen.txt"));
    // A file that does not exist on one side can also be resolved with custom content.
    let status = conflict_resolve(&tc, id.clone(), "name-von-uns.txt".into(), Some("neu\n".into()), None).await.unwrap();
    assert!(status.conflicted.is_empty(), "{:?}", status.conflicted);
    assert_eq!(repo.read_file("name-von-uns.txt"), b"neu\n");

    assert!(matches!(operation_continue(&tc, id, None, None).await.unwrap(), OpResult::Done { .. }));
    assert_eq!(
        repo.git(&["ls-tree", "-r", "--name-only", "HEAD"]),
        "name-von-uns.txt\nvon-denen-geloescht.txt\nvon-uns-geloescht.txt"
    );
}

#[tokio::test]
async fn conflict_keeps_encoding_bom_and_known_marker_lines() {
    let tc = TestCore::new().await;
    let repo = TestRepo::new();
    repo.write_file("alt.txt", b"Gr\xfc\xdfe\nzwei\n");
    repo.write_file("bom.txt", b"\xEF\xBB\xBFeins\nzwei\n");
    repo.write_file("doku.md", "Titel\n=======\n\nText\n");
    repo.commit("Basis");
    repo.checkout_new("feature");
    repo.write_file("alt.txt", b"Gr\xfc\xdfe\nFEATURE \xe4\n");
    repo.write_file("bom.txt", b"\xEF\xBB\xBFeins\nFEATURE\n");
    repo.write_file("doku.md", "Titel\n=======\n\nFeature\n");
    repo.commit("Feature");
    repo.checkout("main");
    repo.write_file("alt.txt", b"Gr\xfc\xdfe\nMAIN \xf6\n");
    repo.write_file("bom.txt", b"\xEF\xBB\xBFeins\nMAIN\n");
    repo.write_file("doku.md", "Titel\n=======\n\nMain\n");
    repo.commit("Main");
    let id = open(&tc, &repo).await;
    let result = merge_start(&tc, id.clone(), "feature".into(), MergeMode::Default).await.unwrap();
    assert_eq!(conflict_files(&result), vec!["alt.txt", "bom.txt", "doku.md"]);

    // windows-1252 stays windows-1252.
    let file = conflict_get(&tc, id.clone(), "alt.txt".into()).await.unwrap();
    assert_eq!(file.encoding.as_deref(), Some("windows-1252"));
    assert_eq!((file.ours.as_deref(), file.theirs.as_deref()), (Some("Grüße\nMAIN ö\n"), Some("Grüße\nFEATURE ä\n")));
    assert!(file.merged.is_some_and(|m| m.contains("Grüße") && m.contains("<<<<<<<")));
    let err = conflict_resolve(&tc, id.clone(), "alt.txt".into(), Some("Grüße → Pfeil\n".into()), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    assert!(err.message.contains("windows-1252"), "{}", err.message);
    conflict_resolve(&tc, id.clone(), "alt.txt".into(), Some("Grüße\nbeides äö\n".into()), None).await.unwrap();
    assert_eq!(repo.read_file("alt.txt"), b"Gr\xfc\xdfe\nbeides \xe4\xf6\n");

    // The file's BOM stays, exactly once.
    let file = conflict_get(&tc, id.clone(), "bom.txt".into()).await.unwrap();
    assert_eq!((file.encoding.as_deref(), file.ours.as_deref()), (Some("utf-8"), Some("eins\nMAIN\n")));
    conflict_resolve(&tc, id.clone(), "bom.txt".into(), Some("\u{feff}eins\nbeides ü\n".into()), None).await.unwrap();
    assert_eq!(repo.read_file("bom.txt"), "\u{feff}eins\nbeides ü\n".as_bytes());

    // "=======" was already in both versions: that is content, not a marker.
    let err = conflict_resolve(&tc, id.clone(), "doku.md".into(), Some("Titel\n=======\n\n<<<<<<< HEAD\nMain\n".into()), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    assert!(err.message.contains("line 4"), "{}", err.message);
    let status = conflict_resolve(&tc, id.clone(), "doku.md".into(), Some("Titel\n=======\n\nBeides\n".into()), None).await.unwrap();
    assert!(status.conflicted.is_empty());
    assert_eq!(repo.read_file("doku.md"), b"Titel\n=======\n\nBeides\n");
}

#[tokio::test]
async fn conflict_resolve_with_autocrlf_writes_crlf() {
    let tc = TestCore::new().await;
    let repo = TestRepo::new();
    repo.git(&["config", "core.autocrlf", "true"]);
    repo.commit_file("a.txt", "eins\r\nzwei\r\n", "Basis");
    repo.checkout_new("feature");
    repo.commit_file("a.txt", "eins\r\nFEATURE\r\n", "Feature");
    repo.checkout("main");
    repo.commit_file("a.txt", "eins\r\nMAIN\r\n", "Main");
    let id = open(&tc, &repo).await;
    merge_start(&tc, id.clone(), "feature".into(), MergeMode::Default).await.unwrap();

    // The index has LF, the working directory CRLF – CRLF is written there again.
    let file = conflict_get(&tc, id.clone(), "a.txt".into()).await.unwrap();
    assert_eq!(file.ours.as_deref(), Some("eins\nMAIN\n"));
    let status = conflict_resolve(&tc, id.clone(), "a.txt".into(), Some("eins\nBEIDES\n".into()), None).await.unwrap();
    assert_eq!(repo.read_file("a.txt"), b"eins\r\nBEIDES\r\n");
    assert!(status.conflicted.is_empty());
    assert_eq!(repo.git(&["cat-file", "blob", ":a.txt"]), "eins\nBEIDES");
}

#[tokio::test]
async fn conflict_resolve_argument_checks_and_foreign_lock() {
    let tc = TestCore::new().await;
    let repo = repo_with_two_conflicts();
    let id = open(&tc, &repo).await;
    merge_start(&tc, id.clone(), "feature".into(), MergeMode::Default).await.unwrap();

    let err = conflict_resolve(&tc, id.clone(), "ohne-nl.txt".into(), None, None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    let err = conflict_resolve(&tc, id.clone(), "ohne-nl.txt".into(), Some("x".into()), Some(ConflictSide::Ours)).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    for missing in ["nur-feature.txt", "gibt-es-nicht.txt", "", "*"] {
        let err = conflict_resolve(&tc, id.clone(), missing.into(), None, Some(ConflictSide::Ours)).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound, "{missing}: {err:?}");
        assert_eq!(conflict_get(&tc, id.clone(), missing.into()).await.unwrap_err().code, ErrorCode::NotFound, "{missing}");
    }

    // Foreign lock file: nothing is written, the lock stays.
    let with_markers = repo.read_file("ohne-nl.txt");
    let lock = git_file(&repo, "index.lock");
    std::fs::write(&lock, "").unwrap();
    let err = conflict_resolve(&tc, id.clone(), "ohne-nl.txt".into(), Some("alpha\nneu".into()), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Locked);
    let err = conflict_resolve(&tc, id.clone(), "ohne-nl.txt".into(), None, Some(ConflictSide::Theirs)).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Locked);
    assert_eq!(repo.read_file("ohne-nl.txt"), with_markers);
    assert!(lock.exists());
    std::fs::remove_file(&lock).unwrap();
    let status = conflict_resolve(&tc, id, "ohne-nl.txt".into(), None, Some(ConflictSide::Ours)).await.unwrap();
    assert_eq!(repo.read_file("ohne-nl.txt"), b"alpha\nmain");
    assert_eq!(paths(&status.conflicted), vec!["ä b.txt"]);
}

#[tokio::test]
async fn conflict_resolve_removes_orig_file_only_when_enabled() {
    let tc = TestCore::new().await;
    let repo = repo_with_two_conflicts();
    let id = open(&tc, &repo).await;
    merge_start(&tc, id.clone(), "feature".into(), MergeMode::Default).await.unwrap();
    // The merge tool is started from the app (only recorded here) and creates the backups.
    crate::commands::settings::settings_set(&tc, serde_json::json!({ "externalMergeTool": "mein-merge-tool {merged}" })).await.unwrap();
    tc.state::<crate::commands::external::ExternalState>().set_dry_run(true);
    for path in ["ohne-nl.txt", "ä b.txt"] {
        crate::commands::external::open_external(&tc, id.clone(), crate::model::ExternalTarget::MergeTool, Some(path.into()), None).await.unwrap();
    }
    repo.write_file("ohne-nl.txt.orig", "sicherung");
    repo.write_file("ä b.txt.orig", "sicherung");

    assert!(tc.settings().unwrap().delete_orig_files);
    conflict_resolve(&tc, id.clone(), "ohne-nl.txt".into(), None, Some(ConflictSide::Ours)).await.unwrap();
    assert!(!exists(&repo, "ohne-nl.txt.orig"));
    assert!(exists(&repo, "ä b.txt.orig"));

    crate::commands::settings::settings_set(&tc, serde_json::json!({ "deleteOrigFiles": false })).await.unwrap();
    conflict_resolve(&tc, id, "ä b.txt".into(), Some("eins\nx\n".into()), None).await.unwrap();
    assert!(exists(&repo, "ä b.txt.orig"));
}

/// An `.orig` file the user placed next to the conflicted file themselves (no merge tool
/// ran, or it was already there before the tool started) is never deleted.
#[tokio::test]
async fn conflict_resolve_keeps_an_orig_file_the_user_created() {
    let tc = TestCore::new().await;
    let repo = repo_with_two_conflicts();
    let id = open(&tc, &repo).await;
    merge_start(&tc, id.clone(), "feature".into(), MergeMode::Default).await.unwrap();
    assert!(tc.settings().unwrap().delete_orig_files);

    // No merge tool ran.
    repo.write_file("ohne-nl.txt.orig", "meine eigene Sicherung");
    conflict_resolve(&tc, id.clone(), "ohne-nl.txt".into(), None, Some(ConflictSide::Ours)).await.unwrap();
    assert_eq!(repo.read_file("ohne-nl.txt.orig"), b"meine eigene Sicherung");

    // The file was already there when the merge tool was started.
    repo.write_file("ä b.txt.orig", "auch meine");
    crate::commands::settings::settings_set(&tc, serde_json::json!({ "externalMergeTool": "mein-merge-tool {merged}" })).await.unwrap();
    tc.state::<crate::commands::external::ExternalState>().set_dry_run(true);
    crate::commands::external::open_external(&tc, id.clone(), crate::model::ExternalTarget::MergeTool, Some("ä b.txt".into()), None).await.unwrap();
    conflict_resolve(&tc, id, "ä b.txt".into(), Some("eins\nx\n".into()), None).await.unwrap();
    assert_eq!(repo.read_file("ä b.txt.orig"), b"auch meine");
}

// ---------------------------------------------------------------------------
// Continue and abort
// ---------------------------------------------------------------------------

#[tokio::test]
async fn abort_restores_the_state_after_restart_for_a_merge_started_in_the_terminal() {
    let tc = TestCore::new().await;
    let repo = repo_with_two_conflicts();
    let before = repo.head();
    let id = open(&tc, &repo).await;
    // Merge started in the terminal, one file already resolved, then the app restarted.
    assert!(!repo.merge("feature"));
    repo.write_file("ohne-nl.txt", "halb gelöst");
    repo.git(&["add", "ohne-nl.txt"]);
    let tc = tc.restart().await;
    assert_eq!(open(&tc, &repo).await, id);
    tc.events.clear();

    let status = operation_abort(&tc, id.clone()).await.unwrap();
    assert!(status.operation.is_none() && status.conflicted.is_empty() && status.staged.is_empty() && status.unstaged.is_empty());
    assert_eq!(repo.head(), before);
    assert_eq!(repo.read_file("ä b.txt"), b"eins\r\nMAIN\r\ndrei\r\n");
    assert_eq!(repo.read_file("ohne-nl.txt"), b"alpha\nmain");
    assert!(!git_file(&repo, "MERGE_HEAD").exists());
    assert!(!exists(&repo, "nur-feature.txt"));
    let changed = tc.events.named(names::REPO_CHANGED);
    assert!(changed[0]["what"].as_array().unwrap().contains(&serde_json::json!("operation")));
    assert!(no_undo(&tc, &id));

    // Without a running operation there is nothing to abort or continue.
    assert_eq!(operation_abort(&tc, id.clone()).await.unwrap_err().code, ErrorCode::NoOperation);
    assert_eq!(operation_continue(&tc, id, None, None).await.unwrap_err().code, ErrorCode::NoOperation);
}

/// feature has three commits; the first two collide with main.
fn repo_for_rebase() -> TestRepo {
    let repo = TestRepo::new();
    repo.write_file("a.txt", "basis\n");
    repo.write_file("b.txt", "basis\n");
    repo.commit("Basis");
    repo.checkout_new("feature");
    repo.commit_file("a.txt", "feature\n", "Feature ändert a");
    repo.commit_file("b.txt", "feature\n", "Feature ändert b");
    repo.commit_file("c.txt", "neu\n", "Feature ergänzt c");
    repo.checkout("main");
    repo.write_file("a.txt", "main\n");
    repo.write_file("b.txt", "main\n");
    repo.commit("Main ändert a und b");
    repo.checkout("feature");
    repo
}

#[tokio::test]
async fn rebase_continue_stops_again_at_the_next_conflict() {
    let tc = TestCore::new().await;
    let repo = repo_for_rebase();
    let orig = repo.head();
    let main_sha = repo.git(&["rev-parse", "main"]);
    assert!(!repo.git_output(&["rebase", "main"]).status.success());
    let id = open(&tc, &repo).await;

    // "ours" is what is being replayed onto (main), "theirs" one's own branch.
    let file = conflict_get(&tc, id.clone(), "a.txt".into()).await.unwrap();
    assert_eq!((file.ours_label.as_str(), file.theirs_label.as_str()), ("main", "feature"));
    assert_eq!((file.ours.as_deref(), file.theirs.as_deref()), (Some("main\n"), Some("feature\n")));
    conflict_resolve(&tc, id.clone(), "a.txt".into(), Some("beides\n".into()), None).await.unwrap();

    let result = operation_continue(&tc, id.clone(), None, None).await.unwrap();
    assert_eq!(conflict_files(&result), vec!["b.txt"]);
    let OpResult::Conflict { operation: Some(op), .. } = &result else { panic!("{result:?}") };
    assert_eq!((op.kind, op.step, op.total_steps), (OperationKind::Rebase, Some(2), Some(3)));
    assert!(no_undo(&tc, &id));

    // Taking "theirs" in a rebase means: the version of one's own branch.
    conflict_resolve(&tc, id.clone(), "b.txt".into(), None, Some(ConflictSide::Theirs)).await.unwrap();
    assert_eq!(repo.read_file("b.txt"), b"feature\n");
    let result = operation_continue(&tc, id.clone(), None, None).await.unwrap();
    let sha = done_sha(&result);
    assert!(matches!(&result, OpResult::Done { summary, .. } if summary.contains("feature onto main")), "{result:?}");

    assert_eq!(repo.current_branch(), "feature");
    assert_eq!(repo.head(), sha);
    assert_eq!(repo.git(&["merge-base", "main", "feature"]), main_sha);
    assert_eq!(repo.git(&["log", "--format=%s", "main..feature"]), "Feature ergänzt c\nFeature ändert b\nFeature ändert a");
    assert_eq!(repo.read_file("a.txt"), b"beides\n");
    assert_eq!(read_status(&tc, &id).await.unwrap().operation, None);

    let entry = last_undo(&tc, &id);
    assert_eq!(entry.action, "rebase");
    assert_eq!(entry.label, "Undo rebase of feature onto main");
    assert_eq!(entry.ref_name.as_deref(), Some("refs/heads/feature"));
    assert_eq!((entry.ref_before.as_deref(), entry.ref_after.as_deref()), (Some(orig.as_str()), Some(sha.as_str())));
    assert_eq!((entry.head_before.as_str(), entry.head_after.as_deref()), ("refs/heads/feature", Some("refs/heads/feature")));
    assert_eq!(backup_ref(&repo, &entry, "before"), Some(orig));
}

#[tokio::test]
async fn rebase_abort_returns_to_the_branch() {
    let tc = TestCore::new().await;
    let repo = repo_for_rebase();
    let orig = repo.head();
    assert!(!repo.git_output(&["rebase", "main"]).status.success());
    let id = open(&tc, &repo).await;
    assert_eq!(reset_branch(&tc, id.clone(), orig.clone(), ResetMode::Hard).await.unwrap_err().code, ErrorCode::OperationInProgress);
    assert_eq!(revert_commit(&tc, id.clone(), orig.clone()).await.unwrap_err().code, ErrorCode::OperationInProgress);

    let status = operation_abort(&tc, id).await.unwrap();
    assert_eq!(status.head, Head::Branch { branch: "feature".into(), sha: orig });
    assert!(status.operation.is_none() && status.conflicted.is_empty());
    assert_eq!(repo.read_file("a.txt"), b"feature\n");
}

/// If Git was terminated in the middle of a checkout (crash), files of the pre-rebase state
/// lie around as untracked leftovers – `git rebase --abort` then refuses. Identical leftovers
/// go; a differing file is never touched, and the message names it.
#[tokio::test]
async fn rebase_abort_gets_past_identical_leftovers_but_never_touches_a_differing_file() {
    let tc = TestCore::new().await;
    let repo = repo_for_rebase();
    let orig = repo.head();
    let c = repo.read_file("c.txt");
    assert!(!repo.git_output(&["rebase", "main"]).status.success());
    assert!(!repo.path().join("c.txt").exists(), "c.txt only comes with a later commit of the rebase");
    let id = open(&tc, &repo).await;

    // Differing content: the user's own work – stays, and so does the rebase.
    repo.write_file("c.txt", "eigene Notiz, nie committet\n");
    let error = operation_abort(&tc, id.clone()).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::DirtyWorktree);
    assert!(error.message.contains("“c.txt”"), "{}", error.message);
    assert_eq!(repo.read_file("c.txt"), b"eigene Notiz, nie committet\n");
    assert!(read_status(&tc, &id).await.unwrap().operation.is_some());

    // Identical to the pre-rebase state: a leftover – the abort succeeds.
    repo.write_file("c.txt", &c);
    let status = operation_abort(&tc, id).await.unwrap();
    assert_eq!(status.head, Head::Branch { branch: "feature".into(), sha: orig });
    assert!(status.operation.is_none() && status.conflicted.is_empty() && status.unstaged.is_empty());
    assert_eq!(repo.read_file("c.txt"), c);
}

/// main and feature both change README.md; feature has a harmless commit before and after.
fn repo_for_cherry_pick() -> (TestRepo, [String; 3]) {
    let repo = TestRepo::with_commit();
    repo.checkout_new("feature");
    let a = repo.commit_file("a.txt", "a\n", "A");
    let b = repo.commit_file("README.md", "# Feature\n", "B kollidiert");
    let c = repo.commit_file("c.txt", "c\n", "C");
    repo.checkout("main");
    repo.commit_file("README.md", "# Main\n", "Main ändert README");
    (repo, [a, b, c])
}

#[tokio::test]
async fn cherry_pick_single_conflict_continue_and_abort() {
    let tc = TestCore::new().await;
    let (repo, [_, b, _]) = repo_for_cherry_pick();
    let before = repo.head();
    let id = open(&tc, &repo).await;

    assert!(!repo.git_output(&["cherry-pick", &b]).status.success());
    let status = operation_abort(&tc, id.clone()).await.unwrap();
    assert!(status.operation.is_none() && status.conflicted.is_empty());
    assert_eq!(repo.head(), before);
    assert_eq!(repo.read_file("README.md"), b"# Main\n");

    assert!(!repo.git_output(&["cherry-pick", &b]).status.success());
    let file = conflict_get(&tc, id.clone(), "README.md".into()).await.unwrap();
    assert_eq!((file.ours_label.as_str(), file.theirs_label), ("main", format!("Cherry-pick {}", &b[..7])));
    conflict_resolve(&tc, id.clone(), "README.md".into(), Some("# Beides\n".into()), None).await.unwrap();
    let result = operation_continue(&tc, id.clone(), None, None).await.unwrap();
    let sha = done_sha(&result);
    assert_eq!(repo.git(&["log", "-1", "--format=%s"]), "B kollidiert");
    assert_eq!(repo.git(&["rev-parse", "HEAD^"]), before);
    assert_eq!(read_status(&tc, &id).await.unwrap().operation, None);

    let entry = last_undo(&tc, &id);
    assert_eq!(entry.action, "cherry_pick");
    assert_eq!((entry.ref_before.as_deref(), entry.ref_after.as_deref()), (Some(before.as_str()), Some(sha.as_str())));
    assert_eq!(entry.payload["summary"], "B kollidiert");
}

#[tokio::test]
async fn cherry_pick_sequence_continues_after_a_commit_made_by_hand() {
    let tc = TestCore::new().await;
    let (repo, [a, b, c]) = repo_for_cherry_pick();
    let before = repo.head();
    assert!(!repo.git_output(&["cherry-pick", &a, &b, &c]).status.success());
    let id = open(&tc, &repo).await;

    // Conflict resolved and committed in the terminal: CHERRY_PICK_HEAD is missing, the sequence is still open.
    repo.write_file("README.md", "# Beides\n");
    repo.git(&["add", "README.md"]);
    repo.git(&["commit", "-q", "--no-edit"]);
    assert!(!git_file(&repo, "CHERRY_PICK_HEAD").exists());
    assert_eq!(read_status(&tc, &id).await.unwrap().operation.map(|o| o.kind), Some(OperationKind::CherryPick));

    let result = operation_continue(&tc, id.clone(), None, None).await.unwrap();
    let sha = done_sha(&result);
    assert_eq!(repo.git(&["log", "--format=%s", &format!("{before}..HEAD")]), "C\nB kollidiert\nA");
    assert_eq!(repo.read_file("c.txt"), b"c\n");
    assert_eq!(read_status(&tc, &id).await.unwrap().operation, None);
    // Undo goes back to before the whole sequence.
    let entry = last_undo(&tc, &id);
    assert_eq!((entry.action.as_str(), entry.ref_before.as_deref(), entry.ref_after.as_deref()), ("cherry_pick", Some(before.as_str()), Some(sha.as_str())));
}

#[tokio::test]
async fn cherry_pick_that_became_empty_is_skipped() {
    let tc = TestCore::new().await;
    let (repo, [_, b, c]) = repo_for_cherry_pick();
    let before = repo.head();
    let id = open(&tc, &repo).await;

    // Single pick resolved with our own side: nothing is left to commit.
    assert!(!repo.git_output(&["cherry-pick", &b]).status.success());
    conflict_resolve(&tc, id.clone(), "README.md".into(), None, Some(ConflictSide::Ours)).await.unwrap();
    let result = operation_continue(&tc, id.clone(), None, None).await.unwrap();
    assert!(matches!(result, OpResult::Done { .. }), "{result:?}");
    assert_eq!(repo.head(), before);
    assert_eq!(read_status(&tc, &id).await.unwrap().operation, None);
    assert!(no_undo(&tc, &id));

    // In a sequence it then continues with the next commit.
    assert!(!repo.git_output(&["cherry-pick", &b, &c]).status.success());
    conflict_resolve(&tc, id.clone(), "README.md".into(), None, Some(ConflictSide::Ours)).await.unwrap();
    let result = operation_continue(&tc, id.clone(), None, None).await.unwrap();
    assert!(matches!(result, OpResult::Done { .. }), "{result:?}");
    assert_eq!(repo.git(&["log", "--format=%s", &format!("{before}..HEAD")]), "C");
    assert_eq!(read_status(&tc, &id).await.unwrap().operation, None);
}

// ---------------------------------------------------------------------------
// revert_commit
// ---------------------------------------------------------------------------

#[tokio::test]
async fn revert_a_normal_commit() {
    let tc = TestCore::new().await;
    let repo = TestRepo::new();
    repo.commit_file("a.txt", "eins\n", "Erster");
    let second = repo.commit_file("a.txt", "zwei\n", "Tippfehler behoben");
    let third = repo.commit_file("b.txt", "b\n", "Dritter");
    let id = open(&tc, &repo).await;
    tc.events.clear();

    let result = revert_commit(&tc, id.clone(), second[..10].to_string()).await.unwrap();
    let sha = done_sha(&result);
    assert!(matches!(&result, OpResult::Done { fast_forward: false, summary, .. } if summary.contains(&second[..7])), "{result:?}");
    assert_eq!(repo.head(), sha);
    assert_eq!(repo.git(&["rev-parse", "HEAD^"]), third);
    assert_eq!(repo.git(&["log", "-1", "--format=%s"]), "Revert \"Tippfehler behoben\"");
    assert_eq!(repo.read_file("a.txt"), b"eins\n");
    assert_eq!(repo.read_file("b.txt"), b"b\n");
    assert_eq!(tc.events.count(names::REPO_CHANGED), 1);

    let entry = last_undo(&tc, &id);
    assert_eq!(entry.action, "revert");
    assert_eq!(entry.label, "Undo revert of ‘Tippfehler behoben’");
    assert_eq!(entry.ref_name.as_deref(), Some("refs/heads/main"));
    assert_eq!((entry.ref_before.as_deref(), entry.ref_after.as_deref()), (Some(third.as_str()), Some(sha.as_str())));
    assert_eq!(entry.payload["summary"], "Tippfehler behoben");

    // The same commit once more: the change is already gone.
    let result = revert_commit(&tc, id.clone(), second).await.unwrap();
    assert_eq!(result, OpResult::UpToDate);
    assert_eq!(repo.head(), sha);
    let status = read_status(&tc, &id).await.unwrap();
    assert!(status.operation.is_none() && status.staged.is_empty() && status.unstaged.is_empty());
}

#[tokio::test]
async fn revert_a_merge_commit_against_its_first_parent() {
    let tc = TestCore::new().await;
    let repo = diverged_repo();
    repo.git(&["merge", "-q", "--no-ff", "--no-edit", "feature"]);
    let merge = repo.head();
    assert_eq!(parent_count(&repo, "HEAD"), 2);
    let id = open(&tc, &repo).await;

    let result = revert_commit(&tc, id.clone(), merge.clone()).await.unwrap();
    let sha = done_sha(&result);
    assert_eq!(repo.git(&["rev-parse", "HEAD^"]), merge);
    assert_eq!(parent_count(&repo, &sha), 1);
    // The incoming changes are gone, those of one's own branch stay.
    assert!(!exists(&repo, "feature.txt"));
    assert_eq!(repo.read_file("main.txt"), b"m\n");
    assert!(repo.git(&["log", "-1", "--format=%B"]).contains("reverts commit"));
    assert_eq!(last_undo(&tc, &id).action, "revert");
}

#[tokio::test]
async fn revert_with_conflict_then_continue() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let changed = repo.commit_file("README.md", "# Main\n", "Main ändert README");
    let before = repo.commit_file("README.md", "# Main, später\n", "Noch eine Änderung");
    let id = open(&tc, &repo).await;

    let result = revert_commit(&tc, id.clone(), changed.clone()).await.unwrap();
    assert_eq!(conflict_files(&result), vec!["README.md"]);
    let OpResult::Conflict { operation: Some(op), .. } = &result else { panic!("{result:?}") };
    assert_eq!((op.kind, op.source.as_deref()), (OperationKind::Revert, Some(&changed[..7])));
    assert!(no_undo(&tc, &id));
    assert_eq!(repo.head(), before);

    let file = conflict_get(&tc, id.clone(), "README.md".into()).await.unwrap();
    assert_eq!((file.ours_label.as_str(), file.theirs_label), ("main", format!("State before {}", &changed[..7])));
    assert_eq!((file.ours.as_deref(), file.theirs.as_deref()), (Some("# Main, später\n"), Some("# Test\n")));
    conflict_resolve(&tc, id.clone(), "README.md".into(), Some("# Test, später\n".into()), None).await.unwrap();

    let result = operation_continue(&tc, id.clone(), None, None).await.unwrap();
    let sha = done_sha(&result);
    assert_eq!(repo.git(&["log", "-1", "--format=%s"]), "Revert \"Main ändert README\"");
    assert_eq!(repo.read_file("README.md"), "# Test, später\n".as_bytes());
    assert_eq!(read_status(&tc, &id).await.unwrap().operation, None);
    let entry = last_undo(&tc, &id);
    assert_eq!((entry.action.as_str(), entry.ref_before.as_deref(), entry.ref_after.as_deref()), ("revert", Some(before.as_str()), Some(sha.as_str())));
}

#[tokio::test]
async fn revert_error_cases() {
    let tc = TestCore::new().await;
    let empty = TestRepo::new();
    let id = open(&tc, &empty).await;
    assert_eq!(revert_commit(&tc, id, "HEAD".into()).await.unwrap_err().code, ErrorCode::NotAllowed);

    let repo = TestRepo::new();
    repo.commit_file("a.txt", "eins\n", "Erster");
    let second = repo.commit_file("a.txt", "zwei\n", "Zweiter");
    let id = open(&tc, &repo).await;
    for unknown in ["0123456789abcdef0123456789abcdef01234567", "", "-n"] {
        assert_eq!(revert_commit(&tc, id.clone(), unknown.into()).await.unwrap_err().code, ErrorCode::NotFound, "{unknown}");
    }

    // Uncommitted change in the affected file.
    repo.write_file("a.txt", "lokal\n");
    let err = revert_commit(&tc, id.clone(), second.clone()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::DirtyWorktree, "{err:?}");
    assert_eq!(repo.read_file("a.txt"), b"lokal\n");
    assert_eq!(repo.head(), second);
    assert_eq!(read_status(&tc, &id).await.unwrap().operation, None);

    // Foreign index.lock.
    repo.write_file("a.txt", "zwei\n");
    let lock = git_file(&repo, "index.lock");
    std::fs::write(&lock, "").unwrap();
    assert_eq!(revert_commit(&tc, id.clone(), second.clone()).await.unwrap_err().code, ErrorCode::Locked);
    assert!(lock.exists());
    std::fs::remove_file(&lock).unwrap();
    assert_eq!(repo.head(), second);

    // Without an identity nothing is started.
    repo.git(&["config", "--unset", "user.name"]);
    assert_eq!(revert_commit(&tc, id.clone(), second.clone()).await.unwrap_err().code, ErrorCode::IdentityMissing);
    assert_eq!(repo.head(), second);
    assert!(no_undo(&tc, &id));
}

#[tokio::test]
async fn revert_on_detached_head() {
    let tc = TestCore::new().await;
    let repo = TestRepo::new();
    repo.commit_file("a.txt", "eins\n", "Erster");
    let second = repo.commit_file("a.txt", "zwei\n", "Zweiter");
    repo.git(&["checkout", "-q", "--detach"]);
    let id = open(&tc, &repo).await;

    let sha = done_sha(&revert_commit(&tc, id.clone(), "HEAD".into()).await.unwrap());
    assert_eq!(repo.read_file("a.txt"), b"eins\n");
    assert_eq!(repo.git(&["rev-parse", "main"]), second);
    let entry = last_undo(&tc, &id);
    assert_eq!(entry.ref_name, None);
    assert_eq!((entry.head_before.as_str(), entry.head_after.as_deref()), (second.as_str(), Some(sha.as_str())));
}

// ---------------------------------------------------------------------------
// reset_branch
// ---------------------------------------------------------------------------

/// Three commits: a.txt = 1, 2, 3; the third adds b.txt.
fn repo_for_reset() -> (TestRepo, [String; 3]) {
    let repo = TestRepo::new();
    let c1 = repo.commit_file("a.txt", "1\n", "Eins");
    let c2 = repo.commit_file("a.txt", "2\n", "Zwei");
    repo.write_file("a.txt", "3\n");
    repo.write_file("b.txt", "b\n");
    let c3 = repo.commit("Drei");
    (repo, [c1, c2, c3])
}

#[tokio::test]
async fn reset_soft_keeps_index_and_worktree() {
    let tc = TestCore::new().await;
    let (repo, [_, c2, c3]) = repo_for_reset();
    let id = open(&tc, &repo).await;
    tc.events.clear();

    // To the current commit: nothing to do, no entry.
    reset_branch(&tc, id.clone(), c3.clone(), ResetMode::Soft).await.unwrap();
    assert!(no_undo(&tc, &id));
    tc.events.clear();

    let status = reset_branch(&tc, id.clone(), c2.clone(), ResetMode::Soft).await.unwrap();
    assert_eq!(status.head, Head::Branch { branch: "main".into(), sha: c2.clone() });
    assert_eq!(paths(&status.staged), vec!["a.txt", "b.txt"]);
    assert_eq!(find(&status.staged, "b.txt").status, FileStatus::Added);
    assert!(status.unstaged.is_empty());
    assert_eq!(repo.read_file("a.txt"), b"3\n");
    assert_eq!(tc.events.named(names::REPO_CHANGED)[0]["what"], serde_json::json!(["worktree", "index", "refs", "head"]));

    let entry = last_undo(&tc, &id);
    assert_eq!(entry.action, "reset");
    assert_eq!(entry.label, format!("Undo reset of main to {}", &c2[..7]));
    assert_eq!(entry.ref_name.as_deref(), Some("refs/heads/main"));
    assert_eq!((entry.ref_before.as_deref(), entry.ref_after.as_deref()), (Some(c3.as_str()), Some(c2.as_str())));
    assert_eq!((entry.head_before.as_str(), entry.head_after.as_deref()), ("refs/heads/main", Some("refs/heads/main")));
    assert_eq!(entry.payload["mode"], "soft");
    assert!(entry.payload["worktreeSnapshot"].is_null() && entry.payload["indexTree"].is_null() && entry.payload["paths"].is_null());
    assert_eq!(backup_ref(&repo, &entry, "before"), Some(c3));
    assert_eq!(backup_ref(&repo, &entry, "worktree"), None);
}

#[tokio::test]
async fn reset_mixed_unstages_and_remembers_the_index() {
    let tc = TestCore::new().await;
    let (repo, [c1, _, c3]) = repo_for_reset();
    repo.write_file("neu.txt", "gestaged\n");
    repo.git(&["add", "neu.txt"]);
    let id = open(&tc, &repo).await;

    let status = reset_branch(&tc, id.clone(), c1.clone(), ResetMode::Mixed).await.unwrap();
    assert_eq!(status.head, Head::Branch { branch: "main".into(), sha: c1.clone() });
    assert!(status.staged.is_empty(), "{:?}", status.staged);
    assert_eq!(paths(&status.unstaged), vec!["a.txt", "b.txt", "neu.txt"]);
    assert_eq!(find(&status.unstaged, "a.txt").status, FileStatus::Modified);
    assert_eq!(find(&status.unstaged, "b.txt").status, FileStatus::Untracked);
    assert_eq!(repo.read_file("a.txt"), b"3\n");
    assert_eq!(repo.read_file("neu.txt"), b"gestaged\n");

    let entry = last_undo(&tc, &id);
    assert_eq!(entry.payload["mode"], "mixed");
    assert!(entry.payload["worktreeSnapshot"].is_null());
    // The previous index is recorded as a tree and protected by a backup ref.
    let tree = entry.payload["indexTree"].as_str().expect("indexTree").to_string();
    assert_eq!(repo.git(&["ls-tree", "--name-only", &tree]), "a.txt\nb.txt\nneu.txt");
    assert_eq!(repo.git(&["show", &format!("{tree}:neu.txt")]), "gestaged");
    let index_commit = backup_ref(&repo, &entry, "index").expect("backup ref index");
    assert_eq!(repo.git(&["rev-parse", &format!("{index_commit}^{{tree}}")]), tree);
    assert_eq!(backup_ref(&repo, &entry, "before"), Some(c3));
}

#[tokio::test]
async fn reset_hard_backs_up_the_worktree_first() {
    let tc = TestCore::new().await;
    let (repo, [c1, _, c3]) = repo_for_reset();
    // Uncommitted work in all forms: modified, staged, untracked, deleted.
    repo.write_file("a.txt", "lokal\n");
    repo.write_file("c.txt", "gestaged\n");
    repo.git(&["add", "c.txt"]);
    repo.write_file("neu datei ü.txt", "unverfolgt\n");
    let id = open(&tc, &repo).await;

    let status = reset_branch(&tc, id.clone(), c1[..8].to_string(), ResetMode::Hard).await.unwrap();
    assert_eq!(status.head, Head::Branch { branch: "main".into(), sha: c1.clone() });
    assert!(status.staged.is_empty());
    assert_eq!(paths(&status.unstaged), vec!["neu datei ü.txt"]);
    assert_eq!(repo.read_file("a.txt"), b"1\n");
    assert!(!exists(&repo, "b.txt") && !exists(&repo, "c.txt"));
    assert_eq!(repo.read_file("neu datei ü.txt"), b"unverfolgt\n");

    let entry = last_undo(&tc, &id);
    assert_eq!((entry.action.as_str(), entry.payload["mode"].as_str()), ("reset", Some("hard")));
    assert_eq!((entry.ref_before.as_deref(), entry.ref_after.as_deref()), (Some(c3.as_str()), Some(c1.as_str())));
    assert_eq!(entry.payload["branch"], "main");
    assert_eq!(backup_ref(&repo, &entry, "before"), Some(c3.clone()));

    // The backup contains the previous working directory, as a commit on the old tip.
    let snapshot = entry.payload["worktreeSnapshot"].as_str().expect("worktreeSnapshot").to_string();
    assert_eq!(backup_ref(&repo, &entry, "worktree"), Some(snapshot.clone()));
    assert_eq!(repo.git(&["rev-parse", &format!("{snapshot}^")]), c3);
    assert_eq!(repo.git(&["log", "-1", "--format=%s|%an", &snapshot]), "forkyard: backup|forkyard");
    assert_eq!(repo.git(&["-c", "core.quotepath=false", "ls-tree", "-r", "--name-only", &snapshot]), "a.txt\nb.txt\nc.txt\nneu datei ü.txt");
    assert_eq!(repo.git(&["show", &format!("{snapshot}:a.txt")]), "lokal");
    assert_eq!(repo.git(&["show", &format!("{snapshot}:c.txt")]), "gestaged");
    assert_eq!(repo.git(&["show", &format!("{snapshot}:neu datei ü.txt")]), "unverfolgt");
    // The previous index: c.txt staged, a.txt still as in the commit.
    let tree = entry.payload["indexTree"].as_str().expect("indexTree").to_string();
    assert_eq!(repo.git(&["ls-tree", "--name-only", &tree]), "a.txt\nb.txt\nc.txt");
    assert_eq!(repo.git(&["show", &format!("{tree}:a.txt")]), "3");

    // The temporary index file is gone again.
    let leftovers: Vec<String> = std::fs::read_dir(repo.path().join(".git"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("forkyard-snapshot"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

#[tokio::test]
async fn reset_hard_to_head_discards_changes_and_works_without_identity() {
    let tc = TestCore::new().await;
    let (repo, [_, _, c3]) = repo_for_reset();
    repo.git(&["config", "--unset", "user.name"]);
    repo.git(&["config", "--unset", "user.email"]);
    repo.write_file("a.txt", "lokal\r\nohne Ende");
    let id = open(&tc, &repo).await;

    let status = reset_branch(&tc, id.clone(), "HEAD".into(), ResetMode::Hard).await.unwrap();
    assert!(status.unstaged.is_empty() && status.staged.is_empty());
    assert_eq!(repo.read_file("a.txt"), b"3\n");
    assert_eq!(repo.head(), c3);
    let entry = last_undo(&tc, &id);
    assert_eq!((entry.ref_before.as_deref(), entry.ref_after.as_deref()), (Some(c3.as_str()), Some(c3.as_str())));
    let snapshot = entry.payload["worktreeSnapshot"].as_str().unwrap().to_string();
    let saved = repo.git_output(&["cat-file", "blob", &format!("{snapshot}:a.txt")]).stdout;
    assert_eq!(saved, b"lokal\r\nohne Ende");
}

#[tokio::test]
async fn reset_on_detached_head_moves_head() {
    let tc = TestCore::new().await;
    let (repo, [_, c2, c3]) = repo_for_reset();
    repo.git(&["checkout", "-q", "--detach"]);
    let id = open(&tc, &repo).await;

    let status = reset_branch(&tc, id.clone(), c2.clone(), ResetMode::Mixed).await.unwrap();
    assert_eq!(status.head, Head::Detached { sha: c2.clone() });
    assert_eq!(repo.git(&["rev-parse", "main"]), c3);
    let entry = last_undo(&tc, &id);
    assert_eq!(entry.ref_name, None);
    assert_eq!((entry.head_before.as_str(), entry.head_after.as_deref()), (c3.as_str(), Some(c2.as_str())));
    assert!(entry.payload["branch"].is_null());
    assert_eq!(entry.label, format!("Undo reset of {} to {}", &c3[..7], &c2[..7]));
}

#[tokio::test]
async fn reset_error_cases() {
    let tc = TestCore::new().await;
    let empty = TestRepo::new();
    let id = open(&tc, &empty).await;
    assert_eq!(reset_branch(&tc, id, "HEAD".into(), ResetMode::Hard).await.unwrap_err().code, ErrorCode::NotAllowed);

    let (repo, [c1, _, c3]) = repo_for_reset();
    let id = open(&tc, &repo).await;
    for unknown in ["gibt-es-nicht", "", "--hard"] {
        let err = reset_branch(&tc, id.clone(), unknown.into(), ResetMode::Mixed).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound, "{unknown}");
    }

    // Foreign index.lock: nothing is lost, no backup is left behind.
    repo.write_file("a.txt", "lokal\n");
    let lock = git_file(&repo, "index.lock");
    std::fs::write(&lock, "").unwrap();
    for mode in [ResetMode::Hard, ResetMode::Mixed] {
        let err = reset_branch(&tc, id.clone(), c1.clone(), mode).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Locked, "{err:?}");
    }
    assert!(lock.exists());
    std::fs::remove_file(&lock).unwrap();
    assert_eq!(repo.head(), c3);
    assert_eq!(repo.read_file("a.txt"), b"lokal\n");
    assert_eq!(repo.git(&["for-each-ref", "refs/forkyard"]), "");
    assert!(no_undo(&tc, &id));

    // Running merge.
    repo.git(&["checkout", "-q", "a.txt"]);
    repo.checkout_new("feature");
    repo.commit_file("a.txt", "feature\n", "Feature");
    repo.checkout("main");
    repo.commit_file("a.txt", "main\n", "Main");
    assert!(!repo.merge("feature"));
    for mode in [ResetMode::Soft, ResetMode::Mixed, ResetMode::Hard] {
        let err = reset_branch(&tc, id.clone(), c1.clone(), mode).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::OperationInProgress);
    }
    assert!(git_file(&repo, "MERGE_HEAD").exists());
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

#[test]
fn marker_lines() {
    for marker in ["<<<<<<< HEAD", "=======", ">>>>>>> feature/x", "||||||| merged common ancestors", "=======\r", "<<<<<<<"] {
        assert!(is_marker_line(marker), "{marker}");
    }
    for text in ["========", "======", " =======", "<<<<<<<x", "=======x", "Text <<<<<<< HEAD", "", "ääääääää"] {
        assert!(!is_marker_line(text), "{text}");
    }
    let known: HashSet<String> = ["=======".to_string()].into();
    assert_eq!(leftover_marker("a\n=======\nb\n", &known), None);
    assert_eq!(leftover_marker("a\n=======\r\nb\n>>>>>>> x\n", &known), Some(4));
    assert_eq!(leftover_marker("a\n=======\nb\n", &HashSet::new()), Some(2));
    assert_eq!(leftover_marker("", &HashSet::new()), None);
}

#[test]
fn content_is_written_in_the_format_of_the_file() {
    let lf = TextFormat { encoding: "utf-8", bom: false, crlf: false };
    let crlf = TextFormat { crlf: true, ..lf };
    assert_eq!(encode_content("a\r\nb\n", &lf).unwrap(), b"a\nb\n");
    assert_eq!(encode_content("a\nb\r\nc", &crlf).unwrap(), b"a\r\nb\r\nc");
    assert_eq!(encode_content("", &crlf).unwrap(), b"");
    assert_eq!(encode_content("ä\n", &TextFormat { bom: true, ..lf }).unwrap(), b"\xEF\xBB\xBF\xC3\xA4\n");
    let latin = TextFormat { encoding: "windows-1252", ..crlf };
    assert_eq!(encode_content("Grüße €\n", &latin).unwrap(), b"Gr\xfc\xdfe \x80\r\n");
    assert_eq!(encode_content("→", &latin).unwrap_err().code, ErrorCode::NotAllowed);
    assert_eq!(eol_counts(b"a\r\nb\nc\r\n"), (2, 1));
    assert_eq!(eol_counts(b"ohne"), (0, 0));
}

#[test]
fn format_follows_ours_then_theirs() {
    let v = |ours: Option<&[u8]>, theirs: Option<&[u8]>, worktree: Option<&[u8]>| Versions {
        base: None,
        ours: ours.map(<[u8]>::to_vec),
        theirs: theirs.map(<[u8]>::to_vec),
        worktree: worktree.map(<[u8]>::to_vec),
    };
    // "ours" decides the line endings, even if "theirs" has different ones.
    assert!(v(Some(b"a\r\nb\r\n"), Some(b"a\nb\n"), Some(b"x\r\ny\n")).format().crlf);
    assert!(!v(Some(b"a\nb\n"), Some(b"a\r\nb\r\n"), Some(b"x\r\ny\n")).format().crlf);
    // If "ours" is missing (deleted by us), "theirs" counts.
    assert!(v(None, Some(b"a\r\n"), None).format().crlf);
    // autocrlf: index LF, working directory CRLF throughout.
    assert!(v(Some(b"a\nb\n"), Some(b"a\nc\n"), Some(b"a\r\nb\r\n")).format().crlf);
    // Pure ASCII in "ours" says nothing about the encoding; "theirs" decides.
    assert_eq!(v(Some(b"abc\n"), Some(b"Gr\xfc\xdfe\n"), None).format().encoding, "windows-1252");
    assert_eq!(v(Some("Grüße\n".as_bytes()), Some(b"Gr\xfc\xdfe\n"), None).format().encoding, "utf-8");
    assert_eq!(v(None, None, None).format(), TextFormat { encoding: "utf-8", bom: false, crlf: false });
    assert!(v(Some(b"\xEF\xBB\xBFa\n"), None, None).format().bom);
    // UTF-16 counts as binary.
    let entry = Unmerged::default();
    assert!(v(Some(b"\xFF\xFEa\x00"), None, None).is_binary(&entry));
    assert!(!v(Some(b"text\n"), Some(b"mehr\n"), None).is_binary(&entry));
}

#[test]
fn parses_unmerged_listing() {
    let a = "1111111111111111111111111111111111111111";
    let b = "2222222222222222222222222222222222222222";
    let raw = format!("100644 {a} 1\tmit leer zeichen.txt\0100644 {b} 3\tmit leer zeichen.txt\0100755 {a} 2\tnur\tuns.sh\0120000 {b} 2\tlink\0kaputt\0");
    let parsed = parse_unmerged(raw.as_bytes());
    assert_eq!(parsed.len(), 3);
    assert_eq!(parsed[0].path, b"mit leer zeichen.txt");
    assert_eq!(parsed[0].stages[0], Some(StageEntry { mode: "100644".into(), sha: a.into() }));
    assert_eq!(parsed[0].stages[1], None);
    assert_eq!(parsed[0].stages[2].as_ref().map(|s| s.sha.as_str()), Some(b));
    assert_eq!(kind_of(&parsed[0]), ConflictKind::DeletedByUs);
    assert_eq!(parsed[1].path, b"nur\tuns.sh");
    assert_eq!(kind_of(&parsed[1]), ConflictKind::AddedByUs);
    assert!(special_mode(&parsed[2].stages[1].as_ref().unwrap().mode));
    assert!(parse_unmerged(b"").is_empty());
}
