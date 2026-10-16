/**
 * The result at the bottom of the conflict tool: an editable CodeMirror editor that knows which
 * text range belongs to which block.
 *
 * The block boundaries are positions in the editor state and move along with every input. If the
 * user types exactly at the boundary to a conflict, the text belongs to the conflict.
 * Checkbox clicks only replace the range of their block – edits in other blocks stay – and do not
 * end up in the editor's undo history (Ctrl+Z only undoes typing).
 */
import { openSearchPanel } from "@codemirror/search";
import { Annotation, EditorState, RangeSetBuilder, StateEffect, StateField, Transaction, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { applyLanguage, codeExtensions, createCodeCompartments, setTabSize, type CodeCompartments } from "../../components/code/extensions";
import { codeVars, type CodeSettings } from "../../components/code/settings";
import { shiftBounds, type ChunkKind } from "./model";

/** Display of a block in the result. */
export type ChunkLook = "plain" | "auto" | "open" | "done";

interface Bounds {
  /** N+1 Positionen: Block i liegt in [pos[i], pos[i+1]). */
  pos: number[];
  kinds: ChunkKind[];
  looks: ChunkLook[];
}

const setBounds = StateEffect.define<number[]>();
const setLooks = StateEffect.define<ChunkLook[]>();
/** Change comes from the side-by-side view (checkbox, “All …”), not from typing. */
export const programmatic = Annotation.define<boolean>();

function boundsField(initial: Bounds) {
  return StateField.define<Bounds>({
    create: () => initial,
    update(value, transaction) {
      let next = value;
      let explicit = false;
      for (const effect of transaction.effects) {
        if (effect.is(setBounds)) {
          next = { ...next, pos: effect.value };
          explicit = true;
        } else if (effect.is(setLooks)) next = { ...next, looks: effect.value };
      }
      if (!explicit && transaction.docChanged) {
        const { kinds } = next;
        const pos = next.pos.map((position, index) => {
          // Input at a boundary belongs to the adjacent conflict: before a conflict the boundary
          // stays before the new text, after a conflict it moves behind it.
          const after = kinds[index];
          const before = kinds[index - 1];
          const assoc = after === "conflict" ? -1 : before === "conflict" ? 1 : -1;
          return transaction.changes.mapPos(position, assoc);
        });
        // Start and end always belong: what is typed at the very front or very back lies in the first or last block.
        if (pos.length > 0) {
          pos[0] = 0;
          pos[pos.length - 1] = transaction.newDoc.length;
        }
        next = { ...next, pos };
      }
      return next;
    },
  });
}

const lineClass: Record<Exclude<ChunkLook, "plain">, Decoration> = {
  auto: Decoration.line({ class: "gc-cf-auto" }),
  open: Decoration.line({ class: "gc-cf-open" }),
  done: Decoration.line({ class: "gc-cf-done" }),
};

/** Colours the lines of the blocks – only in the visible range. */
function chunkDecorations(field: StateField<Bounds>): Extension {
  const build = (view: EditorView): DecorationSet => {
    const { pos, looks } = view.state.field(field);
    const builder = new RangeSetBuilder<Decoration>();
    const doc = view.state.doc;
    let lastLine = 0;
    for (const { from, to } of view.visibleRanges) {
      // First block that reaches into the visible range (binary search over the boundaries).
      let low = 0;
      let high = looks.length - 1;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (pos[middle]! <= from) low = middle;
        else high = middle - 1;
      }
      for (let index = low; index < looks.length && pos[index]! <= to; index++) {
        const look = looks[index]!;
        const chunkFrom = pos[index]!;
        const chunkTo = pos[index + 1]!;
        if (look === "plain" || chunkTo <= chunkFrom) continue;
        // The block ends with its line break: the line after it no longer belongs to it.
        const first = doc.lineAt(Math.max(chunkFrom, from)).number;
        const last = doc.lineAt(Math.min(chunkTo - 1, to)).number;
        for (let number = Math.max(first, lastLine + 1); number <= last; number++) {
          builder.add(doc.line(number).from, doc.line(number).from, lineClass[look]);
          lastLine = number;
        }
      }
    }
    return builder.finish();
  };
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = build(view);
      }
      update(update: ViewUpdate) {
        const changed = update.startState.field(field) !== update.state.field(field);
        if (update.docChanged || update.viewportChanged || changed) this.decorations = build(update.view);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

export interface ResultEditorHandle {
  view(): EditorView | null;
  text(): string;
  /** Text of the blocks (per block the current range in the editor). */
  chunkTexts(): string[];
  bounds(): number[];
  /** Replaces the ranges of the given blocks. Not in the undo history unless `history` is set (“Apply” in the intent column). */
  replaceChunks(changes: { chunk: number; text: string }[], options?: { history?: boolean }): void;
  setLooks(looks: ChunkLook[]): void;
  /** Top and height of a block in pixels, relative to the scroll content. */
  chunkBox(chunk: number): { top: number; height: number } | null;
  /** Block at a scroll position (for coupled scrolling). */
  chunkAt(scrollTop: number): { chunk: number; fraction: number } | null;
  scrollToChunk(chunk: number): void;
  /** Scrolls so that the block is past the top edge by the fraction `fraction` (0–1). */
  scrollToFraction(chunk: number, fraction: number): void;
  /** Puts the cursor at the start of the block (and scrolls it into view). */
  selectChunk(chunk: number): void;
  scrollTop(): number;
  hasFocus(): boolean;
  openSearch(): void;
  focus(): void;
}

export interface ResultEditorProps {
  initialDoc: string;
  initialBounds: number[];
  kinds: ChunkKind[];
  looks: ChunkLook[];
  path: string;
  code: CodeSettings;
  ariaLabel: string;
  /** Every change to the text; `fromUser` false for replacements via replaceChunks. */
  onDocChange: (fromUser: boolean) => void;
  onScroll?: () => void;
  onFocusChange?: (focused: boolean) => void;
}

export const ResultEditor = forwardRef<ResultEditorHandle, ResultEditorProps>(function ResultEditor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const fieldRef = useRef<StateField<Bounds> | null>(null);
  const compartments = useRef<CodeCompartments | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const initial = useRef(props);

  useLayoutEffect(() => {
    if (!host.current) return;
    const start = initial.current;
    const field = boundsField({ pos: start.initialBounds, kinds: start.kinds, looks: start.looks });
    const parts = createCodeCompartments();
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: start.initialDoc,
        extensions: [
          codeExtensions(parts, { tabSize: start.code.tabSize, ariaLabel: start.ariaLabel }),
          field,
          chunkDecorations(field),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              const fromUser = !update.transactions.some((transaction) => transaction.annotation(programmatic));
              callbacks.current.onDocChange(fromUser);
            }
            if (update.focusChanged) callbacks.current.onFocusChange?.(update.view.hasFocus);
          }),
          EditorView.domEventHandlers({
            scroll: () => {
              callbacks.current.onScroll?.();
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    fieldRef.current = field;
    compartments.current = parts;
    // Development build only: the E2E driver reads the result text through it.
    if (import.meta.env.DEV) (host.current as HTMLDivElement & { __gcView?: EditorView }).__gcView = view;
    const cancel = applyLanguage(view, parts, start.path);
    return () => {
      cancel();
      viewRef.current = null;
      view.destroy();
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (view && compartments.current) setTabSize(view, compartments.current, props.code.tabSize);
  }, [props.code.tabSize]);

  useEffect(() => {
    viewRef.current?.requestMeasure();
  }, [props.code.fontSize, props.code.lineHeight]);

  useImperativeHandle(
    ref,
    (): ResultEditorHandle => {
      const state = () => {
        const view = viewRef.current;
        const field = fieldRef.current;
        return view && field ? { view, bounds: view.state.field(field) } : null;
      };
      return {
        view: () => viewRef.current,
        text: () => viewRef.current?.state.doc.toString() ?? "",
        bounds: () => state()?.bounds.pos ?? [],
        chunkTexts: () => {
          const current = state();
          if (!current) return [];
          const { pos } = current.bounds;
          return pos.slice(0, -1).map((from, index) => current.view.state.doc.sliceString(from, pos[index + 1]));
        },
        replaceChunks: (changes, options) => {
          const current = state();
          if (!current || changes.length === 0) return;
          const old = current.bounds.pos;
          const sorted = [...changes].sort((a, b) => a.chunk - b.chunk);
          current.view.dispatch({
            changes: sorted.map((change) => ({ from: old[change.chunk]!, to: old[change.chunk + 1]!, insert: change.text })),
            effects: setBounds.of(shiftBounds(old, sorted)),
            annotations: [programmatic.of(true), Transaction.addToHistory.of(options?.history === true)],
          });
        },
        setLooks: (looks) => {
          viewRef.current?.dispatch({ effects: setLooks.of(looks) });
        },
        chunkBox: (chunk) => {
          const current = state();
          if (!current) return null;
          const { pos } = current.bounds;
          const from = pos[chunk];
          const to = pos[chunk + 1];
          if (from === undefined || to === undefined) return null;
          const view = current.view;
          const top = view.lineBlockAt(from).top;
          const bottom = to > from ? view.lineBlockAt(Math.max(from, to - 1)).bottom : top;
          return { top: top + view.documentPadding.top, height: bottom - top };
        },
        chunkAt: (scrollTop) => {
          const current = state();
          if (!current) return null;
          const view = current.view;
          const { pos } = current.bounds;
          const y = Math.max(0, scrollTop - view.documentPadding.top);
          const block = view.lineBlockAtHeight(y);
          // Block containing the topmost visible line.
          let low = 0;
          let high = pos.length - 2;
          while (low < high) {
            const middle = (low + high + 1) >> 1;
            if (pos[middle]! <= block.from) low = middle;
            else high = middle - 1;
          }
          // Skip empty blocks at the same position: the last one applies.
          const top = view.lineBlockAt(pos[low]!).top;
          const end = pos[low + 1]!;
          const bottom = end > pos[low]! ? view.lineBlockAt(end - 1).bottom : top;
          const fraction = bottom > top ? Math.min(1, Math.max(0, (y - top) / (bottom - top))) : 0;
          return { chunk: low, fraction };
        },
        scrollToChunk: (chunk) => {
          const current = state();
          if (!current) return;
          const from = current.bounds.pos[chunk];
          if (from === undefined) return;
          current.view.dispatch({ effects: EditorView.scrollIntoView(from, { y: "start", yMargin: current.view.defaultLineHeight }) });
        },
        scrollToFraction: (chunk, fraction) => {
          const current = state();
          if (!current) return;
          const { pos } = current.bounds;
          const from = pos[chunk];
          const to = pos[chunk + 1];
          if (from === undefined || to === undefined) return;
          const view = current.view;
          const top = view.lineBlockAt(from).top;
          const bottom = to > from ? view.lineBlockAt(Math.max(from, to - 1)).bottom : top;
          view.scrollDOM.scrollTop = top + view.documentPadding.top + fraction * (bottom - top);
        },
        selectChunk: (chunk) => {
          const current = state();
          if (!current) return;
          const from = current.bounds.pos[chunk];
          if (from === undefined) return;
          current.view.dispatch({ selection: { anchor: from }, effects: EditorView.scrollIntoView(from, { y: "start", yMargin: current.view.defaultLineHeight }) });
        },
        scrollTop: () => viewRef.current?.scrollDOM.scrollTop ?? 0,
        hasFocus: () => viewRef.current?.hasFocus ?? false,
        openSearch: () => {
          const view = viewRef.current;
          if (!view) return;
          view.focus();
          openSearchPanel(view);
        },
        focus: () => viewRef.current?.focus(),
      };
    },
    [],
  );

  return <div ref={host} style={codeVars(props.code)} className="gc-code-host gc-cf-result h-full min-h-0 overflow-hidden bg-surface-sunken" data-result-editor="" />;
});
