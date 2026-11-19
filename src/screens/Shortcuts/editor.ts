/** Pure state of recording one shortcut in the keybinding editor. */
import type { AppCommand } from "../../app/commandTypes";
import { assign, canonical, conflictWith, defaultKeys, refusal, reset, type Keybindings, type Refusal } from "../../app/keybindings";
import type { ShortcutPlatform } from "../../ui/shortcut";

export type RecordState =
  | { kind: "idle" }
  | { kind: "recording"; commandId: string }
  | { kind: "conflict"; commandId: string; combo: string; other: { id: string; title: string } }
  | { kind: "refused"; commandId: string; combo: string; reason: Refusal };

export type RecordAction = { kind: "set"; combo: string } | { kind: "remove" } | { kind: "none" };

/**
 * A key press while recording. `combo` comes from `shortcutFromEvent` (null for a lone modifier),
 * `key` is `KeyboardEvent.key`. Plain Escape cancels, plain Backspace removes the shortcut.
 */
export function onRecordKey(
  state: RecordState,
  combo: string | null,
  key: string,
  ctx: { effective: AppCommand[]; base: AppCommand[]; platform: ShortcutPlatform },
): { state: RecordState; action: RecordAction } {
  const none = { kind: "none" } as const;
  if (state.kind === "idle") return { state, action: none };
  const plain = (name: string) => key === name && (combo === null || combo === name);
  if (plain("Escape")) return { state: { kind: "idle" }, action: none };
  // While asking about a conflict the keys belong to its buttons.
  if (state.kind === "conflict") return { state, action: none };
  if (plain("Backspace")) return { state: { kind: "idle" }, action: { kind: "remove" } };
  if (combo === null) return { state, action: none };
  const { commandId } = state;
  const own = ctx.base.find((command) => command.id === commandId);
  const reason = refusal(combo, ctx.platform, own ? defaultKeys(own) : []);
  if (reason) return { state: { kind: "refused", commandId, combo, reason }, action: none };
  const other = conflictWith(combo, commandId, ctx.effective, ctx.platform);
  if (other) return { state: { kind: "conflict", commandId, combo, other: { id: other.id, title: other.title } }, action: none };
  return { state: { kind: "idle" }, action: { kind: "set", combo } };
}

/** `assign`, but a command that gets exactly its default key back loses its override instead. */
export function assignKey(
  overrides: Keybindings,
  commandId: string,
  combo: string,
  ctx: { effective: readonly AppCommand[]; base: readonly AppCommand[]; platform: ShortcutPlatform },
): Keybindings {
  const next = assign(overrides, commandId, combo, ctx.effective, ctx.platform);
  const own = ctx.base.find((command) => command.id === commandId);
  const defaults = own ? defaultKeys(own).map((key) => canonical(key, ctx.platform)) : [];
  return defaults.length === 1 && defaults[0] === canonical(combo, ctx.platform) ? reset(next, commandId) : next;
}
