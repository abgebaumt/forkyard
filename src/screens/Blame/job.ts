/**
 * Blame as a job (`fileBlameJob`): the lines of `blame:chunk` as they arrive – first every line's
 * text, unassigned, then the spans Git finds – published per file for the view, which shows them
 * until the query resolves with the final lines.
 */
import { useSyncExternalStore } from "react";
import { core, type BlameChunkEvent, type BlameLine, type Id, type Sha, type Unsubscribe } from "../../core";
import { newJobId } from "../../app/run";
import { PENDING_SHA } from "./model";

export { PENDING_SHA };

export interface BlameProgress {
  total: number;
  done: number;
  text: string[];
  /** Index = line number − 1; undefined while not assigned. */
  lines: (BlameLine | undefined)[];
}

/** The progress after `chunk`: a text chunk starts it, span chunks fill in lines (a new object each time). */
export function applyChunk(before: BlameProgress | null, chunk: BlameChunkEvent): BlameProgress | null {
  if (chunk.text) {
    before = { total: chunk.total, done: chunk.done, text: chunk.text, lines: new Array(chunk.text.length) };
    if (chunk.spans.length === 0) return before;
  }
  if (!before) return null;
  const lines = before.lines.slice();
  for (const span of chunk.spans) {
    for (let lineNo = span.startLine; lineNo < span.startLine + span.count && lineNo <= before.text.length; lineNo++) {
      lines[lineNo - 1] = {
        lineNo,
        text: before.text[lineNo - 1]!,
        sha: span.sha,
        author: span.author,
        authoredAt: span.authoredAt,
        summary: span.summary,
        uncommitted: span.uncommitted,
      };
    }
  }
  return { ...before, done: chunk.done, lines };
}

/** All lines; those not assigned yet carry PENDING_SHA. */
export function progressLines(progress: BlameProgress): BlameLine[] {
  return progress.text.map(
    (text, index) =>
      progress.lines[index] ?? {
        lineNo: index + 1,
        text,
        sha: PENDING_SHA,
        author: { name: "", email: "" },
        authoredAt: "",
        summary: "",
        uncommitted: false,
      },
  );
}

export function progressPercent(progress: BlameProgress): number {
  return progress.total === 0 ? 100 : Math.floor((progress.done * 100) / progress.total);
}

export const progressKey = (repoId: Id, path: string, sha: Sha | null) => JSON.stringify([repoId, path, sha]);

const progresses = new Map<string, BlameProgress>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function publishProgress(key: string, progress: BlameProgress | null): void {
  if (progress) progresses.set(key, progress);
  else if (!progresses.delete(key)) return;
  listeners.forEach((listener) => listener());
}

/** The current progress of a running blame (null when none runs). */
export const progressOf = (key: string): BlameProgress | null => progresses.get(key) ?? null;

export function useBlameProgress(key: string): BlameProgress | null {
  return useSyncExternalStore(subscribe, () => progressOf(key));
}

export interface BlameJobDeps {
  listen(handler: (chunk: BlameChunkEvent) => void): Unsubscribe;
  run(input: { repoId: Id; jobId: string; path: string; sha: Sha | null }): Promise<BlameLine[]>;
  cancel(jobId: string): void;
  newJobId(): string;
}

export const liveBlameDeps: BlameJobDeps = {
  listen: (handler) => core.on("blame:chunk", handler),
  run: (input) => core.fileBlameJob(input),
  cancel: (jobId) => void core.jobCancel({ jobId }).catch(() => undefined),
  // Called late: run.ts imports the queries, which import this module.
  newJobId: () => newJobId(),
};

/** Listens (awaits ready) before run; filters chunks by jobId; abort → cancel + publishProgress(key, null); clears progress when settled. */
export async function runBlameJob(
  deps: BlameJobDeps,
  input: { repoId: Id; path: string; sha: Sha | null },
  signal?: AbortSignal,
): Promise<BlameLine[]> {
  const key = progressKey(input.repoId, input.path, input.sha);
  const jobId = deps.newJobId();
  let progress: BlameProgress | null = null;
  const stop = deps.listen((chunk) => {
    if (chunk.jobId !== jobId || signal?.aborted) return;
    progress = applyChunk(progress, chunk);
    publishProgress(key, progress);
  });
  const onAbort = () => {
    deps.cancel(jobId);
    publishProgress(key, null);
  };
  try {
    await stop.ready;
    signal?.throwIfAborted();
    signal?.addEventListener("abort", onAbort, { once: true });
    return await deps.run({ ...input, jobId });
  } finally {
    signal?.removeEventListener("abort", onAbort);
    stop();
    publishProgress(key, null);
  }
}
