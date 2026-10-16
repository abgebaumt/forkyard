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
