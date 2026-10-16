//! Review comments taken over as `fixup!` commits (8.2): the patch for a range of lines – built byte for
//! byte by the core, never by the AI –, the range of the pull request in the local repository and the
//! commit a fixup belongs to. `review_fix_apply` (the takeover) follows below.

use std::collections::HashSet;

use serde_json::{json, Map};

use crate::app::Core;
use crate::commands::commit;
use crate::commands::diff::patch::quote_path;
use crate::commands::graph;
use crate::commands::history::{self, UTF8_BOM};
use crate::commands::status::read_status;
use crate::db::{self, undo::UndoEntry};
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::GitCmd;
use crate::host::{self, Host, RepoApi};
use crate::model::{FixupReason, FixupTarget, Head, PrSummary, RepoChange, ReviewFixApplied, ReviewFixInput, ReviewFixLine, ReviewFixLineKind};
use crate::undo::{self, GroupRecord, RefMove, UndoAction};
use crate::util;

/// Lines of context around the replaced ones.
pub const CONTEXT_LINES: usize = 3;
/// Largest replacement text.
pub const MAX_NEW_TEXT: usize = 64 * 1024;
/// Largest file a fix is built for.
pub const MAX_FILE_BYTES: usize = 8 * 1024 * 1024;

fn read(core: &Core, repo_id: &str) -> CoreResult<GitCmd> {
    Ok(core.git_for(repo_id)?.read_only().no_log())
}

fn short(sha: &str) -> String {
    sha.chars().take(7).collect()
}

// ---------------------------------------------------------------------------
// The patch
// ---------------------------------------------------------------------------

/// The patch of a fix and what the UI shows of it.
#[derive(Debug, Clone)]
pub struct LinePatch {
    /// For `git apply`: the file's bytes outside the range untouched, paths quoted like Git.
    pub patch: Vec<u8>,
    /// The replaced lines, decoded, joined with `\n`.
    pub old_text: String,
    /// The hunk for display.
    pub lines: Vec<ReviewFixLine>,
}

/// The lines of `bytes`, each with its line ending (the last one may have none).
fn split_lines(bytes: &[u8]) -> Vec<&[u8]> {
    let mut lines = Vec::new();
    let mut start = 0;
    for (index, byte) in bytes.iter().enumerate() {
        if *byte == b'\n' {
            lines.push(&bytes[start..=index]);
            start = index + 1;
        }
    }
    if start < bytes.len() {
        lines.push(&bytes[start..]);
    }
    lines
}

fn without_eol(line: &[u8]) -> &[u8] {
    let line = line.strip_suffix(b"\n").unwrap_or(line);
    line.strip_suffix(b"\r").unwrap_or(line)
}

/// One line for display, in the file's encoding (`decode_content`'s name).
fn decode_line(line: &[u8], encoding: &str) -> String {
    let bytes = without_eol(line);
    match encoding_rs::Encoding::for_label(encoding.as_bytes()) {
        Some(enc) if enc != encoding_rs::UTF_8 => enc.decode_without_bom_handling(bytes).0.into_owned(),
        _ => util::decode_lossy(bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(bytes)),
    }
}

/// `sign` + the line; a line without line ending gets Git's marker.
fn emit(patch: &mut Vec<u8>, sign: u8, line: &[u8]) {
    patch.push(sign);
    patch.extend_from_slice(line);
    if !line.ends_with(b"\n") {
        patch.extend_from_slice(b"\n\\ No newline at end of file\n");
    }
}

/// The patch that replaces lines `start..=end` (1-based) of `blob` with `new_text`, with three lines of
/// context. The new lines get the line ending of the first replaced line; a range ending at a last line
/// without final newline keeps it that way; the text is encoded like the file (UTF-8, UTF-8 with BOM,
/// otherwise windows-1252). Refused (`not_allowed`): binary and UTF-16 files, lines outside the file, a
/// text with NUL, over 64 KiB or with characters the encoding cannot hold, and a text that changes nothing.
pub fn line_patch(path: &str, blob: &[u8], start: u32, end: u32, new_text: &str) -> CoreResult<LinePatch> {
    if history::is_binary_content(blob) {
        return Err(CoreError::not_allowed(format!("“{path}” is a binary file; fixes are only taken over for text files.")));
    }
    let (_, encoding) = history::decode_content(blob, "utf-8");
    if encoding.starts_with("utf-16") {
        return Err(CoreError::not_allowed(format!("“{path}” is stored as UTF-16; fixes are only taken over for UTF-8 and single-byte files.")));
    }
    if new_text.len() > MAX_NEW_TEXT || new_text.contains('\0') {
        return Err(CoreError::not_allowed("The suggested text is longer than 64 KiB or contains a NUL character."));
    }
    let lines = split_lines(blob);
    let count = lines.len();
    if start == 0 || end < start || end as usize > count {
        return Err(CoreError::not_allowed(format!("Lines {start}–{end} are not in “{path}”, which has {count} lines.")));
    }
    let (first, last) = (start as usize - 1, end as usize);
    let eol: &[u8] = if lines[first].ends_with(b"\r\n") { b"\r\n" } else { b"\n" };
    let open_end = last == count && !lines[last - 1].ends_with(b"\n");
    let bom: &[u8] = if first == 0 && encoding == UTF8_BOM { &blob[..3] } else { &[] };
    let plain = if encoding == UTF8_BOM { "utf-8" } else { encoding.as_str() };
    let text = new_text.replace("\r\n", "\n");
    let mut new_lines: Vec<Vec<u8>> = Vec::new();
    if !text.is_empty() {
        let parts: Vec<&str> = text.strip_suffix('\n').unwrap_or(&text).split('\n').collect();
        for (index, part) in parts.iter().enumerate() {
            let mut bytes = history::encode_content(part, plain).map_err(|e| CoreError::not_allowed(format!("The suggested text does not fit the encoding of “{path}”: {}", e.message)))?;
            if index == 0 && !bom.is_empty() {
                let mut prefixed = bom.to_vec();
                prefixed.extend_from_slice(&bytes);
                bytes = prefixed;
            }
            if !(open_end && index + 1 == parts.len()) {
                bytes.extend_from_slice(eol);
            }
            new_lines.push(bytes);
        }
    } else if !bom.is_empty() {
        return Err(CoreError::not_allowed(format!("The first line of “{path}” carries the byte order mark and is not deleted this way.")));
    }
    if new_lines.iter().map(Vec::as_slice).eq(lines[first..last].iter().copied()) {
        return Err(CoreError::not_allowed("The suggested text is the same as the lines it would replace."));
    }

    let before = first.saturating_sub(CONTEXT_LINES);
    let after = (last + CONTEXT_LINES).min(count);
    let old_len = after - before;
    let new_len = (first - before) + new_lines.len() + (after - last);
    let new_start = if new_len == 0 { before } else { before + 1 };
    let mut patch = Vec::new();
    let (a, b) = (quote_path(b"a/", path.as_bytes()), quote_path(b"b/", path.as_bytes()));
    patch.extend_from_slice(b"diff --git ");
    patch.extend_from_slice(&a);
    patch.push(b' ');
    patch.extend_from_slice(&b);
    patch.extend_from_slice(b"\n--- ");
    patch.extend_from_slice(&a);
    patch.extend_from_slice(b"\n+++ ");
    patch.extend_from_slice(&b);
    patch.extend_from_slice(format!("\n@@ -{},{old_len} +{new_start},{new_len} @@\n", before + 1).as_bytes());

    let mut shown: Vec<ReviewFixLine> = Vec::new();
    for (offset, line) in lines[before..first].iter().enumerate() {
        emit(&mut patch, b' ', line);
        let number = (before + offset + 1) as u32;
        shown.push(ReviewFixLine { kind: ReviewFixLineKind::Context, text: decode_line(line, &encoding), old: Some(number), new: Some(number) });
    }
    for (offset, line) in lines[first..last].iter().enumerate() {
        emit(&mut patch, b'-', line);
        shown.push(ReviewFixLine { kind: ReviewFixLineKind::Removed, text: decode_line(line, &encoding), old: Some((first + offset + 1) as u32), new: None });
    }
    for (offset, line) in new_lines.iter().enumerate() {
        emit(&mut patch, b'+', line);
        shown.push(ReviewFixLine { kind: ReviewFixLineKind::Added, text: decode_line(line, &encoding), old: None, new: Some((first + offset + 1) as u32) });
    }
    let shift = new_lines.len() as i64 - (last - first) as i64;
    for (offset, line) in lines[last..after].iter().enumerate() {
        emit(&mut patch, b' ', line);
        let number = (last + offset + 1) as i64;
        shown.push(ReviewFixLine { kind: ReviewFixLineKind::Context, text: decode_line(line, &encoding), old: Some(number as u32), new: Some((number + shift) as u32) });
    }
    let old_text = lines[first..last].iter().map(|line| decode_line(line, &encoding)).collect::<Vec<_>>().join("\n");
    Ok(LinePatch { patch, old_text, lines: shown })
}

// ---------------------------------------------------------------------------
// The pull request in the local repository
// ---------------------------------------------------------------------------

/// The pull request's own commits: `base` = merge base of `head` and the target, `commits` =
/// `git log --no-merges --topo-order base..head`, newest first.
#[derive(Debug, Clone)]
pub struct PrRange {
    pub base: String,
    pub head: String,
    pub commits: Vec<FixupTarget>,
}

/// `refs/remotes/<remote>/<branch>` for the pull request's target (both names checked like refs).
pub(crate) fn target_ref(remote: &str, branch: &str) -> CoreResult<String> {
    for name in [remote, branch] {
        util::check_ref_name(name).map_err(|reason| CoreError::not_allowed(format!("“{name}” is not a valid name for a branch or remote: {reason}")))?;
    }
    Ok(format!("refs/remotes/{remote}/{branch}"))
}

pub(crate) async fn pr_range(core: &Core, repo_id: &str, head: &str, target_ref: &str) -> CoreResult<PrRange> {
    let head = graph::resolve_commit(core, repo_id, head)
        .await
        .map_err(|_| CoreError::not_found(format!("The pull request's newest commit {} is not in this repository yet. Fetch or check out its branch first.", short(head))))?;
    let target = graph::resolve_commit(core, repo_id, target_ref)
        .await
        .map_err(|_| CoreError::not_found(format!("“{}” is not in this repository yet. Fetch first.", target_ref.trim_start_matches("refs/remotes/"))))?;
    let out = read(core, repo_id)?.args(["merge-base", head.as_str(), target.as_str()]).run_raw().await?;
    let base = out.stdout_text();
    if !out.success() || !graph::is_full_sha(&base) {
        return Err(CoreError::not_allowed("The pull request's branch and its target have no history in common."));
    }
    let log = read(core, repo_id)?.args(["log", "--no-merges", "--topo-order", "--no-show-signature", "-z", "--format=%H%x1f%s"]).arg(format!("{base}..{head}")).run().await?;
    let commits = util::split_z(&log.stdout)
        .filter_map(|record| {
            let text = util::decode_lossy(record);
            let (sha, summary) = text.trim_start_matches('\n').split_once('\x1f')?;
            graph::is_full_sha(sha).then(|| FixupTarget { sha: sha.to_string(), summary: summary.to_string(), reason: None })
        })
        .collect();
    Ok(PrRange { base, head, commits })
}

/// Files the pull request changes, renamed ones under their new name.
pub(crate) async fn changed_paths(core: &Core, repo_id: &str, range: &PrRange) -> CoreResult<Vec<String>> {
    let out = read(core, repo_id)?
        .args(["-c", "core.quotePath=false", "diff", "--name-only", "-z", "-M", "--no-ext-diff", range.base.as_str(), range.head.as_str()])
        .run()
        .await?;
    Ok(util::split_z(&out.stdout).map(util::decode_lossy).filter(|path| !path.is_empty()).collect())
}

/// The file at the pull request's newest commit, as bytes.
pub(crate) async fn head_blob(core: &Core, repo_id: &str, head: &str, path: &str) -> CoreResult<Vec<u8>> {
    let out = read(core, repo_id)?.args(["cat-file", "blob"]).arg(format!("{head}:{path}")).run_raw().await?;
    if !out.success() {
        return Err(CoreError::not_found(format!("“{path}” does not exist in the pull request's newest commit.")));
    }
    if out.stdout.len() > MAX_FILE_BYTES {
        return Err(CoreError::not_allowed(format!("“{path}” is too large for a suggested fix.")));
    }
    Ok(out.stdout)
}

/// Commits `git blame` names for lines `start..=end` at `head`.
async fn blamed_commits(core: &Core, repo_id: &str, head: &str, path: &str, start: u32, end: u32) -> CoreResult<HashSet<String>> {
    let out = read(core, repo_id)?.args(["blame", "--porcelain", "-L"]).arg(format!("{start},{end}")).arg(head).args(["--", path]).run().await?;
    let mut found = HashSet::new();
    for line in out.stdout_lines() {
        let text = util::decode_lossy(line);
        let mut parts = text.split(' ');
        if let (Some(sha), Some(_), Some(_)) = (parts.next(), parts.next(), parts.next()) {
            if graph::is_full_sha(sha) {
                found.insert(sha.to_string());
            }
        }
    }
    Ok(found)
}

/// The commit a fix for lines `start..=end` of `path` belongs to: the newest pull request commit blame
/// names for these lines (`Blame`), else the newest pull request commit that changes the file (`File`),
/// else none – the user chooses.
pub(crate) async fn fixup_target(core: &Core, repo_id: &str, range: &PrRange, path: &str, start: u32, end: u32) -> CoreResult<Option<FixupTarget>> {
    let blamed = blamed_commits(core, repo_id, &range.head, path, start, end).await?;
    if let Some(found) = range.commits.iter().find(|commit| blamed.contains(&commit.sha)) {
        return Ok(Some(FixupTarget { reason: Some(FixupReason::Blame), ..found.clone() }));
    }
    let out = read(core, repo_id)?
        .env("GIT_LITERAL_PATHSPECS", "1")
        .args(["log", "-1", "--no-merges", "--topo-order", "--format=%H"])
        .arg(format!("{}..{}", range.base, range.head))
        .args(["--", path])
        .run()
        .await?;
    let sha = out.stdout_text();
    Ok(range.commits.iter().find(|commit| commit.sha == sha).map(|commit| FixupTarget { reason: Some(FixupReason::File), ..commit.clone() }))
}

// ---------------------------------------------------------------------------
// Taking a fix over
// ---------------------------------------------------------------------------

/// What a takeover can change.
const CHANGES: [RepoChange; 4] = [RepoChange::Index, RepoChange::Refs, RepoChange::Head, RepoChange::Worktree];
/// `git apply` as line staging calls it.
const APPLY: [&str; 6] = ["-c", "apply.whitespace=nowarn", "-c", "apply.ignoreWhitespace=no", "apply", "--whitespace=nowarn"];

/// Commits a suggested fix as `fixup! <subject of target>` on the checked-out pull request branch
/// through the normal commit path (hooks, signing). Everything is checked again: path and lines, the
/// target among the pull request's commits, the file among its changed files; inside the write lock the
/// branch, that it contains the pull request's newest commit, that nothing is staged, that the file is
/// unchanged and that the patch fits. Consecutive takeovers for the same pull request form one undo step.
pub async fn review_fix_apply(core: &Core, repo_id: String, number: u64, fix: ReviewFixInput, target: String) -> CoreResult<ReviewFixApplied> {
    let path = history::normalize_rel_path(&fix.path)?;
    let RepoApi { api, repo, remote } = host::api_for_repo(core, &repo_id, None).await?;
    let hoster = host::host(api.kind);
    let summary = hoster.pr_head(core, &api, &repo, number).await?;
    let branch = local_branch(hoster, &summary, number);
    let range = pr_range(core, &repo_id, &fix.head_sha, &target_ref(&remote, &summary.target_branch)?).await?;
    let wanted = target.trim().to_ascii_lowercase();
    let Some(chosen) = range.commits.iter().find(|commit| commit.sha == wanted).cloned() else {
        return Err(CoreError::not_allowed("The chosen commit is not one of the pull request's commits."));
    };
    if !changed_paths(core, &repo_id, &range).await?.contains(&path) {
        return Err(CoreError::not_allowed(format!("“{path}” is not changed by this pull request.")));
    }
    let blob = head_blob(core, &repo_id, &range.head, &path).await?;
    let patch = line_patch(&path, &blob, fix.start_line, fix.end_line, &fix.new_text)?;
    let message = format!("fixup! {}\n", chosen.summary);
    let take = TakeOver { repo_id: &repo_id, number, branch: &branch, path: &path, range: &range, patch: &patch.patch, message: &message };
    core.with_write_lock(&repo_id, &CHANGES, take.run(core)).await
}

struct TakeOver<'a> {
    repo_id: &'a str,
    number: u64,
    branch: &'a str,
    path: &'a str,
    range: &'a PrRange,
    patch: &'a [u8],
    message: &'a str,
}

impl TakeOver<'_> {
    async fn run(self, core: &Core) -> CoreResult<ReviewFixApplied> {
        let TakeOver { repo_id, number, branch, path, range, patch, message } = self;
        let status = read_status(core, repo_id).await?;
        if status.operation.is_some() {
            return Err(CoreError::new(ErrorCode::OperationInProgress, "A merge, rebase, cherry-pick or revert is in progress. Finish or abort it first."));
        }
        let head_before = match &status.head {
            Head::Branch { branch: current, sha } if current == branch => sha.clone(),
            _ => return Err(CoreError::not_allowed(format!("Check out “{branch}” first – the fixup commit belongs on the pull request's branch."))),
        };
        let contains = read(core, repo_id)?.args(["merge-base", "--is-ancestor", range.head.as_str(), head_before.as_str()]).run_raw().await?.success();
        if !contains {
            return Err(CoreError::new(ErrorCode::StaleState, format!("“{branch}” does not contain the pull request's newest commit yet. Pull first, then take the fix over again.")));
        }
        if !status.staged.is_empty() {
            return Err(CoreError::new(ErrorCode::DirtyWorktree, "Something is staged. Commit or unstage it first – the fixup commit contains only the fix."));
        }
        if status.unstaged.iter().chain(status.conflicted.iter()).any(|file| file.path == path) {
            return Err(CoreError::new(ErrorCode::DirtyWorktree, format!("“{path}” has uncommitted changes. Commit or discard them first.")));
        }
        let check = core.git_for(repo_id)?.args(APPLY).args(["--check", "--index"]).stdin(patch.to_vec()).run_raw().await?;
        if !check.success() {
            return Err(CoreError::new(ErrorCode::Conflict, format!("The fix no longer fits “{path}” – its lines changed since the suggestion. Suggest the fix again."))
                .with_git_output(check.stderr_text()));
        }
        core.git_for(repo_id)?.args(APPLY).arg("--index").stdin(patch.to_vec()).run().await?;
        if let Err(error) = commit::run_commit(core, repo_id, &["commit", "--cleanup=verbatim", "-F", "-"], message).await {
            restore(core, repo_id, path).await;
            return Err(error);
        }
        let after = read(core, repo_id)?.args(["rev-parse", "--verify", "HEAD^{commit}"]).run_text().await?;
        let undo_label = record_fixups(core, repo_id, number, &format!("refs/heads/{branch}"), &head_before, &after).await?;
        let subjects = read(core, repo_id)?.args(["log", "-z", "--format=%s"]).arg(format!("{}..HEAD", range.base)).run().await?;
        let fixups = util::split_z(&subjects.stdout).filter(|subject| subject.starts_with(b"fixup!")).count() as u32;
        Ok(ReviewFixApplied { commit: after, summary: message.trim_end().to_string(), fixups, base: range.base.clone(), undo_label })
    }
}

/// After a failed commit (hook, signing): index and file of `path` back to HEAD – the file had no own
/// changes before (checked), so this is exactly the state before the takeover.
async fn restore(core: &Core, repo_id: &str, path: &str) {
    for args in [["reset", "-q", "HEAD", "--", path], ["checkout", "-q", "HEAD", "--", path]] {
        let result = match core.git_for(repo_id) {
            Ok(git) => git.env("GIT_LITERAL_PATHSPECS", "1").args(args).run().await.map(|_| ()),
            Err(error) => Err(error),
        };
        if let Err(error) = result {
            log::warn!("“{path}” not restored after the failed fixup commit: {}", error.message);
        }
    }
}

/// Whether the newest undo entry is this pull request's `review_fixups` entry and ends where this
/// takeover started.
fn continues(entry: &UndoEntry, number: u64, branch_ref: &str, before: &str) -> bool {
    let step = &entry.payload["steps"][0];
    entry.action == UndoAction::ReviewFixups.as_str()
        && entry.payload["pr"].as_u64() == Some(number)
        && entry.payload["steps"].as_array().is_some_and(|steps| steps.len() == 1)
        && step["ref"].as_str() == Some(branch_ref)
        && step["after"].as_str() == Some(before)
}

/// One undo step for a row of takeovers: a continuing entry is replaced by one from its start to `after`.
async fn record_fixups(core: &Core, repo_id: &str, number: u64, branch_ref: &str, before: &str, after: &str) -> CoreResult<String> {
    let mut from = before.to_string();
    let mut count: u64 = 1;
    if let Some(entry) = undo::next_undo(core, repo_id, "")?.filter(|entry| continues(entry, number, branch_ref, before)) {
        from = entry.payload["steps"][0]["before"].as_str().unwrap_or(before).to_string();
        count = entry.payload["fixups"].as_u64().unwrap_or(1) + 1;
        core.db.with(|c| db::undo::delete(c, &entry.id))?;
        undo::delete_backup_refs(core, repo_id, &entry.id).await?;
    }
    let label = if count == 1 { format!("Undo 1 fixup commit for #{number}") } else { format!("Undo {count} fixup commits for #{number}") };
    let mut extra = Map::new();
    extra.insert("pr".into(), json!(number));
    extra.insert("branch".into(), json!(branch_ref));
    extra.insert("fixups".into(), json!(count));
    extra.insert("refuseIfPushed".into(), json!(true));
    undo::record_group(
        core,
        GroupRecord {
            id: undo::new_id(),
            repo_id: repo_id.to_string(),
            action: UndoAction::ReviewFixups,
            label: label.clone(),
            refs: vec![RefMove::new(branch_ref, Some(from.as_str()), Some(after))],
            head_before: branch_ref.to_string(),
            head_after: Some(branch_ref.to_string()),
            snapshot: None,
            extra,
        },
    )
    .await?;
    Ok(label)
}

/// The local branch of a pull request, as `pr_checkout` creates it: the source branch, or the host's
/// branch name for a pull request from another repository.
pub(crate) fn local_branch(hoster: &dyn Host, summary: &PrSummary, number: u64) -> String {
    if summary.is_fork || summary.source_branch.is_empty() {
        hoster.fork_branch(number)
    } else {
        summary.source_branch.clone()
    }
}

#[cfg(test)]
pub(crate) mod test_host;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod apply_tests;
