/**
 * Blame data for display: blocks of consecutive lines from the same commit, colour per author
 * (the same as for the avatar) and age step per commit, legend, and the gutter column as a
 * CodeMirror gutter. Which of the two colours the bar shows is decided by CSS alone
 * (`data-blame-color` on the view) – the editor is not rebuilt when toggling.
 */
import { GutterMarker, gutter, type EditorView, type BlockInfo } from "@codemirror/view";
import { Prec, type Extension } from "@codemirror/state";
import type { BlameLine } from "../../core";
import { formatRelative } from "../../app/format";
import { laneColor } from "../../ui/cn";
import { locale, t } from "../../i18n";

export interface BlameBlock {
  index: number;
  sha: string;
  uncommitted: boolean;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  summary: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  /** Author colour (one of the eight lane colours). */
  color: string;
  /** Age step 0 (newest) to AGE_STEPS − 1 (oldest); null for uncommitted lines. */
  age: number | null;
}

/** Number of steps on the “by age” scale (see --gc-blame-age-* in blame.css). */
export const AGE_STEPS = 5;

/** Colour of an age step; the steps are defined as CSS variables on the view. */
export const ageColor = (age: number | null) => (age === null ? "var(--gc-text-muted)" : `var(--gc-blame-age-${age})`);

export type BlameColorMode = "author" | "age";

export interface AgeStat {
  /** Altersstufe 0 … AGE_STEPS − 1. */
  step: number;
  lines: number;
  /** Newest and oldest commit of this step (ISO time); null if no line falls into the step. */
  newest: string | null;
  oldest: string | null;
}

export interface AuthorStat {
  key: string;
  name: string;
  email: string;
  lines: number;
  color: string;
  uncommitted: boolean;
}

export interface BlameModel {
  text: string;
  blocks: BlameBlock[];
  /** Index = Zeilennummer − 1. */
  blockOfLine: Int32Array;
  authors: AuthorStat[];
  commitCount: number;
  /** Zeilen je Altersstufe, neueste zuerst. */
  ages: AgeStat[];
  /** Time of the newest and the oldest commit in the file; null without a committed line. */
  newest: string | null;
  oldest: string | null;
  uncommittedLines: number;
}

/** The same calculation as the avatar (ui/Git.tsx): same person, same colour. */
function hash(text: string): number {
  let value = 0;
  for (let index = 0; index < text.length; index++) value = (value * 31 + text.charCodeAt(index)) | 0;
  return Math.abs(value);
}

export const authorColor = (name: string, email: string) => laneColor(hash(email || name));

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "?";
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + last).toUpperCase();
}

export function buildModel(lines: BlameLine[]): BlameModel {
  const blocks: BlameBlock[] = [];
  const blockOfLine = new Int32Array(lines.length);
  const stats = new Map<string, AuthorStat>();
  const commits = new Set<string>();
  const texts = new Array<string>(lines.length);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    texts[index] = line.text;
    commits.add(line.sha);
    let block = blocks[blocks.length - 1];
    if (!block || block.sha !== line.sha) {
      block = {
        index: blocks.length,
        sha: line.sha,
        uncommitted: line.uncommitted,
        authorName: line.author.name,
        authorEmail: line.author.email,
        authoredAt: line.authoredAt,
        summary: line.summary,
        startLine: index + 1,
        endLine: index + 1,
        color: line.uncommitted ? "var(--gc-text-muted)" : authorColor(line.author.name, line.author.email),
        age: null,
      };
      blocks.push(block);
    } else {
      block.endLine = index + 1;
    }
    blockOfLine[index] = block.index;
    const key = line.uncommitted ? "\u0000uncommitted" : (line.author.email || line.author.name).toLowerCase();
    const stat = stats.get(key);
    if (stat) stat.lines++;
    else stats.set(key, { key, name: line.author.name, email: line.author.email, lines: 1, color: block.color, uncommitted: line.uncommitted });
  }
  const authors = Array.from(stats.values()).sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name, locale()));

  // Age steps: the time between the oldest and the newest commit of the file, split into equally long ranges.
  let min = Infinity;
  let max = -Infinity;
  for (const block of blocks) {
    if (block.uncommitted) continue;
    const time = Date.parse(block.authoredAt);
    if (Number.isNaN(time)) continue;
    min = Math.min(min, time);
    max = Math.max(max, time);
  }
  const ages: AgeStat[] = Array.from({ length: AGE_STEPS }, (_, step) => ({ step, lines: 0, newest: null, oldest: null }));
  let uncommittedLines = 0;
  for (const block of blocks) {
    const count = block.endLine - block.startLine + 1;
    if (block.uncommitted) {
      uncommittedLines += count;
      continue;
    }
    const time = Date.parse(block.authoredAt);
    const span = max - min;
    block.age = Number.isNaN(time) || span <= 0 ? 0 : Math.min(AGE_STEPS - 1, Math.floor(((max - time) / span) * AGE_STEPS));
    const stat = ages[block.age]!;
    stat.lines += count;
    if (!stat.newest || block.authoredAt > stat.newest) stat.newest = block.authoredAt;
    if (!stat.oldest || block.authoredAt < stat.oldest) stat.oldest = block.authoredAt;
  }
  const iso = (time: number) => (Number.isFinite(time) ? new Date(time).toISOString() : null);
  return { text: texts.join("\n"), blocks, blockOfLine, authors, commitCount: commits.size, ages, newest: iso(max), oldest: iso(min), uncommittedLines };
}

// ---------------------------------------------------------------------------
// Randspalte
// ---------------------------------------------------------------------------

type Part = "start" | "second" | "repeat" | "repeat-second" | "rest";

/**
 * In long blocks the label is repeated every this many lines (muted), so that while scrolling
 * it is always visible whom the lines belong to.
 */
const REPEAT_EVERY = 30;

class BlameMarker extends GutterMarker {
  constructor(
    readonly block: BlameBlock,
    readonly part: Part,
  ) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return other instanceof BlameMarker && other.block === this.block && other.part === this.part;
  }

  toDOM(): Node {
    const { block, part } = this;
    const cell = document.createElement("div");
    cell.className = "gc-blame-cell";
    // Both colours are on the cell; which one the bar shows is chosen by CSS via data-blame-color.
    cell.style.setProperty("--gc-blame-author", block.color);
    cell.style.setProperty("--gc-blame-age", ageColor(block.age));
    cell.dataset.block = String(block.index);
    if (block.age !== null) cell.dataset.age = String(block.age);
    if (block.uncommitted) cell.dataset.uncommitted = "";
    if (part === "start" || part === "repeat") {
      if (part === "start") {
        cell.dataset.start = "";
        cell.dataset.sha = block.sha;
      } else {
        cell.dataset.repeat = "";
      }
      const avatar = document.createElement("span");
      avatar.className = "gc-blame-avatar";
      avatar.setAttribute("aria-hidden", "true");
      avatar.textContent = block.uncommitted ? "–" : initials(block.authorName);
      const summary = document.createElement("span");
      summary.className = "gc-blame-summary";
      summary.textContent = block.uncommitted ? t("blame.uncommitted") : block.summary || t("blame.noMessage");
      cell.append(avatar, summary);
      if (!block.uncommitted) {
        const date = document.createElement("span");
        date.className = "gc-blame-date";
        date.textContent = formatRelative(block.authoredAt);
        cell.append(date);
      }
    } else if ((part === "second" || part === "repeat-second") && !block.uncommitted) {
      const author = document.createElement("span");
      author.className = "gc-blame-author";
      author.textContent = block.authorName;
      cell.append(author);
    }
    return cell;
  }
}

/** Placeholder so that the column has its width from the start. */
class SpacerMarker extends GutterMarker {
  toDOM(): Node {
    const cell = document.createElement("div");
    cell.className = "gc-blame-cell";
    return cell;
  }
}

export interface BlameGutterHandlers {
  onActivate(block: BlameBlock): void;
  onHover(block: BlameBlock | null, view: EditorView, line: BlockInfo | null): void;
}

export function blameGutter(model: BlameModel, handlers: BlameGutterHandlers): Extension {
  const markers: BlameMarker[] = new Array(model.blockOfLine.length);
  for (let index = 0; index < model.blockOfLine.length; index++) {
    const block = model.blocks[model.blockOfLine[index]!]!;
    const offset = index + 1 - block.startLine;
    const phase = offset % REPEAT_EVERY;
    // Only repeat if at least two more lines of the block follow.
    const repeats = offset >= REPEAT_EVERY && block.endLine - (index + 1) >= 2 - phase;
    markers[index] = new BlameMarker(block, offset === 0 ? "start" : offset === 1 ? "second" : repeats && phase === 0 ? "repeat" : repeats && phase === 1 ? "repeat-second" : "rest");
  }
  const blockAt = (view: EditorView, line: BlockInfo) => {
    const number = view.state.doc.lineAt(line.from).number;
    const index = model.blockOfLine[number - 1];
    return index === undefined ? null : (model.blocks[index] ?? null);
  };
  // Highest rank: the blame column is on the far left, the line numbers right next to the code.
  return Prec.highest(gutter({
    class: "gc-blame-gutter",
    lineMarker: (view, line) => {
      const number = view.state.doc.lineAt(line.from).number;
      return markers[number - 1] ?? null;
    },
    initialSpacer: () => new SpacerMarker(),
    domEventHandlers: {
      click: (view, line) => {
        const block = blockAt(view, line);
        if (block) handlers.onActivate(block);
        return true;
      },
      mousemove: (view, line) => {
        handlers.onHover(blockAt(view, line), view, line);
        return false;
      },
      mouseleave: (view) => {
        handlers.onHover(null, view, null);
        return false;
      },
    },
  }));
}
