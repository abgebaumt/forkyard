//! The `Provider` trait: one implementation per API/local provider (Teilpaket 1b adds the
//! command-line providers). No streaming; every call takes the job's cancel token and returns
//! as soon as it fires (`http::send_cancellable`).

use std::future::Future;
use std::pin::Pin;
use std::time::Duration;

use serde_json::Value;

use crate::app::Core;
use crate::error::{CoreError, CoreResult};
use crate::jobs::CancelToken;
use crate::model::{AiModelInfo, AiPrice, AiProviderKind};

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

/// One request: system text and user text (from `prompt::Prompt`) and the answer schema.
#[derive(Debug, Clone)]
pub struct CompletionRequest {
    pub system: String,
    pub user: String,
    /// In the dialect of `ai::schema`.
    pub schema: Value,
    pub max_output_tokens: u32,
    /// Time limit of this attempt.
    pub timeout: Duration,
    /// Quick small task (Anthropic: `effort: "low"`).
    pub small_task: bool,
    /// For the log entry of the HTTP call.
    pub repo_id: Option<String>,
    /// chars / 3.5 of system + user.
    pub estimated_input_tokens: u64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Finish {
    Complete,
    /// Cut off at the output limit; `run` asks once more with a higher limit.
    MaxTokens,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Completion {
    /// The answer text (JSON as text; `run` parses and validates it).
    pub text: String,
    pub finish: Finish,
    pub usage: Usage,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProviderCaps {
    pub structured_output: bool,
    pub embeddings: bool,
    pub max_context_tokens: Option<u64>,
    /// Built-in price of the model, if known (own prices: `pricing::price_for`).
    pub pricing: Option<AiPrice>,
}

pub trait Provider: Send + Sync {
    fn id(&self) -> AiProviderKind;
    /// Name in messages and in the activity log ("Anthropic", "LM Studio").
    fn label(&self) -> String;
    fn capabilities(&self) -> ProviderCaps;
    fn complete<'a>(&'a self, core: &'a Core, request: &'a CompletionRequest, cancel: &'a CancelToken) -> BoxFuture<'a, CoreResult<Completion>>;
    fn models<'a>(&'a self, core: &'a Core, cancel: &'a CancelToken) -> BoxFuture<'a, CoreResult<Vec<AiModelInfo>>>;
    /// Embeddings for the semantic search; built per provider by 9.2.
    fn embed<'a>(&'a self, core: &'a Core, texts: &'a [String], cancel: &'a CancelToken) -> BoxFuture<'a, CoreResult<Vec<Vec<f32>>>> {
        let _ = (core, texts, cancel);
        Box::pin(async { Err(CoreError::unsupported("This provider offers no embeddings in this version.")) })
    }
    /// Cost the provider reported itself for the requests made through this instance (the
    /// command-line tools, spec 1.5), in micro-USD; read once after the request. `None` = nothing
    /// reported – API providers are priced by `ai::pricing`.
    fn take_reported_cost_micros(&self) -> Option<i64> {
        None
    }
}
