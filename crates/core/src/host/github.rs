//! GitHub through the REST API (api.github.com or `<instance>/api/v3`), documented endpoints
//! only: `/user`, `/repos/{owner}/{repo}`, `…/pulls`, `…/issues`, `…/commits/{ref}/check-runs`,
//! `…/commits/{ref}/status`, `/search/issues`.

use serde_json::{json, Value};

use super::{
    already_exists, color, detect, first_line, flag, host_user, list, not_found_as, number, opt_text, parallel, review_summary, summarize_checks, text, two_levels, Api, Host, HostFuture, NewPr, Paging,
    PrChange, RepoFacts, RepoPath,
};
use crate::app::Core;
use crate::db::hoster_accounts::AccountFacts;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::http::{encode, with_query, Method};
use crate::model::{
    CheckRunState, HostCapabilities, HostComment, HostKind, HostLabel, HostRepoRef, HostUser, IssueDetails, IssueListState, IssuePage, IssueState, IssueSummary,
    PrCheck, PrCommit, PrDetails, PrListState, PrMergeMethod, PrPage, PrReviewState, PrReviewer, PrState, PrSummary,
};

fn repo_path(repo: &RepoPath) -> String {
    format!("/repos/{}/{}", encode(&repo.owner), encode(&repo.name))
}

fn user(value: &Value) -> Option<HostUser> {
    if !value.is_object() {
        return None;
    }
    host_user(text(value, "login"), opt_text(value, "name"), opt_text(value, "avatar_url"))
}

fn labels(value: &Value) -> Vec<HostLabel> {
    list(value, "labels")
        .iter()
        .filter_map(|label| match label {
            Value::String(name) => Some(HostLabel { name: name.clone(), color: None }),
            other => opt_text(other, "name").map(|name| HostLabel { name, color: color(opt_text(other, "color")) }),
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Account and repository
// ---------------------------------------------------------------------------

/// `GET /user`. Classic tokens list their permissions in `x-oauth-scopes`; pull requests in
/// private repositories need `repo`. Fine-grained tokens list nothing – whether their
/// permissions suffice only shows with the individual call.
pub async fn account_facts(core: &Core, api: &Api) -> CoreResult<AccountFacts> {
    let response = api.get(core, "/user").await?;
    let me: Value = response.json()?;
    let login = opt_text(&me, "login").ok_or_else(|| CoreError::unknown("The response from GitHub could not be read (no user)."))?;
    let mut missing = Vec::new();
    if let Some(scopes) = response.header("x-oauth-scopes") {
        let scopes: Vec<&str> = scopes.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
        if !scopes.is_empty() && !scopes.iter().any(|s| *s == "repo" || *s == "public_repo") {
            missing.push("repo".to_string());
        }
    }
    Ok(AccountFacts { login: Some(login), name: opt_text(&me, "name"), avatar_url: opt_text(&me, "avatar_url"), scopes_ok: missing.is_empty(), missing_scopes: missing })
}

/// `GET /repos/{owner}/{repo}`
pub async fn repo_facts(core: &Core, api: &Api, repo: &RepoPath) -> CoreResult<RepoFacts> {
    let value = api.get_json(core, &repo_path(repo)).await.map_err(|e| not_found_as(e, || format!("GitHub could not find the repository {} – or the token is not allowed to see it.", repo.full())))?;
    let fork_parent = value.get("parent").filter(|p| p.is_object()).and_then(|parent| {
        let owner = parent.get("owner").map(|o| text(o, "login")).unwrap_or_default();
        let name = text(parent, "name");
        (!owner.is_empty() && !name.is_empty()).then(|| HostRepoRef { owner, name, web_url: text(parent, "html_url") })
    });
    Ok(RepoFacts {
        default_branch: opt_text(&value, "default_branch"),
        can_push: value.get("permissions").and_then(|p| p.get("push")).and_then(Value::as_bool),
        fork_parent,
        has_issues: value.get("has_issues").and_then(Value::as_bool),
    })
}

// ---------------------------------------------------------------------------
// Pull Requests
// ---------------------------------------------------------------------------

fn pr_state(value: &Value) -> PrState {
    let merged = flag(value, "merged") || value.get("merged_at").is_some_and(|v| !v.is_null());
    if merged {
        PrState::Merged
    } else if text(value, "state") == "open" {
        PrState::Open
    } else {
        PrState::Closed
    }
}

fn head_sha(value: &Value) -> String {
    value.get("head").map(|head| text(head, "sha")).unwrap_or_default()
}

fn pr_summary(value: &Value) -> PrSummary {
    let branch = |side: &str| value.get(side).map(|v| text(v, "ref")).unwrap_or_default();
    let repo_of = |side: &str| value.get(side).and_then(|v| v.get("repo")).and_then(|r| r.get("full_name")).and_then(Value::as_str).map(str::to_string);
    let is_fork = match (repo_of("head"), repo_of("base")) {
        (Some(head), Some(base)) => !head.eq_ignore_ascii_case(&base),
        // The source repository has been deleted.
        (None, _) => true,
        _ => false,
    };
    PrSummary {
        number: number(value, "number"),
        title: text(value, "title"),
        state: pr_state(value),
        is_draft: flag(value, "draft"),
        author: value.get("user").and_then(user),
        source_branch: branch("head"),
        target_branch: branch("base"),
        updated_at: text(value, "updated_at"),
        web_url: text(value, "html_url"),
        checks: None,
        review_state: None,
        labels: labels(value),
        is_fork,
    }
}

fn check_run_state(run: &Value) -> CheckRunState {
    if text(run, "status") != "completed" {
        return CheckRunState::Pending;
    }
    match text(run, "conclusion").as_str() {
        "success" => CheckRunState::Passing,
        "neutral" | "skipped" => CheckRunState::Skipped,
        _ => CheckRunState::Failing,
    }
}

/// Checks of a commit: check runs (`…/check-runs`) and commit statuses (`…/status`).
async fn checks(core: &Core, api: &Api, repo: &RepoPath, sha: &str) -> CoreResult<Vec<PrCheck>> {
    if sha.is_empty() {
        return Ok(Vec::new());
    }
    let base = format!("{}/commits/{}", repo_path(repo), encode(sha));
    let mut checks: Vec<PrCheck> = Vec::new();
    let runs = api.get_json(core, &format!("{base}/check-runs?per_page=100")).await?;
    for run in list(&runs, "check_runs") {
        checks.push(PrCheck { name: text(run, "name"), state: check_run_state(run), url: opt_text(run, "html_url").or_else(|| opt_text(run, "details_url")) });
    }
    let status = api.get_json(core, &format!("{base}/status?per_page=100")).await?;
    for entry in list(&status, "statuses") {
        let state = match text(entry, "state").as_str() {
            "success" => CheckRunState::Passing,
            "pending" => CheckRunState::Pending,
            _ => CheckRunState::Failing,
        };
        checks.push(PrCheck { name: text(entry, "context"), state, url: opt_text(entry, "target_url") });
    }
    Ok(checks)
}

fn review_state_of(review: &Value) -> Option<PrReviewState> {
    match text(review, "state").as_str() {
        "APPROVED" => Some(PrReviewState::Approved),
        "CHANGES_REQUESTED" => Some(PrReviewState::ChangesRequested),
        "COMMENTED" => Some(PrReviewState::Commented),
        _ => None,
    }
}

/// The last decision per reviewer (a later "commented" does not cancel an approval;
/// a dismissed review no longer counts), plus the requested ones without a decision.
fn reviewers(reviews: &[Value], requested: &[Value]) -> Vec<PrReviewer> {
    let mut result: Vec<PrReviewer> = Vec::new();
    for review in reviews {
        let Some(who) = review.get("user").and_then(user) else { continue };
        let state = text(review, "state");
        let index = result.iter().position(|r| r.user.login == who.login);
        match (state.as_str(), index) {
            ("DISMISSED", Some(i)) => {
                result.remove(i);
            }
            ("APPROVED" | "CHANGES_REQUESTED", Some(i)) => result[i].state = review_state_of(review),
            ("APPROVED" | "CHANGES_REQUESTED" | "COMMENTED", None) => result.push(PrReviewer { user: who, state: review_state_of(review) }),
            _ => {}
        }
    }
    for person in requested.iter().filter_map(user) {
        match result.iter_mut().find(|r| r.user.login == person.login) {
            // Requested again: the old decision no longer applies.
            Some(known) => known.state = None,
            None => result.push(PrReviewer { user: person, state: None }),
        }
    }
    result
}

async fn reviews(core: &Core, api: &Api, repo: &RepoPath, number: u64) -> CoreResult<Vec<Value>> {
    api.get_all(core, &format!("{}/pulls/{number}/reviews?per_page=100", repo_path(repo))).await
}

/// `GET /repos/{owner}/{repo}/pulls`, plus checks and reviews per entry (in parallel, with
/// cached responses). If enriching an entry fails, its fields stay empty.
pub async fn pr_list(core: &Core, api: &Api, repo: &RepoPath, state: PrListState, page: u32, per_page: u32) -> CoreResult<PrPage> {
    let api_state = match state {
        PrListState::Open => "open",
        PrListState::Closed | PrListState::Merged => "closed",
        PrListState::All => "all",
    };
    let path = with_query(
        &format!("{}/pulls", repo_path(repo)),
        &[("state", api_state.to_string()), ("sort", "updated".into()), ("direction", "desc".into()), ("per_page", per_page.to_string()), ("page", page.to_string())],
    );
    let (values, next_page) = api.get_page(core, &path).await.map_err(|e| not_found_as(e, || format!("GitHub could not find the repository {} – or the token is not allowed to see it.", repo.full())))?;
    // GitHub has no "merged" filter: both come as "closed" and are separated here.
    let wanted: Vec<&Value> = values
        .iter()
        .filter(|value| match state {
            PrListState::Closed => pr_state(value) == PrState::Closed,
            PrListState::Merged => pr_state(value) == PrState::Merged,
            _ => true,
        })
        .collect();
    let mut items: Vec<PrSummary> = wanted.iter().map(|value| pr_summary(value)).collect();
    let inputs: Vec<(u64, String, Vec<Value>)> =
        wanted.iter().map(|value| (number(value, "number"), head_sha(value), list(value, "requested_reviewers").to_vec())).collect();
    let extras = parallel(inputs, |(number, sha, requested)| {
        let (core, api, repo) = (core.clone(), api.clone(), repo.clone());
        async move {
            let checks = checks(&core, &api, &repo, &sha).await.ok().and_then(|c| summarize_checks(&c));
            let review = reviews(&core, &api, &repo, number).await.ok().and_then(|r| review_summary(&reviewers(&r, &requested)));
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

fn pr_not_found(repo: &RepoPath, number: u64) -> impl FnOnce() -> String + '_ {
    move || format!("Pull request #{number} does not exist in {}.", repo.full())
}

async fn pr_raw(core: &Core, api: &Api, repo: &RepoPath, number: u64) -> CoreResult<Value> {
    api.get_json(core, &format!("{}/pulls/{number}", repo_path(repo))).await.map_err(|e| not_found_as(e, pr_not_found(repo, number)))
}

/// Only the header data of a pull request (without checks and reviews).
pub async fn pr_head(core: &Core, api: &Api, repo: &RepoPath, number: u64) -> CoreResult<PrSummary> {
    Ok(pr_summary(&pr_raw(core, api, repo, number).await?))
}

fn comment(prefix: &str, value: &Value, created_key: &str) -> HostComment {
    HostComment {
        id: format!("{prefix}{}", number(value, "id")),
        author: value.get("user").and_then(user),
        body: text(value, "body"),
        created_at: text(value, created_key),
        path: opt_text(value, "path"),
        line: value.get("line").and_then(Value::as_u64).or_else(|| value.get("original_line").and_then(Value::as_u64)).and_then(|n| u32::try_from(n).ok()),
    }
}

/// Details: pull request, reviews, comments (general and on lines), commits, checks.
pub async fn pr_get(core: &Core, api: &Api, repo: &RepoPath, number: u64) -> CoreResult<PrDetails> {
    let value = pr_raw(core, api, repo, number).await?;
    let base = repo_path(repo);
    let mut summary = pr_summary(&value);
    let review_values = reviews(core, api, repo, number).await?;
    let reviewers = reviewers(&review_values, list(&value, "requested_reviewers"));
    summary.review_state = review_summary(&reviewers);

    let mut comments: Vec<HostComment> = Vec::new();
    for value in api.get_all(core, &format!("{base}/issues/{number}/comments?per_page=100")).await? {
        comments.push(comment("c", &value, "created_at"));
    }
    for review in review_values.iter().filter(|r| !text(r, "body").trim().is_empty()) {
        comments.push(comment("r", review, "submitted_at"));
    }
    for value in api.get_all(core, &format!("{base}/pulls/{number}/comments?per_page=100")).await? {
        comments.push(comment("d", &value, "created_at"));
    }
    comments.sort_by(|a, b| a.created_at.cmp(&b.created_at));

    let commits = api
        .get_all(core, &format!("{base}/pulls/{number}/commits?per_page=100"))
        .await?
        .iter()
        .map(|entry| {
            let commit = entry.get("commit").cloned().unwrap_or(Value::Null);
            let author = commit.get("author").cloned().unwrap_or(Value::Null);
            PrCommit { sha: text(entry, "sha"), summary: first_line(&text(&commit, "message")), author_name: text(&author, "name"), authored_at: text(&author, "date") }
        })
        .collect();

    let head_sha = head_sha(&value);
    // Fine-grained tokens are often not allowed to read the checks: then the list stays empty.
    let check_runs = checks(core, api, repo, &head_sha).await.unwrap_or_default();
    summary.checks = summarize_checks(&check_runs);
    Ok(PrDetails { summary, body: text(&value, "body"), reviewers, comments, commits, mergeable: value.get("mergeable").and_then(Value::as_bool), check_runs, head_sha })
}

/// `POST /repos/{owner}/{repo}/pulls`, then reviewers and labels.
pub async fn pr_create(core: &Core, api: &Api, repo: &RepoPath, new: NewPr<'_>) -> CoreResult<PrSummary> {
    let base = repo_path(repo);
    let body = json!({ "title": new.title, "body": new.body, "head": new.source_branch, "base": new.target_branch, "draft": new.draft });
    let created: Value = api
        .send_json(core, Method::Post, &format!("{base}/pulls"), &body)
        .await
        .map_err(|e| {
            if already_exists(&e) {
                CoreError { code: ErrorCode::NameExists, message: format!("There is already an open pull request for the branch “{}”.", new.source_branch), git_output: e.git_output, retry_at: None }
            } else {
                not_found_as(e, || format!("GitHub could not find the repository {} – or the token is not allowed to create pull requests there.", repo.full()))
            }
        })?
        .json()?;
    let number = number(&created, "number");
    let after = |what: &str, e: CoreError| CoreError {
        code: e.code,
        message: format!("Pull request #{number} was created, but {what} could not be set: {}", e.message),
        git_output: e.git_output,
        retry_at: e.retry_at,
    };
    if !new.reviewers.is_empty() {
        api.send_json(core, Method::Post, &format!("{base}/pulls/{number}/requested_reviewers"), &json!({ "reviewers": new.reviewers })).await.map_err(|e| after("the reviewers", e))?;
    }
    if !new.labels.is_empty() {
        api.send_json(core, Method::Post, &format!("{base}/issues/{number}/labels"), &json!({ "labels": new.labels })).await.map_err(|e| after("the labels", e))?;
    }
    if new.reviewers.is_empty() && new.labels.is_empty() {
        return Ok(pr_summary(&created));
    }
    pr_head(core, api, repo, number).await
}

/// `PATCH /repos/{owner}/{repo}/pulls/{number}`; labels and reviewers through their own endpoints.
pub async fn pr_update(core: &Core, api: &Api, repo: &RepoPath, number: u64, change: PrChange<'_>) -> CoreResult<PrSummary> {
    let base = repo_path(repo);
    let current = pr_raw(core, api, repo, number).await?;
    if change.draft.is_some_and(|draft| draft != flag(&current, "draft")) {
        return Err(CoreError::new(
            ErrorCode::HostUnsupported,
            "GitHub does not allow switching between draft and “ready for review” through this API. Change it on the website.",
        ));
    }
    let mut patch = serde_json::Map::new();
    if let Some(title) = change.title {
        patch.insert("title".into(), json!(title));
    }
    if let Some(body) = change.body {
        patch.insert("body".into(), json!(body));
    }
    if let Some(target) = change.target_branch {
        patch.insert("base".into(), json!(target));
    }
    if !patch.is_empty() {
        api.send_json(core, Method::Patch, &format!("{base}/pulls/{number}"), &Value::Object(patch)).await.map_err(|e| not_found_as(e, pr_not_found(repo, number)))?;
    }
    if let Some(labels) = change.labels {
        api.send_json(core, Method::Put, &format!("{base}/issues/{number}/labels"), &json!({ "labels": labels })).await?;
    }
    if let Some(wanted) = change.reviewers {
        let requested: Vec<String> = list(&current, "requested_reviewers").iter().map(|r| text(r, "login")).collect();
        let add: Vec<&String> = wanted.iter().filter(|w| !requested.iter().any(|r| r.eq_ignore_ascii_case(w))).collect();
        let remove: Vec<&String> = requested.iter().filter(|r| !wanted.iter().any(|w| w.eq_ignore_ascii_case(r))).collect();
        let path = format!("{base}/pulls/{number}/requested_reviewers");
        if !add.is_empty() {
            api.send_json(core, Method::Post, &path, &json!({ "reviewers": add })).await?;
        }
        if !remove.is_empty() {
            api.send_json(core, Method::Delete, &path, &json!({ "reviewers": remove })).await?;
        }
    }
    pr_head(core, api, repo, number).await
}

/// `POST /repos/{owner}/{repo}/issues/{number}/comments` – also for issues.
pub async fn comment_create(core: &Core, api: &Api, repo: &RepoPath, number: u64, body: &str) -> CoreResult<HostComment> {
    let value: Value = api
        .send_json(core, Method::Post, &format!("{}/issues/{number}/comments", repo_path(repo)), &json!({ "body": body }))
        .await
        .map_err(|e| not_found_as(e, pr_not_found(repo, number)))?
        .json()?;
    Ok(comment("c", &value, "created_at"))
}

/// `PUT /repos/{owner}/{repo}/pulls/{number}/merge`, then delete the source branch if requested.
pub async fn pr_merge(core: &Core, api: &Api, repo: &RepoPath, number: u64, method: PrMergeMethod, delete_branch: bool) -> CoreResult<PrSummary> {
    let base = repo_path(repo);
    let before = pr_head(core, api, repo, number).await?;
    let merge_method = match method {
        PrMergeMethod::Merge => "merge",
        PrMergeMethod::Squash => "squash",
        PrMergeMethod::Rebase => "rebase",
    };
    api.send_json(core, Method::Put, &format!("{base}/pulls/{number}/merge"), &json!({ "merge_method": merge_method })).await.map_err(|e| not_found_as(e, pr_not_found(repo, number)))?;
    if delete_branch && !before.is_fork && !before.source_branch.is_empty() {
        let branch: Vec<String> = before.source_branch.split('/').map(encode).collect();
        match api.delete(core, &format!("{base}/git/refs/heads/{}", branch.join("/"))).await {
            Ok(_) => {}
            // Already gone (e.g. deleted automatically): not an error.
            Err(e) if matches!(e.code, ErrorCode::HostNotFound | ErrorCode::HostRejected) => {}
            Err(e) => {
                return Err(CoreError { code: e.code, message: format!("Pull request #{number} was merged, but the branch “{}” could not be deleted: {}", before.source_branch, e.message), git_output: e.git_output, retry_at: e.retry_at })
            }
        }
    }
    pr_head(core, api, repo, number).await
}

/// Close or reopen: `PATCH …/pulls/{number}` with `state`.
pub async fn pr_set_open(core: &Core, api: &Api, repo: &RepoPath, number: u64, open: bool) -> CoreResult<PrSummary> {
    let state = if open { "open" } else { "closed" };
    let value: Value = api
        .send_json(core, Method::Patch, &format!("{}/pulls/{number}", repo_path(repo)), &json!({ "state": state }))
        .await
        .map_err(|e| not_found_as(e, pr_not_found(repo, number)))?
        .json()?;
    Ok(pr_summary(&value))
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

fn issue_summary(value: &Value) -> IssueSummary {
    let number = number(value, "number");
    IssueSummary {
        number,
        key: format!("#{number}"),
        title: text(value, "title"),
        state: if text(value, "state") == "open" { IssueState::Open } else { IssueState::Closed },
        author: value.get("user").and_then(user),
        assignees: list(value, "assignees").iter().filter_map(user).collect(),
        labels: labels(value),
        updated_at: text(value, "updated_at"),
        web_url: text(value, "html_url"),
    }
}

/// Without search text `GET /repos/{owner}/{repo}/issues` (pull requests are filtered out), with
/// search text `GET /search/issues`.
pub async fn issue_list(core: &Core, api: &Api, repo: &RepoPath, state: IssueListState, query: Option<&str>, page: u32, per_page: u32) -> CoreResult<IssuePage> {
    let missing = |e| not_found_as(e, || format!("GitHub could not find the repository {} – or the token is not allowed to see it.", repo.full()));
    let paging = [("per_page", per_page.to_string()), ("page", page.to_string())];
    let (values, next_page) = match query.map(str::trim).filter(|q| !q.is_empty()) {
        None => {
            let api_state = match state {
                IssueListState::Open => "open",
                IssueListState::Closed => "closed",
                IssueListState::All => "all",
            };
            let mut params = vec![("state", api_state.to_string()), ("sort", "updated".into()), ("direction", "desc".into())];
            params.extend(paging);
            api.get_page(core, &with_query(&format!("{}/issues", repo_path(repo)), &params)).await.map_err(missing)?
        }
        Some(words) => {
            let mut q = format!("{words} repo:{} is:issue", repo.full());
            match state {
                IssueListState::Open => q.push_str(" is:open"),
                IssueListState::Closed => q.push_str(" is:closed"),
                IssueListState::All => {}
            }
            let mut params = vec![("q", q), ("sort", "updated".into()), ("order", "desc".into())];
            params.extend(paging);
            let response = api.get(core, &with_query("/search/issues", &params)).await.map_err(missing)?;
            let next = response.next_page();
            let found: Value = response.json()?;
            (list(&found, "items").to_vec(), next)
        }
    };
    let items = values.iter().filter(|value| value.get("pull_request").is_none()).map(issue_summary).collect();
    Ok(IssuePage { items, next_page })
}

pub async fn issue_get(core: &Core, api: &Api, repo: &RepoPath, number: u64) -> CoreResult<IssueDetails> {
    let base = repo_path(repo);
    let missing = || format!("Issue #{number} does not exist in {}.", repo.full());
    let value = api.get_json(core, &format!("{base}/issues/{number}")).await.map_err(|e| not_found_as(e, missing))?;
    if value.get("pull_request").is_some() {
        return Err(CoreError::new(ErrorCode::HostNotFound, format!("#{number} in {} is a pull request, not an issue.", repo.full())));
    }
    let comments = api.get_all(core, &format!("{base}/issues/{number}/comments?per_page=100")).await?.iter().map(|c| comment("c", c, "created_at")).collect();
    Ok(IssueDetails { summary: issue_summary(&value), body: text(&value, "body"), comments })
}

// ---------------------------------------------------------------------------
// As a `Host`
// ---------------------------------------------------------------------------

pub struct GithubHost;

impl Host for GithubHost {
    fn kind(&self) -> HostKind {
        HostKind::Github
    }
    fn label(&self) -> &'static str {
        "GitHub"
    }
    fn pr_word(&self) -> &'static str {
        "pull request"
    }
    fn public_web(&self) -> Option<&'static str> {
        Some(detect::GITHUB_WEB)
    }
    fn public_hosts(&self) -> &'static [&'static str] {
        &["github.com", "www.github.com", "api.github.com"]
    }
    fn api_base(&self, web_base: &str) -> String {
        if web_base == detect::GITHUB_WEB {
            "https://api.github.com".to_string()
        } else {
            format!("{web_base}/api/v3")
        }
    }
    fn api_suffixes(&self) -> &'static [&'static str] {
        &["api/v3"]
    }
    fn request_headers(&self) -> &'static [(&'static str, &'static str)] {
        &[("accept", "application/vnd.github+json"), ("x-github-api-version", "2022-11-28")]
    }
    fn split_repo_path(&self, path: &str) -> Option<RepoPath> {
        two_levels(path)
    }
    fn capabilities(&self) -> HostCapabilities {
        HostCapabilities {
            issues: true,
            issue_create: false,
            draft_prs: true,
            draft_toggle: false,
            merge_methods: vec![PrMergeMethod::Merge, PrMergeMethod::Squash, PrMergeMethod::Rebase],
            delete_source_branch: true,
            pr_reopen: true,
            pr_reviewers: true,
            pr_labels: true,
            fork_checkout: true,
            review_threads: false,
            review_reply: false,
            review_reply_quotes: false,
        }
    }
    fn pr_ref(&self, number: u64) -> Option<String> {
        Some(format!("refs/pull/{number}/head"))
    }
    fn template_folders(&self) -> &'static [&'static str] {
        &[".github"]
    }
    fn account_facts<'a>(&'a self, core: &'a Core, api: &'a Api) -> HostFuture<'a, AccountFacts> {
        Box::pin(account_facts(core, api))
    }
    fn repo_facts<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath) -> HostFuture<'a, RepoFacts> {
        Box::pin(repo_facts(core, api, repo))
    }
    fn pr_list<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath, state: PrListState, paging: Paging) -> HostFuture<'a, PrPage> {
        Box::pin(pr_list(core, api, repo, state, paging.page, paging.per_page))
    }
    fn pr_get<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath, number: u64) -> HostFuture<'a, PrDetails> {
        Box::pin(pr_get(core, api, repo, number))
    }
    fn pr_head<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath, number: u64) -> HostFuture<'a, PrSummary> {
        Box::pin(pr_head(core, api, repo, number))
    }
    fn issue_list<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath, state: IssueListState, query: Option<&'a str>, paging: Paging) -> HostFuture<'a, IssuePage> {
        Box::pin(issue_list(core, api, repo, state, query, paging.page, paging.per_page))
    }
    fn issue_get<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath, number: u64) -> HostFuture<'a, IssueDetails> {
        Box::pin(issue_get(core, api, repo, number))
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
}
