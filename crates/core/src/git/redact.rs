//! Removes secrets before text goes into the log, into errors or into events:
//!
//! - credentials in URLs (`https://user:token@host` → `https://***@host`), even when the
//!   password contains an `@` or `/`,
//! - header lines with authentication (`Authorization: …`, `http.extraheader=…`, `X-Api-Key: …`),
//! - values of keys whose names suggest a secret (`…password=`, `…token=`,
//!   `sendemail.smtppass=`, `private_token=` in an address).
//!
//! This is a safety net for everything the core doesn't itself know to be a secret. The app's
//! secrets (tokens, API keys, proxy passwords) are additionally removed literally
//! (`secrets::scrub`).

use std::sync::OnceLock;

use regex::Regex;

const MASK: &str = "***";

fn compiled(cell: &'static OnceLock<Option<Regex>>, pattern: &str) -> Option<&'static Regex> {
    cell.get_or_init(|| Regex::new(pattern).ok()).as_ref()
}

/// `Authorization: Bearer …` and relatives: everything after the name up to the end of the line.
fn header() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    compiled(&RE, r"(?i)\b((?:proxy-)?authorization|x-api-key|private-token|job-token|set-cookie|cookie)(\s*[:=]\s*)[^\r\n\x00]+")
}

/// `http.<url>.extraheader=…` (also in the form `key\nvalue` from `git config -z`).
fn extra_header() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    compiled(&RE, r"(?i)(extraheader(?:\s*=\s*|\n))[^\r\n\x00]+")
}

/// `…password=value`, `…token: value`, `smtppass=value`, `api_key=value`.
fn secret_key() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    compiled(
        &RE,
        r#"(?i)\b([a-z0-9_.\-]*(?:password|passwd|smtppass|passphrase|secret|token|api[_-]?key)["']?\s*[=:]\s*["']?)[^\s&"'\x00]+"#,
    )
}

/// Host tokens with a well-known prefix (GitHub `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_`,
/// GitLab `glpat-` and relatives), wherever they appear.
fn host_token() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    compiled(&RE, r"\b(?:gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|gl(?:pat|dt|rt|ptt|ft|oas|cbt|imt)-[A-Za-z0-9_\-]{10,})")
}

/// A word that only introduces a question ("Password for 'https://…':") and is therefore
/// not a value.
fn is_plain_word(value: &str) -> bool {
    value.is_empty() || value == MASK
}

/// Replaces `user[:password]@` after every `scheme://` with `***@`.
///
/// The credentials reach up to the last `@` before the first `/`. If there is none there, but
/// the beginning looks like `user:password` (no port number after the colon), the password
/// itself contains a `/` – then the last `@` of the whole word counts.
fn redact_urls(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(found) = rest.find("://") {
        let scheme_start = rest[..found]
            .char_indices()
            .rev()
            .take_while(|(_, c)| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
            .last()
            .map_or(found, |(index, _)| index);
        let after = &rest[found + 3..];
        if scheme_start == found {
            // No scheme before it: not a URL.
            out.push_str(&rest[..found + 3]);
            rest = after;
            continue;
        }
        let word_end = after.find(|c: char| c.is_whitespace() || matches!(c, '\'' | '"' | '<' | '>' | '\0')).unwrap_or(after.len());
        let word = &after[..word_end];
        let authority_end = word.find('/').unwrap_or(word.len());
        let userinfo_end = match word[..authority_end].rfind('@') {
            Some(at) => Some(at),
            None => {
                let looks_like_credentials = word[..authority_end]
                    .split_once(':')
                    .is_some_and(|(user, tail)| !user.is_empty() && !tail.is_empty() && !tail.bytes().all(|b| b.is_ascii_digit()));
                if looks_like_credentials {
                    word.rfind('@')
                } else {
                    None
                }
            }
        };
        out.push_str(&rest[..found + 3]);
        match userinfo_end {
            Some(at) => {
                out.push_str(MASK);
                out.push_str(&word[at..]);
            }
            None => out.push_str(word),
        }
        rest = &after[word_end..];
    }
    out.push_str(rest);
    out
}

/// Removes credentials and other secrets from a text.
pub fn redact(text: &str) -> String {
    let mut out = if text.contains("://") { redact_urls(text) } else { text.to_string() };
    if let Some(re) = extra_header() {
        if let std::borrow::Cow::Owned(changed) = re.replace_all(&out, format!("${{1}}{MASK}").as_str()) {
            out = changed;
        }
    }
    if let Some(re) = header() {
        if let std::borrow::Cow::Owned(changed) = re.replace_all(&out, format!("${{1}}${{2}}{MASK}").as_str()) {
            out = changed;
        }
    }
    if let Some(re) = secret_key() {
        let replaced = re.replace_all(&out, |found: &regex::Captures<'_>| {
            let whole = &found[0];
            let prefix = &found[1];
            if is_plain_word(&whole[prefix.len()..]) {
                whole.to_string()
            } else {
                format!("{prefix}{MASK}")
            }
        });
        if let std::borrow::Cow::Owned(changed) = replaced {
            out = changed;
        }
    }
    if let Some(re) = host_token() {
        if let std::borrow::Cow::Owned(changed) = re.replace_all(&out, MASK) {
            out = changed;
        }
    }
    out
}

/// Like `redact`, for bytes (decoded lossily).
pub fn redact_bytes(bytes: &[u8]) -> String {
    redact(&String::from_utf8_lossy(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Secrets don't only appear as `scheme://user:password@` in output.
    #[test]
    fn sec08_headers_keys_and_awkward_passwords_are_removed() {
        // Password with "@" or "/": none of it remains.
        assert_eq!(redact("https://anna:ge@heim@github.com/a/b.git"), "https://***@github.com/a/b.git");
        assert!(!redact("https://anna:ge/heim@github.com/a/b.git").contains("heim"), "{}", redact("https://anna:ge/heim@github.com/a/b.git"));
        assert!(!redact("fatal: unable to access 'https://anna:a/b@c@host.example/r.git/'").contains("a/b@c"));
        // Header lines and keys from `git config --list`.
        for (line, secret) in [
            ("http.https://git.example.com/.extraheader=AUTHORIZATION: basic Z2VoZWltOnRva2Vu", "Z2VoZWltOnRva2Vu"),
            ("http.extraheader=Authorization: Bearer ghp_abcdefghijklmnop", "ghp_abcdefghijklmnop"),
            ("> Authorization: token glpat-geheim-123", "glpat-geheim-123"),
            ("Proxy-Authorization: Basic YW5uYTpnZWhlaW0=", "YW5uYTpnZWhlaW0="),
            ("sendemail.smtppass=smtp-Geheimnis", "smtp-Geheimnis"),
            ("credential.password=hunter2-lang", "hunter2-lang"),
            ("url?private_token=abcdef123456&x=1", "abcdef123456"),
            ("access_token=abcdef123456", "abcdef123456"),
            ("X-Api-Key: sk-ant-abcdef", "sk-ant-abcdef"),
        ] {
            let out = redact(line);
            assert!(!out.contains(secret), "{line} → {out}");
        }
        // Harmless things stay readable.
        assert_eq!(redact("remote.origin.url=https://github.com/a/b.git"), "remote.origin.url=https://github.com/a/b.git");
        assert_eq!(redact("user.email=anna@example.com"), "user.email=anna@example.com");
        assert_eq!(redact("error: pathspec 'token.txt' did not match"), "error: pathspec 'token.txt' did not match");
        assert_eq!(redact("git@github.com:a/b.git"), "git@github.com:a/b.git");
    }

    /// Host tokens recognisable by their prefix are removed even without a key or header before them.
    #[test]
    fn bare_host_tokens_are_removed() {
        for (line, secret) in [
            ("using ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 for the request", "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"),
            ("gho_1234567890abcdefXYZ", "gho_1234567890abcdefXYZ"),
            ("token github_pat_11ABCDEFG0123456789_abcdefghijklmnop rejected", "github_pat_11ABCDEFG0123456789_abcdefghijklmnop"),
            ("gitlab says glpat-xYz12_3-AbCdEfGhIjK is expired", "glpat-xYz12_3-AbCdEfGhIjK"),
        ] {
            let out = redact(line);
            assert!(!out.contains(secret), "{line} → {out}");
            assert!(out.contains("***"), "{out}");
        }
        // Words that merely start like a prefix stay.
        assert_eq!(redact("ghp_ is the prefix of classic tokens"), "ghp_ is the prefix of classic tokens");
    }

    #[test]
    fn removes_credentials() {
        assert!(header().is_some() && extra_header().is_some() && secret_key().is_some() && host_token().is_some());
        assert_eq!(redact("https://user:pw@github.com/a/b.git"), "https://***@github.com/a/b.git");
        assert_eq!(redact("fatal: https://ghp_abc@github.com/x"), "fatal: https://***@github.com/x");
        assert_eq!(redact("ssh://git@host:22/r"), "ssh://***@host:22/r");
        assert_eq!(redact("https://github.com/a/b"), "https://github.com/a/b");
        assert_eq!(redact("git@github.com:a/b.git"), "git@github.com:a/b.git");
        assert_eq!(redact("a http://u:p@h/x und https://v@w/y"), "a http://***@h/x und https://***@w/y");
    }
}
