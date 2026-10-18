//! Data types between UI and core – mirror of src/core/types.ts.
//!
//! Rules: structs with `rename_all = "camelCase"`; enums with snake_case values;
//! unions as internally tagged enums with the field `kind` (results: `status`).
//! `Option<T>` is written as `null`, like `T | null` in TypeScript.
//! Whoever changes something here changes types.ts in the same step.

use serde::{Deserialize, Serialize};

use crate::error::CoreError;

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

/// A stable Forkyard release on GitHub (`update_check`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRelease {
    /// Version without a leading `v`, e.g. `1.2.0`.
    pub version: String,
    /// Release page on GitHub; always starts with `https://github.com/abgebaumt/forkyard/`.
    pub url: String,
    /// Release notes as written (Markdown), shortened; the UI shows them as plain text only.
    pub notes: String,
    pub published_at: Option<String>,
}

/// Result of the update check.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// Version of this build.
    pub current: String,
    /// A newer stable release, if there is one (and the automatic check is on, or the check was manual).
    pub latest: Option<UpdateRelease>,
    /// Last attempt to ask GitHub (ISO-8601, UTC); `None` = never.
    pub checked_at: Option<String>,
    /// Version whose notice the user has already seen (shown once per version).
    pub notified_version: Option<String>,
    /// Version the user chose to skip: no notice for it at all.
    pub skipped_version: Option<String>,
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

/// Narrowing for `commit_search`; every field is optional.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CommitSearchFilters {
    /// Commits that add or remove this text in a file (`git log -S`, ignoring case).
    pub pickaxe: Option<String>,
    /// Committed at or after: `YYYY-MM-DD` (start of that day, local time) or ISO-8601 with time.
    pub since: Option<String>,
    /// Committed at or before: `YYYY-MM-DD` (end of that day, local time) or ISO-8601 with time.
    pub until: Option<String>,
    /// Only commits that touch these paths (files or folders, relative to the repository, literal).
    pub paths: Option<Vec<String>>,
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
    /// Only for a range between two commits (`DiffSource::Range` with `to`): fingerprint for
    /// `range_apply` (`PatchSelection.expect`). Kept apart from `token`, which enables line staging.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range_token: Option<String>,
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

/// Where `range_apply` puts the selected changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RangeApplyTarget {
    /// Unstaged, into the working directory.
    Worktree,
    /// Staged only; the working directory stays.
    Index,
    /// Working directory and index.
    Both,
}

/// Selected hunks and lines for a partial stash (`stash_create` with `selection`). Each entry is a
/// selection like `stage_patch` takes it, from the staged or the unstaged diff of one file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StashSelection {
    /// HEAD the UI made the selection on; anything else is `stale_state`.
    pub expect_head: Sha,
    pub staged: Vec<PatchSelection>,
    pub unstaged: Vec<PatchSelection>,
}

// ---------------------------------------------------------------------------
// Compose commits (v1.2, Teilpaket 3.2)
// ---------------------------------------------------------------------------

/// What one unit of "Compose commits" is: one hunk of a text file or a whole file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeState {
    /// Over HEAD, the index and the working directory; `compose_apply` expects it back.
    pub token: String,
    pub branch: String,
    pub head: Sha,
    pub units: Vec<ComposeUnit>,
    /// `commit.gpgSign` is on: one passphrase prompt per commit is possible.
    pub signing: bool,
}

/// A commit of a proposal or a plan: message and the unit IDs it takes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeGroup {
    pub title: String,
    pub body: String,
    pub units: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeProposal {
    pub state: ComposeState,
    /// In creation order; units in no group stay uncommitted.
    pub groups: Vec<ComposeGroup>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposePlan {
    /// In creation order (the first is the oldest).
    pub commits: Vec<ComposeGroup>,
    pub skip_hooks: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeResult {
    /// The new commits, oldest first.
    pub commits: Vec<Sha>,
    pub hooks: Vec<HookOutput>,
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
    Done { remote: String, branch: String, created_upstream: bool, forced: bool },
    UpToDate,
    /// The remote has commits that are missing locally.
    Rejected { reason: String },
    /// Several refs in one push (`extra`): one result per ref, the primary branch first.
    Multi { remote: String, atomic: bool, refs: Vec<PushRefResult> },
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
        /// Local branches (except this one, and none checked out in a worktree) whose tip is one of
        /// the commits – `update_refs` moves them along.
        dependent_branches: Vec<String>,
    },
    Refused {
        reason: RebaseRefusal,
        /// Only set for `no_common_ancestor`.
        detail: Option<RebaseRefusalDetail>,
        message: String,
    },
}

/// What `conflict_preview` simulates (see `commands::preview`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum PreviewOp {
    /// `theirs` (branch, remote branch, tag or SHA) merged into HEAD.
    Merge { theirs: String },
    /// Applied onto HEAD in this order.
    CherryPick { commits: Vec<Sha> },
    /// Reverted on top of HEAD in this order.
    Revert { commits: Vec<Sha> },
    /// `branch` (default: HEAD) rebased onto `onto`. `upstream` limits the range (default: `onto`);
    /// `commits` is an explicit order (interactive plan without the dropped rows).
    Rebase { onto: String, upstream: Option<String>, branch: Option<String>, commits: Option<Vec<Sha>> },
    /// Patch text as for `patch_apply`, checked against the working directory.
    Patch { text: String },
}

/// Result of `conflict_preview`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ConflictPreview {
    Clean,
    /// `at_commit`: in a series, the first commit that conflicts.
    Conflicts { files: Vec<String>, at_commit: Option<Sha> },
    /// Could not be simulated (too many commits, merge commit, unrelated history, invalid patch …).
    Unknown { reason: String },
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

/// One step of `line_history`: a commit that changed the line, and where the line was in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineHistoryStep {
    pub commit: CommitSummary,
    /// Path of the file in this commit (follows renames).
    pub path: String,
    /// Line range in this commit's version of the file (1-based, inclusive).
    pub start_line: u32,
    pub end_line: u32,
}

/// What a reference in a commit message points to (line archaeology, v1.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchaeologyRefKind {
    /// `#12` on the repository's host (on GitHub and Gitea it may turn out to be a pull request).
    Issue,
    /// `!7` on GitLab and Azure DevOps, or a `#12` the host knows as a pull request.
    PullRequest,
    /// A ticket rule: presets, own rules, `.forkyard/links.json`.
    Ticket,
}

/// A pull request, issue or ticket a commit message names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchaeologyRef {
    /// As written in the message: `#12`, `!7`, `ABC-42`.
    pub text: String,
    pub url: String,
    pub kind: ArchaeologyRefKind,
    /// Title from the host; `None` for tickets, without an account, or when the host does not know it.
    pub title: Option<String>,
}

/// One commit that shaped the line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchaeologyStep {
    pub commit: CommitSummary,
    /// Path of the file in this commit (follows renames).
    pub path: String,
    /// Line range in this commit's version of the file (1-based, inclusive).
    pub start_line: u32,
    pub end_line: u32,
    /// Full commit message (at most 4 000 bytes).
    pub message: String,
    /// The change of the line range: ` `, `+`, `-` lines (at most 40, then one “… n more lines”).
    pub diff: Vec<String>,
    pub refs: Vec<ArchaeologyRef>,
}

/// Whether the titles of host references could be looked up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchaeologyHostLookup {
    /// No host reference in the messages.
    None,
    Done,
    /// No account for the repository's host, or no supported host.
    NotConnected,
    /// The host did not answer; the links stay without titles.
    Failed,
}

/// `line_archaeology`: the history of one line, newest first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineArchaeology {
    /// Where the history starts: for a line of the working directory the commit that last changed it.
    pub path: String,
    pub line: u32,
    pub sha: Sha,
    /// First line number of `code`.
    pub code_start: u32,
    /// The line with up to three lines around it, at `sha`.
    pub code: Vec<String>,
    pub steps: Vec<ArchaeologyStep>,
    /// Exactly `LINE_HISTORY_STEPS` steps came back: older changes may exist.
    pub may_have_more: bool,
    pub host_lookup: ArchaeologyHostLookup,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ArchaeologyConfidence {
    High,
    Medium,
    Low,
}

/// The AI's sentence about one step of the timeline.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchaeologyNote {
    pub sha: Sha,
    pub note: String,
}

/// `ai_archaeology`: the summary, checked against the timeline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchaeologyAnswer {
    pub summary: String,
    /// Only for commits of the timeline, in its order.
    pub notes: Vec<ArchaeologyNote>,
    pub confidence: ArchaeologyConfidence,
    /// Estimated cost (API providers with a known price).
    pub cost_usd: Option<f64>,
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
    /// The coding agents of the cockpit (left panel).
    Agents,
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
                sec(SectionId::Agents, false),
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

// ---------------------------------------------------------------------------
// AI (v1.2)
// ---------------------------------------------------------------------------

/// Default of `Settings.ai_confirm_cost_usd`: ask before a request estimated above 0.10 USD.
pub const DEFAULT_AI_CONFIRM_COST_USD: f64 = 0.10;

fn default_ai_confirm_cost() -> f64 {
    DEFAULT_AI_CONFIRM_COST_USD
}

/// AI provider (`Settings.ai_provider`, one for every function and profile). The command-line
/// tools (`ClaudeCode`, `Codex`, `Opencode`) use the sign-in the user already has; Forkyard stores
/// nothing of it (`ai::cli`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiProviderKind {
    Anthropic,
    Openai,
    /// Own address speaking the OpenAI chat-completions protocol (OpenRouter, Mistral, Groq, company proxy).
    OpenaiCompatible,
    Gemini,
    /// Local, native API (`/api/chat`), default `http://127.0.0.1:11434`.
    Ollama,
    /// Local, OpenAI protocol, default `http://127.0.0.1:1234/v1`.
    Lmstudio,
    /// Claude Code (`claude -p`), signed in by the user.
    ClaudeCode,
    /// Codex (`codex exec`), signed in by the user.
    Codex,
    /// opencode (`opencode run`), with the providers the user signed in to.
    Opencode,
}

/// An AI function; each one can be switched off (`Settings.ai_features_off`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiFeature {
    CommitMessage,
    PrDescription,
    Compose,
    ConflictIntent,
    PushReview,
    Plan,
    Archaeology,
    ReleaseNotes,
    BisectScript,
    SemanticSearch,
    ReviewFix,
}

/// From `Settings.ai_enabled`: `None` = `Unset` (never set up, never turned off), `Some(false)` =
/// `Off` (turned off on purpose), `Some(true)` = `On`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiState {
    Unset,
    Off,
    On,
}

/// Own price for a model (USD per million tokens); wins over the built-in table.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPriceOverride {
    pub model: String,
    pub input_usd_per_mtok: f64,
    pub output_usd_per_mtok: f64,
}

/// Why a file of the context is not sent (completely) – shown in "What is sent?".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiOmitReason {
    /// Looks like a secret (`.env*`, keys, keystores): never sent, not even the name.
    Secret,
    /// Matched by `.forkyard/ai-ignore` or the global list: never sent, not even the name.
    Ignored,
    /// Lock file or generated file: only name and size.
    Generated,
    /// Binary: only name and size.
    Binary,
    /// Too large for the budget: only name and line counts.
    Budget,
}

/// A file of the context that is not sent (completely).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiOmitted {
    pub path: String,
    pub reason: AiOmitReason,
    /// Bytes in the index (0 if unknown).
    pub size: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiPriceSource {
    /// From Forkyard's table (`as_of` names its date).
    Builtin,
    /// Entered by the user (`Settings.ai_prices`).
    Own,
}

/// Price of a model in USD per million tokens.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPrice {
    pub input_usd_per_mtok: f64,
    pub output_usd_per_mtok: f64,
    pub source: AiPriceSource,
    pub as_of: Option<String>,
}

/// A model of the provider (`ai_models`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelInfo {
    pub id: String,
    pub label: String,
    /// Context window in tokens, if the provider says.
    pub context_tokens: Option<u64>,
}

/// How a structured answer is requested: schema enforced by the provider, JSON only, or the
/// schema in the prompt (the core validates in every case).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiStructuredMode {
    JsonSchema,
    JsonObject,
    Prompt,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiModelList {
    pub models: Vec<AiModelInfo>,
    pub structured: AiStructuredMode,
}

/// Why "What is sent?" asks before sending (Grundregel 4; `limit` from spec 1.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiAskTrigger {
    /// First use of this function at all (API providers only).
    FirstUse,
    /// More than 100 000 characters.
    Large,
    /// Estimated cost above `Settings.ai_confirm_cost_usd`.
    Cost,
    /// An API provider gets content of this repository for the first time.
    RepoFirst,
    /// This month's costs reached the limit; never remembered ("send this time").
    Limit,
}

/// `ai_status`: what the UI needs for the visibility of AI elements and Settings › AI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    pub state: AiState,
    pub provider: Option<AiProviderKind>,
    pub model: Option<String>,
    /// Provider, model, address and – where needed – the key are there.
    pub connected: bool,
    /// `…abcd` of the stored key of the chosen provider.
    pub key_hint: Option<String>,
    pub local: bool,
    /// Price of the chosen model (own or built-in); `None` = unknown or local.
    pub price: Option<AiPrice>,
    /// Only in `unset`: the one-time notice after the update to 1.2 is due.
    pub intro_pending: bool,
    pub features_off: Vec<AiFeature>,
}

/// What `ai_preview` builds the text from. Later packages add their own variants.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AiInput {
    /// The staged diff of the repository.
    StagedChanges,
    /// "Compose commits": every local change since HEAD, as units with aliases (3.2).
    Compose,
    /// The commit message of the staged changes (spec 3.1): diff, branch, style examples,
    /// template and own instruction – exactly what `ai_commit_message` sends.
    CommitMessage,
    /// Paket 4: the commits of `source` that `target` does not have (full ref names, e.g.
    /// `refs/heads/feature/x` and `refs/remotes/origin/main`).
    PrDescription { source: String, target: String },
    /// "Git in plain language": the user's sentence (Paket 5).
    Plan { text: String },
    /// One line's history for “Why is this so?” (Paket 7.1); `sha: None` = working directory.
    Archaeology { path: String, line: u32, sha: Option<String> },
}

/// "What is sent?": the exact text, what is left out, and whether Forkyard asks before sending.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPreview {
    pub text: String,
    pub omitted: Vec<AiOmitted>,
    /// Shortened to start and end of each hunk.
    pub shortened: Vec<String>,
    pub chars: u64,
    pub estimated_tokens: u64,
    pub estimated_cost_usd: Option<f64>,
    /// Empty: the request goes out without a question (also while AI is not on).
    pub asks: Vec<AiAskTrigger>,
    /// Pass to `ai_preview_confirm`; binds the confirmation to exactly this text.
    pub fingerprint: String,
    pub month_cost_usd: f64,
    pub limit_usd: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageRow {
    pub provider: String,
    pub model: String,
    pub feature: String,
    pub requests: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
}

/// This month's usage (UTC month), numbers only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiUsageSummary {
    pub month: String,
    pub requests: u64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cost_usd: f64,
    pub rows: Vec<AiUsageRow>,
}

// ---------------------------------------------------------------------------
// Git in plain language (v1.2, Paket 5)
// ---------------------------------------------------------------------------

/// A command a plan may contain (allow list in `ai::plan_commands`); wire names as in
/// `CoreCommands` (`branchCreate` …).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlanCommand {
    BranchCreate,
    BranchCheckout,
    BranchRename,
    BranchDelete,
    ResetBranch,
    RebaseStart,
    CherryPick,
    RevertCommit,
    MergeStart,
    StashCreate,
    TagCreate,
    CommitReword,
    Fetch,
    Pull,
    Push,
    BranchDeleteRemote,
    TagPush,
}

/// `local`: changes only this repository and is undone with the plan; `outward`: reaches a
/// remote, is confirmed on its own and cannot be undone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanClass {
    Local,
    Outward,
}

/// JSON type of an argument and how the step editor shows it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanArgKind {
    Text,
    OptionalText,
    Boolean,
    List,
    Choice,
    OptionalChoice,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanArgField {
    pub name: String,
    pub kind: PlanArgKind,
    /// Allowed values of `choice` / `optional_choice`; empty otherwise.
    pub choices: Vec<String>,
}

/// One step as the model proposed it or the user edited it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub command: PlanCommand,
    /// The command's arguments as JSON values (`null` = not given).
    pub args: serde_json::Map<String, serde_json::Value>,
    /// Why the step is needed – the model's words, plain text.
    pub why: String,
}

/// Pre-check of one step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum PlanCheck {
    /// Simulated: no conflicts.
    Clean,
    /// The step cannot stop on conflicts.
    NotNeeded,
    /// Simulated: would stop on conflicts in these files. Blocks the plan.
    Conflicts { files: Vec<String> },
    /// Not simulated (depends on an earlier step or a fetch, or Git cannot simulate it).
    Unknown { reason: String },
    /// The arguments do not fit the allow list or the repository. Blocks the plan.
    Invalid { reason: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStepView {
    pub command: PlanCommand,
    pub args: serde_json::Map<String, serde_json::Value>,
    pub why: String,
    pub class: PlanClass,
    /// Deletes a branch or discards changes (shown with the word "destructive").
    pub destructive: bool,
    /// The command's arguments for the step editor.
    pub fields: Vec<PlanArgField>,
    pub check: PlanCheck,
}

/// A checked plan. Nothing in the repository has changed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanPreview {
    pub steps: Vec<PlanStepView>,
    /// The model's note (why nothing fits, what it left out), plain text.
    pub note: Option<String>,
    /// An operation (merge, rebase, cherry-pick, revert, `git am`) or open conflicts block every plan.
    pub blocked: bool,
    /// Expected state; `ai_plan_run` refuses with `stale_state` when it no longer holds.
    pub expect: String,
    /// No step is invalid or conflicts, nothing blocks and there is at least one step.
    pub runnable: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PlanStepStatus {
    Done,
    Failed,
    NotRun,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStepOutcome {
    pub index: u32,
    pub status: PlanStepStatus,
    /// Only for `failed`.
    pub error: Option<crate::error::CoreError>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanRunResult {
    pub steps: Vec<PlanStepOutcome>,
    /// One group undo entry `plan` was recorded (Mod+Z takes the done steps back).
    pub undo_recorded: bool,
    /// Every step is done.
    pub completed: bool,
    pub cancelled: bool,
}

/// `ai_pr_description` (Paket 4): a suggestion for title and description – nothing is written
/// anywhere; the form places it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiPrDescription {
    /// One line, at most 300 characters.
    pub title: String,
    /// Markdown; ends with `Closes #n` for every host issue the commits mention.
    pub body: String,
    /// Host issues the description closes – from the commits, never from the AI.
    pub closes: Vec<u64>,
}

/// `ai_commit_message`: a draft for the commit form – the core never commits it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCommitMessage {
    /// One line, at most 72 characters (`ai::commit_message::SUMMARY_LIMIT`).
    pub summary: String,
    /// `None` when the summary says everything.
    pub body: Option<String>,
}

/// Sign-in of an AI command-line tool, as the tool reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiLoginState {
    LoggedIn,
    LoggedOut,
    /// The tool gave no readable answer (in time).
    Unknown,
}

/// Where a program was found (`tools::locate`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolSource {
    Configured,
    Path,
    KnownLocation,
    LoginShell,
}

/// An AI command-line tool the setup found (`ai_detect`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCliFound {
    pub provider: AiProviderKind,
    pub path: String,
    pub version: Option<String>,
    pub source: ToolSource,
    pub login: AiLoginState,
    /// "claude.ai", "ChatGPT" … – never an account name.
    pub login_method: Option<String>,
    /// Claude Code would use `ANTHROPIC_API_KEY` from the environment instead of the sign-in.
    pub uses_env_key: bool,
    /// All safety switches are there; otherwise `problem` names the missing ones.
    pub supported: bool,
    pub problem: Option<String>,
    /// The sign-in as text ("claude auth login").
    pub login_command: String,
}

/// Ollama or LM Studio answering on this computer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiLocalFound {
    pub provider: AiProviderKind,
    pub base_url: String,
    pub models: Vec<String>,
}

/// What the setup dialog offers (`ai_detect`); nothing was sent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDetection {
    pub clis: Vec<AiCliFound>,
    pub local: Vec<AiLocalFound>,
    /// Providers with a stored API key.
    pub keys: Vec<AiProviderKind>,
    pub elapsed_ms: u64,
}

/// Own paths of the AI command-line tools (`Settings.ai_cli_paths`, global); `None` = found
/// automatically (PATH, the usual install folders, the login shell's PATH).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiCliPaths {
    pub claude_code: Option<String>,
    pub codex: Option<String>,
    pub opencode: Option<String>,
}

impl AiCliPaths {
    /// The own path for a command-line tool; `None` for every other provider.
    pub fn get(&self, kind: AiProviderKind) -> Option<&str> {
        match kind {
            AiProviderKind::ClaudeCode => self.claude_code.as_deref(),
            AiProviderKind::Codex => self.codex.as_deref(),
            AiProviderKind::Opencode => self.opencode.as_deref(),
            _ => None,
        }
    }

    pub fn entries(&self) -> [(AiProviderKind, Option<&str>); 3] {
        [
            (AiProviderKind::ClaudeCode, self.claude_code.as_deref()),
            (AiProviderKind::Codex, self.codex.as_deref()),
            (AiProviderKind::Opencode, self.opencode.as_deref()),
        ]
    }
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
    /// Ask GitHub once a day whether a newer stable release exists (`update_check`).
    #[serde(default = "yes")]
    pub check_for_updates: bool,
    /// The user's own coding-agent templates (Settings › Coding agents). Global; the built-in
    /// templates (Claude Code, Codex, opencode) are not stored.
    #[serde(default)]
    pub agent_templates: Vec<AgentTemplate>,
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
    // --- AI (v1.2; all global, see db::app_settings::GLOBAL_KEYS) ---
    /// Master switch: `None` = not set up yet, `Some(false)` = turned off on purpose.
    #[serde(default)]
    pub ai_enabled: Option<bool>,
    #[serde(default)]
    pub ai_provider: Option<AiProviderKind>,
    /// Model ID as the provider names it (`claude-sonnet-5-5`, `qwen3:8b` …).
    #[serde(default)]
    pub ai_model: Option<String>,
    /// Address of the OpenAI-compatible service, or another address for Ollama / LM Studio.
    #[serde(default)]
    pub ai_base_url: Option<String>,
    /// Functions that are switched off.
    #[serde(default)]
    pub ai_features_off: Vec<AiFeature>,
    /// Exclusion patterns (gitignore syntax) for every repository.
    #[serde(default)]
    pub ai_exclude: Vec<String>,
    /// Ask before a request whose estimated cost is above this (USD).
    #[serde(default = "default_ai_confirm_cost")]
    pub ai_confirm_cost_usd: f64,
    /// Ask before every further request once this month's estimated API costs reach this (USD).
    #[serde(default)]
    pub ai_monthly_limit_usd: Option<f64>,
    #[serde(default)]
    pub ai_prices: Vec<AiPriceOverride>,
    /// Own paths of the AI command-line tools; empty = found automatically.
    #[serde(default)]
    pub ai_cli_paths: AiCliPaths,
}

fn yes() -> bool {
    true
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
            check_for_updates: true,
            agent_templates: Vec::new(),
            ssh_use_agent: true,
            proxy_url: None,
            proxy_by_host: Vec::new(),
            ssl_ca_file: None,
            ssl_no_verify_hosts: Vec::new(),
            ai_enabled: None,
            ai_provider: None,
            ai_model: None,
            ai_base_url: None,
            ai_features_off: Vec::new(),
            ai_exclude: Vec::new(),
            ai_confirm_cost_usd: DEFAULT_AI_CONFIRM_COST_USD,
            ai_monthly_limit_usd: None,
            ai_prices: Vec::new(),
            ai_cli_paths: AiCliPaths::default(),
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
    /// After checkout, pull, merge, cherry-pick, revert, hard reset and a finished rebase: bring
    /// submodules whose recorded commit changed to it (`git submodule update --init --recursive`).
    pub submodules_auto_update: bool,
    /// Ticket link rules of this repository (presets, own rules, host links on/off). Checked on
    /// saving; the effective rules (including `.forkyard/links.json`) come from `link_rules_get`.
    #[serde(default)]
    pub link_rules: LinkRulesConfig,
    /// "AI off for this repository": no AI element appears for it, nothing of it is sent.
    #[serde(default)]
    pub ai_off: bool,
    /// Own instruction for AI commit messages in this repository (spec 3.1), at most 2000
    /// characters; stored in the app (`repo_settings`), never in .git/config.
    #[serde(default)]
    pub ai_commit_instruction: Option<String>,
    /// Test command for coding agents (run in the agent's worktree when it is done). `None` = none.
    /// App side (`repo_settings`), never read from the repository.
    #[serde(default)]
    pub test_command: Option<String>,
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
            submodules_auto_update: true,
            link_rules: LinkRulesConfig::default(),
            ai_off: false,
            ai_commit_instruction: None,
            test_command: None,
        }
    }
}

/// Trackers with a ready-made rule.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkPresetKind {
    Jira,
    Linear,
    Youtrack,
    Redmine,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkPreset {
    pub kind: LinkPresetKind,
    /// Address of the tracker, e.g. `https://firma.atlassian.net` (http/https, no trailing slash).
    pub base_url: String,
    /// Jira, Linear, YouTrack: only these project keys (`ABC` for `ABC-123`); empty = every key.
    /// Always empty for Redmine (`#123`).
    #[serde(default)]
    pub keys: Vec<String>,
}

/// An own rule: matches of `pattern` link to `url` (`$0` = whole match, `$1` … = groups).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomLinkRule {
    pub id: String,
    pub pattern: String,
    pub url: String,
}

/// Ticket links stored for a repository (`repo_settings`, key `linkRules`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LinkRulesConfig {
    /// `#123` (on GitLab also `!123`) link to the repository's host.
    pub host_rules: bool,
    pub presets: Vec<LinkPreset>,
    pub custom: Vec<CustomLinkRule>,
}

impl Default for LinkRulesConfig {
    fn default() -> Self {
        LinkRulesConfig { host_rules: true, presets: Vec::new(), custom: Vec::new() }
    }
}

/// Where an effective ticket link rule comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkRuleSource {
    Custom,
    Preset,
    RepoFile,
    Host,
}

/// An effective rule: matches of `pattern` link to `url` (`$0` = whole match, `$1` … = groups).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRule {
    /// `custom:<id>`, `preset:<kind>:<n>`, `file:<id or position>`, `host:issue`, `host:merge_request`.
    pub id: String,
    pub source: LinkRuleSource,
    pub pattern: String,
    pub url: String,
}

/// Where `.forkyard/links.json` was read from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkFileOrigin {
    Worktree,
    Head,
}

/// An ignored part of the repository file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRuleProblem {
    /// Position in the file's `rules` (from 0); `None` = the file as a whole.
    pub index: Option<u32>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkRules {
    /// In order of precedence: where two rules match at the same place, the earlier one wins.
    pub rules: Vec<LinkRule>,
    /// `None`: the repository has no `.forkyard/links.json`.
    pub file: Option<LinkFileOrigin>,
    pub problems: Vec<LinkRuleProblem>,
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

// ---------------------------------------------------------------------------
// Repository clean-up (`repoCleanupPreview`, `repoCleanupLfsEstimate`, `repoCleanupRun`)
// ---------------------------------------------------------------------------

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
    /// LFS file locks (`lfs_locks`): after locking/unlocking and after a fetch.
    Locks,
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
    /// Custom commands: the user's own or the approval of a repository file (`custom_commands_list`).
    CustomCommands,
    /// AI status (`ai_status`): master switch, provider, model, key, given confirmations.
    Ai,
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

/// `submodules:updated` – the follow-up job after checkout, pull, merge … (see
/// `commands::submodule::auto`). A failure is a warning; the main operation went through.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmodulesUpdatedEvent {
    pub repo_id: Id,
    pub ok: bool,
    /// Submodules whose recorded commit changed.
    pub paths: Vec<String>,
    /// Why it failed (redacted); `None` on success.
    pub message: Option<String>,
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
            range_token: None,
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
    fn lfs_lock_json() {
        let list = LfsLockList {
            locks: vec![LfsLock {
                id: "1".into(),
                path: "bilder/karte.psd".into(),
                owner: "Lena Berg".into(),
                locked_at: Some("2026-01-02T03:04:05Z".into()),
                ours: false,
            }],
            fetched_at: "2026-01-02T03:05:00.000Z".into(),
        };
        let outcome = LfsLockOutcome { locks: list, failed: vec![LfsLockFailure { path: "plan.psd".into(), reason: "already created lock".into() }] };
        assert_eq!(
            serde_json::to_value(&outcome).unwrap(),
            json!({
                "locks": {
                    "locks": [{"id":"1","path":"bilder/karte.psd","owner":"Lena Berg","lockedAt":"2026-01-02T03:04:05Z","ours":false}],
                    "fetchedAt": "2026-01-02T03:05:00.000Z"
                },
                "failed": [{"path":"plan.psd","reason":"already created lock"}]
            })
        );
        assert_eq!(serde_json::to_value(RepoChange::Locks).unwrap(), "locks");
    }

    #[test]
    fn push_many_json() {
        let extra: PushExtra = serde_json::from_value(json!({"local":"refs/tags/v1","remoteName":null,"force":false})).unwrap();
        assert_eq!(extra, PushExtra { local: "refs/tags/v1".into(), remote_name: None, force: false });
        let multi = PushResult::Multi {
            remote: "origin".into(),
            atomic: true,
            refs: vec![PushRefResult {
                local: "refs/heads/main".into(),
                remote_ref: "refs/heads/main".into(),
                status: PushRefStatus::Rejected,
                forced: false,
                reason: Some("atomic push failed".into()),
            }],
        };
        assert_eq!(
            serde_json::to_value(&multi).unwrap(),
            json!({"status":"multi","remote":"origin","atomic":true,"refs":[{"local":"refs/heads/main","remoteRef":"refs/heads/main","status":"rejected","forced":false,"reason":"atomic push failed"}]})
        );
    }

    #[test]
    fn submodules_updated_json() {
        let event = SubmodulesUpdatedEvent { repo_id: "r".into(), ok: false, paths: vec!["libs/a".into()], message: Some("x".into()) };
        assert_eq!(serde_json::to_value(&event).unwrap(), json!({"repoId":"r","ok":false,"paths":["libs/a"],"message":"x"}));
        assert_eq!(serde_json::to_value(RepoSettings::default()).unwrap()["submodulesAutoUpdate"], true);
        assert!(crate::events::names::ALL.contains(&crate::events::names::SUBMODULES_UPDATED));
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
            dependent_branches: vec!["teil".into()],
        };
        assert_eq!(
            serde_json::to_value(&ok).unwrap(),
            json!({"status":"ok","branch":"feature","base":"b","rows":[{"sha":"s","summary":"sum","description":"","author":{"name":"Ada","email":"ada@example.com"},"authoredAt":"2026-01-01T00:00:00.000Z","action":"reword","message":"neu"}],"rewritesPushed":false,"dependentBranches":["teil"]})
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
    fn conflict_preview_json() {
        let op: PreviewOp = serde_json::from_value(json!({"kind":"rebase","onto":"main"})).unwrap();
        assert_eq!(op, PreviewOp::Rebase { onto: "main".into(), upstream: None, branch: None, commits: None });
        let op: PreviewOp = serde_json::from_value(json!({"kind":"cherry_pick","commits":["a","b"]})).unwrap();
        assert_eq!(op, PreviewOp::CherryPick { commits: vec!["a".into(), "b".into()] });
        let op: PreviewOp = serde_json::from_value(json!({"kind":"patch","text":"diff"})).unwrap();
        assert_eq!(op, PreviewOp::Patch { text: "diff".into() });
        assert_eq!(serde_json::to_value(ConflictPreview::Clean).unwrap(), json!({"status":"clean"}));
        assert_eq!(
            serde_json::to_value(ConflictPreview::Conflicts { files: vec!["a.txt".into()], at_commit: Some("c".into()) }).unwrap(),
            json!({"status":"conflicts","files":["a.txt"],"atCommit":"c"})
        );
        assert_eq!(serde_json::to_value(ConflictPreview::Unknown { reason: "x".into() }).unwrap(), json!({"status":"unknown","reason":"x"}));
    }

    #[test]
    fn stash_selection_json() {
        let selection: StashSelection = serde_json::from_value(json!({
            "expectHead": "abc",
            "staged": [],
            "unstaged": [{"path": "a.txt", "hunks": [{"index": 0, "lines": [1, 2]}], "expect": "t"}]
        }))
        .unwrap();
        assert_eq!(selection.expect_head, "abc");
        assert!(selection.staged.is_empty());
        assert_eq!(selection.unstaged[0].hunks[0].lines, Some(vec![1, 2]));
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
    /// Gitea and Forgejo (including Codeberg).
    Gitea,
    /// Bitbucket Cloud.
    Bitbucket,
    /// Azure DevOps Services.
    AzureDevops,
}

impl HostKind {
    /// Every host the app knows, in the order it lists them.
    pub const ALL: &'static [HostKind] = &[HostKind::Github, HostKind::Gitlab, HostKind::Gitea, HostKind::Bitbucket, HostKind::AzureDevops];

    /// Name in the contract and in `hoster_accounts.kind`.
    pub fn as_str(self) -> &'static str {
        match self {
            HostKind::Github => "github",
            HostKind::Gitlab => "gitlab",
            HostKind::Gitea => "gitea",
            HostKind::Bitbucket => "bitbucket",
            HostKind::AzureDevops => "azure_devops",
        }
    }

    /// The opposite of `as_str`; `None` for a name the app does not know.
    pub fn parse(name: &str) -> Option<HostKind> {
        HostKind::ALL.iter().copied().find(|kind| kind.as_str() == name)
    }
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
    /// User name for Basic authentication (Bitbucket); `None` for hosts that only need the token.
    pub username: Option<String>,
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

/// What a host offers. The UI only shows what is there; the core refuses the rest with
/// `host_unsupported` before anything is sent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostCapabilities {
    /// The host has an issue tracker (Azure DevOps: work items) – for this repository, as far as known.
    pub issues: bool,
    /// Issues can be created from the app.
    pub issue_create: bool,
    /// Pull requests can be created as drafts.
    pub draft_prs: bool,
    /// An existing pull request can switch between draft and ready.
    pub draft_toggle: bool,
    /// Merge methods the API accepts, in display order.
    pub merge_methods: Vec<PrMergeMethod>,
    /// The source branch can be deleted when merging.
    pub delete_source_branch: bool,
    /// A closed pull request can be reopened.
    pub pr_reopen: bool,
    /// Reviewers can be requested by user name.
    pub pr_reviewers: bool,
    /// Pull requests carry labels.
    pub pr_labels: bool,
    /// Pull requests from forks can be checked out (the host offers a ref for them).
    pub fork_checkout: bool,
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
    /// What this host offers for the repository (`issues` reflects a tracker switched off in the repository).
    pub capabilities: HostCapabilities,
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

#[cfg(test)]
mod host_kind_tests {
    use super::*;

    #[test]
    fn host_kinds_have_one_name_in_the_contract_and_in_the_database() {
        for kind in HostKind::ALL.iter().copied() {
            assert_eq!(serde_json::to_value(kind).unwrap(), kind.as_str(), "{kind:?}");
            assert_eq!(HostKind::parse(kind.as_str()), Some(kind));
        }
        assert_eq!(HostKind::parse("svn"), None);
        assert_eq!(HostKind::parse("GitHub"), None, "names are exact");
        assert_eq!(HostKind::parse(""), None);
    }
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

// ---------------------------------------------------------------------------
// Custom commands and the command line
// ---------------------------------------------------------------------------

/// What a custom command does: start a program, run Git, or open a web address.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CustomCommandKind {
    Shell,
    Url,
    Git,
}

/// Working directory of a `shell` command: the open folder (default) or the main working tree.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CustomCommandCwd {
    Repo,
    #[default]
    Worktree,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CustomInputType {
    Text,
    Choice,
    Checkbox,
    File,
}

/// Where a command appears: palette (`repo`) and the context menus of the other kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CustomCommandScope {
    Repo,
    Commit,
    Branch,
    File,
    Submodule,
}

/// A field of the form that is shown before the command runs (`${input:<id>}`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomCommandInput {
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub input_type: CustomInputType,
    /// Start value; for a checkbox `"true"` or `"false"`.
    #[serde(default)]
    pub default: Option<String>,
    /// `choice`: the choices; `checkbox`: at most one entry, the value when ticked.
    #[serde(default)]
    pub options: Vec<String>,
}

fn default_scope() -> Vec<CustomCommandScope> {
    vec![CustomCommandScope::Repo]
}

/// One custom command as it is stored (global) or written in `.forkyard/commands.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomCommandDef {
    pub id: String,
    pub title: String,
    pub kind: CustomCommandKind,
    /// One line: program and arguments (`shell`), Git's arguments without `git` (`git`) or the
    /// address (`url`), with placeholders.
    pub run: String,
    #[serde(default)]
    pub cwd: CustomCommandCwd,
    /// Show the finished command before it runs.
    #[serde(default)]
    pub confirm: bool,
    /// Global `shell` commands only: run the line through the system shell; values arrive as
    /// environment variables, never as part of the line.
    #[serde(default)]
    pub shell: bool,
    #[serde(default)]
    pub inputs: Vec<CustomCommandInput>,
    #[serde(default = "default_scope")]
    pub scope: Vec<CustomCommandScope>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CustomCommandSource {
    Global,
    Repo,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomCommandEntry {
    /// `global:<id>` or `repo:<id>` – what `custom_command_run` takes.
    pub key: String,
    pub source: CustomCommandSource,
    pub command: CustomCommandDef,
    /// `false`: a repository command whose file is not approved in this version.
    pub runnable: bool,
}

/// Approval state of `.forkyard/commands.json`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RepoCommandsState {
    /// No file.
    Missing,
    /// Never approved (or the file cannot be used).
    Untrusted,
    /// Approved once, but the file has changed since.
    Changed,
    Trusted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CustomCommandChangeKind {
    Added,
    Removed,
    Changed,
}

/// What changed in the repository file since the approval (by command id).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomCommandChange {
    pub id: String,
    pub title: String,
    pub change: CustomCommandChangeKind,
    /// `run` before and after; `None` for added or removed commands.
    pub before: Option<String>,
    pub after: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoCommands {
    pub state: RepoCommandsState,
    /// SHA-256 of the file as it is now – what `custom_commands_trust` expects. `None` without a usable file.
    pub hash: Option<String>,
    /// `.forkyard/commands.json`
    pub path: String,
    /// One sentence per command (or file problem) that was rejected.
    pub problems: Vec<String>,
    /// Only for `changed`.
    pub changes: Vec<CustomCommandChange>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomCommandList {
    /// Global commands first, then those of the repository.
    pub commands: Vec<CustomCommandEntry>,
    /// `None` when listed without a repository.
    pub repo: Option<RepoCommands>,
}

/// Where a command was started: the selected commit, branch, file and remote. Missing values fall
/// back to HEAD, the current branch and the upstream remote.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CustomCommandContext {
    pub sha: Option<Sha>,
    pub branch: Option<String>,
    pub file: Option<String>,
    pub remote: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum CustomCommandResult {
    /// `confirm: true` and not confirmed yet: what would run, nothing has run.
    Confirm { display: String, cwd: String },
    /// `shell` or `git` ran; `output` is stdout and stderr, redacted and shortened.
    Finished { exit_code: Option<i32>, output: String },
    /// `url`: the UI opens the address in the system browser.
    OpenUrl { url: String },
}

/// Whether the palette can link the `forkyard` command into a folder on the PATH.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    /// AppImage or macOS app: the app can create the link itself.
    pub installable: bool,
    pub installed: bool,
    /// `~/.local/bin/forkyard` or `/usr/local/bin/forkyard`; `None` if not installable.
    pub link_path: Option<String>,
    /// The folder of the link is on the PATH of the running app.
    pub on_path: bool,
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/// What `stats_compute` counts. `from`/`to`: ISO-8601, compared with the author time (both
/// inclusive); `None` = open. `ref` (JSON key): `HEAD` or a full ref name (`refs/heads/main`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsRange {
    pub from: Option<IsoTime>,
    pub to: Option<IsoTime>,
    #[serde(rename = "ref")]
    pub reference: String,
}

/// Commits of a week (`period` = its Monday, "YYYY-MM-DD") or a month ("YYYY-MM"), by the
/// author's local date.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsBucket {
    pub period: String,
    pub commits: u32,
    pub added: u64,
    pub removed: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsAuthor {
    pub name: String,
    pub email: String,
    pub commits: u32,
    pub added: u64,
    pub removed: u64,
    pub first_at: IsoTime,
    pub last_at: IsoTime,
}

/// A file that still exists at the tip and was changed in the period.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsFile {
    pub path: String,
    pub commits: u32,
    /// Number of different authors.
    pub authors: u32,
    pub added: u64,
    pub removed: u64,
}

/// `score` = commits × authors.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsHotspot {
    pub path: String,
    pub commits: u32,
    pub authors: u32,
    pub score: u32,
}

/// Knowledge per folder (`path` "" = the whole repository). `weight`: changed lines, at least
/// 1 per file change. `bus_factor`: fewest authors who together hold more than half of it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsFolder {
    pub path: String,
    pub weight: u64,
    pub authors: u32,
    pub main_author: Person,
    /// Share of the main author in percent (0–100).
    pub main_share: u32,
    pub bus_factor: u32,
    /// The authors with the most changed lines in the folder, most first (at most 6); the rest of
    /// `weight` belongs to the others.
    pub top: Vec<StatsFolderShare>,
}

/// An author's changed lines in a folder.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsFolderShare {
    pub author: Person,
    pub weight: u64,
}

/// Lines of the blamed sample by the age of their last change, relative to
/// `RepoStats::reference_time`: under 30 days, under 180 days, under 365 days, under 2 × 365
/// days, older.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsCodeAge {
    /// Files that were blamed.
    pub files: u32,
    /// Files of the sample that Git could not blame.
    pub skipped: u32,
    pub month: u64,
    pub half_year: u64,
    pub year: u64,
    pub two_years: u64,
    pub older: u64,
}

/// Longest run of consecutive days with commits ("YYYY-MM-DD", author's local date).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsStreak {
    pub days: u32,
    pub start: String,
    pub end: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsBigCommit {
    pub sha: Sha,
    pub added: u64,
    pub removed: u64,
    pub at: IsoTime,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsBusyDay {
    pub date: String,
    pub commits: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsRecords {
    pub longest_streak: Option<StatsStreak>,
    pub biggest_commit: Option<StatsBigCommit>,
    pub busiest_day: Option<StatsBusyDay>,
}

/// Result of `stats_compute`: derived numbers only – no commit list, no messages.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStats {
    /// The commit whose history was counted; `None` = nothing to count.
    pub tip: Option<Sha>,
    /// Reference point of the code age: `to`, otherwise now (also for a cached result).
    pub reference_time: Option<IsoTime>,
    pub commits: u32,
    pub added: u64,
    pub removed: u64,
    pub first_at: Option<IsoTime>,
    pub last_at: Option<IsoTime>,
    /// 7 × 24: weekday (Monday first) × hour, in the author's local time.
    pub heatmap: Vec<Vec<u32>>,
    pub weeks: Vec<StatsBucket>,
    pub months: Vec<StatsBucket>,
    /// All authors of the period; `authors` holds at most 200 of them.
    pub author_count: u32,
    pub authors: Vec<StatsAuthor>,
    /// All changed files that still exist; `files` holds at most 2000 of them (most changed first).
    pub file_count: u32,
    pub files: Vec<StatsFile>,
    pub hotspots: Vec<StatsHotspot>,
    pub folders: Vec<StatsFolder>,
    pub code_age: StatsCodeAge,
    pub records: StatsRecords,
    /// Came from the cache.
    pub cached: bool,
}

#[cfg(test)]
mod stats_json_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stats_range_reads_ref_and_stats_are_camel_case() {
        let range: StatsRange = serde_json::from_value(json!({ "from": "2025-06-01T00:00:00.000Z", "to": null, "ref": "refs/heads/main" })).unwrap();
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

// ---------------------------------------------------------------------------
// Coding agents (cockpit)
// ---------------------------------------------------------------------------

/// A coding-agent template of the user's own. Placeholders in `args`, `unattended_args` and
/// `resume_args`: `${task}`, `${taskFile}`, `${worktree}`, `${branch}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTemplate {
    /// `custom:<id>`.
    pub id: String,
    pub name: String,
    /// Program name (looked up on PATH) or full path.
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Extra arguments for “without prompts”; `None` = the switch is not available for this template.
    #[serde(default)]
    pub unattended_args: Option<Vec<String>>,
    /// Arguments for “Resume” (instead of `args`); `None` = no resume.
    #[serde(default)]
    pub resume_args: Option<Vec<String>>,
    /// The program reports “waiting”/“done” itself through `$FORKYARD_AGENT_HELPER`.
    #[serde(default)]
    pub status_hook: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentTemplateKind {
    Claude,
    Codex,
    Opencode,
    Custom,
}

/// A template as the start dialog and the settings show it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTemplateInfo {
    /// `claude`, `codex`, `opencode` or `custom:<id>`.
    pub id: String,
    pub kind: AgentTemplateKind,
    pub name: String,
    pub program: String,
    /// Where the program was found; `None` = not found (the template can't be started).
    pub path: Option<String>,
    pub version: Option<String>,
    /// Why “without prompts” is not available; `None` = available.
    pub unattended_blocked: Option<String>,
    /// What “without prompts” does not cover on this system (Windows: Claude Code still asks before commands).
    pub unattended_note: Option<String>,
    pub can_resume: bool,
    /// Status comes from the agent itself (“according to Claude Code”), not only from guessing.
    pub status_hook: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    #[default]
    Starting,
    Running,
    Waiting,
    Done,
    Failed,
    Stopped,
    /// Branch or worktree no longer exist.
    Orphaned,
}

/// Where the status comes from: the agent reported it (hook, terminal signal) or the core guesses
/// it (no screen change for a while).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentStatusSource {
    Agent,
    #[default]
    Guess,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentTestState {
    Running,
    Passed,
    Failed,
}

/// Last run of the repository's test command in the agent's worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTestResult {
    pub state: AgentTestState,
    pub exit_code: Option<i32>,
    /// The last 4 KiB of stdout and stderr, redacted.
    pub output: String,
    pub started_at: IsoTime,
    pub finished_at: Option<IsoTime>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    /// The repository the agent was started from (undo, cleanup and the cockpit live there).
    pub repo_id: String,
    /// Repository row of the agent's worktree (status, diff, watcher); `None` once the folder is gone.
    pub worktree_repo_id: Option<String>,
    pub short_name: String,
    pub template_id: String,
    pub template_name: String,
    pub task: String,
    pub branch: String,
    pub worktree_path: String,
    /// What the user chose as the base (branch name or SHA) and the commit it resolved to.
    pub base: String,
    pub base_sha: String,
    pub unattended: bool,
    pub status: AgentStatus,
    pub status_source: AgentStatusSource,
    /// Terminal of the running session; `None` when no session runs.
    pub terminal_id: Option<String>,
    pub started_at: IsoTime,
    pub ended_at: Option<IsoTime>,
    pub exit_code: Option<i32>,
    /// Last non-empty screen line after a failure (redacted).
    pub last_line: Option<String>,
    pub changed_files: u32,
    /// Commits on the agent's branch that the base does not have.
    pub commits_ahead: u32,
    pub test: Option<AgentTestResult>,
}

/// Defaults for the start dialog, checked live.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSuggestion {
    pub short_name: String,
    pub branch: String,
    /// Why the branch can't be used (invalid name, already exists); `None` = fine.
    pub branch_problem: Option<String>,
    /// Folder the worktree will get.
    pub path: String,
    pub base_sha: String,
    /// Agent configurations in the base commit (`.claude/`, `.codex/`, `opencode.json`).
    pub configs: Vec<String>,
    /// Agents of this repository with a running session.
    pub running: u32,
}

/// What “Stop agent and clean up” would destroy.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCleanupPreview {
    /// Commits of the branch that are on no remote branch and not in the base.
    pub unpushed_commits: u32,
    pub changed_files: u32,
    pub running: bool,
    /// The worktree is locked (`git worktree lock`); cleaning up is refused.
    pub locked: bool,
}

/// Payload of `agents:changed`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsChangedEvent {
    /// The repository whose agents changed (status, start, end, cleanup).
    pub repo_id: String,
    /// Agents with a running session in all repositories (for the prompt when quitting).
    pub running: u32,
}

#[cfg(test)]
mod agent_json_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn agent_types_are_camel_case_and_template_options_default() {
        let template: AgentTemplate = serde_json::from_value(json!({ "id": "custom:1", "name": "Mein Agent", "program": "mein-agent" })).unwrap();
        assert_eq!(
            template,
            AgentTemplate { id: "custom:1".into(), name: "Mein Agent".into(), program: "mein-agent".into(), args: vec![], unattended_args: None, resume_args: None, status_hook: false }
        );
        let full = serde_json::to_value(AgentTemplate { unattended_args: Some(vec!["--yes".into()]), status_hook: true, ..template }).unwrap();
        assert_eq!(full["unattendedArgs"], json!(["--yes"]));
        assert_eq!(full["resumeArgs"], json!(null));
        assert_eq!(full["statusHook"], json!(true));

        let agent = Agent { status: AgentStatus::Waiting, status_source: AgentStatusSource::Agent, ..Agent::default() };
        let v = serde_json::to_value(&agent).unwrap();
        assert_eq!((v["status"].clone(), v["statusSource"].clone()), (json!("waiting"), json!("agent")));
        for key in ["worktreeRepoId", "terminalId", "endedAt", "exitCode", "lastLine", "test"] {
            assert!(v[key].is_null(), "{key}");
        }
        assert_eq!((v["changedFiles"].clone(), v["commitsAhead"].clone(), v["unattended"].clone()), (json!(0), json!(0), json!(false)));
        let back: Agent = serde_json::from_value(v).unwrap();
        assert_eq!(back, agent);
        assert_eq!(Agent::default().status, AgentStatus::Starting);
        assert_eq!(Agent::default().status_source, AgentStatusSource::Guess);

        let all = [AgentStatus::Starting, AgentStatus::Running, AgentStatus::Waiting, AgentStatus::Done, AgentStatus::Failed, AgentStatus::Stopped, AgentStatus::Orphaned];
        let names: Vec<serde_json::Value> = all.iter().map(|s| serde_json::to_value(s).unwrap()).collect();
        assert_eq!(names, vec![json!("starting"), json!("running"), json!("waiting"), json!("done"), json!("failed"), json!("stopped"), json!("orphaned")]);
        assert_eq!(serde_json::to_value(AgentTemplateKind::Opencode).unwrap(), json!("opencode"));
        assert_eq!(serde_json::to_value(SectionId::Agents).unwrap(), json!("agents"));
        let test = AgentTestResult { state: AgentTestState::Passed, exit_code: Some(0), output: "ok".into(), started_at: "2026-10-16T08:00:00.000Z".into(), finished_at: None };
        assert_eq!(serde_json::to_value(&test).unwrap()["startedAt"], json!("2026-10-16T08:00:00.000Z"));
        assert_eq!(serde_json::to_value(AgentsChangedEvent { repo_id: "r".into(), running: 2 }).unwrap(), json!({ "repoId": "r", "running": 2 }));

        // Old stored settings (without the field) still load; the default is an empty list.
        assert_eq!(serde_json::to_value(Settings::default()).unwrap()["agentTemplates"], json!([]));
        assert_eq!(serde_json::to_value(RepoSettings::default()).unwrap()["testCommand"], json!(null));
    }
}

// ---------------------------------------------------------------------------
// Coding agents: collision warning (v1.2, package 2b)
// ---------------------------------------------------------------------------

/// Lines of a file, 1-based and inclusive, counted in the version of the first side of a
/// collision (the agent started first; against the base: the agent).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LineRange {
    pub start: u32,
    pub end: u32,
}

/// `conflict`: Git's merge of both states stops on conflicts. `overlap`: both change the same
/// files, but they merge cleanly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CollisionKind {
    Conflict,
    Overlap,
}

/// A file of a collision; `ranges` only for conflicting text files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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
#[serde(rename_all = "camelCase")]
pub struct CollisionSkip {
    pub agent_id: String,
    pub reason: String,
}

/// `pending`: never checked; `checking`: a check runs (the last collisions stay);
/// `failed`: the check failed (`error`), no collisions.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
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
#[serde(rename_all = "camelCase")]
pub struct CollisionBlock {
    pub range: LineRange,
    pub ours: String,
    pub theirs: String,
}

/// Both sides of every conflict of one file of a collision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
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

// ---------------------------------------------------------------------------
// Review of a coding agent's work (package 2c)
// ---------------------------------------------------------------------------

/// Which state of a coding agent its review compares with the base.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
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
