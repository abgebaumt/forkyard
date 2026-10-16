import { describe, expect, it } from "vitest";
import { EMPTY_TABS, STATE_TONE, addProgram, addShell, closeEntry, neighbour, selectEntry, sessionState } from "./tabsModel";

const title = (n: number) => (n === 1 ? "Shell" : `Shell ${n}`);

describe("terminal tabs", () => {
  it("numbers shells, keeps program titles and reuses the number of a closed shell", () => {
    let tabs = addShell(EMPTY_TABS, "a", title);
    tabs = addShell(tabs, "b", title);
    tabs = addProgram(tabs, "c", "fix-login");
    expect(tabs.entries.map((entry) => entry.title)).toEqual(["Shell", "Shell 2", "fix-login"]);
    expect(tabs.active).toBe("c");
    tabs = closeEntry(tabs, "a");
    tabs = addShell(tabs, "d", title);
    expect(tabs.entries.map((entry) => [entry.key, entry.title])).toEqual([
      ["b", "Shell 2"],
      ["c", "fix-login"],
      ["d", "Shell"],
    ]);
    expect(EMPTY_TABS.entries).toEqual([]);
  });

  it("closing the shown tab shows its right neighbour, else the left one, else nothing", () => {
    let tabs = addShell(addShell(addShell(EMPTY_TABS, "a", title), "b", title), "c", title);
    tabs = selectEntry(tabs, "b");
    tabs = closeEntry(tabs, "b");
    expect(tabs.active).toBe("c");
    tabs = closeEntry(tabs, "c");
    expect(tabs.active).toBe("a");
    tabs = closeEntry(tabs, "a");
    expect(tabs).toEqual({ entries: [], active: null });
  });

  it("closing a hidden tab keeps the shown one; unknown keys change nothing", () => {
    const tabs = addShell(addShell(EMPTY_TABS, "a", title), "b", title);
    expect(closeEntry(tabs, "a").active).toBe("b");
    expect(closeEntry(tabs, "x")).toBe(tabs);
    expect(selectEntry(tabs, "x")).toBe(tabs);
    expect(selectEntry(tabs, "b")).toBe(tabs);
    expect(selectEntry(tabs, "a").active).toBe("a");
  });

  it("arrow keys wrap around", () => {
    const tabs = addShell(addShell(addShell(EMPTY_TABS, "a", title), "b", title), "c", title);
    expect(neighbour(tabs, "c", 1)).toBe("a");
    expect(neighbour(tabs, "a", -1)).toBe("c");
    expect(neighbour(tabs, "a", 1)).toBe("b");
    expect(neighbour(EMPTY_TABS, "a", 1)).toBeNull();
  });

  it("a tab shows its state as a word with a colour", () => {
    expect(sessionState("shell", { kind: "starting" })).toBe("starting");
    expect(sessionState("shell", { kind: "running" })).toBe("running");
    expect(sessionState("shell", { kind: "exited", code: 3 })).toBe("exited");
    expect(sessionState("program", { kind: "exited", code: 0 })).toBe("done");
    expect(sessionState("program", { kind: "exited", code: 1 })).toBe("failed");
    expect(sessionState("program", { kind: "exited", code: null })).toBe("failed");
    expect(sessionState("program", { kind: "running" }, true)).toBe("waiting");
    expect(sessionState("shell", { kind: "failed" })).toBe("failed");
    // Spec, "Gemeinsame UI-Regeln": running = accent, waiting = warning, done = success, error = danger, ended = muted.
    expect(STATE_TONE).toEqual({ starting: "accent", running: "accent", waiting: "warning", done: "success", failed: "danger", exited: "muted" });
  });
});
