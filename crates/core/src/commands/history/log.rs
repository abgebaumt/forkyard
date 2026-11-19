//! A file's history: its commits, following renames.

use super::*;

// ---------------------------------------------------------------------------
// file_history
// ---------------------------------------------------------------------------

/// Commits of a file, newest first; follows renames. `path` is the current path
/// (also of a deleted file: then the history reaches up to the deletion). Unknown
/// path and repository without a commit → empty list. `limit: 0` = 1000.
///
/// `offset` skips that many entries at the start (loading more: `offset` = number of those
/// already loaded). Git starts from the newest commit every time – only that way does following
/// renames stay correct (`git log --follow --skip` loses track across a
/// rename) –, but only the `limit` entries from `offset` on are returned.
pub async fn file_history(
    core: &Core,
    repo_id: String,
    path: String,
    limit: u32,
    offset: Option<u32>,
) -> CoreResult<Vec<FileHistoryEntry>> {
    let rel = util::normalize_rel_path(&path)?;
    let head = core.git_for(&repo_id)?.args(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).read().run_raw().await?;
    if !head.success() {
        return Ok(Vec::new());
    }
    let limit = if limit == 0 { DEFAULT_HISTORY_LIMIT } else { limit.min(MAX_HISTORY_LIMIT) };
    let offset = offset.unwrap_or(0);
    let max_count = format!("--max-count={}", offset.saturating_add(limit));
    let mut parser = HistoryParser::new(&rel);
    core.git_for(&repo_id)?
        // The path is meant literally, even if it contains "*" or "[".
        .literal_paths()
        .args(["log", "--follow", "-M", "--diff-merges=first-parent", "--raw", "--numstat", "-z"])
        .args(LOG_SAFE)
        .args(["--no-decorate", max_count.as_str(), &gitlog::marked_format(HEADER), "--", rel.as_str()])
        .read_only()
        .run_records(0, None, &mut |record| {
            parser.feed(record);
            true
        })
        .await?;
    Ok(parser.finish().into_iter().skip(offset as usize).collect())
}

/// `git log -z --raw --numstat <marked_format(HEADER)>` of one file, commit by commit.
pub(super) struct HistoryParser {
    pub(super) log: gitlog::LogParser,
    /// Name of the file in the commit currently being read (changes at renames).
    pub(super) name: String,
    pub(super) entries: Vec<FileHistoryEntry>,
}

impl HistoryParser {
    pub(super) fn new(path: &str) -> Self {
        HistoryParser { log: gitlog::LogParser::new(HEADER_FIELDS), name: path.to_string(), entries: Vec::new() }
    }

    pub(super) fn feed(&mut self, record: &[u8]) {
        if let Some(commit) = self.log.feed_complete(record) {
            self.add(commit);
        }
    }

    pub(super) fn add(&mut self, commit: gitlog::LogCommit) {
        let raw = commit.raw.first();
        let path = raw.map(|raw| util::decode_lossy(&raw.path));
        let old = raw.and_then(|raw| raw.old_path.as_deref()).map(util::decode_lossy);
        let (status, old_path) = match raw.map(|raw| raw.status) {
            Some(b'R') => (FileStatus::Renamed, old),
            // Copy: like a new file, with a reference to the source.
            Some(b'C') => (FileStatus::Added, old),
            Some(b'A') => (FileStatus::Added, None),
            Some(b'D') => (FileStatus::Deleted, None),
            _ => (FileStatus::Modified, None),
        };
        let path = path.unwrap_or_else(|| self.name.clone());
        if let Some(old) = &old_path {
            // Older commits know the file under the old name.
            self.name = old.clone();
        }
        let counts = commit.files.iter().find(|stat| stat.added.is_some() || stat.deleted.is_some());
        let count = |n: Option<u64>| n.and_then(|n| u32::try_from(n).ok());
        self.entries.push(FileHistoryEntry {
            commit: gitlog::summary(&commit.header),
            path,
            old_path,
            status,
            added: count(counts.and_then(|stat| stat.added)),
            removed: count(counts.and_then(|stat| stat.deleted)),
        });
    }

    pub(super) fn finish(mut self) -> Vec<FileHistoryEntry> {
        if let Some(commit) = std::mem::replace(&mut self.log, gitlog::LogParser::new(0)).finish() {
            self.add(commit);
        }
        self.entries
    }
}
