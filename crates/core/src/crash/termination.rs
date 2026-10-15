//! Requests to end the app from outside end it like quitting does – they are not a crash.
//!
//! - **Unix:** SIGTERM (`kill`, the session ending, a service manager), SIGINT (Ctrl+C in the
//!   terminal that started the app) and SIGHUP (that terminal closing). A signal that was
//!   ignored when the app started (`nohup`) stays ignored. The handler itself only writes the
//!   signal number into a pipe (async-signal-safe); a thread reads it and calls the callback.
//!   Programs the app starts get the default handling back with `exec`.
//! - **Windows:** console events (Ctrl+C, Ctrl+Break, the console window closing, logoff,
//!   shutdown) – only relevant when the app has a console (development builds). Windows ends the
//!   process as soon as the handler returns from the close, logoff and shutdown events (and
//!   after about five seconds anyway), so the handler waits a little for the callback and then
//!   performs the clean exit of the marker itself. Logoff and shutdown of the GUI app arrive as
//!   `WM_ENDSESSION`: the window loop (tao) answers it with the app's `RunEvent::Exit`, which
//!   already performs the clean exit – nothing to do here. Best effort: a process ended with
//!   `TerminateProcess` cannot clean up.
//! - SIGKILL, a crash or a power cut cannot be caught: the next start reports them.
//!
//! The first request calls the callback on its own thread (it is expected to end the process
//! the same way quitting does); a second request while that is still running ends the process at
//! once – still cleanly as far as the crash marker is concerned.

use std::sync::mpsc::{channel, Receiver};
use std::sync::OnceLock;

static INSTALLED: OnceLock<()> = OnceLock::new();

/// Calls `on_request` (with the name of the request, e.g. `SIGTERM`) once the app is asked to end.
/// Only the first call installs anything.
pub fn install_termination_handler<F>(on_request: F) -> std::io::Result<()>
where
    F: Fn(&'static str) + Send + 'static,
{
    if INSTALLED.set(()).is_err() {
        return Err(std::io::Error::new(std::io::ErrorKind::AlreadyExists, "the termination handler is already installed"));
    }
    let (tx, rx) = channel();
    platform::install(tx)?;
    std::thread::Builder::new().name("forkyard-termination".into()).spawn(move || dispatch(&rx, on_request))?;
    Ok(())
}

fn dispatch<F>(rx: &Receiver<&'static str>, on_request: F)
where
    F: Fn(&'static str) + Send + 'static,
{
    let Ok(first) = rx.recv() else { return };
    log::info!("Termination requested ({first}); ending like quitting");
    let spawned = std::thread::Builder::new().name("forkyard-shutdown".into()).spawn(move || on_request(first));
    if let Err(e) = spawned {
        log::warn!("No thread for the shutdown ({e}); ending now");
        super::global().clean_exit();
        std::process::exit(0);
    }
    if let Ok(again) = rx.recv() {
        log::warn!("Termination requested again ({again}); ending now");
        super::global().clean_exit();
        std::process::exit(0);
    }
}

#[cfg(unix)]
mod platform {
    use std::fs::File;
    use std::io::Read;
    use std::os::unix::io::FromRawFd;
    use std::sync::atomic::{AtomicI32, Ordering};
    use std::sync::mpsc::Sender;

    const SIGNALS: [(libc::c_int, &str); 3] = [(libc::SIGTERM, "SIGTERM"), (libc::SIGINT, "SIGINT"), (libc::SIGHUP, "SIGHUP")];

    /// Write end of the pipe; `-1` until installed.
    static WRITE_FD: AtomicI32 = AtomicI32::new(-1);

    extern "C" fn on_signal(signal: libc::c_int) {
        let fd = WRITE_FD.load(Ordering::Relaxed);
        if fd >= 0 {
            let byte = signal as u8;
            // SAFETY: write(2) is async-signal-safe; one byte from this stack frame. The write end
            // is non-blocking, so a full pipe never blocks the interrupted thread.
            unsafe { libc::write(fd, (&byte as *const u8).cast(), 1) };
        }
    }

    pub(super) fn install(tx: Sender<&'static str>) -> std::io::Result<()> {
        let mut fds = [0 as libc::c_int; 2];
        // SAFETY: `pipe` fills the two-element array this function owns.
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: flags on the two descriptors just created; no memory is passed.
        unsafe {
            for fd in fds {
                libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
            }
            let flags = libc::fcntl(fds[1], libc::F_GETFL);
            libc::fcntl(fds[1], libc::F_SETFL, flags | libc::O_NONBLOCK);
        }
        // SAFETY: the read end belongs to this process and is owned by `reader` from here on.
        let mut reader = unsafe { File::from_raw_fd(fds[0]) };
        WRITE_FD.store(fds[1], Ordering::SeqCst);
        std::thread::Builder::new().name("forkyard-signals".into()).spawn(move || {
            let mut byte = [0u8; 1];
            loop {
                match reader.read(&mut byte) {
                    Ok(1) => {
                        let name = SIGNALS.iter().find(|(s, _)| *s as u8 == byte[0]).map_or("signal", |(_, n)| *n);
                        if tx.send(name).is_err() {
                            return;
                        }
                    }
                    Ok(_) => return,
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(_) => return,
                }
            }
        })?;
        for (signal, _) in SIGNALS {
            // SAFETY: `sigaction` with zero-initialised structs this function owns; the handler
            // only does async-signal-safe work.
            unsafe {
                let mut previous: libc::sigaction = std::mem::zeroed();
                if libc::sigaction(signal, std::ptr::null(), &mut previous) == 0 && previous.sa_sigaction == libc::SIG_IGN {
                    continue;
                }
                let mut action: libc::sigaction = std::mem::zeroed();
                action.sa_sigaction = on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
                action.sa_flags = libc::SA_RESTART;
                libc::sigemptyset(&mut action.sa_mask);
                if libc::sigaction(signal, &action, std::ptr::null_mut()) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
        }
        Ok(())
    }
}

#[cfg(windows)]
mod platform {
    use std::sync::mpsc::Sender;
    use std::sync::OnceLock;
    use windows_sys::Win32::System::Console::{
        SetConsoleCtrlHandler, CTRL_BREAK_EVENT, CTRL_CLOSE_EVENT, CTRL_C_EVENT, CTRL_LOGOFF_EVENT, CTRL_SHUTDOWN_EVENT,
    };

    static SENDER: OnceLock<Sender<&'static str>> = OnceLock::new();

    /// Time the callback gets before the handler returns from a close, logoff or shutdown event
    /// (Windows ends the process then; for the close event at the latest after about 5 s).
    const GRACE_MS: u64 = 3_000;

    unsafe extern "system" fn on_console_event(kind: u32) -> windows_sys::core::BOOL {
        let reason = match kind {
            CTRL_C_EVENT => "Ctrl+C",
            CTRL_BREAK_EVENT => "Ctrl+Break",
            CTRL_CLOSE_EVENT => "console closed",
            CTRL_LOGOFF_EVENT => "logoff",
            CTRL_SHUTDOWN_EVENT => "shutdown",
            _ => return 0,
        };
        if let Some(tx) = SENDER.get() {
            let _ = tx.send(reason);
        }
        if matches!(kind, CTRL_CLOSE_EVENT | CTRL_LOGOFF_EVENT | CTRL_SHUTDOWN_EVENT) {
            std::thread::sleep(std::time::Duration::from_millis(GRACE_MS));
            super::super::global().clean_exit();
        }
        1
    }

    pub(super) fn install(tx: Sender<&'static str>) -> std::io::Result<()> {
        let _ = SENDER.set(tx);
        // SAFETY: registers a handler with the signature Windows expects; no memory is passed.
        if unsafe { SetConsoleCtrlHandler(Some(on_console_event), 1) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(())
    }
}

#[cfg(not(any(unix, windows)))]
mod platform {
    pub(super) fn install(_tx: std::sync::mpsc::Sender<&'static str>) -> std::io::Result<()> {
        Ok(())
    }
}
