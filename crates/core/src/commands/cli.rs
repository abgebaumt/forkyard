//! The `forkyard` command on the command line.
//!
//! - `forkyard --help` and `forkyard --version` answer before any window opens (`early_exit`,
//!   called first thing in `main`). Opening a folder from the command line is `launch`.
//! - The Windows installer (NSIS) calls `forkyard.exe --register-path` after installing and
//!   `--unregister-path` before uninstalling: the program folder goes into the user's PATH
//!   (`HKCU\Environment\Path`) and out again. The MSI does the same with Windows Installer itself.
//! - deb and rpm install `/usr/bin/forkyard`. AppImage and the macOS app cannot do that: there the
//!   command palette links the command into a folder on the PATH (`cli_status`, `cli_install`).

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::app::Core;
use crate::error::{CoreError, CoreResult};
use crate::model::{CliStatus, Platform};
use crate::util;

/// Name of the command (and of the program file).
pub const COMMAND_NAME: &str = "forkyard";
/// Installer switches (Windows, NSIS).
pub const REGISTER_PATH: &str = "--register-path";
pub const UNREGISTER_PATH: &str = "--unregister-path";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CliAction {
    Help,
    Version,
    /// The installer adds (`add`) or removes the program folder from the user's PATH.
    Path { add: bool },
}

/// What the arguments (without the program name) ask for before the app starts – or `None`.
pub fn action(args: &[OsString]) -> Option<CliAction> {
    if let [only] = args {
        match only.to_str() {
            Some(REGISTER_PATH) => return Some(CliAction::Path { add: true }),
            Some(UNREGISTER_PATH) => return Some(CliAction::Path { add: false }),
            _ => {}
        }
    }
    args.iter().find_map(|arg| match arg.to_str() {
        Some("--help" | "-h") => Some(CliAction::Help),
        Some("/?") if cfg!(windows) => Some(CliAction::Help),
        Some("--version" | "-V") => Some(CliAction::Version),
        _ => None,
    })
}

pub fn help_text(version: &str) -> String {
    format!(
        "Forkyard {version} – a local Git client\n\n\
         Usage:\n  \
         forkyard [<folder>] [--commit <sha>]\n  \
         forkyard \"forkyard://open?path=<folder>&commit=<sha>\"\n\n\
         Opens the folder (and selects the commit) in the running Forkyard window, or starts Forkyard.\n\n\
         Options:\n  \
         --commit <sha>   Select this commit after opening\n  \
         -h, --help       Show this help and exit\n  \
         -V, --version    Show the version and exit\n"
    )
}

pub fn version_text(version: &str) -> String {
    format!("{COMMAND_NAME} {version}\n")
}

/// Handles `--help`, `--version` and the installer switches; `Some(exit code)` if the process
/// should end now, `None` to start the app normally.
pub fn early_exit<I, S>(args: I, version: &str) -> Option<i32>
where
    I: IntoIterator<Item = S>,
    S: Into<OsString>,
{
    let args: Vec<OsString> = args.into_iter().map(Into::into).collect();
    Some(match action(&args)? {
        CliAction::Help => {
            print_out(&help_text(version));
            0
        }
        CliAction::Version => {
            print_out(&version_text(version));
            0
        }
        CliAction::Path { add } => update_path(add),
    })
}

#[cfg(not(windows))]
fn print_out(text: &str) {
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(text.as_bytes());
    let _ = out.flush();
}

/// A release build on Windows has no console of its own (GUI subsystem): if the output is not
/// redirected, the text goes to the console of the calling terminal.
#[cfg(windows)]
fn print_out(text: &str) {
    use std::io::Write;
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::Console::{AttachConsole, GetStdHandle, ATTACH_PARENT_PROCESS, STD_OUTPUT_HANDLE};
    // SAFETY: GetStdHandle only reads this process's handle table.
    let handle = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
    if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
        let mut out = std::io::stdout().lock();
        let _ = out.write_all(text.as_bytes());
        let _ = out.flush();
        return;
    }
    // SAFETY: no pointers; if there is no parent console, nothing happens.
    unsafe {
        AttachConsole(ATTACH_PARENT_PROCESS);
    }
    if let Ok(mut console) = std::fs::OpenOptions::new().write(true).open("CONOUT$") {
        let _ = console.write_all(text.as_bytes());
    }
}

fn program_dir() -> Option<PathBuf> {
    std::env::current_exe().ok().and_then(|exe| exe.parent().map(Path::to_path_buf))
}

#[cfg(windows)]
fn update_path(add: bool) -> i32 {
    let Some(dir) = program_dir() else {
        eprintln!("{COMMAND_NAME}: the program folder is unknown.");
        return 1;
    };
    match windows_path::update(&dir, add) {
        Ok(()) => 0,
        Err(reason) => {
            eprintln!("{COMMAND_NAME}: PATH not updated: {reason}");
            1
        }
    }
}

#[cfg(not(windows))]
fn update_path(add: bool) -> i32 {
    let _ = (add, program_dir());
    eprintln!("{COMMAND_NAME}: {REGISTER_PATH} and {UNREGISTER_PATH} are only used by the Windows installer.");
    2
}

fn same_dir(a: &str, b: &str) -> bool {
    let normal = |text: &str| text.trim().trim_end_matches(['\\', '/']).to_lowercase();
    let a = normal(a);
    !a.is_empty() && a == normal(b)
}

/// `existing` (a Windows PATH value) with `dir` appended; `None` if it is already listed (case and
/// a trailing backslash do not matter).
pub fn path_with(existing: &str, dir: &str) -> Option<String> {
    if existing.split(';').any(|entry| same_dir(entry, dir)) {
        return None;
    }
    let kept = existing.trim_end_matches(';');
    Some(if kept.is_empty() { dir.to_string() } else { format!("{kept};{dir}") })
}

/// `existing` without exactly the entry `dir` (and without empty entries); `None` if it is not listed.
pub fn path_without(existing: &str, dir: &str) -> Option<String> {
    if !existing.split(';').any(|entry| same_dir(entry, dir)) {
        return None;
    }
    Some(existing.split(';').filter(|entry| !entry.is_empty() && !same_dir(entry, dir)).collect::<Vec<_>>().join(";"))
}

/// `HKCU\Environment\Path`, keeping its type (`REG_EXPAND_SZ` for `%USERPROFILE%` entries), and a
/// broadcast so that new terminals see the change. Exercised by the Windows CI job.
#[cfg(windows)]
mod windows_path {
    use std::path::Path;

    use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
    use windows_sys::Win32::System::Registry::{RegCloseKey, RegOpenKeyExW, RegQueryValueExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_EXPAND_SZ, REG_SZ, REG_VALUE_TYPE};
    use windows_sys::Win32::UI::WindowsAndMessaging::{SendMessageTimeoutW, HWND_BROADCAST, SMTO_ABORTIFHUNG, WM_SETTINGCHANGE};

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    struct Key(HKEY);

    impl Drop for Key {
        fn drop(&mut self) {
            // SAFETY: the handle was opened by RegOpenKeyExW and is closed only here.
            unsafe {
                RegCloseKey(self.0);
            }
        }
    }

    fn read(key: &Key, name: &[u16]) -> Result<(String, REG_VALUE_TYPE), String> {
        let mut kind: REG_VALUE_TYPE = 0;
        let mut size: u32 = 0;
        // SAFETY: valid key and null-terminated name; this first call only asks for the size.
        let status = unsafe { RegQueryValueExW(key.0, name.as_ptr(), std::ptr::null(), &mut kind, std::ptr::null_mut(), &mut size) };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok((String::new(), REG_EXPAND_SZ));
        }
        if status != ERROR_SUCCESS {
            return Err(format!("reading Path failed (error {status})"));
        }
        let mut buffer = vec![0u16; (size as usize).div_ceil(2) + 1];
        let mut bytes = (buffer.len() * 2) as u32;
        // SAFETY: `buffer` holds `bytes` bytes.
        let status = unsafe { RegQueryValueExW(key.0, name.as_ptr(), std::ptr::null(), &mut kind, buffer.as_mut_ptr().cast(), &mut bytes) };
        if status != ERROR_SUCCESS {
            return Err(format!("reading Path failed (error {status})"));
        }
        let length = buffer.iter().position(|&unit| unit == 0).unwrap_or(buffer.len());
        Ok((String::from_utf16_lossy(&buffer[..length]), if kind == REG_SZ { REG_SZ } else { REG_EXPAND_SZ }))
    }

    pub fn update(dir: &Path, add: bool) -> Result<(), String> {
        let dir = dir.to_string_lossy().into_owned();
        let subkey = wide("Environment");
        let mut raw: HKEY = std::ptr::null_mut();
        // SAFETY: null-terminated subkey; `raw` receives the handle that `Key` closes.
        let status = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_QUERY_VALUE | KEY_SET_VALUE, &mut raw) };
        if status != ERROR_SUCCESS {
            return Err(format!("HKCU\\Environment couldn’t be opened (error {status})"));
        }
        let key = Key(raw);
        let name = wide("Path");
        let (existing, kind) = read(&key, &name)?;
        let next = if add { super::path_with(&existing, &dir) } else { super::path_without(&existing, &dir) };
        let Some(next) = next else { return Ok(()) };
        let data = wide(&next);
        // SAFETY: `data` is a null-terminated UTF-16 buffer of the given length in bytes.
        let status = unsafe { RegSetValueExW(key.0, name.as_ptr(), 0, kind, data.as_ptr().cast(), (data.len() * 2) as u32) };
        if status != ERROR_SUCCESS {
            return Err(format!("writing Path failed (error {status})"));
        }
        let environment = wide("Environment");
        let mut result: usize = 0;
        // SAFETY: broadcast with a null-terminated string that lives until the call returns; the
        // time limit keeps a hanging window from blocking the installer.
        unsafe {
            SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0, environment.as_ptr() as isize, SMTO_ABORTIFHUNG, 5000, &mut result);
        }
        Ok(())
    }
}

/// Where the command goes on this installation and what it points to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkPlan {
    pub link: PathBuf,
    pub target: PathBuf,
}

/// AppImage: `~/.local/bin/forkyard` → the image (`$APPIMAGE`); macOS app: `/usr/local/bin/forkyard`
/// → the program in the bundle. `None` where an installer takes care of it (Windows, deb, rpm) or
/// the program runs from a build folder.
pub fn link_plan(platform: Platform, appimage: Option<&Path>, exe: &Path, home: Option<&Path>) -> Option<LinkPlan> {
    match platform {
        Platform::Linux => {
            let image = appimage.filter(|path| path.is_absolute())?;
            Some(LinkPlan { link: home?.join(".local").join("bin").join(COMMAND_NAME), target: image.to_path_buf() })
        }
        Platform::Macos if exe.to_string_lossy().contains(".app/Contents/MacOS/") => {
            Some(LinkPlan { link: PathBuf::from("/usr/local/bin").join(COMMAND_NAME), target: exe.to_path_buf() })
        }
        Platform::Macos | Platform::Windows => None,
    }
}

fn current_plan() -> Option<LinkPlan> {
    let exe = std::env::current_exe().ok()?;
    let appimage = std::env::var_os("APPIMAGE").map(PathBuf::from);
    link_plan(Platform::current(), appimage.as_deref(), &exe, dirs::home_dir().as_deref())
}

#[cfg(unix)]
fn link_installed(plan: &LinkPlan) -> bool {
    std::fs::read_link(&plan.link).is_ok_and(|target| target == plan.target)
}

#[cfg(not(unix))]
fn link_installed(_plan: &LinkPlan) -> bool {
    false
}

fn on_path(link: &Path) -> bool {
    let Some(dir) = link.parent() else { return false };
    std::env::var_os("PATH").is_some_and(|value| std::env::split_paths(&value).any(|entry| entry == dir))
}

#[cfg(unix)]
fn link_error(plan: &LinkPlan, e: std::io::Error) -> CoreError {
    if e.kind() == std::io::ErrorKind::PermissionDenied {
        return CoreError::not_allowed(format!(
            "Forkyard may not write to “{}”. Run this in a terminal instead: sudo ln -sf \"{}\" \"{}\"",
            plan.link.parent().map(util::display_path).unwrap_or_default(),
            util::display_path(&plan.target),
            util::display_path(&plan.link)
        ));
    }
    CoreError::from(e)
}

/// Creates the link. An existing link is replaced only if it is ours (points to something named
/// `*forkyard*`) or dangles; a real file or a foreign link stays (`path_exists`).
#[cfg(unix)]
pub fn install_link(plan: &LinkPlan) -> CoreResult<()> {
    if let Ok(meta) = std::fs::symlink_metadata(&plan.link) {
        if !meta.file_type().is_symlink() {
            return Err(CoreError::path_exists(util::display_path(&plan.link)));
        }
        let current = std::fs::read_link(&plan.link)?;
        if current == plan.target {
            return Ok(());
        }
        let ours = current.file_name().is_some_and(|name| name.to_string_lossy().to_lowercase().contains(COMMAND_NAME)) || !plan.link.exists();
        if !ours {
            return Err(CoreError::path_exists(util::display_path(&plan.link)));
        }
        std::fs::remove_file(&plan.link).map_err(|e| link_error(plan, e))?;
    }
    if let Some(dir) = plan.link.parent() {
        std::fs::create_dir_all(dir).map_err(|e| link_error(plan, e))?;
    }
    std::os::unix::fs::symlink(&plan.target, &plan.link).map_err(|e| link_error(plan, e))
}

#[cfg(not(unix))]
pub fn install_link(_plan: &LinkPlan) -> CoreResult<()> {
    Err(CoreError::unsupported("The installer puts the forkyard command on the PATH."))
}

fn status_for(plan: Option<&LinkPlan>) -> CliStatus {
    match plan {
        Some(plan) => CliStatus { installable: true, installed: link_installed(plan), link_path: Some(util::display_path(&plan.link)), on_path: on_path(&plan.link) },
        None => CliStatus { installable: false, installed: false, link_path: None, on_path: false },
    }
}

/// Whether this installation can link the command itself and whether the link is there.
pub async fn cli_status(core: &Core) -> CoreResult<CliStatus> {
    let _ = core;
    Ok(status_for(current_plan().as_ref()))
}

/// Links the command (AppImage, macOS app). Where an installer does it: `unsupported`.
pub async fn cli_install(core: &Core) -> CoreResult<CliStatus> {
    let _ = core;
    let plan = current_plan().ok_or_else(|| CoreError::unsupported("This installation puts the forkyard command on the PATH itself."))?;
    install_link(&plan)?;
    Ok(status_for(Some(&plan)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    fn os(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn help_and_version_count_anywhere_the_installer_switches_only_alone() {
        assert_eq!(action(&os(&["--help"])), Some(CliAction::Help));
        assert_eq!(action(&os(&["-h"])), Some(CliAction::Help));
        assert_eq!(action(&os(&["/home/anna/repo", "--version"])), Some(CliAction::Version));
        assert_eq!(action(&os(&["-V"])), Some(CliAction::Version));
        assert_eq!(action(&os(&["--register-path"])), Some(CliAction::Path { add: true }));
        assert_eq!(action(&os(&["--unregister-path"])), Some(CliAction::Path { add: false }));
        assert_eq!(action(&os(&["--register-path", "x"])), None, "only as the sole argument");
        assert_eq!(action(&os(&[])), None);
        assert_eq!(action(&os(&["/home/anna/repo", "--commit", "abc123"])), None);
        assert_eq!(action(&os(&["forkyard://open?path=--help"])), None);
    }

    #[test]
    fn the_help_names_every_way_to_start() {
        let text = help_text("1.2.3");
        for part in ["Forkyard 1.2.3", "forkyard [<folder>] [--commit <sha>]", "forkyard://open?path=", "--help", "--version"] {
            assert!(text.contains(part), "{part}\n{text}");
        }
        assert_eq!(version_text("1.2.3"), "forkyard 1.2.3\n");
    }

    #[test]
    fn windows_path_entries_are_added_once_and_removed_exactly() {
        let dir = r"C:\Users\anna\AppData\Local\Forkyard";
        assert_eq!(path_with("", dir).as_deref(), Some(dir));
        assert_eq!(path_with(r"C:\Windows;C:\Tools;", dir).as_deref(), Some(r"C:\Windows;C:\Tools;C:\Users\anna\AppData\Local\Forkyard"));
        assert_eq!(path_with(r"C:\Windows;c:\users\ANNA\appdata\local\forkyard\", dir), None, "already there (case and trailing backslash do not matter)");
        assert_eq!(path_without(r"C:\Windows;C:\Users\anna\AppData\Local\Forkyard;%USERPROFILE%\bin", dir).as_deref(), Some(r"C:\Windows;%USERPROFILE%\bin"));
        assert_eq!(path_without(r"C:\Windows;C:\Users\anna\AppData\Local\Forkyard\Sub", dir), None, "only exactly this folder");
        assert_eq!(path_without(r"C:\Windows", dir), None);
        let added = path_with(r"C:\Windows", dir).unwrap();
        assert_eq!(path_without(&added, dir).as_deref(), Some(r"C:\Windows"));
    }

    // Unix only: the AppImage path in the test is absolute only on Unix (`Path::is_absolute`).
    #[cfg(unix)]
    #[test]
    fn the_link_is_planned_only_where_no_installer_does_it() {
        let home = Path::new("/home/anna");
        let image = Path::new("/home/anna/Apps/Forkyard_1.1.0_amd64.AppImage");
        let plan = link_plan(Platform::Linux, Some(image), Path::new("/tmp/.mount_ForkyX/usr/bin/forkyard"), Some(home)).unwrap();
        assert_eq!(plan, LinkPlan { link: home.join(".local").join("bin").join("forkyard"), target: image.to_path_buf() });
        assert_eq!(link_plan(Platform::Linux, None, Path::new("/usr/bin/forkyard"), Some(home)), None, "deb/rpm: /usr/bin/forkyard comes with the package");
        assert_eq!(link_plan(Platform::Linux, Some(Path::new("relativ.AppImage")), Path::new("/x"), Some(home)), None);
        let exe = Path::new("/Applications/Forkyard.app/Contents/MacOS/forkyard");
        assert_eq!(link_plan(Platform::Macos, None, exe, Some(home)), Some(LinkPlan { link: PathBuf::from("/usr/local/bin/forkyard"), target: exe.to_path_buf() }));
        assert_eq!(link_plan(Platform::Macos, None, Path::new("/Users/anna/forkyard/target/debug/forkyard"), Some(home)), None, "not from a build folder");
        assert_eq!(link_plan(Platform::Windows, None, Path::new(r"C:\Program Files\Forkyard\forkyard.exe"), Some(home)), None);
    }

    #[cfg(unix)]
    #[test]
    fn the_link_is_created_kept_and_replaced_only_when_it_is_ours() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("Forkyard.AppImage");
        std::fs::write(&target, "x").unwrap();
        let plan = LinkPlan { link: dir.path().join("bin").join("forkyard"), target: target.clone() };
        install_link(&plan).unwrap();
        assert_eq!(std::fs::read_link(&plan.link).unwrap(), target);
        assert!(link_installed(&plan));
        install_link(&plan).unwrap();
        // A link to an image that was moved away is replaced.
        std::fs::remove_file(&plan.link).unwrap();
        std::os::unix::fs::symlink(dir.path().join("weg.AppImage"), &plan.link).unwrap();
        assert!(!link_installed(&plan));
        install_link(&plan).unwrap();
        assert_eq!(std::fs::read_link(&plan.link).unwrap(), target);
        // A foreign program or a real file stays.
        std::fs::remove_file(&plan.link).unwrap();
        let other = dir.path().join("anderes-programm");
        std::fs::write(&other, "y").unwrap();
        std::os::unix::fs::symlink(&other, &plan.link).unwrap();
        assert_eq!(install_link(&plan).unwrap_err().code, ErrorCode::PathExists);
        std::fs::remove_file(&plan.link).unwrap();
        std::fs::write(&plan.link, "eigene Datei").unwrap();
        assert_eq!(install_link(&plan).unwrap_err().code, ErrorCode::PathExists);
        assert_eq!(std::fs::read(&plan.link).unwrap(), b"eigene Datei");
    }

    #[tokio::test]
    async fn without_a_plan_the_installer_is_responsible() {
        if current_plan().is_some() {
            return; // the test binary runs inside an AppImage or an app bundle
        }
        let tc = crate::testkit::TestCore::new().await;
        assert_eq!(cli_status(&tc).await.unwrap(), CliStatus { installable: false, installed: false, link_path: None, on_path: false });
        assert_eq!(cli_install(&tc).await.unwrap_err().code, ErrorCode::Unsupported);
    }
}
