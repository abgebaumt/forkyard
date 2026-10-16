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
