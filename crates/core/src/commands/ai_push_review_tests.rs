//! `ai_push_review` (v1.2, 6.2) against local mock providers: what goes out, what comes back.

use serde_json::json;

use super::*;
use crate::commands::settings::{repo_settings_set, settings_set};
use crate::error::ErrorCode;
use crate::model::{AiPushFinding, AiPushFindingKind, AiPushReview};
use crate::testkit::{MockResponse, MockServer, TestCore, TestRemote, TestRepo};

// Built at run time: no literal key format in this file.
fn key() -> String {
    format!("sk-ant-api03-{}", "testkey-0123456789abcdef")
}
fn aws() -> String {
    format!("AKIA{}", "Q7RZ4M2XK9PLW3NB")
}

fn ollama(answer: Value) -> MockServer {
    MockServer::start(move |request| match request.route().as_str() {
        "POST /api/show" => MockResponse::json(200, json!({"model_info": {"qwen3.context_length": 40960}})),
        "POST /api/chat" => MockResponse::json(
            200,
            json!({"model": "qwen3:8b", "message": {"role": "assistant", "content": answer.to_string()}, "done": true, "done_reason": "stop", "prompt_eval_count": 900, "eval_count": 40}),
        ),
        _ => MockResponse::json(404, json!({"error": "not found"})),
    })
}

async fn with_ollama(server: &MockServer) -> TestCore {
    let tc = TestCore::new().await;
    crate::ai::configure_base(&tc, AiProviderKind::Ollama, Some(server.url()));
    settings_set(&tc, json!({"aiEnabled": true, "aiProvider": "ollama", "aiModel": "qwen3:8b"})).await.unwrap();
    tc
}

fn chats(server: &MockServer) -> Vec<String> {
    server.requests().into_iter().filter(|request| request.route() == "POST /api/chat").map(|request| request.body_text()).collect()
}

/// `main` pushed with an old debug print; three commits go out, one of them dated 2010 in UTC+14.
fn repo_with_outgoing() -> (TestRepo, TestRemote) {
    let repo = TestRepo::with_commit();
    repo.commit_file("alt.py", "def alt():\n    print(\"alt-debug\")\n", "Alter Stand");
    let remote = repo.add_remote();
    repo.commit_file("src/zähler.py", "def zaehle(n):\n    print(\"zwischenstand\", n)\n    return n + 1\n", "Zähler");
    repo.commit_file("einstellungen.py", format!("AWS_ZUGANG = \"{}\"\n", aws()), "Zugang");
    repo.write_file(".env", "DB_PASSWORD=sehr-geheim-123\n");
    repo.commit_as("Umgebung", "Ältere Zeit", "alt@example.com", "@1262304000 +1400");
    (repo, remote)
}

#[test]
fn the_review_schema_is_in_the_dialect() {
    crate::ai::schema::check_dialect(&push_review_schema()).unwrap();
}

#[tokio::test]
async fn push_review_sends_only_what_goes_out_and_keeps_findings_of_shown_files() {
    let server = ollama(json!({"findings": [
        {"path": "src/zähler.py", "line": 2, "kind": "debug_output", "note": "Leftover print of the intermediate state."},
        {"path": "src\\zähler.py", "line": 2, "kind": "debug_output", "note": "Leftover print of the intermediate state."},
        {"path": "gibt/es/nicht.py", "line": 1, "kind": "likely_bug", "note": "Invented file."},
        {"path": ".env", "line": 1, "kind": "likely_bug", "note": "Never shown to the model."},
        {"path": "../ausserhalb.py", "line": 1, "kind": "likely_bug", "note": "Outside the repository."},
        {"path": "einstellungen.py", "line": 0, "kind": "likely_bug", "note": format!("Key {} is hard-coded.", aws())},
        {"path": "einstellungen.py", "line": 1, "kind": "commented_code", "note": "   "}
    ]}));
    let tc = with_ollama(&server).await;
    let (repo, _remote) = repo_with_outgoing();
    let id = tc.open(&repo).await.repo.id;

    let review = ai_push_review(&tc, id.clone(), "review-1".into(), None, None, None, "de-DE".into()).await.unwrap();
    let expected_commits: u32 = repo.git(&["rev-list", "--count", "--first-parent", "main", "--not", "--remotes=origin"]).parse().unwrap();
    assert_eq!((review.commits, review.files, review.partial), (expected_commits, 3, false));
    assert_eq!(
        review.findings,
        vec![
            AiPushFinding { path: "einstellungen.py".into(), line: None, kind: AiPushFindingKind::LikelyBug, note: "Key *** is hard-coded.".into() },
            AiPushFinding { path: "src/zähler.py".into(), line: Some(2), kind: AiPushFindingKind::DebugOutput, note: "Leftover print of the intermediate state.".into() },
        ],
        "invented, hidden and outside files, duplicates and empty notes are dropped; keys in notes are redacted"
    );

    let bodies = chats(&server);
    assert_eq!(bodies.len(), 1);
    let body = &bodies[0];
    assert!(body.contains("zwischenstand") && body.contains("Zähler") && body.contains("Umgebung"), "what goes out: {body}");
    assert!(!body.contains("alt-debug"), "already on the remote");
    assert!(!body.contains(&aws()) && !body.contains("sehr-geheim-123"), "keys are redacted, .env is left out");
}

#[tokio::test]
async fn nothing_to_push_sends_nothing() {
    let server = ollama(json!({"findings": []}));
    let tc = with_ollama(&server).await;
    let repo = TestRepo::with_commit();
    let _remote = repo.add_remote();
    let id = tc.open(&repo).await.repo.id;
    let review = ai_push_review(&tc, id, "review-2".into(), None, None, None, "en".into()).await.unwrap();
    assert_eq!(review, AiPushReview { findings: Vec::new(), commits: 0, files: 0, partial: false });
    assert!(chats(&server).is_empty());
}

#[tokio::test]
async fn the_review_asks_like_every_request_and_follows_the_push_target() {
    // Like 1a's tests: every route gets the answer; only `POST /v1/messages` is counted.
    let server = MockServer::start(|_| {
        MockResponse::json(200, json!({"content": [{"type": "text", "text": "{\"findings\":[]}"}], "stop_reason": "end_turn", "usage": {"input_tokens": 1200, "output_tokens": 30}}))
    });
    let tc = TestCore::new().await;
    crate::ai::configure_base(&tc, AiProviderKind::Anthropic, Some(format!("{}/v1", server.url())));
    crate::secrets::set(&tc, "llm:anthropic", &key()).await.unwrap();
    settings_set(&tc, json!({"aiEnabled": true, "aiProvider": "anthropic", "aiModel": "claude-sonnet-5-5"})).await.unwrap();
    let (repo, _remote) = repo_with_outgoing();
    let id = tc.open(&repo).await.repo.id;
    let input = |remote: Option<&str>| AiInput::OutgoingChanges { branch: None, remote: remote.map(str::to_string), remote_branch: None };

    let err = ai_push_review(&tc, id.clone(), "r1".into(), None, None, None, "en".into()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed, "first use and first content of this repository need a confirmation");
    assert_eq!(server.count("POST /v1/messages"), 0);
    let preview = ai_preview(&tc, id.clone(), AiFeature::PushReview, input(None), "en".into()).await.unwrap();
    assert_eq!(preview.asks, vec![AiAskTrigger::FirstUse, AiAskTrigger::RepoFirst]);
    ai_preview_confirm(&tc, Some(id.clone()), AiFeature::PushReview, preview.fingerprint.clone(), preview.asks.clone(), false).await.unwrap();
    let review = ai_push_review(&tc, id.clone(), "r2".into(), None, None, None, "en".into()).await.unwrap();
    assert!(review.findings.is_empty());
    assert_eq!(server.count("POST /v1/messages"), 1, "the confirmed preview is exactly what was sent");
    let sent = server.requests().into_iter().find(|request| request.route() == "POST /v1/messages").unwrap().body_text();
    assert!(!sent.contains(&key()) && !sent.contains(&aws()));

    // A branch without upstream: the rules of push.
    repo.checkout_new("feature/größe");
    repo.commit_file("neu.txt", "neu\n", "Neu");
    assert_eq!(ai_push_review(&tc, id.clone(), "r3".into(), None, None, None, "en".into()).await.unwrap_err().code, ErrorCode::NoUpstream);
    let to_origin = ai_preview(&tc, id.clone(), AiFeature::PushReview, input(Some("origin")), "en".into()).await.unwrap();
    assert!(to_origin.text.contains("Neu") && to_origin.text.contains("Zähler"), "everything not on origin goes out");

    repo_settings_set(&tc, id.clone(), json!({"aiOff": true})).await.unwrap();
    assert_eq!(ai_push_review(&tc, id, "r4".into(), None, Some("origin".into()), None, "en".into()).await.unwrap_err().code, ErrorCode::AiDisabled);
}
