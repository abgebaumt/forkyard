//! Helper program for `GIT_ASKPASS` and `SSH_ASKPASS`.
//!
//! Git and SSH call it with the prompt as the first argument and read the answer
//! from stdout. The program forwards the question over TCP on 127.0.0.1 to the
//! running core (port and one-time token are in the environment) and waits for its
//! answer. Without an answer it exits with code 1; Git and SSH treat that as a
//! cancellation.
//!
//! Protocol, one line per direction, payload in hex:
//!   Request:  `GCAP1 <token> <hex(prompt)>\n`
//!   Response: `OK <hex(answer)>\n` or `NO\n`
//!
//! Second mode, for the hooks of coding agents (Claude Code, Codex):
//!   `forkyard-askpass --agent-status <waiting|done|running> [ignored …]`
//! reports the status to the core (`FORKYARD_AGENT_PORT`, `FORKYARD_AGENT_TOKEN`):
//!   Request:  `FYAS1 <token> <state>\n`
//!   Response: `OK\n` or `NO\n`
//! It never writes to stdout and always exits with 0: a status report must not stop an agent.
//!
//! The file has no dependencies (std only), see Cargo.toml.

use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpStream};
use std::process::ExitCode;
use std::time::Duration;

const PORT_ENV: &str = "FORKYARD_ASKPASS_PORT";
const TOKEN_ENV: &str = "FORKYARD_ASKPASS_TOKEN";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const AGENT_STATUS_FLAG: &str = "--agent-status";
const AGENT_PORT_ENV: &str = "FORKYARD_AGENT_PORT";
const AGENT_TOKEN_ENV: &str = "FORKYARD_AGENT_TOKEN";
const AGENT_TIMEOUT: Duration = Duration::from_secs(2);

fn main() -> ExitCode {
    if std::env::args_os().nth(1).is_some_and(|arg| arg == AGENT_STATUS_FLAG) {
        let state = std::env::args_os().nth(2).and_then(|s| s.into_string().ok()).unwrap_or_default();
        if let Err(reason) = report_agent_status(&state) {
            eprintln!("forkyard-askpass: {reason}");
        }
        return ExitCode::SUCCESS;
    }
    match ask() {
        Ok(answer) => {
            let mut out = std::io::stdout().lock();
            if out.write_all(&answer).and_then(|()| out.write_all(b"\n")).and_then(|()| out.flush()).is_err() {
                return ExitCode::from(1);
            }
            ExitCode::SUCCESS
        }
        Err(reason) => {
            // Ends up in Git's output; never contains an answer.
            eprintln!("forkyard-askpass: {reason}");
            ExitCode::from(1)
        }
    }
}

fn ask() -> Result<Vec<u8>, String> {
    let prompt = std::env::args_os().nth(1).map(os_bytes).unwrap_or_default();
    let port: u16 = std::env::var(PORT_ENV)
        .ok()
        .and_then(|p| p.trim().parse().ok())
        .ok_or("no connection to the app (port missing)")?;
    let token = std::env::var(TOKEN_ENV).map_err(|_| "no connection to the app (token missing)")?;
    if token.is_empty() || !token.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err("no connection to the app (invalid token)".into());
    }

    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let mut stream =
        TcpStream::connect_timeout(&addr.into(), CONNECT_TIMEOUT).map_err(|_| "the app can’t be reached")?;
    let _ = stream.set_nodelay(true);
    let request = format!("GCAP1 {token} {}\n", to_hex(&prompt));
    stream.write_all(request.as_bytes()).and_then(|()| stream.flush()).map_err(|_| "the app can’t be reached")?;

    // No read timeout: the core decides how long a prompt stays open.
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).map_err(|_| "the connection to the app was lost")?;
    let line = line.trim_end();
    if let Some(hex) = line.strip_prefix("OK") {
        return from_hex(hex.trim()).ok_or_else(|| "unreadable answer from the app".to_string());
    }
    Err("prompt not answered".into())
}

/// Reports a coding agent's status to the core; waits at most a few seconds in total.
fn report_agent_status(state: &str) -> Result<(), String> {
    if !matches!(state, "waiting" | "done" | "running") {
        return Err(format!("unknown agent status “{state}”"));
    }
    let port: u16 = std::env::var(AGENT_PORT_ENV)
        .ok()
        .and_then(|p| p.trim().parse().ok())
        .ok_or("no connection to the app (port missing)")?;
    let token = std::env::var(AGENT_TOKEN_ENV).map_err(|_| "no connection to the app (token missing)")?;
    if token.is_empty() || !token.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err("no connection to the app (invalid token)".into());
    }
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let mut stream = TcpStream::connect_timeout(&addr.into(), AGENT_TIMEOUT).map_err(|_| "the app can’t be reached")?;
    let _ = stream.set_read_timeout(Some(AGENT_TIMEOUT));
    let _ = stream.set_write_timeout(Some(AGENT_TIMEOUT));
    stream.write_all(format!("FYAS1 {token} {state}\n").as_bytes()).map_err(|_| "the app can’t be reached")?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).map_err(|_| "no answer from the app")?;
    if line.trim_end() == "OK" {
        Ok(())
    } else {
        Err("status not accepted".into())
    }
}

#[cfg(unix)]
fn os_bytes(value: std::ffi::OsString) -> Vec<u8> {
    use std::os::unix::ffi::OsStringExt;
    value.into_vec()
}

#[cfg(not(unix))]
fn os_bytes(value: std::ffi::OsString) -> Vec<u8> {
    value.to_string_lossy().into_owned().into_bytes()
}

fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[usize::from(b >> 4)] as char);
        out.push(DIGITS[usize::from(b & 0x0f)] as char);
    }
    out
}

fn from_hex(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if bytes.len() % 2 != 0 {
        return None;
    }
    bytes
        .chunks(2)
        .map(|pair| {
            let hi = (pair[0] as char).to_digit(16)?;
            let lo = (pair[1] as char).to_digit(16)?;
            u8::try_from(hi * 16 + lo).ok()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_roundtrip() {
        let data = "Passwort für 'https://ü@host': \n\0".as_bytes();
        let hex = to_hex(data);
        assert!(hex.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(from_hex(&hex).as_deref(), Some(data));
        assert_eq!(from_hex(""), Some(Vec::new()));
        assert_eq!(from_hex("abc"), None);
        assert_eq!(from_hex("zz"), None);
    }
}
