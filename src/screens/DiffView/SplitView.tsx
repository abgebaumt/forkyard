/**
 * “Side by side” view: old and new version in two columns (CodeMirror MergeView).
 * Both columns are in a shared scroll area and therefore run in sync;
 * unchanged stretches are collapsed and open on click.
 *
 * This file is only loaded when the view is needed (React.lazy in index.tsx).
 */
import { Change, MergeView, getChunks, goToNextChunk, goToPreviousChunk } from "@codemirror/merge";
import { EditorView } from "@codemirror/view";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { CodeEditor } from "../../components/code/CodeEditor";
import { applyLanguage, codeExtensions, createCodeCompartments, setTabSize, setWrap, type CodeCompartments } from "../../components/code/extensions";
import { codeVars, type CodeSettings } from "../../components/code/settings";
import type { Hunk } from "../../core";
import { changesFromHunks } from "./hunkChanges";
import { DiffMinimap, type MinimapSource } from "./Minimap";
import { t } from "../../i18n";

export interface SplitViewHandle {
  goToChange(direction: 1 | -1): boolean;
  focus(): void;
}

export interface SplitViewProps {
  /** null: the side does not exist (new or deleted file). */
  oldText: string | null;
  newText: string | null;
  path: string;
  oldPath: string | null;
  /** Git's hunks of the same diff: the changes are derived from them (hunkChanges.ts). */
  hunks?: readonly Hunk[];
  wrap: boolean;
  code: CodeSettings;
}

function Caption({ title, path }: { title: string; path: string }) {
  return (
    <div className="flex h-row min-w-0 flex-1 items-center gap-2 px-3 text-sm">
      <span className="shrink-0 font-medium text-text">{title}</span>
      <span className="min-w-0 truncate font-mono text-code text-text-muted" title={path}>
        {path}
      </span>
    </div>
  );
}

const SplitView = forwardRef<SplitViewHandle, SplitViewProps>(function SplitView({ oldText, newText, path, oldPath, hunks, wrap, code }, ref) {
  const host = useRef<HTMLDivElement>(null);
  const merge = useRef<{ view: MergeView; a: CodeCompartments; b: CodeCompartments } | null>(null);
  const both = oldText !== null && newText !== null;
  const initial = useRef({ wrap, tabSize: code.tabSize });
  initial.current = { wrap, tabSize: code.tabSize };
  /** Counts up as soon as the position of the lines changes (wrapping, expanded stretches) – the minimap then redraws. */
  const [geometry, setGeometry] = useState(0);
  /** Every new merge view has a new scroll element; the minimap then attaches to it anew. */
  const [instance, setInstance] = useState(0);

  useLayoutEffect(() => {
    if (!host.current || oldText === null || newText === null) return;
    const a = createCodeCompartments();
    const b = createCodeCompartments();
    const options = { readOnly: true, wrap: initial.current.wrap, tabSize: initial.current.tabSize };
    const watch = EditorView.updateListener.of((update) => {
      if (update.geometryChanged || update.docChanged) setGeometry((value) => value + 1);
    });
    const view = new MergeView({
      parent: host.current,
      a: { doc: oldText, extensions: [codeExtensions(a, { ...options, ariaLabel: t("diff.split.beforeLabel", { path: oldPath ?? path }) }), watch] },
      b: { doc: newText, extensions: [codeExtensions(b, { ...options, ariaLabel: t("diff.split.afterLabel", { path }) }), watch] },
      collapseUnchanged: { margin: 3, minSize: 6 },
      // The changes come from Git's hunks (line-precise, in linear time). The merge view's own comparison
      // over the whole file blocked for more than 30 seconds with many scattered changes – its time limit
      // does not apply to the coarse fallback. Without hunks it stays, with tight limits.
      diffConfig: hunks
        ? { override: (a, b) => (a === oldText && b === newText ? changesFromHunks(oldText, newText, hunks) : [new Change(0, a.length, 0, b.length)]) }
        : { scanLimit: 500, timeout: 300 },
      highlightChanges: true,
      gutter: true,
    });
    merge.current = { view, a, b };
    setInstance((value) => value + 1);
    const cancelA = applyLanguage(view.a, a, oldPath ?? path);
    const cancelB = applyLanguage(view.b, b, path);
    return () => {
      cancelA();
      cancelB();
      merge.current = null;
      view.destroy();
    };
  }, [oldText, newText, path, oldPath, hunks]);

  useEffect(() => {
    const current = merge.current;
    if (!current) return;
    setWrap(current.view.a, current.a, wrap);
    setWrap(current.view.b, current.b, wrap);
  }, [wrap]);

  useEffect(() => {
    const current = merge.current;
    if (!current) return;
    setTabSize(current.view.a, current.a, code.tabSize);
    setTabSize(current.view.b, current.b, code.tabSize);
  }, [code.tabSize]);

  useEffect(() => {
    merge.current?.view.a.requestMeasure();
    merge.current?.view.b.requestMeasure();
  }, [code.fontSize, code.lineHeight]);

  useImperativeHandle(
    ref,
    () => ({
      goToChange(direction) {
        const view = merge.current?.view.b;
        if (!view) return false;
        view.focus();
        return direction === 1 ? goToNextChunk(view) : goToPreviousChunk(view);
      },
      focus() {
        merge.current?.view.b.focus();
        if (!merge.current) host.current?.querySelector<HTMLElement>(".cm-content")?.focus();
      },
    }),
    [],
  );

  // Minimap: the changed stretches of both columns – removed on the left (before), added on the right (after).
  const minimap = useMemo<MinimapSource>(
    () => ({
      scroller: () => host.current?.querySelector<HTMLElement>(".cm-mergeView") ?? null,
      total: () => host.current?.querySelector<HTMLElement>(".cm-mergeView")?.scrollHeight ?? 1,
      size: (oldText?.length ?? 0) / 40 + (newText?.length ?? 0) / 40,
      marks(emit) {
        const view = merge.current?.view;
        const chunks = view ? getChunks(view.b.state)?.chunks : null;
        if (!view || !chunks) return;
        for (const chunk of chunks) {
          if (chunk.toA > chunk.fromA) emit(view.a.lineBlockAt(chunk.fromA).top, view.a.lineBlockAt(Math.max(chunk.fromA, chunk.toA - 1)).bottom, "remove");
          if (chunk.toB > chunk.fromB) emit(view.b.lineBlockAt(chunk.fromB).top, view.b.lineBlockAt(Math.max(chunk.fromB, chunk.toB - 1)).bottom, "add");
        }
      },
    }),
    [oldText, newText],
  );

  if (!both) {
    // Only one side: new or deleted file. One editor across the full width.
    const added = newText !== null;
    return (
      <div className="flex h-full min-h-0 flex-col" data-split="single">
        <div className="flex shrink-0 border-b border-border bg-surface">
          <Caption title={added ? t("diff.split.newFile") : t("diff.split.deletedFile")} path={added ? path : (oldPath ?? path)} />
        </div>
        <div ref={host} className="min-h-0 flex-1">
          <CodeEditor value={newText ?? oldText ?? ""} path={path} readOnly wrap={wrap} ariaLabel={added ? t("diff.split.newFileLabel", { path }) : t("diff.split.deletedFileLabel", { path })} />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-split="both">
      <div className="flex shrink-0 divide-x divide-border border-b border-border bg-surface">
        <Caption title={t("diff.before")} path={oldPath ?? path} />
        <Caption title={t("diff.after")} path={path} />
      </div>
      <div className="flex min-h-0 flex-1">
        <div ref={host} style={codeVars(code)} className="gc-split min-h-0 min-w-0 flex-1" />
        <DiffMinimap key={instance} source={minimap} version={geometry} />
      </div>
    </div>
  );
});

export default SplitView;
