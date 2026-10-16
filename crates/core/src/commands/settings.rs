//! Settings (global, per profile and per repository) and profiles.

use std::collections::BTreeMap;

use serde_json::{Map, Value};

use crate::app::Core;
use crate::db;
use crate::error::{CoreError, CoreResult};
use crate::git::netconfig;
use crate::model::{AiCliPaths, AiPriceOverride, AppChange, Profile, RepoChange, RepoSettings, SettingScope, Settings, DEFAULT_AI_CONFIRM_COST_USD};
use crate::util;

// ---------------------------------------------------------------------------
// Global settings
// ---------------------------------------------------------------------------

/// Clamps numbers into their ranges and tidies up texts.
fn normalize(mut s: Settings) -> Settings {
    s.zoom = if s.zoom.is_finite() { s.zoom.clamp(0.8, 2.0) } else { 1.0 };
    s.auto_fetch_minutes = s.auto_fetch_minutes.min(60);
    s.initial_commits = s.initial_commits.clamp(500, 100_000);
    s.editor_font_size = s.editor_font_size.clamp(8, 40);
    s.editor_tab_size = s.editor_tab_size.clamp(1, 16);
    s.default_branch_name = s.default_branch_name.trim().to_string();
    if util::check_ref_name(&s.default_branch_name).is_err() {
        s.default_branch_name = Settings::default().default_branch_name;
    }
    s.external_editor = util::non_empty(s.external_editor.take());
    s.external_terminal = util::non_empty(s.external_terminal.take());
    s.external_diff_tool = util::non_empty(s.external_diff_tool.take());
    s.external_merge_tool = util::non_empty(s.external_merge_tool.take());
    normalize_ai(&mut s);
    // Stored network values that are not (or no longer) valid are dropped one by one.
    crate::git::netconfig::normalize_lenient(&mut s);
    s
}

/// Fields of the AI settings; changing one also reports `app:changed` with `ai`.
const AI_KEYS: [&str; 10] = [
    "aiEnabled",
    "aiProvider",
    "aiModel",
    "aiBaseUrl",
    "aiFeaturesOff",
    "aiExclude",
    "aiConfirmCostUsd",
    "aiMonthlyLimitUsd",
    "aiPrices",
    "aiCliPaths",
];

fn normalize_ai(s: &mut Settings) {
    s.ai_model = util::non_empty(s.ai_model.take()).map(|model| model.trim().to_string());
    s.ai_base_url = util::non_empty(s.ai_base_url.take()).map(|url| url.trim().trim_end_matches('/').to_string());
    s.ai_confirm_cost_usd = if s.ai_confirm_cost_usd.is_finite() { s.ai_confirm_cost_usd.clamp(0.0, 100.0) } else { DEFAULT_AI_CONFIRM_COST_USD };
    s.ai_monthly_limit_usd = s.ai_monthly_limit_usd.filter(|limit| limit.is_finite() && *limit >= 0.0).map(|limit| limit.min(100_000.0));
    let mut known = std::collections::HashSet::new();
    s.ai_exclude = s
        .ai_exclude
        .iter()
        .map(|pattern| pattern.trim().to_string())
        .filter(|pattern| !pattern.is_empty() && known.insert(pattern.clone()))
        .take(200)
        .collect();
    s.ai_features_off.sort();
    s.ai_features_off.dedup();
    let mut prices: Vec<AiPriceOverride> = Vec::new();
    for price in std::mem::take(&mut s.ai_prices) {
        let model = price.model.trim().to_string();
        let valid = |value: f64| value.is_finite() && value >= 0.0;
        if model.is_empty() || !valid(price.input_usd_per_mtok) || !valid(price.output_usd_per_mtok) {
            continue;
        }
        prices.retain(|known| known.model != model);
        prices.push(AiPriceOverride { model, input_usd_per_mtok: price.input_usd_per_mtok, output_usd_per_mtok: price.output_usd_per_mtok });
    }
    s.ai_prices = prices;
    for path in [&mut s.ai_cli_paths.claude_code, &mut s.ai_cli_paths.codex, &mut s.ai_cli_paths.opencode] {
        *path = util::non_empty(path.take()).map(|value| value.trim().to_string());
    }
}

/// Own paths of the AI command-line tools must be absolute: a bare name would be searched like PATH.
fn check_cli_paths(paths: &AiCliPaths) -> CoreResult<()> {
    let example = if cfg!(windows) { r"C:\Users\name\.local\bin\claude.exe" } else { "/usr/local/bin/claude" };
    for (kind, path) in paths.entries() {
        let Some(path) = path.map(str::trim).filter(|path| !path.is_empty()) else { continue };
        if !std::path::Path::new(path).is_absolute() {
            return Err(CoreError::not_allowed(format!("Enter the full path of the program for {}, e.g. {example}.", kind.label())));
        }
    }
    Ok(())
}

/// An AI service address: http(s), no credentials in it, unencrypted `http://` only to this computer.
pub(crate) fn check_ai_base_url(url: &str) -> CoreResult<()> {
    let target = crate::http::Target::parse(url)?;
    if target.scheme == "http" && !target.loopback {
        return Err(CoreError::not_allowed(format!(
            "Unencrypted addresses (http://) are only allowed to this computer. Use https://{} or a tunnel to this computer.",
            target.host
        )));
    }
    Ok(())
}

/// Fields of the network settings (proxy, CA bundle, exceptions from certificate verification).
const NETWORK_KEYS: [&str; 4] = ["proxyUrl", "proxyByHost", "sslCaFile", "sslNoVerifyHosts"];

/// Settings of the active profile: defaults, overlaid by the global ones and those of the profile.
/// Each field comes only from its own level (`db::app_settings::GLOBAL_KEYS`); invalid stored
/// values are skipped.
pub fn load_settings(core: &Core) -> CoreResult<Settings> {
    let (global, profile) = core.db.with(|c| {
        let profile_id = db::profiles::active_id(c)?;
        Ok((db::app_settings::get_all(c)?, db::settings::get_all(c, &profile_id)?))
    })?;
    let stored = global
        .into_iter()
        .filter(|(key, _)| db::app_settings::is_global(key))
        .chain(profile.into_iter().filter(|(key, _)| !db::app_settings::is_global(key)));
    let mut settings = Settings::default();
    for (key, value) in stored {
        let mut one = Map::new();
        one.insert(key, value);
        if let Ok((next, _)) = util::apply_patch(&settings, &Value::Object(one), "Settings") {
            settings = next;
        }
    }
    Ok(normalize(settings))
}

pub async fn settings_get(core: &Core) -> CoreResult<Settings> {
    load_settings(core)
}

/// Changes only the fields passed (`Partial<Settings>`). Numbers are clamped into their
/// ranges; an invalid default branch name yields `invalid_name`.
pub async fn settings_set(core: &Core, patch: Value) -> CoreResult<Settings> {
    let current = load_settings(core)?;
    let (next, changed) = util::apply_patch(&current, &patch, "Settings")?;
    if changed.iter().any(|k| k == "defaultBranchName") {
        if let Err(reason) = util::check_ref_name(next.default_branch_name.trim()) {
            return Err(CoreError::invalid_name(format!("Invalid default branch name: {reason}")));
        }
    }
    if changed.iter().any(|k| k == "aiCliPaths") {
        check_cli_paths(&next.ai_cli_paths)?;
    }
    if changed.iter().any(|k| k == "aiBaseUrl") {
        if let Some(url) = next.ai_base_url.as_deref().map(str::trim).filter(|url| !url.is_empty()) {
            check_ai_base_url(url)?;
        }
    }
    let mut next = next;
    if changed.iter().any(|k| NETWORK_KEYS.contains(&k.as_str())) {
        // Strict when saving: an invalid value (placeholder instead of a host, broken
        // proxy address) is an error, so that nothing other than what was entered ever applies.
        crate::git::netconfig::normalize(&mut next).map_err(CoreError::not_allowed)?;
        if changed.iter().any(|k| k == "sslCaFile") {
            if let Some(file) = &next.ssl_ca_file {
                if !std::path::Path::new(file).is_file() {
                    return Err(CoreError::path_not_found(file));
                }
            }
        }
    }
    let mut next = normalize(next);
    if changed.iter().any(|k| PROXY_KEYS.contains(&k.as_str())) {
        // Passwords in proxy addresses go into the keychain; the address is stored and returned
        // without the password.
        let profile_id = core.active_profile_id()?;
        store_proxy_passwords(core, &profile_id, &current, &mut next).await?;
    }
    let as_json = serde_json::to_value(&next)?;
    core.db.tx(|tx| {
        let profile_id = db::profiles::active_id(tx)?;
        for key in &changed {
            if let Some(v) = as_json.get(key) {
                if db::app_settings::is_global(key) {
                    db::app_settings::set(tx, key, v)?;
                } else {
                    db::settings::set(tx, &profile_id, key, v)?;
                }
            }
        }
        Ok(())
    })?;
    if changed.iter().any(|k| k == "aiEnabled") && next.ai_enabled != Some(true) {
        // Grundregel 1: switching off cancels running requests at once.
        crate::ai::run::cancel_all(core);
    }
    if changed.iter().any(|k| AI_KEYS.contains(&k.as_str())) {
        core.emit_app_changed(&[AppChange::Settings, AppChange::Ai]);
    } else {
        core.emit_app_changed(&[AppChange::Settings]);
    }
    Ok(next)
}

/// Which fields of `Settings` apply globally and which per profile.
/// Does not need the core; takes it like every command (contract, `check-commands`).
pub async fn settings_scopes(core: &Core) -> CoreResult<BTreeMap<String, SettingScope>> {
    let _ = core;
    let fields = serde_json::to_value(Settings::default())?;
    let scope = |key: &str| if db::app_settings::is_global(key) { SettingScope::Global } else { SettingScope::Profile };
    Ok(fields.as_object().map(|o| o.keys().map(|k| (k.clone(), scope(k))).collect()).unwrap_or_default())
}

// ---------------------------------------------------------------------------
// Proxy passwords: keychain instead of the settings table
// ---------------------------------------------------------------------------

/// Fields holding proxy addresses.
const PROXY_KEYS: [&str; 2] = ["proxyUrl", "proxyByHost"];

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
async fn store_proxy_passwords(core: &Core, profile_id: &str, current: &Settings, next: &mut Settings) -> CoreResult<()> {
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

/// Prefix of the keychain entries of the removed AI feature (until 2026-10).
const REMOVED_AI_ACCOUNT_PREFIX: &str = "ai:anthropic:";
/// Marker in `app_settings` that the old AI keys have already been removed.
const REMOVED_AI_KEYS_DONE: &str = "cleanup.removedAiKeys";

/// At startup: remove the API keys of the removed AI feature from the keychain.
/// Errors (keychain unreachable) are skipped; the next start tries again.
pub async fn forget_removed_ai_keys(core: &Core) {
    let done = core.db.with(|c| Ok(db::app_settings::get_all(c)?.iter().any(|(key, _)| key == REMOVED_AI_KEYS_DONE)));
    if done.unwrap_or(true) {
        return;
    }
    let Ok(profiles) = core.db.with(db::profiles::list) else {
        return;
    };
    for profile in profiles {
        let _ = crate::secrets::delete(core, &format!("{REMOVED_AI_ACCOUNT_PREFIX}{}", profile.id)).await;
    }
    // Once is enough: the app no longer creates new entries under this name.
    let _ = core.db.with(|c| db::app_settings::set(c, REMOVED_AI_KEYS_DONE, &serde_json::Value::Bool(true)));
}

/// At startup: move proxy passwords that an older version stored in plain text in the settings
/// table into the keychain. If the keychain is unreachable, the old value stays
/// (and still applies); the next start tries again.
pub async fn migrate_proxy_passwords(core: &Core) {
    let Ok(profiles) = core.db.with(db::profiles::list) else {
        return;
    };
    for profile in profiles {
        let stored = core.db.with(|c| db::settings::get_all(c, &profile.id)).unwrap_or_default();
        for (key, value) in &stored {
            let rewritten = match key.as_str() {
                "proxyUrl" => {
                    let Some(url) = value.as_str() else { continue };
                    let (plain, password) = netconfig::split_proxy_password(url);
                    let Some(password) = password else { continue };
                    if !move_proxy_password(core, &profile.id, netconfig::PROXY_SLOT_GLOBAL, &password).await {
                        continue;
                    }
                    Value::String(plain)
                }
                "proxyByHost" => {
                    let mut entries: Vec<crate::model::HostProxy> = serde_json::from_value(value.clone()).unwrap_or_default();
                    let mut moved = false;
                    for entry in entries.iter_mut() {
                        let (plain, password) = netconfig::split_proxy_password(&entry.proxy);
                        let (Some(password), Ok(host)) = (password, netconfig::host_base(&entry.host)) else { continue };
                        if move_proxy_password(core, &profile.id, &host, &password).await {
                            entry.proxy = plain;
                            moved = true;
                        }
                    }
                    if !moved {
                        continue;
                    }
                    match serde_json::to_value(&entries) {
                        Ok(value) => value,
                        Err(_) => continue,
                    }
                }
                _ => continue,
            };
            if let Err(e) = core.db.with(|c| db::settings::set(c, &profile.id, key, &rewritten)) {
                log::warn!("Proxy setting could not be saved after moving the password: {}", e.message);
            }
        }
    }
}

async fn move_proxy_password(core: &Core, profile_id: &str, slot: &str, password: &str) -> bool {
    if password.is_empty() {
        return true;
    }
    match crate::secrets::set(core, &netconfig::proxy_secret_account(profile_id, slot), password).await {
        Ok(()) => true,
        Err(e) => {
            log::warn!("Proxy password stays in the settings for now: {}", e.message);
            false
        }
    }
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
/// host accounts, leftovers of the removed AI feature) – so that deleting the profile takes them along.
fn profile_secret_accounts(core: &Core, profile_id: &str) -> Vec<String> {
    let stored = core.db.with(|c| db::settings::get_all(c, profile_id)).unwrap_or_default();
    let mut accounts: Vec<String> = stored_proxies(&stored).into_iter().map(|(slot, _)| netconfig::proxy_secret_account(profile_id, &slot)).collect();
    let hosters = core.db.with(|c| db::hoster_accounts::list(c, profile_id)).unwrap_or_default();
    accounts.extend(hosters.iter().map(|row| crate::host::secret_account(&row.id)));
    accounts.push(format!("{REMOVED_AI_ACCOUNT_PREFIX}{profile_id}"));
    accounts
}

// ---------------------------------------------------------------------------
// Settings per repository
// ---------------------------------------------------------------------------

/// Fields of `RepoSettings` that live in .git/config (field → Git key).
const GIT_KEYS: [(&str, &str); 4] = [
    ("hooksPath", "core.hooksPath"),
    ("commitTemplate", "commit.template"),
    ("authorName", "user.name"),
    ("authorEmail", "user.email"),
];

/// Fields of `RepoSettings` that the core only returns (never stored, skipped in a patch).
const READ_ONLY_KEYS: [&str; 1] = ["commitTemplateText"];
/// Larger template files are not returned.
const MAX_TEMPLATE_BYTES: u64 = 256 * 1024;

/// Content of the commit template that applies to this repository: `commit.template` from the
/// local, otherwise the global configuration. Git resolves `~` and `~user` itself
/// (`--type=path`); a relative path is relative to the repository's root directory.
/// `None`: no template configured, file missing, too large or not text.
async fn commit_template_text(core: &Core, repo_id: &str) -> Option<String> {
    let root = core.repo_path(repo_id).ok()?;
    let out = core.git_for(repo_id).ok()?.args(["config", "--get", "--type=path", "commit.template"]).read_only().no_log().run_raw().await.ok()?;
    if !out.success() {
        return None;
    }
    let configured = out.stdout_text();
    if configured.trim().is_empty() {
        return None;
    }
    let mut path = std::path::PathBuf::from(configured);
    if path.is_relative() {
        path = root.join(path);
    }
    let meta = tokio::fs::metadata(&path).await.ok()?;
    if !meta.is_file() || meta.len() > MAX_TEMPLATE_BYTES {
        return None;
    }
    let bytes = tokio::fs::read(&path).await.ok()?;
    if util::looks_binary(&bytes) {
        return None;
    }
    Some(util::decode_text(&bytes).0)
}

/// Reads the local .git/config as (key in lower case, value). Without logging: the
/// configuration can contain secrets (tokens as `extraheader`, SMTP passwords).
async fn local_git_config(core: &Core, repo_id: &str) -> CoreResult<Vec<(String, String)>> {
    let out = core.git_for(repo_id)?.args(["config", "--local", "--null", "--list"]).read_only().no_log().run_raw().await?;
    if !out.success() {
        // Exit 1 without output: no readable local configuration → empty.
        if out.stderr.is_empty() {
            return Ok(Vec::new());
        }
        return Err(crate::git::errors::classify("config", out.code, &out.stdout, &out.stderr));
    }
    Ok(util::split_z(&out.stdout)
        .map(|entry| {
            let text = util::decode_lossy(entry);
            let (key, value) = text.split_once('\n').unwrap_or((text.as_str(), ""));
            (key.to_lowercase(), value.to_string())
        })
        .collect())
}

pub async fn repo_settings_get(core: &Core, repo_id: String) -> CoreResult<RepoSettings> {
    let (stored, ssh_key_id) = core.db.with(|c| {
        db::repos::require(c, &repo_id)?;
        let profile_id = db::profiles::active_id(c)?;
        Ok((db::repo_settings::get_all(c, &repo_id)?, db::repo_settings::repo_ssh_key_id(c, &repo_id, &profile_id)?))
    })?;
    let mut settings = RepoSettings::default();
    for (key, value) in stored {
        // The key choice is stored per profile under `sshKeyId:<profile>` (see below).
        if GIT_KEYS.iter().any(|(field, _)| *field == key) || READ_ONLY_KEYS.contains(&key.as_str()) || key.starts_with("sshKeyId") {
            continue;
        }
        let mut one = Map::new();
        one.insert(key, value);
        if let Ok((next, _)) = util::apply_patch(&settings, &Value::Object(one), "Repository settings") {
            settings = next;
        }
    }
    let config = local_git_config(core, &repo_id).await?;
    let lookup = |git_key: &str| {
        let wanted = git_key.to_lowercase();
        config.iter().rev().find(|(k, _)| *k == wanted).map(|(_, v)| v.clone())
    };
    settings.hooks_path = lookup("core.hooksPath");
    settings.commit_template = lookup("commit.template");
    settings.author_name = lookup("user.name");
    settings.author_email = lookup("user.email");
    settings.commit_template_text = commit_template_text(core, &repo_id).await;
    settings.ssh_key_id = ssh_key_id;
    Ok(settings)
}

/// Changes only the fields passed. Git fields (hooksPath, commitTemplate, authorName,
/// authorEmail) go into .git/config (`null` or empty = remove the entry).
/// `commitTemplateText` is read-only and skipped in a patch.
/// `linkRules` is checked (`not_allowed` with the reason) and stored in its canonical form.
pub async fn repo_settings_set(core: &Core, repo_id: String, patch: Value) -> CoreResult<RepoSettings> {
    let current = repo_settings_get(core, repo_id.clone()).await?;
    let (mut next, mut changed) = util::apply_patch(&current, &patch, "Repository settings")?;
    changed.retain(|key| !READ_ONLY_KEYS.contains(&key.as_str()));
    if changed.iter().any(|k| k == "linkRules") {
        next.link_rules = crate::commands::links::normalize_config(&next.link_rules)?;
    }
    if changed.iter().any(|k| k == "encoding") && encoding_rs::Encoding::for_label(next.encoding.trim().as_bytes()).is_none() {
        return Err(CoreError::not_allowed(format!("Unknown encoding “{}”.", next.encoding)));
    }
    if let Some(email) = next.author_email.as_deref().filter(|e| !e.trim().is_empty()) {
        if changed.iter().any(|k| k == "authorEmail") && !looks_like_email(email) {
            return Err(CoreError::not_allowed("The email address is invalid."));
        }
    }
    let as_json = serde_json::to_value(&next)?;
    core.db.tx(|tx| {
        let profile_id = db::profiles::active_id(tx)?;
        // The key must belong to the active profile.
        if changed.iter().any(|k| k == "sshKeyId") {
            if let Some(key_id) = &next.ssh_key_id {
                if db::ssh_keys::get(tx, &profile_id, key_id)?.is_none() {
                    return Err(CoreError::not_found("The SSH key does not belong to this profile."));
                }
            }
        }
        if changed.iter().any(|k| k == "sshKeyId") {
            db::repo_settings::set_repo_ssh_key_id(tx, &repo_id, &profile_id, next.ssh_key_id.as_deref())?;
        }
        for key in &changed {
            if GIT_KEYS.iter().any(|(field, _)| field == key) || key == "sshKeyId" {
                continue;
            }
            match as_json.get(key) {
                // A cleared value (key, pull mode) follows the profile again.
                Some(Value::Null) | None => db::repo_settings::delete(tx, &repo_id, key)?,
                Some(v) => db::repo_settings::set(tx, &repo_id, key, v)?,
            }
        }
        Ok(())
    })?;
    let git_changes: Vec<(&str, Option<String>)> = GIT_KEYS
        .iter()
        .filter(|(field, _)| changed.iter().any(|k| k == field))
        .map(|(field, git_key)| {
            let value = as_json.get(*field).and_then(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
            (*git_key, value)
        })
        .collect();
    if !git_changes.is_empty() {
        core.with_write_lock(&repo_id, &[RepoChange::Config], async {
            for (key, value) in &git_changes {
                let cmd = core.git_for(&repo_id)?.args(["config", "--local"]);
                match value {
                    Some(v) => {
                        cmd.args([*key, v.as_str()]).run().await?;
                    }
                    None => {
                        // Exit 5 = the key was not set; that is fine here.
                        let out = cmd.args(["--unset-all", *key]).run_raw().await?;
                        if !out.success() && out.code != Some(5) {
                            return Err(crate::git::errors::classify("config", out.code, &out.stdout, &out.stderr));
                        }
                    }
                }
            }
            Ok(())
        })
        .await?;
    }
    repo_settings_get(core, repo_id).await
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

fn looks_like_email(email: &str) -> bool {
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
    if let Some(p) = profile {
        if p.is_active && p.sync_gitconfig {
            write_global_identity(core, &p.author_name, &p.author_email).await?;
        }
    }
    core.emit_app_changed(&[AppChange::Profiles]);
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
        let accounts = db::host_accounts::list(tx, &id)?;
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
/// the identity is written into the global gitconfig.
pub async fn profile_activate(core: &Core, id: String) -> CoreResult<Vec<Profile>> {
    let (old_repos, new_repos, profile) = core.db.tx(|tx| {
        let old = db::profiles::active_id(tx)?;
        let old_repos = db::tabs::open_repo_ids(tx, &old)?;
        db::profiles::set_active(tx, &id)?;
        db::tabs::ensure_consistent(tx, &id)?;
        let new_repos = db::tabs::open_repo_ids(tx, &id)?;
        let profile = db::profiles::get(tx, &id)?.ok_or_else(|| CoreError::not_found("Profile not found."))?;
        Ok((old_repos, new_repos, profile))
    })?;
    for repo_id in old_repos.iter().filter(|r| !new_repos.contains(r)) {
        crate::commands::repos::stop_background_if_closed(core, repo_id);
    }
    for repo_id in &new_repos {
        crate::commands::repos::start_background(core, repo_id);
    }
    if profile.sync_gitconfig {
        write_global_identity(core, &profile.author_name, &profile.author_email).await?;
    }
    core.emit_app_changed(&[AppChange::Profiles, AppChange::Settings, AppChange::Tabs, AppChange::Credentials, AppChange::SshKeys]);
    profile_list(core).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use crate::events::names;
    use crate::model::{AiCliPaths, AiFeature, AiProviderKind};
    use crate::model::{PullMode, Theme};
    use crate::testkit::{TestCore, TestRepo};
    use serde_json::json;

    #[tokio::test]
    async fn global_settings_are_shared_and_profile_settings_are_not() {
        let tc = TestCore::new().await;
        settings_set(&tc, json!({"theme": "light", "autoFetchMinutes": 7})).await.unwrap();
        let list = profile_save(&tc, None, "Privat".into(), "".into(), "".into(), false, None).await.unwrap();
        let other = list.iter().find(|p| p.name == "Privat").unwrap().id.clone();
        profile_activate(&tc, other).await.unwrap();
        let s = settings_get(&tc).await.unwrap();
        assert_eq!(s.theme, Theme::Light, "theme is global");
        assert_eq!(s.auto_fetch_minutes, Settings::default().auto_fetch_minutes, "auto-fetch is per profile");
    }

    #[tokio::test]
    async fn mixed_patch_lands_on_both_levels() {
        let tc = TestCore::new().await;
        settings_set(&tc, json!({"zoom": 1.2, "pushAfterCommit": true})).await.unwrap();
        let (global, profile) = tc
            .db
            .with(|c| {
                let pid = db::profiles::active_id(c)?;
                Ok((db::app_settings::get_all(c)?, db::settings::get_all(c, &pid)?))
            })
            .unwrap();
        assert!(global.iter().any(|(k, _)| k == "zoom"));
        assert!(!global.iter().any(|(k, _)| k == "pushAfterCommit"));
        assert!(profile.iter().any(|(k, _)| k == "pushAfterCommit"));
        assert!(!profile.iter().any(|(k, _)| k == "zoom"));
    }

    #[tokio::test]
    async fn every_settings_field_has_exactly_one_scope() {
        let tc = TestCore::new().await;
        let scopes = settings_scopes(&tc).await.unwrap();
        let fields = serde_json::to_value(Settings::default()).unwrap();
        let fields: Vec<&String> = fields.as_object().unwrap().keys().collect();
        assert_eq!(scopes.len(), fields.len());
        for key in fields {
            assert!(scopes.contains_key(key), "{key} has no level");
        }
        for key in db::app_settings::GLOBAL_KEYS {
            assert_eq!(scopes[key], crate::model::SettingScope::Global, "{key}");
        }
        assert_eq!(scopes["proxyUrl"], crate::model::SettingScope::Profile);
    }

    #[tokio::test]
    async fn ai_settings_are_global_tidied_and_checked() {
        let tc = TestCore::new().await;
        let s = settings_get(&tc).await.unwrap();
        assert_eq!(s.ai_enabled, None, "not set up: neither on nor off");
        assert_eq!(s.ai_confirm_cost_usd, 0.10, "ask above 0.10 USD by default (spec Grundregel 4)");
        let s = settings_set(
            &tc,
            json!({
                "aiEnabled": true,
                "aiProvider": "openai_compatible",
                "aiBaseUrl": " https://llm.firma.example/v1/ ",
                "aiModel": "  mistral-large-latest ",
                "aiConfirmCostUsd": -3,
                "aiMonthlyLimitUsd": 25.5,
                "aiExclude": [" *.sql ", "", "*.sql", "geheim/**"],
                "aiFeaturesOff": ["plan", "compose", "plan"],
                "aiPrices": [
                    {"model": " mistral-large-latest ", "inputUsdPerMtok": 2, "outputUsdPerMtok": 6},
                    {"model": "", "inputUsdPerMtok": 1, "outputUsdPerMtok": 1},
                    {"model": "x", "inputUsdPerMtok": -1, "outputUsdPerMtok": 1}
                ]
            }),
        )
        .await
        .unwrap();
        assert_eq!(s.ai_base_url.as_deref(), Some("https://llm.firma.example/v1"));
        assert_eq!(s.ai_model.as_deref(), Some("mistral-large-latest"));
        assert_eq!(s.ai_confirm_cost_usd, 0.0);
        assert_eq!(s.ai_monthly_limit_usd, Some(25.5));
        assert_eq!(s.ai_exclude, vec!["*.sql".to_string(), "geheim/**".to_string()]);
        assert_eq!(s.ai_features_off, vec![AiFeature::Compose, AiFeature::Plan]);
        assert_eq!(s.ai_prices.len(), 1);
        assert_eq!((s.ai_prices[0].model.as_str(), s.ai_prices[0].input_usd_per_mtok, s.ai_prices[0].output_usd_per_mtok), ("mistral-large-latest", 2.0, 6.0));
        let ai_events = tc
            .events
            .all()
            .into_iter()
            .filter(|(name, payload)| name == names::APP_CHANGED && payload["what"].as_array().is_some_and(|what| what.iter().any(|w| w == "ai")))
            .count();
        assert_eq!(ai_events, 1, "an AI change also reports app:changed with ai");

        // Global (Entscheidung 1): another profile sees the same values.
        let list = profile_save(&tc, None, "Privat".into(), "".into(), "".into(), false, None).await.unwrap();
        let other = list.iter().find(|p| p.name == "Privat").unwrap().id.clone();
        profile_activate(&tc, other).await.unwrap();
        let s = settings_get(&tc).await.unwrap();
        assert_eq!((s.ai_enabled, s.ai_provider), (Some(true), Some(AiProviderKind::OpenaiCompatible)));

        // Unencrypted only to this computer.
        let err = settings_set(&tc, json!({"aiBaseUrl": "http://llm.firma.example/v1"})).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
        assert!(err.message.contains("https://"), "{}", err.message);
        let err = settings_set(&tc, json!({"aiBaseUrl": "https://user:pass@llm.firma.example/v1"})).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed, "no credentials in the address");
        assert!(!err.message.contains("pass@"), "{}", err.message);
        let s = settings_set(&tc, json!({"aiBaseUrl": "http://127.0.0.1:11435"})).await.unwrap();
        assert_eq!(s.ai_base_url.as_deref(), Some("http://127.0.0.1:11435"));
        let s = settings_set(&tc, json!({"aiEnabled": false})).await.unwrap();
        assert_eq!(s.ai_enabled, Some(false), "off on purpose is kept apart from unset");
    }

    #[tokio::test]
    async fn ai_off_is_a_repository_setting_outside_the_git_config() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let id = tc.open(&repo).await.repo.id;
        assert!(!repo_settings_get(&tc, id.clone()).await.unwrap().ai_off);
        let s = repo_settings_set(&tc, id.clone(), json!({"aiOff": true})).await.unwrap();
        assert!(s.ai_off);
        let config = String::from_utf8_lossy(&repo.read_file(".git/config")).to_lowercase();
        assert!(!config.contains("aioff"), "stored in the app database, not in .git/config: {config}");
        let tc = tc.restart().await;
        assert!(repo_settings_get(&tc, id).await.unwrap().ai_off, "kept across a restart");
    }

    #[tokio::test]
    async fn cli_paths_are_global_tidied_and_must_be_absolute() {
        let tc = TestCore::new().await;
        assert_eq!(settings_get(&tc).await.unwrap().ai_cli_paths, AiCliPaths::default(), "found automatically by default");
        let own = std::env::temp_dir().join("Programme mit Leerzeichen").join("Grüße").join("claude");
        tc.events.clear();
        let s = settings_set(&tc, json!({"aiCliPaths": {"claudeCode": format!("  {}  ", own.display()), "codex": "   ", "opencode": null}})).await.unwrap();
        assert_eq!(s.ai_cli_paths.claude_code.as_deref(), Some(own.to_str().unwrap()), "trimmed, spaces and umlauts inside kept");
        assert_eq!((s.ai_cli_paths.codex.clone(), s.ai_cli_paths.opencode.clone()), (None, None), "blank = found automatically");
        let ai_events = tc
            .events
            .all()
            .into_iter()
            .filter(|(name, payload)| name == names::APP_CHANGED && payload["what"].as_array().is_some_and(|what| what.iter().any(|w| w == "ai")))
            .count();
        assert_eq!(ai_events, 1, "a path change is an AI change");

        for relative in ["bin/claude", "claude", "-claude"] {
            let err = settings_set(&tc, json!({"aiCliPaths": {"claudeCode": null, "codex": relative, "opencode": null}})).await.unwrap_err();
            assert_eq!(err.code, ErrorCode::NotAllowed, "{relative}");
            assert!(err.message.contains("full path") && err.message.contains("Codex"), "{}", err.message);
        }
        assert_eq!(settings_get(&tc).await.unwrap().ai_cli_paths.claude_code.as_deref(), Some(own.to_str().unwrap()), "a refused change keeps the old value");

        // Global like every AI setting (Entscheidung 1).
        let list = profile_save(&tc, None, "Privat".into(), "".into(), "".into(), false, None).await.unwrap();
        let other = list.iter().find(|p| p.name == "Privat").unwrap().id.clone();
        profile_activate(&tc, other).await.unwrap();
        assert_eq!(settings_get(&tc).await.unwrap().ai_cli_paths.claude_code.as_deref(), Some(own.to_str().unwrap()));
    }

    #[tokio::test]
    async fn profile_colour_is_stored_and_checked() {
        let tc = TestCore::new().await;
        let list = profile_save(&tc, None, "Arbeit".into(), "".into(), "".into(), false, Some(3)).await.unwrap();
        let work = list.iter().find(|p| p.name == "Arbeit").unwrap().clone();
        assert_eq!(work.color, Some(3));
        let list = profile_save(&tc, Some(work.id.clone()), "Arbeit".into(), "".into(), "".into(), false, None).await.unwrap();
        assert_eq!(list.iter().find(|p| p.id == work.id).unwrap().color, None);
        let err = profile_save(&tc, None, "X".into(), "".into(), "".into(), false, Some(9)).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
        let err = profile_save(&tc, None, "Y".into(), "".into(), "".into(), false, Some(0)).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
    }

    #[tokio::test]
    async fn removed_ai_keys_are_cleaned_from_the_keychain() {
        let tc = TestCore::new().await;
        let profile_id = tc.active_profile_id().unwrap();
        let account = format!("ai:anthropic:{profile_id}");
        crate::secrets::set(&tc, &account, "sk-alt").await.unwrap();
        // Startup has already cleaned up; the test replays the first start after the update.
        tc.db.with(|c| Ok(c.execute("delete from app_settings where key = ?1", [REMOVED_AI_KEYS_DONE])?)).unwrap();
        forget_removed_ai_keys(&tc).await;
        assert_eq!(crate::secrets::get(&tc, &account).await.unwrap(), None);
        // After that it no longer runs: an entry created later stays untouched.
        crate::secrets::set(&tc, &account, "sk-neu").await.unwrap();
        forget_removed_ai_keys(&tc).await;
        assert_eq!(crate::secrets::get(&tc, &account).await.unwrap().as_deref(), Some("sk-neu"));
    }

    #[tokio::test]
    async fn defaults_and_patch_with_clamping() {
        let tc = TestCore::new().await;
        let s = settings_get(&tc).await.unwrap();
        assert_eq!(s, Settings::default());

        let s = settings_set(&tc, json!({"theme": "light", "zoom": 3.0, "initialCommits": 10, "autoFetchMinutes": 99, "externalEditor": "  "}))
            .await
            .unwrap();
        assert_eq!(s.theme, Theme::Light);
        assert_eq!(s.zoom, 2.0);
        assert_eq!(s.initial_commits, 500);
        assert_eq!(s.auto_fetch_minutes, 60);
        assert_eq!(s.external_editor, None);
        assert_eq!(tc.events.count(names::APP_CHANGED), 1);

        // Stored and still there after a restart.
        let tc = tc.restart().await;
        let s = settings_get(&tc).await.unwrap();
        assert_eq!(s.theme, Theme::Light);
        assert_eq!(s.zoom, 2.0);
        assert_eq!(s.default_pull_mode, PullMode::Ff);

        let err = settings_set(&tc, json!({"gibtsNicht": true})).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
        let err = settings_set(&tc, json!({"theme": "lila"})).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
        let err = settings_set(&tc, json!({"defaultBranchName": "a..b"})).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidName);
        let s = settings_set(&tc, json!({"defaultBranchName": " trunk ", "externalEditor": "code {path}"})).await.unwrap();
        assert_eq!(s.default_branch_name, "trunk");
        assert_eq!(s.external_editor.as_deref(), Some("code {path}"));
        let s = settings_set(&tc, json!({"externalEditor": null})).await.unwrap();
        assert_eq!(s.external_editor, None);
    }

    #[tokio::test]
    async fn repo_settings_db_and_git_config() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let id = tc.open(&repo).await.repo.id;

        let s = repo_settings_get(&tc, id.clone()).await.unwrap();
        assert_eq!(s.encoding, "utf-8");
        assert!(s.auto_fetch);
        // TestRepo sets user.name/user.email locally.
        assert_eq!(s.author_name.as_deref(), Some("Test Person"));
        assert_eq!(s.hooks_path, None);

        tc.events.clear();
        let s = repo_settings_set(
            &tc,
            id.clone(),
            json!({"encoding": "windows-1252", "autoFetch": false, "defaultPullMode": "rebase", "hooksPath": ".githooks", "authorName": null}),
        )
        .await
        .unwrap();
        assert_eq!(s.encoding, "windows-1252");
        assert!(!s.auto_fetch);
        assert_eq!(s.default_pull_mode, Some(PullMode::Rebase));
        assert_eq!(s.hooks_path.as_deref(), Some(".githooks"));
        assert_eq!(s.author_name, None);
        assert_eq!(repo.git(&["config", "--local", "core.hooksPath"]), ".githooks");
        assert!(!repo.git_output(&["config", "--local", "user.name"]).status.success());
        let changed = tc.events.named(names::REPO_CHANGED);
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0]["what"], json!(["config"]));

        let err = repo_settings_set(&tc, id.clone(), json!({"encoding": "klingonisch"})).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
        let err = repo_settings_set(&tc, id.clone(), json!({"authorEmail": "kein-at"})).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
        // Removing a key that is not set is not an error.
        repo_settings_set(&tc, id.clone(), json!({"commitTemplate": null})).await.unwrap();
    }

    #[tokio::test]
    async fn default_profile_from_global_config() {
        let tc = TestCore::with_global_config("[user]\n\tname = Erika Muster\n\temail = erika@example.com\n").await;
        let profiles = profile_list(&tc).await.unwrap();
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].name, "Default");
        assert_eq!(profiles[0].author_name, "Erika Muster");
        assert_eq!(profiles[0].author_email, "erika@example.com");
        assert!(profiles[0].is_active);

        let tc2 = TestCore::new().await;
        let profiles = profile_list(&tc2).await.unwrap();
        assert_eq!(profiles[0].author_name, "");
    }

    #[tokio::test]
    async fn deleting_a_profile_forgets_repos_only_it_had() {
        let tc = TestCore::new().await;
        let default_id = profile_list(&tc).await.unwrap()[0].id.clone();
        let shared = TestRepo::with_commit();
        let own = TestRepo::with_commit();
        let shared_id = tc.open(&shared).await.repo.id;
        let list = profile_save(&tc, None, "Arbeit".into(), "".into(), "".into(), false, None).await.unwrap();
        let work = list.iter().find(|p| p.name == "Arbeit").unwrap().id.clone();
        profile_activate(&tc, work.clone()).await.unwrap();
        let own_id = tc.open(&own).await.repo.id;
        crate::commands::repos::repo_open_with(&tc, shared.path().to_string_lossy().into_owned(), true).await.unwrap();
        profile_activate(&tc, default_id).await.unwrap();

        profile_delete(&tc, work).await.unwrap();

        assert!(tc.db.with(|c| db::repos::get(c, &own_id)).unwrap().is_none(), "listed only in the deleted profile");
        assert!(tc.db.with(|c| db::repos::get(c, &shared_id)).unwrap().is_some(), "the other profile keeps listing it");
    }

    #[tokio::test]
    async fn profiles_save_activate_delete() {
        let tc = TestCore::new().await;
        let default_id = profile_list(&tc).await.unwrap()[0].id.clone();

        let list = profile_save(&tc, None, "Arbeit".into(), "Max Muster".into(), "max@firma.de".into(), true, None).await.unwrap();
        assert_eq!(list.len(), 2);
        let work = list.iter().find(|p| p.name == "Arbeit").unwrap().clone();
        assert!(!work.is_active);
        // Not active → global config untouched.
        let global = std::fs::read_to_string(tc.global_config_path()).unwrap();
        assert!(!global.contains("Max Muster"));

        let err = profile_save(&tc, None, "arbeit".into(), "".into(), "".into(), false, None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NameExists);
        let err = profile_save(&tc, None, "  ".into(), "".into(), "".into(), false, None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidName);
        let err = profile_save(&tc, None, "X".into(), "".into(), "falsch".into(), false, None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);

        // Each profile has its own tabs; the theme is global.
        settings_set(&tc, json!({"theme": "light"})).await.unwrap();
        let repo = TestRepo::with_commit();
        tc.open(&repo).await;
        let list = profile_activate(&tc, work.id.clone()).await.unwrap();
        assert!(list.iter().find(|p| p.id == work.id).unwrap().is_active);
        assert_eq!(settings_get(&tc).await.unwrap().theme, Theme::Light);
        let tabs = crate::commands::repos::tabs_list(&tc).await.unwrap();
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[0].kind, crate::model::TabKind::Management);
        let global = std::fs::read_to_string(tc.global_config_path()).unwrap();
        assert!(global.contains("Max Muster"), "{global}");
        assert!(global.contains("max@firma.de"));

        let err = profile_delete(&tc, work.id.clone()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
        let list = profile_delete(&tc, default_id.clone()).await.unwrap();
        assert_eq!(list.len(), 1);
        let err = profile_delete(&tc, work.id.clone()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
        let err = profile_activate(&tc, default_id).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);

        // Renaming the active profile with sync writes the new identity.
        profile_save(&tc, Some(work.id.clone()), "Arbeit".into(), "Max M.".into(), "mm@firma.de".into(), true, None).await.unwrap();
        let global = std::fs::read_to_string(tc.global_config_path()).unwrap();
        assert!(global.contains("Max M."));
    }

    /// The template usually lives outside the repository (`~/.gitmessage`): the core returns
    /// its content as well, because the UI cannot read there.
    #[tokio::test]
    async fn commit_template_text_follows_the_effective_template() {
        let outside = tempfile::tempdir().unwrap();
        let template = outside.path().join("vorlage mit leer.txt");
        std::fs::write(&template, "Betreff\n\n# Kommentar\nGrüße\n").unwrap();
        let global = format!("[commit]\n\ttemplate = {}\n", template.to_string_lossy().replace('\\', "/"));
        let tc = TestCore::with_global_config(&global).await;
        let repo = TestRepo::with_commit();
        let id = tc.open(&repo).await.repo.id;

        // Set globally: the repository's raw value stays empty, the text is there.
        let s = repo_settings_get(&tc, id.clone()).await.unwrap();
        assert_eq!(s.commit_template, None);
        assert_eq!(s.commit_template_text.as_deref(), Some("Betreff\n\n# Kommentar\nGrüße\n"));

        // Set locally (relative to the repository) takes precedence; windows-1252 is detected.
        repo.write_file("vorlagen/lokal.txt", b"Gr\xfc\xdfe lokal\r\n");
        let s = repo_settings_set(&tc, id.clone(), json!({"commitTemplate": "vorlagen/lokal.txt"})).await.unwrap();
        assert_eq!(s.commit_template.as_deref(), Some("vorlagen/lokal.txt"));
        assert_eq!(s.commit_template_text.as_deref(), Some("Grüße lokal\r\n"));

        // The field is read-only: a patch with it changes nothing and stores nothing.
        let s = repo_settings_set(&tc, id.clone(), json!({"commitTemplateText": "untergeschoben", "autoFetch": false})).await.unwrap();
        assert_eq!(s.commit_template_text.as_deref(), Some("Grüße lokal\r\n"));
        assert!(!s.auto_fetch);
        let stored = tc.db.with(|c| db::repo_settings::get_all(c, &id)).unwrap();
        assert!(!stored.iter().any(|(key, _)| key == "commitTemplateText"), "{stored:?}");

        // File missing, binary or a directory: no text, no error.
        for (value, content) in [("vorlagen/fehlt.txt", None), ("vorlagen/binaer.bin", Some(&b"a\0b"[..])), ("vorlagen", None)] {
            if let Some(content) = content {
                repo.write_file(value, content);
            }
            let s = repo_settings_set(&tc, id.clone(), json!({"commitTemplate": value})).await.unwrap();
            assert_eq!(s.commit_template_text, None, "{value}");
        }
        // Without a local value the global one applies again.
        let s = repo_settings_set(&tc, id.clone(), json!({"commitTemplate": null})).await.unwrap();
        assert_eq!(s.commit_template_text.as_deref(), Some("Betreff\n\n# Kommentar\nGrüße\n"));
    }

    /// Git resolves `~/…` against the home directory.
    #[tokio::test]
    async fn commit_template_text_resolves_the_home_directory() {
        let home = tempfile::tempdir().unwrap();
        std::fs::write(home.path().join(".gitmessage"), "Aus dem Heimatverzeichnis\n").unwrap();
        let dir = tempfile::tempdir().unwrap();
        let global = dir.path().join("gitconfig");
        std::fs::write(&global, "[commit]\n\ttemplate = ~/.gitmessage\n").unwrap();
        let events = std::sync::Arc::new(crate::events::EventCollector::new());
        let mut config = crate::app::CoreConfig::new(dir.path().join("data"), "0.0.0-test", events);
        config.git_env = crate::testkit::git_isolation_env(&global);
        config.git_env.push(("HOME".into(), home.path().as_os_str().to_os_string()));
        config.git_env.push(("USERPROFILE".into(), home.path().as_os_str().to_os_string()));
        let core = Core::open(config).await.unwrap();
        let repo = TestRepo::with_commit();
        let id = crate::commands::repos::repo_open(&core, repo.path().to_string_lossy().into_owned()).await.unwrap().repo.id;

        let s = repo_settings_get(&core, id.clone()).await.unwrap();
        assert_eq!(s.commit_template_text.as_deref(), Some("Aus dem Heimatverzeichnis\n"));
        // Locally with a tilde as well.
        std::fs::write(home.path().join("lokal.txt"), "Lokal mit Tilde\n").unwrap();
        let s = repo_settings_set(&core, id, json!({"commitTemplate": "~/lokal.txt"})).await.unwrap();
        assert_eq!(s.commit_template.as_deref(), Some("~/lokal.txt"));
        assert_eq!(s.commit_template_text.as_deref(), Some("Lokal mit Tilde\n"));
    }
}
