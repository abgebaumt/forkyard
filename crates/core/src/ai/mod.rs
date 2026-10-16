//! AI connection of the core (v1.2): providers, context, preview, costs, confirmation gate.
//!
//! - One provider for every function and profile (`Settings.ai_provider`, global); keys only in
//!   the keychain under `llm:<provider>` – never `ai:`, because `forget_removed_ai_keys` deletes
//!   `ai:anthropic:*` at startup.
//! - What a model answers is data: parsed and checked against a fixed schema (`schema`), never run.
//! - Repository content is filtered (`ignore`, `context`), redacted and put between delimiters with
//!   a random token per request (`prompt`).
//! - No streaming; every request is a cancellable job (`run`).

pub mod commit_message;
pub mod context;
pub mod gate;
pub mod ignore;
pub mod language;
pub mod pricing;
pub mod prompt;
pub mod provider;
pub mod providers;
pub mod run;
pub mod cli;
pub mod detect;
pub mod schema;

use std::collections::HashMap;
use std::time::Duration;

use parking_lot::Mutex;

use crate::app::Core;
use crate::model::{AiFeature, AiProviderKind, AiState, Settings};

/// Keychain accounts of AI keys: `llm:<provider>`, global (no profile ID).
pub const KEY_PREFIX: &str = "llm:";
/// `app_settings` key of the one-time notice after the update to 1.2 (set by the upgrade step only).
pub const INTRO_PENDING_KEY: &str = "ai.introPending";

/// Development switches (debug builds only): another address per provider (local mocks).
pub const BASE_URL_ENVS: [(AiProviderKind, &str); 6] = [
    (AiProviderKind::Anthropic, "FORKYARD_AI_BASE_URL_ANTHROPIC"),
    (AiProviderKind::Openai, "FORKYARD_AI_BASE_URL_OPENAI"),
    (AiProviderKind::OpenaiCompatible, "FORKYARD_AI_BASE_URL_OPENAI_COMPATIBLE"),
    (AiProviderKind::Gemini, "FORKYARD_AI_BASE_URL_GEMINI"),
    (AiProviderKind::Ollama, "FORKYARD_AI_BASE_URL_OLLAMA"),
    (AiProviderKind::Lmstudio, "FORKYARD_AI_BASE_URL_LMSTUDIO"),
];

pub fn key_account(kind: AiProviderKind) -> String {
    format!("{KEY_PREFIX}{}", kind.as_str())
}

pub fn state_of(settings: &Settings) -> AiState {
    match settings.ai_enabled {
        None => AiState::Unset,
        Some(false) => AiState::Off,
        Some(true) => AiState::On,
    }
}

#[derive(Default)]
struct BaseOverrides {
    map: Mutex<HashMap<AiProviderKind, String>>,
}

/// Another address for a provider (tests, development build); `None` removes the override.
pub fn configure_base(core: &Core, kind: AiProviderKind, base: Option<String>) {
    let state = core.state::<BaseOverrides>();
    let mut map = state.map.lock();
    match base.map(|base| base.trim().trim_end_matches('/').to_string()).filter(|base| !base.is_empty()) {
        Some(base) => {
            map.insert(kind, base);
        }
        None => {
            map.remove(&kind);
        }
    }
}

/// Where the provider is called: override, then `Settings.ai_base_url` (only for providers with
/// an own address), then the default. `None`: the compatible service has no address yet.
pub fn base_url_for(core: &Core, kind: AiProviderKind, settings: &Settings) -> Option<String> {
    if let Some(base) = core.state::<BaseOverrides>().map.lock().get(&kind).cloned() {
        return Some(base);
    }
    if kind.uses_base_url() {
        if let Some(base) = settings.ai_base_url.clone() {
            return Some(base);
        }
    }
    let default = kind.default_base();
    (!default.is_empty()).then(|| default.to_string())
}

/// Whether requests stay on this computer: a local provider (Ollama, LM Studio) whose resolved
/// address is a loopback host. Grundregel 4 skips the first-use and per-repository confirmation
/// only then; `is_local` alone says "no price", not "no data leaves the machine".
pub fn runs_on_this_computer(core: &Core, kind: AiProviderKind, settings: &Settings) -> bool {
    kind.is_local() && base_url_for(core, kind, settings).is_some_and(|base| crate::http::Target::parse(&base).is_ok_and(|target| target.loopback))
}

impl AiProviderKind {
    pub const ALL: [AiProviderKind; 9] = [
        AiProviderKind::Anthropic,
        AiProviderKind::Openai,
        AiProviderKind::OpenaiCompatible,
        AiProviderKind::Gemini,
        AiProviderKind::Ollama,
        AiProviderKind::Lmstudio,
        AiProviderKind::ClaudeCode,
        AiProviderKind::Codex,
        AiProviderKind::Opencode,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            AiProviderKind::Anthropic => "anthropic",
            AiProviderKind::Openai => "openai",
            AiProviderKind::OpenaiCompatible => "openai_compatible",
            AiProviderKind::Gemini => "gemini",
            AiProviderKind::Ollama => "ollama",
            AiProviderKind::Lmstudio => "lmstudio",
            AiProviderKind::ClaudeCode => "claude_code",
            AiProviderKind::Codex => "codex",
            AiProviderKind::Opencode => "opencode",
        }
    }

    /// Name in messages and in the activity log (English, like every core message).
    pub fn label(self) -> &'static str {
        match self {
            AiProviderKind::Anthropic => "Anthropic",
            AiProviderKind::Openai => "OpenAI",
            AiProviderKind::OpenaiCompatible => "OpenAI-compatible service",
            AiProviderKind::Gemini => "Gemini",
            AiProviderKind::Ollama => "Ollama",
            AiProviderKind::Lmstudio => "LM Studio",
            AiProviderKind::ClaudeCode => "Claude Code",
            AiProviderKind::Codex => "Codex",
            AiProviderKind::Opencode => "opencode",
        }
    }

    /// A provider that usually runs on this computer: no costs. Whether it really does (and may
    /// skip confirmations) depends on its address, see `runs_on_this_computer`.
    pub fn is_local(self) -> bool {
        matches!(self, AiProviderKind::Ollama | AiProviderKind::Lmstudio)
    }

    pub fn needs_key(self) -> bool {
        matches!(self, AiProviderKind::Anthropic | AiProviderKind::Openai | AiProviderKind::Gemini)
    }

    pub fn accepts_key(self) -> bool {
        self.needs_key() || self == AiProviderKind::OpenaiCompatible
    }

    pub fn uses_base_url(self) -> bool {
        matches!(self, AiProviderKind::OpenaiCompatible | AiProviderKind::Ollama | AiProviderKind::Lmstudio)
    }

    /// Default address including the API version segment; empty: none (compatible service).
    pub fn default_base(self) -> &'static str {
        match self {
            AiProviderKind::Anthropic => "https://api.anthropic.com/v1",
            AiProviderKind::Openai => "https://api.openai.com/v1",
            AiProviderKind::OpenaiCompatible => "",
            AiProviderKind::Gemini => "https://generativelanguage.googleapis.com/v1beta",
            AiProviderKind::Ollama => "http://127.0.0.1:11434",
            AiProviderKind::Lmstudio => "http://127.0.0.1:1234/v1",
            AiProviderKind::ClaudeCode | AiProviderKind::Codex | AiProviderKind::Opencode => "",
        }
    }

    /// A command-line tool with its own sign-in (Teilpaket 1b, `ai::cli`).
    pub fn is_cli(self) -> bool {
        matches!(self, AiProviderKind::ClaudeCode | AiProviderKind::Codex | AiProviderKind::Opencode)
    }

    /// The program name the tool is searched by; `None` for API and local providers.
    pub fn tool_name(self) -> Option<&'static str> {
        match self {
            AiProviderKind::ClaudeCode => Some("claude"),
            AiProviderKind::Codex => Some("codex"),
            AiProviderKind::Opencode => Some("opencode"),
            _ => None,
        }
    }
}

impl AiFeature {
    pub const ALL: [AiFeature; 11] = [
        AiFeature::CommitMessage,
        AiFeature::PrDescription,
        AiFeature::Compose,
        AiFeature::ConflictIntent,
        AiFeature::PushReview,
        AiFeature::Plan,
        AiFeature::Archaeology,
        AiFeature::ReleaseNotes,
        AiFeature::BisectScript,
        AiFeature::SemanticSearch,
        AiFeature::ReviewFix,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            AiFeature::CommitMessage => "commit_message",
            AiFeature::PrDescription => "pr_description",
            AiFeature::Compose => "compose",
            AiFeature::ConflictIntent => "conflict_intent",
            AiFeature::PushReview => "push_review",
            AiFeature::Plan => "plan",
            AiFeature::Archaeology => "archaeology",
            AiFeature::ReleaseNotes => "release_notes",
            AiFeature::BisectScript => "bisect_script",
            AiFeature::SemanticSearch => "semantic_search",
            AiFeature::ReviewFix => "review_fix",
        }
    }

    /// Name in the activity log: "ai: commit-message (…)".
    pub fn log_name(self) -> &'static str {
        match self {
            AiFeature::CommitMessage => "commit-message",
            AiFeature::PrDescription => "pr-description",
            AiFeature::Compose => "compose",
            AiFeature::ConflictIntent => "conflict-intent",
            AiFeature::PushReview => "push-review",
            AiFeature::Plan => "plan",
            AiFeature::Archaeology => "archaeology",
            AiFeature::ReleaseNotes => "release-notes",
            AiFeature::BisectScript => "bisect-script",
            AiFeature::SemanticSearch => "semantic-search",
            AiFeature::ReviewFix => "review-fix",
        }
    }

    /// Time limit of one request (spec 1.4); command-line providers add 30 s (Teilpaket 1b).
    pub fn timeout(self) -> Duration {
        match self {
            AiFeature::CommitMessage => Duration::from_secs(60),
            AiFeature::Compose | AiFeature::ConflictIntent | AiFeature::PushReview | AiFeature::ReviewFix => Duration::from_secs(180),
            _ => Duration::from_secs(120),
        }
    }

    /// Context budget of the function in tokens; the request gets min(budget, 70 % of the model's context).
    pub fn budget_tokens(self) -> u64 {
        match self {
            AiFeature::CommitMessage => 24_000,
            AiFeature::PrDescription => 32_000,
            AiFeature::Compose => 64_000,
            AiFeature::ConflictIntent => 32_000,
            AiFeature::PushReview => 48_000,
            AiFeature::Plan => 8_000,
            AiFeature::Archaeology => 24_000,
            AiFeature::ReleaseNotes => 32_000,
            AiFeature::BisectScript => 16_000,
            AiFeature::SemanticSearch => 16_000,
            AiFeature::ReviewFix => 24_000,
        }
    }

    pub fn max_output_tokens(self) -> u32 {
        match self {
            AiFeature::CommitMessage | AiFeature::Plan | AiFeature::SemanticSearch => 1_024,
            AiFeature::Compose => 8_192,
            _ => 4_096,
        }
    }

    /// Small, quick tasks: Anthropic gets `effort: "low"`.
    pub fn small_task(self) -> bool {
        matches!(self, AiFeature::CommitMessage | AiFeature::Plan | AiFeature::SemanticSearch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{AiFeature, AiProviderKind, AiState, Settings};
    use std::time::Duration;

    #[test]
    fn the_state_follows_the_master_switch() {
        let mut settings = Settings::default();
        assert_eq!(state_of(&settings), AiState::Unset);
        settings.ai_enabled = Some(false);
        assert_eq!(state_of(&settings), AiState::Off);
        settings.ai_enabled = Some(true);
        assert_eq!(state_of(&settings), AiState::On);
    }

    #[test]
    fn time_limits_per_function_follow_the_spec() {
        assert_eq!(AiFeature::CommitMessage.timeout(), Duration::from_secs(60));
        for feature in [AiFeature::Compose, AiFeature::ConflictIntent, AiFeature::PushReview, AiFeature::ReviewFix] {
            assert_eq!(feature.timeout(), Duration::from_secs(180), "{feature:?}");
        }
        for feature in [AiFeature::PrDescription, AiFeature::Plan, AiFeature::Archaeology, AiFeature::ReleaseNotes, AiFeature::BisectScript, AiFeature::SemanticSearch] {
            assert_eq!(feature.timeout(), Duration::from_secs(120), "{feature:?}");
        }
    }

    #[test]
    fn keys_live_under_llm_never_under_ai() {
        assert_eq!(key_account(AiProviderKind::Anthropic), "llm:anthropic");
        assert_eq!(key_account(AiProviderKind::OpenaiCompatible), "llm:openai_compatible");
        for kind in AiProviderKind::ALL {
            assert!(key_account(kind).starts_with("llm:") && !key_account(kind).starts_with("ai:"), "{kind:?}");
        }
    }

    #[test]
    fn names_match_the_wire_format() {
        for kind in AiProviderKind::ALL {
            assert_eq!(serde_json::to_value(kind).unwrap(), kind.as_str());
        }
        for feature in AiFeature::ALL {
            assert_eq!(serde_json::to_value(feature).unwrap(), feature.as_str());
            assert_eq!(feature.log_name(), feature.as_str().replace('_', "-"));
        }
        assert_eq!(AiFeature::ALL.len(), 11);
    }

    #[test]
    fn only_local_providers_skip_keys() {
        assert!(AiProviderKind::Ollama.is_local() && AiProviderKind::Lmstudio.is_local());
        assert!(!AiProviderKind::Ollama.accepts_key() && !AiProviderKind::Lmstudio.accepts_key());
        assert!(AiProviderKind::OpenaiCompatible.accepts_key() && !AiProviderKind::OpenaiCompatible.needs_key(), "company proxies may need no key");
        for kind in [AiProviderKind::Anthropic, AiProviderKind::Openai, AiProviderKind::Gemini] {
            assert!(kind.needs_key() && !kind.is_local(), "{kind:?}");
        }
        assert_eq!(AiProviderKind::Ollama.default_base(), "http://127.0.0.1:11434");
        assert_eq!(AiProviderKind::Lmstudio.default_base(), "http://127.0.0.1:1234/v1");
        assert_eq!(AiProviderKind::OpenaiCompatible.default_base(), "");
    }

    #[tokio::test]
    async fn the_address_override_wins_over_settings_and_default() {
        let tc = crate::testkit::TestCore::new().await;
        let mut settings = Settings::default();
        assert_eq!(base_url_for(&tc, AiProviderKind::Anthropic, &settings).as_deref(), Some("https://api.anthropic.com/v1"));
        assert_eq!(base_url_for(&tc, AiProviderKind::OpenaiCompatible, &settings), None, "the compatible service needs an address");
        settings.ai_base_url = Some("https://llm.firma.example/v1".into());
        assert_eq!(base_url_for(&tc, AiProviderKind::OpenaiCompatible, &settings).as_deref(), Some("https://llm.firma.example/v1"));
        assert_eq!(base_url_for(&tc, AiProviderKind::Anthropic, &settings).as_deref(), Some("https://api.anthropic.com/v1"), "the setting is not for fixed providers");
        configure_base(&tc, AiProviderKind::Anthropic, Some("http://127.0.0.1:9/v1/".into()));
        assert_eq!(base_url_for(&tc, AiProviderKind::Anthropic, &settings).as_deref(), Some("http://127.0.0.1:9/v1"));
        configure_base(&tc, AiProviderKind::Anthropic, None);
        assert_eq!(base_url_for(&tc, AiProviderKind::Anthropic, &settings).as_deref(), Some("https://api.anthropic.com/v1"));
    }

    #[test]
    fn command_line_tools_take_no_key_no_address_and_no_price() {
        let cli = [AiProviderKind::ClaudeCode, AiProviderKind::Codex, AiProviderKind::Opencode];
        assert_eq!(AiProviderKind::ALL.iter().copied().filter(|kind| kind.is_cli()).collect::<Vec<_>>(), cli);
        let settings = Settings {
            ai_prices: vec![crate::model::AiPriceOverride { model: "sonnet".into(), input_usd_per_mtok: 3.0, output_usd_per_mtok: 15.0 }],
            ..Settings::default()
        };
        for kind in cli {
            assert!(!kind.is_local() && !kind.needs_key() && !kind.accepts_key() && !kind.uses_base_url(), "{kind:?}");
            assert_eq!(kind.default_base(), "");
            assert!(crate::ai::pricing::price_for(&settings, kind, "sonnet").is_none(), "billed through the tool (spec 1.5): {kind:?}");
        }
        assert_eq!(cli.map(AiProviderKind::tool_name), [Some("claude"), Some("codex"), Some("opencode")]);
        assert_eq!(cli.map(|kind| serde_json::to_value(kind).unwrap()), [serde_json::json!("claude_code"), serde_json::json!("codex"), serde_json::json!("opencode")]);
        assert_eq!(cli.map(AiProviderKind::label), ["Claude Code", "Codex", "opencode"]);
        assert!(AiProviderKind::ALL.iter().filter(|kind| !kind.is_cli()).all(|kind| kind.tool_name().is_none()));
        assert_eq!(cli.map(crate::ai::providers::default_context), [200_000, 128_000, 32_000]);
    }

    #[tokio::test]
    async fn command_line_tools_have_no_address() {
        let tc = crate::testkit::TestCore::new().await;
        let settings = Settings { ai_base_url: Some("https://llm.firma.example/v1".into()), ..Settings::default() };
        for kind in [AiProviderKind::ClaudeCode, AiProviderKind::Codex, AiProviderKind::Opencode] {
            assert_eq!(base_url_for(&tc, kind, &settings), None, "{kind:?}");
        }
    }
}
