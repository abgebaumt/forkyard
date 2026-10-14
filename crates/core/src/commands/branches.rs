//! Branches: create, check out, rename, delete, upstream, name check.

use std::collections::HashSet;
use std::path::PathBuf;

use serde_json::json;

use crate::app::Core;
use crate::commands::commit::head_label;
use crate::commands::refs::{read_head, read_refs, short_ref_name};
use crate::commands::status::{parse_porcelain_v2, read_operation, read_status};
use crate::commands::submodule::auto;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::errors;
use crate::model::{Head, OpResult, OperationKind, RefNameCheck, RefNameKind, RefsSnapshot, RepoChange, Status};
use crate::undo::{self, UndoAction, UndoRecord};
use crate::util;

const CHECKOUT_CHANGES: [RepoChange; 4] = [RepoChange::Head, RepoChange::Refs, RepoChange::Index, RepoChange::Worktree];
/// Fields per local branch, each terminated with NUL.
const BRANCH_FORMAT: &str = "--format=%(refname)%00%(objectname)%00%(upstream)%00%(HEAD)%00%(worktreepath)%00";
const BRANCH_FIELDS: usize = 5;
/// The maximum number of file names an error message names.
const MAX_LISTED: usize = 8;

/// Branch from HEAD (`start: None`) or a commit, optionally checked out.
pub async fn branch_create(core: &Core, repo_id: String, name: String, start: Option<String>, checkout: bool) -> CoreResult<RefsSnapshot> {
    let changes: &[RepoChange] = if checkout { &CHECKOUT_CHANGES } else { &[RepoChange::Refs] };
    core.with_write_lock(&repo_id, changes, async {
        let name = name.as_str();
        let head = read_head(core, &repo_id).await?;
        let branches = local_branches(core, &repo_id).await?;
        check_new_name(core, &repo_id, name, RefNameKind::Branch, &names_of(&branches), None).await?;
        if matches!(head, Head::Unborn { .. }) {
            return Err(CoreError::not_allowed(
                "The repository has no commits yet. You can create a branch only after the first commit.",
            ));
        }
        let start_rev = start.as_deref().map(str::trim).filter(|s| !s.is_empty()).unwrap_or("HEAD");
        let Some(sha) = resolve_commit(core, &repo_id, start_rev).await? else {
            return Err(CoreError::not_found(format!("The starting point ‘{start_rev}’ wasn’t found.")));
        };
        // Always at the resolved SHA and without tracking: an upstream only comes about via
        // `branch_checkout` of a remote branch, `branch_set_upstream` or push.
        if checkout {
            if let Some(op) = read_operation(core, &repo_id).await? {
                return Err(operation_error(op.kind));
            }
            run_checkout(core, &repo_id, &["checkout", "--no-track", "-b", name, &sha], &sha).await?;
            let after = read_head(core, &repo_id).await?;
            record_checkout(core, &repo_id, &head, &after, name, Some((name, None, &sha))).await?;
        } else {
            core.git_for(&repo_id)?.args(["branch", "--no-track", name, &sha]).run().await?;
        }
        read_refs(core, &repo_id).await
    })
    .await
}

/// Local branch, remote branch (creates a tracking branch) or SHA (detached).
pub async fn branch_checkout(core: &Core, repo_id: String, target: String) -> CoreResult<Status> {
    let id = repo_id.clone();
    auto::follow(core, &id, checkout_branch(core, repo_id, target)).await
}

async fn checkout_branch(core: &Core, repo_id: String, target: String) -> CoreResult<Status> {
    core.with_write_lock(&repo_id, &CHECKOUT_CHANGES, async {
        // Whoever leaves a detached HEAD with their own commits leaves them behind without a ref:
        // check beforehand so that the answer can say so.
        let leaving = match read_head(core, &repo_id).await? {
            Head::Detached { sha } => Some(sha),
            _ => None,
        };
        checkout_locked(core, &repo_id, target.trim()).await?;
        let mut status = read_status(core, &repo_id).await?;
        if let Some(sha) = leaving {
            let moved = !matches!(&status.head, Head::Detached { sha: now } if *now == sha);
            if moved {
                status.left_behind = left_behind(core, &repo_id, &sha).await;
            }
        }
        Ok(status)
    })
    .await
}

/// Commits from `sha` that hang on no branch, tag or remote branch – `None` if there are none
/// (or it cannot be determined: the warning is an extra, the checkout has happened).
async fn left_behind(core: &Core, repo_id: &str, sha: &str) -> Option<crate::model::LeftBehind> {
    let out = core
        .git_for(repo_id)
        .ok()?
        .args(["rev-list", "--count", sha, "--not", "--branches", "--tags", "--remotes"])
        .read_only()
        .no_log()
        .run_raw()
        .await
        .ok()?;
    let count: u32 = out.stdout_text().trim().parse().ok()?;
    (out.success() && count > 0).then(|| crate::model::LeftBehind { sha: sha.to_string(), count })
}

/// Renames a branch.
pub async fn branch_rename(core: &Core, repo_id: String, name: String, new_name: String) -> CoreResult<RefsSnapshot> {
    core.with_write_lock(&repo_id, &[RepoChange::Refs, RepoChange::Head, RepoChange::Config], async {
        let name = local_name(&name);
        let branches = local_branches(core, &repo_id).await?;
        if !branches.iter().any(|b| b.name == name) {
            return Err(branch_not_found(name));
        }
        if name != new_name {
            check_new_name(core, &repo_id, &new_name, RefNameKind::Branch, &names_of(&branches), Some(name)).await?;
            // `git branch -m` moves the upstream mapping, reflog and – for the current branch – HEAD along.
            // If only the case changes, Git considers the new name taken on Windows and macOS;
            // `-M` is safe then, because no other branch has that name (checked above).
            let mode = if name.to_lowercase() == new_name.to_lowercase() { "-M" } else { "-m" };
            core.git_for(&repo_id)?.args(["branch", mode, name, &new_name]).run().await?;
        }
        read_refs(core, &repo_id).await
    })
    .await
}

/// Deletes branches; without `force` unmerged ones fail with `not_merged`.
pub async fn branch_delete(core: &Core, repo_id: String, names: Vec<String>, force: bool) -> CoreResult<RefsSnapshot> {
    core.with_write_lock(&repo_id, &[RepoChange::Refs, RepoChange::Config], async {
        delete_locked(core, &repo_id, &names, force).await?;
        read_refs(core, &repo_id).await
    })
    .await
}

/// Sets or unsets the upstream (`upstream: None`).
pub async fn branch_set_upstream(core: &Core, repo_id: String, name: String, upstream: Option<String>) -> CoreResult<RefsSnapshot> {
    core.with_write_lock(&repo_id, &[RepoChange::Config, RepoChange::Refs], async {
        let name = local_name(&name);
        let branches = local_branches(core, &repo_id).await?;
        let Some(branch) = branches.iter().find(|b| b.name == name) else {
            return Err(branch_not_found(name));
        };
        match upstream.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
            None => {
                if branch.upstream.is_some() {
                    core.git_for(&repo_id)?.args(["branch", "--unset-upstream", name]).run().await?;
                }
            }
            Some(wanted) => {
                let full = upstream_ref(core, &repo_id, wanted).await?;
                if full == format!("refs/heads/{name}") {
                    return Err(CoreError::not_allowed("A branch can’t be its own upstream."));
                }
                if branch.upstream.as_deref() != Some(full.as_str()) {
                    let arg = format!("--set-upstream-to={full}");
                    core.git_for(&repo_id)?.args(["branch", arg.as_str(), name]).run().await?;
                }
            }
        }
        read_refs(core, &repo_id).await
    })
    .await
}

/// Is the name valid (and free)? For inline input.
pub async fn ref_name_check(core: &Core, repo_id: String, name: String, kind: RefNameKind) -> CoreResult<RefNameCheck> {
    let prefix = match kind {
        RefNameKind::Branch => "refs/heads/",
        RefNameKind::Tag => "refs/tags/",
    };
    let out = core.git_for(&repo_id)?.args(["for-each-ref", "--format=%(refname)", prefix]).read_only().no_log().run().await?;
    let existing: Vec<String> = out
        .stdout_lines()
        .into_iter()
        .map(util::decode_lossy)
        .filter_map(|full| full.strip_prefix(prefix).map(str::to_string))
        .collect();
    match check_new_name(core, &repo_id, &name, kind, &existing, None).await {
        Ok(()) => Ok(RefNameCheck { valid: true, reason: None }),
        Err(e) if e.is(ErrorCode::InvalidName) || e.is(ErrorCode::NameExists) => {
            Ok(RefNameCheck { valid: false, reason: Some(e.message) })
        }
        Err(e) => Err(e),
    }
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub(crate) struct BranchInfo {
    pub(crate) name: String,
    pub(crate) sha: String,
    /// Full ref name of the upstream, even if it no longer exists.
    pub(crate) upstream: Option<String>,
    pub(crate) is_head: bool,
    /// Working directory in which the branch is checked out (or currently being rebuilt).
    pub(crate) worktree: Option<PathBuf>,
}

pub(crate) async fn local_branches(core: &Core, repo_id: &str) -> CoreResult<Vec<BranchInfo>> {
    let out = core.git_for(repo_id)?.args(["for-each-ref", BRANCH_FORMAT, "refs/heads"]).read_only().no_log().run().await?;
    let fields: Vec<&[u8]> = out.stdout.split(|&b| b == 0).collect();
    let mut branches = Vec::new();
    for chunk in fields.chunks(BRANCH_FIELDS) {
        if chunk.len() < BRANCH_FIELDS {
            break;
        }
        // The line break after each record sticks to the first field of the next one.
        let full = util::decode_lossy(chunk[0].strip_prefix(b"\n").unwrap_or(chunk[0]));
        let Some(name) = full.strip_prefix("refs/heads/") else { continue };
        branches.push(BranchInfo {
            name: name.to_string(),
            sha: util::decode_lossy(chunk[1]),
            upstream: Some(util::decode_lossy(chunk[2])).filter(|u| !u.is_empty()),
            is_head: chunk[3] == b"*",
            worktree: (!chunk[4].is_empty()).then(|| util::bytes_to_path(chunk[4])),
        });
    }
    Ok(branches)
}

pub(crate) fn names_of(branches: &[BranchInfo]) -> Vec<String> {
    branches.iter().map(|b| b.name.clone()).collect()
}

/// `refs/heads/x` → `x`; the UI may send either form.
fn local_name(name: &str) -> &str {
    let name = name.trim();
    name.strip_prefix("refs/heads/").unwrap_or(name)
}

fn branch_not_found(name: &str) -> CoreError {
    CoreError::not_found(format!("The branch ‘{name}’ doesn’t exist (anymore)."))
}

fn operation_error(kind: OperationKind) -> CoreError {
    let name = match kind {
        OperationKind::Merge => "a merge",
        OperationKind::Rebase => "a rebase",
        OperationKind::CherryPick => "a cherry-pick",
        OperationKind::Revert => "a revert",
    };
    CoreError::new(
        ErrorCode::OperationInProgress,
        format!("There’s {name} in progress. Finish or abort it first, then switch branches."),
    )
}

/// SHA of the commit `rev` points to (tags are resolved); `None` if it does not exist.
///
/// A short name first means the local branch of that name: Git itself would silently take a tag
/// of the same name (`refs/tags` before `refs/heads`) – but the UI passes branch names from the
/// left panel, the drop menu and the command palette.
pub(crate) async fn resolve_commit(core: &Core, repo_id: &str, rev: &str) -> CoreResult<Option<String>> {
    if rev.is_empty() || rev.starts_with('-') {
        return Ok(None);
    }
    let parse = |name: String| async move {
        let out = core.git_for(repo_id)?.args(["rev-parse", "-q", "--verify", &format!("{name}^{{commit}}")]).read_only().no_log().run_raw().await?;
        Ok::<_, CoreError>(Some(out.stdout_text()).filter(|sha| out.success() && !sha.is_empty()))
    };
    if could_be_branch_name(rev) {
        if let Some(sha) = parse(format!("refs/heads/{rev}")).await? {
            return Ok(Some(sha));
        }
    }
    parse(rev.to_string()).await
}

/// Whether `rev` can be a short name (no full ref name, no expression like `HEAD~2` or `a..b`).
pub(crate) fn could_be_branch_name(rev: &str) -> bool {
    !rev.starts_with("refs/") && rev != "HEAD" && !rev.contains(['~', '^', ':', '@', ' ']) && !rev.contains("..") && util::check_ref_name(rev).is_ok()
}

/// The first path part (at the same depth, with the same path before it) in which `name` and
/// `other` differ only in case: (part in `name`, part in `other`).
/// The last parts of two names of equal length are checked by comparing the whole names.
fn case_clash(name: &str, other: &str) -> Option<(String, String)> {
    let (mine, theirs): (Vec<&str>, Vec<&str>) = (name.split('/').collect(), other.split('/').collect());
    for (index, (a, b)) in mine.iter().zip(&theirs).enumerate() {
        if a == b {
            continue;
        }
        let both_last = index + 1 == mine.len() && index + 1 == theirs.len();
        return (a.to_lowercase() == b.to_lowercase() && !both_last).then(|| (a.to_string(), b.to_string()));
    }
    None
}

/// Checks a new branch or tag name: Git's rules, collisions with `existing`.
/// `ignore` is the name currently being renamed. Errors: `invalid_name` or `name_exists`,
/// the message is the reason as an English sentence.
pub(crate) async fn check_new_name(
    core: &Core,
    repo_id: &str,
    name: &str,
    kind: RefNameKind,
    existing: &[String],
    ignore: Option<&str>,
) -> CoreResult<()> {
    util::check_ref_name(name).map_err(CoreError::invalid_name)?;
    let (what, a_what) = match kind {
        RefNameKind::Branch => ("branch", "A branch"),
        RefNameKind::Tag => ("tag", "A tag"),
    };
    // Refs are files under .git/refs: every name part is a file or folder name, and on
    // Windows the whole path (including ".lock" while writing) ends at 259 characters. Git
    // otherwise only reports "cannot lock ref … Filename too long".
    const MAX_PART: usize = 250;
    if let Some(part) = name.split('/').find(|part| part.encode_utf16().count() > MAX_PART) {
        return Err(CoreError::invalid_name(format!(
            "The name is too long: one part has {} characters, but the file system allows at most {MAX_PART}.",
            part.encode_utf16().count()
        )));
    }
    if cfg!(windows) {
        let prefix = match kind {
            RefNameKind::Branch => "refs/heads/",
            RefNameKind::Tag => "refs/tags/",
        };
        if let Ok(git_dir) = crate::commands::status::git_dir(core, repo_id).await {
            let base = git_dir.as_os_str().to_string_lossy().encode_utf16().count() + 1 + prefix.len() + ".lock".len();
            let length = name.encode_utf16().count();
            if base + length > 259 {
                return Err(CoreError::invalid_name(format!(
                    "The name is too long at {length} characters: together with the repository’s path it exceeds the Windows limit. At most {} characters are possible here.",
                    259usize.saturating_sub(base)
                )));
            }
        }
    }
    // Windows and macOS store refs as files without distinguishing case.
    let folds_case = cfg!(any(windows, target_os = "macos"));
    for other in existing.iter().filter(|o| Some(o.as_str()) != ignore) {
        if other == name {
            return Err(CoreError::name_exists(format!("{a_what} named ‘{name}’ already exists.")));
        }
        if folds_case && other.to_lowercase() == name.to_lowercase() {
            return Err(CoreError::name_exists(format!(
                "The name differs from ‘{other}’ only in upper/lower case. That isn’t possible on this system."
            )));
        }
        // The folder parts too: "Feature/neu" next to "feature/export" ended up in the same
        // folder, and Git then kept the branch under two spellings.
        if folds_case {
            if let Some((mine, theirs)) = case_clash(name, other) {
                return Err(CoreError::name_exists(format!(
                    "The part ‘{mine}’ differs from ‘{theirs}’ in ‘{other}’ only in upper/lower case. That isn’t possible on this system – spell it the same way."
                )));
            }
        }
        // A name cannot be both a folder and a ref.
        if name.strip_prefix(other.as_str()).is_some_and(|rest| rest.starts_with('/')) {
            return Err(CoreError::name_exists(format!(
                "The {what} ‘{other}’ already exists; no other name can be placed below it."
            )));
        }
        if other.strip_prefix(name).is_some_and(|rest| rest.starts_with('/')) {
            return Err(CoreError::name_exists(format!(
                "The {what} ‘{other}’ already exists; ‘{name}’ would also be its folder."
            )));
        }
    }
    // Git has the last word.
    let cmd = core.git_for(repo_id)?.read_only().no_log();
    let out = match kind {
        RefNameKind::Branch => cmd.args(["check-ref-format", "--branch", name]),
        RefNameKind::Tag => cmd.args(["check-ref-format", &format!("refs/tags/{name}")]),
    }
    .run_raw()
    .await?;
    if !out.success() {
        return Err(CoreError::invalid_name(format!("Git doesn’t allow the name ‘{name}’.")));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

enum CheckoutPlan {
    /// Existing local branch.
    Local { name: String },
    /// New local branch that follows a remote branch.
    Track { local: String, remote_full: String, sha: String },
    /// Commit or tag: HEAD gets detached.
    Detach { sha: String, display: String },
}

async fn checkout_locked(core: &Core, repo_id: &str, target: &str) -> CoreResult<()> {
    if target.is_empty() || target.starts_with('-') {
        return Err(target_not_found(target));
    }
    if let Some(op) = read_operation(core, repo_id).await? {
        return Err(operation_error(op.kind));
    }
    let head = read_head(core, repo_id).await?;
    let branches = local_branches(core, repo_id).await?;
    match plan_checkout(core, repo_id, target, &branches).await? {
        CheckoutPlan::Local { name } => {
            if matches!(&head, Head::Branch { branch, .. } if *branch == name) {
                return Ok(());
            }
            let Some(info) = branches.iter().find(|b| b.name == name) else {
                return Err(branch_not_found(&name));
            };
            if let Some(path) = foreign_worktree(core, repo_id, info)? {
                return Err(CoreError::not_allowed(format!(
                    "The branch ‘{name}’ is already checked out in the worktree “{path}” and can’t be checked out here as well."
                )));
            }
            // Only check out: a branch that is behind its remote is never moved by this.
            run_checkout(core, repo_id, &["checkout", &name, "--"], &info.sha).await?;
            let after = read_head(core, repo_id).await?;
            record_checkout(core, repo_id, &head, &after, &name, None).await
        }
        CheckoutPlan::Track { local, remote_full, sha } => {
            run_checkout(core, repo_id, &["checkout", "-b", &local, "--track", &remote_full], &sha).await?;
            let after = read_head(core, repo_id).await?;
            let upstream = short_ref_name(&remote_full).to_string();
            record_checkout(core, repo_id, &head, &after, &local, Some((&local, Some(&upstream), &sha))).await
        }
        CheckoutPlan::Detach { sha, display } => {
            if matches!(&head, Head::Detached { sha: current } if *current == sha) {
                return Ok(());
            }
            run_checkout(core, repo_id, &["checkout", "--detach", &sha], &sha).await?;
            let after = read_head(core, repo_id).await?;
            record_checkout(core, repo_id, &head, &after, &display, None).await
        }
    }
}

fn target_not_found(target: &str) -> CoreError {
    CoreError::not_found(format!("‘{target}’ wasn’t found – neither as a branch nor as a tag or commit."))
}

async fn plan_checkout(core: &Core, repo_id: &str, target: &str, branches: &[BranchInfo]) -> CoreResult<CheckoutPlan> {
    let is_remote_ref = target.starts_with("refs/remotes/");
    let is_tag_ref = target.starts_with("refs/tags/");
    if !is_remote_ref && !is_tag_ref {
        let name = local_name(target);
        if branches.iter().any(|b| b.name == name) {
            return Ok(CheckoutPlan::Local { name: name.to_string() });
        }
    }
    if !is_tag_ref && !target.starts_with("refs/heads/") {
        let short = target.strip_prefix("refs/remotes/").unwrap_or(target);
        let remote_full = format!("refs/remotes/{short}");
        if let Some(sha) = resolve_commit(core, repo_id, &remote_full).await? {
            return Ok(match local_name_for_remote(core, repo_id, short).await? {
                Some(local) if branches.iter().any(|b| b.name == local) => CheckoutPlan::Local { name: local },
                Some(local) => CheckoutPlan::Track { local, remote_full, sha },
                // `origin/HEAD` and the like: no branch name can be derived.
                None => CheckoutPlan::Detach { display: short.to_string(), sha },
            });
        }
    }
    match resolve_commit(core, repo_id, target).await? {
        Some(sha) => {
            let looks_like_sha = target.len() >= 4 && target.chars().all(|c| c.is_ascii_hexdigit()) && sha.starts_with(&target.to_lowercase());
            let display = if looks_like_sha { sha.chars().take(7).collect() } else { short_ref_name(target).to_string() };
            Ok(CheckoutPlan::Detach { sha, display })
        }
        None => Err(target_not_found(target)),
    }
}

/// `origin/feature/x` → `feature/x`. Remote names may contain slashes themselves; the longest
/// known remote name wins.
async fn local_name_for_remote(core: &Core, repo_id: &str, short: &str) -> CoreResult<Option<String>> {
    let out = core.git_for(repo_id)?.arg("remote").read_only().no_log().run_raw().await?;
    let remotes: Vec<String> = if out.success() {
        out.stdout_lines().into_iter().map(util::decode_lossy).filter(|n| !n.is_empty()).collect()
    } else {
        Vec::new()
    };
    let rest = remotes
        .iter()
        .filter_map(|r| short.strip_prefix(r.as_str()).and_then(|rest| rest.strip_prefix('/')))
        .min_by_key(|rest| rest.len())
        .or_else(|| short.split_once('/').map(|(_, rest)| rest));
    Ok(rest.filter(|r| !r.is_empty() && *r != "HEAD").map(str::to_string))
}

/// Path of another worktree in which the branch is checked out.
pub(crate) fn foreign_worktree(core: &Core, repo_id: &str, branch: &BranchInfo) -> CoreResult<Option<String>> {
    let own = util::path_key(&core.repo_path(repo_id)?);
    Ok(branch.worktree.as_ref().filter(|p| util::path_key(p) != own).map(|p| util::display_path(p)))
}

/// Runs `git checkout`. If uncommitted changes block the switch, the message names the
/// affected files.
pub(crate) async fn run_checkout(core: &Core, repo_id: &str, args: &[&str], target_sha: &str) -> CoreResult<()> {
    // Otherwise Git overwrites ignored files that are tracked in the target without a prompt
    // (a local .env that was once checked in) – there is no backup of them anywhere. With
    // `--no-overwrite-ignore` Git refuses instead.
    let mut full: Vec<&str> = Vec::with_capacity(args.len() + 1);
    full.extend(args.first());
    full.push("--no-overwrite-ignore");
    full.extend(args.iter().skip(1));
    let hooks = crate::commands::commit::Hooks::start(core, repo_id).await;
    let out = hooks.wrap(core.git_for(repo_id)?).args(full).check(false).run().await;
    let ran = hooks.finish(core, repo_id);
    let out = out?;
    if out.success() {
        return Ok(());
    }
    // The post-checkout hook runs AFTER the switch: if it ends with an error, Git reports
    // exit code 1 although the branch has been switched. That is not a failed checkout –
    // the UI has already received the hook's output via `hook:output`.
    if ran.iter().any(|hook| hook.hook == "post-checkout" && hook.exit_code != 0) {
        let now = core.git_for(repo_id)?.args(["rev-parse", "-q", "--verify", "HEAD^{commit}"]).read_only().no_log().run_raw().await?;
        if now.success() && now.stdout_text() == target_sha {
            return Ok(());
        }
    }
    let err = errors::classify("checkout", out.code, &out.stdout, &out.stderr);
    if !err.is(ErrorCode::DirtyWorktree) {
        return Err(err);
    }
    let files = blocking_paths(core, repo_id, target_sha).await.unwrap_or_default();
    // What Git names but the status does not know is ignored.
    let ignored: Vec<String> = out
        .stderr_text()
        .lines()
        .filter_map(|line| line.strip_prefix('\t'))
        .map(|line| line.trim().to_string())
        .filter(|file| !file.is_empty() && !files.contains(file))
        .collect();
    if files.is_empty() && !ignored.is_empty() {
        let mut listed = ignored.iter().take(MAX_LISTED).map(|f| format!("‘{f}’")).collect::<Vec<_>>().join(", ");
        if ignored.len() > MAX_LISTED {
            listed.push_str(&format!(" and {} more", ignored.len() - MAX_LISTED));
        }
        let message = if ignored.len() == 1 {
            format!("{listed} is ignored by Git but is a tracked file in the target and would be overwritten by the switch. Move or rename the file first.")
        } else {
            format!("{listed} are ignored by Git but are tracked files in the target and would be overwritten by the switch. Move or rename the files first.")
        };
        return Err(CoreError { message, ..err });
    }
    let message = match files.as_slice() {
        [] => "Uncommitted changes prevent the switch. Commit, stash or discard them first.".to_string(),
        [one] => format!("Uncommitted changes to ‘{one}’ prevent the switch. Commit, stash or discard them first."),
        many => {
            let mut listed = many.iter().take(MAX_LISTED).map(|f| format!("‘{f}’")).collect::<Vec<_>>().join(", ");
            if many.len() > MAX_LISTED {
                listed.push_str(&format!(" and {} more", many.len() - MAX_LISTED));
            }
            format!(
                "Uncommitted changes to {} files prevent the switch: {listed}. Commit, stash or discard them first.",
                many.len()
            )
        }
    };
    Err(CoreError { message, ..err })
}

/// Files that differ between HEAD and the target and are at the same time modified locally
/// or untracked – the switch fails on them.
async fn blocking_paths(core: &Core, repo_id: &str, target_sha: &str) -> CoreResult<Vec<String>> {
    let diff = core
        .git_for(repo_id)?
        .args(["-c", "diff.autoRefreshIndex=false", "diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "HEAD", target_sha])
        .read_only()
        .no_log()
        .run()
        .await?;
    let differing: HashSet<&[u8]> = util::split_z(&diff.stdout).collect();
    let status = core
        .git_for(repo_id)?
        .args(["status", "--porcelain=v2", "-z", "--untracked-files=all"])
        .read_only()
        .no_log()
        .run()
        .await?;
    let mut files = Vec::new();
    for entry in parse_porcelain_v2(&status.stdout).entries {
        for path in std::iter::once(&entry.path).chain(entry.orig_path.iter()) {
            if differing.contains(path.as_slice()) {
                let shown = util::decode_lossy(path);
                if !files.contains(&shown) {
                    files.push(shown);
                }
            }
        }
    }
    Ok(files)
}

/// Undo entry for a checkout. `created`: (branch, upstream, SHA) if a local branch was
/// created in the process.
pub(crate) async fn record_checkout(
    core: &Core,
    repo_id: &str,
    before: &Head,
    after: &Head,
    display: &str,
    created: Option<(&str, Option<&str>, &str)>,
) -> CoreResult<()> {
    let head_before = head_label(before);
    let head_after = head_label(after);
    if head_before == head_after && created.is_none() {
        return Ok(());
    }
    let payload = match created {
        Some((branch, upstream, _)) => json!({ "branch": branch, "upstream": upstream, "created": true }),
        None => json!({}),
    };
    undo::record(
        core,
        UndoRecord {
            id: undo::new_id(),
            repo_id: repo_id.to_string(),
            worktree_path: String::new(),
            action: UndoAction::Checkout,
            label: format!("Undo checkout of {display}"),
            ref_name: created.map(|(branch, _, _)| format!("refs/heads/{branch}")),
            ref_before: None,
            ref_after: created.map(|(_, _, sha)| sha.to_string()),
            head_before,
            head_after: Some(head_after),
            payload,
        },
    )
    .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Deleting and upstream
// ---------------------------------------------------------------------------

async fn delete_locked(core: &Core, repo_id: &str, names: &[String], force: bool) -> CoreResult<()> {
    let mut wanted: Vec<&str> = Vec::new();
    for name in names.iter().map(|n| local_name(n)) {
        if !name.is_empty() && !wanted.contains(&name) {
            wanted.push(name);
        }
    }
    if wanted.is_empty() {
        return Ok(());
    }
    // Check everything first, then delete: either all or none.
    let branches = local_branches(core, repo_id).await?;
    let mut targets: Vec<&BranchInfo> = Vec::new();
    let mut missing: Vec<&str> = Vec::new();
    for name in &wanted {
        match branches.iter().find(|b| b.name == *name) {
            Some(info) => targets.push(info),
            None => missing.push(name),
        }
    }
    if !missing.is_empty() {
        return Err(CoreError::not_found(match missing.as_slice() {
            [one] => format!("The branch ‘{one}’ doesn’t exist (anymore)."),
            many => format!("These branches don’t exist (anymore): {}.", quote_list(many)),
        }));
    }
    for info in &targets {
        if info.is_head {
            return Err(CoreError::not_allowed(format!(
                "The branch ‘{}’ is checked out and can’t be deleted. Switch to another branch first.",
                info.name
            )));
        }
        if let Some(path) = foreign_worktree(core, repo_id, info)? {
            return Err(CoreError::not_allowed(format!(
                "The branch ‘{}’ is checked out in the worktree “{path}” and can’t be deleted.",
                info.name
            )));
        }
        if info.worktree.is_some() {
            return Err(CoreError::not_allowed(format!(
                "The branch ‘{}’ is in use by an operation in progress and can’t be deleted.",
                info.name
            )));
        }
    }
    if !force {
        let unmerged = unmerged_branches(core, repo_id, &targets).await?;
        if !unmerged.is_empty() {
            let message = match unmerged.as_slice() {
                [one] => format!(
                    "The branch ‘{one}’ isn’t merged yet. If you force the deletion, its commits are only reachable through Undo."
                ),
                many => format!(
                    "These branches aren’t merged yet: {}. If you force the deletion, their commits are only reachable through Undo.",
                    quote_list(many)
                ),
            };
            return Err(CoreError::new(ErrorCode::NotMerged, message));
        }
    }

    // Which of the branches have their own settings (upstream etc.) – read once instead of one
    // call per branch that usually finds nothing.
    let configured = branches_with_config(core, repo_id).await;
    let remove_config = |name: &str| {
        let section = format!("branch.{name}");
        let wanted = match configured.as_ref() {
            Some(set) => set.contains(name),
            None => true,
        };
        async move {
            if wanted {
                // Like `git branch -d`: the branch's settings go with it.
                if let Ok(cmd) = core.git_for(repo_id) {
                    let _ = cmd.args(["config", "--remove-section", &section]).run_raw().await;
                }
            }
        }
    };

    // Several branches at once are ONE action: one undo step brings all of them back.
    if targets.len() > 1 {
        let id = undo::new_id();
        let mut script: Vec<u8> = Vec::new();
        for (index, info) in targets.iter().enumerate() {
            let backup = undo::backup_ref_name(&id, &format!("before-{index}"));
            script.extend_from_slice(format!("create {backup}\0{}\0", info.sha).as_bytes());
            script.extend_from_slice(format!("delete refs/heads/{}\0{}\0", info.name, info.sha).as_bytes());
        }
        core.git_for(repo_id)?.args(["update-ref", "-z", "--stdin"]).stdin(script).run().await?;
        for info in &targets {
            remove_config(&info.name).await;
        }
        let head = head_label(&read_head(core, repo_id).await?);
        let steps: Vec<_> = targets.iter().map(|info| json!({ "ref": format!("refs/heads/{}", info.name), "before": info.sha, "after": null })).collect();
        let upstreams: Vec<_> = targets
            .iter()
            .filter_map(|info| info.upstream.as_deref().map(|upstream| json!({ "branch": info.name, "upstream": short_ref_name(upstream) })))
            .collect();
        return undo::record(
            core,
            UndoRecord {
                id,
                repo_id: repo_id.to_string(),
                worktree_path: String::new(),
                action: UndoAction::DeleteBranch,
                label: format!("Undo deletion of {} branches", targets.len()),
                ref_name: None,
                ref_before: None,
                ref_after: None,
                head_before: head.clone(),
                head_after: Some(head),
                payload: json!({ "composite": true, "steps": steps, "upstreams": upstreams }),
            },
        )
        .await
        .map(|_| ());
    }

    // Create backup refs and delete branches in one transaction.
    let entries: Vec<(String, &BranchInfo)> = targets.iter().map(|info| (undo::new_id(), *info)).collect();
    let mut script: Vec<u8> = Vec::new();
    for (id, info) in &entries {
        let backup = undo::backup_ref_name(id, "before");
        script.extend_from_slice(format!("create {backup}\0{}\0", info.sha).as_bytes());
        script.extend_from_slice(format!("delete refs/heads/{}\0{}\0", info.name, info.sha).as_bytes());
    }
    core.git_for(repo_id)?.args(["update-ref", "-z", "--stdin"]).stdin(script).run().await?;

    let head = head_label(&read_head(core, repo_id).await?);
    for (id, info) in entries {
        remove_config(&info.name).await;
        undo::record(
            core,
            UndoRecord {
                id,
                repo_id: repo_id.to_string(),
                worktree_path: String::new(),
                action: UndoAction::DeleteBranch,
                label: format!("Undo deletion of branch ‘{}’", info.name),
                ref_name: Some(format!("refs/heads/{}", info.name)),
                ref_before: Some(info.sha.clone()),
                ref_after: None,
                head_before: head.clone(),
                head_after: Some(head.clone()),
                payload: json!({ "branch": info.name, "upstream": info.upstream.as_deref().map(short_ref_name) }),
            },
        )
        .await?;
    }
    Ok(())
}

/// Names of the branches with a `branch.<name>` section in the configuration; `None` if it
/// cannot be read (then each branch is tried as before).
async fn branches_with_config(core: &Core, repo_id: &str) -> Option<HashSet<String>> {
    let out = core.git_for(repo_id).ok()?.args(["config", "--local", "--name-only", "-z", "--get-regexp", r"^branch\."]).read_only().no_log().run_raw().await.ok()?;
    // Exit code 1: no match.
    if !out.success() && out.code != Some(1) {
        return None;
    }
    let mut names = HashSet::new();
    for key in out.stdout.split(|byte| *byte == 0).filter(|key| !key.is_empty()) {
        let key = util::decode_lossy(key);
        // branch.<name>.<setting> – the name may itself contain dots.
        if let Some(rest) = key.strip_prefix("branch.") {
            if let Some(dot) = rest.rfind('.') {
                names.insert(rest[..dot].to_string());
            }
        }
    }
    Some(names)
}

fn quote_list(names: &[&str]) -> String {
    names.iter().map(|n| format!("‘{n}’")).collect::<Vec<_>>().join(", ")
}

/// Branches whose commits would no longer be reachable anywhere after deleting: neither from
/// HEAD nor from their (existing) upstream.
async fn unmerged_branches<'a>(core: &Core, repo_id: &str, targets: &[&'a BranchInfo]) -> CoreResult<Vec<&'a str>> {
    let merged = core
        .git_for(repo_id)?
        .args(["for-each-ref", "--merged", "HEAD", "--format=%(refname)", "refs/heads"])
        .read_only()
        .no_log()
        .run_raw()
        .await?;
    // In a repository without a commit there is no HEAD that anything could be merged into.
    let in_head: HashSet<String> = if merged.success() {
        merged.stdout_lines().into_iter().map(util::decode_lossy).collect()
    } else {
        HashSet::new()
    };
    let mut unmerged = Vec::new();
    for info in targets {
        if in_head.contains(&format!("refs/heads/{}", info.name)) {
            continue;
        }
        let in_upstream = match &info.upstream {
            Some(upstream) => is_ancestor(core, repo_id, &info.sha, upstream).await?,
            None => false,
        };
        if !in_upstream {
            unmerged.push(info.name.as_str());
        }
    }
    Ok(unmerged)
}

/// `false` also if `descendant` does not exist (any more).
pub(crate) async fn is_ancestor(core: &Core, repo_id: &str, ancestor: &str, descendant: &str) -> CoreResult<bool> {
    let out = core
        .git_for(repo_id)?
        .args(["merge-base", "--is-ancestor", ancestor, descendant])
        .read_only()
        .no_log()
        .run_raw()
        .await?;
    Ok(out.success())
}

/// Full ref name of an upstream: remote branch (`origin/x`) or local branch.
async fn upstream_ref(core: &Core, repo_id: &str, wanted: &str) -> CoreResult<String> {
    let candidates = if wanted.starts_with("refs/") {
        vec![wanted.to_string()]
    } else {
        vec![format!("refs/remotes/{wanted}"), format!("refs/heads/{wanted}")]
    };
    for full in candidates {
        let is_branch = full.starts_with("refs/remotes/") || full.starts_with("refs/heads/");
        if is_branch && resolve_commit(core, repo_id, &full).await?.is_some() {
            return Ok(full);
        }
    }
    Err(CoreError::not_found(format!(
        "The upstream ‘{wanted}’ wasn’t found. If the branch already exists on the remote, a fetch will help."
    )))
}

// ---------------------------------------------------------------------------
// Fast-forward of a branch that is not checked out
// ---------------------------------------------------------------------------

/// Fast-forwards the local branch `branch`, which is NOT checked out, to its upstream –
/// without touching the working directory and index (only the ref moves, guarded by its old
/// value). Nothing is fetched: what counts is the state of the last fetch.
///
/// - `up_to_date`: the branch is already at the upstream or only ahead of it.
/// - `not_allowed`: the branch has its own commits (no fast-forward possible) or is
///   checked out – here (then it goes through pull) or in another worktree.
/// - `no_upstream`: no upstream set, or it no longer exists.
///
/// An undo entry `merge` reverts the step.
pub async fn branch_fast_forward(core: &Core, repo_id: String, branch: String) -> CoreResult<OpResult> {
    core.with_write_lock(&repo_id, &[RepoChange::Refs], fast_forward_locked(core, &repo_id, &branch)).await
}

async fn fast_forward_locked(core: &Core, repo_id: &str, branch: &str) -> CoreResult<OpResult> {
    let name = local_name(branch);
    let branches = local_branches(core, repo_id).await?;
    let Some(info) = branches.iter().find(|b| b.name == name) else {
        return Err(branch_not_found(name));
    };
    if info.is_head {
        return Err(CoreError::not_allowed(format!(
            "The branch “{name}” is checked out. Pull instead (fast-forward only) – that also brings the working directory up to date."
        )));
    }
    if let Some(path) = foreign_worktree(core, repo_id, info)? {
        return Err(CoreError::not_allowed(format!(
            "The branch “{name}” is checked out in the worktree “{path}”. Pull there – otherwise its working directory would no longer match the branch."
        )));
    }
    if info.worktree.is_some() {
        return Err(CoreError::not_allowed(format!(
            "The branch “{name}” is in use by an operation in progress and can’t be moved."
        )));
    }
    let Some(upstream_full) = info.upstream.as_deref() else {
        return Err(CoreError::new(
            ErrorCode::NoUpstream,
            format!("The branch “{name}” has no upstream to follow. Set an upstream first."),
        ));
    };
    let upstream = short_ref_name(upstream_full).to_string();
    let Some(target) = resolve_commit(core, repo_id, upstream_full).await? else {
        return Err(CoreError::new(
            ErrorCode::NoUpstream,
            format!("The upstream “{upstream}” of “{name}” doesn’t exist (anymore). Maybe the branch was deleted on the remote."),
        ));
    };
    if target == info.sha || is_ancestor(core, repo_id, &target, &info.sha).await? {
        return Ok(OpResult::UpToDate);
    }
    if !is_ancestor(core, repo_id, &info.sha, &target).await? {
        let ahead = count_commits(core, repo_id, &format!("{target}..{}", info.sha)).await.unwrap_or(0);
        let own = match ahead {
            1 => format!("a commit of its own that’s missing from “{upstream}”"),
            n if n > 1 => format!("{n} commits of its own that are missing from “{upstream}”"),
            _ => format!("commits of its own that are missing from “{upstream}”"),
        };
        return Err(CoreError::not_allowed(format!(
            "The branch “{name}” has {own} – a fast-forward isn’t possible. Check out the branch and pull (merge or rebase)."
        )));
    }
    let behind = count_commits(core, repo_id, &format!("{}..{target}", info.sha)).await.unwrap_or(0);
    let full = format!("refs/heads/{name}");
    // The old value guards it: if the branch has moved in the meantime, Git changes nothing.
    let message = format!("forkyard: fast-forward to {upstream}");
    let out = core.git_for(repo_id)?.args(["update-ref", "-m", &message, &full, &target, &info.sha]).run_raw().await?;
    if !out.success() {
        let error = errors::classify("update-ref", out.code, &out.stdout, &out.stderr);
        if error.is(ErrorCode::Locked) {
            return Err(error);
        }
        return Err(CoreError::new(
            ErrorCode::StaleState,
            format!("The branch “{name}” has just changed. Please try again."),
        )
        .with_git_output(out.stderr_text()));
    }
    undo::record(
        core,
        UndoRecord {
            id: undo::new_id(),
            repo_id: repo_id.to_string(),
            worktree_path: String::new(),
            action: UndoAction::Merge,
            label: format!("Undo fast-forward of ‘{name}’ to {upstream}"),
            ref_name: Some(full),
            ref_before: Some(info.sha.clone()),
            ref_after: Some(target.clone()),
            // HEAD is not involved: the step applies regardless of which branch is checked out.
            head_before: String::new(),
            head_after: None,
            payload: json!({ "branch": name, "source": upstream, "fastForward": true, "refOnly": true }),
        },
    )
    .await?;
    let summary = match behind {
        1 => format!("Fast-forwarded {name} to {upstream} (1 commit)"),
        n if n > 1 => format!("Fast-forwarded {name} to {upstream} ({n} commits)"),
        _ => format!("Fast-forwarded {name} to {upstream}"),
    };
    Ok(OpResult::Done { sha: Some(target), fast_forward: true, summary })
}

/// Number of commits in `range` (`a..b`).
async fn count_commits(core: &Core, repo_id: &str, range: &str) -> CoreResult<u32> {
    let out = core.git_for(repo_id)?.args(["rev-list", "--count", range]).read_only().no_log().run().await?;
    Ok(out.stdout_text().trim().parse().unwrap_or(0))
}

#[cfg(test)]
mod fast_forward_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::names;
    use crate::model::Ref;
    use crate::testkit::{TestCore, TestRepo};

    fn find<'a>(list: &'a [Ref], name: &str) -> &'a Ref {
        list.iter().find(|r| r.name == name).unwrap_or_else(|| panic!("Ref {name} fehlt in {list:?}"))
    }

    fn has(list: &[Ref], name: &str) -> bool {
        list.iter().any(|r| r.name == name)
    }

    fn undo_count(tc: &TestCore, id: &str) -> i64 {
        tc.db
            .with(|c| Ok(c.query_row("select count(*) from undo_entries where repository_id = ?1", [id], |r| r.get(0))?))
            .unwrap()
    }

    /// Repo with a remote and a remote branch `feature/x` that does not exist locally.
    fn repo_with_remote_branch() -> (TestRepo, crate::testkit::TestRemote, String) {
        let repo = TestRepo::with_commit();
        let remote = repo.add_remote();
        repo.checkout_new("feature/x");
        let sha = repo.commit_file("f.txt", "f\n", "Feature");
        repo.git(&["push", "-q", "origin", "feature/x"]);
        repo.checkout("main");
        repo.git(&["branch", "-D", "feature/x"]);
        (repo, remote, sha)
    }

    // --- branch_create ------------------------------------------------------

    #[tokio::test]
    async fn create_from_head_and_from_commit() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let first = repo.head();
        let second = repo.commit_file("a.txt", "a\n", "Zweiter");
        repo.tag("v1");
        let id = tc.open(&repo).await.repo.id;
        tc.events.clear();

        let refs = branch_create(&tc, id.clone(), "feature/größe-1".into(), None, false).await.unwrap();
        assert_eq!(find(&refs.locals, "feature/größe-1").sha, second);
        assert_eq!(refs.head, Head::Branch { branch: "main".into(), sha: second.clone() }, "HEAD stays");
        assert_eq!(tc.events.named(names::REPO_CHANGED)[0]["what"], json!(["refs"]));
        assert_eq!(undo_count(&tc, &id), 0, "creating without checkout is not an undo step");

        let refs = branch_create(&tc, id.clone(), "alt".into(), Some(first.clone()), false).await.unwrap();
        assert_eq!(find(&refs.locals, "alt").sha, first);
        let refs = branch_create(&tc, id.clone(), "kurz".into(), Some(first[..8].to_string()), false).await.unwrap();
        assert_eq!(find(&refs.locals, "kurz").sha, first);
        let refs = branch_create(&tc, id.clone(), "vom-tag".into(), Some("v1".into()), false).await.unwrap();
        assert_eq!(find(&refs.locals, "vom-tag").sha, second);

        let err = branch_create(&tc, id.clone(), "x".into(), Some("gibt-es-nicht".into()), false).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        assert!(!has(&read_refs(&tc, &id).await.unwrap().locals, "x"));
    }

    #[tokio::test]
    async fn create_rejects_bad_and_taken_names() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        repo.branch("vorhanden");
        repo.branch("gruppe/eins");
        let id = tc.open(&repo).await.repo.id;

        for bad in ["", "mit leerzeichen", "-x", "a..b", "a~1", "ende/", ".versteckt", "x.lock", "HEAD", "a:b", "a\\b", "@"] {
            let err = branch_create(&tc, id.clone(), bad.into(), None, false).await.unwrap_err();
            assert_eq!(err.code, ErrorCode::InvalidName, "{bad}: {err:?}");
            assert!(!err.message.is_empty());
        }
        let err = branch_create(&tc, id.clone(), "vorhanden".into(), None, false).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NameExists);
        assert!(err.message.contains("vorhanden"), "{}", err.message);
        // A folder and a branch of the same name exclude each other.
        let err = branch_create(&tc, id.clone(), "gruppe".into(), None, false).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NameExists);
        let err = branch_create(&tc, id.clone(), "vorhanden/unter".into(), None, true).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NameExists);
        if cfg!(any(windows, target_os = "macos")) {
            let err = branch_create(&tc, id.clone(), "Vorhanden".into(), None, false).await.unwrap_err();
            assert_eq!(err.code, ErrorCode::NameExists);
        }
        assert_eq!(read_refs(&tc, &id).await.unwrap().locals.len(), 3);
    }

    #[tokio::test]
    async fn create_in_repo_without_commit_explains_why_not() {
        let tc = TestCore::new().await;
        let repo = TestRepo::new();
        let id = tc.open(&repo).await.repo.id;
        for checkout in [false, true] {
            let err = branch_create(&tc, id.clone(), "neu".into(), None, checkout).await.unwrap_err();
            assert_eq!(err.code, ErrorCode::NotAllowed);
            assert!(err.message.contains("no commits yet"), "{}", err.message);
        }
        assert_eq!(repo.current_branch(), "main");
    }

    #[tokio::test]
    async fn create_with_checkout_switches_and_records_undo() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let first = repo.head();
        let second = repo.commit_file("a.txt", "a\n", "Zweiter");
        repo.write_file("unverfolgt.txt", "bleibt\n");
        let id = tc.open(&repo).await.repo.id;
        tc.events.clear();

        let refs = branch_create(&tc, id.clone(), "neu".into(), Some(first.clone()), true).await.unwrap();
        assert_eq!(refs.head, Head::Branch { branch: "neu".into(), sha: first.clone() });
        assert_eq!(repo.current_branch(), "neu");
        assert!(!repo.path().join("a.txt").exists());
        assert_eq!(repo.read_file("unverfolgt.txt"), b"bleibt\n");
        assert_eq!(tc.events.named(names::REPO_CHANGED)[0]["what"], json!(["worktree", "index", "refs", "head"]));
        let entry = undo::next_undo(&tc, &id, "").unwrap().unwrap();
        assert_eq!(entry.action, "checkout");
        assert_eq!(entry.label, "Undo checkout of neu");
        assert_eq!(entry.head_before, "refs/heads/main");
        assert_eq!(entry.head_after.as_deref(), Some("refs/heads/neu"));
        assert_eq!(entry.ref_name.as_deref(), Some("refs/heads/neu"));
        assert_eq!(entry.ref_before, None);
        assert_eq!(entry.ref_after.as_deref(), Some(first.as_str()));
        assert_eq!(entry.payload, json!({ "branch": "neu", "upstream": null, "created": true }));
        assert_eq!(repo.git(&["rev-parse", "main"]), second);
    }

    #[tokio::test]
    async fn create_with_checkout_is_all_or_nothing_when_changes_block() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let first = repo.head();
        repo.commit_file("README.md", "# Zwei\n", "Zweiter");
        repo.write_file("README.md", "# Lokal geändert\n");
        let id = tc.open(&repo).await.repo.id;

        let err = branch_create(&tc, id.clone(), "neu".into(), Some(first), true).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::DirtyWorktree);
        assert!(err.message.contains("README.md"), "{}", err.message);
        assert_eq!(repo.current_branch(), "main");
        assert!(!has(&read_refs(&tc, &id).await.unwrap().locals, "neu"), "the branch must not be left over");
        assert_eq!(repo.read_file("README.md"), "# Lokal geändert\n".as_bytes());
    }

    #[tokio::test]
    async fn create_from_remote_branch_sets_no_upstream() {
        let tc = TestCore::new().await;
        let (repo, _remote, sha) = repo_with_remote_branch();
        let id = tc.open(&repo).await.repo.id;
        let refs = branch_create(&tc, id, "eigener".into(), Some("origin/feature/x".into()), false).await.unwrap();
        let created = find(&refs.locals, "eigener");
        assert_eq!(created.sha, sha);
        assert_eq!(created.upstream, None);
    }

    // --- branch_checkout ----------------------------------------------------

    #[tokio::test]
    async fn checkout_local_branch_and_back() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let first = repo.head();
        repo.checkout_new("feature");
        let second = repo.commit_file("a.txt", "a\n", "Feature");
        repo.checkout("main");
        let id = tc.open(&repo).await.repo.id;
        tc.events.clear();

        let status = branch_checkout(&tc, id.clone(), "feature".into()).await.unwrap();
        assert_eq!(status.head, Head::Branch { branch: "feature".into(), sha: second.clone() });
        assert!(repo.path().join("a.txt").exists());
        assert_eq!(tc.events.named(names::REPO_CHANGED)[0]["what"], json!(["worktree", "index", "refs", "head"]));
        let entry = undo::next_undo(&tc, &id, "").unwrap().unwrap();
        assert_eq!(entry.action, "checkout");
        assert_eq!(entry.label, "Undo checkout of feature");
        assert_eq!((entry.head_before.as_str(), entry.head_after.as_deref()), ("refs/heads/main", Some("refs/heads/feature")));
        assert_eq!((entry.ref_name, entry.ref_before, entry.ref_after), (None, None, None));

        // The same branch again: nothing to do, no further undo step.
        branch_checkout(&tc, id.clone(), "feature".into()).await.unwrap();
        assert_eq!(undo_count(&tc, &id), 1);
        // A full ref name works too.
        let status = branch_checkout(&tc, id.clone(), "refs/heads/main".into()).await.unwrap();
        assert_eq!(status.head, Head::Branch { branch: "main".into(), sha: first });
        assert_eq!(undo_count(&tc, &id), 2);

        let err = branch_checkout(&tc, id.clone(), "gibt-es-nicht".into()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        let err = branch_checkout(&tc, id, "--force".into()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        assert_eq!(repo.current_branch(), "main");
    }

    #[tokio::test]
    async fn checkout_prefers_the_branch_over_a_file_or_tag_of_the_same_name() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        repo.commit_file("docs", "eine Datei namens docs\n", "Datei");
        repo.branch("docs");
        let older = repo.git(&["rev-parse", "HEAD^"]);
        repo.git(&["tag", "docs", &older]);
        repo.write_file("docs", "lokal geändert\n");
        let id = tc.open(&repo).await.repo.id;
        let status = branch_checkout(&tc, id, "docs".into()).await.unwrap();
        assert_eq!(status.head, Head::Branch { branch: "docs".into(), sha: repo.head() });
        assert_eq!(repo.read_file("docs"), "lokal geändert\n".as_bytes(), "the file was not reset");
    }

    #[tokio::test]
    async fn checkout_remote_branch_creates_tracking_branch() {
        let tc = TestCore::new().await;
        let (repo, _remote, sha) = repo_with_remote_branch();
        let id = tc.open(&repo).await.repo.id;

        let status = branch_checkout(&tc, id.clone(), "origin/feature/x".into()).await.unwrap();
        assert_eq!(status.head, Head::Branch { branch: "feature/x".into(), sha: sha.clone() });
        assert_eq!(status.upstream.as_ref().map(|u| u.name.as_str()), Some("origin/feature/x"));
        let refs = read_refs(&tc, &id).await.unwrap();
        assert_eq!(find(&refs.locals, "feature/x").upstream.as_deref(), Some("origin/feature/x"));
        let entry = undo::next_undo(&tc, &id, "").unwrap().unwrap();
        assert_eq!(entry.label, "Undo checkout of feature/x");
        assert_eq!(entry.ref_name.as_deref(), Some("refs/heads/feature/x"));
        assert_eq!(entry.ref_before, None);
        assert_eq!(entry.ref_after.as_deref(), Some(sha.as_str()));
        assert_eq!(entry.payload, json!({ "branch": "feature/x", "upstream": "origin/feature/x", "created": true }));
        assert_eq!(entry.head_after.as_deref(), Some("refs/heads/feature/x"));
    }

    #[tokio::test]
    async fn checkout_remote_branch_never_moves_an_existing_local_branch() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let remote = repo.add_remote();
        repo.checkout_new("arbeit");
        let local_sha = repo.head();
        repo.git(&["push", "-q", "-u", "origin", "arbeit"]);
        repo.checkout("main");
        // Someone else keeps pushing: locally "arbeit" is now one commit behind.
        let other = TestRepo::clone_of(&remote);
        other.git(&["checkout", "-q", "arbeit"]);
        let remote_sha = other.commit_file("fremd.txt", "x\n", "Fremd");
        other.git(&["push", "-q", "origin", "arbeit"]);
        repo.git(&["fetch", "-q", "origin"]);
        let id = tc.open(&repo).await.repo.id;

        for target in ["origin/arbeit", "refs/remotes/origin/arbeit"] {
            repo.checkout("main");
            let status = branch_checkout(&tc, id.clone(), target.into()).await.unwrap();
            assert_eq!(status.head, Head::Branch { branch: "arbeit".into(), sha: local_sha.clone() }, "{target}");
            let upstream = status.upstream.expect("upstream stays");
            assert_eq!((upstream.ahead, upstream.behind), (0, 1));
        }
        assert_eq!(repo.git(&["rev-parse", "origin/arbeit"]), remote_sha);
    }

    #[tokio::test]
    async fn checkout_remote_branch_with_slash_in_remote_name() {
        let tc = TestCore::new().await;
        let (repo, remote, sha) = repo_with_remote_branch();
        repo.git(&["remote", "add", "team/zwei", &remote.url()]);
        repo.git(&["fetch", "-q", "team/zwei"]);
        let id = tc.open(&repo).await.repo.id;
        let status = branch_checkout(&tc, id, "team/zwei/feature/x".into()).await.unwrap();
        assert_eq!(status.head, Head::Branch { branch: "feature/x".into(), sha });
        assert_eq!(status.upstream.map(|u| u.name), Some("team/zwei/feature/x".to_string()));
    }

    /// Whoever leaves a detached HEAD with their own commits learns about it from the answer.
    #[tokio::test]
    async fn leaving_a_detached_head_reports_the_commits_no_ref_holds() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let first = repo.head();
        repo.commit_file("a.txt", "a\n", "Zweiter");
        let id = tc.open(&repo).await.repo.id;

        // Detached without own commits: nothing is left behind.
        branch_checkout(&tc, id.clone(), first.clone()).await.unwrap();
        assert_eq!(branch_checkout(&tc, id.clone(), "main".into()).await.unwrap().left_behind, None);

        // Two own commits on the detached HEAD, then back to the branch.
        branch_checkout(&tc, id.clone(), first.clone()).await.unwrap();
        repo.commit_file("lose-1.txt", "1\n", "Ohne Branch 1");
        let orphan = repo.commit_file("lose-2.txt", "2\n", "Ohne Branch 2");
        let status = branch_checkout(&tc, id.clone(), "main".into()).await.unwrap();
        assert_eq!(status.left_behind, Some(crate::model::LeftBehind { sha: orphan.clone(), count: 2 }));
        // An ordinary status does not carry the information.
        assert_eq!(read_status(&tc, &id).await.unwrap().left_behind, None);

        // If a branch hangs on it, nothing is left behind.
        branch_checkout(&tc, id.clone(), orphan.clone()).await.unwrap();
        repo.git(&["branch", "gerettet", &orphan]);
        assert_eq!(branch_checkout(&tc, id.clone(), "main".into()).await.unwrap().left_behind, None);
    }

    #[tokio::test]
    async fn checkout_commit_or_tag_detaches_head() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let first = repo.head();
        repo.git(&["tag", "-a", "v1.0", "-m", "Version 1"]);
        let second = repo.commit_file("a.txt", "a\n", "Zweiter");
        let id = tc.open(&repo).await.repo.id;

        let status = branch_checkout(&tc, id.clone(), first[..10].to_string()).await.unwrap();
        assert_eq!(status.head, Head::Detached { sha: first.clone() });
        let entry = undo::next_undo(&tc, &id, "").unwrap().unwrap();
        assert_eq!(entry.label, format!("Undo checkout of {}", &first[..7]));
        assert_eq!((entry.head_before.as_str(), entry.head_after.as_deref()), ("refs/heads/main", Some(first.as_str())));
        assert_eq!(entry.ref_name, None);

        // From detached back to the branch: head_before is the SHA.
        branch_checkout(&tc, id.clone(), "main".into()).await.unwrap();
        let entry = undo::next_undo(&tc, &id, "").unwrap().unwrap();
        assert_eq!((entry.head_before.as_str(), entry.head_after.as_deref()), (first.as_str(), Some("refs/heads/main")));
        assert_eq!(repo.head(), second);

        // An annotated tag leads to its commit.
        for target in ["v1.0", "refs/tags/v1.0"] {
            branch_checkout(&tc, id.clone(), "main".into()).await.unwrap();
            let status = branch_checkout(&tc, id.clone(), target.into()).await.unwrap();
            assert_eq!(status.head, Head::Detached { sha: first.clone() }, "{target}");
        }
        let entry = undo::next_undo(&tc, &id, "").unwrap().unwrap();
        assert_eq!(entry.label, "Undo checkout of v1.0");
        assert_eq!(repo.git(&["rev-parse", "main"]), second, "no branch was moved");
    }

    #[tokio::test]
    async fn checkout_blocked_by_local_changes_names_the_files() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        repo.commit_file("mit leerzeichen/Größe.txt", "main\n", "Datei auf main");
        repo.checkout_new("feature");
        repo.commit_file("mit leerzeichen/Größe.txt", "feature\n", "Feature ändert");
        repo.commit_file("nur-feature.txt", "f\n", "Feature neu");
        repo.checkout("main");
        // Changed where the branches differ; plus an untracked file that is in the way,
        // and a change that does not interfere.
        repo.write_file("mit leerzeichen/Größe.txt", "lokal\n");
        repo.write_file("nur-feature.txt", "liegt im Weg\n");
        repo.write_file("README.md", "# stört nicht\n");
        let id = tc.open(&repo).await.repo.id;
        let before = repo.head();

        let err = branch_checkout(&tc, id.clone(), "feature".into()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::DirtyWorktree);
        assert!(err.message.contains("2 files"), "{}", err.message);
        assert!(err.message.contains("‘mit leerzeichen/Größe.txt’"), "{}", err.message);
        assert!(err.message.contains("‘nur-feature.txt’"), "{}", err.message);
        assert!(!err.message.contains("README.md"), "{}", err.message);
        assert!(err.git_output.is_some());
        assert_eq!(repo.current_branch(), "main");
        assert_eq!(repo.head(), before);
        assert_eq!(repo.read_file("mit leerzeichen/Größe.txt"), b"lokal\n");
        assert_eq!(undo_count(&tc, &id), 0);

        // Without the interfering files the remaining change comes along.
        repo.git(&["checkout", "--", "mit leerzeichen/Größe.txt"]);
        repo.remove_file("nur-feature.txt");
        let status = branch_checkout(&tc, id, "feature".into()).await.unwrap();
        assert!(matches!(status.head, Head::Branch { ref branch, .. } if branch == "feature"));
        assert_eq!(status.unstaged.len(), 1);
        assert_eq!(repo.read_file("README.md"), "# stört nicht\n".as_bytes());
    }

    #[tokio::test]
    async fn checkout_of_branch_used_by_another_worktree_is_refused_with_its_path() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let other = repo.temp_dir().join("zweites");
        repo.git(&["worktree", "add", "-q", "-b", "anderswo", &other.to_string_lossy()]);
        let id = tc.open(&repo).await.repo.id;

        let err = branch_checkout(&tc, id.clone(), "anderswo".into()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
        assert!(err.message.contains("zweites"), "{}", err.message);
        assert_eq!(repo.current_branch(), "main");
        // Deleting does not work there either.
        let err = branch_delete(&tc, id, vec!["anderswo".into()], true).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
        assert!(err.message.contains("zweites"), "{}", err.message);
        assert_eq!(repo.git(&["rev-parse", "--verify", "refs/heads/anderswo"]), repo.head());
    }

    #[tokio::test]
    async fn checkout_is_refused_while_an_operation_runs_or_the_index_is_locked() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        repo.branch("frei");
        repo.checkout_new("feature");
        repo.commit_file("README.md", "# Feature\n", "Feature");
        repo.checkout("main");
        repo.commit_file("README.md", "# Main\n", "Main");
        let id = tc.open(&repo).await.repo.id;

        let lock = repo.path().join(".git").join("index.lock");
        std::fs::write(&lock, "").unwrap();
        let err = branch_checkout(&tc, id.clone(), "feature".into()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::Locked, "{err:?}");
        assert!(lock.exists());
        std::fs::remove_file(&lock).unwrap();
        assert_eq!(repo.current_branch(), "main");

        assert!(!repo.merge("feature"));
        let err = branch_checkout(&tc, id.clone(), "frei".into()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::OperationInProgress);
        assert!(err.message.contains("merge"), "{}", err.message);
        let err = branch_create(&tc, id, "neu".into(), None, true).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::OperationInProgress);
        assert!(repo.path().join(".git").join("MERGE_HEAD").exists());
    }

    // --- branch_rename ------------------------------------------------------

    #[tokio::test]
    async fn rename_keeps_upstream_and_follows_head() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let _remote = repo.add_remote();
        repo.branch("anderer");
        let id = tc.open(&repo).await.repo.id;
        tc.events.clear();

        // The checked-out branch with an upstream.
        let refs = branch_rename(&tc, id.clone(), "main".into(), "haupt/zweig".into()).await.unwrap();
        assert_eq!(refs.head, Head::Branch { branch: "haupt/zweig".into(), sha: repo.head() });
        assert!(!has(&refs.locals, "main"));
        let renamed = find(&refs.locals, "haupt/zweig");
        assert!(renamed.is_head);
        assert_eq!(renamed.upstream.as_deref(), Some("origin/main"));
        assert_eq!(repo.current_branch(), "haupt/zweig");
        assert_eq!(tc.events.named(names::REPO_CHANGED)[0]["what"], json!(["refs", "head", "config"]));

        // A branch that is not checked out, also with a full ref name.
        let refs = branch_rename(&tc, id.clone(), "refs/heads/anderer".into(), "größer".into()).await.unwrap();
        assert!(has(&refs.locals, "größer") && !has(&refs.locals, "anderer"));
        // Same name: nothing to do.
        branch_rename(&tc, id.clone(), "größer".into(), "größer".into()).await.unwrap();

        let err = branch_rename(&tc, id.clone(), "größer".into(), "haupt/zweig".into()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NameExists);
        let err = branch_rename(&tc, id.clone(), "größer".into(), "nicht erlaubt".into()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidName);
        let err = branch_rename(&tc, id.clone(), "gibt-es-nicht".into(), "egal".into()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        assert_eq!(undo_count(&tc, &id), 0);
    }

    #[tokio::test]
    async fn rename_into_own_folder_and_case_only() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        repo.branch("thema");
        repo.branch("Klein");
        let id = tc.open(&repo).await.repo.id;
        // "thema" → "thema/eins": the old name is not in the way of the new one.
        let refs = branch_rename(&tc, id.clone(), "thema".into(), "thema/eins".into()).await.unwrap();
        assert!(has(&refs.locals, "thema/eins") && !has(&refs.locals, "thema"));
        // Only change the case.
        let refs = branch_rename(&tc, id, "Klein".into(), "klein".into()).await.unwrap();
        assert!(has(&refs.locals, "klein") && !has(&refs.locals, "Klein"), "{:?}", refs.locals);
    }

    // --- branch_delete ------------------------------------------------------

    #[tokio::test]
    async fn delete_merged_branches_with_backup_and_undo() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let _remote = repo.add_remote();
        repo.checkout_new("fertig");
        let done = repo.commit_file("a.txt", "a\n", "Fertig");
        repo.git(&["push", "-q", "-u", "origin", "fertig"]);
        repo.checkout("main");
        assert!(repo.merge("fertig"));
        repo.branch("größe/zwei");
        let id = tc.open(&repo).await.repo.id;
        tc.events.clear();

        let refs = branch_delete(&tc, id.clone(), vec!["fertig".into(), "refs/heads/größe/zwei".into(), "fertig".into()], false)
            .await
            .unwrap();
        assert!(!has(&refs.locals, "fertig") && !has(&refs.locals, "größe/zwei"));
        assert_eq!(refs.locals.len(), 1);
        assert_eq!(tc.events.named(names::REPO_CHANGED)[0]["what"], json!(["refs", "config"]));
        // The branch's settings are gone too.
        assert!(!repo.git_output(&["config", "--get", "branch.fertig.remote"]).status.success());

        // Two branches at once are ONE step: one undo brings both back.
        assert_eq!(undo_count(&tc, &id), 1);
        let last = undo::next_undo(&tc, &id, "").unwrap().unwrap();
        assert_eq!(last.action, "delete_branch");
        assert_eq!(last.label, "Undo deletion of 2 branches");
        assert_eq!((last.ref_name.as_deref(), last.ref_before.as_deref(), last.ref_after.as_deref()), (None, None, None));
        assert_eq!((last.head_before.as_str(), last.head_after.as_deref()), ("refs/heads/main", Some("refs/heads/main")));
        assert_eq!(
            last.payload,
            json!({
                "composite": true,
                "steps": [
                    { "ref": "refs/heads/fertig", "before": done, "after": null },
                    { "ref": "refs/heads/größe/zwei", "before": repo.head(), "after": null },
                ],
                "upstreams": [{ "branch": "fertig", "upstream": "origin/fertig" }],
            })
        );
        assert_eq!(repo.git(&["rev-parse", &undo::backup_ref_name(&last.id, "before-0")]), done);
        assert_eq!(repo.git(&["rev-parse", &undo::backup_ref_name(&last.id, "before-1")]), repo.head());

        // Undo – even with uncommitted changes in the working directory: both branches including upstream.
        repo.write_file("unfertig.txt", "bleibt liegen\n");
        repo.git(&["add", "unfertig.txt"]);
        crate::commands::undo::undo(&tc, id.clone()).await.unwrap();
        assert_eq!(repo.git(&["rev-parse", "refs/heads/fertig"]), done);
        assert_eq!(repo.git(&["rev-parse", "refs/heads/größe/zwei"]), repo.head());
        assert_eq!(repo.git(&["config", "--get", "branch.fertig.remote"]), "origin");
        assert_eq!(repo.read_file("unfertig.txt"), b"bleibt liegen\n");
        // Redo deletes both again.
        crate::commands::undo::redo(&tc, id.clone()).await.unwrap();
        assert!(!repo.git_output(&["rev-parse", "-q", "--verify", "refs/heads/fertig"]).status.success());
        assert!(!repo.git_output(&["rev-parse", "-q", "--verify", "refs/heads/größe/zwei"]).status.success());
        assert!(!repo.git_output(&["config", "--get", "branch.fertig.remote"]).status.success());
    }

    #[tokio::test]
    async fn delete_checks_everything_before_deleting_anything() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        repo.branch("gemergt");
        repo.checkout_new("offen");
        let open = repo.commit_file("a.txt", "a\n", "Offen");
        repo.checkout_new("auch-offen");
        repo.commit_file("b.txt", "b\n", "Auch offen");
        repo.checkout("main");
        let id = tc.open(&repo).await.repo.id;

        // Not merged: nothing is deleted, not even the merged branch.
        let err = branch_delete(&tc, id.clone(), vec!["gemergt".into(), "offen".into(), "auch-offen".into()], false)
            .await
            .unwrap_err();
        assert_eq!(err.code, ErrorCode::NotMerged);
        assert!(err.message.contains("‘offen’") && err.message.contains("‘auch-offen’"), "{}", err.message);
        assert!(!err.message.contains("‘gemergt’"), "{}", err.message);
        assert_eq!(read_refs(&tc, &id).await.unwrap().locals.len(), 4);

        // The checked-out branch: not even with force, and again everything stays.
        let err = branch_delete(&tc, id.clone(), vec!["gemergt".into(), "main".into()], true).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
        assert!(err.message.contains("‘main’"), "{}", err.message);
        // Unknown name.
        let err = branch_delete(&tc, id.clone(), vec!["gemergt".into(), "fehlt".into()], true).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        assert_eq!(read_refs(&tc, &id).await.unwrap().locals.len(), 4);
        assert_eq!(undo_count(&tc, &id), 0);
        assert_eq!(repo.git(&["for-each-ref", "refs/forkyard"]), "");

        // Forced: the commit stays reachable via the backup ref.
        let refs = branch_delete(&tc, id.clone(), vec!["offen".into()], true).await.unwrap();
        assert!(!has(&refs.locals, "offen"));
        let entry = undo::next_undo(&tc, &id, "").unwrap().unwrap();
        assert_eq!(entry.ref_before.as_deref(), Some(open.as_str()));
        assert_eq!(repo.git(&["rev-parse", &undo::backup_ref_name(&entry.id, "before")]), open);
        // Empty list: nothing to do.
        assert_eq!(branch_delete(&tc, id, Vec::new(), false).await.unwrap().locals.len(), 3);
    }

    #[tokio::test]
    async fn delete_counts_a_pushed_branch_as_merged() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let _remote = repo.add_remote();
        repo.checkout_new("gepusht");
        repo.commit_file("a.txt", "a\n", "Gepusht");
        repo.git(&["push", "-q", "-u", "origin", "gepusht"]);
        repo.checkout_new("voraus");
        repo.git(&["branch", "-q", "--set-upstream-to=origin/gepusht"]);
        repo.commit_file("b.txt", "b\n", "Noch nicht gepusht");
        repo.git(&["checkout", "-q", "--detach", "main"]);
        let id = tc.open(&repo).await.repo.id;

        // Fully contained in the upstream: may go, although not in HEAD.
        let refs = branch_delete(&tc, id.clone(), vec!["gepusht".into()], false).await.unwrap();
        assert!(!has(&refs.locals, "gepusht"));
        let entry = undo::next_undo(&tc, &id, "").unwrap().unwrap();
        assert_eq!(entry.head_before, repo.head(), "detached HEAD is recorded as a SHA in the entry");
        // Ahead of the upstream: not merged.
        let err = branch_delete(&tc, id, vec!["voraus".into()], false).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotMerged);
    }

    // --- branch_set_upstream ------------------------------------------------

    #[tokio::test]
    async fn set_and_unset_upstream() {
        let tc = TestCore::new().await;
        let (repo, _remote, _sha) = repo_with_remote_branch();
        repo.branch("lokal");
        let id = tc.open(&repo).await.repo.id;
        tc.events.clear();

        let refs = branch_set_upstream(&tc, id.clone(), "lokal".into(), Some("origin/feature/x".into())).await.unwrap();
        let local = find(&refs.locals, "lokal");
        assert_eq!(local.upstream.as_deref(), Some("origin/feature/x"));
        assert_eq!((local.ahead, local.behind), (0, 1));
        assert_eq!(tc.events.named(names::REPO_CHANGED)[0]["what"], json!(["refs", "config"]));
        // The same again, and with the full name.
        branch_set_upstream(&tc, id.clone(), "lokal".into(), Some("refs/remotes/origin/main".into())).await.unwrap();
        assert_eq!(repo.git(&["rev-parse", "--abbrev-ref", "lokal@{upstream}"]), "origin/main");
        // A local branch as upstream.
        let refs = branch_set_upstream(&tc, id.clone(), "lokal".into(), Some("main".into())).await.unwrap();
        assert_eq!(find(&refs.locals, "lokal").upstream.as_deref(), Some("main"));

        let refs = branch_set_upstream(&tc, id.clone(), "lokal".into(), None).await.unwrap();
        assert_eq!(find(&refs.locals, "lokal").upstream, None);
        // Unsetting without an upstream is not an error.
        branch_set_upstream(&tc, id.clone(), "lokal".into(), None).await.unwrap();

        let err = branch_set_upstream(&tc, id.clone(), "lokal".into(), Some("origin/fehlt".into())).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        assert!(err.message.contains("origin/fehlt"), "{}", err.message);
        let err = branch_set_upstream(&tc, id.clone(), "fehlt".into(), Some("origin/main".into())).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        let err = branch_set_upstream(&tc, id.clone(), "lokal".into(), Some("lokal".into())).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
        let err = branch_set_upstream(&tc, id, "lokal".into(), Some("refs/tags/v1".into())).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    }

    // --- ref_name_check -----------------------------------------------------

    #[tokio::test]
    async fn name_check_gives_german_reasons() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        repo.branch("vorhanden");
        repo.tag("v1.0");
        let id = tc.open(&repo).await.repo.id;
        tc.events.clear();
        let check = |name: &str, kind: RefNameKind| ref_name_check(&tc, id.clone(), name.to_string(), kind);

        assert_eq!(check("feature/größe", RefNameKind::Branch).await.unwrap(), RefNameCheck { valid: true, reason: None });
        let taken = check("vorhanden", RefNameKind::Branch).await.unwrap();
        assert!(!taken.valid);
        assert_eq!(taken.reason.as_deref(), Some("A branch named ‘vorhanden’ already exists."));
        // Branches and tags have separate namespaces.
        assert!(check("vorhanden", RefNameKind::Tag).await.unwrap().valid);
        assert!(check("v1.0", RefNameKind::Branch).await.unwrap().valid);
        let taken = check("v1.0", RefNameKind::Tag).await.unwrap();
        assert_eq!(taken.reason.as_deref(), Some("A tag named ‘v1.0’ already exists."));

        for (bad, part) in [("", "empty"), ("a b", "spaces"), ("a..b", "“..”"), ("x.lock", "“.lock”"), ("a^", "“^”"), ("HEAD", "reserved")] {
            for kind in [RefNameKind::Branch, RefNameKind::Tag] {
                let result = check(bad, kind).await.unwrap();
                assert!(!result.valid, "{bad}");
                assert!(result.reason.as_deref().unwrap_or("").contains(part), "{bad}: {:?}", result.reason);
            }
        }
        let folder = check("vorhanden/unter", RefNameKind::Branch).await.unwrap();
        assert!(!folder.valid && folder.reason.unwrap().contains("‘vorhanden’"));
        // Pure read: no event, no log entry.
        assert!(tc.events.all().is_empty());

        let empty = TestRepo::new();
        let id = tc.open(&empty).await.repo.id;
        assert!(ref_name_check(&tc, id, "neu".into(), RefNameKind::Branch).await.unwrap().valid);
        let err = ref_name_check(&tc, "gibt-es-nicht".into(), "neu".into(), RefNameKind::Branch).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    }
}
