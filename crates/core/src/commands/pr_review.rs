//! Commands for the own review of a pull request: comments on lines, local drafts, submitting.
//!
//! Local drafts live in SQLite (`db::review_drafts`) per repository, repository at the host and pull
//! request; they need no account. The host is recognised from a remote as in `commands/host.rs`
//! (`host_unsupported` if no remote belongs to a supported host).

use crate::app::Core;
use crate::commands::host::check_thread_id;
use crate::db;
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::rev::is_sha;
use crate::host::{self, Host, RepoApi, RepoPath, ReviewSubmission, ReviewSubmitOutcome};
use crate::model::{HostKind, NewReviewComment, PrReviewDrafts, ReviewDraft, ReviewSubmitResult, ReviewVote};
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

/// Pull request numbers start at 1 on every host.
fn check_number(number: u64) -> CoreResult<()> {
    if number == 0 {
        return Err(CoreError::not_allowed("Pull request numbers start at 1. Reload the pull request."));
    }
    Ok(())
}

/// A local draft ID is the decimal row ID; anything else cannot be one of ours.
fn draft_rowid(draft_id: &str) -> CoreResult<i64> {
    draft_id.trim().parse().map_err(|_| CoreError::not_found("This review draft does not exist. Reload the pull request."))
}

/// Checks a comment at the trust boundary and returns the normalised copy: body kept as typed (Markdown
/// indentation matters), not blank and at most 64 KiB; path inside the repository; `line ≥ 1`; a range (`start_line < line`) only where the
/// host takes one; `commit` a full object ID.
pub(crate) fn check_comment(kind: HostKind, comment: &NewReviewComment) -> CoreResult<NewReviewComment> {
    let body = &comment.body;
    if body.trim().is_empty() {
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
    Ok(NewReviewComment { path, ..comment.clone() })
}

/// The drafts of the own review: the host's (started in the browser) first, then the local ones, oldest
/// first. Without an account only the local ones; if the host's cannot be read, `hostUnreadable`.
pub async fn pr_review_drafts(core: &Core, repo_id: String, number: u64, remote: Option<String>) -> CoreResult<PrReviewDrafts> {
    check_number(number)?;
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
    check_number(number)?;
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
    check_number(number)?;
    let id = draft_rowid(&draft_id)?;
    let found = host_repo(core, &repo_id, remote.as_deref()).await?;
    let full = repo_path(&found).full();
    if core.db.with(|c| db::review_drafts::delete(c, &repo_id, &full, number, id))? {
        Ok(())
    } else {
        Err(CoreError::not_found("This review draft no longer exists. Reload the pull request."))
    }
}

/// `host_unsupported` unless the host can do `what` through its API.
fn require(hoster: &dyn Host, can: bool, what: &str) -> CoreResult<()> {
    if can {
        Ok(())
    } else {
        Err(CoreError::new(ErrorCode::HostUnsupported, format!("{} does not offer {what} through its API.", hoster.label())))
    }
}

/// The review text is at most 64 KiB.
fn check_review_body(body: &str) -> CoreResult<()> {
    if body.len() > MAX_BODY_BYTES {
        return Err(CoreError::not_allowed(format!("The review text is longer than {MAX_BODY_BYTES} bytes. Shorten it.")));
    }
    Ok(())
}

/// What a review needs besides its vote: `Comment` a text or at least one draft (local or at the host),
/// `RequestChanges` a text; the text at most 64 KiB.
pub(crate) fn check_submission(vote: ReviewVote, body: &str, drafts: usize) -> CoreResult<()> {
    check_review_body(body)?;
    let blank = body.trim().is_empty();
    if vote == ReviewVote::RequestChanges && blank {
        return Err(CoreError::new(ErrorCode::EmptyMessage, "Requesting changes needs a text that says what to change. Write one."));
    }
    if vote == ReviewVote::Comment && blank && drafts == 0 {
        return Err(CoreError::new(
            ErrorCode::EmptyMessage,
            "This review has neither a text nor comments on lines. Write a text or comment on a line first.",
        ));
    }
    Ok(())
}

/// The error of a vote that failed after `sent` line comments already reached the host; the code stays.
pub(crate) fn vote_failed_after(sent: usize, mut error: CoreError) -> CoreError {
    let what = if sent == 1 { "The line comment was sent".to_string() } else { format!("The {sent} line comments were sent") };
    error.message = format!("{what}; the review itself was not: {}. Send the review again.", error.message.trim_end_matches('.'));
    error
}

/// Sends one comment on a line (or range) at once, without a draft.
pub async fn pr_review_comment_create(
    core: &Core,
    repo_id: String,
    number: u64,
    comment: NewReviewComment,
    remote: Option<String>,
) -> CoreResult<()> {
    check_number(number)?;
    let RepoApi { api, repo, .. } = host::api_for_repo(core, &repo_id, remote.as_deref()).await?;
    let hoster = host::host(api.kind);
    require(hoster, hoster.capabilities().review_comment, "comments on lines")?;
    let comment = check_comment(api.kind, &comment)?;
    hoster.review_comment_create(core, &api, &repo, number, &comment).await
}

/// Marks a review thread as resolved (`resolved: true`) or reopens it; `resolve_id` as `ReviewThread.resolve_id`.
pub async fn pr_review_thread_resolve(
    core: &Core,
    repo_id: String,
    number: u64,
    resolve_id: String,
    resolved: bool,
    remote: Option<String>,
) -> CoreResult<()> {
    check_number(number)?;
    let resolve_id = check_thread_id(&resolve_id)?.to_string();
    let RepoApi { api, repo, .. } = host::api_for_repo(core, &repo_id, remote.as_deref()).await?;
    let hoster = host::host(api.kind);
    require(hoster, hoster.capabilities().review_resolve, "resolving review threads")?;
    hoster.review_thread_set_resolved(core, &api, &repo, number, &resolve_id, resolved).await
}

/// Submits the own review with its vote, text and drafts. Batch hosts take the local drafts with the
/// review; the others get each draft on its own first, and the vote only when all of them arrived.
/// Drafts that reached the host are deleted locally, failing ones stay with their error.
pub async fn pr_review_submit(
    core: &Core,
    repo_id: String,
    number: u64,
    vote: ReviewVote,
    body: String,
    commit: String,
    remote: Option<String>,
) -> CoreResult<ReviewSubmitResult> {
    check_number(number)?;
    let RepoApi { api, repo, .. } = host::api_for_repo(core, &repo_id, remote.as_deref()).await?;
    let hoster = host::host(api.kind);
    let caps = hoster.capabilities();
    match vote {
        ReviewVote::Approve => require(hoster, caps.review_approve, "approving reviews")?,
        ReviewVote::RequestChanges => require(hoster, caps.review_request_changes, "reviews that request changes")?,
        ReviewVote::Comment => require(hoster, caps.review_comment, "reviews")?,
    }
    if !is_sha(&commit) {
        return Err(CoreError::not_allowed("The review must name the full ID of the commit it refers to. Reload the pull request."));
    }
    check_review_body(&body)?;
    let full = repo.full();
    let local = core.db.with(|c| db::review_drafts::list(c, &repo_id, &full, number))?;
    // The host's drafts matter only for a comment review without text or local drafts; unreadable ones
    // count as none (the host itself refuses an empty review).
    let at_host = if vote == ReviewVote::Comment && body.trim().is_empty() && local.is_empty() {
        hoster.review_host_drafts(core, &api, &repo, number).await.map(|d| d.len()).unwrap_or(0)
    } else {
        0
    };
    check_submission(vote, &body, local.len() + at_host)?;

    let outcome = if caps.review_submit_batch {
        let submission = ReviewSubmission { vote, body: &body, commit: &commit, drafts: &local };
        hoster.review_submit(core, &api, &repo, number, submission).await?
    } else {
        let mut outcome = ReviewSubmitOutcome::default();
        for draft in &local {
            match hoster.review_comment_create(core, &api, &repo, number, &host::draft_as_comment(draft)).await {
                Ok(()) => outcome.sent.push(draft.id.clone()),
                Err(error) => outcome.failed.push((draft.id.clone(), error.message)),
            }
        }
        if outcome.failed.is_empty() {
            let submission = ReviewSubmission { vote, body: &body, commit: &commit, drafts: &[] };
            match hoster.review_submit(core, &api, &repo, number, submission).await {
                Ok(done) => (outcome.submitted, outcome.published, outcome.error) = (done.submitted, done.published, done.error),
                Err(error) => outcome.error = Some(error),
            }
        }
        outcome
    };

    // Drafts that reached the host go even when the vote failed afterwards: a retry must not post them twice.
    core.db.with(|c| {
        for id in &outcome.sent {
            db::review_drafts::delete(c, &repo_id, &full, number, draft_rowid(id)?)?;
        }
        for (id, message) in &outcome.failed {
            db::review_drafts::set_error(c, draft_rowid(id)?, message)?;
        }
        Ok(())
    })?;
    if let Some(error) = outcome.error {
        return Err(if outcome.published || outcome.sent.is_empty() { error } else { vote_failed_after(outcome.sent.len(), error) });
    }
    let failed = core.db.with(|c| db::review_drafts::list(c, &repo_id, &full, number))?.into_iter().filter(|d| d.error.is_some()).collect();
    Ok(ReviewSubmitResult { submitted: outcome.submitted, sent: outcome.sent.len() as u32, failed })
}
