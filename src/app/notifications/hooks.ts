/**
 * Make Git hooks visible. The core reports every hook output as an event `hook:output` – on
 * commit, reword, merge, continue, rebase, interactive rebase, squash, cherry-pick, revert,
 * push and tag push. Here that becomes:
 *
 * - Hook prints something and succeeds: a notice with the first line and "Show output".
 *   If it runs several times in one operation (cherry-picking several commits), the core sends
 *   ONE event with all outputs – so also one toast.
 * - Hook fails: an error toast that stays. If the triggering action fails because of it
 *   (`hook_failed`), `reportHookRejection` replaces it with ONE toast that names the action, the
 *   hook and the output together – never two toasts for the same incident.
 *
 * No dependency on queries.ts and run.ts (both call into here).
 */
import { t } from "../../i18n";
import type { CoreError, Id } from "../../core";
import { dismissToast, toast } from "../../ui/Feedback";
import { showOutput } from "../dialogs";
import { desktopNotify } from "../notify";

export interface HookEvent {
  repoId: Id;
  hook: string;
  output: string;
  exitCode: number;
}

interface Failure extends HookEvent {
  at: number;
  toastId: number;
}

/** For this long a failed hook belongs to a `hook_failed` reported after it. */
const FAILURE_WINDOW_MS = 8000;
const FIRST_LINE_MAX = 160;

let lastFailure: Failure | null = null;

const firstLine = (text: string) => {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length > FIRST_LINE_MAX ? `${line.slice(0, FIRST_LINE_MAX - 1)}…` : line;
};

const showHookOutput = (hook: string, output: string) => void showOutput(t("notifications.hooks.outputOf", { hook }), output);

/** A `hook:output` from the core. `notifyOnError`: the "Notify on errors" setting. */
export function reportHookOutput(event: HookEvent, notifyOnError: boolean | undefined): void {
  const text = event.output.trim();
  if (!text && event.exitCode === 0) return;

  if (event.exitCode !== 0) {
    const title = t("notifications.hooks.failed", { hook: event.hook, code: event.exitCode });
    const line = firstLine(text);
    const toastId = toast({
      tone: "danger",
      title,
      description: line || undefined,
      action: text ? { label: t("notifications.hooks.showOutput"), onClick: () => showHookOutput(event.hook, event.output) } : undefined,
    });
    lastFailure = { ...event, at: Date.now(), toastId };
    desktopNotify(notifyOnError, title, line);
    return;
  }

  // Successful, but with output. If a hook runs several times in one operation (cherry-picking
  // several commits), the core already combines its outputs into one event.
  toast({
    tone: "info",
    title: t("notifications.hooks.printed", { hook: event.hook }),
    description: firstLine(text) || undefined,
    sticky: true,
    action: { label: t("notifications.hooks.showOutput"), onClick: () => showHookOutput(event.hook, event.output) },
  });
}

/** The most recently reported failed hook, if it is recent enough. */
function recentFailure(): Failure | null {
  return lastFailure && Date.now() - lastFailure.at < FAILURE_WINDOW_MS ? lastFailure : null;
}

const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * An action failed because of a hook (`hook_failed`). Shows exactly ONE toast: what was rejected,
 * by which hook, the first line of its output and "Show output". The hook's own toast (from
 * `reportHookOutput`) is merged into it.
 */
export async function reportHookRejection(label: string, error: CoreError, notifyOnError: boolean | undefined): Promise<void> {
  // The event comes before the response – but on a different path in the WebView: wait briefly for it.
  for (let round = 0; round < 6 && !recentFailure(); round++) await wait(50);
  const failure = recentFailure();
  lastFailure = null;
  if (failure) dismissToast(failure.toastId);
  const output = (failure?.output ?? error.gitOutput ?? "").trim();
  const hook = failure?.hook ?? null;
  const line = firstLine(output);
  // The core's sentence names the hook, the exit code and whether the operation is paused.
  const message = error.message.trim() || t("notifications.hooks.rejectedMessage");
  const title = t("notifications.hooks.rejected", { label });
  toast({
    tone: "danger",
    title,
    description: line ? `${message}\n${line}` : message,
    action: output ? { label: t("notifications.hooks.showOutput"), onClick: () => showHookOutput(hook ?? t("notifications.hooks.gitHook"), output) } : undefined,
  });
  // The hook itself has already notified the system if its event arrived.
  if (!failure) desktopNotify(notifyOnError, title, message);
}
