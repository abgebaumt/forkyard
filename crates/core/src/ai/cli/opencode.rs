//! opencode (`opencode`, as of 1.17): `opencode run --dir <tmp> --pure --format json
//! [-m <provider/model>]` with `OPENCODE_CONFIG_CONTENT={"share":"disabled","permission":{"*":"deny"}}`,
//! prompt on stdin, schema in the prompt (the core validates). Sign-in: `opencode providers list`
//! ("n credentials"). opencode stores its sessions on this computer (Settings › AI says so).

use std::sync::OnceLock;

use regex::Regex;

use super::{Flag, LoginInfo};
use crate::model::AiLoginState;
use crate::proc::ProcOutput;

pub const HELP_ARGS: [&str; 2] = ["run", "--help"];
pub const STATUS_ARGS: [&str; 2] = ["providers", "list"];
pub const LOGIN_ARGS: [&str; 2] = ["providers", "login"];
pub const CONFIG_ENV: &str = "OPENCODE_CONFIG_CONTENT";
/// No sharing, every permission denied (tools, files, commands).
pub const CONFIG: &str = r#"{"share":"disabled","permission":{"*":"deny"}}"#;
/// The configuration keys above are not visible in `--help`; this version is known to have them.
pub const MIN_VERSION: &str = "1.17.0";
const MIN: (u64, u64, u64) = (1, 17, 0);
pub const SAFETY: [Flag; 3] = [
    Flag { name: "--dir", tokens: &["--dir"] },
    Flag { name: "--pure", tokens: &["--pure"] },
    Flag { name: "--format", tokens: &["--format"] },
];
pub const MODEL: Flag = Flag { name: "--model", tokens: &["--model"] };

fn numbers(version: &str) -> Option<(u64, u64, u64)> {
    let core = version.split(['-', '+']).next()?;
    let mut parts = core.split('.').map(|part| part.parse::<u64>().ok());
    Some((parts.next()??, parts.next().flatten().unwrap_or(0), parts.next().flatten().unwrap_or(0)))
}

pub fn version_ok(version: Option<&str>) -> bool {
    version.and_then(numbers).is_some_and(|found| found >= MIN)
}

fn ansi() -> &'static Regex {
    static ANSI: OnceLock<Regex> = OnceLock::new();
    ANSI.get_or_init(|| Regex::new(r"\x1b\[[0-9;]*[A-Za-z]").expect("pattern"))
}

fn credentials() -> &'static Regex {
    static COUNT: OnceLock<Regex> = OnceLock::new();
    COUNT.get_or_init(|| Regex::new(r"(\d+)\s+credentials?\b").expect("pattern"))
}

pub fn parse_login(out: &ProcOutput) -> LoginInfo {
    let text = ansi().replace_all(&String::from_utf8_lossy(&out.stdout), "").into_owned();
    match credentials().captures(&text).and_then(|found| found[1].parse::<u64>().ok()) {
        Some(0) => LoginInfo { state: AiLoginState::LoggedOut, method: None },
        Some(_) => LoginInfo { state: AiLoginState::LoggedIn, method: None },
        None => LoginInfo::unknown(),
    }
}

/// The command line; the configuration goes through `CONFIG_ENV`, the prompt through stdin.
pub fn args(dir: &std::path::Path, model: Option<&str>) -> Vec<std::ffi::OsString> {
    let mut args: Vec<std::ffi::OsString> = vec!["run".into(), "--dir".into(), dir.into(), "--pure".into(), "--format".into(), "json".into()];
    if let Some(model) = model {
        args.push("-m".into());
        args.push(model.into());
    }
    args
}

/// The answer is the text of the `text` events; tokens and cost from `step_finish`; errors from
/// `error` (`ProviderAuthError` = not signed in).
pub fn parse_answer(out: &ProcOutput) -> crate::error::CoreResult<super::CliAnswer> {
    use crate::error::CoreError;
    use serde_json::Value;
    let kind = crate::model::AiProviderKind::Opencode;
    let mut text = String::new();
    let mut usage = crate::ai::provider::Usage::default();
    let mut cost = 0.0_f64;
    let mut errors: Vec<String> = Vec::new();
    for line in String::from_utf8_lossy(&out.stdout).lines() {
        let Ok(event) = serde_json::from_str::<Value>(line) else { continue };
        match event.get("type").and_then(Value::as_str) {
            Some("text") => text.push_str(event.pointer("/part/text").and_then(Value::as_str).unwrap_or_default()),
            Some("step_finish") => {
                usage.input_tokens += super::count(&event, "/part/tokens/input") + super::count(&event, "/part/tokens/cache/read");
                usage.output_tokens += super::count(&event, "/part/tokens/output");
                cost += event.pointer("/part/cost").and_then(Value::as_f64).unwrap_or(0.0);
            }
            Some("error") => {
                let name = event.pointer("/error/name").and_then(Value::as_str).unwrap_or_default();
                let message = event.pointer("/error/data/message").or_else(|| event.pointer("/error/message")).and_then(Value::as_str).unwrap_or_default();
                errors.push(format!("{name}: {message}"));
            }
            _ => {}
        }
    }
    let joined = errors.join("\n");
    if super::looks_signed_out(&joined) {
        return Err(super::not_logged_in(kind));
    }
    if !errors.is_empty() {
        return Err(CoreError::ai_provider_unavailable(format!("opencode reported an error: {}", super::reported(&joined))));
    }
    if !out.success() {
        return Err(super::exit_failure(kind, out));
    }
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err(CoreError::ai_invalid_answer("opencode wrote no answer"));
    }
    Ok(super::CliAnswer { text, usage, cost_micros: (cost > 0.0).then(|| crate::ai::pricing::micros(cost)) })
}
