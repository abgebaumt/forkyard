//! Fake embedding providers for the tests of the search by meaning: the "meaning" of a text is how
//! often words of three fixed families occur in it, plus a small constant (never a zero vector).

use std::time::Duration;

use serde_json::{json, Value};

use crate::commands::settings::settings_set;
use crate::model::AiProviderKind;
use crate::testkit::{MockResponse, MockServer, TestCore};

pub(crate) const MEANINGS: [&[&str]; 3] = [&["anmeld", "login", "sign-in"], &["absturz", "crash"], &["doku", "readme"]];
pub(crate) const OPENAI_KEY: &str = "sk-proj-semantictest-0123456789abcdef";

pub(crate) fn fake_vector(text: &str) -> Vec<f32> {
    let lower = text.to_lowercase();
    let mut vector: Vec<f32> = MEANINGS.iter().map(|words| words.iter().map(|word| lower.matches(word).count() as f32).sum()).collect();
    vector.push(0.1);
    vector
}

fn inputs(body: &Value) -> Vec<String> {
    body["input"].as_array().map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
}

/// Ollama's `/api/embed` with the fake meanings; every answer waits `delay`.
pub(crate) fn embed_server_with_delay(delay: Duration) -> MockServer {
    MockServer::start(move |request| match request.route().as_str() {
        "POST /api/embed" => {
            let body = request.json();
            let vectors: Vec<Vec<f32>> = inputs(&body).iter().map(|text| fake_vector(text)).collect();
            MockResponse::json(200, json!({ "model": body["model"], "embeddings": vectors })).delay(delay)
        }
        _ => MockResponse::json(404, json!({ "error": "not found" })),
    })
}

pub(crate) fn embed_server() -> MockServer {
    embed_server_with_delay(Duration::ZERO)
}

/// OpenAI's `/v1/embeddings` with the fake meanings.
pub(crate) fn openai_server() -> MockServer {
    MockServer::start(|request| {
        let data: Vec<Value> = inputs(&request.json())
            .iter()
            .enumerate()
            .map(|(index, text)| json!({ "object": "embedding", "index": index, "embedding": fake_vector(text) }))
            .collect();
        MockResponse::json(200, json!({ "object": "list", "data": data }))
    })
}

/// The texts of every embedding request, request by request.
pub(crate) fn embed_inputs(server: &MockServer) -> Vec<Vec<String>> {
    server
        .requests()
        .into_iter()
        .filter(|request| matches!(request.route().as_str(), "POST /api/embed" | "POST /v1/embeddings"))
        .map(|request| inputs(&request.json()))
        .collect()
}

/// AI on, Anthropic as main provider (never asked here) and Ollama as local embedder of the search.
pub(crate) async fn with_local_embedder(server: &MockServer, model: &str) -> TestCore {
    let tc = TestCore::new().await;
    crate::ai::configure_base(&tc, AiProviderKind::Ollama, Some(server.url()));
    settings_set(
        &tc,
        json!({"aiEnabled": true, "aiProvider": "anthropic", "aiModel": "claude-haiku-5-5", "aiSearchEmbedProvider": "ollama", "aiSearchEmbedModel": model}),
    )
    .await
    .unwrap();
    tc
}

/// AI on with OpenAI (key in the test keychain): embeddings through the main provider.
pub(crate) async fn with_openai(server: &MockServer) -> TestCore {
    let tc = TestCore::new().await;
    crate::ai::configure_base(&tc, AiProviderKind::Openai, Some(format!("{}/v1", server.url())));
    crate::secrets::set(&tc, "llm:openai", OPENAI_KEY).await.unwrap();
    settings_set(&tc, json!({"aiEnabled": true, "aiProvider": "openai", "aiModel": "gpt-5.5-mini"})).await.unwrap();
    tc
}
