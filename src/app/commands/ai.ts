/** "Set up AI …": opens Settings › AI – offered only while AI is not set up or not connected (spec 1.3). */
import type { AiStatus } from "../../core";
import { t } from "../../i18n";
import { openAiSettings } from "../ai/open";
import { aiVisibility } from "../ai/visibility";
import { kw, type AppCommand } from "../commandTypes";
import { qk } from "../queries";

export const commands: AppCommand[] = [
  {
    id: "ai.setup",
    title: t("ai.command.setup"),
    group: "Allgemein",
    keywords: kw("ai.command.keywords"),
    hidden: (ctx) => !aiVisibility(ctx.queryClient.getQueryData<AiStatus>(qk.aiStatus)).setupCommand,
    run: () => openAiSettings(),
  },
];
