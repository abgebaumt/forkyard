//! Embeddings of the providers (spec 9.2), against local mocks.

use super::*;
use crate::error::ErrorCode;
use crate::jobs::CancelToken;
use crate::model::{AiProviderKind, AiStructuredMode};
use crate::testkit::{MockResponse, MockServer, TestCore};
use serde_json::json;

const KEY: &str = "sk-proj-embedtest-0123456789abcdef";

fn texts(list: &[&str]) -> Vec<String> {
    list.iter().map(|text| text.to_string()).collect()
}

fn provider(kind: AiProviderKind, base: String, key: Option<&str>, model: &str) -> Box<dyn Provider> {
    build(kind, base, key.map(str::to_string), model.to_string(), AiStructuredMode::JsonSchema, 8_192).unwrap()
}

#[tokio::test]
async fn openai_embeddings_send_the_model_and_512_dimensions_and_keep_the_order() {
    let server = MockServer::start(|_| {
        MockResponse::json(
            200,
            json!({"object": "list", "data": [
                {"object": "embedding", "index": 1, "embedding": [0.0, 1.0]},
                {"object": "embedding", "index": 0, "embedding": [1.0, 0.0]}
            ], "usage": {"prompt_tokens": 9, "total_tokens": 9}}),
        )
    });
    let tc = TestCore::new().await;
    let openai = provider(AiProviderKind::Openai, format!("{}/v1", server.url()), Some(KEY), "text-embedding-3-small");
    let vectors = openai.embed(&tc, &texts(&["Anmeldung repariert", "Absturz behoben"]), &CancelToken::new()).await.unwrap();
    assert_eq!(vectors, vec![vec![1.0, 0.0], vec![0.0, 1.0]], "in the order of the input, by the index the API names");
    let request = &server.requests()[0];
    assert_eq!(request.route(), "POST /v1/embeddings");
    let auth = format!("Bearer {KEY}");
    assert_eq!(request.header("authorization"), Some(auth.as_str()));
    let body = request.json();
    assert_eq!(body["model"], "text-embedding-3-small");
    assert_eq!(body["input"], json!(["Anmeldung repariert", "Absturz behoben"]));
    assert_eq!(body["dimensions"], 512, "spec: at most 512 dimensions");
    let older = provider(AiProviderKind::Openai, format!("{}/v1", server.url()), Some(KEY), "text-embedding-ada-002");
    older.embed(&tc, &texts(&["a", "b"]), &CancelToken::new()).await.unwrap();
    assert!(server.requests()[1].json().get("dimensions").is_none(), "older models have a fixed size");
}

#[tokio::test]
async fn gemini_embeddings_keep_the_key_out_of_the_url() {
    let server = MockServer::start(|_| MockResponse::json(200, json!({"embeddings": [{"values": [0.1, 0.2]}, {"values": [0.3, 0.4]}]})));
    let tc = TestCore::new().await;
    let gemini = provider(AiProviderKind::Gemini, format!("{}/v1beta", server.url()), Some(KEY), "gemini-embedding-001");
    let vectors = gemini.embed(&tc, &texts(&["Erste", "Zweite"]), &CancelToken::new()).await.unwrap();
    assert_eq!(vectors, vec![vec![0.1, 0.2], vec![0.3, 0.4]]);
    let request = &server.requests()[0];
    assert_eq!(request.route(), "POST /v1beta/models/gemini-embedding-001:batchEmbedContents");
    assert_eq!(request.header("x-goog-api-key"), Some(KEY));
    assert!(request.query("key").is_none() && !request.raw().contains(&format!("key={KEY}")), "never ?key= in the address");
    assert_eq!(
        request.json()["requests"][1],
        json!({"model": "models/gemini-embedding-001", "content": {"parts": [{"text": "Zweite"}]}, "outputDimensionality": 512})
    );
}

#[tokio::test]
async fn ollama_lm_studio_and_compatible_services_use_their_own_routes() {
    let server = MockServer::start(|request| match request.route().as_str() {
        "POST /api/embed" => MockResponse::json(200, json!({"model": "embeddinggemma", "embeddings": [[0.5, 0.5, 0.0]], "prompt_eval_count": 3})),
        "POST /v1/embeddings" => MockResponse::json(200, json!({"data": [{"index": 0, "embedding": [0.0, 0.5, 0.5]}]})),
        _ => MockResponse::json(404, json!({"error": "not found"})),
    });
    let tc = TestCore::new().await;
    let ollama = provider(AiProviderKind::Ollama, server.url(), None, "embeddinggemma");
    assert_eq!(ollama.embed(&tc, &texts(&["Grüße"]), &CancelToken::new()).await.unwrap(), vec![vec![0.5, 0.5, 0.0]]);
    let lmstudio = provider(AiProviderKind::Lmstudio, format!("{}/v1", server.url()), None, "text-embedding-nomic-embed-text-v1.5");
    assert_eq!(lmstudio.embed(&tc, &texts(&["Köln"]), &CancelToken::new()).await.unwrap(), vec![vec![0.0, 0.5, 0.5]]);
    let sent = server.requests();
    assert_eq!(sent[0].json(), json!({"model": "embeddinggemma", "input": ["Grüße"], "truncate": true}), "native Ollama API");
    assert_eq!(sent[1].json(), json!({"model": "text-embedding-nomic-embed-text-v1.5", "input": ["Köln"]}));
    assert!(sent.iter().all(|request| request.header("authorization").is_none()), "local providers get no key");
    let compatible = build(AiProviderKind::OpenaiCompatible, format!("{}/v1", server.url()), Some(KEY.into()), "bge-m3".into(), AiStructuredMode::Prompt, 8_192).unwrap();
    compatible.embed(&tc, &texts(&["x"]), &CancelToken::new()).await.unwrap();
    let auth = format!("Bearer {KEY}");
    assert_eq!(server.requests()[2].header("authorization"), Some(auth.as_str()));
}

#[tokio::test]
async fn wrong_answers_and_providers_without_embeddings() {
    let server = MockServer::start(|request| match request.route().as_str() {
        "POST /api/embed" => MockResponse::json(200, json!({"embeddings": [[1.0, 0.0]]})),
        _ => MockResponse::json(404, json!({"error": {"message": "model 'fehlt' not found"}})),
    });
    let tc = TestCore::new().await;
    let ollama = provider(AiProviderKind::Ollama, server.url(), None, "embeddinggemma");
    let err = ollama.embed(&tc, &texts(&["eins", "zwei"]), &CancelToken::new()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::AiInvalidAnswer, "one vector for two texts");
    let lmstudio = provider(AiProviderKind::Lmstudio, format!("{}/v1", server.url()), None, "fehlt");
    assert_eq!(lmstudio.embed(&tc, &texts(&["x"]), &CancelToken::new()).await.unwrap_err().code, ErrorCode::AiProviderUnavailable, "404: model or address unknown");
    let anthropic = provider(AiProviderKind::Anthropic, "https://api.anthropic.com/v1".into(), Some(KEY), "claude-haiku-5-5");
    assert_eq!(anthropic.embed(&tc, &texts(&["x"]), &CancelToken::new()).await.unwrap_err().code, ErrorCode::Unsupported, "Anthropic has no embeddings");
    assert_eq!(server.requests().len(), 2, "nothing went to Anthropic");
}
