//! "What's new": the pull requests the host adds to the digest.

use super::Fixture;
use crate::commands::digest::{digest_get, seen};
use crate::db::repo_seen::{self, SeenRow};
use crate::model::{DigestPrChange::*, DigestPrComments, HostKind};

/// Stores a seen state at `seen_at` whose refs are the current ones: only the PRs can be new.
async fn seen_at(fx: &Fixture, seen_at: &str, pr_max_number: Option<u64>) {
    let refs = seen::current_refs(&fx.tc, &fx.repo_id).await.unwrap();
    let profile = fx.tc.active_profile_id().unwrap();
    let row = SeenRow { seen_at: seen_at.into(), refs, pr_max_number };
    fx.tc.db.with(|c| repo_seen::put(c, &profile, &fx.repo_id, &row)).unwrap();
}

#[tokio::test]
async fn pull_requests_since_the_seen_time() {
    let fx = Fixture::new(HostKind::Github).await;
    fx.state.lock().merged = vec![26];
    fx.state.lock().closed = vec![27];
    seen_at(&fx, "2026-09-27T00:00:00Z", Some(40)).await;
    let d = digest_get(&fx.tc, fx.repo_id.clone(), None).await.unwrap().unwrap();
    let prs = d.prs.unwrap();
    let changed: Vec<_> = prs.changed.iter().map(|p| (p.number, p.change)).collect();
    // hand-noted: 41..45 opened (number > 40); 26 merged, 27 closed (updated 09-27/09-28, after seen_at)
    assert_eq!(changed, vec![(45, Opened), (44, Opened), (43, Opened), (42, Opened), (41, Opened), (27, Closed), (26, Merged)]);
    assert_eq!(prs.changed[0].author.as_deref(), Some("jonas"));
    assert_eq!(d.pr_max_number, Some(45));
    assert_eq!(d.pr_data_missing, None);
    assert!(!d.is_empty);
    assert!(prs.comments.is_empty(), "no PR by lena-hartmann");
    fx.assert_token_stays_secret();
}

#[tokio::test]
async fn new_comments_on_your_pull_request() {
    let fx = Fixture::new(HostKind::Github).await;
    fx.state.lock().pr_authors = vec![(1, "lena-hartmann".into())];
    seen_at(&fx, "2026-09-02T00:00:00Z", Some(45)).await;
    let d = digest_get(&fx.tc, fx.repo_id.clone(), None).await.unwrap().unwrap();
    let prs = d.prs.unwrap();
    // hand-counted from the mock data of PR 1, all on 09-02 by others: review 11 (mira, with text),
    // line comment 31 (mira), issue comment 21 (jonas); review 12 has no text and is no comment.
    assert_eq!(prs.comments, vec![DigestPrComments { number: 1, title: "Anmeldung: Fehlermeldung bei leerem Passwort".into(), count: 3 }]);
    assert_eq!(fx.sent("GET", "/pulls/1").len(), 1, "details only for the own PR");
    assert!(fx.sent("GET", "/pulls/2").is_empty());
}

#[tokio::test]
async fn a_failing_pull_request_detail_drops_the_whole_pr_part() {
    let fx = Fixture::new(HostKind::Github).await;
    fx.state.lock().pr_authors = vec![(1, "lena-hartmann".into())];
    fx.state.lock().pr_details_fail = true;
    seen_at(&fx, "2026-09-02T00:00:00Z", Some(45)).await;
    let d = digest_get(&fx.tc, fx.repo_id.clone(), None).await.unwrap().unwrap();
    assert_eq!(d.prs, None);
    assert_eq!(d.pr_data_missing, Some(HostKind::Github));
    assert_eq!(fx.sent("GET", "/pulls/1").len(), 1, "the list worked, the details failed");
}

#[tokio::test]
async fn without_the_host_the_digest_has_the_hint() {
    let fx = Fixture::new(HostKind::Github).await;
    seen_at(&fx, "2026-09-27T00:00:00Z", Some(40)).await;
    for mode in ["401", "500"] {
        fx.mode(mode);
        let d = digest_get(&fx.tc, fx.repo_id.clone(), None).await.unwrap().unwrap();
        assert_eq!(d.prs, None, "{mode}");
        assert_eq!(d.pr_data_missing, Some(HostKind::Github), "{mode}");
        assert_eq!(d.pr_max_number, Some(40), "{mode}: the stored number stays");
        assert!(d.refs.is_empty() && d.is_empty, "{mode}: the Git part is there");
    }
    fx.assert_token_stays_secret();
}

#[tokio::test]
async fn a_first_digest_counts_nothing_as_opened() {
    let fx = Fixture::new(HostKind::Github).await;
    fx.state.lock().merged = vec![26];
    fx.state.lock().closed = vec![27];
    seen_at(&fx, "2026-09-27T00:00:00Z", None).await;
    let d = digest_get(&fx.tc, fx.repo_id.clone(), None).await.unwrap().unwrap();
    let prs = d.prs.unwrap();
    assert!(prs.changed.iter().all(|p| p.change != Opened), "{:?}", prs.changed);
    // Merged and closed ones since the seen time are still listed without a stored number.
    let changed: Vec<_> = prs.changed.iter().map(|p| (p.number, p.change)).collect();
    assert_eq!(changed, vec![(27, Closed), (26, Merged)]);
    assert_eq!(d.pr_max_number, Some(45));
}
