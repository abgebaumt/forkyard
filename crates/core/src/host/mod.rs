//! Connection to hosts through their official, publicly documented APIs – with the user's own
//! token. Everything that differs between hosts is behind `trait Host`; `host(kind)` hands out
//! the implementation.
//!
//! - `detect`: recognises host, owner and name from a remote's URL.
//! - `github`, `gitlab`: the calls per host; both return the same types (`crate::model`).
//! - This module: accounts (table `hoster_accounts`, token in the keychain), the shared call
//!   path (`Api`) with error translation and paging, the mapping repository → host.
//!
//! The token lives only in the keychain (`hoster:<account ID>`), never reaches the UI
//! (there: the last four characters) and is removed from everything that goes into the log or
//! into error messages.

pub mod azure;
pub mod bitbucket;
pub mod detect;
pub mod gh_cli;
pub mod gitea;
pub mod github;
pub mod gitlab;

use std::future::Future;
use std::pin::Pin;

use serde_json::Value;

use crate::app::Core;
use crate::commands::remotes;
use crate::db;
use crate::db::hoster_accounts::{AccountFacts, HosterAccountRow};
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::http::{self, Method, Request, Response};
use crate::model::{
    AppChange, CheckRunState, ChecksState, HostCapabilities, HostComment, HostKind, HostRepoRef, HostUser, HosterAccount, IssueDetails, IssueListState, IssuePage,
    IssueSummary, PrCheck, PrDetails, PrListState, PrMergeMethod, PrPage, PrReviewState, PrReviewer, PrSummary,
};
use crate::secrets;
use crate::util;

pub use detect::Detected;

/// Entries per page when the UI doesn't ask for something else.
pub const DEFAULT_PER_PAGE: u32 = 20;
/// `Api::get_all` never loads more than this (comments, commits of a pull request).
pub(crate) const MAX_ITEMS: usize = 500;
/// Concurrent calls when enriching a list (checks, reviews per pull request).
const ENRICH_PARALLEL: usize = 6;

/// Keychain account for the token of a host account.
pub fn secret_account(account_id: &str) -> String {
    format!("hoster:{account_id}")
}

pub fn label(kind: HostKind) -> &'static str {
    host(kind).label()
}

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

pub(crate) fn text(value: &Value, key: &str) -> String {
    value.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

pub(crate) fn opt_text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string).filter(|s| !s.is_empty())
}

pub(crate) fn number(value: &Value, key: &str) -> u64 {
    value.get(key).and_then(Value::as_u64).unwrap_or(0)
}

pub(crate) fn flag(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

pub(crate) fn list<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// First line of a text.
pub(crate) fn first_line(text: &str) -> String {
    text.lines().next().unwrap_or("").trim().to_string()
}

/// Summarises individual checks: a failed one wins, then a running one.
pub(crate) fn summarize_checks(checks: &[PrCheck]) -> Option<ChecksState> {
    if checks.iter().any(|c| c.state == CheckRunState::Failing) {
        Some(ChecksState::Failing)
    } else if checks.iter().any(|c| c.state == CheckRunState::Pending) {
        Some(ChecksState::Pending)
    } else if checks.iter().any(|c| c.state == CheckRunState::Passing) {
        Some(ChecksState::Passing)
    } else {
        None
    }
}

/// Summarises the reviewers: requested changes win, then open requests, then approvals.
pub(crate) fn review_summary(reviewers: &[PrReviewer]) -> Option<PrReviewState> {
    let has = |state: Option<PrReviewState>| reviewers.iter().any(|r| r.state == state);
    if has(Some(PrReviewState::ChangesRequested)) {
        Some(PrReviewState::ChangesRequested)
    } else if has(None) {
        Some(PrReviewState::ReviewRequired)
    } else if has(Some(PrReviewState::Approved)) {
        Some(PrReviewState::Approved)
    } else if has(Some(PrReviewState::Commented)) {
        Some(PrReviewState::Commented)
    } else {
        None
    }
}

// ---------------------------------------------------------------------------
// What differs between hosts
// ---------------------------------------------------------------------------

/// A host call as the trait hands it out: boxed so that `dyn Host` works, `Send` so the commands
/// can await it on any thread.
pub type HostFuture<'a, T> = Pin<Box<dyn Future<Output = CoreResult<T>> + Send + 'a>>;

/// Which page of a list, and how many entries per page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Paging {
    pub page: u32,
    pub per_page: u32,
}

/// What the host says about a repository.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RepoFacts {
    pub default_branch: Option<String>,
    pub can_push: Option<bool>,
    pub fork_parent: Option<HostRepoRef>,
    /// `Some(false)`: the repository has its issue tracker switched off.
    pub has_issues: Option<bool>,
}

/// A new pull request, the same for every host.
pub struct NewPr<'a> {
    pub title: &'a str,
    pub body: &'a str,
    pub source_branch: &'a str,
    pub target_branch: &'a str,
    pub draft: bool,
    pub reviewers: &'a [String],
    pub labels: &'a [String],
}

/// Changes to a pull request; `None` = stays as it is.
pub struct PrChange<'a> {
    pub title: Option<&'a str>,
    pub body: Option<&'a str>,
    pub target_branch: Option<&'a str>,
    pub draft: Option<bool>,
    pub reviewers: Option<&'a [String]>,
    pub labels: Option<&'a [String]>,
}

/// A call this host cannot make: `host_unsupported`, before anything is sent.
pub(crate) fn unsupported<'a, T: Send + 'a>(label: &str, what: &str) -> HostFuture<'a, T> {
    let error = CoreError::new(ErrorCode::HostUnsupported, format!("{label} does not offer {what} through its API."));
    Box::pin(async move { Err(error) })
}

/// `owner/name` with exactly two levels (GitHub, Gitea, Bitbucket).
pub(crate) fn two_levels(path: &str) -> Option<RepoPath> {
    let (owner, name) = path.rsplit_once('/')?;
    (!owner.is_empty() && !name.is_empty() && !owner.contains('/')).then(|| RepoPath { owner: owner.to_string(), name: name.to_string() })
}

/// Everything that differs between hosts. `commands/host.rs`, the call path (`Api`) and the
/// detection only go through this trait; each host module implements it once.
pub trait Host: Sync {
    fn kind(&self) -> HostKind;
    /// Name for messages ("GitHub").
    fn label(&self) -> &'static str;
    /// What the host calls a pull request.
    fn pr_word(&self) -> &'static str;
    /// Web address of the public service; `None` if every organization has its own address.
    fn public_web(&self) -> Option<&'static str>;
    /// Server names that, entered as an address, mean the public service.
    fn public_hosts(&self) -> &'static [&'static str] {
        &[]
    }
    /// API address for a normalised web address.
    fn api_base(&self, web_base: &str) -> String;
    /// API paths users sometimes paste with the address (`api/v4`); they are not part of it.
    fn api_suffixes(&self) -> &'static [&'static str] {
        &[]
    }
    /// Last check of a normalised address that is not the public service.
    fn check_base(&self, base: String, _loopback: bool) -> CoreResult<String> {
        Ok(base)
    }
    /// Headers every call carries besides `authorization`.
    fn request_headers(&self) -> &'static [(&'static str, &'static str)];
    /// Value of the `authorization` header.
    fn authorization(&self, token: &str, _username: Option<&str>) -> String {
        format!("Bearer {token}")
    }
    /// Whether the account needs a user name besides the token.
    fn needs_username(&self) -> bool {
        false
    }
    /// The repository from a remote's path below the web address; `None` = no repository there.
    fn split_repo_path(&self, path: &str) -> Option<RepoPath>;
    /// The repository's page at the host.
    fn repo_web_url(&self, web_base: &str, repo: &RepoPath) -> String {
        format!("{web_base}/{}/{}", repo.owner, repo.name)
    }
    fn capabilities(&self) -> HostCapabilities;
    /// Ref under which the host offers the head of a pull request from a fork; `None` = none.
    fn pr_ref(&self, number: u64) -> Option<String>;
    /// Local branch for a pull request from a fork.
    fn fork_branch(&self, number: u64) -> String {
        format!("pr-{number}")
    }
    /// Folders in the working directory where this host keeps pull request templates.
    fn template_folders(&self) -> &'static [&'static str] {
        &[]
    }

    /// Checks the token and says whom it belongs to.
    fn account_facts<'a>(&'a self, core: &'a Core, api: &'a Api) -> HostFuture<'a, AccountFacts>;
    fn repo_facts<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath) -> HostFuture<'a, RepoFacts>;
    fn pr_list<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath, state: PrListState, paging: Paging) -> HostFuture<'a, PrPage>;
    fn pr_get<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath, number: u64) -> HostFuture<'a, PrDetails>;
    /// Only the header data of a pull request (without checks and reviews).
    fn pr_head<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath, number: u64) -> HostFuture<'a, PrSummary>;
    fn issue_list<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath, state: IssueListState, query: Option<&'a str>, paging: Paging) -> HostFuture<'a, IssuePage>;
    fn issue_get<'a>(&'a self, core: &'a Core, api: &'a Api, repo: &'a RepoPath, number: u64) -> HostFuture<'a, IssueDetails>;

    fn pr_create<'a>(&'a self, _core: &'a Core, _api: &'a Api, _repo: &'a RepoPath, _new: NewPr<'a>) -> HostFuture<'a, PrSummary> {
        unsupported(self.label(), "creating pull requests")
    }
    fn pr_update<'a>(&'a self, _core: &'a Core, _api: &'a Api, _repo: &'a RepoPath, _number: u64, _change: PrChange<'a>) -> HostFuture<'a, PrSummary> {
        unsupported(self.label(), "changing pull requests")
    }
    fn pr_comment<'a>(&'a self, _core: &'a Core, _api: &'a Api, _repo: &'a RepoPath, _number: u64, _body: &'a str) -> HostFuture<'a, HostComment> {
        unsupported(self.label(), "comments")
    }
    fn pr_merge<'a>(&'a self, _core: &'a Core, _api: &'a Api, _repo: &'a RepoPath, _number: u64, _method: PrMergeMethod, _delete_branch: bool) -> HostFuture<'a, PrSummary> {
        unsupported(self.label(), "merging")
    }
    fn pr_set_open<'a>(&'a self, _core: &'a Core, _api: &'a Api, _repo: &'a RepoPath, _number: u64, _open: bool) -> HostFuture<'a, PrSummary> {
        unsupported(self.label(), "closing and reopening pull requests")
    }
    fn issue_create<'a>(&'a self, _core: &'a Core, _api: &'a Api, _repo: &'a RepoPath, _title: &'a str, _body: &'a str) -> HostFuture<'a, IssueSummary> {
        unsupported(self.label(), "creating issues")
    }
}

/// The implementation for a host kind.
pub fn host(kind: HostKind) -> &'static dyn Host {
    match kind {
        HostKind::Github => &github::GithubHost,
        HostKind::Gitlab => &gitlab::GitlabHost,
        HostKind::Gitea => &gitea::GiteaHost,
        HostKind::Bitbucket => &bitbucket::BitbucketHost,
        HostKind::AzureDevops => &azure::AzureHost,
    }
}

// ---------------------------------------------------------------------------
// The call path
// ---------------------------------------------------------------------------

/// A repository on the host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoPath {
    pub owner: String,
    pub name: String,
}

impl RepoPath {
    /// `owner/name`.
    pub fn full(&self) -> String {
        format!("{}/{}", self.owner, self.name)
    }
}

/// Access to an account: addresses, token, error translation.
#[derive(Clone)]
pub struct Api {
    pub kind: HostKind,
    pub account_id: String,
    pub web_base: String,
    pub api_base: String,
    token: String,
    /// User name for Basic authentication (only hosts with `needs_username`).
    pub(crate) username: Option<String>,
    /// For assigning the log entries.
    pub repo_id: Option<String>,
    /// The account last carried an error; a success clears it.
    had_error: bool,
}

impl Api {
    pub fn new(kind: HostKind, account_id: &str, web_base: &str, token: String) -> Api {
        Api {
            kind,
            account_id: account_id.to_string(),
            web_base: web_base.to_string(),
            api_base: host(kind).api_base(web_base),
            token,
            username: None,
            repo_id: None,
            had_error: false,
        }
    }

    pub fn label(&self) -> &'static str {
        label(self.kind)
    }

    /// Full address for an API path (`/user`); full addresses (from `Link`) stay as they
    /// are – but only if they belong to the same API.
    fn url(&self, path: &str) -> CoreResult<String> {
        if path.contains("://") {
            if !path.starts_with(&format!("{}/", self.api_base)) {
                return Err(CoreError::unknown(format!("{} redirected to a different address; the request was not sent.", self.label())));
            }
            return Ok(path.to_string());
        }
        Ok(format!("{}{path}", self.api_base))
    }

    fn request(&self, method: Method, path: &str) -> CoreResult<Request> {
        let hoster = host(self.kind);
        let authorization = hoster.authorization(&self.token, self.username.as_deref());
        // Basic authentication carries the token encoded – that form is just as secret.
        let credential = authorization.split_once(' ').map(|(_, value)| value.to_string()).unwrap_or_default();
        let mut request = Request::new(method, self.url(path)?, self.label())
            .secret_header("authorization", authorization, &self.token)
            .alias(self.web_base.clone())
            .repo(self.repo_id.as_deref());
        if !credential.is_empty() && credential != self.token {
            request = request.secret(&credential);
        }
        for (name, value) in hoster.request_headers() {
            request = request.header(name, *value);
        }
        Ok(request)
    }

    /// Sends the call and translates error statuses into `CoreError`.
    async fn send(&self, core: &Core, request: Request) -> CoreResult<Response> {
        let response = http::send(core, request).await?;
        if response.is_success() {
            if self.had_error {
                self.note_account_error(core, None);
            }
            return Ok(response);
        }
        let error = self.status_error(&response);
        if response.status == 401 {
            self.note_account_error(core, Some(&error.message));
        }
        Err(error)
    }

    fn note_account_error(&self, core: &Core, message: Option<&str>) {
        if let Ok(true) = core.db.with(|c| db::hoster_accounts::set_last_error(c, &self.account_id, message)) {
            core.emit_app_changed(&[AppChange::HostAccounts]);
        }
    }

    /// The host's message for an error status, without secrets and truncated.
    fn provider_message(&self, response: &Response) -> String {
        let parsed: Option<Value> = serde_json::from_slice(&response.body).ok();
        let mut parts: Vec<String> = Vec::new();
        if let Some(value) = &parsed {
            // Bitbucket nests it: `{ "type": "error", "error": { "message": … } }`.
            if let Some(message) = value.get("error").and_then(|e| e.get("message")).and_then(Value::as_str).filter(|m| !m.trim().is_empty()) {
                parts.push(message.trim().to_string());
            }
            if parts.is_empty() {
                for key in ["message", "error_description", "error"] {
                    match value.get(key) {
                        Some(Value::String(s)) if !s.trim().is_empty() => parts.push(s.trim().to_string()),
                        Some(Value::Array(items)) => parts.extend(items.iter().filter_map(|i| i.as_str().map(str::to_string))),
                        Some(Value::Object(map)) => {
                            for (field, detail) in map {
                                let detail = match detail {
                                    Value::Array(items) => items.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "),
                                    other => other.as_str().unwrap_or_default().to_string(),
                                };
                                parts.push(format!("{field}: {detail}"));
                            }
                        }
                        _ => {}
                    }
                    if !parts.is_empty() {
                        break;
                    }
                }
            }
            // GitHub gives details in `errors`.
            for item in list(value, "errors") {
                let detail = item.as_str().map(str::to_string).or_else(|| opt_text(item, "message")).or_else(|| {
                    let (field, code) = (text(item, "field"), text(item, "code"));
                    (!field.is_empty() || !code.is_empty()).then(|| format!("{field} {code}").trim().to_string())
                });
                if let Some(detail) = detail {
                    parts.push(detail);
                }
            }
        }
        let joined = parts.join(" – ");
        util::truncate_str(&secrets::scrub(&joined, std::slice::from_ref(&self.token)), 600)
    }

    fn status_error(&self, response: &Response) -> CoreError {
        let label = self.label();
        let detail = self.provider_message(response);
        let with_detail = |error: CoreError| if detail.is_empty() { error } else { error.with_git_output(&detail) };
        if response.is_rate_limited() {
            let retry_at = response.retry_at();
            let message = match &retry_at {
                Some(at) => format!("The {label} rate limit has been reached. You can continue at {at}."),
                None => format!("The {label} rate limit has been reached. Try again later."),
            };
            return with_detail(CoreError::new(ErrorCode::HostRateLimited, message).with_retry_at(retry_at));
        }
        let error = match response.status {
            401 => CoreError::new(
                ErrorCode::HostAuthFailed,
                format!("{label} rejects the token: it is invalid, expired or revoked. Reconnect the account."),
            ),
            // The token is valid but not allowed to do this: a different situation from a rejected token (401).
            403 => CoreError::new(ErrorCode::HostForbidden, format!("{label} denies access: the token lacks the permission for this.")),
            404 | 410 => CoreError::new(ErrorCode::HostNotFound, format!("{label} could not find this – or the token is not allowed to see it.")),
            405 | 406 | 409 | 422 | 400 => {
                let reason = if detail.is_empty() { format!("Status {}", response.status) } else { detail.clone() };
                CoreError::new(ErrorCode::HostRejected, format!("{label} rejected the request: {reason}"))
            }
            status if status >= 500 => CoreError::unknown(format!("{label} reports a server error ({status}). Try again later.")),
            status => CoreError::unknown(format!("{label} responded unexpectedly with status {status}.")),
        };
        with_detail(error)
    }

    pub async fn get(&self, core: &Core, path: &str) -> CoreResult<Response> {
        // Reads are cached: unchanged responses don't count against the limit next time.
        self.send(core, self.request(Method::Get, path)?.cached(self.account_id.clone())).await
    }

    pub async fn get_json(&self, core: &Core, path: &str) -> CoreResult<Value> {
        self.get(core, path).await?.json()
    }

    /// One page of a list together with the number of the next page.
    pub async fn get_page(&self, core: &Core, path: &str) -> CoreResult<(Vec<Value>, Option<u32>)> {
        let response = self.get(core, path).await?;
        let next = response.next_page();
        Ok((as_items(self.label(), response.json()?)?, next))
    }

    /// All pages of a list (up to `MAX_ITEMS` entries), via the `Link` header.
    pub async fn get_all(&self, core: &Core, path: &str) -> CoreResult<Vec<Value>> {
        let mut items: Vec<Value> = Vec::new();
        let mut next = Some(path.to_string());
        while let Some(path) = next {
            let response = self.get(core, &path).await?;
            next = response.next_url();
            items.extend(as_items(self.label(), response.json()?)?);
            if items.len() >= MAX_ITEMS {
                items.truncate(MAX_ITEMS);
                break;
            }
        }
        Ok(items)
    }

    pub async fn send_json(&self, core: &Core, method: Method, path: &str, body: &Value) -> CoreResult<Response> {
        self.send(core, self.request(method, path)?.json(body)).await
    }

    /// `POST` with a JSON Patch document (Azure DevOps work items).
    pub async fn send_json_patch(&self, core: &Core, path: &str, body: &Value) -> CoreResult<Response> {
        self.send(core, self.request(Method::Post, path)?.json_with_type(body, "application/json-patch+json")).await
    }

    pub async fn delete(&self, core: &Core, path: &str) -> CoreResult<Response> {
        self.send(core, self.request(Method::Delete, path)?).await
    }
}

fn as_items(label: &str, value: Value) -> CoreResult<Vec<Value>> {
    match value {
        Value::Array(items) => Ok(items),
        _ => Err(CoreError::unknown(format!("The response from {label} could not be read (unexpected structure)."))),
    }
}

/// Turns a "not found" from the host into a message that says what is missing.
pub(crate) fn not_found_as(error: CoreError, what: impl FnOnce() -> String) -> CoreError {
    if error.code == ErrorCode::HostNotFound {
        CoreError { code: ErrorCode::HostNotFound, message: what(), git_output: error.git_output, retry_at: None }
    } else {
        error
    }
}

/// Recognises "one already exists for this" in a rejection (all hosts word it like that).
pub(crate) fn already_exists(error: &CoreError) -> bool {
    error.code == ErrorCode::HostRejected && error.git_output.as_deref().is_some_and(|detail| detail.to_ascii_lowercase().contains("already exists"))
}

/// Runs `work` for each element, at most `ENRICH_PARALLEL` at a time, and returns the
/// results in input order.
pub(crate) async fn parallel<I, T, F, Fut>(inputs: Vec<I>, work: F) -> Vec<Option<T>>
where
    I: Send + 'static,
    T: Send + 'static,
    F: Fn(I) -> Fut,
    Fut: std::future::Future<Output = T> + Send + 'static,
{
    let limit = std::sync::Arc::new(tokio::sync::Semaphore::new(ENRICH_PARALLEL));
    let mut tasks = tokio::task::JoinSet::new();
    let count = inputs.len();
    for (index, input) in inputs.into_iter().enumerate() {
        let limit = limit.clone();
        let job = work(input);
        tasks.spawn(async move {
            let _permit = limit.acquire_owned().await;
            (index, job.await)
        });
    }
    let mut results: Vec<Option<T>> = (0..count).map(|_| None).collect();
    while let Some(done) = tasks.join_next().await {
        if let Ok((index, value)) = done {
            results[index] = Some(value);
        }
    }
    results
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

fn account_rows(core: &Core) -> CoreResult<(String, Vec<HosterAccountRow>)> {
    core.db.with(|c| {
        let profile_id = db::profiles::active_id(c)?;
        let rows = db::hoster_accounts::list(c, &profile_id)?;
        Ok((profile_id, rows))
    })
}

pub fn accounts(core: &Core) -> CoreResult<Vec<HosterAccount>> {
    Ok(account_rows(core)?.1.iter().map(HosterAccountRow::to_model).collect())
}

fn check_token(token: &str) -> CoreResult<String> {
    let token = token.trim();
    if token.is_empty() {
        return Err(CoreError::not_allowed("The token is missing."));
    }
    if token.len() > 4096 || token.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(CoreError::not_allowed("The token contains spaces or control characters – paste it without line breaks."));
    }
    Ok(token.to_string())
}

async fn facts(core: &Core, api: &Api) -> CoreResult<AccountFacts> {
    host(api.kind).account_facts(core, api).await
}

/// Checks the token against the API, stores it in the keychain and records the account. An
/// existing account for the same address is replaced (new token).
pub async fn connect(core: &Core, kind: HostKind, base_url: Option<String>, token: String) -> CoreResult<HosterAccount> {
    connect_as(core, kind, base_url, None, token).await
}

/// Like `connect`, with the user name some hosts need besides the token (Bitbucket). Hosts that
/// only need the token ignore it.
pub async fn connect_as(core: &Core, kind: HostKind, base_url: Option<String>, username: Option<String>, token: String) -> CoreResult<HosterAccount> {
    let token = check_token(&token)?;
    let username = check_username(host(kind), username)?;
    let web_base = detect::normalize_base_url(kind, base_url.as_deref())?;
    if !secrets::available(core).await {
        return Err(CoreError::io(
            "The operating system's keychain is not available. Without it, Forkyard does not store any token – the account was not connected.",
        ));
    }
    // Check first, then store: a rejected token leaves nothing behind.
    let mut probe = Api::new(kind, "", &web_base, token.clone());
    probe.username = username.clone();
    let facts = facts(core, &probe).await.map_err(|e| {
        not_found_as(e, || format!("No {} API responds at {web_base}. Check the address.", label(kind)))
    })?;
    let profile_id = core.active_profile_id()?;
    let row = core.db.with(|c| db::hoster_accounts::upsert(c, &profile_id, kind, &web_base, username.as_deref(), &secrets::hint(&token), &facts))?;
    if let Err(e) = secrets::set(core, &secret_account(&row.id), &token).await {
        // Without a token the account would be useless.
        let _ = core.db.with(|c| db::hoster_accounts::delete(c, &profile_id, &row.id));
        return Err(e);
    }
    http::clear_cache(core);
    core.emit_app_changed(&[AppChange::HostAccounts]);
    Ok(row.to_model())
}

/// The user name for Basic authentication: required where the host needs one, never containing a
/// colon (it separates name and token) or spaces; dropped for hosts that only need the token.
fn check_username(hoster: &dyn Host, username: Option<String>) -> CoreResult<Option<String>> {
    if !hoster.needs_username() {
        return Ok(None);
    }
    let name = username.as_deref().map(str::trim).unwrap_or("");
    if name.is_empty() {
        return Err(CoreError::not_allowed(format!("{} needs your user name (or account e-mail) besides the token.", hoster.label())));
    }
    if name.len() > 256 || name.chars().any(|c| c == ':' || c.is_whitespace() || c.is_control()) {
        return Err(CoreError::not_allowed("The user name must not contain spaces, colons or control characters."));
    }
    Ok(Some(name.to_string()))
}

/// Disconnects the account: entry and token are deleted. Unknown ID: no error.
pub async fn disconnect(core: &Core, account_id: &str) -> CoreResult<Vec<HosterAccount>> {
    let profile_id = core.active_profile_id()?;
    secrets::delete(core, &secret_account(account_id)).await?;
    let removed = core.db.with(|c| db::hoster_accounts::delete(c, &profile_id, account_id))?;
    http::clear_cache(core);
    if removed {
        core.emit_app_changed(&[AppChange::HostAccounts]);
    }
    accounts(core)
}

fn find_account(core: &Core, account_id: &str) -> CoreResult<HosterAccountRow> {
    core.db
        .with(|c| {
            let profile_id = db::profiles::active_id(c)?;
            db::hoster_accounts::get(c, &profile_id, account_id)
        })?
        .ok_or_else(|| CoreError::not_found("This account does not exist (anymore)."))
}

/// Access to a stored account. `host_auth_failed` if the token is missing from the keychain.
pub async fn api_for_account(core: &Core, row: &HosterAccountRow) -> CoreResult<Api> {
    let token = secrets::get(core, &secret_account(&row.id)).await?.ok_or_else(|| {
        CoreError::new(
            ErrorCode::HostAuthFailed,
            format!("The token for {} is missing from the keychain. Reconnect the account.", row.base_url),
        )
    })?;
    let mut api = Api::new(row.kind, &row.id, &row.base_url, token);
    api.username = row.username.clone();
    api.had_error = row.last_error.is_some();
    Ok(api)
}

/// Checks the stored token again and refreshes name, avatar and permissions. If the host
/// rejects it or is unreachable, the account comes back with `lastError` – not an error.
pub async fn check(core: &Core, account_id: &str) -> CoreResult<HosterAccount> {
    let row = find_account(core, account_id)?;
    let outcome = match api_for_account(core, &row).await {
        Ok(api) => facts(core, &api).await,
        Err(e) => Err(e),
    };
    match outcome {
        Ok(facts) => core.db.with(|c| db::hoster_accounts::set_facts(c, &row.id, &facts))?,
        Err(e) => {
            core.db.with(|c| db::hoster_accounts::set_last_error(c, &row.id, Some(&e.message)))?;
        }
    }
    core.emit_app_changed(&[AppChange::HostAccounts]);
    Ok(find_account(core, account_id)?.to_model())
}

// ---------------------------------------------------------------------------
// Repository → host
// ---------------------------------------------------------------------------

/// The repository on the host together with the remote it was recognised from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoHost {
    pub remote: String,
    pub detected: Detected,
}

/// Finds the remote that belongs to a host: the named one, else `origin`, else the first
/// recognised one (by name). `None`: no remote belongs to a supported host or a connected instance.
pub async fn resolve(core: &Core, repo_id: &str, remote: Option<&str>) -> CoreResult<Option<RepoHost>> {
    let (_, accounts) = account_rows(core)?;
    let all = remotes::read_remotes(core, repo_id).await?;
    let of = |r: &remotes::RawRemote| detect::detect(&r.fetch_url, &accounts).map(|detected| RepoHost { remote: r.name.clone(), detected });
    if let Some(name) = remote.map(str::trim).filter(|n| !n.is_empty()) {
        let wanted = all.iter().find(|r| r.name == name).ok_or_else(|| CoreError::not_found(format!("The remote “{name}” does not exist.")))?;
        return Ok(of(wanted));
    }
    if let Some(found) = all.iter().find(|r| r.name == "origin").and_then(of) {
        return Ok(Some(found));
    }
    Ok(all.iter().find_map(of))
}

/// What the commands for pull requests and issues need.
pub struct RepoApi {
    pub api: Api,
    pub repo: RepoPath,
    pub remote: String,
}

/// Access to the repository on the host. Errors: `host_unsupported` (no remote on a
/// supported host), `host_not_connected` (no account), `host_auth_failed` (token missing).
pub async fn api_for_repo(core: &Core, repo_id: &str, remote: Option<&str>) -> CoreResult<RepoApi> {
    let Some(found) = resolve(core, repo_id, remote).await? else {
        return Err(CoreError::new(
            ErrorCode::HostUnsupported,
            "None of this repository's remotes is on a supported host or a connected self-hosted instance.",
        ));
    };
    let Some(account) = &found.detected.account else {
        return Err(CoreError::new(
            ErrorCode::HostNotConnected,
            format!("No account is connected for {}. You can connect one in Settings under Integrations.", found.detected.web_base),
        ));
    };
    let mut api = api_for_account(core, account).await?;
    api.repo_id = Some(repo_id.to_string());
    Ok(RepoApi { api, repo: RepoPath { owner: found.detected.owner, name: found.detected.name }, remote: found.remote })
}

/// Where pull request templates are looked for, in this order: the hosts' own folders, then the
/// root directory and `docs/`.
pub fn template_folders() -> Vec<&'static str> {
    let mut folders: Vec<&'static str> = Vec::new();
    for kind in HostKind::ALL.iter().copied() {
        for folder in host(kind).template_folders() {
            if !folders.contains(folder) {
                folders.push(folder);
            }
        }
    }
    folders.extend(["", "docs"]);
    folders
}

/// Colour of a label as `#rrggbb` (GitHub returns it without `#`).
pub(crate) fn color(raw: Option<String>) -> Option<String> {
    let raw = raw?;
    let hex = raw.trim().trim_start_matches('#');
    (hex.len() == 6 && hex.bytes().all(|b| b.is_ascii_hexdigit())).then(|| format!("#{}", hex.to_ascii_lowercase()))
}

pub(crate) fn host_user(login: String, name: Option<String>, avatar_url: Option<String>) -> Option<HostUser> {
    (!login.is_empty()).then_some(HostUser { login, name, avatar_url })
}

#[cfg(test)]
mod tests;
