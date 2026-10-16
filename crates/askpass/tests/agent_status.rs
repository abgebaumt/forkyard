//! The helper's `--agent-status` mode against the core's status channel: the hooks of Claude Code
//! and Codex call it; it must deliver the status and never disturb the agent (exit code 0, no
//! output on stdout), also without a channel or with a wrong token.

use std::time::{Duration, Instant};

use gitcore::commands::agents::channel::{HookSignal, StatusChannel};
use gitcore::testkit::TestCore;

const HELPER: &str = env!("CARGO_BIN_EXE_askpass-helper");

async fn run(args: &[&str], env: &[(&str, String)]) -> std::process::Output {
    let mut cmd = tokio::process::Command::new(HELPER);
    cmd.args(args).env_remove("FORKYARD_AGENT_PORT").env_remove("FORKYARD_AGENT_TOKEN");
    for (key, value) in env {
        cmd.env(key, value);
    }
    cmd.output().await.unwrap()
}

#[tokio::test]
async fn the_helper_reports_every_status_and_always_exits_cleanly() {
    let tc = TestCore::new().await;
    let channel = tc.state::<StatusChannel>();
    let port = channel.port().await.expect("status channel");
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let token = channel.register(tx);
    let env = vec![("FORKYARD_AGENT_PORT", port.to_string()), ("FORKYARD_AGENT_TOKEN", token.clone())];

    for (state, expected) in [("waiting", HookSignal::Waiting), ("running", HookSignal::Running), ("done", HookSignal::Done)] {
        let out = run(&["--agent-status", state], &env).await;
        assert!(out.status.success(), "{state}: {:?}", out);
        assert!(out.stdout.is_empty(), "nothing on stdout (hooks may read it)");
        assert_eq!(rx.recv().await, Some(expected));
    }
    // Codex passes the event as a further JSON argument.
    let out = run(&["--agent-status", "done", r#"{"type":"agent-turn-complete","turn-id":"1"}"#], &env).await;
    assert!(out.status.success());
    assert_eq!(rx.recv().await, Some(HookSignal::Done));

    // Wrong token, unknown state, no channel at all: still exit 0, nothing delivered.
    let wrong = vec![("FORKYARD_AGENT_PORT", port.to_string()), ("FORKYARD_AGENT_TOKEN", "0".repeat(32))];
    let out = run(&["--agent-status", "done"], &wrong).await;
    assert!(out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("not accepted"), "{}", String::from_utf8_lossy(&out.stderr));
    assert!(run(&["--agent-status", "fertig"], &env).await.status.success());
    let started = Instant::now();
    let out = run(&["--agent-status", "done"], &[]).await;
    assert!(out.status.success());
    assert!(started.elapsed() < Duration::from_secs(5), "never waits long");
    assert!(rx.try_recv().is_err());
}
