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

/// The JSON line of `--output-format json`: `structured_output` (schema as switch) or `result`
/// (schema in the prompt), tokens from `usage`, the cost from `total_cost_usd`.
pub fn parse_answer(out: &ProcOutput) -> crate::error::CoreResult<super::CliAnswer> {
    use crate::error::CoreError;
    let kind = crate::model::AiProviderKind::ClaudeCode;
    let Ok(value) = serde_json::from_slice::<Value>(&out.stdout) else {
        return Err(if out.success() { CoreError::ai_invalid_answer("Claude Code sent no JSON result") } else { super::exit_failure(kind, out) });
    };
    let result = value.get("result").and_then(Value::as_str).unwrap_or_default();
    let failed = value.get("is_error").and_then(Value::as_bool).unwrap_or(false) || value.get("subtype").and_then(Value::as_str).is_some_and(|subtype| subtype != "success");
    if failed {
        if super::looks_signed_out(result) {
            return Err(super::not_logged_in(kind));
        }
        return Err(CoreError::ai_provider_unavailable(format!("Claude Code reported an error: {}", super::reported(result))));
    }
    let usage = crate::ai::provider::Usage {
        input_tokens: super::count(&value, "/usage/input_tokens") + super::count(&value, "/usage/cache_creation_input_tokens") + super::count(&value, "/usage/cache_read_input_tokens"),
        output_tokens: super::count(&value, "/usage/output_tokens"),
    };
    let cost_micros = value.get("total_cost_usd").and_then(Value::as_f64).map(crate::ai::pricing::micros);
    let text = match value.get("structured_output") {
        Some(structured) if !structured.is_null() => structured.to_string(),
        _ => result.to_string(),
    };
    Ok(super::CliAnswer { text, usage, cost_micros })
}
