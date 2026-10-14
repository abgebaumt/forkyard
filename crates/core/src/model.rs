//! Data types between UI and core – mirror of src/core/types.ts.
//!
//! Rules: structs with `rename_all = "camelCase"`; enums with snake_case values;
//! unions as internally tagged enums with the field `kind` (results: `status`).
//! `Option<T>` is written as `null`, like `T | null` in TypeScript.
//! Whoever changes something here changes types.ts in the same step.

use serde::{Deserialize, Serialize};

pub type Id = String;
pub type Sha = String;
/// UTC, ISO-8601 with `Z`.
pub type IsoTime = String;

// ---------------------------------------------------------------------------
// App, Repositories, Tabs
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Platform {
    Windows,
    Linux,
    Macos,
}

impl Platform {
    pub fn current() -> Self {
        if cfg!(windows) {
            Platform::Windows
        } else if cfg!(target_os = "macos") {
            Platform::Macos
        } else {
            Platform::Linux
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub platform: Platform,
    pub git_version: Option<String>,
    pub git_path: Option<String>,
    pub git_min_version: String,
    pub data_dir: String,
    pub keyring_available: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Repo {
    pub id: Id,
    pub path: String,
    pub name: String,
    pub alias: Option<String>,
    pub is_favorite: bool,
    pub group_name: Option<String>,
    /// Lane colour 1–8 or null.
    pub color: Option<u8>,
    pub last_opened_at: Option<IsoTime>,
    pub missing: bool,
    /// `false`: the repository brings its own commands (hooks, entries in `.git/config`) and
    /// the user has not agreed yet. Until then the core rejects every command for this
    /// repository with `repo_untrusted`; `repo_trust_get` lists what was found.
    pub trusted: bool,
}

/// What would start programs or redirect connections in a repository without the user doing
/// anything.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TrustFindingKind {
    /// Entry in the repository's configuration (`.git/config`).
    Config,
    /// Executable hook in the hooks folder.
    Hook,
    /// The configuration could not be read.
    Unreadable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrustFinding {
    pub kind: TrustFindingKind,
    /// Configuration key (`core.fsmonitor`) or name of the hook (`pre-commit`).
    pub name: String,
    /// Value of the entry, shortened and without credentials; `None` for hooks.
    pub value: Option<String>,
    /// One sentence on what it does.
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoTrust {
    pub repo_id: Id,
    pub trusted: bool,
    /// What the check currently finds (also for a trusted repository).
    pub findings: Vec<TrustFinding>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TabKind {
    Repo,
    Management,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tab {
    pub id: Id,
    pub kind: TabKind,
    pub repo_id: Option<Id>,
    pub position: u32,
    pub is_active: bool,
    pub title: String,
    pub path: Option<String>,
}

/// A profile, only for naming it (e.g. "belongs to …").
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRef {
    pub id: Id,
    pub name: String,
    /// Lane colour 1 to 8; `None` = by position.
    pub color: Option<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedRepo {
    pub repo: Repo,
    pub tab: Tab,
    /// Something succeeded, but not completely (e.g. `repo_init`: the repository is created, a
    /// hook rejected the first commit). The UI shows this as a warning.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notice: Option<OpenNotice>,
}

/// Note on an `OpenedRepo`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenNotice {
    /// Human-readable sentence: what is missing and why.
    pub message: String,
    /// Output of Git or of the hook, if there was any.
    pub output: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneOptions {
    pub depth: Option<u32>,
    pub shallow_since: Option<String>,
    pub branch: Option<String>,
    #[serde(default)]
    pub sparse_paths: Vec<String>,
    #[serde(default)]
    pub recurse_submodules: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitOptions {
    pub parent_path: String,
    pub name: String,
    pub default_branch: Option<String>,
    pub gitignore_template: Option<String>,
    pub license_template: Option<String>,
    pub create_readme: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateOption {
    pub key: String,
    pub label: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InitTemplates {
    pub gitignore: Vec<TemplateOption>,
    pub licenses: Vec<TemplateOption>,
}

/// Request from outside: open this folder (and show the commit). The path is checked
/// (existing folder, complete), the commit is a SHA or `None`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRequest {
    pub path: String,
    pub commit: Option<Sha>,
    /// `true`: the request came as a `forkyard://` link – so possibly from a web page and
    /// not from the user. The UI then asks before it opens a folder that is
    /// not already in the list.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub from_link: bool,
    /// Why the request cannot be carried out; `None` = valid. `path` is then the
    /// path as it was requested (for display), and there is nothing to open.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invalid: Option<LaunchInvalid>,
}

/// Reason why a request from outside cannot be carried out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LaunchInvalid {
    /// The folder does not exist (or it is a file whose folder is missing).
    PathNotFound,
    /// A link names a network or device path (`\\server\…`, `\\?\…`). The app never opens such
    /// paths from a link and does not touch them either.
    PathNotAllowed,
}

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

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
    pub ahead: u32,
    pub behind: u32,
    pub remote: Option<String>,
    pub annotation: Option<String>,
    pub is_annotated: bool,
    pub worktree_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum Head {
    Branch { branch: String, sha: Sha },
    Detached { sha: Sha },
    /// Fresh repository without a commit.
    Unborn { branch: String },
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

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefLabelInfo {
    pub kind: RefKind,
    pub name: String,
    pub full_name: String,
    pub is_head: bool,
}

/// Line segment in the vertical band of a row; `None` = starts/ends at the node.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub top: Option<u32>,
    pub bottom: Option<u32>,
    pub color: u32,
    pub dashed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GraphRowKind {
    Commit,
    Merge,
    Wip,
    Stash,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphRow {
    pub id: String,
    pub kind: GraphRowKind,
    pub sha: Option<Sha>,
    pub lane: u32,
    pub color: u32,
    pub edges: Vec<GraphEdge>,
    pub parents: Vec<Sha>,
    pub summary: String,
    pub author_name: String,
    pub author_email: String,
    pub authored_at: Option<IsoTime>,
    pub refs: Vec<RefLabelInfo>,
    pub is_head: bool,
    pub stash_index: Option<u32>,
    pub wip_count: Option<u32>,
    /// Only for merges: collapsed, with this many commits hidden below it; `None` = expanded.
    pub collapsed_count: Option<u32>,
    /// The merge is meant to be collapsed but brings in more than 20 000 commits: it stays expanded.
    pub collapse_too_large: bool,
    /// Commit of the checked-out branch not pushed yet, or of its upstream not pulled yet.
    pub sync: SyncMark,
}

/// Position of a commit relative to the checked-out branch and its upstream.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SyncMark {
    #[default]
    None,
    /// In the branch, not in its upstream (not pushed yet).
    Ahead,
    /// In the upstream, not in the branch (not pulled yet).
    Behind,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphPage {
    pub rows: Vec<GraphRow>,
    pub next_cursor: Option<String>,
    pub max_lane: u32,
}

/// What a reflog entry records, from the start of its message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReflogAction {
    Checkout,
    Commit,
    Reset,
    Rebase,
    Merge,
    Pull,
    CherryPick,
    Amend,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflogEntry {
    /// Where the ref pointed after the change.
    pub sha: Sha,
    /// `HEAD@{3}`, `main@{0}` …
    pub selector: String,
    pub action: ReflogAction,
    /// Git's text, without credentials.
    pub message: String,
    pub time: IsoTime,
    /// The commit still exists (Git may have removed it, e.g. after `gc`).
    pub exists: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflogPage {
    pub entries: Vec<ReflogEntry>,
    /// null when the reflog has ended.
    pub next_cursor: Option<String>,
}

// ---------------------------------------------------------------------------
// Commits and files
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub name: String,
    pub email: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SignatureStatus {
    None,
    Good,
    Bad,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub sha: Sha,
    pub parents: Vec<Sha>,
    pub author: Person,
    pub committer: Person,
    pub authored_at: IsoTime,
    pub committed_at: IsoTime,
    pub author_offset_minutes: i32,
    pub summary: String,
    pub description: String,
    pub co_authors: Vec<Person>,
    pub signature: SignatureStatus,
    pub refs: Vec<RefLabelInfo>,
    pub is_head: bool,
    pub is_pushed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileStatus {
    Modified,
    Added,
    Deleted,
    Renamed,
    Conflicted,
    Untracked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileArea {
    Unstaged,
    Staged,
    Commit,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictKind {
    BothModified,
    BothAdded,
    BothDeleted,
    DeletedByUs,
    DeletedByThem,
    AddedByUs,
    AddedByThem,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub area: FileArea,
    pub is_binary: bool,
    pub is_lfs: bool,
    pub added: Option<u32>,
    pub removed: Option<u32>,
    pub conflict: Option<ConflictKind>,
}

/// What `commit_details` and `diff_file` compare.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum DiffSource {
    Unstaged,
    Staged,
    /// A commit against its first parent.
    Commit { sha: Sha },
    /// Two commits; `to: None` means working directory.
    Range { from: Sha, to: Option<Sha> },
    Stash { index: u32 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetails {
    pub commit: Option<CommitInfo>,
    pub files: Vec<FileChange>,
    pub added: u32,
    pub removed: u32,
    pub not_combinable_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    pub sha: Sha,
    pub summary: String,
    pub author: Person,
    pub authored_at: IsoTime,
    pub parents: Vec<Sha>,
}

// ---------------------------------------------------------------------------
// Status and running operations
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationKind {
    Merge,
    Rebase,
    CherryPick,
    Revert,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Operation {
    pub kind: OperationKind,
    pub source: Option<String>,
    pub target: Option<String>,
    pub step: Option<u32>,
    pub total_steps: Option<u32>,
    pub message: Option<String>,
}

/// Verdict on a commit during a bisect.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BisectVerdict {
    Good,
    Bad,
    Skip,
}

/// State of a bisect, read from the Git directory (`active: false` = none running).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BisectStatus {
    pub active: bool,
    pub bad: Option<Sha>,
    pub good: Vec<Sha>,
    pub skipped: Vec<Sha>,
    /// The commit to test now (HEAD; with `--no-checkout` BISECT_HEAD).
    pub current: Option<Sha>,
    /// Git's estimate of the steps after this one; `None` until a bad and a good commit are known.
    pub remaining_steps: Option<u32>,
    /// Commits marked since the start.
    pub steps_done: u32,
    /// The first bad commit, as soon as it is certain.
    pub result: Option<Sha>,
    /// Only skipped commits are left between good and bad: the first bad one is among them.
    pub only_skipped_left: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamState {
    pub name: String,
    pub ahead: u32,
    pub behind: u32,
    pub gone: bool,
}

/// Commits that after a checkout are only reachable by their SHA.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeftBehind {
    /// The commit that was left (HEAD before the switch).
    pub sha: Sha,
    /// This many commits are not attached to any ref.
    pub count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub head: Head,
    pub upstream: Option<UpstreamState>,
    pub unstaged: Vec<FileChange>,
    pub staged: Vec<FileChange>,
    pub conflicted: Vec<FileChange>,
    pub operation: Option<Operation>,
    /// Paths whose conflict in the running operation is already resolved (read from the index,
    /// `git ls-files --resolve-undo`) – for "N of M conflicts resolved", also after a restart.
    #[serde(default)]
    pub resolved_conflicts: Vec<String>,
    /// An operation the app does not control holds the repository in an intermediate state:
    /// `"am"` = a `git am` (applying patches) started outside waits to be continued or
    /// aborted. `operation` is then `None`.
    #[serde(default)]
    pub foreign_operation: Option<String>,
    /// Only in the response of `branch_checkout`: the switch left a detached HEAD whose
    /// commits are not attached to any branch, tag or remote branch.
    #[serde(default)]
    pub left_behind: Option<LeftBehind>,
    pub identity_set: bool,
    /// Fingerprint of HEAD and index (for `stale_state` checks).
    pub token: String,
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffLineKind {
    Context,
    Add,
    Remove,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub old_no: Option<u32>,
    pub new_no: Option<u32>,
    pub text: String,
    pub no_newline: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hunk {
    pub index: u32,
    pub old_start: u32,
    pub old_lines: u32,
    pub new_start: u32,
    pub new_lines: u32,
    pub section: String,
    pub lines: Vec<DiffLine>,
}

/// Content of the variant `{ kind: "text" }` of `FileDiff` (without the field `kind`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextDiff {
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub hunks: Vec<Hunk>,
    pub old_text: Option<String>,
    pub new_text: Option<String>,
    pub encoding: String,
    pub token: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum FileDiff {
    Text(TextDiff),
    Binary {
        path: String,
        old_path: Option<String>,
        status: FileStatus,
        old_size: Option<u64>,
        new_size: Option<u64>,
    },
    Image {
        path: String,
        old_path: Option<String>,
        status: FileStatus,
        old_data_url: Option<String>,
        new_data_url: Option<String>,
        old_size: Option<u64>,
        new_size: Option<u64>,
    },
    Lfs {
        path: String,
        old_path: Option<String>,
        status: FileStatus,
        old_oid: Option<String>,
        new_oid: Option<String>,
        old_size: Option<u64>,
        new_size: Option<u64>,
    },
    /// Over 1 MB or 20,000 lines: only load with `force`.
    TooLarge {
        path: String,
        old_path: Option<String>,
        status: FileStatus,
        bytes: u64,
        lines: Option<u64>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HunkSelection {
    pub index: u32,
    /// Positions in `Hunk.lines` (add/remove only). `None` = the whole hunk.
    pub lines: Option<Vec<u32>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PatchSelection {
    pub path: String,
    pub hunks: Vec<HunkSelection>,
    pub expect: String,
}

// ---------------------------------------------------------------------------
// Results of write actions
// ---------------------------------------------------------------------------

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
    Done { sha: Option<Sha>, fast_forward: bool, summary: String },
    UpToDate,
    /// `note`: ready-made note on this conflict (e.g. that the stash is kept),
    /// otherwise `None`.
    Conflict { files: Vec<String>, operation: Option<Operation>, note: Option<String> },
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum PushResult {
    Done { remote: String, branch: String, created_upstream: bool, forced: bool },
    UpToDate,
    /// The remote has commits that are missing locally.
    Rejected { reason: String },
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConflictSide {
    Ours,
    Theirs,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RebaseAction {
    Pick,
    Reword,
    Squash,
    Drop,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RebasePlanRow {
    pub sha: Sha,
    pub summary: String,
    pub description: String,
    pub author: Person,
    pub authored_at: IsoTime,
    pub action: RebaseAction,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RebaseRefusal {
    MergeCommits,
    NoCommonAncestor,
    NothingToRebase,
    DirtyWorktree,
    Detached,
    /// A merge, rebase, cherry-pick or revert is already running.
    OperationInProgress,
}

/// Exact reason for `RebaseRefusal::NoCommonAncestor`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RebaseRefusalDetail {
    /// The base is related to the branch, but not an ancestor (rebasing onto it first helps).
    NotAncestor,
    /// Base and branch have no common history at all.
    UnrelatedHistory,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum RebasePlan {
    Ok {
        branch: String,
        base: Sha,
        /// Oldest commit first, as in Git's todo file.
        rows: Vec<RebasePlanRow>,
        rewrites_pushed: bool,
    },
    Refused {
        reason: RebaseRefusal,
        /// Only set for `no_common_ancestor`.
        detail: Option<RebaseRefusalDetail>,
        message: String,
    },
}

// ---------------------------------------------------------------------------
// Stash, undo, history, files
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stash {
    pub index: u32,
    pub sha: Sha,
    pub message: String,
    pub branch: Option<String>,
    pub base_sha: Sha,
    pub created_at: IsoTime,
    pub file_count: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoStep {
    pub label: String,
    pub action: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoState {
    pub undo: Option<UndoStep>,
    pub redo: Option<UndoStep>,
    /// Why the last action cannot be undone (any more) although there was one –
    /// e.g. because its commit is already pushed. Only set when `undo` is empty.
    #[serde(default)]
    pub undo_blocked: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryEntry {
    pub commit: CommitSummary,
    pub path: String,
    pub old_path: Option<String>,
    pub status: FileStatus,
    pub added: Option<u32>,
    pub removed: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlameLine {
    pub line_no: u32,
    pub text: String,
    pub sha: Sha,
    pub author: Person,
    pub authored_at: IsoTime,
    pub summary: String,
    pub uncommitted: bool,
}

/// Line endings of a file that was read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Eol {
    Lf,
    Crlf,
    Mixed,
}

/// Line endings when writing (`fileWrite`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LineEnding {
    Lf,
    Crlf,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub text: Option<String>,
    pub is_binary: bool,
    pub encoding: String,
    pub eol: Eol,
    pub size: u64,
}

// ---------------------------------------------------------------------------
// View, drafts, settings
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GraphColumnId {
    Refs,
    Graph,
    Message,
    Author,
    Date,
    Sha,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SectionId {
    Local,
    Remote,
    Tags,
    Stashes,
    Worktrees,
    Submodules,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnState {
    pub id: GraphColumnId,
    pub visible: bool,
    pub width: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionState {
    pub id: SectionId,
    pub collapsed: bool,
    pub hidden: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoViewState {
    pub hidden_refs: Vec<String>,
    pub solo_refs: Vec<String>,
    pub pinned_refs: Vec<String>,
    pub collapsed_folders: Vec<String>,
    pub columns: Vec<ColumnState>,
    pub sections: Vec<SectionState>,
    /// Merge commits whose side branch the graph hides (full SHAs).
    #[serde(default)]
    pub collapsed_merges: Vec<String>,
    /// Every merge is collapsed – also those on pages loaded later.
    #[serde(default)]
    pub collapse_all_merges: bool,
}

impl Default for RepoViewState {
    fn default() -> Self {
        let col = |id, visible| ColumnState { id, visible, width: None };
        // Tags, stashes and submodules are secondary to the branches: they start collapsed.
        let sec = |id, collapsed| SectionState { id, collapsed, hidden: false };
        RepoViewState {
            hidden_refs: Vec::new(),
            solo_refs: Vec::new(),
            pinned_refs: Vec::new(),
            collapsed_folders: Vec::new(),
            columns: vec![
                col(GraphColumnId::Refs, true),
                col(GraphColumnId::Graph, true),
                col(GraphColumnId::Message, true),
                col(GraphColumnId::Author, true),
                col(GraphColumnId::Date, true),
                col(GraphColumnId::Sha, false),
            ],
            sections: vec![
                sec(SectionId::Local, false),
                sec(SectionId::Remote, false),
                sec(SectionId::Tags, true),
                sec(SectionId::Stashes, true),
                sec(SectionId::Worktrees, false),
                sec(SectionId::Submodules, true),
            ],
            collapsed_merges: Vec::new(),
            collapse_all_merges: false,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDraft {
    pub summary: String,
    pub description: String,
    pub amend: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Theme {
    Dark,
    Light,
    System,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DateFormat {
    Relative,
    Local,
    Iso,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DiffMode {
    Hunks,
    Inline,
    Split,
}

/// Own proxy for a host (`Settings.proxy_by_host`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProxy {
    /// `https://host[:port]`; the input may also be just `host` or `host:port`.
    pub host: String,
    /// Proxy address; empty = no proxy for this host.
    pub proxy: String,
}

/// Global settings of the active profile.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub theme: Theme,
    /// 0.8 to 1.5
    pub zoom: f64,
    pub date_format: DateFormat,
    pub show_initials: bool,
    pub toolbar_labels: bool,
    pub remember_tabs: bool,
    pub default_branch_name: String,
    /// 0 = off, otherwise 1 to 60.
    pub auto_fetch_minutes: u32,
    pub auto_prune: bool,
    /// At least 500.
    pub initial_commits: u32,
    pub lazy_load: bool,
    pub default_pull_mode: PullMode,
    pub squash_on_merge: bool,
    pub push_after_commit: bool,
    pub delete_orig_files: bool,
    pub diff_mode: DiffMode,
    pub diff_word_wrap: bool,
    pub diff_ignore_whitespace: bool,
    pub editor_font_size: u32,
    pub editor_tab_size: u32,
    pub external_editor: Option<String>,
    pub external_terminal: Option<String>,
    pub external_diff_tool: Option<String>,
    pub external_merge_tool: Option<String>,
    pub notify_on_fetch: bool,
    pub notify_on_error: bool,
    pub ssh_use_agent: bool,
    /// Proxy for all HTTP(S) remotes (`http.proxy`); `None` = whatever Git already uses.
    #[serde(default)]
    pub proxy_url: Option<String>,
    /// Different proxy per host (`http.<url>.proxy`).
    #[serde(default)]
    pub proxy_by_host: Vec<HostProxy>,
    /// Own CA bundle (`http.sslCAInfo`), path of a PEM file.
    #[serde(default)]
    pub ssl_ca_file: Option<String>,
    /// Hosts for which certificate verification is turned off (`http.<url>.sslVerify=false`,
    /// never global), in the form `https://host[:port]`.
    #[serde(default)]
    pub ssl_no_verify_hosts: Vec<String>,
}

/// Level of a `Settings` field: the same for all profiles or per profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SettingScope {
    Global,
    Profile,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: Theme::Dark,
            zoom: 1.0,
            date_format: DateFormat::Relative,
            show_initials: false,
            toolbar_labels: true,
            remember_tabs: true,
            default_branch_name: "main".into(),
            auto_fetch_minutes: 1,
            auto_prune: true,
            initial_commits: 2000,
            lazy_load: true,
            default_pull_mode: PullMode::Ff,
            squash_on_merge: false,
            push_after_commit: false,
            delete_orig_files: true,
            diff_mode: DiffMode::Hunks,
            diff_word_wrap: false,
            diff_ignore_whitespace: false,
            editor_font_size: 13,
            editor_tab_size: 4,
            external_editor: None,
            external_terminal: None,
            external_diff_tool: None,
            external_merge_tool: None,
            notify_on_fetch: false,
            notify_on_error: true,
            ssh_use_agent: true,
            proxy_url: None,
            proxy_by_host: Vec::new(),
            ssl_ca_file: None,
            ssl_no_verify_hosts: Vec::new(),
        }
    }
}

/// App-side settings per repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSettings {
    pub encoding: String,
    pub hooks_path: Option<String>,
    pub commit_template: Option<String>,
    /// Content of the effective template file (`commit.template`, local or global; `~` resolved,
    /// also outside the repository). Read-only; `None` if there is no readable one.
    pub commit_template_text: Option<String>,
    pub default_pull_mode: Option<PullMode>,
    pub auto_fetch: bool,
    pub author_name: Option<String>,
    pub author_email: Option<String>,
    /// SSH key only for this repository (from the keys of the active profile); it is
    /// enforced for the app's network calls, even with an SSH agent. `None` = like the profile.
    #[serde(default)]
    pub ssh_key_id: Option<String>,
}

impl Default for RepoSettings {
    fn default() -> Self {
        RepoSettings {
            encoding: "utf-8".into(),
            hooks_path: None,
            commit_template: None,
            commit_template_text: None,
            default_pull_mode: None,
            auto_fetch: true,
            author_name: None,
            author_email: None,
            ssh_key_id: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: Id,
    pub name: String,
    pub author_name: String,
    pub author_email: String,
    pub sync_gitconfig: bool,
    pub is_active: bool,
    /// Lane colour 1 to 8; `None` = by position in the list.
    pub color: Option<u8>,
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKey {
    pub id: Id,
    pub label: String,
    pub private_key_path: String,
    pub public_key_path: String,
    pub public_key: String,
    pub fingerprint: Option<String>,
    pub has_passphrase: bool,
    pub is_default: bool,
    pub missing: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostAccountKind {
    Password,
    Passphrase,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostAccount {
    pub id: Id,
    pub host: String,
    pub username: String,
    pub kind: HostAccountKind,
    pub created_at: IsoTime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CredentialKind {
    Username,
    Password,
    Passphrase,
    HostKey,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialRequest {
    pub request_id: String,
    pub kind: CredentialKind,
    pub host: String,
    pub username: Option<String>,
    pub detail: Option<String>,
    pub prompt: String,
    pub can_remember: bool,
}

/// `credential:closed`: the prompt `request_id` ended without an answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialClosedEvent {
    pub request_id: String,
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityScope {
    App,
    Repo,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    pub id: Id,
    pub scope: ActivityScope,
    pub repo_id: Option<Id>,
    pub started_at: IsoTime,
    pub duration_ms: u64,
    pub command: String,
    pub exit_code: Option<i32>,
    pub output: String,
    /// Error code of a failed call (as in `CoreError`), otherwise `None`.
    pub code: Option<crate::error::ErrorCode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityPage {
    pub entries: Vec<ActivityEntry>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalTarget {
    Editor,
    Terminal,
    FileManager,
    /// External diff tool for a file (`path` required, `source` selects the comparison).
    DiffTool,
    /// External merge tool for a conflicted file (`path` required).
    MergeTool,
}

// ---------------------------------------------------------------------------
// Small inputs and outputs of individual commands
// ---------------------------------------------------------------------------

/// `kind` of `refNameCheck`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RefNameKind {
    Branch,
    Tag,
}

/// Result of `refNameCheck`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefNameCheck {
    pub valid: bool,
    pub reason: Option<String>,
}

// ---------------------------------------------------------------------------
// Worktrees, submodules, LFS, patches, signing
// ---------------------------------------------------------------------------

/// A working directory of the repository (`git worktree`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    /// Short name of the checked-out branch; `None` for a detached HEAD.
    pub branch: Option<String>,
    pub head: Option<Sha>,
    /// The main worktree (the repository itself).
    pub is_main: bool,
    /// The worktree that is open under this `repoId`.
    pub is_current: bool,
    pub is_locked: bool,
    pub lock_reason: Option<String>,
    /// The folder is missing; `worktree_prune` removes the entry.
    pub is_prunable: bool,
    /// Uncommitted changes or untracked files (removing then needs `force`).
    pub has_changes: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubmoduleState {
    /// Checked out, at the recorded commit, without own changes.
    Initialized,
    /// Recorded, but not fetched yet.
    Uninitialized,
    /// A different commit is checked out than recorded (or the entry has a conflict).
    OutOfSync,
    /// At the recorded commit, but with own changes or untracked files.
    Modified,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Submodule {
    /// Name in `.gitmodules` (usually the same as the path).
    pub name: String,
    pub path: String,
    /// URL from `.gitmodules`, without credentials; `None` if nothing is there.
    pub url: Option<String>,
    /// The commit recorded in the repository.
    pub sha: Sha,
    /// The commit checked out in the submodule; `None` if it is not initialized.
    pub head_sha: Option<Sha>,
    pub state: SubmoduleState,
    /// Branch checked out in the submodule; `None` for a detached HEAD (the normal case) or without a checkout.
    pub branch: Option<String>,
    /// Branch recorded in `.gitmodules` (`submodule.<name>.branch`).
    pub tracking_branch: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LfsStatus {
    pub installed: bool,
    /// e.g. "3.7.1"; `None` without Git LFS.
    pub version: Option<String>,
    /// Patterns tracked via LFS, sorted.
    pub patterns: Vec<String>,
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

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

/// Named group of repositories from the repository list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: Id,
    pub name: String,
    /// In the order in which they were saved.
    pub repo_ids: Vec<Id>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceRepoStatus {
    Done,
    UpToDate,
    Conflict,
    Failed,
    /// Nothing to do: no remote or no upstream.
    Skipped,
}

impl WorkspaceRepoStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            WorkspaceRepoStatus::Done => "done",
            WorkspaceRepoStatus::UpToDate => "up_to_date",
            WorkspaceRepoStatus::Conflict => "conflict",
            WorkspaceRepoStatus::Failed => "failed",
            WorkspaceRepoStatus::Skipped => "skipped",
        }
    }
}

/// What `workspace_fetch` or `workspace_pull` did in a repository.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRepoResult {
    pub repo_id: Id,
    /// Alias or folder name.
    pub name: String,
    pub status: WorkspaceRepoStatus,
    /// Ready-made sentence.
    pub message: String,
    /// Error code for `failed`, `skipped` and `conflict`, otherwise `None`.
    pub code: Option<crate::error::ErrorCode>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceRunResult {
    /// One entry per repository of the workspace, in its order.
    pub results: Vec<WorkspaceRepoResult>,
    /// Number of repositories with `failed` or `conflict`.
    pub failed: u32,
}

// ---------------------------------------------------------------------------
// Gitflow
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Events from the core (names in `crate::events::names`)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RepoChange {
    Worktree,
    Index,
    Refs,
    Head,
    Stash,
    Config,
    Operation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AppChange {
    Tabs,
    Repos,
    Settings,
    Profiles,
    /// Remembered credentials (`credentials_list`).
    Credentials,
    /// SSH keys (`ssh_key_list`).
    SshKeys,
    /// Workspaces (`workspace_list`).
    Workspaces,
    /// Accounts at hosts (`host_accounts`).
    HostAccounts,
}

/// `repo:changed`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoChangedEvent {
    pub repo_id: Id,
    pub what: Vec<RepoChange>,
}

/// `job:progress`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobProgressEvent {
    pub job_id: String,
    pub repo_id: Option<Id>,
    pub phase: String,
    pub percent: Option<u32>,
    pub line: String,
}

/// `job:done`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobDoneEvent {
    pub job_id: String,
    pub repo_id: Option<Id>,
    pub ok: bool,
    pub cancelled: bool,
    pub message: Option<String>,
}

/// `hook:output`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HookOutputEvent {
    pub repo_id: Id,
    pub hook: String,
    pub output: String,
    pub exit_code: i32,
}

/// `terminal:data`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDataEvent {
    pub terminal_id: Id,
    pub data: String,
}

/// `terminal:exit`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitEvent {
    pub terminal_id: Id,
    /// Exit code of the shell; `None` if it could not be determined.
    pub code: Option<i32>,
}

/// `app:changed`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppChangedEvent {
    pub what: Vec<AppChange>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn person() -> Person {
        Person { name: "Ada".into(), email: "ada@example.com".into() }
    }

    fn change(status: FileStatus, area: FileArea) -> FileChange {
        FileChange {
            path: "a.txt".into(),
            old_path: None,
            status,
            area,
            is_binary: false,
            is_lfs: false,
            added: Some(1),
            removed: None,
            conflict: None,
        }
    }

    #[test]
    fn head_json() {
        let h = Head::Branch { branch: "main".into(), sha: "abc".into() };
        assert_eq!(serde_json::to_value(&h).unwrap(), json!({"kind":"branch","branch":"main","sha":"abc"}));
        let d = Head::Detached { sha: "abc".into() };
        assert_eq!(serde_json::to_value(&d).unwrap(), json!({"kind":"detached","sha":"abc"}));
        let u = Head::Unborn { branch: "main".into() };
        assert_eq!(serde_json::to_value(&u).unwrap(), json!({"kind":"unborn","branch":"main"}));
    }

    #[test]
    fn status_json() {
        let s = Status {
            head: Head::Branch { branch: "main".into(), sha: "abc".into() },
            upstream: Some(UpstreamState { name: "origin/main".into(), ahead: 1, behind: 0, gone: false }),
            unstaged: vec![change(FileStatus::Untracked, FileArea::Unstaged)],
            staged: vec![],
            conflicted: vec![FileChange {
                conflict: Some(ConflictKind::BothModified),
                ..change(FileStatus::Conflicted, FileArea::Unstaged)
            }],
            operation: Some(Operation {
                kind: OperationKind::CherryPick,
                source: Some("abc1234".into()),
                target: Some("main".into()),
                step: Some(1),
                total_steps: Some(3),
                message: None,
            }),
            resolved_conflicts: vec!["b.txt".into()],
            foreign_operation: None,
            left_behind: None,
            identity_set: true,
            token: "t".into(),
        };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(
            v,
            json!({
                "head": {"kind":"branch","branch":"main","sha":"abc"},
                "upstream": {"name":"origin/main","ahead":1,"behind":0,"gone":false},
                "unstaged": [{"path":"a.txt","oldPath":null,"status":"untracked","area":"unstaged","isBinary":false,"isLfs":false,"added":1,"removed":null,"conflict":null}],
                "staged": [],
                "conflicted": [{"path":"a.txt","oldPath":null,"status":"conflicted","area":"unstaged","isBinary":false,"isLfs":false,"added":1,"removed":null,"conflict":"both_modified"}],
                "operation": {"kind":"cherry_pick","source":"abc1234","target":"main","step":1,"totalSteps":3,"message":null},
                "resolvedConflicts": ["b.txt"],
                "foreignOperation": null,
                "leftBehind": null,
                "identitySet": true,
                "token": "t"
            })
        );
        let back: Status = serde_json::from_value(v).unwrap();
        assert_eq!(back, s);
    }

    #[test]
    fn file_diff_json() {
        let text = FileDiff::Text(TextDiff {
            path: "a.txt".into(),
            old_path: None,
            status: FileStatus::Modified,
            hunks: vec![Hunk {
                index: 0,
                old_start: 1,
                old_lines: 1,
                new_start: 1,
                new_lines: 1,
                section: "fn main()".into(),
                lines: vec![DiffLine { kind: DiffLineKind::Add, old_no: None, new_no: Some(1), text: "x".into(), no_newline: true }],
            }],
            old_text: None,
            new_text: Some("x".into()),
            encoding: "utf-8".into(),
            token: Some("tok".into()),
        });
        assert_eq!(
            serde_json::to_value(&text).unwrap(),
            json!({
                "kind":"text","path":"a.txt","oldPath":null,"status":"modified",
                "hunks":[{"index":0,"oldStart":1,"oldLines":1,"newStart":1,"newLines":1,"section":"fn main()",
                  "lines":[{"kind":"add","oldNo":null,"newNo":1,"text":"x","noNewline":true}]}],
                "oldText":null,"newText":"x","encoding":"utf-8","token":"tok"
            })
        );
        let big = FileDiff::TooLarge { path: "b".into(), old_path: Some("a".into()), status: FileStatus::Renamed, bytes: 5, lines: None };
        assert_eq!(
            serde_json::to_value(&big).unwrap(),
            json!({"kind":"too_large","path":"b","oldPath":"a","status":"renamed","bytes":5,"lines":null})
        );
        let img = FileDiff::Image {
            path: "p.png".into(),
            old_path: None,
            status: FileStatus::Added,
            old_data_url: None,
            new_data_url: Some("data:image/png;base64,AA==".into()),
            old_size: None,
            new_size: Some(2),
        };
        assert_eq!(
            serde_json::to_value(&img).unwrap(),
            json!({"kind":"image","path":"p.png","oldPath":null,"status":"added","oldDataUrl":null,"newDataUrl":"data:image/png;base64,AA==","oldSize":null,"newSize":2})
        );
        let back: FileDiff = serde_json::from_value(serde_json::to_value(&text).unwrap()).unwrap();
        assert_eq!(back, text);
    }

    #[test]
    fn op_result_json() {
        assert_eq!(serde_json::to_value(OpResult::UpToDate).unwrap(), json!({"status":"up_to_date"}));
        assert_eq!(
            serde_json::to_value(OpResult::Done { sha: Some("abc".into()), fast_forward: true, summary: "ok".into() }).unwrap(),
            json!({"status":"done","sha":"abc","fastForward":true,"summary":"ok"})
        );
        assert_eq!(
            serde_json::to_value(OpResult::Conflict { files: vec!["a".into()], operation: None, note: None }).unwrap(),
            json!({"status":"conflict","files":["a"],"operation":null,"note":null})
        );
    }

    #[test]
    fn push_result_json() {
        assert_eq!(
            serde_json::to_value(PushResult::Done { remote: "origin".into(), branch: "main".into(), created_upstream: true, forced: false }).unwrap(),
            json!({"status":"done","remote":"origin","branch":"main","createdUpstream":true,"forced":false})
        );
        assert_eq!(serde_json::to_value(PushResult::UpToDate).unwrap(), json!({"status":"up_to_date"}));
        assert_eq!(
            serde_json::to_value(PushResult::Rejected { reason: "x".into() }).unwrap(),
            json!({"status":"rejected","reason":"x"})
        );
    }

    #[test]
    fn rebase_plan_json() {
        let ok = RebasePlan::Ok {
            branch: "feature".into(),
            base: "b".into(),
            rows: vec![RebasePlanRow {
                sha: "s".into(),
                summary: "sum".into(),
                description: "".into(),
                author: person(),
                authored_at: "2026-01-01T00:00:00.000Z".into(),
                action: RebaseAction::Reword,
                message: Some("neu".into()),
            }],
            rewrites_pushed: false,
        };
        assert_eq!(
            serde_json::to_value(&ok).unwrap(),
            json!({"status":"ok","branch":"feature","base":"b","rows":[{"sha":"s","summary":"sum","description":"","author":{"name":"Ada","email":"ada@example.com"},"authoredAt":"2026-01-01T00:00:00.000Z","action":"reword","message":"neu"}],"rewritesPushed":false})
        );
        let refused =
            RebasePlan::Refused { reason: RebaseRefusal::NoCommonAncestor, detail: Some(RebaseRefusalDetail::NotAncestor), message: "m".into() };
        assert_eq!(
            serde_json::to_value(&refused).unwrap(),
            json!({"status":"refused","reason":"no_common_ancestor","detail":"not_ancestor","message":"m"})
        );
        let running = RebasePlan::Refused { reason: RebaseRefusal::OperationInProgress, detail: None, message: "m".into() };
        assert_eq!(
            serde_json::to_value(&running).unwrap(),
            json!({"status":"refused","reason":"operation_in_progress","detail":null,"message":"m"})
        );
        let back: RebasePlan = serde_json::from_value(serde_json::to_value(&ok).unwrap()).unwrap();
        assert_eq!(back, ok);
    }

    #[test]
    fn diff_source_json() {
        let cases = [
            (DiffSource::Unstaged, json!({"kind":"unstaged"})),
            (DiffSource::Staged, json!({"kind":"staged"})),
            (DiffSource::Commit { sha: "a".into() }, json!({"kind":"commit","sha":"a"})),
            (DiffSource::Range { from: "a".into(), to: None }, json!({"kind":"range","from":"a","to":null})),
            (DiffSource::Stash { index: 2 }, json!({"kind":"stash","index":2})),
        ];
        for (src, expected) in cases {
            assert_eq!(serde_json::to_value(&src).unwrap(), expected);
            let back: DiffSource = serde_json::from_value(expected).unwrap();
            assert_eq!(back, src);
        }
    }

    #[test]
    fn graph_row_json() {
        let row = GraphRow {
            id: "wip".into(),
            kind: GraphRowKind::Wip,
            sha: None,
            lane: 0,
            color: 0,
            edges: vec![GraphEdge { top: None, bottom: Some(0), color: 0, dashed: true }],
            parents: vec!["p".into()],
            summary: "".into(),
            author_name: "".into(),
            author_email: "".into(),
            authored_at: None,
            refs: vec![RefLabelInfo { kind: RefKind::Local, name: "main".into(), full_name: "refs/heads/main".into(), is_head: true }],
            is_head: false,
            stash_index: None,
            wip_count: Some(3),
            collapsed_count: None,
            collapse_too_large: false,
            sync: SyncMark::None,
        };
        assert_eq!(
            serde_json::to_value(&row).unwrap(),
            json!({"id":"wip","kind":"wip","sha":null,"lane":0,"color":0,
              "edges":[{"top":null,"bottom":0,"color":0,"dashed":true}],
              "parents":["p"],"summary":"","authorName":"","authorEmail":"","authoredAt":null,
              "refs":[{"kind":"local","name":"main","fullName":"refs/heads/main","isHead":true}],
              "isHead":false,"stashIndex":null,"wipCount":3,"collapsedCount":null,"collapseTooLarge":false,"sync":"none"})
        );
    }

    #[test]
    fn settings_defaults_json() {
        let v = serde_json::to_value(Settings::default()).unwrap();
        assert_eq!(v["theme"], "dark");
        assert_eq!(v["zoom"], 1.0);
        assert_eq!(v["dateFormat"], "relative");
        assert_eq!(v["autoFetchMinutes"], 1);
        assert_eq!(v["initialCommits"], 2000);
        assert_eq!(v["defaultBranchName"], "main");
        assert_eq!(v["defaultPullMode"], "ff");
        assert_eq!(v["lazyLoad"], true);
        assert_eq!(v["rememberTabs"], true);
        assert!(v["externalEditor"].is_null());
        assert_eq!(serde_json::to_value(TabKind::Management).unwrap(), "management");
        assert_eq!(serde_json::to_value(ExternalTarget::FileManager).unwrap(), "file_manager");
        assert_eq!(serde_json::to_value(ExternalTarget::DiffTool).unwrap(), "diff_tool");
        assert_eq!(serde_json::to_value(ExternalTarget::MergeTool).unwrap(), "merge_tool");
        assert_eq!(serde_json::to_value(CredentialKind::HostKey).unwrap(), "host_key");
    }
}

// ---------------------------------------------------------------------------
// Hosts (GitHub, GitLab): accounts, pull requests, issues
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostKind {
    Github,
    Gitlab,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostUser {
    pub login: String,
    pub name: Option<String>,
    pub avatar_url: Option<String>,
}

/// A connected account. The token itself never leaves the core.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HosterAccount {
    pub id: Id,
    pub kind: HostKind,
    /// Address of the web UI, e.g. `https://github.com`.
    pub base_url: String,
    /// `None` as long as the account was never checked successfully.
    pub user: Option<HostUser>,
    /// `…` and the last four characters of the token.
    pub token_hint: Option<String>,
    /// Whether the token has the required permissions (as far as the host reveals it).
    pub scopes_ok: bool,
    pub missing_scopes: Vec<String>,
    /// Last error of this account (e.g. token expired); `None` after a success.
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRepoRef {
    pub owner: String,
    pub name: String,
    pub web_url: String,
}

/// Why the details from the host are missing (the repository is still recognized).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfoError {
    pub code: crate::error::ErrorCode,
    pub message: String,
}

/// The repository at the host, recognized by the URL of a remote.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostRepoInfo {
    /// Name of the remote by which it was recognized.
    pub remote: String,
    pub kind: HostKind,
    /// The connected account for this host; `None` = none (then the details below are missing).
    pub account: Option<HosterAccount>,
    /// On GitLab with groups: `group/subgroup`.
    pub owner: String,
    pub name: String,
    pub web_url: String,
    pub default_branch: Option<String>,
    pub can_push: Option<bool>,
    pub fork_parent: Option<HostRepoRef>,
    /// Set when there is an account but the host did not answer or refused.
    pub error: Option<HostInfoError>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrState {
    Open,
    Closed,
    Merged,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrListState {
    Open,
    Closed,
    Merged,
    All,
}

/// Summarized state of the checks (CI) of a pull request.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChecksState {
    Passing,
    Failing,
    Pending,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrReviewState {
    Approved,
    ChangesRequested,
    /// Reviewers are requested but have not decided yet.
    ReviewRequired,
    Commented,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostLabel {
    pub name: String,
    /// `#rrggbb` if the host names a colour.
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrSummary {
    pub number: u64,
    pub title: String,
    pub state: PrState,
    pub is_draft: bool,
    pub author: Option<HostUser>,
    pub source_branch: String,
    pub target_branch: String,
    pub updated_at: IsoTime,
    pub web_url: String,
    pub checks: Option<ChecksState>,
    pub review_state: Option<PrReviewState>,
    pub labels: Vec<HostLabel>,
    /// The source branch lives in a fork.
    pub is_fork: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrPage {
    pub items: Vec<PrSummary>,
    /// Number of the next page; `None` = end.
    pub next_page: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrReviewer {
    pub user: HostUser,
    /// `None` = requested, no decision yet.
    pub state: Option<PrReviewState>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostComment {
    pub id: String,
    pub author: Option<HostUser>,
    /// Markdown.
    pub body: String,
    pub created_at: IsoTime,
    /// For comments on a line of the diff.
    pub path: Option<String>,
    pub line: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCommit {
    pub sha: Sha,
    pub summary: String,
    pub author_name: String,
    pub authored_at: IsoTime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckRunState {
    Passing,
    Failing,
    Pending,
    Skipped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCheck {
    pub name: String,
    pub state: CheckRunState,
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrDetails {
    #[serde(flatten)]
    pub summary: PrSummary,
    /// Markdown.
    pub body: String,
    pub reviewers: Vec<PrReviewer>,
    /// General comments, review texts and comments on lines, by time.
    pub comments: Vec<HostComment>,
    pub commits: Vec<PrCommit>,
    /// `None` = the host is still computing.
    pub mergeable: Option<bool>,
    /// The individual checks (`checks` is their summary).
    pub check_runs: Vec<PrCheck>,
    pub head_sha: Sha,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrMergeMethod {
    Merge,
    Squash,
    Rebase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueState {
    Open,
    Closed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueListState {
    Open,
    Closed,
    All,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueSummary {
    pub number: u64,
    /// Identifier for display, e.g. `#12`.
    pub key: String,
    pub title: String,
    pub state: IssueState,
    pub author: Option<HostUser>,
    pub assignees: Vec<HostUser>,
    pub labels: Vec<HostLabel>,
    pub updated_at: IsoTime,
    pub web_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuePage {
    pub items: Vec<IssueSummary>,
    pub next_page: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueDetails {
    #[serde(flatten)]
    pub summary: IssueSummary,
    /// Markdown.
    pub body: String,
    pub comments: Vec<HostComment>,
}


// ---------------------------------------------------------------------------
// Crash reports
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CrashReportKind {
    /// A Rust panic, written by the panic hook.
    Panic,
    /// The previous run ended without a clean exit and without a panic report.
    UnexpectedExit,
}

/// A pending crash report as the list shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashReportSummary {
    pub id: Id,
    /// ISO 8601, UTC.
    pub time: String,
    pub kind: CrashReportKind,
    pub app_version: String,
    /// First line of the message, shortened.
    pub message: String,
}
