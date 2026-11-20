use std::time::{Duration, Instant};

use crate::commands::{repos, sync, tags};
use crate::db::hoster_accounts::{self, AccountFacts};
use crate::db::repo_seen::{self, SeenRow};
use crate::events::names;
use crate::model::{DigestBehind, DigestRefChange, HostKind, RepoChange};
use crate::testkit::{TestCore, TestRemote, TestRepo, BASE_TIME};
use crate::util;

use super::compose::own_emails;
use super::{digest_get, digest_mark_seen, seen};

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

// ---------------------------------------------------------------------------
// The digest
// ---------------------------------------------------------------------------

struct Day {
    tc: TestCore,
    repo: TestRepo,
    remote: TestRemote,
    id: String,
    /// `feature/alt` as the app saw it.
    old_alt: String,
}

/// App clone as Lena (`lena@example.com`): `main`, `feature/alt`, `feature/weg` pushed, on
/// `feature/mein` (one own commit), seen state ensured. Then `colleague` works in a fresh clone,
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
    let old_alt = repo.git(&["rev-parse", "feature/alt"]);
    repo.checkout_new("feature/mein");
    repo.commit_file("mein.txt", "mein\n", "Meine Arbeit");
    let id = tc.open(&repo).await.repo.id;
    seen::ensure(&tc, &id).await.unwrap();

    colleague(&TestRepo::clone_of(&remote));
    repo.write_file("src/login.rs", "fn login() { todo!() }\n");
    sync::fetch(&tc, id.clone(), util::new_id(), None, true).await.unwrap();
    Day { tc, repo, remote, id, old_alt }
}

fn at(minute: i64) -> String {
    format!("@{} +0000", BASE_TIME + 3600 + 60 * minute)
}

/// Mira's two commits and one of Lena's on `main`, `feature/alt` rewritten, `feature/weg` deleted, tag `v1.0`.
fn colleague_story(c: &TestRepo) {
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
    c.git(&["push", "-q", "origin", "v1.0"]);
}

#[tokio::test]
async fn the_digest_lists_what_the_colleague_did() {
    let d = colleague_day(colleague_story).await;
    let digest = digest_get(&d.tc, d.id.clone(), None).await.unwrap().unwrap();
    let refs: Vec<_> = digest.refs.iter().map(|r| (r.name.as_str(), r.change, r.new_commits)).collect();
    assert_eq!(
        refs,
        vec![
            ("origin/feature/alt", DigestRefChange::Rewritten, 1),
            ("origin/feature/weg", DigestRefChange::Deleted, 0),
            ("origin/main", DigestRefChange::Updated, 2),
            ("v1.0", DigestRefChange::New, 0),
        ]
    );
    let main = digest.refs.iter().find(|r| r.name == "origin/main").unwrap();
    assert_eq!(
        main.commits.iter().map(|c| (c.subject.as_str(), c.author.as_str())).collect::<Vec<_>>(),
        vec![("Fehlertext ändern", "Mira"), ("Login prüfen", "Mira")]
    );
    assert_eq!(digest.new_commits, 3);
    assert_eq!(
        digest.your_files.iter().map(|f| (f.path.as_str(), f.local, f.on_branch)).collect::<Vec<_>>(),
        vec![("src/login.rs", true, false)]
    );
    assert_eq!(digest.your_files[0].sha, d.repo.git(&["rev-parse", "origin/main~2"]), "the newest commit touching it");
    assert_eq!(digest.behind, Some(DigestBehind { branch: "feature/mein".into(), base: "origin/main".into(), behind: 3, ahead: 1 }));
    let tag = digest.refs.iter().find(|r| r.name == "v1.0").unwrap();
    assert_eq!(tag.new_sha.as_deref(), Some(d.repo.git(&["rev-parse", "origin/main"]).as_str()));
    assert!(!digest.is_empty);
    // Oracle for the rewrite: the old tip is not in the new history.
    let new_alt = d.repo.git(&["rev-parse", "origin/feature/alt"]);
    assert!(!d.repo.git_output(&["merge-base", "--is-ancestor", &d.old_alt, &new_alt]).status.success());
}

#[tokio::test]
async fn only_own_commits_hide_the_ref() {
    let d = colleague_day(|c| {
        c.write_file("eigen.txt", "von Lena\n");
        c.commit_as("Eigene Arbeit", "Lena", "LENA@example.com", &at(1));
        c.git(&["push", "-q", "origin", "main"]);
    })
    .await;
    let digest = digest_get(&d.tc, d.id.clone(), None).await.unwrap().unwrap();
    assert!(digest.refs.is_empty() && digest.is_empty, "{:?}", digest.refs);
    assert_eq!(digest.new_commits, 0);
    assert!(digest.behind.is_some(), "behind alone still shows, but does not make it non-empty");
}

#[tokio::test]
async fn a_new_branch_counts_only_commits_not_seen_before() {
    let d = colleague_day(|c| {
        c.git(&["checkout", "-q", "-b", "feature/neu"]);
        c.write_file("neu.txt", "1\n");
        c.commit_as("Neu eins", "Mira", "mira@example.com", &at(1));
        c.write_file("neu.txt", "2\n");
        c.commit_as("Neu zwei", "Mira", "mira@example.com", &at(2));
        c.git(&["push", "-q", "origin", "feature/neu"]);
    })
    .await;
    let digest = digest_get(&d.tc, d.id.clone(), None).await.unwrap().unwrap();
    let refs: Vec<_> = digest.refs.iter().map(|r| (r.name.as_str(), r.change, r.new_commits)).collect();
    assert_eq!(refs, vec![("origin/feature/neu", DigestRefChange::New, 2)]);
}

#[tokio::test]
async fn a_file_changed_on_the_current_branch_is_yours() {
    let d = colleague_day(colleague_story).await;
    d.repo.write_file("src/fehler.rs", "fn fehler() { \"Falsch\" }\n");
    d.repo.git(&["commit", "-q", "-m", "Fehler anders", "--", "src/fehler.rs"]);
    let digest = digest_get(&d.tc, d.id.clone(), None).await.unwrap().unwrap();
    assert_eq!(
        digest.your_files.iter().map(|f| (f.path.as_str(), f.local, f.on_branch)).collect::<Vec<_>>(),
        vec![("src/fehler.rs", false, true), ("src/login.rs", true, false)]
    );
}

#[tokio::test]
async fn a_missing_seen_state_is_created_and_reports_nothing() {
    let d = colleague_day(colleague_story).await;
    d.tc.db.with(|c| Ok(c.execute("delete from repo_seen", [])?)).unwrap();
    let digest = digest_get(&d.tc, d.id.clone(), None).await.unwrap().unwrap();
    assert!(digest.is_empty && digest.refs.is_empty());
    assert!(stored(&d.tc, &d.id).is_some(), "created");
    assert!(digest_get(&d.tc, d.id.clone(), None).await.unwrap().unwrap().is_empty, "and nothing is new against it");
}

#[tokio::test]
async fn a_young_seen_state_answers_none_without_work() {
    let d = colleague_day(colleague_story).await;
    assert_eq!(digest_get(&d.tc, d.id.clone(), Some(8)).await.unwrap(), None);
    let profile = d.tc.active_profile_id().unwrap();
    let mut row = seen_row(&d.tc, &d.id);
    row.seen_at = (chrono::Utc::now() - chrono::Duration::hours(9)).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    d.tc.db.with(|c| repo_seen::put(c, &profile, &d.id, &row)).unwrap();
    let digest = digest_get(&d.tc, d.id.clone(), Some(8)).await.unwrap().expect("old enough");
    assert!(!digest.is_empty);
}

#[tokio::test]
async fn marking_as_seen_empties_the_digest() {
    let d = colleague_day(colleague_story).await;
    digest_mark_seen(&d.tc, d.id.clone(), None).await.unwrap();
    assert!(digest_get(&d.tc, d.id.clone(), None).await.unwrap().unwrap().is_empty);
}

#[tokio::test]
async fn the_noreply_address_of_a_connected_github_account_is_own() {
    let d = colleague_day(|c| {
        c.write_file("web.txt", "aus dem Browser\n");
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
    let digest = digest_get(&d.tc, d.id.clone(), None).await.unwrap().unwrap();
    assert!(digest.refs.is_empty(), "{:?}", digest.refs);
    // No token in the keychain: the PR part stops before any request, which keeps this test offline.
    assert_eq!(digest.pr_data_missing, Some(HostKind::Github));
}

#[tokio::test]
async fn merging_the_seen_main_into_a_seen_branch_reports_only_the_merge() {
    let d = colleague_day(colleague_story).await;
    digest_mark_seen(&d.tc, d.id.clone(), None).await.unwrap();
    let c = TestRepo::clone_of(&d.remote);
    c.git(&["checkout", "-q", "-b", "feature/alt", "origin/feature/alt"]);
    c.git(&["merge", "-q", "--no-ff", "--no-edit", "origin/main"]);
    c.git(&["push", "-q", "origin", "feature/alt"]);
    sync::fetch(&d.tc, d.id.clone(), util::new_id(), None, true).await.unwrap();
    let digest = digest_get(&d.tc, d.id.clone(), None).await.unwrap().unwrap();
    let refs: Vec<_> = digest.refs.iter().map(|r| (r.name.as_str(), r.change, r.new_commits)).collect();
    assert_eq!(refs, vec![("origin/feature/alt", DigestRefChange::Updated, 1)]);
    assert_eq!(digest.new_commits, 1);
}

#[tokio::test]
async fn a_seen_tip_gone_from_the_object_database_counts_as_rewritten() {
    let d = colleague_day(colleague_story).await;
    let profile = d.tc.active_profile_id().unwrap();
    let mut row = seen_row(&d.tc, &d.id);
    row.refs.insert("refs/remotes/origin/feature/alt".into(), "0123456789abcdef0123456789abcdef01234567".into());
    d.tc.db.with(|c| repo_seen::put(c, &profile, &d.id, &row)).unwrap();
    let digest = digest_get(&d.tc, d.id.clone(), None).await.unwrap().unwrap();
    let alt = digest.refs.iter().find(|r| r.name == "origin/feature/alt").unwrap();
    assert_eq!((alt.change, alt.new_commits), (DigestRefChange::Rewritten, 1));
}

#[tokio::test]
async fn without_any_seen_ref_new_refs_list_no_commits() {
    let d = colleague_day(colleague_story).await;
    let profile = d.tc.active_profile_id().unwrap();
    let mut row = seen_row(&d.tc, &d.id);
    row.refs.clear();
    d.tc.db.with(|c| repo_seen::put(c, &profile, &d.id, &row)).unwrap();
    let digest = digest_get(&d.tc, d.id.clone(), None).await.unwrap().unwrap();
    assert!(!digest.refs.is_empty());
    assert!(digest.refs.iter().all(|r| r.change == DigestRefChange::New && r.new_commits == 0), "{:?}", digest.refs);
    assert_eq!(digest.new_commits, 0);
}

#[tokio::test]
async fn a_moved_annotated_tag_reports_both_commits() {
    let d = colleague_day(|c| {
        c.git(&["tag", "-a", "v0.9", "-m", "Vorab", "main"]);
        c.git(&["push", "-q", "origin", "v0.9"]);
    })
    .await;
    digest_mark_seen(&d.tc, d.id.clone(), None).await.unwrap();
    let old = d.repo.git(&["rev-parse", "v0.9^{commit}"]);
    let c = TestRepo::clone_of(&d.remote);
    c.commit_file("später.txt", "x\n", "Später");
    c.git(&["push", "-q", "origin", "main"]);
    sync::fetch(&d.tc, d.id.clone(), util::new_id(), None, true).await.unwrap();
    // A plain fetch never moves an existing tag: move it the way a forced tag fetch would.
    d.repo.git(&["tag", "-f", "-a", "v0.9", "-m", "Verschoben", "origin/main"]);
    let digest = digest_get(&d.tc, d.id.clone(), None).await.unwrap().unwrap();
    let tag = digest.refs.iter().find(|r| r.name == "v0.9").unwrap();
    assert_eq!(tag.change, DigestRefChange::Updated);
    assert_eq!(tag.old_sha.as_deref(), Some(old.as_str()));
    assert_eq!(tag.new_sha.as_deref(), Some(d.repo.git(&["rev-parse", "origin/main"]).as_str()));
}
