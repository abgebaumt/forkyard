//! Connects GitHub with the login of the GitHub CLI (`gh auth token`), so nobody has to create
//! and paste a token. The token goes straight from gh into the keychain; it never reaches the UI,
//! a log or an error text.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use crate::app::Core;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::http;
use crate::model::{HostKind, HosterAccount};

use super::detect;

const TIMEOUT: Duration = Duration::from_secs(15);

/// Takes the token gh holds for github.com (or the GitHub Enterprise address) and connects with it.
pub async fn connect(core: &Core, base_url: Option<String>) -> CoreResult<HosterAccount> {
    let program = find().ok_or_else(|| {
        CoreError::new(ErrorCode::NotFound, "The GitHub CLI (gh) was not found. Install it from cli.github.com, or connect with a token.")
    })?;
    let web_base = detect::normalize_base_url(HostKind::Github, base_url.as_deref())?;
    let host = http::Target::parse(&web_base)?.host;
    let token = token_from(&program, &host).await?;
    super::connect(core, HostKind::Github, base_url, token).await
}

/// gh on the PATH or in the usual install locations.
fn find() -> Option<PathBuf> {
    if let Ok(path) = which::which("gh") {
        return Some(path);
    }
    let mut candidates = Vec::new();
    if cfg!(windows) {
        for var in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
            if let Some(base) = std::env::var_os(var) {
                candidates.push(Path::new(&base).join("GitHub CLI").join("gh.exe"));
            }
        }
    } else {
        for path in ["/usr/bin/gh", "/usr/local/bin/gh", "/opt/homebrew/bin/gh", "/snap/bin/gh", "/home/linuxbrew/.linuxbrew/bin/gh"] {
            candidates.push(PathBuf::from(path));
        }
    }
    candidates.into_iter().find(|path| path.is_file())
}

/// Runs `gh auth token --hostname <host>`. Never prompts: without a login it fails.
async fn token_from(program: &Path, host: &str) -> CoreResult<String> {
    let mut command = tokio::process::Command::new(program);
    command
        .args(["auth", "token", "--hostname", host])
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(crate::git::runner::CREATE_NO_WINDOW);
    let not_signed_in = || CoreError::new(ErrorCode::HostAuthFailed, format!("The GitHub CLI is not signed in to {host}. Run “gh auth login” and try again."));
    let output = match tokio::time::timeout(TIMEOUT, command.output()).await {
        Err(_) => return Err(CoreError::new(ErrorCode::Timeout, "The GitHub CLI did not answer in time.")),
        Ok(Err(e)) => return Err(CoreError::io(format!("The GitHub CLI could not be started: {e}"))),
        Ok(Ok(output)) => output,
    };
    if !output.status.success() {
        return Err(not_signed_in());
    }
    let token = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if token.is_empty() || token.contains(char::is_whitespace) {
        return Err(not_signed_in());
    }
    Ok(token)
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use super::*;

    /// A stand-in for gh: a shell script with the given body.
    fn fake_gh(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("gh");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    /// `token_from`, but again while Linux still reports the fresh script as busy (ETXTBSY: another
    /// test thread forked while the file was open for writing).
    async fn run(gh: &Path, host: &str) -> CoreResult<String> {
        for _ in 0..20 {
            match token_from(gh, host).await {
                Err(e) if e.message.contains("busy") => tokio::time::sleep(Duration::from_millis(50)).await,
                other => return other,
            }
        }
        token_from(gh, host).await
    }

    #[tokio::test]
    async fn reads_the_token_for_the_host() {
        let dir = tempfile::tempdir().unwrap();
        let gh = fake_gh(dir.path(), r#"[ "$1 $2 $3 $4" = "auth token --hostname github.com" ] && [ "$GH_PROMPT_DISABLED" = 1 ] && echo "gho_madeUp123" || exit 9"#);
        assert_eq!(run(&gh, "github.com").await.unwrap(), "gho_madeUp123");
    }

    #[tokio::test]
    async fn a_missing_login_is_an_auth_error_without_gh_output() {
        let dir = tempfile::tempdir().unwrap();
        let gh = fake_gh(dir.path(), "echo 'no oauth token found for github.com' >&2; exit 1");
        let error = run(&gh, "github.com").await.unwrap_err();
        assert_eq!(error.code, ErrorCode::HostAuthFailed);
        assert!(error.message.contains("gh auth login"), "{}", error.message);
        let empty = fake_gh(dir.path(), "exit 0");
        assert_eq!(run(&empty, "github.com").await.unwrap_err().code, ErrorCode::HostAuthFailed);
    }
}
