//! Line archaeology (v1.2, Paket 7.1): why a line looks the way it does.
//!
//! - `line_archaeology` (no AI): the commits that shaped the line (`git log -L`, Paket 0) with their
//!   full messages, the change of the line in each, and the pull requests, issues and tickets they
//!   name – found with the repository's ticket link rules. A line of the working directory is first
//!   traced to the commit that last changed it (`git blame -L`).
//! - `ai_archaeology`: the AI provider summarises that timeline (`ai::archaeology`).
//!
//! The timeline is cached for ten minutes per start commit, path and line, so “What is sent?” and
//! the request build the same text. Messages and file contents are read with `no_log`.

mod refs;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod ai_tests;

use std::collections::HashMap;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use crate::ai::{archaeology as ai_archaeology_context, run};
use crate::app::Core;
use crate::commands::ai::request_frame;
use crate::commands::graph::{is_full_sha, resolve_commit, LOG_SAFE};
use crate::commands::history::{decode_line, line_history_with_diffs, normalize_rel_path, repo_encoding, LINE_HISTORY_STEPS};
use crate::commands::links::link_rules_get;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::errors::classify;
use crate::model::{AiFeature, ArchaeologyAnswer, ArchaeologyHostLookup, ArchaeologyRefKind, ArchaeologyStep, LineArchaeology, LinkRule};
use crate::util;

pub use refs::{number_of, CompiledRules, MAX_REFS_PER_MESSAGE};

/// Longer commit messages are cut (with `…`).
pub const MAX_MESSAGE_BYTES: usize = 4_000;
/// Lines of a step's change; more become one line “… n more lines”.
pub const MAX_DIFF_LINES: usize = 40;
pub const MAX_DIFF_LINE_BYTES: usize = 400;
/// Lines of code shown around the selected line, on each side.
pub const CODE_CONTEXT: u32 = 3;
/// Distinct host references whose titles are looked up per timeline, newest steps first.
pub const MAX_HOST_LOOKUPS: usize = 5;
/// Longer titles from the host are cut.
const MAX_TITLE_BYTES: usize = 300;
const CACHE_TTL: Duration = Duration::from_secs(600);
const CACHE_ENTRIES: usize = 16;

/// Built timelines: key = repository, start commit, path, line, effective link rules.
#[derive(Default)]
pub(crate) struct ArchaeologyCache {
    entries: Mutex<Vec<(String, Instant, LineArchaeology)>>,
}

impl ArchaeologyCache {
    fn get(&self, key: &str) -> Option<LineArchaeology> {
        let mut entries = self.entries.lock();
        entries.retain(|(_, at, _)| at.elapsed() < CACHE_TTL);
        entries.iter().find(|(known, _, _)| known == key).map(|(_, _, value)| value.clone())
    }

    fn put(&self, key: String, value: LineArchaeology) {
        let mut entries = self.entries.lock();
        entries.retain(|(known, _, _)| *known != key);
        entries.push((key, Instant::now(), value));
        if entries.len() > CACHE_ENTRIES {
            let excess = entries.len() - CACHE_ENTRIES;
            entries.drain(..excess);
        }
    }
}

/// The history of line `line` (1-based) of `path` at commit `sha` (`None` = working directory),
/// newest first. See the module documentation.
pub async fn line_archaeology(core: &Core, repo_id: String, path: String, line: u32, sha: Option<String>) -> CoreResult<LineArchaeology> {
    timeline(core, &repo_id, &path, line, sha.as_deref()).await
}

/// “Why is this so?”: the AI provider summarises the timeline of the line. Builds exactly the text
/// “What is sent?” shows for `AiInput::Archaeology` (same timeline from the cache, same budget and
/// secrets from `request_frame`), sends it through `run::complete_json` as job `job_id` and checks the answer against the
/// timeline – nothing is executed, the answer is only text.
pub async fn ai_archaeology(core: &Core, repo_id: String, job_id: String, path: String, line: u32, sha: Option<String>, locale: String) -> CoreResult<ArchaeologyAnswer> {
    let settings = run::ensure_allowed(core, Some(&repo_id), AiFeature::Archaeology)?;
    let found = timeline(core, &repo_id, &path, line, sha.as_deref()).await?;
    let (budget, secrets) = request_frame(core, &settings, AiFeature::Archaeology).await;
    let built = ai_archaeology_context::build(core, &repo_id, &settings, budget, &locale, &secrets, &found).await?;
    let schema = ai_archaeology_context::schema();
    let answer = run::complete_json(core, run::AiRequest { repo_id: Some(&repo_id), feature: AiFeature::Archaeology, job_id: &job_id, prompt: &built.prompt, schema: &schema }).await?;
    let mut parsed = ai_archaeology_context::parse_answer(&answer.value, &found)?;
    parsed.cost_usd = answer.cost_usd;
    Ok(parsed)
}

/// `line_archaeology` for the core's own callers (preview, AI request); cached.
pub(crate) async fn timeline(core: &Core, repo_id: &str, path: &str, line: u32, sha: Option<&str>) -> CoreResult<LineArchaeology> {
    let rel = normalize_rel_path(path)?;
    if line == 0 {
        return Err(CoreError::not_allowed("Lines are counted from 1."));
    }
    let (start_sha, start_path, start_line) = match sha {
        Some(rev) => (resolve_commit(core, repo_id, rev).await?, rel, line),
        None => blame_origin(core, repo_id, &rel, line).await?,
    };
    // Read before the cache: a changed rule or `.forkyard/links.json` is a different timeline.
    let rules = link_rules_get(core, repo_id.to_string()).await?.rules;
    let rules_key = rules.iter().map(|rule| format!("{}\u{1f}{}\u{1f}{}", rule.id, rule.pattern, rule.url)).collect::<Vec<_>>().join("\u{1e}");
    let key = format!("{repo_id}\0{start_sha}\0{start_path}\0{start_line}\0{rules_key}");
    let cache = core.state::<ArchaeologyCache>();
    if let Some(hit) = cache.get(&key) {
        return Ok(hit);
    }
    let built = build(core, repo_id, &start_sha, &start_path, start_line, &rules).await?;
    cache.put(key, built.clone());
    Ok(built)
}

/// Line `line` of the working-directory file → (commit that last changed it, its path there, its
/// line number there).
async fn blame_origin(core: &Core, repo_id: &str, rel: &str, line: u32) -> CoreResult<(String, String, u32)> {
    let out = core
        .git_for(repo_id)?
        .args(["-c", "core.quotePath=false", "blame", "--porcelain"])
        .arg(format!("-L{line},{line}"))
        .args(["--", rel])
        .read_only()
        .no_log()
        .run_raw()
        .await?;
    let not_committed = || CoreError::not_allowed(format!("Line {line} of “{rel}” is not committed yet, so it has no history."));
    if !out.success() {
        let text = out.stderr_text();
        let lower = text.to_lowercase();
        if lower.contains("has only") || lower.contains("no such file") || lower.contains("cannot lstat") {
            return Err(CoreError::not_found(format!("Line {line} of “{rel}” doesn’t exist in the working directory.")).with_git_output(text));
        }
        if lower.contains("no such path") {
            return Err(not_committed());
        }
        return Err(classify("blame", out.code, &out.stdout, &out.stderr));
    }
    let mut sha = String::new();
    let mut origin_line = 0u32;
    let mut origin_path = None;
    for raw in out.stdout.split(|&byte| byte == b'\n') {
        if raw.starts_with(b"\t") {
            break;
        }
        let text = util::decode_lossy(raw);
        if sha.is_empty() {
            let mut parts = text.split(' ');
            sha = parts.next().unwrap_or_default().to_string();
            origin_line = parts.next().and_then(|number| number.parse().ok()).unwrap_or(0);
        } else if let Some(name) = text.strip_prefix("filename ") {
            // A name Git had to quote (control characters, `"`) falls back to today's name.
            origin_path = Some(name.to_string()).filter(|name| !name.starts_with('"'));
        }
    }
    if sha.is_empty() || sha.bytes().all(|byte| byte == b'0') {
        return Err(not_committed());
    }
    if !is_full_sha(&sha) || origin_line == 0 {
        return Err(CoreError::unknown("Git blame gave an answer Forkyard does not understand."));
    }
    Ok((sha, origin_path.unwrap_or_else(|| rel.to_string()), origin_line))
}

async fn build(core: &Core, repo_id: &str, sha: &str, path: &str, line: u32, rules: &[LinkRule]) -> CoreResult<LineArchaeology> {
    let records = line_history_with_diffs(core, repo_id, path, line, sha).await?;
    let (code_start, code) = code_around(core, repo_id, sha, path, line).await?;
    let wanted: Vec<&str> = records.iter().map(|(step, _)| step.commit.sha.as_str()).collect();
    let messages = full_messages(core, repo_id, &wanted).await?;
    let rules = CompiledRules::new(rules);
    let may_have_more = records.len() >= LINE_HISTORY_STEPS as usize;
    let mut steps: Vec<ArchaeologyStep> = records
        .into_iter()
        .map(|(step, diff)| {
            let message = messages.get(&step.commit.sha).cloned().unwrap_or_else(|| step.commit.summary.clone());
            let refs = rules.find(&message);
            ArchaeologyStep { commit: step.commit, path: step.path, start_line: step.start_line, end_line: step.end_line, message, diff: clip_diff(diff), refs }
        })
        .collect();
    let host_lookup = lookup_titles(core, repo_id, &mut steps).await;
    Ok(LineArchaeology { path: path.to_string(), line, sha: sha.to_string(), code_start, code, steps, may_have_more, host_lookup })
}

/// Titles of the pull requests and issues the steps name, from the host: at most
/// `MAX_HOST_LOOKUPS` distinct numbers in the order of the steps (newest first). `#n` is asked as an
/// issue first and, if the host does not know such an issue, as a pull request (GitHub and Gitea
/// answer pull requests on the issue address); `!n` as a pull request. No account or no supported
/// host → `NotConnected`; any other error stops the lookups → `Failed`. The links always stay.
/// Only titles are kept – bodies and comments `issue_get` reads are dropped here.
async fn lookup_titles(core: &Core, repo_id: &str, steps: &mut [ArchaeologyStep]) -> ArchaeologyHostLookup {
    let mut wanted: Vec<(ArchaeologyRefKind, u64)> = Vec::new();
    for reference in steps.iter().flat_map(|step| step.refs.iter()) {
        if reference.kind == ArchaeologyRefKind::Ticket {
            continue;
        }
        let Some(number) = number_of(reference) else { continue };
        if wanted.len() < MAX_HOST_LOOKUPS && !wanted.contains(&(reference.kind, number)) {
            wanted.push((reference.kind, number));
        }
    }
    if wanted.is_empty() {
        return ArchaeologyHostLookup::None;
    }
    let repo_api = match crate::host::api_for_repo(core, repo_id, None).await {
        Ok(found) => found,
        Err(error) if matches!(error.code, ErrorCode::HostNotConnected | ErrorCode::HostUnsupported) => return ArchaeologyHostLookup::NotConnected,
        Err(_) => return ArchaeologyHostLookup::Failed,
    };
    let hoster = crate::host::host(repo_api.api.kind);
    let mut outcome = ArchaeologyHostLookup::Done;
    let mut titles: Vec<((ArchaeologyRefKind, u64), ArchaeologyRefKind, String)> = Vec::new();
    for (kind, number) in wanted {
        let found = match kind {
            ArchaeologyRefKind::Issue => match hoster.issue_get(core, &repo_api.api, &repo_api.repo, number).await {
                Ok(issue) => Ok(Some((ArchaeologyRefKind::Issue, issue.summary.title))),
                Err(error) if error.code == ErrorCode::HostNotFound => pull_title(core, hoster, &repo_api, number).await,
                Err(error) => Err(error),
            },
            _ => pull_title(core, hoster, &repo_api, number).await,
        };
        match found {
            Ok(Some((shown, title))) => titles.push(((kind, number), shown, clip(title.trim(), MAX_TITLE_BYTES))),
            Ok(None) => {}
            Err(_) => {
                outcome = ArchaeologyHostLookup::Failed;
                break;
            }
        }
    }
    for reference in steps.iter_mut().flat_map(|step| step.refs.iter_mut()) {
        let Some(number) = number_of(reference) else { continue };
        if let Some((_, shown, title)) = titles.iter().find(|(key, _, _)| *key == (reference.kind, number)) {
            reference.kind = *shown;
            reference.title = Some(title.clone());
        }
    }
    outcome
}

/// Title of pull request `number` (header only, `pr_head`); `None` if the host does not know it.
async fn pull_title(core: &Core, hoster: &dyn crate::host::Host, repo_api: &crate::host::RepoApi, number: u64) -> CoreResult<Option<(ArchaeologyRefKind, String)>> {
    match hoster.pr_head(core, &repo_api.api, &repo_api.repo, number).await {
        Ok(pull) => Ok(Some((ArchaeologyRefKind::PullRequest, pull.title))),
        Err(error) if error.code == ErrorCode::HostNotFound => Ok(None),
        Err(error) => Err(error),
    }
}

/// Full messages of the commits, by SHA (`%B`, at most `MAX_MESSAGE_BYTES` each). Records end with
/// NUL (`-z`), which no commit message can contain – a message cannot fake another commit's record.
async fn full_messages(core: &Core, repo_id: &str, shas: &[&str]) -> CoreResult<HashMap<String, String>> {
    if shas.is_empty() {
        return Ok(HashMap::new());
    }
    let out = core
        .git_for(repo_id)?
        .args(["log", "--no-walk=unsorted", "--no-color", "-z"])
        .args(LOG_SAFE)
        .arg("--format=%H%x1f%B")
        .args(shas.iter().copied())
        .arg("--")
        .read_only()
        .no_log()
        .run_raw()
        .await?;
    if !out.success() {
        return Err(classify("log", out.code, &out.stdout, &out.stderr));
    }
    let mut messages = HashMap::new();
    for record in out.stdout.split(|&byte| byte == 0).filter(|record| !record.is_empty()) {
        let Some(split) = record.iter().position(|&byte| byte == 0x1f) else { continue };
        let sha = util::decode_lossy(&record[..split]).trim().to_string();
        if !is_full_sha(&sha) || !shas.contains(&sha.as_str()) {
            continue;
        }
        let body = util::decode_lossy(&record[split + 1..]);
        messages.insert(sha, clip(body.trim_end(), MAX_MESSAGE_BYTES));
    }
    Ok(messages)
}

/// The line with `CODE_CONTEXT` lines on each side, at `sha`, decoded like blame lines.
async fn code_around(core: &Core, repo_id: &str, sha: &str, path: &str, line: u32) -> CoreResult<(u32, Vec<String>)> {
    let out = core.git_for(repo_id)?.args(["cat-file", "blob"]).arg(format!("{sha}:{path}")).read_only().no_log().run_raw().await?;
    if !out.success() {
        return Err(CoreError::not_found(format!("“{path}” does not exist in commit {}.", &sha[..sha.len().min(7)])));
    }
    let preferred = repo_encoding(core, repo_id);
    let mut lines: Vec<&[u8]> = out.stdout.split(|&byte| byte == b'\n').collect();
    if lines.last().is_some_and(|last| last.is_empty()) {
        lines.pop();
    }
    let count = lines.len() as u32;
    if line > count {
        return Err(CoreError::not_found(format!("Line {line} of “{path}” doesn’t exist at this commit.")));
    }
    let first = line.saturating_sub(CODE_CONTEXT).max(1);
    let last = (line + CODE_CONTEXT).min(count);
    let code = (first..=last)
        .map(|number| {
            let raw = lines[(number - 1) as usize];
            clip(&decode_line(raw.strip_suffix(b"\r").unwrap_or(raw), &preferred), MAX_DIFF_LINE_BYTES)
        })
        .collect();
    Ok((first, code))
}

fn clip_diff(lines: Vec<String>) -> Vec<String> {
    let total = lines.len();
    let mut clipped: Vec<String> = lines.into_iter().take(MAX_DIFF_LINES).map(|line| clip(&line, MAX_DIFF_LINE_BYTES)).collect();
    if total > MAX_DIFF_LINES {
        clipped.push(format!("… {} more lines", total - MAX_DIFF_LINES));
    }
    clipped
}

/// `text` cut to at most `max` bytes at a character boundary, with `…` when cut.
pub(crate) fn clip(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}
