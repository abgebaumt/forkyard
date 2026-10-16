//! "Git in plain language" (v1.2, Paket 5): a sentence in the command palette becomes a plan of
//! allowed Forkyard steps (`ai_plan`), the user edits it (`ai_plan_check`) and runs it
//! (`ai_plan_run`). The logic lives in `ai::plan`, `ai::plan_check`, `ai::plan_commands` and
//! `ai::plan_run`.

use crate::ai::{plan, plan_check, plan_commands, plan_run, run};
use crate::app::Core;
use crate::error::CoreResult;
use crate::model::{AiFeature, PlanPreview, PlanRunResult, PlanStep};

/// A sentence → a checked plan of allowed steps. The AI request runs as job `job_id`, the check as
/// job `{job_id}:check`; nothing in the repository changes.
pub async fn ai_plan(core: &Core, repo_id: String, job_id: String, text: String, locale: String) -> CoreResult<PlanPreview> {
    let settings = run::ensure_allowed(core, Some(&repo_id), AiFeature::Plan)?;
    // The same budget and known secrets as `ai_preview` for `AiInput::Plan` (Paket 3.1's helper).
    let (budget, secrets) = crate::commands::ai::request_frame(core, &settings, AiFeature::Plan).await;
    let prompt = plan::build_prompt(core, &repo_id, &text, &locale, &secrets, budget).await?;
    let schema = plan_commands::answer_schema();
    let answer = run::complete_json(core, run::AiRequest { repo_id: Some(&repo_id), feature: AiFeature::Plan, job_id: &job_id, prompt: &prompt, schema: &schema }).await?;
    let (steps, note) = plan::parse_steps(&answer.value)?;
    let job = core.start_job(&format!("{job_id}:check"), Some(&repo_id))?;
    let result = plan_check::check(core, &repo_id, &steps, job.token()).await.map(|checked| PlanPreview { note, ..checked.preview });
    job.finish(&result);
    result
}

/// Checks (edited) steps again: arguments, conflicts, expected state. Sends nothing, changes nothing.
pub async fn ai_plan_check(core: &Core, repo_id: String, job_id: String, steps: Vec<PlanStep>) -> CoreResult<PlanPreview> {
    core.repo_path(&repo_id)?;
    let job = core.start_job(&job_id, Some(&repo_id))?;
    let result = plan_check::check(core, &repo_id, &steps, job.token()).await.map(|checked| checked.preview);
    job.finish(&result);
    result
}

/// Runs a checked plan step by step (job `job_id`). `confirmed`: the indexes of the outward steps
/// the user confirmed one by one. `stale_state` when `expect` no longer holds; the result names
/// every step as done, failed or not run.
pub async fn ai_plan_run(core: &Core, repo_id: String, job_id: String, text: String, steps: Vec<PlanStep>, expect: String, confirmed: Vec<u32>) -> CoreResult<PlanRunResult> {
    core.repo_path(&repo_id)?;
    let job = core.start_job(&job_id, Some(&repo_id))?;
    let result = plan_run::run(core, &repo_id, &job, &text, &steps, &expect, &confirmed).await;
    job.finish(&result);
    result
}

#[cfg(test)]
mod check_tests;

#[cfg(test)]
mod ai_tests;

#[cfg(test)]
mod run_tests;
