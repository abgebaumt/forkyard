/**
 * Colours and font of the terminal from the design tokens (CSS variables --gc-*).
 * xterm.js draws itself and knows no CSS variables: the values are read and set again on every
 * theme change.
 */
import type { ITheme } from "@xterm/xterm";

const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

const camel = (name: string) => name.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());

export function readTerminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(`--gc-${name}`).trim();
  const theme: Record<string, string> = {
    background: token("surface-sunken"),
    foreground: token("text"),
    cursor: token("accent"),
    cursorAccent: token("surface-sunken"),
    selectionBackground: token("accent-surface"),
    selectionInactiveBackground: token("surface-raised"),
    scrollbarSliderBackground: token("border"),
    scrollbarSliderHoverBackground: token("border-input"),
    scrollbarSliderActiveBackground: token("text-muted"),
  };
  for (const color of ANSI) {
    theme[color] = token(`term-${color}`);
    theme[camel(`bright-${color}`)] = token(`term-bright-${color}`);
  }
  return theme as ITheme;
}

/** Monospace font from the tokens. */
export function readTerminalFontFamily(): string {
  return getComputedStyle(document.documentElement).getPropertyValue("--gc-font-mono").trim() || "monospace";
}

/**
 * xterm.js takes the line height as a factor of the font's natural height, not of the font size.
 * So that a line is exactly `rowHeight` pixels high (as in the diff and the editor), the natural
 * height is measured the way xterm.js does it.
 */
export function terminalLineHeight(fontFamily: string, fontSize: number, rowHeight: number): number {
  let natural = 0;
  try {
    const context = document.createElement("canvas").getContext("2d");
    if (context) {
      context.font = `${fontSize}px ${fontFamily}`;
      const metrics = context.measureText("W");
      natural = metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent;
    }
  } catch {
    natural = 0;
  }
  if (!(natural > 0)) natural = fontSize * 1.2;
  // Never tighter than the font itself; the small extra makes up for the rounding in xterm.js.
  return Math.max(1, (rowHeight + 0.01) / Math.ceil(natural));
}

/** Reports every theme change (data-theme on the root element; the shell sets "system" there too). */
export function watchTerminalTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}
