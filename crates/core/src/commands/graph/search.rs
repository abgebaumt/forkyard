//! `commit_search` (across the whole history) and `tree_list`.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

use parking_lot::Mutex;

use super::{display_text, is_full_sha, parse_i64, read_cmd, resolve_commit_at, split_shas, Records, LOG_SAFE};
use crate::app::Core;
use crate::commands::history::normalize_rel_path;
use crate::error::{CoreError, CoreResult};
use crate::jobs::CancelToken;
use crate::model::{CommitSearchFilters, CommitSummary, Person};
use crate::util;

/// A search never returns more hits than this.
pub const MAX_SEARCH_RESULTS: u32 = 5000;
/// Shortest SHA prefix that is searched as a SHA.
pub const MIN_SHA_PREFIX: usize = 4;
/// Longest search text; anything beyond it is cut off.
const MAX_QUERY_CHARS: usize = 500;
/// At most this many objects with a matching prefix are looked at.
const MAX_SHA_CANDIDATES: usize = 200;

/// At most this many paths narrow one search.
pub const MAX_SEARCH_PATHS: usize = 100;

/// The checked narrowing of a search: extra `git log` options and literal paths after `--`.
#[derive(Debug, Default)]
struct Narrowing {
    args: Vec<String>,
    paths: Vec<String>,
}

impl Narrowing {
    fn is_empty(&self) -> bool {
        self.args.is_empty() && self.paths.is_empty()
    }
}

/// `YYYY-MM-DD`, optionally with `THH:MM[:SS]` and `Z` or an offset – nothing Git's free-form date
/// parser could read differently from what was typed.
pub(crate) fn is_search_date(value: &str) -> bool {
    regex::Regex::new(r"^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?)?$").is_ok_and(|pattern| pattern.is_match(value))
}

/// `--since=`/`--until=` for a checked date; a bare date covers the whole day (local time, as Git reads it).
fn date_arg(option: &str, value: &str, end_of_day: bool) -> CoreResult<String> {
    if !is_search_date(value) {
        return Err(CoreError::not_allowed(format!("“{value}” is not a date. Use YYYY-MM-DD or an ISO date with a time, e.g. 2026-01-31T18:00:00Z.")));
    }
    let value = match (value.len() == 10, end_of_day) {
        (true, false) => format!("{value} 00:00:00"),
        (true, true) => format!("{value} 23:59:59"),
        (false, _) => value.to_string(),
    };
    Ok(format!("{option}={value}"))
}

fn narrowing(filters: Option<&CommitSearchFilters>) -> CoreResult<Narrowing> {
    let mut out = Narrowing::default();
    let Some(filters) = filters else { return Ok(out) };
    if let Some(text) = filters.pickaxe.as_deref().map(clean_query).filter(|text| !text.is_empty()) {
        out.args.push(format!("-S{text}"));
    }
    if let Some(since) = filters.since.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        out.args.push(date_arg("--since", since, false)?);
    }
    if let Some(until) = filters.until.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        out.args.push(date_arg("--until", until, true)?);
    }
    for path in filters.paths.iter().flatten() {
        let rel = normalize_rel_path(path)?;
        if !out.paths.contains(&rel) {
            out.paths.push(rel);
        }
        if out.paths.len() > MAX_SEARCH_PATHS {
            return Err(CoreError::not_allowed(format!("At most {MAX_SEARCH_PATHS} paths can narrow a search.")));
        }
    }
    Ok(out)
}

const SEARCH_FORMAT: &str = "--format=%H%x00%P%x00%an%x00%ae%x00%at%x00%ct%x00%s";
const SEARCH_FIELDS: usize = 7;
/// What is searched is what can appear in the graph: branches, remote branches, tags and HEAD
/// (for detached HEAD) – not the app's backup refs and not the stash internals.
/// `--ignore-missing`: in a repository without a commit HEAD does not exist yet.
pub(crate) const SEARCH_REFS: [&str; 5] = ["--branches", "--remotes", "--tags", "--ignore-missing", "HEAD"];

/// Running searches per repository and caller (`searchId`): a new search only cancels the
/// previous one of the same caller. That way the search bar and the command palette do not interfere.
#[derive(Default)]
struct SearchState {
    running: Mutex<HashMap<String, (u64, CancelToken)>>,
    counter: AtomicU64,
}

impl SearchState {
    /// Key of a search: repository and caller. Without a `search_id` all callers share
    /// one key (as before).
    fn key(repo_id: &str, search_id: Option<&str>) -> String {
        format!("{repo_id}\0{}", search_id.unwrap_or(""))
    }

    fn begin(&self, key: &str) -> (u64, CancelToken) {
        let generation = self.counter.fetch_add(1, Ordering::Relaxed);
        let mut running = self.running.lock();
        if let Some((_, previous)) = running.remove(key) {
            previous.cancel();
        }
        let token = CancelToken::new();
        running.insert(key.to_string(), (generation, token.clone()));
        (generation, token)
    }

    fn end(&self, key: &str, generation: u64) {
        let mut running = self.running.lock();
        if running.get(key).is_some_and(|(current, _)| *current == generation) {
            running.remove(key);
        }
    }
}

struct Hit {
    committed_at: i64,
    commit: CommitSummary,
}

fn hit(fields: &[Vec<u8>]) -> Hit {
    Hit {
        committed_at: parse_i64(&fields[5]),
        commit: CommitSummary {
            sha: util::decode_lossy(&fields[0]),
            parents: split_shas(&fields[1]),
            author: Person { name: display_text(&fields[2]), email: display_text(&fields[3]) },
            authored_at: util::unix_to_iso(parse_i64(&fields[4])),
            summary: display_text(&fields[6]),
        },
    }
}

/// The input as one line without control characters and of reasonable length: it becomes an
/// argument of Git (a NUL byte or newline in it would make the call fail
/// or turn one search text into several).
fn clean_query(query: &str) -> String {
    let line: String = query.trim().lines().next().unwrap_or("").chars().filter(|c| !c.is_control()).take(MAX_QUERY_CHARS).collect();
    line.trim().to_string()
}

pub(super) async fn commit_search(
    core: &Core,
    repo_id: &str,
    query: &str,
    limit: u32,
    search_id: Option<&str>,
    filters: Option<&CommitSearchFilters>,
) -> CoreResult<Vec<CommitSummary>> {
    let path = core.repo_path(repo_id)?;
    let query = clean_query(query);
    let narrowing = narrowing(filters)?;
    if query.is_empty() && narrowing.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.clamp(1, MAX_SEARCH_RESULTS) as usize;

    let state = core.state::<SearchState>();
    let key = SearchState::key(repo_id, search_id.map(str::trim).filter(|id| !id.is_empty()));
    let (generation, token) = state.begin(&key);
    let result = search(core, &path, repo_id, &query, &narrowing, limit, &token).await;
    state.end(&key, generation);
    result
}

async fn search(core: &Core, path: &Path, repo_id: &str, query: &str, narrowing: &Narrowing, limit: usize, token: &CancelToken) -> CoreResult<Vec<CommitSummary>> {
    let mut hits = if query.is_empty() {
        // Only the narrowing: one `git log` with it.
        log_search(core, path, repo_id, None, narrowing, limit, token).await?
    } else {
        let (by_message, by_author, by_sha) = tokio::join!(
            log_search(core, path, repo_id, Some(format!("--grep={query}")), narrowing, limit, token),
            log_search(core, path, repo_id, Some(format!("--author={query}")), narrowing, limit, token),
            async {
                // A SHA is an exact address: a time window or path does not narrow it.
                if narrowing.is_empty() {
                    sha_search(core, path, repo_id, query, token).await
                } else {
                    Ok(Vec::new())
                }
            },
        );
        let mut hits = by_sha?;
        hits.extend(by_message?);
        hits.extend(by_author?);
        hits
    };
    let mut seen = HashSet::new();
    hits.retain(|h| seen.insert(h.commit.sha.clone()));
    // Newest first; for equal times Git's order is kept.
    hits.sort_by_key(|h| std::cmp::Reverse(h.committed_at));
    hits.truncate(limit);
    Ok(hits.into_iter().map(|h| h.commit).collect())
}

/// `git log` with an optional text filter (`--grep=…` or `--author=…`: fixed text, ignoring case) and the narrowing options.
async fn log_search(core: &Core, path: &Path, repo_id: &str, filter: Option<String>, narrowing: &Narrowing, limit: usize, token: &CancelToken) -> CoreResult<Vec<Hit>> {
    let run = |refs: Vec<String>| async {
        let mut hits = Vec::new();
        let mut records = Records::new(SEARCH_FIELDS);
        let mut on_field = |field: &[u8]| -> bool {
            if let Some(fields) = records.push(field) {
                hits.push(hit(&fields));
            }
            true
        };
        read_cmd(core, path, repo_id)
            // Paths are meant literally, even with `*` or `[`.
            .env("GIT_LITERAL_PATHSPECS", "1")
            .arg("log")
            .args(LOG_SAFE)
            .args(["-z", SEARCH_FORMAT, "--fixed-strings", "--regexp-ignore-case"])
            .args(filter.iter())
            .args(&narrowing.args)
            .arg(format!("--max-count={limit}"))
            .args(refs)
            .arg("--")
            .args(&narrowing.paths)
            .run_records(0, Some(token), &mut on_field)
            .await?;
        Ok::<_, crate::error::CoreError>(hits)
    };
    match run(SEARCH_REFS.iter().map(|arg| arg.to_string()).collect()).await {
        Ok(hits) => Ok(hits),
        Err(error) if error.is(crate::error::ErrorCode::Cancelled) => Err(error),
        Err(error) => {
            // A single corrupt ref ("bad object refs/heads/…") makes `git log --branches`
            // fail entirely: then try once more without it.
            let broken = crate::commands::refs::broken_refs(core, path, repo_id).await;
            if broken.is_empty() {
                return Err(error);
            }
            run(search_refs_without(&broken)).await
        }
    }
}

/// The ref selection of `SEARCH_REFS` without the corrupt refs (full names). `--exclude`
/// applies to the next selection each and expects the name without its prefix.
fn search_refs_without(broken: &[String]) -> Vec<String> {
    let mut args = Vec::new();
    for (prefix, option) in [("refs/heads/", "--branches"), ("refs/remotes/", "--remotes"), ("refs/tags/", "--tags")] {
        for name in broken {
            if let Some(short) = name.strip_prefix(prefix) {
                args.push(format!("--exclude={short}"));
            }
        }
        args.push(option.to_string());
    }
    args.push("--ignore-missing".to_string());
    args.push("HEAD".to_string());
    args
}

/// Commits whose SHA starts with `query` (from 4 hex characters on) and that are reachable
/// from a branch, remote branch, tag or HEAD.
async fn sha_search(core: &Core, path: &Path, repo_id: &str, query: &str, token: &CancelToken) -> CoreResult<Vec<Hit>> {
    if !(MIN_SHA_PREFIX..=64).contains(&query.len()) || !query.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Ok(Vec::new());
    }
    let prefix = query.to_ascii_lowercase();
    // All objects with this prefix, trees and blobs too; those drop out in the next step.
    let listed = read_cmd(core, path, repo_id).arg("rev-parse").arg(format!("--disambiguate={prefix}")).run_raw().await?;
    token.check()?;
    let candidates: Vec<String> = listed
        .stdout_lines()
        .into_iter()
        .map(util::decode_lossy)
        .filter(|sha| is_full_sha(sha) && sha.starts_with(&prefix))
        .take(MAX_SHA_CANDIDATES)
        .collect();
    if !listed.success() || candidates.is_empty() {
        return Ok(Vec::new());
    }
    let mut stdin = String::new();
    for sha in &candidates {
        stdin.push_str(sha);
        stdin.push('\n');
    }

    let mut hits = Vec::new();
    let mut records = Records::new(SEARCH_FIELDS);
    let mut on_field = |field: &[u8]| -> bool {
        if let Some(fields) = records.push(field) {
            hits.push(hit(&fields));
        }
        true
    };
    // What is reachable from the candidates but from no ref: orphaned commits.
    let wanted: HashSet<&str> = candidates.iter().map(String::as_str).collect();
    let mut orphaned: HashSet<String> = HashSet::new();
    let mut on_line = |line: &[u8]| -> bool {
        if let Ok(sha) = std::str::from_utf8(line) {
            let sha = sha.trim();
            if wanted.contains(sha) {
                orphaned.insert(sha.to_string());
            }
        }
        true
    };
    let (found, unreachable) = tokio::join!(
        read_cmd(core, path, repo_id)
            .args(["log", "--no-walk=unsorted"])
            .args(LOG_SAFE)
            .args(["-z", SEARCH_FORMAT, "--stdin"])
            .stdin(stdin.clone())
            .run_records(0, Some(token), &mut on_field),
        read_cmd(core, path, repo_id)
            .args(["rev-list", "--ignore-missing", "--stdin", "--not", "--branches", "--remotes", "--tags", "HEAD"])
            .stdin(stdin.clone())
            .run_records(b'\n', Some(token), &mut on_line),
    );
    found?;
    unreachable?;
    // A tag object with a matching prefix points to a commit with a different SHA: no hit.
    hits.retain(|h| h.commit.sha.starts_with(&prefix) && !orphaned.contains(&h.commit.sha));
    Ok(hits)
}

/// The list entries of these commits (full SHAs), in the given order.
pub(crate) async fn commit_summaries(core: &Core, path: &Path, repo_id: &str, shas: &[String], token: &CancelToken) -> CoreResult<Vec<CommitSummary>> {
    if shas.is_empty() {
        return Ok(Vec::new());
    }
    let mut stdin = String::new();
    for sha in shas.iter().filter(|sha| is_full_sha(sha)) {
        stdin.push_str(sha);
        stdin.push('\n');
    }
    let mut found = Vec::new();
    let mut records = Records::new(SEARCH_FIELDS);
    let mut on_field = |field: &[u8]| -> bool {
        if let Some(fields) = records.push(field) {
            found.push(hit(&fields).commit);
        }
        true
    };
    read_cmd(core, path, repo_id)
        .args(["log", "--no-walk=unsorted"])
        .args(LOG_SAFE)
        .args(["-z", SEARCH_FORMAT, "--stdin"])
        .stdin(stdin)
        .run_records(0, Some(token), &mut on_field)
        .await?;
    Ok(found)
}

/// All files of a commit or of the working directory (tracked and untracked,
/// without ignored ones and without those deleted in the working directory). `filter`: case-insensitive substring.
pub(super) async fn tree_list(core: &Core, repo_id: &str, sha: Option<&str>, filter: Option<&str>) -> CoreResult<Vec<String>> {
    let path = core.repo_path(repo_id)?;
    let needle = filter.map(|f| f.trim().replace('\\', "/").to_lowercase()).filter(|f| !f.is_empty());
    let matches = |file: &str| match &needle {
        Some(needle) => file.to_lowercase().contains(needle.as_str()),
        None => true,
    };
    match sha {
        Some(rev) => {
            let sha = resolve_commit_at(core, &path, repo_id, rev).await?;
            let mut out = Vec::new();
            let mut on_path = |raw: &[u8]| -> bool {
                let file = util::decode_lossy(raw);
                if matches(&file) {
                    out.push(file);
                }
                true
            };
            read_cmd(core, &path, repo_id)
                .args(["ls-tree", "-r", "-z", "--name-only", "--full-tree", sha.as_str()])
                .run_records(0, None, &mut on_path)
                .await?;
            Ok(out)
        }
        None => {
            let (present, deleted) = tokio::join!(
                read_cmd(core, &path, repo_id).args(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).run(),
                read_cmd(core, &path, repo_id).args(["ls-files", "-z", "--deleted"]).run(),
            );
            let (present, deleted) = (present?, deleted?);
            let gone: HashSet<&[u8]> = deleted.stdout_z().into_iter().collect();
            // Conflicted files appear several times in the index; the set sorts and removes duplicates.
            let files: BTreeSet<&[u8]> = present.stdout_z().into_iter().filter(|p| !gone.contains(p)).collect();
            Ok(files.into_iter().map(util::decode_lossy).filter(|f| matches(f)).collect())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queries_become_one_clean_line() {
        assert_eq!(clean_query("  Größe ändern \t"), "Größe ändern");
        assert_eq!(clean_query("erste\nzweite"), "erste");
        assert_eq!(clean_query("a\0b\u{7}c"), "abc");
        assert_eq!(clean_query(" \n "), "");
        assert_eq!(clean_query(&"ä".repeat(2000)).chars().count(), MAX_QUERY_CHARS);
    }

    #[test]
    fn a_new_search_cancels_the_previous_one() {
        let state = SearchState::default();
        let (first_gen, first) = state.begin("r");
        let (other_gen, other) = state.begin("anderes");
        let (second_gen, second) = state.begin("r");
        assert!(first.is_cancelled());
        assert!(!second.is_cancelled());
        assert!(!other.is_cancelled());
        assert_ne!(first_gen, second_gen);
        // The cancelled search does not clean up the new one.
        state.end("r", first_gen);
        assert!(state.running.lock().contains_key("r"));
        state.end("r", second_gen);
        assert!(!state.running.lock().contains_key("r"));
        state.end("anderes", other_gen);
        assert!(state.running.lock().is_empty());
    }

    #[test]
    fn searches_with_different_ids_do_not_cancel_each_other() {
        let state = SearchState::default();
        let palette = SearchState::key("r", Some("palette"));
        let bar = SearchState::key("r", Some("searchbar"));
        let shared = SearchState::key("r", None);
        assert_ne!(palette, bar);
        assert_ne!(palette, shared);
        assert_ne!(SearchState::key("r", Some("palette")), SearchState::key("anderes", Some("palette")));
        let (_, first_palette) = state.begin(&palette);
        let (_, first_bar) = state.begin(&bar);
        let (_, first_shared) = state.begin(&shared);
        assert!(!first_palette.is_cancelled() && !first_bar.is_cancelled() && !first_shared.is_cancelled());
        let (_, second_palette) = state.begin(&palette);
        assert!(first_palette.is_cancelled());
        assert!(!second_palette.is_cancelled() && !first_bar.is_cancelled() && !first_shared.is_cancelled());
        let (_, second_shared) = state.begin(&shared);
        assert!(first_shared.is_cancelled() && !second_shared.is_cancelled() && !first_bar.is_cancelled());
    }
}
