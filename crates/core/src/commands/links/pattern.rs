//! Patterns of ticket link rules: a subset of regular expressions that Rust's `regex` and the UI's
//! JavaScript `RegExp` (without flags) read the same way, and that cannot backtrack for long in
//! JavaScript. The core never matches with them; it decides what may be stored or taken from
//! `.forkyard/links.json`.
//!
//! Allowed: ASCII literals, `.`, `^`, `$`, `|`, groups `(…)` and `(?:…)`, character classes without
//! nesting or set operations, the escapes `\d \D \w \W \s \S \b \B` and a backslash before
//! punctuation, repetitions `* + ? {n} {n,} {n,m}` (also lazy). Not allowed: lookarounds, named
//! groups, flags, back-references, Unicode classes, a repeated group that itself contains a repetition
//! (`(a+)+`) or an alternative (`(a|b)+`), unbounded repetitions in a row that can match the same
//! characters (`\w+\w+`, `\w*a\w*`), a repetition with nothing to repeat (`a**`, `^*`, `\b+`), and
//! patterns that match empty text.

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

/// A set of characters: bit `c` for ASCII `c`, bit 0 for everything else (NUL is never in a pattern).
type Chars = u128;

const ALL: Chars = Chars::MAX;
const OTHER: Chars = 1;

fn char_bit(c: char) -> Chars {
    if c.is_ascii() && c != '\0' {
        1 << (c as u32)
    } else {
        OTHER
    }
}

fn char_range(from: char, to: char) -> Chars {
    (from..=to).fold(0, |set, c| set | char_bit(c))
}

fn digits() -> Chars {
    char_range('0', '9')
}

fn word() -> Chars {
    digits() | char_range('a', 'z') | char_range('A', 'Z') | char_bit('_')
}

/// `\s` also matches Unicode spaces, hence `OTHER`.
fn space() -> Chars {
    char_range('\t', '\r') | char_bit(' ') | OTHER
}

/// Characters an (already checked) escape matches.
fn escape_chars(c: char) -> Chars {
    match c {
        'd' => digits(),
        'D' => !digits(),
        'w' => word(),
        'W' => !word(),
        's' => space(),
        'S' => !space(),
        _ => char_bit(c),
    }
}

/// Index after the `]` of the class that opens at `start`, and the characters it matches (rather
/// too many than too few).
fn scan_class(chars: &[char], start: usize) -> Result<(usize, Chars), String> {
    let mut i = start + 1;
    let negated = chars.get(i) == Some(&'^');
    if negated {
        i += 1;
    }
    if chars.get(i) == Some(&']') {
        return Err("Empty character classes ([] or [^]) are not allowed; write \\] for the character.".into());
    }
    let mut set: Chars = 0;
    let mut previous: Option<char> = None;
    // The last item, when it is a single character that may start a range.
    let mut single: Option<char> = None;
    while i < chars.len() {
        let (item, single_char, next) = match chars[i] {
            ']' => return Ok((i + 1, if negated { !set } else { set })),
            '\\' => {
                let next = *chars.get(i + 1).ok_or_else(|| "The pattern ends with a backslash.".to_string())?;
                check_escape(next, true)?;
                previous = None;
                let single = (!"dDwWsS".contains(next)).then_some(next);
                (escape_chars(next), single, i + 2)
            }
            '[' => return Err("A “[” inside a character class must be written as \\[.".into()),
            c @ ('&' | '-' | '~') if previous == Some(c) => return Err(format!("“{c}{c}” is not allowed inside a character class.")),
            '-' if single.is_some() && chars.get(i + 1).is_some_and(|&c| c != ']') => {
                // A range `x-y`; an escape such as `\d` as its end makes it unclear, so take everything.
                let from = single.take().unwrap_or('\0');
                let (to, next) = match chars[i + 1] {
                    '\\' => match chars.get(i + 2) {
                        Some(&c) if !"dDwWsS".contains(c) => (Some(c), i + 3),
                        _ => (None, i + 2),
                    },
                    c => (Some(c), i + 2),
                };
                set |= match to {
                    Some(to) if from <= to => char_range(from, to),
                    _ => ALL,
                };
                previous = None;
                i = next;
                continue;
            }
            c => {
                previous = Some(c);
                (char_bit(c), Some(c), i + 1)
            }
        };
        set |= item;
        single = single_char;
        i = next;
    }
    Err("A “[” is not closed.".into())
}

/// An open group during the scan.
struct Group {
    /// Contains a repetition (`*`, `+`, `{…}`).
    repeats: bool,
    /// Contains a `|`.
    alternates: bool,
    /// Characters it can match.
    chars: Chars,
    /// `open` (see `scan`) at the `(`.
    open_at_start: Chars,
    /// `open` at the end of each alternative so far.
    branch_ends: Chars,
}

/// The item just before, which a quantifier would repeat.
struct Item {
    repeats: bool,
    alternates: bool,
    chars: Chars,
    /// `open` before the item.
    before: Chars,
}

/// Checks the structure; the syntax details are left to the regex compiler afterwards.
///
/// Besides nested repetition, two things make JavaScript's backtracking explode: a repeated group
/// with alternatives (`(a|a)+`) and unbounded repetitions in a row that can share characters
/// (`\w+\w+`, `\w*a\w*`). For the latter the scan tracks `open`: the characters an unbounded
/// repetition before may still take, because nothing since has fixed where it ends. A mandatory item
/// that matches none of them closes it; a new unbounded repetition must not match any of them.
fn scan(pattern: &str) -> Result<(), String> {
    let chars: Vec<char> = pattern.chars().collect();
    let mut groups: Vec<Group> = Vec::new();
    // `None` for "nothing to repeat" (JavaScript rejects `**`, `^*`, `\b+`, `(*` and `|+`, while Rust
    // accepts some of them).
    let mut item: Option<Item> = None;
    let mut open: Chars = 0;
    // A mandatory atom matching `set` follows.
    let atom = |set: Chars, open: &mut Chars, groups: &mut Vec<Group>| -> Item {
        let before = *open;
        if set & before == 0 {
            *open = 0;
        }
        if let Some(group) = groups.last_mut() {
            group.chars |= set;
        }
        Item { repeats: false, alternates: false, chars: set, before }
    };
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '\\' => {
                let next = *chars.get(i + 1).ok_or_else(|| "The pattern ends with a backslash.".to_string())?;
                check_escape(next, false)?;
                item = if matches!(next, 'b' | 'B') { None } else { Some(atom(escape_chars(next), &mut open, &mut groups)) };
                i += 2;
            }
            '[' => {
                let (end, set) = scan_class(&chars, i)?;
                item = Some(atom(set, &mut open, &mut groups));
                i = end;
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
                groups.push(Group { repeats: false, alternates: false, chars: 0, open_at_start: open, branch_ends: 0 });
                item = None;
            }
            ')' => {
                let group = groups.pop().ok_or_else(|| "A “)” has no matching “(”.".to_string())?;
                if let Some(outer) = groups.last_mut() {
                    outer.repeats |= group.repeats;
                    outer.alternates |= group.alternates;
                    outer.chars |= group.chars;
                }
                open |= group.branch_ends;
                item = Some(Item { repeats: group.repeats, alternates: group.alternates, chars: group.chars, before: group.open_at_start });
                i += 1;
            }
            '|' => {
                match groups.last_mut() {
                    Some(group) => {
                        group.alternates = true;
                        group.branch_ends |= open;
                        open = group.open_at_start;
                    }
                    None => open = 0,
                }
                item = None;
                i += 1;
            }
            '^' | '$' => {
                item = None;
                i += 1;
            }
            c @ ('*' | '+' | '?' | '{') => {
                let Some(repeated) = item.take() else {
                    return Err(format!("“{c}” has nothing to repeat; write \\{c} for the character itself."));
                };
                // `ranged`: a counted repetition with a choice of length, `{2,9}`.
                let (end, optional, unbounded, ranged) = match c {
                    '{' => {
                        let end = quantifier_end(&chars, i)?;
                        let body: String = chars[i + 1..end - 1].iter().collect();
                        let (min, max) = body.split_once(',').unwrap_or((&body, &body));
                        let number = |text: &str| text.trim_start_matches('0').parse::<u64>().unwrap_or(0);
                        (end, number(min) == 0, max.is_empty(), !max.is_empty() && number(min) != number(max))
                    }
                    '*' => (i + 1, true, true, false),
                    '+' => (i + 1, false, true, false),
                    _ => (i + 1, true, false, false),
                };
                if c != '?' {
                    if repeated.repeats {
                        return Err("A repeated group must not contain a repetition itself, e.g. (a+)+ – it can take very long to match.".into());
                    }
                    if repeated.alternates {
                        return Err("A repeated group must not contain alternatives, e.g. (a|b)+ – it can take very long to match; use a character class such as [ab]+ instead.".into());
                    }
                    if let Some(group) = groups.last_mut() {
                        group.repeats = true;
                    }
                }
                if (unbounded || ranged) && repeated.chars & repeated.before != 0 {
                    return Err("Repetitions in a row that can match the same characters, e.g. \\w+\\w+ or \\w*a\\w*, can take very long to match; put a character between them that only one side matches.".into());
                }
                if unbounded {
                    open = repeated.chars | if optional { repeated.before } else { 0 };
                } else if optional {
                    open |= repeated.before;
                }
                // Lazy form: `*?`, `+?`, `{1,3}?`.
                i = if chars.get(end) == Some(&'?') { end + 1 } else { end };
            }
            '}' => return Err("Write \\} for the character “}”.".into()),
            ']' => return Err("Write \\] for the character “]”.".into()),
            '.' => {
                item = Some(atom(ALL, &mut open, &mut groups));
                i += 1;
            }
            c => {
                item = Some(atom(char_bit(c), &mut open, &mut groups));
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
        assert_eq!(check_pattern(r"[A-Z]+-\d+|#\d+"), Ok(0));
        assert_eq!(check_pattern(r"(\d+)-(\d+)"), Ok(2));
        assert_eq!(check_pattern(r"[a-z]+\d+[a-z]+"), Ok(0));
        assert_eq!(check_pattern(r"\w+\w{3}-\w+"), Ok(0));
        assert_eq!(check_pattern(r"\w+\w?-\d{1,6}"), Ok(0));
        assert_eq!(check_pattern(r"(?:a|b)?c+"), Ok(0));
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
            (r"(a|a)+$", "repeated alternation"),
            (r"(?:x|\w)+!", "repeated overlapping alternation"),
            (r"(?:ab|cd){2,9}", "counted alternation"),
            (r"((a|b)c)+", "alternation deep inside a repeated group"),
            (r"\w*\w*\w*\w*\w*\w*!", "consecutive repetitions"),
            (r"\w+\w+!", "two adjacent repetitions"),
            (r"\w+a\w+!", "repetitions joined by a character both can match"),
            (r"\w+\w?\w+", "repetitions joined by an optional character"),
            (r"[a-z]+(?:x)?[a-z]*!", "repetitions joined by an optional group"),
            (r"\w+(\d+)", "repetition followed by a group that starts with one"),
            (r"(?:a\w+|b)\w+", "repetition at the end of one alternative"),
            (r".+x+", "dot followed by a repetition"),
            (r"[^-]+\d+", "negated class followed by a repetition"),
            (r"\w+(?:ab)+", "repetition followed by a repeated group"),
            (r"\w+\w{1,50}-", "repetition followed by a counted range"),
        ];
        for (pattern, why) in rejected {
            assert!(check_pattern(pattern).is_err(), "{why}: {pattern}");
        }
        let error = check_pattern(&"a".repeat(MAX_PATTERN_LEN + 1)).unwrap_err();
        assert!(error.contains("200"), "{error}");
        assert!(check_pattern(r"(a+)+").unwrap_err().contains("repetition"));
        assert!(check_pattern(r"a**").unwrap_err().contains("nothing to repeat"));
        assert!(check_pattern(r"(a|b)+").unwrap_err().contains("alternative"));
        assert!(check_pattern(r"\w+\w+").unwrap_err().contains("in a row"));
    }
}
