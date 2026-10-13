//! Table `profile_repositories`: which repositories a profile lists, with favourite, group
//! and time of last opening per profile.

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::CoreResult;
use crate::util;

pub fn add(conn: &Connection, profile_id: &str, repo_id: &str) -> CoreResult<()> {
    conn.execute(
        "insert or ignore into profile_repositories (profile_id, repository_id) values (?1, ?2)",
        params![profile_id, repo_id],
    )?;
    Ok(())
}

pub fn remove(conn: &Connection, profile_id: &str, repo_id: &str) -> CoreResult<()> {
    conn.execute("delete from profile_repositories where profile_id = ?1 and repository_id = ?2", params![profile_id, repo_id])?;
    Ok(())
}

pub fn contains(conn: &Connection, profile_id: &str, repo_id: &str) -> CoreResult<bool> {
    Ok(conn
        .query_row(
            "select 1 from profile_repositories where profile_id = ?1 and repository_id = ?2",
            params![profile_id, repo_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

/// IDs of the profiles that list the repository (in the order of the profile list).
pub fn profiles_of(conn: &Connection, repo_id: &str) -> CoreResult<Vec<String>> {
    let mut stmt = conn.prepare(
        "select pr.profile_id from profile_repositories pr join profiles p on p.id = pr.profile_id
         where pr.repository_id = ?1 order by p.created_at, p.name",
    )?;
    let rows = stmt.query_map([repo_id], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Adds the repository to the profile (if necessary) and records the time of opening.
pub fn touch_opened(conn: &Connection, profile_id: &str, repo_id: &str) -> CoreResult<()> {
    add(conn, profile_id, repo_id)?;
    conn.execute(
        "update profile_repositories set last_opened_at = ?3 where profile_id = ?1 and repository_id = ?2",
        params![profile_id, repo_id, util::now_iso()],
    )?;
    Ok(())
}

/// Favourite and group in the profile; `None` leaves a field unchanged, `Some(None)` clears the group.
pub fn update(conn: &Connection, profile_id: &str, repo_id: &str, is_favorite: Option<bool>, group_name: Option<Option<String>>) -> CoreResult<()> {
    // Only repos of the own list; adding it on the side would make it show up in another profile.
    if !contains(conn, profile_id, repo_id)? {
        return Err(crate::error::CoreError::not_found("The repository is not in this profile’s list."));
    }
    if let Some(fav) = is_favorite {
        conn.execute(
            "update profile_repositories set is_favorite = ?3 where profile_id = ?1 and repository_id = ?2",
            params![profile_id, repo_id, fav as i64],
        )?;
    }
    if let Some(group) = group_name {
        conn.execute(
            "update profile_repositories set group_name = ?3 where profile_id = ?1 and repository_id = ?2",
            params![profile_id, repo_id, group],
        )?;
    }
    Ok(())
}

/// Deletes repositories that no profile lists any more (including trust and view state via cascade).
pub fn delete_orphans(conn: &Connection) -> CoreResult<usize> {
    Ok(conn.execute(
        "delete from repositories where id not in (select repository_id from profile_repositories)",
        [],
    )?)
}

