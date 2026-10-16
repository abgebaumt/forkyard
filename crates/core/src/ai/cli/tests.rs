//! Pure parts of the command-line providers: capabilities, sign-in, command lines, answers. The
//! inputs are verbatim outputs of the real tools (`testkit::fake_cli`). `Duration`, `Path`, `OsString`,
//! `ProcOutput` and `Usage` come with `super::*`.

use super::*;
use crate::model::AiLoginState::{LoggedIn, LoggedOut, Unknown};
use crate::model::AiProviderKind::{ClaudeCode, Codex, Opencode};
use crate::testkit::fake_cli::{CLAUDE_HELP, CODEX_EXEC_HELP, OPENCODE_RUN_HELP};

fn without(help: &str, flag: &str) -> String {
    help.lines().filter(|line| !line.contains(flag)).collect::<Vec<_>>().join("\n")
}

fn output(code: i32, stdout: &str, stderr: &str) -> ProcOutput {
    ProcOutput { code: Some(code), stdout: stdout.as_bytes().to_vec(), stderr: stderr.as_bytes().to_vec(), stderr_truncated: false, duration: Duration::ZERO }
}

#[test]
fn capabilities_follow_the_help_text() {
    assert_eq!(parse_caps(ClaudeCode, CLAUDE_HELP, Some("2.1.301")), CliCaps { version: Some("2.1.301".into()), missing: Vec::new(), schema: true, model: true });
    let codex = parse_caps(Codex, CODEX_EXEC_HELP, Some("0.162.0"));
    assert!(codex.supported() && codex.schema && codex.model, "{codex:?}");
    let opencode = parse_caps(Opencode, OPENCODE_RUN_HELP, Some("1.17.15"));
    assert!(opencode.supported() && !opencode.schema && opencode.model, "opencode gets the schema in the prompt: {opencode:?}");

    // An old Claude Code without two safety switches is refused, and the message says what to do.
    let old = parse_caps(ClaudeCode, &without(&without(CLAUDE_HELP, "--strict-mcp-config"), "--setting-sources"), Some("1.0.3"));
    assert_eq!(old.missing, ["--strict-mcp-config", "--setting-sources"]);
    let problem = old.problem(ClaudeCode).unwrap();
    assert!(problem.contains("1.0.3") && problem.contains("--strict-mcp-config") && problem.contains("update Claude Code"), "{problem}");
    assert_eq!(parse_caps(ClaudeCode, CLAUDE_HELP, Some("2.1.301")).problem(ClaudeCode), None);
    assert_eq!(parse_caps(ClaudeCode, &without(CLAUDE_HELP, "--no-session-persistence"), Some("2.0.0")).missing, ["--no-session-persistence"]);

    // Only the schema may fall back into the prompt.
    let no_schema = parse_caps(Codex, &without(CODEX_EXEC_HELP, "--output-schema"), Some("0.150.0"));
    assert!(no_schema.supported() && !no_schema.schema, "{no_schema:?}");
    assert_eq!(parse_caps(Codex, &without(CODEX_EXEC_HELP, "--sandbox"), Some("0.150.0")).missing, ["--sandbox"]);
    assert_eq!(parse_caps(Codex, &without(CODEX_EXEC_HELP, "--ignore-rules"), Some("0.150.0")).missing, ["--ignore-rules"]);
    assert!(!parse_caps(Codex, &without(CODEX_EXEC_HELP, "--model"), Some("0.162.0")).model);

    // opencode's config keys do not show in --help: a minimum version stands in for them.
    for (version, supported) in [(Some("1.17.15"), true), (Some("1.17"), true), (Some("2.0.0-beta.1"), true), (Some("1.16.9"), false), (None, false)] {
        assert_eq!(parse_caps(Opencode, OPENCODE_RUN_HELP, version).supported(), supported, "{version:?}");
    }
    assert_eq!(parse_caps(Opencode, &without(OPENCODE_RUN_HELP, "--pure"), Some("1.17.15")).missing, ["--pure"]);
    // A tool that printed nothing usable lacks everything.
    assert_eq!(parse_caps(ClaudeCode, "", Some("2.1.301")).missing.len(), 6);
    assert!(!parse_caps(AiProviderKind::Anthropic, CLAUDE_HELP, None).supported(), "not a command-line tool");
}

#[test]
fn help_flags_are_whole_words() {
    let tools = Flag { name: "--tools", tokens: &["--tools"] };
    assert!(help_has("  --tools <tools...>   Specify", &tools));
    assert!(help_has("  --tools=<tools>", &tools));
    assert!(!help_has("  --tools-extra <x>", &tools));
    assert!(!help_has("Use --toolset or -p/--tools", &tools));
    let print = Flag { name: "--print", tokens: &["--print"] };
    assert!(help_has("  -p, --print                           Print response and exit", &print));
    assert!(!help_has("Output format (only works with --print):", &print), "a mention in a description is not the option");
}

#[test]
fn sign_in_is_read_from_each_tool() {
    let claude_in = output(0, r#"{"loggedIn": true, "authMethod": "claude.ai", "apiProvider": "firstParty", "email": "lena@example.com", "orgName": "Lenas Firma"}"#, "");
    let info = parse_login(ClaudeCode, &claude_in);
    assert_eq!(info, LoginInfo { state: LoggedIn, method: Some("claude.ai".into()) });
    assert!(!format!("{info:?}").contains("lena@"), "the e-mail address never leaves the parser");
    assert_eq!(parse_login(ClaudeCode, &output(1, r#"{"loggedIn": false, "authMethod": "none", "apiProvider": "firstParty"}"#, "")), LoginInfo { state: LoggedOut, method: None });
    assert_eq!(parse_login(ClaudeCode, &output(0, "Logged in as lena@example.com", "")).state, Unknown, "not the JSON of --json");

    assert_eq!(parse_login(Codex, &output(0, "Logged in using ChatGPT\n", "")), LoginInfo { state: LoggedIn, method: Some("ChatGPT".into()) });
    assert_eq!(parse_login(Codex, &output(0, "", "Logged in using an API key - sk-proj-***ABCD\n")), LoginInfo { state: LoggedIn, method: Some("an API key".into()) }, "no part of the key");
    assert_eq!(parse_login(Codex, &output(1, "", "Not logged in\n")).state, LoggedOut);
    assert_eq!(parse_login(Codex, &output(2, "", "error: unrecognized subcommand 'status'\n")).state, Unknown);

    let listed = "┌  Credentials ~/.local/share/opencode/auth.json\n│\n●  Anthropic \u{1b}[90moauth\u{1b}[39m\n│\n└  1 credentials\n";
    assert_eq!(parse_login(Opencode, &output(0, listed, "")).state, LoggedIn);
    assert_eq!(parse_login(Opencode, &output(0, "┌  Credentials ~/.local/share/opencode/auth.json\n│\n└  0 credentials\n", "")).state, LoggedOut);
    assert_eq!(parse_login(Opencode, &output(0, "\u{1b}[1m└  2 credentials\u{1b}[0m", "")).state, LoggedIn, "colours are ignored");
    assert_eq!(parse_login(Opencode, &output(0, "", "")).state, Unknown);
}

#[test]
fn sign_in_commands_per_tool() {
    assert_eq!(login_command(ClaudeCode), "claude auth login");
    assert_eq!(login_command(Codex), "codex login");
    assert_eq!(login_command(Opencode), "opencode providers login");
    assert_eq!(login_args(Codex), [OsString::from("login")]);
    assert!(login_args(AiProviderKind::Gemini).is_empty());
}

use serde_json::json;

use crate::error::ErrorCode;
use crate::model::AiFeature;

fn strings(args: Vec<OsString>) -> Vec<String> {
    args.into_iter().map(|arg| arg.to_string_lossy().into_owned()).collect()
}

#[test]
fn command_lines_carry_only_switches_and_temp_paths() {
    assert_eq!(
        strings(claude::args(Some(r#"{"type":"object"}"#), Some("sonnet"))),
        ["-p", "--output-format", "json", "--json-schema", r#"{"type":"object"}"#, "--tools", "", "--strict-mcp-config", "--setting-sources", "user", "--no-session-persistence", "--model", "sonnet"]
    );
    assert_eq!(strings(claude::args(None, None)), ["-p", "--output-format", "json", "--tools", "", "--strict-mcp-config", "--setting-sources", "user", "--no-session-persistence"]);

    // A Windows profile with a space and an umlaut: the paths are single arguments.
    let dir = Path::new(r"C:\Users\Max Müller\AppData\Roaming\Forkyard\tmp\ai-7f3a");
    let (schema, out) = (dir.join("schema.json"), dir.join("out.json"));
    let shown = |path: &Path| path.to_string_lossy().into_owned();
    let with_all: Vec<String> = [
        "exec", "-C", &shown(dir), "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral", "--ignore-rules", "--output-schema", &shown(&schema), "-o", &shown(&out), "--json", "-m", "gpt-5.1-codex", "-",
    ]
    .iter()
    .map(|arg| arg.to_string())
    .collect();
    assert_eq!(strings(codex::args(dir, Some(&schema), &out, Some("gpt-5.1-codex"))), with_all);
    let bare: Vec<String> =
        ["exec", "-C", &shown(dir), "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral", "--ignore-rules", "-o", &shown(&out), "--json", "-"].iter().map(|arg| arg.to_string()).collect();
    assert_eq!(strings(codex::args(dir, None, &out, None)), bare, "without a schema switch the schema goes into the prompt");

    let opencode_args: Vec<String> = ["run", "--dir", &shown(dir), "--pure", "--format", "json", "-m", "anthropic/claude-sonnet-5-5"].iter().map(|arg| arg.to_string()).collect();
    assert_eq!(strings(opencode::args(dir, Some("anthropic/claude-sonnet-5-5"))), opencode_args);
    assert_eq!(serde_json::from_str::<serde_json::Value>(opencode::CONFIG).unwrap(), json!({"share": "disabled", "permission": {"*": "deny"}}));

    let forbidden = ["--dangerously-skip-permissions", "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "bypassPermissions", "--bare", "workspace-write", "danger-full-access", "--permission-mode"];
    for args in [claude::args(Some("{}"), Some("sonnet")), codex::args(dir, Some(&schema), &out, Some("o3")), opencode::args(dir, Some("x/y"))] {
        let args = strings(args);
        assert!(forbidden.iter().all(|switch| !args.iter().any(|arg| arg == switch)), "{args:?}");
    }
}

#[test]
fn model_names_never_become_switches() {
    for fine in ["sonnet", "claude-sonnet-5-5", "claude-opus-4-6[1m]", "anthropic/claude-sonnet-5-5", "gpt-5.1-codex", "qwen3:8b", "openrouter/meta-llama/llama-3.3-70b@latest", "a+b"] {
        assert!(check_model(fine).is_ok(), "{fine}");
    }
    let long = "m".repeat(201);
    for bad in ["--dangerously-skip-permissions", "-m", "", "son net", "x;rm -rf ~", "a\"b", "100%", "ä-modell", "a\nb", "a&b", long.as_str()] {
        assert_eq!(check_model(bad).unwrap_err().code, ErrorCode::NotAllowed, "{bad:?}");
    }
}

#[test]
fn the_prompt_goes_to_stdin_with_or_without_the_schema() {
    assert_eq!(
        stdin_text("SYSTEM", "## Staged changes\n<<<REPO t0k>>>\n+a\n<<<END t0k>>>", None),
        "SYSTEM\n\n## Staged changes\n<<<REPO t0k>>>\n+a\n<<<END t0k>>>",
        "exactly what “What is sent?” shows"
    );
    assert_eq!(stdin_text("SYSTEM", "USER", Some(&json!({"type": "object"}))), "SYSTEM\n\nThe JSON must match this JSON schema exactly:\n{\"type\":\"object\"}\n\nUSER");
}

#[test]
fn command_line_tools_get_thirty_seconds_more_to_start() {
    assert_eq!(cli_timeout(AiFeature::CommitMessage.timeout()), Duration::from_secs(90));
    assert_eq!(cli_timeout(AiFeature::Compose.timeout()), Duration::from_secs(210));
    assert_eq!(cli_timeout(AiFeature::ReleaseNotes.timeout()), Duration::from_secs(150));
}

#[test]
fn an_api_key_in_the_environment_is_noticed_for_claude_code_only() {
    let with_key = |name: &str| (name == "ANTHROPIC_API_KEY").then(|| OsString::from("sk-ant-env-0123456789"));
    assert!(env_key_present(ClaudeCode, with_key));
    assert!(!env_key_present(Codex, with_key));
    assert!(!env_key_present(ClaudeCode, |_| Some(OsString::new())), "an empty variable does not count");
    assert!(!env_key_present(ClaudeCode, |_| None));
}
use crate::testkit::fake_cli::claude_result;

#[test]
fn claude_code_answers_are_read_from_its_result() {
    let ok = output(0, &claude_result(&json!({"summary": "Fix login", "body": null})).to_string(), "");
    let answer = claude::parse_answer(&ok).unwrap();
    assert_eq!(serde_json::from_str::<serde_json::Value>(&answer.text).unwrap(), json!({"summary": "Fix login", "body": null}));
    assert_eq!(answer.usage, Usage { input_tokens: 3120, output_tokens: 9 }, "120 + 0 cache writes + 3000 cache reads");
    assert_eq!(answer.cost_micros, Some(12_300), "total_cost_usd 0.0123");

    // Schema in the prompt: the answer is the text in `result` (the core validates it).
    let prompt_mode = output(0, r#"{"type":"result","subtype":"success","is_error":false,"result":"```json\n{\"summary\":\"Fix\",\"body\":null}\n```","usage":{"input_tokens":10,"output_tokens":4}}"#, "");
    let answer = claude::parse_answer(&prompt_mode).unwrap();
    assert_eq!(answer.text, "```json\n{\"summary\":\"Fix\",\"body\":null}\n```");
    assert_eq!((answer.usage, answer.cost_micros), (Usage { input_tokens: 10, output_tokens: 4 }, None));

    let signed_out = claude::parse_answer(&output(1, r#"{"type":"result","subtype":"success","is_error":true,"result":"Not logged in · Please run /login"}"#, "")).unwrap_err();
    assert_eq!(signed_out.code, ErrorCode::AiNotLoggedIn);
    assert!(signed_out.message.contains("claude auth login"), "{}", signed_out.message);
    let credit = claude::parse_answer(&output(1, r#"{"type":"result","subtype":"success","is_error":true,"result":"Credit balance is too low"}"#, "")).unwrap_err();
    assert_eq!(credit.code, ErrorCode::AiProviderUnavailable);
    assert!(credit.message.contains("Credit balance is too low"), "{}", credit.message);
    let crashed = claude::parse_answer(&output(3, "", "Error: request failed\nAuthorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz0123")).unwrap_err();
    assert_eq!(crashed.code, ErrorCode::AiProviderUnavailable);
    assert!(crashed.message.contains("exit code 3"), "{}", crashed.message);
    let detail = crashed.git_output.clone().unwrap_or_default();
    assert!(detail.contains("request failed") && !detail.contains("ghp_abcdefghijklmnopqrstuvwxyz0123"), "stderr tail, redacted: {detail}");
    assert_eq!(claude::parse_answer(&output(0, "kein JSON", "")).unwrap_err().code, ErrorCode::AiInvalidAnswer);
    assert_eq!(claude::parse_answer(&output(1, "", "Error: Invalid API key · Please run /login")).unwrap_err().code, ErrorCode::AiNotLoggedIn);
}

#[test]
fn only_claude_code_suggests_model_aliases() {
    let ids: Vec<String> = model_suggestions(ClaudeCode).into_iter().map(|model| model.id).collect();
    assert_eq!(ids, ["sonnet", "opus", "haiku"]);
    assert!(model_suggestions(Codex).is_empty() && model_suggestions(Opencode).is_empty(), "free text, empty = the tool's default");
}
