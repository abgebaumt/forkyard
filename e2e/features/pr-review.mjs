/**
 * PR review (8.3) in the real app: comments on diff lines, drafts, "Submit review" with a verdict,
 * resolve and reopen – on all five hosts of e2e/fixtures/host-mock.mjs (127.0.0.1, nothing reaches
 * a real service). Every check of what went out reads the mock's `state.reviewRequests`.
 *
 * Pull request #9 points at a real local commit (branch feature/pruefung, one file changed), so the
 * Files tab shows the app's own diff of it. Tokens live in a private Secret Service of this process.
 *
 * - main: GitHub – threads at their lines, outdated thread above the diff, draft by C survives a
 *   restart, range comment sent at once, Approve review with the draft;
 * - main: GitHub – a review started in the browser takes the local draft (no second review);
 * - main: GitLab – comment on an unchanged line, Approve (draft note, bulk publish, approve), resolve
 *   and reopen a discussion;
 * - main: Gitea/Forgejo – Approve and Request changes on a foreign PR, only Comment on the own one;
 * - edge: Bitbucket – a failing draft stays with its error and withholds the vote, fixed and sent again;
 * - main: Azure DevOps – range comment, resolve as fixed, Request changes (vote -5);
 * - edge: the local diff is not the PR head – no comment buttons, a hint with Fetch.
 *
 *   node e2e/features/pr-review.mjs
 *   E2E_WD_ONLY="GitLab" node e2e/features/pr-review.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../driver.mjs";
import { until } from "../fixtures/commit-ui.mjs";
import { makeCleanRepoWithRemote } from "../fixtures/fixtures.mjs";
import { startPrivateKeyring } from "../fixtures/github-gitlab-host.mjs";
import { startHostMock } from "../fixtures/host-mock.mjs";
import { assert, assertEqual, assertIncludes, scenario } from "../lib.mjs";

const PRV = '[data-screen="pr-view"]';
const FILES = `${PRV} [data-pr-files="local"]`;
const DIALOG = '[role="dialog"]:has([data-screen="pr-review-submit"])';
const COMPOSER = `${PRV} [data-review-composer]`;
const FIELD = `${COMPOSER} textarea[name="review-comment"]`;
const SUBMIT_OPEN = `${PRV} [data-review-submit-open]`;
const BRANCH = "feature/pruefung";
const FILE = "src/pruefung.rs";
const BODY = "Hier fehlt die Prüfung auf leer.";

/** Before: 24 lines. After: line 12 changed, two lines added after line 14 (new 15 and 16). */
const BEFORE = Array.from({ length: 24 }, (_, i) => `let wert_${i + 1} = ${i + 1};`);
const AFTER = [
  ...BEFORE.slice(0, 11),
  "let wert_12 = pruefe(12)?;",
  ...BEFORE.slice(12, 14),
  "// leer?",
  "pruefe_leer(wert_12)?;",
  ...BEFORE.slice(14),
];

/** The mock's target commit of every pull request (`diff_refs.base_sha` on GitLab). */
const MOCK_BASE = (1000).toString(16).padStart(40, "0");

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const locales = new Map();
/** English UI text straight from the locale files. */
function str(key, vars = {}) {
  const [area, ...rest] = key.split(".");
  if (!locales.has(area))
    locales.set(area, JSON.parse(fs.readFileSync(path.join(ROOT, "src", "i18n", "locales", "en", `${area}.json`), "utf8")));
  let value = locales.get(area);
  for (const part of rest) value = value?.[part];
  if (typeof value !== "string") throw new Error(`no English text for ${key}`);
  return value.replace(/\{\{(\w+)\}\}/g, (_, name) => String(vars[name] ?? ""));
}

let failures = 0;

/** Runs a scenario body and always runs the registered cleanups (last first). */
const withCleanup = (fn) => async (t) => {
  t.cleanups = [];
  try {
    await fn(t);
  } catch (error) {
    // Before the cleanups take the mock and the keyring away.
    await t.shot(`fail-${++failures}`).catch(() => undefined);
    throw error;
  } finally {
    for (const cleanup of t.cleanups.reverse()) {
      try {
        await cleanup();
      } catch {
        // best effort
      }
    }
  }
};

/** A repository whose origin is the mock's repository for `kind`; feature/pruefung is one commit ahead of main. */
function makeReviewRepo(kind, mock) {
  const repo = makeCleanRepoWithRemote({ name: `review-${kind}` });
  repo.git("remote", "set-url", "origin", mock.remoteUrl(kind));
  repo.write(FILE, `${BEFORE.join("\n")}\n`);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Werte angelegt");
  repo.git("checkout", "-q", "-b", BRANCH);
  repo.write(FILE, `${AFTER.join("\n")}\n`);
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Prüfung auf leere Eingabe");
  const head = repo.git("rev-parse", "HEAD").trim();
  repo.git("checkout", "-q", "main");
  return { repo, head };
}

/**
 * Mock, keyring, repository (pull request `number` → feature/pruefung) and the app with an account.
 * `prepare(mock, head)` fills the mock's state before the app starts.
 */
async function setUp(t, kind, { prepare, overrides = {}, numbers = [9] } = {}) {
  const mock = await startHostMock();
  const keyring = await startPrivateKeyring();
  if (!keyring.private) throw new Error("no private Secret Service (dbus-daemon + gnome-keyring-daemon needed)");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fy-review-data-"));
  t.cleanups.push(
    () => mock.close(),
    () => keyring.close(),
    () => fs.rmSync(dataDir, { recursive: true, force: true }),
  );
  const { repo, head } = makeReviewRepo(kind, mock);
  t.cleanups.push(() => repo.cleanup());
  for (const number of numbers)
    mock.state.prOverrides.set(number, {
      source: BRANCH,
      head,
      commits: [{ sha: head, message: "Prüfung auf leere Eingabe" }],
      ...(overrides[number] ?? {}),
    });
  prepare?.(mock, head);
  const env = { ...keyring.env };
  const app = await launch(t, env, dataDir);
  // The last launched app (after a restart the new one) removes the account and its token.
  t.cleanups.push(async () => {
    for (const account of await t.app.invoke("host_accounts")) await t.app.invoke("host_disconnect", { accountId: account.id });
  });
  const { tabId } = await app.openRepo(repo.path);
  await connect(app, kind, mock);
  return { mock, repo, head, app, tabId, env, dataDir };
}

/** The account at the mock (the token goes into the keychain of this launch), then fresh queries. */
async function connect(app, kind, mock) {
  await app.invoke("host_connect", {
    kind,
    baseUrl: mock.baseUrl(kind),
    token: mock.token,
    ...(kind === "bitbucket" ? { username: "lena@example.org" } : {}),
  });
  await refresh(app);
}

async function launch(t, env, dataDir) {
  const app = await t.launch({ width: 1440, height: 900, theme: "light", lang: "en", env, dataDir });
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
  return app;
}

/** Reload accounts and everything of the repository, as after a core event. */
async function refresh(app) {
  await app.exec(() =>
    Promise.all([
      window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "hostAccounts"] }),
      window.__gc.queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === "repo" }),
    ]).then(() => true),
  );
  await app.settle();
}

/** Opens pull request `number` and its Files tab; waits for the diff rows. */
async function openFiles(app, tabId, number = 9) {
  await app.exec((id, n) => window.__gc.store.getState().setCenter(id, { kind: "pr", number: n }), tabId, number);
  await app.waitFor(`${PRV}[data-pr-number="${number}"] [data-pr-head]`, 30_000, { message: `view of #${number}` });
  await app.click({ text: "Files", within: `${PRV} [role="tablist"]` });
  await app.waitFor(`${FILES} [role="row"][data-kind]`, 30_000, { message: "diff rows of the pull request" });
  await app.settle();
}

/** The code cell of the diff row with this new (or, for `kind: "remove"`, old) line number. */
async function codeCell(app, line, kind = null) {
  return app.waitFor(
    () =>
      app.exec(
        (root, no, want) => {
          for (const row of document.querySelectorAll(`${root} [role="row"][data-kind]`)) {
            const cells = row.querySelectorAll('[data-gutter] > [role="gridcell"]');
            const removed = row.dataset.kind === "remove";
            if (want ? row.dataset.kind !== want : removed) continue;
            const number = (removed ? cells[0] : cells[1])?.textContent.trim();
            if (number === String(no)) return row.children[1];
          }
          return null;
        },
        FILES,
        line,
        kind,
      ),
    10_000,
    { message: `diff row of line ${line}` },
  );
}

/** Puts the diff cursor on a line (click into its code) and waits until that row has the focus. */
async function cursorTo(app, line, kind = null) {
  // The rows re-render when threads or drafts reload: a cell found a moment ago may be replaced; find it again.
  let cell = null;
  for (let attempt = 1; ; attempt++) {
    cell = await codeCell(app, line, kind);
    try {
      await app.click(cell);
      break;
    } catch (error) {
      if (attempt >= 3 || !/stale element reference/.test(error.message)) throw error;
    }
  }
  await app.waitFor(() => app.exec((el) => document.activeElement === el.closest('[role="row"]'), cell), 5000, {
    message: `focus on line ${line}`,
  });
}

/** Writes into a React-controlled field (replaces its text). */
const setField = (app, css, value) =>
  app.exec(
    (selector, next) => {
      const field = document.querySelector(selector);
      if (!field) throw new Error(`no field ${selector}`);
      const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(field, next);
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.focus();
      return true;
    },
    css,
    value,
  );

/** C on a line, the text, then "Add to review" (or "Comment now" with `now`). */
async function comment(app, line, body, { now = false, kind = null } = {}) {
  await cursorTo(app, line, kind);
  await app.press("c");
  await app.waitFor(FIELD, 5000, { message: "comment box after C" });
  await app.type(FIELD, body);
  await clickInComposer(app, now ? "[data-review-comment-now]" : "[data-review-add]");
  await app.waitFor(async () => !(await present(app, COMPOSER)), 15_000, { message: "comment box closes after sending" });
}

/** A button of the comment box, scrolled into the diff's view first (a box under the last visible line is cut off). */
async function clickInComposer(app, css) {
  const button = await app.waitFor(`${COMPOSER} ${css}:not([disabled])`, 5000, { message: `${css} in the comment box` });
  await app.exec((el) => el.scrollIntoView({ block: "nearest" }), button);
  await app.click(button);
}

const present = (app, css) => app.exec((selector) => Boolean(document.querySelector(selector)), css);
const text = (app, css) => app.exec((selector) => document.querySelector(selector)?.innerText.replace(/\s+/g, " ").trim() ?? null, css);
const count = (app, css) => app.exec((selector) => document.querySelectorAll(selector).length, css);

/** The dialog's footer button "Submit review" (the title has the same text). */
async function clickDialogSubmit(app) {
  const button = await app.waitFor(
    () =>
      app.exec(
        (css, label) => [...document.querySelectorAll(`${css} button`)].find((b) => b.innerText.trim() === label && !b.disabled) ?? null,
        DIALOG,
        str("pullRequest.view.review.submit"),
      ),
    5000,
    { message: "Submit review in the dialog" },
  );
  await app.click(button);
}

/** "Submit review (n)" → verdict, optional text → submit. Returns once the dialog is gone (or stays with failures). */
async function submitReview(app, { vote = null, body = "", expectClose = true } = {}) {
  await app.click(`${SUBMIT_OPEN}:not([disabled])`);
  await app.waitFor(DIALOG, 5000, { message: "submit dialog" });
  if (vote) await app.click({ text: str(`pullRequest.view.review.${vote}`), within: DIALOG });
  if (body) await app.type(`${DIALOG} textarea[name="review-body"]`, body);
  await clickDialogSubmit(app);
  if (expectClose) await app.waitFor(async () => !(await present(app, DIALOG)), 15_000, { message: "dialog closes after sending" });
}

/** Objects with their keys sorted, recursively. */
const sorted = (value) =>
  Array.isArray(value)
    ? value.map(sorted)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sorted(value[key])]),
        )
      : value;

/** A JSON body as sent, regardless of key order. */
const assertBody = (actual, expected, message = "request body") => assertEqual(sorted(actual), sorted(expected), message);

/** The review writes the mock received, as "METHOD path" (query left out). */
const calls = (mock) => mock.state.reviewRequests.map((entry) => `${entry.method} ${entry.path}`);

// ---------------------------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------------------------

/** GitHub GraphQL review-thread node. */
const ghThread = (id, databaseId, line, { outdated = false, body = "Bitte den Fehlerfall benennen.", head }) => ({
  id,
  isResolved: false,
  isOutdated: outdated,
  path: FILE,
  line: outdated ? null : line,
  startLine: null,
  originalLine: line,
  originalStartLine: null,
  diffSide: "RIGHT",
  comments: {
    nodes: [
      { databaseId, author: { login: "mira", avatarUrl: null }, body, createdAt: "2026-09-03T08:00:00Z", originalCommit: { oid: head } },
    ],
  },
});

scenario(
  "GitHub: threads at their lines, a draft survives a restart, range comment now, Approve with the draft",
  "main",
  withCleanup(async (t) => {
    const setup = await setUp(t, "github", {
      prepare: (mock, head) =>
        mock.state.reviewThreads.set(9, [
          ghThread("PRRT_offen", 9001, 12, { head }),
          ghThread("PRRT_alt", 9002, 5, { outdated: true, body: "Gilt für den alten Stand.", head }),
        ]),
    });
    const { mock, head, tabId, env, dataDir } = setup;
    let app = setup.app;
    await openFiles(app, tabId);
    await app.waitFor(`${FILES} [data-review-row="new:12"] [data-review-thread="9001"]`, 15_000, { message: "thread at line 12" });
    assertIncludes(await text(app, `${FILES} [data-review-thread="9001"]`), "Bitte den Fehlerfall benennen.");
    await app.waitFor(`${FILES} [data-review-block="outdated"] [data-review-thread="9002"]`, 5000, { message: "outdated thread" });
    assertIncludes(await text(app, `${FILES} [data-review-block="outdated"]`), str("pullRequest.view.review.outdated", { count: 1 }));

    // C on a line → comment box → "Add to review": a local draft, nothing sent.
    await comment(app, 13, BODY);
    await app.waitFor(`${FILES} [data-review-row="new:13"] [data-review-draft][data-origin="local"]`, 10_000, { message: "draft at 13" });
    await app.waitFor(async () => (await text(app, SUBMIT_OPEN)) === str("pullRequest.view.review.submitCount", { count: 1 }), 10_000, {
      message: "Submit review (1)",
    });
    assertEqual(calls(mock), [], "a draft sends nothing");
    await t.shot("github-draft", app);
    await t.noConsoleErrors(app);

    // Restart: the draft is still there.
    await app.close();
    app = await launch(t, env, dataDir);
    const again = await app.openRepo(setup.repo.path);
    // Every launch has its own keychain service: the token is given again; the drafts live in the data folder.
    await connect(app, "github", mock);
    await openFiles(app, again.tabId);
    await app.waitFor(`${FILES} [data-review-row="new:13"] [data-review-draft][data-origin="local"]`, 15_000, {
      message: "draft after the restart",
    });
    t.step("draft survived the restart");

    // Range with Shift+↓, Shift+C, "Comment now": one comment on lines 15–16 at once.
    await cursorTo(app, 15);
    await app.press("Shift+ArrowDown", "Shift+c");
    await app.waitFor(FIELD, 5000, { message: "comment box for the range" });
    await app.type(FIELD, "Diese zwei Zeilen zusammenfassen.");
    await clickInComposer(app, "[data-review-comment-now]");
    await until(() => calls(mock).includes("POST /api/v3/repos/octo/demo/pulls/9/comments"), "the range comment reached GitHub", 15_000);
    assertBody(mock.state.reviewRequests[0].body, {
      body: "Diese zwei Zeilen zusammenfassen.",
      commit_id: head,
      path: FILE,
      line: 16,
      side: "RIGHT",
      start_line: 15,
      start_side: "RIGHT",
    });

    // Submit with Approve: one review with the draft.
    await submitReview(app, { vote: "voteApprove" });
    const reviews = mock.state.reviewRequests.filter((entry) => entry.path === "/api/v3/repos/octo/demo/pulls/9/reviews");
    assertEqual(reviews.length, 1, "one review");
    assertBody(reviews[0].body, {
      commit_id: head,
      body: "",
      event: "APPROVE",
      comments: [{ path: FILE, body: BODY, line: 13, side: "RIGHT" }],
    });
    await app.waitFor(async () => (await count(app, `${FILES} [data-review-draft]`)) === 0, 10_000, { message: "draft list empty" });
    await app.waitFor(async () => (await text(app, `${PRV} [data-review-announce]`)) === str("pullRequest.view.review.submitted"), 5000, {
      message: "aria-live: Review sent",
    });
    await t.shot("github-sent", app);
    await t.noConsoleErrors(app);
  }),
);

scenario(
  "GitHub: a review started in the browser takes the local draft, no second review",
  "main",
  withCleanup(async (t) => {
    const { mock, app, tabId } = await setUp(t, "github", {
      prepare: (mock) => {
        mock.state.pendingReview = {
          number: 9,
          comments: [{ id: 7701, path: FILE, line: 18, side: "RIGHT", body: "Im Browser begonnen." }],
        };
      },
    });
    await openFiles(app, tabId);
    const hostDraft = `${FILES} [data-review-row="new:18"] [data-review-draft="7701"][data-origin="host"]`;
    await app.waitFor(hostDraft, 15_000, { message: "draft from the browser at line 18" });
    assertEqual(await text(app, `${hostDraft} [data-review-draft-host]`), str("pullRequest.view.review.startedInBrowser"));
    assert(!(await present(app, `${hostDraft} [data-review-draft-edit]`)), "a browser draft is not edited here");

    await comment(app, 16, BODY);
    await app.waitFor(async () => (await text(app, SUBMIT_OPEN)) === str("pullRequest.view.review.submitCount", { count: 2 }), 10_000, {
      message: "Submit review (2)",
    });
    await submitReview(app, { vote: "voteRequestChanges", body: "Bitte noch die leere Eingabe abfangen." });
    assertEqual(calls(mock), ["POST /api/graphql", "POST /api/v3/repos/octo/demo/pulls/9/reviews/77/events"], "mutation, then the events");
    assertIncludes(mock.state.reviewRequests[0].body.query, "addPullRequestReviewThread");
    assertBody(mock.state.reviewRequests[0].body.variables.input, {
      pullRequestReviewId: "PRR_kwDOpending",
      path: FILE,
      line: 16,
      side: "RIGHT",
      body: BODY,
    });
    assertBody(mock.state.reviewRequests[1].body, { body: "Bitte noch die leere Eingabe abfangen.", event: "REQUEST_CHANGES" });
    await t.noConsoleErrors(app);
  }),
);

/** GitLab discussion on a line (DiffNote). */
const glDiscussion = (id, line, head) => ({
  id,
  individual_note: false,
  notes: [
    {
      id: 901,
      type: "DiffNote",
      body: "Bitte den Fehlerfall benennen.",
      author: { id: 44, username: "mira", name: "mira (Name)", avatar_url: null, state: "active" },
      created_at: "2026-09-02T09:30:00Z",
      system: false,
      resolvable: true,
      resolved: false,
      position: {
        position_type: "text",
        base_sha: "0".repeat(40),
        start_sha: "0".repeat(40),
        head_sha: head,
        old_path: FILE,
        new_path: FILE,
        old_line: null,
        new_line: line,
      },
    },
  ],
});

scenario(
  "GitLab: comment on an unchanged line, Approve publishes the draft notes, resolve and reopen a discussion",
  "main",
  withCleanup(async (t) => {
    const DISCUSSION = "6a9c1750b37d513a43987b574953fceb50b03ce7";
    const { mock, head, app, tabId } = await setUp(t, "gitlab", {
      prepare: (mock, head) => mock.state.reviewThreads.set(9, [glDiscussion(DISCUSSION, 12, head)]),
    });
    await openFiles(app, tabId);
    // New line 18 is old line 16: GitLab gets both numbers.
    await comment(app, 18, BODY, { kind: "context" });
    await app.waitFor(`${FILES} [data-review-row="new:18"] [data-review-draft][data-origin="local"]`, 10_000, { message: "draft at 18" });
    await submitReview(app, { vote: "voteApprove" });
    const base = "/api/v4/projects/gruppe%2Funter%2Fdemo/merge_requests/9";
    assertEqual(calls(mock), [`POST ${base}/draft_notes`, `POST ${base}/draft_notes/bulk_publish`, `POST ${base}/approve`], "order");
    assertBody(mock.state.reviewRequests[0].body, {
      note: BODY,
      position: {
        position_type: "text",
        base_sha: MOCK_BASE,
        start_sha: MOCK_BASE,
        head_sha: head,
        old_path: FILE,
        new_path: FILE,
        new_line: 18,
        old_line: 16,
      },
    });
    assertBody(mock.state.reviewRequests[2].body, { sha: head });

    // Resolve the discussion in the diff, then reopen it.
    const thread = `${FILES} [data-review-row="new:12"] [data-review-thread="${DISCUSSION}"]`;
    await app.click(await app.waitFor(`${thread} [data-review-resolve="resolve"]`, 10_000, { message: "Resolve thread" }));
    await until(() => calls(mock).includes(`PUT ${base}/discussions/${DISCUSSION}`), "resolve reached GitLab", 15_000);
    assertBody(mock.state.reviewRequests.at(-1).body, { resolved: true });
    await app.click(await app.waitFor(`${thread}[data-review-resolved-thread] button`, 10_000, { message: "Resolved – show" }));
    await app.click(await app.waitFor(`${thread} [data-review-resolve="reopen"]`, 5000, { message: "Reopen thread" }));
    await until(() => mock.state.reviewRequests.at(-1).body?.resolved === false, "reopen reached GitLab", 15_000);
    await app.waitFor(`${thread} [data-review-resolve="resolve"]`, 10_000, { message: "open again" });
    await t.shot("gitlab-reopened", app);
    await t.noConsoleErrors(app);
  }),
);

scenario(
  "Gitea: Approve and Request changes on a foreign pull request, only Comment on the own one",
  "main",
  withCleanup(async (t) => {
    const { mock, head, app, tabId } = await setUp(t, "gitea", { numbers: [9, 11], overrides: { 11: { author: "lena" } } });
    await openFiles(app, tabId);
    await submitReview(app, { vote: "voteApprove" });
    await submitReview(app, { vote: "voteRequestChanges", body: "Bitte noch anpassen." });
    assertEqual(calls(mock), ["POST /api/v1/repos/octo/demo/pulls/9/reviews", "POST /api/v1/repos/octo/demo/pulls/9/reviews"]);
    assertBody(mock.state.reviewRequests[0].body, { body: "", commit_id: head, event: "APPROVED", comments: [] });
    assertBody(mock.state.reviewRequests[1].body, {
      body: "Bitte noch anpassen.",
      commit_id: head,
      event: "REQUEST_CHANGES",
      comments: [],
    });

    // The own pull request: no verdict to choose, only a comment review.
    await openFiles(app, tabId, 11);
    await app.click(`${SUBMIT_OPEN}:not([disabled])`);
    await app.waitFor(DIALOG, 5000, { message: "submit dialog of the own PR" });
    assertEqual(await count(app, `${DIALOG} [role="radio"]`), 0, "no verdict choice on the own pull request");
    await app.type(`${DIALOG} textarea[name="review-body"]`, "Notiz an mich.");
    await clickDialogSubmit(app);
    await app.waitFor(async () => !(await present(app, DIALOG)), 15_000, { message: "dialog closes" });
    assertEqual(mock.state.reviewRequests[2].body.event, "COMMENT");
    await t.noConsoleErrors(app);
  }),
);

scenario(
  "Bitbucket: a failing draft stays with its error and withholds the vote; fixed, it goes out with the approval",
  "edge",
  withCleanup(async (t) => {
    const { mock, app, tabId } = await setUp(t, "bitbucket", {
      prepare: (mock) => {
        mock.state.failCommentBody = "kaputt";
      },
    });
    await openFiles(app, tabId);
    await comment(app, 12, BODY, { kind: "add" });
    await comment(app, 16, "kaputt");
    await submitReview(app, { vote: "voteApprove", expectClose: false });
    await app.waitFor(`${DIALOG} [data-review-submit-failed] li`, 15_000, { message: "failed draft listed in the dialog" });
    const comments = "POST /2.0/repositories/team/demo/pullrequests/9/comments";
    assertEqual(calls(mock), [comments, comments], "both drafts tried, no vote");
    assertBody(mock.state.reviewRequests[0].body, { content: { raw: BODY }, inline: { path: FILE, to: 12 } });
    // Cancel (Esc would first close the error toast on top, by design).
    await app.click(
      await app.waitFor(
        () =>
          app.exec((css) => [...document.querySelectorAll(`${css} button`)].find((b) => b.innerText.trim() === "Cancel") ?? null, DIALOG),
        5000,
      ),
    );
    await app.waitFor(async () => !(await present(app, DIALOG)), 5000, { message: "dialog closed" });
    const failed = `${FILES} [data-review-row="new:16"] [data-review-draft][data-origin="local"]`;
    await app.waitFor(`${failed} [data-review-draft-error]`, 10_000, { message: "the failed draft with its error" });
    assertEqual(await count(app, `${FILES} [data-review-draft]`), 1, "the sent draft is gone");
    await t.shot("bitbucket-failed", app);

    // Fix the text and send again.
    await app.click(`${failed} [data-review-draft-edit]`);
    await app.waitFor(FIELD, 5000, { message: "comment box with the draft" });
    await setField(app, FIELD, "Hier bitte zusammenfassen.");
    await clickInComposer(app, "[data-review-add]");
    await app.waitFor(async () => !(await present(app, `${failed} [data-review-draft-error]`)), 10_000, { message: "error cleared" });
    await submitReview(app, { vote: "voteApprove" });
    assertEqual(calls(mock).slice(2), [comments, "POST /2.0/repositories/team/demo/pullrequests/9/approve"]);
    assertBody(mock.state.reviewRequests[2].body, { content: { raw: "Hier bitte zusammenfassen." }, inline: { path: FILE, to: 16 } });
    await app.waitFor(async () => (await count(app, `${FILES} [data-review-draft]`)) === 0, 10_000, { message: "no drafts left" });
    await t.noConsoleErrors(app);
  }),
);

/** Azure DevOps thread on a file position. */
const azThread = (id, line) => ({
  id,
  status: "active",
  threadContext: { filePath: `/${FILE}`, rightFileStart: { line, offset: 1 }, rightFileEnd: { line, offset: 1 } },
  comments: [
    {
      id: 1,
      author: { displayName: "mira (Name)", uniqueName: "mira@example.org", imageUrl: null },
      content: "Bitte den Fehlerfall benennen.",
      publishedDate: "2026-09-02T09:30:00Z",
      commentType: "text",
    },
  ],
});

scenario(
  "Azure DevOps: range comment, resolve as fixed, Request changes votes -5",
  "main",
  withCleanup(async (t) => {
    const { mock, app, tabId } = await setUp(t, "azure_devops", { prepare: (mock) => mock.state.reviewThreads.set(9, [azThread(91, 12)]) });
    await openFiles(app, tabId);
    const repoPath = "/firma/projekt/_apis/git/repositories/demo/pullrequests/9";

    await cursorTo(app, 15);
    await app.press("Shift+ArrowDown", "Shift+c");
    await app.waitFor(FIELD, 5000, { message: "comment box for the range" });
    await app.type(FIELD, BODY);
    await clickInComposer(app, "[data-review-comment-now]");
    await until(() => calls(mock).includes(`POST ${repoPath}/threads`), "the range thread reached Azure DevOps", 15_000);
    assertBody(mock.state.reviewRequests[0].body, {
      comments: [{ parentCommentId: 0, content: BODY, commentType: 1 }],
      status: "active",
      threadContext: { filePath: `/${FILE}`, rightFileStart: { line: 15, offset: 1 }, rightFileEnd: { line: 16, offset: 1 } },
    });

    const thread = `${FILES} [data-review-row="new:12"] [data-review-thread="91"]`;
    await app.click(await app.waitFor(`${thread} [data-review-resolve="resolve"]`, 10_000, { message: "Resolve thread" }));
    await until(() => calls(mock).includes(`PATCH ${repoPath}/threads/91`), "resolve reached Azure DevOps", 15_000);
    assertBody(mock.state.reviewRequests.at(-1).body, { status: "fixed" });

    await submitReview(app, { vote: "voteRequestChanges", body: "Bitte anpassen." });
    assertEqual(calls(mock).slice(2), [`POST ${repoPath}/threads`, `PUT ${repoPath}/reviewers/mock-user`], "text, then the vote");
    assertEqual(mock.state.reviewRequests[2].body.comments[0].content, "Bitte anpassen.");
    assertBody(mock.state.reviewRequests[3].body, { vote: -5 });
    await t.shot("azure-sent", app);
    await t.noConsoleErrors(app);
  }),
);

scenario(
  "the local diff is not the pull request's head: no comment buttons, a hint with Fetch",
  "edge",
  withCleanup(async (t) => {
    // GitHub already has a newer head that was never fetched; the commits known locally end one before it.
    const { app, tabId, mock } = await setUp(t, "github", { overrides: { 9: { head: "e".repeat(40) } } });
    await openFiles(app, tabId);
    const hint = await app.waitFor(`${FILES} [data-review-fetch-hint]`, 10_000, { message: "fetch hint" });
    assertIncludes(await hint.text(), str("pullRequest.view.review.fetchToComment"));
    assertIncludes(await hint.text(), str("pullRequest.view.files.fetch"));
    assertEqual(await count(app, `${FILES} [data-comment-line]`), 0, "no comment buttons on the line numbers");
    await cursorTo(app, 12, "add");
    await app.press("c");
    // C did nothing: the grid still has the focus and no box opened (checked after the key was handled).
    await app.settle();
    assert(!(await present(app, COMPOSER)), "C opens no comment box");
    assertEqual(calls(mock), [], "nothing sent");
    await t.noConsoleErrors(app);
  }),
);
