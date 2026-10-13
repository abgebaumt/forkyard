//! HTTP client of the core – for the official APIs of the hosts (GitHub, GitLab). Git itself still talks to its remotes through the Git runner.
//!
//! - Honours the app's network settings the same way Git does: proxy (global and per host), custom
//!   CA bundle, certificate verification turned off only for explicitly listed hosts.
//!   Without a proxy setting the usual environment variables apply (`HTTPS_PROXY`, `NO_PROXY`).
//!   The operating system's root certificates are trusted.
//! - Timeouts per attempt; retries only for reading calls (GET), on
//!   connection errors and 502/503/504.
//! - Response size is limited; the user agent is `forkyard`.
//! - `If-None-Match` with a remembered ETag where the caller asks for it (`Request::cached`).
//! - Unencrypted (`http://`) only to this computer (tests against a local server).
//! - Every call is written to the activity log (method, address, status, duration) – without
//!   headers and without body. Tokens never appear in the address; whatever the caller names as a
//!   secret is additionally removed from everything that goes into the log or into errors.
//!
//! ureq is blocking; every call therefore runs on the blocking pool.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde::de::DeserializeOwned;
use ureq::http as h;

use crate::app::Core;
use crate::db;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::events::names;
use crate::git::{netconfig, redact};
use crate::model::Settings;
use crate::secrets;
use crate::util;

pub const USER_AGENT: &str = "forkyard";
/// Largest response that is read.
pub const MAX_BODY: u64 = 8 * 1024 * 1024;
/// Maximum number of responses the ETag cache keeps.
const ETAG_ENTRIES: usize = 300;
/// Larger responses are not cached.
const ETAG_MAX_BODY: usize = 512 * 1024;

/// Timeouts and retries. Default: 30 s per attempt, 10 s to connect,
/// two more attempts for reading calls.
#[derive(Debug, Clone)]
pub struct HttpOptions {
    pub timeout: Duration,
    pub connect_timeout: Duration,
    pub retries: u32,
    pub backoff: Duration,
    pub max_body: u64,
}

impl Default for HttpOptions {
    fn default() -> Self {
        HttpOptions {
            timeout: Duration::from_secs(30),
            connect_timeout: Duration::from_secs(10),
            retries: 2,
            backoff: Duration::from_millis(500),
            max_body: MAX_BODY,
        }
    }
}

struct CachedResponse {
    etag: String,
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

#[derive(Default)]
struct HttpState {
    options: Mutex<HttpOptions>,
    /// One agent per target (`scheme://host[:port]`), together with the settings state it was built for.
    agents: Mutex<HashMap<String, (String, ureq::Agent)>>,
    etags: Mutex<HashMap<String, std::sync::Arc<CachedResponse>>>,
}

/// Changes timeouts and retries of this core (tests).
pub fn configure(core: &Core, change: impl FnOnce(&mut HttpOptions)) {
    let state = core.state::<HttpState>();
    change(&mut state.options.lock());
    state.agents.lock().clear();
}

/// Forgets all cached responses (e.g. after disconnecting an account).
pub fn clear_cache(core: &Core) {
    core.state::<HttpState>().etags.lock().clear();
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

impl Method {
    pub fn as_str(self) -> &'static str {
        match self {
            Method::Get => "GET",
            Method::Post => "POST",
            Method::Put => "PUT",
            Method::Patch => "PATCH",
            Method::Delete => "DELETE",
        }
    }
}

/// A prepared call.
#[derive(Debug, Clone)]
pub struct Request {
    method: Method,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
    secrets: Vec<String>,
    aliases: Vec<String>,
    cache_scope: Option<String>,
    repo_id: Option<String>,
    label: String,
    min_timeout: Option<Duration>,
}

impl Request {
    /// `label`: name of the remote side for the log and error messages ("GitHub").
    pub fn new(method: Method, url: impl Into<String>, label: impl Into<String>) -> Self {
        Request {
            method,
            url: url.into(),
            headers: Vec::new(),
            body: None,
            secrets: Vec::new(),
            aliases: Vec::new(),
            cache_scope: None,
            repo_id: None,
            label: label.into(),
            min_timeout: None,
        }
    }

    /// This call may take longer than usual: the timeout is at least `limit`.
    pub fn min_timeout(mut self, limit: Duration) -> Self {
        self.min_timeout = Some(limit);
        self
    }

    pub fn get(url: impl Into<String>, label: impl Into<String>) -> Self {
        Self::new(Method::Get, url, label)
    }

    pub fn header(mut self, name: &str, value: impl Into<String>) -> Self {
        self.headers.push((name.to_string(), value.into()));
        self
    }

    /// Header whose value is secret (token, API key): it is removed from the log and from
    /// error messages in case the remote side sends it back.
    pub fn secret_header(mut self, name: &str, value: impl Into<String>, secret: &str) -> Self {
        self.headers.push((name.to_string(), value.into()));
        self.secrets.push(secret.to_string());
        self
    }

    /// JSON as body (sets `content-type`).
    pub fn json(mut self, body: &serde_json::Value) -> Self {
        self.body = Some(body.to_string().into_bytes());
        self.headers.push(("content-type".to_string(), "application/json".to_string()));
        self
    }

    /// Additional host (`https://host[:port]`) whose proxy and certificate settings also apply
    /// to this call – e.g. `https://github.com` for `api.github.com`.
    pub fn alias(mut self, host_base: impl Into<String>) -> Self {
        self.aliases.push(host_base.into());
        self
    }

    /// Remember the response and ask with `If-None-Match` next time. `scope` separates the
    /// responses of different accounts (same address, different token).
    pub fn cached(mut self, scope: impl Into<String>) -> Self {
        self.cache_scope = Some(scope.into());
        self
    }

    /// Assigns the log entry to a repository.
    pub fn repo(mut self, repo_id: Option<&str>) -> Self {
        self.repo_id = repo_id.map(str::to_string);
        self
    }

    pub fn url(&self) -> &str {
        &self.url
    }
}

/// State of the rate limit, taken from the headers of a response.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RateLimit {
    pub remaining: Option<u64>,
    /// Unix time at which the limit is reset.
    pub reset_at: Option<i64>,
    /// Seconds the remote side asks us to wait.
    pub retry_after: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    /// Names in lower case.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    /// The remote side reported "not modified"; the body comes from the ETag cache.
    pub from_cache: bool,
    label: String,
}

impl Response {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }

    pub fn is_success(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    /// Reads the body as JSON; unreadable responses yield an understandable error
    /// (without quoting the body).
    pub fn json<T: DeserializeOwned>(&self) -> CoreResult<T> {
        serde_json::from_slice(&self.body).map_err(|e| {
            CoreError::unknown(format!("The response from {} could not be read ({}).", self.label, json_error_kind(&e)))
        })
    }

    pub fn rate_limit(&self) -> RateLimit {
        let number = |names: [&str; 2]| names.iter().find_map(|name| self.header(name)).and_then(|v| v.trim().parse::<i64>().ok());
        RateLimit {
            remaining: number(["x-ratelimit-remaining", "ratelimit-remaining"]).and_then(|v| u64::try_from(v).ok()),
            reset_at: number(["x-ratelimit-reset", "ratelimit-reset"]),
            retry_after: self.header("retry-after").and_then(|v| v.trim().parse::<u64>().ok()),
        }
    }

    /// 429, or 403 with an exhausted limit or a requested wait time.
    pub fn is_rate_limited(&self) -> bool {
        let limit = self.rate_limit();
        self.status == 429 || (self.status == 403 && (limit.remaining == Some(0) || limit.retry_after.is_some()))
    }

    /// Earliest time to continue (UTC, ISO-8601), as far as the remote side says.
    pub fn retry_at(&self) -> Option<String> {
        let limit = self.rate_limit();
        let now = chrono::Utc::now().timestamp();
        match (limit.retry_after, limit.reset_at) {
            (Some(seconds), _) => Some(util::unix_to_iso(now + seconds.min(86_400) as i64)),
            (None, Some(reset)) => Some(util::unix_to_iso(reset)),
            (None, None) => None,
        }
    }

    /// Address of the next page from the `Link` header (`rel="next"`).
    pub fn next_url(&self) -> Option<String> {
        let link = self.header("link")?;
        link.split(',').find_map(|part| {
            let (target, params) = part.split_once(';')?;
            let is_next = params.split(';').any(|p| {
                let p = p.trim().to_ascii_lowercase();
                p == "rel=\"next\"" || p == "rel=next"
            });
            let url = target.trim().strip_prefix('<')?.strip_suffix('>')?;
            (is_next && !url.is_empty()).then(|| url.to_string())
        })
    }

    /// Number of the next page (`x-next-page` or the `page` parameter from `Link`).
    pub fn next_page(&self) -> Option<u32> {
        if let Some(page) = self.header("x-next-page").and_then(|v| v.trim().parse::<u32>().ok()) {
            return Some(page);
        }
        let next = self.next_url()?;
        let query = next.split_once('?')?.1;
        query.split('&').find_map(|pair| pair.strip_prefix("page=")).and_then(|v| v.parse::<u32>().ok())
    }
}

fn json_error_kind(e: &serde_json::Error) -> &'static str {
    match e.classify() {
        serde_json::error::Category::Eof => "incomplete",
        serde_json::error::Category::Syntax => "not valid JSON",
        serde_json::error::Category::Data => "unexpected structure",
        serde_json::error::Category::Io => "read error",
    }
}

// ---------------------------------------------------------------------------
// Target and route (proxy, certificates)
// ---------------------------------------------------------------------------

/// Where a call goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub scheme: String,
    pub host: String,
    /// `scheme://host[:port]` in lower case.
    pub base: String,
    pub loopback: bool,
}

/// Whether a host name refers to this computer.
pub fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
    host == "localhost" || host == "::1" || host.starts_with("127.")
}

impl Target {
    pub fn parse(url: &str) -> CoreResult<Target> {
        let bad = || CoreError::not_allowed(format!("“{}” is not a valid address.", redact::redact(url)));
        let (scheme, rest) = url.split_once("://").ok_or_else(bad)?;
        let scheme = scheme.to_ascii_lowercase();
        if scheme != "http" && scheme != "https" {
            return Err(bad());
        }
        let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
        if authority.is_empty() || authority.contains('@') || authority.chars().any(char::is_whitespace) {
            return Err(bad());
        }
        let authority = authority.to_ascii_lowercase();
        let host = match authority.strip_prefix('[') {
            Some(v6) => v6.split(']').next().unwrap_or(v6).to_string(),
            None => authority.rsplit_once(':').map(|(host, _)| host.to_string()).unwrap_or_else(|| authority.clone()),
        };
        if host.is_empty() {
            return Err(bad());
        }
        let loopback = is_loopback_host(&host);
        Ok(Target { base: format!("{scheme}://{authority}"), scheme, host, loopback })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ProxyChoice {
    /// No setting: the environment variables apply (as with Git).
    Environment,
    Direct,
    Url(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Route {
    proxy: ProxyChoice,
    verify: bool,
    ca_file: Option<String>,
}

impl Route {
    /// Picks from the network settings what applies to this target. The per-host entries are stored
    /// as `https://host[:port]` in the settings; `aliases` are compared as well.
    fn pick(settings: &Settings, target: &Target, aliases: &[String]) -> Route {
        let matches = |host: &str| {
            let host = host.trim_end_matches('/');
            host.eq_ignore_ascii_case(&target.base) || aliases.iter().any(|alias| host.eq_ignore_ascii_case(alias.trim_end_matches('/')))
        };
        let by_host = settings.proxy_by_host.iter().find(|entry| matches(&entry.host));
        let proxy = match (by_host, &settings.proxy_url) {
            (Some(entry), _) if entry.proxy.trim().is_empty() => ProxyChoice::Direct,
            (Some(entry), _) => ProxyChoice::Url(entry.proxy.clone()),
            // Calls to this computer never go through a proxy.
            (None, _) if target.loopback => ProxyChoice::Direct,
            (None, Some(proxy)) => ProxyChoice::Url(proxy.clone()),
            (None, None) => ProxyChoice::Environment,
        };
        Route { proxy, verify: !settings.ssl_no_verify_hosts.iter().any(|host| matches(host)), ca_file: settings.ssl_ca_file.clone() }
    }

    /// Distinguishes agents; contains the proxy password and never leaves this module.
    fn fingerprint(&self, options: &HttpOptions) -> String {
        format!("{:?}|{}|{:?}|{:?}|{:?}", self.proxy, self.verify, self.ca_file, options.timeout, options.connect_timeout)
    }

    fn secrets(&self) -> Vec<String> {
        match &self.proxy {
            ProxyChoice::Url(url) => netconfig::split_proxy_password(url).1.into_iter().collect(),
            _ => Vec::new(),
        }
    }

    /// Lines for the log, without credentials.
    fn notes(&self) -> Vec<String> {
        let mut notes = Vec::new();
        match &self.proxy {
            ProxyChoice::Url(url) => notes.push(format!("Proxy: {}", redact::redact(url))),
            ProxyChoice::Direct | ProxyChoice::Environment => {}
        }
        if let Some(file) = &self.ca_file {
            notes.push(format!("Custom CA bundle: {file}"));
        }
        if !self.verify {
            notes.push("Certificate verification turned off for this host".to_string());
        }
        notes
    }
}

fn build_agent(route: &Route, options: &HttpOptions) -> CoreResult<ureq::Agent> {
    use ureq::tls::{parse_pem, PemItem, RootCerts, TlsConfig};

    let roots = match &route.ca_file {
        Some(file) => {
            let pem = std::fs::read(file).map_err(|_| CoreError::path_not_found(file))?;
            let certs: Vec<_> = parse_pem(&pem)
                .filter_map(|item| match item {
                    Ok(PemItem::Certificate(cert)) => Some(cert),
                    _ => None,
                })
                .collect();
            if certs.is_empty() {
                return Err(CoreError::not_allowed(format!("The CA bundle “{file}” contains no certificate in PEM format.")));
            }
            RootCerts::new_with_certs(&certs)
        }
        None => RootCerts::PlatformVerifier,
    };
    let tls = TlsConfig::builder().root_certs(roots).disable_verification(!route.verify).build();
    let mut config = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .user_agent(USER_AGENT)
        .timeout_global(Some(options.timeout))
        .timeout_connect(Some(options.connect_timeout))
        .max_redirects(3)
        .redirect_auth_headers(ureq::config::RedirectAuthHeaders::SameHost)
        .tls_config(tls);
    match &route.proxy {
        ProxyChoice::Environment => {}
        ProxyChoice::Direct => config = config.proxy(None),
        ProxyChoice::Url(url) => {
            let proxy = ureq::Proxy::new(url)
                .map_err(|_| CoreError::not_allowed(format!("The proxy address “{}” can't be used for API calls.", redact::redact(url))))?;
            config = config.proxy(Some(proxy));
        }
    }
    Ok(config.build().into())
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

enum FailureKind {
    Timeout,
    Unreachable,
    Tls,
    Proxy,
    TooLarge,
    Other,
}

struct Failure {
    kind: FailureKind,
    retryable: bool,
    detail: String,
}

impl Failure {
    fn from_ureq(e: ureq::Error) -> Failure {
        let detail = e.to_string();
        let (kind, retryable) = match &e {
            ureq::Error::Timeout(_) => (FailureKind::Timeout, true),
            ureq::Error::HostNotFound | ureq::Error::ConnectionFailed => (FailureKind::Unreachable, true),
            ureq::Error::Io(io) if io.kind() == std::io::ErrorKind::TimedOut => (FailureKind::Timeout, true),
            ureq::Error::Io(_) => (FailureKind::Unreachable, true),
            ureq::Error::Tls(_) | ureq::Error::Rustls(_) | ureq::Error::Pem(_) | ureq::Error::TlsRequired => (FailureKind::Tls, false),
            ureq::Error::ConnectProxyFailed(_) | ureq::Error::InvalidProxyUrl => (FailureKind::Proxy, false),
            ureq::Error::BodyExceedsLimit(_) => (FailureKind::TooLarge, false),
            ureq::Error::Protocol(_) => (FailureKind::Other, true),
            _ => (FailureKind::Other, false),
        };
        // Depending on where it happens, a rejected certificate also arrives as an IO error; it can be recognised by the wording.
        let lower = detail.to_ascii_lowercase();
        if matches!(kind, FailureKind::Unreachable | FailureKind::Other) && ["certificate", "unknownissuer", "notvalidforname", "handshake", "tls"].iter().any(|word| lower.contains(word)) {
            return Failure { kind: FailureKind::Tls, retryable: false, detail };
        }
        Failure { kind, retryable, detail }
    }

    fn into_error(self, label: &str, host: &str, secrets: &[String]) -> CoreError {
        let (code, message) = match self.kind {
            FailureKind::Timeout => (ErrorCode::Timeout, format!("Timeout: {label} ({host}) did not respond in time.")),
            FailureKind::Unreachable => (ErrorCode::Offline, format!("{label} ({host}) is not reachable. Check your network connection.")),
            FailureKind::Tls => (
                ErrorCode::Offline,
                format!("The secure connection to {host} could not be established: the certificate could not be verified. You can set a custom CA bundle under Settings → Network."),
            ),
            FailureKind::Proxy => (ErrorCode::Offline, format!("The proxy did not establish the connection to {host}. Check the proxy settings.")),
            FailureKind::TooLarge => (ErrorCode::Unknown, format!("The response from {label} is too large and was discarded.")),
            FailureKind::Other => (ErrorCode::Unknown, format!("The request to {label} ({host}) failed.")),
        };
        CoreError::new(code, message).with_git_output(secrets::scrub(&self.detail, secrets))
    }
}

struct Parts {
    method: Method,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
    max_body: u64,
}

struct RawResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

fn perform(agent: &ureq::Agent, parts: &Parts) -> Result<RawResponse, Failure> {
    let mut builder = h::Request::builder().method(parts.method.as_str()).uri(parts.url.as_str());
    for (name, value) in &parts.headers {
        builder = builder.header(name.as_str(), value.as_str());
    }
    let invalid = |e: h::Error| Failure { kind: FailureKind::Other, retryable: false, detail: e.to_string() };
    let result = match &parts.body {
        Some(body) => agent.run(builder.body(body.clone()).map_err(invalid)?),
        None => agent.run(builder.body(()).map_err(invalid)?),
    };
    let mut response = result.map_err(Failure::from_ureq)?;
    let status = response.status().as_u16();
    let headers: Vec<(String, String)> = response
        .headers()
        .iter()
        .map(|(name, value)| (name.as_str().to_ascii_lowercase(), String::from_utf8_lossy(value.as_bytes()).into_owned()))
        .collect();
    let declared = headers.iter().find(|(name, _)| name == "content-length").and_then(|(_, value)| value.trim().parse::<u64>().ok());
    if declared.is_some_and(|length| length > parts.max_body) {
        return Err(Failure { kind: FailureKind::TooLarge, retryable: false, detail: String::new() });
    }
    let body = response.body_mut().with_config().limit(parts.max_body).read_to_vec().map_err(|e| {
        let mut failure = Failure::from_ureq(e);
        // The size limit arrives as an IO error while reading.
        if failure.detail.to_ascii_lowercase().contains("limit") {
            failure.kind = FailureKind::TooLarge;
            failure.retryable = false;
        }
        failure
    })?;
    Ok(RawResponse { status, headers, body })
}

/// Address for the log: without credentials and without the named secrets.
fn display_url(url: &str, secrets: &[String]) -> String {
    secrets::scrub(&redact::redact(url), secrets)
}

/// Sends the call. Every response with a status comes back as `Ok` – what a status means is
/// up to the caller. `Err` means: no response (timeout, unreachable, certificate, proxy,
/// response too large) or the call is not allowed.
pub async fn send(core: &Core, request: Request) -> CoreResult<Response> {
    let state = core.state::<HttpState>();
    let mut options = state.options.lock().clone();
    if let Some(limit) = request.min_timeout {
        options.timeout = options.timeout.max(limit);
    }
    let target = Target::parse(&request.url)?;
    if target.scheme == "http" && !target.loopback {
        return Err(CoreError::not_allowed(format!(
            "Unencrypted connections (http://) are only allowed to this computer, not to {}.",
            target.host
        )));
    }
    let settings = core.git.network_settings();
    let route = Route::pick(&settings, &target, &request.aliases);
    let mut secret_values = request.secrets.clone();
    secret_values.extend(route.secrets());

    let agent = {
        let fingerprint = route.fingerprint(&options);
        let known = state.agents.lock().get(&target.base).filter(|(built_for, _)| *built_for == fingerprint).map(|(_, agent)| agent.clone());
        match known {
            Some(agent) => agent,
            None => {
                let agent = build_agent(&route, &options)?;
                state.agents.lock().insert(target.base.clone(), (fingerprint, agent.clone()));
                agent
            }
        }
    };

    let cache_key = match (&request.cache_scope, request.method) {
        (Some(scope), Method::Get) => Some(format!("{scope}\n{}", request.url)),
        _ => None,
    };
    let cached = cache_key.as_ref().and_then(|key| state.etags.lock().get(key).cloned());
    let mut headers = request.headers.clone();
    if let Some(cached) = &cached {
        headers.push(("if-none-match".to_string(), cached.etag.clone()));
    }
    let parts = std::sync::Arc::new(Parts { method: request.method, url: request.url.clone(), headers, body: request.body.clone(), max_body: options.max_body });

    let started_at = util::now_iso();
    let started = Instant::now();
    let attempts = 1 + if request.method == Method::Get { options.retries } else { 0 };
    let mut tries = 0;
    let outcome = loop {
        tries += 1;
        let (agent, parts) = (agent.clone(), parts.clone());
        let result = match tokio::task::spawn_blocking(move || perform(&agent, &parts)).await {
            Ok(result) => result,
            Err(e) => Err(Failure { kind: FailureKind::Other, retryable: false, detail: e.to_string() }),
        };
        let retry = tries < attempts
            && match &result {
                Ok(response) => matches!(response.status, 502..=504),
                Err(failure) => failure.retryable,
            };
        if !retry {
            break result;
        }
        tokio::time::sleep(options.backoff * 2u32.saturating_pow(tries - 1)).await;
    };
    let duration = started.elapsed();

    let result = match outcome {
        Ok(raw) => {
            let response = match (raw.status, &cached) {
                (304, Some(cached)) => Response { status: cached.status, headers: merge_headers(&cached.headers, &raw.headers), body: cached.body.clone(), from_cache: true, label: request.label.clone() },
                _ => Response { status: raw.status, headers: raw.headers, body: raw.body, from_cache: false, label: request.label.clone() },
            };
            if let (Some(key), false) = (&cache_key, response.from_cache) {
                remember(&state, key, &response);
            }
            Ok((raw.status, response))
        }
        Err(failure) => Err(failure.into_error(&request.label, &target.host, &secret_values)),
    };

    log_call(core, &request, &route, &secret_values, started_at, duration, tries, &result);
    result.map(|(_, response)| response)
}

/// Headers of a 304 response (limits, date) take precedence over the cached ones.
fn merge_headers(cached: &[(String, String)], fresh: &[(String, String)]) -> Vec<(String, String)> {
    let mut merged: Vec<(String, String)> = fresh.to_vec();
    for (name, value) in cached {
        if !merged.iter().any(|(known, _)| known == name) {
            merged.push((name.clone(), value.clone()));
        }
    }
    merged
}

fn remember(state: &HttpState, key: &str, response: &Response) {
    let mut etags = state.etags.lock();
    let etag = response.header("etag").map(str::to_string).filter(|etag| !etag.is_empty());
    match etag {
        Some(etag) if response.status == 200 && response.body.len() <= ETAG_MAX_BODY => {
            if etags.len() >= ETAG_ENTRIES && !etags.contains_key(key) {
                etags.clear();
            }
            etags.insert(
                key.to_string(),
                std::sync::Arc::new(CachedResponse { etag, status: response.status, headers: response.headers.clone(), body: response.body.clone() }),
            );
        }
        _ => {
            etags.remove(key);
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn log_call(
    core: &Core,
    request: &Request,
    route: &Route,
    secret_values: &[String],
    started_at: String,
    duration: Duration,
    tries: u32,
    result: &CoreResult<(u16, Response)>,
) {
    let command = format!("{} {}", request.method.as_str(), display_url(&request.url, secret_values));
    let mut lines: Vec<String> = Vec::new();
    let (exit_code, code) = match result {
        Ok((status, response)) => {
            lines.push(format!("HTTP {status}{}", if response.from_cache { " (not modified, from cache)" } else { "" }));
            let limit = response.rate_limit();
            if let Some(remaining) = limit.remaining {
                lines.push(format!("Remaining requests: {remaining}"));
            }
            // Success (including "not modified") counts as 0; otherwise the HTTP status goes into the log.
            let ok = (200..400).contains(status);
            (Some(if ok { 0 } else { i32::from(*status) }), None)
        }
        Err(e) => {
            lines.push(e.message.clone());
            (None, Some(e.code))
        }
    };
    if tries > 1 {
        lines.push(format!("Attempts: {tries}"));
    }
    lines.extend(route.notes());
    let entry = db::activity::NewActivity {
        repo_id: request.repo_id.clone(),
        description: format!("{} {}", request.label, request.method.as_str()),
        command,
        exit_code,
        duration_ms: duration.as_millis() as u64,
        output: secrets::scrub(&lines.join("\n"), secret_values),
        started_at,
        code,
    };
    match core.db.with(|c| db::activity::insert(c, &entry)) {
        Ok(saved) => core.emit(names::LOG_APPENDED, &saved),
        Err(e) => log::warn!("Activity log entry not saved: {}", e.message),
    }
}

/// Encodes a value for a path segment or parameter of an address (RFC 3986:
/// everything except letters, digits and `-._~` becomes `%XX`).
pub fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Appends parameters to an address (`?a=1&b=2`), values encoded.
pub fn with_query(url: &str, params: &[(&str, String)]) -> String {
    if params.is_empty() {
        return url.to_string();
    }
    let query: Vec<String> = params.iter().map(|(key, value)| format!("{key}={}", encode(value))).collect();
    let joiner = if url.contains('?') { '&' } else { '?' };
    format!("{url}{joiner}{}", query.join("&"))
}

#[cfg(test)]
mod tests;
