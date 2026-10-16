//! Paket 4: title and description of a pull request from the commits of a branch.
//!
//! The answer `{ title, body }` is checked beyond the schema: a single-line title of at most 300
//! characters, and every heading of the repository's template still there – otherwise the one
//! repair attempt of `run::complete_json_checked`. Afterwards the core adds `Closes #n` for every
//! host issue the commits mention and reduces closing keywords before any other number to the
//! plain reference – every form the hosts act on (other repositories, issue URLs, GitLab's
//! keywords and lists after one keyword): closing an issue is an effect at the host the user did
//! not ask for, so neither the model nor a prompt injection in a commit may add one.

use std::collections::BTreeSet;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{json, Value};

use crate::model::{AiPrDescription, LinkRule, LinkRuleSource};

/// Longest title (the form's limit, `TITLE_LIMIT` in `PullRequestCreate`).
pub const TITLE_LIMIT: usize = 300;
/// At most this many ticket references go into the prompt.
pub const MAX_TICKETS: usize = 50;

/// A reference a link rule found in a commit message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ticket {
    pub text: String,
    pub url: String,
}

/// The answer: title and Markdown description.
pub fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "title": { "type": "string" },
            "body": { "type": "string" }
        },
        "required": ["title", "body"],
        "additionalProperties": false
    })
}

/// `## Text` → `"## Text"`: an ATX heading (`#` to `######` and a space; closing `#`s and repeated
/// whitespace dropped). `None` for anything else.
fn atx_heading(line: &str) -> Option<String> {
    let level = line.chars().take_while(|c| *c == '#').count();
    if !(1..=6).contains(&level) {
        return None;
    }
    let rest = &line[level..];
    if !(rest.is_empty() || rest.starts_with([' ', '\t'])) {
        return None;
    }
    let text = rest.trim();
    let stripped = text.trim_end_matches('#');
    let text = if stripped.len() < text.len() && (stripped.is_empty() || stripped.ends_with([' ', '\t'])) { stripped.trim_end() } else { text };
    if text.is_empty() {
        return None;
    }
    Some(format!("{} {}", "#".repeat(level), text.split_whitespace().collect::<Vec<_>>().join(" ")))
}

/// The ATX headings of a Markdown text, outside fenced code blocks and HTML comments.
pub fn template_headings(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut fence: Option<(char, usize)> = None;
    let mut in_comment = false;
    for line in text.lines() {
        if in_comment {
            if line.contains("-->") {
                in_comment = false;
            }
            continue;
        }
        let trimmed = line.trim_start_matches(' ');
        let indent = line.len() - trimmed.len();
        if let Some((mark, length)) = fence {
            let run = trimmed.chars().take_while(|c| *c == mark).count();
            if indent < 4 && run >= length && trimmed[run..].trim().is_empty() {
                fence = None;
            }
            continue;
        }
        if indent >= 4 {
            continue;
        }
        let opened = ['`', '~'].into_iter().find_map(|mark| {
            let run = trimmed.chars().take_while(|c| *c == mark).count();
            (run >= 3).then_some((mark, run))
        });
        if opened.is_some() {
            fence = opened;
            continue;
        }
        if let Some(rest) = trimmed.strip_prefix("<!--") {
            in_comment = !rest.contains("-->");
            continue;
        }
        if let Some(heading) = atx_heading(trimmed) {
            out.push(heading);
        }
    }
    out
}

/// Meaning check of the answer (after the schema check).
pub fn check_answer(value: &Value, headings: &[String]) -> Result<(), String> {
    let title = value["title"].as_str().unwrap_or_default().trim();
    if title.is_empty() {
        return Err("$.title: the title is empty".into());
    }
    if title.contains(['\n', '\r']) {
        return Err("$.title: the title must be a single line".into());
    }
    if title.chars().count() > TITLE_LIMIT {
        return Err(format!("$.title: the title has more than {TITLE_LIMIT} characters"));
    }
    let present: BTreeSet<String> = template_headings(value["body"].as_str().unwrap_or_default()).into_iter().collect();
    let missing: Vec<&str> = headings.iter().filter(|heading| !present.contains(*heading)).map(String::as_str).collect();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!("$.body: every heading of the pull request template must stay exactly as it is; missing: {}", missing.join(" | ")))
    }
}

/// `$0` … `$9` of a rule's address, filled from the match.
fn expand(template: &str, caps: &regex::Captures<'_>) -> String {
    let mut out = String::with_capacity(template.len());
    let mut chars = template.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '$' {
            if let Some(digit) = chars.peek().and_then(|d| d.to_digit(10)) {
                chars.next();
                out.push_str(caps.get(digit as usize).map_or("", |m| m.as_str()));
                continue;
            }
        }
        out.push(c);
    }
    out
}

struct Hit<'a> {
    start: usize,
    rule: &'a LinkRule,
    ticket: Ticket,
    number: Option<u64>,
}

/// The matches of all rules in one message; where two overlap, the earlier rule wins (as in the UI).
fn hits<'a>(message: &str, compiled: &'a [(LinkRule, Regex)]) -> Vec<Hit<'a>> {
    let mut taken: Vec<(usize, usize)> = Vec::new();
    let mut out = Vec::new();
    for (rule, regex) in compiled {
        for caps in regex.captures_iter(message) {
            let Some(whole) = caps.get(0) else { continue };
            if taken.iter().any(|(start, end)| whole.start() < *end && *start < whole.end()) {
                continue;
            }
            taken.push((whole.start(), whole.end()));
            let number = caps.get(1).and_then(|m| m.as_str().parse::<u64>().ok()).filter(|n| *n > 0);
            out.push(Hit { start: whole.start(), rule, ticket: Ticket { text: whole.as_str().to_string(), url: expand(&rule.url, &caps) }, number });
        }
    }
    out.sort_by_key(|hit| hit.start);
    out
}

fn compile(rules: &[LinkRule]) -> Vec<(LinkRule, Regex)> {
    rules.iter().filter_map(|rule| Regex::new(&rule.pattern).ok().map(|regex| (rule.clone(), regex))).collect()
}

/// Ticket references in the messages (oldest first), each text once, at most `MAX_TICKETS`.
pub fn tickets(messages: &[String], rules: &[LinkRule]) -> Vec<Ticket> {
    let compiled = compile(rules);
    let mut out: Vec<Ticket> = Vec::new();
    for message in messages {
        for hit in hits(message, &compiled) {
            if out.len() < MAX_TICKETS && !out.iter().any(|known| known.text == hit.ticket.text) {
                out.push(hit.ticket);
            }
        }
    }
    out
}

/// Numbers of host issues (`host:issue`) the messages mention, in order of first appearance.
pub fn issue_numbers(messages: &[String], rules: &[LinkRule]) -> Vec<u64> {
    let compiled = compile(rules);
    let mut out = Vec::new();
    for message in messages {
        for hit in hits(message, &compiled) {
            if hit.rule.source == LinkRuleSource::Host && hit.rule.id == "host:issue" {
                if let Some(number) = hit.number.filter(|n| !out.contains(n)) {
                    out.push(number);
                }
            }
        }
    }
    out
}

/// One reference a closing keyword can act on: `#n`, `owner/repo#n` or `group/sub/project#n`, an
/// issue URL, or an upper-case external ticket (`PROJ-7`, GitLab's Jira form); GitLab also allows
/// `issue`/`issues` in front of each.
const CLOSING_REF: &str = r"(?:issues?\s+)?(?:#\d+\b|[\w.-]+(?:/[\w.-]+)*#\d+\b|https?://[^\s,]+|(?-i:[A-Z][A-Z0-9_]+-\d+\b))";

/// A closing statement as the hosts read it: one keyword of the GitHub/Gitea set or GitLab's
/// larger one (`closing`, `implements`, `fixing`, `resolving` …), then a list of references joined
/// as GitLab joins them: an optional comma and/or `and`, plain spaces or nothing at all
/// (`#12 #77`, `#12#77`) – GitLab closes every issue of such a list.
fn closing_keyword() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        let keyword = r"clos(?:e[sd]?|ing)|fix(?:e[sd]|ing)?|resol(?:ve[sd]?|ving)|implement(?:s|ed|ing)?";
        let list = format!(r"{CLOSING_REF}(?:(?:\s*,?\s*and\s+|\s*,?\s*){CLOSING_REF})*");
        Regex::new(&format!(r"(?i)\b(?:{keyword})\s*:?\s*({list})")).expect("valid pattern")
    })
}

fn closing_ref() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(&format!("(?i){CLOSING_REF}")).expect("valid pattern"))
}

/// The issue numbers a closing statement's list closes, or `None` when one of its references is
/// anything but a plain `#n` (another repository, a URL, an `issue` prefix, a ticket).
fn plain_numbers(list: &str) -> Option<Vec<u64>> {
    closing_ref().find_iter(list).map(|item| item.as_str().strip_prefix('#').and_then(|digits| digits.parse().ok())).collect()
}

/// "Fixes #77" → "#77": a closing statement keeps its keyword only when every reference in it is
/// a plain `#n` of `closes`; otherwise the keyword goes and the references stay as plain text.
pub fn strip_foreign_closes(body: &str, closes: &[u64]) -> String {
    closing_keyword()
        .replace_all(body, |caps: &regex::Captures<'_>| match plain_numbers(&caps[1]) {
            Some(numbers) if numbers.iter().all(|n| closes.contains(n)) => caps[0].to_string(),
            _ => caps[1].to_string(),
        })
        .into_owned()
}

/// Appends `Closes #n` for every number the text does not close yet.
pub fn with_closes(body: &str, closes: &[u64]) -> String {
    let present: BTreeSet<u64> =
        closing_keyword().captures_iter(body).filter_map(|caps| plain_numbers(&caps[1])).flatten().collect();
    let lines: Vec<String> = closes.iter().filter(|n| !present.contains(n)).map(|n| format!("Closes #{n}")).collect();
    if lines.is_empty() {
        body.to_string()
    } else if body.trim().is_empty() {
        lines.join("\n")
    } else {
        format!("{body}\n\n{}", lines.join("\n"))
    }
}

/// The checked answer as the form gets it.
pub fn finish(value: &Value, closes: &[u64]) -> AiPrDescription {
    let title = value["title"].as_str().unwrap_or_default().trim().to_string();
    let body = strip_foreign_closes(value["body"].as_str().unwrap_or_default(), closes);
    AiPrDescription { title, body: with_closes(body.trim_end(), closes), closes: closes.to_vec() }
}

#[cfg(test)]
mod tests;
