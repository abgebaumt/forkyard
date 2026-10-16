//! `range_apply` against real temp repositories: lines of a branch's changes taken over byte-exact into
//! the working directory and/or the index, as from a coding agent's worktree.

use super::*;
use crate::commands::diff::diff_file;
use crate::commands::undo::{redo, undo, undo_peek};
use crate::model::{DiffLineKind, DiffSource, FileDiff, HunkSelection, TextDiff};
use crate::testkit::{TestCore, TestRepo};

const CRLF_BASE: &[u8] = b"eins\r\nzwei\r\ndrei\r\nvier";
const CRLF_AGENT: &[u8] = b"eins\r\nZWEI\r\ndrei\r\nVIER";
const LATIN1_BASE: &[u8] = b"Gr\xfc\xdfe\nalt\n";
const LATIN1_AGENT: &[u8] = b"Gr\xfc\xdfe\nneu \xe4\n";
const ODD: &str = "src/ä b/-start.txt";
const TEN: &str = "1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n";

struct Fx {
    tc: TestCore,
    repo: TestRepo,
    id: String,
    base: String,
    agent: String,
}

/// `main` with four files; branch `agent` changes all of them. HEAD stays on `main`.
async fn fixture() -> Fx {
    let repo = TestRepo::with_commit();
    repo.write_file("crlf.txt", CRLF_BASE);
    repo.write_file("latin1.txt", LATIN1_BASE);
    repo.write_file(ODD, "a\n");
    repo.write_file("zehn.txt", TEN);
    let base = repo.commit("Basis");
    repo.checkout_new("agent");
    repo.write_file("crlf.txt", CRLF_AGENT);
    repo.write_file("latin1.txt", LATIN1_AGENT);
    repo.write_file(ODD, "a\nb\n");
    repo.write_file("zehn.txt", TEN.replace("\n2\n", "\nzwei\n"));
    let agent = repo.commit("Agent ändert alles");
    repo.checkout("main");
    let tc = TestCore::new().await;
    let id = tc.open(&repo).await.repo.id;
    Fx { tc, repo, id, base, agent }
}

impl Fx {
    async fn diff_to(&self, path: &str, to: &str) -> TextDiff {
        let source = DiffSource::Range { from: self.base.clone(), to: Some(to.to_string()) };
        match diff_file(&self.tc, self.id.clone(), path.to_string(), source, None, None, None).await.unwrap() {
            FileDiff::Text(text) => text,
            other => panic!("{other:?}"),
        }
    }

    async fn diff(&self, path: &str) -> TextDiff {
        self.diff_to(path, &self.agent.clone()).await
    }

    async fn apply(&self, selections: Vec<PatchSelection>, target: RangeApplyTarget) -> CoreResult<Status> {
        range_apply(&self.tc, self.id.clone(), "main".into(), "agent".into(), selections, target).await
    }

    fn staged(&self) -> String {
        self.repo.git(&["-c", "core.quotepath=false", "diff", "--cached", "--name-only"])
    }

    fn index_bytes(&self, path: &str) -> Vec<u8> {
        self.repo.git_output(&["show", &format!(":{path}")]).stdout
    }

    fn backup_refs(&self) -> String {
        self.repo.git(&["for-each-ref", "--format=%(refname)", "refs/forkyard/undo"])
    }
}

fn whole(diff: &TextDiff) -> PatchSelection {
    PatchSelection {
        path: diff.path.clone(),
        hunks: diff.hunks.iter().map(|hunk| HunkSelection { index: hunk.index, lines: None }).collect(),
        expect: diff.range_token.clone().expect("range token"),
    }
}

/// Only the changed lines with these texts, from the first hunk.
fn lines(diff: &TextDiff, texts: &[&str]) -> PatchSelection {
    let hunk = &diff.hunks[0];
    let picked: Vec<u32> =
        hunk.lines.iter().enumerate().filter(|(_, line)| line.kind != DiffLineKind::Context && texts.contains(&line.text.as_str())).map(|(index, _)| index as u32).collect();
    assert_eq!(picked.len(), texts.len(), "{:?}", hunk.lines);
    PatchSelection { path: diff.path.clone(), hunks: vec![HunkSelection { index: hunk.index, lines: Some(picked) }], expect: diff.range_token.clone().expect("range token") }
}

#[tokio::test]
async fn takes_single_lines_byte_exact_into_the_working_directory() {
    let fx = fixture().await;
    let diff = fx.diff("crlf.txt").await;
    assert!(diff.token.is_none(), "a range diff offers no line staging");
    let status = fx.apply(vec![lines(&diff, &["zwei", "ZWEI"])], RangeApplyTarget::Worktree).await.unwrap();
    assert_eq!(fx.repo.read_file("crlf.txt"), b"eins\r\nZWEI\r\ndrei\r\nvier", "only the selected pair; CRLF and the missing final newline stay");
    assert_eq!(fx.staged(), "", "the index is untouched");
    assert!(status.unstaged.iter().any(|change| change.path == "crlf.txt"), "{status:?}");
    let latin = fx.diff("latin1.txt").await;
    fx.apply(vec![whole(&latin)], RangeApplyTarget::Worktree).await.unwrap();
    assert_eq!(fx.repo.read_file("latin1.txt"), LATIN1_AGENT, "Latin-1 bytes unchanged");
}

#[tokio::test]
async fn targets_index_and_both() {
    let fx = fixture().await;
    let diff = fx.diff("crlf.txt").await;
    fx.apply(vec![lines(&diff, &["vier", "VIER"])], RangeApplyTarget::Index).await.unwrap();
    assert_eq!(fx.index_bytes("crlf.txt"), b"eins\r\nzwei\r\ndrei\r\nVIER");
    assert_eq!(fx.repo.read_file("crlf.txt"), CRLF_BASE, "the working directory is untouched");
    let latin = fx.diff("latin1.txt").await;
    fx.apply(vec![whole(&latin)], RangeApplyTarget::Both).await.unwrap();
    assert_eq!(fx.index_bytes("latin1.txt"), LATIN1_AGENT);
    assert_eq!(fx.repo.read_file("latin1.txt"), LATIN1_AGENT);
}

#[tokio::test]
async fn a_wrong_token_or_a_changed_file_is_stale() {
    let fx = fixture().await;
    let diff = fx.diff("crlf.txt").await;
    let mut wrong = whole(&diff);
    wrong.expect = "falsch".into();
    assert_eq!(fx.apply(vec![wrong], RangeApplyTarget::Worktree).await.unwrap_err().code, ErrorCode::StaleState);
    // The agent changes the selected file again: the selection no longer describes the range.
    fx.repo.checkout("agent");
    fx.repo.commit_file("crlf.txt", b"eins\r\nZWEI\r\nDREI\r\nVIER".as_slice(), "Nochmal");
    fx.repo.checkout("main");
    let err = fx.apply(vec![lines(&diff, &["vier", "VIER"])], RangeApplyTarget::Worktree).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::StaleState, "{err:?}");
    assert_eq!(fx.repo.read_file("crlf.txt"), CRLF_BASE);
}

#[tokio::test]
async fn another_commit_on_other_files_keeps_the_selection_valid() {
    let fx = fixture().await;
    let diff = fx.diff("crlf.txt").await;
    fx.repo.checkout("agent");
    fx.repo.commit_file("anderes.txt", "x\n", "Anderes");
    fx.repo.checkout("main");
    fx.apply(vec![lines(&diff, &["zwei", "ZWEI"])], RangeApplyTarget::Worktree).await.unwrap();
    assert_eq!(fx.repo.read_file("crlf.txt"), b"eins\r\nZWEI\r\ndrei\r\nvier");
}

#[tokio::test]
async fn a_conflict_with_own_changes_changes_nothing() {
    let fx = fixture().await;
    let diff = fx.diff("zehn.txt").await;
    let mine = TEN.replace("\n2\n", "\nmeins\n");
    fx.repo.write_file("zehn.txt", &mine);
    let refs_before = fx.backup_refs();
    let err = fx.apply(vec![whole(&diff)], RangeApplyTarget::Worktree).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict, "{err:?}");
    assert!(err.message.contains("zehn.txt"), "{}", err.message);
    assert_eq!(fx.repo.read_file("zehn.txt"), mine.as_bytes(), "own change kept, no conflict markers");
    assert_eq!(fx.staged(), "");
    assert_eq!(fx.backup_refs(), refs_before, "no backup was made");
    assert!(undo_peek(&fx.tc, fx.id.clone()).await.unwrap().undo.is_none(), "no undo entry");
}

#[tokio::test]
async fn own_changes_nearby_are_merged_three_way_without_touching_the_index() {
    let fx = fixture().await;
    let diff = fx.diff("zehn.txt").await;
    fx.repo.write_file("zehn.txt", TEN.replace("\n5\n", "\nfünf\n"));
    fx.apply(vec![whole(&diff)], RangeApplyTarget::Worktree).await.unwrap();
    assert_eq!(fx.repo.read_file("zehn.txt"), TEN.replace("\n2\n", "\nzwei\n").replace("\n5\n", "\nfünf\n").as_bytes());
    assert_eq!(fx.staged(), "", "the real index is untouched");
    assert_eq!(fx.repo.git(&["rev-parse", ":zehn.txt"]), fx.repo.git(&["rev-parse", "main:zehn.txt"]));
}

#[tokio::test]
async fn undo_and_redo_restore_both_sides() {
    let fx = fixture().await;
    let diff = fx.diff("crlf.txt").await;
    fx.apply(vec![whole(&diff)], RangeApplyTarget::Both).await.unwrap();
    assert_eq!(fx.repo.read_file("crlf.txt"), CRLF_AGENT);
    let step = undo_peek(&fx.tc, fx.id.clone()).await.unwrap().undo.expect("undo offered");
    assert_eq!(step.action, "range_apply");
    assert!(step.label.contains("crlf.txt") && step.label.contains(&fx.agent[..7]), "{}", step.label);
    undo(&fx.tc, fx.id.clone()).await.unwrap();
    assert_eq!(fx.repo.read_file("crlf.txt"), CRLF_BASE);
    assert_eq!(fx.staged(), "");
    redo(&fx.tc, fx.id.clone()).await.unwrap();
    assert_eq!(fx.repo.read_file("crlf.txt"), CRLF_AGENT);
    assert_eq!(fx.staged(), "crlf.txt");
}

#[tokio::test]
async fn range_apply_handles_dash_space_and_umlaut_paths() {
    let fx = fixture().await;
    let diff = fx.diff(ODD).await;
    assert_eq!(diff.path, ODD);
    fx.apply(vec![whole(&diff)], RangeApplyTarget::Both).await.unwrap();
    assert_eq!(fx.repo.read_file(ODD), b"a\nb\n");
    assert_eq!(fx.staged(), ODD);
    let mut outside = whole(&diff);
    outside.path = "../draußen.txt".into();
    assert_eq!(fx.apply(vec![outside], RangeApplyTarget::Worktree).await.unwrap_err().code, ErrorCode::NotAllowed);
    assert_eq!(fx.apply(vec![whole(&diff), whole(&diff)], RangeApplyTarget::Worktree).await.unwrap_err().code, ErrorCode::NotAllowed, "the same file twice");
}

/// A file far above the diff view's line limit (opened with "show anyway"): only the selected hunk
/// lands, every CRLF of the 60 000 lines stays.
#[tokio::test]
async fn a_huge_crlf_file_takes_over_only_the_selected_hunk() {
    let repo = TestRepo::with_commit();
    let base_text: String = (1..=60_000).map(|n| format!("Zeile {n}\r\n")).collect();
    repo.write_file("riesig.txt", &base_text);
    let base = repo.commit("Riesig");
    repo.checkout_new("agent");
    let agent_text = base_text.replacen("Zeile 2\r\n", "ZWEI\r\n", 1).replacen("Zeile 59999\r\n", "ENDE\r\n", 1);
    repo.write_file("riesig.txt", &agent_text);
    let agent = repo.commit("Agent");
    repo.checkout("main");
    let tc = TestCore::new().await;
    let id = tc.open(&repo).await.repo.id;
    let source = DiffSource::Range { from: base.clone(), to: Some(agent.clone()) };
    let diff = match diff_file(&tc, id.clone(), "riesig.txt".into(), source, Some(true), None, None).await.unwrap() {
        FileDiff::Text(text) => text,
        other => panic!("{other:?}"),
    };
    assert_eq!(diff.hunks.len(), 2, "two changes far apart");
    let last = &diff.hunks[1];
    let selection = PatchSelection { path: diff.path.clone(), hunks: vec![HunkSelection { index: last.index, lines: None }], expect: diff.range_token.clone().expect("range token") };
    range_apply(&tc, id.clone(), base, agent, vec![selection], RangeApplyTarget::Worktree).await.unwrap();
    let expected = base_text.replacen("Zeile 59999\r\n", "ENDE\r\n", 1);
    assert_eq!(repo.read_file("riesig.txt"), expected.as_bytes(), "only the second hunk");
}

#[tokio::test]
async fn a_renamed_file_ends_in_a_conflict_with_its_name() {
    let fx = fixture().await;
    fx.repo.checkout("agent");
    fx.repo.git(&["mv", "zehn.txt", "umbenannt.txt"]);
    fx.repo.write_file("umbenannt.txt", TEN.replace("\n2\n", "\nzwei\n").replace("\n10\n", "\nzehn\n"));
    let renamed = fx.repo.commit("Umbenannt");
    fx.repo.checkout("main");
    let diff = fx.diff_to("umbenannt.txt", &renamed).await;
    assert_eq!(diff.old_path.as_deref(), Some("zehn.txt"), "Git sees a rename");
    let err = range_apply(&fx.tc, fx.id.clone(), fx.base.clone(), renamed, vec![whole(&diff)], RangeApplyTarget::Worktree).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict, "{err:?}");
    assert!(err.message.contains("umbenannt.txt"), "{}", err.message);
    assert!(!fx.repo.path().join("umbenannt.txt").exists());
}
