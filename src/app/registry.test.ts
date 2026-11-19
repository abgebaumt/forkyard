import { afterEach, describe, expect, it, vi } from "vitest";

// No DOM in the tests: `window` is a plain event target (stubbed after the imports), and React's hooks run without a renderer
// (an effect runs at once, an external store re-runs the hook on every notification). Their cleanups run after each test.

let rendering: { subscribed: boolean; render: () => void } | null = null;
const cleanups: (() => void)[] = [];
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useEffect: (effect: () => (() => void) | undefined) => {
    const cleanup = effect();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  },
  useSyncExternalStore: <T>(subscribe: (listener: () => void) => () => void, snapshot: () => T): T => {
    const hook = rendering!;
    if (!hook.subscribed) {
      hook.subscribed = true;
      cleanups.push(subscribe(hook.render));
    }
    return snapshot();
  },
}));

function renderHook<T>(hook: () => T): { current: T } {
  const result = {} as { current: T };
  const state = {
    subscribed: false,
    render: () => {
      rendering = state;
      result.current = hook();
      rendering = null;
    },
  };
  state.render();
  return result;
}

const { commandShortcut, getBaseCommands, registerCommands, setKeybindings, useCommandShortcut, useGlobalShortcuts, useKeybindings } =
  await import("./registry");
vi.stubGlobal("window", new EventTarget());
vi.stubGlobal("document", { querySelector: () => null });
vi.stubGlobal("HTMLElement", class {});

function press(init: Partial<KeyboardEvent>) {
  const event = Object.assign(new Event("keydown", { cancelable: true }), {
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    code: "",
    ...init,
  });
  window.dispatchEvent(event);
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  setKeybindings({});
});

describe("registry with own shortcuts", () => {
  it("the effective shortcut runs, the old one does not", async () => {
    const run = vi.spyOn(getBaseCommands().find((command) => command.id === "app.preferences")!, "run").mockImplementation(() => {});
    setKeybindings({ "app.preferences": ["Mod+Shift+F9"] });
    expect(commandShortcut("app.preferences")).toBe("Mod+Shift+F9");
    renderHook(() => useGlobalShortcuts(false));
    press({ key: ",", code: "Comma", ctrlKey: true });
    await new Promise((resolve) => setTimeout(resolve));
    expect(run).not.toHaveBeenCalled();
    press({ key: "F9", code: "F9", ctrlKey: true, shiftKey: true });
    await new Promise((resolve) => setTimeout(resolve));
    expect(run).toHaveBeenCalledTimes(1);
    run.mockRestore();
  });

  it("Windows AltGr typing a character does not fire a stored Ctrl+Alt shortcut", async () => {
    const run = vi.spyOn(getBaseCommands().find((command) => command.id === "app.preferences")!, "run").mockImplementation(() => {});
    setKeybindings({ "app.preferences": ["Mod+Alt+Q"] });
    renderHook(() => useGlobalShortcuts(false));
    // German layout: AltGr+Q types "@"
    press({ key: "@", code: "KeyQ", ctrlKey: true, altKey: true });
    await new Promise((resolve) => setTimeout(resolve));
    expect(run).not.toHaveBeenCalled();
    press({ key: "q", code: "KeyQ", ctrlKey: true, altKey: true });
    await new Promise((resolve) => setTimeout(resolve));
    expect(run).toHaveBeenCalledTimes(1);
    run.mockRestore();
  });

  it("overrides apply to commands registered later", () => {
    setKeybindings({ "custom.demo": ["Alt+F9"] });
    const stop = registerCommands([{ id: "custom.demo", title: "Demo", group: "Repository", run: vi.fn() }]);
    expect(commandShortcut("custom.demo")).toBe("Alt+F9");
    stop();
    expect(commandShortcut("custom.demo")).toBeUndefined();
    const again = registerCommands([{ id: "custom.demo", title: "Demo", group: "Repository", run: vi.fn() }]);
    expect(commandShortcut("custom.demo")).toBe("Alt+F9");
    again();
  });

  it("reset brings the declared shortcut back", () => {
    setKeybindings({ "app.preferences": null });
    expect(commandShortcut("app.preferences")).toBeUndefined();
    setKeybindings({});
    expect(commandShortcut("app.preferences")).toBe("Mod+,");
  });

  it("useCommandShortcut re-renders on a change", () => {
    const shortcut = renderHook(() => useCommandShortcut("tab.new"));
    expect(shortcut.current).toBe("Mod+T");
    setKeybindings({ "tab.new": ["Mod+Alt+N"] });
    expect(shortcut.current).toBe("Mod+Alt+N");
  });

  it("useKeybindings applies the setting, and no setting yet means the declared shortcuts", () => {
    setKeybindings({ "tab.new": ["Mod+Alt+N"] });
    renderHook(() => useKeybindings(undefined));
    expect(commandShortcut("tab.new")).toBe("Mod+T");
    renderHook(() => useKeybindings({ "tab.new": null }));
    expect(commandShortcut("tab.new")).toBeUndefined();
  });
});
