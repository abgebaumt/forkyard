//! "Check each part" (Paket 8.1): the repository's test command on every planned part, each in a
//! temporary detached worktree `<parent>/<repo>.agents/stack-check-<n>` (Entscheidung 3) that is
//! removed right afterwards – also after a cancel or an error. The own working directory may be
//! dirty; it is never touched. A folder of that name that Git does not know as a worktree is never
//! touched either.

use std::path::Path;
use std::time::Instant;

use crate::app::Core;
use crate::commands::{settings, worktree};
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::jobs::Job;
use crate::model::{RepoChange, StackCheckResult, StackCheckState, StackPart};
use crate::util;

pub const CHECK_PREFIX: &str = "stack-check-";

/// Stand-ins for Paket 2a's `commands::agents::checks::{shell_command, tail, TEST_TIMEOUT}`,
/// `commands::agents::names::agents_dir` and `commands::worktree::main_worktree_path`, which are
/// not on this branch yet. When the packages are merged, these go and the calls use 2a's helpers
/// (same behaviour; 2a's `shell_command` also passes the line verbatim to cmd.exe on Windows).
mod checks {
    use std::time::Duration;

    use crate::git::redact;
    use crate::proc::Proc;

    pub const TEST_TIMEOUT: Duration = Duration::from_secs(30 * 60);
    pub const OUTPUT_TAIL: usize = 4096;

    /// `sh -c <command>`, on Windows `cmd.exe /d /s /c <command>`.
    pub fn shell_command(command: &str) -> Proc {
        if cfg!(windows) {
            Proc::new("cmd.exe").args(["/d", "/s", "/c", command])
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
}

mod names {
    use std::path::{Path, PathBuf};

    use crate::error::{CoreError, CoreResult};

    /// `<parent>/<repo>.agents` for the main worktree `<parent>/<repo>` (Entscheidung 3).
    pub fn agents_dir(main_root: &Path) -> CoreResult<PathBuf> {
        let refuse = || CoreError::not_allowed("Checking each part needs a folder next to the repository; the repository is at the top of the drive.");
        let name = main_root.file_name().ok_or_else(refuse)?;
        let parent = main_root.parent().ok_or_else(refuse)?;
        let mut folder = name.to_os_string();
        folder.push(".agents");
        Ok(parent.join(folder))
    }
}

/// The main worktree: the first entry of `git worktree list`.
async fn main_worktree_path(core: &Core, repo_id: &str) -> CoreResult<std::path::PathBuf> {
    let entries = worktree::entries(core, repo_id).await?;
    entries.into_iter().find(|entry| entry.is_main).map(|entry| entry.path).ok_or_else(|| CoreError::not_found("The repository has no working directory."))
}

fn key(path: &Path) -> String {
    std::fs::canonicalize(path).map(|c| util::path_key(&c)).unwrap_or_else(|_| util::path_key(path))
}

/// Whether Git lists `folder` as a worktree of this repository.
async fn registered(core: &Core, repo_id: &str, folder: &Path) -> CoreResult<bool> {
    let out = core.git_for(repo_id)?.args(["worktree", "list", "--porcelain", "-z"]).read_only().no_log().run().await?;
    let wanted = key(folder);
    let found = util::split_z(&out.stdout).filter_map(|field| field.strip_prefix(&b"worktree "[..])).any(|path| key(&util::bytes_to_path(path)) == wanted);
    Ok(found)
}

/// A detached worktree at `tip`; a leftover registered worktree of the same name goes first.
async fn add_worktree(core: &Core, repo_id: &str, folder: &Path, tip: &str) -> CoreResult<()> {
    core.with_write_lock(repo_id, &[RepoChange::Refs], async {
        if folder.exists() {
            if !registered(core, repo_id, folder).await? {
                return Err(CoreError::path_exists(util::display_path(folder)));
            }
            core.git_for(repo_id)?.args(["worktree", "remove", "--force", "--force"]).arg(folder).run().await?;
        }
        core.git_for(repo_id)?.args(["worktree", "add", "--detach"]).arg(folder).arg(tip).run().await?;
        Ok(())
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
        let folder = dir.join(format!("{CHECK_PREFIX}{}", part.number));
        add_worktree(core, repo_id, &folder, &part.tip).await?;
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
    let main = main_worktree_path(core, repo_id).await?;
    let dir = names::agents_dir(&main)?;
    let job = core.start_job(job_id, Some(repo_id))?;
    let result = check_all(core, repo_id, &job, &dir, &command, parts).await;
    job.finish(&result);
    result
}
