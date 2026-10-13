/**
 * Font size and tab width from the settings (settings.editorFontSize, editorTabSize).
 *
 * `codeVars` returns CSS variables for the host container; the CodeMirror theme and the
 * `.gc-code` class read them. A changed setting therefore takes effect immediately, without an
 * editor being rebuilt.
 */
import type { CSSProperties } from "react";
import { useMemo } from "react";
import { useSettings } from "../../app/queries";

export interface CodeSettings {
  fontSize: number;
  /** Line height in pixels: one and a half times the font size, rounded to whole pixels. */
  lineHeight: number;
  tabSize: number;
}

const DEFAULT_FONT_SIZE = 13;
const DEFAULT_TAB_SIZE = 4;

export function codeSettingsFrom(settings: { editorFontSize?: number; editorTabSize?: number } | null | undefined): CodeSettings {
  const fontSize = Math.min(40, Math.max(8, Math.round(settings?.editorFontSize ?? DEFAULT_FONT_SIZE)));
  const tabSize = Math.min(16, Math.max(1, Math.round(settings?.editorTabSize ?? DEFAULT_TAB_SIZE)));
  return { fontSize, lineHeight: Math.round(fontSize * 1.5), tabSize };
}

/** Current code settings; while the settings are loading, the defaults apply. */
export function useCodeSettings(): CodeSettings {
  const { data } = useSettings();
  const fontSize = data?.editorFontSize;
  const tabSize = data?.editorTabSize;
  return useMemo(() => codeSettingsFrom({ editorFontSize: fontSize, editorTabSize: tabSize }), [fontSize, tabSize]);
}

/** CSS variables for the container of a code view: `<div style={codeVars(settings)}>`. */
export function codeVars(settings: CodeSettings): CSSProperties {
  return {
    "--gc-code-font-size": `${settings.fontSize}px`,
    "--gc-code-line-height": `${settings.lineHeight}px`,
    "--gc-code-tab-size": String(settings.tabSize),
  } as CSSProperties;
}
