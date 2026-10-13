/**
 * Shared helpers for the A flow tests (A-F01.mjs, A-F02.mjs, A-F17.mjs, A-F18.mjs):
 * test harness with one section per test case, green/red list at the end, a section fails on
 * console errors, screenshot to target/e2e/bugs/<ID>.png for sections with a known bug,
 * accessibility check (axe-core and names of all controls), slow and silent network proxies,
 * file permissions on Windows.
 *
 *   const t = createFlowRun("A-F02");
 *   t.attach(app);                                   // after launchApp
 *   await t.section("F02-E9 double Enter", async () => { … t.check(…) … });
 *   await t.section("F02-E11 …", async () => { … }, { bug: "A-03" });   // red section = test for bug A-03
 *   t.finish();                                      // green/red list, exit code
 *
 * Run:  node scripts/e2e/flows/A-F02.mjs [--show] [--only <part>[,<part>]]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { ROOT } from "../driver.mjs";

// Reading git calls of the checks must not take index.lock (otherwise "locked" in the app).
process.env.GIT_OPTIONAL_LOCKS = "0";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const BUG_SHOTS = "target/e2e/bugs";

export function createFlowRun(name, { argv = process.argv.slice(2) } = {}) {
  const failures = [];
  const green = [];
  const red = [];
  const skipped = [];
  const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1].split(",").map((part) => part.toLowerCase()) : null;
  let current = "";
  let app = null;
  let page = null;

  const check = (condition, message) => {
    if (!condition) {
      failures.push(`${current}: ${message}`);
      console.log(`  ✗ ${message}`);
    }
    return Boolean(condition);
  };
  const equal = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  const note = (text) => console.log(`  · ${text}`);

  const toasts = () =>
    page.locator("[data-toast]").evaluateAll((list) => list.map((item) => ({ tone: item.getAttribute("data-toast"), text: item.innerText.replace(/\s+/g, " ").trim() })));

  const eventually = async (read, expected, message, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    const matches = (value) => (typeof expected === "function" ? expected(value) : JSON.stringify(value) === JSON.stringify(expected));
    const attempt = async () => {
      try {
        return await read();
      } catch (error) {
        return `Error: ${String(error?.message ?? error).split("\n")[0]}`;
      }
    };
    let actual = await attempt();
    while (!matches(actual) && Date.now() < deadline) {
      await sleep(80);
      actual = await attempt();
    }
    if (matches(actual)) return true;
    const shown = page ? await toasts().catch(() => []) : [];
    return check(false, `${message}: ${typeof expected === "function" ? "condition not met" : `expected ${JSON.stringify(expected)}`}, got ${JSON.stringify(actual)}${shown.length ? ` – toasts: ${JSON.stringify(shown)}` : ""}`);
  };

  const closeToasts = async () => {
    for (let round = 0; round < 12 && (await page.locator("[data-toast]").count()) > 0; round++) {
      await page.getByRole("button", { name: "Close message" }).first().click({ timeout: 2000 }).catch(() => undefined);
      await sleep(80);
    }
  };
  const waitToast = async (pattern, tone = null, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = (await toasts()).find((toast) => pattern.test(toast.text) && (!tone || toast.tone === tone));
      if (hit) return hit;
      if (Date.now() > deadline) {
        check(false, `toast ${pattern}${tone ? ` (${tone})` : ""} missing; present: ${JSON.stringify(await toasts())}`);
        return null;
      }
      await sleep(80);
    }
  };

  const dialog = () => page.getByRole("dialog");
  const dialogTitle = () => page.evaluate(() => Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).at(-1)?.querySelector("h2")?.textContent?.trim() ?? null);
  const waitDialog = async (pattern, timeoutMs = 20_000) => {
    await eventually(dialogTitle, (title) => title !== null && typeof title === "string" && pattern.test(title), `Dialog ${pattern}`, timeoutMs);
    return page.locator('[role="dialog"], [role="alertdialog"]').last();
  };
  /** What has focus – and is it visible (outline, ring or text caret)? */
  const focused = () =>
    page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { text: "", label: null, tag: "BODY", role: null, visible: false };
      const ring = (target) => {
        const style = getComputedStyle(target);
        return (style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0) || (style.boxShadow !== "none" && style.boxShadow !== "");
      };
      const framed = el.closest("label, [data-field]");
      const isText = el.tagName === "INPUT" || el.tagName === "TEXTAREA";
      return {
        text: (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 80),
        label: el.getAttribute("aria-label") ?? el.labels?.[0]?.textContent ?? null,
        tag: el.tagName,
        role: el.getAttribute("role"),
        visible: ring(el) || (framed ? ring(framed) : false) || (isText && getComputedStyle(el).caretColor !== "transparent"),
      };
    });
  const overflow = () =>
    page.evaluate(() => ({ x: document.documentElement.scrollWidth - document.documentElement.clientWidth, y: document.documentElement.scrollHeight - document.documentElement.clientHeight }));

  const shot = async (file) => {
    if (!app) return null;
    await page.waitForTimeout(150).catch(() => undefined);
    return app.screenshot(file).catch(() => null);
  };

  /**
   * One section = one test case (or a few related ones). `bug`: ID of the reported bug –
   * if the section fails, target/e2e/bugs/<ID>.png is written (unless the section took one itself).
   * `keep`: leave open dialogs and toasts. `skip`: reason why the section does not run.
   */
  const section = async (title, run, { bug = null, keep = false, skip = null } = {}) => {
    if (only && !only.some((part) => title.toLowerCase().includes(part))) return;
    if (skip) {
      skipped.push(`${title} – not run: ${skip}`);
      console.log(`– ${title} (not run: ${skip})`);
      return;
    }
    current = title;
    const before = failures.length;
    const started = Date.now();
    try {
      await run();
    } catch (error) {
      check(false, `aborted: ${error?.stack ?? error}`);
    }
    if (app && page) {
      if (app.consoleErrors.length) {
        check(false, `console errors:\n${app.consoleErrors.join("\n")}`);
        app.consoleErrors.length = 0;
      }
      const failed = failures.length !== before;
      if (failed) {
        const target = bug ? `${BUG_SHOTS}/${bug}.png` : `target/e2e/${name}-failure-${title.replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 50)}.png`;
        if (!(bug && sectionShots.has(bug))) await shot(target);
      }
      try {
        if (!keep || failed) {
          for (let round = 0; round < 5 && (await page.locator('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]').count()) > 0; round++) {
            await page.keyboard.press("Escape");
            await sleep(150);
          }
          await closeToasts();
        }
      } catch {
        // the app is already closed
      }
    }
    const failed = failures.length !== before;
    (failed ? red : green).push(bug && failed ? `${title}  [BUG ${bug}]` : title);
    console.log(`${failed ? "✗" : "✓"} ${title} (${((Date.now() - started) / 1000).toFixed(1)} s)${failed && bug ? `  → BUG ${bug}` : ""}`);
  };
  const sectionShots = new Set();
  /** Capture evidence of a bug right away (before the section cleans up). */
  const bugShot = async (bug) => {
    sectionShots.add(bug);
    return shot(`${BUG_SHOTS}/${bug}.png`);
  };

  const finish = () => {
    console.log(`\n===== ${name} =====`);
    console.log(`Green sections (${green.length}):`);
    for (const title of green) console.log(`  ✓ ${title}`);
    console.log(`Red sections (${red.length}):`);
    for (const title of red) console.log(`  ✗ ${title}`);
    if (skipped.length) {
      console.log(`Not run (${skipped.length}):`);
      for (const title of skipped) console.log(`  – ${title}`);
    }
    if (failures.length) console.log(`\nDeviations:\n${failures.map((line) => `- ${line}`).join("\n")}`);
    console.log(failures.length ? `\n${name}: ${red.length} red sections, ${failures.length} deviations.` : `\n${name}: green.`);
    process.exit(failures.length ? 1 : 0);
  };

  return {
    name,
    failures,
    green,
    red,
    attach(next) {
      app = next;
      page = next?.page ?? null;
    },
    get app() {
      return app;
    },
    get page() {
      return page;
    },
    check,
    equal,
    note,
    eventually,
    toasts,
    closeToasts,
    waitToast,
    dialog,
    dialogTitle,
    waitDialog,
    focused,
    overflow,
    shot,
    bugShot,
    section,
    finish,
  };
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

/** Show the management tab (activate the existing one or open one). */
export async function showManagement(app) {
  const tabs = await app.invoke("tabs_list");
  const existing = tabs.find((tab) => tab.kind === "management");
  if (existing) await app.invoke("tab_activate", { tabId: existing.id });
  else await app.invoke("tab_open", { repoId: null });
  await app.page.locator('[data-screen="repo-management"]').waitFor();
  await app.settle();
}

export const activeTab = async (app) => (await app.invoke("tabs_list")).find((tab) => tab.isActive) ?? null;

/** Closes all repository tabs (the management tab stays or is created). */
export async function closeRepoTabs(app) {
  for (const tab of await app.invoke("tabs_list")) {
    if (tab.kind === "repo") await app.invoke("tab_close", { tabId: tab.id }).catch(() => undefined);
  }
  await showManagement(app);
}

/** Triggers a window focus change (the app then re-reads the repository state). */
export const windowFocus = (app) => app.page.evaluate(() => window.dispatchEvent(new Event("focus")));

/** Graph rows as loaded by the UI: [{ kind, sha, … }]. */
export const loadedRows = (app, repoId) =>
  app.page.evaluate((id) => (window.__gc.queryClient.getQueryData(["repo", id, "graph"])?.pages ?? []).flatMap((page) => page.rows ?? []), repoId);

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

let axeSource = null;

/**
 * Checks an area of the page: axe-core (WCAG 2 A/AA; colour contrast only as a note – the design
 * system checks it on the tokens) and additionally that every control has a name.
 * Returns { serious: [..], minor: [..], unnamed: [..] } – `serious` and `unnamed` should be empty.
 */
export async function a11yAudit(page, scope) {
  if (axeSource === null) axeSource = fs.readFileSync(path.join(ROOT, "node_modules", "axe-core", "axe.min.js"), "utf8");
  if (!(await page.evaluate(() => Boolean(window.axe)))) await page.evaluate(axeSource);
  const result = await page.evaluate(async (selector) => {
    const root = document.querySelector(selector);
    if (!root) return { missing: true };
    const run = await window.axe.run(root, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] });
    const violations = run.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.slice(0, 4).map((node) => node.html.replace(/\s+/g, " ").slice(0, 160)),
    }));
    // Own check: every visible control has a name (text, aria-label, aria-labelledby, label).
    const nameOf = (el) => {
      const labelled = (el.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      return (el.getAttribute("aria-label") ?? "").trim() || labelled.trim() || (el.labels?.[0]?.textContent ?? "").trim() || (el.textContent ?? "").trim() || (el.getAttribute("title") ?? "").trim() || (el.getAttribute("placeholder") ?? "").trim();
    };
    const unnamed = [];
    for (const el of root.querySelectorAll('button, a[href], input, textarea, select, [role="button"], [role="checkbox"], [role="switch"], [role="combobox"], [role="tab"], [role="option"], [role="menuitem"], [role="radio"]')) {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height || el.closest("[aria-hidden='true']") || el.getAttribute("type") === "hidden") continue;
      if (!nameOf(el)) unnamed.push(el.outerHTML.replace(/\s+/g, " ").slice(0, 160));
    }
    return { violations, unnamed };
  }, scope);
  if (result.missing) return { serious: [`area ${scope} missing`], minor: [], unnamed: [] };
  const line = (violation) => `${violation.id} (${violation.impact}): ${violation.help} – ${violation.nodes.join(" | ")}`;
  return {
    serious: result.violations.filter((violation) => violation.id !== "color-contrast" && (violation.impact === "serious" || violation.impact === "critical")).map(line),
    minor: result.violations.filter((violation) => violation.id === "color-contrast" || (violation.impact !== "serious" && violation.impact !== "critical")).map(line),
    unnamed: result.unnamed,
  };
}

/** a11yAudit as a check: `serious` and `unnamed` must be empty; the rest is only reported. */
export async function checkA11y(t, scope, where) {
  const audit = await a11yAudit(t.page, scope);
  t.equal(audit.serious, [], `${where}: axe finds no serious violations`);
  t.equal(audit.unnamed, [], `${where}: every control has a name`);
  for (const line of audit.minor) t.note(`${where}, axe note: ${line}`);
  return audit;
}

// ---------------------------------------------------------------------------
// Network: slow and silent proxy
// ---------------------------------------------------------------------------

/**
 * TCP proxy in front of a local server: `connectDelayMs` waits before connecting,
 * `bytesPerSecond` throttles the server's responses (null = unthrottled).
 */
export async function startSlowProxy(targetPort, { connectDelayMs = 0, bytesPerSecond = null } = {}) {
  const sockets = new Set();
  let connections = 0;
  let forwarded = 0;
  const server = net.createServer((client) => {
    connections += 1;
    sockets.add(client);
    client.on("close", () => sockets.delete(client));
    client.on("error", () => undefined);
    client.pause();
    setTimeout(() => {
      const upstream = net.connect(targetPort, "127.0.0.1");
      sockets.add(upstream);
      upstream.on("close", () => {
        sockets.delete(upstream);
        client.end();
      });
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
      client.pipe(upstream);
      client.resume();
      if (!bytesPerSecond) {
        upstream.on("data", (chunk) => {
          forwarded += chunk.length;
        });
        upstream.pipe(client);
        return;
      }
      // Throttle: forward in 50 ms slices.
      const slice = Math.max(1, Math.floor(bytesPerSecond / 20));
      const queue = [];
      let ended = false;
      upstream.on("data", (chunk) => {
        queue.push(chunk);
        if (queue.length > 64) upstream.pause();
      });
      upstream.on("end", () => {
        ended = true;
      });
      const timer = setInterval(() => {
        if (client.destroyed) return clearInterval(timer);
        let budget = slice;
        while (budget > 0 && queue.length) {
          const head = queue[0];
          if (head.length <= budget) {
            client.write(head);
            forwarded += head.length;
            budget -= head.length;
            queue.shift();
          } else {
            client.write(head.subarray(0, budget));
            forwarded += budget;
            queue[0] = head.subarray(budget);
            budget = 0;
          }
        }
        if (queue.length < 32) upstream.resume();
        if (ended && !queue.length) {
          clearInterval(timer);
          client.end();
        }
      }, 50);
      client.on("close", () => clearInterval(timer));
    }, connectDelayMs);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    connections: () => connections,
    forwarded: () => forwarded,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

/** Server that accepts connections and never answers. */
export async function startBlackHole() {
  const sockets = new Set();
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.on("data", () => undefined);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: server.address().port,
    connections: () => connections,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

// ---------------------------------------------------------------------------
// File system and processes
// ---------------------------------------------------------------------------

const windowsUser = () => `${process.env.USERDOMAIN ?? ""}\\${process.env.USERNAME ?? ""}`.replace(/^\\/, "");

/**
 * Denies the current user write access to a folder (Windows: icacls deny, otherwise chmod).
 * Returns a function that restores the right – always call it, otherwise the folder cannot be deleted.
 */
export function denyWrite(dir) {
  if (process.platform === "win32") {
    // (WD) = create/write files, (AD) = create subfolders/append; inherited by everything below.
    // Not the combined right (W): it would also take SYNCHRONIZE and with it every open of the folder.
    execFileSync("icacls", [dir, "/deny", `${windowsUser()}:(OI)(CI)(WD,AD)`], { stdio: "ignore", windowsHide: true });
    return () => execFileSync("icacls", [dir, "/remove:d", windowsUser()], { stdio: "ignore", windowsHide: true });
  }
  const mode = fs.statSync(dir).mode;
  fs.chmodSync(dir, 0o555);
  return () => fs.chmodSync(dir, mode);
}

/** Denies the current user read access to a folder and its contents. Returns the undo. */
export function denyRead(dir) {
  if (process.platform === "win32") {
    execFileSync("icacls", [dir, "/deny", `${windowsUser()}:(OI)(CI)(RX)`], { stdio: "ignore", windowsHide: true });
    return () => execFileSync("icacls", [dir, "/remove:d", windowsUser()], { stdio: "ignore", windowsHide: true });
  }
  const mode = fs.statSync(dir).mode;
  fs.chmodSync(dir, 0o000);
  return () => fs.chmodSync(dir, mode);
}

/** Running git processes whose command line contains `needle` (Windows: via PowerShell/CIM). */
export function gitProcessesWith(needle) {
  if (process.platform !== "win32") {
    try {
      return execFileSync("pgrep", ["-fl", needle]).toString("utf8").split("\n").filter((line) => /git/.test(line));
    } catch {
      return [];
    }
  }
  try {
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-Command", "Get-CimInstance Win32_Process -Filter \"Name like 'git%'\" | ForEach-Object { \"$($_.ProcessId)`t$($_.CommandLine)\" }"],
      { windowsHide: true, timeout: 30_000 },
    ).toString("utf8");
    return out.split(/\r?\n/).filter((line) => line.includes(needle));
  } catch {
    return [];
  }
}

/** Kills the processes from `gitProcessesWith` (lines "PID<Tab>command line") including children. Returns the count. */
export function killProcesses(lines) {
  let killed = 0;
  for (const line of lines) {
    const pid = Number(String(line).trim().split(/\s+/)[0]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      else process.kill(pid, "SIGKILL");
      killed += 1;
    } catch {
      // already gone
    }
  }
  return killed;
}

/**
 * Asks the app to close – just like clicking the close button or Alt+F4: WM_CLOSE to the main
 * window (window class "Tauri Window"), even when it is invisible in the test. Returns whether a
 * window was found. (taskkill without /F does not reach the invisible window.)
 */
export function requestWindowClose(pid) {
  if (process.platform !== "win32") {
    process.kill(pid, "SIGTERM");
    return true;
  }
  const script = `
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class GcClose {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  public static int Close(uint want) {
    int sent = 0;
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == want) { var c = new StringBuilder(256); GetClassName(h, c, 256); if (c.ToString() == "Tauri Window") { PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); sent++; } } return true; }, IntPtr.Zero);
    return sent;
  }
}
"@
[GcClose]::Close(${Number(pid)})
`;
  try {
    const sent = execFileSync("powershell", ["-NoProfile", "-Command", script], { windowsHide: true, timeout: 30_000 }).toString("utf8").trim();
    return Number(sent) > 0;
  } catch {
    return false;
  }
}

/** file:// URL of a local folder (with three slashes for Git on Windows). */
export function fileUrl(dir) {
  const normal = dir.replaceAll("\\", "/");
  return normal.startsWith("/") ? `file://${normal}` : `file:///${normal}`;
}
