/**
 * Fixtures and UI helpers for scripts/e2e-wd/features/gitflow-hooks.mjs: the clean "messnetz"
 * repository (main, feature/export, remote origin) with Git helpers for Git Flow checks, hook
 * scripts, and a small driver for the palette, dialogs, toasts and menus of the real app.
 */
import fs from "node:fs";
import path from "node:path";
import { makeCleanRepoWithRemote } from "../../e2e/fixtures.mjs";
import { AssertionError } from "../lib.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** "messnetz" with origin, plus helpers: config(key), branches(), head(), sha(rev), isAncestor, commitFile, hook(). */
export function makeFlowRepo({ name = "ablauf" } = {}) {
  const repo = makeCleanRepoWithRemote({ name });
  const tryGit = (...args) => {
    try {
      return repo.git(...args);
    } catch {
      return null;
    }
  };
  const self = {
    ...repo,
    tryGit,
    config: (key) => tryGit("config", "--local", "--get", key),
    branches: () => repo.git("branch", "--format=%(refname:short)").split("\n").filter(Boolean).sort(),
    head: () => repo.git("rev-parse", "--abbrev-ref", "HEAD"),
    sha: (rev) => repo.git("rev-parse", rev),
    isAncestor: (a, b) => tryGit("merge-base", "--is-ancestor", a, b) !== null,
    read: (rel) => fs.readFileSync(path.join(repo.path, rel), "utf8"),
    /** Writes, stages everything and commits; returns the new SHA. */
    commitFile(rel, content, message) {
      repo.write(rel, content);
      repo.git("add", "-A");
      repo.git("commit", "-q", "-m", message);
      return self.sha("HEAD");
    },
    /** Writes an executable hook (sh) into `.git/hooks` or into `dir` (relative to the repository). */
    hook(name, body, dir = ".git/hooks") {
      const folder = path.join(repo.path, dir);
      fs.mkdirSync(folder, { recursive: true });
      const file = path.join(folder, name);
      fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      fs.chmodSync(file, 0o755);
      return file;
    },
    /** SHA of a ref in the bare remote, or null. */
    remoteSha: (ref) => tryGit("ls-remote", "origin", ref)?.split(/\s+/)[0] || null,
  };
  return self;
}

/** Polls `read()` (sync or async) until it equals `expected` (JSON). */
export async function eventually(read, expected, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let actual;
  for (;;) {
    try {
      actual = await read();
    } catch (error) {
      actual = `<${error.message}>`;
    }
    if (JSON.stringify(actual) === JSON.stringify(expected)) return actual;
    if (Date.now() > deadline) throw new AssertionError(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    await sleep(100);
  }
}

/** Polls `read()` until truthy. */
export async function until(read, message, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new AssertionError(`${message} (timed out after ${timeoutMs} ms)`);
    await sleep(100);
  }
}

/** UI driver for one app instance. */
export function flowUi(app) {
  const DIALOG = '[data-screen="gitflow"]';
  const ui = {
    DIALOG,
    FINISH: '[data-screen="gitflow-finish"]',
    sleep,
    /** innerText of a CSS selector (normalised), or null. */
    text: (css) => app.exec((selector) => document.querySelector(selector)?.innerText.replace(/\s+/g, " ").trim() ?? null, css),
    attr: (css, name) => app.exec((selector, key) => document.querySelector(selector)?.getAttribute(key) ?? null, css, name),
    flowState: () => ui.attr(DIALOG, "data-gitflow-state"),
    note: () => ui.text("[data-gitflow-note]"),
    active: () => app.exec((root) => [...document.querySelectorAll(`${root} [data-gitflow-branch]`)].map((row) => row.dataset.gitflowBranch), DIALOG),
    /** Label (or aria-label/text) of the focused element. */
    focusedLabel: () =>
      app.exec(() => {
        const el = document.activeElement;
        if (!el) return null;
        const label = el.labels?.[0]?.textContent?.trim() || (el.id && document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim());
        return label || el.getAttribute("aria-label") || el.textContent?.trim() || null;
      }),
    focusedValue: () => app.exec(() => document.activeElement?.value ?? null),
    /** Presses Tab until the focused element's label is `wanted`. */
    async tabTo(wanted, max = 30) {
      for (let step = 0; step <= max; step++) {
        if ((await ui.focusedLabel()) === wanted) return step;
        await app.press("Tab");
      }
      throw new AssertionError(`Tab does not reach “${wanted}” (focus on “${await ui.focusedLabel()}”)`);
    },
    /** Window focus makes the app re-read the repository. */
    async refresh() {
      await app.exec(() => window.dispatchEvent(new Event("focus")));
      await app.settle();
    },

    // ---- palette ---------------------------------------------------------------------------
    async openPalette(text) {
      await app.exec(() => document.activeElement?.blur());
      await app.press("Control+p");
      const input = await app.waitFor('[data-screen="command-palette"] input[role="combobox"]', 10_000);
      await app.type(input, `>${text}`);
      return input;
    },
    paletteEntry: (id) =>
      app.waitFor(() => app.exec((key) => document.querySelector(`[data-screen="command-palette"] [role="option"][data-key="command:${key}"]`), id), 10_000, { message: `palette entry ${id}` }),
    async closePalette() {
      await app.press("Escape");
      await app.waitFor(() => app.exec(() => !document.querySelector('[data-screen="command-palette"]')), 5000, { message: "palette closed" });
    },
    /** Runs a command through the palette (Ctrl+P, ">text", click on the entry with that id). */
    async runCommand(text, id) {
      await ui.openPalette(text);
      const closed = () => app.exec(() => !document.querySelector('[data-screen="command-palette"]'));
      // The list re-renders while results settle: a click can hit a moving or stale entry. Retry
      // until the palette has run the command (it closes).
      for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt > 0 && (await closed())) return;
        try {
          await app.click(await ui.paletteEntry(id));
        } catch (error) {
          if (await closed()) return;
          if (!/stale/i.test(error.message)) throw error;
        }
        const done = await app.waitFor(closed, 1500).catch(() => false);
        if (done) return;
      }
      throw new AssertionError(`palette entry ${id} did not run`);
    },
    async openFlow(text = "gitflow", id = "gitflow.open") {
      await ui.runCommand(text, id);
      await app.waitFor(DIALOG, 10_000);
      await until(async () => ["setup", "ready"].includes(await ui.flowState()), "the Git Flow dialog is loaded");
      await app.settle();
    },

    // ---- dialogs ---------------------------------------------------------------------------
    /** Title (h2) of the topmost dialog, or null. */
    dialogTitle: () => app.exec(() => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].pop()?.querySelector("h2")?.innerText.trim() ?? null),
    dialogText: () => app.exec(() => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].pop()?.innerText.replace(/\s+/g, " ").trim() ?? null),
    waitDialog: (title, timeout = 10_000) => eventually(ui.dialogTitle, title, `dialog “${title}”`, timeout),
    noDialog: () => app.waitFor(() => app.exec(() => !document.querySelector('[role="dialog"], [role="alertdialog"]')), 10_000, { message: "dialog closed" }),
    /** A text field of the topmost dialog by its label. */
    field: (label) =>
      app.waitFor(
        () =>
          app.exec((wanted) => {
            const dialog = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].pop();
            const found = [...(dialog?.querySelectorAll("label[for]") ?? [])].find((node) => node.textContent.trim() === wanted);
            return found ? document.getElementById(found.htmlFor) : null;
          }, label),
        8000,
        { message: `field “${label}”` },
      ),
    fieldValue: async (label) => (await ui.field(label)).prop("value"),
    /** Replaces a field's text like a user: click, select all, type. */
    async fill(element, text) {
      await app.click(element);
      await app.press("Control+a", "Backspace");
      if (text) await app.type(element, text);
    },
    /** Checkbox (role=checkbox) of the topmost dialog by the start of its label. */
    checkbox: (label) =>
      app.waitFor(
        () =>
          app.exec((wanted) => {
            for (const box of document.querySelectorAll('[role="checkbox"]')) {
              const text = document.querySelector(`label[for="${box.id}"]`)?.textContent ?? "";
              if (text.startsWith(wanted)) return box;
            }
            return null;
          }, label),
        8000,
        { message: `checkbox “${label}”` },
      ),
    checked: async (label) => (await (await ui.checkbox(label)).attr("aria-checked")) === "true",
    /** A button of the topmost dialog by its visible text. */
    dialogButton: (text) =>
      app.waitFor(
        () =>
          app.exec((wanted) => {
            const dialog = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].pop();
            return [...(dialog?.querySelectorAll("button") ?? [])].find((el) => el.innerText.trim() === wanted) ?? null;
          }, text),
        8000,
        { message: `dialog button “${text}”` },
      ),
    /** Kind segment ("Feature" | "Release" | "Hotfix") in the start form. */
    async chooseKind(label) {
      const button = await app.waitFor(
        () => app.exec((root, wanted) => [...document.querySelectorAll(`${root} [aria-label="Type"] [role="radio"], ${root} [aria-label="Type"] button`)].find((el) => el.innerText.trim() === wanted) ?? null, DIALOG, label),
        8000,
        { message: `kind “${label}”` },
      );
      await app.click(button);
      await eventually(ui.selectedKind, label, `kind ${label} selected`, 5000);
    },
    selectedKind: () =>
      app.exec((root) => {
        const all = [...document.querySelectorAll(`${root} [aria-label="Type"] [role="radio"], ${root} [aria-label="Type"] button`)];
        return all.find((el) => el.getAttribute("aria-checked") === "true" || el.getAttribute("data-state") === "on" || el.getAttribute("data-state") === "checked")?.innerText.trim() ?? null;
      }, DIALOG),
    startInput: () => app.waitFor(`${DIALOG} form[data-gitflow-form="start"] input`, 8000),
    startBlocked: () => ui.attr('[data-action="gitflow-start"]', "aria-disabled"),
    /** Start through the open dialog with the mouse: kind, name, click. */
    async start(kindLabel, name) {
      await ui.chooseKind(kindLabel);
      await ui.fill(await ui.startInput(), name);
      await eventually(() => ui.note().then((text) => /^Created as /.test(text ?? "")), true, "name accepted");
      await eventually(ui.startBlocked, null, "“Start” is enabled");
      await app.click('[data-action="gitflow-start"]');
      await ui.noDialog();
    },
    /** Opens the finish dialog of the checked-out branch through the palette. */
    async finishChecked(title) {
      await ui.runCommand("git flow: finish checked", "gitflow.finish");
      await ui.waitDialog(title);
      await app.waitFor(ui.FINISH, 8000);
      await app.settle();
    },

    // ---- toasts ----------------------------------------------------------------------------
    toasts: () => app.exec(() => [...document.querySelectorAll("[data-toast]")].map((el) => ({ tone: el.getAttribute("data-toast"), text: el.innerText.replace(/\s+/g, " ").trim() }))),
    async waitToast(tone, pattern, timeout = 30_000) {
      return app.waitFor(async () => (await ui.toasts()).find((toast) => toast.tone === tone && pattern.test(toast.text))?.text ?? null, timeout, {
        message: `${tone} toast ${pattern}; present: ${JSON.stringify(await ui.toasts().catch(() => []))}`,
      });
    },
    /** Clicks a button inside the toast whose text matches. */
    async toastButton(pattern, label) {
      const button = await app.waitFor(
        () =>
          app.exec((source, wanted, flags) => {
            const re = new RegExp(source, flags);
            const toast = [...document.querySelectorAll("[data-toast]")].find((el) => re.test(el.innerText.replace(/\s+/g, " ")));
            return [...(toast?.querySelectorAll("button") ?? [])].find((el) => el.innerText.trim() === wanted) ?? null;
          }, pattern.source, label, pattern.flags),
        8000,
        { message: `toast button “${label}”` },
      );
      await app.click(button);
    },
    async closeToasts() {
      for (let round = 0; round < 15; round++) {
        const closed = await app.exec(() => {
          const button = document.querySelector('[data-toast] button[aria-label="Close message"]');
          if (!button) return false;
          button.click();
          return true;
        });
        if (!closed) break;
        await sleep(120);
      }
      await app.waitFor(() => app.exec(() => document.querySelectorAll("[data-toast]").length === 0), 5000, { message: "toasts closed" }).catch(() => undefined);
    },

    // ---- context menu ----------------------------------------------------------------------
    async contextMenu(css) {
      const point = await app.waitFor(
        () =>
          app.exec((selector) => {
            const el = document.querySelector(selector);
            if (!el) return null;
            el.scrollIntoView({ block: "nearest" });
            const box = el.getBoundingClientRect();
            return box.width ? { x: Math.round(box.left + Math.min(60, box.width / 2)), y: Math.round(box.top + box.height / 2) } : null;
          }, css),
        10_000,
        { message: `element ${css}` },
      );
      await app.webdriver("POST", "/actions", {
        actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", origin: "viewport", x: point.x, y: point.y }, { type: "pointerDown", button: 2 }, { type: "pointerUp", button: 2 }] }],
      });
      await app.webdriver("DELETE", "/actions").catch(() => undefined);
      await app.waitFor('[role="menu"]', 5000, { message: "context menu open" });
    },
    menuItems: () =>
      app.exec(() =>
        [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')].map((item) => ({
          text: item.innerText.replace(/\s+/g, " ").trim(),
          disabled: item.hasAttribute("data-disabled") || item.getAttribute("aria-disabled") === "true",
        })),
      ),
    async chooseMenu(pattern) {
      const items = await ui.menuItems();
      const index = items.findIndex((item) => pattern.test(item.text));
      if (index < 0) throw new AssertionError(`menu item ${pattern} missing; menu: ${items.map((item) => item.text).join(" | ")}`);
      const elements = await app.$$('[role="menu"] [role^="menuitem"]');
      await elements[index].click();
    },
  };
  return ui;
}
