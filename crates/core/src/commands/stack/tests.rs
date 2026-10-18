//! Stacked pull requests against real temporary repositories (and a bare remote).

use super::*;
use crate::error::ErrorCode;
use crate::model::StackCut;
use crate::testkit::{TestCore, TestRepo};

pub(crate) const BRANCH: &str = "feature/auswertung";
pub(crate) const MAIN: &str = "refs/heads/main";
pub(crate) const P1: &str = "feature/auswertung-1-datenmodell-und-import";
pub(crate) const P2: &str = "feature/auswertung-2-auswertung";
pub(crate) const P3: &str = "feature/auswertung-3-diagramme";

/// `main` (README) and `feature/auswertung` with four commits: a file with CRLF, a path with a
/// leading `-`, an umlaut and a space, a rename and a binary file; the second commit was written
/// years before the first (rebased), author dates in other time zones. An uncommitted change and an
/// untracked file stay in the working directory.
pub(crate) fn stack_repo() -> TestRepo {
    let repo = TestRepo::with_commit();
    repo.checkout_new(BRANCH);
    repo.write_file("src/modell.rs", "pub struct Station;\r\n");
    repo.commit_as_dates("Datenmodell für Stationen", "Lena Ölmann", "lena@example.org", "@1760000000 +1400", "@1760000000 +1400");
    repo.write_file("import/-messwerte ä.csv", "datum;wert\r\n2026-01-01;3,5\r\n");
    repo.commit_as_dates("Import der Messwerte\n\nCSV mit Semikolon.", "Jo Ånström", "jo@example.org", "@1600000000 -0930", "@1760000100 +0000");
    repo.git(&["mv", "src/modell.rs", "src/station.rs"]);
    repo.commit_as_dates("Auswertung je Monat", "Lena Ölmann", "lena@example.org", "@1760000200 +0530", "@1760000200 +0530");
    repo.write_file("diagramme/übersicht.png", [0x89u8, b'P', b'N', b'G', 0, 1, 2, 3]);
    repo.commit_as_dates("Diagramme", "Lena Ölmann", "lena@example.org", "@1760000300 -0300", "@1760000300 -0300");
    repo.write_file("README.md", "# Test\n\nnoch nicht committet\n");
    repo.write_file("notizen.txt", "unversioniert\n");
    repo
}

pub(crate) async fn opened(repo: &TestRepo) -> (TestCore, String) {
    let tc = TestCore::new().await;
    let id = tc.open(repo).await.repo.id;
    (tc, id)
}

pub(crate) fn cut(end: u32, name: &str) -> StackCut {
    StackCut { end, name: name.into() }
}

/// Commits 1–2, 3 and 4; the third name is empty (the subject of commit 4 is used).
pub(crate) fn three_parts() -> Vec<StackCut> {
    vec![cut(2, "Datenmodell und Import"), cut(3, "Auswertung"), cut(4, "")]
}

pub(crate) fn sha_of(repo: &TestRepo, rev: &str) -> Option<String> {
    let out = repo.git_output(&["rev-parse", "--verify", "-q", rev]);
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

#[tokio::test]
async fn the_plan_lists_the_branch_commits_oldest_first_as_git_does() {
    let repo = stack_repo();
    let (tc, id) = opened(&repo).await;
    let plan = stack_plan(&tc, id, BRANCH.into(), MAIN.into(), vec![]).await.unwrap();
    // Oracle: Git's own order and statistics.
    let shas: Vec<String> = repo.git(&["log", "--reverse", "--format=%H", "main..feature/auswertung"]).lines().map(str::to_string).collect();
    assert_eq!(plan.commits.iter().map(|c| c.sha.clone()).collect::<Vec<_>>(), shas);
    assert_eq!(
        plan.commits.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(),
        ["Datenmodell für Stationen", "Import der Messwerte", "Auswertung je Monat", "Diagramme"],
        "Git's order, although the second commit was written years before the first"
    );
    for commit in &plan.commits {
        let numstat = repo.git(&["diff-tree", "--numstat", "-r", "-M", "--no-commit-id", &commit.sha]);
        let lines: Vec<&str> = numstat.lines().collect();
        let added: u64 = lines.iter().filter_map(|line| line.split('\t').next()?.parse::<u64>().ok()).sum();
        assert_eq!((commit.files as usize, commit.added), (lines.len(), added), "{}", commit.subject);
    }
    assert_eq!(plan.tip, repo.git(&["rev-parse", BRANCH]));
    assert_eq!(plan.base_sha, repo.git(&["rev-parse", "main"]));
    assert_eq!((plan.branch.as_str(), plan.base.as_str(), plan.base_name.as_str()), (BRANCH, MAIN, "main"));
    assert_eq!(plan.parts.len(), 1, "without cuts: one part");
    let part = &plan.parts[0];
    assert_eq!((part.number, part.first, part.end, part.branch.as_str(), part.problem.clone()), (1, 1, 4, "feature/auswertung-1-datenmodell-fuer", None));
    assert_eq!(part.tip, plan.tip);
}

#[tokio::test]
async fn cuts_become_numbered_branches_at_the_right_commits() {
    let repo = stack_repo();
    let (tc, id) = opened(&repo).await;
    let plan = stack_plan(&tc, id, format!("refs/heads/{BRANCH}"), MAIN.into(), three_parts()).await.unwrap();
    let got: Vec<(u32, u32, &str, String)> = plan.parts.iter().map(|p| (p.first, p.end, p.branch.as_str(), p.tip.clone())).collect();
    assert_eq!(
        got,
        vec![
            (1, 2, P1, repo.git(&["rev-parse", "feature/auswertung~2"])),
            (3, 3, P2, repo.git(&["rev-parse", "feature/auswertung~1"])),
            (4, 4, P3, repo.git(&["rev-parse", BRANCH])),
        ]
    );
    assert!(plan.parts.iter().all(|p| p.problem.is_none()));
    assert_eq!(repo.git(&["for-each-ref", "--format=%(refname)", "refs/heads"]).lines().count(), 2, "planning creates nothing");
}

#[tokio::test]
async fn names_in_use_are_reported_per_part_as_git_would_refuse_them() {
    let repo = stack_repo();
    repo.branch_at(P2, "main");
    repo.branch_at(&format!("{P1}/alt"), "main");
    let (tc, id) = opened(&repo).await;
    // Oracle: Git itself refuses both names.
    assert!(!repo.git_output(&["branch", P1, "main"]).status.success(), "Git: a branch below that name exists");
    assert!(!repo.git_output(&["branch", P2, "main"]).status.success(), "Git: the branch exists");
    let plan = stack_plan(&tc, id, BRANCH.into(), MAIN.into(), three_parts()).await.unwrap();
    assert_eq!(plan.parts[0].problem.as_deref(), Some(format!("The branch “{P1}/alt” blocks the name “{P1}”.").as_str()));
    assert_eq!(plan.parts[1].problem.as_deref(), Some(format!("A branch “{P2}” already exists.").as_str()));
    assert_eq!(plan.parts[2].problem, None);
}

#[tokio::test]
async fn merges_empty_ranges_and_bad_input_are_refused_before_anything_happens() {
    let repo = stack_repo();
    let (tc, id) = opened(&repo).await;
    let plan = |branch: &str, base: &str, cuts: Vec<StackCut>| stack_plan(&tc, id.clone(), branch.to_string(), base.to_string(), cuts);
    assert_eq!(plan(BRANCH, MAIN, vec![cut(2, "a"), cut(3, "b")]).await.unwrap_err().code, ErrorCode::NotAllowed, "the last part must end at the tip");
    assert_eq!(plan(BRANCH, "main", vec![]).await.unwrap_err().code, ErrorCode::NotAllowed, "the base as a full ref name");
    assert_eq!(plan(BRANCH, "refs/heads/feature/auswertung", vec![]).await.unwrap_err().code, ErrorCode::NotAllowed, "not onto itself");
    assert_eq!(plan("-x", MAIN, vec![]).await.unwrap_err().code, ErrorCode::InvalidName);
    assert_eq!(plan("gibt-es-nicht", MAIN, vec![]).await.unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(plan(BRANCH, "refs/heads/gibt-es-nicht", vec![]).await.unwrap_err().code, ErrorCode::NotFound);
    let error = plan("main", "refs/heads/feature/auswertung", vec![]).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::NotAllowed);
    assert_eq!(error.message, "“main” has no commits that “feature/auswertung” does not have.");

    // A merge in the range: cuts at commit boundaries need a straight history.
    repo.git(&["stash", "-u"]);
    repo.checkout("main");
    repo.commit_file("main.txt", "neu\n", "Main weiter");
    repo.checkout(BRANCH);
    assert!(repo.merge("main"));
    let error = plan(BRANCH, MAIN, vec![]).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::NotAllowed);
    assert!(error.message.contains("merge commits"), "{}", error.message);

    crate::commands::trust::repo_trust_set(&tc, id.clone(), false).await.unwrap();
    assert_eq!(plan(BRANCH, MAIN, vec![]).await.unwrap_err().code, ErrorCode::RepoUntrusted);
}

#[tokio::test]
async fn more_than_a_hundred_commits_are_refused() {
    let repo = TestRepo::with_commit();
    repo.checkout_new("lang");
    for n in 1..=101 {
        repo.empty_commit(&format!("Schritt {n}"));
    }
    let (tc, id) = opened(&repo).await;
    let error = stack_plan(&tc, id, "lang".into(), MAIN.into(), vec![]).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::NotAllowed);
    assert_eq!(error.message, "“lang” has 101 commits; a stack is cut from at most 100.");
}

// --- Creating and reading back (Task 4) ---------------------------------------------------------

/// `stack_repo` opened and split into the three parts of `three_parts`.
pub(crate) async fn created(repo: &TestRepo) -> (TestCore, String) {
    let (tc, id) = opened(repo).await;
    let plan = stack_plan(&tc, id.clone(), BRANCH.into(), MAIN.into(), three_parts()).await.unwrap();
    stack_create(&tc, id.clone(), BRANCH.into(), MAIN.into(), three_parts(), plan.base_sha, plan.tip).await.unwrap();
    (tc, id)
}

fn worktree_state(repo: &TestRepo) -> String {
    repo.git(&["status", "--porcelain=v1", "-z", "--untracked-files=all"])
}

#[tokio::test]
async fn creating_moves_only_refs_and_lands_on_gits_commits() {
    let repo = stack_repo();
    let (tc, id) = opened(&repo).await;
    let plan = stack_plan(&tc, id.clone(), BRANCH.into(), MAIN.into(), three_parts()).await.unwrap();
    let before = worktree_state(&repo);
    let readme = repo.read_file("README.md");
    let index_tree = repo.git(&["write-tree"]);
    let created = stack_create(&tc, id.clone(), BRANCH.into(), MAIN.into(), three_parts(), plan.base_sha.clone(), plan.tip.clone()).await.unwrap();

    // Oracle: the commits Git names relative to the branch tip.
    assert_eq!(sha_of(&repo, P1), sha_of(&repo, "feature/auswertung~2"));
    assert_eq!(sha_of(&repo, P2), sha_of(&repo, "feature/auswertung~1"));
    assert_eq!(sha_of(&repo, P3), sha_of(&repo, BRANCH));
    assert_eq!(repo.current_branch(), BRANCH, "nothing was checked out");
    assert_eq!(worktree_state(&repo), before, "working directory and untracked files untouched");
    assert_eq!(repo.git(&["write-tree"]), index_tree, "index untouched");
    assert_eq!(repo.read_file("README.md"), readme);

    assert_eq!(repo.git(&["config", &format!("branch.{P1}.forkyardStackParent")]), MAIN);
    assert_eq!(repo.git(&["config", &format!("branch.{P2}.forkyardStackParent")]), format!("refs/heads/{P1}"));
    assert_eq!(repo.git(&["config", &format!("branch.{P3}.forkyardStackParent")]), format!("refs/heads/{P2}"));
    assert_eq!(created.parts.iter().map(|p| p.branch.as_str()).collect::<Vec<_>>(), [P1, P2, P3]);
    assert_eq!((created.base.as_str(), created.base_name.as_str()), (MAIN, "main"));
    assert!(created.restack.is_none());
}

#[tokio::test]
async fn undo_removes_every_stack_branch_and_redo_brings_them_back() {
    let repo = stack_repo();
    let (tc, id) = created(&repo).await;
    let tips: Vec<Option<String>> = [P1, P2, P3].iter().map(|b| sha_of(&repo, b)).collect();
    let step = crate::commands::undo::undo_peek(&tc, id.clone()).await.unwrap().undo.expect("one undo step");
    assert_eq!(step.action, "stack_create");
    assert_eq!(step.label, "Undo splitting “feature/auswertung” into 3 stacked branches");

    crate::commands::undo::undo(&tc, id.clone()).await.unwrap();
    for branch in [P1, P2, P3] {
        assert_eq!(sha_of(&repo, branch), None, "{branch} removed");
    }
    assert_eq!(repo.current_branch(), BRANCH);
    assert_eq!(repo.read_file("notizen.txt"), b"unversioniert\n");

    crate::commands::undo::redo(&tc, id.clone()).await.unwrap();
    assert_eq!([P1, P2, P3].iter().map(|b| sha_of(&repo, b)).collect::<Vec<_>>(), tips);

    // A part moved meanwhile: the step is no longer offered (Paket 0 checks every ref of a group).
    repo.git(&["update-ref", &format!("refs/heads/{P2}"), "main"]);
    assert!(crate::commands::undo::undo_peek(&tc, id).await.unwrap().undo.is_none());
}

#[tokio::test]
async fn a_moved_branch_or_a_taken_name_creates_nothing() {
    let repo = stack_repo();
    let (tc, id) = opened(&repo).await;
    let plan = stack_plan(&tc, id.clone(), BRANCH.into(), MAIN.into(), three_parts()).await.unwrap();
    let create = || stack_create(&tc, id.clone(), BRANCH.into(), MAIN.into(), three_parts(), plan.base_sha.clone(), plan.tip.clone());

    repo.branch_at(P2, "main");
    let error = create().await.unwrap_err();
    assert_eq!(error.code, ErrorCode::NameExists);
    assert_eq!(error.message, format!("A branch “{P2}” already exists."));
    assert_eq!((sha_of(&repo, P1), sha_of(&repo, P3)), (None, None), "all or nothing");

    repo.git(&["branch", "-D", P2]);
    repo.git(&["stash", "-u"]);
    repo.commit_file("spaet.txt", "später\n", "Später");
    assert_eq!(create().await.unwrap_err().code, ErrorCode::StaleState, "the branch moved since the plan was shown");
    assert_eq!([P1, P2, P3].iter().map(|b| sha_of(&repo, b)).collect::<Vec<_>>(), [None, None, None]);
    assert!(!repo.git_output(&["config", &format!("branch.{P1}.forkyardStackParent")]).status.success(), "no parent link written");
    assert!(crate::commands::undo::undo_peek(&tc, id).await.unwrap().undo.is_none(), "no undo step for nothing");
}

#[tokio::test]
async fn the_status_follows_the_parent_links_in_the_config() {
    let repo = stack_repo();
    let (tc, id) = created(&repo).await;
    for start in [P1, P2, P3] {
        let status = stack_status(&tc, id.clone(), start.into()).await.unwrap().expect("part of a stack");
        assert_eq!(status.parts.iter().map(|p| p.branch.as_str()).collect::<Vec<_>>(), [P1, P2, P3], "from {start}");
    }
    let status = stack_status(&tc, id.clone(), P1.into()).await.unwrap().unwrap();
    assert_eq!(status.parts.iter().map(|p| p.parent.clone()).collect::<Vec<_>>(), vec![MAIN.to_string(), format!("refs/heads/{P1}"), format!("refs/heads/{P2}")]);
    assert!(status.parts.iter().all(|p| p.contains_parent));
    assert_eq!(status.parts[0].subjects, ["Datenmodell für Stationen", "Import der Messwerte"]);
    assert_eq!(status.parts[2].subjects, ["Diagramme"]);
    assert_eq!(status.parts[0].tip, repo.git(&["rev-parse", "feature/auswertung~2"]));
    assert!(status.parts.iter().all(|p| p.worktree_path.is_none()), "no part is checked out");
    assert!(status.restack.is_none());
    assert_eq!(stack_status(&tc, id.clone(), BRANCH.into()).await.unwrap(), None, "the split branch itself is no part");
    assert_eq!(stack_status(&tc, id.clone(), "main".into()).await.unwrap(), None);

    crate::commands::undo::undo(&tc, id.clone()).await.unwrap();
    assert_eq!(stack_status(&tc, id.clone(), P2.into()).await.unwrap(), None, "undone: the parts are gone");
    crate::commands::undo::redo(&tc, id.clone()).await.unwrap();
    assert!(stack_status(&tc, id, P2.into()).await.unwrap().is_some(), "redo: the parent links in the config still hold");
}

// --- Restack (Task 5) ---------------------------------------------------------------------------

use crate::model::OpResult;

/// Stashes the uncommitted changes and adds a commit to part 1 (checked out here afterwards).
pub(crate) fn change_part_one(repo: &TestRepo, file: &str) {
    repo.git(&["stash", "-u"]);
    repo.checkout(P1);
    repo.commit_file(file, "Nachtrag\n", "Nachtrag zum Datenmodell");
}

#[tokio::test]
async fn a_new_commit_on_a_lower_part_is_pulled_through_the_stack() {
    let repo = stack_repo();
    let (tc, id) = created(&repo).await;
    change_part_one(&repo, "src/notiz.md");
    let old_top = sha_of(&repo, P3).unwrap();
    let status = stack_status(&tc, id.clone(), P3.into()).await.unwrap().unwrap();
    assert_eq!(status.parts.iter().map(|p| p.contains_parent).collect::<Vec<_>>(), [true, false, true]);
    let restack = status.restack.expect("restack offered");
    assert_eq!(restack.onto, format!("refs/heads/{P1}"));
    assert_eq!((restack.top.as_str(), restack.top_tip.as_str()), (P3, old_top.as_str()));
    assert_eq!(restack.moves, [BRANCH, P2], "what --update-refs moves: the split branch points at the top and is not checked out");
    assert!(restack.left_behind.is_empty() && restack.blocked.is_none());

    assert_eq!(stack_restack(&tc, id.clone(), P3.into(), "0".repeat(40)).await.unwrap_err().code, ErrorCode::StaleState);
    let result = stack_restack(&tc, id.clone(), P3.into(), old_top).await.unwrap();
    assert!(matches!(result, OpResult::Done { .. }), "{result:?}");
    // Oracle: Git's ancestry.
    for (lower, upper) in [(P1, P2), (P2, P3)] {
        assert!(repo.git_output(&["merge-base", "--is-ancestor", lower, upper]).status.success(), "{lower} in {upper}");
    }
    assert_eq!(repo.git(&["rev-list", "--count", &format!("{P1}..{P3}")]), "2", "the commits of parts 2 and 3, once each");
    assert_eq!(sha_of(&repo, BRANCH), sha_of(&repo, P3), "the split branch moved along");
    assert!(stack_status(&tc, id.clone(), P1.into()).await.unwrap().unwrap().restack.is_none());
    assert_eq!(stack_restack(&tc, id.clone(), P1.into(), "x".into()).await.unwrap_err().code, ErrorCode::NotAllowed, "up to date");
    assert_eq!(stack_restack(&tc, id, BRANCH.into(), "x".into()).await.unwrap_err().code, ErrorCode::NotFound, "no part");
}

#[tokio::test]
async fn parts_checked_out_in_a_worktree_stay_behind_and_a_checked_out_top_blocks() {
    let repo = stack_repo();
    let (tc, id) = created(&repo).await;
    change_part_one(&repo, "src/notiz.md");
    let other = repo.temp_dir().join("zweiter Baum");
    repo.git(&["worktree", "add", "-q", other.to_str().unwrap(), P2]);
    let old_p2 = sha_of(&repo, P2);
    let restack = stack_status(&tc, id.clone(), P2.into()).await.unwrap().unwrap().restack.unwrap();
    assert_eq!(restack.left_behind, [P2]);
    assert_eq!(restack.moves, [BRANCH], "Git does not move a branch checked out in a worktree");
    stack_restack(&tc, id.clone(), P2.into(), restack.top_tip.clone()).await.unwrap();
    assert_eq!(sha_of(&repo, P2), old_p2, "left behind, as the hint said");
    assert!(repo.git_output(&["merge-base", "--is-ancestor", P1, P3]).status.success());

    // The top part checked out in another worktree: restacking here would fail, so it is blocked.
    repo.git(&["worktree", "remove", other.to_str().unwrap()]);
    repo.checkout(P1);
    repo.commit_file("src/notiz2.md", "Noch einer\n", "Zweiter Nachtrag");
    let third = repo.temp_dir().join("oben");
    repo.git(&["worktree", "add", "-q", third.to_str().unwrap(), P3]);
    let restack = stack_status(&tc, id.clone(), P1.into()).await.unwrap().unwrap().restack.unwrap();
    assert!(restack.blocked.as_deref().is_some_and(|reason| reason.contains("checked out in another worktree")), "{:?}", restack.blocked);
    assert_eq!(stack_restack(&tc, id, P1.into(), restack.top_tip).await.unwrap_err().code, ErrorCode::NotAllowed);
}

// --- Push (Task 6) ------------------------------------------------------------------------------

use crate::model::{PushRefStatus, PushResult};
use crate::testkit::TestRemote;

/// `stack_repo` with a bare remote `origin` that has `main`.
fn with_remote() -> (TestRepo, TestRemote) {
    let repo = stack_repo();
    let remote = TestRemote::new();
    repo.git(&["remote", "add", "origin", &remote.url()]);
    repo.git(&["push", "-q", "origin", "main"]);
    (repo, remote)
}

fn remote_sha(remote: &TestRemote, branch: &str) -> Option<String> {
    let out = remote.git_output(&["rev-parse", "--verify", "-q", &format!("refs/heads/{branch}")]);
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn all_parts() -> Vec<String> {
    vec![P1.to_string(), P2.to_string(), P3.to_string()]
}

fn statuses(result: &PushResult) -> Vec<PushRefStatus> {
    let PushResult::Multi { refs, .. } = result else { panic!("expected one result per part, got {result:?}") };
    refs.iter().map(|r| r.status).collect()
}

#[tokio::test]
async fn all_parts_go_out_in_one_push_with_their_upstreams() {
    let (repo, remote) = with_remote();
    let (tc, id) = created(&repo).await;
    let result = stack_push(&tc, id.clone(), util::new_id(), all_parts(), "origin".into(), false, None).await.unwrap();
    assert!(matches!(result, PushResult::Multi { atomic: true, .. }), "{result:?}");
    assert_eq!(statuses(&result), [PushRefStatus::Ok; 3]);
    for branch in [P1, P2, P3] {
        assert_eq!(remote_sha(&remote, branch), sha_of(&repo, branch), "{branch} on the remote");
        assert_eq!(repo.git(&["config", &format!("branch.{branch}.remote")]), "origin");
        assert_eq!(repo.git(&["config", &format!("branch.{branch}.merge")]), format!("refs/heads/{branch}"));
    }
}

#[tokio::test]
async fn one_rejected_part_pushes_nothing() {
    let (repo, remote) = with_remote();
    let (tc, id) = created(&repo).await;
    // Someone else's commit is already on the remote under the name of part 2.
    let other = TestRepo::clone_of(&remote);
    other.commit_file("fremd.txt", "fremd\n", "Fremder Stand");
    other.git(&["push", "-q", "origin", &format!("HEAD:refs/heads/{P2}")]);
    let result = stack_push(&tc, id.clone(), util::new_id(), all_parts(), "origin".into(), false, None).await.unwrap();
    assert_eq!(statuses(&result), [PushRefStatus::Rejected; 3], "atomic: one refusal refuses all");
    assert_eq!((remote_sha(&remote, P1), remote_sha(&remote, P3)), (None, None), "nothing arrived");
    for branch in [P1, P3] {
        assert!(!repo.git_output(&["config", &format!("branch.{branch}.merge")]).status.success(), "no upstream for {branch}");
    }
}

#[tokio::test]
async fn restacked_parts_need_force_with_lease() {
    let (repo, remote) = with_remote();
    let (tc, id) = created(&repo).await;
    stack_push(&tc, id.clone(), util::new_id(), all_parts(), "origin".into(), false, None).await.unwrap();
    change_part_one(&repo, "src/notiz.md");
    let top = stack_status(&tc, id.clone(), P1.into()).await.unwrap().unwrap().restack.unwrap().top_tip;
    stack_restack(&tc, id.clone(), P1.into(), top).await.unwrap();

    let plain = stack_push(&tc, id.clone(), util::new_id(), all_parts(), "origin".into(), false, None).await.unwrap();
    assert_eq!(statuses(&plain), [PushRefStatus::Rejected; 3], "rewritten parts are no fast-forward, and the push is atomic");
    let forced = stack_push(&tc, id.clone(), util::new_id(), all_parts(), "origin".into(), true, None).await.unwrap();
    assert_eq!(statuses(&forced), [PushRefStatus::Ok; 3]);
    for branch in [P1, P2, P3] {
        assert_eq!(remote_sha(&remote, branch), sha_of(&repo, branch), "{branch}");
    }
}

#[tokio::test]
async fn bad_push_input_sends_nothing() {
    let (repo, remote) = with_remote();
    let (tc, id) = created(&repo).await;
    let push = |branches: Vec<String>, remote: &str| stack_push(&tc, id.clone(), util::new_id(), branches, remote.to_string(), false, None);
    assert_eq!(push(vec![], "origin").await.unwrap_err().code, ErrorCode::NotAllowed);
    assert_eq!(push(vec![P1.into(), P1.into()], "origin").await.unwrap_err().code, ErrorCode::NotAllowed);
    assert_eq!(push(all_parts(), "--mirror").await.unwrap_err().code, ErrorCode::NotAllowed);
    assert_eq!(push(vec![P1.into(), "-x".into()], "origin").await.unwrap_err().code, ErrorCode::InvalidName);
    assert_eq!(remote_sha(&remote, P1), None);
}

// --- Check each part (Task 8; `sh -c` and POSIX tools, so Unix only) -----------------------------

#[cfg(unix)]
mod checks {
    use serde_json::json;

    use super::*;
    use crate::commands::settings::repo_settings_set;
    use crate::model::StackCheckState;

    fn agents_folder(repo: &TestRepo) -> std::path::PathBuf {
        // Entscheidung 3 written out: `<parent>/<repo>.agents` – not from `names::agents_dir`.
        repo.temp_dir().join("repo.agents")
    }

    /// `pruefen`: commit 1 without `ok.txt`, commit 2 adds it. The own working directory is dirty.
    fn checked_repo() -> TestRepo {
        let repo = TestRepo::with_commit();
        repo.checkout_new("pruefen");
        repo.commit_file("a.txt", "a\n", "Ohne Prüfdatei");
        repo.commit_file("ok.txt", "ok\n", "Prüfdatei");
        repo.write_file("README.md", "# Test\n\nungespeichert\n");
        repo
    }

    fn worktrees(repo: &TestRepo) -> usize {
        repo.git(&["worktree", "list", "--porcelain"]).lines().filter(|line| line.starts_with("worktree ")).count()
    }

    #[tokio::test]
    async fn each_part_is_checked_in_its_own_temporary_worktree() {
        let repo = checked_repo();
        let (tc, id) = opened(&repo).await;
        repo_settings_set(&tc, id.clone(), json!({ "testCommand": "test -f ok.txt && pwd && echo grün" })).await.unwrap();
        let results = stack_check(&tc, id.clone(), "chk-1".into(), "pruefen".into(), MAIN.into(), vec![cut(1, "Ohne"), cut(2, "Mit")]).await.unwrap();
        assert_eq!(results.iter().map(|r| (r.part, r.state)).collect::<Vec<_>>(), [(1, StackCheckState::Failed), (2, StackCheckState::Passed)]);
        assert_eq!(results[0].exit_code, Some(1), "POSIX `test` exits with 1 when the file is missing");
        assert_eq!(results[0].tip, repo.git(&["rev-parse", "pruefen~1"]));
        assert!(results[1].output.contains("grün"), "{}", results[1].output);
        assert!(results[1].output.contains("stack-check-2"), "ran in the part's temporary worktree: {}", results[1].output);
        let folder = agents_folder(&repo);
        assert!(!folder.join("stack-check-1").exists() && !folder.join("stack-check-2").exists(), "temporary worktrees removed");
        assert_eq!(worktrees(&repo), 1, "only the main worktree is left");
        assert_eq!(repo.read_file("README.md"), b"# Test\n\nungespeichert\n", "the own working directory may be dirty and stays so");
        assert_eq!(repo.current_branch(), "pruefen");
    }

    #[tokio::test]
    async fn without_a_test_command_nothing_runs_and_a_foreign_folder_is_left_alone() {
        let repo = checked_repo();
        let (tc, id) = opened(&repo).await;
        let cuts = || vec![cut(1, ""), cut(2, "")];
        let error = stack_check(&tc, id.clone(), "chk-2".into(), "pruefen".into(), MAIN.into(), cuts()).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::NotAllowed);
        assert!(error.message.contains("no test command"), "{}", error.message);

        repo_settings_set(&tc, id.clone(), json!({ "testCommand": "true" })).await.unwrap();
        let foreign = agents_folder(&repo).join("stack-check-1");
        std::fs::create_dir_all(&foreign).unwrap();
        std::fs::write(foreign.join("eigene Notiz.txt"), "bleibt\n").unwrap();
        let error = stack_check(&tc, id.clone(), "chk-3".into(), "pruefen".into(), MAIN.into(), cuts()).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::PathExists);
        assert_eq!(std::fs::read(foreign.join("eigene Notiz.txt")).unwrap(), b"bleibt\n", "not Forkyard's: untouched");
        assert_eq!(worktrees(&repo), 1);
    }

    #[tokio::test]
    async fn a_leftover_worktree_of_an_earlier_check_is_replaced() {
        let repo = checked_repo();
        let (tc, id) = opened(&repo).await;
        repo_settings_set(&tc, id.clone(), json!({ "testCommand": "test -f ok.txt" })).await.unwrap();
        let leftover = agents_folder(&repo).join("stack-check-1");
        std::fs::create_dir_all(agents_folder(&repo)).unwrap();
        repo.git(&["worktree", "add", "-q", "--detach", leftover.to_str().unwrap(), "main"]);
        let results = stack_check(&tc, id.clone(), "chk-4".into(), "pruefen".into(), MAIN.into(), vec![cut(2, "")]).await.unwrap();
        assert_eq!(results.iter().map(|r| r.state).collect::<Vec<_>>(), [StackCheckState::Passed], "the leftover at main has no ok.txt – the new one at the tip has");
        assert!(!leftover.exists());
        assert_eq!(worktrees(&repo), 1);
    }

    #[tokio::test]
    async fn cancelling_a_check_removes_its_worktree() {
        let repo = checked_repo();
        let (tc, id) = opened(&repo).await;
        repo_settings_set(&tc, id.clone(), json!({ "testCommand": "sleep 30" })).await.unwrap();
        let folder = agents_folder(&repo).join("stack-check-1");
        let check = stack_check(&tc, id.clone(), "chk-5".into(), "pruefen".into(), MAIN.into(), vec![cut(2, "")]);
        let cancel = async {
            // Wait for the concrete condition: the worktree is there (the program starts right after).
            for _ in 0..400 {
                if folder.join("ok.txt").exists() {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
            crate::commands::sync::job_cancel(&tc, "chk-5".into()).await.unwrap();
        };
        let started = std::time::Instant::now();
        let (result, ()) = tokio::join!(check, cancel);
        assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
        assert!(started.elapsed() < std::time::Duration::from_secs(20), "the program was stopped, not waited for");
        assert!(!folder.exists(), "removed after the cancel");
        assert_eq!(worktrees(&repo), 1);
    }
}

#[tokio::test]
async fn a_key_in_a_part_stops_the_stack_push_until_it_is_accepted() {
    // Spec 6.2: the secret scan runs before every push, also a push with further refs.
    let repo = TestRepo::with_commit();
    let remote = TestRemote::new();
    repo.git(&["remote", "add", "origin", &remote.url()]);
    repo.git(&["push", "-q", "origin", "main"]);
    repo.checkout_new(BRANCH);
    repo.commit_file("src/eins.rs", "pub fn eins() {}\n", "Erster Teil");
    // Built at run time: no literal key format in this file.
    let key = format!("AKIA{}", "Q7RZ4M2XK9PLW3NB");
    repo.commit_file("dienst/zugang.py", format!("AWS_ZUGANG = \"{key}\"\n"), "Zugang für den Dienst");
    let (tc, id) = opened(&repo).await;
    let cuts = vec![cut(1, "Eins"), cut(2, "Zwei")];
    let plan = stack_plan(&tc, id.clone(), BRANCH.into(), MAIN.into(), cuts.clone()).await.unwrap();
    stack_create(&tc, id.clone(), BRANCH.into(), MAIN.into(), cuts, plan.base_sha, plan.tip).await.unwrap();
    let parts = vec![format!("{BRANCH}-1-eins"), format!("{BRANCH}-2-zwei")];

    let stopped = stack_push(&tc, id.clone(), util::new_id(), parts.clone(), "origin".into(), false, None).await.unwrap();
    let PushResult::SecretsFound { findings, .. } = &stopped else { panic!("expected secrets_found, got {stopped:?}") };
    assert_eq!(findings.iter().map(|f| (f.path.as_str(), f.line)).collect::<Vec<_>>(), [("dienst/zugang.py", 1)]);
    assert!(!findings[0].excerpt.contains(&key), "the value is masked");
    for part in &parts {
        assert_eq!(remote_sha(&remote, part), None, "nothing went out before the confirmation");
    }

    let accepted: Vec<String> = findings.iter().map(|f| f.id.clone()).collect();
    let pushed = stack_push(&tc, id.clone(), util::new_id(), parts.clone(), "origin".into(), false, Some(accepted)).await.unwrap();
    assert_eq!(statuses(&pushed), [PushRefStatus::Ok; 2]);
    for part in &parts {
        assert_eq!(remote_sha(&remote, part), sha_of(&repo, part), "{part} on the remote");
    }
}
