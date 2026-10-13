//! Table `host_accounts`: directory of the keychain entries (without the secret).

use rusqlite::{params, Connection, Row};

use crate::error::CoreResult;
use crate::model::{HostAccount, HostAccountKind};
use crate::util;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostAccountRow {
    pub id: String,
    pub profile_id: String,
    pub host: String,
    pub username: String,
    pub kind: HostAccountKind,
    /// Key of the entry in the keychain.
    pub keychain_ref: String,
    pub created_at: String,
}

impl HostAccountRow {
    pub fn to_model(&self) -> HostAccount {
        HostAccount {
            id: self.id.clone(),
            host: self.host.clone(),
            username: self.username.clone(),
            kind: self.kind,
            created_at: self.created_at.clone(),
        }
    }
}

fn kind_to_db(kind: HostAccountKind) -> &'static str {
    match kind {
        HostAccountKind::Password => "password",
        HostAccountKind::Passphrase => "passphrase",
    }
}

fn from_row(r: &Row) -> rusqlite::Result<HostAccountRow> {
    let kind: String = r.get("kind")?;
    Ok(HostAccountRow {
        id: r.get("id")?,
        profile_id: r.get("profile_id")?,
        host: r.get("host")?,
        username: r.get("username")?,
        kind: if kind == "passphrase" { HostAccountKind::Passphrase } else { HostAccountKind::Password },
        keychain_ref: r.get("keychain_ref")?,
        created_at: r.get("created_at")?,
    })
}

const COLUMNS: &str = "id, profile_id, host, username, kind, keychain_ref, created_at";

pub fn list(conn: &Connection, profile_id: &str) -> CoreResult<Vec<HostAccountRow>> {
    let mut stmt = conn.prepare(&format!("select {COLUMNS} from host_accounts where profile_id = ?1 order by host, username"))?;
    let rows = stmt.query_map([profile_id], from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Creates or updates an entry (same host and user). Returns the ID.
pub fn upsert(
    conn: &Connection,
    profile_id: &str,
    host: &str,
    username: &str,
    kind: HostAccountKind,
    keychain_ref: &str,
) -> CoreResult<String> {
    let now = util::now_iso();
    let id = util::new_id();
    conn.execute(
        "insert into host_accounts (id, profile_id, host, username, kind, keychain_ref, created_at, updated_at)
         values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
         on conflict (profile_id, host, username) do update set
           kind = excluded.kind, keychain_ref = excluded.keychain_ref, updated_at = excluded.updated_at",
        params![id, profile_id, host, username, kind_to_db(kind), keychain_ref, now],
    )?;
    let id: String = conn.query_row(
        "select id from host_accounts where profile_id = ?1 and host = ?2 and username = ?3",
        params![profile_id, host, username],
        |r| r.get(0),
    )?;
    Ok(id)
}

pub fn delete(conn: &Connection, profile_id: &str, id: &str) -> CoreResult<()> {
    conn.execute("delete from host_accounts where profile_id = ?1 and id = ?2", params![profile_id, id])?;
    Ok(())
}

/// Deletes all entries of the profile and returns them (so the keychain can be cleaned up too).
pub fn delete_all(conn: &Connection, profile_id: &str) -> CoreResult<Vec<HostAccountRow>> {
    let rows = list(conn, profile_id)?;
    conn.execute("delete from host_accounts where profile_id = ?1", [profile_id])?;
    Ok(rows)
}
