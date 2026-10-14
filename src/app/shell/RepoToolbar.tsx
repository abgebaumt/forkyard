import {
  Archive,
  ArchiveRestore,
  ArrowDownToLine,
  ArrowUpFromLine,
  ChartColumn,
  CloudDownload,
  Command,
  GitBranchPlus,
  Redo2,
  Search,
  Settings as SettingsIcon,
  SquareTerminal,
  Undo2,
} from "lucide-react";
import type { Id, PullMode, Status } from "../../core";
import { Toolbar, ToolbarButton, ToolbarSeparator } from "../../ui/Chrome";
import type { MenuEntry } from "../../ui/Menu";
import { createBranch, selectedBranchStart } from "../actions/branches";
import { busyKeys } from "../actions/keys";
import { operationNames } from "../actions/merge";
import { popStash, stashChanges } from "../actions/stash";
import { addRemote, fetchAll, pull, pullModeHints, pullModeLabels, push, setDefaultPullMode } from "../actions/sync";
import { redo, undo } from "../actions/undo";
import { toggleStats } from "../../screens/Stats/actions";
import { useRemotes, useRepoSettings, useSettings, useStashes, useStatus, useUndoState } from "../queries";
import { useAppStore, useBusy, useTabView } from "../store";
import { t } from "../../i18n";

const icon = (Component: typeof Undo2) => <Component className="size-icon" aria-hidden />;

const NO_REMOTE = t("shell.toolbar.noRemote");

/** What about the checked-out state prevents an action that needs a branch – or null. */
function headBlocker(status: Status | undefined, what: "pull" | "push"): string | null {
  if (!status) return null;
  if (status.head.kind === "detached") return t("shell.toolbar.detached");
  if (status.head.kind === "unborn") return what === "push" ? t("shell.toolbar.noCommitToPush") : t("shell.toolbar.noCommit");
  return null;
}

const operationBlocker = (status: Status | undefined) => (status?.operation ? t("shell.toolbar.finishOperation", { operation: operationNames[status.operation.kind] }) : null);

/**
 * Toolbar of a repo tab. Disabled buttons stay focusable and name the reason:
 * no remote, no upstream, nothing to push, operation in progress, network action in progress.
 */
export function RepoToolbar({ repoId, tabId }: { repoId: Id; tabId: Id }) {
  const { data: status } = useStatus(repoId);
  const { data: remotes } = useRemotes(repoId);
  const { data: stashes } = useStashes(repoId);
  const { data: undoState } = useUndoState(repoId);
  const { data: settings } = useSettings();
  const { data: repoSettings } = useRepoSettings(repoId);
  const view = useTabView(tabId);
  const openOverlay = useAppStore((state) => state.openOverlay);
  const toggleTerminal = useAppStore((state) => state.toggleTerminal);
  const setSearchOpen = useAppStore((state) => state.setSearchOpen);

  const fetching = useBusy(busyKeys.fetch(repoId));
  const pulling = useBusy(busyKeys.pull(repoId));
  const pushing = useBusy(busyKeys.push(repoId));
  const stashing = useBusy(busyKeys.stash(repoId));
  const popping = useBusy(busyKeys.pop(repoId));
  const undoing = useBusy(busyKeys.undo(repoId));
  const branching = useBusy(busyKeys.branch(repoId));
  const rewriting = useBusy(busyKeys.history(repoId));

  const compact = settings ? !settings.toolbarLabels : false;
  const hasRemote = remotes ? remotes.length > 0 : undefined;
  const upstream = status?.upstream ?? null;
  const ahead = upstream?.ahead ?? 0;
  const behind = upstream?.behind ?? 0;
  const changes = status ? status.unstaged.length + status.staged.length : 0;
  const defaultMode: PullMode = repoSettings?.defaultPullMode ?? settings?.defaultPullMode ?? "ff";

  const operation = operationBlocker(status);
  // The core runs only one network action per repository at a time; the other buttons say what they are waiting for.
  const running = fetching ? "Fetch" : pulling ? "Pull" : pushing ? "Push" : null;
  const waitFor = (own: boolean) => (running && !own ? t("shell.toolbar.running", { action: running }) : null);
  const noRemote = hasRemote === false ? NO_REMOTE : null;

  const pullBlocked =
    noRemote ??
    headBlocker(status, "pull") ??
    operation ??
    (status && !upstream ? t("shell.toolbar.noUpstream") : upstream?.gone ? t("shell.toolbar.upstreamGone", { name: upstream.name }) : null) ??
    waitFor(pulling);
  const pushBlocked =
    noRemote ??
    headBlocker(status, "push") ??
    operation ??
    (upstream && !upstream.gone && ahead === 0 ? t("shell.toolbar.nothingToPush", { name: upstream.name }) : null) ??
    waitFor(pushing);
  const fetchBlocked = noRemote ?? waitFor(fetching);
  const branchBlocked = status?.head.kind === "unborn" ? t("shell.toolbar.noCommit") : operation;
  // Exactly one commit selected in the graph (not HEAD): the new branch starts there, as with Ctrl+B.
  const branchStart = selectedBranchStart(repoId, view.selection);
  const stashBlocked = !status
    ? null
    : status.head.kind === "unborn"
      ? t("shell.toolbar.stashNeedsCommit")
      : status.conflicted.length
        ? t("shell.toolbar.resolveConflicts")
        : changes === 0
          ? t("shell.toolbar.nothingToStash")
          : null;
  const popBlocked = stashes && stashes.length === 0 ? t("shell.toolbar.noStash") : status?.conflicted.length ? t("shell.toolbar.resolveConflicts") : null;
  const undoBlocked = undoState && !undoState.undo ? (undoState.undoBlocked ?? t("shell.toolbar.nothingToUndo")) : operation;
  const redoBlocked = undoState && !undoState.redo ? t("shell.toolbar.nothingToRedo") : operation;

  const pullMenu: MenuEntry[] = [
    { type: "label", label: t("shell.toolbar.pullModeLabel") },
    ...(["ff", "ff_only", "rebase"] as const).map(
      (mode): MenuEntry => ({
        label: pullModeLabels[mode],
        checked: mode === defaultMode,
        disabled: Boolean(pullBlocked),
        tooltip: pullBlocked ? `${pullModeLabels[mode]} – ${pullBlocked}` : `${pullModeLabels[mode]} – ${pullModeHints[mode]}`,
        onSelect: () => {
          void setDefaultPullMode(repoId, mode).then((result) => {
            if (result.ok) void pull(repoId, mode, tabId);
          });
        },
      }),
    ),
    { type: "separator" },
    { label: t("shell.toolbar.fetchAll"), shortcut: "Mod+Shift+L", disabled: Boolean(fetchBlocked), tooltip: fetchBlocked ?? undefined, onSelect: () => void fetchAll(repoId) },
    ...(hasRemote === false ? [{ label: t("shell.toolbar.addRemote"), onSelect: addRemote } satisfies MenuEntry] : []),
  ];

  const stashTop = stashes?.[0];

  return (
    <Toolbar>
      <ToolbarButton
        label={t("shell.toolbar.undo")}
        icon={icon(Undo2)}
        shortcut="Mod+Z"
        compact={compact}
        busy={undoing}
        disabled={Boolean(undoBlocked)}
        hint={undoBlocked ?? (undoState?.undo ? t("shell.toolbar.undoWhat", { label: undoState.undo.label }) : t("shell.toolbar.undoHint"))}
        onClick={() => void undo(repoId)}
      />
      <ToolbarButton
        label={t("shell.toolbar.redo")}
        icon={icon(Redo2)}
        shortcut="Mod+Y"
        compact={compact}
        busy={undoing}
        disabled={Boolean(redoBlocked)}
        hint={redoBlocked ?? (undoState?.redo ? t("shell.toolbar.redoWhat", { label: undoState.redo.label }) : t("shell.toolbar.redoHint"))}
        onClick={() => void redo(repoId)}
      />
      <ToolbarSeparator />
      <ToolbarButton
        label="Pull"
        icon={icon(ArrowDownToLine)}
        shortcut="Mod+Shift+D"
        compact={compact}
        busy={pulling}
        disabled={Boolean(pullBlocked)}
        hint={pullBlocked ?? (pulling ? t("shell.toolbar.pullRunning") : `${pullModeLabels[defaultMode]} – ${pullModeHints[defaultMode]}`)}
        badge={behind || undefined}
        badgeLabel={behind ? t("shell.toolbar.toPull", { count: behind }) : undefined}
        menu={pullMenu}
        onClick={() => void pull(repoId, null, tabId)}
      />
      <ToolbarButton
        label="Push"
        icon={icon(ArrowUpFromLine)}
        shortcut="Mod+Shift+P"
        compact={compact}
        busy={pushing}
        disabled={Boolean(pushBlocked)}
        hint={
          pushBlocked ??
          (pushing
            ? t("shell.toolbar.pushRunning")
            : upstream && !upstream.gone
              ? t("shell.toolbar.pushTo", { count: ahead, name: upstream.name })
              : t("shell.toolbar.pushNew"))
        }
        badge={ahead || undefined}
        badgeLabel={ahead ? t("shell.toolbar.toPush", { count: ahead }) : undefined}
        onClick={() => void push(repoId, { tabId })}
      />
      <ToolbarButton
        label="Fetch"
        icon={icon(CloudDownload)}
        shortcut="Mod+Shift+L"
        compact={compact}
        busy={fetching}
        disabled={Boolean(fetchBlocked)}
        hint={fetchBlocked ?? (fetching ? t("shell.toolbar.fetchRunning") : t("shell.toolbar.fetchHint"))}
        onClick={() => void fetchAll(repoId)}
      />
      <ToolbarSeparator />
      <ToolbarButton
        label="Branch"
        icon={icon(GitBranchPlus)}
        shortcut="Mod+B"
        compact={compact}
        busy={branching || rewriting}
        disabled={Boolean(branchBlocked)}
        hint={branchBlocked ?? (branchStart ? t("shell.toolbar.branchAt", { sha: branchStart.slice(0, 7) }) : t("shell.toolbar.branchHint"))}
        onClick={() => void createBranch(repoId, { start: branchStart, tabId })}
      />
      <ToolbarButton
        label="Stash"
        icon={icon(Archive)}
        shortcut="Alt+S"
        compact={compact}
        busy={stashing}
        disabled={Boolean(stashBlocked)}
        hint={stashBlocked ?? t("shell.toolbar.stashHint", { count: changes })}
        onClick={() => void stashChanges(repoId)}
      />
      <ToolbarButton
        label="Pop"
        icon={icon(ArchiveRestore)}
        shortcut="Alt+P"
        compact={compact}
        busy={popping}
        disabled={Boolean(popBlocked)}
        hint={popBlocked ?? (stashTop ? t("shell.toolbar.popWhat", { message: stashTop.message.length > 60 ? `${stashTop.message.slice(0, 59)}…` : stashTop.message }) : t("shell.toolbar.popHint"))}
        onClick={() => void popStash(repoId, stashTop ?? 0, tabId)}
      />
      <ToolbarSeparator />
      <ToolbarButton
        label="Terminal"
        icon={icon(SquareTerminal)}
        shortcut="Mod+`"
        compact={compact}
        pressed={view.terminalOpen}
        hint={view.terminalOpen ? t("shell.toolbar.terminalHide") : t("shell.toolbar.terminalShow")}
        onClick={() => toggleTerminal(tabId)}
      />
      <div className="flex-1" />
      <ToolbarButton
        label={t("shell.toolbar.stats")}
        icon={icon(ChartColumn)}
        compact={compact}
        pressed={view.center.kind === "stats"}
        hint={view.center.kind === "stats" ? t("shell.toolbar.statsHide") : t("shell.toolbar.statsHint")}
        onClick={() => toggleStats(tabId)}
      />
      <ToolbarButton
        label={t("shell.toolbar.search")}
        icon={icon(Search)}
        shortcut="Mod+F"
        compact={compact}
        pressed={view.searchOpen}
        hint={t("shell.toolbar.searchHint")}
        onClick={() => setSearchOpen(tabId, !view.searchOpen)}
      />
      <ToolbarButton
        label={t("shell.toolbar.commands")}
        icon={icon(Command)}
        shortcut="Mod+P"
        compact={compact}
        hint={t("shell.toolbar.palette")}
        onClick={() => openOverlay({ kind: "palette", mode: "all" })}
      />
      <ToolbarButton
        label={t("shell.toolbar.settings")}
        icon={icon(SettingsIcon)}
        shortcut="Mod+,"
        compact={compact}
        onClick={() => openOverlay({ kind: "preferences", section: "general" })}
      />
    </Toolbar>
  );
}

/** Toolbar in the repository management tab: without repo actions. */
export function ManagementToolbar() {
  const openOverlay = useAppStore((state) => state.openOverlay);
  const { data: settings } = useSettings();
  const compact = settings ? !settings.toolbarLabels : false;
  return (
    <Toolbar label={t("shell.toolbar.general")}>
      <div className="flex-1" />
      <ToolbarButton
        label={t("shell.toolbar.commands")}
        icon={icon(Command)}
        shortcut="Mod+P"
        compact={compact}
        hint={t("shell.toolbar.palette")}
        onClick={() => openOverlay({ kind: "palette", mode: "all" })}
      />
      <ToolbarButton
        label={t("shell.toolbar.settings")}
        icon={icon(SettingsIcon)}
        shortcut="Mod+,"
        compact={compact}
        onClick={() => openOverlay({ kind: "preferences", section: "general" })}
      />
    </Toolbar>
  );
}
