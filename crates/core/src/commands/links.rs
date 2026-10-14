//! Ticket links: rules that turn references in commit messages (`#123`, `ABC-42` …) into links.
//! Four sources: the detected host, presets (Jira, Linear, YouTrack, Redmine), the user's own rules
//! (both stored in `repo_settings` under `linkRules`) and the repository file `.forkyard/links.json`.
//! The core only checks and collects the rules; the UI matches them. A link only opens the browser,
//! nothing runs – the repository file therefore needs no trust of its own.

mod pattern;

use std::collections::HashSet;

use crate::error::{CoreError, CoreResult};
use crate::model::{CustomLinkRule, LinkPreset, LinkPresetKind, LinkRulesConfig};

pub use pattern::{check_pattern, MAX_PATTERN_LEN};

/// At most this many own rules (and as many from the repository file).
pub const MAX_RULES: usize = 50;
pub const MAX_PRESETS: usize = 10;
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

#[cfg(test)]
mod tests;
