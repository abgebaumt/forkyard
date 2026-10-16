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
