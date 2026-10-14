//! The follow-up job that updates submodules after checkout and reset, against local bare
//! repositories as the "server" (`protocol.file.allow=always` only in this test core).

use std::time::Duration;

use serde_json::json;

use super::*;
use crate::commands::branches::branch_checkout;
use crate::commands::merge::reset_branch;
use crate::commands::settings::repo_settings_set;
use crate::events::names;
use crate::model::{Head, ResetMode};
use crate::testkit::{TestCore, TestRemote, TestRepo};

const ALLOW_FILE: &str = "[protocol \"file\"]\n\tallow = always\n";
const SUB: &str = "libs/werkzeug";

struct Fixture {
    tc: TestCore,
    repo: TestRepo,
    id: String,
    first: String,
    _lib: TestRepo,
    _remote: TestRemote,
}

fn sub_git(repo: &TestRepo, args: &[&str]) -> String {
    let dir = repo.path().join(SUB).to_string_lossy().into_owned();
    let mut all = vec!["-C", dir.as_str(), "-c", "user.name=Test Person", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"];
    all.extend_from_slice(args);
    repo.git(&all)
}

/// `main` records the library's second commit, branch `alt` its first; the submodule is checked
/// out at the second (in sync with `main`). HEAD on `main`.
async fn fixture() -> Fixture {
    let tc = TestCore::with_global_config(ALLOW_FILE).await;
    let lib = TestRepo::new();
    let first = lib.commit_file("lib.txt", "eins\n", "Bibliothek angelegt");
    let second = lib.commit_file("lib.txt", "eins\nzwei\n", "Bibliothek erweitert");
    let remote = lib.add_remote();
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    submodule_add(&tc, id.clone(), "job-add".into(), remote.url(), SUB.into()).await.unwrap();
    repo.commit("Submodul bei zwei");
    repo.checkout_new("alt");
    sub_git(&repo, &["checkout", "-q", &first]);
    repo.git(&["add", SUB]);
    repo.git(&["commit", "-q", "-m", "Submodul bei eins"]);
    repo.checkout("main");
    sub_git(&repo, &["checkout", "-q", &second]);
    tc.events.clear();
    Fixture { tc, repo, id, first, _lib: lib, _remote: remote }
}

/// The next `submodules:updated` (the follow-up job runs in the background).
async fn next_update(tc: &TestCore) -> serde_json::Value {
    for _ in 0..400 {
        if let Some(event) = tc.events.named(names::SUBMODULES_UPDATED).into_iter().next() {
            return event;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("no submodules:updated within 10 s");
}

#[test]
fn only_changed_or_new_recorded_commits_count() {
    let before = vec![(b"a".to_vec(), "1".to_string()), (b"b".to_vec(), "2".to_string())];
    let after = vec![(b"a".to_vec(), "1".to_string()), (b"b".to_vec(), "3".to_string()), (b"c".to_vec(), "4".to_string())];
    assert_eq!(auto::changed_paths(&before, &after), ["b", "c"]);
    assert!(auto::changed_paths(&after, &after).is_empty());
}

#[test]
fn gitlinks_are_read_from_ls_tree_records() {
    let out = b"100644 blob aaaa\tREADME.md\x00160000 commit bbbb\tlibs/werk zeug\x00100644 blob cccc\t.gitmodules\x00";
    assert_eq!(auto::tree_gitlinks(out), [(b"libs/werk zeug".to_vec(), "bbbb".to_string())]);
    assert!(auto::tree_gitlinks(b"").is_empty());
}

#[tokio::test]
async fn checkout_brings_changed_submodules_along_unless_switched_off() {
    let f = fixture().await;
    branch_checkout(&f.tc, f.id.clone(), "alt".into()).await.unwrap();
    assert_eq!(next_update(&f.tc).await, json!({ "repoId": f.id, "ok": true, "paths": [SUB], "message": null }));
    assert_eq!(sub_git(&f.repo, &["rev-parse", "HEAD"]), f.first);

    // Switched off: the checkout stays the only change.
    repo_settings_set(&f.tc, f.id.clone(), json!({ "submodulesAutoUpdate": false })).await.unwrap();
    f.tc.events.clear();
    branch_checkout(&f.tc, f.id.clone(), "main".into()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(f.tc.events.count(names::SUBMODULES_UPDATED), 0);
    assert_eq!(sub_git(&f.repo, &["rev-parse", "HEAD"]), f.first, "not updated");
}

#[tokio::test]
async fn a_failed_update_is_a_warning_not_an_error_of_the_checkout() {
    let f = fixture().await;
    branch_checkout(&f.tc, f.id.clone(), "alt".into()).await.unwrap();
    next_update(&f.tc).await;
    // A local change in the submodule that checking out the other commit would overwrite.
    f.repo.write_file(&format!("{SUB}/lib.txt"), "lokal\n");
    f.tc.events.clear();

    let status = branch_checkout(&f.tc, f.id.clone(), "main".into()).await.unwrap();
    assert!(matches!(&status.head, Head::Branch { branch, .. } if branch == "main"), "{:?}", status.head);
    let event = next_update(&f.tc).await;
    assert_eq!((event["ok"].clone(), event["paths"].clone()), (json!(false), json!([SUB])));
    assert!(event["message"].as_str().is_some_and(|text| text.contains("Local changes")), "{event}");
    assert_eq!(sub_git(&f.repo, &["rev-parse", "HEAD"]), f.first);
}

#[tokio::test]
async fn hard_reset_updates_but_mixed_reset_does_not() {
    let f = fixture().await;
    let alt = f.repo.git(&["rev-parse", "alt"]);
    let main = f.repo.head();
    reset_branch(&f.tc, f.id.clone(), alt.clone(), ResetMode::Mixed).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(f.tc.events.count(names::SUBMODULES_UPDATED), 0, "mixed leaves the working directory alone");
    reset_branch(&f.tc, f.id.clone(), main, ResetMode::Mixed).await.unwrap();

    reset_branch(&f.tc, f.id.clone(), alt, ResetMode::Hard).await.unwrap();
    assert_eq!(next_update(&f.tc).await["ok"], true);
    assert_eq!(sub_git(&f.repo, &["rev-parse", "HEAD"]), f.first);
}

#[tokio::test]
async fn creating_and_checking_out_a_branch_brings_submodules_along() {
    let f = fixture().await;
    let alt = f.repo.git(&["rev-parse", "alt"]);
    crate::commands::branches::branch_create(&f.tc, f.id.clone(), "neu".into(), Some(alt), false).await.unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(f.tc.events.count(names::SUBMODULES_UPDATED), 0, "without checkout nothing moves");

    crate::commands::branches::branch_create(&f.tc, f.id.clone(), "neu2".into(), Some("alt".into()), true).await.unwrap();
    assert_eq!(next_update(&f.tc).await["ok"], true);
    assert_eq!(sub_git(&f.repo, &["rev-parse", "HEAD"]), f.first);
}

#[tokio::test]
async fn undo_of_a_checkout_brings_submodules_back() {
    let f = fixture().await;
    let second = sub_git(&f.repo, &["rev-parse", "HEAD"]);
    branch_checkout(&f.tc, f.id.clone(), "alt".into()).await.unwrap();
    next_update(&f.tc).await;
    f.tc.events.clear();
    crate::commands::undo::undo(&f.tc, f.id.clone()).await.unwrap();
    assert_eq!(f.repo.current_branch(), "main");
    assert_eq!(next_update(&f.tc).await["ok"], true);
    assert_eq!(sub_git(&f.repo, &["rev-parse", "HEAD"]), second);
}

#[tokio::test]
async fn bisect_start_and_reset_bring_submodules_along() {
    let f = fixture().await;
    let second = sub_git(&f.repo, &["rev-parse", "HEAD"]);
    let good = f.repo.head();
    f.repo.checkout("alt");
    // Only the new file: the submodule (still at the second commit) stays as `alt` records it.
    for name in ["a.txt", "b.txt", "c.txt"] {
        f.repo.write_file(name, "x\n");
        f.repo.git(&["add", name]);
        f.repo.git(&["commit", "-q", "-m", name]);
    }
    let bad = f.repo.head();
    f.repo.checkout("main");
    sub_git(&f.repo, &["checkout", "-q", &second]);
    f.tc.events.clear();

    crate::commands::bisect::bisect_start(&f.tc, f.id.clone(), bad, vec![good]).await.unwrap();
    assert_eq!(next_update(&f.tc).await["ok"], true);
    assert_eq!(sub_git(&f.repo, &["rev-parse", "HEAD"]), f.first, "every tested commit records the first library commit");
    f.tc.events.clear();

    crate::commands::bisect::bisect_reset(&f.tc, f.id.clone()).await.unwrap();
    assert_eq!(next_update(&f.tc).await["ok"], true);
    assert_eq!(sub_git(&f.repo, &["rev-parse", "HEAD"]), second);
}

#[tokio::test]
async fn a_submodule_with_commits_on_no_ref_is_left_alone() {
    let f = fixture().await;
    sub_git(&f.repo, &["checkout", "-q", "--detach"]);
    f.repo.write_file(&format!("{SUB}/eigen.txt"), "eigen\n");
    sub_git(&f.repo, &["add", "eigen.txt"]);
    sub_git(&f.repo, &["commit", "-q", "-m", "Eigener Stand"]);
    let own = sub_git(&f.repo, &["rev-parse", "HEAD"]);
    f.tc.events.clear();

    branch_checkout(&f.tc, f.id.clone(), "alt".into()).await.unwrap();
    let event = next_update(&f.tc).await;
    assert_eq!((event["ok"].clone(), event["paths"].clone()), (json!(false), json!([SUB])));
    assert!(event["message"].as_str().is_some_and(|text| text.contains("not on any branch")), "{event}");
    assert_eq!(sub_git(&f.repo, &["rev-parse", "HEAD"]), own, "the own commit stays checked out");
}

#[tokio::test]
async fn a_submodule_on_a_branch_follows_even_with_own_commits() {
    let f = fixture().await;
    sub_git(&f.repo, &["checkout", "-q", "-b", "arbeit"]);
    f.repo.write_file(&format!("{SUB}/eigen.txt"), "eigen\n");
    sub_git(&f.repo, &["add", "eigen.txt"]);
    sub_git(&f.repo, &["commit", "-q", "-m", "Eigener Stand"]);
    f.tc.events.clear();

    branch_checkout(&f.tc, f.id.clone(), "alt".into()).await.unwrap();
    assert_eq!(next_update(&f.tc).await["ok"], true, "the branch keeps the commit");
    assert_eq!(sub_git(&f.repo, &["rev-parse", "HEAD"]), f.first);
}
