import { clsx, type ClassValue } from "clsx";

export function cn(...values: ClassValue[]): string {
  return clsx(values);
}

/** Lane colour of the graph as a CSS variable. There are eight lane colours, after that they repeat. */
export function laneColor(lane: number): string {
  return `var(--gc-lane-${(((lane % 8) + 8) % 8) + 1})`;
}
