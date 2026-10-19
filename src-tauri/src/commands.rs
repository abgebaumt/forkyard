//! Tauri bindings: exactly one function per command from src/core/api.ts, which only
//! delegates to `gitcore::commands`. Parameters = keys of the input object (Tauri
//! maps `repoId` to `repo_id`). `node scripts/check-commands.mjs` checks this file
//! and the list in lib.rs against api.ts.

use gitcore::commands as c;
use gitcore::model::*;
use gitcore::{Core, CoreError};
use serde::de::DeserializeOwned;
use serde_json::Value;
use tauri::State;

type R<T> = Result<T, CoreError>;

/// Field of a partial object: missing = `None`, `null` = `Some(None)`, value = `Some(Some(..))`.
fn tri_state<T: DeserializeOwned>(body: &Value, key: &str) -> R<Option<Option<T>>> {
    match body.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(v) => serde_json::from_value(v.clone())
            .map(|v| Some(Some(v)))
            .map_err(|e| CoreError::not_allowed(format!("Invalid value for “{key}”: {e}"))),
    }
}

#[tauri::command]
pub async fn app_info(core: State<'_, Core>) -> R<AppInfo> {
    c::app::app_info(&core).await
}

#[tauri::command]
pub async fn app_recheck_git(core: State<'_, Core>) -> R<AppInfo> {
    c::app::app_recheck_git(&core).await
}

#[tauri::command]
pub async fn update_check(core: State<'_, Core>, manual: bool) -> R<UpdateInfo> {
    c::update::update_check(&core, manual).await
}

#[tauri::command]
pub async fn update_dismiss(core: State<'_, Core>, version: String, skip: bool) -> R<UpdateInfo> {
    c::update::update_dismiss(&core, version, skip).await
}

#[tauri::command]
pub async fn app_close_guard(core: State<'_, Core>, active: bool) -> R<()> {
    c::app::app_close_guard(&core, active).await
}

/// Quits the app after a confirmed prompt: cancel running actions, close the window.
#[tauri::command]
pub async fn app_quit(core: State<'_, Core>, window: tauri::Window) -> R<()> {
    c::app::app_quit(&core).await?;
    if let Err(e) = window.close() {
        log::warn!("Could not close the window: {e}");
    }
    Ok(())
}

#[tauri::command]
pub async fn app_launch_request(core: State<'_, Core>) -> R<Option<LaunchRequest>> {
    c::launch::app_launch_request(&core).await
}

#[tauri::command]
pub async fn repo_open(core: State<'_, Core>, path: String, add_to_profile: Option<bool>) -> R<OpenedRepo> {
    c::repos::repo_open_with(&core, path, add_to_profile.unwrap_or(false)).await
}

#[tauri::command]
pub async fn repo_trust_get(core: State<'_, Core>, repo_id: String) -> R<RepoTrust> {
    c::trust::repo_trust_get(&core, repo_id).await
}

#[tauri::command]
pub async fn repo_trust_set(core: State<'_, Core>, repo_id: String, trusted: bool) -> R<RepoTrust> {
    c::trust::repo_trust_set(&core, repo_id, trusted).await
}

#[tauri::command]
pub async fn repo_list(core: State<'_, Core>) -> R<Vec<Repo>> {
    c::repos::repo_list(&core).await
}

#[tauri::command]
pub async fn repo_profiles(core: State<'_, Core>, path: String) -> R<Vec<ProfileRef>> {
    c::repos::repo_profiles(&core, path).await
}

// `alias`, `groupName` and `color` distinguish “missing” from `null`; Tauri can't do that for
// individual parameters, so the raw input object is read here.
// gc:params repoId,alias,isFavorite,groupName,color
#[tauri::command]
pub async fn repo_update(core: State<'_, Core>, request: tauri::ipc::Request<'_>) -> R<Repo> {
    let tauri::ipc::InvokeBody::Json(body) = request.body() else {
        return Err(CoreError::not_allowed("repo_update expects a JSON object."));
    };
    let repo_id = tri_state::<String>(body, "repoId")?
        .flatten()
        .ok_or_else(|| CoreError::not_allowed("repo_update: “repoId” is missing."))?;
    let alias = tri_state::<String>(body, "alias")?;
    let is_favorite = tri_state::<bool>(body, "isFavorite")?.flatten();
    let group_name = tri_state::<String>(body, "groupName")?;
    let color = tri_state::<u8>(body, "color")?;
    c::repos::repo_update(&core, repo_id, alias, is_favorite, group_name, color).await
}

#[tauri::command]
pub async fn repo_forget(core: State<'_, Core>, repo_id: String) -> R<()> {
    c::repos::repo_forget(&core, repo_id).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn repo_clone(core: State<'_, Core>, job_id: String, url: String, parent_path: String, name: String, options: CloneOptions) -> R<OpenedRepo> {
    c::clone_init::repo_clone(&core, job_id, url, parent_path, name, options).await
}

#[tauri::command]
pub async fn repo_init(core: State<'_, Core>, options: InitOptions) -> R<OpenedRepo> {
    c::clone_init::repo_init(&core, options).await
}

#[tauri::command]
pub async fn init_templates(core: State<'_, Core>) -> R<InitTemplates> {
    c::clone_init::init_templates(&core).await
}

#[tauri::command]
pub async fn repo_readme(core: State<'_, Core>, repo_id: String) -> R<Option<String>> {
    c::repos::repo_readme(&core, repo_id).await
}

#[tauri::command]
pub async fn workspace_list(core: State<'_, Core>) -> R<Vec<Workspace>> {
    c::workspace::workspace_list(&core).await
}

#[tauri::command]
pub async fn workspace_save(core: State<'_, Core>, id: Option<String>, name: String, repo_ids: Vec<String>) -> R<Vec<Workspace>> {
    c::workspace::workspace_save(&core, id, name, repo_ids).await
}

#[tauri::command]
pub async fn workspace_delete(core: State<'_, Core>, id: String) -> R<Vec<Workspace>> {
    c::workspace::workspace_delete(&core, id).await
}

#[tauri::command]
pub async fn workspace_fetch(core: State<'_, Core>, job_id: String, workspace_id: String) -> R<WorkspaceRunResult> {
    c::workspace::workspace_fetch(&core, job_id, workspace_id).await
}

#[tauri::command]
pub async fn workspace_pull(core: State<'_, Core>, job_id: String, workspace_id: String, mode: Option<PullMode>) -> R<WorkspaceRunResult> {
    c::workspace::workspace_pull(&core, job_id, workspace_id, mode).await
}

#[tauri::command]
pub async fn tabs_list(core: State<'_, Core>) -> R<Vec<Tab>> {
    c::repos::tabs_list(&core).await
}

#[tauri::command]
pub async fn tab_open(core: State<'_, Core>, repo_id: Option<String>) -> R<Vec<Tab>> {
    c::repos::tab_open(&core, repo_id).await
}

#[tauri::command]
pub async fn tab_close(core: State<'_, Core>, tab_id: String) -> R<Vec<Tab>> {
    c::repos::tab_close(&core, tab_id).await
}

#[tauri::command]
pub async fn tab_move(core: State<'_, Core>, tab_id: String, position: i64) -> R<Vec<Tab>> {
    c::repos::tab_move(&core, tab_id, position).await
}

#[tauri::command]
pub async fn tab_activate(core: State<'_, Core>, tab_id: String) -> R<Vec<Tab>> {
    c::repos::tab_activate(&core, tab_id).await
}

#[tauri::command]
pub async fn graph_page(core: State<'_, Core>, repo_id: String, cursor: Option<String>, limit: u32) -> R<GraphPage> {
    c::graph::graph_page(&core, repo_id, cursor, limit).await
}

#[tauri::command]
pub async fn refs_list(core: State<'_, Core>, repo_id: String) -> R<RefsSnapshot> {
    c::refs::refs_list(&core, repo_id).await
}

#[tauri::command]
pub async fn commit_details(core: State<'_, Core>, repo_id: String, source: DiffSource) -> R<CommitDetails> {
    c::graph::commit_details(&core, repo_id, source).await
}

#[tauri::command]
pub async fn commit_search(core: State<'_, Core>, repo_id: String, query: String, limit: u32, search_id: Option<String>, filters: Option<CommitSearchFilters>) -> R<Vec<CommitSummary>> {
    c::graph::commit_search(&core, repo_id, query, limit, search_id, filters).await
}

#[tauri::command]
pub async fn tree_list(core: State<'_, Core>, repo_id: String, sha: Option<String>, filter: Option<String>) -> R<Vec<String>> {
    c::graph::tree_list(&core, repo_id, sha, filter).await
}

#[tauri::command]
pub async fn view_state_get(core: State<'_, Core>, repo_id: String) -> R<RepoViewState> {
    c::view::view_state_get(&core, repo_id).await
}

#[tauri::command]
pub async fn view_state_set(core: State<'_, Core>, repo_id: String, patch: Value) -> R<RepoViewState> {
    c::view::view_state_set(&core, repo_id, patch).await
}

#[tauri::command]
pub async fn reflog_list(core: State<'_, Core>, repo_id: String, ref_name: Option<String>, cursor: Option<String>, limit: u32) -> R<ReflogPage> {
    c::reflog::reflog_list(&core, repo_id, ref_name, cursor, limit).await
}

#[tauri::command]
pub async fn status_get(core: State<'_, Core>, repo_id: String) -> R<Status> {
    c::status::status_get(&core, repo_id).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn diff_file(
    core: State<'_, Core>,
    repo_id: String,
    path: String,
    source: DiffSource,
    force: Option<bool>,
    ignore_whitespace: Option<bool>,
    encoding: Option<String>,
) -> R<FileDiff> {
    c::diff::diff_file(&core, repo_id, path, source, force, ignore_whitespace, encoding).await
}

#[tauri::command]
pub async fn stage_paths(core: State<'_, Core>, repo_id: String, paths: Option<Vec<String>>) -> R<Status> {
    c::stage::stage_paths(&core, repo_id, paths).await
}

#[tauri::command]
pub async fn unstage_paths(core: State<'_, Core>, repo_id: String, paths: Option<Vec<String>>) -> R<Status> {
    c::stage::unstage_paths(&core, repo_id, paths).await
}

#[tauri::command]
pub async fn stage_patch(core: State<'_, Core>, repo_id: String, selection: PatchSelection) -> R<Status> {
    c::stage::stage_patch(&core, repo_id, selection).await
}

#[tauri::command]
pub async fn unstage_patch(core: State<'_, Core>, repo_id: String, selection: PatchSelection) -> R<Status> {
    c::stage::unstage_patch(&core, repo_id, selection).await
}

#[tauri::command]
pub async fn discard_patch(core: State<'_, Core>, repo_id: String, selection: PatchSelection) -> R<Status> {
    c::stage::discard_patch(&core, repo_id, selection).await
}

#[tauri::command]
pub async fn range_apply(core: State<'_, Core>, repo_id: String, from: String, to: String, selections: Vec<PatchSelection>, target: RangeApplyTarget) -> R<Status> {
    c::range_apply::range_apply(&core, repo_id, from, to, selections, target).await
}

#[tauri::command]
pub async fn discard_paths(core: State<'_, Core>, repo_id: String, paths: Option<Vec<String>>) -> R<Status> {
    c::stage::discard_paths(&core, repo_id, paths).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn commit_create(core: State<'_, Core>, repo_id: String, op_id: String, summary: String, description: String, amend: bool, skip_hooks: bool, push_after: bool, stage_all: bool, expected_head: Option<String>) -> R<CommitResult> {
    c::commit::commit_create(&core, repo_id, op_id, summary, description, amend, skip_hooks, push_after, stage_all, expected_head).await
}

#[tauri::command]
pub async fn commit_reword(core: State<'_, Core>, repo_id: String, summary: String, description: String, sha: Option<String>) -> R<CommitResult> {
    c::commit::commit_reword(&core, repo_id, summary, description, sha).await
}

#[tauri::command]
pub async fn compose_units(core: State<'_, Core>, repo_id: String) -> R<ComposeState> {
    c::compose::compose_units(&core, repo_id).await
}

#[tauri::command]
pub async fn compose_proposal(
    core: State<'_, Core>,
    repo_id: String,
    job_id: String,
    locale: String,
    instruction: Option<String>,
    keep: Vec<ComposeKeep>,
) -> R<ComposeProposal> {
    c::compose::compose_proposal(&core, repo_id, job_id, locale, instruction, keep).await
}

#[tauri::command]
pub async fn compose_apply(core: State<'_, Core>, repo_id: String, job_id: String, plan: ComposePlan, expect_token: String) -> R<ComposeResult> {
    c::compose::compose_apply(&core, repo_id, job_id, plan, expect_token).await
}

#[tauri::command]
pub async fn draft_get(core: State<'_, Core>, repo_id: String) -> R<CommitDraft> {
    c::view::draft_get(&core, repo_id).await
}

#[tauri::command]
pub async fn draft_set(core: State<'_, Core>, repo_id: String, draft: CommitDraft) -> R<()> {
    c::view::draft_set(&core, repo_id, draft).await
}

#[tauri::command]
pub async fn ignore_add(core: State<'_, Core>, repo_id: String, pattern: String, stop_tracking: bool) -> R<Status> {
    c::stage::ignore_add(&core, repo_id, pattern, stop_tracking).await
}

#[tauri::command]
pub async fn file_restore(core: State<'_, Core>, repo_id: String, sha: String, paths: Vec<String>) -> R<Status> {
    c::stage::file_restore(&core, repo_id, sha, paths).await
}

#[tauri::command]
pub async fn file_delete(core: State<'_, Core>, repo_id: String, path: String) -> R<Status> {
    c::stage::file_delete(&core, repo_id, path).await
}

#[tauri::command]
pub async fn branch_create(core: State<'_, Core>, repo_id: String, name: String, start: Option<String>, checkout: bool) -> R<RefsSnapshot> {
    c::branches::branch_create(&core, repo_id, name, start, checkout).await
}

#[tauri::command]
pub async fn branch_checkout(core: State<'_, Core>, repo_id: String, target: String) -> R<Status> {
    c::branches::branch_checkout(&core, repo_id, target).await
}

#[tauri::command]
pub async fn branch_rename(core: State<'_, Core>, repo_id: String, name: String, new_name: String) -> R<RefsSnapshot> {
    c::branches::branch_rename(&core, repo_id, name, new_name).await
}

#[tauri::command]
pub async fn branch_delete(core: State<'_, Core>, repo_id: String, names: Vec<String>, force: bool) -> R<RefsSnapshot> {
    c::branches::branch_delete(&core, repo_id, names, force).await
}

#[tauri::command]
pub async fn branch_delete_remote(core: State<'_, Core>, repo_id: String, job_id: String, remote: String, name: String) -> R<PushResult> {
    c::sync::branch_delete_remote(&core, repo_id, job_id, remote, name).await
}

#[tauri::command]
pub async fn branch_set_upstream(core: State<'_, Core>, repo_id: String, name: String, upstream: Option<String>) -> R<RefsSnapshot> {
    c::branches::branch_set_upstream(&core, repo_id, name, upstream).await
}

#[tauri::command]
pub async fn branch_fast_forward(core: State<'_, Core>, repo_id: String, branch: String) -> R<OpResult> {
    c::branches::branch_fast_forward(&core, repo_id, branch).await
}

#[tauri::command]
pub async fn gitflow_status(core: State<'_, Core>, repo_id: String) -> R<GitflowStatus> {
    c::gitflow::gitflow_status(&core, repo_id).await
}

#[tauri::command]
pub async fn gitflow_init(core: State<'_, Core>, repo_id: String, main: String, develop: String, prefixes: Option<GitflowPrefixes>) -> R<GitflowStatus> {
    c::gitflow::gitflow_init(&core, repo_id, main, develop, prefixes).await
}

#[tauri::command]
pub async fn gitflow_start(core: State<'_, Core>, repo_id: String, kind: GitflowKind, name: String, base: Option<String>) -> R<GitflowStatus> {
    c::gitflow::gitflow_start(&core, repo_id, kind, name, base).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn gitflow_finish(
    core: State<'_, Core>,
    repo_id: String,
    kind: GitflowKind,
    name: String,
    options: Option<GitflowFinishOptions>,
    job_id: Option<String>,
) -> R<OpResult> {
    c::gitflow::gitflow_finish(&core, repo_id, kind, name, options, job_id).await
}

#[tauri::command]
pub async fn ref_name_check(core: State<'_, Core>, repo_id: String, name: String, kind: RefNameKind) -> R<RefNameCheck> {
    c::branches::ref_name_check(&core, repo_id, name, kind).await
}

#[tauri::command]
pub async fn merge_start(core: State<'_, Core>, repo_id: String, source: String, mode: MergeMode) -> R<OpResult> {
    c::merge::merge_start(&core, repo_id, source, mode).await
}

#[tauri::command]
pub async fn conflict_get(core: State<'_, Core>, repo_id: String, path: String) -> R<ConflictFile> {
    c::merge::conflict_get(&core, repo_id, path).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn conflict_resolve(core: State<'_, Core>, repo_id: String, path: String, content: Option<String>, side: Option<ConflictSide>) -> R<Status> {
    c::merge::conflict_resolve(&core, repo_id, path, content, side).await
}

#[tauri::command]
pub async fn operation_continue(core: State<'_, Core>, repo_id: String, message: Option<String>, skip_hooks: Option<bool>) -> R<OpResult> {
    c::merge::operation_continue(&core, repo_id, message, skip_hooks).await
}

#[tauri::command]
pub async fn operation_abort(core: State<'_, Core>, repo_id: String) -> R<Status> {
    c::merge::operation_abort(&core, repo_id).await
}

#[tauri::command]
pub async fn rebase_start(core: State<'_, Core>, repo_id: String, onto: String, branch: Option<String>, update_refs: Option<bool>) -> R<OpResult> {
    c::rebase::rebase_start_with(&core, repo_id, onto, branch, update_refs).await
}

#[tauri::command]
pub async fn rebase_plan(core: State<'_, Core>, repo_id: String, base: String, autosquash: Option<bool>) -> R<RebasePlan> {
    c::rebase::rebase_plan_with(&core, repo_id, base, autosquash).await
}

#[tauri::command]
pub async fn rebase_dependents(core: State<'_, Core>, repo_id: String, onto: String, branch: Option<String>) -> R<Vec<String>> {
    c::rebase::rebase_dependents(&core, repo_id, onto, branch).await
}

#[tauri::command]
pub async fn rebase_apply(core: State<'_, Core>, repo_id: String, base: String, rows: Vec<RebasePlanRow>, update_refs: Option<bool>) -> R<OpResult> {
    c::rebase::rebase_apply_with(&core, repo_id, base, rows, update_refs).await
}

#[tauri::command]
pub async fn cherry_pick(core: State<'_, Core>, repo_id: String, shas: Vec<String>) -> R<OpResult> {
    c::rebase::cherry_pick(&core, repo_id, shas).await
}

#[tauri::command]
pub async fn squash_commits(core: State<'_, Core>, repo_id: String, shas: Vec<String>, message: String) -> R<OpResult> {
    c::rebase::squash_commits(&core, repo_id, shas, message).await
}

#[tauri::command]
pub async fn revert_commit(core: State<'_, Core>, repo_id: String, sha: String) -> R<OpResult> {
    c::merge::revert_commit(&core, repo_id, sha).await
}

#[tauri::command]
pub async fn conflict_preview(core: State<'_, Core>, repo_id: String, job_id: String, op: PreviewOp) -> R<ConflictPreview> {
    c::preview::conflict_preview(&core, repo_id, job_id, op).await
}

#[tauri::command]
pub async fn reset_branch(core: State<'_, Core>, repo_id: String, sha: String, mode: ResetMode) -> R<Status> {
    c::merge::reset_branch(&core, repo_id, sha, mode).await
}

#[tauri::command]
pub async fn bisect_status(core: State<'_, Core>, repo_id: String) -> R<BisectStatus> {
    c::bisect::bisect_status(&core, repo_id).await
}

#[tauri::command]
pub async fn bisect_start(core: State<'_, Core>, repo_id: String, bad: String, good: Vec<String>) -> R<BisectStatus> {
    c::bisect::bisect_start(&core, repo_id, bad, good).await
}

#[tauri::command]
pub async fn bisect_mark(core: State<'_, Core>, repo_id: String, verdict: BisectVerdict, sha: Option<String>) -> R<BisectStatus> {
    c::bisect::bisect_mark(&core, repo_id, verdict, sha).await
}

#[tauri::command]
pub async fn bisect_reset(core: State<'_, Core>, repo_id: String) -> R<BisectStatus> {
    c::bisect::bisect_reset(&core, repo_id).await
}

#[tauri::command]
pub async fn bisect_autopilot_script(core: State<'_, Core>, repo_id: String, job_id: String, request: BisectScriptRequest, locale: String) -> R<BisectScript> {
    c::bisect::bisect_autopilot_script(&core, repo_id, job_id, request, locale).await
}

#[tauri::command]
pub async fn bisect_autopilot_run(core: State<'_, Core>, repo_id: String, job_id: String, bad: String, good: Vec<String>, script: String, step_timeout_secs: u64) -> R<BisectAutopilot> {
    c::bisect::bisect_autopilot_run(&core, repo_id, job_id, bad, good, script, step_timeout_secs).await
}

#[tauri::command]
pub async fn bisect_autopilot_status(core: State<'_, Core>, repo_id: String) -> R<Option<BisectAutopilot>> {
    c::bisect::bisect_autopilot_status(&core, repo_id).await
}

#[tauri::command]
pub async fn bisect_autopilot_close(core: State<'_, Core>, repo_id: String, keep_worktree: bool) -> R<Option<String>> {
    c::bisect::bisect_autopilot_close(&core, repo_id, keep_worktree).await
}

#[tauri::command]
pub async fn remote_list(core: State<'_, Core>, repo_id: String) -> R<Vec<Remote>> {
    c::remotes::remote_list(&core, repo_id).await
}

#[tauri::command]
pub async fn remote_add(core: State<'_, Core>, repo_id: String, name: String, fetch_url: String, push_url: Option<String>) -> R<Vec<Remote>> {
    c::remotes::remote_add(&core, repo_id, name, fetch_url, push_url).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn remote_edit(core: State<'_, Core>, repo_id: String, name: String, new_name: String, fetch_url: String, push_url: Option<String>) -> R<Vec<Remote>> {
    c::remotes::remote_edit(&core, repo_id, name, new_name, fetch_url, push_url).await
}

#[tauri::command]
pub async fn remote_remove(core: State<'_, Core>, repo_id: String, name: String) -> R<Vec<Remote>> {
    c::remotes::remote_remove(&core, repo_id, name).await
}

#[tauri::command]
pub async fn fetch(core: State<'_, Core>, repo_id: String, job_id: String, remote: Option<String>, prune: bool) -> R<FetchResult> {
    c::sync::fetch(&core, repo_id, job_id, remote, prune).await
}

#[tauri::command]
pub async fn pull(core: State<'_, Core>, repo_id: String, job_id: String, mode: Option<PullMode>) -> R<OpResult> {
    c::sync::pull(&core, repo_id, job_id, mode).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn push(
    core: State<'_, Core>,
    repo_id: String,
    job_id: String,
    branch: Option<String>,
    remote: Option<String>,
    remote_branch: Option<String>,
    force: bool,
    expected: Option<String>,
    extra: Option<Vec<PushExtra>>,
    atomic: Option<bool>,
    accepted_secrets: Option<Vec<String>>,
) -> R<PushResult> {
    c::sync::push_with(&core, repo_id, job_id, branch, remote, remote_branch, force, expected, extra, atomic, accepted_secrets).await
}

#[tauri::command]
pub async fn job_cancel(core: State<'_, Core>, job_id: String) -> R<()> {
    c::sync::job_cancel(&core, job_id).await
}

#[tauri::command]
pub async fn push_scan_ignore(core: State<'_, Core>, repo_id: String, ids: Vec<String>) -> R<u32> {
    c::sync::push_scan_ignore(&core, repo_id, ids).await
}

#[tauri::command]
pub async fn push_scan_forget(core: State<'_, Core>, repo_id: String) -> R<RepoSettings> {
    c::sync::push_scan_forget(&core, repo_id).await
}

#[tauri::command]
pub async fn stash_list(core: State<'_, Core>, repo_id: String) -> R<Vec<Stash>> {
    c::stash::stash_list(&core, repo_id).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn stash_create(
    core: State<'_, Core>,
    repo_id: String,
    op_id: String,
    message: Option<String>,
    paths: Option<Vec<String>>,
    include_untracked: bool,
    undoable: Option<bool>,
    selection: Option<StashSelection>,
) -> R<Vec<Stash>> {
    c::stash::stash_create_with(&core, repo_id, op_id, message, paths, include_untracked, undoable, selection).await
}

#[tauri::command]
pub async fn stash_apply(core: State<'_, Core>, repo_id: String, index: u32) -> R<OpResult> {
    c::stash::stash_apply(&core, repo_id, index).await
}

#[tauri::command]
pub async fn stash_pop(core: State<'_, Core>, repo_id: String, index: u32) -> R<OpResult> {
    c::stash::stash_pop(&core, repo_id, index).await
}

#[tauri::command]
pub async fn stash_apply_paths(core: State<'_, Core>, repo_id: String, index: u32, paths: Vec<String>) -> R<Status> {
    c::stash::stash_apply_paths(&core, repo_id, index, paths).await
}

#[tauri::command]
pub async fn stash_drop(core: State<'_, Core>, repo_id: String, index: u32) -> R<Vec<Stash>> {
    c::stash::stash_drop(&core, repo_id, index).await
}

#[tauri::command]
pub async fn stash_rename(core: State<'_, Core>, repo_id: String, index: u32, message: String) -> R<Vec<Stash>> {
    c::stash::stash_rename(&core, repo_id, index, message).await
}

#[tauri::command]
pub async fn tag_create(core: State<'_, Core>, repo_id: String, name: String, sha: Option<String>, message: Option<String>) -> R<RefsSnapshot> {
    c::tags::tag_create(&core, repo_id, name, sha, message).await
}

#[tauri::command]
pub async fn tag_delete(core: State<'_, Core>, repo_id: String, name: String, remote: Option<String>) -> R<RefsSnapshot> {
    c::tags::tag_delete(&core, repo_id, name, remote).await
}

#[tauri::command]
pub async fn tag_push(core: State<'_, Core>, repo_id: String, job_id: String, name: String, remote: String, accepted_secrets: Option<Vec<String>>) -> R<PushResult> {
    c::tags::tag_push_checked(&core, repo_id, job_id, name, remote, accepted_secrets).await
}

#[tauri::command]
pub async fn undo(core: State<'_, Core>, repo_id: String) -> R<UndoState> {
    c::undo::undo(&core, repo_id).await
}

#[tauri::command]
pub async fn redo(core: State<'_, Core>, repo_id: String) -> R<UndoState> {
    c::undo::redo(&core, repo_id).await
}

#[tauri::command]
pub async fn undo_peek(core: State<'_, Core>, repo_id: String) -> R<UndoState> {
    c::undo::undo_peek(&core, repo_id).await
}

#[tauri::command]
pub async fn file_history(core: State<'_, Core>, repo_id: String, path: String, limit: u32, offset: Option<u32>) -> R<Vec<FileHistoryEntry>> {
    c::history::file_history(&core, repo_id, path, limit, offset).await
}

#[tauri::command]
pub async fn line_history(core: State<'_, Core>, repo_id: String, path: String, line: u32, sha: String) -> R<Vec<LineHistoryStep>> {
    c::history::line_history(&core, repo_id, path, line, sha).await
}

#[tauri::command]
pub async fn line_archaeology(core: State<'_, Core>, repo_id: String, path: String, line: u32, sha: Option<String>) -> R<LineArchaeology> {
    c::archaeology::line_archaeology(&core, repo_id, path, line, sha).await
}

#[tauri::command]
pub async fn ai_archaeology(
    core: State<'_, Core>,
    repo_id: String,
    job_id: String,
    path: String,
    line: u32,
    sha: Option<String>,
    locale: String,
) -> R<ArchaeologyAnswer> {
    c::archaeology::ai_archaeology(&core, repo_id, job_id, path, line, sha, locale).await
}

#[tauri::command]
pub async fn file_blame(core: State<'_, Core>, repo_id: String, path: String, sha: Option<String>, encoding: Option<String>) -> R<Vec<BlameLine>> {
    c::history::file_blame(&core, repo_id, path, sha, encoding).await
}

#[tauri::command]
pub async fn file_read(core: State<'_, Core>, repo_id: String, path: String, sha: Option<String>, encoding: Option<String>) -> R<FileContent> {
    c::history::file_read(&core, repo_id, path, sha, encoding).await
}

#[tauri::command]
pub async fn file_write(core: State<'_, Core>, repo_id: String, path: String, content: String, encoding: String, eol: LineEnding) -> R<()> {
    c::history::file_write(&core, repo_id, path, content, encoding, eol).await
}

#[tauri::command]
pub async fn profile_list(core: State<'_, Core>) -> R<Vec<Profile>> {
    c::settings::profile_list(&core).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn profile_save(
    core: State<'_, Core>,
    id: Option<String>,
    name: String,
    author_name: String,
    author_email: String,
    sync_gitconfig: bool,
    color: Option<u8>,
) -> R<Vec<Profile>> {
    c::settings::profile_save(&core, id, name, author_name, author_email, sync_gitconfig, color).await
}

#[tauri::command]
pub async fn profile_delete(core: State<'_, Core>, id: String) -> R<Vec<Profile>> {
    c::settings::profile_delete(&core, id).await
}

#[tauri::command]
pub async fn profile_activate(core: State<'_, Core>, id: String) -> R<Vec<Profile>> {
    c::settings::profile_activate(&core, id).await
}

#[tauri::command]
pub async fn settings_get(core: State<'_, Core>) -> R<Settings> {
    c::settings::settings_get(&core).await
}

#[tauri::command]
pub async fn settings_set(core: State<'_, Core>, patch: Value) -> R<Settings> {
    c::settings::settings_set(&core, patch).await
}

#[tauri::command]
pub async fn settings_scopes(core: State<'_, Core>) -> R<std::collections::BTreeMap<String, SettingScope>> {
    c::settings::settings_scopes(&core).await
}

#[tauri::command]
pub async fn avatar_get(core: State<'_, Core>, email: String) -> R<Option<String>> {
    c::avatars::avatar_get(&core, email).await
}

#[tauri::command]
pub async fn repo_settings_get(core: State<'_, Core>, repo_id: String) -> R<RepoSettings> {
    c::settings::repo_settings_get(&core, repo_id).await
}

#[tauri::command]
pub async fn repo_settings_set(core: State<'_, Core>, repo_id: String, patch: Value) -> R<RepoSettings> {
    c::settings::repo_settings_set(&core, repo_id, patch).await
}

#[tauri::command]
pub async fn link_rules_get(core: State<'_, Core>, repo_id: String) -> R<LinkRules> {
    c::links::link_rules_get(&core, repo_id).await
}

#[tauri::command]
pub async fn ssh_key_list(core: State<'_, Core>) -> R<Vec<SshKey>> {
    c::auth::ssh_key_list(&core).await
}

#[tauri::command]
pub async fn ssh_key_generate(core: State<'_, Core>, label: String, file_name: String, passphrase: Option<String>) -> R<Vec<SshKey>> {
    c::auth::ssh_key_generate(&core, label, file_name, passphrase).await
}

#[tauri::command]
pub async fn ssh_key_import(core: State<'_, Core>, label: String, private_key_path: String, public_key_path: Option<String>) -> R<Vec<SshKey>> {
    c::auth::ssh_key_import(&core, label, private_key_path, public_key_path).await
}

#[tauri::command]
pub async fn ssh_key_remove(core: State<'_, Core>, id: String) -> R<Vec<SshKey>> {
    c::auth::ssh_key_remove(&core, id).await
}

#[tauri::command]
pub async fn ssh_key_set_default(core: State<'_, Core>, id: Option<String>) -> R<Vec<SshKey>> {
    c::auth::ssh_key_set_default(&core, id).await
}

#[tauri::command]
pub async fn credential_answer(core: State<'_, Core>, request_id: String, value: Option<String>, remember: bool) -> R<()> {
    c::auth::credential_answer(&core, request_id, value, remember).await
}

#[tauri::command]
pub async fn credentials_list(core: State<'_, Core>) -> R<Vec<HostAccount>> {
    c::auth::credentials_list(&core).await
}

#[tauri::command]
pub async fn credentials_forget_all(core: State<'_, Core>) -> R<u32> {
    c::auth::credentials_forget_all(&core).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn activity_list(core: State<'_, Core>, scope: ActivityScope, repo_id: Option<String>, cursor: Option<String>, limit: u32) -> R<ActivityPage> {
    c::activity::activity_list(&core, scope, repo_id, cursor, limit).await
}

#[tauri::command]
pub async fn crash_reports_list(core: State<'_, Core>) -> R<Vec<CrashReportSummary>> {
    c::crash::crash_reports_list(&core).await
}

#[tauri::command]
pub async fn crash_report_get(core: State<'_, Core>, id: String) -> R<String> {
    c::crash::crash_report_get(&core, id).await
}

#[tauri::command]
pub async fn crash_report_save(core: State<'_, Core>, id: String, path: String) -> R<()> {
    c::crash::crash_report_save(&core, id, path).await
}

#[tauri::command]
pub async fn crash_report_discard(core: State<'_, Core>, id: String) -> R<()> {
    c::crash::crash_report_discard(&core, id).await
}

#[tauri::command]
pub async fn worktree_list(core: State<'_, Core>, repo_id: String) -> R<Vec<Worktree>> {
    c::worktree::worktree_list(&core, repo_id).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn worktree_add(core: State<'_, Core>, repo_id: String, path: String, branch: String, new_branch: bool, start: Option<String>) -> R<Vec<Worktree>> {
    c::worktree::worktree_add(&core, repo_id, path, branch, new_branch, start).await
}

#[tauri::command]
pub async fn worktree_remove(core: State<'_, Core>, repo_id: String, path: String, force: bool) -> R<Vec<Worktree>> {
    c::worktree::worktree_remove(&core, repo_id, path, force).await
}

#[tauri::command]
pub async fn worktree_lock(core: State<'_, Core>, repo_id: String, path: String, reason: Option<String>) -> R<Vec<Worktree>> {
    c::worktree::worktree_lock(&core, repo_id, path, reason).await
}

#[tauri::command]
pub async fn worktree_unlock(core: State<'_, Core>, repo_id: String, path: String) -> R<Vec<Worktree>> {
    c::worktree::worktree_unlock(&core, repo_id, path).await
}

#[tauri::command]
pub async fn worktree_prune(core: State<'_, Core>, repo_id: String) -> R<Vec<Worktree>> {
    c::worktree::worktree_prune(&core, repo_id).await
}

#[tauri::command]
pub async fn agent_templates(core: State<'_, Core>) -> R<Vec<AgentTemplateInfo>> {
    c::agents::agent_templates(&core).await
}

#[tauri::command]
pub async fn agent_suggest(core: State<'_, Core>, repo_id: String, task: String, branch: Option<String>, base: Option<String>) -> R<AgentSuggestion> {
    c::agents::agent_suggest(&core, repo_id, task, branch, base).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_start(core: State<'_, Core>, repo_id: String, template_id: String, task: String, branch: String, base: String, unattended: bool, cols: u16, rows: u16) -> R<Agent> {
    c::agents::agent_start(&core, repo_id, template_id, task, branch, base, unattended, cols, rows).await
}

#[tauri::command]
pub async fn agent_list(core: State<'_, Core>, repo_id: String) -> R<Vec<Agent>> {
    c::agents::agent_list(&core, repo_id).await
}

#[tauri::command]
pub async fn agent_stop(core: State<'_, Core>, agent_id: String) -> R<Agent> {
    c::agents::agent_stop(&core, agent_id).await
}

#[tauri::command]
pub async fn agent_resume(core: State<'_, Core>, agent_id: String, cols: u16, rows: u16) -> R<Agent> {
    c::agents::agent_resume(&core, agent_id, cols, rows).await
}

#[tauri::command]
pub async fn agent_forget(core: State<'_, Core>, agent_id: String) -> R<()> {
    c::agents::agent_forget(&core, agent_id).await
}

#[tauri::command]
pub async fn agent_cleanup_preview(core: State<'_, Core>, agent_id: String) -> R<AgentCleanupPreview> {
    c::agents::agent_cleanup_preview(&core, agent_id).await
}

#[tauri::command]
pub async fn agent_cleanup(core: State<'_, Core>, agent_id: String) -> R<UndoState> {
    c::agents::agent_cleanup(&core, agent_id).await
}

#[tauri::command]
pub async fn agent_run_tests(core: State<'_, Core>, agent_id: String, job_id: String) -> R<AgentTestResult> {
    c::agents::agent_run_tests(&core, agent_id, job_id).await
}

#[tauri::command]
pub async fn agent_review(core: State<'_, Core>, agent_id: String, source: AgentReviewSource) -> R<AgentReview> {
    c::agents::agent_review(&core, agent_id, source).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_review_commit(
    core: State<'_, Core>,
    agent_id: String,
    op_id: String,
    from: String,
    to: String,
    selections: Vec<PatchSelection>,
    summary: String,
    description: String,
    skip_hooks: bool,
) -> R<CommitResult> {
    c::agents::agent_review_commit(&core, agent_id, op_id, from, to, selections, summary, description, skip_hooks).await
}

#[tauri::command]
pub async fn agent_discard_rest(core: State<'_, Core>, agent_id: String) -> R<Status> {
    c::agents::agent_discard_rest(&core, agent_id).await
}

#[tauri::command]
pub async fn agent_collisions(core: State<'_, Core>, repo_id: String) -> R<CollisionReport> {
    c::agents::agent_collisions(&core, repo_id).await
}

#[tauri::command]
pub async fn agent_collision_check(core: State<'_, Core>, repo_id: String) -> R<CollisionReport> {
    c::agents::agent_collision_check(&core, repo_id).await
}

#[tauri::command]
pub async fn agent_collision_preview(core: State<'_, Core>, repo_id: String, collision_id: String, path: String) -> R<CollisionPreview> {
    c::agents::agent_collision_preview(&core, repo_id, collision_id, path).await
}

#[tauri::command]
pub async fn agent_inform(core: State<'_, Core>, agent_id: String, text: String) -> R<()> {
    c::agents::agent_inform(&core, agent_id, text).await
}

#[tauri::command]
pub async fn submodule_list(core: State<'_, Core>, repo_id: String) -> R<Vec<Submodule>> {
    c::submodule::submodule_list(&core, repo_id).await
}

#[tauri::command]
pub async fn submodule_add(core: State<'_, Core>, repo_id: String, job_id: String, url: String, path: String) -> R<Vec<Submodule>> {
    c::submodule::submodule_add(&core, repo_id, job_id, url, path).await
}

#[tauri::command]
pub async fn submodule_update(core: State<'_, Core>, repo_id: String, job_id: String, paths: Option<Vec<String>>, init: bool) -> R<Vec<Submodule>> {
    c::submodule::submodule_update(&core, repo_id, job_id, paths, init).await
}

#[tauri::command]
pub async fn submodule_remove(core: State<'_, Core>, repo_id: String, path: String, force: Option<bool>) -> R<Vec<Submodule>> {
    c::submodule::submodule_remove(&core, repo_id, path, force).await
}

#[tauri::command]
pub async fn submodule_move(core: State<'_, Core>, repo_id: String, path: String, new_path: String) -> R<Vec<Submodule>> {
    c::submodule::submodule_move(&core, repo_id, path, new_path).await
}

#[tauri::command]
pub async fn lfs_status(core: State<'_, Core>, repo_id: String) -> R<LfsStatus> {
    c::lfs::lfs_status(&core, repo_id).await
}

#[tauri::command]
pub async fn lfs_track(core: State<'_, Core>, repo_id: String, pattern: String) -> R<LfsStatus> {
    c::lfs::lfs_track(&core, repo_id, pattern).await
}

#[tauri::command]
pub async fn lfs_untrack(core: State<'_, Core>, repo_id: String, pattern: String) -> R<LfsStatus> {
    c::lfs::lfs_untrack(&core, repo_id, pattern).await
}

#[tauri::command]
pub async fn lfs_pull(core: State<'_, Core>, repo_id: String, job_id: String) -> R<()> {
    c::lfs::lfs_pull(&core, repo_id, job_id).await
}

#[tauri::command]
pub async fn lfs_prune(core: State<'_, Core>, repo_id: String) -> R<String> {
    c::lfs::lfs_prune(&core, repo_id).await
}

#[tauri::command]
pub async fn lfs_locks(core: State<'_, Core>, repo_id: String, filter: Option<String>, refresh: Option<bool>) -> R<LfsLockList> {
    c::lfs::lfs_locks(&core, repo_id, filter, refresh).await
}

#[tauri::command]
pub async fn lfs_lock(core: State<'_, Core>, repo_id: String, paths: Vec<String>) -> R<LfsLockOutcome> {
    c::lfs::lfs_lock(&core, repo_id, paths).await
}

#[tauri::command]
pub async fn lfs_unlock(core: State<'_, Core>, repo_id: String, paths: Vec<String>, force: bool) -> R<LfsLockOutcome> {
    c::lfs::lfs_unlock(&core, repo_id, paths, force).await
}

#[tauri::command]
pub async fn repo_cleanup_preview(core: State<'_, Core>, repo_id: String) -> R<CleanupPreview> {
    c::cleanup::repo_cleanup_preview(&core, repo_id).await
}

#[tauri::command]
pub async fn repo_cleanup_lfs_estimate(core: State<'_, Core>, repo_id: String) -> R<CleanupLfsEstimate> {
    c::cleanup::repo_cleanup_lfs_estimate(&core, repo_id).await
}

#[tauri::command]
pub async fn repo_cleanup_run(core: State<'_, Core>, repo_id: String, job_id: String, options: CleanupOptions) -> R<CleanupResult> {
    c::cleanup::repo_cleanup_run(&core, repo_id, job_id, options).await
}

#[tauri::command]
pub async fn patch_create(core: State<'_, Core>, repo_id: String, source: DiffSource, paths: Option<Vec<String>>) -> R<PatchText> {
    c::patch::patch_create(&core, repo_id, source, paths).await
}

#[tauri::command]
pub async fn patch_apply(core: State<'_, Core>, repo_id: String, text: String, check_only: bool) -> R<Status> {
    c::patch::patch_apply(&core, repo_id, text, check_only).await
}

#[tauri::command]
pub async fn signing_status(core: State<'_, Core>, repo_id: Option<String>) -> R<SigningStatus> {
    c::signing::signing_status(&core, repo_id).await
}

// `program` and `allowedSignersFile` distinguish “missing” (leave untouched) from `null` (remove
// the entry); so the raw input object is read here.
// gc:params repoId,enabled,format,key,program,allowedSignersFile
#[tauri::command]
pub async fn signing_set(core: State<'_, Core>, request: tauri::ipc::Request<'_>) -> R<SigningStatus> {
    let tauri::ipc::InvokeBody::Json(body) = request.body() else {
        return Err(CoreError::not_allowed("signing_set expects a JSON object."));
    };
    let repo_id = tri_state::<String>(body, "repoId")?.flatten();
    let enabled = tri_state::<bool>(body, "enabled")?.flatten();
    let format = tri_state::<SigningFormat>(body, "format")?.flatten();
    let key = tri_state::<String>(body, "key")?.flatten();
    let program = tri_state::<String>(body, "program")?;
    let allowed_signers_file = tri_state::<String>(body, "allowedSignersFile")?;
    c::signing::signing_set(&core, repo_id, enabled, format, key, program, allowed_signers_file).await
}

#[tauri::command]
pub async fn terminal_open(core: State<'_, Core>, repo_id: String, cols: u16, rows: u16) -> R<String> {
    c::terminal::terminal_open(&core, repo_id, cols, rows).await
}

#[tauri::command]
pub async fn terminal_write(core: State<'_, Core>, terminal_id: String, data: String) -> R<()> {
    c::terminal::terminal_write(&core, terminal_id, data).await
}

#[tauri::command]
pub async fn terminal_resize(core: State<'_, Core>, terminal_id: String, cols: u16, rows: u16) -> R<()> {
    c::terminal::terminal_resize(&core, terminal_id, cols, rows).await
}

#[tauri::command]
pub async fn terminal_close(core: State<'_, Core>, terminal_id: String) -> R<()> {
    c::terminal::terminal_close(&core, terminal_id).await
}

#[tauri::command]
pub async fn open_external(core: State<'_, Core>, repo_id: String, target: ExternalTarget, path: Option<String>, source: Option<DiffSource>) -> R<()> {
    c::external::open_external(&core, repo_id, target, path, source).await
}

// --- Custom commands ---------------------------------------------------------------------------

#[tauri::command]
pub async fn custom_commands_list(core: State<'_, Core>, repo_id: Option<String>) -> R<CustomCommandList> {
    c::custom::custom_commands_list(&core, repo_id).await
}

#[tauri::command]
pub async fn custom_commands_save(core: State<'_, Core>, commands: Vec<CustomCommandDef>) -> R<Vec<CustomCommandDef>> {
    c::custom::custom_commands_save(&core, commands).await
}

#[tauri::command]
pub async fn custom_commands_trust(core: State<'_, Core>, repo_id: String, hash: Option<String>) -> R<CustomCommandList> {
    c::custom::custom_commands_trust(&core, repo_id, hash).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn custom_command_run(
    core: State<'_, Core>,
    repo_id: String,
    id: String,
    context: CustomCommandContext,
    inputs: std::collections::BTreeMap<String, String>,
    job_id: String,
    confirmed: bool,
) -> R<CustomCommandResult> {
    c::custom::custom_command_run(&core, repo_id, id, context, inputs, job_id, confirmed).await
}

#[tauri::command]
pub async fn custom_commands_import(core: State<'_, Core>, path: String) -> R<Vec<CustomCommandDef>> {
    c::custom::custom_commands_import(&core, path).await
}

#[tauri::command]
pub async fn custom_commands_export(core: State<'_, Core>, path: String) -> R<()> {
    c::custom::custom_commands_export(&core, path).await
}

// --- Command line ------------------------------------------------------------------------------

#[tauri::command]
pub async fn cli_status(core: State<'_, Core>) -> R<CliStatus> {
    c::cli::cli_status(&core).await
}

#[tauri::command]
pub async fn cli_install(core: State<'_, Core>) -> R<CliStatus> {
    c::cli::cli_install(&core).await
}

// --- Hosts: accounts, pull requests, issues ---------------------------------------------

#[tauri::command]
pub async fn host_accounts(core: State<'_, Core>) -> R<Vec<HosterAccount>> {
    c::host::host_accounts(&core).await
}

#[tauri::command]
pub async fn host_connect(core: State<'_, Core>, kind: HostKind, base_url: Option<String>, token: String, username: Option<String>) -> R<HosterAccount> {
    c::host::host_connect(&core, kind, base_url, token, username).await
}

#[tauri::command]
pub async fn host_connect_gh(core: State<'_, Core>, base_url: Option<String>) -> R<HosterAccount> {
    c::host::host_connect_gh(&core, base_url).await
}

#[tauri::command]
pub async fn host_disconnect(core: State<'_, Core>, account_id: String) -> R<Vec<HosterAccount>> {
    c::host::host_disconnect(&core, account_id).await
}

#[tauri::command]
pub async fn host_check(core: State<'_, Core>, account_id: String) -> R<HosterAccount> {
    c::host::host_check(&core, account_id).await
}

#[tauri::command]
pub async fn host_repo_info(core: State<'_, Core>, repo_id: String, remote: Option<String>) -> R<Option<HostRepoInfo>> {
    c::host::host_repo_info(&core, repo_id, remote).await
}

#[tauri::command]
pub async fn pr_list(core: State<'_, Core>, repo_id: String, state: PrListState, page: Option<u32>, per_page: Option<u32>, remote: Option<String>) -> R<PrPage> {
    c::host::pr_list(&core, repo_id, state, page, per_page, remote).await
}

#[tauri::command]
pub async fn pr_get(core: State<'_, Core>, repo_id: String, number: u64, remote: Option<String>) -> R<PrDetails> {
    c::host::pr_get(&core, repo_id, number, remote).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pr_create(
    core: State<'_, Core>,
    repo_id: String,
    title: String,
    body: String,
    source_branch: String,
    target_branch: String,
    draft: bool,
    reviewers: Option<Vec<String>>,
    labels: Option<Vec<String>>,
    remote: Option<String>,
) -> R<PrSummary> {
    c::host::pr_create(&core, repo_id, title, body, source_branch, target_branch, draft, reviewers, labels, remote).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pr_update(
    core: State<'_, Core>,
    repo_id: String,
    number: u64,
    title: Option<String>,
    body: Option<String>,
    target_branch: Option<String>,
    draft: Option<bool>,
    reviewers: Option<Vec<String>>,
    labels: Option<Vec<String>>,
    remote: Option<String>,
) -> R<PrSummary> {
    c::host::pr_update(&core, repo_id, number, title, body, target_branch, draft, reviewers, labels, remote).await
}

#[tauri::command]
pub async fn pr_comment(core: State<'_, Core>, repo_id: String, number: u64, body: String, remote: Option<String>) -> R<HostComment> {
    c::host::pr_comment(&core, repo_id, number, body, remote).await
}

#[tauri::command]
pub async fn pr_merge(core: State<'_, Core>, repo_id: String, number: u64, method: PrMergeMethod, delete_branch: bool, remote: Option<String>) -> R<PrSummary> {
    c::host::pr_merge(&core, repo_id, number, method, delete_branch, remote).await
}

#[tauri::command]
pub async fn pr_close(core: State<'_, Core>, repo_id: String, number: u64, remote: Option<String>) -> R<PrSummary> {
    c::host::pr_close(&core, repo_id, number, remote).await
}

#[tauri::command]
pub async fn pr_reopen(core: State<'_, Core>, repo_id: String, number: u64, remote: Option<String>) -> R<PrSummary> {
    c::host::pr_reopen(&core, repo_id, number, remote).await
}

#[tauri::command]
pub async fn pr_checkout(core: State<'_, Core>, repo_id: String, number: u64, remote: Option<String>) -> R<Status> {
    c::host::pr_checkout(&core, repo_id, number, remote).await
}

#[tauri::command]
pub async fn pr_template(core: State<'_, Core>, repo_id: String) -> R<Option<String>> {
    c::host::pr_template(&core, repo_id).await
}

#[tauri::command]
pub async fn pr_review_threads(core: State<'_, Core>, repo_id: String, number: u64, remote: Option<String>) -> R<Vec<ReviewThread>> {
    c::host::pr_review_threads(&core, repo_id, number, remote).await
}

#[tauri::command]
pub async fn pr_review_reply(core: State<'_, Core>, repo_id: String, number: u64, thread_id: String, body: String, remote: Option<String>) -> R<ReviewReply> {
    c::host::pr_review_reply(&core, repo_id, number, thread_id, body, remote).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn issue_list(
    core: State<'_, Core>,
    repo_id: String,
    state: IssueListState,
    query: Option<String>,
    page: Option<u32>,
    per_page: Option<u32>,
    remote: Option<String>,
) -> R<IssuePage> {
    c::host::issue_list(&core, repo_id, state, query, page, per_page, remote).await
}

#[tauri::command]
pub async fn issue_get(core: State<'_, Core>, repo_id: String, number: u64, remote: Option<String>) -> R<IssueDetails> {
    c::host::issue_get(&core, repo_id, number, remote).await
}

#[tauri::command]
pub async fn issue_create(core: State<'_, Core>, repo_id: String, title: String, body: String, remote: Option<String>) -> R<IssueSummary> {
    c::host::issue_create(&core, repo_id, title, body, remote).await
}

#[tauri::command]
pub async fn release_create(core: State<'_, Core>, repo_id: String, tag: String, name: String, body: String, prerelease: bool, remote: Option<String>) -> R<HostRelease> {
    c::host::release_create(&core, repo_id, tag, name, body, prerelease, remote).await
}

#[tauri::command]
pub async fn stats_compute(core: State<'_, Core>, repo_id: String, job_id: String, range: StatsRange) -> R<RepoStats> {
    c::stats::stats_compute(&core, repo_id, job_id, range).await
}

// --- AI (v1.2) ------------------------------------------------------------------

#[tauri::command]
pub async fn ai_status(core: State<'_, Core>) -> R<AiStatus> {
    c::ai::ai_status(&core).await
}

#[tauri::command]
pub async fn ai_key_set(core: State<'_, Core>, provider: AiProviderKind, key: String) -> R<AiStatus> {
    c::ai::ai_key_set(&core, provider, key).await
}

#[tauri::command]
pub async fn ai_key_remove(core: State<'_, Core>, provider: AiProviderKind) -> R<AiStatus> {
    c::ai::ai_key_remove(&core, provider).await
}

#[tauri::command]
pub async fn ai_models(
    core: State<'_, Core>,
    job_id: String,
    provider: AiProviderKind,
    base_url: Option<String>,
    key: Option<String>,
    model: Option<String>,
) -> R<AiModelList> {
    c::ai::ai_models(&core, job_id, provider, base_url, key, model).await
}

#[tauri::command]
pub async fn ai_intro_dismiss(core: State<'_, Core>) -> R<AiStatus> {
    c::ai::ai_intro_dismiss(&core).await
}

#[tauri::command]
pub async fn ai_preview(core: State<'_, Core>, repo_id: String, feature: AiFeature, input: AiInput, locale: String) -> R<AiPreview> {
    c::ai::ai_preview(&core, repo_id, feature, input, locale).await
}

#[tauri::command]
pub async fn ai_preview_confirm(
    core: State<'_, Core>,
    repo_id: Option<String>,
    feature: AiFeature,
    fingerprint: String,
    triggers: Vec<AiAskTrigger>,
    dont_ask_again: bool,
) -> R<()> {
    c::ai::ai_preview_confirm(&core, repo_id, feature, fingerprint, triggers, dont_ask_again).await
}

#[tauri::command]
pub async fn ai_preview_reset(core: State<'_, Core>) -> R<()> {
    c::ai::ai_preview_reset(&core).await
}

#[tauri::command]
pub async fn ai_push_review(
    core: State<'_, Core>,
    repo_id: String,
    job_id: String,
    branch: Option<String>,
    remote: Option<String>,
    remote_branch: Option<String>,
    locale: String,
) -> R<AiPushReview> {
    c::ai::ai_push_review(&core, repo_id, job_id, branch, remote, remote_branch, locale).await
}

#[tauri::command]
pub async fn ai_usage(core: State<'_, Core>) -> R<AiUsageSummary> {
    c::ai::ai_usage(&core).await
}

#[tauri::command]
pub async fn release_notes_range(core: State<'_, Core>, repo_id: String, from: Option<String>, to: Option<String>) -> R<ReleaseNotesRange> {
    c::release_notes::release_notes_range(&core, repo_id, from, to).await
}

#[tauri::command]
pub async fn ai_release_notes(core: State<'_, Core>, repo_id: String, job_id: String, from: Option<String>, to: Option<String>, locale: String) -> R<ReleaseNotes> {
    c::release_notes::ai_release_notes(&core, repo_id, job_id, from, to, locale).await
}

#[tauri::command]
pub async fn changelog_insert(core: State<'_, Core>, repo_id: String, version: String, date: String, notes: String) -> R<ChangelogInsertResult> {
    c::release_notes::changelog_insert(&core, repo_id, version, date, notes).await
}

#[tauri::command]
pub async fn ai_commit_message(core: State<'_, Core>, repo_id: String, job_id: String, locale: String) -> R<AiCommitMessage> {
    c::ai::ai_commit_message(&core, repo_id, job_id, locale).await
}

#[tauri::command]
pub async fn ai_detect(core: State<'_, Core>) -> R<AiDetection> {
    c::ai::ai_detect(&core).await
}

#[tauri::command]
pub async fn ai_cli_login(core: State<'_, Core>, repo_id: String, provider: AiProviderKind, cols: u16, rows: u16) -> R<String> {
    c::ai::ai_cli_login(&core, repo_id, provider, cols, rows).await
}

#[tauri::command]
pub async fn ai_pr_description(core: State<'_, Core>, repo_id: String, job_id: String, source: String, target: String, locale: String) -> R<AiPrDescription> {
    c::ai::ai_pr_description(&core, repo_id, job_id, source, target, locale).await
}

#[tauri::command]
pub async fn ai_plan(core: State<'_, Core>, repo_id: String, job_id: String, text: String, locale: String) -> R<PlanPreview> {
    c::plan::ai_plan(&core, repo_id, job_id, text, locale).await
}

#[tauri::command]
pub async fn ai_plan_check(core: State<'_, Core>, repo_id: String, job_id: String, steps: Vec<PlanStep>) -> R<PlanPreview> {
    c::plan::ai_plan_check(&core, repo_id, job_id, steps).await
}

#[tauri::command]
pub async fn ai_plan_run(
    core: State<'_, Core>,
    repo_id: String,
    job_id: String,
    text: String,
    steps: Vec<PlanStep>,
    expect: String,
    confirmed: Vec<u32>,
) -> R<PlanRunResult> {
    c::plan::ai_plan_run(&core, repo_id, job_id, text, steps, expect, confirmed).await
}

#[tauri::command]
pub async fn ai_conflict_intent(
    core: State<'_, Core>,
    repo_id: String,
    job_id: String,
    path: String,
    blocks: Vec<ConflictBlockRange>,
    locale: String,
) -> R<ConflictIntent> {
    c::ai::ai_conflict_intent(&core, repo_id, job_id, path, blocks, locale).await
}

#[tauri::command]
pub async fn stack_plan(core: State<'_, Core>, repo_id: String, branch: String, base: String, cuts: Vec<StackCut>) -> R<StackPlan> {
    c::stack::stack_plan(&core, repo_id, branch, base, cuts).await
}

#[tauri::command]
pub async fn stack_create(core: State<'_, Core>, repo_id: String, branch: String, base: String, cuts: Vec<StackCut>, expected_base: String, expected_tip: String) -> R<StackStatus> {
    c::stack::stack_create(&core, repo_id, branch, base, cuts, expected_base, expected_tip).await
}

#[tauri::command]
pub async fn stack_status(core: State<'_, Core>, repo_id: String, branch: String) -> R<Option<StackStatus>> {
    c::stack::stack_status(&core, repo_id, branch).await
}

#[tauri::command]
pub async fn stack_restack(core: State<'_, Core>, repo_id: String, branch: String, expected_top: String) -> R<OpResult> {
    c::stack::stack_restack(&core, repo_id, branch, expected_top).await
}

#[tauri::command]
pub async fn stack_push(
    core: State<'_, Core>,
    repo_id: String,
    job_id: String,
    branches: Vec<String>,
    remote: String,
    force: bool,
    accepted_secrets: Option<Vec<String>>,
) -> R<PushResult> {
    c::stack::stack_push(&core, repo_id, job_id, branches, remote, force, accepted_secrets).await
}

#[tauri::command]
pub async fn stack_prs_create(core: State<'_, Core>, repo_id: String, target: String, parts: Vec<StackPrPart>, from: u32, remote: Option<String>) -> R<StackPrOutcome> {
    c::stack::stack_prs_create(&core, repo_id, target, parts, from, remote).await
}

#[tauri::command]
pub async fn stack_check(core: State<'_, Core>, repo_id: String, job_id: String, branch: String, base: String, cuts: Vec<StackCut>) -> R<Vec<StackCheckResult>> {
    c::stack::stack_check(&core, repo_id, job_id, branch, base, cuts).await
}

#[tauri::command]
pub async fn ai_stack_split(core: State<'_, Core>, repo_id: String, job_id: String, branch: String, base: String, locale: String) -> R<AiStackSplit> {
    c::ai::ai_stack_split(&core, repo_id, job_id, branch, base, locale).await
}

#[tauri::command]
pub async fn ai_review_fix(core: State<'_, Core>, repo_id: String, job_id: String, number: u64, thread_id: String, locale: String) -> R<AiReviewFix> {
    c::ai::ai_review_fix(&core, repo_id, job_id, number, thread_id, locale).await
}

#[tauri::command]
pub async fn review_fix_apply(core: State<'_, Core>, repo_id: String, number: u64, fix: ReviewFixInput, target: String) -> R<ReviewFixApplied> {
    c::review_fix::review_fix_apply(&core, repo_id, number, fix, target).await
}

// --- Search by meaning (v1.2) ---------------------------------------------------

#[tauri::command]
pub async fn ai_semantic_status(core: State<'_, Core>, repo_id: String) -> R<AiSemanticStatus> {
    c::ai_search::ai_semantic_status(&core, repo_id).await
}

#[tauri::command]
pub async fn ai_semantic_search(core: State<'_, Core>, repo_id: String, job_id: String, query: String, locale: String) -> R<AiSemanticResult> {
    c::ai_search::ai_semantic_search(&core, repo_id, job_id, query, locale).await
}

#[tauri::command]
pub async fn ai_semantic_index_update(core: State<'_, Core>, repo_id: String, job_id: String) -> R<AiSemanticIndexUpdate> {
    c::ai_search::ai_semantic_index_update(&core, repo_id, job_id).await
}

#[tauri::command]
pub async fn ai_semantic_index_delete(core: State<'_, Core>) -> R<u64> {
    c::ai_search::ai_semantic_index_delete(&core).await
}
