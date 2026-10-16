//! AI commands (v1.2): status, keys, checking a provider, the one-time notice, "What is sent?",
//! confirmations and this month's usage. The AI settings themselves are `Settings` fields
//! (`settings_set`); the AI functions of later packages call `ai::run::complete_json`.

use serde_json::Value;

use crate::ai::{self, context, gate, pricing, providers, run};
use crate::app::Core;
use crate::db;
use crate::error::{CoreError, CoreResult};
use crate::jobs::CancelToken;
use crate::model::{AiAskTrigger, AiFeature, AiInput, AiModelList, AiPreview, AiProviderKind, AiState, AiStatus, AiStructuredMode, AiUsageRow, AiUsageSummary, AppChange};
use crate::secrets;

/// The stored key of a provider; `None` if there is none or the keychain is unreachable.
async fn stored_key(core: &Core, kind: AiProviderKind) -> Option<String> {
    if !kind.accepts_key() {
        return None;
    }
    secrets::get(core, &ai::key_account(kind)).await.ok().flatten()
}

pub async fn ai_status(core: &Core) -> CoreResult<AiStatus> {
    let settings = core.settings()?;
    let state = ai::state_of(&settings);
    let intro_pending = state == AiState::Unset
        && core.db.with(|c| Ok(db::app_settings::get_all(c)?.iter().any(|(key, value)| key == ai::INTRO_PENDING_KEY && *value == Value::Bool(true))))?;
    let kind = settings.ai_provider;
    let key = match kind {
        Some(kind) => stored_key(core, kind).await,
        None => None,
    };
    let connected = match kind {
        None => false,
        // A command-line tool needs only its program (own path or remembered); no process is started here.
        Some(kind) if kind.is_cli() => ai::cli::known_path(core, &settings, kind).is_some(),
        Some(kind) => settings.ai_model.is_some() && ai::base_url_for(core, kind, &settings).is_some() && (!kind.needs_key() || key.is_some()),
    };
    let price = match (kind, settings.ai_model.as_deref()) {
        (Some(kind), Some(model)) => pricing::price_for(&settings, kind, model),
        _ => None,
    };
    Ok(AiStatus {
        state,
        provider: kind,
        model: settings.ai_model.clone(),
        connected,
        key_hint: key.as_deref().map(secrets::hint),
        local: kind.is_some_and(AiProviderKind::is_local),
        price,
        intro_pending,
        features_off: settings.ai_features_off.clone(),
    })
}

/// Stores the key under `llm:<provider>` and reports success only after reading it back.
pub async fn ai_key_set(core: &Core, provider: AiProviderKind, key: String) -> CoreResult<AiStatus> {
    if !provider.accepts_key() {
        return Err(CoreError::not_allowed(format!("{} needs no API key.", provider.label())));
    }
    let key = key.trim().to_string();
    if key.chars().count() < 8 || key.len() > 4096 || key.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(CoreError::not_allowed("This does not look like an API key (at least 8 characters, no spaces or line breaks)."));
    }
    let account = ai::key_account(provider);
    secrets::set(core, &account, &key).await?;
    if secrets::get(core, &account).await?.as_deref() != Some(key.as_str()) {
        return Err(CoreError::io("The keychain did not keep the key. Try again."));
    }
    core.emit_app_changed(&[AppChange::Ai]);
    ai_status(core).await
}

/// Removes the key and reports success only if it is really gone.
pub async fn ai_key_remove(core: &Core, provider: AiProviderKind) -> CoreResult<AiStatus> {
    let account = ai::key_account(provider);
    secrets::delete(core, &account).await?;
    if secrets::get(core, &account).await?.is_some() {
        return Err(CoreError::io("The key is still in the keychain. Remove it there or try again."));
    }
    core.emit_app_changed(&[AppChange::Ai]);
    ai_status(core).await
}

/// "Check": lists the models with the entered values (nothing is stored), remembers the context
/// sizes and – for a compatible service with a model – probes and remembers its structured mode.
pub async fn ai_models(core: &Core, job_id: String, provider: AiProviderKind, base_url: Option<String>, key: Option<String>, model: Option<String>) -> CoreResult<AiModelList> {
    let mut settings = core.settings()?;
    if provider.is_cli() {
        let job = core.start_job(&job_id, None)?;
        let result = ai::cli::check(core, provider, &settings, job.token()).await;
        job.finish(&result);
        return result;
    }
    let stored_base = ai::base_url_for(core, provider, &settings);
    if let Some(url) = base_url.map(|url| url.trim().trim_end_matches('/').to_string()).filter(|url| !url.is_empty()) {
        crate::commands::settings::check_ai_base_url(&url)?;
        settings.ai_base_url = Some(url);
    }
    let Some(base) = ai::base_url_for(core, provider, &settings) else {
        return Err(CoreError::ai_not_configured("The OpenAI-compatible service needs an address. Enter it in Settings › AI."));
    };
    // The stored key only goes to the address it was stored for: a newly typed address gets a key
    // only if one is typed as well.
    let key = match key.map(|key| key.trim().to_string()).filter(|key| !key.is_empty()) {
        Some(key) if provider.accepts_key() => Some(key),
        Some(_) => None,
        None if stored_base.as_deref() == Some(base.as_str()) => stored_key(core, provider).await,
        None => None,
    };
    if provider.needs_key() && key.is_none() {
        return Err(CoreError::ai_not_configured(format!("Enter the API key for {} first.", provider.label())));
    }
    let model = model.map(|model| model.trim().to_string()).unwrap_or_default();
    let job = core.start_job(&job_id, None)?;
    let result = check(core, provider, &base, key, &model, job.token()).await;
    job.finish(&result);
    result
}

async fn check(core: &Core, provider: AiProviderKind, base: &str, key: Option<String>, model: &str, cancel: &CancelToken) -> CoreResult<AiModelList> {
    let built = providers::build(provider, base.to_string(), key.clone(), model.to_string(), AiStructuredMode::Prompt, providers::default_context(provider))?;
    let models = built.models(core, cancel).await?;
    let cache = core.state::<providers::ContextCache>();
    for info in &models {
        if let Some(tokens) = info.context_tokens {
            cache.put(provider, &info.id, tokens);
        }
    }
    let structured = match provider {
        AiProviderKind::OpenaiCompatible if !model.is_empty() => {
            let probe = providers::compatible::Compatible::new(provider, base.to_string(), key, model.to_string(), AiStructuredMode::Prompt, providers::default_context(provider));
            let mode = probe.probe(core, cancel).await?;
            providers::compatible::remember_mode(core, base, mode)?;
            mode
        }
        AiProviderKind::OpenaiCompatible => providers::compatible::stored_mode(core, base),
        _ => AiStructuredMode::JsonSchema,
    };
    Ok(AiModelList { models, structured })
}

/// "Set up …" or "Close" on the notice after the update.
pub async fn ai_intro_dismiss(core: &Core) -> CoreResult<AiStatus> {
    core.db.with(|c| db::app_settings::delete(c, ai::INTRO_PENDING_KEY))?;
    core.emit_app_changed(&[AppChange::Ai]);
    ai_status(core).await
}

/// "What is sent?": builds the exact text without sending anything. Works in every state; the
/// confirmation triggers are computed only while AI is on with a provider and a model.
pub async fn ai_preview(core: &Core, repo_id: String, feature: AiFeature, input: AiInput, locale: String) -> CoreResult<AiPreview> {
    if !core.repo_row(&repo_id)?.trusted {
        return Err(CoreError::repo_untrusted());
    }
    let settings = core.settings()?;
    let kind = settings.ai_provider;
    let model = settings.ai_model.clone();
    let context_size = match (kind, model.as_deref()) {
        (Some(kind), Some(model)) => providers::context_tokens(core, kind, model),
        _ => 32_000,
    };
    let budget = context::budget_tokens(feature.budget_tokens(), context_size);
    let secrets: Vec<String> = match kind {
        Some(kind) => stored_key(core, kind).await.into_iter().collect(),
        None => Vec::new(),
    };
    let built = match input {
        AiInput::StagedChanges => context::staged_changes(core, &repo_id, &settings, budget, &locale, &secrets).await?,
    };
    let chars = built.prompt.chars();
    let mut preview = AiPreview {
        text: built.prompt.text(),
        omitted: built.omitted.clone(),
        shortened: built.shortened.clone(),
        chars,
        estimated_tokens: context::estimate_tokens(chars),
        estimated_cost_usd: None,
        asks: Vec::new(),
        fingerprint: built.prompt.fingerprint(),
        month_cost_usd: 0.0,
        limit_usd: settings.ai_monthly_limit_usd,
    };
    if let (AiState::On, Some(kind), Some(model)) = (ai::state_of(&settings), kind, model.as_deref()) {
        let estimate = run::estimate(core, &settings, kind, model, feature, &built.prompt)?;
        preview.estimated_cost_usd = estimate.cost_usd;
        preview.month_cost_usd = estimate.spent_usd;
        // Same `local` as the request itself (`runs_on_this_computer`), so preview and gate agree.
        preview.asks = gate::pending(core, &settings, &run::situation(core, &settings, kind, Some(&repo_id), feature, &estimate))?;
    }
    Ok(preview)
}

/// "Send" in the preview dialog: approves exactly this text and remembers what is remembered.
pub async fn ai_preview_confirm(core: &Core, repo_id: Option<String>, feature: AiFeature, fingerprint: String, triggers: Vec<AiAskTrigger>, dont_ask_again: bool) -> CoreResult<()> {
    if let Some(repo_id) = &repo_id {
        core.repo_row(repo_id)?;
    }
    gate::confirm(core, repo_id.as_deref(), feature, &fingerprint, &triggers, dont_ask_again)?;
    core.emit_app_changed(&[AppChange::Ai]);
    Ok(())
}

/// "Ask again everywhere".
pub async fn ai_preview_reset(core: &Core) -> CoreResult<()> {
    core.db.with(db::ai::reset_seen)?;
    core.emit_app_changed(&[AppChange::Ai]);
    Ok(())
}

pub async fn ai_usage(core: &Core) -> CoreResult<AiUsageSummary> {
    let month = pricing::current_month();
    let rows: Vec<AiUsageRow> = core
        .db
        .with(|c| db::ai::usage_rows(c, &month))?
        .into_iter()
        .map(|row| AiUsageRow {
            provider: row.provider,
            model: row.model,
            feature: row.feature,
            requests: row.requests,
            input_tokens: row.input_tokens,
            output_tokens: row.output_tokens,
            cost_usd: row.cost_usd_micros as f64 / 1_000_000.0,
        })
        .collect();
    Ok(AiUsageSummary {
        requests: rows.iter().map(|row| row.requests).sum(),
        input_tokens: rows.iter().map(|row| row.input_tokens).sum(),
        output_tokens: rows.iter().map(|row| row.output_tokens).sum(),
        cost_usd: rows.iter().map(|row| row.cost_usd).sum(),
        month,
        rows,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::configure_base;
    use crate::commands::settings::settings_set;
    use crate::error::ErrorCode;
    use crate::testkit::{MockResponse, MockServer, TestCore, TestRepo};
    use serde_json::json;

    #[tokio::test]
    async fn the_state_follows_ai_enabled_and_the_notice_shows_only_while_unset() {
        let tc = TestCore::new().await;
        let status = ai_status(&tc).await.unwrap();
        assert_eq!((status.state, status.intro_pending, status.connected), (AiState::Unset, false, false), "a new installation has no notice");
        // As the upgrade step leaves it for an existing installation.
        tc.db.with(|c| db::app_settings::set(c, "ai.introPending", &Value::Bool(true))).unwrap();
        assert!(ai_status(&tc).await.unwrap().intro_pending);
        settings_set(&tc, json!({"aiEnabled": false})).await.unwrap();
        let off = ai_status(&tc).await.unwrap();
        assert_eq!((off.state, off.intro_pending), (AiState::Off, false), "turned off on purpose: no notice");
        settings_set(&tc, json!({"aiEnabled": true})).await.unwrap();
        assert_eq!(ai_status(&tc).await.unwrap().state, AiState::On);
        settings_set(&tc, json!({"aiEnabled": null})).await.unwrap();
        assert!(ai_status(&tc).await.unwrap().intro_pending, "unset again");
        let after = ai_intro_dismiss(&tc).await.unwrap();
        assert!(!after.intro_pending);
        let left: i64 = tc.db.with(|c| Ok(c.query_row("select count(*) from app_settings where key = 'ai.introPending'", [], |r| r.get(0))?)).unwrap();
        assert_eq!(left, 0);
    }

    #[tokio::test]
    async fn keys_are_stored_under_llm_and_removal_is_checked() {
        let tc = TestCore::new().await;
        ai_key_set(&tc, AiProviderKind::Anthropic, "  sk-ant-api03-ABCDEFGHIJKL1234  ".into()).await.unwrap();
        assert_eq!(tc.secrets.snapshot(), vec![("llm:anthropic".to_string(), "sk-ant-api03-ABCDEFGHIJKL1234".to_string())]);
        settings_set(&tc, json!({"aiEnabled": true, "aiProvider": "anthropic", "aiModel": "claude-sonnet-5-5"})).await.unwrap();
        let status = ai_status(&tc).await.unwrap();
        assert_eq!(status.key_hint.as_deref(), Some("…1234"), "at most the last four characters");
        assert!(status.connected);
        assert_eq!(status.price.map(|price| price.input_usd_per_mtok), Some(2.0));
        for bad in ["sk with space-0123", "kurz", "line\nbreak-0123456789"] {
            assert_eq!(ai_key_set(&tc, AiProviderKind::Anthropic, bad.into()).await.unwrap_err().code, ErrorCode::NotAllowed, "{bad:?}");
        }
        assert_eq!(ai_key_set(&tc, AiProviderKind::Ollama, "irrelevant-0123456".into()).await.unwrap_err().code, ErrorCode::NotAllowed, "local providers take no key");
        let status = ai_key_remove(&tc, AiProviderKind::Anthropic).await.unwrap();
        assert!(!status.connected && status.key_hint.is_none());
        assert!(tc.secrets.snapshot().is_empty(), "removed, as read back");
        let ai_changes = tc.events.all().into_iter().filter(|(name, payload)| name == crate::events::names::APP_CHANGED && payload["what"].as_array().is_some_and(|what| what.iter().any(|w| w == "ai"))).count();
        assert!(ai_changes >= 3, "key set, settings, key removed: {ai_changes}");
    }

    #[tokio::test]
    async fn the_llm_key_survives_the_cleanup_of_the_removed_ai_feature() {
        let tc = TestCore::new().await;
        let profile_id = tc.active_profile_id().unwrap();
        let old = format!("ai:anthropic:{profile_id}");
        crate::secrets::set(&tc, &old, "sk-alt-0123456789").await.unwrap();
        ai_key_set(&tc, AiProviderKind::Anthropic, "sk-ant-api03-NEUNEUNEU-5678".into()).await.unwrap();
        // Replays the first start after the update to 1.2.
        tc.db.with(|c| Ok(c.execute("delete from app_settings where key = 'cleanup.removedAiKeys'", [])?)).unwrap();
        crate::commands::settings::forget_removed_ai_keys(&tc).await;
        assert_eq!(crate::secrets::get(&tc, &old).await.unwrap(), None, "the entry of the removed feature is gone");
        assert_eq!(crate::secrets::get(&tc, "llm:anthropic").await.unwrap().as_deref(), Some("sk-ant-api03-NEUNEUNEU-5678"), "the new key stays");
    }

    #[tokio::test]
    async fn connected_needs_provider_model_address_and_key() {
        let tc = TestCore::new().await;
        settings_set(&tc, json!({"aiEnabled": true, "aiProvider": "ollama"})).await.unwrap();
        assert!(!ai_status(&tc).await.unwrap().connected, "no model yet");
        settings_set(&tc, json!({"aiModel": "qwen3:8b"})).await.unwrap();
        let ollama = ai_status(&tc).await.unwrap();
        assert!(ollama.connected && ollama.local && ollama.price.is_none(), "local: no key, no costs");
        settings_set(&tc, json!({"aiProvider": "openai_compatible", "aiModel": "mistral-large-latest"})).await.unwrap();
        assert!(!ai_status(&tc).await.unwrap().connected, "the compatible service needs an address");
        settings_set(&tc, json!({"aiBaseUrl": "https://llm.firma.example/v1"})).await.unwrap();
        assert!(ai_status(&tc).await.unwrap().connected, "a company proxy may need no key");
        settings_set(&tc, json!({"aiProvider": "gemini", "aiModel": "gemini-2.5-flash"})).await.unwrap();
        assert!(!ai_status(&tc).await.unwrap().connected, "Gemini needs a key");
    }

    #[tokio::test]
    async fn command_line_tools_are_connected_once_their_program_is_known() {
        let tc = TestCore::new().await;
        settings_set(&tc, json!({"aiEnabled": true, "aiProvider": "codex"})).await.unwrap();
        let status = ai_status(&tc).await.unwrap();
        assert!(!status.connected && !status.local && status.price.is_none() && status.key_hint.is_none(), "{status:?}");
        // As the detection leaves it: a remembered program, no model (the tool's default).
        let program = tc.cli_dir().join("codex-programm");
        std::fs::write(&program, "").unwrap();
        crate::ai::cli::remember(&tc, AiProviderKind::Codex, &program).unwrap();
        assert!(ai_status(&tc).await.unwrap().connected, "no model and no key needed");
        std::fs::remove_file(&program).unwrap();
        assert!(!ai_status(&tc).await.unwrap().connected, "the program is gone");
        let own = tc.cli_dir().join("eigener Ordner mit Ü").join("codex");
        std::fs::create_dir_all(own.parent().unwrap()).unwrap();
        std::fs::write(&own, "").unwrap();
        settings_set(&tc, json!({"aiCliPaths": {"claudeCode": null, "codex": own.to_string_lossy(), "opencode": null}})).await.unwrap();
        assert!(ai_status(&tc).await.unwrap().connected, "an own path that exists");
        assert_eq!(ai_key_set(&tc, AiProviderKind::Codex, "sk-irrelevant-0123456".into()).await.unwrap_err().code, ErrorCode::NotAllowed, "a tool takes no key");
    }

    #[tokio::test]
    async fn the_preview_shows_the_exact_text_and_never_sends() {
        let server = MockServer::start(|_| MockResponse::json(500, json!({})));
        let tc = TestCore::new().await;
        configure_base(&tc, AiProviderKind::Anthropic, Some(format!("{}/v1", server.url())));
        let repo = TestRepo::with_commit();
        repo.write_file("src/lib.rs", "pub fn add(a: i32, b: i32) -> i32 { a + b }\n");
        repo.git(&["add", "-A"]);
        let id = tc.open(&repo).await.repo.id;
        let preview = ai_preview(&tc, id.clone(), AiFeature::CommitMessage, AiInput::StagedChanges, "de-DE".into()).await.unwrap();
        assert!(preview.text.contains("File: src/lib.rs") && preview.text.contains("+pub fn add"), "{}", preview.text);
        assert!(preview.asks.is_empty() && preview.estimated_cost_usd.is_none(), "AI not on yet: nothing to ask");
        assert_eq!(preview.chars + 2, preview.text.chars().count() as u64, "system + blank line + user");

        crate::secrets::set(&tc, "llm:anthropic", "sk-ant-api03-testkey-0123456789abcdef").await.unwrap();
        settings_set(&tc, json!({"aiEnabled": true, "aiProvider": "anthropic", "aiModel": "claude-sonnet-5-5"})).await.unwrap();
        let preview = ai_preview(&tc, id.clone(), AiFeature::CommitMessage, AiInput::StagedChanges, "de-DE".into()).await.unwrap();
        assert_eq!(preview.asks, vec![AiAskTrigger::FirstUse, AiAskTrigger::RepoFirst]);
        assert!(preview.estimated_cost_usd.is_some_and(|cost| cost > 0.0 && cost < 0.1), "{:?}", preview.estimated_cost_usd);
        let again = ai_preview(&tc, id.clone(), AiFeature::CommitMessage, AiInput::StagedChanges, "de-DE".into()).await.unwrap();
        assert_ne!(again.text, preview.text, "a new delimiter token per request");
        assert_eq!(again.fingerprint, preview.fingerprint, "but the same content");

        let big: String = (0..3000).map(|n| format!("zeile {n:05} mit etwas text darin, ok\n")).collect();
        repo.write_file("daten.txt", &big);
        repo.git(&["add", "daten.txt"]);
        let large = ai_preview(&tc, id.clone(), AiFeature::Compose, AiInput::StagedChanges, "en".into()).await.unwrap();
        assert!(large.chars > 100_000, "{}", large.chars);
        assert!(large.asks.contains(&AiAskTrigger::Large));

        ai_preview_confirm(&tc, Some(id.clone()), AiFeature::CommitMessage, preview.fingerprint.clone(), preview.asks.clone(), false).await.unwrap();
        assert!(ai_preview(&tc, id.clone(), AiFeature::CommitMessage, AiInput::StagedChanges, "en".into()).await.unwrap().asks.is_empty(), "first use and repository are remembered");
        ai_preview_reset(&tc).await.unwrap();
        assert_eq!(ai_preview(&tc, id.clone(), AiFeature::CommitMessage, AiInput::StagedChanges, "en".into()).await.unwrap().asks, vec![AiAskTrigger::FirstUse, AiAskTrigger::RepoFirst]);
        assert!(server.requests().is_empty(), "the preview never sends anything");

        crate::commands::trust::repo_trust_set(&tc, id.clone(), false).await.unwrap();
        assert_eq!(ai_preview(&tc, id, AiFeature::CommitMessage, AiInput::StagedChanges, "en".into()).await.unwrap_err().code, ErrorCode::RepoUntrusted);
    }

    #[tokio::test]
    async fn checking_uses_the_entered_key_stores_nothing_and_remembers_context_sizes() {
        let server = MockServer::start(|_| MockResponse::json(200, json!({"data": [{"id": "claude-sonnet-5-5", "display_name": "Claude Sonnet 5.5", "max_input_tokens": 1_000_000}], "has_more": false})));
        let tc = TestCore::new().await;
        configure_base(&tc, AiProviderKind::Anthropic, Some(format!("{}/v1", server.url())));
        assert_eq!(ai_models(&tc, "check-0".into(), AiProviderKind::Anthropic, None, None, None).await.unwrap_err().code, ErrorCode::AiNotConfigured, "no key yet");
        let list = ai_models(&tc, "check-1".into(), AiProviderKind::Anthropic, None, Some(" sk-ant-api03-entered-0123456789 ".into()), None).await.unwrap();
        assert_eq!((list.models[0].id.as_str(), list.structured), ("claude-sonnet-5-5", AiStructuredMode::JsonSchema));
        assert_eq!(server.requests()[0].header("x-api-key"), Some("sk-ant-api03-entered-0123456789"));
        assert!(tc.secrets.snapshot().is_empty(), "checking stores nothing");
        assert_eq!(providers::context_tokens(&tc, AiProviderKind::Anthropic, "claude-sonnet-5-5"), 1_000_000);
        let error = ai_models(&tc, "check-2".into(), AiProviderKind::OpenaiCompatible, Some("http://llm.firma.example/v1".into()), None, None).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::NotAllowed, "unencrypted outside this computer");

        // A stored key of the compatible service never goes to a newly typed address.
        let stored = MockServer::start(|_| MockResponse::json(200, json!({"data": [{"id": "m"}]})));
        let other = MockServer::start(|_| MockResponse::json(200, json!({"data": [{"id": "m"}]})));
        crate::secrets::set(&tc, "llm:openai_compatible", "or-key-stored-0123456789").await.unwrap();
        settings_set(&tc, json!({"aiProvider": "openai_compatible", "aiBaseUrl": format!("{}/v1", stored.url())})).await.unwrap();
        ai_models(&tc, "check-3".into(), AiProviderKind::OpenaiCompatible, None, None, None).await.unwrap();
        assert_eq!(stored.requests()[0].header("authorization"), Some("Bearer or-key-stored-0123456789"), "the stored address gets the stored key");
        ai_models(&tc, "check-4".into(), AiProviderKind::OpenaiCompatible, Some(format!("{}/v1", other.url())), None, None).await.unwrap();
        assert!(other.requests().iter().all(|r| r.header("authorization").is_none()), "a new address gets no stored key");
    }

    #[tokio::test]
    async fn this_months_usage_adds_up() {
        let tc = TestCore::new().await;
        let month = pricing::current_month();
        tc.db
            .with(|c| {
                for (feature, input, output, micros) in [("commit_message", 1000, 100, 3_000), ("compose", 5000, 900, 19_000)] {
                    db::ai::add_usage(c, &db::ai::NewUsage { month: &month, provider: "anthropic", model: "claude-sonnet-5-5", feature, input_tokens: input, output_tokens: output, cost_usd_micros: micros })?;
                }
                Ok(())
            })
            .unwrap();
        let usage = ai_usage(&tc).await.unwrap();
        assert_eq!((usage.month.as_str(), usage.requests, usage.input_tokens, usage.output_tokens), (month.as_str(), 2, 6000, 1000));
        assert!((usage.cost_usd - 0.022).abs() < 1e-9, "{}", usage.cost_usd);
        assert_eq!(usage.rows.len(), 2);
    }
}
