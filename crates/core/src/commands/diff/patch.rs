//! Parse Git's unified diffs and build partial patches for hunks and individual lines.
//!
//! Everything works on bytes: line contents are never decoded, a `\r` before the
//! line end belongs to the content, and "\ No newline at end of file" is a property of the
//! line before it. That way CRLF, mixed line endings and non-UTF-8 arrive unchanged in
//! the index or in the working directory.
//!
//! ```ignore
//! let files = patch::parse_diff(&git_diff_output);
//! let patch = patch::build_patch(&files[0], b"src/a b.txt", &selection.hunks, Direction::Forward)?;
//! // → `git apply --cached` (Forward) or `git apply -R` (Reverse)
//! ```

use crate::error::{CoreError, CoreResult};
use crate::model::HunkSelection;

const NO_NEWLINE_MARKER: &[u8] = b"\\ No newline at end of file\n";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineKind {
    Context,
    Add,
    Remove,
}

/// One line of a hunk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PatchLine {
    pub kind: LineKind,
    /// Content without the trailing `\n`; a `\r` before it belongs to the content.
    pub content: Vec<u8>,
    /// This line is followed by "\ No newline at end of file".
    pub no_newline: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PatchHunk {
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    /// Text after the second `@@`.
    pub section: Vec<u8>,
    pub lines: Vec<PatchLine>,
}

/// One `diff --git …` section from the output of `git diff`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FilePatch {
    pub old_mode: Option<String>,
    pub new_mode: Option<String>,
    /// `new file mode` – the old side is `/dev/null`.
    pub is_new: bool,
    /// `deleted file mode` – the new side is `/dev/null`.
    pub is_deleted: bool,
    pub is_rename: bool,
    /// Blob IDs from the `index a..b` line.
    pub old_id: Option<String>,
    pub new_id: Option<String>,
    /// Git reported the file as binary; then there are no hunks.
    pub binary: bool,
    pub hunks: Vec<PatchHunk>,
}

impl FilePatch {
    /// The new side of a hunk as bytes (context and "+" lines).
    pub fn new_side(hunk: &PatchHunk) -> Vec<u8> {
        side(hunk, LineKind::Add)
    }

    /// The old side of a hunk as bytes (context and "−" lines).
    pub fn old_side(hunk: &PatchHunk) -> Vec<u8> {
        side(hunk, LineKind::Remove)
    }
}

fn side(hunk: &PatchHunk, own: LineKind) -> Vec<u8> {
    let mut out = Vec::new();
    for line in hunk.lines.iter().filter(|l| l.kind == LineKind::Context || l.kind == own) {
        out.extend_from_slice(&line.content);
        if !line.no_newline {
            out.push(b'\n');
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

struct Lines<'a> {
    rest: &'a [u8],
}

impl<'a> Lines<'a> {
    fn peek(&self) -> Option<&'a [u8]> {
        if self.rest.is_empty() {
            return None;
        }
        let end = self.rest.iter().position(|&b| b == b'\n').unwrap_or(self.rest.len());
        Some(&self.rest[..end])
    }
}

impl<'a> Iterator for Lines<'a> {
    type Item = &'a [u8];
    fn next(&mut self) -> Option<&'a [u8]> {
        let line = self.peek()?;
        self.rest = self.rest.get(line.len() + 1..).unwrap_or_default();
        Some(line)
    }
}

/// Splits the output of `git diff` (without colours) into its file sections.
/// Splitting happens only at `\n`; everything else stays unchanged in the line content.
pub fn parse_diff(bytes: &[u8]) -> Vec<FilePatch> {
    let mut files: Vec<FilePatch> = Vec::new();
    let mut lines = Lines { rest: bytes };
    while let Some(line) = lines.next() {
        if line.starts_with(b"diff --git ") {
            files.push(FilePatch::default());
            continue;
        }
        let Some(file) = files.last_mut() else { continue };
        match parse_hunk_header(line) {
            Some(mut hunk) => {
                read_hunk_body(&mut lines, &mut hunk);
                file.hunks.push(hunk);
            }
            None => parse_header_line(file, line),
        }
    }
    files
}

fn read_hunk_body(lines: &mut Lines<'_>, hunk: &mut PatchHunk) {
    let (mut old_left, mut new_left) = (hunk.old_lines, hunk.new_lines);
    while old_left > 0 || new_left > 0 {
        let Some(body) = lines.next() else { break };
        let (kind, content) = match body.split_first() {
            // With diff.suppressBlankEmpty Git omits the space of empty context lines.
            None => (LineKind::Context, body),
            Some((b' ', rest)) => (LineKind::Context, rest),
            Some((b'-', rest)) => (LineKind::Remove, rest),
            Some((b'+', rest)) => (LineKind::Add, rest),
            Some((b'\\', _)) => {
                if let Some(last) = hunk.lines.last_mut() {
                    last.no_newline = true;
                }
                continue;
            }
            Some(_) => break,
        };
        match kind {
            LineKind::Context => {
                old_left = old_left.saturating_sub(1);
                new_left = new_left.saturating_sub(1);
            }
            LineKind::Remove => old_left = old_left.saturating_sub(1),
            LineKind::Add => new_left = new_left.saturating_sub(1),
        }
        hunk.lines.push(PatchLine { kind, content: content.to_vec(), no_newline: false });
    }
    // The note for the last line comes after the hunk.
    if lines.peek().is_some_and(|l| l.starts_with(b"\\")) {
        lines.next();
        if let Some(last) = hunk.lines.last_mut() {
            last.no_newline = true;
        }
    }
}

/// `@@ -a[,b] +c[,d] @@[ section]`
fn parse_hunk_header(line: &[u8]) -> Option<PatchHunk> {
    let rest = line.strip_prefix(b"@@ -")?;
    let end = rest.windows(3).position(|w| w == b" @@")?;
    let ranges = std::str::from_utf8(&rest[..end]).ok()?;
    let (old, new) = ranges.split_once(" +")?;
    let range = |text: &str| -> Option<(u32, u32)> {
        match text.split_once(',') {
            Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
            None => Some((text.parse().ok()?, 1)),
        }
    };
    let (old_start, old_lines) = range(old)?;
    let (new_start, new_lines) = range(new)?;
    let section = &rest[end + 3..];
    let section = section.strip_prefix(b" ").unwrap_or(section);
    Some(PatchHunk { old_start, old_lines, new_start, new_lines, section: section.to_vec(), lines: Vec::new() })
}

fn parse_header_line(file: &mut FilePatch, line: &[u8]) {
    let value = |rest: &[u8]| String::from_utf8_lossy(rest).trim().to_string();
    if let Some(rest) = line.strip_prefix(b"new file mode ") {
        file.is_new = true;
        file.new_mode = Some(value(rest));
    } else if let Some(rest) = line.strip_prefix(b"deleted file mode ") {
        file.is_deleted = true;
        file.old_mode = Some(value(rest));
    } else if let Some(rest) = line.strip_prefix(b"old mode ") {
        file.old_mode = Some(value(rest));
    } else if let Some(rest) = line.strip_prefix(b"new mode ") {
        file.new_mode = Some(value(rest));
    } else if line.starts_with(b"rename from ") || line.starts_with(b"rename to ") {
        file.is_rename = true;
    } else if let Some(rest) = line.strip_prefix(b"index ") {
        // index <old>..<new>[ <mode>]
        let text = value(rest);
        let mut parts = text.split(' ');
        if let Some((old, new)) = parts.next().and_then(|ids| ids.split_once("..")) {
            file.old_id = Some(old.to_string());
            file.new_id = Some(new.to_string());
        }
        if let Some(mode) = parts.next() {
            file.old_mode.get_or_insert_with(|| mode.to_string());
            file.new_mode.get_or_insert_with(|| mode.to_string());
        }
    } else if line.starts_with(b"Binary files ") || line == b"GIT binary patch" {
        file.binary = true;
    }
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/// The direction in which the selection takes effect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    /// The selection is added to the old side (staging): patch for `git apply`.
    Forward,
    /// The selection is taken back from the new side (unstaging, discarding):
    /// patch for `git apply -R`.
    Reverse,
}

#[derive(Debug, Clone)]
struct Emitted {
    sign: u8,
    content: Vec<u8>,
    no_newline: bool,
}

fn invalid_selection() -> CoreError {
    CoreError::not_allowed("The selection doesn't match the diff of this file.")
}

/// Builds, from the diff of one file and a selection (whole hunks or positions in
/// `Hunk.lines`), a patch that contains only the selection.
///
/// If a block was changed line by line (as many "−" as "+" lines), the pairs sit next to each
/// other in the patch ([`pair_order`]): a single selected line stays in its place.
///
/// - `Forward`: unselected "+" lines are dropped, unselected "−" lines become
///   context. The patch applies to the old side of the diff.
/// - `Reverse`: mirror image – unselected "+" lines become context, unselected
///   "−" lines are dropped. The patch applies to the new side with `-R`.
///
/// Positions pointing at context lines do not count. `Ok(None)` if no
/// changed line is selected. `path` is the path relative to the repository root in
/// raw bytes; it is quoted according to Git's rules.
pub fn build_patch(file: &FilePatch, path: &[u8], selection: &[HunkSelection], direction: Direction) -> CoreResult<Option<Vec<u8>>> {
    let mut picked: Vec<Vec<bool>> = file.hunks.iter().map(|h| vec![false; h.lines.len()]).collect();
    for sel in selection {
        let index = sel.index as usize;
        let hunk = file.hunks.get(index).ok_or_else(invalid_selection)?;
        let marks = picked.get_mut(index).ok_or_else(invalid_selection)?;
        match &sel.lines {
            None => {
                for (mark, line) in marks.iter_mut().zip(&hunk.lines) {
                    *mark = line.kind != LineKind::Context;
                }
            }
            Some(positions) => {
                for &pos in positions {
                    let line = hunk.lines.get(pos as usize).ok_or_else(invalid_selection)?;
                    if line.kind != LineKind::Context {
                        marks[pos as usize] = true;
                    }
                }
            }
        }
    }
    // All changed lines of the file selected: for new and deleted files the whole
    // file is then created or removed.
    let complete = file.hunks.iter().zip(&picked).all(|(hunk, marks)| hunk.lines.iter().zip(marks).all(|(l, &m)| m || l.kind == LineKind::Context));

    let mut body = Vec::new();
    // Shift of the line numbers caused by the hunks already written.
    let mut shift: i64 = 0;
    for (hunk, marks) in file.hunks.iter().zip(&picked) {
        if !marks.iter().any(|&m| m) {
            continue;
        }
        let lines = normalize(emit(hunk, marks, direction), direction);
        let old_count = lines.iter().filter(|l| l.sign != b'+').count() as i64;
        let new_count = lines.iter().filter(|l| l.sign != b'-').count() as i64;
        // The side the patch must apply to keeps the hunk's start and length;
        // the other one is recounted. With length 0 the header names the line before.
        let (old_start, new_start) = match direction {
            Direction::Forward => {
                let first = first_line(hunk.old_start, old_count) + shift;
                shift += new_count - old_count;
                (i64::from(hunk.old_start), start_for(first, new_count))
            }
            Direction::Reverse => {
                let first = first_line(hunk.new_start, new_count) + shift;
                shift += old_count - new_count;
                (start_for(first, old_count), i64::from(hunk.new_start))
            }
        };
        body.extend_from_slice(format!("@@ -{old_start},{old_count} +{new_start},{new_count} @@\n").as_bytes());
        for line in &lines {
            body.push(line.sign);
            body.extend_from_slice(&line.content);
            body.push(b'\n');
            if line.no_newline {
                body.extend_from_slice(NO_NEWLINE_MARKER);
            }
        }
    }
    if body.is_empty() {
        return Ok(None);
    }

    // Old and new side of the written patch: does the file exist there?
    let (old_exists, new_exists) = match direction {
        Direction::Forward => (!file.is_new, !(file.is_deleted && complete)),
        Direction::Reverse => (!(file.is_new && complete), !file.is_deleted),
    };
    let mut out = Vec::with_capacity(body.len() + 2 * path.len() + 128);
    out.extend_from_slice(b"diff --git ");
    out.extend_from_slice(&quote_path(b"a/", path));
    out.push(b' ');
    out.extend_from_slice(&quote_path(b"b/", path));
    out.push(b'\n');
    if !old_exists {
        out.extend_from_slice(format!("new file mode {}\n", file.new_mode.as_deref().unwrap_or("100644")).as_bytes());
    } else if !new_exists {
        out.extend_from_slice(format!("deleted file mode {}\n", file.old_mode.as_deref().unwrap_or("100644")).as_bytes());
    }
    for (marker, prefix, exists) in [(&b"--- "[..], &b"a/"[..], old_exists), (&b"+++ "[..], &b"b/"[..], new_exists)] {
        out.extend_from_slice(marker);
        if exists {
            out.extend_from_slice(&quote_path(prefix, path));
            // Like Git: a tab unambiguously ends names containing spaces.
            if path.contains(&b' ') {
                out.push(b'\t');
            }
        } else {
            out.extend_from_slice(b"/dev/null");
        }
        out.push(b'\n');
    }
    out.extend_from_slice(&body);
    Ok(Some(out))
}

/// First line of a hunk on one side; with length 0 the header names the line before.
fn first_line(start: u32, count: i64) -> i64 {
    if count == 0 {
        i64::from(start) + 1
    } else {
        i64::from(start)
    }
}

fn start_for(first: i64, count: i64) -> i64 {
    if count == 0 {
        (first - 1).max(0)
    } else {
        first.max(1)
    }
}

/// Order in which the lines of a hunk go into a partial patch (positions in `lines`).
///
/// In a change block Git writes all "−" lines first, then all "+" lines. If you select only the
/// middle pair from a block with three changed lines, the new line would therefore end up AFTER the
/// third old one ("one, three, TWO" – an order that never existed in the file).
/// If a block has as many "−" as "+" lines, the k-th "+" line belongs to the k-th "−" line:
/// the pairs then follow one another ("−one +ONE −two +TWO …"), and every selected line lands
/// at the place of its partner. Blocks with unequal line counts stay as Git writes them.
pub(crate) fn pair_order(kinds: &[LineKind]) -> Vec<usize> {
    let mut order = Vec::with_capacity(kinds.len());
    let mut at = 0;
    while at < kinds.len() {
        if kinds[at] != LineKind::Remove {
            order.push(at);
            at += 1;
            continue;
        }
        let removes = kinds[at..].iter().take_while(|kind| **kind == LineKind::Remove).count();
        let adds = kinds[at + removes..].iter().take_while(|kind| **kind == LineKind::Add).count();
        if removes == adds && removes >= 2 {
            for pair in 0..removes {
                order.push(at + pair);
                order.push(at + removes + pair);
            }
        } else {
            order.extend(at..at + removes + adds);
        }
        at += removes + adds;
    }
    order
}

fn emit(hunk: &PatchHunk, marks: &[bool], direction: Direction) -> Vec<Emitted> {
    let mut out = Vec::with_capacity(hunk.lines.len());
    let kinds: Vec<LineKind> = hunk.lines.iter().map(|line| line.kind).collect();
    let mut order = pair_order(&kinds);
    old_last_line_in_place(hunk, &mut order);
    for index in order {
        let (line, picked) = (&hunk.lines[index], marks[index]);
        let sign = match (line.kind, direction, picked) {
            (LineKind::Context, _, _) => b' ',
            (LineKind::Add, _, true) => b'+',
            (LineKind::Remove, _, true) => b'-',
            (LineKind::Remove, Direction::Forward, false) | (LineKind::Add, Direction::Reverse, false) => b' ',
            (LineKind::Add, Direction::Forward, false) | (LineKind::Remove, Direction::Reverse, false) => continue,
        };
        out.push(Emitted { sign, content: line.content.clone(), no_newline: line.no_newline });
    }
    out
}

/// The old last line ("−" without a newline): Git writes it in front of all "+" lines of its
/// block. In a partial patch the unselected "+" lines of the block become context (taking back)
/// or are dropped, so the line would land in front of lines it followed in the file ("alpha,
/// gamma, BETA" instead of "alpha, BETA, gamma"). Like [`pair_order`], the k-th "−" line belongs
/// to the k-th "+" line of the block: the old last line goes in front of its partner, or to the
/// end of the hunk if the block has fewer "+" lines. Only "+" lines follow it in the hunk (the old
/// side ends there), so the order of the old and of the new side stays the same.
fn old_last_line_in_place(hunk: &PatchHunk, order: &mut Vec<usize>) {
    let Some(last) = hunk.lines.iter().position(|line| line.kind == LineKind::Remove && line.no_newline) else {
        return;
    };
    if hunk.lines[last + 1..].iter().any(|later| later.kind != LineKind::Add) {
        return;
    }
    let rank = hunk.lines[..last].iter().rev().take_while(|line| line.kind == LineKind::Remove).count();
    let partner = last + 1 + rank;
    let Some(from) = order.iter().position(|&i| i == last) else { return };
    order.remove(from);
    match order.iter().position(|&i| i == partner) {
        Some(at) => order.insert(at, last),
        None => order.push(last),
    }
}

/// Makes sure that no line without a newline ends up in the middle of the file in the
/// result. That happens when the last line of the source side has no newline and only
/// part of the changes after it is selected; without the fix two lines would stick
/// together. The affected line gets its newline in the result.
fn normalize(lines: Vec<Emitted>, direction: Direction) -> Vec<Emitted> {
    // Result = new side when staging, old side when taking back.
    let (result_sign, base_sign) = match direction {
        Direction::Forward => (b'+', b'-'),
        Direction::Reverse => (b'-', b'+'),
    };
    let in_result = |l: &Emitted| l.sign == b' ' || l.sign == result_sign;
    let Some(last) = lines.iter().rposition(in_result) else { return lines };
    if !lines[..last].iter().any(|l| l.no_newline && in_result(l)) {
        return lines;
    }
    // Line ending as with the neighbours: CRLF files stay CRLF.
    let crlf_near = |at: usize| {
        lines[at + 1..]
            .iter()
            .chain(lines[..at].iter().rev())
            .find(|l| in_result(l) && !l.no_newline)
            .is_some_and(|l| l.content.ends_with(b"\r"))
    };
    let mut out = Vec::with_capacity(lines.len() + 1);
    for (i, line) in lines.iter().enumerate() {
        if i >= last || !line.no_newline || !in_result(line) {
            out.push(line.clone());
            continue;
        }
        let mut fixed = line.content.clone();
        if crlf_near(i) && !fixed.ends_with(b"\r") {
            fixed.push(b'\r');
        }
        if line.sign == b' ' {
            // The source side keeps the line without a newline, the result gets one.
            let base = Emitted { sign: base_sign, content: line.content.clone(), no_newline: true };
            let result = Emitted { sign: result_sign, content: fixed, no_newline: false };
            if base_sign == b'-' {
                out.push(base);
                out.push(result);
            } else {
                out.push(result);
                out.push(base);
            }
        } else {
            out.push(Emitted { sign: line.sign, content: fixed, no_newline: false });
        }
    }
    out
}

/// Path for the patch header, quoted like Git does with `core.quotepath=false`:
/// quotes only for control characters, `"` or `\`; bytes from 0x80 on stay raw.
pub fn quote_path(prefix: &[u8], path: &[u8]) -> Vec<u8> {
    let needs_quotes = path.iter().any(|&b| b < 0x20 || b == 0x7f || b == b'"' || b == b'\\');
    let mut out = Vec::with_capacity(prefix.len() + path.len() + 2);
    if !needs_quotes {
        out.extend_from_slice(prefix);
        out.extend_from_slice(path);
        return out;
    }
    out.push(b'"');
    out.extend_from_slice(prefix);
    for &b in path {
        match b {
            b'"' => out.extend_from_slice(b"\\\""),
            b'\\' => out.extend_from_slice(b"\\\\"),
            b'\n' => out.extend_from_slice(b"\\n"),
            b'\t' => out.extend_from_slice(b"\\t"),
            b'\r' => out.extend_from_slice(b"\\r"),
            0x07 => out.extend_from_slice(b"\\a"),
            0x08 => out.extend_from_slice(b"\\b"),
            0x0b => out.extend_from_slice(b"\\v"),
            0x0c => out.extend_from_slice(b"\\f"),
            b if b < 0x20 || b == 0x7f => out.extend_from_slice(format!("\\{b:03o}").as_bytes()),
            b => out.push(b),
        }
    }
    out.push(b'"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(bytes: &[u8]) -> String {
        String::from_utf8_lossy(bytes).into_owned()
    }

    fn one(diff: &str) -> FilePatch {
        let mut files = parse_diff(diff.as_bytes());
        assert_eq!(files.len(), 1, "{files:?}");
        files.remove(0)
    }

    fn lines_of(hunk: &PatchHunk) -> Vec<String> {
        hunk.lines
            .iter()
            .map(|l| {
                let sign = match l.kind {
                    LineKind::Context => ' ',
                    LineKind::Add => '+',
                    LineKind::Remove => '-',
                };
                format!("{sign}{}{}", text(&l.content), if l.no_newline { "⏎✗" } else { "" })
            })
            .collect()
    }

    fn pick(index: u32, lines: &[u32]) -> HunkSelection {
        HunkSelection { index, lines: Some(lines.to_vec()) }
    }

    fn whole(index: u32) -> HunkSelection {
        HunkSelection { index, lines: None }
    }

    fn built(file: &FilePatch, path: &str, selection: &[HunkSelection], direction: Direction) -> String {
        text(&build_patch(file, path.as_bytes(), selection, direction).unwrap().expect("Patch"))
    }

    const MODIFIED: &str = "diff --git a/f.txt b/f.txt\nindex 1111111..2222222 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -1,5 +1,7 @@ fn x()\n a\n-b\n+B1\n+B2\n c\n-d\n+D\n e\n+f\n";

    #[test]
    fn parses_headers_and_hunks() {
        let file = one(MODIFIED);
        assert!(!file.is_new && !file.is_deleted && !file.binary);
        assert_eq!(file.old_id.as_deref(), Some("1111111"));
        assert_eq!(file.new_id.as_deref(), Some("2222222"));
        assert_eq!(file.old_mode.as_deref(), Some("100644"));
        assert_eq!(file.hunks.len(), 1);
        let h = &file.hunks[0];
        assert_eq!((h.old_start, h.old_lines, h.new_start, h.new_lines), (1, 5, 1, 7));
        assert_eq!(h.section, b"fn x()");
        assert_eq!(lines_of(h), vec![" a", "-b", "+B1", "+B2", " c", "-d", "+D", " e", "+f"]);
    }

    #[test]
    fn parses_new_deleted_binary_rename_and_several_files() {
        let diff = "diff --git a/neu b/neu\nnew file mode 100755\nindex 0000000..1234567\n--- /dev/null\n+++ b/neu\n@@ -0,0 +1 @@\n+x\n\
                    diff --git a/weg b/weg\ndeleted file mode 100644\nindex 1234567..0000000\n--- a/weg\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y\n\
                    diff --git a/bild.png b/bild.png\nindex 1..2 100644\nBinary files a/bild.png and b/bild.png differ\n\
                    diff --git a/alt b/neu2\nsimilarity index 100%\nrename from alt\nrename to neu2\n\
                    diff --git a/s.sh b/s.sh\nold mode 100644\nnew mode 100755\n";
        let files = parse_diff(diff.as_bytes());
        assert_eq!(files.len(), 5);
        assert!(files[0].is_new);
        assert_eq!(files[0].new_mode.as_deref(), Some("100755"));
        assert_eq!((files[0].hunks[0].old_start, files[0].hunks[0].old_lines, files[0].hunks[0].new_start, files[0].hunks[0].new_lines), (0, 0, 1, 1));
        assert!(files[1].is_deleted);
        assert_eq!(files[1].old_mode.as_deref(), Some("100644"));
        assert_eq!(lines_of(&files[1].hunks[0]), vec!["-x", "-y"]);
        assert!(files[2].binary && files[2].hunks.is_empty());
        assert!(files[3].is_rename && files[3].hunks.is_empty());
        assert_eq!((files[4].old_mode.as_deref(), files[4].new_mode.as_deref()), (Some("100644"), Some("100755")));
    }

    #[test]
    fn parses_bytes_crlf_and_no_newline_markers() {
        let diff: &[u8] = b"* Unmerged path f\ndiff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,3 @@\n a\r\n\n-Gr\xfc\xdfe\r\n\\ No newline at end of file\n+--- kein Kopf\n\\ No newline at end of file\n";
        let files = parse_diff(diff);
        assert_eq!(files.len(), 1);
        let lines = &files[0].hunks[0].lines;
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[0].content, b"a\r");
        // An empty line without a leading space (diff.suppressBlankEmpty) is context.
        assert_eq!((lines[1].kind, lines[1].content.as_slice()), (LineKind::Context, &b""[..]));
        assert_eq!(lines[2].content, b"Gr\xfc\xdfe\r");
        assert!(lines[2].no_newline && lines[3].no_newline);
        // A "+" line that looks like a file header stays a line.
        assert_eq!((lines[3].kind, lines[3].content.as_slice()), (LineKind::Add, &b"--- kein Kopf"[..]));
        assert_eq!(FilePatch::old_side(&files[0].hunks[0]), b"a\r\n\nGr\xfc\xdfe\r");
        assert_eq!(FilePatch::new_side(&files[0].hunks[0]), b"a\r\n\n--- kein Kopf");
    }

    #[test]
    fn hunk_header_without_counts() {
        let file = one("diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -3 +3 @@\n-a\n+b\n@@ -9,0 +10,2 @@ abschnitt @@ mit zeichen\n+x\n+y\n");
        assert_eq!(file.hunks.len(), 2);
        assert_eq!((file.hunks[0].old_start, file.hunks[0].old_lines), (3, 1));
        assert_eq!((file.hunks[1].old_start, file.hunks[1].old_lines, file.hunks[1].new_start, file.hunks[1].new_lines), (9, 0, 10, 2));
        assert_eq!(file.hunks[1].section, b"abschnitt @@ mit zeichen");
    }

    #[test]
    fn forward_whole_hunk_reproduces_the_diff() {
        let file = one(MODIFIED);
        let patch = built(&file, "f.txt", &[whole(0)], Direction::Forward);
        assert_eq!(patch, "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,5 +1,7 @@\n a\n-b\n+B1\n+B2\n c\n-d\n+D\n e\n+f\n");
        assert_eq!(built(&file, "f.txt", &[whole(0)], Direction::Reverse), patch);
    }

    #[test]
    fn forward_drops_unselected_adds_and_keeps_unselected_removes() {
        let file = one(MODIFIED);
        // +B2, -d, +f
        let patch = built(&file, "f.txt", &[pick(0, &[3, 5, 8])], Direction::Forward);
        assert_eq!(patch, "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,5 +1,6 @@\n a\n b\n+B2\n c\n-d\n e\n+f\n");
    }

    #[test]
    fn reverse_is_the_mirror_image() {
        let file = one(MODIFIED);
        // Take back +B2, -d, +f: the remaining "+" are context, the remaining "−" are missing.
        let patch = built(&file, "f.txt", &[pick(0, &[3, 5, 8])], Direction::Reverse);
        assert_eq!(patch, "diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1,6 +1,7 @@\n a\n B1\n+B2\n c\n-d\n D\n e\n+f\n");
    }

    #[test]
    fn context_positions_and_empty_selections_yield_nothing() {
        let file = one(MODIFIED);
        assert_eq!(build_patch(&file, b"f.txt", &[], Direction::Forward).unwrap(), None);
        assert_eq!(build_patch(&file, b"f.txt", &[pick(0, &[0, 4, 7])], Direction::Forward).unwrap(), None);
        assert_eq!(build_patch(&file, b"f.txt", &[pick(0, &[])], Direction::Reverse).unwrap(), None);
        assert!(build_patch(&file, b"f.txt", &[whole(1)], Direction::Forward).is_err());
        assert!(build_patch(&file, b"f.txt", &[pick(0, &[9])], Direction::Forward).is_err());
    }

    const THREE_HUNKS: &str = "diff --git a/f b/f\n--- a/f\n+++ b/f\n\
        @@ -1,4 +1,6 @@\n a\n+n1\n+n2\n b\n c\n d\n\
        @@ -20,4 +22,3 @@\n e\n-f\n g\n h\n\
        @@ -40,3 +41,4 @@\n i\n j\n-k\n+K\n+L\n";

    #[test]
    fn later_hunks_shift_with_what_was_selected() {
        let file = one(THREE_HUNKS);
        // First hunk only +n2, second not at all, third entirely.
        let patch = built(&file, "f", &[pick(0, &[2]), whole(2)], Direction::Forward);
        assert_eq!(
            patch,
            "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,4 +1,5 @@\n a\n+n2\n b\n c\n d\n@@ -40,3 +41,4 @@\n i\n j\n-k\n+K\n+L\n"
        );
        // In reverse the new side stays put, the old one shifts.
        let patch = built(&file, "f", &[pick(0, &[2]), whole(2)], Direction::Reverse);
        assert_eq!(
            patch,
            "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,5 +1,6 @@\n a\n n1\n+n2\n b\n c\n d\n@@ -40,3 +41,4 @@\n i\n j\n-k\n+K\n+L\n"
        );
        let patch = built(&file, "f", &[whole(1)], Direction::Reverse);
        assert_eq!(patch, "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -22,4 +22,3 @@\n e\n-f\n g\n h\n");
    }

    #[test]
    fn new_file_forward_and_reverse() {
        let file = one("diff --git a/n b/n\nnew file mode 100755\nindex 0000000..1234567\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,3 @@\n+eins\n+zwei\n+drei\n");
        // Stage part of a new file: patch against /dev/null with the selected lines.
        assert_eq!(
            built(&file, "n", &[pick(0, &[1])], Direction::Forward),
            "diff --git a/n b/n\nnew file mode 100755\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,1 @@\n+zwei\n"
        );
        // Take back part: the file stays, so an ordinary patch.
        assert_eq!(built(&file, "n", &[pick(0, &[1])], Direction::Reverse), "diff --git a/n b/n\n--- a/n\n+++ b/n\n@@ -1,2 +1,3 @@\n eins\n+zwei\n drei\n");
        // Take back everything: the file disappears.
        assert_eq!(
            built(&file, "n", &[whole(0)], Direction::Reverse),
            "diff --git a/n b/n\nnew file mode 100755\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,3 @@\n+eins\n+zwei\n+drei\n"
        );
    }

    #[test]
    fn deleted_file_forward_and_reverse() {
        let file = one("diff --git a/w b/w\ndeleted file mode 100644\nindex 1234567..0000000\n--- a/w\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-eins\n-zwei\n-drei\n");
        // Stage part of the deletion: the file stays in the index with the rest.
        assert_eq!(built(&file, "w", &[pick(0, &[1])], Direction::Forward), "diff --git a/w b/w\n--- a/w\n+++ b/w\n@@ -1,3 +1,2 @@\n eins\n-zwei\n drei\n");
        assert_eq!(
            built(&file, "w", &[whole(0)], Direction::Forward),
            "diff --git a/w b/w\ndeleted file mode 100644\n--- a/w\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-eins\n-zwei\n-drei\n"
        );
        // Take back part of the deletion: the file comes into being with the selected lines.
        assert_eq!(
            built(&file, "w", &[pick(0, &[0, 2])], Direction::Reverse),
            "diff --git a/w b/w\ndeleted file mode 100644\n--- a/w\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-eins\n-drei\n"
        );
    }

    #[test]
    fn missing_newline_on_the_old_side() {
        let file = one("diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,3 @@\n a\n-b\n\\ No newline at end of file\n+b\n+c\n");
        assert_eq!(lines_of(&file.hunks[0]), vec![" a", "-b⏎✗", "+b", "+c"]);
        // Only +c: the old last line gets its newline.
        assert_eq!(
            built(&file, "f", &[pick(0, &[3])], Direction::Forward),
            "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,3 @@\n a\n-b\n\\ No newline at end of file\n+b\n+c\n"
        );
        // Only −b: the line is dropped.
        assert_eq!(built(&file, "f", &[pick(0, &[1])], Direction::Forward), "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,1 @@\n a\n-b\n\\ No newline at end of file\n");
        // Take back −b, +b and +c stay: the restored line is not at the end.
        assert_eq!(built(&file, "f", &[pick(0, &[1])], Direction::Reverse), "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,4 +1,3 @@\n a\n-b\n b\n c\n");
        // Take back +c: b stays with a newline.
        assert_eq!(built(&file, "f", &[pick(0, &[3])], Direction::Reverse), "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,3 @@\n a\n b\n+c\n");
    }

    #[test]
    fn missing_newline_on_the_new_side_and_both() {
        let file = one("diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n a\n-b\n+B\n\\ No newline at end of file\n");
        assert_eq!(built(&file, "f", &[pick(0, &[2])], Direction::Forward), "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,3 @@\n a\n b\n+B\n\\ No newline at end of file\n");
        assert_eq!(built(&file, "f", &[pick(0, &[1])], Direction::Reverse), "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,2 @@\n a\n-b\n B\n\\ No newline at end of file\n");

        let both = one("diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,3 @@\n a\n-b\n\\ No newline at end of file\n+b\n+c\n\\ No newline at end of file\n");
        // Only +c: b gets a newline in the result, c stays without one.
        assert_eq!(
            built(&both, "f", &[pick(0, &[3])], Direction::Forward),
            "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,3 @@\n a\n-b\n\\ No newline at end of file\n+b\n+c\n\\ No newline at end of file\n"
        );
        // A context line without a newline at the end stays as it is.
        let ctx = one("diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-a\n+A\n z\n\\ No newline at end of file\n");
        assert_eq!(built(&ctx, "f", &[whole(0)], Direction::Forward), "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-a\n+A\n z\n\\ No newline at end of file\n");
    }

    /// Taking back changes at the old last line (no newline): the restored line stays behind the
    /// unselected "+" lines it followed instead of jumping in front of them.
    #[test]
    fn restored_last_line_without_newline_stays_at_the_end() {
        // Old "alpha\nbeta\ngamma", new "alpha\nBETA\ngamma\ndelta" (both without newline).
        let file = one("diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,4 @@\n alpha\n-beta\n-gamma\n\\ No newline at end of file\n+BETA\n+gamma\n+delta\n\\ No newline at end of file\n");
        // Take back −gamma, +gamma, +delta: BETA stays, gamma comes back as the last line.
        assert_eq!(
            built(&file, "f", &[pick(0, &[2, 4, 5])], Direction::Reverse),
            "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,4 @@\n alpha\n BETA\n-gamma\n\\ No newline at end of file\n+gamma\n+delta\n\\ No newline at end of file\n"
        );
        // The same with a changed last line: gamma still comes back as the last line.
        let other = one("diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,4 @@\n alpha\n-beta\n-gamma\n\\ No newline at end of file\n+BETA\n+GAMMA\n+delta\n\\ No newline at end of file\n");
        assert_eq!(
            built(&other, "f", &[pick(0, &[2, 4, 5])], Direction::Reverse),
            "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,3 +1,4 @@\n alpha\n BETA\n-gamma\n\\ No newline at end of file\n+GAMMA\n+delta\n\\ No newline at end of file\n"
        );
    }

    #[test]
    fn added_newline_follows_the_neighbours_line_ending() {
        let file = one("diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,3 @@\n a\r\n-b\n\\ No newline at end of file\n+b\r\n+c\r\n");
        let patch = build_patch(&file, b"f", &[pick(0, &[3])], Direction::Forward).unwrap().unwrap();
        assert_eq!(patch, b"diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,3 @@\n a\r\n-b\n\\ No newline at end of file\n+b\r\n+c\r\n");
    }

    #[test]
    fn paths_are_quoted_like_git_does() {
        assert_eq!(quote_path(b"a/", b"einfach.txt"), b"a/einfach.txt");
        assert_eq!(quote_path(b"a/", "mit leer & ümlaut.txt".as_bytes()), "a/mit leer & ümlaut.txt".as_bytes());
        assert_eq!(quote_path(b"b/", b"sag \"hallo\".txt"), b"\"b/sag \\\"hallo\\\".txt\"");
        assert_eq!(quote_path(b"a/", b"back\\slash\ttab\nzeile\x01"), b"\"a/back\\\\slash\\ttab\\nzeile\\001\"");
        assert_eq!(quote_path(b"a/", b"latin1 \xfc \"x\""), b"\"a/latin1 \xfc \\\"x\\\"\"");

        let file = one(MODIFIED);
        let patch = built(&file, "a b/c \"d\".txt", &[pick(0, &[8])], Direction::Forward);
        assert!(patch.starts_with("diff --git \"a/a b/c \\\"d\\\".txt\" \"b/a b/c \\\"d\\\".txt\"\n--- \"a/a b/c \\\"d\\\".txt\"\t\n+++ \"b/a b/c \\\"d\\\".txt\"\t\n@@"), "{patch}");
        let patch = built(&file, "a b.txt", &[pick(0, &[8])], Direction::Forward);
        assert!(patch.starts_with("diff --git a/a b.txt b/a b.txt\n--- a/a b.txt\t\n+++ b/a b.txt\t\n@@"), "{patch}");
    }
}
