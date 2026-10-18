/**
 * The writer hook end to end with its real send gate: "Write" asks in the nested dialog when the
 * core wants a confirmation, waits for it, and sends only after "Send". The test environment has
 * no DOM, so a minimal hook runtime stands in for React (state, refs, effects with deps).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AiPreview } from "../../core";

// ---- minimal hook runtime -------------------------------------------------------------------
type Slot = { value?: unknown; deps?: unknown[]; cleanup?: (() => void) | void };
let slots: Slot[] = [];
let cursor = 0;
let renderFn: (() => void) | null = null;
let pendingEffects: (() => void)[] = [];
const changed = (a: unknown[] | undefined, b: unknown[] | undefined) => !a || !b || a.length !== b.length || a.some((v, i) => !Object.is(v, b[i]));
const slot = (): Slot => {
  const s = (slots[cursor] ??= {});
  cursor++;
  return s;
};

vi.mock("react", () => ({
  useState: <T>(initial: T) => {
    const s = slot();
    if (!("value" in s)) s.value = initial;
    const set = (next: T | ((prev: T) => T)) => {
      s.value = typeof next === "function" ? (next as (prev: T) => T)(s.value as T) : next;
      renderFn?.();
    };
    return [s.value as T, set];
  },
  useRef: <T>(initial: T) => {
    const s = slot();
    if (!("value" in s)) s.value = { current: initial };
    return s.value;
  },
  useCallback: <T>(fn: T, deps: unknown[]) => {
    const s = slot();
    if (!("value" in s) || changed(s.deps, deps)) {
      s.value = fn;
      s.deps = deps;
    }
    return s.value as T;
  },
  useEffect: (effect: () => (() => void) | void, deps?: unknown[]) => {
    const s = slot();
    if (deps === undefined || !("deps" in s) || changed(s.deps, deps)) {
      s.deps = deps ?? [];
      pendingEffects.push(() => {
        if (typeof s.cleanup === "function") s.cleanup();
        s.cleanup = effect();
      });
    }
  },
}));

// ---- the core and the app surroundings, as local fakes --------------------------------------
const sent: unknown[] = [];
const confirmed: unknown[] = [];
let asks: AiPreview["asks"] = [];

vi.mock("../../core", () => ({
  core: {
    aiPreview: () =>
      Promise.resolve({
        text: "## Commits\n- a1b2c3d Add tag dialog",
        omitted: [],
        shortened: [],
        chars: 34,
        estimatedTokens: 9,
        estimatedCostUsd: null,
        asks,
        fingerprint: "fp-1",
        monthCostUsd: 0,
        limitUsd: null,
      }),
    aiPreviewConfirm: (input: unknown) => {
      confirmed.push(input);
      return Promise.resolve();
    },
    aiReleaseNotes: (input: unknown) => {
      sent.push(input);
      return Promise.resolve({ markdown: "### Added\n- Tag dialog", groups: [], unmentioned: 0 });
    },
    jobCancel: () => Promise.resolve(),
  },
}));
vi.mock("../../app/ai/PreviewDialog", () => ({
  showAiPreview: () => {
    throw new Error("the queued dialog host must not be used inside the tag dialog");
  },
}));
vi.mock("../../app/run", () => ({
  newJobId: () => "job-1",
  runAction: async <T>(_label: string, fn: () => Promise<T>) => {
    try {
      return { ok: true, value: await fn() };
    } catch (error) {
      return { ok: false, error };
    }
  },
}));
vi.mock("./model", () => ({ answerPlacement: (_now: string, _start: string, notes: { markdown: string }) => ({ kind: "insert", text: notes.markdown }) }));

// The loading ticker only needs a timer that never fires within a test.
vi.stubGlobal("window", { setInterval: () => 0, clearInterval: () => undefined });

const { useReleaseNotesWriter } = await import("./useWriter");
type Writer = ReturnType<typeof useReleaseNotesWriter>;

let field = "";
let writer: Writer;
function mount() {
  slots = [];
  pendingEffects = [];
  renderFn = () => {
    cursor = 0;
    writer = useReleaseNotesWriter({ repoId: "repo", to: "v1.2.0", current: () => field, apply: (text) => (field = text) });
    const run = pendingEffects;
    pendingEffects = [];
    run.forEach((effect) => effect());
  };
  renderFn();
}
const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

beforeEach(() => {
  sent.length = 0;
  confirmed.length = 0;
  field = "";
  asks = [];
  mount();
});

describe("release notes writer hook: send confirmation in the nested dialog", () => {
  it("sends without a dialog when the core asks for nothing", async () => {
    await writer.write();
    expect(writer.preview).toBeNull();
    expect(sent).toHaveLength(1);
    expect(field).toBe("### Added\n- Tag dialog");
  });

  it("opens the nested confirmation, waits for it and sends after “Send”", async () => {
    asks = ["first_use"];
    let finished = false;
    const done = writer.write().then(() => (finished = true));
    await settle();
    expect(writer.preview?.mode).toBe("confirm");
    expect(writer.preview?.preview.fingerprint).toBe("fp-1");
    expect(sent).toHaveLength(0);
    expect(finished).toBe(false);

    writer.closePreview({ send: true, dontAskAgain: false });
    await done;
    expect(writer.preview).toBeNull();
    expect(confirmed).toEqual([{ repoId: "repo", feature: "release_notes", fingerprint: "fp-1", triggers: ["first_use"], dontAskAgain: false }]);
    expect(sent).toHaveLength(1);
    expect(field).toBe("### Added\n- Tag dialog");
  });

  it("stops without sending when the confirmation is cancelled", async () => {
    asks = ["first_use"];
    const done = writer.write();
    await settle();
    expect(writer.preview?.mode).toBe("confirm");

    writer.closePreview(null);
    await done;
    expect(writer.preview).toBeNull();
    expect(confirmed).toHaveLength(0);
    expect(sent).toHaveLength(0);
    expect(writer.state.phase).toBe("idle");
    expect(field).toBe("");
  });

  it("“What is sent?” opens the nested dialog to look and resolves on close", async () => {
    const done = writer.whatIsSent();
    await settle();
    expect(writer.preview?.mode).toBe("look");
    writer.closePreview(null);
    await done;
    expect(writer.preview).toBeNull();
    expect(sent).toHaveLength(0);
  });
});
