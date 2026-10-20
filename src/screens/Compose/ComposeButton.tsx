/** "Compose …" narrow and as tall as the commit button, to its right in the Commit Panel – only where the AI element is visible. */
import type { Id } from "../../core";
import { useAiStatus, useRepoSettings, useStatus } from "../../app/queries";
import { Button } from "../../ui/Button";
import { Tip } from "../../ui/Tooltip";
import { t } from "../../i18n";
import { composeVisible, hasChanges, startCompose } from "./actions";

export function ComposeButton({ repoId, tabId }: { repoId: Id; tabId: Id }) {
  const { data: ai } = useAiStatus();
  const { data: repoSettings } = useRepoSettings(repoId);
  const { data: status } = useStatus(repoId);
  if (!composeVisible(ai, repoSettings)) return null;
  const nothing = !hasChanges(status);
  return (
    <Tip label={nothing ? t("wip.compose.nothing") : t("wip.compose.openTip")}>
      <Button
        type="button"
        variant="secondary"
        size="lg"
        data-compose-open=""
        {...(nothing ? { "aria-disabled": true } : {})}
        className="shrink-0 px-2! text-sm! aria-disabled:cursor-default aria-disabled:text-text-disabled"
        onClick={() => {
          if (!nothing) startCompose(tabId);
        }}
      >
        {t("wip.compose.open")}
      </Button>
    </Tip>
  );
}
