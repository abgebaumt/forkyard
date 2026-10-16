//! Exclusion patterns for AI context in gitignore syntax: `.forkyard/ai-ignore` of the repository
//! and the global list from the settings, plus the fixed rules of Grundregel 5.
//!
//! The patterns only exclude: a `!` pattern re-includes only what an earlier pattern of the *same*
//! list excluded – never what the other list or a built-in rule excluded (`context::Exclusions`
//! asks every list separately). As in Git, nothing inside an excluded folder can be re-included.

use regex::Regex;

use crate::model::AiOmitReason;

#[derive(Debug, Clone)]
struct Rule {
    negated: bool,
    dir_only: bool,
    regex: Regex,
}

/// One list of patterns, in order (the last matching pattern decides).
#[derive(Debug, Clone, Default)]
pub struct IgnoreRules {
    rules: Vec<Rule>,
}

impl IgnoreRules {
    pub fn parse(text: &str) -> IgnoreRules {
        let mut rules = IgnoreRules::default();
        rules.add(text);
        rules
    }

    pub fn add(&mut self, text: &str) {
        self.rules.extend(text.lines().filter_map(parse_line));
    }

    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }

    /// `path`: a file, relative to the repository root, separated by `/`.
    pub fn is_ignored(&self, path: &str) -> bool {
        let path = path.trim_start_matches('/');
        let parts: Vec<&str> = path.split('/').filter(|part| !part.is_empty()).collect();
        for end in 1..parts.len() {
            if self.decides(&parts[..end].join("/"), true) == Some(true) {
                return true;
            }
        }
        self.decides(path, false) == Some(true)
    }

    /// `Some(true)`: excluded, `Some(false)`: re-included, `None`: no pattern matches.
    fn decides(&self, path: &str, is_dir: bool) -> Option<bool> {
        self.rules.iter().rev().find(|rule| (!rule.dir_only || is_dir) && rule.regex.is_match(path)).map(|rule| !rule.negated)
    }
}

fn parse_line(line: &str) -> Option<Rule> {
    let line = line.strip_suffix('\r').unwrap_or(line);
    let mut text = trim_trailing_spaces(line);
    if text.is_empty() || text.starts_with('#') {
        return None;
    }
    let negated = text.starts_with('!');
    if negated {
        text = &text[1..];
    }
    if let Some(rest) = text.strip_prefix('\\') {
        if rest.starts_with('#') || rest.starts_with('!') {
            text = rest;
        }
    }
    let dir_only = text.ends_with('/');
    let text = text.trim_end_matches('/');
    if text.is_empty() {
        return None;
    }
    let anchored = text.contains('/');
    let body = glob_to_regex(text.trim_start_matches('/'));
    let pattern = if anchored { format!("^{body}$") } else { format!("^(?:.*/)?{body}$") };
    Regex::new(&pattern).ok().map(|regex| Rule { negated, dir_only, regex })
}

/// Trailing spaces do not count unless escaped with a backslash (as in Git).
fn trim_trailing_spaces(line: &str) -> &str {
    let trimmed = line.trim_end_matches(' ');
    if trimmed.ends_with('\\') && trimmed.len() < line.len() {
        &line[..trimmed.len() + 1]
    } else {
        trimmed
    }
}

fn glob_to_regex(glob: &str) -> String {
    let chars: Vec<char> = glob.chars().collect();
    let mut out = String::new();
    let mut index = 0;
    while index < chars.len() {
        let current = chars[index];
        match current {
            '*' if chars.get(index + 1) == Some(&'*') => {
                let at_start = index == 0 || chars[index - 1] == '/';
                let at_end = index + 2 == chars.len();
                if at_start && chars.get(index + 2) == Some(&'/') {
                    out.push_str("(?:.*/)?");
                    index += 3;
                    continue;
                }
                if at_start && at_end {
                    out.push_str(".*");
                } else {
                    out.push_str("[^/]*");
                }
                index += 2;
                continue;
            }
            '*' => out.push_str("[^/]*"),
            '?' => out.push_str("[^/]"),
            '[' => {
                if let Some(close) = chars[index + 1..].iter().position(|&ch| ch == ']').map(|offset| offset + index + 1) {
                    let class: String = chars[index + 1..close].iter().collect();
                    let class = match class.strip_prefix('!') {
                        Some(rest) => format!("^{rest}"),
                        None => class,
                    };
                    out.push('[');
                    out.push_str(&class.replace('\\', "\\\\"));
                    out.push(']');
                    index = close + 1;
                    continue;
                }
                out.push_str("\\[");
            }
            '\\' if index + 1 < chars.len() => {
                out.push_str(&regex::escape(&chars[index + 1].to_string()));
                index += 2;
                continue;
            }
            other => out.push_str(&regex::escape(&other.to_string())),
        }
        index += 1;
    }
    out
}

const LOCKFILES: [&str; 6] = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "cargo.lock", "poetry.lock", "go.sum"];
const GENERATED_DIRS: [&str; 2] = ["dist", "build"];
const SECRET_SUFFIXES: [&str; 6] = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"];

/// Grundregel 5: secrets (never sent) and lock/generated files (name and size only). Windows
/// separators are accepted.
pub fn builtin_reason(path: &str) -> Option<AiOmitReason> {
    let normalized = path.replace('\\', "/");
    let mut parts: Vec<&str> = normalized.split('/').filter(|part| !part.is_empty()).collect();
    let name = parts.pop()?.to_lowercase();
    if name.starts_with(".env") || name.starts_with("id_rsa") || SECRET_SUFFIXES.iter().any(|suffix| name.ends_with(suffix)) {
        return Some(AiOmitReason::Secret);
    }
    if LOCKFILES.contains(&name.as_str()) || name.contains(".min.") || parts.iter().any(|dir| GENERATED_DIRS.contains(&dir.to_lowercase().as_str())) {
        return Some(AiOmitReason::Generated);
    }
    None
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::AiOmitReason;
    use crate::testkit::TestRepo;

    /// The oracle is Git: the same patterns as .gitignore, asked through `git check-ignore`.
    #[test]
    fn matching_agrees_with_git_check_ignore() {
        let patterns = "# comment line\n*.log\n!keep.log\nbuild/\n/root-only.txt\ndocs/*.pdf\n**/geheim/**\nÜbersicht/*.md\n-flag.txt\nname with space.txt\nlogs/**/*.tmp\n*.[oa]\nfoo?.c\n\\#hash.txt\n";
        let paths = [
            "app.log",
            "keep.log",
            "sub/keep.log",
            "sub/deep/app.log",
            "build/out.js",
            "src/build/x.js",
            "build.rs",
            "root-only.txt",
            "sub/root-only.txt",
            "docs/a.pdf",
            "docs/sub/a.pdf",
            "x/geheim/key.txt",
            "geheim/a/b.txt",
            "Übersicht/plan ä.md",
            "Übersicht/sub/plan.md",
            "-flag.txt",
            "sub/-flag.txt",
            "name with space.txt",
            "logs/a/b/c.tmp",
            "logs/c.tmp",
            "lib.o",
            "lib.c",
            "foo1.c",
            "foo12.c",
            "#hash.txt",
            "README.md",
        ];
        let repo = TestRepo::new();
        repo.write_file(".gitignore", patterns);
        for path in paths {
            repo.write_file(path, "x\n");
        }
        // Without -z (git allows it only with --stdin); core.quotePath=false keeps every fixture path unquoted.
        let mut args = vec!["-c", "core.quotePath=false", "check-ignore", "--no-index", "--"];
        args.extend(paths);
        let output = repo.git_output(&args);
        let git_says: std::collections::BTreeSet<String> =
            output.stdout.split(|byte| *byte == b'\n').filter(|part| !part.is_empty()).map(|part| String::from_utf8(part.to_vec()).unwrap()).collect();
        assert!(git_says.contains("app.log") && git_says.contains("build/out.js"), "the oracle works: {git_says:?}");
        let rules = IgnoreRules::parse(patterns);
        for path in paths {
            assert_eq!(rules.is_ignored(path), git_says.contains(path), "{path}");
        }
    }

    #[test]
    fn negation_cannot_reach_into_an_excluded_folder() {
        let rules = IgnoreRules::parse("intern/\n!intern/oeffentlich.md\nrest/**\n!rest/frei.md\n");
        assert!(rules.is_ignored("intern/oeffentlich.md"), "git cannot re-include a file of an excluded folder");
        assert!(!rules.is_ignored("rest/frei.md"), "rest/** excludes the contents, not the folder");
        assert!(rules.is_ignored("rest/anderes.md"));
        assert!(IgnoreRules::parse("").is_empty() && IgnoreRules::parse("# only a comment\n\n").is_empty());
    }

    #[test]
    fn crlf_pattern_files_work_like_lf_files() {
        let rules = IgnoreRules::parse("*.sql\r\n!keep.sql\r\n");
        assert!(rules.is_ignored("dump.sql"));
        assert!(!rules.is_ignored("keep.sql"));
    }

    #[test]
    fn built_in_rules_follow_grundregel_5() {
        let cases = [
            (".env", Some(AiOmitReason::Secret)),
            (".env.local", Some(AiOmitReason::Secret)),
            ("config/prod.PEM", Some(AiOmitReason::Secret)),
            ("config\\server.key", Some(AiOmitReason::Secret)),
            ("home/.ssh/id_rsa", Some(AiOmitReason::Secret)),
            ("home/.ssh/id_rsa.pub", Some(AiOmitReason::Secret)),
            ("certs/client.p12", Some(AiOmitReason::Secret)),
            ("certs/client.pfx", Some(AiOmitReason::Secret)),
            ("android/release.keystore", Some(AiOmitReason::Secret)),
            ("android/release.jks", Some(AiOmitReason::Secret)),
            ("package-lock.json", Some(AiOmitReason::Generated)),
            ("web/pnpm-lock.yaml", Some(AiOmitReason::Generated)),
            ("yarn.lock", Some(AiOmitReason::Generated)),
            ("Cargo.lock", Some(AiOmitReason::Generated)),
            ("py/poetry.lock", Some(AiOmitReason::Generated)),
            ("go.sum", Some(AiOmitReason::Generated)),
            ("frontend/dist/app.js", Some(AiOmitReason::Generated)),
            ("build/output.txt", Some(AiOmitReason::Generated)),
            ("static/jquery.min.js", Some(AiOmitReason::Generated)),
            ("docs/env.md", None),
            ("src/keys.rs", None),
            ("build.rs", None),
            ("src/builder/mod.rs", None),
            ("Übersicht mit Leerzeichen.md", None),
        ];
        for (path, expected) in cases {
            assert_eq!(builtin_reason(path), expected, "{path}");
        }
    }
}
