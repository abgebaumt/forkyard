//! Creating the planned commits of "Compose commits" (v1.2, Teilpaket 3.2).
//!
//! Inside the write lock: the state token must still match, then ONE group undo entry is
//! prepared (snapshot of index and working directory before anything moves). Every commit is
//! built on a temporary index (`GIT_INDEX_FILE`): HEAD as it was plus the units of this commit and
//! of all earlier ones. Files that are complete come from the working-directory tree as they are
//! (`update-index --index-info` – byte-exact, also binaries, LFS pointers, gitlinks), single hunks
//! as a patch the core builds (`build_patch`, `git apply --cached`). `git commit` then runs on that
//! index, so hooks and signing behave as in the terminal. At the end the real index is set to HEAD
//! for the committed paths; the working directory is never touched, units nobody assigned stay.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::Path;

use serde_json::{json, Map};

use super::units::{self, ChangedFile, ComposeRead};
use crate::app::Core;
use crate::commands::commit::{build_message, check_committable, run_commit_on};
use crate::commands::diff::patch::{self, Direction};
use crate::commands::diff::TempIndex;
use crate::commands::status::read_status;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::GitCmd;
use crate::jobs::Job;
use crate::model::{ComposePlan, ComposeResult, HookOutput, HunkSelection, RepoChange};
use crate::undo::{self, GroupRecord, GroupSnapshot, RefMove, UndoAction};

/// What a compose run can change.
pub(crate) const CHANGES: [RepoChange; 3] = [RepoChange::Index, RepoChange::Refs, RepoChange::Head];
/// Job phase of `job:progress`; the line is "<n>/<total>".
const PHASE: &str = "compose";
/// Reflog message when a failed run moves the branch back.
const ROLLBACK_MESSAGE: &str = "forkyard: compose rolled back";

/// Per file of `ComposeRead::files`: `None` = the whole file, otherwise these hunks.
type Parts = BTreeMap<usize, Option<BTreeSet<usize>>>;

/// One commit of the plan, checked.
struct Step {
    message: String,
    units: Vec<(usize, Option<usize>)>,
}

#[derive(Default)]
struct Done {
    commits: Vec<String>,
    /// Every commit this run made, also one a later check rejected: only these may be dropped
    /// when the branch is moved back.
    created: Vec<String>,
    hooks: Vec<HookOutput>,
}

/// The whole run; call inside the write lock. Any failure after the snapshot moves the branch back
/// to the old HEAD, restores the index and removes the backup refs – but only while the branch holds
/// nothing but this run's commits; otherwise all of it stays as it is.
pub(crate) async fn apply(core: &Core, repo_id: &str, job: &Job, plan: &ComposePlan, expect_token: &str) -> CoreResult<ComposeResult> {
    let read = units::read(core, repo_id).await?;
    if read.token != expect_token {
        return Err(CoreError::stale_state());
    }
    check_committable(&read_status(core, repo_id).await?)?;
    let steps = checked_plan(&read, plan)?;
    let branch_ref = format!("refs/heads/{}", read.branch);
    let entry_id = undo::new_id();
    let snapshot = undo::snapshot_for_group(core, repo_id, &entry_id).await?;
    let index_before = snapshot.index_tree.clone();
    let temp = TempIndex::create(core)?;
    let mut done = Done::default();
    let outcome = async {
        let parts = commit_steps(core, repo_id, job, &read, &steps, plan.skip_hooks, &branch_ref, temp.path(), &mut done).await?;
        let tip = done.commits.last().cloned().unwrap_or_else(|| read.head.clone());
        reset_committed_paths(core, repo_id, &read, &parts, &tip).await?;
        record(core, repo_id, &read, &branch_ref, entry_id.clone(), snapshot, &done.commits).await
    }
    .await;
    if let Err(error) = outcome {
        return Err(match roll_back(core, repo_id, &read, &branch_ref, &entry_id, &done.created, index_before.as_deref()).await {
            Rollback::LeftAlone => left_alone(error),
            Rollback::Done => error,
        });
    }
    Ok(ComposeResult { commits: done.commits, hooks: done.hooks })
}

/// Unknown or doubled units, commits without units, empty summaries – before anything is written.
fn checked_plan(read: &ComposeRead, plan: &ComposePlan) -> CoreResult<Vec<Step>> {
    let index = read.index();
    let mut seen = HashSet::new();
    let mut steps = Vec::new();
    for (number, commit) in plan.commits.iter().enumerate() {
        if commit.units.is_empty() {
            return Err(CoreError::not_allowed(format!("Commit {} has no changes assigned.", number + 1)));
        }
        let message = build_message(&commit.title, &commit.body)?;
        let mut units = Vec::new();
        for id in &commit.units {
            let Some(unit) = index.get(id) else {
                return Err(CoreError::not_allowed(format!("The change “{}” is not part of the current changes.", short_id(id))));
            };
            if !seen.insert(id.as_str()) {
                return Err(CoreError::not_allowed(format!("The change “{}” is assigned to more than one commit.", short_id(id))));
            }
            units.push(*unit);
        }
        steps.push(Step { message, units });
    }
    if steps.is_empty() {
        return Err(CoreError::new(ErrorCode::NothingToCommit, "No commit has changes assigned."));
    }
    Ok(steps)
}

/// `path#hunk` without the token, for messages.
fn short_id(id: &str) -> &str {
    id.rsplit_once('@').map_or(id, |(head, _)| head)
}

fn add_unit(parts: &mut Parts, (file, hunk): (usize, Option<usize>)) {
    let entry = parts.entry(file).or_insert_with(|| Some(BTreeSet::new()));
    match (hunk, entry) {
        (Some(hunk), Some(set)) => {
            set.insert(hunk);
        }
        (None, entry) => *entry = None,
        (Some(_), None) => {}
    }
}

fn commit_args(skip_hooks: bool) -> Vec<&'static str> {
    let mut args = vec!["commit", "--cleanup=verbatim", "-F", "-"];
    if skip_hooks {
        args.push("--no-verify");
    }
    args
}

fn percent(number: usize, total: usize) -> u32 {
    ((number * 100) / total.max(1)) as u32
}

/// Creates the commits one after another. Before each: cancelled? branch still where the previous
/// step left it? After each: the commit sits on the previous tip, has exactly the tree that was
/// built (a hook that staged more fails this), and the working directory is unchanged (a hook that
/// edited files fails this).
#[allow(clippy::too_many_arguments)]
async fn commit_steps(
    core: &Core,
    repo_id: &str,
    job: &Job,
    read: &ComposeRead,
    steps: &[Step],
    skip_hooks: bool,
    branch_ref: &str,
    index: &Path,
    done: &mut Done,
) -> CoreResult<Parts> {
    let mut parts = Parts::new();
    let mut previous = read.head.clone();
    for (number, step) in steps.iter().enumerate() {
        job.token().check()?;
        job.progress(PHASE, Some(percent(number, steps.len())), &format!("{}/{}", number + 1, steps.len()));
        if undo::rev_parse(core, repo_id, branch_ref).await?.as_deref() != Some(previous.as_str()) {
            return Err(moved_meanwhile());
        }
        for unit in &step.units {
            add_unit(&mut parts, *unit);
        }
        let tree = build_index(core, repo_id, read, &parts, index).await?;
        done.hooks.extend(run_commit_on(core, repo_id, &commit_args(skip_hooks), &step.message, Some(index)).await?);
        let Some(sha) = undo::rev_parse(core, repo_id, branch_ref).await? else { return Err(moved_meanwhile()) };
        let parent = undo::rev_parse(core, repo_id, &format!("{sha}^1")).await?;
        let committed = undo::rev_parse(core, repo_id, &format!("{sha}^{{tree}}")).await?;
        if parent.as_deref() != Some(previous.as_str()) {
            return Err(moved_meanwhile());
        }
        done.created.push(sha.clone());
        if committed.as_deref() != Some(tree.as_str()) {
            return Err(hook_changed(&done.hooks, "the content of a commit"));
        }
        if undo::worktree_tree(core, repo_id, None).await? != read.worktree_tree {
            return Err(hook_changed(&done.hooks, "files in the working directory"));
        }
        done.commits.push(sha.clone());
        previous = sha;
    }
    Ok(parts)
}

fn moved_meanwhile() -> CoreError {
    CoreError::new(
        ErrorCode::StaleState,
        "The branch moved while the commits were being created. The commits were taken back; HEAD and the index are as before.",
    )
}

/// The branch holds commits this run did not make: it stays where it is, so does the index, and
/// the backup refs keep what the run created. The hooks' output goes along.
fn left_alone(error: CoreError) -> CoreError {
    let left = CoreError::new(
        ErrorCode::StaleState,
        "The branch was moved by someone else while the commits were being created. Forkyard left the branch and the index where they are and kept its backup refs, so no commit is lost; check the history and reload.",
    );
    match error.git_output {
        Some(output) => left.with_git_output(output),
        None => left,
    }
}

/// `hook_failed` for a hook that changed the index or files; the hooks' output goes along.
fn hook_changed(hooks: &[HookOutput], what: &str) -> CoreError {
    let output = hooks.iter().filter(|hook| !hook.output.is_empty()).map(|hook| format!("{}:\n{}", hook.hook, hook.output)).collect::<Vec<_>>().join("\n\n");
    let error = CoreError::new(
        ErrorCode::HookFailed,
        format!(
            "A Git hook changed {what} while the commits were being created. The commits were taken back; HEAD and the index are as before, changes the hook made to files stay. Create the commits without hooks or let the hook run first."
        ),
    );
    if output.is_empty() {
        error
    } else {
        error.with_git_output(output)
    }
}

/// Fills the temporary index: HEAD as it was, complete files from the working-directory tree,
/// partial files as a patch. Returns the tree the commit must get.
async fn build_index(core: &Core, repo_id: &str, read: &ComposeRead, parts: &Parts, index: &Path) -> CoreResult<String> {
    let on_temp = || -> CoreResult<GitCmd> { Ok(core.git_for(repo_id)?.no_log().env("GIT_INDEX_FILE", index)) };
    on_temp()?.args(["read-tree", read.head.as_str()]).run().await?;
    let mut info = Vec::new();
    let mut patches = Vec::new();
    for (file_index, hunks) in parts {
        let file = &read.files[*file_index];
        let complete = match (hunks, file.hunk_count()) {
            (Some(set), Some(count)) => set.len() == count,
            _ => true,
        };
        if complete {
            index_info(file, &mut info);
            continue;
        }
        let (Some(set), Some(file_patch)) = (hunks, &file.patch) else { continue };
        let selection: Vec<HunkSelection> = set.iter().map(|&hunk| HunkSelection { index: hunk as u32, lines: None }).collect();
        if let Some(bytes) = patch::build_patch(file_patch, &file.entry.path, &selection, Direction::Forward)? {
            patches.extend_from_slice(&bytes);
        }
    }
    if !info.is_empty() {
        on_temp()?.args(["update-index", "-z", "--index-info"]).stdin(info).run().await?;
    }
    if !patches.is_empty() {
        on_temp()?
            .args(["-c", "apply.whitespace=nowarn", "-c", "apply.ignoreWhitespace=no", "apply", "--cached", "--whitespace=nowarn"])
            .stdin(patches)
            .run()
            .await?;
    }
    on_temp()?.arg("write-tree").run_text().await
}

/// `update-index --index-info` lines (NUL-terminated) that make the index entry of the file what
/// the working-directory tree has: removed for deletions, old path removed for renames.
fn index_info(file: &ChangedFile, out: &mut Vec<u8>) {
    let entry = &file.entry;
    let zeros = "0".repeat(entry.old_id.len().max(40));
    if let Some(old) = &entry.old_path {
        out.extend_from_slice(format!("0 {zeros}\t").as_bytes());
        out.extend_from_slice(old);
        out.push(0);
    }
    if entry.status == b'D' {
        out.extend_from_slice(format!("0 {zeros}\t").as_bytes());
    } else {
        out.extend_from_slice(format!("{} {}\t", entry.new_mode, entry.new_id).as_bytes());
    }
    out.extend_from_slice(&entry.path);
    out.push(0);
}

/// The real index takes HEAD for every committed path (old paths of renames too); other staged
/// paths stay as they were.
async fn reset_committed_paths(core: &Core, repo_id: &str, read: &ComposeRead, parts: &Parts, tip: &str) -> CoreResult<()> {
    let mut list = Vec::new();
    for file_index in parts.keys() {
        let entry = &read.files[*file_index].entry;
        list.extend_from_slice(&entry.path);
        list.push(0);
        if let Some(old) = &entry.old_path {
            list.extend_from_slice(old);
            list.push(0);
        }
    }
    core.git_for(repo_id)?
        .env("GIT_LITERAL_PATHSPECS", "1")
        .args(["reset", "-q", tip, "--pathspec-from-file=-", "--pathspec-file-nul"])
        .stdin(list)
        .run()
        .await?;
    Ok(())
}

/// ONE group undo entry for all commits (Paket 0): the branch back to the old HEAD, index and
/// working directory from the snapshot.
async fn record(core: &Core, repo_id: &str, read: &ComposeRead, branch_ref: &str, entry_id: String, snapshot: GroupSnapshot, commits: &[String]) -> CoreResult<()> {
    let label = if commits.len() == 1 { "Undo creating 1 commit".to_string() } else { format!("Undo creating {} commits", commits.len()) };
    let mut extra = Map::new();
    extra.insert("commits".into(), json!(commits));
    undo::record_group(
        core,
        GroupRecord {
            id: entry_id,
            repo_id: repo_id.to_string(),
            action: UndoAction::Compose,
            label,
            refs: vec![RefMove::new(branch_ref, Some(&read.head), commits.last().map(String::as_str))],
            head_before: branch_ref.to_string(),
            head_after: Some(branch_ref.to_string()),
            snapshot: Some(snapshot),
            extra,
        },
    )
    .await?;
    Ok(())
}

enum Rollback {
    /// The branch is back on the old HEAD (or never moved), as far as anything could be restored.
    Done,
    /// The branch holds commits this run did not make (or is gone): nothing was touched.
    LeftAlone,
}

/// Whether the branch tip and its first parents down to the old HEAD are all commits of this run –
/// only then may the branch be moved back without dropping someone else's work.
async fn only_ours(core: &Core, repo_id: &str, read: &ComposeRead, created: &[String], now: &str) -> CoreResult<bool> {
    let mut current = now.to_string();
    for _ in 0..=created.len() {
        if current == read.head {
            return Ok(true);
        }
        if !created.contains(&current) {
            return Ok(false);
        }
        let Some(parent) = undo::rev_parse(core, repo_id, &format!("{current}^1")).await? else { return Ok(false) };
        current = parent;
    }
    Ok(false)
}

/// After a failure: if the branch holds only commits of this run, it goes back to the old HEAD
/// (one transaction, compare-and-swap on the tip just checked), the real index back if it changed,
/// the backup refs removed. If the branch was moved by someone else, nothing is touched and the
/// backup refs stay; likewise if something cannot be restored, so nothing is lost.
async fn roll_back(core: &Core, repo_id: &str, read: &ComposeRead, branch_ref: &str, entry_id: &str, created: &[String], index_before: Option<&str>) -> Rollback {
    let mut restored = true;
    match undo::rev_parse(core, repo_id, branch_ref).await {
        Ok(Some(now)) if now == read.head => {}
        Ok(Some(now)) => match only_ours(core, repo_id, read, created, &now).await {
            Ok(true) => {
                if let Err(e) = undo::apply_ref_moves(core, repo_id, &[RefMove::new(branch_ref, Some(&now), Some(&read.head))], ROLLBACK_MESSAGE).await {
                    log::error!("Compose: {branch_ref} not moved back to {}: {}", read.head, e.message);
                    restored = false;
                }
            }
            Ok(false) => {
                log::warn!("Compose: {branch_ref} was moved by someone else (now {now}); left where it is, backup refs of {entry_id} kept");
                return Rollback::LeftAlone;
            }
            Err(e) => {
                log::error!("Compose: history of {branch_ref} not read after a failure: {}", e.message);
                return Rollback::LeftAlone;
            }
        },
        Ok(None) => {
            log::warn!("Compose: {branch_ref} is gone after a failure; backup refs of {entry_id} kept");
            return Rollback::LeftAlone;
        }
        Err(e) => {
            log::error!("Compose: {branch_ref} not read after a failure; left as it is: {}", e.message);
            return Rollback::LeftAlone;
        }
    }
    if let Some(tree) = index_before {
        let same = units::index_tree_of_copy(core, repo_id).await.is_ok_and(|now| now == tree);
        if !same {
            if let Err(e) = undo::restore_index(core, repo_id, tree).await {
                log::error!("Compose: index not restored to {tree}: {}", e.message);
                restored = false;
            }
        }
    }
    if restored {
        if let Err(e) = undo::delete_backup_refs(core, repo_id, entry_id).await {
            log::warn!("Compose: backup refs of {entry_id} not removed: {}", e.message);
        }
    }
    Rollback::Done
}
