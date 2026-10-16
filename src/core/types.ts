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
  | "repo_other_profile"
  /** A bisect is already running (`bisectStart`). */
  | "bisect_active"
  /** A command from the repository's `.forkyard/commands.json` that is not approved for this version of the file. */
  | "command_untrusted"
  /** Git could not sign the commit or tag: key file missing, signing program missing or failing. */
  | "signing_failed"
  /** AI is off: master switch, the function or "AI off for this repository". */
  | "ai_disabled"
  /** No provider/model/address/key set up, or the key was rejected – Settings › AI. */
  | "ai_not_configured"
  /** The provider does not answer, is overloaded (`retryAt` when it says so) or does not know the model. */
  | "ai_provider_unavailable"
  | "ai_not_logged_in"
  /** The answer did not match the schema, also after one repair attempt. */
  | "ai_invalid_answer"
  /** The provider declined; the message carries its redacted text. */
  | "ai_refused"
  /** Monthly cost limit reached; confirm "send this time" with `aiPreviewConfirm` (trigger `limit`). */
  | "ai_limit_reached"
  | "ai_too_large"
  | "ai_unsupported_version";

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

/** A stable Forkyard release on GitHub. */
export interface UpdateRelease {
  /** Without a leading "v", e.g. "1.2.0". */
  version: string;
  /** Release page; the core only lets addresses under https://github.com/abgebaumt/forkyard/ through. */
  url: string;
  /** Release notes as written (Markdown), shortened – show only as plain text. */
  notes: string;
  publishedAt: string | null;
}

export interface UpdateInfo {
  /** Version of this build. */
  current: string;
  /** A newer stable release, if there is one. */
  latest: UpdateRelease | null;
  /** Last attempt to ask GitHub; null = never. */
  checkedAt: string | null;
  /** Version whose notice was already shown. */
  notifiedVersion: string | null;
  /** Version the user skipped: no notice for it. */
  skippedVersion: string | null;
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

/** Position of a commit relative to the checked-out branch and its upstream. */
export type SyncMark = "none" | "ahead" | "behind";

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
  /** Only for merges: collapsed, with this many commits hidden below it; null = expanded. */
  collapsedCount: number | null;
  /** The merge is meant to be collapsed but brings in more than 20 000 commits: it stays expanded. */
  collapseTooLarge: boolean;
  /** Commit of the checked-out branch not pushed yet (`ahead`) or of its upstream not pulled yet (`behind`). */
  sync: SyncMark;
}

export interface GraphPage {
  rows: GraphRow[];
  /** null when the history has ended. */
  nextCursor: string | null;
  /** Largest lane in this page, for the column width. */
  maxLane: number;
}

/** What a reflog entry records, from the start of its message. */
export type ReflogAction = "checkout" | "commit" | "reset" | "rebase" | "merge" | "pull" | "cherry_pick" | "amend" | "other";

export interface ReflogEntry {
  /** Where the ref pointed after the change. */
  sha: Sha;
  /** `HEAD@{3}`, `main@{0}` … */
  selector: string;
  action: ReflogAction;
  /** Git's text, without credentials. */
  message: string;
  time: IsoTime;
  /** The commit still exists (Git may have removed it, e.g. after `gc`). */
  exists: boolean;
}

export interface ReflogPage {
  entries: ReflogEntry[];
  /** null when the reflog has ended. */
  nextCursor: string | null;
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

/** Narrowing for `commitSearch`; every field is optional. */
export interface CommitSearchFilters {
  /** Commits that add or remove this text in a file (`git log -S`, ignoring case). */
  pickaxe?: string | null;
  /** Committed at or after: `YYYY-MM-DD` (start of that day, local time) or ISO-8601 with time. */
  since?: string | null;
  /** Committed at or before: `YYYY-MM-DD` (end of that day, local time) or ISO-8601 with time. */
  until?: string | null;
  /** Only commits touching these paths (files or folders, relative to the repository, literal). */
  paths?: string[] | null;
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

/** Verdict on a commit during a bisect. */
export type BisectVerdict = "good" | "bad" | "skip";

/** State of a bisect, read from the Git directory (`active: false` = none running). */
export interface BisectStatus {
  active: boolean;
  bad: Sha | null;
  good: Sha[];
  skipped: Sha[];
  /** The commit to test now. */
  current: Sha | null;
  /** Git's estimate of the steps after this one; null until a bad and a good commit are known. */
  remainingSteps: number | null;
  /** Commits marked since the start. */
  stepsDone: number;
  /** The first bad commit, as soon as it is certain. */
  result: Sha | null;
  /** Only skipped commits are left between good and bad: the first bad one is among them. */
  onlySkippedLeft: boolean;
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
  /** Only for a range between two commits: fingerprint for `rangeApply` (`PatchSelection.expect`). */
  rangeToken?: string | null;
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

/** Where `rangeApply` puts the selected changes. */
export type RangeApplyTarget = "worktree" | "index" | "both";

/** Selected lines for `stashCreate` (partial stash). Each entry as `stagePatch` takes it. */
export interface StashSelection {
  /** HEAD the selection was made on; otherwise `stale_state`. */
  expectHead: Sha;
  /** From the staged diff of a file. */
  staged: PatchSelection[];
  /** From the unstaged diff of a file. */
  unstaged: PatchSelection[];
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

/** A further branch or tag for the same push (`push` with `extra`). */
export interface PushExtra {
  /** `refs/heads/<branch>` or `refs/tags/<tag>`. */
  local: string;
  /** Name on the remote without `refs/heads/` / `refs/tags/`; null = the same name. */
  remoteName: string | null;
  /** Branches only: overwrite with `--force-with-lease`. Tags are never forced. */
  force: boolean;
}

export type PushRefStatus = "ok" | "up_to_date" | "rejected";

export interface PushRefResult {
  local: string;
  /** Full ref on the remote. */
  remoteRef: string;
  status: PushRefStatus;
  forced: boolean;
  /** Git's reason for a rejection, e.g. "non-fast-forward", "atomic push failed". */
  reason: string | null;
}

export type PushResult =
  | { status: "done"; remote: string; branch: string; createdUpstream: boolean; forced: boolean }
  | { status: "up_to_date" }
  /** The remote has commits that are missing locally. */
  | { status: "rejected"; reason: string }
  /** Several refs in one push (`extra`): one result per ref, the primary branch first. */
  | { status: "multi"; remote: string; atomic: boolean; refs: PushRefResult[] }
  /** The local secret scan stopped the push; nothing was sent. Push again with `acceptedSecrets` = the IDs to push anyway. */
  | { status: "secrets_found"; findings: SecretFinding[]; commits: number; partial: boolean };

/** Why the secret scan before a push reported a line: known token format, private key, named password/token, password in an address, random-looking string. */
export type SecretRule = "known_token" | "private_key" | "credential" | "url_password" | "high_entropy";

/** One added line that looks like a key. The value never leaves the core: `excerpt` masks it, `hint` is at most its last four characters. */
export interface SecretFinding {
  /** Hash of path and line content; "Don't report again" stores it. */
  id: string;
  path: string;
  /** Line in the new version of the file. */
  line: number;
  /** The newest outgoing commit that adds the line. */
  commit: Sha;
  rule: SecretRule;
  excerpt: string;
  hint: string;
}

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

/** One conflict block of the conflict tool: 0-based first line and number of lines on both sides (stages 2 and 3). */
export interface ConflictBlockRange {
  oursStart: number;
  oursCount: number;
  theirsStart: number;
  theirsCount: number;
}

/** How a block went to the AI: completely; start and end only, or with masked values (both: explanation only); not at all. */
export type IntentSent = "full" | "shortened" | "redacted" | "left_out";

/** The answer for one conflict block; `block` is the 0-based conflict index, `text` only for `full`. */
export interface ConflictIntentBlock {
  block: number;
  sent: IntentSent;
  oursWhy: string | null;
  theirsWhy: string | null;
  text: string | null;
}

/** `aiConflictIntent`: one entry per conflict block, in order. */
export interface ConflictIntent {
  path: string;
  blocks: ConflictIntentBlock[];
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
      /** Local branches pointing into the range (except this one and branches checked out in a worktree) – `updateRefs` moves them along. */
      dependentBranches: string[];
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

/** What `conflictPreview` simulates. */
export type PreviewOp =
  | { kind: "merge"; theirs: string }
  | { kind: "cherry_pick"; commits: Sha[] }
  | { kind: "revert"; commits: Sha[] }
  /** `branch: null` = HEAD; `upstream: null` = `onto`; `commits`: explicit order (interactive plan), null = what Git would replay. */
  | { kind: "rebase"; onto: string; upstream: string | null; branch: string | null; commits: Sha[] | null }
  | { kind: "patch"; text: string };

export type ConflictPreview =
  | { status: "clean" }
  /** `atCommit`: in a series, the first commit that conflicts. */
  | { status: "conflicts"; files: string[]; atCommit: Sha | null }
  /** Not simulated (too many commits, merge commit, unrelated history, invalid patch, Git older than 2.40 for a series). */
  | { status: "unknown"; reason: string };

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

/** One step of `lineHistory`. */
export interface LineHistoryStep {
  commit: CommitSummary;
  /** Path of the file in this commit (follows renames). */
  path: string;
  /** Line range in this commit's version of the file (1-based, inclusive). */
  startLine: number;
  endLine: number;
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

// --- AI (v1.2) ------------------------------------------------------------------

/** One provider for every AI function and every profile (Settings › AI). */
export type AiProviderKind = "anthropic" | "openai" | "openai_compatible" | "gemini" | "ollama" | "lmstudio" | "claude_code" | "codex" | "opencode";

/** AI functions; each one can be switched off (`Settings.aiFeaturesOff`). */
export type AiFeature =
  | "commit_message"
  | "pr_description"
  | "compose"
  | "conflict_intent"
  | "push_review"
  | "plan"
  | "archaeology"
  | "release_notes"
  | "bisect_script"
  | "semantic_search"
  | "review_fix";

/** `unset`: never set up and never turned off; `off`: turned off on purpose; `on`. */
export type AiState = "unset" | "off" | "on";

/** Own price for a model, USD per million tokens; wins over the built-in table. */
export interface AiPriceOverride {
  model: string;
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
}

/** Why a file is not sent (completely): secret/ignored = never, not even the name; generated/binary = name and size; budget = name and line counts. */
export type AiOmitReason = "secret" | "ignored" | "generated" | "binary" | "budget";

/** A file of the context that is not sent (completely); `size` in bytes, 0 if unknown. */
export interface AiOmitted {
  path: string;
  reason: AiOmitReason;
  size: number;
}

export type AiPriceSource = "builtin" | "own";

/** USD per million tokens; `asOf` = date of the built-in table, null for own prices. */
export interface AiPrice {
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
  source: AiPriceSource;
  asOf: string | null;
}

export interface AiModelInfo {
  id: string;
  label: string;
  /** Context window in tokens, null if the provider does not say. */
  contextTokens: number | null;
}

/** `json_schema`: enforced by the provider; `json_object`: JSON only; `prompt`: schema in the prompt. The core validates in every case. */
export type AiStructuredMode = "json_schema" | "json_object" | "prompt";

export interface AiModelList {
  models: AiModelInfo[];
  structured: AiStructuredMode;
}

/** Why the preview asks before sending: first use of a function, > 100 000 characters, cost above the threshold, first content of this repository, monthly limit reached. */
export type AiAskTrigger = "first_use" | "large" | "cost" | "repo_first" | "limit";

/** `aiStatus`: drives the visibility of every AI element and Settings › AI. */
export interface AiStatus {
  state: AiState;
  provider: AiProviderKind | null;
  model: string | null;
  /** Provider, model, address and – where needed – the key are there. */
  connected: boolean;
  /** "…abcd" of the stored key of the chosen provider; never more. */
  keyHint: string | null;
  local: boolean;
  /** Own or built-in price of the chosen model; null = unknown or local. */
  price: AiPrice | null;
  /** Only in "unset": the one-time notice after the update to 1.2 is due. */
  introPending: boolean;
  featuresOff: AiFeature[];
}

/** What `aiPreview` builds the text from; later packages add variants. */
export type AiInput = { kind: "staged_changes" } | { kind: "commit_message" } | { kind: "pr_description"; source: string; target: string } | { kind: "conflict_intent"; path: string; blocks: ConflictBlockRange[] };

/** "What is sent?" – exactly the text that would go out; nothing was sent. */
export interface AiPreview {
  text: string;
  omitted: AiOmitted[];
  /** Shortened to start and end of each hunk. */
  shortened: string[];
  chars: number;
  estimatedTokens: number;
  estimatedCostUsd: number | null;
  /** Empty: goes out without a question. */
  asks: AiAskTrigger[];
  /** Pass to `aiPreviewConfirm`; binds the confirmation to exactly this text. */
  fingerprint: string;
  monthCostUsd: number;
  limitUsd: number | null;
}

export interface AiUsageRow {
  provider: string;
  model: string;
  feature: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** This month's usage (UTC), numbers only – never contents. */
export interface AiUsageSummary {
  month: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  rows: AiUsageRow[];
}

/** `aiPrDescription`: a suggestion for title and description – nothing is written anywhere. */
export interface AiPrDescription {
  /** One line, at most 300 characters. */
  title: string;
  /** Markdown; ends with "Closes #n" for every host issue the commits mention. */
  body: string;
  /** Host issues the description closes – from the commits, never from the AI. */
  closes: number[];
}

/** `aiCommitMessage`: a draft for the commit form – never committed by the core. `summary` is one line of at most 72 characters. */
export interface AiCommitMessage {
  summary: string;
  body: string | null;
}

/** Sign-in of an AI command-line tool, as the tool reports it. */
export type AiLoginState = "logged_in" | "logged_out" | "unknown";

/** Where a program was found: own path, PATH, a usual install folder, the login shell's PATH. */
export type ToolSource = "configured" | "path" | "known_location" | "login_shell";

/** An AI command-line tool the setup found. */
export interface AiCliFound {
  provider: AiProviderKind;
  path: string;
  version: string | null;
  source: ToolSource;
  login: AiLoginState;
  /** "claude.ai", "ChatGPT" … – never an account name. */
  loginMethod: string | null;
  /** Claude Code would use ANTHROPIC_API_KEY from the environment instead of the sign-in. */
  usesEnvKey: boolean;
  /** All safety switches are there; otherwise `problem` names the missing ones. */
  supported: boolean;
  problem: string | null;
  /** The sign-in as text, e.g. "claude auth login" (only shown). */
  loginCommand: string;
}

/** Ollama or LM Studio answering on this computer. */
export interface AiLocalFound {
  provider: AiProviderKind;
  baseUrl: string;
  models: string[];
}

/** `aiDetect`: what the setup offers; nothing was sent. */
export interface AiDetection {
  clis: AiCliFound[];
  local: AiLocalFound[];
  /** Providers with a stored API key. */
  keys: AiProviderKind[];
  elapsedMs: number;
}

/** Global settings of the active profile. The core sets the defaults. */
/** Own paths of the AI command-line tools; null = found automatically (PATH, install folders, login shell). */
export interface AiCliPaths {
  claudeCode: string | null;
  codex: string | null;
  opencode: string | null;
}

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
  /** Ask GitHub once a day whether a newer stable release exists. Global. */
  checkForUpdates: boolean;
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
  // --- AI (v1.2, all global) ---
  /** Master switch: null = not set up yet ("unset"), false = turned off on purpose, true = on. */
  aiEnabled: boolean | null;
  aiProvider: AiProviderKind | null;
  /** Model ID as the provider names it. */
  aiModel: string | null;
  /** Address of the OpenAI-compatible service, or another address for Ollama / LM Studio. `http://` only to this computer. */
  aiBaseUrl: string | null;
  aiFeaturesOff: AiFeature[];
  /** gitignore patterns excluded in every repository (besides `.forkyard/ai-ignore`). */
  aiExclude: string[];
  /** Ask before a request whose estimated cost is above this (USD). Default 0.10. */
  aiConfirmCostUsd: number;
  /** Ask before every further request once this month's estimated costs reach this (USD). null = no limit. */
  aiMonthlyLimitUsd: number | null;
  aiPrices: AiPriceOverride[];
  /** Own paths of Claude Code, Codex and opencode; absolute or null. */
  aiCliPaths: AiCliPaths;
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
  /** After checkout, pull, merge, cherry-pick, revert, hard reset and a finished rebase, changed submodules are checked out at their recorded commit. Default true. */
  submodulesAutoUpdate: boolean;
  /**
   * Ticket links: host links on/off, tracker presets and own rules. `repoSettingsSet` checks them
   * (`not_allowed` with the reason) and stores them in canonical form. The effective rules come from `linkRulesGet`.
   */
  linkRules: LinkRulesConfig;
  /** "AI off for this repository": no AI element, nothing of it is sent. Stored in the app, not in .git/config. */
  aiOff: boolean;
  /** Own instruction for AI commit messages in this repository (at most 2000 characters); null = none. Stored in the app, not in .git/config. */
  aiCommitInstruction: string | null;
}

export type LinkPresetKind = "jira" | "linear" | "youtrack" | "redmine";

export interface LinkPreset {
  kind: LinkPresetKind;
  /** Address of the tracker, http(s), without trailing slash. */
  baseUrl: string;
  /** Jira, Linear, YouTrack: only these project keys (`ABC`); empty = every `ABC-123`. Always empty for Redmine. */
  keys: string[];
}

/** Own rule: matches of `pattern` link to `url` (`$0` = whole match, `$1` … = groups). */
export interface CustomLinkRule {
  id: string;
  pattern: string;
  url: string;
}

export interface LinkRulesConfig {
  /** `#123` (on GitLab also `!123`) link to the repository's host. */
  hostRules: boolean;
  presets: LinkPreset[];
  custom: CustomLinkRule[];
}

export type LinkRuleSource = "custom" | "preset" | "repo_file" | "host";

export interface LinkRule {
  /** `custom:<id>`, `preset:<kind>:<n>`, `file:<id or position>`, `host:issue`, `host:merge_request`. */
  id: string;
  source: LinkRuleSource;
  pattern: string;
  url: string;
}

export type LinkFileOrigin = "worktree" | "head";

export interface LinkRuleProblem {
  /** Position in the file's `rules` (from 0); null = the file as a whole. */
  index: number | null;
  message: string;
}

export interface LinkRules {
  /** In order of precedence. */
  rules: LinkRule[];
  /** null: the repository has no `.forkyard/links.json`. */
  file: LinkFileOrigin | null;
  problems: LinkRuleProblem[];
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

// --- Repository clean-up (`repoCleanupPreview`, `repoCleanupLfsEstimate`, `repoCleanupRun`) ---

/** Numbers from `git count-objects -v`, with Git's KiB values converted to bytes. */
export interface ObjectStats {
  looseCount: number;
  looseBytes: number;
  inPack: number;
  packs: number;
  packBytes: number;
  garbageCount: number;
  garbageBytes: number;
  /** Loose + packs + garbage: "Git objects in total". */
  totalBytes: number;
}

/** An undo entry of the repository (or one of its worktrees), or a backup ref group without an entry. */
export interface CleanupUndoBackup {
  entryId: Id;
  /** Entry: when it was recorded; orphaned: newest commit date of its refs; null = unknown (counts as older than any limit). */
  createdAt: IsoTime | null;
  orphaned: boolean;
}

export interface CleanupPreview {
  objects: ObjectStats;
  /** Bytes in the LFS object folder; null without Git LFS or when the repository does not use it. */
  lfsBytes: number | null;
  undoBackups: CleanupUndoBackup[];
  /** Worktrees whose folder is missing. */
  orphanedWorktrees: number;
  /** Other working directories that share this repository. */
  linkedWorktrees: number;
  /** Reflog entries older than 90 days; null = not counted within 2 s. */
  oldReflogEntries: number | null;
  /** Free space on the disk of the Git directory; null if unknown. */
  freeBytes: number | null;
}

/** What `git lfs prune` would free. */
export interface CleanupLfsEstimate {
  files: number;
  bytes: number;
}

export type CleanupMode = "normal" | "thorough";

export interface CleanupOptions {
  mode: CleanupMode;
  lfs: boolean;
  worktrees: boolean;
  /** Remove undo backups older than this many days (1–3650); null keeps them. */
  undoOlderThanDays: number | null;
  reflog: boolean;
}

/** The steps of a run, in the order they run. */
export type CleanupStep = "worktrees" | "undo" | "reflog" | "lfs" | "gc";
export type CleanupStepStatus = "done" | "skipped" | "failed" | "cancelled" | "not_run";

export interface CleanupStepResult {
  step: CleanupStep;
  status: CleanupStepStatus;
  /** How many were removed, where the step can say (worktrees, undo backups). */
  removed: number | null;
}

export interface CleanupFailure {
  step: CleanupStep;
  error: CoreErrorData;
  /** Another `git gc` runs: its process ID. */
  gcPid: number | null;
  diskFull: boolean;
}

/** Outcome of `repoCleanupRun`, also after a cancel or a failed step. */
export interface CleanupResult {
  before: ObjectStats;
  after: ObjectStats;
  /** LFS object folder before/after, only when the LFS step was chosen. */
  lfsBefore: number | null;
  lfsAfter: number | null;
  /** All five steps in their order. */
  steps: CleanupStepResult[];
  durationMs: number;
  cancelled: boolean;
  failure: CleanupFailure | null;
}

/** A lock on a file at the LFS server (`lfsLocks`). */
export interface LfsLock {
  /** The server's ID of the lock. */
  id: string;
  /** Relative to the repository root, with "/". */
  path: string;
  /** Owner as the server names it; empty if it names none. */
  owner: string;
  /** When the lock was set, as the server reports it; null if unknown. */
  lockedAt: IsoTime | null;
  /** Held by the signed-in user – the server decides that. */
  ours: boolean;
}

export interface LfsLockList {
  /** Sorted by path. */
  locks: LfsLock[];
  /** When the list was read from the server. */
  fetchedAt: IsoTime;
}

/** A path that could not be locked or unlocked, with Git LFS's reason (English). */
export interface LfsLockFailure {
  path: string;
  reason: string;
}

/** Result of `lfsLock` / `lfsUnlock`: the fresh list plus what failed. */
export interface LfsLockOutcome {
  locks: LfsLockList;
  failed: LfsLockFailure[];
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

/** `locks`: LFS file locks (`lfsLocks`) – after locking/unlocking and after a fetch. */
export type RepoChange = "worktree" | "index" | "refs" | "head" | "stash" | "config" | "operation" | "locks";
/** `credentials`: remembered credentials (`credentialsList`), `ssh_keys`: SSH keys (`sshKeyList`), `workspaces`: `workspaceList`, `custom_commands`: `customCommandsList`. */
export type AppChange = "tabs" | "repos" | "settings" | "profiles" | "credentials" | "ssh_keys" | "workspaces" | "host_accounts" | "custom_commands" | "ai";

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
  /** The follow-up job brought changed submodules along; `ok: false` is a warning (`message` says why), the main operation went through. */
  "submodules:updated": { repoId: Id; ok: boolean; paths: string[]; message: string | null };
}

// ---------------------------------------------------------------------------
// Hosts (GitHub, GitLab): accounts, pull requests, issues
// ---------------------------------------------------------------------------

/** Supported hosts, also as a self-hosted instance where the host has one (GitHub Enterprise Server, GitLab self-managed, Gitea/Forgejo). */
export type HostKind = "github" | "gitlab" | "gitea" | "bitbucket" | "azure_devops";

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
  /** User name for Basic authentication (Bitbucket: the account e-mail); null for the other hosts. */
  username: string | null;
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
/** What a host offers; the UI only shows what is there. */
export interface HostCapabilities {
  /** Issue tracker (Azure DevOps: work items); false if the repository has it switched off. */
  issues: boolean;
  issueCreate: boolean;
  draftPrs: boolean;
  /** An existing pull request can switch between draft and ready. */
  draftToggle: boolean;
  mergeMethods: PrMergeMethod[];
  deleteSourceBranch: boolean;
  prReopen: boolean;
  prReviewers: boolean;
  prLabels: boolean;
  /** Pull requests from forks can be checked out. */
  forkCheckout: boolean;
}

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
  capabilities: HostCapabilities;
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

// ---------------------------------------------------------------------------
// Custom commands
// ---------------------------------------------------------------------------

export type CustomCommandKind = "shell" | "url" | "git";
/** Working directory of a `shell` command: the open folder (`worktree`, default) or the main working tree (`repo`). */
export type CustomCommandCwd = "repo" | "worktree";
export type CustomInputType = "text" | "choice" | "checkbox" | "file";
/** Where a command appears: `repo` = command palette; the others = context menus of commits, branches, files, submodules. */
export type CustomCommandScope = "repo" | "commit" | "branch" | "file" | "submodule";

export interface CustomCommandInput {
  id: string;
  label: string;
  type: CustomInputType;
  /** Start value; for a checkbox "true" or "false". */
  default: string | null;
  /** `choice`: the choices; `checkbox`: at most one entry – the value when ticked (otherwise "true"). */
  options: string[];
}

/** One custom command, as stored or written in `.forkyard/commands.json` (format `{ "version": 1, "commands": [...] }`). */
export interface CustomCommandDef {
  id: string;
  title: string;
  kind: CustomCommandKind;
  /** One line with placeholders `${repo}`, `${sha}`, `${branch}`, `${file}`, `${remote}`, `${input:<id>}`; for `git` Git's arguments without "git". */
  run: string;
  cwd: CustomCommandCwd;
  /** Show the finished command before it runs. */
  confirm: boolean;
  /** Global `shell` commands only: through the system shell; values arrive as environment variables `FORKYARD_*`. */
  shell: boolean;
  inputs: CustomCommandInput[];
  scope: CustomCommandScope[];
}

export type CustomCommandSource = "global" | "repo";

export interface CustomCommandEntry {
  /** `global:<id>` or `repo:<id>` – what `customCommandRun` takes. */
  key: string;
  source: CustomCommandSource;
  command: CustomCommandDef;
  /** false: a repository command whose file is not approved in this version. */
  runnable: boolean;
}

export type RepoCommandsState = "missing" | "untrusted" | "changed" | "trusted";
export type CustomCommandChangeKind = "added" | "removed" | "changed";

export interface CustomCommandChange {
  id: string;
  title: string;
  change: CustomCommandChangeKind;
  /** `run` before and after; null for added or removed commands. */
  before: string | null;
  after: string | null;
}

export interface RepoCommands {
  state: RepoCommandsState;
  /** SHA-256 of the file as it is now – what `customCommandsTrust` expects; null without a usable file. */
  hash: string | null;
  /** ".forkyard/commands.json" */
  path: string;
  /** One sentence per rejected command or file problem. */
  problems: string[];
  /** Only for `changed`. */
  changes: CustomCommandChange[];
}

export interface CustomCommandList {
  /** Global commands first, then those of the repository. */
  commands: CustomCommandEntry[];
  /** null when listed without a repository. */
  repo: RepoCommands | null;
}

/** Where a command was started; missing values fall back to HEAD, the current branch and the upstream remote. */
export interface CustomCommandContext {
  sha?: Sha | null;
  branch?: string | null;
  /** Relative path (in the submodule menu: the submodule's path). */
  file?: string | null;
  remote?: string | null;
}

export type CustomCommandResult =
  /** `confirm: true` and not confirmed yet: nothing has run. */
  | { status: "confirm"; display: string; cwd: string }
  /** `output`: stdout and stderr, redacted, at most 64 KiB. */
  | { status: "finished"; exitCode: number | null; output: string }
  /** The UI opens the address in the system browser. */
  | { status: "open_url"; url: string };

/** Whether the app can link the `forkyard` command into a folder on the PATH (AppImage, macOS app). */
export interface CliStatus {
  installable: boolean;
  installed: boolean;
  /** `~/.local/bin/forkyard` or `/usr/local/bin/forkyard`; null if not installable. */
  linkPath: string | null;
  /** The link's folder is on the PATH of the running app. */
  onPath: boolean;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * What `statsCompute` counts. `from`/`to`: ISO-8601, compared with the author time (both
 * inclusive); null = open. `ref`: "HEAD" or a full ref name (`refs/heads/main`).
 */
export interface StatsRange {
  from: IsoTime | null;
  to: IsoTime | null;
  ref: string;
}

/** Commits of a week (`period` = its Monday, "YYYY-MM-DD") or a month ("YYYY-MM"), by the author's local date. */
export interface StatsBucket {
  period: string;
  commits: number;
  added: number;
  removed: number;
}

export interface StatsAuthor {
  name: string;
  email: string;
  commits: number;
  added: number;
  removed: number;
  firstAt: IsoTime;
  lastAt: IsoTime;
}

/** A file that still exists at the tip and was changed in the period. `authors`: number of different authors. */
export interface StatsFile {
  path: string;
  commits: number;
  authors: number;
  added: number;
  removed: number;
}

/** `score` = commits × authors. */
export interface StatsHotspot {
  path: string;
  commits: number;
  authors: number;
  score: number;
}

/**
 * Knowledge per folder (`path` "" = the whole repository). `weight`: changed lines, at least 1
 * per file change. `mainShare`: percent. `busFactor`: fewest authors holding more than half.
 */
export interface StatsFolder {
  path: string;
  weight: number;
  authors: number;
  mainAuthor: Person;
  mainShare: number;
  busFactor: number;
  /** The authors with the most changed lines, most first (at most 6); the rest of `weight` belongs to the others. */
  top: StatsFolderShare[];
}

/** An author's changed lines in a folder. */
export interface StatsFolderShare {
  author: Person;
  weight: number;
}

/**
 * Lines of the blamed sample by the age of their last change (relative to `RepoStats.referenceTime`):
 * under 30 days, under 180 days, under 365 days, under two years, older.
 */
export interface StatsCodeAge {
  /** Files that were blamed. */
  files: number;
  /** Files of the sample Git could not blame. */
  skipped: number;
  month: number;
  halfYear: number;
  year: number;
  twoYears: number;
  older: number;
}

export interface StatsStreak {
  days: number;
  start: string;
  end: string;
}

export interface StatsBigCommit {
  sha: Sha;
  added: number;
  removed: number;
  at: IsoTime;
}

export interface StatsBusyDay {
  date: string;
  commits: number;
}

export interface StatsRecords {
  longestStreak: StatsStreak | null;
  biggestCommit: StatsBigCommit | null;
  busiestDay: StatsBusyDay | null;
}

/** Result of `statsCompute`: derived numbers only – no commit list, no messages. */
export interface RepoStats {
  /** The commit whose history was counted; null = nothing to count. */
  tip: Sha | null;
  /** Reference point of the code age: `to`, otherwise now (also for a cached result). */
  referenceTime: IsoTime | null;
  commits: number;
  added: number;
  removed: number;
  firstAt: IsoTime | null;
  lastAt: IsoTime | null;
  /** 7 × 24: weekday (Monday first) × hour, in the author's local time. */
  heatmap: number[][];
  weeks: StatsBucket[];
  months: StatsBucket[];
  /** All authors of the period; `authors` holds at most 200. */
  authorCount: number;
  authors: StatsAuthor[];
  /** All changed files that still exist; `files` holds at most 2000 (most changed first). */
  fileCount: number;
  files: StatsFile[];
  hotspots: StatsHotspot[];
  folders: StatsFolder[];
  codeAge: StatsCodeAge;
  records: StatsRecords;
  /** Came from the cache. */
  cached: boolean;
}
