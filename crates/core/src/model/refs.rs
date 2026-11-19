//! Refs

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RefKind {
    Local,
    Remote,
    Tag,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ref {
    pub name: String,
    pub full_name: String,
    pub kind: RefKind,
    pub sha: Sha,
    pub is_head: bool,
    pub upstream: Option<String>,
    pub upstream_gone: bool,
    /// Only for local branches with an upstream: see `UpstreamState::pushes_to_upstream`.
    pub pushes_to_upstream: bool,
    /// Only for local branches: see `Status::unpublished`.
    pub unpublished: Option<u32>,
    pub ahead: u32,
    pub behind: u32,
    pub remote: Option<String>,
    pub annotation: Option<String>,
    pub is_annotated: bool,
    pub worktree_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "spike.ts"))]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum Head {
    Branch {
        branch: String,
        sha: Sha,
    },
    Detached {
        sha: Sha,
    },
    /// Fresh repository without a commit.
    Unborn {
        branch: String,
    },
}

impl Head {
    /// The commit HEAD points to; `None` without a commit.
    pub fn sha(&self) -> Option<&str> {
        match self {
            Head::Branch { sha, .. } | Head::Detached { sha } => Some(sha),
            Head::Unborn { .. } => None,
        }
    }

    /// The checked-out branch (also without a commit); `None` when detached.
    pub fn branch(&self) -> Option<&str> {
        match self {
            Head::Branch { branch, .. } | Head::Unborn { branch } => Some(branch),
            Head::Detached { .. } => None,
        }
    }

    /// HEAD in the notation of the undo entries (`head_before`/`head_after`):
    /// `refs/heads/<branch>` when HEAD is on a branch (even without a commit), otherwise the SHA.
    pub fn token(&self) -> String {
        match self {
            Head::Branch { branch, .. } | Head::Unborn { branch } => format!("refs/heads/{branch}"),
            Head::Detached { sha } => sha.clone(),
        }
    }

    /// Name for messages: branch or short SHA.
    pub fn label(&self) -> String {
        match self {
            Head::Branch { branch, .. } | Head::Unborn { branch } => branch.clone(),
            Head::Detached { sha } => crate::git::rev::short(sha).to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefsSnapshot {
    pub head: Head,
    pub locals: Vec<Ref>,
    pub remotes: Vec<Ref>,
    pub tags: Vec<Ref>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemoteHost {
    Github,
    Gitlab,
    Bitbucket,
    Azure,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub name: String,
    pub fetch_url: String,
    pub push_url: Option<String>,
    pub host: RemoteHost,
}
