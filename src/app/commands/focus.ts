/**
 * Jump between the areas of the window – without a mouse.
 *
 *   F6 / Shift+F6   next / previous area (Toolbar → Left Panel → view → Commit Panel)
 *   Alt+1 / 2 / 3   Left Panel / view (graph, diff …) / Commit Panel
 *
 * Each area remembers where the focus was last and gets it back there. Otherwise
 * it lands on the selected row (roving tabindex) and only as a last resort on the first
 * control. A collapsed panel is expanded by Alt+1/Alt+3 for this; F6 stops at its bar.
 */
import { t } from "../../i18n";
import { kw, type AppCommand, type CommandContext } from "../commandTypes";
import { getTabView, isLeftCollapsed } from "../store";

export type AreaId = "toolbar" | "left" | "center" | "terminal" | "right";

/** Order for F6; each area with its possible elements (open or as a bar). */
const AREAS: { id: AreaId; label: string; selector: string }[] = [
  // Only the window's toolbar, not toolbars inside views.
  { id: "toolbar", label: "Toolbar", selector: '[data-shell] > [role="toolbar"]' },
  // `data-area` does not depend on the language (unlike the aria-labels).
  { id: "left", label: "Left Panel", selector: '[data-area="left"], [data-rail="left"]' },
  { id: "center", label: "Ansicht", selector: '[data-area="center"], [data-area="manage"]' },
  // The terminal sits below the view and is only there while it is shown. Alt+4 leads into it.
  { id: "terminal", label: "Terminal", selector: '[data-area="terminal"]' },
  { id: "right", label: "Commit Panel", selector: '[data-area="right"], [data-rail="right"]' },
];

const lastFocus = new Map<AreaId, HTMLElement>();

export function areaOf(element: Element | null): AreaId | null {
  if (!element) return null;
  for (const area of AREAS) if (element.closest(area.selector)) return area.id;
  return null;
}

/** For the focus guard below: the last focused element overall, and the last one in an area. */
let lastElement: HTMLElement | null = null;
let lastInArea: { element: HTMLElement; area: AreaId } | null = null;

// Remember where the focus was last in each area (once, when the registry loads).
if (typeof document !== "undefined") {
  document.addEventListener(
    "focusin",
    (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const area = areaOf(target);
      // The area itself (fallback target while its content loads) is not a place worth remembering.
      if (area && !isAreaElement(target)) {
        lastFocus.set(area, target);
        lastInArea = { element: target, area };
      }
      lastElement = target;
    },
    true,
  );
  // If someone deliberately took the focus away (click into empty space), there is nothing to restore.
  document.addEventListener(
    "focusout",
    (event) => {
      const target = event.target;
      if (event.relatedTarget || !(target instanceof HTMLElement)) return;
      queueMicrotask(() => {
        if (document.activeElement === document.body && target.isConnected && !target.matches(":disabled") && lastElement === target) lastElement = null;
      });
    },
    true,
  );
}

const isAreaElement = (element: Element) => AREAS.some((area) => element.matches(area.selector));

function areaElement(id: AreaId): HTMLElement | null {
  const area = AREAS.find((entry) => entry.id === id)!;
  return document.querySelector<HTMLElement>(area.selector);
}

function visible(element: HTMLElement): boolean {
  if (element.closest("[inert], [aria-hidden='true']")) return false;
  // "visibility: hidden" also counts as gone (a view that stays mounted behind another).
  if (typeof element.checkVisibility === "function" && !element.checkVisibility({ visibilityProperty: true })) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

const TABBABLE =
  'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** The "home" of an area: selected row before the first control. */
const HOME = [
  "[data-focus-home]",
  '[role="row"][tabindex="0"], [role="treeitem"][tabindex="0"], [role="option"][tabindex="0"], [role="gridcell"][tabindex="0"]',
  "[data-row-focus][tabindex='0'], [data-row-index][tabindex='0'], [data-row-id][tabindex='0']",
  '[role="grid"][tabindex="0"], [role="tree"][tabindex="0"], [role="listbox"][tabindex="0"], .cm-content',
];

/**
 * Where the focus can go in an area, best first. "strict": only the last position
 * and the selected row – no arbitrary button (for the focus guard: a button with a tooltip would
 * catch the next Esc, and nobody navigated to it).
 */
function focusCandidates(area: HTMLElement, id: AreaId, strict = false): HTMLElement[] {
  const list: HTMLElement[] = [];
  const remembered = lastFocus.get(id);
  if (remembered && remembered !== area && remembered.isConnected && area.contains(remembered) && visible(remembered) && remembered.tabIndex >= -1) list.push(remembered);
  for (const selector of HOME) {
    const found = [...area.querySelectorAll<HTMLElement>(selector)].find(visible);
    if (found) list.push(found);
  }
  // Not everything that looks like it accepts focus (disabled, hidden): pass along a few fallback targets.
  if (!strict) list.push(...[...area.querySelectorAll<HTMLElement>(TABBABLE)].filter(visible).slice(0, 6));
  return [...new Set(list)];
}

/**
 * Put the focus into an area. Returns false if the area does not exist right now.
 * "scroll: false" leaves the viewport as it is (for the focus guard: nothing may jump).
 * "fallback": if nothing in the area is operable (yet), the area itself takes the focus.
 * "strict": only the last position or the selected row, no arbitrary control.
 */
export function focusArea(id: AreaId, { scroll = true, fallback = false, strict = false }: { scroll?: boolean; fallback?: boolean; strict?: boolean } = {}): boolean {
  const area = areaElement(id);
  if (!area || !visible(area)) return false;
  for (const target of focusCandidates(area, id, strict)) {
    target.focus({ preventScroll: !scroll });
    if (document.activeElement !== target) continue;
    // If the row is outside the visible viewport, scroll there.
    if (scroll) target.scrollIntoView?.({ block: "nearest" });
    return true;
  }
  if (!fallback) return false;
  // Nothing operable there (the panel is still loading, the list is empty): the area itself takes the focus,
  // so that F6 does not skip it. Tab leads in from there as soon as something is there.
  if (!area.hasAttribute("tabindex")) area.tabIndex = -1;
  area.focus({ preventScroll: true });
  return document.activeElement === area;
}

const MODAL = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]';

/**
 * If the focus is only on the area itself (the content is still loading), it moves to the row or the
 * first control as soon as it is there – as long as nobody has put the focus elsewhere in the meantime.
 * For about five seconds, once per frame.
 */
function settleOnContent(id: AreaId, strict: boolean, tries = 300): void {
  const area = areaElement(id);
  if (!area || document.activeElement !== area || tries <= 0) return;
  if (!document.querySelector(MODAL) && focusArea(id, { scroll: false, strict })) return;
  requestAnimationFrame(() => settleOnContent(id, strict, tries - 1));
}

// ---------------------------------------------------------------------------
// Focus guard
// ---------------------------------------------------------------------------

/**
 * If the focused element disappears (the staged file moves to the other list, the diff
 * closes, the tab changes, a button gets disabled), the browser drops the focus to <body> – for
 * the keyboard it is then gone: arrow keys and S/U do nothing anymore, Tab starts at the very beginning.
 * The guard puts it back into the area it was in: onto the selected row, otherwise onto
 * the area itself (and from there onto the row as soon as it is loaded). It only steps in when
 * the element is really gone – not after a click into empty space – and never while a dialog or
 * menu is open (they manage their focus themselves).
 */
function installFocusKeeper(): void {
  let pending = false;
  const gone = (element: HTMLElement) => !element.isConnected || element.matches(":disabled") || !visible(element);
  const lost = () => {
    const active = document.activeElement;
    if (active && active !== document.body) return false;
    return lastElement !== null && gone(lastElement);
  };
  const restore = () => {
    pending = false;
    if (!lost() || document.querySelector(MODAL)) return;
    // If it was a dialog or menu that closed: back to exactly the element before, if it is still there.
    if (lastInArea && lastInArea.element !== lastElement && !gone(lastInArea.element)) {
      lastInArea.element.focus({ preventScroll: true });
      if (document.activeElement === lastInArea.element) return;
    }
    // Otherwise into the area; if it no longer exists (panel collapsed), the view in the centre takes the focus.
    const options = { scroll: false, strict: true, fallback: true };
    const id = lastInArea && focusArea(lastInArea.area, options) ? lastInArea.area : focusArea("center", options) ? "center" : null;
    if (id) settleOnContent(id, true);
  };
  const check = () => {
    if (pending || !lost()) return;
    pending = true;
    // Wait two frames: whoever sets the focus themselves after their action goes first.
    requestAnimationFrame(() => requestAnimationFrame(restore));
  };
  new MutationObserver(check).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "hidden"] });
}

if (typeof document !== "undefined" && typeof MutationObserver !== "undefined") {
  if (document.body) installFocusKeeper();
  else document.addEventListener("DOMContentLoaded", installFocusKeeper, { once: true });
}

/** Waits a few frames until a just-expanded panel is there, then focuses it. */
export function focusAreaSoon(id: AreaId, tries = 20): void {
  // If a dialog, a menu or the command palette is open by now, the focus belongs there:
  // wait instead of taking it away (what the user types there would otherwise land in the area as a shortcut).
  if (document.querySelector(MODAL)) {
    if (tries > 0) requestAnimationFrame(() => focusAreaSoon(id, tries - 1));
    return;
  }
  // First wait briefly for content (a row, a field). If none comes, the area itself takes the focus –
  // and passes it on to the content as soon as that is loaded.
  if (focusArea(id)) return;
  if (tries > 0) requestAnimationFrame(() => focusAreaSoon(id, tries - 1));
  else if (focusArea(id, { fallback: true })) settleOnContent(id, false);
}

function cycle(direction: 1 | -1): void {
  const present = AREAS.filter((area) => {
    const element = areaElement(area.id);
    return element !== null && visible(element);
  });
  if (present.length === 0) return;
  const current = areaOf(document.activeElement);
  let index = present.findIndex((area) => area.id === current);
  // Focus nowhere (body): F6 starts at the view, Shift+F6 at the area before it.
  if (index < 0) index = Math.max(0, present.findIndex((area) => area.id === "center")) - (direction === 1 ? 1 : -1);
  for (let step = 1; step <= present.length; step++) {
    const next = present[(index + direction * step + present.length * 2) % present.length]!;
    if (focusArea(next.id, { fallback: true })) return;
  }
}

const hasRepo = (ctx: CommandContext) => Boolean(ctx.repoId && ctx.tabId);

/** Summary field in the Commit Panel. */
const SUMMARY_FIELD = '[data-commit-summary]';

function focusSummarySoon(tries = 30): void {
  const field = document.querySelector<HTMLElement>(SUMMARY_FIELD);
  if (field && visible(field)) {
    field.focus();
    field.scrollIntoView?.({ block: "nearest" });
    return;
  }
  if (tries > 0) requestAnimationFrame(() => focusSummarySoon(tries - 1));
}

export const commands: AppCommand[] = [
  {
    id: "focus.next",
    title: t("commands.focus.next.title"),
    group: "Ansicht",
    shortcut: "F6",
    keywords: kw("commands.focus.next.keywords"),
    run: () => cycle(1),
  },
  {
    id: "focus.previous",
    title: t("commands.focus.previous.title"),
    group: "Ansicht",
    shortcut: "Shift+F6",
    keywords: kw("commands.focus.previous.keywords"),
    run: () => cycle(-1),
  },
  {
    id: "focus.leftPanel",
    title: t("commands.focus.leftPanel.title"),
    group: "Ansicht",
    shortcut: "Alt+1",
    keywords: kw("commands.focus.leftPanel.keywords"),
    when: hasRepo,
    run: (ctx) => {
      if (isLeftCollapsed(getTabView(ctx.tabId!), ctx.store)) ctx.store.setLeftCollapsed(ctx.tabId!, false);
      focusAreaSoon("left");
    },
  },
  {
    id: "focus.center",
    title: t("commands.focus.center.title"),
    group: "Ansicht",
    shortcut: "Alt+2",
    keywords: kw("commands.focus.center.keywords"),
    run: () => focusAreaSoon("center"),
  },
  {
    id: "focus.commitPanel",
    title: t("commands.focus.commitPanel.title"),
    group: "Ansicht",
    shortcut: "Alt+3",
    keywords: kw("commands.focus.commitPanel.keywords"),
    when: hasRepo,
    run: (ctx) => {
      if (getTabView(ctx.tabId!).rightCollapsed) ctx.store.setRightCollapsed(ctx.tabId!, false);
      focusAreaSoon("right");
    },
  },
  {
    id: "focus.commitMessage",
    title: t("commands.focus.commitMessage.title"),
    group: "Commit",
    shortcut: "Alt+M",
    keywords: kw("commands.focus.commitMessage.keywords"),
    when: hasRepo,
    disabledReason: () => t("commands.reason.repoTabOnly"),
    run: (ctx) => {
      // Bring the local changes to the front (WIP row, commit form), then into the field.
      ctx.store.selectWip(ctx.tabId!);
      ctx.store.setRightPanel(ctx.tabId!, "details");
      focusSummarySoon();
    },
  },
];
