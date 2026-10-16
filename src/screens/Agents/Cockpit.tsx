/**
 * The agent cockpit in the centre (`CenterView { kind: "cockpit" }`): every coding agent of the
 * repository with status (dot + word, and whether the agent reported it or it is guessed), branch,
 * changed files (live through the worktree's watcher), commits ahead of the base, runtime and test
 * result. Keys: ↑/↓/Home/End select, Enter shows the details, menu key or Shift+F10 the actions,
 * Delete cleans up, Esc goes back. Nothing here moves the focus by itself after it opened.
 */
import { Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Agent, Id } from "../../core";
import { hasOpenDialog } from "../../app/dialogs";
import { describeError } from "../../app/errors";
import { openMenuAt, openMenuAtElement } from "../../app/menus/host";
import { useAgents } from "../../app/queries";
import { useAppStore } from "../../app/store";
import { viewMayTakeFocus } from "../../app/viewFocus";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";
import { Banner, EmptyState } from "../../ui/Feedback";
import { t } from "../../i18n";
import { isPlainEscape, ownsKey } from "../FileView/parts";
import { closeCockpit } from "./actions";
import { actionsFor, displayName, formatRuntime, hasSession, sortAgents, statusOrigin, testLabel } from "./model";
import { StatusWord } from "./parts";
import { ACTION_LABELS, agentMenu, runAgentAction, useActionOptions } from "./rowActions";

/** Re-renders every second while an agent runs (runtime). */
function useSecondTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

export async function startNewAgent(repoId: Id, tabId: Id): Promise<void> {
  const { openAgentStart } = await import("./StartDialog");
  await openAgentStart(repoId, tabId);
}

function AgentRow({ agent, tabId, active, onFocus, now, options }: { agent: Agent; tabId: Id; active: boolean; onFocus: () => void; now: number; options: ReturnType<ReturnType<typeof useActionOptions>> }) {
  const actions = actionsFor(agent, options);
  const primary = actions.find((action) => action === "terminal" || action === "resume" || action === "forget") ?? null;
  const tests = testLabel(agent.test);
  return (
    <li className="flex min-w-0 items-center gap-3 border-b border-border px-4 py-2 last:border-b-0">
      <div
        role="button"
        tabIndex={active ? 0 : -1}
        data-agent-row={agent.id}
        data-status={agent.status}
        aria-label={`${displayName(agent)}, ${agent.templateName}`}
        className={cn("flex min-w-0 flex-1 flex-col gap-0.5 rounded-sm focus-visible:outline-2 focus-visible:outline-accent", active && "bg-surface-sunken")}
        onFocus={onFocus}
        onClick={() => useAppStore.getState().showAgent(tabId, agent.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          openMenuAt({ x: event.clientX, y: event.clientY }, agentMenu(agent, tabId, options), displayName(agent));
        }}
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className="truncate text-base font-medium text-text">{displayName(agent)}</span>
          <span className="shrink-0 text-sm text-text-muted">{agent.templateName}</span>
          <StatusWord status={agent.status} origin={statusOrigin(agent)} />
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-3 text-sm text-text-muted">
          <span className="font-mono text-code">{agent.branch}</span>
          <span>{t("agents.cockpit.changed", { count: agent.changedFiles })}</span>
          <span>{t("agents.cockpit.ahead", { count: agent.commitsAhead, base: agent.base })}</span>
          <span className="tabular-nums">{formatRuntime(agent.startedAt, agent.endedAt, now)}</span>
          {tests ? <span data-agent-test={agent.test?.state}>{tests}</span> : null}
          {agent.status === "failed" && agent.exitCode !== null ? <span>{t("agents.cockpit.exitCode", { code: agent.exitCode })}</span> : null}
        </span>
        {agent.status === "failed" && agent.lastLine ? <span className="selectable truncate font-mono text-code text-text-muted">{t("agents.cockpit.lastLine", { line: agent.lastLine })}</span> : null}
      </div>
      {primary ? (
        <Button size="sm" data-action={primary} onClick={() => void runAgentAction(primary, agent, tabId)}>
          {ACTION_LABELS[primary]}
        </Button>
      ) : null}
      <Button size="sm" variant="ghost" data-action="menu" aria-haspopup="menu" onClick={(event) => openMenuAtElement(event.currentTarget, agentMenu(agent, tabId, options), displayName(agent))}>
        …<span className="sr-only">{t("agents.actions.details")}</span>
      </Button>
    </li>
  );
}

export function Cockpit({ repoId, tabId }: { repoId: Id; tabId: Id }) {
  const agents = useAgents(repoId);
  const optionsFor = useActionOptions(repoId);
  const list = useMemo(() => sortAgents(agents.data ?? []), [agents.data]);
  const now = useSecondTick(list.some(hasSession));
  const [activeId, setActiveId] = useState<Id | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const active = list.find((agent) => agent.id === activeId) ?? list[0] ?? null;

  // Once when it opens (by the user): the list gets the focus – not while a dialog is open.
  useEffect(() => {
    if (viewMayTakeFocus()) listRef.current?.querySelector<HTMLElement>("[data-agent-row]")?.focus();
  }, [agents.isSuccess]);

  const focusRow = (agent: Agent | undefined) => {
    if (!agent) return;
    setActiveId(agent.id);
    listRef.current?.querySelector<HTMLElement>(`[data-agent-row="${CSS.escape(agent.id)}"]`)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (isPlainEscape(event.nativeEvent) && !hasOpenDialog()) {
      event.preventDefault();
      closeCockpit(tabId);
      return;
    }
    if (!ownsKey(event.nativeEvent, hasOpenDialog()) || !active) return;
    const index = list.findIndex((agent) => agent.id === active.id);
    const options = optionsFor(active);
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusRow(list[Math.min(list.length - 1, index + 1)]);
        return;
      case "ArrowUp":
        event.preventDefault();
        focusRow(list[Math.max(0, index - 1)]);
        return;
      case "Home":
        event.preventDefault();
        focusRow(list[0]);
        return;
      case "End":
        event.preventDefault();
        focusRow(list[list.length - 1]);
        return;
      case "Enter":
        event.preventDefault();
        useAppStore.getState().showAgent(tabId, active.id);
        return;
      case "Delete":
        event.preventDefault();
        if (actionsFor(active, options).includes("cleanup")) void runAgentAction("cleanup", active, tabId);
        else if (actionsFor(active, options).includes("forget")) void runAgentAction("forget", active, tabId);
        return;
      case "ContextMenu":
      case "F10":
        if (event.key === "F10" && !event.shiftKey) return;
        event.preventDefault();
        openMenuAtElement(event.target as Element, agentMenu(active, tabId, options), displayName(active));
        return;
    }
  };

  return (
    <section data-screen="cockpit" aria-labelledby="cockpit-title" className="flex h-full min-h-0 flex-col bg-bg" onKeyDown={onKeyDown}>
      <header className="flex items-center gap-3 border-b border-border px-4 py-2">
        <h1 id="cockpit-title" className="text-lg font-semibold text-text">
          {t("agents.cockpit.title")}
        </h1>
        <span className="flex-1" />
        <Button size="sm" icon={<Plus className="size-icon" aria-hidden />} onClick={() => void startNewAgent(repoId, tabId)} data-action="new-agent">
          {t("agents.cockpit.new")}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => closeCockpit(tabId)}>
          {t("agents.cockpit.back")}
        </Button>
      </header>
      {agents.isError ? (
        <div className="p-4">
          <Banner tone="danger" title={t("agents.section.loadError")}>
            {describeError(agents.error).text}
          </Banner>
        </div>
      ) : list.length === 0 && agents.isSuccess ? (
        <EmptyState
          title={t("agents.cockpit.empty")}
          action={
            <Button variant="primary" onClick={() => void startNewAgent(repoId, tabId)}>
              {t("agents.cockpit.new")}
            </Button>
          }
        >
          {t("agents.cockpit.emptyHint")}
        </EmptyState>
      ) : (
        <ul ref={listRef} aria-label={t("agents.cockpit.listLabel")} className="min-h-0 flex-1 overflow-auto">
          {list.map((agent) => (
            <AgentRow key={agent.id} agent={agent} tabId={tabId} active={active?.id === agent.id} onFocus={() => setActiveId(agent.id)} now={now} options={optionsFor(agent)} />
          ))}
        </ul>
      )}
    </section>
  );
}
