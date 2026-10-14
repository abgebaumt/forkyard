//! Turns the commits of the log into the numbers of `RepoStats`: totals, heatmap, weeks and
//! months, authors, records, the numbers per file (files, hotspots, knowledge per folder) and
//! the code age buckets. Pure computation – everything that talks to Git is in `stats.rs`.
#![cfg_attr(not(test), allow(dead_code))]

use std::collections::{BTreeMap, HashMap, HashSet};

use chrono::{DateTime, Datelike, Days, NaiveDate, NaiveDateTime, Timelike};

use super::parse::LogCommit;
use crate::model::{
    Person, RepoStats, StatsAuthor, StatsBigCommit, StatsBucket, StatsBusyDay, StatsCodeAge, StatsFile, StatsFolder, StatsHotspot, StatsRecords,
    StatsStreak,
};
use crate::util;

/// At most this many authors, files, hotspots and folders go into the result.
pub(super) const MAX_AUTHORS: usize = 200;
pub(super) const MAX_FILES: usize = 2000;
pub(super) const MAX_HOTSPOTS: usize = 30;
pub(super) const MAX_FOLDERS: usize = 100;
/// Knowledge is counted for the repository root and for folders down to this depth.
pub(super) const FOLDER_DEPTH: usize = 2;
const DAY: i64 = 86_400;
/// Code age: a month is 30 days, a year 365 days.
const MONTH: i64 = 30 * DAY;
const YEAR: i64 = 365 * DAY;
const THREE_YEARS: i64 = 3 * YEAR;

#[derive(Debug, Default, Clone, Copy)]
struct Totals {
    commits: u32,
    added: u64,
    removed: u64,
}

impl Totals {
    fn add(&mut self, added: u64, removed: u64) {
        self.commits += 1;
        self.added += added;
        self.removed += removed;
    }

    fn bucket(self, period: String) -> StatsBucket {
        StatsBucket { period, commits: self.commits, added: self.added, removed: self.removed }
    }
}

struct AuthorAcc {
    /// Name and address of the newest commit (the log comes newest first).
    name: String,
    email: String,
    totals: Totals,
    first: i64,
    last: i64,
}

#[derive(Default)]
struct FileAcc {
    commits: u32,
    added: u64,
    removed: u64,
    /// Author key → changed lines (at least 1 per change).
    weights: HashMap<String, u64>,
}

/// Collects the commits of the period; `finish` builds the result.
pub(super) struct Aggregator {
    from: Option<i64>,
    to: Option<i64>,
    totals: Totals,
    first: Option<i64>,
    last: Option<i64>,
    heatmap: [[u32; 24]; 7],
    weeks: BTreeMap<NaiveDate, Totals>,
    months: BTreeMap<(i32, u32), Totals>,
    days: BTreeMap<NaiveDate, u32>,
    authors: HashMap<String, AuthorAcc>,
    files: HashMap<String, FileAcc>,
    biggest: Option<StatsBigCommit>,
}

/// Under which key the commits of a person are counted: the e-mail address in lower case
/// (without one: the name). `.mailmap` is not applied.
pub(super) fn author_key(name: &str, email: &str) -> String {
    let email = email.trim().to_lowercase();
    if email.is_empty() {
        format!("name:{}", name.trim())
    } else {
        email
    }
}

/// The author's wall-clock time: UTC shifted by their offset.
fn local_time(time: i64, offset: i32) -> NaiveDateTime {
    DateTime::from_timestamp(time.saturating_add(i64::from(offset)), 0).unwrap_or_default().naive_utc()
}

fn day_text(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

impl Aggregator {
    /// `from`/`to`: Unix seconds, both inclusive, compared with the author time.
    pub fn new(from: Option<i64>, to: Option<i64>) -> Self {
        Aggregator {
            from,
            to,
            totals: Totals::default(),
            first: None,
            last: None,
            heatmap: [[0; 24]; 7],
            weeks: BTreeMap::new(),
            months: BTreeMap::new(),
            days: BTreeMap::new(),
            authors: HashMap::new(),
            files: HashMap::new(),
            biggest: None,
        }
    }

    /// Counts a commit whose author time lies in the period; returns whether it counted.
    pub fn add(&mut self, commit: &LogCommit) -> bool {
        if self.from.is_some_and(|from| commit.time < from) || self.to.is_some_and(|to| commit.time > to) {
            return false;
        }
        let added: u64 = commit.files.iter().map(|file| file.added).sum();
        let removed: u64 = commit.files.iter().map(|file| file.removed).sum();
        self.totals.add(added, removed);
        self.first = Some(self.first.map_or(commit.time, |first| first.min(commit.time)));
        self.last = Some(self.last.map_or(commit.time, |last| last.max(commit.time)));

        let local = local_time(commit.time, commit.offset);
        let date = local.date();
        let weekday = date.weekday().num_days_from_monday();
        self.heatmap[weekday as usize][local.hour() as usize] += 1;
        let monday = date.checked_sub_days(Days::new(u64::from(weekday))).unwrap_or(date);
        self.weeks.entry(monday).or_default().add(added, removed);
        self.months.entry((date.year(), date.month())).or_default().add(added, removed);
        *self.days.entry(date).or_default() += 1;

        let key = author_key(&commit.name, &commit.email);
        let author = self.authors.entry(key.clone()).or_insert_with(|| AuthorAcc {
            name: commit.name.clone(),
            email: commit.email.clone(),
            totals: Totals::default(),
            first: commit.time,
            last: commit.time,
        });
        author.totals.add(added, removed);
        author.first = author.first.min(commit.time);
        author.last = author.last.max(commit.time);

        for file in &commit.files {
            let acc = self.files.entry(file.path.clone()).or_default();
            acc.commits += 1;
            acc.added += file.added;
            acc.removed += file.removed;
            *acc.weights.entry(key.clone()).or_default() += (file.added + file.removed).max(1);
        }

        // Ties keep the commit seen first – the newer one.
        let lines = added + removed;
        if lines > 0 && !matches!(&self.biggest, Some(big) if big.added + big.removed >= lines) {
            self.biggest = Some(StatsBigCommit { sha: commit.sha.clone(), added, removed, at: util::unix_to_iso(commit.time) });
        }
        true
    }

    /// The result. `existing`: paths at the tip – only these appear in files, hotspots and
    /// knowledge. `reference_time`: Unix seconds the code age was measured against.
    pub fn finish(self, existing: &HashSet<String>, code_age: StatsCodeAge, tip: String, reference_time: i64) -> RepoStats {
        let records = StatsRecords {
            longest_streak: longest_streak(&self.days),
            biggest_commit: self.biggest.clone(),
            busiest_day: busiest_day(&self.days),
        };

        let mut authors: Vec<StatsAuthor> = self
            .authors
            .values()
            .map(|a| StatsAuthor {
                name: a.name.clone(),
                email: a.email.clone(),
                commits: a.totals.commits,
                added: a.totals.added,
                removed: a.totals.removed,
                first_at: util::unix_to_iso(a.first),
                last_at: util::unix_to_iso(a.last),
            })
            .collect();
        authors.sort_by(|a, b| {
            b.commits
                .cmp(&a.commits)
                .then_with(|| (b.added + b.removed).cmp(&(a.added + a.removed)))
                .then_with(|| a.email.cmp(&b.email))
                .then_with(|| a.name.cmp(&b.name))
        });
        let author_count = authors.len() as u32;
        authors.truncate(MAX_AUTHORS);

        let living: Vec<(&String, &FileAcc)> = self.files.iter().filter(|(path, _)| existing.contains(path.as_str())).collect();
        let mut files: Vec<StatsFile> = living
            .iter()
            .map(|(path, acc)| StatsFile { path: (*path).clone(), commits: acc.commits, authors: acc.weights.len() as u32, added: acc.added, removed: acc.removed })
            .collect();
        files.sort_by(|a, b| b.commits.cmp(&a.commits).then_with(|| (b.added + b.removed).cmp(&(a.added + a.removed))).then_with(|| a.path.cmp(&b.path)));
        let mut hotspots: Vec<StatsHotspot> = files
            .iter()
            .map(|f| StatsHotspot { path: f.path.clone(), commits: f.commits, authors: f.authors, score: f.commits.saturating_mul(f.authors) })
            .collect();
        hotspots.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| b.commits.cmp(&a.commits)).then_with(|| a.path.cmp(&b.path)));
        hotspots.truncate(MAX_HOTSPOTS);
        let file_count = files.len() as u32;
        files.truncate(MAX_FILES);
        let folders = folders(&living, &self.authors);

        RepoStats {
            tip: Some(tip),
            reference_time: Some(util::unix_to_iso(reference_time)),
            commits: self.totals.commits,
            added: self.totals.added,
            removed: self.totals.removed,
            first_at: self.first.map(util::unix_to_iso),
            last_at: self.last.map(util::unix_to_iso),
            heatmap: self.heatmap.iter().map(|row| row.to_vec()).collect(),
            weeks: self.weeks.iter().map(|(monday, totals)| totals.bucket(day_text(*monday))).collect(),
            months: self.months.iter().map(|((year, month), totals)| totals.bucket(format!("{year:04}-{month:02}"))).collect(),
            author_count,
            authors,
            file_count,
            files,
            hotspots,
            folders,
            code_age,
            records,
            cached: false,
        }
    }
}

/// Statistics with nothing to count (repository without a commit, nothing before `to`).
pub(super) fn empty() -> RepoStats {
    RepoStats { heatmap: vec![vec![0; 24]; 7], ..RepoStats::default() }
}

/// The folders a file counts towards: the root ("") and its folders down to `FOLDER_DEPTH`.
pub(super) fn folder_keys(path: &str) -> Vec<String> {
    let parts: Vec<&str> = path.split('/').collect();
    let mut keys = vec![String::new()];
    for depth in 1..parts.len().min(FOLDER_DEPTH + 1) {
        keys.push(parts[..depth].join("/"));
    }
    keys
}

/// `part` of `total` in percent, rounded half up.
pub(super) fn share(part: u64, total: u64) -> u32 {
    if total == 0 {
        return 0;
    }
    ((part * 100 + total / 2) / total) as u32
}

/// The fewest authors who together hold more than half of `total` (`weights` largest first).
pub(super) fn bus_factor(weights: &[u64], total: u64) -> u32 {
    let mut sum = 0u64;
    for (index, weight) in weights.iter().enumerate() {
        sum += weight;
        if sum * 2 > total {
            return index as u32 + 1;
        }
    }
    weights.len() as u32
}

fn folders(files: &[(&String, &FileAcc)], authors: &HashMap<String, AuthorAcc>) -> Vec<StatsFolder> {
    let mut by_folder: HashMap<String, HashMap<&str, u64>> = HashMap::new();
    for (path, acc) in files {
        for folder in folder_keys(path) {
            let weights = by_folder.entry(folder).or_default();
            for (author, weight) in &acc.weights {
                *weights.entry(author.as_str()).or_default() += weight;
            }
        }
    }
    let mut list: Vec<StatsFolder> = by_folder
        .into_iter()
        .map(|(path, weights)| {
            let mut ranked: Vec<(&str, u64)> = weights.into_iter().collect();
            ranked.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
            let sorted: Vec<u64> = ranked.iter().map(|(_, weight)| *weight).collect();
            let total: u64 = sorted.iter().sum();
            let main_author = ranked
                .first()
                .and_then(|(key, _)| authors.get(*key))
                .map(|a| Person { name: a.name.clone(), email: a.email.clone() })
                .unwrap_or_default();
            StatsFolder {
                path,
                weight: total,
                authors: ranked.len() as u32,
                main_author,
                main_share: share(sorted.first().copied().unwrap_or(0), total),
                bus_factor: bus_factor(&sorted, total),
            }
        })
        .collect();
    list.sort_by(|a, b| b.weight.cmp(&a.weight).then_with(|| a.path.cmp(&b.path)));
    list.truncate(MAX_FOLDERS);
    list
}

/// The longest run of consecutive days; ties keep the earliest.
pub(super) fn longest_streak(days: &BTreeMap<NaiveDate, u32>) -> Option<StatsStreak> {
    let mut best: Option<(NaiveDate, NaiveDate, u32)> = None;
    let mut run: Option<(NaiveDate, NaiveDate, u32)> = None;
    for &date in days.keys() {
        let next = match run {
            Some((start, end, length)) if end.succ_opt() == Some(date) => (start, date, length + 1),
            _ => (date, date, 1),
        };
        run = Some(next);
        if !matches!(best, Some((_, _, top)) if top >= next.2) {
            best = Some(next);
        }
    }
    best.map(|(start, end, days)| StatsStreak { days, start: day_text(start), end: day_text(end) })
}

/// The day with the most commits; ties keep the earliest.
pub(super) fn busiest_day(days: &BTreeMap<NaiveDate, u32>) -> Option<StatsBusyDay> {
    let mut best: Option<(NaiveDate, u32)> = None;
    for (&date, &commits) in days {
        if !matches!(best, Some((_, top)) if top >= commits) {
            best = Some((date, commits));
        }
    }
    best.map(|(date, commits)| StatsBusyDay { date: day_text(date), commits })
}

/// Sorts line times (Unix seconds) into the age buckets relative to `reference`.
/// Lines younger than the reference point (clock skew) count as under a month.
pub(super) fn age_buckets(times: &[i64], reference: i64, age: &mut StatsCodeAge) {
    for &time in times {
        let seconds = reference.saturating_sub(time);
        if seconds < MONTH {
            age.month += 1;
        } else if seconds < YEAR {
            age.year += 1;
        } else if seconds < THREE_YEARS {
            age.three_years += 1;
        } else {
            age.older += 1;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::parse::FileDelta;
    use super::*;

    const ADA: (&str, &str) = ("Ada", "ada@example.com");
    const BEN: (&str, &str) = ("Ben", "ben@example.com");

    fn commit(sha: &str, who: (&str, &str), time: i64, offset: i32, files: &[(&str, u64, u64)]) -> LogCommit {
        LogCommit {
            sha: sha.into(),
            name: who.0.into(),
            email: who.1.into(),
            time,
            offset,
            files: files.iter().map(|(path, added, removed)| FileDelta { path: (*path).into(), added: *added, removed: *removed }).collect(),
        }
    }

    /// Newest first, as `git log` delivers them.
    fn history() -> Vec<LogCommit> {
        vec![
            // Wed 2025-06-04 09:00 +0000
            commit("d", BEN, 1_749_027_600, 0, &[("docs/guide.md", 1, 0)]),
            // Wed 2025-06-04 08:00 +0000
            commit("c", BEN, 1_749_024_000, 0, &[("docs/guide.md", 1, 1), ("logo.bin", 0, 0)]),
            // Tue 2025-06-03 23:30 -0700 (in UTC already Wednesday)
            commit("b", BEN, 1_749_018_600, -25_200, &[("docs/guide.md", 5, 0), ("src/app/main.rs", 1, 0)]),
            // Mon 2025-06-02 10:00 +0200
            commit("a", ADA, 1_748_851_200, 7_200, &[("src/app/main.rs", 2, 1)]),
            // Mon 2023-03-06 09:15 +0100
            commit("e", ADA, 1_678_090_500, 3_600, &[("README.md", 3, 0), ("src/app/main.rs", 10, 0), ("old.txt", 2, 0)]),
        ]
    }

    fn existing() -> HashSet<String> {
        ["README.md", "src/app/main.rs", "docs/guide.md", "logo.bin"].into_iter().map(String::from).collect()
    }

    fn aggregate(from: Option<i64>, to: Option<i64>) -> RepoStats {
        let mut agg = Aggregator::new(from, to);
        for commit in history() {
            agg.add(&commit);
        }
        agg.finish(&existing(), StatsCodeAge::default(), "d".into(), 1_749_027_600)
    }

    #[test]
    fn heatmap_buckets_authors_and_records_use_the_authors_local_time() {
        let stats = aggregate(None, None);
        assert_eq!((stats.commits, stats.added, stats.removed), (5, 25, 2));
        assert_eq!((stats.tip.as_deref(), stats.reference_time.as_deref()), (Some("d"), Some("2025-06-04T09:00:00.000Z")));
        assert_eq!((stats.first_at.as_deref(), stats.last_at.as_deref()), (Some("2023-03-06T08:15:00.000Z"), Some("2025-06-04T09:00:00.000Z")));
        let cells: Vec<(usize, usize, u32)> = stats
            .heatmap
            .iter()
            .enumerate()
            .flat_map(|(day, row)| row.iter().enumerate().filter(|(_, n)| **n > 0).map(move |(hour, n)| (day, hour, *n)))
            .collect();
        assert_eq!(cells, [(0, 9, 1), (0, 10, 1), (1, 23, 1), (2, 8, 1), (2, 9, 1)], "Monday first, hour of the author's clock");
        let weeks: Vec<(&str, u32, u64, u64)> = stats.weeks.iter().map(|b| (b.period.as_str(), b.commits, b.added, b.removed)).collect();
        assert_eq!(weeks, [("2023-03-06", 1, 15, 0), ("2025-06-02", 4, 10, 2)]);
        let months: Vec<(&str, u32)> = stats.months.iter().map(|b| (b.period.as_str(), b.commits)).collect();
        assert_eq!(months, [("2023-03", 1), ("2025-06", 4)]);
        let authors: Vec<(&str, u32, u64, u64)> = stats.authors.iter().map(|a| (a.name.as_str(), a.commits, a.added, a.removed)).collect();
        assert_eq!(authors, [("Ben", 3, 8, 1), ("Ada", 2, 17, 1)]);
        assert_eq!((stats.authors[1].first_at.as_str(), stats.authors[1].last_at.as_str()), ("2023-03-06T08:15:00.000Z", "2025-06-02T08:00:00.000Z"));
        assert_eq!(stats.author_count, 2);
        assert_eq!(stats.records.longest_streak, Some(StatsStreak { days: 3, start: "2025-06-02".into(), end: "2025-06-04".into() }));
        assert_eq!(stats.records.busiest_day, Some(StatsBusyDay { date: "2025-06-04".into(), commits: 2 }));
        assert_eq!(stats.records.biggest_commit, Some(StatsBigCommit { sha: "e".into(), added: 15, removed: 0, at: "2023-03-06T08:15:00.000Z".into() }));
    }

    #[test]
    fn files_hotspots_and_folders_only_count_files_that_still_exist() {
        let stats = aggregate(None, None);
        let files: Vec<(&str, u32, u32, u64, u64)> = stats.files.iter().map(|f| (f.path.as_str(), f.commits, f.authors, f.added, f.removed)).collect();
        assert_eq!(files, [("src/app/main.rs", 3, 2, 13, 1), ("docs/guide.md", 3, 1, 7, 1), ("README.md", 1, 1, 3, 0), ("logo.bin", 1, 1, 0, 0)]);
        assert_eq!(stats.file_count, 4, "old.txt no longer exists");
        let hotspots: Vec<(&str, u32)> = stats.hotspots.iter().map(|h| (h.path.as_str(), h.score)).collect();
        assert_eq!(hotspots, [("src/app/main.rs", 6), ("docs/guide.md", 3), ("README.md", 1), ("logo.bin", 1)]);
        let folders: Vec<(&str, u64, u32, &str, u32, u32)> =
            stats.folders.iter().map(|f| (f.path.as_str(), f.weight, f.authors, f.main_author.name.as_str(), f.main_share, f.bus_factor)).collect();
        assert_eq!(
            folders,
            [("", 26, 2, "Ada", 62, 1), ("src", 14, 2, "Ada", 93, 1), ("src/app", 14, 2, "Ada", 93, 1), ("docs", 8, 1, "Ben", 100, 1)]
        );
        assert_eq!(stats.folders[0].main_author.email, "ada@example.com");
    }

    #[test]
    fn the_period_is_inclusive_and_uses_the_author_time() {
        let mut agg = Aggregator::new(Some(1_749_018_600), Some(1_749_024_000));
        let counted: Vec<bool> = history().iter().map(|commit| agg.add(commit)).collect();
        assert_eq!(counted, [false, true, true, false, false]);
        let stats = agg.finish(&existing(), StatsCodeAge::default(), "c".into(), 1_749_024_000);
        assert_eq!(stats.commits, 2);
        assert_eq!(stats.authors.len(), 1);
    }

    #[test]
    fn one_person_with_differently_written_addresses_counts_once() {
        assert_eq!(author_key("Cleo", "CLEO@Example.com "), author_key("Cleo B.", "cleo@example.com"));
        assert_eq!(author_key("Dan", ""), "name:Dan");
        let mut agg = Aggregator::new(None, None);
        agg.add(&commit("2", ("Cleo", "cleo@example.com"), 200, 0, &[("a.txt", 1, 0)]));
        agg.add(&commit("1", ("C. Lastname", "CLEO@Example.com"), 100, 0, &[("a.txt", 1, 0)]));
        let stats = agg.finish(&HashSet::from(["a.txt".to_string()]), StatsCodeAge::default(), "2".into(), 200);
        assert_eq!(stats.authors.len(), 1);
        assert_eq!((stats.authors[0].name.as_str(), stats.authors[0].email.as_str(), stats.authors[0].commits), ("Cleo", "cleo@example.com", 2), "name of the newest commit");
        assert_eq!(stats.files[0].authors, 1);
    }

    #[test]
    fn shares_bus_factor_and_folders() {
        assert_eq!(share(1, 3), 33);
        assert_eq!(share(1, 2), 50);
        assert_eq!(share(2, 3), 67);
        assert_eq!(share(5, 0), 0);
        assert_eq!(bus_factor(&[5, 5], 10), 2, "exactly half is not more than half");
        assert_eq!(bus_factor(&[6, 4], 10), 1);
        assert_eq!(bus_factor(&[3, 3, 3, 1], 10), 2);
        assert_eq!(bus_factor(&[], 0), 0);
        assert_eq!(folder_keys("a.txt"), [""]);
        assert_eq!(folder_keys("src/a.rs"), ["", "src"]);
        assert_eq!(folder_keys("src/app/deep/x.rs"), ["", "src", "src/app"]);
    }

    #[test]
    fn ties_keep_the_earliest_streak_and_day() {
        let days: BTreeMap<NaiveDate, u32> = [(2025, 6, 1, 2), (2025, 6, 2, 1), (2025, 6, 10, 2), (2025, 6, 11, 1)]
            .into_iter()
            .map(|(y, m, d, n)| (NaiveDate::from_ymd_opt(y, m, d).unwrap(), n))
            .collect();
        assert_eq!(longest_streak(&days), Some(StatsStreak { days: 2, start: "2025-06-01".into(), end: "2025-06-02".into() }));
        assert_eq!(busiest_day(&days), Some(StatsBusyDay { date: "2025-06-01".into(), commits: 2 }));
        assert_eq!(longest_streak(&BTreeMap::new()), None);
    }

    #[test]
    fn code_age_bucket_boundaries() {
        let now = 2_000_000_000;
        let mut age = StatsCodeAge::default();
        let times = [now + 10, now - (MONTH - 1), now - MONTH, now - (YEAR - 1), now - YEAR, now - (THREE_YEARS - 1), now - THREE_YEARS];
        age_buckets(&times, now, &mut age);
        assert_eq!((age.month, age.year, age.three_years, age.older), (2, 2, 2, 1));
    }

    #[test]
    fn nothing_to_count() {
        let stats = empty();
        assert_eq!(stats.heatmap.len(), 7);
        assert!(stats.heatmap.iter().all(|row| row.len() == 24 && row.iter().all(|n| *n == 0)));
        assert_eq!((stats.tip, stats.commits, stats.records.biggest_commit), (None, 0, None));
        let mut agg = Aggregator::new(None, None);
        agg.add(&commit("x", ADA, 100, 0, &[]));
        assert_eq!(agg.finish(&HashSet::new(), StatsCodeAge::default(), "x".into(), 100).records.biggest_commit, None, "a commit without lines is no record");
    }
}
