/**
 * Pushing the parts of a stack: one atomic push through the core, guarded by the secret scan like
 * every push – a key in any part stops it until "Push anyway".
 */
import { core, type Id, type Sha } from "../../core";
import { guardSecrets, type ShowFindings } from "../../app/actions/pushCheck";
import { newJobId, runAction } from "../../app/run";
import { t } from "../../i18n";
import { showSecretFindings } from "../PushCheck/SecretDialog";
import { busyKeys } from "../../app/actions/keys";

export function pushStack(
  repoId: Id,
  branches: string[],
  remote: string,
  force: boolean,
  expected: (Sha | null)[] | null,
  show: ShowFindings = showSecretFindings,
) {
  return guardSecrets(
    repoId,
    (acceptedSecrets) => {
      const jobId = newJobId();
      return runAction(
        t("pullRequest.stack.pushAction"),
        () => core.stackPush({ repoId, jobId, branches, remote, force, expected, acceptedSecrets }),
        {
          busyKey: busyKeys.push(repoId),
          job: { id: jobId, title: t("pullRequest.stack.pushAction"), repoId },
        },
      );
    },
    show,
  );
}
