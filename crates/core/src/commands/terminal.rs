//! Built-in terminal: one shell per session on a pseudo-terminal (`portable-pty`, ConPTY on
//! Windows), in the repository's folder and with the user's environment.
//!
//! The UI (xterm.js) sends keystrokes with `terminal_write` and receives the output as the
//! `terminal:data` event – batched (at most every `FLUSH_INTERVAL`, at most `MAX_EVENT_BYTES`
//! per event) and always as valid UTF-8: a character that arrives split across two read
//! chunks is only passed on once complete. When the shell ends, exactly one `terminal:exit`
//! follows the last output.
//!
//! On Windows, ConPTY asks for the cursor position (`ESC[6n`) at startup and waits for the
//! answer before the shell outputs anything at all. The core answers this one question itself
//! (the UI's terminal is empty at that moment, the cursor is at the top left): that way the
//! startup does not depend on whether the UI is already listening.
//!
//! Three threads per session (the pseudo-terminal only supports blocking reads):
//! reader (reads the output), sender (batches and sends events), watcher (waits for the
//! shell to end and then closes the pseudo-terminal so the reader sees end-of-file).
//!
//! Besides the shell, the core can start a program (coding agents) in a registered worktree of the
//! repository (`terminal_open_program`). The reader thread of every session scans the output for BEL,
//! the window title (OSC 0/2) and notifications (OSC 9, OSC 777) and remembers when the screen last
//! changed (`terminal_info`); an optional `TerminalObserver` hears the same.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};

use crate::app::Core;
use crate::error::{CoreError, CoreResult};
use crate::events::names;
use crate::model::{TerminalDataEvent, TerminalExitEvent};
use crate::util;

/// Output is sent as an event at most this often.
pub const FLUSH_INTERVAL: Duration = Duration::from_millis(12);
/// Largest amount of data per `terminal:data`.
pub const MAX_EVENT_BYTES: usize = 64 * 1024;
/// This much output may wait to be sent; beyond that the shell is throttled.
const MAX_PENDING_BYTES: usize = 1024 * 1024;
/// Largest input per `terminal_write` (pasting from the clipboard).
pub const MAX_WRITE_BYTES: usize = 1024 * 1024;
/// This many terminals may be open at the same time.
pub const MAX_TERMINALS: usize = 16;
const MIN_SIZE: u16 = 2;
const MAX_SIZE: u16 = 1000;

/// Open terminals; accessed via `core.state::<TerminalState>()`.
#[derive(Default)]
pub struct TerminalState {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

impl TerminalState {
    /// IDs of the open terminals (for tests and cleanup).
    pub fn open_ids(&self) -> Vec<String> {
        self.sessions.lock().keys().cloned().collect()
    }
}

struct Session {
    /// `None` once the shell has ended (the pseudo-terminal is closed then).
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pid: Option<u32>,
    tree: Option<tree::ProcessTree>,
    info: Mutex<TerminalInfo>,
    observer: Option<Arc<dyn TerminalObserver>>,
}

/// What the reader has read and the sender has not sent yet.
#[derive(Default)]
struct Output {
    pending: Mutex<Pending>,
    changed: Condvar,
}

#[derive(Default)]
struct Pending {
    bytes: Vec<u8>,
    /// The reader has reached the end (pseudo-terminal closed).
    eof: bool,
    /// Exit code of the shell once the watcher knows it (`Some(None)`: ended without a code).
    exit: Option<Option<i32>>,
}

fn pty_error(what: &str, error: impl std::fmt::Display) -> CoreError {
    CoreError::io(format!("{what}: {error}"))
}

fn clamp_size(cols: u16, rows: u16) -> PtySize {
    PtySize { cols: cols.clamp(MIN_SIZE, MAX_SIZE), rows: rows.clamp(MIN_SIZE, MAX_SIZE), pixel_width: 0, pixel_height: 0 }
}

/// A program instead of the shell (coding agents). Built by the core only, never from a command line
/// the UI sent.
#[derive(Debug, Clone)]
pub struct ProgramLaunch {
    /// Absolute path of the program (from `tools::locate`).
    pub program: PathBuf,
    pub args: Vec<OsString>,
    /// Must be a registered worktree of the repository.
    pub cwd: PathBuf,
    pub env: Vec<(OsString, OsString)>,
    /// Short name for the terminal tab.
    pub title: String,
}

/// Something the program in a terminal signalled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalSignal {
    /// BEL outside an escape sequence.
    Bell,
    /// Window title (OSC 0 or 2).
    Title(String),
    /// Notification: OSC 9 (`body`) or OSC 777 `notify;title;body`.
    Notify { title: Option<String>, body: String },
}

/// Hears what a terminal's output shows. Called on the terminal's reader thread: return quickly.
pub trait TerminalObserver: Send + Sync {
    fn screen_changed(&self, terminal_id: &str);
    fn signal(&self, terminal_id: &str, signal: &TerminalSignal);
    /// Every chunk the reader read (raw bytes, before batching). Default: nothing.
    fn output(&self, _terminal_id: &str, _bytes: &[u8]) {}
    /// The program has ended, after its last output and before `terminal:exit`; `None` without an exit code.
    fn exited(&self, _terminal_id: &str, _code: Option<i32>) {}
}

/// What the core knows about an open terminal.
#[derive(Debug, Clone)]
pub struct TerminalInfo {
    pub title: String,
    /// `true` for `terminal_open_program`, `false` for the shell.
    pub program: bool,
    pub cwd: PathBuf,
    /// Last output that changed the screen (OSC sequences and BEL do not count).
    pub last_screen_change: Option<Instant>,
    pub last_signal: Option<TerminalSignal>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum ScanState {
    #[default]
    Text,
    Escape,
    Csi,
    Osc,
    OscEscape,
}

/// Longest OSC sequence that is read; the rest of a longer one is dropped.
const MAX_OSC: usize = 4096;
/// Longest title or notification text that is kept.
const MAX_SIGNAL_TEXT: usize = 200;

/// Finds BEL and the OSC sequences 0/2 (title), 9 and 777 (notifications) in a terminal's output –
/// also when a sequence is split across reads. Everything outside OSC sequences and BEL counts as a
/// screen change.
#[derive(Debug, Default)]
pub struct SignalScanner {
    state: ScanState,
    osc: Vec<u8>,
}

/// What one chunk of output contained.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Scanned {
    pub screen_changed: bool,
    pub signals: Vec<TerminalSignal>,
}

impl SignalScanner {
    pub fn feed(&mut self, bytes: &[u8]) -> Scanned {
        let mut out = Scanned::default();
        for &byte in bytes {
            match self.state {
                ScanState::Text => match byte {
                    0x1b => self.state = ScanState::Escape,
                    0x07 => out.signals.push(TerminalSignal::Bell),
                    _ => out.screen_changed = true,
                },
                ScanState::Escape => self.escape(byte, &mut out),
                ScanState::Csi => {
                    if (0x40..=0x7e).contains(&byte) {
                        self.state = ScanState::Text;
                    }
                }
                ScanState::Osc => match byte {
                    0x07 => {
                        self.finish(&mut out);
                        self.state = ScanState::Text;
                    }
                    0x1b => self.state = ScanState::OscEscape,
                    _ => {
                        if self.osc.len() < MAX_OSC {
                            self.osc.push(byte);
                        }
                    }
                },
                ScanState::OscEscape => {
                    // ESC \ ends the sequence; any other ESC begins the next sequence.
                    self.finish(&mut out);
                    if byte == b'\\' {
                        self.state = ScanState::Text;
                    } else {
                        self.escape(byte, &mut out);
                    }
                }
            }
        }
        out
    }

    /// The byte after an ESC.
    fn escape(&mut self, byte: u8, out: &mut Scanned) {
        match byte {
            b']' => {
                self.osc.clear();
                self.state = ScanState::Osc;
            }
            b'[' => {
                out.screen_changed = true;
                self.state = ScanState::Csi;
            }
            _ => {
                out.screen_changed = true;
                self.state = ScanState::Text;
            }
        }
    }

    fn finish(&mut self, out: &mut Scanned) {
        let osc = std::mem::take(&mut self.osc);
        let text = String::from_utf8_lossy(&osc);
        let (code, rest) = text.split_once(';').unwrap_or((&text, ""));
        let clean = |value: &str| -> String { value.chars().filter(|c| !c.is_control()).take(MAX_SIGNAL_TEXT).collect() };
        match code {
            "0" | "2" => out.signals.push(TerminalSignal::Title(clean(rest))),
            // OSC 9;4;… is a progress report (ConEmu, Windows Terminal), not a notification.
            "9" if !rest.starts_with("4;") => out.signals.push(TerminalSignal::Notify { title: None, body: clean(rest) }),
            "777" => {
                if let Some(notify) = rest.strip_prefix("notify;") {
                    let (title, body) = notify.split_once(';').unwrap_or((notify, ""));
                    out.signals.push(TerminalSignal::Notify { title: Some(clean(title)), body: clean(body) });
                }
            }
            _ => {}
        }
    }
}

/// Scans what a session's reader read; updates `TerminalInfo` and tells the observer.
struct Watch {
    id: String,
    scanner: SignalScanner,
    session: Arc<Session>,
    observer: Option<Arc<dyn TerminalObserver>>,
}

impl Watch {
    fn feed(&mut self, bytes: &[u8]) {
        if let Some(observer) = &self.observer {
            observer.output(&self.id, bytes);
        }
        let scanned = self.scanner.feed(bytes);
        if !scanned.screen_changed && scanned.signals.is_empty() {
            return;
        }
        {
            let mut info = self.session.info.lock();
            if scanned.screen_changed {
                info.last_screen_change = Some(Instant::now());
            }
            if let Some(last) = scanned.signals.last() {
                info.last_signal = Some(last.clone());
            }
        }
        if let Some(observer) = &self.observer {
            if scanned.screen_changed {
                observer.screen_changed(&self.id);
            }
            for signal in &scanned.signals {
                observer.signal(&self.id, signal);
            }
        }
    }
}

fn too_many() -> CoreError {
    CoreError::not_allowed(format!("{MAX_TERMINALS} terminals are already open. Close one first."))
}

/// The user's shell: program and arguments.
/// Windows: PowerShell 7 → Windows PowerShell → cmd. Otherwise `$SHELL` → bash → sh, as a
/// login shell so that PATH and environment from the profile apply (a desktop app does not inherit them).
pub fn default_shell(env_shell: Option<&str>, has_program: &dyn Fn(&str) -> bool) -> (String, Vec<String>) {
    if cfg!(windows) {
        for candidate in ["pwsh.exe", "powershell.exe"] {
            if has_program(candidate) {
                return (candidate.to_string(), vec!["-NoLogo".to_string()]);
            }
        }
        return ("cmd.exe".to_string(), Vec::new());
    }
    let from_env = env_shell.map(str::trim).filter(|shell| !shell.is_empty() && has_program(shell));
    let shell = from_env.map(str::to_string).unwrap_or_else(|| if has_program("bash") { "bash".to_string() } else { "sh".to_string() });
    let name = shell.rsplit('/').next().unwrap_or(&shell).to_string();
    let login = ["bash", "zsh", "fish", "sh", "dash", "ksh"].contains(&name.as_str());
    (shell, if login { vec!["-l".to_string()] } else { Vec::new() })
}

fn program_exists(program: &str) -> bool {
    which::which(program).is_ok()
}

/// Opens a terminal in the repository's folder and returns its ID. The output arrives as
/// `terminal:data`, the end of the shell as `terminal:exit`.
pub async fn terminal_open(core: &Core, repo_id: String, cols: u16, rows: u16) -> CoreResult<String> {
    let root = core.repo_path(&repo_id)?;
    let state = core.state::<TerminalState>();
    if state.sessions.lock().len() >= MAX_TERMINALS {
        return Err(too_many());
    }
    let core = core.clone();
    tokio::task::spawn_blocking(move || open_blocking(&core, &root, cols, rows))
        .await
        .map_err(|e| CoreError::io(format!("The terminal could not be started: {e}")))?
}

/// Opens a terminal that runs `launch.program` in `launch.cwd`, which must be a registered worktree of
/// the repository (the repository itself or a linked one). Output and end arrive like a shell's.
pub async fn terminal_open_program(
    core: &Core,
    repo_id: &str,
    launch: ProgramLaunch,
    cols: u16,
    rows: u16,
    observer: Option<Arc<dyn TerminalObserver>>,
) -> CoreResult<String> {
    core.repo_path(repo_id)?;
    if core.state::<TerminalState>().sessions.lock().len() >= MAX_TERMINALS {
        return Err(too_many());
    }
    if !launch.program.is_absolute() || !launch.program.is_file() {
        return Err(CoreError::not_found(format!("The program “{}” was not found.", util::display_path(&launch.program))));
    }
    if crate::proc::is_batch(&launch.program) {
        return Err(CoreError::unsupported(format!(
            "“{}” is a batch file; it can’t run in the built-in terminal. Point to the program itself (.exe).",
            util::display_path(&launch.program)
        )));
    }
    registered_worktree(core, repo_id, &launch.cwd).await?;
    let core = core.clone();
    tokio::task::spawn_blocking(move || open_program_blocking(&core, launch, cols, rows, observer))
        .await
        .map_err(|e| CoreError::io(format!("The terminal could not be started: {e}")))?
}

/// `cwd` is a worktree of the repository that still exists – otherwise `not_allowed`.
async fn registered_worktree(core: &Core, repo_id: &str, cwd: &Path) -> CoreResult<()> {
    let refuse = || {
        CoreError::not_allowed(format!("“{}” is not a worktree of this repository. Programs only start in one of its worktrees.", util::display_path(cwd)))
    };
    let wanted = std::fs::canonicalize(cwd).map_err(|_| refuse())?;
    let key = util::path_key(&wanted);
    let worktrees = crate::commands::worktree::worktree_list(core, repo_id.to_string()).await?;
    let found = worktrees.iter().filter(|worktree| !worktree.is_prunable).any(|worktree| std::fs::canonicalize(&worktree.path).is_ok_and(|path| util::path_key(&path) == key));
    if found {
        Ok(())
    } else {
        Err(refuse())
    }
}

/// What the core knows about an open terminal; `None` once it has ended.
pub fn terminal_info(core: &Core, terminal_id: &str) -> Option<TerminalInfo> {
    let session = core.state::<TerminalState>().sessions.lock().get(terminal_id).cloned()?;
    let info = session.info.lock().clone();
    Some(info)
}

/// Makes sure that Ctrl+C interrupts something in the shell and its child processes.
///
/// On Windows the process attribute "ignore Ctrl+C" is inherited: if the app was started by a
/// launcher with this attribute (`start /b`, some test runners, `CREATE_NEW_PROCESS_GROUP`),
/// every shell in the built-in terminal would get it too – a running program could no longer
/// be interrupted there. `SetConsoleCtrlHandler(NULL, FALSE)` resets it for this process
/// before the shell is created. The app itself has no console window; nothing changes for it.
#[cfg(windows)]
fn restore_ctrl_c() {
    // SAFETY: call without pointers – `None` as the handler and FALSE only restores the usual
    // Ctrl+C handling for this process.
    let ok = unsafe { windows_sys::Win32::System::Console::SetConsoleCtrlHandler(None, 0) };
    if ok == 0 {
        log::debug!("could not reset Ctrl+C handling (no console attached).");
    }
}

#[cfg(not(windows))]
fn restore_ctrl_c() {}

fn open_blocking(core: &Core, root: &Path, cols: u16, rows: u16) -> CoreResult<String> {
    let env_shell = std::env::var("SHELL").ok();
    let (shell, args) = default_shell(env_shell.as_deref(), &program_exists);
    let program = which::which(&shell).map_err(|_| CoreError::not_found(format!("The shell “{shell}” was not found.")))?;
    // `CommandBuilder::new` takes over this process's environment, i.e. the user's.
    let mut command = CommandBuilder::new(program.as_os_str());
    command.args(&args);
    command.cwd(root.as_os_str());
    let info = TerminalInfo { title: shell.clone(), program: false, cwd: root.to_path_buf(), last_screen_change: None, last_signal: None };
    spawn_session(core, command, &format!("The shell “{shell}” could not be started"), clamp_size(cols, rows), info, None)
}

fn open_program_blocking(core: &Core, launch: ProgramLaunch, cols: u16, rows: u16, observer: Option<Arc<dyn TerminalObserver>>) -> CoreResult<String> {
    let mut command = CommandBuilder::new(launch.program.as_os_str());
    command.args(&launch.args);
    command.cwd(launch.cwd.as_os_str());
    for (key, value) in &launch.env {
        command.env(key, value);
    }
    let name = launch.program.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default();
    let info = TerminalInfo { title: launch.title.clone(), program: true, cwd: launch.cwd.clone(), last_screen_change: None, last_signal: None };
    spawn_session(core, command, &format!("“{name}” could not be started"), clamp_size(cols, rows), info, observer)
}

/// Starts `command` on a new pseudo-terminal, registers the session and starts its three threads.
fn spawn_session(
    core: &Core,
    mut command: CommandBuilder,
    failure: &str,
    size: PtySize,
    info: TerminalInfo,
    observer: Option<Arc<dyn TerminalObserver>>,
) -> CoreResult<String> {
    let pair = native_pty_system().openpty(size).map_err(|e| pty_error("The pseudo terminal could not be created", e))?;
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "forkyard");
    restore_ctrl_c();
    let mut child = pair.slave.spawn_command(command).map_err(|e| pty_error(failure, e))?;
    // Only the program keeps its side of the pseudo-terminal open.
    drop(pair.slave);
    let pid = child.process_id();
    let tree = pid.and_then(tree::ProcessTree::attach);
    let mut killer = child.clone_killer();
    let pipes = pair.master.try_clone_reader().and_then(|reader| Ok((reader, pair.master.take_writer()?)));
    let (reader, writer) = match pipes {
        Ok(pipes) => pipes,
        Err(e) => {
            let _ = killer.kill();
            return Err(pty_error("The terminal can't be read or written", e));
        }
    };

    let id = util::new_id();
    let output = Arc::new(Output::default());
    let session = Arc::new(Session {
        master: Mutex::new(Some(pair.master)),
        writer: Mutex::new(Some(writer)),
        killer: Mutex::new(killer),
        pid,
        tree,
        info: Mutex::new(info),
        observer: observer.clone(),
    });
    core.state::<TerminalState>().sessions.lock().insert(id.clone(), session.clone());

    let mut watch = Watch { id: id.clone(), scanner: SignalScanner::default(), session: session.clone(), observer };
    spawn_thread("terminal-leser", {
        let output = output.clone();
        move || read_loop(reader, &output, &mut watch)
    });
    spawn_thread("terminal-sender", {
        let (core, id, output, session) = (core.clone(), id.clone(), output.clone(), session.clone());
        move || send_loop(&core, &id, &output, &session)
    });
    spawn_thread("terminal-waechter", {
        let output = output.clone();
        move || {
            let code = child.wait().ok().map(|status| status.exit_code() as i32);
            session.shutdown();
            let mut pending = output.pending.lock();
            pending.exit = Some(code);
            output.changed.notify_all();
        }
    });
    Ok(id)
}

fn spawn_thread(name: &str, body: impl FnOnce() + Send + 'static) {
    if let Err(e) = std::thread::Builder::new().name(name.to_string()).spawn(body) {
        log::warn!("thread {name} not started: {e}");
    }
}

impl Session {
    /// Closes the pseudo-terminal: the reader then sees end-of-file. Whatever is still attached
    /// to it (child processes of the shell) ends with it.
    fn shutdown(&self) {
        self.writer.lock().take();
        self.kill_tree();
        self.master.lock().take();
    }

    /// Ends the shell along with everything it started.
    fn kill_tree(&self) {
        if let Some(tree) = &self.tree {
            tree.terminate();
        }
        #[cfg(unix)]
        if let Some(pid) = self.pid.and_then(|pid| i32::try_from(pid).ok()) {
            // The shell leads its own session: the signal goes to its process group.
            // SAFETY: kill(2) with a negative PID only addresses this shell's process group.
            unsafe {
                libc::kill(-pid, libc::SIGHUP);
            }
        }
        #[cfg(not(unix))]
        let _ = self.pid;
        let _ = self.killer.lock().kill();
    }
}

/// Reads the output until the pseudo-terminal is closed; `watch` sees every chunk first.
fn read_loop(mut reader: Box<dyn Read + Send>, output: &Output, watch: &mut Watch) {
    let mut chunk = vec![0u8; 16 * 1024];
    loop {
        let read = match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        watch.feed(&chunk[..read]);
        let mut pending = output.pending.lock();
        // If output backs up, the reader waits: that throttles the shell through the pseudo-terminal.
        while pending.bytes.len() > MAX_PENDING_BYTES {
            output.changed.wait(&mut pending);
        }
        pending.bytes.extend_from_slice(&chunk[..read]);
        output.changed.notify_all();
    }
    output.pending.lock().eof = true;
    output.changed.notify_all();
}

/// The cursor position query and the answer "row 1, column 1".
const CURSOR_QUERY: &[u8] = b"\x1b[6n";
const CURSOR_AT_HOME: &[u8] = b"\x1b[1;1R";

/// Sends the output batched as `terminal:data` and `terminal:exit` at the end.
fn send_loop(core: &Core, id: &str, output: &Output, session: &Session) {
    let mut decoder = Utf8Chunks::default();
    // Only the very first output can be ConPTY's startup query.
    let mut startup = cfg!(windows);
    loop {
        {
            let mut pending = output.pending.lock();
            while pending.bytes.is_empty() && !pending.eof {
                output.changed.wait(&mut pending);
            }
            if pending.bytes.is_empty() && pending.eof {
                break;
            }
        }
        // Collect briefly: many small chunks become one event.
        std::thread::sleep(FLUSH_INTERVAL);
        loop {
            let bytes: Vec<u8> = {
                let mut pending = output.pending.lock();
                let take = pending.bytes.len().min(MAX_EVENT_BYTES);
                let bytes = pending.bytes.drain(..take).collect();
                output.changed.notify_all();
                bytes
            };
            if bytes.is_empty() {
                break;
            }
            let bytes = if std::mem::take(&mut startup) && bytes.starts_with(CURSOR_QUERY) {
                if let Some(writer) = session.writer.lock().as_mut() {
                    let _ = writer.write_all(CURSOR_AT_HOME).and_then(|()| writer.flush());
                }
                bytes[CURSOR_QUERY.len()..].to_vec()
            } else {
                bytes
            };
            let text = decoder.push(&bytes);
            if !text.is_empty() {
                core.emit(names::TERMINAL_DATA, &TerminalDataEvent { terminal_id: id.to_string(), data: text });
            }
        }
    }
    let rest = decoder.finish();
    if !rest.is_empty() {
        core.emit(names::TERMINAL_DATA, &TerminalDataEvent { terminal_id: id.to_string(), data: rest });
    }
    // The exit code is known before the pseudo-terminal is closed – unless reading ended on
    // its own; then wait briefly for the watcher.
    let code = {
        let mut pending = output.pending.lock();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while pending.exit.is_none() && std::time::Instant::now() < deadline {
            output.changed.wait_for(&mut pending, Duration::from_millis(100));
        }
        pending.exit.flatten()
    };
    core.state::<TerminalState>().sessions.lock().remove(id);
    if let Some(observer) = &session.observer {
        observer.exited(id, code);
    }
    core.emit(names::TERMINAL_EXIT, &TerminalExitEvent { terminal_id: id.to_string(), code });
}

/// Turns a byte stream into valid UTF-8: an incomplete character at the end of a chunk waits
/// for its remainder, invalid bytes become U+FFFD.
#[derive(Default)]
pub struct Utf8Chunks {
    carry: Vec<u8>,
}

impl Utf8Chunks {
    pub fn push(&mut self, bytes: &[u8]) -> String {
        let mut input = std::mem::take(&mut self.carry);
        input.extend_from_slice(bytes);
        let mut out = String::with_capacity(input.len());
        let mut rest: &[u8] = &input;
        loop {
            match std::str::from_utf8(rest) {
                Ok(text) => {
                    out.push_str(text);
                    break;
                }
                Err(error) => {
                    let (valid, after) = rest.split_at(error.valid_up_to());
                    out.push_str(&String::from_utf8_lossy(valid));
                    match error.error_len() {
                        // Invalid bytes in the middle of the stream.
                        Some(len) => {
                            out.push('\u{FFFD}');
                            rest = &after[len..];
                        }
                        // Incomplete character at the end: keep it.
                        None => {
                            self.carry = after.to_vec();
                            break;
                        }
                    }
                }
            }
        }
        out
    }

    /// What is left at the end (a truncated character becomes U+FFFD).
    pub fn finish(&mut self) -> String {
        let carry = std::mem::take(&mut self.carry);
        String::from_utf8_lossy(&carry).into_owned()
    }
}

fn session(core: &Core, terminal_id: &str) -> CoreResult<Arc<Session>> {
    core.state::<TerminalState>()
        .sessions
        .lock()
        .get(terminal_id)
        .cloned()
        .ok_or_else(|| CoreError::not_found("This terminal does not exist (anymore)."))
}

/// Input to the shell (keystrokes, paste). Unknown or ended session → `not_found`.
pub async fn terminal_write(core: &Core, terminal_id: String, data: String) -> CoreResult<()> {
    if data.len() > MAX_WRITE_BYTES {
        return Err(CoreError::not_allowed("The input is too large for the terminal (more than 1 MB)."));
    }
    let session = session(core, &terminal_id)?;
    tokio::task::spawn_blocking(move || {
        let mut writer = session.writer.lock();
        let Some(writer) = writer.as_mut() else {
            return Err(CoreError::not_found("This terminal has exited."));
        };
        writer.write_all(data.as_bytes()).and_then(|()| writer.flush()).map_err(|e| pty_error("The input did not reach the terminal", e))
    })
    .await
    .map_err(|e| CoreError::io(format!("Writing to the terminal was aborted: {e}")))?
}

/// New size in characters (clamped to 2 to 1000).
pub async fn terminal_resize(core: &Core, terminal_id: String, cols: u16, rows: u16) -> CoreResult<()> {
    let session = session(core, &terminal_id)?;
    let master = session.master.lock();
    let Some(master) = master.as_ref() else {
        return Err(CoreError::not_found("This terminal has exited."));
    };
    master.resize(clamp_size(cols, rows)).map_err(|e| pty_error("The terminal could not be resized", e))
}

/// Closes the terminal and ends the shell along with its child processes. `terminal:exit`
/// still follows. An unknown ID is not an error (already ended).
pub async fn terminal_close(core: &Core, terminal_id: String) -> CoreResult<()> {
    crate::commands::agents::registry::stop_requested_for_terminal(core, &terminal_id);
    let Ok(session) = session(core, &terminal_id) else { return Ok(()) };
    tokio::task::spawn_blocking(move || session.kill_tree())
        .await
        .map_err(|e| CoreError::io(format!("Closing the terminal was aborted: {e}")))
}

/// Closes all terminals (when the app quits).
pub fn close_all(core: &Core) {
    crate::commands::agents::close_all(core);
    let sessions: Vec<Arc<Session>> = core.state::<TerminalState>().sessions.lock().values().cloned().collect();
    for session in sessions {
        session.kill_tree();
    }
}

/// Windows: a job object around the shell so that `terminal_close` ends the whole process tree.
#[cfg(windows)]
mod tree {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW, TerminateJobObject};
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};

    pub struct ProcessTree(HANDLE);

    // SAFETY: the handle is owned by this value alone; job objects may be used from any thread.
    unsafe impl Send for ProcessTree {}
    unsafe impl Sync for ProcessTree {}

    impl ProcessTree {
        /// Puts the process just started into a new job object; everything it starts afterwards
        /// belongs to it. `None` if Windows refuses.
        pub fn attach(pid: u32) -> Option<ProcessTree> {
            // SAFETY: valid arguments; the handles are checked and the process handle is closed
            // again after the assignment.
            unsafe {
                let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
                if process.is_null() {
                    return None;
                }
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if job.is_null() {
                    CloseHandle(process);
                    return None;
                }
                let assigned = AssignProcessToJobObject(job, process);
                CloseHandle(process);
                if assigned == 0 {
                    CloseHandle(job);
                    return None;
                }
                Some(ProcessTree(job))
            }
        }

        pub fn terminate(&self) {
            // SAFETY: `self.0` is an open job handle.
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for ProcessTree {
        fn drop(&mut self) {
            // SAFETY: `self.0` is an open handle and is only closed here.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

/// Unix needs no separate object: there `kill_tree` ends the shell's process group.
#[cfg(not(windows))]
mod tree {
    pub struct ProcessTree;

    impl ProcessTree {
        pub fn attach(_pid: u32) -> Option<ProcessTree> {
            None
        }
        pub fn terminate(&self) {}
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod program_tests;
