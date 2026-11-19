use std::time::{Duration, Instant};

use crate::commands::{repos, sync, tags};
use crate::db::repo_seen::{self, SeenRow};
use crate::events::names;
use crate::model::RepoChange;
use crate::testkit::{TestCore, TestRemote, TestRepo};
use crate::util;

use super::seen;

struct Fixture {
    tc: TestCore,
    repo: TestRepo,
    remote: TestRemote,
    id: String,
}

/// `main` and `feature/eigen` pushed to `origin` (with `origin/HEAD`), the repository opened in the core.
async fn fixture() -> Fixture {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let remote = repo.add_remote();
    repo.checkout_new("feature/eigen");
    repo.commit_file("eigen.txt", "eigen\n", "Eigene Arbeit");
    repo.git(&["push", "-q", "-u", "origin", "feature/eigen"]);
    repo.git(&["remote", "set-head", "origin", "main"]);
    let id = tc.open(&repo).await.repo.id;
    Fixture { tc, repo, remote, id }
}

fn stored(tc: &TestCore, id: &str) -> Option<SeenRow> {
    let profile = tc.active_profile_id().unwrap();
    tc.db.with(|c| repo_seen::get(c, &profile, id)).unwrap()
}

fn seen_row(tc: &TestCore, id: &str) -> SeenRow {
    stored(tc, id).expect("seen state exists")
}

fn changes(tc: &TestCore) -> Vec<Vec<RepoChange>> {
    tc.events.named(names::REPO_CHANGED).into_iter().map(|e| serde_json::from_value(e["what"].clone()).unwrap()).collect()
}

#[tokio::test]
async fn the_first_start_creates_the_seen_state_silently() {
    let f = fixture().await;
    repos::start_background(&f.tc, &f.id);
    let deadline = Instant::now() + Duration::from_secs(5);
    while stored(&f.tc, &f.id).is_none() {
        assert!(Instant::now() < deadline, "the seen state appears in the background");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let first = seen_row(&f.tc, &f.id);
    assert_eq!(first.refs.get("refs/remotes/origin/main"), Some(&f.repo.git(&["rev-parse", "origin/main"])));
    assert!(first.refs.contains_key("refs/remotes/origin/feature/eigen"));
    assert!(!first.refs.keys().any(|name| name.ends_with("/HEAD")));
    assert_eq!(first.pr_max_number, None);
    assert!(!changes(&f.tc).iter().any(|what| what.contains(&RepoChange::Seen)), "silently");
    seen::ensure(&f.tc, &f.id).await.unwrap();
    assert_eq!(seen_row(&f.tc, &f.id).seen_at, first.seen_at, "a second ensure keeps the old time");
}

#[tokio::test]
async fn an_own_force_push_is_not_reported() {
    let f = fixture().await;
    seen::ensure(&f.tc, &f.id).await.unwrap();
    f.repo.git(&["commit", "-q", "--amend", "-m", "Eigene Arbeit, umformuliert"]);
    let result = sync::push(&f.tc, f.id.clone(), util::new_id(), Some("feature/eigen".into()), None, None, true, None).await.unwrap();
    assert!(matches!(result, crate::model::PushResult::Done { forced: true, .. }), "{result:?}");
    assert_eq!(seen_row(&f.tc, &f.id).refs["refs/remotes/origin/feature/eigen"], f.repo.git(&["rev-parse", "feature/eigen"]));
}

#[tokio::test]
async fn own_tags_and_remote_deletes_move_the_seen_state() {
    let f = fixture().await;
    seen::ensure(&f.tc, &f.id).await.unwrap();
    tags::tag_create(&f.tc, f.id.clone(), "v1.0-ü".into(), None, Some("Erste Version".into())).await.unwrap();
    // Annotated: the tag object, as Git stores it.
    assert_eq!(seen_row(&f.tc, &f.id).refs["refs/tags/v1.0-ü"], f.repo.git(&["rev-parse", "refs/tags/v1.0-ü"]));
    tags::tag_delete(&f.tc, f.id.clone(), "v1.0-ü".into(), None).await.unwrap();
    assert!(!seen_row(&f.tc, &f.id).refs.contains_key("refs/tags/v1.0-ü"));
    sync::branch_delete_remote(&f.tc, f.id.clone(), util::new_id(), "origin".into(), "feature/eigen".into(), None).await.unwrap();
    assert!(!seen_row(&f.tc, &f.id).refs.contains_key("refs/remotes/origin/feature/eigen"));
    assert!(seen_row(&f.tc, &f.id).refs.contains_key("refs/remotes/origin/main"));
}

#[tokio::test]
async fn a_fetch_that_changed_refs_reports_fetched() {
    let f = fixture().await;
    let colleague = TestRepo::clone_of(&f.remote);
    colleague.commit_file("kollege.txt", "k\n", "Vom Kollegen");
    colleague.git(&["push", "-q", "origin", "main"]);
    f.tc.events.clear();
    sync::fetch(&f.tc, f.id.clone(), util::new_id(), None, false).await.unwrap();
    let what = changes(&f.tc).concat();
    assert!(what.contains(&RepoChange::Fetched) && what.contains(&RepoChange::Refs), "{what:?}");
    f.tc.events.clear();
    sync::fetch(&f.tc, f.id.clone(), util::new_id(), None, false).await.unwrap();
    assert!(changes(&f.tc).is_empty(), "a second fetch without changes reports nothing");
}

#[tokio::test]
async fn mark_reports_seen_and_keeps_the_pr_number_when_none() {
    let f = fixture().await;
    seen::mark(&f.tc, &f.id, Some(42)).await.unwrap();
    seen::mark(&f.tc, &f.id, None).await.unwrap();
    let row = seen_row(&f.tc, &f.id);
    assert_eq!(row.pr_max_number, Some(42));
    assert_eq!(row.refs.get("refs/remotes/origin/main"), Some(&f.repo.git(&["rev-parse", "origin/main"])));
    assert_eq!(changes(&f.tc).last(), Some(&vec![RepoChange::Seen]));
}
