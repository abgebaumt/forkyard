//! Pull request texts for “Explain intent” (v1.2, Teilpaket 6.1) against the GitHub test server.
//! The test data set: no. 7 comes from `feature/login`, no. 8 (`korrektur`) from a fork.

use super::*;
use crate::ai::conflict::pull_request_text;

const KIND: HostKind = HostKind::Github;
const SEVEN: &str = "#7 Thema 7 umsetzen\n\nBeschreibung zu **Thema 7**.\n\n- [x] Tests";

#[tokio::test]
async fn the_pull_request_of_a_branch_is_found_by_its_source_branch() {
    let fx = Fixture::new(KIND).await;
    assert_eq!(pull_request_text(&fx.tc, &fx.id(), Some("feature/login")).await.as_deref(), Some(SEVEN));
    assert!(!fx.sent("GET", "/pulls/7").is_empty(), "the text comes from the details of #7");
    assert_eq!(pull_request_text(&fx.tc, &fx.id(), Some("origin/feature/login")).await.as_deref(), Some(SEVEN), "the remote branch of the same remote");
    assert_eq!(pull_request_text(&fx.tc, &fx.id(), Some("main")).await, None, "no pull request comes from main");
    assert_eq!(pull_request_text(&fx.tc, &fx.id(), Some("korrektur")).await, None, "a pull request from a fork never matches a local branch");
    assert_eq!(pull_request_text(&fx.tc, &fx.id(), Some("  ")).await, None);
    assert_eq!(pull_request_text(&fx.tc, &fx.id(), None).await, None);
    fx.assert_token_stays_secret();
}

#[tokio::test]
async fn without_a_working_host_the_pull_request_texts_are_left_out() {
    let fx = Fixture::new(KIND).await;
    fx.mode("500");
    assert_eq!(pull_request_text(&fx.tc, &fx.id(), Some("feature/login")).await, None, "a host error is no error of the explanation");

    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    assert_eq!(pull_request_text(&tc, &id, Some("feature/login")).await, None, "a repository without a remote on a host");
}

#[tokio::test]
async fn the_pull_request_of_the_incoming_branch_goes_into_the_context() {
    use crate::ai::conflict::build;
    use crate::model::{ConflictBlockRange, Settings};

    let fx = Fixture::new(KIND).await;
    fx.repo.commit_file("docs/ablauf.md", "# Ablauf\n\nAnmeldung mit Passwort\n\nEnde\n", "Ablauf beschrieben");
    fx.repo.checkout_new("feature/login");
    fx.repo.commit_file("docs/ablauf.md", "# Ablauf\n\nAnmeldung mit Passwort und zweitem Faktor\n\nEnde\n", "Zweiter Faktor bei der Anmeldung");
    fx.repo.checkout("main");
    fx.repo.commit_file("docs/ablauf.md", "# Ablauf\n\nAnmeldung mit Passkey\n\nEnde\n", "Passkeys statt Passwort");
    assert!(!fx.repo.merge("feature/login"));
    let block = ConflictBlockRange { ours_start: 2, ours_count: 1, theirs_start: 2, theirs_count: 1 };
    let plan = build(&fx.tc, &fx.id(), "docs/ablauf.md", &[block], &Settings::default(), 32_000, "de-DE", &[]).await.unwrap();
    let prompt = &plan.built.prompt;
    let expected = format!("## Pull request of the incoming side\n<<<REPO {token}>>>\n{SEVEN}\n<<<END {token}>>>", token = prompt.token);
    assert!(prompt.user.contains(&expected), "{}", prompt.user);
    assert!(!prompt.user.contains("## Pull request of the current side"), "no pull request comes from main");
    assert!(!prompt.text().contains(TOKEN), "the host token never reaches the prompt");
}
