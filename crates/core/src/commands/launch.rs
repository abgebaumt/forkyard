//! Launching from outside: a folder (and optionally a commit) as a start argument or as
//! `forkyard://open?path=…&commit=…`, and handing it over to an app that is already running.
//!
//! - `from_args` reads the process arguments. Paths are only checked (existing folder) and
//!   never executed; everything else is discarded.
//! - The first instance listens with `listen` on a local channel (127.0.0.1, random port;
//!   port and a random token are stored in `instance.json` in the data directory). A second
//!   instance with a start argument calls `forward` and exits once the first one has accepted
//!   the request.
//! - The UI picks up the request of its own launch with `app_launch_request`; anything that
//!   arrives later is reported by the event `app:open_request`.

use std::collections::HashSet;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

use crate::app::Core;
use crate::commands::window;
use crate::db;
use crate::error::CoreResult;
use crate::events::names;
use crate::git::rev;
use crate::model::{LaunchInvalid, LaunchRequest};
use crate::util;

/// Scheme of the links the app opens.
pub const URL_SCHEME: &str = "forkyard";
/// File in the data directory through which a second instance finds the first one.
pub const INSTANCE_FILE: &str = "instance.json";
/// Largest message on the local channel.
const MAX_MESSAGE: u64 = 64 * 1024;
const CONNECT_TIMEOUT: Duration = Duration::from_millis(400);
const REPLY_TIMEOUT: Duration = Duration::from_millis(2000);
/// Launch requests handled at once; more are dropped (a second instance sends one).
const MAX_CONNECTIONS: usize = 8;

#[derive(Default)]
struct LaunchInner {
    pending: Option<LaunchRequest>,
    /// Windows whose UI has asked for the launch request; from then on it listens for the event.
    attached: HashSet<String>,
}

/// Request waiting for the UI.
#[derive(Default)]
pub struct LaunchState {
    inner: Mutex<LaunchInner>,
}

#[derive(Debug, Serialize, Deserialize)]
struct InstanceFile {
    port: u16,
    token: String,
    pid: u32,
}

#[derive(Debug, Serialize, Deserialize)]
struct Message {
    token: String,
    path: String,
    commit: Option<String>,
    /// The request comes from a `forkyard://` link (see `LaunchRequest::from_link`).
    #[serde(default)]
    from_link: bool,
    /// Only bring the window forward; `path` is ignored.
    #[serde(default)]
    focus: bool,
}

// ---------------------------------------------------------------------------
// Reading arguments
// ---------------------------------------------------------------------------

/// Reads the start arguments (without the program name): `<path>`, `--commit <sha>`,
/// `--commit=<sha>` or a `forkyard://open?path=…&commit=…`. Relative paths are resolved against
/// `cwd`. `None` if no path is given; a path that does not exist yields a request with `invalid`
/// (see `validated`). Unknown switches are skipped.
pub fn from_args<I, S>(args: I, cwd: Option<&Path>) -> Option<LaunchRequest>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let args: Vec<OsString> = args.into_iter().map(Into::into).collect();
    let mut target: Option<String> = None;
    let mut commit: Option<String> = None;
    let mut index = 0;
    while index < args.len() {
        let Some(arg) = args[index].to_str() else {
            index += 1;
            continue;
        };
        if arg == "--commit" {
            commit = args.get(index + 1).and_then(|v| v.to_str()).map(str::to_string);
            index += 2;
            continue;
        }
        if let Some(value) = arg.strip_prefix("--commit=") {
            commit = Some(value.to_string());
        } else if !arg.starts_with('-') && target.is_none() && !arg.is_empty() {
            target = Some(arg.to_string());
        }
        index += 1;
    }
    let target = target?;
    if is_url(&target) {
        let (path, from_url) = parse_url(&target)?;
        return validated_link(&path, commit.or(from_url).as_deref());
    }
    validated(&target, commit.as_deref(), cwd)
}

/// Whether a path points to another machine or a device: `\\server\share`, `//server/…`,
/// `\\?\…`, `\\.\…`. Merely asking "does the folder exist?" makes Windows log in there with the
/// user's credentials.
fn is_network_or_device_path(path: &str) -> bool {
    let mut chars = path.trim_start().chars();
    matches!((chars.next(), chars.next()), (Some('\\' | '/'), Some('\\' | '/')))
}

/// Checks the request from a `forkyard://` link. A link can come from any web page: network and
/// device paths are rejected **before** the file system is asked, relative paths do not exist,
/// and the request carries `from_link` – the UI then asks before it opens a folder the user does
/// not have in the list yet.
pub fn validated_link(path: &str, commit: Option<&str>) -> Option<LaunchRequest> {
    let trimmed = path.trim();
    if is_network_or_device_path(trimmed) {
        if trimmed.contains('\0') {
            return None;
        }
        return Some(LaunchRequest {
            path: trimmed.to_string(),
            commit: None,
            invalid: Some(LaunchInvalid::PathNotAllowed),
            from_link: true,
        });
    }
    let mut request = validated(trimmed, commit, None)?;
    request.from_link = true;
    Some(request)
}

fn is_url(text: &str) -> bool {
    text.len() > URL_SCHEME.len() && text[..URL_SCHEME.len()].eq_ignore_ascii_case(URL_SCHEME) && text[URL_SCHEME.len()..].starts_with(':')
}

/// `forkyard://open?path=…&commit=…` → (path, commit). Only the action `open`.
fn parse_url(url: &str) -> Option<(String, Option<String>)> {
    let rest = &url[URL_SCHEME.len() + 1..];
    let rest = rest.trim_start_matches('/');
    let (action, query) = rest.split_once('?')?;
    if !action.trim_end_matches('/').eq_ignore_ascii_case("open") {
        return None;
    }
    let query = query.split('#').next().unwrap_or(query);
    let (mut path, mut commit) = (None, None);
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        match key {
            "path" => path = percent_decode(value),
            "commit" => commit = percent_decode(value),
            _ => {}
        }
    }
    Some((path.filter(|p| !p.is_empty())?, commit))
}

/// Decodes `%XX`; `None` on broken encoding or invalid UTF-8. A "+" stays a "+" (it occurs in
/// folder names).
fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = text.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Checks a request: the path is made absolute (never executed), the commit must be a SHA (4 to
/// 64 hex characters) – an invalid commit is dropped.
///
/// If the folder does not exist, the request is still delivered, with `invalid:
/// path_not_found` and without a commit: this way the UI can say what went wrong instead of
/// silently starting normally. `None` only if no path can be recognized at all (empty, a foreign
/// address, relative without a working directory).
pub fn validated(path: &str, commit: Option<&str>, cwd: Option<&Path>) -> Option<LaunchRequest> {
    let path = path.trim();
    if path.is_empty() || path.contains('\0') || path.contains("://") {
        return None;
    }
    let given = PathBuf::from(path);
    let full = if given.is_absolute() { given } else { cwd?.join(given) };
    let full = std::path::absolute(&full).ok()?;
    if !full.is_dir() {
        return Some(LaunchRequest {
            path: util::display_path(&full),
            commit: None,
            invalid: Some(LaunchInvalid::PathNotFound),
            from_link: false,
        });
    }
    let commit = commit.map(str::trim).filter(|sha| rev::is_sha_prefix(sha));
    Some(LaunchRequest { path: util::display_path(&full), commit: commit.map(str::to_ascii_lowercase), invalid: None, from_link: false })
}

/// Data directory as Tauri chooses it for `identifier` – for looking into `instance.json` before
/// the app itself is running.
pub fn default_data_dir(identifier: &str) -> Option<PathBuf> {
    dirs::data_dir().map(|dir| dir.join(identifier))
}

// ---------------------------------------------------------------------------
// Picking up and delivering
// ---------------------------------------------------------------------------

/// Stores the request of this process's own launch until the UI picks it up.
pub fn set_initial(core: &Core, request: Option<LaunchRequest>) {
    if let Some(request) = request {
        core.state::<LaunchState>().inner.lock().pending = Some(request);
    }
}

/// The request the app was launched with (or that has since come from a second instance) –
/// once, to the most recently focused window, or to any window while none was ever focused or
/// the focused one has already asked; `None` otherwise. Later requests arrive as the event
/// `app:open_request`.
pub async fn app_launch_request(core: &Core) -> CoreResult<Option<LaunchRequest>> {
    let caller = window::calling_window(core);
    let focused = core
        .db
        .with(|c| {
            let profile_id = db::profiles::active_id(c)?;
            db::windows::ever_focused(c, &profile_id)?.then(|| db::windows::fallback(c, &profile_id)).transpose()
        })
        // Better in any window than lost.
        .unwrap_or(None);
    let state = core.state::<LaunchState>();
    let mut inner = state.inner.lock();
    let takes = focused.as_ref().map_or(true, |f| *f == caller || inner.attached.contains(f));
    inner.attached.insert(caller);
    Ok(if takes { inner.pending.take() } else { None })
}

/// Hands a request to the UI: as an event to the most recently focused window once its UI has
/// asked for the launch request; until then it waits (the most recent one wins) for
/// `app_launch_request` or for `focused`.
pub fn deliver(core: &Core, request: LaunchRequest) {
    let target = window::last_focused(core);
    let state = core.state::<LaunchState>();
    {
        let mut inner = state.inner.lock();
        if !inner.attached.contains(&target) {
            inner.pending = Some(request);
            return;
        }
    }
    core.emit_to(&target, names::APP_OPEN_REQUEST, &request);
}

/// The window got the focus: a request still waiting goes to it once its UI listens.
pub fn focused(core: &Core, label: &str) {
    let state = core.state::<LaunchState>();
    let request = {
        let mut inner = state.inner.lock();
        if !inner.attached.contains(label) {
            return;
        }
        inner.pending.take()
    };
    if let Some(request) = request {
        core.emit_to(label, names::APP_OPEN_REQUEST, &request);
    }
}

/// The window is gone; a later window with the same label (`main`) has to ask again.
pub fn window_closed(core: &Core, label: &str) {
    core.state::<LaunchState>().inner.lock().attached.remove(label);
}

// ---------------------------------------------------------------------------
// Local channel between two instances
// ---------------------------------------------------------------------------

/// Opens this instance's local channel and writes `instance.json`. Runs until the core ends; an
/// error while opening is only logged (then there is simply no handover).
pub async fn listen(core: Core) {
    let Some((listener, port)) = util::bind_loopback("Local channel for launch requests").await else { return };
    let token = util::new_id();
    let file = InstanceFile { port, token: token.clone(), pid: std::process::id() };
    if let Err(e) = write_instance_file(core.data_dir(), &file) {
        log::warn!("{INSTANCE_FILE} not written: {e}");
        return;
    }
    // Never shut down: the channel lives as long as the core.
    let forever = tokio::sync::Notify::new();
    util::serve_loopback(listener, MAX_CONNECTIONS, &forever, |stream| {
        let (core, token) = (core.clone(), token.clone());
        Some(async move {
            let _ = tokio::time::timeout(REPLY_TIMEOUT, serve(&core, &token, stream)).await;
        })
    })
    .await;
}

async fn serve(core: &Core, token: &str, stream: tokio::net::TcpStream) {
    let (read, mut write) = stream.into_split();
    let mut line = String::new();
    let mut reader = tokio::io::BufReader::new(tokio::io::AsyncReadExt::take(read, MAX_MESSAGE));
    let accepted = match reader.read_line(&mut line).await {
        Ok(n) if n > 0 => accept(core, token, &line),
        _ => false,
    };
    let _ = write.write_all(if accepted { b"ok\n" } else { b"no\n" }).await;
    let _ = write.shutdown().await;
}

/// Checks a message (token, path) and delivers the request.
fn accept(core: &Core, token: &str, line: &str) -> bool {
    let Ok(message) = serde_json::from_str::<Message>(line.trim()) else { return false };
    if !util::constant_time_eq(message.token.as_bytes(), token.as_bytes()) {
        return false;
    }
    if message.focus {
        core.emit_to(&window::last_focused(core), names::APP_FOCUS_REQUEST, &serde_json::Value::Null);
        return true;
    }
    // Check again: the message comes from outside this process. A request from a link stays a
    // request from a link (with its stricter rules).
    let request = if message.from_link {
        validated_link(&message.path, message.commit.as_deref())
    } else {
        validated(&message.path, message.commit.as_deref(), None)
    };
    let Some(request) = request else { return false };
    deliver(core, request);
    true
}

fn write_instance_file(data_dir: &Path, file: &InstanceFile) -> std::io::Result<()> {
    let path = data_dir.join(INSTANCE_FILE);
    let text = serde_json::to_string(file).map_err(std::io::Error::other)?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(&path)?.write_all(text.as_bytes())?;
    // A file left behind by an earlier run also belongs only to the current user.
    util::restrict_to_owner(&path)
}

/// Removes `instance.json` on exit – only if it comes from this process (a second instance with
/// the same data directory may have overwritten it in the meantime).
pub fn remove_instance_file(data_dir: &Path) {
    let path = data_dir.join(INSTANCE_FILE);
    let own = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<InstanceFile>(&text).ok())
        .is_some_and(|file| file.pid == std::process::id());
    if own {
        let _ = std::fs::remove_file(&path);
    }
}

/// Second instance: hands the request to the running app with this data directory. `true` if it
/// accepted it (then the caller can exit); `false` if none is running or it does not answer.
/// Blocks for a few seconds at most.
pub fn forward(data_dir: &Path, request: &LaunchRequest) -> bool {
    send(data_dir, |token| Message {
        token,
        path: request.path.clone(),
        commit: request.commit.clone(),
        from_link: request.from_link,
        focus: false,
    })
}

/// Second instance without arguments: asks the running app to bring its window forward.
pub fn forward_focus(data_dir: &Path) -> bool {
    send(data_dir, |token| Message { token, path: String::new(), commit: None, from_link: false, focus: true })
}

fn send(data_dir: &Path, message: impl FnOnce(String) -> Message) -> bool {
    let Ok(text) = std::fs::read_to_string(data_dir.join(INSTANCE_FILE)) else { return false };
    let Ok(file) = serde_json::from_str::<InstanceFile>(&text) else { return false };
    if file.pid == std::process::id() {
        return false;
    }
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, file.port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT) else { return false };
    let _ = stream.set_read_timeout(Some(REPLY_TIMEOUT));
    let _ = stream.set_write_timeout(Some(REPLY_TIMEOUT));
    let Ok(mut line) = serde_json::to_string(&message(file.token)) else { return false };
    line.push('\n');
    if stream.write_all(line.as_bytes()).is_err() {
        return false;
    }
    let mut reply = String::new();
    if BufReader::new(stream).read_line(&mut reply).is_err() {
        return false;
    }
    reply.trim() == "ok"
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::TestCore;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    fn encode(text: &str) -> String {
        text.bytes()
            .map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
            .collect()
    }

    #[test]
    fn reads_path_and_commit_from_arguments() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("mein projekt ü");
        std::fs::create_dir_all(&repo).unwrap();
        let shown = util::display_path(&std::path::absolute(&repo).unwrap());
        let text = repo.to_string_lossy().into_owned();

        let request = from_args(args(&[&text]), None).unwrap();
        assert_eq!(request, LaunchRequest { path: shown.clone(), commit: None, invalid: None, from_link: false });
        let request = from_args(args(&[&text, "--commit", "ABCDEF12"]), None).unwrap();
        assert_eq!(request.commit.as_deref(), Some("abcdef12"));
        let request = from_args(args(&["--commit=0123abcd", "--unbekannt", &text]), None).unwrap();
        assert_eq!((request.path.as_str(), request.commit.as_deref()), (shown.as_str(), Some("0123abcd")));
        // Relative to the caller's working directory.
        let request = from_args(args(&["mein projekt ü"]), Some(dir.path())).unwrap();
        assert_eq!(request.path, shown);
        // An invalid commit is dropped, the folder stays.
        let request = from_args(args(&[&text, "--commit", "HEAD; rm -rf /"]), None).unwrap();
        assert_eq!(request.commit, None);
    }

    #[test]
    fn missing_folders_are_reported_and_everything_else_is_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("datei.txt");
        std::fs::write(&file, "x").unwrap();
        assert_eq!(from_args(args(&[]), None), None);
        assert_eq!(from_args(args(&["--commit", "abcdef12"]), None), None);
        // A path that does not exist (or is not a folder) is delivered with a reason – without a commit.
        let missing = dir.path().join("fehlt");
        let shown = util::display_path(&std::path::absolute(&missing).unwrap());
        let gone = from_args(args(&[&missing.to_string_lossy(), "--commit", "abcdef12"]), None).unwrap();
        assert_eq!(gone, LaunchRequest { path: shown, commit: None, invalid: Some(LaunchInvalid::PathNotFound), from_link: false });
        assert_eq!(serde_json::to_value(&gone).unwrap()["invalid"], "path_not_found");
        let a_file = from_args(args(&[&file.to_string_lossy()]), None).unwrap();
        assert_eq!(a_file.invalid, Some(LaunchInvalid::PathNotFound), "a file is not a folder");
        let encoded_missing = encode(&missing.to_string_lossy());
        assert_eq!(
            from_args(args(&[&format!("forkyard://open?path={encoded_missing}")]), None).unwrap().invalid,
            Some(LaunchInvalid::PathNotFound)
        );
        assert_eq!(from_args(args(&["relativ"]), None), None, "relative without a working directory");
        assert_eq!(from_args(args(&["https://example.com/x"]), Some(dir.path())), None);
        assert_eq!(from_args(args(&["forkyard://run?path=x"]), Some(dir.path())), None, "only the action open");
        assert_eq!(from_args(args(&["forkyard://open"]), Some(dir.path())), None);
        assert_eq!(from_args(args(&["forkyard://open?path=%ZZ"]), Some(dir.path())), None);
        assert_eq!(from_args(args(&["forkyard://open?path="]), Some(dir.path())), None);
    }

    #[test]
    fn reads_the_url_scheme() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("a+b c");
        std::fs::create_dir_all(&repo).unwrap();
        let shown = util::display_path(&std::path::absolute(&repo).unwrap());
        let encoded = encode(&repo.to_string_lossy());

        let request = from_args(args(&[&format!("forkyard://open?path={encoded}&commit=deadbeef")]), None).unwrap();
        assert_eq!(request, LaunchRequest { path: shown.clone(), commit: Some("deadbeef".into()), invalid: None, from_link: true });
        // A request from a link tells the UI so (it then asks the user).
        assert_eq!(serde_json::to_value(&request).unwrap()["fromLink"], true);
        assert!(serde_json::to_value(from_args(args(&[&repo.to_string_lossy()]), None).unwrap()).unwrap().get("fromLink").is_none());
        // Links have no relative paths – not even with a working directory.
        assert_eq!(from_args(args(&["forkyard://open?path=a%2Bb%20c"]), Some(dir.path())), None);
        let request = from_args(args(&[&format!("Forkyard://open/?commit=deadbeef&path={encoded}&x=1#teil")]), None).unwrap();
        assert_eq!(request.path, shown);
        let request = from_args(args(&[&format!("forkyard:open?path={encoded}")]), None).unwrap();
        assert_eq!(request.commit, None);
        // `--commit` on the command line takes precedence.
        let request = from_args(args(&[&format!("forkyard://open?path={encoded}&commit=deadbeef"), "--commit", "cafe1234"]), None).unwrap();
        assert_eq!(request.commit.as_deref(), Some("cafe1234"));
    }

    /// A link from outside must never touch a network or device path (on Windows the machine
    /// would log in to the foreign server with the user's credentials).
    #[test]
    fn sec02_links_never_touch_network_or_device_paths() {
        for hostile in [
            r"\\127.0.0.1\forkyard-gibt-es-nicht\repo",
            "//127.0.0.1/forkyard-gibt-es-nicht/repo",
            r"\\?\C:\Windows",
            r"\\.\C:\Windows",
            r"\\?\UNC\127.0.0.1\c$\x",
        ] {
            let link = format!("forkyard://open?path={}", encode(hostile));
            let request = from_args(args(&[&link]), None);
            let refused = request.as_ref().is_none_or(|r| r.invalid.is_some() && r.invalid != Some(LaunchInvalid::PathNotFound));
            assert!(refused, "{hostile}: {request:?}");
            let request = request.unwrap();
            assert_eq!(
                (request.invalid, request.from_link, request.commit.clone()),
                (Some(LaunchInvalid::PathNotAllowed), true, None),
                "{hostile}"
            );
            assert_eq!(serde_json::to_value(&request).unwrap()["invalid"], "path_not_allowed");
        }
        assert!(
            is_network_or_device_path(r"\\server\x") && is_network_or_device_path("//server/x") && is_network_or_device_path(r"/\server\x")
        );
        assert!(
            !is_network_or_device_path(r"C:\repo")
                && !is_network_or_device_path("/home/anna/repo")
                && !is_network_or_device_path("relativ")
        );
    }

    #[test]
    fn instance_file_is_removed_only_by_its_own_process() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(INSTANCE_FILE);
        write_instance_file(dir.path(), &InstanceFile { port: 1, token: "t".into(), pid: std::process::id().wrapping_add(1) }).unwrap();
        remove_instance_file(dir.path());
        assert!(path.exists(), "the file of another instance stays");
        write_instance_file(dir.path(), &InstanceFile { port: 1, token: "t".into(), pid: std::process::id() }).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        remove_instance_file(dir.path());
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn initial_request_is_handed_out_once_and_later_ones_become_events() {
        let tc = TestCore::new().await;
        let dir = tempfile::tempdir().unwrap();
        let first = validated(&dir.path().to_string_lossy(), Some("abcd1234"), None).unwrap();
        set_initial(&tc, Some(first.clone()));
        assert_eq!(app_launch_request(&tc).await.unwrap(), Some(first.clone()));
        assert_eq!(app_launch_request(&tc).await.unwrap(), None);
        tc.events.clear();
        deliver(&tc, first.clone());
        let events = tc.events.named(names::APP_OPEN_REQUEST);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0], serde_json::json!({ "path": first.path, "commit": "abcd1234" }));
        assert_eq!(app_launch_request(&tc).await.unwrap(), None, "delivered as an event, not twice");
    }

    const W: &str = "w-0123456789abcdef0123456789abcdef";

    fn add_focused_window(tc: &TestCore) {
        tc.db.tx(|tx| crate::db::windows::insert(tx, &crate::db::profiles::active_id(tx)?, W, None)).unwrap();
        crate::commands::window::note_focus(tc, W);
    }

    #[tokio::test]
    async fn external_requests_go_to_the_last_focused_window() {
        let tc = TestCore::new().await;
        add_focused_window(&tc);
        let dir = tempfile::tempdir().unwrap();
        let initial = validated(&dir.path().to_string_lossy(), Some("abcd1234"), None).unwrap();
        set_initial(&tc, Some(initial.clone()));
        assert_eq!(crate::windowing::scoped("main".into(), app_launch_request(&tc)).await.unwrap(), None, "not the focused window");
        assert_eq!(crate::windowing::scoped(W.into(), app_launch_request(&tc)).await.unwrap(), Some(initial));

        let later = validated(&dir.path().to_string_lossy(), None, None).unwrap();
        deliver(&tc, later.clone());
        assert_eq!(tc.events.targeted(names::APP_OPEN_REQUEST), vec![(W.to_string(), serde_json::to_value(&later).unwrap())]);
    }

    /// Each window's UI asks once. A request must not get lost when the focus moves in between.
    #[tokio::test]
    async fn a_waiting_request_follows_the_focus() {
        let tc = TestCore::new().await;
        add_focused_window(&tc);
        let dir = tempfile::tempdir().unwrap();
        let request = validated(&dir.path().to_string_lossy(), None, None).unwrap();
        set_initial(&tc, Some(request.clone()));
        assert_eq!(crate::windowing::scoped("main".into(), app_launch_request(&tc)).await.unwrap(), None);
        crate::commands::window::note_focus(&tc, "main");
        assert_eq!(crate::windowing::scoped(W.into(), app_launch_request(&tc)).await.unwrap(), None);
        assert_eq!(tc.events.targeted(names::APP_OPEN_REQUEST), vec![("main".to_string(), serde_json::to_value(&request).unwrap())]);

        // The focused window has already asked: the next one to ask takes it.
        set_initial(&tc, Some(request.clone()));
        assert_eq!(crate::windowing::scoped(W.into(), app_launch_request(&tc)).await.unwrap(), Some(request.clone()));

        // A window whose UI has not asked yet does not get events; the request waits for it.
        tc.events.clear();
        let fresh = "w-ffffffffffffffffffffffffffffffff";
        tc.db.tx(|tx| crate::db::windows::insert(tx, &crate::db::profiles::active_id(tx)?, fresh, None)).unwrap();
        crate::commands::window::note_focus(&tc, fresh);
        deliver(&tc, request.clone());
        assert!(tc.events.named(names::APP_OPEN_REQUEST).is_empty());
        assert_eq!(crate::windowing::scoped(fresh.into(), app_launch_request(&tc)).await.unwrap(), Some(request));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn second_instance_forwards_over_the_local_channel() {
        let tc = TestCore::new().await;
        let dir = tempfile::tempdir().unwrap();
        let request = validated(&dir.path().to_string_lossy(), None, None).unwrap();
        let data_dir = tc.data_dir().to_path_buf();
        assert!(!forward(&data_dir, &request), "without a running instance");

        let server = tokio::spawn(listen(tc.core.clone()));
        let file = data_dir.join(INSTANCE_FILE);
        for _ in 0..200 {
            if file.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let mut info: InstanceFile = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        // `forward` refuses to send to its own process; the test pretends to be another one.
        info.pid = info.pid.wrapping_add(1);
        std::fs::write(&file, serde_json::to_string(&info).unwrap()).unwrap();

        // Before pickup: the request waits.
        let (dir_a, req_a) = (data_dir.clone(), request.clone());
        assert!(tokio::task::spawn_blocking(move || forward(&dir_a, &req_a)).await.unwrap());
        assert!(tc.events.named(names::APP_OPEN_REQUEST).is_empty());
        assert_eq!(app_launch_request(&tc).await.unwrap(), Some(request.clone()));

        // Afterwards: as an event.
        let (dir_b, req_b) = (data_dir.clone(), request.clone());
        assert!(tokio::task::spawn_blocking(move || forward(&dir_b, &req_b)).await.unwrap());
        assert_eq!(tc.events.named(names::APP_OPEN_REQUEST).len(), 1);

        // A path that does not exist arrives with a reason (the UI explains it).
        let gone = LaunchRequest {
            path: util::display_path(&dir.path().join("fehlt")),
            commit: None,
            invalid: Some(LaunchInvalid::PathNotFound),
            from_link: false,
        };
        let (dir_c, req_c) = (data_dir.clone(), gone.clone());
        assert!(tokio::task::spawn_blocking(move || forward(&dir_c, &req_c)).await.unwrap());
        let events = tc.events.named(names::APP_OPEN_REQUEST);
        assert_eq!(events.len(), 2);
        assert_eq!(events[1], serde_json::json!({ "path": gone.path, "commit": null, "invalid": "path_not_found" }));
        // A request from a link stays a request from a link on its way to the first instance –
        // and a network path in it is not touched there either.
        let linked = LaunchRequest { from_link: true, ..request.clone() };
        let (dir_l, req_l) = (data_dir.clone(), linked.clone());
        assert!(tokio::task::spawn_blocking(move || forward(&dir_l, &req_l)).await.unwrap());
        assert_eq!(tc.events.named(names::APP_OPEN_REQUEST)[2]["fromLink"], true);
        let remote = LaunchRequest { path: r"\\127.0.0.1\forkyard-gibt-es-nicht\x".into(), commit: None, invalid: None, from_link: true };
        let (dir_r, req_r) = (data_dir.clone(), remote);
        assert!(tokio::task::spawn_blocking(move || forward(&dir_r, &req_r)).await.unwrap());
        assert_eq!(tc.events.named(names::APP_OPEN_REQUEST)[3]["invalid"], "path_not_allowed");
        tc.events.clear();
        deliver(&tc, request.clone());
        // A wrong token is rejected.
        info.token = "falsch".into();
        std::fs::write(&file, serde_json::to_string(&info).unwrap()).unwrap();
        let (dir_d, req_d) = (data_dir.clone(), request.clone());
        assert!(!tokio::task::spawn_blocking(move || forward(&dir_d, &req_d)).await.unwrap());
        assert_eq!(tc.events.named(names::APP_OPEN_REQUEST).len(), 1);
        server.abort();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_focus_request_with_the_token_is_accepted_and_emitted() {
        let tc = TestCore::new().await;
        add_focused_window(&tc);
        let data_dir = tc.data_dir().to_path_buf();
        let server = tokio::spawn(listen(tc.core.clone()));
        let file = data_dir.join(INSTANCE_FILE);
        for _ in 0..200 {
            if file.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let mut info: InstanceFile = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        // `send` refuses to talk to its own process; the test pretends to be another one.
        info.pid = info.pid.wrapping_add(1);
        std::fs::write(&file, serde_json::to_string(&info).unwrap()).unwrap();

        let dir_a = data_dir.clone();
        assert!(tokio::task::spawn_blocking(move || forward_focus(&dir_a)).await.unwrap());
        assert_eq!(tc.events.targeted(names::APP_FOCUS_REQUEST), vec![(W.to_string(), serde_json::Value::Null)]);

        info.token = "falsch".into();
        std::fs::write(&file, serde_json::to_string(&info).unwrap()).unwrap();
        assert!(!tokio::task::spawn_blocking(move || forward_focus(&data_dir)).await.unwrap());
        assert_eq!(tc.events.named(names::APP_FOCUS_REQUEST).len(), 1);
        server.abort();
    }
}
