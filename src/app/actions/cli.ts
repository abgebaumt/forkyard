/** "Install command-line command": links `forkyard` into a folder on the PATH where no installer does it. */
import { core } from "../../core";
import { t } from "../../i18n";
import { toast } from "../../ui/Feedback";
import { runAction } from "../run";

export async function installCli(): Promise<void> {
  const label = t("actions.cli.label");
  const status = await runAction(label, () => core.cliStatus());
  if (!status.ok) return;
  if (!status.value.installable) {
    toast({ tone: "info", title: t("actions.cli.managed"), description: t("actions.cli.managedHint") });
    return;
  }
  const result = await runAction(label, () => core.cliInstall());
  if (!result.ok) return;
  toast({
    tone: "success",
    title: t("actions.cli.installed", { path: result.value.linkPath ?? "" }),
    description: result.value.onPath ? t("actions.cli.ready") : t("actions.cli.notOnPath"),
    sticky: !result.value.onPath,
  });
}
