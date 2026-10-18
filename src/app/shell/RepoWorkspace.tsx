import { useLayoutEffect, useState } from "react";
import { FileCog, FolderX, PanelLeftOpen, PanelRightOpen, RefreshCw, ShieldAlert, SquareTerminal } from "lucide-react";
import type { Id, Tab } from "../../core";
import { Button, IconButton } from "../../ui/Button";
import { Cockpit } from "../../screens/Agents/Cockpit";
import { AgentDetailsPanel } from "../../screens/Agents/DetailsPanel";
import { BlameView } from "../../screens/Blame";
import { ArchaeologyPanel } from "../../screens/Archaeology";
import { AgentReviewView } from "../../screens/AgentReview";
import { ReviewCommitPanel } from "../../screens/AgentReview/CommitPanel";
import { CommitDetailsPanel } from "../../screens/CommitDetails";
import { CommitGraph } from "../../screens/CommitGraph";
import { CommitSearch } from "../../screens/CommitSearch";
import { ComposeView } from "../../screens/Compose";
import { ConflictTool } from "../../screens/ConflictTool";
import { DiffView } from "../../screens/DiffView";
import { FileHistory } from "../../screens/FileHistory";
import { FileView } from "../../screens/FileView";
import { LeftPanel } from "../../screens/LeftPanel";
import { PullRequestCreate } from "../../screens/PullRequestCreate";
import { PullRequestView } from "../../screens/PullRequestView";
import { IssuesView } from "../../screens/Issues";
import { StatsView } from "../../screens/Stats";
import { RebaseTool } from "../../screens/RebaseTool";
import { ReflogView } from "../../screens/Reflog";
import { StashForm } from "../../screens/StashForm";
import { TerminalPanel } from "../../screens/Terminal";
import { WipPanel } from "../../screens/WipPanel";
import { EmptyState } from "../../ui/Feedback";
import { closeTab, forgetRepo, openRepository } from "../actions/repos";
import { core } from "../../core";
import { qk, queryClient, trustKey, useRepo, useRepoLocked, useRepoMissing, useRepoTrust } from "../queries";
import { runAction } from "../run";
import { PANEL_LIMITS, showsSidePanels, useAppStore, useLeftCollapsed, useTabView, type CenterView, type TabView } from "../store";
import { FullPage } from "./FullPage";
import { Splitter } from "./Splitter";
import { t } from "../../i18n";

/** Minimum width of the centre and width of the strip of a collapsed panel. */
// 480 px: that is how wide the diff view's header needs to be for its buttons. With 320, when both
// panels were fully expanded, "Close diff", "Wrap" and "Stage hunk" ended up under the Commit Panel.
// This also works in the smallest window (960 px): 180 + 300 (minimum panel widths) + 480.
const CENTER_MIN = 480;
const RAIL_WIDTH = 28;

function Center({ repoId, tabId, center }: { repoId: Id; tabId: Id; center: CenterView }) {
  const props = { repoId, tabId };
  switch (center.kind) {
    case "graph":
      return <CommitGraph {...props} />;
    case "diff":
      return <DiffView {...props} path={center.path} source={center.source} />;
    case "file":
      return <FileView {...props} path={center.path} sha={center.sha} mode={center.mode} />;
    case "history":
      return <FileHistory {...props} path={center.path} />;
    case "blame":
      return <BlameView {...props} path={center.path} sha={center.sha} />;
    case "conflict":
      return <ConflictTool {...props} path={center.path} />;
    case "rebase":
      return <RebaseTool {...props} base={center.base} mode={center.mode} shas={center.shas} />;
    case "pr_create":
      return <PullRequestCreate {...props} />;
    case "pr":
      return <PullRequestView {...props} number={center.number} />;
    case "issues":
      return <IssuesView {...props} number={center.number} />;
    case "agent_review":
      return <AgentReviewView {...props} agentIds={center.agentIds} show={center.show} />;
    case "stats":
      return <StatsView {...props} />;
    case "cockpit":
      return <Cockpit {...props} />;
    case "reflog":
      return <ReflogView {...props} refName={center.ref} />;
    case "compose":
      return <ComposeView {...props} />;
  }
}

function RightPanel({ repoId, tabId, view }: { repoId: Id; tabId: Id; view: TabView }) {
  if (view.rightPanel === "archaeology" && view.archaeology) {
    const target = view.archaeology;
    return <ArchaeologyPanel key={`${target.path}|${target.line}|${target.sha ?? ""}`} repoId={repoId} tabId={tabId} target={target} />;
  }
  if (view.rightPanel === "agent") return <AgentDetailsPanel repoId={repoId} tabId={tabId} agentId={view.agentId} />;
  if (view.rightPanel === "review_commit" && view.center.kind === "agent_review") return <ReviewCommitPanel repoId={repoId} tabId={tabId} agentIds={view.center.agentIds} />;
  if (view.rightPanel === "stash_form") return <StashForm repoId={repoId} tabId={tabId} />;
  const selection = view.selection;
  if (!selection) {
    return (
      <div className="flex h-full items-center justify-center bg-surface">
        <EmptyState title={t("shell.workspace.nothingSelected")}>{t("shell.workspace.nothingSelectedHint")}</EmptyState>
      </div>
    );
  }
  if (selection.kind === "wip") return <WipPanel repoId={repoId} tabId={tabId} />;
  return <CommitDetailsPanel repoId={repoId} tabId={tabId} selection={selection} />;
}

/** Narrow strip in place of a collapsed panel, so it can be brought back by mouse and keyboard. */
function Rail({ side, onOpen }: { side: "left" | "right"; onOpen: () => void }) {
  return (
    <div
      data-rail={side}
      className={side === "left" ? "flex w-control-md shrink-0 flex-col items-center border-r border-border bg-surface pt-1" : "flex w-control-md shrink-0 flex-col items-center border-l border-border bg-surface pt-1"}
    >
      <IconButton
        size="sm"
        label={side === "left" ? t("shell.workspace.showLeft") : t("shell.workspace.showRight")}
        shortcut={side === "left" ? "Mod+J" : "Mod+K"}
        icon={side === "left" ? <PanelLeftOpen className="size-icon" aria-hidden /> : <PanelRightOpen className="size-icon" aria-hidden />}
        onClick={onOpen}
      />
    </div>
  );
}

function MissingRepo({ tab, repoId }: { tab: Tab; repoId: Id }) {
  const { data: repo } = useRepo(repoId);
  const name = repo?.alias ?? repo?.name ?? tab.title;
  const path = repo?.path ?? tab.path ?? "";
  return (
    <FullPage
      icon={<FolderX className="size-8" aria-hidden />}
      title={t("shell.workspace.missingTitle", { name })}
      details={path || null}
      actions={
        <>
          <Button
            icon={<RefreshCw className="size-icon" aria-hidden />}
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: qk.repos });
              void queryClient.invalidateQueries({ queryKey: qk.repo(repoId) });
            }}
          >
            {t("shell.workspace.recheck")}
          </Button>
          <Button variant="primary" onClick={() => void openRepository()}>
            {t("shell.workspace.chooseLocation")}
          </Button>
          <Button onClick={() => void forgetRepo({ id: repoId, name, alias: repo?.alias ?? null, path })}>{t("shell.workspace.removeFromList")}</Button>
          <Button variant="ghost" onClick={() => void closeTab(tab.id)}>
            {t("shell.tabMenu.close")}
          </Button>
        </>
      }
    >
      <p>{t("shell.workspace.missingText")}</p>
    </FullPage>
  );
}

/**
 * Prompt before working in a repository that brings its own commands (hooks, entries in its
 * `.git/config`). The core has not run anything there so far and only does so after consent.
 * The safe choice ("Close tab") comes first and has focus.
 */
function UntrustedRepo({ tab, repoId }: { tab: Tab; repoId: Id }) {
  const { data: repo } = useRepo(repoId);
  const trust = useRepoTrust(repoId);
  const [busy, setBusy] = useState(false);
  const name = repo?.alias ?? repo?.name ?? tab.title;
  const path = repo?.path ?? tab.path ?? "";
  const findings = trust.data?.findings ?? [];

  const agree = async () => {
    setBusy(true);
    const result = await runAction(t("shell.trust.action"), () => core.repoTrustSet({ repoId, trusted: true }));
    setBusy(false);
    if (!result.ok) return;
    // Everything that failed on the locked repository now reloads.
    void queryClient.invalidateQueries({ queryKey: qk.repos });
    void queryClient.invalidateQueries({ queryKey: qk.tabs });
    void queryClient.invalidateQueries({ queryKey: qk.repo(repoId) });
  };

  return (
    <main data-shell="untrusted" aria-label={t("shell.trust.label")} className="flex h-full justify-center overflow-auto bg-bg p-8 text-text">
      <div role="alert" className="flex h-fit w-full max-w-2xl flex-col gap-4">
        <div className="flex items-start gap-3">
          <ShieldAlert className="mt-0.5 size-8 shrink-0 text-warning" aria-hidden />
          <div className="min-w-0">
            <h1 className="text-xl font-semibold">{t("shell.trust.title", { name })}</h1>
            <p className="selectable mt-1 font-mono text-code break-all text-text-muted">{path}</p>
          </div>
        </div>
        <div className="flex flex-col gap-2 text-md text-text-muted">
          <p>{t("shell.trust.text1")}</p>
          <p>{t("shell.trust.text2")}</p>
        </div>

        <section aria-label={t("shell.trust.found")} className="rounded-md border border-border bg-surface">
          <h2 className="border-b border-border px-3 py-2 text-sm font-semibold text-text">
            {trust.isPending ? t("shell.trust.checking") : trust.isError ? t("shell.trust.checkFailed") : t("shell.trust.foundCount", { count: findings.length })}
          </h2>
          {trust.isError ? (
            <p className="px-3 py-2 text-md text-text-muted">{t("shell.trust.unreadable")}</p>
          ) : (
            <ul className="max-h-72 overflow-auto">
              {findings.map((finding) => (
                <li key={`${finding.kind}:${finding.name}:${finding.value ?? ""}`} className="flex gap-2 border-b border-border px-3 py-2 last:border-b-0">
                  {finding.kind === "hook" ? (
                    <SquareTerminal className="mt-0.5 size-icon shrink-0 text-text-muted" aria-hidden />
                  ) : (
                    <FileCog className="mt-0.5 size-icon shrink-0 text-text-muted" aria-hidden />
                  )}
                  <div className="min-w-0">
                    <p className="selectable font-mono text-code break-all text-text">
                      {finding.kind === "hook" ? t("shell.trust.hook", { name: finding.name }) : finding.name}
                      {finding.value ? <span className="text-text-muted"> = {finding.value}</span> : null}
                    </p>
                    <p className="text-sm text-text-muted">{finding.reason}</p>
                  </div>
                </li>
              ))}
              {!trust.isPending && findings.length === 0 ? (
                <li className="px-3 py-2 text-md text-text-muted">{t("shell.trust.nothingLeft")}</li>
              ) : null}
            </ul>
          )}
        </section>

        <div className="flex flex-wrap gap-2">
          <Button variant="primary" autoFocus onClick={() => void closeTab(tab.id)}>
            {t("shell.tabMenu.close")}
          </Button>
          <Button disabled={busy || trust.isPending} onClick={() => void agree()}>
            {t("shell.trust.trustAndOpen")}
          </Button>
          <Button variant="ghost" icon={<RefreshCw className="size-icon" aria-hidden />} onClick={() => void queryClient.invalidateQueries({ queryKey: trustKey(repoId) })}>
            {t("shell.workspace.recheck")}
          </Button>
          <Button variant="ghost" onClick={() => void forgetRepo({ id: repoId, name, alias: repo?.alias ?? null, path })}>
            {t("shell.workspace.removeFromList")}
          </Button>
        </div>
      </div>
    </main>
  );
}

/** Repo view: Left Panel | centre | Commit Panel, with drag handles. */
export function RepoWorkspace({ tab, repoId }: { tab: Tab; repoId: Id }) {
  const tabId = tab.id;
  const view = useTabView(tabId);
  const leftCollapsed = useLeftCollapsed(tabId);
  const leftWidth = useAppStore((state) => state.leftWidth);
  const rightWidth = useAppStore((state) => state.rightWidth);
  const store = useAppStore.getState;
  const locked = useRepoLocked(repoId);
  const missing = useRepoMissing(locked ? null : repoId);
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useLayoutEffect(() => {
    if (!container) return;
    const measure = () => setContainerWidth(container.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, [container]);

  if (locked) {
    return (
      <div className="min-h-0 flex-1">
        <UntrustedRepo tab={tab} repoId={repoId} />
      </div>
    );
  }
  if (missing) {
    return (
      <div className="min-h-0 flex-1">
        <MissingRepo tab={tab} repoId={repoId} />
      </div>
    );
  }

  // The centre keeps its minimum width: if the remembered panel widths do not fit the window,
  // they are only shortened for display – left first, then right. The preference stays remembered.
  let shownLeft = leftWidth;
  let shownRight = rightWidth;
  if (containerWidth > 0) {
    let over = (leftCollapsed ? RAIL_WIDTH : leftWidth) + (view.rightCollapsed ? RAIL_WIDTH : rightWidth) + CENTER_MIN - containerWidth;
    if (over > 0 && !leftCollapsed) {
      const cut = Math.min(over, leftWidth - PANEL_LIMITS.left.min);
      shownLeft -= cut;
      over -= cut;
    }
    if (over > 0 && !view.rightCollapsed) shownRight -= Math.min(over, rightWidth - PANEL_LIMITS.right.min);
  }

  // After collapsing or expanding by keyboard, focus should not fall into nowhere.
  const focusLater = (selector: string) => {
    requestAnimationFrame(() => container?.querySelector<HTMLElement>(selector)?.focus());
  };
  const toggleLeft = (next: string) => {
    store().toggleLeftPanel(tabId);
    focusLater(next);
  };
  const toggleRight = (next: string) => {
    store().toggleRightPanel(tabId);
    focusLater(next);
  };

  const panels = showsSidePanels(view);

  return (
    <div ref={setContainer} className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      {!panels ? null : leftCollapsed ? (
        <Rail side="left" onOpen={() => toggleLeft('[role="separator"][data-side="left"]')} />
      ) : (
        <>
          <aside data-area="left" aria-label={t("shell.workspace.left")} className="flex min-h-0 shrink-0 flex-col overflow-hidden border-r border-border bg-surface" style={{ width: shownLeft }}>
            <LeftPanel repoId={repoId} tabId={tabId} />
          </aside>
          <Splitter
            side="left"
            label={t("shell.workspace.leftWidth")}
            value={shownLeft}
            min={PANEL_LIMITS.left.min}
            max={PANEL_LIMITS.left.max}
            defaultValue={PANEL_LIMITS.left.default}
            grows="left"
            onChange={(width) => store().setLeftWidth(width)}
            onCollapse={() => toggleLeft('[data-rail="left"] button')}
          />
        </>
      )}

      {/* Centre column: the view, below it the terminal as a separate area (own height with handle, own stop for F6). */}
      <div className="flex min-h-0 min-w-80 flex-1 flex-col">
        <main data-area="center" aria-label={t("shell.workspace.center")} className="flex min-h-0 flex-1 flex-col bg-bg">
          {view.searchOpen ? <CommitSearch repoId={repoId} tabId={tabId} /> : null}
          <div className="min-h-0 flex-1">
            <Center repoId={repoId} tabId={tabId} center={view.center} />
          </div>
        </main>
        {view.terminalOpen ? <TerminalPanel repoId={repoId} tabId={tabId} /> : null}
      </div>

      {!panels ? null : view.rightCollapsed ? (
        <Rail side="right" onOpen={() => toggleRight('[role="separator"][data-side="right"]')} />
      ) : (
        <>
          <Splitter
            side="right"
            label={t("shell.workspace.rightWidth")}
            value={shownRight}
            min={PANEL_LIMITS.right.min}
            max={PANEL_LIMITS.right.max}
            defaultValue={PANEL_LIMITS.right.default}
            grows="right"
            onChange={(width) => store().setRightWidth(width)}
            onCollapse={() => toggleRight('[data-rail="right"] button')}
          />
          <aside data-area="right" aria-label={t("shell.workspace.right")} className="flex min-h-0 shrink-0 flex-col overflow-hidden border-l border-border bg-surface" style={{ width: shownRight }}>
            <RightPanel repoId={repoId} tabId={tabId} view={view} />
          </aside>
        </>
      )}
    </div>
  );
}
