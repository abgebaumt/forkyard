//! Tests of the graph commands against real temp repositories.

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::Instant;

use serde_json::json;

use super::layout::check::check_rows;
use super::page::{STASH_REF, WIP_ID};
use super::*;
use crate::commands::repos::repo_open;
use crate::commands::view::view_state_set;
use crate::error::ErrorCode;
use crate::events::names;
use crate::model::{CommitInfo, FileArea, FileChange, FileStatus, GraphEdge, GraphRow, GraphRowKind, Person, SignatureStatus, SyncMark};
use crate::testkit::{git_isolation_env, TestCore, TestRepo, AUTHOR_EMAIL, AUTHOR_NAME, BASE_TIME};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// git with the test kit's isolation, in any folder and optionally with stdin.
fn git_in(repo: &TestRepo, cwd: &Path, args: &[&str], stdin: Option<Vec<u8>>) -> String {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(cwd).stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() });
    for (k, v) in git_isolation_env(&repo.temp_dir().join("gitconfig")) {
        cmd.env(k, v);
    }
    let mut child = cmd.spawn().expect("start git");
    let writer = stdin.map(|data| {
        let mut pipe = child.stdin.take().expect("stdin");
        std::thread::spawn(move || {
            let _ = pipe.write_all(&data);
        })
    });
    let out = child.wait_with_output().expect("git");
    if let Some(w) = writer {
        let _ = w.join();
    }
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim_end().to_string()
}

/// All pages one after another; checks along the way that no page brings more commits than requested.
async fn all_rows(tc: &TestCore, id: &str, page_size: u32) -> Vec<GraphRow> {
    let mut rows = Vec::new();
    let mut cursor = None;
    loop {
        let page = graph_page(tc, id.to_string(), cursor, page_size).await.unwrap();
        let commits = page.rows.iter().filter(|r| matches!(r.kind, GraphRowKind::Commit | GraphRowKind::Merge)).count();
        assert!(commits <= page_size as usize);
        let widest = page.rows.iter().flat_map(|r| r.edges.iter().flat_map(|e| [e.top, e.bottom]).flatten().chain([r.lane])).max().unwrap_or(0);
        assert_eq!(page.max_lane, widest);
        rows.extend(page.rows);
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => return rows,
        }
    }
}

/// The graph as text, for looking at while debugging: per row the lanes (`*` node,
/// `|` passing through, `\` ends at the node, `/` starts at the node, `:` dashed).
fn sketch(rows: &[GraphRow]) -> String {
    let mut out = String::new();
    for row in rows {
        let width = row.edges.iter().flat_map(|e| [e.top, e.bottom]).flatten().chain([row.lane]).max().unwrap_or(0) as usize + 1;
        let mut cells = vec![' '; width];
        for e in &row.edges {
            match (e.top, e.bottom) {
                (Some(t), Some(_)) => cells[t as usize] = if e.dashed { ':' } else { '|' },
                (Some(t), None) if t != row.lane => cells[t as usize] = '\\',
                (None, Some(b)) if b != row.lane => cells[b as usize] = if cells[b as usize] == '\\' { 'X' } else { '/' },
                _ => {}
            }
        }
        cells[row.lane as usize] = match row.kind {
            GraphRowKind::Wip => 'o',
            GraphRowKind::Stash => 's',
            GraphRowKind::Merge => 'M',
            GraphRowKind::Commit => '*',
        };
        let labels: Vec<&str> = row.refs.iter().map(|l| l.name.as_str()).collect();
        out.push_str(&format!("{:<8} c{} {} {}\n", cells.iter().collect::<String>(), row.color, row.summary, if labels.is_empty() { String::new() } else { format!("[{}]", labels.join(", ")) }));
    }
    out
}

fn find<'a>(rows: &'a [GraphRow], id: &str) -> &'a GraphRow {
    rows.iter().find(|r| r.id == id).unwrap_or_else(|| panic!("row {id} missing"))
}

fn ids(rows: &[GraphRow]) -> Vec<&str> {
    rows.iter().map(|r| r.id.as_str()).collect()
}

fn ref_names(row: &GraphRow) -> Vec<&str> {
    row.refs.iter().map(|l| l.name.as_str()).collect()
}

fn file<'a>(files: &'a [FileChange], path: &str) -> &'a FileChange {
    files.iter().find(|f| f.path == path).unwrap_or_else(|| panic!("file {path} missing in {files:?}"))
}

async fn details_of(tc: &TestCore, id: &str, sha: &str) -> CommitDetails {
    commit_details(tc, id.to_string(), DiffSource::Commit { sha: sha.to_string() }).await.unwrap()
}

/// History with branches and merges: one commit on main per round, every three rounds a
/// feature branch with two commits that is merged two rounds later.
fn branchy_repo(rounds: usize) -> TestRepo {
    let repo = TestRepo::with_commit();
    let mut open: Option<(usize, String)> = None;
    for i in 0..rounds {
        repo.commit_file("main.txt", format!("{i}\n"), &format!("Main {i}"));
        if let Some((start, name)) = &open {
            if i == start + 2 {
                assert!(repo.merge(name));
                open = None;
            }
        }
        if i % 3 == 0 && open.is_none() {
            let name = format!("feature/{i}");
            repo.checkout_new(&name);
            repo.commit_file(&format!("f{i}.txt"), "a\n", &format!("Feature {i} a"));
            repo.commit_file(&format!("f{i}.txt"), "b\n", &format!("Feature {i} b"));
            repo.checkout("main");
            open = Some((i, name));
        }
    }
    repo
}

// ---------------------------------------------------------------------------
// graph_page
// ---------------------------------------------------------------------------

#[tokio::test]
async fn linear_history_is_one_lane_and_reads_without_side_effects() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let a = repo.head();
    let b = repo.commit_file("a.txt", "a\n", "Zweiter: Größe ändern");
    let c = repo.commit_file("a.txt", "b\n", "Dritter");
    let id = tc.open(&repo).await.repo.id;
    tc.events.clear();

    let page = graph_page(&tc, id.clone(), None, 100).await.unwrap();
    assert_eq!(ids(&page.rows), vec![c.as_str(), b.as_str(), a.as_str()]);
    assert_eq!(page.next_cursor, None);
    assert_eq!(page.max_lane, 0);
    check_rows(&page.rows, true).unwrap();
    let top = &page.rows[0];
    assert_eq!((top.kind, top.sha.as_deref(), top.lane), (GraphRowKind::Commit, Some(c.as_str()), 0));
    assert!(top.is_head);
    assert_eq!(top.refs.len(), 1);
    assert_eq!((top.refs[0].name.as_str(), top.refs[0].full_name.as_str(), top.refs[0].is_head), ("main", "refs/heads/main", true));
    assert_eq!(top.parents, vec![b.clone()]);
    assert_eq!(top.summary, "Dritter");
    assert_eq!((top.author_name.as_str(), top.author_email.as_str()), (AUTHOR_NAME, AUTHOR_EMAIL));
    let authored = top.authored_at.clone().unwrap();
    assert!(authored.starts_with("2026-01-01T") && authored.ends_with('Z'), "{authored}");
    assert_eq!((top.stash_index, top.wip_count), (None, None));
    assert_eq!(page.rows[1].summary, "Zweiter: Größe ändern");
    assert!(!page.rows[1].is_head && page.rows[1].refs.is_empty());
    assert!(page.rows[2].parents.is_empty());

    // Pure read command: no event, no log entry.
    assert!(tc.events.all().is_empty(), "{:?}", tc.events.all());
    assert_eq!(tc.events.count(names::LOG_APPENDED), 0);
}

/// User requirement: the graph is always sorted by date. Two branches whose
/// commits alternate in time are therefore interleaved and not in one piece.
#[tokio::test]
async fn rows_are_sorted_by_date_across_branches() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let a = repo.head();
    repo.checkout_new("feature/zeit");
    let f1 = repo.commit_file("f.txt", "1\n", "Feature 1");
    repo.checkout("main");
    let m1 = repo.commit_file("m.txt", "1\n", "Main 1");
    repo.checkout("feature/zeit");
    let f2 = repo.commit_file("f.txt", "2\n", "Feature 2");
    repo.checkout("main");
    let m2 = repo.commit_file("m.txt", "2\n", "Main 2");
    let id = tc.open(&repo).await.repo.id;

    for page_size in [100, 2] {
        let rows = all_rows(&tc, &id, page_size).await;
        assert_eq!(ids(&rows), vec![m2.as_str(), f2.as_str(), m1.as_str(), f1.as_str(), a.as_str()], "page size {page_size}\n{}", sketch(&rows));
        check_rows(&rows, true).unwrap();
    }
}

#[tokio::test]
async fn empty_repo_gives_an_empty_page_or_only_the_wip_row() {
    let tc = TestCore::new().await;
    let repo = TestRepo::new();
    let id = tc.open(&repo).await.repo.id;
    let page = graph_page(&tc, id.clone(), None, 100).await.unwrap();
    assert!(page.rows.is_empty());
    assert_eq!((page.next_cursor, page.max_lane), (None, 0));

    repo.write_file("erste datei.txt", "x\n");
    let page = graph_page(&tc, id.clone(), None, 100).await.unwrap();
    assert_eq!(page.rows.len(), 1);
    let wip = &page.rows[0];
    assert_eq!((wip.id.as_str(), wip.kind, wip.wip_count), (WIP_ID, GraphRowKind::Wip, Some(1)));
    assert!(wip.edges.is_empty() && wip.parents.is_empty());
    assert_eq!(page.next_cursor, None);
}

#[tokio::test]
async fn wip_row_counts_changed_files_and_hangs_dashed_on_head() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    repo.commit_file("a.txt", "a\n", "Zweiter");
    let head = repo.head();
    repo.write_file("a.txt", "geändert\n");
    repo.write_file("neu mit leerzeichen.txt", "x");
    repo.write_file("ordner/ünïcödé.txt", "y");
    repo.write_file("b.txt", "b\n");
    repo.git(&["add", "b.txt"]);
    // Staged and changed again afterwards: still counts as one file.
    repo.write_file("b.txt", "b2\n");
    let id = tc.open(&repo).await.repo.id;

    let page = graph_page(&tc, id.clone(), None, 100).await.unwrap();
    check_rows(&page.rows, true).unwrap();
    let wip = &page.rows[0];
    assert_eq!((wip.id.as_str(), wip.kind, wip.sha.clone(), wip.wip_count), (WIP_ID, GraphRowKind::Wip, None, Some(4)));
    assert_eq!(wip.summary, "");
    assert_eq!(wip.authored_at, None);
    assert_eq!(wip.parents, vec![head.clone()]);
    assert_eq!(wip.edges, vec![GraphEdge { top: None, bottom: Some(0), color: wip.color, dashed: true }]);
    let head_row = &page.rows[1];
    assert_eq!((head_row.id.as_str(), head_row.lane, head_row.is_head), (head.as_str(), 0, true));
    assert!(head_row.edges.contains(&GraphEdge { top: Some(0), bottom: None, color: wip.color, dashed: true }));
    assert!(head_row.edges.iter().filter(|e| e.top.is_none()).all(|e| !e.dashed));
    assert!(page.rows[2].edges.iter().all(|e| !e.dashed));

    // Follow-up pages have no WIP row.
    let first = graph_page(&tc, id.clone(), None, 1).await.unwrap();
    assert_eq!(ids(&first.rows), vec![WIP_ID, head.as_str()]);
    let second = graph_page(&tc, id.clone(), first.next_cursor, 1).await.unwrap();
    assert_eq!(second.rows.len(), 1);
    assert_eq!(second.rows[0].kind, GraphRowKind::Commit);
}

#[tokio::test]
async fn wip_line_passes_newer_branches_above_head() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let head = repo.head();
    repo.checkout_new("neuer");
    let n1 = repo.commit_file("n.txt", "1\n", "Neuer 1");
    let n2 = repo.commit_file("n.txt", "2\n", "Neuer 2");
    repo.checkout("main");
    repo.write_file("README.md", "# geändert\n");
    let id = tc.open(&repo).await.repo.id;

    let rows = all_rows(&tc, &id, 100).await;
    check_rows(&rows, true).unwrap();
    assert_eq!(ids(&rows), vec![WIP_ID, n2.as_str(), n1.as_str(), head.as_str()]);
    for sha in [&n2, &n1] {
        let row = find(&rows, sha);
        assert_eq!(row.lane, 1);
        assert!(row.edges.contains(&GraphEdge { top: Some(0), bottom: Some(0), color: rows[0].color, dashed: true }));
        assert!(!row.is_head);
    }
    assert_eq!(find(&rows, &head).lane, 0);
    assert!(find(&rows, &head).is_head);
}

#[tokio::test]
async fn branches_merges_tags_and_remote_refs() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let a = repo.head();
    repo.checkout_new("feature");
    let f1 = repo.commit_file("f.txt", "1\n", "Feature 1");
    let f2 = repo.commit_file("f.txt", "2\n", "Feature 2");
    repo.checkout("main");
    let b = repo.commit_file("b.txt", "b\n", "Main B");
    assert!(repo.merge("feature"));
    let m = repo.head();
    repo.tag("v1.0");
    repo.git(&["tag", "-a", "v2.0", "-m", "Version 2", &f1]);
    let _remote = repo.add_remote();
    repo.checkout_new("offen");
    let o = repo.commit_file("o.txt", "o\n", "Offen");
    repo.checkout("main");
    let id = tc.open(&repo).await.repo.id;

    let rows = all_rows(&tc, &id, 100).await;
    check_rows(&rows, true).unwrap();
    assert_eq!(rows.len(), 6);
    let merge = find(&rows, &m);
    assert_eq!(merge.kind, GraphRowKind::Merge);
    assert_eq!(merge.parents, vec![b.clone(), f2.clone()]);
    assert!(merge.is_head);
    assert_eq!(ref_names(merge), vec!["main", "origin/main", "v1.0"]);
    assert!(merge.refs[0].is_head && !merge.refs[1].is_head);
    assert_eq!(merge.refs.iter().map(|l| l.kind).collect::<Vec<_>>(), vec![RefKind::Local, RefKind::Remote, RefKind::Tag]);
    // Annotated tag: the label sits on the target commit, not on the tag object.
    assert_eq!(ref_names(find(&rows, &f1)), vec!["v2.0"]);
    assert_eq!(find(&rows, &f1).refs[0].full_name, "refs/tags/v2.0");
    assert_eq!(ref_names(find(&rows, &f2)), vec!["feature"]);
    assert_eq!(ref_names(find(&rows, &o)), vec!["offen"]);
    assert!(!find(&rows, &o).is_head);
    assert_eq!(find(&rows, &b).kind, GraphRowKind::Commit);
    assert_eq!(rows.last().map(|r| r.id.as_str()), Some(a.as_str()));
    // The feature commits run in their own lane next to the main line.
    assert_ne!(find(&rows, &f2).lane, find(&rows, &b).lane);
    assert_eq!(find(&rows, &f1).lane, find(&rows, &f2).lane);
    assert_eq!(find(&rows, &f1).color, find(&rows, &f2).color);
    assert!(rows.iter().map(|r| r.lane).max().unwrap() <= 2);
}

#[tokio::test]
async fn stash_rows_hang_on_their_base_commit() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let a = repo.head();
    let b = repo.commit_file("a.txt", "a\n", "Zweiter");
    repo.write_file("a.txt", "älter\n");
    repo.git(&["stash", "push", "-m", "älterer Stash"]);
    let c = repo.commit_file("c.txt", "c\n", "Dritter");
    repo.write_file("a.txt", "neuer\n");
    repo.write_file("unverfolgt.txt", "u\n");
    repo.git(&["stash", "push", "-u", "-m", "neuer Stash"]);
    let s0 = repo.git(&["rev-parse", "stash@{0}"]);
    let s1 = repo.git(&["rev-parse", "stash@{1}"]);
    let id = tc.open(&repo).await.repo.id;

    let rows = all_rows(&tc, &id, 100).await;
    check_rows(&rows, true).unwrap();
    // Only the stash commits themselves, not their helper commits (index, untracked files).
    assert_eq!(ids(&rows), vec![s0.as_str(), c.as_str(), s1.as_str(), b.as_str(), a.as_str()]);
    let newer = find(&rows, &s0);
    assert_eq!((newer.kind, newer.stash_index, newer.sha.as_deref()), (GraphRowKind::Stash, Some(0), Some(s0.as_str())));
    assert_eq!(newer.parents, vec![c.clone()]);
    assert_eq!(newer.summary, "On main: neuer Stash");
    assert_eq!(newer.author_name, AUTHOR_NAME);
    assert!(newer.authored_at.is_some());
    let older = find(&rows, &s1);
    assert_eq!((older.kind, older.stash_index), (GraphRowKind::Stash, Some(1)));
    assert_eq!(older.parents, vec![b.clone()]);
    assert_eq!(older.summary, "On main: älterer Stash");
    // At the side: the base commit stays in the main lane.
    assert_eq!((find(&rows, &c).lane, find(&rows, &b).lane), (0, 0));
    assert_eq!((newer.lane, older.lane), (1, 1));
    // Clean working directory after the stash: no WIP row.
    assert!(rows.iter().all(|r| r.kind != GraphRowKind::Wip));

    // Across the page boundary: the stash is on the same page directly before its base.
    assert_eq!(all_rows(&tc, &id, 1).await, rows);

    view_state_set(&tc, id.clone(), json!({ "hiddenRefs": [STASH_REF] })).await.unwrap();
    let rows = all_rows(&tc, &id, 100).await;
    assert_eq!(ids(&rows), vec![c.as_str(), b.as_str(), a.as_str()]);
}

#[tokio::test]
async fn stash_on_a_commit_no_branch_contains_still_shows() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    repo.git(&["checkout", "-q", "--detach"]);
    let lost = repo.commit_file("x.txt", "x\n", "Ohne Branch");
    repo.write_file("x.txt", "y\n");
    repo.git(&["stash", "push"]);
    let stash = repo.git(&["rev-parse", "stash@{0}"]);
    repo.checkout("main");
    let id = tc.open(&repo).await.repo.id;

    let rows = all_rows(&tc, &id, 100).await;
    check_rows(&rows, true).unwrap();
    assert_eq!(ids(&rows), vec![stash.as_str(), lost.as_str(), repo.head().as_str()]);
    assert_eq!(find(&rows, &lost).kind, GraphRowKind::Commit);
}

#[tokio::test]
async fn pages_join_seamlessly_whatever_the_page_size() {
    let tc = TestCore::new().await;
    let repo = branchy_repo(14);
    repo.checkout_new("unfertig");
    repo.commit_file("u.txt", "u\n", "Unfertig");
    repo.checkout("main");
    repo.write_file("main.txt", "offen\n");
    repo.git(&["stash", "push", "-m", "zwischendurch"]);
    repo.write_file("main.txt", "noch offen\n");
    let id = tc.open(&repo).await.repo.id;

    let whole = graph_page(&tc, id.clone(), None, 1000).await.unwrap();
    assert_eq!(whole.next_cursor, None);
    check_rows(&whole.rows, true).unwrap_or_else(|e| panic!("{e}\n{}", sketch(&whole.rows)));
    let commits = whole.rows.iter().filter(|r| matches!(r.kind, GraphRowKind::Commit | GraphRowKind::Merge)).count();
    let total: usize = repo.git(&["rev-list", "--count", "--branches"]).parse().unwrap();
    assert_eq!(commits, total);
    assert!(whole.rows.iter().any(|r| r.kind == GraphRowKind::Merge));
    assert_eq!(whole.rows[0].kind, GraphRowKind::Wip);
    assert_eq!(whole.rows.iter().filter(|r| r.kind == GraphRowKind::Stash).count(), 1);
    assert!(whole.max_lane >= 1);

    for size in [1, 2, 7, 13] {
        assert_eq!(all_rows(&tc, &id, size).await, whole.rows, "page size {size}");
    }

    // Exactly as many commits as the page holds: no cursor. One fewer: a last page with one commit.
    let exact = graph_page(&tc, id.clone(), None, total as u32).await.unwrap();
    assert_eq!(exact.next_cursor, None);
    assert_eq!(exact.rows, whole.rows);
    let short = graph_page(&tc, id.clone(), None, total as u32 - 1).await.unwrap();
    let rest = graph_page(&tc, id.clone(), short.next_cursor.clone(), 500).await.unwrap();
    assert!(short.next_cursor.is_some());
    assert_eq!((rest.rows.len(), rest.next_cursor), (1, None));

    // Limits: 0 becomes 1, very large values are capped.
    let tiny = graph_page(&tc, id.clone(), None, 0).await.unwrap();
    assert_eq!(tiny.rows.iter().filter(|r| r.kind != GraphRowKind::Wip && r.kind != GraphRowKind::Stash).count(), 1);
    assert_eq!(graph_page(&tc, id.clone(), None, u32::MAX).await.unwrap().rows, whole.rows);
}

#[tokio::test]
async fn cursor_is_refused_once_the_graph_changed() {
    let tc = TestCore::new().await;
    let repo = branchy_repo(6);
    let id = tc.open(&repo).await.repo.id;
    let first = graph_page(&tc, id.clone(), None, 3).await.unwrap();
    let cursor = first.next_cursor.clone().unwrap();
    assert!(graph_page(&tc, id.clone(), Some(cursor.clone()), 3).await.is_ok());

    // Only the working directory changes: the history is the same, the cursor stays valid.
    repo.write_file("main.txt", "offen\n");
    assert!(graph_page(&tc, id.clone(), Some(cursor.clone()), 3).await.is_ok());
    repo.git(&["checkout", "-q", "--", "main.txt"]);

    // Changed view.
    view_state_set(&tc, id.clone(), json!({ "hiddenRefs": ["refs/heads/feature/3"] })).await.unwrap();
    let err = graph_page(&tc, id.clone(), Some(cursor.clone()), 3).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::StaleState);
    view_state_set(&tc, id.clone(), json!({ "hiddenRefs": [] })).await.unwrap();
    assert!(graph_page(&tc, id.clone(), Some(cursor.clone()), 3).await.is_ok());

    // New commit, new tag, new stash: each time the old page no longer fits.
    repo.tag("neu");
    assert_eq!(graph_page(&tc, id.clone(), Some(cursor.clone()), 3).await.unwrap_err().code, ErrorCode::StaleState);
    repo.git(&["tag", "-d", "neu"]);
    assert!(graph_page(&tc, id.clone(), Some(cursor.clone()), 3).await.is_ok());
    repo.commit_file("x.txt", "x\n", "Neu");
    assert_eq!(graph_page(&tc, id.clone(), Some(cursor.clone()), 3).await.unwrap_err().code, ErrorCode::StaleState);

    for garbage in ["", "kein-cursor", "e30"] {
        let err = graph_page(&tc, id.clone(), Some(garbage.to_string()), 3).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::StaleState, "{garbage}");
    }
}

#[tokio::test]
async fn hidden_and_solo_refs_choose_the_start_points() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let a = repo.head();
    repo.checkout_new("feature");
    let f = repo.commit_file("f.txt", "f\n", "Feature");
    repo.checkout("main");
    repo.checkout_new("anderer");
    let o = repo.commit_file("o.txt", "o\n", "Anderer");
    repo.checkout("main");
    let b = repo.commit_file("b.txt", "b\n", "Main B");
    repo.checkout_new("oben");
    let t = repo.commit_file("t.txt", "t\n", "Oben");
    repo.checkout("main");
    repo.tag("marke");
    let id = tc.open(&repo).await.repo.id;

    let rows = all_rows(&tc, &id, 100).await;
    assert_eq!(rows.len(), 5);

    // Hidden: the branch is not a starting point and carries no label.
    view_state_set(&tc, id.clone(), json!({ "hiddenRefs": ["refs/heads/anderer", "refs/tags/marke"] })).await.unwrap();
    let rows = all_rows(&tc, &id, 100).await;
    check_rows(&rows, true).unwrap();
    assert!(rows.iter().all(|r| r.id != o));
    assert_eq!(rows.len(), 4);
    assert_eq!(ref_names(find(&rows, &b)), vec!["main"]);

    // The checked-out branch hidden: HEAD stays a starting point, only the label is missing.
    view_state_set(&tc, id.clone(), json!({ "hiddenRefs": ["refs/heads/main", "refs/heads/oben"] })).await.unwrap();
    let rows = all_rows(&tc, &id, 100).await;
    assert!(find(&rows, &b).is_head);
    assert_eq!(ref_names(find(&rows, &b)), vec!["marke"]);
    assert!(rows.iter().all(|r| r.id != t));

    // Solo: only this branch. HEAD is not in it – the WIP row stands without a line.
    repo.write_file("b.txt", "offen\n");
    view_state_set(&tc, id.clone(), json!({ "hiddenRefs": [], "soloRefs": ["refs/heads/feature"] })).await.unwrap();
    let rows = all_rows(&tc, &id, 100).await;
    check_rows(&rows, true).unwrap();
    assert_eq!(ids(&rows), vec![WIP_ID, f.as_str(), a.as_str()]);
    assert!(rows[0].edges.is_empty() && rows[0].parents.is_empty());
    assert!(rows.iter().all(|r| !r.is_head));

    // Solo on a branch that contains HEAD: the WIP line runs down to the HEAD commit.
    view_state_set(&tc, id.clone(), json!({ "soloRefs": ["refs/heads/oben"] })).await.unwrap();
    let rows = all_rows(&tc, &id, 100).await;
    check_rows(&rows, true).unwrap();
    assert_eq!(ids(&rows), vec![WIP_ID, t.as_str(), b.as_str(), a.as_str()]);
    assert_eq!(rows[0].parents, vec![b.clone()]);
    assert!(find(&rows, &t).edges.iter().any(|e| e.dashed && e.top == e.bottom));
    assert!(find(&rows, &b).is_head);

    // Two solo refs; a deleted solo ref on its own switches solo off.
    view_state_set(&tc, id.clone(), json!({ "soloRefs": ["refs/heads/feature", "refs/heads/anderer"] })).await.unwrap();
    let rows = all_rows(&tc, &id, 100).await;
    assert_eq!(rows.iter().filter(|r| r.kind != GraphRowKind::Wip).count(), 3);
    view_state_set(&tc, id.clone(), json!({ "soloRefs": ["refs/heads/gibt-es-nicht"] })).await.unwrap();
    assert_eq!(all_rows(&tc, &id, 100).await.iter().filter(|r| r.kind != GraphRowKind::Wip).count(), 5);
}

#[tokio::test]
async fn detached_head_and_its_commits_are_shown() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let a = repo.head();
    repo.git(&["checkout", "-q", "--detach"]);
    let d = repo.commit_file("d.txt", "d\n", "Nur über HEAD erreichbar");
    let id = tc.open(&repo).await.repo.id;

    let rows = all_rows(&tc, &id, 100).await;
    check_rows(&rows, true).unwrap();
    assert_eq!(ids(&rows), vec![d.as_str(), a.as_str()]);
    assert!(rows[0].is_head && rows[0].refs.is_empty());
    assert!(!rows[1].is_head);
    assert_eq!(ref_names(&rows[1]), vec!["main"]);
    assert!(!rows[1].refs[0].is_head);
}

#[tokio::test]
async fn shallow_clone_ends_cleanly_at_the_boundary() {
    let tc = TestCore::new().await;
    let source = TestRepo::with_commit();
    for i in 0..5 {
        source.commit_file("a.txt", format!("{i}\n"), &format!("Commit {i}"));
    }
    let url = format!("file:///{}", source.path().to_string_lossy().replace('\\', "/").trim_start_matches('/'));
    git_in(&source, source.temp_dir(), &["clone", "-q", "--depth", "2", &url, "flach"], None);
    let clone = source.temp_dir().join("flach");
    assert!(clone.join(".git").join("shallow").exists());
    let id = repo_open(&tc, clone.to_string_lossy().into_owned()).await.unwrap().repo.id;

    let rows = all_rows(&tc, &id, 100).await;
    assert_eq!(rows.len(), 2);
    // The missing parent of the boundary commit leaves no open line.
    check_rows(&rows, true).unwrap();
    assert!(rows[1].edges.iter().all(|e| e.bottom.is_none()));
    let found = commit_search(&tc, id.clone(), "Commit".into(), 50, None).await.unwrap();
    assert_eq!(found.len(), 2);
    let d = details_of(&tc, &id, &rows[1].id).await;
    assert!(d.commit.is_some());
    assert!(!tree_list(&tc, id.clone(), Some(rows[1].id.clone()), None).await.unwrap().is_empty());
}

#[tokio::test]
async fn works_during_a_conflict_and_beside_a_foreign_index_lock() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    repo.checkout_new("feature");
    repo.commit_file("README.md", "# Feature\n", "Feature");
    repo.checkout("main");
    let head = repo.commit_file("README.md", "# Main\n", "Main");
    assert!(!repo.merge("feature"));
    let lock = repo.path().join(".git").join("index.lock");
    std::fs::write(&lock, b"fremd").unwrap();
    let id = tc.open(&repo).await.repo.id;

    let rows = all_rows(&tc, &id, 100).await;
    check_rows(&rows, true).unwrap();
    assert_eq!(rows[0].kind, GraphRowKind::Wip);
    assert_eq!(rows[0].wip_count, Some(1));
    assert_eq!(rows[0].parents, vec![head.clone()]);
    assert_eq!(rows.len(), 4);
    let d = commit_details(&tc, id.clone(), DiffSource::Unstaged).await.unwrap();
    assert_eq!(d.files.len(), 1);
    assert_eq!((d.files[0].status, d.files[0].path.as_str()), (FileStatus::Conflicted, "README.md"));
    assert!(d.commit.is_none());
    assert!(!commit_search(&tc, id.clone(), "Feature".into(), 10, None).await.unwrap().is_empty());
    assert!(tree_list(&tc, id.clone(), None, None).await.unwrap().contains(&"README.md".to_string()));
    assert!(details_of(&tc, &id, &head).await.commit.is_some());
    // The foreign lock stays untouched.
    assert_eq!(std::fs::read(&lock).unwrap(), b"fremd");
}

#[tokio::test]
async fn user_config_does_not_change_the_parsing() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    repo.git(&["config", "log.showSignature", "true"]);
    repo.git(&["config", "i18n.logOutputEncoding", "ISO-8859-1"]);
    repo.git(&["config", "log.date", "relative"]);
    repo.git(&["config", "format.pretty", "oneline"]);
    repo.git(&["config", "log.decorate", "full"]);
    // Without the euro sign: only then can Git really re-encode the message to ISO-8859-1.
    let latin = repo.commit_file("l.txt", "l\n", "Größe ändern: äöü ß");
    let umlaut = repo.commit_file("a.txt", "a\n", "Größe: äöü ß €");
    let empty = repo.git(&["commit", "-q", "--allow-empty", "--allow-empty-message", "-m", ""]);
    let _ = empty;
    let nameless = repo.head();
    let id = tc.open(&repo).await.repo.id;

    let rows = all_rows(&tc, &id, 100).await;
    check_rows(&rows, true).unwrap();
    assert_eq!(rows.len(), 4);
    assert_eq!(find(&rows, &latin).summary, "Größe ändern: äöü ß");
    assert_eq!(find(&rows, &umlaut).summary, "Größe: äöü ß €");
    assert_eq!(find(&rows, &nameless).summary, "");
    let d = details_of(&tc, &id, &umlaut).await;
    assert_eq!(d.commit.unwrap().summary, "Größe: äöü ß €");
    assert_eq!(details_of(&tc, &id, &latin).await.commit.unwrap().summary, "Größe ändern: äöü ß");
    let found = commit_search(&tc, id.clone(), "Größe".into(), 10, None).await.unwrap();
    assert_eq!(found.iter().map(|c| c.summary.as_str()).collect::<Vec<_>>(), vec!["Größe: äöü ß €", "Größe ändern: äöü ß"]);
}

#[tokio::test]
async fn unknown_repo_and_missing_folder() {
    let tc = TestCore::new().await;
    assert_eq!(graph_page(&tc, "unbekannt".into(), None, 10).await.unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(commit_search(&tc, "unbekannt".into(), "x".into(), 10, None).await.unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(tree_list(&tc, "unbekannt".into(), None, None).await.unwrap_err().code, ErrorCode::NotFound);
    let err = commit_details(&tc, "unbekannt".into(), DiffSource::Unstaged).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);

    let repo = TestRepo::with_commit();
    let head = repo.head();
    let id = tc.open(&repo).await.repo.id;

    // The folder is no longer a repository (.git missing): that is reported, not "commit not found".
    std::fs::rename(repo.path().join(".git"), repo.temp_dir().join("git-weg")).unwrap();
    assert_eq!(graph_page(&tc, id.clone(), None, 10).await.unwrap_err().code, ErrorCode::NotARepo);
    assert_eq!(commit_search(&tc, id.clone(), "Erster".into(), 10, None).await.unwrap_err().code, ErrorCode::NotARepo);
    assert_eq!(tree_list(&tc, id.clone(), None, None).await.unwrap_err().code, ErrorCode::NotARepo);
    assert_eq!(tree_list(&tc, id.clone(), Some("HEAD".into()), None).await.unwrap_err().code, ErrorCode::NotARepo);
    for source in [DiffSource::Commit { sha: head.clone() }, DiffSource::Commit { sha: "HEAD".into() }, DiffSource::Staged, DiffSource::Range { from: head.clone(), to: None }] {
        let err = commit_details(&tc, id.clone(), source.clone()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotARepo, "{source:?}");
    }

    std::fs::rename(repo.path(), repo.temp_dir().join("verschoben")).unwrap();
    assert_eq!(graph_page(&tc, id.clone(), None, 10).await.unwrap_err().code, ErrorCode::PathNotFound);
}

#[tokio::test]
async fn old_commits_in_other_encodings_are_readable() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    // Latin-1 bytes in the message. Once the commit names its encoding: Git re-encodes itself.
    repo.write_file("../botschaft.txt", b"Gr\xfc\xdfe aus M\xfcnchen\n\nText mit \xe4\xf6\xfc.\n");
    repo.git(&["config", "i18n.commitEncoding", "ISO-8859-1"]);
    repo.git(&["commit", "-q", "--allow-empty", "-F", "../botschaft.txt"]);
    let declared = repo.head();
    repo.git(&["config", "--unset", "i18n.commitEncoding"]);
    // Once it does not – such a commit only comes about by bypassing `git commit` (which converts by itself),
    // e.g. through old imports. Here the encoding is guessed for display.
    let tree = repo.git(&["rev-parse", "HEAD^{tree}"]);
    let mut raw = format!("tree {tree}\nparent {declared}\n").into_bytes();
    raw.extend_from_slice(b"author J\xf6rg Wei\xdf <joerg@example.com> 1767300000 +0200\n");
    raw.extend_from_slice(b"committer J\xf6rg Wei\xdf <joerg@example.com> 1767300000 +0200\n\n");
    raw.extend_from_slice(b"Gr\xfc\xdfe aus M\xfcnchen\n\nText mit \xe4\xf6\xfc.\n");
    let undeclared = git_in(&repo, repo.path(), &["hash-object", "-t", "commit", "-w", "--stdin"], Some(raw));
    repo.git(&["update-ref", "refs/heads/main", &undeclared]);
    let id = tc.open(&repo).await.repo.id;

    let rows = all_rows(&tc, &id, 100).await;
    assert_eq!(ids(&rows)[..2], [undeclared.as_str(), declared.as_str()]);
    for sha in [&declared, &undeclared] {
        assert_eq!(find(&rows, sha).summary, "Grüße aus München", "{sha}");
        let c = details_of(&tc, &id, sha).await.commit.unwrap();
        assert_eq!((c.summary.as_str(), c.description.as_str()), ("Grüße aus München", "Text mit äöü."));
    }
    assert_eq!(find(&rows, &undeclared).author_name, "Jörg Weiß");
    let c = details_of(&tc, &id, &undeclared).await.commit.unwrap();
    assert_eq!((c.author.name.as_str(), c.author_offset_minutes), ("Jörg Weiß", 120));
    let found = commit_search(&tc, id.clone(), "joerg@example.com".into(), 10, None).await.unwrap();
    assert_eq!(found.iter().map(|c| (c.summary.as_str(), c.author.name.as_str())).collect::<Vec<_>>(), vec![("Grüße aus München", "Jörg Weiß")]);
    // The search only reliably finds what Git can re-encode to UTF-8.
    let found = commit_search(&tc, id.clone(), "München".into(), 10, None).await.unwrap();
    assert!(found.iter().any(|c| c.sha == declared));
    assert!(found.iter().all(|c| c.summary == "Grüße aus München"));
}

// ---------------------------------------------------------------------------
// commit_details
// ---------------------------------------------------------------------------

#[tokio::test]
async fn commit_metadata_with_zone_body_and_co_authors() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let root = repo.head();
    repo.write_file("a.txt", "a\n");
    repo.git(&["add", "-A"]);
    repo.git(&[
        "commit",
        "-q",
        "--date",
        "2026-03-01T10:00:00+0130",
        "--author",
        "Erika Müller <erika@example.com>",
        "-m",
        "Titel mit Umlauten: äöü",
        "-m",
        "Erste Zeile des Texts.\nZweite Zeile.",
        "-m",
        "Co-authored-by: Jörg Weiß <joerg@example.com>\nCo-authored-by: Ada <ada@example.com>",
    ]);
    let sha = repo.head();
    repo.tag("v1");
    let id = tc.open(&repo).await.repo.id;
    tc.events.clear();

    let d = details_of(&tc, &id, &sha).await;
    let c = d.commit.clone().unwrap();
    assert_eq!(c.sha, sha);
    assert_eq!(c.parents, vec![root.clone()]);
    assert_eq!(c.author, Person { name: "Erika Müller".into(), email: "erika@example.com".into() });
    assert_eq!(c.committer, Person { name: AUTHOR_NAME.into(), email: AUTHOR_EMAIL.into() });
    assert_eq!(c.authored_at, "2026-03-01T08:30:00.000Z");
    assert_eq!(c.author_offset_minutes, 90);
    assert!(c.committed_at.starts_with("2026-01-01T"), "{}", c.committed_at);
    assert_eq!(c.summary, "Titel mit Umlauten: äöü");
    assert_eq!(
        c.description,
        "Erste Zeile des Texts.\nZweite Zeile.\n\nCo-authored-by: Jörg Weiß <joerg@example.com>\nCo-authored-by: Ada <ada@example.com>"
    );
    assert_eq!(
        c.co_authors,
        vec![
            Person { name: "Jörg Weiß".into(), email: "joerg@example.com".into() },
            Person { name: "Ada".into(), email: "ada@example.com".into() },
        ]
    );
    assert_eq!(c.signature, SignatureStatus::None);
    assert_eq!(c.refs.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(), vec!["main", "v1"]);
    assert!(c.refs[0].is_head);
    assert!(c.is_head);
    assert!(!c.is_pushed);
    assert_eq!(d.files.len(), 1);
    assert_eq!((d.added, d.removed, d.not_combinable_reason.clone()), (1, 0, None));
    assert!(tc.events.all().is_empty());

    // Root commit: against the empty tree; no body, no labels, not HEAD.
    let d = details_of(&tc, &id, &root).await;
    let c = d.commit.unwrap();
    assert!(c.parents.is_empty());
    assert_eq!((c.summary.as_str(), c.description.as_str()), ("Erster Commit", ""));
    assert!(c.co_authors.is_empty() && c.refs.is_empty() && !c.is_head);
    assert_eq!(c.author_offset_minutes, 0);
    assert_eq!(d.files.len(), 1);
    assert_eq!((file(&d.files, "README.md").status, file(&d.files, "README.md").area), (FileStatus::Added, FileArea::Commit));
    assert_eq!((d.added, d.removed), (1, 0));

    // Fallback when signature verification hangs: the same data, signature "unknown".
    let path = tc.repo_path(&id).unwrap();
    let unverified = super::details::read_meta_with(&tc, &path, &id, &sha, false).await.unwrap();
    let verified = super::details::read_meta_with(&tc, &path, &id, &sha, true).await.unwrap();
    assert_eq!(unverified.signature, SignatureStatus::Unknown);
    assert_eq!(CommitInfo { signature: SignatureStatus::None, ..unverified }, verified);

    // Short SHA and names are resolved.
    assert_eq!(details_of(&tc, &id, &sha[..8]).await.commit.unwrap().sha, sha);
    assert_eq!(details_of(&tc, &id, "HEAD").await.commit.unwrap().sha, sha);
    assert_eq!(details_of(&tc, &id, &sha.to_uppercase()).await.commit.unwrap().sha, sha);
}

#[tokio::test]
async fn commit_files_with_every_kind_of_change() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    repo.write_file("alter name.txt", "Zeile 1\nZeile 2\nZeile 3\nZeile 4\n");
    repo.write_file("weg.txt", "eins\nzwei\n");
    repo.write_file("ändern.txt", "a\nb\nc\n");
    repo.write_file("bild.bin", [0u8, 1, 2, 3, 0, 255]);
    repo.write_file("crlf.txt", "eins\r\nzwei\r\ndrei\r\n");
    repo.write_file("ohne-nl.txt", "a");
    repo.write_file(".gitattributes", "*.dat filter=lfs\n");
    repo.commit("Ausgangslage");
    repo.git(&["mv", "alter name.txt", "neuer name.txt"]);
    repo.remove_file("weg.txt");
    repo.write_file("ändern.txt", "a\nB\nc\nd\n");
    repo.write_file("bild.bin", [9u8, 0, 9]);
    repo.write_file("crlf.txt", "eins\r\nZWEI\r\ndrei\r\n");
    repo.write_file("ohne-nl.txt", "a\nb");
    repo.write_file("ordner/neu ü.txt", "x\ny\n");
    repo.write_file("gross.dat", "inhalt\n");
    let sha = repo.commit("Alles auf einmal");
    let id = tc.open(&repo).await.repo.id;

    let d = details_of(&tc, &id, &sha).await;
    assert_eq!(d.files.len(), 8, "{:?}", d.files);
    assert!(d.files.iter().all(|f| f.area == FileArea::Commit && f.conflict.is_none()));
    let renamed = file(&d.files, "neuer name.txt");
    assert_eq!((renamed.status, renamed.old_path.as_deref(), renamed.added, renamed.removed), (FileStatus::Renamed, Some("alter name.txt"), Some(0), Some(0)));
    let deleted = file(&d.files, "weg.txt");
    assert_eq!((deleted.status, deleted.added, deleted.removed), (FileStatus::Deleted, Some(0), Some(2)));
    let modified = file(&d.files, "ändern.txt");
    assert_eq!((modified.status, modified.added, modified.removed, modified.old_path.clone()), (FileStatus::Modified, Some(2), Some(1), None));
    let binary = file(&d.files, "bild.bin");
    assert_eq!((binary.status, binary.is_binary, binary.added, binary.removed), (FileStatus::Modified, true, None, None));
    let crlf = file(&d.files, "crlf.txt");
    assert_eq!((crlf.added, crlf.removed, crlf.is_binary), (Some(1), Some(1), false));
    let no_newline = file(&d.files, "ohne-nl.txt");
    assert_eq!((no_newline.added, no_newline.removed), (Some(2), Some(1)));
    let added = file(&d.files, "ordner/neu ü.txt");
    assert_eq!((added.status, added.added, added.removed, added.is_lfs), (FileStatus::Added, Some(2), Some(0), false));
    let lfs = file(&d.files, "gross.dat");
    assert!(lfs.is_lfs);
    assert_eq!((d.added, d.removed), (8, 5));
}

#[tokio::test]
async fn merge_commit_is_compared_with_its_first_parent() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    repo.checkout_new("feature");
    repo.commit_file("f.txt", "1\n2\n", "Feature");
    repo.checkout("main");
    let b = repo.commit_file("b.txt", "b\n", "Main");
    assert!(repo.merge("feature"));
    let m = repo.head();
    let id = tc.open(&repo).await.repo.id;

    let d = details_of(&tc, &id, &m).await;
    let c = d.commit.unwrap();
    assert_eq!(c.parents.len(), 2);
    assert_eq!(c.parents[0], b);
    // Only what the merge brings in compared to main – b.txt was already there.
    assert_eq!(d.files.len(), 1);
    assert_eq!((d.files[0].path.as_str(), d.files[0].status, d.files[0].added), ("f.txt", FileStatus::Added, Some(2)));
}

#[tokio::test]
async fn pushed_means_contained_in_a_remote_branch() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let first = repo.head();
    let id = tc.open(&repo).await.repo.id;
    assert!(!details_of(&tc, &id, &first).await.commit.unwrap().is_pushed, "without a remote nothing is pushed");

    let _remote = repo.add_remote();
    let second = repo.commit_file("a.txt", "a\n", "Nur lokal");
    assert!(details_of(&tc, &id, &first).await.commit.unwrap().is_pushed);
    assert!(!details_of(&tc, &id, &second).await.commit.unwrap().is_pushed);
    let c = details_of(&tc, &id, &first).await.commit.unwrap();
    assert_eq!(c.refs.iter().map(|l| l.name.as_str()).collect::<Vec<_>>(), vec!["origin/main"]);
    assert!(!c.is_head);

    repo.git(&["push", "-q", "origin", "main:refs/heads/anderswo"]);
    assert!(details_of(&tc, &id, &second).await.commit.unwrap().is_pushed);
}

#[tokio::test]
async fn unknown_commits_are_not_found() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    for bad in ["0000000000000000000000000000000000000000", "gibt-es-nicht", "--all", "", "abc", "HEAD~5", "a b"] {
        let err = commit_details(&tc, id.clone(), DiffSource::Commit { sha: bad.to_string() }).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound, "{bad}");
        assert!(err.message.contains("not found"), "{}", err.message);
    }
    // A blob is not a commit.
    let blob = repo.git(&["rev-parse", "HEAD:README.md"]);
    let err = commit_details(&tc, id.clone(), DiffSource::Commit { sha: blob }).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);

    let empty = TestRepo::new();
    let empty_id = tc.open(&empty).await.repo.id;
    let err = commit_details(&tc, empty_id.clone(), DiffSource::Commit { sha: "HEAD".into() }).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    let err = commit_details(&tc, empty_id.clone(), DiffSource::Stash { index: 0 }).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    let d = commit_details(&tc, empty_id, DiffSource::Staged).await.unwrap();
    assert!(d.files.is_empty() && d.commit.is_none());
}

#[tokio::test]
async fn unstaged_and_staged_come_from_the_status() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    repo.write_file("README.md", "# Test\nmehr\n");
    repo.write_file("neu datei.txt", "1\n2\n3\n");
    repo.write_file("gestagt.txt", "g\n");
    repo.git(&["add", "gestagt.txt"]);
    let id = tc.open(&repo).await.repo.id;

    let unstaged = commit_details(&tc, id.clone(), DiffSource::Unstaged).await.unwrap();
    assert!(unstaged.commit.is_none());
    assert_eq!(unstaged.files.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["README.md", "neu datei.txt"]);
    assert_eq!(file(&unstaged.files, "neu datei.txt").status, FileStatus::Untracked);
    assert!(unstaged.files.iter().all(|f| f.area == FileArea::Unstaged));
    assert_eq!((unstaged.added, unstaged.removed), (4, 0));

    let staged = commit_details(&tc, id.clone(), DiffSource::Staged).await.unwrap();
    assert_eq!(staged.files.len(), 1);
    assert_eq!((staged.files[0].path.as_str(), staged.files[0].status, staged.files[0].area), ("gestagt.txt", FileStatus::Added, FileArea::Staged));
    assert_eq!((staged.added, staged.removed, staged.not_combinable_reason), (1, 0, None));
}

#[tokio::test]
async fn range_combines_commits_and_compares_with_the_worktree() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let a = repo.head();
    repo.write_file("bild.bin", [0u8, 1, 2]);
    repo.write_file("foto.bin", [0u8, 9, 9]);
    let b = repo.commit_file("eins.txt", "1\n", "Eins");
    repo.write_file("eins.txt", "1\n2\n");
    repo.write_file("zwei ä.txt", "z\n");
    let c = repo.commit("Zwei");
    repo.git(&["mv", "zwei ä.txt", "drei.txt"]);
    let d = repo.commit("Umbenannt");
    let id = tc.open(&repo).await.repo.id;
    let range = |from: &str, to: Option<&str>| DiffSource::Range { from: from.to_string(), to: to.map(str::to_string) };

    // a..d: everything together; the rename in between is only a new file in the result.
    let all = commit_details(&tc, id.clone(), range(&a, Some(&d))).await.unwrap();
    assert!(all.commit.is_none());
    assert_eq!(all.not_combinable_reason, None);
    assert_eq!(
        all.files.iter().map(|f| (f.path.as_str(), f.status, f.is_binary)).collect::<Vec<_>>(),
        vec![
            ("bild.bin", FileStatus::Added, true),
            ("drei.txt", FileStatus::Added, false),
            ("eins.txt", FileStatus::Added, false),
            ("foto.bin", FileStatus::Added, true),
        ]
    );
    assert_eq!((all.added, all.removed), (3, 0));
    assert!(all.files.iter().all(|f| f.area == FileArea::Commit));

    // b..d: changed and renamed; the other way round the diff is reversed.
    let part = commit_details(&tc, id.clone(), range(&b, Some(&d))).await.unwrap();
    assert_eq!((file(&part.files, "eins.txt").status, file(&part.files, "eins.txt").added), (FileStatus::Modified, Some(1)));
    assert_eq!(file(&part.files, "drei.txt").status, FileStatus::Added);
    let step = commit_details(&tc, id.clone(), range(&c, Some(&d))).await.unwrap();
    assert_eq!((step.files[0].status, step.files[0].old_path.as_deref()), (FileStatus::Renamed, Some("zwei ä.txt")));
    let back = commit_details(&tc, id.clone(), range(&d, Some(&b))).await.unwrap();
    assert_eq!((file(&back.files, "eins.txt").removed, file(&back.files, "drei.txt").status), (Some(1), FileStatus::Deleted));

    // Same commit: nothing to show, but no error.
    let same = commit_details(&tc, id.clone(), range(&d, Some(&d[..10]))).await.unwrap();
    assert!(same.files.is_empty() && same.not_combinable_reason.is_none());

    // Against the working directory: tracked changes (staged or not) plus untracked files.
    repo.write_file("eins.txt", "1\n2\n3\n");
    repo.write_file("gestagt.txt", "g\n");
    repo.git(&["add", "gestagt.txt"]);
    repo.write_file("unverfolgt ö.txt", "u\n");
    repo.write_file(".gitignore", "*.log\n");
    repo.write_file("egal.log", "x\n");
    // Same content, new timestamp (text and binary): `git diff` would rewrite the index for that
    // – a read command must not do that –, and without refreshing it would consider both changed.
    std::thread::sleep(std::time::Duration::from_millis(1100));
    repo.write_file("README.md", "# Test\n");
    repo.write_file("bild.bin", [0u8, 1, 2]);
    repo.write_file("foto.bin", [0u8, 7, 7, 7]);
    let index_before = std::fs::read(repo.path().join(".git").join("index")).unwrap();
    let live = commit_details(&tc, id.clone(), range(&b, None)).await.unwrap();
    assert_eq!(std::fs::read(repo.path().join(".git").join("index")).unwrap(), index_before, "the index was changed");
    let seen: Vec<(&str, FileStatus)> = live.files.iter().map(|f| (f.path.as_str(), f.status)).collect();
    assert_eq!(
        seen,
        vec![
            (".gitignore", FileStatus::Untracked),
            ("drei.txt", FileStatus::Added),
            ("eins.txt", FileStatus::Modified),
            ("foto.bin", FileStatus::Modified),
            ("gestagt.txt", FileStatus::Added),
            ("unverfolgt ö.txt", FileStatus::Untracked),
        ]
    );
    assert!(file(&live.files, "foto.bin").is_binary);
    assert_eq!(file(&live.files, "eins.txt").added, Some(2));
    assert_eq!(file(&live.files, "unverfolgt ö.txt").area, FileArea::Unstaged);
    assert!(live.commit.is_none() && live.not_combinable_reason.is_none());

    let err = commit_details(&tc, id.clone(), range("gibt-es-nicht", Some(&d))).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    let err = commit_details(&tc, id.clone(), range(&a, Some("--all"))).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
}

/// A series starting at the root commit: `from` is the empty tree.
#[tokio::test]
async fn range_from_the_empty_tree_covers_a_run_starting_at_the_root() {
    const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let root = repo.head();
    repo.commit_file("eins.txt", "1\n2\n", "Eins");
    repo.write_file("bild.bin", [0u8, 1, 2]);
    let third = repo.commit_file("README.md", "# Test\nmehr\n", "Drei");
    let id = tc.open(&repo).await.repo.id;
    let range = |from: &str, to: Option<&str>| DiffSource::Range { from: from.to_string(), to: to.map(str::to_string) };

    let all = commit_details(&tc, id.clone(), range(EMPTY_TREE, Some(&third))).await.unwrap();
    assert!(all.commit.is_none());
    assert_eq!(all.not_combinable_reason, None);
    assert_eq!(
        all.files.iter().map(|f| (f.path.as_str(), f.status, f.added)).collect::<Vec<_>>(),
        vec![("README.md", FileStatus::Added, Some(2)), ("bild.bin", FileStatus::Added, None), ("eins.txt", FileStatus::Added, Some(2))]
    );
    assert_eq!((all.added, all.removed), (4, 0));
    // Up to the root commit itself: the same as the root commit alone.
    let first = commit_details(&tc, id.clone(), range(&EMPTY_TREE.to_uppercase(), Some(&root))).await.unwrap();
    let alone = commit_details(&tc, id.clone(), DiffSource::Commit { sha: root.clone() }).await.unwrap();
    assert_eq!(first.files, alone.files);
    // Up to the working directory: everything tracked is new, plus the untracked files.
    repo.write_file("lokal.txt", "x\n");
    let live = commit_details(&tc, id.clone(), range(EMPTY_TREE, None)).await.unwrap();
    assert_eq!(
        live.files.iter().map(|f| (f.path.as_str(), f.status)).collect::<Vec<_>>(),
        vec![
            ("README.md", FileStatus::Added),
            ("bild.bin", FileStatus::Added),
            ("eins.txt", FileStatus::Added),
            ("lokal.txt", FileStatus::Untracked),
        ]
    );
    // Another tree or an abbreviated SHA of the empty tree is still not a commit.
    let err = commit_details(&tc, id.clone(), range(&EMPTY_TREE[..12], Some(&third))).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    let tree = repo.git(&["rev-parse", "HEAD^{tree}"]);
    let err = commit_details(&tc, id.clone(), range(&tree, Some(&third))).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
}

#[tokio::test]
async fn range_between_unrelated_histories_explains_itself() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let main = repo.head();
    repo.git(&["checkout", "-q", "--orphan", "fremd"]);
    let other = repo.commit_file("fremd.txt", "f\n", "Fremde Wurzel");
    repo.checkout("main");
    let id = tc.open(&repo).await.repo.id;

    let d = commit_details(&tc, id.clone(), DiffSource::Range { from: main.clone(), to: Some(other.clone()) }).await.unwrap();
    assert!(d.files.is_empty() && d.commit.is_none());
    let reason = d.not_combinable_reason.unwrap();
    assert!(reason.contains("share no history"), "{reason}");
    // Diverged branches with a common ancestor are an ordinary comparison.
    repo.checkout_new("zweig");
    let side = repo.commit_file("z.txt", "z\n", "Zweig");
    repo.checkout("main");
    let ahead = repo.commit_file("m.txt", "m\n", "Main");
    let d = commit_details(&tc, id.clone(), DiffSource::Range { from: side, to: Some(ahead) }).await.unwrap();
    assert_eq!(d.not_combinable_reason, None);
    assert_eq!(d.files.len(), 2);
}

#[tokio::test]
async fn stash_details_include_untracked_files() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    repo.commit_file("a.txt", "a\n", "Zweiter");
    repo.write_file("a.txt", "a\nb\n");
    repo.write_file("gestagt.txt", "g\n");
    repo.git(&["add", "gestagt.txt"]);
    repo.write_file("unverfolgt mit ü.txt", "1\n2\n");
    repo.git(&["stash", "push", "-u", "-m", "mit allem"]);
    repo.write_file("README.md", "# anders\n");
    repo.git(&["stash", "push"]);
    let older = repo.git(&["rev-parse", "stash@{1}"]);
    let id = tc.open(&repo).await.repo.id;

    let d = commit_details(&tc, id.clone(), DiffSource::Stash { index: 1 }).await.unwrap();
    let c = d.commit.clone().unwrap();
    assert_eq!(c.sha, older);
    assert_eq!(c.summary, "On main: mit allem");
    assert_eq!(c.description, "");
    assert_eq!(c.parents.len(), 3);
    assert!(!c.is_pushed && !c.is_head && c.refs.is_empty());
    let seen: Vec<(&str, FileStatus, Option<u32>)> = d.files.iter().map(|f| (f.path.as_str(), f.status, f.added)).collect();
    assert_eq!(
        seen,
        vec![
            ("a.txt", FileStatus::Modified, Some(1)),
            ("gestagt.txt", FileStatus::Added, Some(1)),
            ("unverfolgt mit ü.txt", FileStatus::Untracked, Some(2)),
        ]
    );
    assert_eq!((d.added, d.removed), (4, 0));

    let d = commit_details(&tc, id.clone(), DiffSource::Stash { index: 0 }).await.unwrap();
    assert_eq!(d.files.len(), 1);
    assert_eq!(d.files[0].path, "README.md");
    assert!(d.commit.unwrap().summary.starts_with("WIP on main:"));

    let err = commit_details(&tc, id.clone(), DiffSource::Stash { index: 2 }).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    assert!(err.message.contains("Stash no. 2"), "{}", err.message);
}

// ---------------------------------------------------------------------------
// commit_search
// commit_search

#[tokio::test]
async fn search_covers_message_author_and_sha_over_all_refs() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let root = repo.head();
    let fix = repo.commit_file("a.txt", "a\n", "Fix: Absturz beim Öffnen (a.c)");
    repo.write_file("b.txt", "b\n");
    repo.git(&["add", "-A"]);
    repo.git(&["commit", "-q", "--author", "Erika Müller <erika@firma.example>", "-m", "Neue Funktion", "-m", "Im Text steht ABSTURZ noch einmal."]);
    let by_erika = repo.head();
    repo.checkout_new("seitenzweig");
    let side = repo.commit_file("s.txt", "s\n", "Nur auf dem Seitenzweig: axc [x]");
    repo.checkout("main");
    repo.git(&["checkout", "-q", "--detach"]);
    let tagged = repo.commit_file("t.txt", "t\n", "Nur über ein Tag erreichbar");
    repo.tag("nur-tag");
    repo.checkout("main");
    let id = tc.open(&repo).await.repo.id;
    tc.events.clear();
    let search = |q: &str, limit: u32| commit_search(&tc, id.clone(), q.to_string(), limit, None);
    let shas = |found: &[CommitSummary]| found.iter().map(|c| c.sha.clone()).collect::<Vec<_>>();

    // Message: case-insensitive, also in the body below the first line; newest first.
    let found = search("absturz", 50).await.unwrap();
    assert_eq!(shas(&found), vec![by_erika.clone(), fix.clone()]);
    assert_eq!(found[1].summary, "Fix: Absturz beim Öffnen (a.c)");
    assert_eq!(found[1].author, Person { name: AUTHOR_NAME.into(), email: AUTHOR_EMAIL.into() });
    assert_eq!(found[1].parents, vec![root.clone()]);
    assert!(found[1].authored_at.ends_with('Z'));

    // Fixed text, no regular expression: "a.c" does not match "axc", "[x]" is meant literally.
    assert_eq!(shas(&search("a.c", 50).await.unwrap()), vec![fix.clone()]);
    assert_eq!(shas(&search("[x]", 50).await.unwrap()), vec![side.clone()]);
    assert_eq!(shas(&search(".*", 50).await.unwrap()), Vec::<String>::new());

    // Other branches, tags and spaces around the input.
    assert_eq!(shas(&search("  seitenzweig ", 50).await.unwrap()), vec![side.clone()]);
    assert_eq!(shas(&search("über ein Tag", 50).await.unwrap()), vec![tagged.clone()]);

    // Author: name or e-mail.
    assert_eq!(shas(&search("erika", 50).await.unwrap()), vec![by_erika.clone()]);
    assert_eq!(shas(&search("FIRMA.example", 50).await.unwrap()), vec![by_erika.clone()]);
    assert_eq!(search(AUTHOR_EMAIL, 50).await.unwrap().len(), 4);

    // SHA prefix from four characters on, upper case too.
    assert_eq!(shas(&search(&fix[..4], 50).await.unwrap()), vec![fix.clone()]);
    assert_eq!(shas(&search(&fix[..12].to_uppercase(), 50).await.unwrap()), vec![fix.clone()]);
    assert_eq!(shas(&search(&fix, 50).await.unwrap()), vec![fix.clone()]);
    assert_eq!(shas(&search(&tagged[..7], 50).await.unwrap()), vec![tagged.clone()]);

    // Limit, empty input, nothing found.
    let limited = search(AUTHOR_EMAIL, 2).await.unwrap();
    assert_eq!(shas(&limited), vec![tagged.clone(), side.clone()]);
    assert!(search("", 50).await.unwrap().is_empty());
    assert!(search("   ", 50).await.unwrap().is_empty());
    assert!(search("kommt nirgends vor", 50).await.unwrap().is_empty());
    assert!(search("--all", 50).await.unwrap().is_empty());
    assert!(tc.events.all().is_empty());
}

#[tokio::test]
async fn search_ignores_objects_the_graph_cannot_show() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let keep = repo.head();
    let dropped = repo.commit_file("weg.txt", "w\n", "Verworfener Commit");
    repo.git(&["reset", "-q", "--hard", &keep]);
    let blob = repo.git(&["rev-parse", "HEAD:README.md"]);
    let tree = repo.git(&["rev-parse", "HEAD^{tree}"]);
    repo.git(&["tag", "-a", "mit-objekt", "-m", "Tag-Objekt"]);
    let tag_object = repo.git(&["rev-parse", "refs/tags/mit-objekt"]);
    let id = tc.open(&repo).await.repo.id;

    // The commit still exists in the object store but hangs off no ref.
    assert!(commit_search(&tc, id.clone(), dropped[..10].to_string(), 10, None).await.unwrap().is_empty());
    assert!(commit_search(&tc, id.clone(), "Verworfener".into(), 10, None).await.unwrap().is_empty());
    for other in [&blob, &tree, &tag_object] {
        assert!(commit_search(&tc, id.clone(), other[..10].to_string(), 10, None).await.unwrap().is_empty(), "{other}");
    }
    assert_eq!(commit_search(&tc, id.clone(), keep[..10].to_string(), 10, None).await.unwrap().len(), 1);
}

#[tokio::test]
async fn search_in_an_empty_repo_and_on_a_detached_head() {
    let tc = TestCore::new().await;
    let empty = TestRepo::new();
    let id = tc.open(&empty).await.repo.id;
    assert!(commit_search(&tc, id.clone(), "irgendwas".into(), 10, None).await.unwrap().is_empty());
    assert!(commit_search(&tc, id.clone(), "abcd".into(), 10, None).await.unwrap().is_empty());

    let repo = TestRepo::with_commit();
    repo.git(&["checkout", "-q", "--detach"]);
    let detached = repo.commit_file("d.txt", "d\n", "Losgelöst");
    let id = tc.open(&repo).await.repo.id;
    let found = commit_search(&tc, id.clone(), "losgelöst".into(), 10, None).await.unwrap();
    // Case-insensitivity applies to ASCII; umlauts must match exactly.
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].sha, detached);
    assert_eq!(commit_search(&tc, id.clone(), detached[..6].to_string(), 10, None).await.unwrap().len(), 1);
}

#[tokio::test]
async fn a_newer_search_cancels_the_running_one() {
    let tc = TestCore::new().await;
    let repo = branchy_repo(4);
    let id = tc.open(&repo).await.repo.id;
    // Both start in the same tick: the second request cancels the first.
    let (first, second) = tokio::join!(
        commit_search(&tc, id.clone(), "Main".into(), 10, None),
        commit_search(&tc, id.clone(), "Feature".into(), 10, None),
    );
    // Whether the older search is still running when the new one starts depends on the platform (on
    // Linux it is often already finished): cancelled or complete, never a wrong result.
    // The cancellation itself is checked by the tests in `search.rs` without timing.
    match first {
        Err(error) => assert_eq!(error.code, ErrorCode::Cancelled),
        Ok(found) => assert_eq!(found.len(), 4),
    }
    // Four feature commits and the merge commit ("Merge branch 'feature/0'").
    assert_eq!(second.unwrap().len(), 5);
    // Nothing is left hanging afterwards; another repository would be untouched anyway.
    assert_eq!(commit_search(&tc, id.clone(), "Main".into(), 10, None).await.unwrap().len(), 4);
}

/// Palette and search bar search at the same time: with their own `searchId` neither cancels the other.
#[tokio::test]
async fn searches_with_their_own_id_run_side_by_side() {
    let tc = TestCore::new().await;
    let repo = branchy_repo(4);
    let id = tc.open(&repo).await.repo.id;
    let (palette, bar, shared) = tokio::join!(
        commit_search(&tc, id.clone(), "Main".into(), 10, Some("palette".into())),
        commit_search(&tc, id.clone(), "Feature".into(), 10, Some("searchbar".into())),
        commit_search(&tc, id.clone(), "Main".into(), 10, None),
    );
    assert_eq!(palette.unwrap().len(), 4);
    assert_eq!(bar.unwrap().len(), 5);
    assert_eq!(shared.unwrap().len(), 4);
    // The same ID still cancels the older search; an empty ID counts as none.
    let (first, second, third) = tokio::join!(
        commit_search(&tc, id.clone(), "Main".into(), 10, Some("palette".into())),
        commit_search(&tc, id.clone(), "Feature".into(), 10, Some("palette".into())),
        commit_search(&tc, id.clone(), "Main".into(), 10, Some("  ".into())),
    );
    // Whether the older search is still running when the new one starts depends on the platform (on
    // Linux it is often already finished): cancelled or complete, never a wrong result.
    // The cancellation itself is checked by the tests in `search.rs` without timing.
    match first {
        Err(error) => assert_eq!(error.code, ErrorCode::Cancelled),
        Ok(found) => assert_eq!(found.len(), 4),
    }
    assert_eq!(second.unwrap().len(), 5);
    assert_eq!(third.unwrap().len(), 4);
}

/// Tauri requires futures that are `Send`.
#[tokio::test]
async fn command_futures_are_send() {
    fn assert_send<T: Send>(value: T) -> T {
        value
    }
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    let head = repo.head();
    assert_eq!(assert_send(graph_page(&tc, id.clone(), None, 10)).await.unwrap().rows.len(), 1);
    assert!(assert_send(commit_details(&tc, id.clone(), DiffSource::Commit { sha: head.clone() })).await.is_ok());
    assert_eq!(assert_send(commit_search(&tc, id.clone(), "Erster".into(), 10, None)).await.unwrap().len(), 1);
    assert_eq!(assert_send(tree_list(&tc, id.clone(), Some(head.clone()), None)).await.unwrap(), vec!["README.md"]);
    assert_eq!(assert_send(resolve_commit(&tc, &id, "main")).await.unwrap(), head);
}

// ---------------------------------------------------------------------------
// tree_list
// ---------------------------------------------------------------------------

#[tokio::test]
async fn tree_of_a_commit_and_of_the_worktree() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    repo.write_file("src/Haupt Datei.rs", "x\n");
    repo.write_file("src/tief/ünïcödé.txt", "y\n");
    repo.write_file(".gitignore", "*.log\nbuild/\n");
    let first = repo.commit("Dateien");
    repo.write_file("später.txt", "z\n");
    let second = repo.commit("Später");
    let id = tc.open(&repo).await.repo.id;
    tc.events.clear();
    let list = |sha: Option<&str>, filter: Option<&str>| tree_list(&tc, id.clone(), sha.map(str::to_string), filter.map(str::to_string));

    assert_eq!(list(Some(&first), None).await.unwrap(), vec![".gitignore", "README.md", "src/Haupt Datei.rs", "src/tief/ünïcödé.txt"]);
    assert_eq!(list(Some(&second), None).await.unwrap().len(), 5);
    assert_eq!(list(Some("HEAD~1"), None).await.unwrap().len(), 4);

    // Filter: case-insensitive substring, also across folder boundaries and with a backslash.
    assert_eq!(list(Some(&second), Some("haupt datei")).await.unwrap(), vec!["src/Haupt Datei.rs"]);
    assert_eq!(list(Some(&second), Some("SRC\\TIEF")).await.unwrap(), vec!["src/tief/ünïcödé.txt"]);
    assert_eq!(list(Some(&second), Some("ÜNÏ")).await.unwrap(), vec!["src/tief/ünïcödé.txt"]);
    assert_eq!(list(Some(&second), Some("  ")).await.unwrap().len(), 5);
    assert!(list(Some(&second), Some("gibt es nicht")).await.unwrap().is_empty());

    // Working directory: tracked and untracked, without ignored and without deleted ones.
    repo.write_file("neu unverfolgt.txt", "n\n");
    repo.write_file("egal.log", "l\n");
    repo.write_file("build/out.bin", "b\n");
    repo.write_file("gestagt.txt", "g\n");
    repo.git(&["add", "gestagt.txt"]);
    repo.remove_file("später.txt");
    assert_eq!(
        list(None, None).await.unwrap(),
        vec![".gitignore", "README.md", "gestagt.txt", "neu unverfolgt.txt", "src/Haupt Datei.rs", "src/tief/ünïcödé.txt"]
    );
    assert_eq!(list(None, Some("UNVERFOLGT")).await.unwrap(), vec!["neu unverfolgt.txt"]);

    let err = list(Some("gibt-es-nicht"), None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);
    assert_eq!(list(Some("--all"), None).await.unwrap_err().code, ErrorCode::NotFound);
    assert!(tc.events.all().is_empty());

    // Repository without a commit: only the working directory exists.
    let empty = TestRepo::new();
    empty.write_file("erste.txt", "1\n");
    let empty_id = tc.open(&empty).await.repo.id;
    assert_eq!(tree_list(&tc, empty_id.clone(), None, None).await.unwrap(), vec!["erste.txt"]);
    assert_eq!(tree_list(&tc, empty_id, Some("HEAD".into()), None).await.unwrap_err().code, ErrorCode::NotFound);
}

// ---------------------------------------------------------------------------
// Performance (acceptance criterion of the architecture)
// ---------------------------------------------------------------------------

/// Writes a stream for `git fast-import`.
struct Importer {
    out: String,
    mark: u32,
    commits: usize,
}

impl Importer {
    /// Commit on `branch`; without `from` the first commit (with one file).
    fn commit(&mut self, branch: &str, message: &str, from: Option<u32>, merge: Option<u32>) -> u32 {
        self.mark += 1;
        self.commits += 1;
        let mark = self.mark;
        let time = BASE_TIME + 60 * i64::from(mark);
        let who = format!("Person {} <person{}@example.com>", mark % 40, mark % 40);
        self.out.push_str(&format!("commit refs/heads/{branch}\nmark :{mark}\nauthor {who} {time} +0000\ncommitter {who} {time} +0000\n"));
        self.out.push_str(&format!("data {}\n{message}\n", message.len()));
        match from {
            Some(parent) => self.out.push_str(&format!("from :{parent}\n")),
            None => self.out.push_str("M 100644 :1 datei.txt\n"),
        }
        if let Some(other) = merge {
            self.out.push_str(&format!("merge :{other}\n"));
        }
        self.out.push('\n');
        mark
    }
}

/// Large history: a main line, short merged feature branches, long-lived open
/// release branches, tags and a remote ref. Returns the stream and the number of commits.
fn big_history(target: usize) -> (Vec<u8>, usize) {
    let mut imp = Importer { out: String::with_capacity(target * 220), mark: 1, commits: 0 };
    imp.out.push_str("blob\nmark :1\ndata 6\nhallo\n\n");
    let mut main = imp.commit("main", "Anfang", None, None);
    let mut pending: Option<(usize, u32)> = None;
    let mut step = 0usize;
    while imp.commits < target {
        step += 1;
        let merge = match pending {
            Some((due, tip)) if due == step => {
                pending = None;
                Some(tip)
            }
            _ => None,
        };
        let message = if merge.is_some() { format!("Merge Arbeit {step}") } else { format!("Hauptlinie {step}") };
        main = imp.commit("main", &message, Some(main), merge);
        if step % 7 == 0 && pending.is_none() {
            let mut tip = main;
            for part in 0..3 {
                tip = imp.commit("arbeit", &format!("Arbeit {step}.{part}"), Some(tip), None);
            }
            pending = Some((step + 4, tip));
        }
        if step % 400 == 0 {
            let name = format!("release/{}", step / 400);
            let mut tip = main;
            for part in 0..5 {
                tip = imp.commit(&name, &format!("Release {step}.{part}"), Some(tip), None);
            }
        }
        if step % 1000 == 0 {
            imp.out.push_str(&format!("reset refs/tags/v{}\nfrom :{main}\n\n", step / 1000));
        }
    }
    imp.out.push_str(&format!("reset refs/remotes/origin/main\nfrom :{}\n\n", main - 200));
    (imp.out.into_bytes(), imp.commits)
}

/// `cargo test -p gitcore --lib commands::graph::tests::performance -- --ignored --nocapture`
#[tokio::test(flavor = "multi_thread")]
#[ignore = "performance measurement with 50 000 commits; run by hand"]
async fn performance_with_50k_commits() {
    let tc = TestCore::new().await;
    let repo = TestRepo::new();
    let started = Instant::now();
    let (stream, total) = big_history(50_000);
    git_in(&repo, repo.path(), &["fast-import", "--quiet"], Some(stream));
    repo.git(&["reset", "-q", "--hard", "main"]);
    let branches = repo.git(&["for-each-ref", "--format=%(refname)"]).lines().count();
    println!("repository with {total} commits and {branches} refs created in {:?}", started.elapsed());
    assert!(total >= 50_000);
    let id = tc.open(&repo).await.repo.id;

    // First page: three times, the fastest and the slowest measurement.
    let mut first_times = Vec::new();
    let mut first = None;
    for _ in 0..3 {
        let t = Instant::now();
        let page = graph_page(&tc, id.clone(), None, 2000).await.unwrap();
        first_times.push(t.elapsed());
        first = Some(page);
    }
    let first = first.unwrap();
    assert_eq!(first.rows.len(), 2000);
    println!("first page (2000 rows): {first_times:?}, widest lane {}", first.max_lane);

    let mut rows = first.rows;
    let mut cursor = first.next_cursor;
    let mut times = Vec::new();
    let mut widest = first.max_lane;
    let mut longest_cursor = 0;
    while let Some(c) = cursor {
        longest_cursor = longest_cursor.max(c.len());
        let t = Instant::now();
        let page = graph_page(&tc, id.clone(), Some(c), 500).await.unwrap();
        times.push(t.elapsed());
        widest = widest.max(page.max_lane);
        rows.extend(page.rows);
        cursor = page.next_cursor;
    }
    let mut sorted = times.clone();
    sorted.sort();
    println!("follow-up pages: median {:?}, 90 % below {:?}", sorted[sorted.len() / 2], sorted[sorted.len() * 9 / 10]);
    let path = tc.repo_path(&id).unwrap();
    for skip in [0, 10_000, 25_000, 49_000] {
        let t = Instant::now();
        let out = read_cmd(&tc, &path, &id)
            .args(["log", "--topo-order", "-z", "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s", "--max-count=501"])
            .arg(format!("--skip={skip}"))
            .args(["--branches", "--remotes", "--tags", "HEAD"])
            .run()
            .await
            .unwrap();
        println!("git log only --skip={skip}: {:?} ({} bytes)", t.elapsed(), out.stdout.len());
    }
    // To put the outliers in context: the same smallest Git call 100 times. If even that varies a lot,
    // it is the machine (process start under load), not the page.
    let mut spawn_times = Vec::new();
    for _ in 0..100 {
        let t = Instant::now();
        read_cmd(&tc, &path, &id).args(["rev-parse", "-q", "--verify", "HEAD^{commit}"]).run().await.unwrap();
        spawn_times.push(t.elapsed());
    }
    spawn_times.sort();
    println!("100 times git rev-parse HEAD: median {:?}, slowest {:?}", spawn_times[50], spawn_times[99]);
    let t = Instant::now();
    read_ref_tips(&tc, &path, &id, None).await.unwrap();
    println!("for-each-ref only: {:?}", t.elapsed());
    let t = Instant::now();
    read_stashes(&tc, &path, &id).await.unwrap();
    println!("stash list only: {:?}", t.elapsed());
    let slowest = times.iter().max().unwrap();
    let sum: std::time::Duration = times.iter().sum();
    println!(
        "{} follow-up pages (500 each): mean {:?}, slowest {:?}, first {:?}, last {:?}; widest lane {widest}, longest cursor {longest_cursor} characters",
        times.len(),
        sum / times.len() as u32,
        slowest,
        times[0],
        times[times.len() - 1]
    );
    assert_eq!(rows.len(), total);
    let t = Instant::now();
    check_rows(&rows, true).unwrap();
    println!("layout across all {} rows checked in {:?}", rows.len(), t.elapsed());

    let t = Instant::now();
    let found = commit_search(&tc, id.clone(), "Arbeit 3500.1".into(), 100, None).await.unwrap();
    println!("search by message across the whole history: {:?} ({} hits)", t.elapsed(), found.len());
    assert_eq!(found.len(), 1);
    let old = rows[rows.len() - 10].id.clone();
    let t = Instant::now();
    let found = commit_search(&tc, id.clone(), old[..10].to_string(), 100, None).await.unwrap();
    println!("search by SHA prefix: {:?} ({} hits)", t.elapsed(), found.len());
    assert_eq!(found.len(), 1);
    let t = Instant::now();
    let found = commit_search(&tc, id.clone(), "person7@example.com".into(), 200, None).await.unwrap();
    println!("search by author: {:?} ({} hits)", t.elapsed(), found.len());
    assert_eq!(found.len(), 200);

    let t = Instant::now();
    let d = details_of(&tc, &id, &rows[0].id).await;
    println!("details of the newest commit: {:?}", t.elapsed());
    assert!(d.commit.is_some());
    let t = Instant::now();
    let d = details_of(&tc, &id, &old).await;
    println!("details of a very old commit (isPushed = {}): {:?}", d.commit.as_ref().unwrap().is_pushed, t.elapsed());
    assert!(d.commit.unwrap().is_pushed);

    // With a commit-graph file (which `git gc` creates by itself) Git no longer has to read the whole history.
    let t = Instant::now();
    repo.git(&["commit-graph", "write", "--reachable"]);
    println!("git commit-graph write: {:?}", t.elapsed());
    let mut with_graph = Vec::new();
    let mut cursor = None;
    let mut rows_with_graph = Vec::new();
    for size in [2000, 500, 500, 500] {
        let t = Instant::now();
        let page = graph_page(&tc, id.clone(), cursor, size).await.unwrap();
        with_graph.push(t.elapsed());
        rows_with_graph.extend(page.rows);
        cursor = page.next_cursor;
    }
    println!("with commit-graph: first page and three follow-up pages {with_graph:?}");
    assert_eq!(rows_with_graph[..], rows[..rows_with_graph.len()]);
    for skip in [0, 25_000, 49_000] {
        let t = Instant::now();
        read_cmd(&tc, &path, &id)
            .args(["log", "--topo-order", "-z", "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%s", "--max-count=501"])
            .arg(format!("--skip={skip}"))
            .args(["--branches", "--remotes", "--tags", "HEAD"])
            .run()
            .await
            .unwrap();
        println!("with commit-graph, git log only --skip={skip}: {:?}", t.elapsed());
    }

    // What is checked is the normal case (fastest first page, 90 % of the follow-up pages): single outliers
    // on a busy machine show up at the top of the output but do not make the test fail.
    assert!(first_times.iter().min().unwrap().as_secs_f64() < 2.0, "first page too slow: {first_times:?}");
    assert!(sorted[sorted.len() * 9 / 10].as_secs_f64() < 2.0, "follow-up pages too slow: {sorted:?}");
}

// ---------------------------------------------------------------------------
// Collapsed merges
// ---------------------------------------------------------------------------

/// main: A ── m1 ── M (merge of feature) ── m2; feature: f1 ── f2 off A. The branch `feature`
/// is deleted afterwards, so no ref keeps f1 and f2 visible. Returns `[a, f1, f2, m1, merge, m2]`.
fn merged_feature() -> (TestRepo, [String; 6]) {
    let repo = TestRepo::with_commit();
    let a = repo.head();
    repo.checkout_new("feature");
    let f1 = repo.commit_file("f.txt", "1\n", "Feature 1");
    let f2 = repo.commit_file("f.txt", "2\n", "Feature 2");
    repo.checkout("main");
    let m1 = repo.commit_file("m.txt", "1\n", "Main 1");
    assert!(repo.merge("feature"));
    let merge = repo.head();
    let m2 = repo.commit_file("m.txt", "2\n", "Main 2");
    repo.git(&["branch", "-D", "feature"]);
    (repo, [a, f1, f2, m1, merge, m2])
}

#[tokio::test]
async fn a_collapsed_merge_hides_its_side_commits_on_every_page_size() {
    let tc = TestCore::new().await;
    let (repo, [a, f1, f2, m1, merge, m2]) = merged_feature();
    let id = tc.open(&repo).await.repo.id;
    let before = graph_page(&tc, id.clone(), None, 1).await.unwrap();

    view_state_set(&tc, id.clone(), json!({"collapsedMerges": [&merge]})).await.unwrap();
    // The view changed: a cursor from before no longer fits.
    let err = graph_page(&tc, id.clone(), before.next_cursor, 1).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::StaleState);

    for page_size in [100, 1, 2, 3] {
        let rows = all_rows(&tc, &id, page_size).await;
        assert_eq!(ids(&rows), vec![m2.as_str(), merge.as_str(), m1.as_str(), a.as_str()], "page size {page_size}\n{}", sketch(&rows));
        assert!(!ids(&rows).contains(&f1.as_str()));
        check_rows(&rows, true).unwrap();
        let row = find(&rows, &merge);
        assert_eq!((row.kind, row.collapsed_count, row.collapse_too_large), (GraphRowKind::Merge, Some(2), false));
        assert_eq!(row.parents, vec![m1.clone(), f2.clone()]);
        assert_eq!(find(&rows, &m2).collapsed_count, None);
    }

    view_state_set(&tc, id.clone(), json!({"collapsedMerges": []})).await.unwrap();
    let rows = all_rows(&tc, &id, 100).await;
    assert_eq!(rows.len(), 6);
    assert_eq!(find(&rows, &merge).collapsed_count, None);
    check_rows(&rows, true).unwrap();
}

#[tokio::test]
async fn a_ref_on_the_side_branch_keeps_its_commits_visible() {
    let tc = TestCore::new().await;
    let (repo, [a, f1, f2, m1, merge, m2]) = merged_feature();
    repo.git(&["branch", "keep", &f1]);
    let id = tc.open(&repo).await.repo.id;
    view_state_set(&tc, id.clone(), json!({"collapsedMerges": [&merge]})).await.unwrap();

    let rows = all_rows(&tc, &id, 100).await;
    assert_eq!(ids(&rows), vec![m2.as_str(), merge.as_str(), m1.as_str(), f1.as_str(), a.as_str()], "{}", sketch(&rows));
    assert_eq!(find(&rows, &merge).collapsed_count, Some(1), "only f2 disappears");
    assert_eq!(ref_names(find(&rows, &f1)), vec!["keep"]);
    check_rows(&rows, true).unwrap();

    // A tag on the tip of the side branch keeps everything: the merge counts as collapsed, but hides nothing.
    repo.git(&["tag", "v-side", &f2]);
    for page_size in [1, 100] {
        let rows = all_rows(&tc, &id, page_size).await;
        assert_eq!(rows.len(), 6, "page size {page_size}\n{}", sketch(&rows));
        assert_eq!(find(&rows, &merge).collapsed_count, Some(0));
        check_rows(&rows, true).unwrap();
    }
}

#[tokio::test]
async fn nested_merges_disappear_with_the_outer_one() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let a = repo.head();
    repo.checkout_new("feature");
    repo.commit_file("f.txt", "1\n", "Feature 1");
    repo.checkout_new("sub");
    repo.commit_file("s.txt", "1\n", "Sub 1");
    repo.checkout("feature");
    repo.commit_file("f.txt", "2\n", "Feature 2");
    assert!(repo.merge("sub"));
    let inner = repo.head();
    repo.checkout("main");
    let m1 = repo.commit_file("m.txt", "1\n", "Main 1");
    assert!(repo.merge("feature"));
    let outer = repo.head();
    repo.git(&["branch", "-D", "feature", "sub"]);
    let id = tc.open(&repo).await.repo.id;

    view_state_set(&tc, id.clone(), json!({"collapsedMerges": [&inner]})).await.unwrap();
    let rows = all_rows(&tc, &id, 100).await;
    assert!(!rows.iter().any(|r| r.summary == "Sub 1"), "{}", sketch(&rows));
    assert_eq!(find(&rows, &inner).collapsed_count, Some(1));
    check_rows(&rows, true).unwrap();

    for list in [json!([&outer]), json!([&outer, &inner])] {
        view_state_set(&tc, id.clone(), json!({ "collapsedMerges": list })).await.unwrap();
        for page_size in [1, 100] {
            let rows = all_rows(&tc, &id, page_size).await;
            assert_eq!(ids(&rows), vec![outer.as_str(), m1.as_str(), a.as_str()], "page size {page_size}\n{}", sketch(&rows));
            assert_eq!(find(&rows, &outer).collapsed_count, Some(4));
            check_rows(&rows, true).unwrap();
        }
    }
}

#[tokio::test]
async fn collapse_all_merges_applies_to_pages_loaded_later() {
    let tc = TestCore::new().await;
    let repo = branchy_repo(30);
    let features = repo.git(&["for-each-ref", "--format=%(refname:short)", "refs/heads/feature"]);
    for name in features.lines() {
        repo.git(&["branch", "-D", name]);
    }
    let id = tc.open(&repo).await.repo.id;
    let expanded = all_rows(&tc, &id, 100).await;
    let merges = expanded.iter().filter(|r| r.kind == GraphRowKind::Merge).count();
    assert!(merges >= 5, "{}", sketch(&expanded));

    view_state_set(&tc, id.clone(), json!({"collapseAllMerges": true})).await.unwrap();
    for page_size in [4, 100] {
        let rows = all_rows(&tc, &id, page_size).await;
        assert!(rows.iter().all(|r| !r.summary.starts_with("Feature")), "page size {page_size}\n{}", sketch(&rows));
        let collapsed: Vec<&GraphRow> = rows.iter().filter(|r| r.kind == GraphRowKind::Merge).collect();
        assert_eq!(collapsed.len(), merges);
        assert!(collapsed.iter().all(|r| r.collapsed_count == Some(2)), "page size {page_size}\n{}", sketch(&rows));
        check_rows(&rows, true).unwrap();
    }
}

#[tokio::test]
async fn a_merge_bringing_in_too_many_commits_stays_expanded() {
    use super::page::{collapse_for, Collapse, Plan};
    let tc = TestCore::new().await;
    let (repo, [_, _, f2, m1, _, _]) = merged_feature();
    let id = tc.open(&repo).await.repo.id;
    let path = tc.repo_path(&id).unwrap();
    let parents = vec![m1.clone(), f2.clone()];
    let plan = Plan::default();

    assert_eq!(collapse_for(&tc, &path, &id, &plan, &parents, 1).await.unwrap(), Collapse::TooLarge);
    assert_eq!(collapse_for(&tc, &path, &id, &plan, &parents, 2).await.unwrap(), Collapse::Hide { count: 2, hidden_parents: vec![f2.clone()] });
}

#[tokio::test]
async fn a_large_hidden_block_at_the_page_boundary_needs_few_log_calls() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let a = repo.head();
    repo.checkout_new("feature");
    for i in 0..50 {
        repo.commit_file("f.txt", format!("{i}\n"), &format!("Feature {i}"));
    }
    repo.checkout("main");
    let m1 = repo.commit_file("m.txt", "1\n", "Main 1");
    assert!(repo.merge("feature"));
    let merge = repo.head();
    let m2 = repo.commit_file("m.txt", "2\n", "Main 2");
    repo.git(&["branch", "-D", "feature"]);
    let id = tc.open(&repo).await.repo.id;
    view_state_set(&tc, id.clone(), json!({"collapseAllMerges": true})).await.unwrap();

    // Page size 2: the second page holds m1, then all 50 hidden commits follow before `a`.
    super::page::LOG_READS.with(|n| n.set(0));
    let rows = all_rows(&tc, &id, 2).await;
    let reads = super::page::LOG_READS.with(std::cell::Cell::get);
    assert_eq!(ids(&rows), vec![m2.as_str(), merge.as_str(), m1.as_str(), a.as_str()], "{}", sketch(&rows));
    assert_eq!(find(&rows, &merge).collapsed_count, Some(50));
    check_rows(&rows, true).unwrap();
    assert!(reads <= 4, "{reads} `git log` calls for two pages");
}

// ---------------------------------------------------------------------------
// Not pushed / not pulled
// ---------------------------------------------------------------------------

#[tokio::test]
async fn rows_mark_commits_not_yet_pushed_or_pulled() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let base = repo.head();
    let _remote = repo.add_remote();
    let pulled_later = repo.commit_file("r.txt", "1\n", "Schon auf dem Remote");
    repo.git(&["push", "-q"]);
    repo.git(&["reset", "-q", "--hard", &base]);
    let local = repo.commit_file("l.txt", "1\n", "Nur lokal");
    let id = tc.open(&repo).await.repo.id;

    let rows = all_rows(&tc, &id, 100).await;
    assert_eq!(find(&rows, &local).sync, SyncMark::Ahead);
    assert_eq!(find(&rows, &pulled_later).sync, SyncMark::Behind);
    assert_eq!(find(&rows, &base).sync, SyncMark::None);

    // Without an upstream there is nothing to compare with.
    repo.git(&["branch", "--unset-upstream"]);
    assert!(all_rows(&tc, &id, 100).await.iter().all(|r| r.sync == SyncMark::None));

    // Detached HEAD: no branch, no marks.
    repo.git(&["branch", "-u", "origin/main"]);
    repo.git(&["checkout", "-q", "--detach"]);
    assert!(all_rows(&tc, &id, 100).await.iter().all(|r| r.sync == SyncMark::None));
}
