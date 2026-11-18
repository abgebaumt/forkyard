//! Proxy passwords: keychain instead of the settings table.

use serde_json::Value;

use crate::app::Core;
use crate::db;
use crate::error::CoreResult;
use crate::git::netconfig;
use crate::model::Settings;

/// Fields holding proxy addresses.
pub(crate) const PROXY_KEYS: [&str; 2] = ["proxyUrl", "proxyByHost"];

enum ProxySecret {
    Set(String),
    Keep,
    Delete,
}

/// What happens to the password of a slot; takes it out of `new` in the process.
fn plan_proxy_secret(old: Option<&str>, new: &mut String) -> ProxySecret {
    let (plain, password) = netconfig::split_proxy_password(new);
    if let Some(password) = password {
        *new = plain;
        return if password.is_empty() { ProxySecret::Delete } else { ProxySecret::Set(password) };
    }
    // Entered without a password (that is how the core returns the address): the remembered one
    // stays as long as the user is the same.
    match (netconfig::proxy_user(new), old.and_then(netconfig::proxy_user)) {
        (Some(now), Some(before)) if now == before => ProxySecret::Keep,
        _ => ProxySecret::Delete,
    }
}

async fn apply_proxy_secret(core: &Core, profile_id: &str, slot: &str, plan: ProxySecret) -> CoreResult<()> {
    let account = netconfig::proxy_secret_account(profile_id, slot);
    match plan {
        ProxySecret::Keep => Ok(()),
        ProxySecret::Set(password) => {
            crate::secrets::set(core, &account, &password).await?;
            core.git.set_proxy_password(profile_id, slot, Some(password));
            Ok(())
        }
        ProxySecret::Delete => {
            crate::secrets::delete(core, &account).await?;
            core.git.set_proxy_password(profile_id, slot, None);
            Ok(())
        }
    }
}

/// Moves the passwords from the proxy addresses in `next` into the keychain and removes
/// the entries of slots that no longer exist. `current` is the state before.
pub(crate) async fn store_proxy_passwords(core: &Core, profile_id: &str, current: &Settings, next: &mut Settings) -> CoreResult<()> {
    let mut plans: Vec<(String, ProxySecret)> = Vec::new();
    match next.proxy_url.as_mut() {
        Some(proxy) => plans.push((netconfig::PROXY_SLOT_GLOBAL.to_string(), plan_proxy_secret(current.proxy_url.as_deref(), proxy))),
        None => plans.push((netconfig::PROXY_SLOT_GLOBAL.to_string(), ProxySecret::Delete)),
    }
    for entry in next.proxy_by_host.iter_mut() {
        let old = current.proxy_by_host.iter().find(|known| known.host == entry.host).map(|known| known.proxy.as_str());
        plans.push((entry.host.clone(), plan_proxy_secret(old, &mut entry.proxy)));
    }
    for gone in current.proxy_by_host.iter().filter(|known| !next.proxy_by_host.iter().any(|entry| entry.host == known.host)) {
        plans.push((gone.host.clone(), ProxySecret::Delete));
    }
    for (slot, plan) in plans {
        apply_proxy_secret(core, profile_id, &slot, plan).await?;
    }
    Ok(())
}

/// The stored proxy addresses of a profile: (slot, address).
fn stored_proxies(stored: &[(String, Value)]) -> Vec<(String, String)> {
    let mut all = Vec::new();
    for (key, value) in stored {
        match key.as_str() {
            "proxyUrl" => {
                if let Some(url) = value.as_str() {
                    all.push((netconfig::PROXY_SLOT_GLOBAL.to_string(), url.to_string()));
                }
            }
            "proxyByHost" => {
                let entries: Vec<crate::model::HostProxy> = serde_json::from_value(value.clone()).unwrap_or_default();
                for entry in entries {
                    if let Ok(host) = netconfig::host_base(&entry.host) {
                        all.push((host, entry.proxy));
                    }
                }
            }
            _ => {}
        }
    }
    all
}

/// At startup: load the proxy passwords of all profiles from the keychain into the cache
/// of the Git runner. The keychain is only asked if there are proxies with user names.
pub async fn load_proxy_passwords(core: &Core) {
    let Ok(profiles) = core.db.with(db::profiles::list) else {
        return;
    };
    for profile in profiles {
        let stored = core.db.with(|c| db::settings::get_all(c, &profile.id)).unwrap_or_default();
        for (slot, url) in stored_proxies(&stored) {
            let needs_password = netconfig::proxy_user(&url).is_some() && netconfig::split_proxy_password(&url).1.is_none();
            if !needs_password {
                continue;
            }
            if let Ok(Some(password)) = crate::secrets::get(core, &netconfig::proxy_secret_account(&profile.id, &slot)).await {
                core.git.set_proxy_password(&profile.id, &slot, Some(password));
            }
        }
    }
}

/// Keychain accounts that belong to a profile (proxy passwords, tokens of the
/// host accounts) – so that deleting the profile takes them along.
pub(crate) fn profile_secret_accounts(core: &Core, profile_id: &str) -> Vec<String> {
    let stored = core.db.with(|c| db::settings::get_all(c, profile_id)).unwrap_or_default();
    let mut accounts: Vec<String> =
        stored_proxies(&stored).into_iter().map(|(slot, _)| netconfig::proxy_secret_account(profile_id, &slot)).collect();
    let hosters = core.db.with(|c| db::hoster_accounts::list(c, profile_id)).unwrap_or_default();
    accounts.extend(hosters.iter().map(|row| crate::host::secret_account(&row.id)));
    accounts
}
