//! Semantic commit search (spec 9.2): "Text | Meaning" in the commit search.
//!
//! The way (Entscheidung 7): (1) a local embedding provider from Settings › AI (Ollama or LM Studio
//! on this computer), else (2) the embeddings API of the main provider, else (3) rephrasing – the
//! model turns the question into search terms, code, paths, author and time window, the core
//! searches with the filters of the commit search and the model sorts the hits.
//!
//! The index lives in its own file `ai-index.db` in the data directory (not in the main database,
//! no migration), per repository and embedding model: subject, start of the message and changed
//! paths of every commit reachable from a branch, remote branch, tag or HEAD – newest first, at
//! most 200 000. It grows on every search and, once "Meaning" was used, in the background after a
//! fetch or commit; commits that are no longer reachable leave it.
//!
//! What goes to an embedder is repository content: the same exclusions, redaction and
//! confirmations (`ai::gate`) as every AI request, bound to exactly the sent text.

pub mod history;
pub mod index;
mod rephrase;
pub mod vector;

#[cfg(test)]
pub(crate) mod fakes;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;

use sha2::{Digest, Sha256};

use crate::ai::context::{self, Exclusions};
use crate::ai::gate::{self, Situation};
use crate::ai::provider::{Provider, Usage};
use crate::ai::{pricing, providers, run};
use crate::app::Core;
use crate::db;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::jobs::{CancelToken, Job};
use crate::commands::graph::commit_summaries;
use crate::model::{AiFeature, AiOmitReason, AiOmitted, AiPreview, AiProviderKind, AiSearchRoute, AiSemanticHit, AiSemanticResult, AiState, AiStructuredMode, CommitSummary, Settings};
use crate::util;

/// At most this many commits are indexed (newest first); spec: "Obergrenze 200 000 Commits".
pub const MAX_COMMITS: usize = 200_000;
/// Longest question; beyond it is cut off.
pub const MAX_QUESTION_CHARS: usize = 500;
pub const DEFAULT_OPENAI_MODEL: &str = "text-embedding-3-small";
pub const DEFAULT_GEMINI_MODEL: &str = "gemini-embedding-001";
/// The preview shows this many new index entries verbatim.
const PREVIEW_ENTRIES: usize = 200;

/// At most this many hits per search.
pub const MAX_HITS: usize = 50;
/// Texts per embedding request.
pub const BATCH: usize = 64;

/// One index update per repository at a time (search or background).
#[derive(Default)]
struct IndexLocks {
    map: parking_lot::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

fn index_lock(core: &Core, repo_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    core.state::<IndexLocks>().map.lock().entry(repo_id.to_string()).or_default().clone()
}

/// At most this many left-out paths are listed in the preview.
const MAX_OMITTED: usize = 200;

/// Which embedder the search uses, if any.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EmbedChoice {
    pub kind: AiProviderKind,
    pub model: String,
    pub route: AiSearchRoute,
}

/// Entscheidung 7: the local embedder of Settings › AI, else the main provider's embeddings,
/// else `None` (rephrasing).
pub fn choose(settings: &Settings) -> Option<EmbedChoice> {
    let model = settings.ai_search_embed_model.clone().filter(|model| !model.trim().is_empty());
    if let (Some(kind @ (AiProviderKind::Ollama | AiProviderKind::Lmstudio)), Some(model)) = (settings.ai_search_embed_provider, model.clone()) {
        return Some(EmbedChoice { kind, model, route: AiSearchRoute::LocalEmbeddings });
    }
    let kind = settings.ai_provider?;
    let model = match kind {
        AiProviderKind::Openai => model.unwrap_or_else(|| DEFAULT_OPENAI_MODEL.to_string()),
        AiProviderKind::Gemini => model.unwrap_or_else(|| DEFAULT_GEMINI_MODEL.to_string()),
        AiProviderKind::OpenaiCompatible | AiProviderKind::Ollama | AiProviderKind::Lmstudio => model?,
        // Anthropic and the command-line providers have no embeddings.
        _ => return None,
    };
    Some(EmbedChoice { kind, model, route: AiSearchRoute::ProviderEmbeddings })
}

/// A provider instance for the embedding model.
pub struct Embedder {
    pub choice: EmbedChoice,
    pub base: String,
    pub label: String,
    pub provider: Box<dyn Provider>,
    /// The provider key (scrubbed literally from every text).
    pub secrets: Vec<String>,
}

impl Embedder {
    pub fn local(&self) -> bool {
        self.choice.kind.is_local()
    }
}

pub async fn embedder(core: &Core, settings: &Settings) -> CoreResult<Option<Embedder>> {
    let Some(choice) = choose(settings) else { return Ok(None) };
    // The local embedder has its own address – never the one of the main provider.
    let lookup = if choice.route == AiSearchRoute::LocalEmbeddings { Settings { ai_base_url: settings.ai_search_embed_base_url.clone(), ..settings.clone() } } else { settings.clone() };
    let Some(base) = crate::ai::base_url_for(core, choice.kind, &lookup) else { return Ok(None) };
    let key = if choice.route == AiSearchRoute::ProviderEmbeddings && choice.kind.accepts_key() {
        crate::secrets::get(core, &crate::ai::key_account(choice.kind)).await?
    } else {
        None
    };
    if choice.kind.needs_key() && key.is_none() {
        return Err(CoreError::ai_not_configured(format!("No API key for {} is stored. Enter it in Settings › AI.", choice.kind.label())));
    }
    let provider = providers::build(choice.kind, base.clone(), key.clone(), choice.model.clone(), AiStructuredMode::JsonSchema, providers::default_context(choice.kind))?;
    Ok(Some(Embedder { label: provider.label(), choice, base, provider, secrets: key.into_iter().collect() }))
}

/// One line without control characters, at most `MAX_QUESTION_CHARS`; empty → `not_allowed`.
pub fn clean_question(query: &str) -> CoreResult<String> {
    let line: String = query.split_whitespace().collect::<Vec<_>>().join(" ").chars().filter(|c| !c.is_control()).take(MAX_QUESTION_CHARS).collect();
    if line.is_empty() {
        return Err(CoreError::not_allowed("Type what you are looking for first."));
    }
    Ok(line)
}

/// What an index update would do: commits to add (with their text) and to remove.
pub struct Plan {
    pub index_id: Option<i64>,
    /// Reachable commits, newest first, at most the cap.
    pub reachable: Vec<String>,
    pub capped: bool,
    /// (SHA, index text) of reachable commits not in the index yet, newest first.
    pub pending: Vec<(String, String)>,
    /// Commits in the index that are no longer reachable.
    pub stale: Vec<String>,
    /// Paths of the new entries that are left out entirely (secret, ignored) – for the preview.
    pub omitted: Vec<AiOmitted>,
}

pub async fn plan(core: &Core, repo_id: &str, embedder: &Embedder, settings: &Settings, cap: usize, token: &CancelToken) -> CoreResult<Plan> {
    let path = core.repo_path(repo_id)?;
    let (reachable, capped) = history::reachable(core, &path, repo_id, cap, token).await?;
    let index_id = index::find(core, repo_id, embedder.choice.kind.as_str(), &embedder.choice.model)?;
    let known = match index_id {
        Some(id) => index::known(core, id)?,
        None => HashSet::new(),
    };
    let wanted: HashSet<&str> = reachable.iter().map(String::as_str).collect();
    let stale: Vec<String> = known.iter().filter(|sha| !wanted.contains(sha.as_str())).cloned().collect();
    let missing: Vec<String> = reachable.iter().filter(|sha| !known.contains(*sha)).cloned().collect();
    let exclusions = Exclusions::load(core, repo_id, &settings.ai_exclude).await?;
    let entries = history::entries(core, &path, repo_id, &missing, token).await?;
    let pending = entries.iter().map(|entry| (entry.sha.clone(), history::entry_text(entry, &exclusions, &embedder.secrets))).collect();
    let mut omitted: Vec<AiOmitted> = Vec::new();
    for path in entries.iter().flat_map(|entry| entry.paths.iter()) {
        if omitted.len() >= MAX_OMITTED {
            break;
        }
        if let Some(reason @ (AiOmitReason::Secret | AiOmitReason::Ignored)) = exclusions.reason(path) {
            if !omitted.iter().any(|known| known.path == *path) {
                omitted.push(AiOmitted { path: path.clone(), reason, size: 0 });
            }
        }
    }
    Ok(Plan { index_id, reachable, capped, pending, stale, omitted })
}

fn write_request(query: Option<&str>, pending: &[(String, String)], total: usize) -> String {
    let mut text = String::new();
    if let Some(query) = query {
        text.push_str("Search question:\n");
        text.push_str(query);
        text.push('\n');
    }
    if total > 0 {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&format!("New index entries: {total}\n"));
        for (sha, entry) in pending {
            text.push_str("--- ");
            text.push_str(sha);
            text.push('\n');
            text.push_str(entry);
            text.push('\n');
        }
    }
    text
}

/// Exactly what one search (or background update without a question) sends to the embedder.
pub fn request_text(query: Option<&str>, pending: &[(String, String)]) -> String {
    write_request(query, pending, pending.len())
}

/// `request_text` up to `PREVIEW_ENTRIES` new entries, then a line with the rest.
pub fn preview_text(query: &str, pending: &[(String, String)]) -> String {
    if pending.len() <= PREVIEW_ENTRIES {
        return request_text(Some(query), pending);
    }
    let mut text = write_request(Some(query), &pending[..PREVIEW_ENTRIES], pending.len());
    text.push_str(&format!("… and {} more new index entries in the same form (not shown here).\n", pending.len() - PREVIEW_ENTRIES));
    text
}

/// Binds a confirmation to exactly this text (`gate`).
pub fn fingerprint(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

pub(crate) struct Costs {
    pub cost_usd: Option<f64>,
    pub spent_usd: f64,
    pub limit_usd: Option<f64>,
    pub limit_reached: bool,
}

/// Estimate of an embedding request: input tokens only, no limit protection without a price.
pub(crate) fn costs(core: &Core, settings: &Settings, embedder: &Embedder, chars: u64) -> CoreResult<Costs> {
    let price = pricing::price_for(settings, embedder.choice.kind, &embedder.choice.model);
    let cost_usd = price.as_ref().map(|price| pricing::cost_usd(price, &Usage { input_tokens: context::estimate_tokens(chars), output_tokens: 0 }));
    let spent_usd = core.db.with(|c| db::ai::month_cost_micros(c, &pricing::current_month(), &run::API_PROVIDERS))? as f64 / 1_000_000.0;
    let limit_usd = settings.ai_monthly_limit_usd;
    let limit_reached = !embedder.local() && price.is_some() && limit_usd.is_some_and(|limit| spent_usd >= limit);
    Ok(Costs { cost_usd, spent_usd, limit_usd, limit_reached })
}

fn situation<'a>(repo_id: &'a str, chars: u64, costs: &Costs, local: bool) -> Situation<'a> {
    Situation { repo_id: Some(repo_id), feature: AiFeature::SemanticSearch, chars, estimated_cost_usd: costs.cost_usd, local, limit_reached: costs.limit_reached }
}

/// "What is sent?" for a search by meaning – sends nothing.
pub async fn preview(core: &Core, repo_id: &str, query: &str, locale: &str) -> CoreResult<AiPreview> {
    let settings = core.settings()?;
    let query = clean_question(query)?;
    let Some(embedder) = embedder(core, &settings).await? else {
        return rephrase::preview(core, repo_id, &settings, &query, locale).await;
    };
    let plan = plan(core, repo_id, &embedder, &settings, MAX_COMMITS, &CancelToken::new()).await?;
    // The question is redacted like repository text (a pasted token is a secret too).
    let sent = context::redact_for_ai(&query, &embedder.secrets);
    let text = request_text(Some(&sent), &plan.pending);
    let chars = text.chars().count() as u64;
    let costs = costs(core, &settings, &embedder, chars)?;
    let asks = if crate::ai::state_of(&settings) == AiState::On { gate::pending(core, &settings, &situation(repo_id, chars, &costs, embedder.local()))? } else { Vec::new() };
    Ok(AiPreview {
        text: preview_text(&sent, &plan.pending),
        omitted: plan.omitted.clone(),
        shortened: Vec::new(),
        chars,
        estimated_tokens: context::estimate_tokens(chars),
        estimated_cost_usd: costs.cost_usd,
        asks,
        fingerprint: fingerprint(&text),
        month_cost_usd: costs.spent_usd,
        limit_usd: costs.limit_usd,
    })
}

/// Words of the question (from 3 characters) that occur in `text`, lower case, in order.
pub fn matched_terms(query: &str, text: &str) -> Vec<String> {
    let haystack = text.to_lowercase();
    let mut found: Vec<String> = Vec::new();
    for word in query.split(|c: char| !(c.is_alphanumeric() || c == '-' || c == '_')) {
        let word = word.trim_matches('-').to_lowercase();
        if word.chars().count() >= 3 && haystack.contains(&word) && !found.contains(&word) {
            found.push(word);
        }
    }
    found
}

/// What one embedding run sent, for usage and the activity log.
struct Sending {
    started_at: String,
    started: Instant,
    chars: u64,
}

impl Sending {
    fn new() -> Self {
        Sending { started_at: util::now_iso(), started: Instant::now(), chars: 0 }
    }
}

/// Embeds the new entries batch by batch; finished batches stay in the index when cancelled.
async fn embed_pending(core: &Core, id: i64, job: Option<&Job>, token: &CancelToken, embedder: &Embedder, pending: &[(String, String)], sending: &mut Sending) -> CoreResult<u64> {
    let total = pending.len();
    let mut done = 0usize;
    for batch in pending.chunks(BATCH) {
        token.check()?;
        let texts: Vec<String> = batch.iter().map(|(_, text)| text.clone()).collect();
        let vectors = embedder.provider.embed(core, &texts, token).await?;
        sending.chars += texts.iter().map(|text| text.chars().count() as u64).sum::<u64>();
        if vectors.len() != batch.len() {
            return Err(CoreError::ai_invalid_answer(format!("{} returned {} embeddings for {} texts", embedder.label, vectors.len(), batch.len())));
        }
        let mut rows = Vec::with_capacity(batch.len());
        for ((sha, _), values) in batch.iter().zip(vectors) {
            let prepared = vector::prepare(values).ok_or_else(|| CoreError::ai_invalid_answer(format!("{} returned an empty embedding", embedder.label)))?;
            rows.push((sha.clone(), prepared));
        }
        index::insert(core, id, &rows)?;
        done += batch.len();
        if let Some(job) = job {
            job.progress("index", Some((done * 100 / total.max(1)) as u32), &format!("{done} / {total}"));
        }
    }
    Ok(done as u64)
}

/// Usage (numbers only) and one activity-log entry; nothing when nothing went out.
fn record_embedding(core: &Core, repo_id: &str, settings: &Settings, embedder: &Embedder, sending: &Sending, error: Option<ErrorCode>) {
    if sending.chars == 0 {
        return;
    }
    let usage = Usage { input_tokens: context::estimate_tokens(sending.chars), output_tokens: 0 };
    let cost_usd = pricing::price_for(settings, embedder.choice.kind, &embedder.choice.model).map(|price| pricing::cost_usd(&price, &usage));
    run::record(
        core,
        &run::Record {
            repo_id: Some(repo_id),
            feature: AiFeature::SemanticSearch,
            kind: embedder.choice.kind,
            label: embedder.label.clone(),
            model: &embedder.choice.model,
            usage,
            cost_usd,
            started_at: sending.started_at.clone(),
            duration_ms: sending.started.elapsed().as_millis() as u64,
            error,
        },
    );
}

/// `ai_semantic_search`: one cancellable job; the route follows the settings (Entscheidung 7).
pub async fn search(core: &Core, repo_id: &str, job_id: &str, query: &str, locale: &str) -> CoreResult<AiSemanticResult> {
    search_with_cap(core, repo_id, job_id, query, locale, MAX_COMMITS).await
}

pub(crate) async fn search_with_cap(core: &Core, repo_id: &str, job_id: &str, query: &str, locale: &str, cap: usize) -> CoreResult<AiSemanticResult> {
    let settings = run::ensure_allowed(core, Some(repo_id), AiFeature::SemanticSearch)?;
    let query = clean_question(query)?;
    let job = core.start_job(job_id, Some(repo_id))?;
    run::track(core, job_id);
    let result = match embedder(core, &settings).await {
        Ok(Some(embedder)) => search_embedded(core, repo_id, &job, &settings, &embedder, &query, cap).await,
        Ok(None) => rephrase::search(core, repo_id, &job, &settings, &query, locale).await,
        Err(error) => Err(error),
    };
    run::untrack(core, job_id);
    job.finish(&result);
    result
}

async fn search_embedded(core: &Core, repo_id: &str, job: &Job, settings: &Settings, embedder: &Embedder, query: &str, cap: usize) -> CoreResult<AiSemanticResult> {
    let token = job.token();
    let lock = index_lock(core, repo_id);
    let _guard = tokio::select! {
        guard = lock.lock_owned() => guard,
        _ = token.cancelled() => return Err(CoreError::cancelled()),
    };
    let plan = plan(core, repo_id, embedder, settings, cap, token).await?;
    // Exactly the text of the preview: the redacted question and the new entries.
    let sent = context::redact_for_ai(query, &embedder.secrets);
    let text = request_text(Some(&sent), &plan.pending);
    let chars = text.chars().count() as u64;
    let costs = costs(core, settings, embedder, chars)?;
    let asks = gate::pending(core, settings, &situation(repo_id, chars, &costs, embedder.local()))?;
    gate::require(core, &fingerprint(&text), &asks, costs.spent_usd, costs.limit_usd)?;

    let id = match plan.index_id {
        Some(id) => id,
        None => index::create(core, repo_id, embedder.choice.kind.as_str(), &embedder.choice.model)?,
    };
    index::remove(core, id, &plan.stale)?;
    let mut sending = Sending::new();
    let outcome = embed_and_score(core, id, job, embedder, &sent, &plan.pending, &mut sending).await;
    record_embedding(core, repo_id, settings, embedder, &sending, outcome.as_ref().err().map(|error| error.code));
    let scored = outcome?;
    index::touch(core, id)?;

    // Best first; equal scores newest first. Only commits that are reachable now.
    let position: HashMap<&str, usize> = plan.reachable.iter().enumerate().map(|(n, sha)| (sha.as_str(), n)).collect();
    let mut ranked: Vec<(String, f32, usize)> = scored.into_iter().filter_map(|(sha, score)| position.get(sha.as_str()).copied().map(|n| (sha, score, n))).collect();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.2.cmp(&b.2)));
    ranked.truncate(MAX_HITS);
    let shas: Vec<String> = ranked.iter().map(|(sha, _, _)| sha.clone()).collect();
    let path = core.repo_path(repo_id)?;
    let mut by_sha: HashMap<String, CommitSummary> = commit_summaries(core, &path, repo_id, &shas, token).await?.into_iter().map(|commit| (commit.sha.clone(), commit)).collect();
    let hits = ranked
        .into_iter()
        .filter_map(|(sha, score, _)| by_sha.remove(&sha).map(|commit| AiSemanticHit { matched_terms: matched_terms(query, &commit.summary), commit, score: Some(f64::from(score)), reason: None }))
        .collect();
    Ok(AiSemanticResult {
        route: embedder.choice.route,
        hits,
        indexed: index::count(core, id)?,
        capped: plan.capped,
        ranked: true,
        filters: None,
        terms: Vec::new(),
        author: None,
        ignored: Vec::new(),
    })
}

async fn embed_and_score(core: &Core, id: i64, job: &Job, embedder: &Embedder, query: &str, pending: &[(String, String)], sending: &mut Sending) -> CoreResult<Vec<(String, f32)>> {
    embed_pending(core, id, Some(job), job.token(), embedder, pending, sending).await?;
    let question = vec![query.to_string()];
    let mut answered = embedder.provider.embed(core, &question, job.token()).await?;
    sending.chars += query.chars().count() as u64;
    let asked = answered
        .pop()
        .and_then(vector::prepare)
        .ok_or_else(|| CoreError::ai_invalid_answer(format!("{} returned no embedding for the question", embedder.label)))?;
    // The linear scan reads the whole index: off the async threads.
    let core = core.clone();
    tokio::task::spawn_blocking(move || index::scores(&core, id, &asked)).await.map_err(|error| CoreError::unknown(format!("The search stopped: {error}")))?
}
