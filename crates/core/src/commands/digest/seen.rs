//! The seen state per profile and repository (`db::repo_seen`): a snapshot of the remote branches
//! and tags at the time the user last looked. Own pushes, deletes and tags move it forward
//! (`absorb`, `absorb_push`), so they never show up as news. App state only: no repository lock.

use std::collections::BTreeMap;

use crate::app::Core;
use crate::commands::refs;
use crate::db::repo_seen::{self, SeenRow};
use crate::error::CoreResult;
use crate::model::{DigestMark, RepoChange};
use crate::util;

/// Remote branches and tags with the object ID as Git stores it (the tag object for annotated
/// tags); symbolic refs like `refs/remotes/origin/HEAD` are left out.
pub(crate) async fn current_refs(core: &Core, repo_id: &str) -> CoreResult<BTreeMap<String, String>> {
    let path = core.repo_path(repo_id)?;
    let options = ["--format=%(refname)%00%(objectname)%00%(symref)%00".to_string()];
    let out = refs::for_each_ref(core, &path, repo_id, &options, &["refs/remotes", "refs/tags"]).await?;
    let mut map = BTreeMap::new();
    for line in out.stdout_lines() {
        let mut parts = line.split(|&b| b == 0);
        let (Some(name), Some(sha), Some(symref)) = (parts.next(), parts.next(), parts.next()) else { continue };
        if symref.is_empty() && !name.is_empty() {
            map.insert(util::decode_lossy(name), util::decode_lossy(sha));
        }
    }
    Ok(map)
}

/// One `ensure` at a time: a second waits and then finds the row (also what lets tests wait for
/// the one `start_background` spawned).
static ENSURING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The stored seen state; without one it is created silently from the current refs.
pub(crate) async fn ensure(core: &Core, repo_id: &str) -> CoreResult<SeenRow> {
    let profile_id = core.active_profile_id()?;
    if let Some(row) = core.db.with(|c| repo_seen::get(c, &profile_id, repo_id))? {
        return Ok(row);
    }
    let _one = ENSURING.lock().await;
    if let Some(row) = core.db.with(|c| repo_seen::get(c, &profile_id, repo_id))? {
        return Ok(row);
    }
    let mut row = SeenRow { seen_at: util::now_iso(), refs: current_refs(core, repo_id).await?, pr_max_number: None, pr_open: Vec::new() };
    // Checked again in the same access: a concurrent `ensure` may have been faster.
    let existing = core.db.with(|c| match repo_seen::get(c, &profile_id, repo_id)? {
        Some(existing) => Ok(Some(existing)),
        None => repo_seen::put(c, &profile_id, repo_id, &row).map(|_| None),
    })?;
    if let Some(existing) = existing {
        return Ok(existing);
    }
    // An own push absorbed before the row existed did nothing, and the first snapshot may predate
    // it: take the refs once more now that the row is there. Only refs that moved in between are
    // taken over, so an `absorb` that ran meanwhile stays.
    let refs = current_refs(core, repo_id).await?;
    let first = row.refs.clone();
    core.db.with(|c| {
        if let Some(mut stored) = repo_seen::get(c, &profile_id, repo_id)? {
            for name in first.keys().chain(refs.keys()) {
                if first.get(name) != refs.get(name) {
                    match refs.get(name) {
                        Some(sha) => stored.refs.insert(name.clone(), sha.clone()),
                        None => stored.refs.remove(name),
                    };
                }
            }
            repo_seen::put(c, &profile_id, repo_id, &stored)?;
            row = stored;
        }
        Ok(row)
    })
}

/// The user has seen what a digest showed: its time, refs and PRs (`None` keeps the stored PR data).
/// A ref whose stored SHA is already what Git has now keeps it: an own push absorbed after the
/// digest was composed must not come back as news.
pub(crate) async fn mark(core: &Core, repo_id: &str, mark: DigestMark) -> CoreResult<()> {
    let profile_id = core.active_profile_id()?;
    let current = current_refs(core, repo_id).await?;
    core.db.with(|c| {
        let stored = repo_seen::get(c, &profile_id, repo_id)?;
        let stored_refs = stored.as_ref().map(|row| row.refs.clone()).unwrap_or_default();
        let mut refs = BTreeMap::new();
        for name in mark.refs.keys().chain(stored_refs.keys()) {
            let kept = stored_refs.get(name).filter(|sha| current.get(name) == Some(sha));
            if let Some(sha) = kept.or_else(|| mark.refs.get(name)) {
                refs.insert(name.clone(), sha.clone());
            }
        }
        let row = SeenRow {
            seen_at: mark.composed_at,
            refs,
            pr_max_number: mark.pr_max_number.or_else(|| stored.as_ref().and_then(|row| row.pr_max_number)),
            pr_open: mark.pr_open.or_else(|| stored.map(|row| row.pr_open)).unwrap_or_default(),
        };
        repo_seen::put(c, &profile_id, repo_id, &row)
    })?;
    core.emit_repo_changed(repo_id, &[RepoChange::Seen]);
    Ok(())
}

/// Takes the current state of `names` (full ref names) into the seen state: the SHA it has now,
/// or out when it is gone. Without a seen state nothing happens; errors are only logged, because
/// the Git step before it has already succeeded.
pub(crate) async fn absorb(core: &Core, repo_id: &str, names: &[String]) {
    absorb_where(core, repo_id, names, |_, _| true).await;
}

/// After an own push: `pushed` are full ref names with the remote's tip before the push as
/// `git push --porcelain` reports it (abbreviated; `None` for a new ref). A remote branch only moves
/// when its seen SHA was that tip: otherwise it still holds foreign commits fetched but not yet
/// seen, and moving it would swallow them (the own commits stay hidden as own). Tags move as in `absorb`.
pub(crate) async fn absorb_push(core: &Core, repo_id: &str, pushed: &[(String, Option<String>)]) {
    let names: Vec<String> = pushed.iter().map(|(name, _)| name.clone()).collect();
    absorb_where(core, repo_id, &names, |name, seen| {
        let before = pushed.iter().find(|(n, _)| n == name).and_then(|(_, before)| before.as_deref());
        !name.starts_with("refs/remotes/")
            || match (seen, before) {
                (None, None) => true,
                (Some(seen), Some(before)) => before.len() >= 4 && seen.starts_with(before),
                _ => false,
            }
    })
    .await;
}

/// `absorb` for the names `moves(name, seen SHA)` allows.
async fn absorb_where(core: &Core, repo_id: &str, names: &[String], moves: impl Fn(&str, Option<&String>) -> bool) {
    let result = async {
        let profile_id = core.active_profile_id()?;
        if core.db.with(|c| repo_seen::get(c, &profile_id, repo_id))?.is_none() {
            return Ok(());
        }
        let current = current_refs(core, repo_id).await?;
        core.db.with(|c| {
            let Some(mut row) = repo_seen::get(c, &profile_id, repo_id)? else { return Ok(()) };
            let moving: Vec<&String> = names.iter().filter(|name| moves(name, row.refs.get(*name))).collect();
            for name in moving {
                match current.get(name) {
                    Some(sha) => row.refs.insert(name.clone(), sha.clone()),
                    None => row.refs.remove(name),
                };
            }
            repo_seen::put(c, &profile_id, repo_id, &row)
        })
    }
    .await;
    if let Err(e) = result {
        log::warn!("Seen state of {repo_id} not updated: {}", e.message);
    }
}
