//! Codex (`codex`, checked with codex-cli 0.162.0): `codex exec -C <tmp> --skip-git-repo-check
//! --sandbox read-only --ephemeral --ignore-rules --ignore-user-config --disable shell_tool
//! --disable view_image --output-schema <tmp>/schema.json -o <tmp>/out.json --json [-m <m>] -`,
//! prompt on stdin. Sign-in: `codex login status`.
//!
//! The read-only sandbox stops writes and the network, not reading: the model could still run
//! `cat` on any file through its shell tool, open images through `view_image`, or reach files
//! through an MCP server of the user's `config.toml`. So the shell and image tools are switched off
//! and the user config is not loaded (the sign-in still is) – Grundregel 5: no access to the
//! repository. A version without `--disable` or `--ignore-user-config` is refused.

use super::{Flag, LoginInfo};
use crate::model::AiLoginState;
use crate::proc::ProcOutput;

pub const HELP_ARGS: [&str; 2] = ["exec", "--help"];
pub const STATUS_ARGS: [&str; 2] = ["login", "status"];
pub const LOGIN_ARGS: [&str; 1] = ["login"];
/// Another working folder, no Git repository needed, read-only sandbox, no stored session, no
/// execpolicy rules, no user config (no MCP servers), no shell or image tool, answer into a file,
/// events as JSON.
pub const SAFETY: [Flag; 9] = [
    Flag { name: "--cd", tokens: &["--cd"] },
    Flag { name: "--skip-git-repo-check", tokens: &["--skip-git-repo-check"] },
    Flag { name: "--sandbox", tokens: &["--sandbox"] },
    Flag { name: "--ephemeral", tokens: &["--ephemeral"] },
    Flag { name: "--ignore-rules", tokens: &["--ignore-rules"] },
    Flag { name: "--ignore-user-config", tokens: &["--ignore-user-config"] },
    Flag { name: "--disable", tokens: &["--disable"] },
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

/// The command line: working root and answer file in `dir`, prompt from stdin (`-`).
pub fn args(dir: &std::path::Path, schema_file: Option<&std::path::Path>, out_file: &std::path::Path, model: Option<&str>) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> =
        vec!["exec".into(), "-C".into(), dir.into(), "--skip-git-repo-check".into(), "--sandbox".into(), "read-only".into(), "--ephemeral".into(), "--ignore-rules".into()];
    // Codex's own tools: no shell (it would read any file despite the read-only sandbox), no images.
    args.extend(["--ignore-user-config".into(), "--disable".into(), "shell_tool".into(), "--disable".into(), "view_image".into()]);
    if let Some(schema) = schema_file {
        args.push("--output-schema".into());
        args.push(schema.into());
    }
    args.extend(["-o".into(), out_file.into(), "--json".into()]);
    if let Some(model) = model {
        args.push("-m".into());
        args.push(model.into());
    }
    args.push("-".into());
    args
}

/// The answer is the last message in `out_file` (`-o`), else the last `agent_message` event; tokens
/// from `turn.completed`; errors from `error` / `turn.failed`.
pub fn parse_answer(out: &ProcOutput, out_file: &std::path::Path) -> crate::error::CoreResult<super::CliAnswer> {
    use crate::error::CoreError;
    use serde_json::Value;
    let kind = crate::model::AiProviderKind::Codex;
    let mut usage = crate::ai::provider::Usage::default();
    let mut last_message: Option<String> = None;
    let mut errors: Vec<String> = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let Ok(event) = serde_json::from_str::<Value>(line) else { continue };
        match event.get("type").and_then(Value::as_str) {
            Some("turn.completed") => {
                usage.input_tokens += super::count(&event, "/usage/input_tokens");
                usage.output_tokens += super::count(&event, "/usage/output_tokens");
            }
            Some("item.completed") if event.pointer("/item/type").and_then(Value::as_str) == Some("agent_message") => {
                last_message = event.pointer("/item/text").and_then(Value::as_str).map(str::to_string);
            }
            Some("error") => errors.extend(event.get("message").and_then(Value::as_str).map(str::to_string)),
            Some("turn.failed") => errors.extend(event.pointer("/error/message").and_then(Value::as_str).map(str::to_string)),
            _ => {}
        }
    }
    let joined = errors.join("\n");
    if super::looks_signed_out(&joined) {
        return Err(super::not_logged_in(kind));
    }
    if !out.success() {
        return Err(if errors.is_empty() { super::exit_failure(kind, out) } else { CoreError::ai_provider_unavailable(format!("Codex reported an error: {}", super::reported(&joined))) });
    }
    let from_file = std::fs::read_to_string(out_file).ok().map(|text| text.trim().to_string()).filter(|text| !text.is_empty());
    let text = from_file.or(last_message).ok_or_else(|| {
        if errors.is_empty() {
            CoreError::ai_invalid_answer("Codex wrote no answer")
        } else {
            CoreError::ai_provider_unavailable(format!("Codex reported an error: {}", super::reported(&joined)))
        }
    })?;
    Ok(super::CliAnswer { text, usage, cost_micros: None })
}
