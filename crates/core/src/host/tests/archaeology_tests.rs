//! Line archaeology: titles of the pull requests and issues a line's commits name, from the GitHub
//! test server (`mocks::github`).

use super::*;
use crate::commands::archaeology::{line_archaeology, MAX_HOST_LOOKUPS};
use crate::model::{ArchaeologyHostLookup, ArchaeologyRefKind, LineArchaeology};

fn refs(found: &LineArchaeology) -> Vec<(String, ArchaeologyRefKind, Option<String>)> {
    found.steps.iter().flat_map(|step| step.refs.iter()).map(|r| (r.text.clone(), r.kind, r.title.clone())).collect()
}

/// Requests for one issue or pull request (not their comments, reviews …).
fn item_requests(f: &Fixture) -> Vec<String> {
    f.server
        .requests()
        .into_iter()
        .map(|request| request.path().to_string())
        .filter(|path| {
            let segments: Vec<&str> = path.split('/').collect();
            segments.len() >= 2 && matches!(segments[segments.len() - 2], "issues" | "pulls") && segments[segments.len() - 1].parse::<u64>().is_ok()
        })
        .collect()
}

#[tokio::test]
async fn titles_come_from_the_host_issue_first_then_pull_request() {
    let f = Fixture::new(HostKind::Github).await;
    f.repo.commit_file("werte.txt", "a\nb\n", "Werte angelegt, siehe #2");
    f.repo.commit_file("werte.txt", "a\nB\n", "B groß (#3), nicht #999");
    f.server.clear();

    let found = line_archaeology(&f.tc, f.id(), "werte.txt".into(), 2, Some("HEAD".into())).await.unwrap();
    assert_eq!(found.host_lookup, ArchaeologyHostLookup::Done);
    assert_eq!(
        refs(&found),
        vec![
            ("#3".to_string(), ArchaeologyRefKind::PullRequest, Some("Thema 3 umsetzen".to_string())),
            ("#999".to_string(), ArchaeologyRefKind::Issue, None),
            ("#2".to_string(), ArchaeologyRefKind::Issue, Some("Problem 2".to_string())),
        ],
        "#3 is a pull request on GitHub; the host does not know #999"
    );
    assert!(found.steps[0].refs[0].url.ends_with("/octo/demo/issues/3"), "the link stays the host rule's address");

    let before = f.server.requests().len();
    let again = line_archaeology(&f.tc, f.id(), "werte.txt".into(), 2, Some("HEAD".into())).await.unwrap();
    assert_eq!(again, found);
    assert_eq!(f.server.requests().len(), before, "the second call comes from the cache");
}

#[tokio::test]
async fn at_most_five_lookups_and_a_failing_host_keeps_the_links() {
    let f = Fixture::new(HostKind::Github).await;
    f.repo.commit_file("liste.txt", "eins\n", "Sammel-Commit für #1 #2 #4 #5 #7 #8 #11");
    f.server.clear();
    let found = line_archaeology(&f.tc, f.id(), "liste.txt".into(), 1, Some("HEAD".into())).await.unwrap();
    assert_eq!(found.host_lookup, ArchaeologyHostLookup::Done);
    let asked = item_requests(&f);
    assert_eq!(asked.len(), MAX_HOST_LOOKUPS, "{asked:?}");
    assert!(asked.iter().all(|path| !path.ends_with("/8") && !path.ends_with("/11")), "the newest five numbers in text order: {asked:?}");
    assert_eq!(found.steps[0].refs.iter().filter(|r| r.title.is_some()).count(), MAX_HOST_LOOKUPS);
    assert_eq!(found.steps[0].refs.len(), 7, "every link stays");

    f.mode("500");
    f.repo.commit_file("liste.txt", "zwei\n", "Wieder #2");
    let failed = line_archaeology(&f.tc, f.id(), "liste.txt".into(), 1, Some("HEAD".into())).await.unwrap();
    assert_eq!(failed.host_lookup, ArchaeologyHostLookup::Failed);
    assert!(failed.steps[0].refs.iter().all(|r| r.title.is_none() && r.url.ends_with("/octo/demo/issues/2")), "the link without a title");
}
