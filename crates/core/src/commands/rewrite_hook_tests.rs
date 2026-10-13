//! Hooks during rebase, interactive rebase, squash, cherry-pick, revert and tag push: their
//! output arrives as `hook:output`, a refusing hook as `hook_failed`.

use crate::commands::merge::{operation_abort, revert_commit};
use crate::commands::rebase::{cherry_pick, rebase_apply, rebase_plan, rebase_start, squash_commits};
use crate::commands::status::read_status;
use crate::commands::tags::{tag_create, tag_push};
use crate::error::ErrorCode;
use crate::events::names;
use crate::model::{OpResult, PushResult, RebaseAction, RebasePlan};
use crate::testkit::{TestCore, TestRepo};
use crate::undo;

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

fn remove_hook(repo: &TestRepo, name: &str) {
    let _ = std::fs::remove_file(repo.path().join(".git").join("hooks").join(name));
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

fn hook_dirs(tc: &TestCore) -> usize {
    tc.data_dir().join(crate::commands::commit::HOOKS_TMP_DIR).read_dir().map(|d| d.count()).unwrap_or(0)
}

async fn clean(tc: &TestCore, id: &str) {
    let status = read_status(tc, id).await.unwrap();
    assert!(status.unstaged.is_empty() && status.staged.is_empty() && status.conflicted.is_empty() && status.operation.is_none(), "{status:?}");
}

/// main: README, m.txt; feature (from the root): f.txt.
fn two_branches() -> TestRepo {
    let repo = TestRepo::with_commit();
    repo.checkout_new("feature");
    repo.commit_file("f.txt", "f\n", "Feature");
    repo.checkout("main");
    repo.commit_file("m.txt", "m\n", "Main");
    repo
}

#[tokio::test]
async fn pre_rebase_can_refuse_a_rebase_and_hooks_are_reported() {
    let tc = TestCore::new().await;
    let repo = two_branches();
    repo.checkout("feature");
    let feature = repo.head();
    let id = tc.open(&repo).await.repo.id;
    write_hook(&repo, "pre-rebase", "echo \"Rebase auf $1 ist hier verboten\" >&2\nexit 4");
    tc.events.clear();

    let err = rebase_start(&tc, id.clone(), "main".into(), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::HookFailed, "{err:?}");
    assert!(err.message.contains("pre-rebase") && err.message.contains("the rebase") && err.message.contains("exit code 4"), "{}", err.message);
    assert!(!err.message.contains("paused"), "nothing is in progress: {}", err.message);
    assert!(err.git_output.clone().unwrap_or_default().contains("ist hier verboten"), "{err:?}");
    let events = hook_events(&tc);
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!((events[0].0.as_str(), events[0].2), ("pre-rebase", 4));
    assert_eq!(repo.head(), feature, "nothing changed");
    clean(&tc, &id).await;
    assert!(undo::next_undo(&tc, &id, "").unwrap().is_none());
    assert!(repo.git(&["for-each-ref", "refs/forkyard"]).is_empty(), "no backup is left behind");

    // A hook that agrees is reported with its output; the rebase runs.
    write_hook(&repo, "pre-rebase", "echo 'Rebase geprüft'");
    write_hook(&repo, "post-rewrite", "echo \"umgeschrieben: $1\"");
    tc.events.clear();
    assert!(matches!(rebase_start(&tc, id.clone(), "main".into(), None).await.unwrap(), OpResult::Done { .. }));
    let events = hook_events(&tc);
    assert!(events.contains(&ran("pre-rebase", "Rebase geprüft", 0)), "{events:?}");
    assert!(events.contains(&ran("post-rewrite", "umgeschrieben: rebase", 0)), "{events:?}");
    assert_eq!(hook_dirs(&tc), 0, "the wrappers are cleaned up");
}

#[tokio::test]
async fn interactive_rebase_and_squash_report_their_hooks() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let base = repo.head();
    let one = repo.commit_file("a.txt", "1\n", "Eins");
    let two = repo.commit_file("b.txt", "2\n", "Zwei");
    let three = repo.commit_file("c.txt", "3\n", "Drei");
    let id = tc.open(&repo).await.repo.id;

    write_hook(&repo, "pre-rebase", "echo 'nicht jetzt' >&2\nexit 1");
    tc.events.clear();
    let err = squash_commits(&tc, id.clone(), vec![one.clone(), two.clone()], "Eins und zwei".into()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::HookFailed, "{err:?}");
    assert!(err.message.contains("pre-rebase") && err.message.contains("the squash"), "{}", err.message);
    assert_eq!(hook_events(&tc), [ran("pre-rebase", "nicht jetzt", 1)]);
    assert_eq!(repo.head(), three);
    let RebasePlan::Ok { mut rows, .. } = rebase_plan(&tc, id.clone(), base.clone()).await.unwrap() else { panic!("expected a plan") };
    rows[2].action = RebaseAction::Drop;
    tc.events.clear();
    let err = rebase_apply(&tc, id.clone(), base.clone(), rows.clone()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::HookFailed, "{err:?}");
    assert!(err.message.contains("the rebase"), "{}", err.message);
    assert_eq!(repo.head(), three);
    clean(&tc, &id).await;
    assert!(undo::next_undo(&tc, &id, "").unwrap().is_none());

    remove_hook(&repo, "pre-rebase");
    write_hook(&repo, "post-rewrite", "echo \"fertig: $1\"");
    tc.events.clear();
    assert!(matches!(squash_commits(&tc, id.clone(), vec![one, two], "Eins und zwei".into()).await.unwrap(), OpResult::Done { .. }));
    // The hook runs per rewritten commit and at the end for the rebase: one event with all lines.
    let rewritten = |tc: &TestCore| hook_events(tc).iter().any(|(hook, output, code)| hook == "post-rewrite" && output.ends_with("fertig: rebase") && *code == 0);
    assert!(rewritten(&tc), "{:?}", hook_events(&tc));
    let RebasePlan::Ok { mut rows, .. } = rebase_plan(&tc, id.clone(), base.clone()).await.unwrap() else { panic!("expected a plan") };
    assert_eq!(rows.len(), 2);
    // Drop the older one: the newer one is rewritten, post-rewrite runs.
    rows[0].action = RebaseAction::Drop;
    tc.events.clear();
    assert!(matches!(rebase_apply(&tc, id.clone(), base, rows).await.unwrap(), OpResult::Done { .. }));
    assert!(rewritten(&tc), "{:?}", hook_events(&tc));
    assert_eq!(hook_dirs(&tc), 0);
}

#[tokio::test]
async fn cherry_pick_reports_hooks_and_a_refusing_hook_halts_it() {
    let tc = TestCore::new().await;
    let repo = two_branches();
    let feature = repo.git(&["rev-parse", "feature"]);
    let main = repo.head();
    let id = tc.open(&repo).await.repo.id;

    write_hook(&repo, "post-commit", "echo 'Commit angelegt'");
    tc.events.clear();
    assert!(matches!(cherry_pick(&tc, id.clone(), vec![feature.clone()]).await.unwrap(), OpResult::Done { .. }));
    assert!(hook_events(&tc).contains(&ran("post-commit", "Commit angelegt", 0)), "{:?}", hook_events(&tc));
    repo.git(&["reset", "-q", "--hard", &main]);

    // The hook refuses the commit: the cherry-pick is applied but not committed.
    write_hook(&repo, "prepare-commit-msg", "echo 'Message nicht erlaubt' >&2\nexit 2");
    tc.events.clear();
    let err = cherry_pick(&tc, id.clone(), vec![feature]).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::HookFailed, "{err:?}");
    assert!(err.message.contains("prepare-commit-msg") && err.message.contains("cherry-pick") && err.message.contains("exit code 2"), "{}", err.message);
    assert!(err.message.contains("paused"), "{}", err.message);
    assert!(hook_events(&tc).contains(&ran("prepare-commit-msg", "Message nicht erlaubt", 2)), "{:?}", hook_events(&tc));
    assert_eq!(repo.head(), main, "no commit");
    let status = read_status(&tc, &id).await.unwrap();
    assert!(status.operation.is_some(), "the cherry-pick is pending");
    operation_abort(&tc, id.clone()).await.unwrap();
    clean(&tc, &id).await;
    let offered = crate::commands::undo::undo_peek(&tc, id.clone()).await.unwrap().undo;
    assert!(offered.is_none(), "an aborted cherry-pick leaves no undo step: {offered:?}");
    assert_eq!(hook_dirs(&tc), 0);
}

#[tokio::test]
async fn revert_reports_hooks_and_a_refusing_hook_halts_it() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let target = repo.commit_file("a.txt", "a\n", "Mit a");
    let id = tc.open(&repo).await.repo.id;

    write_hook(&repo, "prepare-commit-msg", "echo 'nein' >&2\nexit 1");
    tc.events.clear();
    let err = revert_commit(&tc, id.clone(), target.clone()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::HookFailed, "{err:?}");
    assert!(err.message.contains("prepare-commit-msg") && err.message.contains("the revert"), "{}", err.message);
    assert!(hook_events(&tc).contains(&ran("prepare-commit-msg", "nein", 1)), "{:?}", hook_events(&tc));
    assert_eq!(repo.head(), target);
    // Nothing is left half done: no revert pending, nothing staged.
    assert!(!err.message.contains("paused"), "{}", err.message);
    clean(&tc, &id).await;
    assert!(repo.path().join("a.txt").exists());
    // Other local changes survive a refused revert.
    repo.write_file("README.md", "# Test\nlokal\n");
    let err = revert_commit(&tc, id.clone(), target.clone()).await.unwrap_err();
    assert!(matches!(err.code, ErrorCode::HookFailed | ErrorCode::DirtyWorktree), "{err:?}");
    assert_eq!(repo.read_file("README.md"), b"# Test\nlokal\n");
    repo.git(&["checkout", "-q", "--", "README.md"]);
    clean(&tc, &id).await;

    remove_hook(&repo, "prepare-commit-msg");
    write_hook(&repo, "post-commit", "echo 'zurückgenommen'");
    tc.events.clear();
    assert!(matches!(revert_commit(&tc, id.clone(), target).await.unwrap(), OpResult::Done { .. }));
    assert!(hook_events(&tc).contains(&ran("post-commit", "zurückgenommen", 0)), "{:?}", hook_events(&tc));
    assert!(!repo.path().join("a.txt").exists());
    assert_eq!(hook_dirs(&tc), 0);
}

#[tokio::test]
async fn pre_push_is_reported_when_pushing_a_tag() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let remote = repo.add_remote();
    let id = tc.open(&repo).await.repo.id;
    tag_create(&tc, id.clone(), "v1".into(), None, None).await.unwrap();

    write_hook(&repo, "pre-push", "echo \"kein Push nach $1\" >&2\nexit 5");
    tc.events.clear();
    let err = tag_push(&tc, id.clone(), "job-tag-1".into(), "v1".into(), "origin".into()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::HookFailed, "{err:?}");
    assert!(err.message.contains("pre-push") && err.message.contains("exit code 5"), "{}", err.message);
    assert_eq!(hook_events(&tc), [ran("pre-push", "kein Push nach origin", 5)]);
    assert!(!remote.git_output(&["rev-parse", "--verify", "-q", "refs/tags/v1"]).status.success(), "the tag did not arrive");
    let done = tc.events.named(names::JOB_DONE);
    assert_eq!((done.len(), done[0]["ok"].as_bool()), (1, Some(false)));

    write_hook(&repo, "pre-push", "echo 'Push geprüft'");
    tc.events.clear();
    let result = tag_push(&tc, id.clone(), "job-tag-2".into(), "v1".into(), "origin".into()).await.unwrap();
    assert!(matches!(result, PushResult::Done { .. }), "{result:?}");
    assert_eq!(hook_events(&tc), [ran("pre-push", "Push geprüft", 0)]);
    assert_eq!(remote.git(&["rev-parse", "refs/tags/v1"]), repo.head());
    assert_eq!(hook_dirs(&tc), 0);
}
