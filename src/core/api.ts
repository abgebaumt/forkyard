/**
 * All commands the UI can call in the core.
 *
 * Rules of the contract:
 * - Method `repoOpen` is called `repo_open` as a Tauri command (camelCase → snake_case).
 * - Every method takes at most one object. Its keys are the parameters of the
 *   Tauri command (`repoId` arrives in Rust as `repo_id`).
 * - Errors always arrive as `CoreError` (see types.ts).
 * - Long network actions get a `jobId` from the caller. `job:progress` and `job:done`
 *   run under this ID, and `jobCancel` cancels them. The promise resolves with the
 *   result when the job is done.
 * - Write actions additionally report their consequences as `repo:changed`.
 *
 * The UI never calls Git directly and never builds command lines.
 */
import type {
  AiAskTrigger,
  AiCommitMessage,
  AiDetection,
  AiFeature,
  AiInput,
  AiModelList,
  AiPreview,
  AiPrDescription,
  AiProviderKind,
  AiStatus,
  AiUsageSummary,
  CliStatus,
  CrashReportSummary,
  ActivityPage,
  ActivityScope,
  AppInfo,
  BisectStatus,
  BisectVerdict,
  BlameLine,
  CloneOptions,
  CommitDetails,
  CommitDraft,
  CommitResult,
  CommitSummary,
  ComposePlan,
  ComposeProposal,
  ComposeResult,
  ComposeState,
  CommitSearchFilters,
  ConflictFile,
  ConflictPreview,
  CoreEvents,
  CustomCommandContext,
  CustomCommandDef,
  CustomCommandList,
  CustomCommandResult,
  DiffSource,
  ExternalTarget,
  FetchResult,
  FileContent,
  FileDiff,
  FileHistoryEntry,
  LineHistoryStep,
  GitflowFinishOptions,
  GitflowKind,
  GitflowPrefixes,
  GitflowStatus,
  GraphPage,
  HostAccount,
  HostComment,
  HostKind,
  HostRepoInfo,
  HosterAccount,
  Id,
  InitOptions,
  InitTemplates,
  IssueDetails,
  IssuePage,
  IssueSummary,
  IssueState,
  LaunchRequest,
  LfsStatus,
  LfsLockList,
  LfsLockOutcome,
  CleanupLfsEstimate,
  CleanupOptions,
  CleanupPreview,
  CleanupResult,
  MergeMode,
  OpResult,
  OpenedRepo,
  RepoTrust,
  PatchSelection,
  RangeApplyTarget,
  PatchText,
  PlanPreview,
  PlanRunResult,
  PlanStep,
  PrDetails,
  PreviewOp,
  PrListState,
  PrMergeMethod,
  PrPage,
  PrSummary,
  Profile,
  ProfileRef,
  PullMode,
  PushExtra,
  PushResult,
  RebasePlan,
  RebasePlanRow,
  ReflogPage,
  Ref,
  RefsSnapshot,
  Remote,
  Repo,
  LinkRules,
  RepoSettings,
  RepoStats,
  RepoViewState,
  ResetMode,
  SettingScope,
  Settings,
  Sha,
  SigningFormat,
  SigningStatus,
  SshKey,
  Stash,
  StatsRange,
  StashSelection,
  Status,
  Submodule,
  Tab,
  UndoState,
  UpdateInfo,
  Workspace,
  WorkspaceRunResult,
  Worktree,
} from "./types";

type R = { repoId: Id };

export interface CoreCommands {
  // --- App -----------------------------------------------------------------
  appInfo(): Promise<AppInfo>;
  /** Looks for Git again ("Check again") and returns the new state; a Git installed later counts without a restart. */
  appRecheckGit(): Promise<AppInfo>;
  /**
   * Asks GitHub for the newest stable release (`/repos/abgebaumt/forkyard/releases/latest`, only
   * the app version in the user agent). `manual: false`: only while `checkForUpdates` is on and at
   * most once a day (also across restarts) – otherwise the remembered result. `manual: true` always
   * asks. Errors: `host_rate_limited` (403/429), `offline`/`timeout`, `not_allowed` (release page not
   * under github.com/abgebaumt/forkyard), `unknown`. No release yet (404) is "up to date".
   */
  updateCheck(input: { manual: boolean }): Promise<UpdateInfo>;
  /** The notice for `version` was seen (`skip: false`, no second toast) or the version is skipped (`skip: true`, no notice at all). */
  updateDismiss(input: { version: string; skip: boolean }): Promise<UpdateInfo>;
  /**
   * The request the app was started with (start argument or `forkyard://` link) –
   * exactly once, null afterwards. Call it at startup (after subscribing to `app:open_request`):
   * only then does the core send further requests as events.
   */
  appLaunchRequest(): Promise<LaunchRequest | null>;
  /**
   * Reports whether closing the window would lose something (unsaved text, running
   * action). Only then does the window hold and send `app:close_requested`. Every call also
   * counts as a sign of life in response to such a request.
   */
  appCloseGuard(input: { active: boolean }): Promise<void>;
  /** Quits the app: cancels running actions (cleans up a half-finished clone) and closes the window. */
  appQuit(): Promise<void>;

  // --- Repositories and tabs ----------------------------------------------------
  /** Checks the folder, registers it and opens a tab (or activates the existing one). */
  /**
   * If only another profile lists the repository, `repo_other_profile` comes back (the profiles
   * are named by `repoProfiles`); with `addToProfile: true` it is also listed in the active profile and opened.
   */
  repoOpen(input: { path: string; addToProfile?: boolean }): Promise<OpenedRepo>;
  /**
   * State of trust and what the check finds in the repository: entries of its configuration
   * and hooks that Git would run without a prompt. Only reads; runs none of it.
   */
  repoTrustGet(input: R): Promise<RepoTrust>;
  /**
   * The user agrees (`trusted: true`) or withdraws the agreement. Only with the agreement
   * does the core work in a repository that brings its own commands.
   */
  repoTrustSet(input: R & { trusted: boolean }): Promise<RepoTrust>;
  repoList(): Promise<Repo[]>;
  /** The profiles other than the active one that list the repository at `path`. Unknown folder: empty list. */
  repoProfiles(input: { path: string }): Promise<ProfileRef[]>;
  repoUpdate(input: R & { alias?: string | null; isFavorite?: boolean; groupName?: string | null; color?: number | null }): Promise<Repo>;
  /** Removes the entry from the list and closes its tabs. Deletes nothing on disk. */
  repoForget(input: R): Promise<void>;
  /** Clones into `parentPath/name`. Progress via `job:progress`. */
  repoClone(input: { jobId: string; url: string; parentPath: string; name: string; options: CloneOptions }): Promise<OpenedRepo>;
  repoInit(input: { options: InitOptions }): Promise<OpenedRepo>;
  initTemplates(): Promise<InitTemplates>;
  /** README.md in the root directory for the preview in the repository manager; null if there is none. */
  repoReadme(input: R): Promise<string | null>;

  // --- Workspaces (local groups of repositories) ----------------------------------------
  /** Sorted by name. */
  workspaceList(): Promise<Workspace[]>;
  /**
   * Without `id` a workspace is created, otherwise name and repositories are replaced (`repoIds`
   * in the desired order). Errors: `invalid_name` (empty, over 80 characters), `name_exists`,
   * `not_found` (workspace or a repository unknown). Reports `app:changed` with `workspaces`.
   */
  workspaceSave(input: { id?: Id | null; name: string; repoIds: Id[] }): Promise<Workspace[]>;
  /** The repositories stay in the list and on disk. */
  workspaceDelete(input: { id: Id }): Promise<Workspace[]>;
  /**
   * Fetch of all remotes in every repository of the workspace, one after another, as ONE job
   * (`jobCancel` cancels the run → `cancelled`). An error in one repository does not cancel the
   * others; the result says per repository what happened. Progress per repository:
   * see `job:progress` in types.ts. Each repository reports its changes as `repo:changed`, like
   * a single fetch.
   */
  workspaceFetch(input: { jobId: string; workspaceId: Id }): Promise<WorkspaceRunResult>;
  /** Like `workspaceFetch`, with pull. `mode: null` takes each repository's default. */
  workspacePull(input: { jobId: string; workspaceId: Id; mode: PullMode | null }): Promise<WorkspaceRunResult>;

  tabsList(): Promise<Tab[]>;
  /** Opens a repository manager tab (repoId null) or a repo tab. */
  tabOpen(input: { repoId: Id | null }): Promise<Tab[]>;
  tabClose(input: { tabId: Id }): Promise<Tab[]>;
  tabMove(input: { tabId: Id; position: number }): Promise<Tab[]>;
  tabActivate(input: { tabId: Id }): Promise<Tab[]>;

  // --- Graph, refs, search ---------------------------------------------------
  /** First page with `cursor: null`. Contains the WIP row at the top if there are changes, and stash rows. */
  graphPage(input: R & { cursor: string | null; limit: number }): Promise<GraphPage>;
  refsList(input: R): Promise<RefsSnapshot>;
  commitDetails(input: R & { source: DiffSource }): Promise<CommitDetails>;
  /**
   * Searches message, SHA and author across the whole history. A new search cancels the one
   * still running with the same `searchId` in the same repository (that one ends with `cancelled`);
   * searches with different IDs (e.g. "palette", "searchbar") run side by side.
   * Without `searchId` all callers share a common one.
   */
  /** `filters` narrow the search (code, time window, paths); with filters a SHA prefix is not searched as such. */
  commitSearch(input: R & { query: string; limit: number; searchId?: string | null; filters?: CommitSearchFilters | null }): Promise<CommitSummary[]>;
  /** All files of a commit (`sha: null` = working directory), optionally filtered. */
  treeList(input: R & { sha: Sha | null; filter: string | null }): Promise<string[]>;
  viewStateGet(input: R): Promise<RepoViewState>;
  viewStateSet(input: R & { patch: Partial<RepoViewState> }): Promise<RepoViewState>;
  /**
   * Reflog of HEAD (`refName` null) or a branch (`refs/heads/…`, `refs/remotes/…`), newest first.
   * First page with `cursor: null`; entries added between two pages do not shift the next one.
   * Entries whose commit Git has removed come with `exists: false`. Errors: `not_allowed` (other
   * ref), `not_found` (branch gone), `stale_state` (the cursor no longer fits: reload).
   */
  reflogList(input: R & { refName?: string | null; cursor?: string | null; limit: number }): Promise<ReflogPage>;

  // --- Working directory, staging, committing -------------------------------------
  statusGet(input: R): Promise<Status>;
  /**
   * `encoding` sets the encoding of both sides for this one call (name as in
   * `FileContent.encoding`); if omitted or null it is guessed per side. Unknown: `not_allowed`.
   */
  diffFile(input: R & { path: string; source: DiffSource; force?: boolean; ignoreWhitespace?: boolean; encoding?: string | null }): Promise<FileDiff>;
  /** `paths: null` means all. */
  stagePaths(input: R & { paths: string[] | null }): Promise<Status>;
  unstagePaths(input: R & { paths: string[] | null }): Promise<Status>;
  /** Selection from the `unstaged` diff into the index. */
  stagePatch(input: R & { selection: PatchSelection }): Promise<Status>;
  /** Take the selection from the `staged` diff back out of the index. */
  unstagePatch(input: R & { selection: PatchSelection }): Promise<Status>;
  /** Discard the selection from the `unstaged` diff in the working directory. Reversible via undo. */
  discardPatch(input: R & { selection: PatchSelection }): Promise<Status>;
  /**
   * Takes selected hunks or lines of the diff `from..to` (refs or SHAs; `from` may be the empty tree)
   * into the working directory, the index or both. `selections[].expect` is `TextDiff.rangeToken` of
   * that file's range diff. A conflict with own changes → `conflict` naming the files, nothing changes;
   * a selected file that changed in the range → `stale_state`. One undo entry (`range_apply`).
   */
  rangeApply(input: R & { from: string; to: string; selections: PatchSelection[]; target: RangeApplyTarget }): Promise<Status>;
  /** `paths: null` means everything, including untracked files. Creates a backup for undo first. */
  discardPaths(input: R & { paths: string[] | null }): Promise<Status>;
  commitCreate(
    input: R & {
      opId: string;
      summary: string;
      description: string;
      amend: boolean;
      skipHooks: boolean;
      pushAfter: boolean;
      /** Stage everything before the commit (Ctrl+Shift+Enter). */
      stageAll: boolean;
      /**
       * Only with `amend`: the commit the UI last showed. If HEAD has become a different one in
       * the meantime, the core refuses with `stale_state` instead of changing someone else's commit.
       */
      expectedHead: Sha | null;
    },
  ): Promise<CommitResult>;
  /**
   * Change the message of the last commit without touching the index. `sha`: the commit whose
   * message was edited – if HEAD has become a different one in the meantime, `stale_state` comes back.
   */
  commitReword(input: R & { summary: string; description: string; sha: Sha | null }): Promise<CommitResult>;
  /** "Compose commits" (v1.2): every change since HEAD as units (hunks, whole files). Reads only, no AI. */
  composeUnits(input: R): Promise<ComposeState>;
  /**
   * The AI provider's grouping of the units, as job `jobId` (`jobCancel` → `cancelled`). Show and
   * confirm `aiPreview({ input: { kind: "compose" } })` first – the core refuses an unconfirmed text.
   */
  composeProposal(input: R & { jobId: string; locale: string }): Promise<ComposeProposal>;
  /**
   * Creates the planned commits under ONE undo entry, hooks and signing per commit, the working
   * directory untouched. `expectToken` from the units shown (otherwise `stale_state`). Job `jobId`:
   * `job:progress` phase "compose", line "<n>/<total>"; cancellable between commits. Any failure takes
   * every commit of the run back.
   */
  composeApply(input: R & { jobId: string; plan: ComposePlan; expectToken: string }): Promise<ComposeResult>;
  draftGet(input: R): Promise<CommitDraft>;
  draftSet(input: R & { draft: CommitDraft }): Promise<void>;
  /** Pattern into the .gitignore in the root directory; optionally `git rm --cached`. */
  ignoreAdd(input: R & { pattern: string; stopTracking: boolean }): Promise<Status>;
  /**
   * Restore a file from a commit; it ends up staged. Whatever gets overwritten is
   * backed up: undo entry `discard` (label "Undo restore of …").
   */
  fileRestore(input: R & { sha: Sha; paths: string[] }): Promise<Status>;
  /**
   * Deletes a file in the working directory (tracked or untracked; the index stays as it
   * is). Backed up first: undo entry `discard` ("Undo deletion of '…'").
   * Creating goes through `fileWrite`. Errors: `not_found` (file missing), `not_allowed` (folder,
   * outside, `.git`, ignored by Git), `conflict` (conflicted file), `locked`.
   * Reports `repo:changed` with `worktree`.
   */
  fileDelete(input: R & { path: string }): Promise<Status>;

  // --- Branches, merge, rebase ------------------------------------------------------
  /** `start: null` = HEAD. */
  branchCreate(input: R & { name: string; start: string | null; checkout: boolean }): Promise<RefsSnapshot>;
  /**
   * `target` is a local branch, a remote branch (`origin/x` creates the local
   * tracking branch) or a SHA (detached).
   */
  branchCheckout(input: R & { target: string }): Promise<Status>;
  branchRename(input: R & { name: string; newName: string }): Promise<RefsSnapshot>;
  /** Without `force`, deleting unmerged branches fails with `not_merged`. */
  branchDelete(input: R & { names: string[]; force: boolean }): Promise<RefsSnapshot>;
  /**
   * Deletes the branch `name` on the remote (`git push <remote> --delete <name>`); `name` without
   * the remote prefix (`origin/x` works too). `done`: deleted; `up_to_date`: did not exist there
   * (any more), the stale remote branch here has been cleaned up. Job like `push`.
   */
  branchDeleteRemote(input: R & { jobId: string; remote: string; name: string }): Promise<PushResult>;
  /** `upstream: null` removes the link. */
  branchSetUpstream(input: R & { name: string; upstream: string | null }): Promise<RefsSnapshot>;
  /**
   * Fast-forwards a local branch that is NOT checked out to its upstream – only the ref
   * moves, working directory and index stay. Nothing is fetched (state of the last
   * fetch). `done` (with `fastForward: true` and a finished `summary`) or `up_to_date` (already
   * there or only ahead). Errors: `not_allowed` (own commits – no fast-forward
   * possible; or checked out: here → pull with `ff_only`, in another worktree → pull
   * there), `no_upstream` (none set or no longer present), `not_found`,
   * `stale_state`. Undo step `merge`; reports `repo:changed` with `refs`.
   */
  branchFastForward(input: R & { branch: string }): Promise<OpResult>;

  // --- Gitflow (no add-on program; configuration in the usual `gitflow.*` keys) ----
  /** Always works. Without setup (`initialized: false`), `main`, `develop`, `prefixes` are suggestions. */
  gitflowStatus(input: R): Promise<GitflowStatus>;
  /**
   * Writes the setup into the repository's configuration. `main` must exist as a local
   * branch; `develop` is created if missing (from `origin/<develop>`, otherwise
   * from `main`). HEAD stays. `prefixes` if omitted: `feature/`, `release/`, `hotfix/`, no
   * tag prefix. Errors: `invalid_name`, `not_found` (main missing), `not_allowed` (no commit,
   * main = develop). Reports `repo:changed` with config, refs.
   */
  gitflowInit(input: R & { main: string; develop: string; prefixes?: GitflowPrefixes | null }): Promise<GitflowStatus>;
  /**
   * Creates `<prefix><name>` and checks it out. `base` if omitted: feature and release from the
   * development branch, hotfix from the main branch. At most one release and one hotfix at a time
   * (`not_allowed`). Other errors as for `branchCreate` with checkout. Undo step `checkout`.
   */
  gitflowStart(input: R & { kind: GitflowKind; name: string; base?: string | null }): Promise<GitflowStatus>;
  /**
   * Feature: merge (with merge commit) into the development branch. Release/hotfix: merge into the
   * main branch, annotated tag, merge back into the development branch. Afterwards HEAD is
   * on the development branch and the branch is deleted (`options.deleteBranch`).
   * - `done` with a finished `summary`; `up_to_date` if there was nothing left to do.
   * - `conflict` as with `mergeStart` (with `note`): resolve, finish via `operationContinue`
   *   and call `gitflowFinish` again – steps already done are skipped.
   * - Errors: `not_found`, `dirty_worktree` (working directory must be clean),
   *   `operation_in_progress`, `identity_missing`, `name_exists` (tag), `not_allowed`.
   * One undo step (`merge`) reverts the whole finish. With `options.push` the push runs
   * as a job under `jobId` (progress, cancellable); if only the push fails, everything is
   * finished locally and the error says so.
   */
  gitflowFinish(input: R & { kind: GitflowKind; name: string; options?: GitflowFinishOptions | null; jobId?: string | null }): Promise<OpResult>;

  /** Proposal: valid? Reason if not. For inline input. */
  refNameCheck(input: R & { name: string; kind: "branch" | "tag" }): Promise<{ valid: boolean; reason: string | null }>;

  mergeStart(input: R & { source: string; mode: MergeMode }): Promise<OpResult>;
  conflictGet(input: R & { path: string }): Promise<ConflictFile>;
  /** Either `content` (result from the conflict tool) or take `side` entirely. Afterwards the file is staged. */
  conflictResolve(input: R & { path: string; content: string | null; side: "ours" | "theirs" | null }): Promise<Status>;
  /** `message` only when finishing a merge. */
  /** `skipHooks`: the merge commit is created without hooks (as with a normal commit); otherwise no effect. */
  operationContinue(input: R & { message: string | null; skipHooks: boolean | null }): Promise<OpResult>;
  operationAbort(input: R): Promise<Status>;
  /** Rebases the checked-out branch (or `branch`) onto `onto`. `updateRefs`: dependent branches move along (`--update-refs`); one undo step resets all. */
  rebaseStart(input: R & { onto: string; branch: string | null; updateRefs?: boolean | null }): Promise<OpResult>;
  /** Commits between `base` and HEAD as a plan, with a check of the preconditions. */
  rebasePlan(input: R & { base: string }): Promise<RebasePlan>;
  /** The local branches `rebaseStart` with `updateRefs` would move along (`branch: null` = the checked-out one). */
  rebaseDependents(input: R & { onto: string; branch: string | null }): Promise<string[]>;
  rebaseApply(input: R & { base: Sha; rows: RebasePlanRow[]; updateRefs?: boolean | null }): Promise<OpResult>;
  cherryPick(input: R & { shas: Sha[] }): Promise<OpResult>;
  /** Combine consecutive commits of the checked-out branch into one. */
  squashCommits(input: R & { shas: Sha[]; message: string }): Promise<OpResult>;
  revertCommit(input: R & { sha: Sha }): Promise<OpResult>;
  /**
   * Would the operation stop on conflicts? Simulated without touching working directory, index or
   * refs (`git merge-tree`; a series is replayed commit by commit, at most 200; a patch via
   * `git apply --check`). Background read as a job: `jobCancel(jobId)` stops it (`cancelled`).
   * Git problems come back as `unknown` with a reason, not as an error.
   */
  conflictPreview(input: R & { jobId: string; op: PreviewOp }): Promise<ConflictPreview>;
  /** Resets the checked-out branch to `sha`. */
  resetBranch(input: R & { sha: Sha; mode: ResetMode }): Promise<Status>;
  /** Bisect state, read from the Git directory – also one started on the command line. */
  bisectStatus(input: R): Promise<BisectStatus>;
  /**
   * Starts a bisect between `bad` and the `good` commits and checks out the first commit to test.
   * Errors: `bisect_active`, `not_allowed` (working directory not clean, no good commit, the same
   * commit twice, Git refuses the pair), `operation_in_progress`, `not_found`. Reports `repo:changed`.
   */
  bisectStart(input: R & { bad: Sha; good: Sha[] }): Promise<BisectStatus>;
  /** Marks `sha` (null = the commit under test) and checks out the next one. Without a bisect: `no_operation`. */
  bisectMark(input: R & { verdict: BisectVerdict; sha?: Sha | null }): Promise<BisectStatus>;
  /** Ends the bisect and returns to where it started. Without a bisect: `no_operation`. */
  bisectReset(input: R): Promise<BisectStatus>;

  // --- Remotes and syncing -----------------------------------------------------
  remoteList(input: R): Promise<Remote[]>;
  remoteAdd(input: R & { name: string; fetchUrl: string; pushUrl: string | null }): Promise<Remote[]>;
  remoteEdit(input: R & { name: string; newName: string; fetchUrl: string; pushUrl: string | null }): Promise<Remote[]>;
  remoteRemove(input: R & { name: string }): Promise<Remote[]>;
  /** `remote: null` = all. */
  fetch(input: R & { jobId: string; remote: string | null; prune: boolean }): Promise<FetchResult>;
  /** `mode: null` takes the default from the settings. */
  pull(input: R & { jobId: string; mode: PullMode | null }): Promise<OpResult>;
  /**
   * `branch: null` = the checked-out one. Without an upstream `remote` must be set, otherwise `no_upstream`.
   * `force` always uses `--force-with-lease`.
   */
  /** `expected` (only with `force`): the state of the remote branch the prompt showed – only that one is overwritten. */
  /**
   * `extra`: further branches and tags in the same push (force per branch only with lease, tags never
   * forced); `atomic` (default true) = all or nothing (`--atomic`). With `extra` the result is
   * `multi` with one entry per ref; errors before sending: `invalid_name`, `not_found`, `not_allowed`.
   */
  push(input: R & { jobId: string; branch: string | null; remote: string | null; remoteBranch: string | null; force: boolean; expected: string | null; extra?: PushExtra[] | null; atomic?: boolean | null }): Promise<PushResult>;
  jobCancel(input: { jobId: string }): Promise<void>;

  // --- Stash, tags, undo, history ------------------------------------------------
  stashList(input: R): Promise<Stash[]>;
  /**
   * `paths: null` = everything.
   * `undoable: false`: without an undo entry – for "stash and undo", so that the following
   * undo hits the intended action and not the stash just created.
   * `selection`: only these hunks and lines go into the stash (index and working directory keep the
   * rest); `paths` must then be null, `includeUntracked` does not apply. Errors: `stale_state` (HEAD
   * or a diff changed), `not_allowed` (selected unstaged lines build on unselected staged ones),
   * `nothing_to_commit`. Undo step `stash`.
   */
  stashCreate(input: R & { opId: string; message: string | null; paths: string[] | null; includeUntracked: boolean; undoable?: boolean | null; selection?: StashSelection | null }): Promise<Stash[]>;
  stashApply(input: R & { index: number }): Promise<OpResult>;
  stashPop(input: R & { index: number }): Promise<OpResult>;
  /**
   * Apply only these files of a stash to the working directory (index and stash stay).
   * All or nothing. Errors: `not_found` (stash, or file not in it), `conflict` (the
   * file has since changed so that the change no longer fits – the whole stash merges
   * it), `dirty_worktree` (an untracked file already exists). Undo step `discard`.
   */
  stashApplyPaths(input: R & { index: number; paths: string[] }): Promise<Status>;
  stashDrop(input: R & { index: number }): Promise<Stash[]>;
  stashRename(input: R & { index: number; message: string }): Promise<Stash[]>;

  /** Annotated with `message`, otherwise lightweight. `sha: null` = HEAD. */
  tagCreate(input: R & { name: string; sha: Sha | null; message: string | null }): Promise<RefsSnapshot>;
  /** `remote` set: delete it there too. */
  tagDelete(input: R & { name: string; remote: string | null }): Promise<RefsSnapshot>;
  tagPush(input: R & { jobId: string; name: string; remote: string }): Promise<PushResult>;

  undo(input: R): Promise<UndoState>;
  redo(input: R): Promise<UndoState>;
  undoPeek(input: R): Promise<UndoState>;

  /**
   * Follows renames. `offset` skips that many entries at the start – for loading more:
   * `{ limit: 200, offset: <number already loaded> }`; fewer than `limit` entries means the end.
   */
  fileHistory(input: R & { path: string; limit: number; offset?: number | null }): Promise<FileHistoryEntry[]>;
  /**
   * The commits that shaped line `line` (1-based) of `path` at commit `sha`, newest first, at most 20
   * (`git log -L`); follows renames. Each step names the file's path and the line range in that commit.
   */
  lineHistory(input: R & { path: string; line: number; sha: Sha }): Promise<LineHistoryStep[]>;
  /** `sha: null` = working directory. `encoding`: encoding for this one call, otherwise detected. */
  fileBlame(input: R & { path: string; sha: Sha | null; encoding?: string | null }): Promise<BlameLine[]>;
  /**
   * `sha: null` = working directory. `encoding` ("Reopen as"): read with exactly this encoding
   * instead of detecting – `utf-8`, `utf-8-bom`, `utf-16le`, `utf-16be`, `windows-1252`,
   * `iso-8859-15` … (any name the Encoding Standard knows); unknown: `not_allowed`.
   * If omitted or null: detect, using the repository's default (`RepoSettings.encoding`).
   */
  fileRead(input: R & { path: string; sha: Sha | null; encoding?: string | null }): Promise<FileContent>;
  fileWrite(input: R & { path: string; content: string; encoding: string; eol: "lf" | "crlf" }): Promise<void>;

  // --- Profiles, settings, credentials ----------------------------------------
  profileList(): Promise<Profile[]>;
  /** Without `id` a new profile is created. */
  /** `color`: lane colour 1 to 8 or null (by position); otherwise `not_allowed`. */
  profileSave(input: { id: Id | null; name: string; authorName: string; authorEmail: string; syncGitconfig: boolean; color: number | null }): Promise<Profile[]>;
  profileDelete(input: { id: Id }): Promise<Profile[]>;
  profileActivate(input: { id: Id }): Promise<Profile[]>;

  settingsGet(): Promise<Settings>;
  settingsSet(input: { patch: Partial<Settings> }): Promise<Settings>;
  /** Level of each `Settings` field (the same for all profiles or per profile); only changes with a new version. */
  settingsScopes(): Promise<Record<keyof Settings, SettingScope>>;
  /** Avatar for the email address from GitHub as a data URL; null if none is known. */
  avatarGet(input: { email: string }): Promise<string | null>;
  repoSettingsGet(input: R): Promise<RepoSettings>;
  /** `linkRules` is checked (`not_allowed` with the reason) and stored in its canonical form. */
  repoSettingsSet(input: R & { patch: Partial<RepoSettings> }): Promise<RepoSettings>;
  /**
   * Effective ticket link rules in order of precedence (where two match at the same place, the
   * earlier wins): own rules, presets, `.forkyard/links.json` (working directory, otherwise HEAD),
   * host (`#123`, on GitLab also `!123`; off with `linkRules.hostRules`). Invalid entries of the
   * repository file are skipped and listed in `problems`. The core checks the patterns; the UI matches them.
   */
  linkRulesGet(input: R): Promise<LinkRules>;

  sshKeyList(): Promise<SshKey[]>;
  /** Generates an ed25519 pair in the user's SSH folder. */
  sshKeyGenerate(input: { label: string; fileName: string; passphrase: string | null }): Promise<SshKey[]>;
  sshKeyImport(input: { label: string; privateKeyPath: string; publicKeyPath: string | null }): Promise<SshKey[]>;
  /** Removes the entry; the files stay where they are. */
  sshKeyRemove(input: { id: Id }): Promise<SshKey[]>;
  sshKeySetDefault(input: { id: Id | null }): Promise<SshKey[]>;

  /** `value: null` cancels the prompt. */
  credentialAnswer(input: { requestId: string; value: string | null; remember: boolean }): Promise<void>;
  credentialsList(): Promise<HostAccount[]>;
  /** Returns the number of deleted entries. */
  credentialsForgetAll(): Promise<number>;

  activityList(input: { scope: ActivityScope; repoId: Id | null; cursor: string | null; limit: number }): Promise<ActivityPage>;

  // --- Crash reports (written by the core's panic hook or after an unexpected exit; never uploaded) ---
  /** Pending reports, newest first. */
  crashReportsList(): Promise<CrashReportSummary[]>;
  /** Full text of a report (already redacted), with the last Git calls up to the crash appended. */
  crashReportGet(input: { id: Id }): Promise<string>;
  /** Writes the full text to `path` (absolute, from the save dialog). */
  crashReportSave(input: { id: Id; path: string }): Promise<void>;
  /** Deletes a report; no error if it is already gone. */
  crashReportDiscard(input: { id: Id }): Promise<void>;
  /**
   * `path` relative to the repository; null = the repository itself (only editor, terminal, file_manager).
   * - `diff_tool`: `path` is required; `source` picks the comparison (if omitted: unstaged).
   *   With `settings.externalDiffTool` the command gets both versions as files
   *   (`{local}` old, `{remote}` new – for the working directory the real file; without placeholders
   *   both are appended), otherwise `git difftool --no-prompt` starts with the user's `diff.tool`.
   * - `merge_tool`: `path` must be a conflicted file. With `settings.externalMergeTool`:
   *   `{base}`, `{local}` (ours), `{remote}` (theirs), `{merged}` (file in the working directory;
   *   appended if there is no placeholder), otherwise `git mergetool --no-prompt` with `merge.tool`.
   * Both templates also support `{path}` (= `{merged}`) and `{repo}`.
   * Errors: `not_found` (no tool set up – the message explains it –, program missing, file
   * unchanged or without conflict), `not_allowed` (no `path`, path outside, conflicted file
   * in the diff tool). The app does not wait for the tool; what it writes arrives as `repo:changed`.
   */
  openExternal(input: R & { target: ExternalTarget; path: string | null; source?: DiffSource | null }): Promise<void>;

  // --- Custom commands (Settings → Custom commands, `.forkyard/commands.json`) ----------------
  /**
   * The user's own commands and – with `repoId` – those of the repository's `.forkyard/commands.json`
   * with the state of their approval. Repository commands are listed for review but only `runnable`
   * when exactly this version of the file is approved. A locked repository: `repo_untrusted`.
   */
  customCommandsList(input: { repoId: Id | null }): Promise<CustomCommandList>;
  /** Replaces the user's own commands. One invalid command: `not_allowed` naming it, nothing changes. */
  customCommandsSave(input: { commands: CustomCommandDef[] }): Promise<CustomCommandDef[]>;
  /**
   * Approves `.forkyard/commands.json` in the version with `hash` (from the list) or withdraws the
   * approval (`hash: null`). File changed in between: `stale_state`; no usable file: `not_found`.
   */
  customCommandsTrust(input: R & { hash: string | null }): Promise<CustomCommandList>;
  /**
   * Runs a custom command. `id` is the entry's `key`. `inputs`: the form's values by input ID
   * (checkbox "true"/"false"). With `confirm: true` and `confirmed: false` nothing runs: the result is
   * `{ status: "confirm" }` with the finished command line – call again with `confirmed: true`.
   * `shell` and `git` run as job `jobId` (`job:progress`, `jobCancel`); `url` returns the address.
   * Errors: `command_untrusted` (repository file not approved in this version), `not_found` (gone,
   * program missing), `not_allowed` (a value would become an option of Git, a choice that isn't
   * offered, missing commit/branch/file/remote), `invalid_name` (branch in the context).
   */
  customCommandRun(input: R & { id: string; context: CustomCommandContext; inputs: Record<string, string>; jobId: string; confirmed: boolean }): Promise<CustomCommandResult>;
  /** Reads commands from a JSON file (absolute path from the open dialog) without saving them. Any invalid command: `not_allowed`. */
  customCommandsImport(input: { path: string }): Promise<CustomCommandDef[]>;
  /** Writes the user's own commands to `path` (absolute, from the save dialog). */
  customCommandsExport(input: { path: string }): Promise<void>;

  // --- Command line ---------------------------------------------------------------------------
  /** Whether this installation can link the `forkyard` command itself (AppImage, macOS app) and whether it is linked. */
  cliStatus(): Promise<CliStatus>;
  /**
   * Links the command (AppImage: `~/.local/bin/forkyard`, macOS: `/usr/local/bin/forkyard`).
   * Installers that do it themselves (Windows, deb, rpm): `unsupported`. Another file in the way:
   * `path_exists`. No permission: `not_allowed` with the line to run in a terminal.
   */
  cliInstall(): Promise<CliStatus>;

  // --- Built-in terminal ---------------------------------------------------------
  /**
   * Starts the user's shell in the repository's folder on a pseudo-terminal and
   * returns the `terminalId`. Windows: PowerShell 7 → Windows PowerShell → cmd; otherwise `$SHELL`
   * → bash → sh (as a login shell). `cols`/`rows` in characters (2 to 1000). At most 16
   * terminals at a time (`not_allowed`). Output: event `terminal:data`; end: `terminal:exit`.
   * The events start immediately: listen to `terminal:data` before the call and, until the
   * response with the ID is there, buffer by `terminalId` – otherwise the beginning (greeting, prompt) is missing.
   * What xterm.js reports via `onData` (keys, answers to queries from the shell) goes
   * unchanged to `terminalWrite`.
   */
  terminalOpen(input: R & { cols: number; rows: number }): Promise<Id>;
  /** Input to the shell (e.g. `onData` from xterm.js), at most 1 MB. Terminal already ended: `not_found`. */
  terminalWrite(input: { terminalId: Id; data: string }): Promise<void>;
  terminalResize(input: { terminalId: Id; cols: number; rows: number }): Promise<void>;
  /** Ends the shell along with its child processes; `terminal:exit` still follows. Unknown ID: no error. */
  terminalClose(input: { terminalId: Id }): Promise<void>;

  // --- Worktrees ------------------------------------------------------------------
  // A worktree is opened like a repository via `repoOpen({ path })`. All writing
  // commands return the new list and report `repo:changed` with `refs`.
  /** The main worktree comes first. */
  worktreeList(input: R): Promise<Worktree[]>;
  /**
   * `path`: full path; the folder must not exist or must be empty.
   * `newBranch: true` creates `branch` from `start` (null = HEAD). Otherwise the local branch
   * `branch` is checked out; if `branch` is a remote branch, tag or SHA, the worktree is created
   * detached at that commit (`start` is then ignored).
   * Errors: `not_allowed` (path not absolute; branch already checked out in another
   * worktree), `path_not_found`, `path_exists`, `invalid_name`, `name_exists`, `not_found`.
   */
  worktreeAdd(input: R & { path: string; branch: string; newBranch: boolean; start: string | null }): Promise<Worktree[]>;
  /**
   * The branch stays. Errors: `dirty_worktree` (changes or untracked files, without
   * `force`), `not_allowed` (main worktree, the one currently open, or locked), `not_found`.
   */
  worktreeRemove(input: R & { path: string; force: boolean }): Promise<Worktree[]>;
  /** Already locked: the reason is replaced. */
  worktreeLock(input: R & { path: string; reason: string | null }): Promise<Worktree[]>;
  worktreeUnlock(input: R & { path: string }): Promise<Worktree[]>;
  /** Cleans up entries whose folder is missing (`isPrunable`); locked ones stay. */
  worktreePrune(input: R): Promise<Worktree[]>;

  // --- Submodules -------------------------------------------------------------------
  submoduleList(input: R): Promise<Submodule[]>;
  /**
   * Clones `url` into `path` (relative to the repository) and registers the submodule; afterwards
   * it is staged. Job like `fetch`. Errors: `not_allowed` (URL, path outside, local URL without
   * `protocol.file.allow=always`), `path_exists`, network errors. Reports `repo:changed` with
   * worktree, index, config.
   */
  submoduleAdd(input: R & { jobId: string; url: string; path: string }): Promise<Submodule[]>;
  /**
   * Checks out the recorded commits (recursively), `paths: null` = all; `init` initializes
   * first. Job like `fetch`. Errors: `not_found` (no submodule at the path),
   * `dirty_worktree` (changes in the submodule in the way), network errors.
   */
  submoduleUpdate(input: R & { jobId: string; paths: string[] | null; init: boolean }): Promise<Submodule[]>;
  /**
   * deinit + `git rm` + delete the Git directory under `.git/modules`; the removal is then
   * staged. With state `modified` or `out_of_sync` only with `force` (otherwise `dirty_worktree`).
   */
  submoduleRemove(input: R & { path: string; force?: boolean }): Promise<Submodule[]>;
  /**
   * Moves a submodule (`git mv`; Git updates `.gitmodules`); the move is staged afterwards. `newPath`
   * is relative to the repository and must not exist yet (missing parent folders are created).
   * Errors: `not_found`, `path_exists`, `not_allowed` (outside, in `.git`, into itself). Reports
   * `repo:changed` with worktree, index, config.
   */
  submoduleMove(input: R & { path: string; newPath: string }): Promise<Submodule[]>;

  // --- Git LFS ------------------------------------------------------------------------
  /** Always works. If Git LFS is not installed (`installed: false`), the others answer with `unsupported`. */
  lfsStatus(input: R): Promise<LfsStatus>;
  /** Adds the pattern to `.gitattributes` and sets up LFS in the repository the first time. */
  lfsTrack(input: R & { pattern: string }): Promise<LfsStatus>;
  /** `not_found` if the pattern is not tracked. */
  lfsUntrack(input: R & { pattern: string }): Promise<LfsStatus>;
  /** `git lfs pull` as a job (progress, cancellable); afterwards `repo:changed` with worktree. */
  lfsPull(input: R & { jobId: string }): Promise<void>;
  /** Returns Git LFS's summary (one line, English). */
  lfsPrune(input: R): Promise<string>;
  /**
   * LFS file locks at the server (`git lfs locks --verify`), sorted by path; `filter` narrows by
   * path or owner. The core keeps the list and asks the server again only with `refresh` or
   * after a fetch (then `repo:changed` with `locks`). Without `refresh` Git never asks for
   * credentials. Without Git LFS or on a server without the locking API: `unsupported`.
   */
  lfsLocks(input: R & { filter?: string | null; refresh?: boolean }): Promise<LfsLockList>;
  /** Locks the files; paths that could not be locked are in `failed`. `repo:changed` with `locks`. */
  lfsLock(input: R & { paths: string[] }): Promise<LfsLockOutcome>;
  /** Unlocks; `force` also removes other people's locks and own locks on changed files. */
  lfsUnlock(input: R & { paths: string[]; force: boolean }): Promise<LfsLockOutcome>;

  // --- Repository clean-up ------------------------------------------------------------
  /**
   * What takes space now: `git count-objects -v` (in bytes), the LFS cache (null without LFS),
   * undo backups with their age, orphaned and linked worktrees, reflog entries older than 90 days
   * (null: not counted within 2 s) and the free disk space. Only reads.
   */
  repoCleanupPreview(input: R): Promise<CleanupPreview>;
  /** `git lfs prune --dry-run`: how many LFS files and bytes the LFS step would free. `unsupported` without Git LFS. */
  repoCleanupLfsEstimate(input: R): Promise<CleanupLfsEstimate>;
  /**
   * Cleans up as job `jobId` (`job:progress` with the step key in `line`, cancellable via
   * `jobCancel`) under the network and write lock of the repository and of all its listed
   * worktrees: orphaned worktrees → undo backups → reflog → LFS → `git gc`. A cancel or a failed
   * step still resolves with the result (`cancelled`, `failure`); errors before the first step:
   * `repo_untrusted`, `not_allowed` (options), `cancelled` (while waiting), `duplicate`.
   * Afterwards `repo:changed` with refs.
   */
  repoCleanupRun(input: R & { jobId: string; options: CleanupOptions }): Promise<CleanupResult>;

  // --- Patches ------------------------------------------------------------------------
  /**
   * Patch as text. `unstaged` also contains untracked files; `commit` comes in the format of
   * `git format-patch` (with author and message). `paths: null` = everything. Binary files and
   * files whose diff is not UTF-8 are missing from the text and listed in `skipped`.
   */
  patchCreate(input: R & { source: DiffSource; paths: string[] | null }): Promise<PatchText>;
  /**
   * Applies the patch to the working directory (the index stays); `checkOnly` only checks.
   * All or nothing. Errors: `not_allowed` with a sentence naming the places.
   */
  patchApply(input: R & { text: string; checkOnly: boolean }): Promise<Status>;

  // --- Commit signing ---------------------------------------------------------------------
  /** `repoId: null` = global Git configuration; otherwise the values in effect in the repository. */
  signingStatus(input: { repoId: Id | null }): Promise<SigningStatus>;
  /**
   * Writes `commit.gpgSign`, `gpg.format`, `user.signingKey` into the configuration of the
   * repository (`repoId`) or globally (`repoId: null`). `enabled`/`format`/`key` null removes
   * the entry there (in the repository the global value then applies again – that is how "as global" works).
   * `commitCreate` then signs the way Git would in the terminal.
   *
   * `program` and `allowedSignersFile` are three-valued: omitted = leave alone, null =
   * remove the entry, text = set. `program` lands under the key of the format of THIS
   * call (`gpg.program` for openpgp/null, `gpg.ssh.program`, `gpg.x509.program`);
   * `allowedSignersFile` is `gpg.ssh.allowedSignersFile`. Paths are not checked.
   */
  signingSet(input: {
    repoId: Id | null;
    enabled: boolean | null;
    format: SigningFormat | null;
    key: string | null;
    program?: string | null;
    allowedSignersFile?: string | null;
  }): Promise<SigningStatus>;

  // --- Hosts: accounts (GitHub, GitLab – only their official APIs, with the user's token) ---
  // Error codes of all host commands: `host_unsupported` (no remote on GitHub/GitLab or
  // a connected instance), `host_not_connected` (no account for this host),
  // `host_auth_failed`, `host_rate_limited` (time in `message`), `host_not_found`,
  // `host_rejected`, plus `offline` and `timeout`. Every call is logged (without the token).
  /** The connected accounts of the active profile. No network call. */
  hostAccounts(): Promise<HosterAccount[]>;
  /**
   * Checks the token against the host's API and stores it in the keychain; an existing
   * account for the same address is replaced. `baseUrl: null` = github.com or gitlab.com; otherwise
   * the address of the self-hosted instance (`https://gitlab.company.example`). `http://` only to this
   * machine (tests against a local server, there with an explicit `baseUrl`).
   * Errors: `not_allowed` (token empty/with spaces, address invalid), `host_auth_failed`,
   * `host_not_found` (no API answers at the address), `io` (keychain not
   * reachable – then nothing is stored). Reports `app:changed` with `host_accounts`.
   * `username`: only Bitbucket (Atlassian account e-mail or user name), required there; ignored by
   * the other hosts. `not_allowed` if missing or with spaces/colons.
   */
  hostConnect(input: { kind: HostKind; baseUrl: string | null; token: string; username?: string | null }): Promise<HosterAccount>;
  /** GitHub with the login of the GitHub CLI (`gh auth token`); the token stays in the core. */
  hostConnectGh(input: { baseUrl: string | null }): Promise<HosterAccount>;
  /** Deletes account and token. Unknown ID: no error. Returns the remaining accounts. */
  hostDisconnect(input: { accountId: Id }): Promise<HosterAccount[]>;
  /**
   * Checks the stored token again and refreshes name, picture and permissions. If the
   * host refuses or is unreachable, the account comes back with `lastError` – not an error
   * (only `not_found` for an unknown ID).
   */
  hostCheck(input: { accountId: Id }): Promise<HosterAccount>;
  /**
   * The repository at the host, recognised by a remote's URL (https, ssh, scp form;
   * github.com, gitlab.com, self-hosted instances via a connected account). `remote`: name of the
   * remote; if omitted `origin`, otherwise the first one recognised. null = no remote belongs to a
   * supported host. Without an account `defaultBranch`, `canPush`, `forkParent` are missing; if
   * fetching them fails, the reason is in `error` – the command itself does not fail because of it.
   */
  hostRepoInfo(input: R & { remote?: string | null }): Promise<HostRepoInfo | null>;

  // --- Pull requests (GitLab: merge requests) -----------------------------------------------------
  // All optionally take `remote` like `hostRepoInfo`.
  /**
   * One page, most recently updated first. `page` from 1 (default 1), `perPage` 1 to 100 (default
   * 20). `nextPage: null` = end – do not infer it from the page length (GitHub does not filter "merged"
   * itself, pages can be shorter). `checks` and `reviewState` cost additional calls per
   * entry; unchanged responses are cached and do not count against the limit.
   */
  prList(input: R & { state: PrListState; page?: number | null; perPage?: number | null; remote?: string | null }): Promise<PrPage>;
  prGet(input: R & { number: number; remote?: string | null }): Promise<PrDetails>;
  /**
   * `reviewers`: user names; `labels`: names. Errors: `name_exists` (there is already an open one
   * for the source branch), `empty_message` (title empty), `not_allowed`, `host_rejected`.
   * Pull request from a fork: on GitHub `sourceBranch: "<owner>:<branch>"` and as
   * `remote` the one of the target repository.
   */
  prCreate(
    input: R & {
      title: string;
      body: string;
      sourceBranch: string;
      targetBranch: string;
      draft: boolean;
      reviewers?: string[] | null;
      labels?: string[] | null;
      remote?: string | null;
    },
  ): Promise<PrSummary>;
  /**
   * Changes only what is given (omitted or null = stays). `reviewers` and `labels`
   * replace the respective list. Only GitLab can toggle `draft` (GitHub: `host_unsupported`).
   */
  prUpdate(
    input: R & {
      number: number;
      title?: string | null;
      body?: string | null;
      targetBranch?: string | null;
      draft?: boolean | null;
      reviewers?: string[] | null;
      labels?: string[] | null;
      remote?: string | null;
    },
  ): Promise<PrSummary>;
  /** General comment (Markdown). `empty_message` if empty. */
  prComment(input: R & { number: number; body: string; remote?: string | null }): Promise<HostComment>;
  /**
   * Merges at the host; nothing changes locally (then `fetch`). `deleteBranch` deletes the
   * source branch there (not for forks). Not mergeable: `host_rejected` with the host's reason.
   */
  prMerge(input: R & { number: number; method: PrMergeMethod; deleteBranch: boolean; remote?: string | null }): Promise<PrSummary>;
  prClose(input: R & { number: number; remote?: string | null }): Promise<PrSummary>;
  prReopen(input: R & { number: number; remote?: string | null }): Promise<PrSummary>;
  /**
   * Fetches the pull request's branch and checks it out. Same repository: the source branch
   * with upstream (an existing local one is fast-forwarded). Fork: local branch `pr-<number>`
   * (GitLab `mr-<number>`). Errors as for `branchCheckout` and `fetch`; `not_allowed` if the
   * local branch has its own commits that the pull request does not contain. May ask for
   * credentials (`credential:request`).
   */
  prCheckout(input: R & { number: number; remote?: string | null }): Promise<Status>;
  /**
   * Text of the pull request template from the working directory (`.github/`, `.gitlab/`,
   * root, `docs/`: `pull_request_template.md` or a folder with templates), otherwise null.
   * No network call, needs no account.
   */
  prTemplate(input: R): Promise<string | null>;

  // --- Issues ----------------------------------------------------------------------------------
  /** Like `prList`. `query` searches title and body (GitHub: via the search API, own limit of 30/min). */
  issueList(input: R & { state: IssueState | "all"; query?: string | null; page?: number | null; perPage?: number | null; remote?: string | null }): Promise<IssuePage>;
  issueGet(input: R & { number: number; remote?: string | null }): Promise<IssueDetails>;
  /**
   * Creates an issue – on Azure DevOps a work item (type "Issue", or "Bug" if the project's process
   * has none). Only where `HostRepoInfo.capabilities.issueCreate`; elsewhere `host_unsupported`.
   * Errors: `empty_message` (title empty), `not_allowed` (title with line breaks), host errors.
   */
  issueCreate(input: R & { title: string; body: string; remote?: string | null }): Promise<IssueSummary>;

  // --- Statistics -----------------------------------------------------------------------------
  /**
   * Statistics of the history of `range.ref` as a job: `job:progress` with the phases `history`
   * and `blame`, cancellable via `jobCancel`. Only reads. Cached per tip commit and period
   * (`cached: true`). `HEAD` without a commit, or nothing committed up to `to` → empty statistics
   * (`tip: null`); unknown ref → `not_found`; `from`/`to` not ISO-8601 or `from` after `to` → `not_allowed`.
   */
  statsCompute(input: R & { jobId: string; range: StatsRange }): Promise<RepoStats>;

  // --- AI (v1.2; one provider for all profiles; settings are `Settings.ai*` via settingsSet) ----
  /** State (`unset`/`off`/`on`), chosen provider and model, whether it is connected, key hint, price, notice. */
  aiStatus(): Promise<AiStatus>;
  /** Stores the key in the keychain under `llm:<provider>`; success only after reading it back. `not_allowed` for local providers or a value that is no key. */
  aiKeySet(input: { provider: AiProviderKind; key: string }): Promise<AiStatus>;
  /** Removes the key; success only if it is really gone (`io` otherwise). */
  aiKeyRemove(input: { provider: AiProviderKind }): Promise<AiStatus>;
  /**
   * "Check": lists the models with the entered values (`key`/`baseUrl` null = the stored ones); stores
   * no key. For a compatible service with `model` it also probes and remembers the structured mode.
   * Job under `jobId` (cancellable). Errors: `ai_not_configured` (no key/address, key rejected),
   * `ai_provider_unavailable`, `not_allowed` (`http://` outside this computer), `cancelled`, `timeout`.
   */
  aiModels(input: { jobId: string; provider: AiProviderKind; baseUrl: string | null; key: string | null; model: string | null }): Promise<AiModelList>;
  /** Clears the one-time notice after the update ("Set up …" or "Close"). */
  aiIntroDismiss(): Promise<AiStatus>;
  /**
   * "What is sent?": the exact text for `feature` from `input`, the files left out and the confirmations
   * that would be asked – sends nothing, works in every state. `locale` = `locale()` of the UI.
   * Errors: `repo_untrusted`, `not_found`.
   */
  aiPreview(input: R & { feature: AiFeature; input: AiInput; locale: string }): Promise<AiPreview>;
  /** "Send" in the preview: approves exactly this text (`fingerprint`) for the next request within 10 minutes; first use and repository are remembered, `large`/`cost` only with `dontAskAgain`, `limit` never. */
  aiPreviewConfirm(input: { repoId: Id | null; feature: AiFeature; fingerprint: string; triggers: AiAskTrigger[]; dontAskAgain: boolean }): Promise<void>;
  /** "Ask again everywhere": forgets every given confirmation. */
  aiPreviewReset(): Promise<void>;
  /** This month's usage (numbers only). */
  aiUsage(): Promise<AiUsageSummary>;
  /**
   * Paket 4: title and description of a pull request from the commits of `source` that `target`
   * does not have (full ref names: `refs/heads/…`, `refs/remotes/<remote>/…`). Fills the repository's
   * template (all its headings stay) and adds "Closes #n" for host issues of the commits. Job `jobId`
   * (cancellable). Show and confirm `aiPreview` with `{ kind: "pr_description", source, target }`
   * first. Errors: `ai_disabled`, `ai_not_configured`, `ai_provider_unavailable`, `ai_invalid_answer`,
   * `ai_refused`, `ai_limit_reached`, `ai_too_large`, `not_allowed` (not confirmed, or no commits to
   * describe), `not_found` (ref), `repo_untrusted`, `cancelled`, `timeout`.
   */
  aiPrDescription(input: R & { jobId: string; source: string; target: string; locale: string }): Promise<AiPrDescription>;
  /**
   * "Write" in the commit form (spec 3.1): a commit message for the staged changes – a draft, never
   * committed. Built exactly like `aiPreview` with `{ kind: "commit_message" }`, so a confirmation
   * given there holds. Job under `jobId` (`jobCancel` → `cancelled`). Errors: `nothing_to_commit`
   * (nothing staged), `ai_disabled`, `ai_not_configured`, `ai_provider_unavailable`, `ai_invalid_answer`,
   * `ai_refused`, `ai_limit_reached`, `ai_too_large`, `not_allowed` (not confirmed), `repo_untrusted`,
   * `timeout`, `cancelled`.
   */
  aiCommitMessage(input: R & { jobId: string; locale: string }): Promise<AiCommitMessage>;
  /**
   * Setup dialog (Teilpaket 1b): Claude Code, Codex and opencode with version, path and sign-in, Ollama /
   * LM Studio on this computer and the providers with a stored key – about two seconds at most, sends
   * nothing. Remembers the found programs.
   */
  aiDetect(): Promise<AiDetection>;
  /**
   * “Sign in in the terminal”: a terminal in this repository's tab runs the tool's own sign-in in an empty
   * folder of the app (never the repository); returns the terminal ID. Errors: `not_allowed` (not a
   * command-line tool, more than 16 terminals), `ai_not_configured` (tool not found), `unsupported` (batch shim).
   */
  aiCliLogin(input: R & { provider: AiProviderKind; cols: number; rows: number }): Promise<Id>;
  // --- Git in plain language (v1.2, Paket 5) -----------------------------------------------
  /**
   * A sentence → a checked plan of allowed steps. The AI request runs as job `jobId` (cancel with
   * `jobCancel`), the check as job `${jobId}:check`. Nothing in the repository changes. Errors as
   * for every AI request (`ai_*`); more than 10 steps: `ai_invalid_answer` with "plan too long".
   */
  aiPlan(input: R & { jobId: string; text: string; locale: string }): Promise<PlanPreview>;
  /** Checks (edited) steps again: arguments, conflicts, expected state. Sends nothing. */
  aiPlanCheck(input: R & { jobId: string; steps: PlanStep[] }): Promise<PlanPreview>;
  /**
   * Runs a checked plan step by step as job `jobId` (`job:progress` line "n/total"). `confirmed`:
   * indexes of the outward steps the user confirmed one by one. `stale_state` when `expect` no longer
   * holds; `not_allowed` for an unconfirmed outward step or a plan that cannot run.
   */
  aiPlanRun(input: R & { jobId: string; text: string; steps: PlanStep[]; expect: string; confirmed: number[] }): Promise<PlanRunResult>;
}

/** Unsubscribes an event subscription; `ready` resolves as soon as the subscription is in place at the core. */
export type Unsubscribe = (() => void) & { ready: Promise<void> };

/** What does not go through a core command but through the window. */
export interface CoreSystem {
  /** The operating system's folder dialog. null on cancel. */
  pickFolder(input: { title: string; defaultPath?: string }): Promise<string | null>;
  pickFile(input: { title: string; defaultPath?: string }): Promise<string | null>;
  /**
   * Subscribe to an event; the return value unsubscribes. Whoever must not miss an event (e.g. before
   * `terminalOpen`) first waits for `ready`: `const stop = core.on(…); await stop.ready;`.
   */
  on<E extends keyof CoreEvents>(event: E, handler: (payload: CoreEvents[E]) => void): Unsubscribe;
  /**
   * Operating system notification. Asks for permission the first time. false if it
   * is denied or the system cannot show one – not an error. A click on the
   * notification cannot be intercepted.
   */
  notify(input: { title: string; body: string }): Promise<boolean>;
  /** Whether notifications are allowed; `default` = not asked yet. Does not ask. */
  notifyPermission(): Promise<"granted" | "denied" | "default">;
  /** Text from the clipboard, without the WebView's prompt; empty if there is no text there. */
  clipboardRead(): Promise<string>;
  clipboardWrite(input: { text: string }): Promise<void>;
}

export type Core = CoreCommands & CoreSystem;

/** All command names – the Rust core registers exactly these (in snake_case). */
export type CommandName = keyof CoreCommands;

export type { Ref };
