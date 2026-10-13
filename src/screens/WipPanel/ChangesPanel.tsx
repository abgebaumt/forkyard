import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { Trans } from "react-i18next";
import { ChevronDown, CircleCheck, FilePlus2, Minus, Plus, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { CoreError, type ConflictKind, type DiffSource, type FileChange, type Id, type Status } from "../../core";
import { abortOperation, continueOperation, operationNames } from "../../app/actions/merge";
import { createBranch } from "../../app/actions/branches";
import { describeError } from "../../app/errors";
import { openMergeTool } from "../../app/actions/tools";
import { fileMenu } from "../../app/menus";
import { useStatus } from "../../app/queries";
import { getTabView, useAppStore, useBusy } from "../../app/store";
import { FileLayoutSwitch, FileList, type FileSelectModifiers } from "../../components/FileList";
import { Button, IconButton } from "../../ui/Button";
import { Banner, EmptyState } from "../../ui/Feedback";
import { SegmentedControl } from "../../ui/Field";
import { PanelSection } from "../../ui/Git";
import { DropdownMenu, type MenuEntry } from "../../ui/Menu";
import { Tip } from "../../ui/Tooltip";
import { cn } from "../../ui/cn";
import { t } from "../../i18n";
import {
  conflictSides,
  discardEverything,
  discardFiles,
  resolveConflicts,
  stageEverything,
  stageFiles,
  unstageEverything,
  unstageFiles,
  wipBusy,
  type SideNames,
} from "./actions";
import { getDraft, joinMessage, splitMessage } from "./draft";
import { SPLIT_LIMITS, getWipTab, useWipStore, useWipTab, type WipArea } from "./state";

export type PanelMode = "commit" | "stash";

export interface ChangesPanelProps {
  repoId: Id;
  tabId: Id;
  mode: PanelMode;
  /** Form below the lists: commit or stash. */
  footer: ReactNode;
}

const SOURCES: Record<Exclude<WipArea, "conflicts">, DiffSource> = { unstaged: { kind: "unstaged" }, staged: { kind: "staged" } };

/** Section whose content fills the free space and scrolls on its own. */
const SECTION = "flex min-h-14 flex-col *:data-[state=open]:min-h-0 *:data-[state=open]:flex-1 *:data-[state=open]:overflow-y-auto";

function conflictText(kind: ConflictKind | null, sides: SideNames): string {
  switch (kind) {
    case "both_modified":
      return t("wip.conflict.bothModified");
    case "both_added":
      return t("wip.conflict.bothAdded");
    case "both_deleted":
      return t("wip.conflict.bothDeleted");
    case "deleted_by_us":
      return t("wip.conflict.deletedIn", { side: sides.ours });
    case "deleted_by_them":
      return t("wip.conflict.deletedIn", { side: sides.theirs });
    case "added_by_us":
      return t("wip.conflict.addedIn", { side: sides.ours });
    case "added_by_them":
      return t("wip.conflict.addedIn", { side: sides.theirs });
    default:
      return t("wip.conflict.generic");
  }
}

function operationTitle(status: Status): string {
  const operation = status.operation;
  if (!operation && status.foreignOperation === "am") return t("wip.operation.foreignAm");
  if (!operation) return t("wip.operation.stashConflicts");
  const step = operation.step && operation.totalSteps ? t("wip.operation.step", { step: operation.step, total: operation.totalSteps }) : "";
  const source = operation.source ?? t("wip.operation.unknown");
  switch (operation.kind) {
    case "merge":
      return t("wip.operation.merge", { source, target: operation.target ?? t("wip.operation.currentBranch") });
    case "rebase":
      return t("wip.operation.rebase", { source, target: operation.target ?? t("wip.operation.target") }) + step;
    case "cherry_pick":
      return t("wip.operation.cherryPick", { source }) + step;
    case "revert":
      return t("wip.operation.revert", { source }) + step;
  }
}

/** Banner at the top: which operation is running, how many conflicts are resolved, continue and abort. */
function OperationBanner({ repoId, tabId, status }: { repoId: Id; tabId: Id; status: Status }) {
  const operation = status.operation;
  const open = status.conflicted.length;
  const seen = useWipTab(tabId).conflictSeen;
  const busy = useBusy(`${repoId}:operation`);
  // Counted is what this session saw in conflict AND what the index lists as resolved – so the
  // number is right even after a restart in the middle of a merge.
  const stillOpen = new Set(status.conflicted.map((file) => file.path));
  const total = new Set([...seen.paths, ...stillOpen, ...(status.resolvedConflicts ?? [])]).size;
  const solved = total - open;
  const name = operation ? operationNames[operation.kind] : null;

  const progress =
    total === 0
      ? t("wip.progress.none")
      : open === 0
        ? t("wip.progress.allSolved", { count: total })
        : t("wip.progress.partial", { solved, count: total });

  const proceed = () => {
    if (!operation) return;
    if (operation.kind !== "merge") return void continueOperation(repoId, null, tabId);
    // For a merge with the message from the form; if it is empty, the core takes the prepared one.
    const draft = getDraft(repoId);
    const prepared = splitMessage(operation.message ?? "");
    const summary = draft.summary.trim() || prepared.summary;
    const description = draft.summary.trim() ? draft.description : draft.description || prepared.description;
    void continueOperation(repoId, summary ? joinMessage({ summary, description }) : null, tabId, getWipTab(tabId).skipHooks);
  };

  return (
    <Banner tone={open > 0 ? "danger" : operation ? "success" : "info"} title={operationTitle(status)}>
      <p>{progress}</p>
      {!operation && status.foreignOperation === "am" ? (
        <p className="mt-1" data-foreign-operation="am">
          <Trans i18nKey="wip.operation.foreignAmHint" components={{ code: <code className="font-mono" /> }} />
        </p>
      ) : null}
      {operation && name ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            size="sm"
            loading={busy}
            {...(open > 0 ? { "aria-disabled": true, title: t("wip.operation.resolveFirst") } : {})}
            className={cn(open > 0 && "cursor-default text-text-disabled")}
            onClick={() => {
              if (open === 0) proceed();
            }}
          >
            {operation.kind === "merge" ? t("wip.plan.finishMerge") : t("wip.plan.continue", { name })}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void abortOperation(repoId, operation.kind)}>
            {t("wip.operation.abort", { name })}
          </Button>
        </div>
      ) : null}
    </Banner>
  );
}

interface SplitHandleProps {
  value: number;
  onChange: (value: number) => void;
  /** Rectangle of both lists together, from which the ratio is derived. */
  bounds: () => DOMRect | null;
}

/** Handle between "Unstaged" and "Staged": drag, arrow keys, Home/End, double click = middle. */
function SplitHandle({ value, onChange, bounds }: SplitHandleProps) {
  const dragging = useRef(false);
  const fromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = bounds();
    if (!rect || rect.height <= 0) return;
    onChange((event.clientY - rect.top) / rect.height);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.1 : 0.05;
    let next: number | null = null;
    if (event.key === "ArrowDown") next = value + step;
    else if (event.key === "ArrowUp") next = value - step;
    else if (event.key === "Home") next = SPLIT_LIMITS.min;
    else if (event.key === "End") next = SPLIT_LIMITS.max;
    if (next === null) return;
    event.preventDefault();
    onChange(next);
  };
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={t("wip.split.label")}
      aria-valuenow={Math.round(value * 100)}
      aria-valuemin={Math.round(SPLIT_LIMITS.min * 100)}
      aria-valuemax={Math.round(SPLIT_LIMITS.max * 100)}
      aria-valuetext={t("wip.split.value", { value: Math.round(value * 100) })}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragging.current = true;
      }}
      onPointerMove={(event) => {
        if (dragging.current) fromPointer(event);
      }}
      onPointerUp={() => (dragging.current = false)}
      onPointerCancel={() => (dragging.current = false)}
      onDoubleClick={() => onChange(SPLIT_LIMITS.default)}
      onKeyDown={onKeyDown}
      className="group relative z-10 -my-1 h-2 shrink-0 cursor-row-resize touch-none outline-none"
    >
      <span aria-hidden className="absolute inset-x-0 bottom-1/2 h-0.5 bg-transparent transition-colors group-hover:bg-accent group-focus-visible:bg-accent group-active:bg-accent" />
    </div>
  );
}

/** Smallest height of a section (header and one row) when the space has to be shared. */
const SECTION_MIN = 56;

/**
 * Distributes the height between "Unstaged" and "Staged". If both fit, each list gets its natural
 * height and nothing scrolls. Only when the space is not enough does the ratio `split` divide it –
 * and even then no list gets more than it needs.
 */
function useSectionLayout(container: HTMLElement | null, split: number, deps: unknown[]) {
  const [layout, setLayout] = useState<{ first: number | null; overflow: boolean; height: number }>({ first: null, overflow: false, height: 0 });
  useLayoutEffect(() => {
    if (!container) return;
    const natural = (name: string) => {
      const section = container.querySelector<HTMLElement>(`[data-section="${name}"]`);
      if (!section) return 0;
      const header = section.querySelector<HTMLElement>("[data-section-header]")?.offsetHeight ?? 0;
      const content = section.querySelector<HTMLElement>("[data-section-content]");
      // The bottom padding of the section content (pb-1) is part of the natural height.
      const padding = content?.parentElement ? Number.parseFloat(getComputedStyle(content.parentElement).paddingBottom) || 0 : 0;
      return header + (content ? content.offsetHeight + padding : 0) + 1;
    };
    const measure = () => {
      const height = container.clientHeight;
      const first = natural("unstaged");
      const second = natural("staged");
      let next: { first: number | null; overflow: boolean; height: number };
      if (height <= 0) next = { first: null, overflow: false, height: 0 };
      else if (first + second <= height) next = { first, overflow: false, height };
      else {
        let share = split * height;
        if (second < height - share) share = height - second;
        else if (first < share) share = first;
        next = { first: Math.round(Math.min(height - SECTION_MIN, Math.max(SECTION_MIN, share))), overflow: true, height };
      }
      setLayout((current) => (current.first === next.first && current.overflow === next.overflow && current.height === next.height ? current : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    for (const content of container.querySelectorAll("[data-section-content]")) observer.observe(content);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container, split, ...deps]);
  return layout;
}

/**
 * Frame for the commit and stash form: header with the commit/stash switch, banner, the lists
 * "Conflicts", "Unstaged" and "Staged", below them the form of the respective mode.
 */
export function ChangesPanel({ repoId, tabId, mode, footer }: ChangesPanelProps) {
  const { data: status, error, isPending, refetch, isFetching } = useStatus(repoId);
  const wip = useWipTab(tabId);
  const view = useWipStore((state) => state.view);
  const split = useWipStore((state) => state.split);
  const store = useWipStore.getState;
  const app = useAppStore.getState;
  const stagingAll = useBusy(wipBusy.stageAll(repoId));
  const unstagingAll = useBusy(wipBusy.unstageAll(repoId));
  const [lists, setLists] = useState<HTMLDivElement | null>(null);
  const [openSections, setOpenSections] = useState({ unstaged: true, staged: true });

  const unstaged = status?.unstaged ?? [];
  const staged = status?.staged ?? [];
  const conflicted = status?.conflicted ?? [];
  const operation = status?.operation ?? null;
  const sides = useMemo(() => conflictSides(operation, status), [operation, status]);
  const total = unstaged.length + staged.length + conflicted.length;

  const paths = useMemo(
    () => ({ unstaged: unstaged.map((file) => file.path), staged: staged.map((file) => file.path), conflicts: conflicted.map((file) => file.path) }),
    [unstaged, staged, conflicted],
  );
  const selectedIn = (area: WipArea) => {
    const known = new Set(paths[area]);
    return wip.selection[area].selected.filter((path) => known.has(path));
  };
  const selected = { unstaged: selectedIn("unstaged"), staged: selectedIn("staged"), conflicts: selectedIn("conflicts") };

  // For "N of M conflicts resolved": remember all paths that were in conflict in this operation.
  const operationKey = operation ? `${operation.kind}:${operation.source}:${operation.target}:${operation.step}` : conflicted.length ? "none" : "";
  useEffect(() => {
    const seen = store().tabs[tabId]?.conflictSeen ?? { key: "", paths: [] };
    const base = seen.key === operationKey ? seen.paths : [];
    const merged = [...new Set([...base, ...paths.conflicts])];
    if (seen.key !== operationKey || merged.length !== seen.paths.length) store().patch(tabId, { conflictSeen: { key: operationKey, paths: operationKey ? merged : [] } });
  }, [operationKey, paths.conflicts, tabId, store]);

  const layout = useSectionLayout(lists, split, [view, openSections.unstaged, openSections.staged, Boolean(status)]);
  const firstStyle: CSSProperties = layout.first === null ? { flex: `${split} 1 0%` } : { flex: `0 0 ${layout.first}px` };
  const secondStyle: CSSProperties = layout.first === null ? { flex: `${Math.round((1 - split) * 100) / 100} 1 0%` } : { flex: "1 1 0%" };

  const open = (area: WipArea, path: string) => {
    if (area === "conflicts") app().openConflict(tabId, path);
    else app().openDiff(tabId, path, SOURCES[area]);
  };

  const onSelect = (area: WipArea) => (path: string, modifiers: FileSelectModifiers) => {
    store().select(tabId, area, paths[area], path, modifiers);
    if (modifiers.additive || modifiers.range) return;
    // A click opens the diff; arrow keys make an already open diff follow the selection.
    const center = getTabView(tabId).center;
    const following = center.kind === "conflict" || (center.kind === "diff" && (center.source.kind === "unstaged" || center.source.kind === "staged"));
    if (modifiers.source === "pointer" || following) open(area, path);
  };

  /** The marked files if the file under the pointer is one of them – otherwise only that one. */
  const targets = (area: WipArea, file: FileChange) => (selected[area].includes(file.path) ? selected[area] : [file.path]);

  const fallbackMenu = (area: Exclude<WipArea, "conflicts">, files: FileChange[]): MenuEntry[] => {
    const filePaths = files.map((file) => file.path);
    const first = files[0];
    if (!first) return [];
    const many = files.length > 1;
    return [
      { label: t("wip.menu.showDiff"), disabled: many, onSelect: () => open(area, first.path) },
      area === "unstaged"
        ? { label: many ? t("wip.menu.stageFiles", { count: files.length }) : t("wip.menu.stage"), shortcut: "S", onSelect: () => void stageFiles(repoId, tabId, filePaths) }
        : { label: many ? t("wip.menu.unstageFiles", { count: files.length }) : t("wip.menu.unstage"), shortcut: "U", onSelect: () => void unstageFiles(repoId, tabId, filePaths) },
      ...(area === "unstaged"
        ? ([
            { type: "separator" },
            { label: many ? t("wip.menu.discardFiles", { count: files.length }) : t("wip.menu.discard"), shortcut: "Delete", danger: true, onSelect: () => void discardFiles(repoId, tabId, filePaths) },
          ] satisfies MenuEntry[])
        : []),
    ];
  };

  const menuFor = (area: Exclude<WipArea, "conflicts">) => (files: FileChange[]) => {
    const shared = fileMenu({ repoId, tabId, files, source: SOURCES[area] });
    // As long as the shared file menu is still empty, the basic actions stay reachable here.
    return shared.length > 0 ? shared : fallbackMenu(area, files);
  };

  const conflictEntries = (files: FileChange[]): MenuEntry[] => {
    const filePaths = files.map((file) => file.path);
    const first = files[0];
    if (!first) return [];
    const suffix = files.length > 1 ? t("wip.menu.filesSuffix", { count: files.length }) : "";
    return [
      { label: t("wip.menu.openConflictTool"), disabled: files.length > 1, onSelect: () => open("conflicts", first.path) },
      { label: t("wip.menu.openMergeTool"), disabled: files.length > 1, onSelect: () => void openMergeTool(repoId, first.path) },
      { type: "separator" },
      { label: t("wip.menu.takeCurrent", { side: sides.ours }) + suffix, onSelect: () => void resolveConflicts(repoId, tabId, filePaths, "ours", sides) },
      { label: t("wip.menu.takeIncoming", { side: sides.theirs }) + suffix, onSelect: () => void resolveConflicts(repoId, tabId, filePaths, "theirs", sides) },
    ];
  };

  /**
   * Switches between commit and stash form. The panel is rebuilt in the process; if focus was in the
   * switch, it is there again afterwards.
   */
  const switchMode = (next: PanelMode) => {
    if (next === mode) return;
    const keepFocus = document.activeElement?.closest(`[aria-label="${t("wip.panel.form")}"]`) !== null;
    app().setRightPanel(tabId, next === "stash" ? "stash_form" : "details");
    if (keepFocus) {
      requestAnimationFrame(() => document.querySelector<HTMLElement>(`[aria-label="${t("wip.panel.form")}"] [data-state="on"]`)?.focus());
    }
  };

  const plainKey = (event: KeyboardEvent, key: string) => !event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === key;

  const header = (
    <header className="flex h-control-lg shrink-0 items-center gap-1 border-b border-border pr-1 pl-3">
      <h2 className="min-w-0 flex-1 truncate text-base font-medium">
        {t("wip.panel.title")}
        {status && total > 0 ? <span className="ml-2 font-normal text-text-muted tabular-nums">{total}</span> : null}
      </h2>
      <IconButton
        size="sm"
        danger
        label={operation ? t("wip.panel.discardBlocked") : t("wip.panel.discardAll")}
        aria-disabled={!status || unstaged.length + staged.length === 0 || Boolean(operation) || undefined}
        className={cn((!status || unstaged.length + staged.length === 0 || operation) && "text-text-disabled hover:bg-transparent hover:text-text-disabled")}
        icon={<Trash2 className="size-icon" aria-hidden />}
        onClick={() => {
          if (status && unstaged.length + staged.length > 0 && !operation) void discardEverything(repoId, tabId);
        }}
      />
      <FileLayoutSwitch value={view} onChange={(next) => store().setView(next)} />
      <span
        className="contents"
        onKeyDown={(event) => {
          // Arrow keys switch the form directly (not just focus), as described for the segmented control.
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
          event.preventDefault();
          switchMode(event.key === "ArrowRight" ? "stash" : "commit");
        }}
      >
        <SegmentedControl
          label={t("wip.panel.form")}
          value={mode}
          options={[
            { value: "commit", label: "Commit" },
            { value: "stash", label: "Stash" },
          ]}
          onValueChange={(next) => switchMode(next)}
        />
      </span>
    </header>
  );

  let body: ReactNode;
  if (error && !status) {
    const { text, hint } = describeError(error);
    const output = error instanceof CoreError ? error.gitOutput?.trim().split("\n").slice(0, 3).join("\n") : null;
    body = (
      <div role="alert" className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto">
        <EmptyState
          icon={<TriangleAlert className="size-6 text-danger" aria-hidden />}
          title={t("wip.panel.readFailed")}
          action={
            <Button icon={<RefreshCw className="size-icon" aria-hidden />} loading={isFetching} onClick={() => void refetch()}>
              {t("wip.panel.retry")}
            </Button>
          }
        >
          <span className="selectable">
            {text} {output ? null : hint}
            {output ? <code className="mt-2 block font-mono text-code break-words whitespace-pre-wrap text-text">{output}</code> : null}
          </span>
        </EmptyState>
      </div>
    );
  } else if (status && total === 0) {
    const unborn = status.head.kind === "unborn";
    body = (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto">
        <EmptyState
          icon={unborn ? <FilePlus2 className="size-6" aria-hidden /> : <CircleCheck className="size-6" aria-hidden />}
          title={unborn ? t("wip.panel.noFiles") : t("wip.panel.nothingToCommit")}
        >
          {unborn
            ? t("wip.panel.noFilesHint")
            : t("wip.panel.cleanHint")}
        </EmptyState>
      </div>
    );
  } else {
    const loading = !status && isPending;
    body = (
      // If the height is not enough for banner, conflicts, both lists and the form (small window in the
      // middle of a merge), this area scrolls as a whole: the lists keep their minimum height and do
      // not run under the form.
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {conflicted.length > 0 ? (
          <PanelSection title={t("wip.panel.conflicts")} count={conflicted.length} className={cn(SECTION, "max-h-2/5 shrink-0")} data-section="conflicts">
            <FileList
              ariaLabel={t("wip.panel.conflictFiles")}
              files={conflicted}
              view="flat"
              selected={selected.conflicts}
              onSelect={onSelect("conflicts")}
              onActivate={(file) => open("conflicts", file.path)}
              onSelectAll={() => store().setSelected(tabId, "conflicts", paths.conflicts)}
              detail={(file) => conflictText(file.conflict, sides)}
              actionAlways
              menuFor={conflictEntries}
              rowAction={(file) => (
                <DropdownMenu align="end" entries={conflictEntries(conflicted.filter((item) => targets("conflicts", file).includes(item.path)))}>
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-label={t("wip.panel.resolveFile", { path: file.path })}
                    className="inline-flex h-5 items-center gap-0.5 rounded-sm border border-border bg-surface-raised pr-1 pl-1.5 text-xs font-medium text-text hover:border-border-input"
                  >
                    {t("wip.panel.resolve")}
                    <ChevronDown className="size-3" aria-hidden />
                  </button>
                </DropdownMenu>
              )}
            />
          </PanelSection>
        ) : null}
        <div ref={setLists} className="flex min-h-28 flex-1 flex-col">
          <PanelSection
            title={t("wip.panel.unstaged")}
            count={status ? unstaged.length : undefined}
            className={SECTION}
            style={firstStyle}
            data-section="unstaged"
            open={openSections.unstaged}
            onOpenChange={(next) => setOpenSections((current) => ({ ...current, unstaged: next }))}
            pinnedActions={
              <Tip label={t("wip.panel.stageAllTip")} shortcut="Mod+Shift+S">
                <Button size="sm" variant="ghost" loading={stagingAll} disabled={unstaged.length === 0} onClick={() => void stageEverything(repoId, tabId)}>
                  {t("wip.panel.stageAll")}
                </Button>
              </Tip>
            }
          >
            <div data-section-content>
            <FileList
              ariaLabel={t("wip.panel.unstagedFiles")}
              files={unstaged}
              view={view}
              loading={loading}
              selected={selected.unstaged}
              onSelect={onSelect("unstaged")}
              onActivate={(file) => open("unstaged", file.path)}
              onSelectAll={() => store().setSelected(tabId, "unstaged", paths.unstaged)}
              menuFor={menuFor("unstaged")}
              empty={staged.length > 0 ? t("wip.panel.allStaged") : t("wip.panel.noChanges")}
              onKey={(event, file) => {
                if (plainKey(event, "s")) {
                  void stageFiles(repoId, tabId, targets("unstaged", file));
                  return true;
                }
                if (!event.ctrlKey && !event.metaKey && !event.altKey && (event.key === "Delete" || event.key === "Backspace")) {
                  void discardFiles(repoId, tabId, targets("unstaged", file));
                  return true;
                }
                return false;
              }}
              rowAction={(file) => (
                <IconButton
                  size="sm"
                  tabIndex={-1}
                  label={t("wip.menu.stage")}
                  shortcut="S"
                  icon={<Plus className="size-icon" aria-hidden />}
                  onClick={() => void stageFiles(repoId, tabId, targets("unstaged", file))}
                />
              )}
              onFolderKey={(event, files) => {
                if (!plainKey(event, "s")) return false;
                void stageFiles(repoId, tabId, files.map((file) => file.path));
                return true;
              }}
              folderAction={(files) => (
                <IconButton
                  size="sm"
                  tabIndex={-1}
                  label={t("wip.panel.stageFolder", { count: files.length })}
                  shortcut="S"
                  icon={<Plus className="size-icon" aria-hidden />}
                  onClick={() => void stageFiles(repoId, tabId, files.map((file) => file.path))}
                />
              )}
            />
            </div>
          </PanelSection>
          {layout.overflow && openSections.unstaged && openSections.staged ? (
            <SplitHandle value={split} onChange={(next) => store().setSplit(next)} bounds={() => lists?.getBoundingClientRect() ?? null} />
          ) : null}
          <PanelSection
            title={t("wip.panel.staged")}
            count={status ? staged.length : undefined}
            className={SECTION}
            style={secondStyle}
            data-section="staged"
            open={openSections.staged}
            onOpenChange={(next) => setOpenSections((current) => ({ ...current, staged: next }))}
            pinnedActions={
              <Tip label={t("wip.panel.unstageAllTip")} shortcut="Mod+Shift+U">
                <Button size="sm" variant="ghost" loading={unstagingAll} disabled={staged.length === 0} onClick={() => void unstageEverything(repoId, tabId)}>
                  {t("wip.panel.unstageAll")}
                </Button>
              </Tip>
            }
          >
            <div data-section-content>
            <FileList
              ariaLabel={t("wip.panel.stagedFiles")}
              files={staged}
              view={view}
              loading={loading}
              selected={selected.staged}
              onSelect={onSelect("staged")}
              onActivate={(file) => open("staged", file.path)}
              onSelectAll={() => store().setSelected(tabId, "staged", paths.staged)}
              menuFor={menuFor("staged")}
              empty={unstaged.length > 0 ? t("wip.panel.nothingStagedHint") : t("wip.panel.nothingStaged")}
              onKey={(event, file) => {
                if (!plainKey(event, "u")) return false;
                void unstageFiles(repoId, tabId, targets("staged", file));
                return true;
              }}
              rowAction={(file) => (
                <IconButton
                  size="sm"
                  tabIndex={-1}
                  label={t("wip.menu.unstage")}
                  shortcut="U"
                  icon={<Minus className="size-icon" aria-hidden />}
                  onClick={() => void unstageFiles(repoId, tabId, targets("staged", file))}
                />
              )}
              onFolderKey={(event, files) => {
                if (!plainKey(event, "u")) return false;
                void unstageFiles(repoId, tabId, files.map((file) => file.path));
                return true;
              }}
              folderAction={(files) => (
                <IconButton
                  size="sm"
                  tabIndex={-1}
                  label={t("wip.panel.unstageFolder", { count: files.length })}
                  shortcut="U"
                  icon={<Minus className="size-icon" aria-hidden />}
                  onClick={() => void unstageFiles(repoId, tabId, files.map((file) => file.path))}
                />
              )}
            />
            </div>
          </PanelSection>
        </div>
      </div>
    );
  }

  const showOperation = Boolean(status && (status.operation || status.conflicted.length > 0 || status.foreignOperation));
  return (
    <section data-screen={mode === "commit" ? "commit-panel" : "stash-form"} aria-label={t("wip.panel.title")} className="flex h-full min-h-0 flex-col bg-surface">
      {header}
      {status ? (
        <div className="shrink-0 empty:hidden">
          {showOperation ? <OperationBanner repoId={repoId} tabId={tabId} status={status} /> : null}
          {status.head.kind === "detached" && !status.operation ? (
            <Banner tone="warning" title={t("wip.detached.title")}>
              <p>{t("wip.detached.text")}</p>
              <div className="mt-2">
                <Button size="sm" onClick={() => void createBranch(repoId, { checkout: true })}>
                  {t("wip.detached.createBranch")}
                </Button>
              </div>
            </Banner>
          ) : null}
          {!status.identitySet ? (
            <Banner tone="warning" title={t("wip.identity.title")}>
              <p>{t("wip.identity.text")}</p>
              <div className="mt-2">
                <Button size="sm" onClick={() => app().openOverlay({ kind: "preferences", section: "profiles" })}>
                  {t("wip.identity.openProfile")}
                </Button>
              </div>
            </Banner>
          ) : null}
        </div>
      ) : null}
      {body}
      {footer}
    </section>
  );
}
