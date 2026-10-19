//! The newer half of the proposal (v1.2, 3.2 rework): reasons and "unsure" per unit, the user's
//! instruction for a new proposal, units the user placed, protected units and the hooks per
//! commit – against a local Ollama stand-in, never a real service.

use serde_json::json;

use super::apply_tests::{apply, commit, unit};
use super::proposal_tests::{c, chats, normalized, ollama, three_units, token_of_text, with_ollama};
use super::units_tests::{open, write_hook};
use super::*;
use crate::commands::ai::ai_preview;
use crate::error::ErrorCode;
use crate::model::{AiFeature, AiInput, AiOmitReason, ComposeKeep};
use crate::testkit::{TestCore, TestRepo};
use crate::util;

#[tokio::test]
async fn reasons_and_unsure_flags_come_back_per_unit_and_per_commit() {
    let long = "Weil ".repeat(80);
    let server = ollama(json!({"commits": [
        {"title": "Zeile zwei korrigieren", "body": "", "reason": "Beide Korrekturen in a.txt\ngehören zusammen.", "units": [
            {"unit": "u1", "reason": "Korrigiert die zweite Zeile.", "unsure": false},
            {"unit": "u2", "reason": long, "unsure": true}
        ]},
        {"title": "b großschreiben", "body": "", "reason": "", "units": [{"unit": "u3", "reason": "  Nur b.txt.  ", "unsure": false}]}
    ]}));
    let repo = three_units();
    let (tc, id) = with_ollama(&server, &repo).await;

    let proposal = compose_proposal(&tc, id, util::new_id(), "de".into(), None, Vec::new()).await.unwrap();

    let ids: Vec<String> = proposal.state.units.iter().map(|u| u.id.clone()).collect();
    assert_eq!(proposal.groups[0].reason, "Beide Korrekturen in a.txt gehören zusammen.", "one line");
    assert_eq!(proposal.groups[1].reason, "");
    assert_eq!(proposal.notes.len(), 3);
    assert_eq!((proposal.notes[0].unit.as_str(), proposal.notes[0].reason.as_str(), proposal.notes[0].unsure), (ids[0].as_str(), "Korrigiert die zweite Zeile.", false));
    assert_eq!(proposal.notes[1].unit, ids[1]);
    assert!(proposal.notes[1].unsure);
    assert!(proposal.notes[1].reason.chars().count() <= 200, "a long reason is cut: {}", proposal.notes[1].reason.chars().count());
    assert!(proposal.notes[1].reason.starts_with("Weil Weil"));
    assert_eq!(proposal.notes[2].reason, "Nur b.txt.");
}

#[tokio::test]
async fn answers_in_the_old_or_a_loose_shape_are_invalid() {
    let cases = vec![
        (json!({"commits": [{"title": "X", "body": "", "reason": "", "units": ["u1"]}]}), "units as plain aliases"),
        (json!({"commits": [{"title": "X", "body": "", "units": [{"unit": "u1", "reason": "", "unsure": false}]}]}), "a commit without reason"),
        (json!({"commits": [{"title": "X", "body": "", "reason": "", "units": [{"unit": "u1", "reason": "", "unsure": "yes"}]}]}), "unsure as text"),
        (json!({"commits": [{"title": "X", "body": "", "reason": "", "units": [{"unit": "u1", "unsure": false}]}]}), "a unit without reason"),
        (json!({"commits": [{"title": "X", "body": "", "reason": "", "units": [{"unit": "u1", "reason": "", "unsure": false, "confidence": 0.4}]}]}), "an extra field"),
    ];
    for (answer, why) in cases {
        let server = ollama(answer);
        let repo = three_units();
        let (tc, id) = with_ollama(&server, &repo).await;
        let err = compose_proposal(&tc, id, util::new_id(), "en".into(), None, Vec::new()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::AiInvalidAnswer, "{why}: {}", err.message);
    }
}

#[tokio::test]
async fn the_instruction_goes_into_the_system_text_between_guillemets_and_preview_and_request_agree() {
    let server = ollama(json!({"commits": [c("Tests", "", &["u1"])]}));
    let repo = three_units();
    let (tc, id) = with_ollama(&server, &repo).await;
    let instruction = "  Tests in einen\neigenen Commit  ";

    let preview = ai_preview(&tc, id.clone(), AiFeature::Compose, AiInput::Compose { instruction: Some(instruction.into()), keep: Vec::new() }, "de".into()).await.unwrap();
    compose_proposal(&tc, id.clone(), util::new_id(), "de".into(), Some(instruction.into()), Vec::new()).await.unwrap();

    let (system, user) = chats(&server).remove(0);
    assert!(system.contains("«Tests in einen eigenen Commit»"), "one line, between the delimiters of user text: {system}");
    assert!(!user.contains("Tests in einen"), "the instruction is not repository data");
    assert_eq!(normalized(&format!("{system}\n\n{user}")), normalized(&preview.text));

    let empty = ai_preview(&tc, id.clone(), AiFeature::Compose, AiInput::Compose { instruction: Some(" \n ".into()), keep: Vec::new() }, "de".into()).await.unwrap();
    assert!(!empty.text.contains('«'), "a blank instruction is none");
    let err = compose_proposal(&tc, id, util::new_id(), "de".into(), Some("x".repeat(301)), Vec::new()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    assert_eq!(chats(&server).len(), 1, "a too long instruction is refused before anything is sent");
}

#[tokio::test]
async fn units_the_user_placed_are_named_and_never_moved_by_the_answer() {
    // The provider still assigns u1 (placed by the user) – the answer is data, the user's move wins.
    let server = ollama(json!({"commits": [c("Alles zusammen", "", &["u1", "u2"])]}));
    let repo = three_units();
    repo.write_file(".env.local", "API_TOKEN=geheim-123456\n");
    let (tc, id) = with_ollama(&server, &repo).await;
    let state = compose_units(&tc, id.clone()).await.unwrap();
    let a0 = unit(&state, "a.txt", Some(0)).to_string();
    let b = unit(&state, "b.txt", Some(0)).to_string();
    let env = unit(&state, ".env.local", None).to_string();
    let keep = vec![
        ComposeKeep { unit: a0.clone(), commit: Some("Zeile «zwei»\nkorrigieren".into()) },
        ComposeKeep { unit: b, commit: None },
        ComposeKeep { unit: env, commit: Some("Geheimnis".into()) },
    ];

    let proposal = compose_proposal(&tc, id, util::new_id(), "de".into(), None, keep).await.unwrap();

    let (system, user) = chats(&server).remove(0);
    let token = token_of_text(&system);
    assert!(system.contains("Placed by the user"), "{system}");
    assert!(
        user.contains(&format!("## Placed by the user\n<<<REPO {token}>>>\n[unit u1] is in the commit “Zeile «zwei» korrigieren”\n[unit u3] is not committed\n<<<END {token}>>>")),
        "{user}"
    );
    assert!(!user.contains("Geheimnis") && !user.contains(".env.local"), "a protected unit is never mentioned: {user}");
    assert_eq!(proposal.groups.len(), 1);
    assert!(!proposal.groups[0].units.contains(&a0), "the placed unit is not in the answer's commit");
    assert!(proposal.notes.iter().all(|note| note.unit != a0));
}

#[tokio::test]
async fn secret_and_excluded_files_are_protected_and_never_committed() {
    let repo = TestRepo::with_commit();
    repo.commit_file(".forkyard/ai-ignore", "intern/\n", "KI-Ausschluss");
    repo.commit_file("a.txt", "a\n", "A");
    repo.write_file("a.txt", "A\n");
    repo.write_file(".env.local", "DB_PASSWORD=hunter2-sehr-geheim\n");
    repo.write_file("intern/plan.txt", "Übernahme am Montag\n");
    let tc = TestCore::new().await;
    let id = tc.open(&repo).await.repo.id;
    let base = repo.head();

    let state = compose_units(&tc, id.clone()).await.unwrap();

    let protection: Vec<(&str, Option<AiOmitReason>)> = state.units.iter().map(|u| (u.path.as_str(), u.protected)).collect();
    assert_eq!(protection, vec![(".env.local", Some(AiOmitReason::Secret)), ("a.txt", None), ("intern/plan.txt", Some(AiOmitReason::Ignored))]);
    let err = apply(&tc, &id, &state, vec![commit("Alles", "", &[unit(&state, "a.txt", Some(0)), unit(&state, ".env.local", None)])]).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    assert!(err.message.contains(".env.local"), "{}", err.message);
    assert_eq!(repo.head(), base, "nothing was committed");
    assert!(!repo.git_output(&["cat-file", "-e", "HEAD:.env.local"]).status.success(), "and the secret is not in HEAD");
}

#[tokio::test]
async fn the_state_names_the_commit_hooks_and_the_result_lists_them_per_commit() {
    let repo = TestRepo::with_commit();
    repo.commit_file("a.txt", "a\n", "Erster Stand der Datei a");
    repo.commit_file("b.txt", "b\n", "Erster Stand der Datei b");
    repo.write_file("a.txt", "A\n");
    repo.write_file("b.txt", "B\n");
    write_hook(&repo, "pre-commit", "echo pre-commit läuft");
    write_hook(&repo, "commit-msg", "exit 0");
    write_hook(&repo, "post-commit", "exit 0");
    let (tc, id) = open(&repo).await;

    let state = compose_units(&tc, id.clone()).await.unwrap();
    assert_eq!(state.head_subject, "Erster Stand der Datei b");
    assert_eq!(state.hooks, vec!["pre-commit".to_string(), "commit-msg".to_string()], "the hooks that can stop a commit, in Git's order");

    let result = apply(&tc, &id, &state, vec![commit("a groß", "", &[unit(&state, "a.txt", Some(0))]), commit("b groß", "", &[unit(&state, "b.txt", Some(0))])]).await.unwrap();

    assert_eq!(result.steps.len(), 2);
    assert_eq!(result.steps.iter().map(|step| step.sha.clone()).collect::<Vec<_>>(), result.commits);
    for step in &result.steps {
        assert!(step.hooks.contains(&"pre-commit".to_string()) && step.hooks.contains(&"commit-msg".to_string()), "{:?}", step.hooks);
    }
    assert_eq!(repo.git(&["log", "-2", "--format=%s"]).trim(), "b groß\na groß");
}
