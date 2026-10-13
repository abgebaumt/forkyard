//! GitLab through the REST API v4 (`<instance>/api/v4`), documented endpoints only: `/user`,
//! `/personal_access_tokens/self`, `/projects/:id`, `…/merge_requests`, `…/issues`,
//! `…/pipelines/:id/jobs`, `/users?username=`.
//!
//! A project is addressed by its encoded path (`group%2Fsubgroup%2Fproject`).

use serde_json::{json, Value};

use super::{first_line, flag, host_user, list, not_found_as, number, opt_text, parallel, summarize_checks, text, Api, RepoPath};
use crate::app::Core;
use crate::db::hoster_accounts::AccountFacts;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::http::{encode, with_query, Method};
use crate::model::{
    CheckRunState, HostComment, HostLabel, HostRepoRef, HostUser, IssueDetails, IssueListState, IssuePage, IssueState, IssueSummary, PrCheck, PrCommit,
    PrDetails, PrListState, PrMergeMethod, PrPage, PrReviewState, PrReviewer, PrState, PrSummary,
};

/// Prefix with which GitLab marks a merge request as a draft.
const DRAFT_PREFIX: &str = "Draft: ";

fn project_path(repo: &RepoPath) -> String {
    format!("/projects/{}", encode(&repo.full()))
}

fn user(value: &Value) -> Option<HostUser> {
    if !value.is_object() {
        return None;
    }
    host_user(text(value, "username"), opt_text(value, "name"), opt_text(value, "avatar_url"))
}

fn labels(value: &Value) -> Vec<HostLabel> {
    list(value, "labels")
        .iter()
        .filter_map(|label| match label {
            Value::String(name) => Some(HostLabel { name: name.clone(), color: None }),
            other => opt_text(other, "name").map(|name| HostLabel { name, color: super::color(opt_text(other, "color")) }),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Account and project
// ---------------------------------------------------------------------------

/// `GET /user`, plus `GET /personal_access_tokens/self` for the permissions: creating and
/// merging merge requests needs `api`. If the instance doesn't know the second endpoint or the
/// token is of another kind, the permissions count as sufficient until a call fails.
pub async fn account_facts(core: &Core, api: &Api) -> CoreResult<AccountFacts> {
    let me = api.get_json(core, "/user").await?;
    let login = opt_text(&me, "username").ok_or_else(|| CoreError::unknown("The response from GitLab could not be read (no user)."))?;
    let mut missing = Vec::new();
    if let Ok(token) = api.get_json(core, "/personal_access_tokens/self").await {
        if let Some(scopes) = token.get("scopes").and_then(Value::as_array) {
            if !scopes.iter().any(|s| s.as_str() == Some("api")) {
                missing.push("api".to_string());
            }
        }
    }
    Ok(AccountFacts { login: Some(login), name: opt_text(&me, "name"), avatar_url: opt_text(&me, "avatar_url"), scopes_ok: missing.is_empty(), missing_scopes: missing })
}

pub struct RepoFacts {
    pub default_branch: Option<String>,
    pub can_push: Option<bool>,
    pub fork_parent: Option<HostRepoRef>,
}

fn project_missing(repo: &RepoPath) -> impl FnOnce() -> String + '_ {
    move || format!("GitLab could not find the project {} – or the token is not allowed to see it.", repo.full())
}

/// `GET /projects/:id`. Write access requires at least the Developer role (level 30) in the
/// project or in the group.
pub async fn repo_facts(core: &Core, api: &Api, repo: &RepoPath) -> CoreResult<RepoFacts> {
    let value = api.get_json(core, &project_path(repo)).await.map_err(|e| not_found_as(e, project_missing(repo)))?;
    let level = |key: &str| value.get("permissions").and_then(|p| p.get(key)).and_then(|a| a.get("access_level")).and_then(Value::as_u64);
    let can_push = value.get("permissions").filter(|p| p.is_object()).map(|_| level("project_access").max(level("group_access")).unwrap_or(0) >= 30);
    let fork_parent = value.get("forked_from_project").filter(|p| p.is_object()).and_then(|parent| {
        let full = text(parent, "path_with_namespace");
        let (owner, name) = full.rsplit_once('/')?;
        Some(HostRepoRef { owner: owner.to_string(), name: name.to_string(), web_url: text(parent, "web_url") })
    });
    Ok(RepoFacts { default_branch: opt_text(&value, "default_branch"), can_push, fork_parent })
}

// ---------------------------------------------------------------------------
// Merge Requests
// ---------------------------------------------------------------------------

fn mr_state(value: &Value) -> PrState {
    match text(value, "state").as_str() {
        "merged" => PrState::Merged,
        "closed" => PrState::Closed,
        _ => PrState::Open,
    }
}

fn mr_summary(value: &Value) -> PrSummary {
    let project = |key: &str| value.get(key).and_then(Value::as_u64);
    PrSummary {
        number: number(value, "iid"),
        title: text(value, "title"),
        state: mr_state(value),
        is_draft: flag(value, "draft") || flag(value, "work_in_progress"),
        author: value.get("author").and_then(user),
        source_branch: text(value, "source_branch"),
        target_branch: text(value, "target_branch"),
        updated_at: text(value, "updated_at"),
        web_url: text(value, "web_url"),
        checks: None,
        review_state: None,
        labels: labels(value),
        is_fork: matches!((project("source_project_id"), project("target_project_id")), (Some(source), Some(target)) if source != target),
    }
}

fn job_state(status: &str) -> CheckRunState {
    match status {
        "success" => CheckRunState::Passing,
        "failed" | "canceled" => CheckRunState::Failing,
        "skipped" => CheckRunState::Skipped,
        // created, pending, running, manual, scheduled, preparing, waiting_for_resource
        _ => CheckRunState::Pending,
    }
}

/// Summarised state from the merge request's pipeline (`head_pipeline.status`).
fn pipeline_checks(value: &Value) -> Vec<PrCheck> {
    match value.get("head_pipeline").filter(|p| p.is_object()) {
        Some(pipeline) => vec![PrCheck { name: "Pipeline".to_string(), state: job_state(&text(pipeline, "status")), url: opt_text(pipeline, "web_url") }],
        None => Vec::new(),
    }
}

/// Reviewers of the merge request with their approval (`…/approvals`).
fn reviewers(value: &Value, approvals: Option<&Value>) -> Vec<PrReviewer> {
    let approved: Vec<HostUser> = approvals.map(|a| list(a, "approved_by").iter().filter_map(|entry| entry.get("user").and_then(user)).collect()).unwrap_or_default();
    let mut result: Vec<PrReviewer> = approved.into_iter().map(|user| PrReviewer { user, state: Some(PrReviewState::Approved) }).collect();
    for person in list(value, "reviewers").iter().filter_map(user) {
        if !result.iter().any(|r| r.user.login == person.login) {
            result.push(PrReviewer { user: person, state: None });
        }
    }
    result
}

fn review_summary(reviewers: &[PrReviewer], approvals: Option<&Value>) -> Option<PrReviewState> {
    let pending = reviewers.iter().any(|r| r.state.is_none());
    let approved = reviewers.iter().any(|r| r.state == Some(PrReviewState::Approved));
    let left = approvals.and_then(|a| a.get("approvals_left")).and_then(Value::as_u64).unwrap_or(0);
    if approved && left == 0 && !pending {
        Some(PrReviewState::Approved)
    } else if pending || left > 0 {
        Some(PrReviewState::ReviewRequired)
    } else if approved {
        Some(PrReviewState::Approved)
    } else {
        None
    }
}

fn mr_path(repo: &RepoPath, number: u64) -> String {
    format!("{}/merge_requests/{number}", project_path(repo))
}

fn mr_missing(repo: &RepoPath, number: u64) -> impl FnOnce() -> String + '_ {
    move || format!("Merge request !{number} does not exist in {}.", repo.full())
}

async fn mr_raw(core: &Core, api: &Api, repo: &RepoPath, number: u64) -> CoreResult<Value> {
    api.get_json(core, &mr_path(repo, number)).await.map_err(|e| not_found_as(e, mr_missing(repo, number)))
}

/// `GET /projects/:id/merge_requests`, plus pipeline and approvals per entry (in parallel).
pub async fn pr_list(core: &Core, api: &Api, repo: &RepoPath, state: PrListState, page: u32, per_page: u32) -> CoreResult<PrPage> {
    let api_state = match state {
        PrListState::Open => "opened",
        PrListState::Closed => "closed",
        PrListState::Merged => "merged",
        PrListState::All => "all",
    };
    let path = with_query(
        &format!("{}/merge_requests", project_path(repo)),
        &[("state", api_state.to_string()), ("order_by", "updated_at".into()), ("sort", "desc".into()), ("per_page", per_page.to_string()), ("page", page.to_string())],
    );
    let (values, next_page) = api.get_page(core, &path).await.map_err(|e| not_found_as(e, project_missing(repo)))?;
    let mut items: Vec<PrSummary> = values.iter().map(mr_summary).collect();
    let numbers: Vec<u64> = items.iter().map(|item| item.number).collect();
    let extras = parallel(numbers, |number| {
        let (core, api, repo) = (core.clone(), api.clone(), repo.clone());
        async move {
            // The list doesn't include the pipeline; the single merge request does.
            let single = mr_raw(&core, &api, &repo, number).await.ok();
            let approvals = api.get_json(&core, &format!("{}/approvals", mr_path(&repo, number))).await.ok();
            let checks = single.as_ref().and_then(|value| summarize_checks(&pipeline_checks(value)));
            let review = single.as_ref().and_then(|value| review_summary(&reviewers(value, approvals.as_ref()), approvals.as_ref()));
            (checks, review)
        }
    })
    .await;
    for (item, extra) in items.iter_mut().zip(extras) {
        if let Some((checks, review)) = extra {
            item.checks = checks;
            item.review_state = review;
        }
    }
    Ok(PrPage { items, next_page })
}

pub async fn pr_head(core: &Core, api: &Api, repo: &RepoPath, number: u64) -> CoreResult<PrSummary> {
    Ok(mr_summary(&mr_raw(core, api, repo, number).await?))
}

fn note(value: &Value) -> HostComment {
    let position = value.get("position").filter(|p| p.is_object());
    HostComment {
        id: number(value, "id").to_string(),
        author: value.get("author").and_then(user),
        body: text(value, "body"),
        created_at: text(value, "created_at"),
        path: position.and_then(|p| opt_text(p, "new_path").or_else(|| opt_text(p, "old_path"))),
        line: position.and_then(|p| p.get("new_line").and_then(Value::as_u64).or_else(|| p.get("old_line").and_then(Value::as_u64))).and_then(|n| u32::try_from(n).ok()),
    }
}

/// Comments without the system notes ("changed the title").
async fn notes(core: &Core, api: &Api, path: &str) -> CoreResult<Vec<HostComment>> {
    Ok(api.get_all(core, &format!("{path}/notes?sort=asc&per_page=100")).await?.iter().filter(|n| !flag(n, "system")).map(note).collect())
}

fn mergeable(value: &Value) -> Option<bool> {
    match opt_text(value, "detailed_merge_status").as_deref() {
        Some("mergeable") => Some(true),
        Some("checking" | "unchecked" | "preparing" | "approvals_syncing") => None,
        Some(_) => Some(false),
        None => match text(value, "merge_status").as_str() {
            "can_be_merged" => Some(true),
            "cannot_be_merged" => Some(false),
            _ => None,
        },
    }
}

pub async fn pr_get(core: &Core, api: &Api, repo: &RepoPath, number: u64) -> CoreResult<PrDetails> {
    let value = mr_raw(core, api, repo, number).await?;
    let path = mr_path(repo, number);
    let mut summary = mr_summary(&value);
    let approvals = api.get_json(core, &format!("{path}/approvals")).await.ok();
    let reviewers = reviewers(&value, approvals.as_ref());
    summary.review_state = review_summary(&reviewers, approvals.as_ref());
    let comments = notes(core, api, &path).await?;
    let commits = api
        .get_all(core, &format!("{path}/commits?per_page=100"))
        .await?
        .iter()
        .map(|c| PrCommit { sha: text(c, "id"), summary: first_line(&text(c, "title")), author_name: text(c, "author_name"), authored_at: text(c, "authored_date") })
        .collect();
    // Individual jobs of the pipeline; if they can't be read, the pipeline stays as one entry.
    let mut check_runs = pipeline_checks(&value);
    if let Some(pipeline) = value.get("head_pipeline").filter(|p| p.is_object()) {
        let project = pipeline.get("project_id").and_then(Value::as_u64).map(|id| format!("/projects/{id}")).unwrap_or_else(|| project_path(repo));
        if let Ok(jobs) = api.get_all(core, &format!("{project}/pipelines/{}/jobs?per_page=100", number_of(pipeline, "id"))).await {
            if !jobs.is_empty() {
                check_runs = jobs.iter().map(|job| PrCheck { name: text(job, "name"), state: job_state(&text(job, "status")), url: opt_text(job, "web_url") }).collect();
            }
        }
    }
    summary.checks = summarize_checks(&check_runs).or_else(|| summarize_checks(&pipeline_checks(&value)));
    let head_sha = opt_text(&value, "sha").or_else(|| value.get("diff_refs").and_then(|d| opt_text(d, "head_sha"))).unwrap_or_default();
    Ok(PrDetails { summary, body: text(&value, "description"), reviewers, comments, commits, mergeable: mergeable(&value), check_runs, head_sha })
}

fn number_of(value: &Value, key: &str) -> u64 {
    number(value, key)
}

/// User names → IDs (`GET /users?username=`); an unknown name is an error.
async fn user_ids(core: &Core, api: &Api, names: &[String]) -> CoreResult<Vec<u64>> {
    let mut ids = Vec::new();
    for name in names {
        let found = api.get_json(core, &with_query("/users", &[("username", name.clone())])).await?;
        let id = found.as_array().and_then(|users| users.first()).map(|u| number(u, "id")).filter(|id| *id > 0);
        ids.push(id.ok_or_else(|| CoreError::new(ErrorCode::HostRejected, format!("GitLab has no user “{name}”.")))?);
    }
    Ok(ids)
}

fn draft_title(title: &str, draft: bool) -> String {
    let plain = ["Draft: ", "Draft:", "[Draft]", "(Draft)", "WIP: ", "WIP:"].iter().find_map(|prefix| title.strip_prefix(prefix)).unwrap_or(title).trim_start();
    if draft {
        format!("{DRAFT_PREFIX}{plain}")
    } else {
        plain.to_string()
    }
}

fn already_exists(error: &CoreError) -> bool {
    error.code == ErrorCode::HostRejected && error.git_output.as_deref().is_some_and(|detail| detail.to_ascii_lowercase().contains("already exists"))
}

/// `POST /projects/:id/merge_requests`
pub async fn pr_create(core: &Core, api: &Api, repo: &RepoPath, new: super::github::NewPr<'_>) -> CoreResult<PrSummary> {
    let mut body = json!({
        "source_branch": new.source_branch,
        "target_branch": new.target_branch,
        "title": draft_title(new.title, new.draft),
        "description": new.body,
    });
    if !new.labels.is_empty() {
        body["labels"] = json!(new.labels.join(","));
    }
    if !new.reviewers.is_empty() {
        body["reviewer_ids"] = json!(user_ids(core, api, new.reviewers).await?);
    }
    let created: Value = api
        .send_json(core, Method::Post, &format!("{}/merge_requests", project_path(repo)), &body)
        .await
        .map_err(|e| {
            if already_exists(&e) {
                CoreError { code: ErrorCode::NameExists, message: format!("There is already an open merge request for the branch “{}”.", new.source_branch), git_output: e.git_output, retry_at: None }
            } else {
                not_found_as(e, project_missing(repo))
            }
        })?
        .json()?;
    Ok(mr_summary(&created))
}

/// `PUT /projects/:id/merge_requests/:iid`
pub async fn pr_update(core: &Core, api: &Api, repo: &RepoPath, number: u64, change: super::github::PrChange<'_>) -> CoreResult<PrSummary> {
    let mut patch = serde_json::Map::new();
    match (change.title, change.draft) {
        (Some(title), Some(draft)) => {
            patch.insert("title".into(), json!(draft_title(title, draft)));
        }
        (Some(title), None) => {
            // The draft state lives in the title and stays as it is.
            let current = mr_raw(core, api, repo, number).await?;
            let draft = flag(&current, "draft") || flag(&current, "work_in_progress");
            patch.insert("title".into(), json!(draft_title(title, draft)));
        }
        (None, Some(draft)) => {
            let current = mr_raw(core, api, repo, number).await?;
            patch.insert("title".into(), json!(draft_title(&text(&current, "title"), draft)));
        }
        (None, None) => {}
    }
    if let Some(body) = change.body {
        patch.insert("description".into(), json!(body));
    }
    if let Some(target) = change.target_branch {
        patch.insert("target_branch".into(), json!(target));
    }
    if let Some(labels) = change.labels {
        patch.insert("labels".into(), json!(labels.join(",")));
    }
    if let Some(reviewers) = change.reviewers {
        patch.insert("reviewer_ids".into(), json!(user_ids(core, api, reviewers).await?));
    }
    if patch.is_empty() {
        return pr_head(core, api, repo, number).await;
    }
    let value: Value = api.send_json(core, Method::Put, &mr_path(repo, number), &Value::Object(patch)).await.map_err(|e| not_found_as(e, mr_missing(repo, number)))?.json()?;
    Ok(mr_summary(&value))
}

/// `POST /projects/:id/merge_requests/:iid/notes`
pub async fn comment_create(core: &Core, api: &Api, repo: &RepoPath, number: u64, body: &str) -> CoreResult<HostComment> {
    let value: Value = api
        .send_json(core, Method::Post, &format!("{}/notes", mr_path(repo, number)), &json!({ "body": body }))
        .await
        .map_err(|e| not_found_as(e, mr_missing(repo, number)))?
        .json()?;
    Ok(note(&value))
}

/// `PUT /projects/:id/merge_requests/:iid/merge`. On GitLab the project decides whether a merge
/// commit is created; only squash can be chosen. There is no rebase merge method.
pub async fn pr_merge(core: &Core, api: &Api, repo: &RepoPath, number: u64, method: PrMergeMethod, delete_branch: bool) -> CoreResult<PrSummary> {
    let squash = match method {
        PrMergeMethod::Merge => false,
        PrMergeMethod::Squash => true,
        PrMergeMethod::Rebase => {
            return Err(CoreError::new(
                ErrorCode::HostUnsupported,
                "On GitLab, the project decides how merges are done (merge commit or fast-forward). You can choose “Merge” or “Squash” here.",
            ))
        }
    };
    let body = json!({ "squash": squash, "should_remove_source_branch": delete_branch });
    let value: Value = api.send_json(core, Method::Put, &format!("{}/merge", mr_path(repo, number)), &body).await.map_err(|e| not_found_as(e, mr_missing(repo, number)))?.json()?;
    Ok(mr_summary(&value))
}

/// Close or reopen via `state_event`.
pub async fn pr_set_open(core: &Core, api: &Api, repo: &RepoPath, number: u64, open: bool) -> CoreResult<PrSummary> {
    let event = if open { "reopen" } else { "close" };
    let value: Value =
        api.send_json(core, Method::Put, &mr_path(repo, number), &json!({ "state_event": event })).await.map_err(|e| not_found_as(e, mr_missing(repo, number)))?.json()?;
    Ok(mr_summary(&value))
}

/// Ref under which GitLab offers the head of a merge request.
pub fn pr_ref(number: u64) -> String {
    format!("refs/merge-requests/{number}/head")
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

fn issue_summary(value: &Value) -> IssueSummary {
    let number = number(value, "iid");
    IssueSummary {
        number,
        key: format!("#{number}"),
        title: text(value, "title"),
        state: if text(value, "state") == "closed" { IssueState::Closed } else { IssueState::Open },
        author: value.get("author").and_then(user),
        assignees: list(value, "assignees").iter().filter_map(user).collect(),
        labels: labels(value),
        updated_at: text(value, "updated_at"),
        web_url: text(value, "web_url"),
    }
}

/// `GET /projects/:id/issues` (with `search` for the search text).
pub async fn issue_list(core: &Core, api: &Api, repo: &RepoPath, state: IssueListState, query: Option<&str>, page: u32, per_page: u32) -> CoreResult<IssuePage> {
    let api_state = match state {
        IssueListState::Open => "opened",
        IssueListState::Closed => "closed",
        IssueListState::All => "all",
    };
    let mut params = vec![("state", api_state.to_string()), ("order_by", "updated_at".into()), ("sort", "desc".into()), ("per_page", per_page.to_string()), ("page", page.to_string())];
    if let Some(words) = query.map(str::trim).filter(|q| !q.is_empty()) {
        params.push(("search", words.to_string()));
    }
    let (values, next_page) = api.get_page(core, &with_query(&format!("{}/issues", project_path(repo)), &params)).await.map_err(|e| not_found_as(e, project_missing(repo)))?;
    Ok(IssuePage { items: values.iter().map(issue_summary).collect(), next_page })
}

pub async fn issue_get(core: &Core, api: &Api, repo: &RepoPath, number: u64) -> CoreResult<IssueDetails> {
    let path = format!("{}/issues/{number}", project_path(repo));
    let value = api.get_json(core, &path).await.map_err(|e| not_found_as(e, || format!("Issue #{number} does not exist in {}.", repo.full())))?;
    Ok(IssueDetails { summary: issue_summary(&value), body: text(&value, "description"), comments: notes(core, api, &path).await? })
}
