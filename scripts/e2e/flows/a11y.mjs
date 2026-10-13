/**
 * Accessibility and keyboard checks in the real app (Tauri/WebView2), against real fixture
 * repositories and only against the local test servers (host-lib.mjs, host-mock.mjs).
 *
 *   node scripts/e2e/flows/a11y.mjs                    everything (about 20 minutes, one app instance at a time)
 *   node scripts/e2e/flows/a11y.mjs --only repo,zoom   only these parts: start, repo, werkzeuge, hoster, tastatur, zoom
 *   node scripts/e2e/flows/a11y.mjs --verbose          also print tab paths and intermediate states
 *   node scripts/e2e/flows/a11y.mjs --show             visible window
 *   node scripts/e2e/flows/a11y.mjs --no-shots         no evidence images in target/e2e/bugs/
 *
 * What runs here:
 *  1. axe-core (node_modules/axe-core/axe.min.js, loaded into the app page) on every screen and in
 *     every important state, dark and light. Rules: WCAG 2.0/2.1/2.2, levels A and AA.
 *     Parts start (repo-management–init, command-palette, settings with all sections, shortcuts, toasts, full-page messages),
 *     repo (shell–blame, rebase–terminal, remote-dialog, activity-log, submodules, network, dialogs, menus, minimum window),
 *     werkzeuge (conflict, conflict, detached HEAD, empty repository), hoster (pr-create, pr-view, hosts, issues).
 *  2. Our own contrast measurement (axe reports overlaid elements only as "incomplete"): text colour
 *     against the background actually behind it, input placeholders. Every colour is traced back to
 *     its token in design/tokens.json and the pair is checked against the verified list there.
 *  3. Part tastatur – keyboard only (page.keyboard): tab order, visible focus (screenshot comparison
 *     with and without focus when in doubt), focus trap and focus return of 20 dialogs, context
 *     menus via Shift+F10 and the Menu key versus right click, resizing panels and columns by
 *     keyboard, toasts (aria-live, F8, Esc, lifetime), form errors, terminal.
 *  4. Part zoom – largest zoom level, minimum window and both together (nothing clipped or
 *     overlapping), widest panels, prefers-reduced-motion, contrast mode (forced-colors).
 *
 * A section that shows a bug stays red and carries the bug's ID ("BUG L3-…", list in BUGS below):
 * it is the test the bug gets fixed against. At the end comes the list of green and red sections;
 * the raw findings of axe and the contrast measurement are in target/e2e/a11y-funde*.json.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { launchApp, ROOT } from "../driver.mjs";
import { makeCleanRepoWithRemote, makeConflictRepo, makeDetachedRepo, makeEmptyRepo, makeRichRepo } from "../fixtures.mjs";

process.env.GIT_OPTIONAL_LOCKS = "0";
const argv = process.argv.slice(2);
const show = argv.includes("--show");
const shots = !argv.includes("--no-shots");
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1].split(",") : null;
const BUG_SHOTS = "target/e2e/bugs";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// Test scaffold: sections, green/red, bug IDs
// ---------------------------------------------------------------------------------------------

/** { name, ok, bug, messages[] } per section. */
const sections = [];
let current = null;
const check = (condition, message) => {
  if (!condition) {
    current?.messages.push(message);
    console.log(`  ✗ ${message}`);
  }
  return Boolean(condition);
};
const equal = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const eventually = async (read, expected, message, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  let actual = await read();
  while (JSON.stringify(actual) !== JSON.stringify(expected) && Date.now() < deadline) {
    await sleep(60);
    actual = await read();
  }
  return equal(actual, expected, message);
};
/** Waits until `read()` returns something truthy; returns it (or the last value). */
const until = async (read, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!value && Date.now() < deadline) {
    await sleep(60);
    value = await read();
  }
  return value;
};
/**
 * The bugs reported by this script. A section that shows one of them is called
 * "BUG <ID> – …" in the result and stays red until the bug is fixed.
 */
const BUGS = {
  "L3-01": "S2 · From zoom 125 % dialogs stick out of the window: title, close button and action buttons are not visible",
  "L3-02": "S3 · Zoom 150 % in the minimum window: commit panel sticks out of the window, form lies over the file list, toolbar overlaps",
  "L3-03": "S3 · Zoom stops at 150 % – 200 % (WCAG 1.4.4) cannot be reached",
  "L3-04": "S3 · System contrast mode (forced-colors): switches do not show on/off, selection and chosen segments are invisible",
  "L3-05": "S3 · Terminal: output is invisible to screen readers (rows aria-hidden, no accessible buffer)",
  "L3-06": "S3 · Terminal captures Tab and Esc but never names the way out (F6) (WCAG 2.1.2)",
  "L3-07": "S3 · Esc in a toast: focus stays on the empty, invisible toast list, and later toasts no longer disappear on their own",
  "L3-08": "S3 · Toasts with an action button disappear after 5 s – hardly reachable by keyboard or screen reader (WCAG 2.2.1)",
  "L3-09": "S4 · The toast region is announced to screen readers with the untranslated default name \"Notifications (F8)\"",
  "L3-10": "S4 · Tab bar: role=tablist contains elements that are not tabs (axe aria-required-children, WCAG 1.3.1)",
  "L3-11": "S4 · Buttons inside role=option (axe nested-interactive, WCAG 4.1.2): favourite in repo-management, \"Resolve\" in commit-panel, rows in rebase",
  "L3-12": "S4 · Targets too small (axe target-size, WCAG 2.5.8): \"Pull: options\" 16 px wide, zoom buttons 20×20 px",
  "L3-13": "S4 · Icon button \"Pull: options\" shows no tooltip on keyboard focus (all other icon buttons do)",
  "L3-14": "S3 · Both panels at maximum width leave 320 px for the centre: in the diff, close, wrap, whitespace and \"Stage hunk\" are clipped",
};
/**
 * One section. `bug`: ID of the bug this section shows if it turns red – or set inside the
 * section with `blame(id)`. `after` always runs (cleanup), also after an abort.
 */
async function section(name, body, { bug = null, after = null } = {}) {
  current = { name, ok: true, bug, messages: [] };
  sections.push(current);
  try {
    await body();
  } catch (error) {
    check(false, `aborted: ${String(error?.message ?? error).split("\n").slice(0, 3).join(" | ")}`);
  }
  try {
    await after?.();
  } catch (error) {
    console.log(`  (cleanup after "${name}": ${String(error?.message ?? error).split("\n")[0]})`);
  }
  current.ok = current.messages.length === 0;
  if (!current.ok && current.bug) current.name = `BUG ${current.bug} – ${name}`;
  console.log(`${current.ok ? "✓" : "✗"} ${current.name}`);
  const done = current;
  current = null;
  return done.ok;
}
/** Assigns the running section to a reported bug. */
const blame = (id) => {
  if (current) current.bug = id;
};

// ---------------------------------------------------------------------------------------------
// Tokens: colours → names, verified pairs
// ---------------------------------------------------------------------------------------------

const TOKENS = JSON.parse(fs.readFileSync(path.join(ROOT, "design/tokens.json"), "utf8"));
/** "dark" → Map("#16181d" → ["bg"]) */
const TOKEN_NAMES = Object.fromEntries(
  ["dark", "light"].map((theme) => {
    const map = new Map();
    for (const [name, value] of Object.entries(TOKENS.color[theme])) map.set(value.toLowerCase(), [...(map.get(value.toLowerCase()) ?? []), name]);
    return [theme, map];
  }),
);
const PAIRS = new Set(TOKENS.pairs.map((pair) => `${pair[0]}|${pair[1]}`));
const tokenOf = (theme, hex) => TOKEN_NAMES[theme].get(hex.toLowerCase()) ?? null;
/** Is this colour pair in the verified list of tokens.json? */
function pairListed(theme, fgHex, bgHex) {
  const fg = tokenOf(theme, fgHex) ?? [];
  const bg = tokenOf(theme, bgHex) ?? [];
  return fg.some((a) => bg.some((b) => PAIRS.has(`${theme}-${a}|${theme}-${b}`)));
}
const nameColor = (theme, hex) => `${hex}${tokenOf(theme, hex) ? ` (${tokenOf(theme, hex).join("/")})` : " (no token – mixed or fixed)"}`;

// ---------------------------------------------------------------------------------------------
// Loaded into the page: axe and our own measurements
// ---------------------------------------------------------------------------------------------

const AXE_SOURCE = fs.readFileSync(path.join(ROOT, "node_modules/axe-core/axe.min.js"), "utf8");

/** Runs in the page: creates window.__l3. */
function installPageLib() {
  if (window.__l3) return;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const pen = canvas.getContext("2d", { willReadFrequently: true });
  const colorCache = new Map();
  /** Any CSS colour (also oklab, color-mix) → [r, g, b, a]. */
  const rgba = (css) => {
    if (colorCache.has(css)) return colorCache.get(css);
    const plain = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(css);
    let out;
    if (plain) out = [Number(plain[1]), Number(plain[2]), Number(plain[3]), plain[4] === undefined ? 1 : Number(plain[4])];
    else {
      pen.clearRect(0, 0, 1, 1);
      pen.fillStyle = "#000";
      pen.fillStyle = css;
      pen.fillRect(0, 0, 1, 1);
      const data = pen.getImageData(0, 0, 1, 1).data;
      out = [data[0], data[1], data[2], data[3] / 255];
    }
    colorCache.set(css, out);
    return out;
  };
  const over = (top, bottom) => {
    const alpha = top[3] + bottom[3] * (1 - top[3]);
    if (alpha <= 0) return [0, 0, 0, 0];
    return [0, 1, 2].map((i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / alpha).concat(alpha);
  };
  const luminance = (color) => {
    const channel = (value) => {
      const v = value / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2]);
  };
  const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const hex = (color) => `#${color.slice(0, 3).map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;

  const accName = (el) => {
    const labelled = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
    const label = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent : null;
    return (el.getAttribute("aria-label") || labelled || label || el.closest("label")?.textContent || el.getAttribute("placeholder") || el.textContent || el.getAttribute("title") || "").trim().replace(/\s+/g, " ");
  };
  const place = (el) => {
    const host = el.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-toast], [data-screen], [data-area], aside[aria-label], main[aria-label], [role="toolbar"], [role="tablist"], footer, nav[aria-label]');
    if (!host) return "page";
    const screen = host.getAttribute("data-screen") ?? el.closest("[data-screen]")?.getAttribute("data-screen");
    const label = host.getAttribute("aria-label") ?? host.getAttribute("data-area") ?? host.querySelector("h2")?.textContent ?? host.getAttribute("role") ?? host.tagName.toLowerCase();
    return `${screen ? `${screen} ` : ""}${label}`.trim().slice(0, 60);
  };
  const describe = (el) => {
    if (!el || el === document.body) return "<body>";
    const role = el.getAttribute("role");
    const marks = ["data-kind", "data-row-id", "data-entry", "data-side", "data-testid"].map((name) => (el.hasAttribute(name) ? `${name}=${String(el.getAttribute(name)).slice(0, 24)}` : null)).filter(Boolean).join(" ");
    return `${el.tagName.toLowerCase()}${role ? `[${role}]` : ""}${marks ? `{${marks}}` : ""} "${accName(el).slice(0, 60)}" in ${place(el)}`;
  };
  const cssPath = (el) => {
    const parts = [];
    for (let node = el; node && node !== document.body && parts.length < 4; node = node.parentElement) {
      const classes = [...node.classList].filter((name) => /^(text-|bg-|border-|opacity|font-)/.test(name)).slice(0, 4).join(".");
      parts.unshift(`${node.tagName.toLowerCase()}${node.getAttribute("role") ? `[role=${node.getAttribute("role")}]` : ""}${classes ? `.${classes}` : ""}`);
    }
    return parts.join(" > ");
  };

  /**
   * The text colour of `el` and the colour behind it as painted: backgrounds of all elements under
   * the point (siblings too), group opacity included.
   */
  const paint = (el, x, y, textColor) => {
    let stack = document.elementsFromPoint(x, y);
    const top = stack[0];
    if (top && top !== el && !el.contains(top) && !top.contains(el)) return null; // covered
    // If the element itself is not in the stack (pointer-events: none, e.g. while a menu is open),
    // its ancestors count.
    let start = stack.indexOf(el);
    if (start === -1) {
      stack = [];
      for (let node = el; node; node = node.parentElement) stack.push(node);
      start = 0;
    }
    let withText = textColor.slice();
    let without = [0, 0, 0, 0];
    let image = false;
    for (const node of stack.slice(start)) {
      const style = getComputedStyle(node);
      const layer = rgba(style.backgroundColor).slice();
      const inChain = node === el || node.contains(el);
      if (style.backgroundImage !== "none") image = true;
      if (!inChain) {
        let opacity = 1;
        for (let up = node; up; up = up.parentElement) opacity *= Number(getComputedStyle(up).opacity);
        layer[3] *= opacity;
      }
      withText = over(withText, layer);
      without = over(without, layer);
      if (inChain) {
        const opacity = Number(style.opacity);
        if (opacity < 1) {
          withText[3] *= opacity;
          without[3] *= opacity;
        }
      }
      if (without[3] >= 0.999) break;
    }
    const canvasColor = [255, 255, 255, 1];
    return { fg: over(withText, canvasColor), bg: over(without, canvasColor), image };
  };

  const visibleRect = (rect) => rect.width > 1 && rect.height > 1 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;

  /** All visible texts: contrast below the threshold. */
  const contrast = () => {
    const found = new Map();
    const seen = new Set();
    const add = (kind, el, colors, need, text) => {
      const value = ratio(colors.fg, colors.bg);
      if (value >= need - 0.005) return;
      const key = `${kind}|${hex(colors.fg)}|${hex(colors.bg)}|${need}`;
      const entry = found.get(key) ?? { kind, fg: hex(colors.fg), bg: hex(colors.bg), ratio: Math.round(value * 100) / 100, need, count: 0, image: colors.image, samples: [] };
      entry.count += 1;
      if (entry.samples.length < 4) entry.samples.push({ text: text.slice(0, 50), where: place(el), path: cssPath(el), disabled: Boolean(el.closest('[disabled], [aria-disabled="true"], [data-disabled]')) });
      found.set(key, entry);
    };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue.trim();
      const el = node.parentElement;
      if (!text || !el || seen.has(el)) continue;
      if (el.closest("script, style, noscript, .sr-only, [hidden]")) continue;
      const style = getComputedStyle(el);
      if (style.visibility !== "visible" || style.display === "none") continue;
      if (el.closest('[disabled], [aria-disabled="true"], [data-disabled]')) continue; // WCAG 1.4.3 exempts disabled elements
      // … and the label of a disabled field
      const label = el.closest("label");
      if (label) {
        const control = (label.htmlFor && document.getElementById(label.htmlFor)) || label.querySelector("input, button, select, textarea, [role]") || label.parentElement?.querySelector('input, [role="checkbox"], [role="switch"], [role="radio"]');
        if (control && control.matches('[disabled], [aria-disabled="true"], [data-disabled]')) continue;
      }
      const range = document.createRange();
      range.selectNodeContents(node);
      const rect = [...range.getClientRects()].find((item) => visibleRect(item));
      if (!rect) continue;
      const x = Math.min(innerWidth - 1, Math.max(0, rect.left + Math.min(rect.width / 2, 6)));
      const y = rect.top + rect.height / 2;
      const colors = paint(el, x, y, rgba(style.color));
      if (!colors) continue;
      seen.add(el);
      // "Large" text per WCAG: from 24 px, or from 18.66 px bold.
      const size = parseFloat(style.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      add("text", el, colors, large ? 3 : 4.5, text);
    }
    // Placeholders of empty input fields (axe does not check them)
    for (const field of document.querySelectorAll("input[placeholder], textarea[placeholder]")) {
      if (field.value || field.disabled || field.closest('[aria-hidden="true"]')) continue;
      const rect = field.getBoundingClientRect();
      if (!visibleRect(rect)) continue;
      const colors = paint(field, rect.left + Math.min(12, rect.width / 2), rect.top + rect.height / 2, rgba(getComputedStyle(field, "::placeholder").color));
      if (colors) add("placeholder", field, colors, 4.5, `placeholder "${field.getAttribute("placeholder")}"`);
    }
    return [...found.values()];
  };

  /** Borders of input fields against their surroundings (WCAG 1.4.11, 3:1). */
  const fieldBorders = () => {
    const found = new Map();
    for (const field of document.querySelectorAll('input:not([type="hidden"]), textarea, select, [role="combobox"], [role="checkbox"], [role="switch"]')) {
      if (field.disabled || field.closest('[aria-hidden="true"], [disabled], [aria-disabled="true"], [data-disabled], .sr-only')) continue;
      // The visible border often sits on the wrapping element (field with icon, Radix checkbox).
      let frame = field;
      for (let hops = 0; hops < 3 && frame; hops++) {
        const style = getComputedStyle(frame);
        if (parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== "none" && rgba(style.borderTopColor)[3] > 0) break;
        if (rgba(style.backgroundColor)[3] > 0.2 && hops > 0) break;
        frame = frame.parentElement;
      }
      if (!frame) continue;
      const rect = frame.getBoundingClientRect();
      if (!visibleRect(rect)) continue;
      const style = getComputedStyle(frame);
      const outside = frame.parentElement ? paint(frame.parentElement, Math.max(0, rect.left - 2), rect.top + rect.height / 2, [0, 0, 0, 0]) : null;
      if (!outside) continue;
      const border = parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== "none" ? over(rgba(style.borderTopColor), outside.bg) : null;
      const fill = over(rgba(style.backgroundColor), outside.bg);
      const best = Math.max(border ? ratio(border, outside.bg) : 1, ratio(fill, outside.bg));
      if (best >= 3 - 0.005) continue;
      const key = `${border ? hex(border) : "-"}|${hex(fill)}|${hex(outside.bg)}`;
      const entry = found.get(key) ?? { kind: "rahmen", border: border ? hex(border) : null, fill: hex(fill), around: hex(outside.bg), ratio: Math.round(best * 100) / 100, need: 3, count: 0, samples: [] };
      entry.count += 1;
      if (entry.samples.length < 4) entry.samples.push({ text: describe(field), where: place(field), path: cssPath(frame) });
      found.set(key, entry);
    }
    return [...found.values()];
  };

  const reactProps = (el) => {
    const key = Object.keys(el).find((name) => name.startsWith("__reactProps$"));
    return key ? el[key] : null;
  };
  const FOCUSABLE = 'button, a[href], input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable="true"]';
  const POINTER = ["onClick", "onDoubleClick", "onContextMenu", "onContextMenuCapture", "onMouseDown", "onPointerDown", "onPointerDownCapture", "onDragStart", "onDrop", "onMouseEnter", "onPointerEnter", "onPointerMove", "onMouseMove", "onWheel"];
  /** Elements with mouse handlers that are not focusable themselves – for review. */
  const pointerOnly = () => {
    const list = [];
    for (const el of document.querySelectorAll("body *")) {
      const props = reactProps(el);
      if (!props) continue;
      const handlers = POINTER.filter((name) => typeof props[name] === "function");
      if (!handlers.length && !el.draggable) continue;
      if (el.matches(FOCUSABLE)) continue;
      const rect = el.getBoundingClientRect();
      if (!visibleRect(rect) || el.closest('[aria-hidden="true"]')) continue;
      let keyUp = false;
      for (let node = el; node && !keyUp; node = node.parentElement) keyUp = typeof reactProps(node)?.onKeyDown === "function" || typeof reactProps(node)?.onKeyDownCapture === "function";
      list.push({
        el: describe(el),
        path: cssPath(el),
        handlers: handlers.concat(el.draggable ? ["draggable"] : []),
        focusableInside: el.querySelectorAll(FOCUSABLE).length,
        focusableAncestor: Boolean(el.parentElement?.closest(FOCUSABLE)),
        keyHandlerUp: keyUp,
        size: `${Math.round(rect.width)}×${Math.round(rect.height)}`,
      });
    }
    return list;
  };

  /** What is painted on the focused element (and its close surroundings) – to compare with/without focus. */
  const lookOf = (el) => {
    const parts = [];
    const take = (node, pseudo) => {
      const style = getComputedStyle(node, pseudo);
      if (pseudo && (style.content === "none" || style.content === "normal")) return;
      parts.push([style.outlineStyle !== "none" ? `${style.outlineWidth} ${style.outlineColor} ${style.outlineOffset}` : "-", style.boxShadow, style.borderTopColor, style.borderBottomColor, style.borderLeftColor, style.backgroundColor, style.color, style.textDecorationLine, style.opacity].join("~"));
    };
    let node = el;
    for (let hops = 0; hops < 4 && node && node !== document.body; hops++, node = node.parentElement) {
      take(node, null);
      take(node, "::before");
      take(node, "::after");
    }
    for (const child of [...el.children].slice(0, 6)) take(child, null);
    return parts.join("|");
  };
  const focusState = () => {
    const el = document.activeElement;
    if (!el || el === document.body) return { body: true, text: "<body>" };
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const inView = rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
    // The visible part: the rect, clipped by the window and by every ancestor that clips or scrolls.
    const seen = { left: Math.max(0, rect.left), top: Math.max(0, rect.top), right: Math.min(innerWidth, rect.right), bottom: Math.min(innerHeight, rect.bottom) };
    for (let up = el.parentElement; up && up !== document.body; up = up.parentElement) {
      const upStyle = getComputedStyle(up);
      if (!/(auto|scroll|hidden|clip)/.test(`${upStyle.overflowX}${upStyle.overflowY}`)) continue;
      const box = up.getBoundingClientRect();
      seen.left = Math.max(seen.left, box.left);
      seen.top = Math.max(seen.top, box.top);
      seen.right = Math.min(seen.right, box.right);
      seen.bottom = Math.min(seen.bottom, box.bottom);
    }
    const clipped = inView && (seen.right - seen.left < 2 || seen.bottom - seen.top < 2);
    const at = inView && !clipped ? document.elementFromPoint((seen.left + seen.right) / 2, (seen.top + seen.bottom) / 2) : null;
    const reachable = Boolean(at && (at === el || el.contains(at) || at.contains(el)));
    const ring = (target) => {
      const computed = getComputedStyle(target);
      return (computed.outlineStyle !== "none" && parseFloat(computed.outlineWidth) > 0) || (computed.boxShadow !== "none" && computed.boxShadow !== "");
    };
    const outline = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0 ? { color: hex(rgba(style.outlineColor)), width: parseFloat(style.outlineWidth) } : null;
    return {
      body: false,
      text: describe(el),
      role: el.getAttribute("role"),
      tag: el.tagName,
      name: accName(el).slice(0, 80),
      place: place(el),
      focusVisible: el.matches(":focus-visible"),
      ring: ring(el) || Boolean(el.closest("label, [data-field]") && ring(el.closest("label, [data-field]"))),
      outline,
      inView,
      reachable,
      clipped,
      editable: el.matches("input, textarea, [contenteditable=true], .cm-content"),
      look: lookOf(el),
      rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
      id: (el.__l3id ??= Math.random().toString(36).slice(2)),
    };
  };
  /** Look at the same element again after focus has moved on. */
  const lookById = (id) => {
    for (const el of document.querySelectorAll("*")) if (el.__l3id === id) return lookOf(el);
    return null;
  };

  /** Clipped and overflowing elements (for zoom and minimum window). */
  const layout = () => {
    const problems = [];
    const root = document.documentElement;
    const zoom = Number.parseFloat(getComputedStyle(root).zoom || "1") || 1;
    if (root.scrollWidth > root.clientWidth + 1) problems.push({ kind: "seite-waagerecht", text: `page ${root.scrollWidth} > ${root.clientWidth}` });
    if (root.scrollHeight > root.clientHeight + 1) problems.push({ kind: "seite-senkrecht", text: `page ${root.scrollHeight} > ${root.clientHeight}` });
    const scrolls = (el) => {
      for (let up = el; up && up !== document.body; up = up.parentElement) {
        const style = getComputedStyle(up);
        if (/(auto|scroll)/.test(`${style.overflowX}${style.overflowY}`)) return true;
      }
      return false;
    };
    for (const el of document.querySelectorAll('button, a[href], input, select, textarea, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="checkbox"], [role="switch"], [role="radio"], h1, h2, h3, label')) {
      if (el.closest('[aria-hidden="true"], .sr-only')) continue;
      const style = getComputedStyle(el);
      if (style.visibility !== "visible" || style.display === "none") continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) continue;
      // sticks out of the window and is not inside a scrolling area
      if ((rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1 || rect.left < -1 || rect.top < -1) && !scrolls(el)) {
        problems.push({ kind: "ausserhalb", text: describe(el), rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.right), Math.round(rect.bottom)], window: [innerWidth, innerHeight] });
        continue;
      }
      // clipped by a non-scrolling ancestor
      for (let up = el.parentElement; up && up !== document.body; up = up.parentElement) {
        const upStyle = getComputedStyle(up);
        const hidesX = /(hidden|clip)/.test(upStyle.overflowX);
        const hidesY = /(hidden|clip)/.test(upStyle.overflowY);
        if (!hidesX && !hidesY) {
          if (/(auto|scroll)/.test(`${upStyle.overflowX}${upStyle.overflowY}`)) break;
          continue;
        }
        const box = up.getBoundingClientRect();
        const cutX = hidesX && (rect.right > box.right + 2 || rect.left < box.left - 2);
        const cutY = hidesY && (rect.bottom > box.bottom + 2 || rect.top < box.top - 2);
        if (cutX || cutY) {
          problems.push({ kind: "abgeschnitten", text: describe(el), by: cssPath(up), rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.right), Math.round(rect.bottom)], box: [Math.round(box.left), Math.round(box.top), Math.round(box.right), Math.round(box.bottom)] });
          break;
        }
        if (/(auto|scroll)/.test(`${upStyle.overflowX}${upStyle.overflowY}`)) break;
      }
      // button label clipped without an ellipsis
      if (el.matches("button, [role=button], [role=tab], label") && el.scrollWidth > el.clientWidth + 2 && !/ellipsis/.test(style.textOverflow) && ![...el.querySelectorAll("*")].some((child) => /ellipsis/.test(getComputedStyle(child).textOverflow))) {
        if (/(hidden|clip)/.test(style.overflowX)) problems.push({ kind: "text-abgeschnitten", text: describe(el), widths: [el.scrollWidth, el.clientWidth] });
      }
    }
    // Overlapping controls (same layer, not related)
    const controls = [...document.querySelectorAll('button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], [role="checkbox"], [role="switch"]')].filter((el) => {
      if (el.closest('[aria-hidden="true"], .sr-only')) return false;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 2 && rect.height > 2 && style.visibility === "visible" && style.pointerEvents !== "none" && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight;
    });
    for (let i = 0; i < controls.length && problems.length < 80; i++) {
      const a = controls[i];
      const ra = a.getBoundingClientRect();
      const at = document.elementFromPoint(Math.min(innerWidth - 1, ra.left + ra.width / 2), Math.min(innerHeight - 1, ra.top + ra.height / 2));
      if (!at || at === a || a.contains(at) || at.contains(a)) continue;
      // Centre covered: by another control?
      const other = at.closest('button, a[href], input, select, textarea, [role="button"], [role="tab"]');
      if (other && other !== a && !other.contains(a) && !a.contains(other)) problems.push({ kind: "verdeckt", text: describe(a), by: describe(other) });
    }
    return { zoom, window: [innerWidth, innerHeight], problems };
  };

  window.__l3 = { contrast, fieldBorders, pointerOnly, focusState, lookById, layout, describe, accName, hex, rgba, ratio };
}

async function ensureLibs(page) {
  if (!(await page.evaluate(() => Boolean(window.axe)))) await page.evaluate(AXE_SOURCE);
  await page.evaluate(installPageLib);
}

// ---------------------------------------------------------------------------------------------
// Scans
// ---------------------------------------------------------------------------------------------

/** All raw findings: { screen, theme, kind: "axe" | "kontrast" | "rahmen", … } – written as JSON at the end. */
const findings = [];
const pointerNotes = [];
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/**
 * Where an axe finding belongs:
 *  - `bug`: to a reported bug (that bug's section at the end turns red),
 *  - `ok`: not a bug – with the reason and the section that checks it by hand,
 *  - otherwise "NEW": the scan section turns red.
 */
const AXE_RULES = [
  { rule: "aria-required-children", match: /role="tablist"/, bug: "L3-10" },
  { rule: "nested-interactive", bug: "L3-11" },
  { rule: "target-size", match: /Pull: [Oo]ptions|Zoom out|Zoom in/, bug: "L3-12" },
  // Radix menu open: the rest of the app is aria-hidden and locked for the keyboard, focus is in the menu (sections "Context menu …").
  { rule: "aria-hidden-focus", match: /id="root"|data-radix-focus-guard/, ok: "focus is in the open menu/dialog, the rest is locked" },
  // CodeMirror and the palette list scroll with the keyboard – checked in the section "Scrollable areas".
  { rule: "scrollable-region-focusable", match: /cm-scroller|max-h-palette-list/, ok: "scrolls by keyboard (section \"Scrollable areas\")" },
  // axe compares the whole visible text with the name; the section "Visible label is part of the name" checks the main word.
  { rule: "label-content-name-mismatch", ok: "main label is part of the name (own section)" },
];
const classifyAxe = (rule, node) => AXE_RULES.find((entry) => entry.rule === rule && (!entry.match || entry.match.test(`${node.target} ${node.html} ${node.where}`))) ?? null;
/** Scan hits per reported bug: ID → Map(element → Set(screens)). */
const scanHits = new Map();
const hit = (bug, what, screen) => {
  const byElement = scanHits.get(bug) ?? new Map();
  const screens = byElement.get(what) ?? new Set();
  screens.add(screen);
  byElement.set(what, screens);
  scanHits.set(bug, byElement);
};
const normalize = (text) => text.replace(/[0-9a-f]{7,40}/g, "#").replace(/\d+/g, "N").slice(0, 110);

async function axeRun(page, { include = null } = {}) {
  return page.evaluate(
    async ([tags, scope]) => {
      const context = scope ? { include: [scope] } : document;
      const result = await window.axe.run(context, { resultTypes: ["violations", "incomplete"], runOnly: { type: "tag", values: tags.concat("best-practice") }, rules: { "target-size": { enabled: true } } });
      const slim = (list) =>
        list.map((violation) => ({
          rule: violation.id,
          impact: violation.impact,
          wcag: violation.tags.filter((tag) => /^wcag\d{3,}/.test(tag)).join(","),
          bestPractice: violation.tags.includes("best-practice"),
          help: violation.help,
          nodes: violation.nodes.map((node) => ({
            target: node.target.join(" "),
            html: node.html.replace(/\s+/g, " ").slice(0, 260),
            summary: (node.failureSummary ?? "").replace(/\s+/g, " ").slice(0, 260),
            data: [...node.any, ...node.all, ...node.none].map((item) => item.data).filter(Boolean)[0] ?? null,
            where: (() => {
              try {
                const el = document.querySelector(node.target[node.target.length - 1]);
                return el ? window.__l3.describe(el) : "";
              } catch {
                return "";
              }
            })(),
          })),
        }));
      return { violations: slim(result.violations), incomplete: slim(result.incomplete) };
    },
    [AXE_TAGS, include],
  );
}

/**
 * Scans the current state in both themes: axe, contrast, borders. Creates one section per theme;
 * it turns red only through findings that are not assigned to a reported bug.
 * `scope`: CSS selector axe is limited to (otherwise the whole document).
 */
async function scan(app, screen, { themes = ["dark", "light"], scope = null, pointer = true } = {}) {
  const { page } = app;
  for (const theme of themes) {
    await section(`axe + contrast: ${screen} [${theme}]`, async () => {
      await app.setTheme(theme);
      await page.waitForTimeout(220);
      await ensureLibs(page);
      const result = await axeRun(page, { include: scope });
      const fresh = new Set();
      for (const violation of result.violations) {
        for (const node of violation.nodes) {
          const verdict = violation.bestPractice ? { ok: "recommendation (best-practice), not a WCAG criterion" } : classifyAxe(violation.rule, node);
          findings.push({ screen, theme, kind: "axe", rule: violation.rule, impact: violation.impact, wcag: violation.wcag, bestPractice: violation.bestPractice, bug: verdict?.bug ?? null, ok: verdict?.ok ?? null, target: node.target, where: node.where, html: node.html, summary: node.summary, data: node.data });
          if (verdict?.bug) hit(verdict.bug, `${violation.rule}: ${normalize(node.where || node.target)}${node.data?.width ? ` (${node.data.width}×${node.data.height} px)` : ""}`, screen);
          else if (!verdict) fresh.add(`axe ${violation.rule} (${violation.impact}, ${violation.wcag}): ${node.where || node.target} – ${node.summary.slice(0, 160)}`);
        }
      }
      for (const violation of result.incomplete) for (const node of violation.nodes) findings.push({ screen, theme, kind: "axe-unklar", rule: violation.rule, impact: violation.impact, wcag: violation.wcag, target: node.target, where: node.where, html: node.html, summary: node.summary, data: node.data });
      // Own contrast measurement: also covers what axe reports only as "incomplete" because of overlays.
      const contrast = await page.evaluate(() => window.__l3.contrast());
      for (const item of contrast) {
        const listed = pairListed(theme, item.fg, item.bg);
        findings.push({ screen, theme, ...item, what: item.kind, kind: "kontrast", fgToken: tokenOf(theme, item.fg), bgToken: tokenOf(theme, item.bg), pairListed: listed });
        fresh.add(`contrast ${item.ratio}:1 (needs ${item.need}:1), ${item.kind}: ${nameColor(theme, item.fg)} on ${nameColor(theme, item.bg)}${listed ? " – the pair is listed as verified in tokens.json!" : " – the pair is not in tokens.json"}; ${item.count}× e.g. "${item.samples[0].text}" in ${item.samples[0].where} [${item.samples[0].path}]`);
      }
      // Input field borders (WCAG 1.4.11): report only, no red section – the fields are recognisable by fill and label.
      for (const item of await page.evaluate(() => window.__l3.fieldBorders())) findings.push({ screen, theme, kind: "rahmen", ...item });
      for (const line of fresh) check(false, line);
    });
  }
  if (pointer) {
    await ensureLibs(page);
    for (const item of await page.evaluate(() => window.__l3.pointerOnly())) pointerNotes.push({ screen, ...item });
  }
  await app.setTheme("dark");
  await page.waitForTimeout(80);
}

// ---------------------------------------------------------------------------------------------
// Keyboard helpers (page.keyboard only)
// ---------------------------------------------------------------------------------------------

const focusState = async (page) => {
  await page.evaluate(installPageLib);
  return page.evaluate(() => window.__l3.focusState());
};
/**
 * Image of the focused element with and without focus: if they do not differ in a single pixel,
 * focus is not visible. (Focus is briefly removed for this and then restored.)
 */
async function focusIsPainted(page) {
  const clip = await page.evaluate(() => {
    const rect = document.activeElement.getBoundingClientRect();
    const left = Math.max(0, rect.left - 6);
    const top = Math.max(0, rect.top - 6);
    return { x: left, y: top, width: Math.min(innerWidth, rect.right + 6) - left, height: Math.min(innerHeight, rect.bottom + 6) - top };
  });
  if (clip.width < 2 || clip.height < 2) return false;
  const withFocus = await page.screenshot({ clip, animations: "disabled", caret: "hide" });
  await page.evaluate(() => {
    window.__l3blurred = document.activeElement;
    window.__l3blurred.blur();
  });
  await page.waitForTimeout(100);
  const without = await page.screenshot({ clip, animations: "disabled", caret: "hide" });
  await page.evaluate(() => window.__l3blurred?.focus());
  await page.waitForTimeout(60);
  return !withFocus.equals(without);
}

/**
 * Tabs once through everything reachable (until a stop repeats) and records per stop:
 * not <body>, inside the window, not covered – and whether focus is VISIBLE: if nothing measurable
 * changes on the element or its close surroundings when focus moves on, a screenshot comparison
 * with and without focus decides.
 */
async function tabWalk(page, { max = 150, key = "Tab" } = {}) {
  const stops = [];
  let previous = null;
  const back = key === "Tab" ? "Shift+Tab" : "Tab";
  for (let step = 0; step < max; step++) {
    await page.keyboard.press(key);
    await page.waitForTimeout(35);
    let state = await focusState(page);
    if (previous && !previous.body && !state.body && state.id === previous.id) {
      // The only tab stop around: focus does not move on, so the outline itself counts.
      previous.indicator = Boolean(previous.outline) || previous.ring;
    } else if (previous && !previous.body) {
      const after = await page.evaluate((id) => window.__l3.lookById(id), previous.id);
      previous.indicator = after === null ? null : after !== previous.look;
      if (previous.indicator === false && !previous.editable && !state.body) {
        // Nothing measurable: go back to the stop and compare pixels.
        await page.keyboard.press(back);
        await page.waitForTimeout(60);
        if ((await focusState(page)).id === previous.id) previous.indicator = await focusIsPainted(page);
        await page.keyboard.press(key);
        await page.waitForTimeout(60);
        state = await focusState(page);
      }
    }
    if (!state.body && stops.some((stop) => stop.id === state.id)) break; // cycle closed
    stops.push(state);
    previous = state;
  }
  return stops;
}
const walkText = (stops) => stops.map((stop, index) => `${index + 1}. ${stop.text}`).join("\n      ");

// ---------------------------------------------------------------------------------------------
// App and cleanup
// ---------------------------------------------------------------------------------------------

const cleanups = [];
const apps = new Set();
async function start(options = {}) {
  let lastError = null;
  // The machine is under load: a start that fails on the time limit is retried once.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const app = await launchApp({ show, width: 1440, height: 900, theme: "dark", timeoutMs: 120_000, ...options });
      apps.add(app);
      return app;
    } catch (error) {
      lastError = error;
      console.log(`  (start failed, attempt ${attempt + 1}: ${String(error?.message ?? error).split("\n")[0]})`);
      await sleep(3000);
    }
  }
  throw lastError;
}
async function stop(app) {
  if (!app) return;
  apps.delete(app);
  await app.close().catch(() => undefined);
}
const bugShot = async (app, id) => {
  if (!shots) return;
  await app.screenshot(`${BUG_SHOTS}/${id}.png`).catch(() => undefined);
};
const store = (page, fn, arg) => page.evaluate(([source, value]) => new Function("state", "arg", `return (${source})(state, arg)`)(window.__gc.store.getState(), value), [fn.toString(), arg]);
const openOverlay = (page, overlay) => page.evaluate((value) => window.__gc.store.getState().openOverlay(value), overlay);
const closeOverlay = (page) => page.evaluate(() => window.__gc.store.getState().closeOverlay());
const setCenter = (page, tabId, center) => page.evaluate(([id, value]) => window.__gc.store.getState().setCenter(id, value), [tabId, center]);
/** Starts an app command without waiting for it to finish (a command with a dialog only ends with the dialog). Returns whether it was available. */
const runCommand = (page, id) =>
  page.evaluate((command) => {
    const known = window.__gcUi.commands().find((item) => item.id === command);
    if (!known?.available) return false;
    void window.__gcUi.runCommand(command);
    return true;
  }, id);
const dialogCount = (page) => page.locator('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]').count();
/** Raises an app toast (the same function every action uses). `action`: label of an action button. */
const raiseToast = (page, tone, title, { action = null, ...extra } = {}) =>
  page.evaluate(
    async ([kind, text, more, label]) => {
      window.__l3ToastActions = window.__l3ToastActions ?? [];
      const feedback = await import("/src/ui/Feedback.tsx");
      return feedback.toast({ tone: kind, title: text, ...more, ...(label ? { action: { label, onClick: () => window.__l3ToastActions.push(text) } } : {}) });
    },
    [tone, title, extra, action],
  );
const clearToasts = (page) =>
  page.evaluate(async () => {
    const feedback = await import("/src/ui/Feedback.tsx");
    feedback.dismissTransientToasts();
    for (const button of document.querySelectorAll('[data-toast] button[aria-label="Close message"]')) button.click();
  });
/** Esc until no dialog and no menu is open any more. */
async function escapeAll(page) {
  for (let round = 0; round < 6; round++) {
    const open = await page.locator('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"], [role="listbox"][data-state="open"]').count();
    if (!open) break;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(180);
  }
  await closeOverlay(page).catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------------------------

const parts = {};

/** Part "start": without a repository – repo-management, clone, init, preferences (all sections), toasts, full-page errors. */
parts.start = async () => {
  const app = await start();
  const { page } = app;
  const rich = makeRichRepo({ dirty: false });
  const clean = makeCleanRepoWithRemote();
  cleanups.push(rich.cleanup, clean.cleanup);
  try {
    await scan(app, "repo-management Repository management, empty");

    // repo-management filled: two repositories known, one selected (README preview)
    const first = await app.openRepo(rich.path);
    const second = await app.openRepo(clean.path);
    await app.invoke("tab_close", { tabId: second.tabId }).catch(() => undefined);
    await app.invoke("tab_close", { tabId: first.tabId }).catch(() => undefined);
    await app.reload();
    await app.settle();
    await page.waitForTimeout(400);
    await scan(app, "repo-management Repository management, filled");

    await openOverlay(page, { kind: "clone" });
    await page.locator('[data-screen="clone"]').waitFor();
    await scan(app, "clone Clone dialog, empty");
    // Error state: invalid URL
    await page.locator('[data-screen="clone"] input').first().fill("not a valid location");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    await scan(app, "clone Clone dialog, invalid URL");
    await closeOverlay(page);
    await page.waitForTimeout(250);

    await openOverlay(page, { kind: "init" });
    await page.locator('[data-screen="init"]').waitFor();
    await scan(app, "init Init dialog");
    await closeOverlay(page);
    await page.waitForTimeout(250);

    // Preferences: select every section via the tabs
    await openOverlay(page, { kind: "preferences", section: "general" });
    await page.locator('[data-screen="settings"]').waitFor();
    const tabs = await page.locator('[data-screen="settings"] [role="tab"]').allInnerTexts();
    for (const name of tabs) {
      await page.locator('[data-screen="settings"]').getByRole("tab", { name, exact: true }).click();
      await app.settle();
      await page.waitForTimeout(350);
      await scan(app, `settings Preferences › ${name}`);
    }
    await closeOverlay(page);
    await page.waitForTimeout(250);

    await openOverlay(page, { kind: "shortcuts" });
    await page.locator('[data-screen="shortcuts"]').waitFor();
    await scan(app, "shortcuts Keyboard shortcuts");
    await closeOverlay(page);
    await page.waitForTimeout(250);

    await openOverlay(page, { kind: "palette", mode: "all" });
    await page.locator('[data-screen="command-palette"]').waitFor();
    await scan(app, "command-palette Command palette without repository");
    await page.keyboard.type("zzzqqq");
    await page.waitForTimeout(300);
    await scan(app, "command-palette Command palette, no results", { themes: ["dark"] });
    await closeOverlay(page);
    await page.waitForTimeout(250);

    // Toasts in all four tones
    for (const tone of ["info", "success", "warning", "danger"]) await raiseToast(page, tone, `Sample toast ${tone}`, { description: "With a second line of explanation.", ...(tone === "danger" ? { action: "Show output" } : {}), sticky: true });
    await page.waitForTimeout(400);
    await scan(app, "Toasts in all tones");
    await clearToasts(page);
  } finally {
    await stop(app);
  }

  // Full-page error: Git missing
  const broken = await start({ gitPath: path.join(ROOT, "target", "e2e", "gibt-es-nicht", "git.exe"), waitForShell: false });
  try {
    const state = await broken.waitForShell().catch(() => null);
    await broken.page.waitForTimeout(600);
    await scan(broken, `Full-page message "Git missing" (shell: ${state})`);
    await section("Keyboard \"Git missing\": the buttons of the full-page message are reachable by Tab and visibly focused", async () => {
      const stops = await tabWalk(broken.page, { max: 30 });
      note(`stops: ${stops.map((item) => item.name || item.tag).join(" · ")}`);
      check(stops.filter((item) => !item.body).length >= 1, `there are tab stops (${stops.length})`);
      for (const problem of judgeStops(stops)) check(false, problem.text);
    });
  } finally {
    await stop(broken);
  }

  // Confirmation before a repository with hooks (trust question)
  const hooked = makeCleanRepoWithRemote({ name: "mit-hook" });
  cleanups.push(hooked.cleanup);
  fs.writeFileSync(path.join(hooked.path, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho geprueft\n");
  const careful = await start({ trustOpened: false });
  try {
    await careful.invoke("repo_open", { path: hooked.path });
    await careful.page.locator('[data-shell="untrusted"]').waitFor({ timeout: 15_000 });
    await careful.page.waitForTimeout(400);
    await scan(careful, "shell Confirmation \"Trust this repository?\"");
    await section("Keyboard trust question: all buttons reachable by Tab, focus visible", async () => {
      const stops = await tabWalk(careful.page, { max: 60 });
      const inside = stops.filter((item) => !item.body && /Repository confirmation|Found/.test(item.place));
      note(`stops in the confirmation: ${inside.map((item) => item.name || item.tag).join(" · ")}`);
      check(inside.length >= 2, `the confirmation has at least two tab stops (${inside.length})`);
      for (const problem of judgeStops(stops)) check(false, problem.text);
    });
  } finally {
    await stop(careful);
  }
};

/** One state: set up, scan, reset – a failure while setting up becomes a red section. */
async function state(app, screen, enter, { leave = null, scanOptions = {} } = {}) {
  const { page } = app;
  let ready = false;
  try {
    await enter();
    await app.settle().catch(() => undefined);
    await page.waitForTimeout(300);
    ready = true;
  } catch (error) {
    await section(`set up state: ${screen}`, async () => check(false, `not reached: ${String(error?.message ?? error).split("\n")[0]}`));
  }
  if (ready) await scan(app, screen, scanOptions);
  try {
    if (leave) await leave();
    else await escapeAll(page);
  } catch {
    // the next state cleans up itself
  }
  await page.waitForTimeout(150);
}

/** Part "repo": rich repository – shell to blame, stash-form to terminal, remote-dialog, activity-log, submodules, dialogs and menus. */
parts.repo = async () => {
  const app = await start();
  const { page } = app;
  const kb = page.keyboard;
  const rich = makeRichRepo();
  cleanups.push(rich.cleanup);
  try {
    const { repoId, tabId } = await app.openRepo(rich.path);
    await page.waitForTimeout(600);
    const head = rich.git("rev-parse", "HEAD");
    const parent = rich.git("rev-parse", "HEAD~1");
    const merge = rich.git("rev-list", "--merges", "-1", "HEAD");
    const status = await app.invoke("status_get", { repoId });
    const unstagedText = status.unstaged.find((file) => /\.(py|md|csv|txt)$/.test(file.path) && file.status === "modified") ?? status.unstaged[0];
    const tracked = rich.git("ls-files").split(/\r?\n/).find((file) => /\.py$/.test(file));
    const toCenter = (center) => setCenter(page, tabId, center);
    const graph = () => toCenter({ kind: "graph" });

    await state(app, "shell/sidebar/commit-graph/commit-panel repo view with local changes", async () => undefined);
    await state(app, "commit-details Commit details (one commit)", () => store(page, (s, [tab, sha]) => s.selectCommits(tab, [sha]), [tabId, head]));
    await state(app, "commit-details Commit details (merge commit)", () => store(page, (s, [tab, sha]) => s.selectCommits(tab, [sha]), [tabId, merge]));
    await state(app, "commit-details Comparing two commits", () => store(page, (s, [tab, shas]) => s.selectCommits(tab, shas), [tabId, [head, parent]]));
    await state(app, "commit-details Stash details", () => store(page, (s, tab) => s.selectStash(tab, 0), tabId));
    await state(app, "stash-form Stash form", async () => {
      await store(page, (s, tab) => s.selectWip(tab), tabId);
      await store(page, (s, tab) => s.openStashForm(tab), tabId);
    }, { leave: () => store(page, (s, tab) => s.setRightPanel(tab, "details"), tabId) });
    await state(app, "commit-search Commit search with results", async () => {
      await store(page, (s, tab) => s.setSearchOpen(tab, true), tabId);
      await page.locator('[data-screen="commit-search"] input').first().fill("Messwerte");
      await page.waitForTimeout(700);
    }, { leave: () => store(page, (s, tab) => s.setSearchOpen(tab, false), tabId) });
    await state(app, "commit-search Commit search without results", async () => {
      await store(page, (s, tab) => s.setSearchOpen(tab, true), tabId);
      await page.locator('[data-screen="commit-search"] input').first().fill("gibtesnichtxyz");
      await page.waitForTimeout(700);
    }, { leave: () => store(page, (s, tab) => s.setSearchOpen(tab, false), tabId), scanOptions: { themes: ["dark"] } });

    // Centre: diff in three views, file, editor, history, blame
    for (const mode of ["hunks", "inline", "split"]) {
      await state(app, `diff Diff (${mode})`, async () => {
        await app.invoke("settings_set", { patch: { diffMode: mode } }).catch(() => undefined);
        await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "settings"] }));
        await store(page, (s, tab) => s.selectWip(tab), tabId);
        await store(page, (s, [tab, file]) => s.openDiff(tab, file, { kind: "unstaged" }), [tabId, unstagedText.path]);
        await page.locator('[data-screen="diff"]').waitFor();
      }, { leave: graph });
    }
    await state(app, "diff Diff of a commit", async () => {
      const file = rich.git("show", "--name-only", "--format=", head).split(/\r?\n/).filter(Boolean)[0];
      await store(page, (s, [tab, sha]) => s.selectCommits(tab, [sha]), [tabId, head]);
      await store(page, (s, [tab, path, sha]) => s.openDiff(tab, path, { kind: "commit", sha }), [tabId, file, head]);
      await page.locator('[data-screen="diff"]').waitFor();
    }, { leave: graph });
    // Special diffs: image (alt texts), binary file, deleted and renamed file
    for (const [what, file, source] of [
      ["image, modified", "docs/station.png", { kind: "unstaged" }],
      ["image, new", "docs/standort.png", { kind: "unstaged" }],
      ["binary file", "daten/kalibrierung.bin", { kind: "unstaged" }],
      ["deleted file", "docs/alt-konzept.md", { kind: "unstaged" }],
      ["renamed file", "docs/stationsaufbau.md", { kind: "staged" }],
    ]) {
      await state(app, `diff Diff (${what})`, async () => {
        await store(page, (s, tab) => s.selectWip(tab), tabId);
        await store(page, (s, [tab, path, src]) => s.openDiff(tab, path, src), [tabId, file, source]);
        await page.locator('[data-screen="diff"]').waitFor();
      }, { leave: graph, scanOptions: { themes: ["dark"] } });
    }
    await state(app, "file-view File view (read only)", async () => {
      await store(page, (s, [tab, file]) => s.openFile(tab, file, null, "view"), [tabId, tracked]);
      await page.locator('[data-screen="file-view"]').waitFor();
    }, { leave: graph });
    await state(app, "file-view Editor (editing)", async () => {
      await store(page, (s, [tab, file]) => s.openFile(tab, file, null, "edit"), [tabId, tracked]);
      await page.locator('[data-screen="file-view"][data-mode="edit"]').waitFor();
    }, { leave: graph });
    await state(app, "file-view Markdown preview", async () => {
      await store(page, (s, tab) => s.openFile(tab, "README.md", null, "view"), tabId);
      await page.locator('[data-screen="file-view"]').waitFor();
    }, { leave: graph });
    await state(app, "file-history File History", async () => {
      await store(page, (s, [tab, file]) => s.openHistory(tab, file), [tabId, tracked]);
      await page.locator('[data-screen="file-history"]').waitFor();
    }, { leave: graph });
    await state(app, "blame Blame", async () => {
      await store(page, (s, [tab, file]) => s.openBlame(tab, file, null), [tabId, tracked]);
      await page.locator('[data-screen="blame"]').waitFor();
    }, { leave: graph });
    await state(app, "rebase Interactive Rebase", async () => {
      await store(page, (s, [tab, base]) => s.openRebase(tab, base, "interactive", []), [tabId, rich.git("rev-parse", "HEAD~3")]);
      await page.locator('[data-screen="rebase"]').waitFor();
    }, { leave: graph });
    await state(app, "rebase Squash", async () => {
      await store(page, (s, [tab, shas]) => s.openRebase(tab, "", "squash", shas), [tabId, [head, parent]]);
      await page.locator('[data-screen="rebase"]').waitFor();
    }, { leave: graph });
    await state(app, "rebase Cherry-Pick", async () => {
      const other = rich.git("rev-parse", "feature/luftdruck");
      await store(page, (s, [tab, shas]) => s.openRebase(tab, "HEAD", "cherry_pick", shas), [tabId, [other]]);
      await page.locator('[data-screen="rebase"]').waitFor();
    }, { leave: graph });
    await state(app, "terminal Terminal", async () => {
      await store(page, (s, tab) => s.selectWip(tab), tabId);
      await store(page, (s, tab) => s.toggleTerminal(tab), tabId);
      await page.locator('[data-screen="terminal"]').waitFor();
      await page.waitForTimeout(2500);
    }, { leave: () => store(page, (s, tab) => s.toggleTerminal(tab), tabId) });

    // Overlays
    for (const [screen, overlay, marker] of [
      ["command-palette Command palette (repository open)", { kind: "palette", mode: "all" }, '[data-screen="command-palette"]'],
      ["command-palette Command palette (branches)", { kind: "palette", mode: "branches" }, '[data-screen="command-palette"]'],
      ["activity-log Activity Log", { kind: "activity" }, '[data-screen="activity-log"]'],
      ["remote-dialog Add remote dialog", { kind: "add_remote" }, '[data-screen="remote-dialog"]'],
      ["submodules Add submodule dialog", { kind: "add_submodule" }, '[data-screen="submodules"]'],
      ["submodules Git LFS", { kind: "lfs" }, '[data-screen="lfs"]'],
      ["settings Preferences › This repository", { kind: "preferences", section: "repo" }, '[data-screen="settings"]'],
    ]) {
      await state(app, screen, async () => {
        await openOverlay(page, overlay);
        await page.locator(marker).waitFor();
      });
    }
    // Dialogs via commands
    for (const [screen, command] of [
      ["Dialog \"New branch\"", "branch.create"],
      ["Dialog \"Create tag\"", "tag.createAnnotated"],
      ["network Gitflow dialog", "gitflow.open"],
      ["network Create patch", "patch.create.wip"],
      ["network Apply patch", "patch.apply"],
      ["submodules Add worktree", "worktree.add"],
      ["Confirmation \"Discard all changes\"", "wip.discardAll"],
    ]) {
      await state(app, screen, async () => {
        await store(page, (s, tab) => s.selectWip(tab), tabId);
        const ran = await runCommand(page, command);
        if (ran === false) throw new Error(`command ${command} is not available`);
        if (!(await until(async () => (await dialogCount(page)) > 0, 6000))) throw new Error(`command ${command} opens no dialog`);
      });
    }

    // Menus – all opened by keyboard
    await state(app, "Context menu of a commit (graph)", async () => {
      await store(page, (s, [tab, sha]) => s.selectCommits(tab, [sha]), [tabId, parent]);
      await kb.press("Alt+2");
      await page.waitForTimeout(200);
      await kb.press("Shift+F10");
      await page.locator('[role="menu"]').first().waitFor({ timeout: 5000 });
    });
    await state(app, "Context menu of a branch (sidebar)", async () => {
      await kb.press("Alt+1");
      await page.waitForTimeout(200);
      await kb.press("Shift+F10");
      await page.locator('[role="menu"]').first().waitFor({ timeout: 5000 });
    });
    await state(app, "Context menu of a file (commit panel)", async () => {
      await store(page, (s, tab) => s.selectWip(tab), tabId);
      await kb.press("Alt+3");
      await page.waitForTimeout(200);
      for (let step = 0; step < 14 && !(await page.evaluate(() => document.activeElement?.getAttribute("role") === "option")); step++) await kb.press("Tab");
      await kb.press("Shift+F10");
      await page.locator('[role="menu"]').first().waitFor({ timeout: 5000 });
    });
    await state(app, "Pull menu of the toolbar", async () => {
      await page.getByRole("button", { name: /Pull: ([Oo]ptions|[Mm]ode)/ }).first().focus();
      await kb.press("Enter");
      await page.locator('[role="menu"]').first().waitFor({ timeout: 5000 });
    });
    await state(app, "Column menu of the graph", async () => {
      await kb.press("Alt+2");
      await page.waitForTimeout(200);
      for (let step = 0; step < 5 && !(await page.evaluate(() => document.activeElement?.getAttribute("role") === "columnheader")); step++) await kb.press("Shift+Tab");
      await kb.press("Shift+F10");
      await page.locator('[role="menu"]').first().waitFor({ timeout: 5000 });
    });
    await state(app, "Context menu of a tab", async () => {
      await page.locator('[role="tablist"][aria-label="Open repositories"] [role="tab"][aria-selected="true"]').focus();
      await kb.press("Shift+F10");
      await page.locator('[role="menu"]').first().waitFor({ timeout: 5000 });
    });

    // Minimum window
    await app.setSize(960, 600);
    await page.waitForTimeout(500);
    await state(app, "shell in the minimum window 960×600", async () => store(page, (s, tab) => s.selectWip(tab), tabId), { leave: async () => undefined });
    await app.setSize(1440, 900);
    await page.waitForTimeout(400);
  } finally {
    await stop(app);
  }
};

/** Part "werkzeuge" (tools): conflict tool (conflict), conflict in the commit panel, detached HEAD, empty repository. */
parts.werkzeuge = async () => {
  const app = await start();
  const { page } = app;
  const conflict = makeConflictRepo();
  const detached = makeDetachedRepo();
  const empty = makeEmptyRepo();
  cleanups.push(conflict.cleanup, detached.cleanup, empty.cleanup);
  try {
    const opened = await app.openRepo(conflict.path);
    await page.waitForTimeout(600);
    await state(app, "commit-panel Commit panel with conflicts (merge in progress)", async () => store(page, (s, tab) => s.selectWip(tab), opened.tabId), { leave: async () => undefined });
    await state(app, "conflict Conflict tool (unresolved)", async () => {
      await store(page, (s, tab) => s.openConflict(tab, "src/auswertung.py"), opened.tabId);
      await page.locator('[data-screen="conflict"]').waitFor();
      await page.waitForTimeout(800);
    }, { leave: async () => undefined });
    await state(app, "conflict Conflict tool (partly resolved)", async () => {
      const boxes = page.locator('[data-screen="conflict"] [role="checkbox"]');
      if ((await boxes.count()) > 0) await boxes.first().click();
      await page.waitForTimeout(400);
    }, {
      leave: async () => {
        await setCenter(page, opened.tabId, { kind: "graph" });
        await page.waitForTimeout(300);
        // unsaved resolution: confirm the question if it comes up
        if ((await dialogCount(page)) > 0) {
          await page.getByRole("button", { name: /Discard|Close|Don’t save/ }).first().click().catch(() => undefined);
        }
      },
    });

    const second = await app.openRepo(detached.path);
    await page.waitForTimeout(600);
    await state(app, "commit-graph/commit-panel Detached HEAD", async () => store(page, (s, tab) => s.selectWip(tab), second.tabId), { leave: async () => undefined });

    const third = await app.openRepo(empty.path);
    await page.waitForTimeout(600);
    await state(app, "commit-graph empty repository without commits", async () => store(page, (s, tab) => s.selectWip(tab), third.tabId), { leave: async () => undefined });
  } finally {
    await stop(app);
  }
};

const verbose = argv.includes("--verbose");
const note = (text) => {
  if (verbose) console.log(`    · ${text}`);
};

/** Run a command via the command palette – keyboard only (Ctrl+P, ">title", Enter). */
async function paletteCommand(page, title, commandId) {
  await page.keyboard.press("Control+p");
  await page.locator('[data-screen="command-palette"] input[role="combobox"]').waitFor({ timeout: 10_000 });
  await page.keyboard.type(`>${title}`, { delay: 4 });
  const keys = () => page.locator('[data-screen="command-palette"] [role="option"]').evaluateAll((rows) => rows.map((row) => row.dataset.key));
  if (!(await until(async () => (await keys()).includes(`command:${commandId}`), 8000))) throw new Error(`the palette does not find "${title}" (${commandId}): ${JSON.stringify(await keys())}`);
  const index = (await keys()).indexOf(`command:${commandId}`);
  for (let step = 0; step < index; step++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.locator('[data-screen="command-palette"]').waitFor({ state: "detached", timeout: 10_000 });
}

/** Checks the stops of a tab walk: never <body>, always visible, focus visible. Returns the list of problems. */
function judgeStops(stops, { inside = null } = {}) {
  const problems = [];
  for (const [index, stop] of stops.entries()) {
    const where = `stop ${index + 1} ${stop.text}`;
    if (stop.body) {
      problems.push({ kind: "body", text: `${where}: focus is on <body>` });
      continue;
    }
    if (!stop.inView) problems.push({ kind: "ausserhalb", stop, text: `${where}: lies outside the window ${JSON.stringify(stop.rect)}` });
    else if (stop.clipped) problems.push({ kind: "abgeschnitten", stop, text: `${where}: lies in the clipped part of an area ${JSON.stringify(stop.rect)}` });
    else if (!stop.reachable) problems.push({ kind: "verdeckt", stop, text: `${where}: is covered ${JSON.stringify(stop.rect)}` });
    if (stop.indicator === false && !stop.editable) problems.push({ kind: "unsichtbar", stop, text: `${where}: nothing changes visibly when focus arrives or leaves` });
    if (!stop.focusVisible) problems.push({ kind: "kein-focus-visible", stop, text: `${where}: :focus-visible does not apply` });
    if (inside && !stop.place.includes(inside)) problems.push({ kind: "falle", stop, text: `${where}: lies outside "${inside}"` });
  }
  return problems;
}

/** Part "tastatur" (keyboard): everything by hand with the keyboard – order, visible focus, traps, menus, handles, toasts. */
parts.tastatur = async () => {
  const app = await start();
  const { page } = app;
  const kb = page.keyboard;
  const rich = makeRichRepo();
  cleanups.push(rich.cleanup);
  try {
    // ---- repo-management ------------------------------------------------------------------------------
    await section("Keyboard repo-management: tab walk – every stop visible, no stop on <body>", async () => {
      const stops = await tabWalk(page);
      note(`repo-management: ${stops.length} stops\n      ${walkText(stops)}`);
      check(stops.length >= 4, `repo-management has tab stops (${stops.length})`);
      for (const problem of judgeStops(stops)) check(false, problem.text);
    });

    const { repoId, tabId } = await app.openRepo(rich.path);
    await page.waitForTimeout(700);

    // ---- shell ------------------------------------------------------------------------------
    let s04Stops = [];
    await section("Keyboard shell: tab walk through the repo view – every stop visible, no stop on <body>", async () => {
      await kb.press("Alt+2");
      await page.waitForTimeout(200);
      s04Stops = await tabWalk(page, { max: 120 });
      note(`shell: ${s04Stops.length} stops\n      ${walkText(s04Stops)}`);
      for (const problem of judgeStops(s04Stops)) check(false, problem.text);
    });
    await section("Keyboard shell: order of the areas is the reading order (tabs → toolbar → sidebar → view → commit panel → status bar)", async () => {
      const areaOf = (stop) =>
        /Open repositories/.test(stop.place) || /^(New tab|All tabs)$/.test(stop.name) ? "tabs" : /Repository actions/.test(stop.place) ? "toolbar" : /Sidebar|sidebarScreen/.test(stop.place) ? "left" : /commitGraphScreen|commitSearchScreen|View/.test(stop.place) ? "center" : /commitPanelScreen|commitDetailsScreen|stashFormScreen|Commit panel|Local changes/.test(stop.place) ? "right" : /footer/.test(stop.place) ? "status" : /^(Sidebar|Commit panel) width$/.test(stop.name) ? "griff" : `?${stop.place}`;
      const order = [];
      for (const stop of s04Stops) {
        const area = stop.body ? "body" : areaOf(stop);
        if (order.at(-1) !== area) order.push(area);
      }
      note(`areas in tab order: ${order.join(" → ")}`);
      const unknown = order.filter((area) => area.startsWith("?"));
      check(unknown.length === 0, `stops outside the known areas: ${unknown.join(", ")}`);
      // Every area gets exactly one turn (no jumping back and forth).
      const core = order.filter((area) => !["griff", "body"].includes(area) && !area.startsWith("?"));
      // The walk starts in the middle of the cycle (in the view) – rotate to "tabs" as the start for comparison.
      const startAt = core.indexOf("tabs");
      const rotated = startAt >= 0 ? core.slice(startAt).concat(core.slice(0, startAt)) : core;
      const merged = rotated.filter((area, index) => area !== rotated[index - 1] && !(index === rotated.length - 1 && area === rotated[0]));
      equal(merged, ["tabs", "toolbar", "left", "center", "right", "status"], "areas in tab order");
    });

    // ---- Dialogs: focus in, trap, Esc, focus back -------------------------------------------------
    const commands = await page.evaluate(() => window.__gcUi.commands());
    const titleOf = (id) => commands.find((command) => command.id === id)?.title ?? null;
    const dialogs = [
      { name: "Preferences (Ctrl+,)", open: () => kb.press("Control+,") },
      { name: "Keyboard shortcuts (Ctrl+/)", open: () => kb.press("Control+/") },
      { name: "New branch (Ctrl+B)", open: () => kb.press("Control+b") },
      ...["repo.clone", "repo.init", "app.activity", "remote.add", "submodule.add", "lfs.manage", "gitflow.open", "patch.create.wip", "patch.apply", "worktree.add", "tag.create", "tag.createAnnotated", "hosts.connect", "ai.settings", "wip.discardAll"].map((id) => ({
        name: `${titleOf(id) ?? id} (Palette)`,
        id,
        open: () => paletteCommand(page, titleOf(id), id),
      })),
    ];
    for (const dialog of dialogs) {
      await section(`Keyboard dialog "${dialog.name}": focus in, trap holds, Esc closes, focus returns`, async () => {
        await store(page, (s, tab) => s.selectWip(tab), tabId);
        await kb.press("Alt+2");
        await page.waitForTimeout(250);
        const before = await focusState(page);
        check(!before.body, "before opening, focus is on an element");
        if (dialog.id && !commands.find((command) => command.id === dialog.id)?.available) {
          note(`${dialog.id} is not available here – skipped`);
          return;
        }
        await dialog.open();
        if (!(await until(async () => (await dialogCount(page)) > 0, 6000))) {
          const now = await focusState(page);
          note(`${dialog.name}: no dialog; focus: ${now.text}`);
          check(false, `no dialog appeared (focus: ${now.text})`);
          return;
        }
        await page.waitForTimeout(450);
        const title = await page.evaluate(() => {
          const open = [...document.querySelectorAll('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]')].at(-1);
          const labelled = open?.getAttribute("aria-labelledby");
          return { name: open?.getAttribute("aria-label") ?? (labelled ? document.getElementById(labelled)?.textContent : null) ?? null, role: open?.getAttribute("role"), modal: open?.getAttribute("aria-modal"), describedby: open?.getAttribute("aria-describedby") };
        });
        check(Boolean(title.name), `the dialog has an accessible name (${JSON.stringify(title)})`);
        const first = await focusState(page);
        note(`${dialog.name}: name "${title.name}", role ${title.role}; initial focus ${first.text}`);
        check(!first.body && /dialog|S\d\d/.test(first.place) || (await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"], [role="alertdialog"]')))), `focus is in the dialog (${first.text})`);
        const stops = await tabWalk(page, { max: 70 });
        note(`${stops.length} stops: ${stops.map((stop) => stop.name || stop.tag).join(" · ").slice(0, 600)}`);
        const outside = await page.evaluate(() => !document.activeElement?.closest('[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"]'));
        check(!outside, "after the tab walk, focus is still in the dialog");
        for (const problem of judgeStops(stops)) check(false, problem.text);
        const escaped = await page.evaluate((ids) => ids.filter((id) => ![...document.querySelectorAll('[role="dialog"] *, [role="alertdialog"] *')].some((el) => el.__l3id === id)).length, stops.filter((stop) => !stop.body).map((stop) => stop.id));
        check(escaped === 0, `${escaped} tab stops lie outside the dialog (trap does not hold)`);
        // Shift+Tab from the first stop stays inside as well
        await kb.press("Shift+Tab");
        await kb.press("Shift+Tab");
        check(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"], [role="alertdialog"]'))), "Shift+Tab stays in the dialog");
        for (let round = 0; round < 3 && (await dialogCount(page)) > 0; round++) {
          await kb.press("Escape");
          await page.waitForTimeout(350);
        }
        // A "discard unsaved?" question or similar – one more Esc is not always enough
        equal(await dialogCount(page), 0, "Esc closes the dialog");
        await page.waitForTimeout(300);
        const after = await focusState(page);
        check(!after.body, `after closing, focus is not on <body>`);
        check(after.id === before.id, `focus returns to the element from before (before: ${before.text}; after: ${after.text})`);
        check(after.body || after.focusVisible, "… and is visible");
      }, { after: () => escapeAll(page) });
    }

    // ---- Context menus: right click and Shift+F10 / Menu key show the same ------------------------
    const head = rich.git("rev-parse", "HEAD");
    const wip = async () => {
      await store(page, (s, tab) => s.selectWip(tab), tabId);
      await setCenter(page, tabId, { kind: "graph" });
    };
    const menuTargets = [
      ["tab in the tab bar", null, () => page.locator('[role="tablist"][aria-label="Open repositories"] [role="tab"]').first()],
      ...["folder", "branch", "remote", "remote_branch", "tag", "stash", "worktree"].map((kind) => [`sidebar, row "${kind}"`, null, () => page.locator(`[data-screen="sidebar"] [role="treeitem"][data-kind="${kind}"]`).first()]),
      ["sidebar, section header", null, () => page.locator('[data-screen="sidebar"] button[aria-expanded]').first()],
      ["graph, row \"Local changes\"", wip, () => page.locator('[data-screen="commit-graph"] [role="row"][data-row-id="wip"]')],
      ["graph, commit row", null, () => page.locator(`[data-screen="commit-graph"] [role="row"][data-row-id="${head}"]`)],
      ["graph, column header", null, () => page.locator('[data-screen="commit-graph"] [role="columnheader"]').first()],
      ["commit panel, unstaged file", wip, () => page.locator('[role="listbox"][aria-label="Unstaged files"] [role="option"]').first()],
      ["commit panel, staged file", wip, () => page.locator('[role="listbox"][aria-label="Staged files"] [role="option"]').first()],
      ["commit details, file of a commit", () => store(page, (s, [tab, sha]) => s.selectCommits(tab, [sha]), [tabId, head]), () => page.locator('[data-screen="commit-details"] [role="option"]').first()],
    ];
    for (const [name, prepare, locate] of menuTargets) {
      await section(`Context menu "${name}": Shift+F10 and the Menu key open the same menu as right click; Esc returns focus`, async () => {
        if (prepare) await prepare();
        await app.settle();
        await page.waitForTimeout(250);
        const target = locate();
        if (!(await target.count())) return check(false, "the element does not exist in this repository");
        const mouse = await menuByMouse(page, target);
        await escapeAll(page);
        if (prepare) await prepare();
        await page.waitForTimeout(150);
        await locate().focus();
        const byKey = await menuByKey(page, "Shift+F10");
        await escapeAll(page);
        if (prepare) await prepare();
        await locate().focus();
        const byMenuKey = await menuByKey(page, "ContextMenu");
        note(`${name}: mouse ${mouse?.length ?? "–"}, Shift+F10 ${byKey.items?.length ?? "–"}, Menu key ${byMenuKey.items?.length ?? "–"}`);
        check(Boolean(mouse?.length), "right click opens a menu");
        equal(byKey.items, mouse, "Shift+F10 shows the same entries as right click");
        equal(byMenuKey.items, mouse, "the Menu key shows the same entries");
        check(byKey.inMenu === true, "focus is in the menu");
        check(Boolean(byKey.back) && !byKey.back.body && byKey.back.id === byKey.origin.id, `Esc returns focus to the element (now: ${byKey.back?.text})`);
      }, { after: () => escapeAll(page) });
    }
    await wip();

    // ---- Panel size by keyboard -----------------------------------------------------------------
    for (const [label, panel] of [["Sidebar width", '[data-area="left"]'], ["Commit panel width", '[data-area="right"]']]) {
      await section(`Handle "${label}": reachable by Tab, arrow keys, Home and End change the width; aria-valuenow is correct`, async () => {
        const grip = page.locator(`[role="separator"][aria-label="${label}"]`);
        check(s04Stops.some((item) => item.name === label), "the handle is a tab stop");
        await grip.focus();
        const width = () => page.locator(panel).evaluate((el) => Math.round(el.getBoundingClientRect().width));
        const now = async () => Number(await grip.getAttribute("aria-valuenow"));
        const start = await now();
        equal(await width(), start, "aria-valuenow is the panel width");
        const grows = label.includes("Sidebar") ? "ArrowRight" : "ArrowLeft";
        await kb.press(grows);
        await eventually(now, start + 8, `${grows} makes the panel 8 px wider`);
        equal(await width(), start + 8, "the panel really is wider");
        await kb.press(`Shift+${grows}`);
        await eventually(now, start + 40, `Shift+${grows}: large step`);
        await kb.press("Home");
        await eventually(now, Number(await grip.getAttribute("aria-valuemin")), "Home: smallest width");
        await kb.press("End");
        await eventually(now, Number(await grip.getAttribute("aria-valuemax")), "End: largest width");
        check(await focusIsPainted(page), "focus on the handle is visible (screenshot comparison)");
        // back to the initial width – keys only
        await kb.press("Home");
        const shrink = grows === "ArrowRight" ? "ArrowLeft" : "ArrowRight";
        for (let step = 0; step < 80 && (await now()) < start; step++) await kb.press(grows);
        for (let step = 0; step < 80 && (await now()) > start; step++) await kb.press(shrink);
        equal(await now(), start, "back at the initial width");
      });
    }
    await section("Graph columns: width (Shift+←/→), order (Ctrl+←/→) and reset work without a mouse", async () => {
      await wip();
      await page.locator('[data-screen="commit-graph"] [role="row"][data-row-id="wip"]').waitFor();
      await kb.press("Alt+2");
      await page.waitForTimeout(200);
      for (let step = 0; step < 5 && !(await page.evaluate(() => document.activeElement?.getAttribute("role") === "columnheader")); step++) await kb.press("Shift+Tab");
      const header = page.locator('[data-screen="commit-graph"] [role="columnheader"]');
      const columns = () => header.evaluateAll((list) => list.map((el) => ({ name: el.textContent.trim(), width: Math.round(el.getBoundingClientRect().width) })));
      const before = await columns();
      note(`columns: ${JSON.stringify(before)}`);
      equal((await focusState(page)).role, "columnheader", "Shift+Tab from the graph reaches the header row");
      const focused = (await focusState(page)).name;
      await kb.press("Shift+ArrowRight");
      await kb.press("Shift+ArrowRight");
      await page.waitForTimeout(200);
      const wider = await columns();
      check(wider.find((column) => column.name === focused)?.width === before.find((column) => column.name === focused).width + 16, `Shift+→ twice makes "${focused}" 16 px wider (${JSON.stringify(wider)})`);
      // to the "Author" column and move it to the right
      for (let step = 0; step < 6 && (await focusState(page)).name !== "Author"; step++) {
        await kb.press("ArrowRight");
        await page.waitForTimeout(90);
      }
      equal((await focusState(page)).name, "Author", "arrow keys change the column");
      await kb.press("Control+ArrowRight");
      await page.waitForTimeout(200);
      const moved = (await columns()).map((column) => column.name);
      check(moved.indexOf("Author") > moved.indexOf("Date"), `Ctrl+→ moves "Author" after "Date" (${moved.join(", ")})`);
      equal((await focusState(page)).name, "Author", "focus stays on the moved column");
      // reset via the menu
      await kb.press("Shift+F10");
      await page.locator('[role="menu"]').first().waitFor({ timeout: 4000 });
      // After opening, focus is on the menu itself; ↓ goes to the entries.
      const onReset = () => page.evaluate(() => (document.activeElement?.getAttribute("role") ?? "").startsWith("menuitem") && /Reset all columns/.test(document.activeElement.textContent ?? ""));
      for (let step = 0; step < 12 && !(await onReset()); step++) {
        await kb.press("ArrowDown");
        await page.waitForTimeout(40);
      }
      check(await onReset(), "↓ reaches \"Reset all columns\"");
      await kb.press("Enter");
      await page.waitForTimeout(300);
      equal(await columns(), before, "\"Reset all columns\" restores widths and order");
    }, { after: () => escapeAll(page) });

    // ---- Toasts ---------------------------------------------------------------------------------
    /** Restart the toast timer (pointer in and out) – needed after BUG L3-07 has paused it. */
    const wakeToasts = async () => {
      await raiseToast(page, "info", "Cleanup", { sticky: true });
      const box = await page.locator("[data-toast]").first().boundingBox().catch(() => null);
      if (box) await page.mouse.move(box.x + 20, box.y + 10);
      await page.mouse.move(10, 300);
      await clearToasts(page);
    };
    // BUG L3-08 – this section is red until the bug is fixed.
    await section("A toast with an action button stays until it is closed (here: \"… deleted\" with \"Undo\" after \"Delete file\")", async () => {
      // Keyboard only: file in the centre, palette "Delete file …", confirm the question.
      // The mouse pointer is far away from the toast (over it, it would pause the timer).
      await page.mouse.move(10, 300);
      await store(page, (s, tab) => s.openFile(tab, "notizen/offene-fragen.md", null, "view"), tabId);
      await page.locator('[data-screen="file-view"]').waitFor();
      await app.settle();
      await kb.press("Alt+2");
      await paletteCommand(page, "Delete file", "file.delete");
      if (!(await until(async () => (await dialogCount(page)) > 0, 6000))) return check(false, "the confirmation before deleting does not appear");
      for (let step = 0; step < 6 && (await focusState(page)).name !== "Delete"; step++) await kb.press("Tab");
      await kb.press("Enter");
      const toast = page.locator("[data-toast]").filter({ has: page.getByRole("button", { name: "Undo" }) });
      await toast.waitFor({ timeout: 10_000 });
      const shownAt = Date.now();
      note(`toast: ${(await toast.innerText()).replace(/\s+/g, " ")}`);
      check(!fs.existsSync(path.join(rich.path, "notizen", "offene-fragen.md")), "the file is deleted");
      // Someone who cannot see the toast must first hear it, then press F8, Tab, Tab, Enter.
      await page.waitForTimeout(8000);
      const still = await toast.count();
      if (!check(still === 1, `8 s after appearing, the toast with its "Undo" button is ${still ? "still there" : "gone"} – it disappears on its own after about 5 s (measured from ${Date.now() - shownAt} ms back); errors stay, toasts with an action do not`)) await bugShot(app, "L3-08");
    }, { bug: "L3-08", after: async () => { await clearToasts(page); await escapeAll(page); await wip(); } });

    await section("Toasts: announced via a live region (errors assertive, otherwise polite)", async () => {
      await kb.press("Alt+2");
      const live = async () => page.evaluate(() => [...document.querySelectorAll("[aria-live]")].filter((el) => /Sample (error|success)/.test(el.textContent)).map((el) => `${el.getAttribute("role")}/${el.getAttribute("aria-live")}`));
      await raiseToast(page, "danger", "Sample error", { description: "The remote is not reachable." });
      await page.waitForTimeout(120);
      equal(await live(), ["status/assertive"], "an error is announced immediately");
      await clearToasts(page);
      await page.waitForTimeout(1200);
      await raiseToast(page, "success", "Sample success");
      await page.waitForTimeout(120);
      equal(await live(), ["status/polite"], "a success toast is announced politely");
      await clearToasts(page);
    });
    await section("Toasts: F8 jumps in, Tab reaches the action and \"Close message\"; closing returns focus", async () => {
      await kb.press("Alt+2");
      const before = await focusState(page);
      await raiseToast(page, "danger", "Push rejected", { description: "The remote has newer commits.", action: "Pull first" });
      await page.waitForTimeout(300);
      await kb.press("F8");
      const names = [];
      for (let step = 0; step < 3; step++) {
        await kb.press("Tab");
        const state = await focusState(page);
        names.push(state.name);
        check(state.focusVisible && (state.ring || state.outline), `focus is visible on "${state.name.slice(0, 40)}"`);
      }
      check(names[1] === "Pull first" && names[2] === "Close message", `Tab reaches the action and the close button (${names.map((name) => name.slice(0, 30)).join(" → ")})`);
      await kb.press("Enter");
      await eventually(() => page.locator("[data-toast]").count(), 0, "Enter on \"Close message\" closes it");
      await page.waitForTimeout(250);
      const after = await focusState(page);
      check(after.id === before.id, `focus is back where it was before F8 (${after.text})`);
    }, { after: () => clearToasts(page) });
    // BUG L3-07 – this section is red until the bug is fixed.
    await section("Esc in a toast closes it and returns focus to where it was before", async () => {
      await wip();
      await kb.press("Alt+2");
      await page.waitForTimeout(200);
      const before = await focusState(page);
      await raiseToast(page, "danger", "Fetch failed", { description: "origin is not reachable." });
      await page.waitForTimeout(300);
      await kb.press("F8");
      await kb.press("Tab");
      check(/Fetch failed/.test((await focusState(page)).name), "focus is in the toast");
      await kb.press("Escape");
      await eventually(() => page.locator("[data-toast]").count(), 0, "Esc closes the toast");
      await page.waitForTimeout(400);
      const after = await focusState(page);
      note(`focus after Esc: ${after.text}, rect ${JSON.stringify(after.rect)}`);
      if (!check(after.id === before.id, `after Esc, focus is back on "${before.name.slice(0, 40)}" – it is on ${after.text}, size ${after.rect?.[2]}×${after.rect?.[3]} px`)) await bugShot(app, "L3-07");
      check(!after.body && after.rect[2] > 0 && after.rect[3] > 0, "focus is on a visible element");
      await kb.press("ArrowDown");
      await page.waitForTimeout(150);
      // Below the "Local changes" row there is a stash in this repository: the arrow key works in the graph
      // if the selection moved from "wip" to the next graph row (stash or commit).
      const moved = (await store(page, (s, tab) => s.views[tab]?.selection?.kind, tabId)) ?? null;
      check(moved === "commits" || moved === "stash", `the next arrow key works in the graph again (selection: ${moved})`);
      // Consequence: the toast timer stays paused – even after focus has moved elsewhere.
      await kb.press("Alt+2");
      await page.waitForTimeout(200);
      await raiseToast(page, "success", "Afterwards: commit created");
      const later = page.locator("[data-toast]").filter({ hasText: "Afterwards: commit created" });
      await later.waitFor();
      const gone = await later.waitFor({ state: "detached", timeout: 9000 }).then(() => true, () => false);
      check(gone, "a later success toast disappears after about 5 s as usual – it is still there after 9 s (since the Esc no toast disappears on its own until the pointer has been over the toasts once)");
    }, { bug: "L3-07", after: async () => { await clearToasts(page); await wakeToasts(); await wip(); } });
    // BUG L3-09 – this section is red until the bug is fixed.
    await section("The toast region has a translated name", async () => {
      await raiseToast(page, "info", "Just for display", { sticky: true });
      await page.waitForTimeout(200);
      const label = await page.evaluate(() => document.querySelector("[data-toast]")?.closest('[role="region"]')?.getAttribute("aria-label") ?? null);
      check(label !== null && /Notifications/.test(label) && !/\{hotkey\}/.test(label), `aria-label of the region is "${label}" – expected "Notifications (F8)"`);
    }, { bug: "L3-09", after: () => clearToasts(page) });
    // ---- Form errors ----------------------------------------------------------------------------
    for (const [name, open, fill] of [
      ["New branch (name taken)", () => kb.press("Control+b"), async () => { await kb.type("main"); await kb.press("Enter"); }],
      ["Clone repository (no address)", () => paletteCommand(page, titleOf("repo.clone"), "repo.clone"), async () => { await kb.type("no location"); await kb.press("Enter"); }],
      ["Add remote (name taken)", () => paletteCommand(page, titleOf("remote.add"), "remote.add"), async () => { await kb.type("origin"); await kb.press("Tab"); await kb.type("nowhere"); await kb.press("Enter"); }],
      ["Add worktree (empty)", () => paletteCommand(page, titleOf("worktree.add"), "worktree.add"), async () => { await kb.press("Enter"); }],
    ]) {
      await section(`Form error "${name}": field is aria-invalid, the error text is attached to the field (aria-describedby) and announced (role=alert)`, async () => {
        await kb.press("Alt+2");
        await open();
        if (!(await until(async () => (await dialogCount(page)) > 0, 6000))) return check(false, "no dialog");
        await page.waitForTimeout(350);
        await fill();
        await page.waitForTimeout(700);
        const info = await page.evaluate(() => {
          const dialog = [...document.querySelectorAll('[role="dialog"][data-state="open"]')].at(-1);
          const invalid = [...(dialog?.querySelectorAll('[aria-invalid="true"]') ?? [])].map((el) => {
            const ids = `${el.getAttribute("aria-describedby") ?? ""} ${el.getAttribute("aria-errormessage") ?? ""}`.split(/\s+/).filter(Boolean);
            return { field: window.__l3.accName(el).slice(0, 40), texts: ids.map((id) => document.getElementById(id)?.textContent?.trim() ?? "").filter(Boolean) };
          });
          return { open: Boolean(dialog), invalid, alerts: [...(dialog?.querySelectorAll('[role="alert"]') ?? [])].map((el) => el.textContent.trim()), inDialog: Boolean(document.activeElement?.closest('[role="dialog"]')) };
        });
        note(JSON.stringify(info));
        check(info.open, "the dialog stays open");
        check(info.invalid.length >= 1, "at least one field is marked invalid");
        for (const field of info.invalid) check(field.texts.length >= 1, `"${field.field}" names its error via aria-describedby`);
        check(info.alerts.length >= 1, "the error is in a role=alert");
        check(info.inDialog, "focus stays in the dialog");
      }, { after: () => escapeAll(page) });
    }

    // ---- Scrollable areas (axe: scrollable-region-focusable) --------------------------------------
    await section("Scrollable areas: file view, blame and the palette list can be scrolled with the keyboard", async () => {
      // a long file so there is something to scroll
      fs.writeFileSync(path.join(rich.path, "notizen", "lang.txt"), Array.from({ length: 400 }, (_, index) => `line ${index + 1}: reading ${index * 7}`).join("\n"));
      for (const [name, enter, marker] of [
        ["file-view File view", () => store(page, (s, tab) => s.openFile(tab, "notizen/lang.txt", null, "view"), tabId), '[data-screen="file-view"] .cm-scroller'],
        ["blame Blame", () => store(page, (s, tab) => s.openBlame(tab, "daten/messwerte-2026-01.csv", null), tabId), '[data-screen="blame"] .cm-scroller'],
      ]) {
        await enter();
        await page.locator(marker).first().waitFor({ timeout: 15_000 });
        await app.settle();
        await page.waitForTimeout(600);
        await kb.press("Alt+2");
        await page.waitForTimeout(200);
        const scroller = page.locator(marker).first();
        const room = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight);
        if (room < 40) {
          note(`${name}: fits entirely in the area (${room} px) – nothing to scroll`);
          continue;
        }
        await kb.press("PageDown");
        await kb.press("PageDown");
        await page.waitForTimeout(250);
        check((await scroller.evaluate((el) => el.scrollTop)) > 0, `${name}: PgDn scrolls (Alt+2 puts focus on ${(await focusState(page)).text})`);
      }
      await setCenter(page, tabId, { kind: "graph" });
      await kb.press("Control+p");
      await page.locator('[data-screen="command-palette"] [role="option"]').first().waitFor();
      const list = page.locator('[data-screen="command-palette"] [data-scroll="true"]');
      for (let step = 0; step < 25; step++) await kb.press("ArrowDown");
      await page.waitForTimeout(200);
      check((await list.evaluate((el) => el.scrollTop)) > 0, "command-palette: ↓ scrolls the list along with the selection");
      const active = await page.evaluate(() => {
        const input = document.querySelector('[data-screen="command-palette"] input[role="combobox"]');
        const option = document.getElementById(input?.getAttribute("aria-activedescendant") ?? "");
        const list = document.querySelector('[data-screen="command-palette"] [data-scroll="true"]');
        if (!option || !list) return null;
        const a = option.getBoundingClientRect();
        const b = list.getBoundingClientRect();
        // At least four fifths of the row are in the visible part (4 px are missing at the bottom – the list padding).
        return (Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)) / a.height;
      });
      check(active !== null && active >= 0.8, `command-palette: the selected row (aria-activedescendant) is in the visible part of the list (visible share ${active === null ? "–" : Math.round(active * 100)} %)`);
    }, { after: async () => { await escapeAll(page); await setCenter(page, tabId, { kind: "graph" }); } });

    // ---- Centre views: Alt+2 and tab walk --------------------------------------------------------
    for (const [name, enter, marker] of [
      ["diff Diff", () => store(page, (s, tab) => s.openDiff(tab, "src/auswertung.py", { kind: "unstaged" }), tabId), '[data-screen="diff"]'],
      ["file-view File view", () => store(page, (s, tab) => s.openFile(tab, "src/auswertung.py", null, "view"), tabId), '[data-screen="file-view"]'],
      ["file-history File History", () => store(page, (s, tab) => s.openHistory(tab, "src/auswertung.py"), tabId), '[data-screen="file-history"]'],
      ["blame Blame", () => store(page, (s, tab) => s.openBlame(tab, "src/auswertung.py", null), tabId), '[data-screen="blame"]'],
    ]) {
      await section(`Keyboard ${name}: Alt+2 puts focus into the view; every tab stop is visibly focused`, async () => {
        await wip();
        await enter();
        await page.locator(marker).waitFor({ timeout: 15_000 });
        await app.settle();
        await page.waitForTimeout(600);
        await kb.press("Alt+2");
        await page.waitForTimeout(250);
        const first = await focusState(page);
        check(!first.body && first.place.includes(name.slice(0, 3)), `Alt+2 puts focus into the view (${first.text})`);
        const stops = await tabWalk(page, { max: 140 });
        const inside = stops.filter((item) => !item.body && item.place.includes(name.slice(0, 3)));
        note(`${name}: ${inside.length} stops: ${inside.map((item) => item.name.slice(0, 30) || item.tag).join(" · ")}`);
        check(inside.length >= 5, `the view has tab stops (${inside.length})`);
        for (const problem of judgeStops(stops)) check(false, problem.text);
      }, { after: () => setCenter(page, tabId, { kind: "graph" }) });
    }

    // ---- Terminal ---------------------------------------------------------------------------------
    await store(page, (s, tab) => s.toggleTerminal(tab), tabId);
    await page.locator('[data-screen="terminal"]').waitFor();
    await page.waitForTimeout(2500);
    const terminalInput = page.locator('[data-screen="terminal"] textarea');
    await section("Terminal: Tab belongs to the shell, F6 leads out; the terminal buttons are tab stops", async () => {
      await kb.press("Alt+2");
      const stops = await tabWalk(page, { max: 120 });
      const inTerminal = stops.filter((item) => !item.body && /terminalScreen|Terminal/.test(item.place));
      note(`stops in the terminal: ${inTerminal.map((item) => item.name.slice(0, 40)).join(" · ")}`);
      check(inTerminal.some((item) => item.name === "Terminal input"), "the terminal input is a tab stop");
      check(inTerminal.some((item) => item.name === "Terminal height"), "the height handle is a tab stop");
      for (const problem of judgeStops(stops)) check(false, problem.text);
      await terminalInput.focus();
      await kb.press("F6");
      await page.waitForTimeout(200);
      check(!(await page.evaluate(() => Boolean(document.activeElement?.closest('[data-screen="terminal"]')))), "F6 leaves the terminal");
    });
    await section("Terminal: height by keyboard (handle with ↑/↓)", async () => {
      const grip = page.locator('[data-screen="terminal"] [role="separator"], [role="separator"][data-side="terminal"]').first();
      await grip.focus();
      const now = async () => Number(await grip.getAttribute("aria-valuenow"));
      const height = () => page.locator('[data-screen="terminal"]').evaluate((el) => Math.round(el.getBoundingClientRect().height));
      const start = await now();
      const before = await height();
      await kb.press("ArrowUp");
      await kb.press("ArrowUp");
      await page.waitForTimeout(200);
      check((await now()) > start, `↑ makes the terminal taller (aria-valuenow ${start} → ${await now()})`);
      check((await height()) > before, `… really taller (${before} → ${await height()} px)`);
      check(await focusIsPainted(page), "focus on the handle is visible (screenshot comparison)");
      await kb.press("ArrowDown");
      await kb.press("ArrowDown");
    });
    // BUG L3-06 – this section is red until the bug is fixed.
    await section("Terminal: whoever tabs into it learns the way out (F6) – visibly or via the input's description", async () => {
      await terminalInput.focus();
      const moves = [];
      for (const key of ["Tab", "Shift+Tab", "Escape"]) {
        await kb.press(key);
        await page.waitForTimeout(150);
        moves.push(`${key} → ${(await page.evaluate(() => Boolean(document.activeElement?.closest('[data-screen="terminal"] textarea')))) ? "stays in the terminal" : "leaves it"}`);
      }
      note(moves.join("; "));
      await page.waitForTimeout(900);
      const hint = await page.evaluate(() => {
        const root = document.querySelector('[data-screen="terminal"]');
        const input = root.querySelector("textarea");
        const described = (input.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
        const texts = [root.innerText, input.getAttribute("aria-label") ?? "", input.getAttribute("aria-description") ?? "", input.getAttribute("aria-keyshortcuts") ?? "", input.getAttribute("title") ?? "", described, ...[...document.querySelectorAll('[role="tooltip"]')].map((el) => el.textContent)];
        return { found: texts.some((text) => /F6/.test(text)), label: input.getAttribute("aria-label"), described };
      });
      if (!check(hint.found, `neither the visible terminal text nor the input's name/description ("${hint.label}", description "${hint.described}") mention F6 – Tab, Shift+Tab and Esc stay in the terminal (${moves.join("; ")})`)) await bugShot(app, "L3-06");
    }, { bug: "L3-06" });
    // BUG L3-05 – this section is red until the bug is fixed.
    await section("Terminal: the output is readable for screen readers (accessible buffer of xterm.js or rows not aria-hidden)", async () => {
      await terminalInput.focus();
      await kb.type("git status --short", { delay: 8 });
      await kb.press("Enter");
      await page.waitForTimeout(2500);
      const info = await page.evaluate(() => {
        const root = document.querySelector('[data-screen="terminal"]');
        const rows = root.querySelector(".xterm-rows");
        const tree = root.querySelector(".xterm-accessibility, .xterm-accessibility-tree");
        const shown = (rows?.innerText ?? "").trim();
        // What a screen reader gets to read from the terminal: all text outside aria-hidden
        let exposed = "";
        const walker = document.createTreeWalker(root.querySelector(".xterm") ?? root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) if (!node.parentElement.closest('[aria-hidden="true"], style, script')) exposed += node.nodeValue;
        return { rowsHidden: rows?.getAttribute("aria-hidden") ?? null, shown: shown.length, sample: shown.slice(-90), accessibilityTree: Boolean(tree), live: root.querySelectorAll(".xterm [aria-live]").length, exposed: exposed.trim().length };
      });
      note(JSON.stringify(info));
      check(info.shown > 20, `the terminal shows visible output (${info.shown} characters, end: "${info.sample}")`);
      if (!check(info.exposed > 20 || info.accessibilityTree, `of ${info.shown} visible characters a screen reader gets ${info.exposed}: the rows are only in .xterm-rows with aria-hidden="${info.rowsHidden}", there is no accessible buffer (.xterm-accessibility: ${info.accessibilityTree}) and no live region (${info.live})`)) await bugShot(app, "L3-05");
    }, { bug: "L3-05" });
    await store(page, (s, tab) => s.toggleTerminal(tab), tabId);

    // ---- Icon buttons, toolbar, select lists -----------------------------------------------------
    // BUG L3-13 – this section is red until the bug is fixed.
    await section("Icon buttons without a visible label show their name as a tooltip on keyboard focus", async () => {
      await wip();
      await kb.press("Alt+2");
      const missing = [];
      let seen = 0;
      for (let step = 0; step < s04Stops.length + 2; step++) {
        await kb.press("Tab");
        await page.waitForTimeout(40);
        const info = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body || el.tagName !== "BUTTON") return null;
          return { text: (el.innerText ?? "").trim(), svg: Boolean(el.querySelector("svg")), name: el.getAttribute("aria-label") ?? "" };
        });
        if (!info || info.text || !info.svg) continue;
        seen += 1;
        await page.waitForTimeout(900);
        const tips = await page.evaluate(() => [...document.querySelectorAll('[role="tooltip"]')].map((el) => el.textContent.trim()).filter(Boolean));
        if (!tips.length) missing.push(info.name);
      }
      note(`${seen} icon buttons; without tooltip: ${missing.join(", ") || "none"}`);
      check(seen >= 8, `icon buttons were found (${seen})`);
      for (const name of [...new Set(missing)]) check(false, `"${name}" shows no tooltip on focus`);
    }, { bug: "L3-13" });
    await section("Toolbar: disabled buttons stay focusable (aria-disabled) and name the reason", async () => {
      const disabled = await page.locator('[role="toolbar"][aria-label="Repository actions"] button').evaluateAll((list) =>
        list.filter((el) => el.getAttribute("aria-disabled") === "true" || el.disabled).map((el) => ({ name: el.getAttribute("aria-label") ?? el.innerText.trim(), native: el.disabled, tabbable: el.tabIndex >= 0, reason: (el.getAttribute("aria-describedby") ?? "").split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim() })),
      );
      note(JSON.stringify(disabled));
      check(disabled.length >= 1, "in a fresh repository at least one button is disabled (Undo)");
      for (const button of disabled) {
        check(!button.native && button.tabbable, `"${button.name}" is reachable by Tab (aria-disabled instead of disabled)`);
        check(button.reason.length > 0, `"${button.name}" names the reason (${button.reason || "nothing"})`);
      }
    });
    await section("Select list in a dialog: Enter opens, Esc closes only the list – the dialog stays, focus returns to the field", async () => {
      await kb.press("Alt+2");
      await paletteCommand(page, titleOf("repo.init"), "repo.init");
      await page.locator('[data-screen="init"]').waitFor();
      for (let step = 0; step < 10 && (await focusState(page)).role !== "combobox"; step++) await kb.press("Tab");
      const field = await focusState(page);
      equal(field.role, "combobox", "Tab reaches a select list");
      await kb.press("Enter");
      await page.locator('[role="listbox"] [role="option"]').first().waitFor({ timeout: 4000 });
      check(await page.evaluate(() => document.activeElement?.getAttribute("role") === "option"), "focus is on an entry");
      await kb.press("Escape");
      await page.waitForTimeout(350);
      equal(await dialogCount(page), 1, "the dialog is still open");
      check((await focusState(page)).id === field.id, "focus is back on the field");
    }, { after: () => escapeAll(page) });
    await section("Visible label is part of the accessible name (WCAG 2.5.3) – main word of every element with aria-label", async () => {
      await wip();
      await page.waitForTimeout(300);
      const missing = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll("[aria-label]")) {
          if (!el.matches('button, a, [role="button"], [role="tab"], [role="option"], [role="treeitem"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="switch"]')) continue;
          const rect = el.getBoundingClientRect();
          if (rect.width < 2 || el.closest('[aria-hidden="true"]')) continue;
          const name = el.getAttribute("aria-label").toLowerCase().replace(/\s+/g, " ");
          // Main word: the first visible text with letters (counters, times and extras are paraphrased in the name).
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let main = null;
          for (let node = walker.nextNode(); node && !main; node = walker.nextNode()) {
            const text = node.nodeValue.trim();
            if (text.length > 1 && /\p{L}{2}/u.test(text) && !node.parentElement.closest(".sr-only, [aria-hidden='true']")) main = text.toLowerCase().replace(/\s+/g, " ");
          }
          if (main && !name.includes(main)) out.push(`"${el.getAttribute("aria-label").slice(0, 60)}" does not contain the visible text "${main.slice(0, 40)}"`);
        }
        return out;
      });
      for (const line of missing) check(false, line);
    });
  } finally {
    await stop(app);
  }
};

/** Scrollable areas of the current state: where, how far, and whether the keyboard gets in. */
const scrollables = (page) =>
  page.evaluate(() => {
    window.__l3scroll = [];
    const out = [];
    for (const el of document.querySelectorAll("body *")) {
      const style = getComputedStyle(el);
      if (!/(auto|scroll)/.test(style.overflowY)) continue;
      if (el.scrollHeight <= el.clientHeight + 12) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 40 || el.closest('[aria-hidden="true"]')) continue;
      const focusable = 'button, a[href], input:not([type="hidden"]), select, textarea, [tabindex], [contenteditable="true"]';
      window.__l3scroll.push(el);
      out.push({
        index: window.__l3scroll.length - 1,
        text: window.__l3.describe(el),
        cls: el.className.toString().slice(0, 70),
        selfFocusable: el.matches(focusable),
        inside: el.querySelectorAll(focusable).length,
        tabbableInside: [...el.querySelectorAll(focusable)].filter((item) => item.tabIndex >= 0 && !item.disabled).length,
        max: el.scrollHeight - el.clientHeight,
        top: el.scrollTop,
        hasFocus: el.contains(document.activeElement),
      });
    }
    return out;
  });
const scrollTops = (page) => page.evaluate(() => (window.__l3scroll ?? []).map((el) => Math.round(el.scrollTop)));

/** Right click on the centre of an element; returns the entries of the menu that opens (or null). */
async function menuByMouse(page, locator) {
  await locator.click({ button: "right", timeout: 5000 });
  const menu = page.locator('[role="menu"]').first();
  const opened = await menu.waitFor({ timeout: 1500 }).then(() => true, () => false);
  if (!opened) return null;
  const items = await page.locator('[role="menu"] [role^="menuitem"]').allInnerTexts();
  await page.keyboard.press("Escape");
  await page.locator('[role="menu"]').first().waitFor({ state: "detached", timeout: 3000 }).catch(() => undefined);
  return items.map((item) => item.replace(/\s+/g, " ").trim());
}
/** Shift+F10 (or the Menu key) on the focused element. */
async function menuByKey(page, key = "Shift+F10") {
  const origin = await focusState(page);
  await page.keyboard.press(key);
  const menu = page.locator('[role="menu"]').first();
  const opened = await menu.waitFor({ timeout: 1500 }).then(() => true, () => false);
  if (!opened) return { items: null, origin };
  const items = (await page.locator('[role="menu"] [role^="menuitem"]').allInnerTexts()).map((item) => item.replace(/\s+/g, " ").trim());
  const inMenu = await page.evaluate(() => Boolean(document.activeElement?.closest('[role="menu"]')));
  const box = await menu.boundingBox();
  await page.keyboard.press("Escape");
  await page.locator('[role="menu"]').first().waitFor({ state: "detached", timeout: 3000 }).catch(() => undefined);
  await page.waitForTimeout(200);
  const back = await focusState(page);
  return { items, origin, inMenu, box, back };
}

/**
 * Part "hoster": pull requests (pr-create, pr-view), host accounts (hosts), issues (issues) –
 * against the LOCAL host from scripts/e2e/screens/host-lib.mjs, never against real services.
 */
parts.hoster = async () => {
  const { startHost, makeHostRepo, seedPrs, connectDirect, PEOPLE, LONG_TITLE } = await import("../screens/host-lib.mjs");
  const github = await startHost({ kind: "github" });
  cleanups.push(() => void github.close().catch(() => undefined));
  const gh = makeHostRepo(github);
  cleanups.push(() => gh.repo.cleanup?.());
  seedPrs(github, gh.sha);
  const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  github.addIssue({ number: 7, title: "Regenmesser Nord liefert doppelte Werte", body: "Seit dem Neustart des Loggers stehen **beide** Kanäle in der Datei.\n\n- [ ] prüfen\n- [x] gemeldet", author: PEOPLE.jonas, assignees: [PEOPLE.lena], labels: ["bug", "station-nord", "dringend"], updatedAt: minutesAgo(5), comments: [{ author: PEOPLE.aylin, body: "Bei mir auch.", createdAt: minutesAgo(50) }] });
  github.addIssue({ number: 8, title: LONG_TITLE, body: "Ohne Leerzeichen: " + "x".repeat(300), author: PEOPLE.aylin, labels: ["frage"], updatedAt: minutesAgo(15) });
  github.addIssue({ number: 3, title: "Hafen: Zeitstempel in UTC statt Ortszeit", state: "closed", author: PEOPLE.lena, updatedAt: minutesAgo(900) });
  gh.repo.git("checkout", "-q", "main");

  const app = await start();
  const { page } = app;
  const kb = page.keyboard;
  try {
    await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
    const { tabId } = await app.openRepo(gh.repo.path);
    const graph = () => setCenter(page, tabId, { kind: "graph" });

    await state(app, "pr-view/issues sidebar: sections without account (not connected)", async () => page.waitForTimeout(500), { leave: async () => undefined });
    await state(app, "hosts dialog \"Connect host account\"", async () => {
      if (!(await runCommand(page, "hosts.connect"))) throw new Error("hosts.connect not available");
      await page.locator('[data-screen="hosts-connect"]').waitFor();
    });
    await connectDirect(app, github);
    await page.waitForTimeout(800);
    await state(app, "pr-view/issues sidebar: pull request and issue sections (connected)", async () => app.settle(), { leave: async () => undefined });
    await state(app, "hosts Preferences › Integrations (one account)", async () => {
      await openOverlay(page, { kind: "preferences", section: "integrations" });
      await page.locator('[data-screen="hosts"]').waitFor();
    });
    await state(app, "pr-create Create pull request", async () => {
      await setCenter(page, tabId, { kind: "pr_create", source: "thema/neue-auswertung" });
      await page.locator('[data-screen="pr-create"]').waitFor();
      await page.waitForTimeout(1200);
    }, { leave: graph });
    for (const [number, what] of [[12, "CI green, review approved"], [14, "CI failed, not mergeable"], [15, "draft, CI running"]]) {
      await state(app, `pr-view Pull Request #${number} (${what})`, async () => {
        await setCenter(page, tabId, { kind: "pr", number });
        await page.locator(`[data-screen="pr-view"][data-pr-number="${number}"] [data-pr-head]`).waitFor({ timeout: 30_000 });
        await page.waitForTimeout(600);
      }, { leave: graph });
    }
    await state(app, "pr-view Merge dialog", async () => {
      await setCenter(page, tabId, { kind: "pr", number: 12 });
      await page.locator('[data-screen="pr-view"][data-pr-number="12"] [data-pr-head]').waitFor({ timeout: 30_000 });
      await page.locator('[data-screen="pr-view"]').getByRole("button", { name: /^Merge/ }).first().click();
      await page.locator('[data-screen="pr-merge"]').waitFor({ timeout: 8000 });
    }, { leave: async () => { await escapeAll(page); await graph(); } });
    await state(app, "issues Issues: list", async () => {
      await setCenter(page, tabId, { kind: "issues", number: null });
      await page.locator('[data-screen="issues"]').waitFor();
      await page.waitForTimeout(900);
    }, { leave: async () => undefined });
    await state(app, "issues Issues: one issue open", async () => {
      await setCenter(page, tabId, { kind: "issues", number: 7 });
      await page.waitForTimeout(1200);
    }, { leave: graph });

    // Keyboard in the host views
    for (const [name, center, marker] of [
      ["pr-view Pull Request #12", { kind: "pr", number: 12 }, '[data-screen="pr-view"][data-pr-number="12"] [data-pr-head]'],
      ["pr-create Create pull request", { kind: "pr_create", source: "thema/neue-auswertung" }, '[data-screen="pr-create"]'],
      ["issues Issue #7", { kind: "issues", number: 7 }, '[data-screen="issues"]'],
    ]) {
      await section(`Keyboard ${name}: Alt+2 puts focus into the view, every tab stop is visible`, async () => {
        await setCenter(page, tabId, center);
        await page.locator(marker).waitFor({ timeout: 30_000 });
        await app.settle();
        await page.waitForTimeout(700);
        await kb.press("Alt+2");
        await page.waitForTimeout(250);
        const first = await focusState(page);
        note(`${name}: Alt+2 → ${first.text}`);
        check(!first.body && /S2[34]|issuesScreen/.test(first.place), `Alt+2 puts focus into the view (${first.text})`);
        const stops = await tabWalk(page, { max: 140 });
        const inView = stops.filter((stop) => !stop.body && /S2[34]|issuesScreen/.test(stop.place));
        note(`${stops.length} stops, ${inView.length} of them in the view: ${inView.map((stop) => stop.name.slice(0, 40) || stop.tag).join(" · ").slice(0, 900)}`);
        check(inView.length >= 2, `the view has tab stops (${inView.length})`);
        for (const problem of judgeStops(stops)) check(false, problem.text);
      }, { after: graph });
    }
  } finally {
    for (const account of await app.invoke("host_accounts").catch(() => [])) await app.invoke("host_disconnect", { accountId: account.id }).catch(() => undefined);
    await stop(app);
  }
};

const layoutOf = async (page) => {
  await page.evaluate(installPageLib);
  return page.evaluate(() => window.__l3.layout());
};
const zoomOf = (page) => page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).zoom || "1"));
const SCRATCH_SHOTS = "target/e2e/l3-shots";

/** Part "zoom": largest zoom level, minimum window, both together; prefers-reduced-motion; system contrast mode. */
parts.zoom = async () => {
  const app = await start();
  const { page } = app;
  const kb = page.keyboard;
  const rich = makeRichRepo();
  cleanups.push(rich.cleanup);
  // The configured zoom only applies as far as 960×600 layout pixels still fit in the window
  // (src/app/zoom.ts): we wait for the zoom that is effective in the window.
  const setZoom = async (zoom) => {
    await app.invoke("settings_set", { patch: { zoom } });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "settings"] }));
    await page.waitForFunction(
      (value) => {
        const fits = Math.floor(Math.min(window.innerWidth / 960, window.innerHeight / 600) * 100) / 100;
        const expected = value <= 1 ? value : Math.max(1, Math.min(value, fits));
        return Math.abs(Number.parseFloat(getComputedStyle(document.documentElement).zoom || "1") - expected) < 0.011;
      },
      zoom,
      { timeout: 5000 },
    );
  };
  try {
    const { tabId } = await app.openRepo(rich.path);
    await page.waitForTimeout(600);
    const head = rich.git("rev-parse", "HEAD");
    const tracked = "src/auswertung.py";
    const graph = () => setCenter(page, tabId, { kind: "graph" });
    const wip = () => store(page, (s, tab) => s.selectWip(tab), tabId);

    // BUG L3-03 – this section is red until the bug is fixed.
    await section("Zoom: Ctrl + + enlarges up to 200 % (WCAG 1.4.4 resize text)", async () => {
      await kb.press("Alt+2");
      const steps = [];
      for (let press = 0; press < 12; press++) {
        await kb.press("Control+=");
        await page.waitForTimeout(120);
        steps.push(Math.round((await zoomOf(page)) * 100));
      }
      const plus = page.getByRole("button", { name: "Zoom in" });
      const setting = Math.round((await app.invoke("settings_get")).zoom * 100);
      const size = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
      const fits = Math.floor(Math.min(size[0] / 960, size[1] / 600) * 100);
      note(`zoom after each Ctrl + +: ${steps.join(", ")}; setting ${setting} %; button "Zoom in" disabled: ${await plus.isDisabled()}; window ${size.join("×")} holds up to ${fits} %`);
      // The setting goes up to 200 %. The window applies as much of it as still leaves 960×600 layout pixels –
      // full 200 % from 1920×1200; below that the app limits the zoom instead of breaking the layout.
      if (!check(setting >= 200, `after pressing Ctrl + + twelve times the setting is at ${setting} % (displayed steps: ${[...new Set(steps)].join(", ")})`)) await bugShot(app, "L3-03");
      check(steps.at(-1) === Math.min(200, Math.max(100, fits)), `the window applies the largest zoom that fits: ${steps.at(-1)} % (expected ${Math.min(200, Math.max(100, fits))} %)`);
      const label = await page.getByRole("button", { name: /^Zoom \d+%/ }).first().getAttribute("aria-label");
      check(fits >= 200 || /applies \d+%/.test(label ?? ""), `the status bar says how much zoom the window applies: "${label}"`);
    }, { bug: "L3-03" });

    // States checked at every size: [name, enter, leave]
    const views = {
      ansicht: [
        ["shell Repo view", wip, null],
        ["commit-details Commit details", () => store(page, (s, [tab, sha]) => s.selectCommits(tab, [sha]), [tabId, head]), wip],
        ["diff Diff", () => store(page, (s, tab) => s.openDiff(tab, "src/auswertung.py", { kind: "unstaged" }), tabId), graph],
        ["file-view Editor", () => store(page, (s, [tab, file]) => s.openFile(tab, file, null, "edit"), [tabId, tracked]), graph],
        ["file-history File History", () => store(page, (s, [tab, file]) => s.openHistory(tab, file), [tabId, tracked]), graph],
        ["blame Blame", () => store(page, (s, [tab, file]) => s.openBlame(tab, file, null), [tabId, tracked]), graph],
        ["commit-search Search", async () => {
          await store(page, (s, tab) => s.setSearchOpen(tab, true), tabId);
          await page.locator('[data-screen="commit-search"] input').first().fill("Messwerte");
        }, () => store(page, (s, tab) => s.setSearchOpen(tab, false), tabId)],
        ["terminal Terminal", async () => {
          await store(page, (s, tab) => s.toggleTerminal(tab), tabId);
          await page.waitForTimeout(1500);
        }, () => store(page, (s, tab) => s.toggleTerminal(tab), tabId)],
      ],
      dialog: [
        ["shortcuts Keyboard shortcuts", () => openOverlay(page, { kind: "shortcuts" }), null],
        ["settings Preferences › General", () => openOverlay(page, { kind: "preferences", section: "general" }), null],
        ["settings Preferences › This repository", () => openOverlay(page, { kind: "preferences", section: "repo" }), null],
        ["activity-log Activity Log", () => openOverlay(page, { kind: "activity" }), null],
        ["clone Clone dialog", () => openOverlay(page, { kind: "clone" }), null],
        ["init Init dialog", () => openOverlay(page, { kind: "init" }), null],
        ["command-palette Command palette", () => openOverlay(page, { kind: "palette", mode: "all" }), null],
        ["remote-dialog Add remote dialog", () => openOverlay(page, { kind: "add_remote" }), null],
        ["submodules Submodule dialog", () => openOverlay(page, { kind: "add_submodule" }), null],
        ["submodules Git LFS", () => openOverlay(page, { kind: "lfs" }), null],
        ["submodules Worktree dialog", () => runCommand(page, "worktree.add"), null],
        ["network Gitflow", () => runCommand(page, "gitflow.open"), null],
        ["network Create patch", () => runCommand(page, "patch.create.wip"), null],
        ["network Apply patch", () => runCommand(page, "patch.apply"), null],
        ["Dialog New branch", () => runCommand(page, "branch.create"), null],
        ["Confirmation Discard all", () => runCommand(page, "wip.discardAll"), null],
      ],
    };
    const sizes = [
      { label: "Zoom 100 %, minimum window 960×600", zoom: 1, width: 960, height: 600 },
      { label: "Zoom 150 %, window 1440×900", zoom: 1.5, width: 1440, height: 900 },
      { label: "Zoom 125 %, window 1280×720", zoom: 1.25, width: 1280, height: 720 },
      { label: "Zoom 150 %, minimum window 960×600", zoom: 1.5, width: 960, height: 600 },
    ];
    const describeProblem = (problem) => `${problem.kind}: ${problem.text}${problem.by ? ` – by ${problem.by}` : ""}${problem.rect ? ` ${JSON.stringify(problem.rect)}` : ""}${problem.window ? ` in window ${problem.window.join("×")}` : ""}`;
    for (const size of sizes) {
      await app.setSize(size.width, size.height);
      await setZoom(size.zoom);
      await page.waitForTimeout(500);
      // BUG L3-02 (views at zoom 150 % in the minimum window) and BUG L3-01 (dialogs from zoom 125 %): red until fixed.
      for (const [kind, title, bug, shotAt] of [
        ["ansicht", "Views and panels – nothing clipped, covered or outside the window", "L3-02", "shell Repo view"],
        ["dialog", "Dialogs fit entirely in the window (title, close button and action buttons visible)", "L3-01", "shortcuts Keyboard shortcuts"],
      ]) {
        await section(`Layout ${size.label}: ${title}`, async () => {
          for (const [name, enter, leave] of views[kind]) {
            try {
              await enter();
              if (kind === "dialog" && !(await until(async () => (await dialogCount(page)) > 0, 6000))) throw new Error("no dialog appeared");
              await app.settle().catch(() => undefined);
              await page.waitForTimeout(450);
              const result = await layoutOf(page);
              note(`${name}: zoom ${result.zoom}, window ${result.window.join("×")}, ${result.problems.length} findings`);
              if (result.problems.length) {
                // A problem with zoom belongs to the reported bugs; at 100 % it would be new.
                if (size.zoom > 1) blame(bug);
                await app.screenshot(`${SCRATCH_SHOTS}/${size.label.replace(/[^A-Za-z0-9]+/g, "-")}--${name.replace(/[^A-Za-z0-9]+/g, "-")}.png`).catch(() => undefined);
                if (name === shotAt && (size.zoom === 1.5 && (kind === "dialog" ? size.width === 1440 : size.width === 960))) await bugShot(app, bug);
              }
              for (const problem of result.problems.slice(0, 6)) check(false, `${name} – ${describeProblem(problem)}`);
              if (result.problems.length > 6) check(false, `${name} – … and ${result.problems.length - 6} more`);
            } catch (error) {
              check(false, `${name}: ${String(error?.message ?? error).split("\n")[0]}`);
            }
            await escapeAll(page);
            if (leave) await leave();
            await page.waitForTimeout(120);
          }
        });
      }
    }
    await setZoom(1);
    await app.setSize(1440, 900);
    await page.waitForTimeout(400);

    // ---- Maximum width of both panels -------------------------------------------------------------
    // BUG L3-14 – this section is red until the bug is fixed.
    await section("Both panels at maximum width (End on both handles, 1440×900): the centre view stays usable", async () => {
      await wip();
      for (const label of ["Sidebar width", "Commit panel width"]) {
        await page.locator(`[role="separator"][aria-label="${label}"]`).focus();
        await kb.press("End");
      }
      await page.waitForTimeout(400);
      const center = await page.locator('[data-area="center"]').evaluate((el) => Math.round(el.getBoundingClientRect().width));
      note(`centre width: ${center} px`);
      for (const [name, enter] of [["commit-graph Graph", graph], ["diff Diff", () => store(page, (s, tab) => s.openDiff(tab, "src/auswertung.py", { kind: "unstaged" }), tabId)]]) {
        await enter();
        await app.settle();
        await page.waitForTimeout(500);
        const result = await layoutOf(page);
        if (result.problems.length) await bugShot(app, "L3-14");
        for (const problem of result.problems.slice(0, 6)) check(false, `${name} at ${center} px – ${describeProblem(problem)}`);
        if (name === "diff Diff") {
          // The diff header buttons must lie entirely in the centre – none of them under the commit panel.
          const cut = await page.evaluate(() => {
            const main = document.querySelector('[data-area="center"]').getBoundingClientRect();
            return [...document.querySelectorAll('[data-screen="diff"] button')].filter((el) => {
              const rect = el.getBoundingClientRect();
              return rect.width > 0 && (rect.right > main.right + 1 || rect.left < main.left - 1 || rect.width < 12);
            }).map((el) => `${el.getAttribute("aria-label") ?? el.textContent.trim()} (${Math.round(el.getBoundingClientRect().left)}–${Math.round(el.getBoundingClientRect().right)}, centre ends at ${Math.round(main.right)})`);
          });
          for (const item of cut) check(false, `${name} at ${center} px – sticks out of the centre or is squeezed: ${item}`);
        }
      }
    }, {
      bug: "L3-14",
      after: async () => {
        await graph();
        // back to the default widths, with keys
        for (const [label, target, grows] of [["Sidebar width", 260, "ArrowRight"], ["Commit panel width", 380, "ArrowLeft"]]) {
          const grip = page.locator(`[role="separator"][aria-label="${label}"]`);
          await grip.focus();
          await kb.press("Home");
          for (let step = 0; step < 60 && Number(await grip.getAttribute("aria-valuenow")) < target; step++) await kb.press(grows);
        }
      },
    });

    // ---- Reduced motion ----------------------------------------------------------------------------
    const motion = () =>
      page.evaluate(() => {
        const seconds = (value) => Math.max(...value.split(",").map((part) => (part.trim().endsWith("ms") ? parseFloat(part) / 1000 : parseFloat(part))));
        const out = new Set();
        for (const el of document.querySelectorAll("*")) {
          for (const pseudo of [null, "::before", "::after"]) {
            const style = getComputedStyle(el, pseudo);
            if (style.animationName !== "none" && seconds(style.animationDuration) > 0.011) out.add(`Animation ${style.animationName} ${style.animationDuration} (${style.animationIterationCount}×)`);
            if (seconds(style.transitionDuration) > 0.011) out.add(`transition ${style.transitionProperty.slice(0, 40)} ${style.transitionDuration}`);
          }
        }
        return [...out];
      });
    const busyState = async () => {
      await raiseToast(page, "info", "Motion", { sticky: true });
      await openOverlay(page, { kind: "preferences", section: "general" });
      await page.locator('[data-screen="settings"]').waitFor();
      await page.waitForTimeout(60);
    };
    await section("prefers-reduced-motion: with \"reduce motion\" no animation and no transition runs (dialog, toast, switch, loading skeleton)", async () => {
      await busyState();
      const normal = await motion();
      note(`without restriction: ${normal.join("; ") || "nothing"}`);
      check(normal.length > 0, "counter-check: without the setting there are animations or transitions");
      await escapeAll(page);
      await clearToasts(page);
      await page.emulateMedia({ reducedMotion: "reduce" });
      equal(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), true, "the app sees the system setting");
      await busyState();
      const reduced = await motion();
      for (const line of reduced) check(false, `runs despite reduced motion: ${line}`);
      // Loading skeleton: a file's history, while loading
      await escapeAll(page);
      await store(page, (s, [tab, file]) => s.openHistory(tab, file), [tabId, tracked]);
      await page.waitForTimeout(40);
      for (const line of await motion()) check(false, `while loading the history despite reduced motion: ${line}`);
    }, {
      after: async () => {
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await escapeAll(page);
        await clearToasts(page);
        await graph();
      },
    });

    // ---- System contrast mode (Windows "contrast themes", forced-colors) ---------------------------
    await page.emulateMedia({ forcedColors: "active" });
    await page.waitForTimeout(400);
    const clipOf = async (locator, pad = 2) => {
      const box = await locator.boundingBox();
      return { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: box.width + 2 * pad, height: box.height + 2 * pad };
    };
    const picture = (clip) => page.screenshot({ clip, animations: "disabled", caret: "hide" });
    // BUG L3-04 – this section is red until the bug is fixed.
    await section("Contrast mode (forced-colors): every tab stop of the repo view shows focus as an outline", async () => {
      equal(await page.evaluate(() => matchMedia("(forced-colors: active)").matches), true, "the app sees the contrast mode");
      await wip();
      await kb.press("Alt+2");
      const stops = await tabWalk(page, { max: 120 });
      const without = stops.filter((item) => !item.body && !item.outline && !item.editable);
      note(`${stops.length} stops, ${without.length} without outline`);
      for (const item of without) check(false, `${item.text}: no outline in contrast mode – shadows and backgrounds are dropped there`);
    }, { bug: "L3-04" });
    // BUG L3-04 – this section is red until the bug is fixed.
    await section("Contrast mode (forced-colors): a switch looks different when on and off", async () => {
      await openOverlay(page, { kind: "preferences", section: "general" });
      await page.locator('[data-screen="settings"] [role="switch"]').first().waitFor();
      await page.waitForTimeout(400);
      const toggle = page.locator('[data-screen="settings"] [role="switch"]').first();
      const name = await toggle.evaluate((el) => window.__l3?.accName(el) ?? el.getAttribute("aria-label"));
      const clip = await clipOf(toggle);
      const stateBefore = await toggle.getAttribute("aria-checked");
      // Focus elsewhere so only the state determines the image
      await page.locator('[data-screen="settings"] [role="tab"]').first().focus();
      const first = await picture(clip);
      await toggle.focus();
      await kb.press("Space");
      await eventually(() => toggle.getAttribute("aria-checked"), stateBefore === "true" ? "false" : "true", "Space toggles");
      await page.locator('[data-screen="settings"] [role="tab"]').first().focus();
      await page.waitForTimeout(250);
      const second = await picture(clip);
      if (!check(!first.equals(second), `the switch "${String(name).slice(0, 50)}" looks identical in every pixel with aria-checked=true and =false – you cannot see whether a setting is on`)) await bugShot(app, "L3-04");
      await toggle.focus();
      await kb.press("Space");
      await eventually(() => toggle.getAttribute("aria-checked"), stateBefore, "back as before");
    }, { bug: "L3-04", after: () => escapeAll(page) });
    // BUG L3-04 – this section is red until the bug is fixed.
    await section("Contrast mode (forced-colors): the selected graph row and the selected segment of a segmented control are recognisable", async () => {
      await wip();
      await kb.press("Alt+1");
      await page.waitForTimeout(200);
      const row = page.locator(`[data-screen="commit-graph"] [role="row"][data-row-id="${head}"]`);
      const clip = await clipOf(row, 0);
      const plain = await picture(clip);
      await store(page, (s, [tab, sha]) => s.selectCommits(tab, [sha]), [tabId, head]);
      await page.waitForTimeout(300);
      equal(await row.getAttribute("aria-selected"), "true", "the row is selected");
      const selected = await picture(clip);
      check(!plain.equals(selected), "the selected commit row looks exactly like an unselected one (selection only via background colour)");
      await wip();
      await page.waitForTimeout(300);
      // Segmented control Commit | Stash: image with "Commit" selected vs. image with "Stash" selected (focus is in the sidebar).
      const group = page.locator('[data-area="right"] [role="radiogroup"]').first();
      const groupClip = await clipOf(group, 0);
      const chosen = () => group.locator('[role="radio"]').evaluateAll((list) => list.filter((el) => el.getAttribute("aria-checked") === "true" || el.getAttribute("data-state") === "on").map((el) => el.textContent.trim()));
      equal(await chosen(), ["Commit"], "\"Commit\" is selected");
      const commitShot = await picture(groupClip);
      await store(page, (s, tab) => s.setRightPanel(tab, "stash_form"), tabId);
      await page.waitForTimeout(300);
      equal(await chosen(), ["Stash"], "now \"Stash\" is selected");
      const stashShot = await picture(groupClip);
      check(!commitShot.equals(stashShot), "the segmented control \"Commit | Stash\" looks identical in every pixel with \"Commit\" and with \"Stash\" selected");
      await store(page, (s, tab) => s.setRightPanel(tab, "details"), tabId);
    }, { bug: "L3-04" });
    await page.emulateMedia({ forcedColors: "none" });
  } finally {
    await page.emulateMedia({ forcedColors: "none", reducedMotion: "no-preference" }).catch(() => undefined);
    await app.invoke("settings_set", { patch: { zoom: 1 } }).catch(() => undefined);
    await stop(app);
  }
};

// ---------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------

// Exploration: `--sonde <file.mjs>` loads an extra part "sonde" (probe; default export: async (helpers) => …).
if (argv.includes("--sonde")) {
  const file = path.resolve(argv[argv.indexOf("--sonde") + 1]);
  const module = await import(pathToFileURL(file).href);
  parts.sonde = () => module.default({ start, stop, section, check, equal, eventually, until, note, scan, state, store, openOverlay, closeOverlay, setCenter, runCommand, paletteCommand, dialogCount, raiseToast, clearToasts, escapeAll, focusState, tabWalk, walkText, judgeStops, scrollables, scrollTops, menuByMouse, menuByKey, layoutOf, zoomOf, installPageLib, ensureLibs, axeRun, cleanups, sleep, ROOT, fixtures: { makeRichRepo, makeCleanRepoWithRemote, makeConflictRepo, makeDetachedRepo, makeEmptyRepo } });
}
const wanted = Object.keys(parts).filter((name) => (only ? only.includes(name) : name !== "sonde"));
for (const name of wanted) {
  console.log(`\n━━ Part "${name}" ━━`);
  try {
    await parts[name]();
  } catch (error) {
    await section(`Part "${name}" runs through`, async () => check(false, `aborted: ${error?.stack ?? error}`));
  }
  for (const app of [...apps]) await stop(app);
}
for (const cleanup of cleanups) {
  try {
    cleanup();
  } catch {
    // The temp folder stays; the next run removes it
  }
}

// BUG L3-10, BUG L3-11, BUG L3-12 – one section per reported bug from the scans: red as long as axe finds it anywhere.
for (const id of ["L3-10", "L3-11", "L3-12"]) {
  const byElement = scanHits.get(id);
  if (!byElement && only && !only.some((name) => ["start", "repo", "werkzeuge", "hoster"].includes(name))) continue;
  await section(`axe across all scanned states: ${BUGS[id].replace(/^S\d · /, "")}`, async () => {
    for (const [what, screens] of byElement ?? []) check(false, `${what} – in ${screens.size} states, e.g. ${[...screens].slice(0, 3).join("; ")}`);
  }, { bug: id });
}

fs.mkdirSync(path.join(ROOT, "target", "e2e"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "target", "e2e", `a11y-funde${only ? `-${only.join("-")}` : ""}.json`), JSON.stringify({ findings, pointerNotes, sections }, null, 1));

const green = sections.filter((item) => item.ok);
const red = sections.filter((item) => !item.ok);
console.log(`\n══ Accessibility and keyboard: ${green.length} green, ${red.length} red sections ══`);
console.log("\nGREEN");
for (const item of green) console.log(`  ✓ ${item.name}`);
console.log("\nRED");
for (const item of red) {
  console.log(`  ✗ ${item.name}`);
  for (const message of item.messages.slice(0, 10)) console.log(`      - ${message}`);
  if (item.messages.length > 10) console.log(`      … and ${item.messages.length - 10} more`);
}
const shown = [...new Set(red.map((item) => item.bug).filter(Boolean))].sort();
if (shown.length) {
  console.log("\nBUGS SHOWN");
  for (const id of shown) console.log(`  ${id}  ${BUGS[id] ?? ""}`);
}
const unassigned = red.filter((item) => !item.bug);
if (unassigned.length) console.log(`\n${unassigned.length} red sections without a bug ID – new or flaky: take a look.`);
process.exit(red.length ? 1 : 0);
