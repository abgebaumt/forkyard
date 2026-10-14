//! Tests against real temp repositories. Continuing after a conflict runs here
//! through the Git runner with its default environment (`GIT_EDITOR=:`), i.e. exactly
//! the way `operation_continue` will do it – without the helper program and without an environment from here.

use super::*;
use crate::db::undo::UndoEntry;
use crate::events::names;
use crate::testkit::{TestCore, TestRepo, AUTHOR_NAME};

async fn setup() -> (TestCore, TestRepo, String) {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    tc.events.clear();
    (tc, repo, id)
}

/// Summaries of `range`, oldest first.
fn subjects(repo: &TestRepo, range: &str) -> Vec<String> {
    repo.git(&["log", "--reverse", "--format=%s", range]).lines().map(str::to_string).collect()
}

fn message(repo: &TestRepo, rev: &str) -> String {
    repo.git(&["log", "-1", "--format=%B", rev])
}

fn files_of(repo: &TestRepo, rev: &str) -> Vec<String> {
    repo.git(&["-c", "core.quotepath=false", "show", "--name-only", "--format=", rev]).lines().map(str::to_string).collect()
}

fn top_undo(tc: &TestCore, id: &str) -> UndoEntry {
    undo::next_undo(tc, id, "").unwrap().expect("undo entry missing")
}

fn backup_ref(repo: &TestRepo, entry: &UndoEntry) -> Option<String> {
    let name = undo::backup_ref_name(&entry.id, "before");
    let out = repo.git_output(&["rev-parse", "--verify", "-q", &name]);
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn changed_events(tc: &TestCore) -> usize {
    tc.events.count(names::REPO_CHANGED)
}

fn row(sha: &str, action: RebaseAction, message: Option<&str>) -> RebasePlanRow {
    RebasePlanRow {
        sha: sha.to_string(),
        summary: String::new(),
        description: String::new(),
        author: Person { name: String::new(), email: String::new() },
        authored_at: String::new(),
        action,
        message: message.map(str::to_string),
    }
}

/// Like `operation_continue`: the runner with its default environment.
async fn git_continue(tc: &TestCore, id: &str, subcommand: &str) -> GitOutput {
    tc.git_for(id).unwrap().args([subcommand, "--continue"]).run_raw().await.unwrap()
}

fn code_of<T: std::fmt::Debug>(result: CoreResult<T>) -> ErrorCode {
    result.expect_err("expected an error").code
}

// --- Rebase ------------------------------------------------------------------

#[tokio::test]
async fn rebase_moves_the_branch_and_records_undo() {
    let (tc, repo, id) = setup().await;
    repo.checkout_new("feature");
    repo.commit_file("f1.txt", "eins\n", "Feature 1");
    let old_tip = repo.commit_file("Ordner mit Leerzeichen/Größe.txt", "zwei\r\nohne Ende", "Feature 2");
    repo.checkout("main");
    let main_tip = repo.commit_file("m.txt", "main\n", "Main geht weiter");
    repo.checkout("feature");

    let result = rebase_start(&tc, id.clone(), "main".into(), None).await.unwrap();
    let new_tip = repo.head();
    match &result {
        OpResult::Done { sha, fast_forward, summary } => {
            assert_eq!(sha.as_deref(), Some(new_tip.as_str()));
            assert!(!fast_forward);
            assert_eq!(summary, "Rebased 2 commits of ‘feature’ onto ‘main’.");
        }
        other => panic!("{other:?}"),
    }
    assert_ne!(new_tip, old_tip);
    assert_eq!(repo.current_branch(), "feature");
    assert_eq!(subjects(&repo, &format!("{main_tip}..HEAD")), ["Feature 1", "Feature 2"]);
    assert_eq!(repo.git(&["rev-parse", "HEAD~2"]), main_tip);
    assert_eq!(repo.read_file("Ordner mit Leerzeichen/Größe.txt"), b"zwei\r\nohne Ende");
    assert_eq!(repo.git(&["status", "--porcelain"]), "");

    let entry = top_undo(&tc, &id);
    assert_eq!(entry.action, "rebase");
    assert_eq!(entry.label, "Undo rebase of feature onto main");
    assert_eq!(entry.ref_name.as_deref(), Some("refs/heads/feature"));
    assert_eq!(entry.ref_before.as_deref(), Some(old_tip.as_str()));
    assert_eq!(entry.ref_after.as_deref(), Some(new_tip.as_str()));
    assert_eq!(entry.head_before, "refs/heads/feature");
    assert_eq!(entry.head_after.as_deref(), Some("refs/heads/feature"));
    assert_eq!(entry.payload["branch"], "feature");
    assert_eq!(entry.payload["pending"], false);
    assert_eq!(backup_ref(&repo, &entry).as_deref(), Some(old_tip.as_str()));

    let events = tc.events.named(names::REPO_CHANGED);
    assert_eq!(events.len(), 1);
    let what: Vec<&str> = events[0]["what"].as_array().unwrap().iter().filter_map(|v| v.as_str()).collect();
    for kind in ["refs", "head", "worktree", "index", "operation"] {
        assert!(what.contains(&kind), "{kind} fehlt in {what:?}");
    }
}

#[tokio::test]
async fn rebase_up_to_date_fast_forward_and_onto_a_sha() {
    let (tc, repo, id) = setup().await;
    let base = repo.head();
    repo.checkout_new("feature");
    let feature = repo.commit_file("f.txt", "f\n", "Feature");

    // main is an ancestor of feature: nothing to do, no event, no undo entry.
    assert_eq!(rebase_start(&tc, id.clone(), "main".into(), None).await.unwrap(), OpResult::UpToDate);
    assert_eq!(rebase_start(&tc, id.clone(), base.clone(), None).await.unwrap(), OpResult::UpToDate);
    assert_eq!(changed_events(&tc), 0);
    assert!(undo::next_undo(&tc, &id, "").unwrap().is_none());

    // main onto feature: a plain fast-forward.
    repo.checkout("main");
    match rebase_start(&tc, id.clone(), feature.clone(), None).await.unwrap() {
        OpResult::Done { sha, fast_forward, summary } => {
            assert_eq!(sha.as_deref(), Some(feature.as_str()));
            assert!(fast_forward);
            assert_eq!(summary, format!("‘main’ was fast-forwarded to ‘{}’.", &feature[..7]));
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(repo.head(), feature);
    assert_eq!(repo.current_branch(), "main");
    let entry = top_undo(&tc, &id);
    assert_eq!(entry.ref_before.as_deref(), Some(base.as_str()));
    assert_eq!(entry.ref_after.as_deref(), Some(feature.as_str()));
}

#[tokio::test]
async fn rebase_of_another_branch_checks_it_out_first() {
    let (tc, repo, id) = setup().await;
    repo.checkout_new("thema");
    let old_tip = repo.commit_file("t.txt", "t\n", "Thema");
    repo.checkout("main");
    repo.commit_file("m.txt", "m\n", "Main");
    let remote = repo.add_remote();
    let _ = remote;

    // Target as a remote branch, source as a branch that is not checked out.
    let result = rebase_start(&tc, id.clone(), "origin/main".into(), Some("thema".into())).await.unwrap();
    assert!(matches!(result, OpResult::Done { fast_forward: false, .. }), "{result:?}");
    assert_eq!(repo.current_branch(), "thema");
    assert_eq!(subjects(&repo, "main..thema"), ["Thema"]);
    let entry = top_undo(&tc, &id);
    assert_eq!(entry.label, "Undo rebase of thema onto origin/main");
    assert_eq!(entry.head_before, "refs/heads/main");
    assert_eq!(entry.head_after.as_deref(), Some("refs/heads/thema"));
    assert_eq!(entry.ref_before.as_deref(), Some(old_tip.as_str()));

    assert_eq!(code_of(rebase_start(&tc, id.clone(), "main".into(), Some("gibt-es-nicht".into())).await), ErrorCode::NotFound);
    assert_eq!(code_of(rebase_start(&tc, id.clone(), "gibt-es-nicht".into(), None).await), ErrorCode::NotFound);
    assert_eq!(code_of(rebase_start(&tc, id.clone(), "--exec=x".into(), None).await), ErrorCode::NotFound);
}

/// Two commits on feature, the first one collides with main.
fn conflicting_feature(repo: &TestRepo) -> (String, String) {
    repo.commit_file("Größe und Maß.txt", "basis\n", "Datei anlegen");
    repo.checkout_new("feature");
    repo.commit_file("Größe und Maß.txt", "feature\n", "Feature ändert");
    let feature_tip = repo.commit_file("g.txt", "g\n", "Feature ergänzt");
    repo.checkout("main");
    let main_tip = repo.commit_file("Größe und Maß.txt", "main\n", "Main ändert");
    repo.checkout("feature");
    (feature_tip, main_tip)
}

#[tokio::test]
async fn rebase_conflict_leaves_a_continuable_rebase_and_an_open_undo_entry() {
    let (tc, repo, id) = setup().await;
    let (old_tip, main_tip) = conflicting_feature(&repo);

    let result = rebase_start(&tc, id.clone(), "main".into(), None).await.unwrap();
    let OpResult::Conflict { files, operation, .. } = result else {
        panic!("expected a conflict");
    };
    assert_eq!(files, ["Größe und Maß.txt"]);
    let operation = operation.unwrap();
    assert_eq!(operation.kind, OperationKind::Rebase);
    assert_eq!(operation.source.as_deref(), Some("feature"));
    assert_eq!(operation.target.as_deref(), Some("main"));
    assert_eq!((operation.step, operation.total_steps), (Some(1), Some(2)));
    assert_eq!(status::read_operation(&tc, &id).await.unwrap(), Some(operation));
    assert_eq!(changed_events(&tc), 1);

    // The entry knows the old tip but is still open.
    let entry = top_undo(&tc, &id);
    assert_eq!(entry.action, "rebase");
    assert_eq!(entry.ref_before.as_deref(), Some(old_tip.as_str()));
    assert_eq!(entry.ref_after, None);
    assert_eq!(entry.head_after, None);
    assert_eq!(entry.payload["pending"], true);
    assert_eq!(backup_ref(&repo, &entry).as_deref(), Some(old_tip.as_str()));

    // While the rebase is running nothing else works, and the entry stays open.
    assert_eq!(code_of(rebase_start(&tc, id.clone(), "main".into(), None).await), ErrorCode::OperationInProgress);
    assert_eq!(code_of(cherry_pick(&tc, id.clone(), vec![main_tip.clone()]).await), ErrorCode::OperationInProgress);
    assert_eq!(code_of(squash_commits(&tc, id.clone(), vec![main_tip.clone(), old_tip.clone()], "x".into()).await), ErrorCode::OperationInProgress);
    assert_eq!(code_of(rebase_apply(&tc, id.clone(), main_tip.clone(), vec![]).await), ErrorCode::OperationInProgress);
    match rebase_plan(&tc, id.clone(), main_tip.clone()).await.unwrap() {
        RebasePlan::Refused { reason, detail, message } => {
            assert_eq!((reason, detail), (RebaseRefusal::OperationInProgress, None));
            assert!(message.contains("a rebase"), "{message}");
        }
        other => panic!("{other:?}"),
    }
    settle_pending_undo(&tc, &id).await.unwrap();
    assert_eq!(top_undo(&tc, &id).payload["pending"], true);

    // Resolve and continue like `operation_continue`.
    repo.write_file("Größe und Maß.txt", "feature und main\n");
    repo.git(&["add", "-A"]);
    let out = git_continue(&tc, &id, "rebase").await;
    assert!(out.success(), "{}", out.stderr_text());
    assert_eq!(status::read_operation(&tc, &id).await.unwrap(), None);
    assert_eq!(repo.current_branch(), "feature");
    assert_eq!(subjects(&repo, "main..feature"), ["Feature ändert", "Feature ergänzt"]);

    settle_pending_undo(&tc, &id).await.unwrap();
    let entry = top_undo(&tc, &id);
    assert_eq!(entry.ref_after.as_deref(), Some(repo.head().as_str()));
    assert_eq!(entry.head_after.as_deref(), Some("refs/heads/feature"));
    assert_eq!(entry.payload["pending"], false);
    assert_eq!(entry.payload["branch"], "feature");
}

#[tokio::test]
async fn aborted_rebase_drops_the_open_undo_entry() {
    let (tc, repo, id) = setup().await;
    let (old_tip, _) = conflicting_feature(&repo);
    assert!(matches!(rebase_start(&tc, id.clone(), "main".into(), None).await.unwrap(), OpResult::Conflict { .. }));
    let entry = top_undo(&tc, &id);

    let out = tc.git_for(&id).unwrap().args(["rebase", "--abort"]).run_raw().await.unwrap();
    assert!(out.success());
    assert_eq!(repo.head(), old_tip);
    settle_pending_undo(&tc, &id).await.unwrap();
    assert!(undo::next_undo(&tc, &id, "").unwrap().is_none());
    assert_eq!(backup_ref(&repo, &entry), None);
}

#[tokio::test]
async fn rebase_refuses_dirty_worktree_detached_head_and_empty_repo() {
    let (tc, repo, id) = setup().await;
    repo.checkout_new("feature");
    repo.commit_file("f.txt", "f\n", "Feature");
    repo.checkout("main");
    repo.commit_file("m.txt", "m\n", "Main");
    repo.checkout("feature");
    let tip = repo.head();

    // Untracked files don't get in the way, changed and staged ones do.
    repo.write_file("f.txt", "geändert\n");
    assert_eq!(code_of(rebase_start(&tc, id.clone(), "main".into(), None).await), ErrorCode::DirtyWorktree);
    repo.git(&["add", "f.txt"]);
    assert_eq!(code_of(rebase_start(&tc, id.clone(), "main".into(), None).await), ErrorCode::DirtyWorktree);
    assert_eq!(code_of(cherry_pick(&tc, id.clone(), vec![repo.git(&["rev-parse", "main"])]).await), ErrorCode::DirtyWorktree);
    assert_eq!(repo.head(), tip);
    assert_eq!(repo.read_file("f.txt"), b"ge\xc3\xa4ndert\n", "nothing was stashed or discarded");
    assert_eq!(changed_events(&tc), 0, "a refused precondition reports no change");
    assert!(undo::next_undo(&tc, &id, "").unwrap().is_none());
    repo.git(&["reset", "-q", "--hard"]);

    repo.write_file("neu und unverfolgt.txt", "x\n");
    assert!(matches!(rebase_start(&tc, id.clone(), "main".into(), None).await.unwrap(), OpResult::Done { .. }));
    assert_eq!(repo.read_file("neu und unverfolgt.txt"), b"x\n");

    // Detached HEAD: not allowed without naming a branch.
    repo.git(&["checkout", "-q", "--detach"]);
    let err = rebase_start(&tc, id.clone(), "main".into(), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    assert!(err.message.contains("detached HEAD"), "{}", err.message);

    // Empty repository without a commit.
    let empty = TestRepo::new();
    let empty_id = tc.open(&empty).await.repo.id;
    assert_eq!(code_of(rebase_start(&tc, empty_id.clone(), "main".into(), None).await), ErrorCode::NotAllowed);
    assert_eq!(code_of(cherry_pick(&tc, empty_id.clone(), vec![tip.clone()]).await), ErrorCode::NotAllowed);
    assert_eq!(code_of(squash_commits(&tc, empty_id.clone(), vec![tip.clone(), tip.clone()], "x".into()).await), ErrorCode::NotAllowed);
    assert_eq!(code_of(rebase_apply(&tc, empty_id.clone(), tip.clone(), vec![]).await), ErrorCode::NotAllowed);
    match rebase_plan(&tc, empty_id, "main".into()).await.unwrap() {
        RebasePlan::Refused { reason, .. } => assert_eq!(reason, RebaseRefusal::NothingToRebase),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn foreign_index_lock_is_reported_and_changes_nothing() {
    let (tc, repo, id) = setup().await;
    repo.checkout_new("feature");
    let a = repo.commit_file("f.txt", "f\n", "Feature");
    let tip = repo.commit_file("g.txt", "g\n", "Feature 2");
    repo.checkout("main");
    let main_tip = repo.commit_file("m.txt", "m\n", "Main");
    repo.checkout("feature");
    let base = repo.git(&["merge-base", "main", "feature"]);
    let lock = repo.path().join(".git").join("index.lock");
    std::fs::write(&lock, "").unwrap();

    let err = rebase_start(&tc, id.clone(), "main".into(), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Locked, "{err:?}");
    let err = cherry_pick(&tc, id.clone(), vec![main_tip.clone()]).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Locked, "{err:?}");
    let rows = vec![row(&tip, RebaseAction::Pick, None), row(&a, RebaseAction::Pick, None)];
    let err = rebase_apply(&tc, id.clone(), base, rows).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Locked, "{err:?}");

    assert!(lock.exists(), "the foreign lock file is never deleted");
    assert_eq!(repo.head(), tip);
    std::fs::remove_file(&lock).unwrap();
    assert_eq!(repo.current_branch(), "feature");
    assert_eq!(status::read_operation(&tc, &id).await.unwrap(), None);
    assert!(undo::next_undo(&tc, &id, "").unwrap().is_none());
    assert_eq!(repo.git(&["for-each-ref", "refs/forkyard"]), "", "no backup refs are left behind");
}

#[tokio::test]
async fn untracked_file_in_the_way_stops_without_being_overwritten() {
    let (tc, repo, id) = setup().await;
    repo.checkout_new("feature");
    repo.commit_file("y.txt", "aus dem Commit
", "F1: y anlegen");
    repo.git(&["rm", "-q", "y.txt"]);
    repo.commit("F2: y löschen");
    let old_tip = repo.head();
    repo.checkout("main");
    repo.commit_file("x.txt", "main
", "Main");
    repo.checkout("feature");

    // Even checking out the target fails: nothing starts.
    repo.write_file("x.txt", "unverfolgt
");
    let err = rebase_start(&tc, id.clone(), "main".into(), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::DirtyWorktree, "{err:?}");
    assert!(err.message.starts_with("Untracked files"), "{}", err.message);
    assert_eq!(status::read_operation(&tc, &id).await.unwrap(), None);
    assert_eq!((repo.head(), repo.current_branch()), (old_tip.clone(), "feature".to_string()));
    assert_eq!(repo.read_file("x.txt"), b"unverfolgt
");
    assert!(undo::next_undo(&tc, &id, "").unwrap().is_none());
    assert_eq!(repo.git(&["for-each-ref", "refs/forkyard"]), "");
    repo.remove_file("x.txt");

    // In the middle of the rebase: Git stops without conflicted files. That is an error with a running operation.
    repo.write_file("y.txt", "unverfolgt
");
    let err = rebase_start(&tc, id.clone(), "main".into(), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::DirtyWorktree, "{err:?}");
    assert!(err.message.contains("paused"), "{}", err.message);
    assert!(err.git_output.is_some());
    assert_eq!(status::read_operation(&tc, &id).await.unwrap().map(|o| o.kind), Some(OperationKind::Rebase));
    assert_eq!(repo.read_file("y.txt"), b"unverfolgt
");
    let entry = top_undo(&tc, &id);
    assert_eq!((entry.ref_before.as_deref(), entry.ref_after.as_deref()), (Some(old_tip.as_str()), None));
    assert_eq!(entry.payload["pending"], true);

    // File out of the way, continue.
    repo.remove_file("y.txt");
    let out = git_continue(&tc, &id, "rebase").await;
    assert!(out.success(), "{}", out.stderr_text());
    assert_eq!(subjects(&repo, "main..feature"), ["F1: y anlegen", "F2: y löschen"]);
}

#[tokio::test]
async fn cherry_pick_does_not_skip_a_commit_that_could_not_be_applied() {
    let (tc, repo, id) = setup().await;
    repo.checkout_new("quelle");
    let x1 = repo.commit_file("a.txt", "a
", "X1");
    let x2 = repo.commit_file("y.txt", "aus dem Commit
", "X2: y anlegen");
    repo.checkout("main");
    let old_head = repo.head();
    repo.write_file("y.txt", "unverfolgt
");

    // On its own: nothing happens.
    let err = cherry_pick(&tc, id.clone(), vec![x2.clone()]).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::DirtyWorktree, "{err:?}");
    assert_eq!(repo.head(), old_head);
    assert_eq!(status::read_operation(&tc, &id).await.unwrap(), None);
    assert!(undo::next_undo(&tc, &id, "").unwrap().is_none());

    // In a sequence: what has been applied stays; the rest is neither skipped nor left behind as a
    // continuable sequence (continuing would silently leave out the commit).
    for empty_drop in [true, false] {
        let touched = AtomicBool::new(false);
        let err = pick_commits(&tc, &id, &[x1.clone(), x2.clone()], empty_drop, &touched).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::DirtyWorktree, "{err:?}");
        assert!(err.message.contains("‘X2: y anlegen’ wasn't applied"), "{}", err.message);
        assert!(err.message.contains("(1 of 2 applied)"), "{}", err.message);
        assert!(err.git_output.is_some());
        assert_eq!(subjects(&repo, &format!("{old_head}..HEAD")), ["X1"]);
        assert_eq!(status::read_operation(&tc, &id).await.unwrap(), None);
        assert_eq!(repo.read_file("y.txt"), b"unverfolgt
");
        assert_eq!(repo.git(&["status", "--porcelain"]), "?? y.txt");
        let entry = top_undo(&tc, &id);
        assert_eq!(entry.payload["pending"], false);
        assert_eq!((entry.ref_before.as_deref(), entry.ref_after.as_deref()), (Some(old_head.as_str()), Some(repo.head().as_str())));
        repo.git(&["reset", "-q", "--hard", &old_head]);
    }
}

// --- Plan ----------------------------------------------------------------------

#[tokio::test]
async fn plan_lists_commits_oldest_first_and_detects_pushed_commits() {
    let (tc, repo, id) = setup().await;
    let base = repo.head();
    let a = repo.commit_file("a.txt", "a\n", "A: erste Zeile\n\nKörper von A\nzweite Zeile");
    let remote = repo.add_remote();
    let _ = remote;
    let b = repo.commit_file("b.txt", "b\n", "B: „Sonderzeichen“ & mehr");

    match rebase_plan(&tc, id.clone(), base.clone()).await.unwrap() {
        RebasePlan::Ok { branch, base: plan_base, rows, rewrites_pushed, dependent_branches } => {
            assert!(dependent_branches.is_empty(), "{dependent_branches:?}");
            assert_eq!(branch, "main");
            assert_eq!(plan_base, base);
            assert_eq!(rows.iter().map(|r| r.sha.as_str()).collect::<Vec<_>>(), [a.as_str(), b.as_str()]);
            assert_eq!(rows[0].summary, "A: erste Zeile");
            assert_eq!(rows[0].description, "Körper von A\nzweite Zeile");
            assert_eq!(rows[1].summary, "B: „Sonderzeichen“ & mehr");
            assert_eq!(rows[1].description, "");
            assert_eq!(rows[0].author.name, AUTHOR_NAME);
            assert!(rows[0].authored_at.starts_with("2026-01-01T00:"), "{}", rows[0].authored_at);
            assert!(rows.iter().all(|r| r.action == RebaseAction::Pick && r.message.is_none()));
            assert!(rewrites_pushed, "A is already on origin/main");
        }
        other => panic!("{other:?}"),
    }
    // Base as a remote's branch name: only the local commit, nothing pushed.
    match rebase_plan(&tc, id.clone(), "origin/main".into()).await.unwrap() {
        RebasePlan::Ok { base, rows, rewrites_pushed, .. } => {
            assert_eq!(base, a);
            assert_eq!(rows.len(), 1);
            assert!(!rewrites_pushed);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(code_of(rebase_plan(&tc, id.clone(), "gibt-es-nicht".into()).await), ErrorCode::NotFound);
    assert_eq!(changed_events(&tc), 0);
}

#[tokio::test]
async fn plan_refusals() {
    let (tc, repo, id) = setup().await;
    let base = repo.head();
    let reason = |plan: RebasePlan| match plan {
        RebasePlan::Refused { reason, message, detail } => {
            assert!(!message.is_empty());
            assert!(!message.contains('‘'), "names are in “…”: {message}");
            assert_eq!(detail.is_some(), reason == RebaseRefusal::NoCommonAncestor, "detail only for no_common_ancestor");
            reason
        }
        other => panic!("{other:?}"),
    };
    let detail = |plan: RebasePlan| match plan {
        RebasePlan::Refused { detail, .. } => detail,
        other => panic!("{other:?}"),
    };

    assert_eq!(reason(rebase_plan(&tc, id.clone(), "HEAD".into()).await.unwrap()), RebaseRefusal::NothingToRebase);

    // Merge commit in the range.
    repo.checkout_new("seite");
    repo.commit_file("s.txt", "s\n", "Seite");
    repo.checkout("main");
    repo.commit_file("m.txt", "m\n", "Main");
    repo.git(&["merge", "--no-ff", "--no-edit", "seite"]);
    let after_merge = repo.commit_file("n.txt", "n\n", "Nach dem Merge");
    assert_eq!(reason(rebase_plan(&tc, id.clone(), base.clone()).await.unwrap()), RebaseRefusal::MergeCommits);
    let rows = vec![row(&after_merge, RebaseAction::Pick, None)];
    assert_eq!(code_of(rebase_apply(&tc, id.clone(), base.clone(), rows).await), ErrorCode::StaleState);

    // Base is not an ancestor: a sibling branch and an unrelated history.
    repo.checkout_new("neben");
    repo.git(&["reset", "-q", "--hard", &base]);
    let sibling = repo.commit_file("x.txt", "x\n", "Daneben");
    repo.git(&["checkout", "-q", "--orphan", "fremd"]);
    let unrelated = repo.commit("Fremde Wurzel");
    repo.checkout("main");
    assert_eq!(reason(rebase_plan(&tc, id.clone(), sibling.clone()).await.unwrap()), RebaseRefusal::NoCommonAncestor);
    assert_eq!(reason(rebase_plan(&tc, id.clone(), unrelated.clone()).await.unwrap()), RebaseRefusal::NoCommonAncestor);
    // The two cases are told apart by the `detail` field, not by the wording.
    assert_eq!(detail(rebase_plan(&tc, id.clone(), sibling.clone()).await.unwrap()), Some(crate::model::RebaseRefusalDetail::NotAncestor));
    assert_eq!(detail(rebase_plan(&tc, id.clone(), unrelated.clone()).await.unwrap()), Some(crate::model::RebaseRefusalDetail::UnrelatedHistory));
    assert_eq!(code_of(rebase_apply(&tc, id.clone(), sibling, vec![]).await), ErrorCode::StaleState);

    // Uncommitted changes.
    let before_merge = repo.git(&["rev-parse", "HEAD~1"]);
    let _ = before_merge;
    repo.write_file("n.txt", "geändert\n");
    assert_eq!(reason(rebase_plan(&tc, id.clone(), "HEAD~1".into()).await.unwrap()), RebaseRefusal::DirtyWorktree);
    repo.git(&["reset", "-q", "--hard"]);

    // Detached HEAD.
    repo.git(&["checkout", "-q", "--detach"]);
    assert_eq!(reason(rebase_plan(&tc, id.clone(), "HEAD~1".into()).await.unwrap()), RebaseRefusal::Detached);
    let rows = vec![row(&after_merge, RebaseAction::Reword, Some("x"))];
    assert_eq!(code_of(rebase_apply(&tc, id.clone(), "HEAD~1".into(), rows).await), ErrorCode::NotAllowed);
}

// --- Apply a plan ---------------------------------------------------------------

/// Five commits A–E on main, each with its own file. Returns the base and the SHAs.
fn five_commits(repo: &TestRepo) -> (String, Vec<String>) {
    let base = repo.head();
    let shas = vec![
        repo.commit_file("a.txt", "a\n", "A: Datei a"),
        repo.commit_file("b.txt", "b\n", "B: Datei b\n\nKörper von B"),
        repo.commit_file("c.txt", "c\n", "C: Datei c"),
        repo.commit_file("d.txt", "d\n", "D: Datei d"),
        repo.commit_file("Ordner mit Leerzeichen/Ümlaut.txt", "e\r\nohne Ende", "E: Datei e"),
    ];
    (base, shas)
}

#[tokio::test]
async fn apply_runs_every_action_and_a_new_order() {
    let (tc, repo, id) = setup().await;
    let (base, s) = five_commits(&repo);
    let old_tip = repo.head();
    let author_date_a = repo.git(&["log", "-1", "--format=%at", &s[0]]);

    // C to the front, A reworded and B folded in, D removed, E stays.
    let rows = vec![
        row(&s[2], RebaseAction::Pick, None),
        row(&s[0], RebaseAction::Reword, Some("A und B zusammen\n\nNeuer Körper")),
        row(&s[1], RebaseAction::Squash, None),
        row(&s[3], RebaseAction::Drop, None),
        row(&s[4], RebaseAction::Pick, None),
    ];
    let result = rebase_apply(&tc, id.clone(), base.clone(), rows).await.unwrap();
    let new_tip = repo.head();
    match &result {
        OpResult::Done { sha, fast_forward, summary } => {
            assert_eq!(sha.as_deref(), Some(new_tip.as_str()));
            assert!(!fast_forward);
            assert_eq!(summary, "Interactive rebase complete: 2 commits squashed, 1 commit dropped, order changed.");
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(repo.current_branch(), "main");
    assert_eq!(subjects(&repo, &format!("{base}..HEAD")), ["C: Datei c", "A und B zusammen", "E: Datei e"]);
    assert_eq!(message(&repo, "HEAD~1"), "A und B zusammen\n\nNeuer Körper");
    assert_eq!(files_of(&repo, "HEAD~1"), ["a.txt", "b.txt"]);
    assert_eq!(repo.git(&["log", "-1", "--format=%at", "HEAD~1"]), author_date_a, "the target's author date stays");
    assert_eq!(repo.git(&["rev-parse", "HEAD~3"]), base);
    assert!(!repo.path().join("d.txt").exists());
    assert_eq!(repo.read_file("a.txt"), b"a\n");
    assert_eq!(repo.read_file("Ordner mit Leerzeichen/Ümlaut.txt"), b"e\r\nohne Ende");
    assert_eq!(repo.git(&["status", "--porcelain"]), "");
    assert_eq!(status::read_operation(&tc, &id).await.unwrap(), None);
    assert_eq!(changed_events(&tc), 1);

    let entry = top_undo(&tc, &id);
    assert_eq!(entry.action, "rebase");
    assert_eq!(entry.label, "Undo interactive rebase of main");
    assert_eq!(entry.ref_before.as_deref(), Some(old_tip.as_str()));
    assert_eq!(entry.ref_after.as_deref(), Some(new_tip.as_str()));
    assert_eq!(backup_ref(&repo, &entry).as_deref(), Some(old_tip.as_str()));
    // The todo file is cleaned up.
    let tmp = tc.data_dir().join("tmp");
    assert_eq!(std::fs::read_dir(tmp).unwrap().count(), 0);
}

#[tokio::test]
async fn apply_squash_messages_and_undo_kinds() {
    let (tc, repo, id) = setup().await;
    let (base, s) = five_commits(&repo);

    // Without a message of its own: the messages of the combined commits one after another.
    let rows = vec![
        row(&s[0], RebaseAction::Pick, None),
        row(&s[1], RebaseAction::Squash, None),
        row(&s[2], RebaseAction::Squash, None),
        row(&s[3], RebaseAction::Pick, None),
        row(&s[4], RebaseAction::Pick, None),
    ];
    assert!(matches!(rebase_apply(&tc, id.clone(), base.clone(), rows).await.unwrap(), OpResult::Done { .. }));
    assert_eq!(subjects(&repo, &format!("{base}..HEAD")), ["A: Datei a", "D: Datei d", "E: Datei e"]);
    assert_eq!(message(&repo, "HEAD~2"), "A: Datei a\n\nB: Datei b\n\nKörper von B\n\nC: Datei c");
    assert_eq!(files_of(&repo, "HEAD~2"), ["a.txt", "b.txt", "c.txt"]);
    let entry = top_undo(&tc, &id);
    assert_eq!((entry.action.as_str(), entry.label.as_str()), ("squash", "Undo squash of 3 commits"));

    // The message on the squash row counts if the target carries none; a dropped commit in between doesn't matter.
    let s = subjects_shas(&repo, &base);
    let rows = vec![
        row(&s[0], RebaseAction::Pick, None),
        row(&s[1], RebaseAction::Drop, None),
        row(&s[2], RebaseAction::Squash, Some("Alles in einem")),
    ];
    assert!(matches!(rebase_apply(&tc, id.clone(), base.clone(), rows).await.unwrap(), OpResult::Done { .. }));
    assert_eq!(subjects(&repo, &format!("{base}..HEAD")), ["Alles in einem"]);
    assert!(!repo.path().join("d.txt").exists());
    assert!(repo.path().join("Ordner mit Leerzeichen/Ümlaut.txt").exists());
    assert_eq!(top_undo(&tc, &id).action, "rebase", "squash and drop together are a rebase");
}

fn subjects_shas(repo: &TestRepo, base: &str) -> Vec<String> {
    repo.git(&["rev-list", "--reverse", &format!("{base}..HEAD")]).lines().map(str::to_string).collect()
}

#[tokio::test]
async fn apply_reword_keeps_multiline_messages_and_special_characters() {
    let (tc, repo, id) = setup().await;
    let (base, s) = five_commits(&repo);
    let messages = [
        "Fix: „Anführung“ & 'einfach' \"doppelt\" $HOME %PATH% `x` \\n\n\n# sieht aus wie ein Kommentar\n  eingerückt bleibt\nÄÖÜ äöüß 🎉\n\n- Punkt eins\n- Punkt zwei",
        "amend! sieht aus wie ein Autosquash-Commit\n\nKörper",
        "fixup! auch das bleibt wörtlich",
        "# beginnt mit einer Raute",
    ];
    let rows = vec![
        row(&s[0], RebaseAction::Reword, Some(messages[0])),
        row(&s[1], RebaseAction::Reword, Some(messages[1])),
        row(&s[2], RebaseAction::Reword, Some(&format!("\r\n{}\r\n\r\n", messages[2]))),
        row(&s[3], RebaseAction::Reword, Some(messages[3])),
        row(&s[4], RebaseAction::Pick, None),
    ];
    let result = rebase_apply(&tc, id.clone(), base.clone(), rows).await.unwrap();
    assert!(matches!(result, OpResult::Done { .. }), "{result:?}");
    let new = subjects_shas(&repo, &base);
    assert_eq!(new.len(), 5);
    for (i, expected) in messages.iter().enumerate() {
        assert_eq!(message(&repo, &new[i]), *expected, "Commit {i}");
    }
    assert_eq!(message(&repo, &new[4]), "E: Datei e");
    assert_eq!(files_of(&repo, &new[0]), ["a.txt"]);
    assert_eq!(repo.git(&["diff", "--stat", &s[4], "HEAD"]), "", "the content is unchanged");
    let entry = top_undo(&tc, &id);
    assert_eq!((entry.action.as_str(), entry.label.as_str()), ("reword", "Undo reword of 4 commits"));

    // A single commit: the entry names it.
    let rows: Vec<RebasePlanRow> = new
        .iter()
        .enumerate()
        .map(|(i, sha)| if i == 4 { row(sha, RebaseAction::Reword, Some("E neu")) } else { row(sha, RebaseAction::Pick, None) })
        .collect();
    assert!(matches!(rebase_apply(&tc, id.clone(), base.clone(), rows).await.unwrap(), OpResult::Done { .. }));
    assert_eq!(message(&repo, "HEAD"), "E neu");
    let entry = top_undo(&tc, &id);
    assert_eq!(entry.label, "Undo reword of ‘E: Datei e’");
    assert_eq!(entry.payload["summary"], "E: Datei e");

    // Only remove.
    let now = subjects_shas(&repo, &base);
    let rows: Vec<RebasePlanRow> =
        now.iter().enumerate().map(|(i, sha)| row(sha, if i == 4 { RebaseAction::Drop } else { RebaseAction::Pick }, None)).collect();
    assert!(matches!(rebase_apply(&tc, id.clone(), base.clone(), rows).await.unwrap(), OpResult::Done { .. }));
    assert_eq!(subjects_shas(&repo, &base).len(), 4);
    let entry = top_undo(&tc, &id);
    assert_eq!((entry.action.as_str(), entry.label.as_str()), ("drop", "Undo drop of ‘E neu’"));
}

#[tokio::test]
async fn apply_checks_the_plan_against_the_repository() {
    let (tc, repo, id) = setup().await;
    let (base, s) = five_commits(&repo);
    let tip = repo.head();
    let picks = |shas: &[&String]| shas.iter().map(|sha| row(sha, RebaseAction::Pick, None)).collect::<Vec<_>>();

    // Unchanged: nothing to do.
    assert_eq!(rebase_apply(&tc, id.clone(), base.clone(), picks(&s.iter().collect::<Vec<_>>())).await.unwrap(), OpResult::UpToDate);
    // reword with the same message is nothing either.
    let mut rows = picks(&s.iter().collect::<Vec<_>>());
    rows[0] = row(&s[0], RebaseAction::Reword, Some("A: Datei a\n"));
    assert_eq!(rebase_apply(&tc, id.clone(), base.clone(), rows).await.unwrap(), OpResult::UpToDate);

    // Rows don't match base..HEAD: too few, foreign commit, duplicate.
    assert_eq!(code_of(rebase_apply(&tc, id.clone(), base.clone(), picks(&[&s[0], &s[1]])).await), ErrorCode::StaleState);
    assert_eq!(code_of(rebase_apply(&tc, id.clone(), base.clone(), picks(&[&s[0], &s[1], &s[2], &s[3], &base])).await), ErrorCode::StaleState);
    assert_eq!(code_of(rebase_apply(&tc, id.clone(), base.clone(), picks(&[&s[0], &s[1], &s[2], &s[3], &s[3]])).await), ErrorCode::StaleState);
    // Base is meanwhile no longer below HEAD, or equal to HEAD.
    assert_eq!(code_of(rebase_apply(&tc, id.clone(), tip.clone(), vec![]).await), ErrorCode::StaleState);
    assert_eq!(code_of(rebase_apply(&tc, id.clone(), "gibt-es-nicht".into(), vec![]).await), ErrorCode::NotFound);

    // First row squash, also behind a dropped commit.
    let mut rows = picks(&s.iter().collect::<Vec<_>>());
    rows[0].action = RebaseAction::Squash;
    assert_eq!(code_of(rebase_apply(&tc, id.clone(), base.clone(), rows.clone()).await), ErrorCode::NotAllowed);
    rows[0].action = RebaseAction::Drop;
    rows[1].action = RebaseAction::Squash;
    assert_eq!(code_of(rebase_apply(&tc, id.clone(), base.clone(), rows).await), ErrorCode::NotAllowed);
    // Remove everything.
    let rows: Vec<RebasePlanRow> = s.iter().map(|sha| row(sha, RebaseAction::Drop, None)).collect();
    let err = rebase_apply(&tc, id.clone(), base.clone(), rows).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    assert!(err.message.contains("At least one commit"), "{}", err.message);
    // reword without a message.
    let mut rows = picks(&s.iter().collect::<Vec<_>>());
    rows[2] = row(&s[2], RebaseAction::Reword, Some("  \n"));
    assert_eq!(code_of(rebase_apply(&tc, id.clone(), base.clone(), rows).await), ErrorCode::EmptyMessage);
    // Uncommitted changes.
    repo.write_file("a.txt", "geändert\n");
    let mut rows = picks(&s.iter().collect::<Vec<_>>());
    rows[4].action = RebaseAction::Drop;
    assert_eq!(code_of(rebase_apply(&tc, id.clone(), base.clone(), rows).await), ErrorCode::DirtyWorktree);

    assert_eq!(repo.head(), tip, "no refused plan changed anything");
    assert_eq!(changed_events(&tc), 0);
    assert!(undo::next_undo(&tc, &id, "").unwrap().is_none());
    assert_eq!(repo.git(&["for-each-ref", "refs/forkyard"]), "");
}

#[tokio::test]
async fn apply_conflict_can_be_continued_and_keeps_the_planned_messages() {
    let (tc, repo, id) = setup().await;
    repo.commit_file("f.txt", "1\n", "Datei f");
    let base = repo.head();
    let a = repo.commit_file("f.txt", "2\n", "A: f auf 2");
    let b = repo.commit_file("f.txt", "3\n", "B: f auf 3");
    let c = repo.commit_file("c.txt", "c\n", "C: Datei c");
    let d = repo.commit_file("d.txt", "d\n", "D: Datei d");
    let old_tip = repo.head();

    // B before A: both picks collide. After them a reword with squash that only runs after continuing.
    let rows = vec![
        row(&b, RebaseAction::Pick, None),
        row(&a, RebaseAction::Reword, Some("A neu\n\nnach dem Konflikt")),
        row(&c, RebaseAction::Reword, Some("C und D\n\n# bleibt stehen")),
        row(&d, RebaseAction::Squash, None),
    ];
    let result = rebase_apply(&tc, id.clone(), base.clone(), rows).await.unwrap();
    let OpResult::Conflict { files, operation, .. } = result else {
        panic!("expected a conflict");
    };
    assert_eq!(files, ["f.txt"]);
    let operation = operation.unwrap();
    assert_eq!(operation.kind, OperationKind::Rebase);
    assert_eq!(operation.source.as_deref(), Some("main"));
    assert_eq!(operation.step, Some(1));
    let entry = top_undo(&tc, &id);
    assert_eq!(entry.action, "rebase");
    assert_eq!((entry.ref_before.as_deref(), entry.ref_after.as_deref()), (Some(old_tip.as_str()), None));
    assert_eq!(entry.payload["pending"], true);

    // First conflict (B), then the second one (A).
    repo.write_file("f.txt", "3\n");
    repo.git(&["add", "f.txt"]);
    let out = git_continue(&tc, &id, "rebase").await;
    assert!(!out.success(), "A collides afterwards as well");
    assert_eq!(status::read_operation(&tc, &id).await.unwrap().map(|o| o.kind), Some(OperationKind::Rebase));
    repo.write_file("f.txt", "2 und 3\n");
    repo.git(&["add", "f.txt"]);
    let out = git_continue(&tc, &id, "rebase").await;
    assert!(out.success(), "{}", out.stderr_text());

    assert_eq!(status::read_operation(&tc, &id).await.unwrap(), None);
    assert_eq!(repo.current_branch(), "main");
    assert_eq!(subjects(&repo, &format!("{base}..HEAD")), ["B: f auf 3", "A neu", "C und D"]);
    assert_eq!(message(&repo, "HEAD~1"), "A neu\n\nnach dem Konflikt");
    assert_eq!(message(&repo, "HEAD"), "C und D\n\n# bleibt stehen");
    assert_eq!(files_of(&repo, "HEAD"), ["c.txt", "d.txt"]);
    assert_eq!(repo.read_file("f.txt"), b"2 und 3\n");
    assert_eq!(repo.git(&["status", "--porcelain"]), "");

    settle_pending_undo(&tc, &id).await.unwrap();
    let entry = top_undo(&tc, &id);
    assert_eq!(entry.ref_after.as_deref(), Some(repo.head().as_str()));
    assert_eq!(entry.payload["pending"], false);
}

#[tokio::test]
async fn apply_conflict_inside_a_squash_still_ends_with_the_planned_message() {
    let (tc, repo, id) = setup().await;
    let base = repo.head();
    let a = repo.commit_file("f.txt", "1\n", "A: f anlegen");
    let b = repo.commit_file("g.txt", "g\n", "B: Datei g");
    let c = repo.commit_file("f.txt", "2\n", "C: f auf 2");
    let d = repo.commit_file("f.txt", "3\n", "D: f auf 3");

    // Fold D into A, C is dropped: D expects "2" and meets "1".
    let rows = vec![
        row(&a, RebaseAction::Pick, Some("A mit D\n\nzusammengefasst")),
        row(&d, RebaseAction::Squash, None),
        row(&b, RebaseAction::Reword, Some("B neu")),
        row(&c, RebaseAction::Drop, None),
    ];
    let result = rebase_apply(&tc, id.clone(), base.clone(), rows).await.unwrap();
    assert!(matches!(&result, OpResult::Conflict { files, .. } if files == &["f.txt".to_string()]), "{result:?}");

    repo.write_file("f.txt", "3\n");
    repo.git(&["add", "f.txt"]);
    let out = git_continue(&tc, &id, "rebase").await;
    assert!(out.success(), "{}", out.stderr_text());
    assert_eq!(subjects(&repo, &format!("{base}..HEAD")), ["A mit D", "B neu"]);
    assert_eq!(message(&repo, "HEAD~1"), "A mit D\n\nzusammengefasst");
    assert_eq!(files_of(&repo, "HEAD~1"), ["f.txt"]);
    assert_eq!(repo.read_file("f.txt"), b"3\n");
    assert_eq!(repo.git(&["status", "--porcelain"]), "");
}

// --- Squash ---------------------------------------------------------------------

fn commit_as(repo: &TestRepo, name: &str, rel: &str, content: &str, message: &str) -> String {
    repo.write_file(rel, content);
    repo.git(&["add", "-A"]);
    let name_config = format!("user.name={name}");
    repo.git(&["-c", &name_config, "-c", "user.email=andere@example.com", "commit", "-q", "-m", message]);
    repo.head()
}

#[tokio::test]
async fn squash_three_commits_in_the_middle_of_the_branch() {
    let (tc, repo, id) = setup().await;
    let base = repo.head();
    let k1 = commit_as(&repo, "Ada Lovelace", "k1.txt", "eins\n", "eins");
    let k2 = repo.commit_file("k2.txt", "zwei\n", "zwei");
    let k3 = repo.commit_file("Ordner mit Leerzeichen/Größe.txt", "drei\r\nohne Ende", "drei");
    repo.commit_file("k4.txt", "vier\n", "vier\n\nmit Körper");
    repo.commit_file("k1.txt", "eins\nfünf\n", "fünf");
    let old_tip = repo.head();
    let author_date = repo.git(&["log", "-1", "--format=%at", &k1]);

    // The order of the selection doesn't matter.
    let result = squash_commits(&tc, id.clone(), vec![k3.clone(), k1.clone(), k2.clone()], "Eins bis drei\n\nZusammen.".into()).await.unwrap();
    let squashed = repo.git(&["rev-parse", "HEAD~2"]);
    match &result {
        OpResult::Done { sha, summary, .. } => {
            assert_eq!(sha.as_deref(), Some(squashed.as_str()), "sha is the new, squashed commit");
            assert_eq!(summary, "Squashed 3 commits into one.");
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(subjects(&repo, &format!("{base}..HEAD")), ["Eins bis drei", "vier", "fünf"]);
    assert_eq!(message(&repo, &squashed), "Eins bis drei\n\nZusammen.");
    assert_eq!(message(&repo, "HEAD~1"), "vier\n\nmit Körper");
    assert_eq!(files_of(&repo, &squashed), ["Ordner mit Leerzeichen/Größe.txt", "k1.txt", "k2.txt"]);
    assert_eq!(repo.git(&["log", "-1", "--format=%an <%ae> %at", &squashed]), format!("Ada Lovelace <andere@example.com> {author_date}"));
    assert_eq!(repo.git(&["rev-parse", &format!("{squashed}~1")]), base);
    assert_eq!(repo.read_file("Ordner mit Leerzeichen/Größe.txt"), b"drei\r\nohne Ende");
    assert_eq!(repo.read_file("k1.txt"), b"eins\nf\xc3\xbcnf\n");
    assert_eq!(repo.git(&["diff", "--stat", &old_tip, "HEAD"]), "", "the content of the branch is the same");
    assert_eq!(repo.git(&["status", "--porcelain"]), "");

    let entry = top_undo(&tc, &id);
    assert_eq!((entry.action.as_str(), entry.label.as_str()), ("squash", "Undo squash of 3 commits"));
    assert_eq!(entry.ref_name.as_deref(), Some("refs/heads/main"));
    assert_eq!(entry.ref_before.as_deref(), Some(old_tip.as_str()));
    assert_eq!(entry.ref_after.as_deref(), Some(repo.head().as_str()));
    assert_eq!(entry.payload["summary"], "Eins bis drei");
    assert_eq!(entry.payload["count"], 3);
    assert_eq!(backup_ref(&repo, &entry).as_deref(), Some(old_tip.as_str()));
    assert_eq!(changed_events(&tc), 1);
}

#[tokio::test]
async fn squash_at_the_tip_and_including_the_root_commit() {
    let (tc, repo, id) = setup().await;
    let root = repo.head();
    let a = repo.commit_file("a.txt", "a\n", "A");
    let b = repo.commit_file("b.txt", "b\n", "B");

    // The last two commits.
    let result = squash_commits(&tc, id.clone(), vec![a.clone(), b.clone()], "A und B".into()).await.unwrap();
    assert!(matches!(&result, OpResult::Done { sha, .. } if sha.as_deref() == Some(repo.head().as_str())), "{result:?}");
    assert_eq!(subjects(&repo, "HEAD"), ["Erster Commit", "A und B"]);
    assert_eq!(repo.git(&["rev-parse", "HEAD~1"]), root);

    // With the very first commit: a single commit without parents remains.
    let tip = repo.head();
    let result = squash_commits(&tc, id.clone(), vec![root.clone(), tip], "Alles".into()).await.unwrap();
    assert!(matches!(result, OpResult::Done { .. }), "{result:?}");
    assert_eq!(subjects(&repo, "HEAD"), ["Alles"]);
    assert_eq!(repo.git(&["rev-list", "--count", "HEAD"]), "1");
    assert_eq!(files_of(&repo, "HEAD"), ["README.md", "a.txt", "b.txt"]);
    assert_eq!(repo.current_branch(), "main");
    assert_eq!(top_undo(&tc, &id).payload["base"], Value::Null);
}

#[tokio::test]
async fn squash_refuses_what_cannot_be_squashed() {
    let (tc, repo, id) = setup().await;
    let k1 = repo.commit_file("k1.txt", "1\n", "eins");
    let k2 = repo.commit_file("k2.txt", "2\n", "zwei");
    let k3 = repo.commit_file("k3.txt", "3\n", "drei");
    let tip = repo.head();
    let not_allowed = |result: CoreResult<OpResult>, part: &str| {
        let err = result.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed, "{err:?}");
        assert!(err.message.contains(part), "„{part}“ fehlt in: {}", err.message);
    };

    not_allowed(squash_commits(&tc, id.clone(), vec![k1.clone(), k3.clone()], "x".into()).await, "aren't consecutive");
    not_allowed(squash_commits(&tc, id.clone(), vec![k2.clone()], "x".into()).await, "at least two");
    not_allowed(squash_commits(&tc, id.clone(), vec![k2.clone(), k2.clone()], "x".into()).await, "at least two");
    not_allowed(squash_commits(&tc, id.clone(), vec![], "x".into()).await, "No commit");
    assert_eq!(code_of(squash_commits(&tc, id.clone(), vec![k1.clone(), k2.clone()], " \n".into()).await), ErrorCode::EmptyMessage);
    assert_eq!(code_of(squash_commits(&tc, id.clone(), vec![k1.clone(), "0123456789abcdef".into()], "x".into()).await), ErrorCode::NotFound);
    assert_eq!(code_of(squash_commits(&tc, id.clone(), vec![k1.clone(), "HEAD~1".into()], "x".into()).await), ErrorCode::NotFound);

    // A commit from another branch.
    repo.checkout_new("seite");
    let side = repo.commit_file("s.txt", "s\n", "Seite");
    repo.checkout("main");
    not_allowed(squash_commits(&tc, id.clone(), vec![k3.clone(), side.clone()], "x".into()).await, "Not all of the selected commits are on the checked-out branch");

    // Merge commit in the selection or above it.
    repo.commit_file("m.txt", "m\n", "Main");
    repo.git(&["merge", "--no-ff", "--no-edit", "seite"]);
    let merge = repo.head();
    let after = repo.commit_file("n.txt", "n\n", "Danach");
    not_allowed(squash_commits(&tc, id.clone(), vec![merge, after.clone()], "x".into()).await, "Merge commits can't");
    not_allowed(squash_commits(&tc, id.clone(), vec![k1.clone(), k2.clone()], "x".into()).await, "There's a merge commit above");

    // Detached HEAD and uncommitted changes.
    let extra = repo.commit_file("o.txt", "o\n", "Noch einer");
    repo.write_file("o.txt", "geändert\n");
    assert_eq!(code_of(squash_commits(&tc, id.clone(), vec![after.clone(), extra.clone()], "x".into()).await), ErrorCode::DirtyWorktree);
    repo.git(&["reset", "-q", "--hard"]);
    repo.git(&["checkout", "-q", "--detach"]);
    not_allowed(squash_commits(&tc, id.clone(), vec![after, extra], "x".into()).await, "detached HEAD");

    let _ = tip;
    assert_eq!(changed_events(&tc), 0);
    assert!(undo::next_undo(&tc, &id, "").unwrap().is_none());
}

// --- Cherry-Pick ------------------------------------------------------------------

#[tokio::test]
async fn cherry_pick_three_commits_with_a_conflict_at_the_second() {
    let (tc, repo, id) = setup().await;
    repo.commit_file("gemeinsam.txt", "basis\n", "Gemeinsame Datei");
    repo.checkout_new("quelle");
    let x1 = repo.commit_file("x1.txt", "1\n", "X1: neue Datei");
    let x2 = repo.commit_file("gemeinsam.txt", "quelle\n", "X2: ändert gemeinsam");
    let x3 = repo.commit_file("Ordner mit Leerzeichen/x3 ü.txt", "3\r\nohne Ende", "X3: noch eine Datei");
    repo.checkout("main");
    let old_head = repo.commit_file("gemeinsam.txt", "main\n", "Main ändert gemeinsam");

    let result = cherry_pick(&tc, id.clone(), vec![x1.clone(), x2.clone(), x3.clone()]).await.unwrap();
    let OpResult::Conflict { files, operation, .. } = result else {
        panic!("expected a conflict");
    };
    assert_eq!(files, ["gemeinsam.txt"]);
    let operation = operation.unwrap();
    assert_eq!(operation.kind, OperationKind::CherryPick);
    assert_eq!(operation.source.as_deref(), Some(&x2[..7]));
    assert_eq!(operation.target.as_deref(), Some("main"));
    assert_eq!((operation.step, operation.total_steps), (Some(2), Some(3)));
    assert_eq!(subjects(&repo, &format!("{old_head}..HEAD")), ["X1: neue Datei"], "the first commit is already there");
    assert_eq!(changed_events(&tc), 1);

    let entry = top_undo(&tc, &id);
    assert_eq!((entry.action.as_str(), entry.label.as_str()), ("cherry_pick", "Undo cherry-pick of 3 commits"));
    assert_eq!(entry.ref_name.as_deref(), Some("refs/heads/main"));
    assert_eq!((entry.ref_before.as_deref(), entry.ref_after.as_deref()), (Some(old_head.as_str()), None));
    assert_eq!(entry.payload["pending"], true);

    repo.write_file("gemeinsam.txt", "main und quelle\n");
    repo.git(&["add", "-A"]);
    let out = git_continue(&tc, &id, "cherry-pick").await;
    assert!(out.success(), "{}", out.stderr_text());
    assert_eq!(status::read_operation(&tc, &id).await.unwrap(), None);
    assert_eq!(subjects(&repo, &format!("{old_head}..HEAD")), ["X1: neue Datei", "X2: ändert gemeinsam", "X3: noch eine Datei"]);
    assert_eq!(repo.read_file("Ordner mit Leerzeichen/x3 ü.txt"), b"3\r\nohne Ende");

    settle_pending_undo(&tc, &id).await.unwrap();
    let entry = top_undo(&tc, &id);
    assert_eq!(entry.ref_after.as_deref(), Some(repo.head().as_str()));
    assert_eq!(entry.head_after.as_deref(), Some("refs/heads/main"));
    assert_eq!(entry.payload["pending"], false);
}

#[tokio::test]
async fn cherry_pick_applies_in_the_given_order_and_records_undo() {
    let (tc, repo, id) = setup().await;
    repo.checkout_new("quelle");
    let x1 = repo.commit_file("x.txt", "1\n", "X1");
    let x2 = repo.commit_file("x.txt", "1\n2\n", "X2");
    repo.checkout("main");
    let old_head = repo.commit_file("m.txt", "m\n", "Main");

    let result = cherry_pick(&tc, id.clone(), vec![x1.clone(), x2.clone()]).await.unwrap();
    match &result {
        OpResult::Done { sha, fast_forward, summary } => {
            assert_eq!(sha.as_deref(), Some(repo.head().as_str()));
            assert!(!fast_forward);
            assert_eq!(summary, "Cherry-picked 2 commits.");
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(subjects(&repo, &format!("{old_head}..HEAD")), ["X1", "X2"]);
    assert_eq!(repo.read_file("x.txt"), b"1\n2\n");
    let entry = top_undo(&tc, &id);
    assert_eq!(entry.action, "cherry_pick");
    assert_eq!((entry.ref_before.as_deref(), entry.ref_after.as_deref()), (Some(old_head.as_str()), Some(repo.head().as_str())));
    assert_eq!(entry.head_before, "refs/heads/main");
    assert_eq!(entry.head_after.as_deref(), Some("refs/heads/main"));
    assert_eq!(entry.payload["count"], 2);
    assert_eq!(entry.payload["shas"], json!([x1, x2]));

    // A single commit on a detached HEAD.
    repo.git(&["checkout", "-q", "--detach", &old_head]);
    let result = cherry_pick(&tc, id.clone(), vec![x1.clone()]).await.unwrap();
    assert!(matches!(&result, OpResult::Done { summary, .. } if summary == "Cherry-picked 1 commit."), "{result:?}");
    let entry = top_undo(&tc, &id);
    assert_eq!(entry.label, "Undo cherry-pick of ‘X1’");
    assert_eq!(entry.ref_name, None);
    assert_eq!(entry.head_before, old_head);
    assert_eq!(entry.head_after.as_deref(), Some(repo.head().as_str()));

    assert_eq!(code_of(cherry_pick(&tc, id.clone(), vec![]).await), ErrorCode::NotAllowed);
    assert_eq!(code_of(cherry_pick(&tc, id.clone(), vec!["main".into()]).await), ErrorCode::NotFound);
    assert_eq!(code_of(cherry_pick(&tc, id.clone(), vec!["--abort".into()]).await), ErrorCode::NotFound);
    assert_eq!(code_of(cherry_pick(&tc, id.clone(), vec!["0123456789abcdef0123456789abcdef01234567".into()]).await), ErrorCode::NotFound);
}

#[tokio::test]
async fn cherry_pick_skips_commits_whose_change_is_already_there() {
    let (tc, repo, id) = setup().await;
    repo.checkout_new("quelle");
    let dup = repo.commit_file("p.txt", "p\n", "P auf quelle");
    let fresh = repo.commit_file("q.txt", "q\n", "Q auf quelle");
    let dup2 = repo.commit_file("r.txt", "r\n", "R auf quelle");
    repo.checkout("main");
    repo.commit_file("p.txt", "p\n", "P auf main");
    let old_head = repo.commit_file("r.txt", "r\n", "R auf main");

    // Only already included changes: nothing happens, nothing is left hanging.
    assert_eq!(cherry_pick(&tc, id.clone(), vec![dup.clone()]).await.unwrap(), OpResult::UpToDate);
    assert_eq!(repo.head(), old_head);
    assert_eq!(status::read_operation(&tc, &id).await.unwrap(), None);
    assert!(undo::next_undo(&tc, &id, "").unwrap().is_none());

    // Mixed: the new commit arrives, the other two are skipped.
    let result = cherry_pick(&tc, id.clone(), vec![dup.clone(), fresh.clone(), dup2.clone()]).await.unwrap();
    match &result {
        OpResult::Done { summary, .. } => {
            assert_eq!(summary, "Cherry-picked 1 commit. Skipped 2 because the change is already included.")
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(subjects(&repo, &format!("{old_head}..HEAD")), ["Q auf quelle"]);
    assert_eq!(status::read_operation(&tc, &id).await.unwrap(), None);
    assert_eq!(repo.git(&["status", "--porcelain"]), "");
    assert_eq!(top_undo(&tc, &id).payload["count"], 1);

    // Without `--empty=drop` (Git before 2.45) Git stops at every empty pick; then the core pushes on.
    repo.git(&["reset", "-q", "--hard", &old_head]);
    let touched = AtomicBool::new(false);
    let picks = [dup.clone(), fresh.clone(), dup2.clone()];
    let result = pick_commits(&tc, &id, &picks, false, &touched).await.unwrap();
    assert!(matches!(&result, OpResult::Done { summary, .. } if summary.starts_with("Cherry-picked 1 commit. Skipped 2")), "{result:?}");
    assert_eq!(subjects(&repo, &format!("{old_head}..HEAD")), ["Q auf quelle"]);
    assert_eq!(status::read_operation(&tc, &id).await.unwrap(), None);
    repo.git(&["reset", "-q", "--hard", &old_head]);
    assert_eq!(pick_commits(&tc, &id, &picks[..1], false, &touched).await.unwrap(), OpResult::UpToDate);
    assert_eq!(status::read_operation(&tc, &id).await.unwrap(), None);
    assert_eq!(repo.git(&["status", "--porcelain"]), "");

    // A commit that is empty from the start is intended and is kept.
    repo.checkout("quelle");
    let empty = repo.empty_commit("Absichtlich leer");
    repo.checkout("main");
    let result = cherry_pick(&tc, id.clone(), vec![empty]).await.unwrap();
    assert!(matches!(result, OpResult::Done { .. }), "{result:?}");
    assert_eq!(message(&repo, "HEAD"), "Absichtlich leer");
}

#[tokio::test]
async fn cherry_pick_of_a_merge_commit_uses_the_first_parent() {
    let (tc, repo, id) = setup().await;
    repo.checkout_new("ziel");
    repo.checkout("main");
    repo.checkout_new("thema");
    repo.commit_file("t1.txt", "1\n", "Thema 1");
    repo.commit_file("t2.txt", "2\n", "Thema 2");
    repo.checkout("main");
    repo.commit_file("m.txt", "m\n", "Main");
    repo.git(&["merge", "--no-ff", "-m", "Merge von thema", "thema"]);
    let merge = repo.head();
    let after = repo.commit_file("n.txt", "n\n", "Nach dem Merge");
    repo.checkout("ziel");

    // Merge and ordinary commit in one go.
    let result = cherry_pick(&tc, id.clone(), vec![merge, after]).await.unwrap();
    assert!(matches!(&result, OpResult::Done { summary, .. } if summary == "Cherry-picked 2 commits."), "{result:?}");
    assert_eq!(subjects(&repo, "HEAD~2..HEAD"), ["Merge von thema", "Nach dem Merge"]);
    assert_eq!(files_of(&repo, "HEAD~1"), ["t1.txt", "t2.txt"], "the change of the merge relative to its first parent");
    assert_eq!(repo.git(&["rev-list", "--count", "--min-parents=2", "HEAD"]), "0", "no merge commit is created");
    assert!(!repo.path().join("m.txt").exists());
}

// --- Helper program and pure functions ------------------------------------------------

#[tokio::test]
async fn helper_with_spaces_in_its_path_works_through_git_and_a_missing_one_is_reported() {
    let (tc, repo, id) = setup().await;
    let (base, s) = five_commits(&repo);
    let found = find_editor_helper(&tc).unwrap();

    // Name with spaces: Git has to start the editor through its own shell.
    let dir = repo.temp_dir().join("Ordner mit Leerzeichen & 'Zeichen'");
    std::fs::create_dir_all(&dir).unwrap();
    let odd = dir.join(format!("forkyard editor{}", std::env::consts::EXE_SUFFIX));
    std::fs::copy(&found, &odd).unwrap();
    set_editor_helper(&tc, Some(odd.clone()));
    assert!(editor_call(&odd).path.is_none());
    let mut rows: Vec<RebasePlanRow> = s.iter().map(|sha| row(sha, RebaseAction::Pick, None)).collect();
    rows[4].action = RebaseAction::Drop;
    let result = rebase_apply(&tc, id.clone(), base.clone(), rows).await.unwrap();
    assert!(matches!(result, OpResult::Done { .. }), "{result:?}");
    assert_eq!(subjects_shas(&repo, &base), s[..4]);

    // Plain name in a folder that is not on the PATH: Git only finds it through the extended PATH.
    let unique = format!("gc-editor-{}", util::new_id().replace('-', ""));
    let plain = dir.join(format!("{unique}{}", std::env::consts::EXE_SUFFIX));
    std::fs::copy(&found, &plain).unwrap();
    set_editor_helper(&tc, Some(plain.clone()));
    let call = editor_call(&plain);
    assert_eq!(call.command, unique);
    assert!(call.path.is_some());
    let mut rows: Vec<RebasePlanRow> = s[..4].iter().map(|sha| row(sha, RebaseAction::Pick, None)).collect();
    rows.swap(2, 3);
    let result = rebase_apply(&tc, id.clone(), base.clone(), rows).await.unwrap();
    assert!(matches!(result, OpResult::Done { .. }), "{result:?}");
    assert_eq!(subjects(&repo, &format!("{base}..HEAD")), ["A: Datei a", "B: Datei b", "D: Datei d", "C: Datei c"]);
    let s = subjects_shas(&repo, &base);

    // Helper program missing or not startable: the rebase fails cleanly, nothing is left behind.
    let tip = repo.head();
    let mut rows: Vec<RebasePlanRow> = s[..4].iter().map(|sha| row(sha, RebaseAction::Pick, None)).collect();
    rows[3].action = RebaseAction::Drop;
    set_editor_helper(&tc, Some(repo.temp_dir().join("gibt-es-nicht").join(format!("{EDITOR_HELPER_NAME}{}", std::env::consts::EXE_SUFFIX))));
    let err = rebase_apply(&tc, id.clone(), base.clone(), rows.clone()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Unsupported, "{err:?}");
    let broken = repo.temp_dir().join(format!("kaputter-editor{}", std::env::consts::EXE_SUFFIX));
    std::fs::write(&broken, "kein Programm").unwrap();
    set_editor_helper(&tc, Some(broken));
    let err = rebase_apply(&tc, id.clone(), base.clone(), rows).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Io, "{err:?}");
    assert!(err.git_output.is_some());
    assert_eq!(repo.head(), tip);
    assert_eq!(repo.current_branch(), "main");
    assert_eq!(status::read_operation(&tc, &id).await.unwrap(), None);
    assert_eq!(repo.git(&["for-each-ref", "--format=%(refname)", "refs/forkyard"]).lines().count(), 2, "only the backups of the successful rebases");
    assert_eq!(std::fs::read_dir(tc.data_dir().join("tmp")).unwrap().count(), 0);

    set_editor_helper(&tc, None);
    assert_eq!(find_editor_helper(&tc).unwrap(), found);
}

#[test]
fn editor_call_prefers_the_bare_name_on_the_path() {
    let program = Path::new(if cfg!(windows) { r"C:\Program Files (x86)\Mein Client\forkyard-editor.exe" } else { "/opt/mein client/forkyard-editor" });
    let call = editor_call(program);
    assert_eq!(call.command, "forkyard-editor");
    let path = call.path.expect("PATH is extended");
    let first = std::env::split_paths(&path).next().unwrap();
    assert_eq!(first, program.parent().unwrap());

    let odd = Path::new(if cfg!(windows) { r"C:\Tools\mein editor.exe" } else { "/opt/tools/mein editor" });
    let call = editor_call(odd);
    assert!(call.path.is_none());
    assert_eq!(call.command, if cfg!(windows) { "'C:/Tools/mein editor.exe'" } else { "'/opt/tools/mein editor'" });
    assert_eq!(sh_quote("it's"), "'it'\\''s'");
    assert!(is_plain_word("forkyard_1.2+x"));
    assert!(!is_plain_word("a b") && !is_plain_word("") && !is_plain_word("a/b") && !is_plain_word("a~1"));
}

#[test]
fn copy_todo_only_writes_the_file_git_asked_for() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("vorbereitet");
    std::fs::write(&source, "pick abc\ndrop def\n").unwrap();
    let target = dir.path().join(GIT_TODO_FILE);
    std::fs::write(&target, "pick original\n").unwrap();
    assert_eq!(copy_todo(&source, Some(target.clone().into_os_string())), 0);
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "pick abc\ndrop def\n");

    let other = dir.path().join("COMMIT_EDITMSG");
    std::fs::write(&other, "bleibt\n").unwrap();
    assert_eq!(copy_todo(&source, Some(other.clone().into_os_string())), 1);
    assert_eq!(std::fs::read_to_string(&other).unwrap(), "bleibt\n");
    assert_eq!(copy_todo(&source, None), 2);
    assert_eq!(copy_todo(&dir.path().join("fehlt"), Some(target.into_os_string())), 1);
}

fn range_commit(sha: &str, message: &str) -> RangeCommit {
    RangeCommit {
        sha: sha.to_string(),
        parents: vec!["p".to_string()],
        author: Person { name: "A".into(), email: "a@example.com".into() },
        authored_at: String::new(),
        summary: message.lines().next().unwrap_or_default().to_string(),
        description: String::new(),
        message: message.to_string(),
    }
}

fn step(sha: &str, action: RebaseAction, message: Option<&str>) -> Step {
    Step { sha: sha.to_string(), action, message: message.map(str::to_string) }
}

#[test]
fn plan_entries_builds_groups_messages_and_stats() {
    let commits = [range_commit("a", "A\n"), range_commit("b", "B\n\nKörper\n"), range_commit("c", "C\n"), range_commit("d", "D\n")];
    let group = |target: &str, fixups: &[&str], message: Option<&str>| TodoEntry::Group {
        target: target.to_string(),
        fixups: fixups.iter().map(|f| f.to_string()).collect(),
        message: message.map(str::to_string),
    };

    // Unchanged.
    let steps: Vec<Step> = ["a", "b", "c", "d"].iter().map(|s| step(s, RebaseAction::Pick, None)).collect();
    let (entries, stats) = plan_entries(&steps, &commits).unwrap();
    assert_eq!(entries, [group("a", &[], None), group("b", &[], None), group("c", &[], None), group("d", &[], None)]);
    assert!(stats.is_noop());

    // Reordered, combined message, drop in the middle of the group.
    let steps = [
        step("b", RebaseAction::Pick, None),
        step("d", RebaseAction::Drop, None),
        step("a", RebaseAction::Squash, None),
        step("c", RebaseAction::Reword, Some("C neu")),
    ];
    let (entries, stats) = plan_entries(&steps, &commits).unwrap();
    assert_eq!(entries, [group("b", &["a"], Some("B\n\nKörper\n\nA\n")), TodoEntry::Drop("d".into()), group("c", &[], Some("C neu\n"))]);
    assert_eq!(stats, PlanStats { squashed: 1, squash_targets: 1, reworded: vec!["C".into()], dropped: vec!["D".into()], reordered: true });
    assert_eq!(stats.undo_label("main"), (UndoAction::Rebase, "Undo interactive rebase of main".to_string()));
    assert_eq!(
        stats.summary(),
        "Interactive rebase complete: 2 commits squashed, 1 commit reworded, 1 commit dropped, order changed."
    );

    // Precedence of the message: target before squash row.
    let steps = [
        step("a", RebaseAction::Pick, Some("vom Ziel")),
        step("b", RebaseAction::Squash, Some("von der Squash-Zeile")),
        step("c", RebaseAction::Pick, Some("wird bei pick ohne squash ignoriert")),
        step("d", RebaseAction::Pick, None),
    ];
    let (entries, stats) = plan_entries(&steps, &commits).unwrap();
    assert_eq!(entries[0], group("a", &["b"], Some("vom Ziel\n")));
    assert_eq!(entries[1], group("c", &[], None));
    assert!(!stats.reordered);
    assert_eq!(stats.undo_label("main").0, UndoAction::Squash);
}

#[test]
fn messages_are_normalized() {
    assert_eq!(normalize_message("  \n\nErste\r\n\r\nZweite  \n\n\n").as_deref(), Some("Erste\n\nZweite\n"));
    assert_eq!(normalize_message("  eingerückt").as_deref(), Some("  eingerückt\n"));
    assert_eq!(normalize_message(" \r\n\t\n"), None);
    assert_eq!(quoted("kurz"), "‘kurz’");
    assert_eq!(quoted(&"ä".repeat(80)), format!("‘{}…’", "ä".repeat(60)));
    assert_eq!(commits_label(1), "1 commit");
    assert_eq!(commits_label(0), "0 commits");
    assert_eq!(display_rev("origin/main", "abc1234def"), "origin/main");
    assert_eq!(display_rev("refs/heads/main", "abc1234def"), "main");
    assert_eq!(display_rev("ABC1234", "abc1234def"), "abc1234");
}
