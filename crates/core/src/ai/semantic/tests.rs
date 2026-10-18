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

use std::collections::HashSet;
use std::time::{Duration, Instant};

use crate::commands::ai::ai_preview_confirm;
use crate::commands::settings::repo_settings_set;
use crate::model::AiAskTrigger;

fn log_commands(tc: &TestCore) -> Vec<(String, String)> {
    tc.db
        .with(|c| {
            let mut stmt = c.prepare("select coalesce(command, ''), coalesce(output, '') from activity_log where command like 'ai: semantic-search%'")?;
            let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
        .unwrap()
}

fn shas_of(result: &AiSemanticResult) -> Vec<String> {
    result.hits.iter().map(|hit| hit.commit.sha.clone()).collect()
}

fn git_set(repo: &TestRepo, args: &[&str]) -> HashSet<String> {
    repo.git(args).lines().filter(|line| !line.is_empty()).map(str::to_string).collect()
}

#[test]
fn matched_terms_name_the_words_of_the_question() {
    assert_eq!(matched_terms("Wo wurde die Anmeldung repariert?", "Weiterleitung nach der Anmeldung repariert"), vec!["anmeldung", "repariert"]);
    assert_eq!(matched_terms("Probleme mit dem Login", "Login-Formular: Fehlertext"), vec!["login"]);
    assert_eq!(matched_terms("ÄRGER mit der GRÖSSE", "Größe angepasst"), Vec::<String>::new(), "ß and SS are different words");
    assert_eq!(matched_terms("Wer hat der Datei", "Datei geändert"), vec!["der", "datei"], "a word inside another word counts too: “der” in “geändert”");
    assert_eq!(matched_terms("Größe", "GRÖßE geändert"), vec!["größe"]);
    assert_eq!(matched_terms("a b", "a b"), Vec::<String>::new(), "words from three characters");
}

#[tokio::test]
async fn semantic_hits_follow_the_meaning_of_the_fake_embeddings() {
    let server = embed_server();
    let tc = with_local_embedder(&server, "embeddinggemma").await;
    let repo = TestRepo::new();
    repo.commit_file("src/main.rs", "x\n", "Absturz beim Öffnen behoben");
    repo.commit_file("README.md", "x\n", "Doku ergänzt");
    let redirect = repo.commit_file("src/zugang/weiterleitung.rs", "x\n", "Weiterleitung nach der Anmeldung repariert");
    let form = repo.commit_file("src/login/form.rs", "x\n", "Login-Formular: Fehlertext");
    let id = tc.open(&repo).await.repo.id;
    let result = search(&tc, &id, "m1", "Probleme mit dem Login", "de").await.unwrap();
    assert_eq!(result.route, AiSearchRoute::LocalEmbeddings);
    assert!(result.ranked && !result.capped && result.filters.is_none());
    let order = shas_of(&result);
    assert_eq!(order.len(), 4, "every reachable commit, sorted");
    assert_eq!(order[..2].iter().cloned().collect::<HashSet<_>>(), [redirect.clone(), form.clone()].into_iter().collect(), "both sign-in commits come first");
    assert!(result.hits[0].score.unwrap() > 0.9 && result.hits[3].score.unwrap() < 0.2, "{:?}", result.hits.iter().map(|hit| hit.score).collect::<Vec<_>>());
    let form_hit = result.hits.iter().find(|hit| hit.commit.sha == form).unwrap();
    assert_eq!((form_hit.commit.summary.as_str(), form_hit.matched_terms.clone(), form_hit.reason.clone()), ("Login-Formular: Fehlertext", vec!["login".to_string()], None));
    let log = log_commands(&tc);
    assert_eq!(log.len(), 1, "one activity entry per search");
    assert!(log[0].0.starts_with("ai: semantic-search (Ollama · embeddinggemma) · ") && log[0].0.ends_with(" → 0 tokens"), "{}", log[0].0);
    assert!(!log[0].0.contains("Anmeldung") && log[0].1.is_empty(), "no contents in the log");
}

#[tokio::test]
async fn the_index_grows_incrementally_and_follows_rebased_history() {
    let server = embed_server();
    let tc = with_local_embedder(&server, "embeddinggemma").await;
    let repo = TestRepo::new();
    repo.commit_file("a.txt", "a\n", "Absturz beim Öffnen behoben");
    repo.commit_file("b.txt", "b\n", "README ergänzt");
    repo.commit_file("src/login.rs", "x\n", "Login-Formular: Fehlertext");
    let id = tc.open(&repo).await.repo.id;
    let first = search(&tc, &id, "s1", "Login", "de").await.unwrap();
    assert_eq!(first.indexed, 3);
    assert_eq!(embed_inputs(&server).iter().map(Vec::len).collect::<Vec<_>>(), vec![3, 1], "three entries, then the question");

    let added = repo.commit_file("src/zugang/weiterleitung.rs", "w\n", "Weiterleitung nach der Anmeldung repariert");
    server.clear();
    let second = search(&tc, &id, "s2", "Login", "de").await.unwrap();
    assert_eq!(embed_inputs(&server).iter().map(Vec::len).collect::<Vec<_>>(), vec![1, 1], "only the new commit, then the question");
    assert_eq!(second.indexed, 4);

    // Rewritten history: the amended commit replaces the old one.
    repo.git(&["commit", "-q", "--amend", "-m", "Weiterleitung nach dem Login repariert"]);
    let amended = repo.head();
    server.clear();
    let third = search(&tc, &id, "s3", "Login", "de").await.unwrap();
    assert_eq!(embed_inputs(&server)[0].len(), 1, "only the amended commit");
    let found: HashSet<String> = shas_of(&third).into_iter().collect();
    assert_eq!(found, git_set(&repo, &["rev-list", "--branches", "--tags", "HEAD"]), "every reachable commit and only those");
    assert!(!found.contains(&added) && found.contains(&amended));
    assert_eq!(third.indexed, 4, "the replaced commit left the index");

    // A deleted branch takes its commits along.
    repo.checkout_new("seite");
    let side = repo.commit_file("s.txt", "s\n", "Seitenzweig");
    repo.checkout("main");
    assert_eq!(search(&tc, &id, "s4", "Login", "de").await.unwrap().indexed, 5);
    repo.git(&["branch", "-D", "seite"]);
    let after = search(&tc, &id, "s5", "Login", "de").await.unwrap();
    assert!(!shas_of(&after).contains(&side) && after.indexed == 4);
}

#[tokio::test]
async fn a_model_change_builds_a_new_index() {
    let server = embed_server();
    let tc = with_local_embedder(&server, "embeddinggemma").await;
    let repo = TestRepo::new();
    for message in ["Absturz behoben", "Doku ergänzt", "Login repariert"] {
        repo.empty_commit(message);
    }
    let id = tc.open(&repo).await.repo.id;
    search(&tc, &id, "a1", "Login", "de").await.unwrap();
    settings_set(&tc, json!({"aiSearchEmbedModel": "nomic-embed-text"})).await.unwrap();
    server.clear();
    search(&tc, &id, "a2", "Login", "de").await.unwrap();
    assert_eq!(embed_inputs(&server).iter().map(Vec::len).collect::<Vec<_>>(), vec![3, 1], "another model, its own index");
    assert!(server.requests().iter().all(|request| request.json()["model"] == "nomic-embed-text"));
    settings_set(&tc, json!({"aiSearchEmbedModel": "embeddinggemma"})).await.unwrap();
    server.clear();
    search(&tc, &id, "a3", "Login", "de").await.unwrap();
    assert_eq!(embed_inputs(&server).iter().map(Vec::len).collect::<Vec<_>>(), vec![1], "the first index is still there");
}

#[tokio::test]
async fn the_index_keeps_the_newest_commits_up_to_the_cap() {
    let server = embed_server();
    let tc = with_local_embedder(&server, "embeddinggemma").await;
    let repo = TestRepo::new();
    for message in ["Erster", "Zweiter", "Dritter", "Vierter"] {
        repo.empty_commit(message);
    }
    let id = tc.open(&repo).await.repo.id;
    let result = search_with_cap(&tc, &id, "c1", "Login", "de", 2).await.unwrap();
    assert_eq!((result.indexed, result.capped), (2, true));
    assert_eq!(shas_of(&result).into_iter().collect::<HashSet<_>>(), git_set(&repo, &["rev-list", "--max-count=2", "--branches", "--tags", "HEAD"]));
}

#[tokio::test]
async fn what_goes_out_is_what_the_preview_showed() {
    let server = embed_server();
    let tc = with_local_embedder(&server, "embeddinggemma").await;
    let repo = TestRepo::new();
    repo.commit_file("src/zugang/weiterleitung.rs", "x\n", "Weiterleitung nach der Anmeldung repariert");
    repo.commit_file("config/server.key", "-----BEGIN PRIVATE KEY-----\n", "Schlüssel abgelegt");
    let id = tc.open(&repo).await.repo.id;
    let preview = ai_preview(&tc, id.clone(), AiFeature::SemanticSearch, semantic("Anmeldung"), "de".into()).await.unwrap();
    search(&tc, &id, "w1", "Anmeldung", "de").await.unwrap();
    let sent = embed_inputs(&server);
    let entries: Vec<String> = sent[0].clone();
    assert_eq!(entries.len(), 2);
    for entry in &entries {
        assert!(preview.text.contains(&format!("\n{entry}\n")), "{entry:?} was shown before");
        assert!(!entry.contains("server.key"), "a key file is not even named");
    }
    assert_eq!(sent[1], vec!["Anmeldung".to_string()], "the question goes alone");
}

#[tokio::test]
async fn an_external_embedder_asks_before_the_first_index_of_a_repository() {
    let server = openai_server();
    let tc = with_openai(&server).await;
    let repo = TestRepo::new();
    repo.commit_file("src/zugang/weiterleitung.rs", "x\n", "Weiterleitung nach der Anmeldung repariert");
    repo.commit_file("keys.txt", "x\n", "Schlüssel sk-proj-AbCdEfGhIjKlMnOpQrStUvWx0123 rotiert");
    let id = tc.open(&repo).await.repo.id;
    let refused = search(&tc, &id, "e1", "Anmeldung", "de").await.unwrap_err();
    assert_eq!(refused.code, ErrorCode::NotAllowed, "{refused:?}");
    assert!(server.requests().is_empty(), "nothing leaves before the confirmation");

    let preview = ai_preview(&tc, id.clone(), AiFeature::SemanticSearch, semantic("Anmeldung"), "de".into()).await.unwrap();
    assert_eq!(preview.asks, vec![AiAskTrigger::FirstUse, AiAskTrigger::RepoFirst]);
    assert!(preview.text.contains("Weiterleitung nach der Anmeldung repariert"));
    assert!(!preview.text.contains("sk-proj-AbCdEfGhIjKlMnOpQrStUvWx0123"), "keys in messages are redacted");
    ai_preview_confirm(&tc, Some(id.clone()), AiFeature::SemanticSearch, preview.fingerprint.clone(), preview.asks.clone(), false).await.unwrap();
    let result = search(&tc, &id, "e2", "Anmeldung", "de").await.unwrap();
    assert_eq!(result.route, AiSearchRoute::ProviderEmbeddings);
    let sent = server.requests();
    assert_eq!(sent.len(), 2, "the new entries, then the question");
    for request in &sent {
        assert_eq!((request.route().as_str(), request.json()["model"].clone(), request.json()["dimensions"].clone()), ("POST /v1/embeddings", json!("text-embedding-3-small"), json!(512)));
        assert!(!request.body_text().contains("sk-proj-AbCdEfGhIjKlMnOpQrStUvWx0123"));
        let auth = format!("Bearer {OPENAI_KEY}");
        assert_eq!(request.header("authorization"), Some(auth.as_str()));
    }

    // Remembered: the next search of this repository needs no confirmation …
    repo.commit_file("c.txt", "c\n", "Login-Seite übersetzt");
    search(&tc, &id, "e3", "Anmeldung", "de").await.unwrap();
    // … but another repository asks for its own first time.
    let other = TestRepo::new();
    other.commit_file("x.txt", "x\n", "Anderes Projekt");
    let other_id = tc.open(&other).await.repo.id;
    server.clear();
    assert_eq!(search(&tc, &other_id, "e4", "Anmeldung", "de").await.unwrap_err().code, ErrorCode::NotAllowed);
    assert!(server.requests().is_empty());
}

#[tokio::test]
async fn turning_ai_off_cancels_an_index_build_and_keeps_the_index() {
    let server = embed_server_with_delay(Duration::from_secs(5));
    let tc = with_local_embedder(&server, "embeddinggemma").await;
    let repo = TestRepo::new();
    repo.empty_commit("Login repariert");
    let id = tc.open(&repo).await.repo.id;
    let started = Instant::now();
    let off = async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        settings_set(&tc, json!({"aiEnabled": false})).await.unwrap();
    };
    let (result, ()) = tokio::join!(search(&tc, &id, "off-1", "Login", "de"), off);
    assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
    assert!(tc.data_dir().join(index::INDEX_FILE).exists(), "the index stays until “Delete index” (Grundregel 1)");
}

#[tokio::test]
async fn semantic_search_respects_ai_off_and_trust() {
    let server = embed_server();
    let tc = with_local_embedder(&server, "embeddinggemma").await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    let code = |result: CoreResult<AiSemanticResult>| result.unwrap_err().code;
    repo_settings_set(&tc, id.clone(), json!({"aiOff": true})).await.unwrap();
    assert_eq!(code(search(&tc, &id, "t1", "Login", "de").await), ErrorCode::AiDisabled, "AI off for this repository");
    repo_settings_set(&tc, id.clone(), json!({"aiOff": false})).await.unwrap();
    settings_set(&tc, json!({"aiFeaturesOff": ["semantic_search"]})).await.unwrap();
    assert_eq!(code(search(&tc, &id, "t2", "Login", "de").await), ErrorCode::AiDisabled, "the function is off");
    settings_set(&tc, json!({"aiFeaturesOff": []})).await.unwrap();
    crate::commands::trust::repo_trust_set(&tc, id.clone(), false).await.unwrap();
    assert_eq!(code(search(&tc, &id, "t3", "Login", "de").await), ErrorCode::RepoUntrusted);
    assert!(server.requests().is_empty());
}

#[tokio::test]
async fn a_key_typed_into_the_question_is_redacted_before_it_goes_out() {
    let server = embed_server();
    let tc = with_local_embedder(&server, "embeddinggemma").await;
    let repo = TestRepo::new();
    repo.empty_commit("Login repariert");
    let id = tc.open(&repo).await.repo.id;
    let token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    let question = format!("Login mit {token} kaputt");
    let preview = ai_preview(&tc, id.clone(), AiFeature::SemanticSearch, semantic(&question), "de".into()).await.unwrap();
    assert!(preview.text.contains("Search question:\nLogin mit ") && !preview.text.contains(token), "{}", preview.text);
    search(&tc, &id, "k1", &question, "de").await.unwrap();
    let sent = embed_inputs(&server);
    let asked = sent.last().unwrap();
    assert_eq!(asked.len(), 1, "the question alone");
    assert!(asked[0].starts_with("Login mit ") && !asked[0].contains(token), "{asked:?}");
    assert!(sent.iter().flatten().all(|text| !text.contains(token)), "nowhere in what went out");
}

/// Ollama is a "local" provider type, but this one runs on another computer: the search sends
/// commit texts there only after the first-use and per-repository confirmation – on the
/// embeddings route and on the rephrase route alike.
#[tokio::test]
async fn a_local_provider_type_on_another_computer_asks_first() {
    let tc = TestCore::new().await;
    settings_set(&tc, json!({"aiEnabled": true, "aiProvider": "ollama", "aiModel": "llama3.2", "aiBaseUrl": "https://ollama.firma.example", "aiSearchEmbedModel": "bge-m3"})).await.unwrap();
    let repo = TestRepo::new();
    repo.commit_file("src/zugang/weiterleitung.rs", "x\n", "Weiterleitung nach der Anmeldung repariert");
    let id = tc.open(&repo).await.repo.id;
    let preview = ai_preview(&tc, id.clone(), AiFeature::SemanticSearch, semantic("Anmeldung"), "de".into()).await.unwrap();
    assert_eq!(preview.asks, vec![AiAskTrigger::FirstUse, AiAskTrigger::RepoFirst], "embeddings to another computer");
    let refused = search(&tc, &id, "r1", "Anmeldung", "de").await.unwrap_err();
    assert_eq!(refused.code, ErrorCode::NotAllowed, "refused before anything is sent: {refused:?}");

    settings_set(&tc, json!({"aiSearchEmbedModel": null})).await.unwrap();
    let preview = ai_preview(&tc, id.clone(), AiFeature::SemanticSearch, semantic("Anmeldung"), "de".into()).await.unwrap();
    assert_eq!(preview.asks, vec![AiAskTrigger::FirstUse, AiAskTrigger::RepoFirst], "rephrasing on another computer");
}
