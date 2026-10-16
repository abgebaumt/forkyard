//! `ai_detect` (spec 1.3): which AI tools, local models and keys this computer has – for the setup
//! dialog. The three command-line tools are probed side by side (Paket 0's `tools::locate` with its
//! cached version, then `--help` and the sign-in status in parallel with what is left of two
//! seconds), Ollama and LM Studio are asked on this computer with a 300 ms limit, the keychain is
//! looked into. Nothing is sent. Found programs are remembered (`ai::cli::FOUND_KEY`) and checked
//! again before every use.

use std::time::{Duration, Instant};

use serde_json::Value;

use crate::ai::cli;
use crate::app::Core;
use crate::error::CoreResult;
use crate::http::{self, Request};
use crate::model::{AiCliFound, AiDetection, AiLocalFound, AiLoginState, AiProviderKind, Settings, ToolSource};

/// Spec 1.3: „Gesamtdauer ≤ 2 s“.
pub const DETECT_BUDGET: Duration = Duration::from_secs(2);
/// Every probe gets at least this long, also when the budget is used up.
const MIN_PROBE: Duration = Duration::from_millis(300);
/// Spec 1.3: local services with `quick(300 ms, 0)`.
const LOCAL_LIMIT: Duration = Duration::from_millis(300);
const KEY_PROVIDERS: [AiProviderKind; 4] = [AiProviderKind::Anthropic, AiProviderKind::Openai, AiProviderKind::OpenaiCompatible, AiProviderKind::Gemini];

pub async fn detect(core: &Core) -> CoreResult<AiDetection> {
    let started = Instant::now();
    let settings = core.settings()?;
    let (claude, codex, opencode, local, keys) = tokio::join!(
        detect_cli(core, AiProviderKind::ClaudeCode, &settings, started),
        detect_cli(core, AiProviderKind::Codex, &settings, started),
        detect_cli(core, AiProviderKind::Opencode, &settings, started),
        detect_local(core),
        stored_keys(core),
    );
    Ok(AiDetection { clis: [claude, codex, opencode].into_iter().flatten().collect(), local, keys, elapsed_ms: started.elapsed().as_millis() as u64 })
}

async fn detect_cli(core: &Core, kind: AiProviderKind, settings: &Settings, started: Instant) -> Option<AiCliFound> {
    let configured = cli::configured_path(settings, kind);
    if let Some(own) = configured.as_ref().filter(|path| !path.is_file()) {
        return Some(AiCliFound {
            provider: kind,
            path: own.to_string_lossy().into_owned(),
            version: None,
            source: ToolSource::Configured,
            login: AiLoginState::Unknown,
            login_method: None,
            uses_env_key: false,
            supported: false,
            problem: Some("The program set in Settings › AI does not exist.".to_string()),
            login_command: cli::login_command(kind),
        });
    }
    let info = cli::locate_cli(core, kind, configured.as_deref()).await?;
    if let Err(e) = cli::remember(core, kind, &info.path) {
        log::warn!("Found {} not remembered: {}", kind.label(), e.message);
    }
    let left = DETECT_BUDGET.saturating_sub(started.elapsed()).max(MIN_PROBE);
    let (caps, login) = tokio::join!(cli::caps(core, kind, &info.path, info.version.as_deref(), left), cli::login_status(core, kind, &info.path, left));
    Some(AiCliFound {
        provider: kind,
        path: info.path.to_string_lossy().into_owned(),
        version: info.version.clone(),
        source: info.source,
        login: login.state,
        login_method: login.method,
        uses_env_key: cli::env_key_present(kind, |name| std::env::var_os(name)),
        supported: caps.supported(),
        problem: caps.problem(kind),
        login_command: cli::login_command(kind),
    })
}

async fn detect_local(core: &Core) -> Vec<AiLocalFound> {
    let (ollama, lmstudio) = tokio::join!(probe_local(core, AiProviderKind::Ollama), probe_local(core, AiProviderKind::Lmstudio));
    [ollama, lmstudio].into_iter().flatten().collect()
}

/// The default address (or the development override), not `Settings.ai_base_url`: that one belongs
/// to the chosen provider.
async fn probe_local(core: &Core, kind: AiProviderKind) -> Option<AiLocalFound> {
    let base = crate::ai::base_url_for(core, kind, &Settings::default())?;
    let url = if kind == AiProviderKind::Ollama { format!("{base}/api/tags") } else { format!("{base}/models") };
    let response = http::send(core, Request::get(url, kind.label()).quick(LOCAL_LIMIT, 0)).await.ok()?;
    if !response.is_success() {
        return None;
    }
    let value: Value = serde_json::from_slice(&response.body).ok()?;
    let (list, field) = if kind == AiProviderKind::Ollama { ("models", "name") } else { ("data", "id") };
    let models = value.get(list).and_then(Value::as_array).into_iter().flatten().filter_map(|entry| entry.get(field).and_then(Value::as_str)).map(str::to_string).collect();
    Some(AiLocalFound { provider: kind, base_url: base, models })
}

async fn stored_keys(core: &Core) -> Vec<AiProviderKind> {
    let mut found = Vec::new();
    for kind in KEY_PROVIDERS {
        if crate::secrets::get(core, &crate::ai::key_account(kind)).await.ok().flatten().is_some() {
            found.push(kind);
        }
    }
    found
}

/// At app start, in the background: reads the login shell's PATH once (spec 1.3), so the setup
/// does not wait for it.
pub async fn warm_up(core: &Core) {
    let _ = crate::tools::locate::login_shell_path(core).await;
}
