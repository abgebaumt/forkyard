//! Fake coding agent for tests (std only, no product code). Started as an own agent template:
//!   forkyard-fake-agent --log <file> [--exit-after-task <code>]
//! 1. prints "FAKE AGENT READY" and switches bracketed paste on;
//! 2. logs its arguments, working directory and the agent environment to <file>;
//! 3. reads the pasted task (between ESC[200~ and ESC[201~), logs it and writes AGENT_RESULT.md
//!    into its working directory (a changed file for the cockpit);
//! 4. with --exit-after-task: reports "done" and ends with that code; otherwise reports
//!    "waiting" and rings the bell, then reads lines: "done" reports done, "exit <n>" ends with n.
//!
//! Reports go through $FORKYARD_AGENT_HELPER (like the hooks of Claude Code and Codex), without it
//! directly over the status channel ($FORKYARD_AGENT_PORT, $FORKYARD_AGENT_TOKEN).

use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::process::ExitCode;
use std::time::Duration;

const PASTE_START: &str = "\x1b[200~";
const PASTE_END: &str = "\x1b[201~";

fn value_after(args: &[String], flag: &str) -> Option<String> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned()
}

fn escape(text: &str) -> String {
    text.replace('\\', "\\\\").replace('\n', "\\n").replace('\r', "\\r")
}

fn note(log: &mut Option<std::fs::File>, line: &str) {
    if let Some(file) = log {
        let _ = writeln!(file, "{line}");
        let _ = file.flush();
    }
}

fn report(state: &str) {
    if let Some(helper) = std::env::var_os("FORKYARD_AGENT_HELPER") {
        let _ = std::process::Command::new(helper).args(["--agent-status", state]).status();
        return;
    }
    let (Ok(port), Ok(token)) = (std::env::var("FORKYARD_AGENT_PORT"), std::env::var("FORKYARD_AGENT_TOKEN")) else { return };
    let Ok(port) = port.parse::<u16>() else { return };
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let Ok(mut stream) = TcpStream::connect_timeout(&addr.into(), Duration::from_secs(2)) else { return };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.write_all(format!("FYAS1 {token} {state}\n").as_bytes());
    let mut answer = String::new();
    let _ = BufReader::new(stream).read_line(&mut answer);
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut log = value_after(&args, "--log").and_then(|path| OpenOptions::new().create(true).append(true).open(path).ok());
    let exit_after: Option<u8> = value_after(&args, "--exit-after-task").and_then(|v| v.parse().ok());
    let mut out = std::io::stdout();
    let _ = write!(out, "\x1b[?2004hFAKE AGENT READY\r\n");
    let _ = out.flush();
    for arg in &args {
        note(&mut log, &format!("arg: {}", escape(arg)));
    }
    let cwd = std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_default();
    note(&mut log, &format!("cwd: {cwd}"));
    for key in ["FORKYARD_AGENT_PORT", "FORKYARD_AGENT_TOKEN"] {
        note(&mut log, &format!("env {key}: {}", if std::env::var_os(key).is_some() { "set" } else { "unset" }));
    }

    // The task arrives as bracketed paste; the line discipline turns its CRs into line ends.
    let mut stdin = BufReader::new(std::io::stdin().lock());
    let mut collected = Vec::new();
    loop {
        let mut chunk = Vec::new();
        match stdin.read_until(b'\n', &mut chunk) {
            Ok(0) | Err(_) => return ExitCode::SUCCESS,
            Ok(_) => collected.extend_from_slice(&chunk),
        }
        if String::from_utf8_lossy(&collected).contains(PASTE_END) {
            break;
        }
    }
    let text = String::from_utf8_lossy(&collected).into_owned();
    let start = text.find(PASTE_START).map(|i| i + PASTE_START.len()).unwrap_or(0);
    let end = text.find(PASTE_END).unwrap_or(text.len());
    let task = text[start..end].replace("\r\n", "\n").replace('\r', "\n");
    note(&mut log, &format!("task: {}", escape(&task)));
    let _ = std::fs::write("AGENT_RESULT.md", task.as_bytes());

    if let Some(code) = exit_after {
        report("done");
        let _ = write!(out, "BYE\r\n");
        let _ = out.flush();
        return ExitCode::from(code);
    }
    report("waiting");
    let _ = write!(out, "waiting for you\r\n\x07");
    let _ = out.flush();
    let mut line = String::new();
    loop {
        line.clear();
        match stdin.read_line(&mut line) {
            Ok(0) | Err(_) => return ExitCode::SUCCESS,
            Ok(_) => {}
        }
        let command = line.trim();
        if command == "done" {
            report("done");
            let _ = write!(out, "DONE\r\n");
            let _ = out.flush();
        } else if let Some(code) = command.strip_prefix("exit ") {
            let _ = write!(out, "last words before exit\r\n");
            let _ = out.flush();
            return ExitCode::from(code.trim().parse::<u8>().unwrap_or(1));
        }
        // Keep reading a little longer than the line discipline needs.
        let mut rest = [0u8; 0];
        let _ = stdin.read(&mut rest);
    }
}
