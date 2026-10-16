/**
 * Start page: one muted text button "Set up AI features" while AI is not set up (spec 1.3,
 * Entscheidung 11). Not disabled (focusable with Tab, Enter and click open Settings › AI); gone
 * as soon as AI is on or was turned off on purpose.
 */
import { useAiStatus } from "../../app/queries";
import { openAiSettings } from "../../app/ai/open";
import { aiVisibility } from "../../app/ai/visibility";
import { Tip } from "../../ui/Tooltip";
import { t } from "../../i18n";

export function AiSetupEntry() {
  const { data: status } = useAiStatus();
  if (!aiVisibility(status).startEntry) return null;
  return (
    <Tip label={t("ai.entry.tooltip")}>
      <button
        type="button"
        data-ai-setup-entry
        onClick={() => openAiSettings()}
        className="inline-flex h-control-md items-center rounded-md px-3 text-base text-text-muted hover:bg-surface-raised hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
      >
        {t("ai.entry.label")}
      </button>
    </Tip>
  );
}
