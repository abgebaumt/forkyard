//! Recognises what Git or SSH wants to know with a prompt.
//!
//! The texts are the fixed English templates from Git (`credential.c`) and OpenSSH
//! (`sshconnect.c`, `sshconnect2.c`, `ssh-keygen.c`); Git runs with `LC_ALL=C`.

use crate::model::{CredentialKind, HostAccountKind};

/// Under which entry a secret is stored in the keychain (row in `host_accounts`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreKey {
    pub kind: HostAccountKind,
    /// HTTPS: `host[:port][/path]`; other schemes with the scheme in front (`http://host`,
    /// `ssh://host`); passphrase: path of the key.
    pub host: String,
    pub username: String,
}

/// A parsed prompt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Question {
    pub kind: CredentialKind,
    /// Host for display, empty if the question names none.
    pub host: String,
    pub username: Option<String>,
    /// Passphrase: path of the key. Host key: the fingerprint.
    pub detail: Option<String>,
    /// Entry in the keychain; `None` = cannot be remembered. For `Username` only the host
    /// (to look up the remembered account).
    pub store: Option<StoreKey>,
    /// Question from Git itself (HTTPS). Git asks only once per process; SSH repeats the
    /// same question after a wrong input.
    pub from_git: bool,
}

/// This is how OpenSSH's passphrase questions begin (`ssh`, `ssh-add`, `ssh-keygen`). They only
/// count as such at the exact start of the question.
const PASSPHRASE_STARTS: [&str; 5] = ["Enter passphrase", "Bad passphrase", "Enter same passphrase", "Enter new passphrase", "Enter old passphrase"];

/// Parses the text of a prompt.
///
/// Important for security: when signing in via questions from the server
/// (keyboard-interactive), the **server** determines the text. OpenSSH (8.5 and later) prefixes
/// it with `(user@host) `. Everything after that is foreign text and is never read as a question
/// from Git, as a passphrase question or as a host key question – otherwise a hostile server
/// could request remembered secrets (`from_server`). For older OpenSSH versions that pass the
/// text through unmarked, the Git runner turns this sign-in method off.
pub fn classify(prompt: &str) -> Question {
    let text = prompt.trim();
    if let Some((account, server_text)) = server_prompt(text) {
        return from_server(account, server_text);
    }
    let lower = text.to_lowercase();

    if lower.contains("authenticity of host")
        || lower.contains("continue connecting")
        || lower.contains("please type 'yes'")
    {
        return host_key(text);
    }
    if let Some(target) = quoted_after(text, "Username for ") {
        let url = parse_url(target);
        return Question {
            kind: CredentialKind::Username,
            host: url.host.clone(),
            username: None,
            detail: None,
            store: Some(StoreKey { kind: HostAccountKind::Password, host: url.store_host, username: String::new() }),
            from_git: true,
        };
    }
    if let Some(target) = quoted_after(text, "Password for ") {
        let url = parse_url(target);
        let username = url.username.clone();
        return Question {
            kind: CredentialKind::Password,
            host: url.host.clone(),
            username: username.clone(),
            detail: None,
            store: username.map(|username| StoreKey { kind: HostAccountKind::Password, host: url.store_host, username }),
            from_git: true,
        };
    }
    if PASSPHRASE_STARTS.iter().any(|start| text.starts_with(start)) {
        return passphrase(text);
    }
    if let Some(q) = ssh_password(text) {
        return q;
    }
    // Unknown question (PIN, one-time code, …): ask hidden, never remember.
    Question { kind: CredentialKind::Password, host: String::new(), username: None, detail: None, store: None, from_git: false }
}

/// `(user@host) <text from the server>` → (`user@host`, text). This is how OpenSSH 8.5 and later
/// passes on every question the server asks during keyboard-interactive; the part in
/// parentheses is set by the client.
fn server_prompt(text: &str) -> Option<(&str, &str)> {
    let rest = text.strip_prefix('(')?;
    let end = rest.find(") ").or_else(|| rest.strip_suffix(')').map(str::len))?;
    let account = &rest[..end];
    let (user, host) = account.rsplit_once('@')?;
    if user.is_empty() || host.is_empty() || account.contains(char::is_whitespace) || account.contains(['(', ')']) {
        return None;
    }
    Some((account, rest[end + 1..].trim_start()))
}

/// A question whose text the server determines. Only the usual password question (`Password:`)
/// can be remembered – under the host the client names. Everything else is asked hidden, never
/// answered from the keychain and never remembered; the UI shows host and text.
fn from_server(account: &str, server_text: &str) -> Question {
    let (user, host) = account.rsplit_once('@').unwrap_or(("", account));
    let asked = server_text.trim_end().trim_end_matches(':').trim_end();
    let store = asked.eq_ignore_ascii_case("password").then(|| StoreKey {
        kind: HostAccountKind::Password,
        host: format!("ssh://{host}"),
        username: user.to_string(),
    });
    Question { kind: CredentialKind::Password, host: host.to_string(), username: Some(user.to_string()), detail: None, store, from_git: false }
}

fn host_key(text: &str) -> Question {
    // The authenticity of host 'github.com (140.82.121.4)' can't be established.
    // ED25519 key fingerprint is SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU.
    let host = text
        .find("host '")
        .and_then(|start| {
            let rest = &text[start + "host '".len()..];
            rest.find('\'').map(|end| &rest[..end])
        })
        .map(|named| named.split(" (").next().unwrap_or(named).trim().to_string())
        .unwrap_or_default();
    // OpenSSH 10 writes "fingerprint is: SHA256:…" (with a colon), older ones "fingerprint is SHA256:….".
    let detail = text.find("fingerprint is").and_then(|start| {
        let rest = text[start + "fingerprint is".len()..].trim_start_matches(|c: char| c == ':' || c.is_whitespace());
        let token = rest.split_whitespace().next()?.trim_end_matches('.');
        (!token.is_empty()).then(|| token.to_string())
    });
    Question { kind: CredentialKind::HostKey, host, username: None, detail, store: None, from_git: false }
}

fn passphrase(text: &str) -> Question {
    // Enter passphrase for key '/home/u/.ssh/id_ed25519':
    // Enter passphrase for /home/u/.ssh/id_ed25519:            (ssh-add)
    // Bad passphrase, try again for /home/u/.ssh/id_ed25519:   (ssh-add)
    // Enter passphrase:                                        (ssh-keygen)
    let body = text.trim_end().trim_end_matches(':').trim_end();
    let key = match body.find(" for ") {
        Some(pos) => {
            let rest = body[pos + " for ".len()..].trim();
            let rest = rest.strip_prefix("key ").unwrap_or(rest).trim();
            let rest = rest.trim_matches(|c| c == '\'' || c == '"');
            // "(empty for no passphrase)" from ssh-keygen is not a key path.
            (!rest.is_empty() && !rest.ends_with(')')).then(|| rest.to_string())
        }
        None => None,
    };
    Question {
        kind: CredentialKind::Passphrase,
        host: String::new(),
        username: None,
        detail: key.clone(),
        store: key.map(|path| StoreKey { kind: HostAccountKind::Passphrase, host: path, username: String::new() }),
        from_git: false,
    }
}

fn ssh_password(text: &str) -> Option<Question> {
    // git@example.com's password:
    // (The form "(git@example.com) Password:" from keyboard-interactive goes through `from_server`.)
    let body = text.trim_end().trim_end_matches(':').trim_end();
    // ASCII lowercasing leaves the byte positions unchanged.
    let lower = body.to_ascii_lowercase();
    let account = lower.strip_suffix("'s password").map(|a| &body[..a.len()])?;
    let (user, host) = account.rsplit_once('@')?;
    if user.is_empty() || host.is_empty() || account.contains(char::is_whitespace) {
        return None;
    }
    Some(Question {
        kind: CredentialKind::Password,
        host: host.to_string(),
        username: Some(user.to_string()),
        detail: None,
        store: Some(StoreKey { kind: HostAccountKind::Password, host: format!("ssh://{host}"), username: user.to_string() }),
        from_git: false,
    })
}

/// Text between the first and the last single quote after `prefix`, if the question starts that way.
fn quoted_after<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let rest = text.strip_prefix(prefix)?;
    let start = rest.find('\'')?;
    let end = rest.rfind('\'')?;
    (end > start).then(|| &rest[start + 1..end])
}

struct UrlParts {
    host: String,
    store_host: String,
    username: Option<String>,
}

/// `https://user@host:port/path` from a Git question.
fn parse_url(target: &str) -> UrlParts {
    let (scheme, rest) = match target.split_once("://") {
        Some((scheme, rest)) => (scheme.to_lowercase(), rest),
        None => (String::new(), target),
    };
    let (authority, path) = match rest.split_once('/') {
        Some((authority, path)) => (authority, path.trim_end_matches('/')),
        None => (rest, ""),
    };
    let (username, host) = match authority.rsplit_once('@') {
        Some((user, host)) => (Some(percent_decode(user)), host),
        None => (None, authority),
    };
    let mut store_host = if scheme.is_empty() || scheme == "https" { host.to_string() } else { format!("{scheme}://{host}") };
    if !path.is_empty() {
        store_host.push('/');
        store_host.push_str(path);
    }
    UrlParts { host: host.to_string(), store_host, username: username.filter(|u| !u.is_empty()) }
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = text.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok());
            if let Some(value) = hex {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(kind: HostAccountKind, host: &str, username: &str) -> Option<StoreKey> {
        Some(StoreKey { kind, host: host.into(), username: username.into() })
    }

    #[test]
    fn git_https_prompts() {
        let q = classify("Username for 'https://github.com': ");
        assert_eq!(q.kind, CredentialKind::Username);
        assert_eq!(q.host, "github.com");
        assert_eq!(q.username, None);
        assert_eq!(q.store, store(HostAccountKind::Password, "github.com", ""));
        assert!(q.from_git);

        let q = classify("Password for 'https://anna@github.com': ");
        assert_eq!(q.kind, CredentialKind::Password);
        assert_eq!(q.host, "github.com");
        assert_eq!(q.username.as_deref(), Some("anna"));
        assert_eq!(q.store, store(HostAccountKind::Password, "github.com", "anna"));
        assert!(q.from_git);

        // Port, path (credential.useHttpPath), user name with an encoded "@".
        let q = classify("Password for 'https://anna%40firma.de@git.firma.de:8443/team/projekt.git': ");
        assert_eq!(q.host, "git.firma.de:8443");
        assert_eq!(q.username.as_deref(), Some("anna@firma.de"));
        assert_eq!(q.store, store(HostAccountKind::Password, "git.firma.de:8443/team/projekt.git", "anna@firma.de"));

        // Unencrypted HTTP gets its own entry.
        let q = classify("Username for 'http://127.0.0.1:8080': ");
        assert_eq!(q.host, "127.0.0.1:8080");
        assert_eq!(q.store, store(HostAccountKind::Password, "http://127.0.0.1:8080", ""));
        let q = classify("Password for 'http://bob@127.0.0.1:8080': ");
        assert_eq!(q.store, store(HostAccountKind::Password, "http://127.0.0.1:8080", "bob"));

        // Without a user in the question nothing can be remembered.
        let q = classify("Password for 'https://github.com': ");
        assert_eq!(q.kind, CredentialKind::Password);
        assert_eq!(q.username, None);
        assert_eq!(q.store, None);
    }

    #[test]
    fn ssh_passphrase_prompts() {
        let table = [
            ("Enter passphrase for key '/home/anna/.ssh/id_ed25519': ", Some("/home/anna/.ssh/id_ed25519")),
            ("Enter passphrase for key 'C:\\Users\\Anna Müller/.ssh/id_ed25519': ", Some("C:\\Users\\Anna Müller/.ssh/id_ed25519")),
            ("Enter passphrase for /home/anna/.ssh/id_rsa: ", Some("/home/anna/.ssh/id_rsa")),
            ("Bad passphrase, try again for /home/anna/.ssh/id_rsa: ", Some("/home/anna/.ssh/id_rsa")),
            ("Enter passphrase for \"/c/Users/anna/.ssh/id_ed25519\": ", Some("/c/Users/anna/.ssh/id_ed25519")),
            ("Enter passphrase: ", None),
            ("Enter passphrase (empty for no passphrase): ", None),
            ("Enter same passphrase again: ", None),
        ];
        for (prompt, key) in table {
            let q = classify(prompt);
            assert_eq!(q.kind, CredentialKind::Passphrase, "{prompt}");
            assert_eq!(q.host, "", "{prompt}");
            assert_eq!(q.detail.as_deref(), key, "{prompt}");
            assert_eq!(q.store, key.and_then(|k| store(HostAccountKind::Passphrase, k, "")), "{prompt}");
            assert!(!q.from_git);
        }
    }

    #[test]
    fn ssh_password_prompts() {
        let q = classify("git@example.com's password: ");
        assert_eq!(q.kind, CredentialKind::Password);
        assert_eq!(q.host, "example.com");
        assert_eq!(q.username.as_deref(), Some("git"));
        assert_eq!(q.store, store(HostAccountKind::Password, "ssh://example.com", "git"));
        assert!(!q.from_git);

        let q = classify("(anna@git.firma.de) Password: ");
        assert_eq!(q.kind, CredentialKind::Password);
        assert_eq!(q.host, "git.firma.de");
        assert_eq!(q.username.as_deref(), Some("anna"));

        // Questions without a recognisable target: hidden, cannot be remembered.
        for prompt in ["Password: ", "Verification code: ", "Enter PIN for 'YubiKey': ", ""] {
            let q = classify(prompt);
            assert_eq!(q.kind, CredentialKind::Password, "{prompt}");
            assert_eq!(q.store, None, "{prompt}");
            assert_eq!(q.host, "", "{prompt}");
        }
    }

    /// With keyboard-interactive the text after `(user@host) ` comes from the server. It must
    /// count neither as a passphrase question nor as a question from Git, otherwise a hostile
    /// server collects remembered secrets.
    #[test]
    fn sec04_text_from_the_server_is_never_a_passphrase_or_git_question() {
        for spoofed in [
            "(git@server.example) Enter passphrase for key '/home/anna/.ssh/id_ed25519': ",
            "(git@server.example) Bad passphrase, try again for /home/anna/.ssh/id_ed25519: ",
            "(git@server.example) Password for 'https://anna@github.com': ",
            "(git@server.example) Username for 'https://github.com': ",
            "(git@server.example) anna@github.com's password: ",
            "(git@server.example) (anna@github.com) Password: ",
            "(git@server.example) Bitte die passphrase eingeben: ",
            "(git@server.example) The authenticity of host 'github.com (1.2.3.4)' can't be established.\nAre you sure you want to continue connecting (yes/no)? ",
        ] {
            let q = classify(spoofed);
            assert_eq!(q.kind, CredentialKind::Password, "{spoofed}");
            assert_eq!(q.store, None, "{spoofed}: nothing from the keychain, nothing remembered");
            assert_eq!(q.host, "server.example", "{spoofed}: the host the client names");
            assert_eq!(q.detail, None, "{spoofed}");
            assert!(!q.from_git, "{spoofed}");
        }
        // The usual password question via keyboard-interactive stays rememberable – under the host
        // the client puts in front (the server cannot determine it).
        let q = classify("(anna@git.firma.de) Password: ");
        assert_eq!(q.store, store(HostAccountKind::Password, "ssh://git.firma.de", "anna"));
        // Passphrase questions only count at the exact start of the text.
        for other in ["Hinweis: Enter passphrase for key '/k': ", "x Enter passphrase for /k: ", "please enter your passphrase for key '/k': "] {
            let q = classify(other);
            assert_eq!(q.store, None, "{other}");
            assert_ne!(q.kind, CredentialKind::Passphrase, "{other}");
        }
    }

    #[test]
    fn host_key_prompts() {
        let prompt = "The authenticity of host 'github.com (140.82.121.4)' can't be established.\n\
                      ED25519 key fingerprint is SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU.\n\
                      This key is not known by any other names.\n\
                      Are you sure you want to continue connecting (yes/no/[fingerprint])? ";
        let q = classify(prompt);
        assert_eq!(q.kind, CredentialKind::HostKey);
        assert_eq!(q.host, "github.com");
        assert_eq!(q.detail.as_deref(), Some("SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU"));
        assert_eq!(q.store, None);

        // OpenSSH 10: "fingerprint is: SHA256:…" with a colon and without a trailing period.
        let q = classify(
            "The authenticity of host '[127.0.0.1]:2222 ([127.0.0.1]:2222)' can't be established.\n\
             ED25519 key fingerprint is: SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU\n\
             This key is not known by any other names.\n\
             Are you sure you want to continue connecting (yes/no/[fingerprint])? ",
        );
        assert_eq!(q.kind, CredentialKind::HostKey);
        assert_eq!(q.detail.as_deref(), Some("SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU"));
        // Different port, older version without "[fingerprint]", RSA.
        let prompt = "The authenticity of host '[localhost]:2222 ([127.0.0.1]:2222)' can't be established.\n\
                      RSA key fingerprint is SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8.\n\
                      Are you sure you want to continue connecting (yes/no)? ";
        let q = classify(prompt);
        assert_eq!(q.kind, CredentialKind::HostKey);
        assert_eq!(q.host, "[localhost]:2222");
        assert_eq!(q.detail.as_deref(), Some("SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8"));

        let q = classify("Please type 'yes', 'no' or the fingerprint: ");
        assert_eq!(q.kind, CredentialKind::HostKey);
        assert_eq!(q.host, "");
        assert_eq!(q.detail, None);
    }
}
