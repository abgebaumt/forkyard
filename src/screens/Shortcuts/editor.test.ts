import { describe, expect, it } from "vitest";
import type { AppCommand } from "../../app/commandTypes";
import { assignKey, onRecordKey, type RecordState } from "./editor";

const command = (id: string, shortcut?: string): AppCommand =>
  ({ id, title: `Title ${id}`, group: "General", shortcut, run: () => undefined }) as AppCommand;
const base = [command("sync.push", "Mod+Shift+U"), command("branch.create", "Mod+B")];
const ctx = { effective: base, base, platform: "linux" as const };
const recording: RecordState = { kind: "recording", commandId: "sync.push" };

describe("recording a shortcut", () => {
  it("Escape cancels without a change", () => {
    expect(onRecordKey({ kind: "recording", commandId: "sync.push" }, null, "Escape", ctx)).toEqual({
      state: { kind: "idle" },
      action: { kind: "none" },
    });
    expect(onRecordKey(recording, "Escape", "Escape", ctx).state, "as shortcutFromEvent reports it").toEqual({ kind: "idle" });
  });

  it("Backspace removes the shortcut", () => {
    expect(onRecordKey(recording, null, "Backspace", ctx).action).toEqual({ kind: "remove" });
    expect(onRecordKey(recording, "Backspace", "Backspace", ctx)).toEqual({ state: { kind: "idle" }, action: { kind: "remove" } });
  });

  it("a free combination is set at once", () => {
    expect(onRecordKey(recording, "Mod+Alt+K", "k", ctx)).toEqual({ state: { kind: "idle" }, action: { kind: "set", combo: "Mod+Alt+K" } });
  });

  it("a taken combination asks with the other command's name", () => {
    expect(onRecordKey(recording, "Mod+B", "b", ctx).state).toMatchObject({
      kind: "conflict",
      combo: "Mod+B",
      other: { id: "branch.create", title: "Title branch.create" },
    });
  });

  it("the command's own key is no conflict", () => {
    expect(onRecordKey(recording, "Mod+Shift+U", "U", ctx).action).toEqual({ kind: "set", combo: "Mod+Shift+U" });
  });

  it("a reserved combination is refused with the reason", () => {
    expect(onRecordKey(recording, "Mod+C", "c", ctx).state).toMatchObject({ kind: "refused", reason: { kind: "text" } });
  });

  it("after a refusal the next key is recorded again", () => {
    const refused = onRecordKey(recording, "Mod+C", "c", ctx).state;
    expect(onRecordKey(refused, "Mod+Alt+K", "k", ctx).action).toEqual({ kind: "set", combo: "Mod+Alt+K" });
  });

  it("a lone modifier keeps recording", () => {
    expect(onRecordKey(recording, null, "Shift", ctx)).toEqual({ state: recording, action: { kind: "none" } });
  });

  it("while asking about a conflict only Escape counts", () => {
    const conflict = onRecordKey(recording, "Mod+B", "b", ctx).state;
    expect(onRecordKey(conflict, "Mod+Alt+K", "k", ctx)).toEqual({ state: conflict, action: { kind: "none" } });
    expect(onRecordKey(conflict, "Escape", "Escape", ctx).state).toEqual({ kind: "idle" });
  });
});

describe("assigning a recorded shortcut", () => {
  it("the command's own default resets instead of writing an equal override", () => {
    expect(assignKey({ "sync.push": ["Mod+Alt+K"], other: null }, "sync.push", "Mod+Shift+U", ctx)).toEqual({ other: null });
  });

  it("another key is stored and taken from the command that had it", () => {
    expect(assignKey({}, "sync.push", "Mod+B", ctx)).toEqual({ "sync.push": ["Mod+B"], "branch.create": null });
  });
});
