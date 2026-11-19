//! The helper program for the todo file: the app (or `forkyard-editor`) as Git's sequence editor.

use super::*;

// ---------------------------------------------------------------------------
// Helper program for the todo file
// ---------------------------------------------------------------------------

/// Environment variable with the path of the prepared todo file. If it is set,
/// the program works as a sequence editor (see `editor_helper_entry`).
pub const SEQUENCE_TODO_ENV: &str = "FORKYARD_SEQUENCE_TODO";
/// Fixed path to the helper program instead of searching for it.
pub const EDITOR_HELPER_ENV: &str = "FORKYARD_EDITOR_HELPER";
/// Name of the standalone helper program (without extension).
pub const EDITOR_HELPER_NAME: &str = "forkyard-editor";
/// Name of the file Git passes to the sequence editor.
pub(super) const GIT_TODO_FILE: &str = "git-rebase-todo";

/// The running program calls `editor_helper_entry`, so it can be the sequence editor itself.
pub(super) static HOST_IS_HELPER: AtomicBool = AtomicBool::new(false);

/// Fixed path to the helper program, per core (tests, special embeddings).
#[derive(Default)]
pub struct EditorHelper {
    pub(super) program: parking_lot::Mutex<Option<PathBuf>>,
}

/// Sets the helper program for this core; `None` restores the search.
pub fn set_editor_helper(core: &Core, program: Option<PathBuf>) {
    *core.state::<EditorHelper>().program.lock() = program;
}

/// Entry point for every program that is meant to serve as a sequence editor – call it first
/// in `main`. Git starts it as `<program> <path of the todo file>`; if
/// `FORKYARD_SEQUENCE_TODO` is set, the prepared file is copied there and the
/// exit code is returned (the program then exits with it). Otherwise `None`: the
/// program starts normally and remembers that it can serve as the editor itself.
pub fn editor_helper_entry() -> Option<i32> {
    match std::env::var_os(SEQUENCE_TODO_ENV).filter(|v| !v.is_empty()) {
        Some(source) => Some(copy_todo(Path::new(&source), std::env::args_os().nth(1))),
        None => {
            HOST_IS_HELPER.store(true, Ordering::SeqCst);
            None
        }
    }
}

/// Copies the prepared todo file to the place Git names. Other files are not
/// touched: then the rebase fails instead of running the default plan.
pub(super) fn copy_todo(source: &Path, target: Option<OsString>) -> i32 {
    let Some(target) = target.map(PathBuf::from) else {
        eprintln!("{EDITOR_HELPER_NAME}: Git didn't name a todo file.");
        return 2;
    };
    if target.file_name().and_then(|n| n.to_str()) != Some(GIT_TODO_FILE) {
        eprintln!("{EDITOR_HELPER_NAME}: unexpected file {}", target.display());
        return 1;
    }
    match std::fs::read(source).and_then(|content| std::fs::write(&target, content)) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("{EDITOR_HELPER_NAME}: {} -> {}: {e}", source.display(), target.display());
            1
        }
    }
}

/// Looks for the helper program: fixed path (core, then environment), the running program
/// itself, otherwise `forkyard-editor` next to the running program (one level up in tests).
pub(super) fn find_editor_helper(core: &Core) -> CoreResult<PathBuf> {
    let fixed = core.state::<EditorHelper>().program.lock().clone();
    let fixed = fixed.or_else(|| util::dev_env(EDITOR_HELPER_ENV).map(PathBuf::from));
    if let Some(program) = fixed {
        // Without this check Git might find another program of the same name via PATH.
        return if program.is_file() { Ok(program) } else { Err(helper_missing(&util::display_path(&program))) };
    }
    let exe = std::env::current_exe().map_err(|e| CoreError::io(format!("Can't read the app's path: {e}")))?;
    if HOST_IS_HELPER.load(Ordering::SeqCst) {
        return Ok(exe);
    }
    let file = format!("{EDITOR_HELPER_NAME}{}", std::env::consts::EXE_SUFFIX);
    let dir = exe.parent().unwrap_or(Path::new("."));
    let mut places = vec![dir.join(&file)];
    if dir.file_name().is_some_and(|n| n == "deps") {
        if let Some(parent) = dir.parent() {
            places.push(parent.join(&file));
        }
    }
    places.into_iter().find(|p| p.is_file()).ok_or_else(|| helper_missing(&file))
}

pub(super) fn helper_missing(program: &str) -> CoreError {
    CoreError::unsupported(format!("The helper program “{program}” for interactive rebase wasn't found. It has to be next to the app."))
}

/// How Git invokes the helper program.
pub(super) struct EditorCall {
    /// Value for `GIT_SEQUENCE_EDITOR`.
    pub(super) command: String,
    /// New `PATH` if the program is found by its bare name.
    pub(super) path: Option<OsString>,
}

/// Git only starts an editor without a shell if the command contains no special
/// characters – a path with spaces or backslashes does. Hence the bare
/// program name, with its folder prepended to `PATH`. If that doesn't work (name with
/// special characters), the route via the shell that Git brings along remains.
pub(super) fn editor_call(program: &Path) -> EditorCall {
    let file = program.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let name = if cfg!(windows) && file.to_ascii_lowercase().ends_with(".exe") { &file[..file.len() - 4] } else { file.as_str() };
    let dir = program.parent().filter(|d| !d.as_os_str().is_empty());
    if let (true, Some(dir)) = (is_plain_word(name), dir) {
        let mut dirs = vec![dir.to_path_buf()];
        if let Some(current) = std::env::var_os("PATH") {
            dirs.extend(std::env::split_paths(&current));
        }
        if let Ok(path) = std::env::join_paths(dirs) {
            return EditorCall { command: name.to_string(), path: Some(path) };
        }
    }
    EditorCall { command: sh_quote(&program.to_string_lossy().replace('\\', "/")), path: None }
}

pub(super) fn is_plain_word(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '+'))
}

/// Wrap in single quotes, for `sh`.
pub(super) fn sh_quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', "'\\''"))
}
