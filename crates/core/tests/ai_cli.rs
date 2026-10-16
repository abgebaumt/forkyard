//! The AI command-line tools (Teilpaket 1b) against `forkyard-fake-cli`, a test program that plays
//! `claude`, `codex` or `opencode` and records every call. Nothing here starts a real tool or
//! talks to a real service.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use gitcore::ai::cli;
use gitcore::jobs::CancelToken;
use gitcore::proc::Proc;
use gitcore::testkit::{FakeCli, TestCore};
use serde_json::json;

const FAKE: &str = env!("CARGO_BIN_EXE_forkyard-fake-cli");

fn fake() -> &'static Path {
    Path::new(FAKE)
}

#[tokio::test]
async fn the_fake_cli_records_what_it_gets() {
    let tc = TestCore::new().await;
    assert!(std::fs::read_dir(tc.cli_dir()).unwrap().next().is_none(), "every test core searches the tools in its own empty folder");
    let claude = FakeCli::install(
        fake(),
        &tc.cli_dir(),
        "claude",
        &json!({
            "rules": [
                { "args": ["--version"], "stdout": "2.1.301 (Claude Code)\n" },
                { "prefix": ["-p"], "stdout": "{\"ok\":true}", "exit": 3, "writeAfterFlag": { "flag": "-o", "content": "Antwort für Süd" } }
            ],
            "fallback": { "exit": 2, "stderr": "fake: no rule" }
        }),
    );
    let scratch = cli::ScratchDir::new(&tc).unwrap();
    let folder: PathBuf = scratch.path().to_path_buf();
    assert!(folder.starts_with(tc.data_dir().join("tmp")), "{}", folder.display());
    let schema = folder.join("schema.json");
    std::fs::write(&schema, "{\"type\":\"object\"}").unwrap();
    let out_file = folder.join("out.json");
    let args: Vec<OsString> = vec!["-p".into(), "--tools".into(), "".into(), "-o".into(), out_file.clone().into(), schema.clone().into()];
    let out = Proc::new(&claude.program)
        .args(&args)
        .cwd(&folder)
        .stdin("Grüße\r\nZeile 2".as_bytes().to_vec())
        .env("FORKYARD_FAKE_MARK", "gesehen")
        .run(&CancelToken::new())
        .await
        .unwrap();
    assert_eq!((out.code, out.stdout_text()), (Some(3), "{\"ok\":true}".to_string()));
    assert_eq!(std::fs::read_to_string(&out_file).unwrap(), "Antwort für Süd");

    let calls = claude.calls();
    assert_eq!(calls.len(), 1);
    let call = &calls[0];
    assert_eq!(call.args, ["-p", "--tools", "", "-o", out_file.to_str().unwrap(), schema.to_str().unwrap()]);
    assert_eq!(Path::new(&call.cwd), folder.as_path());
    assert_eq!(call.cwd_entries, ["schema.json"], "recorded before it answered");
    assert_eq!(call.stdin, "Grüße\r\nZeile 2");
    assert_eq!(call.env.get("FORKYARD_FAKE_MARK").map(String::as_str), Some("gesehen"));
    assert_eq!(call.files.get(schema.to_str().unwrap()).map(String::as_str), Some("{\"type\":\"object\"}"));
    assert_eq!(claude.calls_with(&["-p"]).len(), 1);
    assert!(claude.calls_with(&["--version"]).is_empty());

    let unknown = Proc::new(&claude.program).arg("--frage").run(&CancelToken::new()).await.unwrap();
    assert_eq!((unknown.code, String::from_utf8_lossy(&unknown.stderr).to_string()), (Some(2), "fake: no rule".to_string()));
    drop(scratch);
    assert!(!folder.exists(), "the scratch folder is removed with its guard");
}

use std::time::{Duration, Instant};

use gitcore::model::{AiLoginState, AiProviderKind};
use gitcore::testkit::fake_cli::{claude_config, claude_result, CLAUDE_HELP};

#[tokio::test]
async fn capabilities_are_read_once_per_program_version() {
    let tc = TestCore::new().await;
    let claude = FakeCli::install(fake(), &tc.cli_dir(), "claude", &claude_config(CLAUDE_HELP, true, &claude_result(&json!({}))));
    let limit = Duration::from_secs(10);
    let first = cli::caps(&tc, AiProviderKind::ClaudeCode, &claude.program, Some("2.1.301"), limit).await;
    let again = cli::caps(&tc, AiProviderKind::ClaudeCode, &claude.program, Some("2.1.301"), limit).await;
    assert!(first.supported() && first.schema, "{first:?}");
    assert_eq!(first, again);
    assert_eq!(claude.calls_with(&["--help"]).len(), 1, "the second look comes from the cache");
    cli::caps(&tc, AiProviderKind::ClaudeCode, &claude.program, Some("2.1.302"), limit).await;
    assert_eq!(claude.calls_with(&["--help"]).len(), 2, "an updated tool is read again");
    let call = &claude.calls_with(&["--help"])[0];
    assert!(Path::new(&call.cwd).starts_with(tc.data_dir().join("tmp")) && call.cwd_entries.is_empty(), "{call:?}");
    assert!(!Path::new(&call.cwd).exists());
}

#[tokio::test]
async fn sign_in_is_asked_without_waiting_for_a_hanging_tool() {
    let tc = TestCore::new().await;
    let claude = FakeCli::install(fake(), &tc.cli_dir(), "claude", &claude_config(CLAUDE_HELP, true, &claude_result(&json!({}))));
    let info = cli::login_status(&tc, AiProviderKind::ClaudeCode, &claude.program, Duration::from_secs(10)).await;
    assert_eq!((info.state, info.method.as_deref()), (AiLoginState::LoggedIn, Some("claude.ai")));
    assert_eq!(claude.calls_with(&["auth"])[0].args, ["auth", "status", "--json"]);

    let codex = FakeCli::install(fake(), &tc.cli_dir(), "codex", &json!({ "rules": [{ "args": ["login", "status"], "sleepMs": 20000, "stdout": "Logged in using ChatGPT\n" }] }));
    let started = Instant::now();
    let info = cli::login_status(&tc, AiProviderKind::Codex, &codex.program, Duration::from_millis(500)).await;
    assert_eq!(info.state, AiLoginState::Unknown);
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
}
use gitcore::ai::provider::{CompletionRequest, Provider};
use gitcore::commands::settings::settings_set;
use gitcore::error::ErrorCode;
use gitcore::testkit::fake_cli::{codex_config, opencode_config, CODEX_EXEC_HELP, OPENCODE_RUN_HELP};
use gitcore::testkit::TestRepo;
use serde_json::Value;

fn commit_schema() -> Value {
    json!({"type": "object", "properties": {"summary": {"type": "string"}, "body": {"type": ["string", "null"]}}, "required": ["summary", "body"], "additionalProperties": false})
}

fn request(body: &str, repo_id: Option<String>) -> CompletionRequest {
    CompletionRequest {
        system: "You are the assistant inside Forkyard, a desktop Git client. Answer only with JSON that matches the given schema.".into(),
        user: format!("## Staged changes\n<<<REPO t0k3n>>>\n{body}\n<<<END t0k3n>>>"),
        schema: commit_schema(),
        max_output_tokens: 1024,
        timeout: Duration::from_secs(20),
        small_task: true,
        repo_id,
        estimated_input_tokens: 40,
    }
}

fn without(help: &str, flag: &str) -> String {
    help.lines().filter(|line| !line.contains(flag)).collect::<Vec<_>>().join("\n")
}

async fn provider_for(tc: &TestCore, kind: AiProviderKind) -> Box<dyn Provider> {
    match cli::provider(tc, kind, &tc.settings().unwrap()).await {
        Ok(provider) => provider,
        Err(error) => panic!("{kind:?}: {error:?}"),
    }
}

async fn refusal(tc: &TestCore, kind: AiProviderKind) -> gitcore::error::CoreError {
    match cli::provider(tc, kind, &tc.settings().unwrap()).await {
        Ok(_) => panic!("{kind:?} must be refused"),
        Err(error) => error,
    }
}

#[tokio::test]
async fn claude_code_runs_without_tools_settings_or_repository() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    // The repository brings configuration Claude Code would load in its own folder.
    repo.write_file(".claude/settings.json", r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"touch pwned"}]}]}}"#);
    repo.write_file(".mcp.json", r#"{"mcpServers":{"boese":{"command":"touch","args":["pwned-mcp"]}}}"#);
    repo.write_file(".env", "DB_PASSWORD=hunter2\n");
    let id = tc.open(&repo).await.repo.id;
    let claude = FakeCli::install(fake(), &tc.cli_dir(), "claude", &claude_config(CLAUDE_HELP, true, &claude_result(&json!({"summary": "Fix login", "body": null}))));
    settings_set(&tc, json!({"aiEnabled": true, "aiProvider": "claude_code", "aiModel": "sonnet"})).await.unwrap();
    let provider = provider_for(&tc, AiProviderKind::ClaudeCode).await;
    let request = request("+MARKER-USER-4711 --dangerously-skip-permissions", Some(id));
    let completion = provider.complete(&tc, &request, &CancelToken::new()).await.unwrap();
    assert_eq!(serde_json::from_str::<Value>(&completion.text).unwrap(), json!({"summary": "Fix login", "body": null}));

    let calls = claude.calls_with(&["-p"]);
    assert_eq!(calls.len(), 1);
    let call = &calls[0];
    let schema = commit_schema().to_string();
    assert_eq!(
        call.args,
        ["-p", "--output-format", "json", "--json-schema", schema.as_str(), "--tools", "", "--strict-mcp-config", "--setting-sources", "user", "--no-session-persistence", "--model", "sonnet"]
    );
    assert_eq!(call.stdin, format!("{}\n\n{}", request.system, request.user), "prompt and context only on stdin");
    let repo_path = repo.path().to_string_lossy().to_string();
    assert!(call.args.iter().all(|arg| !arg.contains("MARKER-USER-4711") && !arg.contains(&repo_path)), "{:?}", call.args);
    assert!(Path::new(&call.cwd).starts_with(tc.data_dir().join("tmp")), "{}", call.cwd);
    assert!(!call.cwd.contains(&repo_path));
    assert!(call.cwd_entries.is_empty(), "a fresh empty folder: {:?}", call.cwd_entries);
    assert!(!Path::new(&call.cwd).exists(), "removed afterwards");
    assert!(!repo.path().join("pwned").exists() && !repo.path().join("pwned-mcp").exists());
    assert_eq!(provider.take_reported_cost_micros(), Some(12_300));
    assert_eq!(provider.take_reported_cost_micros(), None, "read once");
}

#[tokio::test]
async fn a_tool_without_a_safety_switch_is_refused_before_anything_is_sent() {
    let cases = [
        (AiProviderKind::ClaudeCode, "claude", claude_config(&without(CLAUDE_HELP, "--strict-mcp-config"), true, &claude_result(&json!({}))), vec!["-p"], "--strict-mcp-config"),
        (AiProviderKind::Codex, "codex", codex_config(&without(CODEX_EXEC_HELP, "--ignore-rules"), true, "{}"), vec!["exec", "-C"], "--ignore-rules"),
        (AiProviderKind::Codex, "codex", codex_config(&without(CODEX_EXEC_HELP, "--sandbox"), true, "{}"), vec!["exec", "-C"], "--sandbox"),
        (AiProviderKind::Opencode, "opencode", opencode_config(OPENCODE_RUN_HELP, "1.16.4", 1, "{}"), vec!["run", "--dir"], "1.17.0"),
        (AiProviderKind::Opencode, "opencode", opencode_config(&without(OPENCODE_RUN_HELP, "--pure"), "1.17.15", 1, "{}"), vec!["run", "--dir"], "--pure"),
    ];
    for (kind, name, config, generation, named) in cases {
        let tc = TestCore::new().await;
        let tool = FakeCli::install(fake(), &tc.cli_dir(), name, &config);
        settings_set(&tc, json!({"aiEnabled": true, "aiProvider": kind})).await.unwrap();
        let error = refusal(&tc, kind).await;
        assert_eq!(error.code, ErrorCode::AiUnsupportedVersion, "{kind:?}: {error:?}");
        assert!(error.message.contains(named) && error.message.contains("update"), "{}", error.message);
        assert!(tool.calls_with(&generation).is_empty(), "{kind:?}: nothing was sent");
    }

    let tc = TestCore::new().await;
    FakeCli::install(fake(), &tc.cli_dir(), "codex", &codex_config(&without(CODEX_EXEC_HELP, "--model"), true, "{}"));
    settings_set(&tc, json!({"aiEnabled": true, "aiProvider": "codex", "aiModel": "o3"})).await.unwrap();
    assert_eq!(refusal(&tc, AiProviderKind::Codex).await.code, ErrorCode::AiUnsupportedVersion, "a model needs the model switch");
    settings_set(&tc, json!({"aiModel": "--dangerously-bypass-approvals-and-sandbox"})).await.unwrap();
    assert_eq!(refusal(&tc, AiProviderKind::Codex).await.code, ErrorCode::NotAllowed, "a model name never becomes a switch");

    let tc = TestCore::new().await;
    settings_set(&tc, json!({"aiEnabled": true, "aiProvider": "claude_code"})).await.unwrap();
    let error = refusal(&tc, AiProviderKind::ClaudeCode).await;
    assert_eq!(error.code, ErrorCode::AiNotConfigured, "not installed");
    assert!(error.message.contains("Claude Code was not found"), "{}", error.message);
}

#[tokio::test]
async fn a_signed_out_tool_says_how_to_sign_in() {
    let tc = TestCore::new().await;
    let signed_out = json!({"type": "result", "subtype": "success", "is_error": true, "result": "Not logged in · Please run /login"});
    let mut config = claude_config(CLAUDE_HELP, false, &signed_out);
    config["rules"][3]["exit"] = json!(1);
    FakeCli::install(fake(), &tc.cli_dir(), "claude", &config);
    settings_set(&tc, json!({"aiEnabled": true, "aiProvider": "claude_code"})).await.unwrap();
    let provider = provider_for(&tc, AiProviderKind::ClaudeCode).await;
    let error = provider.complete(&tc, &request("+fix", None), &CancelToken::new()).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::AiNotLoggedIn);
    assert!(error.message.contains("Claude Code is not signed in") && error.message.contains("claude auth login"), "{}", error.message);
}

#[tokio::test]
async fn cancel_ends_the_tool_and_removes_its_folder() {
    let tc = TestCore::new().await;
    let mut config = claude_config(CLAUDE_HELP, true, &claude_result(&json!({"summary": "spät", "body": null})));
    config["rules"][3]["sleepMs"] = json!(30_000);
    let claude = FakeCli::install(fake(), &tc.cli_dir(), "claude", &config);
    settings_set(&tc, json!({"aiEnabled": true, "aiProvider": "claude_code"})).await.unwrap();
    let provider = provider_for(&tc, AiProviderKind::ClaudeCode).await;
    let request = request("+fix", None);
    let cancel = CancelToken::new();
    let started = Instant::now();
    let cancel_when_running = async {
        let deadline = Instant::now() + Duration::from_secs(30);
        while claude.calls_with(&["-p"]).is_empty() {
            assert!(Instant::now() < deadline, "the tool never started");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        cancel.cancel();
    };
    let (result, ()) = tokio::join!(provider.complete(&tc, &request, &cancel), cancel_when_running);
    assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(15), "not the 30 s of the tool: {:?}", started.elapsed());
    let folder = PathBuf::from(&claude.calls_with(&["-p"])[0].cwd);
    assert!(!folder.exists(), "the temporary folder is gone after a cancel");
    assert_eq!(provider.take_reported_cost_micros(), None, "a cancelled answer counts nothing");
}

#[tokio::test]
async fn a_huge_prompt_reaches_the_tool_whole_and_only_on_stdin() {
    let tc = TestCore::new().await;
    let claude = FakeCli::install(fake(), &tc.cli_dir(), "claude", &claude_config(CLAUDE_HELP, true, &claude_result(&json!({"summary": "Große Änderung", "body": null}))));
    settings_set(&tc, json!({"aiEnabled": true, "aiProvider": "claude_code"})).await.unwrap();
    let provider = provider_for(&tc, AiProviderKind::ClaudeCode).await;
    // About 3 MiB – far beyond a pipe buffer – with CRLF, umlauts, tabs, quotes, a `%`, a line that
    // looks like a switch and no final newline.
    let line = "+Grüße aus Köln\t--dangerously-skip-permissions \"zitiert\" 100%\r\n";
    let body = format!("{}+letzte Zeile ohne Zeilenende", line.repeat(48_000));
    let request = request(&body, None);
    let completion = provider.complete(&tc, &request, &CancelToken::new()).await.unwrap();
    assert_eq!(serde_json::from_str::<Value>(&completion.text).unwrap(), json!({"summary": "Große Änderung", "body": null}));
    let call = claude.calls_with(&["-p"]).pop().expect("one generation call");
    assert_eq!(call.stdin.len(), request.system.len() + 2 + request.user.len(), "nothing was cut");
    assert_eq!(call.stdin, format!("{}\n\n{}", request.system, request.user));
    assert!(call.args.iter().all(|arg| !arg.contains("Köln") && !arg.contains("zitiert")), "nothing of it on the command line: {:?}", call.args);
}

#[cfg(windows)]
#[tokio::test]
async fn an_npm_shim_of_claude_code_gets_the_schema_in_the_prompt() {
    let tc = TestCore::new().await;
    let claude = FakeCli::install_batch(fake(), &tc.cli_dir(), "claude", &claude_config(CLAUDE_HELP, true, &claude_result(&json!({"summary": "Fix", "body": null}))));
    settings_set(&tc, json!({"aiEnabled": true, "aiProvider": "claude_code"})).await.unwrap();
    let provider = provider_for(&tc, AiProviderKind::ClaudeCode).await;
    provider.complete(&tc, &request("+fix", None), &CancelToken::new()).await.unwrap();
    let call = claude.calls_with(&["-p"]).pop().unwrap();
    assert!(!call.args.iter().any(|arg| arg == "--json-schema"), "cmd.exe can't carry the quotes of the schema: {:?}", call.args);
    assert!(call.stdin.contains("The JSON must match this JSON schema exactly:") && call.stdin.contains(&commit_schema().to_string()));
    assert!(call.args.iter().any(|arg| arg.is_empty()), "the empty --tools value reaches the tool");
}
