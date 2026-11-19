//! Results of write actions

use super::*;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookOutput {
    pub hook: String,
    pub output: String,
    pub exit_code: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    pub sha: Sha,
    pub push: Option<PushResult>,
    pub hooks: Vec<HookOutput>,
}

/// Result of merge, rebase, cherry-pick, revert, pull, stash apply.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum OpResult {
    Done {
        sha: Option<Sha>,
        fast_forward: bool,
        summary: String,
    },
    UpToDate,
    /// `note`: ready-made note on this conflict (e.g. that the stash is kept),
    /// otherwise `None`.
    Conflict {
        files: Vec<String>,
        operation: Option<Operation>,
        note: Option<String>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MergeMode {
    Default,
    FfOnly,
    NoFf,
    Squash,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PullMode {
    Ff,
    FfOnly,
    Rebase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResetMode {
    Soft,
    Mixed,
    Hard,
}

/// A further branch or tag for the same push (`push` with `extra`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushExtra {
    /// Full local ref: `refs/heads/<branch>` or `refs/tags/<tag>`.
    pub local: String,
    /// Name on the remote without `refs/heads/` / `refs/tags/`; `None` = the same name.
    pub remote_name: Option<String>,
    /// Branches only: overwrite with `--force-with-lease` (against the tracking ref).
    pub force: bool,
    /// With `force` only: the remote tip the prompt showed; the lease uses it instead of the
    /// tracking ref. `None` = lease against the tracking ref.
    #[serde(default)]
    pub expected: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PushRefStatus {
    Ok,
    UpToDate,
    Rejected,
}

/// Result of one ref in a push with several refs (from `git push --porcelain`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PushRefResult {
    pub local: String,
    /// Full ref on the remote.
    pub remote_ref: String,
    pub status: PushRefStatus,
    pub forced: bool,
    /// Git's reason for a rejection, e.g. "non-fast-forward", "atomic push failed".
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum PushResult {
    Done {
        remote: String,
        branch: String,
        created_upstream: bool,
        forced: bool,
    },
    UpToDate,
    /// The remote has commits that are missing locally.
    Rejected {
        reason: String,
    },
    /// Several refs in one push (`extra`): one result per ref, the primary branch first.
    Multi {
        remote: String,
        atomic: bool,
        refs: Vec<PushRefResult>,
    },
    /// The local secret scan found added lines that look like a key; nothing was sent. Push again
    /// with `accepted_secrets` = the IDs of these findings to push anyway.
    SecretsFound {
        findings: Vec<SecretFinding>,
        commits: u32,
        partial: bool,
    },
}

/// Why the local secret scan before a push reported a line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecretRule {
    /// A token or key with a well-known prefix.
    KnownToken,
    /// The first line of a private key.
    PrivateKey,
    /// The value of a password, token or secret named as such.
    Credential,
    /// The password in an address `scheme://user:password@host`.
    UrlPassword,
    /// A random-looking string in quotes or after `=` / `:`.
    HighEntropy,
}

/// One added line that looks like a key. The value never leaves the core: `excerpt` is the line
/// with every value masked, `hint` at most its last four characters.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretFinding {
    /// SHA-256 (hex) of path and line content; "Don't report again" stores it.
    pub id: String,
    pub path: String,
    /// Line in the new version of the file (1-based).
    pub line: u32,
    /// The newest outgoing commit that adds this line.
    pub commit: String,
    pub rule: SecretRule,
    pub excerpt: String,
    pub hint: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchFailure {
    pub remote: String,
    pub message: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchResult {
    pub updated_refs: u32,
    pub pruned_refs: u32,
    pub failed: Vec<FetchFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub path: String,
    pub kind: ConflictKind,
    pub base: Option<String>,
    pub ours: Option<String>,
    pub theirs: Option<String>,
    pub merged: Option<String>,
    pub is_binary: bool,
    pub ours_label: String,
    pub theirs_label: String,
    /// `None` for binary files.
    pub encoding: Option<String>,
}
