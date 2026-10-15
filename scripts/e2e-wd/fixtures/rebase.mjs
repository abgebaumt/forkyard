/**
 * Fixtures for features/rebase.mjs: small real Git repositories in a temp folder, with fixed
 * identity and dates (isolated from the user's Git config), plus WebDriver helpers that the
 * rebase feature needs beyond the driver API (right-click, toasts, store access).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitIsolationEnv, globalGitConfig, TEST_IDENTITY } from "../../e2e/fixtures.mjs";

const live = new Set();
process.on("exit", () => {
  for (const dir of live) fs.rmSync(dir, { recursive: true, force: true });
});

let clock = 1780000000;

/** A fresh repository on branch main. */
export function makeRepo(name) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `fy-wd-rebase-${name}-`)));
  live.add(root);
  const config = path.join(root, "gitconfig");
  fs.writeFileSync(config, globalGitConfig());
  const repoPath = path.join(root, name);
  fs.mkdirSync(repoPath, { recursive: true });
  const run = (cwd, args, { allowFail = false } = {}) => {
    clock += 600;
    const when = `${clock} +0100`;
    try {
      return execFileSync("git", args, {
        cwd,
        env: {
          ...process.env,
          ...gitIsolationEnv(config),
          GIT_OPTIONAL_LOCKS: "0",
          GIT_AUTHOR_NAME: TEST_IDENTITY.name,
          GIT_AUTHOR_EMAIL: TEST_IDENTITY.email,
          GIT_AUTHOR_DATE: when,
          GIT_COMMITTER_NAME: TEST_IDENTITY.name,
          GIT_COMMITTER_EMAIL: TEST_IDENTITY.email,
          GIT_COMMITTER_DATE: when,
          GIT_EDITOR: "true",
          GIT_SEQUENCE_EDITOR: "true",
        },
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf8",
      }).replace(/\n$/, "");
    } catch (error) {
      if (allowFail) return `${error.stdout ?? ""}${error.stderr ?? ""}`;
      throw new Error(`git ${args.join(" ")} failed in ${cwd}:\n${error.stdout ?? ""}${error.stderr ?? ""}`);
    }
  };
  run(repoPath, ["init", "-q", "-b", "main"]);
  run(repoPath, ["config", "user.name", TEST_IDENTITY.name]);
  run(repoPath, ["config", "user.email", TEST_IDENTITY.email]);
  const repo = {
    path: repoPath,
    root,
    git: (...args) => run(repoPath, args),
    gitMay: (...args) => run(repoPath, args, { allowFail: true }),
    gitIn: (cwd, ...args) => run(cwd, args),
    write(file, content) {
      const target = path.join(repoPath, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    },
    read: (file) => (fs.existsSync(path.join(repoPath, file)) ? fs.readFileSync(path.join(repoPath, file), "utf8") : null),
    exists: (file) => fs.existsSync(path.join(repoPath, file)),
    commit(file, content, message) {
      repo.write(file, content);
      repo.git("add", "-A");
      repo.git("commit", "-q", "-m", message);
      return repo.git("rev-parse", "HEAD");
    },
    tip: (ref = "HEAD") => run(repoPath, ["rev-parse", ref]),
    subjects: (range) => run(repoPath, ["log", "--reverse", "--format=%s", range]).split("\n").filter(Boolean),
    rebaseRunning: () => fs.existsSync(path.join(repoPath, ".git", "rebase-merge")) || fs.existsSync(path.join(repoPath, ".git", "rebase-apply")),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
      live.delete(root);
    },
  };
  repo.commit("README.md", "# Messnetz\n\nAuswertung der Schulstationen.\n", "Projekt angelegt");
  return repo;
}

/** Branch thema/plan with five commits on main – basis for reorder, squash, drop. */
export function planRepo(name = "rebase-plan") {
  const repo = makeRepo(name);
  const base = repo.tip("main");
  repo.git("checkout", "-q", "-b", "thema/plan");
  const c = {
    c1: repo.commit("sensoren.txt", "Nord\nSüd\nHafen\n", "Sensorliste ergänzt"),
    c2: repo.commit("README.md", "# Messnetz\n\nAuswertung der Schul-Stationen.\n", "Tippfehler im README"),
    c3: repo.commit("export.txt", "Zwischenstand\n", "Zwischenstand Export"),
    c4: repo.commit("export.txt", "fertig\n", "Export fertig"),
    c5: repo.commit("debug.txt", "print(werte)\n", "Debug-Ausgabe"),
  };
  return { repo, base, c };
}

/**
 * Stacked branches: main ← teil (t1, t2) ← thema (t3); main moved on (m1).
 * Rebasing thema onto main can move "teil" along (it points into main..thema).
 */
export function stackRepo(name = "rebase-stapel") {
  const repo = makeRepo(name);
  const base = repo.tip("main");
  repo.git("checkout", "-q", "-b", "teil");
  const t1 = repo.commit("teil/a.txt", "a\n", "Teil A angelegt");
  const t2 = repo.commit("teil/b.txt", "b\n", "Teil B angelegt");
  repo.git("checkout", "-q", "-b", "thema");
  const t3 = repo.commit("thema/c.txt", "c\n", "Thema C auf Teil");
  repo.git("checkout", "-q", "main");
  const m1 = repo.commit("main.txt", "main\n", "Main weiter");
  repo.git("checkout", "-q", "thema");
  return { repo, base, t1, t2, t3, m1 };
}

// ---------------------------------------------------------------------------
// App helpers
// ---------------------------------------------------------------------------

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

/**
 * Right-click on an element: the pointer moves there (real WebDriver action), then the element
 * gets pointerdown/mousedown/contextmenu with button 2 at its centre. A real button-2 action is
 * avoided on purpose: after pointerDown/Up with button 2, WebKitWebDriver (Xvfb) types every
 * later key without Shift and drops non-ASCII characters for the rest of the session.
 */
export async function rightClick(app, element) {
  await app.exec((el) => el.scrollIntoView({ block: "center" }), element);
  await app.webdriver("POST", "/actions", {
    actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", origin: { [ELEMENT_KEY]: element.id }, x: 0, y: 0, duration: 0 }] }],
  });
  await app.exec((el) => {
    const box = el.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, composed: true, clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, button: 2, buttons: 2, view: window };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...at, pointerType: "mouse", pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mousedown", at));
    el.dispatchEvent(new PointerEvent("pointerup", { ...at, buttons: 0, pointerType: "mouse", pointerId: 1, isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { ...at, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("contextmenu", at));
  }, element);
}

/** Visible toasts: [{ tone, text }]. */
export const toasts = (app) =>
  app.exec(() => [...document.querySelectorAll("[data-toast]")].map((item) => ({ tone: item.getAttribute("data-toast"), text: item.innerText.replace(/\s+/g, " ").trim() })));

/** Waits for a toast whose text matches; returns it. */
export async function waitToast(app, pattern, tone = null, timeout = 30_000) {
  return app.waitFor(async () => (await toasts(app)).find((toast) => pattern.test(toast.text) && (!tone || toast.tone === tone)) ?? null, timeout, {
    message: `toast ${pattern}${tone ? ` (${tone})` : ""}`,
  }).catch(async (error) => {
    throw new Error(`${error.message}; present: ${JSON.stringify(await toasts(app))}`);
  });
}

export async function closeToasts(app) {
  for (let round = 0; round < 12; round++) {
    const button = await app.exec(() => document.querySelector('[data-toast] button[aria-label="Close message"]'));
    if (!button) return;
    await app.click(button).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** The center view of a tab ({ kind, base, mode, shas } for the rebase tool). */
export const center = (app, tabId) => app.exec((id) => window.__gc.store.getState().views[id]?.center ?? { kind: "graph" }, tabId);
export const selection = (app, tabId) => app.exec((id) => window.__gc.store.getState().views[id]?.selection ?? { kind: "wip" }, tabId);

/** Rows of the rebase list in DOM order. */
export const rebaseRows = (app) =>
  app.exec(() =>
    [...document.querySelectorAll('[data-screen="rebase"] [role="option"]')]
      .map((row) => ({
        index: Number(row.dataset.index),
        sha: row.dataset.rowSha,
        action: row.querySelector("[data-action]")?.getAttribute("data-action") ?? null,
        summary: row.querySelector("[data-summary]")?.textContent ?? "",
      }))
      .sort((a, b) => a.index - b.index),
  );

/** Tells the app the window got focus (it reloads status/refs as after a terminal change). */
export const nudge = (app) => app.exec(() => window.dispatchEvent(new Event("focus")));

/** Moves the mouse out of the way (no hover tooltips in screenshots). */
export async function parkMouse(app) {
  await app.webdriver("POST", "/actions", {
    actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [{ type: "pointerMove", origin: "viewport", x: 2, y: 2, duration: 0 }] }],
  });
  await app.webdriver("DELETE", "/actions").catch(() => undefined);
}
