//! The app's network settings for Git: proxy, custom CA bundle and – only for explicitly
//! listed hosts – disabled certificate verification.
//!
//! They live in the app settings (`Settings.proxyUrl`, `proxyByHost`, `sslCaFile`,
//! `sslNoVerifyHosts`) and apply to every network call (`GitCmd::network`) – never written to
//! the user's gitconfig. Git receives them through the environment (`GIT_CONFIG_COUNT`,
//! `GIT_CONFIG_KEY_n`, `GIT_CONFIG_VALUE_n`) and not as `-c` on the command line: there the
//! proxy password would be readable by other processes on the machine. Certificate verification
//! is only ever turned off as `http.<url>.sslVerify=false` for a single host; this code never
//! produces a global `http.sslVerify=false`.

use crate::git::redact;
use crate::model::{HostProxy, Settings};

/// Schemes that Git (libcurl) understands for `http.proxy`.
const PROXY_SCHEMES: [&str; 6] = ["http", "https", "socks4", "socks4a", "socks5", "socks5h"];

/// Slot of the global proxy in the keychain and in the cache (the other slots are the host
/// entries from `proxyByHost`).
pub const PROXY_SLOT_GLOBAL: &str = "global";

/// Key in the Git runner's cache.
pub fn proxy_cache_key(profile_id: &str, slot: &str) -> String {
    format!("{profile_id}\n{slot}")
}

/// Keychain account for a proxy's password.
pub fn proxy_secret_account(profile_id: &str, slot: &str) -> String {
    format!("proxy:{profile_id}:{slot}")
}

/// Splits `scheme://[user[:password]@]rest` into (scheme with `://`, user, password, rest).
fn proxy_parts(url: &str) -> Option<(&str, Option<&str>, Option<&str>, &str)> {
    let scheme_end = url.find("://")? + 3;
    let after = &url[scheme_end..];
    let authority_end = after.find('/').unwrap_or(after.len());
    match after[..authority_end].rfind('@') {
        Some(at) => {
            let userinfo = &after[..at];
            let (user, password) = match userinfo.split_once(':') {
                Some((user, password)) => (user, Some(password)),
                None => (userinfo, None),
            };
            Some((&url[..scheme_end], Some(user), password, &after[at + 1..]))
        }
        None => Some((&url[..scheme_end], None, None, after)),
    }
}

/// Separates the password from a proxy address: (`scheme://user@host…`, password).
/// Without a password the address stays as it is.
pub fn split_proxy_password(url: &str) -> (String, Option<String>) {
    match proxy_parts(url) {
        Some((scheme, Some(user), Some(password), rest)) => (format!("{scheme}{user}@{rest}"), Some(password.to_string())),
        _ => (url.to_string(), None),
    }
}

/// User name of a proxy address, if it contains one.
pub fn proxy_user(url: &str) -> Option<String> {
    proxy_parts(url).and_then(|(_, user, _, _)| user).map(str::to_string)
}

/// Puts the password back in (`scheme://user:password@host…`). Only for addresses with a
/// user and without a password; otherwise unchanged.
pub fn with_proxy_password(url: &str, password: &str) -> String {
    match proxy_parts(url) {
        Some((scheme, Some(user), None, rest)) if !password.is_empty() => format!("{scheme}{user}:{password}@{rest}"),
        _ => url.to_string(),
    }
}

/// What a network call additionally gets.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct NetConfig {
    /// One `key=value` per entry, as Git reads it as configuration. Contains the proxy
    /// password – never log it, never put it on a command line.
    pub settings: Vec<String>,
    /// Lines for the log (without credentials).
    pub notes: Vec<String>,
}

impl NetConfig {
    /// The settings as environment for Git. `already` is the number of entries the caller
    /// (or the user) already sets via `GIT_CONFIG_COUNT`; ours come after them. Empty if
    /// there is nothing to set.
    pub fn env(&self, already: usize) -> Vec<(String, String)> {
        if self.settings.is_empty() {
            return Vec::new();
        }
        let mut env = Vec::with_capacity(self.settings.len() * 2 + 1);
        for (offset, setting) in self.settings.iter().enumerate() {
            let (key, value) = setting.split_once('=').unwrap_or((setting.as_str(), ""));
            env.push((format!("GIT_CONFIG_KEY_{}", already + offset), key.to_string()));
            env.push((format!("GIT_CONFIG_VALUE_{}", already + offset), value.to_string()));
        }
        env.push(("GIT_CONFIG_COUNT".to_string(), (already + self.settings.len()).to_string()));
        env
    }
}

/// Brings a host entry into the form Git compares in `http.<url>.*`:
/// `https://host[:port]`. Allowed are `host`, `host:port` and `http(s)://host[:port][/…]`.
/// Wildcards (`*`) and empty entries are rejected – an exception always applies to exactly
/// one named host.
pub fn host_base(input: &str) -> Result<String, String> {
    let text = input.trim();
    if text.is_empty() {
        return Err("The host is missing.".into());
    }
    let (scheme, rest) = match text.split_once("://") {
        Some((scheme, rest)) => (scheme.to_ascii_lowercase(), rest),
        None => ("https".to_string(), text),
    };
    if scheme != "http" && scheme != "https" {
        return Err(format!("“{text}”: only http and https addresses are allowed."));
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    // Credentials don't belong in a host entry.
    let authority = authority.rsplit('@').next().unwrap_or(authority).to_ascii_lowercase();
    let (host, port) = match authority.strip_prefix('[') {
        // IPv6 in square brackets.
        Some(v6) => match v6.split_once(']') {
            Some((address, tail)) => (format!("[{address}]"), tail.strip_prefix(':')),
            None => return Err(format!("“{text}” is not a valid host.")),
        },
        None => match authority.rsplit_once(':') {
            Some((host, port)) => (host.to_string(), Some(port)),
            None => (authority.clone(), None),
        },
    };
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    let host_ok = !bare.is_empty()
        && bare.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '.' | '_' | ':'))
        && (host.starts_with('[') || !bare.contains(':'));
    if !host_ok {
        return Err(if text.contains('*') {
            format!("“{text}”: wildcards are not allowed – please list each host separately.")
        } else {
            format!("“{text}” is not a valid host.")
        });
    }
    match port {
        Some(port) if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) || port.parse::<u16>().is_err() => {
            Err(format!("“{text}”: the port is invalid."))
        }
        Some(port) => Ok(format!("{scheme}://{host}:{port}")),
        None => Ok(format!("{scheme}://{host}")),
    }
}

/// Checks a proxy address (`http://[user:password@]host:port`, also `socks5://…`).
pub fn check_proxy(input: &str) -> Result<String, String> {
    let text = input.trim();
    let Some((scheme, rest)) = text.split_once("://") else {
        return Err(format!("“{}” is not a proxy address. Expected something like http://proxy.company.example:8080.", redact::redact(text)));
    };
    let plain = !rest.is_empty() && !text.chars().any(|c| c.is_whitespace() || c.is_control());
    if !PROXY_SCHEMES.contains(&scheme.to_ascii_lowercase().as_str()) || !plain {
        return Err(format!("“{}” is not a proxy address. Expected something like http://proxy.company.example:8080.", redact::redact(text)));
    }
    Ok(text.to_string())
}

/// Cleans up the network fields of the settings: empty values are dropped, hosts are in the
/// form of `host_base`, duplicates only once. `Err` names the first invalid entry.
pub fn normalize(settings: &mut Settings) -> Result<(), String> {
    settings.proxy_url = match settings.proxy_url.take().map(|p| p.trim().to_string()).filter(|p| !p.is_empty()) {
        Some(proxy) => Some(check_proxy(&proxy)?),
        None => None,
    };
    settings.ssl_ca_file = settings.ssl_ca_file.take().map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    let mut by_host: Vec<HostProxy> = Vec::new();
    for entry in std::mem::take(&mut settings.proxy_by_host) {
        let host = host_base(&entry.host)?;
        // Empty means: no proxy for this host.
        let proxy = if entry.proxy.trim().is_empty() { String::new() } else { check_proxy(&entry.proxy)? };
        by_host.retain(|known| known.host != host);
        by_host.push(HostProxy { host, proxy });
    }
    settings.proxy_by_host = by_host;
    let mut hosts: Vec<String> = Vec::new();
    for host in std::mem::take(&mut settings.ssl_no_verify_hosts) {
        if host.trim().is_empty() {
            continue;
        }
        let host = host_base(&host)?;
        if !hosts.contains(&host) {
            hosts.push(host);
        }
    }
    settings.ssl_no_verify_hosts = hosts;
    Ok(())
}

/// Like `normalize`, but lenient (when loading stored values): whatever is invalid is
/// dropped individually instead of discarding everything.
pub fn normalize_lenient(settings: &mut Settings) {
    settings.proxy_url = settings.proxy_url.take().and_then(|p| check_proxy(&p).ok());
    settings.ssl_ca_file = settings.ssl_ca_file.take().map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
    let mut by_host: Vec<HostProxy> = Vec::new();
    for entry in std::mem::take(&mut settings.proxy_by_host) {
        let (Ok(host), Ok(proxy)) = (host_base(&entry.host), if entry.proxy.trim().is_empty() { Ok(String::new()) } else { check_proxy(&entry.proxy) })
        else {
            continue;
        };
        by_host.retain(|known| known.host != host);
        by_host.push(HostProxy { host, proxy });
    }
    settings.proxy_by_host = by_host;
    let mut hosts: Vec<String> = Vec::new();
    for host in std::mem::take(&mut settings.ssl_no_verify_hosts) {
        if let Ok(host) = host_base(&host) {
            if !hosts.contains(&host) {
                hosts.push(host);
            }
        }
    }
    settings.ssl_no_verify_hosts = hosts;
}

/// The `-c` settings for a network call from (normalized) settings.
pub fn from_settings(settings: &Settings) -> NetConfig {
    let mut config = NetConfig::default();
    if let Some(proxy) = &settings.proxy_url {
        config.settings.push(format!("http.proxy={proxy}"));
        config.notes.push(format!("Proxy: {}", redact::redact(proxy)));
    }
    for entry in &settings.proxy_by_host {
        // The key ends with "/": that way Git compares scheme, host and port exactly.
        config.settings.push(format!("http.{}/.proxy={}", entry.host, entry.proxy));
        let shown = if entry.proxy.is_empty() { "no proxy".to_string() } else { redact::redact(&entry.proxy) };
        config.notes.push(format!("Proxy for {}: {shown}", entry.host));
    }
    if let Some(file) = &settings.ssl_ca_file {
        config.settings.push(format!("http.sslCAInfo={file}"));
        // Git for Windows with the Schannel backend only honors the bundle with this switch.
        config.settings.push("http.schannelUseSSLCAInfo=true".to_string());
        config.notes.push(format!("Custom CA bundle: {file}"));
    }
    for host in &settings.ssl_no_verify_hosts {
        // Only for this one host – never global.
        config.settings.push(format!("http.{host}/.sslVerify=false"));
        config.notes.push(format!("Certificate verification turned off for {host}"));
    }
    config
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_are_normalized_and_wildcards_refused() {
        assert_eq!(host_base("git.example.com").unwrap(), "https://git.example.com");
        assert_eq!(host_base(" Git.Example.COM:8443 ").unwrap(), "https://git.example.com:8443");
        assert_eq!(host_base("https://git.example.com/gruppe/projekt.git").unwrap(), "https://git.example.com");
        assert_eq!(host_base("http://127.0.0.1:8080/").unwrap(), "http://127.0.0.1:8080");
        assert_eq!(host_base("https://anna:geheim@git.example.com").unwrap(), "https://git.example.com", "no credentials in the key");
        assert_eq!(host_base("[::1]:8443").unwrap(), "https://[::1]:8443");
        for bad in ["", "  ", "*", "*.example.com", "https://*", "ssh://git.example.com", "git example.com", "host:port", "host:99999", "a=b", "[::1"] {
            assert!(host_base(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn proxy_passwords_split_and_rejoin() {
        let (plain, password) = split_proxy_password("http://anna:ge%40heim@proxy.firma.example:8080/");
        assert_eq!((plain.as_str(), password.as_deref()), ("http://anna@proxy.firma.example:8080/", Some("ge%40heim")));
        assert_eq!(with_proxy_password(&plain, "ge%40heim"), "http://anna:ge%40heim@proxy.firma.example:8080/");
        assert_eq!(proxy_user(&plain).as_deref(), Some("anna"));
        // Without a user or already with a password: nothing to do.
        assert_eq!(split_proxy_password("socks5://127.0.0.1:1080"), ("socks5://127.0.0.1:1080".to_string(), None));
        assert_eq!(with_proxy_password("socks5://127.0.0.1:1080", "x"), "socks5://127.0.0.1:1080");
        assert_eq!(with_proxy_password("http://a:b@h:1", "x"), "http://a:b@h:1");
        assert_eq!(proxy_user("http://proxy:8080"), None);
        assert_eq!(split_proxy_password("kaputt"), ("kaputt".to_string(), None));
    }

    #[test]
    fn proxies_are_checked() {
        assert_eq!(check_proxy(" http://proxy.firma.example:8080 ").unwrap(), "http://proxy.firma.example:8080");
        assert!(check_proxy("socks5h://127.0.0.1:1080").is_ok());
        for bad in ["proxy:8080", "ftp://proxy:21", "http://", "http://pro xy:1", "http://a\nb"] {
            assert!(check_proxy(bad).is_err(), "{bad}");
        }
        // The error message doesn't reveal a password.
        assert!(!check_proxy("ftp://anna:geheim@proxy:21").unwrap_err().contains("geheim"));
    }

    #[test]
    fn settings_become_scoped_git_options() {
        let mut settings = Settings {
            proxy_url: Some("http://anna:geheim@proxy.firma.example:8080".into()),
            proxy_by_host: vec![
                HostProxy { host: "git.intern.example".into(), proxy: "".into() },
                HostProxy { host: "https://Hub.example:8443/x".into(), proxy: "socks5://127.0.0.1:1080".into() },
            ],
            ssl_ca_file: Some(" C:/zertifikate/firma.pem ".into()),
            ssl_no_verify_hosts: vec!["git.intern.example".into(), "https://git.intern.example/".into(), " ".into()],
            ..Settings::default()
        };
        normalize(&mut settings).unwrap();
        let config = from_settings(&settings);
        assert_eq!(
            config.settings,
            vec![
                "http.proxy=http://anna:geheim@proxy.firma.example:8080",
                "http.https://git.intern.example/.proxy=",
                "http.https://hub.example:8443/.proxy=socks5://127.0.0.1:1080",
                "http.sslCAInfo=C:/zertifikate/firma.pem",
                "http.schannelUseSSLCAInfo=true",
                "http.https://git.intern.example/.sslVerify=false",
            ]
        );
        // They reach Git through the environment: key and value per entry, plus the count –
        // after whatever is already set.
        let env = config.env(2);
        assert_eq!(env.len(), 13);
        assert_eq!(env[0], ("GIT_CONFIG_KEY_2".to_string(), "http.proxy".to_string()));
        assert_eq!(env[1], ("GIT_CONFIG_VALUE_2".to_string(), "http://anna:geheim@proxy.firma.example:8080".to_string()));
        assert_eq!(env[2], ("GIT_CONFIG_KEY_3".to_string(), "http.https://git.intern.example/.proxy".to_string()));
        assert_eq!(env[3], ("GIT_CONFIG_VALUE_3".to_string(), String::new()));
        assert_eq!(env[12], ("GIT_CONFIG_COUNT".to_string(), "8".to_string()));
        assert!(NetConfig::default().env(0).is_empty());
        // Never global, and never the proxy password in the log.
        assert!(!config.settings.iter().any(|s| s.to_lowercase().starts_with("http.sslverify")));
        assert!(config.notes.iter().all(|n| !n.contains("geheim")), "{:?}", config.notes);
        assert!(config.notes.iter().any(|n| n == "Certificate verification turned off for https://git.intern.example"));

        // Without settings: nothing.
        assert_eq!(from_settings(&Settings::default()), NetConfig::default());

        // Strict: the first invalid entry is an error. Lenient: it is dropped.
        let mut bad = Settings { ssl_no_verify_hosts: vec!["*".into(), "ok.example".into()], proxy_url: Some("kaputt".into()), ..Settings::default() };
        assert!(normalize(&mut bad.clone()).is_err());
        normalize_lenient(&mut bad);
        assert_eq!(bad.ssl_no_verify_hosts, vec!["https://ok.example"]);
        assert_eq!(bad.proxy_url, None);
    }
}
