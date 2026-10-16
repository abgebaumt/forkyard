//! The context of an AI request: building blocks (here the staged diff), filters (Grundregel 5),
//! redaction and the budget in tokens (chars / 3.5; min(function budget, 70 % of the model's
//! context)). Shortening runs in a fixed order and every step shows in the preview:
//! generated/lock files → binaries → the largest files to start and end of each hunk → files only
//! by name and line counts. Secret and ignored files are not mentioned in the text at all.
//!
//! Git output with file contents is read with `no_log`: contents never reach the activity log.

use crate::ai::ignore::{builtin_reason, IgnoreRules};
use crate::ai::prompt::{self, Prompt, Section};
use crate::app::Core;
use crate::error::CoreResult;
use crate::git::redact;
use crate::model::{AiOmitReason, AiOmitted, Settings};
use crate::{secrets, util};

pub const CHARS_PER_TOKEN: f64 = 3.5;
/// At most this many file patches are read; further files go out by name and line counts.
pub const MAX_FILES: usize = 400;
/// Generic instruction of the staged-changes preview (`AiInput::StagedChanges`).
pub const STAGED_INSTRUCTION: &str = "Look at the staged changes of the repository.";
const HUNK_HEAD: usize = 20;
const HUNK_TAIL: usize = 10;

pub fn estimate_tokens(chars: u64) -> u64 {
    (chars as f64 / CHARS_PER_TOKEN).ceil() as u64
}

pub fn budget_tokens(feature_budget: u64, model_context: u64) -> u64 {
    feature_budget.min(model_context.saturating_mul(7) / 10)
}

/// One staged file. `added: None` = binary.
#[derive(Debug, Clone, PartialEq)]
pub struct DiffFile {
    pub path: String,
    pub old_path: Option<String>,
    pub added: Option<u64>,
    pub deleted: Option<u64>,
    /// Bytes in the index (read for files sent by name only).
    pub size: u64,
    /// From the first `@@` line on; empty when not read.
    pub patch: String,
    /// Not read because of `MAX_FILES`.
    pub unread: bool,
    raw: Vec<u8>,
    old_raw: Option<Vec<u8>>,
}

impl DiffFile {
    /// A text file (tests and builders that already have the patch).
    pub fn text(path: &str, patch: &str, added: u64, deleted: u64) -> DiffFile {
        DiffFile { path: path.to_string(), old_path: None, added: Some(added), deleted: Some(deleted), size: patch.len() as u64, patch: patch.to_string(), unread: false, raw: path.as_bytes().to_vec(), old_raw: None }
    }

    pub fn binary(path: &str, size: u64) -> DiffFile {
        DiffFile { path: path.to_string(), old_path: None, added: None, deleted: None, size, patch: String::new(), unread: false, raw: path.as_bytes().to_vec(), old_raw: None }
    }

    pub fn is_binary(&self) -> bool {
        self.added.is_none()
    }
}

/// Built-in rules, the global list and `.forkyard/ai-ignore` – each list on its own, so a `!`
/// can only undo its own list.
pub struct Exclusions {
    global: IgnoreRules,
    repo: IgnoreRules,
}

impl Exclusions {
    pub fn new(global_patterns: &[String], repo_file: &str) -> Self {
        Exclusions { global: IgnoreRules::parse(&global_patterns.join("\n")), repo: IgnoreRules::parse(repo_file) }
    }

    /// `.forkyard/ai-ignore` from the working directory, otherwise from `HEAD` (only read).
    pub async fn load(core: &Core, repo_id: &str, global_patterns: &[String]) -> CoreResult<Self> {
        let root = core.repo_path(repo_id)?;
        let text = match tokio::fs::read(root.join(".forkyard").join("ai-ignore")).await {
            Ok(bytes) => util::decode_lossy(&bytes),
            Err(_) => {
                let out = core.git_for(repo_id)?.args(["show", "HEAD:.forkyard/ai-ignore"]).read_only().no_log().run_raw().await?;
                if out.success() {
                    util::decode_lossy(&out.stdout)
                } else {
                    String::new()
                }
            }
        };
        Ok(Self::new(global_patterns, &text))
    }

    /// Secret before ignored before generated: an ignore pattern hides even the name of a lock file.
    pub fn reason(&self, path: &str) -> Option<AiOmitReason> {
        match builtin_reason(path) {
            Some(AiOmitReason::Secret) => Some(AiOmitReason::Secret),
            builtin => {
                if self.global.is_ignored(path) || self.repo.is_ignored(path) {
                    Some(AiOmitReason::Ignored)
                } else {
                    builtin
                }
            }
        }
    }

    fn reason_for(&self, file: &DiffFile) -> Option<AiOmitReason> {
        let hidden = |reason: &AiOmitReason| matches!(reason, AiOmitReason::Secret | AiOmitReason::Ignored);
        // A renamed secret stays a secret under its new name.
        self.reason(&file.path).filter(hidden).or_else(|| file.old_path.as_deref().and_then(|old| self.reason(old)).filter(hidden)).or_else(|| self.reason(&file.path))
    }
}

/// How a file appears in the text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Shown {
    Full,
    Shortened,
    NameOnly(AiOmitReason),
}

#[derive(Debug, Clone)]
pub struct Fitted {
    /// Files that appear in the text (secret and ignored files do not).
    pub entries: Vec<(DiffFile, Shown)>,
    pub omitted: Vec<AiOmitted>,
    /// Paths shown only with start and end of each hunk.
    pub shortened: Vec<String>,
}

/// One numstat row: (added, deleted, old path, path); counts are `None` for binaries.
type NumstatRow = (Option<u64>, Option<u64>, Option<Vec<u8>>, Vec<u8>);

/// `git diff --cached --numstat -z -M`: (added, deleted, old path, path) as bytes.
fn parse_numstat(bytes: &[u8]) -> Vec<NumstatRow> {
    let parts: Vec<&[u8]> = util::split_z(bytes).collect();
    let mut out = Vec::new();
    let mut index = 0;
    while index < parts.len() {
        let mut fields = parts[index].splitn(3, |byte| *byte == b'\t');
        let (Some(added), Some(deleted), Some(rest)) = (fields.next(), fields.next(), fields.next()) else {
            index += 1;
            continue;
        };
        let number = |field: &[u8]| std::str::from_utf8(field).ok().and_then(|text| text.parse::<u64>().ok());
        let (added, deleted) = (number(added), number(deleted));
        if rest.is_empty() {
            let (Some(old), Some(new)) = (parts.get(index + 1), parts.get(index + 2)) else { break };
            out.push((added, deleted, Some(old.to_vec()), new.to_vec()));
            index += 3;
        } else {
            out.push((added, deleted, None, rest.to_vec()));
            index += 1;
        }
    }
    out
}

/// The staged files with their patches (excluded, generated and binary files without content).
pub async fn staged_files(core: &Core, repo_id: &str, exclusions: &Exclusions) -> CoreResult<Vec<DiffFile>> {
    let out = core
        .git_for(repo_id)?
        .args(["diff", "--cached", "--numstat", "-z", "-M", "--no-color", "--no-ext-diff", "--no-textconv"])
        .read_only()
        .no_log()
        .run()
        .await?;
    let mut files = Vec::new();
    let mut read = 0usize;
    for (added, deleted, old_raw, raw) in parse_numstat(&out.stdout) {
        let mut file = DiffFile {
            path: util::decode_lossy(&raw),
            old_path: old_raw.as_deref().map(util::decode_lossy),
            added,
            deleted,
            size: 0,
            patch: String::new(),
            unread: false,
            raw,
            old_raw,
        };
        match exclusions.reason_for(&file) {
            Some(AiOmitReason::Secret | AiOmitReason::Ignored) => {}
            Some(_) => file.size = staged_size(core, repo_id, &file).await,
            None if file.is_binary() => file.size = staged_size(core, repo_id, &file).await,
            None if read < MAX_FILES => {
                file.patch = staged_patch(core, repo_id, &file).await?;
                file.size = file.patch.len() as u64;
                read += 1;
            }
            None => file.unread = true,
        }
        files.push(file);
    }
    Ok(files)
}

async fn staged_patch(core: &Core, repo_id: &str, file: &DiffFile) -> CoreResult<String> {
    // Literal pathspecs: a file named `[entwurf] notiz.md` must not pull in `e notiz.md`.
    let mut cmd = core
        .git_for(repo_id)?
        .env("GIT_LITERAL_PATHSPECS", "1")
        .args(["diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv", "-M", "-U3", "--"]);
    if let Some(old) = &file.old_raw {
        cmd = cmd.arg_bytes(old);
    }
    let out = cmd.arg_bytes(&file.raw).read_only().no_log().run().await?;
    let text = util::decode_text(&out.stdout).0;
    Ok(match text.find("\n@@") {
        Some(start) => text[start + 1..].to_string(),
        None => String::new(),
    })
}

/// Size in the index, for a deleted file in `HEAD`; 0 if neither is known.
async fn staged_size(core: &Core, repo_id: &str, file: &DiffFile) -> u64 {
    for prefix in [b":".as_slice(), b"HEAD:".as_slice()] {
        let spec = [prefix, file.raw.as_slice()].concat();
        let Ok(cmd) = core.git_for(repo_id) else { return 0 };
        if let Ok(out) = cmd.args(["cat-file", "-s"]).arg_bytes(&spec).read_only().no_log().run_raw().await {
            if let (true, Ok(size)) = (out.success(), out.stdout_text().trim().parse::<u64>()) {
                return size;
            }
        }
    }
    0
}

fn header(file: &DiffFile) -> String {
    let mut line = format!("File: {}", file.path);
    if let Some(old) = &file.old_path {
        line.push_str(&format!(" (renamed from {old})"));
    }
    if let (Some(added), Some(deleted)) = (file.added, file.deleted) {
        line.push_str(&format!(" +{added} -{deleted}"));
    }
    line
}

fn render_entry(file: &DiffFile, shown: Shown) -> String {
    match shown {
        Shown::Full => format!("{}\n{}", header(file), file.patch),
        Shown::Shortened => format!("{} (shortened: start and end of each hunk)\n{}", header(file), shorten_patch(&file.patch)),
        Shown::NameOnly(AiOmitReason::Generated) => format!("{} – generated or lock file, {} bytes, content not sent\n", header(file), file.size),
        Shown::NameOnly(AiOmitReason::Binary) => format!("{} – binary file, {} bytes, content not sent\n", header(file), file.size),
        Shown::NameOnly(_) => format!("{} – content left out to stay within the size limit\n", header(file)),
    }
}

fn largest(entries: &[(DiffFile, Shown)], lengths: &[usize], eligible: impl Fn(Shown) -> bool) -> Option<usize> {
    entries.iter().enumerate().filter(|(_, (_, shown))| eligible(*shown)).max_by_key(|(index, _)| lengths[*index]).map(|(index, _)| index)
}

/// Applies the filters and the budget (in characters of the rendered text).
pub fn fit(files: Vec<DiffFile>, exclusions: &Exclusions, budget_chars: usize) -> Fitted {
    let mut omitted = Vec::new();
    let mut entries: Vec<(DiffFile, Shown)> = Vec::new();
    for file in files {
        let item = |reason: AiOmitReason, file: &DiffFile| AiOmitted { path: file.path.clone(), reason, size: file.size };
        match exclusions.reason_for(&file) {
            Some(reason @ (AiOmitReason::Secret | AiOmitReason::Ignored)) => omitted.push(item(reason, &file)),
            Some(reason) => {
                omitted.push(item(reason, &file));
                entries.push((file, Shown::NameOnly(reason)));
            }
            None if file.is_binary() => {
                omitted.push(item(AiOmitReason::Binary, &file));
                entries.push((file, Shown::NameOnly(AiOmitReason::Binary)));
            }
            None if file.unread => {
                omitted.push(item(AiOmitReason::Budget, &file));
                entries.push((file, Shown::NameOnly(AiOmitReason::Budget)));
            }
            None => entries.push((file, Shown::Full)),
        }
    }
    // Entries are joined with one line break each.
    let total = |lengths: &[usize]| lengths.iter().sum::<usize>() + lengths.len().saturating_sub(1);
    let mut lengths: Vec<usize> = entries.iter().map(|(file, shown)| render_entry(file, *shown).len()).collect();
    let mut shortened = Vec::new();
    // Files whose hunks are too short to shorten (shortening would only add the note) stay full.
    let mut unshortenable = vec![false; entries.len()];
    while total(&lengths) > budget_chars {
        let Some(index) = entries
            .iter()
            .enumerate()
            .filter(|(index, (_, shown))| *shown == Shown::Full && !unshortenable[*index])
            .max_by_key(|(index, _)| lengths[*index])
            .map(|(index, _)| index)
        else {
            break;
        };
        let short = render_entry(&entries[index].0, Shown::Shortened).len();
        if short >= lengths[index] {
            unshortenable[index] = true;
            continue;
        }
        entries[index].1 = Shown::Shortened;
        lengths[index] = short;
        shortened.push(entries[index].0.path.clone());
    }
    while total(&lengths) > budget_chars {
        let Some(index) = largest(&entries, &lengths, |shown| matches!(shown, Shown::Full | Shown::Shortened)) else { break };
        let reason = Shown::NameOnly(AiOmitReason::Budget);
        entries[index].1 = reason;
        lengths[index] = render_entry(&entries[index].0, reason).len();
        let path = entries[index].0.path.clone();
        shortened.retain(|known| *known != path);
        omitted.push(AiOmitted { path, reason: AiOmitReason::Budget, size: entries[index].0.size });
    }
    Fitted { entries, omitted, shortened }
}

/// Keeps the first 20 and the last 10 lines of every hunk; line endings stay as they are.
pub fn shorten_patch(patch: &str) -> String {
    fn flush(hunk: &mut Vec<&str>, out: &mut String) {
        if hunk.len() > HUNK_HEAD + HUNK_TAIL + 1 {
            out.extend(hunk[..HUNK_HEAD].iter().copied());
            out.push_str(&format!("… {} lines left out …\n", hunk.len() - HUNK_HEAD - HUNK_TAIL));
            out.extend(hunk[hunk.len() - HUNK_TAIL..].iter().copied());
        } else {
            out.extend(hunk.iter().copied());
        }
        hunk.clear();
    }
    let mut out = String::with_capacity(patch.len().min(64 * 1024));
    let mut hunk: Vec<&str> = Vec::new();
    for line in patch.split_inclusive('\n') {
        if line.starts_with("@@") {
            flush(&mut hunk, &mut out);
            out.push_str(line);
        } else {
            hunk.push(line);
        }
    }
    flush(&mut hunk, &mut out);
    out
}

pub fn redact_for_ai(text: &str, secrets: &[String]) -> String {
    secrets::scrub(&redact::redact(text), secrets)
}

pub fn render(fitted: &Fitted, secrets: &[String]) -> String {
    let text = fitted.entries.iter().map(|(file, shown)| render_entry(file, *shown)).collect::<Vec<_>>().join("\n");
    redact_for_ai(&text, secrets)
}

/// Result of a builder: the prompt and what the preview lists.
#[derive(Debug, Clone)]
pub struct Built {
    pub prompt: Prompt,
    pub omitted: Vec<AiOmitted>,
    pub shortened: Vec<String>,
}

/// `AiInput::StagedChanges`: the staged diff of the repository, filtered and within the budget.
/// `secrets`: values known to be secret (the provider key), scrubbed literally.
pub async fn staged_changes(core: &Core, repo_id: &str, settings: &Settings, budget_tokens: u64, locale: &str, secrets: &[String]) -> CoreResult<Built> {
    let exclusions = Exclusions::load(core, repo_id, &settings.ai_exclude).await?;
    let files = staged_files(core, repo_id, &exclusions).await?;
    let fitted = fit(files, &exclusions, (budget_tokens as f64 * CHARS_PER_TOKEN) as usize);
    let body = render(&fitted, secrets);
    let body = if body.trim().is_empty() { "(nothing staged)".to_string() } else { body };
    let prompt = prompt::build(STAGED_INSTRUCTION, locale, &[Section { title: "Staged changes".into(), body }]);
    Ok(Built { prompt, omitted: fitted.omitted, shortened: fitted.shortened })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::AiOmitReason;
    use crate::testkit::{TestCore, TestRepo};

    fn omitted(built: &Built, path: &str) -> Option<AiOmitReason> {
        built.omitted.iter().find(|item| item.path == path).map(|item| item.reason)
    }

    #[test]
    fn estimates_and_budgets_follow_spec_1_4() {
        assert_eq!(estimate_tokens(0), 0);
        assert_eq!(estimate_tokens(7), 2);
        assert_eq!(estimate_tokens(3500), 1000);
        assert_eq!(estimate_tokens(3501), 1001);
        assert_eq!(budget_tokens(24_000, 200_000), 24_000, "the function's budget when the model is large");
        assert_eq!(budget_tokens(24_000, 8_192), 5_734, "70 % of a small local model");
    }

    #[tokio::test]
    async fn staged_changes_leave_out_secrets_ignored_and_generated_files() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        repo.write_file(".forkyard/ai-ignore", "intern/**\n!intern/oeffentlich.md\n");
        repo.write_file("src/main.rs", "fn main() {\n    let key = \"sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx\";\n    println!(\"{key}\");\n}\n");
        repo.write_file(".env", "DB_PASSWORD=hunter2-sehr-geheim\n");
        repo.write_file("Cargo.lock", "# lock\nversion = 4\n");
        repo.write_file("intern/plan.md", "Übernahme von Firma X\n");
        repo.write_file("intern/oeffentlich.md", "Darf raus\n");
        repo.write_file("dump.sql", "insert into kunden values (1);\n");
        let png: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0, 0, 0, 13, 1, 2, 3, 0, 255, 0, 7];
        repo.write_file("logo.png", &png);
        repo.write_file("Übersicht mit Leerzeichen.md", "Inhalt äöü\r\nZeile 2\r\n");
        repo.write_file("-flag.txt", "x\n");
        // Pathspec magic: `[entwurf] notiz.md` read as a glob would also match `e notiz.md`.
        repo.write_file("[entwurf] notiz.md", "Entwurf\n");
        repo.write_file("e notiz.md", "nur einmal\n");
        repo.git(&["add", "-A"]);
        let id = tc.open(&repo).await.repo.id;
        let settings = Settings { ai_exclude: vec!["*.sql".into()], ..Settings::default() };

        let built = staged_changes(&tc, &id, &settings, 24_000, "de-DE", &[]).await.unwrap();
        let text = built.prompt.text();

        assert!(text.contains("File: src/main.rs"), "{text}");
        assert!(!text.contains("AbCdEfGhIjKlMnOpQrStUvWx") && text.contains("***"), "the key is redacted");
        assert!(!text.contains("hunter2") && !text.contains("File: .env"), ".env is never sent, not even its name");
        assert_eq!(omitted(&built, ".env"), Some(AiOmitReason::Secret));
        assert!(text.contains("File: Cargo.lock") && text.contains("generated or lock file"), "lock files: name and size");
        assert_eq!(omitted(&built, "Cargo.lock"), Some(AiOmitReason::Generated));
        assert!(!text.contains("intern/plan.md") && !text.contains("Übernahme"), "ai-ignore from the working directory");
        assert_eq!(omitted(&built, "intern/plan.md"), Some(AiOmitReason::Ignored));
        assert!(text.contains("Darf raus"), "a negated pattern of the same file re-includes");
        assert!(!text.contains("dump.sql") && !text.contains("kunden"), "global pattern");
        assert_eq!(omitted(&built, "dump.sql"), Some(AiOmitReason::Ignored));
        assert!(text.contains(&format!("File: logo.png – binary file, {} bytes", png.len())), "{text}");
        assert!(text.contains("File: Übersicht mit Leerzeichen.md") && text.contains("+Zeile 2\r\n"), "umlauts, spaces and CRLF stay");
        assert!(text.contains("File: -flag.txt"), "a leading dash is a file, not an option");
        assert!(text.contains("File: [entwurf] notiz.md") && text.contains("+Entwurf"), "{text}");
        assert_eq!(text.matches("+nur einmal").count(), 1, "paths are literal, not globs: {text}");
        assert!(text.contains(&format!("<<<REPO {}>>>", built.prompt.token)));
        assert!(built.prompt.system.contains("de-DE"));
    }

    #[tokio::test]
    async fn ai_ignore_comes_from_head_when_the_working_directory_has_none() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        repo.commit_file(".forkyard/ai-ignore", "*.geheim.txt\n", "AI-Ausschlüsse");
        repo.remove_file(".forkyard/ai-ignore");
        repo.write_file("a.geheim.txt", "nicht senden\n");
        repo.git(&["add", "a.geheim.txt"]);
        let id = tc.open(&repo).await.repo.id;
        let settings = Settings::default();
        let built = staged_changes(&tc, &id, &settings, 24_000, "en", &[]).await.unwrap();
        assert_eq!(omitted(&built, "a.geheim.txt"), Some(AiOmitReason::Ignored));
        assert!(!built.prompt.text().contains("nicht senden"));
        // The working directory's version wins over HEAD.
        repo.write_file(".forkyard/ai-ignore", "anderes.txt\n");
        let built = staged_changes(&tc, &id, &settings, 24_000, "en", &[]).await.unwrap();
        assert!(built.prompt.text().contains("nicht senden"));
    }

    #[tokio::test]
    async fn a_rename_names_both_paths_with_the_line_counts_of_git() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let lines: String = (1..=20).map(|n| format!("Zeile {n}\n")).collect();
        repo.commit_file("alt/name.txt", &lines, "Datei");
        // A move into a new directory with one changed line; Git finds the rename itself (-M).
        repo.remove_file("alt/name.txt");
        repo.write_file("neu/name.txt", lines.replace("Zeile 7\n", "Zeile sieben\n"));
        repo.git(&["add", "-A"]);
        let numstat = repo.git(&["diff", "--cached", "--numstat", "-M"]);
        assert!(numstat.starts_with("1\t1\t"), "the oracle: {numstat}");
        let id = tc.open(&repo).await.repo.id;
        let built = staged_changes(&tc, &id, &Settings::default(), 24_000, "en", &[]).await.unwrap();
        assert!(built.prompt.text().contains("File: neu/name.txt (renamed from alt/name.txt) +1 -1"), "{}", built.prompt.text());
    }

    #[tokio::test]
    async fn known_secrets_are_scrubbed_even_without_a_pattern() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        repo.write_file("notes.txt", "my key is plainword-9f8e7d6c\n");
        repo.git(&["add", "-A"]);
        let id = tc.open(&repo).await.repo.id;
        let built = staged_changes(&tc, &id, &Settings::default(), 24_000, "en", &["plainword-9f8e7d6c".to_string()]).await.unwrap();
        assert!(!built.prompt.text().contains("plainword-9f8e7d6c"));
    }

    #[test]
    fn large_diffs_are_cut_in_the_fixed_order() {
        let hunk = |count: usize, width: usize| -> String {
            let mut patch = format!("@@ -0,0 +1,{count} @@\n");
            for line in 1..=count {
                patch.push_str(&format!("+{:0>width$}\n", line, width = width - 2));
            }
            patch
        };
        let files = || {
            vec![
                DiffFile::text("a.txt", &hunk(1000, 30), 1000, 0),
                DiffFile::text("b.txt", &hunk(100, 50), 100, 0),
                DiffFile::text("c.txt", &hunk(5, 30), 5, 0),
                DiffFile::text("yarn.lock", "@@ -1 +1 @@\n-a\n+b\n", 1, 1),
            ]
        };
        let none = Exclusions::new(&[], "");
        let shown = |fitted: &Fitted, path: &str| fitted.entries.iter().find(|(file, _)| file.path == path).map(|(_, shown)| *shown);

        let roomy = fit(files(), &none, 100_000);
        assert_eq!(shown(&roomy, "a.txt"), Some(Shown::Full));
        assert_eq!(shown(&roomy, "yarn.lock"), Some(Shown::NameOnly(AiOmitReason::Generated)), "lock files first, whatever the budget");

        let medium = fit(files(), &none, 8_000);
        assert_eq!(shown(&medium, "a.txt"), Some(Shown::Shortened), "the largest file is shortened first");
        assert_eq!(shown(&medium, "b.txt"), Some(Shown::Full));
        assert_eq!(medium.shortened, vec!["a.txt".to_string()]);

        let tight = fit(files(), &none, 1_500);
        assert_eq!(shown(&tight, "a.txt"), Some(Shown::Shortened));
        assert_eq!(shown(&tight, "b.txt"), Some(Shown::NameOnly(AiOmitReason::Budget)), "then the largest remaining file only by name");
        assert_eq!(shown(&tight, "c.txt"), Some(Shown::Full));
        assert!(tight.omitted.iter().any(|item| item.path == "b.txt" && item.reason == AiOmitReason::Budget));
        assert_eq!(tight.shortened, vec!["a.txt".to_string()], "b.txt is no longer shortened but left out");
        let rendered = render(&tight, &[]);
        assert!(rendered.len() <= 1_500, "{}", rendered.len());
        assert!(rendered.contains("File: b.txt +100 -0 – content left out to stay within the size limit"));
    }

    #[test]
    fn shortened_hunks_keep_head_and_tail_and_line_endings() {
        let mut patch = String::from("@@ -1,100 +1,100 @@\n");
        for line in 1..=100 {
            patch.push_str(&format!("+line {line}\r\n"));
        }
        let short = shorten_patch(&patch);
        assert!(short.starts_with("@@ -1,100 +1,100 @@\n+line 1\r\n"));
        assert!(short.contains("+line 20\r\n") && !short.contains("+line 21\r\n"));
        assert!(short.contains("… 70 lines left out …\n"));
        assert!(short.contains("+line 91\r\n") && short.ends_with("+line 100\r\n"));
        assert!(!short.contains("+line 90\r\n"));
        let small = "@@ -1,2 +1,2 @@\n-a\n+b\n";
        assert_eq!(shorten_patch(small), small, "short hunks stay as they are");
    }
}
