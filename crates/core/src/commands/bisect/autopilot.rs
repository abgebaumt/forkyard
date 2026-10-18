//! Bisect autopilot (9.1, Entscheidung 2): runs a confirmed test script commit by commit in a
//! temporary, detached worktree `<parent>/<repo>.agents/bisect-<n>` based on the bad commit.
//!
//! Forkyard drives the bisect itself instead of `git bisect run`: each step runs the script through
//! `proc.rs` with its own time limit and the job's cancel signal (which ends the whole process tree),
//! and marks the tested commit with the verdict of the exit code – 0 good, 125 skip, 1–127 bad,
//! anything else stops, as with `git bisect run`.
//!
//! The bisect state lives in the temporary worktree's own Git directory (`BISECT_*` and the
//! per-worktree refs `refs/bisect/*`) and is re-read after every mark, so the own working directory
//! and a bisect running there stay untouched. The repository's write lock is held only while the
//! worktree is added or removed. The script lives in the data folder, outside both worktrees.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use crate::ai::bisect::{check_range, normalize_script, script_problem};
use crate::app::Core;
use crate::commands::agents::names;
use crate::commands::bisect::read_bisect_at;
use crate::commands::worktree::{self, main_worktree_path};
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::errors::classify;
use crate::git::{redact, GitCmd};
use crate::jobs::Job;
use crate::model::{BisectAutopilot, BisectAutopilotPhase, BisectAutopilotStep, BisectShell, BisectStatus, BisectVerdict};
use crate::proc::{Proc, ProcOutput};
use crate::util;

/// Lock reason of an autopilot's worktree while its run or result is open.
pub const LOCK_REASON: &str = "Forkyard bisect autopilot";
/// `job:progress` phase of a run; the UI reloads `bisect_autopilot_status` on it.
pub const PROGRESS_PHASE: &str = "bisect-autopilot";
pub const MAX_STEP_TIMEOUT_SECS: u64 = 86_400;
const MAX_FOLDERS: u32 = 99;
/// A bisect over a million commits needs about 20 marks; a script that keeps skipping stops here.
const MAX_STEPS: usize = 200;
const OUTPUT_TAIL: usize = 2_000;

/// The run of each repository: running, or finished with its worktree still there.
#[derive(Default)]
pub(crate) struct AutopilotRuns {
    runs: Mutex<HashMap<String, BisectAutopilot>>,
}

fn is_running(run: &BisectAutopilot) -> bool {
    matches!(run.phase, BisectAutopilotPhase::Preparing | BisectAutopilotPhase::Testing)
}

impl AutopilotRuns {
    fn get(&self, repo_id: &str) -> Option<BisectAutopilot> {
        self.runs.lock().get(repo_id).cloned()
    }

    fn update(&self, repo_id: &str, change: impl FnOnce(&mut BisectAutopilot)) -> Option<BisectAutopilot> {
        let mut runs = self.runs.lock();
        let run = runs.get_mut(repo_id)?;
        change(run);
        Some(run.clone())
    }

    fn remove(&self, repo_id: &str) {
        self.runs.lock().remove(repo_id);
    }

    /// Worktrees of every run in memory (all repositories, running or with an open result).
    fn owned_paths(&self) -> Vec<String> {
        self.runs.lock().values().map(|run| run.worktree_path.clone()).filter(|path| !path.is_empty()).collect()
    }

    /// Takes the repository for a new run, or says why not.
    fn claim(&self, repo_id: &str, run: BisectAutopilot) -> CoreResult<()> {
        let mut runs = self.runs.lock();
        match runs.get(repo_id) {
            Some(existing) if is_running(existing) => Err(CoreError::new(ErrorCode::BisectActive, "The bisect autopilot is already running for this repository.")),
            Some(_) => Err(CoreError::not_allowed("Close the result of the last autopilot run first (keep or remove its worktree).")),
            None => {
                runs.insert(repo_id.to_string(), run);
                Ok(())
            }
        }
    }
}

/// The verdict for a script's exit code, as `git bisect run` reads it; `None` stops the run.
pub fn verdict_for(code: Option<i32>) -> Option<BisectVerdict> {
    match code {
        Some(0) => Some(BisectVerdict::Good),
        Some(125) => Some(BisectVerdict::Skip),
        Some(1..=127) => Some(BisectVerdict::Bad),
        _ => None,
    }
}

pub(crate) fn status(core: &Core, repo_id: &str) -> Option<BisectAutopilot> {
    core.state::<AutopilotRuns>().get(repo_id)
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(7)]
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

/// The end of the script's output, redacted (kept in memory, shown only to the user).
fn tail(stdout: &[u8], stderr: &[u8]) -> String {
    let mut text = util::decode_lossy(stdout);
    let errors = util::decode_lossy(stderr);
    if !errors.is_empty() {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&errors);
    }
    let mut start = text.len().saturating_sub(OUTPUT_TAIL);
    while !text.is_char_boundary(start) {
        start += 1;
    }
    redact::redact(&text[start..])
}

fn inside(path: &Path, root: &Path) -> bool {
    Path::new(&util::path_key(path)).starts_with(util::path_key(root))
}

fn free_folder(dir: &Path) -> CoreResult<PathBuf> {
    (1..=MAX_FOLDERS)
        .map(|n| dir.join(format!("bisect-{n}")))
        .find(|path| !path.exists())
        .ok_or_else(|| CoreError::name_exists(format!("There are already {MAX_FOLDERS} bisect worktrees in “{}”. Remove some first.", util::display_path(dir))))
}

fn write_script(dir: &Path, script: &str, shell: BisectShell) -> CoreResult<PathBuf> {
    let failed = |e: std::io::Error| CoreError::io(format!("Couldn’t write the test script: {e}"));
    std::fs::create_dir_all(dir).map_err(failed)?;
    let path = dir.join(shell.file_name());
    let mut bytes = Vec::new();
    // Windows PowerShell 5.1 reads a script without BOM in the ANSI code page: umlauts would break.
    if shell == BisectShell::Powershell {
        bytes.extend_from_slice(b"\xEF\xBB\xBF");
    }
    bytes.extend_from_slice(normalize_script(script, shell).as_bytes());
    std::fs::write(&path, bytes).map_err(failed)?;
    Ok(path)
}

fn finish(core: &Core, repo_id: &str, change: impl FnOnce(&mut BisectAutopilot)) -> CoreResult<BisectAutopilot> {
    core.state::<AutopilotRuns>()
        .update(repo_id, |run| {
            change(run);
            run.current = None;
            run.remaining_steps = Some(0);
        })
        .ok_or_else(|| CoreError::unknown("The autopilot run is no longer known."))
}

/// Ends a bisect left in the worktree, unlocks and removes it with what the script left there.
async fn remove_worktree(core: &Core, repo_id: &str, wt: &Path) -> CoreResult<()> {
    let shown = util::display_path(wt);
    if wt.is_dir() {
        let _ = core.git_at(wt).repo(repo_id).args(["bisect", "reset"]).run_raw().await;
    }
    let _ = worktree::worktree_unlock(core, repo_id.to_string(), shown.clone()).await;
    worktree::worktree_remove(core, repo_id.to_string(), shown, true).await.map(|_| ())
}

/// Worktrees locked with `LOCK_REASON` that no run in memory owns: an app that ended during a run
/// (or before its result was closed) left them. Only these are removed – never one the user kept.
async fn remove_leftovers(core: &Core, repo_id: &str) {
    let Ok(list) = worktree::worktree_list(core, repo_id.to_string()).await else { return };
    let owned = core.state::<AutopilotRuns>().owned_paths();
    for entry in list.iter().filter(|entry| !entry.is_main && entry.lock_reason.as_deref() == Some(LOCK_REASON)) {
        if owned.iter().any(|path| util::path_key(Path::new(path)) == util::path_key(Path::new(&entry.path))) {
            continue;
        }
        let removed = if entry.is_prunable {
            let _ = worktree::worktree_unlock(core, repo_id.to_string(), entry.path.clone()).await;
            worktree::worktree_prune(core, repo_id.to_string()).await.map(|_| ())
        } else {
            remove_worktree(core, repo_id, Path::new(&entry.path)).await
        };
        if let Err(error) = removed {
            log::warn!("leftover bisect worktree not removed: {}", error.message);
        }
    }
}

pub(crate) async fn run(core: &Core, repo_id: &str, job_id: &str, bad: &str, good: &[String], script: &str, step_timeout_secs: u64) -> CoreResult<BisectAutopilot> {
    core.repo_path(repo_id)?;
    if let Some(problem) = script_problem(script) {
        return Err(CoreError::not_allowed(format!("The test script can’t run: {problem}.")));
    }
    if step_timeout_secs == 0 || step_timeout_secs > MAX_STEP_TIMEOUT_SECS {
        return Err(CoreError::not_allowed("The time limit per step must be between 1 second and 24 hours."));
    }
    let (bad, good) = check_range(core, repo_id, bad, good).await?;
    let runs = core.state::<AutopilotRuns>();
    runs.claim(
        repo_id,
        BisectAutopilot {
            job_id: job_id.to_string(),
            phase: BisectAutopilotPhase::Preparing,
            worktree_path: String::new(),
            bad: bad.clone(),
            good: good.clone(),
            current: None,
            remaining_steps: None,
            steps: Vec::new(),
            result: None,
            candidates: Vec::new(),
            step_timeout_secs,
            message: None,
            started_at: util::now_iso(),
        },
    )?;
    let job = match core.start_job(job_id, Some(repo_id)) {
        Ok(job) => job,
        Err(error) => {
            runs.remove(repo_id);
            return Err(error);
        }
    };
    // No percentage yet: step 1 reports 0 %, and the job throttle drops a second event with the
    // same phase and percentage within 100 ms – the bar would stay on "Preparing".
    job.progress(PROGRESS_PHASE, None, "Preparing the bisect worktree");
    let result = drive(core, repo_id, &job, &bad, &good, script, Duration::from_secs(step_timeout_secs)).await;
    if result.is_err() {
        runs.remove(repo_id);
    }
    job.finish(&result);
    result
}

async fn drive(core: &Core, repo_id: &str, job: &Job, bad: &str, good: &[String], script: &str, limit: Duration) -> CoreResult<BisectAutopilot> {
    remove_leftovers(core, repo_id).await;
    let main = main_worktree_path(core, repo_id).await?;
    let dir = names::agents_dir(&main)?;
    std::fs::create_dir_all(&dir).map_err(|e| CoreError::io(format!("Couldn’t create “{}”: {e}", util::display_path(&dir))))?;
    let wt = free_folder(&dir)?;
    let script_dir = core.data_dir().join("bisect").join(util::new_id());
    if inside(&script_dir, &main) || inside(&script_dir, &wt) {
        return Err(CoreError::not_allowed("The data folder lies inside the repository; the test script must live outside both worktrees."));
    }
    let shell = BisectShell::current();
    let script_path = write_script(&script_dir, script, shell)?;
    core.state::<AutopilotRuns>().update(repo_id, |run| run.worktree_path = util::display_path(&wt));
    let session = Session { core, repo_id, job, wt: &wt, script: &script_path, shell, limit };
    let outcome = session.go(bad, good).await;
    let _ = std::fs::remove_dir_all(&script_dir);
    if outcome.is_err() {
        if let Err(error) = remove_worktree(core, repo_id, &wt).await {
            log::warn!("bisect worktree not removed: {}", error.message);
        }
        let _ = std::fs::remove_dir(&dir);
    }
    outcome
}

/// One run inside its temporary worktree.
struct Session<'a> {
    core: &'a Core,
    repo_id: &'a str,
    job: &'a Job,
    wt: &'a Path,
    script: &'a Path,
    shell: BisectShell,
    limit: Duration,
}

impl Session<'_> {
    fn git(&self) -> GitCmd {
        self.core.git_at(self.wt).repo(self.repo_id)
    }

    async fn go(&self, bad: &str, good: &[String]) -> CoreResult<BisectAutopilot> {
        self.job.token().check()?;
        let shown = util::display_path(self.wt);
        worktree::worktree_add(self.core, self.repo_id.to_string(), shown.clone(), bad.to_string(), false, None).await?;
        worktree::worktree_lock(self.core, self.repo_id.to_string(), shown, Some(LOCK_REASON.to_string())).await?;
        self.job.token().check()?;
        let out = self.git().args(["bisect", "start"]).arg(bad).args(good).arg("--").run_raw().await?;
        if !out.success() {
            return Err(classify("bisect", out.code, &out.stdout, &out.stderr));
        }
        self.steps().await
    }

    async fn steps(&self) -> CoreResult<BisectAutopilot> {
        let runs = self.core.state::<AutopilotRuns>();
        let mut status = read_bisect_at(self.core, self.wt, self.repo_id).await?;
        loop {
            if let Some(result) = status.result.clone() {
                self.reset(Some(&result)).await?;
                return finish(self.core, self.repo_id, |run| {
                    run.phase = BisectAutopilotPhase::Found;
                    run.result = Some(result);
                });
            }
            if status.only_skipped_left {
                let candidates = self.candidates(&status).await?;
                self.reset(None).await?;
                return finish(self.core, self.repo_id, |run| {
                    run.phase = BisectAutopilotPhase::OnlySkipped;
                    run.candidates = candidates;
                });
            }
            let done = runs.get(self.repo_id).map(|run| run.steps.len()).unwrap_or(0);
            if done >= MAX_STEPS {
                return Err(CoreError::not_allowed(format!("The autopilot stopped after {MAX_STEPS} steps without a result.")));
            }
            let current = status.current.clone().ok_or_else(|| CoreError::unknown("Git did not check out a commit to test."))?;
            self.report(&status, done, &current);
            let started = Instant::now();
            let record = match self.run_script(&current).await {
                Ok(output) => match verdict_for(output.code) {
                    Some(verdict) => BisectAutopilotStep { sha: current.clone(), verdict, exit_code: output.code, timed_out: false, duration_ms: elapsed_ms(started), output_tail: tail(&output.stdout, &output.stderr) },
                    None => {
                        // As with `git bisect run`: such an exit means the script itself is broken.
                        self.reset(Some(&current)).await?;
                        let message = match output.code {
                            Some(code) => format!("The test script ended with exit code {code} on {}. Exit codes above 127 stop the autopilot; use 125 to skip a commit.", short(&current)),
                            None => format!("The test script was ended by a signal on {}; the autopilot stopped.", short(&current)),
                        };
                        return finish(self.core, self.repo_id, |run| {
                            run.phase = BisectAutopilotPhase::Failed;
                            run.message = Some(message);
                        });
                    }
                },
                // Over the time limit: `proc.rs` ended the process tree; the commit counts as skipped.
                Err(error) if error.code == ErrorCode::Timeout => {
                    BisectAutopilotStep { sha: current.clone(), verdict: BisectVerdict::Skip, exit_code: None, timed_out: true, duration_ms: elapsed_ms(started), output_tail: String::new() }
                }
                Err(error) => return Err(error),
            };
            status = self.mark(record.verdict, &current).await?;
            runs.update(self.repo_id, |run| run.steps.push(record));
        }
    }

    fn report(&self, status: &BisectStatus, done: usize, current: &str) {
        let step = done + 1;
        let total = step + status.remaining_steps.unwrap_or(0) as usize;
        self.core.state::<AutopilotRuns>().update(self.repo_id, |run| {
            run.phase = BisectAutopilotPhase::Testing;
            run.current = Some(current.to_string());
            run.remaining_steps = status.remaining_steps;
        });
        let percent = u32::try_from(done * 100 / total).unwrap_or(100);
        self.job.progress(PROGRESS_PHASE, Some(percent), &format!("Step {step} of ~{total} · testing {}", short(current)));
    }

    /// The commits among which the first bad one is: what lies between the bad and the good marks.
    async fn candidates(&self, status: &BisectStatus) -> CoreResult<Vec<String>> {
        let Some(bad) = &status.bad else { return Ok(Vec::new()) };
        let not_good: Vec<String> = status.good.iter().map(|sha| format!("^{sha}")).collect();
        let out = self.git().read_only().no_log().arg("rev-list").arg(bad).args(&not_good).arg("--").run().await?;
        Ok(out.stdout_lines().into_iter().map(util::decode_lossy).collect())
    }

    async fn run_script(&self, sha: &str) -> CoreResult<ProcOutput> {
        let proc = match self.shell {
            BisectShell::Sh => Proc::new("/bin/sh").arg(self.script),
            BisectShell::Powershell => Proc::new("powershell.exe").args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]).arg(self.script),
        };
        proc.cwd(self.wt)
            .env("FORKYARD_BISECT_COMMIT", sha)
            .env_remove("GIT_DIR")
            .env_remove("GIT_WORK_TREE")
            .env_remove("GIT_INDEX_FILE")
            .timeout(self.limit)
            .logged(self.core, Some(self.repo_id), "Bisect autopilot: test script")
            .run(self.job.token())
            .await
    }

    async fn mark(&self, verdict: BisectVerdict, sha: &str) -> CoreResult<BisectStatus> {
        // A script may change tracked files; they would block checking out the next commit. The
        // worktree is the autopilot's own, so nothing of the user's is lost.
        self.git().args(["reset", "--hard", "-q"]).run().await?;
        let word = match verdict {
            BisectVerdict::Good => "good",
            BisectVerdict::Bad => "bad",
            BisectVerdict::Skip => "skip",
        };
        let out = self.git().args(["bisect", word]).arg(sha).run_raw().await?;
        let status = read_bisect_at(self.core, self.wt, self.repo_id).await?;
        // "Only skipped commits left" ends with exit code 2 – a state, not an error.
        if out.success() || status.result.is_some() || status.only_skipped_left {
            return Ok(status);
        }
        Err(classify("bisect", out.code, &out.stdout, &out.stderr))
    }

    /// Ends the bisect inside the worktree; `to` = the commit to stay on.
    async fn reset(&self, to: Option<&str>) -> CoreResult<()> {
        let mut cmd = self.git().args(["bisect", "reset"]);
        if let Some(sha) = to {
            cmd = cmd.arg(sha);
        }
        cmd.run().await.map(|_| ())
    }
}

/// "Keep worktree" (unlocks it; from now on it is the user's) or "Remove worktree".
pub(crate) async fn close(core: &Core, repo_id: &str, keep: bool) -> CoreResult<Option<String>> {
    core.repo_path(repo_id)?;
    let runs = core.state::<AutopilotRuns>();
    let Some(run) = runs.get(repo_id) else { return Ok(None) };
    if is_running(&run) {
        return Err(CoreError::not_allowed("The autopilot is still running. Stop it first."));
    }
    if keep {
        let _ = worktree::worktree_unlock(core, repo_id.to_string(), run.worktree_path.clone()).await;
        runs.remove(repo_id);
        return Ok(Some(run.worktree_path));
    }
    let wt = PathBuf::from(&run.worktree_path);
    remove_worktree(core, repo_id, &wt).await?;
    if let Some(dir) = wt.parent() {
        let _ = std::fs::remove_dir(dir);
    }
    runs.remove(repo_id);
    Ok(None)
}

#[cfg(test)]
mod tests;
