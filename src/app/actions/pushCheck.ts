/**
 * The push check (v1.2, spec 6.2) on the UI side. Every push action runs through `guardSecrets`:
 * the core's secret scan stops a push with `secrets_found`, the dialog shows the findings, and only
 * "Push anyway" repeats the push with exactly those finding IDs (the core scans again; a new finding
 * asks again). "Back" ends like a cancelled action – silently, nothing was sent.
 */
import { CoreError, type Id, type PushResult } from "../../core";
import { t } from "../../i18n";
import type { ActionResult } from "../run";
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
