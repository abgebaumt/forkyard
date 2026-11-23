use std::time::{Duration, Instant};

use crate::commands::{repos, sync, tags};
use crate::db::hoster_accounts::{self, AccountFacts};
use crate::db::repo_seen::{self, SeenRow};
use crate::events::names;
use crate::model::{Digest, DigestBehind, HostKind, RefKind, RepoChange};
use crate::testkit::{TestCore, TestRemote, TestRepo};
use crate::util;

use super::compose::own_emails;
use super::{digest_get, seen};

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

/// The digest the dialog shows right now.
async fn shown(tc: &TestCore, id: &str) -> Digest {
    digest_get(tc, id.to_string(), None).await.unwrap().expect("a digest")
}

/// Seen state A, a colleague pushes B (fetched, nothing shown), the user pulls and pushes C: B stays news.
#[tokio::test]
async fn an_own_push_keeps_foreign_commits_fetched_before_it() {
    let f = fixture().await;
    f.repo.git(&["config", "user.email", "lena@example.com"]);
    seen::ensure(&f.tc, &f.id).await.unwrap();
    let c = TestRepo::clone_of(&f.remote);
    c.commit_as("Vom Kollegen", "Mira", "mira@example.com", &at(1));
    c.git(&["push", "-q", "origin", "main"]);
    sync::fetch(&f.tc, f.id.clone(), util::new_id(), None, true).await.unwrap();
    f.repo.checkout("main");
    f.repo.git(&["merge", "-q", "--ff-only", "origin/main"]);
    f.repo.commit_as("Von Lena", "Lena", "lena@example.com", &at(2));
    let result = sync::push(&f.tc, f.id.clone(), util::new_id(), Some("main".into()), None, None, false, None).await.unwrap();
    assert!(matches!(result, crate::model::PushResult::Done { forced: false, .. }), "{result:?}");
    assert_eq!(f.repo.git(&["rev-parse", "origin/main"]), f.repo.git(&["rev-parse", "main"]), "pushed");
    let digest = digest_get(&f.tc, f.id.clone(), Some(true)).await.unwrap().expect("the fetched commit is still news");
    let main = digest.refs.iter().find(|r| r.name == "origin/main").expect("origin/main is news");
    assert_eq!(
        main.commits.iter().map(|c| c.subject.as_str()).collect::<Vec<_>>(),
        vec!["Von Lena", "Vom Kollegen"],
        "own commits count too"
    );
}

// ---------------------------------------------------------------------------
// The digest
// ---------------------------------------------------------------------------

struct Day {
    tc: TestCore,
    repo: TestRepo,
    remote: TestRemote,
    id: String,
}

/// App clone as Lena (`lena@example.com`): `main`, `feature/alt`, `feature/weg` pushed (all dated long
/// ago), on `feature/mein` (one own commit), seen state ensured. Then `colleague` works in a fresh clone,
/// the app gets a local change in `src/login.rs` and fetches.
async fn colleague_day(colleague: impl FnOnce(&TestRepo)) -> Day {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    repo.git(&["config", "user.email", "lena@example.com"]);
    repo.write_file("src/login.rs", "fn login() {}\n");
    repo.commit_file("src/fehler.rs", "fn fehler() {}\n", "Quellen");
    let remote = repo.add_remote();
    for name in ["feature/alt", "feature/weg"] {
        repo.checkout_new(name);
        repo.commit_file(&format!("{}.txt", &name[8..]), "x\n", name);
        repo.git(&["push", "-q", "origin", name]);
        repo.checkout("main");
    }
    repo.checkout_new("feature/mein");
    repo.commit_file("mein.txt", "mein\n", "Meine Arbeit");
    let id = tc.open(&repo).await.repo.id;
    seen::ensure(&tc, &id).await.unwrap();

    colleague(&TestRepo::clone_of(&remote));
    repo.write_file("src/login.rs", "fn login() { todo!() }\n");
    sync::fetch(&tc, id.clone(), util::new_id(), None, true).await.unwrap();
    Day { tc, repo, remote, id }
}

/// A commit date `minute` minutes into the last hour.
fn at(minute: i64) -> String {
    format!("@{} +0000", chrono::Utc::now().timestamp() - 3600 + 60 * minute)
}

/// Mira's two commits and one of Lena's on `main`, `feature/alt` rewritten, `feature/weg` deleted, tags `v0.1` (old) and `v1.0`.
fn colleague_story(c: &TestRepo) {
    c.git(&["tag", "v0.1"]);
    c.write_file("src/login.rs", "fn login() { pruefen() }\n");
    c.commit_as("Login prüfen", "Mira", "mira@example.com", &at(1));
    c.write_file("src/fehler.rs", "fn fehler() { \"Ungültig\" }\n");
    c.commit_as("Fehlertext ändern", "Mira", "mira@example.com", &at(2));
    c.write_file("eigen.txt", "von Lena\n");
    c.commit_as("Eigene Arbeit", "Lena", "LENA@example.com", &at(3));
    c.git(&["push", "-q", "origin", "main"]);
    c.git(&["checkout", "-q", "-b", "feature/alt", "origin/feature/alt"]);
    c.git(&["reset", "-q", "--hard", "HEAD~1"]);
    c.write_file("alt.txt", "neu\n");
    c.commit_as("Neu geschrieben", "Mira", "mira@example.com", &at(4));
    c.git(&["push", "-q", "-f", "origin", "feature/alt"]);
    c.git(&["push", "-q", "origin", "--delete", "feature/weg"]);
    c.git(&["tag", "v1.0", "main"]);
    c.git(&["push", "-q", "origin", "v0.1", "v1.0"]);
}

#[tokio::test]
async fn the_digest_lists_the_last_24_hours() {
    let d = colleague_day(colleague_story).await;
    let digest = shown(&d.tc, &d.id).await;
    let refs: Vec<_> = digest.refs.iter().map(|r| (r.name.as_str(), r.kind, r.new_commits)).collect();
    // The base branch first, then by name; the deleted branch and the old tag are no news; the tag's
    // time is its commit's.
    assert_eq!(refs, vec![("origin/main", RefKind::Remote, 3), ("origin/feature/alt", RefKind::Remote, 1), ("v1.0", RefKind::Tag, 0),]);
    let main = &digest.refs[0];
    assert_eq!(
        main.commits.iter().map(|c| (c.subject.as_str(), c.author.as_str())).collect::<Vec<_>>(),
        vec![("Eigene Arbeit", "Lena"), ("Fehlertext ändern", "Mira"), ("Login prüfen", "Mira")],
        "own commits are mixed in"
    );
    assert_eq!(digest.new_commits, 4);
    assert_eq!(
        digest.your_files.iter().map(|f| (f.path.as_str(), f.local, f.on_branch)).collect::<Vec<_>>(),
        vec![("src/login.rs", true, false)],
        "only other people's commits touch your files"
    );
    assert_eq!(digest.your_files[0].sha, d.repo.git(&["rev-parse", "origin/main~2"]), "the newest commit touching it");
    assert_eq!(digest.behind, Some(DigestBehind { branch: "feature/mein".into(), base: "origin/main".into(), behind: 3, ahead: 1 }));
    let tag = digest.refs.iter().find(|r| r.name == "v1.0").unwrap();
    assert_eq!(tag.new_sha.as_deref(), Some(d.repo.git(&["rev-parse", "origin/main"]).as_str()));
    assert!(!digest.is_empty);
}

#[tokio::test]
async fn only_own_commits_are_news_too() {
    let d = colleague_day(|c| {
        c.write_file("eigen.txt", "von Lena\n");
        c.commit_as("Eigene Arbeit", "Lena", "LENA@example.com", &at(1));
        c.git(&["push", "-q", "origin", "main"]);
    })
    .await;
    let digest = shown(&d.tc, &d.id).await;
    assert_eq!(digest.refs.iter().map(|r| (r.name.as_str(), r.new_commits)).collect::<Vec<_>>(), vec![("origin/main", 1)]);
    assert!(!digest.is_empty && digest.new_commits == 1);
    assert!(digest.your_files.is_empty());
}

#[tokio::test]
async fn commits_older_than_24_hours_are_no_news() {
    let d = colleague_day(|c| {
        c.write_file("alt.txt", "x\n");
        c.commit_as("Vorgestern", "Mira", "mira@example.com", &format!("@{} +0000", chrono::Utc::now().timestamp() - 48 * 3600));
        c.git(&["push", "-q", "origin", "main"]);
    })
    .await;
    let digest = shown(&d.tc, &d.id).await;
    assert!(digest.refs.is_empty() && digest.is_empty && digest.new_commits == 0, "{:?}", digest.refs);
    assert!(digest.behind.is_some(), "behind alone still shows, but does not make it non-empty");
}

#[tokio::test]
async fn a_new_branch_lists_its_commits_of_the_window() {
    let d = colleague_day(|c| {
        c.git(&["checkout", "-q", "-b", "feature/neu"]);
        c.write_file("neu.txt", "1\n");
        c.commit_as("Neu eins", "Mira", "mira@example.com", &at(1));
        c.write_file("neu.txt", "2\n");
        c.commit_as("Neu zwei", "Mira", "mira@example.com", &at(2));
        c.git(&["push", "-q", "origin", "feature/neu"]);
    })
    .await;
    let digest = shown(&d.tc, &d.id).await;
    let refs: Vec<_> = digest.refs.iter().map(|r| (r.name.as_str(), r.new_commits)).collect();
    assert_eq!(refs, vec![("origin/feature/neu", 2)]);
}

#[tokio::test]
async fn a_file_changed_on_the_current_branch_is_yours() {
    let d = colleague_day(colleague_story).await;
    d.repo.write_file("src/fehler.rs", "fn fehler() { \"Falsch\" }\n");
    d.repo.git(&["commit", "-q", "-m", "Fehler anders", "--", "src/fehler.rs"]);
    let digest = shown(&d.tc, &d.id).await;
    assert_eq!(
        digest.your_files.iter().map(|f| (f.path.as_str(), f.local, f.on_branch)).collect::<Vec<_>>(),
        vec![("src/fehler.rs", false, true), ("src/login.rs", true, false)]
    );
}

#[tokio::test]
async fn every_answer_stores_the_refs_it_was_based_on() {
    let d = colleague_day(colleague_story).await;
    let before = seen_row(&d.tc, &d.id);
    assert!(!before.refs.contains_key("refs/tags/v1.0"), "the fetch brought news");
    assert!(shown(&d.tc, &d.id).await.refs.len() == 3);
    assert_eq!(seen_row(&d.tc, &d.id).refs["refs/remotes/origin/main"], d.repo.git(&["rev-parse", "origin/main"]));
    // The same 24 hours do not open the dialog again, however often one fetches.
    assert_eq!(digest_get(&d.tc, d.id.clone(), Some(true)).await.unwrap(), None);
    sync::fetch(&d.tc, d.id.clone(), util::new_id(), None, true).await.unwrap();
    assert_eq!(digest_get(&d.tc, d.id.clone(), Some(true)).await.unwrap(), None);
    // The palette still shows them.
    assert!(!shown(&d.tc, &d.id).await.is_empty);
}

#[tokio::test]
async fn after_a_fetch_the_changed_refs_open_it_once() {
    let d = colleague_day(colleague_story).await;
    let digest = digest_get(&d.tc, d.id.clone(), Some(true)).await.unwrap().expect("refs changed since the repository was opened");
    assert!(!digest.is_empty);
    assert_eq!(digest_get(&d.tc, d.id.clone(), Some(true)).await.unwrap(), None, "now it is what was shown");
    let c = TestRepo::clone_of(&d.remote);
    c.commit_as("Noch einer", "Mira", "mira@example.com", &at(10));
    c.git(&["push", "-q", "origin", "main"]);
    sync::fetch(&d.tc, d.id.clone(), util::new_id(), None, true).await.unwrap();
    assert!(digest_get(&d.tc, d.id.clone(), Some(true)).await.unwrap().is_some(), "a new fetch with news");
}

#[tokio::test]
async fn changed_refs_without_news_in_the_window_open_nothing_and_are_remembered() {
    let d = colleague_day(|c| {
        c.write_file("alt.txt", "x\n");
        c.commit_as("Vorgestern", "Mira", "mira@example.com", &format!("@{} +0000", chrono::Utc::now().timestamp() - 48 * 3600));
        c.git(&["push", "-q", "origin", "main"]);
    })
    .await;
    assert_eq!(digest_get(&d.tc, d.id.clone(), Some(true)).await.unwrap(), None);
    assert_eq!(seen_row(&d.tc, &d.id).refs["refs/remotes/origin/main"], d.repo.git(&["rev-parse", "origin/main"]), "remembered");
}

#[tokio::test]
async fn an_own_push_after_the_refs_were_read_stays_absorbed() {
    let f = fixture().await;
    seen::ensure(&f.tc, &f.id).await.unwrap();
    let read_before = seen::current_refs(&f.tc, &f.id).await.unwrap();
    f.repo.git(&["commit", "-q", "--amend", "-m", "Eigene Arbeit, umformuliert"]);
    sync::push(&f.tc, f.id.clone(), util::new_id(), Some("feature/eigen".into()), None, None, true, None).await.unwrap();
    seen::store(&f.tc, &f.id, read_before).await.unwrap();
    assert_eq!(digest_get(&f.tc, f.id.clone(), Some(true)).await.unwrap(), None);
}

#[tokio::test]
async fn the_noreply_address_of_a_connected_github_account_is_own() {
    let d = colleague_day(|c| {
        c.write_file("src/login.rs", "fn login() { im_browser() }\n");
        c.commit_as("Im Browser bearbeitet", "Lena Hartmann", "123+lena-hartmann@users.noreply.github.com", &at(1));
        c.git(&["push", "-q", "origin", "main"]);
    })
    .await;
    // Added after the fetch: the test never talks to github.com.
    d.repo.git(&["remote", "add", "hub", "https://github.com/lena-hartmann/app.git"]);
    let profile = d.tc.active_profile_id().unwrap();
    let facts =
        AccountFacts { login: Some("lena-hartmann".into()), name: None, avatar_url: None, scopes_ok: true, missing_scopes: Vec::new() };
    d.tc.db.with(|c| hoster_accounts::upsert(c, &profile, HostKind::Github, "https://github.com", None, "…abcd", &facts)).unwrap();
    let own = own_emails(&d.tc, &d.id).await;
    assert!(own.contains(&"lena-hartmann@users.noreply.github.com".to_string()), "{own:?}");
    assert!(own.contains(&"lena@example.com".to_string()), "{own:?}");
    let digest = shown(&d.tc, &d.id).await;
    assert_eq!(digest.new_commits, 1, "the commit is listed");
    assert!(digest.your_files.is_empty(), "but it is not someone else's change to your file");
    // No token in the keychain: the PR part stops before any request, which keeps this test offline.
    assert_eq!(digest.pr_data_missing, Some(HostKind::Github));
}

#[tokio::test]
async fn own_unpushed_commits_on_a_local_branch_are_news() {
    let d = colleague_day(colleague_story).await;
    d.repo.commit_as("Noch lokal", "Lena", "lena@example.com", &at(5));
    let digest = shown(&d.tc, &d.id).await;
    let local: Vec<_> = digest.refs.iter().filter(|r| r.kind == RefKind::Local).map(|r| (r.name.as_str(), r.new_commits)).collect();
    // Only the unpushed commit: pushed ones stay under their remote branch, local `main` is behind and has none.
    assert_eq!(local, vec![("feature/mein", 1)]);
    assert_eq!(digest.refs.iter().find(|r| r.kind == RefKind::Local).unwrap().commits[0].subject, "Noch lokal");
    assert_eq!(digest.new_commits, 5);
}
