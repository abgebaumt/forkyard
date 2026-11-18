//! The local channels (askpass prompts, agent status, launch handover): a listener on 127.0.0.1
//! that only serves loopback peers. Who may talk is decided by the one-time token in the message.

use std::future::Future;
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::Duration;

use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{Notify, Semaphore};

/// A listener on 127.0.0.1 with a free port; `None` (logged as "`what` not available") if none opens.
pub async fn bind_loopback(what: &str) -> Option<(TcpListener, u16)> {
    match TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await {
        Ok(listener) => {
            let port = listener.local_addr().ok()?.port();
            Some((listener, port))
        }
        Err(e) => {
            log::warn!("{what} not available: {e}");
            None
        }
    }
}

/// Accepts connections until `shutdown` fires or `handle` returns `None`; each connection from a
/// loopback address runs `handle`'s future on its own task. At most `max_connections` run at once,
/// more are dropped.
pub async fn serve_loopback<F, Fut>(listener: TcpListener, max_connections: usize, shutdown: &Notify, mut handle: F)
where
    F: FnMut(TcpStream) -> Option<Fut>,
    Fut: Future<Output = ()> + Send + 'static,
{
    let slots = Arc::new(Semaphore::new(max_connections));
    loop {
        tokio::select! {
            _ = shutdown.notified() => break,
            accepted = listener.accept() => {
                let Ok((stream, peer)) = accepted else {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    continue;
                };
                if !peer.ip().is_loopback() {
                    continue;
                }
                let Ok(slot) = slots.clone().try_acquire_owned() else { continue };
                let Some(work) = handle(stream) else { break };
                tokio::spawn(async move {
                    work.await;
                    drop(slot);
                });
            }
        }
    }
}
