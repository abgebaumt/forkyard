/** What the cockpit, the left section and the details panel can do with an agent. */
import { Copy, FlaskConical, GitPullRequestArrow, Play, Square, SquareTerminal, Trash2, X } from "lucide-react";
import { core, type Agent, type Id } from "../../core";
import { copyText } from "../../app/actions/clipboard";
import { openPrCreate } from "../../app/actions/pullrequests";
import { undo } from "../../app/actions/undo";
import { confirm } from "../../app/dialogs";
import { useAgentTemplates, useHostRepo, useRepoSettings } from "../../app/queries";
import { newJobId, runAction } from "../../app/run";
import { menuItem } from "../../components/SideSection";
import { toast } from "../../ui/Feedback";
import type { MenuEntry } from "../../ui/Menu";
import { t } from "../../i18n";
import { actionsFor, cleanupLines, type AgentAction } from "./model";
import { resumeAgent, showAgentTerminal } from "./session";

export const ACTION_LABELS: Record<AgentAction, string> = {
  terminal: t("agents.actions.terminal"),
  stop: t("agents.actions.stop"),
  resume: t("agents.actions.resume"),
  copyPath: t("agents.actions.copyPath"),
  tests: t("agents.actions.tests"),
  pr: t("agents.actions.pr"),
  cleanup: t("agents.actions.cleanup"),
  forget: t("agents.actions.forget"),
};

const ICONS = { terminal: SquareTerminal, stop: Square, resume: Play, copyPath: Copy, tests: FlaskConical, pr: GitPullRequestArrow, cleanup: Trash2, forget: X } as const;

export interface ActionOptions {
  canResume: boolean;
  hasTestCommand: boolean;
  hasHost: boolean;
}

/** The options `actionsFor` needs, from the templates, the project settings and the host. */
export function useActionOptions(repoId: Id): (agent: Agent) => ActionOptions {
  const templates = useAgentTemplates();
  const { data: repoSettings } = useRepoSettings(repoId);
  const { data: hostRepo } = useHostRepo(repoId);
  return (agent) => ({
    canResume: templates.data?.find((item) => item.id === agent.templateId)?.canResume ?? false,
    hasTestCommand: Boolean(repoSettings?.testCommand),
    hasHost: Boolean(hostRepo),
  });
}

async function cleanUp(agent: Agent): Promise<void> {
  const preview = await runAction(t("agents.cleanup.action"), () => core.agentCleanupPreview({ agentId: agent.id }));
  if (!preview.ok) return;
  if (preview.value.locked) {
    toast({ tone: "warning", title: t("agents.cleanup.locked") });
    return;
  }
  const ok = await confirm({
    title: t("agents.cleanup.title", { name: agent.shortName }),
    body: cleanupLines(preview.value)
      .map((line) => line.text)
      .join(" "),
    details: [agent.worktreePath, agent.branch],
    confirmLabel: t("agents.cleanup.confirm"),
    danger: true,
  });
  if (!ok) return;
  const result = await runAction(t("agents.cleanup.action"), () => core.agentCleanup({ agentId: agent.id }));
  if (result.ok) {
    toast({ tone: "info", title: t("agents.cleanup.done", { name: agent.shortName }), action: { label: t("agents.cleanup.undo"), onClick: () => void undo(agent.repoId) } });
  }
}

export async function runAgentAction(action: AgentAction, agent: Agent, tabId: Id): Promise<void> {
  switch (action) {
    case "terminal":
      showAgentTerminal(tabId, agent.id);
      return;
    case "stop":
      await runAction(t("agents.actions.stopAction"), () => core.agentStop({ agentId: agent.id }));
      return;
    case "resume":
      await runAction(t("agents.actions.resumeAction"), () => resumeAgent(tabId, agent));
      return;
    case "copyPath":
      await copyText(agent.worktreePath, t("agents.actions.copyPath"));
      return;
    case "tests": {
      const jobId = newJobId();
      await runAction(t("agents.actions.testsAction"), () => core.agentRunTests({ agentId: agent.id, jobId }), {
        job: { id: jobId, title: t("agents.actions.testsAction"), repoId: agent.repoId },
      });
      return;
    }
    case "pr":
      // The existing action: jumps to an already open pull request of the branch, otherwise the form.
      openPrCreate(agent.repoId, tabId, { source: agent.branch });
      return;
    case "cleanup":
      await cleanUp(agent);
      return;
    case "forget":
      await runAction(t("agents.actions.forgetAction"), () => core.agentForget({ agentId: agent.id }));
      return;
  }
}

export function agentMenu(agent: Agent, tabId: Id, options: ActionOptions): MenuEntry[] {
  return actionsFor(agent, options).map((action) =>
    menuItem(ACTION_LABELS[action], ICONS[action], () => void runAgentAction(action, agent, tabId), { danger: action === "cleanup", shortcut: action === "cleanup" ? "Delete" : undefined }),
  );
}
