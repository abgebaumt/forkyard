/** Right panel for the agent selected in the cockpit or the left section (`RightPanel = "agent"`). */
import type { ReactNode } from "react";
import type { Id } from "../../core";
import { formatDateTime } from "../../app/format";
import { useAgents } from "../../app/queries";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/Feedback";
import { t } from "../../i18n";
import { actionsFor, displayName, formatRuntime, statusOrigin, testLabel } from "./model";
import { StatusWord } from "./parts";
import { ACTION_LABELS, runAgentAction, useActionOptions } from "./rowActions";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-semibold tracking-wide text-text-muted uppercase">{label}</dt>
      <dd className="selectable min-w-0 text-sm break-words text-text">{children}</dd>
    </div>
  );
}

export function AgentDetailsPanel({ repoId, tabId, agentId }: { repoId: Id; tabId: Id; agentId: Id | null }) {
  const agents = useAgents(repoId);
  const optionsFor = useActionOptions(repoId);
  const agent = agents.data?.find((item) => item.id === agentId);
  if (!agent) {
    return (
      <div data-panel="agent" className="flex h-full items-center justify-center bg-surface">
        <EmptyState title={t("agents.panel.gone")} />
      </div>
    );
  }
  const tests = testLabel(agent.test);
  return (
    <section data-panel="agent" aria-label={t("agents.panel.title")} className="flex h-full min-h-0 flex-col gap-3 overflow-auto bg-surface p-3">
      <h2 className="text-base font-semibold text-text">{displayName(agent)}</h2>
      <dl className="flex flex-col gap-2">
        <Field label={t("agents.panel.status")}>
          <StatusWord status={agent.status} origin={statusOrigin(agent)} />
        </Field>
        <Field label={t("agents.panel.template")}>{agent.templateName}</Field>
        <Field label={t("agents.panel.task")}>
          <span className="whitespace-pre-wrap">{agent.task}</span>
        </Field>
        <Field label={t("agents.panel.branch")}>
          <span className="font-mono text-code">{agent.branch}</span>
        </Field>
        <Field label={t("agents.panel.base")}>
          <span className="font-mono text-code">{agent.base}</span>
        </Field>
        <Field label={t("agents.panel.folder")}>
          <span className="font-mono text-code break-all">{agent.worktreePath}</span>
        </Field>
        <Field label={t("agents.panel.started")}>{formatDateTime(Date.parse(agent.startedAt))}</Field>
        {agent.endedAt ? <Field label={t("agents.panel.ended")}>{formatDateTime(Date.parse(agent.endedAt))}</Field> : null}
        <Field label={t("agents.panel.runtime")}>{formatRuntime(agent.startedAt, agent.endedAt, Date.now())}</Field>
        <Field label={t("agents.panel.changes")}>
          {t("agents.cockpit.changed", { count: agent.changedFiles })} · {t("agents.cockpit.ahead", { count: agent.commitsAhead, base: agent.base })}
        </Field>
        {tests ? (
          <Field label={t("agents.panel.tests")}>
            {tests}
            {agent.test?.output ? (
              <pre aria-label={t("agents.panel.testOutput")} className="mt-1 max-h-60 overflow-auto rounded-sm bg-surface-sunken p-2 font-mono text-code whitespace-pre-wrap">
                {agent.test.output}
              </pre>
            ) : null}
          </Field>
        ) : null}
      </dl>
      <div className="flex flex-wrap gap-2">
        {actionsFor(agent, optionsFor(agent)).map((action) => (
          <Button key={action} size="sm" variant={action === "cleanup" ? "danger" : "secondary"} data-action={action} onClick={() => void runAgentAction(action, agent, tabId)}>
            {ACTION_LABELS[action]}
          </Button>
        ))}
      </div>
    </section>
  );
}
