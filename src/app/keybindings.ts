/**
 * Own keyboard shortcuts (setting `keybindings`: command id → shortcuts, `null` = no key).
 * Pure logic: canonical form, merging over the registry defaults, conflicts, reserved keys and
 * turning a KeyboardEvent into shortcut notation. Notation as in `commandTypes.ts`.
 */
import { fixedKeyGroups } from "../screens/Shortcuts/fixedKeys";
import type { ShortcutPlatform } from "../ui/shortcut";
import { type AppCommand, parseShortcut } from "./commandTypes";

export type Keybindings = Record<string, string[] | null>;

const NAMED_KEYS = [
  "Enter",
  "Escape",
  "Tab",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Space",
  "ContextMenu",
  "Plus",
];
const NAMED_BY_LOWER = new Map(NAMED_KEYS.map((key) => [key.toLowerCase(), key]));

/** Named keys in `KeyboardEvent.key` spelling ("escape" → "Escape", "f7" → "F7"). */
function namedKey(key: string): string {
  if (key.length === 1) return key;
  if (/^f\d{1,2}$/i.test(key)) return key.toUpperCase();
  return NAMED_BY_LOWER.get(key.toLowerCase()) ?? key;
}

/** Modifiers in the order Mod, Ctrl, Alt, Shift, then the key; Ctrl is Mod off macOS. */
export function canonical(shortcut: string, platform: ShortcutPlatform): string {
  const parsed = parseShortcut(shortcut);
  const mac = platform === "mac";
  const parts: string[] = [];
  if (parsed.mod || (parsed.ctrl && !mac)) parts.push("Mod");
  if (parsed.ctrl && mac) parts.push("Ctrl");
  if (parsed.alt) parts.push("Alt");
  if (parsed.shift) parts.push("Shift");
  parts.push(/^[a-z]$/.test(parsed.key) ? parsed.key.toUpperCase() : namedKey(parsed.key));
  return parts.join("+");
}

/** The overridden commands as new objects (list[0] shown, the rest aliases); the others unchanged. */
export function applyKeybindings(base: readonly AppCommand[], overrides: Keybindings): AppCommand[] {
  return base.map((command) => {
    if (!Object.hasOwn(overrides, command.id)) return command;
    const keys = overrides[command.id] ?? [];
    return { ...command, shortcut: keys[0], aliases: keys.slice(1) };
  });
}

/** Every key of a command (also one after `applyKeybindings`): the shown one first, then the aliases. */
export function defaultKeys(command: AppCommand): string[] {
  return [command.shortcut, ...(command.aliases ?? [])].filter((key): key is string => Boolean(key));
}

export type Refusal = { kind: "plain" } | { kind: "fixed"; group: string; label: string } | { kind: "text" } | { kind: "system" };

const TEXT_KEYS = ["Mod+A", "Mod+C", "Mod+V", "Mod+X"];

// Mod+Space off macOS: input method switch.
const DESKTOP_SYSTEM_KEYS = ["Alt+F4", "Alt+Tab", "Ctrl+Alt+Delete", "Ctrl+Alt+ArrowLeft", "Ctrl+Alt+ArrowRight"];
// Alt+Space: the window menu on Windows and Linux, a non-breaking space on macOS. Cmd+Shift+3/4/5: macOS screenshots.
const SYSTEM_KEYS: Record<ShortcutPlatform, string[]> = {
  windows: [...DESKTOP_SYSTEM_KEYS, "Mod+Space", "Alt+Space"],
  linux: [...DESKTOP_SYSTEM_KEYS, "Mod+Space", "Alt+Space", "Ctrl+Alt+T"],
  mac: ["Mod+Q", "Mod+H", "Mod+M", "Mod+Tab", "Mod+Space", "Alt+Space", "Mod+Alt+Escape", "Mod+Shift+3", "Mod+Shift+4", "Mod+Shift+5"],
};

/** Why a combination cannot be assigned at all; `null` if it can. A command's own defaults always can. */
export function refusal(combo: string, platform: ShortcutPlatform, ownDefaults: readonly string[]): Refusal | null {
  const key = canonical(combo, platform);
  const same = (other: string) => canonical(other, platform) === key;
  if (ownDefaults.some(same)) return null;
  const parsed = parseShortcut(key);
  if (!parsed.mod && !parsed.ctrl && !parsed.alt && !/^F([1-9]|1\d|2[0-4])$/.test(parsed.key)) return { kind: "plain" };
  for (const group of fixedKeyGroups) {
    const entry = group.entries.find((e) => !e.commands && e.keys.some(same));
    if (entry) return { kind: "fixed", group: group.title, label: entry.label };
  }
  if (TEXT_KEYS.some(same)) return { kind: "text" };
  if (SYSTEM_KEYS[platform].some(same)) return { kind: "system" };
  return null;
}

/** Another command that already has the combination (shown key or alias). */
export function conflictWith(
  combo: string,
  commandId: string,
  effective: readonly AppCommand[],
  platform: ShortcutPlatform,
): AppCommand | null {
  const key = canonical(combo, platform);
  return effective.find((c) => c.id !== commandId && defaultKeys(c).some((k) => canonical(k, platform) === key)) ?? null;
}

/** Gives the command exactly this combination and takes it away from every other command. */
export function assign(
  overrides: Keybindings,
  commandId: string,
  combo: string,
  effective: readonly AppCommand[],
  platform: ShortcutPlatform,
): Keybindings {
  const key = canonical(combo, platform);
  const next: Keybindings = { ...overrides, [commandId]: [key] };
  for (const command of effective) {
    if (command.id === commandId) continue;
    const keys = defaultKeys(command);
    const rest = keys.filter((k) => canonical(k, platform) !== key);
    if (rest.length < keys.length) next[command.id] = rest.length > 0 ? rest : null;
  }
  return next;
}

export function remove(overrides: Keybindings, commandId: string): Keybindings {
  return { ...overrides, [commandId]: null };
}

export function reset(overrides: Keybindings, commandId: string): Keybindings {
  const { [commandId]: _, ...rest } = overrides;
  return rest;
}

/** Windows AltGr arrives as Ctrl+Alt: a typed character ("{", "@", "€") is text, not a shortcut. */
export function isAltGrText(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey">, mac: boolean): boolean {
  return !mac && event.ctrlKey && event.altKey && event.key.length === 1 && !/^[a-z0-9 ]$/i.test(event.key);
}

const NO_KEY = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "OS", "CapsLock", "Dead", "Unidentified", "Process"]);

/**
 * The shortcut a key press means, in canonical notation, so that `matchesShortcut` recognises
 * the same press again. `null` for a lone modifier, a dead key or the Windows key.
 */
export function shortcutFromEvent(
  event: Pick<KeyboardEvent, "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
  mac: boolean,
): string | null {
  if (NO_KEY.has(event.key) || (event.metaKey && !mac)) return null;
  if (isAltGrText(event, mac)) return null;
  let key: string;
  let shift = event.shiftKey;
  // Numpad only when it types the digit (NumLock off gives End, ArrowDown …).
  const digit = /^Digit(\d)$/.exec(event.code)?.[1] ?? (/^Numpad\d$/.test(event.code) && /^\d$/.test(event.key) ? event.key : undefined);
  if (/^[a-z]$/i.test(event.key)) key = event.key.toUpperCase();
  else if (/^Key[A-Z]$/.test(event.code)) key = event.code.slice(3);
  // A digit unless Shift turned it into another character (German Shift+7 is "/").
  else if (digit && (/^\d$/.test(event.key) || !shift)) key = digit;
  else if (event.key === " ") key = "Space";
  else if (event.key.length === 1) {
    key = event.key;
    shift = false;
  } else key = event.key;
  const parts = [
    event.metaKey || (event.ctrlKey && !mac) ? "Mod" : "",
    event.ctrlKey && mac ? "Ctrl" : "",
    event.altKey ? "Alt" : "",
    shift ? "Shift" : "",
  ];
  return [...parts.filter(Boolean), key].join("+");
}
