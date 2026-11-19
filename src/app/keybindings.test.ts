import { describe, expect, it } from "vitest";
import { formatShortcut } from "../ui/shortcut";
import { type AppCommand, matchesShortcut } from "./commandTypes";
import { applyKeybindings, assign, canonical, conflictWith, refusal, remove, reset, shortcutFromEvent } from "./keybindings";
import { getCommands } from "./registry";

const cmd = (id: string, shortcut?: string, aliases?: string[]): AppCommand => ({
  id,
  title: id,
  group: "General",
  shortcut,
  aliases,
  run: () => {},
});
const base = [
  cmd("sync.push", "Mod+Shift+P"),
  cmd("view.zoomIn", "Mod+Plus", ["Mod+=", "Mod+Shift+="]),
  cmd("view.search", "Mod+F"),
  cmd("repo.x"),
];

type KeyEvent = Parameters<typeof shortcutFromEvent>[0];
const ev = (key: string, code: string, mods: Partial<Omit<KeyEvent, "key" | "code">> = {}): KeyEvent => ({
  key,
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("applyKeybindings", () => {
  it("merges overrides over the defaults", () => {
    const out = applyKeybindings(base, { "sync.push": ["Mod+Shift+K", "F9"], "view.zoomIn": null, "repo.x": ["Alt+X"] });
    expect(out.map((c) => [c.id, c.shortcut, c.aliases])).toEqual([
      ["sync.push", "Mod+Shift+K", ["F9"]],
      ["view.zoomIn", undefined, []],
      ["view.search", "Mod+F", undefined],
      ["repo.x", "Alt+X", []],
    ]);
    expect(out[2]).toBe(base[2]);
  });

  it("treats an empty list like removed", () => {
    expect(applyKeybindings(base, { "sync.push": [] })[0]).toMatchObject({ shortcut: undefined, aliases: [] });
  });

  it("unknown ids are ignored", () => {
    expect(applyKeybindings(base, { "gone.command": ["Mod+F"] })).toEqual(base);
  });
});

describe("canonical", () => {
  it("canonical order and Ctrl = Mod off macOS", () => {
    expect(canonical("shift+mod+p", "linux")).toBe("Mod+Shift+P");
    expect(canonical("Ctrl+K", "windows")).toBe("Mod+K");
    expect(canonical("Ctrl+K", "mac")).toBe("Ctrl+K");
    expect(canonical("Shift+Alt+Ctrl+Mod+x", "mac")).toBe("Mod+Ctrl+Alt+Shift+X");
    expect(canonical("Mod++", "linux")).toBe("Mod++");
  });
});

describe("conflicts", () => {
  it("finds the command that already has the combo, aliases included", () => {
    expect(conflictWith("Mod+=", "sync.push", base, "linux")?.id).toBe("view.zoomIn");
    expect(conflictWith("Ctrl+F", "sync.push", base, "windows")?.id).toBe("view.search");
    expect(conflictWith("Ctrl+F", "sync.push", base, "mac")).toBeNull();
    expect(conflictWith("Mod+Shift+P", "sync.push", base, "linux")).toBeNull();
  });

  it("assign anyway takes the key away from the other command", () => {
    const next = assign({}, "repo.x", "Mod+F", base, "linux");
    expect(next).toEqual({ "repo.x": ["Mod+F"], "view.search": null });
    const zoom = assign({}, "repo.x", "Mod+=", base, "linux");
    expect(zoom["view.zoomIn"]).toEqual(["Mod+Plus", "Mod+Shift+="]);
  });

  it("assign stores the canonical form and leaves the input untouched", () => {
    const before = { "sync.push": null };
    expect(assign(before, "repo.x", "shift+ctrl+j", base, "linux")).toEqual({ "sync.push": null, "repo.x": ["Mod+Shift+J"] });
    expect(before).toEqual({ "sync.push": null });
  });

  it("remove sets null, reset forgets the override", () => {
    expect(remove({ "sync.push": ["F9"] }, "sync.push")).toEqual({ "sync.push": null });
    expect(reset({ "sync.push": ["F9"], "repo.x": null }, "sync.push")).toEqual({ "repo.x": null });
  });
});

describe("refusal", () => {
  it("refuses plain keys, view keys, text editing and system keys with a reason", () => {
    expect(refusal("J", "linux", [])).toEqual({ kind: "plain" });
    expect(refusal("Shift+J", "linux", [])).toEqual({ kind: "plain" });
    expect(refusal("F6", "linux", [])).toBeNull();
    expect(refusal("Mod+S", "linux", [])).toMatchObject({ kind: "fixed" }); // conflict tool, file view
    expect(refusal("Mod+C", "linux", [])).toEqual({ kind: "text" });
    expect(refusal("Alt+F4", "windows", [])).toEqual({ kind: "system" });
    expect(refusal("Ctrl+Alt+T", "linux", [])).toEqual({ kind: "system" });
    expect(refusal("Ctrl+Alt+T", "windows", [])).toBeNull();
    expect(refusal("Mod+Q", "mac", [])).toEqual({ kind: "system" });
    expect(refusal("Mod+Q", "linux", [])).toBeNull();
    expect(refusal("Mod+F", "linux", ["Mod+F"])).toBeNull(); // own default stays valid
  });

  it("names the group and entry of a fixed key", () => {
    const fixed = refusal("Mod+Shift+V", "linux", []);
    expect(fixed?.kind).toBe("fixed");
    expect(fixed && "group" in fixed && fixed.group && fixed.label).toBeTruthy();
  });

  it("only defaults a view also handles itself are refused for other commands", () => {
    const refused = getCommands().flatMap((command) =>
      [command.shortcut, ...(command.aliases ?? [])].filter((key): key is string => Boolean(key) && refusal(key!, "linux", []) !== null),
    );
    expect(refused.sort()).toEqual(["Mod+.", "Mod+Alt+F", "Mod+Enter", "Mod+F", "Mod+Shift+Enter"]);
  });

  it("global commands that pass through a view are not fixed keys", () => {
    for (const key of ["F6", "Shift+F6", "Alt+1", "Alt+2", "Alt+3", "Mod+Shift+H"]) expect(refusal(key, "linux", []), key).toBeNull();
  });
});

describe("shortcutFromEvent", () => {
  const events: [KeyEvent, boolean, string | null][] = [
    [ev("P", "KeyP", { ctrlKey: true, shiftKey: true }), false, "Mod+Shift+P"],
    [ev("k", "KeyK", { metaKey: true }), true, "Mod+K"],
    [ev("k", "KeyK", { ctrlKey: true }), true, "Ctrl+K"],
    [ev("Shift", "ShiftLeft", { shiftKey: true }), false, null],
    [ev("Control", "ControlLeft", { ctrlKey: true }), false, null],
    [ev("F7", "F7", { altKey: true }), false, "Alt+F7"],
    // German layout: Shift+7 gives "/"
    [ev("/", "Digit7", { ctrlKey: true, shiftKey: true }), false, "Mod+/"],
    // AZERTY: the digit row gives "&" without Shift
    [ev("&", "Digit1", { ctrlKey: true }), false, "Mod+1"],
    [ev("1", "Digit1", { ctrlKey: true, shiftKey: true }), false, "Mod+Shift+1"],
    // macOS Option+K types "˚": the physical key counts
    [ev("˚", "KeyK", { altKey: true }), true, "Alt+K"],
    [ev(" ", "Space", { ctrlKey: true }), false, "Mod+Space"],
    [ev("+", "NumpadAdd", { ctrlKey: true }), false, "Mod++"],
    [ev("ArrowUp", "ArrowUp", { ctrlKey: true, shiftKey: true }), false, "Mod+Shift+ArrowUp"],
  ];

  it("records shortcuts per platform", () => {
    for (const [event, mac, expected] of events) expect(shortcutFromEvent(event, mac), event.key).toBe(expected);
  });

  it("ignores the Windows key and dead keys", () => {
    expect(shortcutFromEvent(ev("k", "KeyK", { metaKey: true }), false)).toBeNull();
    expect(shortcutFromEvent(ev("Dead", "Equal", { ctrlKey: true }), false)).toBeNull();
  });

  it("a recorded shortcut matches its own event", () => {
    for (const [event, mac, expected] of events) {
      if (!expected) continue;
      expect(matchesShortcut(event as KeyboardEvent, shortcutFromEvent(event, mac) ?? "", mac), expected).toBe(true);
    }
  });
});

it("shows Mod per platform", () => {
  expect(formatShortcut("Mod+Shift+K", { platform: "linux" })).toBe("Ctrl+Shift+K");
  expect(formatShortcut("Mod+Shift+K", { platform: "mac" })).toBe("⇧⌘K");
});
