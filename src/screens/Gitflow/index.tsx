/**
 * Gitflow: entry points. `openGitflow` shows the dialog (set up, start, running branches); if the
 * user picks "Finish …" there, the finish dialog follows. `openGitflowFinish` opens the finish
 * step directly (a branch's menu, command for the checked-out branch).
 */
import type { GitflowKind, Id } from "../../core";
import { showDialog } from "../../app/dialogs";
import { FinishDialog, type FinishTarget } from "./FinishDialog";
import { GitflowDialog } from "./GitflowDialog";

export type { FinishTarget } from "./FinishDialog";

export function openGitflowFinish(repoId: Id, tabId: Id | null, target: FinishTarget): Promise<null> {
  return showDialog<null>((done) => <FinishDialog repoId={repoId} tabId={tabId} target={target} onClose={() => done(null)} />);
}

export async function openGitflow(repoId: Id, tabId: Id | null, initialKind: GitflowKind = "feature"): Promise<void> {
  const next = await showDialog<{ finish: FinishTarget }>((done) => <GitflowDialog repoId={repoId} initialKind={initialKind} onDone={done} />);
  if (next?.finish) await openGitflowFinish(repoId, tabId, next.finish);
}
