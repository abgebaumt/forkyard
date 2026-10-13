//! Locate Git and check its version.

use std::path::{Path, PathBuf};

use crate::error::{CoreError, CoreResult};

/// Minimum version from the architecture.
pub const MIN_VERSION: (u32, u32, u32) = (2, 39, 0);
pub const MIN_VERSION_TEXT: &str = "2.39";

/// Located Git.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitInfo {
    pub path: PathBuf,
    pub version: (u32, u32, u32),
    /// e.g. "2.54.0"
    pub version_text: String,
}

/// Searches for git on the PATH and in the usual install locations.
pub fn find_git() -> Option<PathBuf> {
    if let Ok(p) = which::which("git") {
        return Some(p);
    }
    candidates().into_iter().find(|p| p.is_file())
}

fn candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if cfg!(windows) {
        for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            if let Some(base) = std::env::var_os(var) {
                out.push(Path::new(&base).join("Git").join("cmd").join("git.exe"));
                out.push(Path::new(&base).join("Git").join("bin").join("git.exe"));
            }
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            out.push(Path::new(&local).join("Programs").join("Git").join("cmd").join("git.exe"));
        }
        if let Some(home) = dirs::home_dir() {
            out.push(home.join("scoop").join("shims").join("git.exe"));
        }
    } else {
        for p in ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git", "/bin/git", "/snap/bin/git"] {
            out.push(PathBuf::from(p));
        }
    }
    out
}

/// Reads "git version 2.54.0.windows.1" (the only output without a plumbing alternative).
pub fn parse_version(output: &str) -> Option<(u32, u32, u32)> {
    let token = output.split_whitespace().find(|t| t.chars().next().is_some_and(|c| c.is_ascii_digit()))?;
    let mut parts = token.split('.').map(|p| p.chars().take_while(|c| c.is_ascii_digit()).collect::<String>());
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let patch = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    Some((major, minor, patch))
}

/// Runs `git --version` (synchronously, only at startup) and checks the minimum version.
pub fn probe(path: &Path) -> CoreResult<GitInfo> {
    require_min_version(probe_any(path)?)
}

/// `git_too_old` if the located Git is below the minimum version.
pub fn require_min_version(info: GitInfo) -> CoreResult<GitInfo> {
    if info.version < MIN_VERSION {
        return Err(CoreError::git_too_old(&info.version_text));
    }
    Ok(info)
}

/// Like `probe`, but without the minimum version: with a Git that is too old the UI should be
/// able to say which version was found where, instead of reporting "Git is missing".
pub fn probe_any(path: &Path) -> CoreResult<GitInfo> {
    let mut cmd = std::process::Command::new(path);
    cmd.arg("--version").env("LC_ALL", "C").stdin(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(super::runner::CREATE_NO_WINDOW);
    }
    let out = cmd.output().map_err(|_| CoreError::git_missing())?;
    if !out.status.success() {
        return Err(CoreError::git_missing());
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let version = parse_version(&text).ok_or_else(CoreError::git_missing)?;
    let version_text = format!("{}.{}.{}", version.0, version.1, version.2);
    Ok(GitInfo { path: path.to_path_buf(), version, version_text })
}

/// Locates and checks Git. Not found: `git_missing`; too old: `git_too_old`.
pub fn detect() -> CoreResult<GitInfo> {
    require_min_version(detect_any()?)
}

/// Locates Git without checking the minimum version.
pub fn detect_any() -> CoreResult<GitInfo> {
    let path = find_git().ok_or_else(CoreError::git_missing)?;
    probe_any(&path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert_eq!(parse_version("git version 2.54.0.windows.1"), Some((2, 54, 0)));
        assert_eq!(parse_version("git version 2.39.5 (Apple Git-154)"), Some((2, 39, 5)));
        assert_eq!(parse_version("git version 2.40"), Some((2, 40, 0)));
        assert_eq!(parse_version("nichts"), None);
        assert!((2, 38, 9) < MIN_VERSION);
    }

    #[test]
    fn finds_installed_git() {
        let info = detect().expect("git must be installed for the tests");
        assert!(info.version >= MIN_VERSION);
    }
}
