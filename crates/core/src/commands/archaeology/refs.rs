//! References in commit messages (`#12`, `!7`, `ABC-42`), found with the repository's effective
//! ticket link rules – the same rules and precedence as the UI's `src/app/ticketLinks.ts`: where
//! two rules match at the same place the earlier rule wins, overlapping matches are skipped.
//! Patterns run as the core checks them (`regex::bytes`, `unicode(false)`): `\b`, `\d`, `\w` are
//! ASCII like in JavaScript, so `#12ä` links the same way here and in the UI.

use regex::bytes::{Captures, Regex, RegexBuilder};

use crate::model::{ArchaeologyRef, ArchaeologyRefKind, LinkRule};

/// At most this many references per commit message.
pub const MAX_REFS_PER_MESSAGE: usize = 10;
/// Only the start of long messages is searched (as `MAX_LINKED_CHARS` in the UI).
const MAX_SCANNED_BYTES: usize = 20_000;

/// The rules in order of precedence, compiled once per timeline with the same builder
/// `links::pattern::check_pattern` uses. A pattern it does not accept is skipped (the core checked
/// them on saving; the repository file is checked on reading).
pub struct CompiledRules(Vec<(LinkRule, Regex)>);

impl CompiledRules {
    pub fn new(rules: &[LinkRule]) -> Self {
        CompiledRules(rules.iter().filter_map(|rule| RegexBuilder::new(&rule.pattern).unicode(false).build().ok().map(|regex| (rule.clone(), regex))).collect())
    }

    /// The references of `message` in text order, each address once, at most `MAX_REFS_PER_MESSAGE`.
    pub fn find(&self, message: &str) -> Vec<ArchaeologyRef> {
        let mut end = message.len().min(MAX_SCANNED_BYTES);
        while !message.is_char_boundary(end) {
            end -= 1;
        }
        let scanned = &message.as_bytes()[..end];
        let mut hits: Vec<(usize, usize, usize, ArchaeologyRef)> = Vec::new();
        for (order, (rule, regex)) in self.0.iter().enumerate() {
            for captures in regex.captures_iter(scanned) {
                let Some(whole) = captures.get(0) else { continue };
                if whole.as_bytes().is_empty() {
                    continue;
                }
                let Some(url) = expand_url(&rule.url, &captures) else { continue };
                let text = String::from_utf8_lossy(whole.as_bytes()).into_owned();
                hits.push((whole.start(), whole.end(), order, ArchaeologyRef { text, url, kind: kind_of(rule), title: None }));
            }
        }
        hits.sort_by_key(|(start, _, order, _)| (*start, *order));
        let mut found: Vec<ArchaeologyRef> = Vec::new();
        let mut at = 0;
        for (start, end, _, reference) in hits {
            if start < at {
                continue;
            }
            at = end;
            if !found.iter().any(|known| known.url == reference.url) {
                found.push(reference);
            }
            if found.len() == MAX_REFS_PER_MESSAGE {
                break;
            }
        }
        found
    }
}

fn kind_of(rule: &LinkRule) -> ArchaeologyRefKind {
    match rule.id.as_str() {
        "host:issue" => ArchaeologyRefKind::Issue,
        "host:merge_request" => ArchaeologyRefKind::PullRequest,
        _ => ArchaeologyRefKind::Ticket,
    }
}

/// `$0` = whole match, `$1` … = groups, each URL-encoded byte by byte (RFC 3986 like
/// `http::encode`: letters, digits and `-._~` stay); only `http(s)://` results count.
fn expand_url(template: &str, captures: &Captures<'_>) -> Option<String> {
    let mut url = String::with_capacity(template.len());
    let mut chars = template.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '$' {
            if let Some(digit) = chars.peek().and_then(|next| next.to_digit(10)) {
                chars.next();
                for &byte in captures.get(digit as usize).map_or(&[][..], |group| group.as_bytes()) {
                    if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
                        url.push(byte as char);
                    } else {
                        url.push_str(&format!("%{byte:02X}"));
                    }
                }
                continue;
            }
        }
        url.push(c);
    }
    let lower = url.to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://")).then_some(url)
}

/// Number of a host reference: `#12` → 12, `!7` → 7; `None` for tickets like `ABC-42`.
pub fn number_of(reference: &ArchaeologyRef) -> Option<u64> {
    if reference.kind == ArchaeologyRefKind::Ticket && !reference.text.starts_with(['#', '!']) {
        return None;
    }
    reference.text.trim_start_matches(['#', '!']).parse().ok()
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::links::host_rules;
    use crate::model::{HostKind, LinkRuleSource};

    fn rule(id: &str, source: LinkRuleSource, pattern: &str, url: &str) -> LinkRule {
        LinkRule { id: id.into(), source, pattern: pattern.into(), url: url.into() }
    }

    fn shown(found: &[ArchaeologyRef]) -> Vec<(&str, &str, ArchaeologyRefKind)> {
        found.iter().map(|reference| (reference.text.as_str(), reference.url.as_str(), reference.kind)).collect()
    }

    #[test]
    fn host_and_ticket_references_in_the_order_of_the_message() {
        let mut rules = vec![rule("preset:jira:0", LinkRuleSource::Preset, r"\b(?:OPS)-\d+\b", "https://jira.example/browse/$0")];
        rules.extend(host_rules(HostKind::Gitlab, "https://gitlab.example/gruppe/projekt"));
        let found = CompiledRules::new(&rules).find("Messung korrigiert (OPS-3)\n\nSiehe !7 und #12, nochmal #12 und OPS-3.");
        assert_eq!(
            shown(&found),
            vec![
                ("OPS-3", "https://jira.example/browse/OPS-3", ArchaeologyRefKind::Ticket),
                ("!7", "https://gitlab.example/gruppe/projekt/-/merge_requests/7", ArchaeologyRefKind::PullRequest),
                ("#12", "https://gitlab.example/gruppe/projekt/-/issues/12", ArchaeologyRefKind::Issue),
            ],
            "each address once, in the order of the message"
        );
        assert!(found.iter().all(|reference| reference.title.is_none()));
        assert_eq!(found.iter().map(number_of).collect::<Vec<_>>(), vec![None, Some(7), Some(12)]);
    }

    #[test]
    fn the_earlier_rule_wins_at_the_same_place_and_overlaps_are_skipped() {
        let rules = vec![
            rule("custom:intern", LinkRuleSource::Custom, r"#(\d+)\b", "https://intern.example/t/$1"),
            rule("host:issue", LinkRuleSource::Host, r"#(\d+)\b", "https://github.example/o/r/issues/$1"),
            rule("custom:lang", LinkRuleSource::Custom, r"#12-a", "https://never.example/$0"),
        ];
        let found = CompiledRules::new(&rules).find("Fix #12-a");
        assert_eq!(shown(&found), vec![("#12", "https://intern.example/t/12", ArchaeologyRefKind::Ticket)], "own rule before host rule; the overlapping later match is skipped");
    }

    #[test]
    fn groups_are_encoded_and_only_web_addresses_count() {
        let rules = vec![
            rule("custom:wiki", LinkRuleSource::Custom, r"wiki:(\S+)", "https://wiki.example/seite/$1"),
            rule("custom:bad", LinkRuleSource::Custom, r"bad:(\w+)", "javascript:alert('$1')"),
        ];
        let found = CompiledRules::new(&rules).find("siehe wiki:Größe/Übersicht und bad:xss");
        assert_eq!(shown(&found), vec![("wiki:Größe/Übersicht", "https://wiki.example/seite/Gr%C3%B6%C3%9Fe%2F%C3%9Cbersicht", ArchaeologyRefKind::Ticket)]);
    }

    #[test]
    fn word_boundaries_are_ascii_like_in_the_ui() {
        let rules = vec![rule("host:issue", LinkRuleSource::Host, r"#(\d+)\b", "https://h.example/issues/$1")];
        // JavaScript's `\b` sees no word character in “ä”, so `#12ä` links `#12` in the UI – here too.
        let found = CompiledRules::new(&rules).find("Größe #12ä und #٣");
        assert_eq!(shown(&found), vec![("#12", "https://h.example/issues/12", ArchaeologyRefKind::Issue)], "Arabic-Indic digits are no `\\d`");
    }

    #[test]
    fn at_most_ten_references_and_broken_patterns_are_skipped() {
        let rules = vec![rule("custom:broken", LinkRuleSource::Custom, r"(unclosed", "https://x.example/$0"), rule("host:issue", LinkRuleSource::Host, r"#(\d+)\b", "https://h.example/issues/$1")];
        let message: String = (1..=15).map(|n| format!("#{n} ")).collect();
        let found = CompiledRules::new(&rules).find(&message);
        assert_eq!(found.len(), MAX_REFS_PER_MESSAGE);
        assert_eq!(found[9].text, "#10");
    }
}
