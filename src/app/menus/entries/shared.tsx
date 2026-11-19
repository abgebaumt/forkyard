/** Shared pieces of the context menus: entries, separators, names in labels, operation blocks. */
import type { ComponentType } from "react";
import type { Id } from "../../../core";
import type { MenuAction, MenuEntry } from "../../../ui/Menu";
import { cachedStatus, clipMiddle, currentBranch } from "../../actions/context";
import { operationNames } from "../../actions/merge";
import { t } from "../../../i18n";

export interface MenuBase {
  repoId: Id;
  tabId: Id;
}

export type Icon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;

export const SEPARATOR: MenuEntry = { type: "separator" };

/** An entry. `blocked` disables it and shows the reason; `tooltip` carries the untruncated names. */
export function item(
  label: string,
  IconComponent: Icon | null,
  onSelect: () => void,
  extra: Partial<MenuAction> & { blocked?: string | null } = {},
): MenuAction {
  const { blocked, ...rest } = extra;
  return {
    label,
    icon: IconComponent ? <IconComponent className="size-icon" aria-hidden /> : undefined,
    // Only once the menu is closed: while it is open, it holds on to focus – a prompt that opens right
    // away would otherwise not get focus on "Cancel".
    onSelect: blocked ? undefined : () => window.requestAnimationFrame(() => window.setTimeout(onSelect, 0)),
    ...rest,
    ...(blocked ? { disabled: true, hint: blocked } : {}),
  };
}

/** Name in quotes, truncated in the middle – the full name is in the entry's tooltip. */
export const q = (name: string, max = 30) => t("menus.quoted", { name: clipMiddle(name, max) });

/** Removes duplicate and superfluous separators (at the start, at the end, consecutive). */
export function tidy(entries: (MenuEntry | null | false | undefined)[]): MenuEntry[] {
  const result: MenuEntry[] = [];
  for (const entry of entries) {
    if (!entry) continue;
    if (entry.type === "separator" && (result.length === 0 || result[result.length - 1]!.type === "separator")) continue;
    result.push(entry);
  }
  while (result.length && result[result.length - 1]!.type === "separator") result.pop();
  return result;
}

/** Reason why nothing in the history can be changed right now – or null. */
export function operationBlock(repoId: Id): string | null {
  const operation = cachedStatus(repoId)?.operation;
  return operation ? t("menus.operationBlock", { operation: operationNames[operation.kind] }) : null;
}

/** What the checked-out state is called in labels. */
export function currentName(repoId: Id): { branch: string | null; label: string; full: string } {
  const branch = currentBranch(repoId);
  return { branch, label: branch ? q(branch) : "HEAD", full: branch ? t("menus.quoted", { name: branch }) : "HEAD" };
}
