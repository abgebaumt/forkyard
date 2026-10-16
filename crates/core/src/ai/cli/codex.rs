//! Codex (`codex`, checked with codex-cli 0.162.0): `codex exec -C <tmp> --skip-git-repo-check
//! --sandbox read-only --ephemeral --ignore-rules --output-schema <tmp>/schema.json -o
//! <tmp>/out.json --json [-m <m>] -`, prompt on stdin. Sign-in: `codex login status`.

use super::{Flag, LoginInfo};
use crate::model::AiLoginState;
use crate::proc::ProcOutput;

pub const HELP_ARGS: [&str; 2] = ["exec", "--help"];
pub const STATUS_ARGS: [&str; 2] = ["login", "status"];
pub const LOGIN_ARGS: [&str; 1] = ["login"];
/// Another working folder, no Git repository needed, read-only sandbox, no stored session, no
/// execpolicy rules, answer into a file, events as JSON.
pub const SAFETY: [Flag; 7] = [
    Flag { name: "--cd", tokens: &["--cd"] },
    Flag { name: "--skip-git-repo-check", tokens: &["--skip-git-repo-check"] },
    Flag { name: "--sandbox", tokens: &["--sandbox"] },
    Flag { name: "--ephemeral", tokens: &["--ephemeral"] },
    Flag { name: "--ignore-rules", tokens: &["--ignore-rules"] },
    Flag { name: "--output-last-message", tokens: &["--output-last-message"] },
    Flag { name: "--json", tokens: &["--json"] },
];
pub const SCHEMA: Flag = Flag { name: "--output-schema", tokens: &["--output-schema"] };
pub const MODEL: Flag = Flag { name: "--model", tokens: &["--model"] };

pub fn parse_login(out: &ProcOutput) -> LoginInfo {
    let text = format!("{}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if text.to_lowercase().contains("not logged in") {
        return LoginInfo { state: AiLoginState::LoggedOut, method: None };
    }
    match text.lines().map(str::trim).find(|line| line.starts_with("Logged in")) {
        // "Logged in using an API key - sk-proj-***ABCD": the method, never a part of the key.
        Some(line) => LoginInfo {
            state: AiLoginState::LoggedIn,
            method: line.strip_prefix("Logged in using ").and_then(|rest| rest.split(" - ").next()).map(|method| method.trim().to_string()).filter(|method| !method.is_empty()),
        },
        None => LoginInfo::unknown(),
    }
}
