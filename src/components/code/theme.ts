/**
 * Look of all code views: a CodeMirror theme and a syntax highlighting,
 * both purely from design tokens (CSS variables `--gc-*`). Because there is no fixed
 * colour value anywhere, an open editor switches between dark and light without being
 * rebuilt.
 *
 * Used by the diff, later by the file editor and the conflict tool.
 */
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import "./code.css";

/**
 * Mapping of Lezer tags → role classes (`gc-tok-*`, colours in code.css from `--gc-syntax-*`).
 * Fixed class names instead of generated ones: that way the same table also colours text outside
 * CodeMirror (see highlight.ts).
 */
export const codeHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.self], class: "gc-tok-keyword" },
  { tag: [t.string, t.special(t.string), t.character, t.regexp, t.escape, t.attributeValue], class: "gc-tok-string" },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit, t.color, t.constant(t.variableName), t.standard(t.variableName)], class: "gc-tok-number" },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: "gc-tok-comment" },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName)), t.macroName], class: "gc-tok-function" },
  { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName)], class: "gc-tok-type" },
  { tag: [t.propertyName, t.attributeName, t.labelName, t.definition(t.propertyName)], class: "gc-tok-property" },
  { tag: [t.tagName], class: "gc-tok-tag" },
  { tag: [t.meta, t.processingInstruction, t.annotation, t.documentMeta, t.contentSeparator, t.quote], class: "gc-tok-meta" },
  { tag: t.heading, class: "gc-tok-heading" },
  { tag: t.strong, class: "gc-tok-strong" },
  { tag: t.emphasis, class: "gc-tok-emphasis" },
  { tag: [t.link, t.url], class: "gc-tok-link" },
  { tag: t.strikethrough, class: "gc-tok-strike" },
  { tag: t.invalid, class: "gc-tok-invalid" },
]);

const v = (role: string) => `var(--gc-${role})`;

/**
 * Editor theme. The selectors with a doubled `&.cm-editor` are necessary because CodeMirror's base
 * themes (`&light …`, `&dark …`) would otherwise be more specific than the theme and their fixed
 * colours would come through.
 */
export const codeTheme: Extension = EditorView.theme({
  "&": {
    color: v("text"),
    backgroundColor: v("surface-sunken"),
    fontSize: "var(--gc-code-font-size, 0.75rem)",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: v("font-mono"),
    lineHeight: "var(--gc-code-line-height, 1.5)",
    fontVariantLigatures: "none",
  },
  ".cm-content": { caretColor: v("accent"), padding: "0" },
  ".cm-line": { padding: "0 0.75rem 0 0.5rem" },
  "&.cm-editor .cm-cursor, &.cm-editor .cm-dropCursor": { borderLeftColor: v("accent") },
  "&.cm-editor .cm-selectionBackground, &.cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    backgroundColor: v("accent-surface"),
  },
  "&.cm-editor .cm-content ::selection": { backgroundColor: v("accent-surface"), color: v("text") },
  "&.cm-editor .cm-gutters": {
    backgroundColor: v("surface-sunken"),
    color: v("text-muted"),
    border: "none",
    borderRight: `1px solid ${v("border")}`,
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 0.5rem 0 0.75rem", minWidth: "2.5rem" },
  "&.cm-editor .cm-activeLine": { backgroundColor: "transparent" },
  "&.cm-editor.cm-focused .cm-activeLine": { backgroundColor: `color-mix(in srgb, ${v("surface-raised")} 55%, transparent)` },
  "&.cm-editor .cm-activeLineGutter": { backgroundColor: "transparent", color: v("text") },
  "&.cm-editor .cm-specialChar": { color: v("danger") },
  "&.cm-editor .cm-foldPlaceholder": {
    backgroundColor: v("surface-raised"),
    border: `1px solid ${v("border")}`,
    color: v("text-muted"),
  },
  "&.cm-editor .cm-matchingBracket, &.cm-editor.cm-focused .cm-matchingBracket": {
    backgroundColor: v("accent-surface"),
    outline: `1px solid ${v("border-input")}`,
  },
  "&.cm-editor .cm-searchMatch": { backgroundColor: v("warning-surface"), outline: `1px solid ${v("warning")}` },
  "&.cm-editor .cm-searchMatch.cm-searchMatch-selected": { backgroundColor: v("accent-surface"), outline: `1px solid ${v("accent")}` },
  "&.cm-editor .cm-selectionMatch": { backgroundColor: `color-mix(in srgb, ${v("accent-surface")} 60%, transparent)` },

  // Panels (search) and tooltips
  "&.cm-editor .cm-panels": {
    backgroundColor: v("surface"),
    color: v("text"),
    fontFamily: v("font-sans"),
  },
  "&.cm-editor .cm-panels.cm-panels-top": { borderBottom: `1px solid ${v("border")}` },
  "&.cm-editor .cm-panels.cm-panels-bottom": { borderTop: `1px solid ${v("border")}` },
  ".cm-search": { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.25rem 0.5rem", padding: "0.375rem 0.5rem" },
  ".cm-search label": { display: "inline-flex", alignItems: "center", gap: "0.25rem", color: v("text-muted") },
  "&.cm-editor .cm-textfield": {
    backgroundColor: v("surface-sunken"),
    color: v("text"),
    border: `1px solid ${v("border-input")}`,
    borderRadius: v("radius-md"),
    height: v("size-control-sm"),
    padding: "0 0.5rem",
    fontFamily: v("font-sans"),
  },
  "&.cm-editor .cm-button": {
    backgroundImage: "none",
    backgroundColor: v("surface-raised"),
    color: v("text"),
    border: `1px solid ${v("border")}`,
    borderRadius: v("radius-md"),
    height: v("size-control-sm"),
    padding: "0 0.5rem",
    fontFamily: v("font-sans"),
  },
  "&.cm-editor .cm-panel button[name=close]": { color: v("text-muted"), cursor: "default" },
  "&.cm-editor .cm-tooltip": {
    backgroundColor: v("surface-raised"),
    color: v("text"),
    border: `1px solid ${v("border")}`,
    borderRadius: v("radius-md"),
    boxShadow: v("shadow-pop"),
  },

  // Merge view (@codemirror/merge): old version on the left, new version on the right
  "&.cm-editor.cm-merge-a .cm-changedLine, &.cm-editor .cm-deletedChunk": { backgroundColor: v("diff-removed") },
  "&.cm-editor.cm-merge-b .cm-changedLine, &.cm-editor .cm-inlineChangedLine": { backgroundColor: v("diff-added") },
  "&.cm-editor.cm-merge-a .cm-changedText, &.cm-editor .cm-deletedChunk .cm-deletedText": { background: v("diff-removed-strong"), borderRadius: v("radius-sm") },
  "&.cm-editor.cm-merge-b .cm-changedText": { background: v("diff-added-strong"), borderRadius: v("radius-sm") },
  "&.cm-editor.cm-merge-b .cm-deletedText": { background: v("diff-removed-strong") },
  "&.cm-editor .cm-changeGutter": { width: "0.25rem", paddingLeft: "0" },
  "&.cm-editor.cm-merge-a .cm-changedLineGutter, &.cm-editor .cm-deletedLineGutter": { background: v("danger") },
  "&.cm-editor.cm-merge-b .cm-changedLineGutter": { background: v("success") },
  "&.cm-editor .cm-inlineChangedLineGutter": { background: v("accent") },
  "&.cm-editor .cm-collapsedLines": {
    background: v("surface"),
    color: v("text-muted"),
    fontFamily: v("font-sans"),
    fontSize: "0.75rem",
    lineHeight: v("size-row"),
    padding: "0 0.75rem",
    borderTop: `1px solid ${v("border")}`,
    borderBottom: `1px solid ${v("border")}`,
    cursor: "default",
  },
  "&.cm-editor .cm-collapsedLines:hover": { color: v("text") },
  "&.cm-editor .cm-collapsedLines:before": { content: '"⋯"', marginInlineEnd: "0.5rem" },
  "&.cm-editor .cm-collapsedLines:after": { content: '""', marginInlineStart: "0" },
});

/** Theme and syntax colours together – the foundation of every code view. */
export const codeAppearance: Extension = [codeTheme, syntaxHighlighting(codeHighlightStyle)];
