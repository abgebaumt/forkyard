//! Names of a coding agent (Entscheidung 3): short name from the task, branch `agent/<short>`,
//! worktree folder `<parent>/<repo>.agents/<short>`. Short names only contain `a-z`, `0-9`
//! and `-`, so they are valid in branch names and as folder names on every system.

use std::path::{Path, PathBuf};

use crate::error::{CoreError, CoreResult};

pub const BRANCH_PREFIX: &str = "agent/";
pub const MAX_SHORT_NAME: usize = 32;
const FALLBACK: &str = "agent";
/// Highest suffix tried for a free name (`-2` … `-99`).
const MAX_SUFFIX: u32 = 99;

/// Latin letters with accents become their base letters; German umlauts and ß are spelled out.
fn fold(c: char) -> Option<&'static str> {
    Some(match c {
        'ä' | 'Ä' => "ae",
        'ö' | 'Ö' => "oe",
        'ü' | 'Ü' => "ue",
        'ß' => "ss",
        'æ' | 'Æ' => "ae",
        'œ' | 'Œ' => "oe",
        'à' | 'á' | 'â' | 'ã' | 'å' | 'À' | 'Á' | 'Â' | 'Ã' | 'Å' => "a",
        'ç' | 'Ç' => "c",
        'è' | 'é' | 'ê' | 'ë' | 'È' | 'É' | 'Ê' | 'Ë' => "e",
        'ì' | 'í' | 'î' | 'ï' | 'Ì' | 'Í' | 'Î' | 'Ï' => "i",
        'ñ' | 'Ñ' => "n",
        'ò' | 'ó' | 'ô' | 'õ' | 'ø' | 'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ø' => "o",
        'ù' | 'ú' | 'û' | 'Ù' | 'Ú' | 'Û' => "u",
        'ý' | 'ÿ' | 'Ý' => "y",
        _ => return None,
    })
}

fn words(text: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    for c in text.chars() {
        if c.is_ascii_alphanumeric() {
            current.push(c.to_ascii_lowercase());
        } else if let Some(folded) = fold(c) {
            current.push_str(folded);
        } else if !current.is_empty() {
            words.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

/// Words joined by `-`, at most `MAX_SHORT_NAME` characters, cut at a word boundary (a single
/// longer word is cut itself). Nothing usable: `agent`.
pub fn short_name_from_task(task: &str) -> String {
    let mut out = String::new();
    for word in words(task) {
        let extra = if out.is_empty() { word.len() } else { word.len() + 1 };
        if out.len() + extra > MAX_SHORT_NAME {
            if out.is_empty() {
                out = word.chars().take(MAX_SHORT_NAME).collect();
            }
            break;
        }
        if !out.is_empty() {
            out.push('-');
        }
        out.push_str(&word);
    }
    if out.is_empty() {
        FALLBACK.to_string()
    } else {
        out
    }
}

/// Short name for a branch the user typed: without `agent/`, otherwise like a task.
pub fn short_name_for_branch(branch: &str) -> String {
    short_name_from_task(branch.strip_prefix(BRANCH_PREFIX).unwrap_or(branch))
}

/// `base`, `base-2`, … `base-99`.
pub fn candidates(base: &str) -> impl Iterator<Item = String> + '_ {
    std::iter::once(base.to_string()).chain((2..=MAX_SUFFIX).map(move |n| format!("{base}-{n}")))
}

/// `<parent>/<repo>.agents` for the main worktree `<parent>/<repo>`.
pub fn agents_dir(main_root: &Path) -> CoreResult<PathBuf> {
    let refuse = || CoreError::not_allowed("Coding agents need a folder next to the repository; the repository is at the top of the drive.");
    let name = main_root.file_name().ok_or_else(refuse)?;
    let parent = main_root.parent().ok_or_else(refuse)?;
    let mut folder = name.to_os_string();
    folder.push(".agents");
    Ok(parent.join(folder))
}

/// The first of `candidates(base)` whose folder in `dir` does not exist and which `taken` does not
/// report (short names of other agents).
pub fn free_name(dir: &Path, base: &str, taken: &dyn Fn(&str) -> bool) -> CoreResult<String> {
    candidates(base)
        .find(|name| !dir.join(name).exists() && !taken(name))
        .ok_or_else(|| CoreError::name_exists(format!("There are already {MAX_SUFFIX} agents named “{base}”. Choose another branch name.")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_names_fold_umlauts_and_stay_valid_branch_parts() {
        // Expected values are written out by hand from the rule: lower case, umlauts folded,
        // words joined by "-", at most 32 characters at a word boundary.
        let cases = [
            ("Fix the login bug in auth.ts", "fix-the-login-bug-in-auth-ts"),
            ("Größe der Übersicht anpassen", "groesse-der-uebersicht-anpassen"),
            ("Refaktoriere den Zahlungsdienst und schreibe Tests für alle Randfälle", "refaktoriere-den-zahlungsdienst"),
            ("--force push verhindern", "force-push-verhindern"),
            ("Ändere C:\\Users\\Jörg\\Notizen.txt", "aendere-c-users-joerg-notizen"),
            ("Café crème brûlée", "cafe-creme-brulee"),
            ("   ", "agent"),
            ("日本語のタスク", "agent"),
            ("README.md\r\naktualisieren", "readme-md-aktualisieren"),
        ];
        for (task, expected) in cases {
            let name = short_name_from_task(task);
            assert_eq!(name, expected, "{task:?}");
            assert!(crate::util::check_ref_name(&format!("{BRANCH_PREFIX}{name}")).is_ok(), "{name}");
            assert!(name.len() <= MAX_SHORT_NAME);
        }
        // One word longer than the limit is cut.
        assert_eq!(short_name_from_task(&"x".repeat(40)), "x".repeat(32));
        // From an edited branch: the "agent/" prefix goes, slashes become dashes.
        assert_eq!(short_name_for_branch("agent/fix-login"), "fix-login");
        assert_eq!(short_name_for_branch("feature/JIRA-12_neu"), "feature-jira-12-neu");
        let suffixed: Vec<String> = candidates("fix").take(3).collect();
        assert_eq!(suffixed, vec!["fix", "fix-2", "fix-3"]);
        assert_eq!(candidates("fix").count(), 99);
    }

    #[test]
    fn the_agents_folder_sits_next_to_the_main_worktree() {
        let root = std::path::Path::new("/home/anna/Mein Projekt Ä/web app");
        assert_eq!(agents_dir(root).unwrap(), std::path::PathBuf::from("/home/anna/Mein Projekt Ä/web app.agents"));
        #[cfg(windows)]
        assert_eq!(agents_dir(std::path::Path::new(r"C:\Users\Jörg\repo")).unwrap(), std::path::PathBuf::from(r"C:\Users\Jörg\repo.agents"));
        assert_eq!(agents_dir(std::path::Path::new("/")).unwrap_err().code, crate::ErrorCode::NotAllowed);

        let dir = crate::testkit::temp_folder();
        std::fs::create_dir_all(dir.path().join("fix-login")).unwrap();
        std::fs::create_dir_all(dir.path().join("fix-login-2")).unwrap();
        let none = |_: &str| false;
        assert_eq!(free_name(dir.path(), "fix-login", &none).unwrap(), "fix-login-3");
        let taken = |name: &str| name == "fix-login-3";
        assert_eq!(free_name(dir.path(), "fix-login", &taken).unwrap(), "fix-login-4");
        assert_eq!(free_name(dir.path(), "neu", &none).unwrap(), "neu");
        let all = |_: &str| true;
        assert_eq!(free_name(dir.path(), "neu", &all).unwrap_err().code, crate::ErrorCode::NameExists);
    }
}
