//! "What's new": what happened in a repository in the last 24 hours.

mod compose;
mod prs;
pub(crate) mod seen;

pub(crate) use compose::compose;

/// The window of the digest.
pub(crate) const WINDOW_HOURS: i64 = 24;

use crate::app::Core;
use crate::db::repo_seen;
use crate::error::CoreResult;
use crate::model::Digest;

/// One answer at a time: two windows asking after the same fetch must not both find the refs changed.
static ONE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// What happened in the last 24 hours. Every answer records the remote refs it was based on
/// (`seen`). With `if_changed` (the check after a fetch) the answer is `None`, before any
/// other Git work, while the remote refs are what the last shown digest was based on, and also
/// when there is nothing new in the window.
pub async fn digest_get(core: &Core, repo_id: String, if_changed: Option<bool>) -> CoreResult<Option<Digest>> {
    let _one = ONE.lock().await;
    let profile_id = core.active_profile_id()?;
    // Read before composing: a fetch meanwhile counts as changed next time.
    let current = seen::current_refs(core, &repo_id).await?;
    if if_changed == Some(true) {
        let stored = core.db.with(|c| repo_seen::get(c, &profile_id, &repo_id))?;
        if stored.map_or(true, |row| row.refs == current) {
            return Ok(None);
        }
    }
    let digest = compose(core, &repo_id, chrono::Utc::now() - chrono::Duration::hours(WINDOW_HOURS)).await?;
    seen::store(core, &repo_id, current).await?;
    Ok((!(digest.is_empty && if_changed == Some(true))).then_some(digest))
}

#[cfg(test)]
mod tests;
