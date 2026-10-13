import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { rootZoom } from "./geometry";

export interface DragSource {
  fullName: string;
  kind: string;
  rowIndex: number;
}

export interface DropTarget {
  /** `fullName` of the target ref. */
  fullName: string;
  /** Element that is marked as the target (label or row). */
  element: Element;
}

export interface RefDragOptions {
  scrollerRef: RefObject<HTMLElement | null>;
  /** May this label be dragged? */
  canDrag: (source: DragSource) => boolean;
  /**
   * Target under the pointer: `label` is the ref label there (if any), `rowIndex` the row.
   * Returning null = cannot drop here.
   */
  resolveTarget: (source: DragSource, under: { label: { fullName: string; element: Element } | null; row: { index: number; element: Element } | null }) => DropTarget | null;
  onDrop: (source: DragSource, target: DropTarget, point: { x: number; y: number }) => void;
}

/** From this distance (unzoomed pixels) on, a pressed label counts as dragged. */
const THRESHOLD = 5;
/** Distance to the top or bottom edge of the list within which it keeps scrolling by itself. */
const SCROLL_ZONE = 32;

interface Session {
  source: DragSource;
  element: HTMLElement;
  startX: number;
  startY: number;
  x: number;
  y: number;
  dragging: boolean;
  ghost: HTMLElement | null;
  target: DropTarget | null;
  frame: number;
  stop: () => void;
}

/**
 * Dragging a ref label with pointer events (no HTML5 drag and drop: Tauri intercepts that on
 * Windows). The target is marked directly on the DOM (`data-drop`) so that no row is re-rendered
 * while dragging. Esc cancels; on release over a target, `onDrop` reports the spot.
 */
export function useRefDrag(options: RefDragOptions) {
  const latest = useRef(options);
  latest.current = options;
  const session = useRef<Session | null>(null);

  const finish = useCallback(() => {
    const current = session.current;
    if (!current) return;
    session.current = null;
    current.stop();
    cancelAnimationFrame(current.frame);
    current.ghost?.remove();
    current.element.removeAttribute("data-dragging");
    current.target?.element.removeAttribute("data-drop");
    document.documentElement.removeAttribute("data-ref-dragging");
  }, []);

  useEffect(() => finish, [finish]);

  const track = (current: Session) => {
    const { resolveTarget } = latest.current;
    const under = document.elementFromPoint(current.x, current.y);
    const labelElement = under?.closest("[data-ref-full]") ?? null;
    const rowElement = under?.closest("[data-row-index]") ?? null;
    const labelName = labelElement?.getAttribute("data-ref-full") ?? null;
    const next = resolveTarget(current.source, {
      label: labelElement && labelName ? { fullName: labelName, element: labelElement } : null,
      row: rowElement ? { index: Number(rowElement.getAttribute("data-row-index")), element: rowElement } : null,
    });
    if (next?.element !== current.target?.element) {
      current.target?.element.removeAttribute("data-drop");
      next?.element.setAttribute("data-drop", "true");
    }
    current.target = next;
    if (current.ghost) {
      const zoom = rootZoom();
      current.ghost.style.transform = `translate(${(current.x + 12) / zoom}px, ${(current.y + 14) / zoom}px)`;
      current.ghost.dataset.over = next ? "true" : "false";
    }
  };

  const autoScroll = (current: Session) => {
    const scroller = latest.current.scrollerRef.current;
    if (scroller && current.dragging) {
      const box = scroller.getBoundingClientRect();
      const above = box.top + SCROLL_ZONE - current.y;
      const below = current.y - (box.bottom - SCROLL_ZONE);
      const speed = above > 0 ? -Math.min(24, above) : below > 0 ? Math.min(24, below) : 0;
      if (speed !== 0 && current.x >= box.left && current.x <= box.right) {
        scroller.scrollTop += speed;
        track(current);
      }
    }
    current.frame = requestAnimationFrame(() => {
      if (session.current === current) autoScroll(current);
    });
  };

  const begin = (current: Session) => {
    current.dragging = true;
    current.element.setAttribute("data-dragging", "true");
    document.documentElement.setAttribute("data-ref-dragging", "true");
    // The label's image follows the pointer; it does not catch pointer events itself.
    const ghost = document.createElement("div");
    ghost.setAttribute("aria-hidden", "true");
    ghost.dataset.refGhost = "true";
    ghost.className = "pointer-events-none fixed top-0 left-0 z-50 inline-flex rounded-sm shadow-pop data-[over=false]:opacity-60";
    ghost.append(current.element.cloneNode(true));
    ghost.firstElementChild?.removeAttribute("data-dragging");
    ghost.firstElementChild?.removeAttribute("data-ref-full");
    document.body.append(ghost);
    current.ghost = ghost;
    autoScroll(current);
  };

  const onPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      if (event.button !== 0 || session.current) return;
      const element = (event.target as Element).closest<HTMLElement>("[data-ref-full]");
      if (!element) return;
      const source: DragSource = {
        fullName: element.getAttribute("data-ref-full") ?? "",
        kind: element.getAttribute("data-ref-kind") ?? "",
        rowIndex: Number(element.getAttribute("data-ref-row") ?? -1),
      };
      if (!source.fullName || !latest.current.canDrag(source)) return;

      const onMove = (move: PointerEvent) => {
        const current = session.current;
        if (!current) return;
        current.x = move.clientX;
        current.y = move.clientY;
        if (!current.dragging) {
          if (Math.hypot(current.x - current.startX, current.y - current.startY) < THRESHOLD) return;
          begin(current);
        }
        track(current);
      };
      const onUp = (up: PointerEvent) => {
        const current = session.current;
        if (!current) return;
        const { dragging, target } = current;
        const point = { x: up.clientX, y: up.clientY };
        finish();
        if (dragging && target) latest.current.onDrop(current.source, target, point);
      };
      const onKey = (key: KeyboardEvent) => {
        if (key.key !== "Escape" || !session.current?.dragging) return;
        key.preventDefault();
        key.stopPropagation();
        finish();
      };
      const onCancel = () => finish();
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("blur", onCancel);
      window.addEventListener("keydown", onKey, true);
      session.current = {
        source,
        element,
        startX: event.clientX,
        startY: event.clientY,
        x: event.clientX,
        y: event.clientY,
        dragging: false,
        ghost: null,
        target: null,
        frame: 0,
        stop: () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          window.removeEventListener("pointercancel", onCancel);
          window.removeEventListener("blur", onCancel);
          window.removeEventListener("keydown", onKey, true);
        },
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [finish],
  );

  /** Is a drag in progress? (For click handlers that should do nothing afterwards.) */
  const isDragging = useCallback(() => session.current?.dragging === true, []);

  return { onPointerDown, isDragging, cancel: finish };
}
