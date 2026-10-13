//! Sequence editor for interactive rebase: Git starts this program with the path of its
//! todo file, and it puts the file prepared by the core there
//! (`gitcore::commands::rebase::editor_helper_entry`). The app itself can take on the same
//! role; this program is for tests and for embeddings without the app.

// No console window on Windows.
#![cfg_attr(windows, windows_subsystem = "windows")]

use gitcore::commands::rebase::{editor_helper_entry, EDITOR_HELPER_NAME, SEQUENCE_TODO_ENV};

fn main() {
    let code = editor_helper_entry().unwrap_or_else(|| {
        eprintln!("{EDITOR_HELPER_NAME}: is started by Git as the sequence editor ({SEQUENCE_TODO_ENV} is missing).");
        2
    });
    std::process::exit(code);
}
