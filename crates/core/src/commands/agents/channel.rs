//! Local status channel of the coding agents. Claude Code (hooks in `--settings`) and Codex
//! (`-c notify=[…]`) start the askpass helper in its `--agent-status` mode; it reports over TCP on
//! 127.0.0.1 with the agent's one-time token: `FYAS1 <token> <waiting|done|running>\n`, answer
//! `OK\n` or `NO\n`. Unknown tokens, other lines and oversized lines are refused; nothing from
//! the line reaches a log.

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, Notify, OnceCell, Semaphore};

use crate::util;

pub const PROTOCOL: &str = "FYAS1";
const MAX_LINE: u64 = 128;
const READ_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CONNECTIONS: usize = 16;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HookSignal {
    /// The agent waits for the user (Claude Code `Notification`).
    Waiting,
    /// The agent finished its turn (Claude Code `Stop`, Codex `agent-turn-complete`).
    Done,
    /// The user answered, the agent works again (Claude Code `UserPromptSubmit`).
    Running,
}

impl HookSignal {
    pub fn parse(text: &str) -> Option<HookSignal> {
        match text {
            "waiting" => Some(HookSignal::Waiting),
            "done" => Some(HookSignal::Done),
            "running" => Some(HookSignal::Running),
            _ => None,
        }
    }
}

/// `FYAS1 <token> <state>` → (token, signal). The token is alphanumeric.
pub fn parse_line(line: &str) -> Option<(&str, HookSignal)> {
    let mut parts = line.trim_end_matches(['\r', '\n']).split(' ');
    if parts.next()? != PROTOCOL {
        return None;
    }
    let token = parts.next().filter(|t| !t.is_empty() && t.bytes().all(|b| b.is_ascii_alphanumeric()))?;
    let signal = HookSignal::parse(parts.next()?)?;
    parts.next().is_none().then_some((token, signal))
}

#[derive(Default)]
struct Inner {
    agents: Mutex<HashMap<String, mpsc::UnboundedSender<HookSignal>>>,
    shutdown: Notify,
}

impl Inner {
    /// The sender of the token, compared in constant time.
    fn sender(&self, token: &str) -> Option<mpsc::UnboundedSender<HookSignal>> {
        let agents = self.agents.lock();
        let mut found = None;
        for (known, sender) in agents.iter() {
            if util::constant_time_eq(known.as_bytes(), token.as_bytes()) {
                found = Some(sender.clone());
            }
        }
        found
    }
}

/// The listener and the tokens of the running agents. One per core (`core.state`).
#[derive(Default)]
pub struct StatusChannel {
    inner: Arc<Inner>,
    port: OnceCell<Option<u16>>,
}

impl Drop for StatusChannel {
    fn drop(&mut self) {
        self.inner.shutdown.notify_one();
    }
}

impl StatusChannel {
    /// Port of the listener (opened on first use); `None` if it can't be opened – the agents' status
    /// is then guessed.
    pub async fn port(&self) -> Option<u16> {
        *self
            .port
            .get_or_init(|| async {
                let listener = match TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await {
                    Ok(listener) => listener,
                    Err(e) => {
                        log::warn!("status channel for coding agents not available: {e}");
                        return None;
                    }
                };
                let port = listener.local_addr().ok()?.port();
                tokio::spawn(serve(listener, self.inner.clone()));
                Some(port)
            })
            .await
    }

    /// A new one-time token whose reports go to `sender`.
    pub fn register(&self, sender: mpsc::UnboundedSender<HookSignal>) -> String {
        let token = uuid::Uuid::new_v4().simple().to_string();
        self.inner.agents.lock().insert(token.clone(), sender);
        token
    }

    pub fn unregister(&self, token: &str) {
        self.inner.agents.lock().remove(token);
    }
}

async fn serve(listener: TcpListener, inner: Arc<Inner>) {
    let slots = Arc::new(Semaphore::new(MAX_CONNECTIONS));
    loop {
        tokio::select! {
            _ = inner.shutdown.notified() => break,
            accepted = listener.accept() => {
                let Ok((stream, peer)) = accepted else {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                };
                if !peer.ip().is_loopback() {
                    continue;
                }
                let Ok(slot) = slots.clone().try_acquire_owned() else { continue };
                let inner = inner.clone();
                tokio::spawn(async move {
                    handle(stream, &inner).await;
                    drop(slot);
                });
            }
        }
    }
}

async fn handle(stream: TcpStream, inner: &Inner) {
    let (read, mut write) = stream.into_split();
    let mut line = String::new();
    let read = tokio::time::timeout(READ_TIMEOUT, BufReader::new(read.take(MAX_LINE)).read_line(&mut line)).await;
    let delivered = match read {
        Ok(Ok(_)) if line.ends_with('\n') => match parse_line(&line) {
            Some((token, signal)) => inner.sender(token).is_some_and(|sender| sender.send(signal).is_ok()),
            None => false,
        },
        _ => false,
    };
    let _ = write.write_all(if delivered { b"OK\n" } else { b"NO\n" }).await;
    let _ = write.shutdown().await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    #[test]
    fn request_lines_are_parsed_strictly() {
        assert_eq!(parse_line("FYAS1 abc123 waiting\n"), Some(("abc123", HookSignal::Waiting)));
        assert_eq!(parse_line("FYAS1 abc123 done\r\n"), Some(("abc123", HookSignal::Done)));
        assert_eq!(parse_line("FYAS1 abc123 running"), Some(("abc123", HookSignal::Running)));
        for bad in ["GCAP1 abc123 done", "FYAS1 abc123 fertig", "FYAS1 abc123", "FYAS1  done", "FYAS1 abc 123 done", "FYAS1 ab-c done", ""] {
            assert_eq!(parse_line(bad), None, "{bad:?}");
        }
    }

    async fn ask(port: u16, line: &[u8]) -> String {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        stream.write_all(line).await.unwrap();
        let mut answer = String::new();
        let _ = BufReader::new(stream).read_line(&mut answer).await;
        answer
    }

    #[tokio::test]
    async fn only_registered_tokens_reach_their_agent() {
        let channel = StatusChannel::default();
        let port = channel.port().await.expect("listener on 127.0.0.1");
        assert_eq!(channel.port().await, Some(port), "one listener");
        let (tx_a, mut rx_a) = tokio::sync::mpsc::unbounded_channel();
        let (tx_b, mut rx_b) = tokio::sync::mpsc::unbounded_channel();
        let a = channel.register(tx_a);
        let b = channel.register(tx_b);
        assert_ne!(a, b);
        assert!(a.len() == 32 && a.bytes().all(|c| c.is_ascii_hexdigit()), "{a}");

        assert_eq!(ask(port, format!("FYAS1 {a} waiting\n").as_bytes()).await, "OK\n");
        assert_eq!(ask(port, format!("FYAS1 {b} done\n").as_bytes()).await, "OK\n");
        assert_eq!(rx_a.recv().await, Some(HookSignal::Waiting));
        assert_eq!(rx_b.recv().await, Some(HookSignal::Done));
        // Unknown token, a token that only shares a prefix, an oversized line: refused, nothing delivered.
        assert_eq!(ask(port, b"FYAS1 0000 done\n").await, "NO\n");
        assert_eq!(ask(port, format!("FYAS1 {}x done\n", &a[..31]).as_bytes()).await, "NO\n");
        let long = format!("FYAS1 {a} {}\n", "w".repeat(400));
        assert_ne!(ask(port, long.as_bytes()).await, "OK\n");
        channel.unregister(&a);
        assert_eq!(ask(port, format!("FYAS1 {a} running\n").as_bytes()).await, "NO\n");
        assert!(rx_a.try_recv().is_err() && rx_b.try_recv().is_err());
    }
}
