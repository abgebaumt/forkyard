/**
 * Running custom commands: ask for the inputs, let the core build the command – for `confirm: true`
 * first only to show it –, then run it as a job and report the result. The core decides what runs;
 * the UI never builds a command line.
 */
import { core, type CustomCommandContext, type CustomCommandEntry, type CustomCommandResult, type Id } from "../../core";
import { t } from "../../i18n";
import { toast } from "../../ui/Feedback";
import { askInputs } from "../../screens/CustomCommands/InputsDialog";
import { confirm, showOutput, type ConfirmOptions } from "../dialogs";
import { newJobId, runAction } from "../run";
import { useAppStore } from "../store";
import { openInBrowser } from "./hosts";

function reportUntrusted(): void {
  toast({
    tone: "warning",
    title: t("customCommands.run.untrusted"),
    description: t("customCommands.run.untrustedHint"),
    action: { label: t("customCommands.run.review"), onClick: () => useAppStore.getState().openOverlay({ kind: "preferences", section: "commands" }) },
  });
}

async function report(title: string, result: CustomCommandResult): Promise<boolean> {
  if (result.status === "open_url") return openInBrowser(result.url, title);
  if (result.status !== "finished") return false;
  const ok = result.exitCode === 0;
  const output = result.output;
  toast({
    tone: ok ? "success" : "danger",
    title: ok ? t("customCommands.run.done", { title }) : t("customCommands.run.failed", { title, code: result.exitCode ?? "–" }),
    action: output ? { label: t("customCommands.run.showOutput"), onClick: () => void showOutput(title, output) } : undefined,
  });
  return ok;
}

/** The prompt before a `confirm: true` command: the finished command line, shown in full. */
export function runConfirmation(title: string, result: Extract<CustomCommandResult, { status: "confirm" }>): ConfirmOptions {
  return {
    title: t("customCommands.run.confirmTitle", { title }),
    body: t("customCommands.run.confirmBody", { cwd: result.cwd }),
    details: [result.display],
    detailsLabel: t("customCommands.run.confirmDetails"),
    detailsWrap: true,
    confirmLabel: t("customCommands.run.confirmLabel"),
  };
}

/** Runs a command from the palette or a context menu. Returns whether it ran successfully. */
export async function runCustomCommand(repoId: Id, entry: CustomCommandEntry, context: CustomCommandContext = {}): Promise<boolean> {
  if (!entry.runnable) {
    reportUntrusted();
    return false;
  }
  const { command } = entry;
  let inputs: Record<string, string> = {};
  if (command.inputs.length > 0) {
    const values = await askInputs(command);
    if (!values) return false;
    inputs = values;
  }
  const call = (confirmed: boolean) => {
    const jobId = newJobId();
    return runAction(command.title, () => core.customCommandRun({ repoId, id: entry.key, context, inputs, jobId, confirmed }), {
      busyKey: `${repoId}:custom:${entry.key}`,
      quiet: ["command_untrusted"],
      job: { id: jobId, title: command.title, repoId },
    });
  };
  let result = await call(false);
  if (result.ok && result.value.status === "confirm") {
    const go = await confirm(runConfirmation(command.title, result.value));
    if (!go) return false;
    result = await call(true);
  }
  if (!result.ok) {
    if (result.error.code === "command_untrusted") reportUntrusted();
    return false;
  }
  return report(command.title, result.value);
}
