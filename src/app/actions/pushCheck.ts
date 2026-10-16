/**
 * The push check (v1.2, spec 6.2) on the UI side. Every push action runs through `guardSecrets`:
 * the core's secret scan stops a push with `secrets_found`, the dialog shows the findings, and only
 * "Push anyway" repeats the push with exactly those finding IDs (the core scans again; a new finding
 * asks again). "Back" ends like a cancelled action – silently, nothing was sent.
 */
import { core, CoreError, type AiStatus, type Id, type PushResult, type RepoSettings } from "../../core";
import { t } from "../../i18n";
import { qk, queryClient } from "../queries";
import { runAction, type ActionResult } from "../run";
import { showSecretFindings } from "../../screens/PushCheck/SecretDialog";
import type { SecretsFound } from "../../screens/PushCheck/model";

export type ShowFindings = (repoId: Id, found: SecretsFound) => Promise<string[] | null>;

/**
 * Never returns an `ok` result with `secrets_found`: every round needs "Push anyway" (a click), and
 * a new finding after that asks again. Callers can therefore treat every other `ok` as sent.
 */
export async function guardSecrets(
  repoId: Id,
  attempt: (acceptedSecrets: string[] | null) => Promise<ActionResult<PushResult>>,
  show: ShowFindings = showSecretFindings,
): Promise<ActionResult<PushResult>> {
  let result = await attempt(null);
  while (result.ok && result.value.status === "secrets_found") {
    const accepted = await show(repoId, result.value);
    if (!accepted) return { ok: false, error: new CoreError({ code: "cancelled", message: t("pushCheck.secrets.stopped"), gitOutput: null }) };
    result = await attempt(accepted);
  }
  return result;
}

/** AI state and the project's settings for the review before a push: from the cache, else loaded. */
export async function reviewContext(repoId: Id): Promise<{ status: AiStatus | undefined; repo: RepoSettings | undefined }> {
  const status =
    queryClient.getQueryData<AiStatus>(qk.aiStatus) ?? (await queryClient.fetchQuery({ queryKey: qk.aiStatus, queryFn: () => core.aiStatus() }).catch(() => undefined));
  const repo =
    queryClient.getQueryData<RepoSettings>(qk.repoSettings(repoId)) ??
    (await queryClient.fetchQuery({ queryKey: qk.repoSettings(repoId), queryFn: () => core.repoSettingsGet({ repoId }) }).catch(() => undefined));
  return { status, repo };
}

/** Settings › Project › Git "Report again". */
export async function forgetIgnoredFindings(repoId: Id): Promise<ActionResult<RepoSettings>> {
  const result = await runAction(t("pushCheck.ignored.action"), () => core.pushScanForget({ repoId }), { success: t("pushCheck.ignored.done") });
  if (result.ok) queryClient.setQueryData(qk.repoSettings(repoId), result.value);
  return result;
}
