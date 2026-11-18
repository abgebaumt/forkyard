//! One streaming parser for `git blame --porcelain`, fed line by line (without `\n`).

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
        let info = self.commits.get_mut(&self.sha)?;
        match key {
            "author" => info.author = value.to_string(),
            "author-mail" => info.email = value.trim_start_matches('<').trim_end_matches('>').to_string(),
            "author-time" => info.time = value.trim().parse().unwrap_or(0),
            "summary" => info.summary = value.to_string(),
            "filename" => info.filename = Some(value.to_string()),
            _ => {}
        }
        None
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
}
