//! Tests for staging, unstaging, discarding, ignoring and restoring –
//! all against real temp repositories.

use super::*;
use crate::commands::diff::diff_file;
use crate::error::ErrorCode;
use crate::events::names;
use crate::model::{DiffLineKind, DiffSource, FileDiff, FileStatus, Head, HunkSelection, TextDiff};
use crate::testkit::{TestCore, TestRepo};
use crate::undo;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn open(repo: &TestRepo) -> (TestCore, String) {
    let tc = TestCore::new().await;
    let id = tc.open(repo).await.repo.id;
    (tc, id)
}

async fn text_diff(tc: &TestCore, id: &str, path: &str, source: DiffSource) -> TextDiff {
    match diff_file(tc, id.to_string(), path.to_string(), source, Some(true), None, None).await.unwrap() {
        FileDiff::Text(text) => text,
        other => panic!("expected a text diff, got: {other:?}"),
    }
}

async fn unstaged(tc: &TestCore, id: &str, path: &str) -> TextDiff {
    text_diff(tc, id, path, DiffSource::Unstaged).await
}

async fn staged(tc: &TestCore, id: &str, path: &str) -> TextDiff {
    text_diff(tc, id, path, DiffSource::Staged).await
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

fn whole(diff: &TextDiff, indices: &[u32]) -> PatchSelection {
    PatchSelection {
        path: diff.path.clone(),
        hunks: indices.iter().map(|&index| HunkSelection { index, lines: None }).collect(),
        expect: diff.token.clone().expect("token missing"),
    }
}

fn all_hunks(diff: &TextDiff) -> PatchSelection {
    let indices: Vec<u32> = diff.hunks.iter().map(|h| h.index).collect();
    whole(diff, &indices)
}

/// Raw bytes of a blob, e.g. `":datei.txt"` (index) or `"HEAD:datei.txt"`.
fn blob(repo: &TestRepo, spec: &str) -> Vec<u8> {
    let out = repo.git_output(&["cat-file", "blob", spec]);
    assert!(out.status.success(), "cat-file {spec}: {}", String::from_utf8_lossy(&out.stderr));
    out.stdout
}

fn in_index(repo: &TestRepo, path: &str) -> bool {
    !repo.git(&["ls-files", "--", path]).is_empty()
}

/// Changed lines according to Git itself (`git diff -U0`), as `+text` / `-text`.
fn changes(repo: &TestRepo, cached: bool, path: &str) -> Vec<String> {
    let mut args = vec!["diff", "--no-color", "--no-ext-diff", "-U0"];
    if cached {
        args.push("--cached");
    }
    args.extend(["--", path]);
    let out = repo.git_output(&args);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout)
        .split('\n')
        .map(|l| l.trim_end_matches('\r'))
        .filter(|l| (l.starts_with('+') || l.starts_with('-')) && !l.starts_with("+++") && !l.starts_with("---"))
        .map(str::to_string)
        .collect()
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

fn code_of<T: std::fmt::Debug>(result: CoreResult<T>) -> ErrorCode {
    result.expect_err("Fehler erwartet").code
}

fn numbered(prefix: &str, count: usize) -> Vec<String> {
    (1..=count).map(|n| format!("{prefix}{n:02}")).collect()
}

fn join_lines(lines: &[String]) -> String {
    lines.iter().map(|l| format!("{l}\n")).collect()
}

// ---------------------------------------------------------------------------
// stage_paths / unstage_paths
// ---------------------------------------------------------------------------

#[tokio::test]
async fn stage_paths_modified_deleted_untracked() {
    let repo = TestRepo::new();
    repo.write_file("geändert.txt", "a\n");
    repo.write_file("gelöscht.txt", "b\n");
    repo.write_file("bleibt.txt", "c\n");
    repo.commit("Basis");
    repo.write_file("geändert.txt", "a\nneu\n");
    repo.remove_file("gelöscht.txt");
    repo.write_file("mit leer zeichen.txt", "x\n");
    repo.write_file("bleibt.txt", "c\nnicht stagen\n");
    let (tc, id) = open(&repo).await;
    tc.events.clear();

    let status = stage_paths(&tc, id.clone(), Some(strings(&["geändert.txt", "gelöscht.txt", "mit leer zeichen.txt"]))).await.unwrap();
    let staged: Vec<(&str, FileStatus)> = status.staged.iter().map(|f| (f.path.as_str(), f.status)).collect();
    assert_eq!(
        staged,
        vec![("gelöscht.txt", FileStatus::Deleted), ("geändert.txt", FileStatus::Modified), ("mit leer zeichen.txt", FileStatus::Added)]
    );
    assert_eq!(status.unstaged.len(), 1);
    assert_eq!(status.unstaged[0].path, "bleibt.txt");
    assert_eq!(blob(&repo, ":geändert.txt"), b"a\nneu\n");
    let events = tc.events.named(names::REPO_CHANGED);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["what"], serde_json::json!(["index"]));

    // Stage everything.
    let status = stage_paths(&tc, id, None).await.unwrap();
    assert!(status.unstaged.is_empty());
    assert_eq!(status.staged.len(), 4);
}

#[tokio::test]
async fn stage_paths_takes_names_literally() {
    let repo = TestRepo::with_commit();
    repo.write_file("a[1].txt", "eins\n");
    repo.write_file("a1.txt", "zwei\n");
    let (tc, id) = open(&repo).await;
    let status = stage_paths(&tc, id, Some(strings(&["a[1].txt"]))).await.unwrap();
    let staged: Vec<&str> = status.staged.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(staged, vec!["a[1].txt"]);
}

#[tokio::test]
async fn stage_paths_missing_file_is_not_found() {
    let repo = TestRepo::with_commit();
    let (tc, id) = open(&repo).await;
    assert_eq!(code_of(stage_paths(&tc, id, Some(strings(&["gibt-es-nicht.txt"]))).await), ErrorCode::NotFound);
}

#[tokio::test]
async fn stage_paths_resolves_a_conflict() {
    let repo = TestRepo::with_commit();
    repo.checkout_new("feature");
    repo.commit_file("README.md", "# Feature\n", "Feature");
    repo.checkout("main");
    repo.commit_file("README.md", "# Main\n", "Main");
    assert!(!repo.merge("feature"));
    let (tc, id) = open(&repo).await;
    let before = crate::commands::status::read_status(&tc, &id).await.unwrap();
    assert_eq!(before.conflicted.len(), 1);

    repo.write_file("README.md", "# Beides\n");
    let status = stage_paths(&tc, id, Some(strings(&["README.md"]))).await.unwrap();
    assert!(status.conflicted.is_empty());
    assert_eq!(status.staged.len(), 1);
    assert!(status.operation.is_some(), "the merge is still running");
    assert_eq!(blob(&repo, ":README.md"), b"# Beides\n");
}

#[tokio::test]
async fn stage_and_unstage_in_an_empty_repo() {
    let repo = TestRepo::new();
    repo.write_file("eins.txt", "1\n");
    repo.write_file("zwei.txt", "2\n");
    let (tc, id) = open(&repo).await;

    let status = stage_paths(&tc, id.clone(), None).await.unwrap();
    assert!(matches!(status.head, Head::Unborn { .. }));
    assert_eq!(status.staged.len(), 2);

    let status = unstage_paths(&tc, id.clone(), Some(strings(&["eins.txt"]))).await.unwrap();
    assert_eq!(status.staged.len(), 1);
    assert_eq!(status.staged[0].path, "zwei.txt");
    assert!(repo.path().join("eins.txt").exists());

    let status = unstage_paths(&tc, id.clone(), None).await.unwrap();
    assert!(status.staged.is_empty());
    assert_eq!(status.unstaged.len(), 2);
    // Nothing staged any more: no error.
    let status = unstage_paths(&tc, id, None).await.unwrap();
    assert!(status.staged.is_empty());
}

#[tokio::test]
async fn unstage_paths_with_head() {
    let repo = TestRepo::new();
    repo.write_file("a.txt", "a\n");
    repo.write_file("b.txt", "b\n");
    repo.commit("Basis");
    repo.write_file("a.txt", "A\n");
    repo.remove_file("b.txt");
    repo.write_file("neu.txt", "n\n");
    repo.git(&["add", "-A"]);
    let (tc, id) = open(&repo).await;

    let status = unstage_paths(&tc, id.clone(), Some(strings(&["a.txt", "neu.txt"]))).await.unwrap();
    let staged: Vec<&str> = status.staged.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(staged, vec!["b.txt"]);
    assert_eq!(blob(&repo, ":a.txt"), b"a\n");
    assert_eq!(repo.read_file("a.txt"), b"A\n", "the working directory stays");
    assert!(!in_index(&repo, "neu.txt"));
    assert!(repo.path().join("neu.txt").exists());

    let status = unstage_paths(&tc, id, None).await.unwrap();
    assert!(status.staged.is_empty());
    assert!(in_index(&repo, "b.txt"));
}

#[tokio::test]
async fn unstage_paths_takes_both_sides_of_a_rename() {
    let repo = TestRepo::new();
    repo.write_file("alt.txt", join_lines(&numbered("zeile", 10)));
    repo.commit("Basis");
    repo.git(&["mv", "alt.txt", "neu.txt"]);
    let (tc, id) = open(&repo).await;
    let before = crate::commands::status::read_status(&tc, &id).await.unwrap();
    assert_eq!(before.staged[0].status, FileStatus::Renamed);

    let status = unstage_paths(&tc, id, Some(strings(&["neu.txt"]))).await.unwrap();
    assert!(status.staged.is_empty(), "{:?}", status.staged);
    assert!(in_index(&repo, "alt.txt"));
    assert!(!in_index(&repo, "neu.txt"));
    assert!(repo.path().join("neu.txt").exists());
}

#[tokio::test]
async fn unstage_all_keeps_conflicts() {
    let repo = TestRepo::with_commit();
    repo.write_file("frei.txt", "x\n");
    repo.commit("frei");
    repo.checkout_new("feature");
    repo.commit_file("README.md", "# Feature\n", "Feature");
    repo.checkout("main");
    repo.commit_file("README.md", "# Main\n", "Main");
    assert!(!repo.merge("feature"));
    repo.write_file("frei.txt", "x\ny\n");
    repo.git(&["add", "frei.txt"]);
    let (tc, id) = open(&repo).await;

    let status = unstage_paths(&tc, id.clone(), None).await.unwrap();
    assert!(status.staged.is_empty());
    assert_eq!(status.conflicted.len(), 1, "the conflict is preserved");
    assert!(status.operation.is_some());
    assert_eq!(code_of(unstage_paths(&tc, id, Some(strings(&["README.md"]))).await), ErrorCode::Conflict);
}

#[tokio::test]
async fn foreign_index_lock_is_reported_and_kept() {
    let repo = TestRepo::with_commit();
    repo.write_file("README.md", "# Test\nmehr\n");
    let (tc, id) = open(&repo).await;
    let diff = unstaged(&tc, &id, "README.md").await;
    let lock = repo.path().join(".git").join("index.lock");
    std::fs::write(&lock, "").unwrap();

    assert_eq!(code_of(stage_paths(&tc, id.clone(), None).await), ErrorCode::Locked);
    assert_eq!(code_of(stage_patch(&tc, id.clone(), all_hunks(&diff)).await), ErrorCode::Locked);
    assert_eq!(code_of(discard_paths(&tc, id.clone(), None).await), ErrorCode::Locked);
    assert!(lock.exists(), "a foreign lock is never deleted");
    assert_eq!(repo.read_file("README.md"), b"# Test\nmehr\n", "nothing discarded");
    assert!(undo::next_undo(&tc, &id, "").unwrap().is_none());

    std::fs::remove_file(&lock).unwrap();
    assert_eq!(stage_paths(&tc, id, None).await.unwrap().staged.len(), 1);
}

#[tokio::test]
async fn stage_paths_on_detached_head() {
    let repo = TestRepo::with_commit();
    repo.git(&["checkout", "-q", "--detach"]);
    repo.write_file("README.md", "# Anders\n");
    let (tc, id) = open(&repo).await;
    let status = stage_paths(&tc, id.clone(), None).await.unwrap();
    assert!(matches!(status.head, Head::Detached { .. }));
    assert_eq!(status.staged.len(), 1);
    assert!(unstage_paths(&tc, id, None).await.unwrap().staged.is_empty());
}

// ---------------------------------------------------------------------------
// stage_patch
// ---------------------------------------------------------------------------

#[tokio::test]
async fn stage_whole_hunks_of_several() {
    let repo = TestRepo::new();
    let base = numbered("zeile", 30);
    repo.write_file("f.txt", join_lines(&base));
    repo.commit("Basis");
    let mut work = base.clone();
    work[1] = "ZWEI neu".into();
    work[14] = "FÜNFZEHN neu".into();
    work.remove(28);
    let work_text = join_lines(&work);
    repo.write_file("f.txt", &work_text);
    let (tc, id) = open(&repo).await;
    let diff = unstaged(&tc, &id, "f.txt").await;
    assert_eq!(diff.hunks.len(), 3);
    tc.events.clear();

    let status = stage_patch(&tc, id.clone(), whole(&diff, &[0, 2])).await.unwrap();

    let mut expected = base.clone();
    expected[1] = "ZWEI neu".into();
    expected.remove(28);
    assert_eq!(blob(&repo, ":f.txt"), join_lines(&expected).into_bytes());
    assert_eq!(changes(&repo, true, "f.txt"), strings(&["-zeile02", "+ZWEI neu", "-zeile29"]));
    assert_eq!(changes(&repo, false, "f.txt"), strings(&["-zeile15", "+FÜNFZEHN neu"]));
    assert_eq!(repo.read_file("f.txt"), work_text.as_bytes());
    assert_eq!(status.staged.len(), 1);
    assert_eq!(status.unstaged.len(), 1);
    let events = tc.events.named(names::REPO_CHANGED);
    assert_eq!(events.len(), 1);
    assert_eq!(events[0]["what"], serde_json::json!(["index"]));
}

#[tokio::test]
async fn stage_single_lines_inside_one_hunk() {
    let repo = TestRepo::new();
    repo.commit_file("f.txt", "a\nb\nc\nd\ne\n", "Basis");
    repo.write_file("f.txt", "a\nB1\nB2\nc\nD\ne\nf\n");
    let (tc, id) = open(&repo).await;
    let diff = unstaged(&tc, &id, "f.txt").await;
    assert_eq!(diff.hunks.len(), 1);

    stage_patch(&tc, id.clone(), pick(&diff, &[("+", "B2"), ("-", "d"), ("+", "f")])).await.unwrap();

    assert_eq!(blob(&repo, ":f.txt"), b"a\nb\nB2\nc\ne\nf\n");
    assert_eq!(changes(&repo, true, "f.txt"), strings(&["+B2", "-d", "+f"]));
    assert_eq!(changes(&repo, false, "f.txt"), strings(&["-b", "+B1", "+D"]));
    assert_eq!(repo.read_file("f.txt"), b"a\nB1\nB2\nc\nD\ne\nf\n");

    // The rest can then be staged line by line as well.
    let rest = unstaged(&tc, &id, "f.txt").await;
    stage_patch(&tc, id.clone(), all_hunks(&rest)).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), b"a\nB1\nB2\nc\nD\ne\nf\n");
    assert!(changes(&repo, false, "f.txt").is_empty());
}

#[tokio::test]
async fn stage_lines_in_several_hunks_with_shifted_positions() {
    let repo = TestRepo::new();
    let base = numbered("z", 40);
    repo.write_file("f.txt", join_lines(&base));
    repo.commit("Basis");
    let mut work = base.clone();
    // Hunk 1: two new lines after z03; hunk 2: z20 replaced; hunk 3: z38 deleted, new line at the end.
    work.splice(3..3, ["neu-a".to_string(), "neu-b".to_string()]);
    work[21] = "ZWANZIG".into();
    work.remove(39);
    work.push("ende".into());
    repo.write_file("f.txt", join_lines(&work));
    let (tc, id) = open(&repo).await;
    let diff = unstaged(&tc, &id, "f.txt").await;
    assert_eq!(diff.hunks.len(), 3);

    stage_patch(&tc, id.clone(), pick(&diff, &[("+", "neu-b"), ("+", "ZWANZIG"), ("-", "z38")])).await.unwrap();

    let mut expected = base.clone();
    expected.splice(3..3, ["neu-b".to_string()]);
    // z20 stays, ZWANZIG comes after it.
    expected.splice(21..21, ["ZWANZIG".to_string()]);
    let pos = expected.iter().position(|l| l == "z38").unwrap();
    expected.remove(pos);
    assert_eq!(blob(&repo, ":f.txt"), join_lines(&expected).into_bytes());
    assert_eq!(changes(&repo, true, "f.txt"), strings(&["+neu-b", "+ZWANZIG", "-z38"]));
    assert_eq!(changes(&repo, false, "f.txt"), strings(&["+neu-a", "-z20", "+ende"]));
}

#[tokio::test]
async fn stage_first_and_last_line() {
    let repo = TestRepo::new();
    repo.commit_file("f.txt", "eins\nzwei\ndrei\n", "Basis");
    repo.write_file("f.txt", "EINS\nzwei\ndrei\nvier\n");
    let (tc, id) = open(&repo).await;
    let diff = unstaged(&tc, &id, "f.txt").await;
    stage_patch(&tc, id.clone(), pick(&diff, &[("-", "eins"), ("+", "EINS")])).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), b"EINS\nzwei\ndrei\n");
    let diff = unstaged(&tc, &id, "f.txt").await;
    stage_patch(&tc, id.clone(), pick(&diff, &[("+", "vier")])).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), b"EINS\nzwei\ndrei\nvier\n");

    // Delete the first and last line, one at a time.
    repo.commit("Zwischenstand");
    repo.write_file("f.txt", "zwei\ndrei\n");
    let diff = unstaged(&tc, &id, "f.txt").await;
    stage_patch(&tc, id.clone(), pick(&diff, &[("-", "vier")])).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), b"EINS\nzwei\ndrei\n");
    let diff = unstaged(&tc, &id, "f.txt").await;
    stage_patch(&tc, id.clone(), pick(&diff, &[("-", "EINS")])).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), b"zwei\ndrei\n");
}

#[tokio::test]
async fn stage_lines_of_a_crlf_file() {
    let repo = TestRepo::new();
    repo.commit_file("f.txt", "a\r\nb\r\nc\r\n", "Basis");
    assert_eq!(blob(&repo, "HEAD:f.txt"), b"a\r\nb\r\nc\r\n");
    repo.write_file("f.txt", "a\r\nB\r\nc\r\nd\r\n");
    let (tc, id) = open(&repo).await;
    let diff = unstaged(&tc, &id, "f.txt").await;
    assert!(diff.hunks[0].lines.iter().all(|l| !l.text.contains('\r')), "{:?}", diff.hunks[0].lines);

    stage_patch(&tc, id.clone(), pick(&diff, &[("+", "d")])).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), b"a\r\nb\r\nc\r\nd\r\n");
    assert_eq!(changes(&repo, true, "f.txt"), strings(&["+d"]));
    assert_eq!(changes(&repo, false, "f.txt"), strings(&["-b", "+B"]));
}

#[tokio::test]
async fn stage_lines_with_autocrlf_true() {
    let repo = TestRepo::new();
    repo.git(&["config", "core.autocrlf", "true"]);
    repo.commit_file("f.txt", "a\r\nb\r\nc\r\n", "Basis");
    assert_eq!(blob(&repo, "HEAD:f.txt"), b"a\nb\nc\n", "Git stores LF");
    let work = b"a\r\nB\r\nc\r\nd\r\n";
    repo.write_file("f.txt", work);
    let (tc, id) = open(&repo).await;
    let diff = unstaged(&tc, &id, "f.txt").await;

    stage_patch(&tc, id.clone(), pick(&diff, &[("-", "b"), ("+", "B")])).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), b"a\nB\nc\n");
    assert_eq!(repo.read_file("f.txt"), work);
    assert_eq!(changes(&repo, false, "f.txt"), strings(&["+d"]));

    let rest = unstaged(&tc, &id, "f.txt").await;
    let status = stage_patch(&tc, id.clone(), all_hunks(&rest)).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), b"a\nB\nc\nd\n");
    assert!(status.unstaged.is_empty(), "{:?}", status.unstaged);
    assert_eq!(repo.read_file("f.txt"), work);
}

#[tokio::test]
async fn stage_lines_with_autocrlf_input() {
    let repo = TestRepo::new();
    repo.git(&["config", "core.autocrlf", "input"]);
    repo.commit_file("f.txt", "a\nb\nc\n", "Basis");
    // The editor wrote CRLF; in the diff only the real change counts.
    repo.write_file("f.txt", "a\r\nB\r\nc\r\nd\r\n");
    let (tc, id) = open(&repo).await;
    let diff = unstaged(&tc, &id, "f.txt").await;
    let changed: Vec<&str> = diff.hunks.iter().flat_map(|h| &h.lines).filter(|l| l.kind != DiffLineKind::Context).map(|l| l.text.as_str()).collect();
    assert_eq!(changed, vec!["b", "B", "d"]);

    stage_patch(&tc, id.clone(), pick(&diff, &[("+", "d")])).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), b"a\nb\nc\nd\n");
    assert_eq!(changes(&repo, false, "f.txt"), strings(&["-b", "+B"]));
}

#[tokio::test]
async fn stage_lines_with_mixed_line_endings() {
    let repo = TestRepo::new();
    repo.commit_file("f.txt", "a\r\nb\nc\r\nd\n", "Basis");
    repo.write_file("f.txt", "a\r\nB\nc\r\nD\r\ne\n");
    let (tc, id) = open(&repo).await;
    let diff = unstaged(&tc, &id, "f.txt").await;

    stage_patch(&tc, id.clone(), pick(&diff, &[("-", "d"), ("+", "D")])).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), b"a\r\nb\nc\r\nD\r\n");
    let rest = unstaged(&tc, &id, "f.txt").await;
    stage_patch(&tc, id.clone(), all_hunks(&rest)).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), b"a\r\nB\nc\r\nD\r\ne\n");
}

#[tokio::test]
async fn stage_when_the_old_side_has_no_final_newline() {
    // Old version without a newline at the end, new one with.
    let repo = TestRepo::new();
    repo.commit_file("f.txt", "a\nb", "Basis");
    repo.write_file("f.txt", "a\nb\nc\n");
    let (tc, id) = open(&repo).await;
    let diff = unstaged(&tc, &id, "f.txt").await;
    let flags: Vec<(DiffLineKind, &str, bool)> = diff.hunks[0].lines.iter().map(|l| (l.kind, l.text.as_str(), l.no_newline)).collect();
    assert_eq!(
        flags,
        vec![
            (DiffLineKind::Context, "a", false),
            (DiffLineKind::Remove, "b", true),
            (DiffLineKind::Add, "b", false),
            (DiffLineKind::Add, "c", false),
        ]
    );

    // Only the new line: the line before gets its newline, otherwise both would stick together.
    stage_patch(&tc, id.clone(), pick(&diff, &[("+", "c")])).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), b"a\nb\nc\n");
    assert!(changes(&repo, false, "f.txt").is_empty());

    // Only the newline (the pair −b/+b).
    repo.git(&["reset", "-q"]);
    let diff = unstaged(&tc, &id, "f.txt").await;
    stage_patch(&tc, id.clone(), pick(&diff, &[("-", "b"), ("+", "b")])).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), b"a\nb\n");
    assert_eq!(changes(&repo, false, "f.txt"), strings(&["+c"]));
}

/// Discarding lines at a missing final newline keeps the order of the lines and adds no newline.
#[tokio::test]
async fn discard_lines_at_a_missing_final_newline_keeps_the_order() {
    let repo = TestRepo::new();
    repo.commit_file("f.txt", "alpha\nbeta\ngamma", "Basis");
    repo.write_file("f.txt", "alpha\nBETA\ngamma\ndelta");
    let (tc, id) = open(&repo).await;
    let diff = unstaged(&tc, &id, "f.txt").await;
    discard_patch(&tc, id.clone(), pick(&diff, &[("-", "gamma"), ("+", "gamma"), ("+", "delta")])).await.unwrap();
    assert_eq!(repo.read_file("f.txt"), b"alpha\nBETA\ngamma");

    // Without a line of the same content: the restored last line still stays last.
    repo.write_file("f.txt", "alpha\nBETA\nGAMMA\ndelta");
    let diff = unstaged(&tc, &id, "f.txt").await;
    discard_patch(&tc, id.clone(), pick(&diff, &[("-", "gamma"), ("+", "GAMMA"), ("+", "delta")])).await.unwrap();
    assert_eq!(repo.read_file("f.txt"), b"alpha\nBETA\ngamma");
}

#[tokio::test]
async fn stage_when_the_new_side_has_no_final_newline() {
    let repo = TestRepo::new();
    repo.commit_file("f.txt", "a\nb\n", "Basis");
    repo.write_file("f.txt", "a\nb\nc");
    let (tc, id) = open(&repo).await;
    let diff = unstaged(&tc, &id, "f.txt").await;
    assert!(diff.hunks[0].lines.last().unwrap().no_newline);
    stage_patch(&tc, id.clone(), pick(&diff, &[("+", "c")])).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), b"a\nb\nc");

    // Last line replaced, the new one without a newline.
    repo.commit("Zwischenstand");
    repo.write_file("f.txt", "a\nb\nC");
    let diff = unstaged(&tc, &id, "f.txt").await;
    stage_patch(&tc, id.clone(), pick(&diff, &[("-", "c")])).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), b"a\nb\n");
    let diff = unstaged(&tc, &id, "f.txt").await;
    stage_patch(&tc, id.clone(), pick(&diff, &[("+", "C")])).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), b"a\nb\nC");
}

#[tokio::test]
async fn stage_when_both_sides_have_no_final_newline() {
    let repo = TestRepo::new();
    repo.commit_file("f.txt", "a\nb\nc", "Basis");
    repo.write_file("f.txt", "a\nB\nc");
    let (tc, id) = open(&repo).await;
    let diff = unstaged(&tc, &id, "f.txt").await;
    let last = diff.hunks[0].lines.last().unwrap();
    assert!(last.kind == DiffLineKind::Context && last.no_newline);
    stage_patch(&tc, id.clone(), pick(&diff, &[("-", "b"), ("+", "B")])).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), b"a\nB\nc");

    // Append a line after a last line without a newline, again without a newline.
    repo.commit("Zwischenstand");
    repo.write_file("f.txt", "a\nB\nc\nd");
    let diff = unstaged(&tc, &id, "f.txt").await;
    stage_patch(&tc, id.clone(), pick(&diff, &[("+", "d")])).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), b"a\nB\nc\nd");
    assert!(changes(&repo, false, "f.txt").is_empty());
}

#[tokio::test]
async fn crlf_file_without_final_newline_keeps_its_line_endings() {
    let repo = TestRepo::new();
    repo.commit_file("f.txt", "a\r\nb", "Basis");
    repo.write_file("f.txt", "a\r\nb\r\nc\r\n");
    let (tc, id) = open(&repo).await;
    let diff = unstaged(&tc, &id, "f.txt").await;
    stage_patch(&tc, id.clone(), pick(&diff, &[("+", "c")])).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), b"a\r\nb\r\nc\r\n");
}

#[tokio::test]
async fn stage_lines_of_an_untracked_file() {
    let repo = TestRepo::with_commit();
    repo.write_file("neu.txt", "eins\nzwei\ndrei\n");
    let (tc, id) = open(&repo).await;
    let diff = unstaged(&tc, &id, "neu.txt").await;
    assert_eq!(diff.status, FileStatus::Untracked);
    assert_eq!(diff.hunks[0].lines.len(), 3);

    let status = stage_patch(&tc, id.clone(), pick(&diff, &[("+", "zwei")])).await.unwrap();
    assert_eq!(blob(&repo, ":neu.txt"), b"zwei\n");
    assert_eq!(changes(&repo, true, "neu.txt"), strings(&["+zwei"]));
    assert_eq!(changes(&repo, false, "neu.txt"), strings(&["+eins", "+drei"]));
    assert_eq!(repo.read_file("neu.txt"), b"eins\nzwei\ndrei\n");
    assert_eq!(status.staged[0].status, FileStatus::Added);

    let rest = unstaged(&tc, &id, "neu.txt").await;
    assert_eq!(rest.status, FileStatus::Modified);
    stage_patch(&tc, id.clone(), all_hunks(&rest)).await.unwrap();
    assert_eq!(blob(&repo, ":neu.txt"), b"eins\nzwei\ndrei\n");
}

#[tokio::test]
async fn stage_whole_untracked_file_in_an_empty_repo() {
    let repo = TestRepo::new();
    repo.subdir("ordner");
    repo.write_file("ordner/neu.txt", "eins\nzwei");
    let (tc, id) = open(&repo).await;
    let diff = unstaged(&tc, &id, "ordner/neu.txt").await;
    let status = stage_patch(&tc, id.clone(), all_hunks(&diff)).await.unwrap();
    assert!(matches!(status.head, Head::Unborn { .. }));
    assert_eq!(blob(&repo, ":ordner/neu.txt"), b"eins\nzwei");
    assert!(status.unstaged.is_empty());
}

#[tokio::test]
async fn stage_lines_of_an_untracked_crlf_file_with_autocrlf() {
    let repo = TestRepo::with_commit();
    repo.git(&["config", "core.autocrlf", "true"]);
    repo.write_file("neu.txt", "eins\r\nzwei\r\ndrei\r\n");
    let (tc, id) = open(&repo).await;
    let diff = unstaged(&tc, &id, "neu.txt").await;
    stage_patch(&tc, id.clone(), pick(&diff, &[("+", "eins"), ("+", "drei")])).await.unwrap();
    assert_eq!(blob(&repo, ":neu.txt"), b"eins\ndrei\n", "as with git add: LF in the index");
    let rest = unstaged(&tc, &id, "neu.txt").await;
    let status = stage_patch(&tc, id.clone(), all_hunks(&rest)).await.unwrap();
    assert_eq!(blob(&repo, ":neu.txt"), b"eins\nzwei\ndrei\n");
    assert!(status.unstaged.is_empty());
}

#[tokio::test]
async fn stage_lines_of_an_intent_to_add_file() {
    let repo = TestRepo::with_commit();
    repo.write_file("neu.txt", "eins\nzwei\n");
    repo.git(&["add", "-N", "neu.txt"]);
    let (tc, id) = open(&repo).await;
    let diff = unstaged(&tc, &id, "neu.txt").await;
    stage_patch(&tc, id.clone(), pick(&diff, &[("+", "eins")])).await.unwrap();
    assert_eq!(blob(&repo, ":neu.txt"), b"eins\n");
    assert_eq!(changes(&repo, false, "neu.txt"), strings(&["+zwei"]));
}

#[tokio::test]
async fn stage_lines_of_a_deleted_file() {
    let repo = TestRepo::new();
    repo.commit_file("weg.txt", "eins\nzwei\ndrei\n", "Basis");
    repo.remove_file("weg.txt");
    let (tc, id) = open(&repo).await;
    let diff = unstaged(&tc, &id, "weg.txt").await;
    assert_eq!(diff.status, FileStatus::Deleted);

    stage_patch(&tc, id.clone(), pick(&diff, &[("-", "zwei")])).await.unwrap();
    assert_eq!(blob(&repo, ":weg.txt"), b"eins\ndrei\n");
    assert_eq!(changes(&repo, true, "weg.txt"), strings(&["-zwei"]));
    assert!(!repo.path().join("weg.txt").exists());

    // The rest: now the file disappears from the index.
    let rest = unstaged(&tc, &id, "weg.txt").await;
    let status = stage_patch(&tc, id.clone(), all_hunks(&rest)).await.unwrap();
    assert!(!in_index(&repo, "weg.txt"));
    assert_eq!(status.staged[0].status, FileStatus::Deleted);
    assert!(status.unstaged.is_empty());
}

#[tokio::test]
async fn latin1_bytes_reach_the_index_unchanged() {
    let repo = TestRepo::new();
    repo.commit_file("alt.txt", b"Gr\xfc\xdfe\nzwei\n", "Basis");
    repo.write_file("alt.txt", b"Gr\xfc\xdfe\nZWEI \xe4\ndrei \xf6\n");
    let (tc, id) = open(&repo).await;
    let diff = unstaged(&tc, &id, "alt.txt").await;
    assert_eq!(diff.encoding, "windows-1252");
    assert_eq!(diff.new_text.as_deref(), Some("Grüße\nZWEI ä\ndrei ö\n"));

    stage_patch(&tc, id.clone(), pick(&diff, &[("-", "zwei"), ("+", "ZWEI ä")])).await.unwrap();
    assert_eq!(blob(&repo, ":alt.txt"), b"Gr\xfc\xdfe\nZWEI \xe4\n");
    let rest = unstaged(&tc, &id, "alt.txt").await;
    stage_patch(&tc, id.clone(), pick(&rest, &[("+", "drei ö")])).await.unwrap();
    assert_eq!(blob(&repo, ":alt.txt"), b"Gr\xfc\xdfe\nZWEI \xe4\ndrei \xf6\n");
}

#[tokio::test]
async fn file_names_with_spaces_umlauts_and_quotes() {
    let repo = TestRepo::new();
    let names = ["mit leer zeichen.txt", "Übergröße/äöü ß.txt", "it's „zitat“ 'x'.txt", " führend.txt", "a b/c d/e f.txt"];
    for name in names {
        repo.write_file(name, "eins\nzwei\ndrei\n");
    }
    repo.commit("Basis");
    for name in names {
        repo.write_file(name, "eins\nZWEI\ndrei\nvier\n");
    }
    let (tc, id) = open(&repo).await;
    for name in names {
        let diff = unstaged(&tc, &id, name).await;
        stage_patch(&tc, id.clone(), pick(&diff, &[("+", "vier")])).await.unwrap_or_else(|e| panic!("{name}: {e:?}"));
        assert_eq!(blob(&repo, &format!(":{name}")), b"eins\nzwei\ndrei\nvier\n", "{name}");

        let diff = staged(&tc, &id, name).await;
        unstage_patch(&tc, id.clone(), all_hunks(&diff)).await.unwrap_or_else(|e| panic!("{name}: {e:?}"));
        assert_eq!(blob(&repo, &format!(":{name}")), b"eins\nzwei\ndrei\n", "{name}");

        let diff = unstaged(&tc, &id, name).await;
        discard_patch(&tc, id.clone(), pick(&diff, &[("-", "zwei"), ("+", "ZWEI")])).await.unwrap_or_else(|e| panic!("{name}: {e:?}"));
        assert_eq!(repo.read_file(name), b"eins\nzwei\ndrei\nvier\n", "{name}");
    }
}

/// Quotes and backslashes don't exist in file names on Windows, but they do
/// in the index – the patch against the index must quote the name correctly.
#[tokio::test]
async fn file_name_with_double_quote_in_the_index() {
    let repo = TestRepo::with_commit();
    // Git for Windows otherwise rejects such names already when adding them.
    repo.git(&["config", "core.protectNTFS", "false"]);
    repo.write_file("inhalt.txt", "eins\nzwei\ndrei\n");
    let sha = repo.git(&["hash-object", "-w", "inhalt.txt"]);
    repo.remove_file("inhalt.txt");
    let name = "sag \"hallo\".txt";
    let out = repo.git_output(&["update-index", "--add", "--cacheinfo", &format!("100644,{sha},{name}")]);
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let (tc, id) = open(&repo).await;

    let diff = staged(&tc, &id, name).await;
    assert_eq!(diff.status, FileStatus::Added);
    unstage_patch(&tc, id.clone(), pick(&diff, &[("+", "zwei")])).await.unwrap();
    let listing = repo.git_output(&["ls-files", "--stage", "-z"]);
    let entry = listing.stdout.split(|&b| b == 0).find(|e| e.ends_with(name.as_bytes())).expect("entry in the index");
    let blob_sha = String::from_utf8_lossy(&entry[7..47]).to_string();
    assert_eq!(blob(&repo, &blob_sha), b"eins\ndrei\n");
}

#[tokio::test]
async fn stale_selection_is_rejected() {
    let repo = TestRepo::new();
    repo.commit_file("f.txt", "a\nb\nc\n", "Basis");
    repo.write_file("f.txt", "a\nB\nc\n");
    let (tc, id) = open(&repo).await;
    let diff = unstaged(&tc, &id, "f.txt").await;

    // The file changes after the diff was shown.
    repo.write_file("f.txt", "a\nB\nc\nd\n");
    assert_eq!(code_of(stage_patch(&tc, id.clone(), all_hunks(&diff)).await), ErrorCode::StaleState);
    assert_eq!(blob(&repo, ":f.txt"), b"a\nb\nc\n");
    assert_eq!(code_of(discard_patch(&tc, id.clone(), all_hunks(&diff)).await), ErrorCode::StaleState);
    assert_eq!(repo.read_file("f.txt"), b"a\nB\nc\nd\n");
    assert!(undo::next_undo(&tc, &id, "").unwrap().is_none());

    // The index changes after the diff was shown.
    let diff = unstaged(&tc, &id, "f.txt").await;
    repo.git(&["add", "f.txt"]);
    assert_eq!(code_of(stage_patch(&tc, id.clone(), all_hunks(&diff)).await), ErrorCode::StaleState);

    // A token of the other diff never fits.
    let staged_diff = staged(&tc, &id, "f.txt").await;
    assert_eq!(code_of(stage_patch(&tc, id.clone(), all_hunks(&staged_diff)).await), ErrorCode::StaleState);
    repo.commit("mehr");
    assert_eq!(code_of(unstage_patch(&tc, id.clone(), all_hunks(&staged_diff)).await), ErrorCode::StaleState);
}

/// If a patch does not apply despite the token (the file changes exactly between checking and
/// applying), Git reports it – the error is then `stale_state` as well.
#[tokio::test]
async fn a_patch_that_does_not_apply_is_stale_state() {
    let repo = TestRepo::with_commit();
    let (tc, id) = open(&repo).await;
    let wrong_content = b"diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,1 +1,1 @@\n-steht dort nicht\n+x\n".to_vec();
    let missing_file = b"diff --git a/fehlt.txt b/fehlt.txt\n--- a/fehlt.txt\n+++ b/fehlt.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n".to_vec();
    for (cached, reverse) in [(true, false), (true, true), (false, true)] {
        let err = apply(&tc, &id, wrong_content.clone(), cached, reverse).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::StaleState, "{err:?}");
        assert!(err.git_output.is_some());
    }
    assert_eq!(code_of(apply(&tc, &id, missing_file, true, false).await), ErrorCode::StaleState);
    assert_eq!(repo.read_file("README.md"), b"# Test\n");
    assert_eq!(blob(&repo, ":README.md"), b"# Test\n");
}

#[tokio::test]
async fn odd_selections() {
    let repo = TestRepo::new();
    repo.commit_file("f.txt", "a\nb\nc\n", "Basis");
    repo.write_file("f.txt", "a\nB\nc\n");
    let (tc, id) = open(&repo).await;
    let diff = unstaged(&tc, &id, "f.txt").await;
    let token = diff.token.clone().unwrap();

    // Only context lines or nothing selected: nothing happens.
    let only_context = PatchSelection { path: "f.txt".into(), hunks: vec![HunkSelection { index: 0, lines: Some(vec![0]) }], expect: token.clone() };
    let status = stage_patch(&tc, id.clone(), only_context).await.unwrap();
    assert!(status.staged.is_empty());
    let nothing = PatchSelection { path: "f.txt".into(), hunks: vec![], expect: token.clone() };
    assert!(stage_patch(&tc, id.clone(), nothing).await.unwrap().staged.is_empty());

    // Positions outside the diff.
    let bad_hunk = PatchSelection { path: "f.txt".into(), hunks: vec![HunkSelection { index: 7, lines: None }], expect: token.clone() };
    assert_eq!(code_of(stage_patch(&tc, id.clone(), bad_hunk).await), ErrorCode::NotAllowed);
    let bad_line = PatchSelection { path: "f.txt".into(), hunks: vec![HunkSelection { index: 0, lines: Some(vec![99]) }], expect: token };
    assert_eq!(code_of(stage_patch(&tc, id.clone(), bad_line).await), ErrorCode::NotAllowed);
    assert_eq!(blob(&repo, ":f.txt"), b"a\nb\nc\n");
}

// ---------------------------------------------------------------------------
// unstage_patch
// ---------------------------------------------------------------------------

#[tokio::test]
async fn unstage_single_lines() {
    let repo = TestRepo::new();
    repo.commit_file("f.txt", "a\nb\nc\nd\ne\n", "Basis");
    repo.write_file("f.txt", "a\nB1\nB2\nc\nD\ne\nf\n");
    repo.git(&["add", "f.txt"]);
    let (tc, id) = open(&repo).await;
    let diff = staged(&tc, &id, "f.txt").await;
    tc.events.clear();

    let status = unstage_patch(&tc, id.clone(), pick(&diff, &[("+", "B2"), ("-", "d"), ("+", "f")])).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), b"a\nB1\nc\nd\nD\ne\n");
    assert_eq!(changes(&repo, true, "f.txt"), strings(&["-b", "+B1", "+D"]));
    assert_eq!(changes(&repo, false, "f.txt"), strings(&["+B2", "-d", "+f"]));
    assert_eq!(repo.read_file("f.txt"), b"a\nB1\nB2\nc\nD\ne\nf\n");
    assert_eq!(status.staged.len(), 1);
    assert_eq!(status.unstaged.len(), 1);
    assert_eq!(tc.events.named(names::REPO_CHANGED)[0]["what"], serde_json::json!(["index"]));

    // Unstage the rest: the index is HEAD again.
    let rest = staged(&tc, &id, "f.txt").await;
    let status = unstage_patch(&tc, id.clone(), all_hunks(&rest)).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), b"a\nb\nc\nd\ne\n");
    assert!(status.staged.is_empty());
}

#[tokio::test]
async fn unstage_one_hunk_of_several() {
    let repo = TestRepo::new();
    let base = numbered("zeile", 30);
    repo.write_file("f.txt", join_lines(&base));
    repo.commit("Basis");
    let mut work = base.clone();
    work.splice(2..2, ["neu-1".to_string(), "neu-2".to_string()]);
    work[16] = "GEÄNDERT".into();
    work.push("ende".into());
    repo.write_file("f.txt", join_lines(&work));
    repo.git(&["add", "f.txt"]);
    let (tc, id) = open(&repo).await;
    let diff = staged(&tc, &id, "f.txt").await;
    assert_eq!(diff.hunks.len(), 3);

    unstage_patch(&tc, id.clone(), whole(&diff, &[1, 2])).await.unwrap();
    let mut expected = base.clone();
    expected.splice(2..2, ["neu-1".to_string(), "neu-2".to_string()]);
    assert_eq!(blob(&repo, ":f.txt"), join_lines(&expected).into_bytes());
    assert_eq!(changes(&repo, true, "f.txt"), strings(&["+neu-1", "+neu-2"]));
}

#[tokio::test]
async fn unstage_lines_of_a_new_file() {
    let repo = TestRepo::with_commit();
    repo.write_file("neu.txt", "eins\nzwei\ndrei\n");
    repo.git(&["add", "neu.txt"]);
    let (tc, id) = open(&repo).await;
    let diff = staged(&tc, &id, "neu.txt").await;
    assert_eq!(diff.status, FileStatus::Added);

    unstage_patch(&tc, id.clone(), pick(&diff, &[("+", "zwei")])).await.unwrap();
    assert_eq!(blob(&repo, ":neu.txt"), b"eins\ndrei\n");
    assert_eq!(changes(&repo, false, "neu.txt"), strings(&["+zwei"]));

    // All remaining lines: the file is untracked again afterwards.
    let rest = staged(&tc, &id, "neu.txt").await;
    let status = unstage_patch(&tc, id.clone(), all_hunks(&rest)).await.unwrap();
    assert!(!in_index(&repo, "neu.txt"));
    assert!(status.staged.is_empty());
    assert_eq!(status.unstaged[0].status, FileStatus::Untracked);
    assert_eq!(repo.read_file("neu.txt"), b"eins\nzwei\ndrei\n");
}

#[tokio::test]
async fn unstage_lines_in_an_empty_repo() {
    let repo = TestRepo::new();
    repo.write_file("neu.txt", "eins\nzwei\n");
    repo.git(&["add", "neu.txt"]);
    let (tc, id) = open(&repo).await;
    let diff = staged(&tc, &id, "neu.txt").await;
    unstage_patch(&tc, id.clone(), pick(&diff, &[("+", "eins")])).await.unwrap();
    assert_eq!(blob(&repo, ":neu.txt"), b"zwei\n");
}

#[tokio::test]
async fn unstage_lines_of_a_staged_deletion() {
    let repo = TestRepo::new();
    repo.commit_file("weg.txt", "eins\nzwei\ndrei\n", "Basis");
    repo.git(&["rm", "-q", "weg.txt"]);
    let (tc, id) = open(&repo).await;
    let diff = staged(&tc, &id, "weg.txt").await;
    assert_eq!(diff.status, FileStatus::Deleted);

    unstage_patch(&tc, id.clone(), pick(&diff, &[("-", "eins"), ("-", "drei")])).await.unwrap();
    assert_eq!(blob(&repo, ":weg.txt"), b"eins\ndrei\n", "the file is back in the index with the selected lines");
    assert_eq!(changes(&repo, true, "weg.txt"), strings(&["-zwei"]));
    assert!(!repo.path().join("weg.txt").exists());
}

#[tokio::test]
async fn unstage_lines_of_a_renamed_file() {
    let repo = TestRepo::new();
    let base = numbered("zeile", 12);
    repo.write_file("alt.txt", join_lines(&base));
    repo.commit("Basis");
    repo.git(&["mv", "alt.txt", "neu.txt"]);
    let mut work = base.clone();
    work[1] = "ZWEI".into();
    work.push("ende".into());
    repo.write_file("neu.txt", join_lines(&work));
    repo.git(&["add", "-A"]);
    let (tc, id) = open(&repo).await;
    let diff = staged(&tc, &id, "neu.txt").await;
    assert_eq!(diff.status, FileStatus::Renamed);
    assert_eq!(diff.old_path.as_deref(), Some("alt.txt"));
    assert_eq!(diff.hunks.len(), 2);

    let status = unstage_patch(&tc, id.clone(), pick(&diff, &[("+", "ende")])).await.unwrap();
    let mut expected = base.clone();
    expected[1] = "ZWEI".into();
    assert_eq!(blob(&repo, ":neu.txt"), join_lines(&expected).into_bytes());
    assert_eq!(status.staged.len(), 1);
    assert_eq!(status.staged[0].status, FileStatus::Renamed, "the rename stays staged");
    assert_eq!(changes(&repo, false, "neu.txt"), strings(&["+ende"]));
}

#[tokio::test]
async fn unstage_with_crlf_and_missing_final_newline() {
    let repo = TestRepo::new();
    repo.commit_file("f.txt", "a\r\nb\r\nc", "Basis");
    repo.write_file("f.txt", "a\r\nb\r\nc\r\nd");
    repo.git(&["add", "f.txt"]);
    let (tc, id) = open(&repo).await;

    // Unstage only the appended line: c keeps the newline from the index.
    let diff = staged(&tc, &id, "f.txt").await;
    unstage_patch(&tc, id.clone(), pick(&diff, &[("+", "d")])).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), b"a\r\nb\r\nc\r\n");
    let rest = staged(&tc, &id, "f.txt").await;
    unstage_patch(&tc, id.clone(), all_hunks(&rest)).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), b"a\r\nb\r\nc");

    // The appended line and the new newline after c in one step.
    repo.git(&["add", "f.txt"]);
    let diff = staged(&tc, &id, "f.txt").await;
    unstage_patch(&tc, id.clone(), pick(&diff, &[("-", "c"), ("+", "c"), ("+", "d")])).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), b"a\r\nb\r\nc");
}

/// Nothing but identical lines: the patch must land at exactly the right place, not at
/// the first matching one.
#[tokio::test]
async fn repeated_lines_are_patched_at_the_right_position() {
    let repo = TestRepo::new();
    let base = vec!["x".to_string(); 60];
    repo.write_file("f.txt", join_lines(&base));
    repo.commit("Basis");
    let mut work = base.clone();
    work.insert(10, "A".into());
    work.insert(41, "B".into());
    work.insert(55, "C".into());
    repo.write_file("f.txt", join_lines(&work));
    let with = |marks: &[(usize, &str)]| {
        let mut lines = base.clone();
        for (at, mark) in marks.iter().rev() {
            lines.insert(*at, mark.to_string());
        }
        join_lines(&lines).into_bytes()
    };
    let (tc, id) = open(&repo).await;

    // First and middle hunk in one patch: the second shifts by the line of the first.
    let diff = unstaged(&tc, &id, "f.txt").await;
    assert_eq!(diff.hunks.len(), 3);
    stage_patch(&tc, id.clone(), whole(&diff, &[0, 1])).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), with(&[(10, "A"), (40, "B")]));
    repo.git(&["reset", "-q"]);

    // Only the middle hunk, then only the last.
    let diff = unstaged(&tc, &id, "f.txt").await;
    stage_patch(&tc, id.clone(), whole(&diff, &[1])).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), with(&[(40, "B")]));
    let diff = unstaged(&tc, &id, "f.txt").await;
    stage_patch(&tc, id.clone(), pick(&diff, &[("+", "C")])).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), with(&[(40, "B"), (53, "C")]));

    // Everything staged; take the middle hunk out again.
    repo.git(&["add", "f.txt"]);
    let diff = staged(&tc, &id, "f.txt").await;
    unstage_patch(&tc, id.clone(), whole(&diff, &[1])).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), with(&[(10, "A"), (53, "C")]));
    let diff = staged(&tc, &id, "f.txt").await;
    unstage_patch(&tc, id.clone(), pick(&diff, &[("+", "C")])).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), with(&[(10, "A")]));

    // Discard the middle and the last hunk in the working directory.
    repo.git(&["reset", "-q"]);
    let diff = unstaged(&tc, &id, "f.txt").await;
    discard_patch(&tc, id.clone(), whole(&diff, &[1, 2])).await.unwrap();
    assert_eq!(repo.read_file("f.txt"), with(&[(10, "A")]));
}

/// Common on Windows: core.autocrlf=true, but the file is stored with CRLF in the repository.
/// Git leaves such files alone; index and working directory must keep CRLF.
#[tokio::test]
async fn crlf_blob_with_autocrlf_true_stays_crlf() {
    let repo = TestRepo::new();
    repo.commit_file("f.txt", "a\r\nb\r\nc\r\n", "Basis");
    assert_eq!(blob(&repo, "HEAD:f.txt"), b"a\r\nb\r\nc\r\n");
    repo.git(&["config", "core.autocrlf", "true"]);
    repo.write_file("f.txt", "a\r\nB\r\nc\r\nd\r\n");
    let (tc, id) = open(&repo).await;

    let diff = unstaged(&tc, &id, "f.txt").await;
    assert_eq!(changes(&repo, false, "f.txt"), strings(&["-b", "+B", "+d"]));
    stage_patch(&tc, id.clone(), pick(&diff, &[("+", "d")])).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), b"a\r\nb\r\nc\r\nd\r\n");

    let diff = unstaged(&tc, &id, "f.txt").await;
    discard_patch(&tc, id.clone(), all_hunks(&diff)).await.unwrap();
    assert_eq!(repo.read_file("f.txt"), b"a\r\nb\r\nc\r\nd\r\n");

    let diff = staged(&tc, &id, "f.txt").await;
    unstage_patch(&tc, id.clone(), all_hunks(&diff)).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), b"a\r\nb\r\nc\r\n");
    assert_eq!(repo.read_file("f.txt"), b"a\r\nb\r\nc\r\nd\r\n");
}

/// Trailing whitespace and tabs stay, even if the user has configured `git apply` so
/// that it "fixes" whitespace.
#[tokio::test]
async fn whitespace_is_never_fixed() {
    let repo = TestRepo::new();
    repo.commit_file("f.txt", "a\nb\n", "Basis");
    repo.git(&["config", "apply.whitespace", "fix"]);
    repo.git(&["config", "apply.ignoreWhitespace", "change"]);
    repo.git(&["config", "core.whitespace", "trailing-space,space-before-tab,tab-in-indent"]);
    let work = b"a  \n \tb\t \n\tc   \n   \n";
    repo.write_file("f.txt", work);
    let (tc, id) = open(&repo).await;

    let diff = unstaged(&tc, &id, "f.txt").await;
    stage_patch(&tc, id.clone(), all_hunks(&diff)).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), work);
    let diff = staged(&tc, &id, "f.txt").await;
    unstage_patch(&tc, id.clone(), pick(&diff, &[("+", "\tc   "), ("+", "   ")])).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), b"a  \n \tb\t \n");
    let diff = unstaged(&tc, &id, "f.txt").await;
    discard_patch(&tc, id.clone(), pick(&diff, &[("+", "   ")])).await.unwrap();
    assert_eq!(repo.read_file("f.txt"), b"a  \n \tb\t \n\tc   \n");
}

/// Within a change block the diff lists first all "−" lines, then all "+" lines. If the change
/// was line by line (equally many), each "−" line belongs to its "+" line: a
/// restored "−" line lands at the place of its partner, not before the whole block.
#[tokio::test]
async fn partial_selection_keeps_changed_lines_in_place() {
    let repo = TestRepo::new();
    repo.commit_file("f.txt", "a\nb\nc\n", "Basis");
    repo.write_file("f.txt", "a\nB\nC\n");
    repo.git(&["add", "f.txt"]);
    let (tc, id) = open(&repo).await;
    let diff = staged(&tc, &id, "f.txt").await;
    let signs: Vec<String> = diff.hunks[0].lines.iter().map(|l| format!("{:?} {}", l.kind, l.text)).collect();
    assert_eq!(signs, vec!["Context a", "Remove b", "Remove c", "Add B", "Add C"]);

    unstage_patch(&tc, id.clone(), pick(&diff, &[("-", "c")])).await.unwrap();
    assert_eq!(blob(&repo, ":f.txt"), b"a\nB\nc\nC\n");
}

/// The bug as reported: stage, discard and unstage the middle pair of lines of a block.
#[tokio::test]
async fn middle_pair_of_a_changed_block_lands_in_the_middle() {
    let repo = TestRepo::new();
    repo.commit_file("block.txt", "kopf\neins\nzwei\ndrei\nfuss\n", "Basis");
    repo.write_file("block.txt", "kopf\nEINS\nZWEI\nDREI\nfuss\n");
    let (tc, id) = open(&repo).await;

    let diff = unstaged(&tc, &id, "block.txt").await;
    stage_patch(&tc, id.clone(), pick(&diff, &[("-", "zwei"), ("+", "ZWEI")])).await.unwrap();
    assert_eq!(blob(&repo, ":block.txt"), b"kopf\neins\nZWEI\ndrei\nfuss\n", "in the index ZWEI is at the place of zwei");
    assert_eq!(repo.read_file("block.txt"), b"kopf\nEINS\nZWEI\nDREI\nfuss\n");

    // Unstage the pair again: the index is as before.
    let diff = staged(&tc, &id, "block.txt").await;
    unstage_patch(&tc, id.clone(), pick(&diff, &[("-", "zwei"), ("+", "ZWEI")])).await.unwrap();
    assert_eq!(blob(&repo, ":block.txt"), b"kopf\neins\nzwei\ndrei\nfuss\n");

    // Discard the middle pair in the working directory: only this line is the old one again.
    let diff = unstaged(&tc, &id, "block.txt").await;
    discard_patch(&tc, id.clone(), pick(&diff, &[("-", "zwei"), ("+", "ZWEI")])).await.unwrap();
    assert_eq!(repo.read_file("block.txt"), b"kopf\nEINS\nzwei\nDREI\nfuss\n");
}

// ---------------------------------------------------------------------------
// discard_patch
// ---------------------------------------------------------------------------

#[tokio::test]
async fn discard_lines_and_record_undo() {
    let repo = TestRepo::new();
    repo.commit_file("f.txt", "a\nb\nc\nd\ne\n", "Basis");
    let work = b"a\nB1\nB2\nc\nD\ne\nf\n";
    repo.write_file("f.txt", work);
    repo.write_file("anderes.txt", "bleibt\n");
    let index_tree = repo.git(&["write-tree"]);
    let (tc, id) = open(&repo).await;
    let diff = unstaged(&tc, &id, "f.txt").await;
    tc.events.clear();

    let status = discard_patch(&tc, id.clone(), pick(&diff, &[("+", "B2"), ("-", "d"), ("+", "f")])).await.unwrap();
    assert_eq!(repo.read_file("f.txt"), b"a\nB1\nc\nd\nD\ne\n");
    assert_eq!(blob(&repo, ":f.txt"), b"a\nb\nc\nd\ne\n", "the index stays untouched");
    assert_eq!(changes(&repo, false, "f.txt"), strings(&["-b", "+B1", "+D"]));
    assert_eq!(status.unstaged.len(), 2);
    let what = tc.events.named(names::REPO_CHANGED)[0]["what"].clone();
    assert!(what.as_array().unwrap().contains(&serde_json::json!("worktree")), "{what}");

    let entry = undo::next_undo(&tc, &id, "").unwrap().expect("undo entry");
    assert_eq!(entry.action, "discard");
    assert_eq!(entry.label, "Undo discarding changes in ‘f.txt’");
    assert_eq!(entry.head_before, "refs/heads/main");
    assert_eq!(entry.head_after.as_deref(), Some("refs/heads/main"));
    assert_eq!(entry.ref_name, None);
    assert_eq!(entry.payload["paths"], serde_json::json!(["f.txt"]));
    assert_eq!(entry.payload["indexTree"], serde_json::json!(index_tree));
    let snapshot = entry.payload["worktreeSnapshot"].as_str().unwrap().to_string();
    assert_eq!(blob(&repo, &format!("{snapshot}:f.txt")), work, "the backup contains the state before discarding");
    assert_eq!(repo.git(&["rev-parse", &format!("{snapshot}^1")]), repo.head());
    assert_eq!(repo.git(&["rev-parse", &format!("refs/forkyard/undo/{}/worktree", entry.id)]), snapshot);
    // The real index and HEAD are untouched by the backup.
    assert_eq!(repo.git(&["write-tree"]), index_tree);
}

#[tokio::test]
async fn discard_lines_with_autocrlf_keeps_crlf() {
    let repo = TestRepo::new();
    repo.git(&["config", "core.autocrlf", "true"]);
    repo.commit_file("f.txt", "a\r\nb\r\nc\r\n", "Basis");
    repo.write_file("f.txt", "a\r\nB\r\nc\r\nd\r\n");
    let (tc, id) = open(&repo).await;
    let diff = unstaged(&tc, &id, "f.txt").await;
    discard_patch(&tc, id.clone(), pick(&diff, &[("+", "d")])).await.unwrap();
    assert_eq!(repo.read_file("f.txt"), b"a\r\nB\r\nc\r\n");
    let diff = unstaged(&tc, &id, "f.txt").await;
    let status = discard_patch(&tc, id.clone(), all_hunks(&diff)).await.unwrap();
    assert_eq!(repo.read_file("f.txt"), b"a\r\nb\r\nc\r\n");
    assert!(status.unstaged.is_empty());
}

#[tokio::test]
async fn discard_lines_of_crlf_and_mixed_files() {
    let repo = TestRepo::new();
    repo.write_file("crlf.txt", "a\r\nb\r\nc\r\n");
    repo.write_file("gemischt.txt", "a\r\nb\nc\r\nd\n");
    repo.commit("Basis");
    repo.write_file("crlf.txt", "a\r\nB\r\nc\r\nd\r\n");
    repo.write_file("gemischt.txt", "a\r\nB\nc\r\nD\r\ne\n");
    let (tc, id) = open(&repo).await;

    let diff = unstaged(&tc, &id, "crlf.txt").await;
    discard_patch(&tc, id.clone(), pick(&diff, &[("-", "b"), ("+", "B")])).await.unwrap();
    assert_eq!(repo.read_file("crlf.txt"), b"a\r\nb\r\nc\r\nd\r\n");

    let diff = unstaged(&tc, &id, "gemischt.txt").await;
    discard_patch(&tc, id.clone(), pick(&diff, &[("-", "d"), ("+", "D")])).await.unwrap();
    assert_eq!(repo.read_file("gemischt.txt"), b"a\r\nB\nc\r\nd\ne\n");
}

#[tokio::test]
async fn discard_with_missing_final_newline() {
    let repo = TestRepo::new();
    repo.commit_file("f.txt", "a\nb", "Basis");
    repo.write_file("f.txt", "a\nb\nc");
    let (tc, id) = open(&repo).await;
    let diff = unstaged(&tc, &id, "f.txt").await;
    // Discard only the new line; b keeps its newline.
    discard_patch(&tc, id.clone(), pick(&diff, &[("+", "c")])).await.unwrap();
    assert_eq!(repo.read_file("f.txt"), b"a\nb\n");
    let diff = unstaged(&tc, &id, "f.txt").await;
    discard_patch(&tc, id.clone(), all_hunks(&diff)).await.unwrap();
    assert_eq!(repo.read_file("f.txt"), b"a\nb");
}

#[tokio::test]
async fn discard_lines_of_an_untracked_file() {
    let repo = TestRepo::with_commit();
    repo.write_file("neu.txt", "eins\nzwei\ndrei\n");
    let (tc, id) = open(&repo).await;
    let diff = unstaged(&tc, &id, "neu.txt").await;
    discard_patch(&tc, id.clone(), pick(&diff, &[("+", "zwei")])).await.unwrap();
    assert_eq!(repo.read_file("neu.txt"), b"eins\ndrei\n");
    let entry = undo::next_undo(&tc, &id, "").unwrap().unwrap();
    let snapshot = entry.payload["worktreeSnapshot"].as_str().unwrap().to_string();
    assert_eq!(blob(&repo, &format!("{snapshot}:neu.txt")), b"eins\nzwei\ndrei\n");

    // All lines: the file is gone.
    let diff = unstaged(&tc, &id, "neu.txt").await;
    let status = discard_patch(&tc, id.clone(), all_hunks(&diff)).await.unwrap();
    assert!(!repo.path().join("neu.txt").exists());
    assert!(status.unstaged.is_empty());
}

#[tokio::test]
async fn discard_lines_of_a_deleted_file_brings_them_back() {
    let repo = TestRepo::new();
    repo.commit_file("weg.txt", "eins\nzwei\ndrei\n", "Basis");
    repo.remove_file("weg.txt");
    let (tc, id) = open(&repo).await;
    let diff = unstaged(&tc, &id, "weg.txt").await;
    discard_patch(&tc, id.clone(), pick(&diff, &[("-", "eins"), ("-", "drei")])).await.unwrap();
    assert_eq!(repo.read_file("weg.txt"), b"eins\ndrei\n");
    assert_eq!(changes(&repo, false, "weg.txt"), strings(&["-zwei"]));
}

// ---------------------------------------------------------------------------
// All subsets: staging, unstaging and discarding must agree with each other
// ---------------------------------------------------------------------------

/// Independent model: lines of a hunk, of which context, unselected
/// "−" lines and selected "+" lines remain. A line without a newline that does not end up
/// at the end gets one.
fn model(lines: &[crate::model::DiffLine], chosen: &[u32]) -> Vec<u8> {
    // A block with equally many "−" and "+" lines (at least two) counts in pairs: −1 +1 −2 +2 …
    let mut order: Vec<usize> = Vec::new();
    let mut at = 0;
    while at < lines.len() {
        let removes = lines[at..].iter().take_while(|l| l.kind == DiffLineKind::Remove).count();
        let adds = lines[at + removes..].iter().take_while(|l| l.kind == DiffLineKind::Add).count();
        if removes >= 2 && removes == adds {
            for pair in 0..removes {
                order.extend([at + pair, at + removes + pair]);
            }
        } else {
            order.extend(at..at + (removes + adds).max(1));
        }
        at += (removes + adds).max(1);
    }
    // The old last line (no newline) belongs to the "+" line of the same rank in its block,
    // or goes to the end if there is none: it stays behind the lines it followed in the file.
    if let Some(last) = lines.iter().position(|l| l.kind == DiffLineKind::Remove && l.no_newline) {
        if lines[last + 1..].iter().all(|l| l.kind == DiffLineKind::Add) {
            let rank = lines[..last].iter().rev().take_while(|l| l.kind == DiffLineKind::Remove).count();
            order.retain(|&i| i != last);
            match order.iter().position(|&i| i == last + 1 + rank) {
                Some(at) => order.insert(at, last),
                None => order.push(last),
            }
        }
    }
    let kept: Vec<&crate::model::DiffLine> = order
        .into_iter()
        .map(|i| (i, &lines[i]))
        .filter(|(i, l)| match l.kind {
            DiffLineKind::Context => true,
            DiffLineKind::Remove => !chosen.contains(&(*i as u32)),
            DiffLineKind::Add => chosen.contains(&(*i as u32)),
        })
        .map(|(_, l)| l)
        .collect();
    let mut out = Vec::new();
    for (i, line) in kept.iter().enumerate() {
        out.extend_from_slice(line.text.as_bytes());
        if !line.no_newline || i + 1 < kept.len() {
            out.push(b'\n');
        }
    }
    out
}

fn subsets(positions: &[u32]) -> Vec<Vec<u32>> {
    (1u32..(1 << positions.len()))
        .map(|mask| positions.iter().enumerate().filter(|(i, _)| mask & (1 << i) != 0).map(|(_, &p)| p).collect())
        .collect()
}

async fn all_subsets_agree(base: &str, work: &str) {
    let repo = TestRepo::new();
    repo.commit_file("f.txt", base, "Basis");
    repo.write_file("f.txt", work);
    let (tc, id) = open(&repo).await;
    let diff = unstaged(&tc, &id, "f.txt").await;
    assert_eq!(diff.hunks.len(), 1, "the case must fit into one hunk");
    let lines = diff.hunks[0].lines.clone();
    let change_positions: Vec<u32> = lines.iter().enumerate().filter(|(_, l)| l.kind != DiffLineKind::Context).map(|(i, _)| i as u32).collect();

    for chosen in subsets(&change_positions) {
        let rest: Vec<u32> = change_positions.iter().copied().filter(|p| !chosen.contains(p)).collect();
        let label = format!("{base:?} → {work:?}, Auswahl {chosen:?}");

        // Stage the selection.
        repo.git(&["reset", "-q"]);
        repo.write_file("f.txt", work);
        apply_directly(&tc, &id, &chosen, false, Direction::Forward, true, &lines, &label).await;
        assert_eq!(blob(&repo, ":f.txt"), model(&lines, &chosen), "stage {label}");
        assert_eq!(repo.read_file("f.txt"), work.as_bytes(), "stage {label}");

        // Stage everything and unstage the selection again: the rest remains.
        repo.git(&["add", "f.txt"]);
        apply_directly(&tc, &id, &chosen, true, Direction::Reverse, true, &lines, &label).await;
        assert_eq!(blob(&repo, ":f.txt"), model(&lines, &rest), "unstage {label}");

        // Discard the selection in the working directory: the rest remains as well.
        repo.git(&["reset", "-q"]);
        apply_directly(&tc, &id, &chosen, false, Direction::Reverse, false, &lines, &label).await;
        assert_eq!(repo.read_file("f.txt"), model(&lines, &rest), "discard {label}");
        assert_eq!(blob(&repo, ":f.txt"), base.as_bytes(), "discard {label}");
    }
}

/// Builds and applies the patch of a selection – without status and backup, so that the
/// many runs stay fast. The remaining tests check the commands themselves.
#[allow(clippy::too_many_arguments)]
async fn apply_directly(tc: &TestCore, id: &str, chosen: &[u32], staged_diff: bool, direction: Direction, cached: bool, expected: &[crate::model::DiffLine], label: &str) {
    let diff = text_diff(tc, id, "f.txt", if staged_diff { DiffSource::Staged } else { DiffSource::Unstaged }).await;
    assert_eq!(diff.hunks[0].lines, expected, "{label}");
    let selection = PatchSelection { path: "f.txt".into(), hunks: vec![HunkSelection { index: 0, lines: Some(chosen.to_vec()) }], expect: diff.token.expect("token") };
    let patch = selected_patch(tc, id, &selection, staged_diff, direction).await.unwrap_or_else(|e| panic!("{label}: {e:?}")).expect("patch");
    apply(tc, id, patch.bytes, cached, direction == Direction::Reverse).await.unwrap_or_else(|e| panic!("{label}: {e:?}"));
}

#[tokio::test]
async fn every_subset_of_a_mixed_hunk() {
    all_subsets_agree("a\nb\nc\nd\n", "a\nB1\nB2\nc\n").await;
}

/// Block changed line by line (two pairs): every subset, in all three directions.
#[tokio::test]
async fn every_subset_of_a_block_changed_line_by_line() {
    all_subsets_agree("k\na\nb\nf\n", "k\nA\nB\nf\n").await;
}

#[tokio::test]
async fn every_subset_without_final_newline_on_both_sides() {
    all_subsets_agree("a\nb", "a\nb\nc").await;
}

#[tokio::test]
async fn every_subset_when_the_final_newline_disappears() {
    all_subsets_agree("x\ny\n", "x\nY").await;
}

/// The old last line without a newline is the second "−" line of a block with more "+" lines.
#[tokio::test]
async fn every_subset_when_lines_follow_the_old_last_line() {
    all_subsets_agree("alpha\nbeta\ngamma", "alpha\nBETA\ngamma\ndelta").await;
    all_subsets_agree("alpha\nbeta\ngamma", "alpha\nBETA\nGAMMA\ndelta\n").await;
}

#[tokio::test]
async fn every_subset_when_the_final_newline_appears() {
    all_subsets_agree("p\nq", "p\nQ\nr\n").await;
}

// ---------------------------------------------------------------------------
// discard_paths
// ---------------------------------------------------------------------------

#[tokio::test]
async fn discard_paths_restores_the_index_state() {
    let repo = TestRepo::new();
    repo.write_file("teils.txt", "a\n");
    repo.write_file("gelöscht.txt", "b\n");
    repo.write_file("bleibt.txt", "c\n");
    repo.commit("Basis");
    // teils.txt: one change staged, another one only in the working directory.
    repo.write_file("teils.txt", "a\ngestaged\n");
    repo.git(&["add", "teils.txt"]);
    repo.write_file("teils.txt", "a\ngestaged\nnur hier\n");
    repo.remove_file("gelöscht.txt");
    repo.write_file("neu/unverfolgt.txt", "x\n");
    repo.write_file("bleibt.txt", "c\nbleibt geändert\n");
    let index_tree = repo.git(&["write-tree"]);
    let (tc, id) = open(&repo).await;
    tc.events.clear();

    let status = discard_paths(&tc, id.clone(), Some(strings(&["teils.txt", "gelöscht.txt", "neu/unverfolgt.txt"]))).await.unwrap();
    assert_eq!(repo.read_file("teils.txt"), b"a\ngestaged\n", "back to the index state");
    assert_eq!(repo.read_file("gelöscht.txt"), b"b\n");
    assert!(!repo.path().join("neu").exists(), "the untracked file and its empty directory are gone");
    assert_eq!(repo.read_file("bleibt.txt"), "c\nbleibt geändert\n".as_bytes());
    assert_eq!(status.staged.len(), 1, "staged changes stay staged");
    let unstaged: Vec<&str> = status.unstaged.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(unstaged, vec!["bleibt.txt"]);
    let what = tc.events.named(names::REPO_CHANGED)[0]["what"].clone();
    assert!(what.as_array().unwrap().contains(&serde_json::json!("worktree")), "{what}");

    let entry = undo::next_undo(&tc, &id, "").unwrap().expect("undo entry");
    assert_eq!(entry.action, "discard");
    assert_eq!(entry.label, "Undo discarding 3 files");
    assert_eq!(entry.payload["paths"], serde_json::json!(["teils.txt", "gelöscht.txt", "neu/unverfolgt.txt"]));
    assert_eq!(entry.payload["indexTree"], serde_json::json!(index_tree));
    let snapshot = entry.payload["worktreeSnapshot"].as_str().unwrap().to_string();
    assert_eq!(blob(&repo, &format!("{snapshot}:teils.txt")), b"a\ngestaged\nnur hier\n");
    assert_eq!(blob(&repo, &format!("{snapshot}:neu/unverfolgt.txt")), b"x\n");
    let listed = repo.git(&["ls-tree", "-r", "--name-only", &snapshot]);
    assert!(!listed.contains("gelöscht.txt"), "in the backup the file is deleted: {listed}");
    assert_eq!(repo.git(&["rev-parse", &format!("refs/forkyard/undo/{}/worktree", entry.id)]), snapshot);
}

#[tokio::test]
async fn discard_paths_special_entries() {
    let repo = TestRepo::with_commit();
    // Newly staged and then deleted in the working directory: comes back from the index.
    repo.write_file("neu gestaged.txt", "n\n");
    repo.git(&["add", "neu gestaged.txt"]);
    repo.remove_file("neu gestaged.txt");
    // Marked with `git add -N`: disappears completely.
    repo.write_file("vorgemerkt.txt", "v\n");
    repo.git(&["add", "-N", "vorgemerkt.txt"]);
    // Only staged, nothing changed in the working directory: stays untouched.
    repo.write_file("README.md", "# Gestaged\n");
    repo.git(&["add", "README.md"]);
    let (tc, id) = open(&repo).await;

    let wanted = strings(&["neu gestaged.txt", "vorgemerkt.txt", "README.md", "gibt-es-nicht.txt", "vorgemerkt.txt"]);
    let status = discard_paths(&tc, id.clone(), Some(wanted)).await.unwrap();
    assert_eq!(repo.read_file("neu gestaged.txt"), b"n\n");
    assert!(!repo.path().join("vorgemerkt.txt").exists());
    assert!(!in_index(&repo, "vorgemerkt.txt"));
    assert_eq!(repo.read_file("README.md"), b"# Gestaged\n");
    assert!(status.unstaged.is_empty(), "{:?}", status.unstaged);
    assert_eq!(status.staged.len(), 2);

    let entry = undo::next_undo(&tc, &id, "").unwrap().unwrap();
    assert_eq!(entry.payload["paths"], serde_json::json!(["neu gestaged.txt", "vorgemerkt.txt"]));
    let snapshot = entry.payload["worktreeSnapshot"].as_str().unwrap().to_string();
    assert_eq!(blob(&repo, &format!("{snapshot}:vorgemerkt.txt")), b"v\n");
    assert_eq!(repo.git(&["ls-tree", "-r", "--name-only", &snapshot]).lines().collect::<Vec<_>>(), vec!["README.md", "vorgemerkt.txt"]);
}

#[tokio::test]
async fn discard_single_file_label_and_noop() {
    let repo = TestRepo::with_commit();
    repo.write_file("README.md", "# Anders\n");
    let (tc, id) = open(&repo).await;
    discard_paths(&tc, id.clone(), Some(strings(&["README.md"]))).await.unwrap();
    assert_eq!(repo.read_file("README.md"), b"# Test\n");
    let entry = undo::next_undo(&tc, &id, "").unwrap().unwrap();
    assert_eq!(entry.label, "Undo discarding ‘README.md’");

    // Nothing to discard: no further undo entry, no error.
    let status = discard_paths(&tc, id.clone(), Some(strings(&["README.md"]))).await.unwrap();
    assert!(status.unstaged.is_empty());
    assert_eq!(undo::next_undo(&tc, &id, "").unwrap().unwrap().id, entry.id);
    discard_paths(&tc, id.clone(), None).await.unwrap();
    assert_eq!(undo::next_undo(&tc, &id, "").unwrap().unwrap().id, entry.id);
}

#[tokio::test]
async fn discard_all_goes_back_to_head() {
    let repo = TestRepo::new();
    repo.write_file("a.txt", "a\n");
    repo.write_file("b.txt", "b\n");
    repo.write_file("alt.txt", join_lines(&numbered("zeile", 10)));
    repo.write_file(".gitignore", "ignoriert.log\n");
    repo.commit("Basis");
    repo.write_file("a.txt", "A gestaged\n");
    repo.git(&["add", "a.txt"]);
    repo.write_file("a.txt", "A gestaged und mehr\n");
    repo.remove_file("b.txt");
    repo.git(&["mv", "alt.txt", "umbenannt.txt"]);
    repo.write_file("neu gestaged.txt", "n\n");
    repo.git(&["add", "neu gestaged.txt"]);
    repo.write_file("ordner/tief/unverfolgt.txt", "u\n");
    repo.write_file("ignoriert.log", "bleibt\n");
    let index_tree = repo.git(&["write-tree"]);
    let head = repo.head();
    let (tc, id) = open(&repo).await;

    let status = discard_paths(&tc, id.clone(), None).await.unwrap();
    assert!(status.unstaged.is_empty() && status.staged.is_empty(), "{status:?}");
    assert_eq!(repo.read_file("a.txt"), b"a\n");
    assert_eq!(repo.read_file("b.txt"), b"b\n");
    assert!(repo.path().join("alt.txt").exists());
    assert!(!repo.path().join("umbenannt.txt").exists());
    assert!(!repo.path().join("neu gestaged.txt").exists());
    assert!(!repo.path().join("ordner").exists());
    assert_eq!(repo.read_file("ignoriert.log"), b"bleibt\n", "ignored files stay");
    assert_eq!(repo.head(), head);

    let entry = undo::next_undo(&tc, &id, "").unwrap().expect("undo entry");
    assert_eq!(entry.action, "discard");
    assert_eq!(entry.label, "Undo discarding 5 files");
    assert!(entry.payload["paths"].is_null(), "null = everything");
    assert_eq!(entry.payload["indexTree"], serde_json::json!(index_tree));
    let snapshot = entry.payload["worktreeSnapshot"].as_str().unwrap().to_string();
    assert_eq!(blob(&repo, &format!("{snapshot}:a.txt")), b"A gestaged und mehr\n");
    assert_eq!(blob(&repo, &format!("{snapshot}:ordner/tief/unverfolgt.txt")), b"u\n");
    assert_eq!(blob(&repo, &format!("{snapshot}:neu gestaged.txt")), b"n\n");
    let listed = repo.git(&["ls-tree", "-r", "--name-only", &snapshot]);
    assert!(listed.contains("umbenannt.txt") && !listed.contains("alt.txt") && !listed.contains("b.txt"), "{listed}");
    assert!(!listed.contains("ignoriert.log"));
    // The index tree stays reachable through a backup ref of its own.
    assert_eq!(repo.git(&["rev-parse", &format!("refs/forkyard/undo/{}/index^{{tree}}", entry.id)]), index_tree);
}

#[tokio::test]
async fn discard_all_in_an_empty_repo() {
    let repo = TestRepo::new();
    repo.write_file("gestaged.txt", "1\n");
    repo.git(&["add", "gestaged.txt"]);
    repo.write_file("unverfolgt.txt", "2\n");
    let (tc, id) = open(&repo).await;

    let status = discard_paths(&tc, id.clone(), None).await.unwrap();
    assert!(matches!(status.head, Head::Unborn { .. }));
    assert!(status.unstaged.is_empty() && status.staged.is_empty());
    assert!(!repo.path().join("gestaged.txt").exists());
    assert!(!repo.path().join("unverfolgt.txt").exists());
    let entry = undo::next_undo(&tc, &id, "").unwrap().unwrap();
    assert_eq!(entry.head_before, "refs/heads/main");
    let snapshot = entry.payload["worktreeSnapshot"].as_str().unwrap().to_string();
    assert_eq!(blob(&repo, &format!("{snapshot}:gestaged.txt")), b"1\n");
    assert_eq!(blob(&repo, &format!("{snapshot}:unverfolgt.txt")), b"2\n");
    assert!(repo.git_output(&["rev-parse", "--verify", "-q", &format!("{snapshot}^1")]).stdout.is_empty(), "without a commit the backup has no HEAD parent");
}

#[tokio::test]
async fn discard_on_detached_head_records_the_sha() {
    let repo = TestRepo::with_commit();
    repo.git(&["checkout", "-q", "--detach"]);
    repo.write_file("README.md", "# Anders\n");
    let (tc, id) = open(&repo).await;
    discard_paths(&tc, id.clone(), None).await.unwrap();
    let entry = undo::next_undo(&tc, &id, "").unwrap().unwrap();
    assert_eq!(entry.head_before, repo.head());
    assert_eq!(repo.read_file("README.md"), b"# Test\n");
}

#[tokio::test]
async fn discard_during_a_merge() {
    let repo = TestRepo::with_commit();
    repo.write_file("frei.txt", "x\n");
    repo.commit("frei");
    repo.checkout_new("feature");
    repo.commit_file("README.md", "# Feature\n", "Feature");
    repo.checkout("main");
    repo.commit_file("README.md", "# Main\n", "Main");
    assert!(!repo.merge("feature"));
    repo.write_file("frei.txt", "x\nmehr\n");
    let (tc, id) = open(&repo).await;

    // Discarding everything would destroy the merge: that is what "Abort" is for.
    assert_eq!(code_of(discard_paths(&tc, id.clone(), None).await), ErrorCode::OperationInProgress);
    assert!(repo.path().join(".git").join("MERGE_HEAD").exists());
    // A conflicted file cannot be discarded, another file can.
    assert_eq!(code_of(discard_paths(&tc, id.clone(), Some(strings(&["README.md"]))).await), ErrorCode::Conflict);
    let status = discard_paths(&tc, id.clone(), Some(strings(&["frei.txt"]))).await.unwrap();
    assert_eq!(repo.read_file("frei.txt"), b"x\n");
    assert_eq!(status.conflicted.len(), 1);
    assert!(status.operation.is_some());
}

#[tokio::test]
async fn lines_during_a_merge_and_in_an_empty_repo() {
    let repo = TestRepo::with_commit();
    repo.write_file("frei.txt", "x\n");
    repo.commit("frei");
    repo.checkout_new("feature");
    repo.commit_file("README.md", "# Feature\n", "Feature");
    repo.checkout("main");
    repo.commit_file("README.md", "# Main\n", "Main");
    assert!(!repo.merge("feature"));
    repo.write_file("frei.txt", "x\neins\nzwei\n");
    let (tc, id) = open(&repo).await;

    // During the merge: a file without a conflict works as always, the conflicted file does not.
    let diff = unstaged(&tc, &id, "frei.txt").await;
    let status = stage_patch(&tc, id.clone(), pick(&diff, &[("+", "eins")])).await.unwrap();
    assert_eq!(blob(&repo, ":frei.txt"), b"x\neins\n");
    assert!(status.operation.is_some());
    assert_eq!(status.conflicted.len(), 1);
    let diff = unstaged(&tc, &id, "frei.txt").await;
    discard_patch(&tc, id.clone(), all_hunks(&diff)).await.unwrap();
    assert_eq!(repo.read_file("frei.txt"), b"x\neins\n");
    let on_conflict = PatchSelection { path: "README.md".into(), hunks: vec![HunkSelection { index: 0, lines: None }], expect: "egal".into() };
    assert_eq!(code_of(stage_patch(&tc, id.clone(), on_conflict.clone()).await), ErrorCode::Conflict);
    assert_eq!(code_of(discard_patch(&tc, id, on_conflict).await), ErrorCode::Conflict);

    // Without a commit: discard lines of an untracked file, with a backup.
    let empty = TestRepo::new();
    empty.write_file("neu.txt", "eins\nzwei\n");
    let (tc, id) = open(&empty).await;
    let diff = unstaged(&tc, &id, "neu.txt").await;
    discard_patch(&tc, id.clone(), pick(&diff, &[("+", "zwei")])).await.unwrap();
    assert_eq!(empty.read_file("neu.txt"), b"eins\n");
    let entry = undo::next_undo(&tc, &id, "").unwrap().unwrap();
    assert_eq!(entry.head_before, "refs/heads/main");
    let snapshot = entry.payload["worktreeSnapshot"].as_str().unwrap().to_string();
    assert_eq!(blob(&empty, &format!("{snapshot}:neu.txt")), b"eins\nzwei\n");
    assert!(entry.payload["indexTree"].is_string());
}

#[tokio::test]
async fn discard_works_without_git_identity() {
    let repo = TestRepo::without_identity();
    repo.write_file("neu.txt", "x\n");
    let (tc, id) = open(&repo).await;
    discard_paths(&tc, id.clone(), Some(strings(&["neu.txt"]))).await.unwrap();
    assert!(!repo.path().join("neu.txt").exists());
    assert!(undo::next_undo(&tc, &id, "").unwrap().is_some());
}

// ---------------------------------------------------------------------------
// ignore_add
// ---------------------------------------------------------------------------

#[tokio::test]
async fn ignore_add_creates_and_appends() {
    let repo = TestRepo::with_commit();
    repo.write_file("a.log", "x\n");
    let (tc, id) = open(&repo).await;
    tc.events.clear();

    let status = ignore_add(&tc, id.clone(), "*.log".into(), false).await.unwrap();
    assert_eq!(repo.read_file(".gitignore"), b"*.log\n");
    let unstaged: Vec<&str> = status.unstaged.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(unstaged, vec![".gitignore"]);
    assert_eq!(tc.events.count(names::REPO_CHANGED), 1);

    ignore_add(&tc, id.clone(), "  build/  ".into(), false).await.unwrap();
    assert_eq!(repo.read_file(".gitignore"), b"*.log\nbuild/\n");
    // No duplicate entry.
    ignore_add(&tc, id.clone(), "*.log".into(), false).await.unwrap();
    assert_eq!(repo.read_file(".gitignore"), b"*.log\nbuild/\n");

    assert_eq!(code_of(ignore_add(&tc, id.clone(), "   ".into(), false).await), ErrorCode::NotAllowed);
    assert_eq!(code_of(ignore_add(&tc, id, "a\nb".into(), false).await), ErrorCode::NotAllowed);
}

#[tokio::test]
async fn ignore_add_keeps_line_endings() {
    let repo = TestRepo::with_commit();
    let (tc, id) = open(&repo).await;
    // CRLF file without a newline at the end.
    repo.write_file(".gitignore", "eins\r\nzwei");
    ignore_add(&tc, id.clone(), "drei".into(), false).await.unwrap();
    assert_eq!(repo.read_file(".gitignore"), b"eins\r\nzwei\r\ndrei\r\n");
    ignore_add(&tc, id.clone(), "zwei".into(), false).await.unwrap();
    assert_eq!(repo.read_file(".gitignore"), b"eins\r\nzwei\r\ndrei\r\n");

    repo.write_file(".gitignore", "eins\nzwei");
    ignore_add(&tc, id, "drei".into(), false).await.unwrap();
    assert_eq!(repo.read_file(".gitignore"), b"eins\nzwei\ndrei\n");
}

#[tokio::test]
async fn ignore_add_can_stop_tracking() {
    let repo = TestRepo::new();
    repo.write_file("logs/a.log", "a\n");
    repo.write_file("logs/tief/b.log", "b\n");
    repo.write_file("behalten.txt", "c\n");
    repo.commit("Basis");
    let (tc, id) = open(&repo).await;

    let status = ignore_add(&tc, id.clone(), "logs/".into(), true).await.unwrap();
    assert!(!in_index(&repo, "logs/a.log") && !in_index(&repo, "logs/tief/b.log"));
    assert!(in_index(&repo, "behalten.txt"));
    assert_eq!(repo.read_file("logs/a.log"), b"a\n", "the files stay on disk");
    let staged: Vec<(&str, FileStatus)> = status.staged.iter().map(|f| (f.path.as_str(), f.status)).collect();
    assert_eq!(staged, vec![("logs/a.log", FileStatus::Deleted), ("logs/tief/b.log", FileStatus::Deleted)]);
    let unstaged: Vec<&str> = status.unstaged.iter().map(|f| f.path.as_str()).collect();
    assert_eq!(unstaged, vec![".gitignore"], "the files now count as ignored");

    // Without stop_tracking a tracked file stays tracked.
    ignore_add(&tc, id, "behalten.txt".into(), false).await.unwrap();
    assert!(in_index(&repo, "behalten.txt"));
}

// ---------------------------------------------------------------------------
// file_restore
// ---------------------------------------------------------------------------

#[tokio::test]
async fn file_restore_brings_back_staged_files() {
    let repo = TestRepo::new();
    repo.write_file("a b.txt", "alt\n");
    repo.write_file("weg.txt", "noch da\n");
    let first = repo.commit("Erster");
    repo.write_file("a b.txt", "neu\n");
    repo.remove_file("weg.txt");
    repo.commit("Zweiter");
    let (tc, id) = open(&repo).await;
    tc.events.clear();

    let status = file_restore(&tc, id.clone(), first.clone(), strings(&["a b.txt", "weg.txt"])).await.unwrap();
    assert_eq!(repo.read_file("a b.txt"), b"alt\n");
    assert_eq!(repo.read_file("weg.txt"), b"noch da\n");
    let staged: Vec<(&str, FileStatus)> = status.staged.iter().map(|f| (f.path.as_str(), f.status)).collect();
    assert_eq!(staged, vec![("a b.txt", FileStatus::Modified), ("weg.txt", FileStatus::Added)]);
    assert!(status.unstaged.is_empty());
    let what = tc.events.named(names::REPO_CHANGED)[0]["what"].clone();
    assert_eq!(what, serde_json::json!(["worktree", "index"]));

    // A short SHA works too.
    repo.commit("Dritter");
    repo.write_file("a b.txt", "ganz neu\n");
    file_restore(&tc, id, first[..8].to_string(), strings(&["a b.txt"])).await.unwrap();
    assert_eq!(repo.read_file("a b.txt"), b"alt\n");
}

#[tokio::test]
async fn file_restore_unknown_file_or_commit() {
    let repo = TestRepo::with_commit();
    let first = repo.head();
    repo.commit_file("später.txt", "x\n", "Zweiter");
    let (tc, id) = open(&repo).await;

    // The file doesn't exist in the commit: nothing is touched, not even the other one.
    repo.write_file("README.md", "# Lokal\n");
    let result = file_restore(&tc, id.clone(), first.clone(), strings(&["README.md", "später.txt"])).await;
    assert_eq!(code_of(result), ErrorCode::NotFound);
    assert_eq!(repo.read_file("README.md"), b"# Lokal\n");
    assert!(repo.path().join("später.txt").exists());

    assert_eq!(code_of(file_restore(&tc, id.clone(), "0123456789abcdef0123456789abcdef01234567".into(), strings(&["README.md"])).await), ErrorCode::NotFound);
    assert_eq!(code_of(file_restore(&tc, id.clone(), "--all".into(), strings(&["README.md"])).await), ErrorCode::NotFound);
    // Without paths nothing happens.
    assert!(file_restore(&tc, id, first, vec![]).await.is_ok());
}

// ---------------------------------------------------------------------------
// file_delete
// ---------------------------------------------------------------------------

#[tokio::test]
async fn file_delete_removes_tracked_and_untracked_files_with_undo() {
    let repo = TestRepo::with_commit();
    repo.commit_file("ordner/tief/alt.txt", "verfolgt\n", "Datei");
    repo.write_file("ordner/tief/alt.txt", "verfolgt\nlokal geändert\n");
    repo.write_file("neu ordner/größe.txt", "unverfolgt\n");
    repo.write_file("gestagt.txt", "neu im Index\n");
    repo.git(&["add", "gestagt.txt"]);
    let (tc, id) = open(&repo).await;
    tc.events.clear();

    // Tracked file: gone from the working directory, still in the index; the empty directory disappears.
    let status = file_delete(&tc, id.clone(), "ordner/tief/alt.txt".into()).await.unwrap();
    assert!(!repo.path().join("ordner").exists());
    let entry = status.unstaged.iter().find(|f| f.path == "ordner/tief/alt.txt").expect("reported as deleted");
    assert_eq!(entry.status, FileStatus::Deleted);
    assert!(in_index(&repo, "ordner/tief/alt.txt"));
    let changed = tc.events.named(names::REPO_CHANGED);
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0]["what"], serde_json::json!(["worktree"]));
    let step = crate::commands::undo::undo_peek(&tc, id.clone()).await.unwrap().undo.expect("undo step");
    assert_eq!((step.action.as_str(), step.label.as_str()), ("discard", "Undo deleting ‘ordner/tief/alt.txt’"));

    // Untracked file (also with backslashes in the path) and a freshly staged one.
    let status = file_delete(&tc, id.clone(), "neu ordner\\größe.txt".replace("\\", if cfg!(windows) { "\\" } else { "/" })).await.unwrap();
    assert!(!repo.path().join("neu ordner").exists());
    assert!(!status.unstaged.iter().any(|f| f.path.contains("größe")));
    let status = file_delete(&tc, id.clone(), "gestagt.txt".into()).await.unwrap();
    assert!(status.staged.iter().any(|f| f.path == "gestagt.txt"));
    assert!(status.unstaged.iter().any(|f| f.path == "gestagt.txt" && f.status == FileStatus::Deleted));

    // Undo brings the files back in reverse order – with their content.
    for _ in 0..3 {
        crate::commands::undo::undo(&tc, id.clone()).await.unwrap();
    }
    assert_eq!(repo.read_file("gestagt.txt"), b"neu im Index\n");
    assert_eq!(repo.read_file("neu ordner/größe.txt"), b"unverfolgt\n");
    assert_eq!(repo.read_file("ordner/tief/alt.txt"), "verfolgt\nlokal geändert\n".as_bytes());
    let status = read_status(&tc, &id).await.unwrap();
    assert!(status.unstaged.iter().any(|f| f.path == "ordner/tief/alt.txt" && f.status == FileStatus::Modified));
    // Redo deletes again.
    crate::commands::undo::redo(&tc, id.clone()).await.unwrap();
    assert!(!repo.path().join("ordner/tief/alt.txt").exists());
}

#[tokio::test]
async fn file_delete_refuses_what_it_cannot_back_up() {
    let repo = TestRepo::with_commit();
    repo.write_file(".gitignore", "*.log\n");
    repo.commit("Ignorieren");
    repo.write_file("egal.log", "ignoriert\n");
    repo.subdir("ordner");
    repo.write_file("ordner/drin.txt", "x\n");
    let (tc, id) = open(&repo).await;

    for (path, code) in [
        ("fehlt.txt", ErrorCode::NotFound),
        ("ordner", ErrorCode::NotAllowed),
        ("egal.log", ErrorCode::NotAllowed),
        ("../draußen.txt", ErrorCode::NotAllowed),
        (".git/config", ErrorCode::NotAllowed),
        ("", ErrorCode::NotAllowed),
    ] {
        assert_eq!(code_of(file_delete(&tc, id.clone(), path.into()).await), code, "{path:?}");
    }
    assert!(repo.path().join("egal.log").exists() && repo.path().join(".git").join("config").exists());
    assert!(crate::commands::undo::undo_peek(&tc, id.clone()).await.unwrap().undo.is_none());

    // Foreign index.lock: nothing is deleted, and no backup is left behind.
    let lock = repo.path().join(".git").join("index.lock");
    std::fs::write(&lock, "").unwrap();
    assert_eq!(code_of(file_delete(&tc, id.clone(), "ordner/drin.txt".into()).await), ErrorCode::Locked);
    std::fs::remove_file(&lock).unwrap();
    assert!(repo.path().join("ordner/drin.txt").exists());
    assert!(repo.git(&["for-each-ref", "refs/forkyard"]).is_empty());

    // Conflicted file: resolve the conflict first.
    repo.checkout_new("feature");
    repo.commit_file("README.md", "# Feature\n", "Feature");
    repo.checkout("main");
    repo.commit_file("README.md", "# Main\n", "Main");
    assert!(!repo.merge("feature"));
    assert_eq!(code_of(file_delete(&tc, id.clone(), "README.md".into()).await), ErrorCode::Conflict);
    assert!(repo.path().join("README.md").exists());
}
