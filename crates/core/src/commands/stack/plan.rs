//! The pure parts of stacked pull requests: names of the branches, cuts, conflicts of ref names,
//! Git's `log --numstat -z` and the parent links in the config, the chain of a stack.

use std::collections::{BTreeMap, HashSet};

use crate::commands::graph::display_text;
use crate::model::StackCut;
use crate::util;

/// At most this many commits are split into a stack.
pub const MAX_COMMITS: usize = 100;
/// At most this many parts.
pub const MAX_PARTS: usize = 20;
/// Longest slug of a part's name inside its branch name.
pub const MAX_SLUG: usize = 24;
/// Key under `branch.<part>` that names the part below (full ref name). Git prints it lowercased.
pub const PARENT_KEY: &str = "forkyardStackParent";

/// A file of a commit, from `--numstat -z`; `added`/`deleted` are `None` for a binary file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileStat {
    pub path: String,
    pub old_path: Option<String>,
    pub added: Option<u64>,
    pub deleted: Option<u64>,
}

/// A commit of the branch with its message and files.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceCommit {
    pub sha: String,
    pub subject: String,
    pub body: String,
    pub files: Vec<FileStat>,
}

/// `[a-z0-9-]` from a part's name: umlauts spelled out (ä → ae, ß → ss), every other character
/// is a separator, at most four words and `MAX_SLUG` characters (cut at a word boundary; a
/// single longer word is cut hard).
pub fn slug(name: &str) -> String {
    let mut folded = String::new();
    for c in name.chars().flat_map(char::to_lowercase) {
        match c {
            'ä' => folded.push_str("ae"),
            'ö' => folded.push_str("oe"),
            'ü' => folded.push_str("ue"),
            'ß' => folded.push_str("ss"),
            'a'..='z' | '0'..='9' => folded.push(c),
            _ => folded.push(' '),
        }
    }
    let mut out = String::new();
    for word in folded.split_whitespace().take(4) {
        let next = if out.is_empty() { word.len() } else { out.len() + 1 + word.len() };
        if next > MAX_SLUG {
            if out.is_empty() {
                out.push_str(&word[..MAX_SLUG]);
            }
            break;
        }
        if !out.is_empty() {
            out.push('-');
        }
        out.push_str(word);
    }
    out
}

/// `<source>-<number>-<slug>`, the number padded to the width of `total`; an empty slug is `part`.
pub fn branch_name(source: &str, number: usize, total: usize, slug: &str) -> String {
    let width = total.to_string().len();
    let slug = if slug.is_empty() { "part" } else { slug };
    format!("{source}-{number:0width$}-{slug}")
}

/// Ends rise strictly, start at 1 at the earliest and the last one is the newest commit.
pub fn validate_cuts(cuts: &[StackCut], commits: usize) -> Result<(), String> {
    if cuts.is_empty() {
        return Err("At least one part is needed.".into());
    }
    if cuts.len() > MAX_PARTS {
        return Err(format!("A stack has at most {MAX_PARTS} parts."));
    }
    let mut previous = 0usize;
    for (index, cut) in cuts.iter().enumerate() {
        let end = cut.end as usize;
        if end <= previous {
            return Err(format!("Part {} must end after commit {previous}.", index + 1));
        }
        if end > commits {
            return Err(format!("Part {} ends after commit {end}, but the branch has {commits} commits.", index + 1));
        }
        previous = end;
    }
    if previous != commits {
        return Err(format!("The last part must end with the newest commit ({commits})."));
    }
    Ok(())
}

/// Why Git would refuse `name` next to the `existing` local branches (short names): the same
/// branch, a branch below `name/`, or a branch that is a folder of `name`.
pub fn ref_conflict(existing: &HashSet<String>, name: &str) -> Option<String> {
    if existing.contains(name) {
        return Some(format!("A branch “{name}” already exists."));
    }
    let folder = format!("{name}/");
    let mut below: Vec<&String> = existing.iter().filter(|other| other.starts_with(&folder)).collect();
    below.sort();
    if let Some(other) = below.first() {
        return Some(format!("The branch “{other}” blocks the name “{name}”."));
    }
    name.match_indices('/')
        .map(|(at, _)| &name[..at])
        .find(|prefix| existing.contains(*prefix))
        .map(|prefix| format!("The branch “{prefix}” blocks the name “{name}”."))
}

/// The bytes up to the next NUL and the rest after it.
fn take_z(bytes: &[u8]) -> Option<(&[u8], &[u8])> {
    let at = bytes.iter().position(|&b| b == 0)?;
    Some((&bytes[..at], &bytes[at + 1..]))
}

fn count(field: Option<&[u8]>) -> Option<u64> {
    std::str::from_utf8(field?).ok()?.trim().parse().ok()
}

/// Reads `git log -z -M --numstat --format=%x1e%H%x00%s%x00%b` field by field, so a 0x1e inside
/// a message cannot split a record.
pub fn parse_log(bytes: &[u8]) -> Vec<SourceCommit> {
    let mut out = Vec::new();
    let mut rest = bytes;
    while let Some(start) = rest.iter().position(|&b| b == 0x1e) {
        rest = &rest[start + 1..];
        let Some((sha, after)) = take_z(rest) else { break };
        let Some((subject, after)) = take_z(after) else { break };
        let Some((body, mut after)) = take_z(after) else { break };
        if after.first() == Some(&b'\n') {
            after = &after[1..];
        }
        let mut files = Vec::new();
        while matches!(after.first(), Some(b'0'..=b'9' | b'-')) {
            let Some((entry, next)) = take_z(after) else { break };
            let mut fields = entry.splitn(3, |&b| b == b'\t');
            let added = count(fields.next());
            let deleted = count(fields.next());
            let path = fields.next().unwrap_or_default();
            if path.is_empty() {
                let Some((old, next)) = take_z(next) else { break };
                let Some((new, next)) = take_z(next) else { break };
                files.push(FileStat { path: util::decode_lossy(new), old_path: Some(util::decode_lossy(old)), added, deleted });
                after = next;
            } else {
                files.push(FileStat { path: util::decode_lossy(path), old_path: None, added, deleted });
                after = next;
            }
        }
        out.push(SourceCommit { sha: util::decode_lossy(sha), subject: display_text(subject), body: display_text(body).trim_end().to_string(), files });
        rest = after;
    }
    out
}

/// `git config -z --get-regexp '^branch\..*\.forkyardstackparent$'`: `key\nvalue\0` per entry;
/// the map goes from the part's short name to its parent's full ref name.
pub fn parse_parents(bytes: &[u8]) -> BTreeMap<String, String> {
    let suffix = format!(".{}", PARENT_KEY.to_ascii_lowercase());
    let mut out = BTreeMap::new();
    for entry in util::split_z(bytes) {
        let text = util::decode_lossy(entry);
        let Some((key, value)) = text.split_once('\n') else { continue };
        let Some(name) = key.strip_prefix("branch.").and_then(|rest| rest.strip_suffix(suffix.as_str())) else { continue };
        if !name.is_empty() && !value.trim().is_empty() {
            out.insert(name.to_string(), value.trim().to_string());
        }
    }
    out
}

/// The parts of the stack `start` belongs to, bottom first: down along the parent links to the
/// base (a ref that is no part), up from `start` while there is exactly one child. Only existing
/// branches count; a cycle is no stack.
pub fn chain(parents: &BTreeMap<String, String>, existing: &HashSet<String>, start: &str) -> Option<Vec<String>> {
    let parent_of = |name: &str| -> Option<&str> {
        if existing.contains(name) {
            parents.get(name).map(String::as_str)
        } else {
            None
        }
    };
    parent_of(start)?;
    let mut seen: HashSet<String> = HashSet::from([start.to_string()]);
    let mut parts = vec![start.to_string()];
    let mut current = start.to_string();
    while let Some(parent) = parent_of(&current).and_then(|p| p.strip_prefix("refs/heads/")) {
        if parent_of(parent).is_none() {
            break;
        }
        if !seen.insert(parent.to_string()) {
            return None;
        }
        parts.push(parent.to_string());
        current = parent.to_string();
    }
    parts.reverse();
    let mut current = start.to_string();
    loop {
        let wanted = format!("refs/heads/{current}");
        let children: Vec<&String> = parents.iter().filter(|(child, parent)| **parent == wanted && existing.contains(child.as_str())).map(|(child, _)| child).collect();
        let [child] = children.as_slice() else { break };
        if !seen.insert((*child).clone()) {
            return None;
        }
        parts.push((*child).clone());
        current = (*child).clone();
    }
    Some(parts)
}

/// `refs/heads/main` → `main`; `refs/remotes/<remote>/<branch>` → `<branch>` (longest known remote
/// name; unknown: everything after the first `/`).
pub fn target_name(base: &str, remotes: &[String]) -> String {
    if let Some(name) = base.strip_prefix("refs/heads/") {
        return name.to_string();
    }
    if let Some(rest) = base.strip_prefix("refs/remotes/") {
        let mut known: Vec<&String> = remotes.iter().filter(|remote| rest.starts_with(&format!("{remote}/"))).collect();
        known.sort_by_key(|remote| std::cmp::Reverse(remote.len()));
        return match known.first() {
            Some(remote) => rest[remote.len() + 1..].to_string(),
            None => rest.split_once('/').map(|(_, name)| name.to_string()).unwrap_or_else(|| rest.to_string()),
        };
    }
    base.to_string()
}

/// `refs/heads/x` → `x`, `refs/remotes/origin/x` → `origin/x`.
pub fn short_ref(name: &str) -> &str {
    name.strip_prefix("refs/heads/").or_else(|| name.strip_prefix("refs/remotes/")).unwrap_or(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::StackCut;

    fn cut(end: u32, name: &str) -> StackCut {
        StackCut { end, name: name.into() }
    }

    fn set(names: &[&str]) -> HashSet<String> {
        names.iter().map(|name| name.to_string()).collect()
    }

    #[test]
    fn slugs_spell_out_umlauts_and_keep_four_words_within_the_limit() {
        assert_eq!(slug("Import der Messwerte"), "import-der-messwerte");
        assert_eq!(slug("Datenmodell für Stationen"), "datenmodell-fuer", "a third word would pass 24 characters");
        assert_eq!(slug("  Größe & Übersicht!! "), "groesse-uebersicht");
        assert_eq!(slug("Eins zwei drei vier fünf"), "eins-zwei-drei-vier");
        assert_eq!(slug("--rm -rf /"), "rm-rf");
        assert_eq!(slug("Café Ölmühle"), "caf-oelmuehle", "accents are separators");
        assert_eq!(slug("Donaudampfschifffahrtsgesellschaft"), "donaudampfschifffahrtsge");
        assert_eq!(slug("ẞ STRASSE"), "ss-strasse");
        assert_eq!(slug("日本語 …"), "");
    }

    #[test]
    fn branch_names_number_the_parts_with_the_width_of_their_count() {
        assert_eq!(branch_name("feature/auswertung", 1, 3, "datenmodell"), "feature/auswertung-1-datenmodell");
        assert_eq!(branch_name("x", 3, 12, "a"), "x-03-a");
        assert_eq!(branch_name("x", 12, 12, "a"), "x-12-a");
        assert_eq!(branch_name("x", 2, 3, ""), "x-2-part");
    }

    #[test]
    fn cuts_must_rise_and_end_with_the_newest_commit() {
        assert_eq!(validate_cuts(&[cut(2, "a"), cut(4, "b")], 4), Ok(()));
        assert_eq!(validate_cuts(&[cut(4, "")], 4), Ok(()));
        assert_eq!(validate_cuts(&[], 4).unwrap_err(), "At least one part is needed.");
        assert_eq!(validate_cuts(&[cut(2, "a"), cut(2, "b"), cut(4, "c")], 4).unwrap_err(), "Part 2 must end after commit 2.");
        assert_eq!(validate_cuts(&[cut(0, "a"), cut(4, "b")], 4).unwrap_err(), "Part 1 must end after commit 0.");
        assert_eq!(validate_cuts(&[cut(2, "a"), cut(5, "b")], 4).unwrap_err(), "Part 2 ends after commit 5, but the branch has 4 commits.");
        assert_eq!(validate_cuts(&[cut(2, "a"), cut(3, "b")], 4).unwrap_err(), "The last part must end with the newest commit (4).");
        let many: Vec<StackCut> = (1..=21).map(|n| cut(n, "")).collect();
        assert_eq!(validate_cuts(&many, 21).unwrap_err(), "A stack has at most 20 parts.");
    }

    #[test]
    fn a_name_conflicts_with_the_same_branch_and_with_folders_of_branches() {
        let existing = set(&["main", "feature/auswertung", "feature/auswertung-1-a/alt", "team"]);
        assert_eq!(ref_conflict(&existing, "feature/auswertung-2-b"), None);
        assert_eq!(ref_conflict(&existing, "main").as_deref(), Some("A branch “main” already exists."));
        assert_eq!(ref_conflict(&existing, "feature/auswertung-1-a").as_deref(), Some("The branch “feature/auswertung-1-a/alt” blocks the name “feature/auswertung-1-a”."));
        assert_eq!(ref_conflict(&existing, "team/x-1-a").as_deref(), Some("The branch “team” blocks the name “team/x-1-a”."));
    }

    #[test]
    fn git_log_with_numstat_is_read_record_by_record() {
        // Shape of `git log --reverse -z -M --numstat --format=%x1e%H%x00%s%x00%b` (Git 2.53): a record
        // separator, three NUL-terminated fields, then – after a newline – NUL-terminated numstat
        // entries; a rename has an empty path followed by old and new path. A body may contain 0x1e.
        let bytes: &[u8] = b"\x1eaaa1\x00zwei dateien\x00\x00\n1\t1\ta\x001\t0\tb \xc3\xa4.txt\x00\
\x1ebbb2\x00rename\x00\x00\n0\t0\t\x00src/modell.rs\x00src/station.rs\x00\
\x1eccc3\x00leer\x00Trenner \x1e mitten\nZeile zwei\n\x00\
\x1eddd4\x00dash\x00\x00\n1\t0\t-lead.txt\x00-\t-\tlogo.png\x00";
        let commits = parse_log(bytes);
        let file = |path: &str, old: Option<&str>, added: Option<u64>, deleted: Option<u64>| FileStat { path: path.into(), old_path: old.map(str::to_string), added, deleted };
        assert_eq!(
            commits,
            vec![
                SourceCommit { sha: "aaa1".into(), subject: "zwei dateien".into(), body: String::new(), files: vec![file("a", None, Some(1), Some(1)), file("b ä.txt", None, Some(1), Some(0))] },
                SourceCommit { sha: "bbb2".into(), subject: "rename".into(), body: String::new(), files: vec![file("src/station.rs", Some("src/modell.rs"), Some(0), Some(0))] },
                SourceCommit { sha: "ccc3".into(), subject: "leer".into(), body: "Trenner \u{1e} mitten\nZeile zwei".into(), files: vec![] },
                SourceCommit { sha: "ddd4".into(), subject: "dash".into(), body: String::new(), files: vec![file("-lead.txt", None, Some(1), Some(0)), file("logo.png", None, None, None)] },
            ]
        );
        assert!(parse_log(b"").is_empty());
    }

    #[test]
    fn parent_links_are_read_from_git_config_output() {
        let bytes: &[u8] = b"branch.feat/\xc3\xa4.b-1-x.forkyardstackparent\nrefs/heads/main\x00branch.feat-2-y.forkyardstackparent\nrefs/heads/feat/\xc3\xa4.b-1-x\x00branch.kaputt\x00";
        let parents = parse_parents(bytes);
        assert_eq!(parents.len(), 2);
        assert_eq!(parents["feat/ä.b-1-x"], "refs/heads/main");
        assert_eq!(parents["feat-2-y"], "refs/heads/feat/ä.b-1-x");
    }

    #[test]
    fn the_chain_follows_single_links_and_refuses_cycles() {
        let parents: BTreeMap<String, String> = [
            ("p1", "refs/heads/main"),
            ("p2", "refs/heads/p1"),
            ("p3", "refs/heads/p2"),
            ("q", "refs/heads/p1"),
            ("gone", "refs/heads/p3"),
            ("x", "refs/heads/y"),
            ("y", "refs/heads/x"),
            ("r1", "refs/remotes/origin/main"),
            ("r2", "refs/heads/r1"),
        ]
        .iter()
        .map(|(child, parent)| (child.to_string(), parent.to_string()))
        .collect();
        let existing = set(&["main", "p1", "p2", "p3", "q", "x", "y", "r1", "r2"]);
        let names = |found: Option<Vec<String>>| found.map(|chain| chain.join(" "));
        assert_eq!(names(chain(&parents, &existing, "p2")).as_deref(), Some("p1 p2 p3"), "down to the base, up while there is one child");
        assert_eq!(names(chain(&parents, &existing, "p3")).as_deref(), Some("p1 p2 p3"), "a deleted child is ignored");
        assert_eq!(names(chain(&parents, &existing, "q")).as_deref(), Some("p1 q"));
        assert_eq!(names(chain(&parents, &existing, "p1")).as_deref(), Some("p1"), "two children end the walk upwards");
        assert_eq!(names(chain(&parents, &existing, "r2")).as_deref(), Some("r1 r2"), "a remote base");
        assert_eq!(chain(&parents, &existing, "x"), None, "cycle");
        assert_eq!(chain(&parents, &existing, "main"), None, "the base is no part");
        assert_eq!(chain(&parents, &existing, "gone"), None, "deleted branch");
    }

    #[test]
    fn the_target_of_the_first_pull_request_is_the_base_on_the_remote() {
        let remotes = vec!["origin".to_string(), "team".to_string(), "team/eu".to_string()];
        assert_eq!(target_name("refs/heads/main", &remotes), "main");
        assert_eq!(target_name("refs/remotes/origin/main", &remotes), "main");
        assert_eq!(target_name("refs/remotes/team/eu/release/2.0", &remotes), "release/2.0", "the longest remote name wins");
        assert_eq!(target_name("refs/remotes/unbekannt/dev", &remotes), "dev");
        assert_eq!(short_ref("refs/remotes/origin/main"), "origin/main");
        assert_eq!(short_ref("refs/heads/feature/x"), "feature/x");
    }
}
