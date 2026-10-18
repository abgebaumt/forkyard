/**
 * Test server for the host integration: answers on 127.0.0.1 in the shape of the public APIs of
 * GitHub (REST, under /api/v3), GitLab (REST v4, under /api/v4), Gitea/Forgejo (under /api/v1),
 * Bitbucket Cloud (2.0, under /2.0) and Azure DevOps (organization `firma`, under /firma). All data
 * is made up; there are no calls to the outside.
 * The Rust counterpart (for `cargo test`) is in crates/core/src/host/tests/mocks.rs.
 *
 *   import { startHostMock } from "./host-mock.mjs";
 *   const mock = await startHostMock();                 // { tls: true } for HTTPS with its own certificate
 *   await app.invoke("host_connect", { kind: "github", baseUrl: mock.baseUrl("github"), token: mock.token });
 *   await app.invoke("host_connect", { kind: "bitbucket", baseUrl: mock.baseUrl("bitbucket"), token: mock.token, username: "lena@example.org" });
 *   // remote of the test repository: mock.remoteUrl("github" | "gitlab" | "gitea" | "bitbucket" | "azure_devops")
 *
 *   mock.url          http://127.0.0.1:<port> – the baseUrl for BOTH hosts (the paths differ)
 *   mock.token        valid token;  mock.weakToken: valid, but without the required permission
 *   mock.caFile       certificate of the test CA for settings.sslCaFile (tls only)
 *   mock.requests     [{ method, path, query, headers, body, status }] in order of arrival
 *   mock.state        mutable data: { merged: Set, closed: Set, created: [], comments: [], releases: [] }
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
 * Releases (GitHub, GitLab, Gitea/Forgejo) are recorded in state.releases; a release for the tag "schon-da" is rejected as a duplicate.
 * 12 issues (divisible by 4: closed). Repository: octo/demo (GitHub, Gitea), gruppe/unter/demo
 * (GitLab), team/demo (Bitbucket), firma/projekt/_git/demo (Azure DevOps). Work items (Azure
 * DevOps) = the 12 issues.
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
  return { merged: new Set(), closed: new Set(), created: [], comments: [], titles: new Map(), workItems: [], releases: [] };
}

/** Records a release; `target` is the commit (`target_commitish`, on GitLab `ref`). */
function recordRelease(state, body, target, description) {
  const entry = { id: 7001 + state.releases.length, tag: body.tag_name, target: target ?? null, name: body.name || body.tag_name, body: description ?? "", prerelease: Boolean(body.prerelease) };
  state.releases.push(entry);
  return entry;
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
    case "POST releases": {
      if (body.tag_name === "schon-da") return json(422, { message: "Validation Failed", errors: [{ resource: "Release", code: "already_exists", field: "tag_name" }] });
      const entry = recordRelease(state, body, body.target_commitish, body.body);
      return json(201, { id: entry.id, tag_name: entry.tag, name: entry.name, body: entry.body, draft: false, prerelease: entry.prerelease, html_url: `${base}/octo/demo/releases/tag/${encodeURIComponent(entry.tag)}` });
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
    case "POST releases": {
      if (body.tag_name === "schon-da") return json(409, { message: "Release already exists" });
      const entry = recordRelease(state, body, body.ref, body.description);
      return json(201, { tag_name: entry.tag, name: entry.name, description: entry.body, _links: { self: `${base}/gruppe/unter/demo/-/releases/${encodeURIComponent(entry.tag)}` } });
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

// --- Gitea / Forgejo -----------------------------------------------------------------------

const gtUser = (login) => ({ id: login.length, login, full_name: `${login} (Name)`, avatar_url: `https://avatars.example/${login}.png` });

function gtPull(base, number, state) {
  const created = state.created.find((entry) => entry.number === number);
  const status = prState(number, state);
  return {
    number,
    title: state.titles.get(number) ?? created?.title ?? (number === 3 ? "WIP: Thema 3 umsetzen" : `Thema ${number} umsetzen`),
    state: status === "open" ? "open" : "closed",
    merged: status === "merged",
    user: gtUser(created ? "lena" : "jonas"),
    body: created?.body ?? `Beschreibung zu **Thema ${number}**.`,
    head: { ref: created?.source ?? sourceBranch(number), sha: sha(number), repo: { full_name: number === 8 ? "fremd/demo" : "octo/demo" } },
    base: { ref: created?.target ?? "main", sha: sha(1000), repo: { full_name: "octo/demo" } },
    updated_at: stamp(number),
    html_url: `${base}/octo/demo/pulls/${number}`,
    labels: number === 1 ? [{ id: 11, name: "bug", color: "ee0701" }] : [],
    requested_reviewers: number === 2 ? [gtUser("mira")] : [],
    mergeable: number !== 13,
  };
}

const gtIssue = (base, number) => ({
  number,
  title: `Problem ${number}`,
  state: number % 4 === 0 ? "closed" : "open",
  user: gtUser("mira"),
  assignees: number === 2 ? [gtUser("lena")] : null,
  labels: [{ id: 12, name: "frage", color: "0e8a16" }],
  updated_at: stamp(number),
  html_url: `${base}/octo/demo/issues/${number}`,
  body: `Text zu Problem ${number}`,
  pull_request: null,
});

function gitea(ctx) {
  const { method, base, state, query, body, json, page, notFound } = ctx;
  const path_ = ctx.path.slice("/api/v1".length);
  if (path_ === "/user") return json(200, { id: 1, login: "lena", full_name: "Lena Hartmann", avatar_url: "https://avatars.example/lena.png" });
  if (!path_.startsWith("/repos/octo/demo")) return notFound("The target couldn't be found.");
  const parts = path_.slice("/repos/octo/demo".length).split("/").filter(Boolean);
  const number = Number(parts[1]) || 0;
  const route = `${method} ${parts.map((part, index) => (index === 1 ? ":n" : part)).join("/")}`;
  const known = number >= 1 && (number <= TOTAL || state.created.some((entry) => entry.number === number));
  switch (route) {
    case "GET ":
      return json(200, { name: "demo", full_name: "octo/demo", default_branch: "main", html_url: `${base}/octo/demo`, permissions: { admin: false, push: true, pull: true }, has_issues: true, parent: { name: "demo", owner: { login: "ursprung" }, html_url: `${base}/ursprung/demo` } });
    case "GET labels":
      return json(200, [{ id: 11, name: "bug" }, { id: 12, name: "frage" }, { id: 13, name: "ui" }]);
    case "GET pulls": {
      const wanted = query.get("state") ?? "open";
      const numbers = range(TOTAL, 1).filter((n) => wanted === "all" || (wanted === "open") === (prState(n, state) === "open"));
      return page(numbers.map((n) => gtPull(base, n, state)), "limit");
    }
    case "POST releases": {
      if (body.tag_name === "schon-da") return json(409, { message: "release tag already exists" });
      const entry = recordRelease(state, body, body.target_commitish, body.body);
      return json(201, { id: entry.id, tag_name: entry.tag, name: entry.name, body: entry.body, html_url: `${base}/octo/demo/releases/tag/${encodeURIComponent(entry.tag)}` });
    }
    case "POST pulls": {
      if (body.head === "schon-da") return json(409, { message: "pull request already exists for these targets" });
      const number = 100 + state.created.length + 1;
      state.created.push({ number, title: body.title, body: body.body ?? "", source: body.head, target: body.base, draft: /^WIP:/.test(body.title ?? "") });
      return json(201, gtPull(base, number, state));
    }
    case "GET pulls/:n":
      return known ? json(200, gtPull(base, number, state)) : notFound("pull request does not exist");
    case "PATCH pulls/:n": {
      if (!known) return notFound("pull request does not exist");
      if (body.state === "closed") state.closed.add(number);
      if (body.state === "open") state.closed.delete(number);
      if (typeof body.title === "string") state.titles.set(number, body.title);
      return json(201, gtPull(base, number, state));
    }
    case "GET pulls/:n/reviews":
      return json(200, number === 1 ? [{ id: 12, user: gtUser("mira"), state: "APPROVED", body: "", submitted_at: "2026-09-02T10:00:00Z" }] : number === 4 ? [{ id: 41, user: gtUser("jonas"), state: "REQUEST_CHANGES", body: "Bitte die Tests ergänzen.", submitted_at: "2026-09-03T10:00:00Z" }] : []);
    case "GET pulls/:n/commits":
      return json(200, [{ sha: sha(number), commit: { message: "Meldung übersetzt", author: { name: "Jonas Weber", date: "2026-09-01T13:00:00Z" } } }]);
    case "POST pulls/:n/requested_reviewers":
      return json(201, []);
    case "DELETE pulls/:n/requested_reviewers":
      return ctx.send(204, "", {});
    case "POST pulls/:n/merge":
      if (number === 13) return json(405, { message: "The pull request cannot be merged: there are merge conflicts." });
      state.merged.add(number);
      return ctx.send(200, "", {});
    case "GET commits/:n/status": {
      const which = parseInt(parts[1] ?? "0", 16);
      const statuses = which === 1 ? [{ context: "build", status: "success", target_url: `${base}/octo/demo/actions/runs/1` }] : which === 2 ? [{ context: "build", status: "pending", target_url: null }] : which === 4 ? [{ context: "build", status: "failure", target_url: null }] : [];
      return json(200, { state: "", statuses });
    }
    case "GET issues": {
      const wanted = query.get("state") ?? "open";
      const search = query.get("q");
      const numbers = range(ISSUES, 1).filter((n) => wanted === "all" || (wanted === "closed") === (n % 4 === 0)).filter((n) => !search || n <= 2);
      return page(numbers.map((n) => gtIssue(base, n)), "limit");
    }
    case "GET issues/:n":
      return number >= 1 && number <= ISSUES ? json(200, gtIssue(base, number)) : notFound("issue does not exist");
    case "GET issues/:n/comments":
      return json(200, [{ id: 21, user: gtUser("jonas"), body: "Danke fürs Ansehen!", created_at: "2026-09-02T09:45:00Z" }]);
    case "POST issues/:n/comments": {
      const comment = { id: 900 + state.comments.length, user: gtUser("lena"), body: body.body ?? "", created_at: new Date().toISOString() };
      state.comments.push(comment);
      return json(201, comment);
    }
    default:
      return notFound("The target couldn't be found.");
  }
}

// --- Bitbucket Cloud -------------------------------------------------------------------------

const bbUser = (nick) => ({ type: "user", display_name: `${nick} (Name)`, nickname: nick, account_id: `557058:${nick}`, links: { avatar: { href: `https://avatars.example/${nick}.png` } } });
const bbState = (status) => (status === "merged" ? "MERGED" : status === "closed" ? "DECLINED" : "OPEN");

function bbPull(base, number, state) {
  const created = state.created.find((entry) => entry.number === number);
  return {
    type: "pullrequest",
    id: number,
    title: state.titles.get(number) ?? created?.title ?? `Thema ${number} umsetzen`,
    description: created?.body ?? `Beschreibung zu **Thema ${number}**.`,
    state: bbState(prState(number, state)),
    draft: created?.draft ?? number === 3,
    author: bbUser(created ? "lena" : "jonas"),
    source: { branch: { name: created?.source ?? sourceBranch(number) }, commit: { hash: sha(number).slice(0, 12) }, repository: { full_name: number === 8 ? "fremd/demo" : "team/demo" } },
    destination: { branch: { name: created?.target ?? "main" }, commit: { hash: sha(1000).slice(0, 12) }, repository: { full_name: "team/demo" } },
    updated_on: stamp(number),
    links: { html: { href: `${base}/team/demo/pull-requests/${number}` } },
    participants: number === 1 ? [{ user: bbUser("mira"), role: "REVIEWER", approved: true, state: "approved" }] : number === 4 ? [{ user: bbUser("jonas"), role: "REVIEWER", approved: false, state: "changes_requested" }] : [],
    reviewers: number === 2 ? [bbUser("mira")] : [],
  };
}

const bbIssue = (base, number) => ({
  type: "issue",
  id: number,
  title: `Problem ${number}`,
  state: number % 4 === 0 ? "resolved" : number % 3 === 0 ? "new" : "open",
  kind: "bug",
  reporter: bbUser("mira"),
  assignee: number === 2 ? bbUser("lena") : null,
  updated_on: stamp(number),
  links: { html: { href: `${base}/team/demo/issues/${number}` } },
  content: { raw: `Text zu Problem ${number}` },
});

function bitbucket(ctx) {
  const { method, base, state, query, body, json, bbPage } = ctx;
  const path_ = ctx.path.slice("/2.0".length);
  const bbError = (status, message) => json(status, { type: "error", error: { message } });
  const values = (list) => json(200, { values: list, page: 1 });
  if (path_ === "/user") {
    return json(200, { type: "user", display_name: "Lena Hartmann", nickname: "lena", account_id: "557058:lena", links: { avatar: { href: "https://avatars.example/lena.png" } } }, { "x-oauth-scopes": ctx.token === MOCK_WEAK_TOKEN ? "account, repository" : "account, repository, pullrequest:write, issue" });
  }
  if (path_ === "/user/permissions/repositories") return values([{ permission: "write", repository: { full_name: "team/demo" } }]);
  if (!path_.startsWith("/repositories/team/demo")) return bbError(404, "Repository not found");
  const parts = path_.slice("/repositories/team/demo".length).split("/").filter(Boolean);
  const number = Number(parts[1]) || 0;
  const route = `${method} ${parts.map((part, index) => (index === 1 ? ":n" : part)).join("/")}`;
  const known = number >= 1 && (number <= TOTAL || state.created.some((entry) => entry.number === number));
  switch (route) {
    case "GET ":
      return json(200, { type: "repository", full_name: "team/demo", mainbranch: { name: "main" }, has_issues: true, links: { html: { href: `${base}/team/demo` } } });
    case "GET pullrequests": {
      const wanted = query.getAll("state");
      const numbers = range(TOTAL, 1).filter((n) => wanted.length === 0 || wanted.includes(bbState(prState(n, state))));
      return bbPage(numbers.map((n) => bbPull(base, n, state)));
    }
    case "POST pullrequests": {
      if (body.source?.branch?.name === "schon-da") return bbError(400, "Only one pull request may be open for a given source and target branch");
      const number = 100 + state.created.length + 1;
      state.created.push({ number, title: body.title, body: body.description ?? "", source: body.source?.branch?.name, target: body.destination?.branch?.name, draft: Boolean(body.draft) });
      return json(201, bbPull(base, number, state));
    }
    case "GET pullrequests/:n":
      return known ? json(200, bbPull(base, number, state)) : bbError(404, "Pull request not found");
    case "PUT pullrequests/:n":
      if (!known) return bbError(404, "Pull request not found");
      if (typeof body.title === "string") state.titles.set(number, body.title);
      return json(200, bbPull(base, number, state));
    case "POST pullrequests/:n/merge":
      if (number === 13) return bbError(400, "You can't merge until you resolve all merge conflicts.");
      state.merged.add(number);
      return json(200, bbPull(base, number, state));
    case "POST pullrequests/:n/decline":
      state.closed.add(number);
      return json(200, bbPull(base, number, state));
    case "GET pullrequests/:n/statuses":
      return values(number === 1 ? [{ key: "build", name: "build", state: "SUCCESSFUL", url: `${base}/team/demo/pipelines/1` }] : number === 4 ? [{ key: "build", name: "build", state: "FAILED", url: null }] : []);
    case "GET pullrequests/:n/diffstat":
      return values([{ status: number === 13 ? "merge conflict" : "modified", new: { path: "src/anmeldung.rs" } }]);
    case "GET pullrequests/:n/comments":
      return values([{ id: 2, user: bbUser("mira"), content: { raw: "Sieht gut aus." }, created_on: "2026-09-02T09:00:00Z", deleted: false }]);
    case "POST pullrequests/:n/comments": {
      const comment = { id: 900 + state.comments.length, user: bbUser("lena"), content: { raw: body.content?.raw ?? "" }, created_on: new Date().toISOString() };
      state.comments.push(comment);
      return json(201, comment);
    }
    case "GET pullrequests/:n/commits":
      return values([{ hash: sha(number), message: "Meldung übersetzt", author: { raw: "Jonas Weber <jonas@example.org>" }, date: "2026-09-01T13:00:00Z" }]);
    case "GET issues": {
      const q = query.get("q") ?? "";
      const numbers = range(ISSUES, 1)
        .filter((n) => (q.includes('state!="new"') ? n % 4 === 0 : q.includes('state="new"') ? n % 4 !== 0 : true))
        .filter((n) => !q.includes("title ~") || n <= 2);
      return bbPage(numbers.map((n) => bbIssue(base, n)));
    }
    case "GET issues/:n":
      return number >= 1 && number <= ISSUES ? json(200, bbIssue(base, number)) : bbError(404, "Issue not found");
    case "GET issues/:n/comments":
      return values([{ id: 21, user: bbUser("jonas"), content: { raw: "Danke fürs Ansehen!" }, created_on: "2026-09-02T09:45:00Z" }]);
    default:
      return bbError(404, "Resource not found");
  }
}

// --- Azure DevOps ----------------------------------------------------------------------------

const azUser = (name) => ({ displayName: `${name} (Name)`, uniqueName: `${name}@example.org`, imageUrl: `https://avatars.example/${name}.png` });
const azStatus = (status) => (status === "merged" ? "completed" : status === "closed" ? "abandoned" : "active");

function azPull(number, state) {
  const created = state.created.find((entry) => entry.number === number);
  const status = azStatus(prState(number, state));
  const pr = {
    pullRequestId: number,
    title: state.titles.get(number) ?? created?.title ?? `Thema ${number} umsetzen`,
    description: created?.body ?? `Beschreibung zu **Thema ${number}**.`,
    status,
    isDraft: created?.draft ?? number === 3,
    createdBy: azUser(created ? "lena" : "jonas"),
    creationDate: stamp(number),
    closedDate: status === "active" ? null : stamp(number),
    sourceRefName: `refs/heads/${created?.source ?? sourceBranch(number)}`,
    targetRefName: `refs/heads/${created?.target ?? "main"}`,
    repository: { name: "demo", project: { name: "projekt" } },
    labels: number === 1 ? [{ name: "bug", active: true }] : [],
    reviewers: number === 1 ? [{ ...azUser("mira"), vote: 10 }] : number === 2 ? [{ ...azUser("mira"), vote: 0 }] : number === 4 ? [{ ...azUser("jonas"), vote: -10 }] : [],
    mergeStatus: number === 13 ? "conflicts" : "succeeded",
    lastMergeSourceCommit: { commitId: sha(number) },
  };
  if (number === 8) pr.forkSource = { repository: { name: "demo", project: { name: "fremd" } } };
  return pr;
}

const azWorkItem = (number) => ({
  id: number,
  fields: {
    "System.Title": `Problem ${number}`,
    "System.State": number % 4 === 0 ? "Closed" : "Active",
    "System.CreatedBy": azUser("mira"),
    "System.AssignedTo": number === 2 ? azUser("lena") : null,
    "System.ChangedDate": stamp(number),
    "System.Tags": number === 1 ? "frage; ui" : "",
    "System.WorkItemType": "Issue",
    "System.Description": `<p>Text zu Problem ${number}</p>`,
  },
});

function azure(ctx) {
  const { method, base, state, query, body, json } = ctx;
  const azError = (status, message) => json(status, { $id: "1", message, typeKey: "MockException" });
  const list = (value) => json(200, { count: value.length, value });
  if (ctx.path === "/firma/_apis/connectionData") {
    return json(200, { authenticatedUser: { id: "mock-user", providerDisplayName: "Lena Hartmann", isActive: true, properties: { Account: { $type: "System.String", $value: "lena@example.org" } } } });
  }
  if (ctx.path === "/firma/_apis/projects") return list([{ id: "p1", name: "projekt" }]);
  const wit = "/firma/projekt/_apis/wit";
  if (ctx.path.startsWith(wit)) {
    const parts = ctx.path.slice(wit.length).split("/").filter(Boolean);
    if (method === "POST" && parts[0] === "wiql") {
      const text = String(body.query ?? "");
      const ids = range(ISSUES, 1)
        .filter((n) => (text.includes("NOT IN") ? n % 4 !== 0 : text.includes("] IN (") ? n % 4 === 0 : true))
        .filter((n) => !text.includes("CONTAINS") || n <= 2);
      const top = Number(query.get("$top")) || ids.length;
      return json(200, { queryType: "flat", workItems: ids.slice(0, top).map((id) => ({ id, url: `${base}/firma/_apis/wit/workItems/${id}` })) });
    }
    if (method === "GET" && parts.length === 1 && parts[0] === "workitems") {
      return list((query.get("ids") ?? "").split(",").map(Number).filter((n) => n > 0).sort((a, b) => a - b).map(azWorkItem));
    }
    if (method === "GET" && parts.length === 2 && parts[0] === "workitems") {
      const n = Number(parts[1]);
      return n >= 1 && n <= ISSUES ? json(200, azWorkItem(n)) : azError(404, `TF401232: Work item ${parts[1]} does not exist.`);
    }
    if (method === "GET" && parts[0] === "workItems" && parts[2] === "comments") {
      return json(200, { totalCount: 1, count: 1, comments: [{ id: 5, text: "Danke fürs Ansehen!", createdBy: azUser("jonas"), createdDate: "2026-09-02T09:45:00Z" }] });
    }
    if (method === "POST" && parts[0] === "workitems" && String(parts[1] ?? "").startsWith("$")) {
      const field = (name) => (Array.isArray(body) ? body.find((op) => op.path === `/fields/${name}`)?.value : null) ?? null;
      const id = 500 + state.workItems.length + 1;
      state.workItems.push({ id, title: field("System.Title") });
      return json(200, { id, fields: { "System.Title": field("System.Title"), "System.State": "New", "System.CreatedBy": azUser("lena"), "System.ChangedDate": new Date().toISOString(), "System.WorkItemType": parts[1].slice(1), "System.Description": field("System.Description") } });
    }
    return azError(404, "The resource cannot be found.");
  }
  const repo = "/firma/projekt/_apis/git/repositories/demo";
  if (!ctx.path.startsWith(repo)) return azError(404, "TF401019: The Git repository with name or identifier demo does not exist.");
  const parts = ctx.path.slice(repo.length).split("/").filter(Boolean);
  const number = Number(parts[1]) || 0;
  const route = `${method} ${parts.map((part, index) => (index === 1 ? ":n" : part)).join("/")}`;
  const known = number >= 1 && (number <= TOTAL || state.created.some((entry) => entry.number === number));
  switch (route) {
    case "GET ":
      return json(200, { id: "r1", name: "demo", defaultBranch: "refs/heads/main", webUrl: `${base}/firma/projekt/_git/demo`, project: { name: "projekt" } });
    case "GET pullrequests": {
      const wanted = query.get("searchCriteria.status") ?? "active";
      const skip = Number(query.get("$skip")) || 0;
      const top = Number(query.get("$top")) || 101;
      const all = range(TOTAL, 1).filter((n) => wanted === "all" || azStatus(prState(n, state)) === wanted);
      return list(all.slice(skip, skip + top).map((n) => azPull(n, state)));
    }
    case "POST pullrequests": {
      if (body.sourceRefName === "refs/heads/schon-da") return azError(409, "TF401179: An active pull request for the source and target branch already exists.");
      const number = 100 + state.created.length + 1;
      state.created.push({ number, title: body.title, body: body.description ?? "", source: String(body.sourceRefName ?? "").replace(/^refs\/heads\//, ""), target: String(body.targetRefName ?? "").replace(/^refs\/heads\//, ""), draft: Boolean(body.isDraft) });
      return json(201, azPull(number, state));
    }
    case "GET pullrequests/:n":
      return known ? json(200, azPull(number, state)) : azError(404, "TF401180: The requested pull request was not found.");
    case "PATCH pullrequests/:n": {
      if (!known) return azError(404, "TF401180: The requested pull request was not found.");
      if (body.status === "completed") {
        if (number === 13) return azError(409, "TF401181: The pull request cannot be completed because it has merge conflicts.");
        state.merged.add(number);
      }
      if (body.status === "abandoned") state.closed.add(number);
      if (body.status === "active") state.closed.delete(number);
      if (typeof body.title === "string") state.titles.set(number, body.title);
      return json(200, azPull(number, state));
    }
    case "GET pullrequests/:n/statuses":
      return list(number === 1 ? [{ id: 1, state: "succeeded", context: { name: "build", genre: "ci" }, targetUrl: "https://ci.example/1" }] : number === 4 ? [{ id: 1, state: "failed", context: { name: "build", genre: "ci" } }] : []);
    case "GET pullrequests/:n/threads":
      return list([{ id: 2, comments: [{ id: 1, author: azUser("mira"), content: "Sieht gut aus.", publishedDate: "2026-09-02T09:00:00Z", commentType: "text" }] }]);
    case "POST pullrequests/:n/threads": {
      const thread = { id: 700 + state.comments.length, comments: [{ id: 1, author: azUser("lena"), content: body.comments?.[0]?.content ?? "", publishedDate: new Date().toISOString(), commentType: "text" }] };
      state.comments.push(thread);
      return json(200, thread);
    }
    case "GET pullrequests/:n/commits":
      return list([{ commitId: sha(number), comment: "Meldung übersetzt", author: { name: "Jonas Weber", date: "2026-09-01T13:00:00Z" } }]);
    case "POST pullrequests/:n/labels":
      return json(200, { name: body.name, active: true });
    default:
      if (method === "DELETE" && parts[2] === "labels") return ctx.send(204, "", {});
      return azError(404, "The resource cannot be found.");
  }
}

/** The token from the `Authorization` header, in the form each host uses. */
function readToken(header, flavour) {
  if (flavour === "gitea") return header.replace(/^token /, "");
  if (flavour === "bitbucket" || flavour === "azure") {
    const decoded = Buffer.from(header.replace(/^Basic /, ""), "base64").toString("utf8");
    const at = decoded.indexOf(":");
    // Bitbucket signs in with user name and token; Azure DevOps with an empty user name.
    if (at < 0 || (flavour === "bitbucket" && at === 0)) return "";
    return decoded.slice(at + 1);
  }
  return header.replace(/^Bearer /, "");
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
      return flavour === "github"
        ? { status: 403, body: JSON.stringify({ message: "API rate limit exceeded for user ID 1." }), headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } }
        : { status: 429, body: flavour === "gitlab" ? "Retry later" : JSON.stringify({ message: "Rate limit exceeded" }), headers: { "retry-after": "600", "ratelimit-remaining": "0", "ratelimit-reset": reset } };
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
      const page = (items, sizeKey = "per_page") => {
        const perPage = Math.max(1, Number(target.searchParams.get(sizeKey)) || 30);
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
      /** Bitbucket's lists: `{ values, page, pagelen, size, next }`. */
      const bbPage = (items) => {
        const perPage = Math.max(1, Number(target.searchParams.get("pagelen")) || 10);
        const current = Math.max(1, Number(target.searchParams.get("page")) || 1);
        const result = { values: items.slice((current - 1) * perPage, current * perPage), page: current, pagelen: perPage, size: items.length };
        if (current * perPage < items.length) {
          const next = new URL(target);
          next.searchParams.set("page", String(current + 1));
          result.next = next.toString();
        }
        return json(200, result);
      };
      const path0 = target.pathname;
      const flavour = path0.startsWith("/api/v4")
        ? "gitlab"
        : path0.startsWith("/api/v3")
          ? "github"
          : path0.startsWith("/api/v1")
            ? "gitea"
            : path0.startsWith("/2.0/")
              ? "bitbucket"
              : path0.startsWith("/firma/")
                ? "azure"
                : "other";
      const notFound = (message) => json(404, { message });

      if (flavour === "other") return notFound("Not Found");
      const token = readToken(request.headers.authorization ?? "", flavour);
      if (token !== MOCK_TOKEN && token !== MOCK_WEAK_TOKEN) return json(401, { message: flavour === "gitlab" ? "401 Unauthorized" : "Bad credentials" });
      const forced = takeFailure(target.pathname);
      if (forced) {
        const answer = forcedAnswer(forced, flavour);
        return send(answer.status, answer.body, answer.headers);
      }
      const ctx = { method: request.method, path: target.pathname, query: target.searchParams, body, base, state, token, json, send, page, bbPage, notFound };
      const handlers = { github, gitlab, gitea, bitbucket, azure };
      return handlers[flavour](ctx);
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
      const paths = { github: "octo/demo", gitlab: "gruppe/unter/demo", gitea: "octo/demo", bitbucket: "team/demo", azure_devops: "firma/projekt/_git/demo" };
      return `${address}/${paths[kind] ?? paths.github}.git`;
    },
    /** `baseUrl` for `host_connect` – Azure DevOps keeps the organization in it. */
    baseUrl(kind = "github") {
      return kind === "azure_devops" ? `${address}/firma` : address;
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
  console.log(`  Gitea/Forgejo: baseUrl ${mock.baseUrl("gitea")}, Remote ${mock.remoteUrl("gitea")}`);
  console.log(`  Bitbucket: baseUrl ${mock.baseUrl("bitbucket")} (user name lena@example.org), Remote ${mock.remoteUrl("bitbucket")}`);
  console.log(`  Azure DevOps: baseUrl ${mock.baseUrl("azure_devops")}, Remote ${mock.remoteUrl("azure_devops")}`);
  console.log(`  Token: ${mock.token}   (without permission: ${mock.weakToken})`);
  if (mock.caFile) console.log(`  Certificate: ${mock.caFile}`);
  console.log("Stop with Ctrl+C.");
}
