//! "What's new": the pull requests the host adds to the digest.

use super::Fixture;
use crate::commands::digest::compose;
use crate::model::{Digest, DigestPrChange::*, DigestPrComments, HostKind};

/// The digest for the window starting at `since`: the mock data is dated September 2026 (`updated_at`
/// is `2026-09-(1 + n % 28)`), so the window is chosen to match it.
async fn since(fx: &Fixture, since: &str) -> Digest {
    let since = chrono::DateTime::parse_from_rfc3339(since).unwrap().with_timezone(&chrono::Utc);
    compose(&fx.tc, &fx.repo_id, since).await.unwrap()
}

#[tokio::test]
async fn pull_requests_of_the_window() {
    let fx = Fixture::new(HostKind::Github).await;
    fx.state.lock().merged = vec![26];
    fx.state.lock().closed = vec![27];
    let d = since(&fx, "2026-09-27T00:00:00Z").await;
    let prs = d.prs.unwrap();
    let changed: Vec<_> = prs.changed.iter().map(|p| (p.number, p.change)).collect();
    // hand-noted: only 26 and 27 were updated on 09-27 and 09-28; one merged, one closed
    assert_eq!(changed, vec![(27, Closed), (26, Merged)]);
    assert_eq!(d.pr_data_missing, None);
    assert!(!d.is_empty);
    assert!(prs.comments.is_empty(), "no PR by lena-hartmann");
    fx.assert_token_stays_secret();
}

#[tokio::test]
async fn the_pull_request_list_is_read_without_checks_and_reviews() {
    let fx = Fixture::new(HostKind::Github).await;
    since(&fx, "2026-09-27T00:00:00Z").await;
    assert_eq!(fx.sent("GET", "/pulls").len(), 1, "one page of the list");
    let extra: Vec<String> =
        fx.server.requests().iter().map(|r| r.path().to_string()).filter(|p| p.contains("/commits/") || p.contains("/reviews")).collect();
    assert_eq!(extra, Vec::<String>::new(), "no requests per pull request");
}

#[tokio::test]
async fn an_open_pull_request_is_active_and_comes_first() {
    let fx = Fixture::new(HostKind::Github).await;
    let d = since(&fx, "2026-09-26T00:00:00Z").await;
    // hand-noted: 25 (closed by its number) was updated on 09-26, 26 and 27 (open) after it
    let changed: Vec<_> = d.prs.unwrap().changed.iter().map(|p| (p.number, p.change)).collect();
    assert_eq!(changed, vec![(27, Updated), (26, Updated), (25, Closed)]);
}

#[tokio::test]
async fn nothing_updated_in_the_window_is_empty() {
    let fx = Fixture::new(HostKind::Github).await;
    let d = since(&fx, "2026-10-01T00:00:00Z").await;
    assert_eq!(d.prs.unwrap().changed, Vec::new());
    assert!(d.is_empty);
}

#[tokio::test]
async fn new_comments_on_your_pull_request() {
    let fx = Fixture::new(HostKind::Github).await;
    fx.state.lock().pr_authors = vec![(1, "lena-hartmann".into())];
    let d = since(&fx, "2026-09-02T00:00:00Z").await;
    let prs = d.prs.unwrap();
    // hand-counted from the mock data of PR 1, all on 09-02 by others: review 11 (mira, with text),
    // line comment 31 (mira), issue comment 21 (jonas); review 12 has no text and is no comment.
    assert_eq!(prs.comments, vec![DigestPrComments { number: 1, title: "Anmeldung: Fehlermeldung bei leerem Passwort".into(), count: 3 }]);
    assert_eq!(fx.sent("GET", "/pulls/1").len(), 1, "details only for the own PR");
    assert!(fx.sent("GET", "/pulls/2").is_empty());
}

#[tokio::test]
async fn azure_counts_new_comments_on_your_pull_request_created_before_the_window() {
    let fx = Fixture::new(HostKind::AzureDevops).await;
    fx.state.lock().pr_authors = vec![(1, "lena".into())];
    // PR 1 was created at 09-02 08:01 and Azure reports nothing later; mira commented at 09:00 and 09:30.
    let d = since(&fx, "2026-09-02T08:30:00Z").await;
    let prs = d.prs.unwrap();
    assert_eq!(prs.comments, vec![DigestPrComments { number: 1, title: "Thema 1 umsetzen".into(), count: 2 }]);
}

#[tokio::test]
async fn a_failing_pull_request_detail_drops_the_whole_pr_part() {
    let fx = Fixture::new(HostKind::Github).await;
    fx.state.lock().pr_authors = vec![(1, "lena-hartmann".into())];
    fx.state.lock().pr_details_fail = true;
    let d = since(&fx, "2026-09-02T00:00:00Z").await;
    assert_eq!(d.prs, None);
    assert_eq!(d.pr_data_missing, Some(HostKind::Github));
    assert_eq!(fx.sent("GET", "/pulls/1").len(), 1, "the list worked, the details failed");
}

#[tokio::test]
async fn without_the_host_the_digest_has_the_hint() {
    let fx = Fixture::new(HostKind::Github).await;
    for mode in ["401", "500"] {
        fx.mode(mode);
        let d = since(&fx, "2026-09-27T00:00:00Z").await;
        assert_eq!(d.prs, None, "{mode}");
        assert_eq!(d.pr_data_missing, Some(HostKind::Github), "{mode}");
        assert!(d.refs.is_empty() && d.is_empty, "{mode}: the Git part is there");
    }
    fx.assert_token_stays_secret();
}
