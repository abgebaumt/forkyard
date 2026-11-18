//! "Compose commits": the local changes as units, the AI provider's grouping
//! and the commits created from a plan under one undo entry.

mod apply;
mod deps;
mod prompt;
mod units;

#[cfg(test)]
mod apply_tests;
#[cfg(test)]
mod deps_tests;
#[cfg(test)]
mod hook_tests;
#[cfg(test)]
mod proposal_tests;
#[cfg(test)]
mod steering_tests;
#[cfg(test)]
mod undo_tests;
#[cfg(test)]
mod units_tests;

use crate::ai::context::Built;
use crate::ai::run;
use crate::app::Core;
use crate::error::CoreResult;
use crate::model::{AiFeature, ComposeKeep, ComposePlan, ComposeProposal, ComposeResult, ComposeState, Settings};

/// The changes between HEAD and the working directory as units. Reads only; no AI.
pub async fn compose_units(core: &Core, repo_id: String) -> CoreResult<ComposeState> {
    Ok(units::read(core, &repo_id).await?.state())
}

/// Creates the planned commits under one undo entry. `expect_token`: from the units the plan was
/// made on (`stale_state` otherwise). Job `job_id`: phase "compose", line "<n>/<total>",
/// cancellable between two commits.
pub async fn compose_apply(
    core: &Core,
    repo_id: String,
    job_id: String,
    plan: ComposePlan,
    expect_token: String,
) -> CoreResult<ComposeResult> {
    let job = core.start_job(&job_id, Some(&repo_id))?;
    let result = core.with_write_lock(&repo_id, &apply::CHANGES, apply::apply(core, &repo_id, &job, &plan, &expect_token)).await;
    job.finish(&result);
    result
}

/// The AI provider's grouping of the units (`AiFeature::Compose`). The UI asks with
/// `ai_preview(…, AiInput::Compose { instruction, keep }, …)` and the confirmation gate first; this
/// builds exactly that text. `instruction`: the user's words for a new proposal; `keep`: units the
/// user placed – the answer leaves them out, so they stay where they are.
pub async fn compose_proposal(
    core: &Core,
    repo_id: String,
    job_id: String,
    locale: String,
    instruction: Option<String>,
    keep: Vec<ComposeKeep>,
) -> CoreResult<ComposeProposal> {
    let frame = run::ask(core, &repo_id, AiFeature::Compose).await?;
    let steering = prompt::Steering { instruction, keep };
    let built = prompt::build(core, &repo_id, &frame.settings, frame.budget, &locale, &frame.secrets, &steering).await?;
    let answer = frame.send(core, &job_id, &built.built.prompt, &prompt::answer_schema()).await?;
    let (groups, notes) = prompt::groups_from_answer(&answer.value, &built.aliases, &built.kept)?;
    Ok(ComposeProposal { state: built.read.state(), groups, notes })
}

/// `ai_preview` with `AiInput::Compose`: the text `compose_proposal` sends, without sending.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn preview_built(
    core: &Core,
    repo_id: &str,
    settings: &Settings,
    budget_tokens: u64,
    locale: &str,
    secrets: &[String],
    instruction: Option<String>,
    keep: Vec<ComposeKeep>,
) -> CoreResult<Built> {
    let steering = prompt::Steering { instruction, keep };
    Ok(prompt::build(core, repo_id, settings, budget_tokens, locale, secrets, &steering).await?.built)
}
