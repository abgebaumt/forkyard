//! Bitbucket Cloud through the REST API 2.0 (`api.bitbucket.org/2.0`), documented endpoints only:
//! `/user`, `/user/permissions/repositories`, `/repositories/{workspace}/{repo_slug}`,
//! `…/pullrequests`, `…/pullrequests/{id}/statuses|diffstat|comments|commits`, `…/issues`.
//!
//! Sign-in: the Atlassian account e-mail (or the Bitbucket user name for an app password) and an
//! API token via Basic authentication. Lists come as `{ values, next }`. Bitbucket knows no labels,
//! cannot reopen a declined pull request and offers no ref for pull requests from forks.

use base64::Engine;
use serde_json::{json, Value};

use super::{
    already_exists, first_line, flag, host_user, list, not_found_as, number, opt_text, parallel, review_summary, summarize_checks, text, two_levels, Api, Host,
    HostFuture, NewPr, Paging, PrChange, RepoFacts, RepoPath, MAX_ITEMS,
};
use crate::app::Core;
use crate::db::hoster_accounts::AccountFacts;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::http::{encode, with_query, Method};
use crate::model::{
    CheckRunState, HostCapabilities, HostComment, HostKind, HostLabel, HostRepoRef, HostUser, IssueDetails, IssueListState, IssuePage, IssueState, IssueSummary,
    PrCheck, PrCommit, PrDetails, PrListState, PrMergeMethod, PrPage, PrReviewState, PrReviewer, PrState, PrSummary,
};

pub const BITBUCKET_WEB: &str = "https://bitbucket.org";
const API_WEB: &str = "https://api.bitbucket.org/2.0";
const LABEL: &str = "Bitbucket";
/// Bitbucket's largest page (`pagelen`).
const MAX_PAGELEN: u32 = 50;
/// Issue states that count as open; everything else (resolved, invalid, duplicate, wontfix, closed) is closed.
const OPEN_STATES: [&str; 3] = ["new", "open", "on hold"];

fn repo_path(repo: &RepoPath) -> String {
    format!("/repositories/{}/{}", encode(&repo.owner), encode(&repo.name))
}

fn pr_path(repo: &RepoPath, number: u64) -> String {
    format!("{}/pullrequests/{number}", repo_path(repo))
}

/// Bitbucket names people by nickname (the user name is no longer public).
fn user(value: &Value) -> Option<HostUser> {
    if !value.is_object() {
        return None;
    }
    let login = opt_text(value, "nickname").or_else(|| opt_text(value, "username")).or_else(|| opt_text(value, "display_name")).unwrap_or_default();
    let avatar = value.get("links").and_then(|l| l.get("avatar")).and_then(|a| opt_text(a, "href"));
    host_user(login, opt_text(value, "display_name"), avatar)
}

fn html_link(value: &Value) -> String {
    value.get("links").and_then(|l| l.get("html")).map(|h| text(h, "href")).unwrap_or_default()
}

fn missing_repo(repo: &RepoPath) -> impl FnOnce() -> String + '_ {
    move || format!("{LABEL} could not find the repository {} – or the account is not allowed to see it.", repo.full())
}

fn pr_not_found(repo: &RepoPath, number: u64) -> impl FnOnce() -> String + '_ {
    move || format!("Pull request #{number} does not exist in {}.", repo.full())
}

/// The entries of a list and the address of the next page.
fn values_of(value: Value) -> CoreResult<(Vec<Value>, Option<String>)> {
    let next = opt_text(&value, "next");
    match value {
        Value::Object(mut map) => match map.remove("values") {
            Some(Value::Array(items)) => Ok((items, next)),
            _ => Err(CoreError::unknown(format!("The response from {LABEL} could not be read (unexpected structure)."))),
        },
        _ => Err(CoreError::unknown(format!("The response from {LABEL} could not be read (unexpected structure)."))),
    }
}

/// The `page` parameter of the address of the next page.
fn page_number(next: Option<String>) -> Option<u32> {
    let next = next?;
    let query = next.split_once('?')?.1;
    query.split('&').find_map(|pair| pair.strip_prefix("page=")).and_then(|v| v.parse().ok())
}

async fn page_of(core: &Core, api: &Api, path: &str) -> CoreResult<(Vec<Value>, Option<u32>)> {
    let (items, next) = values_of(api.get_json(core, path).await?)?;
    Ok((items, page_number(next)))
}

/// All pages of a list (up to `MAX_ITEMS` entries), following `next`.
async fn all_of(core: &Core, api: &Api, path: &str) -> CoreResult<Vec<Value>> {
    let mut items: Vec<Value> = Vec::new();
    let mut next = Some(path.to_string());
    while let Some(path) = next {
        let (values, following) = values_of(api.get_json(core, &path).await?)?;
        items.extend(values);
        next = following;
        if items.len() >= MAX_ITEMS {
            items.truncate(MAX_ITEMS);
            break;
        }
    }
    Ok(items)
}

// ---------------------------------------------------------------------------
// Account and repository
// ---------------------------------------------------------------------------

/// `GET /user`. If Bitbucket lists the token's scopes (`x-oauth-scopes`), writing pull requests
/// must be among them.
pub async fn account_facts(core: &Core, api: &Api) -> CoreResult<AccountFacts> {
    let response = api.get(core, "/user").await?;
    let me: Value = response.json()?;
    let who = user(&me).ok_or_else(|| CoreError::unknown(format!("The response from {LABEL} could not be read (no user).")))?;
    let mut missing = Vec::new();
    if let Some(scopes) = response.header("x-oauth-scopes") {
        let scopes: Vec<&str> = scopes.split(',').map(str::trim).filter(|s| !s.is_empty()).collect();
        if !scopes.is_empty() && !scopes.iter().any(|s| *s == "pullrequest:write" || *s == "write:pullrequest:bitbucket") {
            missing.push("pullrequest:write".to_string());
        }
    }
    Ok(AccountFacts { login: Some(who.login), name: who.name, avatar_url: who.avatar_url, scopes_ok: missing.is_empty(), missing_scopes: missing })
}

/// `GET /repositories/{workspace}/{repo_slug}`, plus the account's permission on it
/// (`/user/permissions/repositories`; if that fails, write access stays unknown).
pub async fn repo_facts(core: &Core, api: &Api, repo: &RepoPath) -> CoreResult<RepoFacts> {
    let value = api.get_json(core, &repo_path(repo)).await.map_err(|e| not_found_as(e, missing_repo(repo)))?;
    let fork_parent = value.get("parent").filter(|p| p.is_object()).and_then(|parent| {
        let full = text(parent, "full_name");
        let (owner, name) = full.split_once('/')?;
        Some(HostRepoRef { owner: owner.to_string(), name: name.to_string(), web_url: html_link(parent) })
    });
    let permission = api.get_json(core, &with_query("/user/permissions/repositories", &[("q", format!("repository.full_name=\"{}\"", repo.full()))])).await.ok();
    let can_push = permission.as_ref().map(|p| list(p, "values").iter().any(|entry| matches!(text(entry, "permission").as_str(), "write" | "admin")));
    Ok(RepoFacts { default_branch: value.get("mainbranch").and_then(|b| opt_text(b, "name")), can_push, fork_parent, has_issues: value.get("has_issues").and_then(Value::as_bool) })
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

fn pr_state(value: &Value) -> PrState {
    match text(value, "state").as_str() {
        "OPEN" => PrState::Open,
        "MERGED" => PrState::Merged,
        // DECLINED, SUPERSEDED
        _ => PrState::Closed,
    }
}

fn pr_summary(value: &Value) -> PrSummary {
    let side = |key: &str| value.get(key).cloned().unwrap_or(Value::Null);
    let (source, destination) = (side("source"), side("destination"));
    let branch = |side: &Value| side.get("branch").map(|b| text(b, "name")).unwrap_or_default();
    let full = |side: &Value| side.get("repository").and_then(|r| opt_text(r, "full_name"));
    let is_fork = match (full(&source), full(&destination)) {
        (Some(from), Some(into)) => !from.eq_ignore_ascii_case(&into),
        // The source repository has been deleted.
        (None, _) => true,
        _ => false,
    };
    PrSummary {
        number: number(value, "id"),
        title: text(value, "title"),
        state: pr_state(value),
        is_draft: flag(value, "draft"),
        author: value.get("author").and_then(user),
        source_branch: branch(&source),
        target_branch: branch(&destination),
        updated_at: text(value, "updated_on"),
        web_url: html_link(value),
        checks: None,
        review_state: None,
        labels: Vec::new(),
        is_fork,
    }
}

/// Decisions of the participants (approved, changes requested), plus the requested reviewers.
fn reviewers(value: &Value) -> Vec<PrReviewer> {
    let mut result: Vec<PrReviewer> = Vec::new();
    for entry in list(value, "participants") {
        let Some(who) = entry.get("user").and_then(user) else { continue };
        let state = match (opt_text(entry, "state").as_deref(), flag(entry, "approved")) {
            (Some("approved"), _) | (_, true) => Some(PrReviewState::Approved),
            (Some("changes_requested"), _) => Some(PrReviewState::ChangesRequested),
            _ if text(entry, "role") == "REVIEWER" => None,
            // Someone who only commented.
            _ => continue,
        };
        result.push(PrReviewer { user: who, state });
    }
    for person in list(value, "reviewers").iter().filter_map(user) {
        if !result.iter().any(|r| r.user.login == person.login) {
            result.push(PrReviewer { user: person, state: None });
        }
    }
    result
}

fn status_state(state: &str) -> CheckRunState {
    match state {
        "SUCCESSFUL" => CheckRunState::Passing,
        "INPROGRESS" => CheckRunState::Pending,
        "STOPPED" => CheckRunState::Skipped,
        _ => CheckRunState::Failing,
    }
}

/// Build statuses of the pull request (`…/pullrequests/{id}/statuses`).
async fn checks(core: &Core, api: &Api, repo: &RepoPath, number: u64) -> CoreResult<Vec<PrCheck>> {
    Ok(all_of(core, api, &format!("{}/statuses?pagelen={MAX_PAGELEN}", pr_path(repo, number)))
        .await?
        .iter()
        .map(|status| PrCheck { name: opt_text(status, "name").unwrap_or_else(|| text(status, "key")), state: status_state(&text(status, "state")), url: opt_text(status, "url") })
        .collect())
}

/// A file with "merge conflict" in the diffstat: not mergeable. Bitbucket says nothing else about it.
async fn mergeable(core: &Core, api: &Api, repo: &RepoPath, number: u64) -> Option<bool> {
    let files = all_of(core, api, &format!("{}/diffstat?pagelen=100", pr_path(repo, number))).await.ok()?;
    Some(!files.iter().any(|file| text(file, "status") == "merge conflict"))
}

/// `GET …/pullrequests` (the list holds no participants: each entry is read once more, in parallel,
/// together with its statuses).
pub async fn pr_list(core: &Core, api: &Api, repo: &RepoPath, state: PrListState, paging: Paging) -> CoreResult<PrPage> {
    let states: &[&str] = match state {
        PrListState::Open => &["OPEN"],
        PrListState::Merged => &["MERGED"],
        PrListState::Closed => &["DECLINED", "SUPERSEDED"],
        PrListState::All => &["OPEN", "MERGED", "DECLINED", "SUPERSEDED"],
    };
    let mut params: Vec<(&str, String)> = states.iter().map(|s| ("state", s.to_string())).collect();
    params.extend([("sort", "-updated_on".to_string()), ("pagelen", paging.per_page.min(MAX_PAGELEN).to_string()), ("page", paging.page.to_string())]);
    let (values, next_page) = page_of(core, api, &with_query(&format!("{}/pullrequests", repo_path(repo)), &params)).await.map_err(|e| not_found_as(e, missing_repo(repo)))?;
    let mut items: Vec<PrSummary> = values.iter().map(pr_summary).collect();
    let numbers: Vec<u64> = items.iter().map(|item| item.number).collect();
    let extras = parallel(numbers, |number| {
        let (core, api, repo) = (core.clone(), api.clone(), repo.clone());
        async move {
            let single = pr_raw(&core, &api, &repo, number).await.ok();
            let checks = checks(&core, &api, &repo, number).await.ok().and_then(|c| summarize_checks(&c));
            let review = single.as_ref().and_then(|value| review_summary(&reviewers(value)));
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
    api.get_json(core, &pr_path(repo, number)).await.map_err(|e| not_found_as(e, pr_not_found(repo, number)))
}

pub async fn pr_head(core: &Core, api: &Api, repo: &RepoPath, number: u64) -> CoreResult<PrSummary> {
    Ok(pr_summary(&pr_raw(core, api, repo, number).await?))
}

fn comment(value: &Value) -> HostComment {
    let inline = value.get("inline").filter(|i| i.is_object());
    HostComment {
        id: number(value, "id").to_string(),
        author: value.get("user").and_then(user),
        body: value.get("content").map(|c| text(c, "raw")).unwrap_or_default(),
        created_at: text(value, "created_on"),
        path: inline.and_then(|i| opt_text(i, "path")),
        line: inline.and_then(|i| i.get("to").and_then(Value::as_u64).or_else(|| i.get("from").and_then(Value::as_u64))).and_then(|n| u32::try_from(n).ok()),
    }
}

/// "Jonas Weber <jonas@example.org>" → "Jonas Weber"; otherwise the linked user.
fn author_name(commit: &Value) -> String {
    let author = commit.get("author").cloned().unwrap_or(Value::Null);
    let raw = text(&author, "raw");
    match raw.split_once(" <") {
        Some((name, _)) if !name.trim().is_empty() => name.trim().to_string(),
        _ => author.get("user").map(|u| text(u, "display_name")).filter(|n| !n.is_empty()).unwrap_or(raw),
    }
}

pub async fn pr_get(core: &Core, api: &Api, repo: &RepoPath, number: u64) -> CoreResult<PrDetails> {
    let value = pr_raw(core, api, repo, number).await?;
    let path = pr_path(repo, number);
    let mut summary = pr_summary(&value);
    let reviewers = reviewers(&value);
    summary.review_state = review_summary(&reviewers);
    let mut comments: Vec<HostComment> = all_of(core, api, &format!("{path}/comments?pagelen=100")).await?.iter().filter(|c| !flag(c, "deleted")).map(comment).collect();
    comments.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    let commits = all_of(core, api, &format!("{path}/commits?pagelen=100"))
        .await?
        .iter()
        .map(|c| PrCommit { sha: text(c, "hash"), summary: first_line(&text(c, "message")), author_name: author_name(c), authored_at: text(c, "date") })
        .collect();
    let check_runs = checks(core, api, repo, number).await.unwrap_or_default();
    summary.checks = summarize_checks(&check_runs);
    let open = summary.state == PrState::Open;
    let head_sha = value.get("source").and_then(|s| s.get("commit")).map(|c| text(c, "hash")).unwrap_or_default();
    Ok(PrDetails {
        summary,
        body: text(&value, "description"),
        reviewers,
        comments,
        commits,
        mergeable: if open { mergeable(core, api, repo, number).await } else { None },
        check_runs,
        head_sha,
    })
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/// Reviewers by name and labels: Bitbucket's API has neither in a form the app can fill.
fn refuse_extras(reviewers: &[String], labels: &[String]) -> CoreResult<()> {
    if !labels.is_empty() {
        return Err(CoreError::new(ErrorCode::HostUnsupported, "Bitbucket has no labels for pull requests."));
    }
    if !reviewers.is_empty() {
        return Err(CoreError::new(ErrorCode::HostUnsupported, "On Bitbucket, reviewers can only be added on the website."));
    }
    Ok(())
}

/// "There is already one" – Bitbucket words it as "only one … may be open".
fn duplicate(error: &CoreError) -> bool {
    already_exists(error) || (error.code == ErrorCode::HostRejected && error.git_output.as_deref().is_some_and(|d| d.to_ascii_lowercase().contains("only one pull request")))
}

/// `POST …/pullrequests`
pub async fn pr_create(core: &Core, api: &Api, repo: &RepoPath, new: NewPr<'_>) -> CoreResult<PrSummary> {
    refuse_extras(new.reviewers, new.labels)?;
    let body = json!({
        "title": new.title,
        "description": new.body,
        "source": { "branch": { "name": new.source_branch } },
        "destination": { "branch": { "name": new.target_branch } },
        "draft": new.draft,
    });
    let created: Value = api
        .send_json(core, Method::Post, &format!("{}/pullrequests", repo_path(repo)), &body)
        .await
        .map_err(|e| {
            if duplicate(&e) {
                CoreError { code: ErrorCode::NameExists, message: format!("There is already an open pull request for the branch “{}”.", new.source_branch), git_output: e.git_output, retry_at: None }
            } else {
                not_found_as(e, missing_repo(repo))
            }
        })?
        .json()?;
    Ok(pr_summary(&created))
}

/// `PUT …/pullrequests/{id}` with only what changes.
pub async fn pr_update(core: &Core, api: &Api, repo: &RepoPath, number: u64, change: PrChange<'_>) -> CoreResult<PrSummary> {
    refuse_extras(change.reviewers.unwrap_or(&[]), change.labels.unwrap_or(&[]))?;
    let mut patch = serde_json::Map::new();
    if let Some(title) = change.title {
        patch.insert("title".into(), json!(title));
    }
    if let Some(body) = change.body {
        patch.insert("description".into(), json!(body));
    }
    if let Some(target) = change.target_branch {
        patch.insert("destination".into(), json!({ "branch": { "name": target } }));
    }
    if let Some(draft) = change.draft {
        patch.insert("draft".into(), json!(draft));
    }
    if patch.is_empty() {
        return pr_head(core, api, repo, number).await;
    }
    let value: Value = api.send_json(core, Method::Put, &pr_path(repo, number), &Value::Object(patch)).await.map_err(|e| not_found_as(e, pr_not_found(repo, number)))?.json()?;
    Ok(pr_summary(&value))
}

/// `POST …/pullrequests/{id}/comments`
pub async fn comment_create(core: &Core, api: &Api, repo: &RepoPath, number: u64, body: &str) -> CoreResult<HostComment> {
    let value: Value = api
        .send_json(core, Method::Post, &format!("{}/comments", pr_path(repo, number)), &json!({ "content": { "raw": body } }))
        .await
        .map_err(|e| not_found_as(e, pr_not_found(repo, number)))?
        .json()?;
    Ok(comment(&value))
}

/// `POST …/pullrequests/{id}/merge` with a merge commit or squashed; Bitbucket closes the branch itself.
pub async fn pr_merge(core: &Core, api: &Api, repo: &RepoPath, number: u64, method: PrMergeMethod, delete_branch: bool) -> CoreResult<PrSummary> {
    let strategy = match method {
        PrMergeMethod::Merge => "merge_commit",
        PrMergeMethod::Squash => "squash",
        PrMergeMethod::Rebase => return Err(CoreError::new(ErrorCode::HostUnsupported, "Bitbucket merges with a merge commit or squashed here – choose “Merge” or “Squash”.")),
    };
    let value: Value = api
        .send_json(core, Method::Post, &format!("{}/merge", pr_path(repo, number)), &json!({ "merge_strategy": strategy, "close_source_branch": delete_branch }))
        .await
        .map_err(|e| not_found_as(e, pr_not_found(repo, number)))?
        .json()?;
    Ok(pr_summary(&value))
}

/// Closing = declining (`POST …/decline`). A declined pull request cannot be reopened on Bitbucket.
pub async fn pr_set_open(core: &Core, api: &Api, repo: &RepoPath, number: u64, open: bool) -> CoreResult<PrSummary> {
    if open {
        return Err(CoreError::new(ErrorCode::HostUnsupported, "Bitbucket cannot reopen a declined pull request. Create a new one from the same branch."));
    }
    let value: Value = api.send_json(core, Method::Post, &format!("{}/decline", pr_path(repo, number)), &json!({})).await.map_err(|e| not_found_as(e, pr_not_found(repo, number)))?.json()?;
    Ok(pr_summary(&value))
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

fn issue_summary(value: &Value) -> IssueSummary {
    let number = number(value, "id");
    IssueSummary {
        number,
        key: format!("#{number}"),
        title: text(value, "title"),
        state: if OPEN_STATES.contains(&text(value, "state").as_str()) { IssueState::Open } else { IssueState::Closed },
        author: value.get("reporter").and_then(user),
        assignees: value.get("assignee").and_then(user).into_iter().collect(),
        // Bitbucket has no labels for issues; the kind (bug, task, …) comes closest.
        labels: opt_text(value, "kind").map(|name| HostLabel { name, color: None }).into_iter().collect(),
        updated_at: text(value, "updated_on"),
        web_url: html_link(value),
    }
}

/// The filter in Bitbucket's query language. Search text is a quoted string there: backslashes and
/// quotes are escaped, so it can never change the query.
fn issue_query(state: IssueListState, words: Option<&str>) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    match state {
        IssueListState::Open => parts.push("(state=\"new\" OR state=\"open\" OR state=\"on hold\")".to_string()),
        IssueListState::Closed => parts.push("(state!=\"new\" AND state!=\"open\" AND state!=\"on hold\")".to_string()),
        IssueListState::All => {}
    }
    if let Some(words) = words.map(str::trim).filter(|w| !w.is_empty()) {
        let quoted = words.replace('\\', "\\\\").replace('"', "\\\"");
        parts.push(format!("(title ~ \"{quoted}\" OR content.raw ~ \"{quoted}\")"));
    }
    (!parts.is_empty()).then(|| parts.join(" AND "))
}

/// A "not found" from the issue tracker: switched off in this repository – or the repository is missing.
async fn issues_switched_off(core: &Core, api: &Api, repo: &RepoPath, error: CoreError) -> CoreError {
    match repo_facts(core, api, repo).await {
        Ok(facts) if facts.has_issues == Some(false) => CoreError::new(ErrorCode::HostUnsupported, format!("The issue tracker is switched off for {} on {LABEL}.", repo.full())),
        Ok(_) => error,
        Err(e) => e,
    }
}

/// `GET …/issues` with `q` (state and search text), most recently changed first.
pub async fn issue_list(core: &Core, api: &Api, repo: &RepoPath, state: IssueListState, query: Option<&str>, paging: Paging) -> CoreResult<IssuePage> {
    let mut params = vec![("sort", "-updated_on".to_string()), ("pagelen", paging.per_page.min(MAX_PAGELEN).to_string()), ("page", paging.page.to_string())];
    if let Some(q) = issue_query(state, query) {
        params.push(("q", q));
    }
    match page_of(core, api, &with_query(&format!("{}/issues", repo_path(repo)), &params)).await {
        Ok((values, next_page)) => Ok(IssuePage { items: values.iter().map(issue_summary).collect(), next_page }),
        Err(e) if e.code == ErrorCode::HostNotFound => Err(issues_switched_off(core, api, repo, e).await),
        Err(e) => Err(e),
    }
}

pub async fn issue_get(core: &Core, api: &Api, repo: &RepoPath, number: u64) -> CoreResult<IssueDetails> {
    let path = format!("{}/issues/{number}", repo_path(repo));
    let value = api.get_json(core, &path).await.map_err(|e| not_found_as(e, || format!("Issue #{number} does not exist in {}.", repo.full())))?;
    // Status changes come as comments without text.
    let comments = all_of(core, api, &format!("{path}/comments?pagelen=100")).await?.iter().map(comment).filter(|c| !c.body.trim().is_empty()).collect();
    Ok(IssueDetails { summary: issue_summary(&value), body: value.get("content").map(|c| text(c, "raw")).unwrap_or_default(), comments })
}

// ---------------------------------------------------------------------------
// As a `Host`
// ---------------------------------------------------------------------------

pub struct BitbucketHost;

impl Host for BitbucketHost {
    fn kind(&self) -> HostKind {
        HostKind::Bitbucket
    }
    fn label(&self) -> &'static str {
        LABEL
    }
    fn pr_word(&self) -> &'static str {
        "pull request"
    }
    fn public_web(&self) -> Option<&'static str> {
        Some(BITBUCKET_WEB)
    }
    fn public_hosts(&self) -> &'static [&'static str] {
        &["bitbucket.org", "www.bitbucket.org", "api.bitbucket.org"]
    }
    /// The public API has its own server; the local test server serves it under `/2.0`.
    fn api_base(&self, web_base: &str) -> String {
        if web_base == BITBUCKET_WEB {
            API_WEB.to_string()
        } else {
            format!("{web_base}/2.0")
        }
    }
    fn check_base(&self, base: String, loopback: bool) -> CoreResult<String> {
        if loopback {
            Ok(base)
        } else {
            Err(CoreError::not_allowed("Forkyard connects to Bitbucket Cloud (bitbucket.org) only – Bitbucket Data Center has a different API."))
        }
    }
    fn request_headers(&self) -> &'static [(&'static str, &'static str)] {
        &[("accept", "application/json")]
    }
    fn authorization(&self, token: &str, username: Option<&str>) -> String {
        let pair = format!("{}:{token}", username.unwrap_or_default());
        format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(pair))
    }
    fn needs_username(&self) -> bool {
        true
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
            merge_methods: vec![PrMergeMethod::Merge, PrMergeMethod::Squash],
            delete_source_branch: true,
            pr_reopen: false,
            pr_reviewers: false,
            pr_labels: false,
            fork_checkout: false,
            releases: false,
        }
    }
    fn pr_ref(&self, _number: u64) -> Option<String> {
        None
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
    fn issue_list<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath, state: IssueListState, query: Option<&'a str>, paging: Paging) -> HostFuture<'a, IssuePage> {
        Box::pin(issue_list(core, api, repo, state, query, paging))
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
