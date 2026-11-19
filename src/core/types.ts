/**
 * Data types between the UI and the core.
 *
 * The contract types are generated from the Rust core (`crates/core/src/model/*.rs`,
 * `error.rs`) into `./generated/` by `npm run gen:types` (ts-rs) and re-exported here; change
 * them in Rust, never in the generated files. This file keeps only what has no Rust type.
 */

export type * from "./generated/agent_collisions";
export type * from "./generated/agent_review";
export type * from "./generated/agents";
export type * from "./generated/ai";
export type * from "./generated/app";
export type * from "./generated/branch_cleanup";
export type * from "./generated/cleanup";
export type * from "./generated/commits";
export type * from "./generated/compose";
export type * from "./generated/conflicts";
export type * from "./generated/crash";
export type * from "./generated/credentials";
export type * from "./generated/custom_commands";
export type * from "./generated/diff";
export type * from "./generated/error";
export type * from "./generated/events";
export type * from "./generated/explain";
export type * from "./generated/gitflow";
export type * from "./generated/graph";
export type * from "./generated/history";
export type * from "./generated/hosts";
export type * from "./generated/log";
export type * from "./generated/refs";
export type * from "./generated/results";
export type * from "./generated/small_io";
export type * from "./generated/stacks";
export type * from "./generated/stats";
export type * from "./generated/status";
export type * from "./generated/view";
export type * from "./generated/windows";
export type * from "./generated/worktrees";

import type { CollisionReport } from "./generated/agent_collisions";
import type { LaunchRequest } from "./generated/app";
import type { CredentialRequest } from "./generated/credentials";
import type { CoreErrorData, ErrorCode } from "./generated/error";
import type { AppChange, BlameChunkEvent, RepoChange } from "./generated/events";
import type { ActivityEntry } from "./generated/log";

export type Id = string;

export type Sha = string;

/** UTC, ISO-8601 with `Z`. */
export type IsoTime = string;

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

/** Git's empty tree (SHA-1 repositories); valid as `from` of a `range` source. */
export const EMPTY_TREE_SHA: Sha = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export type PlanArgValue = string | boolean | string[] | null;

export interface CoreEvents {
  "repo:changed": { repoId: Id; what: RepoChange[] };
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
  /** A second start without arguments: the window sink brings the window forward; the UI does not subscribe. */
  "app:focus_request": null;
  /**
   * The window is supposed to close, but the UI has reported via `appCloseGuard` that something
   * would be lost: it asks the user and calls `appQuit` – or leaves the window open.
   */
  // No payload. (Written as a literal object type: that is how the contract check in e2e/features/contract.mjs reads it.)
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  "app:close_requested": {};
  /** The follow-up job brought changed submodules along; `ok: false` is a warning (`message` says why), the main operation went through. */
  "submodules:updated": { repoId: Id; ok: boolean; paths: string[]; message: string | null };
  /** Coding agents of `repoId` changed (start, status, end, cleanup); `running`: agents running in all repositories. */
  "agents:changed": { repoId: Id; running: number };
  /** The collision check of `repoId`'s coding agents started (`state: "checking"`) or has a new result. */
  "agents:collisions": CollisionReport;
  /** Progress of `fileBlameJob`: the first chunk carries all lines (`text`), later ones the blamed `spans`. */
  "blame:chunk": BlameChunkEvent;
}
