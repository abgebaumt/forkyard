//! Gitflow without an extra program: setting up, starting and finishing feature, release
//! and hotfix branches with ordinary Git commands.
//!
//! The setup is stored in the same keys as with `git flow` (`gitflow.branch.master`,
//! `gitflow.branch.develop`, `gitflow.prefix.*`), so existing setups are detected
//! and the command-line tool keeps matching.
//!
//! Rules when finishing:
//! - Feature: merge (always with a merge commit) into the development branch.
//! - Release and hotfix: merge into the main branch, annotated tag on it, merge back into
//!   the development branch.
//!
//! Afterwards HEAD is on the development branch; the finished branch is deleted
//! (can be turned off). If a merge stops in a conflict, `OpResult::Conflict` comes as with
//! `merge_start`; after resolving and continuing, a second call of `gitflow_finish` does
//! the rest (whatever is already merged or tagged is skipped).
//!
//! Undo: starting is a checkout step. Finishing leaves ONE composite step
//! (`merge` with `payload.composite`) that resets all moved refs and HEAD.

use std::collections::HashMap;

use serde_json::json;

use crate::app::Core;
use crate::commands::branches::{self, BranchInfo};
use crate::commands::commit::{head_label, hook_failure, Hooks, ABORTING_HOOKS};
use crate::commands::merge::stopped_or_failed;
use crate::commands::refs::read_head;
use crate::commands::status::{self, read_operation};
use crate::commands::sync::{self, PushRequest};
use crate::commands::tags;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::jobs::Job;
use crate::model::{
    GitflowBranch, GitflowFinishOptions, GitflowKind, GitflowPrefixes, GitflowStatus, Head, OpResult, PushResult, RefNameKind,
    RepoChange,
};
use crate::undo::{self, UndoAction, UndoRecord};
use crate::util;

const KEY_MAIN: &str = "gitflow.branch.master";
const KEY_DEVELOP: &str = "gitflow.branch.develop";
const KEY_FEATURE: &str = "gitflow.prefix.feature";
const KEY_RELEASE: &str = "gitflow.prefix.release";
const KEY_HOTFIX: &str = "gitflow.prefix.hotfix";
const KEY_VERSION_TAG: &str = "gitflow.prefix.versiontag";
/// `git flow` only considers a repository set up once these prefixes are set too.
const COMPAT_DEFAULTS: [(&str, &str); 2] = [("gitflow.prefix.bugfix", "bugfix/"), ("gitflow.prefix.support", "support/")];

const START_CHANGES: [RepoChange; 4] = [RepoChange::Head, RepoChange::Refs, RepoChange::Index, RepoChange::Worktree];
const FINISH_CHANGES: [RepoChange; 6] =
    [RepoChange::Worktree, RepoChange::Index, RepoChange::Refs, RepoChange::Head, RepoChange::Operation, RepoChange::Config];

fn kind_label(kind: GitflowKind) -> &'static str {
    match kind {
        GitflowKind::Feature => "Feature",
        GitflowKind::Release => "Release",
        GitflowKind::Hotfix => "Hotfix",
    }
}

/// The kind in lower case, for the middle of a sentence.
fn kind_noun(kind: GitflowKind) -> &'static str {
    match kind {
        GitflowKind::Feature => "feature",
        GitflowKind::Release => "release",
        GitflowKind::Hotfix => "hotfix",
    }
}

fn prefix_of(prefixes: &GitflowPrefixes, kind: GitflowKind) -> &str {
    match kind {
        GitflowKind::Feature => &prefixes.feature,
        GitflowKind::Release => &prefixes.release,
        GitflowKind::Hotfix => &prefixes.hotfix,
    }
}

fn not_initialized() -> CoreError {
    CoreError::not_allowed("Gitflow isn’t set up in this repository yet. Set the main and development branches first.")
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/// Setup and running feature, release and hotfix branches. Pure read command.
/// Without a setup, `main`, `develop` and `prefixes` are suggestions for `gitflow_init`.
pub async fn gitflow_status(core: &Core, repo_id: String) -> CoreResult<GitflowStatus> {
    Ok(read_state(core, &repo_id).await?.0)
}

/// All `gitflow.*` entries of the effective configuration (local before global), keys in lower case.
async fn read_config(core: &Core, repo_id: &str) -> CoreResult<HashMap<String, String>> {
    let out = core.git_for(repo_id)?.args(["config", "-z", "--get-regexp", r"^gitflow\."]).read_only().no_log().run_raw().await?;
    let mut map = HashMap::new();
    // Exit 1 only means: nothing set.
    if out.success() {
        for record in out.stdout_z() {
            let text = util::decode_lossy(record);
            let (key, value) = text.split_once('\n').unwrap_or((text.as_str(), ""));
            if !key.is_empty() {
                map.insert(key.to_lowercase(), value.to_string());
            }
        }
    }
    Ok(map)
}

async fn read_state(core: &Core, repo_id: &str) -> CoreResult<(GitflowStatus, Vec<BranchInfo>)> {
    let config = read_config(core, repo_id).await?;
    let branches = branches::local_branches(core, repo_id).await?;
    let set = |key: &str| config.get(key).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    let (main, develop) = (set(KEY_MAIN), set(KEY_DEVELOP));
    let initialized = main.is_some() && develop.is_some();
    let defaults = GitflowPrefixes::default();
    let prefix = |key: &str, default: String| config.get(key).map(|v| v.trim().to_string()).unwrap_or(default);
    let prefixes = GitflowPrefixes {
        feature: prefix(KEY_FEATURE, defaults.feature),
        release: prefix(KEY_RELEASE, defaults.release),
        hotfix: prefix(KEY_HOTFIX, defaults.hotfix),
        version_tag: prefix(KEY_VERSION_TAG, defaults.version_tag),
    };
    let has = |name: &str| branches.iter().any(|b| b.name == name);
    let main = main.unwrap_or_else(|| {
        if has("main") {
            "main".to_string()
        } else if has("master") {
            "master".to_string()
        } else {
            branches.iter().find(|b| b.is_head).map(|b| b.name.clone()).unwrap_or_else(|| "main".to_string())
        }
    });
    let develop = develop.unwrap_or_else(|| if !has("develop") && has("dev") { "dev".to_string() } else { "develop".to_string() });
    let mut active = Vec::new();
    if initialized {
        for branch in &branches {
            for kind in [GitflowKind::Feature, GitflowKind::Release, GitflowKind::Hotfix] {
                let prefix = prefix_of(&prefixes, kind);
                let name = branch.name.strip_prefix(prefix).filter(|rest| !prefix.is_empty() && !rest.is_empty());
                if let Some(name) = name {
                    active.push(GitflowBranch { kind, name: name.to_string(), branch: branch.name.clone() });
                    break;
                }
            }
        }
    }
    Ok((GitflowStatus { initialized, main, develop, prefixes, active }, branches))
}

// ---------------------------------------------------------------------------
// Setting up
// ---------------------------------------------------------------------------

/// Writes the setup into the repository's configuration. The main branch must
/// exist; the development branch is created if it is missing (from `origin/<name>`
/// if that exists, otherwise from the main branch). HEAD stays where it is.
pub async fn gitflow_init(
    core: &Core,
    repo_id: String,
    main: String,
    develop: String,
    prefixes: Option<GitflowPrefixes>,
) -> CoreResult<GitflowStatus> {
    let repo_id = repo_id.as_str();
    core.with_write_lock(repo_id, &[RepoChange::Config, RepoChange::Refs], async {
        let (main, develop) = (main.trim(), develop.trim());
        for (what, name) in [("main branch", main), ("development branch", develop)] {
            util::check_ref_name(name).map_err(|reason| CoreError::invalid_name(format!("“{name}” isn’t a valid name for the {what}: {reason}")))?;
        }
        if main == develop {
            return Err(CoreError::not_allowed("The main and development branches must be two different branches."));
        }
        let prefixes = prefixes.unwrap_or_default();
        check_prefixes(&prefixes)?;
        if matches!(read_head(core, repo_id).await?, Head::Unborn { .. }) {
            return Err(CoreError::not_allowed(
                "The repository has no commits yet. You can set up Gitflow only after the first commit.",
            ));
        }
        let existing = branches::local_branches(core, repo_id).await?;
        if !existing.iter().any(|b| b.name == main) {
            return Err(CoreError::not_found(format!("The main branch “{main}” doesn’t exist. Choose an existing branch.")));
        }
        if !existing.iter().any(|b| b.name == develop) {
            branches::check_new_name(core, repo_id, develop, RefNameKind::Branch, &branches::names_of(&existing), None).await?;
            let remote = format!("refs/remotes/origin/{develop}");
            if branches::resolve_commit(core, repo_id, &remote).await?.is_some() {
                core.git_for(repo_id)?.args(["branch", "--track", develop, &remote]).run().await?;
            } else {
                core.git_for(repo_id)?.args(["branch", "--no-track", develop, &format!("refs/heads/{main}")]).run().await?;
            }
        }
        let values = [
            (KEY_MAIN, main),
            (KEY_DEVELOP, develop),
            (KEY_FEATURE, prefixes.feature.as_str()),
            (KEY_RELEASE, prefixes.release.as_str()),
            (KEY_HOTFIX, prefixes.hotfix.as_str()),
            (KEY_VERSION_TAG, prefixes.version_tag.as_str()),
        ];
        for (key, value) in values {
            core.git_for(repo_id)?.args(["config", "--local", key, value]).run().await?;
        }
        let config = read_config(core, repo_id).await?;
        for (key, value) in COMPAT_DEFAULTS {
            if !config.contains_key(key) {
                core.git_for(repo_id)?.args(["config", "--local", key, value]).run().await?;
            }
        }
        Ok(read_state(core, repo_id).await?.0)
    })
    .await
}

fn check_prefixes(prefixes: &GitflowPrefixes) -> CoreResult<()> {
    let named = [("feature", &prefixes.feature), ("release", &prefixes.release), ("hotfix", &prefixes.hotfix)];
    for (what, prefix) in named {
        if prefix.trim().is_empty() {
            return Err(CoreError::invalid_name(format!("The prefix for {what} branches must not be empty.")));
        }
        util::check_ref_name(&format!("{prefix}x"))
            .map_err(|reason| CoreError::invalid_name(format!("“{prefix}” can’t be used as a prefix for {what} branches: {reason}")))?;
    }
    for (index, (what, prefix)) in named.iter().enumerate() {
        for (other_what, other) in &named[index + 1..] {
            if prefix.starts_with(other.as_str()) || other.starts_with(prefix.as_str()) {
                return Err(CoreError::invalid_name(format!(
                    "The prefixes for {what} (“{prefix}”) and {other_what} (“{other}”) overlap. Each kind needs its own prefix."
                )));
            }
        }
    }
    if !prefixes.version_tag.is_empty() {
        util::check_ref_name(&format!("{}1.0", prefixes.version_tag))
            .map_err(|reason| CoreError::invalid_name(format!("“{}” can’t be used as a prefix for version tags: {reason}", prefixes.version_tag)))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Starting
// ---------------------------------------------------------------------------

/// Creates `<prefix><name>` and checks it out. Starting point without `base`: feature and
/// release from the development branch, hotfix from the main branch. There is at most one
/// release and one hotfix branch at a time.
pub async fn gitflow_start(core: &Core, repo_id: String, kind: GitflowKind, name: String, base: Option<String>) -> CoreResult<GitflowStatus> {
    let repo_id = repo_id.as_str();
    core.with_write_lock(repo_id, &START_CHANGES, async {
        let (state, existing) = read_state(core, repo_id).await?;
        if !state.initialized {
            return Err(not_initialized());
        }
        let name = name.trim();
        let what = kind_noun(kind);
        if name.is_empty() {
            return Err(CoreError::invalid_name(format!("Enter a name for the {what} branch.")));
        }
        let branch = format!("{}{name}", prefix_of(&state.prefixes, kind));
        branches::check_new_name(core, repo_id, &branch, RefNameKind::Branch, &branches::names_of(&existing), None).await?;
        if kind != GitflowKind::Feature {
            if let Some(open) = state.active.iter().find(|a| a.kind == kind) {
                return Err(CoreError::not_allowed(format!(
                    "The {what} branch “{}” already exists. Finish it before you start another one.",
                    open.branch
                )));
            }
        }
        let default_base = if kind == GitflowKind::Hotfix { &state.main } else { &state.develop };
        let sha = match util::non_empty(base.map(|b| b.trim().to_string())) {
            Some(rev) => branches::resolve_commit(core, repo_id, &rev)
                .await?
                .ok_or_else(|| CoreError::not_found(format!("The starting point “{rev}” wasn’t found.")))?,
            None => branches::resolve_commit(core, repo_id, &format!("refs/heads/{default_base}")).await?.ok_or_else(|| {
                CoreError::not_found(format!("The branch “{default_base}” that a {what} starts from doesn’t exist (anymore)."))
            })?,
        };
        if let Some(op) = read_operation(core, repo_id).await? {
            return Err(operation_running(&op.kind));
        }
        let head = read_head(core, repo_id).await?;
        branches::run_checkout(core, repo_id, &["checkout", "--no-track", "-b", &branch, &sha], &sha).await?;
        let after = read_head(core, repo_id).await?;
        branches::record_checkout(core, repo_id, &head, &after, &branch, Some((&branch, None, &sha))).await?;
        Ok(read_state(core, repo_id).await?.0)
    })
    .await
}

fn operation_running(kind: &crate::model::OperationKind) -> CoreError {
    use crate::model::OperationKind::*;
    let name = match kind {
        Merge => "a merge",
        Rebase => "a rebase",
        CherryPick => "a cherry-pick",
        Revert => "a revert",
    };
    CoreError::new(
        ErrorCode::OperationInProgress,
        format!("There’s still {name} in progress. Finish or abort it first – then you can continue with Gitflow."),
    )
}

// ---------------------------------------------------------------------------
// Finishing
// ---------------------------------------------------------------------------

/// Finishes `<prefix><name>` (see the file header). With `options.push` the target
/// branches and the tag are pushed afterwards; `job_id` then carries progress and cancellation.
pub async fn gitflow_finish(
    core: &Core,
    repo_id: String,
    kind: GitflowKind,
    name: String,
    options: Option<GitflowFinishOptions>,
    job_id: Option<String>,
) -> CoreResult<OpResult> {
    let options = options.unwrap_or_default();
    let repo_id = repo_id.as_str();
    core.repo_path(repo_id)?;
    // The job is registered before the local work: a duplicate jobId then fails before anything happens.
    let job = match options.push {
        true => Some(core.start_job(&util::non_empty(job_id).unwrap_or_else(util::new_id), Some(repo_id))?),
        false => None,
    };
    let result = async {
        // Finishing checks out and merges: submodules follow the result (a stop on conflicts is no result).
        let finished = core.with_write_lock(repo_id, &FINISH_CHANGES, finish_locked(core, repo_id, kind, name.trim(), &options));
        let finished = crate::commands::submodule::auto::follow(core, repo_id, finished).await?;
        let (Some(job), OpResult::Done { sha, fast_forward, summary }) = (&job, &finished.result) else {
            return Ok(finished.result);
        };
        let pushed = sync::with_network_lock(core, repo_id, job.token(), push_all(core, repo_id, job, &finished.pushes)).await;
        core.emit_repo_changed(repo_id, &[RepoChange::Refs, RepoChange::Config]);
        match pushed {
            Ok(()) => Ok(OpResult::Done { sha: sha.clone(), fast_forward: *fast_forward, summary: format!("{summary}; pushed") }),
            Err(e) => Err(CoreError {
                message: format!("{} is finished locally, but the push failed: {}", kind_label(kind), e.message),
                ..e
            }),
        }
    }
    .await;
    if let Some(job) = job {
        job.finish(&result);
    }
    result
}

enum PushTarget {
    Branch(String),
    Tag(String),
}

struct Finished {
    result: OpResult,
    pushes: Vec<PushTarget>,
}

impl crate::commands::submodule::auto::Concluded for Finished {
    fn concluded(&self) -> bool {
        crate::commands::submodule::auto::Concluded::concluded(&self.result)
    }
}

/// A ref the finish moved, created (`before: None`) or deleted (`after: None`).
struct Step {
    name: String,
    before: Option<String>,
    after: Option<String>,
}

enum MergeStep {
    Merged(String),
    AlreadyMerged,
    Conflict(OpResult),
}

/// What is recorded for the undo step during the finish.
struct Progress<'a> {
    core: &'a Core,
    repo_id: &'a str,
    id: String,
    label: String,
    head_before: Head,
    steps: Vec<Step>,
    upstreams: Vec<(String, String)>,
    kind: GitflowKind,
    name: &'a str,
}

impl Progress<'_> {
    /// Writes the undo step for everything done so far. `head_after: None` if the
    /// finish stopped along the way and HEAD is not yet at its target.
    async fn record(&self, head_after: Option<&Head>) {
        if self.steps.is_empty() {
            return;
        }
        let result: CoreResult<()> = async {
            for (index, step) in self.steps.iter().enumerate() {
                // A deleted branch stays reachable through the backup.
                if let (Some(before), None) = (&step.before, &step.after) {
                    undo::create_backup_ref(self.core, self.repo_id, &self.id, &format!("before-{index}"), before).await?;
                }
            }
            let steps: Vec<_> = self.steps.iter().map(|s| json!({ "ref": s.name, "before": s.before, "after": s.after })).collect();
            let upstreams: Vec<_> = self.upstreams.iter().map(|(branch, upstream)| json!({ "branch": branch, "upstream": upstream })).collect();
            undo::record(
                self.core,
                UndoRecord {
                    id: self.id.clone(),
                    repo_id: self.repo_id.to_string(),
                    worktree_path: String::new(),
                    action: UndoAction::Merge,
                    label: self.label.clone(),
                    ref_name: None,
                    ref_before: None,
                    ref_after: None,
                    head_before: head_label(&self.head_before),
                    head_after: head_after.map(head_label),
                    payload: json!({
                        "composite": true,
                        "steps": steps,
                        "upstreams": upstreams,
                        "gitflow": { "kind": self.kind, "name": self.name },
                    }),
                },
            )
            .await?;
            Ok(())
        }
        .await;
        if let Err(e) = result {
            log::warn!("undo entry for the Gitflow finish not written: {}", e.message);
        }
    }
}

async fn finish_locked(core: &Core, repo_id: &str, kind: GitflowKind, name: &str, options: &GitflowFinishOptions) -> CoreResult<Finished> {
    let (state, existing) = read_state(core, repo_id).await?;
    if !state.initialized {
        return Err(not_initialized());
    }
    let what = kind_label(kind);
    let noun = kind_noun(kind);
    if let Some(op) = read_operation(core, repo_id).await? {
        return Err(operation_running(&op.kind));
    }
    let branch = format!("{}{name}", prefix_of(&state.prefixes, kind));
    let find = |wanted: &str| existing.iter().find(|b| b.name == wanted);
    let Some(source) = find(&branch).filter(|_| !name.is_empty()) else {
        return Err(CoreError::not_found(format!("The {noun} branch “{branch}” doesn’t exist (anymore).")));
    };
    let Some(develop) = find(&state.develop) else {
        return Err(CoreError::not_found(format!("The development branch “{}” doesn’t exist (anymore).", state.develop)));
    };
    let main = match kind {
        GitflowKind::Feature => None,
        _ => Some(
            find(&state.main).ok_or_else(|| CoreError::not_found(format!("The main branch “{}” doesn’t exist (anymore).", state.main)))?,
        ),
    };
    for info in [Some(source), Some(develop), main].into_iter().flatten() {
        if let Some(path) = branches::foreign_worktree(core, repo_id, info)? {
            return Err(CoreError::not_allowed(format!(
                "The branch “{}” is checked out in the worktree “{path}”. To finish, it must be possible to check it out here.",
                info.name
            )));
        }
    }
    let dirty = core.git_for(repo_id)?.args(["status", "--porcelain=v2", "-z", "--untracked-files=no"]).read_only().no_log().run().await?;
    if !dirty.stdout.is_empty() {
        return Err(CoreError::new(
            ErrorCode::DirtyWorktree,
            format!("To finish the {noun} “{name}”, the working directory must be clean. Commit or stash your changes first."),
        ));
    }
    if !status::identity_set(core, repo_id).await? {
        return Err(CoreError::new(
            ErrorCode::IdentityMissing,
            "Name and email for commits aren’t set.",
        ));
    }

    // Tag: check the name and detect an existing one of the same name before anything is merged.
    let tag = match main {
        Some(main) if !options.no_tag => {
            let tag = util::non_empty(options.tag.as_ref().map(|t| t.trim().to_string())).unwrap_or_else(|| format!("{}{name}", state.prefixes.version_tag));
            util::check_ref_name(&tag).map_err(|reason| CoreError::invalid_name(format!("“{tag}” isn’t a valid tag name: {reason}")))?;
            if let Some(commit) = undo::rev_parse(core, repo_id, &format!("refs/tags/{tag}^{{commit}}")).await? {
                let resumed = commit == main.sha && branches::is_ancestor(core, repo_id, &source.sha, &main.sha).await?;
                if !resumed {
                    return Err(CoreError::name_exists(format!(
                        "A tag named “{tag}” already exists. Enter a different name for the tag."
                    )));
                }
            }
            Some(tag)
        }
        _ => None,
    };

    let mut progress = Progress {
        core,
        repo_id,
        id: undo::new_id(),
        label: format!("Undo finishing {noun} ‘{name}’"),
        head_before: read_head(core, repo_id).await?,
        steps: Vec::new(),
        upstreams: Vec::new(),
        kind,
        name,
    };
    let mut done: Vec<String> = Vec::new();
    let targets: Vec<&BranchInfo> = main.into_iter().chain(std::iter::once(develop)).collect();
    for (index, target) in targets.iter().enumerate() {
        let merged = match merge_into(core, repo_id, target, source).await {
            Ok(step) => step,
            Err(e) => {
                progress.record(None).await;
                return Err(e);
            }
        };
        match merged {
            MergeStep::Merged(new) => {
                progress.steps.push(Step { name: format!("refs/heads/{}", target.name), before: Some(target.sha.clone()), after: Some(new) });
                done.push(format!("merged into {}", target.name));
            }
            MergeStep::AlreadyMerged => {}
            MergeStep::Conflict(result) => {
                progress.record(None).await;
                let note = format!(
                    "The merge into “{}” has conflicts. Resolve them and complete the merge; then run “Finish {noun}” again – the rest follows.",
                    target.name
                );
                let result = match result {
                    OpResult::Conflict { files, operation, .. } => OpResult::Conflict { files, operation, note: Some(note) },
                    other => other,
                };
                return Ok(Finished { result, pushes: Vec::new() });
            }
        }
        // The tag belongs on the main branch, directly after the merge into it.
        if let (0, Some(tag), Some(main)) = (index, &tag, main) {
            match create_tag(core, repo_id, kind, name, tag, &main.name, options.message.as_deref()).await {
                Ok(Some(object)) => {
                    progress.steps.push(Step { name: format!("refs/tags/{tag}"), before: None, after: Some(object) });
                    done.push(format!("created tag “{tag}”"));
                }
                Ok(None) => {}
                Err(e) => {
                    progress.record(None).await;
                    return Err(e);
                }
            }
        }
    }

    let tail: CoreResult<()> = async {
        // At the end HEAD is on the development branch – even if there was nothing left to merge.
        if !matches!(read_head(core, repo_id).await?, Head::Branch { branch, .. } if branch == develop.name) {
            branches::run_checkout(core, repo_id, &["checkout", &develop.name, "--"], &develop.sha).await?;
        }
        if options.delete_branch {
            let full = format!("refs/heads/{}", source.name);
            core.git_for(repo_id)?.args(["update-ref", "-m", "forkyard: Gitflow finished", "-d", &full, &source.sha]).run().await?;
            let _ = core.git_for(repo_id)?.args(["config", "--remove-section", &format!("branch.{}", source.name)]).no_log().run_raw().await;
            if let Some(upstream) = &source.upstream {
                progress.upstreams.push((source.name.clone(), crate::commands::refs::short_ref_name(upstream).to_string()));
            }
            progress.steps.push(Step { name: full, before: Some(source.sha.clone()), after: None });
            done.push("deleted branch".to_string());
        }
        Ok(())
    }
    .await;
    let head_after = read_head(core, repo_id).await?;
    if let Err(e) = tail {
        progress.record(None).await;
        return Err(e);
    }
    progress.record(Some(&head_after)).await;

    if done.is_empty() {
        return Ok(Finished { result: OpResult::UpToDate, pushes: Vec::new() });
    }
    let mut pushes: Vec<PushTarget> = targets.iter().map(|t| PushTarget::Branch(t.name.clone())).collect();
    if let Some(tag) = tag {
        pushes.push(PushTarget::Tag(tag));
    }
    let sha = undo::rev_parse(core, repo_id, &format!("refs/heads/{}", develop.name)).await?;
    Ok(Finished { result: OpResult::Done { sha, fast_forward: false, summary: format!("{what} “{name}” finished: {}", done.join(", ")) }, pushes })
}

/// Merges `source` into `target` with a merge commit (checks out `target` for that). If `source`
/// is already contained there, nothing happens.
async fn merge_into(core: &Core, repo_id: &str, target: &BranchInfo, source: &BranchInfo) -> CoreResult<MergeStep> {
    if branches::is_ancestor(core, repo_id, &source.sha, &format!("refs/heads/{}", target.name)).await? {
        return Ok(MergeStep::AlreadyMerged);
    }
    if !matches!(read_head(core, repo_id).await?, Head::Branch { branch, .. } if branch == target.name) {
        branches::run_checkout(core, repo_id, &["checkout", &target.name, "--"], &target.sha).await?;
    }
    // The short name gives the usual message ("Merge branch 'x'"); only if it means something
    // else (a tag of the same name) does Git get the full name.
    let full = format!("refs/heads/{}", source.name);
    let plain = branches::resolve_commit(core, repo_id, &source.name).await?;
    let arg = if plain.as_deref() == Some(source.sha.as_str()) { source.name.clone() } else { full };
    let hooks = Hooks::start(core, repo_id).await;
    let out = hooks.wrap(core.git_for(repo_id)?).args(["merge", "--no-ff", "--no-edit"]).arg(&arg).run_raw().await;
    let ran = hooks.finish(core, repo_id);
    let out = out?;
    if !out.success() {
        if let Some(error) = hook_failure(&ran, &ABORTING_HOOKS, &out, "the merge commit") {
            return Err(error);
        }
        return Ok(MergeStep::Conflict(stopped_or_failed(core, repo_id, "merge", &out).await?));
    }
    let new = undo::rev_parse(core, repo_id, "HEAD^{commit}").await?.ok_or_else(CoreError::stale_state)?;
    Ok(MergeStep::Merged(new))
}

/// Annotated tag on the tip of `main`. `None`: it was already there (second attempt).
/// Otherwise the SHA of the tag object.
async fn create_tag(core: &Core, repo_id: &str, kind: GitflowKind, name: &str, tag: &str, main: &str, message: Option<&str>) -> CoreResult<Option<String>> {
    let full = format!("refs/tags/{tag}");
    let tip = undo::rev_parse(core, repo_id, &format!("refs/heads/{main}^{{commit}}")).await?.ok_or_else(CoreError::stale_state)?;
    if let Some(commit) = undo::rev_parse(core, repo_id, &format!("{full}^{{commit}}")).await? {
        if commit == tip {
            return Ok(None);
        }
        return Err(CoreError::name_exists(format!("A tag named “{tag}” already exists but points to a different commit.")));
    }
    let message = match message.map(str::trim_end).filter(|m| !m.trim().is_empty()) {
        Some(text) => format!("{text}\n"),
        None => format!("{} {name}\n", kind_label(kind)),
    };
    core.git_for(repo_id)?.args(["tag", "-a", "--cleanup=whitespace", "-F", "-", tag, &tip]).stdin(message).run().await?;
    undo::rev_parse(core, repo_id, &full).await
}

/// Pushes the target branches (to their upstream, otherwise to the only remote or `origin`) and the tag.
async fn push_all(core: &Core, repo_id: &str, job: &Job, targets: &[PushTarget]) -> CoreResult<()> {
    let remotes = crate::commands::remotes::read_remotes(core, repo_id).await?;
    let fallback = match remotes.as_slice() {
        [] => return Err(CoreError::new(ErrorCode::NoRemote, "This repository has no remote to push to.")),
        [only] => only.name.clone(),
        many => many.iter().find(|r| r.name == "origin").unwrap_or(&many[0]).name.clone(),
    };
    let mut tag_remote = fallback.clone();
    for target in targets {
        job.token().check()?;
        let (label, result) = match target {
            PushTarget::Branch(branch) => {
                let upstream = sync::branch_upstream(core, repo_id, branch).await?.filter(|(remote, _)| remote != ".");
                if let Some((remote, _)) = &upstream {
                    tag_remote = remote.clone();
                }
                let remote = if upstream.is_some() { None } else { Some(fallback.as_str()) };
                let request = PushRequest { branch: Some(branch), remote, remote_branch: None, force: false, expected: None };
                (format!("Branch “{branch}”"), sync::push_transfer(core, repo_id, job.token(), Some(job), request).await?)
            }
            PushTarget::Tag(tag) => (format!("Tag “{tag}”"), tags::push_tag(core, repo_id, job, tag, &tag_remote).await?),
        };
        if let PushResult::Rejected { reason } = result {
            return Err(CoreError::new(ErrorCode::PushRejected, format!("{label} was rejected: {reason}")));
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "gitflow_tests.rs"]
mod tests;
