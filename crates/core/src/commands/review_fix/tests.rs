//! The patch of a fix (`line_patch`) applied with Git itself, and the range and fixup target of a pull
//! request against real repositories (rename, rebase, merge from the target, old dates, odd paths).

use super::*;
use crate::error::ErrorCode;
use crate::testkit::{TestCore, TestRepo};

fn text(patch: &LinePatch) -> String {
    String::from_utf8_lossy(&patch.patch).into_owned()
}

/// Commits `bytes` as `path`, applies the patch with `git apply --check --index` and `git apply --index`
/// and returns the file afterwards – Git is the judge of the patch.
fn applied(path: &str, bytes: &[u8], start: u32, end: u32, new_text: &str) -> Vec<u8> {
    let repo = TestRepo::with_commit();
    repo.write_file(path, bytes);
    repo.commit("Datei");
    let patch = line_patch(path, bytes, start, end, new_text).unwrap();
    let file = repo.temp_dir().join("fix.patch");
    std::fs::write(&file, &patch.patch).unwrap();
    repo.git(&["apply", "--check", "--index", file.to_str().unwrap()]);
    repo.git(&["apply", "--index", file.to_str().unwrap()]);
    repo.read_file(path)
}

#[test]
fn line_patch_keeps_bytes_crlf_latin1_bom_and_missing_newline() {
    // CRLF: the new lines get the file's line ending, the others keep theirs.
    assert_eq!(applied("a.txt", b"eins\r\nzwei\r\ndrei\r\nvier\r\n", 2, 3, "ZWEI\nDREI\nneu"), b"eins\r\nZWEI\r\nDREI\r\nneu\r\nvier\r\n");
    // No final newline: replacing the last line keeps it open; replacing another line leaves it alone.
    assert_eq!(applied("b.txt", b"a\nb\nc", 3, 3, "C"), b"a\nb\nC");
    assert_eq!(applied("b.txt", b"a\nb\nc", 2, 2, "B\nB2\n"), b"a\nB\nB2\nc");
    // Latin-1 (windows-1252): the text goes back in the file's encoding.
    assert_eq!(applied("l.txt", b"Gr\xfc\xdfe\nzwei\n", 1, 1, "Grüße, neu"), b"Gr\xfc\xdfe, neu\nzwei\n");
    // UTF-8 with BOM: the mark stays in front of the first line.
    assert_eq!(applied("bom.txt", b"\xef\xbb\xbferste\nzweite\n", 1, 1, "Erste"), b"\xef\xbb\xbfErste\nzweite\n");
    // Deleting lines; inserting by replacing one line with two.
    assert_eq!(applied("d.txt", b"1\n2\n3\n4\n5\n", 2, 4, ""), b"1\n5\n");
    assert_eq!(applied("i.txt", b"1\n2\n", 1, 1, "1\n1a"), b"1\n1a\n2\n");
    // The hunk itself, character for character.
    let patch = line_patch("b.txt", b"a\nb\nc", 3, 3, "C").unwrap();
    assert_eq!(text(&patch), "diff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -1,3 +1,3 @@\n a\n b\n-c\n\\ No newline at end of file\n+C\n\\ No newline at end of file\n");
    assert_eq!(patch.old_text, "c");
    let shown: Vec<(ReviewFixLineKind, &str, Option<u32>, Option<u32>)> = patch.lines.iter().map(|l| (l.kind, l.text.as_str(), l.old, l.new)).collect();
    assert_eq!(
        shown,
        vec![
            (ReviewFixLineKind::Context, "a", Some(1), Some(1)),
            (ReviewFixLineKind::Context, "b", Some(2), Some(2)),
            (ReviewFixLineKind::Removed, "c", Some(3), None),
            (ReviewFixLineKind::Added, "C", None, Some(3)),
        ]
    );
    // Line numbers after the range follow the new length.
    let grown = line_patch("g.txt", b"1\n2\n3\n4\n", 2, 2, "2a\n2b").unwrap();
    assert_eq!(grown.lines.last().map(|l| (l.text.as_str(), l.old, l.new)), Some(("4", Some(4), Some(5))));
    assert_eq!(line_patch("l.txt", b"Gr\xfc\xdfe\nzwei\n", 1, 1, "Grüße, neu").unwrap().old_text, "Grüße", "shown decoded");
}

#[test]
fn line_patch_applies_with_git_for_odd_paths_and_huge_files() {
    for path in ["-x/Grüße Datei.txt", "ordner mit leer/ä.txt", "[klammer] notiz.md"] {
        assert_eq!(applied(path, b"eins\nzwei\n", 2, 2, "ZWEI"), b"eins\nZWEI\n", "{path}");
    }
    #[cfg(unix)]
    assert_eq!(applied("tab\tund \"quote\".txt", b"x\n", 1, 1, "y"), b"y\n", "a path Git quotes");
    let huge: String = (1..=200_000).map(|n| format!("Zeile {n}\n")).collect();
    let patch = line_patch("gross.txt", huge.as_bytes(), 100_000, 100_000, "geändert").unwrap();
    assert_eq!(patch.lines.len(), 8, "3 + 1 + 1 + 3 lines, not the whole file");
    assert!(patch.patch.len() < 400);
    assert_eq!(applied("gross.txt", huge.as_bytes(), 100_000, 100_000, "geändert"), huge.replace("Zeile 100000\n", "geändert\n").into_bytes());
}

#[test]
fn line_patch_refuses_what_it_cannot_build_exactly() {
    let refused = |bytes: &[u8], start: u32, end: u32, text: &str| line_patch("f.txt", bytes, start, end, text).unwrap_err().code;
    let file = b"a\nb\nc\n";
    assert_eq!(refused(file, 0, 1, "x"), ErrorCode::NotAllowed, "lines start at 1");
    assert_eq!(refused(file, 3, 2, "x"), ErrorCode::NotAllowed, "start after end");
    assert_eq!(refused(file, 2, 4, "x"), ErrorCode::NotAllowed, "past the end");
    assert_eq!(refused(file, 2, 2, "b"), ErrorCode::NotAllowed, "changes nothing");
    assert_eq!(refused(file, 2, 2, "b\0"), ErrorCode::NotAllowed, "NUL");
    assert_eq!(refused(file, 2, 2, &"x".repeat(MAX_NEW_TEXT + 1)), ErrorCode::NotAllowed, "too long");
    assert_eq!(refused(b"a\0b\n", 1, 1, "x"), ErrorCode::NotAllowed, "binary");
    assert_eq!(refused(b"\xff\xfea\x00\n\x00", 1, 1, "x"), ErrorCode::NotAllowed, "UTF-16");
    assert_eq!(refused(b"Gr\xfc\xdfe\n", 1, 1, "Haken \u{2713}"), ErrorCode::NotAllowed, "a character windows-1252 does not have");
    assert_eq!(refused(b"\xef\xbb\xbfeins\nzwei\n", 1, 1, ""), ErrorCode::NotAllowed, "the line with the BOM is not deleted");
}

/// Ten lines `Zeile 1` … `Zeile 10`, the given ones replaced.
fn ten(changes: &[(usize, &str)]) -> String {
    (1..=10).map(|n| changes.iter().find(|(i, _)| *i == n).map(|(_, t)| format!("{t}\n")).unwrap_or_else(|| format!("Zeile {n}\n"))).collect()
}

/// main: `a.txt` (ten lines) and `b.txt`; `feature`: P1 changes lines 3–4, P2 renames `a.txt` to
/// `neu/ä b.txt` and changes line 8 (dated 2001 in +14:00), P3 adds `c.txt`; `refs/remotes/origin/main`
/// is main, as after a fetch.
fn feature_repo() -> (TestRepo, [String; 4]) {
    let repo = TestRepo::with_commit();
    repo.write_file("a.txt", ten(&[]));
    repo.write_file("b.txt", "bleibt\n");
    let main = repo.commit("Grundlage");
    repo.git(&["update-ref", "refs/remotes/origin/main", &main]);
    repo.checkout_new("feature");
    let p1 = repo.commit_file("a.txt", ten(&[(3, "drei"), (4, "vier")]), "Zeilen 3 und 4");
    repo.subdir("neu");
    repo.git(&["mv", "a.txt", "neu/ä b.txt"]);
    repo.write_file("neu/ä b.txt", ten(&[(3, "drei"), (4, "vier"), (8, "acht")]));
    let p2 = repo.commit_as("Umbenannt, Zeile 8", "Ada Lovelace", "ada@example.org", "@978307200 +1400");
    let p3 = repo.commit_file("c.txt", "neu\n", "Dritte Datei");
    (repo, [main, p1, p2, p3])
}

#[tokio::test]
async fn the_range_is_the_pull_requests_own_commits_newest_first() {
    let (repo, [main, p1, p2, p3]) = feature_repo();
    let tc = TestCore::new().await;
    let id = tc.open(&repo).await.repo.id;
    let range = pr_range(&tc, &id, &p3, "refs/remotes/origin/main").await.unwrap();
    assert_eq!((range.base.as_str(), range.head.as_str()), (main.as_str(), p3.as_str()));
    let commits: Vec<(&str, &str, Option<FixupReason>)> = range.commits.iter().map(|c| (c.sha.as_str(), c.summary.as_str(), c.reason)).collect();
    assert_eq!(commits, vec![(p3.as_str(), "Dritte Datei", None), (p2.as_str(), "Umbenannt, Zeile 8", None), (p1.as_str(), "Zeilen 3 und 4", None)]);
    assert_eq!(changed_paths(&tc, &id, &range).await.unwrap(), ["c.txt", "neu/ä b.txt"], "renamed files under their new name");
    assert_eq!(head_blob(&tc, &id, &p3, "neu/ä b.txt").await.unwrap(), ten(&[(3, "drei"), (4, "vier"), (8, "acht")]).into_bytes());
    assert_eq!(head_blob(&tc, &id, &p3, "fehlt.txt").await.unwrap_err().code, ErrorCode::NotFound);
    // Missing pieces are named, not guessed.
    assert_eq!(pr_range(&tc, &id, &"f".repeat(40), "refs/remotes/origin/main").await.unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(pr_range(&tc, &id, "--all", "refs/remotes/origin/main").await.unwrap_err().code, ErrorCode::NotFound);
    let error = pr_range(&tc, &id, &p3, "refs/remotes/origin/fehlt").await.unwrap_err();
    assert_eq!(error.code, ErrorCode::NotFound);
    assert!(error.message.contains("Fetch"), "{}", error.message);
    assert_eq!(target_ref("origin", "release/1.2").unwrap(), "refs/remotes/origin/release/1.2");
    assert_eq!(target_ref("origin", "-x").unwrap_err().code, ErrorCode::NotAllowed);
    assert_eq!(target_ref("origin", "a..b").unwrap_err().code, ErrorCode::NotAllowed);
    repo.git(&["checkout", "-q", "--orphan", "fremd"]);
    repo.git(&["rm", "-rfq", "."]);
    let lonely = repo.commit_file("x.txt", "x\n", "Fremd");
    assert_eq!(pr_range(&tc, &id, &lonely, "refs/remotes/origin/main").await.unwrap_err().code, ErrorCode::NotAllowed, "unrelated histories");
}

#[tokio::test]
async fn the_fixup_target_follows_blame_inside_the_pull_request() {
    let (repo, [_, p1, p2, p3]) = feature_repo();
    let tc = TestCore::new().await;
    let id = tc.open(&repo).await.repo.id;
    let range = pr_range(&tc, &id, &p3, "refs/remotes/origin/main").await.unwrap();
    let target = |start: u32, end: u32| fixup_target(&tc, &id, &range, "neu/ä b.txt", start, end);
    let found = target(3, 4).await.unwrap().unwrap();
    assert_eq!((found.sha.as_str(), found.summary.as_str(), found.reason), (p1.as_str(), "Zeilen 3 und 4", Some(FixupReason::Blame)), "lines 3–4 came from P1, before the rename");
    assert_eq!(target(8, 8).await.unwrap().unwrap().sha, p2);
    assert_eq!(target(3, 8).await.unwrap().unwrap().sha, p2, "lines of two commits: the newer one");
    let fallback = target(1, 2).await.unwrap().unwrap();
    assert_eq!((fallback.sha.as_str(), fallback.reason), (p2.as_str(), Some(FixupReason::File)), "lines from main: the newest pull request commit that changes the file");
    assert_eq!(fixup_target(&tc, &id, &range, "b.txt", 1, 1).await.unwrap(), None, "a file the pull request does not change: the user chooses");
}

#[tokio::test]
async fn after_a_rebase_and_a_merge_from_main_the_target_is_still_a_pull_request_commit() {
    let (repo, _) = feature_repo();
    repo.checkout("main");
    repo.commit_file("b.txt", "neu auf main\n", "Neu auf main");
    repo.checkout("feature");
    repo.git(&["rebase", "-q", "main"]);
    repo.checkout("main");
    repo.commit_file("a.txt", ten(&[(1, "eins von main")]), "Zeile 1 auf main");
    let main_tip = repo.head();
    repo.git(&["update-ref", "refs/remotes/origin/main", &main_tip]);
    repo.checkout("feature");
    repo.git(&["merge", "-q", "--no-edit", "main"]);
    let head = repo.head();
    let tc = TestCore::new().await;
    let id = tc.open(&repo).await.repo.id;
    let range = pr_range(&tc, &id, &head, "refs/remotes/origin/main").await.unwrap();
    assert_eq!(range.base, main_tip);
    let subjects: Vec<&str> = range.commits.iter().map(|c| c.summary.as_str()).collect();
    assert_eq!(subjects, ["Dritte Datei", "Umbenannt, Zeile 8", "Zeilen 3 und 4"], "the merge commit is never a target");
    let rebased_p1 = range.commits[2].sha.clone();
    assert_eq!(fixup_target(&tc, &id, &range, "neu/ä b.txt", 3, 4).await.unwrap().unwrap().sha, rebased_p1);
    let line1 = fixup_target(&tc, &id, &range, "neu/ä b.txt", 1, 1).await.unwrap().unwrap();
    assert_eq!((line1.sha.as_str(), line1.reason), (range.commits[1].sha.as_str(), Some(FixupReason::File)), "line 1 came from main through the merge");
}
