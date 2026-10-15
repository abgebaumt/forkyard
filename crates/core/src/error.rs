//! Uniform error of the core. Arrives in the UI as
//! `{ code, message, gitOutput }` (see `CoreErrorData` in types.ts).

use serde::{Deserialize, Serialize};

use crate::git::redact;

/// Error codes, exactly like `ErrorCode` in src/core/types.ts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    NotARepo,
    PathNotFound,
    PathExists,
    GitMissing,
    GitTooOld,
    InvalidName,
    NameExists,
    NotFound,
    DirtyWorktree,
    Conflict,
    NothingToCommit,
    EmptyMessage,
    IdentityMissing,
    HookFailed,
    PushRejected,
    NoUpstream,
    NoRemote,
    AuthFailed,
    HostKeyUnknown,
    Offline,
    Timeout,
    StaleState,
    Locked,
    NotMerged,
    OperationInProgress,
    NoOperation,
    NotAllowed,
    NothingToUndo,
    Cancelled,
    Duplicate,
    Unsupported,
    Io,
    Unknown,
    /// No account is connected for the repository (or the host).
    HostNotConnected,
    /// The host rejects the token (invalid, expired, too few permissions).
    HostAuthFailed,
    /// Request limit of the host reached; the message names the time.
    HostRateLimited,
    /// The host does not know the repository, the pull request or the issue.
    HostNotFound,
    /// The host (or this kind of remote) cannot do this.
    HostUnsupported,
    /// The host rejected the request on content grounds (e.g. not mergeable).
    HostRejected,
    /// The host knows the token but does not allow it this (HTTP 403 without a limit).
    HostForbidden,
    /// The repository brings its own commands and the user has not agreed yet.
    RepoUntrusted,
    /// The repository belongs only to other profiles; it is only opened on explicit request.
    RepoOtherProfile,
    /// A bisect is already running in the repository.
    BisectActive,
    /// A command from the repository's `.forkyard/commands.json` that the user has not approved
    /// (or the file changed since the approval).
    CommandUntrusted,
    /// Git could not sign the commit or tag (key missing, signing program missing or failing).
    SigningFailed,
}

impl ErrorCode {
    /// All codes, for tests and cross-checks.
    pub const ALL: [ErrorCode; 45] = [
        ErrorCode::NotARepo,
        ErrorCode::PathNotFound,
        ErrorCode::PathExists,
        ErrorCode::GitMissing,
        ErrorCode::GitTooOld,
        ErrorCode::InvalidName,
        ErrorCode::NameExists,
        ErrorCode::NotFound,
        ErrorCode::DirtyWorktree,
        ErrorCode::Conflict,
        ErrorCode::NothingToCommit,
        ErrorCode::EmptyMessage,
        ErrorCode::IdentityMissing,
        ErrorCode::HookFailed,
        ErrorCode::PushRejected,
        ErrorCode::NoUpstream,
        ErrorCode::NoRemote,
        ErrorCode::AuthFailed,
        ErrorCode::HostKeyUnknown,
        ErrorCode::Offline,
        ErrorCode::Timeout,
        ErrorCode::StaleState,
        ErrorCode::Locked,
        ErrorCode::NotMerged,
        ErrorCode::OperationInProgress,
        ErrorCode::NoOperation,
        ErrorCode::NotAllowed,
        ErrorCode::NothingToUndo,
        ErrorCode::Cancelled,
        ErrorCode::Duplicate,
        ErrorCode::Unsupported,
        ErrorCode::Io,
        ErrorCode::Unknown,
        ErrorCode::HostNotConnected,
        ErrorCode::HostAuthFailed,
        ErrorCode::HostRateLimited,
        ErrorCode::HostNotFound,
        ErrorCode::HostUnsupported,
        ErrorCode::HostRejected,
        ErrorCode::HostForbidden,
        ErrorCode::RepoUntrusted,
        ErrorCode::RepoOtherProfile,
        ErrorCode::BisectActive,
        ErrorCode::CommandUntrusted,
        ErrorCode::SigningFailed,
    ];

    /// The code as text, as it appears in the JSON (`"not_a_repo"`).
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorCode::NotARepo => "not_a_repo",
            ErrorCode::PathNotFound => "path_not_found",
            ErrorCode::PathExists => "path_exists",
            ErrorCode::GitMissing => "git_missing",
            ErrorCode::GitTooOld => "git_too_old",
            ErrorCode::InvalidName => "invalid_name",
            ErrorCode::NameExists => "name_exists",
            ErrorCode::NotFound => "not_found",
            ErrorCode::DirtyWorktree => "dirty_worktree",
            ErrorCode::Conflict => "conflict",
            ErrorCode::NothingToCommit => "nothing_to_commit",
            ErrorCode::EmptyMessage => "empty_message",
            ErrorCode::IdentityMissing => "identity_missing",
            ErrorCode::HookFailed => "hook_failed",
            ErrorCode::PushRejected => "push_rejected",
            ErrorCode::NoUpstream => "no_upstream",
            ErrorCode::NoRemote => "no_remote",
            ErrorCode::AuthFailed => "auth_failed",
            ErrorCode::HostKeyUnknown => "host_key_unknown",
            ErrorCode::Offline => "offline",
            ErrorCode::Timeout => "timeout",
            ErrorCode::StaleState => "stale_state",
            ErrorCode::Locked => "locked",
            ErrorCode::NotMerged => "not_merged",
            ErrorCode::OperationInProgress => "operation_in_progress",
            ErrorCode::NoOperation => "no_operation",
            ErrorCode::NotAllowed => "not_allowed",
            ErrorCode::NothingToUndo => "nothing_to_undo",
            ErrorCode::Cancelled => "cancelled",
            ErrorCode::Duplicate => "duplicate",
            ErrorCode::Unsupported => "unsupported",
            ErrorCode::Io => "io",
            ErrorCode::Unknown => "unknown",
            ErrorCode::HostNotConnected => "host_not_connected",
            ErrorCode::HostAuthFailed => "host_auth_failed",
            ErrorCode::HostRateLimited => "host_rate_limited",
            ErrorCode::HostNotFound => "host_not_found",
            ErrorCode::HostUnsupported => "host_unsupported",
            ErrorCode::HostRejected => "host_rejected",
            ErrorCode::HostForbidden => "host_forbidden",
            ErrorCode::RepoUntrusted => "repo_untrusted",
            ErrorCode::RepoOtherProfile => "repo_other_profile",
            ErrorCode::BisectActive => "bisect_active",
            ErrorCode::CommandUntrusted => "command_untrusted",
            ErrorCode::SigningFailed => "signing_failed",
        }
    }
}

impl std::fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Error of the core. `message` is human-readable,
/// `git_output` the raw output of Git without credentials.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, thiserror::Error)]
#[serde(rename_all = "camelCase")]
#[error("{message} ({code})")]
pub struct CoreError {
    pub code: ErrorCode,
    pub message: String,
    pub git_output: Option<String>,
    /// Only for `host_rate_limited`: when it continues (ISO-8601, UTC), as far as the service
    /// names it. The UI shows the time in the user's time zone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_at: Option<String>,
}

pub type CoreResult<T> = Result<T, CoreError>;

/// Maximum length of `git_output`, so errors do not flood the UI.
const MAX_GIT_OUTPUT: usize = 64 * 1024;

impl CoreError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        CoreError { code, message: message.into(), git_output: None, retry_at: None }
    }

    /// Appends Git output; credentials are removed, very long output is shortened.
    pub fn with_git_output(mut self, output: impl AsRef<str>) -> Self {
        let text = redact::redact(output.as_ref());
        let text = crate::util::truncate_str(text.trim_end(), MAX_GIT_OUTPUT);
        self.git_output = if text.is_empty() { None } else { Some(text) };
        self
    }

    pub fn is(&self, code: ErrorCode) -> bool {
        self.code == code
    }

    /// Remembers the point in time from which a request limit is free again.
    pub fn with_retry_at(mut self, at: Option<String>) -> Self {
        self.retry_at = at;
        self
    }

    // --- Helper constructors ------------------------------------------------

    pub fn not_a_repo(path: impl std::fmt::Display) -> Self {
        Self::new(ErrorCode::NotARepo, format!("“{path}” is not a Git repository."))
    }
    pub fn path_not_found(path: impl std::fmt::Display) -> Self {
        Self::new(ErrorCode::PathNotFound, format!("The folder “{path}” was not found."))
    }
    pub fn path_exists(path: impl std::fmt::Display) -> Self {
        Self::new(ErrorCode::PathExists, format!("“{path}” already exists."))
    }
    pub fn git_missing() -> Self {
        Self::new(
            ErrorCode::GitMissing,
            "Git was not found. Please install Git 2.39 or later.",
        )
    }
    pub fn git_too_old(found: &str) -> Self {
        Self::new(
            ErrorCode::GitTooOld,
            format!("Git {found} is too old. At least version 2.39 is required."),
        )
    }
    pub fn invalid_name(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidName, message)
    }
    pub fn name_exists(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NameExists, message)
    }
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message)
    }
    pub fn not_allowed(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotAllowed, message)
    }
    pub fn repo_untrusted() -> Self {
        Self::new(
            ErrorCode::RepoUntrusted,
            "This repository brings its own commands (hooks or entries in its Git configuration). Until you allow this, Forkyard won’t run anything in it.",
        )
    }
    /// `names`: the profiles that list the repository.
    pub fn repo_other_profile(names: &[String]) -> Self {
        let list = names.iter().map(|n| format!("“{n}”")).collect::<Vec<_>>().join(", ");
        Self::new(ErrorCode::RepoOtherProfile, format!("The repository belongs to the profile {list}."))
    }
    pub fn command_untrusted() -> Self {
        Self::new(
            ErrorCode::CommandUntrusted,
            "This command comes from the repository’s .forkyard/commands.json, and you haven’t approved this version of the file. Review it in Settings under “Custom commands”.",
        )
    }
    pub fn stale_state() -> Self {
        Self::new(
            ErrorCode::StaleState,
            "The repository has changed in the meantime. The view is reloading; please try again.",
        )
    }
    pub fn locked(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Locked, message)
    }
    pub fn cancelled() -> Self {
        Self::new(ErrorCode::Cancelled, "Cancelled.")
    }
    pub fn timeout() -> Self {
        Self::new(ErrorCode::Timeout, "Timeout: Git took too long to respond.")
    }
    pub fn duplicate() -> Self {
        Self::new(ErrorCode::Duplicate, "This action has already been run or is still running.")
    }
    pub fn nothing_to_undo() -> Self {
        Self::new(ErrorCode::NothingToUndo, "There is nothing to undo.")
    }
    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Unsupported, message)
    }
    /// For commands that a later agent builds.
    pub fn not_built(command: &str) -> Self {
        Self::new(ErrorCode::Unsupported, format!("Not built yet: {command}"))
    }
    pub fn io(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Io, message)
    }
    pub fn unknown(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Unknown, message)
    }
}

/// What happened on a file error, in our own words. The operating system's text
/// (in the system's language, with "(os error N)") does not belong in a message; it is
/// in the output that can be expanded.
pub fn describe_io(e: &std::io::Error) -> (ErrorCode, &'static str) {
    use std::io::ErrorKind;
    const DENIED: &str = "Access denied: you don’t have permission for this file or folder, or another program currently has it open.";
    const IN_USE: &str = "The file is currently open in another program. Close it there and try again.";
    const TOO_LONG: &str = "The name or path is too long or invalid for the file system. Please choose a shorter name or a location with a shorter path.";
    const FULL: &str = "There is no space left on the disk.";
    #[cfg(windows)]
    let by_code = match e.raw_os_error() {
        Some(5) => Some((ErrorCode::Io, DENIED)),
        Some(32 | 33) => Some((ErrorCode::Io, IN_USE)),
        // 206: name too long; 123: name syntactically wrong; 267: directory name invalid (also: path too long).
        Some(206 | 123 | 267) => Some((ErrorCode::InvalidName, TOO_LONG)),
        Some(39 | 112) => Some((ErrorCode::Io, FULL)),
        _ => None,
    };
    #[cfg(not(windows))]
    let by_code = match e.raw_os_error() {
        // ENAMETOOLONG (Linux 36, macOS 63), ENOSPC (28), ETXTBSY (26).
        Some(36 | 63) => Some((ErrorCode::InvalidName, TOO_LONG)),
        Some(28) => Some((ErrorCode::Io, FULL)),
        Some(26) => Some((ErrorCode::Io, IN_USE)),
        _ => None,
    };
    if let Some(found) = by_code {
        return found;
    }
    match e.kind() {
        ErrorKind::NotFound => (ErrorCode::PathNotFound, "The file or folder was not found."),
        ErrorKind::AlreadyExists => (ErrorCode::PathExists, "The file or folder already exists."),
        ErrorKind::PermissionDenied => (ErrorCode::Io, DENIED),
        _ => (ErrorCode::Io, "The file or folder couldn’t be read or written."),
    }
}

impl From<std::io::Error> for CoreError {
    fn from(e: std::io::Error) -> Self {
        let (code, message) = describe_io(&e);
        Self::new(code, message).with_git_output(e.to_string())
    }
}

impl From<rusqlite::Error> for CoreError {
    fn from(e: rusqlite::Error) -> Self {
        Self::new(ErrorCode::Io, format!("Error in the app database: {e}"))
    }
}

impl From<serde_json::Error> for CoreError {
    fn from(e: serde_json::Error) -> Self {
        Self::new(ErrorCode::Unknown, format!("Invalid data: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_like_typescript() {
        let e = CoreError::new(ErrorCode::NotARepo, "x").with_git_output("fatal: https://u:geheim@host/r");
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["code"], "not_a_repo");
        assert_eq!(v["message"], "x");
        let out = v["gitOutput"].as_str().unwrap();
        assert!(!out.contains("geheim"), "{out}");
        let plain = serde_json::to_value(CoreError::cancelled()).unwrap();
        assert!(plain["gitOutput"].is_null());
    }

    #[test]
    fn all_codes_roundtrip() {
        for code in ErrorCode::ALL {
            let v = serde_json::to_value(code).unwrap();
            assert_eq!(v.as_str().unwrap(), code.as_str());
            let back: ErrorCode = serde_json::from_value(v).unwrap();
            assert_eq!(back, code);
        }
    }

    #[test]
    fn io_errors_map() {
        let e: CoreError = std::io::Error::new(std::io::ErrorKind::NotFound, "weg").into();
        assert_eq!(e.code, ErrorCode::PathNotFound);
    }

    /// No operating-system text and no "(os error N)" in the message, the
    /// reason is stated once.
    #[test]
    fn io_errors_are_described_in_own_words() {
        let denied: CoreError = std::io::Error::from(std::io::ErrorKind::PermissionDenied).into();
        assert_eq!(denied.code, ErrorCode::Io);
        assert_eq!(denied.message.matches("Access denied").count(), 1, "{}", denied.message);
        #[cfg(windows)]
        for (raw, code, word) in [(5, ErrorCode::Io, "Access denied"), (32, ErrorCode::Io, "another program"), (267, ErrorCode::InvalidName, "too long"), (123, ErrorCode::InvalidName, "too long"), (206, ErrorCode::InvalidName, "too long")] {
            let e: CoreError = std::io::Error::from_raw_os_error(raw).into();
            assert_eq!(e.code, code, "{raw}");
            assert!(e.message.contains(word) && !e.message.contains("os error"), "{raw}: {}", e.message);
            assert!(e.git_output.unwrap_or_default().contains("os error"), "the raw text stays in the output");
        }
    }

    #[test]
    fn command_untrusted_has_its_own_code() {
        let error = CoreError::command_untrusted();
        assert_eq!(serde_json::to_value(&error).unwrap()["code"], "command_untrusted");
        assert!(ErrorCode::ALL.contains(&ErrorCode::CommandUntrusted));
        assert!(error.message.contains(".forkyard/commands.json"), "{}", error.message);
    }
}
