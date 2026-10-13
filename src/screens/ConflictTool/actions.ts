/**
 * Saving in the conflict tool: write and stage the result (or take one side completely),
 * then go to the next conflict file – or back to the WIP view, where the merge is concluded.
 */
import { core, type Id, type Status } from "../../core";
import { cachedStatus } from "../../app/actions/context";
import { busyKeys } from "../../app/actions/keys";
import { operationNames, showWip } from "../../app/actions/merge";
import { qk, queryClient } from "../../app/queries";
import { runAction } from "../../app/run";
import { withStatus } from "../../app/statusCache";
import { getTabView, setCenterGuard, useAppStore } from "../../app/store";
import { toast } from "../../ui/Feedback";
import { dropSession } from "./session";
import { splitPath } from "./parts";
import { t } from "../../i18n";

export const resolveBusyKey = (repoId: Id, path: string) => busyKeys.write(repoId, `conflict:${path}`);

export type ResolveInput = { content: string; side?: undefined } | { side: "ours" | "theirs"; content?: undefined };

/** After closing, sets the focus in the commit panel (conflict list or conclude button). */
export function focusCommitPanel() {
  const attempt = (tries: number) => {
    const panel = document.querySelector('[data-area="right"]');
    const target =
      panel?.querySelector<HTMLElement>('[data-section="conflicts"] [role="option"][tabindex="0"]') ??
      panel?.querySelector<HTMLElement>('button[data-action="commit"]') ??
      panel?.querySelector<HTMLElement>('[role="option"][tabindex="0"]');
    if (target) target.focus();
    else if (tries > 0) requestAnimationFrame(() => attempt(tries - 1));
  };
  requestAnimationFrame(() => attempt(10));
}

/**
 * Resolves the file. Returns the new status or null (the error was already reported).
 * Afterwards: next open conflict file (in list order), otherwise the WIP view.
 */
export async function resolveConflict(repoId: Id, tabId: Id, path: string, input: ResolveInput): Promise<Status | null> {
  const before = cachedStatus(repoId)?.conflicted.map((file) => file.path) ?? [];
  const label = input.side === "ours" ? t("conflict.resolve.takeOurs") : input.side === "theirs" ? t("conflict.resolve.takeTheirs") : t("conflict.resolve.resolve");
  const result = await runAction(label, withStatus(repoId, () => core.conflictResolve({ repoId, path, content: input.content ?? null, side: input.side ?? null })), {
    busyKey: resolveBusyKey(repoId, path),
  });
  if (!result.ok) return null;
  const status = result.value;
  void queryClient.invalidateQueries({ queryKey: qk.conflictAll(repoId) });
  dropSession(repoId, path);

  const open = status.conflicted.map((file) => file.path);
  const position = before.indexOf(path);
  const next = before.slice(position + 1).find((item) => open.includes(item)) ?? open[0] ?? null;
  const name = splitPath(path).name;
  const operation = status.operation;
  // Only continue if the middle still shows this file. Anyone who has meanwhile opened something
  // else themselves (another conflict file from the list, a diff) stays there: otherwise the view
  // would belatedly jump to a file nobody chose – and the next click on “Keep current version”
  // would hit the wrong file.
  const center = getTabView(tabId).center;
  const stillHere = center.kind === "conflict" && center.path === path;
  toast({
    tone: "success",
    title: t("conflict.resolve.doneTitle", { name }),
    description: next
      ? stillHere
        ? t("conflict.resolve.remainingNext", { count: open.length, next: splitPath(next).name })
        : t("conflict.resolve.remaining", { count: open.length })
      : operation
        ? operation.kind === "merge"
          ? t("conflict.resolve.allDoneMerge")
          : t("conflict.resolve.allDoneContinue", { operation: operationNames[operation.kind] })
        : t("conflict.resolve.allDone"),
  });

  if (!stillHere) return status;
  // Nothing left to lose: the guard against leaving is obsolete.
  setCenterGuard(tabId, null);
  const store = useAppStore.getState();
  if (next) store.openConflict(tabId, next);
  else {
    store.closeCenter(tabId);
    showWip(tabId);
    focusCommitPanel();
  }
  return status;
}
