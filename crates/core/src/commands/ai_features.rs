//! The AI functions that answer one request each: they check (`ai::run::ask`), build the same text
//! "What is sent?" shows (`ai_preview`) and send it (`Frame::send`).

use serde_json::Value;

use crate::ai::features::{commit_message, push_review};
use crate::ai::{self, context, run};
use crate::app::Core;
use crate::error::CoreResult;
use crate::model::{AiCommitMessage, AiFeature, AiPushReview, ConflictBlockRange, ConflictIntent};

/// "Review and push …": asks the provider about leftovers in what a `push` with these
/// arguments would send. Same target rules and errors as `push`; nothing outgoing → no request.
/// Budget, secrets (`request_frame`) and builder are those of `ai_preview` for `AiInput::OutgoingChanges`, so the
/// confirmation of "What is sent?" matches.
pub async fn ai_push_review(
    core: &Core,
    repo_id: String,
    job_id: String,
    branch: Option<String>,
    remote: Option<String>,
    remote_branch: Option<String>,
    locale: String,
) -> CoreResult<AiPushReview> {
    let settings = run::ensure_allowed(core, Some(&repo_id), AiFeature::PushReview)?;
    let outgoing = push_review::outgoing_for(core, &repo_id, branch.as_deref(), remote.as_deref(), remote_branch.as_deref()).await?;
    if outgoing.commits.is_empty() {
        return Ok(AiPushReview { findings: Vec::new(), commits: 0, files: 0, partial: false });
    }
    let frame = run::frame(core, &repo_id, AiFeature::PushReview, settings).await;
    let built = context::outgoing_changes(core, &repo_id, &frame.settings, frame.budget, &locale, &frame.secrets, &outgoing).await?;
    let answer = frame.send(core, &job_id, &built.built.prompt, &push_review::push_review_schema()).await?;
    Ok(AiPushReview {
        findings: push_review::review_findings(&answer.value, &built.shown, &frame.secrets),
        commits: built.commits,
        files: built.files,
        partial: built.partial,
    })
}

/// Title and description of a pull request from the commits of `source` that `target`
/// does not have. A suggestion only – nothing is written; the form places it. The prompt is the
/// one `ai_preview` shows for `AiInput::PrDescription` with the same refs; with a template the
/// answer must keep every heading (one repair attempt), and "Closes #n" comes from the commits.
pub async fn ai_pr_description(
    core: &Core,
    repo_id: String,
    job_id: String,
    source: String,
    target: String,
    locale: String,
) -> CoreResult<crate::model::AiPrDescription> {
    let frame = run::ask(core, &repo_id, AiFeature::PrDescription).await?;
    let pr = ai::features::pr::build(core, &repo_id, &frame.settings, &source, &target, frame.budget, &locale, &frame.secrets).await?;
    let check = |value: &Value| ai::features::pr::check_answer(value, &pr.headings);
    let answer = frame.send_checked(core, &job_id, &pr.built.prompt, &ai::features::pr::schema(), &check).await?;
    Ok(ai::features::pr::finish(&answer.value, &pr.closes))
}

/// 8.2: a fix for one review thread – nothing is written. The prompt is the one `ai_preview` shows for
/// `AiInput::ReviewFix` with the same number and thread; the answer must name the thread's file and lines
/// of the excerpt and give a patch the core can build (one repair attempt); the core adds the fixup target.
pub async fn ai_review_fix(
    core: &Core,
    repo_id: String,
    job_id: String,
    number: u64,
    thread_id: String,
    locale: String,
) -> CoreResult<crate::model::AiReviewFix> {
    let frame = run::ask(core, &repo_id, AiFeature::ReviewFix).await?;
    let review =
        ai::features::review::build(core, &repo_id, &frame.settings, number, &thread_id, frame.budget, &locale, &frame.secrets).await?;
    let check = |value: &Value| ai::features::review::check_answer(value, &review.ctx);
    let answer = frame.send_checked(core, &job_id, &review.built.prompt, &ai::features::review::schema(), &check).await?;
    ai::features::review::finish(core, &repo_id, &review.ctx, &answer.value).await
}

/// Where to cut `branch` into stacked pull requests – a suggestion only, nothing is
/// created. The prompt is the one `ai_preview` shows for `AiInput::StackSplit` with the same refs;
/// the cuts must rise and end with the last commit (one repair attempt).
pub async fn ai_stack_split(
    core: &Core,
    repo_id: String,
    job_id: String,
    branch: String,
    base: String,
    locale: String,
) -> CoreResult<crate::model::AiStackSplit> {
    let frame = run::ask(core, &repo_id, AiFeature::StackSplit).await?;
    let stack = ai::features::stack::build(core, &repo_id, &frame.settings, &branch, &base, frame.budget, &locale, &frame.secrets).await?;
    let check = |value: &Value| ai::features::stack::check_answer(value, stack.commits);
    let answer = frame.send_checked(core, &job_id, &stack.built.prompt, &ai::features::stack::schema(), &check).await?;
    Ok(ai::features::stack::finish(&answer.value))
}

/// "Summarise" on the "What's new" card: one paragraph about the current digest – a text only, the
/// seen state stays. The prompt is the one `ai_preview` shows for `AiInput::Digest`.
pub async fn ai_digest(core: &Core, repo_id: String, job_id: String, locale: String) -> CoreResult<crate::model::AiDigest> {
    let frame = run::ask(core, &repo_id, AiFeature::Digest).await?;
    let built = ai::features::digest::build(core, &repo_id, &frame.settings, frame.budget, &locale, &frame.secrets).await?;
    let answer = frame.send(core, &job_id, &built.prompt, &ai::features::digest::schema()).await?;
    Ok(ai::features::digest::finish(&answer.value))
}

/// "Write" in the commit form: a commit message for the staged changes – a draft, the
/// core commits nothing. Built exactly as `ai_preview` with `AiInput::CommitMessage` shows it, so a
/// confirmation given there holds here; `complete_json` refuses everything unconfirmed.
pub async fn ai_commit_message(core: &Core, repo_id: String, job_id: String, locale: String) -> CoreResult<AiCommitMessage> {
    let frame = run::ask(core, &repo_id, AiFeature::CommitMessage).await?;
    let built = commit_message::build(core, &repo_id, &frame.settings, frame.budget, &locale, &frame.secrets).await?;
    let answer = frame.send(core, &job_id, &built.prompt, &commit_message::schema()).await?;
    commit_message::parse(&answer.value)
}

/// “Explain intent” in the conflict tool: what both sides of every conflict block
/// wanted and a proposed text per block (`ai::features::conflict`). Checks that AI is on for this function and
/// repository before anything is read, builds exactly the text `ai_preview` shows for
/// `AiInput::ConflictIntent` (same builder, same `request_frame`), asks the provider as job `job_id`
/// (confirmations, usage and the activity entry by `complete_json`) and checks the answer per block.
/// Changes nothing in the repository.
pub async fn ai_conflict_intent(
    core: &Core,
    repo_id: String,
    job_id: String,
    path: String,
    blocks: Vec<ConflictBlockRange>,
    locale: String,
) -> CoreResult<ConflictIntent> {
    let frame = run::ask(core, &repo_id, AiFeature::ConflictIntent).await?;
    let plan =
        ai::features::conflict::build(core, &repo_id, &path, &blocks, &frame.settings, frame.budget, &locale, &frame.secrets).await?;
    let answer = frame.send(core, &job_id, &plan.built.prompt, &ai::features::conflict::schema()).await?;
    ai::features::conflict::accept(&plan, &answer.value)
}

#[cfg(test)]
mod push_review_tests;
