//! Repository statistics (`stats_compute`): one pass over `git log --numstat -z --no-merges`
//! plus `git blame --porcelain` on a sample of the files for the code age. Runs as a
//! cancellable job with progress (phase `history`, then `blame`). Only reads: no write lock,
//! every call with `GIT_OPTIONAL_LOCKS=0`.
//!
//! The period is compared with the author time (both ends inclusive); `--since` only shortens
//! the walk, because a commit's committer date is not older than its author date. With `to` the
//! history of the last commit committed up to then is counted. `.mailmap` is not applied.
//!
//! The result holds derived numbers only – never commits or messages.

mod aggregate;
mod parse;
#[cfg(test)]
mod tests;

use std::collections::HashSet;

use crate::app::Core;
use crate::commands::graph::{resolve_commit, LOG_SAFE};
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::jobs::Job;
use crate::model::{RepoStats, StatsCodeAge, StatsRange};
use crate::util;

use aggregate::Aggregator;
use parse::{LogParser, LOG_FORMAT};

/// Progress phase (`job:progress.phase`); the UI names it.
const PHASE_HISTORY: &str = "history";
/// Share of the history pass in the progress; the code age gets the rest.
const HISTORY_SHARE: u32 = 70;
/// Progress after every this many commits.
const PROGRESS_EVERY: u32 = 200;

/// Statistics of the history of `range.ref` as a job under `job_id`.
///
/// `HEAD` without a commit (or nothing committed up to `to`) → empty statistics (`tip: None`).
/// Unknown ref → `not_found`; `from`/`to` not ISO-8601 or `from` after `to` → `not_allowed`.
/// Cancelled via `job_cancel` → `cancelled`.
pub async fn stats_compute(core: &Core, repo_id: String, job_id: String, range: StatsRange) -> CoreResult<RepoStats> {
    let (from, to) = parse_range(&range)?;
    core.repo_path(&repo_id)?;
    let job = core.start_job(&job_id, Some(&repo_id))?;
    let result = compute(core, &repo_id, &range.reference, from, to, &job).await;
    job.finish(&result);
    result
}

/// `from`/`to` as Unix seconds.
fn parse_range(range: &StatsRange) -> CoreResult<(Option<i64>, Option<i64>)> {
    let parse = |value: &Option<String>| -> CoreResult<Option<i64>> {
        match value.as_deref().map(str::trim).filter(|text| !text.is_empty()) {
            None => Ok(None),
            Some(text) => chrono::DateTime::parse_from_rfc3339(text)
                .map(|time| Some(time.timestamp()))
                .map_err(|_| CoreError::not_allowed(format!("“{}” is not a valid point in time.", util::truncate_str(text, 40)))),
        }
    };
    let (from, to) = (parse(&range.from)?, parse(&range.to)?);
    if let (Some(from), Some(to)) = (from, to) {
        if from > to {
            return Err(CoreError::not_allowed("The period starts after it ends."));
        }
    }
    Ok((from, to))
}

async fn compute(core: &Core, repo_id: &str, reference: &str, from: Option<i64>, to: Option<i64>, job: &Job) -> CoreResult<RepoStats> {
    let Some(tip) = resolve_tip(core, repo_id, reference, to).await? else {
        return Ok(aggregate::empty());
    };
    let reference_time = match to {
        Some(to) => to,
        None => commit_time(core, repo_id, &tip).await?,
    };
    let mut aggregator = Aggregator::new(from, to);
    read_log(core, repo_id, &tip, from, job, &mut aggregator).await?;
    let tree = list_tree(core, repo_id, &tip).await?;
    let existing: HashSet<String> = tree.iter().map(|file| file.path.clone()).collect();
    Ok(aggregator.finish(&existing, StatsCodeAge::default(), tip, reference_time))
}

/// The commit whose history is counted: `reference` itself, or with `to` its last commit
/// committed up to then. `None`: `HEAD` without a commit, or nothing committed up to `to`.
async fn resolve_tip(core: &Core, repo_id: &str, reference: &str, to: Option<i64>) -> CoreResult<Option<String>> {
    let reference = match reference.trim() {
        "" => "HEAD",
        other => other,
    };
    let start = match resolve_commit(core, repo_id, reference).await {
        Ok(sha) => sha,
        Err(e) if e.code == ErrorCode::NotFound && reference == "HEAD" => return Ok(None),
        Err(e) => return Err(e),
    };
    let Some(to) = to else { return Ok(Some(start)) };
    let sha = core
        .git_for(repo_id)?
        .args(["rev-list", "-n", "1"])
        .arg(format!("--before=@{to} +0000"))
        .arg(&start)
        .read_only()
        .no_log()
        .run_text()
        .await?;
    Ok((!sha.is_empty()).then_some(sha))
}

/// Committer time of a commit (Unix seconds).
async fn commit_time(core: &Core, repo_id: &str, sha: &str) -> CoreResult<i64> {
    let text = core
        .git_for(repo_id)?
        .args(["log", "-1", "--format=%ct"])
        .args(LOG_SAFE)
        .args([sha, "--"])
        .read_only()
        .no_log()
        .run_text()
        .await?;
    text.trim().parse().map_err(|_| CoreError::unknown(format!("Git reported no time for commit {sha}.")))
}

/// One pass over the log of `tip`; every commit goes to the aggregator as soon as it is read.
async fn read_log(core: &Core, repo_id: &str, tip: &str, from: Option<i64>, job: &Job, aggregator: &mut Aggregator) -> CoreResult<()> {
    job.token().check()?;
    let since = from.map(|from| format!("--since=@{from} +0000"));
    let mut count = core.git_for(repo_id)?.args(["rev-list", "--count", "--no-merges"]);
    if let Some(since) = &since {
        count = count.arg(since);
    }
    let total: u32 = count.arg(tip).read_only().no_log().run_text().await?.trim().parse().unwrap_or(0);
    job.progress(PHASE_HISTORY, Some(0), &format!("0/{total}"));

    let mut log = core
        .git_for(repo_id)?
        .args(["log", "--numstat", "-z", "--no-merges", "-M", "--no-textconv", "--no-decorate", "--date=raw"])
        .args(LOG_SAFE)
        .arg(LOG_FORMAT);
    if let Some(since) = &since {
        log = log.arg(since);
    }
    let mut parser = LogParser::default();
    let mut seen: u32 = 0;
    log.args([tip, "--"])
        .read_only()
        .run_records(0, Some(job.token()), &mut |record| {
            if let Some(commit) = parser.feed(record) {
                aggregator.add(&commit);
                seen += 1;
                if seen % PROGRESS_EVERY == 0 {
                    job.progress(PHASE_HISTORY, Some(percent(seen, total, HISTORY_SHARE)), &format!("{seen}/{total}"));
                }
            }
            true
        })
        .await?;
    if let Some(commit) = parser.finish() {
        aggregator.add(&commit);
    }
    job.progress(PHASE_HISTORY, Some(HISTORY_SHARE), &format!("{total}/{total}"));
    Ok(())
}

/// A file of the tip's tree.
struct TreeFile {
    /// For display and comparison (lossy).
    path: String,
}

async fn list_tree(core: &Core, repo_id: &str, tip: &str) -> CoreResult<Vec<TreeFile>> {
    let out = core.git_for(repo_id)?.args(["ls-tree", "-r", "-l", "-z", "--full-tree", tip]).read_only().no_log().run().await?;
    Ok(out.stdout_z().into_iter().filter_map(parse_tree_entry).collect())
}

/// "<mode> blob <oid> <size>\t<path>"; submodules (`commit`) and anything unreadable → `None`.
fn parse_tree_entry(record: &[u8]) -> Option<TreeFile> {
    let tab = record.iter().position(|&b| b == b'\t')?;
    let meta = std::str::from_utf8(&record[..tab]).ok()?;
    let raw = &record[tab + 1..];
    let kind = meta.split_whitespace().nth(1)?;
    (kind == "blob" && !raw.is_empty()).then(|| TreeFile { path: util::decode_lossy(raw) })
}

/// `done` of `total` as a share of `span` percent.
fn percent(done: u32, total: u32, span: u32) -> u32 {
    if total == 0 {
        return span;
    }
    (u64::from(done.min(total)) * u64::from(span) / u64::from(total)) as u32
}
