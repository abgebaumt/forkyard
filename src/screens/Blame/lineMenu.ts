/**
 * The line menu of Blame (v1.2, 7.1): copy the line, show its commit, blame of the previous version,
 * “Why is this so?” (“History of this line” while AI is hidden). Pure – the view passes the actions.
 */
import type { ArchaeologyTarget } from "../../app/store";
import type { MenuEntry } from "../../ui/Menu";
import { whyEntry, type TargetOrReason } from "../Archaeology/model";
import { t } from "../../i18n";
import type { BlameBlock } from "./model";

export interface BlameLineMenuInput {
  /** Text of the line (copied as is). */
  text: string;
  block: BlameBlock | null;
  /** Where “What was here before?” leads, or why not. */
  parent: { sha: string; path: string } | { reason: string };
  why: TargetOrReason;
  aiVisible: boolean;
  copy(text: string): void;
  reveal(block: BlameBlock): void;
  previous(): void;
  open(target: ArchaeologyTarget): void;
}

export function blameLineMenu(input: BlameLineMenuInput): MenuEntry[] {
  const { block, parent } = input;
  const show: MenuEntry = block?.uncommitted
    ? { label: t("blame.reveal.local"), shortcut: "Enter", onSelect: () => input.reveal(block) }
    : { label: t("blame.menu.showCommit"), shortcut: "Enter", disabled: !block, onSelect: () => (block ? input.reveal(block) : undefined) };
  const previous: MenuEntry =
    "sha" in parent && block
      ? { label: t("blame.menu.previousVersion"), shortcut: "P", onSelect: () => input.previous() }
      : { label: t("blame.menu.previousVersion"), shortcut: "P", disabled: true, hint: "reason" in parent ? parent.reason : undefined };
  return [{ label: t("blame.menu.copyLine"), onSelect: () => input.copy(input.text) }, show, previous, { type: "separator" }, whyEntry(input.why, input.aiVisible, input.open, "W")];
}
