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
mod process;

#[cfg(test)]
mod tests;

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::app::Core;
use crate::commands::history::normalize_rel_path;
use crate::commands::remotes;
use crate::db;
use crate::error::{CoreError, CoreResult};
use crate::git::redact;
use crate::model::{
    AppChange, CustomCommandContext, CustomCommandCwd, CustomCommandDef, CustomCommandEntry, CustomCommandKind, CustomCommandList, CustomCommandResult, CustomCommandSource,
    CustomInputType, RepoCommands, RepoCommandsState,
};
use crate::undo;
use crate::util;
use expand::{InputValue, Values};

/// Longest value of one input.
const MAX_INPUT_BYTES: usize = 4096;

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

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/// The command behind `key` (`global:<id>`, `repo:<id>`). A repository command whose file is not
/// approved in this version: `command_untrusted`.
fn find_runnable(core: &Core, repo_id: &str, root: &Path, key: &str) -> CoreResult<CustomCommandDef> {
    let gone = || CoreError::not_found(format!("The custom command “{key}” doesn’t exist (any more)."));
    let (source, id) = key.split_once(':').ok_or_else(gone)?;
    match source {
        "global" => load_global(core)?.into_iter().find(|command| command.id == id).ok_or_else(gone),
        "repo" => {
            let (info, commands) = repo_part(core, repo_id, root)?;
            let command = commands.into_iter().find(|command| command.id == id).ok_or_else(gone)?;
            if info.state != RepoCommandsState::Trusted {
                return Err(CoreError::command_untrusted());
            }
            Ok(command)
        }
        _ => Err(gone()),
    }
}

async fn current_branch(core: &Core, repo_id: &str) -> CoreResult<Option<String>> {
    let out = core.git_for(repo_id)?.args(["symbolic-ref", "--short", "-q", "HEAD"]).read_only().no_log().run_raw().await?;
    Ok(if out.success() { util::non_empty(Some(out.stdout_text())) } else { None })
}

/// The remote of the branch's upstream, otherwise the only remote.
async fn upstream_remote(core: &Core, repo_id: &str, branch: Option<&str>, remotes: &[String]) -> CoreResult<Option<String>> {
    if let Some(branch) = branch {
        let out = core.git_for(repo_id)?.args(["config", "--get", &format!("branch.{branch}.remote")]).read_only().no_log().run_raw().await?;
        let name = out.stdout_text();
        if out.success() && remotes.contains(&name) {
            return Ok(Some(name));
        }
    }
    Ok(if remotes.len() == 1 { remotes.first().cloned() } else { None })
}

/// The form's values, checked against the definition.
fn input_values(def: &CustomCommandDef, given: &BTreeMap<String, String>) -> CoreResult<BTreeMap<String, InputValue>> {
    let mut out = BTreeMap::new();
    for input in &def.inputs {
        let raw = given.get(&input.id).cloned().or_else(|| input.default.clone()).unwrap_or_default();
        if raw.len() > MAX_INPUT_BYTES || raw.contains('\0') {
            return Err(CoreError::not_allowed(format!("The value for “{}” is too long or contains a NUL character.", input.label)));
        }
        let value = match input.input_type {
            CustomInputType::Text | CustomInputType::File => InputValue { value: raw, from_definition: false },
            CustomInputType::Choice => {
                let chosen = if raw.is_empty() { input.options.first().cloned().unwrap_or_default() } else { raw };
                if !input.options.contains(&chosen) {
                    return Err(CoreError::not_allowed(format!("“{chosen}” is not one of the choices for “{}”.", input.label)));
                }
                InputValue { value: chosen, from_definition: true }
            }
            CustomInputType::Checkbox => {
                let ticked = match raw.as_str() {
                    "true" => true,
                    "false" | "" => false,
                    other => return Err(CoreError::not_allowed(format!("The checkbox “{}” only takes “true” or “false”, not “{other}”.", input.label))),
                };
                let on = input.options.first().cloned().unwrap_or_else(|| "true".to_string());
                InputValue { value: if ticked { on } else { String::new() }, from_definition: true }
            }
        };
        out.insert(input.id.clone(), value);
    }
    Ok(out)
}

/// Every value a placeholder can stand for. A value the UI passes is checked; a missing one falls
/// back to HEAD, the current branch and the upstream remote.
async fn resolve(core: &Core, repo_id: &str, root: &Path, def: &CustomCommandDef, context: &CustomCommandContext, given: &BTreeMap<String, String>) -> CoreResult<Values> {
    let sha = match context.sha.as_deref().map(str::trim).filter(|sha| !sha.is_empty()) {
        Some(sha) if (4..=64).contains(&sha.len()) && sha.bytes().all(|b| b.is_ascii_hexdigit()) => Some(sha.to_ascii_lowercase()),
        Some(other) => return Err(CoreError::not_allowed(format!("“{other}” is not a commit ID."))),
        None => undo::rev_parse(core, repo_id, "HEAD^{commit}").await?,
    };
    let branch = match context.branch.as_deref().filter(|name| !name.is_empty()) {
        Some(name) => {
            util::check_ref_name(name).map_err(|reason| CoreError::invalid_name(format!("Branch “{name}”: {reason}")))?;
            Some(name.to_string())
        }
        None => current_branch(core, repo_id).await?,
    };
    let file = match context.file.as_deref().filter(|path| !path.is_empty()) {
        Some(path) => Some(normalize_rel_path(path)?),
        None => None,
    };
    let remotes = remotes::remote_names(core, repo_id).await?;
    let remote = match context.remote.as_deref().filter(|name| !name.is_empty()) {
        Some(name) if remotes.iter().any(|known| known == name) => Some(name.to_string()),
        Some(name) => return Err(CoreError::not_found(format!("The remote “{name}” doesn’t exist."))),
        None => upstream_remote(core, repo_id, branch.as_deref(), &remotes).await?,
    };
    Ok(Values { repo: util::display_path(root), sha, branch, file, remote, inputs: input_values(def, given)? })
}

/// `worktree`: the open folder; `repo`: the main working tree (differs for a linked worktree).
async fn working_dir(core: &Core, root: &Path, cwd: CustomCommandCwd) -> PathBuf {
    if cwd == CustomCommandCwd::Worktree {
        return root.to_path_buf();
    }
    match crate::commands::trust::common_dir(core, root).await {
        Some(common) if common.file_name().is_some_and(|name| name == ".git") => common.parent().map(Path::to_path_buf).unwrap_or_else(|| root.to_path_buf()),
        _ => root.to_path_buf(),
    }
}

/// Runs a custom command. `id` is the key from the list (`global:<id>`, `repo:<id>`), `inputs`
/// the form's values by input ID. With `confirm: true` and `confirmed: false` nothing runs: the
/// result is `confirm` with the finished command line. `shell` and `git` run as job `job_id`
/// (cancellable with `job_cancel`); `url` returns the address for the browser.
pub async fn custom_command_run(
    core: &Core,
    repo_id: String,
    id: String,
    context: CustomCommandContext,
    inputs: BTreeMap<String, String>,
    job_id: String,
    confirmed: bool,
) -> CoreResult<CustomCommandResult> {
    let root = core.repo_path(&repo_id)?;
    let def = find_runnable(core, &repo_id, &root, &id)?;
    let values = resolve(core, &repo_id, &root, &def, &context, &inputs).await?;
    let cwd = working_dir(core, &root, def.cwd).await;
    let ask = |display: String| CustomCommandResult::Confirm { display, cwd: util::display_path(&cwd) };
    match def.kind {
        CustomCommandKind::Url => {
            let url = expand::url(&def, &values)?;
            if def.confirm && !confirmed {
                return Ok(ask(redact::redact(&url)));
            }
            Ok(CustomCommandResult::OpenUrl { url })
        }
        CustomCommandKind::Shell => {
            let (program, args) = if def.shell { expand::shell_line(&def, &values, cfg!(windows))? } else { expand::shell_args(&def, &values)? };
            let planned = process::Planned { program, args, env: expand::environment(&values) };
            if def.confirm && !confirmed {
                return Ok(ask(planned.display()));
            }
            process::run(core, &repo_id, &job_id, &def.title, &planned, &cwd).await
        }
        CustomCommandKind::Git => {
            let args = expand::git_args(&def, &values)?;
            if def.confirm && !confirmed {
                return Ok(ask(process::display_line("git", &args)));
            }
            Err(CoreError::not_built("custom commands of kind “git”"))
        }
    }
}
