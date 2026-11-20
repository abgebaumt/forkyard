/**
 * The lasso bar's two buttons: "Commit only this" (the selected lines become a commit on HEAD) and
 * "Move to new branch …" (they become a commit on a new branch and leave the working copy).
 * Both send HEAD and every file's token; on `stale_state` the core writes nothing and the lasso stays.
 */
import { core, type Id } from "../../core";
import { t } from "../../i18n";
import { toast } from "../../ui/Feedback";
import { failSummary, wipBusy } from "../../screens/WipPanel/actions";
import { flushDraft, forgetDraft, getDraft, isUntouchedTemplate } from "../../screens/WipPanel/draft";
import { getWipTab, useWipStore } from "../../screens/WipPanel/state";
import { askSelectionBranch } from "../actionDialogs";
import { focusSummarySoon } from "../commands/focus";
import { shortSha } from "../format";
import { lassoCounts, lassoSelections, useLassoStore } from "../lasso";
import { qk, queryClient } from "../queries";
import { newOpId, runAction } from "../run";
import { withFreshStatus } from "../statusCache";
import { getTabView, useAppStore } from "../store";
import { checkout } from "./branches";
import { headSha } from "./context";
import { followVanishedDiff } from "./files";

const lassoOf = (tabId: Id) => useLassoStore.getState().byTab[tabId] ?? {};

/** The bar's count text ("3 lines in 2 files"). */
function countText(tabId: Id): string {
  const { lines, files } = lassoCounts(lassoOf(tabId));
  return t("wip.lasso.count", { lines: t("wip.lasso.lines", { count: lines }), files: t("wip.lasso.files", { count: files }) });
}

/**
 * Sends one of the two commands. The lasso is cleared as soon as the core succeeded, before the status
 * is reloaded: otherwise the guard would see the files change and report them as changed outside.
 */
function send(label: string, repoId: Id, tabId: Id, call: (expectHead: string) => Promise<{ sha: string }>) {
  // An unborn HEAD has no sha: the core answers `not_allowed` with its own text.
  const expectHead = headSha(repoId) ?? "";
  return runAction(
    label,
    withFreshStatus(repoId, async () => {
      const result = await call(expectHead);
      useLassoStore.getState().clear(tabId);
      return result;
    }),
    { busyKey: wipBusy.commit(repoId) },
  );
}

function afterWrite(repoId: Id) {
  followVanishedDiff(repoId);
  void queryClient.invalidateQueries({ queryKey: qk.status(repoId) });
  void queryClient.invalidateQueries({ queryKey: qk.diffAll(repoId) });
  void queryClient.invalidateQueries({ queryKey: qk.undo(repoId) });
}

/** Commits the lasso on HEAD with the message of the commit field; an empty field gets the focus. */
export async function commitLasso(repoId: Id, tabId: Id): Promise<"done" | "needsMessage" | "failed"> {
  const selections = lassoSelections(lassoOf(tabId));
  if (selections.length === 0) return "failed";
  const { summary: rawSummary, description, amend } = getDraft(repoId);
  const summary = rawSummary.trim();
  const missing = amend
    ? t("wip.lasso.amendOn")
    : !summary
      ? t("wip.commit.summaryMissing")
      : isUntouchedTemplate(repoId, { summary, description })
        ? t("wip.commit.untouchedTemplate")
        : null;
  if (missing) {
    failSummary(tabId, missing);
    if (getTabView(tabId).rightCollapsed) useAppStore.getState().setRightCollapsed(tabId, false);
    focusSummarySoon();
    return "needsMessage";
  }
  useWipStore.getState().patch(tabId, { summaryError: null });
  flushDraft(repoId);

  const label = t("wip.lasso.commitOnly");
  const { skipHooks } = getWipTab(tabId);
  const opId = newOpId();
  const result = await send(label, repoId, tabId, (expectHead) =>
    core.commitSelection({ repoId, opId, selections, summary, description, skipHooks, expectHead }),
  );
  if (!result.ok) {
    // The guard then drops exactly the files that changed; the rest of the lasso stays.
    if (result.error.code === "stale_state") void queryClient.invalidateQueries({ queryKey: qk.diffAll(repoId) });
    return "failed";
  }
  forgetDraft(repoId);
  useWipStore.getState().patch(tabId, { amendFilled: null, amendSha: null });
  afterWrite(repoId);
  toast({ tone: "success", title: t("wip.commit.created"), description: `${shortSha(result.value.sha)} · ${summary}` });
  return "done";
}

/** Asks for branch and message, moves the lasso there, offers "Switch to branch". */
export async function lassoToBranch(repoId: Id, tabId: Id): Promise<"done" | "cancelled" | "failed"> {
  const selections = lassoSelections(lassoOf(tabId));
  if (selections.length === 0) return "cancelled";
  const draft = getDraft(repoId);
  const input = await askSelectionBranch({ repoId, summary: draft.summary, description: draft.description, lines: countText(tabId) });
  if (!input) return "cancelled";

  const { branch, summary, description } = input;
  const { skipHooks } = getWipTab(tabId);
  const opId = newOpId();
  const result = await send(t("wip.lasso.toBranch"), repoId, tabId, (expectHead) =>
    core.selectionToBranch({ repoId, opId, selections, branch, summary, description, skipHooks, expectHead }),
  );
  if (!result.ok) {
    if (result.error.code === "stale_state") void queryClient.invalidateQueries({ queryKey: qk.diffAll(repoId) });
    return "failed";
  }
  // The commit draft stays: it was only the dialog's prefill.
  afterWrite(repoId);
  toast({
    tone: "success",
    title: t("wip.lasso.movedTitle", { branch }),
    description: `${shortSha(result.value.sha)} · ${summary}`,
    action: { label: t("wip.lasso.switch"), onClick: () => void checkout(repoId, branch, { tabId }) },
  });
  return "done";
}
