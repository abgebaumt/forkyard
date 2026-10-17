//! A signal that arrives while a request waits for its answer must not end the request. In the app
//! that is mostly SIGCHLD of a Git process that ends at the same moment; the kernel does not restart
//! a socket read that has a timeout, not even with `SA_RESTART`. A POST (an AI chat, a new pull
//! request) is never sent twice, so it cannot be saved by a retry.
//!
//! Its own test binary: it signals every thread of the process, which would disturb other tests.
#![cfg(target_os = "linux")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use gitcore::http::{send, Method, Request};
use gitcore::testkit::{MockResponse, MockServer, TestCore};
use serde_json::json;

extern "C" fn ignore(_: libc::c_int) {}

/// Like the handler tokio installs for SIGCHLD: catches the signal and restarts what it can.
fn install_handler(signal: libc::c_int) {
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = ignore as extern "C" fn(libc::c_int) as usize;
        action.sa_flags = libc::SA_RESTART;
        libc::sigemptyset(&mut action.sa_mask);
        assert_eq!(libc::sigaction(signal, &action, std::ptr::null_mut()), 0);
    }
}

/// Sends `signal` to every thread of this process except the mock server's own.
fn signal_every_thread(signal: libc::c_int) {
    let pid = std::process::id() as libc::pid_t;
    let Ok(tasks) = std::fs::read_dir("/proc/self/task") else { return };
    for task in tasks.flatten() {
        let name = std::fs::read_to_string(task.path().join("comm")).unwrap_or_default();
        if name.starts_with("mock-http") {
            continue;
        }
        let Some(tid) = task.file_name().to_str().and_then(|t| t.parse::<libc::pid_t>().ok()) else { continue };
        unsafe {
            libc::syscall(libc::SYS_tgkill, pid, tid, signal);
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_signal_during_a_post_does_not_end_the_request() {
    install_handler(libc::SIGUSR2);
    let tc = TestCore::new().await;
    let server = MockServer::start(|_| MockResponse::json(200, json!({ "answer": "ok" })).delay(Duration::from_millis(600)));

    let stop = Arc::new(AtomicBool::new(false));
    let signaller = {
        let stop = stop.clone();
        std::thread::Builder::new()
            .name("mock-http-signal".into())
            .spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    signal_every_thread(libc::SIGUSR2);
                    std::thread::sleep(Duration::from_millis(5));
                }
            })
            .unwrap()
    };

    let result = send(&tc, Request::new(Method::Post, format!("{}/api/chat", server.url()), "Ollama").json(&json!({ "q": 1 }))).await;
    stop.store(true, Ordering::SeqCst);
    signaller.join().unwrap();

    let response = result.unwrap_or_else(|e| panic!("the request ended early: {:?} {}", e.code, e.message));
    assert_eq!(response.status, 200);
    assert_eq!(response.text(), r#"{"answer":"ok"}"#);
    assert_eq!(server.count("POST /api/chat"), 1, "sent exactly once");
}
