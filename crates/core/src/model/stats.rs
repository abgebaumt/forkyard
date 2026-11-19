//! Statistics

use super::*;

/// What `stats_compute` counts. `from`/`to`: ISO-8601, compared with the author time (both
/// inclusive); `None` = open. `ref` (JSON key): `HEAD` or a full ref name (`refs/heads/main`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsRange {
    pub from: Option<IsoTime>,
    pub to: Option<IsoTime>,
    #[serde(rename = "ref")]
    pub reference: String,
}

/// Commits of a week (`period` = its Monday, "YYYY-MM-DD") or a month ("YYYY-MM"), by the
/// author's local date.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsBucket {
    pub period: String,
    pub commits: u32,
    pub added: u64,
    pub removed: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsAuthor {
    pub name: String,
    pub email: String,
    pub commits: u32,
    pub added: u64,
    pub removed: u64,
    pub first_at: IsoTime,
    pub last_at: IsoTime,
}

/// A file that still exists at the tip and was changed in the period.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsFile {
    pub path: String,
    pub commits: u32,
    /// Number of different authors.
    pub authors: u32,
    pub added: u64,
    pub removed: u64,
}

/// `score` = commits × authors.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsHotspot {
    pub path: String,
    pub commits: u32,
    pub authors: u32,
    pub score: u32,
}

/// Knowledge per folder (`path` "" = the whole repository). `weight`: changed lines, at least
/// 1 per file change. `bus_factor`: fewest authors who together hold more than half of it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsFolder {
    pub path: String,
    pub weight: u64,
    pub authors: u32,
    pub main_author: Person,
    /// Share of the main author in percent (0–100).
    pub main_share: u32,
    pub bus_factor: u32,
    /// The authors with the most changed lines in the folder, most first (at most 6); the rest of
    /// `weight` belongs to the others.
    pub top: Vec<StatsFolderShare>,
}

/// An author's changed lines in a folder.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsFolderShare {
    pub author: Person,
    pub weight: u64,
}

/// Lines of the blamed sample by the age of their last change, relative to
/// `RepoStats::reference_time`: under 30 days, under 180 days, under 365 days, under 2 × 365
/// days, older.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsCodeAge {
    /// Files that were blamed.
    pub files: u32,
    /// Files of the sample that Git could not blame.
    pub skipped: u32,
    pub month: u64,
    pub half_year: u64,
    pub year: u64,
    pub two_years: u64,
    pub older: u64,
}

/// Longest run of consecutive days with commits ("YYYY-MM-DD", author's local date).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsStreak {
    pub days: u32,
    pub start: String,
    pub end: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsBigCommit {
    pub sha: Sha,
    pub added: u64,
    pub removed: u64,
    pub at: IsoTime,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsBusyDay {
    pub date: String,
    pub commits: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsRecords {
    pub longest_streak: Option<StatsStreak>,
    pub biggest_commit: Option<StatsBigCommit>,
    pub busiest_day: Option<StatsBusyDay>,
}

/// Result of `stats_compute`: derived numbers only – no commit list, no messages.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStats {
    /// The commit whose history was counted; `None` = nothing to count.
    pub tip: Option<Sha>,
    /// Reference point of the code age: `to`, otherwise now (also for a cached result).
    pub reference_time: Option<IsoTime>,
    pub commits: u32,
    pub added: u64,
    pub removed: u64,
    pub first_at: Option<IsoTime>,
    pub last_at: Option<IsoTime>,
    /// 7 × 24: weekday (Monday first) × hour, in the author's local time.
    pub heatmap: Vec<Vec<u32>>,
    pub weeks: Vec<StatsBucket>,
    pub months: Vec<StatsBucket>,
    /// All authors of the period; `authors` holds at most 200 of them.
    pub author_count: u32,
    pub authors: Vec<StatsAuthor>,
    /// All changed files that still exist; `files` holds at most 2000 of them (most changed first).
    pub file_count: u32,
    pub files: Vec<StatsFile>,
    pub hotspots: Vec<StatsHotspot>,
    pub folders: Vec<StatsFolder>,
    pub code_age: StatsCodeAge,
    pub records: StatsRecords,
    /// Came from the cache.
    pub cached: bool,
}
