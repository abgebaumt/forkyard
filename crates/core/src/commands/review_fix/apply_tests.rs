//! Taking a fix over as a `fixup!` commit (8.2) against real repositories and the GitHub-shaped stand-in:
//! one commit per takeover through the normal commit path, one undo for a row of takeovers, every refused
//! takeover leaves branch, index and files as they were, no undo once the fixups are on a remote.

use super::test_host::{pr_repo, PrRepo, BRANCH, FILE, FIX, FIXED_FILE, P1_FILE, P1_SUBJECT, P2_SUBJECT};
use super::*;
use crate::commands::rebase::{rebase_apply_with, rebase_plan_with};
use crate::commands::undo::{redo, undo, undo_peek};
use crate::error::ErrorCode;
use crate::model::{RebaseAction, RebasePlan, ReviewFixInput};
use crate::testkit::{TestRemote, TestRepo};

fn input(path: &str, start: u32, end: u32, text: &str, head: &str) -> ReviewFixInput {
    ReviewFixInput { path: path.into(), start_line: start, end_line: end, new_text: text.into(), head_sha: head.into() }
}

fn subjects_since(s: &PrRepo, rev: &str) -> String {
    s.repo.git(&["log", "--format=%s", &format!("{rev}..HEAD")])
}

#[tokio::test]
async fn takeovers_become_fixup_commits_with_one_undo_for_the_row() {
    let s = pr_repo(Vec::new()).await;
    let first = review_fix_apply(&s.tc, s.id.clone(), 7, input(FILE, 3, 4, FIX, &s.p2), s.p1.clone()).await.unwrap();
    assert_eq!(first.summary, format!("fixup! {P1_SUBJECT}"));
    assert_eq!(s.repo.git(&["log", "-1", "--format=%B"]), format!("fixup! {P1_SUBJECT}"));
    assert_eq!((first.fixups, first.base.as_str(), first.undo_label.as_str()), (1, s.main.as_str(), "Undo 1 fixup commit for #7"));
    assert_eq!(first.commit, s.repo.head());
    assert_eq!(s.repo.read_file(FILE), FIXED_FILE.as_bytes());
    assert_eq!(s.repo.git(&["show", "--format=", "--name-only", "HEAD"]), FILE, "the commit holds only the fix");
    assert_eq!(s.repo.git(&["status", "--porcelain"]), "");

    let second = review_fix_apply(&s.tc, s.id.clone(), 7, input("docs/hinweis.md", 3, 3, "Passwörter brauchen 4 Zeichen.", &s.p2), s.p2.clone()).await.unwrap();
    assert_eq!(subjects_since(&s, &s.p2), format!("fixup! {P2_SUBJECT}\nfixup! {P1_SUBJECT}"));
    assert_eq!((second.fixups, second.undo_label.as_str()), (2, "Undo 2 fixup commits for #7"));
    let peek = undo_peek(&s.tc, s.id.clone()).await.unwrap();
    assert_eq!(peek.undo.map(|step| (step.label, step.action)), Some(("Undo 2 fixup commits for #7".to_string(), "review_fixups".to_string())));

    undo(&s.tc, s.id.clone()).await.unwrap();
    assert_eq!(s.repo.head(), s.p2, "both fixups are undone at once");
    assert_eq!(s.repo.read_file(FILE), P1_FILE.as_bytes());
    assert_eq!(s.repo.git(&["status", "--porcelain"]), "");
    redo(&s.tc, s.id.clone()).await.unwrap();
    assert_eq!(s.repo.head(), second.commit);
    assert_eq!(s.repo.read_file(FILE), FIXED_FILE.as_bytes());
}

#[tokio::test]
async fn preconditions_leave_branch_index_and_files_untouched() {
    let s = pr_repo(Vec::new()).await;
    let apply = |fix: ReviewFixInput, target: String| review_fix_apply(&s.tc, s.id.clone(), 7, fix, target);
    let fix = || input(FILE, 3, 4, FIX, &s.p2);

    // Not on the pull request's branch.
    s.repo.checkout("main");
    let error = apply(fix(), s.p1.clone()).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::NotAllowed);
    assert!(error.message.contains(BRANCH), "{}", error.message);
    assert_eq!(s.repo.head(), s.main);
    s.repo.checkout(BRANCH);
    // Something else is staged.
    s.repo.write_file("README.md", "# Anders\n");
    s.repo.git(&["add", "README.md"]);
    assert_eq!(apply(fix(), s.p1.clone()).await.unwrap_err().code, ErrorCode::DirtyWorktree);
    assert_eq!(s.repo.git(&["diff", "--cached", "--name-only"]), "README.md", "the own staging stays");
    s.repo.git(&["reset", "-q", "--", "README.md"]);
    s.repo.git(&["checkout", "--", "README.md"]);
    // The file itself has uncommitted changes.
    s.repo.write_file(FILE, "lokal\n");
    assert_eq!(apply(fix(), s.p1.clone()).await.unwrap_err().code, ErrorCode::DirtyWorktree);
    assert_eq!(s.repo.read_file(FILE), b"lokal\n");
    s.repo.git(&["checkout", "--", FILE]);
    // The lines changed since the suggestion (an own commit on top).
    let own = s.repo.commit_file(FILE, P1_FILE.replace("// zu kurz", "// anders"), "Eigene Änderung");
    let error = apply(fix(), s.p1.clone()).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Conflict);
    assert!(error.message.contains(FILE), "{}", error.message);
    assert_eq!(s.repo.head(), own);
    assert_eq!(s.repo.git(&["status", "--porcelain"]), "");
    s.repo.git(&["reset", "-q", "--hard", &s.p2]);
    // The branch is behind the pull request.
    s.repo.git(&["reset", "-q", "--hard", &s.p1]);
    assert_eq!(apply(fix(), s.p1.clone()).await.unwrap_err().code, ErrorCode::StaleState);
    s.repo.git(&["reset", "-q", "--hard", &s.p2]);
    // A target outside the pull request, a file it does not change, lines outside the file, paths
    // outside the repository and a head that is not a commit name.
    assert_eq!(apply(fix(), s.main.clone()).await.unwrap_err().code, ErrorCode::NotAllowed);
    assert_eq!(apply(input("README.md", 1, 1, "# Neu", &s.p2), s.p1.clone()).await.unwrap_err().code, ErrorCode::NotAllowed);
    assert_eq!(apply(input(FILE, 7, 9, "x", &s.p2), s.p1.clone()).await.unwrap_err().code, ErrorCode::NotAllowed);
    assert_eq!(apply(input("../außerhalb.rs", 1, 1, "x", &s.p2), s.p1.clone()).await.unwrap_err().code, ErrorCode::NotAllowed);
    assert_eq!(apply(input(FILE, 3, 4, FIX, "--oneline"), s.p1.clone()).await.unwrap_err().code, ErrorCode::NotFound);

    assert_eq!(s.repo.head(), s.p2);
    assert_eq!(s.repo.git(&["status", "--porcelain"]), "");
    assert_eq!(subjects_since(&s, &s.main), format!("{P2_SUBJECT}\n{P1_SUBJECT}"), "no fixup commit was made");
    assert!(undo_peek(&s.tc, s.id.clone()).await.unwrap().undo.is_none(), "nothing to undo");
}

/// `pre-commit` that always fails (Git runs it through its `sh`, also on Windows).
fn failing_hook(repo: &TestRepo) {
    let hook = repo.path().join(".git").join("hooks").join("pre-commit");
    std::fs::create_dir_all(hook.parent().unwrap()).unwrap();
    std::fs::write(&hook, "#!/bin/sh\necho 'Bitte erst die Tests laufen lassen' >&2\nexit 1\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
}

#[tokio::test]
async fn a_failing_hook_restores_file_and_index() {
    let s = pr_repo(Vec::new()).await;
    failing_hook(&s.repo);
    let error = review_fix_apply(&s.tc, s.id.clone(), 7, input(FILE, 3, 4, FIX, &s.p2), s.p1.clone()).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::HookFailed);
    assert!(error.message.contains("pre-commit"), "{}", error.message);
    assert_eq!(s.repo.head(), s.p2);
    assert_eq!(s.repo.git(&["status", "--porcelain"]), "", "index and file as before");
    assert_eq!(s.repo.read_file(FILE), P1_FILE.as_bytes());
    assert!(undo_peek(&s.tc, s.id.clone()).await.unwrap().undo.is_none());
}

#[tokio::test]
async fn undo_refuses_once_the_fixups_are_on_a_remote() {
    let s = pr_repo(Vec::new()).await;
    let remote = TestRemote::new();
    s.repo.git(&["remote", "add", "sicherung", &remote.url()]);
    let applied = review_fix_apply(&s.tc, s.id.clone(), 7, input(FILE, 3, 4, FIX, &s.p2), s.p1.clone()).await.unwrap();
    s.repo.git(&["push", "-q", "sicherung", BRANCH]);
    let error = undo(&s.tc, s.id.clone()).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::NotAllowed);
    assert!(error.message.contains("remote"), "{}", error.message);
    assert_eq!(s.repo.head(), applied.commit, "nothing moved");
    assert_eq!(s.repo.read_file(FILE), FIXED_FILE.as_bytes());
    let step = undo_peek(&s.tc, s.id.clone()).await.unwrap().undo.map(|step| step.label);
    assert_eq!(step.as_deref(), Some("Undo 1 fixup commit for #7"), "the entry stays");
}

#[tokio::test]
async fn autosquash_after_a_takeover_folds_the_fixup_into_its_target() {
    let s = pr_repo(Vec::new()).await;
    let applied = review_fix_apply(&s.tc, s.id.clone(), 7, input(FILE, 3, 4, FIX, &s.p2), s.p1.clone()).await.unwrap();
    let RebasePlan::Ok { rows, .. } = rebase_plan_with(&s.tc, s.id.clone(), applied.base.clone(), Some(true)).await.unwrap() else { panic!("expected a plan") };
    let plan: Vec<(&str, RebaseAction)> = rows.iter().map(|r| (r.sha.as_str(), r.action)).collect();
    assert_eq!(plan, vec![(s.p1.as_str(), RebaseAction::Pick), (applied.commit.as_str(), RebaseAction::Fixup), (s.p2.as_str(), RebaseAction::Pick)]);
    rebase_apply_with(&s.tc, s.id.clone(), applied.base.clone(), rows, None).await.unwrap();
    assert_eq!(subjects_since(&s, &s.main), format!("{P2_SUBJECT}\n{P1_SUBJECT}"), "the fixup went into its commit");
    assert_eq!(s.repo.git(&["show", &format!("HEAD~1:{FILE}")]), FIXED_FILE.trim_end(), "the first commit now holds the fix");
    assert_eq!(s.repo.git(&["status", "--porcelain"]), "");
}
