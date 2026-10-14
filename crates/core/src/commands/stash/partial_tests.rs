//! Partial stash against real temp repositories: unstaged only, staged only, mixed over two files,
//! CRLF without a final newline, Latin-1, rollback after a failure, stale selections, undo and redo.

use std::sync::atomic::Ordering;

use super::*;
use crate::commands::diff::diff_file;
use crate::commands::undo::{redo, undo};
use crate::model::{DiffLineKind, DiffSource, FileDiff, HunkSelection, PatchSelection, StashSelection, TextDiff};
use crate::testkit::{TestCore, TestRepo};

async fn open(repo: &TestRepo) -> (TestCore, String) {
    let tc = TestCore::new().await;
    let id = tc.open(repo).await.repo.id;
    (tc, id)
}

async fn diff(tc: &TestCore, id: &str, path: &str, staged: bool) -> TextDiff {
    let source = if staged { DiffSource::Staged } else { DiffSource::Unstaged };
    match diff_file(tc, id.to_string(), path.to_string(), source, Some(true), None, None).await.unwrap() {
        FileDiff::Text(text) => text,
        other => panic!("expected a text diff, got: {other:?}"),
    }
}

/// Selection of single lines by sign and text, e.g. `("+", "neu")`.
fn pick(diff: &TextDiff, wanted: &[(&str, &str)]) -> PatchSelection {
    let mut hunks: Vec<HunkSelection> = Vec::new();
    for (sign, text) in wanted {
        let kind = if *sign == "+" { DiffLineKind::Add } else { DiffLineKind::Remove };
        let found = diff.hunks.iter().find_map(|h| h.lines.iter().position(|l| l.kind == kind && l.text == *text).map(|p| (h.index, p as u32)));
        let (hunk, pos) = found.unwrap_or_else(|| panic!("line {sign}{text} missing in {:#?}", diff.hunks));
        match hunks.iter_mut().find(|h| h.index == hunk) {
            Some(sel) => sel.lines.get_or_insert_with(Vec::new).push(pos),
            None => hunks.push(HunkSelection { index: hunk, lines: Some(vec![pos]) }),
        }
    }
    PatchSelection { path: diff.path.clone(), hunks, expect: diff.token.clone().expect("token missing") }
}

/// Raw bytes of a blob, e.g. `":a.txt"` (index) or `"stash@{0}:a.txt"`.
fn blob(repo: &TestRepo, spec: &str) -> Vec<u8> {
    let out = repo.git_output(&["cat-file", "blob", spec]);
    assert!(out.status.success(), "cat-file {spec}: {}", String::from_utf8_lossy(&out.stderr));
    out.stdout
}

fn selection(repo: &TestRepo, staged: Vec<PatchSelection>, unstaged: Vec<PatchSelection>) -> StashSelection {
    StashSelection { expect_head: repo.head(), staged, unstaged }
}

async fn stash_lines(tc: &TestCore, id: &str, selection: StashSelection) -> CoreResult<Vec<Stash>> {
    stash_create_with(tc, id.to_string(), util::new_id(), Some("Teil".into()), None, true, None, Some(selection)).await
}

/// The file in the newest stash: (worktree commit, index commit).
fn stashed(repo: &TestRepo, path: &str) -> (Vec<u8>, Vec<u8>) {
    (blob(repo, &format!("stash@{{0}}:{path}")), blob(repo, &format!("stash@{{0}}^2:{path}")))
}

#[tokio::test]
async fn unstaged_lines_go_into_the_stash_and_the_rest_stays() {
    let repo = TestRepo::new();
    repo.commit_file("f.txt", "eins\nzwei\ndrei\nvier\nfünf\nsechs\nsieben\nacht\n", "Basis");
    repo.write_file("f.txt", "EINS\nzwei\ndrei\nvier\nfünf\nsechs\nsieben\nACHT\n");
    let (tc, id) = open(&repo).await;
    let unstaged = diff(&tc, &id, "f.txt", false).await;

    let stashes = stash_lines(&tc, &id, selection(&repo, vec![], vec![pick(&unstaged, &[("-", "eins"), ("+", "EINS")])])).await.unwrap();
    assert_eq!((stashes.len(), stashes[0].message.as_str()), (1, "Teil"));
    assert_eq!(repo.read_file("f.txt"), "eins\nzwei\ndrei\nvier\nfünf\nsechs\nsieben\nACHT\n".as_bytes());
    let (work, index) = stashed(&repo, "f.txt");
    assert_eq!(work, "EINS\nzwei\ndrei\nvier\nfünf\nsechs\nsieben\nacht\n".as_bytes());
    assert_eq!(index, blob(&repo, "HEAD:f.txt"), "nothing staged went into the stash");
    assert_eq!(blob(&repo, ":f.txt"), blob(&repo, "HEAD:f.txt"), "the index stays");
}

#[tokio::test]
async fn staged_lines_leave_index_and_working_directory() {
    let repo = TestRepo::new();
    repo.commit_file("f.txt", "a\nb\nc\nd\ne\nf\ng\nh\n", "Basis");
    repo.write_file("f.txt", "A\nb\nc\nd\ne\nf\ng\nH\n");
    repo.git(&["add", "f.txt"]);
    let (tc, id) = open(&repo).await;
    let staged = diff(&tc, &id, "f.txt", true).await;

    stash_lines(&tc, &id, selection(&repo, vec![pick(&staged, &[("-", "a"), ("+", "A")])], vec![])).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), b"a\nb\nc\nd\ne\nf\ng\nH\n");
    assert_eq!(repo.read_file("f.txt"), b"a\nb\nc\nd\ne\nf\ng\nH\n");
    let (work, index) = stashed(&repo, "f.txt");
    assert_eq!(index, b"A\nb\nc\nd\ne\nf\ng\nh\n");
    assert_eq!(work, b"A\nb\nc\nd\ne\nf\ng\nh\n");
}

#[tokio::test]
async fn mixed_selection_over_two_files_keeps_everything_else() {
    let repo = TestRepo::new();
    repo.commit_file("a.txt", "1\n2\n3\n4\n5\n6\n7\n8\n", "a");
    repo.commit_file("b.txt", "x\ny\n", "b");
    repo.write_file("a.txt", "EINS\n2\n3\n4\n5\n6\n7\n8\n");
    repo.git(&["add", "a.txt"]);
    repo.write_file("a.txt", "EINS\n2\n3\n4\n5\n6\n7\nACHT\n");
    repo.write_file("b.txt", "x\nY\nz\n");
    let (tc, id) = open(&repo).await;
    let staged_a = diff(&tc, &id, "a.txt", true).await;
    let unstaged_b = diff(&tc, &id, "b.txt", false).await;

    let picked = selection(&repo, vec![pick(&staged_a, &[("-", "1"), ("+", "EINS")])], vec![pick(&unstaged_b, &[("-", "y"), ("+", "Y")])]);
    stash_lines(&tc, &id, picked).await.unwrap();
    // Left behind: the unselected unstaged line of a.txt and the new last line of b.txt.
    assert_eq!(blob(&repo, ":a.txt"), b"1\n2\n3\n4\n5\n6\n7\n8\n");
    assert_eq!(repo.read_file("a.txt"), b"1\n2\n3\n4\n5\n6\n7\nACHT\n");
    assert_eq!(repo.read_file("b.txt"), b"x\ny\nz\n");
    // In the stash: exactly the selection.
    assert_eq!(stashed(&repo, "a.txt"), (b"EINS\n2\n3\n4\n5\n6\n7\n8\n".to_vec(), b"EINS\n2\n3\n4\n5\n6\n7\n8\n".to_vec()));
    assert_eq!(stashed(&repo, "b.txt"), (b"x\nY\n".to_vec(), b"x\ny\n".to_vec()));
}

#[tokio::test]
async fn crlf_without_final_newline_and_latin1_stay_byte_exact() {
    let repo = TestRepo::new();
    repo.commit_file("crlf.txt", "a\r\nb\r\nc\r\nd\r\ne\r\nf", "CRLF");
    repo.commit_file("alt.txt", b"Gr\xfc\xdfe\nzwei\n", "Latin-1");
    repo.write_file("crlf.txt", "a\r\nB\r\nc\r\nd\r\ne\r\nf\r\ng");
    repo.write_file("alt.txt", b"Gr\xfc\xdfe\nZWEI \xe4\ndrei \xf6\n");
    let (tc, id) = open(&repo).await;
    let crlf = diff(&tc, &id, "crlf.txt", false).await;
    let latin = diff(&tc, &id, "alt.txt", false).await;

    let picked = selection(&repo, vec![], vec![pick(&crlf, &[("-", "b"), ("+", "B")]), pick(&latin, &[("+", "drei ö")])]);
    stash_lines(&tc, &id, picked).await.unwrap();
    assert_eq!(repo.read_file("crlf.txt"), b"a\r\nb\r\nc\r\nd\r\ne\r\nf\r\ng");
    assert_eq!(repo.read_file("alt.txt"), b"Gr\xfc\xdfe\nZWEI \xe4\n");
    assert_eq!(stashed(&repo, "crlf.txt").0, b"a\r\nB\r\nc\r\nd\r\ne\r\nf");
    assert_eq!(stashed(&repo, "alt.txt").0, b"Gr\xfc\xdfe\nzwei\ndrei \xf6\n");
}

#[tokio::test]
async fn a_failure_while_taking_the_selection_out_restores_everything() {
    let repo = TestRepo::new();
    repo.commit_file("a.txt", "1\n2\n3\n4\n5\n6\n7\n8\n", "a");
    repo.commit_file("b.txt", "x\ny\n", "b");
    repo.write_file("a.txt", "EINS\n2\n3\n4\n5\n6\n7\n8\n");
    repo.git(&["add", "a.txt"]);
    repo.write_file("b.txt", "x\nY\nz\n");
    let (tc, id) = open(&repo).await;
    let staged_a = diff(&tc, &id, "a.txt", true).await;
    let unstaged_b = diff(&tc, &id, "b.txt", false).await;
    let index_a = blob(&repo, ":a.txt");
    // b.txt is taken out first, then the injected failure hits.
    tc.state::<partial::FailRemoval>().0.store(true, Ordering::SeqCst);

    let picked = selection(&repo, vec![pick(&staged_a, &[("-", "1"), ("+", "EINS")])], vec![pick(&unstaged_b, &[("-", "y"), ("+", "Y")])]);
    let err = stash_lines(&tc, &id, picked).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Io, "{err:?}");
    assert!(err.message.contains("Nothing was stashed"), "{}", err.message);
    assert_eq!(repo.read_file("b.txt"), b"x\nY\nz\n", "b.txt is back");
    assert_eq!(repo.read_file("a.txt"), b"EINS\n2\n3\n4\n5\n6\n7\n8\n");
    assert_eq!(blob(&repo, ":a.txt"), index_a, "the index is back");
    assert!(read_rows(&tc, &id).await.unwrap().is_empty(), "the stash was dropped again");
    assert!(crate::undo::next_undo(&tc, &id, "").unwrap().is_none(), "no undo entry");
    assert_eq!(repo.git(&["for-each-ref", "refs/forkyard/undo/"]), "", "no backup refs left");
}

#[tokio::test]
async fn stale_or_empty_selections_change_nothing_and_undo_redo_work() {
    let repo = TestRepo::new();
    repo.commit_file("f.txt", "a\nb\nc\nd\ne\nf\ng\nh\n", "Basis");
    repo.write_file("f.txt", "A\nb\nc\nd\ne\nf\ng\nH\n");
    let (tc, id) = open(&repo).await;
    let unstaged = diff(&tc, &id, "f.txt", false).await;
    let picked = selection(&repo, vec![], vec![pick(&unstaged, &[("-", "a"), ("+", "A")])]);

    let mut old_head = picked.clone();
    old_head.expect_head = "0".repeat(40);
    assert_eq!(stash_lines(&tc, &id, old_head).await.unwrap_err().code, ErrorCode::StaleState);
    assert_eq!(stash_lines(&tc, &id, selection(&repo, vec![], vec![])).await.unwrap_err().code, ErrorCode::NothingToCommit);
    let both = stash_create_with(&tc, id.clone(), util::new_id(), None, Some(vec!["f.txt".into()]), true, None, Some(picked.clone())).await;
    assert_eq!(both.unwrap_err().code, ErrorCode::NotAllowed);
    assert_eq!(repo.read_file("f.txt"), b"A\nb\nc\nd\ne\nf\ng\nH\n", "nothing happened yet");

    stash_lines(&tc, &id, picked.clone()).await.unwrap();
    assert_eq!(repo.read_file("f.txt"), b"a\nb\nc\nd\ne\nf\ng\nH\n");
    // The same selection again no longer fits the diff.
    assert_eq!(stash_lines(&tc, &id, picked).await.unwrap_err().code, ErrorCode::StaleState);
    assert_eq!(read_rows(&tc, &id).await.unwrap().len(), 1);

    undo(&tc, id.clone()).await.unwrap();
    assert_eq!(repo.read_file("f.txt"), b"A\nb\nc\nd\ne\nf\ng\nH\n");
    assert!(read_rows(&tc, &id).await.unwrap().is_empty(), "undo drops the stash");
    redo(&tc, id.clone()).await.unwrap();
    assert_eq!(repo.read_file("f.txt"), b"a\nb\nc\nd\ne\nf\ng\nH\n");
    assert_eq!(read_rows(&tc, &id).await.unwrap().len(), 1, "redo puts the same stash back");
    assert_eq!(blob(&repo, "stash@{0}:f.txt"), b"A\nb\nc\nd\ne\nf\ng\nh\n");
}
