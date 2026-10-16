//! The commit message of spec 3.1: the answer schema `{ summary, body }` and its normalisation.
//! The summary is one line of at most `SUMMARY_LIMIT` characters (the limit of the commit form).
//! The schema dialect has no length limits, so the core cuts a longer summary itself, at a word
//! boundary – asking again would be a new request that needs its own confirmation.

use serde_json::{json, Value};

use crate::error::{CoreError, CoreResult};
use crate::model::AiCommitMessage;

/// The same number as `SUMMARY_LIMIT` in `src/core/limits.ts` (checked by `limits.test.ts`).
pub const SUMMARY_LIMIT: usize = 72;
/// Longest own commit instruction of a repository (`RepoSettings.ai_commit_instruction`).
pub const MAX_INSTRUCTION_CHARS: usize = 2_000;

pub fn schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "summary": {"type": "string", "description": "One line of at most 72 characters: what the commit does."},
            "body": {"type": ["string", "null"], "description": "What changed and why, in lines of at most 72 characters; null when the summary says everything."}
        },
        "required": ["summary", "body"],
        "additionalProperties": false
    })
}

/// One line of at most `SUMMARY_LIMIT` characters: inner whitespace collapsed, a longer line cut at
/// the last space that keeps it within the limit (a single longer word is cut hard), without a
/// dangling `, ; : -` at the end.
pub fn fit_summary(line: &str) -> String {
    let collapsed = line.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= SUMMARY_LIMIT {
        return collapsed;
    }
    let head: String = collapsed.chars().take(SUMMARY_LIMIT + 1).collect();
    let cut = match head.rfind(' ') {
        Some(at) if at > 0 => head[..at].to_string(),
        _ => collapsed.chars().take(SUMMARY_LIMIT).collect(),
    };
    cut.trim_end_matches([',', ';', ':', '-', ' ']).to_string()
}

/// The checked answer as the commit form gets it. A summary with several lines keeps its first
/// non-empty line; the rest goes to the start of the body.
pub fn parse(value: &Value) -> CoreResult<AiCommitMessage> {
    let text = |key: &str| value.get(key).and_then(Value::as_str).unwrap_or("").replace("\r\n", "\n").replace('\r', "\n");
    let summary_text = text("summary");
    let mut lines = summary_text.lines().map(str::trim).filter(|line| !line.is_empty());
    let Some(first) = lines.next() else {
        return Err(CoreError::ai_invalid_answer("the summary is empty"));
    };
    let summary = fit_summary(first);
    let spill = lines.collect::<Vec<_>>().join("\n");
    let body_text = text("body");
    let body = body_text.lines().map(str::trim_end).collect::<Vec<_>>().join("\n");
    let parts: Vec<&str> = [spill.as_str(), body.trim_matches('\n')].into_iter().filter(|part| !part.trim().is_empty()).collect();
    Ok(AiCommitMessage { summary, body: (!parts.is_empty()).then(|| parts.join("\n\n")) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::schema::{check_dialect, validate};
    use crate::error::ErrorCode;
    use serde_json::json;

    #[test]
    fn the_answer_schema_is_in_the_dialect() {
        let schema = schema();
        assert_eq!(check_dialect(&schema), Ok(()));
        assert_eq!(validate(&schema, &json!({"summary": "Fix", "body": null})), Ok(()));
        assert!(validate(&schema, &json!({"summary": "Fix"})).is_err(), "body is required, as null");
        assert!(validate(&schema, &json!({"summary": "Fix", "body": null, "files": []})).is_err(), "nothing else");
    }

    #[test]
    fn long_summaries_are_cut_at_a_word_boundary() {
        assert_eq!(
            fit_summary("Vergleich der Tagesmittel für alle drei Schulstationen als CSV-Datei exportieren und danach prüfen"),
            "Vergleich der Tagesmittel für alle drei Schulstationen als CSV-Datei"
        );
        assert_eq!(
            fit_summary("Exportiere die Tagesmittel aller Stationen als CSV und ergänze die Hilfe dazu, damit es klar ist"),
            "Exportiere die Tagesmittel aller Stationen als CSV und ergänze die Hilfe",
            "exactly 72 characters fit, an umlaut is one character"
        );
        assert_eq!(fit_summary(&"A".repeat(80)), "A".repeat(72), "one long word is cut hard");
        assert_eq!(fit_summary("Add  the \t export"), "Add the export", "inner whitespace collapses");
        assert_eq!(fit_summary("Kurz"), "Kurz");
        for long in ["Vergleich der Tagesmittel für alle drei Schulstationen als CSV-Datei exportieren und danach prüfen", "x y ".repeat(40).as_str()] {
            assert!(fit_summary(long).chars().count() <= SUMMARY_LIMIT, "{long}");
        }
    }

    #[test]
    fn answers_become_one_summary_line_and_an_optional_body() {
        let parsed = |value: serde_json::Value| parse(&value).unwrap();
        assert_eq!(
            parsed(json!({"summary": "  Export der Tagesmittel als CSV  ", "body": null})),
            AiCommitMessage { summary: "Export der Tagesmittel als CSV".into(), body: None }
        );
        assert_eq!(
            parsed(json!({"summary": "Export ergänzt", "body": "Schreibt je Station eine Zeile.  \r\nMit Kopfzeile.\r\n\r\n"})).body.as_deref(),
            Some("Schreibt je Station eine Zeile.\nMit Kopfzeile."),
            "CRLF, trailing spaces and blank lines at the end go"
        );
        assert_eq!(
            parsed(json!({"summary": "Export ergänzt\n\nWeil die Auswertung ihn braucht.", "body": "Details."})),
            AiCommitMessage { summary: "Export ergänzt".into(), body: Some("Weil die Auswertung ihn braucht.\n\nDetails.".into()) },
            "a second line of the summary moves into the body"
        );
        assert_eq!(parsed(json!({"summary": "Fix", "body": "  - Punkt eins\n  - Punkt zwei"})).body.as_deref(), Some("  - Punkt eins\n  - Punkt zwei"), "indentation stays");
        assert_eq!(parsed(json!({"summary": "Fix", "body": "   \n "})).body, None, "a blank body is no body");
        assert_eq!(parsed(json!({"summary": "\n  \nFix", "body": null})).summary, "Fix");
        let error = parse(&json!({"summary": "  \n ", "body": "Nur Text"})).unwrap_err();
        assert_eq!(error.code, ErrorCode::AiInvalidAnswer);
    }
}
