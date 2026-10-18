//! Bisect (`git bisect`): find the commit that introduced a bug by marking commits good or bad.
//!
//! The state is read only from the Git directory – `BISECT_START`, `BISECT_LOG`, `BISECT_TERMS` and
//! the refs under `refs/bisect/` – never kept in memory, so a bisect started on the command line
//! shows up as well, including its own terms (`--term-new`/`--term-old`). Start, mark and reset are
//! write operations under the repository's lock.

use std::collections::HashSet;
use std::path::Path;

use crate::app::Core;
use crate::commands::graph::{is_full_sha, read_cmd, resolve_commit};
use crate::commands::refs::for_each_ref;
use crate::commands::status::{self, read_operation};
use crate::commands::submodule::auto;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::errors::classify;
use crate::model::{BisectStatus, BisectVerdict, RepoChange};
use crate::util;

/// A bisect checks out other commits and moves refs under `refs/bisect/`.
const CHANGES: [RepoChange; 5] = [RepoChange::Worktree, RepoChange::Index, RepoChange::Refs, RepoChange::Head, RepoChange::Operation];

pub async fn bisect_status(core: &Core, repo_id: String) -> CoreResult<BisectStatus> {
    read_bisect(core, &repo_id).await
}

/// Starts between `bad` and the `good` commits; Git checks out the first commit to test.
pub async fn bisect_start(core: &Core, repo_id: String, bad: String, good: Vec<String>) -> CoreResult<BisectStatus> {
    auto::follow(core, &repo_id, core.with_write_lock(&repo_id, &CHANGES, start_locked(core, &repo_id, &bad, &good))).await
}

/// Marks `sha` (`None` = the commit under test); Git checks out the next one.
pub async fn bisect_mark(core: &Core, repo_id: String, verdict: BisectVerdict, sha: Option<String>) -> CoreResult<BisectStatus> {
    auto::follow(core, &repo_id, core.with_write_lock(&repo_id, &CHANGES, mark_locked(core, &repo_id, verdict, sha.as_deref()))).await
}

/// Ends the bisect; Git returns to the branch (or commit) it started from.
pub async fn bisect_reset(core: &Core, repo_id: String) -> CoreResult<BisectStatus> {
    let reset = core.with_write_lock(&repo_id, &CHANGES, async {
        if !read_bisect(core, &repo_id).await?.active {
            return Err(no_bisect());
        }
        core.git_for(&repo_id)?.args(["bisect", "reset"]).run().await?;
        read_bisect(core, &repo_id).await
    });
    auto::follow(core, &repo_id, reset).await
}

async fn start_locked(core: &Core, repo_id: &str, bad: &str, good: &[String]) -> CoreResult<BisectStatus> {
    if read_bisect(core, repo_id).await?.active {
        return Err(CoreError::new(ErrorCode::BisectActive, "A bisect is already running. Finish it first."));
    }
    if read_operation(core, repo_id).await?.is_some() {
        return Err(CoreError::new(
            ErrorCode::OperationInProgress,
            "A merge, rebase, cherry-pick or revert is in progress. Finish or abort it before starting a bisect.",
        ));
    }
    if good.is_empty() {
        return Err(CoreError::not_allowed("A bisect needs at least one good commit."));
    }
    let bad = resolve_commit(core, repo_id, bad).await?;
    let mut goods = Vec::with_capacity(good.len());
    for sha in good {
        goods.push(resolve_commit(core, repo_id, sha).await?);
    }
    if goods.contains(&bad) {
        return Err(CoreError::not_allowed("The same commit can’t be both good and bad."));
    }
    let dirty = core.git_for(repo_id)?.args(["status", "--porcelain=v2", "-z", "--untracked-files=no"]).read_only().no_log().run().await?;
    if !dirty.stdout.is_empty() {
        return Err(CoreError::not_allowed(
            "A bisect checks out other commits, so the working directory must be clean. Commit or stash your changes first.",
        ));
    }
    let out = core.git_for(repo_id)?.args(["bisect", "start"]).arg(&bad).args(&goods).arg("--").run_raw().await?;
    let status = read_bisect(core, repo_id).await?;
    if out.success() {
        return Ok(status);
    }
    // Git cleans up after a failed start; whatever is left is removed so no half bisect remains.
    if status.active {
        let _ = core.git_for(repo_id)?.args(["bisect", "reset"]).run_raw().await;
    }
    let error = classify("bisect", out.code, &out.stdout, &out.stderr);
    Err(if error.code == ErrorCode::Unknown {
        CoreError::not_allowed("Git can’t bisect between these commits. The good commit must be an ancestor of the bad one.")
            .with_git_output(out.stderr_text())
    } else {
        error
    })
}

async fn mark_locked(core: &Core, repo_id: &str, verdict: BisectVerdict, sha: Option<&str>) -> CoreResult<BisectStatus> {
    if !read_bisect(core, repo_id).await?.active {
        return Err(no_bisect());
    }
    let terms = read_terms(&status::git_dir(core, repo_id).await?);
    let word = match verdict {
        BisectVerdict::Good => terms.good,
        BisectVerdict::Bad => terms.bad,
        BisectVerdict::Skip => "skip".to_string(),
    };
    let target = match sha {
        Some(sha) => Some(resolve_commit(core, repo_id, sha).await?),
        None => None,
    };
    let mut cmd = core.git_for(repo_id)?.arg("bisect").arg(&word);
    if let Some(target) = &target {
        cmd = cmd.arg(target);
    }
    let out = cmd.run_raw().await?;
    let status = read_bisect(core, repo_id).await?;
    // "Only skipped commits left" ends with exit code 2 – that is a state, not an error.
    if out.success() || status.result.is_some() || status.only_skipped_left {
        return Ok(status);
    }
    Err(classify("bisect", out.code, &out.stdout, &out.stderr))
}

fn no_bisect() -> CoreError {
    CoreError::new(ErrorCode::NoOperation, "No bisect is running.")
}

/// The words Git uses for "bad" and "good" in this bisect.
struct Terms {
    bad: String,
    good: String,
}

fn read_terms(dir: &Path) -> Terms {
    let text = std::fs::read(dir.join("BISECT_TERMS")).map(|b| util::decode_lossy(&b)).unwrap_or_default();
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    match (lines.next(), lines.next()) {
        (Some(bad), Some(good)) if valid_term(bad) && valid_term(good) => Terms { bad: bad.to_string(), good: good.to_string() },
        _ => Terms { bad: "bad".to_string(), good: "good".to_string() },
    }
}

fn valid_term(term: &str) -> bool {
    !term.starts_with('-') && term.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The state as Git keeps it; `BisectStatus::default()` if no bisect is running.
pub(crate) async fn read_bisect(core: &Core, repo_id: &str) -> CoreResult<BisectStatus> {
    let path = core.repo_path(repo_id)?;
    read_bisect_at(core, &path, repo_id).await
}

/// The bisect of the worktree at `path` (the main one or a linked one). Every worktree has its own:
/// `BISECT_*` lie in its own Git directory (`.git/worktrees/<name>` for a linked one) and
/// `refs/bisect/*` are per-worktree refs.
pub(crate) async fn read_bisect_at(core: &Core, path: &Path, repo_id: &str) -> CoreResult<BisectStatus> {
    let dir = status::git_dir_at(core, path, repo_id).await?;
    if !dir.join("BISECT_START").is_file() {
        return Ok(BisectStatus::default());
    }
    let terms = read_terms(&dir);
    let listed = for_each_ref(core, path, repo_id, &["--format=%(refname)%00%(objectname)".to_string()], &["refs/bisect"]).await?;
    let bad_ref = format!("refs/bisect/{}", terms.bad);
    let good_prefix = format!("refs/bisect/{}-", terms.good);
    let mut status = BisectStatus { active: true, ..Default::default() };
    for line in listed.stdout_lines() {
        let text = util::decode_lossy(line);
        let Some((name, sha)) = text.split_once('\0') else { continue };
        if !is_full_sha(sha) {
            continue;
        }
        if name == bad_ref {
            status.bad = Some(sha.to_string());
        } else if name.starts_with(&good_prefix) {
            status.good.push(sha.to_string());
        } else if name.starts_with("refs/bisect/skip-") {
            status.skipped.push(sha.to_string());
        }
    }
    let log = std::fs::read(dir.join("BISECT_LOG")).map(|b| util::decode_lossy(&b)).unwrap_or_default();
    status.steps_done = count_steps(&log, &terms);
    status.current = current_commit(core, path, repo_id, &dir).await;
    if let (Some(bad), false) = (status.bad.clone(), status.good.is_empty()) {
        evaluate(core, path, repo_id, &dir, &bad, &mut status).await?;
    }
    Ok(status)
}

/// Marks since the start: the log has one `git bisect <term|skip> <sha>` line per mark.
fn count_steps(log: &str, terms: &Terms) -> u32 {
    let marks = log
        .lines()
        .filter(|line| {
            let Some(rest) = line.strip_prefix("git bisect ") else { return false };
            let word = rest.split_whitespace().next().unwrap_or_default();
            word == terms.bad || word == terms.good || word == "skip"
        })
        .count();
    u32::try_from(marks).unwrap_or(u32::MAX)
}

/// With `--no-checkout` Git moves BISECT_HEAD instead of HEAD.
async fn current_commit(core: &Core, path: &Path, repo_id: &str, dir: &Path) -> Option<String> {
    let name = if dir.join("BISECT_HEAD").is_file() { "BISECT_HEAD" } else { "HEAD" };
    let out = read_cmd(core, path, repo_id).args(["rev-parse", "-q", "--verify"]).arg(format!("{name}^{{commit}}")).run_raw().await.ok()?;
    let sha = out.stdout_text();
    (out.success() && is_full_sha(&sha)).then_some(sha)
}

/// Remaining steps, result and "only skipped left" from `git rev-list --bisect-vars`, limited to
/// the bisect's pathspec (`BISECT_NAMES`).
async fn evaluate(core: &Core, path: &Path, repo_id: &str, dir: &Path, bad: &str, status: &mut BisectStatus) -> CoreResult<()> {
    let mut stdin = format!("{bad}\n");
    for sha in &status.good {
        stdin.push('^');
        stdin.push_str(sha);
        stdin.push('\n');
    }
    // The pathspec of the bisect limits the candidates exactly as Git's own count does.
    let names: Vec<std::ffi::OsString> = std::fs::read(dir.join("BISECT_NAMES"))
        .map(|raw| bisect_names(&raw).iter().map(|name| util::bytes_to_path(name).into_os_string()).collect())
        .unwrap_or_default();
    let vars = read_cmd(core, path, repo_id).args(["rev-list", "--bisect-vars", "--stdin", "--"]).args(&names).stdin(stdin.clone()).run_raw().await?;
    if !vars.success() {
        return Ok(());
    }
    let text = vars.stdout_text();
    let var = |name: &str| text.lines().find_map(|l| l.strip_prefix(name)?.strip_prefix('=')).map(|v| v.trim_matches('\'').to_string());
    let all: usize = var("bisect_all").and_then(|v| v.parse().ok()).unwrap_or(0);
    let steps: i64 = var("bisect_steps").and_then(|v| v.parse().ok()).unwrap_or(0);
    if all == 1 {
        status.result = Some(bad.to_string());
        status.remaining_steps = Some(0);
        return Ok(());
    }
    status.remaining_steps = Some(u32::try_from(steps.max(0)).unwrap_or(u32::MAX));
    if all <= status.skipped.len() + 1 {
        let listed = read_cmd(core, path, repo_id).args(["rev-list", "--stdin", "--"]).args(&names).stdin(stdin).run().await?;
        let skipped: HashSet<&str> = status.skipped.iter().map(String::as_str).collect();
        let candidates: Vec<String> = listed.stdout_lines().into_iter().map(util::decode_lossy).collect();
        if candidates.iter().all(|c| c == bad || skipped.contains(c.as_str())) {
            status.only_skipped_left = true;
            status.remaining_steps = Some(0);
        }
    }
    Ok(())
}

/// The pathspec a bisect was started with (`git bisect start … -- <paths>`): `BISECT_NAMES` holds
/// it shell-quoted (` 'a b' 'it'\\''s'`, Git's `sq_quote_argv`). Bytes, never lossy.
fn bisect_names(raw: &[u8]) -> Vec<Vec<u8>> {
    let mut names = Vec::new();
    let mut current: Option<Vec<u8>> = None;
    let mut quoted = false;
    let mut bytes = raw.iter().copied();
    while let Some(byte) = bytes.next() {
        match (quoted, byte) {
            (true, b'\'') => quoted = false,
            (true, _) => current.get_or_insert_with(Vec::new).push(byte),
            (false, b'\'') => {
                quoted = true;
                current.get_or_insert_with(Vec::new);
            }
            (false, b'\\') => {
                if let Some(next) = bytes.next() {
                    current.get_or_insert_with(Vec::new).push(next);
                }
            }
            (false, b' ' | b'\t' | b'\n' | b'\r') => names.extend(current.take()),
            (false, _) => current.get_or_insert_with(Vec::new).push(byte),
        }
    }
    names.extend(current);
    names
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::names;
    use crate::testkit::{TestCore, TestRepo};

    /// `n` commits on main, oldest first.
    fn chain(repo: &TestRepo, n: usize) -> Vec<String> {
        (1..=n).map(|i| repo.commit_file("f.txt", format!("{i}\n"), &format!("c{i}"))).collect()
    }

    /// A bisect started on the command line with a pathspec: only commits that touch those paths
    /// are candidates, so the result is there as soon as Git has it.
    #[tokio::test]
    async fn an_external_bisect_with_a_pathspec_counts_only_matching_commits() {
        let tc = TestCore::new().await;
        let repo = TestRepo::new();
        let good = repo.commit_file("x.txt", "0\n", "c0");
        repo.commit_file("anderes.txt", "1\n", "c1");
        let culprit = repo.commit_file("mein ordner/f'x.txt", "2\n", "c2");
        repo.commit_file("anderes.txt", "3\n", "c3");
        let bad = repo.commit_file("anderes.txt", "4\n", "c4");
        let id = tc.open(&repo).await.repo.id;
        repo.git(&["bisect", "start", &bad, &good, "--", "mein ordner/f'x.txt", "fehlt.txt"]);
        let out = repo.git(&["bisect", "bad", &culprit]);
        // Newer Git versions quote the term: "is the first 'bad' commit".
        assert!(out.contains("is the first bad commit") || out.contains("is the first 'bad' commit"), "{out}");

        let status = bisect_status(&tc, id.clone()).await.unwrap();
        assert_eq!(status.result.as_deref(), Some(culprit.as_str()), "{status:?}");
        assert_eq!(status.remaining_steps, Some(0));
    }

    #[test]
    fn saved_pathspecs_are_unquoted() {
        assert_eq!(bisect_names(b" 'a b' 'it'\\''s' 'x'\\!'y'\n"), [b"a b".to_vec(), b"it's".to_vec(), b"x!y".to_vec()]);
        assert!(bisect_names(b"\n").is_empty());
        assert!(bisect_names(b"").is_empty());
    }

    #[tokio::test]
    async fn marking_until_the_first_bad_commit_is_found() {
        let tc = TestCore::new().await;
        let repo = TestRepo::new();
        let shas = chain(&repo, 8);
        let id = tc.open(&repo).await.repo.id;
        assert_eq!(bisect_status(&tc, id.clone()).await.unwrap(), BisectStatus::default());

        tc.events.clear();
        let mut status = bisect_start(&tc, id.clone(), shas[7].clone(), vec![shas[0].clone()]).await.unwrap();
        assert!(status.active);
        assert_eq!((status.bad.as_deref(), status.good.clone()), (Some(shas[7].as_str()), vec![shas[0].clone()]));
        assert!(status.remaining_steps.is_some_and(|n| n >= 1), "{status:?}");
        assert_eq!(status.steps_done, 0);
        assert!(tc.events.count(names::REPO_CHANGED) >= 1);

        // The bug came in with c5.
        let mut rounds = 0;
        while status.result.is_none() {
            rounds += 1;
            assert!(rounds < 10, "{status:?}");
            let current = status.current.clone().expect("a commit to test");
            assert_eq!(repo.head(), current, "HEAD is on the commit to test");
            let index = shas.iter().position(|s| *s == current).unwrap();
            let verdict = if index >= 4 { BisectVerdict::Bad } else { BisectVerdict::Good };
            status = bisect_mark(&tc, id.clone(), verdict, None).await.unwrap();
        }
        assert_eq!(status.result.as_deref(), Some(shas[4].as_str()));
        assert_eq!(status.remaining_steps, Some(0));
        assert_eq!(status.steps_done, rounds);

        let done = bisect_reset(&tc, id.clone()).await.unwrap();
        assert!(!done.active);
        assert_eq!(repo.current_branch(), "main");
        assert_eq!(repo.head(), shas[7]);
    }

    #[tokio::test]
    async fn skipping_is_recorded_and_only_skipped_commits_left_is_a_state() {
        let tc = TestCore::new().await;
        let repo = TestRepo::new();
        let shas = chain(&repo, 3);
        let id = tc.open(&repo).await.repo.id;

        let status = bisect_start(&tc, id.clone(), shas[2].clone(), vec![shas[0].clone()]).await.unwrap();
        assert_eq!(status.current.as_deref(), Some(shas[1].as_str()));
        // Git ends this with exit code 2 – for the user it is a state, not an error.
        let status = bisect_mark(&tc, id.clone(), BisectVerdict::Skip, None).await.unwrap();
        assert_eq!(status.skipped, vec![shas[1].clone()]);
        assert!(status.only_skipped_left, "{status:?}");
        assert_eq!((status.result.clone(), status.steps_done), (None, 1));
    }

    #[tokio::test]
    async fn a_named_commit_can_be_marked() {
        let tc = TestCore::new().await;
        let repo = TestRepo::new();
        let shas = chain(&repo, 6);
        let id = tc.open(&repo).await.repo.id;
        bisect_start(&tc, id.clone(), shas[5].clone(), vec![shas[0].clone()]).await.unwrap();
        let status = bisect_mark(&tc, id.clone(), BisectVerdict::Good, Some(shas[2].clone())).await.unwrap();
        assert!(status.good.contains(&shas[2]), "{status:?}");
        let err = bisect_mark(&tc, id.clone(), BisectVerdict::Bad, Some("-x".into())).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn start_needs_a_clean_tree_and_refuses_a_second_bisect() {
        let tc = TestCore::new().await;
        let repo = TestRepo::new();
        let shas = chain(&repo, 4);
        let id = tc.open(&repo).await.repo.id;

        repo.write_file("f.txt", "geändert\n");
        let err = bisect_start(&tc, id.clone(), shas[3].clone(), vec![shas[0].clone()]).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
        assert!(err.message.contains("stash"), "{}", err.message);
        assert!(!bisect_status(&tc, id.clone()).await.unwrap().active);

        repo.git(&["checkout", "-q", "--", "f.txt"]);
        repo.write_file("neu.txt", "untracked files do not block\n");
        bisect_start(&tc, id.clone(), shas[3].clone(), vec![shas[0].clone()]).await.unwrap();
        let err = bisect_start(&tc, id.clone(), shas[3].clone(), vec![shas[0].clone()]).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::BisectActive);
    }

    #[tokio::test]
    async fn a_bisect_started_on_the_command_line_is_recognised_with_its_own_terms() {
        let tc = TestCore::new().await;
        let repo = TestRepo::new();
        let shas = chain(&repo, 6);
        let id = tc.open(&repo).await.repo.id;
        repo.git(&["bisect", "start", "--term-new=kaputt", "--term-old=heil", &shas[5], &shas[0], "--"]);

        let status = bisect_status(&tc, id.clone()).await.unwrap();
        assert!(status.active);
        assert_eq!((status.bad.as_deref(), status.good.clone()), (Some(shas[5].as_str()), vec![shas[0].clone()]));
        let tested = status.current.clone().expect("a commit to test");

        let status = bisect_mark(&tc, id.clone(), BisectVerdict::Bad, None).await.unwrap();
        assert_eq!(status.bad.as_deref(), Some(tested.as_str()));
        let log = std::fs::read_to_string(repo.path().join(".git").join("BISECT_LOG")).unwrap();
        assert!(log.contains("git bisect kaputt"), "{log}");
        assert_eq!(status.steps_done, 1);
    }

    #[tokio::test]
    async fn a_failed_start_leaves_nothing_behind_and_marks_need_a_running_bisect() {
        let tc = TestCore::new().await;
        let repo = TestRepo::new();
        let shas = chain(&repo, 4);
        let id = tc.open(&repo).await.repo.id;

        // Good and bad swapped: Git refuses.
        let err = bisect_start(&tc, id.clone(), shas[0].clone(), vec![shas[3].clone()]).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed, "{err:?}");
        assert!(!bisect_status(&tc, id.clone()).await.unwrap().active);
        assert_eq!(repo.current_branch(), "main");

        let err = bisect_mark(&tc, id.clone(), BisectVerdict::Good, None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NoOperation);
        let err = bisect_reset(&tc, id.clone()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NoOperation);
        let err = bisect_start(&tc, id.clone(), shas[1].clone(), Vec::new()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
        let err = bisect_start(&tc, id.clone(), shas[1].clone(), vec![shas[1].clone()]).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
        let err = bisect_start(&tc, id.clone(), "-x".into(), vec![shas[0].clone()]).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn a_bisect_ended_midway_or_from_outside_is_gone() {
        let tc = TestCore::new().await;
        let repo = TestRepo::new();
        let shas = chain(&repo, 6);
        let id = tc.open(&repo).await.repo.id;

        // Ended in the app before the result is known: back on the branch it started from.
        let status = bisect_start(&tc, id.clone(), shas[5].clone(), vec![shas[0].clone()]).await.unwrap();
        assert!(status.active && status.result.is_none(), "{status:?}");
        let done = bisect_reset(&tc, id.clone()).await.unwrap();
        assert_eq!(done, BisectStatus::default());
        assert_eq!((repo.current_branch(), repo.head()), ("main".to_string(), shas[5].clone()));

        // Ended on the command line: the next read sees no bisect, marking is refused.
        bisect_start(&tc, id.clone(), shas[5].clone(), vec![shas[0].clone()]).await.unwrap();
        repo.git(&["bisect", "reset"]);
        assert_eq!(bisect_status(&tc, id.clone()).await.unwrap(), BisectStatus::default());
        let err = bisect_mark(&tc, id.clone(), BisectVerdict::Good, None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NoOperation);
    }

    /// The JSON spelling the UI uses (types.ts): camelCase fields, snake_case enum values, and the
    /// AI input as one flat object with `kind`.
    #[test]
    fn autopilot_types_use_the_contract_spelling() {
        use crate::model::{AiInput, BisectAutopilot, BisectAutopilotPhase, BisectAutopilotStep, BisectScriptRequest, BisectShell};
        let request: BisectScriptRequest =
            serde_json::from_value(serde_json::json!({"description": "Fahrenheit falsch", "testCommand": null, "bad": "b", "good": ["g"]})).unwrap();
        assert_eq!(request.test_command, None);
        let input: AiInput = serde_json::from_value(serde_json::json!({
            "kind": "bisect_script", "description": "Fahrenheit falsch", "testCommand": "make test", "bad": "b", "good": ["g1", "g2"]
        }))
        .unwrap();
        assert_eq!(
            input,
            AiInput::BisectScript(BisectScriptRequest {
                description: "Fahrenheit falsch".into(),
                test_command: Some("make test".into()),
                bad: "b".into(),
                good: vec!["g1".into(), "g2".into()],
            })
        );
        let run = BisectAutopilot {
            job_id: "j".into(),
            phase: BisectAutopilotPhase::OnlySkipped,
            worktree_path: "/home/anna/Mein Projekt.agents/bisect-1".into(),
            bad: "b".into(),
            good: vec!["g".into()],
            current: None,
            remaining_steps: Some(0),
            steps: vec![BisectAutopilotStep { sha: "s".into(), verdict: BisectVerdict::Skip, exit_code: None, timed_out: true, duration_ms: 5, output_tail: String::new() }],
            result: None,
            candidates: vec!["s".into(), "b".into()],
            step_timeout_secs: 600,
            message: None,
            started_at: "2026-10-16T08:00:00Z".into(),
        };
        let value = serde_json::to_value(&run).unwrap();
        assert_eq!(value["phase"], "only_skipped");
        assert_eq!(value["worktreePath"], "/home/anna/Mein Projekt.agents/bisect-1");
        assert_eq!(value["steps"][0]["timedOut"], true);
        assert_eq!(value["steps"][0]["exitCode"], serde_json::Value::Null);
        assert_eq!(value["stepTimeoutSecs"], 600);
        assert_eq!(serde_json::to_value(BisectShell::Powershell).unwrap(), "powershell");
        assert_eq!(serde_json::to_value(BisectAutopilotPhase::Found).unwrap(), "found");
    }

    /// Each worktree has its own bisect: `BISECT_*` lie in its own Git directory and `refs/bisect/*`
    /// are per-worktree refs. One in a linked worktree is read there and never shows in the main one.
    #[tokio::test]
    async fn a_bisect_in_a_linked_worktree_is_read_from_its_own_git_directory() {
        let tc = TestCore::new().await;
        let repo = TestRepo::new();
        let shas = chain(&repo, 6);
        let id = tc.open(&repo).await.repo.id;
        let linked = repo.temp_dir().join("zweiter Baum ä");
        let linked_s = linked.to_str().unwrap();
        repo.git(&["worktree", "add", "-q", "--detach", linked_s, &shas[5]]);
        repo.git(&["-C", linked_s, "bisect", "start", &shas[5], &shas[0], "--"]);

        let there = read_bisect_at(&tc, &linked, &id).await.unwrap();
        assert!(there.active);
        assert_eq!((there.bad.as_deref(), there.good.clone()), (Some(shas[5].as_str()), vec![shas[0].clone()]));
        assert_eq!(there.current, Some(repo.git(&["-C", linked_s, "rev-parse", "HEAD"])));
        assert!(there.remaining_steps.is_some());
        assert_eq!(bisect_status(&tc, id.clone()).await.unwrap(), BisectStatus::default(), "the main worktree has no bisect");
        assert!(!repo.path().join(".git").join("BISECT_START").exists());

        // The other way round: a bisect in the main worktree does not change the linked one's.
        bisect_start(&tc, id.clone(), shas[3].clone(), vec![shas[1].clone()]).await.unwrap();
        let again = read_bisect_at(&tc, &linked, &id).await.unwrap();
        assert_eq!((again.bad.as_deref(), again.good), (Some(shas[5].as_str()), vec![shas[0].clone()]));
        assert_eq!(bisect_status(&tc, id.clone()).await.unwrap().bad.as_deref(), Some(shas[3].as_str()));
    }
}
