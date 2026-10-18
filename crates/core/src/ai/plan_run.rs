//! Running a checked plan (spec Paket 5): the expected state must still hold (checked again inside
//! the write lock before step 1), every outward step must be confirmed on its own, then the steps
//! run one after another through their existing commands (each takes the write lock itself), and
//! the first error ends the plan. Before step 1 the working directory and index are backed up and
//! the refs the steps may move are noted; at the end the steps' own undo entries give way to one
//! group entry `plan`, so one Mod+Z brings back the local state before step 1. Pushed refs stay
//! pushed – the label says so. Only the entries the steps recorded themselves are replaced
//! (`undo::recording`); when another action recorded or undid something meanwhile, the steps keep
//! their own entries, so no group entry can take the user's action back or drop its backup.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
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
    /// Undo entries (all worktrees, both stacks) and their state before step 1.
    known: HashMap<String, String>,
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
    // Undo entries the steps themselves recorded.
    let mut recorded: HashSet<String> = HashSet::new();
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
        let (result, ids) = undo::recording(follow_cancel(core, job.token(), &step_job, plan_commands::execute(core, repo_id, &step_job, action))).await;
        recorded.extend(ids);
        match result {
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
    let undo_recorded = finish(core, repo_id, start, &touched, text, done.len(), pushed, stashed, &recorded).await?;
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
        let known = undo_states(core, repo_id)?;
        Ok(Start { entry, head, snapshot, before, known })
    })
    .await
}

/// Replaces the steps' own undo entries by one group entry `plan`; `false` when nothing local changed.
#[allow(clippy::too_many_arguments)]
async fn finish(core: &Core, repo_id: &str, start: Start, touched: &BTreeSet<String>, text: &str, done: usize, pushed: bool, stashed: bool, recorded: &HashSet<String>) -> CoreResult<bool> {
    core.with_write_lock(repo_id, &[RepoChange::Refs], async {
        let now = undo_states(core, repo_id)?;
        // Another action recorded, undid or redid something while the plan ran (the palette closes,
        // the plan goes on in the core): one group entry would take that action back too, or drop
        // its backup. The steps then keep their own entries, each undone on its own.
        let foreign = now.iter().any(|(id, state)| !recorded.contains(id) && start.known.get(id) != Some(state));
        if foreign {
            undo::delete_backup_refs(core, repo_id, &start.entry).await?;
            return Ok(false);
        }
        for id in now.keys().filter(|id| recorded.contains(*id)) {
            core.db.with(|c| db::undo::delete(c, id))?;
            undo::delete_backup_refs(core, repo_id, id).await?;
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

/// Every undo entry of the repository (all worktrees, both stacks) with its state.
fn undo_states(core: &Core, repo_id: &str) -> CoreResult<HashMap<String, String>> {
    Ok(core.db.with(|c| db::undo::all_for_repo(c, repo_id))?.into_iter().map(|e| (e.id, e.state.as_str().to_string())).collect())
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

    /// The user discards a file while the plan runs (the palette closed, the plan goes on in the
    /// core): the discard keeps its undo entry and its backup of the file, and the plan's own step
    /// is not folded together with it.
    #[tokio::test]
    async fn an_action_of_the_user_during_the_plan_keeps_its_undo_entry_and_backup() {
        use crate::commands::plan::ai_plan_check;
        use crate::model::PlanCommand;
        use crate::testkit::TestRepo;

        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let id = tc.open(&repo).await.repo.id;
        let tracked = repo.git(&["ls-files"]);
        let tracked = tracked.lines().next().expect("a tracked file").to_string();
        repo.write_file(&tracked, b"meine Arbeit\r\nohne Schluss \xe4");
        let steps = vec![PlanStep {
            command: PlanCommand::BranchCreate,
            args: json!({"name": "fix", "start": null, "checkout": true}).as_object().cloned().unwrap(),
            why: "Weil es verlangt wurde.".into(),
        }];
        let preview = ai_plan_check(&tc, id.clone(), crate::util::new_id(), steps.clone()).await.unwrap();
        let checked = plan_check::check(&tc, &id, &steps, &CancelToken::new()).await.unwrap();
        let start = begin(&tc, &id, &steps, &preview.expect, &checked.seen, &checked.touched).await.unwrap();

        // Meanwhile, outside the plan: the user discards the change.
        crate::commands::stage::discard_paths(&tc, id.clone(), Some(vec![tracked.clone()])).await.unwrap();
        let discard = tc.db.with(|c| db::undo::list_done(c, &id, "")).unwrap().into_iter().next().expect("the discard's entry");
        assert_eq!(discard.action, "discard");
        let backups = |entry: &str| repo.git(&["for-each-ref", "--format=%(refname)", &format!("refs/forkyard/undo/{entry}/")]);
        assert!(!backups(&discard.id).trim().is_empty(), "the discard backed the file up");

        // The plan's step.
        let action = checked.actions.into_iter().flatten().next().unwrap();
        let step_job = "plan-x:0".to_string();
        let ((), recorded) = undo::recording(async { plan_commands::execute(&tc, &id, &step_job, &action).await.unwrap() }).await;
        assert_eq!(recorded.len(), 1, "the step recorded one entry of its own");
        finish(&tc, &id, start, &checked.touched, "Branch fix", 1, false, false, &recorded.into_iter().collect()).await.unwrap();

        let done: Vec<String> = tc.db.with(|c| db::undo::list_done(c, &id, "")).unwrap().into_iter().map(|e| e.id).collect();
        assert!(done.contains(&discard.id), "the discard's undo entry stays: {done:?}");
        assert!(!backups(&discard.id).trim().is_empty(), "the discard's backup refs stay");
        assert_eq!(repo.current_branch(), "fix");

        // Undo brings the discarded work back, byte for byte.
        while let Some(top) = tc.db.with(|c| db::undo::top_done(c, &id, "")).unwrap() {
            crate::commands::undo::undo(&tc, id.clone()).await.unwrap();
            if top.id == discard.id {
                break;
            }
        }
        assert_eq!(repo.read_file(&tracked), b"meine Arbeit\r\nohne Schluss \xe4");
    }
}
