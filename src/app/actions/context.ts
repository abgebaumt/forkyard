/**
 * What actions and menus need to know about a repository – read from the query cache,
 * without asking the core. Menus are pure functions and need the answer immediately;
 * if something is missing from the cache, "unknown" applies and the core checks on execution.
 */
import type { InfiniteData } from "@tanstack/react-query";
import { core, type BisectStatus, type GraphPage, type GraphRow, type Id, type Ref, type RefsSnapshot, type Remote, type RepoViewState, type Settings, type Sha, type Stash, type Status, type UndoState } from "../../core";
import { qk, queryClient } from "../queries";
import { loadStatus } from "../statusCache";

export const cachedStatus = (repoId: Id) => queryClient.getQueryData<Status>(qk.status(repoId));
export const cachedRefs = (repoId: Id) => queryClient.getQueryData<RefsSnapshot>(qk.refs(repoId));
export const cachedRemotes = (repoId: Id) => queryClient.getQueryData<Remote[]>(qk.remotes(repoId));
export const cachedStashes = (repoId: Id) => queryClient.getQueryData<Stash[]>(qk.stashes(repoId));
export const cachedSettings = () => queryClient.getQueryData<Settings>(qk.settings);
export const cachedViewState = (repoId: Id) => queryClient.getQueryData<RepoViewState>(qk.viewState(repoId));
export const cachedBisect = (repoId: Id) => queryClient.getQueryData<BisectStatus>(qk.bisect(repoId));
export const cachedUndo = (repoId: Id) => queryClient.getQueryData<UndoState>(qk.undo(repoId));

/** All loaded graph rows in display order (newest first). */
export function cachedGraphRows(repoId: Id): GraphRow[] {
  const data = queryClient.getQueryData<InfiniteData<GraphPage>>(qk.graph(repoId));
  return data?.pages.flatMap((page) => page.rows) ?? [];
}

/** Whether the graph is loaded up to the beginning of the history. */
export function graphComplete(repoId: Id): boolean {
  const data = queryClient.getQueryData<InfiniteData<GraphPage>>(qk.graph(repoId));
  const last = data?.pages[data.pages.length - 1];
  return Boolean(last && last.nextCursor === null);
}

/** Name of the checked-out branch; null for a detached HEAD or while the status is still missing. */
export function currentBranch(repoId: Id): string | null {
  const head = cachedStatus(repoId)?.head ?? cachedRefs(repoId)?.head;
  return head && head.kind !== "detached" ? head.branch : null;
}

/** SHA of HEAD; null in a repository without commits. */
export function headSha(repoId: Id): Sha | null {
  const head = cachedStatus(repoId)?.head ?? cachedRefs(repoId)?.head;
  return head && head.kind !== "unborn" ? head.sha : null;
}

export function findLocalBranch(repoId: Id, name: string): Ref | undefined {
  return cachedRefs(repoId)?.locals.find((ref) => ref.name === name);
}

/**
 * Fresh data for actions that must not rely on the cache. Asked directly from the core
 * and then put into the cache – a query through the query client could be cancelled by a
 * concurrent `repo:changed`, and the action would be left without an answer.
 */
async function fresh<T>(key: readonly unknown[], load: () => Promise<T>): Promise<T> {
  const value = await load();
  queryClient.setQueryData(key, value);
  return value;
}
// The status has its own ordering check (statusCache.ts).
export { loadStatus };
export const loadRefs = (repoId: Id) => fresh(qk.refs(repoId), () => core.refsList({ repoId }));
export const loadStashes = (repoId: Id) => fresh(qk.stashes(repoId), () => core.stashList({ repoId }));
export const loadRemotes = (repoId: Id): Promise<Remote[]> => {
  const cached = cachedRemotes(repoId);
  return cached ? Promise.resolve(cached) : fresh(qk.remotes(repoId), () => core.remoteList({ repoId }));
};

/** Short form of a SHA for texts. */
export const short = (sha: Sha) => sha.slice(0, 7);

/** Shortens long names and summaries for titles of dialogs and messages; the full text is shown elsewhere. */
export function clip(text: string, max = 60): string {
  const line = text.split("\n")[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

/** Shortens in the middle so the start and end of a long branch name stay readable. */
export function clipMiddle(text: string, max = 32): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) * 0.6);
  const tail = max - 1 - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}
