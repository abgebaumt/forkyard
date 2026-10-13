//! Refs: branches, remote branches, tags, HEAD.
//!
//! Reusable by other commands: `read_refs`, `read_head`, `parse_for_each_ref`.

use std::path::Path;

use crate::app::Core;
use crate::error::{CoreError, CoreResult};
use crate::git::GitCmd;
use crate::model::{Head, Ref, RefKind, RefsSnapshot};
use crate::util;

/// Fields per ref, each terminated by NUL. The tag message is only included for annotated
/// tags; otherwise every branch would bring along the whole commit message.
const FORMAT: &str = "--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(HEAD)%00%(upstream)%00%(upstream:track)%00%(worktreepath)%00%(symref)%00%(if:equals=tag)%(objecttype)%(then)%(contents)%(end)%00";
const FIELDS: usize = 10;

/// Local and remote branches, tags, HEAD, upstream, ahead/behind (`git for-each-ref`).
pub async fn refs_list(core: &Core, repo_id: String) -> CoreResult<RefsSnapshot> {
    read_refs(core, &repo_id).await
}

/// Reads all refs and HEAD. Pure read command, takes no lock and does not log.
pub async fn read_refs(core: &Core, repo_id: &str) -> CoreResult<RefsSnapshot> {
    let path = core.repo_path(repo_id)?;
    let options = [FORMAT.to_string()];
    let (refs, remotes) = tokio::join!(
        for_each_ref(core, &path, repo_id, &options, &["refs/heads", "refs/remotes", "refs/tags"]),
        read_cmd(core, &path, repo_id).arg("remote").run_raw(),
    );
    let refs = refs?;
    let remote_names: Vec<String> = match &remotes {
        Ok(out) if out.success() => out.stdout_lines().into_iter().map(util::decode_lossy).filter(|n| !n.is_empty()).collect(),
        _ => Vec::new(),
    };
    let parsed = parse_for_each_ref(&refs.stdout, &remote_names, &path);
    let head = match parsed.locals.iter().find(|r| r.is_head) {
        Some(current) => Head::Branch { branch: current.name.clone(), sha: current.sha.clone() },
        // Detached or without a commit: for-each-ref does not tell us that.
        None => head_at(core, &path, repo_id).await?,
    };
    Ok(RefsSnapshot { head, locals: parsed.locals, remotes: parsed.remotes, tags: parsed.tags })
}

/// HEAD alone: branch, detached or without a commit.
pub async fn read_head(core: &Core, repo_id: &str) -> CoreResult<Head> {
    let path = core.repo_path(repo_id)?;
    head_at(core, &path, repo_id).await
}

/// `git for-each-ref <options> <patterns>` that does not fail completely because of a single
/// damaged ref: if a ref points to a missing object, Git aborts with "missing object" – then the
/// call runs again without the damaged refs (previously one broken ref emptied the whole list).
pub(crate) async fn for_each_ref(core: &Core, path: &Path, repo_id: &str, options: &[String], patterns: &[&str]) -> CoreResult<crate::git::GitOutput> {
    let run = |broken: Vec<String>, watched: bool| {
        let cmd = read_cmd(core, path, repo_id).arg("for-each-ref").args(options).args(broken.into_iter().map(|name| format!("--exclude={name}"))).args(patterns);
        if watched { cmd.idle_timeout(HANG_GUARD) } else { cmd }.run_raw()
    };
    // Git for Windows (seen with 2.54) no longer exits after "fatal: missing object" with the full
    // format of `refs_list`: the process silently stalls, and the branch list would load forever.
    // That is why the first run has a limit on silence; after it, things continue as after the
    // error message itself.
    let first = match run(Vec::new(), true).await {
        Ok(out) if out.success() => return Ok(out),
        Ok(out) => Some(out),
        Err(e) if e.is(crate::error::ErrorCode::Timeout) => None,
        Err(e) => return Err(e),
    };
    // No result (the call hung) or the message "missing object".
    let suspicious = match &first {
        Some(out) => out.stderr_text().to_lowercase().contains("missing object"),
        None => true,
    };
    if suspicious {
        let broken = broken_refs(core, path, repo_id).await;
        if !broken.is_empty() {
            log::warn!("Skipping damaged refs: {}", broken.join(", "));
            let retry = run(broken, false).await?;
            if retry.success() {
                return Ok(retry);
            }
        } else if first.is_none() {
            // No damaged ref: Git was just silent for a long time (very large repository). Again without a limit.
            let again = run(Vec::new(), false).await?;
            if again.success() {
                return Ok(again);
            }
            return Err(crate::git::errors::classify("for-each-ref", again.code, &again.stdout, &again.stderr));
        }
    }
    match first {
        Some(out) => Err(crate::git::errors::classify("for-each-ref", out.code, &out.stdout, &out.stderr)),
        None => Err(CoreError::timeout()),
    }
}

/// How long `git for-each-ref` may stay silent before the call is considered hung.
const HANG_GUARD: std::time::Duration = std::time::Duration::from_secs(3);

/// Refs that make Git commands fail: the ref file is empty or contains garbage ("broken ref"),
/// or it points to an object that does not exist. Full ref names.
pub(crate) async fn broken_refs(core: &Core, path: &Path, repo_id: &str) -> Vec<String> {
    let Ok(listed) = read_cmd(core, path, repo_id).args(["for-each-ref", "--format=%(refname) %(objectname)"]).run_raw().await else {
        return Vec::new();
    };
    let mut broken: Vec<String> = listed
        .stderr_text()
        .lines()
        .filter_map(|line| line.trim().strip_prefix("warning: ignoring broken ref ").map(|name| name.trim().to_string()))
        .filter(|name| name.starts_with("refs/"))
        .collect();
    let pairs: Vec<(String, String)> = listed
        .stdout_text()
        .lines()
        .filter_map(|line| line.rsplit_once(' ').map(|(name, sha)| (name.to_string(), sha.to_string())))
        .collect();
    if !pairs.is_empty() {
        let stdin: String = pairs.iter().map(|(_, sha)| format!("{sha}\n")).collect();
        if let Ok(checked) = read_cmd(core, path, repo_id).args(["cat-file", "--batch-check"]).stdin(stdin).run_raw().await {
            for ((name, _), answer) in pairs.iter().zip(checked.stdout_text().lines()) {
                if answer.trim_end().ends_with(" missing") && !broken.contains(name) {
                    broken.push(name.clone());
                }
            }
        }
    }
    broken
}

fn read_cmd(core: &Core, path: &Path, repo_id: &str) -> GitCmd {
    core.git.cmd(path).repo(repo_id).read_only().no_log()
}

async fn head_at(core: &Core, path: &Path, repo_id: &str) -> CoreResult<Head> {
    let (symref, commit) = tokio::join!(
        read_cmd(core, path, repo_id).args(["symbolic-ref", "-q", "HEAD"]).run_raw(),
        read_cmd(core, path, repo_id).args(["rev-parse", "-q", "--verify", "HEAD^{commit}"]).run_raw(),
    );
    let (symref, commit) = (symref?, commit?);
    let branch = if symref.success() {
        let full = symref.stdout_text();
        Some(full.strip_prefix("refs/heads/").unwrap_or(&full).to_string()).filter(|b| !b.is_empty())
    } else {
        None
    };
    let sha = if commit.success() { Some(commit.stdout_text()).filter(|s| !s.is_empty()) } else { None };
    match (branch, sha) {
        (Some(branch), Some(sha)) => Ok(Head::Branch { branch, sha }),
        (None, Some(sha)) => Ok(Head::Detached { sha }),
        (Some(branch), None) => Ok(Head::Unborn { branch }),
        (None, None) => {
            // Neither branch nor commit: not a repository, or HEAD is broken.
            let err = crate::git::errors::classify("rev-parse", commit.code, &symref.stderr, &commit.stderr);
            if err.is(crate::error::ErrorCode::Unknown) {
                Err(CoreError::unknown("Could not read the repository's HEAD.").with_git_output(commit.stderr_text()))
            } else {
                Err(err)
            }
        }
    }
}

/// Result of `parse_for_each_ref`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ParsedRefs {
    pub locals: Vec<Ref>,
    pub remotes: Vec<Ref>,
    pub tags: Vec<Ref>,
}

/// Parses the output of `git for-each-ref` with `FORMAT`.
/// `remote_names`: names of the remotes (for remotes with `/` in the name); `worktree`: our own
/// working directory, so that `worktree_path` only names other worktrees.
pub fn parse_for_each_ref(stdout: &[u8], remote_names: &[String], worktree: &Path) -> ParsedRefs {
    let own_worktree = util::path_key(worktree);
    let fields: Vec<&[u8]> = stdout.split(|&b| b == 0).collect();
    let mut raw = Vec::new();
    for chunk in fields.chunks(FIELDS) {
        if chunk.len() < FIELDS {
            break;
        }
        // Git ends every record with a newline; it sticks to the first field of the next one.
        let full_name = util::decode_lossy(chunk[0].strip_prefix(b"\n").unwrap_or(chunk[0]));
        raw.push((full_name, chunk));
    }
    let known: std::collections::HashSet<&str> = raw.iter().map(|(name, _)| name.as_str()).collect();

    let mut out = ParsedRefs::default();
    for (full_name, f) in &raw {
        let text = |i: usize| util::decode_lossy(f[i]);
        let (kind, name) = if let Some(n) = full_name.strip_prefix("refs/heads/") {
            (RefKind::Local, n)
        } else if let Some(n) = full_name.strip_prefix("refs/remotes/") {
            (RefKind::Remote, n)
        } else if let Some(n) = full_name.strip_prefix("refs/tags/") {
            (RefKind::Tag, n)
        } else {
            continue;
        };
        // origin/HEAD is only a pointer to the remote's default branch.
        if kind == RefKind::Remote && !f[8].is_empty() {
            continue;
        }
        let is_annotated = kind == RefKind::Tag && f[2] == b"tag";
        let peeled = text(3);
        let sha = if is_annotated && !peeled.is_empty() { peeled } else { text(1) };
        let is_head = kind == RefKind::Local && f[4] == b"*";

        let upstream_full = if kind == RefKind::Local { text(5) } else { String::new() };
        let upstream = (!upstream_full.is_empty()).then(|| short_ref_name(&upstream_full).to_string());
        let track = text(6);
        let upstream_gone = upstream.is_some() && (track.contains("gone") || !known.contains(upstream_full.as_str()));
        let (ahead, behind) = if upstream.is_some() && !upstream_gone { parse_track(&track) } else { (0, 0) };

        let worktree_raw = f[7];
        let worktree_path = (kind == RefKind::Local && !is_head && !worktree_raw.is_empty())
            .then(|| util::bytes_to_path(worktree_raw))
            .filter(|p| util::path_key(p) != own_worktree)
            .map(|p| util::display_path(&p));

        let item = Ref {
            name: name.to_string(),
            full_name: full_name.clone(),
            kind,
            sha,
            is_head,
            upstream,
            upstream_gone,
            ahead,
            behind,
            remote: (kind == RefKind::Remote).then(|| remote_of(name, remote_names)),
            annotation: is_annotated.then(|| clean_annotation(&text(9))),
            is_annotated,
            worktree_path,
        };
        match kind {
            RefKind::Local => out.locals.push(item),
            RefKind::Remote => out.remotes.push(item),
            RefKind::Tag => out.tags.push(item),
        }
    }
    out
}

/// `refs/remotes/origin/main` → `origin/main`, `refs/heads/main` → `main`.
pub fn short_ref_name(full: &str) -> &str {
    for prefix in ["refs/heads/", "refs/remotes/", "refs/tags/"] {
        if let Some(rest) = full.strip_prefix(prefix) {
            return rest;
        }
    }
    full
}

/// Numbers from `%(upstream:track)`: `[ahead 2, behind 1]`. Fixed under `LC_ALL=C`.
fn parse_track(track: &str) -> (u32, u32) {
    let number_after = |word: &str| -> u32 {
        track
            .find(word)
            .map(|i| track[i + word.len()..].trim_start().chars().take_while(char::is_ascii_digit).collect::<String>())
            .and_then(|digits| digits.parse().ok())
            .unwrap_or(0)
    };
    (number_after("ahead"), number_after("behind"))
}

/// Remote of a remote branch: the longest known remote name that matches;
/// otherwise the part before the first slash.
fn remote_of(short: &str, remote_names: &[String]) -> String {
    remote_names
        .iter()
        .filter(|r| short.strip_prefix(r.as_str()).is_some_and(|rest| rest.starts_with('/')))
        .max_by_key(|r| r.len())
        .cloned()
        .unwrap_or_else(|| short.split('/').next().unwrap_or(short).to_string())
}

/// Tag message without the appended signature.
fn clean_annotation(contents: &str) -> String {
    let mut end = contents.len();
    for marker in ["-----BEGIN PGP SIGNATURE-----", "-----BEGIN SSH SIGNATURE-----", "-----BEGIN SIGNED MESSAGE-----"] {
        if let Some(i) = contents.find(marker) {
            end = end.min(i);
        }
    }
    contents[..end].trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A branch points to a commit whose object is missing: the other refs still arrive – and
    /// quickly. (Git for Windows silently stalls after "fatal: missing object" with the full
    /// format; without a limit on silence the branch list would load forever.)
    #[tokio::test]
    async fn refs_list_gets_past_a_branch_whose_commit_object_is_missing() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let _remote = repo.add_remote();
        repo.checkout_new("kaputt");
        let tip = repo.commit_file("k.txt", "k\n", "Kaputt");
        repo.checkout("main");
        repo.git(&["tag", "-a", "v1", "-m", "Version 1"]);
        std::fs::remove_file(repo.path().join(".git").join("objects").join(&tip[..2]).join(&tip[2..])).expect("loose object");
        let id = tc.open(&repo).await.repo.id;

        let started = std::time::Instant::now();
        let refs = tokio::time::timeout(std::time::Duration::from_secs(30), refs_list(&tc, id)).await.expect("refs_list does not hang").unwrap();
        assert!(started.elapsed() < std::time::Duration::from_secs(20), "{:?}", started.elapsed());
        let names: Vec<&str> = refs.locals.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["main"], "the damaged branch is skipped, the rest is there");
        assert_eq!(refs.tags.len(), 1);
    }
    use crate::error::ErrorCode;
    use crate::events::names;
    use crate::testkit::{TestCore, TestRepo};

    fn find<'a>(list: &'a [Ref], name: &str) -> &'a Ref {
        list.iter().find(|r| r.name == name).unwrap_or_else(|| panic!("ref {name} missing in {list:?}"))
    }

    #[tokio::test]
    async fn lists_branches_and_head() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let first = repo.head();
        repo.checkout_new("feature/neu");
        let second = repo.commit_file("a.txt", "a\n", "Zweiter");
        let id = tc.open(&repo).await.repo.id;
        tc.events.clear();

        let refs = refs_list(&tc, id).await.unwrap();
        assert_eq!(refs.head, Head::Branch { branch: "feature/neu".into(), sha: second.clone() });
        assert_eq!(refs.locals.len(), 2);
        let feature = find(&refs.locals, "feature/neu");
        assert_eq!(feature.full_name, "refs/heads/feature/neu");
        assert_eq!(feature.kind, RefKind::Local);
        assert_eq!(feature.sha, second);
        assert!(feature.is_head);
        assert_eq!(feature.upstream, None);
        assert!(!feature.upstream_gone);
        assert_eq!(feature.remote, None);
        assert_eq!(feature.worktree_path, None);
        let main = find(&refs.locals, "main");
        assert_eq!(main.sha, first);
        assert!(!main.is_head);
        assert!(refs.remotes.is_empty());
        assert!(refs.tags.is_empty());
        // Reading does not log and reports no change.
        assert_eq!(tc.events.count(names::LOG_APPENDED), 0);
        assert_eq!(tc.events.count(names::REPO_CHANGED), 0);
    }

    #[tokio::test]
    async fn upstream_ahead_behind_and_gone() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let remote = repo.add_remote();
        repo.checkout_new("weg");
        repo.git(&["push", "-q", "-u", "origin", "weg"]);
        repo.checkout("main");

        // Someone else pushes a commit, we have two of our own.
        let other = TestRepo::clone_of(&remote);
        other.commit_file("fremd.txt", "x\n", "Fremder Commit");
        other.git(&["push", "-q", "origin", "main"]);
        repo.commit_file("eins.txt", "1\n", "Eins");
        repo.commit_file("zwei.txt", "2\n", "Zwei");
        repo.git(&["fetch", "-q", "origin"]);
        // The remote branch of "weg" disappears.
        repo.git(&["update-ref", "-d", "refs/remotes/origin/weg"]);
        let id = tc.open(&repo).await.repo.id;

        let refs = read_refs(&tc, &id).await.unwrap();
        let main = find(&refs.locals, "main");
        assert_eq!(main.upstream.as_deref(), Some("origin/main"));
        assert!(!main.upstream_gone);
        assert_eq!((main.ahead, main.behind), (2, 1));
        let gone = find(&refs.locals, "weg");
        assert_eq!(gone.upstream.as_deref(), Some("origin/weg"));
        assert!(gone.upstream_gone);
        assert_eq!((gone.ahead, gone.behind), (0, 0));

        assert_eq!(refs.remotes.len(), 1, "{:?}", refs.remotes);
        let origin_main = find(&refs.remotes, "origin/main");
        assert_eq!(origin_main.full_name, "refs/remotes/origin/main");
        assert_eq!(origin_main.kind, RefKind::Remote);
        assert_eq!(origin_main.remote.as_deref(), Some("origin"));
        assert_eq!(origin_main.sha, other.head());
        assert_eq!(origin_main.upstream, None);
    }

    #[tokio::test]
    async fn remote_head_symref_is_left_out_and_remote_names_may_contain_slashes() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let remote = repo.add_remote();
        let clone = TestRepo::clone_of(&remote);
        // A clone has refs/remotes/origin/HEAD as a symref.
        assert_eq!(clone.git(&["symbolic-ref", "refs/remotes/origin/HEAD"]), "refs/remotes/origin/main");
        clone.git(&["remote", "add", "team/zwei", &remote.url()]);
        clone.git(&["fetch", "-q", "team/zwei"]);
        let id = tc.open(&clone).await.repo.id;

        let refs = read_refs(&tc, &id).await.unwrap();
        let names: Vec<&str> = refs.remotes.iter().map(|r| r.name.as_str()).collect();
        assert_eq!(names, vec!["origin/main", "team/zwei/main"]);
        assert_eq!(find(&refs.remotes, "team/zwei/main").remote.as_deref(), Some("team/zwei"));
        assert_eq!(find(&refs.locals, "main").upstream.as_deref(), Some("origin/main"));
    }

    #[tokio::test]
    async fn annotated_and_lightweight_tags() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let first = repo.head();
        repo.tag("leicht");
        repo.git(&["tag", "-a", "v1.0", "-m", "Version 1.0\n\nMit Umlauten: äöü ß"]);
        let second = repo.commit_file("b.txt", "b\n", "Zweiter");
        let id = tc.open(&repo).await.repo.id;

        let refs = read_refs(&tc, &id).await.unwrap();
        assert_eq!(refs.tags.len(), 2);
        let light = find(&refs.tags, "leicht");
        assert_eq!(light.full_name, "refs/tags/leicht");
        assert_eq!(light.kind, RefKind::Tag);
        assert_eq!(light.sha, first);
        assert!(!light.is_annotated);
        assert_eq!(light.annotation, None);
        assert!(!light.is_head);
        let annotated = find(&refs.tags, "v1.0");
        // The target commit, not the tag object.
        assert_eq!(annotated.sha, first);
        assert_ne!(repo.git(&["rev-parse", "refs/tags/v1.0"]), first);
        assert!(annotated.is_annotated);
        assert_eq!(annotated.annotation.as_deref(), Some("Version 1.0\n\nMit Umlauten: äöü ß"));
        assert_eq!(refs.head, Head::Branch { branch: "main".into(), sha: second });
    }

    #[tokio::test]
    async fn detached_head_and_repo_without_commit() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let first = repo.head();
        repo.commit_file("b.txt", "b\n", "Zweiter");
        repo.git(&["checkout", "-q", "--detach", &first]);
        let id = tc.open(&repo).await.repo.id;
        let refs = read_refs(&tc, &id).await.unwrap();
        assert_eq!(refs.head, Head::Detached { sha: first.clone() });
        assert!(refs.locals.iter().all(|r| !r.is_head));
        assert_eq!(read_head(&tc, &id).await.unwrap(), Head::Detached { sha: first });

        let empty = TestRepo::new();
        let id = tc.open(&empty).await.repo.id;
        let refs = read_refs(&tc, &id).await.unwrap();
        assert_eq!(refs.head, Head::Unborn { branch: "main".into() });
        assert!(refs.locals.is_empty() && refs.remotes.is_empty() && refs.tags.is_empty());
    }

    #[tokio::test]
    async fn branch_in_another_worktree() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        repo.branch("frei");
        let other = repo.temp_dir().join("zweites");
        repo.git(&["worktree", "add", "-q", "-b", "anderswo", &other.to_string_lossy()]);
        let id = tc.open(&repo).await.repo.id;

        let refs = read_refs(&tc, &id).await.unwrap();
        let elsewhere = find(&refs.locals, "anderswo");
        let shown = elsewhere.worktree_path.as_deref().expect("worktree_path set");
        assert_eq!(util::path_key(Path::new(shown)), util::path_key(&other));
        assert!(!elsewhere.is_head);
        assert_eq!(find(&refs.locals, "main").worktree_path, None);
        assert_eq!(find(&refs.locals, "frei").worktree_path, None);

        // From the second worktree's point of view it is the other way round (.git is a file there).
        assert!(other.join(".git").is_file());
        let other_id = crate::commands::repos::repo_open(&tc, other.to_string_lossy().into_owned()).await.unwrap().repo.id;
        let refs = read_refs(&tc, &other_id).await.unwrap();
        assert_eq!(refs.head, Head::Branch { branch: "anderswo".into(), sha: repo.head() });
        assert!(find(&refs.locals, "anderswo").is_head);
        assert_eq!(find(&refs.locals, "anderswo").worktree_path, None);
        let main_path = find(&refs.locals, "main").worktree_path.clone().expect("main is in the first worktree");
        assert_eq!(util::path_key(Path::new(&main_path)), util::path_key(repo.path()));
    }

    #[tokio::test]
    async fn branch_being_rebased_is_not_reported_as_foreign_worktree() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        repo.checkout_new("feature");
        repo.commit_file("README.md", "# Feature\n", "Feature");
        repo.checkout("main");
        repo.commit_file("README.md", "# Main\n", "Main");
        repo.checkout("feature");
        assert!(!repo.git_output(&["rebase", "main"]).status.success());
        let id = tc.open(&repo).await.repo.id;

        let refs = read_refs(&tc, &id).await.unwrap();
        assert!(matches!(refs.head, Head::Detached { .. }));
        assert_eq!(find(&refs.locals, "feature").worktree_path, None);
    }

    #[tokio::test]
    async fn unknown_repo_and_missing_folder() {
        let tc = TestCore::new().await;
        let err = read_refs(&tc, "gibt-es-nicht").await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);

        let repo = TestRepo::with_commit();
        let id = tc.open(&repo).await.repo.id;
        std::fs::remove_dir_all(repo.path().join(".git")).unwrap();
        let err = read_refs(&tc, &id).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotARepo, "{err:?}");
        let err = read_head(&tc, &id).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotARepo, "{err:?}");
    }

    #[test]
    fn parses_track_and_remote_names() {
        assert_eq!(parse_track("[ahead 3, behind 12]"), (3, 12));
        assert_eq!(parse_track("[behind 4]"), (0, 4));
        assert_eq!(parse_track("[ahead 1]"), (1, 0));
        assert_eq!(parse_track(""), (0, 0));
        let remotes = vec!["origin".to_string(), "team/zwei".to_string(), "team".to_string()];
        assert_eq!(remote_of("team/zwei/main", &remotes), "team/zwei");
        assert_eq!(remote_of("team/main", &remotes), "team");
        assert_eq!(remote_of("unbekannt/x/y", &remotes), "unbekannt");
        assert_eq!(short_ref_name("refs/remotes/origin/a/b"), "origin/a/b");
        assert_eq!(clean_annotation("Text\n\n-----BEGIN PGP SIGNATURE-----\nabc\n"), "Text");
    }

    #[test]
    fn parser_ignores_truncated_output() {
        let parsed = parse_for_each_ref(b"refs/heads/main\0abc\0commit\0", &[], Path::new("/x"));
        assert_eq!(parsed, ParsedRefs::default());
    }
}
