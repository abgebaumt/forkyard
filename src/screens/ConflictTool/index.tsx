/**
 * Resolve a conflict. Top left the current side, top right the incoming side, below the
 * (editable) result. Conflicts are decided block by block or line by line; saving is only
 * possible once no conflict marker is left in the result.
 *
 * Keys (while the tool is open and the focus is not in a foreign text field):
 *   F7 / Shift+F7  or  Alt+↓ / Alt+↑     next / previous conflict
 *   Alt+→ / Alt+←                        next / previous conflict file
 *   Ctrl+S                               resolved – save and stage
 *   Ctrl+F                               search in the result
 *   Esc                                  close (asks first if a resolution is unsaved)
 * In the side-by-side view: arrow keys move, ←/→ switches the side, Space toggles,
 * T swaps the order when both sides are chosen.
 */
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { Id } from "../../core";
import { openExternal } from "../../app/actions/files";
import { operationNames, showWip } from "../../app/actions/merge";
import { hasOpenDialog } from "../../app/dialogs";
import { toCoreError } from "../../app/errors";
import { useConflict, useSettings, useStatus } from "../../app/queries";
import { getTabView, useAppStore } from "../../app/store";
import { preventedByGuard } from "../../app/webviewGuards";
import { IconButton } from "../../ui/Button";
import { isMacShortcuts } from "../../ui/shortcut";
import { focusCommitPanel } from "./actions";
import "./conflict.css";
import { isLarge } from "./model";
import { ConflictError, ConflictSkeleton, Divider, Tag, ToolHeader } from "./parts";
import { sideTitles } from "./titles";
import { WholeFile, wholeReason } from "./WholeFile";
import { Workbench, type WorkbenchHandle } from "./Workbench";
import { t } from "../../i18n";

export interface ConflictToolProps {
  repoId: Id;
  tabId: Id;
  path: string;
}

const isTextField = (element: Element | null) => Boolean(element && (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.tagName === "SELECT"));

function countLines(...texts: (string | null)[]): number {
  let lines = 0;
  for (const text of texts) {
    if (!text) continue;
    for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) lines++;
  }
  return lines;
}

/** Resolve a conflict. */
export function ConflictTool({ repoId, tabId, path }: ConflictToolProps) {
  const store = useAppStore.getState;
  const root = useRef<HTMLElement>(null);
  const workbench = useRef<WorkbenchHandle>(null);

  const query = useConflict(repoId, path);
  const file = query.data;
  const { data: status } = useStatus(repoId);
  const operation = status?.operation ?? null;
  const titles = useMemo(() => (file ? sideTitles(operation, file) : null), [operation, file]);

  // The workbench is rebuilt as soon as the file or the versions change.
  const version = useRef({ key: 0, path: "", base: null as string | null, ours: null as string | null, theirs: null as string | null });
  if (file && (version.current.path !== path || version.current.base !== file.base || version.current.ours !== file.ours || version.current.theirs !== file.theirs)) {
    version.current = { key: version.current.key + 1, path, base: file.base, ours: file.ours, theirs: file.theirs };
  }

  const [forced, setForced] = useState<string | null>(null);
  // Only if a custom merge tool is set in the settings; it writes to the file in the working directory.
  const { data: settings } = useSettings();
  const externalTool = Boolean(settings?.externalMergeTool?.trim());

  // --- Conflict files of the list -----------------------------------------------------------
  const files = status?.conflicted ?? [];
  const fileIndex = files.findIndex((item) => item.path === path);
  const goToFile = useCallback(
    (direction: 1 | -1) => {
      const target = files[fileIndex + direction];
      if (fileIndex >= 0 && target) store().openConflict(tabId, target.path);
    },
    [files, fileIndex, store, tabId],
  );

  const close = useCallback(() => {
    store().closeCenter(tabId);
    // With an unsaved resolution the guard asks first – then the middle (and the focus) stays for now.
    if (getTabView(tabId).center.kind === "conflict") return;
    showWip(tabId);
    focusCommitPanel();
  }, [store, tabId]);

  // --- Tastatur -----------------------------------------------------------------------------
  const keys = useRef({ goToFile, close });
  keys.current = { goToFile, close };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.defaultPrevented && !preventedByGuard(event)) || hasOpenDialog() || useAppStore.getState().overlay) return;
      const target = event.target instanceof Element ? event.target : null;
      if (isTextField(target)) return;
      if (target?.closest('[role="menu"], [role="dialog"]')) return;
      const inside = Boolean(target && root.current?.contains(target));
      if (!inside && target instanceof HTMLElement && target.isContentEditable) return;
      const plain = !event.ctrlKey && !event.metaKey;
      let handled = true;
      if (event.key === "F7" && plain && !event.altKey) workbench.current?.goToConflict(event.shiftKey ? -1 : 1);
      else if (event.altKey && plain && !event.shiftKey && event.key === "ArrowDown") workbench.current?.goToConflict(1);
      else if (event.altKey && plain && !event.shiftKey && event.key === "ArrowUp") workbench.current?.goToConflict(-1);
      else if (event.altKey && plain && !event.shiftKey && event.key === "ArrowRight") keys.current.goToFile(1);
      else if (event.altKey && plain && !event.shiftKey && event.key === "ArrowLeft") keys.current.goToFile(-1);
      else if (event.key === "Escape" && plain && !event.altKey && !event.shiftKey) keys.current.close();
      else handled = false;
      if (handled) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  /** Ctrl+S and Ctrl+F belong to the tool here – before the window's commands see them. */
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const mod = isMacShortcuts() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (!mod || event.altKey || event.shiftKey || event.defaultPrevented || !workbench.current) return;
    const key = event.key.toLowerCase();
    if (key === "s") workbench.current.save();
    else if (key === "f") workbench.current.openSearch();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  // --- Kopf ---------------------------------------------------------------------------------
  const tags: ReactNode = (
    <>
      {operation ? (
        <Tag data="operation" title={t("conflict.header.operation")}>
          {operationNames[operation.kind].charAt(0).toUpperCase() + operationNames[operation.kind].slice(1)}
          {operation.step && operation.totalSteps ? ` ${operation.step}/${operation.totalSteps}` : ""}
        </Tag>
      ) : null}
      {file && !file.isBinary && file.encoding && file.encoding.toLowerCase() !== "utf-8" ? (
        <Tag data="encoding" title={t("conflict.header.encoding")}>
          {file.encoding}
        </Tag>
      ) : null}
    </>
  );
  const external: ReactNode =
    externalTool && file ? (
      <IconButton size="sm" label={t("conflict.header.external")} data-action="external" icon={<ExternalLink className="size-icon" aria-hidden />} onClick={() => void openExternal(repoId, "merge_tool", path)} />
    ) : null;
  const fileNav: ReactNode =
    files.length > 1 || fileIndex < 0 ? (
      <>
        {external}
        <Divider />
        <div role="group" aria-label={t("conflict.header.switchFile")} className="flex shrink-0 items-center">
          <IconButton size="sm" label={t("conflict.header.prevFile")} shortcut="Alt+ArrowLeft" disabled={fileIndex <= 0} icon={<ChevronLeft className="size-icon" aria-hidden />} onClick={() => goToFile(-1)} />
          <span className="min-w-8 px-0.5 text-center text-xs text-text-muted tabular-nums" data-file-position="" aria-label={fileIndex >= 0 ? t("conflict.header.filePosition", { index: fileIndex + 1, total: files.length }) : undefined}>
            {fileIndex >= 0 ? `${fileIndex + 1}/${files.length}` : "–"}
          </span>
          <IconButton
            size="sm"
            label={t("conflict.header.nextFile")}
            shortcut="Alt+ArrowRight"
            disabled={fileIndex < 0 || fileIndex >= files.length - 1}
            icon={<ChevronRight className="size-icon" aria-hidden />}
            onClick={() => goToFile(1)}
          />
        </div>
      </>
    ) : (
      external
    );

  // --- Inhalt -------------------------------------------------------------------------------
  let body: ReactNode;
  let state: string;
  if (query.isPending) {
    state = "loading";
    body = (
      <>
        <ToolHeader path={path} middle={tags} end={fileNav} onClose={close} />
        <ConflictSkeleton />
      </>
    );
  } else if (query.isError || !file || !titles) {
    state = "error";
    body = (
      <>
        <ToolHeader path={path} middle={tags} end={fileNav} onClose={close} />
        <ConflictError error={toCoreError(query.error)} path={path} retrying={query.isFetching} onRetry={() => void query.refetch()} onClose={close} />
      </>
    );
  } else {
    const reason = wholeReason(file);
    const large = !reason && forced !== path && isLarge(file.ours, file.theirs);
    if (reason || large || file.ours === null || file.theirs === null) {
      state = reason ?? "large";
      body = (
        <>
          <ToolHeader path={path} middle={tags} end={fileNav} onClose={close} />
          <WholeFile
            repoId={repoId}
            tabId={tabId}
            path={path}
            file={file}
            titles={titles}
            reason={reason ?? "large"}
            lines={large ? Math.max(countLines(file.ours), countLines(file.theirs)) : 0}
            onForce={() => setForced(path)}
          />
        </>
      );
    } else {
      state = "lines";
      body = <Workbench key={version.current.key} ref={workbench} repoId={repoId} tabId={tabId} path={path} file={file} ours={file.ours} theirs={file.theirs} titles={titles} tags={tags} fileNav={fileNav} onClose={close} />;
    }
  }

  return (
    <section ref={root} aria-label={t("conflict.ariaLabel", { path })} data-screen="conflict" data-conflict-state={state} data-conflict-kind={file?.kind} onKeyDown={onKeyDown} className="flex h-full min-h-0 min-w-0 flex-col bg-bg">
      {body}
    </section>
  );
}
