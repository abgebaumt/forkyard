//! Google Gemini API (`POST {base}/models/{model}:generateContent`, base
//! `https://generativelanguage.googleapis.com/v1beta`): `responseMimeType: application/json` with
//! `responseJsonSchema`. The key goes in the header `x-goog-api-key`, **never** as `?key=` in the
//! address (addresses end up in logs and proxies).

use serde_json::{json, Value};

use crate::ai::provider::{BoxFuture, Completion, CompletionRequest, Finish, Provider, ProviderCaps, Usage};
use crate::ai::providers::{host_of, http_failure, json_body, send};
use crate::app::Core;
use crate::error::{CoreError, CoreResult};
use crate::http::{self, Method, Request};
use crate::jobs::CancelToken;
use crate::model::{AiModelInfo, AiProviderKind};

const LABEL: &str = "Gemini";

pub struct Gemini {
    base: String,
    key: String,
    model: String,
    context_tokens: u64,
}

impl Gemini {
    pub fn new(base: String, key: String, model: String, context_tokens: u64) -> Self {
        Gemini { base: base.trim_end_matches('/').to_string(), key, model, context_tokens }
    }

    fn model_id(&self) -> &str {
        self.model.trim_start_matches("models/")
    }

    fn authorized(&self, request: Request) -> Request {
        request.secret_header("x-goog-api-key", self.key.clone(), &self.key)
    }

    fn body(&self, request: &CompletionRequest) -> Value {
        json!({
            "systemInstruction": { "parts": [{ "text": request.system }] },
            "contents": [{ "role": "user", "parts": [{ "text": request.user }] }],
            "generationConfig": { "responseMimeType": "application/json", "responseJsonSchema": request.schema, "maxOutputTokens": request.max_output_tokens },
        })
    }

    fn parse(value: &Value) -> CoreResult<Completion> {
        if let Some(reason) = value.pointer("/promptFeedback/blockReason").and_then(Value::as_str) {
            return Err(CoreError::ai_refused(&format!("Gemini blocked the request ({reason}).")));
        }
        let candidate = value.pointer("/candidates/0");
        let text: String = candidate
            .and_then(|candidate| candidate.pointer("/content/parts"))
            .and_then(Value::as_array)
            .map(|parts| parts.iter().filter_map(|part| part.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join(""))
            .unwrap_or_default();
        let usage = Usage {
            input_tokens: value.pointer("/usageMetadata/promptTokenCount").and_then(Value::as_u64).unwrap_or(0),
            output_tokens: value.pointer("/usageMetadata/candidatesTokenCount").and_then(Value::as_u64).unwrap_or(0),
        };
        match candidate.and_then(|candidate| candidate.get("finishReason")).and_then(Value::as_str) {
            Some("MAX_TOKENS") => Ok(Completion { text, finish: Finish::MaxTokens, usage }),
            Some(reason @ ("SAFETY" | "PROHIBITED_CONTENT" | "BLOCKLIST" | "SPII" | "RECITATION")) => Err(CoreError::ai_refused(&format!("Gemini stopped the answer ({reason})."))),
            _ => Ok(Completion { text, finish: Finish::Complete, usage }),
        }
    }
}

impl Provider for Gemini {
    fn id(&self) -> AiProviderKind {
        AiProviderKind::Gemini
    }

    fn label(&self) -> String {
        LABEL.to_string()
    }

    fn capabilities(&self) -> ProviderCaps {
        ProviderCaps { structured_output: true, embeddings: true, max_context_tokens: Some(self.context_tokens), pricing: None }
    }

    fn complete<'a>(&'a self, core: &'a Core, request: &'a CompletionRequest, cancel: &'a CancelToken) -> BoxFuture<'a, CoreResult<Completion>> {
        Box::pin(async move {
            let url = format!("{}/models/{}:generateContent", self.base, http::encode(self.model_id()));
            let http_request = self.authorized(Request::new(Method::Post, url, LABEL)).json(&self.body(request)).timeout(request.timeout).repo(request.repo_id.as_deref());
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
            let mut page_token: Option<String> = None;
            for _ in 0..10 {
                let mut params = vec![("pageSize", "1000".to_string())];
                if let Some(token) = &page_token {
                    params.push(("pageToken", token.clone()));
                }
                let url = http::with_query(&format!("{}/models", self.base), &params);
                let response = send(core, self.authorized(Request::get(url, LABEL)), cancel, LABEL, &host_of(&self.base)).await?;
                if !response.is_success() {
                    return Err(http_failure(LABEL, &response, std::slice::from_ref(&self.key)));
                }
                let page = json_body(LABEL, &response)?;
                for entry in page.get("models").and_then(Value::as_array).into_iter().flatten() {
                    let generates = entry.get("supportedGenerationMethods").and_then(Value::as_array).is_some_and(|methods| methods.iter().any(|method| method == "generateContent"));
                    let Some(name) = entry.get("name").and_then(Value::as_str).filter(|_| generates) else { continue };
                    let id = name.trim_start_matches("models/").to_string();
                    models.push(AiModelInfo {
                        label: entry.get("displayName").and_then(Value::as_str).unwrap_or(&id).to_string(),
                        context_tokens: entry.get("inputTokenLimit").and_then(Value::as_u64),
                        id,
                    });
                }
                page_token = page.get("nextPageToken").and_then(Value::as_str).filter(|token| !token.is_empty()).map(str::to_string);
                if page_token.is_none() {
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
    use crate::ai::provider::{Finish, Provider};
    use crate::ai::providers::test_request;
    use crate::error::ErrorCode;
    use crate::jobs::CancelToken;
    use crate::testkit::{MockResponse, MockServer, TestCore};
    use serde_json::{json, Value};

    const KEY: &str = "AIzaSyA-1234567890abcdefghijklmnopqrstu";

    fn schema() -> Value {
        json!({"type": "object", "properties": {"summary": {"type": "string"}, "body": {"type": ["string", "null"]}}, "required": ["summary", "body"], "additionalProperties": false})
    }

    fn provider(server: &MockServer, model: &str) -> Gemini {
        Gemini::new(format!("{}/v1beta", server.url()), KEY.into(), model.into(), 1_000_000)
    }

    fn answer(finish: &str, text: &str) -> MockResponse {
        MockResponse::json(200, json!({"candidates": [{"content": {"role": "model", "parts": [{"text": text}]}, "finishReason": finish}], "usageMetadata": {"promptTokenCount": 33, "candidatesTokenCount": 8}}))
    }

    #[tokio::test]
    async fn gemini_key_goes_in_the_header_never_into_the_url() {
        let tc = TestCore::new().await;
        let server = MockServer::start(|request| match request.route().as_str() {
            "GET /v1beta/models" => MockResponse::json(200, json!({"models": []})),
            _ => answer("STOP", "{\"summary\":\"Fix\",\"body\":null}"),
        });
        let request = test_request(schema());
        let gemini = provider(&server, "models/gemini-2.5-flash");
        let completion = gemini.complete(&tc, &request, &CancelToken::new()).await.unwrap();
        assert_eq!(completion.text, "{\"summary\":\"Fix\",\"body\":null}");
        assert_eq!((completion.usage.input_tokens, completion.usage.output_tokens), (33, 8));
        gemini.models(&tc, &CancelToken::new()).await.unwrap();
        for sent in server.requests() {
            assert_eq!(sent.header("x-goog-api-key"), Some(KEY));
            assert!(!sent.target.contains(KEY) && !sent.target.contains("key="), "{}", sent.target);
        }
        let generate = &server.requests()[0];
        assert_eq!(generate.path(), "/v1beta/models/gemini-2.5-flash:generateContent");
        let body = generate.json();
        assert_eq!(body["generationConfig"]["responseMimeType"], "application/json");
        assert_eq!(body["generationConfig"]["responseJsonSchema"], schema());
        assert_eq!(body["generationConfig"]["maxOutputTokens"], 1024);
        assert_eq!(body["systemInstruction"]["parts"][0]["text"], json!(request.system));
        assert_eq!(body["contents"][0]["parts"][0]["text"], json!(request.user));
    }

    #[tokio::test]
    async fn blocked_and_cut_off_answers() {
        let tc = TestCore::new().await;
        let safety = MockServer::start(|_| answer("SAFETY", ""));
        assert_eq!(provider(&safety, "gemini-2.5-flash").complete(&tc, &test_request(schema()), &CancelToken::new()).await.unwrap_err().code, ErrorCode::AiRefused);
        let blocked = MockServer::start(|_| MockResponse::json(200, json!({"promptFeedback": {"blockReason": "PROHIBITED_CONTENT"}, "usageMetadata": {"promptTokenCount": 10}})));
        let error = provider(&blocked, "gemini-2.5-flash").complete(&tc, &test_request(schema()), &CancelToken::new()).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::AiRefused);
        assert!(error.message.contains("PROHIBITED_CONTENT"), "{}", error.message);
        let cut = MockServer::start(|_| answer("MAX_TOKENS", "{\"summ"));
        assert_eq!(provider(&cut, "gemini-2.5-flash").complete(&tc, &test_request(schema()), &CancelToken::new()).await.unwrap().finish, Finish::MaxTokens);
    }

    #[tokio::test]
    async fn only_models_that_generate_content_are_listed() {
        let tc = TestCore::new().await;
        let server = MockServer::start(|_| {
            MockResponse::json(200, json!({"models": [
                {"name": "models/gemini-2.5-flash", "displayName": "Gemini 2.5 Flash", "inputTokenLimit": 1_048_576, "supportedGenerationMethods": ["generateContent", "countTokens"]},
                {"name": "models/text-embedding-004", "displayName": "Text Embedding 004", "supportedGenerationMethods": ["embedContent"]}
            ]}))
        });
        let models = provider(&server, "gemini-2.5-flash").models(&tc, &CancelToken::new()).await.unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!((models[0].id.as_str(), models[0].label.as_str(), models[0].context_tokens), ("gemini-2.5-flash", "Gemini 2.5 Flash", Some(1_048_576)));
    }
}
