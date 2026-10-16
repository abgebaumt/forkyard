//! "Compose commits" (v1.2, Teilpaket 3.2): the local changes as units, the AI provider's grouping
//! and the commits created from a plan under one undo entry.

mod apply;
mod units;

#[cfg(test)]
mod units_tests;
#[cfg(test)]
mod apply_tests;
#[cfg(test)]
mod hook_tests;

use crate::app::Core;
use crate::error::CoreResult;
use crate::model::{ComposePlan, ComposeResult, ComposeState};

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
