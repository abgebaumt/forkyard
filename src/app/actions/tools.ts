/**
 * Launch an external diff and merge tool. The core provides the versions as files and starts
 * the program from the settings (or `git difftool` / `git mergetool`); the app does not wait
 * for it. If a tool is missing, the message leads straight to the settings.
 */
import { t } from "../../i18n";
import { core, type DiffSource, type Id } from "../../core";
import { toast } from "../../ui/Feedback";
import { describeError } from "../errors";
import { runAction } from "../run";
import { useAppStore } from "../store";
import { clip } from "./context";

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function explain(title: string, error: unknown) {
  toast({
    tone: "danger",
    title,
    description: describeError(error).text,
    action: { label: t("actions.tools.setup"), onClick: () => useAppStore.getState().openOverlay({ kind: "preferences", section: "external" }) },
  });
}

/** Shows a file's diff in the external diff tool. `source` picks the comparison as in the diff view. */
export async function openDiffTool(repoId: Id, path: string, source: DiffSource) {
  const result = await runAction(t("actions.files.external.diffTool"), () => core.openExternal({ repoId, target: "diff_tool", path, source }), {
    busyKey: `${repoId}:open:diff_tool:${path}`,
    quiet: ["not_found"],
  });
  if (result.ok) toast({ tone: "info", title: t("actions.tools.diffStarted"), description: t("actions.tools.diffStartedDescription", { name: clip(fileName(path), 48) }) });
  else if (result.error.code === "not_found") explain(t("actions.tools.diffFailed"), result.error);
  return result;
}

/** Opens a conflicted file in the external merge tool. What the tool writes then shows up in the app. */
export async function openMergeTool(repoId: Id, path: string) {
  const result = await runAction(t("actions.files.external.mergeTool"), () => core.openExternal({ repoId, target: "merge_tool", path }), {
    busyKey: `${repoId}:open:merge_tool:${path}`,
    quiet: ["not_found"],
  });
  if (result.ok) toast({ tone: "info", title: t("actions.tools.mergeStarted"), description: t("actions.tools.mergeStartedDescription", { name: clip(fileName(path), 48) }) });
  else if (result.error.code === "not_found") explain(t("actions.tools.mergeFailed"), result.error);
  return result;
}
