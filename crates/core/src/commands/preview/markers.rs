//! Conflict markers in a merged blob (`git merge-tree --write-tree` leaves them in the result
//! tree): where each conflict sits and what both sides wrote.
//!
//! Line numbers count the file as the first side ("ours") sees it: lines outside conflicts and
//! the first side's lines. Marker lines, the base section of the diff3 style (`|||||||`) and the
//! second side do not count. A conflict whose first side is empty is reported at the line before
//! it (1 at the top of the file). Markers are runs of at least seven characters (the attribute
//! `conflict-marker-size` makes them longer; a block keeps the length of its `<` run); a block
//! that never ends is ignored. Bytes stay bytes (CRLF, Latin-1).

use crate::model::LineRange;

/// Shortest marker run Git writes.
pub const MIN_MARKER: usize = 7;

/// One conflict: its lines in the first side's numbering and the raw bytes of both sides.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MarkerBlock {
    pub range: LineRange,
    pub ours: Vec<u8>,
    pub theirs: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Section {
    Outside,
    Ours,
    Base,
    Theirs,
}

/// Length of the marker run of `ch` that makes up `line` (without its line break): the run, then
/// the end of the line or – with `label` – a space. `exact`: the run must have this length.
fn marker(line: &[u8], ch: u8, exact: Option<usize>, label: bool) -> Option<usize> {
    let line = line.strip_suffix(b"\r").unwrap_or(line);
    let run = line.iter().take_while(|&&c| c == ch).count();
    if run < MIN_MARKER || exact.is_some_and(|size| size != run) {
        return None;
    }
    match line.get(run) {
        None => Some(run),
        Some(b' ') if label => Some(run),
        _ => None,
    }
}

/// Every complete conflict of the merged `blob`, in order.
pub fn blocks(blob: &[u8]) -> Vec<MarkerBlock> {
    let mut out = Vec::new();
    let mut section = Section::Outside;
    // Lines of the first side's view so far, and where the current block started.
    let mut line_no: u32 = 0;
    let mut before: u32 = 0;
    let mut size = MIN_MARKER;
    let mut ours: Vec<u8> = Vec::new();
    let mut ours_lines: u32 = 0;
    let mut theirs: Vec<u8> = Vec::new();
    for line in blob.split_inclusive(|&b| b == b'\n') {
        let content = line.strip_suffix(b"\n").unwrap_or(line);
        match section {
            Section::Outside => {
                if let Some(run) = marker(content, b'<', None, true) {
                    size = run;
                    before = line_no;
                    ours.clear();
                    theirs.clear();
                    ours_lines = 0;
                    section = Section::Ours;
                } else {
                    line_no += 1;
                }
            }
            Section::Ours => {
                if marker(content, b'|', Some(size), true).is_some() {
                    section = Section::Base;
                } else if marker(content, b'=', Some(size), false).is_some() {
                    section = Section::Theirs;
                } else {
                    ours.extend_from_slice(line);
                    ours_lines += 1;
                    line_no += 1;
                }
            }
            Section::Base => {
                if marker(content, b'=', Some(size), false).is_some() {
                    section = Section::Theirs;
                }
            }
            Section::Theirs => {
                if marker(content, b'>', Some(size), true).is_some() {
                    let range = if ours_lines == 0 {
                        let at = before.max(1);
                        LineRange { start: at, end: at }
                    } else {
                        LineRange { start: before + 1, end: before + ours_lines }
                    };
                    out.push(MarkerBlock { range, ours: std::mem::take(&mut ours), theirs: std::mem::take(&mut theirs) });
                    section = Section::Outside;
                } else {
                    theirs.extend_from_slice(line);
                }
            }
        }
    }
    out
}

/// Only the line ranges of `blocks`.
pub fn ranges(blob: &[u8]) -> Vec<LineRange> {
    blocks(blob).into_iter().map(|block| block.range).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn range(start: u32, end: u32) -> LineRange {
        LineRange { start, end }
    }

    #[test]
    fn marker_blocks_count_the_first_sides_lines() {
        // CRLF, two blocks, the second with an empty first side, a last line without a line break.
        let blob = b"eins\r\n<<<<<<< ours\r\nA1\r\nA2\r\n=======\r\nB1\r\n>>>>>>> theirs\r\nmitte\r\n<<<<<<< ours\r\n=======\r\nB2\r\n>>>>>>> theirs\r\nende";
        assert_eq!(
            blocks(blob),
            vec![
                MarkerBlock { range: range(2, 3), ours: b"A1\r\nA2\r\n".to_vec(), theirs: b"B1\r\n".to_vec() },
                MarkerBlock { range: range(4, 4), ours: Vec::new(), theirs: b"B2\r\n".to_vec() },
            ]
        );
        assert_eq!(ranges(blob), vec![range(2, 3), range(4, 4)]);
        // An empty first side at the very top is reported at line 1.
        assert_eq!(ranges(b"<<<<<<< a\n=======\nneu\n>>>>>>> b\nrest\n"), vec![range(1, 1)]);
    }

    #[test]
    fn diff3_sections_and_longer_markers_are_understood() {
        // Marker size 9: the seven '=' inside the first side are text, not the separator.
        let blob = b"<<<<<<<<< ours\nX\n=======\n||||||||| base\nO\n=========\nY\n>>>>>>>>> theirs\nnach\n";
        assert_eq!(blocks(blob), vec![MarkerBlock { range: range(1, 2), ours: b"X\n=======\n".to_vec(), theirs: b"Y\n".to_vec() }]);
        let diff3 = b"vor\n<<<<<<< a\nneu a\n||||||| basis\nalt\n=======\nneu b\n>>>>>>> b\n";
        assert_eq!(blocks(diff3), vec![MarkerBlock { range: range(2, 2), ours: b"neu a\n".to_vec(), theirs: b"neu b\n".to_vec() }]);
    }

    #[test]
    fn text_that_only_looks_like_markers_is_no_conflict() {
        assert!(blocks(b"<<<<<<<x\n=======\n>>>>>>>\n").is_empty());
        assert!(blocks(b"<<<<<< sechs\nX\n======\nY\n>>>>>> sechs\n").is_empty());
        assert!(blocks(b"a <<<<<<< b\n").is_empty());
        // A block that never ends.
        assert!(blocks(b"<<<<<<< a\nX\n=======\nY\n").is_empty());
        assert!(blocks(b"").is_empty());
    }

    #[test]
    fn bytes_stay_bytes_and_huge_files_keep_exact_numbers() {
        let latin1 = b"caf\xe9\n<<<<<<< a\n\xe4\n=======\n\xf6\n>>>>>>> b\n";
        assert_eq!(blocks(latin1), vec![MarkerBlock { range: range(2, 2), ours: b"\xe4\n".to_vec(), theirs: b"\xf6\n".to_vec() }]);
        let mut huge = Vec::new();
        for n in 1..=10_000 {
            huge.extend_from_slice(format!("zeile {n}\n").as_bytes());
        }
        huge.extend_from_slice(b"<<<<<<< a\n");
        for n in 1..=500 {
            huge.extend_from_slice(format!("a {n}\n").as_bytes());
        }
        huge.extend_from_slice(b"=======\nb\n>>>>>>> b\n");
        for n in 1..=100 {
            huge.extend_from_slice(format!("rest {n}\n").as_bytes());
        }
        huge.extend_from_slice(b"<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n");
        assert_eq!(ranges(&huge), vec![range(10_001, 10_500), range(10_601, 10_601)]);
    }
}
