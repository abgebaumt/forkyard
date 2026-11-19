//! Profiles: name, identity and their own settings, repo lists and credentials.

use crate::app::Core;
use crate::commands::settings::proxy_secrets::profile_secret_accounts;
use crate::db;
use crate::error::{CoreError, CoreResult};
use crate::model::{AppChange, Profile};

pub(crate) fn looks_like_email(email: &str) -> bool {
    let email = email.trim();
    match email.split_once('@') {
        Some((local, domain)) => !local.is_empty() && !domain.is_empty() && !email.chars().any(char::is_whitespace),
        None => false,
    }
}

/// Writes name and email into the global gitconfig (empty values are skipped).
async fn write_global_identity(core: &Core, name: &str, email: &str) -> CoreResult<()> {
    let cwd = core.data_dir().to_path_buf();
    for (key, value) in [("user.name", name), ("user.email", email)] {
        if !value.trim().is_empty() {
            core.git_at(&cwd).args(["config", "--global", key, value.trim()]).run().await?;
        }
    }
    Ok(())
}

pub async fn profile_list(core: &Core) -> CoreResult<Vec<Profile>> {
    core.db.with(db::profiles::list)
}

/// Creates a profile (`id: None`) or changes it. With `sync_gitconfig` and an active
/// profile, name and email are written into the global gitconfig.
pub async fn profile_save(
    core: &Core,
    id: Option<String>,
    name: String,
    author_name: String,
    author_email: String,
    sync_gitconfig: bool,
    color: Option<u8>,
) -> CoreResult<Vec<Profile>> {
    if let Some(c) = color {
        if !(1..=8).contains(&c) {
            return Err(CoreError::not_allowed("The color must be between 1 and 8."));
        }
    }
    let name = name.trim().to_string();
    let author_name = author_name.trim().to_string();
    let author_email = author_email.trim().to_string();
    if name.is_empty() {
        return Err(CoreError::invalid_name("The profile name must not be empty."));
    }
    if !author_email.is_empty() && !looks_like_email(&author_email) {
        return Err(CoreError::not_allowed("The email address is invalid."));
    }
    let saved_id = core.db.tx(|tx| {
        if db::profiles::name_taken(tx, &name, id.as_deref())? {
            return Err(CoreError::name_exists(format!("A profile named “{name}” already exists.")));
        }
        let saved = match &id {
            Some(id) => {
                db::profiles::update(tx, id, &name, &author_name, &author_email, sync_gitconfig)?;
                id.clone()
            }
            None => db::profiles::insert(tx, &name, &author_name, &author_email, sync_gitconfig)?,
        };
        db::profiles::set_color(tx, &saved, color)?;
        Ok(saved)
    })?;
    let profile = core.db.with(|c| db::profiles::get(c, &saved_id))?;
    // The DB change is final: announce it first, report an identity-write error afterwards.
    let synced = match &profile {
        Some(p) if p.is_active && p.sync_gitconfig => write_global_identity(core, &p.author_name, &p.author_email).await,
        _ => Ok(()),
    };
    core.emit_app_changed(&[AppChange::Profiles]);
    synced.map_err(|e| CoreError::io(format!("Saved “{name}”, but the global Git identity couldn't be written: {}", e.message)))?;
    profile_list(core).await
}

/// Deletes a profile including its settings and tabs. Not the active one and not the last one.
pub async fn profile_delete(core: &Core, id: String) -> CoreResult<Vec<Profile>> {
    let secret_accounts = profile_secret_accounts(core, &id);
    let accounts = core.db.tx(|tx| {
        let profile = db::profiles::get(tx, &id)?.ok_or_else(|| CoreError::not_found("Profile not found."))?;
        if db::profiles::count(tx)? <= 1 {
            return Err(CoreError::not_allowed("The last profile can't be deleted."));
        }
        if profile.is_active {
            return Err(CoreError::not_allowed("The active profile can't be deleted. Activate another one first."));
        }
        // The rows disappear by cascade; their keychain entries must go afterwards as well.
        let accounts = db::credentials::list(tx, &id)?;
        db::profiles::delete(tx, &id)?;
        // Repositories that only this profile listed go as well.
        db::profile_repos::delete_orphans(tx)?;
        Ok(accounts)
    })?;
    crate::commands::auth::purge_keychain_entries(core, &accounts).await;
    for account in &secret_accounts {
        if let Err(e) = crate::secrets::delete(core, account).await {
            log::warn!("An entry of the deleted profile remained in the keychain: {}", e.message);
        }
    }
    core.emit_app_changed(&[AppChange::Profiles, AppChange::Repos]);
    profile_list(core).await
}

/// Switches the active profile (own tabs and settings); with `sync_gitconfig`
/// the identity is written into the global gitconfig. Refused (`not_allowed`) while another window
/// reports something to lose: the switch closes it without asking.
pub async fn profile_activate(core: &Core, id: String) -> CoreResult<Vec<Profile>> {
    let caller = crate::commands::window::calling_window(core);
    let (old_tabs, new_repos, windows, profile) = core.db.tx(|tx| {
        let old = db::profiles::active_id(tx)?;
        // The other windows close without their close guard: their unsaved work would be gone unasked.
        if old != id && core.state::<crate::commands::app::CloseGuard>().active_elsewhere(&caller) > 0 {
            return Err(CoreError::not_allowed(
                "Another window has unsaved work or a running action. Save, finish or close it there first, then switch profiles.",
            ));
        }
        crate::commands::window::save_all_geometry(core, tx, &old)?;
        let old_tabs = db::tabs::list_all(tx, &old)?;
        db::profiles::set_active(tx, &id)?;
        // Renaming windows is safe only while none of them is open: not when re-activating the active profile.
        if old != id {
            db::windows::ensure(tx, &id)?;
        }
        db::tabs::ensure_all(tx, &id)?;
        let new_repos = db::tabs::open_repo_ids(tx, &id)?;
        let windows = db::windows::list(tx, &id)?;
        let profile = db::profiles::get(tx, &id)?.ok_or_else(|| CoreError::not_found("Profile not found."))?;
        Ok((old_tabs, new_repos, windows, profile))
    })?;
    crate::commands::window::forget_geometry(core);
    core.events.sync_windows(&windows, true);
    for tabs in old_tabs.chunk_by(|a, b| a.window == b.window) {
        crate::commands::window::tabs_left(core, &tabs[0].window, tabs);
    }
    for repo_id in &new_repos {
        crate::commands::repos::start_background(core, repo_id);
    }
    let synced =
        if profile.sync_gitconfig { write_global_identity(core, &profile.author_name, &profile.author_email).await } else { Ok(()) };
    core.emit_app_changed(&[
        AppChange::Profiles,
        AppChange::Settings,
        AppChange::Tabs,
        AppChange::Credentials,
        AppChange::SshKeys,
        AppChange::Windows,
    ]);
    synced.map_err(|e| {
        CoreError::io(format!("Switched to “{}”, but the global Git identity couldn't be written: {}", profile.name, e.message))
    })?;
    profile_list(core).await
}

#[cfg(test)]
mod tests;
