/**
 * The lasso: lines selected in the unstaged diff, kept across files, per tab. Each file keeps the
 * diff token its keys belong to and the ready `PatchSelection`, so "commit only this" needs no
 * further diff read. `useLassoGuard` drops a file's selection as soon as the file changes.
 */
import { useEffect, useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { create } from "zustand";
import type { FileDiff, Id, PatchSelection } from "../core";
import { t } from "../i18n";
import { toast } from "../ui/Feedback";
import { baseName } from "./paths";
import { busyKeys } from "./actions/keys";
import { diffQuery, useStatus } from "./queries";
import { useAppStore } from "./store";

export interface LassoFile {
  token: string;
  keys: string[];
  selection: PatchSelection;
  lines: number;
  /** Selected in a force-opened (large) diff: the guard compares against that one. */
  forced: boolean;
}

/** Key = path. */
export type Lasso = Readonly<Record<string, LassoFile>>;

const EMPTY_LASSO: Lasso = {};
const UNSTAGED = { kind: "unstaged" } as const;
const NO_KEYS: ReadonlySet<string> = new Set();

/** null or no keys removes the file. */
export function setLassoFile(lasso: Lasso, path: string, file: LassoFile | null): Lasso {
  const { [path]: _, ...rest } = lasso;
  return file && file.keys.length > 0 ? { ...rest, [path]: file } : rest;
}

export function lassoCounts(lasso: Lasso): { files: number; lines: number } {
  const files = Object.values(lasso);
  return { files: files.length, lines: files.reduce((sum, file) => sum + file.lines, 0) };
}

/** Sorted by path (code units, like Git). */
export function lassoSelections(lasso: Lasso): PatchSelection[] {
  return Object.keys(lasso)
    .sort()
    .map((path) => lasso[path]!.selection);
}

/** The file's keys, but only if they belong to the diff with this token. */
export function keysFor(lasso: Lasso, path: string, token: string | null | undefined): ReadonlySet<string> {
  const file = lasso[path];
  return file && token && file.token === token ? new Set(file.keys) : NO_KEYS;
}

/** `tokens[path]`: the current unstaged token, null = no longer in the unstaged list. Missing paths are kept. */
export function dropStale(lasso: Lasso, tokens: Readonly<Record<string, string | null>>): { lasso: Lasso; dropped: string[] } {
  const dropped = Object.keys(lasso)
    .filter((path) => path in tokens && tokens[path] !== lasso[path]!.token)
    .sort();
  if (dropped.length === 0) return { lasso, dropped };
  return { lasso: Object.fromEntries(Object.entries(lasso).filter(([path]) => !dropped.includes(path))), dropped };
}

/**
 * `tokens` for dropStale. `diffs[i]` belongs to `paths[i]` (the forced diff for forced files).
 * Nothing while one of our own writes runs: the change it makes is not one from outside.
 */
export function currentTokens(
  paths: readonly string[],
  unstaged: ReadonlySet<string> | null,
  diffs: readonly ({ data?: FileDiff; isFetching: boolean } | undefined)[],
  writing: boolean,
): Record<string, string | null> {
  const tokens: Record<string, string | null> = {};
  if (writing) return tokens;
  paths.forEach((path, index) => {
    const diff = diffs[index];
    if (unstaged && !unstaged.has(path)) tokens[path] = null;
    else if (diff?.data?.kind === "text" && diff.data.token && !diff.isFetching) tokens[path] = diff.data.token;
  });
  return tokens;
}

/** The unstaged diff per path; for a file selected in a force-opened diff the forced one (only that one has a token). */
export const guardQueries = (repoId: Id, lasso: Lasso, paths: readonly string[]) =>
  paths.map((path) => diffQuery(repoId, path, UNSTAGED, { force: lasso[path]?.forced ?? false }));

interface LassoState {
  byTab: Record<Id, Lasso>;
  setFile(tabId: Id, path: string, file: LassoFile | null): void;
  clear(tabId: Id): void;
  replace(tabId: Id, lasso: Lasso): void;
}

/** Window-local like the other view stores. */
export const useLassoStore = create<LassoState>()((set) => ({
  byTab: {},
  setFile: (tabId, path, file) =>
    set(({ byTab }) => ({ byTab: { ...byTab, [tabId]: setLassoFile(byTab[tabId] ?? EMPTY_LASSO, path, file) } })),
  clear: (tabId) => set(({ byTab }) => ({ byTab: { ...byTab, [tabId]: EMPTY_LASSO } })),
  replace: (tabId, lasso) => set(({ byTab }) => ({ byTab: { ...byTab, [tabId]: lasso } })),
}));

// A closed tab takes its lasso along.
useAppStore.subscribe((state, previous) => {
  if (state.views === previous.views) return;
  const { byTab } = useLassoStore.getState();
  const gone = Object.keys(byTab).filter((tabId) => !(tabId in state.views));
  if (gone.length > 0)
    useLassoStore.setState({ byTab: Object.fromEntries(Object.entries(byTab).filter(([tabId]) => !gone.includes(tabId))) });
});

export const useLasso = (tabId: Id): Lasso => useLassoStore((state) => state.byTab[tabId] ?? EMPTY_LASSO);

/** Re-reads the unstaged diff of every selected file when the status changes; drops changed files with a notice. */
export function useLassoGuard(repoId: Id, tabId: Id): void {
  const lasso = useLasso(tabId);
  const { data: status } = useStatus(repoId);
  // Our own stage, discard and lasso commits: their result is no change from outside (same keys as their runAction).
  const writing = useAppStore((state) =>
    Boolean(state.busy[busyKeys.write(repoId, "patch")] || state.busy[busyKeys.write(repoId, "commit")]),
  );
  const paths = useMemo(() => Object.keys(lasso).sort(), [lasso]);
  // Same cache entries as the diff view: the core's worktree events refetch them once each, an open diff shares the read.
  const diffs = useQueries({ queries: guardQueries(repoId, lasso, paths) });
  const unstaged = status ? new Set(status.unstaged.map((file) => file.path)) : null;
  const signature = JSON.stringify(currentTokens(paths, unstaged, diffs, writing));

  useEffect(() => {
    const current = useLassoStore.getState().byTab[tabId] ?? EMPTY_LASSO;
    const result = dropStale(current, JSON.parse(signature) as Record<string, string | null>);
    if (result.dropped.length === 0) return;
    useLassoStore.getState().replace(tabId, result.lasso);
    for (const path of result.dropped) toast({ tone: "info", title: t("wip.lasso.dropped", { file: baseName(path) }) });
  }, [signature, tabId]);
}
