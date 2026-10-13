import { t } from "../../i18n";
import { core, type ErrorCode, type Id, type UndoState } from "../../core";
import { toast } from "../../ui/Feedback";
import { qk, queryClient } from "../queries";
import { runAction } from "../run";
import { withFreshStatus } from "../statusCache";
import { busyKeys } from "./keys";
import { stashChanges } from "./stash";

type Direction = "undo" | "redo";

/** Why a step was refused – in our own words, with what helps now. */
function explain(code: ErrorCode, direction: Direction, label: string | undefined): { title: string; description: string } | null {
  const undo = direction === "undo";
  const step = label ? t("actions.undo.step", { label }) : t("actions.undo.thisStep");
  const stale = undo ? t("actions.undo.title.staleUndo") : t("actions.undo.title.staleRedo");
  switch (code) {
    case "stale_state":
      return { title: stale, description: t("actions.undo.explain.stale", { step }) };
    case "dirty_worktree":
      return {
        title: undo ? t("actions.undo.title.dirtyUndo") : t("actions.undo.title.dirtyRedo"),
        description: t("actions.undo.explain.dirty", { step }),
      };
    case "not_allowed":
      return {
        title: undo ? t("actions.undo.title.localUndo") : t("actions.undo.title.localRedo"),
        description: t("actions.undo.explain.pushed", { step }),
      };
    case "operation_in_progress":
      return { title: t("actions.undo.title.notNow"), description: t("actions.undo.explain.operation") };
    case "conflict":
      return { title: t("actions.undo.title.notNow"), description: t("actions.undo.explain.conflict") };
    case "not_found":
      return {
        title: stale,
        description: t("actions.undo.explain.missing", { step: label ? step : t("actions.undo.thisStepObject") }),
      };
    default:
      return null;
  }
}

const QUIET: ErrorCode[] = ["nothing_to_undo", "stale_state", "dirty_worktree", "not_allowed", "operation_in_progress", "conflict", "not_found"];

async function runStep(repoId: Id, direction: Direction) {
  const before = queryClient.getQueryData<UndoState>(qk.undo(repoId));
  const label = direction === "undo" ? before?.undo?.label : before?.redo?.label;
  const name = direction === "undo" ? t("actions.undoLabel") : t("actions.undo.redoLabel");
  const result = await runAction(name, withFreshStatus(repoId, () => core[direction]({ repoId })), {
    busyKey: busyKeys.undo(repoId),
    quiet: QUIET,
  });
  if (result.ok) {
    queryClient.setQueryData(qk.undo(repoId), result.value);
    toast({ tone: "success", title: direction === "undo" ? t("actions.undo.doneUndo") : t("actions.undo.doneRedo"), description: label });
    return result;
  }
  const code = result.error.code;
  if (code === "nothing_to_undo") {
    // If the last action simply can no longer be undone (already pushed), the reason is shown with it.
    const reason = direction === "undo" ? (await core.undoPeek({ repoId }).catch(() => null))?.undoBlocked : null;
    if (reason) toast({ tone: "info", sticky: true, title: t("actions.undo.title.localUndo"), description: reason });
    else toast({ tone: "info", title: direction === "undo" ? t("actions.undo.nothingUndo") : t("actions.undo.nothingRedo") });
  } else {
    // The core names the files that were edited further since the action: then its sentence applies.
    const changedSince = code === "dirty_worktree" && /seit dieser Aktion|since this action/i.test(result.error.message);
    const text = changedSince
      ? { title: direction === "undo" ? t("actions.undo.overwriteUndo") : t("actions.undo.overwriteRedo"), description: result.error.message }
      : explain(code, direction, label);
    if (text) {
      toast({
        tone: "warning",
        sticky: true,
        ...text,
        action:
          code === "dirty_worktree"
            ? {
                label: direction === "undo" ? t("actions.undo.stashUndo") : t("actions.undo.stashRedo"),
                // Without its own undo entry: otherwise the following undo would only revert this stash.
                onClick: () =>
                  void stashChanges(repoId, { message: t("actions.undo.stashMessage", { name }), quiet: true, undoable: false }).then((stashed) => {
                    if (stashed.ok) void runStep(repoId, direction);
                  }),
              }
            : undefined,
      });
    }
  }
  // The state in the core may have changed despite the error.
  void queryClient.invalidateQueries({ queryKey: qk.undo(repoId) });
  return result;
}

export const undo = (repoId: Id) => runStep(repoId, "undo");
export const redo = (repoId: Id) => runStep(repoId, "redo");
