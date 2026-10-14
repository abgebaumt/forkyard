/**
 * Before merge, rebase, cherry-pick and revert from menus, the palette and drag and drop: a quick
 * conflict preview (at most 1.5 s), for a rebase also the branches that could move along. Only if
 * there is something to say does a dialog ask – otherwise the action runs right away, as before.
 */
import { core, type Id, type PreviewOp } from "../../core";
import { openPreflightDialog, type PreflightChoice } from "../../screens/Preflight";
import { needsDialog } from "../../screens/Preflight/model";
import { previewOnce } from "../conflictPreview";

export const PREFLIGHT_LIMIT_MS = 1500;

export interface PreflightRequest {
  /** Question for the dialog title, e.g. “Merge feature into main?”. */
  title: string;
  /** The verb of the action for the button. */
  confirmLabel: string;
  op: PreviewOp;
  /** Only for a rebase: target and branch, to offer the dependent branches. */
  rebase?: { onto: string; branch: string | null };
}

/** null = the user cancelled in the dialog. */
export async function preflight(repoId: Id, request: PreflightRequest): Promise<PreflightChoice | null> {
  const noDependents: Promise<string[]> = Promise.resolve([]);
  const [preview, dependents] = await Promise.all([
    previewOnce(repoId, request.op, PREFLIGHT_LIMIT_MS),
    request.rebase ? core.rebaseDependents({ repoId, onto: request.rebase.onto, branch: request.rebase.branch }).catch(() => [] as string[]) : noDependents,
  ]);
  const facts = { preview, dependents };
  if (!needsDialog(facts)) return { updateRefs: false };
  return openPreflightDialog({ title: request.title, confirmLabel: request.confirmLabel, facts });
}
