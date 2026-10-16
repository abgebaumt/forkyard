/**
 * Runs once in the shell and follows the agents of every open repository tab – active or not –
 * and of every repository that reported agents: terminal tabs learn which agent waits, an agent
 * that starts waiting, finishes or fails is announced politely (failed: assertively) and, when the
 * window is not in front, reported as a system notification. Never moves the focus.
 */
import { useCallback, useEffect, useState } from "react";
import type { Id, Tab } from "../../core";
import { desktopNotify } from "../../app/notify";
import { useAgents, useRepo } from "../../app/queries";
import { useAppStore } from "../../app/store";
import { t } from "../../i18n";
import { createStatusMemory, displayName, statusLabel, watchedRepos, type StatusChange } from "./model";
import { syncAgentSessions } from "./session";

/** For the whole session: a repository's baseline survives its watcher being unmounted. */
const memory = createStatusMemory();

type Announce = (text: string, assertive: boolean) => void;

function RepoAgentWatch({ repoId, announce }: { repoId: Id; announce: Announce }) {
  const agents = useAgents(repoId);
  const { data: repo } = useRepo(repoId);

  useEffect(() => {
    const list = agents.data;
    if (!list) return;
    syncAgentSessions(list);
    const changes: StatusChange[] = memory.observe(repoId, list);
    for (const change of changes) {
      const name = displayName(change.agent);
      announce(t("agents.cockpit.announce", { name, status: statusLabel(change.agent.status) }), change.kind === "failed");
      const title = change.kind === "waiting" ? t("agents.notify.waiting", { name }) : change.kind === "done" ? t("agents.notify.done", { name }) : t("agents.notify.failed", { name });
      desktopNotify(true, title, t("agents.notify.body", { repo: repo?.alias ?? repo?.name ?? "", branch: change.agent.branch }));
    }
    // A second run with the same list (e.g. once `repo` has loaded) reports nothing again.
  }, [agents.data, repo, repoId, announce]);

  return null;
}

export function AgentWatch({ tabs }: { tabs: Tab[] }) {
  const agentRepos = useAppStore((state) => state.agentRepos);
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");
  const announce = useCallback<Announce>((text, loud) => (loud ? setAssertive(text) : setPolite(text)), []);

  return (
    <>
      {watchedRepos(tabs, agentRepos).map((repoId) => (
        <RepoAgentWatch key={repoId} repoId={repoId} announce={announce} />
      ))}
      <p className="sr-only" aria-live="polite" data-agent-live="polite">
        {polite}
      </p>
      <p className="sr-only" aria-live="assertive" data-agent-live="assertive">
        {assertive}
      </p>
    </>
  );
}
