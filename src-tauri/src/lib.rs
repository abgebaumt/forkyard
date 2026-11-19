//! Thin Tauri binding: creates the core, forwards its events to the window and
//! registers the commands from src/core/api.ts. All logic lives in `gitcore`.

mod commands;

use std::path::PathBuf;
use std::sync::Arc;

use gitcore::{Core, CoreConfig, EventSink};
use tauri::{AppHandle, Emitter, Manager};

/// Overrides the data directory (for tests with several instances).
const DATA_DIR_ENV: &str = "FORKYARD_DATA_DIR";
/// Fixed path to Git instead of searching; a path that does not exist yields the “Git missing” state.
const GIT_PATH_ENV: &str = "FORKYARD_GIT_PATH";
/// Development build only: a different address for the Vite server (the E2E driver has its own port).
const DEV_URL_ENV: &str = "FORKYARD_DEV_URL";
/// Development build only, set by the E2E driver: `hidden` does not show the window, so test runs
/// don't disturb work on the machine (the WebView still renders, the driver sets the switches for
/// that); `visible` shows it. When the variable is set, the WebView behaves as in a release build
/// (no browser shortcuts).
const E2E_WINDOW_ENV: &str = "FORKYARD_E2E_WINDOW";
/// Development build only: inner window size in PHYSICAL pixels, e.g. `1440x900`. The E2E driver
/// starts the WebView with scale factor 1, so these are CSS pixels as well – the same on every
/// screen. The minimum size from tauri.conf.json then also applies in physical pixels.
const WINDOW_SIZE_ENV: &str = "FORKYARD_WINDOW_SIZE";
/// A different service name in the OS keychain (default `forkyard`). The E2E driver sets it so
/// test runs don't mix their tokens and passwords into the user's real entries.
const KEYRING_SERVICE_ENV: &str = "FORKYARD_KEYRING_SERVICE";
/// Development build only: a different avatar service; `off` disables the lookup (E2E, screenshots).
const AVATAR_URL_ENV: &str = "FORKYARD_AVATAR_URL";
/// Development build only: a different address for the update check instead of api.github.com;
/// `off` turns it off (E2E, screenshots).
const UPDATE_URL_ENV: &str = "FORKYARD_UPDATE_URL";
/// Development build only: search the AI command-line tools only in this folder – no PATH, no login
/// shell (E2E with the fake tool target/debug/forkyard-fake-cli).
const AI_CLI_DIR_ENV: &str = "FORKYARD_AI_CLI_DIR";
const MAIN_WINDOW: &str = "main";
/// WebKitGTK's switch for its timer-based vblank instead of watching the display through DRM.
#[cfg(target_os = "linux")]
const VBLANK_TIMER_ENV: &str = "WEBKIT_FORCE_VBLANK_TIMER";

/// Linux with more than one GPU (a laptop with an integrated GPU and an NVIDIA/AMD one): WebKitGTK
/// watches the display's vblank through DRM and, when the WebView loads its page, opens every GPU's
/// DRM card and asks it for its connectors. A GPU that is powered down (runtime power management)
/// wakes up for that – about 3 s in which the window does not appear, on every start once the GPU
/// went back to sleep, and it then stays awake. With several GPUs WebKit's timer-based vblank is used
/// instead (`WEBKIT_FORCE_VBLANK_TIMER`); a value set by the user is kept. Must run before GTK and
/// WebKit start (first thing in `run`, while the process has no other threads).
#[cfg(target_os = "linux")]
fn avoid_waking_idle_gpus() -> Option<usize> {
    if std::env::var_os(VBLANK_TIMER_ENV).is_some() {
        return None;
    }
    let gpus = drm_gpu_count(std::path::Path::new("/sys/class/drm"));
    if gpus < 2 {
        return None;
    }
    std::env::set_var(VBLANK_TIMER_ENV, "1");
    Some(gpus)
}

/// GPUs with a DRM card in `dir` (`/sys/class/drm`): `card<N>` entries whose device has a PCI vendor.
/// Connectors (`card1-eDP-1`) and firmware framebuffers (`simple-framebuffer`, no vendor) don't count.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn drm_gpu_count(dir: &std::path::Path) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    entries
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .and_then(|name| name.strip_prefix("card"))
                .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
        })
        .filter(|entry| entry.path().join("device").join("vendor").is_file())
        .count()
}

fn env_value(name: &str) -> Option<std::ffi::OsString> {
    std::env::var_os(name).filter(|v| !v.is_empty())
}

/// Whether the development and test overrides apply: only when Tauri runs in development mode
/// AND the program is a debug build.
///
/// `tauri::is_dev()` alone only says that the UI is not embedded (the `custom-protocol` feature
/// is missing) – which is also true for a `cargo build --release` without the Tauri CLI. Such a
/// program would load the UI from a local port and could be redirected via environment
/// variables; `run` therefore aborts there (`is_unbundled_release`).
fn dev_mode() -> bool {
    dev_switches_allowed(tauri::is_dev(), cfg!(debug_assertions))
}

fn dev_switches_allowed(tauri_dev: bool, debug_build: bool) -> bool {
    tauri_dev && debug_build
}

/// An optimised program without the embedded UI: produced by `cargo build --release` instead of
/// `tauri build`, and must not run like that.
fn is_unbundled_release(tauri_dev: bool, debug_build: bool) -> bool {
    tauri_dev && !debug_build
}

/// Environment variable that is only honoured in development mode.
fn dev_env_value(name: &str) -> Option<std::ffi::OsString> {
    if dev_mode() {
        env_value(name)
    } else {
        None
    }
}

/// Whether the window may navigate to this address: only to its own UI. Everything else (a link in
/// foreign content, a dropped file, a redirect) is rejected – the app opens external links
/// exclusively through the system browser.
fn navigation_allowed(url: &tauri::Url, dev_url: Option<&tauri::Url>) -> bool {
    match url.scheme() {
        // Embedded UI: macOS/Linux `tauri://localhost`, Windows `http(s)://tauri.localhost`.
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" if url.host_str() == Some("tauri.localhost") => true,
        "about" => url.as_str() == "about:blank",
        // Development mode: exactly the origin of the Vite server.
        _ => dev_url.is_some_and(|dev| {
            dev.scheme() == url.scheme() && dev.host_str() == url.host_str() && dev.port_or_known_default() == url.port_or_known_default()
        }),
    }
}

fn navigation_guard<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("navigation-guard")
        .on_navigation(|webview, url| {
            let dev_url = if dev_mode() { webview.app_handle().config().build.dev_url.clone() } else { None };
            let allowed = navigation_allowed(url, dev_url.as_ref());
            if !allowed {
                log::warn!("Window navigation rejected: {}://{}", url.scheme(), url.host_str().unwrap_or(""));
            }
            allowed
        })
        .build()
}

/// Sends core events to all windows; names exactly as `CoreEvents` in types.ts.
struct WindowSink {
    app: AppHandle,
}

impl EventSink for WindowSink {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        // An external request brings the window to the front – not under the E2E driver.
        if matches!(event, gitcore::events::names::APP_OPEN_REQUEST | gitcore::events::names::APP_FOCUS_REQUEST)
            && dev_env_value(E2E_WINDOW_ENV).is_none()
        {
            if let Some(window) = self.app.get_webview_window(MAIN_WINDOW) {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }
        if let Err(e) = self.app.emit(event, payload) {
            log::warn!("Event {event} not delivered: {e}");
        }
    }
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, Box<dyn std::error::Error>> {
    match env_value(DATA_DIR_ENV) {
        Some(dir) => Ok(PathBuf::from(dir)),
        None => Ok(app.path().app_data_dir()?),
    }
}

fn setup(app: &mut tauri::App, launch: Option<gitcore::model::LaunchRequest>) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let data_dir = data_dir(&handle)?;
    let version = app.package_info().version.to_string();
    let crash = gitcore::crash::global().attach(&data_dir, &version);
    if let Some(id) = &crash.unexpected_report {
        log::warn!("The previous run ended without shutting down; report {id}");
    }
    if !crash.owns_marker {
        log::info!("Another instance uses this data directory; it keeps the crash marker");
    }
    log::info!("Forkyard {version} on {} {}", std::env::consts::OS, std::env::consts::ARCH);
    let mut config = CoreConfig::new(data_dir, version, Arc::new(WindowSink { app: handle }));
    config.git_path = env_value(GIT_PATH_ENV).map(PathBuf::from);
    config.keyring_service = dev_env_value(KEYRING_SERVICE_ENV).and_then(|v| v.into_string().ok());
    let core = gitcore::startup::timed("core open", || tauri::async_runtime::block_on(Core::open(config)))?;
    if let Some(base) = dev_env_value(AVATAR_URL_ENV).and_then(|v| v.into_string().ok()) {
        gitcore::commands::avatars::configure(&core, Some(if base == "off" { String::new() } else { base }));
    }
    if let Some(base) = dev_env_value(UPDATE_URL_ENV).and_then(|v| v.into_string().ok()) {
        gitcore::commands::update::configure(&core, Some(if base == "off" { String::new() } else { base }));
    }
    // Development build only: AI providers at local mock addresses (`FORKYARD_AI_BASE_URL_<PROVIDER>`).
    for (kind, name) in gitcore::ai::BASE_URL_ENVS {
        if let Some(base) = dev_env_value(name).and_then(|v| v.into_string().ok()) {
            gitcore::ai::configure_base(&core, kind, Some(base));
        }
    }
    if let Some(dir) = dev_env_value(AI_CLI_DIR_ENV) {
        gitcore::ai::cli::configure_dir(&core, Some(PathBuf::from(dir)));
    }
    // This launch's request waits for the UI; later ones arrive over the local channel.
    gitcore::commands::launch::set_initial(&core, launch);
    tauri::async_runtime::spawn(gitcore::commands::launch::listen(core.clone()));
    app.manage(core.clone());
    // SIGTERM, Ctrl+C, the console closing …: end like quitting, not as a crash.
    let quit_handle = app.handle().clone();
    if let Err(e) = gitcore::crash::install_termination_handler(move |reason| end_on_request(&quit_handle, reason)) {
        log::warn!("Requests to end the app are not handled: {e}");
    }
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let under_test = dev_env_value(E2E_WINDOW_ENV).is_some();
        // In the development build F5 and F12 keep working – except under the E2E driver.
        if !dev_mode() || under_test {
            disable_browser_keys(&window);
        }
        if dev_mode() {
            prepare_test_window(app, &window);
        }
    }
    tauri::async_runtime::spawn(async move {
        gitcore::startup::reached("setup done");
        // File watching and auto-fetch for the tabs of the last session.
        gitcore::startup::timed_async("file watching and auto-fetch for the open tabs", async {
            if let Ok(tabs) = gitcore::commands::repos::tabs_list(&core).await {
                for repo_id in tabs.into_iter().filter_map(|t| t.repo_id) {
                    gitcore::commands::repos::start_background(&core, &repo_id);
                }
            }
        })
        .await;
        if let Err(e) = gitcore::startup::timed_async("cleanup", core.startup_cleanup()).await {
            log::warn!("Startup cleanup failed: {}", e.message);
        }
        // the login shell's PATH once per start, so the AI setup does not wait for it.
        gitcore::startup::timed_async("login shell PATH", gitcore::ai::detect::warm_up(&core)).await;
    });
    Ok(())
}

/// Disables the shortcuts with which the WebView itself would do something: find in page
/// (Ctrl+F, F3), print (Ctrl+P), reload (F5, Ctrl+R), zoom (Ctrl+Plus/Minus), developer tools,
/// back/forward. Text editing (Ctrl+C/V/X/A/Z) stays. The keys still reach the UI as `keydown` –
/// so its own commands on Ctrl+F, Ctrl+P etc. keep working.
/// On Linux and macOS the UI intercepts these keys itself (src/app/webviewGuards.ts).
#[cfg(windows)]
fn disable_browser_keys(window: &tauri::WebviewWindow) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows_core::Interface;

    let result = window.with_webview(|webview| {
        // SAFETY: calls into the WebView2 COM interface on the thread it lives on
        // (`with_webview` runs on the main thread); the objects belong to the running WebView.
        let outcome = unsafe {
            webview
                .controller()
                .CoreWebView2()
                .and_then(|core| core.Settings())
                .and_then(|settings| settings.cast::<ICoreWebView2Settings3>())
                .and_then(|settings| settings.SetAreBrowserAcceleratorKeysEnabled(false))
        };
        if let Err(e) = outcome {
            log::warn!("Could not disable the WebView's browser shortcuts: {e}");
        }
    });
    if let Err(e) = result {
        log::warn!("No access to the WebView: {e}");
    }
}

#[cfg(not(windows))]
fn disable_browser_keys(_window: &tauri::WebviewWindow) {}

fn parse_size(text: &str) -> Option<(u32, u32)> {
    let (width, height) = text.trim().split_once(['x', 'X'])?;
    let (width, height) = (width.parse().ok()?, height.parse().ok()?);
    (width > 0 && height > 0).then_some((width, height))
}

/// Development build: window size from the environment, and the UI may set the size itself
/// (`plugin:window|set_size`) – that is how the E2E driver sizes the real window.
fn prepare_test_window(app: &tauri::App, window: &tauri::WebviewWindow) {
    let capability = tauri::ipc::CapabilityBuilder::new("dev-window-size")
        .window(MAIN_WINDOW)
        .permission("core:window:allow-set-size")
        .permission("core:window:allow-set-min-size");
    if let Err(e) = app.add_capability(capability) {
        eprintln!("Could not grant the window-size permissions for tests: {e}");
    }
    let Some(text) = env_value(WINDOW_SIZE_ENV).and_then(|v| v.into_string().ok()) else {
        return;
    };
    let Some((width, height)) = parse_size(&text) else {
        eprintln!("{WINDOW_SIZE_ENV} expects WIDTHxHEIGHT, e.g. 1440x900 (was: {text}).");
        return;
    };
    let minimum = app.config().app.windows.iter().find(|w| w.label == MAIN_WINDOW).and_then(|w| Some((w.min_width?, w.min_height?)));
    let outcome = match minimum {
        Some((min_width, min_height)) => window.set_min_size(Some(tauri::PhysicalSize::new(min_width as u32, min_height as u32))),
        None => Ok(()),
    }
    .and_then(|()| window.set_size(tauri::PhysicalSize::new(width, height)));
    if let Err(e) = outcome {
        eprintln!("Could not set window size {text}: {e}");
    }
}

/// The embedded context; in the development build the address and window can be changed for tests.
fn context() -> tauri::Context {
    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    if dev_mode() {
        let config = context.config_mut();
        if let Some(url) = env_value(DEV_URL_ENV).and_then(|v| v.into_string().ok()) {
            match url.parse() {
                Ok(url) => config.build.dev_url = Some(url),
                Err(e) => eprintln!("{DEV_URL_ENV} is not a valid address ({e}); keeping the built-in one."),
            }
        }
        if env_value(E2E_WINDOW_ENV).is_some_and(|v| v == "hidden") {
            for window in &mut config.app.windows {
                window.visible = false;
                window.focus = false;
                window.skip_taskbar = true;
            }
        }
    }
    context
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Closing the window (×, Alt+F4, logging off): if the UI has reported that something would be
/// lost, the window does not close and the UI asks instead. Otherwise the running actions are
/// cancelled first (no Git process keeps running without the app, a half-finished clone is
/// cleaned up), then the window closes.
fn on_window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    let tauri::WindowEvent::CloseRequested { api, .. } = event else { return };
    let Some(core) = window.try_state::<Core>() else { return };
    let core: Core = (*core).clone();
    let guard = core.state::<gitcore::commands::app::CloseGuard>();
    if guard.intercept(window.label()) {
        api.prevent_close();
        core.events.emit(gitcore::events::names::APP_CLOSE_REQUESTED, serde_json::json!({}));
        return;
    }
    if core.jobs.running() == 0 || guard.quitting() {
        return;
    }
    // Something is still running: hide immediately, clean up, then really close.
    api.prevent_close();
    let window = window.clone();
    let _ = window.hide();
    tauri::async_runtime::spawn(async move {
        let _ = gitcore::commands::app::app_quit(&core).await;
        let _ = window.close();
    });
}

/// The last steps of every orderly end (quitting, closing the window, a termination request).
fn finish_exit(handle: &tauri::AppHandle) {
    if let Some(core) = handle.try_state::<Core>() {
        gitcore::commands::terminal::close_all(&core);
        // Port and password of the local channel are only valid while the app is running.
        gitcore::commands::launch::remove_instance_file(core.data_dir());
    }
    // Last: from here on, ending is not a crash.
    gitcore::crash::global().clean_exit();
}

/// The app is asked to end from outside (SIGTERM, SIGINT, SIGHUP, console events; see
/// `gitcore::crash::install_termination_handler`): the same path as quitting – running actions
/// are cancelled, then the event loop ends with `RunEvent::Exit` (`finish_exit`). Should it not
/// get there in time, the steps of `finish_exit` run here and the process ends.
fn end_on_request(handle: &tauri::AppHandle, reason: &str) {
    if let Some(core) = handle.try_state::<Core>() {
        let core: Core = (*core).clone();
        tauri::async_runtime::block_on(async move {
            let _ = gitcore::commands::app::app_quit(&core).await;
        });
    }
    handle.exit(0);
    std::thread::sleep(std::time::Duration::from_secs(3));
    log::warn!("The app did not end after {reason}; ending now");
    finish_exit(handle);
    std::process::exit(0);
}

pub fn run() {
    // First of all: the log and the panic hook. Until the data directory is known (`setup`), lines
    // wait in memory; with `windows_subsystem = "windows"` there is no console to see a panic in.
    gitcore::startup::mark_process_start();
    #[cfg(target_os = "linux")]
    let vblank_timer = avoid_waking_idle_gpus();
    gitcore::crash::install();
    #[cfg(target_os = "linux")]
    if let Some(gpus) = vblank_timer {
        log::info!("{gpus} GPUs: WebKit uses its vblank timer, so that starting does not wake a powered-down GPU ({VBLANK_TIMER_ENV}=1)");
    }
    if is_unbundled_release(tauri::is_dev(), cfg!(debug_assertions)) {
        // Without the embedded UI a shipped program would load it from a local port – whoever
        // serves that port would have access to all of the app's commands.
        eprintln!("forkyard: This program was built without the embedded UI (cargo build --release). A release build is only produced by “npm run tauri build”.");
        std::process::exit(2);
    }
    let context = context();
    // External launch: `<folder>`, `--commit <sha>` or `forkyard://open?path=…&commit=…`.
    // If the app is already running with this data directory, it receives the request and this process ends.
    let launch = gitcore::commands::launch::from_args(std::env::args_os().skip(1), std::env::current_dir().ok().as_deref());
    let data_dir =
        env_value(DATA_DIR_ENV).map(PathBuf::from).or_else(|| gitcore::commands::launch::default_data_dir(&context.config().identifier));
    let forwarded = data_dir.is_some_and(|dir| match &launch {
        Some(request) => gitcore::commands::launch::forward(&dir, request),
        None => gitcore::commands::launch::forward_focus(&dir),
    });
    if forwarded {
        return;
    }
    let result = tauri::Builder::default()
        // The window only shows its own UI; any navigation to another address is rejected.
        .plugin(navigation_guard())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // System notifications (replaces the WebView's `window.Notification`, which otherwise
        // rejects every request) and clipboard access without a WebView prompt.
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(move |app| {
            gitcore::startup::reached("window created");
            setup(app, launch)
        })
        .on_page_load(|_, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                gitcore::startup::reached("page loaded");
            }
        })
        .on_window_event(on_window_event)
        .invoke_handler(commands::handler())
        .build(context);
    match result {
        Ok(app) => app.run(|handle, event| {
            // On exit, close the shells of the built-in terminals together with their child processes.
            if let tauri::RunEvent::Exit = event {
                finish_exit(handle);
            }
        }),
        Err(e) => {
            log::error!("The app couldn’t be started: {e}");
            eprintln!("The app couldn’t be started: {e}");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Development switches only in a debug build; a release without the embedded UI does not start.
    #[test]
    fn dev_switches_need_a_debug_build() {
        assert!(dev_switches_allowed(true, true), "cargo build / tauri dev");
        assert!(!dev_switches_allowed(true, false), "cargo build --release without the Tauri CLI");
        assert!(!dev_switches_allowed(false, false), "tauri build");
        assert!(!dev_switches_allowed(false, true), "tauri build --debug");
        assert!(is_unbundled_release(true, false));
        assert!(!is_unbundled_release(true, true) && !is_unbundled_release(false, false) && !is_unbundled_release(false, true));
    }

    /// The layout of /sys/class/drm on a laptop with an Intel and an NVIDIA GPU (as on the machine
    /// where the 3 s wake-up was measured): a firmware framebuffer without vendor, two PCI cards,
    /// their connectors and render nodes.
    #[test]
    fn counts_the_gpus_with_a_drm_card() {
        let dir = std::env::temp_dir().join(format!(
            "fy-drm-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        let card = |name: &str, vendor: Option<&str>| {
            let device = dir.join(name).join("device");
            std::fs::create_dir_all(&device).unwrap();
            if let Some(vendor) = vendor {
                std::fs::write(device.join("vendor"), format!("{vendor}\n")).unwrap();
            }
        };
        assert_eq!(drm_gpu_count(&dir), 0, "no folder: no GPU");
        card("card0", None);
        card("card2", Some("0x8086"));
        for connector in ["card2-eDP-2", "card2-HDMI-A-2"] {
            std::fs::create_dir_all(dir.join(connector)).unwrap();
        }
        std::fs::create_dir_all(dir.join("renderD129").join("device")).unwrap();
        std::fs::write(dir.join("renderD129").join("device").join("vendor"), "0x8086\n").unwrap();
        std::fs::write(dir.join("version"), "drm 1.1.0\n").unwrap();
        assert_eq!(drm_gpu_count(&dir), 1, "one GPU: WebKit's DRM vblank stays");
        card("card1", Some("0x10de"));
        card("card1-DP-1", Some("0x10de"));
        assert_eq!(drm_gpu_count(&dir), 2, "integrated + discrete GPU");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The window never leaves its own UI.
    #[test]
    fn the_window_only_navigates_to_its_own_pages() {
        let url = |text: &str| text.parse::<tauri::Url>().unwrap();
        let dev = url("http://127.0.0.1:1420/");
        for own in [
            "tauri://localhost/",
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "https://tauri.localhost/index.html",
            "about:blank",
        ] {
            assert!(navigation_allowed(&url(own), None), "{own}");
        }
        assert!(navigation_allowed(&url("http://127.0.0.1:1420/?scenario=x"), Some(&dev)));
        for foreign in [
            "https://example.com/",
            "http://127.0.0.1:1420/",
            "file:///C:/Users/anna/geheim.html",
            "tauri://anders/",
            "http://tauri.localhost.example.com/",
            "data:text/html,<script>1</script>",
            "javascript:alert(1)",
            "about:srcdoc",
            "forkyard://open?path=x",
        ] {
            assert!(!navigation_allowed(&url(foreign), None), "{foreign}");
        }
        // In development mode exactly the origin of the Vite server counts.
        for foreign in ["http://127.0.0.1:1421/", "http://localhost:1420/", "https://127.0.0.1:1420/", "https://example.com/"] {
            assert!(!navigation_allowed(&url(foreign), Some(&dev)), "{foreign}");
        }
    }

    /// The policy in tauri.conf.json: no inline script, no eval, no foreign sources.
    #[test]
    fn the_content_security_policy_is_strict() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let csp = config["app"]["security"]["csp"].as_str().expect("a policy is set");
        let directive = |name: &str| -> Vec<&str> {
            csp.split(';')
                .map(str::trim)
                .find(|d| d.split_whitespace().next() == Some(name))
                .map(|d| d.split_whitespace().skip(1).collect())
                .unwrap_or_default()
        };
        assert_eq!(directive("default-src"), ["'self'"]);
        assert_eq!(directive("script-src"), ["'self'"], "no 'unsafe-inline', no 'unsafe-eval', no foreign source");
        assert_eq!(directive("connect-src"), ["ipc:", "http://ipc.localhost"], "only the channel to the core");
        assert_eq!(directive("object-src"), ["'none'"]);
        assert_eq!(directive("base-uri"), ["'none'"]);
        assert_eq!(directive("form-action"), ["'none'"]);
        assert_eq!(directive("frame-ancestors"), ["'none'"]);
        assert!(!csp.contains("unsafe-eval") && !csp.contains('*') && !csp.contains("https:"), "{csp}");
        assert!(directive("img-src").iter().all(|s| ["'self'", "data:", "blob:"].contains(s)));
    }

    /// `forkyard` is the command on every system: the program's name (deb/rpm install
    /// /usr/bin/forkyard, Windows forkyard.exe), the PATH entry of both Windows installers, and the
    /// version that `forkyard --version` reports.
    #[test]
    fn the_command_line_command_is_set_up_by_the_installers() {
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(config["mainBinaryName"], "forkyard");
        // Without a version here Tauri takes the one from Cargo.toml, so `forkyard --version` and the bundles agree.
        assert!(config["version"].is_null(), "the app version lives only in Cargo.toml and package.json");
        let package: serde_json::Value = serde_json::from_str(include_str!("../../package.json")).unwrap();
        assert_eq!(package["version"].as_str(), Some(env!("CARGO_PKG_VERSION")), "package.json and Cargo.toml disagree");
        let windows = &config["bundle"]["windows"];
        assert_eq!(windows["nsis"]["installerHooks"], "windows/installer-hooks.nsh");
        let hooks = include_str!("../windows/installer-hooks.nsh");
        assert!(hooks.contains("!macro NSIS_HOOK_POSTINSTALL") && hooks.contains(r#""$INSTDIR\forkyard.exe" --register-path"#), "{hooks}");
        assert!(
            hooks.contains("!macro NSIS_HOOK_PREUNINSTALL") && hooks.contains(r#""$INSTDIR\forkyard.exe" --unregister-path"#),
            "{hooks}"
        );
        assert_eq!(windows["wix"]["fragmentPaths"], serde_json::json!(["windows/cli-path.wxs"]));
        assert_eq!(windows["wix"]["componentRefs"], serde_json::json!(["ForkyardCliPath"]));
        let fragment = include_str!("../windows/cli-path.wxs");
        for part in
            [r#"<Component Id="ForkyardCliPath""#, r#"Name="PATH""#, r#"Value="[INSTALLDIR]""#, r#"Permanent="no""#, r#"Part="last""#]
        {
            assert!(fragment.contains(part), "{part}\n{fragment}");
        }
    }

    /// build.rs gives the main thread 8 MB on Windows: with the default 1 MB, a double-click on a
    /// branch (IPC handler plus the `branch_checkout` future, both built on the main thread) ended
    /// the release build with a stack overflow. Read from the PE header of this test executable,
    /// which is linked with the same arguments as the app.
    #[cfg(windows)]
    #[test]
    fn the_main_thread_gets_eight_megabytes_of_stack_on_windows() {
        let exe = std::fs::read(std::env::current_exe().unwrap()).unwrap();
        let u16_at = |at: usize| u16::from_le_bytes(exe[at..at + 2].try_into().unwrap());
        let u32_at = |at: usize| u32::from_le_bytes(exe[at..at + 4].try_into().unwrap());
        let pe = u32_at(0x3c) as usize;
        assert_eq!(&exe[pe..pe + 4], b"PE\0\0");
        // Optional header after the 4-byte signature and the 20-byte COFF header; PE32+ only.
        let optional = pe + 24;
        assert_eq!(u16_at(optional), 0x20b, "PE32+");
        let reserve = u64::from_le_bytes(exe[optional + 72..optional + 80].try_into().unwrap());
        assert!(reserve >= 8 * 1024 * 1024, "main thread stack reserve is {reserve} bytes");
    }
}
