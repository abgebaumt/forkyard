//! Settings (global, per profile and per repository). Profiles: `commands/profiles.rs`.

use serde_json::{Map, Value};

use crate::app::Core;
use crate::db;
use crate::error::{CoreError, CoreResult};
use crate::model::{AiCliPaths, AiPriceOverride, AppChange, RepoChange, RepoSettings, Settings, DEFAULT_AI_CONFIRM_COST_USD};
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
const AI_KEYS: [&str; 13] = [
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
    "aiSearchEmbedProvider",
    "aiSearchEmbedModel",
    "aiSearchEmbedBaseUrl",
];

fn normalize_ai(s: &mut Settings) {
    s.ai_model = util::non_empty(s.ai_model.take()).map(|model| model.trim().to_string());
    s.ai_base_url = util::non_empty(s.ai_base_url.take()).map(|url| url.trim().trim_end_matches('/').to_string());
    s.ai_confirm_cost_usd =
        if s.ai_confirm_cost_usd.is_finite() { s.ai_confirm_cost_usd.clamp(0.0, 100.0) } else { DEFAULT_AI_CONFIRM_COST_USD };
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
        prices.push(AiPriceOverride {
            model,
            input_usd_per_mtok: price.input_usd_per_mtok,
            output_usd_per_mtok: price.output_usd_per_mtok,
        });
    }
    s.ai_prices = prices;
    s.ai_search_embed_model = util::non_empty(s.ai_search_embed_model.take()).map(|model| model.trim().to_string());
    s.ai_search_embed_base_url = util::non_empty(s.ai_search_embed_base_url.take()).map(|url| url.trim().trim_end_matches('/').to_string());
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

/// The address of the local embedding provider of the search: only this computer, whatever the
/// scheme – a provider elsewhere would be a second external provider.
pub(crate) fn check_local_embed_url(url: &str) -> CoreResult<()> {
    let target = crate::http::Target::parse(url)?;
    if !target.loopback {
        return Err(CoreError::not_allowed(format!(
            "The embedding provider of the search runs on this computer only. Use an address like http://127.0.0.1:11434 instead of {}.",
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
    if changed.iter().any(|k| k == "aiSearchEmbedProvider") && next.ai_search_embed_provider.is_some_and(|kind| !kind.is_local()) {
        return Err(CoreError::not_allowed(
            "The embedding provider of the search must run on this computer: choose Ollama or LM Studio, or use the main provider.",
        ));
    }
    if changed.iter().any(|k| k == "aiSearchEmbedBaseUrl") {
        if let Some(url) = next.ai_search_embed_base_url.as_deref().map(str::trim).filter(|url| !url.is_empty()) {
            check_local_embed_url(url)?;
        }
    }
    let mut next = next;
    if changed.iter().any(|k| k == "agentTemplates") {
        next.agent_templates = crate::commands::agents::templates::validate_custom(&next.agent_templates)?;
    }
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
        // switching off cancels running requests at once.
        crate::ai::run::cancel_all(core);
    }
    if changed.iter().any(|k| AI_KEYS.contains(&k.as_str())) {
        core.emit_app_changed(&[AppChange::Settings, AppChange::Ai]);
    } else {
        core.emit_app_changed(&[AppChange::Settings]);
    }
    Ok(next)
}

pub(crate) mod proxy_secrets;

use crate::commands::profiles::looks_like_email;
use proxy_secrets::{store_proxy_passwords, PROXY_KEYS};

// ---------------------------------------------------------------------------
// Settings per repository
// ---------------------------------------------------------------------------

/// Fields of `RepoSettings` that live in .git/config (field → Git key).
const GIT_KEYS: [(&str, &str); 4] =
    [("hooksPath", "core.hooksPath"), ("commitTemplate", "commit.template"), ("authorName", "user.name"), ("authorEmail", "user.email")];

/// Fields of `RepoSettings` that the core only returns (never stored, skipped in a patch).
const READ_ONLY_KEYS: [&str; 2] = ["commitTemplateText", "secretScanIgnoredCount"];
/// Larger template files are not returned.
const MAX_TEMPLATE_BYTES: u64 = 256 * 1024;

/// Content of the commit template that applies to this repository: `commit.template` from the
/// local, otherwise the global configuration. Git resolves `~` and `~user` itself
/// (`--type=path`); a relative path is relative to the repository's root directory.
/// `None`: no template configured, file missing, too large or not text.
async fn commit_template_text(core: &Core, repo_id: &str) -> Option<String> {
    let root = core.repo_path(repo_id).ok()?;
    let out = core.git_for(repo_id).ok()?.args(["config", "--get", "--type=path", "commit.template"]).read().run_raw().await.ok()?;
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
    let out = core.git_for(repo_id)?.args(["config", "--local", "--null", "--list"]).read().run_raw().await?;
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

impl Core {
    /// The settings of one repository (database and `.git/config`); what features read
    /// instead of calling the `repo_settings_get` command.
    pub async fn repo_settings(&self, repo_id: &str) -> CoreResult<RepoSettings> {
        let core = self;
        let (stored, ssh_key_id) = core.db.with(|c| {
            db::repos::require(c, repo_id)?;
            let profile_id = db::profiles::active_id(c)?;
            Ok((db::repo_settings::get_all(c, repo_id)?, db::repo_settings::repo_ssh_key_id(c, repo_id, &profile_id)?))
        })?;
        let mut settings = RepoSettings::default();
        for (key, value) in stored {
            // The key choice is stored per profile under `sshKeyId:<profile>` (see below).
            if GIT_KEYS.iter().any(|(field, _)| *field == key)
                || READ_ONLY_KEYS.contains(&key.as_str())
                || key.starts_with("sshKeyId")
                || key == crate::secret_scan::IGNORED_KEY
            {
                continue;
            }
            let mut one = Map::new();
            one.insert(key, value);
            if let Ok((next, _)) = util::apply_patch(&settings, &Value::Object(one), "Repository settings") {
                settings = next;
            }
        }
        let config = local_git_config(core, repo_id).await?;
        let lookup = |git_key: &str| {
            let wanted = git_key.to_lowercase();
            config.iter().rev().find(|(k, _)| *k == wanted).map(|(_, v)| v.clone())
        };
        settings.hooks_path = lookup("core.hooksPath");
        settings.commit_template = lookup("commit.template");
        settings.author_name = lookup("user.name");
        settings.author_email = lookup("user.email");
        settings.commit_template_text = commit_template_text(core, repo_id).await;
        settings.ssh_key_id = ssh_key_id;
        settings.secret_scan_ignored_count =
            u32::try_from(core.db.with(|c| crate::secret_scan::ignored_ids(c, repo_id))?.len()).unwrap_or(u32::MAX);
        Ok(settings)
    }
}

pub async fn repo_settings_get(core: &Core, repo_id: String) -> CoreResult<RepoSettings> {
    core.repo_settings(&repo_id).await
}

/// Changes only the fields passed. Git fields (hooksPath, commitTemplate, authorName,
/// authorEmail) go into .git/config (`null` or empty = remove the entry).
/// `commitTemplateText` is read-only and skipped in a patch.
/// `linkRules` is checked (`not_allowed` with the reason) and stored in its canonical form.
pub async fn repo_settings_set(core: &Core, repo_id: String, patch: Value) -> CoreResult<RepoSettings> {
    let current = core.repo_settings(&repo_id).await?;
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
    if changed.iter().any(|k| k == "aiCommitInstruction") {
        next.ai_commit_instruction = crate::ai::features::commit_message::own_instruction(next.ai_commit_instruction.as_deref())?;
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
    core.repo_settings(&repo_id).await
}

#[cfg(test)]
mod tests;
