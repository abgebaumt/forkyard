//! Patterns of ticket link rules: a subset of regular expressions that Rust's `regex` and the UI's
//! JavaScript `RegExp` (without flags) read the same way, and that cannot backtrack for long in
//! JavaScript. The core never matches with them; it decides what may be stored or taken from
//! `.forkyard/links.json`.
//!
//! Allowed: ASCII literals, `.`, `^`, `$`, `|`, groups `(…)` and `(?:…)`, character classes without
//! nesting or set operations, the escapes `\d \D \w \W \s \S \b \B` and a backslash before
//! punctuation, repetitions `* + ? {n} {n,} {n,m}` (also lazy). Not allowed: lookarounds, named
//! groups, flags, back-references, Unicode classes, a repeated group that itself contains a repetition
//! (`(a+)+`), a repetition with nothing to repeat (`a**`, `^*`, `\b+`), and patterns that match empty text.

/// Longer patterns are rejected.
pub const MAX_PATTERN_LEN: usize = 200;

/// Punctuation that may follow a backslash (both engines read it as the character itself).
const ESCAPED_PUNCT: &str = "\\.*+?()[]{}|^$-/#";

const BRACE: &str = "A “{” must start a repetition such as {2} or {1,3}; write \\{ for the character itself.";

/// Checks a pattern; `Ok(n)` = number of capture groups.
pub fn check_pattern(pattern: &str) -> Result<usize, String> {
    if pattern.is_empty() {
        return Err("The pattern is empty.".into());
    }
    if !pattern.is_ascii() {
        return Err("Only ASCII characters are allowed in a pattern.".into());
    }
    if pattern.len() > MAX_PATTERN_LEN {
        return Err(format!("The pattern is longer than {MAX_PATTERN_LEN} characters."));
    }
    if pattern.chars().any(|c| c.is_ascii_control()) {
        return Err("The pattern contains control characters.".into());
    }
    scan(pattern)?;
    let regex = regex::bytes::RegexBuilder::new(pattern)
        .unicode(false)
        .size_limit(1 << 20)
        .build()
        .map_err(|error| format!("The pattern is not a valid regular expression ({}).", reason(&error)))?;
    if regex.is_match(b"") {
        return Err("The pattern also matches empty text.".into());
    }
    Ok(regex.captures_len() - 1)
}

/// The last line of the regex error ("error: unclosed group").
fn reason(error: &regex::Error) -> String {
    let text = error.to_string();
    text.lines().rev().find_map(|line| line.trim().strip_prefix("error: ")).unwrap_or("invalid syntax").to_string()
}

fn check_escape(c: char, in_class: bool) -> Result<(), String> {
    if "dDwWsS".contains(c) || (!in_class && "bB".contains(c)) || ESCAPED_PUNCT.contains(c) {
        return Ok(());
    }
    if c.is_ascii_digit() {
        return Err("Back-references (\\1 …) are not allowed.".into());
    }
    Err(format!("The escape \\{c} is not allowed; use \\d, \\w, \\s, \\b or a backslash before a punctuation character."))
}

/// End (index after `}`) of a `{n}`, `{n,}` or `{n,m}` that starts at `start`.
fn quantifier_end(chars: &[char], start: usize) -> Result<usize, String> {
    let digits = |at: &mut usize| -> bool {
        let from = *at;
        while chars.get(*at).is_some_and(char::is_ascii_digit) {
            *at += 1;
        }
        *at > from
    };
    let mut i = start + 1;
    if !digits(&mut i) {
        return Err(BRACE.into());
    }
    if chars.get(i) == Some(&',') {
        i += 1;
        digits(&mut i);
    }
    if chars.get(i) != Some(&'}') {
        return Err(BRACE.into());
    }
    Ok(i + 1)
}

/// Index after the `]` of the class that opens at `start`.
fn scan_class(chars: &[char], start: usize) -> Result<usize, String> {
    let mut i = start + 1;
    if chars.get(i) == Some(&'^') {
        i += 1;
    }
    if chars.get(i) == Some(&']') {
        return Err("Empty character classes ([] or [^]) are not allowed; write \\] for the character.".into());
    }
    let mut previous: Option<char> = None;
    while i < chars.len() {
        match chars[i] {
            ']' => return Ok(i + 1),
            '\\' => {
                let next = *chars.get(i + 1).ok_or_else(|| "The pattern ends with a backslash.".to_string())?;
                check_escape(next, true)?;
                previous = None;
                i += 2;
                continue;
            }
            '[' => return Err("A “[” inside a character class must be written as \\[.".into()),
            c @ ('&' | '-' | '~') if previous == Some(c) => return Err(format!("“{c}{c}” is not allowed inside a character class.")),
            _ => {}
        }
        previous = Some(chars[i]);
        i += 1;
    }
    Err("A “[” is not closed.".into())
}

/// Checks the structure; the syntax details are left to the regex compiler afterwards.
fn scan(pattern: &str) -> Result<(), String> {
    let chars: Vec<char> = pattern.chars().collect();
    // One entry per open group: does it contain a repetition?
    let mut groups: Vec<bool> = Vec::new();
    // The item just before is a closed group that contains a repetition.
    let mut last_repeats = false;
    // The item just before can be repeated (JavaScript rejects `**`, `^*`, `\b+`, `(*` and `|+`
    // as "nothing to repeat", while Rust accepts some of them).
    let mut can_repeat = false;
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '\\' => {
                let next = *chars.get(i + 1).ok_or_else(|| "The pattern ends with a backslash.".to_string())?;
                check_escape(next, false)?;
                last_repeats = false;
                can_repeat = !matches!(next, 'b' | 'B');
                i += 2;
            }
            '[' => {
                i = scan_class(&chars, i)?;
                last_repeats = false;
                can_repeat = true;
            }
            '(' => {
                if chars.get(i + 1) == Some(&'?') {
                    if chars.get(i + 2) != Some(&':') {
                        return Err("Only groups “(…)” and “(?:…)” are allowed – no lookarounds, named groups or flags.".into());
                    }
                    i += 3;
                } else {
                    i += 1;
                }
                groups.push(false);
                last_repeats = false;
                can_repeat = false;
            }
            ')' => {
                let inner = groups.pop().ok_or_else(|| "A “)” has no matching “(”.".to_string())?;
                if inner {
                    if let Some(outer) = groups.last_mut() {
                        *outer = true;
                    }
                }
                last_repeats = inner;
                can_repeat = true;
                i += 1;
            }
            '^' | '$' | '|' => {
                last_repeats = false;
                can_repeat = false;
                i += 1;
            }
            c @ ('*' | '+' | '?' | '{') => {
                if !can_repeat {
                    return Err(format!("“{c}” has nothing to repeat; write \\{c} for the character itself."));
                }
                can_repeat = false;
                let end = if c == '{' { quantifier_end(&chars, i)? } else { i + 1 };
                if c != '?' {
                    if last_repeats {
                        return Err("A repeated group must not contain a repetition itself, e.g. (a+)+ – it can take very long to match.".into());
                    }
                    if let Some(group) = groups.last_mut() {
                        *group = true;
                    }
                }
                // Lazy form: `*?`, `+?`, `{1,3}?`.
                i = if chars.get(end) == Some(&'?') { end + 1 } else { end };
                last_repeats = false;
            }
            '}' => return Err("Write \\} for the character “}”.".into()),
            ']' => return Err("Write \\] for the character “]”.".into()),
            _ => {
                last_repeats = false;
                can_repeat = true;
                i += 1;
            }
        }
    }
    if !groups.is_empty() {
        return Err("A “(” is not closed.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_common_ticket_patterns() {
        assert_eq!(check_pattern(r"\b[A-Z][A-Z0-9]+-\d+\b"), Ok(0));
        assert_eq!(check_pattern(r"#(\d+)\b"), Ok(1));
        assert_eq!(check_pattern(r"\b(?:ABC|DEF)-(\d{1,6})\b"), Ok(1));
        assert_eq!(check_pattern(r"(?:fix(?:es)?|close[sd]?) #(\d+)"), Ok(1));
        assert_eq!(check_pattern(r"[\w.\-]+@\{(\d+)\}"), Ok(1));
        assert_eq!(check_pattern(r"CVE-(\d{4}-\d+)"), Ok(1));
        assert_eq!(check_pattern(r"T\d+?x"), Ok(0));
        assert!(check_pattern(&"a".repeat(MAX_PATTERN_LEN)).is_ok());
    }

    #[test]
    fn rejects_what_rust_and_javascript_read_differently_or_slowly() {
        let rejected = [
            ("", "empty"),
            (r"(?=x)a", "lookahead"),
            (r"(?<=x)a", "lookbehind"),
            (r"(?<n>a)", "named group"),
            (r"(?i)abc", "inline flag"),
            (r"(a)\1", "back-reference"),
            (r"\p{L}+", "Unicode class"),
            (r"\x41", "hex escape"),
            (r"\Aabc", "Rust-only anchor"),
            (r"a\<b", "Rust-only word start"),
            (r"[[:alpha:]]", "POSIX class"),
            (r"[a-z&&[^x]]", "class intersection"),
            (r"[]a]", "empty class"),
            (r"a{", "lone brace"),
            (r"a}", "lone closing brace"),
            (r"a]", "lone closing bracket"),
            (r"(a+)+$", "nested repetition"),
            (r"(?:\d*)*x", "nested repetition without capture"),
            (r"((a)+)+", "deeply nested repetition"),
            (r"(a{2})+", "nested counted repetition"),
            (r"\d*", "matches empty text"),
            (r"a|", "empty alternative"),
            ("ä-\\d+", "non-ASCII"),
            ("a\tb", "control character"),
            (r"(abc", "unclosed group"),
            (r"abc)", "stray parenthesis"),
            (r"[abc", "unclosed class"),
            (r"a\", "trailing backslash"),
            (r"*a", "nothing to repeat"),
            (r"a**", "repeated repetition"),
            (r"a?+", "repeated optional"),
            (r"^*a", "repeated anchor"),
            (r"\b+a", "repeated word boundary"),
            (r"a|+b", "repetition after an alternative"),
            (r"(+a)", "repetition at the start of a group"),
        ];
        for (pattern, why) in rejected {
            assert!(check_pattern(pattern).is_err(), "{why}: {pattern}");
        }
        let error = check_pattern(&"a".repeat(MAX_PATTERN_LEN + 1)).unwrap_err();
        assert!(error.contains("200"), "{error}");
        assert!(check_pattern(r"(a+)+").unwrap_err().contains("repetition"));
        assert!(check_pattern(r"a**").unwrap_err().contains("nothing to repeat"));
    }
}
