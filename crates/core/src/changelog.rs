//! CHANGELOG.md in the working directory (release notes, v1.2 Teilpaket 7.2): finding it,
//! recognising Keep a Changelog and its heading language, and inserting the section of a new
//! version. Pure text functions; the command `changelog_insert` (`commands/release_notes.rs`)
//! reads and writes. Everything outside the inserted section stays byte for byte as it was:
//! line endings, a missing final newline, the `[Unreleased]` section, link references at the end.

use std::path::{Path, PathBuf};

pub const FILE_NAME: &str = "CHANGELOG.md";
pub const EN_HEADINGS: [&str; 4] = ["Added", "Changed", "Fixed", "Other"];
pub const DE_HEADINGS: [&str; 4] = ["Neu", "Geändert", "Behoben", "Sonstiges"];
/// Further Keep a Changelog headings that mark a file as English.
const EN_ONLY: [&str; 3] = ["Removed", "Deprecated", "Security"];

/// The language of the group headings (`### Added` / `### Neu`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeadingLanguage {
    En,
    De,
}

impl HeadingLanguage {
    /// Added, Changed, Fixed, Other – in this order.
    pub fn headings(self) -> [&'static str; 4] {
        match self {
            HeadingLanguage::En => EN_HEADINGS,
            HeadingLanguage::De => DE_HEADINGS,
        }
    }
}

/// The changelog in `root`: `CHANGELOG.md`, else the first file whose name matches ignoring case.
pub fn find(root: &Path) -> std::io::Result<Option<PathBuf>> {
    let mut matches: Vec<String> = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        if let Some(name) = entry.file_name().to_str() {
            if name.eq_ignore_ascii_case(FILE_NAME) {
                matches.push(name.to_string());
            }
        }
    }
    matches.sort();
    let chosen = matches.iter().find(|name| name.as_str() == FILE_NAME).or_else(|| matches.first());
    Ok(chosen.map(|name| root.join(name)))
}

/// Lines without their line ending (`\n` or `\r\n`).
fn lines(text: &str) -> impl Iterator<Item = &str> {
    text.split('\n').map(|line| line.strip_suffix('\r').unwrap_or(line))
}

/// The first `###` heading that is one of the known group words decides.
pub fn heading_language(text: &str) -> Option<HeadingLanguage> {
    for line in lines(text) {
        let Some(word) = line.strip_prefix("### ") else { continue };
        let word = word.trim();
        if DE_HEADINGS.contains(&word) {
            return Some(HeadingLanguage::De);
        }
        if EN_HEADINGS.contains(&word) || EN_ONLY.contains(&word) {
            return Some(HeadingLanguage::En);
        }
    }
    None
}

/// `rest` = what follows `## `: `[Unreleased]`, `Unreleased`, any case.
fn is_unreleased(rest: &str) -> bool {
    let name = rest.trim().trim_start_matches('[');
    name.get(..10).is_some_and(|start| start.eq_ignore_ascii_case("unreleased"))
}

/// Mentions keepachangelog.com or has a `## [Unreleased]` heading.
pub fn is_keep_a_changelog(text: &str) -> bool {
    text.to_ascii_lowercase().contains("keepachangelog.com")
        || lines(text).filter_map(|line| line.strip_prefix("## ")).any(|rest| rest.trim_start().starts_with('[') && is_unreleased(rest))
}

/// `v1.2.0` → `1.2.0` (a leading `v` before a digit); anything else stays.
pub fn version_label(tag: &str) -> String {
    let tag = tag.trim();
    match tag.strip_prefix(['v', 'V']) {
        Some(rest) if rest.starts_with(|c: char| c.is_ascii_digit()) => rest.to_string(),
        _ => tag.to_string(),
    }
}

/// The version a `## ` heading names (`[1.2.0] - 2026-10-20` → `1.2.0`).
fn heading_version(rest: &str) -> String {
    let rest = rest.trim_start().trim_start_matches('[');
    version_label(rest.split(|c: char| c == ']' || c.is_whitespace()).next().unwrap_or(""))
}

pub fn has_version(text: &str, version: &str) -> bool {
    let wanted = version_label(version);
    lines(text).filter_map(|line| line.strip_prefix("## ")).any(|rest| heading_version(rest) == wanted)
}

/// Byte offset of the first `## ` heading that is not `Unreleased`.
fn insertion_offset(text: &str) -> Option<usize> {
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        let bare = line.trim_end_matches(['\n', '\r']);
        if let Some(rest) = bare.strip_prefix("## ") {
            if !is_unreleased(rest) {
                return Some(offset);
            }
        }
        offset += line.len();
    }
    None
}

fn ends_with_blank_line(prefix: &str) -> bool {
    prefix.is_empty() || prefix.ends_with("\n\n") || prefix.ends_with("\n\r\n")
}

fn section(version: &str, date: &str, notes: &str, bracketed: bool, dash: &str, newline: &str) -> String {
    let label = version_label(version);
    let heading = if bracketed { format!("## [{label}] {dash} {date}") } else { format!("## {label} {dash} {date}") };
    let body = notes.trim().replace("\r\n", "\n");
    let mut out = format!("{heading}{newline}");
    if !body.is_empty() {
        out.push_str(newline);
        out.push_str(&body.replace('\n', newline));
        out.push_str(newline);
    }
    out
}

/// Inserts the section of `version`; `Err` names the version if it already has one.
pub fn insert(existing: &str, version: &str, date: &str, notes: &str) -> Result<String, String> {
    let label = version_label(version);
    if has_version(existing, &label) {
        return Err(format!("{FILE_NAME} already has a section for {label}."));
    }
    let newline = if existing.contains("\r\n") { "\r\n" } else { "\n" };
    let headings: Vec<&str> = lines(existing).filter_map(|line| line.strip_prefix("## ")).collect();
    let bracketed = is_keep_a_changelog(existing) || headings.iter().any(|rest| rest.trim_start().starts_with('['));
    let dash = if headings.iter().any(|rest| rest.contains(" – ")) { "–" } else { "-" };
    let new_section = section(&label, date, notes, bracketed, dash, newline);
    let mut out = String::with_capacity(existing.len() + new_section.len() + 4);
    match insertion_offset(existing) {
        Some(offset) => {
            let (before, after) = existing.split_at(offset);
            out.push_str(before);
            if !ends_with_blank_line(before) {
                out.push_str(newline);
            }
            out.push_str(&new_section);
            out.push_str(newline);
            out.push_str(after);
        }
        None => {
            out.push_str(existing);
            if !existing.is_empty() {
                if !existing.ends_with('\n') {
                    out.push_str(newline);
                }
                if !ends_with_blank_line(&out) {
                    out.push_str(newline);
                }
            }
            out.push_str(&new_section);
        }
    }
    Ok(out)
}

/// A changelog that did not exist yet.
pub fn new_file(version: &str, date: &str, notes: &str) -> String {
    format!("# Changelog\n\n{}", section(version, date, notes, true, "-", "\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FORKYARD_STYLE: &str = "# Changelog\n\nAll notable changes are listed here. The format follows\n[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).\n\n## [Unreleased]\n\n## [1.1.0] – 2026-10-16\n\n### Added\n\n- Crash reports.\n\n[1.1.0]: https://example.org/compare/v1.0.0...v1.1.0\n";

    #[test]
    fn keep_a_changelog_gets_the_new_version_directly_below_unreleased() {
        let out = insert(FORKYARD_STYLE, "v1.2.0", "2026-10-20", "### Added\n\n- Release notes from the tag dialog.\n").unwrap();
        assert_eq!(
            out,
            "# Changelog\n\nAll notable changes are listed here. The format follows\n[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).\n\n## [Unreleased]\n\n## [1.2.0] – 2026-10-20\n\n### Added\n\n- Release notes from the tag dialog.\n\n## [1.1.0] – 2026-10-16\n\n### Added\n\n- Crash reports.\n\n[1.1.0]: https://example.org/compare/v1.0.0...v1.1.0\n"
        );
    }

    #[test]
    fn pending_unreleased_entries_stay_where_they_are() {
        let text = "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Noch offen.\n\n## [0.9.0] - 2025-12-24\n\n- Erste Vorschau.\n";
        assert_eq!(
            insert(text, "1.0.0", "2026-01-02", "### Behoben\n\n- Absturz behoben").unwrap(),
            "# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- Noch offen.\n\n## [1.0.0] - 2026-01-02\n\n### Behoben\n\n- Absturz behoben\n\n## [0.9.0] - 2025-12-24\n\n- Erste Vorschau.\n"
        );
    }

    #[test]
    fn a_plain_changelog_gets_the_section_before_the_first_version_without_brackets() {
        let text = "# Änderungen\n\nWas sich in „Messnetz“ geändert hat.\n\n## 0.3.0 - 2024-03-01\n\n- Größere Schrift\n";
        assert_eq!(
            insert(text, "0.4.0", "2026-10-20", "### Neu\n\n- Export als CSV").unwrap(),
            "# Änderungen\n\nWas sich in „Messnetz“ geändert hat.\n\n## 0.4.0 - 2026-10-20\n\n### Neu\n\n- Export als CSV\n\n## 0.3.0 - 2024-03-01\n\n- Größere Schrift\n"
        );
    }

    #[test]
    fn crlf_and_a_missing_final_newline_stay_as_they_are() {
        let crlf = "# Changelog\r\n\r\n## [1.0.0] - 2026-01-02\r\n\r\n- Erste Version\r\n";
        assert_eq!(
            insert(crlf, "v1.1.0", "2026-10-20", "### Behoben\n\n- Absturz behoben").unwrap(),
            "# Changelog\r\n\r\n## [1.1.0] - 2026-10-20\r\n\r\n### Behoben\r\n\r\n- Absturz behoben\r\n\r\n## [1.0.0] - 2026-01-02\r\n\r\n- Erste Version\r\n"
        );
        assert_eq!(
            insert("# Changelog\n\n## [Unreleased]", "1.0.0", "2026-10-20", "- Erste Version").unwrap(),
            "# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-10-20\n\n- Erste Version\n"
        );
        assert_eq!(insert("", "1.0.0", "2026-10-20", "- x").unwrap(), "## 1.0.0 - 2026-10-20\n\n- x\n", "an empty file has no style to follow");
    }

    #[test]
    fn an_existing_version_is_refused_with_or_without_v() {
        let text = "# Changelog\n\n## [1.1.0] - 2026-10-16\n\n- x\n";
        assert!(insert(text, "v1.1.0", "2026-10-20", "- y").unwrap_err().contains("1.1.0"));
        assert!(insert("## v2.0 – 2026-01-01\n", "2.0", "2026-10-20", "- y").is_err());
        assert!(insert(text, "v1.1.0-rc.1", "2026-10-20", "- y").is_ok(), "a pre-release is another version");
        assert_eq!(version_label("v1.2.0"), "1.2.0");
        assert_eq!(version_label("V3"), "3");
        assert_eq!(version_label("version-2"), "version-2");
        assert_eq!(version_label("v"), "v");
        assert!(has_version(text, "1.1.0") && !has_version(text, "1.1"));
    }

    #[test]
    fn headings_follow_the_file() {
        assert_eq!(heading_language(FORKYARD_STYLE), Some(HeadingLanguage::En));
        assert_eq!(heading_language("## [1.0.0]\r\n\r\n### Behoben\r\n"), Some(HeadingLanguage::De));
        assert_eq!(heading_language("## 1.0\n\n### Security\n"), Some(HeadingLanguage::En));
        assert_eq!(heading_language("## 1.0\n\n- nur eine Liste\n#### Added\n### Neuigkeiten\n"), None);
        assert_eq!(HeadingLanguage::De.headings(), ["Neu", "Geändert", "Behoben", "Sonstiges"]);
        assert!(is_keep_a_changelog(FORKYARD_STYLE));
        assert!(is_keep_a_changelog("## [unreleased]\n"));
        assert!(!is_keep_a_changelog("# Änderungen\n\n## 0.3.0\n"));
    }

    #[test]
    fn a_new_file_has_a_title_and_the_section() {
        assert_eq!(new_file("v1.0.0", "2026-10-20", "### Neu\n\n- Erste Version\n"), "# Changelog\n\n## [1.0.0] - 2026-10-20\n\n### Neu\n\n- Erste Version\n");
    }

    #[test]
    fn the_changelog_is_found_ignoring_case_and_the_exact_name_wins() {
        let dir = crate::testkit::temp_folder();
        assert_eq!(find(dir.path()).unwrap(), None);
        std::fs::write(dir.path().join("CHANGELOG.md.bak"), "x").unwrap();
        assert_eq!(find(dir.path()).unwrap(), None, "only the name itself counts");
        std::fs::write(dir.path().join("changelog.md"), "# klein\n").unwrap();
        assert_eq!(find(dir.path()).unwrap(), Some(dir.path().join("changelog.md")));
        std::fs::write(dir.path().join("CHANGELOG.md"), "# groß\n").unwrap();
        let names = std::fs::read_dir(dir.path()).unwrap().count();
        if names == 3 {
            assert_eq!(find(dir.path()).unwrap(), Some(dir.path().join("CHANGELOG.md")), "case-sensitive file system: the exact name wins");
        }
    }
}
