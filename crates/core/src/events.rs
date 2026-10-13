//! Events from the core to the UI. The sink is a trait so that tests
//! can collect events and src-tauri sends them to the window.

use parking_lot::Mutex;
use serde_json::Value;

/// Event names, exactly like the keys of `CoreEvents` in types.ts.
pub mod names {
    pub const REPO_CHANGED: &str = "repo:changed";
    pub const JOB_PROGRESS: &str = "job:progress";
    pub const JOB_DONE: &str = "job:done";
    pub const CREDENTIAL_REQUEST: &str = "credential:request";
    /// A prompt ended without an answer from the UI (time limit, Git exited,
    /// action cancelled): its dialog should close.
    pub const CREDENTIAL_CLOSED: &str = "credential:closed";
    pub const HOOK_OUTPUT: &str = "hook:output";
    pub const LOG_APPENDED: &str = "log:appended";
    pub const APP_CHANGED: &str = "app:changed";
    /// Output of a built-in terminal (batched, valid UTF-8).
    pub const TERMINAL_DATA: &str = "terminal:data";
    /// The shell of a built-in terminal has exited.
    pub const TERMINAL_EXIT: &str = "terminal:exit";
    /// A second instance (or a link) asks the running app to open a folder.
    pub const APP_OPEN_REQUEST: &str = "app:open_request";
    /// The window is about to close, but the UI has reported something to lose
    /// (`app_close_guard`): it asks and then calls `app_quit`.
    pub const APP_CLOSE_REQUESTED: &str = "app:close_requested";

    pub const ALL: [&str; 12] = [
        REPO_CHANGED,
        JOB_PROGRESS,
        JOB_DONE,
        CREDENTIAL_REQUEST,
        CREDENTIAL_CLOSED,
        HOOK_OUTPUT,
        LOG_APPENDED,
        APP_CHANGED,
        TERMINAL_DATA,
        TERMINAL_EXIT,
        APP_OPEN_REQUEST,
        APP_CLOSE_REQUESTED,
    ];
}

/// Receiver for events. `payload` is already the JSON from `crate::model`.
pub trait EventSink: Send + Sync {
    fn emit(&self, event: &str, payload: Value);
}

/// Discards everything.
pub struct NullSink;

impl EventSink for NullSink {
    fn emit(&self, _event: &str, _payload: Value) {}
}

/// Collects events for tests.
#[derive(Default)]
pub struct EventCollector {
    events: Mutex<Vec<(String, Value)>>,
}

impl EventCollector {
    pub fn new() -> Self {
        Self::default()
    }
    /// All events collected so far.
    pub fn all(&self) -> Vec<(String, Value)> {
        self.events.lock().clone()
    }
    /// Take all events (afterwards the collector is empty).
    pub fn take(&self) -> Vec<(String, Value)> {
        std::mem::take(&mut *self.events.lock())
    }
    /// Payloads of all events with this name.
    pub fn named(&self, name: &str) -> Vec<Value> {
        self.events.lock().iter().filter(|(n, _)| n == name).map(|(_, v)| v.clone()).collect()
    }
    pub fn count(&self, name: &str) -> usize {
        self.events.lock().iter().filter(|(n, _)| n == name).count()
    }
    pub fn clear(&self) {
        self.events.lock().clear();
    }
}

impl EventSink for EventCollector {
    fn emit(&self, event: &str, payload: Value) {
        self.events.lock().push((event.to_string(), payload));
    }
}
