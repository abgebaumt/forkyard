/**
 * What the two sides are called. Git always calls them “ours” and “theirs”; what that means
 * depends on the operation – during a rebase “ours” is the target and “theirs” your own commit.
 * The headings say this in words, not just “left / right”.
 */
import type { ConflictFile, Operation } from "../../core";
import type { Side } from "./model";
import { t } from "../../i18n";

export interface SideTitle {
  /** Heading with name, e.g. “Current (main)”. */
  heading: string;
  /** Only the role, e.g. “Current”. */
  role: string;
  /** Branch, commit or description. */
  name: string;
  /** One explanatory sentence below the heading. */
  hint: string;
  /** Label for “everything from this side”. */
  all: string;
  /** Label for “whole version of this side” (binary file, very large). */
  whole: string;
}

export type SideTitles = Record<Side, SideTitle>;

const withName = (role: string, name: string) => (name ? `${role} (${name})` : role);

/** One side from the texts under `conflict.side.<key>`. */
function side(key: string, name: string, hint?: string): SideTitle {
  const role = t(`conflict.side.${key}.role`);
  return { heading: withName(role, name), role, name, hint: hint ?? t(`conflict.side.${key}.hint`), all: t(`conflict.side.${key}.all`), whole: t(`conflict.side.${key}.whole`) };
}

export function sideTitles(operation: Operation | null | undefined, file: Pick<ConflictFile, "oursLabel" | "theirsLabel">): SideTitles {
  const ours = file.oursLabel.trim();
  const theirs = file.theirsLabel.trim();
  switch (operation?.kind) {
    case "rebase":
      return { ours: side("rebaseOurs", ours), theirs: side("rebaseTheirs", theirs) };
    case "cherry_pick":
      return { ours: side("current", ours, t("conflict.side.current.hintCheckedOut")), theirs: side("cherryPick", theirs.replace(/^Cherry-Pick\s+/i, "")) };
    case "revert":
      return { ours: side("current", ours, t("conflict.side.current.hintCheckedOut")), theirs: side("revert", theirs) };
    default:
      return { ours: side("current", ours), theirs: side("incoming", theirs, operation ? t("conflict.side.incoming.hint") : t("conflict.side.incoming.hintApplied")) };
  }
}
