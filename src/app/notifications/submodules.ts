/**
 * Follow-up job "update submodules" after checkout, pull, merge …: success stays quiet (the
 * submodule list just refreshes), a failure is a warning – the main operation went through.
 * No dependency on queries.ts and run.ts (queries.ts calls into here).
 */
import { t } from "../../i18n";
import type { CoreEvents } from "../../core";
import { toast } from "../../ui/Feedback";

type SubmodulesUpdated = CoreEvents["submodules:updated"];

export function submoduleWarning(event: SubmodulesUpdated): { title: string; description: string } | null {
  if (event.ok) return null;
  const paths = `${event.paths.slice(0, 3).join(", ")}${event.paths.length > 3 ? " …" : ""}`;
  const lines = [event.message, paths ? t("submoduleSync.failedPaths", { paths }) : null].filter((line): line is string => Boolean(line));
  return { title: t("submoduleSync.failedTitle"), description: lines.join("\n") };
}

export function reportSubmoduleUpdate(event: SubmodulesUpdated): void {
  const warning = submoduleWarning(event);
  if (warning) toast({ tone: "warning", title: warning.title, description: warning.description });
}
