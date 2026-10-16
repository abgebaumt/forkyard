//! "Compose commits" (v1.2, Teilpaket 3.2): the local changes as units, the AI provider's grouping
//! and the commits created from a plan under one undo entry.

mod units;

#[cfg(test)]
mod units_tests;

use crate::app::Core;
use crate::error::CoreResult;
use crate::model::ComposeState;

/// The changes between HEAD and the working directory as units. Reads only; no AI.
pub async fn compose_units(core: &Core, repo_id: String) -> CoreResult<ComposeState> {
    Ok(units::read(core, &repo_id).await?.state())
}
