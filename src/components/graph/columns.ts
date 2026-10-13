/**
 * Columns of the commit graph: order, visibility, widths – and how the actual layout results
 * from them at a given width.
 *
 * Refs, graph and message are always there and come first in this order; the message
 * gets the free space and never less than MESSAGE_MIN. Author, date and SHA are optional
 * and can be reordered among themselves. Stored per repository (RepoViewState.columns).
 */
import type { DateFormat, GraphColumnId, RepoViewState } from "../../core";
import { t } from "../../i18n";

export type ColumnState = RepoViewState["columns"][number];
export type FixedColumnId = "refs" | "graph" | "message";
export type OptionalColumnId = "author" | "date" | "sha";
export type ResizableColumnId = Exclude<GraphColumnId, "message">;

export const FIXED_COLUMNS: FixedColumnId[] = ["refs", "graph", "message"];
export const OPTIONAL_COLUMNS: OptionalColumnId[] = ["author", "date", "sha"];

export const COLUMN_LABELS: Record<GraphColumnId, string> = {
  refs: t("graph.columns.refs"),
  graph: t("graph.columns.graph"),
  message: t("graph.columns.message"),
  author: t("graph.columns.author"),
  date: t("graph.columns.date"),
  sha: t("graph.columns.sha"),
};

// Dimensions from design/tokens.json › layout › graph-columns
export const MESSAGE_MIN = 160;
/** Below this message width the author column shrinks to the avatar (as long as it has no fixed width). */
const MESSAGE_COMFORT = 280;
export const AUTHOR_COMPACT = 36;
const REFS_SOFT_MIN = 112;
/** From this width on the author column shows the name next to the avatar. */
export const AUTHOR_NAME_FROM = 72;
const GRAPH_AUTO_MAX = 216;
/** Without a fixed width never narrower than the column title "Graph". */
const GRAPH_AUTO_MIN = 64;

export const COLUMN_LIMITS: Record<ResizableColumnId, { min: number; max: number }> = {
  refs: { min: 64, max: 480 },
  graph: { min: 40, max: 640 },
  author: { min: 32, max: 320 },
  date: { min: 64, max: 240 },
  sha: { min: 60, max: 120 },
};

const DEFAULT_WIDTHS = { refs: 160, author: 132, date: 112, dateAbsolute: 140, sha: 72 };

export const isOptional = (id: GraphColumnId): id is OptionalColumnId => (OPTIONAL_COLUMNS as GraphColumnId[]).includes(id);
export const isResizable = (id: GraphColumnId): id is ResizableColumnId => id !== "message";

export function clampColumnWidth(id: ResizableColumnId, width: number): number {
  const limits = COLUMN_LIMITS[id];
  return Math.round(Math.min(limits.max, Math.max(limits.min, width)));
}

/** Brings the stored state into the fixed form: three fixed columns first, then the optional ones in stored order. */
export function normalizeColumns(stored: ColumnState[] | null | undefined): ColumnState[] {
  const byId = new Map<GraphColumnId, ColumnState>();
  for (const column of stored ?? []) if (!byId.has(column.id)) byId.set(column.id, column);
  const width = (id: GraphColumnId) => {
    const value = byId.get(id)?.width;
    return typeof value === "number" && isResizable(id) ? clampColumnWidth(id, value) : null;
  };
  const fixed = FIXED_COLUMNS.map((id): ColumnState => ({ id, visible: true, width: width(id) }));
  const order = [...byId.keys()].filter(isOptional);
  for (const id of OPTIONAL_COLUMNS) if (!order.includes(id)) order.push(id);
  const optional = order.map((id): ColumnState => ({ id, visible: byId.get(id)?.visible ?? id !== "sha", width: width(id) }));
  return [...fixed, ...optional];
}

export const DEFAULT_COLUMNS: ColumnState[] = normalizeColumns(null);

export function setColumnWidth(columns: ColumnState[], id: ResizableColumnId, width: number | null): ColumnState[] {
  return columns.map((column) => (column.id === id ? { ...column, width: width === null ? null : clampColumnWidth(id, width) } : column));
}

export function setColumnVisible(columns: ColumnState[], id: OptionalColumnId, visible: boolean): ColumnState[] {
  return columns.map((column) => (column.id === id ? { ...column, visible } : column));
}

/**
 * New order of the optional columns: first `shown` (the currently displayed ones, in the new
 * order), followed by all other optional ones in their previous order.
 */
export function orderOptional(columns: ColumnState[], shown: OptionalColumnId[]): ColumnState[] {
  const fixed = columns.filter((column) => !isOptional(column.id));
  const optional = columns.filter((column) => isOptional(column.id));
  const front = shown.map((id) => optional.find((column) => column.id === id)).filter((column): column is ColumnState => column !== undefined);
  const rest = optional.filter((column) => !shown.includes(column.id as OptionalColumnId));
  return [...fixed, ...front, ...rest];
}

/** Moves a displayed optional column one place to the left (−1) or right (+1). */
export function moveColumn(columns: ColumnState[], shown: OptionalColumnId[], id: OptionalColumnId, direction: -1 | 1): ColumnState[] {
  const at = shown.indexOf(id);
  const other = shown[at + direction];
  if (at < 0 || other === undefined) return columns;
  const next = [...shown];
  next[at] = other;
  next[at + direction] = id;
  return orderOptional(columns, next);
}

/** Puts a displayed optional column before another one, or at the end of the displayed ones (`before: null`). */
export function placeColumn(columns: ColumnState[], shown: OptionalColumnId[], id: OptionalColumnId, before: OptionalColumnId | null): ColumnState[] {
  if (id === before) return columns;
  const rest = shown.filter((other) => other !== id);
  const at = before === null ? rest.length : rest.indexOf(before);
  if (at < 0) return columns;
  return orderOptional(columns, [...rest.slice(0, at), id, ...rest.slice(at)]);
}

export const sameColumns = (a: ColumnState[], b: ColumnState[]) =>
  a.length === b.length && a.every((column, index) => column.id === b[index]?.id && column.visible === b[index]?.visible && column.width === b[index]?.width);

export interface ColumnLayout {
  /** Displayed columns from left to right. */
  order: GraphColumnId[];
  widths: Record<GraphColumnId, number>;
  /** Left edge of the graph column (for the canvas). */
  graphLeft: number;
  /** Chosen as visible, but currently not shown for lack of space. */
  squeezed: OptionalColumnId[];
  /** Sum of all widths; larger than the space only if even the minimum widths do not fit. */
  total: number;
}

export interface LayoutInput {
  columns: ColumnState[];
  /** Available width of the rows. */
  available: number;
  /** Width needed by all lanes. */
  graphNatural: number;
  dateFormat: DateFormat;
}

/** Width of a column when space is not short: the stored one, otherwise the default. */
export function preferredWidth(column: ColumnState, input: Pick<LayoutInput, "graphNatural" | "dateFormat">): number {
  if (column.id === "message") return MESSAGE_MIN;
  if (column.width !== null) return clampColumnWidth(column.id, column.width);
  switch (column.id) {
    case "refs":
      return DEFAULT_WIDTHS.refs;
    case "graph":
      return Math.round(Math.min(GRAPH_AUTO_MAX, Math.max(GRAPH_AUTO_MIN, input.graphNatural)));
    case "author":
      return DEFAULT_WIDTHS.author;
    case "date":
      return input.dateFormat === "relative" ? DEFAULT_WIDTHS.date : DEFAULT_WIDTHS.dateAbsolute;
    case "sha":
      return DEFAULT_WIDTHS.sha;
  }
}

/**
 * Actual layout. If there is not enough space for 160 px of message, first the author column falls
 * back to the avatar, then the refs column gives way a little, then optional columns drop out from
 * the right, and finally refs and graph shrink down to their minimum width.
 * None of this is stored – when the window gets wider, everything is back.
 */
export function layoutColumns(input: LayoutInput): ColumnLayout {
  const widths = { refs: 0, graph: 0, message: MESSAGE_MIN, author: 0, date: 0, sha: 0 } satisfies Record<GraphColumnId, number>;
  const state = new Map(input.columns.map((column) => [column.id, column]));
  for (const column of input.columns) if (column.id !== "message") widths[column.id] = preferredWidth(column, input);

  let optional = input.columns.filter((column) => isOptional(column.id) && column.visible).map((column) => column.id as OptionalColumnId);
  const squeezed: OptionalColumnId[] = [];
  const fixed = () => widths.refs + widths.graph + optional.reduce((sum, id) => sum + widths[id], 0);
  const message = () => input.available - fixed();

  if (optional.includes("author") && state.get("author")?.width === null && message() < MESSAGE_COMFORT) widths.author = AUTHOR_COMPACT;
  // A refs column without a fixed width gives way before a whole column drops out; the labels then get truncated.
  if (message() < MESSAGE_MIN && state.get("refs")?.width === null) widths.refs = Math.max(REFS_SOFT_MIN, widths.refs - (MESSAGE_MIN - message()));
  while (message() < MESSAGE_MIN && optional.length > 0) {
    squeezed.unshift(optional[optional.length - 1]!);
    optional = optional.slice(0, -1);
  }
  if (message() < MESSAGE_MIN) widths.refs = Math.max(COLUMN_LIMITS.refs.min, widths.refs - (MESSAGE_MIN - message()));
  if (message() < MESSAGE_MIN) widths.graph = Math.max(COLUMN_LIMITS.graph.min, widths.graph - (MESSAGE_MIN - message()));
  widths.message = Math.max(MESSAGE_MIN, message());

  const order: GraphColumnId[] = [...FIXED_COLUMNS, ...optional];
  return { order, widths, graphLeft: widths.refs, squeezed, total: order.reduce((sum, id) => sum + widths[id], 0) };
}
