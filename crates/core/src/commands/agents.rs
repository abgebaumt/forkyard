//! Coding agents (cockpit, package 2a): templates, start in an own worktree, status, lifecycle,
//! cleanup. The cockpit needs no AI provider. Branch and worktree are Git's; the `agents` table
//! only keeps metadata, and the running session (terminal, status) lives in memory.

pub mod channel;
pub mod checks;
pub mod cleanup;
pub mod cmdline;
pub mod machine;
pub mod collision;
pub mod names;
pub mod registry;
pub mod templates;
#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};

use crate::app::Core;
use crate::commands::{graph, trust, worktree};
use crate::db;
use crate::db::agents::{AgentRow, EndReason};
use crate::error::{CoreError, CoreResult};
use crate::model::{Agent, AgentStatus, AgentStatusSource, AgentSuggestion, AgentTemplateInfo, AgentTemplateKind};
use crate::tools::locate::{locate, ToolInfo};
use crate::util;
use registry::AgentRegistry;
use templates::TemplateDef;

/// Agent configurations a CLI loads from its working directory; the repository trust check does
/// not know them, so the start dialog lists them.
pub(crate) const CONFIG_NAMES: [&str; 3] = [".claude", ".codex", "opencode.json"];

/// Which of `CONFIG_NAMES` the commit has (folders with a trailing `/`), in the order of `CONFIG_NAMES`.
async fn agent_configs(core: &Core, repo_id: &str, sha: &str) -> CoreResult<Vec<String>> {
    let out = core.git_for(repo_id)?.read_only().no_log().args(["ls-tree", "-z", sha, "--"]).args(CONFIG_NAMES).run().await?;
    let mut found: Vec<String> = Vec::new();
    for entry in util::split_z(&out.stdout) {
        // "<mode> <type> <object>\t<path>"
        let Some(tab) = entry.iter().position(|&b| b == b'\t') else { continue };
        let is_tree = entry[..tab].split(|&b| b == b' ').nth(1) == Some(&b"tree"[..]);
        let name = util::decode_lossy(&entry[tab + 1..]);
        found.push(if is_tree { format!("{name}/") } else { name });
    }
    found.sort_by_key(|name| CONFIG_NAMES.iter().position(|c| name.trim_end_matches('/') == *c));
    Ok(found)
}

/// Defaults for the start dialog and the live check of an edited branch. `branch: None` proposes
/// `agent/<short name from the task>` with the first suffix for which folder, branch and agent
/// name are all free; with a branch, only the folder gets a suffix and `branch_problem` says what
/// is wrong with it. `base`: default HEAD.
pub async fn agent_suggest(core: &Core, repo_id: String, task: String, branch: Option<String>, base: Option<String>) -> CoreResult<AgentSuggestion> {
    let main = worktree::main_worktree_path(core, &repo_id).await?;
    let dir = names::agents_dir(&main)?;
    let base = base.as_deref().map(str::trim).filter(|b| !b.is_empty()).unwrap_or("HEAD").to_string();
    let base_sha = graph::resolve_commit(core, &repo_id, &base).await?;
    let rows = core.db.with(|c| db::agents::list_for_repo(c, &repo_id))?;
    let taken = |name: &str| rows.iter().any(|row| row.short_name == name);
    let wanted = branch.as_deref().map(str::trim).filter(|b| !b.is_empty()).map(str::to_string);
    let (short_name, branch) = match wanted {
        Some(branch) => (names::free_name(&dir, &names::short_name_for_branch(&branch), &taken)?, branch),
        None => {
            let mut chosen = None;
            for candidate in names::candidates(&names::short_name_from_task(&task)) {
                if dir.join(&candidate).exists() || taken(&candidate) {
                    continue;
                }
                if worktree::local_branch_exists(core, &repo_id, &format!("{}{candidate}", names::BRANCH_PREFIX)).await? {
                    continue;
                }
                chosen = Some(candidate);
                break;
            }
            let short = chosen.ok_or_else(|| CoreError::name_exists("Every name for this task is taken. Type a branch name."))?;
            let branch = format!("{}{short}", names::BRANCH_PREFIX);
            (short, branch)
        }
    };
    let branch_problem = match util::check_ref_name(&branch) {
        Err(reason) => Some(reason),
        Ok(()) if worktree::local_branch_exists(core, &repo_id, &branch).await? => Some(format!("A branch “{branch}” already exists.")),
        Ok(()) => None,
    };
    let configs = agent_configs(core, &repo_id, &base_sha).await?;
    let running = rows.iter().filter(|row| row.ended_at.is_none()).count() as u32;
    let path = util::display_path(&dir.join(&short_name));
    Ok(AgentSuggestion { short_name, branch, branch_problem, path, base_sha, configs, running })
}

/// Runs the repository's test command in the agent's worktree now (a cancellable job).
pub async fn agent_run_tests(core: &Core, agent_id: String, job_id: String) -> CoreResult<crate::model::AgentTestResult> {
    checks::run_tests(core, &agent_id, &job_id).await
}

/// After every status change of a session: when the agent is done and the repository has a test
/// command, the tests run by themselves (once at a time).
pub(crate) async fn after_status_change(core: &Core, session: &registry::Session) {
    if session.snapshot().status != AgentStatus::Done {
        return;
    }
    let configured = crate::commands::settings::repo_settings_get(core, session.repo_id.clone())
        .await
        .ok()
        .and_then(|s| s.test_command)
        .is_some_and(|c| !c.trim().is_empty());
    let registry = core.state::<AgentRegistry>();
    if !configured || registry.test_of(&session.agent_id).is_some_and(|t| t.state == crate::model::AgentTestState::Running) {
        return;
    }
    let (core, agent_id) = (core.clone(), session.agent_id.clone());
    let job_id = format!("agent-test:{agent_id}:{}", util::new_id());
    tokio::spawn(async move {
        if let Err(e) = checks::run_tests(&core, &agent_id, &job_id).await {
            log::warn!("tests of agent {agent_id} not run: {}", e.message);
        }
    });
}

/// Largest task text.
pub const MAX_TASK_BYTES: usize = 64 * 1024;

/// Where the template's program is, through Paket 0's program search: a path (with a separator) is
/// the configured location, a name is searched on PATH, at the usual places and in the login shell's
/// PATH. The terminal needs an absolute file; a configured path that is no file is not found (no
/// search for a program of the same name).
pub(crate) async fn resolve_program(core: &Core, def: &TemplateDef) -> Option<ToolInfo> {
    let given = Path::new(&def.program);
    if given.is_absolute() || given.components().count() > 1 {
        let path = std::path::absolute(given).ok().filter(|path| path.is_file())?;
        let name = path.file_name()?.to_string_lossy().into_owned();
        return locate(core, &name, Some(&path)).await;
    }
    locate(core, &def.program, None).await
}

/// The templates with where their programs are (start dialog, settings).
pub async fn agent_templates(core: &Core) -> CoreResult<Vec<AgentTemplateInfo>> {
    let settings = core.settings()?;
    let mut out = Vec::new();
    for def in templates::all(&settings.agent_templates) {
        let found = resolve_program(core, &def).await;
        let version = found.as_ref().and_then(|f| f.version.clone());
        out.push(AgentTemplateInfo {
            unattended_blocked: templates::unattended_blocked(&def, version.as_deref()),
            unattended_note: templates::unattended_note(&def, cfg!(windows)),
            can_resume: def.kind != AgentTemplateKind::Custom || def.resume_args.is_some(),
            status_hook: def.status_hook,
            path: found.as_ref().map(|f| util::display_path(&f.path)),
            version,
            id: def.id,
            kind: def.kind,
            name: def.name,
            program: def.program,
        });
    }
    Ok(out)
}

/// Entries of `git status --porcelain=v2 -z`: one per changed or untracked path (renames carry their
/// original path as an extra field; header lines start with `#`).
pub fn count_status_entries(stdout: &[u8]) -> u32 {
    let mut count = 0;
    let mut skip = false;
    for field in util::split_z(stdout) {
        if std::mem::take(&mut skip) {
            continue;
        }
        match field.first() {
            Some(b'1' | b'u' | b'?') => count += 1,
            Some(b'2') => {
                count += 1;
                skip = true;
            }
            _ => {}
        }
    }
    count
}

fn same_path(a: &Path, b: &Path) -> bool {
    util::path_key(a) == util::path_key(b)
}

async fn changed_files(core: &Core, repo_id: &str, folder: &Path) -> u32 {
    let out = core.git.cmd(folder).repo(repo_id).read_only().no_log().args(["status", "--porcelain=v2", "-z", "--untracked-files=all"]).run_raw().await;
    match out {
        Ok(out) if out.success() => count_status_entries(&out.stdout),
        _ => 0,
    }
}

async fn commits_ahead(core: &Core, repo_id: &str, row: &AgentRow) -> u32 {
    let range = format!("{}..refs/heads/{}", row.base_sha, row.branch);
    match core.git_for(repo_id) {
        Ok(cmd) => cmd.read_only().no_log().args(["rev-list", "--count", &range]).run_text().await.ok().and_then(|n| n.trim().parse().ok()).unwrap_or(0),
        Err(_) => 0,
    }
}

fn template_name(core: &Core, template_id: &str) -> String {
    let custom = core.settings().map(|s| s.agent_templates).unwrap_or_default();
    templates::find(&custom, template_id).map(|t| t.name).unwrap_or_else(|_| template_id.to_string())
}

/// The agent as the cockpit shows it: Git decides whether branch and worktree still exist; the
/// session (if any) gives the status, otherwise the recorded end.
pub(crate) async fn describe(core: &Core, row: &AgentRow) -> Agent {
    let folder = PathBuf::from(&row.worktree_path);
    let full_ref = format!("refs/heads/{}", row.branch);
    let listed = worktree::listed_worktrees(core, &row.repo_id).await.unwrap_or_default();
    let in_git = listed.iter().any(|(path, branch)| same_path(path, &folder) && branch.as_deref() == Some(full_ref.as_str()));
    let branch_exists = worktree::local_branch_exists(core, &row.repo_id, &row.branch).await.unwrap_or(false);
    let present = in_git && branch_exists && folder.is_dir();
    let session = core.state::<AgentRegistry>().get(&row.id);
    let snapshot = session.as_ref().map(|s| s.snapshot());
    let running = snapshot.as_ref().is_some_and(|s| !s.finished);
    let (status, source) = match &snapshot {
        Some(s) => (s.status, s.source),
        None => match (row.end_reason, row.exit_code) {
            (Some(EndReason::Exited), Some(0)) => (AgentStatus::Done, AgentStatusSource::Guess),
            (Some(EndReason::Exited), _) => (AgentStatus::Failed, AgentStatusSource::Guess),
            _ => (AgentStatus::Stopped, AgentStatusSource::Guess),
        },
    };
    let status = if !present && !running { AgentStatus::Orphaned } else { status };
    let worktree_repo_id = if folder.is_dir() { core.db.with(|c| db::repos::find_by_path(c, &folder)).ok().flatten().map(|r| r.id) } else { None };
    Agent {
        id: row.id.clone(),
        repo_id: row.repo_id.clone(),
        worktree_repo_id: worktree_repo_id.clone(),
        short_name: row.short_name.clone(),
        template_id: row.template_id.clone(),
        template_name: template_name(core, &row.template_id),
        task: row.task.clone(),
        branch: row.branch.clone(),
        worktree_path: row.worktree_path.clone(),
        base: row.base.clone(),
        base_sha: row.base_sha.clone(),
        unattended: row.unattended,
        status,
        status_source: source,
        terminal_id: session.as_ref().filter(|_| running).map(|s| s.terminal_id().to_string()),
        started_at: row.started_at.clone(),
        ended_at: if running { None } else { row.ended_at.clone() },
        exit_code: snapshot.as_ref().and_then(|s| s.exit_code).or(if running { None } else { row.exit_code }),
        last_line: snapshot.as_ref().and_then(|s| s.last_line.clone()),
        changed_files: if present { changed_files(core, worktree_repo_id.as_deref().unwrap_or(&row.repo_id), &folder).await } else { 0 },
        commits_ahead: if branch_exists { commits_ahead(core, &row.repo_id, row).await } else { 0 },
        test: core.state::<AgentRegistry>().test_of(&row.id),
    }
}

/// The repository's agents, newest first, each checked against `git worktree list`.
pub async fn agent_list(core: &Core, repo_id: String) -> CoreResult<Vec<Agent>> {
    core.repo_path(&repo_id)?;
    let rows = core.db.with(|c| db::agents::list_for_repo(c, &repo_id))?;
    let mut out = Vec::with_capacity(rows.len());
    for row in &rows {
        let agent = describe(core, row).await;
        // Live changed files: the watcher of the worktree is in memory only (gone after a restart or
        // an undone cleanup), so it is started again here.
        if let Some(worktree_repo_id) = agent.worktree_repo_id.as_deref().filter(|_| agent.status != AgentStatus::Orphaned) {
            if !crate::watcher::is_watching(core, worktree_repo_id) {
                if let Err(e) = crate::watcher::start_watching(core, worktree_repo_id) {
                    log::warn!("file watching for the agent's worktree not started: {}", e.message);
                }
            }
        }
        out.push(agent);
    }
    Ok(out)
}

/// Starts a coding agent: checks trust, template and names, creates branch and worktree
/// (`<parent>/<repo>.agents/<short name>`) from `base`, registers the worktree (own repository row,
/// trusted like every worktree, not in the repository list) and starts the template in a terminal
/// there; the task is typed in once the program is ready. A failure after the worktree was created
/// removes worktree and branch again.
///
/// Errors: `repo_untrusted`; `not_allowed` (template unknown or its program not found, “without
/// prompts” not available, empty task, 16 terminals open); `invalid_name`; `name_exists` (branch);
/// `not_found` (base).
#[allow(clippy::too_many_arguments)]
pub async fn agent_start(core: &Core, repo_id: String, template_id: String, task: String, branch: String, base: String, unattended: bool, cols: u16, rows: u16) -> CoreResult<Agent> {
    core.repo_path(&repo_id)?;
    let task = task.trim_end().to_string();
    if task.trim().is_empty() {
        return Err(CoreError::not_allowed("Describe the task for the agent."));
    }
    if task.len() > MAX_TASK_BYTES {
        return Err(CoreError::not_allowed("The task is too long (more than 64 KB)."));
    }
    let settings = core.settings()?;
    let def = templates::find(&settings.agent_templates, &template_id)?;
    let program = resolve_program(core, &def)
        .await
        .ok_or_else(|| CoreError::not_allowed(format!("“{}” was not found. Install it or set its path under Settings › Coding agents.", def.name)))?;
    if unattended {
        if let Some(reason) = templates::unattended_blocked(&def, program.version.as_deref()) {
            return Err(CoreError::not_allowed(reason));
        }
    }
    let branch = branch.trim().to_string();
    util::check_ref_name(&branch).map_err(CoreError::invalid_name)?;
    if worktree::local_branch_exists(core, &repo_id, &branch).await? {
        return Err(CoreError::name_exists(format!("A branch “{branch}” already exists.")));
    }
    let base_sha = graph::resolve_commit(core, &repo_id, &base).await?;
    let main = worktree::main_worktree_path(core, &repo_id).await?;
    let dir = names::agents_dir(&main)?;
    let rows_now = core.db.with(|c| db::agents::list_for_repo(c, &repo_id))?;
    let short_name = names::free_name(&dir, &names::short_name_for_branch(&branch), &|name| rows_now.iter().any(|r| r.short_name == name))?;
    std::fs::create_dir_all(&dir).map_err(|e| CoreError::io(format!("The folder {} could not be created: {e}", util::display_path(&dir))))?;
    let folder = dir.join(&short_name);
    worktree::worktree_add(core, repo_id.clone(), folder.to_string_lossy().into_owned(), branch.clone(), true, Some(base_sha.clone())).await?;
    let row = AgentRow {
        id: util::new_id(),
        repo_id: repo_id.clone(),
        short_name,
        template_id: def.id.clone(),
        task,
        branch: branch.clone(),
        worktree_path: util::display_path(&folder),
        base: base.trim().to_string(),
        base_sha,
        unattended,
        started_at: util::now_iso(),
        ended_at: None,
        exit_code: None,
        end_reason: None,
    };
    match register_and_spawn(core, &row, &def, &program.path, cols, rows).await {
        Ok(()) => Ok(describe(core, &row).await),
        Err(e) => {
            roll_back(core, &row, &folder).await;
            Err(e)
        }
    }
}

async fn register_and_spawn(core: &Core, row: &AgentRow, def: &TemplateDef, program: &Path, cols: u16, rows: u16) -> CoreResult<()> {
    let folder = PathBuf::from(&row.worktree_path);
    let worktree_row = core.db.with(|c| db::repos::upsert(c, &folder))?;
    trust::settle_on_open(core, &worktree_row.id, &folder).await?;
    if let Err(e) = crate::watcher::start_watching(core, &worktree_row.id) {
        log::warn!("file watching for the agent's worktree not started: {}", e.message);
    }
    core.db.with(|c| db::agents::insert(c, row))?;
    registry::spawn_session(core, row, def, program, false, cols, rows).await.map(|_| ())
}

fn running_session(core: &Core, agent_id: &str) -> Option<std::sync::Arc<registry::Session>> {
    core.state::<AgentRegistry>().get(agent_id).filter(|s| !s.snapshot().finished)
}

/// Ends the agent's program (the whole process tree). The status becomes “stopped” as soon as it
/// has ended (`agents:changed`). Without a running session the agent is returned unchanged.
pub async fn agent_stop(core: &Core, agent_id: String) -> CoreResult<Agent> {
    let row = core.db.with(|c| db::agents::require(c, &agent_id))?;
    if let Some(session) = running_session(core, &agent_id) {
        crate::commands::terminal::terminal_close(core, session.terminal_id().to_string()).await?;
    }
    Ok(describe(core, &row).await)
}

/// Starts the template again in the same worktree with its resume arguments (Claude Code
/// `--continue`, Codex `resume --last`, opencode `--continue`) and the same permission mode.
pub async fn agent_resume(core: &Core, agent_id: String, cols: u16, rows: u16) -> CoreResult<Agent> {
    let row = core.db.with(|c| db::agents::require(c, &agent_id))?;
    core.repo_path(&row.repo_id)?;
    if running_session(core, &agent_id).is_some() {
        return Err(CoreError::not_allowed("This agent is still running."));
    }
    if describe(core, &row).await.status == AgentStatus::Orphaned {
        return Err(CoreError::not_allowed("The agent's branch or worktree no longer exists; it can't be resumed."));
    }
    let settings = core.settings()?;
    let def = templates::find(&settings.agent_templates, &row.template_id)?;
    if def.kind == AgentTemplateKind::Custom && def.resume_args.is_none() {
        return Err(CoreError::not_allowed(format!("The template “{}” has no arguments for “Resume”.", def.name)));
    }
    let program = resolve_program(core, &def)
        .await
        .ok_or_else(|| CoreError::not_allowed(format!("“{}” was not found. Install it or set its path under Settings › Coding agents.", def.name)))?;
    if row.unattended {
        if let Some(reason) = templates::unattended_blocked(&def, program.version.as_deref()) {
            return Err(CoreError::not_allowed(reason));
        }
    }
    let started = util::now_iso();
    core.db.with(|c| db::agents::set_restarted(c, &row.id, &started))?;
    let row = AgentRow { started_at: started, ended_at: None, exit_code: None, end_reason: None, ..row };
    if let Err(e) = registry::spawn_session(core, &row, &def, &program.path, true, cols, rows).await {
        let _ = core.db.with(|c| db::agents::set_ended(c, &row.id, &util::now_iso(), None, EndReason::Stopped));
        return Err(e);
    }
    Ok(describe(core, &row).await)
}

/// Removes the entry of an orphaned agent (branch or worktree gone). Git is not touched.
pub async fn agent_forget(core: &Core, agent_id: String) -> CoreResult<()> {
    let row = core.db.with(|c| db::agents::require(c, &agent_id))?;
    if running_session(core, &agent_id).is_some() || describe(core, &row).await.status != AgentStatus::Orphaned {
        return Err(CoreError::not_allowed("Only orphaned agents can be removed from the list. Use “Stop agent and clean up” for the others."));
    }
    let folder = PathBuf::from(&row.worktree_path);
    if !folder.is_dir() {
        if let Some(entry) = core.db.with(|c| db::repos::find_by_path(c, &folder))? {
            let _ = crate::watcher::stop_watching(core, &entry.id);
            core.db.with(|c| db::repos::delete(c, &entry.id))?;
        }
    }
    core.db.with(|c| db::agents::delete(c, &row.id))?;
    core.state::<AgentRegistry>().remove(&row.id);
    registry::emit_changed(core, &row.repo_id);
    Ok(())
}

/// What “Stop agent and clean up” would destroy (see `cleanup::preview`).
pub async fn agent_cleanup_preview(core: &Core, agent_id: String) -> CoreResult<crate::model::AgentCleanupPreview> {
    cleanup::preview(core, agent_id).await
}

/// “Stop agent and clean up” with one undo entry in the main repository (see `cleanup::run`).
pub async fn agent_cleanup(core: &Core, agent_id: String) -> CoreResult<crate::model::UndoState> {
    cleanup::run(core, agent_id).await
}

/// The app is closing: every running agent is recorded as ended by the app before its terminal
/// ends, so the exit that follows does not count as a failure.
pub fn close_all(core: &Core) {
    for session in core.state::<AgentRegistry>().all() {
        if session.snapshot().finished {
            continue;
        }
        session.mark_closed();
        if let Err(e) = core.db.with(|c| db::agents::set_ended(c, &session.agent_id, &util::now_iso(), None, EndReason::AppClosed)) {
            log::warn!("end of agent {} not recorded: {}", session.agent_id, e.message);
        }
    }
}

/// At startup: sessions the last run did not record as ended (crash, killed process) are ended by
/// the app; they show “stopped” with “Resume”.
pub fn reconcile_on_start(core: &Core) -> CoreResult<u32> {
    let open = core.db.with(db::agents::list_open)?;
    let now = util::now_iso();
    core.db.tx(|tx| {
        for row in &open {
            db::agents::set_ended(tx, &row.id, &now, None, EndReason::AppClosed)?;
        }
        Ok(())
    })?;
    Ok(open.len() as u32)
}

/// Takes back what `agent_start` created after the worktree: row, repository entry, worktree, branch.
async fn roll_back(core: &Core, row: &AgentRow, folder: &Path) {
    let _ = core.db.with(|c| db::agents::delete(c, &row.id));
    if let Ok(Some(entry)) = core.db.with(|c| db::repos::find_by_path(c, folder)) {
        let _ = crate::watcher::stop_watching(core, &entry.id);
        let _ = core.db.with(|c| db::repos::delete(c, &entry.id));
    }
    let removed = core
        .with_write_lock(&row.repo_id, &[crate::model::RepoChange::Refs], async {
            core.git_for(&row.repo_id)?.args(["worktree", "remove", "--force"]).arg(folder).run().await?;
            core.git_for(&row.repo_id)?.args(["update-ref", "-d"]).arg(format!("refs/heads/{}", row.branch)).run().await?;
            Ok(())
        })
        .await;
    if let Err(e) = removed {
        log::warn!("worktree of the failed agent start not removed: {}", e.message);
    }
}
