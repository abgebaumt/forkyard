//! Tests of the process runner with real child processes: `/bin/sh` on Unix, Windows PowerShell on
//! Windows. Nothing here talks to the network.

use std::time::{Duration, Instant};

use super::*;
use crate::error::ErrorCode;
use crate::events::names;
use crate::model::ActivityScope;
use crate::testkit::{temp_folder, TestCore};

/// A shell command: `/bin/sh -c` on Unix, Windows PowerShell on Windows.
fn shell(unix: &str, windows: &str) -> Proc {
    if cfg!(windows) {
        Proc::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", windows])
    } else {
        Proc::new("/bin/sh").args(["-c", unix])
    }
}

fn process_alive(pid: &str) -> bool {
    if cfg!(windows) {
        let out = std::process::Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"]).output().expect("tasklist");
        String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
    } else {
        std::process::Command::new("kill").args(["-0", pid]).status().map(|s| s.success()).unwrap_or(false)
    }
}

async fn wait_for_file(path: &Path) -> String {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok(text) = std::fs::read_to_string(path) {
            let text = text.trim().to_string();
            if !text.is_empty() {
                return text;
            }
        }
        assert!(Instant::now() < deadline, "{} never appeared", path.display());
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
}

#[tokio::test]
async fn passes_stdin_env_and_cwd_and_returns_the_exit_code() {
    let dir = temp_folder();
    let cwd = dir.path().join("Ordner mit Leerzeichen");
    std::fs::create_dir_all(&cwd).unwrap();
    let out = shell(
        "printf '%s|%s|' \"$FY_PROC_TEST\" \"$(pwd -P)\"; cat; exit 3",
        "[Console]::Out.Write($env:FY_PROC_TEST + '|' + (Get-Location).Path + '|'); [Console]::Out.Write([Console]::In.ReadToEnd()); exit 3",
    )
    .cwd(&cwd)
    .env("FY_PROC_TEST", "wert")
    .stdin(b"Eingabe\r\nZeile 2".to_vec())
    .run(&CancelToken::new())
    .await
    .unwrap();
    let shown = if cfg!(windows) { cwd.display().to_string() } else { std::fs::canonicalize(&cwd).unwrap().display().to_string() };
    assert_eq!(out.code, Some(3), "a non-zero exit is a result, not an error");
    assert!(!out.success());
    assert_eq!(String::from_utf8_lossy(&out.stdout), format!("wert|{shown}|Eingabe\r\nZeile 2"));
}

#[cfg(unix)]
#[tokio::test]
async fn arguments_reach_the_program_unchanged() {
    let out = Proc::new("/bin/sh")
        .args(["-c", "printf '%s\\n' \"$@\"", "sh", "-leading-dash", "mit Leerzeichen", "Grüße ä", ""])
        .run(&CancelToken::new())
        .await
        .unwrap();
    assert!(out.success());
    assert_eq!(String::from_utf8(out.stdout).unwrap(), "-leading-dash\nmit Leerzeichen\nGrüße ä\n\n");
}

#[tokio::test]
async fn a_timeout_stops_the_program() {
    let start = Instant::now();
    let err = shell("sleep 30", "Start-Sleep -Seconds 30").timeout(Duration::from_millis(500)).run(&CancelToken::new()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Timeout, "{err:?}");
    assert!(err.message.contains("0.5 s"), "{}", err.message);
    assert!(start.elapsed() < Duration::from_secs(10), "{:?}", start.elapsed());
}

#[tokio::test]
async fn cancel_ends_the_program_and_what_it_started() {
    let dir = temp_folder();
    let pid_file = dir.path().join("child.pid");
    let cancel = CancelToken::new();
    let proc = shell(
        "sleep 300 & echo $! > child.pid; wait",
        "$p = Start-Process -PassThru -WindowStyle Hidden -FilePath ping.exe -ArgumentList '-n','300','127.0.0.1'; Set-Content -Path child.pid -Value $p.Id -Encoding ascii; Wait-Process -Id $p.Id",
    )
    .cwd(dir.path());
    let running = tokio::spawn({
        let cancel = cancel.clone();
        async move { proc.run(&cancel).await }
    });
    let child = wait_for_file(&pid_file).await;
    assert!(process_alive(&child), "the grandchild runs");
    let start = Instant::now();
    cancel.cancel();
    let err = running.await.unwrap().unwrap_err();
    assert_eq!(err.code, ErrorCode::Cancelled, "{err:?}");
    assert!(start.elapsed() < Duration::from_secs(5), "cancel is immediate: {:?}", start.elapsed());
    let deadline = Instant::now() + Duration::from_secs(10);
    while process_alive(&child) {
        assert!(Instant::now() < deadline, "grandchild {child} still runs");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn a_cancelled_token_starts_nothing() {
    let dir = temp_folder();
    let cancel = CancelToken::new();
    cancel.cancel();
    let err = shell("echo x > ran.txt", "Set-Content -Path ran.txt -Value x").cwd(dir.path()).run(&cancel).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Cancelled);
    assert!(!dir.path().join("ran.txt").exists());
}

#[tokio::test]
async fn too_much_stdout_stops_the_program_and_stderr_is_cut() {
    let err = shell("yes 0123456789 | head -c 20000; sleep 30", "[Console]::Out.Write('x' * 20000); Start-Sleep -Seconds 30")
        .max_output(1024, 1024)
        .timeout(Duration::from_secs(60))
        .run(&CancelToken::new())
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed, "{err:?}");
    assert!(err.message.contains("1 KiB"), "{}", err.message);
    // Exits right away: the limit still counts, even if the pipes close at the same moment.
    let err = shell("yes 0123456789 | head -c 20000", "[Console]::Out.Write('x' * 20000)").max_output(1024, 1024).run(&CancelToken::new()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed, "{err:?}");

    let out = shell("head -c 5000 /dev/zero | tr '\\000' e >&2; printf ok", "[Console]::Error.Write('e' * 5000); [Console]::Out.Write('ok')")
        .max_output(1024, 1024)
        .run(&CancelToken::new())
        .await
        .unwrap();
    assert_eq!(out.stdout, b"ok");
    assert_eq!(out.stderr, vec![b'e'; 1024]);
    assert!(out.stderr_truncated);
}

#[tokio::test]
async fn missing_program_or_folder_are_clear_errors() {
    let err = Proc::new("fy-gibt-es-nicht-4711").run(&CancelToken::new()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound, "{err:?}");
    assert!(err.message.contains("fy-gibt-es-nicht-4711"), "{}", err.message);
    let dir = temp_folder();
    let err = shell("true", "exit 0").cwd(dir.path().join("fehlt")).run(&CancelToken::new()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::PathNotFound, "{err:?}");
}

#[tokio::test]
async fn the_log_names_the_command_but_never_stdin_stdout_or_stderr() {
    let tc = TestCore::new().await;
    tc.events.clear();
    let out = shell(
        "cat >/dev/null; printf 'GEHEIM-STDOUT-%s' $((800+15)); printf 'GEHEIM-STDERR-%s' $((40+2)) >&2  # https://lena:pw-4711@example.com/x",
        "$null = [Console]::In.ReadToEnd(); [Console]::Out.Write('GEHEIM-STDOUT-' + (800+15)); [Console]::Error.Write('GEHEIM-STDERR-' + (40+2)) # https://lena:pw-4711@example.com/x",
    )
    .stdin(b"GEHEIM-STDIN-4711".to_vec())
    .logged(&tc, None, "Testprogramm")
    .run(&CancelToken::new())
    .await
    .unwrap();
    assert!(String::from_utf8_lossy(&out.stdout).contains("GEHEIM-STDOUT-815"), "the program really wrote it");
    assert!(String::from_utf8_lossy(&out.stderr).contains("GEHEIM-STDERR-42"));

    let entries = tc.db.with(|c| crate::db::activity::page(c, ActivityScope::App, None, None, 50)).unwrap().entries;
    let entry = entries.iter().find(|e| e.command.contains("example.com")).expect("log entry with the command line");
    assert_eq!(entry.exit_code, Some(0));
    assert_eq!(entry.output, "", "no program output in the log");
    assert!(!entry.command.contains("pw-4711"), "credentials in the command line are redacted: {}", entry.command);
    for e in &entries {
        for text in [&e.command, &e.output] {
            for secret in ["GEHEIM-STDIN-4711", "GEHEIM-STDOUT-815", "GEHEIM-STDERR-42"] {
                assert!(!text.contains(secret), "{secret} in the log: {text}");
            }
        }
    }
    let events = tc.events.named(names::LOG_APPENDED);
    assert_eq!(events.len(), 1, "{events:?}");
    assert_eq!(events[0]["command"], entry.command.as_str());
}

/// A small program in `dir` that prints "fake-tool 1.2.3 <first argument>": a shell script on Unix,
/// a batch file on Windows.
fn fake_tool(dir: &Path, name: &str) -> PathBuf {
    if cfg!(windows) {
        let path = dir.join(format!("{name}.cmd"));
        std::fs::write(&path, "@echo off\r\necho fake-tool 1.2.3 %~1\r\n").unwrap();
        path
    } else {
        let path = dir.join(name);
        std::fs::write(&path, "#!/bin/sh\nprintf 'fake-tool 1.2.3 %s\\n' \"$1\"\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }
}

#[test]
fn batch_command_lines_quote_paths_and_refuse_cmd_metacharacters() {
    let program = Path::new(r"C:\Users\Max Muster\AppData\Roaming\npm\claude.cmd");
    let line = batch_command_line(program, &["--version".into(), r"C:\Temp\fy (1)\schema.json".into(), "".into()]).unwrap();
    assert_eq!(line, r#""C:\Users\Max Muster\AppData\Roaming\npm\claude.cmd" --version "C:\Temp\fy (1)\schema.json" """#);
    for bad in ["a&b", "100%", "x|y", "\"q\"", "a^b", "!x!", "a<b", "a>b", "a\nb", "a\rb"] {
        let err = batch_command_line(program, &[bad.into()]).unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed, "{bad:?}");
    }
    assert!(is_batch(Path::new(r"C:\x\CLAUDE.CMD")) && is_batch(Path::new("run.bat")));
    assert!(!is_batch(Path::new("claude.exe")) && !is_batch(Path::new("claude")));
}

#[tokio::test]
async fn programs_are_found_on_an_extra_search_path() {
    let dir = temp_folder();
    let bin = dir.path().join("mit Leerzeichen");
    std::fs::create_dir_all(&bin).unwrap();
    fake_tool(&bin, "fy-proc-fake-tool");
    // Windows: found without the extension (PATHEXT) and started through cmd.exe.
    let out = Proc::new("fy-proc-fake-tool").search_path(bin.as_os_str()).arg("--version").run(&CancelToken::new()).await.unwrap();
    assert!(out.success(), "{out:?}");
    assert_eq!(out.stdout_text(), "fake-tool 1.2.3 --version");
    let err = Proc::new("fy-proc-fake-tool").run(&CancelToken::new()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound, "not on PATH without the extra search path");
}

#[cfg(windows)]
#[tokio::test]
async fn batch_files_never_receive_cmd_metacharacters() {
    let dir = temp_folder();
    let script = dir.path().join("tool.cmd");
    std::fs::write(&script, "@echo off\r\necho ran> ran.txt\r\n").unwrap();
    let err = Proc::new(&script).cwd(dir.path()).arg("x & echo pwned> pwned.txt").run(&CancelToken::new()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed, "{err:?}");
    assert!(!dir.path().join("ran.txt").exists(), "nothing started");
    assert!(!dir.path().join("pwned.txt").exists());
}

#[cfg(windows)]
#[tokio::test]
async fn batch_files_receive_arguments_with_spaces_and_parentheses() {
    let dir = temp_folder();
    let script = dir.path().join("zeig mich.cmd");
    std::fs::write(&script, "@echo off\r\necho [%~1]\r\n").unwrap();
    let out = Proc::new(&script).arg(r"C:\Temp\fy (1)\a b.json").run(&CancelToken::new()).await.unwrap();
    assert_eq!(out.stdout_text(), r"[C:\Temp\fy (1)\a b.json]");
}
