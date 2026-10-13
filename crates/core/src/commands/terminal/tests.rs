//! Tests of the terminal with a real shell as a child process.

use std::time::{Duration, Instant};

use super::*;
use crate::error::ErrorCode;
use crate::testkit::{TestCore, TestRepo};

const WAIT: Duration = Duration::from_secs(90);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Shell {
    /// PowerShell 7 or Windows PowerShell.
    Pwsh,
    Cmd,
    Posix,
}

fn shell_kind() -> Shell {
    let env_shell = std::env::var("SHELL").ok();
    let (program, _) = default_shell(env_shell.as_deref(), &program_exists);
    let name = program.to_lowercase();
    if name.contains("pwsh") || name.contains("powershell") {
        Shell::Pwsh
    } else if name.contains("cmd") {
        Shell::Cmd
    } else {
        Shell::Posix
    }
}

async fn setup() -> (TestCore, TestRepo, String) {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    (tc, repo, id)
}

/// A terminal's output so far, assembled from all `terminal:data` events.
fn output_of(tc: &TestCore, terminal: &str) -> String {
    tc.events
        .named(names::TERMINAL_DATA)
        .iter()
        .filter(|e| e["terminalId"] == terminal)
        .map(|e| e["data"].as_str().unwrap_or_default().to_string())
        .collect()
}

fn exit_events(tc: &TestCore, terminal: &str) -> Vec<Option<i64>> {
    tc.events.named(names::TERMINAL_EXIT).iter().filter(|e| e["terminalId"] == terminal).map(|e| e["code"].as_i64()).collect()
}

async fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !done() {
        assert!(Instant::now() < deadline, "timeout: {what}");
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

async fn wait_for_output(tc: &TestCore, terminal: &str, needle: &str) -> String {
    let deadline = Instant::now() + WAIT;
    while !output_of(tc, terminal).contains(needle) {
        assert!(Instant::now() < deadline, "timeout: output containing \"{needle}\"; so far: {:?}", output_of(tc, terminal));
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    output_of(tc, terminal)
}

async fn send(tc: &TestCore, terminal: &str, line: &str) {
    terminal_write(tc, terminal.to_string(), format!("{line}\r")).await.unwrap();
}

/// A command whose output contains "MARK42END" but whose typed line does not.
fn computed_echo(shell: Shell) -> &'static str {
    match shell {
        Shell::Cmd => "for /L %i in (42,1,42) do @echo MARK%iEND",
        _ => "echo MARK$((40+2))END",
    }
}

fn digits_between(text: &str, open: &str, close: &str) -> Option<String> {
    let mut rest = text;
    while let Some(start) = rest.find(open) {
        let after = &rest[start + open.len()..];
        let digits: String = after.chars().take_while(char::is_ascii_digit).collect();
        if !digits.is_empty() && after[digits.len()..].starts_with(close) {
            return Some(digits);
        }
        rest = after;
    }
    None
}

fn process_alive(pid: &str) -> bool {
    if cfg!(windows) {
        let out = std::process::Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"]).output().expect("tasklist");
        String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
    } else {
        std::process::Command::new("kill").args(["-0", pid]).status().map(|s| s.success()).unwrap_or(false)
    }
}

#[test]
fn utf8_is_never_split_across_events() {
    let mut chunks = Utf8Chunks::default();
    let text = "Grüße 😀 – fertig";
    let bytes = text.as_bytes();
    // Every split of the stream yields the same text, never half a character.
    for split in 0..=bytes.len() {
        let mut out = chunks.push(&bytes[..split]);
        assert!(!out.contains('\u{FFFD}'), "split at {split}: {out:?}");
        out.push_str(&chunks.push(&bytes[split..]));
        out.push_str(&chunks.finish());
        assert_eq!(out, text, "split at {split}");
    }
    // Byte by byte.
    let mut out = String::new();
    for byte in bytes {
        out.push_str(&chunks.push(std::slice::from_ref(byte)));
    }
    assert_eq!(out, text);
    // Invalid bytes are replaced, the rest stays; likewise a truncated character at the end.
    assert_eq!(chunks.push(b"a\xffb\xc3"), "a\u{FFFD}b");
    assert_eq!(chunks.finish(), "\u{FFFD}");
    assert_eq!(chunks.push(b""), "");
}

#[test]
fn the_shell_is_chosen_per_platform() {
    let all = |_: &str| true;
    let none = |_: &str| false;
    if cfg!(windows) {
        assert_eq!(default_shell(None, &all).0, "pwsh.exe");
        assert_eq!(default_shell(None, &|p| p == "powershell.exe").0, "powershell.exe");
        assert_eq!(default_shell(Some("/bin/zsh"), &none), ("cmd.exe".to_string(), vec![]));
    } else {
        assert_eq!(default_shell(Some("/bin/zsh"), &all), ("/bin/zsh".to_string(), vec!["-l".to_string()]));
        assert_eq!(default_shell(Some("/opt/eigene-shell"), &all), ("/opt/eigene-shell".to_string(), vec![]));
        assert_eq!(default_shell(Some("/gibt/es/nicht"), &|p| p == "bash").0, "bash");
        assert_eq!(default_shell(None, &none).0, "sh");
        assert_eq!(default_shell(Some("  "), &all).0, "bash");
    }
}

#[tokio::test]
async fn a_command_runs_in_the_repository_and_its_output_arrives() {
    let (tc, repo, id) = setup().await;
    let shell = shell_kind();
    let terminal = terminal_open(&tc, id.clone(), 120, 30).await.unwrap();
    assert_eq!(tc.state::<TerminalState>().open_ids(), vec![terminal.clone()]);

    send(&tc, &terminal, computed_echo(shell)).await;
    wait_for_output(&tc, &terminal, "MARK42END").await;

    // The working directory is the repository; the user's environment is there (PATH: git is found).
    repo.write_file("nur-hier-4711.txt", "x\n");
    send(&tc, &terminal, if shell == Shell::Posix { "ls" } else { "dir" }).await;
    wait_for_output(&tc, &terminal, "nur-hier-4711.txt").await;
    send(&tc, &terminal, "git rev-parse HEAD").await;
    wait_for_output(&tc, &terminal, &repo.head()).await;

    // Umlauts and emoji arrive as valid UTF-8 – both ways.
    repo.write_file("grüße-😀.txt", "x\n");
    send(&tc, &terminal, "git status --porcelain").await;
    let seen = wait_for_output(&tc, &terminal, "nur-hier-4711.txt").await;
    assert!(!seen.contains('\u{FFFD}'), "{seen:?}");

    // Exit code of the shell.
    send(&tc, &terminal, "exit 3").await;
    wait_until("terminal:exit", || !exit_events(&tc, &terminal).is_empty()).await;
    assert_eq!(exit_events(&tc, &terminal), [Some(3)]);
    assert!(tc.state::<TerminalState>().open_ids().is_empty());
    // Afterwards the session is gone.
    assert_eq!(terminal_write(&tc, terminal.clone(), "x".into()).await.unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(terminal_resize(&tc, terminal.clone(), 80, 24).await.unwrap_err().code, ErrorCode::NotFound);
    terminal_close(&tc, terminal).await.unwrap();
}

#[tokio::test]
async fn resize_reaches_the_shell_and_odd_sizes_do_not_crash() {
    let (tc, _repo, id) = setup().await;
    let shell = shell_kind();
    let terminal = terminal_open(&tc, id.clone(), 80, 24).await.unwrap();
    send(&tc, &terminal, computed_echo(shell)).await;
    wait_for_output(&tc, &terminal, "MARK42END").await;

    for (cols, rows) in [(0, 0), (1, 1), (u16::MAX, u16::MAX), (132, 43), (132, 43), (97, 31)] {
        terminal_resize(&tc, terminal.clone(), cols, rows).await.unwrap();
    }
    let query = match shell {
        Shell::Pwsh => Some("echo \"W$($Host.UI.RawUI.WindowSize.Width)x$($Host.UI.RawUI.WindowSize.Height)W\""),
        Shell::Posix => Some("echo \"W$(stty size | awk '{print $2 \"x\" $1}')W\""),
        Shell::Cmd => None,
    };
    if let Some(query) = query {
        send(&tc, &terminal, query).await;
        wait_for_output(&tc, &terminal, "W97x31W").await;
    }
    // After resizing, the shell keeps running.
    send(&tc, &terminal, computed_echo(shell).replace("MARK", "NOCH").as_str()).await;
    wait_for_output(&tc, &terminal, "NOCH42END").await;
    terminal_close(&tc, terminal.clone()).await.unwrap();
    wait_until("terminal:exit after close", || !exit_events(&tc, &terminal).is_empty()).await;
}

#[tokio::test]
async fn close_ends_the_shell_and_everything_it_started() {
    let (tc, _repo, id) = setup().await;
    let shell = shell_kind();
    let terminal = terminal_open(&tc, id.clone(), 100, 30).await.unwrap();
    send(&tc, &terminal, computed_echo(shell)).await;
    wait_for_output(&tc, &terminal, "MARK42END").await;

    let start_child = match shell {
        Shell::Pwsh => Some("$p = Start-Process -FilePath ping -ArgumentList '-n','900','127.0.0.1' -PassThru -NoNewWindow; echo \"PID$($p.Id)PID\""),
        Shell::Posix => Some("sleep 900 & echo \"PID$!PID\""),
        Shell::Cmd => None,
    };
    let child = match start_child {
        Some(command) => {
            send(&tc, &terminal, command).await;
            wait_until("PID of the child process", || digits_between(&output_of(&tc, &terminal), "PID", "PID").is_some()).await;
            let pid = digits_between(&output_of(&tc, &terminal), "PID", "PID").unwrap();
            assert!(process_alive(&pid), "the child process {pid} is running");
            Some(pid)
        }
        None => None,
    };

    let started = Instant::now();
    terminal_close(&tc, terminal.clone()).await.unwrap();
    wait_until("terminal:exit after close", || !exit_events(&tc, &terminal).is_empty()).await;
    assert!(started.elapsed() < Duration::from_secs(30), "{:?}", started.elapsed());
    assert_eq!(exit_events(&tc, &terminal).len(), 1, "exactly one terminal:exit");
    assert!(tc.state::<TerminalState>().open_ids().is_empty());
    if let Some(pid) = child {
        wait_until(&format!("child process {pid} ended"), || !process_alive(&pid)).await;
    }
    // Closing twice and closing something unknown is not an error.
    terminal_close(&tc, terminal.clone()).await.unwrap();
    terminal_close(&tc, "gibt-es-nicht".into()).await.unwrap();
}

#[tokio::test]
async fn output_is_bundled_and_several_terminals_stay_apart() {
    let (tc, _repo, id) = setup().await;
    let shell = shell_kind();
    let first = terminal_open(&tc, id.clone(), 100, 30).await.unwrap();
    let second = terminal_open(&tc, id.clone(), 100, 30).await.unwrap();
    assert_ne!(first, second);
    send(&tc, &first, computed_echo(shell).replace("MARK", "ERSTES").as_str()).await;
    send(&tc, &second, computed_echo(shell).replace("MARK", "ZWEITES").as_str()).await;
    wait_for_output(&tc, &first, "ERSTES42END").await;
    wait_for_output(&tc, &second, "ZWEITES42END").await;
    assert!(!output_of(&tc, &first).contains("ZWEITES42END") && !output_of(&tc, &second).contains("ERSTES42END"));

    // Many lines at once: far fewer events than lines, and nothing gets lost.
    let before = tc.events.named(names::TERMINAL_DATA).iter().filter(|e| e["terminalId"] == first.as_str()).count();
    let flood = match shell {
        Shell::Pwsh => "1..3000 | ForEach-Object { \"zeile-$_-ende\" }",
        Shell::Posix => "i=1; while [ $i -le 3000 ]; do echo \"zeile-$i-ende\"; i=$((i+1)); done",
        Shell::Cmd => "for /L %i in (1,1,3000) do @echo zeile-%i-ende",
    };
    send(&tc, &first, flood).await;
    let seen = wait_for_output(&tc, &first, "zeile-3000-ende").await;
    assert!(seen.contains("zeile-1-ende") && seen.contains("zeile-1500-ende"));
    let events = tc.events.named(names::TERMINAL_DATA).iter().filter(|e| e["terminalId"] == first.as_str()).count() - before;
    assert!(events < 1500, "{events} events for 3000 lines");
    let largest = tc.events.named(names::TERMINAL_DATA).iter().map(|e| e["data"].as_str().unwrap_or_default().len()).max().unwrap_or(0);
    assert!(largest <= MAX_EVENT_BYTES * 3, "an event is at most {MAX_EVENT_BYTES} raw bytes: {largest}");

    for terminal in [&first, &second] {
        terminal_close(&tc, terminal.to_string()).await.unwrap();
        wait_until("terminal:exit", || !exit_events(&tc, terminal).is_empty()).await;
    }
    assert!(tc.state::<TerminalState>().open_ids().is_empty());
}

#[tokio::test]
async fn bad_input_is_refused() {
    let (tc, repo, id) = setup().await;
    assert_eq!(terminal_open(&tc, "unbekannt".into(), 80, 24).await.unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(terminal_write(&tc, "unbekannt".into(), "x".into()).await.unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(terminal_resize(&tc, "unbekannt".into(), 80, 24).await.unwrap_err().code, ErrorCode::NotFound);

    let terminal = terminal_open(&tc, id.clone(), 80, 24).await.unwrap();
    let huge = "x".repeat(MAX_WRITE_BYTES + 1);
    assert_eq!(terminal_write(&tc, terminal.clone(), huge).await.unwrap_err().code, ErrorCode::NotAllowed);
    close_all(&tc);
    wait_until("terminal:exit after close_all", || !exit_events(&tc, &terminal).is_empty()).await;

    // The repository's folder is gone.
    let gone = repo.path().to_path_buf();
    drop(repo);
    assert!(!gone.exists());
    assert_eq!(terminal_open(&tc, id, 80, 24).await.unwrap_err().code, ErrorCode::PathNotFound);
}
