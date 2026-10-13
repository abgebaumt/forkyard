/**
 * Test server for the host integration: answers on 127.0.0.1 in the shape of the public APIs of
 * GitHub (REST, under /api/v3) and GitLab (REST v4, under /api/v4). All data is made up; there are
 * no calls to the outside.
 * The Rust counterpart (for `cargo test`) is in crates/core/src/host/tests/mocks.rs.
 *
 *   import { startHostMock } from "./host-mock.mjs";
 *   const mock = await startHostMock();                 // { tls: true } for HTTPS with its own certificate
 *   await app.invoke("host_connect", { kind: "github", baseUrl: mock.url, token: mock.token });
 *   // remote of the test repository: mock.remoteUrl("github") or mock.remoteUrl("gitlab")
 *
 *   mock.url          http://127.0.0.1:<port> – the baseUrl for BOTH hosts (the paths differ)
 *   mock.token        valid token;  mock.weakToken: valid, but without the required permission
 *   mock.caFile       certificate of the test CA for settings.sslCaFile (tls only)
 *   mock.requests     [{ method, path, query, headers, body, status }] in order of arrival
 *   mock.state        mutable data: { merged: Set, closed: Set, created: [], comments: [] }
 *
 * Control:
 *   mock.fail("unauthorized")                          all further requests fail like this …
 *   mock.fail("rate_limit", { times: 1, match: "/pulls" })   … or only the next one whose path matches
 *     kinds: unauthorized (401), rate_limit (GitHub 403 with x-ratelimit-*, GitLab 429 with retry-after),
 *            not_found (404), server_error (500), broken_json (200 with truncated JSON),
 *            or an object { status, body, headers }
 *   mock.delay(1500, { match: "/pulls" })              delay answers (for timeouts)
 *   mock.reset()                                       reset failures, delays, requests and data
 *   await mock.close()
 *
 * Data (the same for both hosts): 45 pull/merge requests, no. 1 to 45. Number ending in 0: merged;
 * in 5: closed; otherwise open. No. 1 has passed checks and an approval, no. 2 running checks and a
 * requested reviewer, no. 3 is a draft, no. 4 has a failed check, no. 7 comes from the branch
 * feature/login, no. 8 from a fork, no. 13 cannot be merged. A new pull request from the branch
 * "schon-da" is rejected as a duplicate.
 * 12 issues (divisible by 4: closed). Repository: octo/demo (GitHub), gruppe/unter/demo (GitLab).
 *
 * Called directly (to try it out):  node scripts/e2e/host-mock.mjs [--tls] [--port 8123]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { opensslPath } from "./git-http-server.mjs";

/** Made up – they only look like tokens. */
export const MOCK_TOKEN = "ghp_FreiErfundenesTestToken0123456789abcd";
export const MOCK_WEAK_TOKEN = "ghp_FreiErfundenOhneRechte0123456789wxyz";

const TOTAL = 45;
const ISSUES = 12;
const GITLAB_PROJECT = "/projects/gruppe%2Funter%2Fdemo";

const sha = (number) => number.toString(16).padStart(40, "0");
const stamp = (number) => `2026-09-${String(1 + (number % 28)).padStart(2, "0")}T08:${String(number % 60).padStart(2, "0")}:00Z`;
const sourceBranch = (number) => (number === 7 ? "feature/login" : number === 8 ? "korrektur" : `feature/thema-${number}`);

function freshState() {
  return { merged: new Set(), closed: new Set(), created: [], comments: [], titles: new Map() };
}

function prState(number, state) {
  if (state.merged.has(number) || number % 10 === 0) return "merged";
  if (state.closed.has(number) || number % 10 === 5) return "closed";
  return "open";
}

// --- GitHub ---------------------------------------------------------------------------------

const ghUser = (login) => ({ login, id: login.length, avatar_url: `https://avatars.example/${login}.png`, type: "User" });

function ghPull(base, number, state) {
  const created = state.created.find((entry) => entry.number === number);
  const status = prState(number, state);
  return {
    number,
    title: state.titles.get(number) ?? created?.title ?? (number === 1 ? "Anmeldung: Fehlermeldung bei leerem Passwort" : `Thema ${number} umsetzen`),
    state: status === "open" ? "open" : "closed",
    merged_at: status === "merged" ? "2026-09-20T10:00:00Z" : null,
    draft: created?.draft ?? number === 3,
    user: ghUser(created ? "lena-hartmann" : "jonas"),
    body: created?.body ?? `Beschreibung zu **Thema ${number}**.\n\n- [x] Tests\n- [ ] Doku`,
    head: { ref: created?.source ?? sourceBranch(number), sha: sha(number), repo: { full_name: number === 8 ? "fremd/demo" : "octo/demo" } },
    base: { ref: created?.target ?? "main", sha: sha(1000), repo: { full_name: "octo/demo" } },
    updated_at: stamp(number),
    html_url: `${base}/octo/demo/pull/${number}`,
    labels: number === 1 ? [{ name: "bug", color: "d73a4a" }] : [],
    requested_reviewers: number === 2 ? [ghUser("mira")] : [],
    mergeable: number !== 13,
  };
}

function ghIssue(base, number) {
  const issue = {
    number,
    title: `Problem ${number}`,
    state: number % 4 === 0 ? "closed" : "open",
    user: ghUser("mira"),
    assignees: number === 2 ? [ghUser("lena-hartmann")] : [],
    labels: [{ name: "frage", color: "0e8a16" }],
    updated_at: stamp(number),
    html_url: `${base}/octo/demo/issues/${number}`,
    body: `Text zu Problem ${number}`,
  };
  // GitHub's issue list also contains pull requests; they carry this key.
  if (number % 3 === 0) issue.pull_request = { url: `${base}/api/v3/repos/octo/demo/pulls/${number}` };
  return issue;
}

function github(ctx) {
  const { method, base, state, query, body, json, notFound } = ctx;
  const path_ = ctx.path.slice("/api/v3".length);
  if (path_ === "/user") {
    return json(200, { login: "lena-hartmann", name: "Lena Hartmann", avatar_url: "https://avatars.example/lena-hartmann.png" }, { "x-oauth-scopes": ctx.token === MOCK_WEAK_TOKEN ? "gist, read:org" : "repo, read:org" });
  }
  if (path_ === "/search/issues") return json(200, { total_count: 2, incomplete_results: false, items: [ghIssue(base, 1), ghIssue(base, 2)] });
  if (!path_.startsWith("/repos/octo/demo")) return notFound("Not Found");
  const parts = path_.slice("/repos/octo/demo".length).split("/").filter(Boolean);
  const number = Number(parts[1]) || 0;
  const route = `${method} ${parts.map((part, index) => (index === 1 && parts[0] !== "git" ? ":n" : part)).join("/")}`;
  const known = number >= 1 && (number <= TOTAL || state.created.some((entry) => entry.number === number));
  switch (route) {
    case "GET ":
      return json(200, {
        name: "demo",
        full_name: "octo/demo",
        default_branch: "main",
        html_url: `${base}/octo/demo`,
        permissions: { admin: false, push: true, pull: true },
        fork: true,
        parent: { name: "demo", owner: { login: "ursprung" }, html_url: `${base}/ursprung/demo` },
      });
    case "GET pulls": {
      const wanted = query.get("state") ?? "open";
      const numbers = [...state.created.map((entry) => entry.number).reverse(), ...range(TOTAL, 1)].filter((n) => wanted === "all" || (wanted === "open") === (prState(n, state) === "open"));
      return ctx.page(numbers.map((n) => ghPull(base, n, state)));
    }
    case "POST pulls": {
      if (body.head === "schon-da") {
        return json(422, { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: "A pull request already exists for octo:schon-da." }] });
      }
      const entry = { number: 101 + state.created.length, title: body.title, body: body.body ?? "", source: body.head, target: body.base, draft: Boolean(body.draft) };
      state.created.push(entry);
      return json(201, ghPull(base, entry.number, state));
    }
    case "GET pulls/:n":
      return known ? json(200, ghPull(base, number, state)) : notFound("Not Found");
    case "PATCH pulls/:n":
      if (body.state === "closed") state.closed.add(number);
      if (body.state === "open") state.closed.delete(number);
      if (typeof body.title === "string") state.titles.set(number, body.title);
      return json(200, ghPull(base, number, state));
    case "GET pulls/:n/reviews":
      return json(
        200,
        number === 1
          ? [
              { id: 11, user: ghUser("mira"), state: "COMMENTED", body: "Erster Blick: sieht gut aus.", submitted_at: "2026-09-02T09:00:00Z" },
              { id: 12, user: ghUser("mira"), state: "APPROVED", body: "", submitted_at: "2026-09-02T10:00:00Z" },
            ]
          : number === 4
            ? [{ id: 41, user: ghUser("jonas"), state: "CHANGES_REQUESTED", body: "Bitte die Tests ergänzen.", submitted_at: "2026-09-03T10:00:00Z" }]
            : [],
      );
    case "GET pulls/:n/comments":
      return json(200, number === 1 ? [{ id: 31, user: ghUser("mira"), body: "Hier fehlt die Prüfung auf leer.", created_at: "2026-09-02T09:30:00Z", path: "src/anmeldung.rs", line: 42 }] : []);
    case "GET pulls/:n/commits":
      return json(200, [
        { sha: sha(number * 100 + 1), commit: { message: "Prüfung ergänzt\n\nLängere Erklärung.", author: { name: "Jonas Weber", date: "2026-09-01T12:00:00Z" } } },
        { sha: sha(number), commit: { message: "Meldung übersetzt", author: { name: "Jonas Weber", date: "2026-09-01T13:00:00Z" } } },
      ]);
    case "POST pulls/:n/requested_reviewers":
      return json(201, ghPull(base, number, state));
    case "DELETE pulls/:n/requested_reviewers":
      return json(200, ghPull(base, number, state));
    case "PUT pulls/:n/merge":
      if (number === 13) return json(405, { message: "Pull Request is not mergeable" });
      state.merged.add(number);
      return json(200, { sha: sha(number + 5000), merged: true, message: "Pull Request successfully merged" });
    case "GET commits/:n/check-runs": {
      const of = parseInt(parts[1], 16);
      const runs =
        of === 1
          ? [
              { name: "build", status: "completed", conclusion: "success", html_url: `${base}/octo/demo/runs/1` },
              { name: "docs", status: "completed", conclusion: "skipped", html_url: null, details_url: "https://ci.example/docs" },
            ]
          : of === 2
            ? [{ name: "build", status: "in_progress", conclusion: null, html_url: `${base}/octo/demo/runs/2` }]
            : of === 4
              ? [{ name: "build", status: "completed", conclusion: "failure", html_url: `${base}/octo/demo/runs/4` }]
              : [];
      return json(200, { total_count: runs.length, check_runs: runs });
    }
    case "GET commits/:n/status":
      return json(200, { state: "pending", statuses: parseInt(parts[1], 16) === 1 ? [{ context: "lizenz/cla", state: "success", target_url: "https://cla.example/1" }] : [] });
    case "GET issues": {
      const wanted = query.get("state") ?? "open";
      return ctx.page(range(ISSUES, 1).filter((n) => wanted === "all" || (wanted === "closed") === (n % 4 === 0)).map((n) => ghIssue(base, n)));
    }
    case "GET issues/:n":
      return number >= 1 && number <= 200 ? json(200, ghIssue(base, number)) : notFound("Not Found");
    case "GET issues/:n/comments":
      return json(200, [
        { id: 21, user: ghUser("jonas"), body: "Danke fürs Ansehen!", created_at: "2026-09-02T09:45:00Z" },
        ...state.comments.filter((entry) => entry.number === number).map((entry) => ({ id: entry.id, user: ghUser("lena-hartmann"), body: entry.body, created_at: entry.at })),
      ]);
    case "POST issues/:n/comments": {
      const entry = { id: 99 + state.comments.length, number, body: body.body, at: "2026-09-05T08:00:00Z" };
      state.comments.push(entry);
      return json(201, { id: entry.id, user: ghUser("lena-hartmann"), body: entry.body, created_at: entry.at });
    }
    case "POST issues/:n/labels":
    case "PUT issues/:n/labels":
      return json(200, []);
    default:
      if (method === "DELETE" && parts[0] === "git") return ctx.send(204, "", {});
      return notFound("Not Found");
  }
}

// --- GitLab ---------------------------------------------------------------------------------

const glUser = (username) => ({ id: 40 + username.length, username, name: `${username} (Name)`, avatar_url: `https://avatars.example/${username}.png`, state: "active" });

function glMerge(base, number, state, single) {
  const created = state.created.find((entry) => entry.number === number);
  const status = prState(number, state);
  const title = state.titles.get(number) ?? created?.title ?? (number === 3 ? "Draft: Thema 3 umsetzen" : `Thema ${number} umsetzen`);
  const pipeline = { 1: "success", 2: "running", 4: "failed" }[number];
  const merge = {
    iid: number,
    id: 9000 + number,
    title,
    description: created?.body ?? `Beschreibung zu **Thema ${number}**.`,
    state: status === "open" ? "opened" : status,
    draft: title.startsWith("Draft:"),
    work_in_progress: title.startsWith("Draft:"),
    author: glUser(created ? "lena.hartmann" : "jonas"),
    source_branch: created?.source ?? sourceBranch(number),
    target_branch: created?.target ?? "main",
    source_project_id: number === 8 ? 99 : 7,
    target_project_id: 7,
    updated_at: stamp(number),
    web_url: `${base}/gruppe/unter/demo/-/merge_requests/${number}`,
    labels: number === 1 ? ["bug"] : [],
    reviewers: number === 2 ? [glUser("mira")] : [],
    sha: sha(number),
    detailed_merge_status: number === 13 ? "conflict" : "mergeable",
  };
  if (single) merge.head_pipeline = pipeline ? { id: 500 + number, project_id: 7, status: pipeline, web_url: `${base}/gruppe/unter/demo/-/pipelines/${500 + number}` } : null;
  return merge;
}

const glIssue = (base, number) => ({
  iid: number,
  title: `Problem ${number}`,
  state: number % 4 === 0 ? "closed" : "opened",
  author: glUser("mira"),
  assignees: number === 2 ? [glUser("lena.hartmann")] : [],
  labels: ["frage"],
  updated_at: stamp(number),
  web_url: `${base}/gruppe/unter/demo/-/issues/${number}`,
  description: `Text zu Problem ${number}`,
});

function gitlab(ctx) {
  const { method, base, state, query, body, json, notFound } = ctx;
  const path_ = ctx.path.slice("/api/v4".length);
  if (path_ === "/user") return json(200, { id: 1, username: "lena.hartmann", name: "Lena Hartmann", avatar_url: "https://avatars.example/lena.png" });
  if (path_ === "/personal_access_tokens/self") return json(200, { id: 3, name: "forkyard", scopes: ctx.token === MOCK_WEAK_TOKEN ? ["read_api"] : ["api", "read_user"], active: true });
  if (path_ === "/users") return json(200, query.get("username") === "mira" ? [glUser("mira")] : []);
  if (path_ === "/projects/7/pipelines/501/jobs") {
    return json(200, [
      { id: 1, name: "build", status: "success", web_url: `${base}/gruppe/unter/demo/-/jobs/1` },
      { id: 2, name: "lint", status: "skipped", web_url: `${base}/gruppe/unter/demo/-/jobs/2` },
    ]);
  }
  if (!path_.startsWith(GITLAB_PROJECT)) return notFound("404 Project Not Found");
  const parts = path_.slice(GITLAB_PROJECT.length).split("/").filter(Boolean);
  const number = Number(parts[1]) || 0;
  const route = `${method} ${parts.map((part, index) => (index === 1 ? ":n" : part)).join("/")}`;
  const known = number >= 1 && (number <= TOTAL || state.created.some((entry) => entry.number === number));
  const notes = (kind) => [
    { id: 1, system: true, body: "changed title from A to B", author: glUser("jonas"), created_at: "2026-09-02T08:00:00Z" },
    { id: 2, system: false, body: "Sieht gut aus.", author: glUser("mira"), created_at: "2026-09-02T09:00:00Z" },
    ...(kind === "merge_requests" ? [{ id: 3, system: false, body: "Hier bitte prüfen.", author: glUser("mira"), created_at: "2026-09-02T09:30:00Z", position: { new_path: "src/anmeldung.rs", new_line: 42, old_path: "src/anmeldung.rs", old_line: null } }] : []),
    ...state.comments.filter((entry) => entry.number === number).map((entry) => ({ id: entry.id, system: false, body: entry.body, author: glUser("lena.hartmann"), created_at: entry.at })),
  ];
  switch (route) {
    case "GET ":
      return json(200, {
        id: 7,
        path_with_namespace: "gruppe/unter/demo",
        default_branch: "main",
        web_url: `${base}/gruppe/unter/demo`,
        permissions: { project_access: { access_level: 40 }, group_access: null },
        forked_from_project: { id: 3, path_with_namespace: "quelle/gruppe/demo", web_url: `${base}/quelle/gruppe/demo` },
      });
    case "GET merge_requests": {
      const wanted = query.get("state") ?? "all";
      const numbers = [...state.created.map((entry) => entry.number).reverse(), ...range(TOTAL, 1)].filter((n) => wanted === "all" || wanted === (prState(n, state) === "open" ? "opened" : prState(n, state)));
      return ctx.page(numbers.map((n) => glMerge(base, n, state, false)));
    }
    case "POST merge_requests": {
      if (body.source_branch === "schon-da") return json(409, { message: ["Another open merge request already exists for this source branch: !5"] });
      const entry = { number: 101 + state.created.length, title: body.title, body: body.description ?? "", source: body.source_branch, target: body.target_branch };
      state.created.push(entry);
      return json(201, glMerge(base, entry.number, state, true));
    }
    case "GET merge_requests/:n":
      return known ? json(200, glMerge(base, number, state, true)) : notFound("404 Not found");
    case "PUT merge_requests/:n":
      if (body.state_event === "close") state.closed.add(number);
      if (body.state_event === "reopen") state.closed.delete(number);
      if (typeof body.title === "string") state.titles.set(number, body.title);
      return json(200, glMerge(base, number, state, true));
    case "PUT merge_requests/:n/merge":
      if (number === 13) return json(405, { message: "405 Method Not Allowed" });
      state.merged.add(number);
      return json(200, glMerge(base, number, state, true));
    case "GET merge_requests/:n/approvals":
      return json(200, number === 1 ? { approved: true, approvals_left: 0, approved_by: [{ user: glUser("mira") }] } : { approved: false, approvals_left: 0, approved_by: [] });
    case "GET merge_requests/:n/notes":
    case "GET issues/:n/notes":
      return ctx.page(notes(parts[0]));
    case "POST merge_requests/:n/notes": {
      const entry = { id: 99 + state.comments.length, number, body: body.body, at: "2026-09-05T08:00:00Z" };
      state.comments.push(entry);
      return json(201, { id: entry.id, system: false, body: entry.body, author: glUser("lena.hartmann"), created_at: entry.at });
    }
    case "GET merge_requests/:n/commits":
      return ctx.page([
        { id: sha(number), title: "Meldung übersetzt", author_name: "Jonas Weber", authored_date: "2026-09-01T13:00:00Z" },
        { id: sha(number * 100 + 1), title: "Prüfung ergänzt", author_name: "Jonas Weber", authored_date: "2026-09-01T12:00:00Z" },
      ]);
    case "GET issues": {
      const wanted = query.get("state") ?? "all";
      const search = query.get("search");
      return ctx.page(
        range(ISSUES, 1)
          .filter((n) => wanted === "all" || (wanted === "closed") === (n % 4 === 0))
          .filter((n) => !search || n <= 2)
          .map((n) => glIssue(base, n)),
      );
    }
    case "GET issues/:n":
      return number >= 1 && number <= 200 ? json(200, glIssue(base, number)) : notFound("404 Not found");
    default:
      return notFound("404 Not Found");
  }
}

// --- Server ---------------------------------------------------------------------------------

/**
 * An own certificate authority and a server certificate for 127.0.0.1 issued by it – like in a
 * corporate network. (rustls rejects a single self-signed certificate as its own trust anchor if
 * it is marked as a CA.)
 */
function makeCertificateChain(dir) {
  const file = (name) => path.join(dir, name);
  const run = (args) => execFileSync(opensslPath(), args, { stdio: "ignore", windowsHide: true });
  run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", file("ca-key.pem"), "-out", file("ca.pem"), "-days", "2", "-subj", "/CN=forkyard Test-CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
  run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", file("server-key.pem"), "-out", file("server.csr"), "-subj", "/CN=127.0.0.1"]);
  fs.writeFileSync(file("server.ext"), "subjectAltName=IP:127.0.0.1,DNS:localhost\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n");
  run(["x509", "-req", "-in", file("server.csr"), "-CA", file("ca.pem"), "-CAkey", file("ca-key.pem"), "-CAcreateserial", "-out", file("server-cert.pem"), "-days", "2", "-extfile", file("server.ext")]);
  return { key: file("server-key.pem"), cert: file("server-cert.pem"), ca: file("ca.pem") };
}

function range(from, to) {
  const list = [];
  for (let n = from; n >= to; n -= 1) list.push(n);
  return list;
}

function forcedAnswer(kind, flavour) {
  if (typeof kind === "object") return { status: kind.status ?? 500, body: typeof kind.body === "string" ? kind.body : JSON.stringify(kind.body ?? {}), headers: kind.headers ?? {} };
  switch (kind) {
    case "unauthorized":
      return { status: 401, body: JSON.stringify({ message: flavour === "gitlab" ? "401 Unauthorized" : "Bad credentials" }), headers: {} };
    case "rate_limit": {
      const reset = String(Math.floor(Date.now() / 1000) + 600);
      return flavour === "gitlab"
        ? { status: 429, body: "Retry later", headers: { "retry-after": "600", "ratelimit-remaining": "0", "ratelimit-reset": reset } }
        : { status: 403, body: JSON.stringify({ message: "API rate limit exceeded for user ID 1." }), headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } };
    }
    case "not_found":
      return { status: 404, body: JSON.stringify({ message: flavour === "gitlab" ? "404 Not found" : "Not Found" }), headers: {} };
    case "server_error":
      return { status: 500, body: JSON.stringify({ message: "Server Error" }), headers: {} };
    case "broken_json":
      return { status: 200, body: '[{"number": 1, "title": "abgeschn', headers: {} };
    default:
      throw new Error(`host-mock: unknown failure kind "${kind}"`);
  }
}

/**
 * Starts the test server.
 * @param {object}  [options]
 * @param {boolean} [options.tls]   HTTPS with a self-issued certificate (`caFile`)
 * @param {number}  [options.port]  fixed port; otherwise a free one
 */
export async function startHostMock({ tls = false, port = 0 } = {}) {
  const requests = [];
  let state = freshState();
  let failures = [];
  let delays = [];
  const root = tls ? fs.mkdtempSync(path.join(os.tmpdir(), "gc-fix-hostmock-")) : null;
  let scheme = "http";
  let address = "";

  const handler = (request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const target = new URL(request.url, `${scheme}://${request.headers.host}`);
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        body = {};
      }
      const entry = { method: request.method, path: target.pathname, query: Object.fromEntries(target.searchParams), headers: request.headers, body: raw ? body : null, status: 0 };
      requests.push(entry);
      const base = `${scheme}://${request.headers.host}`;
      const send = (status, text, headers) => {
        entry.status = status;
        const wait = delays.find((rule) => !rule.match || target.pathname.includes(rule.match))?.ms ?? 0;
        setTimeout(() => {
          const bodiless = status === 204 || status === 304;
          response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers, ...(bodiless ? {} : { "content-length": Buffer.byteLength(text) }) });
          response.end(bodiless ? undefined : text);
        }, wait);
      };
      const json = (status, value, headers = {}) => {
        const text = JSON.stringify(value);
        // Like the real services: same answer, same ETag – and 304 if the caller already has it.
        const etag = `"${crypto.createHash("sha1").update(text).digest("hex").slice(0, 16)}"`;
        if (request.method === "GET" && status === 200 && request.headers["if-none-match"] === etag) return send(304, "", { etag, ...headers });
        return send(status, text, request.method === "GET" && status === 200 ? { etag, ...headers } : headers);
      };
      const page = (items) => {
        const perPage = Math.max(1, Number(target.searchParams.get("per_page")) || 30);
        const current = Math.max(1, Number(target.searchParams.get("page")) || 1);
        const slice = items.slice((current - 1) * perPage, current * perPage);
        const headers = { "x-page": String(current), "x-next-page": "" };
        if (current * perPage < items.length) {
          const next = new URL(target);
          next.searchParams.set("page", String(current + 1));
          headers.link = `<${next.toString()}>; rel="next"`;
          headers["x-next-page"] = String(current + 1);
        }
        return json(200, slice, headers);
      };
      const flavour = target.pathname.startsWith("/api/v4") ? "gitlab" : target.pathname.startsWith("/api/v3") ? "github" : "other";
      const notFound = (message) => json(404, { message });

      if (flavour === "other") return notFound("Not Found");
      const token = (request.headers.authorization ?? "").replace(/^Bearer /, "");
      if (token !== MOCK_TOKEN && token !== MOCK_WEAK_TOKEN) return json(401, { message: flavour === "gitlab" ? "401 Unauthorized" : "Bad credentials" });
      const forced = takeFailure(target.pathname);
      if (forced) {
        const answer = forcedAnswer(forced, flavour);
        return send(answer.status, answer.body, answer.headers);
      }
      const ctx = { method: request.method, path: target.pathname, query: target.searchParams, body, base, state, token, json, send, page, notFound };
      return flavour === "gitlab" ? gitlab(ctx) : github(ctx);
    });
  };

  function takeFailure(pathname) {
    const index = failures.findIndex((rule) => !rule.match || pathname.includes(rule.match));
    if (index < 0) return null;
    const rule = failures[index];
    if (rule.times !== Infinity) {
      rule.times -= 1;
      if (rule.times <= 0) failures.splice(index, 1);
    }
    return rule.kind;
  }

  let server;
  let caFile = null;
  if (tls) {
    const { key, cert, ca } = makeCertificateChain(root);
    caFile = ca;
    scheme = "https";
    server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, handler);
  } else {
    server = http.createServer(handler);
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  address = `${scheme}://127.0.0.1:${server.address().port}`;

  return {
    url: address,
    port: server.address().port,
    token: MOCK_TOKEN,
    weakToken: MOCK_WEAK_TOKEN,
    caFile,
    requests,
    get state() {
      return state;
    },
    /** URL for `git remote add`: this is how the core recognizes the repository on this server. */
    remoteUrl(kind = "github") {
      return `${address}/${kind === "gitlab" ? "gruppe/unter/demo" : "octo/demo"}.git`;
    },
    /** Makes requests fail: `times` of them (default: all further ones) whose path contains `match`. */
    fail(kind, { times = Infinity, match = null } = {}) {
      forcedAnswer(kind, "github"); // validates the kind right away
      failures.push({ kind, times, match });
    },
    /** Delays answers by `ms` milliseconds (0 removes all delays). */
    delay(ms, { match = null } = {}) {
      if (!ms) delays = [];
      else delays.push({ ms, match });
    },
    /** Only removes failures and delays. */
    recover() {
      failures = [];
      delays = [];
    },
    reset() {
      failures = [];
      delays = [];
      requests.length = 0;
      state = freshState();
    },
    async close() {
      await new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
      if (root) fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const portAt = args.indexOf("--port");
  const mock = await startHostMock({ tls: args.includes("--tls"), port: portAt >= 0 ? Number(args[portAt + 1]) : 0 });
  console.log(`Test server running: ${mock.url}`);
  console.log(`  GitHub: baseUrl ${mock.url}, Remote ${mock.remoteUrl("github")}`);
  console.log(`  GitLab: baseUrl ${mock.url}, Remote ${mock.remoteUrl("gitlab")}`);
  console.log(`  Token: ${mock.token}   (without permission: ${mock.weakToken})`);
  if (mock.caFile) console.log(`  Certificate: ${mock.caFile}`);
  console.log("Stop with Ctrl+C.");
}
