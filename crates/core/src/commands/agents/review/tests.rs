//! Review of a coding agent's work against real temp repositories: which two commits it compares
//! (a snapshot of the agent's worktree or its branch tip, against the fork point). Expected values
//! come from Git (`rev-parse`, `merge-base`, `cat-file`, `status`) and from literal fixtures, never
//! from the helpers under test.

use std::path::{Path, PathBuf};
use std::process::Command;

use super::*;
use crate::commands::agents::agent_review;
use crate::commands::graph::commit_details;
use crate::error::ErrorCode;
use crate::model::DiffSource;
use crate::testkit::{git_isolation_env, TestCore, TestRepo};

pub(super) const CRLF_BASE: &[u8] = b"eins\r\nzwei\r\ndrei";
pub(super) const CRLF_AGENT: &[u8] = b"EINS\r\nzwei\r\nDREI";
pub(super) const LATIN1: &[u8] = b"Gr\xf6\xdfe: 3\n";
/// Umlaut, space and a leading "-" in one file name.
pub(super) const ODD: &str = "-Größe neu.txt";
pub(super) const TASK: &str = "Liste groß schreiben\nund die Größe ergänzen";

pub(super) struct Fx {
    pub(super) tc: TestCore,
    pub(super) repo: TestRepo,
    pub(super) id: String,
    pub(super) row: AgentRow,
    pub(super) folder: PathBuf,
}

/// An agent as `agent_start` leaves it, without a session: branch `agent/<short>` from `base` in
/// `<temp>/repo.agents/<short>` (Entscheidung 3 written out), its own repository row, its row.
pub(super) async fn agent_at(tc: &TestCore, repo: &TestRepo, id: &str, short: &str, base: &str) -> (AgentRow, PathBuf) {
    let folder = repo.temp_dir().join("repo.agents").join(short);
    std::fs::create_dir_all(folder.parent().unwrap()).unwrap();
    let base_sha = repo.git(&["rev-parse", base]);
    repo.git(&["worktree", "add", "-q", "-b", &format!("agent/{short}"), &folder.to_string_lossy(), &base_sha]);
    let row = AgentRow {
        id: format!("agent-{short}"),
        repo_id: id.to_string(),
        short_name: short.to_string(),
        template_id: "claude".into(),
        task: TASK.into(),
        branch: format!("agent/{short}"),
        worktree_path: folder.to_string_lossy().into_owned(),
        base: base.to_string(),
        base_sha,
        unattended: false,
        started_at: "2026-10-16T08:00:00.000Z".into(),
        ended_at: Some("2026-10-16T08:30:00.000Z".into()),
        exit_code: Some(0),
        end_reason: Some(db::agents::EndReason::Exited),
    };
    let entry = tc.db.with(|c| db::repos::upsert(c, &folder)).unwrap();
    crate::commands::trust::settle_on_open(tc, &entry.id, &folder).await.unwrap();
    tc.db.with(|c| db::agents::insert(c, &row)).unwrap();
    (row, folder)
}

/// `main` with a CRLF list without a final newline and a `.gitignore` for `*.log`; one agent on it.
pub(super) async fn fixture() -> Fx {
    let repo = TestRepo::with_commit();
    repo.write_file("liste.txt", CRLF_BASE);
    repo.write_file(".gitignore", "*.log\n");
    repo.commit("Basis mit Liste");
    let tc = TestCore::new().await;
    let id = tc.open(&repo).await.repo.id;
    let (row, folder) = agent_at(&tc, &repo, &id, "liste", "main").await;
    Fx { tc, repo, id, row, folder }
}

fn git_cmd(repo: &TestRepo, dir: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(dir).env("LC_ALL", "C");
    for (key, value) in git_isolation_env(&repo.temp_dir().join("gitconfig")) {
        cmd.env(key, value);
    }
    cmd
}

/// git in the agent's worktree with the test repository's isolated configuration.
pub(super) fn git_in(repo: &TestRepo, dir: &Path, args: &[&str]) -> String {
    let out = git_cmd(repo, dir, args).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim_end().to_string()
}

/// A commit in the agent's worktree as the agent would make it; `date` in Git's raw format.
pub(super) fn agent_commit(fx: &Fx, file: &str, content: &[u8], message: &str, date: Option<&str>) -> String {
    std::fs::write(fx.folder.join(file), content).unwrap();
    git_in(&fx.repo, &fx.folder, &["add", "-A"]);
    let mut cmd = git_cmd(&fx.repo, &fx.folder, &["-c", "user.name=Agent", "-c", "user.email=agent@example.com", "commit", "-q", "-m", message]);
    if let Some(date) = date {
        cmd.env("GIT_AUTHOR_DATE", date).env("GIT_COMMITTER_DATE", date);
    }
    let out = cmd.output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    git_in(&fx.repo, &fx.folder, &["rev-parse", "HEAD"])
}

pub(super) fn blob(repo: &TestRepo, rev_path: &str) -> Vec<u8> {
    let out = repo.git_output(&["cat-file", "blob", rev_path]);
    assert!(out.status.success(), "cat-file {rev_path}: {}", String::from_utf8_lossy(&out.stderr));
    out.stdout
}

async fn changed_paths(fx: &Fx, review: &AgentReview) -> Vec<String> {
    let details = commit_details(&fx.tc, fx.id.clone(), DiffSource::Range { from: review.from.clone(), to: Some(review.to.clone()) }).await.unwrap();
    let mut paths: Vec<String> = details.files.into_iter().map(|file| file.path).collect();
    paths.sort();
    paths
}

#[tokio::test]
async fn the_snapshot_holds_the_working_state_without_touching_index_or_refs() {
    let fx = fixture().await;
    std::fs::write(fx.folder.join("liste.txt"), CRLF_AGENT).unwrap();
    std::fs::write(fx.folder.join(ODD), LATIN1).unwrap();
    std::fs::write(fx.folder.join("debug.log"), "laut\n").unwrap();
    let refs_before = fx.repo.git(&["for-each-ref", "--format=%(refname) %(objectname)"]);
    let agent_status_before = git_in(&fx.repo, &fx.folder, &["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    let agent_index_before = git_in(&fx.repo, &fx.folder, &["ls-files", "--stage", "-z"]);

    let review = agent_review(&fx.tc, fx.row.id.clone(), AgentReviewSource::Snapshot).await.unwrap();

    let head = git_in(&fx.repo, &fx.folder, &["rev-parse", "HEAD"]);
    assert_eq!(review.source, AgentReviewSource::Snapshot);
    assert_eq!(review.tip, fx.repo.git(&["rev-parse", "agent/liste"]));
    assert_eq!(review.from, fx.repo.git(&["merge-base", "main", &head]), "fork point from git");
    assert_eq!(fx.repo.git(&["rev-list", "--parents", "-n", "1", &review.to]), format!("{} {head}", review.to), "exactly one parent: the agent's HEAD");
    assert_eq!(blob(&fx.repo, &format!("{}:liste.txt", review.to)), CRLF_AGENT, "CRLF and the missing final newline stay");
    assert_eq!(blob(&fx.repo, &format!("{}:{ODD}", review.to)), LATIN1, "new file byte for byte");
    assert!(!fx.repo.git_output(&["cat-file", "-e", &format!("{}:debug.log", review.to)]).status.success(), "ignored files stay out");
    assert_eq!(review.uncommitted_files, 2);
    assert_eq!(review.worktree_repo_id, fx.tc.db.with(|c| db::repos::find_by_path(c, &fx.folder)).unwrap().map(|r| r.id));
    assert!(!review.running);
    assert_eq!(changed_paths(&fx, &review).await, vec![ODD.to_string(), "liste.txt".to_string()]);

    assert_eq!(fx.repo.git(&["for-each-ref", "--format=%(refname) %(objectname)"]), refs_before, "no ref was created");
    assert_eq!(git_in(&fx.repo, &fx.folder, &["status", "--porcelain=v1", "-z", "--untracked-files=all"]), agent_status_before, "the agent's files are untouched");
    assert_eq!(git_in(&fx.repo, &fx.folder, &["ls-files", "--stage", "-z"]), agent_index_before, "the agent's index is untouched");
    assert_eq!(fx.repo.git(&["status", "--porcelain"]), "", "my own working directory is untouched");
}

#[tokio::test]
async fn the_same_working_state_gives_the_same_snapshot_in_any_time_zone() {
    let fx = fixture().await;
    // The agent committed at a time in the Chatham Islands' summer time (+13:45).
    let head = agent_commit(&fx, "agent.txt", b"vom Agenten\n", "Agent arbeitet", Some("1750615200 +1345"));
    std::fs::write(fx.folder.join("liste.txt"), CRLF_AGENT).unwrap();
    let first = agent_review(&fx.tc, fx.row.id.clone(), AgentReviewSource::Snapshot).await.unwrap();
    assert_eq!(fx.repo.git(&["show", "-s", "--format=%ct", &first.to]), "1750615200", "the date of the agent's HEAD, not now");
    assert_eq!(fx.repo.git(&["rev-parse", &format!("{}^", first.to)]), head);
    let again = agent_review(&fx.tc, fx.row.id.clone(), AgentReviewSource::Snapshot).await.unwrap();
    assert_eq!(again.to, first.to, "nothing changed: the same commit");

    std::fs::write(fx.folder.join("liste.txt"), b"EINS\r\nzwei\r\ndrei").unwrap();
    let changed = agent_review(&fx.tc, fx.row.id.clone(), AgentReviewSource::Snapshot).await.unwrap();
    assert_ne!(changed.to, first.to, "a changed file gives a new snapshot");
    std::fs::write(fx.folder.join("liste.txt"), CRLF_AGENT).unwrap();
    let back = agent_review(&fx.tc, fx.row.id.clone(), AgentReviewSource::Snapshot).await.unwrap();
    assert_eq!(back.to, first.to, "the same state again: the same commit again");
}

#[tokio::test]
async fn a_clean_worktree_or_commits_only_compare_the_branch_tip() {
    let fx = fixture().await;
    let tip = agent_commit(&fx, "agent.txt", b"vom Agenten\n", "Agent", None);
    let clean = agent_review(&fx.tc, fx.row.id.clone(), AgentReviewSource::Snapshot).await.unwrap();
    assert_eq!((clean.source, clean.to.as_str(), clean.uncommitted_files), (AgentReviewSource::Branch, tip.as_str(), 0), "nothing uncommitted: the branch");

    std::fs::write(fx.folder.join("liste.txt"), CRLF_AGENT).unwrap();
    let commits_before = commit_objects(&fx.repo);
    let branch = agent_review(&fx.tc, fx.row.id.clone(), AgentReviewSource::Branch).await.unwrap();
    assert_eq!((branch.source, branch.to.as_str(), branch.uncommitted_files), (AgentReviewSource::Branch, tip.as_str(), 1));
    assert_eq!(changed_paths(&fx, &branch).await, vec!["agent.txt".to_string()], "only what the agent committed");
    assert_eq!(commit_objects(&fx.repo), commits_before, "“commits only” writes no snapshot commit");
}

/// Number of commit objects in the object database (loose and packed), counted by Git.
fn commit_objects(repo: &TestRepo) -> usize {
    repo.git(&["cat-file", "--batch-all-objects", "--batch-check=%(objecttype)"]).lines().filter(|kind| *kind == "commit").count()
}

#[tokio::test]
async fn the_base_is_the_fork_point_even_after_a_rebase_or_a_moved_base() {
    let fx = fixture().await;
    let fork = fx.row.base_sha.clone();
    agent_commit(&fx, "agent.txt", b"vom Agenten\n", "Agent", None);
    // main moves on with a commit the agent does not have.
    fx.repo.commit_file("main.txt", "weiter\n", "Main weiter");

    let moved = agent_review(&fx.tc, fx.row.id.clone(), AgentReviewSource::Branch).await.unwrap();
    assert_eq!(moved.from, fx.repo.git(&["merge-base", "main", "agent/liste"]));
    assert_eq!(moved.from, fork, "main's later commit is not the agent's base");
    assert_eq!(changed_paths(&fx, &moved).await, vec!["agent.txt".to_string()], "main's own commit does not show up reversed");

    // The agent rebases onto the new main.
    git_in(&fx.repo, &fx.folder, &["-c", "user.name=Agent", "-c", "user.email=agent@example.com", "rebase", "-q", "main"]);
    let rebased = agent_review(&fx.tc, fx.row.id.clone(), AgentReviewSource::Branch).await.unwrap();
    assert_eq!(rebased.from, fx.repo.git(&["rev-parse", "main"]), "fork point after the rebase");
    assert_eq!(changed_paths(&fx, &rebased).await, vec!["agent.txt".to_string()], "only the agent's work, not main's");

    // An agent whose base branch was deleted falls back to the recorded base commit.
    fx.repo.branch_at("release", &fork);
    let (other, _) = agent_at(&fx.tc, &fx.repo, &fx.id, "release-fix", "release").await;
    fx.repo.git(&["branch", "-D", "release"]);
    let gone = agent_review(&fx.tc, other.id.clone(), AgentReviewSource::Branch).await.unwrap();
    assert_eq!(gone.from, fork);
    assert_eq!(gone.base, "release");
}

#[tokio::test]
async fn unknown_and_orphaned_agents_are_refused() {
    let fx = fixture().await;
    assert_eq!(agent_review(&fx.tc, "gibt-es-nicht".into(), AgentReviewSource::Snapshot).await.unwrap_err().code, ErrorCode::NotFound);
    fx.repo.git(&["worktree", "remove", "--force", &fx.folder.to_string_lossy()]);
    let err = agent_review(&fx.tc, fx.row.id.clone(), AgentReviewSource::Snapshot).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed, "{err:?}");
    assert_eq!(err.message, ORPHANED);
}

// ---------------------------------------------------------------------------
// Taking a selection over (Paket 0's range_apply from the agent's diff) and committing it
// ---------------------------------------------------------------------------

use crate::commands::agents::agent_review_commit;
use crate::commands::diff::diff_file;
use crate::commands::range_apply::range_apply;
use crate::model::{DiffLineKind, FileDiff, HunkSelection, PatchSelection, RangeApplyTarget, TextDiff};

/// The agent changed the list (uncommitted, CRLF) and created the odd Latin-1 file.
async fn agent_work(fx: &Fx) -> AgentReview {
    std::fs::write(fx.folder.join("liste.txt"), CRLF_AGENT).unwrap();
    std::fs::write(fx.folder.join(ODD), LATIN1).unwrap();
    agent_review(&fx.tc, fx.row.id.clone(), AgentReviewSource::Snapshot).await.unwrap()
}

async fn range_diff(fx: &Fx, review: &AgentReview, path: &str) -> TextDiff {
    let source = DiffSource::Range { from: review.from.clone(), to: Some(review.to.clone()) };
    match diff_file(&fx.tc, fx.id.clone(), path.to_string(), source, None, None, None).await.unwrap() {
        FileDiff::Text(text) => text,
        other => panic!("{other:?}"),
    }
}

fn whole(diff: &TextDiff) -> PatchSelection {
    PatchSelection {
        path: diff.path.clone(),
        hunks: diff.hunks.iter().map(|hunk| HunkSelection { index: hunk.index, lines: None }).collect(),
        expect: diff.range_token.clone().expect("range token"),
    }
}

/// Only the changed lines with these texts, from the first hunk.
fn lines(diff: &TextDiff, texts: &[&str]) -> PatchSelection {
    let hunk = &diff.hunks[0];
    let picked: Vec<u32> =
        hunk.lines.iter().enumerate().filter(|(_, line)| line.kind != DiffLineKind::Context && texts.contains(&line.text.as_str())).map(|(index, _)| index as u32).collect();
    assert_eq!(picked.len(), texts.len(), "{:?}", hunk.lines);
    PatchSelection { path: diff.path.clone(), hunks: vec![HunkSelection { index: hunk.index, lines: Some(picked) }], expect: diff.range_token.clone().expect("range token") }
}

/// The list's first pair of lines and the whole new file.
async fn usual_selection(fx: &Fx, review: &AgentReview) -> Vec<PatchSelection> {
    let liste = range_diff(fx, review, "liste.txt").await;
    let odd = range_diff(fx, review, ODD).await;
    vec![lines(&liste, &["eins", "EINS"]), whole(&odd)]
}

fn staged(repo: &TestRepo) -> String {
    repo.git(&["-c", "core.quotepath=false", "diff", "--cached", "--name-only"])
}

#[tokio::test]
async fn taking_over_lines_from_the_agent_changes_only_my_working_directory() {
    let fx = fixture().await;
    let review = agent_work(&fx).await;
    let selection = usual_selection(&fx, &review).await;
    range_apply(&fx.tc, fx.id.clone(), review.from.clone(), review.to.clone(), selection, RangeApplyTarget::Worktree).await.unwrap();
    assert_eq!(fx.repo.read_file("liste.txt"), b"EINS\r\nzwei\r\ndrei", "only the first pair; CRLF and the missing final newline stay");
    assert_eq!(fx.repo.read_file(ODD), LATIN1, "the new file byte for byte");
    assert_eq!(staged(&fx.repo), "", "unstaged: the index is untouched");
    assert_eq!(std::fs::read(fx.folder.join("liste.txt")).unwrap(), CRLF_AGENT, "the agent's worktree keeps its state");
}

#[tokio::test]
async fn taking_over_staged_puts_the_lines_into_index_and_folder() {
    let fx = fixture().await;
    let review = agent_work(&fx).await;
    let liste = range_diff(&fx, &review, "liste.txt").await;
    range_apply(&fx.tc, fx.id.clone(), review.from.clone(), review.to.clone(), vec![lines(&liste, &["drei", "DREI"])], RangeApplyTarget::Both).await.unwrap();
    assert_eq!(fx.repo.git_output(&["show", ":liste.txt"]).stdout, b"eins\r\nzwei\r\nDREI");
    assert_eq!(fx.repo.read_file("liste.txt"), b"eins\r\nzwei\r\nDREI");
    assert_eq!(staged(&fx.repo), "liste.txt");
}

#[tokio::test]
async fn my_own_change_on_the_same_line_ends_in_a_conflict_and_changes_nothing() {
    let fx = fixture().await;
    let review = agent_work(&fx).await;
    let liste = range_diff(&fx, &review, "liste.txt").await;
    let mine: &[u8] = b"mein\r\nzwei\r\ndrei";
    fx.repo.write_file("liste.txt", mine);
    let err = range_apply(&fx.tc, fx.id.clone(), review.from.clone(), review.to.clone(), vec![whole(&liste)], RangeApplyTarget::Worktree).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict, "{err:?}");
    assert!(err.message.contains("liste.txt"), "names the file: {}", err.message);
    assert_eq!(fx.repo.read_file("liste.txt"), mine, "own change kept, no conflict markers");
}

#[tokio::test]
async fn commit_selection_commits_only_the_selection_on_my_branch() {
    let fx = fixture().await;
    let review = agent_work(&fx).await;
    let before = fx.repo.head();
    let selection = usual_selection(&fx, &review).await;
    let result = agent_review_commit(
        &fx.tc,
        fx.row.id.clone(),
        "op-review-1".into(),
        review.from.clone(),
        review.to.clone(),
        selection,
        "Liste groß schreiben".into(),
        "und die Größe ergänzen".into(),
        false,
    )
    .await
    .unwrap();
    assert_eq!(result.sha, fx.repo.head());
    assert_eq!(fx.repo.git(&["rev-parse", "HEAD^"]), before, "one new commit on top");
    assert_eq!(fx.repo.current_branch(), "main");
    assert_eq!(fx.repo.git(&["log", "-1", "--format=%B"]), "Liste groß schreiben\n\nund die Größe ergänzen");
    let mut files: Vec<String> =
        fx.repo.git(&["-c", "core.quotepath=false", "show", "--format=", "--name-only", "HEAD"]).lines().filter(|line| !line.is_empty()).map(str::to_string).collect();
    files.sort();
    assert_eq!(files, vec![ODD.to_string(), "liste.txt".to_string()]);
    assert_eq!(fx.repo.git_output(&["show", "HEAD:liste.txt"]).stdout, b"EINS\r\nzwei\r\ndrei");
    assert_eq!(blob(&fx.repo, &format!("HEAD:{ODD}")), LATIN1);
    assert_eq!(fx.repo.git(&["status", "--porcelain"]), "", "nothing is left over in my working directory");
    assert_eq!(fx.repo.git(&["rev-parse", "agent/liste"]), review.tip, "the agent's branch did not move");
    assert_eq!(std::fs::read(fx.folder.join("liste.txt")).unwrap(), CRLF_AGENT);
}

#[tokio::test]
async fn commit_selection_refuses_a_staging_area_with_my_own_changes() {
    let fx = fixture().await;
    let review = agent_work(&fx).await;
    let before = fx.repo.head();
    fx.repo.write_file("eigen.txt", "meins\n");
    fx.repo.git(&["add", "eigen.txt"]);
    let selection = usual_selection(&fx, &review).await;
    let err = agent_review_commit(&fx.tc, fx.row.id.clone(), "op-review-2".into(), review.from.clone(), review.to.clone(), selection, "Liste".into(), String::new(), false)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed, "{err:?}");
    assert_eq!(err.message, STAGED);
    assert_eq!(fx.repo.head(), before, "nothing committed");
    assert_eq!(fx.repo.read_file("liste.txt"), CRLF_BASE, "nothing taken over");
    assert!(!fx.repo.path().join(ODD).exists());
    assert_eq!(staged(&fx.repo), "eigen.txt", "my own staged change stays as it was");
}

#[tokio::test]
async fn commit_selection_without_a_summary_or_a_selection_changes_nothing() {
    let fx = fixture().await;
    let review = agent_work(&fx).await;
    let selection = usual_selection(&fx, &review).await;
    let empty = agent_review_commit(&fx.tc, fx.row.id.clone(), "op-review-3".into(), review.from.clone(), review.to.clone(), selection, "   ".into(), String::new(), false)
        .await
        .unwrap_err();
    assert_eq!(empty.code, ErrorCode::EmptyMessage);
    let nothing = agent_review_commit(&fx.tc, fx.row.id.clone(), "op-review-4".into(), review.from.clone(), review.to.clone(), Vec::new(), "Liste".into(), String::new(), false)
        .await
        .unwrap_err();
    assert_eq!(nothing.code, ErrorCode::NothingToCommit);
    assert_eq!(fx.repo.read_file("liste.txt"), CRLF_BASE);
    assert_eq!(staged(&fx.repo), "");
}

#[tokio::test]
async fn commit_selection_refuses_while_a_merge_is_in_progress() {
    let fx = fixture().await;
    let review = agent_work(&fx).await;
    let selection = usual_selection(&fx, &review).await;
    // A real merge conflict in my repository: README.md changed on both sides.
    fx.repo.checkout_new("seite");
    fx.repo.commit_file("README.md", "# Seite\n", "Seite");
    fx.repo.checkout("main");
    fx.repo.commit_file("README.md", "# Haupt\n", "Haupt");
    assert!(!fx.repo.git_output(&["merge", "seite"]).status.success(), "the merge stops at the conflict");
    let before = fx.repo.head();
    let err = agent_review_commit(&fx.tc, fx.row.id.clone(), "op-review-6".into(), review.from.clone(), review.to.clone(), selection, "Liste".into(), String::new(), false)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::OperationInProgress, "{err:?}");
    assert_eq!(err.message, OPERATION);
    assert_eq!(fx.repo.head(), before, "nothing committed");
    assert!(fx.repo.path().join(".git").join("MERGE_HEAD").exists(), "the merge is left as it was");
    assert_eq!(fx.repo.read_file("liste.txt"), CRLF_BASE, "nothing taken over");
    assert!(!fx.repo.path().join(ODD).exists());
}

#[cfg(unix)]
#[tokio::test]
async fn a_failing_hook_keeps_the_selection_staged() {
    use std::os::unix::fs::PermissionsExt;
    let fx = fixture().await;
    let review = agent_work(&fx).await;
    let before = fx.repo.head();
    let hooks = fx.repo.path().join(".git").join("hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    std::fs::write(hooks.join("pre-commit"), "#!/bin/sh\necho 'Linter: Fehler' >&2\nexit 3\n").unwrap();
    std::fs::set_permissions(hooks.join("pre-commit"), std::fs::Permissions::from_mode(0o755)).unwrap();
    let selection = usual_selection(&fx, &review).await;
    let err = agent_review_commit(&fx.tc, fx.row.id.clone(), "op-review-5".into(), review.from.clone(), review.to.clone(), selection, "Liste".into(), String::new(), false)
        .await
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::HookFailed, "{err:?}");
    assert!(err.message.ends_with(STAYS_STAGED), "{}", err.message);
    assert_eq!(fx.repo.head(), before);
    let mut list: Vec<String> = staged(&fx.repo).lines().filter(|line| !line.is_empty()).map(str::to_string).collect();
    list.sort();
    assert_eq!(list, vec![ODD.to_string(), "liste.txt".to_string()], "the selection stays staged");
    assert_eq!(fx.repo.git_output(&["show", ":liste.txt"]).stdout, b"EINS\r\nzwei\r\ndrei");
}
