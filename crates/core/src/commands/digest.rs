//! "What's new since …": what changed in a repository since the user last looked.

mod compose;
mod prs;
pub(crate) mod seen;

use compose::compose_at;

use crate::app::Core;
use crate::db::repo_seen;
use crate::error::CoreResult;
use crate::model::Digest;

/// What changed since the seen state. With `min_age_hours`, `None` while the seen state is younger,
/// before any Git work (auto-fetch asks every minute). Without a seen state one is created and the
/// digest is empty. A pure read: no lock.
pub async fn digest_get(core: &Core, repo_id: String, min_age_hours: Option<u32>) -> CoreResult<Option<Digest>> {
    let profile_id = core.active_profile_id()?;
    let stored = core.db.with(|c| repo_seen::get(c, &profile_id, &repo_id))?;
    let (row, fresh) = match stored {
        Some(row) => (row, false),
        None => (seen::ensure(core, &repo_id).await?, true),
    };
    if let Some(hours) = min_age_hours {
        let young = chrono::DateTime::parse_from_rfc3339(&row.seen_at)
            .is_ok_and(|at| chrono::Utc::now().signed_duration_since(at) < chrono::Duration::hours(i64::from(hours)));
        if young {
            return Ok(None);
        }
    }
    if fresh {
        return Ok(Some(Digest {
            seen_at: row.seen_at,
            refs: Vec::new(),
            new_commits: 0,
            your_files: Vec::new(),
            behind: None,
            prs: None,
            pr_data_missing: None,
            pr_max_number: row.pr_max_number,
            is_empty: true,
        }));
    }
    compose_at(core, &repo_id, &row).await.map(Some)
}

/// The user has seen everything up to now. `pr_max_number` comes from the digest the card showed;
/// `None` keeps the stored one.
pub async fn digest_mark_seen(core: &Core, repo_id: String, pr_max_number: Option<u64>) -> CoreResult<()> {
    seen::mark(core, &repo_id, pr_max_number).await
}

#[cfg(test)]
mod tests;
