/**
 * Shared code foundation (CodeMirror 6) for the diff, the file editor and the
 * conflict tool.
 *
 *   <CodeEditor value={text} path="src/app.ts" readOnly ariaLabel="…" />      a ready-made editor
 *   codeExtensions(createCodeCompartments(), { readOnly: true })              for MergeView & co.
 *   useLineTokens(path, text)                                                 colours without an editor
 *   <div className="gc-code" style={codeVars(useCodeSettings())}>             font for custom code text
 */
export { CodeEditor, type CodeEditorProps } from "./CodeEditor";
export {
  applyLanguage,
  codeExtensions,
  codePhrases,
  createCodeCompartments,
  setReadOnly,
  setTabSize,
  setWrap,
  type CodeCompartments,
  type CodeExtensionOptions,
} from "./extensions";
export { HIGHLIGHT_MAX_CHARS, highlightText, useLineTokens, type LineToken, type LineTokens } from "./highlight";
export { languageNameForPath, loadLanguageForPath } from "./languages";
export { codeSettingsFrom, codeVars, useCodeSettings, type CodeSettings } from "./settings";
export { codeAppearance, codeHighlightStyle, codeTheme } from "./theme";
