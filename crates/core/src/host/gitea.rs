//! Gitea and Forgejo (including Codeberg) through the REST API (`<instance>/api/v1`), documented
//! endpoints only: `/user`, `/repos/{owner}/{repo}`, `…/pulls`, `…/pulls/{index}/reviews`,
//! `…/pulls/{index}/commits`, `…/commits/{ref}/status`, `…/issues`, `…/issues/{index}/comments`.
//!
//! Gitea marks drafts with a title prefix (`WIP:`); the token travels as `Authorization: token …`.

use serde_json::{json, Value};

use super::{
    already_exists, color, first_line, flag, host_user, list, not_found_as, number, opt_text, parallel, review_summary, summarize_checks, text, two_levels, Api, Host,
    HostFuture, NewPr, Paging, PrChange, RepoFacts, RepoPath,
};
use crate::app::Core;
use crate::db::hoster_accounts::AccountFacts;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::http::{encode, with_query, Method};
use crate::model::{
    CheckRunState, HostCapabilities, HostComment, HostKind, HostLabel, HostRepoRef, HostUser, IssueDetails, IssueListState, IssuePage, IssueState, IssueSummary,
    PrCheck, PrCommit, PrDetails, PrListState, PrMergeMethod, PrPage, PrReviewState, PrReviewer, PrState, PrSummary,
};

/// Codeberg, the public Forgejo instance: what "no address" means for this host.
pub const CODEBERG_WEB: &str = "https://codeberg.org";
const LABEL: &str = "Gitea/Forgejo";
/// Title prefixes that mark a draft; `WIP: ` is the one the app writes.
const DRAFT_PREFIXES: [&str; 4] = ["WIP: ", "WIP:", "[WIP] ", "[WIP]"];
/// Gitea's largest page (`limit`).
const MAX_LIMIT: u32 = 50;

fn repo_path(repo: &RepoPath) -> String {
    format!("/repos/{}/{}", encode(&repo.owner), encode(&repo.name))
}

fn user(value: &Value) -> Option<HostUser> {
    if !value.is_object() {
        return None;
    }
    host_user(text(value, "login"), opt_text(value, "full_name"), opt_text(value, "avatar_url"))
}

fn labels(value: &Value) -> Vec<HostLabel> {
    list(value, "labels").iter().filter_map(|label| opt_text(label, "name").map(|name| HostLabel { name, color: color(opt_text(label, "color")) })).collect()
}

fn missing_repo(repo: &RepoPath) -> impl FnOnce() -> String + '_ {
    move || format!("{LABEL} could not find the repository {} – or the token is not allowed to see it.", repo.full())
}

fn pr_not_found(repo: &RepoPath, number: u64) -> impl FnOnce() -> String + '_ {
    move || format!("Pull request #{number} does not exist in {}.", repo.full())
}

/// The title without a draft prefix.
fn strip_draft(title: &str) -> &str {
    DRAFT_PREFIXES.iter().find_map(|prefix| title.strip_prefix(prefix)).map(str::trim_start).unwrap_or(title)
}

fn is_draft(value: &Value) -> bool {
    let title = text(value, "title");
    flag(value, "draft") || strip_draft(&title).len() != title.len()
}

// ---------------------------------------------------------------------------
// Account and repository
// ---------------------------------------------------------------------------

/// `GET /user`. Gitea does not reveal a token's scopes; missing ones show with the individual call (403).
pub async fn account_facts(core: &Core, api: &Api) -> CoreResult<AccountFacts> {
    let me = api.get_json(core, "/user").await?;
    let login = opt_text(&me, "login").ok_or_else(|| CoreError::unknown(format!("The response from {LABEL} could not be read (no user).")))?;
    Ok(AccountFacts { login: Some(login), name: opt_text(&me, "full_name"), avatar_url: opt_text(&me, "avatar_url"), scopes_ok: true, missing_scopes: Vec::new() })
}

/// `GET /repos/{owner}/{repo}`
pub async fn repo_facts(core: &Core, api: &Api, repo: &RepoPath) -> CoreResult<RepoFacts> {
    let value = api.get_json(core, &repo_path(repo)).await.map_err(|e| not_found_as(e, missing_repo(repo)))?;
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
// Pull requests
// ---------------------------------------------------------------------------

fn pr_state(value: &Value) -> PrState {
    if flag(value, "merged") {
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
        is_draft: is_draft(value),
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

fn status_state(state: &str) -> CheckRunState {
    match state {
        // "warning": passed with warnings.
        "success" | "warning" => CheckRunState::Passing,
        "pending" => CheckRunState::Pending,
        _ => CheckRunState::Failing,
    }
}

/// Commit statuses of the head commit (`…/commits/{ref}/status`).
async fn checks(core: &Core, api: &Api, repo: &RepoPath, sha: &str) -> CoreResult<Vec<PrCheck>> {
    if sha.is_empty() {
        return Ok(Vec::new());
    }
    let combined = api.get_json(core, &format!("{}/commits/{}/status", repo_path(repo), encode(sha))).await?;
    Ok(list(&combined, "statuses")
        .iter()
        .map(|status| PrCheck {
            name: text(status, "context"),
            state: status_state(&opt_text(status, "status").or_else(|| opt_text(status, "state")).unwrap_or_default()),
            url: opt_text(status, "target_url"),
        })
        .collect())
}

fn review_state_of(state: &str) -> Option<PrReviewState> {
    match state {
        "APPROVED" => Some(PrReviewState::Approved),
        "REQUEST_CHANGES" => Some(PrReviewState::ChangesRequested),
        "COMMENT" => Some(PrReviewState::Commented),
        _ => None,
    }
}

/// The last decision per reviewer (a later comment does not cancel an approval; dismissed reviews
/// don't count; `REQUEST_REVIEW` = asked again), plus the requested ones without a decision.
fn reviewers(reviews: &[Value], requested: &[Value]) -> Vec<PrReviewer> {
    let mut result: Vec<PrReviewer> = Vec::new();
    for review in reviews.iter().filter(|r| !flag(r, "dismissed")) {
        let Some(who) = review.get("user").and_then(user) else { continue };
        let state = text(review, "state");
        let index = result.iter().position(|r| r.user.login == who.login);
        match (state.as_str(), index) {
            ("APPROVED" | "REQUEST_CHANGES", Some(i)) => result[i].state = review_state_of(&state),
            ("REQUEST_REVIEW", Some(i)) => result[i].state = None,
            ("APPROVED" | "REQUEST_CHANGES" | "COMMENT", None) => result.push(PrReviewer { user: who, state: review_state_of(&state) }),
            ("REQUEST_REVIEW", None) => result.push(PrReviewer { user: who, state: None }),
            _ => {}
        }
    }
    for person in requested.iter().filter_map(user) {
        if !result.iter().any(|r| r.user.login == person.login) {
            result.push(PrReviewer { user: person, state: None });
        }
    }
    result
}

async fn reviews(core: &Core, api: &Api, repo: &RepoPath, number: u64) -> CoreResult<Vec<Value>> {
    api.get_all(core, &format!("{}/pulls/{number}/reviews?limit={MAX_LIMIT}", repo_path(repo))).await
}

/// `GET /repos/{owner}/{repo}/pulls`, plus checks and reviews per entry (in parallel). Gitea lists
/// merged pull requests under "closed"; they are separated here (pages may come out shorter).
pub async fn pr_list(core: &Core, api: &Api, repo: &RepoPath, state: PrListState, paging: Paging) -> CoreResult<PrPage> {
    let api_state = match state {
        PrListState::Open => "open",
        PrListState::Closed | PrListState::Merged => "closed",
        PrListState::All => "all",
    };
    let path = with_query(
        &format!("{}/pulls", repo_path(repo)),
        &[("state", api_state.to_string()), ("sort", "recentupdate".into()), ("page", paging.page.to_string()), ("limit", paging.per_page.min(MAX_LIMIT).to_string())],
    );
    let (values, next_page) = api.get_page(core, &path).await.map_err(|e| not_found_as(e, missing_repo(repo)))?;
    let wanted: Vec<&Value> = values
        .iter()
        .filter(|value| match state {
            PrListState::Closed => pr_state(value) == PrState::Closed,
            PrListState::Merged => pr_state(value) == PrState::Merged,
            _ => true,
        })
        .collect();
    let mut items: Vec<PrSummary> = wanted.iter().map(|value| pr_summary(value)).collect();
    let inputs: Vec<(u64, String, Vec<Value>)> = wanted.iter().map(|value| (number(value, "number"), head_sha(value), list(value, "requested_reviewers").to_vec())).collect();
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

async fn pr_raw(core: &Core, api: &Api, repo: &RepoPath, number: u64) -> CoreResult<Value> {
    api.get_json(core, &format!("{}/pulls/{number}", repo_path(repo))).await.map_err(|e| not_found_as(e, pr_not_found(repo, number)))
}

pub async fn pr_head(core: &Core, api: &Api, repo: &RepoPath, number: u64) -> CoreResult<PrSummary> {
    Ok(pr_summary(&pr_raw(core, api, repo, number).await?))
}

fn comment(prefix: &str, value: &Value, created_key: &str) -> HostComment {
    HostComment {
        id: format!("{prefix}{}", number(value, "id")),
        author: value.get("user").and_then(user),
        body: text(value, "body"),
        created_at: text(value, created_key),
        path: None,
        line: None,
    }
}

/// Details: pull request, reviews, comments (general ones and review texts), commits, checks.
pub async fn pr_get(core: &Core, api: &Api, repo: &RepoPath, number: u64) -> CoreResult<PrDetails> {
    let value = pr_raw(core, api, repo, number).await?;
    let base = repo_path(repo);
    let mut summary = pr_summary(&value);
    let review_values = reviews(core, api, repo, number).await?;
    let reviewers = reviewers(&review_values, list(&value, "requested_reviewers"));
    summary.review_state = review_summary(&reviewers);

    let mut comments: Vec<HostComment> = api.get_all(core, &format!("{base}/issues/{number}/comments?limit={MAX_LIMIT}")).await?.iter().map(|c| comment("c", c, "created_at")).collect();
    for review in review_values.iter().filter(|r| !text(r, "body").trim().is_empty()) {
        comments.push(comment("r", review, "submitted_at"));
    }
    comments.sort_by(|a, b| a.created_at.cmp(&b.created_at));

    let commits = api
        .get_all(core, &format!("{base}/pulls/{number}/commits?limit={MAX_LIMIT}"))
        .await?
        .iter()
        .map(|entry| {
            let commit = entry.get("commit").cloned().unwrap_or(Value::Null);
            let author = commit.get("author").cloned().unwrap_or(Value::Null);
            PrCommit { sha: text(entry, "sha"), summary: first_line(&text(&commit, "message")), author_name: text(&author, "name"), authored_at: text(&author, "date") }
        })
        .collect();

    let head_sha = head_sha(&value);
    let check_runs = checks(core, api, repo, &head_sha).await.unwrap_or_default();
    summary.checks = summarize_checks(&check_runs);
    Ok(PrDetails { summary, body: text(&value, "body"), reviewers, comments, commits, mergeable: value.get("mergeable").and_then(Value::as_bool), check_runs, head_sha })
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

fn draft_title(title: &str, draft: bool) -> String {
    let plain = strip_draft(title);
    if draft {
        format!("{}{plain}", DRAFT_PREFIXES[0])
    } else {
        plain.to_string()
    }
}

/// Label names → IDs of the repository (case-insensitive); an unknown name is an error.
async fn label_ids(core: &Core, api: &Api, repo: &RepoPath, names: &[String]) -> CoreResult<Vec<u64>> {
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let known = api.get_all(core, &format!("{}/labels?limit={MAX_LIMIT}", repo_path(repo))).await?;
    names
        .iter()
        .map(|name| {
            known
                .iter()
                .find(|label| text(label, "name").eq_ignore_ascii_case(name))
                .map(|label| number(label, "id"))
                .ok_or_else(|| CoreError::new(ErrorCode::HostRejected, format!("The repository {} has no label “{name}”.", repo.full())))
        })
        .collect()
}

/// `POST /repos/{owner}/{repo}/pulls`, then the reviewers.
pub async fn pr_create(core: &Core, api: &Api, repo: &RepoPath, new: NewPr<'_>) -> CoreResult<PrSummary> {
    let base = repo_path(repo);
    let labels = label_ids(core, api, repo, new.labels).await?;
    let mut body = json!({ "title": draft_title(new.title, new.draft), "body": new.body, "head": new.source_branch, "base": new.target_branch });
    if !labels.is_empty() {
        body["labels"] = json!(labels);
    }
    let created: Value = api
        .send_json(core, Method::Post, &format!("{base}/pulls"), &body)
        .await
        .map_err(|e| {
            if already_exists(&e) {
                CoreError { code: ErrorCode::NameExists, message: format!("There is already an open pull request for the branch “{}”.", new.source_branch), git_output: e.git_output, retry_at: None }
            } else {
                not_found_as(e, || format!("{LABEL} could not find the repository {} – or the token is not allowed to create pull requests there.", repo.full()))
            }
        })?
        .json()?;
    let number = number(&created, "number");
    if new.reviewers.is_empty() {
        return Ok(pr_summary(&created));
    }
    api.send_json(core, Method::Post, &format!("{base}/pulls/{number}/requested_reviewers"), &json!({ "reviewers": new.reviewers })).await.map_err(|e| CoreError {
        code: e.code,
        message: format!("Pull request #{number} was created, but the reviewers could not be set: {}", e.message),
        git_output: e.git_output,
        retry_at: e.retry_at,
    })?;
    pr_head(core, api, repo, number).await
}

/// `PATCH /repos/{owner}/{repo}/pulls/{index}`; reviewers through their own endpoint.
pub async fn pr_update(core: &Core, api: &Api, repo: &RepoPath, number: u64, change: PrChange<'_>) -> CoreResult<PrSummary> {
    let base = repo_path(repo);
    let current = pr_raw(core, api, repo, number).await?;
    let current_title = text(&current, "title");
    let was_draft = is_draft(&current);
    let mut patch = serde_json::Map::new();
    if change.title.is_some() || change.draft.is_some_and(|draft| draft != was_draft) {
        patch.insert("title".into(), json!(draft_title(change.title.unwrap_or(&current_title), change.draft.unwrap_or(was_draft))));
    }
    if let Some(body) = change.body {
        patch.insert("body".into(), json!(body));
    }
    if let Some(target) = change.target_branch {
        patch.insert("base".into(), json!(target));
    }
    if let Some(labels) = change.labels {
        patch.insert("labels".into(), json!(label_ids(core, api, repo, labels).await?));
    }
    if !patch.is_empty() {
        api.send_json(core, Method::Patch, &format!("{base}/pulls/{number}"), &Value::Object(patch)).await.map_err(|e| not_found_as(e, pr_not_found(repo, number)))?;
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

/// `POST /repos/{owner}/{repo}/issues/{index}/comments` – pull requests are issues there.
pub async fn comment_create(core: &Core, api: &Api, repo: &RepoPath, number: u64, body: &str) -> CoreResult<HostComment> {
    let value: Value = api
        .send_json(core, Method::Post, &format!("{}/issues/{number}/comments", repo_path(repo)), &json!({ "body": body }))
        .await
        .map_err(|e| not_found_as(e, pr_not_found(repo, number)))?
        .json()?;
    Ok(comment("c", &value, "created_at"))
}

/// `POST /repos/{owner}/{repo}/pulls/{index}/merge`; Gitea deletes the branch itself if asked.
pub async fn pr_merge(core: &Core, api: &Api, repo: &RepoPath, number: u64, method: PrMergeMethod, delete_branch: bool) -> CoreResult<PrSummary> {
    let action = match method {
        PrMergeMethod::Merge => "merge",
        PrMergeMethod::Squash => "squash",
        PrMergeMethod::Rebase => "rebase",
    };
    api.send_json(core, Method::Post, &format!("{}/pulls/{number}/merge", repo_path(repo)), &json!({ "Do": action, "delete_branch_after_merge": delete_branch }))
        .await
        .map_err(|e| not_found_as(e, pr_not_found(repo, number)))?;
    pr_head(core, api, repo, number).await
}

/// Close or reopen: `PATCH …/pulls/{index}` with `state`.
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

fn is_pull_request(value: &Value) -> bool {
    value.get("pull_request").is_some_and(|p| !p.is_null())
}

/// `GET /repos/{owner}/{repo}/issues?type=issues` (`q` searches title and body).
pub async fn issue_list(core: &Core, api: &Api, repo: &RepoPath, state: IssueListState, query: Option<&str>, paging: Paging) -> CoreResult<IssuePage> {
    let api_state = match state {
        IssueListState::Open => "open",
        IssueListState::Closed => "closed",
        IssueListState::All => "all",
    };
    let mut params = vec![("state", api_state.to_string()), ("type", "issues".into()), ("page", paging.page.to_string()), ("limit", paging.per_page.min(MAX_LIMIT).to_string())];
    if let Some(words) = query.map(str::trim).filter(|q| !q.is_empty()) {
        params.push(("q", words.to_string()));
    }
    let (values, next_page) = api.get_page(core, &with_query(&format!("{}/issues", repo_path(repo)), &params)).await.map_err(|e| not_found_as(e, missing_repo(repo)))?;
    Ok(IssuePage { items: values.iter().filter(|value| !is_pull_request(value)).map(issue_summary).collect(), next_page })
}

pub async fn issue_get(core: &Core, api: &Api, repo: &RepoPath, number: u64) -> CoreResult<IssueDetails> {
    let base = repo_path(repo);
    let value = api.get_json(core, &format!("{base}/issues/{number}")).await.map_err(|e| not_found_as(e, || format!("Issue #{number} does not exist in {}.", repo.full())))?;
    if is_pull_request(&value) {
        return Err(CoreError::new(ErrorCode::HostNotFound, format!("#{number} in {} is a pull request, not an issue.", repo.full())));
    }
    let comments = api.get_all(core, &format!("{base}/issues/{number}/comments?limit={MAX_LIMIT}")).await?.iter().map(|c| comment("c", c, "created_at")).collect();
    Ok(IssueDetails { summary: issue_summary(&value), body: text(&value, "body"), comments })
}

// ---------------------------------------------------------------------------
// As a `Host`
// ---------------------------------------------------------------------------

pub struct GiteaHost;

impl Host for GiteaHost {
    fn kind(&self) -> HostKind {
        HostKind::Gitea
    }
    fn label(&self) -> &'static str {
        LABEL
    }
    fn pr_word(&self) -> &'static str {
        "pull request"
    }
    fn public_web(&self) -> Option<&'static str> {
        Some(CODEBERG_WEB)
    }
    fn public_hosts(&self) -> &'static [&'static str] {
        &["codeberg.org", "www.codeberg.org"]
    }
    fn api_base(&self, web_base: &str) -> String {
        format!("{web_base}/api/v1")
    }
    fn api_suffixes(&self) -> &'static [&'static str] {
        &["api/v1"]
    }
    fn request_headers(&self) -> &'static [(&'static str, &'static str)] {
        &[("accept", "application/json")]
    }
    fn authorization(&self, token: &str, _username: Option<&str>) -> String {
        format!("token {token}")
    }
    fn split_repo_path(&self, path: &str) -> Option<RepoPath> {
        two_levels(path)
    }
    fn capabilities(&self) -> HostCapabilities {
        HostCapabilities {
            issues: true,
            issue_create: false,
            draft_prs: true,
            draft_toggle: true,
            merge_methods: vec![PrMergeMethod::Merge, PrMergeMethod::Squash, PrMergeMethod::Rebase],
            delete_source_branch: true,
            pr_reopen: true,
            pr_reviewers: true,
            pr_labels: true,
            fork_checkout: true,
        }
    }
    fn pr_ref(&self, number: u64) -> Option<String> {
        Some(format!("refs/pull/{number}/head"))
    }
    fn template_folders(&self) -> &'static [&'static str] {
        &[".gitea", ".forgejo"]
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
}
