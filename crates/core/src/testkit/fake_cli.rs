//! Installing the fake AI command-line tool (`src/bin/forkyard-fake-cli.rs`) under the name of the
//! tool it plays, and reading what it was called with.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

/// One recorded call of the fake tool.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FakeCall {
    pub args: Vec<String>,
    pub cwd: String,
    pub cwd_entries: Vec<String>,
    pub stdin: String,
    pub env: BTreeMap<String, String>,
    pub files: BTreeMap<String, String>,
}

pub struct FakeCli {
    /// What Forkyard starts: the program, or the `.cmd` shim of `install_batch`.
    pub program: PathBuf,
    state: PathBuf,
    name: String,
}

/// Copies the program file. On Unix in a separate `cp` process: a write handle held by this
/// (multi-threaded) test process would be inherited by a child another test forks at that moment,
/// and starting the copy would then fail with "Text file busy" (ETXTBSY).
fn copy_program(binary: &Path, program: &Path) {
    #[cfg(unix)]
    {
        let status = std::process::Command::new("cp").arg("--").arg(binary).arg(program).status();
        assert!(matches!(status, Ok(status) if status.success()), "copy {} → {}: {status:?}", binary.display(), program.display());
    }
    #[cfg(not(unix))]
    std::fs::copy(binary, program).unwrap_or_else(|e| panic!("copy {} → {}: {e}", binary.display(), program.display()));
}

impl FakeCli {
    /// Copies `binary` (target/debug/forkyard-fake-cli) to `dir/<name>` (`.exe` on Windows) with `config`.
    pub fn install(binary: &Path, dir: &Path, name: &str, config: &Value) -> FakeCli {
        std::fs::create_dir_all(dir).expect("folder of the fake tool");
        let program = dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX));
        copy_program(binary, &program);
        let fake = FakeCli { program, state: dir.to_path_buf(), name: name.to_string() };
        fake.set_config(config);
        fake
    }

    /// Like an npm install on Windows: `dir/<name>.cmd` calls the real program in `dir/<name>-bin/`.
    pub fn install_batch(binary: &Path, dir: &Path, name: &str, config: &Value) -> FakeCli {
        let inner = FakeCli::install(binary, &dir.join(format!("{name}-bin")), name, config);
        let shim = dir.join(format!("{name}.cmd"));
        std::fs::write(&shim, format!("@\"%~dp0{name}-bin\\{name}.exe\" %*\r\n")).expect("shim");
        FakeCli { program: shim, state: inner.state, name: inner.name }
    }

    pub fn set_config(&self, config: &Value) {
        let text = serde_json::to_string_pretty(config).expect("config");
        std::fs::write(self.state.join(format!("{}.fake.json", self.name)), text).expect("config file");
    }

    pub fn calls(&self) -> Vec<FakeCall> {
        let text = std::fs::read_to_string(self.state.join(format!("{}.calls.jsonl", self.name))).unwrap_or_default();
        text.lines().filter(|line| !line.trim().is_empty()).map(|line| serde_json::from_str(line).expect("call record")).collect()
    }

    /// The calls whose arguments start with `prefix`.
    pub fn calls_with(&self, prefix: &[&str]) -> Vec<FakeCall> {
        self.calls().into_iter().filter(|call| call.args.len() >= prefix.len() && call.args.iter().zip(prefix).all(|(arg, want)| arg == want)).collect()
    }
}

// --- Fixtures: what the real tools print ----------------------------------------------------
//
// Claude Code 2.1.301 and codex-cli 0.162.0: the lines with the switches Forkyard reads, verbatim
// from `claude --help` and `codex exec --help`. opencode 1.17: in its yargs layout (the tool was not
// installed where this was written; see the plan's rulings).

/// `claude --help` (Claude Code 2.1.301), the options Forkyard reads.
pub const CLAUDE_HELP: &str = r##"Usage: claude [options] [command] [prompt]

Claude Code - starts an interactive session by default, use -p/--print for
non-interactive output

Options:
  --json-schema <schema>                JSON Schema for structured output
                                        validation. Example:
                                        {"type":"object","properties":{"name":{"type":"string"}},"required":["name"]}
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
  --no-session-persistence              Disable session persistence - sessions
                                        will not be saved to disk and cannot be
                                        resumed (only works with --print)
  --output-format <format>              Output format (only works with --print):
                                        "text" (default), "json" (single
                                        result), or "stream-json" (realtime
                                        streaming) (choices: "text", "json",
                                        "stream-json")
  -p, --print                           Print response and exit (useful for
                                        pipes).
  --setting-sources <sources>           Comma-separated list of setting sources
                                        to load (user, project, local).
  --strict-mcp-config                   Only use MCP servers from --mcp-config,
                                        ignoring all other MCP configurations
  --tools <tools...>                    Specify the list of available tools from
                                        the built-in set. Use "" to disable all
                                        tools, "default" to use all tools, or
                                        specify tool names (e.g.
                                        "Bash,Edit,Read").
"##;

/// `codex exec --help` (codex-cli 0.162.0), the options Forkyard reads.
pub const CODEX_EXEC_HELP: &str = r##"Run Codex non-interactively

Usage: codex exec [OPTIONS] [PROMPT]
       codex exec [OPTIONS] <COMMAND> [ARGS]

Arguments:
  [PROMPT]
          Initial instructions for the agent. If not provided as an argument (or if `-` is used),
          instructions are read from stdin. If stdin is piped and a prompt is also provided, stdin
          is appended as a `<stdin>` block

Options:
  -m, --model <MODEL>
          Model the agent should use

  -s, --sandbox <SANDBOX_MODE>
          Select the sandbox policy to use when executing model-generated shell commands

          [possible values: read-only, workspace-write, danger-full-access]

  -C, --cd <DIR>
          Tell the agent to use the specified directory as its working root

      --skip-git-repo-check
          Allow running Codex outside a Git repository

      --ephemeral
          Run without persisting session files to disk

      --disable <FEATURE>
          Disable a feature (repeatable). Equivalent to `-c features.<name>=false`

      --ignore-user-config
          Do not load `$CODEX_HOME/config.toml`; auth still uses `CODEX_HOME`

      --ignore-rules
          Do not load user or project execpolicy `.rules` files

      --output-schema <FILE>
          Path to a JSON Schema file describing the model's final response shape

      --json
          Print events to stdout as JSONL

  -o, --output-last-message <FILE>
          Specifies file where the last message from the agent should be written
"##;

/// `opencode run --help` (opencode 1.17, yargs layout).
pub const OPENCODE_RUN_HELP: &str = r##"opencode run [message..]

run opencode with a message

Positionals:
  message  message to send                                          [array] [default: []]

Options:
  -h, --help     show help                                                      [boolean]
  -m, --model    model to use in the format of provider/model                    [string]
      --format   format: default (formatted) or json (raw JSON events)
                                      [string] [choices: "default", "json"] [default: "default"]
      --dir      directory to run in                                             [string]
      --pure     run without external plugins                                   [boolean]
"##;

/// The JSON line of `claude -p --output-format json` with this structured answer.
pub fn claude_result(structured: &Value) -> Value {
    serde_json::json!({
        "type": "result",
        "subtype": "success",
        "is_error": false,
        "duration_ms": 2310,
        "num_turns": 1,
        "result": "",
        "session_id": "9b1f0c7e-1d2a-4c43-9a51-3f6f2f1e9a10",
        "total_cost_usd": 0.0123,
        "usage": { "input_tokens": 120, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 3000, "output_tokens": 9 },
        "structured_output": structured
    })
}

/// A fake `claude`: version, help, sign-in and `answer` (the stdout JSON) for `-p`.
pub fn claude_config(help: &str, logged_in: bool, answer: &Value) -> Value {
    let status = serde_json::json!({ "loggedIn": logged_in, "authMethod": if logged_in { "claude.ai" } else { "none" }, "apiProvider": "firstParty" });
    serde_json::json!({
        "rules": [
            { "args": ["--version"], "stdout": "2.1.301 (Claude Code)\n" },
            { "args": ["--help"], "stdout": help },
            { "args": ["auth", "status", "--json"], "stdout": status.to_string(), "exit": if logged_in { 0 } else { 1 } },
            { "prefix": ["-p"], "stdout": answer.to_string() }
        ],
        "fallback": { "exit": 2, "stderr": "fake claude: unknown call" }
    })
}

/// The `--json` events of `codex exec` ending in `last_message`.
pub fn codex_events(last_message: &str) -> String {
    [
        serde_json::json!({ "type": "thread.started", "thread_id": "0199a213-81c0-7800-8aa1-bbab2a035a53" }),
        serde_json::json!({ "type": "turn.started" }),
        serde_json::json!({ "type": "item.completed", "item": { "id": "item_0", "type": "agent_message", "text": last_message } }),
        serde_json::json!({ "type": "turn.completed", "usage": { "input_tokens": 2400, "cached_input_tokens": 1200, "output_tokens": 31 } }),
    ]
    .iter()
    .map(|event| format!("{event}\n"))
    .collect()
}

/// A fake `codex`: version, help, sign-in and an `exec` that writes `last_message` to `-o`.
pub fn codex_config(help: &str, logged_in: bool, last_message: &str) -> Value {
    let status = if logged_in {
        serde_json::json!({ "args": ["login", "status"], "stdout": "Logged in using ChatGPT\n", "exit": 0 })
    } else {
        serde_json::json!({ "args": ["login", "status"], "stderr": "Not logged in\n", "exit": 1 })
    };
    serde_json::json!({
        "rules": [
            { "args": ["--version"], "stdout": "codex-cli 0.162.0\n" },
            { "args": ["exec", "--help"], "stdout": help },
            status,
            { "prefix": ["exec", "-C"], "stdout": codex_events(last_message), "writeAfterFlag": { "flag": "-o", "content": last_message } }
        ],
        "fallback": { "exit": 2, "stderr": "fake codex: unknown call" }
    })
}

/// The `--format json` events of `opencode run` with `text` as the answer.
pub fn opencode_events(text: &str) -> String {
    [
        serde_json::json!({ "type": "step_start", "timestamp": 1_767_225_600_000_u64, "sessionID": "ses_7f3a", "part": { "type": "step-start" } }),
        serde_json::json!({ "type": "text", "timestamp": 1_767_225_601_000_u64, "sessionID": "ses_7f3a", "part": { "type": "text", "text": text } }),
        serde_json::json!({ "type": "step_finish", "timestamp": 1_767_225_602_000_u64, "sessionID": "ses_7f3a", "part": { "type": "step-finish", "reason": "stop", "cost": 0.0042, "tokens": { "input": 1800, "output": 25, "reasoning": 0, "cache": { "read": 200, "write": 0 } } } }),
    ]
    .iter()
    .map(|event| format!("{event}\n"))
    .collect()
}

/// A fake `opencode` of `version` with `credentials` signed-in providers.
pub fn opencode_config(help: &str, version: &str, credentials: u32, text: &str) -> Value {
    let listed = format!("┌  Credentials ~/.local/share/opencode/auth.json\n│\n{}└  {credentials} credentials\n", if credentials > 0 { "●  Anthropic \u{1b}[90moauth\u{1b}[39m\n│\n" } else { "" });
    serde_json::json!({
        "rules": [
            { "args": ["--version"], "stdout": format!("{version}\n") },
            { "args": ["run", "--help"], "stdout": help },
            { "args": ["providers", "list"], "stdout": listed },
            { "prefix": ["run", "--dir"], "stdout": opencode_events(text) }
        ],
        "fallback": { "exit": 2, "stderr": "fake opencode: unknown call" }
    })
}
