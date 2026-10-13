// No console window on Windows in the release build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // During an interactive rebase Git starts this program as the sequence editor; then just write the todo file.
    if let Some(code) = gitcore::commands::rebase::editor_helper_entry() {
        std::process::exit(code);
    }
    forkyard_lib::run()
}
