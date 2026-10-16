//! Local secret scan before every push (v1.2, spec 6.2). No AI, nothing leaves the computer: the
//! patterns of `git/redact.rs` plus an entropy rule look at the added lines of the commits a push
//! sends. A finding carries the place, the rule, the line with every value masked and at most the
//! last four characters of the value; the value itself is never stored, logged or shown.

use std::collections::HashSet;
use std::sync::OnceLock;

use regex::Regex;
use rusqlite::Connection;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::ai::ignore::builtin_reason;
use crate::app::Core;
use crate::db;
use crate::error::{CoreError, CoreResult};
use crate::git::redact::{self, SecretKind};
use crate::jobs::{CancelToken, Job};
use crate::model::{AiOmitReason, PushResult, SecretFinding, SecretRule};
use crate::{secrets, util};

/// The scan stops after this many outgoing commits (newest first) …
pub const MAX_COMMITS: usize = 1000;
/// … or this much patch text, and lists at most this many findings; then the result is `partial`.
pub const MAX_PATCH_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_FINDINGS: usize = 200;
/// Bits per character from which a quoted or assigned string counts as random.
pub const ENTROPY_MIN: f64 = 4.3;
const EXCERPT_CHARS: usize = 160;

/// Where in a line a value looks like a key, and why.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LineHit {
    pub start: usize,
    pub end: usize,
    pub rule: SecretRule,
}

fn rule_of(kind: SecretKind) -> SecretRule {
    match kind {
        SecretKind::KnownToken => SecretRule::KnownToken,
        SecretKind::PrivateKey => SecretRule::PrivateKey,
        SecretKind::Credential => SecretRule::Credential,
        SecretKind::UrlPassword => SecretRule::UrlPassword,
    }
}

/// A named value counts only if it looks like a real one: at least 8 characters, 5 different
/// ones, and no reference to somewhere else (`${VAR}`, `{{ x }}`, `<placeholder>`, `%s`, a call,
/// an environment variable).
pub fn real_value(value: &str) -> bool {
    let distinct: HashSet<char> = value.chars().collect();
    value.chars().count() >= 8
        && distinct.len() >= 5
        && !value.contains(|c: char| matches!(c, '$' | '{' | '}' | '<' | '>' | '(' | ')' | '%'))
        && !value.to_ascii_lowercase().contains("env")
}

/// Shannon entropy in bits per byte.
pub fn shannon_bits(text: &str) -> f64 {
    let bytes = text.as_bytes();
    if bytes.is_empty() {
        return 0.0;
    }
    let mut counts = [0usize; 256];
    for &byte in bytes {
        counts[byte as usize] += 1;
    }
    let total = bytes.len() as f64;
    counts
        .iter()
        .filter(|&&count| count > 0)
        .map(|&count| {
            let share = count as f64 / total;
            -share * share.log2()
        })
        .sum()
}

/// 20–200 characters, lower and upper case and a digit, at least `ENTROPY_MIN` bits per
/// character; hex-only strings (hashes, checksums) and SRI values (`sha512-…`) never count.
pub fn looks_random(value: &str) -> bool {
    let core = value.trim_end_matches('=');
    if !(20..=200).contains(&core.len()) || core.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return false;
    }
    if ["sha1-", "sha256-", "sha384-", "sha512-"].iter().any(|prefix| core.starts_with(prefix)) {
        return false;
    }
    let lower = core.bytes().any(|byte| byte.is_ascii_lowercase());
    let upper = core.bytes().any(|byte| byte.is_ascii_uppercase());
    let digit = core.bytes().any(|byte| byte.is_ascii_digit());
    lower && upper && digit && shannon_bits(core) >= ENTROPY_MIN
}

fn compiled(cell: &'static OnceLock<Option<Regex>>, pattern: &str) -> Option<&'static Regex> {
    cell.get_or_init(|| Regex::new(pattern).ok()).as_ref()
}

/// A string in quotes.
fn quoted() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    compiled(&RE, r#"["'`]([A-Za-z0-9+/=_\-]{20,200})["'`]"#)
}

/// A value after `=` or `:`, up to a space, `,`, `;` or the end of the line.
fn assigned() -> Option<&'static Regex> {
    static RE: OnceLock<Option<Regex>> = OnceLock::new();
    compiled(&RE, r"[=:]\s*([A-Za-z0-9+/=_\-]{20,200})(?:[\s,;]|$)")
}

/// The values in one added line that look like keys, sorted by position. `path` decides whether
/// the entropy rule applies (not in generated and lock files).
pub fn scan_line(path: &str, line: &str) -> Vec<LineHit> {
    let mut hits: Vec<LineHit> = redact::secret_spans(line)
        .into_iter()
        .filter(|span| match span.kind {
            SecretKind::Credential | SecretKind::UrlPassword => real_value(&line[span.start..span.end]),
            SecretKind::KnownToken | SecretKind::PrivateKey => true,
        })
        .map(|span| LineHit { start: span.start, end: span.end, rule: rule_of(span.kind) })
        .collect();
    if builtin_reason(path) != Some(AiOmitReason::Generated) {
        for re in [quoted(), assigned()].into_iter().flatten() {
            for captures in re.captures_iter(line) {
                let Some(value) = captures.get(1) else { continue };
                let (start, end) = (value.start(), value.end());
                if hits.iter().any(|hit| start < hit.end && hit.start < end) || !looks_random(value.as_str()) {
                    continue;
                }
                hits.push(LineHit { start, end, rule: SecretRule::HighEntropy });
            }
        }
    }
    hits.sort_by_key(|hit| hit.start);
    hits
}

/// The line for the dialog: every value replaced by its hint (`…` + last four characters), the
/// rest through `redact`, at most `EXCERPT_CHARS` characters. The BEGIN line of a private key stays.
pub fn mask_line(line: &str, hits: &[LineHit]) -> String {
    let mut out = String::with_capacity(line.len().min(EXCERPT_CHARS * 2));
    let mut position = 0;
    for hit in hits {
        if hit.start < position {
            continue;
        }
        out.push_str(&redact::redact(&line[position..hit.start]));
        let value = &line[hit.start..hit.end];
        if hit.rule == SecretRule::PrivateKey {
            out.push_str(value);
        } else {
            out.push_str(&secrets::hint(value));
        }
        position = hit.end;
    }
    out.push_str(&redact::redact(&line[position..]));
    let trimmed = out.trim();
    if trimmed.chars().count() > EXCERPT_CHARS {
        format!("{}…", trimmed.chars().take(EXCERPT_CHARS).collect::<String>())
    } else {
        trimmed.to_string()
    }
}

/// SHA-256 (lower-case hex) of the path bytes, a zero byte and the line bytes (without CR).
pub fn finding_id(path: &[u8], line: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(path);
    hasher.update([0u8]);
    hasher.update(line);
    hasher.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Git's C quoting (`"…"` with `\\`, `\"`, `\t`, `\n` … and `\ooo` for bytes outside ASCII).
fn unquote_c(quoted: &[u8]) -> Option<Vec<u8>> {
    let inner = quoted.strip_prefix(b"\"")?;
    let mut out = Vec::with_capacity(inner.len());
    let mut index = 0;
    while index < inner.len() {
        match inner[index] {
            b'"' => return Some(out),
            b'\\' => {
                let next = *inner.get(index + 1)?;
                if next.is_ascii_digit() {
                    let digits = inner.get(index + 1..index + 4)?;
                    let value = digits.iter().try_fold(0u32, |acc, digit| (b'0'..=b'7').contains(digit).then(|| acc * 8 + u32::from(*digit - b'0')))?;
                    out.push(u8::try_from(value).ok()?);
                    index += 4;
                    continue;
                }
                out.push(match next {
                    b'n' => b'\n',
                    b't' => b'\t',
                    b'r' => b'\r',
                    b'a' => 7,
                    b'b' => 8,
                    b'f' => 12,
                    b'v' => 11,
                    other => other,
                });
                index += 2;
            }
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    None
}

/// The path after `+++ `: `b/<path>` (with a trailing tab when it contains a space) or the
/// quoted form `"b/…"`. `None` for `/dev/null` and anything unreadable.
pub fn new_path(rest: &[u8]) -> Option<Vec<u8>> {
    let raw = if rest.first() == Some(&b'"') { unquote_c(rest)? } else { rest.strip_suffix(b"\t").unwrap_or(rest).to_vec() };
    if raw == b"/dev/null" {
        return None;
    }
    raw.strip_prefix(b"b/").map(<[u8]>::to_vec)
}

/// Result of a scan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecretScan {
    /// Sorted by path, then line; at most `MAX_FINDINGS`.
    pub findings: Vec<SecretFinding>,
    pub commits: u32,
    /// A limit was reached: not every outgoing commit or finding is included.
    pub partial: bool,
}

/// Reads `git log --format=%x00%H -p -U0 --src-prefix=a/ --dst-prefix=b/` line by line (as a
/// stream, so a huge history is never held in memory). Only `+` lines inside a hunk count; a line
/// starting with `+++ ` inside a hunk is content, not a header.
pub struct PatchScanner<'a> {
    ignored: &'a HashSet<String>,
    max_commits: usize,
    max_bytes: usize,
    commit: String,
    commits: u32,
    path: Option<Vec<u8>>,
    in_hunk: bool,
    next_line: u32,
    bytes: usize,
    partial: bool,
    seen: HashSet<String>,
    findings: Vec<SecretFinding>,
}

impl<'a> PatchScanner<'a> {
    pub fn new(ignored: &'a HashSet<String>, max_commits: usize, max_bytes: usize) -> Self {
        PatchScanner {
            ignored,
            max_commits,
            max_bytes,
            commit: String::new(),
            commits: 0,
            path: None,
            in_hunk: false,
            next_line: 1,
            bytes: 0,
            partial: false,
            seen: HashSet::new(),
            findings: Vec::new(),
        }
    }

    /// One line without its `\n`. `false`: a limit was reached, stop reading.
    pub fn feed(&mut self, line: &[u8]) -> bool {
        self.bytes += line.len() + 1;
        if self.bytes > self.max_bytes {
            self.partial = true;
            return false;
        }
        if let Some(sha) = line.strip_prefix(b"\0") {
            if self.commits as usize >= self.max_commits {
                self.partial = true;
                return false;
            }
            self.commits += 1;
            self.commit = util::decode_lossy(sha).trim().to_string();
            self.path = None;
            self.in_hunk = false;
            return true;
        }
        if line.starts_with(b"diff --git ") {
            self.path = None;
            self.in_hunk = false;
            return true;
        }
        if self.in_hunk {
            match line.first() {
                Some(b'+') => self.added(&line[1..]),
                Some(b' ') => self.next_line = self.next_line.saturating_add(1),
                Some(b'@') => self.hunk(line),
                _ => {}
            }
            return true;
        }
        if let Some(rest) = line.strip_prefix(b"+++ ") {
            self.path = new_path(rest);
        } else if line.starts_with(b"@@ ") {
            self.hunk(line);
        }
        true
    }

    /// `@@ -a,b +c,d @@`: the next added line has number `c`.
    fn hunk(&mut self, line: &[u8]) {
        let text = util::decode_lossy(line);
        let start = text.split(' ').find_map(|part| part.strip_prefix('+')).and_then(|range| range.split(',').next()).and_then(|number| number.parse::<u32>().ok());
        self.next_line = start.unwrap_or(1);
        self.in_hunk = true;
    }

    fn added(&mut self, content: &[u8]) {
        let number = self.next_line;
        self.next_line = self.next_line.saturating_add(1);
        let Some(path) = self.path.as_deref() else { return };
        let content = content.strip_suffix(b"\r").unwrap_or(content);
        let text = util::decode_lossy(content);
        let path_text = util::decode_lossy(path);
        let hits = scan_line(&path_text, &text);
        let Some(first) = hits.first().copied() else { return };
        let id = finding_id(path, content);
        if self.ignored.contains(&id) || !self.seen.insert(id.clone()) {
            return;
        }
        if self.findings.len() >= MAX_FINDINGS {
            self.partial = true;
            return;
        }
        let hint = if first.rule == SecretRule::PrivateKey { String::new() } else { secrets::hint(&text[first.start..first.end]) };
        self.findings.push(SecretFinding { id, path: path_text, line: number, commit: self.commit.clone(), rule: first.rule, excerpt: mask_line(&text, &hits), hint });
    }

    pub fn finish(mut self) -> SecretScan {
        self.findings.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
        SecretScan { findings: self.findings, commits: self.commits, partial: self.partial }
    }
}

/// `repo_settings` key of "Don't report again": a JSON array of finding IDs (hashes, never values).
pub const IGNORED_KEY: &str = "secretScanIgnoredIds";
/// At most this many IDs are kept per repository (the newest).
pub const MAX_IGNORED: usize = 2000;

/// Scans the added lines of every commit reachable from `tips` (full refs) but not from a
/// remote-tracking branch of `remote` – newest first, within `MAX_COMMITS` and `MAX_PATCH_BYTES`.
/// Read-only and without a log entry: the patch holds file contents.
pub async fn scan_outgoing(core: &Core, repo_id: &str, tips: &[String], remote: &str, cancel: &CancelToken) -> CoreResult<SecretScan> {
    let ignored = core.db.with(|c| ignored_ids(c, repo_id))?;
    let mut scanner = PatchScanner::new(&ignored, MAX_COMMITS, MAX_PATCH_BYTES);
    core.git_for(repo_id)?
        .args(["log", "--format=%x00%H", "-p", "-U0", "-M", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/"])
        .arg(format!("--max-count={}", MAX_COMMITS + 1))
        .args(tips)
        .arg("--not")
        .arg(format!("--remotes={remote}"))
        .arg("--")
        .read_only()
        .no_log()
        .run_records(b'\n', Some(cancel), &mut |line: &[u8]| scanner.feed(line))
        .await?;
    Ok(scanner.finish())
}

fn stored_ids(conn: &Connection, repo_id: &str) -> CoreResult<Vec<String>> {
    let value = db::repo_settings::get_all(conn, repo_id)?.into_iter().find(|(key, _)| key == IGNORED_KEY).map(|(_, value)| value);
    Ok(match value {
        Some(Value::Array(items)) => items.into_iter().filter_map(|item| item.as_str().map(str::to_string)).collect(),
        _ => Vec::new(),
    })
}

/// The findings this repository no longer reports.
pub fn ignored_ids(conn: &Connection, repo_id: &str) -> CoreResult<HashSet<String>> {
    Ok(stored_ids(conn, repo_id)?.into_iter().collect())
}

/// "Don't report again": stores the IDs (64 lower-case hex characters each); returns how many
/// IDs are stored now.
pub fn ignore_ids(conn: &Connection, repo_id: &str, ids: &[String]) -> CoreResult<usize> {
    if let Some(bad) = ids.iter().find(|id| id.len() != 64 || !id.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))) {
        return Err(CoreError::not_allowed(format!("“{}” is not the ID of a finding.", util::truncate_str(bad, 80))));
    }
    let mut list = stored_ids(conn, repo_id)?;
    for id in ids {
        if !list.contains(id) {
            list.push(id.clone());
        }
    }
    if list.len() > MAX_IGNORED {
        let excess = list.len() - MAX_IGNORED;
        list.drain(..excess);
    }
    db::repo_settings::set(conn, repo_id, IGNORED_KEY, &Value::Array(list.iter().cloned().map(Value::String).collect()))?;
    Ok(list.len())
}

/// "Report again": forgets every "Don't report again" of the repository.
pub fn forget_ignored(conn: &Connection, repo_id: &str) -> CoreResult<()> {
    db::repo_settings::delete(conn, repo_id, IGNORED_KEY)
}

/// Before every push: `Some(SecretsFound)` if an outgoing added line looks like a key and is not
/// among `accepted` (the IDs the user saw and pushed anyway); then nothing may be sent.
pub async fn check_push(core: &Core, repo_id: &str, tips: &[String], remote: &str, accepted: Option<&[String]>, job: Option<&Job>, cancel: &CancelToken) -> CoreResult<Option<PushResult>> {
    if let Some(job) = job {
        job.progress("Push", None, "Checking the added lines for keys …");
    }
    let scan = scan_outgoing(core, repo_id, tips, remote, cancel).await?;
    let accepted: HashSet<&str> = accepted.unwrap_or_default().iter().map(String::as_str).collect();
    if scan.findings.iter().all(|finding| accepted.contains(finding.id.as_str())) {
        return Ok(None);
    }
    Ok(Some(PushResult::SecretsFound { findings: scan.findings, commits: scan.commits, partial: scan.partial }))
}

/// For pushes without a dialog of their own (Gitflow): names at most three places, never a value.
pub fn stopped_message(label: &str, findings: &[SecretFinding]) -> String {
    let places: Vec<String> = findings.iter().take(3).map(|finding| format!("{}:{}", finding.path, finding.line)).collect();
    let more = if findings.len() > 3 { ", …" } else { "" };
    let what = if findings.len() == 1 { "1 added line looks".to_string() } else { format!("{} added lines look", findings.len()) };
    format!("{label} was not pushed: {what} like a key ({}{more}). Push it with “Push” to see the findings and decide.", places.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    // Built at run time: no literal key format in this file.
    fn token() -> String {
        format!("ghp_{}", "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789")
    }
    fn aws() -> String {
        format!("AKIA{}", "Q7RZ4M2XK9PLW3NB")
    }
    /// 32 characters, 5.0 bits per character (each character once).
    const RANDOM: &str = "Zx9Qm2Lr7Tv4Wk8Np3Hs6Bd1Fg5Jc0Ya";

    fn rules(path: &str, line: &str) -> Vec<SecretRule> {
        scan_line(path, line).into_iter().map(|hit| hit.rule).collect()
    }

    #[test]
    fn lines_that_look_like_keys_are_found_and_ordinary_code_is_not() {
        assert_eq!(rules("a.py", &format!("TOKEN = \"{}\"", token())), vec![SecretRule::KnownToken]);
        assert_eq!(rules("a.rs", &format!("let id = \"{}\";", aws())), vec![SecretRule::KnownToken]);
        assert_eq!(rules("k.pem", &format!("-----BEGIN {}PRIVATE KEY-----", "RSA ")), vec![SecretRule::PrivateKey]);
        assert_eq!(rules("a.yml", "password: hunter2-lang"), vec![SecretRule::Credential]);
        assert_eq!(rules("a.ini", "url = https://anna:Geheim-2026x@git.example.com/r.git"), vec![SecretRule::UrlPassword]);
        assert_eq!(rules("a.ts", &format!("const signing = \"{RANDOM}\";")), vec![SecretRule::HighEntropy]);
        assert_eq!(rules("a.env", &format!("SESSION_SALT={RANDOM}")), vec![SecretRule::HighEntropy]);
        for (path, line) in [
            ("a.ts", "password: string;"),
            ("a.ts", "const password = process.env.DB_PASSWORD;"),
            ("a.yml", "api_key: ${API_KEY}"),
            ("a.py", "token = get_token()"),
            ("a.py", "password = \"********\""),
            ("a.ts", "const name = \"GetUserById2FromDatabaseCache\";"),
            ("a.ts", "const id = \"550e8400-e29b-41d4-a716-446655440000\";"),
            ("a.ts", "const sha = \"9fceb02d0ae598e95dc970b74767f19372d61af8\";"),
            ("a.ts", "const md5 = \"d41d8cd98f00b204e9800998ecf8427e\";"),
            ("a.md", "Siehe https://github.com/forkyard/forkyard/blob/main/README.md"),
            ("a.txt", "max_tokens = 4096"),
            ("a.txt", "-----BEGIN PUBLIC KEY-----"),
            ("a.txt", "Die Übergabe erfolgt um 14:00 Uhr am Südtor."),
        ] {
            assert!(scan_line(path, line).is_empty(), "{path}: {line} → {:?}", scan_line(path, line));
        }
        // Lock files carry random-looking checksums: only the patterns count there.
        assert_eq!(rules("package-lock.json", &format!("\"integrity\": \"{RANDOM}\",")), Vec::<SecretRule>::new());
        assert_eq!(rules("web/package-lock.json", &format!("\"_auth\": \"{}\"", token())), vec![SecretRule::KnownToken]);
        assert_eq!(rules("app.js", &format!("x = \"sha512-{RANDOM}\"")), Vec::<SecretRule>::new(), "an SRI value is a checksum");
    }

    #[test]
    fn entropy_and_value_rules_follow_their_thresholds() {
        assert_eq!(shannon_bits(""), 0.0);
        assert_eq!(shannon_bits("aaaa"), 0.0);
        assert!((shannon_bits("abcd") - 2.0).abs() < 1e-9);
        assert!((shannon_bits(RANDOM) - 5.0).abs() < 1e-9);
        assert!(looks_random(RANDOM));
        assert!(!looks_random(&RANDOM[..19]), "below 20 characters");
        assert!(!looks_random("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaB1"), "0.4 bits per character");
        assert!(!looks_random("ZX9QM2LR7TV4WK8NP3HS6BD1FG5JC0YA"), "no lower case");
        assert!(!looks_random("deadbeefdeadbeefdeadbeefdeadbeef01234567"), "hex only");
        assert!(real_value("hunter2-lang"));
        assert!(!real_value("hunter2"), "fewer than 8 characters");
        assert!(!real_value("aaaabbbb"), "fewer than 5 different characters");
        for reference in ["${DB_PASS}", "{{ secret }}", "<your-token-here>", "getenv(\"X\")", "%(password)s", "process.env.TOKEN_VALUE"] {
            assert!(!real_value(reference), "{reference}");
        }
    }

    #[test]
    fn findings_show_at_most_the_last_four_characters() {
        let line = format!("AWS_ZUGANG = \"{}\"  # und password=hunter2-lang", aws());
        let hits = scan_line("dienst.py", &line);
        assert_eq!(hits.iter().map(|hit| hit.rule).collect::<Vec<_>>(), vec![SecretRule::KnownToken, SecretRule::Credential]);
        assert_eq!(mask_line(&line, &hits), "AWS_ZUGANG = \"…W3NB\"  # und password=…lang");
        let short = "pin_secret = Kx7mQ2zP";
        assert_eq!(mask_line(short, &scan_line("a.cfg", short)), "pin_secret = …", "8 characters: not even the tail");
        let long = format!("{} key = \"{}\"", "x".repeat(300), aws());
        let excerpt = mask_line(&long, &scan_line("a.txt", &long));
        assert_eq!(excerpt.chars().count(), 161);
        assert!(excerpt.ends_with('…') && !excerpt.contains(&aws()[..12]));
        let pem = format!("-----BEGIN {}PRIVATE KEY-----", "OPENSSH ");
        assert_eq!(mask_line(&pem, &scan_line("id", &pem)), pem, "the marker itself is no secret");
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
    }

    /// `git log --format=%x00%H -p -U0` as Git writes it, line by line.
    fn sample_patch() -> Vec<Vec<u8>> {
        let key = aws();
        let pem = format!("-----BEGIN {}PRIVATE KEY-----", "OPENSSH ");
        let mut lines: Vec<Vec<u8>> = Vec::new();
        let mut add = |line: &[u8]| lines.push(line.to_vec());
        add(format!("\0{}", "a".repeat(40)).as_bytes());
        add(b"");
        // Umlaut, space and a leading '-': Git quotes the path and escapes the bytes in octal.
        add(b"diff --git \"a/-geheim/z\\303\\274gang daten.txt\" \"b/-geheim/z\\303\\274gang daten.txt\"");
        add(b"new file mode 100644");
        add(b"--- /dev/null");
        add(b"+++ \"b/-geheim/z\\303\\274gang daten.txt\"");
        add(b"@@ -0,0 +1,3 @@");
        add(b"+erste Zeile\r");
        add(b"+++ kein Kopf, sondern Inhalt");
        add(format!("+AWS = \"{key}\"\r").as_bytes());
        // A space in the name: Git appends a tab to the --- / +++ lines.
        add(b"diff --git a/doku/mit leer.md b/doku/mit leer.md");
        add(b"--- a/doku/mit leer.md\t");
        add(b"+++ b/doku/mit leer.md\t");
        add(b"@@ -10,2 +9,0 @@");
        add(b"-password=hunter2-lang");
        add(b"-zweite");
        add(b"@@ -20,0 +19,2 @@ Abschnitt");
        add(b"+harmlos");
        add(b"+password = \"anders-2026x\"");
        add(b"diff --git a/bild.png b/bild.png");
        add(b"new file mode 100644");
        add(b"Binary files /dev/null and b/bild.png differ");
        add(b"diff --git a/alt.txt b/alt.txt");
        add(b"deleted file mode 100644");
        add(b"--- a/alt.txt");
        add(b"+++ /dev/null");
        add(b"@@ -1 +0,0 @@");
        add(format!("-{}", token()).as_bytes());
        // An older commit adds the same line again (without CR): one finding, the newest commit.
        add(format!("\0{}", "b".repeat(40)).as_bytes());
        add(b"");
        add(b"diff --git \"a/-geheim/z\\303\\274gang daten.txt\" \"b/-geheim/z\\303\\274gang daten.txt\"");
        add(b"--- \"a/-geheim/z\\303\\274gang daten.txt\"");
        add(b"+++ \"b/-geheim/z\\303\\274gang daten.txt\"");
        add(b"@@ -6,0 +7 @@");
        add(format!("+AWS = \"{key}\"").as_bytes());
        add(format!("\0{}", "c".repeat(40)).as_bytes());
        add(b"");
        add(b"diff --git a/schluessel/id_ed25519 b/schluessel/id_ed25519");
        add(b"+++ b/schluessel/id_ed25519");
        add(b"@@ -0,0 +1,2 @@");
        add(format!("+{pem}").as_bytes());
        add(b"+b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAt");
        lines
    }

    fn scan_lines(lines: &[Vec<u8>], ignored: &HashSet<String>, max_commits: usize, max_bytes: usize) -> SecretScan {
        let mut scanner = PatchScanner::new(ignored, max_commits, max_bytes);
        for line in lines {
            if !scanner.feed(line) {
                break;
            }
        }
        scanner.finish()
    }

    #[test]
    fn the_patch_scanner_reads_only_added_lines_with_their_new_line_numbers() {
        let lines = sample_patch();
        let scan = scan_lines(&lines, &HashSet::new(), MAX_COMMITS, MAX_PATCH_BYTES);
        let places: Vec<(&str, u32, SecretRule, &str)> = scan.findings.iter().map(|f| (f.path.as_str(), f.line, f.rule, f.commit.as_str())).collect();
        let (a, c) = ("a".repeat(40), "c".repeat(40));
        assert_eq!(
            places,
            vec![
                ("-geheim/zügang daten.txt", 3, SecretRule::KnownToken, a.as_str()),
                ("doku/mit leer.md", 20, SecretRule::Credential, a.as_str()),
                ("schluessel/id_ed25519", 1, SecretRule::PrivateKey, c.as_str()),
            ]
        );
        assert_eq!((scan.commits, scan.partial), (3, false));
        let first = &scan.findings[0];
        assert_eq!(first.excerpt, "AWS = \"…W3NB\"", "no CR, value masked");
        assert_eq!(first.hint, "…W3NB");
        assert_eq!(first.id, sha256_hex(format!("-geheim/zügang daten.txt\0AWS = \"{}\"", aws()).as_bytes()), "hash of path and line content");
        assert_eq!(scan.findings[2].hint, "", "a private key has no tail to show");
        assert!(!format!("{:?}", scan.findings).contains(&aws()));

        // "Don't report again" for the second one.
        let ignored: HashSet<String> = [sha256_hex(b"doku/mit leer.md\0password = \"anders-2026x\"")].into_iter().collect();
        let quiet = scan_lines(&lines, &ignored, MAX_COMMITS, MAX_PATCH_BYTES);
        assert_eq!(quiet.findings.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), vec!["-geheim/zügang daten.txt", "schluessel/id_ed25519"]);

        // Limits: two commits, or a few bytes.
        let two = scan_lines(&lines, &HashSet::new(), 2, MAX_PATCH_BYTES);
        assert_eq!((two.commits, two.partial, two.findings.len()), (2, true, 2));
        let tiny = scan_lines(&lines, &HashSet::new(), MAX_COMMITS, 200);
        assert!(tiny.partial && tiny.findings.is_empty());
    }

    #[test]
    fn paths_are_unquoted_byte_exact() {
        assert_eq!(new_path(b"b/src/main.rs"), Some(b"src/main.rs".to_vec()));
        assert_eq!(new_path(b"b/mit leer.txt\t"), Some(b"mit leer.txt".to_vec()));
        assert_eq!(new_path(b"\"b/z\\303\\274gang\\tmit\\\"quote\\\"\""), Some("zügang\tmit\"quote\"".as_bytes().to_vec()));
        assert_eq!(new_path(b"\"b/latin\\374.txt\""), Some(b"latin\xfc.txt".to_vec()), "a Latin-1 byte stays a byte");
        assert_eq!(new_path(b"/dev/null"), None);
        assert_eq!(new_path(b"\"b/kaputt"), None, "an unterminated quote is no path");
    }

    #[test]
    fn a_thousand_added_lines_are_scanned_in_under_200_ms() {
        let mut lines: Vec<Vec<u8>> = vec![format!("\0{}", "d".repeat(40)).into_bytes(), Vec::new(), b"diff --git a/gross.rs b/gross.rs".to_vec(), b"+++ b/gross.rs".to_vec(), b"@@ -0,0 +1,1000 @@".to_vec()];
        for n in 1..=1000u32 {
            let line = if n % 100 == 0 { format!("+let token_{n} = \"ghp_{}{n:04}\";", "AbCdEfGhIjKlMnOpQrStUvWxYz012345") } else { format!("+let wert_{n} = berechne({n}, \"Messreihe Hafen\");") };
            lines.push(line.into_bytes());
        }
        // Compile the patterns before timing.
        assert!(scan_line("warm.rs", "let a = 1;").is_empty());
        let started = Instant::now();
        let scan = scan_lines(&lines, &HashSet::new(), MAX_COMMITS, MAX_PATCH_BYTES);
        let elapsed = started.elapsed();
        assert_eq!(scan.findings.len(), 10);
        assert_eq!(scan.findings.iter().map(|f| f.line).collect::<Vec<_>>(), (1..=10).map(|n| n * 100).collect::<Vec<u32>>());
        assert!(elapsed.as_millis() < 200, "spec target: < 200 ms, took {elapsed:?}");
    }
}

#[cfg(test)]
#[path = "secret_scan_tests.rs"]
mod repo_tests;
