//! `execute`: every allowed action calls the existing core command – checked in Git itself
//! (branches, tags, the stash list, the bare remote) – including a step that stops on conflicts
//! (taken back at once), a cherry-pick across a rename and a force push whose lease no longer holds.

use serde_json::json;

use super::*;
use crate::error::ErrorCode;
use crate::testkit::{TestCore, TestRepo};

async fn setup() -> (TestCore, TestRepo, String) {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    (tc, repo, id)
}

async fn exec(tc: &TestCore, id: &str, action: PlanAction) -> CoreResult<()> {
    execute(tc, id, &crate::util::new_id(), &action).await
}

fn has_ref(repo: &TestRepo, name: &str) -> bool {
    repo.git_output(&["rev-parse", "--verify", "-q", name]).status.success()
}

#[tokio::test]
async fn local_actions_run_the_existing_commands() {
    let (tc, repo, id) = setup().await;
    let base = repo.head();
    exec(&tc, &id, PlanAction::BranchCreate { name: "feature/größe".into(), start: base.clone(), checkout: true }).await.unwrap();
    assert_eq!(repo.current_branch(), "feature/größe");
    let second = repo.commit_file("liste.txt", "eins\n", "Liste");

    exec(&tc, &id, PlanAction::TagCreate { name: "v1.0".into(), sha: Some(base.clone()), message: Some("Erste Version".into()) }).await.unwrap();
    assert_eq!(repo.git(&["rev-parse", "v1.0^{commit}"]), base);
    assert_eq!(repo.git(&["cat-file", "-t", "v1.0"]), "tag", "a message makes it annotated");

    exec(&tc, &id, PlanAction::CommitReword { sha: None, summary: "Liste der Größen".into(), description: String::new() }).await.unwrap();
    assert_eq!(repo.git(&["log", "-1", "--format=%s"]), "Liste der Größen");
    assert_ne!(repo.head(), second, "the commit was rewritten");

    repo.write_file("notizen/über uns.md", "Entwurf\n");
    repo.write_file("anderes.txt", "bleibt\n");
    exec(&tc, &id, PlanAction::StashCreate { message: Some("Notizen".into()), include_untracked: true, paths: vec!["notizen/über uns.md".into()] }).await.unwrap();
    assert_eq!(repo.git(&["stash", "list", "--format=%s"]), "On feature/größe: Notizen");
    assert!(!repo.path().join("notizen/über uns.md").exists(), "only the named file is stashed");
    assert_eq!(repo.read_file("anderes.txt"), b"bleibt\n");

    exec(&tc, &id, PlanAction::BranchCheckout { target: "main".into() }).await.unwrap();
    assert_eq!(repo.current_branch(), "main");
    exec(&tc, &id, PlanAction::BranchRename { name: "feature/größe".into(), new_name: "feature/maße".into() }).await.unwrap();
    assert!(has_ref(&repo, "refs/heads/feature/maße") && !has_ref(&repo, "refs/heads/feature/größe"));
    exec(&tc, &id, PlanAction::BranchDelete { name: "feature/maße".into(), force: true }).await.unwrap();
    assert!(!has_ref(&repo, "refs/heads/feature/maße"));

    let gone = repo.commit_file("weg.txt", "weg\n", "Wird zurückgesetzt");
    exec(&tc, &id, PlanAction::ResetBranch { sha: base.clone(), mode: crate::model::ResetMode::Hard }).await.unwrap();
    assert_eq!(repo.head(), base);
    assert!(!repo.path().join("weg.txt").exists());
    assert_ne!(gone, base);
}

#[tokio::test]
async fn a_step_that_stops_on_conflicts_is_taken_back_at_once() {
    let (tc, repo, id) = setup().await;
    repo.commit_file("f.txt", "eins\nzwei\ndrei\n", "Basis");
    repo.checkout_new("seite");
    let seite = repo.commit_file("f.txt", "eins\nZWEI seite\ndrei\n", "Seite");
    repo.checkout("main");
    let head = repo.commit_file("f.txt", "eins\nzwei main\ndrei\n", "Main");

    let err = exec(&tc, &id, PlanAction::MergeStart { source: "seite".into(), mode: crate::model::MergeMode::Default }).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    assert!(err.message.contains("f.txt"), "{}", err.message);
    assert_eq!(repo.head(), head);
    assert!(!repo.path().join(".git/MERGE_HEAD").exists(), "no half-done merge is left");
    assert_eq!(repo.git(&["status", "--porcelain"]), "");

    let err = exec(&tc, &id, PlanAction::CherryPick { shas: vec![seite] }).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::Conflict);
    assert!(!repo.path().join(".git/CHERRY_PICK_HEAD").exists(), "no half-done cherry-pick is left");
    assert_eq!(repo.git(&["status", "--porcelain"]), "");
    assert_eq!(repo.head(), head);
    let open = tc.db.with(|c| crate::db::undo::list_done(c, &id, "")).unwrap();
    assert!(open.iter().all(|e| e.payload.get("pending") != Some(&json!(true))), "no open undo entry is left: {open:?}");
}

#[tokio::test]
async fn a_cherry_pick_follows_a_renamed_file() {
    let (tc, repo, id) = setup().await;
    repo.commit_file("alt/name.txt", "eins\nzwei\ndrei\nvier\nfünf\n", "Datei");
    repo.checkout_new("umbau");
    // `git mv` does not create the target folder.
    std::fs::create_dir_all(repo.path().join("neu")).unwrap();
    repo.git(&["mv", "alt/name.txt", "neu/name mit leer.txt"]);
    repo.commit("Umbenannt");
    repo.checkout("main");
    let fix = repo.commit_file("alt/name.txt", "eins\nzwei\nDREI\nvier\nfünf\n", "Zeile 3 korrigiert");
    repo.checkout("umbau");
    exec(&tc, &id, PlanAction::CherryPick { shas: vec![fix] }).await.unwrap();
    assert_eq!(repo.read_file("neu/name mit leer.txt"), b"eins\nzwei\nDREI\nvier\nf\xc3\xbcnf\n");
    assert!(!repo.path().join("alt/name.txt").exists());
    assert_eq!(repo.git(&["log", "-1", "--format=%s"]), "Zeile 3 korrigiert");
}

#[tokio::test]
async fn outward_actions_push_delete_and_push_tags() {
    let (tc, repo, id) = setup().await;
    let remote = repo.add_remote();
    repo.checkout_new("neu");
    let tip = repo.commit_file("n.txt", "n\n", "Neu");
    exec(&tc, &id, PlanAction::Push { branch: "neu".into(), remote: Some("origin".into()), force: false, expected: None }).await.unwrap();
    assert_eq!(remote.git(&["rev-parse", "refs/heads/neu"]), tip);
    repo.tag("v2");
    exec(&tc, &id, PlanAction::TagPush { name: "v2".into(), remote: "origin".into() }).await.unwrap();
    assert_eq!(remote.git(&["rev-parse", "refs/tags/v2"]), tip);
    exec(&tc, &id, PlanAction::BranchDeleteRemote { remote: "origin".into(), name: "neu".into() }).await.unwrap();
    assert!(!remote.git_output(&["rev-parse", "--verify", "-q", "refs/heads/neu"]).status.success());
}

#[tokio::test]
async fn a_force_push_never_overwrites_what_its_lease_has_not_seen() {
    let (tc, repo, id) = setup().await;
    let remote = repo.add_remote();
    let seen = repo.git(&["rev-parse", "refs/remotes/origin/main"]);
    // Someone else pushes; this repository has not fetched.
    let other = TestRepo::clone_of(&remote);
    let theirs = other.commit_file("fremd.txt", "fremd\n", "Von jemand anderem");
    other.git(&["push", "-q", "origin", "main"]);
    repo.git(&["commit", "--amend", "-q", "-m", "Umgeschrieben"]);
    let result = exec(&tc, &id, PlanAction::Push { branch: "main".into(), remote: None, force: true, expected: Some(seen) }).await;
    assert!(result.is_err(), "{result:?}");
    assert_eq!(remote.git(&["rev-parse", "refs/heads/main"]), theirs, "the remote keeps the other commit");
}

/// Paket 6.2: the local secret scan runs before every push, plan steps included, and a plan never
/// pushes past a finding. The fake key is built at run time (6.2's rule: no literal key formats in
/// the sources); the oracle is the bare remote itself.
#[tokio::test]
async fn a_push_step_with_a_key_stops_before_anything_is_sent() {
    let (tc, repo, id) = setup().await;
    let remote = repo.add_remote();
    let before = remote.git(&["rev-parse", "refs/heads/main"]);
    let key = format!("AKIA{}", "Q7RZ4M2XK9PLW3NB");
    repo.commit_file("dienst/zugang.env", format!("AWS_ZUGANG={key}\n"), "Zugang für den Dienst");

    let err = exec(&tc, &id, PlanAction::Push { branch: "main".into(), remote: None, force: false, expected: None }).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    assert!(err.message.starts_with("“main” was not pushed"), "{}", err.message);
    assert!(err.message.contains("dienst/zugang.env:1"), "the place is named: {}", err.message);
    assert!(!err.message.contains(&key) && !err.message.contains("Q7RZ4M2XK9PLW3NB"), "the value is never shown: {}", err.message);
    assert_eq!(remote.git(&["rev-parse", "refs/heads/main"]), before, "nothing was sent");

    repo.git(&["tag", "-a", "v3", "-m", "Version 3"]);
    let err = exec(&tc, &id, PlanAction::TagPush { name: "v3".into(), remote: "origin".into() }).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    assert!(err.message.starts_with("Tag “v3” was not pushed"), "{}", err.message);
    assert!(!remote.git_output(&["rev-parse", "--verify", "-q", "refs/tags/v3"]).status.success(), "the tag stayed local");
}

#[tokio::test]
async fn a_failed_fetch_ends_the_step() {
    let (tc, repo, id) = setup().await;
    repo.git(&["remote", "add", "kaputt", "/gibt/es/nicht/repo.git"]);
    assert!(exec(&tc, &id, PlanAction::Fetch { remote: Some("kaputt".into()), prune: false }).await.is_err(), "a named remote fails itself");
    let err = exec(&tc, &id, PlanAction::Fetch { remote: None, prune: false }).await.unwrap_err();
    assert!(err.message.contains("kaputt"), "{}", err.message);
}
