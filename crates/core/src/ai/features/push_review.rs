//! The review before a push: leftovers (debug output, commented-out code, likely bugs) in what a
//! push would send. The prompt is `context::outgoing_changes`; the answer is data, checked here.

use std::collections::HashSet;

use serde_json::{json, Value};

use crate::ai::context;
use crate::app::Core;
use crate::commands::sync::{push_destination, PushRequest};
use crate::error::CoreResult;
use crate::model::{AiPushFinding, AiPushFindingKind};
use crate::util;

/// The outgoing changes of a push with these arguments (`AiInput::OutgoingChanges`, `ai_push_review`).
pub(crate) async fn outgoing_for(
    core: &Core,
    repo_id: &str,
    branch: Option<&str>,
    remote: Option<&str>,
    remote_branch: Option<&str>,
) -> CoreResult<context::Outgoing> {
    let request = PushRequest { branch, remote, remote_branch, ..PushRequest::default() };
    let (local_ref, remote, _) = push_destination(core, repo_id, &request).await?;
    context::outgoing(core, repo_id, &local_ref, &remote).await
}

const MAX_REVIEW_FINDINGS: usize = 50;

const MAX_NOTE_CHARS: usize = 300;

/// Answer schema of the review before a push (1a's dialect: every field required, no formats).
pub(crate) fn push_review_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "findings": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "line": {"type": ["integer", "null"]},
                        "kind": {"type": "string", "enum": ["debug_output", "commented_code", "likely_bug"]},
                        "note": {"type": "string"}
                    },
                    "required": ["path", "line", "kind", "note"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["findings"],
        "additionalProperties": false
    })
}

/// The answer is data: only files the model saw, sensible lines, redacted notes,
/// no duplicates, at most `MAX_REVIEW_FINDINGS`; sorted by path and line.
pub(crate) fn review_findings(value: &Value, shown: &[String], secrets: &[String]) -> Vec<AiPushFinding> {
    let known: HashSet<&str> = shown.iter().map(String::as_str).collect();
    let mut seen: HashSet<(String, Option<u32>, AiPushFindingKind)> = HashSet::new();
    let mut out = Vec::new();
    for item in value.get("findings").and_then(Value::as_array).into_iter().flatten() {
        let Some(raw) = item.get("path").and_then(Value::as_str) else { continue };
        let Some(path) = [raw.to_string(), raw.replace('\\', "/")]
            .into_iter()
            .filter_map(|candidate| crate::util::normalize_rel_path(&candidate).ok())
            .find(|candidate| known.contains(candidate.as_str()))
        else {
            continue;
        };
        let kind = match item.get("kind").and_then(Value::as_str) {
            Some("debug_output") => AiPushFindingKind::DebugOutput,
            Some("commented_code") => AiPushFindingKind::CommentedCode,
            Some("likely_bug") => AiPushFindingKind::LikelyBug,
            _ => continue,
        };
        let line = item.get("line").and_then(Value::as_u64).filter(|number| *number >= 1).and_then(|number| u32::try_from(number).ok());
        let note = context::redact_for_ai(item.get("note").and_then(Value::as_str).unwrap_or("").trim(), secrets);
        let note = util::truncate_str(&note, MAX_NOTE_CHARS);
        if note.trim().is_empty() || !seen.insert((path.clone(), line, kind)) {
            continue;
        }
        out.push(AiPushFinding { path, line, kind, note });
        if out.len() == MAX_REVIEW_FINDINGS {
            break;
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path).then(a.line.cmp(&b.line)));
    out
}
