/**
 * The lasso: lines selected in the unstaged diff, kept across files, per tab. Each file keeps the
 * diff token its keys belong to and the ready `PatchSelection`, so "commit only this" needs no
 * further diff read. `useLassoGuard` drops a file's selection as soon as the file changes.
 */
import { useEffect, useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { create } from "zustand";
import type { Id, PatchSelection } from "../core";
import { t } from "../i18n";
import { toast } from "../ui/Feedback";
import { baseName } from "./paths";
import { diffQuery, useStatus } from "./queries";

export interface LassoFile {
  token: string;
  keys: string[];
  selection: PatchSelection;
  lines: number;
}

/** Key = path. */
export type Lasso = Readonly<Record<string, LassoFile>>;

const EMPTY_LASSO: Lasso = {};
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
  clear: (tabId) =>
    set(({ byTab }) => {
      const { [tabId]: _, ...rest } = byTab;
      return { byTab: rest };
    }),
  replace: (tabId, lasso) => set(({ byTab }) => ({ byTab: { ...byTab, [tabId]: lasso } })),
}));

export const useLasso = (tabId: Id): Lasso => useLassoStore((state) => state.byTab[tabId] ?? EMPTY_LASSO);

const UNSTAGED = { kind: "unstaged" } as const;

/** Re-reads the unstaged diff of every selected file when the status changes; drops changed files with a notice. */
export function useLassoGuard(repoId: Id, tabId: Id): void {
  const lasso = useLasso(tabId);
  const { data: status } = useStatus(repoId);
  const paths = useMemo(() => Object.keys(lasso).sort(), [lasso]);
  // Same cache entries as the diff view: the core's worktree events refetch them once each, an open diff shares the read.
  const diffs = useQueries({ queries: paths.map((path) => diffQuery(repoId, path, UNSTAGED)) });

  const tokens: Record<string, string | null> = {};
  const unstaged = status ? new Set(status.unstaged.map((file) => file.path)) : null;
  paths.forEach((path, index) => {
    const diff = diffs[index]?.data;
    if (unstaged && !unstaged.has(path)) tokens[path] = null;
    else if (diff?.kind === "text" && diff.token && !diffs[index]?.isFetching) tokens[path] = diff.token;
  });
  const signature = JSON.stringify(tokens);

  useEffect(() => {
    const current = useLassoStore.getState().byTab[tabId] ?? EMPTY_LASSO;
    const result = dropStale(current, JSON.parse(signature) as Record<string, string | null>);
    if (result.dropped.length === 0) return;
    useLassoStore.getState().replace(tabId, result.lasso);
    for (const path of result.dropped) toast({ tone: "info", title: t("wip.lasso.dropped", { file: baseName(path) }) });
  }, [signature, tabId]);
}
