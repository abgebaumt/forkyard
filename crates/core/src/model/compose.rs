//! Compose commits

use super::*;

/// What one unit of "Compose commits" is: one hunk of a text file or a whole file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "compose.ts"))]
#[serde(rename_all = "snake_case")]
pub enum ComposeUnitKind {
    Hunk,
    /// A text file that is not split (beyond `MAX_SPLIT_FILES`, or without hunks).
    File,
    Added,
    Deleted,
    Renamed,
    Binary,
    Submodule,
    Lfs,
    /// File mode or type changed.
    Mode,
    /// Symbolic link.
    Link,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "compose.ts"))]
#[serde(rename_all = "camelCase")]
pub struct ComposeUnit {
    /// `<path>#<hunk index>@<token>`; whole files `<path>#file@<token>`.
    pub id: String,
    pub path: String,
    pub old_path: Option<String>,
    pub kind: ComposeUnitKind,
    pub hunk_index: Option<u32>,
    /// `@@ -a,b +c,d @@ section` as `git diff` prints it; empty for whole files.
    pub header: String,
    pub added: u32,
    pub removed: u32,
    /// For display only, at most `MAX_UNIT_LINES`; the commit always takes the whole unit.
    pub lines: Vec<DiffLine>,
    pub lines_cut: bool,
    /// Units this one needs to build ("doesn't build on its own" when they come later or not at
    /// all); found by fixed rules, never by the AI.
    pub requires: Vec<String>,
    /// Secret or excluded from AI (`.env.local`, `.forkyard/ai-ignore`): never sent, never
    /// committed by "Compose commits"; it stays in "Don't commit".
    pub protected: Option<AiOmitReason>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "compose.ts"))]
#[serde(rename_all = "camelCase")]
pub struct ComposeState {
    /// Over HEAD, the index and the working directory; `compose_apply` expects it back.
    pub token: String,
    pub branch: String,
    pub head: Sha,
    /// Subject of HEAD, the start of the history preview.
    pub head_subject: String,
    pub units: Vec<ComposeUnit>,
    /// `commit.gpgSign` is on: one passphrase prompt per commit is possible.
    pub signing: bool,
    /// Commit hooks of the repository that run for every commit ("pre-commit", "commit-msg" …).
    pub hooks: Vec<String>,
}

/// A commit of a proposal or a plan: message and the unit IDs it takes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "compose.ts"))]
#[serde(rename_all = "camelCase")]
pub struct ComposeGroup {
    pub title: String,
    pub body: String,
    pub units: Vec<String>,
    /// The AI provider's short reason why these changes form one commit; empty in a plan.
    #[serde(default)]
    #[cfg_attr(feature = "ts", ts(optional = nullable))]
    pub reason: String,
}

/// The AI provider's note on one unit it placed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "compose.ts"))]
#[serde(rename_all = "camelCase")]
pub struct ComposeNote {
    pub unit: String,
    /// One short sentence: why the unit is in its commit.
    pub reason: String,
    /// Another commit (or not committing) would have been as plausible.
    pub unsure: bool,
}

/// A unit the user placed: a new proposal leaves it where it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "compose.ts"))]
#[serde(rename_all = "camelCase")]
pub struct ComposeKeep {
    pub unit: String,
    /// Summary of the commit it is in; `None` = "Don't commit".
    pub commit: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "compose.ts"))]
#[serde(rename_all = "camelCase")]
pub struct ComposeProposal {
    pub state: ComposeState,
    /// In creation order; units in no group stay uncommitted. Kept units are in no group.
    pub groups: Vec<ComposeGroup>,
    /// Per placed unit, in the order of the answer.
    pub notes: Vec<ComposeNote>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "compose.ts"))]
#[serde(rename_all = "camelCase")]
pub struct ComposePlan {
    /// In creation order (the first is the oldest).
    pub commits: Vec<ComposeGroup>,
    pub skip_hooks: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "compose.ts"))]
#[serde(rename_all = "camelCase")]
pub struct ComposeResult {
    /// The new commits, oldest first.
    pub commits: Vec<Sha>,
    pub hooks: Vec<HookOutput>,
    /// Per new commit, oldest first: the hooks that ran for it.
    pub steps: Vec<ComposeStep>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "compose.ts"))]
#[serde(rename_all = "camelCase")]
pub struct ComposeStep {
    pub sha: Sha,
    pub hooks: Vec<String>,
}
