/**
 * Before merge, rebase, cherry-pick and revert from menus, the palette and drag and drop: a quick
 * conflict preview (at most 1.5 s), for a rebase also the branches that could move along. Only if
 * there is something to say does a dialog ask – otherwise the action runs right away, as before.
 * A check that takes longer than a moment opens the dialog early with “Checking for conflicts…”;
 * if it then finds nothing to say, the dialog closes on its own and the action runs.
 */
import { core, type Id, type PreviewOp } from "../../core";
import { openPreflightDialog, type PreflightChoice } from "../../screens/Preflight";
import { needsDialog, type PreflightFacts } from "../../screens/Preflight/model";
import { previewOnce } from "../conflictPreview";

export const PREFLIGHT_LIMIT_MS = 1500;
/** Fast checks never show a dialog; slower ones show their checking state after this long. */
export const CHECKING_DIALOG_DELAY_MS = 250;

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
  const abort = new AbortController();
  const noDependents: Promise<string[]> = Promise.resolve([]);
  const facts: Promise<PreflightFacts> = Promise.all([
    previewOnce(repoId, request.op, PREFLIGHT_LIMIT_MS, abort.signal),
    request.rebase ? core.rebaseDependents({ repoId, onto: request.rebase.onto, branch: request.rebase.branch }).catch(() => [] as string[]) : noDependents,
  ]).then(([preview, dependents]) => ({ preview, dependents }));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), CHECKING_DIALOG_DELAY_MS);
  });
  const early = await Promise.race([facts, slow]);
  clearTimeout(timer);

  const dialog = { title: request.title, confirmLabel: request.confirmLabel };
  if (early) {
    if (!needsDialog(early)) return { updateRefs: false };
    return openPreflightDialog({ ...dialog, facts: early });
  }
  // Still checking: the dialog shows it and follows the answer.
  const choice = await openPreflightDialog({ ...dialog, facts });
  if (choice === null) abort.abort();
  return choice;
}
