//! Table `profiles`.

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::int_bool;
use crate::error::{CoreError, CoreResult};
use crate::model::Profile;
use crate::util;

fn from_row(r: &Row) -> rusqlite::Result<Profile> {
    Ok(Profile {
        id: r.get("id")?,
        name: r.get("name")?,
        author_name: r.get("author_name")?,
        author_email: r.get("author_email")?,
        sync_gitconfig: int_bool(r.get("sync_gitconfig")?),
        is_active: int_bool(r.get("is_active")?),
        color: r.get::<_, Option<String>>("color")?.and_then(|c| c.parse::<u8>().ok()),
    })
}

const COLUMNS: &str = "id, name, author_name, author_email, sync_gitconfig, is_active, color";

pub fn list(conn: &Connection) -> CoreResult<Vec<Profile>> {
    let mut stmt = conn.prepare(&format!("select {COLUMNS} from profiles order by created_at, name"))?;
    let rows = stmt.query_map([], from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, id: &str) -> CoreResult<Option<Profile>> {
    Ok(conn
        .query_row(&format!("select {COLUMNS} from profiles where id = ?1"), [id], from_row)
        .optional()?)
}

pub fn count(conn: &Connection) -> CoreResult<i64> {
    Ok(conn.query_row("select count(*) from profiles", [], |r| r.get(0))?)
}

/// The active profile (after startup there is always exactly one).
pub fn active(conn: &Connection) -> CoreResult<Profile> {
    conn.query_row(&format!("select {COLUMNS} from profiles where is_active = 1"), [], from_row)
        .optional()?
        .ok_or_else(|| CoreError::not_found("No profile is active."))
}

pub fn active_id(conn: &Connection) -> CoreResult<String> {
    Ok(active(conn)?.id)
}

/// Is the name already taken (case-insensitive), except by `except_id`?
pub fn name_taken(conn: &Connection, name: &str, except_id: Option<&str>) -> CoreResult<bool> {
    let n: i64 = conn.query_row(
        "select count(*) from profiles where lower(name) = lower(?1) and id <> coalesce(?2, '')",
        params![name.trim(), except_id],
        |r| r.get(0),
    )?;
    Ok(n > 0)
}

pub fn insert(conn: &Connection, name: &str, author_name: &str, author_email: &str, sync_gitconfig: bool) -> CoreResult<String> {
    let id = util::new_id();
    let now = util::now_iso();
    conn.execute(
        "insert into profiles (id, name, author_name, author_email, sync_gitconfig, is_active, created_at, updated_at)
         values (?1, ?2, ?3, ?4, ?5, 0, ?6, ?6)",
        params![id, name.trim(), author_name, author_email, sync_gitconfig as i64, now],
    )?;
    Ok(id)
}

pub fn update(conn: &Connection, id: &str, name: &str, author_name: &str, author_email: &str, sync_gitconfig: bool) -> CoreResult<()> {
    let n = conn.execute(
        "update profiles set name = ?2, author_name = ?3, author_email = ?4, sync_gitconfig = ?5, updated_at = ?6 where id = ?1",
        params![id, name.trim(), author_name, author_email, sync_gitconfig as i64, util::now_iso()],
    )?;
    if n == 0 {
        return Err(CoreError::not_found("Profile not found."));
    }
    Ok(())
}

/// Lane colour 1 to 8 (checked by the caller); `None` = by position.
pub fn set_color(conn: &Connection, id: &str, color: Option<u8>) -> CoreResult<()> {
    conn.execute("update profiles set color = ?2 where id = ?1", params![id, color.map(|c| c.to_string())])?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> CoreResult<()> {
    conn.execute("delete from profiles where id = ?1", [id])?;
    Ok(())
}

/// Makes `id` the only active profile.
pub fn set_active(conn: &Connection, id: &str) -> CoreResult<()> {
    if get(conn, id)?.is_none() {
        return Err(CoreError::not_found("Profile not found."));
    }
    conn.execute("update profiles set is_active = 0 where is_active = 1 and id <> ?1", [id])?;
    conn.execute("update profiles set is_active = 1, updated_at = ?2 where id = ?1", params![id, util::now_iso()])?;
    Ok(())
}
