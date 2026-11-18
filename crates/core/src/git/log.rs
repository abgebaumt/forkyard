//! Reading `git log -z`: the switches every log call needs, the shared commit header, a field
//! collector for plain formats and one streaming parser for logs with `--numstat` and `--raw`.

use crate::model::{CommitSummary, Person};
use crate::util;

/// Switches for every `git log`: the user's configuration (`log.showSignature`,
/// `i18n.logOutputEncoding`) must not change the output.
pub(crate) const LOG_SAFE: [&str; 2] = ["--no-show-signature", "--encoding=UTF-8"];

/// SHA, parents, author name, author e-mail, author time (Unix) and subject, NUL-separated.
pub(crate) const HEADER: &str = "%H%x00%P%x00%an%x00%ae%x00%at%x00%s";
pub(crate) const HEADER_FIELDS: usize = 6;

/// The commit described by the first `HEADER_FIELDS` fields.
pub(crate) fn summary<F: AsRef<[u8]>>(fields: &[F]) -> CommitSummary {
    let text = |i: usize| util::decode_text(fields[i].as_ref()).0;
    CommitSummary {
        sha: util::decode_lossy(fields[0].as_ref()),
        parents: text(1).split_whitespace().map(str::to_string).collect(),
        author: Person { name: text(2), email: text(3) },
        authored_at: util::unix_to_iso(text(4).trim().parse().unwrap_or(0)),
        summary: text(5),
    }
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

/// Starts a commit in the output of `marked_format`. Only a whole record is compared, and only
/// where a numstat or raw line could stand, so a path or message never looks like it.
pub(crate) const MARK: &[u8] = b"\x1e\x1efy\x1e";

/// `--format=` for `LogParser`: the mark, then `fields` (NUL-separated), each NUL-terminated.
pub(crate) fn marked_format(fields: &str) -> String {
    format!("--format=%x1e%x1efy%x1e%x00{fields}%x00")
}

/// One `--numstat` line; the counts are `None` for a binary file.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct FileStat {
    pub path: Vec<u8>,
    /// The old path of a rename or copy (`-M`/`-C`).
    pub old_path: Option<Vec<u8>>,
    pub added: Option<u64>,
    pub deleted: Option<u64>,
}

/// One `--raw` line: the status letter and the path (two paths for a rename or copy).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct RawChange {
    pub status: u8,
    pub path: Vec<u8>,
    pub old_path: Option<Vec<u8>>,
}

/// A commit of the log: its header fields and the changed files.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct LogCommit {
    pub header: Vec<Vec<u8>>,
    pub files: Vec<FileStat>,
    pub raw: Vec<RawChange>,
}

enum Row {
    Stat(FileStat),
    Raw(RawChange),
}

/// A row whose paths are the next records.
struct Open {
    row: Row,
    paths: Vec<Vec<u8>>,
    wanted: usize,
}

impl Open {
    fn close(mut self) -> Row {
        let path = self.paths.pop().unwrap_or_default();
        let old = self.paths.pop();
        match &mut self.row {
            Row::Stat(stat) => (stat.path, stat.old_path) = (path, old),
            Row::Raw(raw) => (raw.path, raw.old_path) = (path, old),
        }
        self.row
    }
}

/// State machine over the NUL-separated records of `git log -z [--numstat] [--raw]
/// <marked_format(..)>` with `width` header fields. A commit is complete when the next one
/// starts (`feed` returns it) or the output ends (`finish`). Anything before the first mark is skipped.
pub(crate) struct LogParser {
    width: usize,
    commit: Option<LogCommit>,
    open: Option<Open>,
}

impl LogParser {
    pub(crate) fn new(width: usize) -> Self {
        LogParser { width, commit: None, open: None }
    }

    pub(crate) fn feed(&mut self, record: &[u8]) -> Option<LogCommit> {
        if let Some(open) = self.open.as_mut() {
            open.paths.push(record.to_vec());
            if open.paths.len() == open.wanted {
                let row = self.open.take().map(Open::close);
                if let Some(commit) = self.commit.as_mut() {
                    match row {
                        Some(Row::Stat(stat)) => commit.files.push(stat),
                        Some(Row::Raw(raw)) => commit.raw.push(raw),
                        None => {}
                    }
                }
            }
            return None;
        }
        if let Some(commit) = self.commit.as_mut() {
            if commit.header.len() < self.width {
                commit.header.push(record.to_vec());
                return None;
            }
        }
        // The diff part starts with a line break after the format.
        let start = record.iter().position(|&b| b != b'\n').unwrap_or(record.len());
        let token = &record[start..];
        if token == MARK {
            return self.commit.replace(LogCommit::default());
        }
        let commit = self.commit.as_mut()?;
        if token.first() == Some(&b':') {
            // ":<mode> <mode> <blob> <blob> <status>[score]", then the path or two paths.
            let status = token.rsplit(|&b| b == b' ').next().and_then(|s| s.first().copied()).unwrap_or(b'M');
            let wanted = if matches!(status, b'R' | b'C') { 2 } else { 1 };
            self.open = Some(Open { row: Row::Raw(RawChange { status, ..RawChange::default() }), paths: Vec::new(), wanted });
            return None;
        }
        if let Some(stat) = numstat_row(token) {
            if stat.path.is_empty() {
                // A rename: old and new path follow as records of their own.
                self.open = Some(Open { row: Row::Stat(stat), paths: Vec::new(), wanted: 2 });
            } else {
                commit.files.push(stat);
            }
        }
        None
    }

    /// The last commit at the end of the output (only with a complete header).
    pub(crate) fn finish(self) -> Option<LogCommit> {
        self.commit.filter(|commit| commit.header.len() == self.width)
    }

    /// `feed` that drops commits with an incomplete header (output cut off or noise).
    pub(crate) fn feed_complete(&mut self, record: &[u8]) -> Option<LogCommit> {
        let width = self.width;
        self.feed(record).filter(|commit| commit.header.len() == width)
    }
}

/// All commits of a whole `git log -z` output (see `LogParser`).
pub(crate) fn parse_log(bytes: &[u8], width: usize) -> Vec<LogCommit> {
    let mut parser = LogParser::new(width);
    let mut commits: Vec<LogCommit> = bytes.split(|&b| b == 0).filter_map(|record| parser.feed_complete(record)).collect();
    commits.extend(parser.finish());
    commits
}

/// "<added>\t<deleted>\t<path>"; "-" counts (binary) are `None`, an empty path means a rename.
fn numstat_row(token: &[u8]) -> Option<FileStat> {
    let mut fields = token.splitn(3, |&b| b == b'\t');
    let (added, deleted, path) = (fields.next()?, fields.next()?, fields.next()?);
    let count = |field: &[u8]| std::str::from_utf8(field).ok()?.trim().parse::<u64>().ok();
    Some(FileStat { path: path.to_vec(), old_path: None, added: count(added), deleted: count(deleted) })
}

/// `git diff --numstat -z` or `git apply --numstat -z`: one entry per file.
pub(crate) fn parse_numstat(bytes: &[u8]) -> Vec<FileStat> {
    let mut parser = LogParser::new(0);
    parser.commit = Some(LogCommit::default());
    for record in util::split_z(bytes) {
        parser.feed(record);
    }
    parser.commit.map(|commit| commit.files).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stat(path: &str, old: Option<&str>, added: Option<u64>, deleted: Option<u64>) -> FileStat {
        FileStat { path: path.into(), old_path: old.map(|o| o.into()), added, deleted }
    }

    #[test]
    fn the_format_has_the_mark_and_one_nul_per_field() {
        assert_eq!(marked_format("%H%x00%s"), "--format=%x1e%x1efy%x1e%x00%H%x00%s%x00");
        assert_eq!(HEADER.matches("%x00").count() + 1, HEADER_FIELDS);
    }

    #[test]
    fn numstat_with_renames_binaries_and_odd_names() {
        let rows = parse_numstat(b"3\t1\tein pfad.txt\0-\t-\tbild.png\x000\t0\t\0alt.txt\0neu.txt\x0012\t0\tletzte\0");
        assert_eq!(
            rows,
            [
                stat("ein pfad.txt", None, Some(3), Some(1)),
                stat("bild.png", None, None, None),
                stat("neu.txt", Some("alt.txt"), Some(0), Some(0)),
                stat("letzte", None, Some(12), Some(0)),
            ]
        );
        assert!(parse_numstat(b"").is_empty());
    }

    /// The shape of `git log -z --raw --numstat <marked_format(..)>` (Git 2.53): header fields, then
    /// after a newline the raw lines, the numstat lines, an empty record between commits.
    #[test]
    fn log_with_raw_numstat_renames_and_odd_records() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"noise\0");
        bytes.extend_from_slice(b"\x1e\x1efy\x1e\0aaaa\0Body \x1e\x1efy\x1e inside\0\0");
        bytes.extend_from_slice(
            b"\x1e\x1efy\x1e\0bbbb\0\0\n:100644 100644 1 2 R090\0alt.txt\0neu.txt\0:000000 100644 0 1 A\0\x1e\x1efy\x1e\0",
        );
        bytes.extend_from_slice(b"3\t1\t\0alt.txt\0neu.txt\0-\t-\t\x1e\x1efy\x1e\0\0");
        bytes.extend_from_slice(b"\x1e\x1efy\x1e\0cccc\0last\0\n1\t0\t-lead.txt\0");
        let commits = parse_log(&bytes, 2);
        assert_eq!(commits.len(), 3);
        assert_eq!(commits[0].header, [b"aaaa".to_vec(), b"Body \x1e\x1efy\x1e inside".to_vec()], "a field never starts a commit");
        assert!(commits[0].files.is_empty() && commits[0].raw.is_empty());
        assert_eq!(
            commits[1].raw,
            [
                RawChange { status: b'R', path: b"neu.txt".to_vec(), old_path: Some(b"alt.txt".to_vec()) },
                RawChange { status: b'A', path: MARK.to_vec(), old_path: None },
            ],
            "a path that looks like the mark is a path"
        );
        assert_eq!(
            commits[1].files,
            [stat("neu.txt", Some("alt.txt"), Some(3), Some(1)), FileStat { path: MARK.to_vec(), ..FileStat::default() }]
        );
        assert_eq!(commits[2].files, [stat("-lead.txt", None, Some(1), Some(0))]);
        assert!(parse_log(b"\x1e\x1efy\x1e\0only-one-field", 2).is_empty(), "a cut-off header is no commit");
    }

    #[test]
    fn summary_from_the_header() {
        let fields: [&[u8]; 6] = [b"aaaa", b"bbbb cccc", b"Ada", b"ada@example.com", b"60", b"Hallo \xe4"];
        let commit = summary(&fields);
        assert_eq!((commit.sha.as_str(), commit.parents.as_slice()), ("aaaa", ["bbbb".to_string(), "cccc".to_string()].as_slice()));
        assert_eq!((commit.author.name.as_str(), commit.authored_at.as_str()), ("Ada", "1970-01-01T00:01:00.000Z"));
        assert_eq!(commit.summary, "Hallo ä", "legacy Latin-1 is guessed");
    }
}
