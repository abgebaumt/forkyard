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
