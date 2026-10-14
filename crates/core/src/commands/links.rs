//! Ticket links: rules that turn references in commit messages (`#123`, `ABC-42` …) into links.
//! Four sources: the detected host, presets (Jira, Linear, YouTrack, Redmine), the user's own rules
//! (both stored in `repo_settings` under `linkRules`) and the repository file `.forkyard/links.json`.
//! The core only checks and collects the rules; the UI matches them. A link only opens the browser,
//! nothing runs – the repository file therefore needs no trust of its own.

mod pattern;

use std::collections::HashSet;
use std::path::Path;

use serde::Deserialize;

use crate::app::Core;
use crate::db;
use crate::error::{CoreError, CoreResult};
use crate::git::redact::redact;
use crate::model::{
    CustomLinkRule, HostKind, LinkFileOrigin, LinkPreset, LinkPresetKind, LinkRule, LinkRuleProblem, LinkRuleSource, LinkRules, LinkRulesConfig,
};

pub use pattern::{check_pattern, MAX_PATTERN_LEN};

/// At most this many own rules (and as many from the repository file).
pub const MAX_RULES: usize = 50;
pub const MAX_PRESETS: usize = 10;
/// The repository file with link rules (relative to the root).
pub const LINKS_FILE: &str = ".forkyard/links.json";
/// Larger repository files are ignored.
const MAX_FILE_BYTES: usize = 64 * 1024;
const MAX_KEYS: usize = 10;
const MAX_KEY_LEN: usize = 10;
const MAX_ID_LEN: usize = 64;
const MAX_URL_LEN: usize = 2000;

pub fn preset_name(kind: LinkPresetKind) -> &'static str {
    match kind {
        LinkPresetKind::Jira => "Jira",
        LinkPresetKind::Linear => "Linear",
        LinkPresetKind::Youtrack => "YouTrack",
        LinkPresetKind::Redmine => "Redmine",
    }
}

/// Address of a tracker: http(s), a host without a user name, no `$`, `?` or `#`; without a trailing slash.
pub fn check_base_url(input: &str) -> Result<String, String> {
    let url = input.trim().trim_end_matches('/');
    if url.len() > MAX_URL_LEN {
        return Err(format!("The address is longer than {MAX_URL_LEN} characters."));
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("The address must not contain spaces.".into());
    }
    let lower = url.to_ascii_lowercase();
    let Some(rest) = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://")) else {
        return Err("The address must start with http:// or https://.".into());
    };
    let host = rest.split('/').next().unwrap_or("");
    if host.is_empty() || host.contains('@') {
        return Err("The address needs a host, without a user name.".into());
    }
    if rest.contains(['$', '?', '#']) {
        return Err("The address must not contain “$”, “?” or “#”.".into());
    }
    Ok(url.to_string())
}

/// Address template of a rule. The host must be written out in full before the first placeholder
/// (otherwise the commit text could pick the target), `$n` must not exceed the pattern's groups.
pub fn check_url_template(url: &str, groups: usize) -> Result<String, String> {
    let url = url.trim();
    if url.len() > MAX_URL_LEN {
        return Err(format!("The address is longer than {MAX_URL_LEN} characters."));
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("The address must not contain spaces or control characters.".into());
    }
    let lower = url.to_ascii_lowercase();
    let Some(rest) = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://")) else {
        return Err("The address must start with http:// or https://.".into());
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    if host.is_empty() || host.contains(['$', '@']) {
        return Err("The address needs a fixed host before the first placeholder, e.g. https://tracker.example/browse/$0.".into());
    }
    let bytes = url.as_bytes();
    let mut at = 0;
    while let Some(found) = url[at..].find('$') {
        let dollar = at + found;
        match bytes.get(dollar + 1) {
            Some(digit) if digit.is_ascii_digit() => {
                let n = usize::from(digit - b'0');
                if n > groups {
                    return Err(format!("The address uses ${n}, but the pattern has only {groups} group(s)."));
                }
                at = dollar + 2;
            }
            _ => return Err("A “$” must be followed by a group number ($0 to $9).".into()),
        }
    }
    Ok(url.to_string())
}

/// Project key: a capital letter, then up to nine capital letters, digits or `_`.
fn valid_key(key: &str) -> bool {
    let mut chars = key.chars();
    key.len() <= MAX_KEY_LEN
        && chars.next().is_some_and(|c| c.is_ascii_uppercase())
        && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= MAX_ID_LEN && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Checks the stored config before saving and brings it into its canonical form (trimmed, keys in
/// capitals without duplicates). Errors: `not_allowed` with the reason and the position.
pub fn normalize_config(config: &LinkRulesConfig) -> CoreResult<LinkRulesConfig> {
    if config.presets.len() > MAX_PRESETS {
        return Err(CoreError::not_allowed(format!("At most {MAX_PRESETS} trackers are allowed.")));
    }
    if config.custom.len() > MAX_RULES {
        return Err(CoreError::not_allowed(format!("At most {MAX_RULES} own rules are allowed.")));
    }
    let mut presets = Vec::with_capacity(config.presets.len());
    for preset in &config.presets {
        let name = preset_name(preset.kind);
        let base_url = check_base_url(&preset.base_url).map_err(|reason| CoreError::not_allowed(format!("{name}: {reason}")))?;
        let mut keys: Vec<String> = Vec::new();
        if preset.kind != LinkPresetKind::Redmine {
            for raw in &preset.keys {
                let key = raw.trim().to_ascii_uppercase();
                if !valid_key(&key) {
                    return Err(CoreError::not_allowed(format!(
                        "{name}: “{key}” is not a project key (a capital letter, then up to nine capital letters, digits or “_”)."
                    )));
                }
                if !keys.contains(&key) {
                    keys.push(key);
                }
            }
            if keys.len() > MAX_KEYS {
                return Err(CoreError::not_allowed(format!("{name}: at most {MAX_KEYS} project keys.")));
            }
        }
        presets.push(LinkPreset { kind: preset.kind, base_url, keys });
    }
    let mut ids = HashSet::new();
    let mut custom = Vec::with_capacity(config.custom.len());
    for (index, rule) in config.custom.iter().enumerate() {
        let position = index + 1;
        let id = rule.id.trim().to_string();
        if !valid_id(&id) {
            return Err(CoreError::not_allowed(format!("Rule {position}: the ID must be 1 to {MAX_ID_LEN} letters, digits, “-” or “_”.")));
        }
        if !ids.insert(id.clone()) {
            return Err(CoreError::not_allowed(format!("Rule {position}: the ID “{id}” is used twice.")));
        }
        let groups = check_pattern(&rule.pattern).map_err(|reason| CoreError::not_allowed(format!("Rule {position}: {reason}")))?;
        let url = check_url_template(&rule.url, groups).map_err(|reason| CoreError::not_allowed(format!("Rule {position}: {reason}")))?;
        custom.push(CustomLinkRule { id, pattern: rule.pattern.clone(), url });
    }
    Ok(LinkRulesConfig { host_rules: config.host_rules, presets, custom })
}

fn preset_id(kind: LinkPresetKind) -> &'static str {
    match kind {
        LinkPresetKind::Jira => "jira",
        LinkPresetKind::Linear => "linear",
        LinkPresetKind::Youtrack => "youtrack",
        LinkPresetKind::Redmine => "redmine",
    }
}

/// Pattern and address of a preset (`base_url` already checked, without trailing slash).
fn preset_rule(kind: LinkPresetKind, base_url: &str, keys: &[String]) -> (String, String) {
    let keys: Vec<&str> = keys.iter().map(String::as_str).filter(|key| valid_key(key)).collect();
    let key_pattern = if keys.is_empty() { r"\b[A-Z][A-Z0-9]+-\d+\b".to_string() } else { format!(r"\b(?:{})-\d+\b", keys.join("|")) };
    match kind {
        LinkPresetKind::Jira => (key_pattern, format!("{base_url}/browse/$0")),
        LinkPresetKind::Linear | LinkPresetKind::Youtrack => (key_pattern, format!("{base_url}/issue/$0")),
        LinkPresetKind::Redmine => (r"#(\d+)\b".to_string(), format!("{base_url}/issues/$1")),
    }
}

/// `#123` (and `!123` on GitLab) for the repository on its host. New hosts need an arm here.
pub fn host_rules(kind: HostKind, web_url: &str) -> Vec<LinkRule> {
    let rule = |id: &str, pattern: &str, url: String| LinkRule { id: id.to_string(), source: LinkRuleSource::Host, pattern: pattern.to_string(), url };
    match kind {
        HostKind::Github => vec![rule("host:issue", r"#(\d+)\b", format!("{web_url}/issues/$1"))],
        HostKind::Gitlab => vec![
            rule("host:issue", r"#(\d+)\b", format!("{web_url}/-/issues/$1")),
            rule("host:merge_request", r"!(\d+)\b", format!("{web_url}/-/merge_requests/$1")),
        ],
    }
}

/// Own rules and presets from the settings. They were checked on saving; whatever no longer
/// passes (a stricter check after an update) is skipped silently.
fn stored_rules(config: &LinkRulesConfig) -> Vec<LinkRule> {
    let mut rules = Vec::new();
    for rule in &config.custom {
        let Ok(groups) = check_pattern(&rule.pattern) else { continue };
        let Ok(url) = check_url_template(&rule.url, groups) else { continue };
        rules.push(LinkRule { id: format!("custom:{}", rule.id), source: LinkRuleSource::Custom, pattern: rule.pattern.clone(), url });
    }
    for (index, preset) in config.presets.iter().enumerate() {
        let Ok(base_url) = check_base_url(&preset.base_url) else { continue };
        let (pattern, url) = preset_rule(preset.kind, &base_url, &preset.keys);
        rules.push(LinkRule { id: format!("preset:{}:{index}", preset_id(preset.kind)), source: LinkRuleSource::Preset, pattern, url });
    }
    rules
}

#[derive(Deserialize)]
struct LinksFile {
    version: u32,
    #[serde(default)]
    rules: Vec<serde_json::Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileRule {
    #[serde(default)]
    id: Option<String>,
    pattern: String,
    url: String,
}

fn whole(message: String) -> LinkRuleProblem {
    LinkRuleProblem { index: None, message: redact(&message) }
}

fn too_large() -> String {
    format!("{LINKS_FILE} is larger than 64 KiB and is ignored.")
}

/// Rules of the repository file, each one checked on its own. Format:
/// `{ "version": 1, "rules": [ { "id"?: "…", "pattern": "…", "url": "…" } ] }`.
fn parse_file(bytes: &[u8]) -> (Vec<LinkRule>, Vec<LinkRuleProblem>) {
    let mut problems = Vec::new();
    if bytes.len() > MAX_FILE_BYTES {
        problems.push(whole(too_large()));
        return (Vec::new(), problems);
    }
    let file: LinksFile = match serde_json::from_slice(bytes) {
        Ok(file) => file,
        Err(error) => {
            problems.push(whole(format!("{LINKS_FILE} cannot be read ({error}).")));
            return (Vec::new(), problems);
        }
    };
    if file.version != 1 {
        problems.push(whole(format!("{LINKS_FILE} has version {}; this version of Forkyard reads version 1.", file.version)));
        return (Vec::new(), problems);
    }
    let mut rules: Vec<LinkRule> = Vec::new();
    for (index, raw) in file.rules.into_iter().enumerate() {
        let mut problem = |message: String| problems.push(LinkRuleProblem { index: Some(u32::try_from(index).unwrap_or(u32::MAX)), message: redact(&message) });
        if rules.len() >= MAX_RULES {
            problem(format!("More than {MAX_RULES} rules; the rest is ignored."));
            break;
        }
        let rule: FileRule = match serde_json::from_value(raw) {
            Ok(rule) => rule,
            Err(error) => {
                problem(format!("Not a rule ({error})."));
                continue;
            }
        };
        let groups = match check_pattern(&rule.pattern) {
            Ok(groups) => groups,
            Err(reason) => {
                problem(reason);
                continue;
            }
        };
        let url = match check_url_template(&rule.url, groups) {
            Ok(url) => url,
            Err(reason) => {
                problem(reason);
                continue;
            }
        };
        let id = match rule.id.map(|id| id.trim().to_string()) {
            Some(id) if valid_id(&id) => format!("file:{id}"),
            Some(_) => {
                problem(format!("The ID must be 1 to {MAX_ID_LEN} letters, digits, “-” or “_”."));
                continue;
            }
            None => format!("file:{}", index + 1),
        };
        if rules.iter().any(|existing| existing.id == id) {
            problem("The ID is used twice.".to_string());
            continue;
        }
        rules.push(LinkRule { id, source: LinkRuleSource::RepoFile, pattern: rule.pattern, url });
    }
    (rules, problems)
}

/// The file in the working directory, only if it really lies inside the repository.
async fn read_inside(root: &Path, path: &Path) -> Result<Vec<u8>, String> {
    let unreadable = || format!("{LINKS_FILE} cannot be read.");
    let (Ok(real_root), Ok(real)) = (tokio::fs::canonicalize(root).await, tokio::fs::canonicalize(path).await) else {
        return Err(unreadable());
    };
    if !real.starts_with(&real_root) {
        return Err(format!("{LINKS_FILE} points outside the repository and is ignored."));
    }
    let meta = tokio::fs::metadata(&real).await.map_err(|_| unreadable())?;
    if !meta.is_file() {
        return Err(format!("{LINKS_FILE} is not a file and is ignored."));
    }
    if meta.len() > MAX_FILE_BYTES as u64 {
        return Err(too_large());
    }
    tokio::fs::read(&real).await.map_err(|_| unreadable())
}

/// The repository file: from the working directory, otherwise from HEAD. `None`: neither has one
/// (also on an unborn HEAD).
async fn read_links_file(core: &Core, repo_id: &str) -> CoreResult<Option<(LinkFileOrigin, Result<Vec<u8>, String>)>> {
    let root = core.repo_path(repo_id)?;
    let path = root.join(LINKS_FILE);
    if tokio::fs::symlink_metadata(&path).await.is_ok() {
        return Ok(Some((LinkFileOrigin::Worktree, read_inside(&root, &path).await)));
    }
    let spec = format!("HEAD:{LINKS_FILE}");
    let size = core.git_for(repo_id)?.args(["cat-file", "-s", spec.as_str()]).read_only().no_log().run_raw().await?;
    if !size.success() {
        return Ok(None);
    }
    let bytes: u64 = size.stdout_text().trim().parse().unwrap_or(u64::MAX);
    if bytes > MAX_FILE_BYTES as u64 {
        return Ok(Some((LinkFileOrigin::Head, Err(too_large()))));
    }
    let blob = core.git_for(repo_id)?.args(["cat-file", "blob", spec.as_str()]).read_only().no_log().run_raw().await?;
    if !blob.success() {
        return Ok(None);
    }
    Ok(Some((LinkFileOrigin::Head, Ok(blob.stdout))))
}

/// Effective ticket link rules in order of precedence: own rules, presets, repository file, host.
/// Invalid entries of the repository file are skipped and listed in `problems`.
pub async fn link_rules_get(core: &Core, repo_id: String) -> CoreResult<LinkRules> {
    let stored = core.db.with(|c| {
        db::repos::require(c, &repo_id)?;
        db::repo_settings::get_all(c, &repo_id)
    })?;
    // Locked (untrusted) or missing repositories answer like every other read.
    core.repo_path(&repo_id)?;
    let config = stored
        .into_iter()
        .find(|(key, _)| key == "linkRules")
        .and_then(|(_, value)| serde_json::from_value::<LinkRulesConfig>(value).ok())
        .unwrap_or_default();
    let mut rules = stored_rules(&config);
    let mut problems = Vec::new();
    let mut file = None;
    if let Some((origin, content)) = read_links_file(core, &repo_id).await? {
        file = Some(origin);
        match content {
            Ok(bytes) => {
                let (found, issues) = parse_file(&bytes);
                rules.extend(found);
                problems.extend(issues);
            }
            Err(message) => problems.push(whole(message)),
        }
    }
    if config.host_rules {
        if let Some(found) = crate::host::resolve(core, &repo_id, None).await? {
            // The address comes from the remote URL (owner/name); it passes the same checks as any
            // other rule, so a `$` or a space in a remote path never reaches the UI.
            let checked = host_rules(found.detected.kind, &found.detected.web_url())
                .into_iter()
                .filter(|rule| check_pattern(&rule.pattern).and_then(|groups| check_url_template(&rule.url, groups)).is_ok());
            rules.extend(checked);
        }
    }
    Ok(LinkRules { rules, file, problems })
}

#[cfg(test)]
mod tests;
