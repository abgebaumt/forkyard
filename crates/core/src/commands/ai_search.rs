//! Search by meaning (v1.2, spec 9.2): status, search, background growth, "Delete index".

use crate::ai::semantic;
use crate::app::Core;
use crate::error::CoreResult;
use crate::model::{AiSemanticIndexUpdate, AiSemanticResult, AiSemanticStatus, AppChange};

/// Which way the search by meaning goes and how many commits the index of this repository has.
pub async fn ai_semantic_status(core: &Core, repo_id: String) -> CoreResult<AiSemanticStatus> {
    core.repo_row(&repo_id)?;
    semantic::status(core, &repo_id)
}

/// Search by meaning as job `job_id`; confirm `ai_preview` (`AiInput::SemanticSearch`) first when it asks.
pub async fn ai_semantic_search(core: &Core, repo_id: String, job_id: String, query: String, locale: String) -> CoreResult<AiSemanticResult> {
    semantic::search(core, &repo_id, &job_id, &query, &locale).await
}

/// Background growth after fetch/commit (UI: `repo:changed` with refs/head).
pub async fn ai_semantic_index_update(core: &Core, repo_id: String, job_id: String) -> CoreResult<AiSemanticIndexUpdate> {
    semantic::index_update(core, &repo_id, &job_id).await
}

/// "Delete index" (Settings › AI): every repository and model.
pub async fn ai_semantic_index_delete(core: &Core) -> CoreResult<u64> {
    let removed = semantic::index::delete_all(core)?;
    core.emit_app_changed(&[AppChange::Ai]);
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::ai::semantic::fakes::*;
    use crate::commands::ai::{ai_preview, ai_preview_confirm};
    use crate::commands::settings::settings_set;
    use crate::events::names;
    use crate::model::{AiAskTrigger, AiFeature, AiInput, AiProviderKind, AiSearchRoute};
    use crate::testkit::{TestCore, TestRepo};

    fn ai_events(tc: &TestCore) -> usize {
        tc.events
            .all()
            .into_iter()
            .filter(|(name, payload)| name == names::APP_CHANGED && payload["what"].as_array().is_some_and(|what| what.iter().any(|w| w == "ai")))
            .count()
    }

    const NOTHING: AiSemanticIndexUpdate = AiSemanticIndexUpdate { added: 0, removed: 0, waiting: false };

    #[tokio::test]
    async fn status_counts_the_index_of_the_current_model_and_delete_clears_every_one() {
        let server = embed_server();
        let tc = with_local_embedder(&server, "embeddinggemma").await;
        let repo = TestRepo::new();
        for message in ["Erster", "Zweiter", "Dritter"] {
            repo.empty_commit(message);
        }
        let id = tc.open(&repo).await.repo.id;
        let local = AiSemanticStatus { route: AiSearchRoute::LocalEmbeddings, provider: Some(AiProviderKind::Ollama), model: Some("embeddinggemma".into()), indexed: 0, used: false, local: true };
        assert_eq!(ai_semantic_status(&tc, id.clone()).await.unwrap(), local);
        assert!(server.requests().is_empty(), "the status sends nothing");
        ai_semantic_search(&tc, id.clone(), "st1".into(), "Login".into(), "de".into()).await.unwrap();
        assert_eq!(ai_semantic_status(&tc, id.clone()).await.unwrap(), AiSemanticStatus { indexed: 3, used: true, ..local.clone() });

        settings_set(&tc, json!({"aiSearchEmbedProvider": null})).await.unwrap();
        let rephrase = ai_semantic_status(&tc, id.clone()).await.unwrap();
        assert_eq!((rephrase.route, rephrase.provider, rephrase.indexed, rephrase.used, rephrase.local), (AiSearchRoute::Rephrase, Some(AiProviderKind::Anthropic), 0, false, false));

        let before = ai_events(&tc);
        assert_eq!(ai_semantic_index_delete(&tc).await.unwrap(), 1);
        assert!(ai_events(&tc) > before, "“Delete index” reports app:changed with ai");
        settings_set(&tc, json!({"aiSearchEmbedProvider": "ollama"})).await.unwrap();
        assert_eq!(ai_semantic_status(&tc, id).await.unwrap(), local, "gone for every repository and model");
    }

    #[tokio::test]
    async fn background_updates_wait_for_the_first_search_and_stop_while_ai_is_off() {
        let server = embed_server();
        let tc = with_local_embedder(&server, "embeddinggemma").await;
        let repo = TestRepo::new();
        repo.empty_commit("Login repariert");
        let id = tc.open(&repo).await.repo.id;
        assert_eq!(ai_semantic_index_update(&tc, id.clone(), "b1".into()).await.unwrap(), NOTHING);
        assert!(server.requests().is_empty(), "nothing before “Meaning” was used for this repository");

        ai_semantic_search(&tc, id.clone(), "b2".into(), "Login".into(), "de".into()).await.unwrap();
        repo.empty_commit("Absturz behoben");
        server.clear();
        let grown = ai_semantic_index_update(&tc, id.clone(), "b3".into()).await.unwrap();
        assert_eq!(grown, AiSemanticIndexUpdate { added: 1, removed: 0, waiting: false });
        assert_eq!(embed_inputs(&server), vec![vec!["Absturz behoben".to_string()]], "only the new commit, no question");

        repo.git(&["reset", "-q", "--hard", "HEAD~1"]);
        server.clear();
        assert_eq!(ai_semantic_index_update(&tc, id.clone(), "b4".into()).await.unwrap(), AiSemanticIndexUpdate { added: 0, removed: 1, waiting: false }, "a commit that left the history leaves the index");
        assert!(server.requests().is_empty());

        settings_set(&tc, json!({"aiEnabled": false})).await.unwrap();
        repo.empty_commit("Doku ergänzt");
        server.clear();
        assert_eq!(ai_semantic_index_update(&tc, id, "b5".into()).await.unwrap(), NOTHING, "AI off: nothing, and no error");
        assert!(server.requests().is_empty());
    }

    #[tokio::test]
    async fn a_background_update_that_would_ask_waits_for_the_next_search() {
        let server = openai_server();
        let tc = with_openai(&server).await;
        let repo = TestRepo::new();
        repo.empty_commit("Login repariert");
        let id = tc.open(&repo).await.repo.id;
        let question = || AiInput::SemanticSearch { query: "Login".into() };
        let preview = ai_preview(&tc, id.clone(), AiFeature::SemanticSearch, question(), "de".into()).await.unwrap();
        ai_preview_confirm(&tc, Some(id.clone()), AiFeature::SemanticSearch, preview.fingerprint, preview.asks, false).await.unwrap();
        ai_semantic_search(&tc, id.clone(), "w1".into(), "Login".into(), "de".into()).await.unwrap();

        // From now on every request asks about its cost.
        settings_set(&tc, json!({"aiConfirmCostUsd": 0, "aiPrices": [{"model": "text-embedding-3-small", "inputUsdPerMtok": 1000, "outputUsdPerMtok": 0}]})).await.unwrap();
        repo.empty_commit("Absturz behoben");
        server.clear();
        assert_eq!(ai_semantic_index_update(&tc, id.clone(), "w2".into()).await.unwrap(), AiSemanticIndexUpdate { added: 0, removed: 0, waiting: true });
        assert!(server.requests().is_empty(), "the background never sends what needs a confirmation");
        let next = ai_preview(&tc, id, AiFeature::SemanticSearch, question(), "de".into()).await.unwrap();
        assert_eq!(next.asks, vec![AiAskTrigger::Cost], "the next search asks for it");
        assert!(next.text.contains("Absturz behoben"));
    }
}
