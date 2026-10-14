//! Parsers for the two Git outputs of the statistics: `git log --numstat -z` (see `LOG_FORMAT`)
//! and `git blame --porcelain`. Bytes in, plain numbers out; paths are decoded lossily (they
//! are only shown and compared, never handed back to Git).
#![cfg_attr(not(test), allow(dead_code))]

use std::collections::HashMap;

use crate::util;

/// Marks the start of a commit in the output of `git log` (see `LOG_FORMAT`).
const COMMIT_MARK: &[u8] = b"\x01st\x01";
/// SHA, author name, author e-mail and author date as "<unix> <+hhmm>" (needs `--date=raw`).
pub(super) const LOG_FORMAT: &str = "--format=%x01st%x01%x00%H%x00%an%x00%ae%x00%ad%x00";
const HEADER_FIELDS: usize = 4;

/// One file of a commit (numstat). Binary files count with 0 lines; a rename under its new path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct FileDelta {
    pub path: String,
    pub added: u64,
    pub removed: u64,
}

/// A commit of the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct LogCommit {
    pub sha: String,
    pub name: String,
    pub email: String,
    /// Author time, Unix seconds.
    pub time: i64,
    /// UTC offset of the author in seconds (+0200 → 7200).
    pub offset: i32,
    pub files: Vec<FileDelta>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum Expect {
    /// Before the first commit.
    #[default]
    Mark,
    Header,
    /// numstat lines or the next commit.
    Body,
    /// A rename: the old path follows, then the new one.
    RenameOld,
    RenameNew,
}

/// State machine over the NUL-separated records of
/// `git log -z --numstat --date=raw <LOG_FORMAT>`. A commit is complete when the next one
/// starts (`feed` returns it) or the output ends (`finish`).
#[derive(Debug, Default)]
pub(super) struct LogParser {
    expect: Expect,
    header: Vec<Vec<u8>>,
    files: Vec<FileDelta>,
    /// Line counts of a rename whose paths are the next two records.
    rename: Option<(u64, u64)>,
}

impl LogParser {
    pub fn feed(&mut self, record: &[u8]) -> Option<LogCommit> {
        match self.expect {
            Expect::Header => {
                self.header.push(record.to_vec());
                if self.header.len() == HEADER_FIELDS {
                    self.expect = Expect::Body;
                }
                None
            }
            Expect::RenameOld => {
                self.expect = Expect::RenameNew;
                None
            }
            Expect::RenameNew => {
                if let Some((added, removed)) = self.rename.take() {
                    self.files.push(FileDelta { path: util::decode_lossy(record), added, removed });
                }
                self.expect = Expect::Body;
                None
            }
            Expect::Mark | Expect::Body => self.feed_body(record),
        }
    }

    fn feed_body(&mut self, record: &[u8]) -> Option<LogCommit> {
        // The numstat block starts with a line break after the format.
        let start = record.iter().position(|&b| b != b'\n').unwrap_or(record.len());
        let token = &record[start..];
        if token.is_empty() {
            return None;
        }
        if token == COMMIT_MARK {
            let done = self.take();
            self.expect = Expect::Header;
            return done;
        }
        if self.expect == Expect::Mark {
            return None;
        }
        let mut fields = token.splitn(3, |&b| b == b'\t');
        if let (Some(added), Some(removed), Some(path)) = (fields.next(), fields.next(), fields.next()) {
            // "-" for binary files.
            let count = |field: &[u8]| std::str::from_utf8(field).ok().and_then(|s| s.parse::<u64>().ok()).unwrap_or(0);
            let (added, removed) = (count(added), count(removed));
            if path.is_empty() {
                self.rename = Some((added, removed));
                self.expect = Expect::RenameOld;
            } else {
                self.files.push(FileDelta { path: util::decode_lossy(path), added, removed });
            }
        }
        None
    }

    fn take(&mut self) -> Option<LogCommit> {
        let header = std::mem::take(&mut self.header);
        let files = std::mem::take(&mut self.files);
        self.rename = None;
        if header.len() < HEADER_FIELDS {
            return None;
        }
        let text = |i: usize| util::decode_lossy(&header[i]);
        let (time, offset) = parse_raw_date(&text(3))?;
        Some(LogCommit { sha: text(0), name: text(1), email: text(2), time, offset, files })
    }

    /// The last commit at the end of the output.
    pub fn finish(mut self) -> Option<LogCommit> {
        self.take()
    }
}

/// "1735812000 -0500" → (1735812000, -18000). Anything else → `None`.
pub(super) fn parse_raw_date(text: &str) -> Option<(i64, i32)> {
    let (secs, zone) = text.trim().split_once(' ')?;
    let secs: i64 = secs.parse().ok()?;
    let sign = match zone.as_bytes().first()? {
        b'+' => 1,
        b'-' => -1,
        _ => return None,
    };
    let digits = &zone[1..];
    if digits.len() != 4 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let hours: i32 = digits[..2].parse().ok()?;
    let minutes: i32 = digits[2..].parse().ok()?;
    Some((secs, sign * (hours * 3600 + minutes * 60)))
}

/// Author time of every line of a file from `git blame --porcelain` (fed line by line, without
/// `\n`). The details of a commit only come with its first line; later lines only name the SHA.
#[derive(Debug, Default)]
pub(super) struct BlameAges {
    times: HashMap<String, i64>,
    current: String,
    /// One entry per line of the file, in order.
    pub lines: Vec<i64>,
}

impl BlameAges {
    pub fn feed(&mut self, line: &[u8]) {
        if line.first() == Some(&b'\t') {
            self.lines.push(self.times.get(&self.current).copied().unwrap_or(0));
            return;
        }
        let text = util::decode_lossy(line);
        let (key, value) = text.split_once(' ').unwrap_or((text.as_str(), ""));
        let is_sha = (key.len() == 40 || key.len() == 64) && key.bytes().all(|b| b.is_ascii_hexdigit());
        if is_sha && value.split(' ').count() >= 2 {
            self.current = key.to_string();
        } else if key == "author-time" {
            if let Ok(time) = value.trim().parse::<i64>() {
                self.times.insert(self.current.clone(), time);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What Git 2.53 writes for `git log --numstat -z -M --date=raw <LOG_FORMAT>`: a commit with a
    /// rename and a binary file, then the root commit.
    fn sample() -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(b"\x01st\x01\0bbbb\0Ben\0ben@example.com\x001735812000 -0500\0\0\n1\t0\t\0f.txt\0g.txt\0-\t-\tsrc/b.bin\0");
        out.extend_from_slice(b"\x01st\x01\0aaaa\0Ada\0ada@example.com\x001735725600 +0200\0\0\n3\t0\tf.txt\0");
        out
    }

    fn parse(bytes: &[u8]) -> Vec<LogCommit> {
        let mut parser = LogParser::default();
        let mut commits: Vec<LogCommit> = bytes.split(|&b| b == 0).filter_map(|record| parser.feed(record)).collect();
        commits.extend(parser.finish());
        commits
    }

    fn delta(path: &str, added: u64, removed: u64) -> FileDelta {
        FileDelta { path: path.into(), added, removed }
    }

    #[test]
    fn reads_commits_renames_and_binary_files() {
        let commits = parse(&sample());
        assert_eq!(commits.len(), 2);
        assert_eq!((commits[0].sha.as_str(), commits[0].name.as_str(), commits[0].email.as_str()), ("bbbb", "Ben", "ben@example.com"));
        assert_eq!((commits[0].time, commits[0].offset), (1_735_812_000, -18_000));
        assert_eq!(commits[0].files, [delta("g.txt", 1, 0), delta("src/b.bin", 0, 0)], "rename under the new path, binary with 0 lines");
        assert_eq!((commits[1].sha.as_str(), commits[1].offset), ("aaaa", 7_200));
        assert_eq!(commits[1].files, [delta("f.txt", 3, 0)]);
    }

    #[test]
    fn commits_without_files_and_text_before_the_first_commit() {
        let bytes = b"warning: noise\0\x01st\x01\0cccc\0Cleo\0cleo@example.com\x001700000000 +0000\0\0\x01st\x01\0dddd\0Dan\0\x001700000001 +0130\0\0\n2\t1\tx/\xffy.txt\0";
        let commits = parse(bytes);
        assert_eq!(commits.iter().map(|c| c.sha.as_str()).collect::<Vec<_>>(), ["cccc", "dddd"]);
        assert!(commits[0].files.is_empty());
        assert_eq!(commits[1].email, "", "a commit without an e-mail address");
        assert_eq!(commits[1].offset, 5_400);
        assert_eq!(commits[1].files, [delta("x/\u{fffd}y.txt", 2, 1)], "paths that are not UTF-8 are decoded lossily");
    }

    #[test]
    fn the_log_format_matches_the_parser() {
        assert!(LOG_FORMAT.starts_with("--format=%x01st%x01%x00"), "starts with the commit mark");
        assert_eq!(LOG_FORMAT.matches("%x00").count(), HEADER_FIELDS + 1, "mark plus one NUL per header field");
    }

    #[test]
    fn raw_dates() {
        assert_eq!(parse_raw_date("1 +0000"), Some((1, 0)));
        assert_eq!(parse_raw_date("-5 -0130"), Some((-5, -5_400)));
        assert_eq!(parse_raw_date("x +0000"), None);
        assert_eq!(parse_raw_date("1 0200"), None);
        assert_eq!(parse_raw_date("1 +02"), None);
        assert_eq!(parse_raw_date("1"), None);
    }

    #[test]
    fn blame_gives_the_author_time_of_every_line() {
        let porcelain = "\
7c174286634dcf4ed0370cc763389e0867280331 1 1 3
author A
author-mail <a@x>
author-time 1735725600
author-tz +0200
summary one
boundary
filename f.txt
\ta
7c174286634dcf4ed0370cc763389e0867280331 2 2
\tb
7c174286634dcf4ed0370cc763389e0867280331 3 3
\tc
dbebd63cd225ab9343885dde1bccedefaea20963 4 4 1
author A
author-time 1735812000
summary two
previous 7c174286634dcf4ed0370cc763389e0867280331 f.txt
filename g.txt
\td
";
        let mut ages = BlameAges::default();
        for line in porcelain.lines() {
            ages.feed(line.as_bytes());
        }
        assert_eq!(ages.lines, [1_735_725_600, 1_735_725_600, 1_735_725_600, 1_735_812_000]);
    }

    #[test]
    fn blame_with_sha256_and_a_line_that_looks_like_a_header() {
        let sha = "a".repeat(64);
        let mut ages = BlameAges::default();
        for line in [format!("{sha} 1 1 2"), "author-time 42".into(), "\tauthor-time 7".into(), format!("{sha} 2 2"), "\t".into()] {
            ages.feed(line.as_bytes());
        }
        assert_eq!(ages.lines, [42, 42], "content lines start with a tab and are never read as headers");
    }
}
