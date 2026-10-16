//! Finding coding-agent CLIs and the programs of agent templates – `claude`, `codex`, `opencode` or any
//! other name – with their version: an own configured path, then PATH, then the usual install folders,
//! then the PATH of the user's login shell (a desktop app often starts with a shorter PATH than the
//! terminal). The basis of `aiDetect` (1b) and of the agent templates (2a).
//!
//! Versions are remembered per path, size and modification time: a second look costs nothing until the
//! program is updated. The login shell's PATH is read at most once per app run, within two seconds,
//! without a terminal (`-l`, never `-i`, stdin empty). `--version` runs in an empty folder so a CLI
//! never reads a repository's configuration.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::OnceCell;

use crate::app::Core;
use crate::jobs::CancelToken;
use crate::proc::Proc;
use crate::util;

/// The coding-agent CLIs Forkyard knows by name.
pub const KNOWN_TOOLS: [&str; 3] = ["claude", "codex", "opencode"];
const VERSION_TIMEOUT: Duration = Duration::from_secs(2);
const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(2);
const MARK: &[u8] = b"__FY__";
const SMALL_OUTPUT: usize = 64 * 1024;

/// Lives in `crate::model` since the AI setup sends it to the UI (Teilpaket 1b).
pub use crate::model::ToolSource;

/// A located program.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub name: String,
    pub path: PathBuf,
    /// From `--version`; `None` if the program gave none within two seconds.
    pub version: Option<String>,
    pub source: ToolSource,
}

/// The parts of the environment the install folders depend on.
#[derive(Debug, Clone, Default)]
pub struct LocateEnv {
    pub home: Option<PathBuf>,
    pub app_data: Option<PathBuf>,
    pub local_app_data: Option<PathBuf>,
    pub user_profile: Option<PathBuf>,
    pub npm_prefix: Option<PathBuf>,
    pub windows: bool,
    pub macos: bool,
}

impl LocateEnv {
    pub fn current() -> LocateEnv {
        let var = |name: &str| std::env::var_os(name).filter(|value| !value.is_empty()).map(PathBuf::from);
        LocateEnv {
            home: dirs::home_dir(),
            app_data: var("APPDATA"),
            local_app_data: var("LOCALAPPDATA"),
            user_profile: var("USERPROFILE"),
            npm_prefix: var("NPM_CONFIG_PREFIX"),
            windows: cfg!(windows),
            macos: cfg!(target_os = "macos"),
        }
    }
}

/// Where `locate_in` looks.
#[derive(Debug, Clone, Default)]
pub struct SearchSpec {
    /// An own path from the settings.
    pub configured: Option<PathBuf>,
    /// Like PATH.
    pub path_var: Option<OsString>,
    /// Install folders, in this order.
    pub known: Vec<PathBuf>,
    /// The login shell's PATH.
    pub login_path: Option<OsString>,
}

/// The folders the CLIs install themselves into, in this order.
pub fn known_locations(name: &str, env: &LocateEnv) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if env.windows {
        if let Some(profile) = &env.user_profile {
            out.push(profile.join(".local").join("bin"));
        }
        if let Some(app_data) = &env.app_data {
            out.push(app_data.join("npm"));
        }
        if let Some(local) = &env.local_app_data {
            out.push(local.join("Programs").join(name));
            out.push(local.join("Programs").join(name).join("bin"));
        }
        if let Some(prefix) = &env.npm_prefix {
            out.push(prefix.clone());
        }
    } else {
        if let Some(home) = &env.home {
            for dir in [".local", ".opencode", ".bun", ".npm-global"] {
                out.push(home.join(dir).join("bin"));
            }
        }
        if let Some(prefix) = &env.npm_prefix {
            out.push(prefix.join("bin"));
        }
        if env.macos {
            out.push(PathBuf::from("/opt/homebrew/bin"));
        }
        out.push(PathBuf::from("/usr/local/bin"));
    }
    out
}

/// The program `name` in `dir`; on Windows `.exe` before `.cmd` and `.bat`.
fn program_in(dir: &Path, name: &str) -> Option<PathBuf> {
    if cfg!(windows) {
        ["exe", "cmd", "bat"].iter().map(|ext| dir.join(format!("{name}.{ext}"))).find(|path| path.is_file())
    } else {
        Some(dir.join(name)).filter(|path| path.is_file())
    }
}

/// The first version number in a `--version` output ("codex-cli 0.162.0" → "0.162.0").
pub fn parse_version(output: &str) -> Option<String> {
    let pattern = regex::Regex::new(r"\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?").ok()?;
    pattern.find(output).map(|found| found.as_str().to_string())
}

/// Arguments for `$SHELL` that print its PATH between markers (fish joins its list itself).
pub fn login_shell_args(shell: &Path) -> Vec<String> {
    let name = shell.file_name().map(|name| name.to_string_lossy().to_lowercase()).unwrap_or_default();
    let script = if name == "fish" { "printf \"__FY__%s__FY__\" (string join : $PATH)" } else { "printf \"__FY__%s__FY__\" \"$PATH\"" };
    vec!["-l".to_string(), "-c".to_string(), script.to_string()]
}

/// The text between the two markers – whatever the shell's profile printed around it.
pub fn parse_marked_path(stdout: &[u8]) -> Option<OsString> {
    let find = |haystack: &[u8]| haystack.windows(MARK.len()).position(|window| window == MARK);
    let start = find(stdout)? + MARK.len();
    let end = start + find(&stdout[start..])?;
    let value = &stdout[start..end];
    (!value.is_empty()).then(|| util::bytes_to_os(value))
}

/// Size, modification time and the version read for them.
type VersionStamp = (u64, Option<SystemTime>, Option<String>);

#[derive(Default)]
struct LocateState {
    /// path → stamp
    versions: Mutex<HashMap<PathBuf, VersionStamp>>,
    login_path: OnceCell<Option<OsString>>,
}

/// A fresh empty folder under the data folder; removed by the caller.
fn fresh_dir(core: &Core) -> Option<PathBuf> {
    let dir = core.data_dir().join("tmp").join(format!("locate-{}", util::new_id()));
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// Asks `shell` (as a login shell, without a terminal) for its PATH.
pub async fn login_shell_path_from(core: &Core, shell: &Path) -> Option<OsString> {
    let dir = fresh_dir(core)?;
    let out = Proc::new(shell).args(login_shell_args(shell)).cwd(&dir).timeout(LOGIN_SHELL_TIMEOUT).max_output(SMALL_OUTPUT, SMALL_OUTPUT).run(&CancelToken::new()).await;
    let _ = std::fs::remove_dir_all(&dir);
    parse_marked_path(&out.ok()?.stdout)
}

/// The PATH of the user's login shell (`$SHELL`), read once per app run; `None` on Windows.
pub async fn login_shell_path(core: &Core) -> Option<OsString> {
    if cfg!(windows) {
        return None;
    }
    let state = core.state::<LocateState>();
    state
        .login_path
        .get_or_init(|| async {
            let shell = std::env::var_os("SHELL").map(PathBuf::from).filter(|shell| shell.is_absolute())?;
            login_shell_path_from(core, &shell).await
        })
        .await
        .clone()
}

/// The version of the program at `path` (`--version`), remembered per path, size and modification time.
pub async fn version_of(core: &Core, path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    let stamp = (meta.len(), meta.modified().ok());
    let state = core.state::<LocateState>();
    if let Some((len, modified, version)) = state.versions.lock().get(path) {
        if (*len, *modified) == stamp {
            return version.clone();
        }
    }
    let dir = fresh_dir(core)?;
    let out = Proc::new(path).arg("--version").cwd(&dir).timeout(VERSION_TIMEOUT).max_output(SMALL_OUTPUT, SMALL_OUTPUT).run(&CancelToken::new()).await;
    let _ = std::fs::remove_dir_all(&dir);
    let version = out.ok().and_then(|out| parse_version(&String::from_utf8_lossy(&out.stdout)).or_else(|| parse_version(&String::from_utf8_lossy(&out.stderr))));
    state.versions.lock().insert(path.to_path_buf(), (stamp.0, stamp.1, version.clone()));
    version
}

fn find(name: &str, spec: &SearchSpec) -> Option<(PathBuf, ToolSource)> {
    if let Some(path) = spec.configured.as_ref().filter(|path| path.is_file()) {
        return Some((path.clone(), ToolSource::Configured));
    }
    let cwd = std::env::temp_dir();
    if let Some(path) = spec.path_var.as_ref().and_then(|paths| which::which_in(name, Some(paths), &cwd).ok()) {
        return Some((path, ToolSource::Path));
    }
    if let Some(path) = spec.known.iter().find_map(|dir| program_in(dir, name)) {
        return Some((path, ToolSource::KnownLocation));
    }
    spec.login_path.as_ref().and_then(|paths| which::which_in(name, Some(paths), &cwd).ok()).map(|path| (path, ToolSource::LoginShell))
}

/// Looks for `name` in `spec` (configured → PATH → install folders → login shell) and reads its version.
pub async fn locate_in(core: &Core, name: &str, spec: &SearchSpec) -> Option<ToolInfo> {
    let (path, source) = find(name, spec)?;
    let version = version_of(core, &path).await;
    Some(ToolInfo { name: name.to_string(), path, version, source })
}

/// `locate_in` with this machine's PATH and install folders; the login shell is only asked when
/// nothing else found the program.
pub async fn locate(core: &Core, name: &str, configured: Option<&Path>) -> Option<ToolInfo> {
    let env = LocateEnv::current();
    let spec = SearchSpec { configured: configured.map(Path::to_path_buf), path_var: std::env::var_os("PATH"), known: known_locations(name, &env), login_path: None };
    if find(name, &spec).is_some() {
        return locate_in(core, name, &spec).await;
    }
    let login_path = login_shell_path(core).await?;
    locate_in(core, name, &SearchSpec { login_path: Some(login_path), ..SearchSpec::default() }).await
}

/// `locate` for several names; those not found are left out.
pub async fn locate_all(core: &Core, names: &[&str]) -> Vec<ToolInfo> {
    let mut out = Vec::new();
    for name in names {
        if let Some(found) = locate(core, name, None).await {
            out.push(found);
        }
    }
    out
}

#[cfg(test)]
mod tests;
