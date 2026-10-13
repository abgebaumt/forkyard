/**
 * Minimap of the diff: a narrow bar on the right that squeezes the whole file into the height of
 * the view. Removed lines are in the left half, added lines in the right (the position says it,
 * not only the colour); a frame shows the visible range. Clicking or dragging jumps.
 *
 * Purely supplementary (aria-hidden): with the keyboard you move between the changes with F7 /
 * Shift+F7; the bar takes no focus.
 *
 * Drawing happens on a canvas, at most once per frame and less often for very large diffs. The
 * frame of the visible range is a separate element and follows scrolling without redrawing.
 */
import { useEffect, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

export type MinimapKind = "add" | "remove";

export interface MinimapSource {
  /** The scrolling element of the diff. */
  scroller(): HTMLElement | null;
  /** Total height of the content in CSS pixels. */
  total(): number;
  /** Calls `emit` for every changed stretch (top and bottom edge in CSS pixels of the content). */
  marks(emit: (top: number, bottom: number, kind: MinimapKind) => void): void;
  /** Approximate number of lines – from several tens of thousands on, drawing happens less often. */
  size: number;
}

/** From this many lines on, redrawing happens at most every LARGE_INTERVAL_MS. */
const LARGE_SIZE = 20_000;
const LARGE_INTERVAL_MS = 160;
const ADD = 1;
const REMOVE = 2;

function readColors() {
  const style = getComputedStyle(document.documentElement);
  return { add: style.getPropertyValue("--gc-success").trim() || "currentColor", remove: style.getPropertyValue("--gc-danger").trim() || "currentColor" };
}

export interface DiffMinimapProps {
  source: MinimapSource;
  /** When the value changes, it is redrawn (new diff, wrapping, collapsed regions, new heights). */
  version: unknown;
}

export function DiffMinimap({ source, version }: DiffMinimapProps) {
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const latest = useRef(source);
  latest.current = source;
  const state = useRef({ frame: 0, timer: 0, lastDraw: 0, scale: 1, colors: null as ReturnType<typeof readColors> | null });

  const placeThumb = useRef(() => {});
  placeThumb.current = () => {
    const scroller = latest.current.scroller();
    const element = thumb.current;
    const host = root.current;
    if (!scroller || !element || !host) return;
    const { scale } = state.current;
    const height = Math.min(host.clientHeight, Math.max(scroller.clientHeight * scale, 1));
    const top = Math.min(host.clientHeight - height, Math.max(0, scroller.scrollTop * scale));
    element.style.height = `${height}px`;
    element.style.transform = `translateY(${top}px)`;
    // If everything fits into view, there is no visible range to show.
    element.hidden = scroller.scrollHeight <= scroller.clientHeight + 1;
  };

  const draw = useRef(() => {});
  draw.current = () => {
    const host = root.current;
    const surface = canvas.current;
    if (!host || !surface) return;
    const current = state.current;
    current.lastDraw = performance.now();
    const cssWidth = host.clientWidth;
    const cssHeight = host.clientHeight;
    if (cssWidth === 0 || cssHeight === 0) return;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(cssWidth * ratio));
    const height = Math.max(1, Math.round(cssHeight * ratio));
    if (surface.width !== width) surface.width = width;
    if (surface.height !== height) surface.height = height;
    const total = Math.max(1, latest.current.total());
    // Short diffs are not stretched: at most 1:1.
    current.scale = Math.min(1, cssHeight / total);
    const perPixel = current.scale * ratio;

    // Remember per pixel row what lies there – many lines of the diff fall onto the same one.
    const buckets = new Uint8Array(height);
    const minMark = Math.max(2, Math.round(2 * ratio));
    let added = 0;
    let removed = 0;
    latest.current.marks((top, bottom, kind) => {
      const bit = kind === "add" ? ADD : REMOVE;
      if (bit === ADD) added += 1;
      else removed += 1;
      const from = Math.min(height - 1, Math.max(0, Math.floor(top * perPixel)));
      const to = Math.min(height, Math.max(from + minMark, Math.ceil(bottom * perPixel)));
      for (let y = from; y < to; y++) buckets[y] = buckets[y]! | bit;
    });

    const ctx = surface.getContext("2d");
    if (!ctx) return;
    current.colors ??= readColors();
    ctx.clearRect(0, 0, width, height);
    const half = Math.floor(width / 2);
    const gap = Math.max(1, Math.round(ratio));
    const paint = (bit: number, color: string, x: number, w: number) => {
      ctx.fillStyle = color;
      let start = -1;
      for (let y = 0; y <= height; y++) {
        const on = y < height && (buckets[y]! & bit) !== 0;
        if (on && start < 0) start = y;
        else if (!on && start >= 0) {
          ctx.fillRect(x, start, w, y - start);
          start = -1;
        }
      }
    };
    paint(REMOVE, current.colors.remove, gap, half - gap);
    paint(ADD, current.colors.add, half + gap, width - half - 2 * gap);
    host.dataset.marksAdded = String(added);
    host.dataset.marksRemoved = String(removed);
    host.dataset.scale = current.scale.toFixed(4);
    // For measurements: how often it was drawn (scrolling alone must not redraw anything).
    host.dataset.draws = String(Number(host.dataset.draws ?? 0) + 1);
    placeThumb.current();
  };

  /** Draws on the next frame – for very large diffs at most every 160 ms. */
  const schedule = useRef(() => {});
  schedule.current = () => {
    const current = state.current;
    if (current.frame || current.timer) return;
    const wait = latest.current.size >= LARGE_SIZE ? Math.max(0, LARGE_INTERVAL_MS - (performance.now() - current.lastDraw)) : 0;
    const run = () => {
      current.timer = 0;
      current.frame = requestAnimationFrame(() => {
        current.frame = 0;
        draw.current();
      });
    };
    if (wait > 0) current.timer = window.setTimeout(run, wait);
    else run();
  };

  // New content: draw immediately (before the first frame) if it was never drawn, otherwise throttled.
  useLayoutEffect(() => {
    if (state.current.lastDraw === 0) draw.current();
    else schedule.current();
  }, [version]);

  useEffect(() => {
    const host = root.current;
    const scroller = latest.current.scroller();
    if (!host) return;
    const current = state.current;
    const onScroll = () => placeThumb.current();
    scroller?.addEventListener("scroll", onScroll, { passive: true });
    const resize = new ResizeObserver(() => schedule.current());
    resize.observe(host);
    if (scroller) resize.observe(scroller);
    // Theme-Wechsel: Farben neu lesen.
    const theme = new MutationObserver(() => {
      current.colors = null;
      schedule.current();
    });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    return () => {
      scroller?.removeEventListener("scroll", onScroll);
      resize.disconnect();
      theme.disconnect();
      cancelAnimationFrame(current.frame);
      window.clearTimeout(current.timer);
      current.frame = 0;
      current.timer = 0;
    };
  }, []);

  // --- Clicking and dragging ------------------------------------------------------------------
  const dragging = useRef(false);
  const jump = (event: ReactPointerEvent<HTMLDivElement>) => {
    const host = root.current;
    const scroller = latest.current.scroller();
    if (!host || !scroller) return;
    const box = host.getBoundingClientRect();
    // getBoundingClientRect and clientY are both unscaled; the height of the bar in CSS pixels gives the ratio.
    const y = ((event.clientY - box.top) / Math.max(1, box.height)) * host.clientHeight;
    // The clicked spot goes to the middle of the visible range.
    scroller.scrollTop = y / state.current.scale - scroller.clientHeight / 2;
  };

  return (
    <div
      ref={root}
      aria-hidden
      data-diff-minimap=""
      className="relative w-minimap shrink-0 cursor-pointer touch-none border-l border-border bg-surface select-none"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragging.current = true;
        jump(event);
      }}
      onPointerMove={(event) => {
        if (dragging.current) jump(event);
      }}
      onPointerUp={() => {
        dragging.current = false;
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
    >
      <canvas ref={canvas} className="absolute inset-0 size-full" />
      <div ref={thumb} data-minimap-thumb="" className="pointer-events-none absolute inset-x-0 top-0 rounded-sm border border-border-input bg-text/10" />
    </div>
  );
}
