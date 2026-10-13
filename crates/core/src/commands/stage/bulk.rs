//! Add many new files to the index (or to a temporary index) quickly.
//!
//! `git add` stores every new file as its own "loose" object under `.git/objects/xx/`.
//! On Windows that costs a few milliseconds per file (create the file,
//! rename, virus scanner): 2000 new files took 12 to 22 s that way. Git can instead write new
//! contents into ONE pack ("bulk checkin"), but only for files
//! above `core.bigFileThreshold` that are not converted while being read in.
//!
//! `prestage` therefore adds up front the files for which a conversion cannot change
//! anything – no `\r` in the content (then every CRLF conversion has no effect) and
//! no `filter`, `ident` or `working-tree-encoding` attribute –, with
//! `core.bigFileThreshold=1` and without CRLF conversion. The result is byte-identical to
//! that of an ordinary `git add`. Afterwards the ordinary call runs as before; it
//! finds the pre-added files unchanged and only adds the rest.
//!
//! If the pre-step fails (except on a foreign lock), that is not an error:
//! the ordinary call then does everything, only slower.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::app::Core;
use crate::error::{CoreResult, ErrorCode};
use crate::git::GitCmd;
use crate::util;

/// The detour only pays off from this many files on (each call creates a pack; many small
/// packs would slow Git down in the long run).
pub const BULK_MIN_FILES: usize = 64;
/// The core does not read larger files itself; the ordinary call adds them.
const MAX_SCANNED_BYTES: u64 = 16 * 1024 * 1024;
/// From this Git version on there is `--attr-source`: with it, `text`/`eol` attributes from
/// .gitattributes don't apply during the pre-step either (for content without `\r` they have
/// no effect anyway, but they would keep Git from using the pack).
const ATTR_SOURCE_VERSION: (u32, u32, u32) = (2, 42, 0);

/// Pre-step for `git add -A [<paths>]`. `index_file`: temporary index instead of the real one.
/// Only passes on `locked` as an error; everything else is left to the ordinary call.
pub async fn prestage(core: &Core, repo_id: &str, index_file: Option<&Path>, paths: Option<&[Vec<u8>]>) -> CoreResult<()> {
    match run(core, repo_id, index_file, paths).await {
        Ok(()) => Ok(()),
        Err(e) if e.is(ErrorCode::Locked) => Err(e),
        Err(e) => {
            log::info!("Fast staging skipped: {}", e.message);
            Ok(())
        }
    }
}

fn base(core: &Core, repo_id: &str, index_file: Option<&Path>) -> CoreResult<GitCmd> {
    let mut cmd = core.git_for(repo_id)?.no_log().env("GIT_LITERAL_PATHSPECS", "1");
    if let Some(index) = index_file {
        cmd = cmd.env("GIT_INDEX_FILE", index);
    }
    Ok(cmd)
}

async fn run(core: &Core, repo_id: &str, index_file: Option<&Path>, paths: Option<&[Vec<u8>]>) -> CoreResult<()> {
    if let Some(list) = paths {
        if list.len() < BULK_MIN_FILES {
            return Ok(());
        }
    }
    // New and modified files (without ignored ones), one entry per file.
    let listed = base(core, repo_id, index_file)?
        .read_only()
        .args(["ls-files", "-z", "--others", "--modified", "--exclude-standard"])
        .run()
        .await?;
    let wanted: Option<Wanted> = paths.map(Wanted::new);
    let mut candidates: Vec<Vec<u8>> = Vec::new();
    let mut seen: HashSet<&[u8]> = HashSet::new();
    for path in util::split_z(&listed.stdout) {
        if path.is_empty() || !seen.insert(path) {
            continue;
        }
        if wanted.as_ref().map_or(true, |w| w.covers(path)) {
            candidates.push(path.to_vec());
        }
    }
    if candidates.len() < BULK_MIN_FILES {
        return Ok(());
    }

    let root = core.repo_path(repo_id)?;
    let candidates = tokio::task::spawn_blocking(move || without_carriage_returns(&root, candidates))
        .await
        .unwrap_or_default();
    if candidates.len() < BULK_MIN_FILES {
        return Ok(());
    }
    let candidates = without_conversion_attributes(core, repo_id, index_file, candidates).await?;
    if candidates.len() < BULK_MIN_FILES {
        return Ok(());
    }

    let mut cmd = base(core, repo_id, index_file)?;
    if let Some(empty_tree) = attr_source(core, repo_id).await {
        cmd = cmd.arg(format!("--attr-source={empty_tree}"));
    }
    cmd.args(["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "-c", "core.bigFileThreshold=1"])
        .args(["add", "--pathspec-from-file=-", "--pathspec-file-nul"])
        .stdin(nul_separated(&candidates))
        .run()
        .await?;
    Ok(())
}

/// Empty tree as the source of attributes, if Git knows `--attr-source`.
async fn attr_source(core: &Core, repo_id: &str) -> Option<String> {
    let info = core.git.info().ok()?;
    if info.version < ATTR_SOURCE_VERSION {
        return None;
    }
    let out = core.git_for(repo_id).ok()?.no_log().read_only().args(["hash-object", "-t", "tree", "--stdin"]).stdin(Vec::new()).run().await.ok()?;
    Some(out.stdout_text()).filter(|sha| !sha.is_empty())
}

/// Only regular files up to `MAX_SCANNED_BYTES` without `\r` in the content.
fn without_carriage_returns(root: &Path, candidates: Vec<Vec<u8>>) -> Vec<Vec<u8>> {
    candidates
        .into_iter()
        .filter(|rel| {
            let full: PathBuf = util::join_from_git(root, rel);
            match std::fs::symlink_metadata(&full) {
                Ok(meta) if meta.is_file() && meta.len() <= MAX_SCANNED_BYTES => {}
                _ => return false,
            }
            match std::fs::read(&full) {
                Ok(content) => !content.contains(&b'\r'),
                Err(_) => false,
            }
        })
        .collect()
}

/// Removes paths to which a filter (e.g. LFS), `ident` or `working-tree-encoding` applies.
async fn without_conversion_attributes(core: &Core, repo_id: &str, index_file: Option<&Path>, candidates: Vec<Vec<u8>>) -> CoreResult<Vec<Vec<u8>>> {
    let out = base(core, repo_id, index_file)?
        .read_only()
        .args(["check-attr", "-z", "--stdin", "filter", "ident", "working-tree-encoding"])
        .stdin(nul_separated(&candidates))
        .run()
        .await?;
    // Output: path NUL attribute NUL value NUL.
    let fields: Vec<&[u8]> = util::split_z(&out.stdout).collect();
    let mut converted: HashSet<&[u8]> = HashSet::new();
    for triple in fields.chunks(3) {
        if let [path, _, value] = triple {
            if *value != b"unspecified" && *value != b"unset" {
                converted.insert(path);
            }
        }
    }
    Ok(candidates.into_iter().filter(|p| !converted.contains(p.as_slice())).collect())
}

fn nul_separated(paths: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::new();
    for path in paths {
        out.extend_from_slice(path);
        out.push(0);
    }
    out
}

/// The requested paths: files or directories (then everything below them).
struct Wanted {
    exact: HashSet<Vec<u8>>,
    folders: Vec<Vec<u8>>,
}

impl Wanted {
    fn new(paths: &[Vec<u8>]) -> Wanted {
        let mut exact = HashSet::new();
        let mut folders = Vec::new();
        for path in paths {
            let trimmed = path.strip_suffix(b"/").unwrap_or(path);
            exact.insert(trimmed.to_vec());
            let mut folder = trimmed.to_vec();
            folder.push(b'/');
            folders.push(folder);
        }
        Wanted { exact, folders }
    }

    fn covers(&self, path: &[u8]) -> bool {
        self.exact.contains(path) || self.folders.iter().any(|f| path.starts_with(f))
    }
}
