//! GitLab through the REST API v4 (`<instance>/api/v4`), documented endpoints only: `/user`,
//! `/personal_access_tokens/self`, `/projects/:id`, `…/merge_requests`, `…/issues`,
//! `…/pipelines/:id/jobs`, `/users?username=`.
//!
//! A project is addressed by its encoded path (`group%2Fsubgroup%2Fproject`).

use serde_json::{json, Value};

use super::{
    already_exists, detect, draft_as_comment, first_line, flag, host_user, list, not_found_as, number, opt_text, parallel, release_error,
    summarize_checks, text, Api, Host, HostFuture, NewPr, NewRelease, Paging, RepoFacts, RepoPath, ReviewSubmission, ReviewSubmitOutcome,
};
use crate::app::Core;
use crate::db::hoster_accounts::AccountFacts;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::http::{encode, with_query, Method};
use crate::model::{
    CheckRunState, HostCapabilities, HostComment, HostKind, HostLabel, HostRelease, HostRepoRef, HostUser, IssueDetails, IssueListState,
    IssuePage, IssueState, IssueSummary, NewReviewComment, PrCheck, PrCommit, PrDetails, PrListState, PrMergeMethod, PrPage, PrReviewState,
    PrReviewer, PrState, PrSummary, ReviewDraft, ReviewDraftOrigin, ReviewReply, ReviewSide, ReviewThread, ReviewVote,
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
    Ok(AccountFacts {
        login: Some(login),
        name: opt_text(&me, "name"),
        avatar_url: opt_text(&me, "avatar_url"),
        scopes_ok: missing.is_empty(),
        missing_scopes: missing,
    })
}

fn project_missing(repo: &RepoPath) -> impl FnOnce() -> String + '_ {
    move || format!("GitLab could not find the project {} – or the token is not allowed to see it.", repo.full())
}

/// `GET /projects/:id`. Write access requires at least the Developer role (level 30) in the
/// project or in the group.
pub async fn repo_facts(core: &Core, api: &Api, repo: &RepoPath) -> CoreResult<RepoFacts> {
    let value = api.get_json(core, &project_path(repo)).await.map_err(|e| not_found_as(e, project_missing(repo)))?;
    let level = |key: &str| value.get("permissions").and_then(|p| p.get(key)).and_then(|a| a.get("access_level")).and_then(Value::as_u64);
    let can_push =
        value.get("permissions").filter(|p| p.is_object()).map(|_| level("project_access").max(level("group_access")).unwrap_or(0) >= 30);
    let fork_parent = value.get("forked_from_project").filter(|p| p.is_object()).and_then(|parent| {
        let full = text(parent, "path_with_namespace");
        let (owner, name) = full.rsplit_once('/')?;
        Some(HostRepoRef { owner: owner.to_string(), name: name.to_string(), web_url: text(parent, "web_url") })
    });
    Ok(RepoFacts {
        default_branch: opt_text(&value, "default_branch"),
        can_push,
        fork_parent,
        has_issues: value.get("issues_enabled").and_then(Value::as_bool),
    })
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
        Some(pipeline) => {
            vec![PrCheck { name: "Pipeline".to_string(), state: job_state(&text(pipeline, "status")), url: opt_text(pipeline, "web_url") }]
        }
        None => Vec::new(),
    }
}

/// Reviewers of the merge request with their approval (`…/approvals`).
fn reviewers(value: &Value, approvals: Option<&Value>) -> Vec<PrReviewer> {
    let approved: Vec<HostUser> =
        approvals.map(|a| list(a, "approved_by").iter().filter_map(|entry| entry.get("user").and_then(user)).collect()).unwrap_or_default();
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
        &[
            ("state", api_state.to_string()),
            ("order_by", "updated_at".into()),
            ("sort", "desc".into()),
            ("per_page", per_page.to_string()),
            ("page", page.to_string()),
        ],
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
        line: position
            .and_then(|p| p.get("new_line").and_then(Value::as_u64).or_else(|| p.get("old_line").and_then(Value::as_u64)))
            .and_then(|n| u32::try_from(n).ok()),
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
        .map(|c| PrCommit {
            sha: text(c, "id"),
            summary: first_line(&text(c, "title")),
            author_name: text(c, "author_name"),
            authored_at: text(c, "authored_date"),
        })
        .collect();
    // Individual jobs of the pipeline; if they can't be read, the pipeline stays as one entry.
    let mut check_runs = pipeline_checks(&value);
    if let Some(pipeline) = value.get("head_pipeline").filter(|p| p.is_object()) {
        let project =
            pipeline.get("project_id").and_then(Value::as_u64).map(|id| format!("/projects/{id}")).unwrap_or_else(|| project_path(repo));
        if let Ok(jobs) = api.get_all(core, &format!("{project}/pipelines/{}/jobs?per_page=100", number_of(pipeline, "id"))).await {
            if !jobs.is_empty() {
                check_runs = jobs
                    .iter()
                    .map(|job| PrCheck { name: text(job, "name"), state: job_state(&text(job, "status")), url: opt_text(job, "web_url") })
                    .collect();
            }
        }
    }
    summary.checks = summarize_checks(&check_runs).or_else(|| summarize_checks(&pipeline_checks(&value)));
    let head_sha = opt_text(&value, "sha").or_else(|| value.get("diff_refs").and_then(|d| opt_text(d, "head_sha"))).unwrap_or_default();
    Ok(PrDetails {
        summary,
        body: text(&value, "description"),
        reviewers,
        comments,
        commits,
        mergeable: mergeable(&value),
        check_runs,
        head_sha,
    })
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
    let plain = ["Draft: ", "Draft:", "[Draft]", "(Draft)", "WIP: ", "WIP:"]
        .iter()
        .find_map(|prefix| title.strip_prefix(prefix))
        .unwrap_or(title)
        .trim_start();
    if draft {
        format!("{DRAFT_PREFIX}{plain}")
    } else {
        plain.to_string()
    }
}

/// `POST /projects/:id/merge_requests`
pub async fn pr_create(core: &Core, api: &Api, repo: &RepoPath, new: NewPr<'_>) -> CoreResult<PrSummary> {
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
                CoreError {
                    code: ErrorCode::NameExists,
                    message: format!("There is already an open merge request for the branch “{}”.", new.source_branch),
                    git_output: e.git_output,
                    retry_at: None,
                }
            } else {
                not_found_as(e, project_missing(repo))
            }
        })?
        .json()?;
    Ok(mr_summary(&created))
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
pub async fn pr_merge(
    core: &Core,
    api: &Api,
    repo: &RepoPath,
    number: u64,
    method: PrMergeMethod,
    delete_branch: bool,
) -> CoreResult<PrSummary> {
    let squash = match method {
        PrMergeMethod::Merge => false,
        PrMergeMethod::Squash => true,
        PrMergeMethod::Rebase => return Err(CoreError::new(
            ErrorCode::HostUnsupported,
            "On GitLab, the project decides how merges are done (merge commit or fast-forward). You can choose “Merge” or “Squash” here.",
        )),
    };
    let body = json!({ "squash": squash, "should_remove_source_branch": delete_branch });
    let value: Value = api
        .send_json(core, Method::Put, &format!("{}/merge", mr_path(repo, number)), &body)
        .await
        .map_err(|e| not_found_as(e, mr_missing(repo, number)))?
        .json()?;
    Ok(mr_summary(&value))
}

/// Close or reopen via `state_event`.
pub async fn pr_set_open(core: &Core, api: &Api, repo: &RepoPath, number: u64, open: bool) -> CoreResult<PrSummary> {
    let event = if open { "reopen" } else { "close" };
    let value: Value = api
        .send_json(core, Method::Put, &mr_path(repo, number), &json!({ "state_event": event }))
        .await
        .map_err(|e| not_found_as(e, mr_missing(repo, number)))?
        .json()?;
    Ok(mr_summary(&value))
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
pub async fn issue_list(
    core: &Core,
    api: &Api,
    repo: &RepoPath,
    state: IssueListState,
    query: Option<&str>,
    page: u32,
    per_page: u32,
) -> CoreResult<IssuePage> {
    let api_state = match state {
        IssueListState::Open => "opened",
        IssueListState::Closed => "closed",
        IssueListState::All => "all",
    };
    let mut params = vec![
        ("state", api_state.to_string()),
        ("order_by", "updated_at".into()),
        ("sort", "desc".into()),
        ("per_page", per_page.to_string()),
        ("page", page.to_string()),
    ];
    if let Some(words) = query.map(str::trim).filter(|q| !q.is_empty()) {
        params.push(("search", words.to_string()));
    }
    let (values, next_page) = api
        .get_page(core, &with_query(&format!("{}/issues", project_path(repo)), &params))
        .await
        .map_err(|e| not_found_as(e, project_missing(repo)))?;
    Ok(IssuePage { items: values.iter().map(issue_summary).collect(), next_page })
}

pub async fn issue_get(core: &Core, api: &Api, repo: &RepoPath, number: u64) -> CoreResult<IssueDetails> {
    let path = format!("{}/issues/{number}", project_path(repo));
    let value =
        api.get_json(core, &path).await.map_err(|e| not_found_as(e, || format!("Issue #{number} does not exist in {}.", repo.full())))?;
    Ok(IssueDetails { summary: issue_summary(&value), body: text(&value, "description"), comments: notes(core, api, &path).await? })
}

// ---------------------------------------------------------------------------
// Review threads (8.2)
// ---------------------------------------------------------------------------

fn position_line(position: &Value, key: &str) -> Option<u32> {
    position.get(key).and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()).filter(|n| *n > 0)
}

/// A discussion whose first note sits on a line of the diff (`DiffNote` with `position`); general
/// discussions and system notes are no review threads. Resolved: every resolvable note is resolved.
fn discussion_thread(value: &Value) -> Option<ReviewThread> {
    let notes: Vec<&Value> = list(value, "notes").iter().filter(|n| !flag(n, "system")).collect();
    let first = *notes.first()?;
    if text(first, "type") != "DiffNote" {
        return None;
    }
    let position = first.get("position").filter(|p| p.is_object())?;
    let id = opt_text(value, "id")?;
    let (side, line, path, start_key) = match (position_line(position, "new_line"), position_line(position, "old_line")) {
        (Some(new), _) => (ReviewSide::New, Some(new), opt_text(position, "new_path")?, "new_line"),
        (None, Some(old)) => (ReviewSide::Old, Some(old), opt_text(position, "old_path")?, "old_line"),
        (None, None) => (ReviewSide::New, None, opt_text(position, "new_path")?, "new_line"),
    };
    let start_line = position
        .get("line_range")
        .and_then(|r| r.get("start"))
        .and_then(|s| position_line(s, start_key))
        .filter(|start| line.is_some_and(|end| *start < end));
    let resolvable: Vec<&&Value> = notes.iter().filter(|n| flag(n, "resolvable")).collect();
    let comments = notes
        .iter()
        .map(|n| {
            let mut comment = note(n);
            comment.path = Some(path.clone());
            comment.line = line;
            comment
        })
        .collect();
    Some(ReviewThread {
        resolve_id: (!resolvable.is_empty()).then(|| id.clone()),
        id,
        path,
        line,
        start_line,
        side,
        commit: opt_text(position, "head_sha"),
        resolved: !resolvable.is_empty() && resolvable.iter().all(|n| flag(n, "resolved")),
        outdated: false,
        comments,
    })
}

/// `GET /projects/:id/merge_requests/:iid/discussions`
pub async fn review_threads(core: &Core, api: &Api, repo: &RepoPath, mr: u64) -> CoreResult<Vec<ReviewThread>> {
    let discussions = api
        .get_all(core, &format!("{}/discussions?per_page=100", mr_path(repo, mr)))
        .await
        .map_err(|e| not_found_as(e, mr_missing(repo, mr)))?;
    Ok(discussions.iter().filter_map(discussion_thread).collect())
}

/// `POST /projects/:id/merge_requests/:iid/discussions/:discussion_id/notes`
pub async fn review_reply(core: &Core, api: &Api, repo: &RepoPath, mr: u64, thread_id: &str, body: &str) -> CoreResult<ReviewReply> {
    let value: Value = api
        .send_json(core, Method::Post, &format!("{}/discussions/{}/notes", mr_path(repo, mr), encode(thread_id)), &json!({ "body": body }))
        .await
        .map_err(|e| not_found_as(e, || format!("The review thread does not exist (anymore) in merge request !{mr}.")))?
        .json()?;
    Ok(ReviewReply { comment: note(&value), quoted: false })
}

// ---------------------------------------------------------------------------
// Own review (8.3)
// ---------------------------------------------------------------------------

fn new_commits(what_next: &str) -> CoreError {
    CoreError::new(ErrorCode::StaleState, format!("The merge request has new commits. Reload and {what_next}."))
}

/// `diff_refs` of the merge request (`GET …/merge_requests/:iid`); the head must still be `expected_head`.
async fn diff_refs(core: &Core, api: &Api, repo: &RepoPath, mr: u64, expected_head: &str, what_next: &str) -> CoreResult<Value> {
    let value = mr_raw(core, api, repo, mr).await?;
    let refs = value.get("diff_refs").filter(|r| !text(r, "head_sha").is_empty()).cloned().ok_or_else(|| {
        CoreError::new(
            ErrorCode::HostRejected,
            format!("GitLab has not worked out the changes of merge request !{mr} yet. Try again in a moment."),
        )
    })?;
    if text(&refs, "head_sha") != expected_head {
        return Err(new_commits(what_next));
    }
    Ok(refs)
}

/// The documented text `position` of a comment on a line: the new side takes `new_line` (plus `old_line` on an
/// unchanged line), the old side `old_line`.
fn position(diff_refs: &Value, comment: &NewReviewComment) -> Value {
    let mut position = json!({
        "position_type": "text",
        "base_sha": diff_refs["base_sha"],
        "start_sha": diff_refs["start_sha"],
        "head_sha": diff_refs["head_sha"],
        "old_path": comment.path,
        "new_path": comment.path,
    });
    match comment.side {
        ReviewSide::New => {
            position["new_line"] = json!(comment.line);
            if let Some(old) = comment.old_line {
                position["old_line"] = json!(old);
            }
        }
        ReviewSide::Old => position["old_line"] = json!(comment.line),
    }
    position
}

/// `POST /projects/:id/merge_requests/:iid/discussions` – a new discussion on a line of the diff.
pub async fn review_comment_create(core: &Core, api: &Api, repo: &RepoPath, mr: u64, comment: &NewReviewComment) -> CoreResult<()> {
    let refs = diff_refs(core, api, repo, mr, &comment.commit, "comment again").await?;
    let body = json!({ "body": comment.body, "position": position(&refs, comment) });
    api.send_json(core, Method::Post, &format!("{}/discussions", mr_path(repo, mr)), &body)
        .await
        .map_err(|e| not_found_as(e, mr_missing(repo, mr)))?;
    Ok(())
}

/// `PUT /projects/:id/merge_requests/:iid/discussions/:discussion_id` with `resolved`.
pub async fn review_thread_set_resolved(
    core: &Core,
    api: &Api,
    repo: &RepoPath,
    mr: u64,
    resolve_id: &str,
    resolved: bool,
) -> CoreResult<()> {
    let path = format!("{}/discussions/{}", mr_path(repo, mr), encode(resolve_id));
    api.send_json(core, Method::Put, &path, &json!({ "resolved": resolved }))
        .await
        .map_err(|e| not_found_as(e, || "The review thread does not exist (anymore). Reload the merge request.".to_string()))?;
    Ok(())
}

/// The token user's draft notes on lines, `GET …/merge_requests/:iid/draft_notes`; general ones are left out.
pub async fn review_host_drafts(core: &Core, api: &Api, repo: &RepoPath, mr: u64) -> CoreResult<Vec<ReviewDraft>> {
    let notes = api
        .get_all(core, &format!("{}/draft_notes?per_page=100", mr_path(repo, mr)))
        .await
        .map_err(|e| not_found_as(e, mr_missing(repo, mr)))?;
    Ok(notes
        .iter()
        .filter_map(|n| {
            let position = n.get("position").filter(|p| p.is_object())?;
            let (new, old) = (position_line(position, "new_line"), position_line(position, "old_line"));
            let path = if new.is_some() { opt_text(position, "new_path") } else { opt_text(position, "old_path") }?;
            Some(ReviewDraft {
                id: number(n, "id").to_string(),
                origin: ReviewDraftOrigin::Host,
                path,
                line: new.or(old),
                start_line: None,
                side: if new.is_none() && old.is_some() { ReviewSide::Old } else { ReviewSide::New },
                old_line: new.and(old),
                commit: opt_text(position, "head_sha"),
                body: text(n, "note"),
                error: None,
            })
        })
        .collect())
}

/// Each local draft becomes a draft note (`POST …/draft_notes`); only when all arrived: `bulk_publish` (which
/// also publishes the draft notes started in the browser), the text as a note, then the approval with the
/// head as `sha`. Once a draft note exists at GitLab every error goes into the outcome, so the sent drafts are
/// dropped locally and not posted twice.
pub async fn review_submit(
    core: &Core,
    api: &Api,
    repo: &RepoPath,
    mr: u64,
    submission: ReviewSubmission<'_>,
) -> CoreResult<ReviewSubmitOutcome> {
    let refs = diff_refs(core, api, repo, mr, submission.commit, "send the review again").await?;
    let path = mr_path(repo, mr);
    let not_found = |e| not_found_as(e, mr_missing(repo, mr));
    let mut outcome = ReviewSubmitOutcome::default();
    for draft in submission.drafts {
        // Its line numbers belong to another head; GitLab would put it on the wrong line.
        if draft.commit.as_deref() != Some(submission.commit) {
            let message = "The merge request has new commits since this comment was written. Check the line and save the comment again.";
            outcome.failed.push((draft.id.clone(), message.to_string()));
            continue;
        }
        let body = json!({ "note": draft.body, "position": position(&refs, &draft_as_comment(draft)) });
        match api.send_json(core, Method::Post, &format!("{path}/draft_notes"), &body).await {
            Ok(_) => outcome.sent.push(draft.id.clone()),
            Err(error) => outcome.failed.push((draft.id.clone(), error.message)),
        }
    }
    if !outcome.failed.is_empty() {
        return Ok(outcome);
    }
    let finish = async {
        api.send_json(core, Method::Post, &format!("{path}/draft_notes/bulk_publish"), &json!({})).await?;
        if !submission.body.trim().is_empty() {
            comment_create(core, api, repo, mr, submission.body).await?;
        }
        if submission.vote == ReviewVote::Approve {
            api.send_json(core, Method::Post, &format!("{path}/approve"), &json!({ "sha": submission.commit })).await?;
        }
        CoreResult::Ok(())
    };
    match finish.await {
        Ok(()) => outcome.submitted = true,
        Err(error) => outcome.error = Some(not_found(error)),
    }
    Ok(outcome)
}

// ---------------------------------------------------------------------------
// As a `Host`
// ---------------------------------------------------------------------------

pub struct GitlabHost;

/// `POST /projects/:id/releases`. `ref` is only used when the tag does not exist on GitLab yet;
/// GitLab has no pre-release flag.
pub async fn release_create(core: &Core, api: &Api, repo: &RepoPath, new: NewRelease<'_>) -> CoreResult<HostRelease> {
    let body = json!({ "tag_name": new.tag, "ref": new.target_sha, "name": new.name, "description": new.body });
    let created: Value = api
        .send_json(core, Method::Post, &format!("{}/releases", project_path(repo)), &body)
        .await
        .map_err(|e| release_error(e, new.tag, project_missing(repo)))?
        .json()?;
    let web_url = created.get("_links").and_then(|links| opt_text(links, "self"));
    Ok(HostRelease { tag: text(&created, "tag_name"), name: text(&created, "name"), web_url })
}

impl Host for GitlabHost {
    fn kind(&self) -> HostKind {
        HostKind::Gitlab
    }
    fn label(&self) -> &'static str {
        "GitLab"
    }
    fn pr_word(&self) -> &'static str {
        "merge request"
    }
    fn public_web(&self) -> Option<&'static str> {
        Some(detect::GITLAB_WEB)
    }
    fn public_hosts(&self) -> &'static [&'static str] {
        &["gitlab.com", "www.gitlab.com"]
    }
    fn api_base(&self, web_base: &str) -> String {
        format!("{web_base}/api/v4")
    }
    fn api_suffixes(&self) -> &'static [&'static str] {
        &["api/v4"]
    }
    fn request_headers(&self) -> &'static [(&'static str, &'static str)] {
        &[("accept", "application/json")]
    }
    /// Groups can be nested arbitrarily deep: everything before the last segment is the owner.
    fn split_repo_path(&self, path: &str) -> Option<RepoPath> {
        let (owner, name) = path.rsplit_once('/')?;
        (!owner.is_empty() && !name.is_empty()).then(|| RepoPath { owner: owner.to_string(), name: name.to_string() })
    }
    fn capabilities(&self) -> HostCapabilities {
        HostCapabilities {
            issues: true,
            issue_create: false,
            draft_prs: true,
            draft_toggle: true,
            merge_methods: vec![PrMergeMethod::Merge, PrMergeMethod::Squash],
            delete_source_branch: true,
            pr_reopen: true,
            pr_reviewers: true,
            pr_labels: true,
            fork_checkout: true,
            releases: true,
            review_comment: true,
            review_comment_range: false,
            review_resolve: true,
            review_submit_batch: true,
            review_approve: true,
            review_request_changes: false,
            review_vote_own_pr: false,
            review_threads: true,
            review_reply: true,
            review_reply_quotes: false,
        }
    }
    fn pr_ref(&self, number: u64) -> Option<String> {
        Some(format!("refs/merge-requests/{number}/head"))
    }
    fn fork_branch(&self, number: u64) -> String {
        format!("mr-{number}")
    }
    fn template_folders(&self) -> &'static [&'static str] {
        &[".gitlab"]
    }
    fn account_facts<'a>(&'a self, core: &'a Core, api: &'a Api) -> HostFuture<'a, AccountFacts> {
        Box::pin(account_facts(core, api))
    }
    fn repo_facts<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath) -> HostFuture<'a, RepoFacts> {
        Box::pin(repo_facts(core, api, repo))
    }
    fn pr_list<'a>(
        &'a self,
        core: &'a Core,
        api: &'a Api,
        repo: &'a RepoPath,
        state: PrListState,
        paging: Paging,
    ) -> HostFuture<'a, PrPage> {
        Box::pin(pr_list(core, api, repo, state, paging.page, paging.per_page))
    }
    fn pr_get<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath, number: u64) -> HostFuture<'a, PrDetails> {
        Box::pin(pr_get(core, api, repo, number))
    }
    fn pr_head<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath, number: u64) -> HostFuture<'a, PrSummary> {
        Box::pin(pr_head(core, api, repo, number))
    }
    fn issue_list<'a>(
        &'a self,
        core: &'a Core,
        api: &'a Api,
        repo: &'a RepoPath,
        state: IssueListState,
        query: Option<&'a str>,
        paging: Paging,
    ) -> HostFuture<'a, IssuePage> {
        Box::pin(issue_list(core, api, repo, state, query, paging.page, paging.per_page))
    }
    fn issue_get<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath, number: u64) -> HostFuture<'a, IssueDetails> {
        Box::pin(issue_get(core, api, repo, number))
    }
    fn pr_create<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath, new: NewPr<'a>) -> HostFuture<'a, PrSummary> {
        Box::pin(pr_create(core, api, repo, new))
    }
    fn pr_comment<'a>(
        &'a self,
        core: &'a Core,
        api: &'a Api,
        repo: &'a RepoPath,
        number: u64,
        body: &'a str,
    ) -> HostFuture<'a, HostComment> {
        Box::pin(comment_create(core, api, repo, number, body))
    }
    fn pr_merge<'a>(
        &'a self,
        core: &'a Core,
        api: &'a Api,
        repo: &'a RepoPath,
        number: u64,
        method: PrMergeMethod,
        delete_branch: bool,
    ) -> HostFuture<'a, PrSummary> {
        Box::pin(pr_merge(core, api, repo, number, method, delete_branch))
    }
    fn pr_set_open<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath, number: u64, open: bool) -> HostFuture<'a, PrSummary> {
        Box::pin(pr_set_open(core, api, repo, number, open))
    }

    fn release_create<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath, new: NewRelease<'a>) -> HostFuture<'a, HostRelease> {
        Box::pin(release_create(core, api, repo, new))
    }
    fn review_threads<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath, number: u64) -> HostFuture<'a, Vec<ReviewThread>> {
        Box::pin(review_threads(core, api, repo, number))
    }
    fn review_reply<'a>(
        &'a self,
        core: &'a Core,
        api: &'a Api,
        repo: &'a RepoPath,
        number: u64,
        thread_id: &'a str,
        body: &'a str,
    ) -> HostFuture<'a, ReviewReply> {
        Box::pin(review_reply(core, api, repo, number, thread_id, body))
    }
    fn review_comment_create<'a>(
        &'a self,
        core: &'a Core,
        api: &'a Api,
        repo: &'a RepoPath,
        number: u64,
        comment: &'a NewReviewComment,
    ) -> HostFuture<'a, ()> {
        Box::pin(review_comment_create(core, api, repo, number, comment))
    }
    fn review_thread_set_resolved<'a>(
        &'a self,
        core: &'a Core,
        api: &'a Api,
        repo: &'a RepoPath,
        number: u64,
        resolve_id: &'a str,
        resolved: bool,
    ) -> HostFuture<'a, ()> {
        Box::pin(review_thread_set_resolved(core, api, repo, number, resolve_id, resolved))
    }
    fn review_submit<'a>(
        &'a self,
        core: &'a Core,
        api: &'a Api,
        repo: &'a RepoPath,
        number: u64,
        submission: ReviewSubmission<'a>,
    ) -> HostFuture<'a, ReviewSubmitOutcome> {
        Box::pin(review_submit(core, api, repo, number, submission))
    }
    fn review_host_drafts<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath, number: u64) -> HostFuture<'a, Vec<ReviewDraft>> {
        Box::pin(review_host_drafts(core, api, repo, number))
    }
}
