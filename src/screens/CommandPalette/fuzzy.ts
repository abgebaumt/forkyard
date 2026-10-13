/**
 * Fuzzy search for the command palette.
 *
 * There is a match if all characters of the input occur in this order in the text (case and
 * umlauts do not matter: “ruckgangig” finds “Rückgängig”). Among all possible assignments the
 * one with the best score wins (dynamic programming):
 *
 * - characters at the start of the text count most, then word starts (after space, “/”, “-”, “_”,
 *   “.”, “(” … or at a lower → upper case change),
 * - consecutive characters get a bonus,
 * - gaps cost something, a long text minimally more than a short one,
 * - for paths a match in the file name counts more than one in the folder.
 *
 * Returned are the score and the positions of the matched characters (for highlighting).
 */

export interface FuzzyMatch {
  score: number;
  /** Indices of the matched characters in the original text, ascending. */
  positions: number[];
}

const FOLD: Record<string, string> = {
  ä: "a",
  ö: "o",
  ü: "u",
  ß: "s",
  à: "a",
  á: "a",
  â: "a",
  é: "e",
  è: "e",
  ê: "e",
  ë: "e",
  í: "i",
  ì: "i",
  ï: "i",
  ó: "o",
  ò: "o",
  ô: "o",
  ú: "u",
  ù: "u",
  ç: "c",
  ñ: "n",
};

/** Lower case and umlauts folded to the base letter – per UTF-16 unit so that the positions stay correct. */
export function fold(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    const lower = char.toLowerCase();
    const single = lower.length === 1 ? lower : char;
    out += FOLD[single] ?? single;
  }
  return out;
}

const SEPARATORS = new Set([" ", "/", "\\", "-", "_", ".", "(", ":", "„", '"', "'", "@", "#", "›", ","]);

const SCORE_MATCH = 1;
const BONUS_FIRST = 10;
const BONUS_WORD = 8;
const BONUS_CAMEL = 6;
const BONUS_CONSECUTIVE = 5;
const BONUS_BASENAME = 2;
const PENALTY_GAP_START = 3;
const PENALTY_GAP = 0.5;
const PENALTY_LEADING = 0.15;
const PENALTY_LENGTH = 0.02;

const isLower = (char: string) => char !== char.toUpperCase() && char === char.toLowerCase();
const isUpper = (char: string) => char !== char.toLowerCase() && char === char.toUpperCase();

/** Score for a matched character at position `index` (without context). */
function positionBonus(original: string, index: number, basenameStart: number): number {
  let bonus = SCORE_MATCH;
  if (index === 0) bonus += BONUS_FIRST;
  else {
    const before = original[index - 1]!;
    if (SEPARATORS.has(before)) bonus += BONUS_WORD;
    else if (isLower(before) && isUpper(original[index]!)) bonus += BONUS_CAMEL;
  }
  if (basenameStart > 0 && index >= basenameStart) bonus += BONUS_BASENAME;
  return bonus;
}

const NEG = -1e9;

// Working memory, reused across all calls. The search runs over all entries on every keystroke
// (20 000 files); new arrays per input character and per entry took most of the time. The call is
// not nested, one set of buffers is enough.
let rowA = new Float64Array(256);
let rowB = new Float64Array(256);
let backAt = new Int32Array(4096);
let firstAt = new Int32Array(64);
let lastAt = new Int32Array(64);

/**
 * Scores `text` against an input prepared with `prepareQuery`. `null` = no match.
 * `path: true` gives matches in the last path segment a bonus. `foldedText` saves the folding
 * when the caller keeps it around for many queries.
 */
export function fuzzyMatch(query: string, text: string, options: { path?: boolean; foldedText?: string } = {}): FuzzyMatch | null {
  const m = query.length;
  if (m === 0) return { score: 0, positions: [] };
  const hay = options.foldedText ?? fold(text);
  const n = hay.length;
  if (m > n) return null;

  if (firstAt.length < m) {
    firstAt = new Int32Array(m * 2);
    lastAt = new Int32Array(m * 2);
  }
  // Earliest position per input character (greedy from the left) – at the same time the pre-check:
  // does the input occur as a subsequence at all?
  let probe = 0;
  for (let index = 0; index < n && probe < m; index++) {
    if (hay.charCodeAt(index) === query.charCodeAt(probe)) firstAt[probe++] = index;
  }
  if (probe < m) return null;
  // Latest position per character (greedy from the right). In every complete assignment character i
  // lies between firstAt[i] and lastAt[i]; only this window is computed.
  probe = m - 1;
  for (let index = n - 1; index >= 0 && probe >= 0; index--) {
    if (hay.charCodeAt(index) === query.charCodeAt(probe)) lastAt[probe--] = index;
  }

  if (rowA.length < n) {
    rowA = new Float64Array(n * 2);
    rowB = new Float64Array(n * 2);
  }
  if (backAt.length < m * n) backAt = new Int32Array(m * n * 2);

  const basenameStart = options.path ? Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\")) + 1 : 0;

  // row[j]: best score if the current input character falls on hay[j]. A row is only valid within
  // its window [lo, hi]; outside it holds stale values from earlier calls.
  let previous = rowA;
  let current = rowB;
  let prevLo = 0;
  let prevHi = -1;
  for (let i = 0; i < m; i++) {
    const code = query.charCodeAt(i);
    const lo = firstAt[i]!;
    const hi = lastAt[i]!;
    const row = i * n;
    // gap = max over k ≤ j-2 of previous[k] − gapCost(j−k−1)
    let gap = NEG;
    let gapFrom = -1;
    // The gap accumulates from the first valid position of the previous row – that may lie before the row's own window.
    for (let j = i === 0 ? lo : Math.min(lo, prevLo + 2); j <= hi; j++) {
      if (i > 0) {
        if (gap > NEG / 2) gap -= PENALTY_GAP;
        const k = j - 2;
        if (k >= prevLo && k <= prevHi) {
          const start = previous[k]!;
          if (start > NEG / 2 && start - PENALTY_GAP_START > gap) {
            gap = start - PENALTY_GAP_START;
            gapFrom = k;
          }
        }
      }
      if (j < lo) continue;
      if (hay.charCodeAt(j) !== code) {
        current[j] = NEG;
        continue;
      }
      const bonus = positionBonus(text, j, basenameStart);
      if (i === 0) {
        current[j] = bonus - j * PENALTY_LEADING;
        continue;
      }
      let value = NEG;
      let from = -1;
      const adjacent = j - 1 >= prevLo && j - 1 <= prevHi ? previous[j - 1]! : NEG;
      if (adjacent > NEG / 2) {
        value = adjacent + bonus + BONUS_CONSECUTIVE;
        from = j - 1;
      }
      if (gap > NEG / 2 && gap + bonus > value) {
        value = gap + bonus;
        from = gapFrom;
      }
      current[j] = value;
      backAt[row + j] = from;
    }
    const swap = previous;
    previous = current;
    current = swap;
    prevLo = lo;
    prevHi = hi;
  }

  let end = -1;
  let best = NEG;
  for (let j = prevLo; j <= prevHi; j++) {
    if (previous[j]! > best) {
      best = previous[j]!;
      end = j;
    }
  }
  if (end < 0 || best <= NEG / 2) return null;

  const positions = new Array<number>(m);
  let at = end;
  for (let i = m - 1; i >= 0; i--) {
    positions[i] = at;
    if (i > 0) at = backAt[i * n + at]!;
  }
  return { score: best - n * PENALTY_LENGTH, positions };
}

/** Prepares an input for `fuzzyMatch` (surrounding whitespace removed, folded). */
export function prepareQuery(query: string): string {
  return fold(query.trim());
}

/** Best match over several texts (title, keywords); the positions only apply to the first text. */
export function fuzzyBest(query: string, primary: string, extra: readonly string[] = [], options: { path?: boolean } = {}): FuzzyMatch | null {
  const main = fuzzyMatch(query, primary, options);
  let best = main;
  for (const text of extra) {
    const hit = fuzzyMatch(query, text);
    // Keywords count slightly less than the visible title and highlight nothing.
    if (hit && (!best || hit.score - 2 > best.score)) best = { score: hit.score - 2, positions: main?.positions ?? [] };
  }
  return best;
}

/** Splits a text at the match positions into pieces for highlighting. */
export function highlightParts(text: string, positions: readonly number[]): { text: string; hit: boolean }[] {
  if (positions.length === 0) return [{ text, hit: false }];
  const marks = new Set(positions);
  const parts: { text: string; hit: boolean }[] = [];
  let current = "";
  let currentHit = false;
  for (let index = 0; index < text.length; index++) {
    const hit = marks.has(index);
    if (index > 0 && hit !== currentHit) {
      parts.push({ text: current, hit: currentHit });
      current = "";
    }
    currentHit = hit;
    current += text[index];
  }
  if (current) parts.push({ text: current, hit: currentHit });
  return parts;
}

/**
 * Filter out random matches: from three characters on the score must average above 1.5 per character.
 * Consecutive pieces and word starts achieve that, but letters scattered anywhere in the text do not
 * (“wind” in “Gewählten Commit auschecken”).
 */
export function isWeakMatch(match: FuzzyMatch, queryLength: number): boolean {
  return queryLength >= 3 && match.score < queryLength * 1.5;
}
