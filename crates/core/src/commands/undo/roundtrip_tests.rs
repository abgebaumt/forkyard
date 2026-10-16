//! Every undoable action against its real command: the command runs the way the UI calls
//! it, then undo and redo – back and forth twice. Here the entries as the commands really
//! write them meet the execution in `commands::undo`.

use super::*;
use crate::commands::branches::{branch_checkout, branch_create, branch_delete};
use crate::commands::commit::{commit_create, commit_reword};
use crate::commands::diff::diff_file;
use crate::commands::merge::{conflict_resolve, merge_start, operation_abort, operation_continue, reset_branch, revert_commit};
use crate::commands::rebase::{cherry_pick, rebase_apply, rebase_plan, rebase_start, squash_commits};
use crate::commands::remotes::remote_remove;
use crate::commands::stage::{discard_patch, discard_paths, file_restore};
use crate::commands::stash::{stash_create, stash_drop, stash_list, stash_pop};
use crate::commands::sync::pull;
use crate::model::{
    ConflictSide, DiffSource, FileDiff, HunkSelection, MergeMode, OpResult, PatchSelection, PullMode, RebaseAction, RebasePlan, ResetMode,
};
use crate::testkit::{TestCore, TestRemote, TestRepo};

struct Fx {
    tc: TestCore,
    repo: TestRepo,
    id: String,
}

impl Fx {
    async fn new() -> Fx {
        Self::with(TestRepo::with_commit()).await
    }

    async fn with(repo: TestRepo) -> Fx {
        let tc = TestCore::new().await;
        let id = tc.open(&repo).await.repo.id;
        Fx { tc, repo, id }
    }

    fn id(&self) -> String {
        self.id.clone()
    }

    fn sha(&self, rev: &str) -> String {
        self.repo.git(&["rev-parse", rev])
    }

    fn has_ref(&self, name: &str) -> bool {
        self.repo.git_output(&["rev-parse", "--verify", "-q", name]).status.success()
    }

    /// HEAD as in the entries: ref name or SHA.
    fn token(&self) -> String {
        let out = self.repo.git_output(&["symbolic-ref", "-q", "HEAD"]);
        if out.status.success() {
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        } else {
            self.repo.head()
        }
    }

    fn lines(&self, args: &[&str]) -> Vec<String> {
        let mut full = vec!["-c", "core.quotepath=false"];
        full.extend_from_slice(args);
        self.repo.git(&full).lines().map(str::to_string).filter(|l| !l.is_empty()).collect()
    }

    /// `git status --porcelain`, empty = clean.
    fn porcelain(&self) -> Vec<String> {
        let out = self.repo.git_output(&["status", "--porcelain", "-z", "--untracked-files=all"]);
        assert!(out.status.success());
        String::from_utf8_lossy(&out.stdout).split('\0').filter(|l| !l.is_empty()).map(str::to_string).collect()
    }

    fn subject(&self, rev: &str) -> String {
        self.repo.git(&["log", "-1", "--format=%s", rev])
    }

    fn subjects(&self, range: &str) -> Vec<String> {
        self.lines(&["log", "--reverse", "--format=%s", range])
    }

    fn text(&self, rel: &str) -> String {
        String::from_utf8_lossy(&self.repo.read_file(rel)).into_owned()
    }

    fn exists(&self, rel: &str) -> bool {
        self.repo.path().join(rel).exists()
    }

    fn backup_refs(&self) -> Vec<String> {
        self.lines(&["for-each-ref", "--format=%(refname)", "refs/forkyard/undo"])
    }

    /// Entries of the undo stack, topmost first.
    fn entries(&self) -> Vec<UndoEntry> {
        self.tc.db.with(|c| db::undo::list_done(c, &self.id, "")).unwrap()
    }

    fn top(&self) -> UndoEntry {
        self.entries().into_iter().next().expect("undo entry missing")
    }

    async fn undo(&self) -> CoreResult<UndoState> {
        undo(&self.tc, self.id()).await
    }

    async fn redo(&self) -> CoreResult<UndoState> {
        redo(&self.tc, self.id()).await
    }

    async fn peek(&self) -> UndoState {
        undo_peek(&self.tc, self.id()).await.unwrap()
    }

    /// The command has run: the button offers exactly `action`; then back and forth twice.
    async fn round_trip(&self, action: &str, before: impl Fn(&Fx), after: impl Fn(&Fx)) {
        after(self);
        let offered = self.peek().await.undo.unwrap_or_else(|| panic!("no undo step offered; entries: {:#?}", self.entries()));
        assert_eq!(offered.action, action, "{offered:?}");
        assert!(offered.label.starts_with("Undo "), "{}", offered.label);
        for round in 0..2 {
            let state = self.undo().await.unwrap_or_else(|e| panic!("undo in round {round}: {e:?}"));
            let step = state.redo.unwrap_or_else(|| panic!("redo step missing after undo (round {round})"));
            assert_eq!(step.action, action);
            before(self);
            let state = self.redo().await.unwrap_or_else(|e| panic!("redo in round {round}: {e:?}"));
            assert_eq!(state.undo.map(|s| s.action).as_deref(), Some(action), "after redo the undo step is there again");
            assert!(state.redo.is_none());
            after(self);
        }
    }

    async fn commit(&self, summary: &str) -> String {
        commit_create(&self.tc, self.id(), util::new_id(), summary.into(), String::new(), false, false, false, false, None).await.unwrap().sha
    }

    /// `main` and `feature` both change the README: merging, rebasing and picking yields a conflict.
    fn diverge_with_conflict(&self) -> (String, String) {
        self.repo.checkout_new("feature");
        let feature = self.repo.commit_file("README.md", "# Feature\n", "Feature ändert README");
        self.repo.checkout("main");
        let main = self.repo.commit_file("README.md", "# Main\n", "Main ändert README");
        (main, feature)
    }

    async fn take_theirs(&self, path: &str) {
        conflict_resolve(&self.tc, self.id(), path.into(), None, Some(ConflictSide::Theirs)).await.unwrap();
    }
}

fn done_sha(result: OpResult) -> String {
    match result {
        OpResult::Done { sha: Some(sha), .. } => sha,
        other => panic!("expected done with a SHA: {other:?}"),
    }
}

fn assert_conflict(result: &OpResult) {
    assert!(matches!(result, OpResult::Conflict { .. }), "{result:?}");
}

// --- Commit, Amend, Reword ---------------------------------------------------

#[tokio::test]
async fn commit_undo_and_redo() {
    let fx = Fx::new().await;
    let a = fx.repo.head();
    fx.repo.write_file("neu ä.txt", "x\r\n");
    fx.repo.git(&["add", "-A"]);
    let b = fx.commit("Zweiter").await;
    assert_eq!(fx.top().payload["merge"], false);
    fx.round_trip(
        "commit",
        |fx| {
            assert_eq!(fx.repo.head(), a);
            assert_eq!(fx.porcelain(), ["A  neu ä.txt"]);
        },
        |fx| {
            assert_eq!(fx.repo.head(), b);
            assert!(fx.porcelain().is_empty());
        },
    )
    .await;
}

#[tokio::test]
async fn first_commit_and_commit_on_detached_head() {
    let fx = Fx::with(TestRepo::new()).await;
    fx.repo.write_file("a.txt", "a\n");
    fx.repo.git(&["add", "-A"]);
    let first = fx.commit("Erster").await;
    fx.round_trip(
        "commit",
        |fx| {
            assert!(!fx.has_ref("HEAD"), "without a commit again");
            assert_eq!(fx.token(), "refs/heads/main");
            assert_eq!(fx.porcelain(), ["A  a.txt"]);
        },
        |fx| assert_eq!(fx.repo.head(), first),
    )
    .await;

    fx.repo.git(&["checkout", "-q", "--detach"]);
    fx.repo.write_file("b.txt", "b\n");
    fx.repo.git(&["add", "-A"]);
    let second = fx.commit("Ohne Branch").await;
    fx.round_trip(
        "commit",
        |fx| {
            assert_eq!(fx.token(), first, "HEAD stays detached");
            assert_eq!(fx.porcelain(), ["A  b.txt"]);
        },
        |fx| assert_eq!(fx.token(), second),
    )
    .await;
    assert_eq!(fx.sha("refs/heads/main"), first, "the branch was never moved");
}

#[tokio::test]
async fn amend_and_reword_undo_and_redo() {
    let fx = Fx::new().await;
    let old = fx.repo.commit_file("a.txt", "eins\n", "Alt");
    fx.repo.write_file("a.txt", "zwei\n");
    fx.repo.git(&["add", "-A"]);
    let amended = commit_create(&fx.tc, fx.id(), util::new_id(), "Neu".into(), String::new(), true, false, false, false, None).await.unwrap().sha;
    fx.round_trip(
        "amend",
        |fx| {
            assert_eq!(fx.repo.head(), old);
            assert_eq!(fx.subject("HEAD"), "Alt");
            assert_eq!(fx.porcelain(), ["M  a.txt"], "the added change stays staged");
        },
        |fx| {
            assert_eq!(fx.repo.head(), amended);
            assert_eq!(fx.subject("HEAD"), "Neu");
            assert!(fx.porcelain().is_empty());
        },
    )
    .await;

    let reworded = commit_reword(&fx.tc, fx.id(), "Anders gesagt".into(), "Mit Beschreibung".into(), None).await.unwrap().sha;
    fx.round_trip(
        "reword",
        |fx| {
            assert_eq!(fx.repo.head(), amended);
            assert_eq!(fx.subject("HEAD"), "Neu");
            assert!(fx.porcelain().is_empty());
        },
        |fx| {
            assert_eq!(fx.repo.head(), reworded);
            assert_eq!(fx.subject("HEAD"), "Anders gesagt");
        },
    )
    .await;
}

// --- Merge ---------------------------------------------------------------------

#[tokio::test]
async fn merge_fast_forward_real_merge_and_squash() {
    let fx = Fx::new().await;
    let a = fx.repo.head();
    fx.repo.checkout_new("feature");
    let f = fx.repo.commit_file("f.txt", "f\n", "Feature");
    fx.repo.checkout("main");

    // Fast-forward
    assert_eq!(done_sha(merge_start(&fx.tc, fx.id(), "feature".into(), MergeMode::Default).await.unwrap()), f);
    fx.round_trip(
        "merge",
        |fx| {
            assert_eq!(fx.repo.head(), a);
            assert!(!fx.exists("f.txt"));
        },
        |fx| assert_eq!(fx.repo.head(), f),
    )
    .await;
    fx.undo().await.unwrap();

    // Real merge commit
    let m = done_sha(merge_start(&fx.tc, fx.id(), "feature".into(), MergeMode::NoFf).await.unwrap());
    fx.round_trip(
        "merge",
        |fx| {
            assert_eq!(fx.repo.head(), a);
            assert!(!fx.exists("f.txt"));
            assert!(fx.porcelain().is_empty());
        },
        |fx| {
            assert_eq!(fx.repo.head(), m);
            assert_eq!(fx.sha("HEAD^2"), f);
        },
    )
    .await;
    fx.undo().await.unwrap();

    // Squash: no ref moves, the changes are staged.
    fx.repo.write_file("lokal.txt", "unverfolgt\n");
    let result = merge_start(&fx.tc, fx.id(), "feature".into(), MergeMode::Squash).await.unwrap();
    assert!(matches!(result, OpResult::Done { sha: None, .. }), "{result:?}");
    let entry = fx.top();
    assert_eq!(entry.ref_before, entry.ref_after);
    assert_eq!(entry.payload["squash"], true);
    fx.round_trip(
        "merge",
        |fx| {
            assert_eq!(fx.repo.head(), a);
            assert_eq!(fx.porcelain(), ["?? lokal.txt"], "state before the squash, the untracked file stays");
            assert!(!fx.exists("f.txt"));
        },
        |fx| {
            assert_eq!(fx.repo.head(), a);
            assert_eq!(fx.porcelain(), ["A  f.txt", "?? lokal.txt"]);
        },
    )
    .await;
}

#[tokio::test]
async fn merge_finished_after_a_conflict_by_commit_or_continue() {
    for by_commit in [true, false] {
        let fx = Fx::new().await;
        let (main, feature) = fx.diverge_with_conflict();
        assert_conflict(&merge_start(&fx.tc, fx.id(), "feature".into(), MergeMode::Default).await.unwrap());
        assert!(fx.entries().is_empty(), "a merge in conflict has no undo entry yet");
        assert_eq!(fx.peek().await, UndoState::default());
        fx.take_theirs("README.md").await;

        let (merged, action) = if by_commit {
            // The commit concludes the merge (payload.merge).
            let sha = fx.commit("Merge von Hand abgeschlossen").await;
            assert_eq!(fx.top().payload["merge"], true);
            (sha, "commit")
        } else {
            (done_sha(operation_continue(&fx.tc, fx.id(), None, None).await.unwrap()), "merge")
        };
        assert_eq!(fx.entries().len(), 1);
        assert_eq!(fx.sha("HEAD^2"), feature);
        fx.round_trip(
            action,
            |fx| {
                assert_eq!(fx.repo.head(), main, "back before the merge ({action})");
                assert_eq!(fx.text("README.md"), "# Main\n");
                assert!(fx.porcelain().is_empty(), "nothing remains staged: {:?}", fx.porcelain());
                assert!(!fx.repo.path().join(".git").join("MERGE_HEAD").exists());
            },
            |fx| {
                assert_eq!(fx.repo.head(), merged);
                assert_eq!(fx.text("README.md"), "# Feature\n");
            },
        )
        .await;
    }
}

#[tokio::test]
async fn aborted_merge_leaves_no_entry() {
    let fx = Fx::new().await;
    let (main, _) = fx.diverge_with_conflict();
    assert_conflict(&merge_start(&fx.tc, fx.id(), "feature".into(), MergeMode::Default).await.unwrap());
    operation_abort(&fx.tc, fx.id()).await.unwrap();
    assert_eq!(fx.repo.head(), main);
    assert!(fx.entries().is_empty());
    assert!(fx.backup_refs().is_empty());
    assert_eq!(fx.undo().await.unwrap_err().code, ErrorCode::NothingToUndo);
}

// --- Revert, Cherry-Pick ---------------------------------------------------------

#[tokio::test]
async fn revert_undo_and_redo_also_after_a_conflict() {
    let fx = Fx::new().await;
    let first = fx.repo.commit_file("a.txt", "eins\n", "Eins");
    let second = fx.repo.commit_file("b.txt", "b\n", "Zwei");
    let reverted = done_sha(revert_commit(&fx.tc, fx.id(), second.clone()).await.unwrap());
    fx.round_trip(
        "revert",
        |fx| {
            assert_eq!(fx.repo.head(), second);
            assert!(fx.exists("b.txt"));
        },
        |fx| {
            assert_eq!(fx.repo.head(), reverted);
            assert!(!fx.exists("b.txt"));
        },
    )
    .await;

    // Revert with a conflict: revert "Eins" after a.txt was changed further.
    let third = fx.repo.commit_file("a.txt", "eins und mehr\n", "Drei");
    assert_conflict(&revert_commit(&fx.tc, fx.id(), first).await.unwrap());
    fx.repo.git(&["rm", "-q", "-f", "a.txt"]);
    let finished = done_sha(operation_continue(&fx.tc, fx.id(), None, None).await.unwrap());
    fx.round_trip(
        "revert",
        |fx| {
            assert_eq!(fx.repo.head(), third);
            assert_eq!(fx.text("a.txt"), "eins und mehr\n");
        },
        |fx| {
            assert_eq!(fx.repo.head(), finished);
            assert!(!fx.exists("a.txt"));
        },
    )
    .await;
}

#[tokio::test]
async fn cherry_pick_undo_and_redo() {
    let fx = Fx::new().await;
    fx.repo.checkout_new("feature");
    let one = fx.repo.commit_file("eins.txt", "1\n", "Eins");
    let two = fx.repo.commit_file("zwei.txt", "2\n", "Zwei");
    fx.repo.checkout("main");
    let main = fx.repo.head();
    let picked = done_sha(cherry_pick(&fx.tc, fx.id(), vec![one, two]).await.unwrap());
    fx.round_trip(
        "cherry_pick",
        |fx| {
            assert_eq!(fx.repo.head(), main);
            assert!(!fx.exists("eins.txt") && !fx.exists("zwei.txt"));
        },
        |fx| {
            assert_eq!(fx.repo.head(), picked);
            assert_eq!(fx.subjects(&format!("{main}..HEAD")), ["Eins", "Zwei"]);
        },
    )
    .await;
}

#[tokio::test]
async fn cherry_pick_finished_after_a_conflict_has_one_complete_entry() {
    let fx = Fx::new().await;
    let (main, feature) = fx.diverge_with_conflict();
    assert_conflict(&cherry_pick(&fx.tc, fx.id(), vec![feature]).await.unwrap());
    let open = fx.top();
    assert_eq!(open.payload["pending"], true);
    assert_eq!(open.ref_after, None);
    assert_eq!(fx.peek().await, UndoState::default(), "while the operation is running, nothing is offered");
    assert_eq!(fx.undo().await.unwrap_err().code, ErrorCode::OperationInProgress);

    fx.take_theirs("README.md").await;
    let picked = done_sha(operation_continue(&fx.tc, fx.id(), None, None).await.unwrap());
    let entries = fx.entries();
    assert_eq!(entries.len(), 1, "the open entry is completed, no second one is created: {entries:#?}");
    assert_eq!(entries[0].id, open.id);
    assert_eq!(entries[0].payload["pending"], false);
    assert_eq!(entries[0].ref_before.as_deref(), Some(main.as_str()));
    assert_eq!(entries[0].ref_after.as_deref(), Some(picked.as_str()));
    assert_eq!(entries[0].head_after.as_deref(), Some("refs/heads/main"));
    fx.round_trip(
        "cherry_pick",
        |fx| {
            assert_eq!(fx.repo.head(), main);
            assert_eq!(fx.text("README.md"), "# Main\n");
        },
        |fx| {
            assert_eq!(fx.repo.head(), picked);
            assert_eq!(fx.text("README.md"), "# Feature\n");
        },
    )
    .await;
}

#[tokio::test]
async fn aborted_cherry_pick_and_rebase_leave_no_entry() {
    let fx = Fx::new().await;
    let (main, feature) = fx.diverge_with_conflict();
    assert_conflict(&cherry_pick(&fx.tc, fx.id(), vec![feature.clone()]).await.unwrap());
    assert_eq!(fx.entries().len(), 1);
    operation_abort(&fx.tc, fx.id()).await.unwrap();
    assert_eq!(fx.repo.head(), main);
    assert!(fx.entries().is_empty(), "{:#?}", fx.entries());
    assert!(fx.backup_refs().is_empty());

    fx.repo.checkout("feature");
    assert_conflict(&rebase_start(&fx.tc, fx.id(), "main".into(), None).await.unwrap());
    assert_eq!(fx.entries().len(), 1);
    assert_eq!(fx.backup_refs().len(), 1);
    operation_abort(&fx.tc, fx.id()).await.unwrap();
    assert_eq!(fx.sha("refs/heads/feature"), feature);
    assert_eq!(fx.token(), "refs/heads/feature");
    assert!(fx.entries().is_empty(), "{:#?}", fx.entries());
    assert!(fx.backup_refs().is_empty(), "{:?}", fx.backup_refs());
    assert_eq!(fx.peek().await, UndoState::default());
    assert_eq!(fx.undo().await.unwrap_err().code, ErrorCode::NothingToUndo);
}

// --- Rebase, Interactive Rebase, Squash -----------------------------------------

#[tokio::test]
async fn rebase_undo_and_redo() {
    let fx = Fx::new().await;
    fx.repo.checkout_new("feature");
    let old_tip = fx.repo.commit_file("f.txt", "f\n", "Feature");
    fx.repo.checkout("main");
    let main = fx.repo.commit_file("m.txt", "m\n", "Main geht weiter");

    // From main, with `branch`: the rebase switches to feature, undo switches back.
    let new_tip = done_sha(rebase_start(&fx.tc, fx.id(), "main".into(), Some("feature".into())).await.unwrap());
    fx.round_trip(
        "rebase",
        |fx| {
            assert_eq!(fx.sha("refs/heads/feature"), old_tip);
            assert_eq!(fx.token(), "refs/heads/main");
            assert_eq!(fx.repo.head(), main);
        },
        |fx| {
            assert_eq!(fx.sha("refs/heads/feature"), new_tip);
            assert_eq!(fx.token(), "refs/heads/feature");
            assert_eq!(fx.sha("HEAD^"), main);
            assert!(fx.exists("f.txt") && fx.exists("m.txt"));
        },
    )
    .await;
}

#[tokio::test]
async fn rebase_finished_after_a_conflict_has_one_complete_entry() {
    let fx = Fx::new().await;
    let (main, feature) = fx.diverge_with_conflict();
    fx.repo.checkout("feature");
    assert_conflict(&rebase_start(&fx.tc, fx.id(), "main".into(), None).await.unwrap());
    let open = fx.top();
    assert_eq!((open.action.as_str(), open.ref_after.as_deref()), ("rebase", None));

    // During a rebase, "theirs" is our own commit.
    fx.take_theirs("README.md").await;
    let new_tip = done_sha(operation_continue(&fx.tc, fx.id(), None, None).await.unwrap());
    let entries = fx.entries();
    assert_eq!(entries.len(), 1, "{entries:#?}");
    assert_eq!(entries[0].id, open.id);
    assert_eq!(entries[0].payload["pending"], false);
    assert_eq!(entries[0].ref_before.as_deref(), Some(feature.as_str()));
    assert_eq!(entries[0].ref_after.as_deref(), Some(new_tip.as_str()));
    assert_eq!(entries[0].head_after.as_deref(), Some("refs/heads/feature"));
    assert_eq!(fx.backup_refs(), [u::backup_ref_name(&open.id, "before")]);
    fx.round_trip(
        "rebase",
        |fx| {
            assert_eq!(fx.repo.head(), feature);
            assert_eq!(fx.token(), "refs/heads/feature");
        },
        |fx| {
            assert_eq!(fx.repo.head(), new_tip);
            assert_eq!(fx.sha("HEAD^"), main);
            assert_eq!(fx.text("README.md"), "# Feature\n");
        },
    )
    .await;
}

#[tokio::test]
async fn rebase_finished_in_the_terminal_is_settled_by_undo() {
    let fx = Fx::new().await;
    let (_, feature) = fx.diverge_with_conflict();
    fx.repo.checkout("feature");
    assert_conflict(&rebase_start(&fx.tc, fx.id(), "main".into(), None).await.unwrap());
    // Resolved and continued in the terminal: the core learns nothing about it.
    fx.repo.write_file("README.md", "# Beides\n");
    fx.repo.git(&["add", "README.md"]);
    fx.repo.git(&["-c", "core.editor=true", "rebase", "--continue"]);
    let new_tip = fx.repo.head();
    assert_eq!(fx.top().ref_after, None);

    assert_eq!(fx.peek().await.undo.unwrap().action, "rebase", "the open entry is offered too");
    fx.undo().await.unwrap();
    assert_eq!(fx.repo.head(), feature);
    fx.redo().await.unwrap();
    assert_eq!(fx.repo.head(), new_tip);
}

#[tokio::test]
async fn interactive_rebase_squash_drop_and_reword() {
    let fx = Fx::new().await;
    let base = fx.repo.head();
    fx.repo.commit_file("a.txt", "a\n", "A");
    fx.repo.commit_file("b.txt", "b\n", "B");
    let old_tip = fx.repo.commit_file("c.txt", "c\n", "C");
    let plan = |fx: &Fx| {
        let (tc, id, base) = (fx.tc.core.clone(), fx.id(), base.clone());
        async move {
            match rebase_plan(&tc, id, base).await.unwrap() {
                RebasePlan::Ok { rows, .. } => rows,
                other => panic!("expected a plan: {other:?}"),
            }
        }
    };

    // Squash: B is merged into A.
    let mut rows = plan(&fx).await;
    rows[1].action = RebaseAction::Squash;
    let squashed = done_sha(rebase_apply(&fx.tc, fx.id(), base.clone(), rows).await.unwrap());
    fx.round_trip(
        "squash",
        |fx| {
            assert_eq!(fx.repo.head(), old_tip);
            assert_eq!(fx.subjects(&format!("{base}..HEAD")), ["A", "B", "C"]);
        },
        |fx| {
            assert_eq!(fx.repo.head(), squashed);
            assert_eq!(fx.subjects(&format!("{base}..HEAD")), ["A", "C"]);
            assert!(fx.exists("b.txt"));
        },
    )
    .await;
    fx.undo().await.unwrap();

    // Drop: B disappears.
    let mut rows = plan(&fx).await;
    rows[1].action = RebaseAction::Drop;
    let dropped = done_sha(rebase_apply(&fx.tc, fx.id(), base.clone(), rows).await.unwrap());
    fx.round_trip(
        "drop",
        |fx| {
            assert_eq!(fx.repo.head(), old_tip);
            assert!(fx.exists("b.txt"));
        },
        |fx| {
            assert_eq!(fx.repo.head(), dropped);
            assert_eq!(fx.subjects(&format!("{base}..HEAD")), ["A", "C"]);
            assert!(!fx.exists("b.txt"));
        },
    )
    .await;
    fx.undo().await.unwrap();

    // Reword: A gets a new message.
    let mut rows = plan(&fx).await;
    rows[0].action = RebaseAction::Reword;
    rows[0].message = Some("A, besser erklärt".into());
    let reworded = done_sha(rebase_apply(&fx.tc, fx.id(), base.clone(), rows).await.unwrap());
    fx.round_trip(
        "reword",
        |fx| {
            assert_eq!(fx.repo.head(), old_tip);
            assert_eq!(fx.subjects(&format!("{base}..HEAD")), ["A", "B", "C"]);
        },
        |fx| {
            assert_eq!(fx.repo.head(), reworded);
            assert_eq!(fx.subjects(&format!("{base}..HEAD")), ["A, besser erklärt", "B", "C"]);
            assert!(fx.porcelain().is_empty());
        },
    )
    .await;
    fx.undo().await.unwrap();

    // Reordering counts as a rebase.
    let mut rows = plan(&fx).await;
    rows.swap(0, 2);
    let reordered = done_sha(rebase_apply(&fx.tc, fx.id(), base.clone(), rows).await.unwrap());
    fx.round_trip(
        "rebase",
        |fx| assert_eq!(fx.repo.head(), old_tip),
        |fx| {
            assert_eq!(fx.repo.head(), reordered);
            assert_eq!(fx.subjects(&format!("{base}..HEAD")), ["C", "B", "A"]);
        },
    )
    .await;
}

#[tokio::test]
async fn squash_commits_undo_and_redo() {
    let fx = Fx::new().await;
    let base = fx.repo.head();
    let a = fx.repo.commit_file("a.txt", "a\n", "A");
    let b = fx.repo.commit_file("b.txt", "b\n", "B");
    let old_tip = fx.repo.commit_file("c.txt", "c\n", "C");
    let result = squash_commits(&fx.tc, fx.id(), vec![a, b], "A und B".into()).await.unwrap();
    assert!(matches!(result, OpResult::Done { .. }), "{result:?}");
    let new_tip = fx.repo.head();
    fx.round_trip(
        "squash",
        |fx| {
            assert_eq!(fx.repo.head(), old_tip);
            assert_eq!(fx.subjects(&format!("{base}..HEAD")), ["A", "B", "C"]);
        },
        |fx| {
            assert_eq!(fx.repo.head(), new_tip);
            assert_eq!(fx.subjects(&format!("{base}..HEAD")), ["A und B", "C"]);
        },
    )
    .await;
}

// --- Reset -------------------------------------------------------------------------

#[tokio::test]
async fn reset_soft_mixed_and_hard() {
    let fx = Fx::new().await;
    let a = fx.repo.head();
    let b = fx.repo.commit_file("a.txt", "committet\n", "Zweiter");

    reset_branch(&fx.tc, fx.id(), a.clone(), ResetMode::Soft).await.unwrap();
    fx.round_trip(
        "reset",
        |fx| {
            assert_eq!(fx.repo.head(), b);
            assert!(fx.porcelain().is_empty());
        },
        |fx| {
            assert_eq!(fx.repo.head(), a);
            assert_eq!(fx.porcelain(), ["A  a.txt"]);
        },
    )
    .await;
    fx.undo().await.unwrap();

    // Mixed: a staged change is unstaged afterwards; undo stages it again.
    fx.repo.write_file("neu.txt", "neu\n");
    fx.repo.git(&["add", "neu.txt"]);
    reset_branch(&fx.tc, fx.id(), a.clone(), ResetMode::Mixed).await.unwrap();
    fx.round_trip(
        "reset",
        |fx| {
            assert_eq!(fx.repo.head(), b);
            assert_eq!(fx.porcelain(), ["A  neu.txt"]);
        },
        |fx| {
            assert_eq!(fx.repo.head(), a);
            assert_eq!(fx.porcelain(), ["?? a.txt", "?? neu.txt"]);
        },
    )
    .await;
    fx.undo().await.unwrap();

    // Hard: staged, unstaged and untracked work comes back completely.
    fx.repo.write_file("a.txt", "lokal geändert\n");
    fx.repo.write_file("unverfolgt.txt", "u\n");
    reset_branch(&fx.tc, fx.id(), a.clone(), ResetMode::Hard).await.unwrap();
    fx.round_trip(
        "reset",
        |fx| {
            assert_eq!(fx.repo.head(), b);
            assert_eq!(fx.porcelain(), [" M a.txt", "A  neu.txt", "?? unverfolgt.txt"]);
            assert_eq!(fx.text("a.txt"), "lokal geändert\n");
        },
        |fx| {
            assert_eq!(fx.repo.head(), a);
            // As with Git: untracked files stay in place on a hard reset.
            assert_eq!(fx.porcelain(), ["?? unverfolgt.txt"]);
        },
    )
    .await;
}

// --- Discard, restore file ----------------------------------------------------------

#[tokio::test]
async fn discard_paths_with_untracked_files_and_discard_everything() {
    let fx = Fx::new().await;
    fx.repo.commit_file("a.txt", "eins\n", "A");
    fx.repo.write_file("a.txt", "geändert\n");
    fx.repo.write_file("tief/im/ordner ü.txt", "unverfolgt\n");
    fx.repo.write_file("bleibt.txt", "bleibt\n");

    discard_paths(&fx.tc, fx.id(), Some(vec!["a.txt".into(), "tief/im/ordner ü.txt".into()])).await.unwrap();
    let entry = fx.top();
    assert!(fx.has_ref(&u::backup_ref_name(&entry.id, "worktree")));
    assert!(fx.has_ref(&u::backup_ref_name(&entry.id, "index")), "the additional backup ref of the index");
    fx.round_trip(
        "discard",
        |fx| {
            assert_eq!(fx.porcelain(), [" M a.txt", "?? bleibt.txt", "?? tief/im/ordner ü.txt"]);
            assert_eq!(fx.text("a.txt"), "geändert\n");
            assert_eq!(fx.text("tief/im/ordner ü.txt"), "unverfolgt\n");
        },
        |fx| {
            assert_eq!(fx.porcelain(), ["?? bleibt.txt"]);
            assert!(!fx.exists("tief"), "folders that became empty disappear again");
        },
    )
    .await;
    fx.undo().await.unwrap();

    // Discard everything: staged changes too.
    fx.repo.git(&["add", "bleibt.txt"]);
    discard_paths(&fx.tc, fx.id(), None).await.unwrap();
    fx.round_trip(
        "discard",
        |fx| assert_eq!(fx.porcelain(), [" M a.txt", "A  bleibt.txt", "?? tief/im/ordner ü.txt"]),
        |fx| assert!(fx.porcelain().is_empty(), "{:?}", fx.porcelain()),
    )
    .await;
}

#[tokio::test]
async fn discard_patch_undo_and_redo() {
    let fx = Fx::new().await;
    fx.repo.commit_file("f.txt", "eins\nzwei\ndrei\n", "Basis");
    fx.repo.write_file("f.txt", "eins\nZWEI\ndrei\nvier\n");
    let FileDiff::Text(diff) = diff_file(&fx.tc, fx.id(), "f.txt".into(), DiffSource::Unstaged, None, None, None).await.unwrap() else {
        panic!("expected a text diff")
    };
    // Discard only the appended line.
    let (hunk, line) = diff
        .hunks
        .iter()
        .find_map(|h| h.lines.iter().position(|l| l.text == "vier").map(|p| (h.index, p as u32)))
        .expect("line \"vier\" missing");
    let selection = PatchSelection { path: "f.txt".into(), hunks: vec![HunkSelection { index: hunk, lines: Some(vec![line]) }], expect: diff.token.clone().unwrap() };
    discard_patch(&fx.tc, fx.id(), selection).await.unwrap();
    fx.round_trip(
        "discard",
        |fx| assert_eq!(fx.text("f.txt"), "eins\nZWEI\ndrei\nvier\n"),
        |fx| assert_eq!(fx.text("f.txt"), "eins\nZWEI\ndrei\n", "redo again discards only the line, not the whole file"),
    )
    .await;
}

#[tokio::test]
async fn file_restore_backs_up_what_it_overwrites() {
    let fx = Fx::new().await;
    let old = fx.repo.commit_file("a.txt", "alt\n", "Alt");
    fx.repo.commit_file("a.txt", "neu\n", "Neu");
    fx.repo.write_file("a.txt", "lokale Arbeit\n");
    fx.repo.write_file("b.txt", "gestaged\n");
    fx.repo.git(&["add", "b.txt"]);

    file_restore(&fx.tc, fx.id(), old.clone(), vec!["a.txt".into()]).await.unwrap();
    let entry = fx.top();
    assert_eq!(entry.action, "discard");
    assert_eq!(entry.payload["restoredFrom"], old.as_str());
    assert_eq!(entry.label, format!("Undo restoring ‘a.txt’ from {}", &old[..7]));
    fx.round_trip(
        "discard",
        |fx| {
            assert_eq!(fx.text("a.txt"), "lokale Arbeit\n", "the overwritten work is back");
            assert_eq!(fx.porcelain(), [" M a.txt", "A  b.txt"]);
        },
        |fx| {
            assert_eq!(fx.text("a.txt"), "alt\n");
            assert_eq!(fx.porcelain(), ["M  a.txt", "A  b.txt"], "the restored file is staged");
        },
    )
    .await;

    // If restoring changes nothing, no further entry is created.
    let count = fx.entries().len();
    file_restore(&fx.tc, fx.id(), old, vec!["a.txt".into()]).await.unwrap();
    assert_eq!(fx.entries().len(), count);
}

// --- Delete branch, remove remote, checkout -----------------------------------------

/// Deleting several branches at once is ONE action (each used to be its own undo step): one step
/// back brings all of them back, one step forward deletes all of them again.
#[tokio::test]
async fn deleting_several_branches_is_one_step() {
    let fx = Fx::new().await;
    let _remote = fx.repo.add_remote();
    let main = fx.repo.head();
    fx.repo.git(&["branch", "--track", "eins", "origin/main"]);
    fx.repo.checkout_new("zwei");
    let two = fx.repo.commit_file("z.txt", "z\n", "Zwei");
    fx.repo.checkout("main");

    branch_delete(&fx.tc, fx.id(), vec!["eins".into(), "zwei".into()], true).await.unwrap();
    let entries = fx.entries();
    assert_eq!(entries.len(), 1);
    assert_eq!((entries[0].action.as_str(), entries[0].label.as_str()), ("delete_branch", "Undo deletion of 2 branches"));
    assert!(!fx.has_ref("refs/heads/eins") && !fx.has_ref("refs/heads/zwei"));

    for round in 0..2 {
        let state = fx.undo().await.unwrap();
        assert_eq!(state.undo, None, "round {round}");
        assert_eq!(fx.sha("refs/heads/eins"), main);
        assert_eq!(fx.sha("refs/heads/zwei"), two);
        assert_eq!(fx.repo.git(&["rev-parse", "--abbrev-ref", "eins@{upstream}"]), "origin/main", "the upstream is set again");
        let state = fx.redo().await.unwrap();
        assert_eq!(state.redo, None);
        assert!(!fx.has_ref("refs/heads/eins") && !fx.has_ref("refs/heads/zwei"));
        assert!(fx.repo.git_output(&["config", "branch.eins.remote"]).stdout.is_empty());
    }

    // A single branch stays a simple entry.
    fx.undo().await.unwrap();
    branch_delete(&fx.tc, fx.id(), vec!["zwei".into()], true).await.unwrap();
    assert_eq!(fx.top().ref_name.as_deref(), Some("refs/heads/zwei"));
}

#[tokio::test]
async fn removed_remote_comes_back_with_branches_and_upstreams() {
    let fx = Fx::new().await;
    let remote: TestRemote = fx.repo.add_remote();
    let main = fx.repo.head();
    fx.repo.checkout_new("feature");
    let feature = fx.repo.commit_file("f.txt", "f\n", "Feature");
    fx.repo.git(&["push", "-q", "-u", "origin", "feature"]);
    fx.repo.checkout("main");
    fx.repo.git(&["remote", "set-url", "--push", "origin", "https://example.com/schieben.git"]);
    let fetch_url = fx.repo.git(&["remote", "get-url", "origin"]);

    remote_remove(&fx.tc, fx.id(), "origin".into()).await.unwrap();
    let label = fx.peek().await.undo.unwrap().label;
    assert!(!label.to_ascii_lowercase().contains("fetch"), "with recorded remote branches no fetch is needed: {label}");
    fx.round_trip(
        "remove_remote",
        |fx| {
            assert_eq!(fx.repo.git(&["remote", "get-url", "origin"]), fetch_url);
            assert_eq!(fx.repo.git(&["remote", "get-url", "--push", "origin"]), "https://example.com/schieben.git");
            assert_eq!(fx.sha("refs/remotes/origin/main"), main, "remote branches are back without a fetch");
            assert_eq!(fx.sha("refs/remotes/origin/feature"), feature);
            assert_eq!(fx.repo.git(&["rev-parse", "--abbrev-ref", "main@{upstream}"]), "origin/main");
            assert_eq!(fx.repo.git(&["rev-parse", "--abbrev-ref", "feature@{upstream}"]), "origin/feature");
        },
        |fx| {
            assert!(fx.lines(&["remote"]).is_empty());
            assert!(!fx.has_ref("refs/remotes/origin/main"));
            assert!(fx.repo.git_output(&["config", "branch.main.remote"]).stdout.is_empty());
        },
    )
    .await;
    drop(remote);
}

#[tokio::test]
async fn checkout_of_branch_remote_branch_and_commit() {
    let fx = Fx::new().await;
    let _remote = fx.repo.add_remote();
    let main = fx.repo.head();
    fx.repo.checkout_new("feature");
    let feature = fx.repo.commit_file("f.txt", "f\n", "Feature");
    fx.repo.git(&["push", "-q", "origin", "feature:nur-remote"]);
    fx.repo.checkout("main");

    // Local branch
    branch_checkout(&fx.tc, fx.id(), "feature".into()).await.unwrap();
    fx.round_trip("checkout", |fx| assert_eq!(fx.token(), "refs/heads/main"), |fx| assert_eq!(fx.token(), "refs/heads/feature")).await;
    fx.undo().await.unwrap();

    // Remote branch: creates the local tracking branch; undo removes it again along with its upstream.
    branch_checkout(&fx.tc, fx.id(), "origin/nur-remote".into()).await.unwrap();
    fx.round_trip(
        "checkout",
        |fx| {
            assert_eq!(fx.token(), "refs/heads/main");
            assert!(!fx.has_ref("refs/heads/nur-remote"));
            assert!(fx.repo.git_output(&["config", "branch.nur-remote.remote"]).stdout.is_empty(), "no leftovers in the configuration");
        },
        |fx| {
            assert_eq!(fx.token(), "refs/heads/nur-remote");
            assert_eq!(fx.repo.head(), feature);
            assert_eq!(fx.repo.git(&["rev-parse", "--abbrev-ref", "nur-remote@{upstream}"]), "origin/nur-remote");
        },
    )
    .await;
    fx.undo().await.unwrap();

    // New branch with checkout
    branch_create(&fx.tc, fx.id(), "frisch".into(), Some(feature.clone()), true).await.unwrap();
    fx.round_trip(
        "checkout",
        |fx| {
            assert_eq!(fx.token(), "refs/heads/main");
            assert!(!fx.has_ref("refs/heads/frisch"));
        },
        |fx| {
            assert_eq!(fx.token(), "refs/heads/frisch");
            assert_eq!(fx.repo.head(), feature);
        },
    )
    .await;
    fx.undo().await.unwrap();

    // Commit (Detached HEAD)
    branch_checkout(&fx.tc, fx.id(), feature.clone()).await.unwrap();
    fx.round_trip("checkout", |fx| assert_eq!(fx.token(), "refs/heads/main"), |fx| assert_eq!(fx.token(), feature)).await;
    assert_eq!(fx.sha("refs/heads/main"), main);
}

// --- Stash ---------------------------------------------------------------------------

#[tokio::test]
async fn stash_create_and_pop_undo_and_redo() {
    let fx = Fx::new().await;
    fx.repo.write_file("README.md", "# Geändert\n");
    fx.repo.write_file("neu.txt", "unverfolgt\n");
    stash_create(&fx.tc, fx.id(), util::new_id(), Some("Meine Arbeit".into()), None, true, None).await.unwrap();
    fx.round_trip(
        "stash",
        |fx| {
            assert_eq!(fx.porcelain(), [" M README.md", "?? neu.txt"]);
            assert!(!fx.has_ref("refs/stash"));
        },
        |fx| {
            assert!(fx.porcelain().is_empty());
            assert_eq!(fx.lines(&["stash", "list", "--format=%gs"]), ["On main: Meine Arbeit"]);
        },
    )
    .await;

    let result = stash_pop(&fx.tc, fx.id(), 0).await.unwrap();
    assert!(matches!(result, OpResult::Done { .. }), "{result:?}");
    fx.round_trip(
        "stash_pop",
        |fx| {
            assert!(fx.porcelain().is_empty());
            assert_eq!(fx.lines(&["stash", "list", "--format=%gs"]), ["On main: Meine Arbeit"]);
        },
        |fx| {
            assert_eq!(fx.porcelain(), [" M README.md", "?? neu.txt"]);
            assert!(!fx.has_ref("refs/stash"));
        },
    )
    .await;
}

#[tokio::test]
async fn dropping_a_stash_voids_its_undo_entry() {
    let fx = Fx::new().await;
    let a = fx.repo.head();
    fx.repo.write_file("a.txt", "a\n");
    fx.repo.git(&["add", "-A"]);
    let b = fx.commit("Zweiter").await;
    fx.repo.write_file("README.md", "# Geändert\n");
    stash_create(&fx.tc, fx.id(), util::new_id(), None, None, true, None).await.unwrap();
    assert_eq!(fx.peek().await.undo.unwrap().action, "stash");

    stash_drop(&fx.tc, fx.id(), 0).await.unwrap();
    let entries = fx.entries();
    assert_eq!(entries.iter().map(|e| e.action.as_str()).collect::<Vec<_>>(), ["commit"], "the \"stash\" entry is invalidated");
    // The older step is not blocked.
    assert_eq!(fx.peek().await.undo.unwrap().action, "commit");
    fx.undo().await.unwrap();
    assert_eq!(fx.repo.head(), a);
    fx.redo().await.unwrap();
    assert_eq!(fx.repo.head(), b);
    assert!(stash_list(&fx.tc, fx.id()).await.unwrap().is_empty());
}

// --- Pull ------------------------------------------------------------------------------

/// A second clone that changes `rel` and pushes to `origin/main`; returns the new SHA.
fn push_from_elsewhere(remote: &TestRemote, rel: &str, content: &str) -> String {
    let other = TestRepo::clone_of(remote);
    let sha = other.commit_file(rel, content, &format!("Anderswo: {rel}"));
    other.git(&["push", "-q", "origin", "main"]);
    sha
}

#[tokio::test]
async fn pull_fast_forward_merge_and_rebase() {
    for mode in [PullMode::FfOnly, PullMode::Ff, PullMode::Rebase] {
        let fx = Fx::new().await;
        let remote = fx.repo.add_remote();
        let theirs = push_from_elsewhere(&remote, "remote.txt", "r\n");
        if mode != PullMode::FfOnly {
            fx.repo.commit_file("lokal.txt", "l\n", "Lokal");
        }
        let before = fx.repo.head();
        let result = pull(&fx.tc, fx.id(), util::new_id(), Some(mode)).await.unwrap();
        let after = done_sha(result);
        let action = if mode == PullMode::Rebase { "rebase" } else { "merge" };
        fx.round_trip(
            action,
            |fx| {
                assert_eq!(fx.repo.head(), before, "{mode:?}");
                assert!(!fx.exists("remote.txt"));
                assert_eq!(fx.sha("refs/remotes/origin/main"), theirs, "the fetch stays");
            },
            |fx| {
                assert_eq!(fx.repo.head(), after, "{mode:?}");
                assert!(fx.exists("remote.txt"));
                match mode {
                    PullMode::FfOnly => assert_eq!(after, theirs),
                    PullMode::Ff => assert_eq!(fx.sha("HEAD^2"), theirs),
                    PullMode::Rebase => assert_eq!(fx.sha("HEAD^"), theirs),
                }
            },
        )
        .await;
    }
}

#[tokio::test]
async fn pull_finished_after_a_conflict_is_undoable() {
    for mode in [PullMode::Ff, PullMode::Rebase] {
        let fx = Fx::new().await;
        let remote = fx.repo.add_remote();
        let theirs = push_from_elsewhere(&remote, "README.md", "# Anderswo\n");
        let ours = fx.repo.commit_file("README.md", "# Lokal\n", "Lokal");
        assert_conflict(&pull(&fx.tc, fx.id(), util::new_id(), Some(mode)).await.unwrap());
        assert!(fx.entries().is_empty());
        fx.take_theirs("README.md").await;
        let finished = done_sha(operation_continue(&fx.tc, fx.id(), None, None).await.unwrap());
        assert_eq!(fx.entries().len(), 1);
        let action = if mode == PullMode::Rebase { "rebase" } else { "merge" };
        fx.round_trip(
            action,
            |fx| {
                assert_eq!(fx.repo.head(), ours, "{mode:?}");
                assert_eq!(fx.token(), "refs/heads/main");
                assert_eq!(fx.text("README.md"), "# Lokal\n");
            },
            |fx| {
                assert_eq!(fx.repo.head(), finished, "{mode:?}");
                assert!(fx.sha("HEAD^") == theirs || fx.sha("HEAD^2") == theirs);
            },
        )
        .await;
    }
}

#[test]
fn every_action_is_covered_here() {
    // Reminder when adding an action: it needs a test with the real command here.
    let covered = [
        "checkout", "commit", "amend", "discard", "delete_branch", "remove_remote", "reset", "rebase", "cherry_pick", "squash", "reword", "drop", "merge",
        "revert", "stash", "stash_pop",
    ];
    // Group actions (`record_group`) have no command of their own yet: `group_tests.rs` covers their
    // executor; the package that adds the command adds its round trip here.
    for action in UndoAction::ALL.into_iter().filter(|action| !action.is_group()) {
        assert!(covered.contains(&action.as_str()), "{} has no test with the real command", action.as_str());
    }
}

// Work created after an action survives its undo.
#[path = "keep_work_tests.rs"]
mod keep_work_tests;
