//! Opening in an editor, terminal or file manager, plus external diff and merge tools (`tools`).
//!
//! The flow is split in two so it can be tested without really starting programs:
//! `plan` is a pure function deciding what would be started (`Launch`), `launch`
//! starts it detached. Command lines from the settings are split by us
//! (`split_command_line`) and never handed to a shell; `{path}` and `{repo}` are only
//! substituted after splitting, so a path with spaces stays one argument.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};

use parking_lot::Mutex;

use crate::app::Core;
use crate::commands::history::normalize_rel_path;
use crate::error::{CoreError, CoreResult};
use crate::model::{DiffSource, ExternalTarget, Settings};
use crate::util;

pub mod tools;

/// Placeholders in `Settings.external_editor` / `external_terminal`.
pub const PATH_PLACEHOLDER: &str = "{path}";
pub const REPO_PLACEHOLDER: &str = "{repo}";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Windows,
    Linux,
    Mac,
}

impl Platform {
    pub fn current() -> Platform {
        if cfg!(windows) {
            Platform::Windows
        } else if cfg!(target_os = "macos") {
            Platform::Mac
        } else {
            Platform::Linux
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchArg {
    /// Ordinary argument; the standard library takes care of quoting.
    Plain(String),
    /// Windows only: put into the command line unchanged (for `explorer /select,"…"`).
    Raw(String),
}

/// A planned program start.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub program: String,
    pub args: Vec<LaunchArg>,
    pub cwd: PathBuf,
    /// The program is a terminal and needs its own console window on Windows.
    pub terminal: bool,
    /// Additional environment (only for `git difftool`/`git mergetool`).
    pub env: Vec<(std::ffi::OsString, std::ffi::OsString)>,
}

impl Launch {
    fn new(program: &str, args: &[&str], cwd: &Path, terminal: bool) -> Launch {
        Launch {
            program: program.to_string(),
            args: args.iter().map(|a| LaunchArg::Plain((*a).to_string())).collect(),
            cwd: cwd.to_path_buf(),
            terminal,
            env: Vec::new(),
        }
    }

    /// The arguments as text (for tests and error messages).
    pub fn arg_strings(&self) -> Vec<&str> {
        self.args
            .iter()
            .map(|a| match a {
                LaunchArg::Plain(s) | LaunchArg::Raw(s) => s.as_str(),
            })
            .collect()
    }
}

/// State for tests: with `set_dry_run(true)`, `open_external` starts nothing but
/// remembers the planned start (`take_launched`). Access via `core.state::<ExternalState>()`.
#[derive(Default)]
pub struct ExternalState {
    dry_run: AtomicBool,
    launched: Mutex<Vec<Launch>>,
}

impl ExternalState {
    pub fn set_dry_run(&self, on: bool) {
        self.dry_run.store(on, Ordering::SeqCst);
    }
    pub fn take_launched(&self) -> Vec<Launch> {
        std::mem::take(&mut *self.launched.lock())
    }
}

// ---------------------------------------------------------------------------
// Command lines from the settings
// ---------------------------------------------------------------------------

/// Splits a command line into program and arguments, without a shell.
///
/// - Whitespace separates; `"…"` and `'…'` group (also in the middle of a word).
/// - With `backslash_escapes` (Linux, macOS), `\` outside of quotes protects the
///   next character, and inside `"…"` `\"` and `\\` stand for `"` and `\`.
/// - Without `backslash_escapes` (Windows), `\` is the path separator and stays literal everywhere,
///   also in `"C:\Folder\"`. A quote inside an argument is not possible there
///   (it does not occur in Windows paths).
///
/// Unclosed quotes → `not_allowed`.
pub fn split_command_line(line: &str, backslash_escapes: bool) -> CoreResult<Vec<String>> {
    let mut args: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut in_word = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                in_word = true;
                loop {
                    match chars.next() {
                        Some('"') => break,
                        Some('\\') if backslash_escapes && matches!(chars.peek(), Some('"' | '\\')) => {
                            current.extend(chars.next());
                        }
                        Some(other) => current.push(other),
                        None => return Err(unclosed_quote(line)),
                    }
                }
            }
            '\'' => {
                in_word = true;
                loop {
                    match chars.next() {
                        Some('\'') => break,
                        Some(other) => current.push(other),
                        None => return Err(unclosed_quote(line)),
                    }
                }
            }
            '\\' if backslash_escapes => {
                in_word = true;
                current.push(chars.next().unwrap_or('\\'));
            }
            c if c.is_whitespace() => {
                if in_word {
                    args.push(std::mem::take(&mut current));
                    in_word = false;
                }
            }
            other => {
                in_word = true;
                current.push(other);
            }
        }
    }
    if in_word {
        args.push(current);
    }
    Ok(args)
}

fn unclosed_quote(line: &str) -> CoreError {
    CoreError::not_allowed(format!("A quotation mark in the command “{line}” is not closed."))
}

/// Splits the template and substitutes `{path}` and `{repo}`. If `{path}` does not occur and
/// `append_path` is set, the path is appended as the last argument.
pub fn expand_template(template: &str, path: &str, repo: &str, append_path: bool, platform: Platform) -> CoreResult<Vec<String>> {
    let parts = split_command_line(template, platform != Platform::Windows)?;
    if !parts.first().is_some_and(|p| !p.trim().is_empty()) {
        return Err(CoreError::not_allowed("The command in Settings is empty."));
    }
    let has_path = parts.iter().any(|p| p.contains(PATH_PLACEHOLDER));
    let mut args: Vec<String> =
        parts.iter().map(|p| p.replace(PATH_PLACEHOLDER, path).replace(REPO_PLACEHOLDER, repo)).collect();
    if !has_path && append_path {
        args.push(path.to_string());
    }
    Ok(args)
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/// What is to be opened, already resolved.
#[derive(Debug, Clone)]
pub struct OpenRequest<'a> {
    pub target: ExternalTarget,
    /// Root of the repository.
    pub repo: &'a Path,
    /// File or folder in the repository; `None` = the repository itself.
    pub item: Option<&'a Path>,
    pub item_is_dir: bool,
    /// `$TERMINAL` (only relevant on Linux).
    pub env_terminal: Option<&'a str>,
}

/// Path as an argument for a foreign program: the system's spelling, without `\\?\`.
fn arg_path(path: &Path) -> String {
    let text = util::display_path(path);
    match text.strip_prefix(r"\\?\UNC\") {
        Some(rest) => format!(r"\\{rest}"),
        None => text.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(text),
    }
}

/// Extensions that may be opened via the system's file type association when no editor is
/// configured: plain text and source formats behind which no system has an interpreter
/// or installer as the default. Deliberately left out: everything executable
/// (`bat`, `cmd`, `exe`, `lnk`, `msi`, `reg`, `desktop`, `command`, `app`), scripts (`js`,
/// `vbs`, `ps1`, `sh`, `py`, `rb`, `pl`, `php`, `lua`) and formats a browser renders with
/// scripts (`html`, `svg`).
const TEXT_EXTENSIONS: [&str; 62] = [
    "txt", "md", "markdown", "rst", "adoc", "log", "json", "jsonc", "json5", "xml", "yml", "yaml", "toml", "ini", "cfg", "conf", "properties", "csv",
    "tsv", "css", "scss", "sass", "less", "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "rs", "go", "java", "kt", "kts", "swift", "m", "mm", "ts", "tsx",
    "jsx", "cs", "fs", "sql", "graphql", "proto", "tex", "bib", "diff", "patch", "lock", "gitignore", "gitattributes", "gitmodules", "editorconfig",
    "cmake", "gradle", "dart", "scala", "ex", "erl", "hs",
];

/// Whether the file has a text or source format from `TEXT_EXTENSIONS`. Dot files
/// (`.gitignore`) count by their name.
fn is_plain_text_file(path: &Path) -> bool {
    let name = path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default();
    let extension = match name.rsplit_once('.') {
        Some((_, extension)) => extension,
        None => return false,
    };
    TEXT_EXTENSIONS.contains(&extension)
}

/// Decides which program is started with which arguments. `has_program`
/// tells whether a program can be found (for choosing the default terminal).
pub fn plan(platform: Platform, settings: &Settings, request: &OpenRequest<'_>, has_program: &dyn Fn(&str) -> bool) -> CoreResult<Launch> {
    let repo = arg_path(request.repo);
    let item = request.item.unwrap_or(request.repo);
    let item_text = arg_path(item);
    // Folder containing the file (or the folder itself).
    let folder: &Path = match request.item {
        Some(path) if !request.item_is_dir => path.parent().unwrap_or(request.repo),
        Some(path) => path,
        None => request.repo,
    };
    let folder_text = arg_path(folder);
    // Explorer splits its command line itself (commas separate): always quote paths.
    // On Windows a file name cannot contain a `"`.
    let explorer = |prefix: &str, path: &str| Launch {
        program: "explorer.exe".into(),
        args: vec![LaunchArg::Raw(format!("{prefix}\"{path}\""))],
        cwd: request.repo.to_path_buf(),
        terminal: false,
        env: Vec::new(),
    };
    let from_template = |template: &str, path: &str, append: bool, cwd: &Path, terminal: bool| -> CoreResult<Launch> {
        let mut args = expand_template(template, path, &repo, append, platform)?;
        let program = args.remove(0);
        Ok(Launch { program, args: args.into_iter().map(LaunchArg::Plain).collect(), cwd: cwd.to_path_buf(), terminal, env: Vec::new() })
    };

    match request.target {
        ExternalTarget::Editor => match settings.external_editor.as_deref().filter(|t| !t.trim().is_empty()) {
            Some(template) => from_template(template, &item_text, true, request.repo, false),
            // No setting, folder (or the repository itself): the system's file manager.
            None if request.item.is_none() || request.item_is_dir => Ok(match platform {
                Platform::Windows => explorer("", &item_text),
                Platform::Linux => Launch::new("xdg-open", &[&item_text], request.repo, false),
                Platform::Mac => Launch::new("open", &[&item_text], request.repo, false),
            }),
            // No setting, file: never blindly via the file type association – for `.bat`,
            // `.lnk`, `.js`, `.desktop`, `.command`, "open" there means "run", and the
            // file may come from a foreign repository.
            None => Ok(match platform {
                // The text editor the user has as the default on macOS – for every file.
                Platform::Mac => Launch::new("open", &["-t", &item_text], request.repo, false),
                Platform::Windows if is_plain_text_file(item) => explorer("", &item_text),
                // The Windows "Open with" dialog: the user picks the program themselves.
                Platform::Windows => Launch {
                    program: "rundll32.exe".into(),
                    args: vec![LaunchArg::Raw(format!("shell32.dll,OpenAs_RunDLL {item_text}"))],
                    cwd: request.repo.to_path_buf(),
                    terminal: false,
                    env: Vec::new(),
                },
                Platform::Linux if is_plain_text_file(item) => Launch::new("xdg-open", &[&item_text], request.repo, false),
                // No uniform "Open with" dialog: the file's folder in the file manager.
                Platform::Linux => Launch::new("xdg-open", &[&folder_text], request.repo, false),
            }),
        },
        ExternalTarget::Terminal => match settings.external_terminal.as_deref().filter(|t| !t.trim().is_empty()) {
            Some(template) => from_template(template, &folder_text, false, folder, true),
            None => default_terminal(platform, folder, &folder_text, request.env_terminal, has_program),
        },
        ExternalTarget::FileManager => Ok(match platform {
            Platform::Windows => match request.item {
                Some(_) if !request.item_is_dir => explorer("/select,", &item_text),
                _ => explorer("", &folder_text),
            },
            Platform::Mac => match request.item {
                Some(_) => Launch::new("open", &["-R", &item_text], request.repo, false),
                None => Launch::new("open", &[&folder_text], request.repo, false),
            },
            // No uniform way to select a file: open the folder.
            Platform::Linux => Launch::new("xdg-open", &[&folder_text], request.repo, false),
        }),
        // These two need Git (versions of the file) and go through `tools::plan_tool`.
        ExternalTarget::DiffTool | ExternalTarget::MergeTool => {
            Err(CoreError::unsupported("The diff and merge tools are started via open_external with a file."))
        }
    }
}

fn default_terminal(
    platform: Platform,
    folder: &Path,
    folder_text: &str,
    env_terminal: Option<&str>,
    has_program: &dyn Fn(&str) -> bool,
) -> CoreResult<Launch> {
    match platform {
        Platform::Windows => {
            if has_program("wt.exe") {
                return Ok(Launch::new("wt.exe", &["-d", folder_text], folder, true));
            }
            let shell = ["pwsh.exe", "powershell.exe"].into_iter().find(|p| has_program(p)).unwrap_or("cmd.exe");
            Ok(Launch::new(shell, &[], folder, true))
        }
        Platform::Mac => Ok(Launch::new("open", &["-a", "Terminal", folder_text], folder, true)),
        Platform::Linux => {
            let from_env = env_terminal.map(str::trim).filter(|t| !t.is_empty() && has_program(t));
            if let Some(program) = from_env {
                return Ok(Launch::new(program, &[], folder, true));
            }
            let working_dir = format!("--working-directory={folder_text}");
            let candidates: [(&str, Vec<&str>); 5] = [
                ("x-terminal-emulator", vec![]),
                ("gnome-terminal", vec![working_dir.as_str()]),
                ("konsole", vec!["--workdir", folder_text]),
                ("xfce4-terminal", vec![working_dir.as_str()]),
                ("xterm", vec![]),
            ];
            candidates
                .iter()
                .find(|(program, _)| has_program(program))
                .map(|(program, args)| Launch::new(program, args, folder, true))
                .ok_or_else(|| {
                    CoreError::not_found("No terminal program was found. Set one in Settings.")
                })
        }
    }
}

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

fn program_exists(program: &str) -> bool {
    which::which(program).is_ok()
}

/// Builds a Windows command line the way programs split it again (rules of
/// `CommandLineToArgvW`): arguments with whitespace or `"` are quoted,
/// backslashes before a `"` are doubled.
pub fn windows_command_line(program: &str, args: &[LaunchArg]) -> String {
    fn quoted(arg: &str, out: &mut String) {
        if !arg.is_empty() && !arg.chars().any(|c| c == ' ' || c == '\t' || c == '"') {
            out.push_str(arg);
            return;
        }
        out.push('"');
        let mut backslashes = 0;
        for c in arg.chars() {
            match c {
                '\\' => backslashes += 1,
                '"' => {
                    out.extend(std::iter::repeat('\\').take(backslashes * 2 + 1));
                    out.push('"');
                    backslashes = 0;
                }
                other => {
                    out.extend(std::iter::repeat('\\').take(backslashes));
                    out.push(other);
                    backslashes = 0;
                }
            }
        }
        out.extend(std::iter::repeat('\\').take(backslashes * 2));
        out.push('"');
    }
    let mut line = String::new();
    quoted(program, &mut line);
    for arg in args {
        line.push(' ');
        match arg {
            LaunchArg::Plain(text) => quoted(text, &mut line),
            LaunchArg::Raw(text) => line.push_str(text),
        }
    }
    line
}

/// Windows: start a program in a new console window without giving it any
/// input/output. The standard library always passes on its own (here: empty) handles,
/// and a shell with empty input exits immediately – hence the direct call.
#[cfg(windows)]
mod new_console {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};

    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_UNICODE_ENVIRONMENT: u32 = 0x0000_0400;

    /// STARTUPINFOW
    #[repr(C)]
    struct StartupInfo {
        cb: u32,
        reserved: *mut u16,
        desktop: *mut u16,
        title: *mut u16,
        x: u32,
        y: u32,
        x_size: u32,
        y_size: u32,
        x_count_chars: u32,
        y_count_chars: u32,
        fill_attribute: u32,
        flags: u32,
        show_window: u16,
        cb_reserved2: u16,
        reserved2: *mut u8,
        std_input: HANDLE,
        std_output: HANDLE,
        std_error: HANDLE,
    }

    /// PROCESS_INFORMATION
    #[repr(C)]
    struct ProcessInfo {
        process: HANDLE,
        thread: HANDLE,
        process_id: u32,
        thread_id: u32,
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateProcessW(
            application: *const u16,
            command_line: *mut u16,
            process_attributes: *const c_void,
            thread_attributes: *const c_void,
            inherit_handles: i32,
            creation_flags: u32,
            environment: *const c_void,
            current_directory: *const u16,
            startup_info: *const StartupInfo,
            process_information: *mut ProcessInfo,
        ) -> i32;
    }

    fn wide(text: &std::ffi::OsStr) -> Vec<u16> {
        text.encode_wide().chain(std::iter::once(0)).collect()
    }

    pub fn spawn(program: &Path, command_line: &str, cwd: &Path) -> std::io::Result<()> {
        let application = wide(program.as_os_str());
        let mut line = wide(std::ffi::OsStr::new(command_line));
        let directory = wide(cwd.as_os_str());
        // SAFETY: Both structs consist only of numbers and pointers; "all zero" is valid for them.
        let mut startup: StartupInfo = unsafe { std::mem::zeroed() };
        startup.cb = std::mem::size_of::<StartupInfo>() as u32;
        // SAFETY: as above.
        let mut info: ProcessInfo = unsafe { std::mem::zeroed() };
        // SAFETY: All pointers point to live, NUL-terminated buffers or to the
        // structs above; the command line is mutable, as CreateProcessW requires.
        // No handles are inherited and no environment is passed (our own applies).
        let ok = unsafe {
            CreateProcessW(
                application.as_ptr(),
                line.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                CREATE_NEW_CONSOLE | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT,
                std::ptr::null(),
                directory.as_ptr(),
                &startup,
                &mut info,
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: After success both handles belong to us and are only closed here.
        unsafe {
            CloseHandle(info.thread);
            CloseHandle(info.process);
        }
        Ok(())
    }
}

/// Starts the program detached: no inherited input/output, its own process group;
/// it keeps running when the app exits. Program not found → `not_found`.
pub fn launch(launch: &Launch) -> CoreResult<()> {
    let missing = || {
        CoreError::not_found(format!(
            "The program “{}” was not found. Check the command in Settings.",
            launch.program
        ))
    };
    let failed = |e: std::io::Error| match e.kind() {
        std::io::ErrorKind::NotFound => missing(),
        _ => CoreError::io(format!("“{}” could not be started: {e}", launch.program)),
    };
    let program = which::which(&launch.program).map_err(|_| missing())?;
    #[cfg(windows)]
    {
        let batch = program.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
        // Batch scripts are started by the standard library (it knows their quoting rules).
        if launch.terminal && !batch {
            let line = windows_command_line(&program.to_string_lossy(), &launch.args);
            return new_console::spawn(&program, &line, &launch.cwd).map_err(failed);
        }
    }
    let mut command = std::process::Command::new(&program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        for arg in &launch.args {
            match arg {
                LaunchArg::Plain(text) => command.arg(text),
                LaunchArg::Raw(text) => command.raw_arg(text),
            };
        }
        command.creation_flags(crate::git::runner::CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }
    #[cfg(not(windows))]
    {
        use std::os::unix::process::CommandExt;
        command.args(launch.arg_strings());
        command.process_group(0);
    }
    command.current_dir(&launch.cwd).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    command.envs(launch.env.iter().map(|(key, value)| (key, value)));
    let child = command.spawn().map_err(failed)?;
    // Unix: reap the finished process so that no zombie remains.
    #[cfg(unix)]
    std::thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
    });
    #[cfg(not(unix))]
    drop(child);
    Ok(())
}

/// Opens the repository (`path: None`) or a file or folder in it:
///
/// - `editor`: `Settings.external_editor` (template with `{path}`, otherwise the path is
///   appended). Without a setting: a folder in the file manager; a text or source file
///   (`TEXT_EXTENSIONS`) with the program associated with it; any other file is **not**
///   started via its association, but offered in the "Open with" dialog on Windows,
///   opened in the text editor on macOS (`open -t`) and shown in the file manager on Linux.
/// - `terminal`: `Settings.external_terminal` (the working directory is the folder; `{path}`
///   is substituted but not appended); without a setting Windows Terminal → PowerShell →
///   cmd, on Linux `$TERMINAL`, x-terminal-emulator, gnome-terminal, konsole,
///   xfce4-terminal, xterm, on macOS Terminal.app.
/// - `file_manager`: Explorer with the file selected, `open -R`, or `xdg-open` on the folder.
///
/// - `diff_tool`: `path` is required; `source` chooses the comparison (if not given: unstaged
///   changes). With `Settings.external_diff_tool` the command gets both versions as
///   files (`{local}`, `{remote}`; appended without placeholders), otherwise
///   `git difftool --no-prompt` starts with the tool configured in Git.
/// - `merge_tool`: `path` must be a conflicted file. With `Settings.external_merge_tool`
///   the command gets `{base}`, `{local}`, `{remote}` and `{merged}` (without placeholders
///   `{merged}` is appended), otherwise `git mergetool --no-prompt` starts.
///   Details in `tools`.
///
/// Errors: path outside the repository → `not_allowed`; file missing (editor) or
/// program not found → `not_found`; no diff/merge tool configured → `not_found`;
/// start fails → `io`.
pub async fn open_external(core: &Core, repo_id: String, target: ExternalTarget, path: Option<String>, source: Option<DiffSource>) -> CoreResult<()> {
    let root = core.repo_path(&repo_id)?;
    let settings = core.settings()?;
    if matches!(target, ExternalTarget::DiffTool | ExternalTarget::MergeTool) {
        let planned = tools::plan_tool(core, &repo_id, target, path.as_deref(), source, &settings).await?;
        if target == ExternalTarget::MergeTool {
            // Merge tools put a backup `<file>.orig` next to the file. Only such a one –
            // not one that was already there before – is cleaned up later by `conflict_resolve`.
            if let Some(rel) = path.as_deref().and_then(|p| normalize_rel_path(p).ok()) {
                let orig = util_orig_path(&root, &rel);
                if std::fs::symlink_metadata(&orig).is_err() {
                    core.state::<MergeToolRuns>().started.lock().insert((repo_id.clone(), rel));
                }
            }
        }
        return start(core, planned).await;
    }
    let mut item: Option<PathBuf> = None;
    if let Some(path) = path.as_deref().filter(|p| !p.trim().is_empty()) {
        let rel = normalize_rel_path(path)?;
        let mut full = root.clone();
        rel.split('/').for_each(|part| full.push(part));
        if target == ExternalTarget::Editor && !full.exists() {
            return Err(CoreError::not_found(format!("The file “{rel}” does not exist in the working directory.")));
        }
        // Terminal and file manager: if the file does not exist (any more), take the nearest existing folder.
        while !full.exists() && full != root {
            if !full.pop() {
                break;
            }
        }
        if full != root {
            item = Some(full);
        }
    }
    let item_is_dir = item.as_deref().is_some_and(Path::is_dir);
    let env_terminal = std::env::var("TERMINAL").ok();
    let request = OpenRequest { target, repo: &root, item: item.as_deref(), item_is_dir, env_terminal: env_terminal.as_deref() };
    let planned = plan(Platform::current(), &settings, &request, &program_exists)?;
    start(core, planned).await
}

/// Conflicted files for which an external merge tool was started in this session and
/// next to which there was no `.orig` file before: (repository, path).
#[derive(Default)]
pub struct MergeToolRuns {
    started: Mutex<std::collections::HashSet<(String, String)>>,
}

impl MergeToolRuns {
    /// Whether the merge tool ran for this file; the mark is consumed afterwards.
    pub fn take(&self, repo_id: &str, rel: &str) -> bool {
        self.started.lock().remove(&(repo_id.to_string(), rel.to_string()))
    }
}

fn util_orig_path(root: &Path, rel: &str) -> PathBuf {
    let mut full = root.to_path_buf();
    rel.split('/').for_each(|part| full.push(part));
    let mut name = full.into_os_string();
    name.push(".orig");
    PathBuf::from(name)
}

/// Starts the planned call – or only remembers it (test mode, `set_dry_run`).
async fn start(core: &Core, planned: Launch) -> CoreResult<()> {
    let state = core.state::<ExternalState>();
    if state.dry_run.load(Ordering::SeqCst) {
        state.launched.lock().push(planned);
        return Ok(());
    }
    tokio::task::spawn_blocking(move || launch(&planned))
        .await
        .map_err(|e| CoreError::io(format!("Starting the program was aborted: {e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use crate::testkit::{TestCore, TestRepo};
    use serde_json::json;

    fn split(line: &str, escapes: bool) -> Vec<String> {
        split_command_line(line, escapes).unwrap()
    }

    #[test]
    fn splits_command_lines_without_a_shell() {
        assert_eq!(split("code --wait {path}", false), ["code", "--wait", "{path}"]);
        assert_eq!(split("  a   b\tc\n", true), ["a", "b", "c"]);
        assert_eq!(split(r#""C:\Program Files\Editor\ed.exe" -n "{path}""#, false), [r"C:\Program Files\Editor\ed.exe", "-n", "{path}"]);
        // A folder at the end of a quoted argument: the backslash stays literal.
        assert_eq!(split(r#"x "C:\Ordner\" y"#, false), ["x", r"C:\Ordner\", "y"]);
        assert_eq!(split(r#""C:\a b\\c" "\\server\x y""#, false), [r"C:\a b\\c", r"\\server\x y"]);
        assert_eq!(split(r#"x "a \"b\" c\\" 'd\' "e\f""#, true), ["x", r#"a "b" c\"#, r"d\", r"e\f"]);
        assert_eq!(split(r"\\server\freigabe\ed.exe a", false), [r"\\server\freigabe\ed.exe", "a"]);
        assert_eq!(split("'/opt/mein editor/ed' --flag='a b' ''", true), ["/opt/mein editor/ed", "--flag=a b", ""]);
        assert_eq!(split(r"/opt/mein\ editor/ed a\\b", true), ["/opt/mein editor/ed", r"a\b"]);
        assert_eq!(split(r#"pre"mit te"post"#, true), ["premit tepost"]);
        // Shell characters have no meaning.
        assert_eq!(split("ed {path}; rm -rf ~ && echo $HOME | x > y `z`", true), ["ed", "{path};", "rm", "-rf", "~", "&&", "echo", "$HOME", "|", "x", ">", "y", "`z`"]);
        assert!(split("", true).is_empty() && split("   ", false).is_empty());
        for bad in [r#"ed "offen"#, "ed 'offen", r#"ed "a\""#] {
            assert_eq!(split_command_line(bad, true).unwrap_err().code, ErrorCode::NotAllowed, "{bad}");
        }
    }

    #[test]
    fn placeholders_are_replaced_after_splitting() {
        let nasty = r#"C:\Mein Repo\a "b" & del x; $(y) %PATH%.txt"#;
        let args = expand_template("code --goto {path} --folder={repo}", nasty, r"C:\Mein Repo", true, Platform::Windows).unwrap();
        assert_eq!(args, ["code", "--goto", nasty, r"--folder=C:\Mein Repo"]);
        // Without a placeholder the path is appended (editor) or not (terminal).
        assert_eq!(expand_template("vim -p", "/r/a b", "/r", true, Platform::Linux).unwrap(), ["vim", "-p", "/r/a b"]);
        assert_eq!(expand_template("kitty --single-instance", "/r", "/r", false, Platform::Linux).unwrap(), ["kitty", "--single-instance"]);
        assert_eq!(expand_template("ed '{path}:1' {path}", "/r/x", "/r", true, Platform::Linux).unwrap(), ["ed", "/r/x:1", "/r/x"]);
        for empty in ["", "   ", "\"\" {path}"] {
            assert_eq!(expand_template(empty, "/p", "/r", true, Platform::Linux).unwrap_err().code, ErrorCode::NotAllowed);
        }
    }

    fn request<'a>(target: ExternalTarget, repo: &'a Path, item: Option<&'a Path>, dir: bool) -> OpenRequest<'a> {
        OpenRequest { target, repo, item, item_is_dir: dir, env_terminal: None }
    }

    #[test]
    fn plans_editor_and_file_manager_per_platform() {
        let defaults = Settings::default();
        let none = |_: &str| false;
        let repo = Path::new("/home/a/Mein Repo");
        let file = repo.join("src").join("Größe.rs");
        let shown = |p: &Path| arg_path(p);

        let l = plan(Platform::Linux, &defaults, &request(ExternalTarget::Editor, repo, Some(&file), false), &none).unwrap();
        assert_eq!((l.program.as_str(), l.arg_strings(), l.terminal), ("xdg-open", vec![shown(&file).as_str()], false));
        let l = plan(Platform::Mac, &defaults, &request(ExternalTarget::Editor, repo, None, false), &none).unwrap();
        assert_eq!((l.program.as_str(), l.arg_strings()), ("open", vec![shown(repo).as_str()]));
        // macOS opens files in the text editor, never via the association.
        let l = plan(Platform::Mac, &defaults, &request(ExternalTarget::Editor, repo, Some(&file), false), &none).unwrap();
        assert_eq!((l.program.as_str(), l.arg_strings()), ("open", vec!["-t", shown(&file).as_str()]));
        // Windows offers the "Open with" dialog for everything that is not text; Linux shows the folder.
        let script = repo.join("werk zeug").join("start.bat");
        let l = plan(Platform::Windows, &defaults, &request(ExternalTarget::Editor, repo, Some(&script), false), &none).unwrap();
        assert_eq!(l.program, "rundll32.exe");
        assert_eq!(l.args, [LaunchArg::Raw(format!("shell32.dll,OpenAs_RunDLL {}", shown(&script)))]);
        let l = plan(Platform::Linux, &defaults, &request(ExternalTarget::Editor, repo, Some(&script), false), &none).unwrap();
        assert_eq!((l.program.as_str(), l.arg_strings()), ("xdg-open", vec![shown(&repo.join("werk zeug")).as_str()]));
        // Folders still go to the file manager, dot files count by their name.
        let l = plan(Platform::Windows, &defaults, &request(ExternalTarget::Editor, repo, Some(&repo.join("src")), true), &none).unwrap();
        assert_eq!(l.program, "explorer.exe");
        assert!(is_plain_text_file(Path::new("/r/.gitignore")) && is_plain_text_file(Path::new("/r/LIESMICH.TXT")));
        assert!(!is_plain_text_file(Path::new("/r/Makefile")) && !is_plain_text_file(Path::new("/r/a.txt.exe")));
        let l = plan(Platform::Windows, &defaults, &request(ExternalTarget::Editor, repo, Some(&file), false), &none).unwrap();
        assert_eq!(l.program, "explorer.exe");
        assert_eq!(l.args, [LaunchArg::Raw(format!("\"{}\"", shown(&file)))]);

        let custom = Settings { external_editor: Some("\"my editor\" --reuse {path}".into()), ..Settings::default() };
        let l = plan(Platform::Linux, &custom, &request(ExternalTarget::Editor, repo, Some(&file), false), &none).unwrap();
        assert_eq!((l.program.as_str(), l.arg_strings()), ("my editor", vec!["--reuse", shown(&file).as_str()]));
        assert_eq!(l.cwd, repo);
        // Without a file: the repository itself.
        let l = plan(Platform::Linux, &custom, &request(ExternalTarget::Editor, repo, None, false), &none).unwrap();
        assert_eq!(l.arg_strings(), ["--reuse", shown(repo).as_str()]);

        // File manager: select the file where the system can.
        let l = plan(Platform::Windows, &defaults, &request(ExternalTarget::FileManager, repo, Some(&file), false), &none).unwrap();
        assert_eq!(l.args, [LaunchArg::Raw(format!("/select,\"{}\"", shown(&file)))]);
        let l = plan(Platform::Windows, &defaults, &request(ExternalTarget::FileManager, repo, Some(&repo.join("src")), true), &none).unwrap();
        assert_eq!(l.args, [LaunchArg::Raw(format!("\"{}\"", shown(&repo.join("src"))))]);
        let l = plan(Platform::Windows, &defaults, &request(ExternalTarget::FileManager, repo, None, false), &none).unwrap();
        assert_eq!(l.args, [LaunchArg::Raw(format!("\"{}\"", shown(repo)))]);
        let l = plan(Platform::Mac, &defaults, &request(ExternalTarget::FileManager, repo, Some(&file), false), &none).unwrap();
        assert_eq!((l.program.as_str(), l.arg_strings()), ("open", vec!["-R", shown(&file).as_str()]));
        let l = plan(Platform::Linux, &defaults, &request(ExternalTarget::FileManager, repo, Some(&file), false), &none).unwrap();
        assert_eq!((l.program.as_str(), l.arg_strings()), ("xdg-open", vec![shown(&repo.join("src")).as_str()]));
    }

    /// Without a configured editor a file must never be started via the file type association
    /// – for `.bat`, `.lnk`, `.js`, `.desktop`, `.command` that would mean running it.
    #[test]
    fn sec05_editor_without_setting_never_runs_a_file_through_its_association() {
        let defaults = Settings::default();
        let none = |_: &str| false;
        let repo = Path::new("/home/a/Mein Repo");
        for name in ["start.bat", "setup.cmd", "werkzeug.exe", "klick.lnk", "skript.js", "makro.vbs", "seite.hta", "paket.msi", "eintrag.reg", "lauf.ps1", "ohne-endung", "bild.png"] {
            let file = repo.join(name);
            let l = plan(Platform::Windows, &defaults, &request(ExternalTarget::Editor, repo, Some(&file), false), &none).unwrap();
            let runs_it = l.program.eq_ignore_ascii_case("explorer.exe") && l.args == [LaunchArg::Raw(format!("\"{}\"", arg_path(&file)))];
            assert!(!runs_it, "{name}: explorer.exe <file> starts the associated application");
        }
        for name in ["start.desktop", "lauf.sh", "programm", "paket.AppImage", "skript.py"] {
            let file = repo.join(name);
            let l = plan(Platform::Linux, &defaults, &request(ExternalTarget::Editor, repo, Some(&file), false), &none).unwrap();
            assert!(!(l.program == "xdg-open" && l.arg_strings() == [arg_path(&file).as_str()]), "{name}: xdg-open <file>");
        }
        for name in ["start.command", "Programm.app", "skript.sh", "werkzeug"] {
            let file = repo.join(name);
            let l = plan(Platform::Mac, &defaults, &request(ExternalTarget::Editor, repo, Some(&file), false), &none).unwrap();
            assert!(!(l.program == "open" && l.arg_strings() == [arg_path(&file).as_str()]), "{name}: open <file>");
        }
    }

    #[test]
    fn plans_the_terminal_per_platform() {
        let defaults = Settings::default();
        let repo = Path::new("/home/a/Mein Repo");
        let sub = repo.join("src");
        let file = sub.join("main.rs");
        let shown = |p: &Path| arg_path(p);
        let term = |platform, item: Option<&Path>, dir, env: Option<&str>, known: &[&str]| {
            let known: Vec<String> = known.iter().map(|k| k.to_string()).collect();
            let has = move |p: &str| known.iter().any(|k| k == p);
            let req = OpenRequest { target: ExternalTarget::Terminal, repo, item, item_is_dir: dir, env_terminal: env };
            plan(platform, &defaults, &req, &has)
        };

        // Windows: Windows Terminal → PowerShell → cmd.
        let l = term(Platform::Windows, None, false, None, &["wt.exe", "pwsh.exe"]).unwrap();
        assert_eq!((l.program.as_str(), l.arg_strings(), l.terminal), ("wt.exe", vec!["-d", shown(repo).as_str()], true));
        assert_eq!(term(Platform::Windows, None, false, None, &["pwsh.exe", "powershell.exe"]).unwrap().program, "pwsh.exe");
        assert_eq!(term(Platform::Windows, None, false, None, &["powershell.exe"]).unwrap().program, "powershell.exe");
        let l = term(Platform::Windows, Some(&file), false, None, &[]).unwrap();
        assert_eq!((l.program.as_str(), l.cwd.as_path(), l.args.len()), ("cmd.exe", sub.as_path(), 0));

        // Linux: $TERMINAL first, then the usual names; the working directory is the file's folder.
        let l = term(Platform::Linux, Some(&file), false, Some("kitty"), &["kitty", "xterm"]).unwrap();
        assert_eq!((l.program.as_str(), l.cwd.as_path()), ("kitty", sub.as_path()));
        assert_eq!(term(Platform::Linux, None, false, Some("fehlt"), &["x-terminal-emulator", "xterm"]).unwrap().program, "x-terminal-emulator");
        let l = term(Platform::Linux, Some(&sub), true, None, &["gnome-terminal", "konsole"]).unwrap();
        assert_eq!((l.program.as_str(), l.arg_strings()), ("gnome-terminal", vec![format!("--working-directory={}", shown(&sub)).as_str()]));
        let l = term(Platform::Linux, None, false, None, &["konsole"]).unwrap();
        assert_eq!(l.arg_strings(), ["--workdir", shown(repo).as_str()]);
        assert_eq!(term(Platform::Linux, None, false, None, &["xterm"]).unwrap().program, "xterm");
        let err = term(Platform::Linux, None, false, None, &[]).unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        assert!(err.message.contains("terminal"));

        let l = term(Platform::Mac, Some(&file), false, None, &[]).unwrap();
        assert_eq!((l.program.as_str(), l.arg_strings()), ("open", vec!["-a", "Terminal", shown(&sub).as_str()]));

        // Own template: {path} is the folder and is not appended.
        let none = |_: &str| false;
        let custom = Settings { external_terminal: Some("alacritty --working-directory {path}".into()), ..Settings::default() };
        let l = plan(Platform::Linux, &custom, &request(ExternalTarget::Terminal, repo, Some(&file), false), &none).unwrap();
        assert_eq!((l.program.as_str(), l.arg_strings(), l.terminal), ("alacritty", vec!["--working-directory", shown(&sub).as_str()], true));
        let plain = Settings { external_terminal: Some("kitty".into()), ..Settings::default() };
        let l = plan(Platform::Linux, &plain, &request(ExternalTarget::Terminal, repo, None, false), &none).unwrap();
        assert!(l.args.is_empty() && l.cwd == repo);
        let broken = Settings { external_terminal: Some("kitty \"offen".into()), ..Settings::default() };
        let err = plan(Platform::Linux, &broken, &request(ExternalTarget::Terminal, repo, None, false), &none).unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
    }

    #[test]
    fn windows_command_lines_are_quoted_like_the_system_expects() {
        let plain = |items: &[&str]| items.iter().map(|a| LaunchArg::Plain(a.to_string())).collect::<Vec<_>>();
        assert_eq!(windows_command_line(r"C:\Windows\System32\cmd.exe", &[]), r"C:\Windows\System32\cmd.exe");
        assert_eq!(
            windows_command_line(r"C:\Program Files\wt\wt.exe", &plain(&["-d", r"C:\Mein Repo", ""])),
            r#""C:\Program Files\wt\wt.exe" -d "C:\Mein Repo" """#
        );
        // A backslash before the closing quote is doubled, otherwise the argument would stay open.
        assert_eq!(windows_command_line("t", &plain(&[r"C:\Mein Ordner\", r"C:\ohne\"])), r#"t "C:\Mein Ordner\\" C:\ohne\"#);
        assert_eq!(windows_command_line("t", &plain(&[r#"a "b" \" c\\"#])), r#"t "a \"b\" \\\" c\\\\""#);
        assert_eq!(windows_command_line("e", &[LaunchArg::Raw(r#"/select,"C:\a b\c.txt""#.into())]), r#"e /select,"C:\a b\c.txt""#);
    }

    #[test]
    fn verbatim_prefix_is_removed_from_arguments() {
        if cfg!(windows) {
            assert_eq!(arg_path(Path::new(r"\\?\C:\Repo\a.txt")), r"C:\Repo\a.txt");
            assert_eq!(arg_path(Path::new(r"\\?\UNC\server\freigabe\a.txt")), r"\\server\freigabe\a.txt");
            assert_eq!(arg_path(Path::new("C:/Repo/sub/a.txt")), r"C:\Repo\sub\a.txt");
        }
    }

    async fn setup(repo: &TestRepo) -> (TestCore, String) {
        let tc = TestCore::new().await;
        let id = tc.open(repo).await.repo.id;
        tc.state::<ExternalState>().set_dry_run(true);
        (tc, id)
    }

    #[tokio::test]
    async fn open_external_resolves_paths_and_uses_the_settings() {
        let repo = TestRepo::with_commit();
        repo.write_file("Mein Ordner/Größe 1.txt", "x");
        let (tc, id) = setup(&repo).await;
        let state = tc.state::<ExternalState>();
        let root = arg_path(&tc.repo_path(&id).unwrap());
        let file = arg_path(&tc.repo_path(&id).unwrap().join("Mein Ordner").join("Größe 1.txt"));
        let folder = arg_path(&tc.repo_path(&id).unwrap().join("Mein Ordner"));

        crate::commands::settings::settings_set(&tc, json!({ "externalEditor": "mein-editor --datei {path} --repo {repo}", "externalTerminal": "mein-terminal" }))
            .await
            .unwrap();
        open_external(&tc, id.clone(), ExternalTarget::Editor, Some("Mein Ordner/Größe 1.txt".into()), None).await.unwrap();
        open_external(&tc, id.clone(), ExternalTarget::Editor, None, None).await.unwrap();
        open_external(&tc, id.clone(), ExternalTarget::Terminal, Some("Mein Ordner/Größe 1.txt".into()), None).await.unwrap();
        // Deleted file: terminal and file manager take the nearest existing folder.
        open_external(&tc, id.clone(), ExternalTarget::Terminal, Some("Mein Ordner/weg/fehlt.txt".into()), None).await.unwrap();
        open_external(&tc, id.clone(), ExternalTarget::Terminal, Some("fehlt.txt".into()), None).await.unwrap();
        let launched = state.take_launched();
        assert_eq!(launched.len(), 5);
        assert_eq!((launched[0].program.as_str(), launched[0].arg_strings()), ("mein-editor", vec!["--datei", file.as_str(), "--repo", root.as_str()]));
        assert_eq!(launched[1].arg_strings(), ["--datei", root.as_str(), "--repo", root.as_str()]);
        assert_eq!((launched[2].program.as_str(), arg_path(&launched[2].cwd), launched[2].terminal), ("mein-terminal", folder.clone(), true));
        assert_eq!(arg_path(&launched[3].cwd), folder);
        assert_eq!(arg_path(&launched[4].cwd), root);

        // File manager with the file or folder selected.
        open_external(&tc, id.clone(), ExternalTarget::FileManager, Some("Mein Ordner/Größe 1.txt".into()), None).await.unwrap();
        open_external(&tc, id.clone(), ExternalTarget::FileManager, None, None).await.unwrap();
        let launched = state.take_launched();
        if cfg!(windows) {
            assert_eq!(launched[0].args, [LaunchArg::Raw(format!("/select,\"{file}\""))]);
            assert_eq!(launched[1].args, [LaunchArg::Raw(format!("\"{root}\""))]);
        }
        assert!(launched[0].arg_strings().iter().any(|a| a.contains("Mein Ordner")));

        // Error cases: nothing is started.
        let err = open_external(&tc, id.clone(), ExternalTarget::Editor, Some("fehlt.txt".into()), None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        for bad in ["../draußen", "/etc/passwd", "a/../../b"] {
            let err = open_external(&tc, id.clone(), ExternalTarget::Editor, Some(bad.into()), None).await.unwrap_err();
            assert_eq!(err.code, ErrorCode::NotAllowed, "{bad}");
        }
        assert_eq!(open_external(&tc, "unbekannt".into(), ExternalTarget::Terminal, None, None).await.unwrap_err().code, ErrorCode::NotFound);
        crate::commands::settings::settings_set(&tc, json!({ "externalEditor": "ed \"offen" })).await.unwrap();
        assert_eq!(open_external(&tc, id.clone(), ExternalTarget::Editor, None, None).await.unwrap_err().code, ErrorCode::NotAllowed);
        assert!(state.take_launched().is_empty());
    }

    #[tokio::test]
    async fn open_external_without_settings_uses_the_system_default() {
        let repo = TestRepo::with_commit();
        let (tc, id) = setup(&repo).await;
        let state = tc.state::<ExternalState>();
        open_external(&tc, id.clone(), ExternalTarget::Editor, Some("README.md".into()), None).await.unwrap();
        let launched = state.take_launched();
        let expected = match Platform::current() {
            Platform::Windows => "explorer.exe",
            Platform::Linux => "xdg-open",
            Platform::Mac => "open",
        };
        assert_eq!(launched[0].program, expected);
        // The file is the last argument (macOS puts `-t` before it).
        assert!(launched[0].arg_strings().last().unwrap().trim_end_matches('"').ends_with("README.md"));
        // An empty path counts as "the repository itself".
        open_external(&tc, id.clone(), ExternalTarget::Editor, Some("  ".into()), None).await.unwrap();
        assert_eq!(state.take_launched()[0].arg_strings()[0].trim_matches('"'), arg_path(&tc.repo_path(&id).unwrap()));
    }

    /// A console program started as a terminal gets a real console as input
    /// (with redirected, empty input a shell would exit immediately).
    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "briefly opens a console window; by hand: cargo test -p gitcore --lib -- --ignored terminal_gets_a_real_console"]
    async fn terminal_gets_a_real_console() {
        let dir = tempfile::tempdir().unwrap();
        let result = dir.path().join("konsole.txt");
        let script = format!("[Console]::IsInputRedirected | Out-File -Encoding ascii -FilePath '{}'", result.display());
        let args = ["-NoProfile", "-Command", script.as_str()];
        launch(&Launch::new("powershell.exe", &args, dir.path(), true)).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        while std::fs::read_to_string(&result).map(|t| t.trim().is_empty()).unwrap_or(true) && std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert_eq!(std::fs::read_to_string(&result).unwrap().trim(), "False", "the terminal's input is redirected");
    }

    #[tokio::test]
    async fn launching_reports_missing_programs_and_really_starts_existing_ones() {
        let repo = TestRepo::with_commit();
        let tc = TestCore::new().await;
        let id = tc.open(&repo).await.repo.id;

        crate::commands::settings::settings_set(&tc, json!({ "externalEditor": "gibt-es-ganz-sicher-nicht-4711 {path}" })).await.unwrap();
        let err = open_external(&tc, id.clone(), ExternalTarget::Editor, None, None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        assert!(err.message.contains("gibt-es-ganz-sicher-nicht-4711"), "{}", err.message);

        // Really start a harmless program: Git writes a file into the repository.
        // The path with spaces must arrive as one argument.
        repo.subdir("Ziel Ordner");
        crate::commands::settings::settings_set(&tc, json!({ "externalEditor": "git init -q {path}" })).await.unwrap();
        open_external(&tc, id.clone(), ExternalTarget::Editor, Some("Ziel Ordner".into()), None).await.unwrap();
        let marker = repo.path().join("Ziel Ordner").join(".git").join("HEAD");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
        while !marker.exists() && std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(marker.exists(), "the started program did nothing");
    }
}
