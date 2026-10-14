/**
 * Ticket links in commit messages. The rules come from the core (`linkRulesGet`), already checked
 * there (ASCII, no lookarounds, no back-references, no nested repetition), so `RegExp` without
 * flags reads them exactly as the core does. Matching happens only here.
 */
import type { CustomLinkRule, LinkRule } from "../core";

export interface CompiledRule {
  rule: LinkRule;
  regex: RegExp;
}

export type TextPart = { kind: "text"; text: string } | { kind: "link"; text: string; url: string; ruleId: string };

/** Longer texts are linked only in their first part (e.g. a pasted log in a commit message). */
export const MAX_LINKED_CHARS = 20_000;

export function compileRules(rules: readonly LinkRule[]): CompiledRule[] {
  const compiled: CompiledRule[] = [];
  for (const rule of rules) {
    // The core checked the pattern already; a rule that would still backtrack badly never runs.
    if (hasNestedRepetition(rule.pattern)) continue;
    try {
      compiled.push({ rule, regex: new RegExp(rule.pattern, "g") });
    } catch {
      // The core checked the pattern; an engine that disagrees just skips the rule.
    }
  }
  return compiled;
}

/** `$0` = whole match, `$1` … = groups, URL-encoded. Only http(s) results count. */
export function expandUrl(template: string, match: RegExpExecArray): string | null {
  const url = template.replace(/\$(\d)/g, (_all, digit: string) => encodeURIComponent(match[Number(digit)] ?? ""));
  return /^https?:\/\//i.test(url) ? url : null;
}

interface Hit {
  start: number;
  end: number;
  url: string;
  ruleId: string;
  order: number;
}

/** Text in parts; where two rules match at the same place the earlier rule wins, overlaps are skipped. */
export function linkify(text: string, rules: readonly CompiledRule[]): TextPart[] {
  if (!text) return [];
  if (rules.length === 0) return [{ kind: "text", text }];
  const scanned = text.slice(0, MAX_LINKED_CHARS);
  const hits: Hit[] = [];
  rules.forEach(({ rule, regex }, order) => {
    regex.lastIndex = 0;
    for (let match = regex.exec(scanned); match; match = regex.exec(scanned)) {
      if (match[0] === "") {
        regex.lastIndex += 1;
        continue;
      }
      const url = expandUrl(rule.url, match);
      if (url) hits.push({ start: match.index, end: match.index + match[0].length, url, ruleId: rule.id, order });
    }
  });
  hits.sort((a, b) => a.start - b.start || a.order - b.order);
  const parts: TextPart[] = [];
  let at = 0;
  for (const hit of hits) {
    if (hit.start < at) continue;
    if (hit.start > at) parts.push({ kind: "text", text: text.slice(at, hit.start) });
    parts.push({ kind: "link", text: text.slice(hit.start, hit.end), url: hit.url, ruleId: hit.ruleId });
    at = hit.end;
  }
  if (at < text.length) parts.push({ kind: "text", text: text.slice(at) });
  return parts;
}

// --- Patterns that backtrack for long (mirror of the core's scan in commands/links/pattern.rs) ---

/** A set of characters: bit `c` for ASCII `c`, bit 0 for everything else (as in the core). */
type Chars = bigint;

const ALL: Chars = (1n << 128n) - 1n;
const OTHER: Chars = 1n;
const not = (set: Chars): Chars => ALL ^ set;

function charBit(c: string): Chars {
  const code = c.charCodeAt(0);
  return code > 0 && code < 128 ? 1n << BigInt(code) : OTHER;
}

function charRange(from: string, to: string): Chars {
  let set = 0n;
  for (let code = from.charCodeAt(0); code <= to.charCodeAt(0); code += 1) set |= charBit(String.fromCharCode(code));
  return set;
}

const DIGITS = charRange("0", "9");
const WORD = DIGITS | charRange("a", "z") | charRange("A", "Z") | charBit("_");
/** `\s` also matches Unicode spaces, hence `OTHER`. */
const SPACE = charRange("\t", "\r") | charBit(" ") | OTHER;
/** Punctuation the core allows after a backslash. */
const ESCAPED_PUNCT = "\\.*+?()[]{}|^$-/#";

/**
 * Characters an escape matches. Escapes the core refuses throw `Refused`: JavaScript reads some of
 * them as one character (`\x41`, `\u0041`, `\101`), so reading them on would misplace quantifiers.
 */
function escapeChars(c: string): Chars {
  switch (c) {
    case "d":
      return DIGITS;
    case "D":
      return not(DIGITS);
    case "w":
      return WORD;
    case "W":
      return not(WORD);
    case "s":
      return SPACE;
    case "S":
      return not(SPACE);
    default:
      if (ESCAPED_PUNCT.includes(c)) return charBit(c);
      throw new Refused();
  }
}

/** The pattern does not compile in JavaScript either; `tryRule` reports it as invalid. */
class Unreadable extends Error {}
/** The construct the core rejects because JavaScript backtracks for long on it. */
class Slow extends Error {}
/** An escape the core refuses (`\x41`, `\1`, `\cA` …); the test field does not run such a pattern. */
class Refused extends Error {}

/** Index after the `]` of the class that opens at `start`, and the characters it matches. */
function scanClass(pattern: string, start: number): [number, Chars] {
  let i = start + 1;
  const negated = pattern[i] === "^";
  if (negated) i += 1;
  let set = 0n;
  let single: string | null = null;
  // JavaScript reads `[]` as "nothing" and `[^]` as "anything".
  if (pattern[i] === "]") return [i + 1, negated ? ALL : 0n];
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "]") return [i + 1, negated ? not(set) : set];
    if (c === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) throw new Unreadable();
      set |= escapeChars(next);
      single = "dDwWsS".includes(next) ? null : next;
      i += 2;
    } else if (c === "-" && single !== null && i + 1 < pattern.length && pattern[i + 1] !== "]") {
      // A range `x-y`; an escape such as `\d` as its end makes it unclear, so take everything.
      const from = single;
      single = null;
      let to: string | null;
      if (pattern[i + 1] === "\\") {
        const escaped = pattern[i + 2];
        if (escaped !== undefined) escapeChars(escaped);
        to = escaped !== undefined && !"dDwWsS".includes(escaped) ? escaped : null;
        i += to === null ? 2 : 3;
      } else {
        to = pattern[i + 1]!;
        i += 2;
      }
      set |= to !== null && from <= to ? charRange(from, to) : ALL;
    } else {
      set |= charBit(c);
      single = c;
      i += 1;
    }
  }
  throw new Unreadable();
}

/** `[end, min, max]` of a `{n}`, `{n,}` or `{n,m}` at `start` (max null = unbounded), or null for a literal `{`. */
function counted(pattern: string, start: number): [number, number, number | null] | null {
  const match = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(start));
  if (!match) return null;
  const min = Number(match[1]);
  const max = match[2] === undefined ? min : match[3] ? Number(match[3]) : null;
  return [start + match[0].length, min, max];
}

interface Group {
  repeats: boolean;
  alternates: boolean;
  chars: Chars;
  openAtStart: Chars;
  branchEnds: Chars;
  /** Number of alternatives (1 without `|`). */
  branches: number;
}

interface Item {
  repeats: boolean;
  alternates: boolean;
  chars: Chars;
  before: Chars;
}

/**
 * The core's scan (commands/links/pattern.rs), read the way JavaScript reads the pattern: throws
 * `Slow` for a repeated group without a fixed width (`(a+)+`, `(aa?)+`) or with an alternative
 * (`(a|b)+`), and for repetitions in a row that can match the same characters (`\w+\w+`, `\w?\w?`).
 * Escapes the core refuses throw `Refused`. Other constructs the core refuses but JavaScript
 * accepts are read on, so a pattern typed into the test field never runs into exponential
 * backtracking.
 */
function scanSlow(pattern: string): void {
  const groups: Group[] = [];
  let item: Item | null = null;
  let open: Chars = 0n;
  // Alternatives per group with a `|` (and of the pattern itself): see `tooManyChoices`.
  const choices: number[] = [];
  let topBranches = 1;
  const atom = (set: Chars): Item => {
    const before = open;
    if ((set & before) === 0n) open = 0n;
    const group = groups[groups.length - 1];
    if (group) group.chars |= set;
    return { repeats: false, alternates: false, chars: set, before };
  };
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "\\") {
      const next = pattern[i + 1];
      if (next === undefined) throw new Unreadable();
      item = next === "b" || next === "B" ? null : atom(escapeChars(next));
      i += 2;
    } else if (c === "[") {
      const [end, set] = scanClass(pattern, i);
      item = atom(set);
      i = end;
    } else if (c === "(") {
      if (pattern[i + 1] === "?") {
        // `(?:`, lookarounds `(?=`, `(?!`, `(?<=`, `(?<!`, named groups `(?<name>` and modifiers `(?i:`.
        const prefix = /^\(\?(?::|=|!|<=|<!|<[^>]*>|[A-Za-z-]+:)/.exec(pattern.slice(i));
        if (!prefix) throw new Unreadable();
        i += prefix[0].length;
      } else {
        i += 1;
      }
      groups.push({ repeats: false, alternates: false, chars: 0n, openAtStart: open, branchEnds: 0n, branches: 1 });
      item = null;
    } else if (c === ")") {
      const group = groups.pop();
      if (!group) throw new Unreadable();
      if (group.branches > 1) choices.push(group.branches);
      const outer = groups[groups.length - 1];
      if (outer) {
        outer.repeats ||= group.repeats;
        outer.alternates ||= group.alternates;
        outer.chars |= group.chars;
      }
      open |= group.branchEnds;
      item = { repeats: group.repeats, alternates: group.alternates, chars: group.chars, before: group.openAtStart };
      i += 1;
    } else if (c === "|") {
      const group = groups[groups.length - 1];
      if (group) {
        group.alternates = true;
        group.branchEnds |= open;
        group.branches += 1;
        open = group.openAtStart;
      } else {
        topBranches += 1;
        open = 0n;
      }
      item = null;
      i += 1;
    } else if (c === "^" || c === "$") {
      item = null;
      i += 1;
    } else if (c === "*" || c === "+" || c === "?" || (c === "{" && counted(pattern, i))) {
      const repeated = item;
      item = null;
      if (!repeated) throw new Unreadable();
      let end = i + 1;
      let optional = c !== "+";
      let unbounded = c !== "?";
      let ranged = false;
      if (c === "{") {
        const [after, min, max] = counted(pattern, i)!;
        end = after;
        optional = min === 0;
        unbounded = max === null;
        ranged = max !== null && min !== max;
      }
      if (c !== "?" && (repeated.repeats || repeated.alternates)) throw new Slow();
      const group = groups[groups.length - 1];
      if (group) group.repeats = true;
      if ((unbounded || ranged || c === "?") && (repeated.chars & repeated.before) !== 0n) throw new Slow();
      if (unbounded) open = repeated.chars | (optional ? repeated.before : 0n);
      else if (optional || ranged) open |= repeated.chars | (optional ? repeated.before : 0n);
      // Lazy form: `*?`, `+?`, `{1,3}?`.
      i = pattern[end] === "?" ? end + 1 : end;
    } else if (c === ".") {
      item = atom(ALL);
      i += 1;
    } else {
      // Also a literal `{`, `}` or `]`, which JavaScript reads as the character itself.
      item = atom(charBit(c));
      i += 1;
    }
  }
  if (topBranches > 1) choices.push(topBranches);
  if (tooManyChoices(choices)) throw new Slow();
}

/** At most this many ways through the groups with alternatives, leaving out the largest group. */
const MAX_CHOICES = 64;

/**
 * Groups with alternatives in a row multiply the ways a failing match is retried (`(\w|\w)` 24
 * times takes seconds on a 40-character word). One group may hold many alternatives (a preset with
 * many keys); the product of all the others is capped – as `check_choices` in the core.
 */
function tooManyChoices(choices: readonly number[]): boolean {
  const largest = Math.max(1, ...choices);
  let product = 1;
  let skipped = false;
  for (const count of choices) {
    if (count === largest && !skipped) {
      skipped = true;
      continue;
    }
    product *= count;
    if (product > MAX_CHOICES) return true;
  }
  return false;
}

/**
 * The same rule as in the core: true for patterns that can take exponential time in JavaScript –
 * nested repetition (`(a+)+`), repeated groups with alternatives or of varying width, and
 * repetitions in a row that share characters, and too many groups with alternatives. Guards the
 * test field before it runs a pattern, and `compileRules`.
 */
export function hasNestedRepetition(pattern: string): boolean {
  const outcome = scanOutcome(pattern);
  // A refused escape hides where quantifiers attach, so it cannot be ruled out.
  return outcome === "slow" || outcome === "refused";
}

function scanOutcome(pattern: string): "fine" | "slow" | "refused" | "unreadable" {
  try {
    scanSlow(pattern);
    return "fine";
  } catch (error) {
    if (error instanceof Slow) return "slow";
    if (error instanceof Refused) return "refused";
    if (error instanceof Unreadable) return "unreadable";
    throw error;
  }
}

export type RuleTest = { kind: "invalid" } | { kind: "nested" } | { kind: "ok"; links: { text: string; url: string | null }[] };

/** For the test field in the settings: matches in `sample` (at most 20); the core checks again on saving. */
export function tryRule(pattern: string, url: string, sample: string): RuleTest {
  const outcome = scanOutcome(pattern);
  if (outcome === "refused") return { kind: "invalid" };
  if (outcome === "slow") return { kind: "nested" };
  let regex: RegExp;
  try {
    regex = new RegExp(pattern, "g");
  } catch {
    return { kind: "invalid" };
  }
  const links: { text: string; url: string | null }[] = [];
  for (let match = regex.exec(sample); match && links.length < 20; match = regex.exec(sample)) {
    if (match[0] === "") {
      regex.lastIndex += 1;
      continue;
    }
    links.push({ text: match[0], url: expandUrl(url.trim(), match) });
  }
  return { kind: "ok", links };
}

/** "abc, OPS;ops x1" → ["ABC", "OPS", "X1"]. */
export function splitKeys(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((key) => key.trim().toUpperCase()).filter(Boolean))];
}

/** The smallest free `rule-<n>`. */
export function newRuleId(existing: readonly CustomLinkRule[]): string {
  const taken = new Set(existing.map((rule) => rule.id));
  let n = 1;
  while (taken.has(`rule-${n}`)) n += 1;
  return `rule-${n}`;
}
