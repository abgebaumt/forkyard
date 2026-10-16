//! File history, blame, reading and writing files.
//!
//! - `file_history`: `git log --follow` with a fixed format, parsed as a stream.
//! - `file_blame`: `git blame --porcelain`, parsed as a stream.
//! - `line_history`: `git log -L` for one line – the commits that shaped it, with its range in each.
//! - `file_read` / `file_write`: content for the editor, with encoding and line endings.
//!
//! Paths come from the UI relative to the repository (with `/`). Anything leading out of the
//! repository (`..`, absolute) is rejected with `not_allowed`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::app::Core;
use crate::db;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::model::{BlameLine, CommitSummary, Eol, FileContent, FileHistoryEntry, FileStatus, LineEnding, LineHistoryStep, Person, RepoChange};
use crate::util;

/// Above this size `file_read` no longer returns text (`text: null`, `isBinary: false`).
pub const MAX_TEXT_BYTES: u64 = 5 * 1024 * 1024;
/// `file_history` without a limit (`limit: 0`).
const DEFAULT_HISTORY_LIMIT: u32 = 1000;
const MAX_HISTORY_LIMIT: u32 = 50_000;
/// Marks the start of a commit in the output of `git log`.
const COMMIT_MARK: &[u8] = b"\x01gc\x01";
const HISTORY_FORMAT: &str = "--format=%x01gc%x01%x00%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00";
/// Encoding name for UTF-8 with a byte order mark (`FileContent.encoding`, `file_write`).
pub const UTF8_BOM: &str = "utf-8-bom";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/// Checks a path from the UI and brings it into Git's form: relative to the
/// repository, with `/`, without `.` parts. Absolute, `..` or empty → `not_allowed`.
pub fn normalize_rel_path(path: &str) -> CoreResult<String> {
    let outside = || CoreError::not_allowed(format!("The path “{path}” is outside the repository."));
    if path.contains('\0') {
        return Err(CoreError::not_allowed("The path contains an invalid character."));
    }
    let unified = if cfg!(windows) { path.replace('\\', "/") } else { path.to_string() };
    let bytes = unified.as_bytes();
    let has_drive = cfg!(windows) && bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic();
    if unified.starts_with('/') || has_drive || Path::new(&unified).is_absolute() {
        return Err(outside());
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in unified.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err(outside()),
            other => parts.push(other),
        }
    }
    if parts.is_empty() {
        return Err(CoreError::not_allowed("No file path was given."));
    }
    Ok(parts.join("/"))
}

/// Whether a path component means the Git directory (also in the spellings Windows treats as equal).
fn is_git_component(part: &str) -> bool {
    let mut name = part.to_lowercase();
    if cfg!(windows) {
        name = name.trim_end_matches(['.', ' ']).to_string();
        if name == "git~1" {
            return true;
        }
    }
    name == ".git"
}

/// Whether the (already normalised) path points into a `.git` directory.
pub fn is_inside_git_dir(rel: &str) -> bool {
    rel.split('/').any(is_git_component)
}

pub(crate) fn join_rel(root: &Path, rel: &str) -> PathBuf {
    let mut path = root.to_path_buf();
    for part in rel.split('/') {
        path.push(part);
    }
    path
}

/// Absolute path for reading. If a symlink leads out of the repository: `not_allowed`.
fn resolve_for_read(root: &Path, rel: &str) -> CoreResult<PathBuf> {
    let target = join_rel(root, rel);
    if let (Ok(real_root), Ok(real)) = (root.canonicalize(), target.canonicalize()) {
        if !real.starts_with(&real_root) {
            return Err(CoreError::not_allowed(format!("“{rel}” points to a file outside the repository.")));
        }
    }
    Ok(target)
}

/// Absolute path for writing. Follows symlinks as far as the path already exists, and
/// rejects everything that would then lie outside the repository or in `.git`.
fn resolve_for_write(root: &Path, rel: &str) -> CoreResult<PathBuf> {
    let git_error = || CoreError::not_allowed("Writing to the Git directory (.git) is not allowed.");
    if is_inside_git_dir(rel) {
        return Err(git_error());
    }
    let real_root = root.canonicalize()?;
    let target = join_rel(root, rel);
    // Deepest part of the path that already exists.
    let mut existing = target.clone();
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    while existing.symlink_metadata().is_err() {
        match (existing.file_name().map(|n| n.to_os_string()), existing.parent().map(Path::to_path_buf)) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                existing = parent;
            }
            _ => break,
        }
    }
    let real = existing.canonicalize()?;
    let inside = real.strip_prefix(&real_root).map_err(|_| {
        CoreError::not_allowed(format!("“{rel}” points to a location outside the repository."))
    })?;
    if inside.components().any(|c| is_git_component(&c.as_os_str().to_string_lossy())) {
        return Err(git_error());
    }
    let mut resolved = real;
    for name in rest.iter().rev() {
        resolved.push(name);
    }
    Ok(resolved)
}

/// A commit or ref as an argument for Git: nothing that could be misread as a switch or as
/// `<rev>:<path>`.
fn check_rev(sha: &str) -> CoreResult<&str> {
    let rev = sha.trim();
    if rev.is_empty() || rev.starts_with('-') || rev.chars().any(|c| c == ':' || c.is_whitespace() || c.is_control()) {
        return Err(CoreError::not_allowed(format!("“{sha}” is not a valid commit reference.")));
    }
    Ok(rev)
}

fn short_rev(rev: &str) -> String {
    let is_sha = rev.len() >= 40 && rev.bytes().all(|b| b.is_ascii_hexdigit());
    if is_sha { rev.chars().take(7).collect() } else { rev.to_string() }
}

// ---------------------------------------------------------------------------
// Encoding and line endings
// ---------------------------------------------------------------------------

/// The encoding preferred in the repository (`RepoSettings.encoding`), otherwise "utf-8".
fn repo_encoding(core: &Core, repo_id: &str) -> String {
    core.db
        .with(|c| db::repo_settings::get_all(c, repo_id))
        .ok()
        .and_then(|all| all.into_iter().find(|(k, _)| k == "encoding"))
        .and_then(|(_, v)| v.as_str().map(|s| s.trim().to_lowercase()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "utf-8".into())
}

fn encoding_name(enc: &'static encoding_rs::Encoding) -> String {
    enc.name().to_ascii_lowercase()
}

/// The preferred encoding, if it is known and not UTF-8/UTF-16 anyway.
fn legacy_encoding(preferred: &str) -> Option<&'static encoding_rs::Encoding> {
    encoding_rs::Encoding::for_label(preferred.trim().as_bytes())
        .filter(|e| *e != encoding_rs::UTF_8 && *e != encoding_rs::UTF_16LE && *e != encoding_rs::UTF_16BE)
}

/// Whether the bytes start with a UTF-16 BOM (such files contain NUL bytes but are text).
fn has_utf16_bom(bytes: &[u8]) -> bool {
    matches!(encoding_rs::Encoding::for_bom(bytes), Some((enc, _)) if enc != encoding_rs::UTF_8)
}

/// Binary as with Git (NUL in the first 8000 bytes), except for UTF-16 with a BOM.
pub fn is_binary_content(bytes: &[u8]) -> bool {
    !has_utf16_bom(bytes) && util::looks_binary(bytes)
}

/// Decodes file content for display and names the encoding with which
/// `encode_content` produces the same bytes again:
/// BOM → "utf-8-bom" / "utf-16le" / "utf-16be"; pure ASCII → the preferred encoding;
/// valid UTF-8 → "utf-8"; otherwise the preferred encoding, falling back to windows-1252.
pub fn decode_content(bytes: &[u8], preferred: &str) -> (String, String) {
    if let Some((enc, bom_len)) = encoding_rs::Encoding::for_bom(bytes) {
        let (text, _) = enc.decode_without_bom_handling(&bytes[bom_len..]);
        let name = if enc == encoding_rs::UTF_8 { UTF8_BOM.to_string() } else { encoding_name(enc) };
        return (text.into_owned(), name);
    }
    let legacy = legacy_encoding(preferred);
    match std::str::from_utf8(bytes) {
        Ok(text) if bytes.is_ascii() => (text.to_string(), legacy.map(encoding_name).unwrap_or_else(|| "utf-8".into())),
        Ok(text) => (text.to_string(), "utf-8".into()),
        Err(_) => {
            let enc = legacy.unwrap_or(encoding_rs::WINDOWS_1252);
            let (text, _) = enc.decode_without_bom_handling(bytes);
            (text.into_owned(), encoding_name(enc))
        }
    }
}

/// Converts text into the named encoding. Unknown name → `not_allowed`;
/// characters the encoding does not know → `unsupported` (nothing is silently replaced).
pub fn encode_content(text: &str, encoding: &str) -> CoreResult<Vec<u8>> {
    let label = encoding.trim().to_lowercase();
    if label.is_empty() || label == "utf-8" || label == "utf8" {
        return Ok(text.as_bytes().to_vec());
    }
    if label == UTF8_BOM || label == "utf8-bom" {
        let mut out = vec![0xEF, 0xBB, 0xBF];
        out.extend_from_slice(text.as_bytes());
        return Ok(out);
    }
    let Some(enc) = encoding_rs::Encoding::for_label(label.as_bytes()) else {
        return Err(CoreError::not_allowed(format!("Unknown encoding “{encoding}”.")));
    };
    if enc == encoding_rs::UTF_8 {
        return Ok(text.as_bytes().to_vec());
    }
    if enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE {
        let little = enc == encoding_rs::UTF_16LE;
        let mut out: Vec<u8> = if little { vec![0xFF, 0xFE] } else { vec![0xFE, 0xFF] };
        for unit in text.encode_utf16() {
            out.extend_from_slice(&if little { unit.to_le_bytes() } else { unit.to_be_bytes() });
        }
        return Ok(out);
    }
    if enc.output_encoding() != enc {
        return Err(CoreError::unsupported(format!("Files cannot be saved in the encoding “{encoding}”.")));
    }
    let (bytes, _, unmappable) = enc.encode(text);
    if unmappable {
        return Err(CoreError::unsupported(format!(
            "The text contains characters that don’t exist in the encoding “{}”. Please save it as UTF-8.",
            encoding_name(enc)
        )));
    }
    Ok(bytes.into_owned())
}

/// Encoding given by a single call (`encoding` for `file_read`, `file_blame`,
/// `diff_file`): `None` = detect as before; otherwise read exactly like that, even if the
/// bytes look like something else ("Reopen with encoding"). Unknown name → `not_allowed`.
pub(crate) fn forced_encoding(label: Option<&str>) -> CoreResult<Option<&'static encoding_rs::Encoding>> {
    let Some(label) = label.map(|l| l.trim().to_lowercase()).filter(|l| !l.is_empty()) else { return Ok(None) };
    if label == UTF8_BOM || label == "utf8-bom" {
        return Ok(Some(encoding_rs::UTF_8));
    }
    encoding_rs::Encoding::for_label(label.as_bytes())
        .map(Some)
        .ok_or_else(|| CoreError::not_allowed(format!("Unknown encoding “{label}”.")))
}

/// Decodes with exactly this encoding (a matching BOM at the start is dropped; whatever does not
/// fit is replaced) and names it so that `encode_content` produces the same bytes again.
pub(crate) fn decode_forced(bytes: &[u8], enc: &'static encoding_rs::Encoding) -> (String, String) {
    let (body, had_bom) = match encoding_rs::Encoding::for_bom(bytes) {
        Some((found, len)) if found == enc => (&bytes[len..], true),
        _ => (bytes, false),
    };
    let name = if enc == encoding_rs::UTF_8 && had_bom { UTF8_BOM.to_string() } else { encoding_name(enc) };
    (enc.decode_without_bom_handling(body).0.into_owned(), name)
}

/// Line endings of a text: only `\n` → lf, only `\r\n` → crlf, both → mixed (without a newline: lf).
pub fn detect_eol(text: &str) -> Eol {
    let bytes = text.as_bytes();
    let (mut lf, mut crlf) = (0usize, 0usize);
    for (i, &b) in bytes.iter().enumerate() {
        if b == b'\n' {
            if i > 0 && bytes[i - 1] == b'\r' {
                crlf += 1;
            } else {
                lf += 1;
            }
        }
    }
    match (lf, crlf) {
        (_, 0) => Eol::Lf,
        (0, _) => Eol::Crlf,
        _ => Eol::Mixed,
    }
}

/// Normalises all line endings (`\r\n` and `\n`) to the requested one.
pub fn normalize_eol(text: &str, eol: LineEnding) -> String {
    let unix = text.replace("\r\n", "\n");
    match eol {
        LineEnding::Lf => unix,
        LineEnding::Crlf => unix.replace('\n', "\r\n"),
    }
}

/// Decodes a single line (blame): UTF-8, otherwise the preferred encoding or windows-1252.
fn decode_line(bytes: &[u8], preferred: &str) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => {
            let enc = legacy_encoding(preferred).unwrap_or(encoding_rs::WINDOWS_1252);
            enc.decode_without_bom_handling(bytes).0.into_owned()
        }
    }
}

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
pub async fn file_history(core: &Core, repo_id: String, path: String, limit: u32, offset: Option<u32>) -> CoreResult<Vec<FileHistoryEntry>> {
    let rel = normalize_rel_path(&path)?;
    let head = core
        .git_for(&repo_id)?
        .args(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])
        .read_only()
        .no_log()
        .run_raw()
        .await?;
    if !head.success() {
        return Ok(Vec::new());
    }
    let limit = if limit == 0 { DEFAULT_HISTORY_LIMIT } else { limit.min(MAX_HISTORY_LIMIT) };
    let offset = offset.unwrap_or(0);
    let max_count = format!("--max-count={}", offset.saturating_add(limit));
    let mut parser = HistoryParser::new(&rel);
    core.git_for(&repo_id)?
        // The path is meant literally, even if it contains "*" or "[".
        .env("GIT_LITERAL_PATHSPECS", "1")
        .args(["log", "--follow", "-M", "--diff-merges=first-parent", "--raw", "--numstat", "-z"])
        .args(["--no-show-signature", "--no-decorate", max_count.as_str(), HISTORY_FORMAT, "--", rel.as_str()])
        .read_only()
        .run_records(0, None, &mut |record| {
            parser.feed(record);
            true
        })
        .await?;
    Ok(parser.finish().into_iter().skip(offset as usize).collect())
}

// ---------------------------------------------------------------------------
// line_history
// ---------------------------------------------------------------------------

/// `line_history` returns at most this many steps.
pub const LINE_HISTORY_STEPS: u32 = 20;
/// Start of a commit in the output of `git log -L`. It stands at a line start, where a diff line never
/// begins with 0x1e.
const LINE_MARK: &[u8] = b"\x1e\x1efy\x1e";
const LINE_FORMAT: &str = "--format=%x1e%x1efy%x1e%H%x00%P%x00%an%x00%ae%x00%at%x00%s%x00";

/// The commits that shaped line `line` (1-based) of `path` at commit `sha`, newest first, at most
/// `LINE_HISTORY_STEPS` (`git log -L<n>,<n>:<path>`); follows renames. Each step names the file's path
/// and the line range in that commit. Pure read.
pub async fn line_history(core: &Core, repo_id: String, path: String, line: u32, sha: String) -> CoreResult<Vec<LineHistoryStep>> {
    let rel = normalize_rel_path(&path)?;
    if line == 0 {
        return Err(CoreError::not_allowed("Lines are counted from 1."));
    }
    let commit = crate::commands::graph::resolve_commit(core, &repo_id, &sha).await?;
    let out = core
        .git_for(&repo_id)?
        .args(["-c", "core.quotePath=false", "log"])
        .args(crate::commands::graph::LOG_SAFE)
        .args(["--no-decorate", "--no-color", "--no-ext-diff", "-z"])
        .arg(format!("--max-count={LINE_HISTORY_STEPS}"))
        .arg(LINE_FORMAT)
        .arg(format!("-L{line},{line}:{rel}"))
        .arg(&commit)
        .arg("--")
        .read_only()
        .no_log()
        .run_raw()
        .await?;
    if !out.success() {
        let text = out.stderr_text();
        if text.contains("has only") || text.contains("no path") {
            return Err(CoreError::not_found(format!("Line {line} of “{rel}” doesn’t exist at this commit.")).with_git_output(text));
        }
        return Err(crate::git::errors::classify("log", out.code, &out.stdout, &out.stderr));
    }
    Ok(parse_line_history(&out.stdout, &rel))
}

/// The records of `git log -L` with `LINE_FORMAT`: header fields, then the diff of the line range.
fn parse_line_history(stdout: &[u8], newest_path: &str) -> Vec<LineHistoryStep> {
    let mut steps = Vec::new();
    let mut last_path = newest_path.to_string();
    let mut starts: Vec<usize> = stdout.windows(LINE_MARK.len()).enumerate().filter(|(_, window)| *window == LINE_MARK).map(|(index, _)| index).collect();
    starts.push(stdout.len());
    for pair in starts.windows(2) {
        let record = &stdout[pair[0] + LINE_MARK.len()..pair[1]];
        let mut fields = record.splitn(7, |&byte| byte == 0);
        let header: Vec<&[u8]> = (0..6).filter_map(|_| fields.next()).collect();
        let [sha, parents, name, email, time, summary] = header.as_slice() else { continue };
        let Some((path, start, count)) = hunk_of(fields.next().unwrap_or_default()) else { continue };
        let path = path.unwrap_or_else(|| last_path.clone());
        last_path = path.clone();
        steps.push(LineHistoryStep {
            commit: CommitSummary {
                sha: util::decode_lossy(sha),
                parents: util::decode_lossy(parents).split_whitespace().map(str::to_string).collect(),
                author: Person { name: util::decode_lossy(name), email: util::decode_lossy(email) },
                authored_at: util::unix_to_iso(util::decode_lossy(time).trim().parse().unwrap_or(0)),
                summary: util::decode_lossy(summary),
            },
            path,
            start_line: start,
            end_line: if count == 0 { start } else { start + count - 1 },
        });
    }
    steps
}

/// Path (`+++ b/…`; `None` if Git quoted it) and the new range (`+c,d`) of the first hunk.
fn hunk_of(diff: &[u8]) -> Option<(Option<String>, u32, u32)> {
    let mut path = None;
    for line in diff.split(|&byte| byte == b'\n') {
        let line = line.strip_prefix(b"\0").unwrap_or(line);
        if let Some(rest) = line.strip_prefix(b"+++ ") {
            path = rest.strip_prefix(b"b/").filter(|name| !name.starts_with(b"\"")).map(|name| util::decode_lossy(name).trim_end_matches('\t').to_string());
        } else if line.starts_with(b"@@ ") {
            let text = util::decode_lossy(line);
            let new = text.split_whitespace().find(|part| part.starts_with('+'))?;
            let (start, count) = match new[1..].split_once(',') {
                Some((start, count)) => (start.parse().ok()?, count.parse().ok()?),
                None => (new[1..].parse().ok()?, 1),
            };
            return Some((path, start, count));
        }
    }
    None
}

#[derive(Default)]
struct PendingEntry {
    header: Vec<Vec<u8>>,
    status: Option<u8>,
    first_path: Option<Vec<u8>>,
    second_path: Option<Vec<u8>>,
    added: Option<u32>,
    removed: Option<u32>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Expect {
    /// Before the first commit.
    Mark,
    /// Header field number n (SHA, parents, name, e-mail, time, summary).
    Header,
    /// Diff entries or the next commit.
    Body,
    RawPath,
    RawSecondPath,
    NumstatOld,
    NumstatNew,
}

const HEADER_FIELDS: usize = 6;

/// State machine over the NUL-separated output of
/// `git log -z --raw --numstat --format=<HISTORY_FORMAT>`.
struct HistoryParser {
    expect: Expect,
    current: Option<PendingEntry>,
    /// Name of the file in the commit currently being read (changes at renames).
    name: String,
    entries: Vec<FileHistoryEntry>,
}

impl HistoryParser {
    fn new(path: &str) -> Self {
        HistoryParser { expect: Expect::Mark, current: None, name: path.to_string(), entries: Vec::new() }
    }

    fn feed(&mut self, record: &[u8]) {
        match self.expect {
            Expect::Header => {
                if let Some(cur) = self.current.as_mut() {
                    cur.header.push(record.to_vec());
                    if cur.header.len() == HEADER_FIELDS {
                        self.expect = Expect::Body;
                    }
                }
            }
            Expect::RawPath => {
                let two_paths = matches!(self.current.as_ref().and_then(|c| c.status), Some(b'R' | b'C'));
                if let Some(cur) = self.current.as_mut() {
                    cur.first_path = Some(record.to_vec());
                }
                self.expect = if two_paths { Expect::RawSecondPath } else { Expect::Body };
            }
            Expect::RawSecondPath => {
                if let Some(cur) = self.current.as_mut() {
                    cur.second_path = Some(record.to_vec());
                }
                self.expect = Expect::Body;
            }
            Expect::NumstatOld => self.expect = Expect::NumstatNew,
            Expect::NumstatNew => self.expect = Expect::Body,
            Expect::Mark | Expect::Body => self.feed_body(record),
        }
    }

    fn feed_body(&mut self, record: &[u8]) {
        let start = record.iter().position(|&b| b != b'\n').unwrap_or(record.len());
        let token = &record[start..];
        if token.is_empty() {
            return;
        }
        if token == COMMIT_MARK {
            self.flush();
            self.current = Some(PendingEntry::default());
            self.expect = Expect::Header;
            return;
        }
        let Some(cur) = self.current.as_mut() else { return };
        if token[0] == b':' {
            // ":<mode> <mode> <blob> <blob> <status>[similarity]", then the path or two paths.
            if cur.status.is_none() {
                cur.status = token.rsplit(|&b| b == b' ').next().and_then(|s| s.first().copied());
                self.expect = Expect::RawPath;
            }
            return;
        }
        let mut fields = token.splitn(3, |&b| b == b'\t');
        if let (Some(added), Some(removed), Some(path)) = (fields.next(), fields.next(), fields.next()) {
            let number = |field: &[u8]| std::str::from_utf8(field).ok().and_then(|s| s.parse::<u32>().ok());
            if cur.added.is_none() && cur.removed.is_none() {
                cur.added = number(added);
                cur.removed = number(removed);
            }
            if path.is_empty() {
                // Rename: old and new path follow as separate entries.
                self.expect = Expect::NumstatOld;
            }
        }
    }

    fn flush(&mut self) {
        let Some(cur) = self.current.take() else { return };
        if cur.header.len() < HEADER_FIELDS {
            return;
        }
        let text = |i: usize| util::decode_lossy(&cur.header[i]);
        let commit = CommitSummary {
            sha: text(0),
            parents: text(1).split_whitespace().map(str::to_string).collect(),
            author: Person { name: text(2), email: text(3) },
            authored_at: util::unix_to_iso(text(4).trim().parse().unwrap_or(0)),
            summary: text(5),
        };
        let decode = |p: &Option<Vec<u8>>| p.as_deref().map(util::decode_lossy);
        let (status, path, old_path) = match cur.status {
            Some(b'R') => (FileStatus::Renamed, decode(&cur.second_path), decode(&cur.first_path)),
            // Copy: like a new file, with a reference to the source.
            Some(b'C') => (FileStatus::Added, decode(&cur.second_path), decode(&cur.first_path)),
            Some(b'A') => (FileStatus::Added, decode(&cur.first_path), None),
            Some(b'D') => (FileStatus::Deleted, decode(&cur.first_path), None),
            _ => (FileStatus::Modified, decode(&cur.first_path), None),
        };
        let path = path.unwrap_or_else(|| self.name.clone());
        if let Some(old) = &old_path {
            // Older commits know the file under the old name.
            self.name = old.clone();
        }
        self.entries.push(FileHistoryEntry { commit, path, old_path, status, added: cur.added, removed: cur.removed });
    }

    fn finish(mut self) -> Vec<FileHistoryEntry> {
        self.flush();
        self.entries
    }
}

// ---------------------------------------------------------------------------
// file_blame
// ---------------------------------------------------------------------------

/// `git blame --porcelain`; `sha: None` = working directory including uncommitted lines
/// (`uncommitted: true`). A file that does not exist in HEAD yet comes back entirely as
/// "not committed". Binary file → `unsupported`; unknown path → `not_found`.
///
/// `encoding` sets the encoding for this one call (otherwise: UTF-8, falling back to the
/// repository's default).
pub async fn file_blame(core: &Core, repo_id: String, path: String, sha: Option<String>, encoding: Option<String>) -> CoreResult<Vec<BlameLine>> {
    let rel = normalize_rel_path(&path)?;
    let forced = forced_encoding(encoding.as_deref())?;
    let preferred = repo_encoding(core, &repo_id);
    let binary = || CoreError::unsupported(format!("“{rel}” is a binary file; blame is only available for text files."));
    let mut cmd = core.git_for(&repo_id)?.args(["blame", "--porcelain"]);
    match sha.as_deref() {
        Some(sha) => {
            let rev = check_rev(sha)?;
            let spec = format!("{rev}:{rel}");
            let is_binary = blob_looks_binary(core, &repo_id, &spec).await.map_err(|e| match e.code {
                ErrorCode::NotFound | ErrorCode::Unknown => CoreError::not_found(format!(
                    "The file “{rel}” does not exist in commit {}.",
                    short_rev(rev)
                ))
                .with_git_output(e.git_output.unwrap_or_default()),
                _ => e,
            })?;
            if is_binary {
                return Err(binary());
            }
            cmd = cmd.arg(rev);
        }
        None => {
            let root = core.repo_path(&repo_id)?;
            let file = resolve_for_read(&root, &rel)?;
            if !file.is_file() {
                return Err(CoreError::not_found(format!("The file “{rel}” does not exist in the working directory.")));
            }
            if is_binary_content(&read_head_bytes(&file)?) {
                return Err(binary());
            }
            let in_head = core
                .git_for(&repo_id)?
                .args(["cat-file", "-e", &format!("HEAD:{rel}")])
                .read_only()
                .no_log()
                .run_raw()
                .await?
                .success();
            if !in_head {
                return uncommitted_file(&file, &rel, &preferred, forced);
            }
        }
    }
    let mut parser = BlameParser::new(&preferred, forced);
    cmd.args(["--", rel.as_str()])
        .read_only()
        .run_records(b'\n', None, &mut |line| {
            parser.feed(line);
            true
        })
        .await?;
    Ok(parser.lines)
}

/// Whether a blob is binary without reading it completely: Git is stopped as soon as the first NUL byte arrives.
pub(crate) async fn blob_looks_binary(core: &Core, repo_id: &str, spec: &str) -> CoreResult<bool> {
    let mut nul_in_head = false;
    let out = core
        .git_for(repo_id)?
        .args(["cat-file", "blob", spec])
        .read_only()
        .no_log()
        .run_records(0, None, &mut |before_nul| {
            nul_in_head = before_nul.len() < 8000;
            false
        })
        .await?;
    // Without a NUL Git runs to the end normally (code = 0); only an early NUL counts.
    Ok(out.code.is_none() && nul_in_head)
}

/// The first 8000 bytes of a file (for binary detection).
fn read_head_bytes(file: &Path) -> CoreResult<Vec<u8>> {
    use std::io::Read;
    let mut head = Vec::with_capacity(8000);
    std::fs::File::open(file)?.take(8000).read_to_end(&mut head)?;
    Ok(head)
}

const ZERO_AUTHOR: &str = "Not committed yet";
const ZERO_SUMMARY: &str = "Uncommitted changes";

fn zero_sha(len: usize) -> String {
    "0".repeat(len)
}

/// Blame of a file HEAD does not know (new or untracked): every line is "not committed".
fn uncommitted_file(file: &Path, rel: &str, preferred: &str, forced: Option<&'static encoding_rs::Encoding>) -> CoreResult<Vec<BlameLine>> {
    let size = file.metadata()?.len();
    if size > MAX_TEXT_BYTES {
        return Err(CoreError::unsupported(format!("“{rel}” is too large for blame.")));
    }
    let bytes = std::fs::read(file)?;
    let (text, _) = match forced {
        Some(enc) => decode_forced(&bytes, enc),
        None => decode_content(&bytes, preferred),
    };
    let now = util::now_iso();
    let mut lines: Vec<&str> = text.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    Ok(lines
        .into_iter()
        .enumerate()
        .map(|(i, line)| BlameLine {
            line_no: i as u32 + 1,
            text: line.strip_suffix('\r').unwrap_or(line).to_string(),
            sha: zero_sha(40),
            author: Person { name: ZERO_AUTHOR.into(), email: String::new() },
            authored_at: now.clone(),
            summary: ZERO_SUMMARY.into(),
            uncommitted: true,
        })
        .collect())
}

#[derive(Default, Clone)]
struct BlameCommit {
    author: Person,
    authored_at: String,
    summary: String,
}

/// Line-by-line parser for `git blame --porcelain`. The details of a commit only appear
/// at its first occurrence; after that each line only has "<sha> <old> <new>" and the content.
struct BlameParser {
    preferred: String,
    /// Encoding given by the call; otherwise it is guessed per line.
    forced: Option<&'static encoding_rs::Encoding>,
    commits: HashMap<String, BlameCommit>,
    sha: String,
    line_no: u32,
    lines: Vec<BlameLine>,
}

impl BlameParser {
    fn new(preferred: &str, forced: Option<&'static encoding_rs::Encoding>) -> Self {
        BlameParser { preferred: preferred.to_string(), forced, commits: HashMap::new(), sha: String::new(), line_no: 0, lines: Vec::new() }
    }

    fn feed(&mut self, line: &[u8]) {
        if let Some(content) = line.strip_prefix(b"\t") {
            let content = content.strip_suffix(b"\r").unwrap_or(content);
            let uncommitted = !self.sha.is_empty() && self.sha.bytes().all(|b| b == b'0');
            let commit = self.commits.get(&self.sha).cloned().unwrap_or_default();
            let (author, summary) = if uncommitted {
                (Person { name: ZERO_AUTHOR.into(), email: String::new() }, ZERO_SUMMARY.to_string())
            } else {
                (commit.author, commit.summary)
            };
            self.lines.push(BlameLine {
                line_no: self.line_no,
                text: match self.forced {
                    Some(enc) => enc.decode_without_bom_handling(content).0.into_owned(),
                    None => decode_line(content, &self.preferred),
                },
                sha: self.sha.clone(),
                author,
                authored_at: commit.authored_at,
                summary,
                uncommitted,
            });
            return;
        }
        let text = util::decode_lossy(line);
        let (key, value) = text.split_once(' ').unwrap_or((text.as_str(), ""));
        let is_sha = (key.len() == 40 || key.len() == 64) && key.bytes().all(|b| b.is_ascii_hexdigit());
        if is_sha {
            // "<sha> <line in original> <line in result> [<count>]"
            let final_line = value.split(' ').nth(1).and_then(|n| n.parse::<u32>().ok());
            if let Some(n) = final_line {
                self.sha = key.to_string();
                self.line_no = n;
                self.commits.entry(self.sha.clone()).or_insert_with(|| BlameCommit {
                    authored_at: util::unix_to_iso(0),
                    ..BlameCommit::default()
                });
                return;
            }
        }
        let Some(commit) = self.commits.get_mut(&self.sha) else { return };
        match key {
            "author" => commit.author.name = value.to_string(),
            "author-mail" => commit.author.email = value.trim_start_matches('<').trim_end_matches('>').to_string(),
            "author-time" => commit.authored_at = util::unix_to_iso(value.trim().parse().unwrap_or(0)),
            "summary" => commit.summary = value.to_string(),
            _ => {}
        }
    }
}

// ---------------------------------------------------------------------------
// file_read
// ---------------------------------------------------------------------------

/// Reads a file; `sha: None` = working directory, otherwise the state in this commit.
///
/// - Binary file: `text: null`, `isBinary: true`, `encoding: ""`.
/// - Larger than `MAX_TEXT_BYTES` (5 MiB): `text: null`, `isBinary: false`, `encoding: ""` –
///   that is how the UI recognises "too large"; `size` gives the size.
/// - Otherwise the text unchanged (line endings are kept), with `encoding` and `eol`
///   for the later `file_write`.
///
/// File missing: `not_found`. Path outside the repository: `not_allowed`.
///
/// `encoding` sets the encoding for this one call ("Reopen with encoding"): then it is
/// decoded exactly like that instead of detected; with UTF-16 the file counts as text even without a BOM.
/// Unknown name → `not_allowed`. `None` = detect, with the repository's default.
pub async fn file_read(core: &Core, repo_id: String, path: String, sha: Option<String>, encoding: Option<String>) -> CoreResult<FileContent> {
    let rel = normalize_rel_path(&path)?;
    let forced = forced_encoding(encoding.as_deref())?;
    let preferred = repo_encoding(core, &repo_id);
    let no_text = |size: u64, is_binary: bool| FileContent {
        path: rel.clone(),
        text: None,
        is_binary,
        encoding: String::new(),
        eol: Eol::Lf,
        size,
    };
    let bytes = match sha.as_deref() {
        None => {
            let root = core.repo_path(&repo_id)?;
            let file = resolve_for_read(&root, &rel)?;
            let meta = match file.metadata() {
                Ok(meta) => meta,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    return Err(CoreError::not_found(format!("The file “{rel}” does not exist in the working directory.")));
                }
                Err(e) => return Err(e.into()),
            };
            if meta.is_dir() {
                return Err(CoreError::not_allowed(format!("“{rel}” is a folder.")));
            }
            if meta.len() > MAX_TEXT_BYTES {
                return Ok(no_text(meta.len(), is_binary_content(&read_head_bytes(&file)?)));
            }
            tokio::fs::read(&file).await?
        }
        Some(sha) => {
            let rev = check_rev(sha)?;
            let missing = || CoreError::not_found(format!("The file “{rel}” does not exist in commit {}.", short_rev(rev)));
            let check = core
                .git_for(&repo_id)?
                .args(["cat-file", "--batch-check", "-z"])
                .stdin(format!("{rev}:{rel}\0").into_bytes())
                .read_only()
                .no_log()
                .run()
                .await?;
            // "<oid> <type> <size>" or "<spec> missing".
            let line = check.stdout_text();
            let mut fields = line.rsplitn(3, ' ');
            let (size, kind, oid) = match (fields.next(), fields.next(), fields.next()) {
                (Some(size), Some(kind), Some(oid)) if size != "missing" => (size.parse::<u64>().ok(), kind, oid),
                _ => return Err(missing()),
            };
            let Some(size) = size else { return Err(missing()) };
            match kind {
                "blob" => {}
                "tree" => return Err(CoreError::not_allowed(format!("“{rel}” is a folder."))),
                _ => return Err(missing()),
            }
            if size > MAX_TEXT_BYTES {
                let is_binary = blob_looks_binary(core, &repo_id, oid).await?;
                return Ok(no_text(size, is_binary));
            }
            core.git_for(&repo_id)?.args(["cat-file", "blob", oid]).read_only().no_log().run().await?.stdout
        }
    };
    let size = bytes.len() as u64;
    let utf16 = forced.is_some_and(|enc| enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE);
    if !utf16 && is_binary_content(&bytes) {
        return Ok(no_text(size, true));
    }
    let (text, encoding) = match forced {
        Some(enc) => decode_forced(&bytes, enc),
        None => decode_content(&bytes, &preferred),
    };
    let eol = detect_eol(&text);
    Ok(FileContent { path: rel, text: Some(text), is_binary: false, encoding, eol, size })
}

// ---------------------------------------------------------------------------
// file_write
// ---------------------------------------------------------------------------

/// Saves a file in the working directory (editor): in the given encoding, all
/// line endings normalised to `eol`, atomically (temp file in the same folder, then
/// rename). Missing folders are created. Reports `repo:changed` with `worktree`.
///
/// Path outside the repository, in `.git` or a folder → `not_allowed`; unknown
/// encoding → `not_allowed`; characters the encoding does not know → `unsupported`.
pub async fn file_write(core: &Core, repo_id: String, path: String, content: String, encoding: String, eol: LineEnding) -> CoreResult<()> {
    let rel = normalize_rel_path(&path)?;
    let root = core.repo_path(&repo_id)?;
    let target = resolve_for_write(&root, &rel)?;
    if target.is_dir() {
        return Err(CoreError::not_allowed(format!("“{rel}” is a folder.")));
    }
    let bytes = encode_content(&normalize_eol(&content, eol), &encoding)?;
    core.with_write_lock(&repo_id, &[RepoChange::Worktree], async {
        let shown = rel.clone();
        tokio::task::spawn_blocking(move || write_atomic(&target, &bytes))
            .await
            .map_err(|e| CoreError::io(format!("Saving was aborted: {e}")))?
            .map_err(|e| CoreError::new(e.code, format!("“{shown}” could not be saved. {}", e.message)))
    })
    .await
}

/// Writes to a temp file next to the target and renames it over it (see
/// `util::write_file_atomic`): if another program holds the file briefly, it waits.
fn write_atomic(target: &Path, bytes: &[u8]) -> CoreResult<()> {
    util::write_file_atomic(target, bytes).map_err(CoreError::from)
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod line_history_tests;
