//! OpenAI Responses API (`POST {base}/responses`, base `https://api.openai.com/v1`) with a strict
//! `text.format` json_schema (all fields `required`, `additionalProperties: false`, optional
//! fields as `[T, "null"]` – exactly the dialect of `ai::schema`). `store: false`: nothing is kept
//! at the provider for later use.

use serde_json::{json, Value};

use crate::ai::provider::{BoxFuture, Completion, CompletionRequest, Finish, Provider, ProviderCaps, Usage};
use crate::ai::providers::{host_of, http_failure, json_body, send};
use crate::app::Core;
use crate::error::{CoreError, CoreResult};
use crate::http::{Method, Request};
use crate::jobs::CancelToken;
use crate::model::{AiModelInfo, AiProviderKind};

const LABEL: &str = "OpenAI";

pub struct OpenAi {
    base: String,
    key: String,
    model: String,
    context_tokens: u64,
}

impl OpenAi {
    pub fn new(base: String, key: String, model: String, context_tokens: u64) -> Self {
        OpenAi { base: base.trim_end_matches('/').to_string(), key, model, context_tokens }
    }

    fn authorized(&self, request: Request) -> Request {
        request.secret_header("authorization", format!("Bearer {}", self.key), &self.key)
    }

    fn body(&self, request: &CompletionRequest) -> Value {
        json!({
            "model": self.model,
            "instructions": request.system,
            "input": request.user,
            "max_output_tokens": request.max_output_tokens,
            "store": false,
            "text": { "format": { "type": "json_schema", "name": "forkyard_answer", "schema": request.schema, "strict": true } },
        })
    }

    fn parse(value: &Value) -> CoreResult<Completion> {
        let mut text = String::new();
        let mut refusal: Option<String> = None;
        for item in value.get("output").and_then(Value::as_array).into_iter().flatten() {
            if item.get("type").and_then(Value::as_str) != Some("message") {
                continue;
            }
            for part in item.get("content").and_then(Value::as_array).into_iter().flatten() {
                match part.get("type").and_then(Value::as_str) {
                    Some("output_text") => text.push_str(part.get("text").and_then(Value::as_str).unwrap_or("")),
                    Some("refusal") => refusal = Some(part.get("refusal").and_then(Value::as_str).unwrap_or("").to_string()),
                    _ => {}
                }
            }
        }
        if let Some(refusal) = refusal {
            return Err(CoreError::ai_refused(&refusal));
        }
        let usage = Usage {
            input_tokens: value.pointer("/usage/input_tokens").and_then(Value::as_u64).unwrap_or(0),
            output_tokens: value.pointer("/usage/output_tokens").and_then(Value::as_u64).unwrap_or(0),
        };
        if value.get("status").and_then(Value::as_str) == Some("incomplete") {
            if value.pointer("/incomplete_details/reason").and_then(Value::as_str) == Some("content_filter") {
                return Err(CoreError::ai_refused("The provider's content filter stopped the answer."));
            }
            return Ok(Completion { text, finish: Finish::MaxTokens, usage });
        }
        Ok(Completion { text, finish: Finish::Complete, usage })
    }
}

impl Provider for OpenAi {
    fn id(&self) -> AiProviderKind {
        AiProviderKind::Openai
    }

    fn label(&self) -> String {
        LABEL.to_string()
    }

    fn capabilities(&self) -> ProviderCaps {
        ProviderCaps { structured_output: true, embeddings: true, max_context_tokens: Some(self.context_tokens), pricing: None }
    }

    fn complete<'a>(&'a self, core: &'a Core, request: &'a CompletionRequest, cancel: &'a CancelToken) -> BoxFuture<'a, CoreResult<Completion>> {
        Box::pin(async move {
            let http_request = self
                .authorized(Request::new(Method::Post, format!("{}/responses", self.base), LABEL))
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
            let response = send(core, self.authorized(Request::get(format!("{}/models", self.base), LABEL)), cancel, LABEL, &host_of(&self.base)).await?;
            if !response.is_success() {
                return Err(http_failure(LABEL, &response, std::slice::from_ref(&self.key)));
            }
            Ok(model_ids(&json_body(LABEL, &response)?))
        })
    }
}

/// `{"data": [{"id": …}]}` of the OpenAI protocol.
pub(crate) fn model_ids(value: &Value) -> Vec<AiModelInfo> {
    value
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("id").and_then(Value::as_str))
        .map(|id| AiModelInfo { id: id.to_string(), label: id.to_string(), context_tokens: None })
        .collect()
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

    const KEY: &str = "sk-proj-testkey0123456789abcdefghij";

    fn schema() -> Value {
        json!({"type": "object", "properties": {"summary": {"type": "string"}, "body": {"type": ["string", "null"]}}, "required": ["summary", "body"], "additionalProperties": false})
    }

    fn provider(server: &MockServer) -> OpenAi {
        OpenAi::new(format!("{}/v1", server.url()), KEY.into(), "gpt-5.1".into(), 128_000)
    }

    #[tokio::test]
    async fn strict_json_schema_through_the_responses_api() {
        let tc = TestCore::new().await;
        let server = MockServer::start(|_| {
            MockResponse::json(
                200,
                json!({"id": "resp_1", "status": "completed", "output": [
                    {"type": "reasoning", "summary": []},
                    {"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": "{\"summary\":\"Fix\",\"body\":null}"}]}
                ], "usage": {"input_tokens": 50, "output_tokens": 7}}),
            )
        });
        let request = test_request(schema());
        let completion = provider(&server).complete(&tc, &request, &CancelToken::new()).await.unwrap();
        assert_eq!(completion.text, "{\"summary\":\"Fix\",\"body\":null}");
        assert_eq!((completion.finish, completion.usage), (Finish::Complete, Usage { input_tokens: 50, output_tokens: 7 }));
        let sent = &server.requests()[0];
        assert_eq!(sent.route(), "POST /v1/responses");
        assert_eq!(sent.header("authorization"), Some(format!("Bearer {KEY}").as_str()));
        let body = sent.json();
        assert_eq!(body["text"]["format"], json!({"type": "json_schema", "name": "forkyard_answer", "schema": schema(), "strict": true}));
        assert_eq!(body["store"], false, "nothing is kept at the provider for later use");
        assert_eq!(body["instructions"], json!(request.system));
        assert_eq!(body["input"], json!(request.user));
        assert_eq!(body["max_output_tokens"], 1024);
    }

    #[tokio::test]
    async fn refusals_and_incomplete_answers() {
        let tc = TestCore::new().await;
        let refusing = MockServer::start(|_| {
            MockResponse::json(200, json!({"status": "completed", "output": [{"type": "message", "content": [{"type": "refusal", "refusal": "I can't help with that request."}]}], "usage": {"input_tokens": 5, "output_tokens": 3}}))
        });
        let error = provider(&refusing).complete(&tc, &test_request(schema()), &CancelToken::new()).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::AiRefused);
        assert!(error.message.contains("I can't help with that request."));
        let cut = MockServer::start(|_| {
            MockResponse::json(200, json!({"status": "incomplete", "incomplete_details": {"reason": "max_output_tokens"}, "output": [{"type": "message", "content": [{"type": "output_text", "text": "{\"summ"}]}], "usage": {"input_tokens": 5, "output_tokens": 1024}}))
        });
        assert_eq!(provider(&cut).complete(&tc, &test_request(schema()), &CancelToken::new()).await.unwrap().finish, Finish::MaxTokens);
    }

    #[tokio::test]
    async fn models_are_listed() {
        let tc = TestCore::new().await;
        let server = MockServer::start(|_| MockResponse::json(200, json!({"object": "list", "data": [{"id": "gpt-5.1", "object": "model"}, {"id": "text-embedding-3-small", "object": "model"}]})));
        let models = provider(&server).models(&tc, &CancelToken::new()).await.unwrap();
        assert_eq!(models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["gpt-5.1", "text-embedding-3-small"]);
        assert_eq!(server.requests()[0].route(), "GET /v1/models");
    }
}
