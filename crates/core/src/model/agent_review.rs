//! Review of a coding agent's work

use super::*;

/// Which state of a coding agent its review compares with the base.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "agent_review.ts"))]
#[serde(rename_all = "snake_case")]
pub enum AgentReviewSource {
    /// The agent's working state: its commits plus uncommitted and new files (a snapshot commit).
    #[default]
    Snapshot,
    /// Only what the agent committed on its branch.
    Branch,
}

/// The two commits the review of an agent compares, and what the review's actions need to know.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "agent_review.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AgentReview {
    pub agent_id: String,
    /// The repository the agent belongs to (where the takeover lands).
    pub repo_id: String,
    /// Repository row of the agent's worktree; `None` if its folder has none.
    pub worktree_repo_id: Option<String>,
    /// The effective source: `Snapshot` only if the worktree differs from its HEAD.
    pub source: AgentReviewSource,
    /// The fork point (`git merge-base` of the base and `to`).
    pub from: String,
    /// The agent's state: the snapshot commit or the branch tip.
    pub to: String,
    /// The branch tip.
    pub tip: String,
    /// The agent's base as it was chosen at the start (e.g. `main`).
    pub base: String,
    /// Files of the worktree that differ from its HEAD (uncommitted, including new ones).
    pub uncommitted_files: u32,
    /// The agent's program is running.
    pub running: bool,
}

#[cfg(test)]
mod agent_review_json_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_review_is_camel_case_and_its_source_snake_case() {
        let review = AgentReview {
            agent_id: "agent-liste".into(),
            repo_id: "r1".into(),
            worktree_repo_id: None,
            source: AgentReviewSource::Snapshot,
            from: "a".repeat(40),
            to: "b".repeat(40),
            tip: "c".repeat(40),
            base: "main".into(),
            uncommitted_files: 2,
            running: true,
        };
        assert_eq!(
            serde_json::to_value(&review).unwrap(),
            json!({
                "agentId": "agent-liste", "repoId": "r1", "worktreeRepoId": null, "source": "snapshot",
                "from": "a".repeat(40), "to": "b".repeat(40), "tip": "c".repeat(40), "base": "main",
                "uncommittedFiles": 2, "running": true,
            })
        );
        assert_eq!(serde_json::from_value::<AgentReviewSource>(json!("branch")).unwrap(), AgentReviewSource::Branch);
        assert_eq!(AgentReviewSource::default(), AgentReviewSource::Snapshot);
    }
}

#[cfg(test)]
mod conflict_intent_json_tests {
    use super::*;
    use serde_json::json;

    /// The UI sends line ranges and gets explanations and proposals back in exactly this shape.
    #[test]
    fn conflict_intent_types_have_their_wire_shape() {
        let input: AiInput = serde_json::from_value(json!({
            "kind": "conflict_intent",
            "path": "src/-anmeldung ä.txt",
            "blocks": [{ "oursStart": 1, "oursCount": 0, "theirsStart": 1, "theirsCount": 2 }]
        }))
        .unwrap();
        assert_eq!(
            input,
            AiInput::ConflictIntent {
                path: "src/-anmeldung ä.txt".into(),
                blocks: vec![ConflictBlockRange { ours_start: 1, ours_count: 0, theirs_start: 1, theirs_count: 2 }]
            }
        );
        assert_eq!(
            serde_json::to_value(AiInput::StagedChanges).unwrap(),
            json!({ "kind": "staged_changes" }),
            "the variant of 1a keeps its shape"
        );

        let intent = ConflictIntent {
            path: "a.txt".into(),
            blocks: vec![
                ConflictIntentBlock { block: 0, sent: IntentSent::LeftOut, ours_why: None, theirs_why: None, text: None },
                ConflictIntentBlock {
                    block: 1,
                    sent: IntentSent::Full,
                    ours_why: Some("x".into()),
                    theirs_why: Some("y".into()),
                    text: Some("z\n".into()),
                },
            ],
        };
        assert_eq!(
            serde_json::to_value(&intent).unwrap(),
            json!({
                "path": "a.txt",
                "blocks": [
                    { "block": 0, "sent": "left_out", "oursWhy": null, "theirsWhy": null, "text": null },
                    { "block": 1, "sent": "full", "oursWhy": "x", "theirsWhy": "y", "text": "z\n" }
                ]
            })
        );
        for sent in ["full", "shortened", "redacted", "left_out"] {
            assert!(serde_json::from_value::<IntentSent>(json!(sent)).is_ok(), "{sent}");
        }
        assert!(
            serde_json::from_value::<ConflictBlockRange>(json!({ "oursStart": -1, "oursCount": 0, "theirsStart": 0, "theirsCount": 0 }))
                .is_err(),
            "no negative line numbers"
        );
    }
}
