//! Branch cleaner: what the host's pull requests add to the Git facts.

use super::Fixture;
use crate::commands::branch_cleanup::candidates_at;
use crate::model::{BranchCleanupClass, BranchCleanupClass::*, BranchCleanupList, BranchCleanupReason, BranchCleanupReason::*, HostKind};
use crate::testkit::BASE_TIME;

const NOW: i64 = BASE_TIME + 30 * 86_400;

fn classes(list: &BranchCleanupList) -> Vec<(&str, BranchCleanupClass, Vec<BranchCleanupReason>)> {
    list.candidates.iter().map(|c| (c.name.as_str(), c.class, c.reasons.clone())).collect()
}

/// `feature/thema-20` and `-30` (two commits each, not merged in Git), `feature/login` (one) and `fertig` (merged).
fn build(fx: &Fixture) -> (String, String) {
    let repo = &fx.repo;
    let mut tips = Vec::new();
    for name in ["feature/thema-20", "feature/thema-30"] {
        repo.checkout_new(name);
        repo.commit_file(&format!("{}-a.txt", &name[8..]), "a\n", "Teil 1");
        tips.push(repo.commit_file(&format!("{}-b.txt", &name[8..]), "b\n", "Teil 2"));
        repo.checkout("main");
    }
    repo.checkout_new("feature/login");
    repo.commit_file("login.txt", "l\n", "Anmeldung");
    repo.checkout("main");
    repo.checkout_new("fertig");
    repo.commit_file("fertig.txt", "f\n", "Fertig");
    repo.checkout("main");
    repo.git(&["merge", "-q", "--no-ff", "--no-edit", "fertig"]);
    repo.git(&["update-ref", "refs/remotes/origin/main", "main"]);
    (tips[0].clone(), tips[1].clone())
}

#[tokio::test]
async fn a_squash_merged_branch_is_recognised_by_its_merged_pull_request() {
    let fx = Fixture::new(HostKind::Github).await;
    let (tip20, tip30) = build(&fx);
    let before30 = fx.repo.git(&["rev-parse", &format!("{tip30}^")]);
    fx.state.lock().head_shas = vec![(20, tip20), (30, before30)];

    let list = candidates_at(&fx.tc, &fx.id(), NOW).await.unwrap();
    assert_eq!(list.pr_data_missing, None);
    assert_eq!(
        classes(&list),
        vec![
            ("feature/thema-20", Safe, vec![PrMerged { number: 20 }, Unmerged { count: 2 }, Unpushed { count: 2 }]),
            ("feature/thema-30", Review, vec![PrMerged { number: 30 }, Unmerged { count: 2 }, Unpushed { count: 2 }]),
            ("fertig", Safe, vec![Merged, NoPr]),
        ],
        "feature/login has an open PR and no cleanup reason"
    );
    assert!(fx.sent("GET", "/pulls/7").is_empty(), "details only for merged PRs of local branches");
    assert_eq!(fx.sent("GET", "/pulls/20").len(), 1);
    fx.assert_token_stays_secret();
}

#[tokio::test]
async fn a_merged_pr_of_a_branch_git_calls_merged_reads_no_details() {
    let fx = Fixture::new(HostKind::Github).await;
    build(&fx);
    // PR 40 (merged) of a branch Git already calls merged; PR 20's branch tracks another name.
    fx.repo.checkout_new("feature/thema-40");
    fx.repo.commit_file("t40.txt", "x\n", "Thema 40");
    fx.repo.checkout("main");
    fx.repo.git(&["merge", "-q", "--no-ff", "--no-edit", "feature/thema-40"]);
    fx.repo.git(&["update-ref", "refs/remotes/origin/main", "main"]);
    fx.repo.git(&["branch", "-q", "-m", "feature/thema-20", "lokal-20"]);
    fx.repo.git(&["update-ref", "refs/remotes/origin/feature/thema-20", "lokal-20"]);
    fx.repo.git(&["branch", "-q", "--set-upstream-to=origin/feature/thema-20", "lokal-20"]);
    let tip20 = fx.repo.git(&["rev-parse", "lokal-20"]);
    fx.state.lock().head_shas = vec![(20, tip20)];

    let list = candidates_at(&fx.tc, &fx.id(), NOW).await.unwrap();
    let row = |name: &str| list.candidates.iter().find(|c| c.name == name).map(|c| (c.class, c.reasons.clone()));
    assert_eq!(row("feature/thema-40"), Some((Safe, vec![Merged, PrMerged { number: 40 }])));
    assert!(fx.sent("GET", "/pulls/40").is_empty(), "merged in Git: the PR's head can't change the class");
    assert_eq!(row("lokal-20").map(|r| r.0), Some(Safe), "matched by the upstream name on the host remote");
    assert_eq!(fx.sent("GET", "/pulls/20").len(), 1);
}

#[tokio::test]
async fn failing_pr_details_leave_the_branch_for_review() {
    let fx = Fixture::new(HostKind::Github).await;
    let (tip20, _) = build(&fx);
    {
        let mut state = fx.state.lock();
        state.head_shas = vec![(20, tip20)];
        state.pr_details_fail = true;
    }

    let list = candidates_at(&fx.tc, &fx.id(), NOW).await.unwrap();
    assert_eq!(list.pr_data_missing, None, "the list itself was read");
    let thema20 = list.candidates.iter().find(|c| c.name == "feature/thema-20").unwrap();
    assert_eq!(
        (thema20.class, thema20.reasons.clone()),
        (Review, vec![PrMerged { number: 20 }, Unmerged { count: 2 }, Unpushed { count: 2 }])
    );
}

#[tokio::test]
async fn without_the_host_the_list_comes_without_pr_reasons() {
    let fx = Fixture::new(HostKind::Github).await;
    build(&fx);
    for mode in ["500", "401"] {
        fx.mode(mode);
        let list = candidates_at(&fx.tc, &fx.id(), NOW).await.unwrap();
        assert_eq!(list.pr_data_missing, Some(HostKind::Github), "{mode}");
        assert_eq!(classes(&list), vec![("fertig", Safe, vec![Merged])], "{mode}: feature/thema-20 has no class reason any more");
    }
    fx.assert_token_stays_secret();
}

#[tokio::test]
async fn a_host_without_an_account_reports_missing_pr_data_without_a_call() {
    let fx = Fixture::new(HostKind::Github).await;
    build(&fx);
    fx.repo.git(&["remote", "set-url", "origin", "https://github.com/octo/demo.git"]);
    let list = candidates_at(&fx.tc, &fx.id(), NOW).await.unwrap();
    assert_eq!(list.pr_data_missing, Some(HostKind::Github));
    assert_eq!(classes(&list), vec![("fertig", Safe, vec![Merged])]);
    assert!(fx.server.requests().is_empty(), "no call without an account");
}
