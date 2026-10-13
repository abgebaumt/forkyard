//! Table `repositories`: path, alias and colour are shared by all profiles. Favourite, group
//! and last opening are stored per profile in `profile_repositories`; the rows here show
//! them for the active profile.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension, Row};

use super::int_bool;
use crate::error::{CoreError, CoreResult};
use crate::model::Repo;
use crate::util;

/// Row without the computed field `missing`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoRow {
    pub id: String,
    pub path: String,
    pub alias: Option<String>,
    pub is_favorite: bool,
    pub group_name: Option<String>,
    pub color: Option<u8>,
    pub last_opened_at: Option<String>,
    /// Git may work in this folder (see `commands::trust`).
    pub trusted: bool,
}

impl RepoRow {
    /// Folder name as display name.
    pub fn folder_name(&self) -> String {
        Path::new(&self.path)
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| self.path.clone())
    }

    /// Alias or folder name.
    pub fn title(&self) -> String {
        self.alias.clone().filter(|a| !a.trim().is_empty()).unwrap_or_else(|| self.folder_name())
    }

    /// Model for the UI; `missing` is checked against the file system.
    pub fn to_model(&self) -> Repo {
        Repo {
            id: self.id.clone(),
            path: self.path.clone(),
            name: self.folder_name(),
            alias: self.alias.clone(),
            is_favorite: self.is_favorite,
            group_name: self.group_name.clone(),
            color: self.color,
            last_opened_at: self.last_opened_at.clone(),
            missing: is_missing(Path::new(&self.path)),
            trusted: self.trusted,
        }
    }
}

/// The folder is missing or no longer has a `.git` (folder, or file for worktrees).
pub fn is_missing(path: &Path) -> bool {
    !path.is_dir() || !path.join(".git").exists()
}

fn from_row(r: &Row) -> rusqlite::Result<RepoRow> {
    let color: Option<String> = r.get("color")?;
    Ok(RepoRow {
        id: r.get("id")?,
        path: r.get("path")?,
        alias: r.get("alias")?,
        is_favorite: int_bool(r.get("is_favorite")?),
        group_name: r.get("group_name")?,
        color: color.and_then(|c| c.parse::<u8>().ok()),
        last_opened_at: r.get("last_opened_at")?,
        trusted: int_bool(r.get("trusted")?),
    })
}

const COLUMNS: &str = "r.id, r.path, r.alias, coalesce(pr.is_favorite, 0) as is_favorite, pr.group_name, r.color, pr.last_opened_at, \
     exists (select 1 from repository_trust t where t.repository_id = r.id) as trusted";

/// Repositories with the details of the active profile (no entry there: no favourite, no group).
const FROM: &str = "repositories r left join profile_repositories pr \
     on pr.repository_id = r.id and pr.profile_id = (select id from profiles where is_active = 1)";

/// The repositories of the active profile: most recently opened first, never opened ones at the end by path.
pub fn list(conn: &Connection) -> CoreResult<Vec<RepoRow>> {
    let mut stmt = conn.prepare(&format!(
        "select {COLUMNS} from {FROM} where pr.repository_id is not null \
         order by pr.last_opened_at is null, pr.last_opened_at desc, r.path"
    ))?;
    let rows = stmt.query_map([], from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// All known repositories, regardless of which profile lists them (by path).
pub fn list_all(conn: &Connection) -> CoreResult<Vec<RepoRow>> {
    let mut stmt = conn.prepare(&format!("select {COLUMNS} from {FROM} order by r.path"))?;
    let rows = stmt.query_map([], from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, id: &str) -> CoreResult<Option<RepoRow>> {
    Ok(conn.query_row(&format!("select {COLUMNS} from {FROM} where r.id = ?1"), [id], from_row).optional()?)
}

/// Like `get`, but `not_found` if the ID does not exist.
pub fn require(conn: &Connection, id: &str) -> CoreResult<RepoRow> {
    get(conn, id)?.ok_or_else(|| CoreError::not_found("The repository is no longer in the list."))
}

pub fn find_by_path(conn: &Connection, path: &Path) -> CoreResult<Option<RepoRow>> {
    let key = util::path_key(path);
    Ok(conn
        .query_row(&format!("select {COLUMNS} from {FROM} where r.path_key = ?1"), [key], from_row)
        .optional()?)
}

/// Adds a repository or returns the existing one (same `path_key`).
/// The stored path is updated to `path`.
pub fn upsert(conn: &Connection, path: &Path) -> CoreResult<RepoRow> {
    let key = util::path_key(path);
    let display = util::display_path(path);
    let now = util::now_iso();
    if let Some(existing) = find_by_path(conn, path)? {
        conn.execute("update repositories set path = ?2, updated_at = ?3 where id = ?1", params![existing.id, display, now])?;
        return require(conn, &existing.id);
    }
    let id = util::new_id();
    conn.execute(
        "insert into repositories (id, path, path_key, created_at, updated_at) values (?1, ?2, ?3, ?4, ?4)",
        params![id, display, key, now],
    )?;
    require(conn, &id)
}

/// Records the opening in the active profile (and adds the repository there).
pub fn touch_opened(conn: &Connection, id: &str) -> CoreResult<()> {
    let profile_id = super::profiles::active_id(conn)?;
    super::profile_repos::touch_opened(conn, &profile_id, id)
}

/// Changes fields; `None` leaves a field unchanged, `Some(None)` clears it.
pub fn update(
    conn: &Connection,
    id: &str,
    alias: Option<Option<String>>,
    is_favorite: Option<bool>,
    group_name: Option<Option<String>>,
    color: Option<Option<u8>>,
) -> CoreResult<RepoRow> {
    let now = util::now_iso();
    if let Some(alias) = alias {
        conn.execute("update repositories set alias = ?2, updated_at = ?3 where id = ?1", params![id, alias, now])?;
    }
    if is_favorite.is_some() || group_name.is_some() {
        let profile_id = super::profiles::active_id(conn)?;
        super::profile_repos::update(conn, &profile_id, id, is_favorite, group_name)?;
    }
    if let Some(color) = color {
        let text = color.map(|c| c.to_string());
        conn.execute("update repositories set color = ?2, updated_at = ?3 where id = ?1", params![id, text, now])?;
    }
    require(conn, id)
}

/// Deletes the entry; tabs, view state, drafts etc. go with it via cascade.
pub fn delete(conn: &Connection, id: &str) -> CoreResult<()> {
    conn.execute("delete from repositories where id = ?1", [id])?;
    Ok(())
}

/// Records (or forgets) that Git may work in this repository.
pub fn set_trusted(conn: &Connection, id: &str, trusted: bool) -> CoreResult<()> {
    if trusted {
        conn.execute("insert or ignore into repository_trust (repository_id) values (?1)", [id])?;
    } else {
        conn.execute("delete from repository_trust where repository_id = ?1", [id])?;
    }
    Ok(())
}
