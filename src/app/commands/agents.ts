/** Commands of the coding-agent cockpit (src/screens/Agents). The start dialog is loaded on demand: it pulls in the terminal. */
import { t } from "../../i18n";
import { kw, type AppCommand, type CommandContext } from "../commandTypes";
import { openCockpit } from "../../screens/Agents/actions";
import { reviewAgentFromPalette } from "../../screens/AgentReview/actions";

const hasRepo = (ctx: CommandContext) => Boolean(ctx.repoId && ctx.tabId);

export const commands: AppCommand[] = [
  {
    id: "agents.new",
    title: t("agents.commands.new"),
    group: "Repository",
    shortcut: "Mod+Shift+A",
    keywords: kw("agents.commands.newKeywords"),
    when: hasRepo,
    run: async (ctx) => {
      const { openAgentStart } = await import("../../screens/Agents/StartDialog");
      await openAgentStart(ctx.repoId!, ctx.tabId!);
    },
  },
  {
    id: "agents.cockpit",
    title: t("agents.commands.cockpit"),
    group: "Repository",
    keywords: kw("agents.commands.cockpitKeywords"),
    when: hasRepo,
    run: (ctx) => openCockpit(ctx.tabId!),
  },
  {
    id: "agents.review",
    title: t("agents.commands.review"),
    group: "Repository",
    keywords: kw("agents.commands.reviewKeywords"),
    when: hasRepo,
    run: (ctx) => reviewAgentFromPalette(ctx.repoId!, ctx.tabId!),
  },
];
