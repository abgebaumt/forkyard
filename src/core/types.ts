/**
 * Data types between the UI and the core.
 *
 * This file is the contract. The Rust core mirrors every type in
 * `crates/core/src/model.rs` with `#[serde(rename_all = "camelCase")]`;
 * union variants are in snake_case and carry the field `kind`
 * (`status` for results). Whoever changes something here changes it there in
 * the same step.
 */

export type Id = string;
export type Sha = string;
/** UTC, ISO-8601 with `Z`. */
export type IsoTime = string;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ErrorCode =
  | "not_a_repo"
  | "path_not_found"
  | "path_exists"
  | "git_missing"
  | "git_too_old"
  | "invalid_name"
  | "name_exists"
  | "not_found"
  | "dirty_worktree"
  | "conflict"
  | "nothing_to_commit"
  | "empty_message"
  | "identity_missing"
  | "hook_failed"
  | "push_rejected"
  | "no_upstream"
  | "no_remote"
  | "auth_failed"
  | "host_key_unknown"
  | "offline"
  | "timeout"
  | "stale_state"
  | "locked"
  | "not_merged"
  | "operation_in_progress"
  | "no_operation"
  | "not_allowed"
  | "nothing_to_undo"
  | "cancelled"
  | "duplicate"
  | "unsupported"
  | "io"
  | "unknown"
  /** No account is connected for the repository (or the host). */
  | "host_not_connected"
  /** The host rejects the token (invalid, expired, insufficient permissions) or it is missing from the keychain. */
  | "host_auth_failed"
  /** Request limit reached. `message` names the time (ISO-8601, UTC) from which it continues, if known. */
  | "host_rate_limited"
  /** The host does not know the repository, pull request or issue (or the token may not see it). */
  | "host_not_found"
  /** No remote on GitHub/GitLab, or the host cannot do what was asked. */
  | "host_unsupported"
  /** The host rejected the request on its merits (not mergeable, invalid input …); reason in `message`. */
  | "host_rejected"
  /** The host knows the token but does not allow it this (HTTP 403 without a rate limit). */
  | "host_forbidden"
  /**
   * The repository brings its own commands (hooks, entries in `.git/config`) and the user has
   * not agreed yet. Every command with `repoId` answers like this until `repoTrustSet` unlocks it.
   */
  | "repo_untrusted"
  /** The repository belongs only to other profiles. `repoProfiles` names them; `repoOpen` with `addToProfile: true` opens it anyway. */
  | "repo_other_profile";

/** This is how every error comes from the core. `message` is English and meant for humans. */
export interface CoreErrorData {
  code: ErrorCode;
  message: string;
  /** Raw output of Git, without credentials. */
  gitOutput: string | null;
  /**
   * Only for `host_rate_limited`: when it continues (ISO-8601, UTC), as far as the service
   * names it. The same time is also in `message`; missing otherwise.
   */
  retryAt?: IsoTime | null;
}

export class CoreError extends Error implements CoreErrorData {
  code: ErrorCode;
  gitOutput: string | null;
  retryAt: IsoTime | null;
  constructor(data: CoreErrorData) {
    super(data.message);
    this.name = "CoreError";
    this.code = data.code;
    this.gitOutput = data.gitOutput ?? null;
    this.retryAt = data.retryAt ?? null;
  }
}

// ---------------------------------------------------------------------------
// App, repositories, tabs
// ---------------------------------------------------------------------------

export type Platform = "windows" | "linux" | "macos";

export interface AppInfo {
  version: string;
  platform: Platform;
  /** e.g. "2.54.0"; null if no Git was found. */
  gitVersion: string | null;
  gitPath: string | null;
  /** Minimum version from the architecture (2.39). */
  gitMinVersion: string;
  dataDir: string;
  /** Whether the operating system's keychain is reachable. */
  keyringAvailable: boolean;
}

/**
 * Request from outside (start argument `<folder> [--commit <sha>]`, link
 * `forkyard://open?path=…&commit=…` or a second instance): open this folder and,
 * if given, show the commit. The core has checked the path (existing folder,
 * absolute) – whether it is a repository is only told by `repoOpen`.
 */
export interface LaunchRequest {
  path: string;
  /** SHA (lowercase, 4 to 64 characters, abbreviated too) or null. */
  commit: Sha | null;
  /**
   * Set if the request cannot be carried out: `path_not_found` = the folder does not exist
   * (or it is a file). `path` is then the requested path for display, `commit`
   * null – open nothing, only report. Missing for valid requests.
   */
  invalid?: "path_not_found" | "path_not_allowed" | null;
  /**
   * `true` if the request comes from a `forkyard://` link – so possibly from a
   * web page and not from the user. The UI then asks before opening a folder
   * that is not in the list yet. `invalid: "path_not_allowed"`: the link names a
   * network or device path; the app never opens such paths from a link (and does not touch them).
   * Missing for requests from the command line.
   */
  fromLink?: boolean;
}

export interface Repo {
  id: Id;
  path: string;
  /** Folder name. */
  name: string;
  alias: string | null;
  isFavorite: boolean;
  groupName: string | null;
  /** Lane colour 1–8 as a marker, or null. */
  color: number | null;
  lastOpenedAt: IsoTime | null;
  /** The folder no longer exists or is no longer a repository. */
  missing: boolean;
  /**
   * `false`: the repository brings its own commands (hooks, entries in `.git/config`), and the
   * user has not agreed to it yet. Until then every command for this repository answers
   * with `repo_untrusted`; `repoTrustGet` names the findings, `repoTrustSet` unlocks it.
   */
  trusted: boolean;
}

/** What in a repository would start programs or redirect connections without the user doing anything. */
export interface TrustFinding {
  /** `config`: entry in `.git/config`; `hook`: executable hook; `unreadable`: the configuration could not be read. */
  kind: "config" | "hook" | "unreadable";
  /** Key (`core.fsmonitor`) or name of the hook (`pre-commit`). */
  name: string;
  /** Value of the entry, shortened and without credentials; null for hooks. */
  value: string | null;
  /** One sentence on what it does. */
  reason: string;
}

export interface RepoTrust {
  repoId: Id;
  trusted: boolean;
  /** What the check currently finds (also for a trusted repository). */
  findings: TrustFinding[];
}

export type TabKind = "repo" | "management";

export interface Tab {
  id: Id;
  kind: TabKind;
  repoId: Id | null;
  position: number;
  isActive: boolean;
  /** Alias or folder name; empty for the repository manager tab. */
  title: string;
  path: string | null;
}

/** A profile, only for naming it (e.g. "belongs to …"). */
export interface ProfileRef {
  id: Id;
  name: string;
  /** Lane colour 1 to 8; null = by position in the list. */
  color: number | null;
}

export interface OpenedRepo {
  repo: Repo;
  tab: Tab;
  /**
   * Something succeeded, but not entirely (e.g. `repoInit`: created, but a hook rejected the first
   * commit). `output`: output of Git or of the hook.
   */
  notice?: { message: string; output: string | null } | null;
}

export interface CloneOptions {
  /** Shallow clone. */
  depth: number | null;
  shallowSince: string | null;
  branch: string | null;
  /** Sparse checkout: only these paths. */
  sparsePaths: string[];
  recurseSubmodules: boolean;
}

export interface InitOptions {
  /** Parent folder; the repository is created in `parentPath/name`. */
  parentPath: string;
  name: string;
  defaultBranch: string | null;
  /** Key from `initTemplates().gitignore`, or null. */
  gitignoreTemplate: string | null;
  /** Key from `initTemplates().licenses`, or null. */
  licenseTemplate: string | null;
  createReadme: boolean;
}

export interface InitTemplates {
  gitignore: { key: string; label: string }[];
  licenses: { key: string; label: string }[];
}

// ---------------------------------------------------------------------------
// Refs
// ---------------------------------------------------------------------------

export type RefKind = "local" | "remote" | "tag";

export interface Ref {
  /** Short name: `main`, `origin/main`, `v1.0`. */
  name: string;
  /** `refs/heads/main` etc. Unique key. */
  fullName: string;
  kind: RefKind;
  sha: Sha;
  /** The checked-out branch. */
  isHead: boolean;
  /** Short name of the upstream (`origin/main`), only for local branches. */
  upstream: string | null;
  /** The upstream is set but no longer exists. */
  upstreamGone: boolean;
  ahead: number;
  behind: number;
  /** Name of the remote, only for remote branches. */
  remote: string | null;
  /** Only for annotated tags. */
  annotation: string | null;
  isAnnotated: boolean;
  /** Checked out in another worktree. */
  worktreePath: string | null;
}

export type Head =
  | { kind: "branch"; branch: string; sha: Sha }
  | { kind: "detached"; sha: Sha }
  /** Fresh repository without a commit. */
  | { kind: "unborn"; branch: string };

export interface RefsSnapshot {
  head: Head;
  locals: Ref[];
  remotes: Ref[];
  tags: Ref[];
}

export type RemoteHost = "github" | "gitlab" | "bitbucket" | "azure" | "other";

export interface Remote {
  name: string;
  fetchUrl: string;
  /** Only if it differs from the fetch URL. */
  pushUrl: string | null;
  host: RemoteHost;
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

/** Label on a graph row. */
export interface RefLabelInfo {
  kind: RefKind;
  name: string;
  fullName: string;
  isHead: boolean;
}

/**
 * A line segment within the vertical band of a row.
 * `top` is the lane at the top edge, `bottom` the one at the bottom edge.
 * null means: the segment starts or ends at this row's node.
 *   top=2, bottom=2      line runs straight through in lane 2
 *   top=3, bottom=2      line switches from lane 3 to 2
 *   top=1, bottom=null   line comes from above in lane 1 and ends at the node
 *   top=null, bottom=0   line starts at the node and goes down in lane 0
 */
export interface GraphEdge {
  top: number | null;
  bottom: number | null;
  /** Colour index from 0; the UI takes it modulo 8 for `lane-1…8`. */
  color: number;
  dashed: boolean;
}

export type GraphRowKind = "commit" | "merge" | "wip" | "stash";

export interface GraphRow {
  /** For commits and stashes the SHA, for the WIP row `"wip"`. */
  id: string;
  kind: GraphRowKind;
  sha: Sha | null;
  lane: number;
  color: number;
  edges: GraphEdge[];
  parents: Sha[];
  /** First line of the message; empty for WIP (the UI writes the text). */
  summary: string;
  authorName: string;
  authorEmail: string;
  authoredAt: IsoTime | null;
  refs: RefLabelInfo[];
  /** HEAD points to this commit. */
  isHead: boolean;
  /** Only for `stash`: position in the stash list. */
  stashIndex: number | null;
  /** Only for `wip`: number of changed files. */
  wipCount: number | null;
}

export interface GraphPage {
  rows: GraphRow[];
  /** null when the history has ended. */
  nextCursor: string | null;
  /** Largest lane in this page, for the column width. */
  maxLane: number;
}

// ---------------------------------------------------------------------------
// Commits and files
// ---------------------------------------------------------------------------

export interface Person {
  name: string;
  email: string;
}

export type SignatureStatus = "none" | "good" | "bad" | "unknown";

export interface CommitInfo {
  sha: Sha;
  parents: Sha[];
  author: Person;
  committer: Person;
  authoredAt: IsoTime;
  committedAt: IsoTime;
  /** Author's time zone in minutes east of UTC, for the tooltip. */
  authorOffsetMinutes: number;
  summary: string;
  description: string;
  coAuthors: Person[];
  signature: SignatureStatus;
  refs: RefLabelInfo[];
  isHead: boolean;
  /** Contained in at least one remote branch. */
  isPushed: boolean;
}

export type FileStatus = "modified" | "added" | "deleted" | "renamed" | "conflicted" | "untracked";
export type FileArea = "unstaged" | "staged" | "commit";
export type ConflictKind =
  | "both_modified"
  | "both_added"
  | "both_deleted"
  | "deleted_by_us"
  | "deleted_by_them"
  | "added_by_us"
  | "added_by_them";

export interface FileChange {
  path: string;
  oldPath: string | null;
  status: FileStatus;
  area: FileArea;
  isBinary: boolean;
  isLfs: boolean;
  /** null if not counted (binary, very large). */
  added: number | null;
  removed: number | null;
  conflict: ConflictKind | null;
}

/** What `commitDetails` and `diffFile` compare. */
export type DiffSource =
  | { kind: "unstaged" }
  | { kind: "staged" }
  /** A commit against its first parent. */
  | { kind: "commit"; sha: Sha }
  /**
   * Two commits; `to: null` means working directory. `from` may be the empty tree
   * (`EMPTY_TREE_SHA`): then everything up to `to` counts as added – for the combined diff
   * of a sequence that starts at the root commit.
   */
  | { kind: "range"; from: Sha; to: Sha | null }
  | { kind: "stash"; index: number };

/** Git's empty tree (SHA-1 repositories); valid as `from` of a `range` source. */
export const EMPTY_TREE_SHA: Sha = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface CommitDetails {
  /** null for ranges and comparisons. */
  commit: CommitInfo | null;
  files: FileChange[];
  added: number;
  removed: number;
  /** For ranges: explanation if no combined diff is possible. */
  notCombinableReason: string | null;
}

export interface CommitSummary {
  sha: Sha;
  summary: string;
  author: Person;
  authoredAt: IsoTime;
  parents: Sha[];
}

// ---------------------------------------------------------------------------
// Status and running operations
// ---------------------------------------------------------------------------

export type OperationKind = "merge" | "rebase" | "cherry_pick" | "revert";

export interface Operation {
  kind: OperationKind;
  /** What comes in: branch name or short SHA. */
  source: string | null;
  /** Where to: branch name. */
  target: string | null;
  /** For rebase and multi-step cherry-pick. */
  step: number | null;
  totalSteps: number | null;
  /** Prepared commit message (MERGE_MSG). */
  message: string | null;
}

export interface UpstreamState {
  name: string;
  ahead: number;
  behind: number;
  gone: boolean;
}

export interface Status {
  head: Head;
  upstream: UpstreamState | null;
  unstaged: FileChange[];
  staged: FileChange[];
  conflicted: FileChange[];
  operation: Operation | null;
  /**
   * Paths whose conflict is already resolved in the running operation (read from the index) –
   * for "N of M conflicts resolved", also after a restart. Empty without an operation.
   */
  resolvedConflicts?: string[];
  /**
   * `"am"`: a `git am` (applying patches) started outside is waiting to be continued or
   * aborted. The app does not control it (`operation` is then null), but names it.
   */
  foreignOperation?: "am" | null;
  /**
   * Only in the response of `branchCheckout`: the switch left a detached HEAD whose
   * commits (`count` of them from `sha`) are not on any branch, tag or remote branch.
   */
  leftBehind?: { sha: Sha; count: number } | null;
  /** Git identity is set (user.name and user.email). */
  identitySet: boolean;
  /**
   * Fingerprint of HEAD and index. Write commands can receive it as
   * `expect` and abort with `stale_state` if it no longer matches.
   */
  token: string;
}

// ---------------------------------------------------------------------------
// Diff
// ---------------------------------------------------------------------------

export type DiffLineKind = "context" | "add" | "remove";

export interface DiffLine {
  kind: DiffLineKind;
  oldNo: number | null;
  newNo: number | null;
  /** Without line ending. Non-UTF-8 is decoded lossily for display. */
  text: string;
  /** "\ No newline at end of file" applies to this line. */
  noNewline: boolean;
}

export interface Hunk {
  index: number;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Text after the second `@@`, usually the enclosing function. */
  section: string;
  lines: DiffLine[];
}

export interface TextDiff {
  kind: "text";
  path: string;
  oldPath: string | null;
  status: FileStatus;
  hunks: Hunk[];
  /** Full versions for "Whole file" and "Side by side"; null if too large or not present. */
  oldText: string | null;
  newText: string | null;
  /** Detected encoding, e.g. "utf-8", "windows-1252". */
  encoding: string;
  /** Only for `unstaged` and `staged`: fingerprint for `stagePatch` etc. */
  token: string | null;
}

export type FileDiff =
  | TextDiff
  | { kind: "binary"; path: string; oldPath: string | null; status: FileStatus; oldSize: number | null; newSize: number | null }
  | {
      kind: "image";
      path: string;
      oldPath: string | null;
      status: FileStatus;
      /** data: URLs; null if the side does not exist. */
      oldDataUrl: string | null;
      newDataUrl: string | null;
      oldSize: number | null;
      newSize: number | null;
    }
  | {
      kind: "lfs";
      path: string;
      oldPath: string | null;
      status: FileStatus;
      oldOid: string | null;
      newOid: string | null;
      oldSize: number | null;
      newSize: number | null;
    }
  /** Over 1 MB or 20 000 lines: only load with `force: true`. */
  | { kind: "too_large"; path: string; oldPath: string | null; status: FileStatus; bytes: number; lines: number | null };

/** Selection for hunk and line staging. */
export interface PatchSelection {
  path: string;
  hunks: {
    index: number;
    /** Positions in `Hunk.lines` (add/remove only). null = the whole hunk. */
    lines: number[] | null;
  }[];
  /** `TextDiff.token` of the diff the selection was made on. */
  expect: string;
}

// ---------------------------------------------------------------------------
// Results of write actions
// ---------------------------------------------------------------------------

export interface HookOutput {
  hook: string;
  output: string;
  exitCode: number;
}

export interface CommitResult {
  sha: Sha;
  /** Only if "push afterwards" was chosen. */
  push: PushResult | null;
  hooks: HookOutput[];
}

/** Result of merge, rebase, cherry-pick, revert, pull, stash apply. */
export type OpResult =
  | { status: "done"; sha: Sha | null; fastForward: boolean; summary: string }
  | { status: "up_to_date" }
  /** `note`: ready-made hint about the conflict (e.g. "The stash is kept …"), otherwise null. */
  | { status: "conflict"; files: string[]; operation: Operation | null; note: string | null };

export type MergeMode = "default" | "ff_only" | "no_ff" | "squash";
export type PullMode = "ff" | "ff_only" | "rebase";
export type ResetMode = "soft" | "mixed" | "hard";

export type PushResult =
  | { status: "done"; remote: string; branch: string; createdUpstream: boolean; forced: boolean }
  | { status: "up_to_date" }
  /** The remote has commits that are missing locally. */
  | { status: "rejected"; reason: string };

export interface FetchResult {
  /** Number of changed remote refs. */
  updatedRefs: number;
  prunedRefs: number;
  /** Remotes that were not reachable, with reason. */
  failed: { remote: string; message: string }[];
}

export interface ConflictFile {
  path: string;
  kind: ConflictKind;
  /** null if the version does not exist or is binary. */
  base: string | null;
  ours: string | null;
  theirs: string | null;
  /** Current content in the working directory, with conflict markers. */
  merged: string | null;
  isBinary: boolean;
  oursLabel: string;
  theirsLabel: string;
  /** Encoding in which `conflictResolve` writes the text; null for binary files. */
  encoding: string | null;
}

export type RebaseAction = "pick" | "reword" | "squash" | "drop";

export interface RebasePlanRow {
  sha: Sha;
  summary: string;
  description: string;
  author: Person;
  authoredAt: IsoTime;
  action: RebaseAction;
  /** New message for `reword` or for the result of a `squash`. */
  message: string | null;
}

export type RebasePlan =
  | {
      status: "ok";
      branch: string;
      base: Sha;
      /** Oldest commit first, as in Git's todo file. */
      rows: RebasePlanRow[];
      /** At least one of the commits is already on a remote. */
      rewritesPushed: boolean;
    }
  | {
      status: "refused";
      /** `operation_in_progress`: a merge, rebase, cherry-pick or revert is already running. */
      reason: "merge_commits" | "no_common_ancestor" | "nothing_to_rebase" | "dirty_worktree" | "detached" | "operation_in_progress";
      /**
       * Only for `no_common_ancestor`: `not_ancestor` = the base is related, but not an ancestor
       * (rebasing onto it first helps); `unrelated_history` = no common history at all. Otherwise null.
       */
      detail?: "not_ancestor" | "unrelated_history" | null;
      message: string;
    };

// ---------------------------------------------------------------------------
// Stash, undo, history, files
// ---------------------------------------------------------------------------

export interface Stash {
  index: number;
  sha: Sha;
  message: string;
  /** Branch on which the stash was made. */
  branch: string | null;
  baseSha: Sha;
  createdAt: IsoTime;
  fileCount: number;
}

export interface UndoStep {
  /** Ready-made sentence for the tooltip, e.g. "Undo commit ‘Fix typo’". */
  label: string;
  action: string;
}

export interface UndoState {
  undo: UndoStep | null;
  redo: UndoStep | null;
  /**
   * Why the last action can no longer be undone although there was one (e.g. its
   * commit has already been pushed). Only set if `undo` is empty.
   */
  undoBlocked?: string | null;
}

export interface FileHistoryEntry {
  commit: CommitSummary;
  /** Path of the file in this commit (follows renames). */
  path: string;
  oldPath: string | null;
  status: FileStatus;
  added: number | null;
  removed: number | null;
}

export interface BlameLine {
  lineNo: number;
  text: string;
  sha: Sha;
  author: Person;
  authoredAt: IsoTime;
  summary: string;
  /** Line is not committed yet. */
  uncommitted: boolean;
}

export interface FileContent {
  path: string;
  /** null for binary files. */
  text: string | null;
  isBinary: boolean;
  encoding: string;
  eol: "lf" | "crlf" | "mixed";
  size: number;
}

// ---------------------------------------------------------------------------
// View, drafts, settings
// ---------------------------------------------------------------------------

export type GraphColumnId = "refs" | "graph" | "message" | "author" | "date" | "sha";
export type SectionId = "local" | "remote" | "tags" | "stashes" | "worktrees" | "submodules";

export interface RepoViewState {
  /** `fullName` of the refs hidden in the graph. */
  hiddenRefs: string[];
  /** If not empty, the graph shows only these refs. */
  soloRefs: string[];
  pinnedRefs: string[];
  collapsedFolders: string[];
  columns: { id: GraphColumnId; visible: boolean; width: number | null }[];
  sections: { id: SectionId; collapsed: boolean; hidden: boolean }[];
  /** Merge commits whose side branch the graph hides (full SHAs). */
  collapsedMerges: Sha[];
  /** Every merge is collapsed – also those on pages loaded later. */
  collapseAllMerges: boolean;
}

export interface CommitDraft {
  summary: string;
  description: string;
  amend: boolean;
}

export type Theme = "dark" | "light" | "system";

/** Level of a setting: `global` applies in all profiles, `profile` only in the active one. */
export type SettingScope = "global" | "profile";
export type DateFormat = "relative" | "local" | "iso";
export type DiffMode = "hunks" | "inline" | "split";

/** Global settings of the active profile. The core sets the defaults. */
export interface Settings {
  theme: Theme;
  /** 0.8 to 1.5 */
  zoom: number;
  dateFormat: DateFormat;
  /** Initials instead of avatars. */
  showInitials: boolean;
  toolbarLabels: boolean;
  rememberTabs: boolean;
  defaultBranchName: string;
  /** 0 = off, otherwise 1 to 60. */
  autoFetchMinutes: number;
  autoPrune: boolean;
  /** Commits per page on first load, at least 500. */
  initialCommits: number;
  lazyLoad: boolean;
  defaultPullMode: PullMode;
  squashOnMerge: boolean;
  pushAfterCommit: boolean;
  /** Delete `.orig` files after a resolved conflict. */
  deleteOrigFiles: boolean;
  diffMode: DiffMode;
  diffWordWrap: boolean;
  diffIgnoreWhitespace: boolean;
  editorFontSize: number;
  editorTabSize: number;
  /** Command line with `{path}`, or null for the system default. */
  externalEditor: string | null;
  externalTerminal: string | null;
  /** Command line with `{local}` and `{remote}`; null = `git difftool` with the user's Git configuration. */
  externalDiffTool: string | null;
  /** Command line with `{base}`, `{local}`, `{remote}`, `{merged}`; null = `git mergetool`. */
  externalMergeTool: string | null;
  notifyOnFetch: boolean;
  notifyOnError: boolean;
  sshUseAgent: boolean;
  // --- Network (applies only to the app's network calls; the user's gitconfig stays untouched) ---
  /**
   * Proxy for all HTTP(S) remotes, e.g. `http://proxy.company.example:8080` (also `https`,
   * `socks4`, `socks4a`, `socks5`, `socks5h`; `user:password@` possible). null = none.
   */
  proxyUrl?: string | null;
  /**
   * Different proxy per host. `host`: `git.example.com`, `git.example.com:8443` or an
   * https/http address – the core stores `https://host[:port]`. `proxy: ""` = no proxy
   * for this host.
   */
  proxyByHost?: { host: string; proxy: string }[];
  /** Own CA bundle: path of a PEM file (must exist). null = the system's certificates. */
  sslCaFile?: string | null;
  /**
   * Hosts for which certificate verification is turned off – only these, never globally. Input as
   * for `proxyByHost.host`; wildcards (`*`) are rejected with `not_allowed`.
   */
  sslNoVerifyHosts?: string[];
}

/** App-side settings per repository. */
export interface RepoSettings {
  encoding: string;
  /** null = Git's default. */
  hooksPath: string | null;
  /** Raw value of `commit.template` in the repository's .git/config (a path). */
  commitTemplate: string | null;
  /**
   * Read-only: content of the effective template file (`commit.template` local, otherwise global;
   * `~` resolved, also outside the repository), as it is in the file – lines starting with
   * `#` are comments that Git removes on commit. null: no template, file missing, over
   * 256 KB or not text. `repoSettingsSet` ignores the field.
   */
  commitTemplateText: string | null;
  /** Overrides the global default; null = global. */
  defaultPullMode: PullMode | null;
  autoFetch: boolean;
  /** Identity for this repository only (stored in .git/config). */
  authorName: string | null;
  authorEmail: string | null;
  /**
   * SSH key for this repository only (from the active profile's keys); the app
   * enforces it for its network calls, even with an SSH agent. null = like the profile. A key
   * from another profile yields `not_found`; if its file is missing, fetch/pull/push fail with
   * `path_not_found`. If the key is removed, the choice is null again.
   */
  sshKeyId: Id | null;
}

export interface Profile {
  id: Id;
  name: string;
  authorName: string;
  authorEmail: string;
  /** Write name and email into the global gitconfig. */
  syncGitconfig: boolean;
  isActive: boolean;
  /** Lane colour 1 to 8; null = by position in the list. */
  color: number | null;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export interface SshKey {
  id: Id;
  label: string;
  privateKeyPath: string;
  publicKeyPath: string;
  /** Content of the .pub file for copying. */
  publicKey: string;
  fingerprint: string | null;
  hasPassphrase: boolean;
  /** This key is used for SSH connections. */
  isDefault: boolean;
  /** One of the files is missing. */
  missing: boolean;
}

/** A remembered entry in the keychain – without the secret. */
export interface HostAccount {
  id: Id;
  host: string;
  username: string;
  kind: "password" | "passphrase";
  createdAt: IsoTime;
}

export type CredentialKind = "username" | "password" | "passphrase" | "host_key";

export interface CredentialRequest {
  requestId: string;
  kind: CredentialKind;
  host: string;
  /** For `password`: the user name, if already known. */
  username: string | null;
  /** For `passphrase`: path of the key. For `host_key`: the fingerprint. */
  detail: string | null;
  /** Original prompt text from Git or SSH. */
  prompt: string;
  /** Whether "remember" can be offered (keychain reachable). */
  canRemember: boolean;
}

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

export type ActivityScope = "app" | "repo";

export interface ActivityEntry {
  id: Id;
  scope: ActivityScope;
  repoId: Id | null;
  startedAt: IsoTime;
  durationMs: number;
  /** Command line without credentials, e.g. `git fetch --all --prune`. */
  command: string;
  exitCode: number | null;
  /**
   * For network calls with an enforced SSH key (setting "Use SSH agent" off) the
   * output ends with the line `SSH key: <path>`.
   */
  output: string;
  /** Error code of a failed call (the same as in the `CoreError`), otherwise null. */
  code?: ErrorCode | null;
}

export interface ActivityPage {
  entries: ActivityEntry[];
  nextCursor: string | null;
}

export type CrashReportKind = "panic" | "unexpected_exit";

/** A pending crash report as listed. */
export interface CrashReportSummary {
  id: Id;
  /** ISO 8601, UTC. */
  time: string;
  kind: CrashReportKind;
  appVersion: string;
  /** First line of the message, shortened. */
  message: string;
}

/** `diff_tool` and `merge_tool` need a `path` in `openExternal` (see api.ts). */
export type ExternalTarget = "editor" | "terminal" | "file_manager" | "diff_tool" | "merge_tool";

// ---------------------------------------------------------------------------
// Worktrees, submodules, LFS, patches, signing
// ---------------------------------------------------------------------------

/** A working directory of the repository (`git worktree`). */
export interface Worktree {
  path: string;
  /** Short name of the checked-out branch; null for a detached HEAD. */
  branch: string | null;
  head: Sha | null;
  /** The main worktree (the repository itself). */
  isMain: boolean;
  /** The worktree that is open under this `repoId`. */
  isCurrent: boolean;
  isLocked: boolean;
  lockReason: string | null;
  /** The folder is missing; `worktreePrune` cleans up the entry. */
  isPrunable: boolean;
  /** Uncommitted changes or untracked files (removing then needs `force`). */
  hasChanges: boolean;
}

/**
 * - `initialized`: checked out, at the recorded commit, without own changes
 * - `uninitialized`: recorded, but not fetched yet
 * - `out_of_sync`: a different commit is checked out than recorded
 * - `modified`: own changes or untracked files in the submodule
 */
export type SubmoduleState = "initialized" | "uninitialized" | "out_of_sync" | "modified";

export interface Submodule {
  /** Name in `.gitmodules` (usually the same as the path). */
  name: string;
  path: string;
  /** URL from `.gitmodules`, without credentials. */
  url: string | null;
  /** The commit recorded in the repository. */
  sha: Sha;
  /** The commit checked out in the submodule; null if it is not initialized. */
  headSha: Sha | null;
  state: SubmoduleState;
  /** Branch checked out in the submodule; null for a detached HEAD (the normal case). */
  branch: string | null;
  /** Branch recorded in `.gitmodules`. */
  trackingBranch: string | null;
}

export interface LfsStatus {
  installed: boolean;
  /** e.g. "3.7.1"; null without Git LFS. */
  version: string | null;
  /** Patterns tracked via LFS, sorted. */
  patterns: string[];
}

export interface PatchText {
  /** The patch; empty if there is nothing to show. */
  text: string;
  /** Files that are missing because they are binary or their diff is not valid UTF-8. */
  skipped: string[];
}

export type SigningFormat = "openpgp" | "ssh" | "x509";

export interface SigningStatus {
  /** `commit.gpgSign` */
  enabled: boolean;
  /** `gpg.format`; null = not set (Git uses OpenPGP). */
  format: SigningFormat | null;
  /** `user.signingKey`: key ID, path of the public SSH key, or certificate ID. */
  key: string | null;
  /** The configured program (`gpg.program`, `gpg.ssh.program`, `gpg.x509.program`), otherwise null. */
  program: string | null;
  /** `gpg.ssh.allowedSignersFile` (for verifying SSH signatures), otherwise null. The core always returns the field. */
  allowedSignersFile?: string | null;
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

/** Named group of repositories from the repository list (per profile). */
export interface Workspace {
  id: Id;
  name: string;
  /** In the stored order. A forgotten repository (`repoForget`) drops out by itself. */
  repoIds: Id[];
}

/**
 * - `done`: something arrived (fetch) or the branch was advanced (pull)
 * - `up_to_date`: nothing to do
 * - `conflict`: the pull stopped in a conflict – resolve it in the repository
 * - `failed`: error (see `code` and `message`); the other repositories kept going
 * - `skipped`: no remote or no upstream
 */
export type WorkspaceRepoStatus = "done" | "up_to_date" | "conflict" | "failed" | "skipped";

export interface WorkspaceRepoResult {
  repoId: Id;
  /** Alias or folder name. */
  name: string;
  status: WorkspaceRepoStatus;
  /** Ready-made sentence. */
  message: string;
  /** For `failed`, `skipped` and `conflict` the error code, otherwise null. */
  code: ErrorCode | null;
}

export interface WorkspaceRunResult {
  /** One entry per repository of the workspace, in its order. */
  results: WorkspaceRepoResult[];
  /** Number with `failed` or `conflict`. */
  failed: number;
}

// ---------------------------------------------------------------------------
// Gitflow
// ---------------------------------------------------------------------------

export type GitflowKind = "feature" | "release" | "hotfix";

/** Prefixes as in Git's `gitflow.prefix.*` keys. */
export interface GitflowPrefixes {
  /** Default `feature/`. */
  feature: string;
  /** Default `release/`. */
  release: string;
  /** Default `hotfix/`. */
  hotfix: string;
  /** Prefix of the version tags, often empty or `v`. */
  versionTag: string;
}

export interface GitflowStatus {
  /** `gitflow.branch.master` and `gitflow.branch.develop` are set (also by `git flow init`). */
  initialized: boolean;
  /** Set up: the value from the configuration. Otherwise a suggestion for `gitflowInit`. */
  main: string;
  develop: string;
  prefixes: GitflowPrefixes;
  /** Running branches (only if set up): `branch` = prefix + `name`. */
  active: { kind: GitflowKind; name: string; branch: string }[];
}

/** Every field may be omitted. */
export interface GitflowFinishOptions {
  /** Delete the finished branch. Default: true. */
  deleteBranch?: boolean;
  /** Release/hotfix only: name of the tag; if omitted, version prefix + name. */
  tag?: string | null;
  /** Release/hotfix only: message of the annotated tag; if omitted, "Release <name>" or "Hotfix <name>". */
  message?: string | null;
  /** Push target branches and tag afterwards (to the upstream, otherwise to the only remote or `origin`). */
  push?: boolean;
  /** Release/hotfix only: do not create a tag. */
  noTag?: boolean;
}

// ---------------------------------------------------------------------------
// Events from the core
// ---------------------------------------------------------------------------

export type RepoChange = "worktree" | "index" | "refs" | "head" | "stash" | "config" | "operation";
/** `credentials`: remembered credentials (`credentialsList`), `ssh_keys`: SSH keys (`sshKeyList`), `workspaces`: `workspaceList`. */
export type AppChange = "tabs" | "repos" | "settings" | "profiles" | "credentials" | "ssh_keys" | "workspaces" | "host_accounts";

export interface CoreEvents {
  "repo:changed": { repoId: Id; what: RepoChange[] };
  /**
   * For `workspaceFetch`/`workspacePull`, `repoId` carries the repository whose turn it
   * currently is: `phase: "start"` at the beginning (percent = share of the whole run), then Git's phases,
   * finally the status of this repository (`done`, `up_to_date`, `conflict`, `failed`,
   * `skipped`) with the ready-made sentence in `line`.
   */
  "job:progress": { jobId: string; repoId: Id | null; phase: string; percent: number | null; line: string };
  "job:done": { jobId: string; repoId: Id | null; ok: boolean; cancelled: boolean; message: string | null };
  "credential:request": CredentialRequest;
  /** The prompt ended without an answer (time limit, Git exited, action cancelled): close the dialog. */
  "credential:closed": { requestId: string };
  /**
   * A hook printed something or failed. The core sends the event BEFORE
   * the triggering command responds (even if that one fails with `hook_failed`). Captured for
   * commit, reword, merge, continue, rebase, interactive rebase, squash, cherry-pick,
   * revert, push and tag push.
   */
  "hook:output": { repoId: Id; hook: string; output: string; exitCode: number };
  "log:appended": ActivityEntry;
  /** Tabs, repository list, settings, profiles, credentials or SSH keys have changed. */
  "app:changed": { what: AppChange[] };
  /**
   * Output of a built-in terminal: batched (about every 12 ms, at most 64 KB per event)
   * and always valid UTF-8 – straight into xterm.js's `terminal.write(data)`.
   */
  "terminal:data": { terminalId: Id; data: string };
  /** The shell has ended (also after `terminalClose`); comes after the last output, exactly once. */
  "terminal:exit": { terminalId: Id; code: number | null };
  /**
   * While the app is running: a second instance or a link asks to open a folder. Only comes
   * after the UI has called `appLaunchRequest()` once – whatever arrives before that
   * is returned by that call.
   */
  "app:open_request": LaunchRequest;
  /**
   * The window is supposed to close, but the UI has reported via `appCloseGuard` that something
   * would be lost: it asks the user and calls `appQuit` – or leaves the window open.
   */
  // No payload. (Written as a literal object type: that is how the contract check in scripts/e2e/contract.mjs reads it.)
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  "app:close_requested": {};
}

// ---------------------------------------------------------------------------
// Hosts (GitHub, GitLab): accounts, pull requests, issues
// ---------------------------------------------------------------------------

/** Supported hosts, also as a self-hosted instance (GitHub Enterprise Server, GitLab self-managed). */
export type HostKind = "github" | "gitlab";

export interface HostUser {
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

/**
 * A connected account at a host. The token itself never leaves the core; `tokenHint`
 * shows `…` and the last four characters. Per profile there is at most one account per host address.
 */
export interface HosterAccount {
  id: Id;
  kind: HostKind;
  /** Address of the web UI without a trailing slash, e.g. `https://github.com`. */
  baseUrl: string;
  /** null as long as the account has never been checked successfully. */
  user: HostUser | null;
  tokenHint: string | null;
  /** Whether the token has the necessary permissions – as far as the host reveals it (otherwise true). */
  scopesOk: boolean;
  /** Missing permissions, e.g. `["repo"]` (GitHub) or `["api"]` (GitLab). */
  missingScopes: string[];
  /** Last error of this account (e.g. token expired), null after a success. */
  lastError: string | null;
}

export interface HostRepoRef {
  owner: string;
  name: string;
  webUrl: string;
}

/** The repository at the host, recognised by a remote's URL. */
export interface HostRepoInfo {
  /** Name of the remote it was recognised by. */
  remote: string;
  kind: HostKind;
  /** The connected account for this host; null = none (then the host-provided fields are null). */
  account: HosterAccount | null;
  /** On GitLab with groups: `group/subgroup`. */
  owner: string;
  name: string;
  webUrl: string;
  defaultBranch: string | null;
  canPush: boolean | null;
  /** The repository this one is a fork of. */
  forkParent: HostRepoRef | null;
  /** Set if an account exists but the host refused or did not respond. */
  error: { code: ErrorCode; message: string } | null;
}

export type PrState = "open" | "closed" | "merged";
/** Filter for `prList`. `closed` means closed WITHOUT a merge. */
export type PrListState = PrState | "all";
/** Summarised state of the checks (CI). */
export type ChecksState = "passing" | "failing" | "pending";
/** `review_required`: reviewers have been requested but have not decided yet. */
export type PrReviewState = "approved" | "changes_requested" | "review_required" | "commented";

export interface HostLabel {
  name: string;
  /** `#rrggbb`, if the host names a colour (GitLab in lists: null). */
  color: string | null;
}

export interface PrSummary {
  number: number;
  title: string;
  state: PrState;
  isDraft: boolean;
  author: HostUser | null;
  sourceBranch: string;
  targetBranch: string;
  updatedAt: IsoTime;
  webUrl: string;
  /** null = no checks (or not readable). */
  checks: ChecksState | null;
  reviewState: PrReviewState | null;
  labels: HostLabel[];
  /** The source branch is in a fork. */
  isFork: boolean;
}

export interface PrPage {
  items: PrSummary[];
  /** Number of the next page; null = end. */
  nextPage: number | null;
}

export interface PrReviewer {
  user: HostUser;
  /** null = requested, no decision yet. */
  state: PrReviewState | null;
}

export interface HostComment {
  id: string;
  author: HostUser | null;
  /** Markdown. */
  body: string;
  createdAt: IsoTime;
  /** Only for comments on a line of the diff. */
  path: string | null;
  line: number | null;
}

export interface PrCommit {
  sha: Sha;
  summary: string;
  authorName: string;
  authoredAt: IsoTime;
}

export interface PrCheck {
  name: string;
  state: ChecksState | "skipped";
  url: string | null;
}

export interface PrDetails extends PrSummary {
  /** Markdown. */
  body: string;
  reviewers: PrReviewer[];
  /** General comments, review texts and comments on lines, by time (at most 500 per kind). */
  comments: HostComment[];
  commits: PrCommit[];
  /** null = the host is still computing. */
  mergeable: boolean | null;
  /** The individual checks; `checks` is their summary. */
  checkRuns: PrCheck[];
  headSha: Sha;
}

/** GitLab only has `merge` and `squash` (`rebase` → `host_unsupported`). */
export type PrMergeMethod = "merge" | "squash" | "rebase";

export type IssueState = "open" | "closed";

export interface IssueSummary {
  number: number;
  /** Identifier for display, e.g. `#12`. */
  key: string;
  title: string;
  state: IssueState;
  author: HostUser | null;
  assignees: HostUser[];
  labels: HostLabel[];
  updatedAt: IsoTime;
  webUrl: string;
}

export interface IssuePage {
  items: IssueSummary[];
  nextPage: number | null;
}

export interface IssueDetails extends IssueSummary {
  /** Markdown. */
  body: string;
  comments: HostComment[];
}
