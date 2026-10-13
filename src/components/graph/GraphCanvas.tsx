import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { GraphRow } from "../../core";
import type { PaintRow } from "./decor";
import { paintGraph, readMetrics, readPalette, rootZoom, type GraphMetrics, type GraphPalette } from "./geometry";

export interface GraphCanvasProps {
  /** The scrolling element of the row list. */
  scrollerRef: RefObject<HTMLElement | null>;
  /** All loaded rows in display order (index = row). */
  rows: GraphRow[];
  /** Left edge and width of the graph column in CSS pixels. */
  left: number;
  width: number;
  /** Total height of the list; the canvas never extends beyond it. */
  totalHeight: number;
  /**
   * Pinning and highlighting: returns the rows of a section as they are drawn.
   * A new object means "redraw"; without it (null) the core's rows are drawn unchanged.
   */
  decor?: GraphDecor | null;
}

export interface GraphDecor {
  /** Rows `first…last` (inclusive) for the canvas. */
  rows(first: number, last: number): (index: number) => PaintRow | undefined;
}

/** Counters for tests and measurements (only visible in the development build). */
export const graphStats = { paints: 0, lastPaintMs: 0, rowRenders: 0 };

declare global {
  interface Window {
    __gcGraphStats?: typeof graphStats;
  }
}
if (import.meta.env.DEV && typeof window !== "undefined") window.__gcGraphStats = graphStats;

/** Rows above and below the visible area that are drawn along. */
const MIN_BUFFER_ROWS = 24;
/** At this few rows of distance to the edge of the canvas, it is repositioned. */
const EDGE_ROWS = 6;

/**
 * The graph column as a canvas. The canvas is a window of about three screen heights
 * that lies INSIDE the list's content and scrolls with it: during normal scrolling nothing is
 * redrawn and nothing lags behind the rows. Only when the visible area reaches the
 * edge of the window is it moved and redrawn in the same step (no flicker).
 */
export function GraphCanvas({ scrollerRef, rows, left, width, totalHeight, decor = null }: GraphCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const state = useRef({
    rows,
    width,
    totalHeight,
    decor,
    top: 0,
    height: 0,
    scale: 0,
    metrics: null as GraphMetrics | null,
    palette: null as GraphPalette | null,
  });
  state.current.rows = rows;
  state.current.width = width;
  state.current.totalHeight = totalHeight;
  state.current.decor = decor;

  const update = useRef((_force: boolean) => {});
  update.current = (force: boolean) => {
    const canvas = canvasRef.current;
    const scroller = scrollerRef.current;
    if (!canvas || !scroller) return;
    const current = state.current;
    if (!current.metrics || !current.palette) {
      current.metrics = readMetrics();
      current.palette = readPalette();
    }
    const { metrics, palette } = current;
    const rowHeight = metrics.rowHeight;
    const viewTop = scroller.scrollTop;
    const viewHeight = scroller.clientHeight;
    const scale = (window.devicePixelRatio || 1) * rootZoom();

    const edge = EDGE_ROWS * rowHeight;
    const inside =
      (current.top === 0 || viewTop >= current.top + edge) &&
      (current.top + current.height >= current.totalHeight || viewTop + viewHeight <= current.top + current.height - edge);
    if (!force && inside && scale === current.scale) return;

    const buffer = Math.max(MIN_BUFFER_ROWS, Math.ceil(viewHeight / rowHeight)) * rowHeight;
    const top = Math.max(0, Math.floor((viewTop - buffer) / rowHeight) * rowHeight);
    const height = Math.max(0, Math.min(current.totalHeight - top, Math.ceil((viewTop + viewHeight + buffer - top) / rowHeight) * rowHeight));
    const pixelWidth = Math.max(1, Math.round(current.width * scale));
    const pixelHeight = Math.max(1, Math.round(height * scale));

    const started = performance.now();
    // Set the size only when it changes: setting it clears the canvas and costs a memory allocation.
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    canvas.style.width = `${current.width}px`;
    canvas.style.height = `${height}px`;
    canvas.style.transform = `translateY(${top}px)`;
    current.top = top;
    current.height = height;
    current.scale = scale;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const list = current.rows;
    const first = Math.floor(top / rowHeight);
    const last = Math.min(list.length - 1, Math.ceil((top + height) / rowHeight) - 1);
    paintGraph({
      ctx,
      rowAt: current.decor && last >= first ? current.decor.rows(first, last) : (index) => list[index],
      first,
      last,
      originY: top,
      scale,
      width: pixelWidth,
      height: pixelHeight,
      metrics,
      palette,
    });
    graphStats.paints += 1;
    graphStats.lastPaintMs = performance.now() - started;
  };

  // Data, width or height changed: redraw before the next frame.
  useLayoutEffect(() => {
    update.current(true);
  }, [rows, width, totalHeight, decor]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const onScroll = () => update.current(false);
    scroller.addEventListener("scroll", onScroll, { passive: true });

    const resize = new ResizeObserver(() => update.current(true));
    resize.observe(scroller);

    // Theme and zoom hang on the root element; re-read colours and dimensions.
    const refresh = () => {
      state.current.metrics = null;
      state.current.palette = null;
      update.current(true);
    };
    const theme = new MutationObserver(refresh);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style", "class"] });
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", refresh);

    // devicePixelRatio changes when moving to another screen and on WebView zoom.
    let density: MediaQueryList | null = null;
    const watchDensity = () => {
      density?.removeEventListener("change", onDensity);
      density = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      density.addEventListener("change", onDensity);
    };
    const onDensity = () => {
      watchDensity();
      update.current(true);
    };
    watchDensity();
    const onWindowResize = () => update.current(false);
    window.addEventListener("resize", onWindowResize);

    return () => {
      scroller.removeEventListener("scroll", onScroll);
      resize.disconnect();
      theme.disconnect();
      scheme.removeEventListener("change", refresh);
      density?.removeEventListener("change", onDensity);
      window.removeEventListener("resize", onWindowResize);
    };
  }, [scrollerRef]);

  return <canvas ref={canvasRef} aria-hidden data-graph-canvas className="pointer-events-none absolute top-0 z-10" style={{ left }} />;
}
