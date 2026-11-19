//! AI

use super::*;

/// Default of `Settings.ai_confirm_cost_usd`: ask before a request estimated above 0.10 USD.
pub const DEFAULT_AI_CONFIRM_COST_USD: f64 = 0.10;

pub(super) fn default_ai_confirm_cost() -> f64 {
    DEFAULT_AI_CONFIRM_COST_USD
}

/// AI provider (`Settings.ai_provider`, one for every function and profile). The command-line
/// tools (`ClaudeCode`, `Codex`, `Opencode`) use the sign-in the user already has; Forkyard stores
/// nothing of it (`ai::cli`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "ai.ts"))]
#[serde(rename_all = "snake_case")]
pub enum AiProviderKind {
    Anthropic,
    Openai,
    /// Own address speaking the OpenAI chat-completions protocol (OpenRouter, Mistral, Groq, company proxy).
    OpenaiCompatible,
    Gemini,
    /// Local, native API (`/api/chat`), default `http://127.0.0.1:11434`.
    Ollama,
    /// Local, OpenAI protocol, default `http://127.0.0.1:1234/v1`.
    Lmstudio,
    /// Claude Code (`claude -p`), signed in by the user.
    ClaudeCode,
    /// Codex (`codex exec`), signed in by the user.
    Codex,
    /// opencode (`opencode run`), with the providers the user signed in to.
    Opencode,
}

/// An AI function; each one can be switched off (`Settings.ai_features_off`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "ai.ts"))]
#[serde(rename_all = "snake_case")]
pub enum AiFeature {
    CommitMessage,
    PrDescription,
    Compose,
    ConflictIntent,
    PushReview,
    Plan,
    Archaeology,
    ReleaseNotes,
    BisectScript,
    SemanticSearch,
    ReviewFix,
    /// Where to cut a branch into stacked pull requests.
    StackSplit,
}

/// From `Settings.ai_enabled`: `None` = `Unset` (never set up, never turned off), `Some(false)` =
/// `Off` (turned off on purpose), `Some(true)` = `On`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "ai.ts"))]
#[serde(rename_all = "snake_case")]
pub enum AiState {
    Unset,
    Off,
    On,
}

/// Own price for a model (USD per million tokens); wins over the built-in table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "ai.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AiPriceOverride {
    pub model: String,
    pub input_usd_per_mtok: f64,
    pub output_usd_per_mtok: f64,
}

/// Why a file of the context is not sent (completely) – shown in "What is sent?".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "ai.ts"))]
#[serde(rename_all = "snake_case")]
pub enum AiOmitReason {
    /// Looks like a secret (`.env*`, keys, keystores): never sent, not even the name.
    Secret,
    /// Matched by `.forkyard/ai-ignore` or the global list: never sent, not even the name.
    Ignored,
    /// Lock file or generated file: only name and size.
    Generated,
    /// Binary: only name and size.
    Binary,
    /// Too large for the budget: only name and line counts.
    Budget,
}

/// A file of the context that is not sent (completely).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "ai.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AiOmitted {
    pub path: String,
    pub reason: AiOmitReason,
    /// Bytes in the index (0 if unknown).
    pub size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "ai.ts"))]
#[serde(rename_all = "snake_case")]
pub enum AiPriceSource {
    /// From Forkyard's table (`as_of` names its date).
    Builtin,
    /// Entered by the user (`Settings.ai_prices`).
    Own,
}

/// Price of a model in USD per million tokens.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "ai.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AiPrice {
    pub input_usd_per_mtok: f64,
    pub output_usd_per_mtok: f64,
    pub source: AiPriceSource,
    pub as_of: Option<String>,
}

/// A model of the provider (`ai_models`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "ai.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AiModelInfo {
    pub id: String,
    pub label: String,
    /// Context window in tokens, if the provider says.
    pub context_tokens: Option<u64>,
}

/// How a structured answer is requested: schema enforced by the provider, JSON only, or the
/// schema in the prompt (the core validates in every case).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "ai.ts"))]
#[serde(rename_all = "snake_case")]
pub enum AiStructuredMode {
    JsonSchema,
    JsonObject,
    Prompt,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "ai.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AiModelList {
    pub models: Vec<AiModelInfo>,
    pub structured: AiStructuredMode,
}

/// Why "What is sent?" asks before sending.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "ai.ts"))]
#[serde(rename_all = "snake_case")]
pub enum AiAskTrigger {
    /// First use of this function at all (API providers only).
    FirstUse,
    /// More than 100 000 characters.
    Large,
    /// Estimated cost above `Settings.ai_confirm_cost_usd`.
    Cost,
    /// An API provider gets content of this repository for the first time.
    RepoFirst,
    /// This month's costs reached the limit; never remembered ("send this time").
    Limit,
}

/// `ai_status`: what the UI needs for the visibility of AI elements and Settings › AI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "ai.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub state: AiState,
    pub provider: Option<AiProviderKind>,
    pub model: Option<String>,
    /// Provider, model, address and – where needed – the key are there.
    pub connected: bool,
    /// `…abcd` of the stored key of the chosen provider.
    pub key_hint: Option<String>,
    pub local: bool,
    /// Price of the chosen model (own or built-in); `None` = unknown or local.
    pub price: Option<AiPrice>,
    /// Only in `unset`: the one-time notice after the update to 1.2 is due.
    pub intro_pending: bool,
    pub features_off: Vec<AiFeature>,
}

/// What `ai_preview` builds the text from. Later packages add their own variants.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "ai.ts"))]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AiInput {
    /// The staged diff of the repository.
    StagedChanges,
    /// "Compose commits": every local change since HEAD, as units with aliases (3.2), with the
    /// user's instruction for a new proposal and the units they placed themselves.
    Compose {
        #[serde(default)]
        #[cfg_attr(feature = "ts", ts(optional = nullable))]
        instruction: Option<String>,
        #[serde(default)]
        #[cfg_attr(feature = "ts", ts(optional = nullable))]
        keep: Vec<ComposeKeep>,
    },
    /// Bisect autopilot (9.1): the user's description and test command, the range's commit
    /// subjects, top-level names, build files and changed paths.
    BisectScript(BisectScriptRequest),
    /// The commit message of the staged changes: diff, branch, style examples,
    /// template and own instruction – exactly what `ai_commit_message` sends.
    CommitMessage,
    /// The commits of `source` that `target` does not have (full ref names, e.g.
    /// `refs/heads/feature/x` and `refs/remotes/origin/main`).
    PrDescription { source: String, target: String },
    /// The conflict blocks of one conflicted file, as line ranges of the conflict tool.
    ConflictIntent { path: String, blocks: Vec<ConflictBlockRange> },
    /// What a push with these arguments would send: the outgoing commits and their
    /// combined diff. Same target rules as `push`.
    #[serde(rename_all = "camelCase")]
    OutgoingChanges { branch: Option<String>, remote: Option<String>, remote_branch: Option<String> },
    /// The commits of the release notes (7.2): after `from` (default: the nearest earlier tag,
    /// tags on `to` left out) up to `to` (default `HEAD`), merges left out.
    ReleaseNotes { from: Option<String>, to: Option<String> },
    /// "Git in plain language": the user's sentence.
    Plan { text: String },
    /// One line's history for “Why is this so?”; `sha: None` = working directory.
    Archaeology { path: String, line: u32, sha: Option<String> },
    /// Where to cut `branch` (short or `refs/heads/…`) above `base` (full ref of a branch).
    StackSplit { branch: String, base: String },
    /// 8.2: one review thread of pull request `number`; the core reads thread, pull request and file
    /// itself (`{"kind": "review_fix", "number": 7, "threadId": "…"}`).
    #[serde(rename_all = "camelCase")]
    ReviewFix { number: u64, thread_id: String },
    /// The search by meaning (9.2): the question and – with embeddings – the new index entries.
    SemanticSearch { query: String },
}

/// Kind of a hint of the review before a push. Keys are never a kind: they come from
/// the local secret scan only.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "ai.ts"))]
#[serde(rename_all = "snake_case")]
pub enum AiPushFindingKind {
    DebugOutput,
    CommentedCode,
    LikelyBug,
}

/// One hint of the review before a push; no promise of severity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "ai.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AiPushFinding {
    /// One of the files the model saw.
    pub path: String,
    /// Line in the new version, if the model named one.
    pub line: Option<u32>,
    pub kind: AiPushFindingKind,
    /// Redacted, at most 300 characters.
    pub note: String,
}

/// Result of `ai_push_review`. `commits = 0`: nothing goes out, nothing was sent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "ai.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AiPushReview {
    pub findings: Vec<AiPushFinding>,
    pub commits: u32,
    pub files: u32,
    /// More than `MAX_REVIEW_COMMITS` commits go out: only the newest were reviewed.
    pub partial: bool,
}

/// "What is sent?": the exact text, what is left out, and whether Forkyard asks before sending.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "ai.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AiPreview {
    pub text: String,
    pub omitted: Vec<AiOmitted>,
    /// Shortened to start and end of each hunk.
    pub shortened: Vec<String>,
    pub chars: u64,
    pub estimated_tokens: u64,
    pub estimated_cost_usd: Option<f64>,
    /// Empty: the request goes out without a question (also while AI is not on).
    pub asks: Vec<AiAskTrigger>,
    /// Pass to `ai_preview_confirm`; binds the confirmation to exactly this text.
    pub fingerprint: String,
    pub month_cost_usd: f64,
    pub limit_usd: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "ai.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AiUsageRow {
    pub provider: String,
    pub model: String,
    pub feature: String,
    pub requests: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
}

/// This month's usage (UTC month), numbers only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "ai.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AiUsageSummary {
    pub month: String,
    pub requests: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
    pub rows: Vec<AiUsageRow>,
}
