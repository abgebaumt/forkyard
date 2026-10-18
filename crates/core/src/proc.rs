//! Runner for programs other than Git: coding-agent CLIs, test scripts, status hooks.
//!
//! ```ignore
//! let out = Proc::new("claude")
//!     .args(["-p", "--output-format", "json"])
//!     .cwd(&empty_temp_dir)              // never the repository
//!     .stdin(prompt.into_bytes())        // user data only through stdin or files
//!     .timeout(Duration::from_secs(90))
//!     .logged(core, Some(&repo_id), "ai: commit-message (Claude Code)")
//!     .run(&cancel)
//!     .await?;
//! ```
//!
//! - The program runs in its own process group (Unix) or job object (Windows): cancel and timeout
//!   end it together with everything it started. On Windows no console window opens.
//! - Output is limited: more than `MAX_STDOUT` on stdout stops the program (`not_allowed`, a
//!   truncated answer is never returned as complete); stderr keeps its first `MAX_STDERR` bytes.
//! - A non-zero exit code is not an error: the caller decides what it means.
//! - The activity log gets the command line (redacted), exit code, duration and the error message –
//!   never stdin, stdout or stderr.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Notify;

use crate::app::Core;
use crate::db;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::events::names;
use crate::git::redact;
use crate::git::runner::{kill_tree, ProcessTree};
use crate::jobs::CancelToken;
use crate::util;

/// Largest stdout a program may write.
pub const MAX_STDOUT: usize = 8 * 1024 * 1024;
/// Stderr beyond this is dropped.
pub const MAX_STDERR: usize = 1024 * 1024;
/// The program has exited, but something it left running keeps the pipes open: wait this long.
const PIPE_GRACE: Duration = Duration::from_millis(300);

/// Result of a finished program.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcOutput {
    /// `None` if the program was ended by a signal.
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// More than the stderr limit arrived; the rest was dropped.
    pub stderr_truncated: bool,
    pub duration: Duration,
}

impl ProcOutput {
    pub fn success(&self) -> bool {
        self.code == Some(0)
    }

    /// stdout as text (lossy), without trailing whitespace.
    pub fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).trim_end().to_string()
    }
}

struct LogTo {
    core: Core,
    repo_id: Option<String>,
    description: String,
}

/// A program call; see the module documentation.
pub struct Proc {
    program: OsString,
    args: Vec<OsString>,
    /// Appended verbatim after `args` on Windows, without std's MSVC quoting (see [`Proc::raw_arg`]).
    raw: Option<OsString>,
    cwd: Option<PathBuf>,
    env: Vec<(OsString, Option<OsString>)>,
    stdin: Option<Vec<u8>>,
    timeout: Option<Duration>,
    max_stdout: usize,
    max_stderr: usize,
    search_path: Option<OsString>,
    log: Option<LogTo>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stop {
    Overflow,
    Cancelled,
    TimedOut,
}

enum End {
    /// All pipes closed.
    Read,
    /// Exited, but the pipes stayed open (background process of the program).
    PipesHeld,
    Stop(Stop),
}

impl Proc {
    pub fn new(program: impl AsRef<OsStr>) -> Self {
        Proc {
            program: program.as_ref().to_os_string(),
            args: Vec::new(),
            raw: None,
            cwd: None,
            env: Vec::new(),
            stdin: None,
            timeout: None,
            max_stdout: MAX_STDOUT,
            max_stderr: MAX_STDERR,
            search_path: None,
            log: None,
        }
    }

    pub fn arg(mut self, arg: impl AsRef<OsStr>) -> Self {
        self.args.push(arg.as_ref().to_os_string());
        self
    }

    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<OsStr>,
    {
        self.args.extend(args.into_iter().map(|arg| arg.as_ref().to_os_string()));
        self
    }

    /// A command-line tail that goes onto the Windows command line exactly as given – for
    /// `cmd.exe /s /c "<line>"`, which strips the outer quotes and knows no backslash escapes, so the
    /// usual `\"` quoting would mangle quotes inside the line. Elsewhere it is one ordinary argument.
    pub fn raw_arg(mut self, line: impl AsRef<OsStr>) -> Self {
        self.raw = Some(line.as_ref().to_os_string());
        self
    }

    pub fn cwd(mut self, dir: impl Into<PathBuf>) -> Self {
        self.cwd = Some(dir.into());
        self
    }

    pub fn env(mut self, key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) -> Self {
        self.env.push((key.as_ref().to_os_string(), Some(value.as_ref().to_os_string())));
        self
    }

    pub fn env_remove(mut self, key: impl AsRef<OsStr>) -> Self {
        self.env.push((key.as_ref().to_os_string(), None));
        self
    }

    pub fn stdin(mut self, data: impl Into<Vec<u8>>) -> Self {
        self.stdin = Some(data.into());
        self
    }

    pub fn timeout(mut self, limit: Duration) -> Self {
        self.timeout = Some(limit);
        self
    }

    /// Lower limits for stdout and stderr in bytes; never above `MAX_STDOUT`/`MAX_STDERR`.
    pub fn max_output(mut self, stdout: usize, stderr: usize) -> Self {
        self.max_stdout = stdout.min(MAX_STDOUT);
        self.max_stderr = stderr.min(MAX_STDERR);
        self
    }

    /// Folders searched before PATH (separated like PATH), e.g. the login shell's PATH. On Windows the
    /// extensions from PATHEXT apply.
    pub fn search_path(mut self, paths: impl Into<OsString>) -> Self {
        self.search_path = Some(paths.into());
        self
    }

    /// Writes one entry into the activity log (app log with `repo_id: None`).
    pub fn logged(mut self, core: &Core, repo_id: Option<&str>, description: impl Into<String>) -> Self {
        self.log = Some(LogTo { core: core.clone(), repo_id: repo_id.map(str::to_string), description: description.into() });
        self
    }

    /// The command line for confirmations and the log, redacted.
    pub fn command_line(&self) -> String {
        let args: Vec<String> = self.args.iter().chain(&self.raw).map(|arg| arg.to_string_lossy().into_owned()).collect();
        display_line(&self.program.to_string_lossy(), &args)
    }

    fn name(&self) -> String {
        Path::new(&self.program).file_name().unwrap_or(&self.program).to_string_lossy().into_owned()
    }

    pub async fn run(self, cancel: &CancelToken) -> CoreResult<ProcOutput> {
        let started_at = util::now_iso();
        let start = Instant::now();
        let result = self.execute(cancel).await;
        self.write_log(&started_at, start.elapsed(), &result);
        result
    }

    /// The program to start: a path as given, otherwise found on `search_path`, then on PATH.
    fn resolve(&self) -> CoreResult<PathBuf> {
        let given = Path::new(&self.program);
        if given.is_absolute() || given.components().count() > 1 {
            return if given.is_file() { Ok(given.to_path_buf()) } else { Err(not_found(&self.program)) };
        }
        let cwd = self.cwd.clone().unwrap_or_else(std::env::temp_dir);
        self.search_path
            .as_ref()
            .and_then(|paths| which::which_in(&self.program, Some(paths), &cwd).ok())
            .or_else(|| which::which(&self.program).ok())
            .ok_or_else(|| not_found(&self.program))
    }

    fn command(&self, program: &Path) -> CoreResult<tokio::process::Command> {
        if is_batch(program) {
            return batch_command(&batch_command_line(program, &self.args)?);
        }
        let mut cmd = tokio::process::Command::new(program);
        cmd.args(&self.args);
        if let Some(raw) = &self.raw {
            #[cfg(windows)]
            cmd.raw_arg(raw);
            #[cfg(not(windows))]
            cmd.arg(raw);
        }
        Ok(cmd)
    }

    async fn execute(&self, cancel: &CancelToken) -> CoreResult<ProcOutput> {
        cancel.check()?;
        if let Some(dir) = &self.cwd {
            if !dir.is_dir() {
                return Err(CoreError::path_not_found(util::display_path(dir)));
            }
        }
        let program = self.resolve()?;
        let mut cmd = self.command(&program)?;
        cmd.stdin(if self.stdin.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
        if let Some(dir) = &self.cwd {
            cmd.current_dir(dir);
        }
        for (key, value) in &self.env {
            match value {
                Some(value) => cmd.env(key, value),
                None => cmd.env_remove(key),
            };
        }
        #[cfg(windows)]
        cmd.creation_flags(crate::git::runner::CREATE_NO_WINDOW);
        #[cfg(unix)]
        cmd.process_group(0);

        let start = Instant::now();
        let mut child = spawn(&mut cmd, cancel).await.map_err(|e| spawn_error(&self.name(), e))?;
        let tree = ProcessTree::attach(&child);
        let (stdin_pipe, stdout_pipe, stderr_pipe) = (child.stdin.take(), child.stdout.take(), child.stderr.take());
        let data = self.stdin.clone();
        let (max_stdout, max_stderr) = (self.max_stdout, self.max_stderr);
        let overflow = Notify::new();
        let overflowed = AtomicBool::new(false);
        // Outside the read futures: what was read stays available when reading is cut short.
        let mut stdout: Vec<u8> = Vec::new();
        let mut stderr: Vec<u8> = Vec::new();
        let mut stderr_truncated = false;

        let stdin_fut = async move {
            if let (Some(mut pipe), Some(data)) = (stdin_pipe, data) {
                // The program may close stdin early; that shows in its exit code.
                let _ = pipe.write_all(&data).await;
                let _ = pipe.shutdown().await;
            }
        };
        let stdout_fut = async {
            let collected = &mut stdout;
            let Some(mut pipe) = stdout_pipe else { return };
            let mut chunk = vec![0u8; 64 * 1024];
            loop {
                let n = match pipe.read(&mut chunk).await {
                    Ok(0) | Err(_) => return,
                    Ok(n) => n,
                };
                if collected.len() + n > max_stdout {
                    overflowed.store(true, Ordering::SeqCst);
                    overflow.notify_one();
                    return;
                }
                collected.extend_from_slice(&chunk[..n]);
            }
        };
        let stderr_fut = async {
            let (collected, truncated) = (&mut stderr, &mut stderr_truncated);
            let Some(mut pipe) = stderr_pipe else { return };
            let mut chunk = vec![0u8; 16 * 1024];
            loop {
                let n = match pipe.read(&mut chunk).await {
                    Ok(0) | Err(_) => return,
                    Ok(n) => n,
                };
                let room = max_stderr.saturating_sub(collected.len());
                if n > room {
                    *truncated = true;
                }
                collected.extend_from_slice(&chunk[..n.min(room)]);
            }
        };

        let deadline = self.timeout.map(|limit| tokio::time::Instant::now() + limit);
        let mut io = Box::pin(async { tokio::join!(stdin_fut, stdout_fut, stderr_fut) });
        let mut exit: Option<std::process::ExitStatus> = None;
        let mut grace: Option<tokio::time::Instant> = None;
        let end = loop {
            tokio::select! {
                _ = &mut io => break End::Read,
                status = child.wait(), if exit.is_none() => {
                    exit = status.ok();
                    grace = Some(tokio::time::Instant::now() + PIPE_GRACE);
                }
                _ = sleep_until(grace) => break End::PipesHeld,
                _ = overflow.notified() => break End::Stop(Stop::Overflow),
                _ = cancel.cancelled() => break End::Stop(Stop::Cancelled),
                _ = sleep_until(deadline) => break End::Stop(Stop::TimedOut),
            }
        };
        drop(io);
        let end = if overflowed.load(Ordering::SeqCst) { End::Stop(Stop::Overflow) } else { end };
        if let End::Stop(stop) = end {
            kill_tree(&mut child, tree.as_ref()).await;
            let _ = child.wait().await;
            return Err(self.stop_error(stop));
        }
        let status = match exit {
            Some(status) => status,
            None => {
                let waited = tokio::select! {
                    status = child.wait() => Ok(status),
                    _ = cancel.cancelled() => Err(Stop::Cancelled),
                    _ = sleep_until(deadline) => Err(Stop::TimedOut),
                };
                match waited {
                    Ok(status) => status.map_err(|e| CoreError::io(format!("Waiting for “{}” failed.", self.name())).with_git_output(e.to_string()))?,
                    Err(stop) => {
                        kill_tree(&mut child, tree.as_ref()).await;
                        let _ = child.wait().await;
                        return Err(self.stop_error(stop));
                    }
                }
            }
        };
        Ok(ProcOutput { code: status.code(), stdout, stderr, stderr_truncated, duration: start.elapsed() })
    }

    fn stop_error(&self, stop: Stop) -> CoreError {
        let name = self.name();
        match stop {
            Stop::Cancelled => CoreError::cancelled(),
            Stop::TimedOut => {
                CoreError::new(ErrorCode::Timeout, format!("“{name}” did not finish within {} and was stopped.", seconds(self.timeout.unwrap_or_default())))
            }
            Stop::Overflow => CoreError::not_allowed(format!("“{name}” wrote more than {} of output and was stopped.", size(self.max_stdout))),
        }
    }

    fn write_log(&self, started_at: &str, duration: Duration, result: &CoreResult<ProcOutput>) {
        let Some(log) = &self.log else { return };
        let (exit_code, code, output) = match result {
            Ok(out) => (out.code, (!out.success()).then_some(ErrorCode::Unknown), String::new()),
            Err(e) => (None, Some(e.code), e.message.clone()),
        };
        let entry = db::activity::NewActivity {
            repo_id: log.repo_id.clone(),
            description: log.description.clone(),
            command: self.command_line(),
            exit_code,
            duration_ms: duration.as_millis() as u64,
            output,
            started_at: started_at.to_string(),
            code,
        };
        match log.core.db.with(|c| db::activity::insert(c, &entry)) {
            Ok(saved) => log.core.emit(names::LOG_APPENDED, &saved),
            Err(e) => log::warn!("Log entry not saved: {}", e.message),
        }
    }
}

/// `.cmd` or `.bat`: Windows runs it through `cmd.exe`, which reads the command line itself.
pub fn is_batch(path: &Path) -> bool {
    path.extension().and_then(OsStr::to_str).is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
}

/// Characters `cmd.exe` interprets even inside quotes, or that end the command line.
const BATCH_FORBIDDEN: &[char] = &['"', '%', '!', '^', '&', '|', '<', '>', '\r', '\n', '\0'];

/// The command line for `cmd.exe /d /s /c "<line>"`: program and arguments, quoted where they contain
/// spaces or characters cmd splits at. An argument `cmd.exe` would interpret is refused – user text
/// belongs into stdin or a file, never onto a batch command line.
pub fn batch_command_line(program: &Path, args: &[OsString]) -> CoreResult<String> {
    let refuse = |text: &str| {
        CoreError::not_allowed(format!(
            "A batch file can’t be started with “{}”: it contains a character cmd.exe would interpret. Such data goes through stdin or a file.",
            redact::redact(text)
        ))
    };
    let program = program.to_str().ok_or_else(|| CoreError::not_allowed("The path of the batch file is not valid Unicode."))?;
    if program.contains(BATCH_FORBIDDEN) {
        return Err(refuse(program));
    }
    let mut line = format!("\"{program}\"");
    for arg in args {
        let text = arg.to_str().ok_or_else(|| CoreError::not_allowed("An argument for the batch file is not valid Unicode."))?;
        if text.contains(BATCH_FORBIDDEN) {
            return Err(refuse(text));
        }
        line.push(' ');
        if text.is_empty() || text.contains([' ', '\t', '(', ')', ',', ';', '=']) {
            line.push('"');
            line.push_str(text);
            line.push('"');
        } else {
            line.push_str(text);
        }
    }
    Ok(line)
}

#[cfg(windows)]
fn batch_command(line: &str) -> CoreResult<tokio::process::Command> {
    // Not ComSpec: the environment must not choose the interpreter.
    let shell = std::env::var_os("SystemRoot").map(|root| PathBuf::from(root).join("System32").join("cmd.exe")).unwrap_or_else(|| PathBuf::from("cmd.exe"));
    let mut cmd = tokio::process::Command::new(shell);
    cmd.raw_arg(format!("/d /s /c \"{line}\""));
    Ok(cmd)
}

#[cfg(not(windows))]
fn batch_command(_line: &str) -> CoreResult<tokio::process::Command> {
    Err(CoreError::not_allowed("Batch files (.cmd, .bat) only run on Windows."))
}

fn not_found(program: &OsStr) -> CoreError {
    CoreError::not_found(format!("The program “{}” was not found.", program.to_string_lossy()))
}

/// Starts `cmd`. A program file that is still open for writing ("Text file busy" on Unix: just
/// written or updated, or held for a moment by a child another thread forked in that window) is
/// tried again a few times, about 0.6 s in all, instead of failing at once.
async fn spawn(cmd: &mut tokio::process::Command, cancel: &CancelToken) -> std::io::Result<tokio::process::Child> {
    let mut delay = Duration::from_millis(10);
    for _ in 0..6 {
        match cmd.spawn() {
            Err(e) if is_busy(&e) && !cancel.is_cancelled() => {
                tokio::time::sleep(delay).await;
                delay *= 2;
            }
            other => return other,
        }
    }
    cmd.spawn()
}

#[cfg(unix)]
fn is_busy(e: &std::io::Error) -> bool {
    e.raw_os_error() == Some(libc::ETXTBSY)
}

#[cfg(not(unix))]
fn is_busy(_: &std::io::Error) -> bool {
    false
}

fn spawn_error(name: &str, e: std::io::Error) -> CoreError {
    if e.kind() == std::io::ErrorKind::NotFound {
        return CoreError::not_found(format!("The program “{name}” was not found.")).with_git_output(e.to_string());
    }
    let (code, reason) = crate::error::describe_io(&e);
    CoreError::new(code, format!("“{name}” couldn’t be started. {reason}")).with_git_output(e.to_string())
}

async fn sleep_until(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

fn seconds(limit: Duration) -> String {
    if limit < Duration::from_secs(10) {
        format!("{:.1} s", limit.as_secs_f64())
    } else {
        format!("{} s", limit.as_secs())
    }
}

fn size(bytes: usize) -> String {
    if bytes >= 1024 * 1024 {
        format!("{} MiB", bytes / (1024 * 1024))
    } else if bytes >= 1024 {
        format!("{} KiB", bytes / 1024)
    } else {
        format!("{bytes} bytes")
    }
}

fn quote(arg: &str) -> String {
    if !arg.is_empty() && !arg.chars().any(|c| c.is_whitespace() || c == '"') {
        return arg.to_string();
    }
    format!("\"{}\"", arg.replace('"', "\\\""))
}

/// `program arg …` with quotes around arguments containing spaces, without credentials. Only for
/// display – the program gets its arguments separately.
pub fn display_line(program: &str, args: &[String]) -> String {
    let mut line = quote(program);
    for arg in args {
        line.push(' ');
        line.push_str(&quote(arg));
    }
    util::truncate_str(&redact::redact(&line), 2000)
}

#[cfg(test)]
mod tests;
