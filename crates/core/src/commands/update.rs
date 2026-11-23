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
//! - Installing (the shell's updater): only installable builds, only the version the UI showed.
//! - "What's new": the core hands each newer version out once (`lastSeenVersion`).

use std::sync::atomic::{AtomicBool, Ordering};
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
/// Key in `app_settings`: highest version whose "What's new" was handed out. Missing = new installation.
pub const LAST_SEEN_KEY: &str = "lastSeenVersion";

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
    /// This build may replace itself (set once by the shell).
    installable: AtomicBool,
    /// Debug builds: the version "What's new" sees instead of `current_version()`.
    version: parking_lot::Mutex<Option<String>>,
}

/// Sets the address of the API (tests, development build); `Some("")` turns the check off.
pub fn configure(core: &Core, base: Option<String>) {
    *core.state::<UpdateCheckState>().base.lock() = base.map(|base| base.trim_end_matches('/').to_string());
}

/// Whether this build may replace itself: Windows, macOS, or Linux started as an AppImage. On Linux
/// `appimage_build` must hold too (the binary is the AppImage bundle): a .deb or .rpm started from an
/// AppImage's terminal inherits `APPIMAGE`.
pub fn installable(os: &str, appimage: Option<&std::ffi::OsStr>, appimage_build: bool) -> bool {
    matches!(os, "windows" | "macos") || (os == "linux" && appimage_build && appimage.is_some_and(|path| !path.is_empty()))
}

/// Set once at start by the shell (`src-tauri`); default false.
pub fn configure_installable(core: &Core, installable: bool) {
    core.state::<UpdateCheckState>().installable.store(installable, Ordering::Relaxed);
}

/// Debug builds: the version the "What's new" logic sees instead of `current_version()`.
pub fn configure_version(core: &Core, version: Option<String>) {
    *core.state::<UpdateCheckState>().version.lock() = version;
}

fn is_installable(core: &Core) -> bool {
    core.state::<UpdateCheckState>().installable.load(Ordering::Relaxed)
}

/// `update_unavailable_for_package` unless installable.
pub fn ensure_installable(core: &Core) -> CoreResult<()> {
    if is_installable(core) {
        return Ok(());
    }
    Err(CoreError::new(
        ErrorCode::UpdateUnavailableForPackage,
        "This installation is managed by the package manager and cannot update itself; download the new version from the release page.",
    ))
}

/// `reported` (from `UpdateInfo.latest`) and `offered` (the plugin's) must be the same stable version, else `stale_state`.
pub fn check_reported(reported: &str, offered: &str) -> CoreResult<()> {
    match (stable_version(reported), stable_version(offered)) {
        (Some(reported), Some(offered)) if reported == offered => Ok(()),
        _ => Err(CoreError::new(ErrorCode::StaleState, "The release changed since the last check. Check for updates again.")),
    }
}

/// The version to show "What's new" for, once: missing or unreadable entry (new installation) →
/// remember `current`, nothing to show; lower than `current` → remember and show; same or higher
/// (downgrade) → keep the higher one. Read and write under one lock: the first window gets it.
pub(crate) fn whats_new_at(core: &Core, current: &str) -> CoreResult<Option<String>> {
    let current = current.trim();
    let Some(version) = any_version(current) else { return Ok(None) };
    core.db.with(|c| {
        let seen = db::app_settings::get(c, LAST_SEEN_KEY)?.and_then(|value| value.as_str().and_then(any_version));
        if seen.as_ref().is_some_and(|seen| *seen >= version) {
            return Ok(None);
        }
        db::app_settings::set(c, LAST_SEEN_KEY, &serde_json::Value::String(current.to_string()))?;
        Ok(seen.map(|_| current.to_string()))
    })
}

/// The version to show "What's new" for, once (see `whats_new_at`).
pub async fn update_whats_new(core: &Core) -> CoreResult<Option<String>> {
    let configured = core.state::<UpdateCheckState>().version.lock().clone();
    whats_new_at(core, configured.as_deref().unwrap_or(current_version()))
}

fn load(core: &Core) -> CoreResult<StoredState> {
    let value = core.db.with(|c| db::app_settings::get(c, STATE_KEY))?;
    // A broken entry is as good as none.
    Ok(value.and_then(|value| serde_json::from_value(value).ok()).unwrap_or_default())
}

fn save(core: &Core, state: &StoredState) -> CoreResult<()> {
    let value = serde_json::to_value(state)?;
    core.db.with(|c| db::app_settings::set(c, STATE_KEY, &value))
}

/// Any semver version (prereleases such as `1.3.0-dev` included), optionally with a leading `v`.
fn any_version(text: &str) -> Option<semver::Version> {
    let text = text.trim();
    semver::Version::parse(text.strip_prefix(['v', 'V']).unwrap_or(text)).ok()
}

/// `x.y.z` or `vx.y.z`; prereleases (`-rc.1`) and anything else do not count.
fn stable_version(tag: &str) -> Option<semver::Version> {
    any_version(tag).filter(|version| version.pre.is_empty())
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

/// At most `NOTES_MAX` bytes, cut after the last whole line (Markdown links and lists stay whole)
/// with `…` on its own line; a single overlong first line is cut at a character instead.
fn notes_excerpt(body: &str) -> String {
    let body = body.trim();
    if body.len() <= NOTES_MAX {
        return body.to_string();
    }
    let mut end = NOTES_MAX;
    while !body.is_char_boundary(end) {
        end -= 1;
    }
    match body[..end].rfind('\n') {
        Some(line_end) => format!("{}\n…", body[..line_end].trim_end()),
        None => format!("{}…", &body[..end]),
    }
}

/// What the UI gets: the remembered release only if it is newer than this build.
fn info(core: &Core, state: &StoredState, show: bool) -> UpdateInfo {
    let current = current_version();
    let newer = |release: &&UpdateRelease| match (stable_version(&release.version), any_version(current)) {
        (Some(latest), Some(current)) => latest > current,
        _ => false,
    };
    UpdateInfo {
        current: current.to_string(),
        latest: if show { state.release.as_ref().filter(newer).cloned() } else { None },
        checked_at: state.checked_at.clone(),
        notified_version: state.notified_version.clone(),
        skipped_version: state.skipped_version.clone(),
        installable: is_installable(core),
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
        return Err(CoreError::new(
            ErrorCode::HostRateLimited,
            "GitHub is limiting requests right now; the update check will try again later.",
        )
        .with_retry_at(response.retry_at()));
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
        return Ok(info(core, &state, show && !base.is_empty()));
    }
    state.checked_at = Some(util::now_iso());
    let result = fetch(core, &base).await;
    if let Ok(release) = &result {
        state.release = release.clone();
    }
    save(core, &state)?;
    result.map(|_| info(core, &state, show))
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
    Ok(info(core, &state, enabled))
}

#[cfg(test)]
mod tests;
