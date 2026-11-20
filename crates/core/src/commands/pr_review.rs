//! Commands for the own review of a pull request: comments on lines, local drafts, submitting.
//!
//! Local drafts live in SQLite (`db::review_drafts`) per repository, repository at the host and pull
//! request; they need no account. The host is recognised from a remote as in `commands/host.rs`
//! (`host_unsupported` if no remote belongs to a supported host).

use crate::app::Core;
use crate::db;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::rev::is_sha;
use crate::host::{self, RepoPath};
use crate::model::{HostKind, NewReviewComment, PrReviewDrafts, ReviewDraft};
use crate::util;

/// Largest comment body in bytes.
const MAX_BODY_BYTES: usize = 65_536;

/// The repository at the host for `repo_id`; no account needed.
async fn host_repo(core: &Core, repo_id: &str, remote: Option<&str>) -> CoreResult<host::RepoHost> {
    host::resolve(core, repo_id, remote).await?.ok_or_else(|| {
        CoreError::new(
            ErrorCode::HostUnsupported,
            "None of this repository's remotes is on a supported host or a connected self-hosted instance.",
        )
    })
}

fn repo_path(found: &host::RepoHost) -> RepoPath {
    RepoPath { owner: found.detected.owner.clone(), name: found.detected.name.clone() }
}

/// A local draft ID is the decimal row ID; anything else cannot be one of ours.
fn draft_rowid(draft_id: &str) -> CoreResult<i64> {
    draft_id.trim().parse().map_err(|_| CoreError::not_found("This review draft does not exist. Reload the pull request."))
}

/// Checks a comment at the trust boundary and returns the normalised copy: body trimmed, not empty and
/// at most 64 KiB; path inside the repository; `line ≥ 1`; a range (`start_line < line`) only where the
/// host takes one; `commit` a full object ID.
pub(crate) fn check_comment(kind: HostKind, comment: &NewReviewComment) -> CoreResult<NewReviewComment> {
    let body = comment.body.trim();
    if body.is_empty() {
        return Err(CoreError::new(ErrorCode::EmptyMessage, "The comment must not be empty. Write something or discard the draft."));
    }
    if body.len() > MAX_BODY_BYTES {
        return Err(CoreError::not_allowed(format!("The comment is longer than {MAX_BODY_BYTES} bytes. Shorten it.")));
    }
    let path = util::normalize_rel_path(&comment.path)?;
    if comment.line == 0 || comment.old_line == Some(0) {
        return Err(CoreError::not_allowed("Line numbers start at 1."));
    }
    if let Some(start) = comment.start_line {
        if start == 0 || start >= comment.line {
            return Err(CoreError::not_allowed("A range of lines must start before its last line."));
        }
        let hoster = host::host(kind);
        if !hoster.capabilities().review_comment_range {
            return Err(CoreError::not_allowed(format!("{} takes comments on single lines only. Pick one line.", hoster.label())));
        }
    }
    if !is_sha(&comment.commit) {
        return Err(CoreError::not_allowed("The comment must name the full ID of the commit it refers to."));
    }
    Ok(NewReviewComment { path, body: body.to_string(), ..comment.clone() })
}

/// The drafts of the own review: the host's (started in the browser) first, then the local ones, oldest
/// first. Without an account only the local ones; if the host's cannot be read, `hostUnreadable`.
pub async fn pr_review_drafts(core: &Core, repo_id: String, number: u64, remote: Option<String>) -> CoreResult<PrReviewDrafts> {
    let found = host_repo(core, &repo_id, remote.as_deref()).await?;
    let repo = repo_path(&found);
    let local = core.db.with(|c| db::review_drafts::list(c, &repo_id, &repo.full(), number))?;
    let mut drafts = Vec::new();
    let mut host_unreadable = false;
    if let Some(account) = &found.detected.account {
        let from_host = async {
            let mut api = host::api_for_account(core, account).await?;
            api.repo_id = Some(repo_id.clone());
            host::host(found.detected.kind).review_host_drafts(core, &api, &repo, number).await
        }
        .await;
        match from_host {
            Ok(host_drafts) => drafts = host_drafts,
            Err(_) => host_unreadable = true,
        }
    }
    drafts.extend(local);
    Ok(PrReviewDrafts { drafts, host_unreadable })
}

/// Stores a local draft (`draft_id: None`) or replaces one (its error is cleared). Nothing is sent.
pub async fn pr_review_draft_save(
    core: &Core,
    repo_id: String,
    number: u64,
    comment: NewReviewComment,
    draft_id: Option<String>,
    remote: Option<String>,
) -> CoreResult<ReviewDraft> {
    let found = host_repo(core, &repo_id, remote.as_deref()).await?;
    let comment = check_comment(found.detected.kind, &comment)?;
    let id = draft_id.as_deref().map(draft_rowid).transpose()?;
    let full = repo_path(&found).full();
    core.db.with(|c| match id {
        Some(id) => db::review_drafts::update(c, &repo_id, &full, number, id, &comment),
        None => db::review_drafts::insert(c, &repo_id, &full, number, &comment),
    })
}

/// Discards a local draft; `not_found` if this pull request has no such draft.
pub async fn pr_review_draft_delete(core: &Core, repo_id: String, number: u64, draft_id: String, remote: Option<String>) -> CoreResult<()> {
    let id = draft_rowid(&draft_id)?;
    let found = host_repo(core, &repo_id, remote.as_deref()).await?;
    let full = repo_path(&found).full();
    if core.db.with(|c| db::review_drafts::delete(c, &repo_id, &full, number, id))? {
        Ok(())
    } else {
        Err(CoreError::not_found("This review draft no longer exists. Reload the pull request."))
    }
}
