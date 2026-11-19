//! The running operation: continue and abort.

use super::*;

// ---------------------------------------------------------------------------
// operation_continue / operation_abort
// ---------------------------------------------------------------------------

/// Continues the running operation: merge → commit (with `message`, otherwise MERGE_MSG),
/// rebase, cherry-pick and revert → `--continue`. If conflicts are still open, `conflict`
/// comes back with the file list without calling Git; a rebase may stop on a conflict
/// again at the next commit.
///
/// `skip_hooks`: the merge commit is created with `--no-verify` (like "Skip Git hooks" for an
/// ordinary commit). Git has no such option for rebase, cherry-pick and revert; there it has no effect.
pub async fn operation_continue(core: &Core, repo_id: String, message: Option<String>, skip_hooks: Option<bool>) -> CoreResult<OpResult> {
    auto::follow_operation(
        core,
        &repo_id,
        core.with_write_lock(&repo_id, &ALL_CHANGES, continue_locked(core, &repo_id, message, skip_hooks.unwrap_or(false))),
    )
    .await
}

pub(super) async fn continue_locked(core: &Core, repo_id: &str, message: Option<String>, skip_hooks: bool) -> CoreResult<OpResult> {
    let Some(op) = read_operation(core, repo_id).await? else { return Err(no_operation(core, repo_id).await) };
    let unmerged = ls_unmerged(core, repo_id).await?;
    if !unmerged.is_empty() {
        return Ok(OpResult::Conflict { files: display_paths(&unmerged), operation: Some(op), note: None });
    }
    let dir = crate::git::repo::git_dir(core, repo_id).await?;
    let head = read_head(core, repo_id).await?;
    let start = OperationStart::read(core, repo_id, &dir, &op, &head).await;
    // Rebase and cherry-pick started from the app left an open undo entry on the conflict.
    // If it belongs to this operation, it is completed at the end; if it is orphaned
    // (finished or aborted in the terminal), it is closed now.
    let pending = rebase::pending_undo(core, repo_id)?;
    let adopted =
        pending.as_ref().is_some_and(|entry| rebase::pending_belongs_to(entry, op.kind, start.ref_name.as_deref(), &start.before));
    if let Some(orphan) = pending.as_ref().filter(|_| !adopted) {
        if let Err(e) = rebase::settle_entry(core, repo_id, orphan).await {
            log::warn!("Orphaned undo entry not closed: {}", e.message);
        }
    }

    let hooks = Hooks::start(core, repo_id).await;
    let git = hooks.wrap(core.git_for(repo_id)?);
    let result: CoreResult<(&str, GitOutput)> = async {
        Ok(match op.kind {
            OperationKind::Merge => {
                let git = if skip_hooks { git.arg("commit").arg("--no-verify") } else { git.arg("commit") };
                let out = match util::non_empty(message) {
                    Some(text) => git.args(["--cleanup=whitespace", "-F", "-"]).stdin(text).run_raw().await?,
                    // MERGE_MSG contains the conflict list as a comment; without an editor it would otherwise stay.
                    None => git.args(["--no-edit", "--cleanup=strip"]).run_raw().await?,
                };
                ("commit", out)
            }
            OperationKind::Rebase => ("rebase", git.args(["rebase", "--continue"]).run_raw().await?),
            OperationKind::CherryPick | OperationKind::Revert => {
                let (subcommand, marker) =
                    if op.kind == OperationKind::CherryPick { ("cherry-pick", "CHERRY_PICK_HEAD") } else { ("revert", "REVERT_HEAD") };
                // If the resolution left nothing over, `--continue` would fail with "now empty":
                // the step is skipped then.
                let empty = dir.join(marker).exists() && index_matches_head(core, repo_id).await?;
                let flag = if empty { "--skip" } else { "--continue" };
                (subcommand, git.args([subcommand, flag]).run_raw().await?)
            }
        })
    }
    .await;
    let ran = hooks.finish(core, repo_id);
    let (subcommand, out) = result?;
    if !out.success() {
        if ls_unmerged(core, repo_id).await?.is_empty() {
            if let Some(error) = hook_failure(&ran, &ABORTING_HOOKS, &out, "the commit") {
                return Err(error);
            }
        }
        return stopped_or_failed(core, repo_id, subcommand, &out).await;
    }
    if let Some(still) = read_operation(core, repo_id).await? {
        // Exit 0 but not done: a rebase stopped at an "edit" or "break".
        return Ok(OpResult::Conflict { files: Vec::new(), operation: Some(still), note: None });
    }

    let new_head = read_head(core, repo_id).await?;
    let new = new_head.sha().map(str::to_string);
    let source = op.source.clone().unwrap_or_else(|| "?".to_string());
    let target = op.target.clone().unwrap_or_else(|| new_head.label());
    let (action, undo_label, summary) = match op.kind {
        OperationKind::Merge => {
            (UndoAction::Merge, format!("Undo merge of {source} into {target}"), format!("Merged {source} into {target}"))
        }
        OperationKind::Rebase => (
            UndoAction::Rebase,
            format!("Undo rebase of {source} onto {target}"),
            format!("Moved {source} onto {target} (rebase complete)"),
        ),
        OperationKind::CherryPick => (UndoAction::CherryPick, "Undo cherry-pick".to_string(), "Cherry-pick complete".to_string()),
        OperationKind::Revert => (UndoAction::Revert, "Undo revert".to_string(), "Revert complete".to_string()),
    };
    if let Some(entry) = pending.as_ref().filter(|_| adopted) {
        // The entry from the start of the operation gets its final state (or disappears if
        // nothing changed).
        if let Err(e) = rebase::settle_entry(core, repo_id, entry).await {
            log::warn!("Undo entry not completed: {}", e.message);
        }
    } else if let Some(new) = new.as_ref().filter(|new| **new != start.before) {
        let pending = Pending::new(repo_id);
        if op.kind == OperationKind::Rebase {
            // The branch's old commits are afterwards only reachable through this backup.
            keep_ref(core, repo_id, pending.id(), "before", &start.before).await;
        }
        let head_after = start.ref_name.clone().unwrap_or_else(|| new.clone());
        let subject = commit_meta(core, repo_id, new).await.map(|m| m.subject).unwrap_or_default();
        let id = pending.id().to_string();
        pending
            .record(
                core,
                UndoRecord {
                    id,
                    repo_id: repo_id.to_string(),
                    worktree_path: String::new(),
                    action,
                    label: undo_label,
                    ref_name: start.ref_name.clone(),
                    ref_before: Some(start.before.clone()),
                    ref_after: Some(new.clone()),
                    head_before: start.ref_name.clone().unwrap_or_else(|| start.before.clone()),
                    head_after: Some(head_after),
                    payload: json!({
                        "branch": start.ref_name.as_deref().map(short_ref_name),
                        "source": op.source,
                        "summary": subject,
                    }),
                },
            )
            .await;
    }
    Ok(OpResult::Done { sha: new, fast_forward: false, summary })
}

/// Where the branch stood before the operation – read before `--continue` removes the state files.
pub(super) struct OperationStart {
    /// Moved branch as full ref name; `None` for detached HEAD.
    pub(super) ref_name: Option<String>,
    pub(super) before: String,
}

impl OperationStart {
    pub(super) async fn read(core: &Core, repo_id: &str, dir: &Path, op: &Operation, head: &Head) -> OperationStart {
        let current = head.sha().unwrap_or_default().to_string();
        let first_line = |path: PathBuf| {
            std::fs::read_to_string(path).ok().and_then(|t| t.lines().next().map(|l| l.trim().to_string())).filter(|l| !l.is_empty())
        };
        match op.kind {
            OperationKind::Rebase => {
                // During the rebase HEAD is detached; branch and old tip are in the state folder.
                let state = if dir.join("rebase-merge").is_dir() { dir.join("rebase-merge") } else { dir.join("rebase-apply") };
                OperationStart {
                    ref_name: first_line(state.join("head-name")).filter(|n| n.starts_with("refs/")),
                    before: first_line(state.join("orig-head")).unwrap_or(current),
                }
            }
            OperationKind::Merge => OperationStart { ref_name: branch_ref(head), before: current },
            OperationKind::CherryPick | OperationKind::Revert => {
                // For a sequence the state before the first step, otherwise the current one.
                let before = match first_line(dir.join("sequencer").join("head")) {
                    Some(start) => rev::rev_parse(core, repo_id, &format!("{}^{{commit}}", start)).await.ok().flatten().unwrap_or(current),
                    None => current,
                };
                OperationStart { ref_name: branch_ref(head), before }
            }
        }
    }
}

/// Aborts the running operation and restores the state before it. The state comes from
/// the Git directory – it does not matter whether the operation was started here, before a
/// restart or in the terminal.
pub async fn operation_abort(core: &Core, repo_id: String) -> CoreResult<Status> {
    let repo_id = repo_id.as_str();
    core.with_write_lock(repo_id, &ALL_CHANGES, async {
        let Some(op) = read_operation(core, repo_id).await? else { return Err(no_operation(core, repo_id).await) };
        let subcommand = match op.kind {
            OperationKind::Merge => "merge",
            OperationKind::Rebase => "rebase",
            OperationKind::CherryPick => "cherry-pick",
            OperationKind::Revert => "revert",
        };
        // `--abort` of merge and cherry-pick runs as `reset --merge`, and that refuses files whose
        // timestamps in the index are stale ("not uptodate. Cannot merge") – even if their content
        // has not changed (copied repository, tools that merely touch files). The read commands
        // never refresh the index; hence here.
        core.git_for(repo_id)?.args(["update-index", "-q", "--refresh"]).no_log().run_raw().await?;
        // What the user did to UNRELATED files during the operation does not belong to the
        // operation: `rebase --abort` resets hard, `merge --abort` discards staged changes.
        // Without its backup (kept under a backup ref until it is written back) there is no abort.
        let extra = ExtraWork::find(core, repo_id, &op).await.map_err(|e| {
            let mut refused = CoreError::new(
                e.code,
                format!("Not aborted: your other changes couldn’t be backed up ({}). Fix or close that file, then abort again.", e.message),
            );
            refused.git_output = e.git_output;
            refused
        })?;
        let backup = match &extra {
            Some(extra) => Pending::new(repo_id).keep(core, "worktree", &extra.snapshot.commit).await?,
            None => Pending::new(repo_id),
        };
        let head_before = extra.as_ref().map(|extra| extra.head.clone());
        let aborted = async {
            let out = core.git_for(repo_id)?.args([subcommand, "--abort"]).run_raw().await?;
            if !out.success() {
                abort_past_leftovers(core, repo_id, subcommand, &out).await?;
            }
            Ok::<_, CoreError>(())
        }
        .await;
        // The backup goes only when the work is back, or when the abort failed on a lock before
        // touching anything (HEAD unchanged). Otherwise Git may have reset part of it: it stays.
        let safe = match (&aborted, extra) {
            (Ok(()), Some(extra)) => match extra.restore(core, repo_id).await {
                Ok(()) => true,
                Err(e) => {
                    log::warn!("Extra work not restored after the abort: {}", e.message);
                    false
                }
            },
            (Ok(()), None) => true,
            (Err(e), _) => {
                e.is(ErrorCode::Locked)
                    && rev::rev_parse(core, repo_id, "HEAD^{commit}").await.ok().flatten().as_deref() == head_before.as_deref()
            }
        };
        if safe || head_before.is_none() {
            backup.forget(core).await;
        } else {
            log::warn!("Extra work of the abort kept in {}", undo::backup_ref_name(backup.id(), "worktree"));
        }
        aborted?;
        // An open undo entry of the aborted operation disappears (the branch is back at the
        // start); an orphaned one is closed.
        if let Err(e) = rebase::settle_pending_undo(core, repo_id).await {
            log::warn!("Open undo entry not cleaned up after the abort: {}", e.message);
        }
        read_status(core, repo_id).await
    })
    .await
}

/// `rebase --abort` refuses to overwrite untracked files that the pre-rebase state contains
/// as tracked files. Such files are left behind when Git was terminated in the middle of a
/// checkout (crash, power failure): the rebase could then never be aborted again. If their
/// content matches byte for byte what the abort writes anyway, they are leftovers – they
/// go, and the abort runs once more. If even one differs, nothing is touched and the
/// message names the files.
pub(super) async fn abort_past_leftovers(core: &Core, repo_id: &str, subcommand: &str, failed: &GitOutput) -> CoreResult<()> {
    let text = failed.stderr_text();
    let plain = || crate::git::errors::classify(subcommand, failed.code, &failed.stdout, &failed.stderr);
    if !text.contains("untracked working tree files would be overwritten") {
        return Err(plain());
    }
    let files: Vec<String> = text
        .lines()
        .filter_map(|line| line.strip_prefix('\t'))
        .map(|file| file.trim().to_string())
        .filter(|file| !file.is_empty())
        .collect();
    let dir = crate::git::repo::git_dir(core, repo_id).await?;
    let target = ["rebase-merge/orig-head", "rebase-apply/orig-head"]
        .iter()
        .find_map(|name| std::fs::read_to_string(dir.join(name)).ok())
        .map(|sha| sha.trim().to_string())
        .filter(|sha| !sha.is_empty());
    let root = core.repo_path(repo_id)?;
    let mut differing: Vec<String> = Vec::new();
    if let Some(target) = &target {
        for file in &files {
            let wanted =
                core.git_for(repo_id)?.read().args(["rev-parse", "-q", "--verify"]).arg(format!("{target}:{file}")).run_raw().await?;
            let found = core.git_for(repo_id)?.read().args(["hash-object", "--"]).arg(file).run_raw().await?;
            let same =
                wanted.success() && found.success() && !wanted.stdout_text().is_empty() && wanted.stdout_text() == found.stdout_text();
            if !same {
                differing.push(file.clone());
            }
        }
    }
    if files.is_empty() || target.is_none() || !differing.is_empty() {
        let named = if differing.is_empty() { &files } else { &differing };
        let list = named.iter().take(5).map(|file| format!("“{file}”")).collect::<Vec<_>>().join(", ");
        let more = if named.len() > 5 { format!(" and {} more", named.len() - 5) } else { String::new() };
        let mut error = CoreError::new(
            ErrorCode::DirtyWorktree,
            format!(
                "Aborting would overwrite untracked files that exist as tracked files in the previous state: {list}{more}. Git won’t touch them. Move or delete them, then you can abort the operation."
            ),
        );
        error.git_output = Some(text);
        return Err(error);
    }
    for file in &files {
        let path = util::join_from_git(&root, file.as_bytes());
        if let Err(e) = std::fs::remove_file(&path) {
            log::warn!("Leftover of an interrupted checkout not removed ({file}): {e}");
        }
    }
    log::info!("{} leftovers of an interrupted checkout removed (identical to the pre-rebase state)", files.len());
    core.git_for(repo_id)?.args([subcommand, "--abort"]).run().await?;
    Ok(())
}

/// Work on files the running operation has nothing to do with: backed up before the abort,
/// written back afterwards where the abort reset them.
pub(super) struct ExtraWork {
    /// The working directory before the abort.
    pub(super) snapshot: undo::Snapshot,
    /// HEAD before the abort.
    pub(super) head: String,
    /// Files changed relative to HEAD that are neither conflicted nor touched by the commit
    /// being applied or by the incoming side.
    pub(super) paths: Vec<Vec<u8>>,
}

impl ExtraWork {
    pub(super) async fn find(core: &Core, repo_id: &str, op: &Operation) -> CoreResult<Option<ExtraWork>> {
        let Some(head) = rev::rev_parse(core, repo_id, "HEAD^{commit}").await? else { return Ok(None) };
        let snapshot = undo::snapshot(core, repo_id, None).await?;
        let changed =
            changed_names(core, repo_id, &["diff-tree", "-r", "-z", "--name-only", "--no-renames", &head, &snapshot.tree]).await?;
        if changed.is_empty() {
            return Ok(None);
        }
        let mut touched: HashSet<Vec<u8>> = ls_unmerged(core, repo_id).await?.into_iter().map(|entry| entry.path).collect();
        let dir = crate::git::repo::git_dir(core, repo_id).await?;
        let lines = |name: &str| -> Vec<String> {
            std::fs::read_to_string(dir.join(name))
                .map(|text| text.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
                .unwrap_or_default()
        };
        match op.kind {
            OperationKind::Merge => {
                // What the incoming side changed since the merge base.
                for other in lines("MERGE_HEAD") {
                    let range = format!("{head}...{other}");
                    touched.extend(
                        changed_names(core, repo_id, &["diff", "--no-ext-diff", "-z", "--name-only", "--no-renames", &range])
                            .await
                            .unwrap_or_default(),
                    );
                }
            }
            OperationKind::Rebase | OperationKind::CherryPick | OperationKind::Revert => {
                // The commit the operation is currently at.
                let stopped = match op.kind {
                    OperationKind::Rebase => lines("rebase-merge/stopped-sha").into_iter().chain(lines("REBASE_HEAD")).next(),
                    OperationKind::CherryPick => lines("CHERRY_PICK_HEAD").into_iter().next(),
                    _ => lines("REVERT_HEAD").into_iter().next(),
                };
                match stopped {
                    Some(sha) => touched.extend(
                        changed_names(
                            core,
                            repo_id,
                            &["diff-tree", "-r", "-z", "--name-only", "--no-renames", "--no-commit-id", "--root", "-m", &sha],
                        )
                        .await
                        .unwrap_or_default(),
                    ),
                    // Without the commit, "unrelated" cannot be determined: then touch nothing.
                    None => return Ok(None),
                }
            }
        }
        let paths: Vec<Vec<u8>> = changed.into_iter().filter(|path| !touched.contains(path)).collect();
        Ok(if paths.is_empty() { None } else { Some(ExtraWork { snapshot, head, paths }) })
    }

    pub(super) async fn restore(self, core: &Core, repo_id: &str) -> CoreResult<()> {
        let Some(now) = rev::rev_parse(core, repo_id, "HEAD^{commit}").await? else { return Ok(()) };
        // Files that differ between the state in the middle of the operation and the state after the
        // abort were already changed by the operation itself: they stay as the abort leaves them.
        let moved: HashSet<Vec<u8>> = if now == self.head {
            HashSet::new()
        } else {
            changed_names(core, repo_id, &["diff-tree", "-r", "-z", "--name-only", "--no-renames", &self.head, &now])
                .await?
                .into_iter()
                .collect()
        };
        let keep: Vec<String> = self.paths.iter().filter(|path| !moved.contains(*path)).map(|path| util::decode_lossy(path)).collect();
        if keep.is_empty() {
            return Ok(());
        }
        let current = undo::worktree_tree(core, repo_id, Some(&keep)).await?;
        if let Ok(plan) = undo::plan_restore(core, repo_id, None, &current, &self.snapshot.commit, Some(&keep)).await? {
            undo::apply_restore(core, repo_id, &plan).await?;
        }
        Ok(())
    }
}

/// NUL-separated paths from the output of a Git command.
pub(super) async fn changed_names(core: &Core, repo_id: &str, args: &[&str]) -> CoreResult<Vec<Vec<u8>>> {
    let out = core.git_for(repo_id)?.args(args).read().run().await?;
    Ok(out.stdout_z().into_iter().filter(|path| !path.is_empty()).map(<[u8]>::to_vec).collect())
}
