//! App, Repositories, Tabs

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "app.ts"))]
#[serde(rename_all = "snake_case")]
pub enum Platform {
    Windows,
    Linux,
    Macos,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Platform::Windows
        } else if cfg!(target_os = "macos") {
            Platform::Macos
        } else {
            Platform::Linux
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "app.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub platform: Platform,
    pub git_version: Option<String>,
    pub git_path: Option<String>,
    pub git_min_version: String,
    pub data_dir: String,
}

/// The UI's startup milestones (`app_startup_report`): times in ms since `time_origin`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "app.ts"))]
#[serde(rename_all = "camelCase")]
pub struct StartupReport {
    /// `performance.timeOrigin`: when the page started loading, Unix time in ms.
    pub time_origin: f64,
    pub marks: Vec<StartupMark>,
    /// Core calls made during the start.
    pub calls: Vec<StartupCall>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "app.ts"))]
#[serde(rename_all = "camelCase")]
pub struct StartupMark {
    pub name: String,
    pub at: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "app.ts"))]
#[serde(rename_all = "camelCase")]
pub struct StartupCall {
    pub command: String,
    pub start: f64,
    pub ms: f64,
}

/// A stable Forkyard release on GitHub (`update_check`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "app.ts"))]
#[serde(rename_all = "camelCase")]
pub struct UpdateRelease {
    /// Version without a leading `v`, e.g. `1.2.0`.
    pub version: String,
    /// Release page on GitHub; always starts with `https://github.com/abgebaumt/forkyard/`.
    pub url: String,
    /// Release notes as written (Markdown), shortened; the UI shows them as plain text only.
    pub notes: String,
    pub published_at: Option<String>,
}

/// Result of the update check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "app.ts"))]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// Version of this build.
    pub current: String,
    /// A newer stable release, if there is one (and the automatic check is on, or the check was manual).
    pub latest: Option<UpdateRelease>,
    /// Last attempt to ask GitHub (ISO-8601, UTC); `None` = never.
    pub checked_at: Option<String>,
    /// Version whose notice the user has already seen (shown once per version).
    pub notified_version: Option<String>,
    /// Version the user chose to skip: no notice for it at all.
    pub skipped_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "app.ts"))]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub id: Id,
    pub path: String,
    pub name: String,
    pub alias: Option<String>,
    pub is_favorite: bool,
    pub group_name: Option<String>,
    /// Lane colour 1–8 or null.
    pub color: Option<u8>,
    pub last_opened_at: Option<IsoTime>,
    pub missing: bool,
    /// `false`: the repository brings its own commands (hooks, entries in `.git/config`) and
    /// the user has not agreed yet. Until then the core rejects every command for this
    /// repository with `repo_untrusted`; `repo_trust_get` lists what was found.
    pub trusted: bool,
}

/// What would start programs or redirect connections in a repository without the user doing
/// anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "app.ts"))]
#[serde(rename_all = "snake_case")]
pub enum TrustFindingKind {
    /// Entry in the repository's configuration (`.git/config`).
    Config,
    /// Executable hook in the hooks folder.
    Hook,
    /// The configuration could not be read.
    Unreadable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "app.ts"))]
#[serde(rename_all = "camelCase")]
pub struct TrustFinding {
    pub kind: TrustFindingKind,
    /// Configuration key (`core.fsmonitor`) or name of the hook (`pre-commit`).
    pub name: String,
    /// Value of the entry, shortened and without credentials; `None` for hooks.
    pub value: Option<String>,
    /// One sentence on what it does.
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "app.ts"))]
#[serde(rename_all = "camelCase")]
pub struct RepoTrust {
    pub repo_id: Id,
    pub trusted: bool,
    /// What the check currently finds (also for a trusted repository).
    pub findings: Vec<TrustFinding>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "app.ts"))]
#[serde(rename_all = "snake_case")]
pub enum TabKind {
    Repo,
    Management,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "app.ts"))]
#[serde(rename_all = "camelCase")]
pub struct Tab {
    pub id: Id,
    pub kind: TabKind,
    pub repo_id: Option<Id>,
    pub position: u32,
    /// Active within its window: every window has exactly one active tab.
    pub is_active: bool,
    pub title: String,
    pub path: Option<String>,
    /// Label of the window the tab belongs to (`main` or `w-…`).
    pub window: String,
}

/// A profile, only for naming it (e.g. "belongs to …").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "app.ts"))]
#[serde(rename_all = "camelCase")]
pub struct ProfileRef {
    pub id: Id,
    pub name: String,
    /// Lane colour 1 to 8; `None` = by position.
    pub color: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "app.ts"))]
#[serde(rename_all = "camelCase")]
pub struct OpenedRepo {
    pub repo: Repo,
    pub tab: Tab,
    /// Something succeeded, but not completely (e.g. `repo_init`: the repository is created, a
    /// hook rejected the first commit). The UI shows this as a warning.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice: Option<OpenNotice>,
}

/// Note on an `OpenedRepo`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "app.ts"))]
#[serde(rename_all = "camelCase")]
pub struct OpenNotice {
    /// Human-readable sentence: what is missing and why.
    pub message: String,
    /// Output of Git or of the hook, if there was any.
    pub output: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "app.ts"))]
#[serde(rename_all = "camelCase")]
pub struct CloneOptions {
    pub depth: Option<u32>,
    pub shallow_since: Option<String>,
    pub branch: Option<String>,
    #[serde(default)]
    pub sparse_paths: Vec<String>,
    #[serde(default)]
    pub recurse_submodules: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "app.ts"))]
#[serde(rename_all = "camelCase")]
pub struct InitOptions {
    pub parent_path: String,
    pub name: String,
    pub default_branch: Option<String>,
    pub gitignore_template: Option<String>,
    pub license_template: Option<String>,
    pub create_readme: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "app.ts"))]
#[serde(rename_all = "camelCase")]
pub struct TemplateOption {
    pub key: String,
    pub label: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "app.ts"))]
#[serde(rename_all = "camelCase")]
pub struct InitTemplates {
    pub gitignore: Vec<TemplateOption>,
    pub licenses: Vec<TemplateOption>,
}

/// Request from outside: open this folder (and show the commit). The path is checked
/// (existing folder, complete), the commit is a SHA or `None`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "app.ts"))]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequest {
    pub path: String,
    pub commit: Option<Sha>,
    /// `true`: the request came as a `forkyard://` link – so possibly from a web page and
    /// not from the user. The UI then asks before it opens a folder that is
    /// not already in the list.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub from_link: bool,
    /// Why the request cannot be carried out; `None` = valid. `path` is then the
    /// path as it was requested (for display), and there is nothing to open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invalid: Option<LaunchInvalid>,
}

/// Reason why a request from outside cannot be carried out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "app.ts"))]
#[serde(rename_all = "snake_case")]
pub enum LaunchInvalid {
    /// The folder does not exist (or it is a file whose folder is missing).
    PathNotFound,
    /// A link names a network or device path (`\\server\…`, `\\?\…`). The app never opens such
    /// paths from a link and does not touch them either.
    PathNotAllowed,
}
