import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The E2E driver (scripts/e2e/driver.mjs) starts its own server: a different port than
// `tauri dev`, and without HMR – otherwise a change by one agent would reload the pages of all
// running test instances in the middle of a test.
const e2ePort = Number(process.env.FORKYARD_E2E_PORT) || null;

/**
 * For scripts/e2e/screens/csp.mjs: the test server sends the Content-Security-Policy from
 * src-tauri/tauri.conf.json as a header, so that the UI can be checked under exactly this
 * policy (in the built app Tauri sets it itself). The only difference:
 * the Vite server is its own origin here, so its client may reach it.
 */
function testCsp(port: number | null): string | null {
  if (!process.env.FORKYARD_E2E_CSP || !port) return null;
  const config = JSON.parse(readFileSync(new URL("./src-tauri/tauri.conf.json", import.meta.url), "utf8")) as { app: { security: { csp: string } } };
  return config.app.security.csp.replace("connect-src ", `connect-src 'self' ws://127.0.0.1:${port} `);
}
const cspHeader = testCsp(e2ePort);

/**
 * For the WebDriver harness (scripts/e2e-wd): WebDriver cannot hook into a page before its own
 * scripts run, so the test server puts a small classic script in front of the app. It records
 * uncaught errors, unhandled rejections, console.error calls and failed resource loads in
 * `window.__gcE2E.errors` from the very first moment.
 */
const errorHook = Boolean(e2ePort && process.env.FORKYARD_E2E_ERROR_HOOK);
const ERROR_HOOK_SOURCE = `(() => {
  const errors = [];
  window.__gcE2E = { errors };
  const text = (value) => {
    if (value instanceof Error) return value.name + ": " + value.message + (value.stack ? "\\n" + value.stack : "");
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  };
  const original = console.error.bind(console);
  console.error = (...args) => { errors.push("[console] " + args.map(text).join(" ")); original(...args); };
  window.addEventListener("error", (event) => {
    const target = event.target;
    if (target && target !== window && (target.src || target.href)) errors.push("[request] " + (target.src || target.href));
    else errors.push("[pageerror] " + text(event.error || event.message));
  }, true);
  window.addEventListener("unhandledrejection", (event) => errors.push("[rejection] " + text(event.reason)));
})();`;

/** How the driver recognises that the server of this checkout is really answering on the port. */
const identity: Plugin = {
  name: "gc-identity",
  configureServer(server) {
    server.middlewares.use("/__gc_root", (_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ root: server.config.root, pid: process.pid, hmr: server.config.server.hmr !== false, errorHook }));
    });
    if (errorHook) {
      server.middlewares.use("/__gc_e2e_hook.js", (_request, response) => {
        response.setHeader("Content-Type", "text/javascript");
        response.end(ERROR_HOOK_SOURCE);
      });
    }
  },
  transformIndexHtml(html) {
    return errorHook ? html.replace("<head>", '<head>\n    <script src="/__gc_e2e_hook.js"></script>') : html;
  },
};

// Port 1420 and strictPort are the Tauri convention (devUrl in src-tauri/tauri.conf.json).
export default defineConfig({
  plugins: [react(), tailwindcss(), identity],
  clearScreen: false,
  // Separate cache, so that the test server and `tauri dev` do not rewrite each other's bundled dependencies.
  cacheDir: e2ePort ? (errorHook ? "node_modules/.vite-e2e-wd" : "node_modules/.vite-e2e") : "node_modules/.vite",
  server: {
    host: "127.0.0.1",
    port: e2ePort ?? 1420,
    strictPort: true,
    hmr: e2ePort ? false : undefined,
    headers: cspHeader ? { "Content-Security-Policy": cspHeader } : undefined,
    // Rust builds and test artefacts do not trigger a rebuild.
    watch: { ignored: ["**/target/**", "**/src-tauri/**", "**/crates/**"] },
  },
  test: { include: ["src/**/*.test.{ts,tsx}"] },
});
