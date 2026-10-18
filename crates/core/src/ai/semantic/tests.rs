//! The search by meaning end to end, against fake embedders and real temp repositories.

use serde_json::json;

use super::fakes::*;
use super::*;
use crate::commands::ai::ai_preview;
use crate::commands::settings::settings_set;
use crate::error::ErrorCode;
use crate::model::{AiInput, AiOmitReason, AiOmitted};
use crate::testkit::{TestCore, TestRepo};

fn settings_with(patch: serde_json::Value) -> Settings {
    let mut merged = serde_json::to_value(Settings::default()).unwrap();
    for (key, value) in patch.as_object().unwrap() {
        merged[key] = value.clone();
    }
    serde_json::from_value(merged).unwrap()
}

fn semantic(query: &str) -> AiInput {
    AiInput::SemanticSearch { query: query.to_string() }
}

#[test]
fn the_route_prefers_the_local_embedder_then_the_main_provider_then_rephrasing() {
    let pick = |patch| choose(&settings_with(patch)).map(|choice| (choice.kind, choice.model, choice.route));
    use AiProviderKind::{Gemini, Lmstudio, Openai, OpenaiCompatible};
    use AiSearchRoute::{LocalEmbeddings, ProviderEmbeddings};
    assert_eq!(pick(json!({})), None, "no provider: the rephrase route (which then asks for one)");
    assert_eq!(pick(json!({"aiProvider": "anthropic", "aiModel": "claude-haiku-5-5"})), None, "Anthropic has no embeddings");
    assert_eq!(pick(json!({"aiProvider": "openai", "aiModel": "gpt-5.5-mini"})), Some((Openai, "text-embedding-3-small".into(), ProviderEmbeddings)));
    assert_eq!(pick(json!({"aiProvider": "gemini", "aiModel": "gemini-3-flash"})), Some((Gemini, "gemini-embedding-001".into(), ProviderEmbeddings)));
    assert_eq!(pick(json!({"aiProvider": "openai", "aiSearchEmbedModel": "text-embedding-3-large"})), Some((Openai, "text-embedding-3-large".into(), ProviderEmbeddings)));
    assert_eq!(pick(json!({"aiProvider": "openai_compatible", "aiModel": "mistral-large-latest"})), None, "a compatible service needs an embedding model");
    assert_eq!(pick(json!({"aiProvider": "openai_compatible", "aiSearchEmbedModel": "bge-m3"})), Some((OpenaiCompatible, "bge-m3".into(), ProviderEmbeddings)));
    assert_eq!(pick(json!({"aiProvider": "ollama", "aiModel": "qwen3:8b"})), None, "a chat model is no embedding model");
    assert_eq!(
        pick(json!({"aiProvider": "openai", "aiSearchEmbedProvider": "lmstudio", "aiSearchEmbedModel": "nomic"})),
        Some((Lmstudio, "nomic".into(), LocalEmbeddings)),
        "the local embedder comes first (Entscheidung 7)"
    );
    assert_eq!(pick(json!({"aiProvider": "anthropic", "aiSearchEmbedProvider": "ollama"})), None, "a local embedder without a model is not set up");
}

#[tokio::test]
async fn the_local_embedder_never_gets_the_main_providers_address() {
    let tc = TestCore::new().await;
    settings_set(
        &tc,
        json!({"aiEnabled": true, "aiProvider": "openai_compatible", "aiModel": "mistral-large-latest", "aiBaseUrl": "https://llm.firma.example/v1", "aiSearchEmbedProvider": "ollama", "aiSearchEmbedModel": "embeddinggemma"}),
    )
    .await
    .unwrap();
    crate::secrets::set(&tc, "llm:openai_compatible", "firmen-schluessel-0815").await.unwrap();
    let local = embedder(&tc, &tc.settings().unwrap()).await.unwrap().unwrap();
    assert_eq!((local.choice.kind, local.base.as_str(), local.choice.route), (AiProviderKind::Ollama, "http://127.0.0.1:11434", AiSearchRoute::LocalEmbeddings));
    assert!(local.secrets.is_empty(), "no key goes to the local embedder");
    settings_set(&tc, json!({"aiSearchEmbedBaseUrl": "http://127.0.0.1:11500"})).await.unwrap();
    assert_eq!(embedder(&tc, &tc.settings().unwrap()).await.unwrap().unwrap().base, "http://127.0.0.1:11500");
    settings_set(&tc, json!({"aiSearchEmbedProvider": null, "aiSearchEmbedBaseUrl": null, "aiSearchEmbedModel": "bge-m3"})).await.unwrap();
    let main = embedder(&tc, &tc.settings().unwrap()).await.unwrap().unwrap();
    assert_eq!(
        (main.choice.kind, main.base.as_str(), main.choice.model.as_str(), main.secrets.clone()),
        (AiProviderKind::OpenaiCompatible, "https://llm.firma.example/v1", "bge-m3", vec!["firmen-schluessel-0815".to_string()])
    );
}

#[tokio::test]
async fn the_preview_shows_exactly_what_the_search_sends() {
    let server = embed_server();
    let tc = with_local_embedder(&server, "embeddinggemma").await;
    let repo = TestRepo::new();
    let first = repo.commit_file("src/zugang/weiterleitung.rs", "fn weiter() {}\n", "Weiterleitung nach der Anmeldung repariert");
    let second = repo.commit_file(".env", "TOKEN=geheim\n", "Umgebung angelegt");
    let id = tc.open(&repo).await.repo.id;
    let preview = ai_preview(&tc, id.clone(), AiFeature::SemanticSearch, semantic("  Wo wurde die\nAnmeldung repariert? "), "de".into()).await.unwrap();
    let expected = format!(
        "Search question:\nWo wurde die Anmeldung repariert?\n\nNew index entries: 2\n--- {second}\nUmgebung angelegt\n--- {first}\nWeiterleitung nach der Anmeldung repariert\nFiles: src/zugang/weiterleitung.rs\n"
    );
    assert_eq!(preview.text, expected, "the question, then every new commit newest first; .env not even by name");
    assert_eq!(preview.omitted, vec![AiOmitted { path: ".env".into(), reason: AiOmitReason::Secret, size: 0 }], "named only in the left-out list of the dialog");
    assert_eq!(preview.chars, expected.chars().count() as u64);
    assert!(preview.asks.is_empty() && preview.estimated_cost_usd.is_none(), "local: no confirmation, no costs");
    assert!(preview.fingerprint.len() == 64 && preview.fingerprint.bytes().all(|b| b.is_ascii_hexdigit()));
    assert!(server.requests().is_empty(), "the preview sends nothing");
    repo.commit_file("b.txt", "b\n", "Noch ein Commit");
    let later = ai_preview(&tc, id.clone(), AiFeature::SemanticSearch, semantic("Wo wurde die Anmeldung repariert?"), "de".into()).await.unwrap();
    assert_ne!(later.fingerprint, preview.fingerprint, "another text, another approval");
    let empty = ai_preview(&tc, id, AiFeature::SemanticSearch, semantic(" \n "), "de".into()).await.unwrap_err();
    assert_eq!(empty.code, ErrorCode::NotAllowed);
}

#[tokio::test]
async fn a_large_first_index_shows_200_entries_and_counts_all() {
    let server = embed_server();
    let tc = with_local_embedder(&server, "embeddinggemma").await;
    let repo = TestRepo::new();
    for n in 0..205 {
        repo.empty_commit(&format!("Messwert {n:03} ergänzt"));
    }
    let id = tc.open(&repo).await.repo.id;
    let preview = ai_preview(&tc, id, AiFeature::SemanticSearch, semantic("Messwerte"), "de".into()).await.unwrap();
    assert!(preview.text.starts_with("Search question:\nMesswerte\n\nNew index entries: 205\n--- "), "{}", preview.text.chars().take(120).collect::<String>());
    assert_eq!(preview.text.matches("\n--- ").count(), 200);
    assert!(preview.text.ends_with("… and 5 more new index entries in the same form (not shown here).\n"));
    assert!(preview.text.contains("\nMesswert 005 ergänzt\n") && !preview.text.contains("Messwert 004"), "newest first");
    assert!(preview.chars > preview.text.chars().count() as u64, "the size counts every entry");
    assert!(server.requests().is_empty());
}
