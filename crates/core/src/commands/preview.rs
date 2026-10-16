//! Conflict preview: would a merge, cherry-pick, revert, rebase or patch stop on conflicts?
//!
//! Nothing in the working directory, the index or the refs changes. `git merge-tree --write-tree`
//! computes a merge as objects only; a series (cherry-pick, revert, rebase) is replayed one commit
//! at a time onto the tree the previous step produced. Intermediate trees become loose commits
//! (`commit-tree`, no ref points at them; `git gc` removes them later). A patch is checked with
//! `git apply --check` against the working directory.
//!
//! Runs as a background read (`GIT_OPTIONAL_LOCKS=0`, not in the activity log) under a job:
//! `job_cancel(job_id)` stops it. Git failures are not errors of the call but the result `unknown`
//! with a reason – the dialogs show them as a state.

use crate::app::Core;
use crate::commands::patch::MAX_PATCH_BYTES;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::{GitCmd, GitOutput};
use crate::jobs::CancelToken;
use crate::model::{ConflictPreview, LineRange, PreviewOp};
use crate::util;

/// At most this many commits of a series are replayed.
pub const MAX_SERIES: usize = 200;
/// `git merge-tree --merge-base` exists from this version on.
pub(crate) const MERGE_BASE_OPTION: (u32, u32, u32) = (2, 40, 0);
/// Conflicted blobs larger than this get no line ranges (a huge file stays a file name).
pub(crate) const MAX_RANGE_BLOB: u64 = 8 * 1024 * 1024;
/// At most this many conflicted files of one merge get line ranges.
pub(crate) const MAX_RANGE_FILES: usize = 50;
/// Identity of the intermediate commits (never on a ref, never shown).
const PREVIEW_IDENTITY: [(&str, &str); 4] = [
    ("GIT_AUTHOR_NAME", "forkyard"),
    ("GIT_AUTHOR_EMAIL", "forkyard@localhost"),
    ("GIT_COMMITTER_NAME", "forkyard"),
    ("GIT_COMMITTER_EMAIL", "forkyard@localhost"),
];

/// Simulates `op` and says whether it would stop on conflicts. Job under `job_id` (cancellable).
pub async fn conflict_preview(core: &Core, repo_id: String, job_id: String, op: PreviewOp) -> CoreResult<ConflictPreview> {
    core.repo_path(&repo_id)?;
    let job = core.start_job(&job_id, Some(&repo_id))?;
    let result = preview(core, &repo_id, job.token(), op).await;
    job.finish(&result);
    result
}

/// Errors that stay errors of the call; everything else becomes `unknown` with the message.
fn stays_error(code: ErrorCode) -> bool {
    matches!(code, ErrorCode::Cancelled | ErrorCode::RepoUntrusted | ErrorCode::PathNotFound | ErrorCode::GitMissing | ErrorCode::GitTooOld)
}

async fn preview(core: &Core, repo_id: &str, cancel: &CancelToken, op: PreviewOp) -> CoreResult<ConflictPreview> {
    let outcome = match op {
        PreviewOp::Merge { theirs } => merge(core, repo_id, cancel, &theirs).await,
        PreviewOp::CherryPick { commits } => series(core, repo_id, cancel, &commits, Step::Pick).await,
        PreviewOp::Revert { commits } => series(core, repo_id, cancel, &commits, Step::Revert).await,
        PreviewOp::Rebase { onto, upstream, branch, commits } => {
            rebase(core, repo_id, cancel, &onto, upstream.as_deref(), branch.as_deref(), commits.as_deref()).await
        }
        PreviewOp::Patch { text } => patch(core, repo_id, cancel, &text).await,
    };
    match outcome {
        Err(e) if stays_error(e.code) => Err(e),
        Err(e) => Ok(ConflictPreview::Unknown { reason: e.message }),
        ok => ok,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    /// Apply the commit's changes (cherry-pick, rebase).
    Pick,
    /// Take the commit's changes back (revert).
    Revert,
}

/// A read call of the preview: background (no optional locks), not logged, cancellable; the
/// caller evaluates the exit code.
async fn git(core: &Core, repo_id: &str, cancel: &CancelToken, args: &[&str], stdin: Option<Vec<u8>>) -> CoreResult<GitOutput> {
    let mut cmd = core.git_for(repo_id)?.read_only().no_log().check(false).args(args);
    if let Some(data) = stdin {
        cmd = cmd.stdin(data);
    }
    cmd.run_stream(cancel, &mut |_| {}).await
}

/// Git's first error line as the reason (without "fatal:"/"error:"), the output attached (redacted).
fn git_failure(out: &GitOutput) -> CoreError {
    let text = out.stderr_text();
    let line = text
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("hint:"))
        .map(|line| line.trim_start_matches("fatal: ").trim_start_matches("error: ").to_string())
        .unwrap_or_else(|| "Git could not simulate this.".to_string());
    CoreError::unknown(line).with_git_output(text)
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(7)]
}

/// The commit `rev` points to; never a leading `-` (no option injection).
async fn commit_of(core: &Core, repo_id: &str, cancel: &CancelToken, rev: &str) -> CoreResult<String> {
    let rev = rev.trim();
    if rev.is_empty() || rev.starts_with('-') {
        return Err(CoreError::not_found(format!("“{rev}” is not a commit.")));
    }
    let spec = format!("{rev}^{{commit}}");
    let out = git(core, repo_id, cancel, &["rev-parse", "--verify", "--quiet", &spec], None).await?;
    let sha = out.stdout_text();
    if !out.success() || sha.is_empty() {
        return Err(CoreError::not_found(format!("The commit “{rev}” wasn't found.")));
    }
    Ok(sha)
}

/// One conflicted file of a `git merge-tree` result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MergedConflict {
    /// For display (lossy UTF-8).
    pub path: String,
    /// As Git wrote it (`-z`), byte for byte.
    pub raw_path: Vec<u8>,
    /// Where the conflicts sit, in the first side's lines (only with `with_ranges`).
    pub ranges: Vec<LineRange>,
}

/// Result of one `git merge-tree --write-tree`.
pub(crate) enum Merged {
    Tree(String),
    /// `tree`: the merge result, with conflict markers in the conflicted text files.
    Conflicts { tree: String, files: Vec<MergedConflict> },
}

fn paths(files: Vec<MergedConflict>) -> Vec<String> {
    files.into_iter().map(|file| file.path).collect()
}

/// `git merge-tree --write-tree` of `ours` and `theirs`, with `base` as the merge base (otherwise
/// Git finds it). `with_ranges`: for each conflicted file (at most `MAX_RANGE_FILES`) the merged
/// blob is read from the result tree and its conflict markers give the line ranges. The conflict
/// style is fixed to `merge`, so the repository's `merge.conflictStyle` does not move them.
pub(crate) async fn merge_tree(core: &Core, repo_id: &str, cancel: &CancelToken, base: Option<&str>, ours: &str, theirs: &str, with_ranges: bool) -> CoreResult<Merged> {
    let base_arg = base.map(|sha| format!("--merge-base={sha}"));
    let mut args = vec!["-c", "merge.conflictStyle=merge", "merge-tree", "--write-tree", "--name-only", "--no-messages", "-z"];
    if let Some(arg) = &base_arg {
        args.push(arg.as_str());
    }
    args.push(ours);
    args.push(theirs);
    let out = git(core, repo_id, cancel, &args, None).await?;
    // `-z --name-only --no-messages`: the tree, then one NUL-terminated path per conflicted file.
    let mut records = util::split_z(&out.stdout);
    let tree = records.next().map(util::decode_lossy).unwrap_or_default();
    match out.code {
        Some(0) if !tree.is_empty() => Ok(Merged::Tree(tree)),
        Some(1) => {
            let mut files: Vec<MergedConflict> = Vec::new();
            for record in records {
                if record.is_empty() || files.iter().any(|file| file.raw_path == record) {
                    continue;
                }
                files.push(MergedConflict { path: util::decode_lossy(record), raw_path: record.to_vec(), ranges: Vec::new() });
            }
            if with_ranges {
                for file in files.iter_mut().take(MAX_RANGE_FILES) {
                    cancel.check()?;
                    if let Some(blob) = conflicted_blob(core, repo_id, cancel, &tree, &file.raw_path).await? {
                        file.ranges = markers::ranges(&blob);
                    }
                }
            }
            Ok(Merged::Conflicts { tree, files })
        }
        _ => Err(git_failure(&out)),
    }
}

/// The merged version of a conflicted file from a `merge-tree` result tree (with its conflict
/// markers); `None` if it is no blob there (deleted, submodule) or larger than `MAX_RANGE_BLOB`.
pub(crate) async fn conflicted_blob(core: &Core, repo_id: &str, cancel: &CancelToken, tree: &str, raw_path: &[u8]) -> CoreResult<Option<Vec<u8>>> {
    let mut spec = format!("{tree}:").into_bytes();
    spec.extend_from_slice(raw_path);
    let read = || -> CoreResult<GitCmd> { Ok(core.git_for(repo_id)?.read_only().no_log().check(false)) };
    let kind = read()?.args(["cat-file", "-t"]).arg_bytes(&spec).run_stream(cancel, &mut |_| {}).await?;
    if !kind.success() || kind.stdout_text().trim() != "blob" {
        return Ok(None);
    }
    let size = read()?.args(["cat-file", "-s"]).arg_bytes(&spec).run_stream(cancel, &mut |_| {}).await?;
    let bytes: u64 = size.stdout_text().trim().parse().unwrap_or(u64::MAX);
    if !size.success() || bytes > MAX_RANGE_BLOB {
        return Ok(None);
    }
    let blob = read()?.args(["cat-file", "blob"]).arg_bytes(&spec).run_stream(cancel, &mut |_| {}).await?;
    Ok(blob.success().then_some(blob.stdout))
}

async fn merge(core: &Core, repo_id: &str, cancel: &CancelToken, theirs: &str) -> CoreResult<ConflictPreview> {
    let ours = commit_of(core, repo_id, cancel, "HEAD").await?;
    let theirs = commit_of(core, repo_id, cancel, theirs).await?;
    Ok(match merge_tree(core, repo_id, cancel, None, &ours, &theirs, false).await? {
        Merged::Tree(_) => ConflictPreview::Clean,
        Merged::Conflicts { files, .. } => ConflictPreview::Conflicts { files: paths(files), at_commit: None },
    })
}

fn too_many() -> ConflictPreview {
    ConflictPreview::Unknown { reason: format!("More than {MAX_SERIES} commits – the preview only checks series of up to {MAX_SERIES}.") }
}

/// Cherry-pick or revert of `commits` on top of HEAD.
async fn series(core: &Core, repo_id: &str, cancel: &CancelToken, commits: &[String], step: Step) -> CoreResult<ConflictPreview> {
    if commits.len() > MAX_SERIES {
        return Ok(too_many());
    }
    let start = commit_of(core, repo_id, cancel, "HEAD").await?;
    let mut resolved = Vec::with_capacity(commits.len());
    for rev in commits {
        resolved.push(commit_of(core, repo_id, cancel, rev).await?);
    }
    replay(core, repo_id, cancel, start, &resolved, step).await
}

/// Replays `commits` one after the other onto `start`; stops at the first conflict.
async fn replay(core: &Core, repo_id: &str, cancel: &CancelToken, start: String, commits: &[String], step: Step) -> CoreResult<ConflictPreview> {
    if commits.is_empty() {
        return Ok(ConflictPreview::Clean);
    }
    if commits.len() > MAX_SERIES {
        return Ok(too_many());
    }
    if core.git.info()?.version < MERGE_BASE_OPTION {
        return Ok(ConflictPreview::Unknown { reason: "Previewing a series of commits needs Git 2.40 or later.".to_string() });
    }
    let mut current = start;
    for (index, commit) in commits.iter().enumerate() {
        cancel.check()?;
        let parent = only_parent(core, repo_id, cancel, commit).await?;
        let (base, theirs) = match step {
            Step::Pick => (parent.as_str(), commit.as_str()),
            Step::Revert => (commit.as_str(), parent.as_str()),
        };
        let merged = merge_tree(core, repo_id, cancel, Some(base), &current, theirs, false).await?;
        match merged {
            Merged::Conflicts { files, .. } => return Ok(ConflictPreview::Conflicts { files: paths(files), at_commit: Some(commit.clone()) }),
            Merged::Tree(tree) if index + 1 < commits.len() => current = wrap_tree(core, repo_id, cancel, &tree).await?,
            Merged::Tree(_) => {}
        }
    }
    Ok(ConflictPreview::Clean)
}

/// The single parent of `commit`; a root or merge commit cannot be replayed with one base.
async fn only_parent(core: &Core, repo_id: &str, cancel: &CancelToken, commit: &str) -> CoreResult<String> {
    let out = git(core, repo_id, cancel, &["rev-list", "--parents", "-n", "1", commit], None).await?;
    if !out.success() {
        return Err(git_failure(&out));
    }
    let text = out.stdout_text();
    let mut parents = text.split_whitespace().skip(1);
    match (parents.next(), parents.next()) {
        (Some(parent), None) => Ok(parent.to_string()),
        (None, _) => Err(CoreError::unknown(format!("{} is the first commit of the repository; the preview can't replay it.", short(commit)))),
        (Some(_), Some(_)) => Err(CoreError::unknown(format!("{} is a merge commit; the preview can't replay it.", short(commit)))),
    }
}

/// A loose commit around an intermediate tree, so that the next step has a commit to merge with.
async fn wrap_tree(core: &Core, repo_id: &str, cancel: &CancelToken, tree: &str) -> CoreResult<String> {
    let mut cmd = core.git_for(repo_id)?.read_only().no_log().check(false).args(["commit-tree", "--no-gpg-sign", tree, "-m", "forkyard: preview"]);
    for (key, value) in PREVIEW_IDENTITY {
        cmd = cmd.env(key, value);
    }
    let out = cmd.run_stream(cancel, &mut |_| {}).await?;
    if !out.success() {
        return Err(git_failure(&out));
    }
    Ok(out.stdout_text())
}

/// `branch` (default HEAD) onto `onto`: the commits `git rebase` would replay (own commits
/// without merges and without those already upstream), or the explicit order `commits`.
async fn rebase(
    core: &Core,
    repo_id: &str,
    cancel: &CancelToken,
    onto: &str,
    upstream: Option<&str>,
    branch: Option<&str>,
    commits: Option<&[String]>,
) -> CoreResult<ConflictPreview> {
    let onto_sha = commit_of(core, repo_id, cancel, onto).await?;
    let list: Vec<String> = match commits {
        Some(list) => {
            if list.len() > MAX_SERIES {
                return Ok(too_many());
            }
            let mut resolved = Vec::with_capacity(list.len());
            for rev in list {
                resolved.push(commit_of(core, repo_id, cancel, rev).await?);
            }
            resolved
        }
        None => {
            let tip_rev = match branch.map(|name| name.trim().trim_start_matches("refs/heads/")).filter(|name| !name.is_empty()) {
                Some(name) => format!("refs/heads/{name}"),
                None => "HEAD".to_string(),
            };
            let tip = commit_of(core, repo_id, cancel, &tip_rev).await?;
            let from = match upstream.map(str::trim).filter(|rev| !rev.is_empty()) {
                Some(rev) => commit_of(core, repo_id, cancel, rev).await?,
                None => onto_sha.clone(),
            };
            let range = format!("{from}...{tip}");
            let out = git(core, repo_id, cancel, &["rev-list", "--reverse", "--no-merges", "--right-only", "--cherry-pick", &range], None).await?;
            if !out.success() {
                return Err(git_failure(&out));
            }
            out.stdout_lines().into_iter().map(util::decode_lossy).filter(|sha| !sha.is_empty()).collect()
        }
    };
    replay(core, repo_id, cancel, onto_sha, &list, Step::Pick).await
}

/// `git apply --check` against the working directory, like `patch_apply` with `check_only`.
async fn patch(core: &Core, repo_id: &str, cancel: &CancelToken, text: &str) -> CoreResult<ConflictPreview> {
    if text.trim().is_empty() {
        return Ok(ConflictPreview::Unknown { reason: "The patch is empty.".to_string() });
    }
    if text.len() > MAX_PATCH_BYTES {
        return Ok(ConflictPreview::Unknown { reason: "The patch is larger than 32 MB.".to_string() });
    }
    let args = ["-c", "apply.whitespace=nowarn", "-c", "apply.ignoreWhitespace=no", "apply", "--whitespace=nowarn", "--check"];
    let out = git(core, repo_id, cancel, &args, Some(text.as_bytes().to_vec())).await?;
    if out.success() {
        return Ok(ConflictPreview::Clean);
    }
    let files = patch_conflicts(&out.stderr_text());
    if files.is_empty() {
        return Err(git_failure(&out));
    }
    Ok(ConflictPreview::Conflicts { files, at_commit: None })
}

/// The files `git apply --check` names in its error lines (each once, in order).
fn patch_conflicts(stderr: &str) -> Vec<String> {
    let mut files: Vec<String> = Vec::new();
    for line in stderr.lines() {
        let Some(rest) = line.trim().strip_prefix("error: ") else { continue };
        let file = if let Some(place) = rest.strip_prefix("patch failed: ") {
            place.rsplit_once(':').map_or(place, |(file, _)| file)
        } else if let Some(file) = rest.strip_suffix(": patch does not apply") {
            file
        } else if let Some(file) = rest.strip_suffix(": No such file or directory") {
            file
        } else if let Some(file) = rest.strip_suffix(": already exists in working directory") {
            file
        } else if let Some(file) = rest.strip_suffix(": does not exist in index") {
            file
        } else {
            continue;
        };
        let file = file.trim().to_string();
        if !file.is_empty() && !files.contains(&file) {
            files.push(file);
        }
    }
    files
}

pub mod markers;

#[cfg(test)]
mod tests;
