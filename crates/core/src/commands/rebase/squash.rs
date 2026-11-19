//! Squashing commits into one.

use super::*;

// ---------------------------------------------------------------------------
// Squash
// ---------------------------------------------------------------------------

pub(super) async fn squash(core: &Core, repo_id: &str, shas: &[String], message: &str, touched: &AtomicBool) -> CoreResult<OpResult> {
    let Some(message) = normalize_message(message) else {
        return Err(CoreError::new(ErrorCode::EmptyMessage, "The commit message is empty."));
    };
    require_shas(shas)?;
    ensure_no_operation(core, repo_id).await?;
    settle_pending_undo(core, repo_id).await?;
    let head = crate::git::repo::read_head(core, repo_id).await?;
    let (branch, head_sha) = require_branch(&head, "Squashing")?;

    let mut resolve = core.git_for(repo_id)?.read().arg("rev-parse");
    for sha in shas {
        resolve = resolve.arg(format!("{}^{{commit}}", sha.trim()));
    }
    let resolved = resolve.run_raw().await?;
    if !resolved.success() {
        return Err(
            CoreError::not_found("At least one of the selected commits doesn't exist (anymore).").with_git_output(resolved.stderr_text())
        );
    }
    let wanted: HashSet<String> = resolved.stdout_lines().into_iter().map(util::decode_lossy).filter(|l| !l.is_empty()).collect();
    if wanted.len() < 2 {
        return Err(CoreError::not_allowed("Select at least two commits to squash."));
    }

    // Read downwards from HEAD until all selected commits have been seen.
    let mut chain: Vec<(String, Vec<String>)> = Vec::new();
    let mut missing = wanted.len();
    core.git_for(repo_id)?
        .read()
        .args(["rev-list", "--topo-order", "--parents", "HEAD"])
        .run_records(b'\n', None, &mut |line: &[u8]| {
            let text = util::decode_lossy(line);
            let mut parts = text.split_whitespace().map(str::to_string);
            let Some(sha) = parts.next() else {
                return true;
            };
            if wanted.contains(&sha) {
                missing -= 1;
            }
            chain.push((sha, parts.collect()));
            missing > 0
        })
        .await?;
    if missing > 0 {
        return Err(CoreError::not_allowed(
            "Not all of the selected commits are on the checked-out branch. You can only squash commits on the branch that's checked out.",
        ));
    }
    if chain.iter().any(|(sha, parents)| parents.len() > 1 && wanted.contains(sha)) {
        return Err(CoreError::not_allowed("Merge commits can't be squashed."));
    }
    if chain.iter().any(|(_, parents)| parents.len() > 1) {
        return Err(CoreError::not_allowed(
            "There's a merge commit above the selected commits. The commits above it would have to be reapplied, which would flatten the merge.",
        ));
    }
    // Without a merge, `chain` is the straight line from HEAD to the oldest selected commit.
    let newest = chain.iter().position(|(sha, _)| wanted.contains(sha)).unwrap_or(0);
    if chain.len() - newest != wanted.len() {
        return Err(CoreError::not_allowed("The selected commits aren't consecutive. You can only squash consecutive commits."));
    }
    ensure_clean(core, repo_id).await?;

    let base = chain.last().and_then(|(_, parents)| parents.first().cloned());
    let steps: Vec<Step> = chain
        .iter()
        .rev()
        .enumerate()
        .map(|(i, (sha, _))| Step {
            sha: sha.clone(),
            action: if i > 0 && wanted.contains(sha) { RebaseAction::Squash } else { RebaseAction::Pick },
            message: (i == 0).then(|| message.clone()),
        })
        .collect();
    let (entries, _) = plan_entries(&steps, &[])?;
    let summary_line = message.lines().next().unwrap_or_default().to_string();
    let ctx = Rewrite {
        undo_id: undo::new_id(),
        action: UndoAction::Squash,
        label: format!("Undo squash of {}", commits_label(wanted.len())),
        branch: branch.clone(),
        old_tip: head_sha.clone(),
        head_before: head.token(),
        payload: json!({ "branch": branch, "base": base, "summary": summary_line, "count": wanted.len() }),
        what: "squash",
    };
    let todo = render_todo(core, repo_id, &entries, &[]).await?;
    undo::create_backup_ref(core, repo_id, &ctx.undo_id, "before", &head_sha).await?;
    touched.store(true, Ordering::SeqCst);
    let (out, ran) = match run_interactive(core, repo_id, base.as_deref(), &todo, false).await {
        Ok(out) => out,
        Err(e) => {
            undo::delete_backup_refs(core, repo_id, &ctx.undo_id).await?;
            return Err(e);
        }
    };
    let concluded = conclude_rebase(core, repo_id, &out, ctx).await;
    match prefer_hook_failure(core, repo_id, concluded, &ran, &out, "the squash").await? {
        Finished::Stopped(result) => Ok(result),
        Finished::Unchanged => Ok(OpResult::UpToDate),
        Finished::Done(new_tip) => {
            // The new commit sits as far below the tip as there were commits above the selection.
            let squashed = if newest == 0 { Some(new_tip) } else { rev::rev_parse(core, repo_id, &format!("{new_tip}~{newest}")).await? };
            Ok(OpResult::Done {
                sha: squashed,
                fast_forward: false,
                summary: format!("Squashed {} into one.", commits_label(wanted.len())),
            })
        }
    }
}
