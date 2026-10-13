//! Tests for fast staging of many new files (bulk.rs) – against real temp repositories.

use std::path::Path;
use std::time::{Duration, Instant};

use super::*;
use crate::error::ErrorCode;
use crate::testkit::{TestCore, TestRepo};

/// Generous for a busy machine; without the pre-step the same
/// call took 12 to 22 s on Windows.
const TIME_LIMIT: Duration = Duration::from_secs(8);
/// When the whole test suite runs in parallel (and other builds run alongside), every fixed limit
/// breaks at some point. What counts then is the comparison with an ordinary `git add -A` under the
/// same load: the fast path must be at least this many times faster.
const MIN_SPEEDUP: u32 = 3;
/// Upper limit for runs where the only point is that nothing hangs.
const HANG_LIMIT: Duration = Duration::from_secs(120);

fn write_many(repo: &TestRepo, count: usize) {
    for i in 0..count {
        repo.write_file(&format!("massen/ordner-{}/reihe-{i:04}.csv", i % 20), format!("messung;{i}\n2026-03-01;{}\n", i * 7));
    }
}

/// How long an ordinary `git add -A` takes for just as many new files – now, under the current load.
fn plain_add_duration(count: usize) -> Duration {
    let twin = TestRepo::with_commit();
    write_many(&twin, count);
    let started = Instant::now();
    twin.git(&["add", "-A"]);
    started.elapsed()
}

fn assert_fast(what: &str, took: Duration, count: usize) {
    if took < TIME_LIMIT {
        return;
    }
    let plain = plain_add_duration(count);
    assert!(took * MIN_SPEEDUP < plain, "{what}: {took:?}; an ordinary `git add -A` currently takes {plain:?}");
}

async fn open(repo: &TestRepo) -> (TestCore, String) {
    let tc = TestCore::new().await;
    let id = tc.open(repo).await.repo.id;
    (tc, id)
}

async fn git_on_index(tc: &TestCore, id: &str, index: &Path, args: &[&str]) -> String {
    tc.git_for(id).unwrap().no_log().env("GIT_INDEX_FILE", index).args(args).run().await.unwrap().stdout_text()
}

/// Tree that an ordinary `git add -A` without the pre-step would produce (own index).
async fn plain_add_tree(tc: &TestCore, id: &str) -> String {
    let index = tc.data_dir().join(format!("vergleich-{}.index", crate::util::new_id()));
    git_on_index(tc, id, &index, &["read-tree", "HEAD"]).await;
    git_on_index(tc, id, &index, &["add", "-A"]).await;
    let tree = git_on_index(tc, id, &index, &["write-tree"]).await;
    let _ = std::fs::remove_file(&index);
    tree
}

/// (loose objects, objects in packs)
fn count_objects(repo: &TestRepo) -> (u64, u64) {
    let text = repo.git(&["count-objects", "-v"]);
    let field = |name: &str| text.lines().find_map(|l| l.strip_prefix(name)).and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(0);
    (field("count:"), field("in-pack:"))
}

fn blob(repo: &TestRepo, spec: &str) -> Vec<u8> {
    let out = repo.git_output(&["cat-file", "blob", spec]);
    assert!(out.status.success(), "cat-file {spec}: {}", String::from_utf8_lossy(&out.stderr));
    out.stdout
}

fn in_index(repo: &TestRepo, path: &str) -> bool {
    !repo.git(&["ls-files", "--", path]).is_empty()
}

/// Reported from the UI: "Stage all" with 2000 new files took 15 to 22 s,
/// because Git creates a loose object per file. Now they end up in one pack.
#[tokio::test]
async fn staging_2000_new_files_takes_seconds() {
    let repo = TestRepo::with_commit();
    write_many(&repo, 2000);
    let (tc, id) = open(&repo).await;
    let started = Instant::now();
    let status = stage_paths(&tc, id.clone(), None).await.unwrap();
    let took = started.elapsed();
    assert_eq!(status.staged.len(), 2000);
    assert!(status.unstaged.is_empty());
    assert_fast("stage_paths(null) mit 2000 neuen Dateien", took, 2000);
    let (loose, packed) = count_objects(&repo);
    assert!(packed >= 2000, "the new contents are in a pack: {packed} packed, {loose} loose");
    assert!(loose < 200, "hardly any loose objects: {loose}");
    // Byte-identical to what an ordinary `git add -A` produces.
    assert_eq!(repo.git(&["write-tree"]), plain_add_tree(&tc, &id).await);
    assert_eq!(blob(&repo, ":massen/ordner-7/reihe-0007.csv"), b"messung;7\n2026-03-01;49\n");
    repo.git(&["fsck", "--no-dangling"]);
    // Unstage and stage again: the objects already exist.
    unstage_paths(&tc, id.clone(), None).await.unwrap();
    let again = Instant::now();
    assert_eq!(stage_paths(&tc, id.clone(), None).await.unwrap().staged.len(), 2000);
    assert_fast("stage_paths(null) ein zweites Mal", again.elapsed(), 2000);
    // And the commit on top contains everything.
    repo.git(&["commit", "-q", "-m", "Viele Dateien"]);
    assert_eq!(repo.git(&["ls-tree", "-r", "--name-only", "HEAD"]).lines().count(), 2001);
}

/// The pre-step must not change anything about the result: line-ending conversion, filters and
/// files with `\r` still take the ordinary path.
#[tokio::test]
async fn bulk_staging_gives_the_same_tree_as_plain_add() {
    let repo = TestRepo::with_commit();
    repo.git(&["config", "core.autocrlf", "true"]);
    repo.git(&["config", "filter.gross.clean", "tr a-z A-Z"]);
    repo.git(&["config", "filter.gross.smudge", "cat"]);
    repo.write_file(".gitattributes", "*.laut filter=gross\n*.fest text eol=crlf\n*.roh -text\n");
    repo.write_file("README.md", "# Test\ngeändert\n");
    for i in 0..90 {
        repo.write_file(&format!("lf/datei-{i}.txt"), format!("zeile {i}\nzwei\n"));
        repo.write_file(&format!("crlf/datei-{i}.txt"), format!("zeile {i}\r\nzwei\r\n"));
        repo.write_file(&format!("fest/datei-{i}.fest"), format!("fest {i}\nzwei\n"));
        repo.write_file(&format!("roh/datei-{i}.roh"), format!("roh {i}\r\nzwei\n"));
    }
    for i in 0..70 {
        repo.write_file(&format!("laut/datei-{i}.laut"), format!("leise {i}\n"));
    }
    repo.write_file("binaer/bild.bin", [0u8, 159, 146, 150, 13, 10, 0]);
    repo.write_file("leer/nichts.txt", "");
    repo.write_file("ohne-ende/x.txt", "kein Zeilenende");
    repo.write_file("umlaut/größe \u{1F600}.txt", "ja\n");
    let (tc, id) = open(&repo).await;
    let expected = plain_add_tree(&tc, &id).await;
    // The comparison run has already created the objects; for the real run only the tree counts.
    let status = stage_paths(&tc, id.clone(), None).await.unwrap();
    assert!(status.unstaged.is_empty(), "{:?}", status.unstaged.iter().map(|f| &f.path).collect::<Vec<_>>());
    assert_eq!(repo.git(&["write-tree"]), expected);
    assert_eq!(blob(&repo, ":laut/datei-3.laut"), b"LEISE 3\n");
    assert_eq!(blob(&repo, ":crlf/datei-3.txt"), b"zeile 3\nzwei\n");
    assert_eq!(blob(&repo, ":roh/datei-3.roh"), b"roh 3\r\nzwei\n");
    assert_eq!(blob(&repo, ":fest/datei-3.fest"), b"fest 3\nzwei\n");
    repo.git(&["fsck", "--no-dangling"]);
}

/// The same without a comparison run before: the pre-step creates the objects itself.
#[tokio::test]
async fn bulk_staging_with_conversions_from_scratch() {
    let repo = TestRepo::with_commit();
    repo.git(&["config", "core.autocrlf", "true"]);
    repo.git(&["config", "filter.gross.clean", "tr a-z A-Z"]);
    repo.git(&["config", "filter.gross.smudge", "cat"]);
    repo.write_file(".gitattributes", "*.laut filter=gross\n");
    for i in 0..100 {
        repo.write_file(&format!("lf/datei-{i}.txt"), format!("zeile {i}\nzwei\n"));
        repo.write_file(&format!("crlf/datei-{i}.txt"), format!("zeile {i}\r\nzwei\r\n"));
        repo.write_file(&format!("laut/datei-{i}.laut"), format!("leise {i}\n"));
    }
    let (tc, id) = open(&repo).await;
    let status = stage_paths(&tc, id.clone(), None).await.unwrap();
    assert!(status.unstaged.is_empty());
    assert_eq!(status.staged.len(), 301);
    assert_eq!(blob(&repo, ":lf/datei-99.txt"), b"zeile 99\nzwei\n");
    assert_eq!(blob(&repo, ":crlf/datei-99.txt"), b"zeile 99\nzwei\n");
    assert_eq!(blob(&repo, ":laut/datei-99.laut"), b"LEISE 99\n");
    let (_, packed) = count_objects(&repo);
    assert!((100..300).contains(&packed), "only the files without conversion are in the pack: {packed}");
    assert_eq!(repo.git(&["write-tree"]), plain_add_tree(&tc, &id).await);
    repo.git(&["fsck", "--no-dangling"]);
}

/// With selected paths and below the threshold.
#[tokio::test]
async fn bulk_staging_of_selected_paths_and_small_sets() {
    let repo = TestRepo::with_commit();
    for i in 0..150 {
        repo.write_file(&format!("a/datei-{i}.txt"), format!("a {i}\n"));
        repo.write_file(&format!("b/datei-{i}.txt"), format!("b {i}\n"));
    }
    let (tc, id) = open(&repo).await;
    // Few files: ordinary path, no pack.
    let few: Vec<String> = (0..5).map(|i| format!("b/datei-{i}.txt")).collect();
    assert_eq!(stage_paths(&tc, id.clone(), Some(few)).await.unwrap().staged.len(), 5);
    assert_eq!(count_objects(&repo).1, 0);
    // Many single paths from one directory: only these end up in the index.
    let many: Vec<String> = (0..150).map(|i| format!("a/datei-{i}.txt")).collect();
    let status = stage_paths(&tc, id.clone(), Some(many)).await.unwrap();
    assert_eq!(status.staged.len(), 155);
    assert_eq!(status.unstaged.len(), 145);
    assert!(count_objects(&repo).1 >= 150);
    assert_eq!(blob(&repo, ":a/datei-149.txt"), b"a 149\n");
    assert!(!in_index(&repo, "b/datei-149.txt"));
}

/// A foreign index.lock stops the pre-step as well, and nothing is changed.
#[tokio::test]
async fn bulk_staging_stops_at_a_foreign_lock() {
    let repo = TestRepo::with_commit();
    for i in 0..100 {
        repo.write_file(&format!("neu/datei-{i}.txt"), format!("{i}\n"));
    }
    let (tc, id) = open(&repo).await;
    let lock = repo.path().join(".git").join("index.lock");
    std::fs::write(&lock, "").unwrap();
    let error = stage_paths(&tc, id.clone(), None).await.expect_err("gesperrt");
    assert_eq!(error.code, ErrorCode::Locked);
    assert!(lock.exists());
    std::fs::remove_file(&lock).unwrap();
    assert!(!in_index(&repo, "neu/datei-1.txt"));
    assert_eq!(stage_paths(&tc, id, None).await.unwrap().staged.len(), 100);
}

/// "Discard all" backs up the working directory first – that too via the fast path.
#[tokio::test]
async fn discard_everything_with_many_new_files_is_undoable() {
    let repo = TestRepo::with_commit();
    for i in 0..1000 {
        repo.write_file(&format!("viele/datei-{i}.txt"), format!("inhalt {i}\n"));
    }
    let (tc, id) = open(&repo).await;
    let started = Instant::now();
    let status = discard_paths(&tc, id.clone(), None).await.unwrap();
    // The backup takes the fast path; deleting 1000 files still costs time under load.
    assert!(started.elapsed() < HANG_LIMIT, "{:?}", started.elapsed());
    let (_, packed) = count_objects(&repo);
    assert!(packed >= 1000, "the backup is in a pack: {packed}");
    assert!(status.unstaged.is_empty());
    assert!(!repo.path().join("viele").exists());
    // The real index stayed untouched.
    assert!(!in_index(&repo, "viele/datei-1.txt"));
    crate::commands::undo::undo(&tc, id.clone()).await.unwrap();
    assert_eq!(repo.read_file("viele/datei-999.txt"), b"inhalt 999\n");
    assert_eq!(read_status(&tc, &id).await.unwrap().unstaged.len(), 1000);
}
