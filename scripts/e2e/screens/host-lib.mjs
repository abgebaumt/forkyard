/**
 * Shared by hosts.mjs, pr-create.mjs and pr-view.mjs: a LOCAL host for testing and a repository whose remote
 * points to it.
 *
 * `startHost({ kind })` starts a small server on 127.0.0.1 that mimics the parts of the public
 * GitHub (`/api/v3/…`) or GitLab (`/api/v4/…`) REST API the core calls – with made-up data. No call
 * ever goes to a real service: the app gets this server's address as a "custom instance", and the
 * test repository's remote points to the same server (under `/<owner>/<name>.git` it forwards to
 * scripts/e2e/git-http-server.mjs, so fetch and push really run).
 *
 *   const host = await startHost({ kind: "github" });
 *   host.base                      // http://127.0.0.1:<port> – enter as the instance address
 *   host.token / host.badToken     // made-up tokens: one is valid, the other is not
 *   host.addPr({ number: 12, … })  // add a pull request
 *   host.requests                  // everything the app sent: [{ method, path, body, token }]
 *   host.set({ rateLimited: true }) / host.revoke(token) / host.set({ readOnly: true })
 *
 * The scripts also check that the token shows up nowhere: `tokenLeaks(app, token)`.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { isAlive, makeCleanRepoWithRemote } from "../fixtures.mjs";
import { startGitHttpServer } from "../git-http-server.mjs";

export const SHOTS = "target/e2e/shots";

export const PEOPLE = {
  lena: { login: "lena-hartmann", name: "Lena Hartmann", id: 101 },
  jonas: { login: "jonas", name: "Jonas Albrecht", id: 102 },
  aylin: { login: "aylin", name: "Aylin Demir", id: 103 },
  mats: { login: "mats-oeztuerk", name: "Mats Öztürk", id: 104 },
};

const GIT_USER = "lena";
const GIT_PASSWORD = "nur-fuer-den-testserver";
const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

// ---------------------------------------------------------------------------
// The local host
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {"github"|"gitlab"} options.kind
 * @param {string} [options.owner="schule"]  on GitLab this may be `group/subgroup`
 * @param {string} [options.name="messnetz"]
 */
export async function startHost({ kind, owner = "schule", name = "messnetz" }) {
  const git = await startGitHttpServer({ users: { [GIT_USER]: GIT_PASSWORD } });
  const bare = `${name}.git`;
  const full = `${owner}/${name}`;
  // Made up and known only to this server. The shape resembles real tokens so redaction and hints are tested as in real use.
  const prefix = kind === "github" ? "ghp_" : "glpat-";
  const token = `${prefix}TestTokenNurLokal${kind === "github" ? "A7c9" : "K4m2"}`;
  const badToken = `${prefix}FalschesTokenXXXX0000`;
  const narrowToken = `${prefix}ZuWenigRechteNurLesen5e5e`;
  const secondToken = `${prefix}ZweitesTokenNachErsatzQ8w1`;

  const state = {
    tokens: new Map([
      [token, { user: PEOPLE.lena, scopes: kind === "github" ? ["repo", "read:org"] : ["api"] }],
      [secondToken, { user: PEOPLE.lena, scopes: kind === "github" ? ["repo"] : ["api"] }],
      [narrowToken, { user: PEOPLE.lena, scopes: kind === "github" ? ["read:user"] : ["read_api"] }],
    ]),
    revoked: new Set(),
    rateLimited: false,
    /** Write calls are rejected with 403 ("no permission"). */
    readOnly: false,
    /** Delay responses by this many milliseconds. */
    delayMs: 0,
    defaultBranch: "main",
    canPush: true,
    forkParent: null,
    prs: [],
    /** Issues (issues.mjs); `addIssue` adds some. */
    issues: [],
    /** Reading issues is rejected with 403 ("no permission") or 404 (issues disabled). */
    issuesForbidden: false,
    issuesMissing: false,
    nextNumber: 40,
    nextCommentId: 9000,
    deletedBranches: [],
  };
  const requests = [];
  let base = "";

  const pr = (number) => state.prs.find((item) => item.number === Number(number)) ?? null;
  const web = (number) => (kind === "github" ? `${base}/${full}/pull/${number}` : `${base}/${full}/-/merge_requests/${number}`);

  // --- GitHub shape --------------------------------------------------------------------------
  const ghUser = (user) => (user ? { login: user.login, id: user.id, name: user.name, avatar_url: `${base}/avatars/${user.login}.png` } : null);
  const ghPr = (item) => ({
    number: item.number,
    title: item.title,
    body: item.body,
    state: item.state === "open" ? "open" : "closed",
    merged: item.state === "merged",
    merged_at: item.state === "merged" ? item.updatedAt : null,
    draft: item.draft,
    user: ghUser(item.author),
    head: { ref: item.source, sha: item.headSha, repo: { full_name: item.fork ? `${item.author.login}/${name}` : full } },
    base: { ref: item.target, repo: { full_name: full } },
    updated_at: item.updatedAt,
    html_url: web(item.number),
    labels: item.labels.map((label) => ({ name: label, color: "8250df" })),
    requested_reviewers: item.requested.map(ghUser),
    mergeable: item.mergeable,
  });
  const ghCheck = (check, index) => ({
    id: index + 1,
    name: check.name,
    status: check.state === "pending" ? "in_progress" : "completed",
    conclusion: check.state === "passing" ? "success" : check.state === "failing" ? "failure" : check.state === "skipped" ? "skipped" : null,
    html_url: check.url ?? null,
  });

  // --- GitLab shape --------------------------------------------------------------------------
  const glUser = (user) => (user ? { id: user.id, username: user.login, name: user.name, avatar_url: `${base}/avatars/${user.login}.png` } : null);
  const glPipeline = (item) => {
    const real = item.checks.filter((check) => check.state !== "skipped");
    if (!item.checks.length) return null;
    const status = real.some((check) => check.state === "failing") ? "failed" : real.some((check) => check.state === "pending") ? "running" : "success";
    return { id: 5000 + item.number, project_id: 77, status, web_url: `${base}/${full}/-/pipelines/${5000 + item.number}` };
  };
  const glMr = (item) => ({
    iid: item.number,
    id: 100_000 + item.number,
    title: item.draft && !/^Draft:/.test(item.title) ? `Draft: ${item.title}` : item.title,
    description: item.body,
    state: item.state === "open" ? "opened" : item.state,
    draft: item.draft,
    work_in_progress: item.draft,
    author: glUser(item.author),
    source_branch: item.source,
    target_branch: item.target,
    source_project_id: item.fork ? 78 : 77,
    target_project_id: 77,
    updated_at: item.updatedAt,
    web_url: web(item.number),
    labels: item.labels,
    reviewers: [...item.requested, ...item.reviews.filter((review) => review.state === "approved").map((review) => review.user)].map(glUser),
    sha: item.headSha,
    detailed_merge_status: item.mergeable === null ? "checking" : item.mergeable ? "mergeable" : "conflict",
    merge_status: item.mergeable ? "can_be_merged" : "cannot_be_merged",
    head_pipeline: glPipeline(item),
  });

  const json = (response, status, body, headers = {}) => {
    const text = body === undefined ? "" : JSON.stringify(body);
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text), ...headers });
    response.end(text);
  };
  const paged = (response, request, all) => {
    const url = new URL(request.url, base);
    const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get("per_page") ?? 30)));
    const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
    const slice = all.slice((page - 1) * perPage, page * perPage);
    const headers = {};
    if (page * perPage < all.length) {
      url.searchParams.set("page", String(page + 1));
      headers.Link = `<${url.toString()}>; rel="next"`;
      headers["X-Next-Page"] = String(page + 1);
    }
    json(response, 200, slice, headers);
  };

  /** New pull request from what the app sends – in the shape of the respective host. */
  const create = ({ title, body, source, target, draft, author }) => {
    const item = normalize({ number: state.nextNumber++, title, body, source, target, draft, author, updatedAt: iso(0), mergeable: true });
    state.prs.unshift(item);
    return item;
  };

  // --- Issues (issues) ---------------------------------------------------------------------------
  // Return true if they answered. Numbers without an issue are left to the pull request routes
  // (GitHub also lists their comments under `/issues/<n>`).
  const issue = (number) => state.issues.find((item) => item.number === Number(number)) ?? null;
  const issueWeb = (number) => (kind === "github" ? `${base}/${full}/issues/${number}` : `${base}/${full}/-/issues/${number}`);
  const issueBlocked = (response) => {
    if (state.issuesForbidden) return json(response, 403, kind === "github" ? { message: "Resource not accessible by personal access token" } : { message: "403 Forbidden" }), true;
    if (state.issuesMissing) return json(response, 404, kind === "github" ? { message: "Not Found" } : { message: "404 Project Not Found" }), true;
    return false;
  };
  const issuesIn = (wanted, words) => {
    const needle = (words ?? "").trim().toLowerCase();
    return state.issues
      .filter((item) => wanted === "all" || item.state === wanted)
      .filter((item) => !needle || `${item.title}\n${item.body}`.toLowerCase().includes(needle))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  };
  const ghIssue = (item) => ({
    number: item.number,
    title: item.title,
    body: item.body,
    state: item.state,
    user: ghUser(item.author),
    assignees: item.assignees.map(ghUser),
    labels: item.labels.map((label) => ({ name: label, color: "d73a4a" })),
    comments: item.comments.length,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    html_url: issueWeb(item.number),
  });
  const githubIssues = (request, response, url) => {
    const route = `${request.method} ${url.pathname.replace(/^\/api\/v3/, "")}`;
    const repo = `/repos/${full}`;
    let match;
    if (route === `GET ${repo}/issues`) {
      if (issueBlocked(response)) return true;
      const wanted = url.searchParams.get("state") ?? "open";
      // As on GitHub, open pull requests are in the list too (with `pull_request`); the core filters them out.
      const pulls = state.prs.filter((item) => item.state === "open" && wanted !== "closed").map((item) => ({ ...ghPr(item), pull_request: { url: `${base}/api/v3${repo}/pulls/${item.number}` } }));
      paged(response, request, [...issuesIn(wanted, "").map(ghIssue), ...pulls]);
      return true;
    }
    if (route === "GET /search/issues") {
      if (issueBlocked(response)) return true;
      const q = url.searchParams.get("q") ?? "";
      const wanted = /\bis:open\b/.test(q) ? "open" : /\bis:closed\b/.test(q) ? "closed" : "all";
      const words = q.replace(/\b(?:repo|is):\S+/g, " ").trim();
      const found = issuesIn(wanted, words).map(ghIssue);
      const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get("per_page") ?? 30)));
      const page = Math.max(1, Number(url.searchParams.get("page") ?? 1));
      const headers = {};
      if (page * perPage < found.length) {
        const next = new URL(request.url, base);
        next.searchParams.set("page", String(page + 1));
        headers.Link = `<${next.toString()}>; rel="next"`;
      }
      json(response, 200, { total_count: found.length, incomplete_results: false, items: found.slice((page - 1) * perPage, page * perPage) }, headers);
      return true;
    }
    if ((match = new RegExp(`^GET ${repo}/issues/(\\d+)(/comments)?$`).exec(route))) {
      const item = issue(match[1]);
      // No issue with this number: if it is a pull request, its routes answer.
      if (!item) return pr(match[1]) ? false : (json(response, 404, { message: "Not Found" }), true);
      if (issueBlocked(response)) return true;
      if (match[2]) paged(response, request, item.comments.map((comment) => ({ id: comment.id, user: ghUser(comment.author), body: comment.body, created_at: comment.createdAt })));
      else json(response, 200, ghIssue(item));
      return true;
    }
    return false;
  };
  const glIssue = (item) => ({
    iid: item.number,
    id: 200_000 + item.number,
    title: item.title,
    description: item.body,
    state: item.state === "open" ? "opened" : "closed",
    author: glUser(item.author),
    assignees: item.assignees.map(glUser),
    labels: item.labels,
    user_notes_count: item.comments.length,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    web_url: issueWeb(item.number),
  });
  /** `rest`: the path after `/projects/<id>`. */
  const gitlabIssues = (request, response, url, rest) => {
    const route = `${request.method} ${rest}`;
    let match;
    if (route === "GET /issues") {
      if (issueBlocked(response)) return true;
      const wanted = url.searchParams.get("state") ?? "opened";
      paged(response, request, issuesIn(wanted === "opened" ? "open" : wanted, url.searchParams.get("search")).map(glIssue));
      return true;
    }
    if ((match = /^GET \/issues\/(\d+)(\/notes)?$/.exec(route))) {
      if (issueBlocked(response)) return true;
      const item = issue(match[1]);
      if (!item) return json(response, 404, { message: "404 Not found" }), true;
      if (match[2]) paged(response, request, item.comments.map((comment) => ({ id: comment.id, author: glUser(comment.author), body: comment.body, created_at: comment.createdAt, system: Boolean(comment.system) })));
      else json(response, 200, glIssue(item));
      return true;
    }
    return false;
  };

  const github = (request, response, url, body, who) => {
    const route = `${request.method} ${url.pathname.replace(/^\/api\/v3/, "")}`;
    const repo = `/repos/${full}`;
    let match;
    if (githubIssues(request, response, url)) return;
    if (route === "GET /user") return json(response, 200, ghUser(who.user), { "X-OAuth-Scopes": who.scopes.join(", ") });
    if (route === `GET ${repo}`) {
      return json(response, 200, {
        full_name: full,
        default_branch: state.defaultBranch,
        html_url: `${base}/${full}`,
        permissions: { pull: true, push: state.canPush, admin: false },
        ...(state.forkParent ? { fork: true, parent: { name: state.forkParent.name, owner: { login: state.forkParent.owner }, html_url: `${base}/${state.forkParent.owner}/${state.forkParent.name}` } } : {}),
      });
    }
    if (route === `GET ${repo}/pulls`) {
      const wanted = url.searchParams.get("state") ?? "open";
      const list = state.prs.filter((item) => wanted === "all" || (wanted === "open" ? item.state === "open" : item.state !== "open"));
      return paged(response, request, list.map(ghPr));
    }
    if (route === `POST ${repo}/pulls`) {
      if (!body.title?.trim()) return json(response, 422, { message: "Validation Failed", errors: [{ resource: "PullRequest", field: "title", code: "missing_field" }] });
      const head = String(body.head ?? "").split(":").pop();
      if (state.prs.some((item) => item.state === "open" && item.source === head)) {
        return json(response, 422, { message: "Validation Failed", errors: [{ resource: "PullRequest", code: "custom", message: `A pull request already exists for ${owner}:${head}.` }] });
      }
      return json(response, 201, ghPr(create({ title: body.title, body: body.body ?? "", source: head, target: body.base, draft: Boolean(body.draft), author: who.user })));
    }
    if ((match = /^GET \/repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]+)\/(check-runs|status)$/.exec(route))) {
      const item = state.prs.find((candidate) => candidate.headSha === match[1]);
      if (match[2] === "status") return json(response, 200, { state: "success", statuses: [] });
      return json(response, 200, { total_count: item?.checks.length ?? 0, check_runs: (item?.checks ?? []).map(ghCheck) });
    }
    if ((match = new RegExp(`^(GET|PATCH) ${repo}/pulls/(\\d+)$`).exec(route))) {
      const item = pr(match[2]);
      if (!item) return json(response, 404, { message: "Not Found" });
      if (match[1] === "PATCH") {
        if (body.state === "closed" && item.state === "open") item.state = "closed";
        if (body.state === "open" && item.state === "closed") item.state = "open";
        if (typeof body.title === "string") item.title = body.title;
        if (typeof body.body === "string") item.body = body.body;
        item.updatedAt = iso(0);
      }
      return json(response, 200, ghPr(item));
    }
    if ((match = new RegExp(`^(GET|POST|PUT|DELETE) (?:${repo})/(pulls|issues)/(\\d+)/([a-z_]+)$`).exec(route))) {
      const [, method, family, number, what] = match;
      const item = pr(number);
      if (!item) return json(response, 404, { message: "Not Found" });
      if (method === "GET" && family === "pulls" && what === "reviews") {
        return paged(response, request, item.reviews.map((review, index) => ({ id: index + 1, user: ghUser(review.user), state: review.state.toUpperCase(), body: review.body ?? "", submitted_at: review.at ?? iso(90) })));
      }
      if (method === "GET" && family === "issues" && what === "comments") {
        return paged(response, request, item.comments.filter((comment) => !comment.path).map((comment) => ({ id: comment.id, user: ghUser(comment.author), body: comment.body, created_at: comment.createdAt })));
      }
      if (method === "GET" && family === "pulls" && what === "comments") {
        return paged(response, request, item.comments.filter((comment) => comment.path).map((comment) => ({ id: comment.id, user: ghUser(comment.author), body: comment.body, created_at: comment.createdAt, path: comment.path, line: comment.line })));
      }
      if (method === "GET" && family === "pulls" && what === "commits") {
        return paged(response, request, item.commits.map((commit) => ({ sha: commit.sha, commit: { message: commit.message, author: { name: commit.authorName, date: commit.date } } })));
      }
      if (method === "POST" && family === "issues" && what === "comments") {
        const comment = { id: state.nextCommentId++, author: who.user, body: String(body.body ?? ""), createdAt: iso(0), path: null, line: null };
        item.comments.push(comment);
        item.updatedAt = iso(0);
        return json(response, 201, { id: comment.id, user: ghUser(comment.author), body: comment.body, created_at: comment.createdAt });
      }
      if (method === "POST" && family === "pulls" && what === "requested_reviewers") {
        item.requested = (body.reviewers ?? []).map((login) => Object.values(PEOPLE).find((person) => person.login === login) ?? { login, name: login, id: 900 });
        return json(response, 201, ghPr(item));
      }
      if (method === "POST" && family === "issues" && what === "labels") {
        item.labels = [...new Set([...item.labels, ...(body.labels ?? [])])];
        return json(response, 200, item.labels.map((label) => ({ name: label, color: "8250df" })));
      }
      if (method === "PUT" && family === "pulls" && what === "merge") {
        if (item.state !== "open" || item.mergeable === false || item.draft) return json(response, 405, { message: "Pull Request is not mergeable" });
        item.state = "merged";
        item.mergedWith = body.merge_method;
        item.updatedAt = iso(0);
        return json(response, 200, { merged: true, message: "Pull Request successfully merged", sha: item.headSha });
      }
    }
    if ((match = new RegExp(`^DELETE ${repo}/git/refs/heads/(.+)$`).exec(route))) {
      state.deletedBranches.push(decodeURIComponent(match[1]));
      response.writeHead(204);
      return response.end();
    }
    if (route === `GET ${repo}/issues`) return json(response, 200, []);
    return json(response, 404, { message: "Not Found" });
  };

  const gitlab = (request, response, url, body, who) => {
    // `/projects/group%2Fname/…`: the encoded project id is one piece in the path.
    const raw = url.pathname.replace(/^\/api\/v4/, "");
    const project = `/projects/${encodeURIComponent(full)}`;
    const rest = raw.toLowerCase().startsWith(project.toLowerCase()) ? raw.slice(project.length) : null;
    const route = `${request.method} ${rest ?? raw}`;
    let match;
    if (rest !== null && gitlabIssues(request, response, url, rest)) return;
    if (rest === null) {
      if (route === "GET /user") return json(response, 200, glUser(who.user));
      if (route === "GET /personal_access_tokens/self") return json(response, 200, { id: 1, name: "forkyard", scopes: who.scopes, active: true });
      if (route === "GET /users") {
        const found = Object.values(PEOPLE).filter((person) => person.login === url.searchParams.get("username"));
        return json(response, 200, found.map(glUser));
      }
      if ((match = /^GET \/projects\/77\/pipelines\/(\d+)\/jobs$/.exec(route))) {
        const item = pr(Number(match[1]) - 5000);
        return paged(response, request, (item?.checks ?? []).map((check, index) => ({ id: index + 1, name: check.name, status: check.state === "passing" ? "success" : check.state === "failing" ? "failed" : check.state === "skipped" ? "skipped" : "running", web_url: check.url ?? null })));
      }
      return json(response, 404, { message: "404 Not Found" });
    }
    if (route === "GET ") {
      return json(response, 200, {
        id: 77,
        path_with_namespace: full,
        default_branch: state.defaultBranch,
        web_url: `${base}/${full}`,
        permissions: { project_access: { access_level: state.canPush ? 40 : 20 }, group_access: null },
        ...(state.forkParent ? { forked_from_project: { path_with_namespace: `${state.forkParent.owner}/${state.forkParent.name}`, web_url: `${base}/${state.forkParent.owner}/${state.forkParent.name}` } } : {}),
      });
    }
    if (route === "GET /merge_requests") {
      const wanted = url.searchParams.get("state") ?? "opened";
      const list = state.prs.filter((item) => wanted === "all" || (wanted === "opened" ? item.state === "open" : item.state === wanted));
      return paged(response, request, list.map(glMr));
    }
    if (route === "POST /merge_requests") {
      if (!body.title?.trim()) return json(response, 400, { message: { title: ["can't be blank"] } });
      const clash = state.prs.find((item) => item.state === "open" && item.source === body.source_branch);
      if (clash) return json(response, 409, { message: [`Another open merge request already exists for this source branch: !${clash.number}`] });
      const draft = /^Draft:/.test(body.title);
      const item = create({ title: body.title.replace(/^Draft:\s*/, ""), body: body.description ?? "", source: body.source_branch, target: body.target_branch, draft, author: who.user });
      if (typeof body.labels === "string" && body.labels) item.labels = body.labels.split(",");
      if (Array.isArray(body.reviewer_ids)) item.requested = body.reviewer_ids.map((id) => Object.values(PEOPLE).find((person) => person.id === id)).filter(Boolean);
      return json(response, 201, glMr(item));
    }
    if (route === "GET /issues") return json(response, 200, []);
    if ((match = /^(GET|PUT|POST) \/merge_requests\/(\d+)(?:\/([a-z_]+))?$/.exec(route))) {
      const [, method, number, what] = match;
      const item = pr(number);
      if (!item) return json(response, 404, { message: "404 Not found" });
      if (!what && method === "GET") return json(response, 200, glMr(item));
      if (!what && method === "PUT") {
        if (body.state_event === "close" && item.state === "open") item.state = "closed";
        if (body.state_event === "reopen" && item.state === "closed") item.state = "open";
        if (typeof body.title === "string") item.title = body.title;
        item.updatedAt = iso(0);
        return json(response, 200, glMr(item));
      }
      if (what === "approvals" && method === "GET") {
        return json(response, 200, { approved_by: item.reviews.filter((review) => review.state === "approved").map((review) => ({ user: glUser(review.user) })), approvals_left: 0 });
      }
      if (what === "notes" && method === "GET") {
        return paged(response, request, item.comments.map((comment) => ({ id: comment.id, author: glUser(comment.author), body: comment.body, created_at: comment.createdAt, system: false, ...(comment.path ? { position: { new_path: comment.path, new_line: comment.line } } : {}) })));
      }
      if (what === "notes" && method === "POST") {
        const comment = { id: state.nextCommentId++, author: who.user, body: String(body.body ?? ""), createdAt: iso(0), path: null, line: null };
        item.comments.push(comment);
        return json(response, 201, { id: comment.id, author: glUser(comment.author), body: comment.body, created_at: comment.createdAt, system: false });
      }
      if (what === "commits" && method === "GET") {
        return paged(response, request, item.commits.map((commit) => ({ id: commit.sha, title: commit.message.split("\n")[0], author_name: commit.authorName, authored_date: commit.date })));
      }
      if (what === "merge" && method === "PUT") {
        if (item.state !== "open" || item.mergeable === false || item.draft) return json(response, 405, { message: "405 Method Not Allowed" });
        item.state = "merged";
        item.mergedWith = body.squash ? "squash" : "merge";
        if (body.should_remove_source_branch) state.deletedBranches.push(item.source);
        item.updatedAt = iso(0);
        return json(response, 200, glMr(item));
      }
    }
    return json(response, 404, { message: "404 Not Found" });
  };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    // Git itself (fetch, push) goes to the Git server behind; the proxy adds its login.
    const gitPrefix = `/${full}.git`;
    if (decodeURIComponent(url.pathname).startsWith(gitPrefix)) {
      const target = `/${bare}${decodeURIComponent(url.pathname).slice(gitPrefix.length)}${url.search}`;
      const upstream = http.request(
        { host: "127.0.0.1", port: git.port, method: request.method, path: target, headers: { ...request.headers, host: `127.0.0.1:${git.port}`, authorization: `Basic ${Buffer.from(`${GIT_USER}:${GIT_PASSWORD}`).toString("base64")}` } },
        (answer) => {
          response.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(response);
        },
      );
      upstream.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      request.pipe(upstream);
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = { unreadable: text };
      }
      const sent = /^Bearer\s+(.+)$/i.exec(request.headers.authorization ?? "")?.[1] ?? null;
      const entry = { method: request.method, path: decodeURIComponent(url.pathname), query: url.search, body, token: sent, status: 0, at: Date.now() };
      requests.push(entry);
      const answer = () => {
        response.on("finish", () => {
          entry.status = response.statusCode;
        });
        const api = kind === "github" ? "/api/v3" : "/api/v4";
        if (!url.pathname.startsWith(`${api}/`)) return json(response, 404, { message: "Not Found" });
        const who = sent && !state.revoked.has(sent) ? state.tokens.get(sent) : null;
        if (!who) return json(response, 401, kind === "github" ? { message: "Bad credentials" } : { message: "401 Unauthorized" });
        if (state.rateLimited) {
          return kind === "github"
            ? json(response, 403, { message: "API rate limit exceeded for user." }, { "X-RateLimit-Limit": "5000", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(Math.floor(Date.now() / 1000) + 1800) })
            : json(response, 429, { message: "429 Too Many Requests" }, { "Retry-After": "1800", "RateLimit-Remaining": "0" });
        }
        if (state.readOnly && request.method !== "GET") {
          return json(response, 403, kind === "github" ? { message: "Resource not accessible by personal access token" } : { message: "403 Forbidden" });
        }
        return kind === "github" ? github(request, response, url, body, who) : gitlab(request, response, url, body, who);
      };
      if (state.delayMs) setTimeout(answer, state.delayMs);
      else answer();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  function normalize(input) {
    return {
      title: "",
      body: "",
      state: "open",
      draft: false,
      author: PEOPLE.jonas,
      target: "main",
      updatedAt: iso(180),
      headSha: "0".repeat(40),
      mergeable: true,
      checks: [],
      reviews: [],
      requested: [],
      comments: [],
      commits: [],
      labels: [],
      fork: false,
      ...input,
    };
  }

  return {
    kind,
    owner,
    name,
    full,
    base,
    /** Repository address for `git remote` – the same server, so the core recognizes the host. */
    remoteUrl: `${base}/${full}.git`,
    webUrl: `${base}/${full}`,
    token,
    badToken,
    narrowToken,
    secondToken,
    requests,
    state,
    git,
    bare,
    /** Creates the bare repository behind the remote, as a copy of `from`. */
    publish(from) {
      return git.createBare(bare, { from });
    },
    /** git in the bare repository on the server (no network). */
    serverGit: (...args) => git.git(bare, ...args),
    addPr(input) {
      const item = normalize(input);
      state.prs = [...state.prs.filter((existing) => existing.number !== item.number), item].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
      return item;
    },
    pr,
    webUrlOf: web,
    /** Adds an issue (issues.mjs): `{ number, title, body?, state?, author?, assignees?, labels?, comments?, updatedAt? }`. */
    addIssue(input) {
      const item = { title: "", body: "", state: "open", author: PEOPLE.jonas, assignees: [], labels: [], comments: [], createdAt: iso(600), updatedAt: iso(180), ...input };
      item.comments = item.comments.map((comment) => ({ id: state.nextCommentId++, author: PEOPLE.aylin, body: "", createdAt: iso(60), ...comment }));
      state.issues = [...state.issues.filter((existing) => existing.number !== item.number), item];
      return item;
    },
    issue,
    issueWebUrlOf: issueWeb,
    set(patch) {
      Object.assign(state, patch);
    },
    revoke(value) {
      state.revoked.add(value);
    },
    /** Calls since `from`, optionally filtered: `sent("POST", /\/pulls$/)`. */
    sent(method, pattern, from = 0) {
      return requests.slice(from).filter((entry) => entry.method === method && pattern.test(entry.path));
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
      await git.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Repository and data
// ---------------------------------------------------------------------------

export const TEMPLATE = "## Was ändert sich?\n\n## Wie getestet?\n\n- [ ] Tests laufen\n";

/** Description with everything the view must NOT run or load. */
export const EVIL_BODY = [
  "## Was",
  "",
  "Schreibt den Vergleich als **CSV**. Siehe [Projektseite](https://example.org/projekt) und [Skript-Link](javascript:alert(1)).",
  "",
  "<script>window.__evil = (window.__evil || 0) + 1</script>",
  '<img src=x onerror="window.__evil = (window.__evil || 0) + 1">',
  "",
  "![Diagramm](https://example.org/diagramm.png)",
  "",
  '<iframe src="https://example.org"></iframe>',
  '<a href="https://example.org/klick" onclick="window.__evil = 99">Klick</a>',
  "",
  "- [x] Export",
  "- [ ] Doku",
  "",
  "```py",
  "def zeile(station, wert):",
  '    return f"{station};{wert}"',
  "```",
].join("\n");

export const LONG_TITLE = "Plausibilitätsprüfung für alle Sensoren eingeführt, damit Ausreißer des Datenloggers bei Frost nicht länger unbemerkt in die Tagesmittel und Monatsberichte gelangen";
export const LONG_BRANCH = "thema/plausibilitaetspruefung-fuer-alle-sensoren-mit-einem-sehr-langen-branch-namen";

/**
 * Repository "messnetz" whose `origin` points to the local host. Branches:
 *   main                    pushed
 *   feature/export          pushed, 1 commit ahead of main → pull request #12
 *   thema/neue-auswertung   local only, 1 commit           → title from the commit
 *   thema/zwei-schritte     local only, 2 commits          → title from the branch name
 *   station/hafen           server only, 1 commit          → pull request #9, commits missing locally
 * Plus a pull request template in the working directory (committed on main).
 */
export function makeHostRepo(host, { name = "messnetz" } = {}) {
  const repo = makeCleanRepoWithRemote({ name: `${name}-${host.kind}` });
  const sha = {};
  // Template on main – and main pushed to the old remote right away, so the state is the same everywhere.
  repo.write(host.kind === "github" ? ".github/pull_request_template.md" : ".gitlab/merge_request_templates/Default.md", TEMPLATE);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Vorlage für Pull Requests");
  repo.git("push", "-q", "origin", "main");
  sha.main = repo.git("rev-parse", "main");
  sha.feature = repo.git("rev-parse", "feature/export");

  // Server only: a commit on station/hafen that someone else pushed. Locally there is neither the
  // branch nor the commit – only a fetch brings it.
  repo.git("push", "-q", "origin", "main:refs/heads/station/hafen");
  repo.git("update-ref", "-d", "refs/remotes/origin/station/hafen");
  sha.hafen = repo.commitOnRemote({ branch: "station/hafen", file: "stationen/hafen.md", content: "# Hafen\n\nDritte Station, 3 m über dem Meer.\n", message: "Hafenstation ergänzt" });

  // The server gets what has been pushed so far.
  host.publish(repo.remotePath);
  repo.git("remote", "set-url", "origin", host.remoteUrl);

  // Local only.
  repo.git("checkout", "-q", "-b", "thema/zwei-schritte", "main");
  repo.write("docs/schritt-1.md", "# Schritt 1\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Erster Schritt");
  repo.write("docs/schritt-2.md", "# Schritt 2\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Zweiter Schritt");
  repo.git("checkout", "-q", "-b", "thema/neue-auswertung", "main");
  repo.write("auswertung.md", "# Auswertung\n\nMonatsmittel je Station.\n");
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Auswertung als eigenes Dokument");
  sha.auswertung = repo.git("rev-parse", "HEAD");
  return { repo, sha };
}

/** The pull requests the scripts work with. */
export function seedPrs(host, sha) {
  host.addPr({
    number: 12,
    title: "CSV-Export für den Vergleich",
    body: EVIL_BODY,
    author: PEOPLE.jonas,
    source: "feature/export",
    headSha: sha.feature,
    updatedAt: iso(60),
    checks: [
      { name: "build", state: "passing", url: `${host.base}/ci/build` },
      { name: "test (windows)", state: "passing", url: null },
      { name: "lint", state: "skipped", url: null },
    ],
    reviews: [{ user: PEOPLE.aylin, state: "approved" }],
    requested: [PEOPLE.lena],
    labels: ["export", "daten"],
    comments: [
      { id: 501, author: PEOPLE.lena, body: "Sieht gut aus. Fehlt noch der **Kopf** der Datei?", createdAt: iso(50), path: null, line: null },
      { id: 502, author: PEOPLE.jonas, body: "Kommt im nächsten Commit.", createdAt: iso(40), path: "src/export.py", line: 4 },
    ],
    commits: [{ sha: sha.feature, message: "CSV-Export für den Vergleich", authorName: "Jonas Albrecht", date: iso(600) }],
  });
  host.addPr({
    number: 14,
    title: LONG_TITLE,
    author: PEOPLE.lena,
    source: LONG_BRANCH,
    headSha: "1".repeat(40),
    updatedAt: iso(120),
    mergeable: false,
    checks: [
      { name: "build", state: "passing", url: null },
      { name: "test (linux)", state: "failing", url: `${host.base}/ci/test` },
    ],
    reviews: [{ user: PEOPLE.jonas, state: "changes_requested", body: "Bitte die Grenzwerte belegen." }],
    commits: [{ sha: "1".repeat(40), message: "Plausibilitätsprüfung", authorName: "Lena Hartmann", date: iso(700) }],
  });
  host.addPr({
    number: 15,
    title: "Regensumme je Monat",
    draft: true,
    author: PEOPLE.lena,
    source: "thema/regen",
    headSha: "2".repeat(40),
    updatedAt: iso(200),
    checks: [{ name: "build", state: "pending", url: null }],
  });
  host.addPr({
    number: 9,
    title: "Hafenstation ergänzt",
    author: PEOPLE.aylin,
    source: "station/hafen",
    headSha: sha.hafen,
    updatedAt: iso(300),
    commits: [{ sha: sha.hafen, message: "Hafenstation ergänzt", authorName: "Aylin Demir", date: iso(900) }],
  });
}

/** Many open pull requests (for loading more and long lists). */
export function seedMany(host, count = 45) {
  for (let index = 0; index < count; index++) {
    host.addPr({ number: 100 + index, title: `Messlauf ${String(index + 1).padStart(3, "0")} nachgetragen`, author: index % 3 === 0 ? PEOPLE.lena : PEOPLE.mats, source: `messlauf/${String(index + 1).padStart(3, "0")}`, headSha: (3 + (index % 6)).toString().repeat(40), updatedAt: iso(1000 + index) });
  }
}

// ---------------------------------------------------------------------------
// Interaction and checks
// ---------------------------------------------------------------------------

/** Connect an account, bypassing the UI (for scripts that check something else). */
export async function connectDirect(app, host, token = host.token) {
  const account = await app.invoke("host_connect", { kind: host.kind, baseUrl: host.base, token });
  await refreshHostQueries(app);
  return account;
}

/** Reload accounts, the repository's host and pull requests – as after a core event. */
export async function refreshHostQueries(app) {
  await app.page.evaluate(() => {
    const client = window.__gc.queryClient;
    return Promise.all([
      client.invalidateQueries({ queryKey: ["app", "hostAccounts"] }),
      client.invalidateQueries({ predicate: (query) => query.queryKey[0] === "repo" && ["hostRepo", "prs", "pr", "prTemplate"].includes(String(query.queryKey[2])) }),
    ]);
  });
  await app.settle();
}

/**
 * Where does the token appear? Searches the document (including attributes and field values), the
 * query cache, the store, localStorage and sessionStorage and the console messages.
 * Empty list = nowhere.
 */
export async function tokenLeaks(app, token, { allowField = false } = {}) {
  const found = await app.page.evaluate(
    ([secret, fieldAllowed]) => {
      const places = [];
      if (document.documentElement.outerHTML.includes(secret)) places.push("document (HTML)");
      if ((document.body.innerText ?? "").includes(secret)) places.push("visible text");
      for (const field of document.querySelectorAll("input, textarea")) {
        if (field.value.includes(secret) && !(fieldAllowed && field.type === "password")) places.push(`field ${field.name || field.type}`);
        if ((field.getAttribute("value") ?? "").includes(secret)) places.push(`value attribute of ${field.name || field.type}`);
        if (field.value.includes(secret) && field.type !== "password") places.push(`field ${field.name || field.type} is not a password field`);
      }
      const seen = new WeakSet();
      const dump = (value) => {
        try {
          return JSON.stringify(value, (_key, item) => {
            if (typeof item === "object" && item !== null) {
              if (seen.has(item)) return undefined;
              seen.add(item);
            }
            return typeof item === "function" ? undefined : item;
          });
        } catch {
          return "";
        }
      };
      const cache = window.__gc.queryClient.getQueryCache().getAll().map((query) => ({ key: query.queryKey, data: query.state.data, error: String(query.state.error?.message ?? "") }));
      if ((dump(cache) ?? "").includes(secret)) places.push("query cache");
      if ((dump(window.__gc.store.getState()) ?? "").includes(secret)) places.push("store");
      for (const [name, storage] of [["localStorage", localStorage], ["sessionStorage", sessionStorage]]) {
        for (let index = 0; index < storage.length; index++) {
          const key = storage.key(index);
          if (`${key}=${storage.getItem(key)}`.includes(secret)) places.push(`${name}: ${key}`);
        }
      }
      return places;
    },
    [token, allowField],
  );
  if (app.consoleErrors.some((line) => line.includes(token))) found.push("console");
  return found;
}

/**
 * Separate keychain service name per run (`FORKYARD_KEYRING_SERVICE`): this run's entries can be
 * found in the system keychain – and nothing is left under the real app's name.
 */
export const keyringName = (script) => `forkyard-e2e-${script}-${process.pid}`;

/** This run's entries in the Windows Credential Manager (`cmdkey /list`); elsewhere: empty. */
export function keychainEntries(service) {
  if (process.platform !== "win32") return [];
  const out = execFileSync("cmdkey", ["/list"], { windowsHide: true }).toString("utf8");
  return out.split(/\r?\n/).filter((line) => line.includes(service));
}

/**
 * Removes entries of aborted runs from the keychain (made-up tokens for the local host): everything
 * under `forkyard-e2e-<script>-<pid>` whose process is no longer alive. At the start of every script.
 */
export function sweepKeychain() {
  if (process.platform !== "win32") return 0;
  let removed = 0;
  const out = execFileSync("cmdkey", ["/list"], { windowsHide: true }).toString("utf8");
  for (const match of out.matchAll(/target=(\S+\.forkyard-e2e-[a-z0-9]+-(\d+))\s*$/gim)) {
    if (isAlive(Number(match[2]))) continue;
    try {
      execFileSync("cmdkey", [`/delete:${match[1]}`], { windowsHide: true, stdio: "ignore" });
      removed += 1;
    } catch {
      // already gone
    }
  }
  return removed;
}

/** Is the token in a file (app log, database)? */
export function fileContains(file, token) {
  try {
    return fs.readFileSync(file).includes(Buffer.from(token, "utf8"));
  } catch {
    return false;
  }
}

/** All files under `dir` that contain the token (app data dir: SQLite, logs). */
export function filesContaining(dir, token) {
  const hits = [];
  const walk = (folder) => {
    let entries = [];
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (fileContains(full, token)) hits.push(full);
    }
  };
  walk(dir);
  return hits;
}

/** Records what the page writes to the console (all levels) – to search it for the token. */
export function recordConsole(app) {
  const lines = [];
  app.page.on("console", (message) => lines.push(`[${message.type()}] ${message.text()}`));
  return lines;
}

/** Run a command via the command palette – keyboard only. */
export async function runCommand(app, text, commandId) {
  const { page } = app;
  await page.keyboard.press("Control+p");
  await page.locator('[data-screen="command-palette"] input[role="combobox"]').waitFor({ timeout: 10_000 });
  await page.keyboard.type(`>${text}`, { delay: 5 });
  const keys = () => page.locator('[data-screen="command-palette"] [role="option"]').evaluateAll((rows) => rows.map((row) => row.dataset.key));
  const deadline = Date.now() + 10_000;
  while (!(await keys()).includes(`command:${commandId}`)) {
    if (Date.now() > deadline) throw new Error(`The palette does not find "${text}" (${commandId}). Present: ${JSON.stringify(await keys())}`);
    await page.waitForTimeout(80);
  }
  const index = (await keys()).indexOf(`command:${commandId}`);
  for (let step = 0; step < index; step++) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.locator('[data-screen="command-palette"]').waitFor({ state: "detached", timeout: 10_000 });
}

/** Accessible name of the focused element (aria-label, <label for>, else its text). */
export const focusedName = (page) =>
  page.evaluate(() => {
    const element = document.activeElement;
    if (!element || element === document.body) return null;
    const aria = element.getAttribute("aria-label");
    if (aria) return aria.trim();
    const label = element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`) : null;
    if (label?.textContent) return label.textContent.trim();
    return (element.textContent ?? "").trim().replace(/\s+/g, " ");
  });

/** Press Tab (or Shift+Tab) until the element with this name has focus. */
export async function tabTo(page, wanted, { back = false, max = 60 } = {}) {
  const matches = (name) => name !== null && (wanted instanceof RegExp ? wanted.test(name) : name === wanted);
  const seen = [];
  for (let step = 0; step <= max; step++) {
    const name = await focusedName(page);
    if (matches(name)) return name;
    seen.push(name);
    await page.keyboard.press(back ? "Shift+Tab" : "Tab");
  }
  throw new Error(`Not reachable by Tab: ${wanted}. Visited: ${seen.join(" → ")}`);
}

/** Does anything stick out sideways from the box, or does the page scroll horizontally? Empty list = everything fits. */
export const escaping = (page, selector) =>
  page.evaluate((target) => {
    const root = document.querySelector(target);
    const box = root?.getBoundingClientRect();
    if (!root || !box) return ["box missing"];
    const out = [];
    if (document.documentElement.scrollWidth > document.documentElement.clientWidth) out.push("the page scrolls horizontally");
    for (const element of root.querySelectorAll("*")) {
      const rect = element.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      let clipped = false;
      for (let parent = element.parentElement; parent && parent !== root.parentElement; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (style.overflowX !== "visible" || style.overflowY !== "visible") {
          clipped = true;
          break;
        }
      }
      if (!clipped && (rect.right > box.right + 1 || rect.left < box.left - 1)) out.push((element.textContent ?? element.tagName).trim().slice(0, 40));
    }
    return out;
  }, selector);
