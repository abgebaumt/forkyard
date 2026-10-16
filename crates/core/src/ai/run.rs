//! One AI request from start to end – the entry point of every AI function:
//!
//! 1. AI on, function on, repository trusted and not "AI off" (`ensure_allowed`);
//! 2. the provider from the settings (key from the keychain);
//! 3. estimate (characters, tokens, cost, this month's costs) and the confirmations of
//!    `gate` for exactly this prompt;
//! 4. a cancellable job: request, at most one more with twice the output limit if the answer was
//!    cut off, at most one repair attempt if it does not match the schema;
//! 5. usage (numbers only) and one activity-log entry without contents.

use std::collections::HashSet;
use std::time::Instant;

use parking_lot::Mutex;
use serde_json::Value;

use crate::ai::gate::{self, Situation};
use crate::ai::prompt::Prompt;
use crate::ai::provider::{CompletionRequest, Finish, Provider, Usage};
use crate::ai::{context, pricing, providers, schema};
use crate::app::Core;
use crate::db;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::events::names;
use crate::jobs::CancelToken;
use crate::model::{AiFeature, AiProviderKind, AiState, Settings};
use crate::util;

/// Providers whose costs count for the monthly limit (command-line tools do not, spec 1.5).
pub const API_PROVIDERS: [&str; 4] = ["anthropic", "openai", "openai_compatible", "gemini"];
const MAX_RAISED_OUTPUT: u32 = 32_000;

pub struct AiRequest<'a> {
    pub repo_id: Option<&'a str>,
    pub feature: AiFeature,
    /// The UI's job ID (`job:progress`/`job:done`, `jobCancel`).
    pub job_id: &'a str,
    pub prompt: &'a Prompt,
    /// In the dialect of `ai::schema`.
    pub schema: &'a Value,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AiAnswer {
    /// Matches the schema.
    pub value: Value,
    pub usage: Usage,
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Estimate {
    pub chars: u64,
    pub tokens: u64,
    /// Input tokens plus the function's output limit; `None` = price unknown or local.
    pub cost_usd: Option<f64>,
    pub spent_usd: f64,
    pub limit_usd: Option<f64>,
    pub limit_reached: bool,
}

/// IDs of the running AI jobs (for "master switch off").
#[derive(Default)]
pub struct AiJobs {
    ids: Mutex<HashSet<String>>,
}

pub fn cancel_all(core: &Core) -> usize {
    let ids: Vec<String> = core.state::<AiJobs>().ids.lock().iter().cloned().collect();
    for id in &ids {
        core.jobs.cancel(id);
    }
    ids.len()
}

pub fn repo_ai_off(core: &Core, repo_id: &str) -> CoreResult<bool> {
    core.db.with(|c| Ok(db::repo_settings::get_all(c, repo_id)?.into_iter().any(|(key, value)| key == "aiOff" && value == Value::Bool(true))))
}

pub fn ensure_allowed(core: &Core, repo_id: Option<&str>, feature: AiFeature) -> CoreResult<Settings> {
    let settings = core.settings()?;
    if crate::ai::state_of(&settings) != AiState::On || settings.ai_features_off.contains(&feature) {
        return Err(CoreError::ai_disabled());
    }
    if let Some(repo_id) = repo_id {
        if !core.repo_row(repo_id)?.trusted {
            return Err(CoreError::repo_untrusted());
        }
        if repo_ai_off(core, repo_id)? {
            return Err(CoreError::ai_disabled());
        }
    }
    Ok(settings)
}

pub fn estimate(core: &Core, settings: &Settings, kind: AiProviderKind, model: &str, feature: AiFeature, prompt: &Prompt) -> CoreResult<Estimate> {
    let chars = prompt.chars();
    let tokens = context::estimate_tokens(chars);
    let price = pricing::price_for(settings, kind, model);
    let cost_usd = price.as_ref().map(|price| pricing::cost_usd(price, &Usage { input_tokens: tokens, output_tokens: u64::from(feature.max_output_tokens()) }));
    let spent_usd = core.db.with(|c| db::ai::month_cost_micros(c, &pricing::current_month(), &API_PROVIDERS))? as f64 / 1_000_000.0;
    let limit_usd = settings.ai_monthly_limit_usd;
    let limit_reached = !kind.is_local() && price.is_some() && limit_usd.is_some_and(|limit| spent_usd >= limit);
    Ok(Estimate { chars, tokens, cost_usd, spent_usd, limit_usd, limit_reached })
}

pub async fn complete_json(core: &Core, request: AiRequest<'_>) -> CoreResult<AiAnswer> {
    schema::check_dialect(request.schema).map_err(|reason| CoreError::unknown(format!("Internal error: the answer schema is invalid ({reason}).")))?;
    let settings = ensure_allowed(core, request.repo_id, request.feature)?;
    let provider = providers::active(core, &settings).await?;
    let kind = provider.id();
    let model = settings.ai_model.clone().unwrap_or_default();
    let estimate = estimate(core, &settings, kind, &model, request.feature, request.prompt)?;
    let situation = Situation {
        repo_id: request.repo_id,
        feature: request.feature,
        chars: estimate.chars,
        estimated_cost_usd: estimate.cost_usd,
        local: kind.is_local(),
        limit_reached: estimate.limit_reached,
    };
    let pending = gate::pending(core, &settings, &situation)?;
    gate::require(core, &request.prompt.fingerprint(), &pending, estimate.spent_usd, estimate.limit_usd)?;

    let job = core.start_job(request.job_id, request.repo_id)?;
    core.state::<AiJobs>().ids.lock().insert(request.job_id.to_string());
    let started_at = util::now_iso();
    let started = Instant::now();
    let outcome = ask(core, provider.as_ref(), &request, estimate.tokens, job.token()).await;
    core.state::<AiJobs>().ids.lock().remove(request.job_id);
    let (usage, result) = match outcome {
        Ok((value, usage)) => (usage, Ok(value)),
        Err((usage, error)) => (usage, Err(error)),
    };
    let cost_usd = pricing::price_for(&settings, kind, &model).map(|price| pricing::cost_usd(&price, &usage));
    record(
        core,
        &Record {
            repo_id: request.repo_id,
            feature: request.feature,
            kind,
            label: provider.label(),
            model: &model,
            usage,
            cost_usd,
            started_at,
            duration_ms: started.elapsed().as_millis() as u64,
            error: result.as_ref().err().map(|error| error.code),
        },
    );
    let answer = result.map(|value| AiAnswer { value, usage, cost_usd });
    job.finish(&answer);
    answer
}

async fn ask(core: &Core, provider: &dyn Provider, request: &AiRequest<'_>, estimated: u64, cancel: &CancelToken) -> Result<(Value, Usage), (Usage, CoreError)> {
    let mut usage = Usage::default();
    let mut call = CompletionRequest {
        system: request.prompt.system.clone(),
        user: request.prompt.user.clone(),
        schema: request.schema.clone(),
        max_output_tokens: request.feature.max_output_tokens(),
        timeout: request.feature.timeout(),
        small_task: request.feature.small_task(),
        repo_id: request.repo_id.map(str::to_string),
        estimated_input_tokens: estimated,
    };
    let (mut raised, mut repaired) = (false, false);
    loop {
        let completion = match provider.complete(core, &call, cancel).await {
            Ok(completion) => completion,
            Err(error) => return Err((usage, error)),
        };
        usage.input_tokens += completion.usage.input_tokens;
        usage.output_tokens += completion.usage.output_tokens;
        if completion.finish == Finish::MaxTokens {
            if raised {
                return Err((usage, CoreError::ai_invalid_answer("the answer was cut off at the length limit twice")));
            }
            raised = true;
            call.max_output_tokens = call.max_output_tokens.saturating_mul(2).min(MAX_RAISED_OUTPUT);
            continue;
        }
        let checked = schema::parse_answer(&completion.text).and_then(|value| schema::validate(request.schema, &value).map(|()| value));
        match checked {
            Ok(value) => return Ok((value, usage)),
            Err(reason) if !repaired => {
                repaired = true;
                call.user = format!("{}\n\nYour previous answer could not be used: {reason}. Answer again with JSON that matches the schema exactly.", request.prompt.user);
            }
            Err(reason) => return Err((usage, CoreError::ai_invalid_answer(reason))),
        }
    }
}

struct Record<'a> {
    repo_id: Option<&'a str>,
    feature: AiFeature,
    kind: AiProviderKind,
    label: String,
    model: &'a str,
    usage: Usage,
    cost_usd: Option<f64>,
    started_at: String,
    duration_ms: u64,
    error: Option<ErrorCode>,
}

/// Numbers into `ai_usage`, one entry into the activity log – never contents.
fn record(core: &Core, record: &Record<'_>) {
    if record.usage.input_tokens + record.usage.output_tokens > 0 {
        let month = pricing::current_month();
        let usage = db::ai::NewUsage {
            month: &month,
            provider: record.kind.as_str(),
            model: record.model,
            feature: record.feature.as_str(),
            input_tokens: record.usage.input_tokens,
            output_tokens: record.usage.output_tokens,
            cost_usd_micros: record.cost_usd.map(pricing::micros).unwrap_or(0),
        };
        if let Err(e) = core.db.with(|c| db::ai::add_usage(c, &usage)) {
            log::warn!("AI usage not counted: {}", e.message);
        }
    }
    let entry = db::activity::NewActivity {
        repo_id: record.repo_id.map(str::to_string),
        description: format!("ai: {}", record.feature.log_name()),
        command: format!(
            "ai: {} ({} · {}) · {} → {} tokens",
            record.feature.log_name(),
            record.label,
            record.model,
            record.usage.input_tokens,
            record.usage.output_tokens
        ),
        exit_code: if record.error.is_none() { Some(0) } else { None },
        duration_ms: record.duration_ms,
        output: String::new(),
        started_at: record.started_at.clone(),
        code: record.error,
    };
    match core.db.with(|c| db::activity::insert(c, &entry)) {
        Ok(saved) => core.emit(names::LOG_APPENDED, &saved),
        Err(e) => log::warn!("Activity log entry not saved: {}", e.message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::prompt::{self, Section};
    use crate::commands::settings::{repo_settings_set, settings_set};
    use crate::model::{ActivityScope, AiAskTrigger};
    use crate::testkit::{MockRequest, MockResponse, MockServer, TestCore, TestRepo};
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    const KEY: &str = "sk-ant-api03-testkey-0123456789abcdef";

    fn schema() -> Value {
        json!({"type": "object", "properties": {"summary": {"type": "string"}, "body": {"type": ["string", "null"]}}, "required": ["summary", "body"], "additionalProperties": false})
    }

    fn prompt_with(body: &str) -> Prompt {
        prompt::build("Write a commit message.", "en", &[Section { title: "Staged changes".into(), body: body.into() }])
    }

    fn request<'a>(repo_id: Option<&'a str>, job_id: &'a str, prompt: &'a Prompt, schema: &'a Value) -> AiRequest<'a> {
        AiRequest { repo_id, feature: AiFeature::CommitMessage, job_id, prompt, schema }
    }

    fn ollama_chat(content: &str, done_reason: &str) -> MockResponse {
        MockResponse::json(200, json!({"model": "qwen3:8b", "message": {"role": "assistant", "content": content}, "done": true, "done_reason": done_reason, "prompt_eval_count": 50, "eval_count": 7}))
    }

    fn ollama_show() -> MockResponse {
        MockResponse::json(200, json!({"model_info": {"qwen3.context_length": 40960}}))
    }

    fn anthropic_answer(input: u64, output: u64) -> MockResponse {
        MockResponse::json(200, json!({"content": [{"type": "text", "text": "{\"summary\":\"Fix\",\"body\":null}"}], "stop_reason": "end_turn", "usage": {"input_tokens": input, "output_tokens": output}}))
    }

    async fn with_ollama(server: &MockServer) -> TestCore {
        let tc = TestCore::new().await;
        crate::ai::configure_base(&tc, AiProviderKind::Ollama, Some(server.url()));
        settings_set(&tc, json!({"aiEnabled": true, "aiProvider": "ollama", "aiModel": "qwen3:8b"})).await.unwrap();
        tc
    }

    async fn with_anthropic(server: &MockServer, model: &str) -> TestCore {
        let tc = TestCore::new().await;
        crate::ai::configure_base(&tc, AiProviderKind::Anthropic, Some(format!("{}/v1", server.url())));
        crate::secrets::set(&tc, "llm:anthropic", KEY).await.unwrap();
        settings_set(&tc, json!({"aiEnabled": true, "aiProvider": "anthropic", "aiModel": model})).await.unwrap();
        tc
    }

    fn chats(server: &MockServer) -> Vec<MockRequest> {
        server.requests().into_iter().filter(|r| r.route() == "POST /api/chat").collect()
    }

    #[tokio::test]
    async fn requests_are_refused_unless_ai_is_on_for_this_function_and_repository() {
        let server = MockServer::start(|request| match request.route().as_str() {
            "POST /api/show" => ollama_show(),
            _ => ollama_chat("{\"summary\":\"Fix\",\"body\":null}", "stop"),
        });
        let tc = TestCore::new().await;
        crate::ai::configure_base(&tc, AiProviderKind::Ollama, Some(server.url()));
        let (prompt, schema) = (prompt_with("+fix"), schema());
        let code = |result: CoreResult<AiAnswer>| result.unwrap_err().code;
        assert_eq!(code(complete_json(&tc, request(None, "j1", &prompt, &schema)).await), ErrorCode::AiDisabled, "unset");
        settings_set(&tc, json!({"aiEnabled": false})).await.unwrap();
        assert_eq!(code(complete_json(&tc, request(None, "j2", &prompt, &schema)).await), ErrorCode::AiDisabled, "off");
        settings_set(&tc, json!({"aiEnabled": true})).await.unwrap();
        assert_eq!(code(complete_json(&tc, request(None, "j3", &prompt, &schema)).await), ErrorCode::AiNotConfigured, "on, but no provider");
        settings_set(&tc, json!({"aiProvider": "ollama", "aiModel": "qwen3:8b", "aiFeaturesOff": ["commit_message"]})).await.unwrap();
        assert_eq!(code(complete_json(&tc, request(None, "j4", &prompt, &schema)).await), ErrorCode::AiDisabled, "this function is off");
        assert!(server.requests().is_empty(), "nothing was sent so far");
        settings_set(&tc, json!({"aiFeaturesOff": []})).await.unwrap();
        let repo = TestRepo::with_commit();
        let id = tc.open(&repo).await.repo.id;
        complete_json(&tc, request(Some(&id), "j5", &prompt, &schema)).await.unwrap();
        repo_settings_set(&tc, id.clone(), json!({"aiOff": true})).await.unwrap();
        assert_eq!(code(complete_json(&tc, request(Some(&id), "j6", &prompt, &schema)).await), ErrorCode::AiDisabled, "AI off for this repository");
        repo_settings_set(&tc, id.clone(), json!({"aiOff": false})).await.unwrap();
        crate::commands::trust::repo_trust_set(&tc, id.clone(), false).await.unwrap();
        assert_eq!(code(complete_json(&tc, request(Some(&id), "j7", &prompt, &schema)).await), ErrorCode::RepoUntrusted, "the AI core checks trust itself");
        assert_eq!(chats(&server).len(), 1);
    }

    #[tokio::test]
    async fn an_invalid_answer_gets_one_repair_with_the_reason() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let server = MockServer::start(move |request| match request.route().as_str() {
            "POST /api/show" => ollama_show(),
            _ if counter.fetch_add(1, Ordering::SeqCst) == 0 => ollama_chat("{\"summary\": 5, \"body\": null}", "stop"),
            _ => ollama_chat("{\"summary\":\"Fix login\",\"body\":null}", "stop"),
        });
        let tc = with_ollama(&server).await;
        let (prompt, schema) = (prompt_with("+fix"), schema());
        let answer = complete_json(&tc, request(None, "r1", &prompt, &schema)).await.unwrap();
        assert_eq!(answer.value, json!({"summary": "Fix login", "body": null}));
        assert_eq!(answer.usage, Usage { input_tokens: 100, output_tokens: 14 }, "both attempts count");
        assert_eq!(answer.cost_usd, None, "local models cost nothing");
        let sent = chats(&server);
        assert_eq!(sent.len(), 2);
        let second = sent[1].json()["messages"][1]["content"].as_str().unwrap().to_string();
        assert!(second.contains("could not be used") && second.contains("$.summary: expected text"), "{second}");
        assert!(second.starts_with(&prompt.user), "the repair repeats the original request");
    }

    #[tokio::test]
    async fn two_invalid_answers_end_with_ai_invalid_answer() {
        let server = MockServer::start(|request| match request.route().as_str() {
            "POST /api/show" => ollama_show(),
            _ => ollama_chat("Sure! Here is your commit message: Fix", "stop"),
        });
        let tc = with_ollama(&server).await;
        let (prompt, schema) = (prompt_with("+fix"), schema());
        let error = complete_json(&tc, request(None, "r2", &prompt, &schema)).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::AiInvalidAnswer);
        assert_eq!(chats(&server).len(), 2, "exactly one repair attempt");
    }

    #[tokio::test]
    async fn a_cut_off_answer_is_asked_again_with_twice_the_limit() {
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let server = MockServer::start(move |request| match request.route().as_str() {
            "POST /api/show" => ollama_show(),
            _ if counter.fetch_add(1, Ordering::SeqCst) == 0 => ollama_chat("{\"summ", "length"),
            _ => ollama_chat("{\"summary\":\"Fix\",\"body\":null}", "stop"),
        });
        let tc = with_ollama(&server).await;
        let (prompt, schema) = (prompt_with("+fix"), schema());
        complete_json(&tc, request(None, "m1", &prompt, &schema)).await.unwrap();
        let sent = chats(&server);
        assert_eq!(sent[0].json()["options"]["num_predict"], 1024);
        assert_eq!(sent[1].json()["options"]["num_predict"], 2048);
    }

    #[tokio::test]
    async fn usage_and_costs_are_counted_but_no_contents_are_logged() {
        let server = MockServer::start(|_| anthropic_answer(12_345, 678));
        let tc = with_anthropic(&server, "claude-sonnet-5-5").await;
        let prompt = prompt_with("+MARKER-7f3a-INHALT fix");
        let schema = schema();
        gate::confirm(&tc, None, AiFeature::CommitMessage, &prompt.fingerprint(), &[AiAskTrigger::FirstUse], false).unwrap();
        let answer = complete_json(&tc, request(None, "u1", &prompt, &schema)).await.unwrap();
        assert_eq!(answer.cost_usd.map(pricing::micros), Some(31_470), "12 345 × 2 USD/M + 678 × 10 USD/M");
        let rows = tc.db.with(|c| db::ai::usage_rows(c, &pricing::current_month())).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            (rows[0].provider.as_str(), rows[0].model.as_str(), rows[0].feature.as_str(), rows[0].requests, rows[0].input_tokens, rows[0].output_tokens, rows[0].cost_usd_micros),
            ("anthropic", "claude-sonnet-5-5", "commit_message", 1, 12_345, 678, 31_470)
        );
        let log = tc.db.with(|c| db::activity::page(c, ActivityScope::App, None, None, 50)).unwrap();
        let entry = log.entries.iter().find(|e| e.command.starts_with("ai: commit-message")).expect("an AI log entry");
        assert_eq!(entry.command, "ai: commit-message (Anthropic · claude-sonnet-5-5) · 12345 → 678 tokens");
        assert_eq!(entry.output, "");
        assert_eq!(entry.code, None);
        let everything: String = tc
            .db
            .with(|c| {
                let mut stmt = c.prepare("select coalesce(description, '') || ' ' || coalesce(command, '') || ' ' || coalesce(output, '') from activity_log")?;
                let rows = stmt.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                Ok(rows.join("\n"))
            })
            .unwrap();
        assert!(!everything.contains("MARKER-7f3a-INHALT") && !everything.contains(KEY), "no contents and no key in the activity log");
        assert!(tc.events.all().iter().all(|(_, payload)| !payload.to_string().contains("MARKER-7f3a-INHALT")), "nor in any event");
    }

    #[tokio::test]
    async fn api_providers_ask_before_the_first_use_and_the_first_time_per_repository() {
        let server = MockServer::start(|_| anthropic_answer(10, 5));
        let tc = with_anthropic(&server, "claude-sonnet-5-5").await;
        let repo = TestRepo::with_commit();
        let id = tc.open(&repo).await.repo.id;
        let schema = schema();
        let prompt = prompt_with("+fix");
        let error = complete_json(&tc, request(Some(&id), "a1", &prompt, &schema)).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::NotAllowed, "{error:?}");
        assert!(server.requests().is_empty(), "nothing goes out unconfirmed");
        gate::confirm(&tc, Some(&id), AiFeature::CommitMessage, &prompt_with("+other text").fingerprint(), &[AiAskTrigger::FirstUse, AiAskTrigger::RepoFirst], false).unwrap();
        // Remembered as seen: from now on this repository and this function need no confirmation.
        complete_json(&tc, request(Some(&id), "a2", &prompt, &schema)).await.unwrap();
        assert_eq!(server.requests().len(), 1);
        let other = TestRepo::with_commit();
        let other_id = tc.open(&other).await.repo.id;
        assert_eq!(complete_json(&tc, request(Some(&other_id), "a3", &prompt, &schema)).await.unwrap_err().code, ErrorCode::NotAllowed, "another repository asks for its own first time");
        assert_eq!(server.requests().len(), 1);
    }

    #[tokio::test]
    async fn the_monthly_limit_stops_until_confirmed_for_this_text() {
        let server = MockServer::start(|_| anthropic_answer(10, 5));
        let tc = with_anthropic(&server, "claude-sonnet-5-5").await;
        settings_set(&tc, json!({"aiMonthlyLimitUsd": 0.01})).await.unwrap();
        let month = pricing::current_month();
        tc.db
            .with(|c| db::ai::add_usage(c, &db::ai::NewUsage { month: &month, provider: "anthropic", model: "claude-sonnet-5-5", feature: "compose", input_tokens: 1, output_tokens: 1, cost_usd_micros: 20_000 }))
            .unwrap();
        let schema = schema();
        let prompt = prompt_with("+fix");
        gate::confirm(&tc, None, AiFeature::CommitMessage, &prompt.fingerprint(), &[AiAskTrigger::FirstUse], false).unwrap();
        let error = complete_json(&tc, request(None, "l1", &prompt, &schema)).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::AiLimitReached);
        assert!(error.message.contains("0.02") && error.message.contains("0.01"), "{}", error.message);
        assert!(server.requests().is_empty());
        gate::confirm(&tc, None, AiFeature::CommitMessage, &prompt.fingerprint(), &[AiAskTrigger::Limit], false).unwrap();
        complete_json(&tc, request(None, "l2", &prompt, &schema)).await.unwrap();
        assert_eq!(
            complete_json(&tc, request(None, "l2b", &prompt, &schema)).await.unwrap_err().code,
            ErrorCode::AiLimitReached,
            "“Send this time” holds for one request, even for the same text"
        );
        let next = prompt_with("+next change");
        assert_eq!(complete_json(&tc, request(None, "l3", &next, &schema)).await.unwrap_err().code, ErrorCode::AiLimitReached, "asked again before every further request");
        settings_set(&tc, json!({"aiModel": "claude-eigenbau"})).await.unwrap();
        complete_json(&tc, request(None, "l4", &next, &schema)).await.unwrap();
        assert_eq!(server.requests().len(), 2, "an unknown price has no limit protection (spec 1.5)");
    }

    #[tokio::test]
    async fn cancelling_ends_the_job_at_once_and_drops_the_answer() {
        let server = MockServer::start(|request| match request.route().as_str() {
            "POST /api/show" => ollama_show(),
            _ => ollama_chat("{\"summary\":\"late\",\"body\":null}", "stop").delay(Duration::from_secs(5)),
        });
        let tc = with_ollama(&server).await;
        let (prompt, schema) = (prompt_with("+fix"), schema());
        let started = std::time::Instant::now();
        let cancel = async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            tc.jobs.cancel("job-cancel")
        };
        let (result, was_running) = tokio::join!(complete_json(&tc, request(None, "job-cancel", &prompt, &schema)), cancel);
        assert!(was_running, "the job was registered while the request ran");
        assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
        assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
        let done = tc.events.all().into_iter().find(|(name, payload)| name == names::JOB_DONE && payload["jobId"] == "job-cancel").expect("job:done");
        assert_eq!(done.1["cancelled"], true);
    }

    #[tokio::test]
    async fn turning_the_master_switch_off_cancels_running_requests() {
        let server = MockServer::start(|request| match request.route().as_str() {
            "POST /api/show" => ollama_show(),
            _ => ollama_chat("{\"summary\":\"late\",\"body\":null}", "stop").delay(Duration::from_secs(5)),
        });
        let tc = with_ollama(&server).await;
        let (prompt, schema) = (prompt_with("+fix"), schema());
        let off = async {
            tokio::time::sleep(Duration::from_millis(300)).await;
            settings_set(&tc, json!({"aiEnabled": false})).await.unwrap();
        };
        let (result, ()) = tokio::join!(complete_json(&tc, request(None, "job-off", &prompt, &schema)), off);
        assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
    }
}
