//! `commit_details`: metadata and file list of a commit, a range, a stash
//! or the working directory.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Duration;

use super::{commit_not_found, display_text, is_full_sha, other_failure, parse_i64, read_cmd, read_ref_tips, read_stashes, resolve_commit_at, split_shas, LOG_SAFE};
use crate::app::Core;
use crate::commands::diff::is_empty_tree;
use crate::commands::status::{self, LineCounts};
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::GitOutput;
use crate::model::{CommitDetails, CommitInfo, DiffSource, FileArea, FileChange, FileStatus, Person, SignatureStatus};
use crate::util;

/// With `--date=raw`, `%ad` and `%cd` are "<Unix seconds> <±HHMM>".
const META_FORMAT: &str = "--format=%H%x00%P%x00%an%x00%ae%x00%ad%x00%cn%x00%ce%x00%cd%x00%G?%x00%s%x00%b";
const META_FIELDS: usize = 11;
/// Git may take this long for one commit including signature verification.
const SIGNATURE_TIMEOUT: Duration = Duration::from_secs(5);
/// `git diff` against the working directory must not write the index back (see status.rs).
const NO_INDEX_REFRESH: [&str; 2] = ["-c", "diff.autoRefreshIndex=false"];

pub(super) async fn commit_details(core: &Core, repo_id: &str, source: DiffSource) -> CoreResult<CommitDetails> {
    let path = core.repo_path(repo_id)?;
    match source {
        DiffSource::Unstaged => worktree(core, repo_id, FileArea::Unstaged).await,
        DiffSource::Staged => worktree(core, repo_id, FileArea::Staged).await,
        DiffSource::Commit { sha } => commit(core, &path, repo_id, &sha).await,
        DiffSource::Range { from, to } => range(core, &path, repo_id, &from, to.as_deref()).await,
        DiffSource::Stash { index } => stash(core, &path, repo_id, index).await,
    }
}

fn details(commit: Option<CommitInfo>, files: Vec<FileChange>) -> CommitDetails {
    let added = files.iter().filter_map(|f| f.added).fold(0u32, u32::saturating_add);
    let removed = files.iter().filter_map(|f| f.removed).fold(0u32, u32::saturating_add);
    CommitDetails { commit, files, added, removed, not_combinable_reason: None }
}

// ---------------------------------------------------------------------------
// Working directory
// ---------------------------------------------------------------------------

/// The files from the status. `unstaged` also contains the conflicted files (at the front).
async fn worktree(core: &Core, repo_id: &str, area: FileArea) -> CoreResult<CommitDetails> {
    let status = status::read_status(core, repo_id).await?;
    let files = match area {
        FileArea::Staged => status.staged,
        _ => {
            let mut files = status.conflicted;
            files.extend(status.unstaged);
            files
        }
    };
    Ok(details(None, files))
}

// ---------------------------------------------------------------------------
// One commit
// ---------------------------------------------------------------------------

async fn commit(core: &Core, path: &Path, repo_id: &str, sha: &str) -> CoreResult<CommitDetails> {
    // A full SHA needs no Git call of its own; if it does not exist, `read_meta` reports that.
    let sha = if is_full_sha(sha.trim()) { sha.trim().to_ascii_lowercase() } else { resolve_commit_at(core, path, repo_id, sha).await? };
    let (meta, files, labels, head, pushed) = tokio::join!(
        read_meta(core, path, repo_id, &sha),
        // Against the first parent; a root commit against the empty tree.
        diff_files(core, path, repo_id, &["diff-tree", "-r", "--root", "--no-commit-id", "--diff-merges=first-parent"], vec![sha.clone()]),
        read_ref_tips(core, path, repo_id, Some(&sha)),
        read_cmd(core, path, repo_id).args(["rev-parse", "-q", "--verify", "HEAD^{commit}"]).run_raw(),
        is_pushed(core, path, repo_id, &sha),
    );
    let mut info = meta?;
    let mut files = files?;
    info.refs = labels?.into_iter().map(|r| r.label).collect();
    // The checked-out branch comes first.
    info.refs.sort_by_key(|l| !l.is_head);
    info.is_head = head.is_ok_and(|out| out.success() && out.stdout_text() == sha);
    info.is_pushed = pushed;
    mark_lfs(core, path, repo_id, &mut files).await;
    Ok(details(Some(info), files.into_iter().map(|f| f.change).collect()))
}

/// Metadata of a commit. `not_found` if it does not exist.
async fn read_meta(core: &Core, path: &Path, repo_id: &str, sha: &str) -> CoreResult<CommitInfo> {
    match read_meta_with(core, path, repo_id, sha, true).await {
        // Signature verification hangs (GnuPG agent, key server): the details come anyway.
        Err(e) if e.is(ErrorCode::Timeout) => read_meta_with(core, path, repo_id, sha, false).await,
        other => other,
    }
}

/// `verify: false` leaves the signature unchecked (`unknown`); Git then does not start GnuPG.
pub(super) async fn read_meta_with(core: &Core, path: &Path, repo_id: &str, sha: &str, verify: bool) -> CoreResult<CommitInfo> {
    let format = META_FORMAT.replace("%G?", if verify { "%G?" } else { "?" });
    let mut cmd = read_cmd(core, path, repo_id).args(["log", "-1", "--no-walk"]).args(LOG_SAFE).args(["--date=raw", "-z", format.as_str(), sha, "--"]);
    if verify {
        cmd = cmd.timeout(SIGNATURE_TIMEOUT);
    }
    let out = cmd.run_raw().await?;
    let fields: Vec<&[u8]> = out.stdout.split(|&b| b == 0).collect();
    if !out.success() || fields.len() < META_FIELDS {
        let short: String = sha.chars().take(10).collect();
        return Err(other_failure(&out, "log").unwrap_or_else(|| commit_not_found(&short).with_git_output(out.stderr_text())));
    }
    let text = |i: usize| display_text(fields[i]);
    let (authored, offset) = parse_raw_date(&text(4));
    let (committed, _) = parse_raw_date(&text(7));
    let description = text(10).trim_end().to_string();
    Ok(CommitInfo {
        sha: text(0),
        parents: split_shas(fields[1]),
        author: Person { name: text(2), email: text(3) },
        committer: Person { name: text(5), email: text(6) },
        authored_at: util::unix_to_iso(authored),
        committed_at: util::unix_to_iso(committed),
        author_offset_minutes: offset,
        summary: text(9),
        co_authors: parse_co_authors(&description),
        description,
        signature: signature_status(fields[8]),
        refs: Vec::new(),
        is_head: false,
        is_pushed: false,
    })
}

/// "1767225600 +0130" → (seconds, minutes east of UTC).
fn parse_raw_date(raw: &str) -> (i64, i32) {
    let mut parts = raw.split_whitespace();
    let secs = parts.next().map_or(0, |s| parse_i64(s.as_bytes()));
    let offset = parts.next().map_or(0, |zone| {
        let (sign, digits) = match zone.strip_prefix('-') {
            Some(rest) => (-1, rest),
            None => (1, zone.strip_prefix('+').unwrap_or(zone)),
        };
        match digits.parse::<i32>() {
            Ok(hhmm) if digits.len() == 4 => sign * ((hhmm / 100) * 60 + hhmm % 100),
            _ => 0,
        }
    });
    (secs, offset)
}

/// Git's `%G?`: G good, B bad, N none; everything else is "not verifiable"
/// (key missing, expired, unknown validity).
fn signature_status(code: &[u8]) -> SignatureStatus {
    match code {
        b"G" => SignatureStatus::Good,
        b"B" | b"R" => SignatureStatus::Bad,
        b"N" | b"" => SignatureStatus::None,
        _ => SignatureStatus::Unknown,
    }
}

/// Reads `Co-authored-by: Name <mail>` lines from the text of a commit message
/// (case-insensitive, without duplicates).
pub fn parse_co_authors(description: &str) -> Vec<Person> {
    const KEY: &str = "co-authored-by:";
    let mut out: Vec<Person> = Vec::new();
    for line in description.lines() {
        let line = line.trim();
        let Some(head) = line.get(..KEY.len()) else { continue };
        if !head.eq_ignore_ascii_case(KEY) {
            continue;
        }
        let value = line[KEY.len()..].trim();
        let person = match (value.find('<'), value.rfind('>')) {
            (Some(open), Some(close)) if open < close => {
                Person { name: value[..open].trim().to_string(), email: value[open + 1..close].trim().to_string() }
            }
            _ => Person { name: value.to_string(), email: String::new() },
        };
        if (person.name.is_empty() && person.email.is_empty()) || out.contains(&person) {
            continue;
        }
        out.push(person);
    }
    out
}

/// Whether the commit is contained in at least one remote branch. One run instead of a
/// check per remote branch: `rev-list` returns the commit only if no remote ref contains it.
async fn is_pushed(core: &Core, path: &Path, repo_id: &str, sha: &str) -> bool {
    let out = read_cmd(core, path, repo_id).args(["rev-list", "--max-count=1", sha, "--not", "--remotes"]).run_raw().await;
    matches!(out, Ok(out) if out.success() && out.stdout_text().is_empty())
}

// ---------------------------------------------------------------------------
// File lists
// ---------------------------------------------------------------------------

/// One file of the list, with what further Git calls need.
struct ChangedFile {
    raw_path: Vec<u8>,
    /// Git's status letter (M, A, D, R …); `?` for untracked files.
    code: u8,
    /// The mode is the same on both sides (no chmod, no type change).
    same_mode: bool,
    /// Blob of the old side.
    old_sha: String,
    change: FileChange,
}

impl ChangedFile {
    fn untracked(raw: &[u8]) -> Self {
        ChangedFile {
            raw_path: raw.to_vec(),
            code: b'?',
            same_mode: false,
            old_sha: String::new(),
            change: FileChange {
                path: util::decode_lossy(raw),
                old_path: None,
                status: FileStatus::Untracked,
                area: FileArea::Unstaged,
                is_binary: false,
                is_lfs: false,
                added: None,
                removed: None,
                conflict: None,
            },
        }
    }
}

struct RawChange {
    code: u8,
    same_mode: bool,
    old_sha: String,
    path: Vec<u8>,
    old_path: Option<Vec<u8>>,
}

/// Parses `--raw -z --no-abbrev`: `:<mode> <mode> <SHA> <SHA> <status>[number] NUL path NUL`;
/// for renames the old and new path follow.
fn parse_raw_z(stdout: &[u8]) -> Vec<RawChange> {
    let mut out = Vec::new();
    let mut fields = util::split_z(stdout);
    while let Some(meta) = fields.next() {
        let Some(meta) = meta.strip_prefix(b":") else { continue };
        let parts: Vec<&[u8]> = meta.split(|&b| b == b' ').collect();
        let Some(&code) = parts.get(4).and_then(|status| status.first()) else { continue };
        let (path, old_path) = if code == b'R' || code == b'C' {
            let (Some(old), Some(new)) = (fields.next(), fields.next()) else { break };
            (new, Some(old))
        } else {
            let Some(path) = fields.next() else { break };
            (path, None)
        };
        out.push(RawChange {
            code,
            same_mode: parts[0] == parts[1],
            old_sha: util::decode_lossy(parts[2]),
            path: path.to_vec(),
            old_path: old_path.map(<[u8]>::to_vec),
        });
    }
    out
}

fn to_changes(raw: Vec<RawChange>, counts: &HashMap<Vec<u8>, LineCounts>) -> Vec<ChangedFile> {
    raw.into_iter()
        .map(|n| {
            let status = match n.code {
                b'A' | b'C' => FileStatus::Added,
                b'D' => FileStatus::Deleted,
                b'R' => FileStatus::Renamed,
                b'U' => FileStatus::Conflicted,
                // M, T (type change) and everything unknown.
                _ => FileStatus::Modified,
            };
            let count = counts.get(&n.path);
            let change = FileChange {
                path: util::decode_lossy(&n.path),
                old_path: n.old_path.as_deref().filter(|_| status == FileStatus::Renamed).map(util::decode_lossy),
                status,
                area: FileArea::Commit,
                is_binary: count.is_some_and(|c| c.binary),
                is_lfs: false,
                added: count.and_then(|c| c.added),
                removed: count.and_then(|c| c.removed),
                conflict: None,
            };
            ChangedFile { raw_path: n.path, code: n.code, same_mode: n.same_mode, old_sha: n.old_sha, change }
        })
        .collect()
}

/// File list from two runs of the same diff command: `--raw` (status as with `--name-status`,
/// plus mode and blob) and `--numstat`.
/// `command`: subcommand with its switches, `revs`: the compared commits.
///
/// A corrupt repository should not prevent the file list of a commit entirely:
/// - `git diff-tree` reads the index on the side; if it is broken, the comparison of two commits
///   runs again with an empty index – it does not need it.
/// - If a blob is missing, the line counts (and rename detection) fail: then the
///   list comes without counts or without renames.
async fn diff_files(core: &Core, path: &Path, repo_id: &str, command: &[&str], revs: Vec<String>) -> CoreResult<Vec<ChangedFile>> {
    let between_commits = command.first() == Some(&"diff-tree");
    let no_index = core.data_dir().join("kein-index");
    let run = |format: &'static str, renames: bool, without_index: bool| {
        let (pre, rest): (&[&str], &[&str]) = if command.first() == Some(&"diff") { (&NO_INDEX_REFRESH, command) } else { (&[], command) };
        let mut cmd = read_cmd(core, path, repo_id).args(pre).args(rest).arg(if renames { "-M" } else { "--no-renames" });
        if without_index {
            cmd = cmd.env("GIT_INDEX_FILE", &no_index);
        }
        cmd.args(["-z", "--no-abbrev", "--no-ext-diff", "--no-textconv", format]).args(&revs).arg("--").run()
    };
    let index_broken = |result: &CoreResult<crate::git::GitOutput>| matches!(result, Err(e) if e.message.contains(".git/index"));
    let (mut raw, mut counts) = tokio::join!(run("--raw", true, false), run("--numstat", true, false));
    let mut without_index = false;
    if between_commits && (index_broken(&raw) || index_broken(&counts)) {
        without_index = true;
        (raw, counts) = tokio::join!(run("--raw", true, true), run("--numstat", true, true));
    }
    if raw.is_err() {
        // Rename detection reads contents; without it the trees are enough.
        if let Ok(plain) = run("--raw", false, without_index).await {
            raw = Ok(plain);
            counts = run("--numstat", false, without_index).await;
        }
    }
    let counts = match counts {
        Ok(out) => status::parse_numstat_z(&out.stdout),
        Err(e) => {
            log::warn!("line counts of the comparison not readable: {}", e.message);
            Default::default()
        }
    };
    Ok(to_changes(parse_raw_z(&raw?.stdout), &counts))
}

/// `git diff <commit>` must not refresh the index (`NO_INDEX_REFRESH`) and therefore also
/// reports files as changed that only have a new timestamp. Those drop out here:
/// text files without a changed line, binary files after comparing the content.
async fn drop_untouched(core: &Core, path: &Path, repo_id: &str, files: Vec<ChangedFile>) -> Vec<ChangedFile> {
    let suspect = |f: &ChangedFile| f.code == b'M' && f.same_mode;
    let unchanged_text =
        |f: &ChangedFile| suspect(f) && !f.change.is_binary && f.change.added.unwrap_or(0) == 0 && f.change.removed.unwrap_or(0) == 0;
    let mut files: Vec<ChangedFile> = files.into_iter().filter(|f| !unchanged_text(f)).collect();

    // `hash-object --stdin-paths` takes one path per line; names with a newline stay unchecked.
    let binaries: Vec<usize> =
        (0..files.len()).filter(|&i| suspect(&files[i]) && files[i].change.is_binary && !files[i].raw_path.contains(&b'\n')).collect();
    if binaries.is_empty() {
        return files;
    }
    let mut stdin = Vec::new();
    for &i in &binaries {
        stdin.extend_from_slice(&files[i].raw_path);
        stdin.push(b'\n');
    }
    let Ok(out) = read_cmd(core, path, repo_id).args(["hash-object", "--stdin-paths"]).stdin(stdin).run_raw().await else {
        return files;
    };
    let hashes = out.stdout_lines();
    if !out.success() || hashes.len() != binaries.len() {
        return files;
    }
    let same: HashSet<usize> =
        binaries.iter().zip(&hashes).filter(|(&i, hash)| files[i].old_sha.as_bytes() == **hash).map(|(&i, _)| i).collect();
    let mut position = 0;
    files.retain(|_| {
        position += 1;
        !same.contains(&(position - 1))
    });
    files
}

/// Sets `is_lfs` from the attribute `filter=lfs` (from the working directory's .gitattributes).
/// Only a display aid: if the query fails, it stays `false`.
async fn mark_lfs(core: &Core, path: &Path, repo_id: &str, files: &mut [ChangedFile]) {
    if files.is_empty() {
        return;
    }
    let mut stdin = Vec::new();
    for f in files.iter() {
        stdin.extend_from_slice(&f.raw_path);
        stdin.push(0);
    }
    let out = read_cmd(core, path, repo_id).args(["check-attr", "-z", "--stdin", "filter"]).stdin(stdin).run_raw().await;
    let Ok(out) = out else { return };
    if !out.success() {
        return;
    }
    // Output: path NUL attribute NUL value NUL.
    let fields = out.stdout_z();
    let lfs: HashSet<&[u8]> = fields.chunks(3).filter(|t| t.len() == 3 && t[2] == b"lfs").map(|t| t[0]).collect();
    for f in files.iter_mut() {
        f.change.is_lfs = lfs.contains(f.raw_path.as_slice());
    }
}

// ---------------------------------------------------------------------------
// Range and comparison
// ---------------------------------------------------------------------------

async fn range(core: &Core, path: &Path, repo_id: &str, from: &str, to: Option<&str>) -> CoreResult<CommitDetails> {
    // The empty tree as `from`: everything up to `to` counts as added (series starting at the root commit).
    let from_empty = is_empty_tree(from);
    let from = if from_empty { from.trim().to_ascii_lowercase() } else { resolve_commit_at(core, path, repo_id, from).await? };
    let Some(to) = to else {
        return range_to_worktree(core, path, repo_id, &from).await;
    };
    let to = resolve_commit_at(core, path, repo_id, to).await?;
    if from == to {
        return Ok(details(None, Vec::new()));
    }
    let (files, base) = tokio::join!(
        diff_files(core, path, repo_id, &["diff-tree", "-r"], vec![from.clone(), to.clone()]),
        async {
            if from_empty {
                // A tree has no history; the question of the common ancestor does not arise.
                Ok(GitOutput { code: Some(0), ..GitOutput::default() })
            } else {
                read_cmd(core, path, repo_id).args(["merge-base", &from, &to]).run_raw().await
            }
        },
    );
    // Exit code 1 without output: there is no common ancestor.
    if base.is_ok_and(|out: GitOutput| out.code == Some(1) && out.stdout_text().is_empty()) {
        let mut out = details(None, Vec::new());
        out.not_combinable_reason = Some(
            "The two commits share no history. A combined diff would not be meaningful here.".to_string(),
        );
        return Ok(out);
    }
    let mut files = files?;
    mark_lfs(core, path, repo_id, &mut files).await;
    Ok(details(None, files.into_iter().map(|f| f.change).collect()))
}

/// Commit against the working directory: tracked files from `git diff <commit>`, plus the
/// untracked (not ignored) ones.
async fn range_to_worktree(core: &Core, path: &Path, repo_id: &str, from: &str) -> CoreResult<CommitDetails> {
    let (files, untracked) = tokio::join!(
        diff_files(core, path, repo_id, &["diff"], vec![from.to_string()]),
        read_cmd(core, path, repo_id).args(["ls-files", "--others", "--exclude-standard", "-z"]).run(),
    );
    let mut files = drop_untouched(core, path, repo_id, files?).await;
    files.extend(untracked?.stdout_z().into_iter().map(ChangedFile::untracked));
    files.sort_by(|a, b| a.raw_path.cmp(&b.raw_path));
    mark_lfs(core, path, repo_id, &mut files).await;
    Ok(details(None, files.into_iter().map(|f| f.change).collect()))
}

// ---------------------------------------------------------------------------
// Stash
// ---------------------------------------------------------------------------

async fn stash(core: &Core, path: &Path, repo_id: &str, index: u32) -> CoreResult<CommitDetails> {
    let stashes = read_stashes(core, path, repo_id).await?;
    let Some(entry) = stashes.into_iter().find(|s| s.index == index) else {
        return Err(CoreError::not_found(format!("Stash no. {index} does not exist (anymore).")));
    };
    let Some(base) = entry.base() else {
        return Err(CoreError::unknown("The stash has no base commit and cannot be shown."));
    };
    let (meta, tracked, untracked) = tokio::join!(
        read_meta(core, path, repo_id, &entry.sha),
        // Everything tracked (staged and unstaged) against the commit the stash was made on.
        diff_files(core, path, repo_id, &["diff-tree", "-r"], vec![base.to_string(), entry.sha.clone()]),
        async {
            match entry.untracked() {
                // The third parent is a commit without parents that contains only the untracked files.
                Some(sha) => diff_files(core, path, repo_id, &["diff-tree", "-r", "--root", "--no-commit-id"], vec![sha.to_string()]).await,
                None => Ok(Vec::new()),
            }
        },
    );
    let mut info = meta?;
    // The message comes from the reflog: a renamed stash keeps its commit.
    info.summary = entry.message.clone();
    info.description = String::new();
    info.co_authors = Vec::new();
    let mut files = tracked?;
    for mut f in untracked? {
        f.change.status = FileStatus::Untracked;
        files.push(f);
    }
    files.sort_by(|a, b| a.raw_path.cmp(&b.raw_path));
    mark_lfs(core, path, repo_id, &mut files).await;
    Ok(details(Some(info), files.into_iter().map(|f| f.change).collect()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_dates() {
        assert_eq!(parse_raw_date("1767225600 +0000"), (1_767_225_600, 0));
        assert_eq!(parse_raw_date("1767225600 +0130"), (1_767_225_600, 90));
        assert_eq!(parse_raw_date("1767225600 -0800"), (1_767_225_600, -480));
        assert_eq!(parse_raw_date("1767225600 +0545"), (1_767_225_600, 345));
        assert_eq!(parse_raw_date("1767225600"), (1_767_225_600, 0));
        assert_eq!(parse_raw_date("unsinn"), (0, 0));
    }

    #[test]
    fn signature_codes() {
        assert_eq!(signature_status(b"N"), SignatureStatus::None);
        assert_eq!(signature_status(b"G"), SignatureStatus::Good);
        assert_eq!(signature_status(b"B"), SignatureStatus::Bad);
        assert_eq!(signature_status(b"R"), SignatureStatus::Bad);
        for code in [b"U", b"X", b"Y", b"E"] {
            assert_eq!(signature_status(code), SignatureStatus::Unknown);
        }
    }

    #[test]
    fn co_authors() {
        let body = "Text mit Umlauten: äöü\n\nCo-authored-by: Erika Müller <erika@example.com>\nco-AUTHORED-by:  Jörg <j@example.com> \nCo-authored-by: Nur Name\nCo-authored-by: Erika Müller <erika@example.com>\nCo-authored-by:\nSigned-off-by: X <x@example.com>";
        assert_eq!(
            parse_co_authors(body),
            vec![
                Person { name: "Erika Müller".into(), email: "erika@example.com".into() },
                Person { name: "Jörg".into(), email: "j@example.com".into() },
                Person { name: "Nur Name".into(), email: String::new() },
            ]
        );
        assert!(parse_co_authors("ä").is_empty());
        assert!(parse_co_authors("").is_empty());
    }

    #[test]
    fn raw_records() {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let zero = "0".repeat(40);
        let mut input = Vec::new();
        for (meta, paths) in [
            (format!(":100644 100644 {a} {b} M"), "a b.txt\0"),
            (format!(":100644 100644 {a} {a} R087"), "alt/ä.txt\0neu.txt\0"),
            (format!(":100644 000000 {a} {zero} D"), "weg\0"),
            (format!(":000000 100644 {zero} {b} A"), ":doppelpunkt\0"),
            (format!(":100644 120000 {a} {b} T"), "link\0"),
            (format!(":100644 100755 {a} {a} M"), "skript.sh\0"),
        ] {
            input.extend_from_slice(meta.as_bytes());
            input.push(0);
            input.extend_from_slice(paths.as_bytes());
        }
        let parsed = parse_raw_z(&input);
        let seen: Vec<String> = parsed
            .iter()
            .map(|n| {
                let old = n.old_path.as_deref().map(util::decode_lossy).unwrap_or_default();
                format!("{} {} <{old}> {}", n.code as char, util::decode_lossy(&n.path), if n.same_mode { "=" } else { "≠" })
            })
            .collect();
        assert_eq!(
            seen,
            vec!["M a b.txt <> =", "R neu.txt <alt/ä.txt> =", "D weg <> ≠", "A :doppelpunkt <> ≠", "T link <> ≠", "M skript.sh <> ≠"]
        );
        assert_eq!(parsed[0].old_sha, a);
        assert!(parse_raw_z(b"").is_empty());
        // Truncated output: no crash, the incomplete entry is dropped.
        let mut cut = format!(":100644 100644 {a} {b} M\0a\0:100644 100644 {a} {a} R100\0nur-alt\0").into_bytes();
        assert_eq!(parse_raw_z(&cut).len(), 1);
        cut.truncate(20);
        assert!(parse_raw_z(&cut).is_empty());
    }
}
