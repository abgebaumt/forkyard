//! Table `stats_cache`: results of `stats_compute` as JSON – derived numbers only, never
//! commits. The key names the tip commit, the period and the version of the computation
//! (`commands::stats`); each repository keeps its `KEEP_PER_REPO` newest entries.

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::CoreResult;

/// Entries per repository; older ones are dropped when a new one is written.
pub const KEEP_PER_REPO: u32 = 12;

pub fn get(conn: &Connection, repo_id: &str, key: &str) -> CoreResult<Option<String>> {
    let value = conn
        .query_row(
            "select value from stats_cache where repository_id = ?1 and cache_key = ?2",
            params![repo_id, key],
            |r| r.get(0),
        )
        .optional()?;
    Ok(value)
}

/// Stores (or replaces) an entry and drops everything beyond the newest `KEEP_PER_REPO`.
pub fn put(conn: &Connection, repo_id: &str, key: &str, value: &str) -> CoreResult<()> {
    conn.execute(
        "insert into stats_cache (repository_id, cache_key, value) values (?1, ?2, ?3)
         on conflict (repository_id, cache_key) do update set
           value = excluded.value, created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
        params![repo_id, key, value],
    )?;
    conn.execute(
        "delete from stats_cache where repository_id = ?1 and rowid not in (
           select rowid from stats_cache where repository_id = ?1 order by created_at desc, rowid desc limit ?2)",
        params![repo_id, KEEP_PER_REPO],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{repos, Db};

    fn db_with_repo() -> (Db, String) {
        let db = Db::open_in_memory().unwrap();
        let id = db.with(|c| Ok(repos::upsert(c, std::path::Path::new("/statistik/repo"))?.id)).unwrap();
        (db, id)
    }

    #[test]
    fn stores_replaces_and_reads_entries() {
        let (db, id) = db_with_repo();
        assert_eq!(db.with(|c| get(c, &id, "v1|abc||")).unwrap(), None);
        db.with(|c| put(c, &id, "v1|abc||", r#"{"commits":1}"#)).unwrap();
        db.with(|c| put(c, &id, "v1|abc||", r#"{"commits":2}"#)).unwrap();
        assert_eq!(db.with(|c| get(c, &id, "v1|abc||")).unwrap().as_deref(), Some(r#"{"commits":2}"#));
        assert!(db.with(|c| put(c, &id, "v1|kaputt||", "kein json")).is_err(), "only JSON is stored");
    }

    #[test]
    fn keeps_only_the_newest_entries_per_repository() {
        let (db, id) = db_with_repo();
        for n in 0..KEEP_PER_REPO + 2 {
            db.with(|c| put(c, &id, &format!("key-{n}"), "{}")).unwrap();
        }
        let count: i64 = db.with(|c| Ok(c.query_row("select count(*) from stats_cache where repository_id = ?1", [&id], |r| r.get(0))?)).unwrap();
        assert_eq!(count, i64::from(KEEP_PER_REPO));
        assert_eq!(db.with(|c| get(c, &id, "key-0")).unwrap(), None, "the oldest entry is gone");
        assert_eq!(db.with(|c| get(c, &id, "key-1")).unwrap(), None);
        assert!(db.with(|c| get(c, &id, &format!("key-{}", KEEP_PER_REPO + 1))).unwrap().is_some());
    }

    #[test]
    fn forgetting_the_repository_removes_its_entries() {
        let (db, id) = db_with_repo();
        db.with(|c| put(c, &id, "key", "{}")).unwrap();
        db.with(|c| repos::delete(c, &id)).unwrap();
        let count: i64 = db.with(|c| Ok(c.query_row("select count(*) from stats_cache", [], |r| r.get(0))?)).unwrap();
        assert_eq!(count, 0);
    }
}
