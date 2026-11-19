//! Stacked pull requests

use super::*;

/// Where a part of a stack ends: after commit number `end` (1 = the oldest commit of the branch).
/// `name`: words for its branch name; empty = the subject of the part's first commit.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "stacks.ts"))]
#[serde(rename_all = "camelCase")]
pub struct StackCut {
    pub end: u32,
    pub name: String,
}

/// A commit of the branch being split, oldest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "stacks.ts"))]
#[serde(rename_all = "camelCase")]
pub struct StackCommit {
    pub sha: Sha,
    pub subject: String,
    pub files: u32,
    pub added: u64,
    pub deleted: u64,
}

/// A planned part: commits `first..=end` (1-based), its branch and why it can't be created yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "stacks.ts"))]
#[serde(rename_all = "camelCase")]
pub struct StackPart {
    pub number: u32,
    pub branch: String,
    pub first: u32,
    pub end: u32,
    pub tip: Sha,
    /// The name is taken, blocked by a folder of branches or invalid.
    pub problem: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "stacks.ts"))]
#[serde(rename_all = "camelCase")]
pub struct StackPlan {
    /// The branch being split (short name).
    pub branch: String,
    /// Full ref name of the base (`refs/heads/main`, `refs/remotes/origin/main`).
    pub base: String,
    /// The base's branch name on the host: the target of the first pull request.
    pub base_name: String,
    pub base_sha: Sha,
    pub tip: Sha,
    pub commits: Vec<StackCommit>,
    pub parts: Vec<StackPart>,
}

/// A part of an existing stack (from the parent links in `.git/config`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "stacks.ts"))]
#[serde(rename_all = "camelCase")]
pub struct StackStatusPart {
    pub branch: String,
    /// Full ref name of the part below (part 1: the base).
    pub parent: String,
    pub tip: Sha,
    /// The part still contains its parent's tip; `false` = it has to be restacked.
    pub contains_parent: bool,
    /// Checked out in this or another worktree.
    pub worktree_path: Option<String>,
    /// Subjects of the part's own commits, oldest first (at most 50).
    pub subjects: Vec<String>,
}

/// "Restack": rebase `top` onto `onto` with `--update-refs`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "stacks.ts"))]
#[serde(rename_all = "camelCase")]
pub struct StackRestack {
    pub onto: String,
    pub top: String,
    pub top_tip: Sha,
    /// Local branches Git moves along (`rebase_dependents`).
    pub moves: Vec<String>,
    /// Parts that would have to move but are checked out in a worktree: Git leaves them.
    pub left_behind: Vec<String>,
    /// Why it can't run here (the top part is checked out in another worktree).
    pub blocked: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "stacks.ts"))]
#[serde(rename_all = "camelCase")]
pub struct StackStatus {
    pub base: String,
    pub base_name: String,
    pub parts: Vec<StackStatusPart>,
    pub restack: Option<StackRestack>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "stacks.ts"))]
#[serde(rename_all = "snake_case")]
pub enum StackCheckState {
    Passed,
    Failed,
    TimedOut,
}

/// Result of the test command on one part, in its temporary worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "stacks.ts"))]
#[serde(rename_all = "camelCase")]
pub struct StackCheckResult {
    pub part: u32,
    pub tip: Sha,
    pub state: StackCheckState,
    pub exit_code: Option<i32>,
    /// The last 4 KiB of stdout and stderr, redacted.
    pub output: String,
    pub duration_ms: u64,
}

/// A pull request to open for a part.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "stacks.ts"))]
#[serde(rename_all = "camelCase")]
pub struct StackPrPart {
    pub branch: String,
    pub title: String,
    pub body: String,
    pub draft: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "stacks.ts"))]
#[serde(rename_all = "camelCase")]
pub struct StackPrCreated {
    pub part: u32,
    pub pr: PrSummary,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "stacks.ts"))]
#[serde(rename_all = "camelCase")]
pub struct StackPrFailed {
    pub part: u32,
    pub error: crate::error::CoreError,
}

/// What `stack_prs_create` did: the pull requests created in order, and the first failure (the
/// parts above it were not sent).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "stacks.ts"))]
#[serde(rename_all = "camelCase")]
pub struct StackPrOutcome {
    pub created: Vec<StackPrCreated>,
    pub failed: Option<StackPrFailed>,
}

/// A part the AI proposes: it ends after commit `end`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "stacks.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AiStackPart {
    pub end: u32,
    pub name: String,
    pub title: String,
    /// One sentence in the UI language: why this part stands on its own.
    pub why: String,
}

/// `aiStackSplit`: a suggestion only – nothing is created.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "stacks.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AiStackSplit {
    pub parts: Vec<AiStackPart>,
}

#[cfg(test)]
mod stats_json_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stats_range_reads_ref_and_stats_are_camel_case() {
        let range: StatsRange =
            serde_json::from_value(json!({ "from": "2025-06-01T00:00:00.000Z", "to": null, "ref": "refs/heads/main" })).unwrap();
        assert_eq!(range, StatsRange { from: Some("2025-06-01T00:00:00.000Z".into()), to: None, reference: "refs/heads/main".into() });
        assert_eq!(serde_json::to_value(&range).unwrap()["ref"], "refs/heads/main");

        let stats = RepoStats {
            code_age: StatsCodeAge { half_year: 4, two_years: 5, ..StatsCodeAge::default() },
            folders: vec![StatsFolder { path: String::new(), main_share: 45, bus_factor: 2, ..StatsFolder::default() }],
            ..RepoStats::default()
        };
        let v = serde_json::to_value(&stats).unwrap();
        assert_eq!(v["codeAge"]["halfYear"], 4);
        assert_eq!(v["codeAge"]["twoYears"], 5);
        assert_eq!(v["folders"][0]["mainShare"], 45);
        assert_eq!(v["folders"][0]["busFactor"], 2);
        assert!(v["folders"][0]["mainAuthor"].is_object());
        assert!(v["folders"][0]["top"].is_array());
        assert!(v["records"]["longestStreak"].is_null());
        assert!(v["tip"].is_null() && v["referenceTime"].is_null() && v["firstAt"].is_null());
        for key in ["heatmap", "weeks", "months", "authors", "files", "hotspots", "folders"] {
            assert!(v[key].is_array(), "{key}");
        }
        assert_eq!((v["authorCount"].clone(), v["fileCount"].clone(), v["cached"].clone()), (json!(0), json!(0), json!(false)));
        let back: RepoStats = serde_json::from_value(v).unwrap();
        assert_eq!(back, stats);
    }
}
