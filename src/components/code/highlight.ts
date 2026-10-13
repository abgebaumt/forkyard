/**
 * Syntax highlighting without an editor: parses a text with the language's Lezer parser and
 * returns the coloured spans per line – with the same classes as CodeMirror
 * (`codeHighlightStyle`). The diff view draws its lines itself and colours them with this.
 */
import type { LanguageSupport } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
import { useEffect, useState } from "react";
import { loadLanguageForPath } from "./languages";
import { codeHighlightStyle } from "./theme";

export interface LineToken {
  /** Columns within the line (UTF-16 units), `to` exclusive. */
  from: number;
  to: number;
  className: string;
}

/** Index = line number − 1. Lines without coloured spans are missing. */
export type LineTokens = (LineToken[] | undefined)[];

/** Above this length nothing is coloured any more: the parser would run noticeably long on the UI thread. */
export const HIGHLIGHT_MAX_CHARS = 600_000;

/** Colours `text` and distributes the spans over lines (split at `\n`). */
export function highlightText(text: string, support: LanguageSupport): LineTokens {
  const tree = support.language.parser.parse(text);
  const starts: number[] = [0];
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) starts.push(index + 1);
  const lines: LineTokens = new Array(starts.length);
  let line = 0;
  highlightTree(tree, codeHighlightStyle, (from, to, className) => {
    // The spans come in document order; `line` only moves forward.
    while (line + 1 < starts.length && (starts[line + 1] as number) <= from) line++;
    let current = line;
    let start = from;
    while (start < to) {
      const lineStart = starts[current] as number;
      const next = current + 1 < starts.length ? (starts[current + 1] as number) : Number.POSITIVE_INFINITY;
      // The line ending itself does not belong to the line.
      const end = Math.min(to, next - 1);
      if (end > start) (lines[current] ??= []).push({ from: start - lineStart, to: end - lineStart, className });
      if (to <= next) break;
      start = next;
      current++;
    }
  });
  return lines;
}

/**
 * Coloured lines for `text` in the language of `path`. Returns `null` until language and
 * parsing are ready, and permanently `null` if there is no language or the text
 * is too long – the view then shows uncoloured text.
 */
export function useLineTokens(path: string | null | undefined, text: string | null | undefined): LineTokens | null {
  const [result, setResult] = useState<{ path: string; text: string; tokens: LineTokens } | null>(null);

  useEffect(() => {
    if (!path || !text || text.length > HIGHLIGHT_MAX_CHARS) return;
    let cancelled = false;
    void loadLanguageForPath(path).then((support) => {
      if (cancelled || !support) return;
      // Compute after the next frame: the uncoloured text is already shown by then.
      setTimeout(() => {
        if (cancelled) return;
        try {
          const tokens = highlightText(text, support);
          if (!cancelled) setResult({ path, text, tokens });
        } catch (error) {
          console.warn("Syntax highlighting failed:", error);
        }
      }, 0);
    });
    return () => {
      cancelled = true;
    };
  }, [path, text]);

  return result && result.path === path && result.text === text ? result.tokens : null;
}
