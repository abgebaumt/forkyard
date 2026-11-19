//! Events from the core to the UI. The sink is a trait so that tests
//! can collect events and src-tauri sends them to the window.

use parking_lot::Mutex;
use serde_json::Value;

use crate::model::WindowState;

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
    /// A second instance without arguments asks the running app to bring its window forward.
    pub const APP_FOCUS_REQUEST: &str = "app:focus_request";
    /// The window is about to close, but the UI has reported something to lose
    /// (`app_close_guard`): it asks and then calls `app_quit`.
    pub const APP_CLOSE_REQUESTED: &str = "app:close_requested";
    /// The follow-up job brought changed submodules along (or failed – a warning).
    pub const SUBMODULES_UPDATED: &str = "submodules:updated";
    /// Coding agents of a repository changed (started, status, ended, cleaned up).
    pub const AGENTS_CHANGED: &str = "agents:changed";
    /// New result (or start) of the collision check of a repository's coding agents (payload `CollisionReport`).
    pub const AGENT_COLLISIONS: &str = "agents:collisions";
    /// Lines (first) and blamed spans (then) of a running `file_blame_job` (payload `BlameChunkEvent`).
    pub const BLAME_CHUNK: &str = "blame:chunk";

    pub const ALL: [&str; 17] = [
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
        APP_FOCUS_REQUEST,
        APP_CLOSE_REQUESTED,
        SUBMODULES_UPDATED,
        AGENTS_CHANGED,
        AGENT_COLLISIONS,
        BLAME_CHUNK,
    ];
}

/// Receiver for events. `payload` is already the JSON from `crate::model`.
pub trait EventSink: Send + Sync {
    fn emit(&self, event: &str, payload: Value);
    /// An event for exactly one window (by label). Sinks without windows send it like `emit`.
    fn emit_to(&self, window: &str, event: &str, payload: Value) {
        let _ = window;
        self.emit(event, payload);
    }
    /// The windows of the active profile that should be open; the binding opens and closes to match.
    /// `place_existing` also moves windows that are already open to their stored geometry.
    fn sync_windows(&self, windows: &[WindowState], place_existing: bool) {
        let _ = (windows, place_existing);
    }
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
    /// `emit_to` calls: (event, window, payload).
    targeted: Mutex<Vec<(String, String, Value)>>,
    window_syncs: Mutex<Vec<Vec<WindowState>>>,
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
        self.window_syncs.lock().clear();
        self.targeted.lock().clear();
        std::mem::take(&mut *self.events.lock())
    }
    /// Payloads of all events with this name.
    pub fn named(&self, name: &str) -> Vec<Value> {
        self.events.lock().iter().filter(|(n, _)| n == name).map(|(_, v)| v.clone()).collect()
    }
    pub fn count(&self, name: &str) -> usize {
        self.events.lock().iter().filter(|(n, _)| n == name).count()
    }
    /// (window, payload) of all events with this name that went to one window.
    pub fn targeted(&self, name: &str) -> Vec<(String, Value)> {
        self.targeted.lock().iter().filter(|(n, _, _)| n == name).map(|(_, w, v)| (w.clone(), v.clone())).collect()
    }
    /// The window lists of all `sync_windows` calls, oldest first.
    pub fn window_syncs(&self) -> Vec<Vec<WindowState>> {
        self.window_syncs.lock().clone()
    }
    pub fn clear(&self) {
        self.window_syncs.lock().clear();
        self.targeted.lock().clear();
        self.events.lock().clear();
    }
}

impl EventSink for EventCollector {
    fn emit(&self, event: &str, payload: Value) {
        self.events.lock().push((event.to_string(), payload));
    }
    fn emit_to(&self, window: &str, event: &str, payload: Value) {
        self.targeted.lock().push((event.to_string(), window.to_string(), payload.clone()));
        self.emit(event, payload);
    }
    fn sync_windows(&self, windows: &[WindowState], _place_existing: bool) {
        self.window_syncs.lock().push(windows.to_vec());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn targeted_events_are_also_collected_by_name() {
        let c = EventCollector::new();
        c.emit_to("w-x", names::APP_OPEN_REQUEST, json!({"path": "/p"}));
        assert_eq!(c.named(names::APP_OPEN_REQUEST).len(), 1);
        assert_eq!(c.targeted(names::APP_OPEN_REQUEST)[0].0, "w-x");
    }
}
