/**
 * Run core actions: catch errors, report them understandably, disable buttons.
 */
import { CoreError, type ErrorCode, type Id, type Settings } from "../core";
import { toast } from "../ui/Feedback";
import { t } from "../i18n";
import { showOutput } from "./dialogs";
import { describeError, toCoreError } from "./errors";
import { reportHookRejection } from "./notifications/hooks";
import { desktopNotify } from "./notify";
import { qk, queryClient } from "./queries";
import { useAppStore } from "./store";

export type ActionResult<T> = { ok: true; value: T } | { ok: false; error: CoreError };

export interface RunOptions<T> {
  /** Success toast; a function for text depending on the result, null = no toast. */
  success?: string | ((value: T) => string | null);
  /** While the action runs, this key is "busy" (useBusy). A second call is discarded. */
  busyKey?: string;
  /** Return these errors without a toast (the caller handles them itself). */
  quiet?: ErrorCode[];
  /** Show the job in the status bar while the action runs (for actions with a jobId). */
  job?: { id: string; title: string; repoId: Id | null; askBeforeQuit?: boolean };
}

const SILENT: ErrorCode[] = ["cancelled", "duplicate"];

/**
 * Runs `fn`. Errors are shown as a toast (they stay, text is selectable, with "Show output" when
 * there is Git output) and returned as `{ ok: false }` – never thrown.
 *
 *   const result = await runAction("Push", () => core.push({...}), { busyKey: `${repoId}:push` });
 *   if (result.ok) …
 */
export async function runAction<T>(label: string, fn: () => Promise<T>, options: RunOptions<T> = {}): Promise<ActionResult<T>> {
  const store = useAppStore.getState();
  const { busyKey, job } = options;
  if (busyKey && store.busy[busyKey]) {
    return { ok: false, error: new CoreError({ code: "duplicate", message: t("errors.duplicate.text"), gitOutput: null }) };
  }
  if (busyKey) store.setBusy(busyKey, true);
  if (job) store.startJob(job);
  try {
    const value = await fn();
    const message = typeof options.success === "function" ? options.success(value) : options.success;
    if (message) toast({ tone: "success", title: message });
    return { ok: true, value };
  } catch (raw) {
    const error = toCoreError(raw);
    if (!SILENT.includes(error.code) && !options.quiet?.includes(error.code)) showError(label, error);
    return { ok: false, error };
  } finally {
    if (busyKey) useAppStore.getState().setBusy(busyKey, false);
    if (job) useAppStore.getState().finishJob(job.id);
  }
}

/** Error toast in the style of runAction, for places that catch errors themselves. */
export function showError(label: string, raw: unknown): void {
  const error = toCoreError(raw);
  const notifyOnError = queryClient.getQueryData<Settings>(qk.settings)?.notifyOnError;
  // A hook rejected: one message naming the action, the hook and its output together.
  if (error.code === "hook_failed") {
    void reportHookRejection(label, error, notifyOnError);
    return;
  }
  const { text, hint } = describeError(error);
  const gitOutput = error.gitOutput?.trim();
  toast({
    tone: "danger",
    title: t("app.run.failed", { label }),
    description: hint ? `${text}\n${hint}` : text,
    action: gitOutput ? { label: t("app.run.showOutput"), onClick: () => void showOutput(t("app.run.outputTitle", { label }), gitOutput) } : undefined,
  });
  // If the window is not in front right now (long push, fetch in the background), the system says it too.
  desktopNotify(notifyOnError, t("app.run.failed", { label }), text);
}

let counter = 0;
const random = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2)}`;

/** ID for network actions (`job:progress`, `job:done`, `jobCancel`). */
export function newJobId(): string {
  return `job-${random()}`;
}

/** Operation ID against duplicate execution (commit, stash). */
export function newOpId(): string {
  return `op-${random()}`;
}
