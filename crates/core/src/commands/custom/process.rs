//! Runs a custom command of kind `shell` as a job: in its own process group (Unix) or job object
//! (Windows) so that cancelling ends the whole tree, with the output line by line as
//! `job:progress`, everything redacted, and one entry in the repository's activity log.

use std::path::Path;
use std::time::Instant;

use parking_lot::Mutex;

use crate::app::Core;
use crate::db;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::events::names;
use crate::git::redact;
use crate::jobs::Job;
use crate::model::{CustomCommandResult, RepoChange};
use crate::proc::Proc;
use crate::util;

/// At most this much output is collected (the rest still goes out as progress).
const MAX_COLLECTED: usize = 1024 * 1024;
/// At most this much goes into the result and the activity log.
pub(crate) const MAX_OUTPUT: usize = 64 * 1024;
/// A custom command may have changed anything.
pub(crate) const ALL_CHANGES: [RepoChange; 7] = [
    RepoChange::Worktree,
    RepoChange::Index,
    RepoChange::Refs,
    RepoChange::Head,
    RepoChange::Stash,
    RepoChange::Config,
    RepoChange::Operation,
];

/// What would be started: program, arguments, additional environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Planned {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

impl Planned {
    /// The command line for confirmation and log, redacted.
    pub fn display(&self) -> String {
        display_line(&self.program, &self.args)
    }
}

pub(crate) use crate::proc::display_line;

/// Runs `planned` in `cwd` as job `job_id` and reports `repo:changed` afterwards.
pub(crate) async fn run(
    core: &Core,
    repo_id: &str,
    job_id: &str,
    title: &str,
    planned: &Planned,
    cwd: &Path,
) -> CoreResult<CustomCommandResult> {
    let job = core.start_job(job_id, Some(repo_id))?;
    let result = execute(core, repo_id, &job, title, planned, cwd).await;
    core.emit_repo_changed(repo_id, &ALL_CHANGES);
    job.finish(&result);
    result
}

async fn execute(core: &Core, repo_id: &str, job: &Job, title: &str, planned: &Planned, cwd: &Path) -> CoreResult<CustomCommandResult> {
    let started_at = util::now_iso();
    let start = Instant::now();
    let mut proc = Proc::new(&planned.program).args(&planned.args).cwd(cwd).std_batch_quoting();
    for (key, value) in &planned.env {
        proc = proc.env(key, value);
    }
    // The program is looked up on the command's own PATH first (on Windows with PATHEXT, so `npm` finds `npm.cmd`).
    if let Some((_, path)) = planned.env.iter().find(|(key, _)| key.eq_ignore_ascii_case("PATH")) {
        proc = proc.search_path(path);
    }
    let collected = Mutex::new(Vec::new());
    // Every line goes out as progress (redacted); at most `MAX_COLLECTED` is kept.
    let on_line = |segment: &[u8]| {
        let line = redact::redact_bytes(segment);
        job.progress("", None, line.trim_end_matches('\r'));
        let mut all = collected.lock();
        if all.len() < MAX_COLLECTED {
            all.extend_from_slice(segment);
            all.push(b'\n');
        }
    };
    let (exit_code, failure) = match proc.run_lines(job.token(), &on_line).await {
        Ok(out) => (out.code, None),
        Err(e) if e.code == ErrorCode::NotFound => (
            None,
            Some(CoreError::not_found(format!("The program “{}” was not found. Write its full path or check PATH.", planned.program))),
        ),
        Err(e) => (None, Some(e)),
    };
    let output = util::truncate_str(redact::redact_bytes(&collected.into_inner()).trim_end(), MAX_OUTPUT);
    let entry = db::activity::NewActivity {
        repo_id: Some(repo_id.to_string()),
        description: format!("Custom command: {title}"),
        command: planned.display(),
        exit_code,
        duration_ms: start.elapsed().as_millis() as u64,
        output: output.clone(),
        started_at,
        code: failure.as_ref().map(|e| e.code).or(if exit_code == Some(0) { None } else { Some(ErrorCode::Unknown) }),
    };
    match core.db.with(|c| db::activity::insert(c, &entry)) {
        Ok(saved) => core.emit(names::LOG_APPENDED, &saved),
        Err(e) => log::warn!("Log entry not saved: {}", e.message),
    }
    match failure {
        Some(error) => Err(error),
        None => Ok(CustomCommandResult::Finished { exit_code, output }),
    }
}
