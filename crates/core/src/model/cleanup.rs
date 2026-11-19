//! Repository clean-up (`repoCleanupPreview`, `repoCleanupLfsEstimate`, `repoCleanupRun`)

use super::*;

/// Numbers from `git count-objects -v`, with Git's KiB values converted to bytes.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectStats {
    /// Loose objects (`count`).
    pub loose_count: u64,
    /// `size` × 1024.
    pub loose_bytes: u64,
    /// Objects in packs (`in-pack`).
    pub in_pack: u64,
    pub packs: u64,
    /// `size-pack` × 1024.
    pub pack_bytes: u64,
    /// Files in the object folder Git does not recognize (`garbage`).
    pub garbage_count: u64,
    /// `size-garbage` × 1024.
    pub garbage_bytes: u64,
    /// Loose + packs + garbage: “Git objects in total”.
    pub total_bytes: u64,
}

/// An undo backup: an undo entry of the repository (or one of its worktrees), or a group of
/// `refs/forkyard/undo/<id>/…` without an entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupUndoBackup {
    pub entry_id: Id,
    /// Entry: when it was recorded. Orphaned: newest committer date of its refs; `None` if no ref
    /// points to a commit – such a backup counts as older than any limit.
    pub created_at: Option<IsoTime>,
    /// No undo entry in the database.
    pub orphaned: bool,
}

/// What the clean-up dialog shows before anything runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupPreview {
    pub objects: ObjectStats,
    /// Bytes in the LFS object folder; `None` if Git LFS is not installed or the repository does not use it.
    pub lfs_bytes: Option<u64>,
    pub undo_backups: Vec<CleanupUndoBackup>,
    /// Worktrees whose folder is missing (`git worktree list`: prunable).
    pub orphaned_worktrees: u32,
    /// Other working directories that share this repository (without missing ones).
    pub linked_worktrees: u32,
    /// Reflog entries older than 90 days; `None` = not counted within the time budget.
    pub old_reflog_entries: Option<u64>,
    /// Free space on the disk of the Git directory; `None` if unknown.
    pub free_bytes: Option<u64>,
}

/// What `git lfs prune` would free (from `git lfs prune --dry-run`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupLfsEstimate {
    pub files: u64,
    pub bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CleanupMode {
    /// `git gc`.
    Normal,
    /// `git gc --aggressive --prune=now`.
    Thorough,
}

/// The choices of the clean-up dialog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupOptions {
    pub mode: CleanupMode,
    /// `git lfs prune`.
    pub lfs: bool,
    /// `git worktree prune`.
    pub worktrees: bool,
    /// Remove undo backups older than this many days (1–3650); `None` = keep them.
    pub undo_older_than_days: Option<u32>,
    /// `git reflog expire --expire=90.days.ago --expire-unreachable=90.days.ago --all`.
    pub reflog: bool,
}

/// The steps of a run, in the order they run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CleanupStep {
    Worktrees,
    Undo,
    Reflog,
    Lfs,
    Gc,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CleanupStepStatus {
    Done,
    /// Not chosen, or nothing to do (Git LFS not installed).
    Skipped,
    Failed,
    /// The cancel arrived while this step ran.
    Cancelled,
    /// Not started after a failure or a cancel.
    NotRun,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupStepResult {
    pub step: CleanupStep,
    pub status: CleanupStepStatus,
    /// How many were removed, where the step can say (worktrees, undo backups).
    pub removed: Option<u64>,
}

/// The step that failed and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupFailure {
    pub step: CleanupStep,
    pub error: CoreError,
    /// Another `git gc` runs: its process ID.
    pub gc_pid: Option<u32>,
    /// The disk is full.
    pub disk_full: bool,
}

/// Outcome of `repoCleanupRun`; also after a cancel or a failed step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResult {
    pub before: ObjectStats,
    pub after: ObjectStats,
    /// LFS object folder before/after, only when the LFS step was chosen.
    pub lfs_before: Option<u64>,
    pub lfs_after: Option<u64>,
    /// All five steps in their order.
    pub steps: Vec<CleanupStepResult>,
    pub duration_ms: u64,
    pub cancelled: bool,
    pub failure: Option<CleanupFailure>,
}

/// A lock on a file at the LFS server (`git lfs locks --verify`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsLock {
    /// The server's ID of the lock.
    pub id: String,
    /// Relative to the repository root, with `/`.
    pub path: String,
    /// Name of the owner as the server reports it; empty if it reports none.
    pub owner: String,
    /// When the lock was set, as the server reports it (usually ISO 8601); `None` if unknown.
    pub locked_at: Option<IsoTime>,
    /// Held by the signed-in user – the server decides that (`--verify`).
    pub ours: bool,
}

/// Result of `lfs_locks`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsLockList {
    /// Sorted by path.
    pub locks: Vec<LfsLock>,
    /// When the list was read from the server (UTC).
    pub fetched_at: IsoTime,
}

/// A path that `lfs_lock` / `lfs_unlock` could not lock or unlock.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsLockFailure {
    pub path: String,
    /// Git LFS's reason (English, without credentials), e.g. "already created lock".
    pub reason: String,
}

/// Result of `lfs_lock` / `lfs_unlock`: the fresh list from the server plus what failed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsLockOutcome {
    pub locks: LfsLockList,
    pub failed: Vec<LfsLockFailure>,
}

/// Result of `patch_create`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchText {
    /// The patch; empty if there is nothing to show.
    pub text: String,
    /// Files that are missing because they are binary or their diff is not valid UTF-8.
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SigningFormat {
    Openpgp,
    Ssh,
    X509,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SigningStatus {
    /// `commit.gpgSign`
    pub enabled: bool,
    /// `gpg.format`; `None` = not set (Git uses OpenPGP).
    pub format: Option<SigningFormat>,
    /// `user.signingKey`
    pub key: Option<String>,
    /// `gpg.program`, `gpg.ssh.program` or `gpg.x509.program` – depending on the format.
    pub program: Option<String>,
    /// `gpg.ssh.allowedSignersFile` (for verifying SSH signatures).
    #[serde(default)]
    pub allowed_signers_file: Option<String>,
}
