//! Gitflow

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GitflowKind {
    Feature,
    Release,
    Hotfix,
}

/// Prefixes as in the `gitflow.prefix.*` keys of the Git configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitflowPrefixes {
    pub feature: String,
    pub release: String,
    pub hotfix: String,
    /// Prefix of the version tags (`gitflow.prefix.versiontag`), often empty or "v".
    pub version_tag: String,
}

impl Default for GitflowPrefixes {
    fn default() -> Self {
        GitflowPrefixes { feature: "feature/".into(), release: "release/".into(), hotfix: "hotfix/".into(), version_tag: String::new() }
    }
}

/// A running feature, release or hotfix branch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitflowBranch {
    pub kind: GitflowKind,
    /// Name without prefix.
    pub name: String,
    /// Full branch name (prefix + name).
    pub branch: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitflowStatus {
    /// `gitflow.branch.master` and `gitflow.branch.develop` are set.
    pub initialized: bool,
    /// Set up: the value from the configuration; otherwise a suggestion for the setup.
    pub main: String,
    pub develop: String,
    pub prefixes: GitflowPrefixes,
    pub active: Vec<GitflowBranch>,
}

/// Options of `gitflow_finish`; every field may be missing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GitflowFinishOptions {
    /// Delete the feature, release or hotfix branch afterwards (default: yes).
    pub delete_branch: bool,
    /// Release and hotfix only: name of the tag; `None` = version prefix + name.
    pub tag: Option<String>,
    /// Release and hotfix only: message of the (annotated) tag.
    pub message: Option<String>,
    /// Push the affected branches and the tag afterwards.
    pub push: bool,
    /// Release and hotfix only: do not create a tag.
    pub no_tag: bool,
}

impl Default for GitflowFinishOptions {
    fn default() -> Self {
        GitflowFinishOptions { delete_branch: true, tag: None, message: None, push: false, no_tag: false }
    }
}
