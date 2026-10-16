//! Committing and changing the message.
//!
//! Both commands go through `git commit` so that hooks, signing and finishing a merge behave
//! as in the terminal. The hooks' output is captured per hook: for the duration of the call
//! `core.hooksPath` points to a folder with small wrapper scripts that start the real hook
//! and record its output and exit code.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde_json::json;

use crate::app::Core;
use crate::commands::status::read_status;
use crate::db;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::events::names;
use crate::git::{errors, GitCmd};
use crate::model::{
    CommitDraft, CommitResult, FileChange, Head, HookOutput, HookOutputEvent, OperationKind, PushResult, RepoChange, Status,
};
use crate::undo::{self, UndoAction, UndoRecord};
use crate::util;

/// What a commit can change (`Operation`: a running merge is concluded).
const COMMIT_CHANGES: [RepoChange; 4] = [RepoChange::Index, RepoChange::Refs, RepoChange::Head, RepoChange::Operation];
/// Hooks whose failure prevents the commit.
pub(crate) const ABORTING_HOOKS: [&str; 4] = ["pre-commit", "pre-merge-commit", "prepare-commit-msg", "commit-msg"];
/// The wrappers live under this folder of the data directory during a call.
pub(crate) const HOOKS_TMP_DIR: &str = "hooks-tmp";
/// Environment variables for the wrapper script.
const ENV_HOOK_REAL: &str = "FORKYARD_HOOK_REAL";
const ENV_HOOK_LOG: &str = "FORKYARD_HOOK_LOG";
/// The maximum amount of a hook's output that is passed on.
const MAX_HOOK_OUTPUT: usize = 256 * 1024;

/// Starts the real hook of the same name, records output and exit code and passes both on to
/// Git unchanged. Runs via Git's sh on Windows.
const HOOK_WRAPPER: &str = r#"#!/bin/sh
# forkyard: captures the output of the actual hook.
name=${0##*/}
name=${name##*\\}
if [ -z "$FORKYARD_HOOK_REAL" ] || [ -z "$FORKYARD_HOOK_LOG" ]; then
  exit 0
fi
tmp="$FORKYARD_HOOK_LOG/$name.$$.tmp"
"$FORKYARD_HOOK_REAL/$name" "$@" >"$tmp" 2>&1
code=$?
cat "$tmp" >&2
cat "$tmp" >>"$FORKYARD_HOOK_LOG/$name.out"
rm -f "$tmp"
printf '%s %s\n' "$name" "$code" >>"$FORKYARD_HOOK_LOG/order"
exit $code
"#;

/// Commit (optionally amend, without hooks, stage everything, push afterwards). Idempotent via `op_id`.
///
/// `expected_head` (only with `amend`): the commit the UI showed as the "last commit". If HEAD
/// is a different one by now (commit in the terminal, pull), nothing is changed:
/// `stale_state` – otherwise "Amend last commit" would hit a commit the user has never seen.
#[allow(clippy::too_many_arguments)]
pub async fn commit_create(
    core: &Core,
    repo_id: String,
    op_id: String,
    summary: String,
    description: String,
    amend: bool,
    skip_hooks: bool,
    push_after: bool,
    stage_all: bool,
    expected_head: Option<String>,
) -> CoreResult<CommitResult> {
    core.idempotent(&op_id, async {
        let message = build_message(&summary, &description)?;
        let request = CommitRequest { summary: summary.trim(), message: &message, amend, skip_hooks, stage_all, expected_head: expected_head.as_deref() };
        let (mut result, branch) =
            core.with_write_lock(&repo_id, &COMMIT_CHANGES, commit_locked(core, &repo_id, &request)).await?;
        if push_after {
            // Outside the write lock: push takes it itself. The commit stays valid even if the
            // push fails.
            let pushed = crate::commands::sync::push(core, repo_id.clone(), op_id.clone(), branch, None, None, false, None).await;
            result.push = Some(match pushed {
                Ok(done) => done,
                Err(e) => PushResult::Rejected { reason: e.message },
            });
        }
        Ok(result)
    })
    .await
}

/// Changes the message of the last commit without touching the index. `sha`: the commit whose
/// message the UI showed for editing; if HEAD is a different one by now, nothing is changed
/// (`stale_state`).
pub async fn commit_reword(core: &Core, repo_id: String, summary: String, description: String, sha: Option<String>) -> CoreResult<CommitResult> {
    let message = build_message(&summary, &description)?;
    core.with_write_lock(&repo_id, &[RepoChange::Refs, RepoChange::Head], async {
        let status = read_status(core, &repo_id).await?;
        check_committable(&status)?;
        if let Some(op) = &status.operation {
            return Err(operation_error(op.kind, "change the message"));
        }
        let (branch, old_sha) = branch_and_sha(&status.head);
        let Some(old_sha) = old_sha else {
            return Err(CoreError::not_allowed("There's no commit yet whose message could be changed."));
        };
        ensure_head_is(sha.as_deref(), &old_sha)?;
        let undo_id = undo::new_id();
        undo::create_backup_ref(core, &repo_id, &undo_id, "before", &old_sha).await?;
        // `--only` without paths: the commit keeps its tree, staged changes stay staged.
        // `--allow-empty`: even a commit without changes may get a new message.
        let args = ["commit", "--amend", "--only", "--allow-empty", "--cleanup=verbatim", "-F", "-"];
        let hooks = match run_commit(core, &repo_id, &args, &message).await {
            Ok(hooks) => hooks,
            Err(e) => {
                drop_backup(core, &repo_id, &undo_id).await;
                return Err(e);
            }
        };
        let sha = head_sha(core, &repo_id).await?;
        let head = head_label(&status.head);
        undo::record(
            core,
            UndoRecord {
                id: undo_id,
                repo_id: repo_id.clone(),
                worktree_path: String::new(),
                action: UndoAction::Reword,
                label: format!("Undo new message {}", quoted(&summary)),
                ref_name: branch.as_ref().map(|b| format!("refs/heads/{b}")),
                ref_before: Some(old_sha.clone()),
                ref_after: Some(sha.clone()),
                head_before: if branch.is_some() { head.clone() } else { old_sha },
                head_after: Some(if branch.is_some() { head } else { sha.clone() }),
                payload: json!({ "summary": summary.trim() }),
            },
        )
        .await?;
        Ok(CommitResult { sha, push: None, hooks })
    })
    .await
}

struct CommitRequest<'a> {
    summary: &'a str,
    message: &'a str,
    amend: bool,
    skip_hooks: bool,
    stage_all: bool,
    /// Only with `amend`: the commit the UI showed as the last one.
    expected_head: Option<&'a str>,
}

/// `stale_state` if the UI considers a different commit the last one than Git does (a SHA may
/// be abbreviated). Without a value the current HEAD applies.
fn ensure_head_is(expected: Option<&str>, head: &str) -> CoreResult<()> {
    let Some(expected) = expected.map(str::trim).filter(|sha| !sha.is_empty()) else { return Ok(()) };
    let (expected, head) = (expected.to_ascii_lowercase(), head.to_ascii_lowercase());
    if head.starts_with(&expected) || expected.starts_with(&head) {
        return Ok(());
    }
    Err(CoreError::new(
        ErrorCode::StaleState,
        "The last commit has changed in the meantime (for example through a commit in the terminal or a pull). Nothing was changed. Take a look at the new last commit and then try again.",
    ))
}

/// The commit itself, under the write lock. Additionally returns the current branch (for the
/// push afterwards).
async fn commit_locked(core: &Core, repo_id: &str, req: &CommitRequest<'_>) -> CoreResult<(CommitResult, Option<String>)> {
    let status = read_status(core, repo_id).await?;
    check_committable(&status)?;
    let merging = match &status.operation {
        None => false,
        Some(op) if op.kind == OperationKind::Merge && !req.amend => true,
        Some(op) => return Err(operation_error(op.kind, if req.amend { "amend the last commit" } else { "commit" })),
    };
    let (branch, old_sha) = branch_and_sha(&status.head);
    if req.amend && old_sha.is_none() {
        return Err(CoreError::not_allowed("There's no commit yet that could be amended."));
    }
    if let (true, Some(head)) = (req.amend, old_sha.as_deref()) {
        ensure_head_is(req.expected_head, head)?;
    }

    let has_staged = if req.stage_all {
        core.git_for(repo_id)?.args(["add", "-A"]).run().await?;
        index_differs_from_head(core, repo_id).await?
    } else {
        !status.staged.is_empty()
    };
    if !has_staged && !req.amend && !merging {
        let message = if req.stage_all {
            "There are no changes to commit."
        } else {
            "Nothing is staged. Stage some changes first."
        };
        return Err(CoreError::new(ErrorCode::NothingToCommit, message));
    }

    let mut args = vec!["commit", "--cleanup=verbatim", "-F", "-"];
    if req.amend {
        args.push("--amend");
        if !has_staged {
            // Only the message changes; the tree stays as it was.
            args.push("--allow-empty");
        }
    }
    if req.skip_hooks {
        args.push("--no-verify");
    }

    let undo_id = undo::new_id();
    if let (true, Some(old)) = (req.amend, &old_sha) {
        undo::create_backup_ref(core, repo_id, &undo_id, "before", old).await?;
    }
    let hooks = match run_commit(core, repo_id, &args, req.message).await {
        Ok(hooks) => hooks,
        Err(e) => {
            if req.amend {
                drop_backup(core, repo_id, &undo_id).await;
            }
            return Err(e);
        }
    };
    let sha = head_sha(core, repo_id).await?;

    if let Err(e) = core.db.with(|c| db::drafts::set(c, repo_id, "", &CommitDraft::default())) {
        log::warn!("Commit draft not cleared: {}", e.message);
    }

    let head = head_label(&status.head);
    let on_branch = branch.is_some();
    let label = if req.amend {
        format!("Undo amend of {}", quoted(req.summary))
    } else {
        format!("Undo commit {}", quoted(req.summary))
    };
    undo::record(
        core,
        UndoRecord {
            id: undo_id,
            repo_id: repo_id.to_string(),
            worktree_path: String::new(),
            action: if req.amend { UndoAction::Amend } else { UndoAction::Commit },
            label,
            ref_name: branch.as_ref().map(|b| format!("refs/heads/{b}")),
            ref_before: old_sha.clone(),
            ref_after: Some(sha.clone()),
            head_before: if on_branch { head.clone() } else { old_sha.unwrap_or_default() },
            head_after: Some(if on_branch { head } else { sha.clone() }),
            payload: json!({ "summary": req.summary, "merge": merging }),
        },
    )
    .await?;
    Ok((CommitResult { sha, push: None, hooks }, branch))
}

/// Summary, blank line, description – exactly as it should be in the commit.
pub(crate) fn build_message(summary: &str, description: &str) -> CoreResult<String> {
    let summary = summary.replace("\r\n", "\n");
    let summary = summary.trim();
    if summary.is_empty() {
        return Err(CoreError::new(
            ErrorCode::EmptyMessage,
            "The commit message is empty. Enter a summary.",
        ));
    }
    let description = description.replace("\r\n", "\n");
    let description = description.trim_end().trim_start_matches('\n');
    let mut message = String::with_capacity(summary.len() + description.len() + 3);
    message.push_str(summary);
    message.push('\n');
    if !description.trim().is_empty() {
        message.push('\n');
        message.push_str(description);
        message.push('\n');
    }
    Ok(message)
}

/// Identity set, no open conflict.
pub(crate) fn check_committable(status: &Status) -> CoreResult<()> {
    if !status.identity_set {
        return Err(CoreError::new(
            ErrorCode::IdentityMissing,
            "Your name and email for commits aren't set. Add them in Settings under “Profile”.",
        ));
    }
    if !status.conflicted.is_empty() {
        return Err(CoreError::new(
            ErrorCode::Conflict,
            format!("There are still unresolved conflicts in {}. Resolve them first.", file_list(&status.conflicted)),
        ));
    }
    Ok(())
}

pub(crate) fn operation_error(kind: OperationKind, what: &str) -> CoreError {
    let (name, hint) = match kind {
        OperationKind::Merge => ("a merge", "Finish the merge with a commit or abort it first."),
        OperationKind::Rebase => ("a rebase", "Continue the rebase with “Continue” or abort it."),
        OperationKind::CherryPick => ("a cherry-pick", "Finish the cherry-pick with “Continue” or abort it."),
        OperationKind::Revert => ("a revert", "Finish the revert with “Continue” or abort it."),
    };
    CoreError::new(ErrorCode::OperationInProgress, format!("There is {name} in progress, so you can't {what} right now. {hint}"))
}

/// "‘a.txt’" or "3 files (a.txt, b.txt, …)".
fn file_list(files: &[FileChange]) -> String {
    const MAX: usize = 5;
    if let [only] = files {
        return quoted(&only.path);
    }
    let mut names: Vec<&str> = files.iter().take(MAX).map(|f| f.path.as_str()).collect();
    if files.len() > MAX {
        names.push("…");
    }
    format!("{} files ({})", files.len(), names.join(", "))
}

/// First line in single quotes, shortened for undo sentences.
pub(crate) fn quoted(text: &str) -> String {
    const MAX: usize = 60;
    let line = text.trim().lines().next().unwrap_or("").trim();
    if line.chars().count() > MAX {
        format!("‘{}…’", line.chars().take(MAX).collect::<String>())
    } else {
        format!("‘{line}’")
    }
}

/// HEAD as undo records it: `refs/heads/<branch>` or the SHA.
pub(crate) fn head_label(head: &Head) -> String {
    match head {
        Head::Branch { branch, .. } | Head::Unborn { branch } => format!("refs/heads/{branch}"),
        Head::Detached { sha } => sha.clone(),
    }
}

fn branch_and_sha(head: &Head) -> (Option<String>, Option<String>) {
    match head {
        Head::Branch { branch, sha } => (Some(branch.clone()), Some(sha.clone())),
        Head::Detached { sha } => (None, Some(sha.clone())),
        Head::Unborn { branch } => (Some(branch.clone()), None),
    }
}

async fn head_sha(core: &Core, repo_id: &str) -> CoreResult<String> {
    core.git_for(repo_id)?.args(["rev-parse", "--verify", "HEAD^{commit}"]).read_only().no_log().run_text().await
}

/// Are there staged changes compared to HEAD (or compared to the empty tree)?
async fn index_differs_from_head(core: &Core, repo_id: &str) -> CoreResult<bool> {
    let out = core
        .git_for(repo_id)?
        .args(["-c", "diff.autoRefreshIndex=false", "diff", "--cached", "--quiet", "--no-ext-diff"])
        .read_only()
        .no_log()
        .run_raw()
        .await?;
    match out.code {
        Some(0) => Ok(false),
        Some(1) => Ok(true),
        code => Err(errors::classify("diff", code, &out.stdout, &out.stderr)),
    }
}

async fn drop_backup(core: &Core, repo_id: &str, undo_id: &str) {
    if let Err(e) = undo::delete_backup_refs(core, repo_id, undo_id).await {
        log::warn!("Backup ref of {undo_id} not removed: {}", e.message);
    }
}

/// Runs `git commit` with the message on stdin, captures the hook output and reports it as
/// `hook:output`. A hook that rejects the commit yields `hook_failed`.
async fn run_commit(core: &Core, repo_id: &str, args: &[&str], message: &str) -> CoreResult<Vec<HookOutput>> {
    run_commit_on(core, repo_id, args, message, None).await
}

/// `run_commit` on another index file (`GIT_INDEX_FILE`): "Compose commits" builds every commit
/// on a temporary index; hooks see that index, as with `git commit <paths>` in the terminal.
pub(crate) async fn run_commit_on(core: &Core, repo_id: &str, args: &[&str], message: &str, index_file: Option<&Path>) -> CoreResult<Vec<HookOutput>> {
    let capture = Hooks::start(core, repo_id).await;
    let mut cmd = capture.wrap(core.git_for(repo_id)?);
    if let Some(index) = index_file {
        cmd = cmd.env("GIT_INDEX_FILE", index);
    }
    let out = cmd.args(args).stdin(message.as_bytes().to_vec()).check(false).run().await;
    let hooks = capture.finish(core, repo_id);
    let out = out?;
    if out.success() {
        return Ok(hooks);
    }
    if let Some(error) = hook_failure(&hooks, &ABORTING_HOOKS, &out, "the commit") {
        return Err(error);
    }
    Err(errors::classify("commit", out.code, &out.stdout, &out.stderr))
}

/// The `hook_failed` error if one of the `aborting` hooks ran with exit code ≠ 0.
/// `what` completes the sentence: "The hook ‘x’ rejected <what>".
pub(crate) fn hook_failure(hooks: &[HookOutput], aborting: &[&str], out: &crate::git::GitOutput, what: &str) -> Option<CoreError> {
    let failed = hooks.iter().find(|h| h.exit_code != 0 && aborting.contains(&h.hook.as_str()))?;
    let output = if failed.output.is_empty() { out.stderr_text() } else { failed.output.clone() };
    Some(
        CoreError::new(
            ErrorCode::HookFailed,
            format!("The hook {} rejected {what} (exit code {}).", quoted(&failed.hook), failed.exit_code),
        )
        .with_git_output(output),
    )
}

/// Captures the hook output for a Git call (commit, merge, continue, push): `start`, then
/// build the call with `wrap` (before the subcommand!), then `finish`. If the repository has
/// no hooks or the folder cannot be created, `wrap` has no effect and `finish` returns
/// nothing; the hooks still run then.
pub(crate) struct Hooks(Option<HookCapture>);

impl Hooks {
    pub(crate) async fn start(core: &Core, repo_id: &str) -> Hooks {
        match HookCapture::prepare(core, repo_id).await {
            Ok(capture) => Hooks(capture),
            Err(e) => {
                // Without wrappers the hooks still run, only their output is not attributed per hook.
                log::warn!("Hook output cannot be captured: {}", e.message);
                Hooks(None)
            }
        }
    }

    /// Sets `core.hooksPath` to the wrappers for this one call. Must come before the
    /// subcommand: `hooks.wrap(core.git_for(id)?).args(["merge", …])`.
    pub(crate) fn wrap(&self, cmd: GitCmd) -> GitCmd {
        let Some(capture) = &self.0 else { return cmd };
        let mut hooks_path = OsString::from("core.hooksPath=");
        hooks_path.push(shell_path(&capture.wrap));
        cmd.arg("-c")
            .arg(hooks_path)
            .env(ENV_HOOK_REAL, shell_path(&capture.real))
            .env(ENV_HOOK_LOG, shell_path(&capture.log))
    }

    /// Reads the output, removes the folder and reports `hook:output` per hook.
    pub(crate) fn finish(self, core: &Core, repo_id: &str) -> Vec<HookOutput> {
        let hooks = self.0.map(HookCapture::finish).unwrap_or_default();
        for hook in &hooks {
            core.emit(
                names::HOOK_OUTPUT,
                &HookOutputEvent { repo_id: repo_id.to_string(), hook: hook.hook.clone(), output: hook.output.clone(), exit_code: hook.exit_code },
            );
        }
        hooks
    }
}

/// Cleans up wrapper folders that an earlier run left behind (a hook background process held
/// a file open, the app crashed). Only folders older than `older_than`: a second instance
/// with the same data directory may be using one right now.
pub(crate) fn cleanup_hook_dirs(data_dir: &Path, older_than: std::time::Duration) -> usize {
    let Ok(entries) = std::fs::read_dir(data_dir.join(HOOKS_TMP_DIR)) else { return 0 };
    let mut removed = 0;
    for entry in entries.flatten() {
        let old_enough = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age >= older_than);
        if old_enough && std::fs::remove_dir_all(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Temporary folder with the wrapper scripts and the captured output.
struct HookCapture {
    root: PathBuf,
    wrap: PathBuf,
    log: PathBuf,
    /// The repository's hooks folder (`.git/hooks` or `core.hooksPath`).
    real: PathBuf,
}

impl HookCapture {
    /// `None` if the repository has no hooks.
    async fn prepare(core: &Core, repo_id: &str) -> CoreResult<Option<HookCapture>> {
        let repo = core.repo_path(repo_id)?;
        let out = core.git_for(repo_id)?.args(["rev-parse", "--git-path", "hooks"]).read_only().no_log().run().await?;
        let listed = out.stdout.strip_suffix(b"\n").unwrap_or(&out.stdout);
        let listed = util::bytes_to_path(listed.strip_suffix(b"\r").unwrap_or(listed));
        // A relative path applies from the working directory in which the hooks run.
        let real = if listed.is_absolute() { listed } else { repo.join(listed) };
        let hooks = hook_files(&real);
        if hooks.is_empty() {
            return Ok(None);
        }
        let root = core.data_dir().join(HOOKS_TMP_DIR).join(util::new_id());
        let wrap = root.join("wrap");
        let log = root.join("log");
        std::fs::create_dir_all(&wrap)?;
        std::fs::create_dir_all(&log)?;
        for name in &hooks {
            let path = wrap.join(name);
            std::fs::write(&path, HOOK_WRAPPER)?;
            make_executable(&path)?;
        }
        Ok(Some(HookCapture { root, wrap, log, real }))
    }

    /// Reads which hooks ran and removes the folder. Hooks without output that succeeded are
    /// left out.
    fn finish(self) -> Vec<HookOutput> {
        let order = std::fs::read(self.log.join("order")).unwrap_or_default();
        let mut hooks: Vec<HookOutput> = Vec::new();
        for line in util::decode_lossy(&order).lines() {
            let Some((name, code)) = line.trim().rsplit_once(' ') else { continue };
            let code: i32 = code.parse().unwrap_or(1);
            match hooks.iter_mut().find(|h| h.hook == name) {
                // Ran several times (e.g. reference-transaction): a failure stays.
                Some(seen) => {
                    if code != 0 {
                        seen.exit_code = code;
                    }
                }
                None => {
                    let raw = std::fs::read(self.log.join(format!("{name}.out"))).unwrap_or_default();
                    let output = util::truncate_str(util::decode_text(&raw).0.trim_end(), MAX_HOOK_OUTPUT);
                    hooks.push(HookOutput { hook: name.to_string(), output, exit_code: code });
                }
            }
        }
        if let Err(e) = std::fs::remove_dir_all(&self.root) {
            log::warn!("Temporary hook folder not removed: {e}");
        }
        hooks.retain(|h| !h.output.is_empty() || h.exit_code != 0);
        hooks
    }
}

/// Names of the hooks in the folder: executable files without an extension (on Windows also `.exe`).
pub(crate) fn hook_files(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut names = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_name) = entry.file_name().into_string() else { continue };
        let name = if cfg!(windows) { file_name.strip_suffix(".exe").unwrap_or(&file_name) } else { file_name.as_str() };
        if name.is_empty() || name.contains('.') {
            continue;
        }
        // Follows symbolic links (hook managers like to link).
        let Ok(meta) = std::fs::metadata(entry.path()) else { continue };
        if meta.is_file() && is_executable(&meta) && !names.iter().any(|n| n == name) {
            names.push(name.to_string());
        }
    }
    names.sort();
    names
}

#[cfg(unix)]
fn is_executable(meta: &std::fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn is_executable(_meta: &std::fs::Metadata) -> bool {
    true
}

#[cfg(unix)]
fn make_executable(path: &Path) -> CoreResult<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))?;
    Ok(())
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> CoreResult<()> {
    Ok(())
}

/// Path as Git and sh understand it: on Windows with forward slashes.
fn shell_path(path: &Path) -> OsString {
    if cfg!(windows) {
        let text = path.to_string_lossy().replace('\\', "/");
        OsString::from(text.strip_prefix("//?/").unwrap_or(&text))
    } else {
        path.as_os_str().to_os_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::status::read_status;
    use crate::testkit::{TestCore, TestRepo, AUTHOR_NAME};

    fn write_hook(repo: &TestRepo, name: &str, body: &str) {
        let dir = repo.path().join(".git").join("hooks");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        make_executable(&path).unwrap();
    }

    async fn commit(tc: &TestCore, id: &str, summary: &str, description: &str) -> CoreResult<CommitResult> {
        commit_create(tc, id.to_string(), util::new_id(), summary.into(), description.into(), false, false, false, false, None).await
    }

    async fn commit_with(tc: &TestCore, id: &str, summary: &str, amend: bool, skip_hooks: bool, stage_all: bool) -> CoreResult<CommitResult> {
        commit_create(tc, id.to_string(), util::new_id(), summary.into(), String::new(), amend, skip_hooks, false, stage_all, None).await
    }

    /// Message of the commit as it is stored in the object (without the trailing line break).
    fn message_of(repo: &TestRepo, rev: &str) -> String {
        let raw = repo.git(&["cat-file", "commit", rev]);
        raw.split_once("\n\n").map(|(_, body)| body.to_string()).unwrap_or_default()
    }

    fn backup_ref(repo: &TestRepo, entry_id: &str, name: &str) -> String {
        repo.git(&["rev-parse", &undo::backup_ref_name(entry_id, name)])
    }

    #[tokio::test]
    async fn commits_staged_changes_and_records_undo() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let before = repo.head();
        repo.write_file("a.txt", "eins\n");
        repo.write_file("b.txt", "bleibt unstaged\n");
        repo.git(&["add", "a.txt"]);
        let id = tc.open(&repo).await.repo.id;
        core_draft(&tc, &id, "Entwurf");
        tc.events.clear();

        let result = commit(&tc, &id, "  Tippfehler behoben  ", "Erste Zeile\n\n# keine Kommentarzeile\n  eingerückt\n\n").await.unwrap();
        assert_eq!(result.sha, repo.head());
        assert_ne!(result.sha, before);
        assert_eq!(result.push, None);
        assert!(result.hooks.is_empty());
        assert_eq!(repo.git(&["rev-parse", "HEAD^"]), before);
        assert_eq!(message_of(&repo, "HEAD"), "Tippfehler behoben\n\nErste Zeile\n\n# keine Kommentarzeile\n  eingerückt");
        assert_eq!(repo.git(&["show", "--name-only", "--format=", "HEAD"]), "a.txt");
        // What was not staged stays where it is.
        let status = read_status(&tc, &id).await.unwrap();
        assert!(status.staged.is_empty());
        assert_eq!(status.unstaged.len(), 1);

        let changed = tc.events.named(names::REPO_CHANGED);
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0]["what"], json!(["index", "refs", "head", "operation"]));
        // The draft is cleared.
        assert_eq!(tc.db.with(|c| db::drafts::get(c, &id, "")).unwrap(), CommitDraft::default());

        let entry = undo::next_undo(&tc, &id, "").unwrap().unwrap();
        assert_eq!(entry.action, "commit");
        assert_eq!(entry.label, "Undo commit ‘Tippfehler behoben’");
        assert_eq!(entry.ref_name.as_deref(), Some("refs/heads/main"));
        assert_eq!(entry.ref_before.as_deref(), Some(before.as_str()));
        assert_eq!(entry.ref_after.as_deref(), Some(result.sha.as_str()));
        assert_eq!(entry.head_before, "refs/heads/main");
        assert_eq!(entry.head_after.as_deref(), Some("refs/heads/main"));
        assert_eq!(entry.payload["summary"], "Tippfehler behoben");
        assert_eq!(entry.payload["merge"], false);
    }

    fn core_draft(tc: &TestCore, id: &str, summary: &str) {
        let draft = CommitDraft { summary: summary.into(), description: "x".into(), amend: false };
        tc.db.with(|c| db::drafts::set(c, id, "", &draft)).unwrap();
        assert_eq!(tc.db.with(|c| db::drafts::get(c, id, "")).unwrap(), draft);
    }

    #[tokio::test]
    async fn summary_only_message_and_crlf_input() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        repo.write_file("a.txt", "x\n");
        repo.git(&["add", "-A"]);
        let id = tc.open(&repo).await.repo.id;
        commit(&tc, &id, "Nur Summary", "  \n").await.unwrap();
        assert_eq!(repo.git(&["cat-file", "commit", "HEAD"]).split_once("\n\n").unwrap().1, "Nur Summary");

        repo.write_file("a.txt", "y\n");
        repo.git(&["add", "-A"]);
        commit(&tc, &id, "Grüße", "Zeile 1\r\nZeile 2\r\n").await.unwrap();
        assert_eq!(message_of(&repo, "HEAD"), "Grüße\n\nZeile 1\nZeile 2");
    }

    #[tokio::test]
    async fn rejects_empty_message_and_nothing_staged() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let before = repo.head();
        repo.write_file("a.txt", "x\n");
        let id = tc.open(&repo).await.repo.id;

        let err = commit(&tc, &id, "   ", "Text").await.unwrap_err();
        assert_eq!(err.code, ErrorCode::EmptyMessage);
        // Nothing staged (the file is only untracked).
        let err = commit(&tc, &id, "Leer", "").await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NothingToCommit);
        assert!(err.message.contains("staged"), "{}", err.message);
        assert_eq!(repo.head(), before);
        assert!(undo::next_undo(&tc, &id, "").unwrap().is_none());

        // With "stage everything", but without any change.
        repo.remove_file("a.txt");
        let err = commit_with(&tc, &id, "Leer", false, false, true).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NothingToCommit);
        assert_eq!(repo.head(), before);
    }

    #[tokio::test]
    async fn stage_all_takes_odd_names_and_keeps_bytes() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        repo.commit_file("alt.txt", "weg\n", "Alt");
        repo.write_file("mit leerzeichen/Größe übersicht.txt", "Zeile 1\r\nZeile 2\r\n");
        repo.write_file("ohne-umbruch.txt", "kein Zeilenende");
        repo.write_file("README.md", "# Geändert\n");
        repo.remove_file("alt.txt");
        let id = tc.open(&repo).await.repo.id;

        let result = commit_with(&tc, &id, "Alles auf einmal", false, false, true).await.unwrap();
        assert_eq!(result.sha, repo.head());
        let mut names: Vec<String> =
            repo.git(&["show", "--name-status", "--format=", "-z", "HEAD"]).split('\0').map(str::to_string).collect();
        names.retain(|n| !n.is_empty());
        assert_eq!(
            names,
            vec!["M", "README.md", "D", "alt.txt", "A", "mit leerzeichen/Größe übersicht.txt", "A", "ohne-umbruch.txt"]
        );
        // Byte-exact: CRLF stays CRLF, a missing line ending stays missing.
        let crlf = repo.git_output(&["cat-file", "blob", "HEAD:mit leerzeichen/Größe übersicht.txt"]).stdout;
        assert_eq!(crlf, b"Zeile 1\r\nZeile 2\r\n");
        let bare = repo.git_output(&["cat-file", "blob", "HEAD:ohne-umbruch.txt"]).stdout;
        assert_eq!(bare, b"kein Zeilenende");
        let status = read_status(&tc, &id).await.unwrap();
        assert!(status.staged.is_empty() && status.unstaged.is_empty());
    }

    #[tokio::test]
    async fn identity_missing_is_reported_before_git_runs() {
        let tc = TestCore::new().await;
        let repo = TestRepo::without_identity();
        repo.write_file("a.txt", "x\n");
        repo.git(&["add", "-A"]);
        let id = tc.open(&repo).await.repo.id;
        let err = commit(&tc, &id, "Ohne Autor", "").await.unwrap_err();
        assert_eq!(err.code, ErrorCode::IdentityMissing);
        assert!(err.message.contains("Settings"), "{}", err.message);
        assert!(repo.git_output(&["rev-parse", "--verify", "HEAD"]).status.code() != Some(0));
    }

    #[tokio::test]
    async fn first_commit_in_empty_repo() {
        let tc = TestCore::new().await;
        let repo = TestRepo::new();
        repo.write_file("a.txt", "x\n");
        let id = tc.open(&repo).await.repo.id;

        let err = commit_with(&tc, &id, "Amend ohne Commit", true, false, true).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);

        let result = commit_with(&tc, &id, "Erster Commit", false, false, true).await.unwrap();
        assert_eq!(result.sha, repo.head());
        assert_eq!(repo.git(&["rev-list", "--count", "HEAD"]), "1");
        let entry = undo::next_undo(&tc, &id, "").unwrap().unwrap();
        assert_eq!(entry.ref_name.as_deref(), Some("refs/heads/main"));
        assert_eq!(entry.ref_before, None);
        assert_eq!(entry.ref_after.as_deref(), Some(result.sha.as_str()));
        assert_eq!(entry.head_before, "refs/heads/main");
    }

    #[tokio::test]
    async fn commit_on_detached_head() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let before = repo.head();
        repo.git(&["checkout", "-q", "--detach"]);
        repo.write_file("a.txt", "x\n");
        repo.git(&["add", "-A"]);
        let id = tc.open(&repo).await.repo.id;

        let result = commit(&tc, &id, "Ohne Branch", "").await.unwrap();
        assert_eq!(repo.head(), result.sha);
        assert_eq!(repo.git(&["rev-parse", "main"]), before, "main stays where it is");
        assert!(!repo.git_output(&["symbolic-ref", "-q", "HEAD"]).status.success());
        let entry = undo::next_undo(&tc, &id, "").unwrap().unwrap();
        assert_eq!(entry.ref_name, None);
        assert_eq!(entry.head_before, before);
        assert_eq!(entry.head_after.as_deref(), Some(result.sha.as_str()));
    }

    #[tokio::test]
    async fn amend_keeps_author_and_creates_backup_ref() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let parent = repo.head();
        let old = repo.commit_file("a.txt", "eins\n", "Alter Text");
        let author_date = repo.git(&["log", "-1", "--format=%at"]);
        repo.write_file("a.txt", "zwei\n");
        repo.git(&["add", "-A"]);
        let id = tc.open(&repo).await.repo.id;

        let result = commit_with(&tc, &id, "Neuer Text", true, false, false).await.unwrap();
        assert_ne!(result.sha, old);
        assert_eq!(repo.head(), result.sha);
        assert_eq!(repo.git(&["rev-parse", "HEAD^"]), parent);
        assert_eq!(message_of(&repo, "HEAD"), "Neuer Text");
        assert_eq!(repo.git_output(&["cat-file", "blob", "HEAD:a.txt"]).stdout, b"zwei\n");
        assert_eq!(repo.git(&["log", "-1", "--format=%at"]), author_date, "author date stays");
        assert_eq!(repo.git(&["log", "-1", "--format=%an"]), AUTHOR_NAME);

        let entry = undo::next_undo(&tc, &id, "").unwrap().unwrap();
        assert_eq!(entry.action, "amend");
        assert_eq!(entry.label, "Undo amend of ‘Neuer Text’");
        assert_eq!(entry.ref_before.as_deref(), Some(old.as_str()));
        assert_eq!(entry.ref_after.as_deref(), Some(result.sha.as_str()));
        assert_eq!(backup_ref(&repo, &entry.id, "before"), old);

        // Only change the message: nothing staged, the tree stays.
        let tree = repo.git(&["rev-parse", "HEAD^{tree}"]);
        let again = commit_with(&tc, &id, "Nur die Message", true, false, false).await.unwrap();
        assert_eq!(repo.git(&["rev-parse", "HEAD^{tree}"]), tree);
        assert_eq!(message_of(&repo, "HEAD"), "Nur die Message");
        assert_eq!(repo.git(&["rev-parse", "HEAD^"]), parent);
        assert_ne!(again.sha, result.sha);
    }

    #[tokio::test]
    async fn open_conflict_blocks_and_resolved_merge_is_concluded() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        repo.checkout_new("feature");
        let theirs = repo.commit_file("README.md", "# Feature\n", "Feature");
        repo.checkout("main");
        let ours = repo.commit_file("README.md", "# Main\n", "Main");
        assert!(!repo.merge("feature"));
        let id = tc.open(&repo).await.repo.id;

        let err = commit(&tc, &id, "Merge", "").await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Conflict);
        assert!(err.message.contains("README.md"), "{}", err.message);
        // "Stage everything" must not silently mark an open conflict as resolved.
        let err = commit_with(&tc, &id, "Merge", false, false, true).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Conflict);
        assert!(!repo.git(&["ls-files", "-u"]).is_empty(), "the conflict is still open");

        repo.write_file("README.md", "# Beides\n");
        repo.git(&["add", "README.md"]);
        let err = commit_with(&tc, &id, "Amend im Merge", true, false, false).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::OperationInProgress);
        assert!(repo.path().join(".git").join("MERGE_HEAD").exists());

        let result = commit(&tc, &id, "Merge von feature", "Konflikt in README gelöst").await.unwrap();
        assert_eq!(repo.git(&["rev-list", "--parents", "-1", "HEAD"]), format!("{} {ours} {theirs}", result.sha));
        assert!(!repo.path().join(".git").join("MERGE_HEAD").exists());
        assert_eq!(message_of(&repo, "HEAD"), "Merge von feature\n\nKonflikt in README gelöst");
        let status = read_status(&tc, &id).await.unwrap();
        assert!(status.operation.is_none());
        let entry = undo::next_undo(&tc, &id, "").unwrap().unwrap();
        assert_eq!(entry.action, "commit");
        assert_eq!(entry.payload["merge"], true);
        assert_eq!(entry.ref_before.as_deref(), Some(ours.as_str()));
    }

    #[tokio::test]
    async fn merge_without_changes_can_still_be_concluded() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        repo.checkout_new("feature");
        repo.commit_file("f.txt", "f\n", "Feature");
        repo.checkout("main");
        repo.commit_file("m.txt", "m\n", "Main");
        // Merge without commit in which our side wins completely: nothing is staged.
        repo.git(&["merge", "--no-commit", "-s", "ours", "feature"]);
        let id = tc.open(&repo).await.repo.id;
        assert!(read_status(&tc, &id).await.unwrap().staged.is_empty());
        let result = commit(&tc, &id, "Merge ohne Inhalt", "").await.unwrap();
        assert_eq!(repo.git(&["rev-list", "--parents", "-1", "HEAD"]).split(' ').count(), 3);
        assert_eq!(result.sha, repo.head());
    }

    #[tokio::test]
    async fn commit_is_refused_during_cherry_pick() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        repo.checkout_new("feature");
        let pick = repo.commit_file("README.md", "# Feature\n", "Feature");
        repo.checkout("main");
        let before = repo.commit_file("README.md", "# Main\n", "Main");
        assert!(!repo.git_output(&["cherry-pick", &pick]).status.success());
        repo.write_file("README.md", "# Beides\n");
        repo.git(&["add", "README.md"]);
        let id = tc.open(&repo).await.repo.id;
        let err = commit(&tc, &id, "Von Hand", "").await.unwrap_err();
        assert_eq!(err.code, ErrorCode::OperationInProgress);
        assert!(err.message.contains("cherry-pick"), "{}", err.message);
        assert_eq!(repo.head(), before);
    }

    #[tokio::test]
    async fn hook_output_is_captured_per_hook() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        write_hook(&repo, "pre-commit", "echo 'Prüfe Dateien'\necho 'auf stderr' >&2");
        write_hook(&repo, "commit-msg", "echo \"Message-Datei: $(cat \"$1\")\"");
        write_hook(&repo, "post-commit", "echo 'Fertig: Grüße'");
        write_hook(&repo, "prepare-commit-msg", "exit 0");
        repo.write_file("a.txt", "x\n");
        repo.git(&["add", "-A"]);
        let id = tc.open(&repo).await.repo.id;
        tc.events.clear();

        let result = commit(&tc, &id, "Mit Hooks", "").await.unwrap();
        assert_eq!(result.sha, repo.head());
        // A silent, successful hook (prepare-commit-msg) does not show up.
        assert_eq!(
            result.hooks,
            vec![
                HookOutput { hook: "pre-commit".into(), output: "Prüfe Dateien\nauf stderr".into(), exit_code: 0 },
                HookOutput { hook: "commit-msg".into(), output: "Message-Datei: Mit Hooks".into(), exit_code: 0 },
                HookOutput { hook: "post-commit".into(), output: "Fertig: Grüße".into(), exit_code: 0 },
            ]
        );
        let events = tc.events.named(names::HOOK_OUTPUT);
        assert_eq!(events.len(), 3);
        assert_eq!(events[0], json!({ "repoId": id, "hook": "pre-commit", "output": "Prüfe Dateien\nauf stderr", "exitCode": 0 }));
        // The temporary folder is gone again, and the repo's configuration stayed untouched.
        let leftovers = std::fs::read_dir(tc.data_dir().join("hooks-tmp")).map(|d| d.count()).unwrap_or(0);
        assert_eq!(leftovers, 0);
        assert!(!repo.git_output(&["config", "--get", "core.hooksPath"]).status.success());
    }

    #[tokio::test]
    async fn failing_pre_commit_hook_stops_the_commit() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let before = repo.head();
        write_hook(&repo, "pre-commit", "echo 'Lint: 2 Fehler in a.txt'\nexit 3");
        repo.write_file("a.txt", "x\n");
        repo.git(&["add", "-A"]);
        let id = tc.open(&repo).await.repo.id;
        tc.events.clear();

        let op = util::new_id();
        let err = commit_create(&tc, id.clone(), op.clone(), "Abgelehnt".into(), String::new(), false, false, false, false, None)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::HookFailed);
        assert!(err.message.contains("pre-commit") && err.message.contains('3'), "{}", err.message);
        assert_eq!(err.git_output.as_deref(), Some("Lint: 2 Fehler in a.txt"));
        assert_eq!(repo.head(), before);
        assert!(undo::next_undo(&tc, &id, "").unwrap().is_none());
        let events = tc.events.named(names::HOOK_OUTPUT);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["exitCode"], 3);
        // The change stays staged, and the same operation ID may try again.
        assert_eq!(read_status(&tc, &id).await.unwrap().staged.len(), 1);

        // "Without hooks" skips pre-commit; post-commit still runs and is reported.
        write_hook(&repo, "post-commit", "echo 'nachher'");
        let result = commit_create(&tc, id.clone(), op, "Ohne Hooks".into(), String::new(), false, true, false, false, None).await.unwrap();
        assert_eq!(result.sha, repo.head());
        assert_ne!(result.sha, before);
        assert_eq!(result.hooks, vec![HookOutput { hook: "post-commit".into(), output: "nachher".into(), exit_code: 0 }]);
    }

    #[tokio::test]
    async fn failing_commit_msg_hook_and_custom_hooks_path() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let before = repo.head();
        // Hooks in a separate folder with a space in its name (core.hooksPath, relative).
        let dir = repo.subdir("meine hooks");
        let hook = dir.join("commit-msg");
        std::fs::write(&hook, "#!/bin/sh\ngrep -q '^TICKET-' \"$1\" || { echo 'Ticket fehlt'; exit 1; }\n").unwrap();
        make_executable(&hook).unwrap();
        repo.git(&["config", "core.hooksPath", "meine hooks"]);
        repo.write_file("a.txt", "x\n");
        repo.git(&["add", "a.txt"]);
        let id = tc.open(&repo).await.repo.id;

        let err = commit(&tc, &id, "Ohne Ticket", "").await.unwrap_err();
        assert_eq!(err.code, ErrorCode::HookFailed);
        assert!(err.message.contains("commit-msg"), "{}", err.message);
        assert_eq!(err.git_output.as_deref(), Some("Ticket fehlt"));
        assert_eq!(repo.head(), before);

        let result = commit(&tc, &id, "TICKET-1 mit Ticket", "").await.unwrap();
        assert!(result.hooks.is_empty());
        assert_eq!(message_of(&repo, "HEAD"), "TICKET-1 mit Ticket");
        assert_eq!(repo.git(&["config", "--get", "core.hooksPath"]), "meine hooks");
    }

    #[tokio::test]
    async fn same_op_id_commits_only_once() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        repo.write_file("a.txt", "x\n");
        repo.git(&["add", "-A"]);
        let id = tc.open(&repo).await.repo.id;
        let op = "op-1".to_string();
        let first = commit_create(&tc, id.clone(), op.clone(), "Einmal".into(), String::new(), false, false, false, false, None).await.unwrap();
        repo.write_file("a.txt", "y\n");
        repo.git(&["add", "-A"]);
        let err = commit_create(&tc, id.clone(), op, "Einmal".into(), String::new(), false, false, false, false, None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Duplicate);
        assert_eq!(repo.head(), first.sha);
    }

    #[tokio::test]
    async fn foreign_index_lock_is_reported_and_left_alone() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let before = repo.head();
        repo.write_file("a.txt", "x\n");
        repo.git(&["add", "-A"]);
        let id = tc.open(&repo).await.repo.id;
        let lock = repo.path().join(".git").join("index.lock");
        std::fs::write(&lock, "").unwrap();

        let err = commit(&tc, &id, "Gesperrt", "").await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Locked, "{err:?}");
        let err = commit_with(&tc, &id, "Gesperrt", false, false, true).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Locked, "{err:?}");
        assert!(lock.exists(), "a foreign lock is never deleted");
        assert_eq!(repo.head(), before);

        std::fs::remove_file(&lock).unwrap();
        commit(&tc, &id, "Wieder frei", "").await.unwrap();
    }

    #[tokio::test]
    async fn commit_survives_a_failing_push() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        repo.write_file("a.txt", "x\n");
        repo.git(&["add", "-A"]);
        let id = tc.open(&repo).await.repo.id;
        // No remote: the push cannot succeed, the commit stands anyway.
        let result = commit_create(&tc, id, util::new_id(), "Mit Push".into(), String::new(), false, false, true, false, None).await.unwrap();
        assert_eq!(result.sha, repo.head());
        assert!(matches!(result.push, Some(PushResult::Rejected { ref reason }) if !reason.is_empty()), "{:?}", result.push);
    }

    #[tokio::test]
    async fn push_after_commit_reaches_the_remote() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let remote = repo.add_remote();
        repo.write_file("a.txt", "x\n");
        repo.git(&["add", "-A"]);
        let id = tc.open(&repo).await.repo.id;
        tc.events.clear();
        let op_id = util::new_id();
        let result = commit_create(&tc, id.clone(), op_id.clone(), "Mit Push".into(), String::new(), false, false, true, false, None).await.unwrap();
        assert_eq!(
            result.push,
            Some(PushResult::Done { remote: "origin".into(), branch: "main".into(), created_upstream: false, forced: false }),
        );
        assert_eq!(result.sha, repo.head());
        assert_eq!(remote.git(&["rev-parse", "refs/heads/main"]), result.sha, "the commit arrived on the remote");
        assert_eq!(repo.git(&["rev-parse", "refs/remotes/origin/main"]), result.sha);

        // The push runs as a job under the commit's opId (progress, cancel) …
        let done = tc.events.named(names::JOB_DONE);
        assert_eq!(done.len(), 1);
        assert_eq!(done[0]["jobId"], op_id.as_str());
        assert_eq!(done[0]["ok"], true);
        // … and after the commit reports the remote branches that moved.
        let changed: Vec<serde_json::Value> = tc.events.named(names::REPO_CHANGED).into_iter().map(|e| e["what"].clone()).collect();
        assert_eq!(changed, vec![json!(["index", "refs", "head", "operation"]), json!(["refs"])]);

        // Pushed is pushed: the commit is no longer offered for local undo.
        assert!(undo::next_undo(&tc, &id, "").unwrap().is_some());
        assert_eq!(crate::commands::undo::undo_peek(&tc, id.clone()).await.unwrap().undo, None);

        // A rejected push leaves the commit in place and names the reason.
        let other = TestRepo::clone_of(&remote);
        other.commit_file("fremd.txt", "f\n", "Anderswo");
        other.git(&["push", "-q", "origin", "main"]);
        repo.write_file("b.txt", "y\n");
        repo.git(&["add", "-A"]);
        let second = commit_create(&tc, id.clone(), util::new_id(), "Zweiter mit Push".into(), String::new(), false, false, true, false, None).await.unwrap();
        assert_eq!(second.sha, repo.head());
        assert!(matches!(&second.push, Some(PushResult::Rejected { reason }) if reason.contains("origin/main")), "{:?}", second.push);
        assert_ne!(remote.git(&["rev-parse", "refs/heads/main"]), second.sha);
    }

    #[tokio::test]
    async fn reword_changes_only_the_message() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let parent = repo.head();
        let old = repo.commit_file("a.txt", "eins\n", "Alter Text");
        let tree = repo.git(&["rev-parse", "HEAD^{tree}"]);
        let author = repo.git(&["log", "-1", "--format=%an <%ae> %at"]);
        // Staged, unstaged and untracked changes must not slip into the commit.
        repo.write_file("a.txt", "gestaged\n");
        repo.write_file("neu gestaged.txt", "neu\n");
        repo.git(&["add", "-A"]);
        repo.git(&["rm", "-q", "--cached", "README.md"]);
        repo.write_file("a.txt", "gestaged und weiter geändert\n");
        repo.write_file("unverfolgt.txt", "u\n");
        let index_before = repo.git(&["ls-files", "--stage"]);
        let id = tc.open(&repo).await.repo.id;
        tc.events.clear();

        let result = commit_reword(&tc, id.clone(), "Neuer Text".into(), "Mit Beschreibung\n# und Raute".into(), None).await.unwrap();
        assert_ne!(result.sha, old);
        assert_eq!(repo.head(), result.sha);
        assert_eq!(message_of(&repo, "HEAD"), "Neuer Text\n\nMit Beschreibung\n# und Raute");
        assert_eq!(repo.git(&["rev-parse", "HEAD^{tree}"]), tree, "the tree stays");
        assert_eq!(repo.git(&["rev-parse", "HEAD^"]), parent);
        assert_eq!(repo.git(&["log", "-1", "--format=%an <%ae> %at"]), author);
        assert_eq!(repo.git(&["ls-files", "--stage"]), index_before, "the index stays untouched");
        assert_eq!(repo.read_file("a.txt"), "gestaged und weiter geändert\n".as_bytes());
        let status = read_status(&tc, &id).await.unwrap();
        let staged: Vec<&str> = status.staged.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(staged, vec!["README.md", "a.txt", "neu gestaged.txt"]);

        assert_eq!(tc.events.named(names::REPO_CHANGED)[0]["what"], json!(["refs", "head"]));
        let entry = undo::next_undo(&tc, &id, "").unwrap().unwrap();
        assert_eq!(entry.action, "reword");
        assert_eq!(entry.label, "Undo new message ‘Neuer Text’");
        assert_eq!(entry.ref_name.as_deref(), Some("refs/heads/main"));
        assert_eq!(entry.ref_before.as_deref(), Some(old.as_str()));
        assert_eq!(entry.ref_after.as_deref(), Some(result.sha.as_str()));
        assert_eq!(backup_ref(&repo, &entry.id, "before"), old);
    }

    #[tokio::test]
    async fn reword_keeps_merge_parents_and_empty_commits() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        repo.checkout_new("feature");
        let theirs = repo.commit_file("f.txt", "f\n", "Feature");
        repo.checkout("main");
        let ours = repo.commit_file("m.txt", "m\n", "Main");
        assert!(repo.merge("feature"));
        let id = tc.open(&repo).await.repo.id;
        let result = commit_reword(&tc, id.clone(), "Merge mit neuem Text".into(), String::new(), None).await.unwrap();
        assert_eq!(repo.git(&["rev-list", "--parents", "-1", "HEAD"]), format!("{} {ours} {theirs}", result.sha));

        // A commit without changes, on a detached HEAD.
        repo.empty_commit("Leer");
        repo.git(&["checkout", "-q", "--detach"]);
        let old = repo.head();
        let result = commit_reword(&tc, id.clone(), "Leer, aber anders".into(), String::new(), None).await.unwrap();
        assert_eq!(message_of(&repo, "HEAD"), "Leer, aber anders");
        assert_eq!(repo.git(&["rev-parse", "HEAD^{tree}"]), repo.git(&["rev-parse", "HEAD^^{tree}"]));
        let entry = undo::next_undo(&tc, &id, "").unwrap().unwrap();
        assert_eq!(entry.ref_name, None);
        assert_eq!(entry.head_before, old);
        assert_eq!(entry.head_after.as_deref(), Some(result.sha.as_str()));
    }

    #[tokio::test]
    async fn reword_refuses_empty_message_running_operation_and_empty_repo() {
        let tc = TestCore::new().await;
        let empty = TestRepo::new();
        let id = tc.open(&empty).await.repo.id;
        let err = commit_reword(&tc, id, "Text".into(), String::new(), None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);

        let repo = TestRepo::with_commit();
        repo.checkout_new("feature");
        repo.commit_file("README.md", "# Feature\n", "Feature");
        repo.checkout("main");
        let before = repo.commit_file("README.md", "# Main\n", "Main");
        let id = tc.open(&repo).await.repo.id;
        let err = commit_reword(&tc, id.clone(), " \n".into(), "Text".into(), None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::EmptyMessage);

        assert!(!repo.merge("feature"));
        repo.write_file("README.md", "# Beides\n");
        repo.git(&["add", "README.md"]);
        let err = commit_reword(&tc, id.clone(), "Text".into(), String::new(), None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::OperationInProgress);
        assert_eq!(repo.head(), before);
        // No orphaned backup refs.
        assert_eq!(repo.git(&["for-each-ref", "refs/forkyard"]), "");
    }

    #[tokio::test]
    async fn reword_runs_the_commit_msg_hook() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let before = repo.head();
        write_hook(&repo, "commit-msg", "grep -q verboten \"$1\" && { echo 'Wort nicht erlaubt'; exit 1; }\necho geprüft");
        let id = tc.open(&repo).await.repo.id;

        let err = commit_reword(&tc, id.clone(), "Ein verbotenes Wort".into(), String::new(), None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::HookFailed);
        assert_eq!(err.git_output.as_deref(), Some("Wort nicht erlaubt"));
        assert_eq!(repo.head(), before);
        assert_eq!(repo.git(&["for-each-ref", "refs/forkyard"]), "", "Sicherungs-Ref wieder entfernt");

        let result = commit_reword(&tc, id, "Erlaubt".into(), String::new(), None).await.unwrap();
        assert_eq!(result.hooks, vec![HookOutput { hook: "commit-msg".into(), output: "geprüft".into(), exit_code: 0 }]);
    }

    #[test]
    fn message_building() {
        assert_eq!(build_message(" a ", "").unwrap(), "a\n");
        assert_eq!(build_message("a", "\n\n  b\n c \n\n").unwrap(), "a\n\n  b\n c\n");
        assert_eq!(build_message("a", "# x").unwrap(), "a\n\n# x\n");
        assert_eq!(build_message("\r\n", "x").unwrap_err().code, ErrorCode::EmptyMessage);
        assert_eq!(quoted("kurz\nzweite Zeile"), "‘kurz’");
        assert_eq!(quoted(&"ä".repeat(80)).chars().count(), 63);
    }
}
