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
