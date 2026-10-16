//! "Git in plain language" (v1.2, Paket 5): a sentence in the command palette becomes a plan of
//! allowed Forkyard steps (`ai_plan`), the user edits it (`ai_plan_check`) and runs it
//! (`ai_plan_run`). The logic lives in `ai::plan`, `ai::plan_check`, `ai::plan_commands` and
//! `ai::plan_run`.

use crate::ai::plan_check;
use crate::app::Core;
use crate::error::CoreResult;
use crate::model::{PlanPreview, PlanStep};

/// Checks (edited) steps again: arguments, conflicts, expected state. Sends nothing, changes nothing.
pub async fn ai_plan_check(core: &Core, repo_id: String, job_id: String, steps: Vec<PlanStep>) -> CoreResult<PlanPreview> {
    core.repo_path(&repo_id)?;
    let job = core.start_job(&job_id, Some(&repo_id))?;
    let result = plan_check::check(core, &repo_id, &steps, job.token()).await.map(|checked| checked.preview);
    job.finish(&result);
    result
}

#[cfg(test)]
mod check_tests;
