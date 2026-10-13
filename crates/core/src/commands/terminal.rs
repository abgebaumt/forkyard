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

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

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
        return Err(CoreError::not_allowed(format!(
            "{MAX_TERMINALS} terminals are already open. Close one first."
        )));
    }
    let core = core.clone();
    tokio::task::spawn_blocking(move || open_blocking(&core, &root, cols, rows))
        .await
        .map_err(|e| CoreError::io(format!("The terminal could not be started: {e}")))?
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

    let pair = native_pty_system().openpty(clamp_size(cols, rows)).map_err(|e| pty_error("The pseudo terminal could not be created", e))?;
    // `CommandBuilder::new` takes over this process's environment, i.e. the user's.
    let mut command = CommandBuilder::new(program.as_os_str());
    command.args(&args);
    command.cwd(root.as_os_str());
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    command.env("TERM_PROGRAM", "forkyard");
    restore_ctrl_c();
    let mut child = pair.slave.spawn_command(command).map_err(|e| pty_error(&format!("The shell “{shell}” could not be started"), e))?;
    // Only the shell keeps its side of the pseudo-terminal open.
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
    });
    core.state::<TerminalState>().sessions.lock().insert(id.clone(), session.clone());

    spawn_thread("terminal-leser", {
        let output = output.clone();
        move || read_loop(reader, &output)
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

/// Reads the output until the pseudo-terminal is closed.
fn read_loop(mut reader: Box<dyn Read + Send>, output: &Output) {
    let mut chunk = vec![0u8; 16 * 1024];
    loop {
        let read = match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
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
    let Ok(session) = session(core, &terminal_id) else { return Ok(()) };
    tokio::task::spawn_blocking(move || session.kill_tree())
        .await
        .map_err(|e| CoreError::io(format!("Closing the terminal was aborted: {e}")))
}

/// Closes all terminals (when the app quits).
pub fn close_all(core: &Core) {
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
