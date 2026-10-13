/**
 * Command registry. Collects all files under src/app/commands/*.ts that
 * provide `export const commands: AppCommand[]`. New commands = new file there,
 * no shared list to change.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { AppInfo, Status, Tab } from "../core";
import type { AppCommand, CommandContext } from "./commandTypes";
import { hasCommandModifier, matchesShortcut } from "./commandTypes";
import { hasOpenDialog } from "./dialogs";
import { qk, queryClient } from "./queries";
import { showError } from "./run";
import { useAppStore } from "./store";
import { preventedByGuard } from "./webviewGuards";

export type { AppCommand, CommandContext, CommandGroup } from "./commandTypes";

const modules = import.meta.glob<{ commands?: AppCommand[] }>("./commands/*.ts", { eager: true });

let registered: AppCommand[] = [];
const listeners = new Set<() => void>();

function collect(): AppCommand[] {
  const seen = new Map<string, AppCommand>();
  for (const [file, module] of Object.entries(modules)) {
    for (const command of module.commands ?? []) {
      if (seen.has(command.id)) console.warn(`Command "${command.id}" is duplicated (${file}); the later one wins.`);
      seen.set(command.id, command);
    }
  }
  return [...seen.values()];
}
registered = collect();

/** All commands (including those currently unavailable). */
export function getCommands(): AppCommand[] {
  return registered;
}

/** Register further commands at runtime (e.g. depending on the screen). The return value unregisters them. */
export function registerCommands(commands: AppCommand[]): () => void {
  registered = [...registered.filter((item) => !commands.some((command) => command.id === item.id)), ...commands];
  listeners.forEach((listener) => listener());
  return () => {
    registered = registered.filter((item) => !commands.includes(item));
    listeners.forEach((listener) => listener());
  };
}

export function useCommands(): AppCommand[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => registered,
  );
}

/** Context at the time of the call, fresh from the query cache and store. */
export function buildCommandContext(source: CommandContext["source"] = "menu"): CommandContext {
  const tabs = [...(queryClient.getQueryData<Tab[]>(qk.tabs) ?? [])].sort((a, b) => a.position - b.position);
  const tab = tabs.find((item) => item.isActive) ?? null;
  const store = useAppStore.getState();
  const repoId = tab?.kind === "repo" ? tab.repoId : null;
  const info = queryClient.getQueryData<AppInfo>(qk.appInfo);
  return {
    platform: info?.platform ?? "windows",
    tabs,
    tab,
    tabId: tab?.id ?? null,
    repoId,
    view: tab ? (store.views[tab.id] ?? null) : null,
    status: repoId ? queryClient.getQueryData<Status>(qk.status(repoId)) : undefined,
    store,
    queryClient,
    source,
  };
}

export function isAvailable(command: AppCommand, ctx: CommandContext): boolean {
  try {
    return command.when ? command.when(ctx) : true;
  } catch {
    return false;
  }
}

/** Runs a command if it is available. Returns false if not. */
export async function runCommand(idOrCommand: string | AppCommand, source: CommandContext["source"] = "menu"): Promise<boolean> {
  const command = typeof idOrCommand === "string" ? registered.find((item) => item.id === idOrCommand) : idOrCommand;
  if (!command) return false;
  const ctx = buildCommandContext(source);
  if (!isAvailable(command, ctx)) return false;
  try {
    await command.run(ctx);
  } catch (error) {
    showError(command.title, error);
  }
  return true;
}

function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(target.type);
  }
  return Boolean(target.closest(".cm-editor"));
}

/** An open modal window (Radix dialog, promise dialog) blocks global shortcuts. */
function modalOpen(): boolean {
  return hasOpenDialog() || document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]') !== null;
}

/** Global keyboard handler. Mount exactly once in the shell. */
export function useGlobalShortcuts(mac: boolean) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Editors (CodeMirror) and input fields that handle a shortcut themselves take precedence.
      // The guard against browser shortcuts (webviewGuards) also calls preventDefault – that does not count.
      if ((event.defaultPrevented && !preventedByGuard(event)) || event.isComposing) return;
      if (modalOpen()) return;
      const inText = isTextTarget(event.target);
      for (const command of registered) {
        const shortcuts = [command.shortcut, ...(command.aliases ?? [])].filter((item): item is string => Boolean(item));
        const hit = shortcuts.find((shortcut) => matchesShortcut(event, shortcut, mac));
        if (!hit) continue;
        if (inText && (command.textEditing || !hasCommandModifier(hit, mac))) return;
        const ctx = buildCommandContext("keyboard");
        if (!isAvailable(command, ctx)) continue;
        event.preventDefault();
        event.stopPropagation();
        void Promise.resolve()
          .then(() => command.run(ctx))
          .catch((error: unknown) => showError(command.title, error));
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mac]);
}
