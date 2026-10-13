/**
 * Patches: create a patch from a commit, a stash, the local changes or single files (clipboard or
 * file) and apply a patch (paste or pick a file, check first, then apply). Both are dialogs via
 * the shell's DialogHost.
 */
import type { Id } from "../../core";
import { showDialog } from "../../app/dialogs";
import { ApplyPatchDialog } from "./ApplyDialog";
import { CreatePatchDialog, type PatchRequest } from "./CreateDialog";

export type { PatchRequest } from "./CreateDialog";

export function openCreatePatch(repoId: Id, request: PatchRequest): Promise<null> {
  return showDialog<null>((done) => <CreatePatchDialog repoId={repoId} request={request} onClose={() => done(null)} />);
}

export function openApplyPatch(repoId: Id, tabId: Id | null): Promise<null> {
  return showDialog<null>((done) => <ApplyPatchDialog repoId={repoId} tabId={tabId} onClose={() => done(null)} />);
}
