/**
 * Image comparison without DOM: the four view modes, the remembered choice and the geometry
 * of the stacked modes (swipe, onion skin). The pixel comparison follows below (Task 3).
 * The drawing happens in ImageDiff.tsx.
 */
import type { CSSProperties } from "react";
import { t } from "../../i18n";

export type ImageMode = "side" | "swipe" | "onion" | "difference";
export const IMAGE_MODES: readonly ImageMode[] = ["side", "swipe", "onion", "difference"];

/** Below this width and height an image is shown enlarged with crisp pixel edges. */
export const SMALL_IMAGE_PX = 192;

const MODE_KEY = "gc.imageDiff.mode";

const MODE_LABELS: Record<ImageMode, string> = {
  side: t("diff.image.modes.side"),
  swipe: t("diff.image.modes.swipe"),
  onion: t("diff.image.modes.onion"),
  difference: t("diff.image.modes.difference"),
};

/** Last chosen mode; without storage (private window, blocked) side by side. */
export function loadImageMode(): ImageMode {
  try {
    const stored = localStorage.getItem(MODE_KEY);
    return IMAGE_MODES.find((mode) => mode === stored) ?? "side";
  } catch {
    return "side";
  }
}

export function saveImageMode(mode: ImageMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // then the choice only applies until restart
  }
}

/** Added or deleted image: only one side exists, there is nothing to lay on top of each other. */
export function effectiveMode(wanted: ImageMode, hasOld: boolean, hasNew: boolean): ImageMode {
  return hasOld && hasNew ? wanted : "side";
}

export interface ModeOption {
  value: ImageMode;
  label: string;
  disabled: boolean;
  hint?: string;
}

export function modeOptions(hasOld: boolean, hasNew: boolean): ModeOption[] {
  const both = hasOld && hasNew;
  return IMAGE_MODES.map((value) => {
    const disabled = value !== "side" && !both;
    return { value, label: MODE_LABELS[value], disabled, hint: disabled ? t("diff.image.onlyOneSide") : undefined };
  });
}

export interface Size {
  width: number;
  height: number;
}

/** Frame size in pixels; `before`/`after`: share of each image in percent of the frame. */
export interface StackGeometry {
  width: number;
  height: number;
  before: Size;
  after: Size;
}

export const sameSize = (a: Size, b: Size) => a.width === b.width && a.height === b.height;

/** Both images at the same scale, aligned at the top left, in a frame as large as both together. */
export function stackGeometry(before: Size, after: Size): StackGeometry {
  const width = Math.max(before.width, after.width, 1);
  const height = Math.max(before.height, after.height, 1);
  const share = (size: Size): Size => ({ width: (size.width / width) * 100, height: (size.height / height) * 100 });
  return { width, height, before: share(before), after: share(after) };
}

/**
 * The frame fills the stage (a size container) as far as its aspect ratio allows, but never grows
 * beyond the natural size.
 */
export function stackFrameStyle(geometry: Size): CSSProperties {
  const { width, height } = geometry;
  return { aspectRatio: `${width} / ${height}`, width: `min(100cqw, calc(100cqh * ${width} / ${height}), ${width}px)` };
}

// ---------------------------------------------------------------------------
// Pixel difference
// ---------------------------------------------------------------------------

export type Rgb = readonly [number, number, number];

/** RGBA, row by row, as `ImageData.data`. */
export interface Pixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface PixelDiff {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
  /** Number of differing pixels. */
  changed: number;
}

/** Unchanged pixels keep this share of their brightness. */
export const DIM = 0.25;

/** Larger images are not compared pixel by pixel (four bytes per pixel, three bitmaps at once). */
export const MAX_DIFF_PIXELS = 4096 * 4096;

export function canCompare(a: Size, b: Size): boolean {
  return Math.max(a.width, b.width) * Math.max(a.height, b.height) <= MAX_DIFF_PIXELS;
}

/** Offset of the pixel (x, y) in `image.data`, or -1 outside the image. */
function offset(image: Pixels, x: number, y: number): number {
  return x < image.width && y < image.height ? (y * image.width + x) * 4 : -1;
}

/**
 * Both images aligned at the top left in a canvas as large as both together. Differing pixels
 * get the highlight colour (opaque), the rest is dimmed. Pixels that are fully transparent on
 * both sides – or that exist on one side only and are transparent there – count as equal.
 */
export function pixelDifference(before: Pixels, after: Pixels, highlight: Rgb): PixelDiff {
  const width = Math.max(before.width, after.width);
  const height = Math.max(before.height, after.height);
  const data = new Uint8ClampedArray(width * height * 4);
  let changed = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const a = offset(before, x, y);
      const b = offset(after, x, y);
      const out = (y * width + x) * 4;
      const alphaA = a < 0 ? 0 : (before.data[a + 3] ?? 0);
      const alphaB = b < 0 ? 0 : (after.data[b + 3] ?? 0);
      if (alphaA === 0 && alphaB === 0) continue;
      const same =
        a >= 0 &&
        b >= 0 &&
        alphaA === alphaB &&
        before.data[a] === after.data[b] &&
        before.data[a + 1] === after.data[b + 1] &&
        before.data[a + 2] === after.data[b + 2];
      if (!same) {
        changed += 1;
        data[out] = highlight[0];
        data[out + 1] = highlight[1];
        data[out + 2] = highlight[2];
        data[out + 3] = 255;
        continue;
      }
      data[out] = (after.data[b] ?? 0) * DIM;
      data[out + 1] = (after.data[b + 1] ?? 0) * DIM;
      data[out + 2] = (after.data[b + 2] ?? 0) * DIM;
      data[out + 3] = alphaB;
    }
  }
  return { width, height, data, changed };
}

/** `#rgb` or `#rrggbb` (the token format); other notations yield null. */
export function hexToRgb(value: string): Rgb | null {
  const hex = value.trim().replace(/^#/, "");
  const full = hex.length === 3 ? [...hex].map((char) => char + char).join("") : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) return null;
  const number = Number.parseInt(full, 16);
  return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
}
