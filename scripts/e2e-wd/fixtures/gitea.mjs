/**
 * A local Gitea/Forgejo instance for the WebDriver E2E tests: ONE address on 127.0.0.1 that answers
 * the REST API (`/api/v1/…`, from scripts/e2e/host-mock.mjs) and serves the repository `octo/demo`
 * over Git smart HTTP (`/octo/demo.git/…`, forwarded to scripts/e2e/git-http-server.mjs with its
 * login added). The app gets this address as a self-hosted instance, and the test repository's
 * `origin` points to the same address – so fetch, push and "Check out branch" really run.
 * Nothing calls a real service.
 *
 *   const repo = makeCleanRepoWithRemote({ name: "demo" });
 *   const gitea = await startGitea(repo);
 *   gitea.base        http://127.0.0.1:<port> – the instance address
 *   gitea.token / gitea.weakToken
 *   gitea.mock        the host mock (requests, state, fail(), recover(), reset())
 *   gitea.remoteUrl   http://127.0.0.1:<port>/octo/demo.git (already set as `origin` of the repo)
 *   gitea.serverGit("rev-parse", "refs/heads/main")   git in the bare repository on the server
 *   gitea.sha         { main, login, fork }  – heads of main, feature/login (PR #7), refs/pull/8/head (PR #8)
 *   await gitea.close()
 *
 * The server repository gets the branches the mock's pull requests name: `feature/login` (PR #7,
 * same repository) and `refs/pull/8/head` (PR #8 from a fork). Both are written by pushing to the
 * bare repository's PATH, never over HTTP: the Git server runs in this process, a synchronous git
 * call against it would block forever.
 */
import http from "node:http";
import { startHostMock } from "../../e2e/host-mock.mjs";
import { startGitHttpServer } from "../../e2e/git-http-server.mjs";

const GIT_USER = "lena";
const GIT_PASSWORD = "nur-fuer-den-testserver";
const FULL = "octo/demo";
const BARE = "demo.git";

export async function startGitea(repo) {
  const mock = await startHostMock();
  const git = await startGitHttpServer({ users: { [GIT_USER]: GIT_PASSWORD } });
  const bareDir = git.createBare(BARE, { from: repo.path });
  const serverGit = (...args) => git.git(BARE, ...args);

  // PR #7: branch feature/login in the same repository; PR #8: a fork's head under refs/pull/8/head.
  const sha = { main: repo.git("rev-parse", "main") };
  repo.git("checkout", "-q", "-b", "feature/login", "main");
  repo.write("src/anmeldung.py", '"""Anmeldung."""\n\n\ndef pruefen(passwort):\n    return bool(passwort)\n');
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Leeres Passwort abweisen");
  sha.login = repo.git("rev-parse", "HEAD");
  repo.git("checkout", "-q", "-b", "fork-arbeit", "main");
  repo.write("docs/korrektur.md", "# Korrektur\n\nTippfehler in der Stationsliste.\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Korrektur aus dem Fork");
  sha.fork = repo.git("rev-parse", "HEAD");
  repo.git("checkout", "-q", "main");
  repo.git("push", "-q", bareDir, "feature/login:refs/heads/feature/login", "fork-arbeit:refs/pull/8/head");
  repo.git("branch", "-q", "-D", "feature/login", "fork-arbeit");

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname);
    const gitPrefix = `/${FULL}.git`;
    const toGit = pathname.startsWith(gitPrefix);
    const target = toGit ? { port: git.port, path: `/${BARE}${pathname.slice(gitPrefix.length)}${url.search}` } : { port: mock.port, path: request.url };
    const headers = { ...request.headers };
    if (toGit) headers.authorization = `Basic ${Buffer.from(`${GIT_USER}:${GIT_PASSWORD}`).toString("base64")}`;
    const upstream = http.request({ host: "127.0.0.1", port: target.port, method: request.method, path: target.path, headers }, (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    });
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    request.pipe(upstream);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const remoteUrl = `${base}/${FULL}.git`;
  repo.git("remote", "set-url", "origin", remoteUrl);

  return {
    base,
    remoteUrl,
    token: mock.token,
    weakToken: mock.weakToken,
    mock,
    git,
    sha,
    serverGit,
    /** Requests of the app to the API (`/api/v1/…`) from index `from` of mock.requests. */
    api(from = 0) {
      return mock.requests.slice(from).filter((entry) => entry.path.startsWith("/api/v1"));
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      await Promise.all([mock.close(), git.close()]).catch(() => undefined);
    },
  };
}

