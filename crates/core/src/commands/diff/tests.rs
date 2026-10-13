//! Tests for `diff_file` against real temp repositories.

use base64::Engine;

use super::*;
use crate::error::ErrorCode;
use crate::events::names;
use crate::model::{DiffLine, DiffLineKind, TextDiff};
use crate::testkit::{TestCore, TestRepo};

async fn open(repo: &TestRepo) -> (TestCore, String) {
    let tc = TestCore::new().await;
    let id = tc.open(repo).await.repo.id;
    (tc, id)
}

/// The tests here call `diff_file` without a given encoding.
async fn diff_file(
    core: &crate::Core,
    repo_id: String,
    path: String,
    source: DiffSource,
    force: Option<bool>,
    ignore_whitespace: Option<bool>,
) -> CoreResult<FileDiff> {
    super::diff_file(core, repo_id, path, source, force, ignore_whitespace, None).await
}

async fn diff(tc: &TestCore, id: &str, path: &str, source: DiffSource) -> FileDiff {
    diff_file(tc, id.to_string(), path.to_string(), source, None, None).await.unwrap_or_else(|e| panic!("{path}: {e:?}"))
}

fn text(diff: FileDiff) -> TextDiff {
    match diff {
        FileDiff::Text(text) => text,
        other => panic!("Text-Diff erwartet, bekommen: {other:?}"),
    }
}

async fn text_of(tc: &TestCore, id: &str, path: &str, source: DiffSource) -> TextDiff {
    text(diff(tc, id, path, source).await)
}

/// Lines as `+text`, `-text`, ` text`.
fn signed(lines: &[DiffLine]) -> Vec<String> {
    lines
        .iter()
        .map(|l| {
            let sign = match l.kind {
                DiffLineKind::Context => ' ',
                DiffLineKind::Add => '+',
                DiffLineKind::Remove => '-',
            };
            format!("{sign}{}", l.text)
        })
        .collect()
}

fn all_signed(diff: &TextDiff) -> Vec<String> {
    diff.hunks.iter().flat_map(|h| signed(&h.lines)).collect()
}

const RUST_FILE: &str = "fn main() {\n    let a = 1;\n    let b = 2;\n    let c = 3;\n    let d = 4;\n    let e = 5;\n    let f = 6;\n    let g = 7;\n}\n";

#[tokio::test]
async fn unstaged_modification_with_numbers_section_and_texts() {
    let repo = TestRepo::new();
    repo.commit_file("src/main.rs", RUST_FILE, "Basis");
    let work = RUST_FILE.replace("let e = 5;", "let e = 50;\n    let neu = 0;");
    repo.write_file("src/main.rs", &work);
    let (tc, id) = open(&repo).await;
    tc.events.clear();

    let d = text_of(&tc, &id, "src/main.rs", DiffSource::Unstaged).await;
    assert_eq!(d.path, "src/main.rs");
    assert_eq!(d.old_path, None);
    assert_eq!(d.status, FileStatus::Modified);
    assert_eq!(d.encoding, "utf-8");
    assert_eq!(d.old_text.as_deref(), Some(RUST_FILE));
    assert_eq!(d.new_text.as_deref(), Some(work.as_str()));
    assert_eq!(d.token.as_ref().map(String::len), Some(32));
    assert_eq!(d.hunks.len(), 1);
    let h = &d.hunks[0];
    assert_eq!((h.index, h.old_start, h.old_lines, h.new_start, h.new_lines), (0, 3, 7, 3, 8));
    assert_eq!(h.section, "fn main() {");
    assert_eq!(
        signed(&h.lines),
        vec!["     let b = 2;", "     let c = 3;", "     let d = 4;", "-    let e = 5;", "+    let e = 50;", "+    let neu = 0;", "     let f = 6;", "     let g = 7;", " }"]
    );
    let numbers: Vec<(Option<u32>, Option<u32>)> = h.lines.iter().map(|l| (l.old_no, l.new_no)).collect();
    assert_eq!(
        numbers,
        vec![
            (Some(3), Some(3)),
            (Some(4), Some(4)),
            (Some(5), Some(5)),
            (Some(6), None),
            (None, Some(6)),
            (None, Some(7)),
            (Some(7), Some(8)),
            (Some(8), Some(9)),
            (Some(9), Some(10)),
        ]
    );
    assert!(h.lines.iter().all(|l| !l.no_newline));
    // Pure read command: no event, no log entry.
    assert_eq!(tc.events.count(names::REPO_CHANGED), 0);
    assert_eq!(tc.events.count(names::LOG_APPENDED), 0);
}

#[tokio::test]
async fn several_hunks_are_numbered() {
    let repo = TestRepo::new();
    let base: Vec<String> = (1..=40).map(|n| format!("zeile {n}")).collect();
    repo.commit_file("f.txt", base.join("\n") + "\n", "Basis");
    let mut work = base.clone();
    work[2] = "DREI".into();
    work[30] = "EINUNDDREISSIG".into();
    repo.write_file("f.txt", work.join("\n") + "\n");
    let (tc, id) = open(&repo).await;
    let d = text_of(&tc, &id, "f.txt", DiffSource::Unstaged).await;
    assert_eq!(d.hunks.len(), 2);
    assert_eq!(d.hunks[1].index, 1);
    assert_eq!((d.hunks[1].old_start, d.hunks[1].old_lines), (28, 7));
    assert_eq!(d.hunks[1].lines[3].old_no, Some(31));
}

#[tokio::test]
async fn untracked_file_is_all_added() {
    let repo = TestRepo::with_commit();
    repo.write_file("neu ordner/neue datei.txt", "eins\nzwei\n");
    let (tc, id) = open(&repo).await;
    let d = text_of(&tc, &id, "neu ordner/neue datei.txt", DiffSource::Unstaged).await;
    assert_eq!(d.status, FileStatus::Untracked);
    assert_eq!(all_signed(&d), vec!["+eins", "+zwei"]);
    assert_eq!(d.hunks[0].lines[1].new_no, Some(2));
    assert_eq!(d.old_text, None);
    assert_eq!(d.new_text.as_deref(), Some("eins\nzwei\n"));
    assert!(d.token.is_some());
    // The real index stays untouched, and no helper file is left behind.
    assert!(repo.git(&["ls-files"]).lines().all(|l| l == "README.md"));
    let names = |dir: std::path::PathBuf| -> Vec<String> { std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect() };
    let leftovers = names(tc.data_dir().join("tmp"));
    assert!(leftovers.is_empty(), "{leftovers:?}");
    let mut in_git_dir = names(repo.path().join(".git"));
    in_git_dir.sort();
    assert!(!in_git_dir.iter().any(|n| n.contains("lock") || n.starts_with("forkyard")), "{in_git_dir:?}");

    // Empty untracked file: text without hunks.
    repo.write_file("leer.txt", "");
    let d = text_of(&tc, &id, "leer.txt", DiffSource::Unstaged).await;
    assert_eq!(d.status, FileStatus::Untracked);
    assert!(d.hunks.is_empty());
}

#[tokio::test]
async fn staged_diff_also_in_an_empty_repo() {
    let repo = TestRepo::new();
    repo.write_file("a.txt", "eins\nzwei\n");
    repo.git(&["add", "a.txt"]);
    repo.write_file("a.txt", "eins\nzwei\nnur im Arbeitsverzeichnis\n");
    let (tc, id) = open(&repo).await;

    let d = text_of(&tc, &id, "a.txt", DiffSource::Staged).await;
    assert_eq!(d.status, FileStatus::Added);
    assert_eq!(all_signed(&d), vec!["+eins", "+zwei"]);
    assert_eq!(d.old_text, None);
    assert_eq!(d.new_text.as_deref(), Some("eins\nzwei\n"), "the version from the index");
    assert!(d.token.is_some());

    repo.commit("Erster");
    let (staged_text, unstaged_text) = ("eins\nZWEI\n", "eins\nZWEI\ndrei\n");
    repo.write_file("a.txt", staged_text);
    repo.git(&["add", "a.txt"]);
    repo.write_file("a.txt", unstaged_text);
    let s = text_of(&tc, &id, "a.txt", DiffSource::Staged).await;
    assert_eq!(all_signed(&s), vec![" eins", "-zwei", "-nur im Arbeitsverzeichnis", "+ZWEI"]);
    assert_eq!(s.old_text.as_deref(), Some("eins\nzwei\nnur im Arbeitsverzeichnis\n"));
    assert_eq!(s.new_text.as_deref(), Some(staged_text));
    let u = text_of(&tc, &id, "a.txt", DiffSource::Unstaged).await;
    assert_eq!(all_signed(&u), vec![" eins", " ZWEI", "+drei"]);
    assert_eq!(u.old_text.as_deref(), Some(staged_text));
    assert_ne!(s.token, u.token);
}

#[tokio::test]
async fn commit_diff_against_first_parent_and_root() {
    let repo = TestRepo::new();
    let root = repo.commit_file("a.txt", "eins\n", "Wurzel");
    let second = repo.commit_file("a.txt", "eins\nzwei\n", "Zweiter");
    repo.checkout_new("feature");
    repo.commit_file("b.txt", "feature\n", "Feature");
    repo.checkout("main");
    repo.commit_file("a.txt", "eins\nzwei\ndrei\n", "Main");
    assert!(repo.merge("feature"));
    let merge = repo.head();
    let (tc, id) = open(&repo).await;

    let d = text_of(&tc, &id, "a.txt", DiffSource::Commit { sha: second.clone() }).await;
    assert_eq!(d.status, FileStatus::Modified);
    assert_eq!(all_signed(&d), vec![" eins", "+zwei"]);
    assert_eq!(d.token, None, "only unstaged and staged carry a token");
    assert_eq!(d.old_text.as_deref(), Some("eins\n"));

    let d = text_of(&tc, &id, "a.txt", DiffSource::Commit { sha: root }).await;
    assert_eq!(d.status, FileStatus::Added);
    assert_eq!(all_signed(&d), vec!["+eins"]);

    // Merge commit: against the first parent, i.e. only what the merge brings in.
    let d = text_of(&tc, &id, "b.txt", DiffSource::Commit { sha: merge.clone() }).await;
    assert_eq!(d.status, FileStatus::Added);
    let unchanged = text_of(&tc, &id, "a.txt", DiffSource::Commit { sha: merge }).await;
    assert!(unchanged.hunks.is_empty());

    let missing = diff_file(&tc, id.clone(), "gibt-es-nicht.txt".into(), DiffSource::Commit { sha: second }, None, None).await;
    assert_eq!(missing.unwrap_err().code, ErrorCode::NotFound);
    let bad = diff_file(&tc, id, "a.txt".into(), DiffSource::Commit { sha: "--output=x".into() }, None, None).await;
    assert_eq!(bad.unwrap_err().code, ErrorCode::NotFound);
}

/// The file `ding` becomes a folder, the folder `ordner/` becomes a file. The diff of the
/// one file shows only its own lines – not those of the files in the folder of the same name.
#[tokio::test]
async fn file_swapped_with_a_folder_shows_only_its_own_lines() {
    let repo = TestRepo::new();
    repo.write_file("ding", "ich bin eine Datei\n");
    repo.write_file("ordner/a.txt", "a\n");
    repo.write_file("ordner/b.txt", "b\n");
    repo.commit("Datei und Ordner");
    repo.remove_file("ding");
    std::fs::remove_dir_all(repo.path().join("ordner")).unwrap();
    repo.write_file("ding/inhalt.txt", "jetzt bin ich ein Ordner\n");
    repo.write_file("ding/tief/noch-eins.txt", "tiefer\n");
    repo.write_file("ordner", "jetzt bin ich eine Datei\n");
    repo.git(&["add", "-A"]);
    let (tc, id) = open(&repo).await;

    let d = text_of(&tc, &id, "ding", DiffSource::Staged).await;
    assert_eq!((d.status, all_signed(&d)), (FileStatus::Deleted, vec!["-ich bin eine Datei".to_string()]));
    assert!(d.token.is_some(), "one section, so with a token for taking back individual lines");
    let d = text_of(&tc, &id, "ordner", DiffSource::Staged).await;
    assert_eq!((d.status, all_signed(&d)), (FileStatus::Added, vec!["+jetzt bin ich eine Datei".to_string()]));
    let d = text_of(&tc, &id, "ding/inhalt.txt", DiffSource::Staged).await;
    assert_eq!(all_signed(&d), vec!["+jetzt bin ich ein Ordner"]);

    let sha = repo.commit("Getauscht");
    let d = text_of(&tc, &id, "ding", DiffSource::Commit { sha: sha.clone() }).await;
    assert_eq!(all_signed(&d), vec!["-ich bin eine Datei"]);
    let d = text_of(&tc, &id, "ordner", DiffSource::Commit { sha }).await;
    assert_eq!(all_signed(&d), vec!["+jetzt bin ich eine Datei"]);
}

/// With `working-tree-encoding=UTF-16LE-BOM` the file is UTF-16 in the working directory
/// (raw, full of NUL bytes). Git compares the converted version – so it is a text diff.
#[tokio::test]
async fn working_tree_encoding_utf16_is_a_text_diff() {
    fn utf16le(text: &str) -> Vec<u8> {
        let mut bytes = vec![0xff, 0xfe];
        bytes.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
        bytes
    }
    let repo = TestRepo::new();
    repo.write_file(".gitattributes", "utf16.txt text working-tree-encoding=UTF-16LE-BOM eol=crlf\n");
    repo.write_file("utf16.txt", utf16le("Größe in °C\r\nzweite Zeile\r\n"));
    repo.commit("UTF-16 mit Attribut");
    repo.write_file("utf16.txt", utf16le("Größe in °C\r\nzweite Zeile\r\ndritte Zeile\r\n"));
    let (tc, id) = open(&repo).await;

    let d = text_of(&tc, &id, "utf16.txt", DiffSource::Unstaged).await;
    let added: Vec<String> = all_signed(&d).into_iter().filter(|line| line.starts_with('+')).collect();
    assert_eq!(added, vec!["+dritte Zeile"]);
    assert!(d.token.is_some(), "lines can be staged");

    // Without the attribute a UTF-16 file stays binary for Git – and therefore here too.
    repo.write_file("ohne-attribut.bin", utf16le("eins\r\n"));
    repo.commit("UTF-16 ohne Attribut");
    repo.write_file("ohne-attribut.bin", utf16le("eins\r\nzwei\r\n"));
    assert!(matches!(diff(&tc, &id, "ohne-attribut.bin", DiffSource::Unstaged).await, FileDiff::Binary { .. }));
}

#[test]
fn only_this_file_keeps_the_section_of_the_path() {
    let one = b"diff --git a/ding b/ding\ndeleted file mode 100644\n--- a/ding\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n".to_vec();
    let two = b"diff --git a/ding/inhalt.txt b/ding/inhalt.txt\nnew file mode 100644\n--- /dev/null\n+++ b/ding/inhalt.txt\n@@ -0,0 +1 @@\n+diff --git a/ding b/ding\n".to_vec();
    let both = [one.clone(), two.clone()].concat();
    assert_eq!(only_this_file(both.clone(), b"ding", None), one);
    assert_eq!(only_this_file(both.clone(), b"ding/inhalt.txt", None), two);
    // A single section stays as it is; without a match (path spelled differently) everything stays.
    assert_eq!(only_this_file(one.clone(), b"anders", None), one);
    assert_eq!(only_this_file(both.clone(), b"mit \"quote\"", None), both);
    // Rename: old and new path in the header line.
    let renamed = b"diff --git a/alt.txt b/neu.txt\nsimilarity index 90%\n".to_vec();
    let mixed = [renamed.clone(), two].concat();
    assert_eq!(only_this_file(mixed, b"neu.txt", Some(b"alt.txt")), renamed);
}

#[tokio::test]
async fn range_between_commits_and_to_the_worktree() {
    let repo = TestRepo::new();
    let first = repo.commit_file("a.txt", "eins\n", "Erster");
    repo.commit_file("a.txt", "eins\nzwei\n", "Zweiter");
    let third = repo.commit_file("a.txt", "eins\nzwei\ndrei\n", "Dritter");
    repo.write_file("a.txt", "eins\nzwei\ndrei\nlokal\n");
    repo.write_file("unverfolgt.txt", "x\n");
    let (tc, id) = open(&repo).await;

    let d = text_of(&tc, &id, "a.txt", DiffSource::Range { from: first.clone(), to: Some(third.clone()) }).await;
    assert_eq!(all_signed(&d), vec![" eins", "+zwei", "+drei"]);
    assert_eq!(d.token, None);
    // Opposite direction.
    let d = text_of(&tc, &id, "a.txt", DiffSource::Range { from: third, to: Some(first.clone()) }).await;
    assert_eq!(all_signed(&d), vec![" eins", "-zwei", "-drei"]);

    let d = text_of(&tc, &id, "a.txt", DiffSource::Range { from: first.clone(), to: None }).await;
    assert_eq!(all_signed(&d), vec![" eins", "+zwei", "+drei", "+lokal"]);
    assert_eq!(d.new_text.as_deref(), Some("eins\nzwei\ndrei\nlokal\n"));
    let d = text_of(&tc, &id, "unverfolgt.txt", DiffSource::Range { from: first, to: None }).await;
    assert_eq!(d.status, FileStatus::Untracked);
    assert_eq!(all_signed(&d), vec!["+x"]);
}

/// The empty tree as `from`: the combined diff of a series starting at the root commit.
#[tokio::test]
async fn range_from_the_empty_tree() {
    const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    let repo = TestRepo::new();
    repo.commit_file("a.txt", "eins\n", "Erster");
    let second = repo.commit_file("a.txt", "eins\nzwei\n", "Zweiter");
    repo.git(&["mv", "a.txt", "b.txt"]);
    let third = repo.commit("Umbenannt");
    repo.write_file("b.txt", "eins\nzwei\nlokal\n");
    let (tc, id) = open(&repo).await;

    let d = text_of(&tc, &id, "a.txt", DiffSource::Range { from: EMPTY_TREE.into(), to: Some(second) }).await;
    assert_eq!(d.status, FileStatus::Added);
    assert_eq!(all_signed(&d), vec!["+eins", "+zwei"]);
    assert_eq!((d.old_text.as_deref(), d.new_text.as_deref()), (None, Some("eins\nzwei\n")));
    let d = text_of(&tc, &id, "b.txt", DiffSource::Range { from: EMPTY_TREE.into(), to: Some(third.clone()) }).await;
    assert_eq!((d.status, d.old_path.as_deref()), (FileStatus::Added, None));
    // The file no longer exists at the end of the series.
    let gone = diff_file(&tc, id.clone(), "a.txt".into(), DiffSource::Range { from: EMPTY_TREE.into(), to: Some(third) }, None, None).await;
    assert_eq!(gone.unwrap_err().code, ErrorCode::NotFound);
    // Up to the working directory.
    let d = text_of(&tc, &id, "b.txt", DiffSource::Range { from: EMPTY_TREE.into(), to: None }).await;
    assert_eq!(all_signed(&d), vec!["+eins", "+zwei", "+lokal"]);
}

#[tokio::test]
async fn stash_diff_with_untracked_files() {
    let repo = TestRepo::new();
    repo.commit_file("a.txt", "eins\n", "Basis");
    repo.write_file("a.txt", "eins\ngestasht\n");
    repo.write_file("neu.txt", "unverfolgt\n");
    repo.git(&["stash", "push", "-u", "-m", "Test"]);
    let (tc, id) = open(&repo).await;

    let d = text_of(&tc, &id, "a.txt", DiffSource::Stash { index: 0 }).await;
    assert_eq!(d.status, FileStatus::Modified);
    assert_eq!(all_signed(&d), vec![" eins", "+gestasht"]);
    assert_eq!(d.token, None);
    let d = text_of(&tc, &id, "neu.txt", DiffSource::Stash { index: 0 }).await;
    assert_eq!(d.status, FileStatus::Added);
    assert_eq!(all_signed(&d), vec!["+unverfolgt"]);

    let missing = diff_file(&tc, id, "a.txt".into(), DiffSource::Stash { index: 5 }, None, None).await;
    assert_eq!(missing.unwrap_err().code, ErrorCode::NotFound);
}

#[tokio::test]
async fn no_newline_markers_on_both_sides() {
    let repo = TestRepo::new();
    repo.commit_file("f.txt", "a\nb", "Basis");
    repo.write_file("f.txt", "a\nB");
    let (tc, id) = open(&repo).await;
    let d = text_of(&tc, &id, "f.txt", DiffSource::Unstaged).await;
    let flags: Vec<(String, bool)> = d.hunks[0].lines.iter().map(|l| (l.text.clone(), l.no_newline)).collect();
    assert_eq!(flags, vec![("a".into(), false), ("b".into(), true), ("B".into(), true)]);
    assert_eq!(d.old_text.as_deref(), Some("a\nb"));
    assert_eq!(d.new_text.as_deref(), Some("a\nB"));
}

#[tokio::test]
async fn crlf_lines_come_without_carriage_return() {
    let repo = TestRepo::new();
    repo.commit_file("f.txt", "a\r\nb\r\n", "Basis");
    repo.write_file("f.txt", "a\r\nB\r\n");
    let (tc, id) = open(&repo).await;
    let d = text_of(&tc, &id, "f.txt", DiffSource::Unstaged).await;
    assert_eq!(all_signed(&d), vec![" a", "-b", "+B"]);
    assert_eq!(d.new_text.as_deref(), Some("a\r\nB\r\n"), "the full version stays unchanged");
}

#[tokio::test]
async fn binary_files_report_sizes() {
    let repo = TestRepo::new();
    repo.commit_file("daten.bin", [1u8, 0, 2, 3], "Basis");
    repo.write_file("daten.bin", [1u8, 0, 2, 3, 4, 5]);
    repo.write_file("neu.bin", [0u8; 10]);
    let (tc, id) = open(&repo).await;

    let d = diff(&tc, &id, "daten.bin", DiffSource::Unstaged).await;
    assert_eq!(d, FileDiff::Binary { path: "daten.bin".into(), old_path: None, status: FileStatus::Modified, old_size: Some(4), new_size: Some(6) });
    let d = diff(&tc, &id, "neu.bin", DiffSource::Unstaged).await;
    assert_eq!(d, FileDiff::Binary { path: "neu.bin".into(), old_path: None, status: FileStatus::Untracked, old_size: None, new_size: Some(10) });

    repo.git(&["rm", "-q", "--cached", "daten.bin"]);
    let d = diff(&tc, &id, "daten.bin", DiffSource::Staged).await;
    assert_eq!(d, FileDiff::Binary { path: "daten.bin".into(), old_path: None, status: FileStatus::Deleted, old_size: Some(4), new_size: None });
}

#[tokio::test]
async fn binary_by_attribute() {
    let repo = TestRepo::new();
    repo.write_file(".gitattributes", "*.dat binary\n");
    repo.commit_file("werte.dat", "nur text\n", "Basis");
    repo.write_file("werte.dat", "anderer text\n");
    let (tc, id) = open(&repo).await;
    let d = diff(&tc, &id, "werte.dat", DiffSource::Unstaged).await;
    assert!(matches!(d, FileDiff::Binary { old_size: Some(9), new_size: Some(13), .. }), "{d:?}");
}

#[tokio::test]
async fn images_come_as_data_urls() {
    let png_old: Vec<u8> = [&b"\x89PNG\r\n\x1a\n"[..], &[0u8, 1, 2, 3][..]].concat();
    let png_new: Vec<u8> = [&b"\x89PNG\r\n\x1a\n"[..], &[9u8, 8, 7, 0, 0][..]].concat();
    let repo = TestRepo::new();
    repo.commit_file("bilder/logo.PNG", &png_old, "Basis");
    repo.write_file("bilder/logo.PNG", &png_new);
    repo.write_file("neu.svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>\n");
    let (tc, id) = open(&repo).await;

    let decode = |url: &Option<String>, mime: &str| -> Vec<u8> {
        let url = url.as_ref().expect("data-URL");
        let data = url.strip_prefix(&format!("data:{mime};base64,")).unwrap_or_else(|| panic!("{url}"));
        base64::engine::general_purpose::STANDARD.decode(data).unwrap()
    };
    match diff(&tc, &id, "bilder/logo.PNG", DiffSource::Unstaged).await {
        FileDiff::Image { status, old_data_url, new_data_url, old_size, new_size, .. } => {
            assert_eq!(status, FileStatus::Modified);
            assert_eq!(decode(&old_data_url, "image/png"), png_old);
            assert_eq!(decode(&new_data_url, "image/png"), png_new);
            assert_eq!((old_size, new_size), (Some(12), Some(13)));
        }
        other => panic!("{other:?}"),
    }
    match diff(&tc, &id, "neu.svg", DiffSource::Unstaged).await {
        FileDiff::Image { status, old_data_url, new_data_url, .. } => {
            assert_eq!(status, FileStatus::Untracked);
            assert_eq!(old_data_url, None);
            assert!(decode(&new_data_url, "image/svg+xml").starts_with(b"<svg"));
        }
        other => panic!("{other:?}"),
    }
    // From a commit too.
    match diff(&tc, &id, "bilder/logo.PNG", DiffSource::Commit { sha: repo.head() }).await {
        FileDiff::Image { status, old_data_url, new_data_url, .. } => {
            assert_eq!(status, FileStatus::Added);
            assert_eq!(old_data_url, None);
            assert_eq!(decode(&new_data_url, "image/png"), png_old);
        }
        other => panic!("{other:?}"),
    }
}

fn lfs_pointer(oid: &str, size: u64) -> String {
    format!("version https://git-lfs.github.com/spec/v1\noid sha256:{oid}\nsize {size}\n")
}

#[tokio::test]
async fn lfs_pointers_are_recognised() {
    let (old_oid, new_oid) = ("a".repeat(64), "b".repeat(64));
    let repo = TestRepo::new();
    repo.commit_file("video.mp4", lfs_pointer(&old_oid, 1000), "Basis");
    repo.write_file("video.mp4", lfs_pointer(&new_oid, 2500));
    repo.write_file("neu.png", lfs_pointer(&new_oid, 7));
    let (tc, id) = open(&repo).await;

    let d = diff(&tc, &id, "video.mp4", DiffSource::Unstaged).await;
    assert_eq!(
        d,
        FileDiff::Lfs {
            path: "video.mp4".into(),
            old_path: None,
            status: FileStatus::Modified,
            old_oid: Some(old_oid.clone()),
            new_oid: Some(new_oid.clone()),
            old_size: Some(1000),
            new_size: Some(2500),
        }
    );
    // A pointer takes precedence over the image extension.
    let d = diff(&tc, &id, "neu.png", DiffSource::Unstaged).await;
    assert!(matches!(d, FileDiff::Lfs { old_oid: None, new_size: Some(7), .. }), "{d:?}");
}

/// With a clean filter set up (as with git-lfs installed) the working directory holds the
/// real content; the pointer only comes into being in the diff.
#[tokio::test]
async fn lfs_pointer_from_a_clean_filter() {
    let repo = TestRepo::new();
    let new_oid = "c".repeat(64);
    repo.write_file(".gitattributes", "*.big filter=fake\n");
    repo.commit_file("daten.big", lfs_pointer(&"a".repeat(64), 10), "Basis");
    repo.git(&["config", "filter.fake.clean", &format!("printf 'version https://git-lfs.github.com/spec/v1\\noid sha256:{new_oid}\\nsize 4242\\n'")]);
    repo.write_file("daten.big", "echter inhalt, kein zeiger\n");
    let (tc, id) = open(&repo).await;
    let d = diff(&tc, &id, "daten.big", DiffSource::Unstaged).await;
    assert!(
        matches!(&d, FileDiff::Lfs { old_size: Some(10), new_oid: Some(oid), new_size: Some(4242), .. } if *oid == new_oid),
        "{d:?}"
    );
}

#[tokio::test]
async fn too_large_by_lines_and_by_bytes() {
    let repo = TestRepo::with_commit();
    let many: String = (0..20_001).map(|n| format!("{n}\n")).collect();
    repo.write_file("viele.txt", &many);
    let long_line = "x".repeat(4000);
    let big: String = (0..300).map(|_| format!("{long_line}\n")).collect();
    repo.write_file("gross.txt", &big);
    let (tc, id) = open(&repo).await;

    let d = diff(&tc, &id, "viele.txt", DiffSource::Unstaged).await;
    assert_eq!(
        d,
        FileDiff::TooLarge { path: "viele.txt".into(), old_path: None, status: FileStatus::Untracked, bytes: many.len() as u64, lines: Some(20_001) }
    );
    let forced = text(diff_file(&tc, id.clone(), "viele.txt".into(), DiffSource::Unstaged, Some(true), None).await.unwrap());
    assert_eq!(forced.hunks[0].lines.len(), 20_001);
    assert!(forced.new_text.is_some());
    assert!(forced.token.is_some());

    let d = diff(&tc, &id, "gross.txt", DiffSource::Unstaged).await;
    assert_eq!(d, FileDiff::TooLarge { path: "gross.txt".into(), old_path: None, status: FileStatus::Untracked, bytes: big.len() as u64, lines: None });
    let forced = text(diff_file(&tc, id.clone(), "gross.txt".into(), DiffSource::Unstaged, Some(true), None).await.unwrap());
    assert_eq!(forced.hunks[0].lines.len(), 300);
    assert_eq!(forced.new_text, None, "the full version stays out above the size limit");

    // A large binary file is binary, not "too large".
    let mut blob = vec![7u8; 1_200_000];
    blob[100] = 0;
    repo.write_file("gross.bin", &blob);
    let d = diff(&tc, &id, "gross.bin", DiffSource::Unstaged).await;
    assert!(matches!(d, FileDiff::Binary { new_size: Some(1_200_000), .. }), "{d:?}");
}

#[tokio::test]
async fn latin1_is_detected_and_decoded() {
    let repo = TestRepo::new();
    repo.commit_file("alt.txt", b"Gr\xfc\xdfe\n", "Basis");
    repo.write_file("alt.txt", b"Gr\xfc\xdfe\nM\xe4rz\n");
    let (tc, id) = open(&repo).await;
    let d = text_of(&tc, &id, "alt.txt", DiffSource::Unstaged).await;
    assert_eq!(d.encoding, "windows-1252");
    assert_eq!(all_signed(&d), vec![" Grüße", "+März"]);
    assert_eq!(d.old_text.as_deref(), Some("Grüße\n"));
}

#[tokio::test]
async fn renames_carry_the_old_path() {
    let repo = TestRepo::new();
    let base: Vec<String> = (1..=12).map(|n| format!("zeile {n}")).collect();
    repo.commit_file("alter name.txt", base.join("\n") + "\n", "Basis");
    repo.subdir("ordner");
    repo.git(&["mv", "alter name.txt", "ordner/neuer näme.txt"]);
    let mut work = base.clone();
    work[5] = "SECHS".into();
    repo.write_file("ordner/neuer näme.txt", work.join("\n") + "\n");
    repo.git(&["add", "-A"]);
    let (tc, id) = open(&repo).await;

    let d = text_of(&tc, &id, "ordner/neuer näme.txt", DiffSource::Staged).await;
    assert_eq!(d.status, FileStatus::Renamed);
    assert_eq!(d.old_path.as_deref(), Some("alter name.txt"));
    assert_eq!(d.hunks.len(), 1);
    assert!(all_signed(&d).contains(&"-zeile 6".to_string()) && all_signed(&d).contains(&"+SECHS".to_string()));
    assert_eq!(d.old_text.as_deref(), Some((base.join("\n") + "\n").as_str()));
    // The old side of the rename is a deletion on its own.
    let old = text_of(&tc, &id, "alter name.txt", DiffSource::Staged).await;
    assert_eq!(old.status, FileStatus::Deleted);

    let sha = repo.commit("Umbenannt");
    let d = text_of(&tc, &id, "ordner/neuer näme.txt", DiffSource::Commit { sha }).await;
    assert_eq!(d.status, FileStatus::Renamed);
    assert_eq!(d.old_path.as_deref(), Some("alter name.txt"));

    // Pure rename without changes.
    repo.git(&["mv", "ordner/neuer näme.txt", "zurück.txt"]);
    let d = text_of(&tc, &id, "zurück.txt", DiffSource::Staged).await;
    assert_eq!(d.status, FileStatus::Renamed);
    assert!(d.hunks.is_empty());
}

#[tokio::test]
async fn deleted_new_mode_change_and_submodule_do_not_crash() {
    let repo = TestRepo::new();
    repo.write_file("weg.txt", "eins\nzwei\n");
    repo.write_file("skript.sh", "#!/bin/sh\n");
    let first = repo.commit("Basis");
    repo.remove_file("weg.txt");
    repo.git(&["update-index", "--chmod=+x", "skript.sh"]);
    repo.git(&["update-index", "--add", "--cacheinfo", &format!("160000,{first},modul")]);
    let (tc, id) = open(&repo).await;

    let d = text_of(&tc, &id, "weg.txt", DiffSource::Unstaged).await;
    assert_eq!(d.status, FileStatus::Deleted);
    assert_eq!(all_signed(&d), vec!["-eins", "-zwei"]);
    assert_eq!(d.new_text, None);
    assert_eq!(d.old_text.as_deref(), Some("eins\nzwei\n"));

    // Only the mode changed: text without hunks.
    let d = text_of(&tc, &id, "skript.sh", DiffSource::Staged).await;
    assert_eq!(d.status, FileStatus::Modified);
    assert!(d.hunks.is_empty());

    // Submodule entry (gitlink) in the index.
    let d = text_of(&tc, &id, "modul", DiffSource::Staged).await;
    assert_eq!(d.status, FileStatus::Added);
    assert_eq!(all_signed(&d), vec![format!("+Subproject commit {first}")]);
    assert_eq!(d.token, None, "no line staging for submodules");
    let d = diff(&tc, &id, "modul", DiffSource::Unstaged).await;
    assert!(matches!(d, FileDiff::Text(_)), "{d:?}");

    repo.git(&["rm", "-q", "--cached", "weg.txt"]);
    let d = text_of(&tc, &id, "weg.txt", DiffSource::Staged).await;
    assert_eq!(d.status, FileStatus::Deleted);
}

#[tokio::test]
async fn conflicted_file_and_detached_head() {
    let repo = TestRepo::with_commit();
    repo.checkout_new("feature");
    repo.commit_file("README.md", "# Feature\n", "Feature");
    repo.checkout("main");
    repo.commit_file("README.md", "# Main\n", "Main");
    assert!(!repo.merge("feature"));
    let (tc, id) = open(&repo).await;

    let d = text_of(&tc, &id, "README.md", DiffSource::Unstaged).await;
    assert_eq!(d.status, FileStatus::Conflicted);
    assert_eq!(d.token, None, "no line staging in conflicted files");
    assert!(all_signed(&d).iter().any(|l| l.starts_with("+<<<<<<<")), "{:?}", all_signed(&d));
    let d = text_of(&tc, &id, "README.md", DiffSource::Staged).await;
    assert_eq!(d.status, FileStatus::Conflicted);

    repo.git(&["merge", "--abort"]);
    repo.git(&["checkout", "-q", "--detach"]);
    repo.write_file("README.md", "# Main\nlose\n");
    let d = text_of(&tc, &id, "README.md", DiffSource::Unstaged).await;
    assert_eq!(all_signed(&d), vec![" # Main", "+lose"]);
}

#[tokio::test]
async fn missing_paths_and_directories() {
    let repo = TestRepo::with_commit();
    repo.write_file("ordner/datei.txt", "x\n");
    let (tc, id) = open(&repo).await;
    for source in [DiffSource::Unstaged, DiffSource::Staged] {
        let result = diff_file(&tc, id.clone(), "gibt-es-nicht.txt".into(), source, None, None).await;
        assert_eq!(result.unwrap_err().code, ErrorCode::NotFound);
    }
    let result = diff_file(&tc, id.clone(), "ordner".into(), DiffSource::Unstaged, None, None).await;
    assert_eq!(result.unwrap_err().code, ErrorCode::Unsupported);
    let result = diff_file(&tc, "unbekannt".into(), "README.md".into(), DiffSource::Unstaged, None, None).await;
    assert_eq!(result.unwrap_err().code, ErrorCode::NotFound);

    // Tracked and unchanged: empty diff, no error.
    let d = text_of(&tc, &id, "README.md", DiffSource::Unstaged).await;
    assert!(d.hunks.is_empty());
    assert_eq!(d.status, FileStatus::Modified);
    assert!(text_of(&tc, &id, "README.md", DiffSource::Staged).await.hunks.is_empty());
}

#[tokio::test]
async fn ignore_whitespace_hides_whitespace_only_changes() {
    let repo = TestRepo::new();
    repo.commit_file("f.txt", "a\nb\nc\n", "Basis");
    repo.write_file("f.txt", "a\n  b\nC\n");
    let (tc, id) = open(&repo).await;

    let plain = text_of(&tc, &id, "f.txt", DiffSource::Unstaged).await;
    assert_eq!(all_signed(&plain), vec![" a", "-b", "-c", "+  b", "+C"]);
    let ignoring = text(diff_file(&tc, id.clone(), "f.txt".into(), DiffSource::Unstaged, None, Some(true)).await.unwrap());
    assert_eq!(all_signed(&ignoring), vec![" a", "   b", "-c", "+C"]);
    assert_eq!(ignoring.token, None, "the selection from this view does not match the real diff");

    // Without whitespace-only changes both views are equal, the token is valid.
    repo.write_file("f.txt", "a\nb\nC\n");
    let plain = text_of(&tc, &id, "f.txt", DiffSource::Unstaged).await;
    let ignoring = text(diff_file(&tc, id, "f.txt".into(), DiffSource::Unstaged, None, Some(true)).await.unwrap());
    assert!(plain.token.is_some());
    assert_eq!(ignoring.token, plain.token);
}

#[tokio::test]
async fn token_follows_index_and_worktree() {
    let repo = TestRepo::new();
    repo.commit_file("f.txt", "a\nb\nc\n", "Basis");
    repo.write_file("f.txt", "a\nB\nc\n");
    let (tc, id) = open(&repo).await;
    let first = text_of(&tc, &id, "f.txt", DiffSource::Unstaged).await.token;
    assert_eq!(text_of(&tc, &id, "f.txt", DiffSource::Unstaged).await.token, first, "same state, same token");

    // Only the timestamp changes: same token.
    repo.write_file("f.txt", "a\nB\nc\n");
    assert_eq!(text_of(&tc, &id, "f.txt", DiffSource::Unstaged).await.token, first);

    repo.write_file("f.txt", "a\nB\nc\nd\n");
    let second = text_of(&tc, &id, "f.txt", DiffSource::Unstaged).await.token;
    assert_ne!(second, first);

    repo.git(&["add", "f.txt"]);
    repo.write_file("f.txt", "a\nB\nc\nd\ne\n");
    let third = text_of(&tc, &id, "f.txt", DiffSource::Unstaged).await.token;
    assert!(third != second && third != first);
}

#[tokio::test]
async fn works_while_a_foreign_index_lock_exists() {
    let repo = TestRepo::with_commit();
    repo.write_file("README.md", "# Test\nmehr\n");
    repo.write_file("neu.txt", "x\n");
    std::fs::write(repo.path().join(".git").join("index.lock"), "").unwrap();
    let (tc, id) = open(&repo).await;
    assert_eq!(all_signed(&text_of(&tc, &id, "README.md", DiffSource::Unstaged).await), vec![" # Test", "+mehr"]);
    assert_eq!(all_signed(&text_of(&tc, &id, "neu.txt", DiffSource::Unstaged).await), vec!["+x"]);
    assert!(repo.path().join(".git").join("index.lock").exists());
}

#[tokio::test]
async fn user_diff_settings_do_not_change_the_result() {
    let repo = TestRepo::new();
    repo.commit_file("f.txt", "a\n\nb\nc\n", "Basis");
    repo.write_file("f.txt", "a\n\nb\nC\n");
    for (key, value) in [
        ("diff.noprefix", "true"),
        ("diff.mnemonicPrefix", "true"),
        ("diff.suppressBlankEmpty", "true"),
        ("diff.context", "0"),
        ("diff.external", "false"),
        ("color.diff", "always"),
    ] {
        repo.git(&["config", key, value]);
    }
    let (tc, id) = open(&repo).await;
    let d = text_of(&tc, &id, "f.txt", DiffSource::Unstaged).await;
    assert_eq!(all_signed(&d), vec![" a", " ", " b", "-c", "+C"]);
}

#[tokio::test]
async fn encoding_can_be_given_for_one_call() {
    let repo = TestRepo::new();
    repo.commit_file("l.txt", b"Gr\xfc\xdfe\n", "Latin");
    repo.write_file("l.txt", b"Gr\xfc\xdfe\nneu \xfc\n");
    let (tc, id) = open(&repo).await;

    let auto = text_of(&tc, &id, "l.txt", DiffSource::Unstaged).await;
    assert_eq!(auto.encoding, "windows-1252");
    assert_eq!(auto.hunks[0].lines[0].text, "Grüße");

    let forced = text(super::diff_file(&tc, id.clone(), "l.txt".into(), DiffSource::Unstaged, None, None, Some("windows-1251".into())).await.unwrap());
    assert_eq!(forced.encoding, "windows-1251");
    assert_eq!(forced.hunks[0].lines[0].text, "GrьЯe");
    assert_eq!(forced.hunks[0].lines[1].text, "neu ь");
    assert_eq!(forced.old_text.as_deref(), Some("GrьЯe\n"));
    assert_eq!(forced.new_text.as_deref(), Some("GrьЯe\nneu ь\n"));
    assert_eq!(forced.token, auto.token, "the display encoding does not change the fingerprint");

    let err = super::diff_file(&tc, id, "l.txt".into(), DiffSource::Unstaged, None, None, Some("klingonisch".into())).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
}
