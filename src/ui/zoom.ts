/**
 * UI zoom (CSS `zoom` on the root element) – and how much of it actually applies in the window.
 *
 * The views are built for at least 960x600 layout pixels (the smallest window at 100 %).
 * A zoom of 150 % in a 960 px wide window would leave only 640x400 of that: toolbar and
 * Commit Panel ran into each other, dialogs stuck out of the window. So the configured zoom
 * only applies as far as the window still provides this minimum area; with a larger window it
 * takes full effect. Zooming out (below 100 %) is not affected.
 */
import { useEffect, useState } from "react";

/** Smallest area in layout pixels the views are built for. */
export const MIN_LAYOUT = { width: 960, height: 600 } as const;

/** The zoom that applies at this window size (rounded down to whole percent). */
export function effectiveZoom(setting: number, width: number, height: number): number {
  if (!Number.isFinite(setting) || setting <= 0) return 1;
  if (setting <= 1) return setting;
  const fits = Math.floor(Math.min(width / MIN_LAYOUT.width, height / MIN_LAYOUT.height) * 100) / 100;
  return Math.max(1, Math.min(setting, fits));
}

/** Like `effectiveZoom`, follows the window size. */
export function useEffectiveZoom(setting: number): number {
  const read = () => (typeof window === "undefined" ? setting : effectiveZoom(setting, window.innerWidth, window.innerHeight));
  const [zoom, setZoom] = useState(read);
  useEffect(() => {
    const update = () => setZoom(read());
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
    // `read` depends only on `setting`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setting]);
  return zoom;
}

/** The currently applied zoom (for calculations with mouse coordinates). */
export function appliedZoom(): number {
  if (typeof document === "undefined") return 1;
  return Number(document.documentElement.style.getPropertyValue("zoom")) || 1;
}

/**
 * Distance that menus, tooltips and select lists keep from the window edge (Radix's `collisionPadding`).
 *
 * Positioning measures the window in visible pixels but calculates inside the zoomed root element,
 * i.e. in layout pixels: at a zoom above 100 % it thinks the right and bottom edges are further
 * away than they are – a menu near the edge stuck out of the window. The difference is therefore
 * added to the padding.
 */
export function collisionPadding(base = 8): number | { top: number; left: number; right: number; bottom: number } {
  const zoom = appliedZoom();
  if (zoom <= 1 || typeof window === "undefined") return base;
  const beyond = (size: number) => size - size / zoom;
  return { top: base, left: base, right: base + beyond(window.innerWidth), bottom: base + beyond(window.innerHeight) };
}
