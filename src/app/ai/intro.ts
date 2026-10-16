/**
 * One-time notice after the update to 1.2 (spec 1.3): only in "unset", only when the upgrade step
 * set `ai.introPending`, once per start, without a time limit. "Set up …" and "Close" both clear
 * the marker; closing the toast with × only hides it for this run.
 */
import { useEffect } from "react";
import { core, type AiStatus } from "../../core";
import { toast } from "../../ui/Feedback";
import { t } from "../../i18n";
import { qk, queryClient, useAiStatus } from "../queries";
import { openAiSettings } from "./open";

let shown = false;

async function dismiss(): Promise<void> {
  try {
    queryClient.setQueryData(qk.aiStatus, await core.aiIntroDismiss());
  } catch {
    // Not cleared: the notice comes once more on the next start.
  }
}

export function maybeShowAiIntro(status: AiStatus | undefined): boolean {
  if (shown || !status || status.state !== "unset" || !status.introPending) return false;
  shown = true;
  toast({
    tone: "info",
    sticky: true,
    title: t("ai.intro.title"),
    action: {
      label: t("ai.intro.setup"),
      onClick: () => {
        openAiSettings();
        void dismiss();
      },
    },
    secondaryAction: { label: t("ai.intro.close"), onClick: () => void dismiss() },
  });
  return true;
}

/** Mount once in the shell; `ready` once the session (tabs) is loaded. */
export function useAiIntro(ready: boolean): void {
  const { data } = useAiStatus();
  useEffect(() => {
    if (ready) maybeShowAiIntro(data);
  }, [ready, data]);
}

export function resetAiIntroForTests(): void {
  shown = false;
}
