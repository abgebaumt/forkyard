//! The repository's test command (project setting “Test command”) in an agent's worktree, as a
//! cancellable job through Paket 0's process runner. It is the user's own command line from the
//! app database (never from the repository), run by the system shell.

use std::path::PathBuf;
use std::time::Duration;

use crate::app::Core;
use crate::db;
use crate::error::{CoreError, CoreResult};
use crate::git::redact;
use crate::model::{AgentTestResult, AgentTestState};
use crate::proc::Proc;
use crate::util;

use super::registry::{emit_changed, AgentRegistry};

pub const TEST_TIMEOUT: Duration = Duration::from_secs(30 * 60);
pub const OUTPUT_TAIL: usize = 4096;

/// `sh -c <command>`, on Windows `cmd.exe /d /s /c "<command>"`. On Windows the line goes on raw:
/// cmd.exe strips only the outer quotes, so std's `\"` escaping would mangle every quote the user's
/// command contains (`cargo test -- --skip "slow test"`, `"C:\Program Files\…\npm.cmd" test`).
pub fn shell_command(command: &str) -> Proc {
    if cfg!(windows) {
        Proc::new("cmd.exe").raw_arg(format!("/d /s /c \"{command}\""))
    } else {
        Proc::new("sh").args(["-c", command])
    }
}

/// stdout then stderr, the last `OUTPUT_TAIL` bytes (cut at a character boundary), redacted.
pub fn tail(stdout: &[u8], stderr: &[u8]) -> String {
    let mut all = String::from_utf8_lossy(stdout).into_owned();
    let err = String::from_utf8_lossy(stderr);
    if !err.is_empty() {
        if !all.is_empty() && !all.ends_with('\n') {
            all.push('\n');
        }
        all.push_str(&err);
    }
    let redacted = redact::redact(&all);
    if redacted.len() <= OUTPUT_TAIL {
        return redacted;
    }
    let mut start = redacted.len() - OUTPUT_TAIL;
    while !redacted.is_char_boundary(start) {
        start += 1;
    }
    format!("…{}", &redacted[start..])
}

/// Runs the test command in the agent's worktree as the job `job_id` and stores the result.
pub(crate) async fn run_tests(core: &Core, agent_id: &str, job_id: &str) -> CoreResult<AgentTestResult> {
    let row = core.db.with(|c| db::agents::require(c, agent_id))?;
    core.repo_path(&row.repo_id)?;
    let settings = crate::commands::settings::repo_settings_get(core, row.repo_id.clone()).await?;
    let command = settings
        .test_command
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .ok_or_else(|| CoreError::not_allowed("This repository has no test command (Settings › Project)."))?;
    let folder = PathBuf::from(&row.worktree_path);
    if !folder.is_dir() {
        return Err(CoreError::not_allowed("The agent's worktree no longer exists."));
    }
    let registry = core.state::<AgentRegistry>();
    let started_at = util::now_iso();
    // Check and mark in one step: two "done" reports right after each other start one run.
    if !registry.try_begin_test(&row.id, &started_at) {
        return Err(CoreError::not_allowed("The tests of this agent are already running."));
    }
    emit_changed(core, &row.repo_id);
    let job = match core.start_job(job_id, Some(&row.repo_id)) {
        Ok(job) => job,
        Err(e) => {
            registry.tests_forget(&row.id);
            return Err(e);
        }
    };
    // A job the UI did not start shows its phase as the title (like auto-fetch).
    job.progress(&format!("Tests of {}", row.short_name), None, "");
    let mut proc = shell_command(&command).cwd(folder).timeout(TEST_TIMEOUT).logged(core, Some(&row.repo_id), format!("Agent tests: {}", row.short_name));
    // The same PATH as in the user's terminal (npm, cargo …).
    if let Some(path) = crate::tools::locate::login_shell_path(core).await {
        proc = proc.env("PATH", path);
    }
    let run = proc.run(job.token()).await;
    let outcome = match &run {
        Ok(out) => Ok(AgentTestResult {
            state: if out.success() { AgentTestState::Passed } else { AgentTestState::Failed },
            exit_code: out.code,
            output: tail(&out.stdout, &out.stderr),
            started_at,
            finished_at: Some(util::now_iso()),
        }),
        Err(e) => Err(e.clone()),
    };
    job.finish(&run);
    match &outcome {
        Ok(result) => registry.set_test(&row.id, result.clone()),
        Err(_) => registry.tests_forget(&row.id),
    }
    emit_changed(core, &row.repo_id);
    outcome
}
