//! Table `repo_settings`: app-side settings per repository (key/JSON).
//! Keys are field names of `RepoSettings` in camelCase. What Git itself understands
//! (hooksPath, commitTemplate, authorName, authorEmail) lives in .git/config, not here.

use rusqlite::{params, Connection};
use serde_json::Value;

use crate::error::CoreResult;
use crate::util;

pub fn get_all(conn: &Connection, repo_id: &str) -> CoreResult<Vec<(String, Value)>> {
    let mut stmt = conn.prepare("select key, value from repo_settings where repository_id = ?1")?;
    let rows = stmt
        .query_map([repo_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows
        .into_iter()
        .filter_map(|(k, v)| serde_json::from_str(&v).ok().map(|v| (k, v)))
        .collect())
}

pub fn set(conn: &Connection, repo_id: &str, key: &str, value: &Value) -> CoreResult<()> {
    conn.execute(
        "insert into repo_settings (repository_id, key, value, updated_at) values (?1, ?2, ?3, ?4)
         on conflict (repository_id, key) do update set value = excluded.value, updated_at = excluded.updated_at",
        params![repo_id, key, value.to_string(), util::now_iso()],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, repo_id: &str, key: &str) -> CoreResult<()> {
    conn.execute("delete from repo_settings where repository_id = ?1 and key = ?2", params![repo_id, key])?;
    Ok(())
}

/// A text value (e.g. `sshKeyId`) or `None` if nothing or no text is stored.
fn text_value(conn: &Connection, repo_id: &str, key: &str) -> CoreResult<Option<String>> {
    Ok(get_all(conn, repo_id)?.into_iter().find(|(k, _)| k == key).and_then(|(_, v)| v.as_str().map(str::to_string)))
}

/// Storage key of the key choice: per profile, because the SSH keys belong to a profile,
/// while the repository may belong to several.
fn ssh_key_slot(profile_id: &str) -> String {
    format!("sshKeyId:{profile_id}")
}

/// The SSH key the project chose in the profile (ID from `ssh_keys`).
pub fn repo_ssh_key_id(conn: &Connection, repo_id: &str, profile_id: &str) -> CoreResult<Option<String>> {
    text_value(conn, repo_id, &ssh_key_slot(profile_id))
}

/// Sets (`Some`) or forgets (`None`) the profile's key choice for the repository.
pub fn set_repo_ssh_key_id(conn: &Connection, repo_id: &str, profile_id: &str, key_id: Option<&str>) -> CoreResult<()> {
    match key_id {
        Some(id) => set(conn, repo_id, &ssh_key_slot(profile_id), &Value::String(id.to_string())),
        None => delete(conn, repo_id, &ssh_key_slot(profile_id)),
    }
}

/// Forgets the key choice in all repositories that point to the SSH key `key_id` – when it
/// is removed.
pub fn clear_ssh_key_references(conn: &Connection, key_id: &str) -> CoreResult<()> {
    conn.execute("delete from repo_settings where key like 'sshKeyId:%' and value = json_quote(?1)", [key_id])?;
    Ok(())
}
