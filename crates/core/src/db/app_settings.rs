//! Table `app_settings`: global settings, the same for all profiles. Keys are the field
//! names of `Settings` in camelCase, values are JSON. All other fields belong to the profile
//! (table `settings`).

use rusqlite::{params, Connection};
use serde_json::Value;

use crate::error::CoreResult;
use crate::util;

/// Fields of `Settings` that apply globally. Network (proxy, certificates) deliberately belongs to
/// the profile: a company proxy only applies in the "Work" profile.
pub const GLOBAL_KEYS: [&str; 26] = [
    "theme",
    "zoom",
    "dateFormat",
    "showInitials",
    "toolbarLabels",
    "diffMode",
    "diffWordWrap",
    "diffIgnoreWhitespace",
    "editorFontSize",
    "editorTabSize",
    "externalEditor",
    "externalTerminal",
    "externalDiffTool",
    "externalMergeTool",
    "notifyOnFetch",
    "notifyOnError",
    "checkForUpdates",
    // AI (v1.2): one provider and one key for all profiles (Entscheidung 1).
    "aiEnabled",
    "aiProvider",
    "aiModel",
    "aiBaseUrl",
    "aiFeaturesOff",
    "aiExclude",
    "aiConfirmCostUsd",
    "aiMonthlyLimitUsd",
    "aiPrices",
];

pub fn is_global(key: &str) -> bool {
    GLOBAL_KEYS.contains(&key)
}

pub fn get_all(conn: &Connection) -> CoreResult<Vec<(String, Value)>> {
    let mut stmt = conn.prepare("select key, value from app_settings")?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows.into_iter().filter_map(|(k, v)| serde_json::from_str(&v).ok().map(|v| (k, v))).collect())
}

pub fn set(conn: &Connection, key: &str, value: &Value) -> CoreResult<()> {
    conn.execute(
        "insert into app_settings (key, value, updated_at) values (?1, ?2, ?3)
         on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at",
        params![key, value.to_string(), util::now_iso()],
    )?;
    Ok(())
}

/// Removes a key (no error if it is not there).
pub fn delete(conn: &Connection, key: &str) -> CoreResult<()> {
    conn.execute("delete from app_settings where key = ?1", [key])?;
    Ok(())
}
