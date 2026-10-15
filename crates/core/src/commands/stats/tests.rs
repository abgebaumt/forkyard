//! Tests for `stats_compute` against real temp repositories with fixed authors and times.

use super::*;
use crate::events::names;
use crate::testkit::{TestCore, TestRepo};

const ADA: (&str, &str) = ("Ada", "ada@example.com");
const BEN: (&str, &str) = ("Ben", "ben@example.com");

async fn setup(repo: &TestRepo) -> (TestCore, String) {
    let tc = TestCore::new().await;
    let id = tc.open(repo).await.repo.id;
    tc.events.clear();
    (tc, id)
}

fn range(from: Option<&str>, to: Option<&str>, reference: &str) -> StatsRange {
    StatsRange { from: from.map(str::to_string), to: to.map(str::to_string), reference: reference.to_string() }
}

async fn run(tc: &TestCore, id: &str, range: StatsRange) -> RepoStats {
    stats_compute(tc, id.to_string(), format!("job-{}", util::new_id()), range).await.unwrap()
}

/// Like `run`, with "now" fixed to `now` (Unix seconds).
async fn run_at(tc: &TestCore, id: &str, range: StatsRange, now: i64) -> RepoStats {
    stats_compute_at(tc, id.to_string(), format!("job-{}", util::new_id()), range, now).await.unwrap()
}

/// 2025-06-22T18:00:00Z: the commit time of the demo's tip.
const TIP_TIME: i64 = 1_750_615_200;
const DAY: i64 = 86_400;

fn lines(items: &[&str]) -> String {
    items.iter().map(|line| format!("{line}\n")).collect()
}

/// src/app/main.rs: `first`, then l2 … l10, then `tail`.
fn main_rs(first: &str, tail: &[&str]) -> String {
    let mut all = vec![first, "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"];
    all.extend_from_slice(tail);
    lines(&all)
}

/// The demo history (oldest first; times with the author's offset). Returns the SHAs in this order.
///
/// | # | who  | when (author's clock)       | changes                                               |
/// |---|------|-----------------------------|-------------------------------------------------------|
/// | 0 | Ada  | Mon 2023-03-06 09:15 +0100  | README.md (3), old.txt (2), src/app/main.rs (10)      |
/// | 1 | Ada  | Mon 2025-06-02 10:00 +0200  | main.rs +2 −1                                         |
/// | 2 | Ben  | Tue 2025-06-03 23:30 −0700  | docs/guide.md (5), main.rs +1                         |
/// | 3 | Ben  | Wed 2025-06-04 08:00 +0000  | logo.bin (binary, 120 bytes), guide.md +1 −1          |
/// | 4 | Ben  | Wed 2025-06-04 09:00 +0000  | guide.md +1                                           |
/// | 5 | Cleo | Thu 2025-06-05 14:00 +0000  | src/lib/util.rs (4), old.txt deleted (−2); CLEO@Example.com |
/// | 6 | Cleo | Fri 2025-06-20 14:30 +0000  | util.rs +3 −1, main.rs +1 −1                          |
/// | 7 | Ben  | Sat 2025-06-21 12:00 +0000  | guide.md +2                                           |
/// | 8 | Ada  | Sun 2025-06-22 18:00 +0000  | README.md +1 −1                                       |
fn demo() -> (TestRepo, Vec<String>) {
    let repo = TestRepo::new();
    let mut shas = Vec::new();
    repo.write_file("README.md", lines(&["r1", "r2", "r3"]));
    repo.write_file("old.txt", lines(&["o1", "o2"]));
    repo.write_file("src/app/main.rs", main_rs("l1", &[]));
    shas.push(repo.commit_as("Start", ADA.0, ADA.1, "@1678090500 +0100"));
    repo.write_file("src/app/main.rs", main_rs("L1", &["l11"]));
    shas.push(repo.commit_as("Main", ADA.0, ADA.1, "@1748851200 +0200"));
    repo.write_file("docs/guide.md", lines(&["g1", "g2", "g3", "g4", "g5"]));
    repo.write_file("src/app/main.rs", main_rs("L1", &["l11", "l12"]));
    shas.push(repo.commit_as("Guide", BEN.0, BEN.1, "@1749018600 -0700"));
    repo.write_file("logo.bin", [0u8, 1, 2].repeat(40));
    repo.write_file("docs/guide.md", lines(&["g1", "g2", "g3", "g4", "G5"]));
    shas.push(repo.commit_as("Logo", BEN.0, BEN.1, "@1749024000 +0000"));
    repo.write_file("docs/guide.md", lines(&["g1", "g2", "g3", "g4", "G5", "g6"]));
    shas.push(repo.commit_as("More", BEN.0, BEN.1, "@1749027600 +0000"));
    repo.write_file("src/lib/util.rs", lines(&["u1", "u2", "u3", "u4"]));
    repo.remove_file("old.txt");
    shas.push(repo.commit_as("Util", "Cleo", "CLEO@Example.com", "@1749132000 +0000"));
    repo.write_file("src/lib/util.rs", lines(&["U1", "u2", "u3", "u4", "u5", "u6"]));
    repo.write_file("src/app/main.rs", main_rs("L1", &["l11", "L12"]));
    shas.push(repo.commit_as("Tidy", "Cleo", "cleo@example.com", "@1750429800 +0000"));
    repo.write_file("docs/guide.md", lines(&["g1", "g2", "g3", "g4", "G5", "g6", "g7", "g8"]));
    shas.push(repo.commit_as("Docs", BEN.0, BEN.1, "@1750507200 +0000"));
    repo.write_file("README.md", lines(&["r1", "r2", "R3"]));
    shas.push(repo.commit_as("Readme", ADA.0, ADA.1, "@1750615200 +0000"));
    (repo, shas)
}

#[tokio::test]
async fn the_demo_history_gives_the_expected_numbers() {
    let (repo, shas) = demo();
    let (tc, id) = setup(&repo).await;
    let stats = run_at(&tc, &id, range(None, None, "HEAD"), TIP_TIME).await;
    assert_eq!(stats.tip.as_deref(), Some(shas[8].as_str()));
    assert_eq!(stats.reference_time.as_deref(), Some("2025-06-22T18:00:00.000Z"), "without `to`: now");
    assert_eq!((stats.commits, stats.added, stats.removed), (9, 36, 7));
    assert_eq!((stats.first_at.as_deref(), stats.last_at.as_deref()), (Some("2023-03-06T08:15:00.000Z"), Some("2025-06-22T18:00:00.000Z")));

    let cells: Vec<(usize, usize, u32)> = stats
        .heatmap
        .iter()
        .enumerate()
        .flat_map(|(day, row)| row.iter().enumerate().filter(|(_, n)| **n > 0).map(move |(hour, n)| (day, hour, *n)))
        .collect();
    assert_eq!(cells, [(0, 9, 1), (0, 10, 1), (1, 23, 1), (2, 8, 1), (2, 9, 1), (3, 14, 1), (4, 14, 1), (5, 12, 1), (6, 18, 1)]);
    let weeks: Vec<(&str, u32, u64, u64)> = stats.weeks.iter().map(|b| (b.period.as_str(), b.commits, b.added, b.removed)).collect();
    assert_eq!(weeks, [("2023-03-06", 1, 15, 0), ("2025-06-02", 5, 14, 4), ("2025-06-16", 3, 7, 3)]);
    let months: Vec<(&str, u32)> = stats.months.iter().map(|b| (b.period.as_str(), b.commits)).collect();
    assert_eq!(months, [("2023-03", 1), ("2025-06", 8)]);

    let authors: Vec<(&str, &str, u32, u64, u64)> = stats.authors.iter().map(|a| (a.name.as_str(), a.email.as_str(), a.commits, a.added, a.removed)).collect();
    assert_eq!(authors, [("Ben", "ben@example.com", 4, 10, 1), ("Ada", "ada@example.com", 3, 18, 2), ("Cleo", "cleo@example.com", 2, 8, 4)]);
    assert_eq!(stats.author_count, 3, "Cleo with two spellings of her address is one author");

    let files: Vec<(&str, u32, u32, u64, u64)> = stats.files.iter().map(|f| (f.path.as_str(), f.commits, f.authors, f.added, f.removed)).collect();
    assert_eq!(
        files,
        [("src/app/main.rs", 4, 3, 14, 2), ("docs/guide.md", 4, 1, 9, 1), ("src/lib/util.rs", 2, 1, 7, 1), ("README.md", 2, 1, 4, 1), ("logo.bin", 1, 1, 0, 0)]
    );
    assert_eq!(stats.file_count, 5, "the deleted old.txt is not listed");
    let hotspots: Vec<(&str, u32)> = stats.hotspots.iter().map(|h| (h.path.as_str(), h.score)).collect();
    assert_eq!(hotspots, [("src/app/main.rs", 12), ("docs/guide.md", 4), ("README.md", 2), ("src/lib/util.rs", 2), ("logo.bin", 1)]);
    let folders: Vec<(&str, u64, u32, &str, u32, u32)> =
        stats.folders.iter().map(|f| (f.path.as_str(), f.weight, f.authors, f.main_author.name.as_str(), f.main_share, f.bus_factor)).collect();
    assert_eq!(
        folders,
        [
            ("", 40, 3, "Ada", 45, 2),
            ("src", 24, 3, "Ada", 54, 1),
            ("src/app", 16, 3, "Ada", 81, 1),
            ("docs", 10, 1, "Ben", 100, 1),
            ("src/lib", 8, 1, "Cleo", 100, 1),
        ]
    );

    assert_eq!(stats.records.longest_streak, Some(crate::model::StatsStreak { days: 4, start: "2025-06-02".into(), end: "2025-06-05".into() }));
    assert_eq!(stats.records.busiest_day, Some(crate::model::StatsBusyDay { date: "2025-06-04".into(), commits: 2 }));
    let biggest = stats.records.biggest_commit.clone().unwrap();
    assert_eq!((biggest.sha.as_str(), biggest.added, biggest.removed), (shas[0].as_str(), 15, 0));
    assert!(!stats.cached);
}

#[tokio::test]
async fn the_period_filters_by_author_time_and_to_picks_the_tip() {
    let (repo, shas) = demo();
    let (tc, id) = setup(&repo).await;
    let late = run(&tc, &id, range(Some("2025-06-16T00:00:00Z"), None, "HEAD")).await;
    assert_eq!(late.commits, 3);
    assert_eq!(late.authors.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(), ["Cleo", "Ada", "Ben"]);
    assert_eq!(late.tip.as_deref(), Some(shas[8].as_str()));

    let early = run(&tc, &id, range(None, Some("2025-06-04T23:59:59Z"), "HEAD")).await;
    assert_eq!(early.tip.as_deref(), Some(shas[4].as_str()), "the last commit committed up to `to`");
    assert_eq!(early.commits, 5);
    assert_eq!(early.reference_time.as_deref(), Some("2025-06-04T23:59:59.000Z"));
    assert!(early.files.iter().any(|f| f.path == "old.txt"), "files as they are at that tip");
    assert!(!early.files.iter().any(|f| f.path == "src/lib/util.rs"));

    let nothing = run(&tc, &id, range(None, Some("2020-01-01T00:00:00Z"), "HEAD")).await;
    assert_eq!((nothing.commits, nothing.tip), (0, None));
}

#[tokio::test]
async fn branches_count_their_own_history_and_merges_are_left_out() {
    let repo = TestRepo::with_commit();
    repo.checkout_new("side");
    repo.commit_file("side.txt", "s\n", "Side");
    repo.checkout("main");
    repo.commit_file("main.txt", "m\n", "Main");
    assert!(repo.merge("side"));
    let (tc, id) = setup(&repo).await;
    let all = run(&tc, &id, range(None, None, "HEAD")).await;
    assert_eq!(all.commits, 3, "first commit, side and main – not the merge");
    let side = run(&tc, &id, range(None, None, "refs/heads/side")).await;
    assert_eq!(side.commits, 2);
    assert!(side.files.iter().all(|f| f.path != "main.txt"));
}

#[tokio::test]
async fn empty_repositories_and_invalid_input() {
    let repo = TestRepo::new();
    let (tc, id) = setup(&repo).await;
    let empty = run(&tc, &id, range(None, None, "HEAD")).await;
    assert_eq!((empty.commits, empty.tip.clone()), (0, None));
    assert!(empty.heatmap.len() == 7 && empty.heatmap.iter().all(|row| row.len() == 24 && row.iter().all(|n| *n == 0)));

    repo.commit_file("a.txt", "a\n", "A");
    let code = |result: CoreResult<RepoStats>| result.unwrap_err().code;
    assert_eq!(code(stats_compute(&tc, id.clone(), "j1".into(), range(None, None, "refs/heads/gibt-es-nicht")).await), ErrorCode::NotFound);
    assert_eq!(code(stats_compute(&tc, id.clone(), "j2".into(), range(None, None, "--output=/tmp/x")).await), ErrorCode::NotFound);
    assert_eq!(code(stats_compute(&tc, id.clone(), "j3".into(), range(Some("gestern"), None, "HEAD")).await), ErrorCode::NotAllowed);
    assert_eq!(
        code(stats_compute(&tc, id.clone(), "j4".into(), range(Some("2025-02-01T00:00:00Z"), Some("2025-01-01T00:00:00Z"), "HEAD")).await),
        ErrorCode::NotAllowed
    );
    assert_eq!(code(stats_compute(&tc, "unbekannt".into(), "j5".into(), range(None, None, "HEAD")).await), ErrorCode::NotFound);
}

#[tokio::test]
async fn the_job_reports_progress_and_its_end_and_changes_nothing() {
    let (repo, _) = demo();
    let (tc, id) = setup(&repo).await;
    stats_compute(&tc, id.clone(), "job-stats".into(), range(None, None, "HEAD")).await.unwrap();
    let progress = tc.events.named(names::JOB_PROGRESS);
    assert!(progress.iter().all(|p| p["jobId"] == "job-stats" && p["repoId"] == id.as_str()));
    assert!(progress.iter().any(|p| p["phase"] == "history" && p["percent"] == 70), "{progress:?}");
    assert!(progress.iter().any(|p| p["phase"] == "blame" && p["percent"] == 100), "{progress:?}");
    let done = tc.events.named(names::JOB_DONE);
    assert_eq!((done.len(), done[0]["ok"].as_bool()), (1, Some(true)));
    assert!(!tc.jobs.is_running("job-stats"));
    assert_eq!(tc.events.count(names::REPO_CHANGED), 0, "only reads");
}

#[tokio::test]
async fn an_untrusted_repository_is_not_read() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    repo.git(&["config", "core.fsmonitor", "touch FSMONITOR-LIEF;:"]);
    let opened = crate::commands::repos::repo_open(&tc, repo.path().to_string_lossy().into_owned()).await.unwrap();
    assert!(!opened.repo.trusted);
    let error = stats_compute(&tc, opened.repo.id.clone(), "job-locked".into(), range(None, None, "HEAD")).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::RepoUntrusted);
    assert!(!repo.path().join("FSMONITOR-LIEF").exists());
    assert_eq!(tc.events.count(names::JOB_DONE), 0, "no job was started");
}

/// Tauri needs command futures that are `Send`.
#[tokio::test]
async fn the_command_future_is_send() {
    fn assert_send<T: Send>(value: T) -> T {
        value
    }
    let repo = TestRepo::with_commit();
    let (tc, id) = setup(&repo).await;
    let stats = assert_send(stats_compute(&tc, id, "job-send".into(), range(None, None, "HEAD"))).await.unwrap();
    assert_eq!(stats.commits, 1);
}

#[tokio::test]
async fn the_sample_takes_the_largest_text_files_and_skips_binaries() {
    let (repo, shas) = demo();
    let (tc, id) = setup(&repo).await;
    let tree = list_tree(&tc, &id, &shas[8]).await.unwrap();
    let mut paths: Vec<&str> = tree.iter().map(|f| f.path.as_str()).collect();
    paths.sort_unstable();
    assert_eq!(paths, ["README.md", "docs/guide.md", "logo.bin", "src/app/main.rs", "src/lib/util.rs"]);
    let sample = blame_sample(&tc, &id, &tree, 2, &CancelToken::new()).await.unwrap();
    assert_eq!(sample, [b"src/app/main.rs".to_vec(), b"docs/guide.md".to_vec()], "logo.bin is the largest, but binary");
}

#[tokio::test]
async fn code_age_counts_lines_by_the_age_of_their_last_change() {
    let (repo, _) = demo();
    let (tc, id) = setup(&repo).await;
    let stats = run_at(&tc, &id, range(None, None, "HEAD"), TIP_TIME).await;
    assert_eq!(stats.code_age, StatsCodeAge { files: 4, skipped: 0, month: 18, half_year: 0, year: 0, two_years: 0, older: 11 });
    let early = run(&tc, &id, range(None, Some("2025-06-04T23:59:59Z"), "HEAD")).await;
    assert_eq!(early.code_age, StatsCodeAge { files: 4, skipped: 0, month: 9, half_year: 0, year: 0, two_years: 0, older: 14 }, "measured at that tip, against `to`");
}

#[tokio::test]
async fn without_to_the_code_age_is_measured_against_today_not_the_last_commit() {
    let (repo, _) = demo();
    let (tc, id) = setup(&repo).await;
    let later = TIP_TIME + 200 * DAY;
    let stats = run_at(&tc, &id, range(None, None, "HEAD"), later).await;
    assert_eq!(stats.code_age, StatsCodeAge { files: 4, skipped: 0, month: 0, half_year: 0, year: 18, two_years: 0, older: 11 });
    assert_eq!(stats.reference_time, Some(util::unix_to_iso(later)));
}

#[tokio::test]
async fn a_cached_result_sorts_the_code_age_again_against_today() {
    let (repo, _) = demo();
    let (tc, id) = setup(&repo).await;
    let first = run_at(&tc, &id, range(None, None, "HEAD"), TIP_TIME).await;
    assert_eq!(first.code_age.month, 18);
    let years_later = TIP_TIME + 3 * 365 * DAY;
    let again = run_at(&tc, &id, range(None, None, "HEAD"), years_later).await;
    assert!(again.cached, "the blame result is reused");
    assert_eq!(again.code_age, StatsCodeAge { files: 4, skipped: 0, month: 0, half_year: 0, year: 0, two_years: 0, older: 29 });
    assert_eq!(again.reference_time, Some(util::unix_to_iso(years_later)));
    let early = run_at(&tc, &id, range(None, Some("2025-06-04T23:59:59Z"), "HEAD"), years_later).await;
    assert_eq!(early.code_age.month, 9, "with `to` the age stays measured against `to`");
}

#[tokio::test]
async fn results_are_cached_per_tip_and_period() {
    let (repo, _) = demo();
    let (tc, id) = setup(&repo).await;
    let first = run(&tc, &id, range(None, None, "HEAD")).await;
    let second = run(&tc, &id, range(None, None, "HEAD")).await;
    assert!(!first.cached && second.cached);
    assert_eq!(RepoStats { cached: false, ..second }, first);
    assert!(!run(&tc, &id, range(Some("2025-06-16T00:00:00Z"), None, "HEAD")).await.cached, "another period is its own entry");
    assert_eq!(tc.events.count(names::JOB_DONE), 3, "a cached run also ends its job");

    repo.commit_as("Neu", ADA.0, ADA.1, "@1750701600 +0000");
    let after = run(&tc, &id, range(None, None, "HEAD")).await;
    assert!(!after.cached, "a new tip is computed again");
    assert_eq!(after.commits, 10);

    let stored: Vec<String> = tc
        .db
        .with(|c| {
            let mut stmt = c.prepare("select value from stats_cache where repository_id = ?1")?;
            let rows = stmt.query_map([&id], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
            Ok(rows)
        })
        .unwrap();
    assert_eq!(stored.len(), 3);
    assert!(stored.iter().all(|text| !text.contains("Guide") && !text.contains("Tidy")), "no commit messages in the cache");
}

#[tokio::test]
async fn a_cancelled_run_caches_nothing_and_job_ids_are_unique() {
    let (repo, _) = demo();
    let (tc, id) = setup(&repo).await;
    let job = tc.start_job("job-cancelled", Some(&id)).unwrap();
    job.token().cancel();
    let error = compute(&tc, &id, "HEAD", None, None, TIP_TIME, &job).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Cancelled);
    drop(job);
    let rows: i64 = tc.db.with(|c| Ok(c.query_row("select count(*) from stats_cache where repository_id = ?1", [&id], |r| r.get(0))?)).unwrap();
    assert_eq!(rows, 0);

    let busy = tc.start_job("job-twice", Some(&id)).unwrap();
    let error = stats_compute(&tc, id.clone(), "job-twice".into(), range(None, None, "HEAD")).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Duplicate);
    drop(busy);
}

#[tokio::test]
async fn a_cancel_sent_before_the_computation_registers_stops_it() {
    // StrictMode or a view closed at once: the UI's `job_cancel` overtakes `stats_compute`.
    let (repo, _) = demo();
    let (tc, id) = setup(&repo).await;
    crate::commands::sync::job_cancel(&tc, "job-early".into()).await.unwrap();
    let error = stats_compute(&tc, id.clone(), "job-early".into(), range(None, None, "HEAD")).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::Cancelled);
    let done = tc.events.named(names::JOB_DONE);
    assert_eq!(done.len(), 1, "one job, one end");
    assert_eq!(done[0]["cancelled"], true);
    assert!(!tc.jobs.is_running("job-early"));
}
