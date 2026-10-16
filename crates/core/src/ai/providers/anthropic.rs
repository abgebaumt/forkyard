//! Anthropic Messages API (`POST {base}/messages`, base `https://api.anthropic.com/v1`).
//! Structured answers through `output_config.format` (`json_schema`) – no forced `tool_choice`
//! (400 on current models). `stop_reason`: `refusal` → `ai_refused`, `max_tokens` →
//! `Finish::MaxTokens`. Requests close to the context size are counted with `count_tokens` first.
//! Model IDs without a date; context sizes from `GET /models` (`max_input_tokens`).

use serde_json::{json, Value};

use crate::ai::pricing;
use crate::ai::provider::{BoxFuture, Completion, CompletionRequest, Finish, Provider, ProviderCaps, Usage};
use crate::ai::providers::{host_of, http_failure, json_body, send};
use crate::app::Core;
use crate::error::{CoreError, CoreResult};
use crate::http::{self, Method, Request};
use crate::jobs::CancelToken;
use crate::model::{AiModelInfo, AiProviderKind};

pub const API_VERSION: &str = "2023-06-01";
const LABEL: &str = "Anthropic";

pub struct Anthropic {
    base: String,
    key: String,
    model: String,
    context_tokens: u64,
}

impl Anthropic {
    pub fn new(base: String, key: String, model: String, context_tokens: u64) -> Self {
        Anthropic { base: base.trim_end_matches('/').to_string(), key, model, context_tokens }
    }

    fn authorized(&self, request: Request) -> Request {
        request.secret_header("x-api-key", self.key.clone(), &self.key).header("anthropic-version", API_VERSION)
    }

    fn body(&self, request: &CompletionRequest) -> Value {
        let mut output_config = json!({ "format": { "type": "json_schema", "schema": request.schema } });
        if request.small_task {
            output_config["effort"] = json!("low");
        }
        json!({
            "model": self.model,
            "max_tokens": request.max_output_tokens,
            "system": request.system,
            "messages": [{ "role": "user", "content": request.user }],
            "output_config": output_config,
        })
    }

    fn parse(value: &Value) -> CoreResult<Completion> {
        let text: String = value
            .get("content")
            .and_then(Value::as_array)
            .map(|blocks| {
                blocks.iter().filter(|block| block.get("type").and_then(Value::as_str) == Some("text")).filter_map(|block| block.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("")
            })
            .unwrap_or_default();
        let usage = Usage {
            input_tokens: value.pointer("/usage/input_tokens").and_then(Value::as_u64).unwrap_or(0),
            output_tokens: value.pointer("/usage/output_tokens").and_then(Value::as_u64).unwrap_or(0),
        };
        match value.get("stop_reason").and_then(Value::as_str) {
            Some("refusal") => {
                let explanation = value.pointer("/stop_details/explanation").and_then(Value::as_str).map(str::to_string).unwrap_or(text);
                Err(CoreError::ai_refused(&explanation))
            }
            Some("max_tokens") => Ok(Completion { text, finish: Finish::MaxTokens, usage }),
            _ => Ok(Completion { text, finish: Finish::Complete, usage }),
        }
    }

    async fn count_tokens(&self, core: &Core, request: &CompletionRequest, cancel: &CancelToken) -> CoreResult<u64> {
        let body = json!({ "model": self.model, "system": request.system, "messages": [{ "role": "user", "content": request.user }] });
        let http_request = self.authorized(Request::new(Method::Post, format!("{}/messages/count_tokens", self.base), LABEL)).json(&body).repo(request.repo_id.as_deref());
        let response = send(core, http_request, cancel, LABEL, &host_of(&self.base)).await?;
        if !response.is_success() {
            return Err(http_failure(LABEL, &response, std::slice::from_ref(&self.key)));
        }
        Ok(json_body(LABEL, &response)?.get("input_tokens").and_then(Value::as_u64).unwrap_or(0))
    }
}

impl Provider for Anthropic {
    fn id(&self) -> AiProviderKind {
        AiProviderKind::Anthropic
    }

    fn label(&self) -> String {
        LABEL.to_string()
    }

    fn capabilities(&self) -> ProviderCaps {
        ProviderCaps { structured_output: true, embeddings: false, max_context_tokens: Some(self.context_tokens), pricing: pricing::builtin_price(AiProviderKind::Anthropic, &self.model) }
    }

    fn complete<'a>(&'a self, core: &'a Core, request: &'a CompletionRequest, cancel: &'a CancelToken) -> BoxFuture<'a, CoreResult<Completion>> {
        Box::pin(async move {
            if request.estimated_input_tokens > self.context_tokens / 2 {
                let counted = self.count_tokens(core, request, cancel).await?;
                if counted > self.context_tokens * 7 / 10 {
                    return Err(CoreError::ai_too_large(format!(
                        "The request has about {counted} tokens; {} takes {} at most. Leave out the largest files.",
                        self.model, self.context_tokens
                    )));
                }
            }
            let http_request = self
                .authorized(Request::new(Method::Post, format!("{}/messages", self.base), LABEL))
                .json(&self.body(request))
                .timeout(request.timeout)
                .repo(request.repo_id.as_deref());
            let response = send(core, http_request, cancel, LABEL, &host_of(&self.base)).await?;
            if !response.is_success() {
                return Err(http_failure(LABEL, &response, std::slice::from_ref(&self.key)));
            }
            Self::parse(&json_body(LABEL, &response)?)
        })
    }

    fn models<'a>(&'a self, core: &'a Core, cancel: &'a CancelToken) -> BoxFuture<'a, CoreResult<Vec<AiModelInfo>>> {
        Box::pin(async move {
            let mut models = Vec::new();
            let mut after: Option<String> = None;
            for _ in 0..10 {
                let mut params = vec![("limit", "1000".to_string())];
                if let Some(id) = &after {
                    params.push(("after_id", id.clone()));
                }
                let url = http::with_query(&format!("{}/models", self.base), &params);
                let response = send(core, self.authorized(Request::get(url, LABEL)), cancel, LABEL, &host_of(&self.base)).await?;
                if !response.is_success() {
                    return Err(http_failure(LABEL, &response, std::slice::from_ref(&self.key)));
                }
                let page = json_body(LABEL, &response)?;
                for entry in page.get("data").and_then(Value::as_array).into_iter().flatten() {
                    let Some(id) = entry.get("id").and_then(Value::as_str) else { continue };
                    models.push(AiModelInfo {
                        id: id.to_string(),
                        label: entry.get("display_name").and_then(Value::as_str).unwrap_or(id).to_string(),
                        context_tokens: entry.get("max_input_tokens").and_then(Value::as_u64),
                    });
                }
                after = page.get("last_id").and_then(Value::as_str).map(str::to_string);
                if page.get("has_more").and_then(Value::as_bool) != Some(true) || after.is_none() {
                    break;
                }
            }
            Ok(models)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::provider::{Finish, Provider, Usage};
    use crate::ai::providers::test_request;
    use crate::error::ErrorCode;
    use crate::jobs::CancelToken;
    use crate::testkit::{MockResponse, MockServer, TestCore};
    use serde_json::{json, Value};

    const KEY: &str = "sk-ant-api03-testkey-0123456789abcdef";

    fn schema() -> Value {
        json!({"type": "object", "properties": {"summary": {"type": "string"}, "body": {"type": ["string", "null"]}}, "required": ["summary", "body"], "additionalProperties": false})
    }

    fn provider(base: String, context: u64) -> Anthropic {
        Anthropic::new(base, KEY.into(), "claude-sonnet-5-5".into(), context)
    }

    fn answer(stop: &str, text: &str) -> MockResponse {
        MockResponse::json(
            200,
            json!({"id": "msg_01", "type": "message", "role": "assistant", "model": "claude-sonnet-5-5", "content": [{"type": "text", "text": text}], "stop_reason": stop, "usage": {"input_tokens": 120, "output_tokens": 9}}),
        )
    }

    #[tokio::test]
    async fn structured_output_goes_into_output_config_without_forced_tools() {
        let tc = TestCore::new().await;
        let server = MockServer::start(|request| match request.route().as_str() {
            "POST /v1/messages" => answer("end_turn", "{\"summary\":\"Fix login\",\"body\":null}"),
            _ => MockResponse::json(404, json!({})),
        });
        let request = test_request(schema());
        let completion = provider(format!("{}/v1", server.url()), 200_000).complete(&tc, &request, &CancelToken::new()).await.unwrap();
        assert_eq!(serde_json::from_str::<Value>(&completion.text).unwrap(), json!({"summary": "Fix login", "body": null}));
        assert_eq!(completion.usage, Usage { input_tokens: 120, output_tokens: 9 });
        assert_eq!(completion.finish, Finish::Complete);
        let sent = &server.requests()[0];
        assert_eq!(sent.header("x-api-key"), Some(KEY));
        assert_eq!(sent.header("anthropic-version"), Some("2023-06-01"));
        let body = sent.json();
        assert_eq!(body["output_config"]["format"], json!({"type": "json_schema", "schema": schema()}));
        assert_eq!(body["output_config"]["effort"], "low", "small tasks run with low effort");
        assert!(body.get("tool_choice").is_none() && body.get("tools").is_none(), "no forced tool use (400 on current models)");
        assert_eq!(body["model"], "claude-sonnet-5-5");
        assert_eq!(body["max_tokens"], 1024);
        assert_eq!(body["system"], json!(request.system));
        assert_eq!(body["messages"], json!([{"role": "user", "content": request.user}]));
        assert!(!sent.target.contains(KEY));
    }

    #[tokio::test]
    async fn a_refusal_is_ai_refused_and_a_cut_off_answer_is_reported() {
        let tc = TestCore::new().await;
        let refusing = MockServer::start(|_| {
            MockResponse::json(
                200,
                json!({"content": [], "stop_reason": "refusal", "stop_details": {"type": "refusal", "category": "cyber", "explanation": "This request touches on harmful security topics."}, "usage": {"input_tokens": 30, "output_tokens": 0}}),
            )
        });
        let error = provider(format!("{}/v1", refusing.url()), 200_000).complete(&tc, &test_request(schema()), &CancelToken::new()).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::AiRefused);
        assert!(error.message.contains("harmful security topics"), "{}", error.message);
        let cut = MockServer::start(|_| answer("max_tokens", "{\"summary\":\"Fi"));
        let completion = provider(format!("{}/v1", cut.url()), 200_000).complete(&tc, &test_request(schema()), &CancelToken::new()).await.unwrap();
        assert_eq!(completion.finish, Finish::MaxTokens);
    }

    #[tokio::test]
    async fn a_rejected_key_points_to_the_settings_and_is_never_shown() {
        let tc = TestCore::new().await;
        let server = MockServer::start(|_| {
            MockResponse::json(401, json!({"type": "error", "error": {"type": "authentication_error", "message": format!("invalid x-api-key {KEY}")}}))
        });
        let error = provider(format!("{}/v1", server.url()), 200_000).complete(&tc, &test_request(schema()), &CancelToken::new()).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::AiNotConfigured);
        assert!(error.message.contains("Settings › AI"), "{}", error.message);
        let output = error.git_output.clone().unwrap_or_default();
        assert!(output.contains("invalid x-api-key"), "{output}");
        assert!(!error.message.contains(KEY) && !output.contains(KEY));
        let log = tc.db.with(|c| crate::db::activity::page(c, crate::model::ActivityScope::App, None, None, 50)).unwrap();
        assert!(!log.entries.is_empty());
        assert!(log.entries.iter().all(|entry| !entry.command.contains(KEY) && !entry.output.contains(KEY)));
    }

    #[tokio::test]
    async fn an_overloaded_provider_names_the_retry_time() {
        let tc = TestCore::new().await;
        let server = MockServer::start(|_| MockResponse::json(529, json!({"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}})).header("retry-after", "30"));
        let error = provider(format!("{}/v1", server.url()), 200_000).complete(&tc, &test_request(schema()), &CancelToken::new()).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::AiProviderUnavailable);
        assert!(error.message.contains("529"), "{}", error.message);
        assert!(error.retry_at.is_some());
        assert_eq!(server.count("POST /v1/messages"), 1, "a generation is never repeated by itself");
    }

    #[tokio::test]
    async fn the_model_list_reads_context_sizes_across_pages() {
        let tc = TestCore::new().await;
        let server = MockServer::start(|request| {
            if request.query("after_id").as_deref() == Some("claude-sonnet-5-5") {
                MockResponse::json(200, json!({"data": [{"id": "claude-haiku-5-5", "display_name": "Claude Haiku 5.5", "max_input_tokens": 1_000_000}], "has_more": false}))
            } else {
                MockResponse::json(
                    200,
                    json!({"data": [{"id": "claude-opus-5-5", "display_name": "Claude Opus 5.5", "max_input_tokens": 1_000_000}, {"id": "claude-sonnet-5-5", "display_name": "Claude Sonnet 5.5"}], "has_more": true, "last_id": "claude-sonnet-5-5"}),
                )
            }
        });
        let models = provider(format!("{}/v1", server.url()), 200_000).models(&tc, &CancelToken::new()).await.unwrap();
        let ids: Vec<&str> = models.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
        assert_eq!(models[0].label, "Claude Opus 5.5");
        assert_eq!((models[0].context_tokens, models[1].context_tokens), (Some(1_000_000), None));
        assert_eq!(server.count("GET /v1/models"), 2);
        assert!(server.requests().iter().all(|r| r.header("x-api-key") == Some(KEY)));
    }

    #[tokio::test]
    async fn large_requests_are_counted_before_they_are_sent() {
        let tc = TestCore::new().await;
        let too_big = MockServer::start(|request| match request.route().as_str() {
            "POST /v1/messages/count_tokens" => MockResponse::json(200, json!({"input_tokens": 160_000})),
            _ => answer("end_turn", "{}"),
        });
        let mut request = test_request(schema());
        request.estimated_input_tokens = 150_000;
        let error = provider(format!("{}/v1", too_big.url()), 200_000).complete(&tc, &request, &CancelToken::new()).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::AiTooLarge);
        assert_eq!(too_big.count("POST /v1/messages"), 0, "nothing expensive was sent");
        let counted = too_big.requests().into_iter().find(|r| r.route() == "POST /v1/messages/count_tokens").unwrap().json();
        assert_eq!(counted["model"], "claude-sonnet-5-5");
        assert!(counted.get("max_tokens").is_none());
        let fits = MockServer::start(|request| match request.route().as_str() {
            "POST /v1/messages/count_tokens" => MockResponse::json(200, json!({"input_tokens": 90_000})),
            _ => answer("end_turn", "{\"summary\":\"x\",\"body\":null}"),
        });
        provider(format!("{}/v1", fits.url()), 200_000).complete(&tc, &request, &CancelToken::new()).await.unwrap();
        assert_eq!(fits.count("POST /v1/messages"), 1);
        let small = MockServer::start(|_| answer("end_turn", "{\"summary\":\"x\",\"body\":null}"));
        provider(format!("{}/v1", small.url()), 200_000).complete(&tc, &test_request(schema()), &CancelToken::new()).await.unwrap();
        assert_eq!(small.count("POST /v1/messages/count_tokens"), 0, "small requests are not counted");
    }

    #[tokio::test]
    async fn an_unreachable_service_is_provider_unavailable() {
        let tc = TestCore::new().await;
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let error = provider(format!("http://127.0.0.1:{port}/v1"), 200_000).complete(&tc, &test_request(schema()), &CancelToken::new()).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::AiProviderUnavailable, "{error:?}");
        assert!(error.message.contains(&format!("127.0.0.1:{port}")), "{}", error.message);
    }
}
