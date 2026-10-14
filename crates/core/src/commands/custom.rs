//! Custom commands (api.ts: `customCommands*`, `customCommandRun`).
//!
//! Two sources: the user's own commands (global, stored as JSON in `app_settings`) and the
//! repository file `.forkyard/commands.json`. A repository command only runs after the user has
//! approved exactly this version of the file (SHA-256 of its bytes, stored in `repo_settings`);
//! every change needs a new approval.
//!
//! Nothing is ever put together into a shell string: `shell` commands are split into program and
//! arguments first and every placeholder becomes part of exactly one argument (`expand`); with
//! `shell: true` (global only) the values travel as environment variables. `git` commands go
//! through the Git runner and the write queue, and no value may become an option of Git. `url`
//! commands only produce an encoded http(s) address that the UI opens in the browser.

pub mod definition;
pub mod expand;

#[cfg(test)]
mod tests;

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::app::Core;
use crate::db;
use crate::error::{CoreError, CoreResult};
use crate::model::{AppChange, CustomCommandDef, CustomCommandEntry, CustomCommandList, CustomCommandSource};
use crate::util;

/// Key in `app_settings` under which the user's own commands are stored (same format as a file).
const GLOBAL_KEY: &str = "customCommands";

fn entry(source: CustomCommandSource, command: CustomCommandDef, runnable: bool) -> CustomCommandEntry {
    let prefix = match source {
        CustomCommandSource::Global => "global",
        CustomCommandSource::Repo => "repo",
    };
    CustomCommandEntry { key: format!("{prefix}:{}", command.id), source, command, runnable }
}

/// A command list in the file format.
fn file_value(commands: &[CustomCommandDef]) -> serde_json::Value {
    serde_json::json!({ "version": definition::FORMAT_VERSION, "commands": commands })
}

/// The user's own commands. What no longer passes the checks (stored by an older version) is left out.
fn load_global(core: &Core) -> CoreResult<Vec<CustomCommandDef>> {
    let stored = core.db.with(|c| Ok(db::app_settings::get_all(c)?.into_iter().find(|(key, _)| key == GLOBAL_KEY).map(|(_, value)| value)))?;
    let Some(value) = stored else { return Ok(Vec::new()) };
    Ok(definition::parse_file(&serde_json::to_vec(&value)?, CustomCommandSource::Global).commands)
}

fn check_global(commands: &[CustomCommandDef]) -> CoreResult<()> {
    if commands.len() > definition::MAX_COMMANDS {
        return Err(CoreError::not_allowed(format!("At most {} custom commands are possible.", definition::MAX_COMMANDS)));
    }
    let mut ids = HashSet::new();
    for command in commands {
        definition::validate(command, CustomCommandSource::Global).map_err(|reason| CoreError::not_allowed(format!("Command “{}”: {reason}", command.id)))?;
        if !ids.insert(command.id.as_str()) {
            return Err(CoreError::not_allowed(format!("The ID “{}” is used by two commands.", command.id)));
        }
    }
    Ok(())
}

fn full_path(path: &str) -> CoreResult<PathBuf> {
    let target = PathBuf::from(path.trim());
    if !target.is_absolute() {
        return Err(CoreError::not_allowed("Custom commands are imported from and exported to a full path only."));
    }
    Ok(target)
}

/// The user's own commands; with `repo_id` the repository must be usable (trusted, present).
pub async fn custom_commands_list(core: &Core, repo_id: Option<String>) -> CoreResult<CustomCommandList> {
    let commands = load_global(core)?.into_iter().map(|command| entry(CustomCommandSource::Global, command, true)).collect();
    if let Some(repo_id) = &repo_id {
        core.repo_path(repo_id)?;
    }
    Ok(CustomCommandList { commands, repo: None })
}

/// Replaces the user's own commands. Every command is checked; one invalid command rejects the
/// whole list (`not_allowed`, naming it) and nothing changes.
pub async fn custom_commands_save(core: &Core, commands: Vec<CustomCommandDef>) -> CoreResult<Vec<CustomCommandDef>> {
    check_global(&commands)?;
    core.db.with(|c| db::app_settings::set(c, GLOBAL_KEY, &file_value(&commands)))?;
    core.emit_app_changed(&[AppChange::CustomCommands]);
    load_global(core)
}

/// Reads commands from a file (`path` absolute, from the open dialog) – not saved yet. All or
/// nothing: any rejected command makes it `not_allowed` with every reason.
pub async fn custom_commands_import(core: &Core, path: String) -> CoreResult<Vec<CustomCommandDef>> {
    let _ = core;
    let source = full_path(&path)?;
    if std::fs::metadata(&source)?.len() > definition::MAX_FILE_BYTES as u64 {
        return Err(CoreError::not_allowed(format!("The file is larger than {} KiB.", definition::MAX_FILE_BYTES / 1024)));
    }
    let parsed = definition::parse_file(&std::fs::read(&source)?, CustomCommandSource::Global);
    if !parsed.problems.is_empty() {
        return Err(CoreError::not_allowed(format!("The file can’t be imported:\n{}", parsed.problems.join("\n"))));
    }
    Ok(parsed.commands)
}

/// Writes the user's own commands to `path` (absolute, from the save dialog) in the file format.
pub async fn custom_commands_export(core: &Core, path: String) -> CoreResult<()> {
    let target = full_path(&path)?;
    if target.is_dir() {
        return Err(CoreError::not_allowed(format!("“{}” is a folder.", util::display_path(&target))));
    }
    if !target.parent().is_some_and(Path::is_dir) {
        return Err(CoreError::not_found(format!("The folder for “{}” doesn’t exist.", util::display_path(&target))));
    }
    let mut text = serde_json::to_string_pretty(&file_value(&load_global(core)?))?;
    text.push('\n');
    util::write_file_atomic(&target, text.as_bytes()).map_err(|e| CoreError::io(format!("The custom commands couldn’t be exported: {e}")))
}
