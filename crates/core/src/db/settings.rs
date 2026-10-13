//! Table `settings`: key/value per profile. Keys are the field names of
//! `Settings` in camelCase (e.g. `autoFetchMinutes`), values are JSON.

use rusqlite::{params, Connection};
use serde_json::Value;

use crate::error::CoreResult;
use crate::util;

pub fn get_all(conn: &Connection, profile_id: &str) -> CoreResult<Vec<(String, Value)>> {
    let mut stmt = conn.prepare("select key, value from settings where profile_id = ?1")?;
    let rows = stmt
        .query_map([profile_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows
        .into_iter()
        .filter_map(|(k, v)| serde_json::from_str(&v).ok().map(|v| (k, v)))
        .collect())
}

pub fn set(conn: &Connection, profile_id: &str, key: &str, value: &Value) -> CoreResult<()> {
    conn.execute(
        "insert into settings (profile_id, key, value, updated_at) values (?1, ?2, ?3, ?4)
         on conflict (profile_id, key) do update set value = excluded.value, updated_at = excluded.updated_at",
        params![profile_id, key, value.to_string(), util::now_iso()],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, profile_id: &str, key: &str) -> CoreResult<()> {
    conn.execute("delete from settings where profile_id = ?1 and key = ?2", params![profile_id, key])?;
    Ok(())
}
