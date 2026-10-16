//! Paket 8.2: "Suggest fix" for one review thread. The AI sees the pull request (number, title,
//! branches), the thread's comments and an excerpt of the commented file at the pull request's newest
//! commit with line numbers – nothing else. Its answer (`{ path, startLine, endLine, newText, why }`) is
//! data: only the thread's file, only lines of the excerpt, and a patch the core can build itself
//! (`commands::review_fix::line_patch`); anything else uses the one repair attempt.

use serde_json::{json, Value};

use crate::ai::context::{self, Built, Exclusions, CHARS_PER_TOKEN};
use crate::ai::prompt::{self, Section};
use crate::app::Core;
use crate::commands::history::{self, normalize_rel_path};
use crate::commands::refs;
use crate::commands::review_fix::{self, PrRange};
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::host::{self, RepoApi};
use crate::model::{AiOmitReason, AiReviewFix, Head, ReviewSide, ReviewThread, Settings};

/// Lines before and after the commented ones that the AI sees.
pub const WINDOW: u32 = 60;
/// The excerpt when the full window does not fit three quarters of the budget.
pub const SMALL_WINDOW: u32 = 20;

pub const INSTRUCTION: &str = "You get one review thread of a pull request and an excerpt of the file it comments on, as the file is at the pull request's newest commit. Every excerpt line starts with its line number and a vertical bar. Propose the smallest change that does what the review asks for. Answer with: path – exactly the file of the review thread; startLine and endLine – the first and the last excerpt line you replace (1-based, inclusive, both inside the excerpt); newText – the complete new text for exactly these lines, without line numbers (empty to delete them); why – one or two sentences for the author of the pull request. Change nothing outside the excerpt and keep the file's indentation.";

/// What a request was built from; the meaning check and `finish` need it.
pub struct ReviewFixContext {
    pub number: u64,
    pub thread: ReviewThread,
    /// The thread's file, normalised.
    pub path: String,
    pub range: PrRange,
    /// The file at the pull request's newest commit.
    pub blob: Vec<u8>,
    /// The commented lines (1-based, inclusive).
    pub lines: (u32, u32),
    /// The lines of the excerpt the AI saw.
    pub window: (u32, u32),
    /// The local branch of the pull request.
    pub branch: String,
}

pub struct ReviewBuilt {
    pub built: Built,
    pub ctx: ReviewFixContext,
}

pub fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": { "type": "string" },
            "startLine": { "type": "integer" },
            "endLine": { "type": "integer" },
            "newText": { "type": "string" },
            "why": { "type": "string" }
        },
        "required": ["path", "startLine", "endLine", "newText", "why"],
        "additionalProperties": false
    })
}

fn never_sent(reason: AiOmitReason) -> &'static str {
    match reason {
        AiOmitReason::Secret => "looks like a secret",
        AiOmitReason::Ignored => "matches .forkyard/ai-ignore or the global exclusion list",
        AiOmitReason::Generated => "is a generated or lock file",
        AiOmitReason::Binary => "is a binary file",
        AiOmitReason::Budget => "is too large",
    }
}

/// `<n>| <text>` for every line of the window.
fn excerpt(lines: &[&str], window: (u32, u32)) -> String {
    (window.0..=window.1).map(|n| format!("{n}| {}", lines[(n - 1) as usize].trim_end_matches('\r'))).collect::<Vec<_>>().join("\n")
}

/// Reads pull request, thread and file and builds the prompt. Refused before anything is sent: a
/// thread that is gone (`not_found`), outdated or on the old side, a file the pull request does not
/// change or that is excluded (`not_allowed`), the pull request's commits not here (`not_found`).
#[allow(clippy::too_many_arguments)]
pub async fn build(core: &Core, repo_id: &str, settings: &Settings, number: u64, thread_id: &str, budget_tokens: u64, locale: &str, secrets: &[String]) -> CoreResult<ReviewBuilt> {
    let RepoApi { api, repo, remote } = host::api_for_repo(core, repo_id, None).await?;
    let hoster = host::host(api.kind);
    if !hoster.capabilities().review_threads {
        return Err(CoreError::new(ErrorCode::HostUnsupported, format!("{} offers no review threads through its API.", hoster.label())));
    }
    let details = hoster.pr_get(core, &api, &repo, number).await?;
    let thread = hoster
        .review_threads(core, &api, &repo, number)
        .await?
        .into_iter()
        .find(|t| t.id == thread_id)
        .ok_or_else(|| CoreError::not_found(format!("The review thread no longer exists in #{number}.")))?;
    let (Some(end), ReviewSide::New, false) = (thread.line, thread.side, thread.outdated) else {
        return Err(CoreError::not_allowed("This review comment refers to lines that are no longer in the pull request – a fix can only be suggested for current lines."));
    };
    let path = normalize_rel_path(&thread.path)?;
    if history::is_inside_git_dir(&path) {
        return Err(CoreError::not_allowed("Files inside the Git directory are never changed by a fix."));
    }
    let range = review_fix::pr_range(core, repo_id, &details.head_sha, &review_fix::target_ref(&remote, &details.summary.target_branch)?).await?;
    if !review_fix::changed_paths(core, repo_id, &range).await?.contains(&path) {
        return Err(CoreError::not_allowed(format!("“{path}” is not changed by this pull request.")));
    }
    if let Some(reason) = Exclusions::load(core, repo_id, &settings.ai_exclude).await?.reason(&path) {
        return Err(CoreError::not_allowed(format!("“{path}” is never sent to the AI: it {}.", never_sent(reason))));
    }
    let blob = review_fix::head_blob(core, repo_id, &range.head, &path).await?;
    if history::is_binary_content(&blob) {
        return Err(CoreError::not_allowed(format!("“{path}” is a binary file; fixes are only suggested for text files.")));
    }
    let (text, _) = history::decode_content(&blob, "utf-8");
    let mut lines: Vec<&str> = text.split('\n').collect();
    if text.ends_with('\n') {
        lines.pop();
    }
    let count = lines.len() as u32;
    let start = thread.start_line.filter(|s| *s <= end).unwrap_or(end);
    if end > count {
        return Err(CoreError::not_allowed(format!("The commented lines {start}–{end} are past the end of “{path}”.")));
    }
    let header = format!("#{number} {}\nSource branch: {}\nTarget branch: {}", details.summary.title, details.summary.source_branch, details.summary.target_branch);
    let commented = if start < end { format!("{start}–{end}") } else { end.to_string() };
    let conversation = thread
        .comments
        .iter()
        .map(|c| format!("{} ({}):\n{}", c.author.as_ref().map(|a| a.login.as_str()).unwrap_or("?"), c.created_at, c.body))
        .collect::<Vec<_>>()
        .join("\n\n");
    let thread_text = format!("File: {path}\nCommented lines: {commented}\n\n{conversation}");
    let budget_chars = (budget_tokens as f64 * CHARS_PER_TOKEN) as usize;
    let mut chosen = None;
    for around in [WINDOW, SMALL_WINDOW] {
        let window = (start.saturating_sub(around).max(1), (end + around).min(count));
        let file_text = format!("File: {path}, lines {}–{} of {count}\n{}", window.0, window.1, excerpt(&lines, window));
        let sections = vec![
            Section { title: "Pull request".into(), body: context::redact_for_ai(&header, secrets) },
            Section { title: "Review thread".into(), body: context::redact_for_ai(&thread_text, secrets) },
            Section { title: "File excerpt (line number| text)".into(), body: context::redact_for_ai(&file_text, secrets) },
        ];
        if sections.iter().map(|s| s.title.len() + s.body.len()).sum::<usize>() * 4 <= budget_chars * 3 {
            chosen = Some((window, around, sections));
            break;
        }
    }
    let Some((window, around, sections)) = chosen else {
        return Err(CoreError::ai_too_large("The review thread and the lines around it do not fit the model's context."));
    };
    let prompt = prompt::build(INSTRUCTION, locale, &sections);
    let shortened = if around == WINDOW { Vec::new() } else { vec![path.clone()] };
    let branch = review_fix::local_branch(hoster, &details.summary, number);
    Ok(ReviewBuilt { built: Built { prompt, omitted: Vec::new(), shortened }, ctx: ReviewFixContext { number, thread, path, range, blob, lines: (start, end), window, branch } })
}

/// The meaning of an answer: the thread's file, lines inside the excerpt, and a patch the core can
/// build (`line_patch` – which also refuses a text that changes nothing).
pub fn check_answer(value: &Value, ctx: &ReviewFixContext) -> Result<(), String> {
    let path = value["path"].as_str().unwrap_or("");
    if normalize_rel_path(path).ok().as_deref() != Some(ctx.path.as_str()) {
        return Err(format!("$.path: must be “{}”, the file of the review thread", ctx.path));
    }
    let (start, end) = (value["startLine"].as_u64().unwrap_or(0), value["endLine"].as_u64().unwrap_or(0));
    if start < u64::from(ctx.window.0) || end > u64::from(ctx.window.1) || start > end {
        return Err(format!("$.startLine/$.endLine: must lie within the excerpt, lines {}–{}, with startLine ≤ endLine", ctx.window.0, ctx.window.1));
    }
    let new_text = value["newText"].as_str().unwrap_or("");
    review_fix::line_patch(&ctx.path, &ctx.blob, start as u32, end as u32, new_text).map(|_| ()).map_err(|e| format!("$.newText: {}", e.message))
}

/// The checked answer as the UI gets it: the hunk built by the core, the fixup target (blame of the
/// commented lines), the candidates and whether the branch is checked out.
pub async fn finish(core: &Core, repo_id: &str, ctx: &ReviewFixContext, value: &Value) -> CoreResult<AiReviewFix> {
    let (start, end) = (value["startLine"].as_u64().unwrap_or(0) as u32, value["endLine"].as_u64().unwrap_or(0) as u32);
    let new_text = value["newText"].as_str().unwrap_or("").to_string();
    let patch = review_fix::line_patch(&ctx.path, &ctx.blob, start, end, &new_text)?;
    let target = review_fix::fixup_target(core, repo_id, &ctx.range, &ctx.path, ctx.lines.0, ctx.lines.1).await?;
    let on_branch = matches!(refs::read_head(core, repo_id).await?, Head::Branch { branch, .. } if branch == ctx.branch);
    Ok(AiReviewFix {
        thread_id: ctx.thread.id.clone(),
        path: ctx.path.clone(),
        start_line: start,
        end_line: end,
        new_text,
        why: value["why"].as_str().unwrap_or("").trim().to_string(),
        head_sha: ctx.range.head.clone(),
        old_text: patch.old_text,
        lines: patch.lines,
        target,
        candidates: ctx.range.commits.clone(),
        branch: ctx.branch.clone(),
        on_branch,
    })
}

#[cfg(test)]
mod tests;
