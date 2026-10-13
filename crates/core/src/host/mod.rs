//! Connection to hosts through their official, publicly documented APIs – with the user's own
//! token: GitHub (REST, also GitHub Enterprise Server) and GitLab (REST v4, also self-hosted
//! instances). No other hosts are contacted.
//!
//! - `detect`: recognises host, owner and name from a remote's URL.
//! - `github`, `gitlab`: the calls per host; both return the same types (`crate::model`).
//! - This module: accounts (table `hoster_accounts`, token in the keychain), the shared call
//!   path (`Api`) with error translation and paging, the mapping repository → host.
//!
//! The token lives only in the keychain (`hoster:<account ID>`), never reaches the UI
//! (there: the last four characters) and is removed from everything that goes into the log or
//! into error messages.

pub mod detect;
pub mod gh_cli;
pub mod github;
pub mod gitlab;

use serde_json::Value;

use crate::app::Core;
use crate::commands::remotes;
use crate::db;
use crate::db::hoster_accounts::{AccountFacts, HosterAccountRow};
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::http::{self, Method, Request, Response};
use crate::model::{AppChange, ChecksState, CheckRunState, HostKind, HostUser, HosterAccount, PrCheck};
use crate::secrets;
use crate::util;

pub use detect::Detected;

/// Entries per page when the UI doesn't ask for something else.
pub const DEFAULT_PER_PAGE: u32 = 20;
/// `Api::get_all` never loads more than this (comments, commits of a pull request).
const MAX_ITEMS: usize = 500;
/// Concurrent calls when enriching a list (checks, reviews per pull request).
const ENRICH_PARALLEL: usize = 6;

/// Keychain account for the token of a host account.
pub fn secret_account(account_id: &str) -> String {
    format!("hoster:{account_id}")
}

pub fn label(kind: HostKind) -> &'static str {
    match kind {
        HostKind::Github => "GitHub",
        HostKind::Gitlab => "GitLab",
    }
}

/// What the host calls a "pull request".
pub fn pr_word(kind: HostKind) -> &'static str {
    match kind {
        HostKind::Github => "pull request",
        HostKind::Gitlab => "merge request",
    }
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
            api_base: detect::api_base(kind, web_base),
            token,
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
        let mut request = Request::new(method, self.url(path)?, self.label())
            .secret_header("authorization", format!("Bearer {}", self.token), &self.token)
            .alias(self.web_base.clone())
            .repo(self.repo_id.as_deref());
        request = match self.kind {
            HostKind::Github => request.header("accept", "application/vnd.github+json").header("x-github-api-version", "2022-11-28"),
            HostKind::Gitlab => request.header("accept", "application/json"),
        };
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
    match api.kind {
        HostKind::Github => github::account_facts(core, api).await,
        HostKind::Gitlab => gitlab::account_facts(core, api).await,
    }
}

/// Checks the token against the API (`/user`), stores it in the keychain and records the
/// account. An existing account for the same address is replaced (new token).
pub async fn connect(core: &Core, kind: HostKind, base_url: Option<String>, token: String) -> CoreResult<HosterAccount> {
    let token = check_token(&token)?;
    let web_base = detect::normalize_base_url(kind, base_url.as_deref())?;
    if !secrets::available(core).await {
        return Err(CoreError::io(
            "The operating system's keychain is not available. Without it, Forkyard does not store any token – the account was not connected.",
        ));
    }
    // Check first, then store: a rejected token leaves nothing behind.
    let probe = Api::new(kind, "", &web_base, token.clone());
    let facts = facts(core, &probe).await.map_err(|e| {
        not_found_as(e, || format!("No {} API responds at {web_base}. Check the address.", label(kind)))
    })?;
    let profile_id = core.active_profile_id()?;
    let row = core.db.with(|c| db::hoster_accounts::upsert(c, &profile_id, kind, &web_base, &secrets::hint(&token), &facts))?;
    if let Err(e) = secrets::set(core, &secret_account(&row.id), &token).await {
        // Without a token the account would be useless.
        let _ = core.db.with(|c| db::hoster_accounts::delete(c, &profile_id, &row.id));
        return Err(e);
    }
    http::clear_cache(core);
    core.emit_app_changed(&[AppChange::HostAccounts]);
    Ok(row.to_model())
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
/// recognised one (by name). `None`: no remote belongs to GitHub, GitLab or a connected instance.
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
            "None of this repository's remotes is on GitHub, GitLab or a connected self-hosted instance.",
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
