//! Test program: plays an AI command-line tool (`claude`, `codex`, `opencode`) for the tests of
//! Teilpaket 1b (`crates/core/tests/ai_cli.rs`) and the E2E features. Built by every `cargo build`,
//! never bundled; it is a fixture, not product code.
//!
//! It is copied into a folder under the name of the tool it plays (`claude`, `claude.exe` …) and
//! reads `<name>.fake.json` next to itself:
//!
//! ```json
//! { "rules": [
//!     { "args": ["--version"], "stdout": "2.1.301 (Claude Code)\n" },
//!     { "prefix": ["exec", "-C"], "stdout": "…", "stderr": "…", "exit": 0, "sleepMs": 0,
//!       "writeAfterFlag": { "flag": "-o", "content": "…" } } ],
//!   "fallback": { "exit": 2, "stderr": "no rule" } }
//! ```
//!
//! The first rule whose `args` equal the arguments, or whose `prefix` starts them, answers;
//! otherwise `fallback`. `writeAfterFlag` writes `content` into the file named after `flag`.
//! Before answering, every call is appended to `<name>.calls.jsonl` (one JSON line): arguments,
//! working folder and its entries, stdin, a few environment variables and the contents of every
//! argument that names an existing file.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

/// Environment variables the tests look at.
const RECORDED_ENV: [&str; 4] = ["OPENCODE_CONFIG_CONTENT", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "FORKYARD_FAKE_MARK"];
const MAX_FILE: usize = 64 * 1024;

fn main() {
    std::process::exit(run());
}

fn run() -> i32 {
    let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("fake-cli"));
    let dir = exe.parent().map(Path::to_path_buf).unwrap_or_default();
    let name = exe.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut stdin = Vec::new();
    let _ = std::io::stdin().read_to_end(&mut stdin);
    record(&dir, &name, &args, &stdin);
    let config: Option<Value> = std::fs::read_to_string(dir.join(format!("{name}.fake.json"))).ok().and_then(|text| serde_json::from_str(&text).ok());
    let Some(config) = config else {
        eprintln!("fake-cli: {name}.fake.json is missing or not JSON");
        return 97;
    };
    let rule = config["rules"].as_array().into_iter().flatten().find(|rule| matches(rule, &args)).cloned().unwrap_or_else(|| config["fallback"].clone());
    answer(&rule, &args)
}

fn strings(value: &Value) -> Option<Vec<String>> {
    value.as_array().map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect())
}

fn matches(rule: &Value, args: &[String]) -> bool {
    if let Some(exact) = strings(&rule["args"]) {
        return exact == args;
    }
    if let Some(prefix) = strings(&rule["prefix"]) {
        return args.len() >= prefix.len() && args[..prefix.len()] == prefix[..];
    }
    false
}

fn answer(rule: &Value, args: &[String]) -> i32 {
    if let Some(ms) = rule["sleepMs"].as_u64() {
        std::thread::sleep(Duration::from_millis(ms));
    }
    if let (Some(flag), Some(content)) = (rule["writeAfterFlag"]["flag"].as_str(), rule["writeAfterFlag"]["content"].as_str()) {
        if let Some(target) = args.iter().position(|arg| arg == flag).and_then(|at| args.get(at + 1)) {
            let _ = std::fs::write(target, content);
        }
    }
    if let Some(text) = rule["stdout"].as_str() {
        let _ = std::io::stdout().write_all(text.as_bytes());
    }
    if let Some(text) = rule["stderr"].as_str() {
        let _ = std::io::stderr().write_all(text.as_bytes());
    }
    rule["exit"].as_i64().unwrap_or(0) as i32
}

fn record(dir: &Path, name: &str, args: &[String], stdin: &[u8]) {
    let cwd = std::env::current_dir().unwrap_or_default();
    let mut entries: Vec<String> = std::fs::read_dir(&cwd).map(|list| list.filter_map(Result::ok).map(|entry| entry.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_default();
    entries.sort();
    let env: BTreeMap<&str, String> = RECORDED_ENV.iter().filter_map(|key| std::env::var(key).ok().map(|value| (*key, value))).collect();
    let files: BTreeMap<&str, String> = args
        .iter()
        .filter(|arg| !arg.is_empty() && Path::new(arg.as_str()).is_file())
        .filter_map(|arg| std::fs::read(arg).ok().map(|bytes| (arg.as_str(), String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_FILE)]).into_owned())))
        .collect();
    let line = json!({ "args": args, "cwd": cwd.to_string_lossy(), "cwdEntries": entries, "stdin": String::from_utf8_lossy(stdin), "env": env, "files": files });
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join(format!("{name}.calls.jsonl"))) {
        // One write per line: calls running side by side (detection) do not mix their lines.
        let _ = file.write_all(format!("{line}\n").as_bytes());
    }
}
