/**
 * Geometry of the commit graph: dimensions from the design tokens and drawing a
 * section onto canvas. Pure functions, no React.
 *
 * Coordinates: callers compute in CSS pixels (row × row height). Drawing happens in
 * device pixels, aligned to whole pixels – that keeps vertical lines sharp at any
 * scaling (devicePixelRatio, app zoom), and the pieces of two rows join
 * without a seam.
 */
import type { PaintRow } from "./decor";

export interface GraphMetrics {
  /** Row height (--gc-size-graph-row). */
  rowHeight: number;
  /** Distance between two lanes (--gc-size-lane). */
  lane: number;
  /** Diameter of a node (--gc-size-node). */
  node: number;
  /** Stroke width of the edges (--gc-size-edge). */
  edge: number;
  /** Margin left and right of the lanes (two steps of the spacing grid). */
  pad: number;
}

export interface GraphPalette {
  /** lane-1 … lane-8. */
  lanes: string[];
}

const LANE_COLORS = 8;
/**
 * Opacity of dimmed lines and nodes (highlighting a branch) – the same value as the
 * utility `opacity-40` used to draw dimmed rows and ref labels.
 */
export const DIM_ALPHA = 0.4;

function px(style: CSSStyleDeclaration, name: string, fallback: number): number {
  const value = Number.parseFloat(style.getPropertyValue(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Dimensions from the CSS variables. The fallback values match tokens.json › size. */
export function readMetrics(root: Element = document.documentElement): GraphMetrics {
  const style = getComputedStyle(root);
  return {
    rowHeight: px(style, "--gc-size-graph-row", 28),
    lane: px(style, "--gc-size-lane", 16),
    node: px(style, "--gc-size-node", 10),
    edge: px(style, "--gc-size-edge", 2),
    pad: 2 * px(style, "--spacing", 4),
  };
}

export function readPalette(root: Element = document.documentElement): GraphPalette {
  const style = getComputedStyle(root);
  const lanes: string[] = [];
  for (let index = 1; index <= LANE_COLORS; index++) lanes.push(style.getPropertyValue(`--gc-lane-${index}`).trim() || "currentColor");
  return { lanes };
}

/** Centre of a lane, in CSS pixels from the left edge of the graph column. */
export const laneX = (lane: number, metrics: GraphMetrics) => metrics.pad + lane * metrics.lane + metrics.lane / 2;

/** Width needed by all lanes up to `maxLane`. */
export const graphWidthFor = (maxLane: number, metrics: GraphMetrics) => 2 * metrics.pad + (Math.max(0, maxLane) + 1) * metrics.lane;

/** App zoom (CSS `zoom` on the root element). Pointer coordinates are unzoomed, CSS lengths zoomed. */
export function rootZoom(): number {
  const zoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom || "1");
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

export interface PaintJob {
  ctx: CanvasRenderingContext2D;
  /** Row for a list index; undefined = draw nothing. */
  rowAt: (index: number) => PaintRow | undefined;
  /** First and last index (inclusive) to draw. */
  first: number;
  last: number;
  /** CSS pixels of the list position at the top edge of the canvas. */
  originY: number;
  /** Device pixels per CSS pixel. */
  scale: number;
  /** Size of the canvas in device pixels. */
  width: number;
  height: number;
  metrics: GraphMetrics;
  palette: GraphPalette;
}

/**
 * Draws edges and nodes of the rows `first…last`.
 *
 * Edges per row (see GraphEdge):
 *   top = bottom        vertically through the row
 *   top ≠ bottom        smooth lane change over the row height
 *   top → node          vertically or with a rounded corner into the node
 *   node → bottom       vertically or horizontally out of the node and down with a rounded corner
 */
export function paintGraph(job: PaintJob): void {
  const { ctx, rowAt, first, last, originY, scale, metrics, palette } = job;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, job.width, job.height);
  if (last < first) return;

  const lineWidth = Math.max(1, Math.round(metrics.edge * scale));
  // Odd stroke widths lie on half pixels, even ones on whole pixels.
  const half = (lineWidth % 2) / 2;
  const snap = (css: number) => Math.round(css * scale - half) + half;
  const edgeY = (css: number) => Math.round((css - originY) * scale);
  const x = (lane: number) => snap(laneX(lane, metrics));
  const rowPx = metrics.rowHeight * scale;
  const corner = Math.min(metrics.rowHeight / 2, metrics.lane * 0.75) * scale;

  // Group edges by colour, dash style and "dimmed": few state changes, one stroke() per group.
  const groups = new Map<number, Path2D>();
  const pathFor = (color: number, dashed: boolean, dim: boolean) => {
    const key = (((color % LANE_COLORS) + LANE_COLORS) % LANE_COLORS) * 4 + (dashed ? 1 : 0) + (dim ? 2 : 0);
    let path = groups.get(key);
    if (!path) {
      path = new Path2D();
      groups.set(key, path);
    }
    return path;
  };

  for (let index = first; index <= last; index++) {
    const row = rowAt(index);
    if (!row || row.edges.length === 0) continue;
    const top = edgeY(index * metrics.rowHeight);
    const bottom = edgeY((index + 1) * metrics.rowHeight);
    const middle = Math.round((top + bottom) / 2 - half) + half;
    const nodeX = x(row.lane);
    for (const edge of row.edges) {
      const path = pathFor(edge.color, edge.dashed, edge.dim === true);
      if (edge.top !== null && edge.bottom !== null) {
        const from = x(edge.top);
        const to = x(edge.bottom);
        path.moveTo(from, top);
        if (from === to) path.lineTo(to, bottom);
        else path.bezierCurveTo(from, middle, to, middle, to, bottom);
      } else if (edge.top !== null) {
        const from = x(edge.top);
        path.moveTo(from, top);
        if (from === nodeX) {
          path.lineTo(nodeX, middle);
        } else {
          // Stay in the own lane and only turn in at the height of the node.
          const radius = Math.min(corner, Math.abs(nodeX - from), middle - top);
          const direction = nodeX > from ? 1 : -1;
          path.lineTo(from, middle - radius);
          path.quadraticCurveTo(from, middle, from + direction * radius, middle);
          path.lineTo(nodeX, middle);
        }
      } else if (edge.bottom !== null) {
        const to = x(edge.bottom);
        path.moveTo(nodeX, middle);
        if (to === nodeX) {
          path.lineTo(to, bottom);
        } else {
          // Turn into the target lane immediately, then continue vertically.
          const radius = Math.min(corner, Math.abs(to - nodeX), bottom - middle);
          const direction = to > nodeX ? 1 : -1;
          path.lineTo(to - direction * radius, middle);
          path.quadraticCurveTo(to, middle, to, middle + radius);
          path.lineTo(to, bottom);
        }
      }
    }
  }

  ctx.lineWidth = lineWidth;
  ctx.lineCap = "butt";
  ctx.lineJoin = "round";
  // Four dashes per row: the pattern completes at every row boundary and continues without a jump.
  const period = rowPx / 4;
  // Dimmed groups first: highlighted lines lie on top where two cross.
  for (const dimPass of [true, false]) {
    for (const [key, path] of groups) {
      if (((key & 2) !== 0) !== dimPass) continue;
      ctx.globalAlpha = dimPass ? DIM_ALPHA : 1;
      ctx.strokeStyle = palette.lanes[key >> 2] ?? "currentColor";
      ctx.setLineDash(key & 1 ? [period * 0.55, period * 0.45] : []);
      ctx.stroke(path);
    }
  }
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);

  // Nodes lie above the edges. A narrow gap around the node is punched out
  // instead of painting it in the background colour: that way it is also correct on selected rows.
  const radius = (metrics.node / 2) * scale;
  const gap = Math.max(1, 1.5 * scale);
  const punch = (draw: () => void) => {
    const alpha = ctx.globalAlpha;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "destination-out";
    ctx.beginPath();
    draw();
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = alpha;
  };
  for (let index = first; index <= last; index++) {
    const row = rowAt(index);
    // The placeholder row "No changes" has no node (lane −1).
    if (!row || row.lane < 0) continue;
    const top = edgeY(index * metrics.rowHeight);
    const bottom = edgeY((index + 1) * metrics.rowHeight);
    const cy = Math.round((top + bottom) / 2 - half) + half;
    const cx = x(row.lane);
    const color = palette.lanes[((row.color % LANE_COLORS) + LANE_COLORS) % LANE_COLORS] ?? "currentColor";
    // Punching out resets the opacity itself; only what is painted afterwards is dimmed.
    ctx.globalAlpha = row.dim ? DIM_ALPHA : 1;
    ctx.fillStyle = color;
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;

    if (row.kind === "wip") {
      const ring = radius - lineWidth / 2;
      punch(() => ctx.arc(cx, cy, radius + gap / 2, 0, Math.PI * 2));
      const dash = (Math.PI * 2 * ring) / 8;
      ctx.setLineDash([dash, dash]);
      ctx.beginPath();
      ctx.arc(cx, cy, ring, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (row.kind === "stash") {
      const side = Math.round(radius * 2 - lineWidth);
      const left = Math.round(cx - side / 2 - half) + half;
      const upper = Math.round(cy - side / 2 - half) + half;
      const outer = lineWidth / 2 + gap / 2;
      punch(() => ctx.rect(left - outer, upper - outer, side + 2 * outer, side + 2 * outer));
      ctx.beginPath();
      ctx.roundRect(left, upper, side, side, Math.max(1, scale));
      ctx.stroke();
    } else if (row.kind === "merge") {
      const small = Math.max(1.5 * scale, radius - 1.5 * scale);
      punch(() => ctx.arc(cx, cy, small + gap, 0, Math.PI * 2));
      ctx.beginPath();
      ctx.arc(cx, cy, small, 0, Math.PI * 2);
      ctx.fill();
    } else if (row.isHead) {
      // The checked-out commit: ring with a dot – distinguishable from the others even without colour.
      const ring = radius + scale - lineWidth / 2;
      punch(() => ctx.arc(cx, cy, radius + scale + gap, 0, Math.PI * 2));
      ctx.beginPath();
      ctx.arc(cx, cy, ring, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(scale, radius - 2.5 * scale), 0, Math.PI * 2);
      ctx.fill();
    } else {
      punch(() => ctx.arc(cx, cy, radius + gap, 0, Math.PI * 2));
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}
