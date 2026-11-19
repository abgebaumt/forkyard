//! Blame of a file, also for uncommitted changes.

use super::*;

// ---------------------------------------------------------------------------
// file_blame
// ---------------------------------------------------------------------------

/// `git blame --porcelain`; `sha: None` = working directory including uncommitted lines
/// (`uncommitted: true`). A file that does not exist in HEAD yet comes back entirely as
/// "not committed". Binary file → `unsupported`; unknown path → `not_found`.
///
/// `encoding` sets the encoding for this one call (otherwise: UTF-8, falling back to the
/// repository's default).
pub async fn file_blame(
    core: &Core,
    repo_id: String,
    path: String,
    sha: Option<String>,
    encoding: Option<String>,
) -> CoreResult<Vec<BlameLine>> {
    let target = match blame_source(core, &repo_id, &path, sha.as_deref(), encoding.as_deref()).await? {
        BlameSource::Ready(lines) => return Ok(lines),
        BlameSource::Git(target) => target,
    };
    let mut cmd = core.git_for(&repo_id)?.args(["blame", "--porcelain"]);
    if let Some(rev) = &target.rev {
        cmd = cmd.arg(rev);
    }
    let mut parser = BlameParser::new(&target.preferred, target.forced);
    cmd.args(["--", target.rel.as_str()])
        .read_only()
        .run_records(b'\n', None, &mut |line| {
            parser.feed(line);
            true
        })
        .await?;
    Ok(parser.lines)
}

/// What a blame shows: lines that need no Git (a file HEAD does not know), or what Git blames.
pub(crate) enum BlameSource {
    Ready(Vec<BlameLine>),
    Git(BlameTarget),
}

/// A checked file for `git blame`.
pub(crate) struct BlameTarget {
    /// Normalised path relative to the repository.
    pub rel: String,
    /// The checked revision; `None` = working directory.
    pub rev: Option<String>,
    /// The file on disk (working directory only).
    pub file: Option<PathBuf>,
    /// The repository's encoding (`repo_encoding`).
    pub preferred: String,
    /// Encoding given by the call; otherwise it is guessed per line.
    pub forced: Option<&'static encoding_rs::Encoding>,
}

/// The checks of `file_blame` (path, encoding, revision, existence, binary, size).
pub(crate) async fn blame_source(
    core: &Core,
    repo_id: &str,
    path: &str,
    sha: Option<&str>,
    encoding: Option<&str>,
) -> CoreResult<BlameSource> {
    let rel = util::normalize_rel_path(path)?;
    let forced = util::forced_encoding(encoding)?;
    let preferred = repo_encoding(core, repo_id);
    let binary = || CoreError::unsupported(format!("“{rel}” is a binary file; blame is only available for text files."));
    let too_large = || CoreError::unsupported(format!("“{rel}” is too large for blame."));
    let (rev, file) = match sha {
        Some(sha) => {
            let rev = check_rev(sha)?;
            let spec = format!("{rev}:{rel}");
            let is_binary = blob_looks_binary(core, repo_id, &spec).await.map_err(|e| match e.code {
                ErrorCode::NotFound | ErrorCode::Unknown => {
                    CoreError::not_found(format!("The file “{rel}” does not exist in commit {}.", short_rev(rev)))
                        .with_git_output(e.git_output.unwrap_or_default())
                }
                _ => e,
            })?;
            if is_binary {
                return Err(binary());
            }
            let size = core.git_for(repo_id)?.args(["cat-file", "-s", &spec]).read().run_raw().await?;
            if String::from_utf8_lossy(&size.stdout).trim().parse::<u64>().is_ok_and(|n| n > MAX_TEXT_BYTES) {
                return Err(too_large());
            }
            (Some(rev.to_string()), None)
        }
        None => {
            let root = core.repo_path(repo_id)?;
            let file = util::resolve_for_read(&root, &rel)?;
            if !file.is_file() {
                return Err(CoreError::not_found(format!("The file “{rel}” does not exist in the working directory.")));
            }
            if util::is_binary_content(&read_head_bytes(&file)?) {
                return Err(binary());
            }
            if file.metadata()?.len() > MAX_TEXT_BYTES {
                return Err(too_large());
            }
            let in_head = core.git_for(repo_id)?.args(["cat-file", "-e", &format!("HEAD:{rel}")]).read().run_raw().await?.success();
            if !in_head {
                return uncommitted_file(&file, &rel, &preferred, forced).map(BlameSource::Ready);
            }
            (None, Some(file))
        }
    };
    Ok(BlameSource::Git(BlameTarget { rel, rev, file, preferred, forced }))
}

/// Whether a blob is binary without reading it completely: Git is stopped as soon as the first NUL byte arrives.
pub(crate) async fn blob_looks_binary(core: &Core, repo_id: &str, spec: &str) -> CoreResult<bool> {
    let mut nul_in_head = false;
    let out = core
        .git_for(repo_id)?
        .args(["cat-file", "blob", spec])
        .read()
        .run_records(0, None, &mut |before_nul| {
            nul_in_head = before_nul.len() < 8000;
            false
        })
        .await?;
    // Without a NUL Git runs to the end normally (code = 0); only an early NUL counts.
    Ok(out.code.is_none() && nul_in_head)
}

/// The first 8000 bytes of a file (for binary detection).
pub(super) fn read_head_bytes(file: &Path) -> CoreResult<Vec<u8>> {
    use std::io::Read;
    let mut head = Vec::with_capacity(8000);
    std::fs::File::open(file)?.take(8000).read_to_end(&mut head)?;
    Ok(head)
}

pub(super) const ZERO_AUTHOR: &str = "Not committed yet";
pub(super) const ZERO_SUMMARY: &str = "Uncommitted changes";

pub(super) fn zero_sha(len: usize) -> String {
    "0".repeat(len)
}

/// Blame of a file HEAD does not know (new or untracked): every line is "not committed".
pub(super) fn uncommitted_file(
    file: &Path,
    rel: &str,
    preferred: &str,
    forced: Option<&'static encoding_rs::Encoding>,
) -> CoreResult<Vec<BlameLine>> {
    let size = file.metadata()?.len();
    if size > MAX_TEXT_BYTES {
        return Err(CoreError::unsupported(format!("“{rel}” is too large for blame.")));
    }
    let bytes = std::fs::read(file)?;
    let (text, _) = match forced {
        Some(enc) => util::decode_forced(&bytes, enc),
        None => util::decode_content(&bytes, preferred),
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

/// A line's text (without `\n` and `\r`) as blame shows it: the forced encoding, or guessed per line.
pub(super) fn decode_blame_line(content: &[u8], preferred: &str, forced: Option<&'static encoding_rs::Encoding>) -> String {
    match forced {
        Some(enc) => enc.decode_without_bom_handling(content).0.into_owned(),
        None => util::decode_line(content, preferred),
    }
}

/// `git blame --porcelain` (see `git::blame::BlameParser`) into `BlameLine`s.
pub(super) struct BlameParser {
    pub(super) porcelain: crate::git::blame::BlameParser,
    pub(super) preferred: String,
    /// Encoding given by the call; otherwise it is guessed per line.
    pub(super) forced: Option<&'static encoding_rs::Encoding>,
    pub(super) lines: Vec<BlameLine>,
}

impl BlameParser {
    pub(super) fn new(preferred: &str, forced: Option<&'static encoding_rs::Encoding>) -> Self {
        BlameParser { porcelain: Default::default(), preferred: preferred.to_string(), forced, lines: Vec::new() }
    }

    pub(super) fn feed(&mut self, line: &[u8]) {
        let Some(blamed) = self.porcelain.feed(line) else { return };
        let content = blamed.content.strip_suffix(b"\r").unwrap_or(blamed.content);
        let uncommitted = blamed.sha.bytes().all(|b| b == b'0');
        let (author, summary) = if uncommitted {
            (Person { name: ZERO_AUTHOR.into(), email: String::new() }, ZERO_SUMMARY.to_string())
        } else {
            (Person { name: blamed.info.author.clone(), email: blamed.info.email.clone() }, blamed.info.summary.clone())
        };
        self.lines.push(BlameLine {
            line_no: blamed.final_line,
            text: decode_blame_line(content, &self.preferred, self.forced),
            sha: blamed.sha.to_string(),
            author,
            authored_at: util::unix_to_iso(blamed.info.time),
            summary,
            uncommitted,
        });
    }
}
