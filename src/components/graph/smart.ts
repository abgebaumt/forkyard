/**
 * "Only the essentials" in the graph: the checked-out branch, its upstream and the target
 * (the main branch it will eventually be merged into). Implemented via the view's solo refs –
 * the core's graph command has no switch of its own, it reads `soloRefs`.
 *
 * Only the computation and what the UI remembers per repository live here; writing happens
 * in src/app/actions/graphView.ts.
 */
import { useSyncExternalStore } from "react";
import type { Id, Ref, RefsSnapshot } from "../../core";

export interface SmartSelection {
  /** `fullName` of the refs the graph should show. */
  refs: string[];
  current: Ref;
  upstream: Ref | null;
  target: Ref | null;
}

/** Usual names of the main branch, after the default from the settings. */
const TARGET_NAMES = ["main", "master", "develop", "trunk"];

/** Name of a remote branch without the remote in front: `origin/main` → `main`. */
const withoutRemote = (ref: Ref) => (ref.remote && ref.name.startsWith(`${ref.remote}/`) ? ref.name.slice(ref.remote.length + 1) : ref.name);

/**
 * What the selection contains. null: no branch checked out (detached HEAD, repository without a commit) –
 * then there is nothing it could align with.
 */
export function smartSelection(refs: RefsSnapshot | undefined, defaultBranchName: string | undefined): SmartSelection | null {
  if (!refs || refs.head.kind !== "branch") return null;
  const headName = refs.head.branch;
  const current = refs.locals.find((ref) => ref.isHead) ?? refs.locals.find((ref) => ref.name === headName);
  if (!current) return null;
  const upstream = current.upstream && !current.upstreamGone ? (refs.remotes.find((ref) => ref.name === current.upstream) ?? null) : null;
  let target: Ref | null = null;
  const names = [...new Set([defaultBranchName, ...TARGET_NAMES].filter((name): name is string => Boolean(name)))];
  for (const name of names) {
    if (name === current.name) {
      // The main branch itself is checked out: there is no other target.
      target = null;
      break;
    }
    target = refs.locals.find((ref) => ref.name === name) ?? refs.remotes.find((ref) => withoutRemote(ref) === name) ?? null;
    if (target) break;
  }
  if (target && (target.fullName === current.fullName || target.fullName === upstream?.fullName)) target = null;
  const list = [current.fullName, upstream?.fullName, target?.fullName].filter((name): name is string => Boolean(name));
  return { refs: [...new Set(list)], current, upstream, target };
}

export const sameRefs = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

// ---------------------------------------------------------------------------
// Remembered per repository (in the app's window storage; the solo refs themselves live in the core)
// ---------------------------------------------------------------------------

export interface SmartRecord {
  /** The solo refs the switch last set – if they differ, someone has filtered by hand. */
  applied: string[];
  /** The previous solo refs; they come back when switching off. */
  previous: string[];
}

const STORAGE_KEY = "gc.graph.smart";
let records: Record<Id, SmartRecord> | null = null;
const listeners = new Set<() => void>();

function load(): Record<Id, SmartRecord> {
  if (records) return records;
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    records = parsed && typeof parsed === "object" ? (parsed as Record<Id, SmartRecord>) : {};
  } catch {
    records = {};
  }
  return records;
}

export const smartRecord = (repoId: Id): SmartRecord | null => load()[repoId] ?? null;

export function setSmartRecord(repoId: Id, record: SmartRecord | null): void {
  const next = { ...load() };
  if (record) next[repoId] = record;
  else delete next[repoId];
  records = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // No storage available: the switch then only applies until the next restart.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The remembered state of the switch for this repository; null = off. */
export function useSmartRecord(repoId: Id): SmartRecord | null {
  return useSyncExternalStore(subscribe, () => load()[repoId] ?? null);
}
