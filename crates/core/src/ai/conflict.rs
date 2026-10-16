//! Teilpaket 6.1 – “Explain intent” in the conflict tool.
//!
//! The UI sends the conflict blocks of its own three-way model as line ranges of the two sides
//! (`ConflictBlockRange`); the core reads the versions itself from the index (stages 2 and 3, as
//! `conflict_get`), so what goes out is Git's content, not text from the UI. Around the blocks go
//! the commit messages of both sides since they split and – if a host account is connected – the
//! texts of the pull requests of both branches. Everything from the repository is redacted and
//! stands between the delimiters of `ai::prompt`.
//!
//! The answer is data: per block two explanations and a proposed text. The core checks that every
//! block that went out is answered exactly once, normalises line endings and refuses proposals that
//! still contain conflict markers. A block shortened for the budget or changed by redaction gets an
//! explanation only – its proposal would lack lines or contain masks, so it is never offered.

use crate::error::{CoreError, CoreResult};
use crate::model::ConflictBlockRange;

/// At most this many conflict blocks of one file go into one request.
pub const MAX_BLOCKS: usize = 200;
/// Unchanged lines shown before and after a block (from the current side; equal on both sides).
const CONTEXT_LINES: usize = 3;

/// Lines without line endings, exactly as the conflict tool splits a version (`splitText` in
/// `src/screens/ConflictTool/model.ts`): CRLF counts as LF, a final line break starts no new line.
pub fn split_lines(text: &str) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    let normalized = text.replace("\r\n", "\n");
    let mut lines: Vec<String> = normalized.split('\n').map(str::to_string).collect();
    if lines.last().is_some_and(|line| line.is_empty()) {
        lines.pop();
    }
    lines
}

/// One conflict block with its surroundings, cut from the versions Git holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockText {
    /// 0-based first line of the block in the respective version.
    pub ours_start: usize,
    pub theirs_start: usize,
    /// Up to three lines before and after the block (current side).
    pub before: Vec<String>,
    pub ours: Vec<String>,
    pub theirs: Vec<String>,
    pub after: Vec<String>,
}

/// Checks the tool's ranges against the versions and cuts the blocks: in order, without overlap,
/// inside both versions, never empty on both sides. A mismatch means the tool's model is older than
/// the index – `not_allowed`, nothing is sent.
pub fn slice_blocks(ours: &[String], theirs: &[String], ranges: &[ConflictBlockRange]) -> CoreResult<Vec<BlockText>> {
    if ranges.is_empty() {
        return Err(CoreError::not_allowed("There is no conflict block to explain."));
    }
    if ranges.len() > MAX_BLOCKS {
        return Err(CoreError::not_allowed(format!(
            "At most {MAX_BLOCKS} conflict blocks can be explained at once; this file has {}.",
            ranges.len()
        )));
    }
    let mut blocks = Vec::with_capacity(ranges.len());
    let (mut ours_from, mut theirs_from) = (0usize, 0usize);
    for (index, range) in ranges.iter().enumerate() {
        let (ours_start, ours_count) = (range.ours_start as usize, range.ours_count as usize);
        let (theirs_start, theirs_count) = (range.theirs_start as usize, range.theirs_count as usize);
        let (ours_end, theirs_end) = (ours_start + ours_count, theirs_start + theirs_count);
        let fits = ours_start >= ours_from
            && theirs_start >= theirs_from
            && ours_end <= ours.len()
            && theirs_end <= theirs.len()
            && ours_count + theirs_count > 0;
        if !fits {
            return Err(CoreError::not_allowed(format!(
                "Conflict block {} does not match the file any more. Reload the conflict and try again.",
                index + 1
            )));
        }
        blocks.push(BlockText {
            ours_start,
            theirs_start,
            before: ours[ours_start.saturating_sub(CONTEXT_LINES)..ours_start].to_vec(),
            ours: ours[ours_start..ours_end].to_vec(),
            theirs: theirs[theirs_start..theirs_end].to_vec(),
            after: ours[ours_end..(ours_end + CONTEXT_LINES).min(ours.len())].to_vec(),
        });
        ours_from = ours_end;
        theirs_from = theirs_end;
    }
    Ok(blocks)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    fn range(ours_start: u32, ours_count: u32, theirs_start: u32, theirs_count: u32) -> ConflictBlockRange {
        ConflictBlockRange { ours_start, ours_count, theirs_start, theirs_count }
    }

    /// The same split as `splitText` in `src/screens/ConflictTool/model.ts`.
    #[test]
    fn lines_are_split_like_the_conflict_tool() {
        assert_eq!(split_lines(""), Vec::<String>::new());
        assert_eq!(split_lines("a\nb\n"), vec!["a", "b"]);
        assert_eq!(split_lines("a\r\nb"), vec!["a", "b"], "CRLF and no newline at the end");
        assert_eq!(split_lines("a\n\n"), vec!["a", ""], "an empty last line stays a line");
        assert_eq!(split_lines("\n"), vec![""]);
        assert_eq!(split_lines("a\rb\n"), vec!["a\rb"], "a lone CR is content");
    }

    #[test]
    fn block_ranges_must_match_the_versions() {
        let ours = split_lines("kopf\neins main\nmitte\nzwei\ndrei\nvier main\nende\n");
        let theirs = split_lines("kopf\neins feature\nneu\nmitte\nzwei\ndrei\nende\n");
        let blocks = slice_blocks(&ours, &theirs, &[range(1, 1, 1, 2), range(5, 1, 6, 0)]).unwrap();
        assert_eq!(
            blocks[0],
            BlockText {
                ours_start: 1,
                theirs_start: 1,
                before: vec!["kopf".into()],
                ours: vec!["eins main".into()],
                theirs: vec!["eins feature".into(), "neu".into()],
                after: vec!["mitte".into(), "zwei".into(), "drei".into()],
            }
        );
        assert_eq!(
            blocks[1],
            BlockText {
                ours_start: 5,
                theirs_start: 6,
                before: vec!["mitte".into(), "zwei".into(), "drei".into()],
                ours: vec!["vier main".into()],
                theirs: vec![],
                after: vec!["ende".into()],
            },
            "a side without lines is allowed, the context comes from the current side"
        );

        let refused = |ranges: &[ConflictBlockRange]| {
            let error = slice_blocks(&ours, &theirs, ranges).unwrap_err();
            assert_eq!(error.code, ErrorCode::NotAllowed);
            error.message
        };
        assert_eq!(refused(&[range(6, 2, 6, 0)]), "Conflict block 1 does not match the file any more. Reload the conflict and try again.", "beyond the end");
        assert!(refused(&[range(1, 2, 1, 1), range(2, 1, 3, 1)]).starts_with("Conflict block 2 "), "overlapping blocks");
        assert!(refused(&[range(5, 1, 6, 0), range(1, 1, 1, 2)]).starts_with("Conflict block 2 "), "blocks out of order");
        assert!(refused(&[range(3, 0, 3, 0)]).starts_with("Conflict block 1 "), "a block without lines on both sides");
        assert_eq!(refused(&[]), "There is no conflict block to explain.");
        let many = vec![range(0, 1, 0, 1); MAX_BLOCKS + 1];
        assert_eq!(refused(&many), "At most 200 conflict blocks can be explained at once; this file has 201.");
    }
}
