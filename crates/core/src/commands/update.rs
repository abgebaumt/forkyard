//! Update check against the GitHub releases of Forkyard.
//!
//! - One request: `GET https://api.github.com/repos/abgebaumt/forkyard/releases/latest` – GitHub
//!   only returns the newest stable release there (no drafts, no prereleases). No token, no
//!   cookies; the only thing it learns is the app version in the user agent (`Forkyard/<version>`).
//! - Automatic (`manual: false`): only while the setting `checkForUpdates` is on and at most once
//!   a day – the time of the last attempt is stored in `app_settings` and survives restarts.
//!   A failed attempt counts as well, so an offline machine does not ask again on every start.
//! - Manual: always asks.
//! - 404 (no release yet) counts as "up to date". 403/429 is `host_rate_limited`, no response
//!   `offline`/`timeout`; the UI keeps quiet about errors of the automatic check (the HTTP call
//!   is in the activity log anyway).
//! - Only tags that are a plain `x.y.z` (optionally with a leading `v`) count; the release page
//!   must lie under `https://github.com/abgebaumt/forkyard/`, since the UI opens it in the browser.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::app::Core;
use crate::commands::settings::load_settings;
use crate::db;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::http::{self, Request};
use crate::model::{UpdateInfo, UpdateRelease};
use crate::util;

/// Default address of the GitHub API.
pub const DEFAULT_BASE: &str = "https://api.github.com";
/// Every release page the UI may open starts with this.
pub const RELEASE_PAGE_PREFIX: &str = "https://github.com/abgebaumt/forkyard/";
/// Key in `app_settings` (not a `Settings` field).
pub const STATE_KEY: &str = "updateCheck";
/// Automatic checks at most this often.
pub const INTERVAL: Duration = Duration::from_secs(24 * 3600);
/// Longest release notes kept (bytes).
pub const NOTES_MAX: usize = 4000;

/// Version of this build.
pub fn current_version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

/// What is remembered between checks.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StoredState {
    pub checked_at: Option<String>,
    /// Newest stable release seen at the last successful check (may be the current version).
    pub release: Option<UpdateRelease>,
    pub notified_version: Option<String>,
    pub skipped_version: Option<String>,
}

/// Per attempt (and to connect): a check must never hold anything up.
const TIMEOUT: Duration = Duration::from_secs(8);
/// Label in the activity log and in error messages.
const LABEL: &str = "GitHub releases";

#[derive(Default)]
struct UpdateCheckState {
    /// Another address instead of GitHub (tests, development build); `Some("")` turns the check off.
    base: parking_lot::Mutex<Option<String>>,
    /// One check at a time: a second automatic check that waited sees the fresh time and skips.
    running: tokio::sync::Mutex<()>,
}

/// Sets the address of the API (tests, development build); `Some("")` turns the check off.
pub fn configure(core: &Core, base: Option<String>) {
    *core.state::<UpdateCheckState>().base.lock() = base.map(|base| base.trim_end_matches('/').to_string());
}

fn load(core: &Core) -> CoreResult<StoredState> {
    let value = core.db.with(|c| Ok(db::app_settings::get_all(c)?.into_iter().find(|(key, _)| key == STATE_KEY).map(|(_, value)| value)))?;
    // A broken entry is as good as none.
    Ok(value.and_then(|value| serde_json::from_value(value).ok()).unwrap_or_default())
}

fn save(core: &Core, state: &StoredState) -> CoreResult<()> {
    let value = serde_json::to_value(state)?;
    core.db.with(|c| db::app_settings::set(c, STATE_KEY, &value))
}

/// `x.y.z` or `vx.y.z`; prereleases (`-rc.1`) and anything else do not count.
fn stable_version(tag: &str) -> Option<semver::Version> {
    let plain = tag.trim().strip_prefix(['v', 'V']).unwrap_or(tag.trim());
    let version = semver::Version::parse(plain).ok()?;
    version.pre.is_empty().then_some(version)
}

/// The release page lies under the project on github.com and is a plain address.
fn valid_page(url: &str) -> bool {
    url.len() <= 512
        && url.starts_with(RELEASE_PAGE_PREFIX)
        && url.len() > RELEASE_PAGE_PREFIX.len()
        // No dot segments, not even encoded: the browser would leave the project with them.
        && !url.contains("..")
        && !url.to_ascii_lowercase().contains("%2e")
        && url.bytes().all(|b| b.is_ascii_graphic() && !matches!(b, b'"' | b'\\' | b'<' | b'>' | b'`' | b'@'))
}

fn notes_excerpt(body: &str) -> String {
    let body = body.trim();
    if body.len() <= NOTES_MAX {
        return body.to_string();
    }
    let mut end = NOTES_MAX;
    while !body.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &body[..end])
}

/// What the UI gets: the remembered release only if it is newer than this build.
fn info(state: &StoredState, show: bool) -> UpdateInfo {
    let current = current_version();
    let newer = |release: &&UpdateRelease| match (stable_version(&release.version), semver::Version::parse(current)) {
        (Some(latest), Ok(current)) => latest > current,
        _ => false,
    };
    UpdateInfo {
        current: current.to_string(),
        latest: if show { state.release.as_ref().filter(newer).cloned() } else { None },
        checked_at: state.checked_at.clone(),
        notified_version: state.notified_version.clone(),
        skipped_version: state.skipped_version.clone(),
    }
}

fn due(state: &StoredState) -> bool {
    let Some(last) = state.checked_at.as_deref().and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok()) else { return true };
    let age = chrono::Utc::now().signed_duration_since(last);
    // A time in the future (clock set back) does not block the check for good.
    age < chrono::Duration::zero() || age.to_std().map(|age| age >= INTERVAL).unwrap_or(true)
}

#[derive(Deserialize)]
struct GitHubRelease {
    #[serde(default)]
    tag_name: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
}

/// Asks GitHub. `Ok(None)`: no stable release (yet).
async fn fetch(core: &Core, base: &str) -> CoreResult<Option<UpdateRelease>> {
    let url = format!("{base}/repos/abgebaumt/forkyard/releases/latest");
    let request = Request::get(url, LABEL)
        .header("accept", "application/vnd.github+json")
        .header("user-agent", format!("Forkyard/{}", current_version()))
        .alias("https://github.com")
        .quick(TIMEOUT, 1);
    let response = http::send(core, request).await?;
    if response.status == 404 {
        return Ok(None);
    }
    if response.is_rate_limited() || response.status == 403 || response.status == 429 {
        return Err(CoreError::new(ErrorCode::HostRateLimited, "GitHub is limiting requests right now; the update check will try again later.").with_retry_at(response.retry_at()));
    }
    if !response.is_success() {
        return Err(CoreError::unknown(format!("The update check failed (GitHub answered with HTTP {}).", response.status)));
    }
    let release: GitHubRelease = response.json()?;
    let Some(version) = stable_version(&release.tag_name) else { return Ok(None) };
    if release.draft || release.prerelease {
        return Ok(None);
    }
    if !valid_page(&release.html_url) {
        return Err(CoreError::not_allowed("The update check got an unexpected address for the release page and ignored it."));
    }
    Ok(Some(UpdateRelease {
        version: version.to_string(),
        url: release.html_url,
        notes: notes_excerpt(release.body.as_deref().unwrap_or("")),
        published_at: release.published_at.filter(|at| chrono::DateTime::parse_from_rfc3339(at).is_ok()),
    }))
}

/// `manual: false` is the automatic check (setting and once a day); `manual: true` always asks.
pub async fn update_check(core: &Core, manual: bool) -> CoreResult<UpdateInfo> {
    let check = core.state::<UpdateCheckState>();
    let _running = check.running.lock().await;
    let enabled = load_settings(core)?.check_for_updates;
    let mut state = load(core)?;
    let base = check.base.lock().clone().unwrap_or_else(|| DEFAULT_BASE.to_string());
    let show = enabled || manual;
    if base.is_empty() || (!manual && (!enabled || !due(&state))) {
        return Ok(info(&state, show && !base.is_empty()));
    }
    state.checked_at = Some(util::now_iso());
    let result = fetch(core, &base).await;
    if let Ok(release) = &result {
        state.release = release.clone();
    }
    save(core, &state)?;
    result.map(|_| info(&state, show))
}

/// The user has seen the notice for `version` (`skip: false`) or wants no notice for it at all
/// (`skip: true`).
pub async fn update_dismiss(core: &Core, version: String, skip: bool) -> CoreResult<UpdateInfo> {
    let Some(version) = stable_version(&version).map(|v| v.to_string()).filter(|v| *v == version.trim()) else {
        return Err(CoreError::not_allowed(format!("“{}” is not a version number.", util::truncate_str(&version, 40))));
    };
    let check = core.state::<UpdateCheckState>();
    let _running = check.running.lock().await;
    let enabled = load_settings(core)?.check_for_updates;
    let mut state = load(core)?;
    state.notified_version = Some(version.clone());
    if skip {
        state.skipped_version = Some(version);
    }
    save(core, &state)?;
    Ok(info(&state, enabled))
}

#[cfg(test)]
mod tests;
