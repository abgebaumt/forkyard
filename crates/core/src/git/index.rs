//! Git's index and trees: temporary index files (`GIT_INDEX_FILE`) and the empty tree.

use std::path::{Path, PathBuf};

use crate::app::Core;
use crate::error::CoreResult;
use crate::util;

const STALE_TEMP_AGE: std::time::Duration = std::time::Duration::from_secs(3600);

/// The empty tree. Git always knows it, even when no object for it is stored; as the
/// `from` of a range it stands for "from the empty state on" (e.g. a series starting at the root commit).
pub(crate) const EMPTY_TREE_SHA1: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
pub(crate) const EMPTY_TREE_SHA256: &str = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";

/// Whether `rev` is the (fully spelled out) SHA of the empty tree.
pub(crate) fn is_empty_tree(rev: &str) -> bool {
    let rev = rev.trim();
    rev.eq_ignore_ascii_case(EMPTY_TREE_SHA1) || rev.eq_ignore_ascii_case(EMPTY_TREE_SHA256)
}

/// The empty tree in the object format of `sha` (SHA-1 or SHA-256).
pub(crate) fn empty_tree(sha: &str) -> &'static str {
    if sha.len() > 40 {
        EMPTY_TREE_SHA256
    } else {
        EMPTY_TREE_SHA1
    }
}

/// Separate index file (for `GIT_INDEX_FILE`) that is removed again when the value is
/// dropped. The real index stays untouched. The file lives in the app's data directory,
/// not in the repository: that way a mere read command does not trigger the file
/// watcher.
pub(crate) struct TempIndex {
    path: PathBuf,
}

impl TempIndex {
    pub(crate) fn create(core: &Core) -> CoreResult<TempIndex> {
        let dir = core.data_dir().join("tmp");
        std::fs::create_dir_all(&dir)?;
        remove_stale_temp_files(&dir);
        Ok(TempIndex { path: dir.join(format!("index-{}", util::new_id())) })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let mut lock = self.path.clone().into_os_string();
        lock.push(".lock");
        let _ = std::fs::remove_file(lock);
    }
}

/// Removes index files left behind by a crash (older than one hour).
fn remove_stale_temp_files(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let old =
            entry.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).is_some_and(|age| age > STALE_TEMP_AGE);
        if old && entry.file_name().to_string_lossy().starts_with("index-") {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StageEntry {
    pub(crate) mode: String,
    pub(crate) sha: String,
}

/// A conflicted file: path in raw bytes and stages 1 (base), 2 (ours), 3 (theirs).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct Unmerged {
    pub(crate) path: Vec<u8>,
    pub(crate) stages: [Option<StageEntry>; 3],
}

/// Parses `git ls-files --unmerged -z`: one record per stage, "mode SHA stage TAB path".
pub(crate) fn parse_unmerged(stdout: &[u8]) -> Vec<Unmerged> {
    let mut out: Vec<Unmerged> = Vec::new();
    for record in util::split_z(stdout) {
        let Some(tab) = record.iter().position(|&b| b == b'\t') else { continue };
        let (meta, path) = (util::decode_lossy(&record[..tab]), &record[tab + 1..]);
        let mut parts = meta.split(' ');
        let (Some(mode), Some(sha), Some(stage)) = (parts.next(), parts.next(), parts.next()) else { continue };
        let Some(index) = stage.parse::<usize>().ok().filter(|s| (1..=3).contains(s)) else { continue };
        if out.last().map(|u| u.path.as_slice()) != Some(path) {
            out.push(Unmerged { path: path.to_vec(), stages: Default::default() });
        }
        if let Some(last) = out.last_mut() {
            last.stages[index - 1] = Some(StageEntry { mode: mode.to_string(), sha: sha.to_string() });
        }
    }
    out
}

/// The open conflicts of the index, one entry per path.
pub(crate) async fn ls_unmerged(core: &Core, repo_id: &str) -> CoreResult<Vec<Unmerged>> {
    let out = core.git_for(repo_id)?.read().args(["ls-files", "--unmerged", "-z"]).run().await?;
    Ok(parse_unmerged(&out.stdout))
}
