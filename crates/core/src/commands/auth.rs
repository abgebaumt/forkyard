//! SSH keys and credentials.
//!
//! - `broker`: relays prompts from Git and SSH (helper program ↔ UI),
//!   hooked into the Git runner via `.network()`.
//! - `prompt`: recognises the kind of a prompt.
//! - `keychain`: the operating system's keychain.
//! - `ssh`: key files and ssh-keygen.
//!
//! For other parts of the core:
//! - `core.git_for(..)?.network()` asks through the UI when needed;
//!   `.network().no_prompt()` never asks (auto-fetch).
//! - `configure(core, |c| …)` redirects the SSH folder, keychain and helper program (tests).
//! - `forget_profile_credentials` / `purge_keychain_entries` clean up the keychain.

pub mod broker;
pub mod keychain;
#[cfg(target_os = "linux")]
mod secret_service;
pub mod prompt;
pub mod ssh;

use std::path::{Path, PathBuf};

pub use broker::{AuthConfig, Broker, Session, SessionMode};

use crate::app::Core;
use crate::db;
use crate::db::host_accounts::HostAccountRow;
use crate::db::ssh_keys::SshKeyRow;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::model::{AppChange, HostAccount, SshKey};
use crate::util;

/// Changes the credential and SSH settings of this core (SSH folder, service name in the
/// keychain, path of the helper program, timeout for prompts).
pub fn configure(core: &Core, change: impl FnOnce(&mut AuthConfig)) {
    core.git.broker().configure(change);
}

/// Deletes all remembered credentials of a profile from the keychain and the index.
pub async fn forget_profile_credentials(core: &Core, profile_id: &str) -> CoreResult<u32> {
    core.git.broker().forget_profile(profile_id).await
}

/// Deletes the keychain entries for rows that have already been removed from `host_accounts`
/// (e.g. by deleting a profile); returns the count.
pub async fn purge_keychain_entries(core: &Core, rows: &[HostAccountRow]) -> u32 {
    core.git.broker().purge_keychain(rows).await
}

fn file_not_found(path: &Path) -> CoreError {
    CoreError::new(ErrorCode::PathNotFound, format!("The file “{}” was not found.", util::display_path(path)))
}

fn check_label(label: &str) -> CoreResult<String> {
    let label = label.trim();
    if label.is_empty() {
        return Err(CoreError::invalid_name("The key label must not be empty."));
    }
    if label.chars().count() > 100 || label.chars().any(char::is_control) {
        return Err(CoreError::invalid_name("The key label is too long or contains control characters."));
    }
    Ok(label.to_string())
}

fn key_rows(core: &Core) -> CoreResult<(String, Vec<SshKeyRow>)> {
    core.db.with(|c| {
        let profile_id = db::profiles::active_id(c)?;
        let rows = db::ssh_keys::list(c, &profile_id)?;
        Ok((profile_id, rows))
    })
}

fn ensure_not_registered(rows: &[SshKeyRow], private: &Path) -> CoreResult<()> {
    let key = util::path_key(private);
    if rows.iter().any(|r| util::path_key(Path::new(&r.private_key_path)) == key) {
        return Err(CoreError::name_exists(format!(
            "The key “{}” is already registered.",
            util::display_path(private)
        )));
    }
    Ok(())
}

async fn to_model(core: &Core, row: SshKeyRow, keygen: Option<&Path>) -> SshKey {
    let private = PathBuf::from(&row.private_key_path);
    let public = PathBuf::from(&row.public_key_path);
    let public_key = ssh::read_public_key(&public);
    let missing = !private.is_file() || !public.is_file();
    let fingerprint = match keygen {
        Some(keygen) if !public_key.is_empty() => {
            let broker = core.git.broker();
            let cached = broker.fingerprints.lock().get(&public_key).cloned();
            match cached {
                Some(fingerprint) => fingerprint,
                None => {
                    let fingerprint = ssh::fingerprint(keygen, &public).await;
                    broker.fingerprints.lock().insert(public_key.clone(), fingerprint.clone());
                    fingerprint
                }
            }
        }
        _ => None,
    };
    let has_passphrase = ssh::has_passphrase(keygen, &private).await;
    SshKey {
        id: row.id,
        label: row.label,
        private_key_path: row.private_key_path,
        public_key_path: row.public_key_path,
        public_key,
        fingerprint,
        has_passphrase,
        is_default: row.is_default,
        missing,
    }
}

/// SSH keys of the active profile.
pub async fn ssh_key_list(core: &Core) -> CoreResult<Vec<SshKey>> {
    let (_, rows) = key_rows(core)?;
    let keygen = ssh::find_ssh_keygen(&core.git.broker().config(), core.git_found().as_ref()).ok();
    let mut keys = Vec::with_capacity(rows.len());
    for row in rows {
        keys.push(to_model(core, row, keygen.as_deref()).await);
    }
    Ok(keys)
}

/// Generates an ed25519 pair in the user's SSH folder.
pub async fn ssh_key_generate(core: &Core, label: String, file_name: String, passphrase: Option<String>) -> CoreResult<Vec<SshKey>> {
    let label = check_label(&label)?;
    let file_name = ssh::check_file_name(&file_name)?;
    let passphrase = passphrase.filter(|p| !p.is_empty());
    if passphrase.as_ref().is_some_and(|p| p.len() < ssh::MIN_PASSPHRASE_LEN) {
        return Err(CoreError::not_allowed(format!(
            "The passphrase must be at least {} characters long (or empty).",
            ssh::MIN_PASSPHRASE_LEN
        )));
    }
    let broker = core.git.broker();
    let config = broker.config();
    let dir = ssh::ssh_dir(&config)?;
    let private = dir.join(&file_name);
    let public = ssh::public_path_for(&private);
    for path in [&private, &public] {
        // symlink_metadata: a dangling link also occupies the name.
        if std::fs::symlink_metadata(path).is_ok() {
            return Err(CoreError::path_exists(util::display_path(path)));
        }
    }
    let (profile_id, rows) = key_rows(core)?;
    ensure_not_registered(&rows, &private)?;
    let keygen = ssh::find_ssh_keygen(&config, core.git_found().as_ref())?;

    std::fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // ssh requires that the folder belongs only to the user.
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    let email = core.db.with(db::profiles::active)?.author_email;
    let comment = if email.trim().is_empty() { label.clone() } else { email.trim().to_string() };
    ssh::generate(broker, &keygen, &private, &comment, passphrase.as_deref()).await?;

    core.db.with(|c| db::ssh_keys::insert(c, &profile_id, &label, &util::display_path(&private), &util::display_path(&public)))?;
    core.emit_app_changed(&[AppChange::SshKeys]);
    ssh_key_list(core).await
}

/// Registers an existing key.
pub async fn ssh_key_import(core: &Core, label: String, private_key_path: String, public_key_path: Option<String>) -> CoreResult<Vec<SshKey>> {
    let label = check_label(&label)?;
    let private = PathBuf::from(private_key_path.trim());
    if !private.is_absolute() || !private.is_file() {
        return Err(file_not_found(&private));
    }
    if !ssh::looks_like_private_key(&private) {
        return Err(CoreError::not_allowed(format!(
            "“{}” is not a private SSH key.",
            util::display_path(&private)
        )));
    }
    let public = match util::non_empty(public_key_path.map(|p| p.trim().to_string())) {
        Some(path) => {
            let path = PathBuf::from(path);
            if !path.is_absolute() || !path.is_file() {
                return Err(file_not_found(&path));
            }
            path
        }
        None => {
            let beside = ssh::public_path_for(&private);
            if !beside.is_file() {
                return Err(CoreError::new(
                    ErrorCode::PathNotFound,
                    format!(
                        "There is no file “{}” next to the key. Select the file with the public key.",
                        util::display_path(&beside)
                    ),
                ));
            }
            beside
        }
    };
    let public_key = ssh::read_public_key(&public);
    if public_key.is_empty() || public_key.contains("PRIVATE KEY") || public_key.lines().count() > 1 {
        return Err(CoreError::not_allowed(format!(
            "“{}” is not a public SSH key.",
            util::display_path(&public)
        )));
    }
    let (profile_id, rows) = key_rows(core)?;
    ensure_not_registered(&rows, &private)?;
    core.db.with(|c| db::ssh_keys::insert(c, &profile_id, &label, &util::display_path(&private), &util::display_path(&public)))?;
    core.emit_app_changed(&[AppChange::SshKeys]);
    ssh_key_list(core).await
}

/// Removes the entry; the files stay where they are.
pub async fn ssh_key_remove(core: &Core, id: String) -> CoreResult<Vec<SshKey>> {
    core.db.tx(|tx| {
        let profile_id = db::profiles::active_id(tx)?;
        if db::ssh_keys::get(tx, &profile_id, &id)?.is_none() {
            return Err(CoreError::not_found("The key is not registered (anymore)."));
        }
        db::ssh_keys::delete(tx, &profile_id, &id)?;
        // Projects that had chosen exactly this key follow the profile again.
        db::repo_settings::clear_ssh_key_references(tx, &id)
    })?;
    core.emit_app_changed(&[AppChange::SshKeys]);
    ssh_key_list(core).await
}

/// Sets the default key (`id: None` = none).
pub async fn ssh_key_set_default(core: &Core, id: Option<String>) -> CoreResult<Vec<SshKey>> {
    core.db.tx(|tx| {
        let profile_id = db::profiles::active_id(tx)?;
        if let Some(id) = &id {
            if db::ssh_keys::get(tx, &profile_id, id)?.is_none() {
                return Err(CoreError::not_found("The key is not registered (anymore)."));
            }
        }
        db::ssh_keys::set_default(tx, &profile_id, id.as_deref())
    })?;
    core.emit_app_changed(&[AppChange::SshKeys]);
    ssh_key_list(core).await
}

/// Answer to a `credential:request`; `value: None` cancels.
///
/// For a host key question only the value `"yes"` accepts the key; anything else rejects it.
/// `remember` stores the password or passphrase in the keychain once the Git call has
/// succeeded. An answer to an expired prompt yields `not_found`; a cancel (`None`) is not an
/// error then.
pub async fn credential_answer(core: &Core, request_id: String, value: Option<String>, remember: bool) -> CoreResult<()> {
    core.git.broker().answer(&request_id, value, remember)
}

/// Remembered keychain entries (without the secret).
pub async fn credentials_list(core: &Core) -> CoreResult<Vec<HostAccount>> {
    core.git.broker().accounts()
}

/// Deletes all remembered credentials; returns the count.
pub async fn credentials_forget_all(core: &Core) -> CoreResult<u32> {
    let profile_id = core.active_profile_id()?;
    forget_profile_credentials(core, &profile_id).await
}

#[cfg(test)]
mod tests;
