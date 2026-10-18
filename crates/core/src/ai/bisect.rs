//! Bisect autopilot (9.1): the AI request that writes a test script.
//!
//! The answer is only text: it is checked against the schema, normalised and shown in the editor.
//! Nothing here runs it – `bisect_autopilot_run` does, after the user pressed "Run".

use serde_json::{json, Value};

use crate::error::{CoreError, CoreResult};
use crate::model::{BisectScript, BisectShell};

/// Larger scripts are refused (the editor shows the same limit).
pub const MAX_SCRIPT_BYTES: usize = 64 * 1024;
const MAX_SUMMARY: usize = 300;

impl BisectShell {
    /// The shell of this system.
    pub fn current() -> BisectShell {
        if cfg!(windows) {
            BisectShell::Powershell
        } else {
            BisectShell::Sh
        }
    }

    /// How the prompt names the shell and its call.
    pub fn prompt_name(self) -> &'static str {
        match self {
            BisectShell::Sh => "POSIX sh (run as `/bin/sh test.sh`)",
            BisectShell::Powershell => "Windows PowerShell 5.1 (run as `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File test.ps1`)",
        }
    }

    pub fn file_name(self) -> &'static str {
        match self {
            BisectShell::Sh => "test.sh",
            BisectShell::Powershell => "test.ps1",
        }
    }
}

/// The answer: the whole script and one sentence about what it checks (dialect of `ai::schema`).
pub fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "script": { "type": "string", "description": "The whole test script." },
            "summary": { "type": "string", "description": "One sentence: what the script checks." }
        },
        "required": ["script", "summary"],
        "additionalProperties": false
    })
}

/// One line ending for the shell (`exit 0\r` breaks `sh`), without a Markdown fence around the
/// whole script, with a final newline. An empty result stays empty.
pub fn normalize_script(script: &str, shell: BisectShell) -> String {
    let unified = script.replace("\r\n", "\n").replace('\r', "\n");
    let trimmed = unified.trim();
    let body = match trimmed.strip_prefix("```") {
        Some(rest) if trimmed.len() >= 6 && trimmed.ends_with("```") => {
            let inner = &rest[..rest.len() - 3];
            // The opening line may name the language (```sh).
            inner.split_once('\n').map(|(_, code)| code).unwrap_or("")
        }
        _ => trimmed,
    };
    let body = body.trim_matches('\n');
    if body.trim().is_empty() {
        return String::new();
    }
    let text = format!("{body}\n");
    match shell {
        BisectShell::Sh => text,
        BisectShell::Powershell => text.replace('\n', "\r\n"),
    }
}

/// Why a script cannot run, in words for errors; `None` = fine.
pub fn script_problem(script: &str) -> Option<&'static str> {
    if script.trim().is_empty() {
        Some("the script is empty")
    } else if script.len() > MAX_SCRIPT_BYTES {
        Some("the script is longer than 64 KiB")
    } else if script.contains('\0') {
        Some("the script contains a NUL byte")
    } else {
        None
    }
}

/// The checked answer of `complete_json` as a script for `shell`.
pub fn parse_answer(value: &Value, shell: BisectShell) -> CoreResult<BisectScript> {
    let script = normalize_script(value.get("script").and_then(Value::as_str).unwrap_or_default(), shell);
    if let Some(problem) = script_problem(&script) {
        return Err(CoreError::ai_invalid_answer(problem));
    }
    let summary: String = value.get("summary").and_then(Value::as_str).unwrap_or_default().trim().chars().take(MAX_SUMMARY).collect();
    Ok(BisectScript { script, summary, shell })
}

#[cfg(test)]
mod tests;
