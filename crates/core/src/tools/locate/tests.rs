//! Locating programs with fake CLIs in temp folders (shell scripts on Unix, batch files on Windows).

use super::*;
use crate::testkit::{temp_folder, TestCore};

/// A fake CLI that appends a line to `counter` on every start and prints `version_line`.
fn fake_tool(dir: &Path, name: &str, version_line: &str, counter: &Path) -> PathBuf {
    std::fs::create_dir_all(dir).unwrap();
    if cfg!(windows) {
        let path = dir.join(format!("{name}.cmd"));
        std::fs::write(&path, format!("@echo off\r\necho x>>\"{}\"\r\necho {version_line}\r\n", counter.display())).unwrap();
        path
    } else {
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\necho x >> '{}'\necho '{version_line}'\n", counter.display())).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path
    }
}

fn runs(counter: &Path) -> usize {
    std::fs::read_to_string(counter).map(|text| text.lines().count()).unwrap_or(0)
}

fn same(a: &Path, b: &Path) -> bool {
    util::path_key(a) == util::path_key(b)
}

fn folder_of(program: &Path) -> OsString {
    std::env::join_paths([program.parent().unwrap()]).unwrap()
}

#[test]
fn versions_are_read_from_typical_outputs() {
    assert_eq!(parse_version("2.1.301 (Claude Code)").as_deref(), Some("2.1.301"));
    assert_eq!(parse_version("codex-cli 0.162.0").as_deref(), Some("0.162.0"));
    assert_eq!(parse_version("opencode 1.17.15\n").as_deref(), Some("1.17.15"));
    assert_eq!(parse_version("v20.11.1").as_deref(), Some("20.11.1"));
    assert_eq!(parse_version("tool 1.2.3-beta.1 build 7").as_deref(), Some("1.2.3-beta.1"));
    assert_eq!(parse_version("Python 3.12").as_deref(), Some("3.12"));
    assert_eq!(parse_version("keine Version"), None);
}

#[test]
fn known_locations_follow_the_install_conventions() {
    let shown = |list: Vec<PathBuf>| list.iter().map(|path| path.to_string_lossy().replace('\\', "/")).collect::<Vec<_>>();
    let unix = LocateEnv { home: Some("/home/lena".into()), npm_prefix: Some("/opt/npm".into()), macos: true, ..Default::default() };
    assert_eq!(
        shown(known_locations("claude", &unix)),
        ["/home/lena/.local/bin", "/home/lena/.opencode/bin", "/home/lena/.bun/bin", "/home/lena/.npm-global/bin", "/opt/npm/bin", "/opt/homebrew/bin", "/usr/local/bin"]
    );
    let windows = LocateEnv {
        user_profile: Some(r"C:\Users\Lena".into()),
        app_data: Some(r"C:\Users\Lena\AppData\Roaming".into()),
        local_app_data: Some(r"C:\Users\Lena\AppData\Local".into()),
        windows: true,
        ..Default::default()
    };
    assert_eq!(
        shown(known_locations("codex", &windows)),
        ["C:/Users/Lena/.local/bin", "C:/Users/Lena/AppData/Roaming/npm", "C:/Users/Lena/AppData/Local/Programs/codex", "C:/Users/Lena/AppData/Local/Programs/codex/bin"]
    );
}

#[test]
fn the_login_shell_path_sits_between_the_markers() {
    assert_eq!(parse_marked_path(b"Willkommen!\n__FY__/opt/fy/bin:/usr/bin__FY__ Tsch\xc3\xbcss"), Some(OsString::from("/opt/fy/bin:/usr/bin")));
    assert_eq!(parse_marked_path(b"__FY____FY__"), None);
    assert_eq!(parse_marked_path(b"kein Marker"), None);
    assert_eq!(parse_marked_path(b"__FY__/nur/anfang"), None);
    assert_eq!(login_shell_args(Path::new("/usr/bin/fish")), ["-l", "-c", "printf \"__FY__%s__FY__\" (string join : $PATH)"]);
    assert_eq!(login_shell_args(Path::new("/bin/zsh")), ["-l", "-c", "printf \"__FY__%s__FY__\" \"$PATH\""]);
}

#[cfg(unix)]
#[tokio::test]
async fn the_login_shell_is_asked_without_a_terminal_and_within_a_time_limit() {
    use std::os::unix::fs::PermissionsExt;
    let tc = TestCore::new().await;
    let dir = temp_folder();
    let args_file = dir.path().join("args.txt");
    let shell = dir.path().join("fake-shell");
    std::fs::write(&shell, format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\necho 'Willkommen!'\nprintf '__FY__%s__FY__' '/opt/fy bin:/usr/bin'\n", args_file.display())).unwrap();
    std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(login_shell_path_from(&tc, &shell).await, Some(OsString::from("/opt/fy bin:/usr/bin")));
    assert_eq!(std::fs::read_to_string(&args_file).unwrap(), "-l\n-c\nprintf \"__FY__%s__FY__\" \"$PATH\"\n", "a login shell, never -i");

    let slow = dir.path().join("slow-shell");
    std::fs::write(&slow, "#!/bin/sh\nsleep 30\n").unwrap();
    std::fs::set_permissions(&slow, std::fs::Permissions::from_mode(0o755)).unwrap();
    let started = std::time::Instant::now();
    assert_eq!(login_shell_path_from(&tc, &slow).await, None);
    assert!(started.elapsed() < std::time::Duration::from_secs(5), "{:?}", started.elapsed());
}

#[tokio::test]
async fn configured_then_path_then_known_locations_then_the_login_shell() {
    let tc = TestCore::new().await;
    let dir = temp_folder();
    let counter = dir.path().join("runs.txt");
    let on_path = fake_tool(&dir.path().join("pfad mit leerzeichen"), "fy-loc-tool", "fy-loc-tool 1.0.0", &counter);
    let known = fake_tool(&dir.path().join("bekannt"), "fy-loc-tool", "fy-loc-tool 2.0.0", &counter);
    let login = fake_tool(&dir.path().join("login"), "fy-loc-tool", "fy-loc-tool 3.0.0", &counter);
    let all = SearchSpec { configured: None, path_var: Some(folder_of(&on_path)), known: vec![known.parent().unwrap().to_path_buf()], login_path: Some(folder_of(&login)) };

    let found = locate_in(&tc, "fy-loc-tool", &all).await.unwrap();
    assert!(same(&found.path, &on_path), "{found:?}");
    assert_eq!((found.source, found.version.as_deref(), found.name.as_str()), (ToolSource::Path, Some("1.0.0"), "fy-loc-tool"));

    let found = locate_in(&tc, "fy-loc-tool", &SearchSpec { path_var: None, ..all.clone() }).await.unwrap();
    assert!(same(&found.path, &known), "{found:?}");
    assert_eq!((found.source, found.version.as_deref()), (ToolSource::KnownLocation, Some("2.0.0")));

    let found = locate_in(&tc, "fy-loc-tool", &SearchSpec { path_var: None, known: Vec::new(), ..all.clone() }).await.unwrap();
    assert!(same(&found.path, &login), "{found:?}");
    assert_eq!((found.source, found.version.as_deref()), (ToolSource::LoginShell, Some("3.0.0")));

    let found = locate_in(&tc, "fy-loc-tool", &SearchSpec { configured: Some(known.clone()), ..all.clone() }).await.unwrap();
    assert_eq!((found.path, found.source), (known.clone(), ToolSource::Configured), "an own path wins");
    let found = locate_in(&tc, "fy-loc-tool", &SearchSpec { configured: Some(dir.path().join("fehlt")), ..all.clone() }).await.unwrap();
    assert_eq!(found.source, ToolSource::Path, "a configured path that is gone is skipped");

    assert!(locate_in(&tc, "fy-gibt-es-nicht", &all).await.is_none());
}

#[tokio::test]
async fn a_version_is_read_once_per_program_file() {
    let tc = TestCore::new().await;
    let dir = temp_folder();
    let counter = dir.path().join("runs.txt");
    let bin = dir.path().join("bin");
    let tool = fake_tool(&bin, "fy-cache-tool", "fy-cache-tool 0.162.0", &counter);
    assert_eq!(version_of(&tc, &tool).await.as_deref(), Some("0.162.0"));
    assert_eq!(version_of(&tc, &tool).await.as_deref(), Some("0.162.0"));
    assert_eq!(runs(&counter), 1, "the second look comes from the cache");
    // An update rewrites the file: the version is read again.
    fake_tool(&bin, "fy-cache-tool", "fy-cache-tool 0.163.10", &counter);
    assert_eq!(version_of(&tc, &tool).await.as_deref(), Some("0.163.10"));
    assert_eq!(runs(&counter), 2);
    assert!(version_of(&tc, &dir.path().join("gibt-es-nicht")).await.is_none());
}
