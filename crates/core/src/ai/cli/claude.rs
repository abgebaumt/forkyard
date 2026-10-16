//! Claude Code (`claude`, checked with 2.1.301): `claude -p --output-format json --json-schema
//! <schema> --tools "" --strict-mcp-config --setting-sources user --no-session-persistence
//! [--model <m>]`, prompt on stdin. Sign-in: `claude auth status --json` (`loggedIn`,
//! `authMethod`; the e-mail address in it is never read). `--bare` can't be used – it reads no
//! sign-in.

use serde_json::Value;

use super::{Flag, LoginInfo};
use crate::model::AiLoginState;
use crate::proc::ProcOutput;

pub const HELP_ARGS: [&str; 1] = ["--help"];
pub const STATUS_ARGS: [&str; 3] = ["auth", "status", "--json"];
pub const LOGIN_ARGS: [&str; 2] = ["auth", "login"];
/// Print mode with JSON output, no tools, no MCP servers but Forkyard's (none), only the user's
/// settings, no stored session.
pub const SAFETY: [Flag; 6] = [
    Flag { name: "--print", tokens: &["--print"] },
    Flag { name: "--output-format", tokens: &["--output-format"] },
    Flag { name: "--tools", tokens: &["--tools"] },
    Flag { name: "--strict-mcp-config", tokens: &["--strict-mcp-config"] },
    Flag { name: "--setting-sources", tokens: &["--setting-sources"] },
    Flag { name: "--no-session-persistence", tokens: &["--no-session-persistence"] },
];
pub const SCHEMA: Flag = Flag { name: "--json-schema", tokens: &["--json-schema"] };
pub const MODEL: Flag = Flag { name: "--model", tokens: &["--model"] };

pub fn parse_login(out: &ProcOutput) -> LoginInfo {
    let Ok(value) = serde_json::from_slice::<Value>(&out.stdout) else {
        return LoginInfo::unknown();
    };
    match value.get("loggedIn").and_then(Value::as_bool) {
        Some(true) => LoginInfo {
            state: AiLoginState::LoggedIn,
            method: value.get("authMethod").and_then(Value::as_str).filter(|method| !method.is_empty() && *method != "none").map(str::to_string),
        },
        Some(false) => LoginInfo { state: AiLoginState::LoggedOut, method: None },
        None => LoginInfo::unknown(),
    }
}

/// The command line; `schema` = the schema's JSON text (Forkyard's own text, never repository data).
pub fn args(schema: Option<&str>, model: Option<&str>) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = ["-p", "--output-format", "json"].iter().map(std::ffi::OsString::from).collect();
    if let Some(schema) = schema {
        args.push("--json-schema".into());
        args.push(schema.into());
    }
    args.extend(["--tools", "", "--strict-mcp-config", "--setting-sources", "user", "--no-session-persistence"].iter().map(std::ffi::OsString::from));
    if let Some(model) = model {
        args.push("--model".into());
        args.push(model.into());
    }
    args
}
