//! Committing a selection against real temp repositories, with Git as the oracle: two files at once,
//! CRLF, a missing final newline, Latin-1, umlaut paths, an untracked file, staged changes that stay,
//! collisions with the index, stale state and hooks.

use super::*;
use crate::commands::diff::diff_file;
use crate::db::undo::UndoEntry;
use crate::model::{DiffLineKind, DiffSource, FileDiff, HunkSelection, PatchSelection, TextDiff};
use crate::testkit::{TestCore, TestRepo};

const FILES: [&str; 6] = ["a.txt", "b ä.txt", "c.txt", "crlf.txt", "ohne-ende.txt", "latin1.txt"];

/// The fixture commit on top of a first commit (so there is "another commit" for stale tests).
async fn setup() -> (TestCore, TestRepo, String, String) {
    let repo = TestRepo::with_commit();
    repo.write_file("a.txt", "eins\nzwei\ndrei\nvier\n");
    repo.write_file("b ä.txt", "alpha\nbeta\n");
    repo.write_file("c.txt", "x\n");
    repo.write_file("crlf.txt", "eins\r\nzwei\r\n");
    repo.write_file("ohne-ende.txt", "eins\nzwei");
    repo.write_file("latin1.txt", b"Gr\xfc\xdfe\n");
    let head = repo.commit("Basis");
    let tc = TestCore::new().await;
    let id = tc.open(&repo).await.repo.id;
    (tc, repo, id, head)
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
        let found =
            diff.hunks.iter().find_map(|h| h.lines.iter().position(|l| l.kind == kind && l.text == *text).map(|p| (h.index, p as u32)));
        let (hunk, pos) = found.unwrap_or_else(|| panic!("line {sign}{text} missing in {:#?}", diff.hunks));
        match hunks.iter_mut().find(|h| h.index == hunk) {
            Some(sel) => sel.lines.get_or_insert_with(Vec::new).push(pos),
            None => hunks.push(HunkSelection { index: hunk, lines: Some(vec![pos]) }),
        }
    }
    PatchSelection { path: diff.path.clone(), hunks, expect: diff.token.clone().expect("token missing") }
}

/// Every hunk of the file.
fn all(diff: &TextDiff) -> PatchSelection {
    let hunks = diff.hunks.iter().map(|h| HunkSelection { index: h.index, lines: None }).collect();
    PatchSelection { path: diff.path.clone(), hunks, expect: diff.token.clone().expect("token missing") }
}

fn blob(repo: &TestRepo, spec: &str) -> Vec<u8> {
    let out = repo.git_output(&["cat-file", "blob", spec]);
    assert!(out.status.success(), "cat-file {spec}: {}", String::from_utf8_lossy(&out.stderr));
    out.stdout
}

fn git(repo: &TestRepo, args: &[&str]) -> String {
    let mut all = vec!["-c", "core.quotepath=false"];
    all.extend_from_slice(args);
    repo.git(&all)
}

fn top_undo(tc: &TestCore, id: &str) -> Option<UndoEntry> {
    crate::undo::next_undo(tc, id, "").unwrap()
}

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

/// HEAD, the staged diff, the files, the backup refs and the top undo entry: what must not change
/// when a commit is refused.
fn state(tc: &TestCore, repo: &TestRepo, id: &str) -> (String, String, Vec<Vec<u8>>, String, Option<String>) {
    let files = FILES.iter().map(|f| repo.read_file(f)).collect();
    (
        repo.head(),
        repo.git(&["diff", "--cached"]),
        files,
        repo.git(&["for-each-ref", "refs/forkyard/undo"]),
        top_undo(tc, id).map(|entry| entry.id),
    )
}

async fn commit(tc: &TestCore, id: &str, selections: Vec<PatchSelection>, head: &str) -> CoreResult<CommitResult> {
    commit_selection(tc, id.to_string(), crate::util::new_id(), selections, "Auswahl".into(), "".into(), false, head.to_string()).await
}

#[tokio::test]
async fn commits_exactly_the_selected_lines_of_two_files() {
    let (tc, repo, id, head) = setup().await;
    repo.write_file("a.txt", "EINS\nzwei\ndrei\nvier\n");
    repo.write_file("c.txt", "y\n");
    repo.git(&["add", "a.txt", "c.txt"]);
    repo.write_file("a.txt", "EINS\nzwei\nDREI\nVIER\n");
    repo.write_file("b ä.txt", "alpha\nbeta\ngamma\ndelta\n");
    let selections = vec![
        pick(&diff(&tc, &id, "a.txt", false).await, &[("-", "drei"), ("+", "DREI")]),
        pick(&diff(&tc, &id, "b ä.txt", false).await, &[("+", "gamma")]),
    ];

    let result =
        commit_selection(&tc, id.clone(), "op1".into(), selections, "Auswahl".into(), "".into(), false, head.clone()).await.unwrap();

    assert_eq!(repo.git(&["rev-parse", "HEAD~1"]), head);
    assert_eq!(git(&repo, &["show", "HEAD:a.txt"]), "eins\nzwei\nDREI\nvier");
    assert_eq!(git(&repo, &["show", "HEAD:b ä.txt"]), "alpha\nbeta\ngamma");
    assert_eq!(git(&repo, &["diff", "--name-only", "HEAD~1", "HEAD"]), "a.txt\nb ä.txt");
    assert_eq!(repo.read_file("a.txt"), b"EINS\nzwei\nDREI\nVIER\n");
    assert_eq!(repo.read_file("b ä.txt"), b"alpha\nbeta\ngamma\ndelta\n");
    assert_eq!(git(&repo, &["diff", "--cached", "--name-only"]), "a.txt\nc.txt");
    assert_eq!(git(&repo, &["show", ":a.txt"]), "EINS\nzwei\nDREI\nvier");
    assert_eq!(git(&repo, &["show", ":c.txt"]), "y");
    let entry = top_undo(&tc, &id).expect("undo entry missing");
    assert_eq!(entry.action, "commit");
    assert_eq!(entry.label, "Undo commit ‘Auswahl’");
    assert_eq!(result.sha, repo.head());
}

#[tokio::test]
async fn crlf_missing_newline_and_latin1_stay_bytes() {
    let (tc, repo, id, head) = setup().await;
    repo.write_file("crlf.txt", "eins\r\nZWEI\r\ndrei\r\n");
    repo.write_file("ohne-ende.txt", "eins\nzwei\ndrei");
    repo.write_file("latin1.txt", b"Gr\xfc\xdfe\n\xc4rger\n");
    let before: Vec<Vec<u8>> = FILES.iter().map(|f| repo.read_file(f)).collect();
    let selections = vec![
        pick(&diff(&tc, &id, "crlf.txt", false).await, &[("+", "drei")]),
        all(&diff(&tc, &id, "ohne-ende.txt", false).await),
        pick(&diff(&tc, &id, "latin1.txt", false).await, &[("+", "Ärger")]),
    ];

    commit(&tc, &id, selections, &head).await.unwrap();

    assert_eq!(blob(&repo, "HEAD:crlf.txt"), b"eins\r\nzwei\r\ndrei\r\n");
    assert_eq!(blob(&repo, "HEAD:ohne-ende.txt"), b"eins\nzwei\ndrei");
    assert_eq!(blob(&repo, "HEAD:latin1.txt"), b"Gr\xfc\xdfe\n\xc4rger\n");
    assert_eq!(blob(&repo, ":crlf.txt"), b"eins\r\nzwei\r\ndrei\r\n", "the index follows the new HEAD");
    let after: Vec<Vec<u8>> = FILES.iter().map(|f| repo.read_file(f)).collect();
    assert_eq!(after, before, "working directory byte-identical");
}

#[tokio::test]
async fn an_untracked_file_with_part_of_its_lines() {
    let (tc, repo, id, head) = setup().await;
    repo.write_file("neu ü.txt", "a\nb\nc\n");
    let selections = vec![pick(&diff(&tc, &id, "neu ü.txt", false).await, &[("+", "a"), ("+", "c")])];

    commit(&tc, &id, selections, &head).await.unwrap();

    assert_eq!(git(&repo, &["show", "HEAD:neu ü.txt"]), "a\nc");
    assert_eq!(repo.read_file("neu ü.txt"), b"a\nb\nc\n");
    assert_eq!(git(&repo, &["status", "--porcelain", "-z", "--", "neu ü.txt"]), " M neu ü.txt\0");
}

#[tokio::test]
async fn a_selection_that_collides_with_staged_changes_is_refused() {
    let (tc, repo, id, head) = setup().await;
    repo.write_file("a.txt", "eins\nZWEI\ndrei\nvier\n");
    repo.git(&["add", "a.txt"]);
    repo.write_file("a.txt", "eins\nZwei!\ndrei\nvier\n");
    let selections = vec![pick(&diff(&tc, &id, "a.txt", false).await, &[("-", "ZWEI"), ("+", "Zwei!")])];
    let before = state(&tc, &repo, &id);

    let err = commit(&tc, &id, selections, &head).await.unwrap_err();

    assert_eq!(err.code, ErrorCode::SelectionConflictsWithIndex);
    assert!(err.message.contains("a.txt"), "{}", err.message);
    assert_eq!(state(&tc, &repo, &id), before);
}

#[tokio::test]
async fn stale_head_or_token_changes_nothing() {
    let (tc, repo, id, head) = setup().await;
    repo.write_file("c.txt", "y\n");
    repo.git(&["add", "c.txt"]);
    repo.write_file("a.txt", "eins\nzwei\nDREI\nvier\n");
    let picked = pick(&diff(&tc, &id, "a.txt", false).await, &[("+", "DREI")]);
    let before = state(&tc, &repo, &id);
    let other = repo.git(&["rev-parse", "HEAD~1"]);

    let err = commit(&tc, &id, vec![picked.clone()], &other).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::StaleState);
    assert_eq!(state(&tc, &repo, &id), before);

    let stale = PatchSelection { expect: "x".into(), ..picked.clone() };
    let err = commit(&tc, &id, vec![stale], &head).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::StaleState);
    assert_eq!(state(&tc, &repo, &id), before);

    let err = commit(&tc, &id, vec![], &head).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NothingToCommit);
    let err = commit(&tc, &id, vec![PatchSelection { hunks: vec![], ..picked }], &head).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NothingToCommit);
    assert_eq!(state(&tc, &repo, &id), before);
}

#[tokio::test]
async fn hooks_see_only_the_selection() {
    let (tc, repo, id, head) = setup().await;
    std::fs::write(repo.path().join(".git/info/exclude"), "gesehen.txt\n").unwrap();
    write_hook(&repo, "pre-commit", "git diff --cached --name-only > gesehen.txt");
    repo.write_file("c.txt", "y\n");
    repo.git(&["add", "c.txt"]);
    repo.write_file("a.txt", "eins\nzwei\nDREI\nvier\n");
    repo.write_file("b ä.txt", "alpha\nbeta\ngamma\n");
    let selections = vec![pick(&diff(&tc, &id, "a.txt", false).await, &[("-", "drei"), ("+", "DREI")])];

    commit(&tc, &id, selections, &head).await.unwrap();

    assert_eq!(std::fs::read_to_string(repo.path().join("gesehen.txt")).unwrap(), "a.txt\n");
    assert_eq!(git(&repo, &["diff", "--cached", "--name-only"]), "c.txt");
}

#[tokio::test]
async fn a_hook_that_changes_files_takes_the_commit_back() {
    let (tc, repo, id, head) = setup().await;
    write_hook(&repo, "pre-commit", r#"printf 'vom Hook\n' >> "b ä.txt""#);
    repo.write_file("c.txt", "y\n");
    repo.git(&["add", "c.txt"]);
    repo.write_file("a.txt", "eins\nzwei\nDREI\nvier\n");
    let selections = vec![pick(&diff(&tc, &id, "a.txt", false).await, &[("-", "drei"), ("+", "DREI")])];
    let cached = repo.git(&["diff", "--cached"]);

    let err = commit(&tc, &id, selections, &head).await.unwrap_err();

    assert_eq!(err.code, ErrorCode::HookFailed, "{}", err.message);
    assert_eq!(repo.head(), head);
    assert_eq!(repo.git(&["diff", "--cached"]), cached);
    assert_eq!(repo.read_file("b ä.txt"), b"alpha\nbeta\nvom Hook\n", "the hook's change stays");
    assert!(top_undo(&tc, &id).is_none(), "no undo entry");
}
