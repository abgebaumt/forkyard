//! The history of one line (`git log -L`).

use super::*;

// ---------------------------------------------------------------------------
// line_history
// ---------------------------------------------------------------------------

/// `line_history` returns at most this many steps.
pub const LINE_HISTORY_STEPS: u32 = 20;

/// The commits that shaped line `line` (1-based) of `path` at commit `sha`, newest first, at most
/// `LINE_HISTORY_STEPS` (`git log -L<n>,<n>:<path>`); follows renames. Each step names the file's path
/// and the line range in that commit. Pure read.
pub async fn line_history(core: &Core, repo_id: String, path: String, line: u32, sha: String) -> CoreResult<Vec<LineHistoryStep>> {
    Ok(line_history_with_diffs(core, &repo_id, &path, line, &sha).await?.into_iter().map(|(step, _)| step).collect())
}

/// `line_history` plus the change of the line range in each step: the ` `, `+` and `-` lines of its
/// hunks without headers, `\ No newline` notes and CR, decoded like blame lines. For the line
/// archaeology; the output holds file contents and is never logged.
pub(crate) async fn line_history_with_diffs(
    core: &Core,
    repo_id: &str,
    path: &str,
    line: u32,
    sha: &str,
) -> CoreResult<Vec<(LineHistoryStep, Vec<String>)>> {
    let rel = util::normalize_rel_path(path)?;
    if line == 0 {
        return Err(CoreError::not_allowed("Lines are counted from 1."));
    }
    let commit = rev::resolve_commit(core, repo_id, sha).await?;
    let out = core
        .git_for(repo_id)?
        .args(["-c", "core.quotePath=false", "log"])
        .args(LOG_SAFE)
        .args(["--no-decorate", "--no-color", "--no-ext-diff", "-z"])
        .arg(format!("--max-count={LINE_HISTORY_STEPS}"))
        .arg(gitlog::marked_format(HEADER))
        .arg(format!("-L{line},{line}:{rel}"))
        .arg(&commit)
        .arg("--")
        .read()
        .run_raw()
        .await?;
    if !out.success() {
        let text = out.stderr_text();
        if text.contains("has only") || text.contains("no path") {
            return Err(CoreError::not_found(format!("Line {line} of “{rel}” doesn’t exist at this commit.")).with_git_output(text));
        }
        return Err(crate::git::errors::classify("log", out.code, &out.stdout, &out.stderr));
    }
    Ok(parse_line_records(&out.stdout, &rel, &repo_encoding(core, repo_id)))
}

/// The records of `git log -L` with `marked_format(HEADER)`: header fields, then the diff of the line
/// range. The mark stands at a line start, where a diff line never begins with 0x1e.
pub(super) fn parse_line_records(stdout: &[u8], newest_path: &str, preferred: &str) -> Vec<(LineHistoryStep, Vec<String>)> {
    let mut steps = Vec::new();
    let mut last_path = newest_path.to_string();
    let mut starts: Vec<usize> =
        stdout.windows(gitlog::MARK.len()).enumerate().filter(|(_, window)| *window == gitlog::MARK).map(|(index, _)| index).collect();
    starts.push(stdout.len());
    for pair in starts.windows(2) {
        let record = &stdout[pair[0] + gitlog::MARK.len()..pair[1]];
        let record = record.strip_prefix(b"\0").unwrap_or(record);
        let mut fields = record.splitn(HEADER_FIELDS + 1, |&byte| byte == 0);
        let header: Vec<&[u8]> = (0..HEADER_FIELDS).filter_map(|_| fields.next()).collect();
        if header.len() < HEADER_FIELDS {
            continue;
        }
        let diff = fields.next().unwrap_or_default();
        let Some((path, start, count)) = hunk_of(diff) else { continue };
        let path = path.unwrap_or_else(|| last_path.clone());
        last_path = path.clone();
        let step = LineHistoryStep {
            commit: gitlog::summary(&header),
            path,
            start_line: start,
            end_line: if count == 0 { start } else { start + count - 1 },
        };
        steps.push((step, hunk_lines(diff, preferred)));
    }
    steps
}

/// The ` `, `+` and `-` lines after the first `@@` header (later headers are skipped); without CR.
pub(super) fn hunk_lines(diff: &[u8], preferred: &str) -> Vec<String> {
    let mut lines = Vec::new();
    let mut inside = false;
    for raw in diff.split(|&byte| byte == b'\n') {
        let raw = raw.strip_prefix(b"\0").unwrap_or(raw);
        if raw.starts_with(b"@@ ") {
            inside = true;
            continue;
        }
        if inside && matches!(raw.first(), Some(b' ' | b'+' | b'-')) {
            let content = raw.strip_suffix(b"\r").unwrap_or(raw);
            lines.push(util::decode_line(content, preferred));
        }
    }
    lines
}

/// Path (`+++ b/…`; `None` if Git quoted it) and the new range (`+c,d`) of the first hunk.
pub(super) fn hunk_of(diff: &[u8]) -> Option<(Option<String>, u32, u32)> {
    let mut path = None;
    for line in diff.split(|&byte| byte == b'\n') {
        let line = line.strip_prefix(b"\0").unwrap_or(line);
        if let Some(rest) = line.strip_prefix(b"+++ ") {
            path = rest
                .strip_prefix(b"b/")
                .filter(|name| !name.starts_with(b"\""))
                .map(|name| util::decode_lossy(name).trim_end_matches('\t').to_string());
        } else if line.starts_with(b"@@ ") {
            let hunk = crate::commands::diff::patch::parse_hunk_header(line)?;
            return Some((path, hunk.new_start, hunk.new_lines));
        }
    }
    None
}
