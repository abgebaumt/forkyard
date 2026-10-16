//! "Compose commits" (v1.2, Teilpaket 3.2): the local changes as units, the AI provider's grouping
//! and the commits created from a plan under one undo entry.

mod apply;
mod prompt;
mod units;

#[cfg(test)]
mod units_tests;
#[cfg(test)]
mod apply_tests;
#[cfg(test)]
mod hook_tests;
#[cfg(test)]
mod proposal_tests;
#[cfg(test)]
mod undo_tests;

use crate::ai::context::Built;
use crate::ai::run::{self, AiRequest};
use crate::app::Core;
use crate::commands::ai::request_frame;
use crate::error::CoreResult;
use crate::model::{AiFeature, ComposePlan, ComposeProposal, ComposeResult, ComposeState, Settings};

/// The changes between HEAD and the working directory as units. Reads only; no AI.
pub async fn compose_units(core: &Core, repo_id: String) -> CoreResult<ComposeState> {
    Ok(units::read(core, &repo_id).await?.state())
}

/// Creates the planned commits under one undo entry. `expect_token`: from the units the plan was
/// made on (`stale_state` otherwise). Job `job_id`: phase "compose", line "<n>/<total>",
/// cancellable between two commits.
pub async fn compose_apply(core: &Core, repo_id: String, job_id: String, plan: ComposePlan, expect_token: String) -> CoreResult<ComposeResult> {
    let job = core.start_job(&job_id, Some(&repo_id))?;
    let result = core.with_write_lock(&repo_id, &apply::CHANGES, apply::apply(core, &repo_id, &job, &plan, &expect_token)).await;
    job.finish(&result);
    result
}

/// The AI provider's grouping of the units (`AiFeature::Compose`). The UI asks with
/// `ai_preview(…, AiInput::Compose, …)` and the confirmation gate first; this builds exactly that text.
pub async fn compose_proposal(core: &Core, repo_id: String, job_id: String, locale: String) -> CoreResult<ComposeProposal> {
    let settings = run::ensure_allowed(core, Some(&repo_id), AiFeature::Compose)?;
    // The same budget and secrets as `ai_preview` (Paket 3.1's helper), so both build the same text.
    let (budget, secrets) = request_frame(core, &settings, AiFeature::Compose).await;
    let built = prompt::build(core, &repo_id, &settings, budget, &locale, &secrets).await?;
    let schema = prompt::answer_schema();
    let answer = run::complete_json(
        core,
        AiRequest { repo_id: Some(&repo_id), feature: AiFeature::Compose, job_id: &job_id, prompt: &built.built.prompt, schema: &schema },
    )
    .await?;
    let groups = prompt::groups_from_answer(&answer.value, &built.aliases)?;
    Ok(ComposeProposal { state: built.read.state(), groups })
}

/// `ai_preview` with `AiInput::Compose`: the text `compose_proposal` sends, without sending.
pub(crate) async fn preview_built(core: &Core, repo_id: &str, settings: &Settings, budget_tokens: u64, locale: &str, secrets: &[String]) -> CoreResult<Built> {
    Ok(prompt::build(core, repo_id, settings, budget_tokens, locale, secrets).await?.built)
}
