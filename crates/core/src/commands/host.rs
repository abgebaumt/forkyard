//! Commands for the host integration: accounts, pull requests (on GitLab: merge requests) and
//! issues. The work happens in `crate::host`; here things are checked, mapped and dispatched.
//!
//! All commands with `repo_id` recognise the host from the URL of a remote (`remote`: name of the
//! remote; if not given `origin`, otherwise the first one recognised). Error codes: `host_unsupported`
//! (no remote on a supported host), `host_not_connected` (no account), `host_auth_failed`,
//! `host_rate_limited`, `host_not_found`, `host_rejected`, plus `offline` and `timeout`.

use std::path::Path;

use crate::app::Core;
use crate::commands::branches;
use crate::commands::status::read_status;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::host::{self, NewPr, Paging, PrChange, RepoApi, DEFAULT_PER_PAGE};
use crate::model::{
    HostComment, HostInfoError, HostKind, HostRepoInfo, HosterAccount, IssueDetails, IssueListState, IssuePage, PrDetails, PrListState, PrMergeMethod, PrPage,
    PrSummary, RepoChange, Status,
};
use crate::util;

/// Largest template `pr_template` returns.
const MAX_TEMPLATE_BYTES: u64 = 256 * 1024;

fn per_page(value: Option<u32>) -> u32 {
    value.unwrap_or(DEFAULT_PER_PAGE).clamp(1, 100)
}

fn page(value: Option<u32>) -> u32 {
    value.unwrap_or(1).max(1)
}

fn paging(page_number: Option<u32>, per_page_count: Option<u32>) -> Paging {
    Paging { page: page(page_number), per_page: per_page(per_page_count) }
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/// The connected accounts of the active profile.
pub async fn host_accounts(core: &Core) -> CoreResult<Vec<HosterAccount>> {
    host::accounts(core)
}

/// Checks the token against the host's API and stores it in the keychain.
pub async fn host_connect(core: &Core, kind: HostKind, base_url: Option<String>, token: String) -> CoreResult<HosterAccount> {
    host::connect(core, kind, base_url, token).await
}

/// Connects GitHub with the login of the GitHub CLI (`gh auth token`); the token never leaves the core.
pub async fn host_connect_gh(core: &Core, base_url: Option<String>) -> CoreResult<HosterAccount> {
    host::gh_cli::connect(core, base_url).await
}

pub async fn host_disconnect(core: &Core, account_id: String) -> CoreResult<Vec<HosterAccount>> {
    host::disconnect(core, &account_id).await
}

pub async fn host_check(core: &Core, account_id: String) -> CoreResult<HosterAccount> {
    host::check(core, &account_id).await
}

/// The repository at the host; `None` if no remote belongs to GitHub, GitLab or a
/// connected self-hosted instance. Without an account the details from the host are missing; if
/// fetching them fails, the reason is in `error` – the command itself does not fail because of it.
pub async fn host_repo_info(core: &Core, repo_id: String, remote: Option<String>) -> CoreResult<Option<HostRepoInfo>> {
    let Some(found) = host::resolve(core, &repo_id, remote.as_deref()).await? else {
        return Ok(None);
    };
    let detected = found.detected;
    let hoster = host::host(detected.kind);
    let mut info = HostRepoInfo {
        remote: found.remote,
        kind: detected.kind,
        account: detected.account.as_ref().map(|row| row.to_model()),
        web_url: detected.web_url(),
        owner: detected.owner.clone(),
        name: detected.name.clone(),
        default_branch: None,
        can_push: None,
        fork_parent: None,
        capabilities: hoster.capabilities(),
        error: None,
    };
    let Some(account) = &detected.account else {
        return Ok(Some(info));
    };
    let repo = host::RepoPath { owner: detected.owner, name: detected.name };
    let facts = async {
        let mut api = host::api_for_account(core, account).await?;
        api.repo_id = Some(repo_id.clone());
        hoster.repo_facts(core, &api, &repo).await
    }
    .await;
    match facts {
        Ok(facts) => {
            info.default_branch = facts.default_branch;
            info.can_push = facts.can_push;
            info.fork_parent = facts.fork_parent;
            if facts.has_issues == Some(false) {
                info.capabilities.issues = false;
            }
        }
        Err(e) => info.error = Some(HostInfoError { code: e.code, message: e.message }),
    }
    // The call may have changed the account's state (token rejected or accepted again).
    if let Some(fresh) = host::accounts(core)?.into_iter().find(|a| a.id == account.id) {
        info.account = Some(fresh);
    }
    Ok(Some(info))
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

/// One page of pull requests, most recently changed first. `page` from 1; `nextPage: null` = end.
/// (GitHub does not know "merged" as a filter – pages there may come out shorter.)
pub async fn pr_list(core: &Core, repo_id: String, state: PrListState, page_number: Option<u32>, per_page_count: Option<u32>, remote: Option<String>) -> CoreResult<PrPage> {
    let RepoApi { api, repo, .. } = host::api_for_repo(core, &repo_id, remote.as_deref()).await?;
    host::host(api.kind).pr_list(core, &api, &repo, state, paging(page_number, per_page_count)).await
}

pub async fn pr_get(core: &Core, repo_id: String, number: u64, remote: Option<String>) -> CoreResult<PrDetails> {
    let RepoApi { api, repo, .. } = host::api_for_repo(core, &repo_id, remote.as_deref()).await?;
    host::host(api.kind).pr_get(core, &api, &repo, number).await
}

fn clean_names(values: Option<Vec<String>>) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for value in values.unwrap_or_default() {
        let value = value.trim().trim_start_matches('@').to_string();
        if !value.is_empty() && !names.contains(&value) {
            names.push(value);
        }
    }
    names
}

fn check_title(title: &str) -> CoreResult<String> {
    let title = title.trim();
    if title.is_empty() {
        return Err(CoreError::new(ErrorCode::EmptyMessage, "The title must not be empty."));
    }
    if title.contains(['\n', '\r']) {
        return Err(CoreError::not_allowed("The title must be a single line."));
    }
    Ok(title.to_string())
}

/// Creates a pull request. `name_exists` if there is already an open one for the source branch.
#[allow(clippy::too_many_arguments)]
pub async fn pr_create(
    core: &Core,
    repo_id: String,
    title: String,
    body: String,
    source_branch: String,
    target_branch: String,
    draft: bool,
    reviewers: Option<Vec<String>>,
    labels: Option<Vec<String>>,
    remote: Option<String>,
) -> CoreResult<PrSummary> {
    let title = check_title(&title)?;
    let (source, target) = (source_branch.trim(), target_branch.trim());
    if source.is_empty() || target.is_empty() {
        return Err(CoreError::not_allowed("Source and target branch are required."));
    }
    if source == target {
        return Err(CoreError::not_allowed("Source and target branch are the same."));
    }
    let RepoApi { api, repo, .. } = host::api_for_repo(core, &repo_id, remote.as_deref()).await?;
    let (reviewers, labels) = (clean_names(reviewers), clean_names(labels));
    let new = NewPr { title: &title, body: &body, source_branch: source, target_branch: target, draft, reviewers: &reviewers, labels: &labels };
    host::host(api.kind).pr_create(core, &api, &repo, new).await
}

/// Changes only what is given (`None` = stays). `reviewers` and `labels` replace the list.
#[allow(clippy::too_many_arguments)]
pub async fn pr_update(
    core: &Core,
    repo_id: String,
    number: u64,
    title: Option<String>,
    body: Option<String>,
    target_branch: Option<String>,
    draft: Option<bool>,
    reviewers: Option<Vec<String>>,
    labels: Option<Vec<String>>,
    remote: Option<String>,
) -> CoreResult<PrSummary> {
    let title = title.as_deref().map(check_title).transpose()?;
    let target = target_branch.as_deref().map(str::trim).filter(|t| !t.is_empty());
    let reviewers = reviewers.map(|r| clean_names(Some(r)));
    let labels = labels.map(|l| clean_names(Some(l)));
    let RepoApi { api, repo, .. } = host::api_for_repo(core, &repo_id, remote.as_deref()).await?;
    let change = PrChange { title: title.as_deref(), body: body.as_deref(), target_branch: target, draft, reviewers: reviewers.as_deref(), labels: labels.as_deref() };
    host::host(api.kind).pr_update(core, &api, &repo, number, change).await
}

/// General comment (Markdown) on a pull request.
pub async fn pr_comment(core: &Core, repo_id: String, number: u64, body: String, remote: Option<String>) -> CoreResult<HostComment> {
    if body.trim().is_empty() {
        return Err(CoreError::new(ErrorCode::EmptyMessage, "The comment must not be empty."));
    }
    let RepoApi { api, repo, .. } = host::api_for_repo(core, &repo_id, remote.as_deref()).await?;
    host::host(api.kind).pr_comment(core, &api, &repo, number, &body).await
}

/// Merges at the host. Nothing changes locally – fetch afterwards.
pub async fn pr_merge(core: &Core, repo_id: String, number: u64, method: PrMergeMethod, delete_branch: bool, remote: Option<String>) -> CoreResult<PrSummary> {
    let RepoApi { api, repo, .. } = host::api_for_repo(core, &repo_id, remote.as_deref()).await?;
    host::host(api.kind).pr_merge(core, &api, &repo, number, method, delete_branch).await
}

async fn set_open(core: &Core, repo_id: &str, number: u64, remote: Option<&str>, open: bool) -> CoreResult<PrSummary> {
    let RepoApi { api, repo, .. } = host::api_for_repo(core, repo_id, remote).await?;
    host::host(api.kind).pr_set_open(core, &api, &repo, number, open).await
}

pub async fn pr_close(core: &Core, repo_id: String, number: u64, remote: Option<String>) -> CoreResult<PrSummary> {
    set_open(core, &repo_id, number, remote.as_deref(), false).await
}

pub async fn pr_reopen(core: &Core, repo_id: String, number: u64, remote: Option<String>) -> CoreResult<PrSummary> {
    set_open(core, &repo_id, number, remote.as_deref(), true).await
}

async fn rev_exists(core: &Core, repo_id: &str, rev: &str) -> CoreResult<bool> {
    let spec = format!("{rev}^{{commit}}");
    Ok(core.git_for(repo_id)?.args(["rev-parse", "--verify", "--quiet", &spec]).read_only().no_log().run_raw().await?.success())
}

async fn current_branch(core: &Core, repo_id: &str) -> CoreResult<Option<String>> {
    let out = core.git_for(repo_id)?.args(["symbolic-ref", "--short", "-q", "HEAD"]).read_only().no_log().run_raw().await?;
    Ok(if out.success() { util::non_empty(Some(out.stdout_text())) } else { None })
}

/// Fetches the branch of a pull request and checks it out.
///
/// - If the source branch is in the same repository, it is fetched as a normal branch and
///   checked out with an upstream (an existing local branch is fast-forwarded if possible).
/// - For a fork, the local branch `pr-<number>` (GitLab: `mr-<number>`) is created from the
///   ref the host offers for the pull request.
///
/// Errors as with `branch_checkout` (`dirty_worktree`, …) and with network calls; `not_allowed`
/// if the local branch has its own commits that the pull request does not contain (any more).
pub async fn pr_checkout(core: &Core, repo_id: String, number: u64, remote: Option<String>) -> CoreResult<Status> {
    let RepoApi { api, repo, remote } = host::api_for_repo(core, &repo_id, remote.as_deref()).await?;
    let hoster = host::host(api.kind);
    let head = hoster.pr_head(core, &api, &repo, number).await?;
    let word = hoster.pr_word();
    let same_repo = !head.is_fork && !head.source_branch.is_empty();
    // From a fork the branch only comes through the ref the host offers for the pull request.
    let fork_ref = if same_repo {
        None
    } else {
        Some(hoster.pr_ref(number).ok_or_else(|| {
            CoreError::new(
                ErrorCode::HostUnsupported,
                format!("{} offers no branch for {word}s from forks. Add the fork as a remote and check out its branch from there.", hoster.label()),
            )
        })?)
    };
    let local = if same_repo { head.source_branch.clone() } else { hoster.fork_branch(number) };
    util::check_ref_name(&local).map_err(|reason| CoreError::invalid_name(format!("The {word} branch can't be created here: {reason}")))?;
    // Same repository: fetch as a remote branch so the upstream is right. Fork: into a
    // separate ref of the app that disappears again at the end (an auto-fetch could
    // overwrite FETCH_HEAD in the meantime).
    let (source, newest) = match fork_ref {
        None => (format!("refs/heads/{}", head.source_branch), format!("refs/remotes/{remote}/{}", head.source_branch)),
        Some(reference) => (reference, format!("refs/forkyard/pull/{number}")),
    };
    let refspec = format!("+{source}:{newest}");
    let fetched = {
        // One transfer runs per repository at a time.
        let _network = core.network_lock(&repo_id).await;
        match core.git_for(&repo_id) {
            Ok(git) => git.args(["fetch", "--no-tags", remote.as_str(), refspec.as_str()]).network().run().await,
            Err(e) => Err(e),
        }
    };
    core.emit_repo_changed(&repo_id, &[RepoChange::Refs]);
    fetched.map_err(|e| {
        if e.git_output.as_deref().is_some_and(|o| o.contains("couldn't find remote ref")) {
            CoreError::new(ErrorCode::HostNotFound, format!("The remote “{remote}” does not offer the branch of {word} #{number} (anymore).")).with_git_output(e.git_output.unwrap_or_default())
        } else {
            e
        }
    })?;
    let result = checkout_fetched(core, &repo_id, &local, &newest, same_repo.then(|| format!("{remote}/{}", head.source_branch)), word).await;
    if !same_repo {
        // The helper ref has served its purpose, however it went.
        if let Ok(git) = core.git_for(&repo_id) {
            let _ = git.args(["update-ref", "-d", newest.as_str()]).no_log().run_raw().await;
        }
    }
    result
}

/// Second part of `pr_checkout`: create or fast-forward the local branch and check it out.
/// `tracking`: the remote branch (`origin/x`) a new local branch should follow.
async fn checkout_fetched(core: &Core, repo_id: &str, local: &str, newest: &str, tracking: Option<String>, word: &str) -> CoreResult<Status> {
    let on_it = current_branch(core, repo_id).await?.as_deref() == Some(local);
    let local_exists = rev_exists(core, repo_id, &format!("refs/heads/{local}")).await?;
    if !local_exists {
        if let Some(tracking) = tracking {
            // Creates the local branch with an upstream.
            return branches::branch_checkout(core, repo_id.to_string(), tracking).await;
        }
        core.with_write_lock(repo_id, &[RepoChange::Refs], async { core.git_for(repo_id)?.args(["branch", "--no-track", local, newest]).run().await.map(|_| ()) }).await?;
        return branches::branch_checkout(core, repo_id.to_string(), local.to_string()).await;
    }
    if !on_it {
        branches::branch_checkout(core, repo_id.to_string(), local.to_string()).await?;
    }
    // Fast-forward to the fetched state. Own commits on top stay; if the branch has diverged, it is refused.
    core.with_write_lock(repo_id, &[RepoChange::Head, RepoChange::Refs, RepoChange::Index, RepoChange::Worktree], async {
        let contained = core.git_for(repo_id)?.args(["merge-base", "--is-ancestor", newest, "HEAD"]).read_only().no_log().run_raw().await?;
        if contained.success() {
            return read_status(core, repo_id).await;
        }
        let out = core.git_for(repo_id)?.args(["merge", "--ff-only", newest]).run_raw().await?;
        if !out.success() {
            let text = format!("{}{}", out.stdout_text(), util::decode_lossy(&out.stderr));
            if text.contains("Not possible to fast-forward") || text.contains("diverging") {
                return Err(CoreError::not_allowed(format!(
                    "The local branch “{local}” has commits that the {word} does not contain. Rename or reset it first."
                )));
            }
            return Err(crate::git::errors::classify("merge", out.code, &out.stdout, &out.stderr));
        }
        read_status(core, repo_id).await
    })
    .await
}

/// Names (lower case) under which a single template may live.
const TEMPLATE_FILES: [&str; 2] = ["pull_request_template.md", "merge_request_template.md"];
/// Folders with one or more templates (lower case).
const TEMPLATE_DIRS: [&str; 2] = ["pull_request_template", "merge_request_templates"];

fn read_template(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_TEMPLATE_BYTES {
        return None;
    }
    let bytes = std::fs::read(path).ok()?;
    if util::looks_binary(&bytes) {
        return None;
    }
    Some(util::decode_text(&bytes).0)
}

/// Looks for a template in a folder (case-insensitive).
fn template_in(dir: &Path) -> Option<String> {
    let mut entries: Vec<(String, std::path::PathBuf)> = std::fs::read_dir(dir).ok()?.filter_map(|e| e.ok()).map(|e| (e.file_name().to_string_lossy().to_lowercase(), e.path())).collect();
    entries.sort();
    if let Some(found) = entries.iter().filter(|(name, _)| TEMPLATE_FILES.contains(&name.as_str())).find_map(|(_, path)| read_template(path)) {
        return Some(found);
    }
    for (_, folder) in entries.iter().filter(|(name, path)| TEMPLATE_DIRS.contains(&name.as_str()) && path.is_dir()) {
        let mut files: Vec<(String, std::path::PathBuf)> =
            std::fs::read_dir(folder).ok()?.filter_map(|e| e.ok()).map(|e| (e.file_name().to_string_lossy().to_lowercase(), e.path())).filter(|(name, _)| name.ends_with(".md")).collect();
        // "Default.md" first (that is how GitLab picks), otherwise by name.
        files.sort_by_key(|(name, _)| (name != "default.md", name.clone()));
        if let Some(found) = files.iter().find_map(|(_, path)| read_template(path)) {
            return Some(found);
        }
    }
    None
}

/// Text of the pull request template from the working directory, if the repository
/// ships one: `.github/`, `.gitlab/` (and the folders of the other hosts, see `host::template_folders`),
/// the root directory or `docs/` – each with
/// `pull_request_template.md` or a folder of templates (`PULL_REQUEST_TEMPLATE/`,
/// `merge_request_templates/`; from it `Default.md`, otherwise the first). No network call.
pub async fn pr_template(core: &Core, repo_id: String) -> CoreResult<Option<String>> {
    let root = core.repo_path(&repo_id)?;
    let folders = host::template_folders();
    let found = tokio::task::spawn_blocking(move || folders.iter().find_map(|folder| template_in(&root.join(folder)))).await;
    found.map_err(|e| CoreError::unknown(format!("The search for the template was aborted: {e}")))
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

/// One page of issues, most recently changed first; `query` searches title and body.
pub async fn issue_list(
    core: &Core,
    repo_id: String,
    state: IssueListState,
    query: Option<String>,
    page_number: Option<u32>,
    per_page_count: Option<u32>,
    remote: Option<String>,
) -> CoreResult<IssuePage> {
    let RepoApi { api, repo, .. } = host::api_for_repo(core, &repo_id, remote.as_deref()).await?;
    host::host(api.kind).issue_list(core, &api, &repo, state, query.as_deref(), paging(page_number, per_page_count)).await
}

pub async fn issue_get(core: &Core, repo_id: String, number: u64, remote: Option<String>) -> CoreResult<IssueDetails> {
    let RepoApi { api, repo, .. } = host::api_for_repo(core, &repo_id, remote.as_deref()).await?;
    host::host(api.kind).issue_get(core, &api, &repo, number).await
}
