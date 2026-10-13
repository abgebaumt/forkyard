import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it } from "vitest";
import { matchesShortcut } from "./commandTypes";
import { invalidateRepo, qk } from "./queries";
import { getCommands } from "./registry";
import { defaultTabView, isLeftCollapsed, PANEL_LIMITS, useAppStore } from "./store";
import { versionAtLeast } from "./App";

function key(init: Partial<KeyboardEvent> & { key: string; code: string }): KeyboardEvent {
  return { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...init } as KeyboardEvent;
}

describe("Shortcuts", () => {
  it("Mod is Ctrl on Windows/Linux and Cmd on macOS", () => {
    expect(matchesShortcut(key({ key: "t", code: "KeyT", ctrlKey: true }), "Mod+T", false)).toBe(true);
    expect(matchesShortcut(key({ key: "t", code: "KeyT", ctrlKey: true }), "Mod+T", true)).toBe(false);
    expect(matchesShortcut(key({ key: "t", code: "KeyT", metaKey: true }), "Mod+T", true)).toBe(true);
  });

  it("Shift must match for letters", () => {
    expect(matchesShortcut(key({ key: "Z", code: "KeyZ", ctrlKey: true, shiftKey: true }), "Mod+Z", false)).toBe(false);
    expect(matchesShortcut(key({ key: "Z", code: "KeyZ", ctrlKey: true, shiftKey: true }), "Mod+Shift+Z", false)).toBe(true);
  });

  it("letters by layout (German: Z is on KeyY)", () => {
    expect(matchesShortcut(key({ key: "z", code: "KeyY", ctrlKey: true }), "Mod+Z", false)).toBe(true);
    expect(matchesShortcut(key({ key: "z", code: "KeyY", ctrlKey: true }), "Mod+Y", false)).toBe(false);
  });

  it("Alt+O on macOS yields a special character but counts via the physical key", () => {
    expect(matchesShortcut(key({ key: "ø", code: "KeyO", altKey: true }), "Alt+O", true)).toBe(true);
  });

  it("punctuation on a German keyboard: Ctrl+/ is Ctrl+Shift+7, Ctrl+= is Ctrl+Shift+0", () => {
    expect(matchesShortcut(key({ key: "/", code: "Digit7", ctrlKey: true, shiftKey: true }), "Mod+/", false)).toBe(true);
    expect(matchesShortcut(key({ key: "=", code: "Digit0", ctrlKey: true, shiftKey: true }), "Mod+=", false)).toBe(true);
    // The same key must then not additionally trigger "Reset zoom"
    expect(matchesShortcut(key({ key: "=", code: "Digit0", ctrlKey: true, shiftKey: true }), "Mod+0", false)).toBe(false);
    expect(matchesShortcut(key({ key: "0", code: "Digit0", ctrlKey: true }), "Mod+0", false)).toBe(true);
  });

  it("digits via the key code, also on the numpad", () => {
    expect(matchesShortcut(key({ key: "1", code: "Digit1", ctrlKey: true }), "Mod+1", false)).toBe(true);
    expect(matchesShortcut(key({ key: "End", code: "Numpad1", ctrlKey: true }), "Mod+1", false)).toBe(true);
  });

  it("Ctrl+Tab as a named key", () => {
    expect(matchesShortcut(key({ key: "Tab", code: "Tab", ctrlKey: true }), "Ctrl+Tab", false)).toBe(true);
    expect(matchesShortcut(key({ key: "Tab", code: "Tab", ctrlKey: true, shiftKey: true }), "Ctrl+Tab", false)).toBe(false);
  });
});

describe("Git version", () => {
  it("compares numerically and ignores suffixes", () => {
    expect(versionAtLeast("2.45.1.windows.1", "2.39")).toBe(true);
    expect(versionAtLeast("2.39.0", "2.39")).toBe(true);
    expect(versionAtLeast("2.38.5", "2.39")).toBe(false);
    expect(versionAtLeast("2.100.0", "2.39")).toBe(true);
  });
});

describe("Store", () => {
  beforeEach(() => {
    useAppStore.setState({ views: {}, jobs: {}, credentialQueue: [], busy: {}, narrow: false, narrowLeftOpen: false, overlay: null });
  });

  it("multi-selection remembers the order; the last one is active", () => {
    const store = useAppStore.getState();
    store.selectCommits("t1", ["a"]);
    store.toggleCommit("t1", "b");
    store.toggleCommit("t1", "c");
    store.toggleCommit("t1", "b");
    expect(useAppStore.getState().views.t1?.selection).toEqual({ kind: "commits", shas: ["a", "c"] });
  });

  it("selecting a stash with its SHA asks the graph to scroll to the stash row", () => {
    const store = useAppStore.getState();
    store.selectStash("t1", 2, "abc123");
    const view = useAppStore.getState().views.t1;
    expect(view?.selection).toEqual({ kind: "stash", index: 2 });
    expect(view?.reveal).toMatchObject({ sha: "abc123", key: "stash:2" });
    store.selectStash("t1", 1);
    expect(useAppStore.getState().views.t1?.reveal).toBe(view?.reveal);
  });

  it("Left Panel collapses in a narrow window and can still be opened", () => {
    const store = useAppStore.getState();
    store.setNarrow(true);
    const view = () => useAppStore.getState().views.t1 ?? defaultTabView();
    expect(isLeftCollapsed(view(), useAppStore.getState())).toBe(true);
    store.toggleLeftPanel("t1");
    expect(isLeftCollapsed(view(), useAppStore.getState())).toBe(false);
    store.toggleLeftPanel("t1");
    expect(isLeftCollapsed(view(), useAppStore.getState())).toBe(true);
    // Back in a wide window: open again, because the user never collapsed it themselves
    store.setNarrow(false);
    expect(isLeftCollapsed(view(), useAppStore.getState())).toBe(false);
  });

  it("panel widths stay within their limits", () => {
    const store = useAppStore.getState();
    store.setLeftWidth(10);
    store.setRightWidth(5000);
    expect(useAppStore.getState().leftWidth).toBe(PANEL_LIMITS.left.min);
    expect(useAppStore.getState().rightWidth).toBe(PANEL_LIMITS.right.max);
  });

  it("jobs from events and the credentials queue", () => {
    const store = useAppStore.getState();
    store.startJob({ id: "j1", title: "Push", repoId: "r" });
    store.updateJob({ jobId: "j1", repoId: "r", phase: "Schreiben", percent: 40, line: "Writing objects: 40%" });
    store.updateJob({ jobId: "j2", repoId: null, phase: "Fetch", percent: null, line: "" });
    expect(useAppStore.getState().jobs.j1).toMatchObject({ title: "Push", percent: 40 });
    expect(useAppStore.getState().jobs.j2?.title).toBe("Fetch");
    store.finishJob("j1");
    expect(useAppStore.getState().jobs.j1).toBeUndefined();

    const request = { requestId: "q", kind: "password" as const, host: "h", username: null, detail: null, prompt: "", canRemember: false };
    store.enqueueCredential(request);
    store.enqueueCredential(request);
    expect(useAppStore.getState().credentialQueue).toHaveLength(1);
    store.resolveCredential("q");
    expect(useAppStore.getState().credentialQueue).toHaveLength(0);
  });
});

describe("Invalidation after repo:changed", () => {
  function seeded() {
    const client = new QueryClient();
    const r = "r1";
    const keys = {
      status: qk.status(r),
      refs: qk.refs(r),
      graph: qk.graph(r),
      stashes: qk.stashes(r),
      remotes: qk.remotes(r),
      undo: qk.undo(r),
      repoSettings: qk.repoSettings(r),
      diffUnstaged: qk.diff(r, "a.txt", { kind: "unstaged" }),
      diffCommit: qk.diff(r, "a.txt", { kind: "commit", sha: "abc" }),
      commitDetails: qk.commitDetails(r, { kind: "commit", sha: "abc" }),
      fileWorktree: qk.file(r, "a.txt", null),
      fileCommit: qk.file(r, "a.txt", "abc"),
      otherRepo: qk.status("r2"),
    };
    for (const value of Object.values(keys)) client.setQueryData(value, 1);
    const invalid = () =>
      Object.entries(keys)
        .filter(([, value]) => client.getQueryState(value)?.isInvalidated)
        .map(([name]) => name)
        .sort();
    return { client, invalid };
  }

  it("worktree/index → status, working directory diffs and undo (discard creates an entry)", async () => {
    const { client, invalid } = seeded();
    await invalidateRepo(client, "r1", ["worktree"]);
    expect(invalid()).toEqual(["diffUnstaged", "fileWorktree", "status", "undo"]);
  });

  it("refs/head → refs, graph, status, undo", async () => {
    const { client, invalid } = seeded();
    await invalidateRepo(client, "r1", ["head"]);
    expect(invalid()).toEqual(["diffUnstaged", "fileWorktree", "graph", "refs", "status", "undo"]);
  });

  it("stash → stashes and graph; config → remotes and repo settings", async () => {
    const first = seeded();
    await invalidateRepo(first.client, "r1", ["stash"]);
    expect(first.invalid()).toEqual(["graph", "stashes", "undo"]);
    const second = seeded();
    await invalidateRepo(second.client, "r1", ["config"]);
    expect(second.invalid()).toEqual(["refs", "remotes", "repoSettings"]);
  });
});

describe("Command registry", () => {
  it("collects the shell commands with their shortcuts", () => {
    const byId = new Map(getCommands().map((command) => [command.id, command]));
    const expected: Record<string, string> = {
      "tab.new": "Mod+T",
      "tab.close": "Mod+W",
      "tab.goto.1": "Mod+1",
      "tab.goto.9": "Mod+9",
      "view.toggleLeftPanel": "Mod+J",
      "view.toggleCommitPanel": "Mod+K",
      "app.palette": "Mod+P",
      "view.search": "Mod+F",
      "app.preferences": "Mod+,",
      "app.shortcuts": "Mod+/",
      "view.zoomIn": "Mod++",
      "view.zoomOut": "Mod+-",
      "view.zoomReset": "Mod+0",
      "repo.open": "Alt+O",
    };
    for (const [id, shortcut] of Object.entries(expected)) expect(byId.get(id)?.shortcut, id).toBe(shortcut);
  });

  it("no shortcut is assigned twice", () => {
    const seen = new Map<string, string>();
    for (const command of getCommands()) {
      for (const shortcut of [command.shortcut, ...(command.aliases ?? [])]) {
        if (!shortcut) continue;
        expect(seen.get(shortcut), `${shortcut}: ${command.id} and ${seen.get(shortcut)}`).toBeUndefined();
        seen.set(shortcut, command.id);
      }
    }
  });
});
