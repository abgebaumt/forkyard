/** "Agents" section in the left panel, after "Worktrees": short name, status (dot + word), changed files, runtime. */
import { Bot, LayoutList, Plus } from "lucide-react";
import type { Id } from "../../core";
import { useAgents, useViewState } from "../../app/queries";
import { useAppStore } from "../../app/store";
import { MENU_SEPARATOR, menuItem, SideEmpty, SideLoadError, SideSection, SideSkeleton } from "../../components/SideSection";
import { IconButton, Button } from "../../ui/Button";
import { TreeRow } from "../../ui/Git";
import { t } from "../../i18n";
import { EMPTY_VIEW, sectionState, setSection } from "../LeftPanel/viewState";
import { openCockpit } from "./actions";
import { startNewAgent } from "./Cockpit";
import { displayName, formatRuntime, sortAgents, statusLabel } from "./model";
import { StatusDot } from "./parts";
import { agentMenu, runAgentAction, useActionOptions } from "./rowActions";

export function AgentsSection({ repoId, tabId, query }: { repoId: Id; tabId: Id; query: string }) {
  const agents = useAgents(repoId);
  const viewQuery = useViewState(repoId);
  const view = viewQuery.data ?? EMPTY_VIEW;
  const state = sectionState(view, "agents");
  const optionsFor = useActionOptions(repoId, agents.data ?? []);
  if (state.hidden) return null;
  const all = sortAgents(agents.data ?? []);
  const filtering = query.trim().length > 0;
  const needle = query.trim().toLowerCase();
  const items = filtering ? all.filter((agent) => agent.shortName.includes(needle) || agent.branch.toLowerCase().includes(needle)) : all;
  if (filtering && items.length === 0) return null;
  const open = filtering ? true : !state.collapsed;
  const toggle = () => {
    if (filtering || !viewQuery.data) return;
    void setSection(repoId, "agents", { collapsed: !state.collapsed });
  };
  const placeholder = agents.isPending ? (
    <SideSkeleton rows={1} />
  ) : agents.isError && !agents.data ? (
    <SideLoadError title={t("agents.section.loadError")} error={agents.error} onRetry={() => void agents.refetch()} />
  ) : all.length === 0 ? (
    <SideEmpty
      action={
        <Button size="sm" variant="ghost" onClick={() => void startNewAgent(repoId, tabId)}>
          {t("agents.section.new")}
        </Button>
      }
    >
      {t("agents.section.empty")}
    </SideEmpty>
  ) : undefined;
  return (
    <SideSection
      id="agents"
      title={t("agents.section.title")}
      icon={<Bot aria-hidden />}
      count={agents.isPending ? undefined : filtering ? `${items.length}/${all.length}` : all.length}
      open={open}
      onToggle={toggle}
      listLabel={t("agents.section.title")}
      items={items}
      itemId={(agent) => agent.id}
      itemText={(agent) => agent.shortName}
      renderRow={(agent, rowState) => (
        <TreeRow
          key={agent.id}
          {...rowState.attrs}
          label={displayName(agent)}
          icon={<StatusDot status={agent.status} />}
          selected={rowState.selected}
          focusable={rowState.focusable}
          meta={
            <span className="truncate text-xs text-text-muted" data-agent-status={agent.status}>
              {[statusLabel(agent.status), t("agents.cockpit.changed", { count: agent.changedFiles }), formatRuntime(agent.startedAt, agent.endedAt, Date.now())].join(" · ")}
            </span>
          }
          metaFills
          data-kind="agent"
          data-agent={agent.id}
          aria-label={`${displayName(agent)}, ${statusLabel(agent.status)}`}
        />
      )}
      onActivate={(agent) => useAppStore.getState().showAgent(tabId, agent.id)}
      onRemove={(agent) => void runAgentAction(agent.status === "orphaned" ? "forget" : "cleanup", agent, tabId)}
      rowMenu={(agent) => agentMenu(agent, tabId, optionsFor(agent))}
      sectionMenu={[
        menuItem(open ? t("agents.section.collapse") : t("agents.section.expand"), null, toggle, { blocked: filtering ? t("agents.section.alwaysOpen") : null }),
        menuItem(t("agents.section.hide"), null, () => void setSection(repoId, "agents", { hidden: true }), { hint: t("agents.section.hideHint") }),
        MENU_SEPARATOR,
        menuItem(t("agents.commands.cockpit"), LayoutList, () => openCockpit(tabId)),
        menuItem(t("agents.section.new"), Plus, () => void startNewAgent(repoId, tabId)),
      ]}
      // Spec 2a: the section ends with the row “New agent …” (the empty state has its own button).
      footer={
        all.length > 0 && !filtering ? (
          <Button size="sm" variant="ghost" className="w-full justify-start" data-action="new-agent-row" onClick={() => void startNewAgent(repoId, tabId)}>
            {t("agents.section.new")}
          </Button>
        ) : undefined
      }
      placeholder={placeholder}
      actions={
        <>
          <IconButton size="sm" data-action="cockpit" label={t("agents.commands.cockpit")} icon={<LayoutList className="size-3.5" aria-hidden />} onClick={() => openCockpit(tabId)} />
          <IconButton size="sm" data-action="add" label={t("agents.section.new")} icon={<Plus className="size-3.5" aria-hidden />} onClick={() => void startNewAgent(repoId, tabId)} />
        </>
      }
    />
  );
}
