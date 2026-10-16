//! Azure DevOps Services (`https://dev.azure.com/<organization>`) through the REST API 7.1,
//! documented endpoints only: `_apis/connectionData`, `_apis/projects`,
//! `{project}/_apis/git/repositories/{repo}`, `…/pullrequests`, `…/pullrequests/{id}/statuses|threads|commits|labels`,
//! `{project}/_apis/wit/wiql`, `{project}/_apis/wit/workitems`, `…/workItems/{id}/comments`.
//!
//! An account belongs to one organization (its address, which is also the API address). In a
//! repository, `owner` is the project and `name` the repository. "Issues" are work items.
//! Sign-in: personal access token via Basic authentication with an empty user name.

use base64::Engine;
use serde_json::{json, Value};

use super::{
    already_exists, detect, first_line, flag, host_user, list, not_found_as, number, opt_text, parallel, review_summary, summarize_checks, text, Api, Host, HostFuture,
    NewPr, Paging, PrChange, RepoFacts, RepoPath,
};
use crate::app::Core;
use crate::db::hoster_accounts::AccountFacts;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::http::{encode, with_query, Method};
use crate::model::{
    CheckRunState, HostCapabilities, HostComment, HostKind, HostLabel, HostRepoRef, HostUser, IssueDetails, IssueListState, IssuePage, IssueState, IssueSummary, PrCheck,
    PrCommit, PrDetails, PrListState, PrMergeMethod, PrPage, PrReviewState, PrReviewer, PrState, PrSummary,
};

pub const AZURE_WEB: &str = "https://dev.azure.com";
const LABEL: &str = "Azure DevOps";
const VERSION: &str = "7.1";

/// `path?api-version=7.1&…`
fn v(path: &str, params: &[(&str, String)]) -> String {
    let mut all: Vec<(&str, String)> = vec![("api-version", VERSION.to_string())];
    all.extend(params.iter().cloned());
    with_query(path, &all)
}

fn repo_path(repo: &RepoPath) -> String {
    format!("/{}/_apis/git/repositories/{}", encode(&repo.owner), encode(&repo.name))
}

fn pr_path(repo: &RepoPath, number: u64) -> String {
    format!("{}/pullrequests/{number}", repo_path(repo))
}

fn repo_web(api: &Api, repo: &RepoPath) -> String {
    AzureHost.repo_web_url(&api.web_base, repo)
}

/// An identity (`createdBy`, reviewer, author): the unique name is the login.
fn identity(value: &Value) -> Option<HostUser> {
    if !value.is_object() {
        return None;
    }
    let login = opt_text(value, "uniqueName").unwrap_or_else(|| text(value, "displayName"));
    host_user(login, opt_text(value, "displayName"), opt_text(value, "imageUrl"))
}

fn structure() -> CoreError {
    CoreError::unknown(format!("The response from {LABEL} could not be read (unexpected structure)."))
}

/// The entries of `{ count, value: [...] }`.
fn values_of(value: Value) -> CoreResult<Vec<Value>> {
    match value {
        Value::Object(mut map) => match map.remove("value") {
            Some(Value::Array(items)) => Ok(items),
            _ => Err(structure()),
        },
        _ => Err(structure()),
    }
}

fn missing_repo(repo: &RepoPath) -> impl FnOnce() -> String + '_ {
    move || format!("{LABEL} could not find the repository {} – or the token is not allowed to see it.", repo.full())
}

fn pr_not_found(repo: &RepoPath, number: u64) -> impl FnOnce() -> String + '_ {
    move || format!("Pull request #{number} does not exist in {}.", repo.full())
}

/// A name of letters, digits, `-`, `_`, `.` – what Azure DevOps allows for an organization.
fn is_organization(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

// ---------------------------------------------------------------------------
// Account and repository
// ---------------------------------------------------------------------------

/// `GET {org}/_apis/connectionData` (who signed in), then `GET {org}/_apis/projects?$top=1`: the
/// token must be valid for this organization's projects, not only for the sign-in.
pub async fn account_facts(core: &Core, api: &Api) -> CoreResult<AccountFacts> {
    let data = api.get_json(core, "/_apis/connectionData").await?;
    let no_user = || CoreError::unknown(format!("The response from {LABEL} could not be read (no user)."));
    let me = data.get("authenticatedUser").filter(|u| u.is_object()).ok_or_else(no_user)?;
    let login = me.get("properties").and_then(|p| p.get("Account")).and_then(|a| opt_text(a, "$value")).or_else(|| opt_text(me, "providerDisplayName")).ok_or_else(no_user)?;
    api.get_json(core, &v("/_apis/projects", &[("$top", "1".to_string())])).await?;
    Ok(AccountFacts { login: Some(login), name: opt_text(me, "providerDisplayName"), avatar_url: None, scopes_ok: true, missing_scopes: Vec::new() })
}

/// `GET {project}/_apis/git/repositories/{repo}`. Azure does not say whether the token may push.
pub async fn repo_facts(core: &Core, api: &Api, repo: &RepoPath) -> CoreResult<RepoFacts> {
    let value = api.get_json(core, &v(&repo_path(repo), &[])).await.map_err(|e| not_found_as(e, missing_repo(repo)))?;
    let fork_parent = value.get("parentRepository").filter(|p| p.is_object()).and_then(|parent| {
        let project = parent.get("project").map(|p| text(p, "name")).unwrap_or_default();
        let name = text(parent, "name");
        if project.is_empty() || name.is_empty() {
            return None;
        }
        let parent_repo = RepoPath { owner: project, name };
        Some(HostRepoRef { web_url: repo_web(api, &parent_repo), owner: parent_repo.owner, name: parent_repo.name })
    });
    let default_branch = opt_text(&value, "defaultBranch").map(|branch| branch_name(&branch));
    Ok(RepoFacts { default_branch, can_push: None, fork_parent, has_issues: Some(true) })
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

fn branch_name(reference: &str) -> String {
    reference.strip_prefix("refs/heads/").unwrap_or(reference).to_string()
}

fn pr_state(value: &Value) -> PrState {
    match text(value, "status").as_str() {
        "completed" => PrState::Merged,
        "abandoned" => PrState::Closed,
        _ => PrState::Open,
    }
}

/// Votes: 10 approved, 5 approved with suggestions, 0 none, -5 waiting for the author, -10 rejected.
fn vote_state(vote: i64) -> Option<PrReviewState> {
    match vote {
        5 | 10 => Some(PrReviewState::Approved),
        -5 | -10 => Some(PrReviewState::ChangesRequested),
        _ => None,
    }
}

fn reviewers(value: &Value) -> Vec<PrReviewer> {
    list(value, "reviewers").iter().filter_map(|r| identity(r).map(|user| PrReviewer { user, state: vote_state(r.get("vote").and_then(Value::as_i64).unwrap_or(0)) })).collect()
}

/// The list already carries the reviewers with their votes.
fn pr_summary(web: &str, value: &Value) -> PrSummary {
    let number = number(value, "pullRequestId");
    PrSummary {
        number,
        title: text(value, "title"),
        state: pr_state(value),
        is_draft: flag(value, "isDraft"),
        author: value.get("createdBy").and_then(identity),
        source_branch: branch_name(&text(value, "sourceRefName")),
        target_branch: branch_name(&text(value, "targetRefName")),
        updated_at: opt_text(value, "closedDate").unwrap_or_else(|| text(value, "creationDate")),
        web_url: format!("{web}/pullrequest/{number}"),
        checks: None,
        review_state: review_summary(&reviewers(value)),
        labels: list(value, "labels")
            .iter()
            .filter(|label| label.get("active").and_then(Value::as_bool).unwrap_or(true))
            .filter_map(|label| opt_text(label, "name").map(|name| HostLabel { name, color: None }))
            .collect(),
        is_fork: value.get("forkSource").is_some_and(Value::is_object),
    }
}

fn mergeable(value: &Value) -> Option<bool> {
    match text(value, "mergeStatus").as_str() {
        "succeeded" => Some(true),
        "conflicts" | "failure" | "rejectedByPolicy" => Some(false),
        // queued, notSet: still computing
        _ => None,
    }
}

fn status_state(state: &str) -> CheckRunState {
    match state {
        "succeeded" => CheckRunState::Passing,
        "pending" | "notSet" => CheckRunState::Pending,
        "notApplicable" => CheckRunState::Skipped,
        _ => CheckRunState::Failing,
    }
}

/// Statuses posted to the pull request (`…/statuses`); a later status of the same context wins.
async fn checks(core: &Core, api: &Api, repo: &RepoPath, number: u64) -> CoreResult<Vec<PrCheck>> {
    let statuses = values_of(api.get_json(core, &v(&format!("{}/statuses", pr_path(repo, number)), &[])).await?)?;
    let mut checks: Vec<PrCheck> = Vec::new();
    for status in &statuses {
        let context = status.get("context").cloned().unwrap_or(Value::Null);
        let (genre, name) = (text(&context, "genre"), text(&context, "name"));
        let name = if genre.is_empty() { name } else { format!("{genre}/{name}") };
        let check = PrCheck { name, state: status_state(&text(status, "state")), url: opt_text(status, "targetUrl") };
        match checks.iter_mut().find(|known| known.name == check.name) {
            Some(known) => *known = check,
            None => checks.push(check),
        }
    }
    Ok(checks)
}

/// `GET …/pullrequests?searchCriteria.status=…&$top=…&$skip=…`, one more than the page to know
/// whether another follows; plus the statuses per entry (in parallel).
pub async fn pr_list(core: &Core, api: &Api, repo: &RepoPath, state: PrListState, paging: Paging) -> CoreResult<PrPage> {
    let status = match state {
        PrListState::Open => "active",
        PrListState::Merged => "completed",
        PrListState::Closed => "abandoned",
        PrListState::All => "all",
    };
    let skip = (paging.page - 1) * paging.per_page;
    let path = v(&format!("{}/pullrequests", repo_path(repo)), &[("searchCriteria.status", status.to_string()), ("$top", (paging.per_page + 1).to_string()), ("$skip", skip.to_string())]);
    let mut values = values_of(api.get_json(core, &path).await.map_err(|e| not_found_as(e, missing_repo(repo)))?)?;
    let more = values.len() > paging.per_page as usize;
    values.truncate(paging.per_page as usize);
    let web = repo_web(api, repo);
    let mut items: Vec<PrSummary> = values.iter().map(|value| pr_summary(&web, value)).collect();
    let numbers: Vec<u64> = items.iter().map(|item| item.number).collect();
    let extras = parallel(numbers, |number| {
        let (core, api, repo) = (core.clone(), api.clone(), repo.clone());
        async move { checks(&core, &api, &repo, number).await.ok().and_then(|c| summarize_checks(&c)) }
    })
    .await;
    for (item, checks) in items.iter_mut().zip(extras) {
        item.checks = checks.flatten();
    }
    Ok(PrPage { items, next_page: more.then_some(paging.page + 1) })
}

async fn pr_raw(core: &Core, api: &Api, repo: &RepoPath, number: u64) -> CoreResult<Value> {
    api.get_json(core, &v(&pr_path(repo, number), &[])).await.map_err(|e| not_found_as(e, pr_not_found(repo, number)))
}

pub async fn pr_head(core: &Core, api: &Api, repo: &RepoPath, number: u64) -> CoreResult<PrSummary> {
    Ok(pr_summary(&repo_web(api, repo), &pr_raw(core, api, repo, number).await?))
}

/// The comments of all threads, without system notes ("policy status updated").
fn thread_comments(threads: &[Value]) -> Vec<HostComment> {
    let mut comments: Vec<HostComment> = Vec::new();
    for thread in threads.iter().filter(|t| !flag(t, "isDeleted")) {
        let context = thread.get("threadContext").filter(|c| c.is_object());
        let path = context.and_then(|c| opt_text(c, "filePath")).map(|p| p.trim_start_matches('/').to_string());
        let line = context.and_then(|c| c.get("rightFileStart")).and_then(|s| s.get("line")).and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok());
        for entry in list(thread, "comments").iter().filter(|c| text(c, "commentType") != "system" && !flag(c, "isDeleted")) {
            comments.push(HostComment {
                id: format!("{}-{}", number(thread, "id"), number(entry, "id")),
                author: entry.get("author").and_then(identity),
                body: text(entry, "content"),
                created_at: text(entry, "publishedDate"),
                path: path.clone(),
                line,
            });
        }
    }
    comments.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    comments
}

pub async fn pr_get(core: &Core, api: &Api, repo: &RepoPath, number: u64) -> CoreResult<PrDetails> {
    let value = pr_raw(core, api, repo, number).await?;
    let path = pr_path(repo, number);
    let summary_base = repo_web(api, repo);
    let mut summary = pr_summary(&summary_base, &value);
    let reviewers = reviewers(&value);
    let threads = values_of(api.get_json(core, &v(&format!("{path}/threads"), &[])).await?)?;
    let commits = values_of(api.get_json(core, &v(&format!("{path}/commits"), &[])).await?)?
        .iter()
        .map(|c| {
            let author = c.get("author").cloned().unwrap_or(Value::Null);
            PrCommit { sha: text(c, "commitId"), summary: first_line(&text(c, "comment")), author_name: text(&author, "name"), authored_at: text(&author, "date") }
        })
        .collect();
    let check_runs = checks(core, api, repo, number).await.unwrap_or_default();
    summary.checks = summarize_checks(&check_runs);
    let head_sha = value.get("lastMergeSourceCommit").map(|c| text(c, "commitId")).unwrap_or_default();
    Ok(PrDetails { summary, body: text(&value, "description"), reviewers, comments: thread_comments(&threads), commits, mergeable: mergeable(&value), check_runs, head_sha })
}

// ---------------------------------------------------------------------------
// Writing pull requests
// ---------------------------------------------------------------------------

fn no_reviewers() -> CoreError {
    CoreError::new(ErrorCode::HostUnsupported, "On Azure DevOps, reviewers are added on the website (the API needs their identity IDs).")
}

fn heads(branch: &str) -> String {
    format!("refs/heads/{branch}")
}

/// `POST …/pullrequests` (labels by name in the same call).
pub async fn pr_create(core: &Core, api: &Api, repo: &RepoPath, new: NewPr<'_>) -> CoreResult<PrSummary> {
    if !new.reviewers.is_empty() {
        return Err(no_reviewers());
    }
    let mut body = json!({ "sourceRefName": heads(new.source_branch), "targetRefName": heads(new.target_branch), "title": new.title, "description": new.body, "isDraft": new.draft });
    if !new.labels.is_empty() {
        body["labels"] = json!(new.labels.iter().map(|name| json!({ "name": name })).collect::<Vec<_>>());
    }
    let created: Value = api
        .send_json(core, Method::Post, &v(&format!("{}/pullrequests", repo_path(repo)), &[]), &body)
        .await
        .map_err(|e| {
            if already_exists(&e) {
                CoreError { code: ErrorCode::NameExists, message: format!("There is already an open pull request for the branch “{}”.", new.source_branch), git_output: e.git_output, retry_at: None }
            } else {
                not_found_as(e, missing_repo(repo))
            }
        })?
        .json()?;
    Ok(pr_summary(&repo_web(api, repo), &created))
}

/// `PATCH …/pullrequests/{id}` for title, description, target and draft; labels through `…/labels`.
pub async fn pr_update(core: &Core, api: &Api, repo: &RepoPath, number: u64, change: PrChange<'_>) -> CoreResult<PrSummary> {
    if change.reviewers.is_some_and(|r| !r.is_empty()) {
        return Err(no_reviewers());
    }
    let mut patch = serde_json::Map::new();
    if let Some(title) = change.title {
        patch.insert("title".into(), json!(title));
    }
    if let Some(body) = change.body {
        patch.insert("description".into(), json!(body));
    }
    if let Some(target) = change.target_branch {
        patch.insert("targetRefName".into(), json!(heads(target)));
    }
    if let Some(draft) = change.draft {
        patch.insert("isDraft".into(), json!(draft));
    }
    if !patch.is_empty() {
        api.send_json(core, Method::Patch, &v(&pr_path(repo, number), &[]), &Value::Object(patch)).await.map_err(|e| not_found_as(e, pr_not_found(repo, number)))?;
    }
    if let Some(wanted) = change.labels {
        let current = pr_raw(core, api, repo, number).await?;
        let have: Vec<String> = list(&current, "labels").iter().filter(|l| l.get("active").and_then(Value::as_bool).unwrap_or(true)).map(|l| text(l, "name")).collect();
        let labels = format!("{}/labels", pr_path(repo, number));
        for name in wanted.iter().filter(|w| !have.iter().any(|h| h.eq_ignore_ascii_case(w))) {
            api.send_json(core, Method::Post, &v(&labels, &[]), &json!({ "name": name })).await?;
        }
        for name in have.iter().filter(|h| !wanted.iter().any(|w| w.eq_ignore_ascii_case(h))) {
            api.delete(core, &v(&format!("{labels}/{}", encode(name)), &[])).await?;
        }
    }
    pr_head(core, api, repo, number).await
}

/// A new thread with one comment (`POST …/threads`, status "active").
pub async fn comment_create(core: &Core, api: &Api, repo: &RepoPath, number: u64, body: &str) -> CoreResult<HostComment> {
    let thread: Value = api
        .send_json(core, Method::Post, &v(&format!("{}/threads", pr_path(repo, number)), &[]), &json!({ "comments": [{ "parentCommentId": 0, "content": body, "commentType": 1 }], "status": 1 }))
        .await
        .map_err(|e| not_found_as(e, pr_not_found(repo, number)))?
        .json()?;
    thread_comments(std::slice::from_ref(&thread)).into_iter().next().ok_or_else(structure)
}

/// Completing = `PATCH status=completed` with the commit the pull request currently points to (Azure
/// refuses if it moved in the meantime) and the merge strategy.
pub async fn pr_merge(core: &Core, api: &Api, repo: &RepoPath, number: u64, method: PrMergeMethod, delete_branch: bool) -> CoreResult<PrSummary> {
    let current = pr_raw(core, api, repo, number).await?;
    let commit = current.get("lastMergeSourceCommit").map(|c| text(c, "commitId")).unwrap_or_default();
    let strategy = match method {
        PrMergeMethod::Merge => "noFastForward",
        PrMergeMethod::Squash => "squash",
        PrMergeMethod::Rebase => "rebase",
    };
    let body = json!({ "status": "completed", "lastMergeSourceCommit": { "commitId": commit }, "completionOptions": { "mergeStrategy": strategy, "deleteSourceBranch": delete_branch } });
    let value: Value = api.send_json(core, Method::Patch, &v(&pr_path(repo, number), &[]), &body).await.map_err(|e| not_found_as(e, pr_not_found(repo, number)))?.json()?;
    Ok(pr_summary(&repo_web(api, repo), &value))
}

/// Abandon or reactivate: `PATCH status`.
pub async fn pr_set_open(core: &Core, api: &Api, repo: &RepoPath, number: u64, open: bool) -> CoreResult<PrSummary> {
    let status = if open { "active" } else { "abandoned" };
    let value: Value = api.send_json(core, Method::Patch, &v(&pr_path(repo, number), &[]), &json!({ "status": status })).await.map_err(|e| not_found_as(e, pr_not_found(repo, number)))?.json()?;
    Ok(pr_summary(&repo_web(api, repo), &value))
}

// ---------------------------------------------------------------------------
// Work items ("issues")
// ---------------------------------------------------------------------------

/// Work item states that count as closed (Basic, Agile, Scrum and CMMI processes).
const CLOSED_STATES: [&str; 5] = ["Closed", "Done", "Removed", "Resolved", "Completed"];
/// The fields a list entry needs.
const FIELDS: &str = "System.Id,System.Title,System.State,System.CreatedBy,System.AssignedTo,System.ChangedDate,System.Tags,System.WorkItemType";
/// WIQL returns at most this many IDs.
const MAX_WIQL: usize = 20_000;

fn project_path(repo: &RepoPath) -> String {
    format!("/{}", encode(&repo.owner))
}

/// A WIQL string literal: `'` doubled, so search text can never end the literal.
fn wiql_text(words: &str) -> String {
    words.replace('\'', "''")
}

/// The query: work items of the project, by state, optionally with search text, most recently changed first.
fn wiql(state: IssueListState, words: Option<&str>) -> String {
    let closed = CLOSED_STATES.iter().map(|s| format!("'{s}'")).collect::<Vec<_>>().join(", ");
    let mut query = String::from("SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project");
    match state {
        IssueListState::Open => query.push_str(&format!(" AND [System.State] NOT IN ({closed})")),
        IssueListState::Closed => query.push_str(&format!(" AND [System.State] IN ({closed})")),
        IssueListState::All => {}
    }
    if let Some(words) = words.map(str::trim).filter(|w| !w.is_empty()) {
        let quoted = wiql_text(words);
        query.push_str(&format!(" AND ([System.Title] CONTAINS '{quoted}' OR [System.Description] CONTAINS WORDS '{quoted}')"));
    }
    query.push_str(" ORDER BY [System.ChangedDate] DESC");
    query
}

fn work_item_url(api: &Api, repo: &RepoPath, number: u64) -> String {
    format!("{}/{}/_workitems/edit/{number}", api.web_base, encode(&repo.owner))
}

fn work_item_summary(api: &Api, repo: &RepoPath, item: &Value) -> IssueSummary {
    let fields = item.get("fields").cloned().unwrap_or(Value::Null);
    let number = number(item, "id");
    let state = text(&fields, "System.State");
    let kind = text(&fields, "System.WorkItemType");
    let tags = text(&fields, "System.Tags");
    IssueSummary {
        number,
        key: format!("#{number}"),
        title: text(&fields, "System.Title"),
        state: if CLOSED_STATES.contains(&state.as_str()) { IssueState::Closed } else { IssueState::Open },
        author: fields.get("System.CreatedBy").and_then(identity),
        assignees: fields.get("System.AssignedTo").and_then(identity).into_iter().collect(),
        // The type first ("Issue", "Bug"), then the tags.
        labels: std::iter::once(kind).chain(tags.split(';').map(|tag| tag.trim().to_string())).filter(|name| !name.is_empty()).map(|name| HostLabel { name, color: None }).collect(),
        updated_at: text(&fields, "System.ChangedDate"),
        web_url: work_item_url(api, repo, number),
    }
}

/// Reads the work items in one call and keeps the order of `ids` (the API answers in its own).
async fn work_items(core: &Core, api: &Api, repo: &RepoPath, ids: &[u64]) -> CoreResult<Vec<IssueSummary>> {
    let joined = ids.iter().map(u64::to_string).collect::<Vec<_>>().join(",");
    let value = api.get_json(core, &v(&format!("{}/_apis/wit/workitems", project_path(repo)), &[("ids", joined), ("fields", FIELDS.to_string())])).await?;
    let mut items: Vec<IssueSummary> = values_of(value)?.iter().map(|item| work_item_summary(api, repo, item)).collect();
    items.sort_by_key(|item| ids.iter().position(|id| *id == item.number).unwrap_or(usize::MAX));
    Ok(items)
}

fn missing_project(repo: &RepoPath) -> impl FnOnce() -> String + '_ {
    move || format!("{LABEL} could not find the project {} – or the token is not allowed to see its work items.", repo.owner)
}

/// WIQL for the IDs (as many as this page needs plus one), then the page in one batch.
pub async fn issue_list(core: &Core, api: &Api, repo: &RepoPath, state: IssueListState, query: Option<&str>, paging: Paging) -> CoreResult<IssuePage> {
    let start = ((paging.page - 1) * paging.per_page) as usize;
    let wanted = (start + paging.per_page as usize + 1).min(MAX_WIQL);
    let found: Value = api
        .send_json(core, Method::Post, &v(&format!("{}/_apis/wit/wiql", project_path(repo)), &[("$top", wanted.to_string())]), &json!({ "query": wiql(state, query) }))
        .await
        .map_err(|e| not_found_as(e, missing_project(repo)))?
        .json()?;
    let Some(entries) = found.get("workItems").and_then(Value::as_array) else {
        return Err(structure());
    };
    let ids: Vec<u64> = entries.iter().map(|w| number(w, "id")).filter(|id| *id > 0).collect();
    let page_ids: Vec<u64> = ids.iter().copied().skip(start).take(paging.per_page as usize).collect();
    let next_page = (ids.len() > start + page_ids.len()).then_some(paging.page + 1);
    if page_ids.is_empty() {
        return Ok(IssuePage { items: Vec::new(), next_page: None });
    }
    Ok(IssuePage { items: work_items(core, api, repo, &page_ids).await?, next_page })
}

/// The work item with its comments (the comments API is still a preview in 7.1). Description and
/// comments are HTML; the UI sanitises them like any Markdown from a host.
pub async fn issue_get(core: &Core, api: &Api, repo: &RepoPath, number: u64) -> CoreResult<IssueDetails> {
    let base = project_path(repo);
    let item = api
        .get_json(core, &v(&format!("{base}/_apis/wit/workitems/{number}"), &[]))
        .await
        .map_err(|e| not_found_as(e, || format!("Work item #{number} does not exist in {}.", repo.owner)))?;
    let thread = api.get_json(core, &with_query(&format!("{base}/_apis/wit/workItems/{number}/comments"), &[("api-version", "7.1-preview.4".to_string())])).await?;
    let comments = list(&thread, "comments")
        .iter()
        .map(|c| HostComment { id: super::number(c, "id").to_string(), author: c.get("createdBy").and_then(identity), body: text(c, "text"), created_at: text(c, "createdDate"), path: None, line: None })
        .collect();
    let body = item.get("fields").map(|fields| text(fields, "System.Description")).unwrap_or_default();
    Ok(IssueDetails { summary: work_item_summary(api, repo, &item), body, comments })
}

/// Plain text as the HTML Azure keeps descriptions in: escaped, line breaks as `<br>`.
fn as_html(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace("\r\n", "\n").replace('\n', "<br>")
}

/// "The process has no such work item type" (VS402323).
fn unknown_type(error: &CoreError) -> bool {
    matches!(error.code, ErrorCode::HostNotFound | ErrorCode::HostRejected) && error.git_output.as_deref().is_some_and(|detail| detail.contains("VS402323"))
}

async fn create_as(core: &Core, api: &Api, repo: &RepoPath, kind: &str, patch: &Value) -> CoreResult<Value> {
    api.send_json_patch(core, &v(&format!("{}/_apis/wit/workitems/${kind}", project_path(repo)), &[]), patch).await?.json()
}

/// Creates a work item of type "Issue" (Basic, Agile, CMMI); a process without that type (Scrum)
/// gets a "Bug" instead.
pub async fn issue_create(core: &Core, api: &Api, repo: &RepoPath, title: &str, body: &str) -> CoreResult<IssueSummary> {
    let patch = json!([
        { "op": "add", "path": "/fields/System.Title", "value": title },
        { "op": "add", "path": "/fields/System.Description", "value": as_html(body) },
    ]);
    let created = match create_as(core, api, repo, "Issue", &patch).await {
        Err(e) if unknown_type(&e) => create_as(core, api, repo, "Bug", &patch).await,
        other => other,
    }
    .map_err(|e| not_found_as(e, missing_project(repo)))?;
    Ok(work_item_summary(api, repo, &created))
}

// ---------------------------------------------------------------------------
// As a `Host`
// ---------------------------------------------------------------------------

pub struct AzureHost;

impl Host for AzureHost {
    fn kind(&self) -> HostKind {
        HostKind::AzureDevops
    }
    fn label(&self) -> &'static str {
        LABEL
    }
    fn pr_word(&self) -> &'static str {
        "pull request"
    }
    /// Every organization has its own address.
    fn public_web(&self) -> Option<&'static str> {
        None
    }
    fn api_base(&self, web_base: &str) -> String {
        web_base.to_string()
    }
    /// `https://dev.azure.com/<org>` (also from a pasted project or repository address),
    /// `https://<org>.visualstudio.com` → the same; on the local test server `http://127.0.0.1:<port>/<org>`.
    fn check_base(&self, base: String, loopback: bool) -> CoreResult<String> {
        let lower = base.to_ascii_lowercase();
        if let Some(org) = lower.strip_prefix(&format!("{AZURE_WEB}/")).and_then(|rest| rest.split('/').next()).filter(|org| is_organization(org)) {
            return Ok(format!("{AZURE_WEB}/{org}"));
        }
        if let Some(org) = lower.strip_prefix("https://").and_then(|rest| rest.split('/').next()).and_then(|host| host.strip_suffix(".visualstudio.com")).filter(|org| is_organization(org)) {
            return Ok(format!("{AZURE_WEB}/{org}"));
        }
        if loopback {
            if let Some((scheme, rest)) = lower.split_once("://") {
                if let Some((authority, path)) = rest.split_once('/') {
                    if let Some(org) = path.split('/').next().filter(|org| is_organization(org)) {
                        return Ok(format!("{scheme}://{authority}/{org}"));
                    }
                }
            }
        }
        Err(CoreError::not_allowed("Azure DevOps needs the address of your organization: https://dev.azure.com/<organization>."))
    }
    /// Without the redirect header Azure answers a rejected token with a sign-in page (203).
    fn request_headers(&self) -> &'static [(&'static str, &'static str)] {
        &[("accept", "application/json"), ("x-tfs-fedauthredirect", "Suppress")]
    }
    fn authorization(&self, token: &str, _username: Option<&str>) -> String {
        format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!(":{token}")))
    }
    /// `<project>/_git/<repository>` below the organization.
    fn split_repo_path(&self, path: &str) -> Option<RepoPath> {
        match path.split('/').collect::<Vec<_>>().as_slice() {
            [project, "_git", name] if !project.is_empty() && !name.is_empty() => Some(RepoPath { owner: detect::percent_decode(project), name: detect::percent_decode(name) }),
            _ => None,
        }
    }
    fn repo_web_url(&self, web_base: &str, repo: &RepoPath) -> String {
        format!("{web_base}/{}/_git/{}", encode(&repo.owner), encode(&repo.name))
    }
    fn capabilities(&self) -> HostCapabilities {
        HostCapabilities {
            issues: true,
            issue_create: true,
            draft_prs: true,
            draft_toggle: true,
            merge_methods: vec![PrMergeMethod::Merge, PrMergeMethod::Squash, PrMergeMethod::Rebase],
            delete_source_branch: true,
            pr_reopen: true,
            pr_reviewers: false,
            pr_labels: true,
            fork_checkout: false,
            review_threads: false,
            review_reply: false,
            review_reply_quotes: false,
        }
    }
    /// Azure only offers `refs/pull/<id>/merge` – a merge result, not the head of the fork.
    fn pr_ref(&self, _number: u64) -> Option<String> {
        None
    }
    fn template_folders(&self) -> &'static [&'static str] {
        &[".azuredevops"]
    }
    fn account_facts<'a>(&'a self, core: &'a Core, api: &'a Api) -> HostFuture<'a, AccountFacts> {
        Box::pin(account_facts(core, api))
    }
    fn repo_facts<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath) -> HostFuture<'a, RepoFacts> {
        Box::pin(repo_facts(core, api, repo))
    }
    fn pr_list<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath, state: PrListState, paging: Paging) -> HostFuture<'a, PrPage> {
        Box::pin(pr_list(core, api, repo, state, paging))
    }
    fn pr_get<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath, number: u64) -> HostFuture<'a, PrDetails> {
        Box::pin(pr_get(core, api, repo, number))
    }
    fn pr_head<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath, number: u64) -> HostFuture<'a, PrSummary> {
        Box::pin(pr_head(core, api, repo, number))
    }
    fn pr_create<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath, new: NewPr<'a>) -> HostFuture<'a, PrSummary> {
        Box::pin(pr_create(core, api, repo, new))
    }
    fn pr_update<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath, number: u64, change: PrChange<'a>) -> HostFuture<'a, PrSummary> {
        Box::pin(pr_update(core, api, repo, number, change))
    }
    fn pr_comment<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath, number: u64, body: &'a str) -> HostFuture<'a, HostComment> {
        Box::pin(comment_create(core, api, repo, number, body))
    }
    fn pr_merge<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath, number: u64, method: PrMergeMethod, delete_branch: bool) -> HostFuture<'a, PrSummary> {
        Box::pin(pr_merge(core, api, repo, number, method, delete_branch))
    }
    fn pr_set_open<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath, number: u64, open: bool) -> HostFuture<'a, PrSummary> {
        Box::pin(pr_set_open(core, api, repo, number, open))
    }
    fn issue_list<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath, state: IssueListState, query: Option<&'a str>, paging: Paging) -> HostFuture<'a, IssuePage> {
        Box::pin(issue_list(core, api, repo, state, query, paging))
    }
    fn issue_get<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath, number: u64) -> HostFuture<'a, IssueDetails> {
        Box::pin(issue_get(core, api, repo, number))
    }
    fn issue_create<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath, title: &'a str, body: &'a str) -> HostFuture<'a, IssueSummary> {
        Box::pin(issue_create(core, api, repo, title, body))
    }
}
