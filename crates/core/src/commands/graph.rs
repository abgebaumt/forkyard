//! Graph, commit details, search, file list.
//!
//! All four commands only read: no lock, no event, no log entry,
//! `GIT_OPTIONAL_LOCKS=0`. Structure:
//! - `layout`: the lane layout (pure computation, without Git),
//! - `page`: `graph_page`,
//! - `details`: `commit_details`,
//! - `search`: `commit_search` and `tree_list`.
//!
//! Reusable for other commands: `resolve_commit`, `read_ref_tips`, `read_stashes`.

mod details;
pub mod layout;
mod page;
mod search;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod search_filter_tests;

use std::collections::HashMap;
use std::path::Path;

use crate::app::Core;
use crate::error::{CoreError, CoreResult};
use crate::git::GitCmd;
use crate::model::{CommitDetails, CommitSearchFilters, CommitSummary, DiffSource, GraphPage, RefKind, RefLabelInfo};
use crate::util;

pub use details::parse_co_authors;
pub use page::{MAX_PAGE_SIZE, STASH_REF, WIP_ID};
pub use search::{MAX_SEARCH_PATHS, MAX_SEARCH_RESULTS, MIN_SHA_PREFIX};
pub(crate) use search::{commit_summaries, is_search_date, SEARCH_REFS};

/// One page of the graph with a finished lane layout; first page with `cursor: None` (with WIP and stash rows).
pub async fn graph_page(core: &Core, repo_id: String, cursor: Option<String>, limit: u32) -> CoreResult<GraphPage> {
    page::graph_page(core, &repo_id, cursor.as_deref(), limit).await
}

/// Metadata and changed files of a commit, range or stash.
pub async fn commit_details(core: &Core, repo_id: String, source: DiffSource) -> CoreResult<CommitDetails> {
    details::commit_details(core, &repo_id, source).await
}

/// Search in message, SHA and author across the whole history, optionally narrowed by `filters`
/// (code, time window, paths). A new search cancels the one still running with the same `search_id`
/// in the same repository (`cancelled`); searches with different IDs run side by side. Without a
/// `search_id` all callers share one.
pub async fn commit_search(
    core: &Core,
    repo_id: String,
    query: String,
    limit: u32,
    search_id: Option<String>,
    filters: Option<CommitSearchFilters>,
) -> CoreResult<Vec<CommitSummary>> {
    search::commit_search(core, &repo_id, &query, limit, search_id.as_deref(), filters.as_ref()).await
}

/// All files of a commit (`sha: None` = working directory), optionally filtered.
pub async fn tree_list(core: &Core, repo_id: String, sha: Option<String>, filter: Option<String>) -> CoreResult<Vec<String>> {
    search::tree_list(core, &repo_id, sha.as_deref(), filter.as_deref()).await
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// Switches for every `git log`: the user's configuration (`log.showSignature`,
/// `i18n.logOutputEncoding`) must not change the output.
pub(crate) const LOG_SAFE: [&str; 2] = ["--no-show-signature", "--encoding=UTF-8"];

pub(crate) fn read_cmd(core: &Core, path: &Path, repo_id: &str) -> GitCmd {
    core.git.cmd(path).repo(repo_id).read_only().no_log()
}

/// Full SHA (SHA-1 or SHA-256).
pub(crate) fn is_full_sha(text: &str) -> bool {
    (text.len() == 40 || text.len() == 64) && text.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Resolves a commit name (SHA, prefix, branch, `HEAD` …) to the full SHA.
/// `not_found` if the commit does not exist.
pub async fn resolve_commit(core: &Core, repo_id: &str, rev: &str) -> CoreResult<String> {
    let path = core.repo_path(repo_id)?;
    resolve_commit_at(core, &path, repo_id, rev).await
}

pub(crate) async fn resolve_commit_at(core: &Core, path: &Path, repo_id: &str, rev: &str) -> CoreResult<String> {
    let rev = rev.trim();
    if rev.is_empty() || rev.starts_with('-') || rev.chars().any(|c| c.is_control()) {
        return Err(commit_not_found(rev));
    }
    let out = read_cmd(core, path, repo_id)
        .args(["rev-parse", "-q", "--verify", "--end-of-options"])
        .arg(format!("{rev}^{{commit}}"))
        .run_raw()
        .await?;
    let sha = out.stdout_text();
    if out.success() && is_full_sha(&sha) {
        Ok(sha)
    } else {
        Err(other_failure(&out, "rev-parse").unwrap_or_else(|| commit_not_found(rev)))
    }
}

pub(crate) fn commit_not_found(rev: &str) -> CoreError {
    let shown: String = rev.chars().filter(|c| !c.is_control()).take(40).collect();
    CoreError::not_found(format!("Commit “{shown}” was not found."))
}

/// A failed call that does not mean "does not exist" but something else
/// (no repository any more, folder not trusted …): this error takes precedence.
pub(crate) fn other_failure(out: &crate::git::GitOutput, subcommand: &str) -> Option<CoreError> {
    if out.success() {
        return None;
    }
    let err = crate::git::errors::classify(subcommand, out.code, &out.stdout, &out.stderr);
    (!matches!(err.code, crate::error::ErrorCode::NotFound | crate::error::ErrorCode::Unknown)).then_some(err)
}

/// Fields per ref, each terminated with NUL (Git appends a newline per record).
const REF_FORMAT: &str =
    "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(HEAD)%00%(symref)%00";
const REF_FIELDS: usize = 7;

/// A branch, remote branch or tag with the commit it points to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefTip {
    pub label: RefLabelInfo,
    /// For annotated tags the target commit.
    pub sha: String,
}

/// Parses `git for-each-ref` with `REF_FORMAT`. Left out are `origin/HEAD` (only a
/// pointer) and refs that do not point to a commit (tag on a tree or blob).
pub(crate) fn parse_ref_tips(stdout: &[u8]) -> Vec<RefTip> {
    let fields: Vec<&[u8]> = stdout.split(|&b| b == 0).collect();
    let mut out = Vec::new();
    for f in fields.chunks(REF_FIELDS) {
        if f.len() < REF_FIELDS {
            break;
        }
        let full_name = util::decode_lossy(f[0].strip_prefix(b"\n").unwrap_or(f[0]));
        let (kind, name) = if let Some(n) = full_name.strip_prefix("refs/heads/") {
            (RefKind::Local, n)
        } else if let Some(n) = full_name.strip_prefix("refs/remotes/") {
            (RefKind::Remote, n)
        } else if let Some(n) = full_name.strip_prefix("refs/tags/") {
            (RefKind::Tag, n)
        } else {
            continue;
        };
        if kind == RefKind::Remote && !f[6].is_empty() {
            continue;
        }
        let sha = if f[2] == b"commit" {
            f[1]
        } else if f[2] == b"tag" && f[4] == b"commit" {
            f[3]
        } else {
            continue;
        };
        out.push(RefTip {
            label: RefLabelInfo {
                kind,
                name: name.to_string(),
                full_name: full_name.clone(),
                is_head: kind == RefKind::Local && f[5] == b"*",
            },
            sha: util::decode_lossy(sha),
        });
    }
    out
}

/// Branches, remote branches and tags with their commit – without upstream and ahead/behind,
/// so fast even with many refs. `points_at`: only refs pointing to this commit.
pub async fn read_ref_tips(core: &Core, path: &Path, repo_id: &str, points_at: Option<&str>) -> CoreResult<Vec<RefTip>> {
    let mut options = vec![REF_FORMAT.to_string()];
    if let Some(sha) = points_at {
        options.push(format!("--points-at={sha}"));
    }
    let out = crate::commands::refs::for_each_ref(core, path, repo_id, &options, &["refs/heads", "refs/remotes", "refs/tags"]).await?;
    Ok(parse_ref_tips(&out.stdout))
}

/// One entry of the stash list. `parents`: base commit, index commit, optionally the
/// commit with the untracked files.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StashEntry {
    pub index: u32,
    pub sha: String,
    pub parents: Vec<String>,
    /// Text from the reflog, e.g. "WIP on main: 1a2b3c4 Title" or "On main: own text".
    pub message: String,
    pub author_name: String,
    pub author_email: String,
    pub authored_at: i64,
}

impl StashEntry {
    /// The commit the stash was made on.
    pub fn base(&self) -> Option<&str> {
        self.parents.first().map(String::as_str)
    }
    /// The commit with the untracked files (`stash -u`), if present.
    pub fn untracked(&self) -> Option<&str> {
        self.parents.get(2).map(String::as_str)
    }
}

/// All stashes, `stash@{0}` first. Without a stash: empty list.
pub async fn read_stashes(core: &Core, path: &Path, repo_id: &str) -> CoreResult<Vec<StashEntry>> {
    // Reflog of refs/stash; if the ref is missing Git reports an error – that only means "no stash".
    let listed = read_cmd(core, path, repo_id)
        .args(["log", "-g"])
        .args(LOG_SAFE)
        .args(["-z", "--format=%H%x00%gs", "refs/stash", "--"])
        .run_raw()
        .await?;
    if !listed.success() {
        return Ok(Vec::new());
    }
    let fields = listed.stdout_z();
    let entries: Vec<(String, String)> =
        fields.chunks(2).filter(|c| c.len() == 2).map(|c| (util::decode_lossy(c[0]), display_text(c[1]))).collect();
    if entries.is_empty() {
        return Ok(Vec::new());
    }
    // Fetch parents and author separately: when walking the reflog the parents are not reliable.
    let mut stdin = String::new();
    for (sha, _) in &entries {
        stdin.push_str(sha);
        stdin.push('\n');
    }
    let meta = read_cmd(core, path, repo_id)
        .args(["log", "--no-walk=unsorted"])
        .args(LOG_SAFE)
        .args(["-z", "--format=%H%x00%P%x00%an%x00%ae%x00%at", "--stdin"])
        .stdin(stdin)
        .run()
        .await?;
    let fields = meta.stdout_z();
    let by_sha: HashMap<String, &[&[u8]]> = fields.chunks(5).filter(|c| c.len() == 5).map(|c| (util::decode_lossy(c[0]), c)).collect();
    let mut out = Vec::with_capacity(entries.len());
    for (index, (sha, message)) in entries.into_iter().enumerate() {
        let Some(f) = by_sha.get(&sha) else { continue };
        out.push(StashEntry {
            index: index as u32,
            parents: split_shas(f[1]),
            message,
            author_name: display_text(f[2]),
            author_email: display_text(f[3]),
            authored_at: parse_i64(f[4]),
            sha,
        });
    }
    Ok(out)
}

/// Text from a commit (message, name) for display. Git returns UTF-8 if the commit
/// names its encoding; old commits without that may be encoded differently – then it is guessed.
pub(crate) fn display_text(bytes: &[u8]) -> String {
    util::decode_text(bytes).0
}

/// `%P`: SHAs separated by spaces.
pub(crate) fn split_shas(field: &[u8]) -> Vec<String> {
    field.split(|&b| b == b' ').filter(|p| !p.is_empty()).map(util::decode_lossy).collect()
}

pub(crate) fn parse_i64(field: &[u8]) -> i64 {
    std::str::from_utf8(field).ok().and_then(|t| t.trim().parse().ok()).unwrap_or(0)
}

/// Collects the NUL-separated fields of a `git log -z --format=…` stream into records
/// with a fixed number of fields.
pub(crate) struct Records {
    width: usize,
    fields: Vec<Vec<u8>>,
}

impl Records {
    pub(crate) fn new(width: usize) -> Self {
        Records { width, fields: Vec::with_capacity(width) }
    }
    /// Takes one field; if that completes the record, it is returned.
    pub(crate) fn push(&mut self, field: &[u8]) -> Option<Vec<Vec<u8>>> {
        self.fields.push(field.to_vec());
        if self.fields.len() == self.width {
            Some(std::mem::replace(&mut self.fields, Vec::with_capacity(self.width)))
        } else {
            None
        }
    }
}
