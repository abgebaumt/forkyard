//! Running agent sessions: one per agent whose program runs in a terminal. Terminal observer,
//! status channel and a timer feed one task per session; it drives the status automaton, types
//! the task once the program is ready, reports every change as `agents:changed` and records the
//! end in the `agents` table. Ended sessions stay here (last screen line, test result) until the
//! agent is resumed, cleaned up or the app restarts.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use tokio::sync::mpsc;

use super::channel::{HookSignal, StatusChannel};
use super::cmdline::{self, LaunchInput, StatusLink};
use super::machine::{Cue, Event, Machine};
use super::templates::TemplateDef;
use crate::app::Core;
use crate::commands::terminal::{self, ProgramLaunch, TerminalObserver, TerminalSignal};
use crate::db::{self, agents::{AgentRow, EndReason}};
use crate::error::{CoreError, CoreResult};
use crate::events::names;
use crate::git::redact;
use crate::model::{AgentStatus, AgentStatusSource, AgentTestResult, AgentsChangedEvent};
use crate::util;

const TICK: Duration = Duration::from_millis(250);
/// The task is typed once the program has been quiet this long after its first output …
const TYPE_AFTER_QUIET: Duration = Duration::from_millis(1500);
/// … or at the latest this long after the start.
const TYPE_AT_LATEST: Duration = Duration::from_secs(15);
const LAST_LINE_CHARS: usize = 200;

/// The task as bracketed paste plus Enter. Line breaks become CR (what a terminal sends for Enter);
/// ESC is removed so the text can't end the paste early.
pub fn paste(task: &str) -> String {
    let text: String = task.replace("\r\n", "\n").replace('\n', "\r").chars().filter(|c| *c != '\x1b').collect();
    format!("\x1b[200~{text}\x1b[201~\r")
}

/// The last visible, non-empty line of the output (escape sequences removed).
#[derive(Debug, Default)]
pub struct LineTail {
    current: String,
    last: Option<String>,
    in_escape: bool,
    in_osc: bool,
}

impl LineTail {
    pub fn push(&mut self, text: &str) {
        for c in text.chars() {
            if self.in_osc {
                // OSC ends with BEL or ESC \ .
                if c == '\x07' || c == '\\' {
                    self.in_osc = false;
                }
                continue;
            }
            if self.in_escape {
                if c == ']' {
                    self.in_osc = true;
                    self.in_escape = false;
                } else if c.is_ascii_alphabetic() || c == '~' {
                    self.in_escape = false;
                }
                continue;
            }
            match c {
                '\x1b' => self.in_escape = true,
                '\n' | '\r' => self.end_line(),
                c if c.is_control() => {}
                c => {
                    if self.current.chars().count() < LAST_LINE_CHARS {
                        self.current.push(c);
                    }
                }
            }
        }
    }

    fn end_line(&mut self) {
        let line = std::mem::take(&mut self.current);
        let line = line.trim();
        if !line.is_empty() {
            self.last = Some(line.to_string());
        }
    }

    /// The last finished line (or the unfinished one, if it has text), redacted.
    pub fn last(&self) -> Option<String> {
        let open = self.current.trim();
        let line = if open.is_empty() { self.last.clone() } else { Some(open.to_string()) };
        line.map(|l| redact::redact(&l))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionSnapshot {
    pub status: AgentStatus,
    pub source: AgentStatusSource,
    pub finished: bool,
    pub exit_code: Option<i32>,
    pub last_line: Option<String>,
}

pub struct Session {
    pub agent_id: String,
    pub repo_id: String,
    terminal_id: String,
    token: String,
    machine: Mutex<Machine>,
    tail: Arc<Mutex<LineTail>>,
    events: mpsc::UnboundedSender<Event>,
}

impl Session {
    pub fn terminal_id(&self) -> &str {
        &self.terminal_id
    }

    pub fn send(&self, event: Event) {
        let _ = self.events.send(event);
    }

    pub fn snapshot(&self) -> SessionSnapshot {
        let machine = self.machine.lock();
        let finished = machine.is_final();
        SessionSnapshot {
            status: machine.status(),
            source: machine.source(),
            finished,
            exit_code: machine.exit_code(),
            last_line: if finished && machine.status() == AgentStatus::Failed { self.tail.lock().last() } else { None },
        }
    }
}

#[derive(Default)]
pub struct AgentRegistry {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    /// Last test run per agent (also for agents without a session).
    tests: Mutex<HashMap<String, AgentTestResult>>,
}

impl AgentRegistry {
    pub fn test_of(&self, agent_id: &str) -> Option<AgentTestResult> {
        self.tests.lock().get(agent_id).cloned()
    }

    pub(crate) fn set_test(&self, agent_id: &str, result: AgentTestResult) {
        self.tests.lock().insert(agent_id.to_string(), result);
    }

    pub fn get(&self, agent_id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().get(agent_id).cloned()
    }

    fn running(&self, filter: impl Fn(&Session) -> bool) -> u32 {
        self.sessions.lock().values().filter(|s| filter(s) && !s.machine.lock().is_final()).count() as u32
    }

    /// Agents of the repository whose program runs.
    pub fn running_in(&self, repo_id: &str) -> u32 {
        self.running(|s| s.repo_id == repo_id)
    }

    pub fn running_total(&self) -> u32 {
        self.running(|_| true)
    }

    pub fn remove(&self, agent_id: &str) {
        self.sessions.lock().remove(agent_id);
        self.tests.lock().remove(agent_id);
    }

    pub(crate) fn all(&self) -> Vec<Arc<Session>> {
        self.sessions.lock().values().cloned().collect()
    }
}

/// `agents:changed` for the repository, with the number of running agents of all repositories.
pub(crate) fn emit_changed(core: &Core, repo_id: &str) {
    let running = core.state::<AgentRegistry>().running_total();
    core.emit(names::AGENTS_CHANGED, &AgentsChangedEvent { repo_id: repo_id.to_string(), running });
}

/// Terminal events → status events.
struct Observer {
    events: mpsc::UnboundedSender<Event>,
    tail: Arc<Mutex<LineTail>>,
}

impl TerminalObserver for Observer {
    fn screen_changed(&self, _terminal_id: &str) {
        let _ = self.events.send(Event::Output);
    }

    fn signal(&self, _terminal_id: &str, signal: &TerminalSignal) {
        let cue = match signal {
            TerminalSignal::Bell => Cue::Bell,
            TerminalSignal::Notify { .. } => Cue::Notification,
            TerminalSignal::Title(_) => Cue::Title,
        };
        let _ = self.events.send(Event::Terminal(cue));
    }

    fn output(&self, _terminal_id: &str, bytes: &[u8]) {
        self.tail.lock().push(&String::from_utf8_lossy(bytes));
    }

    fn exited(&self, _terminal_id: &str, code: Option<i32>) {
        let _ = self.events.send(Event::Exited(code));
    }
}

fn io_error(what: &str, e: std::io::Error) -> CoreError {
    CoreError::io(format!("{what}: {e}"))
}

/// Starts (or resumes) the agent's program in its worktree and registers the session.
pub(crate) async fn spawn_session(core: &Core, row: &AgentRow, def: &TemplateDef, program: &Path, resume: bool, cols: u16, rows: u16) -> CoreResult<Arc<Session>> {
    let worktree = PathBuf::from(&row.worktree_path);
    let files = core.data_dir().join("agents").join(&row.id);
    util::create_private_dir(&files).map_err(|e| io_error("The agent's folder in the data directory could not be created", e))?;
    let task_file = files.join("task.md");
    let settings_file = files.join("claude-settings.json");
    let channel = core.state::<StatusChannel>();
    let port = channel.port().await;
    let (hook_tx, mut hook_rx) = mpsc::unbounded_channel::<HookSignal>();
    let token = channel.register(hook_tx);
    let helper = core.git.broker().helper_path();
    let input = LaunchInput {
        program,
        worktree: &worktree,
        branch: &row.branch,
        task: &row.task,
        task_file: &task_file,
        settings_file: &settings_file,
        status: port.map(|port| StatusLink { port, token: &token, helper: helper.as_deref() }),
        windows: cfg!(windows),
        unattended: row.unattended,
        resume,
    };
    let prepared = cmdline::build(def, &input).and_then(|launch| {
        if launch.writes_task_file {
            util::write_file_atomic(&task_file, row.task.as_bytes()).map_err(|e| io_error("The task file could not be written", e))?;
        }
        if let Some(json) = &launch.settings_json {
            util::write_file_atomic(&settings_file, json.as_bytes()).map_err(|e| io_error("The agent's settings could not be written", e))?;
        }
        Ok(launch)
    });
    let launch = match prepared {
        Ok(launch) => launch,
        Err(e) => {
            channel.unregister(&token);
            return Err(e);
        }
    };
    let (events, rx) = mpsc::unbounded_channel();
    let tail = Arc::new(Mutex::new(LineTail::default()));
    let observer: Arc<dyn TerminalObserver> = Arc::new(Observer { events: events.clone(), tail: tail.clone() });
    let mut env = launch.env.clone();
    // A desktop app does not inherit the login shell's PATH; CLIs installed with npm need `node` from it.
    if let Some(path) = crate::tools::locate::login_shell_path(core).await {
        env.push(("PATH".into(), path));
    }
    let spec = ProgramLaunch { program: launch.program.clone(), args: launch.args.clone(), cwd: worktree.clone(), env, title: row.short_name.clone() };
    let terminal_id = match terminal::terminal_open_program(core, &row.repo_id, spec, cols, rows, Some(observer)).await {
        Ok(id) => id,
        Err(e) => {
            channel.unregister(&token);
            return Err(e);
        }
    };
    let forward = events.clone();
    tokio::spawn(async move {
        while let Some(signal) = hook_rx.recv().await {
            if forward.send(Event::Hook(signal)).is_err() {
                break;
            }
        }
    });
    let session = Arc::new(Session {
        agent_id: row.id.clone(),
        repo_id: row.repo_id.clone(),
        terminal_id,
        token,
        machine: Mutex::new(Machine::new(Instant::now(), def.status_hook)),
        tail,
        events,
    });
    core.state::<AgentRegistry>().sessions.lock().insert(row.id.clone(), session.clone());
    let pending = launch.types_task.then(|| row.task.clone());
    tokio::spawn(drive(core.clone(), session.clone(), rx, pending));
    emit_changed(core, &row.repo_id);
    Ok(session)
}

async fn drive(core: Core, session: Arc<Session>, mut rx: mpsc::UnboundedReceiver<Event>, mut pending: Option<String>) {
    let started = Instant::now();
    let mut first_output: Option<Instant> = None;
    let mut last_output = started;
    let mut ticker = tokio::time::interval(TICK);
    loop {
        let event = tokio::select! {
            received = rx.recv() => match received {
                Some(event) => event,
                None => break,
            },
            _ = ticker.tick() => Event::Tick,
        };
        let now = Instant::now();
        if matches!(event, Event::Output | Event::Terminal(Cue::Title)) {
            first_output.get_or_insert(now);
            last_output = now;
        }
        if event == Event::Tick && pending.is_some() {
            let quiet = first_output.is_some() && now.duration_since(last_output) >= TYPE_AFTER_QUIET;
            if quiet || now.duration_since(started) >= TYPE_AT_LATEST {
                let task = pending.take().unwrap_or_default();
                if let Err(e) = terminal::terminal_write(&core, session.terminal_id.clone(), paste(&task)).await {
                    log::warn!("task not typed into the agent's terminal: {}", e.message);
                }
            }
        }
        let (changed, finished) = {
            let mut machine = session.machine.lock();
            let changed = machine.apply(event, now);
            (changed, machine.is_final())
        };
        if changed {
            emit_changed(&core, &session.repo_id);
            super::after_status_change(&core, &session).await;
        }
        if finished {
            record_end(&core, &session);
            break;
        }
    }
}

impl Session {
    /// The app is closing: the session ends as stopped (recorded synchronously, the exit that
    /// follows changes nothing).
    pub fn mark_closed(&self) {
        let mut machine = self.machine.lock();
        machine.apply(Event::AppClosed, Instant::now());
    }
}

/// `terminal_close` on an agent's terminal (the × of its terminal tab, the cockpit's “Stop”):
/// the user ended it, so the end counts as “stopped”.
pub fn stop_requested_for_terminal(core: &Core, terminal_id: &str) {
    for session in core.state::<AgentRegistry>().all() {
        if session.terminal_id == terminal_id {
            session.send(Event::StopRequested);
            session.machine.lock().apply(Event::StopRequested, Instant::now());
        }
    }
}

/// Writes the end of the session to the `agents` table and closes its status token.
fn record_end(core: &Core, session: &Session) {
    core.state::<StatusChannel>().unregister(&session.token);
    let already = core.db.with(|c| db::agents::get(c, &session.agent_id)).ok().flatten().and_then(|row| row.end_reason);
    if already == Some(EndReason::AppClosed) {
        return;
    }
    let (status, code) = {
        let machine = session.machine.lock();
        (machine.status(), machine.exit_code())
    };
    let reason = if status == AgentStatus::Stopped { EndReason::Stopped } else { EndReason::Exited };
    if let Err(e) = core.db.with(|c| db::agents::set_ended(c, &session.agent_id, &util::now_iso(), code, reason)) {
        log::warn!("end of agent {} not recorded: {}", session.agent_id, e.message);
    }
    emit_changed(core, &session.repo_id);
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_task_is_pasted_with_cr_line_ends_and_without_escape() {
        assert_eq!(paste("Zeile 1\nZeile 2\r\nEnde"), "\x1b[200~Zeile 1\rZeile 2\rEnde\x1b[201~\r");
        assert_eq!(paste("böse\x1b[201~rm -rf /"), "\x1b[200~böse[201~rm -rf /\x1b[201~\r");
    }

    #[test]
    fn the_last_line_ignores_escape_sequences_and_is_redacted() {
        let mut tail = LineTail::default();
        tail.push("\x1b]0;Titel\x07\x1b[1;32mErste Zeile\x1b[0m\r\n");
        tail.push("Fehler: token ghp_abcdefghijklmnopqrstuvwxyz0123456789\r\n\r\n");
        let last = tail.last().unwrap();
        assert!(last.starts_with("Fehler: token "), "{last}");
        assert!(!last.contains("ghp_abcdefghijklmnopqrstuvwxyz0123456789"), "{last}");
        let mut open = LineTail::default();
        open.push("Erste\r\nnoch offen");
        assert_eq!(open.last().as_deref(), Some("noch offen"));
        assert_eq!(LineTail::default().last(), None);
    }
}
