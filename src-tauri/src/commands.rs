//! Tauri bindings: exactly one command per method of src/core/api.ts, which only
//! delegates to `gitcore::commands`. Parameters = keys of the input object (Tauri
//! maps `repoId` to `repo_id`). Plain delegations are lines of the `commands!` table;
//! the few with special bodies are hand-written below it and named in `hand_written:`.
//! `handler()` registers both (lib.rs). `node scripts/check-commands.mjs` checks this
//! file against api.ts.

use gitcore::commands as c;
use gitcore::model::*;
use gitcore::windowing::scoped;
use gitcore::{Core, CoreError};
use serde::de::DeserializeOwned;
use serde_json::Value;
use tauri::State;

#[allow(clippy::wildcard_imports)] // brings the `__cmd__` macros of the hand-written updater commands along
use crate::updater::*;

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

/// Emits one `#[tauri::command]` wrapper per table line
/// `name => area::core_fn(param: Type, ...) -> Ret;` that passes `State<Core>` and the parameters
/// on to `gitcore::commands::area::core_fn`, run in the calling window's scope
/// (`gitcore::windowing::scoped`), plus `handler()`: `generate_handler!` for the table
/// and the `hand_written` commands (defined below the table).
macro_rules! commands {
    (
        hand_written: $($hand:ident),* ;
        $($name:ident => $area:ident :: $func:ident ( $($arg:ident : $ty:ty),* ) -> $ret:ty ;)*
    ) => {
        $(
            #[tauri::command]
            #[allow(clippy::too_many_arguments)]
            pub async fn $name(core: State<'_, Core>, caller: tauri::WebviewWindow, $($arg: $ty),*) -> R<$ret> {
                scoped(caller.label().to_string(), c::$area::$func(&core, $($arg),*)).await
            }
        )*

        /// The invoke handler for every command in this file.
        pub fn handler() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
            tauri::generate_handler![$($name,)* $($hand),*]
        }
    };
}

commands! {
    hand_written: app_quit, repo_open, repo_update, signing_set, update_download, update_install, window_close, window_layout;

    app_info => app::app_info() -> AppInfo;
    app_keyring_available => app::app_keyring_available() -> bool;
    app_recheck_git => app::app_recheck_git() -> AppInfo;
    update_check => update::update_check(manual: bool) -> UpdateInfo;
    update_dismiss => update::update_dismiss(version: String, skip: bool) -> UpdateInfo;
    update_whats_new => update::update_whats_new() -> Option<String>;
    app_startup_report => app::app_startup_report(report: StartupReport) -> ();
    app_close_guard => app::app_close_guard(active: bool) -> ();
    app_losses_elsewhere => app::app_losses_elsewhere() -> u32;
    app_launch_request => launch::app_launch_request() -> Option<LaunchRequest>;
    repo_trust_get => trust::repo_trust_get(repo_id: String) -> RepoTrust;
    repo_trust_set => trust::repo_trust_set(repo_id: String, trusted: bool) -> RepoTrust;
    repo_list => repos::repo_list() -> Vec<Repo>;
    repo_profiles => repos::repo_profiles(path: String) -> Vec<ProfileRef>;
    repo_forget => repos::repo_forget(repo_id: String) -> ();
    repo_clone => clone_init::repo_clone(job_id: String, url: String, parent_path: String, name: String, options: CloneOptions) -> OpenedRepo;
    repo_init => clone_init::repo_init(options: InitOptions) -> OpenedRepo;
    init_templates => clone_init::init_templates() -> InitTemplates;
    repo_readme => repos::repo_readme(repo_id: String) -> Option<String>;
    tabs_list => repos::tabs_list() -> Vec<Tab>;
    tab_open => repos::tab_open(repo_id: Option<String>) -> Vec<Tab>;
    tab_close => repos::tab_close(tab_id: String) -> Vec<Tab>;
    tab_move => repos::tab_move(tab_id: String, position: i64) -> Vec<Tab>;
    tab_activate => repos::tab_activate(tab_id: String) -> Vec<Tab>;
    window_list => window::window_list() -> Vec<WindowInfo>;
    window_new => window::window_new() -> String;
    window_strip_report => window::window_strip_report(strip: Option<StripReport>) -> ();
    tab_move_to_window => window::tab_move_to_window(tab_id: String, window: String, position: i64) -> Vec<Tab>;
    tab_move_to_new_window => window::tab_move_to_new_window(tab_id: String, at: Option<ScreenPoint>) -> String;
    tab_handoff_put => window::tab_handoff_put(tab_id: String, handoff: String, terminal_ids: Vec<String>) -> ();
    tab_handoff_take => window::tab_handoff_take(tab_id: String) -> Option<String>;
    graph_page => graph::graph_page(repo_id: String, cursor: Option<String>, limit: u32) -> GraphPage;
    refs_list => refs::refs_list(repo_id: String) -> RefsSnapshot;
    commit_details => graph::commit_details(repo_id: String, source: DiffSource) -> CommitDetails;
    commit_search => graph::commit_search(repo_id: String, query: String, limit: u32, search_id: Option<String>, filters: Option<CommitSearchFilters>) -> Vec<CommitSummary>;
    tree_list => graph::tree_list(repo_id: String, sha: Option<String>, filter: Option<String>) -> Vec<String>;
    view_state_get => view::view_state_get(repo_id: String) -> RepoViewState;
    view_state_set => view::view_state_set(repo_id: String, patch: Value) -> RepoViewState;
    reflog_list => reflog::reflog_list(repo_id: String, ref_name: Option<String>, cursor: Option<String>, limit: u32) -> ReflogPage;
    status_get => status::status_get(repo_id: String) -> Status;
    diff_file => diff::diff_file(repo_id: String, path: String, source: DiffSource, force: Option<bool>, ignore_whitespace: Option<bool>, encoding: Option<String>) -> FileDiff;
    stage_paths => stage::stage_paths(repo_id: String, paths: Option<Vec<String>>) -> Status;
    unstage_paths => stage::unstage_paths(repo_id: String, paths: Option<Vec<String>>) -> Status;
    stage_patch => stage::stage_patch(repo_id: String, selection: PatchSelection) -> Status;
    unstage_patch => stage::unstage_patch(repo_id: String, selection: PatchSelection) -> Status;
    discard_patch => stage::discard_patch(repo_id: String, selection: PatchSelection) -> Status;
    range_apply => patch::range_apply(repo_id: String, from: String, to: String, selections: Vec<PatchSelection>, target: RangeApplyTarget) -> Status;
    discard_paths => stage::discard_paths(repo_id: String, paths: Option<Vec<String>>) -> Status;
    commit_create => commit::commit_create(repo_id: String, op_id: String, summary: String, description: String, amend: bool, skip_hooks: bool, push_after: bool, stage_all: bool, expected_head: Option<String>) -> CommitResult;
    commit_selection => commit::commit_selection(repo_id: String, op_id: String, selections: Vec<PatchSelection>, summary: String, description: String, skip_hooks: bool, expect_head: String) -> CommitResult;
    selection_to_branch => commit::selection_to_branch(repo_id: String, op_id: String, selections: Vec<PatchSelection>, branch: String, summary: String, description: String, skip_hooks: bool, expect_head: String) -> CommitResult;
    commit_reword => commit::commit_reword(repo_id: String, summary: String, description: String, sha: Option<String>) -> CommitResult;
    compose_units => compose::compose_units(repo_id: String) -> ComposeState;
    compose_proposal => compose::compose_proposal(repo_id: String, job_id: String, locale: String, instruction: Option<String>, keep: Vec<ComposeKeep>) -> ComposeProposal;
    compose_apply => compose::compose_apply(repo_id: String, job_id: String, plan: ComposePlan, expect_token: String) -> ComposeResult;
    draft_get => view::draft_get(repo_id: String) -> CommitDraft;
    draft_set => view::draft_set(repo_id: String, draft: CommitDraft) -> ();
    ignore_add => stage::ignore_add(repo_id: String, pattern: String, stop_tracking: bool) -> Status;
    file_restore => stage::file_restore(repo_id: String, sha: String, paths: Vec<String>) -> Status;
    file_delete => stage::file_delete(repo_id: String, path: String) -> Status;
    branch_create => branches::branch_create(repo_id: String, name: String, start: Option<String>, checkout: bool) -> RefsSnapshot;
    branch_checkout => branches::branch_checkout(repo_id: String, target: String) -> Status;
    branch_rename => branches::branch_rename(repo_id: String, name: String, new_name: String) -> RefsSnapshot;
    branch_delete => branches::branch_delete(repo_id: String, names: Vec<String>, force: bool) -> RefsSnapshot;
    branch_cleanup_candidates => branch_cleanup::branch_cleanup_candidates(repo_id: String) -> BranchCleanupList;
    branch_cleanup_delete => branch_cleanup::branch_cleanup_delete(repo_id: String, targets: Vec<BranchCleanupTarget>) -> RefsSnapshot;
    digest_get => digest::digest_get(repo_id: String, min_age_hours: Option<u32>) -> Option<Digest>;
    digest_mark_seen => digest::digest_mark_seen(repo_id: String, mark: DigestMark) -> ();
    branch_delete_remote => sync::branch_delete_remote(repo_id: String, job_id: String, remote: String, name: String, expected: Option<String>) -> PushResult;
    branch_set_upstream => branches::branch_set_upstream(repo_id: String, name: String, upstream: Option<String>) -> RefsSnapshot;
    branch_fast_forward => branches::branch_fast_forward(repo_id: String, branch: String) -> OpResult;
    gitflow_status => gitflow::gitflow_status(repo_id: String) -> GitflowStatus;
    gitflow_init => gitflow::gitflow_init(repo_id: String, main: String, develop: String, prefixes: Option<GitflowPrefixes>) -> GitflowStatus;
    gitflow_start => gitflow::gitflow_start(repo_id: String, kind: GitflowKind, name: String, base: Option<String>) -> GitflowStatus;
    gitflow_finish => gitflow::gitflow_finish(repo_id: String, kind: GitflowKind, name: String, options: Option<GitflowFinishOptions>, job_id: Option<String>) -> OpResult;
    ref_name_check => branches::ref_name_check(repo_id: String, name: String, kind: RefNameKind) -> RefNameCheck;
    merge_start => merge::merge_start(repo_id: String, source: String, mode: MergeMode) -> OpResult;
    conflict_get => merge::conflict_get(repo_id: String, path: String) -> ConflictFile;
    conflict_resolve => merge::conflict_resolve(repo_id: String, path: String, content: Option<String>, side: Option<ConflictSide>) -> Status;
    operation_continue => merge::operation_continue(repo_id: String, message: Option<String>, skip_hooks: Option<bool>) -> OpResult;
    operation_abort => merge::operation_abort(repo_id: String) -> Status;
    rebase_start => rebase::rebase_start_with(repo_id: String, onto: String, branch: Option<String>, update_refs: Option<bool>) -> OpResult;
    rebase_plan => rebase::rebase_plan_with(repo_id: String, base: String, autosquash: Option<bool>) -> RebasePlan;
    rebase_branch_plan => rebase::rebase_branch_plan(repo_id: String, from: Option<String>) -> RebasePlan;
    rebase_dependents => rebase::rebase_dependents(repo_id: String, onto: String, branch: Option<String>) -> Vec<String>;
    rebase_apply => rebase::rebase_apply_with(repo_id: String, base: String, rows: Vec<RebasePlanRow>, update_refs: Option<bool>) -> OpResult;
    cherry_pick => rebase::cherry_pick(repo_id: String, shas: Vec<String>) -> OpResult;
    squash_commits => rebase::squash_commits(repo_id: String, shas: Vec<String>, message: String) -> OpResult;
    revert_commit => rebase::revert_commit(repo_id: String, sha: String) -> OpResult;
    conflict_preview => preview::conflict_preview(repo_id: String, job_id: String, op: PreviewOp) -> ConflictPreview;
    reset_branch => merge::reset_branch(repo_id: String, sha: String, mode: ResetMode) -> Status;
    bisect_status => bisect::bisect_status(repo_id: String) -> BisectStatus;
    bisect_start => bisect::bisect_start(repo_id: String, bad: String, good: Vec<String>) -> BisectStatus;
    bisect_mark => bisect::bisect_mark(repo_id: String, verdict: BisectVerdict, sha: Option<String>) -> BisectStatus;
    bisect_reset => bisect::bisect_reset(repo_id: String) -> BisectStatus;
    bisect_autopilot_script => bisect::bisect_autopilot_script(repo_id: String, job_id: String, request: BisectScriptRequest, locale: String) -> BisectScript;
    bisect_autopilot_run => bisect::bisect_autopilot_run(repo_id: String, job_id: String, bad: String, good: Vec<String>, script: String, step_timeout_secs: u64) -> BisectAutopilot;
    bisect_autopilot_status => bisect::bisect_autopilot_status(repo_id: String) -> Option<BisectAutopilot>;
    bisect_autopilot_close => bisect::bisect_autopilot_close(repo_id: String, keep_worktree: bool) -> Option<String>;
    remote_list => remotes::remote_list(repo_id: String) -> Vec<Remote>;
    remote_add => remotes::remote_add(repo_id: String, name: String, fetch_url: String, push_url: Option<String>) -> Vec<Remote>;
    remote_edit => remotes::remote_edit(repo_id: String, name: String, new_name: String, fetch_url: String, push_url: Option<String>) -> Vec<Remote>;
    remote_remove => remotes::remote_remove(repo_id: String, name: String) -> Vec<Remote>;
    fetch => sync::fetch(repo_id: String, job_id: String, remote: Option<String>, prune: bool) -> FetchResult;
    pull => sync::pull(repo_id: String, job_id: String, mode: Option<PullMode>) -> OpResult;
    push => sync::push_with(repo_id: String, job_id: String, branch: Option<String>, remote: Option<String>, remote_branch: Option<String>, force: bool, expected: Option<String>, extra: Option<Vec<PushExtra>>, atomic: Option<bool>, accepted_secrets: Option<Vec<String>>) -> PushResult;
    job_cancel => sync::job_cancel(job_id: String) -> ();
    push_scan_ignore => sync::push_scan_ignore(repo_id: String, ids: Vec<String>) -> u32;
    push_scan_forget => sync::push_scan_forget(repo_id: String) -> RepoSettings;
    stash_list => stash::stash_list(repo_id: String) -> Vec<Stash>;
    stash_create => stash::stash_create_with(repo_id: String, op_id: String, message: Option<String>, paths: Option<Vec<String>>, include_untracked: bool, undoable: Option<bool>, selection: Option<StashSelection>) -> Vec<Stash>;
    stash_apply => stash::stash_apply(repo_id: String, index: u32, expected_sha: Option<String>) -> OpResult;
    stash_pop => stash::stash_pop(repo_id: String, index: u32, expected_sha: Option<String>) -> OpResult;
    stash_apply_paths => stash::stash_apply_paths(repo_id: String, index: u32, expected_sha: Option<String>, paths: Vec<String>) -> Status;
    stash_drop => stash::stash_drop(repo_id: String, index: u32, expected_sha: Option<String>) -> Vec<Stash>;
    stash_rename => stash::stash_rename(repo_id: String, index: u32, message: String) -> Vec<Stash>;
    tag_create => tags::tag_create(repo_id: String, name: String, sha: Option<String>, message: Option<String>) -> RefsSnapshot;
    tag_delete => tags::tag_delete(repo_id: String, name: String, remote: Option<String>) -> RefsSnapshot;
    tag_push => tags::tag_push_checked(repo_id: String, job_id: String, name: String, remote: String, accepted_secrets: Option<Vec<String>>) -> PushResult;
    undo => undo::undo(repo_id: String) -> UndoState;
    redo => undo::redo(repo_id: String) -> UndoState;
    undo_peek => undo::undo_peek(repo_id: String) -> UndoState;
    file_history => history::file_history(repo_id: String, path: String, limit: u32, offset: Option<u32>) -> Vec<FileHistoryEntry>;
    line_history => history::line_history(repo_id: String, path: String, line: u32, sha: String) -> Vec<LineHistoryStep>;
    line_archaeology => archaeology::line_archaeology(repo_id: String, path: String, line: u32, sha: Option<String>) -> LineArchaeology;
    ai_archaeology => archaeology::ai_archaeology(repo_id: String, job_id: String, path: String, line: u32, sha: Option<String>, locale: String) -> ArchaeologyAnswer;
    file_blame => history::file_blame(repo_id: String, path: String, sha: Option<String>, encoding: Option<String>) -> Vec<BlameLine>;
    file_blame_job => history::file_blame_job(repo_id: String, job_id: String, path: String, sha: Option<String>, encoding: Option<String>) -> Vec<BlameLine>;
    file_read => history::file_read(repo_id: String, path: String, sha: Option<String>, encoding: Option<String>) -> FileContent;
    file_write => history::file_write(repo_id: String, path: String, content: String, encoding: String, eol: LineEnding) -> ();
    profile_list => profiles::profile_list() -> Vec<Profile>;
    profile_save => profiles::profile_save(id: Option<String>, name: String, author_name: String, author_email: String, sync_gitconfig: bool, color: Option<u8>) -> Vec<Profile>;
    profile_delete => profiles::profile_delete(id: String) -> Vec<Profile>;
    profile_activate => profiles::profile_activate(id: String) -> Vec<Profile>;
    settings_get => settings::settings_get() -> Settings;
    settings_set => settings::settings_set(patch: Value) -> Settings;
    avatar_get => avatars::avatar_get(email: String) -> Option<String>;
    repo_settings_get => settings::repo_settings_get(repo_id: String) -> RepoSettings;
    repo_settings_set => settings::repo_settings_set(repo_id: String, patch: Value) -> RepoSettings;
    link_rules_get => links::link_rules_get(repo_id: String) -> LinkRules;
    ssh_key_list => auth::ssh_key_list() -> Vec<SshKey>;
    ssh_key_generate => auth::ssh_key_generate(label: String, file_name: String, passphrase: Option<String>) -> Vec<SshKey>;
    ssh_key_import => auth::ssh_key_import(label: String, private_key_path: String, public_key_path: Option<String>) -> Vec<SshKey>;
    ssh_key_remove => auth::ssh_key_remove(id: String) -> Vec<SshKey>;
    ssh_key_set_default => auth::ssh_key_set_default(id: Option<String>) -> Vec<SshKey>;
    credential_answer => auth::credential_answer(request_id: String, value: Option<String>, remember: bool) -> ();
    credentials_list => auth::credentials_list() -> Vec<HostAccount>;
    credentials_forget_all => auth::credentials_forget_all() -> u32;
    activity_list => activity::activity_list(scope: ActivityScope, repo_id: Option<String>, cursor: Option<String>, limit: u32) -> ActivityPage;
    crash_reports_list => crash::crash_reports_list() -> Vec<CrashReportSummary>;
    crash_report_get => crash::crash_report_get(id: String) -> String;
    crash_report_save => crash::crash_report_save(id: String, path: String) -> ();
    crash_report_discard => crash::crash_report_discard(id: String) -> ();
    worktree_list => worktree::worktree_list(repo_id: String) -> Vec<Worktree>;
    worktree_add => worktree::worktree_add(repo_id: String, path: String, branch: String, new_branch: bool, start: Option<String>) -> Vec<Worktree>;
    worktree_remove => worktree::worktree_remove(repo_id: String, path: String, force: bool) -> Vec<Worktree>;
    worktree_lock => worktree::worktree_lock(repo_id: String, path: String, reason: Option<String>) -> Vec<Worktree>;
    worktree_unlock => worktree::worktree_unlock(repo_id: String, path: String) -> Vec<Worktree>;
    worktree_prune => worktree::worktree_prune(repo_id: String) -> Vec<Worktree>;
    agent_templates => agents::agent_templates() -> Vec<AgentTemplateInfo>;
    agent_suggest => agents::agent_suggest(repo_id: String, task: String, branch: Option<String>, base: Option<String>) -> AgentSuggestion;
    agent_start => agents::agent_start(repo_id: String, template_id: String, task: String, branch: String, base: String, unattended: bool, cols: u16, rows: u16) -> Agent;
    agent_list => agents::agent_list(repo_id: String) -> Vec<Agent>;
    agent_stop => agents::agent_stop(agent_id: String) -> Agent;
    agent_resume => agents::agent_resume(agent_id: String, cols: u16, rows: u16) -> Agent;
    agent_forget => agents::agent_forget(agent_id: String) -> ();
    agent_cleanup_preview => agents::agent_cleanup_preview(agent_id: String) -> AgentCleanupPreview;
    agent_cleanup => agents::agent_cleanup(agent_id: String) -> UndoState;
    agent_run_tests => agents::agent_run_tests(agent_id: String, job_id: String) -> AgentTestResult;
    agent_review => agents::agent_review(agent_id: String, source: AgentReviewSource) -> AgentReview;
    agent_review_commit => agents::agent_review_commit(agent_id: String, op_id: String, from: String, to: String, selections: Vec<PatchSelection>, summary: String, description: String, skip_hooks: bool) -> CommitResult;
    agent_discard_rest => agents::agent_discard_rest(agent_id: String) -> Status;
    agent_collisions => agents::agent_collisions(repo_id: String) -> CollisionReport;
    agent_collision_check => agents::agent_collision_check(repo_id: String) -> CollisionReport;
    agent_collision_preview => agents::agent_collision_preview(repo_id: String, collision_id: String, path: String) -> CollisionPreview;
    agent_inform => agents::agent_inform(agent_id: String, text: String) -> ();
    submodule_list => submodule::submodule_list(repo_id: String) -> Vec<Submodule>;
    submodule_add => submodule::submodule_add(repo_id: String, job_id: String, url: String, path: String) -> Vec<Submodule>;
    submodule_update => submodule::submodule_update(repo_id: String, job_id: String, paths: Option<Vec<String>>, init: bool) -> Vec<Submodule>;
    submodule_remove => submodule::submodule_remove(repo_id: String, path: String, force: Option<bool>) -> Vec<Submodule>;
    submodule_move => submodule::submodule_move(repo_id: String, path: String, new_path: String) -> Vec<Submodule>;
    lfs_status => lfs::lfs_status(repo_id: String) -> LfsStatus;
    lfs_track => lfs::lfs_track(repo_id: String, pattern: String) -> LfsStatus;
    lfs_untrack => lfs::lfs_untrack(repo_id: String, pattern: String) -> LfsStatus;
    lfs_pull => lfs::lfs_pull(repo_id: String, job_id: String) -> ();
    lfs_prune => lfs::lfs_prune(repo_id: String) -> String;
    lfs_locks => lfs::lfs_locks(repo_id: String, filter: Option<String>, refresh: Option<bool>) -> LfsLockList;
    lfs_lock => lfs::lfs_lock(repo_id: String, paths: Vec<String>) -> LfsLockOutcome;
    lfs_unlock => lfs::lfs_unlock(repo_id: String, paths: Vec<String>, force: bool) -> LfsLockOutcome;
    repo_cleanup_preview => cleanup::repo_cleanup_preview(repo_id: String) -> CleanupPreview;
    repo_cleanup_lfs_estimate => cleanup::repo_cleanup_lfs_estimate(repo_id: String) -> CleanupLfsEstimate;
    repo_cleanup_run => cleanup::repo_cleanup_run(repo_id: String, job_id: String, options: CleanupOptions) -> CleanupResult;
    patch_create => patch::patch_create(repo_id: String, source: DiffSource, paths: Option<Vec<String>>) -> PatchText;
    patch_apply => patch::patch_apply(repo_id: String, text: String, check_only: bool) -> Status;
    signing_status => signing::signing_status(repo_id: Option<String>) -> SigningStatus;
    terminal_open => terminal::terminal_open(repo_id: String, cols: u16, rows: u16) -> String;
    terminal_write => terminal::terminal_write(terminal_id: String, data: String) -> ();
    terminal_resize => terminal::terminal_resize(terminal_id: String, cols: u16, rows: u16) -> ();
    terminal_close => terminal::terminal_close(terminal_id: String) -> ();
    open_external => external::open_external(repo_id: String, target: ExternalTarget, path: Option<String>, source: Option<DiffSource>) -> ();
    // --- Custom commands ---------------------------------------------------------------------------
    custom_commands_list => custom::custom_commands_list(repo_id: Option<String>) -> CustomCommandList;
    custom_commands_save => custom::custom_commands_save(commands: Vec<CustomCommandDef>) -> Vec<CustomCommandDef>;
    custom_commands_trust => custom::custom_commands_trust(repo_id: String, hash: Option<String>) -> CustomCommandList;
    custom_command_run => custom::custom_command_run(repo_id: String, id: String, context: CustomCommandContext, inputs: std::collections::BTreeMap<String, String>, job_id: String, confirmed: bool) -> CustomCommandResult;
    custom_commands_import => custom::custom_commands_import(path: String) -> Vec<CustomCommandDef>;
    custom_commands_export => custom::custom_commands_export(path: String) -> ();
    // --- Command line ------------------------------------------------------------------------------
    cli_status => cli::cli_status() -> CliStatus;
    cli_install => cli::cli_install() -> CliStatus;
    // --- Hosts: accounts, pull requests, issues ---------------------------------------------
    host_accounts => host::host_accounts() -> Vec<HosterAccount>;
    host_connect => host::host_connect(kind: HostKind, base_url: Option<String>, token: String, username: Option<String>) -> HosterAccount;
    host_connect_gh => host::host_connect_gh(base_url: Option<String>) -> HosterAccount;
    host_disconnect => host::host_disconnect(account_id: String) -> Vec<HosterAccount>;
    host_check => host::host_check(account_id: String) -> HosterAccount;
    host_repo_info => host::host_repo_info(repo_id: String, remote: Option<String>) -> Option<HostRepoInfo>;
    pr_list => host::pr_list(repo_id: String, state: PrListState, page: Option<u32>, per_page: Option<u32>, remote: Option<String>) -> PrPage;
    pr_get => host::pr_get(repo_id: String, number: u64, remote: Option<String>) -> PrDetails;
    pr_create => host::pr_create(repo_id: String, title: String, body: String, source_branch: String, target_branch: String, draft: bool, reviewers: Option<Vec<String>>, labels: Option<Vec<String>>, remote: Option<String>) -> PrSummary;
    pr_comment => host::pr_comment(repo_id: String, number: u64, body: String, remote: Option<String>) -> HostComment;
    pr_merge => host::pr_merge(repo_id: String, number: u64, method: PrMergeMethod, delete_branch: bool, remote: Option<String>) -> PrSummary;
    pr_close => host::pr_close(repo_id: String, number: u64, remote: Option<String>) -> PrSummary;
    pr_reopen => host::pr_reopen(repo_id: String, number: u64, remote: Option<String>) -> PrSummary;
    pr_checkout => host::pr_checkout(repo_id: String, number: u64, remote: Option<String>) -> Status;
    pr_template => host::pr_template(repo_id: String) -> Option<String>;
    pr_review_threads => host::pr_review_threads(repo_id: String, number: u64, remote: Option<String>) -> Vec<ReviewThread>;
    pr_review_reply => host::pr_review_reply(repo_id: String, number: u64, thread_id: String, body: String, remote: Option<String>) -> ReviewReply;
    pr_review_drafts => pr_review::pr_review_drafts(repo_id: String, number: u64, remote: Option<String>) -> PrReviewDrafts;
    pr_review_draft_save => pr_review::pr_review_draft_save(repo_id: String, number: u64, comment: NewReviewComment, draft_id: Option<String>, remote: Option<String>) -> ReviewDraft;
    pr_review_draft_delete => pr_review::pr_review_draft_delete(repo_id: String, number: u64, draft_id: String, remote: Option<String>) -> ();
    pr_review_comment_create => pr_review::pr_review_comment_create(repo_id: String, number: u64, comment: NewReviewComment, remote: Option<String>) -> ();
    pr_review_thread_resolve => pr_review::pr_review_thread_resolve(repo_id: String, number: u64, resolve_id: String, resolved: bool, remote: Option<String>) -> ();
    pr_review_submit => pr_review::pr_review_submit(repo_id: String, number: u64, vote: ReviewVote, body: String, commit: String, remote: Option<String>) -> ReviewSubmitResult;
    issue_list => host::issue_list(repo_id: String, state: IssueListState, query: Option<String>, page: Option<u32>, per_page: Option<u32>, remote: Option<String>) -> IssuePage;
    issue_get => host::issue_get(repo_id: String, number: u64, remote: Option<String>) -> IssueDetails;
    issue_create => host::issue_create(repo_id: String, title: String, body: String, remote: Option<String>) -> IssueSummary;
    release_create => host::release_create(repo_id: String, tag: String, name: String, body: String, prerelease: bool, remote: Option<String>) -> HostRelease;
    stats_compute => stats::stats_compute(repo_id: String, job_id: String, range: StatsRange) -> RepoStats;
    // --- AI ------------------------------------------------------------------
    ai_status => ai::ai_status() -> AiStatus;
    ai_key_set => ai::ai_key_set(provider: AiProviderKind, key: String) -> AiStatus;
    ai_key_remove => ai::ai_key_remove(provider: AiProviderKind) -> AiStatus;
    ai_models => ai::ai_models(job_id: String, provider: AiProviderKind, base_url: Option<String>, key: Option<String>, model: Option<String>) -> AiModelList;
    ai_intro_dismiss => ai::ai_intro_dismiss() -> AiStatus;
    ai_preview => ai::ai_preview(repo_id: String, feature: AiFeature, input: AiInput, locale: String) -> AiPreview;
    ai_preview_confirm => ai::ai_preview_confirm(repo_id: Option<String>, feature: AiFeature, fingerprint: String, triggers: Vec<AiAskTrigger>, dont_ask_again: bool) -> ();
    ai_preview_reset => ai::ai_preview_reset() -> ();
    ai_push_review => ai_features::ai_push_review(repo_id: String, job_id: String, branch: Option<String>, remote: Option<String>, remote_branch: Option<String>, locale: String) -> AiPushReview;
    ai_usage => ai::ai_usage() -> AiUsageSummary;
    release_notes_range => release_notes::release_notes_range(repo_id: String, from: Option<String>, to: Option<String>) -> ReleaseNotesRange;
    ai_release_notes => release_notes::ai_release_notes(repo_id: String, job_id: String, from: Option<String>, to: Option<String>, locale: String) -> ReleaseNotes;
    changelog_insert => release_notes::changelog_insert(repo_id: String, version: String, date: String, notes: String) -> ChangelogInsertResult;
    ai_commit_message => ai_features::ai_commit_message(repo_id: String, job_id: String, locale: String) -> AiCommitMessage;
    ai_detect => ai::ai_detect() -> AiDetection;
    ai_cli_login => ai::ai_cli_login(repo_id: String, provider: AiProviderKind, cols: u16, rows: u16) -> String;
    ai_pr_description => ai_features::ai_pr_description(repo_id: String, job_id: String, source: String, target: String, locale: String) -> AiPrDescription;
    ai_plan => plan::ai_plan(repo_id: String, job_id: String, text: String, locale: String) -> PlanPreview;
    ai_plan_check => plan::ai_plan_check(repo_id: String, job_id: String, steps: Vec<PlanStep>) -> PlanPreview;
    ai_plan_run => plan::ai_plan_run(repo_id: String, job_id: String, text: String, steps: Vec<PlanStep>, expect: String, confirmed: Vec<u32>) -> PlanRunResult;
    ai_conflict_intent => ai_features::ai_conflict_intent(repo_id: String, job_id: String, path: String, blocks: Vec<ConflictBlockRange>, locale: String) -> ConflictIntent;
    stack_plan => stack::stack_plan(repo_id: String, branch: String, base: String, cuts: Vec<StackCut>) -> StackPlan;
    stack_create => stack::stack_create(repo_id: String, branch: String, base: String, cuts: Vec<StackCut>, expected_base: String, expected_tip: String) -> StackStatus;
    stack_status => stack::stack_status(repo_id: String, branch: String) -> Option<StackStatus>;
    stack_restack => stack::stack_restack(repo_id: String, branch: String, expected_top: String) -> OpResult;
    stack_push => stack::stack_push(repo_id: String, job_id: String, branches: Vec<String>, remote: String, force: bool, expected: Option<Vec<Option<String>>>, accepted_secrets: Option<Vec<String>>) -> PushResult;
    stack_prs_create => stack::stack_prs_create(repo_id: String, target: String, parts: Vec<StackPrPart>, from: u32, remote: Option<String>) -> StackPrOutcome;
    stack_check => stack::stack_check(repo_id: String, job_id: String, branch: String, base: String, cuts: Vec<StackCut>) -> Vec<StackCheckResult>;
    ai_stack_split => ai_features::ai_stack_split(repo_id: String, job_id: String, branch: String, base: String, locale: String) -> AiStackSplit;
    ai_digest => ai_features::ai_digest(repo_id: String, job_id: String, locale: String) -> AiDigest;
    ai_review_fix => ai_features::ai_review_fix(repo_id: String, job_id: String, number: u64, thread_id: String, locale: String) -> AiReviewFix;
    review_fix_apply => review_fix::review_fix_apply(repo_id: String, number: u64, fix: ReviewFixInput, target: String) -> ReviewFixApplied;
    // --- Search by meaning ---------------------------------------------------
    ai_semantic_status => ai_search::ai_semantic_status(repo_id: String) -> AiSemanticStatus;
    ai_semantic_search => ai_search::ai_semantic_search(repo_id: String, job_id: String, query: String, locale: String) -> AiSemanticResult;
    ai_semantic_index_update => ai_search::ai_semantic_index_update(repo_id: String, job_id: String) -> AiSemanticIndexUpdate;
    ai_semantic_index_delete => ai_search::ai_semantic_index_delete() -> u64;
}

// --- Hand-written: bodies that do more than delegate (listed in `hand_written` above) ---------

/// Quits the app after a confirmed prompt: cancel running actions, close every window. Quitting is
/// marked first, so the windows keep their rows for the next start.
#[tauri::command]
pub async fn app_quit(core: State<'_, Core>, app: tauri::AppHandle) -> R<()> {
    c::app::app_quit(&core).await?;
    app.exit(0);
    Ok(())
}

/// Closing the calling window is confirmed: its jobs stop (as the only window, the app quits),
/// then it closes without asking again.
#[tauri::command]
pub async fn window_close(core: State<'_, Core>, window: tauri::WebviewWindow) -> R<()> {
    scoped(window.label().to_string(), c::window::window_close(&core)).await?;
    if let Err(e) = window.close() {
        log::warn!("Could not close the window: {e}");
    }
    Ok(())
}

#[tauri::command]
pub async fn window_layout(core: State<'_, Core>, app: tauri::AppHandle, window: tauri::WebviewWindow) -> R<WindowLayout> {
    let (frames, cursor) = crate::windows::layout_frames(&app);
    scoped(window.label().to_string(), c::window::window_layout(&core, frames, cursor)).await
}

#[tauri::command]
pub async fn repo_open(core: State<'_, Core>, window: tauri::WebviewWindow, path: String, add_to_profile: Option<bool>) -> R<OpenedRepo> {
    scoped(window.label().to_string(), c::repos::repo_open_with(&core, path, add_to_profile.unwrap_or(false))).await
}

// `alias`, `groupName` and `color` distinguish “missing” from `null`; Tauri can't do that for
// individual parameters, so the raw input object is read here.
// gc:params repoId,alias,isFavorite,groupName,color
#[tauri::command]
pub async fn repo_update(core: State<'_, Core>, window: tauri::WebviewWindow, request: tauri::ipc::Request<'_>) -> R<Repo> {
    let tauri::ipc::InvokeBody::Json(body) = request.body() else {
        return Err(CoreError::not_allowed("repo_update expects a JSON object."));
    };
    let repo_id =
        tri_state::<String>(body, "repoId")?.flatten().ok_or_else(|| CoreError::not_allowed("repo_update: “repoId” is missing."))?;
    let alias = tri_state::<String>(body, "alias")?;
    let is_favorite = tri_state::<bool>(body, "isFavorite")?.flatten();
    let group_name = tri_state::<String>(body, "groupName")?;
    let color = tri_state::<u8>(body, "color")?;
    scoped(window.label().to_string(), c::repos::repo_update(&core, repo_id, alias, is_favorite, group_name, color)).await
}

// `program` and `allowedSignersFile` distinguish “missing” (leave untouched) from `null` (remove
// the entry); so the raw input object is read here.
// gc:params repoId,enabled,format,key,program,allowedSignersFile
#[tauri::command]
pub async fn signing_set(core: State<'_, Core>, window: tauri::WebviewWindow, request: tauri::ipc::Request<'_>) -> R<SigningStatus> {
    let tauri::ipc::InvokeBody::Json(body) = request.body() else {
        return Err(CoreError::not_allowed("signing_set expects a JSON object."));
    };
    let repo_id = tri_state::<String>(body, "repoId")?.flatten();
    let enabled = tri_state::<bool>(body, "enabled")?.flatten();
    let format = tri_state::<SigningFormat>(body, "format")?.flatten();
    let key = tri_state::<String>(body, "key")?.flatten();
    let program = tri_state::<String>(body, "program")?;
    let allowed_signers_file = tri_state::<String>(body, "allowedSignersFile")?;
    scoped(window.label().to_string(), c::signing::signing_set(&core, repo_id, enabled, format, key, program, allowed_signers_file)).await
}
