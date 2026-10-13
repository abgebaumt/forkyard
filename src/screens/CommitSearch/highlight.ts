/** Highlighting of search matches in the result list. Pure functions, no DOM. */

export interface TextPart {
  text: string;
  match: boolean;
}

/**
 * Splits `text` at all places where `needle` occurs (case-insensitive).
 * Together the parts give exactly `text` again.
 */
export function highlightParts(text: string, needle: string): TextPart[] {
  const wanted = needle.trim().toLowerCase();
  if (!wanted || !text) return [{ text, match: false }];
  const lower = text.toLowerCase();
  // toLowerCase can change the length (e.g. “İ”); then the positions are wrong – better no highlighting.
  if (lower.length !== text.length) return [{ text, match: false }];
  const parts: TextPart[] = [];
  let position = 0;
  for (;;) {
    const at = lower.indexOf(wanted, position);
    if (at < 0) break;
    if (at > position) parts.push({ text: text.slice(position, at), match: false });
    parts.push({ text: text.slice(at, at + wanted.length), match: true });
    position = at + wanted.length;
  }
  if (position < text.length) parts.push({ text: text.slice(position), match: false });
  return parts.length > 0 ? parts : [{ text, match: false }];
}

/** The core searches SHAs from four hex characters on as a prefix. */
const MIN_SHA_PREFIX = 4;

/** How many characters of the short SHA (7) are highlighted: 0 if the search text is not a prefix of this SHA. */
export function shaMatchLength(sha: string, needle: string): number {
  const wanted = needle.trim().toLowerCase();
  if (wanted.length < MIN_SHA_PREFIX || !/^[0-9a-f]+$/.test(wanted)) return 0;
  return sha.toLowerCase().startsWith(wanted) ? Math.min(7, wanted.length) : 0;
}
