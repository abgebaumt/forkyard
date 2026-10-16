/**
 * Runs in every repository tab: takes over each new agent list – terminal tabs learn which agent
 * waits, an agent that starts waiting, finishes or fails is announced politely (failed: assertively)
 * and, when the window is not in front, reported as a system notification. Never moves the focus.
 */
import { useEffect, useRef, useState } from "react";
import type { AgentStatus, Id } from "../../core";
import { desktopNotify } from "../../app/notify";
import { useAgents, useRepo } from "../../app/queries";
import { t } from "../../i18n";
import { displayName, statusChanges, statusLabel } from "./model";
import { syncAgentSessions } from "./session";

export function AgentWatch({ repoId }: { repoId: Id; tabId: Id }) {
  const agents = useAgents(repoId);
  const { data: repo } = useRepo(repoId);
  const before = useRef<Map<Id, AgentStatus> | null>(null);
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");

  useEffect(() => {
    const list = agents.data;
    if (!list) return;
    syncAgentSessions(list);
    const changes = before.current ? statusChanges(before.current, list) : [];
    before.current = new Map(list.map((agent) => [agent.id, agent.status]));
    for (const change of changes) {
      const name = displayName(change.agent);
      const text = t("agents.cockpit.announce", { name, status: statusLabel(change.agent.status) });
      if (change.kind === "failed") setAssertive(text);
      else setPolite(text);
      const title = change.kind === "waiting" ? t("agents.notify.waiting", { name }) : change.kind === "done" ? t("agents.notify.done", { name }) : t("agents.notify.failed", { name });
      desktopNotify(true, title, t("agents.notify.body", { repo: repo?.alias ?? repo?.name ?? "", branch: change.agent.branch }));
    }
  }, [agents.data, repo]);

  return (
    <>
      <p className="sr-only" aria-live="polite" data-agent-live="polite">
        {polite}
      </p>
      <p className="sr-only" aria-live="assertive" data-agent-live="assertive">
        {assertive}
      </p>
    </>
  );
}
