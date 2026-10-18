//! The providers and what they share: sending through `http::send_cancellable`, error mapping,
//! the remembered context sizes, building the active provider from the settings.

pub mod anthropic;
pub mod compatible;
pub mod gemini;
pub mod ollama;
pub mod openai;

use std::collections::HashMap;

use parking_lot::Mutex;
use serde_json::Value;

use crate::ai::provider::Provider;
use crate::app::Core;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::http::{self, Request, Response};
use crate::jobs::CancelToken;
use crate::model::{AiProviderKind, AiStructuredMode, Settings};

/// Context sizes the providers reported (`ai_models`), per provider and model.
#[derive(Default)]
pub struct ContextCache {
    map: Mutex<HashMap<(AiProviderKind, String), u64>>,
}

impl ContextCache {
    pub fn get(&self, kind: AiProviderKind, model: &str) -> Option<u64> {
        self.map.lock().get(&(kind, model.to_string())).copied()
    }

    pub fn put(&self, kind: AiProviderKind, model: &str, tokens: u64) {
        self.map.lock().insert((kind, model.to_string()), tokens);
    }
}

/// Assumed context size until the provider told us (conservative).
pub fn default_context(kind: AiProviderKind) -> u64 {
    match kind {
        AiProviderKind::Anthropic => 200_000,
        AiProviderKind::Openai => 128_000,
        AiProviderKind::OpenaiCompatible => 32_000,
        AiProviderKind::Gemini => 128_000,
        AiProviderKind::Ollama | AiProviderKind::Lmstudio => 8_192,
        // The tools choose the model themselves; the budget follows their usual context size.
        AiProviderKind::ClaudeCode => 200_000,
        AiProviderKind::Codex => 128_000,
        AiProviderKind::Opencode => 32_000,
    }
}

pub fn context_tokens(core: &Core, kind: AiProviderKind, model: &str) -> u64 {
    core.state::<ContextCache>().get(kind, model).unwrap_or_else(|| default_context(kind))
}

/// `host[:port]` of an address, for messages ("Ollama is not responding (127.0.0.1:11434).").
pub fn host_of(base: &str) -> String {
    match http::Target::parse(base) {
        Ok(target) => target.base.split_once("://").map(|(_, rest)| rest.to_string()).unwrap_or(target.base),
        Err(_) => base.to_string(),
    }
}

/// Every provider call: cancellable, offline mapped to `ai_provider_unavailable`.
pub async fn send(core: &Core, request: Request, cancel: &CancelToken, label: &str, host: &str) -> CoreResult<Response> {
    http::send_cancellable(core, request, cancel).await.map_err(|error| transport_failure(error, label, host))
}

pub fn transport_failure(error: CoreError, label: &str, host: &str) -> CoreError {
    match error.code {
        ErrorCode::Offline => {
            let detail = error.git_output.clone().unwrap_or_else(|| error.message.clone());
            CoreError::ai_provider_unavailable(format!("{label} is not responding ({host}).")).with_git_output(detail)
        }
        _ => error,
    }
}

/// The provider's own error text (shortened), for `gitOutput`.
fn provider_message(response: &Response) -> String {
    let json: Option<Value> = serde_json::from_slice(&response.body).ok();
    let text = json
        .as_ref()
        .and_then(|value| {
            value.pointer("/error/message").or_else(|| value.get("error").filter(|error| error.is_string())).or_else(|| value.get("message")).and_then(Value::as_str).map(str::to_string)
        })
        .unwrap_or_else(|| response.text());
    crate::util::truncate_str(text.trim(), 2000)
}

/// An answer with an error status. `secrets` are removed from the provider's text.
pub fn http_failure(label: &str, response: &Response, secrets: &[String]) -> CoreError {
    let detail = crate::secrets::scrub(&provider_message(response), secrets);
    let status = response.status;
    let error = match status {
        401 | 403 => CoreError::ai_not_configured(format!("{label} rejected the API key (HTTP {status}). Check the key in Settings › AI.")),
        404 => CoreError::ai_provider_unavailable(format!("{label} does not know this model or address (HTTP 404). Check the model in Settings › AI.")),
        408 | 429 | 500..=599 => CoreError::ai_provider_unavailable(format!("{label} is overloaded or unavailable right now (HTTP {status}). Try again later.")).with_retry_at(response.retry_at()),
        _ => CoreError::unknown(format!("{label} rejected the request (HTTP {status}).")),
    };
    error.with_git_output(detail)
}

pub fn json_body(label: &str, response: &Response) -> CoreResult<Value> {
    serde_json::from_slice(&response.body).map_err(|_| CoreError::ai_invalid_answer(format!("{label} sent a response that is not JSON")))
}

/// A list of numbers as one embedding.
pub(crate) fn numbers(label: &str, value: Option<&Value>) -> CoreResult<Vec<f32>> {
    let invalid = || CoreError::ai_invalid_answer(format!("{label} sent an embedding that is not a list of numbers"));
    let values = value.and_then(Value::as_array).ok_or_else(invalid)?;
    values.iter().map(|number| number.as_f64().map(|n| n as f32).ok_or_else(invalid)).collect()
}

/// Exactly one embedding per text.
pub(crate) fn expect_count(label: &str, vectors: Vec<Vec<f32>>, wanted: usize) -> CoreResult<Vec<Vec<f32>>> {
    if vectors.len() != wanted {
        return Err(CoreError::ai_invalid_answer(format!("{label} returned {} embeddings for {wanted} texts", vectors.len())));
    }
    Ok(vectors)
}

/// `{"data": [{"index": n, "embedding": […]}]}` of the OpenAI protocol, in the order of the input.
pub(crate) fn openai_vectors(label: &str, value: &Value, wanted: usize) -> CoreResult<Vec<Vec<f32>>> {
    let mut rows: Vec<(usize, Vec<f32>)> = Vec::new();
    for (position, item) in value.get("data").and_then(Value::as_array).into_iter().flatten().enumerate() {
        let index = item.get("index").and_then(Value::as_u64).map(|index| index as usize).unwrap_or(position);
        rows.push((index, numbers(label, item.get("embedding"))?));
    }
    rows.sort_by_key(|(index, _)| *index);
    expect_count(label, rows.into_iter().map(|(_, vector)| vector).collect(), wanted)
}

/// A provider for exactly these values (used by `active` and by "Check" with unsaved values).
pub fn build(kind: AiProviderKind, base: String, key: Option<String>, model: String, mode: AiStructuredMode, context_tokens: u64) -> CoreResult<Box<dyn Provider>> {
    match kind {
        AiProviderKind::Anthropic => Ok(Box::new(anthropic::Anthropic::new(base, key.unwrap_or_default(), model, context_tokens))),
        AiProviderKind::Openai => Ok(Box::new(openai::OpenAi::new(base, key.unwrap_or_default(), model, context_tokens))),
        AiProviderKind::OpenaiCompatible => Ok(Box::new(compatible::Compatible::new(kind, base, key, model, mode, context_tokens))),
        AiProviderKind::Lmstudio => Ok(Box::new(compatible::Compatible::new(kind, base, None, model, AiStructuredMode::JsonSchema, context_tokens))),
        AiProviderKind::Gemini => Ok(Box::new(gemini::Gemini::new(base, key.unwrap_or_default(), model, context_tokens))),
        AiProviderKind::Ollama => Ok(Box::new(ollama::Ollama::new(base, model, context_tokens))),
        AiProviderKind::ClaudeCode | AiProviderKind::Codex | AiProviderKind::Opencode => {
            Err(CoreError::unknown(format!("Internal error: {} is started through ai::cli::provider.", kind.label())))
        }
    }
}

/// The provider of the settings, with the key from the keychain.
pub async fn active(core: &Core, settings: &Settings) -> CoreResult<Box<dyn Provider>> {
    let Some(kind) = settings.ai_provider else {
        return Err(CoreError::ai_not_configured("No AI provider is chosen yet. Choose one in Settings › AI."));
    };
    if kind.is_cli() {
        // The command-line tools use the user's own sign-in: no model, address or key needed.
        return crate::ai::cli::provider(core, kind, settings).await;
    }
    let Some(model) = settings.ai_model.clone() else {
        return Err(CoreError::ai_not_configured(format!("No model is chosen for {}. Choose one in Settings › AI.", kind.label())));
    };
    let Some(base) = crate::ai::base_url_for(core, kind, settings) else {
        return Err(CoreError::ai_not_configured("The OpenAI-compatible service needs an address. Enter it in Settings › AI."));
    };
    let key = if kind.accepts_key() { crate::secrets::get(core, &crate::ai::key_account(kind)).await? } else { None };
    if kind.needs_key() && key.is_none() {
        return Err(CoreError::ai_not_configured(format!("No API key for {} is stored. Enter it in Settings › AI.", kind.label())));
    }
    let mode = if kind == AiProviderKind::OpenaiCompatible { compatible::stored_mode(core, &base) } else { AiStructuredMode::JsonSchema };
    let context = context_tokens(core, kind, &model);
    build(kind, base, key, model, mode, context)
}

#[cfg(test)]
pub(crate) fn test_request(schema: serde_json::Value) -> crate::ai::provider::CompletionRequest {
    crate::ai::provider::CompletionRequest {
        system: "You are the assistant inside Forkyard.".into(),
        user: "## Staged changes\n<<<REPO t0k3n>>>\n+fix\n<<<END t0k3n>>>".into(),
        schema,
        max_output_tokens: 1024,
        timeout: std::time::Duration::from_secs(10),
        small_task: true,
        repo_id: None,
        estimated_input_tokens: 40,
    }
}

#[cfg(test)]
mod embed_tests;
