/**
 * Building blocks every CodeMirror view is assembled from. `CodeEditor` uses them
 * for a single editor; the merge views (side-by-side diff, conflicts) pass
 * the same extensions on to `MergeView`.
 */
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { bracketMatching, indentOnInput, indentUnit } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorState, type Extension } from "@codemirror/state";
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers } from "@codemirror/view";
import { loadLanguageForPath } from "./languages";
import { codeAppearance } from "./theme";
import { t } from "../../i18n";

/** Translated texts for CodeMirror's built-in controls (search, folded ranges). */
export const codePhrases: Extension = EditorState.phrases.of({
  // @codemirror/view
  "Control character": t("graph.code.controlCharacter"),
  // @codemirror/search
  Find: t("graph.code.find"),
  Replace: t("graph.code.replace"),
  next: t("graph.code.next"),
  previous: t("graph.code.previous"),
  all: t("graph.code.all"),
  "match case": t("graph.code.matchCase"),
  "by word": t("graph.code.byWord"),
  regexp: t("graph.code.regexp"),
  replace: t("graph.code.replaceOne"),
  "replace all": t("graph.code.replaceAll"),
  close: t("graph.code.close"),
  "current match": t("graph.code.currentMatch"),
  "replaced $ matches": t("graph.code.replacedMatches"),
  "replaced match on line $": t("graph.code.replacedMatchOnLine"),
  "on line": t("graph.code.onLine"),
  "Go to line": t("graph.code.goToLine"),
  go: t("graph.code.go"),
  // @codemirror/merge
  "$ unchanged lines": t("graph.code.unchangedLines"),
});

export interface CodeExtensionOptions {
  /** Read only: text stays selectable and navigable by keyboard, but cannot be changed. */
  readOnly?: boolean;
  /** Wrap long lines. */
  wrap?: boolean;
  tabSize?: number;
  lineNumbers?: boolean;
  /** Name for screen readers, e.g. "New version of README.md". */
  ariaLabel?: string;
}

/**
 * A set of toggleable compartments. Whoever builds a view creates `createCodeCompartments()`
 * once, passes `codeExtensions(...)` into the state and later toggles via the `set…` helpers,
 * without rebuilding the editor.
 */
export interface CodeCompartments {
  language: Compartment;
  wrap: Compartment;
  readOnly: Compartment;
  tabSize: Compartment;
}

export function createCodeCompartments(): CodeCompartments {
  return { language: new Compartment(), wrap: new Compartment(), readOnly: new Compartment(), tabSize: new Compartment() };
}

const readOnlyExtension = (readOnly: boolean): Extension => [EditorState.readOnly.of(readOnly)];
const wrapExtension = (wrap: boolean): Extension => (wrap ? EditorView.lineWrapping : []);
const tabExtension = (tabSize: number): Extension => [EditorState.tabSize.of(tabSize), indentUnit.of(" ".repeat(tabSize))];

/** Everything a code view needs: look, line numbers, selection, search, keyboard. */
export function codeExtensions(compartments: CodeCompartments, options: CodeExtensionOptions = {}): Extension {
  const { readOnly = false, wrap = false, tabSize = 4, ariaLabel } = options;
  return [
    options.lineNumbers === false ? [] : [lineNumbers(), highlightActiveLineGutter()],
    highlightSpecialChars(),
    drawSelection(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    bracketMatching(),
    readOnly ? [] : [history(), indentOnInput(), keymap.of(historyKeymap)],
    search({ top: true }),
    keymap.of([...defaultKeymap, ...searchKeymap]),
    codePhrases,
    codeAppearance,
    ariaLabel ? EditorView.contentAttributes.of({ "aria-label": ariaLabel }) : [],
    compartments.readOnly.of(readOnlyExtension(readOnly)),
    compartments.wrap.of(wrapExtension(wrap)),
    compartments.tabSize.of(tabExtension(tabSize)),
    compartments.language.of([]),
  ];
}

export function setWrap(view: EditorView, compartments: CodeCompartments, wrap: boolean): void {
  view.dispatch({ effects: compartments.wrap.reconfigure(wrapExtension(wrap)) });
}

export function setReadOnly(view: EditorView, compartments: CodeCompartments, readOnly: boolean): void {
  view.dispatch({ effects: compartments.readOnly.reconfigure(readOnlyExtension(readOnly)) });
}

export function setTabSize(view: EditorView, compartments: CodeCompartments, tabSize: number): void {
  view.dispatch({ effects: compartments.tabSize.reconfigure(tabExtension(tabSize)) });
}

/**
 * Loads the language for the path and applies it. Returns a function to cancel (in case
 * the view disappears before loading finishes or the path changes).
 */
export function applyLanguage(view: EditorView, compartments: CodeCompartments, path: string | null | undefined): () => void {
  let cancelled = false;
  void loadLanguageForPath(path).then((support) => {
    if (cancelled) return;
    try {
      view.dispatch({ effects: compartments.language.reconfigure(support ?? []) });
    } catch {
      // The view is already destroyed – nothing to do.
    }
  });
  return () => {
    cancelled = true;
  };
}
