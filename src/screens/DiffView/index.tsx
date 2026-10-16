/**
 * Diff view. Shows the changes of a file as hunks, as the whole file or side by side; in the
 * working directory hunks and single lines can be staged, unstaged and discarded.
 *
 * Keys (apply while the diff is open and the focus is not in a text field):
 *   F7 / Shift+F7  or  Alt+↓ / Alt+↑     next / previous change (puts the focus into the diff)
 *   Alt+→ / Alt+←                        next / previous file of the same list
 *   Esc                                  clear the selection, otherwise close the diff
 * The keys in the line grid are in LineView.tsx.
 */
import { FileCheck, FileSymlink, FileX, Space } from "lucide-react";
import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DiffMode, DiffSource, FileChange, FileDiff, Id, TextDiff } from "../../core";
import { openDiffTool } from "../../app/actions/tools";
import { hasOpenDialog } from "../../app/dialogs";
import { toCoreError } from "../../app/errors";
import { useCommitDetails, useDiff, useSettings, useStatus } from "../../app/queries";
import { useAppStore, useBusy } from "../../app/store";
import { preventedByGuard } from "../../app/webviewGuards";
import { useLineTokens } from "../../components/code/highlight";
import { codeVars, useCodeSettings } from "../../components/code/settings";
import { Button } from "../../ui/Button";
import { Banner } from "../../ui/Feedback";
import { closedOnlyTooltip } from "../../ui/Tooltip";
import { applyPatch, modeLabels, patchBusyKey, saveViewSetting, type PatchAction } from "./actions";
import { DiffHeader } from "./DiffHeader";
import "./diff.css";
import { LineView, type LineViewHandle, type PatchTarget } from "./LineView";
import { WordDiffCache, buildFileRows, buildHunkRows, hunkToPatch, patchModeOf, selectionToPatch, sourceKey } from "./model";
import { queueStashSelection } from "../StashForm/selection";
import { BinaryDiffView, DiffError, DiffSkeleton, LfsDiffView, Notice, TooLargeView } from "./OtherKinds";
import { ImageDiffView } from "./ImageDiff";
import type { SplitViewHandle } from "./SplitView";
import { t } from "../../i18n";

const SplitView = lazy(() => import("./SplitView"));

export interface DiffViewProps {
  repoId: Id;
  tabId: Id;
  path: string;
  source: DiffSource;
  /**
   * Embedded in another view (file history): meant read-only, without file switching, without
   * history and close button; Esc and Alt+←/→ stay with the host view.
   */
  embedded?: boolean;
}

const EMPTY: ReadonlySet<string> = new Set();
const NO_FOLDS: ReadonlySet<number> = new Set();

/** Puts the focus back into the file list of the commit panel (after closing). */
function focusFileList() {
  requestAnimationFrame(() => {
    const panel = document.querySelector('[data-area="right"]');
    const target =
      panel?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]') ??
      panel?.querySelector<HTMLElement>('[role="option"][tabindex="0"]') ??
      panel?.querySelector<HTMLElement>('[role="listbox"] [role="option"]') ??
      panel?.querySelector<HTMLElement>('[role="listbox"]');
    target?.focus();
  });
}

const isTextField = (element: Element | null) => Boolean(element && (element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.tagName === "SELECT"));

/** Slim hint strip above the diff. */
function Strip({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div role="status" data-diff-strip="" className="flex min-h-control-md shrink-0 items-center gap-2 border-b border-border bg-surface px-3 py-0.5 text-sm text-text-muted">
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

/** Diff. */
export function DiffView({ repoId, tabId, path, source, embedded = false }: DiffViewProps) {
  const store = useAppStore.getState;
  const fileKey = `${sourceKey(source)}|${path}`;
  const root = useRef<HTMLElement>(null);

  // --- Einstellungen -----------------------------------------------------------
  const { data: settings } = useSettings();
  const mode: DiffMode = settings?.diffMode ?? "hunks";
  const wrap = settings?.diffWordWrap ?? false;
  const ignoreWhitespace = settings?.diffIgnoreWhitespace ?? false;
  const code = useCodeSettings();

  // --- Daten -------------------------------------------------------------------
  const [forced, setForced] = useState<string | null>(null);
  const force = forced === fileKey;
  const query = useDiff(repoId, path, source, { force, ignoreWhitespace });
  const diff: FileDiff | undefined = query.data;
  const text: TextDiff | null = diff?.kind === "text" ? diff : null;
  const patchMode = patchModeOf(source);
  const canPatch = Boolean(text?.token) && text?.status !== "conflicted";
  const busy = useBusy(patchBusyKey(repoId));

  // The list the file comes from – for “previous/next file”.
  const { data: status } = useStatus(repoId);
  const detailSource = source.kind === "commit" || source.kind === "range" || source.kind === "stash" ? source : null;
  const { data: details } = useCommitDetails(repoId, detailSource);
  const files: FileChange[] = useMemo(() => {
    if (detailSource) return details?.files ?? [];
    if (!status) return [];
    if (source.kind === "staged") return status.staged;
    return status.conflicted.some((file) => file.path === path) ? status.conflicted : status.unstaged;
  }, [detailSource, details, status, source.kind, path]);
  const fileIndex = files.findIndex((file) => file.path === path);
  const lastFileIndex = useRef(0);
  if (fileIndex >= 0) lastFileIndex.current = fileIndex;
  const listed = fileIndex >= 0 ? files[fileIndex] : undefined;

  // --- State of the view -------------------------------------------------------
  const selectionId = `${fileKey}|${text?.token ?? ""}`;
  const [selection, setSelection] = useState<{ id: string; keys: ReadonlySet<string> }>({ id: "", keys: EMPTY });
  const selected = selection.id === selectionId ? selection.keys : EMPTY;
  const setSelected = useCallback((keys: Set<string>) => setSelection({ id: selectionId, keys }), [selectionId]);

  const [folds, setFolds] = useState<{ id: string; collapsed: ReadonlySet<number> }>({ id: "", collapsed: NO_FOLDS });
  const collapsed = folds.id === fileKey ? folds.collapsed : NO_FOLDS;

  const [changeIndex, setChangeIndex] = useState(-1);
  const lineView = useRef<LineViewHandle>(null);
  const splitView = useRef<SplitViewHandle>(null);

  // Which display is really shown: if the full text is missing (over 1 MiB), it stays with the hunks.
  const oldMissing = text ? text.oldText === null && text.status !== "added" && text.status !== "untracked" : false;
  const newMissing = text ? text.newText === null && text.status !== "deleted" : false;
  const shown: DiffMode = !text ? mode : mode === "inline" && newMissing ? "hunks" : mode === "split" && (oldMissing || newMissing) ? "hunks" : mode;
  const fellBack = Boolean(text) && shown !== mode;

  const model = useMemo(() => {
    if (!text) return null;
    return shown === "inline" ? buildFileRows(text, text.newText ?? "", collapsed, code.tabSize) : buildHunkRows(text, code.tabSize);
  }, [text, shown, collapsed, code.tabSize]);
  const words = useMemo(() => (text ? new WordDiffCache(text) : null), [text]);
  const oldTokens = useLineTokens(text ? (text.oldPath ?? text.path) : null, shown === "split" ? null : text?.oldText);
  const newTokens = useLineTokens(text ? text.path : null, shown === "split" ? null : text?.newText);

  // --- Aktionen ----------------------------------------------------------------
  const close = useCallback(() => {
    store().closeCenter(tabId);
    focusFileList();
  }, [store, tabId]);

  const goToFile = useCallback(
    (direction: 1 | -1) => {
      // If the file is no longer in the list (e.g. fully staged), the next one is already in its place.
      const from = fileIndex >= 0 ? fileIndex : direction === 1 ? lastFileIndex.current - 1 : lastFileIndex.current;
      const target = files[from + direction];
      if (target) store().openDiff(tabId, target.path, source);
    },
    [fileIndex, files, source, store, tabId],
  );

  const goToChange = useCallback(
    (direction: 1 | -1) => {
      if (shown === "split") splitView.current?.goToChange(direction);
      else lineView.current?.goToChange(direction);
    },
    [shown],
  );

  const onPatch = useCallback(
    async (action: PatchAction, target: PatchTarget) => {
      if (!text) return;
      const patch = target.kind === "selection" ? selectionToPatch(text, selected) : hunkToPatch(text, target.hunkOrd);
      if (!patch) return;
      const outcome = await applyPatch(action, repoId, patch, target.kind === "selection" ? selected.size : null);
      if (outcome.result === "stale") setSelection({ id: "", keys: EMPTY });
      if (outcome.result !== "done") return;
      setSelection({ id: "", keys: EMPTY });
      // Nothing left in this file: to the next one in the list, otherwise back to the graph.
      const list = action === "unstage" ? outcome.status.staged : outcome.status.unstaged;
      if (list.some((file) => file.path === path)) return;
      const next = list[lastFileIndex.current] ?? list[lastFileIndex.current - 1] ?? list[list.length - 1];
      if (next) store().openDiff(tabId, next.path, source);
      else close();
    },
    [text, selected, repoId, path, store, tabId, source, close],
  );

  const onStash = useCallback(() => {
    const patch = text ? selectionToPatch(text, selected) : null;
    if (!patch || (patchMode !== "unstaged" && patchMode !== "staged")) return;
    if (queueStashSelection(repoId, tabId, patchMode, patch, selected.size)) setSelection({ id: "", keys: EMPTY });
  }, [text, selected, patchMode, repoId, tabId]);

  const toggleFold = useCallback(
    (id: number) => {
      const next = new Set(collapsed);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      setFolds({ id: fileKey, collapsed: next });
    },
    [collapsed, fileKey],
  );
  const foldCount = shown === "inline" ? (model?.foldCount ?? 0) : 0;
  const allCollapsed = foldCount > 0 && collapsed.size >= foldCount;
  const toggleAllFolds = () => setFolds({ id: fileKey, collapsed: allCollapsed ? NO_FOLDS : new Set(Array.from({ length: foldCount }, (_, index) => index)) });

  // --- Tastatur ----------------------------------------------------------------
  const keys = useRef({ goToChange, goToFile, close, hasSelection: selected.size > 0, clear: () => setSelection({ id: "", keys: EMPTY }), embedded });
  keys.current = { goToChange, goToFile, close, hasSelection: selected.size > 0, clear: () => setSelection({ id: "", keys: EMPTY }), embedded };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // The guard against browser shortcuts (F7, Alt+arrow) calls preventDefault – that does not count as “already handled”.
      // Likewise an Esc that only closed the tooltip of the focused button: it closes the diff too.
      if ((event.defaultPrevented && !preventedByGuard(event) && !closedOnlyTooltip(event)) || hasOpenDialog() || useAppStore.getState().overlay) return;
      const target = event.target instanceof Element ? event.target : null;
      if (isTextField(target)) return;
      // Menus, dialogs and foreign editors keep their keys.
      if (target?.closest('[role="menu"], [role="dialog"]')) return;
      const inside = Boolean(target && root.current?.contains(target));
      if (!inside && target instanceof HTMLElement && target.isContentEditable) return;
      const plain = !event.ctrlKey && !event.metaKey;
      let handled = true;
      if (event.key === "F7" && plain && !event.altKey) keys.current.goToChange(event.shiftKey ? -1 : 1);
      else if (event.altKey && plain && !event.shiftKey && event.key === "ArrowDown") keys.current.goToChange(1);
      else if (event.altKey && plain && !event.shiftKey && event.key === "ArrowUp") keys.current.goToChange(-1);
      else if (keys.current.embedded) handled = false;
      else if (event.altKey && plain && !event.shiftKey && event.key === "ArrowRight") keys.current.goToFile(1);
      else if (event.altKey && plain && !event.shiftKey && event.key === "ArrowLeft") keys.current.goToFile(-1);
      else if (event.key === "Escape" && plain && !event.altKey && !event.shiftKey) {
        if (keys.current.hasSelection) keys.current.clear();
        else keys.current.close();
      } else handled = false;
      if (handled) event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // --- Kopf --------------------------------------------------------------------
  const counts = useMemo(() => {
    if (!text) return null;
    let added = 0;
    let removed = 0;
    for (const hunk of text.hunks) for (const line of hunk.lines) if (line.kind === "add") added++; else if (line.kind === "remove") removed++;
    return { added, removed };
  }, [text]);

  const header = (
    <DiffHeader
      path={path}
      oldPath={diff?.oldPath ?? listed?.oldPath ?? null}
      status={diff?.status ?? listed?.status ?? null}
      source={source}
      added={counts?.added ?? listed?.added ?? null}
      removed={counts?.removed ?? listed?.removed ?? null}
      encoding={text && text.encoding.toLowerCase() !== "utf-8" ? text.encoding : null}
      mode={mode}
      onMode={(next) => void saveViewSetting({ diffMode: next })}
      wrap={wrap}
      onWrap={(next) => void saveViewSetting({ diffWordWrap: next })}
      ignoreWhitespace={ignoreWhitespace}
      onIgnoreWhitespace={(next) => void saveViewSetting({ diffIgnoreWhitespace: next })}
      textual={query.isPending || Boolean(text && text.hunks.length > 0)}
      changeCount={model?.changeStarts.length ?? (text ? text.hunks.length : 0)}
      changeIndex={changeIndex}
      onChange={goToChange}
      fileIndex={fileIndex}
      fileCount={files.length}
      onFile={goToFile}
      fold={shown === "inline" && foldCount > 0 ? { collapsed: allCollapsed, onToggle: toggleAllFolds } : null}
      onHistory={() => store().openHistory(tabId, path)}
      onBlame={() => store().openBlame(tabId, path, source.kind === "commit" ? source.sha : source.kind === "range" ? source.to : null)}
      onEdit={source.kind === "unstaged" || source.kind === "staged" ? () => store().openFile(tabId, path, null, "edit") : null}
      onExternalDiff={embedded ? null : () => void openDiffTool(repoId, path, source)}
      onClose={close}
      embedded={embedded}
    />
  );

  // --- Inhalt ------------------------------------------------------------------
  let body: ReactNode;
  if (query.isPending) {
    body = <DiffSkeleton />;
  } else if (query.isError || !diff) {
    body = <DiffError error={toCoreError(query.error)} path={path} retrying={query.isFetching} onRetry={() => void query.refetch()} onClose={close} />;
  } else if (diff.kind === "image") {
    body = <ImageDiffView diff={diff} />;
  } else if (diff.kind === "binary") {
    body = <BinaryDiffView diff={diff} />;
  } else if (diff.kind === "lfs") {
    body = <LfsDiffView diff={diff} />;
  } else if (diff.kind === "too_large") {
    body = <TooLargeView diff={diff} loading={query.isFetching} onForce={() => setForced(fileKey)} />;
  } else if (diff.hunks.length === 0) {
    body = <NoHunks diff={diff} source={source} ignoreWhitespace={ignoreWhitespace} onShowWhitespace={() => void saveViewSetting({ diffIgnoreWhitespace: false })} />;
  } else if (shown === "split") {
    body = (
      <Suspense fallback={<DiffSkeleton />}>
        <SplitView ref={splitView} oldText={diff.oldText} newText={diff.newText} path={diff.path} oldPath={diff.oldPath} hunks={diff.hunks} wrap={wrap} code={code} />
      </Suspense>
    );
  } else if (model && words) {
    body = (
      <LineView
        ref={lineView}
        key={fileKey}
        diff={diff}
        model={model}
        mode={shown}
        wrap={wrap}
        patchMode={patchMode}
        canPatch={canPatch}
        busy={busy}
        code={code}
        oldTokens={oldTokens}
        newTokens={newTokens}
        words={words}
        selected={selected}
        onSelectedChange={setSelected}
        onPatch={(action, target) => void onPatch(action, target)}
        onStash={patchMode !== "none" && canPatch ? onStash : undefined}
        onToggleFold={toggleFold}
        onChangeIndex={setChangeIndex}
        label={t("diff.view.changesLabel", { path })}
      />
    );
  }

  const showsLines = Boolean(text && text.hunks.length > 0);
  return (
    <section ref={root} aria-label={t("diff.view.ariaLabel", { path })} data-screen="diff" data-diff-mode={shown} data-diff-kind={diff?.kind} data-diff-token={text?.token ?? undefined} style={codeVars(code)} className="flex h-full min-h-0 min-w-0 flex-col bg-bg">
      {header}
      {text?.status === "conflicted" ? (
        <Banner tone="warning" title={t("diff.conflict.title")} actions={<Button size="sm" onClick={() => store().openConflict(tabId, path)}>{t("diff.conflict.resolve")}</Button>}>
          {t("diff.conflict.body")}
        </Banner>
      ) : null}
      {showsLines && fellBack ? <Strip>{t("diff.view.fellBack", { mode: modeLabels[mode] })}</Strip> : null}
      {showsLines && patchMode !== "none" && ignoreWhitespace && shown !== "split" && text && !text.token && text.status !== "conflicted" ? (
        <Strip
          action={
            <Button size="sm" variant="ghost" onClick={() => void saveViewSetting({ diffIgnoreWhitespace: false })}>
              {t("diff.whitespace.show")}
            </Button>
          }
        >
          {t("diff.whitespace.ignoredNoStage")}
        </Strip>
      ) : null}
      <div className="relative min-h-0 flex-1">{body}</div>
    </section>
  );
}

/** Text diff without hunks: depending on the situation, a sentence saying what is going on. */
function NoHunks({ diff, source, ignoreWhitespace, onShowWhitespace }: { diff: TextDiff; source: DiffSource; ignoreWhitespace: boolean; onShowWhitespace: () => void }) {
  if (diff.status === "renamed") {
    return (
      <Notice id="renamed" icon={<FileSymlink className="size-8" aria-hidden />} title={t("diff.noHunks.renamedTitle")}>
        <p>{t("diff.noHunks.renamedBody")}</p>
        <p className="mt-1 font-mono text-code break-all">
          {diff.oldPath} → {diff.path}
        </p>
      </Notice>
    );
  }
  if (ignoreWhitespace) {
    return (
      <Notice id="whitespace" icon={<Space className="size-8" aria-hidden />} title={t("diff.noHunks.whitespaceTitle")} action={<Button onClick={onShowWhitespace}>{t("diff.whitespace.show")}</Button>}>
        {t("diff.noHunks.whitespaceBody")}
      </Notice>
    );
  }
  if (diff.status === "added" || diff.status === "untracked") {
    return (
      <Notice id="empty" icon={<FileCheck className="size-8" aria-hidden />} title={t("diff.noHunks.emptyTitle")}>
        {t("diff.noHunks.emptyBody")}
      </Notice>
    );
  }
  if (diff.status === "deleted") {
    return (
      <Notice id="empty" icon={<FileX className="size-8" aria-hidden />} title={t("diff.noHunks.emptyDeletedTitle")}>
        {t("diff.noHunks.emptyDeletedBody")}
      </Notice>
    );
  }
  const live = source.kind === "unstaged" || source.kind === "staged";
  return (
    <Notice id="unchanged" icon={<FileCheck className="size-8" aria-hidden />} title={t("diff.noHunks.unchangedTitle")}>
      {live
        ? source.kind === "unstaged"
          ? t("diff.noHunks.unchangedUnstaged")
          : t("diff.noHunks.unchangedStaged")
        : t("diff.noHunks.unchangedMode")}
    </Notice>
  );
}
