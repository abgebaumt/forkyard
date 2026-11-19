//! Tests of the `git log` walkers behind `graph_page`: follow-up pages read on from a running
//! walker, and every way a walker goes away falls back to `--skip` with the same rows.

use std::time::{Duration, Instant};

use serde_json::json;

use super::layout::check::check_rows;
use super::walker::GraphWalkers;
use super::*;
use crate::commands::repos::tab_close;
use crate::commands::view::view_state_set;
use crate::error::ErrorCode;
use crate::model::{GraphRow, GraphRowKind};
use crate::testkit::{TestCore, TestRepo, BASE_TIME};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// All pages one after another.
async fn all_rows(tc: &TestCore, id: &str, page_size: u32) -> Vec<GraphRow> {
    let mut rows = Vec::new();
    let mut cursor = None;
    loop {
        let page = graph_page(tc, id.to_string(), cursor, page_size).await.unwrap();
        rows.extend(page.rows);
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => return rows,
        }
    }
}

/// argv of the graph's `git log` calls started since the last call.
pub(super) fn log_spawns(tc: &TestCore) -> Vec<Vec<String>> {
    tc.git.take_spawned().into_iter().filter(|argv| argv.iter().any(|a| a == "log") && argv.iter().any(|a| a == "--date-order")).collect()
}

fn uses_skip(spawns: &[Vec<String>]) -> bool {
    spawns.iter().flatten().any(|a| a.starts_with("--skip"))
}

/// The SHAs of the commit and merge rows.
fn shas(rows: &[GraphRow]) -> Vec<&str> {
    rows.iter().filter(|r| matches!(r.kind, GraphRowKind::Commit | GraphRowKind::Merge)).filter_map(|r| r.sha.as_deref()).collect()
}

/// A `git fast-import` stream with `count` commits in a row on `main`.
fn linear_history(count: usize) -> Vec<u8> {
    let mut out = String::from("blob\nmark :1\ndata 6\nhallo\n\n");
    for n in 0..count {
        let mark = n + 2;
        let time = BASE_TIME + 60 * mark as i64;
        let who = format!("Person {} <person{}@example.com>", n % 7, n % 7);
        out.push_str(&format!("commit refs/heads/main\nmark :{mark}\nauthor {who} {time} +0000\ncommitter {who} {time} +0000\n"));
        let message = format!("Schritt {n}");
        out.push_str(&format!("data {}\n{message}\n", message.len()));
        if n == 0 {
            out.push_str("M 100644 :1 datei.txt\n");
        } else {
            out.push_str(&format!("from :{}\n", mark - 1));
        }
        out.push('\n');
    }
    out.into_bytes()
}

fn linear_repo(count: usize) -> TestRepo {
    let repo = TestRepo::new();
    repo.fast_import(&linear_history(count));
    repo.git(&["reset", "-q", "--hard", "main"]);
    repo
}

/// Waits until `done` holds; fails after 10 s.
async fn wait_for(what: &str, done: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn follow_up_pages_read_on_without_a_new_git_log() {
    let tc = TestCore::new().await;
    let repo = linear_repo(3000);
    let id = tc.open(&repo).await.repo.id;
    log_spawns(&tc);

    let rows = all_rows(&tc, &id, 500).await;
    assert_eq!(shas(&rows).len(), 3000);
    let spawns = log_spawns(&tc);
    assert_eq!(spawns.len(), 1, "{spawns:?}");
    assert!(!uses_skip(&spawns), "{spawns:?}");
}

#[tokio::test]
async fn pages_match_git_log_date_order_on_an_extreme_history() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let base = repo.head();
    let (name, email) = ("Zeitreisende", "zeit@example.com");
    repo.checkout_new("feature");
    repo.commit_file("f.txt", "1\n", "Feature 1");
    repo.commit_file("f.txt", "2\n", "Feature 2");
    repo.checkout("main");
    repo.commit_file("m.txt", "1\n", "Main 1");
    // Far ahead at +1400, then a child that is older than its parent at -1200.
    let ahead = format!("@{} +1400", BASE_TIME + 500_000);
    let behind = format!("@{} -1200", BASE_TIME - 500_000);
    repo.write_file("m.txt", "2\n");
    repo.commit_as_dates("Zukunft", name, email, &ahead, &ahead);
    repo.write_file("m.txt", "3\n");
    repo.commit_as_dates("Vergangenheit", name, email, &behind, &behind);
    assert!(repo.merge("feature"));
    // A branch rebased onto main; its old commits stay reachable through `thema-alt`.
    repo.git(&["checkout", "-q", "-b", "thema", &base]);
    repo.commit_file("t.txt", "1\n", "Thema 1");
    repo.commit_file("t.txt", "2\n", "Thema 2");
    repo.branch("thema-alt");
    repo.git(&["rebase", "-q", "main"]);
    // An unrelated root.
    repo.git(&["checkout", "-q", "--orphan", "waise"]);
    repo.commit_file("w.txt", "w\n", "Waise");
    repo.git(&["tag", "-a", "v1", "-m", "Version 1", &base]);
    repo.checkout("main");
    let id = tc.open(&repo).await.repo.id;

    let expected = repo.git(&["log", "--date-order", "--format=%H", "HEAD", "--branches", "--remotes", "--tags"]);
    let expected: Vec<&str> = expected.lines().collect();
    assert!(expected.len() >= 12, "{expected:?}");
    for size in [1, 2, 7, 500] {
        assert_eq!(shas(&all_rows(&tc, &id, size).await), expected, "page size {size}");
    }
}

#[tokio::test]
async fn a_gone_walker_falls_back_to_skip_with_the_same_rows() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    repo.checkout_new("feature");
    for i in 0..5 {
        repo.commit_file("f.txt", format!("{i}\n"), &format!("Feature {i}"));
    }
    repo.checkout("main");
    for i in 0..3 {
        repo.commit_file("m.txt", format!("{i}\n"), &format!("Main {i}"));
    }
    assert!(repo.merge("feature"));
    for i in 3..6 {
        repo.commit_file("m.txt", format!("{i}\n"), &format!("Main {i}"));
    }
    repo.git(&["branch", "-D", "feature"]);
    let id = tc.open(&repo).await.repo.id;
    view_state_set(&tc, id.clone(), json!({"collapseAllMerges": true})).await.unwrap();

    let reference = all_rows(&tc, &id, 2).await;
    log_spawns(&tc);
    let mut page = graph_page(&tc, id.clone(), None, 2).await.unwrap();
    let mut rows = page.rows;
    while let Some(cursor) = page.next_cursor {
        release_graph_walkers(&tc, &id);
        page = graph_page(&tc, id.clone(), Some(cursor), 2).await.unwrap();
        rows.extend(page.rows);
    }
    assert_eq!(rows, reference);
    assert!(uses_skip(&log_spawns(&tc)));
    check_rows(&rows, true).unwrap();
}

#[tokio::test]
async fn a_walker_is_never_used_after_the_graph_changed() {
    let tc = TestCore::new().await;
    let repo = linear_repo(10);
    let id = tc.open(&repo).await.repo.id;
    let first = graph_page(&tc, id.clone(), None, 2).await.unwrap();
    repo.commit_file("neu.txt", "neu\n", "Von draußen");

    let err = graph_page(&tc, id.clone(), first.next_cursor, 2).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::StaleState);
    let fresh = graph_page(&tc, id.clone(), None, 2).await.unwrap();
    assert!(fresh.next_cursor.is_some());
    assert_eq!(graph_walker_count(&tc, Some(&id)), 1);
}

#[tokio::test]
async fn the_same_cursor_twice_gives_the_same_page() {
    let tc = TestCore::new().await;
    let repo = linear_repo(10);
    let id = tc.open(&repo).await.repo.id;
    let cursor = graph_page(&tc, id.clone(), None, 2).await.unwrap().next_cursor;

    let (a, b) = tokio::join!(graph_page(&tc, id.clone(), cursor.clone(), 2), graph_page(&tc, id.clone(), cursor.clone(), 2));
    let (a, b) = (a.unwrap(), b.unwrap());
    assert_eq!(a.rows, b.rows);
    release_graph_walkers(&tc, &id);
    let skipped = graph_page(&tc, id.clone(), cursor, 2).await.unwrap();
    assert_eq!(a.rows, skipped.rows);
    assert_eq!(shas(&a.rows).len(), 2);
}

#[tokio::test]
async fn at_most_four_walkers_the_least_recently_used_goes_first() {
    let tc = TestCore::new().await;
    let repos: Vec<TestRepo> = (0..5).map(|_| linear_repo(50)).collect();
    let mut ids = Vec::new();
    for repo in &repos {
        ids.push(tc.open(repo).await.repo.id);
    }
    let mut cursors = Vec::new();
    for id in &ids[..4] {
        cursors.push(graph_page(&tc, id.clone(), None, 10).await.unwrap().next_cursor);
    }
    let r1_next = graph_page(&tc, ids[0].clone(), cursors[0].clone(), 10).await.unwrap().next_cursor;
    graph_page(&tc, ids[4].clone(), None, 10).await.unwrap();
    assert_eq!(graph_walker_count(&tc, None), MAX_WALKERS);

    log_spawns(&tc);
    graph_page(&tc, ids[1].clone(), cursors[1].clone(), 10).await.unwrap();
    assert!(uses_skip(&log_spawns(&tc)), "r2's walker was the least recently used");
    graph_page(&tc, ids[0].clone(), r1_next, 10).await.unwrap();
    assert_eq!(log_spawns(&tc), Vec::<Vec<String>>::new());
}

#[tokio::test]
async fn an_idle_walker_ends_and_the_next_page_still_works() {
    let tc = TestCore::new().await;
    tc.state::<GraphWalkers>().set_idle(Duration::from_millis(200));
    let repo = linear_repo(10);
    let id = tc.open(&repo).await.repo.id;
    let cursor = graph_page(&tc, id.clone(), None, 2).await.unwrap().next_cursor;
    assert_eq!(graph_walker_count(&tc, None), 1);

    wait_for("the idle walker to end", || graph_walker_count(&tc, None) == 0).await;
    log_spawns(&tc);
    let page = graph_page(&tc, id.clone(), cursor, 2).await.unwrap();
    assert_eq!(shas(&page.rows).len(), 2);
    assert!(uses_skip(&log_spawns(&tc)));
}

#[tokio::test]
async fn closing_the_last_tab_releases_the_walkers() {
    let tc = TestCore::new().await;
    let repo = linear_repo(10);
    let opened = tc.open(&repo).await;
    graph_page(&tc, opened.repo.id.clone(), None, 2).await.unwrap();
    assert_eq!(graph_walker_count(&tc, Some(&opened.repo.id)), 1);

    tab_close(&tc, opened.tab.id).await.unwrap();
    assert_eq!(graph_walker_count(&tc, Some(&opened.repo.id)), 0);
}
