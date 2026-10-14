//! Recognises from a remote's URL which host a repository lives on.
//!
//! Understood are `https://…`, `http://…`, `ssh://…`, `git://…` and the scp form
//! (`git@host:path`). Recognised are github.com and gitlab.com as well as self-hosted instances
//! for which an account with a matching address is connected. All other hosts count as not recognised.

use super::{host, RepoPath};
use crate::db::hoster_accounts::HosterAccountRow;
use crate::error::{CoreError, CoreResult};
use crate::http;
use crate::model::HostKind;

pub const GITHUB_WEB: &str = "https://github.com";
pub const GITLAB_WEB: &str = "https://gitlab.com";

/// Where a remote's URL points to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteLocation {
    /// Server name in lower case, without port.
    pub host: String,
    /// Port, only for `http(s)://` when given explicitly.
    pub web_port: Option<u16>,
    /// `http` or `https` for web URLs, otherwise `None` (ssh, git, scp form).
    pub web_scheme: Option<String>,
    /// Path without leading slash and without `.git`, e.g. `group/project`.
    pub path: String,
}

/// Splits a remote's URL; `None` for local paths, `file://` and anything unreadable.
pub fn parse_remote_url(url: &str) -> Option<RemoteLocation> {
    let url = url.trim();
    let (scheme, authority, path) = match url.split_once("://") {
        Some((scheme, rest)) => {
            let scheme = scheme.to_ascii_lowercase();
            if !matches!(scheme.as_str(), "http" | "https" | "ssh" | "git" | "git+ssh" | "ssh+git") {
                return None;
            }
            let (authority, path) = rest.split_once('/')?;
            (Some(scheme), authority, path)
        }
        None => {
            // scp form: [user@]host:path – no slash before the colon, no drive letter.
            let (before, path) = url.split_once(':')?;
            if before.contains(['/', '\\']) || before.chars().any(char::is_whitespace) || before.len() < 2 {
                return None;
            }
            (None, before, path)
        }
    };
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    let (host, port) = match host_port.strip_prefix('[') {
        Some(v6) => {
            let (address, tail) = v6.split_once(']')?;
            (address.to_string(), tail.strip_prefix(':').and_then(|p| p.parse::<u16>().ok()))
        }
        None => match host_port.rsplit_once(':') {
            Some((host, port)) if !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()) => (host.to_string(), port.parse::<u16>().ok()),
            _ => (host_port.to_string(), None),
        },
    };
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() {
        return None;
    }
    let path = path.split(['?', '#']).next().unwrap_or("");
    let path = path.trim_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path).trim_end_matches('/');
    if path.is_empty() || path.split('/').any(|segment| segment.is_empty() || segment == "." || segment == "..") {
        return None;
    }
    let web_scheme = scheme.filter(|s| s == "http" || s == "https");
    let web_port = if web_scheme.is_some() { port } else { None };
    Some(RemoteLocation { host, web_port, web_scheme, path: path.to_string() })
}

/// Decodes `%XX` in a path segment (Azure DevOps project names often contain `%20`). Invalid
/// sequences stay as they are.
pub(crate) fn percent_decode(segment: &str) -> String {
    let bytes = segment.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let hex = bytes.get(index + 1..index + 3).and_then(|pair| std::str::from_utf8(pair).ok()).filter(|pair| pair.bytes().all(|b| b.is_ascii_hexdigit())).and_then(|pair| u8::from_str_radix(pair, 16).ok());
        match (bytes[index], hex) {
            (b'%', Some(byte)) => {
                out.push(byte);
                index += 3;
            }
            (byte, _) => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(out).unwrap_or_else(|_| segment.to_string())
}

/// Brings an account's address into its canonical form: `https://host[:port][/path]`, lower
/// case, without trailing slash. Without input the public service applies (a host without one
/// needs an address). `http://` is only allowed to this computer (tests against a local server).
pub fn normalize_base_url(kind: HostKind, input: Option<&str>) -> CoreResult<String> {
    let hoster = host(kind);
    let Some(text) = input.map(str::trim).filter(|text| !text.is_empty()) else {
        return hoster
            .public_web()
            .map(str::to_string)
            .ok_or_else(|| CoreError::not_allowed(format!("{} needs the address of your organization or instance.", hoster.label())));
    };
    let with_scheme = if text.contains("://") { text.to_string() } else { format!("https://{text}") };
    let target = http::Target::parse(&with_scheme)?;
    if target.scheme == "http" && !target.loopback {
        return Err(CoreError::not_allowed(format!(
            "The address must start with https:// – over http:// the token would be sent unencrypted to {}.",
            target.host
        )));
    }
    let after = with_scheme.split_once("://").map(|(_, rest)| rest).unwrap_or("");
    let path = after.split_once('/').map(|(_, path)| path).unwrap_or("");
    let path = path.split(['?', '#']).next().unwrap_or("").trim_matches('/');
    if path.split('/').any(|segment| segment == "." || segment == "..") || path.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(CoreError::not_allowed(format!("“{text}” is not a valid address.")));
    }
    // The public services have exactly one address, no matter how it was entered.
    if hoster.public_hosts().contains(&target.host.as_str()) {
        if let Some(web) = hoster.public_web() {
            return Ok(web.to_string());
        }
    }
    // The API paths are not part of the web UI's address.
    let mut path = path;
    for suffix in HostKind::ALL.iter().flat_map(|kind| host(*kind).api_suffixes()) {
        path = path.trim_end_matches(suffix).trim_end_matches('/');
    }
    let base = if path.is_empty() { target.base } else { format!("{}/{path}", target.base) };
    hoster.check_base(base, target.loopback)
}

/// API address for a (normalised) web address.
pub fn api_base(kind: HostKind, web_base: &str) -> String {
    host(kind).api_base(web_base)
}

/// Splits a web address into (host without port, port, path prefix without outer slashes).
fn base_parts(web_base: &str) -> Option<(String, Option<u16>, String)> {
    let (scheme, rest) = web_base.split_once("://")?;
    let (authority, prefix) = rest.split_once('/').unwrap_or((rest, ""));
    let (host, port) = match authority.strip_prefix('[') {
        Some(v6) => {
            let (address, tail) = v6.split_once(']')?;
            (address.to_string(), tail.strip_prefix(':').and_then(|p| p.parse::<u16>().ok()))
        }
        None => match authority.rsplit_once(':') {
            Some((host, port)) => (host.to_string(), port.parse::<u16>().ok()),
            None => (authority.to_string(), None),
        },
    };
    let default_port = if scheme == "http" { 80 } else { 443 };
    Some((host.to_ascii_lowercase(), port.filter(|p| *p != default_port), prefix.trim_matches('/').to_string()))
}

/// Names under which the public services additionally offer SSH (port 443).
fn canonical_host(host: &str) -> &str {
    match host {
        "ssh.github.com" | "www.github.com" => "github.com",
        "altssh.gitlab.com" | "www.gitlab.com" => "gitlab.com",
        other => other,
    }
}

/// The repository's path below a web address, if the remote points there.
fn path_under(web_base: &str, location: &RemoteLocation) -> Option<String> {
    let (host, port, prefix) = base_parts(web_base)?;
    if canonical_host(&location.host) != host {
        return None;
    }
    // For web URLs the port must match as well; for SSH the port says nothing about the web UI.
    if let Some(scheme) = &location.web_scheme {
        let default_port = if scheme == "http" { 80 } else { 443 };
        if location.web_port.filter(|p| *p != default_port) != port {
            return None;
        }
    }
    if prefix.is_empty() {
        return Some(location.path.clone());
    }
    // Instance under a subpath (`https://firma.example/gitlab`): web URLs carry it, SSH usually doesn't.
    match location.path.strip_prefix(&format!("{prefix}/")) {
        Some(rest) => Some(rest.to_string()),
        None if location.web_scheme.is_none() => Some(location.path.clone()),
        None => None,
    }
}

/// A repository recognised on a host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Detected {
    pub kind: HostKind,
    /// The connected account, if there is one for this address.
    pub account: Option<HosterAccountRow>,
    pub web_base: String,
    /// On GitLab with groups: `group/subgroup`.
    pub owner: String,
    pub name: String,
}

impl Detected {
    pub fn web_url(&self) -> String {
        host(self.kind).repo_web_url(&self.web_base, &RepoPath { owner: self.owner.clone(), name: self.name.clone() })
    }
}

/// Recognises the host for a remote URL. Connected accounts take precedence (that's how
/// self-hosted instances are recognised); without an account only the public services are recognised.
pub fn detect(url: &str, accounts: &[HosterAccountRow]) -> Option<Detected> {
    let location = parse_remote_url(url)?;
    for account in accounts {
        if let Some(path) = path_under(&account.base_url, &location) {
            if let Some(repo) = host(account.kind).split_repo_path(&path) {
                return Some(Detected { kind: account.kind, account: Some(account.clone()), web_base: account.base_url.clone(), owner: repo.owner, name: repo.name });
            }
        }
    }
    for kind in HostKind::ALL.iter().copied() {
        let Some(web_base) = host(kind).public_web() else { continue };
        if let Some(path) = path_under(web_base, &location) {
            let repo = host(kind).split_repo_path(&path)?;
            return Some(Detected { kind, account: None, web_base: web_base.to_string(), owner: repo.owner, name: repo.name });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(kind: HostKind, base_url: &str) -> HosterAccountRow {
        HosterAccountRow {
            id: format!("konto-{base_url}"),
            profile_id: "p".into(),
            kind,
            base_url: base_url.into(),
            username: None,
            login: Some("lena".into()),
            name: None,
            avatar_url: None,
            token_hint: None,
            scopes_ok: true,
            missing_scopes: Vec::new(),
            last_error: None,
        }
    }

    #[test]
    fn remote_urls_in_every_common_form() {
        let cases = [
            ("https://github.com/octo/demo.git", "github.com", "octo/demo"),
            ("https://github.com/octo/demo", "github.com", "octo/demo"),
            ("https://lena:geheim@github.com/octo/demo.git/", "github.com", "octo/demo"),
            ("http://127.0.0.1:8123/octo/demo.git", "127.0.0.1", "octo/demo"),
            ("git@github.com:octo/demo.git", "github.com", "octo/demo"),
            ("github.com:octo/demo", "github.com", "octo/demo"),
            ("ssh://git@github.com/octo/demo.git", "github.com", "octo/demo"),
            ("ssh://git@ssh.github.com:443/octo/demo.git", "ssh.github.com", "octo/demo"),
            ("git://GitHub.com/octo/demo.git", "github.com", "octo/demo"),
            ("git@gitlab.com:gruppe/unter/projekt.git", "gitlab.com", "gruppe/unter/projekt"),
            ("https://gitlab.firma.example:8443/gruppe/projekt.git?x=1", "gitlab.firma.example", "gruppe/projekt"),
            ("ssh://git@[::1]:2222/gruppe/projekt.git", "::1", "gruppe/projekt"),
        ];
        for (url, host, path) in cases {
            let location = parse_remote_url(url).unwrap_or_else(|| panic!("{url}"));
            assert_eq!((location.host.as_str(), location.path.as_str()), (host, path), "{url}");
        }
        for url in ["", "C:/repos/demo", "C:\\repos\\demo", "/srv/git/demo.git", "../demo", "file:///srv/git/demo.git", "https://github.com/", "ftp://github.com/a/b", "git@github.com:", "https://github.com/a/../b"] {
            assert_eq!(parse_remote_url(url), None, "{url}");
        }
    }

    #[test]
    fn public_hosts_are_detected_without_an_account() {
        let hub = detect("git@github.com:octo/demo.git", &[]).unwrap();
        assert_eq!((hub.kind, hub.owner.as_str(), hub.name.as_str(), hub.account.is_none()), (HostKind::Github, "octo", "demo", true));
        assert_eq!(hub.web_url(), "https://github.com/octo/demo");
        assert_eq!(detect("ssh://git@ssh.github.com:443/octo/demo.git", &[]).unwrap().web_url(), "https://github.com/octo/demo");
        let lab = detect("https://gitlab.com/gruppe/unter/projekt.git", &[]).unwrap();
        assert_eq!((lab.kind, lab.owner.as_str(), lab.name.as_str()), (HostKind::Gitlab, "gruppe/unter", "projekt"));
        // Other hosts and self-hosted instances without an account: not recognised.
        for url in [
            "git@ssh.dev.azure.com:v3/firma/projekt/repo",
            "https://dev.azure.com/firma/projekt/_git/repo",
            "https://gitlab.firma.example/gruppe/projekt.git",
            "https://github.firma.example/octo/demo.git",
            "https://git.example.org/team/projekt.git",
            // GitHub has no subgroups; a single segment is not a repository.
            "https://github.com/octo/demo/extra",
            "https://github.com/octo",
            // A different port is a different service.
            "https://github.com:8443/octo/demo.git",
        ] {
            assert_eq!(detect(url, &[]), None, "{url}");
        }
    }

    #[test]
    fn own_instances_are_detected_through_their_account() {
        let accounts = [
            account(HostKind::Gitlab, "https://gitlab.firma.example"),
            account(HostKind::Github, "https://github.firma.example:8443"),
            account(HostKind::Gitlab, "https://dienste.firma.example/gitlab"),
            account(HostKind::Github, "http://127.0.0.1:8123"),
        ];
        let lab = detect("git@gitlab.firma.example:gruppe/unter/projekt.git", &accounts).unwrap();
        assert_eq!((lab.kind, lab.owner.as_str(), lab.name.as_str()), (HostKind::Gitlab, "gruppe/unter", "projekt"));
        assert_eq!(lab.account.as_ref().map(|a| a.base_url.as_str()), Some("https://gitlab.firma.example"));
        // Web URL: the port must match. SSH: the port says nothing.
        assert!(detect("https://github.firma.example:8443/octo/demo.git", &accounts).is_some());
        assert!(detect("https://github.firma.example/octo/demo.git", &accounts).is_none());
        assert!(detect("ssh://git@github.firma.example:2222/octo/demo.git", &accounts).is_some());
        // Instance under a subpath.
        let nested = detect("https://dienste.firma.example/gitlab/gruppe/projekt.git", &accounts).unwrap();
        assert_eq!((nested.owner.as_str(), nested.name.as_str()), ("gruppe", "projekt"));
        assert_eq!(nested.web_url(), "https://dienste.firma.example/gitlab/gruppe/projekt");
        assert!(detect("https://dienste.firma.example/anderes/gruppe/projekt.git", &accounts).is_none());
        assert_eq!(detect("git@dienste.firma.example:gruppe/projekt.git", &accounts).unwrap().owner, "gruppe");
        // The local test server.
        let local = detect("http://127.0.0.1:8123/octo/demo.git", &accounts).unwrap();
        assert_eq!((local.kind, local.web_base.as_str()), (HostKind::Github, "http://127.0.0.1:8123"));
        assert!(detect("http://127.0.0.1:9999/octo/demo.git", &accounts).is_none());
        // An account for github.com takes precedence over the built-in detection and is attached to the result.
        let with_account = [account(HostKind::Github, GITHUB_WEB)];
        assert!(detect("https://github.com/octo/demo.git", &with_account).unwrap().account.is_some());
    }

    #[test]
    fn base_urls_are_normalized() {
        let ok = |kind, input: Option<&str>| normalize_base_url(kind, input).unwrap();
        assert_eq!(ok(HostKind::Github, None), GITHUB_WEB);
        assert_eq!(ok(HostKind::Github, Some("  ")), GITHUB_WEB);
        assert_eq!(ok(HostKind::Github, Some("https://api.github.com/")), GITHUB_WEB);
        assert_eq!(ok(HostKind::Gitlab, Some("gitlab.com")), GITLAB_WEB);
        assert_eq!(ok(HostKind::Gitlab, Some("GitLab.Firma.Example/")), "https://gitlab.firma.example");
        assert_eq!(ok(HostKind::Gitlab, Some("https://dienste.firma.example/gitlab/api/v4/")), "https://dienste.firma.example/gitlab");
        assert_eq!(ok(HostKind::Github, Some("https://github.firma.example:8443/api/v3")), "https://github.firma.example:8443");
        assert_eq!(ok(HostKind::Github, Some("http://127.0.0.1:8123")), "http://127.0.0.1:8123");
        assert_eq!(ok(HostKind::Gitlab, Some("http://localhost:8123/")), "http://localhost:8123");
        for bad in ["http://gitlab.firma.example", "ftp://x", "https://", "https://lena:pw@gitlab.firma.example", "https://a b"] {
            let error = normalize_base_url(HostKind::Gitlab, Some(bad)).unwrap_err();
            assert_eq!(error.code, crate::ErrorCode::NotAllowed, "{bad}");
            assert!(!error.message.contains("pw@"), "{}", error.message);
        }
        assert_eq!(api_base(HostKind::Github, GITHUB_WEB), "https://api.github.com");
        assert_eq!(api_base(HostKind::Github, "https://github.firma.example"), "https://github.firma.example/api/v3");
        assert_eq!(api_base(HostKind::Gitlab, GITLAB_WEB), "https://gitlab.com/api/v4");
        assert_eq!(api_base(HostKind::Gitlab, "http://127.0.0.1:8123"), "http://127.0.0.1:8123/api/v4");
    }

    #[test]
    fn repository_paths_are_split_the_way_each_host_nests_them() {
        let split = |kind: HostKind, path: &str| host(kind).split_repo_path(path).map(|r| (r.owner, r.name));
        assert_eq!(split(HostKind::Github, "octo/demo"), Some(("octo".to_string(), "demo".to_string())));
        assert_eq!(split(HostKind::Github, "octo/demo/extra"), None);
        assert_eq!(split(HostKind::Gitlab, "gruppe/unter/projekt"), Some(("gruppe/unter".to_string(), "projekt".to_string())));
        assert_eq!(split(HostKind::Gitlab, "projekt"), None);
        for kind in HostKind::ALL.iter().copied() {
            let web = host(kind).repo_web_url("https://x.example", &RepoPath { owner: "a".into(), name: "b".into() });
            assert!(web.starts_with("https://x.example/") && web.ends_with('b'), "{kind:?}: {web}");
            // Without input the public service applies; a host without one needs an address.
            match host(kind).public_web() {
                Some(web) => assert_eq!(normalize_base_url(kind, None).unwrap(), web),
                None => assert_eq!(normalize_base_url(kind, None).unwrap_err().code, crate::ErrorCode::NotAllowed),
            }
        }
    }
}
