//! Terminals that run a program (coding agents) in a worktree of the repository, and what their
//! output signals.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use super::*;
use crate::error::ErrorCode;
use crate::testkit::{TestCore, TestRepo};

const WAIT: Duration = Duration::from_secs(60);

#[derive(Default)]
struct Seen {
    screen: AtomicUsize,
    signals: Mutex<Vec<TerminalSignal>>,
}

impl TerminalObserver for Seen {
    fn screen_changed(&self, _terminal_id: &str) {
        self.screen.fetch_add(1, Ordering::SeqCst);
    }
    fn signal(&self, _terminal_id: &str, signal: &TerminalSignal) {
        self.signals.lock().push(signal.clone());
    }
}

fn output_of(tc: &TestCore, terminal: &str) -> String {
    tc.events.named(names::TERMINAL_DATA).iter().filter(|e| e["terminalId"] == terminal).map(|e| e["data"].as_str().unwrap_or_default().to_string()).collect()
}

async fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !done() {
        assert!(Instant::now() < deadline, "timeout: {what}");
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

/// A program that prints its folder, runs `extra_unix` (Unix only) and then waits.
fn printing_program(extra_unix: &str) -> (PathBuf, Vec<OsString>) {
    if cfg!(windows) {
        (which::which("powershell.exe").unwrap(), vec!["-NoProfile".into(), "-Command".into(), "(Get-Location).Path; Start-Sleep -Seconds 30".into()])
    } else {
        (PathBuf::from("/bin/sh"), vec!["-c".into(), format!("pwd -P; {extra_unix} sleep 30").into()])
    }
}

fn launch(program: PathBuf, args: Vec<OsString>, cwd: &Path) -> ProgramLaunch {
    ProgramLaunch { program, args, cwd: cwd.to_path_buf(), env: vec![("FY_AGENT".into(), "1".into())], title: "fix-login".into() }
}

#[test]
fn signals_split_across_chunks_and_bel_inside_osc() {
    let chunks: [&[u8]; 5] = [
        b"ab\x1b]0;Agent ",
        b"B\x07\x07x\x1b]777;notify;Fertig;Tests gr\xc3\xbcn\x1b\\",
        b"\x1b]9;4;1;50\x07",
        b"\x1b]9;fertig\x1b\\",
        b"\x1b[2J",
    ];
    let mut scanner = SignalScanner::default();
    let results: Vec<Scanned> = chunks.iter().map(|chunk| scanner.feed(chunk)).collect();
    let notify = |title: Option<&str>, body: &str| TerminalSignal::Notify { title: title.map(str::to_string), body: body.to_string() };
    assert_eq!(results[0], Scanned { screen_changed: true, signals: vec![] }, "a half title is no signal yet");
    assert_eq!(
        results[1],
        Scanned { screen_changed: true, signals: vec![TerminalSignal::Title("Agent B".into()), TerminalSignal::Bell, notify(Some("Fertig"), "Tests grün")] },
        "the BEL that ends the title is no bell; the second one is"
    );
    assert_eq!(results[2], Scanned { screen_changed: false, signals: vec![] }, "OSC 9;4 is a progress report");
    assert_eq!(results[3], Scanned { screen_changed: false, signals: vec![notify(None, "fertig")] });
    assert_eq!(results[4], Scanned { screen_changed: true, signals: vec![] });

    // Byte by byte: the same signals.
    let mut scanner = SignalScanner::default();
    let mut signals = Vec::new();
    for byte in chunks.concat() {
        signals.extend(scanner.feed(&[byte]).signals);
    }
    assert_eq!(signals, vec![TerminalSignal::Title("Agent B".into()), TerminalSignal::Bell, notify(Some("Fertig"), "Tests grün"), notify(None, "fertig")]);
}

#[tokio::test]
async fn a_program_runs_in_a_linked_worktree_of_the_repository() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    let worktree = repo.temp_dir().join("repo.agents").join("fix login");
    repo.git(&["worktree", "add", "-q", "-b", "agent/fix-login", worktree.to_str().unwrap()]);
    let (program, args) = printing_program("");
    let terminal = terminal_open_program(&tc, &id, launch(program, args, &worktree), 120, 30, None).await.unwrap();
    let shown = if cfg!(windows) { worktree.display().to_string() } else { std::fs::canonicalize(&worktree).unwrap().display().to_string() };
    wait_until("the folder in the output", || output_of(&tc, &terminal).contains(&shown)).await;
    let info = terminal_info(&tc, &terminal).expect("info of a running terminal");
    assert!(info.program);
    assert_eq!(info.title, "fix-login");
    assert!(info.last_screen_change.is_some());
    terminal_close(&tc, terminal.clone()).await.unwrap();
    wait_until("terminal:exit", || tc.events.named(names::TERMINAL_EXIT).iter().any(|e| e["terminalId"] == terminal.as_str())).await;
    assert!(terminal_info(&tc, &terminal).is_none(), "the session is gone");
}

#[tokio::test]
async fn only_worktrees_of_the_repository_and_located_programs_are_allowed() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let other = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    let (program, args) = printing_program("");
    let stranger = repo.temp_dir().join("fremd");
    std::fs::create_dir_all(&stranger).unwrap();
    let missing = repo.temp_dir().join("gibt-es-nicht");
    let sub = repo.subdir("src");
    for cwd in [stranger.as_path(), other.path(), missing.as_path(), sub.as_path()] {
        let err = terminal_open_program(&tc, &id, launch(program.clone(), args.clone(), cwd), 80, 24, None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed, "{cwd:?}: {err:?}");
    }
    let err = terminal_open_program(&tc, &id, launch(PathBuf::from("sh"), args.clone(), repo.path()), 80, 24, None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound, "only programs the core located (absolute paths)");
    let batch = repo.temp_dir().join("agent.cmd");
    std::fs::write(&batch, "@echo off\r\n").unwrap();
    let err = terminal_open_program(&tc, &id, launch(batch, Vec::new(), repo.path()), 80, 24, None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Unsupported, "{err:?}");
    // The repository itself is its main worktree.
    let terminal = terminal_open_program(&tc, &id, launch(program, args, repo.path()), 80, 24, None).await.unwrap();
    terminal_close(&tc, terminal).await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn bell_title_and_notifications_reach_the_observer() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    let seen = Arc::new(Seen::default());
    let (program, args) = printing_program(r"printf '\033]0;Agent A\007'; printf '\007'; printf '\033]9;fertig\033\\';");
    let observer: Arc<dyn TerminalObserver> = seen.clone();
    let terminal = terminal_open_program(&tc, &id, launch(program, args, repo.path()), 80, 24, Some(observer)).await.unwrap();
    wait_until("three signals", || seen.signals.lock().len() >= 3).await;
    let notify = TerminalSignal::Notify { title: None, body: "fertig".into() };
    assert_eq!(*seen.signals.lock(), vec![TerminalSignal::Title("Agent A".into()), TerminalSignal::Bell, notify.clone()]);
    assert!(seen.screen.load(Ordering::SeqCst) > 0, "the folder name changed the screen");
    assert_eq!(terminal_info(&tc, &terminal).unwrap().last_signal, Some(notify));
    terminal_close(&tc, terminal).await.unwrap();
}
