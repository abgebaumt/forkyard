//! The AI writes one paragraph about "What's new".
//!
//! Context: the digest the dialog shows (`commands::digest`) – ref names and how they changed, commit
//! subjects (never authors, e-mail addresses, bodies or file contents), the names of the
//! user's files the new commits touch, how far the current branch is behind, pull request numbers and
//! titles. Secret and ignored file names are not named and show up in "What is sent?". Everything is
//! redacted and sent between the markers of `ai::prompt`; the answer is plain text.

use serde_json::{json, Value};

use crate::ai::context::{self, Built, Exclusions};
use crate::ai::prompt::{self, Section};
use crate::app::Core;
use crate::commands::digest::{compose, WINDOW_HOURS};
use crate::error::{CoreError, CoreResult};
use crate::model::{AiDigest, AiOmitReason, AiOmitted, Digest, DigestPrChange, RefKind, Settings};

/// Longest paragraph the dialog shows.
pub const MAX_CHARS: usize = 1200;
pub const DIGEST_TITLE: &str = "What changed in the last 24 hours";

pub const INSTRUCTION: &str =
    "Write one short paragraph in the user's language about what changed in the repository in the last 24 hours. \
Name branches, tags and pull requests by their names. \
Give no advice and use no lists. Return the paragraph as `paragraph`.";

pub fn schema() -> Value {
    json!({
        "type": "object",
        "properties": { "paragraph": { "type": "string" } },
        "required": ["paragraph"],
        "additionalProperties": false
    })
}

/// The answer trimmed and cut to `MAX_CHARS` characters.
pub fn finish(value: &Value) -> AiDigest {
    let text = value.get("paragraph").and_then(Value::as_str).unwrap_or_default().trim();
    AiDigest { paragraph: text.chars().take(MAX_CHARS).collect::<String>().trim_end().to_string() }
}

fn render(digest: &Digest, exclusions: &Exclusions, omitted: &mut Vec<AiOmitted>) -> String {
    let mut out = String::new();
    for r in &digest.refs {
        let change = if r.kind == RefKind::Tag { "new tag" } else { "updated" };
        out.push_str(&format!("Ref {}: {change}, {} new commits\n", r.name, r.new_commits));
        for commit in &r.commits {
            out.push_str(&format!("   {}\n", commit.subject));
        }
    }
    for file in &digest.your_files {
        match exclusions.reason(&file.path) {
            Some(reason @ (AiOmitReason::Secret | AiOmitReason::Ignored)) => {
                omitted.push(AiOmitted { path: file.path.clone(), reason, size: 0 });
            }
            _ => {
                let note = if file.local { "changed locally" } else { "changed on the user's branch" };
                out.push_str(&format!("User's file touched by new commits: {} ({note})\n", file.path));
            }
        }
    }
    if let Some(behind) = &digest.behind {
        out.push_str(&format!("Branch {} is {} commits behind {} and {} ahead\n", behind.branch, behind.behind, behind.base, behind.ahead));
    }
    for pr in digest.prs.iter().flat_map(|prs| &prs.changed) {
        let change = match pr.change {
            DigestPrChange::Updated => "updated",
            DigestPrChange::Merged => "merged",
            DigestPrChange::Closed => "closed",
        };
        out.push_str(&format!("Pull request #{} {}: {change}\n", pr.number, pr.title));
    }
    for pr in digest.prs.iter().flat_map(|prs| &prs.comments) {
        out.push_str(&format!("Pull request #{} {}: {} new comments\n", pr.number, pr.title, pr.count));
    }
    out
}

/// The prompt for the repository's current digest. `secrets`: values known to be secret (the
/// provider key), scrubbed literally.
pub async fn build(
    core: &Core,
    repo_id: &str,
    settings: &Settings,
    budget_tokens: u64,
    locale: &str,
    secrets: &[String],
) -> CoreResult<Built> {
    let digest = compose(core, repo_id, chrono::Utc::now() - chrono::Duration::hours(WINDOW_HOURS)).await?;
    let exclusions = Exclusions::load(core, repo_id, &settings.ai_exclude).await?;
    let mut omitted = Vec::new();
    let body = context::redact_for_ai(&render(&digest, &exclusions, &mut omitted), secrets);
    let prompt = prompt::build(INSTRUCTION, locale, &[Section { title: DIGEST_TITLE.into(), body }]);
    if prompt.chars() as f64 > budget_tokens as f64 * context::CHARS_PER_TOKEN {
        return Err(CoreError::ai_too_large("What's new is too long for the model's context; read the dialog instead."));
    }
    Ok(Built { prompt, omitted, shortened: Vec::new() })
}

#[cfg(test)]
mod tests;
