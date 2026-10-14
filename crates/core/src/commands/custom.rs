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
use crate::model::{AppChange, CustomCommandDef, CustomCommandEntry, CustomCommandList, CustomCommandSource, RepoCommands, RepoCommandsState};
use crate::util;
use serde::{Deserialize, Serialize};

/// Key in `app_settings` under which the user's own commands are stored (same format as a file).
const GLOBAL_KEY: &str = "customCommands";

/// Key in `repo_settings`: the approved version of the repository file.
const TRUST_KEY: &str = "customCommandsTrust";

/// What the user approved: the hash, and the text so that a changed file can say what changed.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct TrustRecord {
    hash: String,
    content: String,
}

enum RepoFile {
    Missing,
    /// There is something, but it is not read (a link, too large, unreadable) – the reason.
    Unusable(String),
    Present(Vec<u8>),
}

/// Reads `.forkyard/commands.json` from the working directory. Links are not followed – neither
/// for the folder nor for the file – so the file cannot point outside the repository.
fn read_repo_file(root: &Path) -> RepoFile {
    let unreadable = |e: &std::io::Error| RepoFile::Unusable(format!("{} couldn’t be read. {}", definition::REPO_FILE, crate::error::describe_io(e).1));
    let folder = root.join(".forkyard");
    match std::fs::symlink_metadata(&folder) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return RepoFile::Missing,
        Err(e) => return unreadable(&e),
        Ok(meta) if !meta.is_dir() => return RepoFile::Unusable(".forkyard is not a regular folder (links are not followed).".to_string()),
        Ok(_) => {}
    }
    let path = folder.join("commands.json");
    let meta = match std::fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return RepoFile::Missing,
        Err(e) => return unreadable(&e),
        Ok(meta) => meta,
    };
    if !meta.file_type().is_file() {
        return RepoFile::Unusable(format!("{} is not a regular file (links are not followed).", definition::REPO_FILE));
    }
    if meta.len() > definition::MAX_FILE_BYTES as u64 {
        return RepoFile::Unusable(format!("{} is larger than {} KiB.", definition::REPO_FILE, definition::MAX_FILE_BYTES / 1024));
    }
    match std::fs::read(&path) {
        Ok(bytes) => RepoFile::Present(bytes),
        Err(e) => unreadable(&e),
    }
}

fn load_trust(core: &Core, repo_id: &str) -> CoreResult<Option<TrustRecord>> {
    let stored = core.db.with(|c| Ok(db::repo_settings::get_all(c, repo_id)?.into_iter().find(|(key, _)| key == TRUST_KEY).map(|(_, value)| value)))?;
    Ok(stored.and_then(|value| serde_json::from_value(value).ok()))
}

/// The repository file: its state and the commands that pass the checks.
fn repo_part(core: &Core, repo_id: &str, root: &Path) -> CoreResult<(RepoCommands, Vec<CustomCommandDef>)> {
    let mut info = RepoCommands { state: RepoCommandsState::Missing, hash: None, path: definition::REPO_FILE.to_string(), problems: Vec::new(), changes: Vec::new() };
    let bytes = match read_repo_file(root) {
        RepoFile::Missing => return Ok((info, Vec::new())),
        RepoFile::Unusable(reason) => {
            info.state = RepoCommandsState::Untrusted;
            info.problems.push(reason);
            return Ok((info, Vec::new()));
        }
        RepoFile::Present(bytes) => bytes,
    };
    let trust = load_trust(core, repo_id)?;
    let hash = definition::file_hash(&bytes);
    let parsed = definition::parse_file(&bytes, CustomCommandSource::Repo);
    info.state = match &trust {
        Some(record) if record.hash == hash => RepoCommandsState::Trusted,
        Some(_) => RepoCommandsState::Changed,
        None => RepoCommandsState::Untrusted,
    };
    if let (RepoCommandsState::Changed, Some(record)) = (info.state, &trust) {
        let approved = definition::parse_file(record.content.as_bytes(), CustomCommandSource::Repo).commands;
        info.changes = definition::changes(&approved, &parsed.commands);
    }
    info.hash = Some(hash);
    info.problems = parsed.problems;
    Ok((info, parsed.commands))
}

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

/// The user's own commands and – with `repo_id` – those of `.forkyard/commands.json` with the state
/// of their approval. Repository commands are listed (for review) but only `runnable` when this
/// exact version of the file is approved.
pub async fn custom_commands_list(core: &Core, repo_id: Option<String>) -> CoreResult<CustomCommandList> {
    let mut commands: Vec<CustomCommandEntry> = load_global(core)?.into_iter().map(|command| entry(CustomCommandSource::Global, command, true)).collect();
    let repo = match repo_id {
        Some(repo_id) => {
            let root = core.repo_path(&repo_id)?;
            let (info, defs) = repo_part(core, &repo_id, &root)?;
            let runnable = info.state == RepoCommandsState::Trusted;
            commands.extend(defs.into_iter().map(|command| entry(CustomCommandSource::Repo, command, runnable)));
            Some(info)
        }
        None => None,
    };
    Ok(CustomCommandList { commands, repo })
}

/// Replaces the user's own commands. Every command is checked; one invalid command rejects the
/// whole list (`not_allowed`, naming it) and nothing changes.
pub async fn custom_commands_save(core: &Core, commands: Vec<CustomCommandDef>) -> CoreResult<Vec<CustomCommandDef>> {
    check_global(&commands)?;
    core.db.with(|c| db::app_settings::set(c, GLOBAL_KEY, &file_value(&commands)))?;
    core.emit_app_changed(&[AppChange::CustomCommands]);
    load_global(core)
}

/// Approves the repository file in the version with `hash` (from `custom_commands_list`), or
/// withdraws the approval (`hash: None`). If the file has changed in between: `stale_state`; if
/// there is no usable file: `not_found`.
pub async fn custom_commands_trust(core: &Core, repo_id: String, hash: Option<String>) -> CoreResult<CustomCommandList> {
    let root = core.repo_path(&repo_id)?;
    match hash {
        None => core.db.with(|c| db::repo_settings::delete(c, &repo_id, TRUST_KEY))?,
        Some(expected) => {
            let RepoFile::Present(bytes) = read_repo_file(&root) else {
                return Err(CoreError::not_found(format!("The repository has no usable {} (any more).", definition::REPO_FILE)));
            };
            let found = definition::file_hash(&bytes);
            if found != expected {
                return Err(CoreError::stale_state());
            }
            let record = serde_json::to_value(TrustRecord { hash: found, content: util::decode_lossy(&bytes) })?;
            core.db.with(|c| db::repo_settings::set(c, &repo_id, TRUST_KEY, &record))?;
        }
    }
    core.emit_app_changed(&[AppChange::CustomCommands]);
    custom_commands_list(core, Some(repo_id)).await
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
