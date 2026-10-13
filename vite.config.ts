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

/** How the driver recognises that the server of this checkout is really answering on the port. */
const identity: Plugin = {
  name: "gc-identity",
  configureServer(server) {
    server.middlewares.use("/__gc_root", (_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ root: server.config.root, pid: process.pid, hmr: server.config.server.hmr !== false }));
    });
  },
};

// Port 1420 and strictPort are the Tauri convention (devUrl in src-tauri/tauri.conf.json).
export default defineConfig({
  plugins: [react(), tailwindcss(), identity],
  clearScreen: false,
  // Separate cache, so that the test server and `tauri dev` do not rewrite each other's bundled dependencies.
  cacheDir: e2ePort ? "node_modules/.vite-e2e" : "node_modules/.vite",
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
