//! What the search by meaning reads from Git: the commits reachable from branches, remote
//! branches, tags and HEAD (the refs of the text search, newest first), and per commit the
//! subject, the message and the changed paths. Reads only (`read_cmd`: read-only, no log of
//! contents); commits go to Git as full SHAs on stdin.

use std::collections::HashMap;
use std::path::Path;

use crate::ai::context::{self, Exclusions};
use crate::app::Core;
use crate::commands::graph::{display_text, is_full_sha, read_cmd, LOG_SAFE, SEARCH_REFS};
use crate::error::{CoreError, CoreResult};
use crate::jobs::CancelToken;
use crate::model::AiOmitReason;
use crate::util;

pub const MAX_SUBJECT: usize = 300;
pub const MAX_BODY: usize = 1000;
pub const MAX_PATHS: usize = 40;
pub const MAX_PATH_CHARS: usize = 200;
/// Commits per `git log --stdin` call.
const CHUNK: usize = 500;
/// A record starts with 0x1E and the SHA; subject and message follow, then the paths (`-z`).
const ENTRY_FORMAT: &str = "--format=%x1e%H%x00%s%x00%b%x00";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitEntry {
    pub sha: String,
    pub subject: String,
    pub body: String,
    /// Changed paths as Git lists them (`--name-only`, new name of a rename; none for a merge).
    pub paths: Vec<String>,
}

/// Newest first, at most `cap`; `true` when there were more.
pub async fn reachable(core: &Core, path: &Path, repo_id: &str, cap: usize, token: &CancelToken) -> CoreResult<(Vec<String>, bool)> {
    let out = read_cmd(core, path, repo_id).arg("rev-list").arg(format!("--max-count={}", cap.saturating_add(1))).args(SEARCH_REFS).run_raw().await?;
    token.check()?;
    if !out.success() {
        return Err(CoreError::unknown("Git could not list the commits of the repository.").with_git_output(out.stderr_text()));
    }
    let mut shas: Vec<String> = out.stdout_lines().into_iter().map(util::decode_lossy).filter(|sha| is_full_sha(sha)).collect();
    let capped = shas.len() > cap;
    shas.truncate(cap);
    Ok((shas, capped))
}

/// Reads `-z --name-only` records field by field: 0x1E+SHA, subject, body, the end of the
/// record (empty), then the paths (the first one after a line break).
#[derive(Default)]
struct EntryParser {
    out: Vec<CommitEntry>,
    current: Option<CommitEntry>,
    header: usize,
}

impl EntryParser {
    fn push(&mut self, field: &[u8]) {
        if let Some(sha) = field.strip_prefix(b"\x1e").map(util::decode_lossy).filter(|sha| is_full_sha(sha)) {
            if let Some(done) = self.current.take() {
                self.out.push(done);
            }
            self.current = Some(CommitEntry { sha, subject: String::new(), body: String::new(), paths: Vec::new() });
            self.header = 1;
            return;
        }
        let Some(entry) = self.current.as_mut() else { return };
        match self.header {
            1 => {
                entry.subject = display_text(field);
                self.header = 2;
            }
            2 => {
                entry.body = display_text(field);
                self.header = 3;
            }
            _ => {
                // The empty end-of-record field and the paths; the first path follows a line break.
                let path = field.strip_prefix(b"\n").unwrap_or(field);
                if !path.is_empty() {
                    entry.paths.push(util::decode_lossy(path));
                }
            }
        }
    }

    fn finish(mut self) -> Vec<CommitEntry> {
        if let Some(done) = self.current.take() {
            self.out.push(done);
        }
        self.out
    }
}

pub async fn entries(core: &Core, path: &Path, repo_id: &str, shas: &[String], token: &CancelToken) -> CoreResult<Vec<CommitEntry>> {
    let mut found: HashMap<String, CommitEntry> = HashMap::with_capacity(shas.len());
    for chunk in shas.chunks(CHUNK) {
        token.check()?;
        let mut stdin = String::new();
        for sha in chunk.iter().filter(|sha| is_full_sha(sha)) {
            stdin.push_str(sha);
            stdin.push('\n');
        }
        if stdin.is_empty() {
            continue;
        }
        let mut parser = EntryParser::default();
        let mut on_field = |field: &[u8]| -> bool {
            parser.push(field);
            true
        };
        read_cmd(core, path, repo_id)
            .arg("log")
            .args(LOG_SAFE)
            .args(["--no-walk=unsorted", "--stdin", "-z", "--name-only", ENTRY_FORMAT])
            .stdin(stdin)
            .run_records(0, Some(token), &mut on_field)
            .await?;
        for entry in parser.finish() {
            found.insert(entry.sha.clone(), entry);
        }
    }
    Ok(shas.iter().filter_map(|sha| found.remove(sha)).collect())
}

/// Names in the root folder of HEAD (for the rephrase route); none without a commit.
pub async fn top_level(core: &Core, path: &Path, repo_id: &str) -> CoreResult<Vec<String>> {
    let out = read_cmd(core, path, repo_id).args(["ls-tree", "-z", "--name-only", "HEAD"]).run_raw().await?;
    if !out.success() {
        return Ok(Vec::new());
    }
    Ok(util::split_z(&out.stdout).map(util::decode_lossy).collect())
}

/// Without the files that are never sent, not even by name (secrets, ignore patterns).
pub fn shown_paths<'a>(paths: &'a [String], exclusions: &Exclusions) -> Vec<&'a String> {
    paths.iter().filter(|path| !matches!(exclusions.reason(path), Some(AiOmitReason::Secret | AiOmitReason::Ignored))).collect()
}

/// The text that is embedded for a commit: subject, message, `Files: …` – redacted.
pub fn entry_text(entry: &CommitEntry, exclusions: &Exclusions, secrets: &[String]) -> String {
    let mut text = cut(entry.subject.trim().trim_end_matches('\r'), MAX_SUBJECT);
    let body = entry.body.replace("\r\n", "\n");
    let body = cut(body.trim(), MAX_BODY);
    if !body.is_empty() {
        text.push('\n');
        text.push_str(&body);
    }
    let shown = shown_paths(&entry.paths, exclusions);
    if !shown.is_empty() {
        let listed: Vec<String> = shown.iter().take(MAX_PATHS).map(|path| cut(path, MAX_PATH_CHARS)).collect();
        text.push_str("\nFiles: ");
        text.push_str(&listed.join(", "));
        if shown.len() > MAX_PATHS {
            text.push_str(&format!(" (+{} more)", shown.len() - MAX_PATHS));
        }
    }
    context::redact_for_ai(&text, secrets)
}

/// At most `max_chars` characters; a cut text ends with "…".
pub fn cut(text: &str, max_chars: usize) -> String {
    if text.chars().count() <= max_chars {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max_chars).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::jobs::CancelToken;
    use crate::testkit::{TestCore, TestRepo};

    async fn opened(repo: &TestRepo) -> (TestCore, String, std::path::PathBuf) {
        let tc = TestCore::new().await;
        let id = tc.open(repo).await.repo.id;
        let path = tc.repo_path(&id).unwrap();
        (tc, id, path)
    }

    #[tokio::test]
    async fn reachable_lists_every_ref_newest_first_up_to_the_cap() {
        let repo = TestRepo::new();
        let first = repo.commit_as("Erster", "Erika Muster", "erika@example.com", "@1600000000 +0200");
        let second = repo.commit_as("Zweiter", "Erika Muster", "erika@example.com", "@1600000600 +0200");
        repo.checkout_new("nur-tag");
        let tagged = repo.commit_as("Nur über den Tag erreichbar", "Erika Muster", "erika@example.com", "@1600001200 -0700");
        repo.tag("v-alt");
        repo.checkout("main");
        repo.git(&["branch", "-D", "nur-tag"]);
        let tree = repo.git(&["rev-parse", "HEAD^{tree}"]);
        let dangling = repo.git(&["commit-tree", &tree, "-p", &second, "-m", "Nur im Undo-Ref"]);
        repo.git(&["update-ref", "refs/forkyard/undo/test", &dangling]);
        let (tc, id, path) = opened(&repo).await;
        let token = CancelToken::new();
        let oracle: Vec<String> = repo.git(&["rev-list", "--branches", "--remotes", "--tags", "HEAD"]).lines().map(str::to_string).collect();
        let (all, capped) = reachable(&tc, &path, &id, 100, &token).await.unwrap();
        assert_eq!(all, oracle, "the same commits in the same order as Git");
        assert_eq!(all, vec![tagged.clone(), second.clone(), first], "newest first, a tag-only commit included");
        assert!(!capped && !all.contains(&dangling), "the app's backup refs are not searched");
        assert_eq!(reachable(&tc, &path, &id, 2, &token).await.unwrap(), (vec![tagged, second], true));

        let empty = TestRepo::new();
        let empty_id = tc.open(&empty).await.repo.id;
        let empty_path = tc.repo_path(&empty_id).unwrap();
        assert_eq!(reachable(&tc, &empty_path, &empty_id, 10, &token).await.unwrap(), (Vec::new(), false), "no commit yet");
    }

    #[tokio::test]
    async fn entries_match_git_for_old_renamed_and_encoded_commits() {
        let repo = TestRepo::new();
        repo.write_file("alt/Anmeldung.rs", "fn anmelden() {}\n");
        let old = repo.commit_as("Uralter Import", "Erika Muster", "erika@example.com", "@946664940 +0530");
        repo.subdir("neu");
        repo.git(&["mv", "alt/Anmeldung.rs", "neu/an meldung ü.rs"]);
        let renamed = repo.commit_as("Datei umbenannt", "Mats Öztürk", "mats@example.com", "@1275418800 -0800");
        repo.write_file("-start.txt", "s\n");
        repo.write_file("[x].txt", "x\n");
        let odd = repo.commit("Seltsame Namen");
        let message = repo.temp_dir().join("nachricht.txt");
        std::fs::write(&message, b"Zeilenenden\r\n\r\nErste Zeile\r\nZweite Zeile\r\n").unwrap();
        repo.write_file("crlf.txt", "a\r\n");
        repo.git(&["add", "-A"]);
        repo.git(&["commit", "-q", "--cleanup=verbatim", "-F", message.to_str().unwrap()]);
        let crlf = repo.head();
        std::fs::write(&message, b"Gr\xfc\xdfe aus K\xf6ln\n").unwrap();
        repo.write_file("koeln.txt", "k\n");
        repo.git(&["add", "-A"]);
        repo.git(&["-c", "i18n.commitEncoding=ISO-8859-1", "commit", "-q", "-F", message.to_str().unwrap()]);
        let latin = repo.head();
        repo.checkout_new("seite");
        let side = repo.commit_file("seite.txt", "s\n", "Seitenzweig");
        repo.checkout("main");
        repo.git(&["merge", "-q", "--no-ff", "-m", "Seite zusammengeführt", "seite"]);
        let merge = repo.head();
        let (tc, id, path) = opened(&repo).await;

        let wanted = vec![merge.clone(), latin.clone(), crlf.clone(), odd.clone(), renamed.clone(), old.clone(), side.clone()];
        let got = entries(&tc, &path, &id, &wanted, &CancelToken::new()).await.unwrap();
        assert_eq!(got.iter().map(|entry| entry.sha.clone()).collect::<Vec<_>>(), wanted, "in the order asked for");
        let by = |sha: &str| got.iter().find(|entry| entry.sha == sha).unwrap().clone();
        for sha in [&old, &renamed, &odd, &side] {
            assert_eq!(by(sha).subject, repo.git(&["show", "-s", "--format=%s", sha]), "subject of {sha}");
            let names: Vec<String> = repo
                .git(&["-c", "core.quotePath=false", "show", "--name-only", "--format=", sha])
                .lines()
                .filter(|line| !line.is_empty())
                .map(str::to_string)
                .collect();
            assert_eq!(by(sha).paths, names, "paths of {sha}");
        }
        assert_eq!(by(&renamed).paths, vec!["neu/an meldung ü.rs".to_string()], "a rename lists the new name");
        assert_eq!(by(&odd).paths, vec!["-start.txt".to_string(), "[x].txt".to_string()]);
        assert_eq!(by(&old).paths, vec!["alt/Anmeldung.rs".to_string()], "the root commit lists its files");
        assert_eq!(by(&latin).subject, "Grüße aus Köln", "re-encoded from the declared Latin-1");
        assert_eq!(by(&crlf).subject.trim_end_matches('\r'), "Zeilenenden");
        assert!(by(&crlf).body.contains("Erste Zeile") && by(&crlf).body.contains("Zweite Zeile"), "{:?}", by(&crlf).body);
        assert_eq!(by(&merge).subject, "Seite zusammengeführt");
        assert!(by(&merge).paths.is_empty(), "a merge lists no files of its own");
        assert!(entries(&tc, &path, &id, &[], &CancelToken::new()).await.unwrap().is_empty());
    }

    #[test]
    fn index_texts_leave_out_secrets_and_ignored_paths() {
        let exclusions = Exclusions::new(&["*.sql".to_string()], "docs/intern/**\n");
        let entry = CommitEntry {
            sha: "a".repeat(40),
            subject: "Zugang eingerichtet\r".into(),
            body: "Token ghp_abcdefghijklmnopqrstuvwxyz0123456789 entfernt\r\nZweite Zeile\r\n".into(),
            paths: [".env.local", "config/server.key", "dump.sql", "docs/intern/plan.md", "package-lock.json", "src/zugang/Übersicht.rs", "-rf"].map(String::from).to_vec(),
        };
        let text = entry_text(&entry, &exclusions, &[]);
        assert!(text.starts_with("Zugang eingerichtet\nToken "), "{text}");
        assert!(text.contains(" entfernt\nZweite Zeile\nFiles: package-lock.json, src/zugang/Übersicht.rs, -rf"), "{text}");
        for hidden in [".env", "server.key", "dump.sql", "docs/intern", "ghp_abcdefghijklmnopqrstuvwxyz0123456789", "\r"] {
            assert!(!text.contains(hidden), "{hidden:?} in {text}");
        }
        let secret_key = "eigener-schluessel-4711";
        let with_key = CommitEntry { body: format!("Schlüssel {secret_key} getauscht"), paths: Vec::new(), ..entry.clone() };
        assert!(!entry_text(&with_key, &exclusions, &[secret_key.to_string()]).contains(secret_key), "the provider key is scrubbed literally");

        let many = CommitEntry {
            subject: "ü".repeat(400),
            body: String::new(),
            paths: (0..45).map(|n| format!("src/datei-{n:02}.rs")).collect(),
            ..entry
        };
        let text = entry_text(&many, &exclusions, &[]);
        assert!(text.starts_with(&format!("{}…\nFiles: src/datei-00.rs, ", "ü".repeat(300))), "{text}");
        assert!(text.ends_with("src/datei-39.rs (+5 more)"), "{text}");
        assert_eq!(cut("Köln", 4), "Köln");
        assert_eq!(cut("Kölner", 4), "Köln…");
    }
}
