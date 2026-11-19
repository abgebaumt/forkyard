//! File history, blame, reading and writing files.
//!
//! - `file_history`: `git log --follow` with a fixed format, parsed as a stream.
//! - `file_blame`: `git blame --porcelain`, parsed as a stream.
//! - `line_history`: `git log -L` for one line – the commits that shaped it, with its range in each.
//! - `file_read` / `file_write`: content for the editor, with encoding and line endings.
//!
//! Paths come from the UI relative to the repository (with `/`). Anything leading out of the
//! repository (`..`, absolute) is rejected with `not_allowed`.

use std::path::Path;

use crate::app::Core;
use crate::db;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::log::{self as gitlog, HEADER, HEADER_FIELDS, LOG_SAFE};
use crate::git::rev;
use crate::model::{BlameLine, Eol, FileContent, FileHistoryEntry, FileStatus, LineEnding, LineHistoryStep, Person, RepoChange};
use crate::util;

/// Above this size `file_read` no longer returns text (`text: null`, `isBinary: false`).
pub const MAX_TEXT_BYTES: u64 = 5 * 1024 * 1024;
/// `file_history` without a limit (`limit: 0`).
const DEFAULT_HISTORY_LIMIT: u32 = 1000;
const MAX_HISTORY_LIMIT: u32 = 50_000;

/// A commit or ref as an argument for Git: nothing that could be misread as a switch or as
/// `<rev>:<path>`.
fn check_rev(sha: &str) -> CoreResult<&str> {
    let rev = sha.trim();
    if !rev::is_rev_arg(rev) || rev.chars().any(|c| c == ':' || c.is_whitespace()) {
        return Err(CoreError::not_allowed(format!("“{sha}” is not a valid commit reference.")));
    }
    Ok(rev)
}

fn short_rev(rev: &str) -> String {
    let is_sha = rev.len() >= 40 && rev.bytes().all(|b| b.is_ascii_hexdigit());
    if is_sha {
        rev.chars().take(7).collect()
    } else {
        rev.to_string()
    }
}

mod blame;
mod line;
mod log;
pub use blame::*;
pub use line::*;
pub use log::*;

// ---------------------------------------------------------------------------
// Encoding and line endings
// ---------------------------------------------------------------------------

/// The encoding preferred in the repository (`RepoSettings.encoding`), otherwise "utf-8".
pub(crate) fn repo_encoding(core: &Core, repo_id: &str) -> String {
    core.db
        .with(|c| db::repo_settings::get(c, repo_id, "encoding"))
        .ok()
        .flatten()
        .and_then(|v| v.as_str().map(|s| s.trim().to_lowercase()))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "utf-8".into())
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
pub async fn file_read(
    core: &Core,
    repo_id: String,
    path: String,
    sha: Option<String>,
    encoding: Option<String>,
) -> CoreResult<FileContent> {
    let rel = util::normalize_rel_path(&path)?;
    let forced = util::forced_encoding(encoding.as_deref())?;
    let preferred = repo_encoding(core, &repo_id);
    let no_text =
        |size: u64, is_binary: bool| FileContent { path: rel.clone(), text: None, is_binary, encoding: String::new(), eol: Eol::Lf, size };
    let bytes = match sha.as_deref() {
        None => {
            let root = core.repo_path(&repo_id)?;
            let file = util::resolve_for_read(&root, &rel)?;
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
                return Ok(no_text(meta.len(), util::is_binary_content(&read_head_bytes(&file)?)));
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
                .read()
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
            core.git_for(&repo_id)?.args(["cat-file", "blob", oid]).read().run().await?.stdout
        }
    };
    let size = bytes.len() as u64;
    let utf16 = forced.is_some_and(|enc| enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE);
    if !utf16 && util::is_binary_content(&bytes) {
        return Ok(no_text(size, true));
    }
    let (text, encoding) = match forced {
        Some(enc) => util::decode_forced(&bytes, enc),
        None => util::decode_content(&bytes, &preferred),
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
    let rel = util::normalize_rel_path(&path)?;
    let root = core.repo_path(&repo_id)?;
    let target = util::resolve_for_write(&root, &rel)?;
    if target.is_dir() {
        return Err(CoreError::not_allowed(format!("“{rel}” is a folder.")));
    }
    let bytes = util::encode_content(&normalize_eol(&content, eol), &encoding)?;
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
mod line_history_tests;
#[cfg(test)]
mod tests;
