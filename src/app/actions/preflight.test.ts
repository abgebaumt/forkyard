import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConflictPreview } from "../../core";
import type { PreflightFacts } from "../../screens/Preflight/model";

/** A promise the test resolves from outside. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let pending = deferred<ConflictPreview | null>();
let lastSignal: AbortSignal | undefined;
const previewOnce = vi.fn((_repoId: string, _op: unknown, _limit: number, signal?: AbortSignal) => {
  lastSignal = signal;
  return pending.promise;
});
type Opened = { facts: PreflightFacts | Promise<PreflightFacts> };
const opened: Opened[] = [];
let dialogAnswer = deferred<{ updateRefs: boolean } | null>();

vi.mock("../conflictPreview", () => ({ previewOnce: (...args: Parameters<typeof previewOnce>) => previewOnce(...args) }));
vi.mock("../../core", () => ({ core: { rebaseDependents: () => Promise.resolve([]) } }));
vi.mock("../../screens/Preflight", () => ({
  openPreflightDialog: (options: Opened) => {
    opened.push(options);
    return dialogAnswer.promise;
  },
}));

const { preflight, CHECKING_DIALOG_DELAY_MS } = await import("./preflight");

const request = { title: "Merge feature into main?", confirmLabel: "Merge", op: { kind: "merge" as const, theirs: "feature" } };

describe("preflight before merge, rebase, cherry-pick and revert", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pending = deferred();
    dialogAnswer = deferred();
    opened.length = 0;
    lastSignal = undefined;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a fast, clean check opens no dialog", async () => {
    const result = preflight("repo", request);
    pending.resolve({ status: "clean" });
    await expect(result).resolves.toEqual({ updateRefs: false });
    expect(opened).toHaveLength(0);
  });

  it("a slow check opens the dialog in its checking state while it runs", async () => {
    const result = preflight("repo", request);
    await vi.advanceTimersByTimeAsync(CHECKING_DIALOG_DELAY_MS);
    expect(opened).toHaveLength(1);
    // Still checking: the dialog got the unfinished facts, not an answer.
    expect(opened[0]!.facts).toBeInstanceOf(Promise);
    pending.resolve({ status: "conflicts", files: ["a.txt"], atCommit: null });
    await expect(opened[0]!.facts).resolves.toEqual({ preview: { status: "conflicts", files: ["a.txt"], atCommit: null }, dependents: [] });
    dialogAnswer.resolve({ updateRefs: false });
    await expect(result).resolves.toEqual({ updateRefs: false });
  });

  it("cancelling the checking dialog cancels the check", async () => {
    const result = preflight("repo", request);
    await vi.advanceTimersByTimeAsync(CHECKING_DIALOG_DELAY_MS);
    dialogAnswer.resolve(null);
    await expect(result).resolves.toBeNull();
    expect(lastSignal?.aborted).toBe(true);
  });

  it("with conflicts found quickly the dialog opens with the answer", async () => {
    const result = preflight("repo", request);
    pending.resolve({ status: "conflicts", files: ["a.txt"], atCommit: null });
    await vi.advanceTimersByTimeAsync(0);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.facts).not.toBeInstanceOf(Promise);
    dialogAnswer.resolve({ updateRefs: false });
    await result;
  });
});
