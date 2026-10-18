//! "Check each part" (Paket 8.1): the repository's test command on every planned part, each in a
//! temporary detached worktree `<parent>/<repo>.agents/stack-check-<n>` (Entscheidung 3) that is
//! removed right afterwards – also after a cancel or an error. The own working directory may be
//! dirty; it is never touched. Coding agents share that folder (an agent on `agent/stack-check-1`
//! gets `stack-check-1`), so an existing folder of that name – a worktree or not – is never touched:
//! the check takes the next free name (`stack-check-<n>-2`, …) and removes only what it created.

use std::path::{Path, PathBuf};
use std::time::Instant;

use crate::app::Core;
use crate::commands::agents::{checks, names};
use crate::commands::{settings, worktree};
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::jobs::Job;
use crate::model::{RepoChange, StackCheckResult, StackCheckState, StackPart};
use crate::util;

pub const CHECK_PREFIX: &str = "stack-check-";

/// How many names per part are tried before the check gives up.
const MAX_FOLDERS: u32 = 99;

/// A detached worktree at `tip` in a folder that does not exist yet – the first free one of
/// `stack-check-<part>`, `stack-check-<part>-2`, …; claimed inside the write lock.
async fn add_worktree(core: &Core, repo_id: &str, dir: &Path, part: u32, tip: &str) -> CoreResult<PathBuf> {
    core.with_write_lock(repo_id, &[RepoChange::Refs], async {
        let folder = (1..=MAX_FOLDERS)
            .map(|n| if n == 1 { dir.join(format!("{CHECK_PREFIX}{part}")) } else { dir.join(format!("{CHECK_PREFIX}{part}-{n}")) })
            .find(|path| !path.exists() && std::fs::symlink_metadata(path).is_err())
            .ok_or_else(|| CoreError::path_exists(util::display_path(&dir.join(format!("{CHECK_PREFIX}{part}")))))?;
        core.git_for(repo_id)?.args(["worktree", "add", "--detach"]).arg(&folder).arg(tip).run().await?;
        Ok(folder)
    })
    .await
}

/// Removes the temporary worktree (its build output included) and prunes Git's list.
async fn remove_worktree(core: &Core, repo_id: &str, folder: &Path) -> CoreResult<()> {
    core.with_write_lock(repo_id, &[RepoChange::Refs], async {
        if folder.exists() {
            let out = core.git_for(repo_id)?.args(["worktree", "remove", "--force", "--force"]).arg(folder).run_raw().await?;
            if !out.success() && folder.exists() {
                std::fs::remove_dir_all(folder).map_err(|e| CoreError::io(format!("The temporary worktree “{}” couldn't be removed: {e}", util::display_path(folder))))?;
            }
        }
        core.git_for(repo_id)?.args(["worktree", "prune"]).run().await?;
        Ok(())
    })
    .await
}

async fn check_all(core: &Core, repo_id: &str, job: &Job, dir: &Path, command: &str, parts: &[StackPart]) -> CoreResult<Vec<StackCheckResult>> {
    std::fs::create_dir_all(dir).map_err(|e| CoreError::io(format!("The folder “{}” couldn't be created: {e}", util::display_path(dir))))?;
    let path = crate::tools::locate::login_shell_path(core).await;
    let total = parts.len();
    let mut results = Vec::with_capacity(total);
    for part in parts {
        job.progress(&format!("Checking part {} of {total}", part.number), Some(((part.number as usize - 1) * 100 / total) as u32), "");
        let folder = add_worktree(core, repo_id, dir, part.number, &part.tip).await?;
        let started = Instant::now();
        let mut proc = checks::shell_command(command).cwd(folder.clone()).timeout(checks::TEST_TIMEOUT).logged(core, Some(repo_id), format!("Stack check: part {}", part.number));
        if let Some(path) = &path {
            proc = proc.env("PATH", path);
        }
        let ran = proc.run(job.token()).await;
        let removed = remove_worktree(core, repo_id, &folder).await;
        let duration_ms = started.elapsed().as_millis() as u64;
        let result = match ran {
            Ok(out) => StackCheckResult {
                part: part.number,
                tip: part.tip.clone(),
                state: if out.success() { StackCheckState::Passed } else { StackCheckState::Failed },
                exit_code: out.code,
                output: checks::tail(&out.stdout, &out.stderr),
                duration_ms,
            },
            Err(error) if error.code == ErrorCode::Timeout => StackCheckResult {
                part: part.number,
                tip: part.tip.clone(),
                state: StackCheckState::TimedOut,
                exit_code: None,
                output: format!("Stopped after {} minutes.", checks::TEST_TIMEOUT.as_secs() / 60),
                duration_ms,
            },
            Err(error) => return Err(error),
        };
        removed?;
        results.push(result);
    }
    Ok(results)
}

/// Runs the repository's test command on every part, one after the other, as the job `job_id`.
pub(crate) async fn run(core: &Core, repo_id: &str, job_id: &str, parts: &[StackPart]) -> CoreResult<Vec<StackCheckResult>> {
    let repo_settings = settings::repo_settings_get(core, repo_id.to_string()).await?;
    let command = repo_settings
        .test_command
        .map(|command| command.trim().to_string())
        .filter(|command| !command.is_empty())
        .ok_or_else(|| CoreError::not_allowed("This repository has no test command (Settings › Project › AI and agents)."))?;
    let main = worktree::main_worktree_path(core, repo_id).await?;
    let dir = names::agents_dir(&main)?;
    let job = core.start_job(job_id, Some(repo_id))?;
    let result = check_all(core, repo_id, &job, &dir, &command, parts).await;
    job.finish(&result);
    result
}
