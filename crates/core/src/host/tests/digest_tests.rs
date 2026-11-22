//! "What's new": the pull requests the host adds to the digest.

use super::Fixture;
use crate::commands::digest::{digest_get, digest_mark_seen, seen};
use crate::db::repo_seen::{self, SeenRow};
use crate::model::{DigestPrChange::*, DigestPrComments, HostKind};

/// Stores a seen state at `seen_at` whose refs are the current ones: only the PRs can be new.
async fn seen_at(fx: &Fixture, seen_at: &str, pr_max_number: Option<u64>, pr_open: Vec<u64>) {
    let refs = seen::current_refs(&fx.tc, &fx.repo_id).await.unwrap();
    let profile = fx.tc.active_profile_id().unwrap();
    let row = SeenRow { seen_at: seen_at.into(), refs, pr_max_number, pr_open };
    fx.tc.db.with(|c| repo_seen::put(c, &profile, &fx.repo_id, &row)).unwrap();
}

/// The PRs up to `max` the mock data has open (numbers ending in 0 are merged, in 5 closed).
fn open_up_to(max: u64) -> Vec<u64> {
    (1..=max).filter(|n| n % 5 != 0).collect()
}

#[tokio::test]
async fn pull_requests_since_the_seen_time() {
    let fx = Fixture::new(HostKind::Github).await;
    fx.state.lock().merged = vec![26];
    fx.state.lock().closed = vec![27];
    seen_at(&fx, "2026-09-27T00:00:00Z", Some(40), open_up_to(40)).await;
    let d = digest_get(&fx.tc, fx.repo_id.clone(), None).await.unwrap().unwrap();
    let prs = d.prs.unwrap();
    let changed: Vec<_> = prs.changed.iter().map(|p| (p.number, p.change)).collect();
    // hand-noted: 41..44 opened (number > 40, open), 45 closed since (number > 40); 26 merged and
    // 27 closed (open when seen)
    assert_eq!(changed, vec![(44, Opened), (43, Opened), (42, Opened), (41, Opened), (45, Closed), (27, Closed), (26, Merged)]);
    assert_eq!(prs.changed[0].author.as_deref(), Some("jonas"));
    assert_eq!(d.mark.pr_max_number, Some(45));
    let mut open = open_up_to(45);
    open.retain(|n| ![26, 27].contains(n));
    assert_eq!(d.mark.pr_open, Some(open));
    assert_eq!(d.pr_data_missing, None);
    assert!(!d.is_empty);
    assert!(prs.comments.is_empty(), "no PR by lena-hartmann");
    fx.assert_token_stays_secret();
}

#[tokio::test]
async fn new_comments_on_your_pull_request() {
    let fx = Fixture::new(HostKind::Github).await;
    fx.state.lock().pr_authors = vec![(1, "lena-hartmann".into())];
    seen_at(&fx, "2026-09-02T00:00:00Z", Some(45), open_up_to(45)).await;
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
    seen_at(&fx, "2026-09-02T00:00:00Z", Some(45), open_up_to(45)).await;
    let d = digest_get(&fx.tc, fx.repo_id.clone(), None).await.unwrap().unwrap();
    assert_eq!(d.prs, None);
    assert_eq!(d.pr_data_missing, Some(HostKind::Github));
    assert_eq!(fx.sent("GET", "/pulls/1").len(), 1, "the list worked, the details failed");
}

#[tokio::test]
async fn without_the_host_the_digest_has_the_hint() {
    let fx = Fixture::new(HostKind::Github).await;
    seen_at(&fx, "2026-09-27T00:00:00Z", Some(40), vec![26]).await;
    for mode in ["401", "500"] {
        fx.mode(mode);
        let d = digest_get(&fx.tc, fx.repo_id.clone(), None).await.unwrap().unwrap();
        assert_eq!(d.prs, None, "{mode}");
        assert_eq!(d.pr_data_missing, Some(HostKind::Github), "{mode}");
        assert_eq!(d.mark.pr_max_number, Some(40), "{mode}: the stored number stays");
        assert_eq!(d.mark.pr_open, None, "{mode}: marking keeps the stored open PRs");
        assert!(d.refs.is_empty() && d.is_empty, "{mode}: the Git part is there");
    }
    fx.assert_token_stays_secret();
}

#[tokio::test]
async fn a_first_digest_counts_nothing_and_remembers_the_open_ones() {
    let fx = Fixture::new(HostKind::Github).await;
    fx.state.lock().merged = vec![26];
    fx.state.lock().closed = vec![27];
    seen_at(&fx, "2026-09-27T00:00:00Z", None, Vec::new()).await;
    let d = digest_get(&fx.tc, fx.repo_id.clone(), None).await.unwrap().unwrap();
    // Nothing was seen open before: nothing can have been merged or closed since.
    assert_eq!(d.prs.unwrap().changed, Vec::new());
    assert_eq!(d.mark.pr_max_number, Some(45));
    digest_mark_seen(&fx.tc, fx.repo_id.clone(), d.mark).await.unwrap();
    fx.state.lock().merged = vec![26, 28];
    let d = digest_get(&fx.tc, fx.repo_id.clone(), None).await.unwrap().unwrap();
    let changed: Vec<_> = d.prs.unwrap().changed.iter().map(|p| (p.number, p.change)).collect();
    assert_eq!(changed, vec![(28, Merged)], "open when marked, merged since");
}

/// A PR merged before the last look moves its `updated_at` with every later comment or bot run: it
/// is no news again.
#[tokio::test]
async fn a_seen_merged_pull_request_with_later_activity_is_not_news_again() {
    let fx = Fixture::new(HostKind::Github).await;
    fx.state.lock().merged = vec![26];
    let mut open = open_up_to(45);
    open.retain(|n| *n != 26);
    // updated_at of 26 is 2026-09-27T08:26, after the seen time.
    seen_at(&fx, "2026-09-27T00:00:00Z", Some(45), open).await;
    let d = digest_get(&fx.tc, fx.repo_id.clone(), None).await.unwrap().unwrap();
    assert_eq!(d.prs.unwrap().changed, Vec::new());
    assert!(d.is_empty);
}
