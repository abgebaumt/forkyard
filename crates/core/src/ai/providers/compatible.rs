//! OpenAI chat-completions protocol (`POST {base}/chat/completions`, `GET {base}/models`) for
//! services with an own address (OpenRouter, Mistral, Groq, company proxies) and for LM Studio
//! (`http://127.0.0.1:1234/v1`, always `json_schema`). How a compatible service takes structured
//! answers is checked once ("Check": `json_schema` → `json_object` → schema in the prompt) and
//! remembered per address; the core validates the answer in every mode.

use std::time::Duration;

use serde_json::{json, Value};

use crate::ai::provider::{BoxFuture, Completion, CompletionRequest, Finish, Provider, ProviderCaps, Usage, EMBED_TIMEOUT};
use crate::ai::providers::openai::model_ids;
use crate::ai::providers::{host_of, http_failure, json_body, openai_vectors, send};
use crate::ai::schema;
use crate::app::Core;
use crate::db;
use crate::error::{CoreError, CoreResult};
use crate::http::{Method, Request};
use crate::jobs::CancelToken;
use crate::model::{AiModelInfo, AiProviderKind, AiStructuredMode};

/// `app_settings`: `{"baseUrl": …, "mode": …}` of the last check.
pub const MODE_KEY: &str = "ai.compatibleMode";

pub struct Compatible {
    kind: AiProviderKind,
    base: String,
    key: Option<String>,
    model: String,
    mode: AiStructuredMode,
    context_tokens: u64,
}

impl Compatible {
    pub fn new(kind: AiProviderKind, base: String, key: Option<String>, model: String, mode: AiStructuredMode, context_tokens: u64) -> Self {
        Compatible { kind, base: base.trim_end_matches('/').to_string(), key: key.filter(|key| !key.trim().is_empty()), model, mode, context_tokens }
    }

    fn label_text(&self) -> String {
        if self.kind == AiProviderKind::Lmstudio {
            "LM Studio".to_string()
        } else {
            format!("OpenAI-compatible service ({})", host_of(&self.base))
        }
    }

    fn secrets(&self) -> Vec<String> {
        self.key.iter().cloned().collect()
    }

    fn authorized(&self, request: Request) -> Request {
        match &self.key {
            Some(key) => request.secret_header("authorization", format!("Bearer {key}"), key),
            None => request,
        }
    }

    fn body(&self, request: &CompletionRequest, mode: AiStructuredMode) -> Value {
        let mut system = request.system.clone();
        if mode != AiStructuredMode::JsonSchema {
            system.push_str(&format!("\n\nThe JSON must match this JSON schema exactly:\n{}", request.schema));
        }
        let mut body = json!({
            "model": self.model,
            "max_tokens": request.max_output_tokens,
            "stream": false,
            "messages": [{ "role": "system", "content": system }, { "role": "user", "content": request.user }],
        });
        match mode {
            AiStructuredMode::JsonSchema => body["response_format"] = json!({ "type": "json_schema", "json_schema": { "name": "forkyard_answer", "strict": true, "schema": request.schema } }),
            AiStructuredMode::JsonObject => body["response_format"] = json!({ "type": "json_object" }),
            AiStructuredMode::Prompt => {}
        }
        body
    }

    fn parse(value: &Value) -> CoreResult<Completion> {
        let choice = value.pointer("/choices/0");
        let message = choice.and_then(|choice| choice.get("message"));
        if let Some(refusal) = message.and_then(|message| message.get("refusal")).and_then(Value::as_str).filter(|refusal| !refusal.is_empty()) {
            return Err(CoreError::ai_refused(refusal));
        }
        let text = message.and_then(|message| message.get("content")).and_then(Value::as_str).unwrap_or("").to_string();
        let usage = Usage {
            input_tokens: value.pointer("/usage/prompt_tokens").and_then(Value::as_u64).unwrap_or(0),
            output_tokens: value.pointer("/usage/completion_tokens").and_then(Value::as_u64).unwrap_or(0),
        };
        match choice.and_then(|choice| choice.get("finish_reason")).and_then(Value::as_str) {
            Some("length") => Ok(Completion { text, finish: Finish::MaxTokens, usage }),
            Some("content_filter") => Err(CoreError::ai_refused("The provider's content filter stopped the answer.")),
            _ => Ok(Completion { text, finish: Finish::Complete, usage }),
        }
    }

    fn chat_request(&self, request: &CompletionRequest, mode: AiStructuredMode) -> Request {
        self.authorized(Request::new(Method::Post, format!("{}/chat/completions", self.base), self.label_text()))
            .json(&self.body(request, mode))
            .timeout(request.timeout)
            .repo(request.repo_id.as_deref())
    }

    /// Which structured mode the service accepts: a tiny request per mode (400/415/422 = not supported).
    pub async fn probe(&self, core: &Core, cancel: &CancelToken) -> CoreResult<AiStructuredMode> {
        let probe_schema = json!({ "type": "object", "properties": { "ok": { "type": "boolean" } }, "required": ["ok"], "additionalProperties": false });
        let request = CompletionRequest {
            system: "Reply with JSON only.".into(),
            user: "Return the JSON object {\"ok\": true}.".into(),
            schema: probe_schema.clone(),
            max_output_tokens: 50,
            timeout: Duration::from_secs(60),
            small_task: true,
            repo_id: None,
            estimated_input_tokens: 20,
        };
        let label = self.label_text();
        for mode in [AiStructuredMode::JsonSchema, AiStructuredMode::JsonObject] {
            let response = send(core, self.chat_request(&request, mode), cancel, &label, &host_of(&self.base)).await?;
            if matches!(response.status, 400 | 415 | 422) {
                continue;
            }
            if !response.is_success() {
                return Err(http_failure(&label, &response, &self.secrets()));
            }
            let usable = json_body(&label, &response)
                .ok()
                .and_then(|value| Self::parse(&value).ok())
                .and_then(|completion| schema::parse_answer(&completion.text).ok())
                .is_some_and(|value| schema::validate(&probe_schema, &value).is_ok());
            if usable {
                return Ok(mode);
            }
        }
        Ok(AiStructuredMode::Prompt)
    }
}

impl Provider for Compatible {
    fn id(&self) -> AiProviderKind {
        self.kind
    }

    fn label(&self) -> String {
        self.label_text()
    }

    fn capabilities(&self) -> ProviderCaps {
        ProviderCaps { structured_output: self.mode == AiStructuredMode::JsonSchema, embeddings: true, max_context_tokens: Some(self.context_tokens), pricing: None }
    }

    fn complete<'a>(&'a self, core: &'a Core, request: &'a CompletionRequest, cancel: &'a CancelToken) -> BoxFuture<'a, CoreResult<Completion>> {
        Box::pin(async move {
            let label = self.label_text();
            let response = send(core, self.chat_request(request, self.mode), cancel, &label, &host_of(&self.base)).await?;
            if !response.is_success() {
                return Err(http_failure(&label, &response, &self.secrets()));
            }
            Self::parse(&json_body(&label, &response)?)
        })
    }

    fn models<'a>(&'a self, core: &'a Core, cancel: &'a CancelToken) -> BoxFuture<'a, CoreResult<Vec<AiModelInfo>>> {
        Box::pin(async move {
            let label = self.label_text();
            let response = send(core, self.authorized(Request::get(format!("{}/models", self.base), label.clone())), cancel, &label, &host_of(&self.base)).await?;
            if !response.is_success() {
                return Err(http_failure(&label, &response, &self.secrets()));
            }
            Ok(model_ids(&json_body(&label, &response)?))
        })
    }

    fn embed<'a>(&'a self, core: &'a Core, texts: &'a [String], cancel: &'a CancelToken) -> BoxFuture<'a, CoreResult<Vec<Vec<f32>>>> {
        Box::pin(async move {
            let label = self.label_text();
            let request = self
                .authorized(Request::new(Method::Post, format!("{}/embeddings", self.base), label.clone()))
                .json(&json!({ "model": self.model, "input": texts }))
                .timeout(EMBED_TIMEOUT);
            let response = send(core, request, cancel, &label, &host_of(&self.base)).await?;
            if !response.is_success() {
                return Err(http_failure(&label, &response, &self.secrets()));
            }
            openai_vectors(&label, &json_body(&label, &response)?, texts.len())
        })
    }
}

/// The remembered mode for this address; `Prompt` until it was checked.
pub fn stored_mode(core: &Core, base: &str) -> AiStructuredMode {
    let stored = core.db.with(|c| Ok(db::app_settings::get_all(c)?.into_iter().find(|(key, _)| key == MODE_KEY).map(|(_, value)| value))).ok().flatten();
    stored
        .filter(|value| value.get("baseUrl").and_then(Value::as_str) == Some(base))
        .and_then(|value| value.get("mode").cloned())
        .and_then(|mode| serde_json::from_value(mode).ok())
        .unwrap_or(AiStructuredMode::Prompt)
}

pub fn remember_mode(core: &Core, base: &str, mode: AiStructuredMode) -> CoreResult<()> {
    let value = json!({ "baseUrl": base, "mode": mode });
    core.db.with(|c| db::app_settings::set(c, MODE_KEY, &value))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::provider::{Finish, Provider};
    use crate::ai::providers::{build, test_request};
    use crate::error::ErrorCode;
    use crate::jobs::CancelToken;
    use crate::testkit::{MockResponse, MockServer, TestCore};
    use serde_json::{json, Value};

    fn schema() -> Value {
        json!({"type": "object", "properties": {"summary": {"type": "string"}, "body": {"type": ["string", "null"]}}, "required": ["summary", "body"], "additionalProperties": false})
    }

    fn chat(content: &str, finish: &str) -> MockResponse {
        MockResponse::json(200, json!({"id": "c1", "choices": [{"index": 0, "message": {"role": "assistant", "content": content, "refusal": null}, "finish_reason": finish}], "usage": {"prompt_tokens": 40, "completion_tokens": 6}}))
    }

    fn compatible(server: &MockServer, key: Option<&str>, mode: AiStructuredMode) -> Compatible {
        Compatible::new(AiProviderKind::OpenaiCompatible, format!("{}/v1", server.url()), key.map(str::to_string), "mistral-large-latest".into(), mode, 32_000)
    }

    #[tokio::test]
    async fn json_schema_mode_sends_a_strict_response_format() {
        let tc = TestCore::new().await;
        let server = MockServer::start(|_| chat("{\"summary\":\"Fix\",\"body\":null}", "stop"));
        let completion = compatible(&server, Some("or-key-0123456789"), AiStructuredMode::JsonSchema).complete(&tc, &test_request(schema()), &CancelToken::new()).await.unwrap();
        assert_eq!(completion.text, "{\"summary\":\"Fix\",\"body\":null}");
        let sent = &server.requests()[0];
        assert_eq!(sent.route(), "POST /v1/chat/completions");
        assert_eq!(sent.header("authorization"), Some("Bearer or-key-0123456789"));
        let body = sent.json();
        assert_eq!(body["response_format"], json!({"type": "json_schema", "json_schema": {"name": "forkyard_answer", "strict": true, "schema": schema()}}));
        assert_eq!(body["stream"], false);
        assert_eq!(body["messages"][0]["role"], "system");
        assert!(!body["messages"][0]["content"].as_str().unwrap().contains("must match this JSON schema"), "the schema is enforced, not repeated");
    }

    #[tokio::test]
    async fn prompt_mode_puts_the_schema_into_the_system_text() {
        let tc = TestCore::new().await;
        let server = MockServer::start(|_| chat("{\"summary\":\"Fix\",\"body\":null}", "stop"));
        compatible(&server, None, AiStructuredMode::Prompt).complete(&tc, &test_request(schema()), &CancelToken::new()).await.unwrap();
        let sent = &server.requests()[0];
        let body = sent.json();
        assert!(body.get("response_format").is_none());
        let system = body["messages"][0]["content"].as_str().unwrap().to_string();
        assert!(system.contains("must match this JSON schema") && system.contains("\"additionalProperties\":false"), "{system}");
        assert_eq!(sent.header("authorization"), None, "a company proxy without a key gets no header");
    }

    #[tokio::test]
    async fn the_check_falls_back_from_json_schema_to_json_object_and_is_remembered() {
        let tc = TestCore::new().await;
        let server = MockServer::start(|request| match request.json()["response_format"]["type"].as_str() {
            Some("json_schema") => MockResponse::json(400, json!({"error": {"message": "response_format json_schema is not supported"}})),
            Some("json_object") => chat("{\"ok\": true}", "stop"),
            _ => chat("{\"ok\": true}", "stop"),
        });
        let provider = compatible(&server, None, AiStructuredMode::Prompt);
        assert_eq!(provider.probe(&tc, &CancelToken::new()).await.unwrap(), AiStructuredMode::JsonObject);
        let base = format!("{}/v1", server.url());
        assert_eq!(stored_mode(&tc, &base), AiStructuredMode::Prompt, "nothing remembered before");
        remember_mode(&tc, &base, AiStructuredMode::JsonObject).unwrap();
        assert_eq!(stored_mode(&tc, &base), AiStructuredMode::JsonObject);
        assert_eq!(stored_mode(&tc, "https://other.example/v1"), AiStructuredMode::Prompt, "only for this address");
        let refusing_all = MockServer::start(|_| MockResponse::json(422, json!({"error": {"message": "unsupported"}})));
        assert_eq!(compatible(&refusing_all, None, AiStructuredMode::Prompt).probe(&tc, &CancelToken::new()).await.unwrap(), AiStructuredMode::Prompt);
    }

    #[tokio::test]
    async fn refusal_and_length_are_read_from_the_choice() {
        let tc = TestCore::new().await;
        let refusing = MockServer::start(|_| {
            MockResponse::json(200, json!({"choices": [{"message": {"role": "assistant", "content": null, "refusal": "No."}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 1, "completion_tokens": 1}}))
        });
        let error = compatible(&refusing, None, AiStructuredMode::JsonSchema).complete(&tc, &test_request(schema()), &CancelToken::new()).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::AiRefused);
        let cut = MockServer::start(|_| chat("{\"sum", "length"));
        assert_eq!(compatible(&cut, None, AiStructuredMode::JsonSchema).complete(&tc, &test_request(schema()), &CancelToken::new()).await.unwrap().finish, Finish::MaxTokens);
    }

    #[tokio::test]
    async fn lm_studio_uses_its_v1_api_with_json_schema_and_no_key() {
        let tc = TestCore::new().await;
        let server = MockServer::start(|request| match request.route().as_str() {
            "GET /v1/models" => MockResponse::json(200, json!({"data": [{"id": "qwen2.5-7b-instruct"}]})),
            _ => chat("{\"summary\":\"Fix\",\"body\":null}", "stop"),
        });
        let lm = build(AiProviderKind::Lmstudio, format!("{}/v1", server.url()), Some("ignored".into()), "qwen2.5-7b-instruct".into(), AiStructuredMode::Prompt, 8_192).unwrap();
        assert_eq!((lm.id(), lm.label()), (AiProviderKind::Lmstudio, "LM Studio".to_string()));
        assert!(lm.capabilities().structured_output);
        lm.complete(&tc, &test_request(schema()), &CancelToken::new()).await.unwrap();
        let models = lm.models(&tc, &CancelToken::new()).await.unwrap();
        assert_eq!(models[0].id, "qwen2.5-7b-instruct");
        let chat_request = server.requests().into_iter().find(|r| r.route() == "POST /v1/chat/completions").unwrap();
        assert_eq!(chat_request.json()["response_format"]["type"], "json_schema");
        assert!(server.requests().iter().all(|r| r.header("authorization").is_none()));
    }
}
