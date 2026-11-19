//! Conflicts: the three versions of a file, resolving it, the index stages and the text form.

use super::*;

// ---------------------------------------------------------------------------
// conflict_get
// ---------------------------------------------------------------------------

/// The three versions of a conflicted file from index stages 1 (base), 2 (ours) and
/// 3 (theirs), plus the content in the working directory with markers. Read-only command.
pub async fn conflict_get(core: &Core, repo_id: String, path: String) -> CoreResult<ConflictFile> {
    let repo_id = repo_id.as_str();
    let entry = unmerged_entry(core, repo_id, &path).await?;
    let root = core.repo_path(repo_id)?;
    let versions = Versions::read(core, repo_id, &root, &entry).await?;
    let head = read_head(core, repo_id).await?;
    let operation = read_operation(core, repo_id).await?;
    let (ours_label, theirs_label) = side_labels(operation.as_ref(), &head);

    let is_binary = versions.is_binary(&entry);
    let text = |bytes: &Option<Vec<u8>>| bytes.as_deref().filter(|_| !is_binary).map(|b| util::decode_text(b).0);
    Ok(ConflictFile {
        path,
        kind: kind_of(&entry),
        base: text(&versions.base),
        ours: text(&versions.ours),
        theirs: text(&versions.theirs),
        merged: text(&versions.worktree),
        is_binary,
        ours_label,
        theirs_label,
        // A binary file has no encoding.
        encoding: (!is_binary).then(|| versions.format().encoding.to_string()),
    })
}

/// Names of the two sides, matching index stages 2 and 3 (see the top of the file).
pub(super) fn side_labels(operation: Option<&Operation>, head: &Head) -> (String, String) {
    let current = head.label();
    let Some(op) = operation else {
        // Conflict without a running operation: squash merge or applied stash.
        return (current, "Incoming change".to_string());
    };
    let ours = op.target.clone().unwrap_or(current);
    let source = op.source.clone();
    let theirs = match op.kind {
        OperationKind::Merge | OperationKind::Rebase => source.unwrap_or_else(|| "Incoming change".to_string()),
        OperationKind::CherryPick => source.map_or_else(|| "Cherry-pick".to_string(), |s| format!("Cherry-pick {s}")),
        // In a revert, stage 3 is the state before the reverted commit.
        OperationKind::Revert => source.map_or_else(|| "Revert".to_string(), |s| format!("State before {s}")),
    };
    (ours, theirs)
}

// ---------------------------------------------------------------------------
// conflict_resolve
// ---------------------------------------------------------------------------

/// Resolves the conflict of one file: either with `content` (written in the file's encoding
/// and line endings, then staged) or with a whole side. If the chosen side does not exist
/// (e.g. `ours` for "deleted by us"), that means: delete the file.
pub async fn conflict_resolve(
    core: &Core,
    repo_id: String,
    path: String,
    content: Option<String>,
    side: Option<ConflictSide>,
) -> CoreResult<Status> {
    if content.is_some() == side.is_some() {
        return Err(CoreError::not_allowed(
            "To resolve a conflict, provide either content or a side (ours/theirs) – exactly one of the two.",
        ));
    }
    let repo_id = repo_id.as_str();
    core.with_write_lock(repo_id, &[RepoChange::Worktree, RepoChange::Index], async {
        let entry = unmerged_entry(core, repo_id, &path).await?;
        let root = core.repo_path(repo_id)?;
        // Check first, then write: with a foreign lock file, a modified but unstaged file would otherwise be left behind.
        ensure_index_unlocked(core, repo_id).await?;
        match (&content, side) {
            (Some(content), _) => resolve_with_content(core, repo_id, &root, &path, &entry, content).await?,
            (None, Some(side)) => resolve_with_side(core, repo_id, &entry, side).await?,
            (None, None) => {}
        }
        // Only the backup of a merge tool the app started for this file: an `.orig` file the
        // user placed next to it themselves stays.
        let rel = crate::util::normalize_rel_path(&path).unwrap_or_else(|_| path.clone());
        let tool_ran = core.state::<crate::commands::external::MergeToolRuns>().take(repo_id, &rel);
        if tool_ran && core.settings()?.delete_orig_files {
            remove_orig_file(core, repo_id, &root, &entry.path).await;
        }
        read_status(core, repo_id).await
    })
    .await
}

pub(super) async fn resolve_with_content(
    core: &Core,
    repo_id: &str,
    root: &Path,
    path: &str,
    entry: &Unmerged,
    content: &str,
) -> CoreResult<()> {
    if entry.stages.iter().flatten().any(|s| special_mode(&s.mode)) {
        return Err(CoreError::not_allowed(format!(
            "“{path}” is a symlink or submodule and can’t be resolved as text. Take one of the two sides instead."
        )));
    }
    let versions = Versions::read(core, repo_id, root, entry).await?;
    if versions.is_binary(entry) {
        return Err(CoreError::not_allowed(format!(
            "“{path}” is a binary file and can’t be resolved as text. Take one of the two sides instead."
        )));
    }
    // Lines that already look like a marker in one of the versions (e.g. a heading with
    // "=======") belong to the content and do not count.
    let mut known = HashSet::new();
    for bytes in [&versions.ours, &versions.theirs].into_iter().flatten() {
        let (text, _) = util::decode_text(bytes);
        known.extend(text.lines().filter(|l| is_marker_line(l)).map(|l| l.trim_end_matches('\r').to_string()));
    }
    if let Some(line) = leftover_marker(content, &known) {
        return Err(CoreError::not_allowed(format!(
            "The content still contains conflict markers (line {line}). Resolve all conflicts in the file first."
        )));
    }
    let bytes = encode_content(content, &versions.format())?;
    let full = util::join_from_git(root, &entry.path);
    // Via a temp file and with patience: a Git reading at the same time (status refresh)
    // briefly holds the file on Windows (os error 1224, 32, 5).
    tokio::task::spawn_blocking(move || util::write_file_atomic(&full, &bytes))
        .await
        .map_err(|e| CoreError::io(format!("Saving was aborted: {e}")))?
        .map_err(|e| {
            let e = CoreError::from(e);
            CoreError::new(e.code, format!("Couldn’t write “{path}”. {}", e.message))
        })?;
    path_cmd(core, repo_id)?.args(["add", "--"]).arg_bytes(&entry.path).run().await?;
    Ok(())
}

pub(super) async fn resolve_with_side(core: &Core, repo_id: &str, entry: &Unmerged, side: ConflictSide) -> CoreResult<()> {
    let (stage, flag) = match side {
        ConflictSide::Ours => (&entry.stages[1], "--ours"),
        ConflictSide::Theirs => (&entry.stages[2], "--theirs"),
    };
    if stage.is_some() {
        path_cmd(core, repo_id)?.args(["checkout", flag, "--"]).arg_bytes(&entry.path).run().await?;
        path_cmd(core, repo_id)?.args(["add", "--"]).arg_bytes(&entry.path).run().await?;
    } else {
        // The chosen side does not have the file: taking it means deleting.
        path_cmd(core, repo_id)?.args(["rm", "-f", "-q", "--"]).arg_bytes(&entry.path).run().await?;
    }
    Ok(())
}

/// Removes `<path>.orig` (created by `git mergetool`), as long as the file is not tracked.
/// Only call this if the app started the merge tool for this file.
pub(super) async fn remove_orig_file(core: &Core, repo_id: &str, root: &Path, rel: &[u8]) {
    let mut orig = rel.to_vec();
    orig.extend_from_slice(b".orig");
    let full = util::join_from_git(root, &orig);
    if !std::fs::symlink_metadata(&full).is_ok_and(|m| m.is_file()) {
        return;
    }
    let listed = match core.git_for(repo_id).map(GitCmd::read) {
        Ok(cmd) => cmd.literal_paths().args(["ls-files", "-z", "--"]).arg_bytes(&orig).run_raw().await,
        Err(e) => Err(e),
    };
    if matches!(&listed, Ok(out) if out.success() && out.stdout.is_empty()) {
        if let Err(e) = std::fs::remove_file(&full) {
            log::warn!("{} not removed: {e}", util::display_path(&full));
        }
    }
}

// ---------------------------------------------------------------------------
// Index stages of a conflicted file
// ---------------------------------------------------------------------------

/// The conflict entry of exactly this path, or `not_found`.
pub(super) async fn unmerged_entry(core: &Core, repo_id: &str, path: &str) -> CoreResult<Unmerged> {
    let missing = || CoreError::not_found(format!("“{path}” has no open conflict."));
    if path.is_empty() {
        return Err(missing());
    }
    if path.contains(char::REPLACEMENT_CHARACTER) {
        // Possibly a name that is not UTF-8: find its raw bytes among all conflicts.
        let all = ls_unmerged(core, repo_id).await?;
        let raw = util::raw_path(path, &all.iter().map(|u| &u.path[..]).collect::<Vec<_>>())?;
        return all.into_iter().find(|u| u.path == raw).ok_or_else(missing);
    }
    let out = core
        .git_for(repo_id)?
        .read()
        .literal_paths()
        .args(["ls-files", "--unmerged", "-z", "--"])
        .arg_bytes(path.as_bytes())
        .run_raw()
        .await?;
    if !out.success() {
        return Err(missing());
    }
    parse_unmerged(&out.stdout).into_iter().find(|u| u.path == path.as_bytes()).ok_or_else(missing)
}

pub(super) fn display_paths(unmerged: &[Unmerged]) -> Vec<String> {
    unmerged.iter().map(|u| util::decode_lossy(&u.path)).collect()
}

/// Kind of conflict from the stages present (same mapping as in the status).
pub(super) fn kind_of(entry: &Unmerged) -> ConflictKind {
    let has = |i: usize| entry.stages[i].is_some();
    let (x, y) = match (has(0), has(1), has(2)) {
        (true, false, false) => (b'D', b'D'),
        (false, true, false) => (b'A', b'U'),
        (true, true, false) => (b'U', b'D'),
        (false, false, true) => (b'U', b'A'),
        (true, false, true) => (b'D', b'U'),
        (false, true, true) => (b'A', b'A'),
        _ => (b'U', b'U'),
    };
    status::conflict_kind(x, y)
}

/// Symlink (120000) or submodule (160000): not text.
pub(super) fn special_mode(mode: &str) -> bool {
    mode == "120000" || mode == "160000"
}

/// Contents of the three stages and of the file in the working directory, as raw bytes.
pub(super) struct Versions {
    pub(super) base: Option<Vec<u8>>,
    pub(super) ours: Option<Vec<u8>>,
    pub(super) theirs: Option<Vec<u8>>,
    pub(super) worktree: Option<Vec<u8>>,
}

impl Versions {
    pub(super) async fn read(core: &Core, repo_id: &str, root: &Path, entry: &Unmerged) -> CoreResult<Versions> {
        let (base, ours, theirs) = tokio::join!(
            stage_blob(core, repo_id, entry.stages[0].as_ref()),
            stage_blob(core, repo_id, entry.stages[1].as_ref()),
            stage_blob(core, repo_id, entry.stages[2].as_ref()),
        );
        let full = util::join_from_git(root, &entry.path);
        let worktree = match std::fs::symlink_metadata(&full) {
            Ok(meta) if meta.is_file() => std::fs::read(&full).ok(),
            _ => None,
        };
        Ok(Versions { base: base?, ours: ours?, theirs: theirs?, worktree })
    }

    pub(super) fn all(&self) -> impl Iterator<Item = &[u8]> {
        [&self.base, &self.ours, &self.theirs, &self.worktree].into_iter().filter_map(|v| v.as_deref())
    }

    /// The file is binary if one version is. UTF-16 counts as binary, as in Git.
    pub(super) fn is_binary(&self, entry: &Unmerged) -> bool {
        entry.stages.iter().flatten().any(|s| special_mode(&s.mode))
            || self.all().any(|b| util::looks_binary(b) || b.starts_with(b"\xFF\xFE") || b.starts_with(b"\xFE\xFF"))
    }

    /// Encoding and line endings in which the file is written.
    pub(super) fn format(&self) -> TextFormat {
        let primary = self.ours.as_deref().or(self.theirs.as_deref());
        // The first version with non-ASCII characters decides; pure ASCII fits any encoding.
        let encoding = [&self.ours, &self.theirs, &self.base]
            .into_iter()
            .filter_map(|v| v.as_deref())
            .find(|b| !b.is_ascii())
            .map_or("utf-8", |b| util::decode_text(b).1);
        // If "ours" has CRLF, CRLF is written. With `core.autocrlf` the index has LF and only the
        // working directory has CRLF; then the file there decides.
        let crlf = primary.is_some_and(|b| {
            let (crlf, lf) = eol_counts(b);
            crlf > 0 && crlf >= lf
        }) || self.worktree.as_deref().is_some_and(|b| {
            let (crlf, lf) = eol_counts(b);
            crlf > 0 && lf == 0
        });
        TextFormat { encoding, bom: primary.is_some_and(|b| b.starts_with(UTF8_BOM)), crlf }
    }
}

pub(super) async fn stage_blob(core: &Core, repo_id: &str, stage: Option<&StageEntry>) -> CoreResult<Option<Vec<u8>>> {
    let Some(stage) = stage.filter(|s| !special_mode(&s.mode)) else { return Ok(None) };
    let out = core.git_for(repo_id)?.read().args(["cat-file", "blob", &stage.sha]).run().await?;
    Ok(Some(out.stdout))
}

// ---------------------------------------------------------------------------
// Text: encoding, line endings, conflict markers
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct TextFormat {
    /// "utf-8" or "windows-1252" (as in `util::decode_text`).
    pub(super) encoding: &'static str,
    pub(super) bom: bool,
    pub(super) crlf: bool,
}

/// Number of line endings: (CRLF, lone LF).
pub(super) fn eol_counts(bytes: &[u8]) -> (usize, usize) {
    let (mut crlf, mut lf, mut previous) = (0, 0, 0u8);
    for &b in bytes {
        if b == b'\n' {
            if previous == b'\r' {
                crlf += 1;
            } else {
                lf += 1;
            }
        }
        previous = b;
    }
    (crlf, lf)
}

/// Brings the UI's text into the file's form. A missing newline at the end stays
/// missing.
pub(super) fn encode_content(content: &str, format: &TextFormat) -> CoreResult<Vec<u8>> {
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);
    let mut text = content.replace("\r\n", "\n");
    if format.crlf {
        text = text.replace('\n', "\r\n");
    }
    let mut out = Vec::with_capacity(text.len() + 3);
    if format.bom {
        out.extend_from_slice(UTF8_BOM);
    }
    if format.encoding == "windows-1252" {
        let (bytes, _, unmappable) = encoding_rs::WINDOWS_1252.encode(&text);
        if unmappable {
            return Err(CoreError::not_allowed(
                "The content contains characters that can’t be saved in the file’s encoding (windows-1252).",
            ));
        }
        out.extend_from_slice(&bytes);
    } else {
        out.extend_from_slice(text.as_bytes());
    }
    Ok(out)
}

/// Line that looks like a conflict marker: seven identical characters from `<`, `=`, `>`,
/// `|` at the start of the line, followed by end of line or whitespace.
pub(crate) fn is_marker_line(line: &str) -> bool {
    let line = line.trim_end_matches('\r');
    let bytes = line.as_bytes();
    bytes.len() >= 7
        && matches!(bytes[0], b'<' | b'=' | b'>' | b'|')
        && bytes[..7].iter().all(|&b| b == bytes[0])
        && matches!(bytes.get(7), None | Some(b' ') | Some(b'\t'))
}

/// First line (counted from 1) with a leftover marker. Lines from `known` were already in
/// one of the versions and are content.
pub(super) fn leftover_marker(content: &str, known: &HashSet<String>) -> Option<usize> {
    content.lines().position(|line| is_marker_line(line) && !known.contains(line.trim_end_matches('\r'))).map(|i| i + 1)
}
