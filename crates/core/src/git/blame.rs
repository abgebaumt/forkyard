//! Streaming parsers for `git blame --porcelain` and `git blame --incremental`, fed line by line
//! (without `\n`).

use std::collections::HashMap;

use crate::git::rev;
use crate::util;

/// What porcelain tells about a commit; it comes only with the commit's first line.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct BlameInfo {
    pub author: String,
    /// Without the angle brackets.
    pub email: String,
    /// Author time, Unix seconds (0 if missing).
    pub time: i64,
    pub summary: String,
    /// The path in that commit as Git wrote it (quoted if Git had to quote it).
    pub filename: Option<String>,
}

/// A line of the file with the commit that last changed it.
pub(crate) struct BlamedLine<'a> {
    pub sha: &'a str,
    /// Line number in that commit and in the blamed file (1-based).
    pub orig_line: u32,
    pub final_line: u32,
    pub info: &'a BlameInfo,
    /// The content without the leading tab (still with a CR, if any).
    pub content: &'a [u8],
}

#[derive(Default)]
pub(crate) struct BlameParser {
    commits: HashMap<String, BlameInfo>,
    sha: String,
    orig_line: u32,
    final_line: u32,
}

impl BlameParser {
    /// Takes one line; a content line comes back with its commit.
    pub(crate) fn feed<'a>(&'a mut self, line: &'a [u8]) -> Option<BlamedLine<'a>> {
        if let Some(content) = line.strip_prefix(b"\t") {
            let info = self.commits.get(&self.sha)?;
            return Some(BlamedLine { sha: &self.sha, orig_line: self.orig_line, final_line: self.final_line, info, content });
        }
        let text = util::decode_lossy(line);
        let (key, value) = text.split_once(' ').unwrap_or((text.as_str(), ""));
        if rev::is_sha(key) {
            // "<sha> <line in original> <line in result> [<count>]"
            let mut numbers = value.split(' ').map(|n| n.parse::<u32>().ok());
            if let (Some(Some(orig)), Some(Some(fin))) = (numbers.next(), numbers.next()) {
                (self.orig_line, self.final_line) = (orig, fin);
                self.sha = key.to_string();
                self.commits.entry(self.sha.clone()).or_default();
                return None;
            }
        }
        set_detail(self.commits.get_mut(&self.sha)?, key, value);
        None
    }
}

/// Applies one "<key> <value>" line about a commit; unknown keys (`boundary`, `previous`, …) are ignored.
fn set_detail(info: &mut BlameInfo, key: &str, value: &str) {
    match key {
        "author" => info.author = value.to_string(),
        "author-mail" => info.email = value.trim_start_matches('<').trim_end_matches('>').to_string(),
        "author-time" => info.time = value.trim().parse().unwrap_or(0),
        "summary" => info.summary = value.to_string(),
        "filename" => info.filename = Some(value.to_string()),
        _ => {}
    }
}

/// A range of lines of the blamed file with the commit that last changed them.
pub(crate) struct IncrementalSpan<'a> {
    pub sha: &'a str,
    /// First line in the blamed file (1-based).
    pub final_start: u32,
    pub count: u32,
    pub info: &'a BlameInfo,
}

/// `git blame --incremental`: a header line per range, the commit's details only the first time,
/// and a `filename` line that ends every range.
#[derive(Default)]
pub(crate) struct IncrementalParser {
    commits: HashMap<String, BlameInfo>,
    /// sha, first line, count of the range being read.
    current: Option<(String, u32, u32)>,
}

impl IncrementalParser {
    /// Takes one line; the `filename` line that ends a range returns that range.
    pub(crate) fn feed<'a>(&'a mut self, line: &'a [u8]) -> Option<IncrementalSpan<'a>> {
        let text = util::decode_lossy(line);
        let (key, value) = text.split_once(' ').unwrap_or((text.as_str(), ""));
        if rev::is_sha(key) {
            // "<sha> <line in original> <line in result> <count>"
            let numbers: Vec<Option<u32>> = value.split(' ').map(|n| n.parse().ok()).collect();
            if let [Some(_), Some(start), Some(count)] = numbers[..] {
                self.commits.entry(key.to_string()).or_default();
                self.current = Some((key.to_string(), start, count));
                return None;
            }
        }
        let (sha, ..) = self.current.as_ref()?;
        set_detail(self.commits.get_mut(sha)?, key, value);
        if key != "filename" {
            return None;
        }
        let (sha, final_start, count) = self.current.take()?;
        let (sha, info) = self.commits.get_key_value(&sha)?;
        Some(IncrementalSpan { sha, final_start, count, info })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn details_come_once_and_content_lines_are_never_headers() {
        let a = "7c174286634dcf4ed0370cc763389e0867280331";
        let b = "a".repeat(64);
        let porcelain = format!(
            "{a} 1 1 2\nauthor Ada\nauthor-mail <ada@x>\nauthor-time 1735725600\nsummary eins\nfilename f.txt\n\tzeile\r\n\
             {a} 2 2\n\tauthor-time 7\n{b} 5 3 1\nauthor Ben\nauthor-time x\nsummary\nfilename \"q\\tx\"\n\t"
        );
        let mut parser = BlameParser::default();
        let mut seen = Vec::new();
        for line in porcelain.split('\n') {
            if let Some(l) = parser.feed(line.as_bytes()) {
                seen.push((l.sha.to_string(), l.orig_line, l.final_line, l.info.clone(), l.content.to_vec()));
            }
        }
        let ada = BlameInfo {
            author: "Ada".into(),
            email: "ada@x".into(),
            time: 1_735_725_600,
            summary: "eins".into(),
            filename: Some("f.txt".into()),
        };
        let ben = BlameInfo { author: "Ben".into(), filename: Some("\"q\\tx\"".into()), ..BlameInfo::default() };
        assert_eq!(
            seen,
            [
                (a.to_string(), 1, 1, ada.clone(), b"zeile\r".to_vec()),
                (a.to_string(), 2, 2, ada, b"author-time 7".to_vec()),
                (b.clone(), 5, 3, ben, Vec::new()),
            ]
        );
    }

    fn spans(input: &str) -> Vec<(String, u32, u32, BlameInfo)> {
        let mut parser = IncrementalParser::default();
        input
            .split('\n')
            .filter_map(|line| parser.feed(line.as_bytes()).map(|s| (s.sha.to_string(), s.final_start, s.count, s.info.clone())))
            .collect()
    }

    #[test]
    fn incremental_spans_carry_commit_details_once() {
        let a = "1".repeat(40);
        let b = "2".repeat(40);
        let input = format!(
            "{a} 1 1 2\nauthor A\nauthor-mail <a@x>\nauthor-time 100\nsummary S\nfilename f\n\
             {b} 3 3 1\nauthor B\nauthor-mail <b@x>\nauthor-time 200\nsummary T\nfilename f\n\
             {a} 5 4 1\nfilename f\n"
        );
        let ada = BlameInfo { author: "A".into(), email: "a@x".into(), time: 100, summary: "S".into(), filename: Some("f".into()) };
        let ben = BlameInfo { author: "B".into(), email: "b@x".into(), time: 200, summary: "T".into(), filename: Some("f".into()) };
        assert_eq!(spans(&input), [(a.clone(), 1, 2, ada.clone()), (b, 3, 1, ben), (a, 4, 1, ada)]);
    }

    #[test]
    fn boundary_and_previous_lines_are_not_spans() {
        let a = "3".repeat(40);
        let p = "4".repeat(40);
        let input = format!(
            "{a} 1 1 1\nauthor A\nsummary S\nboundary\nfilename f\n\
             {a} 2 2 3\nprevious {p} alt.txt\nboundary\nfilename f\n"
        );
        let got = spans(&input);
        assert_eq!(
            got.iter().map(|(s, start, count, _)| (s.as_str(), *start, *count)).collect::<Vec<_>>(),
            [(a.as_str(), 1, 1), (a.as_str(), 2, 3)]
        );
        assert_eq!((got[1].3.author.as_str(), got[1].3.summary.as_str()), ("A", "S"));
        // A detail line without a header before it is ignored.
        assert!(spans("filename f\nauthor X\n").is_empty());
    }
}
