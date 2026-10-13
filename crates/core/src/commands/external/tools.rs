//! External diff tool and merge tool (`open_external` with `diff_tool` / `merge_tool`).
//!
//! Two ways:
//!
//! - **Command from the settings** (`externalDiffTool`, `externalMergeTool`): the core puts
//!   the versions as files into a separate folder under `<data dir>/tmp/tools/`
//!   and substitutes their paths into the template. Placeholders: `{local}` (old or own
//!   version), `{remote}` (new or incoming), `{base}` (common ancestor; for a diff
//!   equal to `{local}`), `{merged}` and `{path}` (the file in the working directory), `{repo}`.
//!   Without placeholders, `{local} {remote}` are appended for the diff tool, `{merged}` for
//!   the merge tool. The template is split by us as for the editor and never handed to a shell.
//! - **Without a setting**: `git difftool` or `git mergetool` with the user's Git
//!   configuration (`diff.tool`/`merge.tool`, otherwise `diff.guitool`/`merge.guitool`), without a
//!   prompt (`--no-prompt`). If nothing is configured there, `not_found` comes with an explanation –
//!   otherwise Git would guess and, if in doubt, start a terminal program nobody sees.
//!
//! The start is detached like editor and terminal; the app does not wait for the tool.
//! The file watcher notices what the tool writes.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use super::{arg_path, split_command_line, Launch, LaunchArg, Platform, PATH_PLACEHOLDER, REPO_PLACEHOLDER};
use crate::app::Core;
use crate::commands::diff::{self, EMPTY_TREE_SHA1, EMPTY_TREE_SHA256};
use crate::commands::history::normalize_rel_path;
use crate::error::{CoreError, CoreResult};
use crate::model::{DiffSource, ExternalTarget, Settings};
use crate::util;

pub const LOCAL_PLACEHOLDER: &str = "{local}";
pub const REMOTE_PLACEHOLDER: &str = "{remote}";
pub const BASE_PLACEHOLDER: &str = "{base}";
pub const MERGED_PLACEHOLDER: &str = "{merged}";

/// Subfolder of the data directory for the versions a tool gets to see.
pub const TOOLS_TMP_DIR: &str = "tools";
/// The versions are kept this long (the tool may stay open for a long time).
const STALE_AFTER: Duration = Duration::from_secs(24 * 3600);

/// The paths substituted into a template.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolFiles {
    pub local: String,
    pub remote: String,
    pub base: String,
    pub merged: String,
    pub repo: String,
}

/// Splits the template and substitutes the placeholders. If none of the file placeholders
/// occurs, `append` (placeholder names) are appended as further arguments.
pub fn expand_tool_template(template: &str, files: &ToolFiles, append: &[&str], platform: Platform) -> CoreResult<Vec<String>> {
    let parts = split_command_line(template, platform != Platform::Windows)?;
    if !parts.first().is_some_and(|p| !p.trim().is_empty()) {
        return Err(CoreError::not_allowed("The command in Settings is empty."));
    }
    let fill = |text: &str| {
        text.replace(LOCAL_PLACEHOLDER, &files.local)
            .replace(REMOTE_PLACEHOLDER, &files.remote)
            .replace(BASE_PLACEHOLDER, &files.base)
            .replace(MERGED_PLACEHOLDER, &files.merged)
            .replace(PATH_PLACEHOLDER, &files.merged)
            .replace(REPO_PLACEHOLDER, &files.repo)
    };
    let file_placeholders = [LOCAL_PLACEHOLDER, REMOTE_PLACEHOLDER, BASE_PLACEHOLDER, MERGED_PLACEHOLDER, PATH_PLACEHOLDER];
    let has_file = parts.iter().any(|p| file_placeholders.iter().any(|ph| p.contains(ph)));
    let mut args: Vec<String> = parts.iter().map(|p| fill(p)).collect();
    if !has_file {
        args.extend(append.iter().map(|ph| fill(ph)));
    }
    Ok(args)
}

fn launch_from(args: Vec<String>, cwd: &Path) -> Launch {
    let mut args = args;
    let program = args.remove(0);
    Launch { program, args: args.into_iter().map(LaunchArg::Plain).collect(), cwd: cwd.to_path_buf(), terminal: false, env: Vec::new() }
}

/// `git <args>` as a detached start, with the same Git environment as the Git runner
/// (in tests: the isolated configuration).
fn launch_git(core: &Core, args: Vec<String>, cwd: &Path) -> CoreResult<Launch> {
    let git = core.git.info()?;
    Ok(Launch {
        program: git.path.to_string_lossy().into_owned(),
        args: args.into_iter().map(LaunchArg::Plain).collect(),
        cwd: cwd.to_path_buf(),
        terminal: false,
        env: core.git.base_env(),
    })
}

/// Plans the start of the diff or merge tool for `path`.
pub(super) async fn plan_tool(
    core: &Core,
    repo_id: &str,
    target: ExternalTarget,
    path: Option<&str>,
    source: Option<DiffSource>,
    settings: &Settings,
) -> CoreResult<Launch> {
    let root = core.repo_path(repo_id)?;
    let what = if target == ExternalTarget::MergeTool { "merge tool" } else { "diff tool" };
    let Some(path) = path.filter(|p| !p.trim().is_empty()) else {
        return Err(CoreError::not_allowed(format!("A file is required for the {what}.")));
    };
    let rel = normalize_rel_path(path)?;
    match target {
        ExternalTarget::MergeTool => merge_tool(core, repo_id, &root, &rel, settings).await,
        _ => diff_tool(core, repo_id, &root, &rel, source.unwrap_or(DiffSource::Unstaged), settings).await,
    }
}

fn worktree_file(root: &Path, rel: &str) -> PathBuf {
    let mut full = root.to_path_buf();
    rel.split('/').for_each(|part| full.push(part));
    full
}

// ---------------------------------------------------------------------------
// Diff tool
// ---------------------------------------------------------------------------

async fn diff_tool(core: &Core, repo_id: &str, root: &Path, rel: &str, source: DiffSource, settings: &Settings) -> CoreResult<Launch> {
    let Some(template) = settings.external_diff_tool.as_deref().filter(|t| !t.trim().is_empty()) else {
        return git_difftool(core, repo_id, root, rel, &source).await;
    };
    let sides = diff::file_sides(core, repo_id, rel, &source).await?;
    let dir = new_tool_dir(core)?;
    let merged = worktree_file(root, rel);
    let old_name = sides.old_path.as_deref().unwrap_or(rel);
    let local = write_version(&dir, old_name, "LOCAL", sides.old.as_deref())?;
    // If the new side is the working directory, the tool gets the real file: changes
    // in it end up where the user expects them.
    let remote = if sides.new_is_worktree && merged.is_file() { merged.clone() } else { write_version(&dir, rel, "REMOTE", sides.new.as_deref())? };
    let files = ToolFiles { local: arg_path(&local), remote: arg_path(&remote), base: arg_path(&local), merged: arg_path(&merged), repo: arg_path(root) };
    let args = expand_tool_template(template, &files, &[LOCAL_PLACEHOLDER, REMOTE_PLACEHOLDER], Platform::current())?;
    Ok(launch_from(args, root))
}

/// Only SHAs (abbreviated too) – nothing Git could read as an option or expression.
fn check_sha(rev: &str) -> CoreResult<&str> {
    if (4..=64).contains(&rev.len()) && rev.bytes().all(|b| b.is_ascii_hexdigit()) {
        Ok(rev)
    } else {
        Err(CoreError::not_found(format!("The commit “{rev}” was not found.")))
    }
}

/// Whether Git itself knows a tool: (`tool` set, otherwise `guitool` set).
async fn configured_tool(core: &Core, repo_id: &str, section: &str) -> CoreResult<Option<bool>> {
    for (key, gui) in [("tool", false), ("guitool", true)] {
        let out = core.git_for(repo_id)?.args(["config", "--get", &format!("{section}.{key}")]).read_only().no_log().run_raw().await?;
        if out.success() && !out.stdout_text().trim().is_empty() {
            return Ok(Some(gui));
        }
    }
    Ok(None)
}

async fn git_difftool(core: &Core, repo_id: &str, root: &Path, rel: &str, source: &DiffSource) -> CoreResult<Launch> {
    let Some(gui) = configured_tool(core, repo_id, "diff").await? else {
        return Err(CoreError::not_found(
            "No diff tool is set up. Enter a command in Settings under “External programs” (e.g. “meld {local} {remote}”) or set “diff.tool” in Git.",
        ));
    };
    let mut args: Vec<String> = vec!["difftool".into(), "--no-prompt".into()];
    if gui {
        args.push("--gui".into());
    }
    match source {
        DiffSource::Unstaged => {}
        DiffSource::Staged => args.push("--cached".into()),
        DiffSource::Commit { sha } => {
            let sha = check_sha(sha)?;
            let parent = core.git_for(repo_id)?.args(["rev-parse", "--verify", "--quiet", &format!("{sha}^")]).read_only().no_log().run_raw().await?;
            let from = if parent.success() {
                parent.stdout_text()
            } else if sha.len() > 40 {
                EMPTY_TREE_SHA256.to_string()
            } else {
                EMPTY_TREE_SHA1.to_string()
            };
            args.extend([from, sha.to_string()]);
        }
        DiffSource::Range { from, to } => {
            args.push(check_sha(from)?.to_string());
            if let Some(to) = to {
                args.push(check_sha(to)?.to_string());
            }
        }
        DiffSource::Stash { index } => {
            args.extend([format!("stash@{{{index}}}^"), format!("stash@{{{index}}}")]);
        }
    }
    args.extend(["--".to_string(), rel.to_string()]);
    let mut launch = launch_git(core, args, root)?;
    launch.env.push(("GIT_LITERAL_PATHSPECS".into(), "1".into()));
    Ok(launch)
}

// ---------------------------------------------------------------------------
// Merge tool
// ---------------------------------------------------------------------------

/// Blob IDs of stages 1 to 3 of a conflicted file; empty if it has no conflict.
async fn conflict_stages(core: &Core, repo_id: &str, rel: &str) -> CoreResult<[Option<String>; 3]> {
    let out = core
        .git_for(repo_id)?
        .env("GIT_LITERAL_PATHSPECS", "1")
        .args(["ls-files", "--unmerged", "-z", "--", rel])
        .read_only()
        .no_log()
        .run()
        .await?;
    let mut stages: [Option<String>; 3] = [None, None, None];
    for record in util::split_z(&out.stdout) {
        // `<mode> <blob> <stage>TAB<path>`
        let Some(tab) = record.iter().position(|&b| b == b'\t') else { continue };
        if &record[tab + 1..] != rel.as_bytes() {
            continue;
        }
        let meta = util::decode_lossy(&record[..tab]);
        let mut fields = meta.split(' ');
        let (Some(_mode), Some(blob), Some(stage)) = (fields.next(), fields.next(), fields.next()) else { continue };
        if let Some(slot) = stage.parse::<usize>().ok().and_then(|n| n.checked_sub(1)).and_then(|i| stages.get_mut(i)) {
            *slot = Some(blob.to_string());
        }
    }
    Ok(stages)
}

async fn merge_tool(core: &Core, repo_id: &str, root: &Path, rel: &str, settings: &Settings) -> CoreResult<Launch> {
    let stages = conflict_stages(core, repo_id, rel).await?;
    if stages.iter().all(Option::is_none) {
        return Err(CoreError::not_found(format!("“{rel}” has no open conflict.")));
    }
    let merged = worktree_file(root, rel);
    let Some(template) = settings.external_merge_tool.as_deref().filter(|t| !t.trim().is_empty()) else {
        let Some(gui) = configured_tool(core, repo_id, "merge").await? else {
            return Err(CoreError::not_found(
                "No merge tool is set up. Enter a command in Settings under “External programs” (e.g. “meld {local} {merged} {remote}”) or set “merge.tool” in Git.",
            ));
        };
        let mut args: Vec<String> = vec!["mergetool".into(), "--no-prompt".into()];
        if gui {
            args.push("--gui".into());
        }
        args.extend(["--".to_string(), rel.to_string()]);
        let mut launch = launch_git(core, args, root)?;
        launch.env.push(("GIT_LITERAL_PATHSPECS".into(), "1".into()));
        return Ok(launch);
    };
    if !merged.is_file() {
        return Err(CoreError::not_allowed(format!(
            "“{rel}” does not exist in the working directory (deleted on one side). Resolve this conflict in the app by taking one side."
        )));
    }
    let dir = new_tool_dir(core)?;
    let mut written: Vec<PathBuf> = Vec::with_capacity(3);
    for (blob, label) in stages.iter().zip(["BASE", "LOCAL", "REMOTE"]) {
        let content = match blob {
            Some(id) => Some(core.git_for(repo_id)?.args(["cat-file", "blob", id.as_str()]).read_only().no_log().run().await?.stdout),
            // If a stage is missing (e.g. added on both sides), the tool gets an empty file.
            None => None,
        };
        written.push(write_version(&dir, rel, label, content.as_deref())?);
    }
    let files = ToolFiles {
        base: arg_path(&written[0]),
        local: arg_path(&written[1]),
        remote: arg_path(&written[2]),
        merged: arg_path(&merged),
        repo: arg_path(root),
    };
    let args = expand_tool_template(template, &files, &[MERGED_PLACEHOLDER], Platform::current())?;
    Ok(launch_from(args, root))
}

// ---------------------------------------------------------------------------
// Files for the tool
// ---------------------------------------------------------------------------

/// New folder for the versions of one call; also cleans up folders older than one day.
fn new_tool_dir(core: &Core) -> CoreResult<PathBuf> {
    let parent = core.data_dir().join("tmp").join(TOOLS_TMP_DIR);
    std::fs::create_dir_all(&parent)?;
    remove_stale(&parent, STALE_AFTER);
    let dir = parent.join(util::new_id());
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Removes subfolders older than `older_than`; returns their number.
pub(crate) fn remove_stale(parent: &Path, older_than: Duration) -> usize {
    let Ok(entries) = std::fs::read_dir(parent) else { return 0 };
    let now = SystemTime::now();
    let mut removed = 0;
    for entry in entries.flatten() {
        let age = entry.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| now.duration_since(t).ok());
        if age.is_some_and(|age| age >= older_than) && std::fs::remove_dir_all(entry.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Longest file name of a version (without label and extension).
const MAX_VERSION_STEM: usize = 80;
const MAX_VERSION_EXTENSION: usize = 16;

/// File name (stem, extension with dot) for a version. `rel` may be the old name of a
/// rename and then comes unchanged from a Git tree – on Windows names like
/// `x\..\..\raus.bat` are possible there. Only the last part after `/` and `\` is taken;
/// characters a file system reads as a separator, drive or wildcard are replaced.
fn version_name(rel: &str) -> (String, String) {
    let last = rel.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = last.chars().map(|c| if c.is_alphanumeric() || " ._-+()[]{},=@#%&!~$'".contains(c) { c } else { '_' }).collect();
    // Windows strips trailing dots and spaces; "." and ".." are not names
    // (a leading dot stays: `.gitignore`).
    let cleaned = cleaned.trim_end_matches([' ', '.']).trim_start_matches(' ');
    let (stem, extension) = match cleaned.rfind('.') {
        Some(dot) if dot > 0 && cleaned.len() - dot <= MAX_VERSION_EXTENSION => (&cleaned[..dot], &cleaned[dot..]),
        _ => (cleaned, ""),
    };
    let stem: String = stem.chars().take(MAX_VERSION_STEM).collect();
    (if stem.is_empty() { "datei".to_string() } else { stem }, extension.to_string())
}

/// Writes a version as `<name>_<LABEL>.<extension>`; the extension stays so that the tool
/// recognises the language. `None` (the side does not exist) gives an empty file. The file
/// always lives directly in `dir`.
fn write_version(dir: &Path, rel: &str, label: &str, content: Option<&[u8]>) -> CoreResult<PathBuf> {
    let (stem, extension) = version_name(rel);
    let name = format!("{stem}_{label}{extension}");
    let path = dir.join(&name);
    // Safety net below the net: the final path must be a single name in `dir`.
    if path.parent() != Some(dir) || !util::is_plain_relative(Path::new(&name)) || Path::new(&name).components().count() != 1 {
        return Err(CoreError::not_allowed(format!("The file name “{}” can't be used to store the file for the tool.", util::display_path(Path::new(rel)))));
    }
    std::fs::write(&path, content.unwrap_or_default())?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::external::{open_external, ExternalState};
    use crate::commands::merge::merge_start;
    use crate::commands::settings::settings_set;
    use crate::error::ErrorCode;
    use crate::model::{MergeMode, OpResult};
    use crate::testkit::{TestCore, TestRepo};
    use serde_json::json;

    /// The old name of a rename comes from Git and can be `x\..\..\raus.bat` on
    /// Windows – the version must still end up in the temp folder.
    #[test]
    fn sec03_versions_are_always_written_inside_the_tool_folder() {
        let parent = tempfile::tempdir().unwrap();
        let dir = parent.path().join("tools").join("lauf");
        std::fs::create_dir_all(&dir).unwrap();
        for hostile in ["x\\..\\..\\raus.bat", "a/b\\..\\..\\..\\raus.cmd", "..\\..\\raus.exe", "C:\\Windows\\raus.bat", "..", ".", "sub/..", "con", "a:b.txt", "NUL.txt"] {
            let written = write_version(&dir, hostile, "LOCAL", Some(b"inhalt")).unwrap();
            assert_eq!(written.parent(), Some(dir.as_path()), "{hostile} → {}", written.display());
            let name = written.file_name().unwrap().to_string_lossy().into_owned();
            assert!(!name.contains(['\\', '/', ':']) && name.contains("_LOCAL"), "{hostile} → {name}");
            assert!(written.is_file(), "{hostile}: {}", written.display());
        }
        // Nothing was created outside the folder.
        let strays: Vec<_> = walk(parent.path()).into_iter().filter(|p| p.is_file() && p.parent() != Some(dir.as_path())).collect();
        assert!(strays.is_empty(), "{strays:?}");
        // Ordinary names stay readable (the tool recognises the language by the extension).
        let plain = write_version(&dir, "src/Größe.rs", "REMOTE", None).unwrap();
        assert_eq!(plain.file_name().unwrap().to_string_lossy(), "Größe_REMOTE.rs");
    }

    fn walk(root: &Path) -> Vec<PathBuf> {
        let mut all = Vec::new();
        let mut open = vec![root.to_path_buf()];
        while let Some(dir) = open.pop() {
            for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    open.push(path.clone());
                }
                all.push(path);
            }
        }
        all
    }

    fn files() -> ToolFiles {
        ToolFiles { local: "/t/a_LOCAL.txt".into(), remote: "/r/mit leer/a.txt".into(), base: "/t/a_BASE.txt".into(), merged: "/r/mit leer/a.txt".into(), repo: "/r/mit leer".into() }
    }

    #[test]
    fn tool_templates_are_filled_after_splitting() {
        let f = files();
        let args = expand_tool_template("meld --diff {local} {remote} --output={merged}", &f, &[LOCAL_PLACEHOLDER], Platform::Linux).unwrap();
        assert_eq!(args, ["meld", "--diff", "/t/a_LOCAL.txt", "/r/mit leer/a.txt", "--output=/r/mit leer/a.txt"]);
        let args = expand_tool_template("'kdiff3' {base} {local} {remote} -o {merged} --cs {repo}", &f, &[], Platform::Linux).unwrap();
        assert_eq!(args, ["kdiff3", "/t/a_BASE.txt", "/t/a_LOCAL.txt", "/r/mit leer/a.txt", "-o", "/r/mit leer/a.txt", "--cs", "/r/mit leer"]);
        // Without placeholders, arguments are appended; {path} counts as a placeholder (the file in the working directory).
        let args = expand_tool_template("bcompare", &f, &[LOCAL_PLACEHOLDER, REMOTE_PLACEHOLDER], Platform::Linux).unwrap();
        assert_eq!(args, ["bcompare", "/t/a_LOCAL.txt", "/r/mit leer/a.txt"]);
        let args = expand_tool_template("code --wait {path}", &f, &[LOCAL_PLACEHOLDER, REMOTE_PLACEHOLDER], Platform::Linux).unwrap();
        assert_eq!(args, ["code", "--wait", "/r/mit leer/a.txt"]);
        // Shell characters have no meaning.
        let args = expand_tool_template("tool {local}; rm -rf ~", &f, &[], Platform::Linux).unwrap();
        assert_eq!(args, ["tool", "/t/a_LOCAL.txt;", "rm", "-rf", "~"]);
        for bad in ["", "  ", "tool \"offen {local}"] {
            assert_eq!(expand_tool_template(bad, &f, &[], Platform::Linux).unwrap_err().code, ErrorCode::NotAllowed, "{bad:?}");
        }
    }

    #[test]
    fn versions_keep_their_extension() {
        let dir = tempfile::tempdir().unwrap();
        let p = write_version(dir.path(), "src/Größe 1.test.rs", "LOCAL", Some(b"x")).unwrap();
        assert_eq!(p.file_name().unwrap().to_string_lossy(), "Größe 1.test_LOCAL.rs");
        assert_eq!(std::fs::read(&p).unwrap(), b"x");
        let p = write_version(dir.path(), "Makefile", "BASE", None).unwrap();
        assert_eq!(p.file_name().unwrap().to_string_lossy(), "Makefile_BASE");
        assert_eq!(std::fs::read(&p).unwrap(), b"");
        let p = write_version(dir.path(), ".gitignore", "REMOTE", Some(b"")).unwrap();
        assert_eq!(p.file_name().unwrap().to_string_lossy(), ".gitignore_REMOTE");
        // Clean-up by age.
        assert_eq!(remove_stale(dir.path(), Duration::from_secs(3600)), 0);
        std::fs::create_dir_all(dir.path().join("alt")).unwrap();
        assert_eq!(remove_stale(dir.path(), Duration::ZERO), 1);
    }

    async fn setup(repo: &TestRepo) -> (TestCore, String) {
        let tc = TestCore::new().await;
        let id = tc.open(repo).await.repo.id;
        tc.state::<ExternalState>().set_dry_run(true);
        (tc, id)
    }

    fn read(path: &str) -> String {
        String::from_utf8(std::fs::read(path).unwrap_or_else(|e| panic!("{path}: {e}"))).unwrap()
    }

    #[tokio::test]
    async fn diff_tool_from_the_settings_gets_both_versions() {
        let repo = TestRepo::new();
        let first = repo.commit_file("src/a b.txt", "eins\n", "Erster");
        let second = repo.commit_file("src/a b.txt", "eins\nzwei\n", "Zweiter");
        repo.write_file("src/a b.txt", "eins\nzwei\ngestaged\n");
        repo.git(&["add", "-A"]);
        repo.write_file("src/a b.txt", "eins\nzwei\ngestaged\nlokal\n");
        repo.write_file("neu.txt", "unverfolgt\n");
        let (tc, id) = setup(&repo).await;
        let state = tc.state::<ExternalState>();
        let root = tc.repo_path(&id).unwrap();
        let worktree = arg_path(&root.join("src").join("a b.txt"));
        settings_set(&tc, json!({ "externalDiffTool": "mein-diff --links {local} --rechts {remote} --repo {repo}" })).await.unwrap();
        let open = |source: Option<DiffSource>| open_external(&tc, id.clone(), ExternalTarget::DiffTool, Some("src/a b.txt".into()), source);

        // Without a source: unstaged changes; on the right is the real file.
        open(None).await.unwrap();
        open(Some(DiffSource::Staged)).await.unwrap();
        open(Some(DiffSource::Commit { sha: second.clone() })).await.unwrap();
        open(Some(DiffSource::Commit { sha: first.clone() })).await.unwrap();
        open(Some(DiffSource::Range { from: first.clone(), to: Some(second.clone()) })).await.unwrap();
        open(Some(DiffSource::Range { from: first.clone(), to: None })).await.unwrap();
        let launched = state.take_launched();
        assert_eq!(launched.len(), 6);
        let sides = |i: usize| {
            let args = launched[i].arg_strings();
            assert_eq!((launched[i].program.as_str(), args[0], args[2], args[4]), ("mein-diff", "--links", "--rechts", "--repo"));
            assert_eq!(args[5], arg_path(&root));
            (args[1].to_string(), args[3].to_string())
        };
        let (local, remote) = sides(0);
        assert_eq!(read(&local), "eins\nzwei\ngestaged\n");
        assert_eq!(remote, worktree);
        assert!(local.ends_with("a b_LOCAL.txt"), "{local}");
        assert!(local.contains(&arg_path(tc.data_dir())), "the version lives in the data directory, not in the repository: {local}");
        let (local, remote) = sides(1);
        assert_eq!((read(&local).as_str(), read(&remote).as_str()), ("eins\nzwei\n", "eins\nzwei\ngestaged\n"));
        assert!(remote.ends_with("a b_REMOTE.txt"), "{remote}");
        let (local, remote) = sides(2);
        assert_eq!((read(&local).as_str(), read(&remote).as_str()), ("eins\n", "eins\nzwei\n"));
        // Root commit: an empty file on the left.
        let (local, remote) = sides(3);
        assert_eq!((read(&local).as_str(), read(&remote).as_str()), ("", "eins\n"));
        let (local, remote) = sides(4);
        assert_eq!((read(&local).as_str(), read(&remote).as_str()), ("eins\n", "eins\nzwei\n"));
        let (local, remote) = sides(5);
        assert_eq!(read(&local), "eins\n");
        assert_eq!(remote, worktree);

        // Untracked file: empty on the left, the file itself on the right.
        open_external(&tc, id.clone(), ExternalTarget::DiffTool, Some("neu.txt".into()), None).await.unwrap();
        let launched = state.take_launched();
        assert_eq!(read(launched[0].arg_strings()[1]), "");
        assert_eq!(launched[0].arg_strings()[3], arg_path(&root.join("neu.txt")));

        // Template without placeholders: both sides are appended.
        settings_set(&tc, json!({ "externalDiffTool": "bcompare" })).await.unwrap();
        open(Some(DiffSource::Staged)).await.unwrap();
        let launched = state.take_launched();
        assert_eq!(launched[0].args.len(), 2);

        // Error cases: nothing is started.
        for (path, source, code) in [
            (None, None, ErrorCode::NotAllowed),
            (Some("../draußen.txt"), None, ErrorCode::NotAllowed),
            (Some("gibt-es-nicht.txt"), None, ErrorCode::NotFound),
            (Some("src/a b.txt"), Some(DiffSource::Commit { sha: "--output=x".into() }), ErrorCode::NotFound),
        ] {
            let err = open_external(&tc, id.clone(), ExternalTarget::DiffTool, path.map(str::to_string), source).await.unwrap_err();
            assert_eq!(err.code, code, "{path:?}");
        }
        assert!(state.take_launched().is_empty());
    }

    #[tokio::test]
    async fn diff_tool_without_settings_uses_git_difftool() {
        let repo = TestRepo::new();
        let first = repo.commit_file("a.txt", "eins\n", "Erster");
        let second = repo.commit_file("a.txt", "zwei\n", "Zweiter");
        repo.write_file("a.txt", "lokal\n");
        let (tc, id) = setup(&repo).await;
        let state = tc.state::<ExternalState>();
        let open = |source: Option<DiffSource>| open_external(&tc, id.clone(), ExternalTarget::DiffTool, Some("a.txt".into()), source);

        // Nothing configured: an explanation instead of a program nobody sees.
        let err = open(None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        assert!(err.message.contains("diff.tool") && err.message.contains("Settings"), "{}", err.message);

        repo.git(&["config", "diff.tool", "meld"]);
        open(None).await.unwrap();
        open(Some(DiffSource::Staged)).await.unwrap();
        open(Some(DiffSource::Commit { sha: second.clone() })).await.unwrap();
        open(Some(DiffSource::Commit { sha: first.clone() })).await.unwrap();
        open(Some(DiffSource::Range { from: first.clone(), to: None })).await.unwrap();
        open(Some(DiffSource::Stash { index: 2 })).await.unwrap();
        let launched = state.take_launched();
        let git = tc.git.info().unwrap().path.to_string_lossy().into_owned();
        assert!(launched.iter().all(|l| l.program == git && !l.terminal));
        assert_eq!(launched[0].arg_strings(), ["difftool", "--no-prompt", "--", "a.txt"]);
        assert_eq!(launched[1].arg_strings(), ["difftool", "--no-prompt", "--cached", "--", "a.txt"]);
        assert_eq!(launched[2].arg_strings(), ["difftool", "--no-prompt", first.as_str(), second.as_str(), "--", "a.txt"]);
        assert_eq!(launched[3].arg_strings(), ["difftool", "--no-prompt", EMPTY_TREE_SHA1, first.as_str(), "--", "a.txt"]);
        assert_eq!(launched[4].arg_strings(), ["difftool", "--no-prompt", first.as_str(), "--", "a.txt"]);
        assert_eq!(launched[5].arg_strings(), ["difftool", "--no-prompt", "stash@{2}^", "stash@{2}", "--", "a.txt"]);
        // The core's Git environment applies here too (in tests: the isolated configuration).
        assert!(launched[0].env.iter().any(|(k, _)| k == "GIT_CONFIG_GLOBAL"));

        // Only a graphical tool configured.
        repo.git(&["config", "--unset", "diff.tool"]);
        repo.git(&["config", "diff.guitool", "kdiff3"]);
        open(None).await.unwrap();
        assert_eq!(state.take_launched()[0].arg_strings(), ["difftool", "--no-prompt", "--gui", "--", "a.txt"]);
    }

    fn conflict_repo() -> TestRepo {
        let repo = TestRepo::new();
        repo.commit_file("a.txt", "basis\n", "Basis");
        repo.checkout_new("feature");
        repo.commit_file("a.txt", "feature\n", "Feature");
        repo.commit_file("nur-dort.txt", "x\n", "Nur dort");
        repo.checkout("main");
        repo.commit_file("a.txt", "main\n", "Main");
        repo
    }

    #[tokio::test]
    async fn merge_tool_gets_base_local_remote_and_the_file() {
        let repo = conflict_repo();
        let (tc, id) = setup(&repo).await;
        let state = tc.state::<ExternalState>();
        assert!(matches!(merge_start(&tc, id.clone(), "feature".into(), MergeMode::Default).await.unwrap(), OpResult::Conflict { .. }));
        let root = tc.repo_path(&id).unwrap();
        let open = |path: &str| open_external(&tc, id.clone(), ExternalTarget::MergeTool, Some(path.to_string()), None);

        // No setting and no merge.tool: explanation.
        let err = open("a.txt").await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        assert!(err.message.contains("merge.tool"), "{}", err.message);
        repo.git(&["config", "merge.tool", "meld"]);
        open("a.txt").await.unwrap();
        let launched = state.take_launched();
        assert_eq!(launched[0].program, tc.git.info().unwrap().path.to_string_lossy());
        assert_eq!(launched[0].arg_strings(), ["mergetool", "--no-prompt", "--", "a.txt"]);

        settings_set(&tc, json!({ "externalMergeTool": "mein-merge {base} {local} {remote} -o {merged}" })).await.unwrap();
        open("a.txt").await.unwrap();
        let launched = state.take_launched();
        let args = launched[0].arg_strings();
        assert_eq!((launched[0].program.as_str(), args.len(), args[3]), ("mein-merge", 5, "-o"));
        assert_eq!((read(args[0]).as_str(), read(args[1]).as_str(), read(args[2]).as_str()), ("basis\n", "main\n", "feature\n"));
        assert_eq!(args[4], arg_path(&root.join("a.txt")));
        assert!(read(args[4]).contains("<<<<<<<"));
        assert!(args[0].ends_with("a_BASE.txt") && args[1].ends_with("a_LOCAL.txt") && args[2].ends_with("a_REMOTE.txt"));
        // Without placeholders: the file with the conflict markers.
        settings_set(&tc, json!({ "externalMergeTool": "code --wait" })).await.unwrap();
        open("a.txt").await.unwrap();
        assert_eq!(state.take_launched()[0].arg_strings(), ["--wait", arg_path(&root.join("a.txt")).as_str()]);

        // Not a conflicted file, or no file given.
        assert_eq!(open("nur-dort.txt").await.unwrap_err().code, ErrorCode::NotFound);
        assert_eq!(open("fehlt.txt").await.unwrap_err().code, ErrorCode::NotFound);
        let err = open_external(&tc, id.clone(), ExternalTarget::MergeTool, None, None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
        assert!(state.take_launched().is_empty());
    }

    /// Really start a harmless program: Git compares the two versions and
    /// writes the result into a file.
    #[tokio::test]
    async fn the_diff_tool_is_really_started_with_both_files() {
        let repo = TestRepo::new();
        repo.commit_file("a.txt", "eins\n", "Erster");
        repo.write_file("a.txt", "eins\nneu im Arbeitsverzeichnis\n");
        let tc = TestCore::new().await;
        let id = tc.open(&repo).await.repo.id;
        let out = tempfile::tempdir().unwrap();
        let result = out.path().join("ergebnis.patch");
        let template = format!("git diff --no-index \"--output={}\" {{local}} {{remote}}", arg_path(&result));
        settings_set(&tc, json!({ "externalDiffTool": template })).await.unwrap();
        open_external(&tc, id.clone(), ExternalTarget::DiffTool, Some("a.txt".into()), None).await.unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while std::fs::read_to_string(&result).map(|t| !t.contains("+neu im Arbeitsverzeichnis")).unwrap_or(true) && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let patch = std::fs::read_to_string(&result).unwrap_or_default();
        assert!(patch.contains("+neu im Arbeitsverzeichnis") && patch.contains("a_LOCAL.txt"), "{patch}");
    }
}
