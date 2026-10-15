/**
 * Fixtures for features/repos.mjs (open, clone, create, tabs, groups, profiles, trust).
 * Real Git repositories in temp folders; nothing touches the network or the user's data.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { makeCleanRepoWithRemote } from "../../e2e/fixtures.mjs";
export { makeWorkspace, fileUrl } from "../../e2e/screens/repo-entry-lib.mjs";

/** Marker files: if they appear, a command from the repository's configuration or hooks has run. */
export const FSMONITOR_MARKER = "FSMONITOR-RAN";
export const HOOK_MARKER = "HOOK-RAN";
export const PROXY_PASSWORD = "proxy-secret-4711";

/**
 * A repository as it would come from an extracted archive: `core.fsmonitor` runs a command on
 * every `git status`, a proxy with a password in it, and a post-checkout hook.
 */
export function makeForeignRepo(name) {
  const repo = makeCleanRepoWithRemote({ name });
  repo.git("config", "core.fsmonitor", `touch ${FSMONITOR_MARKER};:`);
  repo.git("config", "http.proxy", `http://anna:${PROXY_PASSWORD}@proxy.invalid:8080`);
  repo.git("config", "http.sslVerify", "false");
  const hooks = path.join(repo.path, ".git", "hooks");
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(path.join(hooks, "post-checkout"), `#!/bin/sh\ntouch ${HOOK_MARKER}\n`, { mode: 0o755 });
  return repo;
}

export const ran = (repo, marker) => fs.existsSync(path.join(repo.path, marker));

/**
 * Source for clones: a work repository with four commits on main and a second branch, plus its
 * bare copy (`source`). `count` = commits on main.
 */
export function makeCloneSource(ws, name = "wetterdaten") {
  const work = ws.repo(`${name}-arbeit`, { "README.md": `# ${name}\n`, "src/lesen.py": "print('lesen')\n", "docs/aufbau.md": "# Aufbau\n" });
  ws.commit(work, "src/lesen.py", "print('lesen 2')\n", "Lesen überarbeitet", "2026-01-10T12:00:00+01:00");
  ws.commit(work, "docs/aufbau.md", "# Aufbau\n\nMast und Logger.\n", "Aufbau beschrieben", "2026-02-10T12:00:00+01:00");
  ws.commit(work, "src/pruefen.py", "print('prüfen')\n", "Prüfung ergänzt", "2026-03-10T12:00:00+01:00");
  ws.git(work, "checkout", "-q", "-b", "entwicklung");
  ws.commit(work, "src/entwurf.py", "print('entwurf')\n", "Entwurf", "2026-03-20T12:00:00+01:00");
  ws.git(work, "checkout", "-q", "main");
  const source = ws.at(`${name}.git`);
  ws.git(ws.root, "clone", "-q", "--bare", work, source);
  return { work, source, count: Number(ws.git(source, "rev-list", "--count", "main")), head: ws.git(source, "rev-parse", "main") };
}

/**
 * HTTP proxy in front of scripts/e2e/git-http-server.mjs that signs in by itself (Basic auth
 * header) and holds the pack transfer (`POST …/git-upload-pack`) for `holdMs` – so a clone stays
 * running long enough to be cancelled, independent of machine speed.
 *   const proxy = await startHoldingProxy(server.url(""), { user: "lena", password: "…", holdMs: 30_000 });
 *   proxy.url("messnetz.git"); proxy.held; await proxy.close();
 */
export async function startHoldingProxy(base, { user, password, holdMs = 30_000 }) {
  const upstream = new URL(base);
  const auth = `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
  const timers = new Set();
  const state = { held: 0 };
  const server = http.createServer((request, response) => {
    const forward = () => {
      const outgoing = http.request(
        { host: upstream.hostname, port: upstream.port, method: request.method, path: request.url, headers: { ...request.headers, host: upstream.host, authorization: auth } },
        (answer) => {
          response.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(response);
        },
      );
      outgoing.on("error", () => response.destroy());
      request.pipe(outgoing);
    };
    if (request.method === "POST" && request.url.endsWith("/git-upload-pack")) {
      state.held += 1;
      request.pause();
      const timer = setTimeout(() => {
        timers.delete(timer);
        request.resume();
        forward();
      }, holdMs);
      timers.add(timer);
      request.on("close", () => {
        clearTimeout(timer);
        timers.delete(timer);
      });
    } else forward();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  return {
    get held() {
      return state.held;
    },
    url: (name) => `http://127.0.0.1:${port}/${name}`,
    close: () =>
      new Promise((resolve) => {
        for (const timer of timers) clearTimeout(timer);
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** Own empty folder for an app data directory that survives a restart. */
export function makeDataDir(prefix = "fy-wdrepos-data-") {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}
