//! Tests for undo/redo. The other commands are not built here yet; the entries are
//! therefore created the way the undo convention prescribes: the Git action runs through
//! the testkit, then `undo::record` with backup refs and a backup commit.
//! Stash and stash pop go through the real commands.

use serde_json::{json, Value};

use super::*;
use crate::commands::stash::{stash_create, stash_list, stash_pop};
use crate::commands::status::read_status;
use crate::events::names;
use crate::model::OpResult;
use crate::testkit::{TestCore, TestRepo};
use crate::undo::UndoRecord;

const MAIN: &str = "refs/heads/main";

struct Fx {
    tc: TestCore,
    repo: TestRepo,
    id: String,
}

/// An entry following the undo convention.
struct Rec {
    action: UndoAction,
    label: String,
    ref_name: Option<String>,
    before: Option<String>,
    after: Option<String>,
    head_before: String,
    head_after: Option<String>,
    payload: Value,
    backups: Vec<(&'static str, String)>,
}

fn rec(action: UndoAction, label: &str) -> Rec {
    Rec {
        action,
        label: label.to_string(),
        ref_name: None,
        before: None,
        after: None,
        head_before: MAIN.to_string(),
        head_after: Some(MAIN.to_string()),
        payload: json!({}),
        backups: Vec::new(),
    }
}

impl Rec {
    fn branch(mut self, name: &str, before: Option<&str>, after: Option<&str>) -> Self {
        self.ref_name = Some(format!("refs/heads/{name}"));
        self.before = before.map(str::to_string);
        self.after = after.map(str::to_string);
        self
    }
    fn heads(mut self, before: &str, after: &str) -> Self {
        self.head_before = before.to_string();
        self.head_after = Some(after.to_string());
        self
    }
    fn payload(mut self, payload: Value) -> Self {
        self.payload = payload;
        self
    }
    fn backup(mut self, name: &'static str, sha: &str) -> Self {
        self.backups.push((name, sha.to_string()));
        self
    }
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

    fn staged(&self) -> Vec<String> {
        self.lines(&["diff", "--cached", "--name-only"])
    }

    /// `git status --porcelain`, empty = clean.
    fn porcelain(&self) -> Vec<String> {
        let out = self.repo.git_output(&["status", "--porcelain", "-z", "--untracked-files=all"]);
        assert!(out.status.success());
        String::from_utf8_lossy(&out.stdout).split('\0').filter(|l| !l.is_empty()).map(str::to_string).collect()
    }

    fn exists(&self, rel: &str) -> bool {
        self.repo.path().join(rel).exists()
    }

    fn backup_refs(&self) -> Vec<String> {
        self.lines(&["for-each-ref", "--format=%(refname)", "refs/forkyard/undo"])
    }

    async fn record(&self, r: Rec) -> String {
        let id = u::new_id();
        for (name, sha) in &r.backups {
            u::create_backup_ref(&self.tc, &self.id, &id, name, sha).await.unwrap();
        }
        u::record(
            &self.tc,
            UndoRecord {
                id: id.clone(),
                repo_id: self.id.clone(),
                worktree_path: String::new(),
                action: r.action,
                label: r.label,
                ref_name: r.ref_name,
                ref_before: r.before,
                ref_after: r.after,
                head_before: r.head_before,
                head_after: r.head_after,
                payload: r.payload,
            },
        )
        .await
        .unwrap();
        id
    }

    async fn undo(&self) -> CoreResult<UndoState> {
        undo(&self.tc, self.id.clone()).await
    }

    async fn redo(&self) -> CoreResult<UndoState> {
        redo(&self.tc, self.id.clone()).await
    }

    async fn peek(&self) -> UndoState {
        undo_peek(&self.tc, self.id.clone()).await.unwrap()
    }

    fn changed(&self) -> Vec<String> {
        let mut what: Vec<String> = self
            .tc
            .events
            .named(names::REPO_CHANGED)
            .iter()
            .flat_map(|e| e["what"].as_array().cloned().unwrap_or_default())
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();
        what.sort();
        what.dedup();
        what
    }

    /// Back and forth twice: undo restores the state before, redo the state after again.
    async fn back_and_forth(&self, before: impl Fn(&Fx), after: impl Fn(&Fx)) {
        after(self);
        for round in 0..2 {
            let state = self.undo().await.unwrap_or_else(|e| panic!("undo in round {round}: {e:?}"));
            assert!(state.redo.is_some(), "after undo there is a redo step");
            before(self);
            let state = self.redo().await.unwrap_or_else(|e| panic!("redo in round {round}: {e:?}"));
            assert!(state.undo.is_some(), "after redo there is an undo step again");
            assert!(state.redo.is_none());
            after(self);
        }
    }
}

// --- Commit, Amend, Reword ---------------------------------------------------

#[tokio::test]
async fn commit_undo_keeps_the_changes_staged() {
    let fx = Fx::new().await;
    let a = fx.repo.head();
    fx.repo.write_file("neu ä.txt", "x\r\n");
    fx.repo.git(&["add", "-A"]);
    fx.repo.git(&["commit", "-q", "-m", "Zweiter"]);
    let b = fx.repo.head();
    fx.record(rec(UndoAction::Commit, "Undo commit “Zweiter”").branch("main", Some(&a), Some(&b))).await;
    fx.tc.events.clear();

    let state = fx.undo().await.unwrap();
    assert!(state.undo.is_none());
    let redo_step = state.redo.unwrap();
    assert_eq!(redo_step.action, "commit");
    assert_eq!(redo_step.label, "Redo commit “Zweiter”");
    assert_eq!(fx.repo.head(), a);
    assert_eq!(fx.token(), MAIN);
    assert_eq!(fx.staged(), ["neu ä.txt"]);
    assert_eq!(fx.repo.read_file("neu ä.txt"), b"x\r\n");
    assert_eq!(fx.changed(), ["head", "index", "refs"]);

    let state = fx.redo().await.unwrap();
    assert_eq!(state.undo.unwrap().label, "Undo commit “Zweiter”");
    assert!(state.redo.is_none());
    assert_eq!(fx.repo.head(), b);
    assert!(fx.porcelain().is_empty());

    fx.back_and_forth(
        |fx| {
            assert_eq!(fx.repo.head(), a);
            assert_eq!(fx.staged(), ["neu ä.txt"]);
        },
        |fx| {
            assert_eq!(fx.repo.head(), b);
            assert!(fx.porcelain().is_empty());
        },
    )
    .await;
}

#[tokio::test]
async fn short_branch_names_in_an_entry_are_understood() {
    let fx = Fx::new().await;
    let a = fx.repo.head();
    let b = fx.repo.commit_file("a.txt", "a\n", "Zweiter");
    // Against the convention, without "refs/heads/": no ref outside of it may be created.
    let mut entry = rec(UndoAction::Commit, "Undo commit “Zweiter”").heads("main", "main");
    entry.ref_name = Some("main".into());
    entry.before = Some(a.clone());
    entry.after = Some(b.clone());
    fx.record(entry).await;
    fx.back_and_forth(|fx| assert_eq!(fx.repo.head(), a), |fx| assert_eq!(fx.repo.head(), b)).await;
    let refs = fx.lines(&["for-each-ref", "--format=%(refname)"]);
    assert!(refs.iter().all(|r| r == "refs/heads/main" || r.starts_with("refs/forkyard/undo/")), "{refs:?}");
    assert!(!fx.repo.path().join(".git").join("main").exists());
}

#[tokio::test]
async fn first_commit_goes_back_to_a_repo_without_commits() {
    let fx = Fx::with(TestRepo::new()).await;
    fx.repo.write_file("a.txt", "a\n");
    fx.repo.git(&["add", "-A"]);
    fx.repo.git(&["commit", "-q", "-m", "Erster"]);
    let b = fx.repo.head();
    fx.record(rec(UndoAction::Commit, "Undo commit “Erster”").branch("main", None, Some(&b))).await;

    fx.back_and_forth(
        |fx| {
            assert!(!fx.has_ref("HEAD"), "the branch is without a commit again");
            assert_eq!(fx.token(), MAIN);
            assert_eq!(fx.lines(&["ls-files"]), ["a.txt"], "the index stays");
            assert_eq!(fx.repo.read_file("a.txt"), b"a\n");
        },
        |fx| {
            assert_eq!(fx.repo.head(), b);
            assert!(fx.porcelain().is_empty());
        },
    )
    .await;
}

#[tokio::test]
async fn commit_on_detached_head() {
    let fx = Fx::new().await;
    fx.repo.git(&["checkout", "-q", "--detach"]);
    let a = fx.repo.head();
    let b = fx.repo.commit_file("a.txt", "a\n", "Lose");
    fx.record(rec(UndoAction::Commit, "Undo commit “Lose”").heads(&a, &b)).await;
    fx.back_and_forth(
        |fx| {
            assert_eq!(fx.token(), a, "HEAD stays detached");
            assert_eq!(fx.staged(), ["a.txt"]);
        },
        |fx| {
            assert_eq!(fx.token(), b);
            assert!(fx.porcelain().is_empty());
        },
    )
    .await;
    assert_eq!(fx.sha("main"), a, "main stays untouched");
}

#[tokio::test]
async fn amend_and_reword_go_back_softly() {
    let fx = Fx::new().await;
    let b = fx.repo.commit_file("a.txt", "a\n", "Zweiter");
    fx.repo.write_file("b.txt", "b\n");
    fx.repo.git(&["add", "-A"]);
    fx.repo.git(&["commit", "-q", "--amend", "-m", "Zweiter, ergänzt"]);
    let b2 = fx.repo.head();
    fx.record(rec(UndoAction::Amend, "Undo amend of “Zweiter”").branch("main", Some(&b), Some(&b2)).backup("before", &b)).await;
    fx.back_and_forth(
        |fx| {
            assert_eq!(fx.repo.head(), b);
            assert_eq!(fx.staged(), ["b.txt"], "what the amend added stays staged");
        },
        |fx| {
            assert_eq!(fx.repo.head(), b2);
            assert!(fx.porcelain().is_empty());
        },
    )
    .await;

    fx.repo.git(&["commit", "-q", "--amend", "-m", "Neue Message"]);
    let b3 = fx.repo.head();
    fx.record(rec(UndoAction::Reword, "Undo message change").branch("main", Some(&b2), Some(&b3)).backup("before", &b2)).await;
    fx.back_and_forth(
        |fx| {
            assert_eq!(fx.repo.head(), b2);
            assert_eq!(fx.repo.git(&["log", "-1", "--format=%s"]), "Zweiter, ergänzt");
            assert!(fx.porcelain().is_empty());
        },
        |fx| {
            assert_eq!(fx.repo.head(), b3);
            assert_eq!(fx.repo.git(&["log", "-1", "--format=%s"]), "Neue Message");
        },
    )
    .await;
}

// --- Merge, Revert, Cherry-Pick, Squash, Drop, Rebase ----------------------

#[tokio::test]
async fn merge_needs_a_clean_worktree() {
    let fx = Fx::new().await;
    fx.repo.checkout_new("feature");
    fx.repo.commit_file("f.txt", "f\n", "Feature");
    fx.repo.checkout("main");
    let a = fx.repo.commit_file("m.txt", "m\n", "Main");
    fx.repo.git(&["merge", "-q", "--no-ff", "--no-edit", "feature"]);
    let m = fx.repo.head();
    fx.record(rec(UndoAction::Merge, "Undo merge of feature").branch("main", Some(&a), Some(&m))).await;

    // Modified tracked file: rejected, nothing moves, the entry stays.
    fx.repo.write_file("m.txt", "lokal\n");
    let err = fx.undo().await.unwrap_err();
    assert_eq!(err.code, ErrorCode::DirtyWorktree);
    assert_eq!(fx.repo.head(), m);
    assert_eq!(fx.repo.read_file("m.txt"), b"lokal\n");
    assert_eq!(fx.peek().await.undo.unwrap().action, "merge");
    fx.repo.git(&["checkout", "-q", "--", "m.txt"]);

    // Untracked files do not matter and stay where they are.
    fx.repo.write_file("notiz.txt", "bleibt\n");
    fx.tc.events.clear();
    fx.back_and_forth(
        |fx| {
            assert_eq!(fx.repo.head(), a);
            assert!(!fx.exists("f.txt"));
            assert_eq!(fx.porcelain(), ["?? notiz.txt"]);
        },
        |fx| {
            assert_eq!(fx.repo.head(), m);
            assert!(fx.exists("f.txt"));
            assert_eq!(fx.porcelain(), ["?? notiz.txt"]);
        },
    )
    .await;
    assert_eq!(fx.changed(), ["head", "index", "refs", "worktree"]);

    // Redo also requires a clean working directory.
    fx.undo().await.unwrap();
    fx.repo.write_file("m.txt", "lokal\n");
    assert_eq!(fx.redo().await.unwrap_err().code, ErrorCode::DirtyWorktree);
    assert_eq!(fx.repo.head(), a);
    // An untracked file that the merge state would overwrite blocks as well.
    fx.repo.git(&["checkout", "-q", "--", "m.txt"]);
    fx.repo.write_file("f.txt", "eigene Datei\n");
    let err = fx.redo().await.unwrap_err();
    assert_eq!(err.code, ErrorCode::DirtyWorktree);
    assert_eq!(fx.repo.read_file("f.txt"), b"eigene Datei\n");
    assert_eq!(fx.repo.head(), a);
}

#[tokio::test]
async fn revert_cherry_pick_squash_and_drop_reset_the_branch() {
    for action in [UndoAction::Revert, UndoAction::CherryPick, UndoAction::Squash, UndoAction::Drop] {
        let fx = Fx::new().await;
        fx.repo.commit_file("a.txt", "1\n", "Eins");
        let before = fx.repo.commit_file("a.txt", "2\n", "Zwei");
        match action {
            UndoAction::Revert => {
                fx.repo.git(&["revert", "--no-edit", "HEAD"]);
            }
            UndoAction::CherryPick => {
                fx.repo.git(&["checkout", "-q", "-b", "andere", "HEAD~2"]);
                fx.repo.commit_file("b.txt", "b\n", "Von nebenan");
                fx.repo.checkout("main");
                fx.repo.git(&["cherry-pick", "andere"]);
            }
            UndoAction::Squash => {
                fx.repo.git(&["reset", "-q", "--soft", "HEAD~2"]);
                fx.repo.git(&["commit", "-q", "-m", "Zusammengefasst"]);
            }
            _ => {
                fx.repo.git(&["reset", "-q", "--hard", "HEAD~1"]);
            }
        }
        let after = fx.repo.head();
        assert_ne!(before, after);
        let label = format!("Undo {}", action.as_str());
        fx.record(rec(action, &label).branch("main", Some(&before), Some(&after)).backup("before", &before)).await;
        fx.back_and_forth(
            |fx| {
                assert_eq!(fx.repo.head(), before, "{action:?}");
                assert_eq!(fx.repo.read_file("a.txt"), b"2\n");
                assert!(fx.porcelain().is_empty());
            },
            |fx| {
                assert_eq!(fx.repo.head(), after, "{action:?}");
                assert!(fx.porcelain().is_empty());
            },
        )
        .await;
        assert_eq!(fx.token(), MAIN);
    }
}

#[tokio::test]
async fn rebase_with_unknown_end_state_and_branch_switch() {
    let fx = Fx::new().await;
    fx.repo.checkout_new("feature");
    fx.repo.commit_file("f.txt", "f\n", "Feature");
    fx.repo.checkout("main");
    fx.repo.commit_file("m.txt", "m\n", "Main");
    let f_before = fx.sha("feature");
    // "feature onto main" from main: HEAD is on feature afterwards.
    fx.repo.git(&["rebase", "-q", "main", "feature"]);
    let f_after = fx.sha("feature");
    assert_ne!(f_before, f_after);
    // End state unknown (e.g. the rebase only finished after a conflict).
    fx.record(
        rec(UndoAction::Rebase, "Undo rebase of feature")
            .branch("feature", Some(&f_before), None)
            .heads(MAIN, "refs/heads/feature")
            .backup("before", &f_before),
    )
    .await;
    fx.back_and_forth(
        |fx| {
            assert_eq!(fx.sha("feature"), f_before);
            assert_eq!(fx.token(), MAIN);
            assert!(!fx.exists("f.txt"));
            assert!(fx.porcelain().is_empty());
        },
        |fx| {
            assert_eq!(fx.sha("feature"), f_after);
            assert_eq!(fx.token(), "refs/heads/feature");
            assert!(fx.exists("f.txt") && fx.exists("m.txt"));
            assert!(fx.porcelain().is_empty());
        },
    )
    .await;
}

// --- Reset --------------------------------------------------------------------

#[tokio::test]
async fn reset_soft_and_mixed() {
    let fx = Fx::new().await;
    let c1 = fx.repo.head();
    let c2 = fx.repo.commit_file("a.txt", "a\n", "Zweiter");

    fx.repo.git(&["reset", "-q", "--soft", &c1]);
    fx.record(rec(UndoAction::Reset, "Undo reset").branch("main", Some(&c2), Some(&c1)).payload(json!({ "mode": "soft" })).backup("before", &c2))
        .await;
    fx.back_and_forth(
        |fx| {
            assert_eq!(fx.repo.head(), c2);
            assert!(fx.porcelain().is_empty());
        },
        |fx| {
            assert_eq!(fx.repo.head(), c1);
            assert_eq!(fx.staged(), ["a.txt"]);
        },
    )
    .await;
    fx.undo().await.unwrap();

    // Mixed: a file was staged before; the index comes back from indexTree.
    fx.repo.write_file("neu.txt", "n\n");
    fx.repo.git(&["add", "neu.txt"]);
    let index_tree = fx.repo.git(&["write-tree"]);
    fx.repo.git(&["reset", "-q", "--mixed", &c1]);
    fx.record(
        rec(UndoAction::Reset, "Undo reset")
            .branch("main", Some(&c2), Some(&c1))
            .payload(json!({ "mode": "mixed", "worktreeSnapshot": null, "indexTree": index_tree, "paths": null }))
            .backup("before", &c2),
    )
    .await;
    fx.back_and_forth(
        |fx| {
            assert_eq!(fx.repo.head(), c2);
            assert_eq!(fx.staged(), ["neu.txt"]);
            assert_eq!(fx.porcelain(), ["A  neu.txt"]);
        },
        |fx| {
            assert_eq!(fx.repo.head(), c1);
            assert!(fx.staged().is_empty());
            assert_eq!(fx.porcelain(), ["?? a.txt", "?? neu.txt"]);
        },
    )
    .await;
    assert_eq!(fx.repo.read_file("a.txt"), b"a\n");
}

#[tokio::test]
async fn hard_reset_brings_back_worktree_and_index() {
    let fx = Fx::new().await;
    let c1 = fx.repo.head();
    let c2 = fx.repo.commit_file("a.txt", "eins\r\nzwei\r\n", "Zweiter");
    let edited: &[u8] = b"eins\r\nZWEI\r\ndrei ohne Ende";
    fx.repo.write_file("a.txt", edited);
    fx.repo.write_file("gestaged ü.txt", "g\n");
    fx.repo.git(&["add", "gestaged ü.txt"]);
    fx.repo.write_file("lose datei.txt", "l\n");

    // Recording as in reset_branch: backup, then the reset.
    let (snapshot, index_tree) = u::snapshot_worktree(&fx.tc, &fx.id, None).await.unwrap();
    fx.repo.git(&["reset", "-q", "--hard", &c1]);
    fx.record(
        rec(UndoAction::Reset, "Undo hard reset")
            .branch("main", Some(&c2), Some(&c1))
            .payload(json!({ "mode": "hard", "worktreeSnapshot": snapshot, "indexTree": index_tree, "paths": null }))
            .backup("before", &c2)
            .backup("worktree", &snapshot),
    )
    .await;
    fx.tc.events.clear();

    fx.back_and_forth(
        |fx| {
            assert_eq!(fx.repo.head(), c2);
            assert_eq!(fx.repo.read_file("a.txt"), edited, "byte-exact, with CRLF and without a final newline");
            assert_eq!(fx.repo.read_file("gestaged ü.txt"), b"g\n");
            assert_eq!(fx.staged(), ["gestaged ü.txt"]);
            assert_eq!(fx.porcelain(), [" M a.txt", "A  gestaged ü.txt", "?? lose datei.txt"]);
        },
        |fx| {
            assert_eq!(fx.repo.head(), c1);
            assert!(!fx.exists("a.txt") && !fx.exists("gestaged ü.txt"));
            assert_eq!(fx.porcelain(), ["?? lose datei.txt"]);
        },
    )
    .await;
    assert_eq!(fx.changed(), ["head", "index", "refs", "worktree"]);

    // Work continued between undo and redo: redo only repeats the reset; whatever was created
    // since stays in place (redo used to wipe it) – also across the next undo.
    fx.undo().await.unwrap();
    fx.repo.write_file("später.txt", "s\n");
    fx.redo().await.unwrap();
    assert!(fx.exists("später.txt") && !fx.exists("a.txt"));
    fx.undo().await.unwrap();
    assert_eq!(fx.repo.read_file("später.txt"), b"s\n");
    assert_eq!(fx.repo.read_file("a.txt"), edited);
}

// --- Discard ------------------------------------------------------------------

#[tokio::test]
async fn discard_of_paths_restores_files_and_deleted_untracked_ones() {
    let fx = Fx::new().await;
    fx.repo.write_file("crlf datei.txt", "eins\r\nzwei\r\n");
    fx.repo.write_file("ohne ende.txt", "a\nb");
    fx.repo.write_file("bleibt.txt", "x\n");
    let head = fx.repo.commit("Dateien");
    fx.repo.write_file("crlf datei.txt", "eins\r\nZWEI\r\n");
    fx.repo.write_file("ohne ende.txt", "a\nb\nc");
    fx.repo.write_file("bleibt.txt", "anders\n");
    fx.repo.write_file("ordner/neu ö.txt", "neu");
    let paths = vec!["crlf datei.txt".to_string(), "ohne ende.txt".to_string(), "ordner/neu ö.txt".to_string()];

    // Recording as in discard_paths: back up the paths, then discard.
    let (snapshot, index_tree) = u::snapshot_worktree(&fx.tc, &fx.id, Some(&paths)).await.unwrap();
    assert_eq!(fx.sha(&format!("{snapshot}^")), head, "the backup hangs off HEAD");
    fx.repo.git(&["checkout", "-q", "--", "crlf datei.txt", "ohne ende.txt"]);
    std::fs::remove_dir_all(fx.repo.path().join("ordner")).unwrap();
    fx.record(
        rec(UndoAction::Discard, "Undo discarding 3 files")
            .payload(json!({ "worktreeSnapshot": snapshot, "indexTree": index_tree, "paths": paths }))
            .backup("worktree", &snapshot),
    )
    .await;
    fx.tc.events.clear();

    fx.back_and_forth(
        |fx| {
            assert_eq!(fx.repo.read_file("crlf datei.txt"), b"eins\r\nZWEI\r\n");
            assert_eq!(fx.repo.read_file("ohne ende.txt"), b"a\nb\nc");
            assert_eq!(fx.repo.read_file("ordner/neu ö.txt"), b"neu", "the deleted untracked file is back");
            assert_eq!(fx.repo.read_file("bleibt.txt"), b"anders\n");
            assert_eq!(fx.repo.head(), head);
        },
        |fx| {
            assert_eq!(fx.repo.read_file("crlf datei.txt"), b"eins\r\nzwei\r\n");
            assert_eq!(fx.repo.read_file("ohne ende.txt"), b"a\nb");
            assert!(!fx.exists("ordner"), "the empty folder is gone again too");
            assert_eq!(fx.repo.read_file("bleibt.txt"), b"anders\n", "files not selected stay untouched");
            assert_eq!(fx.porcelain(), [" M bleibt.txt"]);
        },
    )
    .await;
    assert_eq!(fx.changed(), ["index", "worktree"]);
}

#[tokio::test]
async fn discard_of_everything_and_stale_after_a_commit() {
    let fx = Fx::new().await;
    fx.repo.commit_file("a.txt", "a\n", "Zweiter");
    fx.repo.write_file("a.txt", "geaendert\n");
    fx.repo.write_file("gestaged.txt", "g\n");
    fx.repo.git(&["add", "gestaged.txt"]);
    fx.repo.write_file("tief/im/ordner.txt", "t\n");
    let (snapshot, index_tree) = u::snapshot_worktree(&fx.tc, &fx.id, None).await.unwrap();
    fx.repo.git(&["reset", "-q", "--hard"]);
    fx.repo.git(&["clean", "-fdq"]);
    assert!(fx.porcelain().is_empty());
    fx.record(
        rec(UndoAction::Discard, "Undo discarding all changes")
            .payload(json!({ "worktreeSnapshot": snapshot, "indexTree": index_tree, "paths": null }))
            .backup("worktree", &snapshot),
    )
    .await;
    fx.back_and_forth(
        |fx| {
            assert_eq!(fx.repo.read_file("a.txt"), b"geaendert\n");
            assert_eq!(fx.porcelain(), [" M a.txt", "A  gestaged.txt", "?? tief/im/ordner.txt"]);
        },
        |fx| assert!(fx.porcelain().is_empty()),
    )
    .await;

    // A commit was made in the meantime: the backup no longer matches HEAD. The entry is
    // skipped and no longer offered – until the repository is back at its state.
    let old = fx.repo.head();
    fx.repo.commit_file("b.txt", "b
", "Dazwischen");
    let err = fx.undo().await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NothingToUndo);
    assert!(fx.porcelain().is_empty());
    assert_eq!(fx.peek().await.undo, None, "the button does not offer the stale step");
    fx.repo.git(&["reset", "-q", "--hard", &old]);
    assert_eq!(fx.peek().await.undo.unwrap().action, "discard", "the entry is not deleted");
}

// --- Delete branch, remove remote, checkout ----------------------------------

#[tokio::test]
async fn deleted_branch_comes_back_with_its_upstream() {
    let fx = Fx::new().await;
    let _remote = fx.repo.add_remote();
    fx.repo.checkout_new("feature");
    let tip = fx.repo.commit_file("f.txt", "f\n", "Feature");
    fx.repo.git(&["push", "-q", "-u", "origin", "feature"]);
    fx.repo.checkout("main");
    fx.repo.git(&["branch", "-D", "feature"]);
    fx.record(
        rec(UndoAction::DeleteBranch, "Undo deleting feature")
            .branch("feature", Some(&tip), None)
            .payload(json!({ "branch": "feature", "upstream": "origin/feature" }))
            .backup("before", &tip),
    )
    .await;
    fx.tc.events.clear();
    fx.back_and_forth(
        |fx| {
            assert_eq!(fx.sha("refs/heads/feature"), tip);
            assert_eq!(fx.repo.git(&["rev-parse", "--abbrev-ref", "feature@{upstream}"]), "origin/feature");
            assert_eq!(fx.token(), MAIN);
        },
        |fx| assert!(!fx.has_ref("refs/heads/feature")),
    )
    .await;
    assert_eq!(fx.changed(), ["config", "refs"]);

    // Upstream that does not exist (yet) as a remote branch: the configuration is set anyway.
    fx.repo.branch_at("lokal", &tip);
    fx.repo.git(&["branch", "-D", "lokal"]);
    fx.record(
        rec(UndoAction::DeleteBranch, "Undo deleting lokal")
            .branch("lokal", Some(&tip), None)
            .payload(json!({ "branch": "lokal", "upstream": "origin/noch/nicht/da" })),
    )
    .await;
    fx.undo().await.unwrap();
    assert_eq!(fx.sha("refs/heads/lokal"), tip);
    assert_eq!(fx.repo.git(&["config", "branch.lokal.remote"]), "origin");
    assert_eq!(fx.repo.git(&["config", "branch.lokal.merge"]), "refs/heads/noch/nicht/da");

    // If the branch exists again in the meantime, the state no longer fits.
    fx.repo.git(&["branch", "-D", "lokal"]);
    fx.repo.branch_at("lokal", "main");
    assert_eq!(fx.peek().await.redo, None);
    assert_eq!(fx.redo().await.unwrap_err().code, ErrorCode::NothingToUndo);
    assert_eq!(fx.sha("refs/heads/lokal"), fx.sha("main"), "the new branch stays as it is");
}

#[tokio::test]
async fn removed_remote_comes_back_with_both_urls() {
    let fx = Fx::new().await;
    fx.repo.git(&["remote", "add", "upstream", "https://example.com/holen.git"]);
    fx.repo.git(&["remote", "set-url", "--push", "upstream", "https://example.com/schieben.git"]);
    fx.repo.git(&["remote", "remove", "upstream"]);
    fx.record(rec(UndoAction::RemoveRemote, "Undo removing remote “upstream”").payload(json!({
        "remote": { "name": "upstream", "fetchUrl": "https://example.com/holen.git", "pushUrl": "https://example.com/schieben.git" }
    })))
    .await;
    let label = fx.peek().await.undo.unwrap().label;
    assert!(label.starts_with("Undo removing remote “upstream”") && label.contains("fetch"), "{label}");
    fx.tc.events.clear();
    fx.back_and_forth(
        |fx| {
            assert_eq!(fx.repo.git(&["remote", "get-url", "upstream"]), "https://example.com/holen.git");
            assert_eq!(fx.repo.git(&["remote", "get-url", "--push", "upstream"]), "https://example.com/schieben.git");
        },
        |fx| assert!(fx.lines(&["remote"]).is_empty()),
    )
    .await;
    assert_eq!(fx.changed(), ["config", "refs"]);
    assert_eq!(fx.peek().await.redo, None);

    // The remote was re-added by hand in the meantime: overwrite nothing.
    fx.repo.git(&["remote", "add", "upstream", "https://example.com/anders.git"]);
    assert_eq!(fx.peek().await.undo, None);
    assert_eq!(fx.undo().await.unwrap_err().code, ErrorCode::NothingToUndo);
    assert_eq!(fx.repo.git(&["remote", "get-url", "upstream"]), "https://example.com/anders.git");
}

#[tokio::test]
async fn checkout_between_branches_detached_and_new_branch() {
    let fx = Fx::new().await;
    let c1 = fx.repo.head();
    fx.repo.checkout_new("feature");
    fx.repo.commit_file("a.txt", "feature\n", "Feature");
    fx.repo.checkout("main");

    fx.repo.checkout("feature");
    fx.record(rec(UndoAction::Checkout, "Undo checkout of feature").heads(MAIN, "refs/heads/feature")).await;
    fx.back_and_forth(
        |fx| {
            assert_eq!(fx.token(), MAIN);
            assert!(!fx.exists("a.txt"));
        },
        |fx| {
            assert_eq!(fx.token(), "refs/heads/feature");
            assert!(fx.exists("a.txt"));
        },
    )
    .await;

    // To a commit (detached).
    fx.repo.git(&["checkout", "-q", "--detach", &c1]);
    fx.record(rec(UndoAction::Checkout, "Undo checkout").heads("refs/heads/feature", &c1)).await;
    fx.back_and_forth(|fx| assert_eq!(fx.token(), "refs/heads/feature"), |fx| assert_eq!(fx.token(), c1)).await;

    // Checkout that created a branch: on undo it disappears again.
    fx.repo.checkout_new("neu");
    fx.record(rec(UndoAction::Checkout, "Undo checkout of neu").branch("neu", None, Some(&c1)).heads(&c1, "refs/heads/neu")).await;
    fx.back_and_forth(
        |fx| {
            assert_eq!(fx.token(), c1);
            assert!(!fx.has_ref("refs/heads/neu"));
        },
        |fx| {
            assert_eq!(fx.token(), "refs/heads/neu");
            assert_eq!(fx.sha("neu"), c1);
        },
    )
    .await;

    // Local changes the switch would overwrite: dirty_worktree, nothing happens.
    fx.repo.checkout("feature");
    fx.record(rec(UndoAction::Checkout, "Undo checkout of feature").heads("refs/heads/neu", "refs/heads/feature")).await;
    fx.repo.write_file("a.txt", "lokal\n");
    let err = fx.undo().await.unwrap_err();
    assert_eq!(err.code, ErrorCode::DirtyWorktree);
    assert_eq!(fx.token(), "refs/heads/feature");
    assert_eq!(fx.repo.read_file("a.txt"), b"lokal\n");

    // The branch to go back to was deleted.
    fx.repo.git(&["checkout", "-q", "--", "a.txt"]);
    fx.repo.git(&["branch", "-D", "neu"]);
    assert_eq!(fx.undo().await.unwrap_err().code, ErrorCode::StaleState);
}

// --- Stash and stash pop (through the real commands) -------------------------

#[tokio::test]
async fn stash_undo_brings_the_changes_back_and_redo_stashes_again() {
    let fx = Fx::new().await;
    fx.repo.commit_file("b.txt", "b\n", "Zweiter");
    fx.repo.write_file("README.md", "# in Arbeit\r\n");
    fx.repo.write_file("gestaged.txt", "g\n");
    fx.repo.git(&["add", "gestaged.txt"]);
    fx.repo.write_file("neu ü.txt", "ohne Ende");
    let list = stash_create(&fx.tc, fx.id.clone(), util::new_id(), Some("Arbeit".into()), None, true, None).await.unwrap();
    assert_eq!(list.len(), 1);
    fx.tc.events.clear();

    let state = fx.undo().await.unwrap();
    assert_eq!(state.redo.unwrap().label, "Redo stash “Arbeit”");
    assert_eq!(fx.changed(), ["index", "stash", "worktree"]);
    for round in 0..2 {
        // Undone: everything is back, the list is empty.
        assert_eq!(fx.repo.read_file("README.md"), b"# in Arbeit\r\n", "round {round}");
        assert_eq!(fx.repo.read_file("neu ü.txt"), b"ohne Ende");
        assert_eq!(fx.porcelain(), [" M README.md", "A  gestaged.txt", "?? neu ü.txt"]);
        assert!(stash_list(&fx.tc, fx.id.clone()).await.unwrap().is_empty());

        fx.redo().await.unwrap();
        assert!(fx.porcelain().is_empty());
        let list = stash_list(&fx.tc, fx.id.clone()).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].message, "Arbeit");
        assert_eq!(list[0].file_count, 3);

        fx.undo().await.unwrap();
    }

    // Partial stash: redo again takes only the selected paths.
    fx.repo.git(&["reset", "-q", "--hard"]);
    fx.repo.git(&["clean", "-fdq"]);
    fx.repo.write_file("README.md", "# eins\n");
    fx.repo.write_file("b.txt", "zwei\n");
    stash_create(&fx.tc, fx.id.clone(), util::new_id(), None, Some(vec!["b.txt".into()]), false, None).await.unwrap();
    assert_eq!(fx.porcelain(), [" M README.md"]);
    fx.undo().await.unwrap();
    assert_eq!(fx.porcelain(), [" M README.md", " M b.txt"]);
    fx.redo().await.unwrap();
    assert_eq!(fx.porcelain(), [" M README.md"]);
    assert_eq!(stash_list(&fx.tc, fx.id.clone()).await.unwrap().len(), 1);

    // The stash was deleted by hand: nothing left to undo.
    fx.repo.git(&["stash", "drop", "-q"]);
    assert_eq!(fx.peek().await.undo, None);
    assert_eq!(fx.undo().await.unwrap_err().code, ErrorCode::NothingToUndo);
}

#[tokio::test]
async fn stash_pop_undo_puts_the_stash_back_in_place() {
    let fx = Fx::new().await;
    for name in ["eins", "zwei", "drei"] {
        fx.repo.write_file("README.md", format!("# {name}\n"));
        if name == "zwei" {
            fx.repo.write_file("aus dem stash.txt", "s\n");
        }
        stash_create(&fx.tc, fx.id.clone(), util::new_id(), Some(name.into()), None, true, None).await.unwrap();
    }
    let original = stash_list(&fx.tc, fx.id.clone()).await.unwrap();
    // Before the pop there is already other work in the directory; it does not belong to the stash.
    fx.repo.write_file("lokal.txt", "l\n");

    let result = stash_pop(&fx.tc, fx.id.clone(), 1).await.unwrap();
    assert!(matches!(result, OpResult::Done { .. }));
    fx.tc.events.clear();

    let ids = |list: &[crate::model::Stash]| list.iter().map(|s| (s.sha.clone(), s.message.clone())).collect::<Vec<_>>();
    for round in 0..2 {
        let state = fx.undo().await.unwrap();
        assert_eq!(state.redo.unwrap().label, "Redo stash pop of “zwei”");
        // State before the pop: only our own file, all three stashes in their old order.
        assert_eq!(fx.porcelain(), ["?? lokal.txt"], "round {round}");
        assert_eq!(fx.repo.read_file("README.md"), b"# Test\n");
        assert!(!fx.exists("aus dem stash.txt"));
        assert_eq!(ids(&stash_list(&fx.tc, fx.id.clone()).await.unwrap()), ids(&original));

        let state = fx.redo().await.unwrap();
        assert_eq!(state.undo.unwrap().label, "Undo stash pop of “zwei”");
        assert_eq!(fx.repo.read_file("README.md"), b"# zwei\n");
        assert_eq!(fx.repo.read_file("aus dem stash.txt"), b"s\n");
        assert_eq!(fx.porcelain(), [" M README.md", "?? aus dem stash.txt", "?? lokal.txt"]);
        let list = stash_list(&fx.tc, fx.id.clone()).await.unwrap();
        assert_eq!(list.iter().map(|s| s.message.as_str()).collect::<Vec<_>>(), ["drei", "eins"]);
    }
    assert_eq!(fx.changed(), ["index", "stash", "worktree"]);
    assert_eq!(fx.lines(&["for-each-ref", "--format=%(refname)", "refs/forkyard/stash-rebuild"]), Vec::<String>::new());

    // After a commit the state no longer fits.
    fx.repo.git(&["add", "lokal.txt"]);
    fx.repo.git(&["commit", "-q", "-m", "Dazwischen"]);
    assert_eq!(fx.peek().await.undo, None);
    assert_eq!(fx.undo().await.unwrap_err().code, ErrorCode::NothingToUndo);
}

// --- Preconditions, stack, cleanup -------------------------------------------

#[tokio::test]
async fn stale_entries_are_skipped_until_the_repository_is_back_on_their_state() {
    let fx = Fx::new().await;
    let a = fx.repo.head();
    let b = fx.repo.commit_file("a.txt", "a\n", "Zweiter");
    fx.record(rec(UndoAction::Commit, "Undo commit “Zweiter”").branch("main", Some(&a), Some(&b))).await;
    let c = fx.repo.commit_file("c.txt", "c\n", "Im Terminal");
    fx.tc.events.clear();

    // The branch is no longer at the after state: the step is not offered.
    assert_eq!(fx.peek().await.undo, None);
    let err = fx.undo().await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NothingToUndo);
    assert_eq!(fx.repo.head(), c, "nothing was moved");
    assert_eq!(fx.tc.events.count(names::REPO_CHANGED), 0);

    // Back at the after state it works again: the entry was only skipped.
    fx.repo.git(&["reset", "-q", "--hard", &b]);
    assert_eq!(fx.peek().await.undo.unwrap().action, "commit");
    fx.undo().await.unwrap();
    assert_eq!(fx.repo.head(), a);

    // Redo: the branch is no longer at the before state.
    fx.repo.git(&["commit", "-q", "-m", "Anders weiter"]);
    assert_eq!(fx.peek().await.redo, None);
    let err = fx.redo().await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NothingToUndo);
    assert!(err.message.contains("redo"), "{}", err.message);

    // HEAD on another branch: stale as well.
    fx.repo.git(&["reset", "-q", "--soft", &a]);
    fx.repo.git(&["stash", "-q"]);
    assert_eq!(fx.peek().await.redo.unwrap().action, "commit");
    fx.repo.checkout_new("woanders");
    assert_eq!(fx.peek().await.redo, None);
    assert_eq!(fx.redo().await.unwrap_err().code, ErrorCode::NothingToUndo);
    fx.repo.checkout("main");
    fx.redo().await.unwrap();
    assert_eq!(fx.repo.head(), b);
}

#[tokio::test]
async fn a_stale_entry_does_not_block_older_ones() {
    let fx = Fx::new().await;
    let a = fx.repo.head();
    // Older step: a deleted branch.
    fx.repo.branch_at("alt", "main");
    fx.repo.git(&["branch", "-D", "alt"]);
    fx.record(
        rec(UndoAction::DeleteBranch, "Undo deleting branch ‘alt’")
            .branch("alt", Some(&a), None)
            .payload(json!({ "branch": "alt", "upstream": null }))
            .backup("before", &a),
    )
    .await;
    // Newer step: a commit followed by another one made in the terminal.
    let b = fx.repo.commit_file("a.txt", "a\n", "Zweiter");
    let stale = fx.record(rec(UndoAction::Commit, "Undo commit “Zweiter”").branch("main", Some(&a), Some(&b))).await;
    let c = fx.repo.commit_file("c.txt", "c\n", "Im Terminal");

    let state = fx.peek().await;
    assert_eq!(state.undo.unwrap().label, "Undo deleting branch ‘alt’", "the button shows what really happens");
    let state = fx.undo().await.unwrap();
    assert_eq!(fx.sha("refs/heads/alt"), a);
    assert_eq!(fx.repo.head(), c);
    assert_eq!(state.undo, None);
    assert_eq!(state.redo.unwrap().action, "delete_branch");
    // The skipped entry is not deleted and applies again as soon as the state fits.
    assert!(fx.tc.db.with(|conn| crate::db::undo::get(conn, &stale)).unwrap().is_some());
    fx.repo.git(&["reset", "-q", "--hard", &b]);
    assert_eq!(fx.peek().await.undo.unwrap().action, "commit");
}

#[tokio::test]
async fn pushed_commit_is_not_offered_for_undo() {
    let fx = Fx::new().await;
    let _remote = fx.repo.add_remote();
    let a = fx.repo.head();
    let b = fx.repo.commit_file("a.txt", "a\n", "Zweiter");
    fx.record(rec(UndoAction::Commit, "Undo commit “Zweiter”").branch("main", Some(&a), Some(&b))).await;
    assert_eq!(fx.peek().await.undo.unwrap().action, "commit");
    fx.repo.git(&["push", "-q", "origin", "main"]);

    // The commit is on the remote: it is no longer undone locally.
    assert_eq!(fx.peek().await.undo, None);
    let err = fx.undo().await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NothingToUndo);
    assert_eq!(fx.repo.head(), b);
    assert!(fx.backup_refs().is_empty(), "nothing was touched");

    // A fast-forward merge rightly lands on a commit of the remote and stays undoable.
    fx.repo.git(&["reset", "-q", "--hard", &a]);
    fx.repo.git(&["merge", "-q", "--ff-only", "origin/main"]);
    fx.record(rec(UndoAction::Merge, "Undo merge of origin/main").branch("main", Some(&a), Some(&b))).await;
    fx.back_and_forth(|fx| assert_eq!(fx.repo.head(), a), |fx| assert_eq!(fx.repo.head(), b)).await;
}

#[tokio::test]
async fn running_operation_and_open_conflicts_block_undo() {
    let fx = Fx::new().await;
    let a = fx.repo.head();
    fx.repo.checkout_new("feature");
    fx.repo.commit_file("README.md", "# Feature\n", "Feature");
    fx.repo.checkout("main");
    let b = fx.repo.commit_file("README.md", "# Main\n", "Main");
    fx.record(rec(UndoAction::Commit, "Undo commit “Main”").branch("main", Some(&a), Some(&b))).await;

    assert!(!fx.repo.merge("feature"));
    let err = fx.undo().await.unwrap_err();
    assert_eq!(err.code, ErrorCode::OperationInProgress);
    assert!(fx.repo.path().join(".git").join("MERGE_HEAD").exists());
    assert_eq!(fx.repo.head(), b);
    fx.repo.git(&["merge", "--abort"]);

    // Conflict without a running operation (e.g. after a stash pop).
    fx.repo.write_file("README.md", "# Stash\n");
    fx.repo.git(&["stash", "-q"]);
    let b2 = fx.repo.commit_file("README.md", "# Main 2\n", "Main 2");
    fx.record(rec(UndoAction::Commit, "Undo commit “Main 2”").branch("main", Some(&b), Some(&b2))).await;
    assert!(!fx.repo.git_output(&["stash", "pop"]).status.success());
    assert_eq!(fx.undo().await.unwrap_err().code, ErrorCode::Conflict);
    fx.repo.git(&["checkout", "-q", "HEAD", "--", "README.md"]);
    fx.undo().await.unwrap();
    assert_eq!(fx.repo.head(), b);
}

#[tokio::test]
async fn nothing_to_undo_or_redo() {
    let fx = Fx::new().await;
    fx.tc.events.clear();
    let err = fx.undo().await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NothingToUndo);
    let err = fx.redo().await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NothingToUndo);
    assert!(err.message.contains("redo"));
    assert_eq!(fx.tc.events.count(names::REPO_CHANGED), 0);
    assert_eq!(fx.peek().await, UndoState::default());

    assert_eq!(undo(&fx.tc, "unbekannt".into()).await.unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(redo(&fx.tc, "unbekannt".into()).await.unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(undo_peek(&fx.tc, "unbekannt".into()).await.unwrap_err().code, ErrorCode::NotFound);
}

#[tokio::test]
async fn stack_order_and_a_new_action_clears_redo() {
    let fx = Fx::new().await;
    let c1 = fx.repo.head();
    let c2 = fx.repo.commit_file("a.txt", "a\n", "Zwei");
    fx.record(rec(UndoAction::Commit, "Undo commit “Zwei”").branch("main", Some(&c1), Some(&c2))).await;
    let c3 = fx.repo.commit_file("b.txt", "b\n", "Drei");
    let third = fx.record(rec(UndoAction::Commit, "Undo commit “Drei”").branch("main", Some(&c2), Some(&c3))).await;

    let state = fx.undo().await.unwrap();
    assert_eq!(fx.repo.head(), c2);
    assert_eq!(state.undo.unwrap().label, "Undo commit “Zwei”");
    assert_eq!(state.redo.unwrap().label, "Redo commit “Drei”");
    let state = fx.undo().await.unwrap();
    assert_eq!(fx.repo.head(), c1);
    assert!(state.undo.is_none());
    assert_eq!(state.redo.unwrap().label, "Redo commit “Zwei”", "last undone = first redone");
    let state = fx.redo().await.unwrap();
    assert_eq!(fx.repo.head(), c2);
    assert_eq!(state.redo.unwrap().label, "Redo commit “Drei”");

    // The undone commit "Drei" only hangs off the backup ref "after" now.
    let after_ref = u::backup_ref_name(&third, "after");
    assert_eq!(fx.sha(&after_ref), c3);

    // A new action empties the redo stack along with its backup refs.
    fx.repo.git(&["reset", "-q", "--hard"]);
    let c3b = fx.repo.commit_file("c.txt", "c\n", "Drei, anders");
    fx.record(rec(UndoAction::Commit, "Undo commit “Drei, anders”").branch("main", Some(&c2), Some(&c3b))).await;
    let state = fx.peek().await;
    assert!(state.redo.is_none());
    assert_eq!(state.undo.unwrap().label, "Undo commit “Drei, anders”");
    assert!(!fx.has_ref(&after_ref));
    assert_eq!(fx.redo().await.unwrap_err().code, ErrorCode::NothingToUndo);
}

#[tokio::test]
async fn cleanup_of_old_entries_removes_all_their_backup_refs() {
    let fx = Fx::new().await;
    let c1 = fx.repo.head();
    let c2 = fx.repo.commit_file("a.txt", "a\n", "Zwei");
    fx.repo.write_file("a.txt", "lokal\n");
    let (snapshot, index_tree) = u::snapshot_worktree(&fx.tc, &fx.id, None).await.unwrap();
    fx.repo.git(&["reset", "-q", "--hard", &c1]);
    let old = fx
        .record(
            rec(UndoAction::Reset, "Undo hard reset")
                .branch("main", Some(&c2), Some(&c1))
                .payload(json!({ "mode": "hard", "worktreeSnapshot": snapshot, "indexTree": index_tree, "paths": null }))
                .backup("before", &c2)
                .backup("worktree", &snapshot),
        )
        .await;
    fx.undo().await.unwrap();
    let refs = fx.backup_refs();
    for name in ["before", "worktree", "after", "after-worktree"] {
        assert!(refs.contains(&u::backup_ref_name(&old, name)), "{name} missing in {refs:?}");
    }

    fx.tc
        .db
        .with(|c| {
            c.execute("update undo_entries set created_at = '2000-01-01T00:00:00.000Z' where id = ?1", [&old])?;
            Ok(())
        })
        .unwrap();
    fx.tc.startup_cleanup().await.unwrap();
    assert!(fx.backup_refs().is_empty(), "{:?}", fx.backup_refs());
    assert_eq!(fx.peek().await, UndoState::default());
    assert_eq!(fx.repo.read_file("a.txt"), b"lokal\n", "cleanup does not touch the working directory");
}

#[tokio::test]
async fn foreign_index_lock_is_reported_and_the_entry_stays() {
    let fx = Fx::new().await;
    let a = fx.repo.head();
    fx.repo.checkout_new("feature");
    fx.repo.commit_file("f.txt", "f\n", "Feature");
    fx.repo.checkout("main");
    fx.repo.git(&["merge", "-q", "--no-ff", "--no-edit", "feature"]);
    let m = fx.repo.head();
    fx.record(rec(UndoAction::Merge, "Undo merge of feature").branch("main", Some(&a), Some(&m))).await;

    let lock = fx.repo.path().join(".git").join("index.lock");
    std::fs::write(&lock, "").unwrap();
    let err = fx.undo().await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Locked);
    assert!(lock.exists(), "the foreign lock file is never deleted");
    assert_eq!(fx.repo.head(), m);
    assert_eq!(fx.peek().await.undo.unwrap().action, "merge");
    std::fs::remove_file(&lock).unwrap();
    fx.undo().await.unwrap();
    assert_eq!(fx.repo.head(), a);
}

#[tokio::test]
async fn lost_backup_is_reported_instead_of_guessing() {
    let fx = Fx::new().await;
    let a = fx.repo.head();
    let b = fx.repo.commit_file("a.txt", "a\n", "Zweiter");
    // An entry whose earlier state does not exist (any more).
    fx.record(rec(UndoAction::Amend, "Undo amend").branch("main", Some("0123456789abcdef0123456789abcdef01234567"), Some(&b))).await;
    let err = fx.undo().await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    assert_eq!(fx.repo.head(), b);

    fx.record(rec(UndoAction::Discard, "Undo discard").payload(json!({ "worktreeSnapshot": null, "indexTree": null, "paths": null }))).await;
    assert_eq!(fx.undo().await.unwrap_err().code, ErrorCode::NotFound);
    let _ = a;
}

// --- Backup and restore -------------------------------------------------------

#[tokio::test]
async fn snapshot_works_without_commits_and_without_identity() {
    let fx = Fx::with(TestRepo::without_identity()).await;
    fx.repo.write_file("a ä.txt", "a\r\n");
    fx.repo.write_file("tief/b.txt", "b");
    fx.repo.git(&["add", "a ä.txt"]);
    let before = fx.porcelain();

    let (snapshot, index_tree) = u::snapshot_worktree(&fx.tc, &fx.id, None).await.unwrap();
    assert_eq!(fx.repo.git(&["log", "-1", "--format=%P|%s|%an", &snapshot]), "|forkyard: backup|forkyard", "without a commit the backup has no parent");
    assert_eq!(fx.lines(&["ls-tree", "-r", "--name-only", &snapshot]), ["a ä.txt", "tief/b.txt"]);
    assert_eq!(fx.lines(&["ls-tree", "-r", "--name-only", index_tree.as_deref().unwrap()]), ["a ä.txt"]);
    assert_eq!(fx.porcelain(), before, "the real index stays untouched");
    let leftovers: Vec<_> = std::fs::read_dir(fx.repo.path().join(".git"))
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("forkyard-"))
        .collect();
    assert!(leftovers.is_empty(), "temporary index files are gone again: {leftovers:?}");

    std::fs::remove_dir_all(fx.repo.path().join("tief")).unwrap();
    fx.repo.write_file("a ä.txt", "kaputt");
    fx.repo.write_file("später.txt", "s");
    u::restore_worktree(&fx.tc, &fx.id, &snapshot, None).await.unwrap();
    assert_eq!(fx.repo.read_file("a ä.txt"), b"a\r\n");
    assert_eq!(fx.repo.read_file("tief/b.txt"), b"b");
    assert!(!fx.exists("später.txt"));
}

#[tokio::test]
async fn restore_handles_file_directory_swaps_and_leaves_ignored_files_alone() {
    let fx = Fx::new().await;
    fx.repo.write_file(".gitignore", "ignoriert/\n*.log\n");
    fx.repo.write_file("ding", "eine Datei\n");
    fx.repo.write_file("ordner/kind.txt", "k\n");
    fx.repo.commit("Ausgangslage");
    fx.repo.write_file("ignoriert/geheim.txt", "g\n");
    fx.repo.write_file("ordner/build.log", "log\n");
    let token = read_status(&fx.tc, &fx.id).await.unwrap().token;
    let (snapshot, _) = u::snapshot_worktree(&fx.tc, &fx.id, None).await.unwrap();
    assert_eq!(fx.lines(&["ls-tree", "-r", "--name-only", &snapshot]), [".gitignore", "README.md", "ding", "ordner/kind.txt"], "ignored files are not backed up");
    assert_eq!(read_status(&fx.tc, &fx.id).await.unwrap().token, token);

    // File becomes folder, folder becomes file.
    fx.repo.remove_file("ding");
    fx.repo.write_file("ding/innen.txt", "i\n");
    fx.repo.remove_file("ordner/kind.txt");
    fx.repo.remove_file("ordner/build.log");
    std::fs::remove_dir(fx.repo.path().join("ordner")).unwrap();
    fx.repo.write_file("ordner", "jetzt eine Datei\n");
    fx.repo.write_file("ignoriert/noch eins.txt", "n\n");

    u::restore_worktree(&fx.tc, &fx.id, &snapshot, None).await.unwrap();
    assert_eq!(fx.repo.read_file("ding"), b"eine Datei\n");
    assert_eq!(fx.repo.read_file("ordner/kind.txt"), b"k\n");
    assert_eq!(fx.repo.read_file("ignoriert/geheim.txt"), b"g\n");
    assert_eq!(fx.repo.read_file("ignoriert/noch eins.txt"), b"n\n", "ignored files stay where they are");
    assert!(fx.porcelain().is_empty());
}

#[tokio::test]
async fn snapshot_of_paths_tolerates_missing_ones_and_open_conflicts() {
    let fx = Fx::new().await;
    fx.repo.commit_file("a.txt", "a\n", "A");
    fx.repo.write_file("a.txt", "geändert\n");
    fx.repo.write_file("muster[1].txt", "wörtlich\n");
    fx.repo.write_file("muster1.txt", "nicht gemeint\n");
    let paths = vec!["a.txt".to_string(), "gibt es nicht.txt".to_string(), "muster[1].txt".to_string()];
    let (snapshot, index_tree) = u::snapshot_worktree(&fx.tc, &fx.id, Some(&paths)).await.unwrap();
    assert!(index_tree.is_some());
    assert_eq!(fx.repo.git(&["show", &format!("{snapshot}:a.txt")]), "geändert");
    assert_eq!(fx.lines(&["ls-tree", "-r", "--name-only", &snapshot]), ["README.md", "a.txt", "muster[1].txt"], "paths are literal, not patterns");

    // Open conflicts: there is no tree of the index, the backup is created anyway.
    fx.repo.git(&["checkout", "-q", "--", "a.txt"]);
    fx.repo.checkout_new("feature");
    fx.repo.commit_file("a.txt", "feature\n", "Feature");
    fx.repo.checkout("main");
    fx.repo.commit_file("a.txt", "main\n", "Main");
    assert!(!fx.repo.merge("feature"));
    let (snapshot, index_tree) = u::snapshot_worktree(&fx.tc, &fx.id, None).await.unwrap();
    assert!(index_tree.is_none());
    assert!(fx.repo.git(&["show", &format!("{snapshot}:a.txt")]).contains("<<<<<<<"));
    assert!(fx.repo.path().join(".git").join("MERGE_HEAD").exists());
}

#[test]
fn labels_and_actions() {
    assert_eq!(u::redo_label("Undo commit “x”"), "Redo commit “x”");
    assert_eq!(u::redo_label("Something else"), "Redo: Something else");
    for action in UndoAction::ALL {
        assert_eq!(UndoAction::parse(action.as_str()), Some(action));
    }
    let entry = |action: UndoAction, payload: Value| UndoEntry {
        id: "x".into(),
        repo_id: "r".into(),
        worktree_path: String::new(),
        action: action.as_str().into(),
        label: String::new(),
        ref_name: None,
        ref_before: None,
        ref_after: None,
        head_before: MAIN.into(),
        head_after: None,
        payload,
        state: UndoEntryState::Done,
        created_at: String::new(),
    };
    for action in UndoAction::ALL {
        assert!(!changes_for(&entry(action, json!({}))).is_empty());
    }
    // A commit that concluded a merge is undone hard.
    assert!(!changes_for(&entry(UndoAction::Commit, json!({ "merge": false }))).contains(&RepoChange::Worktree));
    assert!(changes_for(&entry(UndoAction::Commit, json!({ "merge": true }))).contains(&RepoChange::Worktree));
    assert_eq!(UndoAction::parse("push"), None);
    assert_eq!(u::shorten("kurz", 10), "kurz");
    assert_eq!(u::shorten("ein längerer Text", 8), "ein län…");
    assert!(head_matches("refs/heads/main", &Head::Unborn { branch: "main".into() }));
    assert!(head_matches("ABCDEF1", &Head::Detached { sha: "abcdef1".into() }));
    assert!(!head_matches("refs/heads/main", &Head::Detached { sha: "abcdef1".into() }));
}
// --- Racy index ---------------------------------------------------------------

/// A file rewritten with the same size in the same timestamp tick as the index: Git compares
/// such "racily clean" entries by content because the index is not older than them. The backup
/// works on a copy of the index – the copy must keep that property, or the backup silently takes
/// the old content (seen as a flaky partial-stash undo under load).
#[tokio::test]
async fn snapshot_takes_content_of_racily_clean_files() {
    use std::time::{Duration, SystemTime};
    let fx = Fx::new().await;
    fx.repo.git(&["config", "core.trustctime", "false"]);
    fx.repo.commit_file("f.txt", "a\nb\n", "f");
    let when = SystemTime::now() - Duration::from_secs(3600);
    let touch = |rel: &str| std::fs::File::options().write(true).open(fx.repo.path().join(rel)).unwrap().set_modified(when).unwrap();
    touch("f.txt");
    fx.repo.git(&["update-index", "-q", "--refresh"]);
    // Same size, same mtime as the index entry, and the index itself from the same tick.
    fx.repo.write_file("f.txt", "A\nB\n");
    touch("f.txt");
    touch(".git/index");

    let (snapshot, _) = u::snapshot_worktree(&fx.tc, &fx.id, None).await.unwrap();
    assert_eq!(fx.repo.git(&["show", &format!("{snapshot}:f.txt")]), "A\nB");
    let (snapshot, _) = u::snapshot_worktree(&fx.tc, &fx.id, Some(&["f.txt".to_string()])).await.unwrap();
    assert_eq!(fx.repo.git(&["show", &format!("{snapshot}:f.txt")]), "A\nB");
}
