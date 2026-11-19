import { describe, expect, test, vi } from "vitest";
import type { BlameChunkEvent, BlameLine, BlameSpan, Unsubscribe } from "../../core";
import {
  applyChunk,
  progressKey,
  progressOf,
  progressLines,
  progressPercent,
  runBlameJob,
  type BlameJobDeps,
  type BlameProgress,
} from "./job";

const SHA = "s".repeat(40);
const span = (startLine: number, count: number, sha = SHA): BlameSpan => ({
  sha,
  startLine,
  count,
  author: { name: "Lena Hartmann", email: "lena@example.org" },
  authoredAt: "2026-03-02T09:02:00.000Z",
  summary: "Messintervall auf fünf Minuten",
  uncommitted: false,
});
const chunk = (patch: Partial<BlameChunkEvent>): BlameChunkEvent => ({
  jobId: "job-1",
  repoId: "r1",
  total: 3,
  done: 0,
  text: null,
  spans: [],
  ...patch,
});

/** Fake deps: the test sends chunks and settles the run by hand. */
function fakeDeps(jobId = "job-1") {
  let handler: ((chunk: BlameChunkEvent) => void) | null = null;
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  let settle!: { resolve: (lines: BlameLine[]) => void; reject: (error: unknown) => void };
  const log: string[] = [];
  const deps: BlameJobDeps = {
    listen(next) {
      log.push("listen");
      handler = next;
      const stop = (() => {
        handler = null;
      }) as Unsubscribe;
      stop.ready = ready;
      return stop;
    },
    run: vi.fn((input) => {
      log.push(`run ${input.jobId}`);
      return new Promise<BlameLine[]>((resolve, reject) => {
        settle = { resolve, reject };
      });
    }),
    cancel: vi.fn((jobId: string) => settle.reject(new Error(`cancelled ${jobId}`))),
    newJobId: () => jobId,
  };
  return {
    deps,
    log,
    markReady,
    send: (event: BlameChunkEvent) => handler?.(event),
    resolve: (lines: BlameLine[]) => settle.resolve(lines),
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const input = { repoId: "r1", path: "src/main.rs", sha: null };
const KEY = progressKey("r1", "src/main.rs", null);

describe("blame job", () => {
  test("text chunk shows all lines pending, span chunks fill them", () => {
    const started = applyChunk(null, chunk({ text: ["a", "b", "c"] }));
    expect(started).not.toBeNull();
    expect(progressLines(started!).map((line) => line.sha)).toEqual(["", "", ""]);
    expect(progressLines(started!).map((line) => line.text)).toEqual(["a", "b", "c"]);
    expect(progressPercent(started!)).toBe(0);

    const filled = applyChunk(started, chunk({ done: 2, spans: [span(2, 2)] })) as BlameProgress;
    const lines = progressLines(filled);
    expect(lines.map((line) => line.sha)).toEqual(["", SHA, SHA]);
    expect(lines.map((line) => line.text)).toEqual(["a", "b", "c"]);
    expect(lines.map((line) => line.lineNo)).toEqual([1, 2, 3]);
    expect(progressPercent(filled)).toBe(66);
    // The earlier snapshot stays as it was (a new object per chunk for useSyncExternalStore).
    expect(progressLines(started!)[1]!.sha).toBe("");
  });

  test("a span chunk without a text chunk before it starts nothing; an empty file is 100 %", () => {
    expect(applyChunk(null, chunk({ spans: [span(1, 1)] }))).toBeNull();
    expect(progressPercent(applyChunk(null, chunk({ total: 0, text: [] }))!)).toBe(100);
  });

  test("chunks of other jobs are ignored and the result resolves", async () => {
    const fake = fakeDeps();
    const seen: (BlameProgress | null)[] = [];
    const result = runBlameJob(fake.deps, input);
    fake.markReady();
    await flush();
    fake.send(chunk({ jobId: "other", text: ["x", "y", "z"] }));
    seen.push(progressOf(KEY));
    fake.send(chunk({ text: ["a", "b", "c"] }));
    seen.push(progressOf(KEY));
    const lines: BlameLine[] = [];
    fake.resolve(lines);
    await expect(result).resolves.toBe(lines);
    expect(seen[0]).toBeNull();
    expect(seen[1]?.text).toEqual(["a", "b", "c"]);
    // Settled: the progress is gone one macrotask later.
    await flush();
    expect(progressOf(KEY)).toBeNull();
  });

  test("on success the progress stays until the query has the result", async () => {
    const fake = fakeDeps();
    const result = runBlameJob(fake.deps, input);
    fake.markReady();
    await flush();
    fake.send(chunk({ text: ["a", "b", "c"] }));
    fake.resolve([]);
    await result;
    // Still there right after the promise resolved: the view keeps its editor until the data arrives.
    expect(progressOf(KEY)?.text).toEqual(["a", "b", "c"]);
    await flush();
    expect(progressOf(KEY)).toBeNull();
  });

  test("an older job settling late does not clear a newer job's progress for the same file", async () => {
    const older = fakeDeps("job-old");
    const newer = fakeDeps("job-new");
    const first = runBlameJob(older.deps, input);
    older.markReady();
    await flush();
    older.send(chunk({ jobId: "job-old", text: ["a", "b", "c"] }));
    const second = runBlameJob(newer.deps, input);
    newer.markReady();
    await flush();
    newer.send(chunk({ jobId: "job-new", text: ["x", "y", "z"] }));
    older.resolve([]);
    await first;
    await flush();
    expect(progressOf(KEY)?.text).toEqual(["x", "y", "z"]);
    newer.resolve([]);
    await second;
    await flush();
    expect(progressOf(KEY)).toBeNull();
  });

  test("aborting cancels the job and clears the progress", async () => {
    const fake = fakeDeps();
    const controller = new AbortController();
    const result = runBlameJob(fake.deps, input, controller.signal);
    fake.markReady();
    await flush();
    fake.send(chunk({ text: ["a", "b", "c"] }));
    expect(progressOf(KEY)).not.toBeNull();
    controller.abort();
    await expect(result).rejects.toThrow("cancelled job-1");
    expect(fake.deps.cancel).toHaveBeenCalledTimes(1);
    expect(fake.deps.cancel).toHaveBeenCalledWith("job-1");
    expect(progressOf(KEY)).toBeNull();
  });

  test("listening starts before the command is sent", async () => {
    const fake = fakeDeps();
    const result = runBlameJob(fake.deps, input);
    await flush();
    expect(fake.log).toEqual(["listen"]);
    expect(fake.deps.run).not.toHaveBeenCalled();
    fake.markReady();
    await flush();
    expect(fake.log).toEqual(["listen", "run job-1"]);
    fake.resolve([]);
    await result;
  });
});
