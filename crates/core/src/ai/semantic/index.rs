//! `ai-index.db` in the data directory: one index per repository and embedding model (spec 9.2).
//! Its own file, not the main database: deletable as a whole, no migration (`create table if not
//! exists`). The file is created on the first write; reading a missing file means "no index".

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};

use crate::ai::semantic::vector;
use crate::app::Core;
use crate::error::{CoreError, CoreResult};
use crate::util;

pub const INDEX_FILE: &str = "ai-index.db";

const SCHEMA: &str = "
create table if not exists indexes (
    id integer primary key,
    repository_id text not null,
    provider text not null,
    model text not null,
    dims integer not null default 0,
    used_at text not null,
    unique (repository_id, provider, model)
);
create table if not exists entries (
    index_id integer not null references indexes (id) on delete cascade,
    sha text not null,
    scale real not null,
    vector blob not null,
    primary key (index_id, sha)
) without rowid;
";

#[derive(Default)]
struct IndexStore {
    conn: Mutex<Option<Connection>>,
}

fn file(core: &Core) -> PathBuf {
    core.data_dir().join(INDEX_FILE)
}

fn open(path: &Path) -> CoreResult<Connection> {
    // Private like the main database – before SQLite creates -wal and -shm next to it.
    if let Err(e) = util::create_private_file(path).and_then(|()| util::restrict_to_owner(path)) {
        log::warn!("Permissions of the search index not restricted: {e}");
    }
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    let _mode: String = conn.query_row("pragma journal_mode = wal", [], |r| r.get(0))?;
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
}

/// `create`: open (and create) the file. Without `create` a missing file gives `Ok(None)`.
fn with<T>(core: &Core, create: bool, f: impl FnOnce(&Connection) -> CoreResult<T>) -> CoreResult<Option<T>> {
    let store = core.state::<IndexStore>();
    let mut conn = store.conn.lock();
    if conn.is_none() {
        let path = file(core);
        if !create && !path.exists() {
            return Ok(None);
        }
        *conn = Some(open(&path)?);
    }
    match conn.as_ref() {
        Some(conn) => f(conn).map(Some),
        None => Ok(None),
    }
}

pub fn find(core: &Core, repo_id: &str, provider: &str, model: &str) -> CoreResult<Option<i64>> {
    let found = with(core, false, |c| {
        Ok(c.query_row(
            "select id from indexes where repository_id = ?1 and provider = ?2 and model = ?3",
            params![repo_id, provider, model],
            |r| r.get::<_, i64>(0),
        )
        .optional()?)
    })?;
    Ok(found.flatten())
}

pub fn create(core: &Core, repo_id: &str, provider: &str, model: &str) -> CoreResult<i64> {
    let id = with(core, true, |c| {
        c.execute(
            "insert or ignore into indexes (repository_id, provider, model, used_at) values (?1, ?2, ?3, ?4)",
            params![repo_id, provider, model, util::now_iso()],
        )?;
        Ok(c.query_row("select id from indexes where repository_id = ?1 and provider = ?2 and model = ?3", params![repo_id, provider, model], |r| r.get::<_, i64>(0))?)
    })?;
    id.ok_or_else(|| CoreError::io("The search index could not be opened."))
}

pub fn known(core: &Core, id: i64) -> CoreResult<HashSet<String>> {
    let shas = with(core, false, |c| {
        let mut stmt = c.prepare("select sha from entries where index_id = ?1")?;
        let rows = stmt.query_map([id], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<HashSet<_>>>()?)
    })?;
    Ok(shas.unwrap_or_default())
}

pub fn count(core: &Core, id: i64) -> CoreResult<u64> {
    let n = with(core, false, |c| Ok(c.query_row("select count(*) from entries where index_id = ?1", [id], |r| r.get::<_, i64>(0))?))?;
    Ok(n.unwrap_or(0).max(0) as u64)
}

/// Stores prepared vectors (`vector::prepare`); the first batch fixes the index's vector size.
pub fn insert(core: &Core, id: i64, rows: &[(String, Vec<f32>)]) -> CoreResult<()> {
    if rows.is_empty() {
        return Ok(());
    }
    with(core, true, |c| {
        let tx = c.unchecked_transaction()?;
        let mut dims: i64 = tx.query_row("select dims from indexes where id = ?1", [id], |r| r.get(0))?;
        {
            let mut stmt = tx.prepare("insert or replace into entries (index_id, sha, scale, vector) values (?1, ?2, ?3, ?4)")?;
            for (sha, values) in rows {
                let size = values.len() as i64;
                if dims == 0 {
                    tx.execute("update indexes set dims = ?2 where id = ?1", params![id, size])?;
                    dims = size;
                } else if size != dims {
                    return Err(CoreError::ai_invalid_answer(format!("the embedding size changed from {dims} to {size}")));
                }
                let (scale, quantized) = vector::quantize(values);
                stmt.execute(params![id, sha, f64::from(scale), vector::to_blob(&quantized)])?;
            }
        }
        tx.commit()?;
        Ok(())
    })?;
    Ok(())
}

pub fn remove(core: &Core, id: i64, shas: &[String]) -> CoreResult<usize> {
    if shas.is_empty() {
        return Ok(0);
    }
    let removed = with(core, false, |c| {
        let tx = c.unchecked_transaction()?;
        let mut removed = 0;
        {
            let mut stmt = tx.prepare("delete from entries where index_id = ?1 and sha = ?2")?;
            for sha in shas {
                removed += stmt.execute(params![id, sha])?;
            }
        }
        tx.commit()?;
        Ok(removed)
    })?;
    Ok(removed.unwrap_or(0))
}

/// Linear cosine search over every entry of the index.
pub fn scores(core: &Core, id: i64, query: &[f32]) -> CoreResult<Vec<(String, f32)>> {
    let scored = with(core, false, |c| {
        let mut stmt = c.prepare("select sha, scale, vector from entries where index_id = ?1")?;
        let rows = stmt.query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, f64>(1)?, r.get::<_, Vec<u8>>(2)?)))?;
        let mut out = Vec::new();
        for row in rows {
            let (sha, scale, blob) = row?;
            if blob.len() != query.len() {
                return Err(CoreError::ai_invalid_answer(format!("the question has {} dimensions, the index {}", query.len(), blob.len())));
            }
            out.push((sha, vector::score(query, scale as f32, &vector::from_blob(&blob))));
        }
        Ok(out)
    })?;
    Ok(scored.unwrap_or_default())
}

pub fn touch(core: &Core, id: i64) -> CoreResult<()> {
    with(core, false, |c| {
        c.execute("update indexes set used_at = ?2 where id = ?1", params![id, util::now_iso()])?;
        Ok(())
    })?;
    Ok(())
}

/// "Delete index": every repository and model; returns the number of indexes removed.
pub fn delete_all(core: &Core) -> CoreResult<u64> {
    let removed = with(core, false, |c| {
        let removed = c.execute("delete from indexes", [])?;
        c.execute_batch("vacuum")?;
        Ok(removed as u64)
    })?;
    Ok(removed.unwrap_or(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use crate::testkit::TestCore;

    fn sha(c: char) -> String {
        c.to_string().repeat(40)
    }

    #[tokio::test]
    async fn the_index_is_kept_per_repository_and_model_in_its_own_file() {
        let tc = TestCore::new().await;
        let file = tc.data_dir().join(INDEX_FILE);
        assert_eq!(find(&tc, "repo-a", "ollama", "embeddinggemma").unwrap(), None);
        assert!(!file.exists(), "reading never creates the file");
        let a = create(&tc, "repo-a", "ollama", "embeddinggemma").unwrap();
        assert!(file.exists());
        assert_eq!(create(&tc, "repo-a", "ollama", "embeddinggemma").unwrap(), a, "one index per repository and model");
        assert_eq!(find(&tc, "repo-a", "ollama", "embeddinggemma").unwrap(), Some(a));
        let b = create(&tc, "repo-a", "ollama", "nomic-embed-text").unwrap();
        let c = create(&tc, "repo-b", "ollama", "embeddinggemma").unwrap();
        assert!(a != b && a != c && b != c, "another model or repository is another index");
        insert(&tc, a, &[(sha('1'), vec![1.0, 0.0]), (sha('2'), vec![0.0, 1.0])]).unwrap();
        insert(&tc, b, &[(sha('1'), vec![0.6, 0.8, 0.0])]).unwrap();
        assert_eq!((count(&tc, a).unwrap(), count(&tc, b).unwrap(), count(&tc, c).unwrap()), (2, 1, 0));
        let err = insert(&tc, a, &[(sha('3'), vec![1.0, 0.0, 0.0])]).unwrap_err();
        assert_eq!(err.code, ErrorCode::AiInvalidAnswer, "a model does not change its vector size");
        assert_eq!(count(&tc, a).unwrap(), 2, "nothing of the refused batch is kept");
        let main_tables: Vec<String> = tc
            .db
            .with(|c| {
                let mut stmt = c.prepare("select name from sqlite_master where type = 'table'")?;
                let names = stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(names)
            })
            .unwrap();
        assert!(!main_tables.iter().any(|t| t == "entries" || t == "indexes"), "not in the main database: {main_tables:?}");
        assert_eq!(delete_all(&tc).unwrap(), 3);
        assert_eq!(find(&tc, "repo-a", "ollama", "embeddinggemma").unwrap(), None);
        assert_eq!(delete_all(&tc).unwrap(), 0);
    }

    #[tokio::test]
    async fn stale_commits_leave_and_scores_follow_the_cosine() {
        let tc = TestCore::new().await;
        let id = create(&tc, "repo", "openai", "text-embedding-3-small").unwrap();
        let (a, b, c) = (sha('a'), sha('b'), sha('c'));
        insert(&tc, id, &[(a.clone(), vec![1.0, 0.0, 0.0]), (b.clone(), vec![0.8, 0.6, 0.0]), (c.clone(), vec![0.0, 0.0, 1.0])]).unwrap();
        let mut ranked = scores(&tc, id, &[1.0, 0.0, 0.0]).unwrap();
        ranked.sort_by(|x, y| y.1.total_cmp(&x.1));
        assert_eq!(ranked.iter().map(|(sha, _)| sha.clone()).collect::<Vec<_>>(), vec![a.clone(), b.clone(), c.clone()]);
        assert!((ranked[0].1 - 1.0).abs() < 0.01 && (ranked[1].1 - 0.8).abs() < 0.01 && ranked[2].1.abs() < 0.01, "{ranked:?}");
        assert_eq!(scores(&tc, id, &[1.0, 0.0]).unwrap_err().code, ErrorCode::AiInvalidAnswer, "a question of another size");
        assert_eq!(remove(&tc, id, &[b.clone(), sha('d')]).unwrap(), 1);
        assert_eq!(known(&tc, id).unwrap(), [a.clone(), c.clone()].into_iter().collect());
        insert(&tc, id, &[(c.clone(), vec![0.0, 1.0, 0.0])]).unwrap();
        assert_eq!(count(&tc, id).unwrap(), 2, "embedding a commit again replaces it");
        touch(&tc, id).unwrap();
    }
}
