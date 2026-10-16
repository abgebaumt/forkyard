//! Narrowing the commit search: code (`-S`), time window, paths. Commit dates rise along the history so
//! Git's date cut-off sees them in order.

use super::*;
use crate::error::ErrorCode;
use crate::testkit::{TestCore, TestRepo};

struct Fx {
    /// Keeps the temporary repository alive while the core searches it.
    _repo: TestRepo,
    tc: TestCore,
    id: String,
    june_a: String,
    june_b: String,
    added: String,
    other: String,
    fix: String,
}

async fn fixture() -> Fx {
    let repo = TestRepo::new();
    let commit = |file: &str, content: &str, message: &str, date: &str| {
        repo.write_file(file, content);
        repo.commit_as_dates(message, "Erika Muster", "erika@example.com", date, date)
    };
    let june_a = commit("a.txt", "a\n", "Juni A", "2025-06-13T08:00:00+0000");
    let june_b = commit("-start.txt", "s\n", "Juni B", "2025-06-15T13:00:00+0000");
    let added = commit("src/ä b/lib.rs", "fn geheimeFunktion() {}\n", "Füge Funktion hinzu", "2025-12-31T23:30:00+14:00");
    let other = commit("[x].txt", "GEHEIMEFUNKTION\n", "Anderes", "2026-01-01T10:00:00-12:00");
    let fix = commit("x.txt", "x\n", "Fix x", "2026-01-02T10:00:00+0000");
    let tc = TestCore::new().await;
    let id = tc.open(&repo).await.repo.id;
    Fx { _repo: repo, tc, id, june_a, june_b, added, other, fix }
}

impl Fx {
    async fn search(&self, query: &str, filters: CommitSearchFilters) -> CoreResult<Vec<String>> {
        let found = commit_search(&self.tc, self.id.clone(), query.to_string(), 50, None, Some(filters)).await?;
        Ok(found.into_iter().map(|commit| commit.sha).collect())
    }
}

fn filters(pickaxe: Option<&str>, since: Option<&str>, until: Option<&str>, paths: &[&str]) -> CommitSearchFilters {
    CommitSearchFilters {
        pickaxe: pickaxe.map(str::to_string),
        since: since.map(str::to_string),
        until: until.map(str::to_string),
        paths: (!paths.is_empty()).then(|| paths.iter().map(|path| path.to_string()).collect()),
    }
}

#[tokio::test]
async fn search_filters_narrow_by_code_and_path() {
    let fx = fixture().await;
    assert_eq!(fx.search("", filters(Some("geheimefunktion"), None, None, &[])).await.unwrap(), vec![fx.other.clone(), fx.added.clone()], "code search ignores case");
    assert_eq!(fx.search("", filters(Some("geheimeFunktion"), None, None, &["src/ä b"])).await.unwrap(), vec![fx.added.clone()], "plus a folder");
    assert_eq!(fx.search("Juni", filters(None, Some("2025-06-14"), None, &[])).await.unwrap(), vec![fx.june_b.clone()], "message search and a date together");
    // With filters a SHA prefix is not searched as such.
    assert_eq!(fx.search(&fx.june_a[..8], CommitSearchFilters::default()).await.unwrap(), vec![fx.june_a.clone()], "no filters: SHA search as before");
    assert!(fx.search(&fx.june_a[..8], filters(None, Some("2000-01-01"), None, &[])).await.unwrap().is_empty());
    assert!(fx.search("", CommitSearchFilters::default()).await.unwrap().is_empty(), "nothing to look for");
}

#[tokio::test]
async fn search_filters_respect_time_zones_and_literal_paths() {
    let fx = fixture().await;
    // 2025-12-31T23:30+14:00 is 09:30 UTC; 2026-01-01T10:00-12:00 is 22:00 UTC.
    assert_eq!(fx.search("", filters(None, Some("2025-12-31T09:00:00Z"), Some("2025-12-31T10:00:00Z"), &[])).await.unwrap(), vec![fx.added.clone()]);
    assert_eq!(fx.search("", filters(None, Some("2025-12-31T20:30:00+14:00"), Some("2025-12-31T23:59:00+14:00"), &[])).await.unwrap(), vec![fx.added.clone()]);
    assert_eq!(fx.search("", filters(None, Some("2026-01-01T21:00:00Z"), Some("2026-01-01T23:00:00Z"), &[])).await.unwrap(), vec![fx.other.clone()]);
    // A bare date means local midnight / end of day; the commits sit far enough from the borders that
    // every time zone between UTC−12 and UTC+14 gives the same answer.
    assert_eq!(fx.search("", filters(None, Some("2025-06-15"), None, &[])).await.unwrap(), vec![fx.fix.clone(), fx.other.clone(), fx.added.clone(), fx.june_b.clone()]);
    assert_eq!(fx.search("", filters(None, None, Some("2025-06-13"), &[])).await.unwrap(), vec![fx.june_a.clone()]);
    // Paths are literal: a leading dash and brackets are no options or patterns.
    assert_eq!(fx.search("", filters(None, None, None, &["-start.txt"])).await.unwrap(), vec![fx.june_b.clone()]);
    assert_eq!(fx.search("", filters(None, None, None, &["[x].txt"])).await.unwrap(), vec![fx.other.clone()], "not x.txt");
}

#[tokio::test]
async fn search_filters_are_checked() {
    let fx = fixture().await;
    for bad in ["yesterday", "2025-13", "1.1.2026", "2025-06-15 --all"] {
        let err = fx.search("", filters(None, Some(bad), None, &[])).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed, "{bad}");
    }
    assert_eq!(fx.search("", filters(None, None, None, &["../draußen"])).await.unwrap_err().code, ErrorCode::NotAllowed);
    let many: Vec<String> = (0..=MAX_SEARCH_PATHS).map(|n| format!("datei-{n}.txt")).collect();
    let too_many = CommitSearchFilters { paths: Some(many), ..CommitSearchFilters::default() };
    assert_eq!(fx.search("", too_many).await.unwrap_err().code, ErrorCode::NotAllowed);
}
