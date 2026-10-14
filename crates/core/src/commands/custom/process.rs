//! Runs a custom command of kind `shell` as a job: in its own process group (Unix) or job object
//! (Windows) so that cancelling ends the whole tree, with the output line by line as
//! `job:progress`, everything redacted, and one entry in the repository's activity log.

use std::path::Path;
use std::process::Stdio;
use std::time::Instant;

use parking_lot::Mutex;
use tokio::io::{AsyncBufReadExt, AsyncRead};

use crate::app::Core;
use crate::db;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::events::names;
use crate::git::redact;
use crate::git::runner::{kill_tree, ProcessTree};
use crate::jobs::Job;
use crate::model::{CustomCommandResult, RepoChange};
use crate::util;

/// At most this much output is collected (the rest still goes out as progress).
const MAX_COLLECTED: usize = 1024 * 1024;
/// At most this much goes into the result and the activity log.
pub(crate) const MAX_OUTPUT: usize = 64 * 1024;
/// A custom command may have changed anything.
pub(crate) const ALL_CHANGES: [RepoChange; 7] =
    [RepoChange::Worktree, RepoChange::Index, RepoChange::Refs, RepoChange::Head, RepoChange::Stash, RepoChange::Config, RepoChange::Operation];

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

fn quote(arg: &str) -> String {
    if !arg.is_empty() && !arg.chars().any(|c| c.is_whitespace() || c == '"') {
        return arg.to_string();
    }
    format!("\"{}\"", arg.replace('"', "\\\""))
}

/// `program arg …` with quotes around arguments containing spaces, without credentials. Only for
/// display – the program gets its arguments separately.
pub(crate) fn display_line(program: &str, args: &[String]) -> String {
    let mut line = quote(program);
    for arg in args {
        line.push(' ');
        line.push_str(&quote(arg));
    }
    util::truncate_str(&redact::redact(&line), 2000)
}

/// Runs `planned` in `cwd` as job `job_id` and reports `repo:changed` afterwards.
pub(crate) async fn run(core: &Core, repo_id: &str, job_id: &str, title: &str, planned: &Planned, cwd: &Path) -> CoreResult<CustomCommandResult> {
    let job = core.start_job(job_id, Some(repo_id))?;
    let result = execute(core, repo_id, &job, title, planned, cwd).await;
    core.emit_repo_changed(repo_id, &ALL_CHANGES);
    job.finish(&result);
    result
}

fn spawn_error(program: &str, e: std::io::Error) -> CoreError {
    if e.kind() == std::io::ErrorKind::NotFound {
        return CoreError::not_found(format!("The program “{program}” was not found. Write its full path or check PATH.")).with_git_output(e.to_string());
    }
    let (code, reason) = crate::error::describe_io(&e);
    CoreError::new(code, format!("“{program}” couldn’t be started. {reason}")).with_git_output(e.to_string())
}

/// Reads one pipe line by line: as progress (redacted) and into `collected`.
async fn pump<R: AsyncRead + Unpin>(pipe: Option<R>, job: &Job, collected: &Mutex<Vec<u8>>) {
    let Some(pipe) = pipe else { return };
    let mut segments = tokio::io::BufReader::new(pipe).split(b'\n');
    while let Ok(Some(segment)) = segments.next_segment().await {
        let line = redact::redact_bytes(&segment);
        job.progress("", None, line.trim_end_matches('\r'));
        let mut all = collected.lock();
        if all.len() < MAX_COLLECTED {
            all.extend_from_slice(&segment);
            all.push(b'\n');
        }
    }
}

async fn execute(core: &Core, repo_id: &str, job: &Job, title: &str, planned: &Planned, cwd: &Path) -> CoreResult<CustomCommandResult> {
    let started_at = util::now_iso();
    let start = Instant::now();
    let mut command = tokio::process::Command::new(&planned.program);
    command.args(&planned.args).current_dir(cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    for (key, value) in &planned.env {
        command.env(key, value);
    }
    #[cfg(windows)]
    command.creation_flags(crate::git::runner::CREATE_NO_WINDOW);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|e| spawn_error(&planned.program, e))?;
    let tree = ProcessTree::attach(&child);
    let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
    let collected = Mutex::new(Vec::new());
    let token = job.token().clone();
    let waited = tokio::select! {
        status = async {
            tokio::join!(pump(stdout, job, &collected), pump(stderr, job, &collected));
            child.wait().await
        } => Some(status),
        _ = token.cancelled() => None,
    };
    let (exit_code, failure) = match waited {
        Some(Ok(status)) => (status.code(), None),
        Some(Err(e)) => (None, Some(CoreError::io(format!("Waiting for “{}” failed.", planned.program)).with_git_output(e.to_string()))),
        None => {
            kill_tree(&mut child, tree.as_ref()).await;
            let _ = child.wait().await;
            (None, Some(CoreError::cancelled()))
        }
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
