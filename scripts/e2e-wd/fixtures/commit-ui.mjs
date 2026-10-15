/**
 * Helpers for features/commit.mjs: the commit panel ("Local changes") and the diff view of the
 * real app over WebDriver, plus byte-level Git reads in the fixture repositories.
 *
 * Everything that reads app state goes through the debug-only `window.__gc` (store, query cache);
 * everything that changes state goes through the UI (clicks, keys) unless a scenario says otherwise.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gitIsolationEnv, globalGitConfig } from "../../e2e/fixtures.mjs";
import { AssertionError } from "../lib.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Lines of Git output without empty ones. */
export const lines = (text) => String(text).split(/\r?\n/).filter(Boolean);

/** Writes bytes/text into the working directory of a fixture repository (creates folders). */
export function writeBytes(repo, rel, content) {
  const file = path.join(repo.path, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
export const readBytes = (repo, rel) => fs.readFileSync(path.join(repo.path, rel));
export const readText = (repo, rel) => fs.readFileSync(path.join(repo.path, rel), "utf8");

/** Raw git (Buffer output) in a fixture repository, isolated from the machine's configuration. */
export function gitRaw(repo, args, { input, config } = {}) {
  const globalConfig = config ?? path.join(repo.root, "gitconfig");
  if (!fs.existsSync(globalConfig)) fs.writeFileSync(globalConfig, globalGitConfig());
  return execFileSync("git", args, {
    cwd: repo.path,
    input,
    env: { ...process.env, ...gitIsolationEnv(globalConfig), GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}
/** The blob of `rel` in the index, byte-exact. */
export const indexBlob = (repo, rel) => gitRaw(repo, ["cat-file", "blob", `:${rel}`]);
export const hex = (value) => Buffer.from(value).toString("hex");

/** Parses `git diff --cached` of one file into hunks / added / removed lines. */
export function parseDiff(text) {
  const all = String(text).split("\n");
  return {
    hunks: all.filter((line) => line.startsWith("@@")).length,
    added: all.filter((line) => line.startsWith("+") && !line.startsWith("+++")).map((line) => line.slice(1)),
    removed: all.filter((line) => line.startsWith("-") && !line.startsWith("---")).map((line) => line.slice(1)),
  };
}

/** Polls `read()` until it equals `expected` (JSON); throws an AssertionError with the last value otherwise. */
export async function eventually(read, expected, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let actual;
  for (;;) {
    actual = await read();
    if (JSON.stringify(actual) === JSON.stringify(expected)) return actual;
    if (Date.now() > deadline) throw new AssertionError(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    await sleep(80);
  }
}

/** Polls `read()` until it is truthy; throws an AssertionError otherwise. */
export async function until(read, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new AssertionError(`${message} (timed out after ${timeoutMs} ms)`);
    await sleep(80);
  }
}

/** Driver for the commit panel and diff view of one app instance. */
export function commitUi(app) {
  const ui = {
    /** Status from the query cache of the UI (what the panel shows). */
    status: (repoId) => app.exec((id) => window.__gc.queryClient.getQueryData(["repo", id, "status"]) ?? null, repoId),
    async counts(repoId) {
      const data = await ui.status(repoId);
      return data ? { unstaged: data.unstaged.length, staged: data.staged.length, conflicted: data.conflicted.length } : null;
    },
    waitCounts: (repoId, expected, message = "list state", timeoutMs = 20_000) => eventually(() => ui.counts(repoId), expected, message, timeoutMs),
    /** File keys shown in a section ("unstaged" | "staged" | "conflicts"). */
    rows: (area) => app.exec((name) => [...document.querySelectorAll(`[data-section="${name}"] [data-row-key]`)].map((row) => row.dataset.rowKey), area),
    row: (area, file) => app.waitFor(`[data-section="${area}"] [data-row-key=${JSON.stringify(file)}]`, 15_000),
    /** Window focus makes the app re-read the working directory (the watcher may not have reported yet). */
    async refresh() {
      await app.exec(() => window.dispatchEvent(new Event("focus")));
      await app.settle();
    },
    summary: () => app.waitFor("input[data-commit-summary]"),
    description: () => app.waitFor('form textarea[aria-label="Description"]'),
    fields: () =>
      app.exec(() => ({
        summary: document.querySelector("input[data-commit-summary]")?.value ?? null,
        description: document.querySelector('form textarea[aria-label="Description"]')?.value ?? null,
      })),
    /** Replaces the text of a field the way a user does: click, select all, type. */
    async fill(element, text) {
      await app.click(element);
      await app.press("Control+a", "Backspace");
      if (text) await app.type(element, text);
    },
    /** Types multi-line text: WebDriver drops "\n", so each line break is an Enter key press. */
    async typeLines(element, text) {
      const parts = text.split("\n");
      for (const [index, part] of parts.entries()) {
        if (index > 0) await app.press("Enter");
        if (part) await app.type(element, part);
      }
    },
    commitButton: () => app.waitFor('form button[data-action="commit"]'),
    commitLabel: () => app.exec(() => document.querySelector('form button[data-action="commit"]')?.textContent?.trim() ?? null),
    commitBlocked: () => app.exec(() => document.querySelector('form button[data-action="commit"]')?.getAttribute("aria-disabled") === "true"),
    /** Radix checkbox of the commit form by the start of its label ("Amend last commit", "Push after commit" …). */
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
        10_000,
        { message: `checkbox "${label}"` },
      ),
    checked: async (label) => (await (await ui.checkbox(label)).attr("aria-checked")) === "true",
    /** Texts of the toasts of a tone, or of all. */
    toasts: (tone = null) => app.exec((which) => [...document.querySelectorAll(which ? `[data-toast="${which}"]` : "[data-toast]")].map((node) => node.innerText.replace(/\s+/g, " ").trim()), tone),
    async waitToast(tone, pattern, timeoutMs = 20_000) {
      return app.waitFor(async () => (await ui.toasts(tone)).find((text) => pattern.test(text)) ?? null, timeoutMs, {
        message: `toast (${tone}) matching ${pattern}; present: ${JSON.stringify(await ui.toasts().catch(() => []))}`,
      });
    },
    async closeToasts() {
      for (let round = 0; round < 12; round++) {
        const closed = await app.exec(() => {
          const button = document.querySelector('[data-toast] button[aria-label="Close message"]');
          if (!button) return false;
          button.click();
          return true;
        });
        if (!closed) return;
        await sleep(150);
      }
    },
    /** Alert text at the commit form (field validation). */
    formAlert: () => app.exec(() => document.querySelector('form [role="alert"]')?.innerText?.trim() ?? null),
    view: (tabId) => app.exec((id) => window.__gc.store.getState().views[id] ?? null, tabId),
    closeCenter: (tabId) => app.exec((id) => window.__gc.store.getState().closeCenter(id), tabId),
    selectWip: (tabId) => app.exec((id) => window.__gc.store.getState().selectWip(id), tabId),
    selectCommit: (tabId, sha) => app.exec((id, value) => window.__gc.store.getState().selectCommits(id, [value]), tabId, sha),
    focusedKey: () => app.exec(() => document.activeElement?.dataset?.rowKey ?? null),
    focusedLabel: () => app.exec(() => document.activeElement?.getAttribute("aria-label") ?? null),
    /** Presses Tab until `predicate` (runs in the page, gets document.activeElement and arg) holds. */
    async tabUntil(predicate, arg, max = 120) {
      const source = predicate.toString();
      for (let step = 0; step <= max; step++) {
        if (await app.exec((code, value) => Boolean(new Function("el", "arg", `return (${code})(el, arg)`)(document.activeElement, value)), source, arg)) return step;
        await app.press("Tab");
      }
      throw new AssertionError(`Tab does not reach the target: ${source.slice(0, 120)}`);
    },
    tabToList: (label) => ui.tabUntil((el, name) => Boolean(el?.closest(`[aria-label="${name}"]`) && el.hasAttribute("data-row-key")), label),
    tabToField: (label) => ui.tabUntil((el, name) => el?.getAttribute("aria-label") === name, label),

    // ---- diff view -------------------------------------------------------------------------
    /** Waits until the diff of `file` is open and loaded. */
    async diffReady(file, timeoutMs = 30_000) {
      await app.waitFor(
        () =>
          app.exec((label) => {
            const root = document.querySelector('[data-screen="diff"]');
            return root?.getAttribute("aria-label") === label && !root.querySelector("[data-diff-loading]");
          }, `Diff of ${file}`),
        timeoutMs,
        { message: `diff of ${file} loaded` },
      );
      await app.settle();
    },
    /** Click on the file row in the panel list opens its diff. */
    async openDiff(area, file) {
      const row = await ui.row(area, file);
      await app.exec((el) => el.scrollIntoView({ block: "nearest" }), row);
      await app.click(row);
      await ui.diffReady(file);
    },
    diffToken: () => app.exec(() => document.querySelector('[data-screen="diff"]')?.getAttribute("data-diff-token") ?? null),
    /** Waits until the diff was reloaded after a write (token changed) or closed / moved on. */
    async diffChanged(before, file) {
      await app.waitFor(
        () =>
          app.exec((old, label) => {
            const root = document.querySelector('[data-screen="diff"]');
            return !root || root.getAttribute("aria-label") !== label || root.getAttribute("data-diff-token") !== old;
          }, before, `Diff of ${file}`),
        20_000,
        { message: `diff of ${file} reloaded` },
      );
      await app.settle();
    },
    /** Rendered rows of the diff grid: { index, kind, selected, text }. */
    diffRows: () =>
      app.exec(() =>
        [...document.querySelectorAll('[data-screen="diff"] [data-diff-grid] [data-row][role="row"]')].map((row) => ({
          index: Number(row.dataset.row),
          kind: row.dataset.kind ?? (row.dataset.hunk !== undefined ? "hunk" : "other"),
          selected: row.getAttribute("aria-selected") === "true",
          text: (row.querySelector(".selectable")?.textContent ?? row.textContent ?? "").replace(/​/g, ""),
        })),
      ),
    async changedRows() {
      return (await ui.diffRows()).filter((row) => row.kind === "add" || row.kind === "remove").map((row) => `${row.kind === "add" ? "+" : "-"}${row.text}`);
    },
    async selectedRows() {
      return (await ui.diffRows()).filter((row) => row.selected).map((row) => `${row.kind === "add" ? "+" : "-"}${row.text}`);
    },
    hunkHeads: () => app.exec(() => [...document.querySelectorAll('[data-screen="diff"] [data-diff-grid] [data-hunk]')].map((head) => head.innerText.replace(/\s+/g, " ").trim())),
    /** The line-number cell (gutter) of the changed row `kind` ("add" | "remove") with text `text`. */
    gutter: (kind, text) =>
      app.waitFor(
        () =>
          app.exec((wantedKind, wantedText) => {
            for (const row of document.querySelectorAll(`[data-screen="diff"] [data-diff-grid] [data-row][data-kind="${wantedKind}"]`)) {
              const value = (row.querySelector(".selectable")?.textContent ?? "").replace(/​/g, "");
              if (value === wantedText) return row.querySelector("[data-gutter]");
            }
            return null;
          }, kind, text),
        10_000,
        { message: `gutter of ${kind} line "${text}"` },
      ),
    /** Button inside the selection bar of the diff by its exact text ("Stage 2 lines" …). */
    selectionButton: (label) => app.waitFor(() => app.byText(label, { within: "[data-selection-bar]" }), 10_000, { message: `selection bar button "${label}"` }),
    /** Button "Stage hunk"/"Unstage hunk" of hunk `index` (0-based). */
    hunkButton: (index, label) =>
      app.waitFor(
        () => app.exec((at, text) => [...(document.querySelector(`[data-screen="diff"] [data-hunk="${at}"]`)?.querySelectorAll("button") ?? [])].find((button) => (button.getAttribute("aria-label") ?? button.textContent ?? "").trim() === text) ?? null, index, label),
        10_000,
        { message: `"${label}" of hunk ${index}` },
      ),

    /** Click with Shift held (W3C actions: key and pointer source in parallel). */
    async shiftClick(element) {
      await app.webdriver("POST", "/actions", {
        actions: [
          { type: "key", id: "kb", actions: [{ type: "keyDown", value: "" }, { type: "pause", duration: 0 }, { type: "pause", duration: 0 }, { type: "pause", duration: 0 }, { type: "keyUp", value: "" }] },
          {
            type: "pointer",
            id: "mouse",
            parameters: { pointerType: "mouse" },
            actions: [
              { type: "pause", duration: 0 },
              { type: "pointerMove", duration: 0, origin: { "element-6066-11e4-a52e-4f735466cecf": element.id }, x: 0, y: 0 },
              { type: "pointerDown", button: 0 },
              { type: "pointerUp", button: 0 },
              { type: "pause", duration: 0 },
            ],
          },
        ],
      });
      await app.webdriver("DELETE", "/actions").catch(() => undefined);
    },
    /** Element has no horizontal overflow and the page neither. */
    overflow: () =>
      app.exec(() => {
        const root = document.documentElement;
        const side = document.querySelector('[data-screen="commit-panel"]');
        return { page: root.scrollWidth - root.clientWidth, panel: side ? side.scrollWidth - side.clientWidth : 0 };
      }),
  };
  return ui;
}
