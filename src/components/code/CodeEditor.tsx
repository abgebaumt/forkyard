import { Annotation, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useEffect, useLayoutEffect, useRef } from "react";
import { cn } from "../../ui/cn";
import { applyLanguage, codeExtensions, createCodeCompartments, setReadOnly, setTabSize, setWrap, type CodeCompartments } from "./extensions";
import { codeVars, useCodeSettings } from "./settings";

/** Marks the syncing of `value`, so that it is not reported as user input. */
const fromOutside = Annotation.define<boolean>();

export interface CodeEditorProps {
  /** Content. If the value changes from outside, the editor is synced. */
  value: string;
  /** Path of the file: determines the language of the syntax highlighting. */
  path?: string | null;
  readOnly?: boolean;
  wrap?: boolean;
  lineNumbers?: boolean;
  /** Name for screen readers. */
  ariaLabel: string;
  /** Reports every change by the user (not the syncing of `value`). */
  onChange?: (value: string) => void;
  /** The editor is ready; for commands such as jumping or focus. On teardown `null` arrives. */
  onView?: (view: EditorView | null) => void;
  /** Further extensions. Only read on setup – on change, recreate the editor via `key`. */
  extensions?: Extension;
  className?: string;
}

/**
 * A CodeMirror editor with the app's look: colours from the tokens, font size and
 * tab width from the settings, language by file extension. Fills its container and
 * scrolls by itself.
 */
export function CodeEditor({ value, path, readOnly = false, wrap = false, lineNumbers = true, ariaLabel, onChange, onView, extensions, className }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const compartmentsRef = useRef<CodeCompartments | null>(null);
  const settings = useCodeSettings();
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onViewRef = useRef(onView);
  onViewRef.current = onView;
  // What applies at setup; later changes go through the effects below.
  const initial = useRef({ value, readOnly, wrap, tabSize: settings.tabSize, lineNumbers, ariaLabel, extensions });

  useLayoutEffect(() => {
    if (!host.current) return;
    const compartments = createCodeCompartments();
    const start = initial.current;
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: start.value,
        extensions: [
          codeExtensions(compartments, { readOnly: start.readOnly, wrap: start.wrap, tabSize: start.tabSize, lineNumbers: start.lineNumbers, ariaLabel: start.ariaLabel }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.some((transaction) => transaction.annotation(fromOutside))) {
              onChangeRef.current?.(update.state.doc.toString());
            }
          }),
          start.extensions ?? [],
        ],
      }),
    });
    viewRef.current = view;
    compartmentsRef.current = compartments;
    onViewRef.current?.(view);
    return () => {
      onViewRef.current?.(null);
      viewRef.current = null;
      compartmentsRef.current = null;
      view.destroy();
    };
  }, []);

  // Sync the value from outside (e.g. file reloaded) without losing the position.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) view.dispatch({ changes: { from: 0, to: current.length, insert: value }, annotations: fromOutside.of(true) });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    const compartments = compartmentsRef.current;
    if (view && compartments) return applyLanguage(view, compartments, path);
  }, [path]);

  useEffect(() => {
    const view = viewRef.current;
    const compartments = compartmentsRef.current;
    if (view && compartments) setWrap(view, compartments, wrap);
  }, [wrap]);

  useEffect(() => {
    const view = viewRef.current;
    const compartments = compartmentsRef.current;
    if (view && compartments) setReadOnly(view, compartments, readOnly);
  }, [readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    const compartments = compartmentsRef.current;
    if (view && compartments) setTabSize(view, compartments, settings.tabSize);
  }, [settings.tabSize]);

  // New font size: CodeMirror has to re-measure its line heights.
  useEffect(() => {
    viewRef.current?.requestMeasure();
  }, [settings.fontSize, settings.lineHeight]);

  return <div ref={host} style={codeVars(settings)} className={cn("gc-code-host h-full min-h-0 overflow-hidden bg-surface-sunken", className)} data-code-editor="" />;
}
