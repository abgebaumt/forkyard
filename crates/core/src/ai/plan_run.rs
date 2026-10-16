//! Running a checked plan (spec Paket 5): the expected state must still hold (checked again inside
//! the write lock before step 1), every outward step must be confirmed on its own, then the steps
//! run one after another through their existing commands (each takes the write lock itself), and
//! the first error ends the plan. Before step 1 the working directory and index are backed up and
//! the refs the steps may move are noted; at the end the steps' own undo entries give way to one
//! group entry `plan`, so one Mod+Z brings back the local state before step 1. Pushed refs stay
//! pushed – the label says so.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::future::Future;

use serde_json::{json, Map};

use crate::ai::plan_check::{self, Checked};
use crate::ai::plan_commands::{self, PlanAction};
use crate::app::Core;
use crate::commands::refs;
use crate::db;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::jobs::{CancelToken, Job};
use crate::model::{Head, PlanClass, PlanRunResult, PlanStep, PlanStepOutcome, PlanStepStatus, RepoChange};
use crate::undo::{self, GroupRecord, GroupSnapshot, RefMove, UndoAction};

fn expired() -> CoreError {
    CoreError::new(ErrorCode::StaleState, "The repository changed since the plan was shown. The plan has expired; ask again.")
}

struct Start {
    entry: String,
    head: Head,
    snapshot: GroupSnapshot,
    before: BTreeMap<String, Option<String>>,
    /// Undo entries that existed before step 1.
    known: HashSet<String>,
}

pub async fn run(core: &Core, repo_id: &str, job: &Job, text: &str, steps: &[PlanStep], expect: &str, confirmed: &[u32]) -> CoreResult<PlanRunResult> {
    let Checked { preview, actions, touched, seen } = plan_check::check(core, repo_id, steps, job.token()).await?;
    if preview.expect != expect {
        return Err(expired());
    }
    if !preview.runnable {
        return Err(CoreError::not_allowed("Some steps of this plan cannot run. Edit or remove them first."));
    }
    for (index, view) in preview.steps.iter().enumerate() {
        if view.class == PlanClass::Outward && !confirmed.contains(&(index as u32)) {
            return Err(CoreError::not_allowed(format!("Step {} goes out to the remote and needs its own confirmation.", index + 1)));
        }
    }
    let actions: Vec<PlanAction> = actions.into_iter().flatten().collect();
    let start = begin(core, repo_id, steps, expect, &seen, &touched).await?;

    let total = actions.len();
    let mut outcomes: Vec<PlanStepOutcome> = Vec::with_capacity(total);
    let mut stopped: Option<bool> = None; // Some(cancelled?)
    for (index, action) in actions.iter().enumerate() {
        let index32 = index as u32;
        if stopped.is_none() && job.token().is_cancelled() {
            stopped = Some(true);
        }
        if stopped.is_some() {
            outcomes.push(PlanStepOutcome { index: index32, status: PlanStepStatus::NotRun, error: None });
            continue;
        }
        job.progress("plan", Some((index * 100 / total.max(1)) as u32), &format!("{}/{}", index + 1, total));
        let step_job = format!("{}:{index}", job.id());
        match follow_cancel(core, job.token(), &step_job, plan_commands::execute(core, repo_id, &step_job, action)).await {
            Ok(()) => outcomes.push(PlanStepOutcome { index: index32, status: PlanStepStatus::Done, error: None }),
            Err(error) => {
                stopped = Some(error.code == ErrorCode::Cancelled);
                outcomes.push(PlanStepOutcome { index: index32, status: PlanStepStatus::Failed, error: Some(error) });
            }
        }
    }
    let done: Vec<&PlanAction> = actions.iter().zip(&outcomes).filter(|(_, o)| o.status == PlanStepStatus::Done).map(|(a, _)| a).collect();
    let pushed = done.iter().any(|action| action.class() == PlanClass::Outward);
    let stashed = done.iter().any(|action| matches!(action, PlanAction::StashCreate { .. }));
    let undo_recorded = finish(core, repo_id, start, &touched, text, done.len(), pushed, stashed).await?;
    Ok(PlanRunResult { steps: outcomes, undo_recorded, completed: stopped.is_none(), cancelled: stopped == Some(true) })
}

/// Snapshot and "before" refs, after checking the expected state once more inside the write lock.
async fn begin(core: &Core, repo_id: &str, steps: &[PlanStep], expect: &str, seen: &BTreeMap<String, String>, touched: &BTreeSet<String>) -> CoreResult<Start> {
    core.with_write_lock(repo_id, &[], async {
        if plan_check::expect_token(core, repo_id, steps, seen).await? != expect {
            return Err(expired());
        }
        let entry = undo::new_id();
        let head = refs::read_head(core, repo_id).await?;
        let snapshot = undo::snapshot_for_group(core, repo_id, &entry).await?;
        let mut before = BTreeMap::new();
        for name in touched {
            before.insert(name.clone(), undo::rev_parse(core, repo_id, name).await?);
        }
        let known = core.db.with(|c| db::undo::list_done(c, repo_id, ""))?.into_iter().map(|e| e.id).collect();
        Ok(Start { entry, head, snapshot, before, known })
    })
    .await
}

/// Replaces the steps' own undo entries by one group entry `plan`; `false` when nothing local changed.
#[allow(clippy::too_many_arguments)]
async fn finish(core: &Core, repo_id: &str, start: Start, touched: &BTreeSet<String>, text: &str, done: usize, pushed: bool, stashed: bool) -> CoreResult<bool> {
    core.with_write_lock(repo_id, &[RepoChange::Refs], async {
        let own: Vec<db::undo::UndoEntry> = core.db.with(|c| db::undo::list_done(c, repo_id, ""))?.into_iter().filter(|e| !start.known.contains(&e.id)).collect();
        for entry in &own {
            core.db.with(|c| db::undo::delete(c, &entry.id))?;
            undo::delete_backup_refs(core, repo_id, &entry.id).await?;
        }
        let after_head = refs::read_head(core, repo_id).await?;
        let mut moves = Vec::new();
        for name in touched {
            let after = undo::rev_parse(core, repo_id, name).await?;
            let before = start.before.get(name).cloned().flatten();
            if before != after {
                moves.push(RefMove { name: name.clone(), from: before, to: after });
            }
        }
        let (head_before, head_after) = (undo::head_token(&start.head), undo::head_token(&after_head));
        if done == 0 || (moves.is_empty() && head_before == head_after && !stashed) {
            undo::delete_backup_refs(core, repo_id, &start.entry).await?;
            return Ok(false);
        }
        let mut label = format!("Undo plan “{}”", undo::shorten(text.trim(), 60));
        if pushed {
            label.push_str(" – pushed refs stay pushed");
        }
        let mut extra = Map::new();
        extra.insert("planSteps".into(), json!(done));
        extra.insert("pushed".into(), json!(pushed));
        undo::record_group(
            core,
            GroupRecord {
                id: start.entry.clone(),
                repo_id: repo_id.to_string(),
                action: UndoAction::Plan,
                label,
                refs: moves,
                head_before,
                head_after: Some(head_after),
                snapshot: Some(start.snapshot.clone()),
                extra,
            },
        )
        .await?;
        Ok(true)
    })
    .await
}

/// Runs `work`; when the plan is cancelled meanwhile, the step's own job is cancelled too and its
/// end is awaited (no step is left half-way).
async fn follow_cancel<T>(core: &Core, cancel: &CancelToken, step_job: &str, work: impl Future<Output = CoreResult<T>>) -> CoreResult<T> {
    tokio::pin!(work);
    tokio::select! {
        result = &mut work => result,
        () = cancel.cancelled() => {
            core.jobs.cancel(step_job);
            work.await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::TestCore;

    #[tokio::test]
    async fn cancelling_the_plan_cancels_the_running_step_job() {
        let tc = TestCore::new().await;
        let plan = CancelToken::new();
        let step = tc.start_job("plan-1:0", None).unwrap();
        let step_token = step.token().clone();
        plan.cancel();
        let result: CoreResult<()> = follow_cancel(&tc, &plan, "plan-1:0", async move {
            step_token.cancelled().await;
            Err(CoreError::cancelled())
        })
        .await;
        assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled, "the step ended because its own job was cancelled");
        step.finish(&Ok::<(), CoreError>(()));
    }
}
