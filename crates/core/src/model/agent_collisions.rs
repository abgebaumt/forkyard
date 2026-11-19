//! Coding agents: collision warning

use super::*;

/// Lines of a file, 1-based and inclusive, counted in the version of the first side of a
/// collision (the agent started first; against the base: the agent).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "agent_collisions.ts"))]
#[serde(rename_all = "camelCase")]
pub struct LineRange {
    pub start: u32,
    pub end: u32,
}

/// `conflict`: Git's merge of both states stops on conflicts. `overlap`: both change the same
/// files, but they merge cleanly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "agent_collisions.ts"))]
#[serde(rename_all = "snake_case")]
pub enum CollisionKind {
    Conflict,
    Overlap,
}

/// A file of a collision; `ranges` only for conflicting text files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "agent_collisions.ts"))]
#[serde(rename_all = "camelCase")]
pub struct CollisionFile {
    pub path: String,
    pub conflict: bool,
    pub ranges: Vec<LineRange>,
}

/// Two coding agents – or an agent and the current tip of its base (`other_agent_id` null,
/// `base` its name) – whose work touches the same files. `agent_id` is the agent started first.
/// `id`: `<agent>+<other agent>` or `<agent>+base`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "agent_collisions.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AgentCollision {
    pub id: String,
    pub kind: CollisionKind,
    pub agent_id: String,
    pub other_agent_id: Option<String>,
    pub base: Option<String>,
    pub files: Vec<CollisionFile>,
}

/// An agent the check left out because its worktree or base could not be read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "agent_collisions.ts"))]
#[serde(rename_all = "camelCase")]
pub struct CollisionSkip {
    pub agent_id: String,
    pub reason: String,
}

/// `pending`: never checked; `checking`: a check runs (the last collisions stay);
/// `failed`: the check failed (`error`), no collisions.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "agent_collisions.ts"))]
#[serde(rename_all = "snake_case")]
pub enum CollisionCheckState {
    #[default]
    Pending,
    Checking,
    Done,
    Failed,
}

/// The last collision check of a repository's coding agents (event `agents:collisions`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "agent_collisions.ts"))]
#[serde(rename_all = "camelCase")]
pub struct CollisionReport {
    pub repo_id: String,
    pub state: CollisionCheckState,
    pub checked_at: Option<IsoTime>,
    pub error: Option<String>,
    pub collisions: Vec<AgentCollision>,
    pub skipped: Vec<CollisionSkip>,
}

/// One conflict of a file: where it sits (first side's lines) and what both sides wrote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "agent_collisions.ts"))]
#[serde(rename_all = "camelCase")]
pub struct CollisionBlock {
    pub range: LineRange,
    pub ours: String,
    pub theirs: String,
}

/// Both sides of every conflict of one file of a collision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "agent_collisions.ts"))]
#[serde(rename_all = "camelCase")]
pub struct CollisionPreview {
    pub collision_id: String,
    pub path: String,
    pub blocks: Vec<CollisionBlock>,
    pub truncated: bool,
}

#[cfg(test)]
mod collision_model_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn collision_types_have_the_contract_shape() {
        let collision = AgentCollision {
            id: "a+b".into(),
            kind: CollisionKind::Conflict,
            agent_id: "a".into(),
            other_agent_id: None,
            base: Some("main".into()),
            files: vec![CollisionFile { path: "src/auth.ts".into(), conflict: true, ranges: vec![LineRange { start: 40, end: 62 }] }],
        };
        assert_eq!(
            serde_json::to_value(&collision).unwrap(),
            json!({
                "id": "a+b", "kind": "conflict", "agentId": "a", "otherAgentId": null, "base": "main",
                "files": [{ "path": "src/auth.ts", "conflict": true, "ranges": [{ "start": 40, "end": 62 }] }]
            })
        );
        let report = CollisionReport { repo_id: "r".into(), ..Default::default() };
        assert_eq!(
            serde_json::to_value(&report).unwrap(),
            json!({ "repoId": "r", "state": "pending", "checkedAt": null, "error": null, "collisions": [], "skipped": [] })
        );
        let skip = CollisionSkip { agent_id: "d".into(), reason: "kaputt".into() };
        assert_eq!(serde_json::to_value(&skip).unwrap(), json!({ "agentId": "d", "reason": "kaputt" }));
        let preview = CollisionPreview {
            collision_id: "a+b".into(),
            path: "x".into(),
            blocks: vec![CollisionBlock { range: LineRange { start: 1, end: 1 }, ours: "a\n".into(), theirs: "b\n".into() }],
            truncated: false,
        };
        assert_eq!(
            serde_json::to_value(&preview).unwrap(),
            json!({ "collisionId": "a+b", "path": "x", "blocks": [{ "range": { "start": 1, "end": 1 }, "ours": "a\n", "theirs": "b\n" }], "truncated": false })
        );
        assert_eq!(serde_json::to_value(CollisionKind::Overlap).unwrap(), json!("overlap"));
        assert_eq!(serde_json::to_value(CollisionCheckState::Checking).unwrap(), json!("checking"));
        assert_eq!(serde_json::to_value(CollisionCheckState::Failed).unwrap(), json!("failed"));
    }
}
