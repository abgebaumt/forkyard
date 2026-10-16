import { describe, expect, it } from "vitest";
import { CoreError, type AiStatus, type PlanPreview, type PlanRunResult, type PlanStepView } from "../../../core";
import {
  afterRun,
  applyDraft,
  askMode,
  askQuery,
  checkView,
  classView,
  draftOf,
  escapeAction,
  footerKeys,
  offerAskRow,
  planErrorText,
  planKey,
  liveText,
  resultText,
  runBlocker,
  shiftConfirmed,
  stepProgress,
  stepTitle,
  withoutStep,
  type PlanPhase,
} from "./model";

const view = (patch: Partial<PlanStepView> & Pick<PlanStepView, "command" | "args">): PlanStepView => ({
  why: "",
  class: "local",
  destructive: false,
  fields: [],
  check: { status: "not_needed" },
  ...patch,
});
const plan = (steps: PlanStepView[], patch: Partial<PlanPreview> = {}): PlanPreview => ({ steps, note: null, blocked: false, expect: "e1", runnable: true, ...patch });
const key = (name: string, mods: { ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean } = {}) => ({ key: name, ctrlKey: false, metaKey: false, altKey: false, ...mods });
const previewPhase = (preview: PlanPreview, selected = 0, confirmed: number[] = [], busy = false): PlanPhase => ({ kind: "preview", text: "x", preview, selected, confirmed, busy });

const create = view({ command: "branchCreate", args: { name: "fix/größe", start: null, checkout: true }, fields: [{ name: "name", kind: "text", choices: [] }, { name: "start", kind: "optional_text", choices: [] }, { name: "checkout", kind: "boolean", choices: [] }] });
const push = view({ command: "push", args: { branch: "fix/größe", remote: "origin", force: false }, class: "outward", fields: [{ name: "branch", kind: "optional_text", choices: [] }, { name: "remote", kind: "optional_text", choices: [] }, { name: "force", kind: "boolean", choices: [] }] });
const pull = view({ command: "pull", args: { pullMode: null } });

describe("the ask row (spec Paket 5: “?” and the last row without matches)", () => {
  it("starts with “?” only while asking is possible", () => {
    expect(askQuery("?leg einen Branch an", true)).toBe("leg einen Branch an");
    expect(askQuery("?   ", true)).toBe("");
    expect(askQuery("?leg an", false)).toBeNull();
    expect(askQuery("leg an", true)).toBeNull();
    expect(askQuery(">?leg an", true)).toBeNull();
  });

  it("appears without a prefix only when nothing matched", () => {
    expect(offerAskRow(true, "all", "mach einen hotfix", 0)).toBe(true);
    expect(offerAskRow(true, "all", "mach einen hotfix", 1)).toBe(false);
    expect(offerAskRow(true, "commands", "mach einen hotfix", 0)).toBe(false);
    expect(offerAskRow(false, "all", "mach einen hotfix", 0)).toBe(false);
    expect(offerAskRow(true, "all", "   ", 0)).toBe(false);
  });
});

describe("keys in the plan preview", () => {
  it("moves the selection around and keeps Tab and modifiers out", () => {
    const phase = previewPhase(plan([create, push, pull]), 2);
    expect(planKey(phase, key("ArrowDown"))).toEqual({ kind: "select", index: 0 });
    expect(planKey(phase, key("ArrowUp"))).toEqual({ kind: "select", index: 1 });
    expect(planKey(phase, key("e", { ctrlKey: true }))).toEqual({ kind: "none" });
    expect(planKey(phase, key("Tab"))).toEqual({ kind: "none" });
    expect(planKey(previewPhase(plan([create]), 0, [], true), key("Enter")), "nothing while re-checking").toEqual({ kind: "none" });
  });

  it("E edits, Del removes, Space confirms only steps that go out", () => {
    const phase = previewPhase(plan([create, push, pull]), 0);
    expect(planKey(phase, key("e"))).toEqual({ kind: "edit", index: 0 });
    expect(planKey(phase, key("E"))).toEqual({ kind: "edit", index: 0 });
    expect(planKey(phase, key("Delete"))).toEqual({ kind: "remove", index: 0 });
    expect(planKey(phase, key(" ")), "a local step needs no own confirmation").toEqual({ kind: "none" });
    expect(planKey(previewPhase(plan([create, push]), 1), key(" "))).toEqual({ kind: "confirm", index: 1 });
    expect(planKey(previewPhase(plan([pull]), 0), key("e"))).toEqual({ kind: "notice", text: "This step has nothing to edit." });
  });

  it("Enter runs only a plan without blockers", () => {
    expect(planKey(previewPhase(plan([create, push]), 0, []), key("Enter"))).toEqual({ kind: "notice", text: "Step 2 goes out to the remote. Confirm it with Space first." });
    expect(planKey(previewPhase(plan([create, push]), 0, [1]), key("Enter"))).toEqual({ kind: "run" });
    expect(planKey({ kind: "result", text: "x", preview: plan([create]), confirmed: [], result: { steps: [], undoRecorded: false, completed: false, cancelled: false } }, key("Enter"))).toEqual({ kind: "close" });
  });

  it("names the first blocker", () => {
    expect(runBlocker(plan([create], { blocked: true }), [])).toBe("An operation is in progress. Finish or abort it first.");
    expect(runBlocker(plan([]), [])).toBe("The plan has no steps.");
    const conflicting = view({ command: "mergeStart", args: { source: "main", mergeMode: "default" }, check: { status: "conflicts", files: ["f.txt"] } });
    expect(runBlocker(plan([create, conflicting]), [])).toBe("Step 2 can’t run as it is. Edit it (E) or remove it (Del).");
    expect(runBlocker(plan([create, push]), [1])).toBeNull();
  });

  it("Esc depends on the phase; the text stays", () => {
    expect(escapeAction({ kind: "loading", text: "x", jobId: "j", startedAt: 0 })).toBe("cancelRequest");
    expect(escapeAction({ kind: "running", text: "x", preview: plan([create]), confirmed: [], jobId: "j", startedAt: 0 })).toBe("cancelRun");
    expect(escapeAction({ kind: "editing", text: "x", preview: plan([create]), selected: 0, confirmed: [], draft: {} })).toBe("endEdit");
    expect(escapeAction(previewPhase(plan([create])))).toBe("back");
    expect(escapeAction({ kind: "failed", text: "x", error: null })).toBe("back");
    expect(escapeAction({ kind: "idle" })).toBe("none");
  });

  it("shows the keys that work right now", () => {
    expect(footerKeys(previewPhase(plan([create, push]), 1)).map(([k]) => k)).toEqual(["↑↓", "Enter", "E", "Del", "Space", "Esc"]);
    expect(footerKeys(previewPhase(plan([create, push]), 0)).map(([k]) => k)).toEqual(["↑↓", "Enter", "E", "Del", "Esc"]);
    expect(footerKeys({ kind: "loading", text: "x", jobId: "j", startedAt: 0 })).toEqual([["Esc", "cancel"]]);
  });
});

describe("words of a step", () => {
  it("titles name what happens, with short SHAs", () => {
    expect(stepTitle(create)).toBe("Create branch “fix/größe” at HEAD and check it out");
    expect(stepTitle(view({ command: "push", args: { branch: "main", remote: "origin", force: true } }))).toBe("Push main to origin with force (with lease)");
    expect(stepTitle(view({ command: "push", args: { branch: null, remote: null, force: false } }))).toBe("Push the current branch to its upstream");
    expect(stepTitle(view({ command: "cherryPick", args: { commits: ["1234567890abcdef1234567890abcdef12345678", "abcdef0"] } }))).toBe("Cherry-pick 1234567, abcdef0");
    expect(stepTitle(view({ command: "resetBranch", args: { target: "v1.0", resetMode: "hard" } }))).toBe("Reset the current branch to v1.0 (hard – discards changes)");
    expect(stepTitle(view({ command: "branchDeleteRemote", args: { remote: "origin", name: "alt" } }))).toBe("Delete branch “alt” on origin");
  });

  it("class, check and outcome are a word and a tone, never a colour alone", () => {
    expect(classView(push)).toEqual({ word: "goes out", tone: "danger" });
    expect(classView(view({ command: "branchDelete", args: { name: "x", force: false }, destructive: true }))).toEqual({ word: "destructive", tone: "danger" });
    expect(classView(create)).toEqual({ word: "local", tone: "muted" });
    expect(checkView({ status: "conflicts", files: ["f.txt", "g h.txt"] })).toEqual({ word: "conflicts", tone: "danger", detail: "f.txt, g h.txt" });
    expect(checkView({ status: "unknown", reason: "The result depends on what step 2 does." })).toEqual({ word: "not checked", tone: "warning", detail: "The result depends on what step 2 does." });
    expect(checkView({ status: "not_needed" }).word).toBe("");
    expect(checkView({ status: "clean" })).toEqual({ word: "no conflicts", tone: "success", detail: null });
  });
});

describe("editing and removing steps", () => {
  it("a draft round-trips; lists split at commas only, empty optionals become null", () => {
    const stash = view({
      command: "stashCreate",
      args: { message: null, includeUntracked: true, paths: ["notizen/über uns.md"] },
      fields: [{ name: "message", kind: "optional_text", choices: [] }, { name: "includeUntracked", kind: "boolean", choices: [] }, { name: "paths", kind: "list", choices: [] }],
    });
    const draft = draftOf(stash);
    expect(draft).toEqual({ message: "", includeUntracked: true, paths: "notizen/über uns.md" });
    expect(applyDraft(stash, { ...draft, paths: "notizen/über uns.md, b.txt ,", message: "  " })).toEqual({
      command: "stashCreate",
      args: { message: null, includeUntracked: true, paths: ["notizen/über uns.md", "b.txt"] },
      why: "",
    });
    expect(applyDraft(create, { name: " hotfix-2 ", start: "", checkout: false }).args).toEqual({ name: "hotfix-2", start: null, checkout: false });
  });

  it("removing a step keeps the other confirmations on their steps", () => {
    expect(withoutStep(plan([create, push, pull]), 1).map((s) => s.command)).toEqual(["branchCreate", "pull"]);
    expect(withoutStep(plan([create]), 0)[0]).toBeUndefined();
    expect(shiftConfirmed([0, 2, 3], 2)).toEqual([0, 2]);
    expect(shiftConfirmed([1], 0)).toEqual([0]);
  });
});

describe("errors of the plan request", () => {
  it("a long plan and an expired plan have their own words", () => {
    const long = new CoreError({ code: "ai_invalid_answer", message: "The AI's answer could not be used (plan too long: at most 10 steps).", gitOutput: null });
    expect(planErrorText(long)).toBe("Plan too long – at most 10 steps. Ask for less at once.");
    const stale = new CoreError({ code: "stale_state", message: "The repository changed since the plan was shown. The plan has expired; ask again.", gitOutput: null });
    expect(planErrorText(stale)).toBe("The repository changed since the plan was shown. The plan has expired – ask again.");
    expect(planErrorText(new CoreError({ code: "cancelled", message: "Cancelled.", gitOutput: null }))).toBe("");
  });
});

describe("when the palette offers asking (spec 1.3: unset / off / on)", () => {
  const status = (patch: Partial<AiStatus>): AiStatus => ({
    state: "on",
    provider: "ollama",
    model: "qwen3:8b",
    connected: true,
    keyHint: null,
    local: true,
    price: null,
    introPending: false,
    featuresOff: [],
    ...patch,
  });

  it("asks only with AI on, for this function, this repository and in a repository tab", () => {
    expect(askMode(status({}), false, true)).toBe("ask");
    expect(askMode(status({ state: "unset", provider: null, model: null, connected: false }), false, true), "not set up").toBe("hidden");
    expect(askMode(status({ state: "off" }), false, true), "switched off").toBe("hidden");
    expect(askMode(status({ featuresOff: ["plan"] }), false, true), "this function off").toBe("hidden");
    expect(askMode(status({ featuresOff: ["commit_message"] }), false, true), "another function off").toBe("ask");
    expect(askMode(status({}), true, true), "AI off for this repository").toBe("hidden");
    expect(askMode(status({}), false, false), "no repository tab").toBe("hidden");
    expect(askMode(undefined, false, true), "status not loaded yet").toBe("hidden");
  });

  it("with AI on but no provider connected the row opens the setup instead of sending", () => {
    expect(askMode(status({ provider: null, model: null, connected: false }), false, true)).toBe("setup");
  });
});

describe("running and the result", () => {
  const result = (statuses: ("done" | "failed" | "not_run")[], patch: Partial<PlanRunResult> = {}): PlanRunResult => ({
    steps: statuses.map((status, index) => ({ index, status, error: status === "failed" ? { code: "nothing_to_commit", message: "There are no changes to stash.", gitOutput: null } : null })),
    undoRecorded: statuses.includes("done"),
    completed: statuses.every((status) => status === "done"),
    cancelled: false,
    ...patch,
  });

  it("reads the step counter of the job", () => {
    expect(stepProgress("2/4")).toEqual({ n: 2, total: 4 });
    expect(stepProgress("")).toBeNull();
    expect(stepProgress("x/4")).toBeNull();
  });

  it("a finished plan closes the palette with a toast; a stopped one stays to show why", () => {
    expect(afterRun(result(["done", "done", "done"]))).toEqual({ close: true, toast: "Plan done: 3 steps" });
    expect(afterRun(result(["done"]))).toEqual({ close: true, toast: "Plan done: 1 step" });
    expect(afterRun(result(["done", "failed", "not_run"])).close).toBe(false);
  });

  it("says where the plan stopped and what Mod+Z does", () => {
    expect(resultText(result(["done", "failed", "not_run"]))).toContain("stopped at step 2");
    expect(resultText(result(["done", "failed", "not_run"]))).toContain("takes them back");
    expect(resultText(result(["failed", "not_run"]))).toBe("Step 1 failed; nothing was changed.");
    expect(resultText(result(["done", "not_run"], { cancelled: true }))).toContain("Cancelled. The steps already done stay done");
    expect(resultText(result(["not_run", "not_run"], { cancelled: true }))).toBe("Cancelled; nothing was changed.");
  });

  it("announces a ready plan politely", () => {
    expect(liveText(previewPhase(plan([create, push])))).toBe("Plan with 2 steps ready");
    expect(liveText(previewPhase(plan([create]), 0, [], true))).toBe("");
    expect(liveText({ kind: "loading", text: "x", jobId: "j", startedAt: 0 })).toBe("");
  });
});
