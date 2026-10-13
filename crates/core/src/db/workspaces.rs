//! Tables `workspaces` and `workspace_repositories`: named groups of repositories
//! per profile. The order of the repositories is stored in `position`.

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::{CoreError, CoreResult};
use crate::model::Workspace;
use crate::util;

fn repo_ids(conn: &Connection, workspace_id: &str) -> CoreResult<Vec<String>> {
    let mut stmt = conn.prepare("select repository_id from workspace_repositories where workspace_id = ?1 order by position, repository_id")?;
    let ids = stmt.query_map([workspace_id], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(ids)
}

/// All workspaces of the profile, by name.
pub fn list(conn: &Connection, profile_id: &str) -> CoreResult<Vec<Workspace>> {
    let mut stmt = conn.prepare("select id, name from workspaces where profile_id = ?1 order by name collate nocase, id")?;
    let rows = stmt
        .query_map([profile_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter().map(|(id, name)| Ok(Workspace { repo_ids: repo_ids(conn, &id)?, id, name })).collect()
}

pub fn get(conn: &Connection, profile_id: &str, id: &str) -> CoreResult<Option<Workspace>> {
    let name: Option<String> = conn
        .query_row("select name from workspaces where profile_id = ?1 and id = ?2", params![profile_id, id], |r| r.get(0))
        .optional()?;
    match name {
        Some(name) => Ok(Some(Workspace { id: id.to_string(), name, repo_ids: repo_ids(conn, id)? })),
        None => Ok(None),
    }
}

/// Creates a workspace (`id: None`) or replaces name and repositories of an existing one.
/// Call inside a transaction. Errors: `not_found` (workspace or a repository
/// unknown), `name_exists`.
pub fn save(conn: &Connection, profile_id: &str, id: Option<&str>, name: &str, repo_ids: &[String]) -> CoreResult<String> {
    let taken = |e: rusqlite::Error| {
        if super::is_unique_violation(&e) {
            CoreError::name_exists(format!("A workspace named “{name}” already exists."))
        } else {
            e.into()
        }
    };
    let id = match id {
        Some(id) => {
            let changed = conn
                .execute(
                    "update workspaces set name = ?3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where profile_id = ?1 and id = ?2",
                    params![profile_id, id, name],
                )
                .map_err(taken)?;
            if changed == 0 {
                return Err(CoreError::not_found("This workspace no longer exists."));
            }
            id.to_string()
        }
        None => {
            let id = util::new_id();
            conn.execute("insert into workspaces (id, profile_id, name) values (?1, ?2, ?3)", params![id, profile_id, name]).map_err(taken)?;
            id
        }
    };
    conn.execute("delete from workspace_repositories where workspace_id = ?1", [&id])?;
    for (position, repo_id) in repo_ids.iter().enumerate() {
        conn.execute(
            "insert into workspace_repositories (workspace_id, repository_id, position) values (?1, ?2, ?3)",
            params![id, repo_id, position as i64],
        )
        .map_err(|e| {
            if super::is_foreign_key_violation(&e) {
                CoreError::not_found("One of the selected repositories is no longer in the repository list.")
            } else {
                e.into()
            }
        })?;
    }
    Ok(id)
}

/// `false` if the workspace did not exist.
/// Removes the repository from all workspaces of the profile.
pub fn remove_repo(conn: &Connection, profile_id: &str, repo_id: &str) -> CoreResult<()> {
    conn.execute(
        "delete from workspace_repositories where repository_id = ?2
         and workspace_id in (select id from workspaces where profile_id = ?1)",
        params![profile_id, repo_id],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, profile_id: &str, id: &str) -> CoreResult<bool> {
    Ok(conn.execute("delete from workspaces where profile_id = ?1 and id = ?2", params![profile_id, id])? > 0)
}
