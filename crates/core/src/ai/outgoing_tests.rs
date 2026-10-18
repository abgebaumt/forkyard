//! What a push sends, as AI context (v1.2, 6.2).

use super::*;
use crate::commands::ai::ai_preview;
use crate::error::ErrorCode;
use crate::model::{AiFeature, AiInput, AiOmitReason, Settings};
use crate::testkit::{TestCore, TestRemote, TestRepo};

// Built at run time: no literal key format in this file.
fn aws() -> String {
    format!("AKIA{}", "Q7RZ4M2XK9PLW3NB")
}

#[tokio::test]
async fn outgoing_changes_hold_only_what_the_push_sends() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    repo.commit_file("alt.py", "print(\"alt-debug\")\n", "Alter Stand");
    repo.commit_file("alt/hinweis.md", "Hinweis\n", "Hinweis");
    let _remote = repo.add_remote();
    let id = tc.open(&repo).await.repo.id;
    let pushed = repo.head();

    repo.commit_file("-flag und ü.py", "def zaehle(n):\n    print(\"zwischenstand\", n)\n", "Zwischenstand ausgeben");
    repo.subdir("doku");
    repo.git(&["mv", "alt/hinweis.md", "doku/hinweis.md"]);
    repo.commit_as("Hinweis verschoben", "Ältere Zeit", "alt@example.com", "@1262304000 +1400");
    repo.commit_file("package-lock.json", "{\"lockfileVersion\": 3}\n", "Abhängigkeiten");
    repo.write_file(".env", format!("AWS={}\n", aws()));
    repo.commit_file("einstellungen.py", format!("AWS_ZUGANG = \"{}\"\n", aws()), "Zugang");

    let outgoing = outgoing(&tc, &id, "refs/heads/main", "origin").await.unwrap();
    assert_eq!(outgoing.base, pushed, "the diff starts where the remote is");
    assert_eq!(outgoing.base, repo.git(&["rev-parse", "origin/main"]));
    assert_eq!(outgoing.tip, repo.head());
    assert_eq!(outgoing.commits.iter().map(|(_, subject)| subject.as_str()).collect::<Vec<_>>(), vec!["Zugang", "Abhängigkeiten", "Hinweis verschoben", "Zwischenstand ausgeben"]);
    assert!(!outgoing.partial);

    let built = outgoing_changes(&tc, &id, &Settings::default(), 24_000, "de-DE", &[], &outgoing).await.unwrap();
    let text = built.built.prompt.user.clone();
    assert!(text.contains("zwischenstand") && text.contains("File: -flag und ü.py"), "{text}");
    assert!(text.contains("File: doku/hinweis.md (renamed from alt/hinweis.md)"), "{text}");
    assert!(text.contains("package-lock.json") && text.contains("generated or lock file"), "{text}");
    assert!(text.contains("Hinweis verschoben") && text.contains("Abhängigkeiten"), "the subjects go along: {text}");
    assert!(!text.contains("alt-debug"), "already on the remote");
    assert!(!text.contains(&aws()), "redacted");
    assert!(!text.contains(".env"), "secret files are not even named");
    assert_eq!((built.commits, built.files, built.partial), (4, 5, false));
    let mut shown = built.shown.clone();
    shown.sort();
    assert_eq!(shown, vec!["-flag und ü.py", "doku/hinweis.md", "einstellungen.py"]);
    assert!(built.built.omitted.iter().any(|item| item.path == ".env" && item.reason == AiOmitReason::Secret));
}

#[tokio::test]
async fn a_new_branch_and_a_first_push_start_from_the_right_base() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let first = repo.head();
    let remote = TestRemote::new();
    repo.git(&["remote", "add", "origin", &remote.url()]);
    let id = tc.open(&repo).await.repo.id;
    repo.commit_file("b.txt", "b\n", "Zweiter");

    let root = outgoing(&tc, &id, "refs/heads/main", "origin").await.unwrap();
    assert_eq!(root.commits.len(), 2);
    assert_eq!(root.base, crate::commands::diff::empty_tree(&first), "nothing on the remote: from the empty tree");

    repo.git(&["push", "-q", "origin", "main"]);
    repo.git(&["fetch", "-q", "origin"]);
    let main = repo.head();
    repo.checkout_new("feature/größe");
    repo.commit_file("c.txt", "c\n", "Dritter");
    let feature = outgoing(&tc, &id, "refs/heads/feature/größe", "origin").await.unwrap();
    assert_eq!(feature.base, main, "a new branch starts where the remote already has its history");
    assert_eq!(feature.commits.iter().map(|(_, subject)| subject.as_str()).collect::<Vec<_>>(), vec!["Dritter"]);

    repo.git(&["push", "-q", "origin", "feature/größe"]);
    repo.git(&["fetch", "-q", "origin"]);
    let none = outgoing(&tc, &id, "refs/heads/feature/größe", "origin").await.unwrap();
    assert!(none.commits.is_empty());
    assert_eq!(none.base, none.tip);
}

#[tokio::test]
async fn what_is_sent_shows_the_outgoing_changes_with_the_rules_of_push() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let _remote = repo.add_remote();
    let id = tc.open(&repo).await.repo.id;
    repo.commit_file("zaehler.py", "print(\"zwischenstand\")\n", "Zwischenstand");
    let input = |remote: Option<&str>| AiInput::OutgoingChanges { branch: None, remote: remote.map(str::to_string), remote_branch: None };

    let preview = ai_preview(&tc, id.clone(), AiFeature::PushReview, input(None), "en".into()).await.unwrap();
    assert!(preview.text.contains("zwischenstand") && preview.text.contains("Zwischenstand"), "{}", preview.text);
    assert!(preview.asks.is_empty(), "AI is not on: nothing to confirm, nothing sent");

    repo.checkout_new("ohne-upstream");
    let err = ai_preview(&tc, id.clone(), AiFeature::PushReview, input(None), "en".into()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NoUpstream, "the same rules as push");
    let to_origin = ai_preview(&tc, id.clone(), AiFeature::PushReview, input(Some("origin")), "en".into()).await.unwrap();
    assert!(to_origin.text.contains("zwischenstand"));
    assert_eq!(ai_preview(&tc, id, AiFeature::PushReview, input(Some("gibt-es-nicht")), "en".into()).await.unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(serde_json::to_value(input(Some("origin"))).unwrap(), serde_json::json!({"kind": "outgoing_changes", "branch": null, "remote": "origin", "remoteBranch": null}));
}
