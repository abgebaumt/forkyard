//! AI commands (v1.2): status, keys, checking a provider, the one-time notice, "What is sent?",
//! confirmations and this month's usage. The AI settings themselves are `Settings` fields
//! (`settings_set`); the AI functions of later packages call `ai::run::complete_json`.

use std::collections::HashSet;
use std::ffi::OsString;
use std::path::PathBuf;

use serde_json::{json, Value};

use crate::ai::{self, commit_message, context, gate, pricing, providers, run};
use crate::app::Core;
use crate::db;
use crate::error::{CoreError, CoreResult};
use crate::jobs::CancelToken;
use crate::model::{
    AiAskTrigger, AiCommitMessage, AiDetection, AiFeature, AiInput, AiModelList, AiPreview, AiProviderKind, AiState, AiStatus, AiStructuredMode, AiUsageRow, AiUsageSummary, AppChange, AiPushFinding, AiPushFindingKind, AiPushReview, ConflictBlockRange, ConflictIntent, Settings,
};
use crate::secrets;
use crate::util;
use crate::commands::sync::{push_destination, PushRequest};

/// The stored key of a provider; `None` if there is none or the keychain is unreachable.
async fn stored_key(core: &Core, kind: AiProviderKind) -> Option<String> {
    if !kind.accepts_key() {
        return None;
    }
    secrets::get(core, &ai::key_account(kind)).await.ok().flatten()
}

/// Budget (tokens) and known secrets of a request for `feature` – the same for "What is sent?"
/// and for the request itself, so both build the same text (the confirmation is bound to it).
async fn request_frame(core: &Core, settings: &Settings, feature: AiFeature) -> (u64, Vec<String>) {
    let context_size = match (settings.ai_provider, settings.ai_model.as_deref()) {
        (Some(kind), Some(model)) => providers::context_tokens(core, kind, model),
        _ => 32_000,
    };
    let secrets = match settings.ai_provider {
        Some(kind) => stored_key(core, kind).await.into_iter().collect(),
        None => Vec::new(),
    };
    (context::budget_tokens(feature.budget_tokens(), context_size), secrets)
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

/// The outgoing changes of a push with these arguments (`AiInput::OutgoingChanges`, `ai_push_review`).
async fn outgoing_for(core: &Core, repo_id: &str, branch: Option<&str>, remote: Option<&str>, remote_branch: Option<&str>) -> CoreResult<context::Outgoing> {
    let request = PushRequest { branch, remote, remote_branch, ..PushRequest::default() };
    let (local_ref, remote, _) = push_destination(core, repo_id, &request).await?;
    context::outgoing(core, repo_id, &local_ref, &remote).await
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
    let (budget, secrets) = request_frame(core, &settings, feature).await;
    let built = match input {
        AiInput::StagedChanges => context::staged_changes(core, &repo_id, &settings, budget, &locale, &secrets).await?,
        AiInput::CommitMessage => commit_message::build(core, &repo_id, &settings, budget, &locale, &secrets).await?,
        AiInput::PrDescription { source, target } => ai::pr::build(core, &repo_id, &settings, &source, &target, budget, &locale, &secrets).await?.built,
        AiInput::ConflictIntent { path, blocks } => ai::conflict::build(core, &repo_id, &path, &blocks, &settings, budget, &locale, &secrets).await?.built,
        AiInput::OutgoingChanges { branch, remote, remote_branch } => {
            let outgoing = outgoing_for(core, &repo_id, branch.as_deref(), remote.as_deref(), remote_branch.as_deref()).await?;
            context::outgoing_changes(core, &repo_id, &settings, budget, &locale, &secrets, &outgoing).await?.built
        }
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

const MAX_REVIEW_FINDINGS: usize = 50;
const MAX_NOTE_CHARS: usize = 300;

/// Answer schema of the review before a push (1a's dialect: every field required, no formats).
fn push_review_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "findings": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "line": {"type": ["integer", "null"]},
                        "kind": {"type": "string", "enum": ["debug_output", "commented_code", "likely_bug"]},
                        "note": {"type": "string"}
                    },
                    "required": ["path", "line", "kind", "note"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["findings"],
        "additionalProperties": false
    })
}

/// The answer is data (Grundregel 3): only files the model saw, sensible lines, redacted notes,
/// no duplicates, at most `MAX_REVIEW_FINDINGS`; sorted by path and line.
fn review_findings(value: &Value, shown: &[String], secrets: &[String]) -> Vec<AiPushFinding> {
    let known: HashSet<&str> = shown.iter().map(String::as_str).collect();
    let mut seen: HashSet<(String, Option<u32>, AiPushFindingKind)> = HashSet::new();
    let mut out = Vec::new();
    for item in value.get("findings").and_then(Value::as_array).into_iter().flatten() {
        let Some(raw) = item.get("path").and_then(Value::as_str) else { continue };
        let Some(path) = [raw.to_string(), raw.replace('\\', "/")]
            .into_iter()
            .filter_map(|candidate| crate::commands::history::normalize_rel_path(&candidate).ok())
            .find(|candidate| known.contains(candidate.as_str()))
        else {
            continue;
        };
        let kind = match item.get("kind").and_then(Value::as_str) {
            Some("debug_output") => AiPushFindingKind::DebugOutput,
            Some("commented_code") => AiPushFindingKind::CommentedCode,
            Some("likely_bug") => AiPushFindingKind::LikelyBug,
            _ => continue,
        };
        let line = item.get("line").and_then(Value::as_u64).filter(|number| *number >= 1).and_then(|number| u32::try_from(number).ok());
        let note = context::redact_for_ai(item.get("note").and_then(Value::as_str).unwrap_or("").trim(), secrets);
        let note = util::truncate_str(&note, MAX_NOTE_CHARS);
        if note.trim().is_empty() || !seen.insert((path.clone(), line, kind)) {
            continue;
        }
        out.push(AiPushFinding { path, line, kind, note });
        if out.len() == MAX_REVIEW_FINDINGS {
            break;
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    out
}

/// "Review and push …" (spec 6.2): asks the provider about leftovers in what a `push` with these
/// arguments would send. Same target rules and errors as `push`; nothing outgoing → no request.
/// Budget, secrets (`request_frame`) and builder are those of `ai_preview` for `AiInput::OutgoingChanges`, so the
/// confirmation of "What is sent?" matches.
pub async fn ai_push_review(core: &Core, repo_id: String, job_id: String, branch: Option<String>, remote: Option<String>, remote_branch: Option<String>, locale: String) -> CoreResult<AiPushReview> {
    let settings = run::ensure_allowed(core, Some(&repo_id), AiFeature::PushReview)?;
    let outgoing = outgoing_for(core, &repo_id, branch.as_deref(), remote.as_deref(), remote_branch.as_deref()).await?;
    if outgoing.commits.is_empty() {
        return Ok(AiPushReview { findings: Vec::new(), commits: 0, files: 0, partial: false });
    }
    // Budget and known secrets exactly as `ai_preview` computes them (Paket 3.1's `request_frame`).
    let (budget, secrets) = request_frame(core, &settings, AiFeature::PushReview).await;
    let built = context::outgoing_changes(core, &repo_id, &settings, budget, &locale, &secrets, &outgoing).await?;
    let schema = push_review_schema();
    let answer = run::complete_json(core, run::AiRequest { repo_id: Some(&repo_id), feature: AiFeature::PushReview, job_id: &job_id, prompt: &built.built.prompt, schema: &schema }).await?;
    Ok(AiPushReview { findings: review_findings(&answer.value, &built.shown, &secrets), commits: built.commits, files: built.files, partial: built.partial })
}

/// Paket 4: title and description of a pull request from the commits of `source` that `target`
/// does not have. A suggestion only – nothing is written; the form places it. The prompt is the
/// one `ai_preview` shows for `AiInput::PrDescription` with the same refs; with a template the
/// answer must keep every heading (one repair attempt), and "Closes #n" comes from the commits.
pub async fn ai_pr_description(core: &Core, repo_id: String, job_id: String, source: String, target: String, locale: String) -> CoreResult<crate::model::AiPrDescription> {
    let settings = run::ensure_allowed(core, Some(&repo_id), AiFeature::PrDescription)?;
    let (budget, secrets) = request_frame(core, &settings, AiFeature::PrDescription).await;
    let pr = ai::pr::build(core, &repo_id, &settings, &source, &target, budget, &locale, &secrets).await?;
    let schema = ai::pr::schema();
    let request = run::AiRequest { repo_id: Some(&repo_id), feature: AiFeature::PrDescription, job_id: &job_id, prompt: &pr.built.prompt, schema: &schema };
    let answer = run::complete_json_checked(core, request, &|value: &serde_json::Value| ai::pr::check_answer(value, &pr.headings)).await?;
    Ok(ai::pr::finish(&answer.value, &pr.closes))
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

/// "Write" in the commit form (spec 3.1): a commit message for the staged changes – a draft, the
/// core commits nothing. Built exactly as `ai_preview` with `AiInput::CommitMessage` shows it, so a
/// confirmation given there holds here; `complete_json` refuses everything unconfirmed.
pub async fn ai_commit_message(core: &Core, repo_id: String, job_id: String, locale: String) -> CoreResult<AiCommitMessage> {
    let settings = run::ensure_allowed(core, Some(&repo_id), AiFeature::CommitMessage)?;
    let (budget, secrets) = request_frame(core, &settings, AiFeature::CommitMessage).await;
    let built = commit_message::build(core, &repo_id, &settings, budget, &locale, &secrets).await?;
    let schema = commit_message::schema();
    let answer = run::complete_json(core, run::AiRequest { repo_id: Some(&repo_id), feature: AiFeature::CommitMessage, job_id: &job_id, prompt: &built.prompt, schema: &schema }).await?;
    commit_message::parse(&answer.value)
}

/// Setup dialog: Claude Code, Codex and opencode with version, path and sign-in, Ollama / LM Studio on
/// this computer and the providers with a stored key – about two seconds at most, sends nothing.
pub async fn ai_detect(core: &Core) -> CoreResult<AiDetection> {
    ai::detect::detect(core).await
}

/// „Sign in in the terminal“ (spec „Zustände“, `ai_not_logged_in`): a terminal in this repository's
/// tab runs the tool's own sign-in (`claude auth login`, `codex login`, `opencode providers login`) in
/// an empty folder of the app. Returns the terminal ID.
pub async fn ai_cli_login(core: &Core, repo_id: String, provider: AiProviderKind, cols: u16, rows: u16) -> CoreResult<String> {
    if !provider.is_cli() {
        return Err(CoreError::not_allowed(format!("{} has no sign-in in the terminal.", provider.label())));
    }
    let settings = core.settings()?;
    let program = ai::cli::program_for(core, provider, &settings).await?;
    let mut env: Vec<(OsString, OsString)> = Vec::new();
    if let Some(path) = ai::cli::child_path(core).await {
        env.push((OsString::from("PATH"), path));
    }
    let launch = crate::commands::terminal::ProgramLaunch { program, args: ai::cli::login_args(provider), cwd: PathBuf::new(), env, title: provider.label().to_string() };
    crate::commands::terminal::terminal_open_login(core, &repo_id, launch, cols, rows).await
}

/// Teilpaket 6.1 – “Explain intent” in the conflict tool: what both sides of every conflict block
/// wanted and a proposed text per block (`ai::conflict`). Checks that AI is on for this function and
/// repository before anything is read, builds exactly the text `ai_preview` shows for
/// `AiInput::ConflictIntent` (same builder, same `request_frame`), asks the provider as job `job_id`
/// (confirmations, usage and the activity entry by `complete_json`) and checks the answer per block.
/// Changes nothing in the repository.
pub async fn ai_conflict_intent(core: &Core, repo_id: String, job_id: String, path: String, blocks: Vec<ConflictBlockRange>, locale: String) -> CoreResult<ConflictIntent> {
    let settings = run::ensure_allowed(core, Some(&repo_id), AiFeature::ConflictIntent)?;
    let (budget, secrets) = request_frame(core, &settings, AiFeature::ConflictIntent).await;
    let plan = ai::conflict::build(core, &repo_id, &path, &blocks, &settings, budget, &locale, &secrets).await?;
    let schema = ai::conflict::schema();
    let answer = run::complete_json(
        core,
        run::AiRequest { repo_id: Some(&repo_id), feature: AiFeature::ConflictIntent, job_id: &job_id, prompt: &plan.built.prompt, schema: &schema },
    )
    .await?;
    ai::conflict::accept(&plan, &answer.value)
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

    #[cfg(unix)]
    #[tokio::test]
    async fn signing_in_runs_the_tool_in_an_empty_folder_of_the_app() {
        use std::os::unix::fs::PermissionsExt;
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        repo.write_file(".claude/settings.json", r#"{"hooks":{}}"#);
        let id = tc.open(&repo).await.repo.id;
        let log = tc.cli_dir().join("anmeldung.log");
        let script = tc.cli_dir().join("claude");
        // `--version` (the search) is answered with nothing; the sign-in records where it ran.
        std::fs::write(
            &script,
            format!("#!/bin/sh\n[ \"$1\" = auth ] || exit 0\nprintf '%s|' \"$(pwd -P)\" \"$@\" > '{log}.tmp'\nls -A >> '{log}.tmp'\nmv '{log}.tmp' '{log}'\n", log = log.display()),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        let terminal = ai_cli_login(&tc, id.clone(), AiProviderKind::ClaudeCode, 100, 30).await.unwrap();
        assert!(!terminal.is_empty());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        let text = loop {
            if let Ok(text) = std::fs::read_to_string(&log) {
                break text;
            }
            assert!(std::time::Instant::now() < deadline, "the sign-in never ran");
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        };
        let folder = std::fs::canonicalize(tc.data_dir().join("tmp").join("cli-login")).unwrap();
        assert_eq!(text, format!("{}|auth|login|", folder.display()), "in the app's empty folder, not in the repository");
        for kind in [AiProviderKind::Anthropic, AiProviderKind::Ollama] {
            assert_eq!(ai_cli_login(&tc, id.clone(), kind, 100, 30).await.unwrap_err().code, ErrorCode::NotAllowed, "{kind:?}");
        }
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

    /// A repository with German subjects and one staged file.
    fn messnetz() -> TestRepo {
        let repo = TestRepo::with_commit();
        repo.commit_file("README.md", "# Messnetz\n", "Projekt für das Messnetz angelegt");
        repo.commit_file("stationen.csv", "kürzel;name\nN;Nord\n", "Liste der Stationen");
        repo.commit_file("src/vergleich.py", "def differenz(a, b):\n    return a - b\n", "Vergleich der Tagesmittel zweier Stationen");
        repo.write_file("src/export.py", "def zeile(station, wert):\n    return f\"{station};{wert}\"\n");
        repo.git(&["add", "src/export.py"]);
        repo
    }

    fn without_token(text: &str) -> String {
        let token = text.split("<<<REPO ").nth(1).and_then(|rest| rest.split(">>>").next()).unwrap_or_default().to_string();
        assert!(!token.is_empty(), "the text has a delimiter token");
        text.replace(&token, "TOKEN")
    }

    #[tokio::test]
    async fn the_commit_message_comes_from_the_staged_diff_with_a_local_model() {
        let server = MockServer::start(|request| match request.route().as_str() {
            "POST /api/show" => MockResponse::json(200, json!({"model_info": {"qwen3.context_length": 40960}})),
            _ => MockResponse::json(
                200,
                json!({"model": "qwen3:8b", "message": {"role": "assistant", "content": "{\"summary\":\"  CSV-Export je Station ergänzt  \",\"body\":\"Schreibt je Station eine Zeile.\\r\\n\"}"}, "done": true, "done_reason": "stop", "prompt_eval_count": 420, "eval_count": 31}),
            ),
        });
        let tc = TestCore::new().await;
        configure_base(&tc, AiProviderKind::Ollama, Some(server.url()));
        settings_set(&tc, json!({"aiEnabled": true, "aiProvider": "ollama", "aiModel": "qwen3:8b"})).await.unwrap();
        let repo = messnetz();
        let id = tc.open(&repo).await.repo.id;

        let message = ai_commit_message(&tc, id.clone(), "cm-local".into(), "de-DE".into()).await.unwrap();
        assert_eq!(message, AiCommitMessage { summary: "CSV-Export je Station ergänzt".into(), body: Some("Schreibt je Station eine Zeile.".into()) });

        let chat = server.requests().into_iter().find(|r| r.route() == "POST /api/chat").expect("one request");
        let body = chat.json();
        assert_eq!(body["format"], commit_message::schema());
        let system = body["messages"][0]["content"].as_str().unwrap();
        let user = body["messages"][1]["content"].as_str().unwrap();
        assert!(system.contains("in German"), "{system}");
        assert!(user.contains("File: src/export.py") && user.contains("+def zeile(station, wert):"), "{user}");
        for subject in repo.git(&["log", "--no-merges", "--format=%s"]).lines() {
            assert!(user.contains(subject), "style example {subject}: {user}");
        }
        assert!(user.contains("\nmain\n"), "the branch: {user}");
        assert_eq!(server.count("POST /api/chat"), 1);
        assert_eq!(repo.git(&["diff", "--cached", "--name-only"]), "src/export.py", "the core commits and unstages nothing");
    }

    #[tokio::test]
    async fn the_preview_approves_exactly_the_text_the_command_sends() {
        assert_eq!(serde_json::from_value::<AiInput>(json!({"kind": "commit_message"})).unwrap(), AiInput::CommitMessage);
        let server = MockServer::start(|_| {
            MockResponse::json(200, json!({"content": [{"type": "text", "text": "{\"summary\":\"CSV-Export je Station ergänzt\",\"body\":null}"}], "stop_reason": "end_turn", "usage": {"input_tokens": 900, "output_tokens": 12}}))
        });
        let tc = TestCore::new().await;
        configure_base(&tc, AiProviderKind::Anthropic, Some(format!("{}/v1", server.url())));
        crate::secrets::set(&tc, "llm:anthropic", "sk-ant-api03-testkey-0123456789abcdef").await.unwrap();
        settings_set(&tc, json!({"aiEnabled": true, "aiProvider": "anthropic", "aiModel": "claude-sonnet-5-5"})).await.unwrap();
        let repo = messnetz();
        let id = tc.open(&repo).await.repo.id;
        let messages = || server.requests().into_iter().filter(|r| r.route() == "POST /v1/messages").collect::<Vec<_>>();

        let error = ai_commit_message(&tc, id.clone(), "cm-1".into(), "de-DE".into()).await.unwrap_err();
        assert_eq!(error.code, ErrorCode::NotAllowed, "{error:?}");
        assert!(messages().is_empty(), "nothing goes out before “What is sent?” was confirmed");

        let preview = ai_preview(&tc, id.clone(), AiFeature::CommitMessage, AiInput::CommitMessage, "de-DE".into()).await.unwrap();
        assert_eq!(preview.asks, vec![AiAskTrigger::FirstUse, AiAskTrigger::RepoFirst]);
        assert!(preview.text.contains("## Recent commit subjects") && preview.text.contains("File: src/export.py"), "{}", preview.text);
        ai_preview_confirm(&tc, Some(id.clone()), AiFeature::CommitMessage, preview.fingerprint.clone(), preview.asks.clone(), false).await.unwrap();

        let message = ai_commit_message(&tc, id.clone(), "cm-2".into(), "de-DE".into()).await.unwrap();
        assert_eq!(message, AiCommitMessage { summary: "CSV-Export je Station ergänzt".into(), body: None });
        let sent = messages();
        assert_eq!(sent.len(), 1);
        let body = sent[0].json();
        let sent_text = format!("{}\n\n{}", body["system"].as_str().unwrap(), body["messages"][0]["content"].as_str().unwrap());
        assert_eq!(without_token(&sent_text), without_token(&preview.text), "exactly the previewed text went out");
        assert_ne!(sent_text, preview.text, "with its own delimiter token");
        assert!(!sent_text.contains("sk-ant-api03-testkey"), "the key is never part of the text");
    }

    #[tokio::test]
    async fn nothing_is_sent_while_ai_is_off_untrusted_or_nothing_is_staged() {
        let server = MockServer::start(|_| MockResponse::json(200, json!({"model_info": {}})));
        let tc = TestCore::new().await;
        configure_base(&tc, AiProviderKind::Ollama, Some(server.url()));
        settings_set(&tc, json!({"aiEnabled": true, "aiProvider": "ollama", "aiModel": "qwen3:8b"})).await.unwrap();
        let repo = messnetz();
        let id = tc.open(&repo).await.repo.id;
        crate::commands::settings::repo_settings_set(&tc, id.clone(), json!({"aiOff": true})).await.unwrap();
        assert_eq!(ai_commit_message(&tc, id.clone(), "cm-off".into(), "en".into()).await.unwrap_err().code, ErrorCode::AiDisabled, "AI off for this repository");
        crate::commands::settings::repo_settings_set(&tc, id.clone(), json!({"aiOff": false})).await.unwrap();
        settings_set(&tc, json!({"aiFeaturesOff": ["commit_message"]})).await.unwrap();
        assert_eq!(ai_commit_message(&tc, id.clone(), "cm-feature".into(), "en".into()).await.unwrap_err().code, ErrorCode::AiDisabled, "the function is off");
        settings_set(&tc, json!({"aiFeaturesOff": []})).await.unwrap();
        repo.git(&["reset", "-q"]);
        assert_eq!(ai_commit_message(&tc, id.clone(), "cm-empty".into(), "en".into()).await.unwrap_err().code, ErrorCode::NothingToCommit);
        assert_eq!(ai_preview(&tc, id.clone(), AiFeature::CommitMessage, AiInput::CommitMessage, "en".into()).await.unwrap_err().code, ErrorCode::NothingToCommit);
        repo.git(&["add", "src/export.py"]);
        crate::commands::trust::repo_trust_set(&tc, id.clone(), false).await.unwrap();
        assert_eq!(ai_commit_message(&tc, id, "cm-untrusted".into(), "en".into()).await.unwrap_err().code, ErrorCode::RepoUntrusted, "the AI core checks repository trust itself");
        assert!(server.requests().iter().all(|r| r.route() != "POST /api/chat"), "nothing was sent");
    }
}

#[cfg(test)]
#[path = "ai_push_review_tests.rs"]
mod push_review_tests;
