//! Table `ssh_keys`: key paths per profile (the passphrase lives in the keychain).

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::int_bool;
use crate::error::CoreResult;
use crate::util;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshKeyRow {
    pub id: String,
    pub profile_id: String,
    pub label: String,
    pub private_key_path: String,
    pub public_key_path: String,
    pub is_default: bool,
    pub created_at: String,
}

fn from_row(r: &Row) -> rusqlite::Result<SshKeyRow> {
    Ok(SshKeyRow {
        id: r.get("id")?,
        profile_id: r.get("profile_id")?,
        label: r.get("label")?,
        private_key_path: r.get("private_key_path")?,
        public_key_path: r.get("public_key_path")?,
        is_default: int_bool(r.get("is_default")?),
        created_at: r.get("created_at")?,
    })
}

const COLUMNS: &str = "id, profile_id, label, private_key_path, public_key_path, is_default, created_at";

pub fn list(conn: &Connection, profile_id: &str) -> CoreResult<Vec<SshKeyRow>> {
    let mut stmt = conn.prepare(&format!("select {COLUMNS} from ssh_keys where profile_id = ?1 order by created_at, label"))?;
    let rows = stmt.query_map([profile_id], from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, profile_id: &str, id: &str) -> CoreResult<Option<SshKeyRow>> {
    Ok(conn
        .query_row(&format!("select {COLUMNS} from ssh_keys where profile_id = ?1 and id = ?2"), params![profile_id, id], from_row)
        .optional()?)
}

pub fn insert(conn: &Connection, profile_id: &str, label: &str, private_key_path: &str, public_key_path: &str) -> CoreResult<String> {
    let id = util::new_id();
    let now = util::now_iso();
    conn.execute(
        "insert into ssh_keys (id, profile_id, label, private_key_path, public_key_path, is_default, created_at, updated_at)
         values (?1, ?2, ?3, ?4, ?5, 0, ?6, ?6)",
        params![id, profile_id, label, private_key_path, public_key_path, now],
    )?;
    Ok(id)
}

pub fn delete(conn: &Connection, profile_id: &str, id: &str) -> CoreResult<()> {
    conn.execute("delete from ssh_keys where profile_id = ?1 and id = ?2", params![profile_id, id])?;
    Ok(())
}

/// Sets the default key (`None` = none).
pub fn set_default(conn: &Connection, profile_id: &str, id: Option<&str>) -> CoreResult<()> {
    conn.execute("update ssh_keys set is_default = 0 where profile_id = ?1 and is_default = 1", [profile_id])?;
    if let Some(id) = id {
        conn.execute(
            "update ssh_keys set is_default = 1, updated_at = ?3 where profile_id = ?1 and id = ?2",
            params![profile_id, id, util::now_iso()],
        )?;
    }
    Ok(())
}
