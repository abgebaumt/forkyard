//! Patches: creating them as text and applying them.
//!
//! `patch_create` returns a patch that `git apply` (and, for a single commit, also `git am`)
//! understands. Binary files and files whose diff is not valid UTF-8 are left out – their
//! content does not survive the trip as text; they are listed in `skipped`.
//! `patch_apply` applies a patch to the working directory or only checks whether it fits.

use crate::app::Core;
use crate::commands::diff::TempIndex;
use crate::commands::history::normalize_rel_path;
use crate::commands::status::{self, read_status};
use crate::error::{CoreError, CoreResult};
use crate::git::GitCmd;
use crate::model::{DiffSource, PatchText, RepoChange, Status};
use crate::util;

/// Largest patch that `patch_apply` accepts or `patch_create` returns.
pub const MAX_PATCH_BYTES: usize = 32 * 1024 * 1024;
/// Maximum number of characters for all paths together (they become arguments to Git).
const MAX_PATH_ARGUMENT_CHARS: usize = 20_000;

/// Fixed options so that the user's configuration (prefixes, external diff, textconv, colours)
/// does not change the patch.
const DIFF_OPTIONS: [&str; 7] = ["--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "--full-index", "-M"];

fn git(core: &Core, repo_id: &str) -> CoreResult<GitCmd> {
    Ok(core.git_for(repo_id)?.env("GIT_LITERAL_PATHSPECS", "1"))
}

/// Only SHAs (also abbreviated) – nothing Git could read as an option or expression.
fn check_sha(rev: &str) -> CoreResult<&str> {
    let rev = rev.trim();
    if (4..=64).contains(&rev.len()) && rev.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(rev)
    } else {
        Err(CoreError::not_found(format!("The commit “{rev}” wasn't found.")))
    }
}

/// Splits a patch into its file sections (`diff --git …`); with `format-patch` they are preceded
/// by the header with author, date and message.
fn split_sections(patch: &[u8]) -> (&[u8], Vec<&[u8]>) {
    const MARK: &[u8] = b"diff --git ";
    let mut starts: Vec<usize> = Vec::new();
    let mut line_start = 0;
    while line_start < patch.len() {
        if patch[line_start..].starts_with(MARK) {
            starts.push(line_start);
        }
        match patch[line_start..].iter().position(|&b| b == b'\n') {
            Some(newline) => line_start += newline + 1,
            None => break,
        }
    }
    let Some(&first) = starts.first() else { return (patch, Vec::new()) };
    let mut sections = Vec::with_capacity(starts.len());
    for (i, &start) in starts.iter().enumerate() {
        let end = starts.get(i + 1).copied().unwrap_or(patch.len());
        sections.push(&patch[start..end]);
    }
    (&patch[..first], sections)
}

/// Path of a section's file (new side), from `+++ b/…`, `rename to …` or the header line.
fn section_path(section: &[u8]) -> String {
    let text = util::decode_lossy(section);
    let mut from_header: Option<String> = None;
    for (i, line) in text.lines().enumerate() {
        if i == 0 {
            // `diff --git a/x b/x` – if both names are equal, the second half is the path.
            let rest = line.trim_start_matches("diff --git ");
            from_header = rest.rsplit_once(" b/").map(|(_, path)| path.trim_matches('"').to_string());
            continue;
        }
        if line.starts_with("@@") {
            break;
        }
        for prefix in ["rename to ", "copy to "] {
            if let Some(path) = line.strip_prefix(prefix) {
                return path.trim_matches('"').to_string();
            }
        }
        if let Some(path) = line.strip_prefix("+++ b/") {
            return path.trim_end_matches('\t').trim_matches('"').to_string();
        }
    }
    from_header.unwrap_or_default()
}

fn is_binary_section(section: &[u8]) -> bool {
    util::decode_lossy(section).lines().take_while(|line| !line.starts_with("@@")).any(|line| {
        (line.starts_with("Binary files ") && line.ends_with(" differ")) || line == "GIT binary patch"
    })
}

/// A section without content: only the header line, because Git considered the file changed due
/// to a new timestamp. `git apply` cannot do anything with it.
fn is_empty_section(section: &[u8]) -> bool {
    const MEANINGFUL: [&str; 9] = ["@@", "new file mode", "deleted file mode", "old mode", "new mode", "rename ", "copy ", "Binary files ", "GIT binary patch"];
    !util::decode_lossy(section).lines().skip(1).any(|line| MEANINGFUL.iter().any(|start| line.starts_with(start)))
}

/// Leaves out sections of binary files and those with invalid UTF-8.
fn text_only(patch: &[u8]) -> PatchText {
    let (head, sections) = split_sections(patch);
    let mut text = util::decode_lossy(head);
    let mut skipped = Vec::new();
    for section in sections {
        if is_empty_section(section) {
            continue;
        }
        match std::str::from_utf8(section) {
            Ok(valid) if !is_binary_section(section) => text.push_str(valid),
            _ => skipped.push(section_path(section)),
        }
    }
    PatchText { text, skipped }
}

/// The paths as arguments (`-- <path> …`); too many at once → `not_allowed`.
fn path_arguments(paths: &Option<Vec<String>>) -> CoreResult<Vec<String>> {
    let Some(paths) = paths else { return Ok(Vec::new()) };
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        let rel = normalize_rel_path(path)?;
        if !out.contains(&rel) {
            out.push(rel);
        }
    }
    if out.iter().map(|p| p.len() + 1).sum::<usize>() > MAX_PATH_ARGUMENT_CHARS {
        return Err(CoreError::not_allowed("That's too many individual files for one patch. Select fewer, or include all changes."));
    }
    Ok(out)
}

/// Creates a patch as text.
///
/// - `unstaged`: changes in the working directory against the index, with the untracked
///   (non-ignored) files as new files.
/// - `staged`: the index against HEAD.
/// - `commit`: the commit in the format of `git format-patch` (author, date, message; also for `git am`).
/// - `range`: the difference between two commits or up to the working directory (`to: None`,
///   without untracked files).
/// - `stash`: the stash against the commit it was created on, its untracked files as new files.
///
/// `paths: None` = everything. An empty patch (nothing changed) is not an error: `text` is then empty.
pub async fn patch_create(core: &Core, repo_id: String, source: DiffSource, paths: Option<Vec<String>>) -> CoreResult<PatchText> {
    let repo_id = repo_id.as_str();
    let wanted = path_arguments(&paths)?;
    if paths.is_some() && wanted.is_empty() {
        return Ok(PatchText { text: String::new(), skipped: Vec::new() });
    }
    let diff = |extra: &[&str]| -> CoreResult<GitCmd> { Ok(git(core, repo_id)?.read_only().no_log().args(["-c", "diff.autoRefreshIndex=false", "diff"]).args(DIFF_OPTIONS).args(extra)) };
    let out = match &source {
        DiffSource::Unstaged => {
            // `git diff` does not know untracked files. In a copy of the index they are marked as
            // "intent to add" – then the diff shows them as new files; the real index stays untouched.
            let temp = TempIndex::create(core)?;
            let real = status::git_dir(core, repo_id).await?.join("index");
            if real.is_file() {
                util::copy_index_file(&real, temp.path())?;
            }
            let mut add = git(core, repo_id)?.no_log().env("GIT_INDEX_FILE", temp.path()).args(["add", "-N", "--"]);
            add = if wanted.is_empty() { add.arg(".") } else { add.args(&wanted) };
            // A path that does not exist (any more) is not an error here: the diff shows deleted files anyway.
            add.run_raw().await?;
            // The copy may be refreshed: this drops files that only have a new timestamp.
            git(core, repo_id)?.no_log().env("GIT_INDEX_FILE", temp.path()).args(["update-index", "-q", "--refresh"]).run_raw().await?;
            diff(&[])?.env("GIT_INDEX_FILE", temp.path()).arg("--").args(&wanted).run().await?
        }
        DiffSource::Staged => diff(&["--cached"])?.arg("--").args(&wanted).run().await?,
        DiffSource::Commit { sha } => {
            let sha = check_sha(sha)?;
            git(core, repo_id)?
                .read_only()
                .no_log()
                .args(["format-patch", "-1", "--stdout", "--no-signature", "--no-stat", "--no-color", "--no-ext-diff", "--no-textconv", "--full-index", "-M"])
                .args(["--src-prefix=a/", "--dst-prefix=b/", sha])
                .arg("--")
                .args(&wanted)
                .run()
                .await
                .map_err(|e| unknown_commit(sha, e))?
        }
        DiffSource::Range { from, to } => {
            let mut cmd = diff(&[])?.arg(check_sha(from)?);
            if let Some(to) = to {
                cmd = cmd.arg(check_sha(to)?);
            }
            cmd.arg("--").args(&wanted).run().await.map_err(|e| unknown_commit(from, e))?
        }
        DiffSource::Stash { index } => {
            let missing = |e: CoreError| CoreError::not_found(format!("There is no stash number {index}.")).with_git_output(e.git_output.unwrap_or_default());
            let parents = git(core, repo_id)?.read_only().no_log().args(["rev-list", "--parents", "-n", "1"]).arg(format!("stash@{{{index}}}")).arg("--").run().await.map_err(missing)?;
            let shas: Vec<String> = parents.stdout_text().split_whitespace().map(str::to_string).collect();
            let (Some(stash), Some(base)) = (shas.first(), shas.get(1)) else {
                return Err(CoreError::not_found(format!("There is no stash number {index}.")));
            };
            let mut out = diff(&[])?.arg(base).arg(stash).arg("--").args(&wanted).run().await?;
            // Untracked files (`--include-untracked`) live in a separate third parent: new files.
            if let Some(untracked) = shas.get(3) {
                let new_files = diff(&[])?.arg(crate::commands::diff::empty_tree(stash)).arg(untracked).arg("--").args(&wanted).run().await?;
                out.stdout.extend_from_slice(&new_files.stdout);
            }
            out
        }
    };
    if out.stdout.len() > MAX_PATCH_BYTES {
        return Err(CoreError::not_allowed("The patch is larger than 32 MB. Select fewer files."));
    }
    Ok(text_only(&out.stdout))
}

fn unknown_commit(rev: &str, cause: CoreError) -> CoreError {
    if !matches!(cause.code, crate::error::ErrorCode::NotFound | crate::error::ErrorCode::Unknown) {
        return cause;
    }
    let mut error = CoreError::not_found(format!("The commit “{rev}” wasn't found."));
    error.git_output = cause.git_output;
    error
}

/// Turns the output of `git apply` into a sentence that says what the problem is.
fn apply_error(stderr: &str) -> CoreError {
    let mut reasons: Vec<String> = Vec::new();
    for line in stderr.lines() {
        let line = line.trim();
        let Some(rest) = line.strip_prefix("error: ") else { continue };
        let reason = if let Some(place) = rest.strip_prefix("patch failed: ") {
            match place.rsplit_once(':') {
                Some((file, line_no)) => format!("doesn't match “{file}” (from line {line_no})"),
                None => format!("doesn't match “{place}”"),
            }
        } else if let Some(file) = rest.strip_suffix(": No such file or directory") {
            format!("“{file}” doesn't exist in the working directory")
        } else if let Some(file) = rest.strip_suffix(": already exists in working directory") {
            format!("“{file}” already exists in the working directory")
        } else if let Some(file) = rest.strip_suffix(": does not exist in index") {
            format!("“{file}” doesn't exist in the repository")
        } else if rest.contains("corrupt patch") || rest.contains("No valid patches") || rest.contains("unrecognized input") {
            "the text isn't a valid patch".to_string()
        } else {
            // "<file>: patch does not apply" only repeats the line before it; anything else is in gitOutput.
            continue;
        };
        if !reasons.contains(&reason) {
            reasons.push(reason);
        }
    }
    let message = if reasons.is_empty() {
        "The patch can't be applied.".to_string()
    } else {
        let shown: Vec<String> = reasons.iter().take(5).cloned().collect();
        let more = if reasons.len() > shown.len() { format!(" and {} more places", reasons.len() - shown.len()) } else { String::new() };
        format!("The patch can't be applied: {}{more}.", shown.join("; "))
    };
    CoreError::not_allowed(message).with_git_output(stderr)
}

/// Applies a patch to the working directory (the index stays as it is; new files are untracked
/// afterwards). With `check_only` it only checks whether it could be applied – nothing changes.
/// A patch is applied completely or not at all.
///
/// Errors: `not_allowed` with a sentence naming the places (does not match file X from line N,
/// file missing, file already exists, not a valid patch); `locked`.
///
/// Before applying, the affected files are backed up: an undo entry `discard` ("Undo applying
/// the patch …") restores them and removes newly created ones.
pub async fn patch_apply(core: &Core, repo_id: String, text: String, check_only: bool) -> CoreResult<Status> {
    let repo_id = repo_id.as_str();
    if text.trim().is_empty() {
        return Err(CoreError::not_allowed("The patch is empty."));
    }
    if text.len() > MAX_PATCH_BYTES {
        return Err(CoreError::not_allowed("The patch is larger than 32 MB."));
    }
    let changes: &[RepoChange] = if check_only { &[] } else { &[RepoChange::Worktree] };
    core.with_write_lock(repo_id, changes, async {
        let apply = || -> CoreResult<GitCmd> {
            Ok(git(core, repo_id)?.args(["-c", "apply.whitespace=nowarn", "-c", "apply.ignoreWhitespace=no", "apply", "--whitespace=nowarn"]))
        };
        let failure = |out: &crate::git::GitOutput| {
            let classified = crate::git::errors::classify("apply", out.code, &out.stdout, &out.stderr);
            if classified.is(crate::error::ErrorCode::Locked) {
                classified
            } else {
                apply_error(&out.stderr_text())
            }
        };
        let text = text.into_bytes();
        // Check first: if the patch does not fit, neither a backup nor an undo entry is created.
        let checked = apply()?.arg("--check").read_only().no_log().stdin(text.clone()).run_raw().await?;
        if !checked.success() {
            return Err(failure(&checked));
        }
        if check_only {
            return read_status(core, repo_id).await;
        }
        let paths = touched_paths(core, repo_id, &text).await?;
        let head = crate::commands::refs::read_head(core, repo_id).await?;
        let backup = crate::commands::stage::Backup::create(core, repo_id, &head, Some(&paths)).await?;
        let out = match apply()?.stdin(text).run_raw().await {
            Ok(out) => out,
            Err(e) => {
                backup.forget(core, repo_id).await;
                return Err(e);
            }
        };
        if !out.success() {
            backup.forget(core, repo_id).await;
            return Err(failure(&out));
        }
        let label = match paths.as_slice() {
            [one] => format!("Undo applying the patch to ‘{}’", util::decode_lossy(one)),
            many => format!("Undo applying the patch ({} files)", many.len()),
        };
        let listed = paths.iter().map(|p| util::decode_lossy(p)).collect();
        backup.record(core, repo_id, &head, label, Some(listed)).await?;
        read_status(core, repo_id).await
    })
    .await
}

/// The paths the patch touches (for renames the old and the new name), as Git reads them:
/// `git apply --numstat -z` only evaluates and changes nothing.
async fn touched_paths(core: &Core, repo_id: &str, patch: &[u8]) -> CoreResult<Vec<Vec<u8>>> {
    let out = git(core, repo_id)?.args(["apply", "--numstat", "-z"]).read_only().no_log().stdin(patch.to_vec()).run_raw().await?;
    if !out.success() {
        return Err(apply_error(&out.stderr_text()));
    }
    let mut paths: Vec<Vec<u8>> = Vec::new();
    let mut add = |path: &[u8]| {
        if !path.is_empty() && !paths.iter().any(|known| known == path) {
            paths.push(path.to_vec());
        }
    };
    // "<plus>\t<minus>\t<path>" per file; for a rename the path is empty and the two following
    // entries name the old and the new name.
    let mut records = out.stdout_z().into_iter();
    while let Some(record) = records.next() {
        let path = record.splitn(3, |&b| b == b'\t').nth(2).unwrap_or_default();
        if path.is_empty() {
            for name in records.by_ref().take(2) {
                add(name);
            }
        } else {
            add(path);
        }
    }
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use crate::events::names;
    use crate::testkit::{TestCore, TestRepo};

    async fn open(repo: &TestRepo) -> (TestCore, String) {
        let tc = TestCore::new().await;
        let id = tc.open(repo).await.repo.id;
        (tc, id)
    }

    /// Two repositories with the same initial state: patches from one fit into the other.
    fn twins() -> (TestRepo, TestRepo) {
        let make = || {
            let repo = TestRepo::new();
            repo.write_file("a.txt", "eins\nzwei\ndrei\n");
            repo.write_file("ordner/b größe.txt", "b\n");
            repo.write_file("bild.bin", [0u8, 1, 2, 3]);
            repo.write_file("latin1.txt", b"Gr\xfc\xdfe\n");
            repo.commit("Ausgangsstand");
            repo
        };
        (make(), make())
    }

    #[test]
    fn sections_are_split_and_filtered() {
        let patch = b"From abc Mon Sep 17 00:00:00 2001\nSubject: [PATCH] Test\n\n---\ndiff --git a/a.txt b/a.txt\nindex 1..2 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-alt\n+neu\n\
diff --git a/bild.bin b/bild.bin\nindex 3..4 100644\nBinary files a/bild.bin and b/bild.bin differ\n\
diff --git a/alt name.txt b/neu name.txt\nsimilarity index 90%\nrename from alt name.txt\nrename to neu name.txt\n\
diff --git a/l.txt b/l.txt\n--- a/l.txt\n+++ b/l.txt\n@@ -1 +1 @@\n-Gr\xfc\xdfe\n+Gruesse\n";
        let (head, sections) = split_sections(patch);
        assert!(head.starts_with(b"From abc") && head.ends_with(b"---\n"));
        assert_eq!(sections.len(), 4);
        assert_eq!(sections.iter().map(|s| section_path(s)).collect::<Vec<_>>(), ["a.txt", "bild.bin", "neu name.txt", "l.txt"]);
        let filtered = text_only(patch);
        assert_eq!(filtered.skipped, ["bild.bin", "l.txt"]);
        assert!(filtered.text.contains("+neu") && filtered.text.contains("rename to neu name.txt") && filtered.text.starts_with("From abc"));
        assert!(!filtered.text.contains("Binary files") && !filtered.text.contains("Gruesse"));
        // A line "diff --git" in the middle of the content (with a prefix sign) is not a new section.
        let tricky = b"diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1,2 @@\n a\n+diff --git a/y b/y\n";
        assert_eq!(split_sections(tricky).1.len(), 1);
        // Only a new timestamp: the empty section is silently dropped; a new empty file stays.
        let stat_only = text_only(b"diff --git a/x b/x\ndiff --git a/leer b/leer\nnew file mode 100644\nindex 0000000..e69de29\n");
        assert_eq!((stat_only.text.as_str(), stat_only.skipped.len()), ("diff --git a/leer b/leer\nnew file mode 100644\nindex 0000000..e69de29\n", 0));
        assert_eq!(text_only(b"").text, "");
    }

    #[tokio::test]
    async fn worktree_patch_travels_to_another_repository() {
        let (source, target) = twins();
        source.write_file("a.txt", "eins\nZWEI\ndrei\nvier\n");
        source.write_file("ordner/b größe.txt", "b\ngeändert\n");
        source.write_file("neu/ganz neu.txt", "frisch\n");
        source.write_file("bild.bin", [9u8, 0, 9]);
        source.write_file("latin1.txt", b"Gr\xfc\xdfe ge\xe4ndert\n");
        source.write_file("leer.txt", "");
        source.remove_file("ordner/b größe.txt");
        source.write_file("ordner/b größe.txt", "b\ngeändert\n");
        let (tc, id) = open(&source).await;
        let index_before = std::fs::read(source.path().join(".git").join("index")).unwrap();

        let patch = patch_create(&tc, id.clone(), DiffSource::Unstaged, None).await.unwrap();
        assert_eq!(std::fs::read(source.path().join(".git").join("index")).unwrap(), index_before, "the index stays untouched");
        let mut skipped = patch.skipped.clone();
        skipped.sort();
        assert_eq!(skipped, ["bild.bin", "latin1.txt"]);
        assert!(patch.text.contains("+ZWEI") && patch.text.contains("new file mode") && patch.text.contains("+frisch"), "{}", patch.text);
        assert!(patch.text.contains("diff --git a/ordner/b größe.txt b/ordner/b größe.txt") || patch.text.contains("b gr"), "{}", patch.text);

        // In the other repository: check first (changes nothing), then apply.
        let target_id = tc.open(&target).await.repo.id;
        tc.events.clear();
        let checked = patch_apply(&tc, target_id.clone(), patch.text.clone(), true).await.unwrap();
        assert!(checked.unstaged.is_empty());
        assert_eq!(target.read_file("a.txt"), b"eins\nzwei\ndrei\n");
        assert_eq!(tc.events.count(names::REPO_CHANGED), 0);
        let status = patch_apply(&tc, target_id.clone(), patch.text.clone(), false).await.unwrap();
        assert_eq!(target.read_file("a.txt"), b"eins\nZWEI\ndrei\nvier\n");
        assert_eq!(target.read_file("ordner/b größe.txt"), "b\ngeändert\n".as_bytes());
        assert_eq!(target.read_file("neu/ganz neu.txt"), b"frisch\n");
        assert!(target.path().join("leer.txt").exists());
        assert_eq!(target.read_file("bild.bin"), [0u8, 1, 2, 3], "binary files are not in the patch");
        assert!(status.staged.is_empty(), "the index stays as it is");
        assert!(status.unstaged.iter().any(|f| f.path == "neu/ganz neu.txt"));
        assert_eq!(tc.events.named(names::REPO_CHANGED)[0]["what"], serde_json::json!(["worktree"]));

        // A second time it no longer fits – with an explanation, and nothing changes.
        let err = patch_apply(&tc, target_id.clone(), patch.text.clone(), false).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
        assert!(err.message.contains("The patch can't be applied") && (err.message.contains("a.txt") || err.message.contains("exist")), "{}", err.message);
        assert!(err.git_output.is_some());
        assert_eq!(patch_apply(&tc, target_id.clone(), patch.text.clone(), true).await.unwrap_err().code, ErrorCode::NotAllowed);

        // Exactly one undo step (checking and the failed attempt leave none): it restores the
        // changed files and removes the newly created ones – anything else in the working
        // directory stays.
        use crate::commands::undo::{redo, undo, undo_peek};
        let entries: i64 = tc.db.with(|c| Ok(c.query_row("select count(*) from undo_entries", [], |r| r.get(0))?)).unwrap();
        assert_eq!(entries, 1);
        let label = undo_peek(&tc, target_id.clone()).await.unwrap().undo.unwrap().label;
        assert!(label.starts_with("Undo applying the patch (") && label.ends_with("files)"), "{label}");
        target.write_file("daneben.txt", "bleibt\n");
        undo(&tc, target_id.clone()).await.unwrap();
        assert_eq!(target.read_file("a.txt"), b"eins\nzwei\ndrei\n");
        assert_eq!(target.read_file("ordner/b größe.txt"), b"b\n");
        assert!(!target.path().join("neu").exists() && !target.path().join("leer.txt").exists());
        assert_eq!(target.read_file("daneben.txt"), b"bleibt\n");
        redo(&tc, target_id.clone()).await.unwrap();
        assert_eq!(target.read_file("a.txt"), b"eins\nZWEI\ndrei\nvier\n");
        assert_eq!(target.read_file("neu/ganz neu.txt"), b"frisch\n");

        // Only selected paths.
        let only = patch_create(&tc, id.clone(), DiffSource::Unstaged, Some(vec!["neu/ganz neu.txt".into(), "ordner\\b größe.txt".replace('\\', if cfg!(windows) { "\\" } else { "/" })])).await.unwrap();
        assert!(only.text.contains("+frisch") && only.text.contains("+geändert") && !only.text.contains("ZWEI"), "{}", only.text);
        assert!(only.skipped.is_empty());
        let none = patch_create(&tc, id.clone(), DiffSource::Unstaged, Some(vec![])).await.unwrap();
        assert_eq!((none.text.as_str(), none.skipped.len()), ("", 0));
    }

    /// A stash with `--include-untracked`: its untracked files (third parent) are part of the
    /// patch as new files, also when only they are selected.
    #[tokio::test]
    async fn stash_patch_includes_the_untracked_files() {
        let (source, target) = twins();
        source.write_file("a.txt", "eins\nzwei\ndrei\nvier\n");
        source.write_file("notizen/neu.txt", "frisch notiert\n");
        source.git(&["stash", "push", "-q", "--include-untracked", "-m", "mit neuen"]);
        let (tc, id) = open(&source).await;
        let target_id = tc.open(&target).await.repo.id;

        let stash = patch_create(&tc, id.clone(), DiffSource::Stash { index: 0 }, None).await.unwrap();
        assert!(stash.text.contains("+vier") && stash.text.contains("new file mode") && stash.text.contains("+frisch notiert"), "{}", stash.text);
        patch_apply(&tc, target_id.clone(), stash.text.clone(), false).await.unwrap();
        assert_eq!(target.read_file("a.txt"), b"eins\nzwei\ndrei\nvier\n");
        assert_eq!(target.read_file("notizen/neu.txt"), b"frisch notiert\n");

        let only = patch_create(&tc, id.clone(), DiffSource::Stash { index: 0 }, Some(vec!["notizen/neu.txt".into()])).await.unwrap();
        assert!(only.text.contains("+frisch notiert") && !only.text.contains("+vier"), "{}", only.text);
        let tracked = patch_create(&tc, id.clone(), DiffSource::Stash { index: 0 }, Some(vec!["a.txt".into()])).await.unwrap();
        assert!(tracked.text.contains("+vier") && !tracked.text.contains("frisch"), "{}", tracked.text);
    }

    #[tokio::test]
    async fn staged_commit_range_and_stash_patches() {
        let (source, target) = twins();
        let base = source.head();
        source.write_file("a.txt", "eins\nzwei\ndrei\ngestaged\n");
        source.git(&["add", "a.txt"]);
        source.write_file("a.txt", "eins\nzwei\ndrei\ngestaged\nnur lokal\n");
        let (tc, id) = open(&source).await;
        let target_id = tc.open(&target).await.repo.id;

        let staged = patch_create(&tc, id.clone(), DiffSource::Staged, None).await.unwrap();
        assert!(staged.text.contains("+gestaged") && !staged.text.contains("nur lokal"));
        // Commit in format-patch format: author and message are included.
        source.git(&["commit", "-q", "-m", "Zeile ergänzt\n\nMit Beschreibung und Umlauten: äöü"]);
        let commit = source.head();
        let mail = patch_create(&tc, id.clone(), DiffSource::Commit { sha: commit.clone() }, None).await.unwrap();
        assert!(mail.text.starts_with("From ") && mail.text.contains("Subject: [PATCH] ") && mail.text.contains("+gestaged"), "{}", mail.text);
        assert!(mail.text.contains("From: Test Person <test@example.com>"));
        patch_apply(&tc, target_id.clone(), mail.text.clone(), false).await.unwrap();
        assert_eq!(target.read_file("a.txt"), b"eins\nzwei\ndrei\ngestaged\n");
        // `git am` takes the same text and creates the commit with author and message.
        target.git(&["checkout", "-q", "--", "a.txt"]);
        let file = target.temp_dir().join("commit.patch");
        std::fs::write(&file, &mail.text).unwrap();
        target.git(&["am", "-q", &file.to_string_lossy()]);
        assert_eq!(target.git(&["log", "-1", "--format=%s|%an"]), "Zeile ergänzt|Test Person");

        // Range between two commits and up to the working directory.
        let second = source.commit_file("ordner/b größe.txt", "b\nzweite\n", "Zweite Datei geändert");
        let range = patch_create(&tc, id.clone(), DiffSource::Range { from: base.clone(), to: Some(second.clone()) }, None).await.unwrap();
        assert!(range.text.contains("+gestaged") && range.text.contains("+zweite") && !range.text.starts_with("From "));
        let live = patch_create(&tc, id.clone(), DiffSource::Range { from: commit.clone(), to: None }, Some(vec!["a.txt".into()])).await.unwrap();
        assert!(live.text.contains("+nur lokal") && !live.text.contains("zweite"), "{}", live.text);

        // Stash.
        source.write_file("a.txt", "eins\nzwei\ndrei\ngestaged\nnur lokal\nfür den Stash\n");
        source.git(&["stash", "push", "-q", "-m", "lokal"]);
        let stash = patch_create(&tc, id.clone(), DiffSource::Stash { index: 0 }, None).await.unwrap();
        assert!(stash.text.contains("+für den Stash") && !stash.text.contains("+nur lokal"), "{}", stash.text);
        // Nothing changed: empty patch.
        assert_eq!(patch_create(&tc, id.clone(), DiffSource::Unstaged, None).await.unwrap().text, "");

        // Error cases.
        for source in [DiffSource::Commit { sha: "--output=x".into() }, DiffSource::Commit { sha: "0123456789abcdef0123456789abcdef01234567".into() }, DiffSource::Stash { index: 7 }] {
            assert_eq!(patch_create(&tc, id.clone(), source, None).await.unwrap_err().code, ErrorCode::NotFound);
        }
        assert_eq!(patch_create(&tc, id.clone(), DiffSource::Staged, Some(vec!["../draußen".into()])).await.unwrap_err().code, ErrorCode::NotAllowed);
        assert_eq!(patch_create(&tc, "unbekannt".into(), DiffSource::Staged, None).await.unwrap_err().code, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn apply_explains_what_does_not_fit() {
        let (source, _) = twins();
        let (tc, id) = open(&source).await;
        let apply = |text: &str, check: bool| patch_apply(&tc, id.clone(), text.to_string(), check);

        assert_eq!(apply("   \n", false).await.unwrap_err().code, ErrorCode::NotAllowed);
        let err = apply("das ist kein Patch\nnur Text\n", false).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
        assert!(err.message.contains("isn't a valid patch"), "{}", err.message);
        // Context does not match.
        let wrong = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n ganz\n-anders\n+neu\n hier\n";
        let err = apply(wrong, true).await.unwrap_err();
        assert!(err.message.contains("doesn't match “a.txt” (from line 1)"), "{}", err.message);
        // File missing or already exists.
        let missing = "diff --git a/fehlt.txt b/fehlt.txt\n--- a/fehlt.txt\n+++ b/fehlt.txt\n@@ -1 +1 @@\n-a\n+b\n";
        assert!(apply(missing, false).await.unwrap_err().message.contains("“fehlt.txt” doesn't exist in the working directory"));
        let exists = "diff --git a/a.txt b/a.txt\nnew file mode 100644\n--- /dev/null\n+++ b/a.txt\n@@ -0,0 +1 @@\n+x\n";
        assert!(apply(exists, false).await.unwrap_err().message.contains("“a.txt” already exists in the working directory"));
        // All or nothing: one matching and one non-matching section change nothing.
        let good = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,3 +1,3 @@\n eins\n-zwei\n+ZWEI\n drei\n";
        assert_eq!(apply(&format!("{good}{missing}"), false).await.unwrap_err().code, ErrorCode::NotAllowed);
        assert_eq!(source.read_file("a.txt"), b"eins\nzwei\ndrei\n");
        // The matching one alone works; the patch's line endings stay as they are.
        let status = apply(good, false).await.unwrap();
        assert_eq!(source.read_file("a.txt"), b"eins\nZWEI\ndrei\n");
        assert_eq!(status.unstaged.len(), 1);
        // A foreign index.lock does not disturb applying to the working directory (the index stays untouched).
        assert_eq!(apply("x", false).await.unwrap_err().code, ErrorCode::NotAllowed);
    }
}
