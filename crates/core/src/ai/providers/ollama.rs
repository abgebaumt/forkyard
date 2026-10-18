//! Ollama on this computer, **native** API (`POST {base}/api/chat` with `format: <schema>` and
//! `options.num_ctx`), base `http://127.0.0.1:11434`. Not through `/v1/chat/completions`: there is
//! no `num_ctx` there, and a large diff would be cut silently to the model's small default
//! context. Context size from `POST /api/show` (`<arch>.context_length`, asked once per model),
//! models from `GET /api/tags`. No key, no costs.

use serde_json::{json, Value};

use crate::ai::provider::{BoxFuture, Completion, CompletionRequest, Finish, Provider, ProviderCaps, Usage, EMBED_TIMEOUT};
use crate::ai::providers::{expect_count, host_of, http_failure, json_body, numbers, send, ContextCache};
use crate::app::Core;
use crate::error::{CoreError, CoreResult};
use crate::http::{Method, Request};
use crate::jobs::CancelToken;
use crate::model::{AiModelInfo, AiProviderKind};

const LABEL: &str = "Ollama";

pub struct Ollama {
    base: String,
    model: String,
    /// Assumed until `/api/show` tells.
    context_tokens: u64,
}

/// Context for this request: input + output + a reserve, at least 2048, at most the model's.
pub fn num_ctx(estimated_input_tokens: u64, max_output_tokens: u32, context_max: u64) -> u64 {
    (estimated_input_tokens + u64::from(max_output_tokens) + 512).clamp(2_048, context_max.max(2_048))
}

impl Ollama {
    pub fn new(base: String, model: String, context_tokens: u64) -> Self {
        Ollama { base: base.trim_end_matches('/').to_string(), model, context_tokens }
    }

    async fn context_max(&self, core: &Core, cancel: &CancelToken) -> CoreResult<u64> {
        if let Some(known) = core.state::<ContextCache>().get(AiProviderKind::Ollama, &self.model) {
            return Ok(known);
        }
        let request = Request::new(Method::Post, format!("{}/api/show", self.base), LABEL).json(&json!({ "model": self.model }));
        let response = send(core, request, cancel, LABEL, &host_of(&self.base)).await?;
        if !response.is_success() {
            return Err(http_failure(LABEL, &response, &[]));
        }
        let value = json_body(LABEL, &response)?;
        let tokens = value
            .get("model_info")
            .and_then(Value::as_object)
            .and_then(|info| info.iter().find(|(key, _)| key.ends_with(".context_length")).and_then(|(_, tokens)| tokens.as_u64()))
            .unwrap_or(self.context_tokens);
        core.state::<ContextCache>().put(AiProviderKind::Ollama, &self.model, tokens);
        Ok(tokens)
    }
}

impl Provider for Ollama {
    fn id(&self) -> AiProviderKind {
        AiProviderKind::Ollama
    }

    fn label(&self) -> String {
        LABEL.to_string()
    }

    fn capabilities(&self) -> ProviderCaps {
        ProviderCaps { structured_output: true, embeddings: true, max_context_tokens: Some(self.context_tokens), pricing: None }
    }

    fn complete<'a>(&'a self, core: &'a Core, request: &'a CompletionRequest, cancel: &'a CancelToken) -> BoxFuture<'a, CoreResult<Completion>> {
        Box::pin(async move {
            let context_max = self.context_max(core, cancel).await?;
            let needed = request.estimated_input_tokens + u64::from(request.max_output_tokens);
            if needed > context_max {
                return Err(CoreError::ai_too_large(format!(
                    "The request needs about {needed} tokens; {} takes {context_max}. Leave out the largest files or choose a model with a larger context.",
                    self.model
                )));
            }
            let body = json!({
                "model": self.model,
                "stream": false,
                "format": request.schema,
                "messages": [{ "role": "system", "content": request.system }, { "role": "user", "content": request.user }],
                "options": { "num_ctx": num_ctx(request.estimated_input_tokens, request.max_output_tokens, context_max), "num_predict": request.max_output_tokens },
            });
            let http_request = Request::new(Method::Post, format!("{}/api/chat", self.base), LABEL).json(&body).timeout(request.timeout).repo(request.repo_id.as_deref());
            let response = send(core, http_request, cancel, LABEL, &host_of(&self.base)).await?;
            if !response.is_success() {
                return Err(http_failure(LABEL, &response, &[]));
            }
            let value = json_body(LABEL, &response)?;
            let text = value.pointer("/message/content").and_then(Value::as_str).unwrap_or("").to_string();
            let usage = Usage {
                input_tokens: value.get("prompt_eval_count").and_then(Value::as_u64).unwrap_or(0),
                output_tokens: value.get("eval_count").and_then(Value::as_u64).unwrap_or(0),
            };
            let finish = if value.get("done_reason").and_then(Value::as_str) == Some("length") { Finish::MaxTokens } else { Finish::Complete };
            Ok(Completion { text, finish, usage })
        })
    }

    fn models<'a>(&'a self, core: &'a Core, cancel: &'a CancelToken) -> BoxFuture<'a, CoreResult<Vec<AiModelInfo>>> {
        Box::pin(async move {
            let response = send(core, Request::get(format!("{}/api/tags", self.base), LABEL), cancel, LABEL, &host_of(&self.base)).await?;
            if !response.is_success() {
                return Err(http_failure(LABEL, &response, &[]));
            }
            let value = json_body(LABEL, &response)?;
            Ok(value
                .get("models")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|entry| entry.get("name").and_then(Value::as_str))
                .map(|name| AiModelInfo { id: name.to_string(), label: name.to_string(), context_tokens: None })
                .collect())
        })
    }

    fn embed<'a>(&'a self, core: &'a Core, texts: &'a [String], cancel: &'a CancelToken) -> BoxFuture<'a, CoreResult<Vec<Vec<f32>>>> {
        Box::pin(async move {
            // `truncate`: a text longer than the model's context is cut by Ollama instead of failing.
            let body = json!({ "model": self.model, "input": texts, "truncate": true });
            let request = Request::new(Method::Post, format!("{}/api/embed", self.base), LABEL).json(&body).timeout(EMBED_TIMEOUT);
            let response = send(core, request, cancel, LABEL, &host_of(&self.base)).await?;
            if !response.is_success() {
                return Err(http_failure(LABEL, &response, &[]));
            }
            let value = json_body(LABEL, &response)?;
            let vectors = value
                .get("embeddings")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|item| numbers(LABEL, Some(item)))
                .collect::<CoreResult<Vec<_>>>()?;
            expect_count(LABEL, vectors, texts.len())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::provider::{Finish, Provider};
    use crate::ai::providers::test_request;
    use crate::error::ErrorCode;
    use crate::jobs::CancelToken;
    use crate::testkit::{MockResponse, MockServer, TestCore};
    use serde_json::{json, Value};

    fn schema() -> Value {
        json!({"type": "object", "properties": {"summary": {"type": "string"}, "body": {"type": ["string", "null"]}}, "required": ["summary", "body"], "additionalProperties": false})
    }

    fn chat(done_reason: &str) -> MockResponse {
        MockResponse::json(200, json!({"model": "qwen3:8b", "message": {"role": "assistant", "content": "{\"summary\":\"Fix\",\"body\":null}"}, "done": true, "done_reason": done_reason, "prompt_eval_count": 50, "eval_count": 7}))
    }

    fn server_with_context(context: u64) -> MockServer {
        MockServer::start(move |request| match request.route().as_str() {
            "POST /api/show" => MockResponse::json(200, json!({"model_info": {"general.architecture": "qwen3", "qwen3.context_length": context}})),
            "GET /api/tags" => MockResponse::json(200, json!({"models": [{"name": "qwen3:8b"}, {"name": "llama3.2:3b"}]})),
            "POST /api/chat" => chat("stop"),
            _ => MockResponse::json(404, json!({"error": "not found"})),
        })
    }

    #[test]
    fn the_context_window_fits_the_request() {
        assert_eq!(num_ctx(10_000, 1_024, 131_072), 11_536);
        assert_eq!(num_ctx(40, 1_024, 131_072), 2_048, "at least 2048");
        assert_eq!(num_ctx(100_000, 4_096, 32_768), 32_768, "never more than the model takes");
    }

    #[tokio::test]
    async fn the_native_chat_gets_schema_and_context_size() {
        let tc = TestCore::new().await;
        let server = server_with_context(131_072);
        let ollama = Ollama::new(server.url(), "qwen3:8b".into(), 8_192);
        let mut request = test_request(schema());
        request.estimated_input_tokens = 10_000;
        let completion = ollama.complete(&tc, &request, &CancelToken::new()).await.unwrap();
        assert_eq!((completion.finish, completion.usage.input_tokens, completion.usage.output_tokens), (Finish::Complete, 50, 7));
        let body = server.requests().into_iter().find(|r| r.route() == "POST /api/chat").unwrap().json();
        assert_eq!(body["format"], schema());
        assert_eq!(body["stream"], false);
        assert_eq!(body["options"]["num_ctx"], 11_536, "large diffs are never cut silently by a small default context");
        assert_eq!(body["options"]["num_predict"], 1024);
        assert_eq!(body["messages"][0]["role"], "system");
        assert_eq!(server.count("POST /v1/chat/completions"), 0, "not the OpenAI layer");
        ollama.complete(&tc, &request, &CancelToken::new()).await.unwrap();
        assert_eq!(server.count("POST /api/show"), 1, "the context size is asked once");
        let models = ollama.models(&tc, &CancelToken::new()).await.unwrap();
        assert_eq!(models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["qwen3:8b", "llama3.2:3b"]);
    }

    #[tokio::test]
    async fn a_request_larger_than_the_model_is_refused_before_sending() {
        let tc = TestCore::new().await;
        let server = server_with_context(4_096);
        let mut request = test_request(schema());
        request.estimated_input_tokens = 5_000;
        let error = Ollama::new(server.url(), "qwen3:8b".into(), 8_192).complete(&tc, &request, &CancelToken::new()).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::AiTooLarge);
        assert_eq!(server.count("POST /api/chat"), 0);
    }

    #[tokio::test]
    async fn a_cut_off_answer_and_an_unreachable_service() {
        let tc = TestCore::new().await;
        let cut = MockServer::start(|request| match request.route().as_str() {
            "POST /api/show" => MockResponse::json(200, json!({"model_info": {"llama.context_length": 8192}})),
            _ => chat("length"),
        });
        assert_eq!(Ollama::new(cut.url(), "llama3.2:3b".into(), 8_192).complete(&tc, &test_request(schema()), &CancelToken::new()).await.unwrap().finish, Finish::MaxTokens);
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let error = Ollama::new(format!("http://127.0.0.1:{port}"), "qwen3:8b".into(), 8_192).complete(&tc, &test_request(schema()), &CancelToken::new()).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::AiProviderUnavailable);
        assert_eq!(error.message, format!("Ollama is not responding (127.0.0.1:{port})."));
    }
}
