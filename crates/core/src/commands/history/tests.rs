//! Tests for file history, blame, reading and writing files – against real temp repositories.

use serde_json::json;

use super::*;
use crate::error::ErrorCode;
use crate::events::names;
use crate::testkit::{TestCore, TestRepo, AUTHOR_EMAIL, AUTHOR_NAME, BASE_TIME};

async fn setup(repo: &TestRepo) -> (TestCore, String) {
    let tc = TestCore::new().await;
    let id = tc.open(repo).await.repo.id;
    tc.events.clear();
    (tc, id)
}

// The older tests call without the parameters added later (encoding, offset).
async fn file_history(core: &Core, repo_id: String, path: String, limit: u32) -> CoreResult<Vec<FileHistoryEntry>> {
    super::file_history(core, repo_id, path, limit, None).await
}

async fn file_blame(core: &Core, repo_id: String, path: String, sha: Option<String>) -> CoreResult<Vec<BlameLine>> {
    super::file_blame(core, repo_id, path, sha, None).await
}

async fn file_read(core: &Core, repo_id: String, path: String, sha: Option<String>) -> CoreResult<FileContent> {
    super::file_read(core, repo_id, path, sha, None).await
}

async fn history(tc: &TestCore, id: &str, path: &str) -> Vec<FileHistoryEntry> {
    file_history(tc, id.to_string(), path.to_string(), 100).await.unwrap()
}

fn summaries(entries: &[FileHistoryEntry]) -> Vec<&str> {
    entries.iter().map(|e| e.commit.summary.as_str()).collect()
}

fn code<T: std::fmt::Debug>(result: CoreResult<T>) -> ErrorCode {
    result.unwrap_err().code
}

fn commit_as(repo: &TestRepo, name: &str, email: &str, message: &str) -> String {
    repo.git(&["add", "-A"]);
    repo.git(&["-c", &format!("user.name={name}"), "-c", &format!("user.email={email}"), "commit", "-q", "-m", message]);
    repo.head()
}

// --- file_history -------------------------------------------------------------

#[tokio::test]
async fn history_lists_commits_newest_first_with_counts() {
    let repo = TestRepo::new();
    let first = repo.commit_file("a.txt", "eins\n", "Erster");
    repo.commit_file("anders.txt", "x\n", "Betrifft a.txt nicht");
    let second = repo.commit_file("a.txt", "eins\nzwei\ndrei\n", "Zweiter");
    let third = repo.commit_file("a.txt", "eins\ndrei\n", "Dritter: Grüße");
    let (tc, id) = setup(&repo).await;

    let entries = history(&tc, &id, "a.txt").await;
    assert_eq!(summaries(&entries), ["Dritter: Grüße", "Zweiter", "Erster"]);
    assert_eq!(entries[0].commit.sha, third);
    assert_eq!(entries[0].commit.parents, vec![second.clone()]);
    assert_eq!(entries[2].commit.sha, first);
    assert!(entries[2].commit.parents.is_empty());
    assert_eq!(entries[0].commit.author, Person { name: AUTHOR_NAME.into(), email: AUTHOR_EMAIL.into() });
    // Times are UTC; the test kit assigns fixed timestamps from 2026-01-01 on.
    let authored: i64 = repo.git(&["log", "-1", "--format=%at", &first]).parse().unwrap();
    assert!(authored >= BASE_TIME);
    assert_eq!(entries[2].commit.authored_at, util::unix_to_iso(authored));
    assert!(entries[2].commit.authored_at.starts_with("2026-01-01T00:0") && entries[2].commit.authored_at.ends_with('Z'));

    assert_eq!((entries[0].status, entries[0].added, entries[0].removed), (FileStatus::Modified, Some(0), Some(1)));
    assert_eq!((entries[1].status, entries[1].added, entries[1].removed), (FileStatus::Modified, Some(2), Some(0)));
    assert_eq!((entries[2].status, entries[2].added, entries[2].removed), (FileStatus::Added, Some(1), Some(0)));
    assert!(entries.iter().all(|e| e.path == "a.txt" && e.old_path.is_none()));

    // One log entry for the actual call, no change notification.
    assert_eq!(tc.events.count(names::LOG_APPENDED), 1);
    assert_eq!(tc.events.count(names::REPO_CHANGED), 0);
}

#[tokio::test]
async fn history_follows_renames() {
    let repo = TestRepo::new();
    repo.commit_file("alt.txt", "eins\nzwei\ndrei\nvier\n", "Angelegt");
    repo.commit_file("alt.txt", "eins\nzwei\ndrei\nvier\nfünf\n", "Erweitert");
    repo.subdir("ordner");
    repo.git(&["mv", "alt.txt", "ordner/neu.txt"]);
    repo.commit("Umbenannt");
    repo.commit_file("ordner/neu.txt", "eins\nzwei\ndrei\nvier\nfünf\nsechs\n", "Nach dem Umbenennen");
    let (tc, id) = setup(&repo).await;

    let entries = history(&tc, &id, "ordner/neu.txt").await;
    assert_eq!(summaries(&entries), ["Nach dem Umbenennen", "Umbenannt", "Erweitert", "Angelegt"]);
    assert_eq!(entries[0].path, "ordner/neu.txt");
    assert_eq!(entries[1].status, FileStatus::Renamed);
    assert_eq!(entries[1].path, "ordner/neu.txt");
    assert_eq!(entries[1].old_path.as_deref(), Some("alt.txt"));
    assert_eq!((entries[1].added, entries[1].removed), (Some(0), Some(0)));
    // Before the rename the file carries its old name.
    assert_eq!(entries[2].path, "alt.txt");
    assert_eq!((entries[2].status, entries[2].added), (FileStatus::Modified, Some(1)));
    assert_eq!((entries[3].path.as_str(), entries[3].status), ("alt.txt", FileStatus::Added));

    // Under the old name the history ends at the rename (that is where the path disappears).
    let old = history(&tc, &id, "alt.txt").await;
    assert_eq!(old.len(), 3, "{:?}", summaries(&old));
    assert_eq!(old[1].commit.summary, "Erweitert");
}

#[tokio::test]
async fn history_of_a_deleted_file_ends_with_the_deletion() {
    let repo = TestRepo::new();
    repo.commit_file("weg.txt", "a\nb\n", "Angelegt");
    repo.commit_file("weg.txt", "a\nb\nc\n", "Geändert");
    repo.remove_file("weg.txt");
    repo.commit("Gelöscht");
    repo.commit_file("bleibt.txt", "x\n", "Danach");
    let (tc, id) = setup(&repo).await;

    let entries = history(&tc, &id, "weg.txt").await;
    assert_eq!(summaries(&entries), ["Gelöscht", "Geändert", "Angelegt"]);
    assert_eq!((entries[0].status, entries[0].added, entries[0].removed), (FileStatus::Deleted, Some(0), Some(3)));
    assert_eq!(entries[0].path, "weg.txt");
}

#[tokio::test]
async fn history_edge_cases_unknown_path_empty_repo_and_bad_paths() {
    let repo = TestRepo::with_commit();
    let (tc, id) = setup(&repo).await;
    assert!(history(&tc, &id, "gibt/es/nicht.txt").await.is_empty());
    assert_eq!(code(file_history(&tc, id.clone(), "../draußen.txt".into(), 10).await), ErrorCode::NotAllowed);
    assert_eq!(code(file_history(&tc, id.clone(), "a/../../b".into(), 10).await), ErrorCode::NotAllowed);
    let absolute = repo.path().join("README.md").to_string_lossy().into_owned();
    assert_eq!(code(file_history(&tc, id.clone(), absolute, 10).await), ErrorCode::NotAllowed);
    assert_eq!(code(file_history(&tc, id.clone(), "".into(), 10).await), ErrorCode::NotAllowed);
    assert_eq!(code(file_history(&tc, "unbekannt".into(), "a".into(), 10).await), ErrorCode::NotFound);
    // "./" and duplicate separators do no harm.
    assert_eq!(history(&tc, &id, "./README.md").await.len(), 1);

    let empty = TestRepo::new();
    empty.write_file("neu.txt", "x\n");
    let empty_id = tc.open(&empty).await.repo.id;
    assert!(history(&tc, &empty_id, "neu.txt").await.is_empty());
}

#[tokio::test]
async fn history_handles_special_names_binary_files_and_limit() {
    let repo = TestRepo::new();
    // "*" is not a valid character in file names on Windows.
    let (odd, neighbour) = if cfg!(windows) {
        ("Über uns/mein Text [1].txt", "Über uns/mein Text 1.txt")
    } else {
        ("Über uns/mein Text [1]*.txt", "Über uns/mein Text 1x.txt")
    };
    repo.commit_file(odd, "a\n", "Sondername angelegt");
    // A path the pattern would match must not be counted.
    repo.commit_file(neighbour, "b\n", "Nachbar");
    repo.commit_file(odd, "a\nb\n", "Sondername geändert");
    repo.commit_file("bild.bin", [0u8, 1, 2, 3, 0, 255], "Binär angelegt");
    repo.commit_file("bild.bin", [9u8, 0, 0, 7], "Binär geändert");
    let (tc, id) = setup(&repo).await;

    let entries = history(&tc, &id, odd).await;
    assert_eq!(summaries(&entries), ["Sondername geändert", "Sondername angelegt"]);
    assert!(entries.iter().all(|e| e.path == odd));

    let binary = history(&tc, &id, "bild.bin").await;
    assert_eq!(binary.len(), 2);
    assert!(binary.iter().all(|e| e.added.is_none() && e.removed.is_none()));
    assert_eq!(binary[1].status, FileStatus::Added);

    for i in 0..5 {
        repo.commit_file("oft.txt", format!("{i}\n"), &format!("Stand {i}"));
    }
    let limited = file_history(&tc, id.clone(), "oft.txt".into(), 2).await.unwrap();
    assert_eq!(summaries(&limited), ["Stand 4", "Stand 3"]);
    assert_eq!(file_history(&tc, id.clone(), "oft.txt".into(), 0).await.unwrap().len(), 5);
}

#[tokio::test]
async fn history_includes_merges_and_works_detached() {
    let repo = TestRepo::new();
    repo.commit_file("a.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n", "Basis");
    repo.checkout_new("feature");
    repo.commit_file("a.txt", "1\n2\n3\n4\n5\n6\n7\n8\nneun\n", "Feature ändert das Ende");
    repo.checkout("main");
    repo.commit_file("a.txt", "eins\n2\n3\n4\n5\n6\n7\n8\n9\n", "Main ändert den Anfang");
    assert!(repo.merge("feature"));
    let merge = repo.head();
    let (tc, id) = setup(&repo).await;

    let entries = history(&tc, &id, "a.txt").await;
    let merged = entries.iter().find(|e| e.commit.sha == merge).expect("merge commit missing from the history");
    assert_eq!(merged.commit.parents.len(), 2);
    assert_eq!((merged.status, merged.added, merged.removed), (FileStatus::Modified, Some(1), Some(1)));
    assert_eq!(entries.len(), 4, "{:?}", summaries(&entries));
    assert!(entries.iter().all(|e| e.path == "a.txt"));

    // Detached HEAD on the first commit: only its history.
    let base = entries.last().unwrap().commit.sha.clone();
    repo.git(&["checkout", "-q", "--detach", &base]);
    assert_eq!(summaries(&history(&tc, &id, "a.txt").await), ["Basis"]);
}

#[test]
fn history_parser_survives_odd_input() {
    // A commit without a diff entry (e.g. a merge without differences) keeps the tracked name.
    let mut p = HistoryParser::new("neu.txt");
    for rec in [COMMIT_MARK, b"aaaa", b"bbbb cccc", b"N", b"n@x", b"60", b"Ohne Diff", b""] {
        p.feed(rec);
    }
    // Rename: raw line with two paths, numstat with an empty path and two following entries.
    for rec in [b"\n".as_slice(), COMMIT_MARK, b"dddd", b"", b"N", b"n@x", b"0", b"", b"", b"\n:100644 100644 1 2 R090", b"alt.txt", b"neu.txt"] {
        p.feed(rec);
    }
    for rec in [b"3\t1\t".as_slice(), b"alt.txt", b"neu.txt", b""] {
        p.feed(rec);
    }
    // A file name that looks like the marker does not start a new commit.
    for rec in [COMMIT_MARK, b"eeee", b"", b"N", b"n@x", b"0", b"Seltsam", b":000000 100644 0 1 A", COMMIT_MARK, b"-\t-\tx"] {
        p.feed(rec);
    }
    let entries = p.finish();
    assert_eq!(entries.len(), 3);
    assert_eq!((entries[0].path.as_str(), entries[0].status, entries[0].added), ("neu.txt", FileStatus::Modified, None));
    assert_eq!(entries[0].commit.parents, ["bbbb", "cccc"]);
    assert_eq!(entries[1].status, FileStatus::Renamed);
    assert_eq!((entries[1].old_path.as_deref(), entries[1].added, entries[1].removed), (Some("alt.txt"), Some(3), Some(1)));
    assert_eq!(entries[1].commit.summary, "");
    assert_eq!(entries[2].status, FileStatus::Added);
    assert_eq!(entries[2].path.as_bytes(), COMMIT_MARK);
    assert_eq!((entries[2].added, entries[2].removed), (None, None));
}

// --- file_blame ---------------------------------------------------------------

#[tokio::test]
async fn blame_attributes_lines_to_commits_and_marks_uncommitted_ones() {
    let repo = TestRepo::new();
    let first = repo.commit_file("a.txt", "eins\nzwei\ndrei\n", "Erster Stand");
    repo.write_file("a.txt", "eins\nZWEI\ndrei\nvier\n");
    let second = commit_as(&repo, "Zweite Person", "zwei@example.com", "Zweite Zeile groß, vierte neu");
    let (tc, id) = setup(&repo).await;

    let lines = file_blame(&tc, id.clone(), "a.txt".into(), None).await.unwrap();
    assert_eq!(lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), ["eins", "ZWEI", "drei", "vier"]);
    assert_eq!(lines.iter().map(|l| l.line_no).collect::<Vec<_>>(), [1, 2, 3, 4]);
    assert_eq!(lines.iter().map(|l| l.sha.as_str()).collect::<Vec<_>>(), [&first, &second, &first, &second]);
    assert_eq!(lines[0].author, Person { name: AUTHOR_NAME.into(), email: AUTHOR_EMAIL.into() });
    assert_eq!(lines[0].summary, "Erster Stand");
    let authored: i64 = repo.git(&["log", "-1", "--format=%at", &first]).parse().unwrap();
    assert_eq!(lines[0].authored_at, util::unix_to_iso(authored));
    assert!(authored >= BASE_TIME && lines[0].authored_at.ends_with('Z'));
    assert_eq!(lines[1].author, Person { name: "Zweite Person".into(), email: "zwei@example.com".into() });
    // The later line of the same commit also carries its details (they appear only once in the output).
    assert_eq!((lines[3].author.name.as_str(), lines[3].summary.as_str()), ("Zweite Person", "Zweite Zeile groß, vierte neu"));
    assert_eq!(lines[2].summary, "Erster Stand");
    assert!(lines.iter().all(|l| !l.uncommitted));

    // Uncommitted change in the working directory.
    repo.write_file("a.txt", "eins\nZWEI\nneu dazwischen\ndrei\nvier\n");
    let lines = file_blame(&tc, id.clone(), "a.txt".into(), None).await.unwrap();
    assert_eq!(lines.len(), 5);
    assert_eq!(lines.iter().map(|l| l.uncommitted).collect::<Vec<_>>(), [false, false, true, false, false]);
    assert_eq!(lines[2].text, "neu dazwischen");
    assert!(lines[2].sha.bytes().all(|b| b == b'0'));
    assert_eq!(lines[2].author.name, "Not committed yet");
    assert_eq!(lines[3].sha, first);

    // With a SHA: the state of this commit, without the changes after it.
    let old = file_blame(&tc, id.clone(), "a.txt".into(), Some(first.clone())).await.unwrap();
    assert_eq!(old.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), ["eins", "zwei", "drei"]);
    assert!(old.iter().all(|l| l.sha == first && !l.uncommitted));
    assert_eq!(tc.events.count(names::REPO_CHANGED), 0);
}

#[tokio::test]
async fn blame_handles_crlf_missing_final_newline_and_special_names() {
    let repo = TestRepo::new();
    let name = "Ordner mit Leerzeichen/Größe.txt";
    repo.commit_file(name, "eins\r\nzwei\r\nohne Ende", "CRLF ohne Zeilenumbruch am Ende");
    let (tc, id) = setup(&repo).await;
    let lines = file_blame(&tc, id.clone(), name.into(), None).await.unwrap();
    assert_eq!(lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), ["eins", "zwei", "ohne Ende"]);
    assert_eq!(lines[2].line_no, 3);
    let at_head = file_blame(&tc, id.clone(), name.into(), Some(repo.head())).await.unwrap();
    assert_eq!(at_head, lines);

    // Content that is not UTF-8: windows-1252 as a fallback, or the repository's encoding.
    repo.commit_file("alt.txt", b"Gr\xfc\xdfe\n\xb1\n".as_slice(), "Alte Kodierung");
    let lines = file_blame(&tc, id.clone(), "alt.txt".into(), None).await.unwrap();
    assert_eq!((lines[0].text.as_str(), lines[1].text.as_str()), ("Grüße", "±"));
    crate::commands::settings::repo_settings_set(&tc, id.clone(), json!({ "encoding": "iso-8859-2" })).await.unwrap();
    let lines = file_blame(&tc, id.clone(), "alt.txt".into(), None).await.unwrap();
    assert_eq!(lines[1].text, "ą");
}

#[tokio::test]
async fn blame_rejects_binary_files_and_reports_missing_ones() {
    let repo = TestRepo::new();
    repo.commit_file("bild.bin", [1u8, 0, 2, 0, 3], "Binär");
    let sha = repo.commit_file("text.txt", "a\n", "Text");
    let (tc, id) = setup(&repo).await;

    let err = file_blame(&tc, id.clone(), "bild.bin".into(), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Unsupported);
    assert!(err.message.contains("binary file"), "{}", err.message);
    assert_eq!(code(file_blame(&tc, id.clone(), "bild.bin".into(), Some(sha.clone())).await), ErrorCode::Unsupported);

    assert_eq!(code(file_blame(&tc, id.clone(), "fehlt.txt".into(), None).await), ErrorCode::NotFound);
    let err = file_blame(&tc, id.clone(), "fehlt.txt".into(), Some(sha.clone())).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    assert!(err.message.contains("fehlt.txt") && err.message.contains(&sha[..7]), "{}", err.message);
    let unknown = "0123456789abcdef0123456789abcdef01234567".to_string();
    assert_eq!(code(file_blame(&tc, id.clone(), "text.txt".into(), Some(unknown)).await), ErrorCode::NotFound);
    assert_eq!(code(file_blame(&tc, id.clone(), "text.txt".into(), Some("--output=x".into())).await), ErrorCode::NotAllowed);
    assert_eq!(code(file_blame(&tc, id.clone(), "../x".into(), None).await), ErrorCode::NotAllowed);

    // Deleted in the working directory: there is nothing to show.
    repo.remove_file("text.txt");
    assert_eq!(code(file_blame(&tc, id.clone(), "text.txt".into(), None).await), ErrorCode::NotFound);
    // It still exists in the commit.
    assert_eq!(file_blame(&tc, id.clone(), "text.txt".into(), Some(sha)).await.unwrap().len(), 1);
}

#[tokio::test]
async fn blame_of_files_unknown_to_head_is_all_uncommitted() {
    // Empty repository without a commit.
    let repo = TestRepo::new();
    repo.write_file("neu.txt", "a\r\nb\n\nc");
    let (tc, id) = setup(&repo).await;
    let lines = file_blame(&tc, id.clone(), "neu.txt".into(), None).await.unwrap();
    assert_eq!(lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>(), ["a", "b", "", "c"]);
    assert!(lines.iter().all(|l| l.uncommitted && l.sha.len() == 40 && l.sha.bytes().all(|b| b == b'0')));
    assert_eq!(lines[3].line_no, 4);

    // With commits: untracked and freshly staged.
    repo.commit("Erster");
    repo.write_file("unverfolgt.txt", "x\ny\n");
    repo.write_file("gestaged.txt", "z\n");
    repo.git(&["add", "gestaged.txt"]);
    assert_eq!(file_blame(&tc, id.clone(), "unverfolgt.txt".into(), None).await.unwrap().len(), 2);
    let staged = file_blame(&tc, id.clone(), "gestaged.txt".into(), None).await.unwrap();
    assert!(staged.len() == 1 && staged[0].uncommitted);
    repo.write_file("leer.txt", "");
    assert!(file_blame(&tc, id.clone(), "leer.txt".into(), None).await.unwrap().is_empty());
}

#[tokio::test]
async fn blame_streams_large_files() {
    let repo = TestRepo::new();
    let mut text = String::new();
    for i in 0..20_000 {
        text.push_str(&format!("Zeile {i}\n"));
    }
    repo.commit_file("groß.txt", &text, "Viele Zeilen");
    let changed = text.replacen("Zeile 12000\n", "Zeile zwölftausend\n", 1);
    let second = repo.commit_file("groß.txt", &changed, "Eine Zeile geändert");
    let (tc, id) = setup(&repo).await;
    let lines = file_blame(&tc, id, "groß.txt".into(), None).await.unwrap();
    assert_eq!(lines.len(), 20_000);
    assert_eq!(lines[19_999].line_no, 20_000);
    assert_eq!(lines[12_000].text, "Zeile zwölftausend");
    assert_eq!(lines.iter().filter(|l| l.sha == second).count(), 1);
    assert_eq!(lines[0].summary, "Viele Zeilen");
}

#[tokio::test]
async fn blame_while_an_operation_is_running() {
    let repo = TestRepo::new();
    repo.commit_file("a.txt", "basis\n", "Basis");
    repo.checkout_new("feature");
    repo.commit_file("a.txt", "feature\n", "Feature");
    repo.checkout("main");
    let main = repo.commit_file("a.txt", "main\n", "Main");
    assert!(!repo.merge("feature"));
    let (tc, id) = setup(&repo).await;
    // In the middle of a conflict: the state of a commit stays readable.
    let lines = file_blame(&tc, id.clone(), "a.txt".into(), Some(main.clone())).await.unwrap();
    assert_eq!((lines.len(), lines[0].text.as_str()), (1, "main"));
    let content = file_read(&tc, id.clone(), "a.txt".into(), None).await.unwrap();
    assert!(content.text.unwrap().contains("<<<<<<<"));
    assert_eq!(history(&tc, &id, "a.txt").await.len(), 2);
}

// --- file_read ----------------------------------------------------------------

#[tokio::test]
async fn read_reports_text_encoding_eol_and_size() {
    let repo = TestRepo::with_commit();
    let (tc, id) = setup(&repo).await;
    let read = |path: &str| file_read(&tc, id.clone(), path.to_string(), None);

    repo.write_file("lf.txt", "Grüße\nzwei\n");
    let lf = read("lf.txt").await.unwrap();
    assert_eq!(lf.text.as_deref(), Some("Grüße\nzwei\n"));
    assert_eq!((lf.encoding.as_str(), lf.eol, lf.is_binary, lf.size), ("utf-8", Eol::Lf, false, 13));
    assert_eq!(lf.path, "lf.txt");

    repo.write_file("crlf.txt", "eins\r\nzwei\r\n");
    let crlf = read("crlf.txt").await.unwrap();
    assert_eq!((crlf.eol, crlf.text.as_deref()), (Eol::Crlf, Some("eins\r\nzwei\r\n")));

    repo.write_file("gemischt.txt", "eins\r\nzwei\ndrei");
    assert_eq!(read("gemischt.txt").await.unwrap().eol, Eol::Mixed);

    repo.write_file("ohne.txt", "kein Zeilenumbruch am Ende");
    let none = read("ohne.txt").await.unwrap();
    assert_eq!((none.eol, none.text.as_deref()), (Eol::Lf, Some("kein Zeilenumbruch am Ende")));

    repo.write_file("leer.txt", "");
    let empty = read("leer.txt").await.unwrap();
    assert_eq!((empty.text.as_deref(), empty.size, empty.is_binary), (Some(""), 0, false));

    // Reading does not log and reports no change.
    assert_eq!(tc.events.count(names::LOG_APPENDED), 0);
    assert_eq!(tc.events.count(names::REPO_CHANGED), 0);
}

#[tokio::test]
async fn read_guesses_the_encoding_and_prefers_the_repo_setting() {
    let repo = TestRepo::with_commit();
    let (tc, id) = setup(&repo).await;
    let read = |path: &str| file_read(&tc, id.clone(), path.to_string(), None);

    repo.write_file("bom.txt", b"\xef\xbb\xbfhallo\n".as_slice());
    let bom = read("bom.txt").await.unwrap();
    assert_eq!((bom.text.as_deref(), bom.encoding.as_str(), bom.size), (Some("hallo\n"), "utf-8-bom", 9));

    let mut utf16 = vec![0xFF, 0xFE];
    for unit in "Grüße\r\n".encode_utf16() {
        utf16.extend_from_slice(&unit.to_le_bytes());
    }
    repo.write_file("utf16.txt", &utf16);
    let wide = read("utf16.txt").await.unwrap();
    assert_eq!((wide.text.as_deref(), wide.encoding.as_str(), wide.eol, wide.is_binary), (Some("Grüße\r\n"), "utf-16le", Eol::Crlf, false));

    repo.write_file("alt.txt", b"Gr\xfc\xdfe \xb1\n".as_slice());
    repo.write_file("ascii.txt", "nur ascii\n");
    repo.write_file("utf8.txt", "Grüße\n");
    let legacy = read("alt.txt").await.unwrap();
    assert_eq!((legacy.text.as_deref(), legacy.encoding.as_str()), (Some("Grüße ±\n"), "windows-1252"));
    assert_eq!(read("ascii.txt").await.unwrap().encoding, "utf-8");

    crate::commands::settings::repo_settings_set(&tc, id.clone(), json!({ "encoding": "ISO-8859-2" })).await.unwrap();
    let preferred = read("alt.txt").await.unwrap();
    assert_eq!((preferred.text.as_deref(), preferred.encoding.as_str()), (Some("Grüße ą\n"), "iso-8859-2"));
    // Pure ASCII counts as the repository's encoding; real UTF-8 stays UTF-8.
    assert_eq!(read("ascii.txt").await.unwrap().encoding, "iso-8859-2");
    assert_eq!(read("utf8.txt").await.unwrap().encoding, "utf-8");
    assert_eq!(read("bom.txt").await.unwrap().encoding, "utf-8-bom");
}

#[tokio::test]
async fn read_binary_too_large_and_missing() {
    let repo = TestRepo::with_commit();
    let (tc, id) = setup(&repo).await;
    let read = |path: &str| file_read(&tc, id.clone(), path.to_string(), None);

    repo.write_file("bild.bin", [0x89u8, b'P', b'N', b'G', 0, 0, 1]);
    let binary = read("bild.bin").await.unwrap();
    assert_eq!((binary.text, binary.is_binary, binary.size, binary.encoding.as_str()), (None, true, 7, ""));

    // Above the limit: no text, but not binary either – that is how the UI recognises "too large".
    let big = "0123456789abcde\n".repeat((MAX_TEXT_BYTES as usize / 16) + 1);
    repo.write_file("riesig.txt", &big);
    let large = read("riesig.txt").await.unwrap();
    assert_eq!((large.text, large.is_binary, large.size), (None, false, big.len() as u64));
    // Exactly at the limit it is still read.
    repo.write_file("grenze.txt", &big[..MAX_TEXT_BYTES as usize]);
    assert!(read("grenze.txt").await.unwrap().text.is_some());
    // The large state cannot be fetched as text from a commit either.
    let sha = repo.commit("Große Datei");
    let committed = file_read(&tc, id.clone(), "riesig.txt".into(), Some(sha)).await.unwrap();
    assert_eq!((committed.text, committed.is_binary, committed.size), (None, false, big.len() as u64));

    let missing = read("fehlt.txt").await.unwrap_err();
    assert_eq!(missing.code, ErrorCode::NotFound);
    assert!(missing.message.contains("fehlt.txt"));
    repo.subdir("ordner");
    assert_eq!(code(read("ordner").await), ErrorCode::NotAllowed);
    assert_eq!(code(read("../draußen.txt").await), ErrorCode::NotAllowed);
    assert_eq!(code(read("ordner/../../x").await), ErrorCode::NotAllowed);
    assert_eq!(code(read(&repo.temp_dir().join("gitconfig").to_string_lossy()).await), ErrorCode::NotAllowed);
    assert_eq!(code(read("/etc/passwd").await), ErrorCode::NotAllowed);
    if cfg!(windows) {
        assert_eq!(code(read("C:\\Windows\\win.ini").await), ErrorCode::NotAllowed);
        assert_eq!(code(read("..\\x").await), ErrorCode::NotAllowed);
        assert_eq!(code(read("\\\\server\\freigabe\\x").await), ErrorCode::NotAllowed);
        // Backslashes as separators are allowed on Windows.
        assert!(read("ordner\\..\\README.md").await.is_err());
        repo.write_file("ordner/innen.txt", "x");
        assert_eq!(read("ordner\\innen.txt").await.unwrap().path, "ordner/innen.txt");
    }
}

#[tokio::test]
async fn read_from_a_commit() {
    let repo = TestRepo::new();
    let name = "Mein Ordner/Übersicht 1.txt";
    let first = repo.commit_file(name, "alt\r\n", "Erster");
    let second = repo.commit_file(name, "neu\n", "Zweiter");
    repo.commit_file("bild.bin", [0u8, 1, 0], "Binär");
    repo.write_file(name, "im Arbeitsverzeichnis\n");
    let (tc, id) = setup(&repo).await;
    let read = |path: &str, sha: &str| file_read(&tc, id.clone(), path.to_string(), Some(sha.to_string()));

    let old = read(name, &first).await.unwrap();
    assert_eq!((old.text.as_deref(), old.eol, old.size, old.path.as_str()), (Some("alt\r\n"), Eol::Crlf, 5, name));
    assert_eq!(read(name, &second).await.unwrap().text.as_deref(), Some("neu\n"));
    assert_eq!(file_read(&tc, id.clone(), name.into(), None).await.unwrap().text.as_deref(), Some("im Arbeitsverzeichnis\n"));
    // Ref names work too.
    assert_eq!(read(name, "HEAD~1").await.unwrap().text.as_deref(), Some("neu\n"));
    assert!(read("bild.bin", "HEAD").await.unwrap().is_binary);

    let err = read("bild.bin", &first).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    assert!(err.message.contains(&first[..7]), "{}", err.message);
    assert_eq!(code(read("Mein Ordner", &first).await), ErrorCode::NotAllowed);
    assert_eq!(code(read(name, "0123456789abcdef0123456789abcdef01234567").await), ErrorCode::NotFound);
    assert_eq!(code(read(name, "-p").await), ErrorCode::NotAllowed);
    assert_eq!(code(read(name, "HEAD:x").await), ErrorCode::NotAllowed);
    assert_eq!(code(read("../x", &first).await), ErrorCode::NotAllowed);
    assert_eq!(tc.events.count(names::LOG_APPENDED), 0);

    // Empty repository: there is no commit that could be read from.
    let empty = TestRepo::new();
    let empty_id = tc.open(&empty).await.repo.id;
    assert_eq!(code(file_read(&tc, empty_id, "a.txt".into(), Some("HEAD".into())).await), ErrorCode::NotFound);
}

// --- file_write ---------------------------------------------------------------

#[tokio::test]
async fn write_converts_line_endings_creates_folders_and_reports_the_change() {
    let repo = TestRepo::with_commit();
    let (tc, id) = setup(&repo).await;
    let write = |path: &str, content: &str, encoding: &str, eol: LineEnding| {
        file_write(&tc, id.clone(), path.to_string(), content.to_string(), encoding.to_string(), eol)
    };

    write("neu/tief/Größe 1.txt", "eins\nzwei\r\ndrei", "utf-8", LineEnding::Crlf).await.unwrap();
    assert_eq!(repo.read_file("neu/tief/Größe 1.txt"), "eins\r\nzwei\r\ndrei".as_bytes());
    let changed = tc.events.named(names::REPO_CHANGED);
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0], json!({ "repoId": id, "what": ["worktree"] }));

    write("neu/tief/Größe 1.txt", "eins\r\nzwei\r\ndrei\n", "utf-8", LineEnding::Lf).await.unwrap();
    assert_eq!(repo.read_file("neu/tief/Größe 1.txt"), b"eins\nzwei\ndrei\n");
    // No temp files are left behind.
    let names: Vec<String> =
        std::fs::read_dir(repo.path().join("neu/tief")).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(names, ["Größe 1.txt"]);

    // Replace an existing file, also with empty content.
    write("README.md", "", "utf-8", LineEnding::Lf).await.unwrap();
    assert_eq!(repo.read_file("README.md"), b"");
    let status = crate::commands::status::read_status(&tc, &id).await.unwrap();
    assert_eq!(status.unstaged.len(), 2);
}

#[tokio::test]
async fn write_round_trips_encodings() {
    let repo = TestRepo::with_commit();
    let (tc, id) = setup(&repo).await;
    let cases: [(&str, &[u8]); 5] = [
        ("utf-8", b"Gr\xc3\xbc\xc3\x9fe\n"),
        ("utf-8-bom", b"\xef\xbb\xbfGr\xc3\xbc\xc3\x9fe\n"),
        ("windows-1252", b"Gr\xfc\xdfe\n"),
        ("utf-16le", b"\xff\xfeG\0r\0\xfc\0\xdf\0e\0\n\0"),
        ("utf-16be", b"\xfe\xff\0G\0r\0\xfc\0\xdf\0e\0\n"),
    ];
    for (encoding, bytes) in cases {
        file_write(&tc, id.clone(), "t.txt".into(), "Grüße\n".into(), encoding.into(), LineEnding::Lf).await.unwrap();
        assert_eq!(repo.read_file("t.txt"), bytes, "{encoding}");
        // What file_read reports produces the same bytes when written back.
        let read = file_read(&tc, id.clone(), "t.txt".into(), None).await.unwrap();
        assert_eq!((read.text.as_deref(), read.encoding.as_str()), (Some("Grüße\n"), encoding));
    }
    // Case and other names of the same encoding.
    file_write(&tc, id.clone(), "t.txt".into(), "ä".into(), "Latin1".into(), LineEnding::Lf).await.unwrap();
    assert_eq!(repo.read_file("t.txt"), b"\xe4");
    file_write(&tc, id.clone(), "t.txt".into(), "ä".into(), "".into(), LineEnding::Lf).await.unwrap();
    assert_eq!(repo.read_file("t.txt"), "ä".as_bytes());

    // Characters that cannot be represented: nothing is replaced, the file stays as it was.
    tc.events.clear();
    let err = file_write(&tc, id.clone(), "t.txt".into(), "Preis: 5 €, 日本".into(), "windows-1252".into(), LineEnding::Lf).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Unsupported);
    assert!(err.message.contains("windows-1252"), "{}", err.message);
    let err = file_write(&tc, id.clone(), "t.txt".into(), "x".into(), "klingonisch".into(), LineEnding::Lf).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    assert_eq!(repo.read_file("t.txt"), "ä".as_bytes());
    assert_eq!(tc.events.count(names::REPO_CHANGED), 0);
}

#[tokio::test]
async fn write_refuses_paths_outside_the_repo_and_inside_git() {
    let repo = TestRepo::with_commit();
    let (tc, id) = setup(&repo).await;
    let write = |path: &str| file_write(&tc, id.clone(), path.to_string(), "böse".to_string(), "utf-8".to_string(), LineEnding::Lf);
    let config_before = repo.read_file(".git/config");

    for path in ["../draußen.txt", "a/../../draußen.txt", "/tmp/draußen.txt", "", ".", "a/.."] {
        assert_eq!(code(write(path).await), ErrorCode::NotAllowed, "{path}");
    }
    let outside = repo.temp_dir().join("draußen.txt");
    assert_eq!(code(write(&outside.to_string_lossy()).await), ErrorCode::NotAllowed);
    for path in [".git/config", ".git/hooks/pre-commit", ".GIT/config", "sub/.git/config", ".git"] {
        let err = write(path).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed, "{path}");
        assert!(err.message.contains(".git"), "{}", err.message);
    }
    if cfg!(windows) {
        for path in [".git\\config", ".git./config", ".git /config", "GIT~1/config", "C:\\Windows\\x.txt"] {
            assert_eq!(code(write(path).await), ErrorCode::NotAllowed, "{path}");
        }
    }
    repo.subdir("ordner");
    assert_eq!(code(write("ordner").await), ErrorCode::NotAllowed);

    assert!(!outside.exists());
    assert!(!repo.path().join("sub").exists());
    assert!(!repo.path().join(".git/hooks/pre-commit").exists());
    assert_eq!(repo.read_file(".git/config"), config_before);
    assert_eq!(tc.events.count(names::REPO_CHANGED), 0);
    assert_eq!(code(file_write(&tc, "unbekannt".into(), "a".into(), "x".into(), "utf-8".into(), LineEnding::Lf).await), ErrorCode::NotFound);
}

#[cfg(unix)]
#[tokio::test]
async fn write_does_not_follow_symlinks_out_of_the_repo() {
    let repo = TestRepo::with_commit();
    let (tc, id) = setup(&repo).await;
    let outside = repo.temp_dir().join("draussen");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("ziel.txt"), "unberührt").unwrap();
    std::os::unix::fs::symlink(&outside, repo.path().join("link")).unwrap();
    std::os::unix::fs::symlink(repo.path().join(".git"), repo.path().join("versteckt")).unwrap();
    std::os::unix::fs::symlink(repo.path().join("README.md"), repo.path().join("innen")).unwrap();
    let write = |path: &str| file_write(&tc, id.clone(), path.to_string(), "neu".to_string(), "utf-8".to_string(), LineEnding::Lf);

    assert_eq!(code(write("link/ziel.txt").await), ErrorCode::NotAllowed);
    assert_eq!(code(write("link/neu.txt").await), ErrorCode::NotAllowed);
    assert_eq!(code(write("versteckt/config").await), ErrorCode::NotAllowed);
    assert_eq!(std::fs::read(outside.join("ziel.txt")).unwrap(), "unberührt".as_bytes());
    assert_eq!(code(file_read(&tc, id.clone(), "link/ziel.txt".into(), None).await), ErrorCode::NotAllowed);
    // A symlink that stays inside the repository is written through instead of replaced.
    write("innen").await.unwrap();
    assert_eq!(repo.read_file("README.md"), b"neu");
    assert!(repo.path().join("innen").symlink_metadata().unwrap().file_type().is_symlink());
}

// --- pure functions -----------------------------------------------------------

#[test]
fn path_rules() {
    assert_eq!(normalize_rel_path("a/b.txt").unwrap(), "a/b.txt");
    assert_eq!(normalize_rel_path("./a//b/./c").unwrap(), "a/b/c");
    assert_eq!(normalize_rel_path("Über uns/ä ö.txt").unwrap(), "Über uns/ä ö.txt");
    assert_eq!(normalize_rel_path("..a/b..").unwrap(), "..a/b..");
    for bad in ["", "/", "..", "a/..", "/a", "a\0b", "./.."] {
        assert_eq!(normalize_rel_path(bad).unwrap_err().code, ErrorCode::NotAllowed, "{bad:?}");
    }
    assert!(is_inside_git_dir(".git/config") && is_inside_git_dir("a/.GIT/x") && is_inside_git_dir(".git"));
    assert!(!is_inside_git_dir(".gitignore") && !is_inside_git_dir("a/.github/x") && !is_inside_git_dir("x.git/y"));
}

#[test]
fn eol_and_encoding_helpers() {
    assert_eq!(detect_eol(""), Eol::Lf);
    assert_eq!(detect_eol("a\rb"), Eol::Lf);
    assert_eq!(detect_eol("a\r\n"), Eol::Crlf);
    assert_eq!(detect_eol("\na\r\n"), Eol::Mixed);
    assert_eq!(normalize_eol("a\r\nb\nc\r\n", LineEnding::Lf), "a\nb\nc\n");
    assert_eq!(normalize_eol("a\r\nb\nc", LineEnding::Crlf), "a\r\nb\r\nc");
    assert!(is_binary_content(b"a\0b") && !is_binary_content(b"\xff\xfea\0") && !is_binary_content(b""));
    assert_eq!(decode_content(b"", "utf-8"), (String::new(), "utf-8".to_string()));
    assert_eq!(decode_content(b"\x83n", "shift_jis").1, "shift_jis");
    // Unknown preferred encoding: as if none were given.
    assert_eq!(decode_content(b"\xe4", "gibt-es-nicht"), ("ä".to_string(), "windows-1252".to_string()));
    assert_eq!(encode_content("ä", "UTF8").unwrap(), "ä".as_bytes());
    assert_eq!(encode_content("x", "replacement").unwrap_err().code, ErrorCode::Unsupported);
}

// --- encoding per call, offset -----------------------------------------------------

#[tokio::test]
async fn read_and_blame_with_an_encoding_given_for_this_call() {
    let repo = TestRepo::new();
    repo.write_file("u.txt", "Grüße\n");
    repo.write_file("l.txt", b"Gr\xfc\xdfe\n");
    let sha = repo.commit("Dateien");
    let (tc, id) = setup(&repo).await;

    // Without a given encoding it is detected as before.
    let auto = super::file_read(&tc, id.clone(), "l.txt".into(), None, None).await.unwrap();
    assert_eq!((auto.text.as_deref(), auto.encoding.as_str()), (Some("Grüße\n"), "windows-1252"));
    // With a given encoding it is read exactly like that – in the working directory and from a commit.
    for from in [None, Some(sha.clone())] {
        let cyrillic = super::file_read(&tc, id.clone(), "l.txt".into(), from, Some("Windows-1251".into())).await.unwrap();
        assert_eq!((cyrillic.text.as_deref(), cyrillic.encoding.as_str()), (Some("GrьЯe\n"), "windows-1251"));
    }
    // Even against appearances: valid UTF-8 as windows-1252.
    let mojibake = super::file_read(&tc, id.clone(), "u.txt".into(), None, Some("windows-1252".into())).await.unwrap();
    assert_eq!(mojibake.text.as_deref(), Some("Gr\u{c3}\u{bc}\u{c3}\u{178}e\n"));
    assert_eq!(mojibake.encoding, "windows-1252");
    // Whatever does not fit is replaced; nothing fails.
    let lossy = super::file_read(&tc, id.clone(), "l.txt".into(), None, Some("utf-8".into())).await.unwrap();
    assert_eq!((lossy.text.as_deref(), lossy.encoding.as_str()), (Some("Gr\u{fffd}\u{fffd}e\n"), "utf-8"));
    assert_eq!(code(super::file_read(&tc, id.clone(), "l.txt".into(), None, Some("klingonisch".into())).await), ErrorCode::NotAllowed);
    // Empty or null means: detect.
    let blank = super::file_read(&tc, id.clone(), "l.txt".into(), None, Some("  ".into())).await.unwrap();
    assert_eq!(blank.encoding, "windows-1252");

    // UTF-16 without a BOM otherwise counts as binary; with a given encoding it is text.
    repo.write_file("w.txt", b"H\0i\0\n\0");
    let binary = super::file_read(&tc, id.clone(), "w.txt".into(), None, None).await.unwrap();
    assert!(binary.is_binary && binary.text.is_none());
    let wide = super::file_read(&tc, id.clone(), "w.txt".into(), None, Some("utf-16le".into())).await.unwrap();
    assert_eq!((wide.text.as_deref(), wide.encoding.as_str(), wide.is_binary), (Some("Hi\n"), "utf-16le", false));
    // A BOM matching the given encoding does not belong to the text.
    repo.write_file("b.txt", b"\xEF\xBB\xBFmit BOM\n");
    let bom = super::file_read(&tc, id.clone(), "b.txt".into(), None, Some("utf-8".into())).await.unwrap();
    assert_eq!((bom.text.as_deref(), bom.encoding.as_str()), (Some("mit BOM\n"), "utf-8-bom"));

    // Blame: committed file, state of a commit and a file never committed.
    let lines = super::file_blame(&tc, id.clone(), "l.txt".into(), None, Some("windows-1251".into())).await.unwrap();
    assert_eq!(lines[0].text, "GrьЯe");
    let lines = super::file_blame(&tc, id.clone(), "l.txt".into(), Some(sha), Some("windows-1251".into())).await.unwrap();
    assert_eq!(lines[0].text, "GrьЯe");
    repo.write_file("neu.txt", b"Gr\xfc\xdfe\n");
    let lines = super::file_blame(&tc, id.clone(), "neu.txt".into(), None, Some("windows-1251".into())).await.unwrap();
    assert_eq!((lines[0].text.as_str(), lines[0].uncommitted), ("GrьЯe", true));
    let lines = super::file_blame(&tc, id.clone(), "l.txt".into(), None, None).await.unwrap();
    assert_eq!(lines[0].text, "Grüße", "without a given encoding, as before");
    assert_eq!(code(super::file_blame(&tc, id, "l.txt".into(), None, Some("klingonisch".into())).await), ErrorCode::NotAllowed);
}

#[tokio::test]
async fn history_offset_pages_through_and_keeps_following_renames() {
    let repo = TestRepo::new();
    repo.commit_file("alt.txt", "1\n", "C1");
    repo.commit_file("alt.txt", "1\n2\n", "C2");
    repo.git(&["mv", "alt.txt", "neu.txt"]);
    repo.commit("C3 umbenannt");
    repo.commit_file("neu.txt", "1\n2\n3\n", "C4");
    repo.commit_file("neu.txt", "1\n2\n3\n4\n", "C5");
    let (tc, id) = setup(&repo).await;
    let all = history(&tc, &id, "neu.txt").await;
    assert_eq!(summaries(&all), vec!["C5", "C4", "C3 umbenannt", "C2", "C1"]);

    let mut paged = Vec::new();
    for offset in [0, 2, 4] {
        let page = super::file_history(&tc, id.clone(), "neu.txt".into(), 2, Some(offset)).await.unwrap();
        assert!(page.len() <= 2);
        paged.extend(page);
    }
    assert_eq!(paged, all, "page by page gives the same list");
    // Beyond the rename the page knows the old name.
    let second = super::file_history(&tc, id.clone(), "neu.txt".into(), 2, Some(2)).await.unwrap();
    assert_eq!(summaries(&second), vec!["C3 umbenannt", "C2"]);
    assert_eq!((second[0].old_path.as_deref(), second[1].path.as_str()), (Some("alt.txt"), "alt.txt"));
    assert!(super::file_history(&tc, id.clone(), "neu.txt".into(), 2, Some(5)).await.unwrap().is_empty());
    assert!(super::file_history(&tc, id, "neu.txt".into(), 2, Some(500)).await.unwrap().is_empty());
}
