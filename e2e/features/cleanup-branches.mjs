/**
 * "Clean up branches" in the real app over WebDriver: opening it from the command palette, the
 * menu of the "Local" section and "Clean up repository"; the candidates with their reasons, the safe
 * ones preselected and protected ones never selectable; one click deletes and one Undo brings all back;
 * a list that no longer matches the repository is refused and reloaded; deleting on the remote after
 * its own confirmation (also when the branch was already gone there); missing PR data for a GitHub
 * remote without an account; the German texts.
 *
 *   node e2e/features/cleanup-branches.mjs
 *   E2E_WD_ONLY=undo node e2e/features/cleanup-branches.mjs
 *
 * Every check also asks Git: `git for-each-ref`, `git rev-parse`, `git ls-remote`.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { gitIsolationEnv, makeCleanRepoWithRemote } from "../fixtures/fixtures.mjs";
import { assertEqual, assertMatch, scenario } from "../lib.mjs";

const LAUNCH = { width: 1440, height: 900, theme: "light", lang: "en" };
const VIEW = '[data-screen="branch-cleanup"]';

// ---------------------------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------------------------

const envFor = (fx) => ({ ...process.env, ...gitIsolationEnv(path.join(fx.root, "gitconfig")) });
const gitIn = (fx, cwd, args, env = {}) =>
  execFileSync("git", args, { cwd, env: { ...envFor(fx), ...env }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const git = (fx, ...args) => gitIn(fx, fx.path, args);
const localBranches = (fx) => git(fx, "for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads").split("\n").filter(Boolean);
const remoteHeads = (fx, name) => gitIn(fx, fx.path, ["ls-remote", "--heads", fx.remotePath, name]);

/**
 * Branches next to `main`: `fertig` and `erledigt/ä` (in main), `release/2026.1` (in main, protected
 * by default) and `alt` (one own commit from 2025-01-01). `feature/export` of the fixture goes, so the
 * list holds exactly these four.
 */
function addBranches(fx) {
  git(fx, "branch", "-D", "feature/export");
  git(fx, "branch", "fertig", "main~1");
  git(fx, "branch", "erledigt/ä", "main~2");
  git(fx, "branch", "release/2026.1", "main");
  const date = "2025-01-01T10:00:00+0100";
  const alt = gitIn(fx, fx.path, ["commit-tree", "main^{tree}", "-p", "main", "-m", "Alter Versuch mit Tagesmaxima"], {
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_DATE: date,
  });
  git(fx, "branch", "alt", alt);
  return { fertig: git(fx, "rev-parse", "fertig"), "erledigt/ä": git(fx, "rev-parse", "erledigt/ä"), alt };
}

// ---------------------------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------------------------

/** Runs a command via the palette, keyboard only (F1, type, Enter). */
async function palette(app, text) {
  await app.press("F1");
  const input = await app.waitFor('input[role="combobox"]', 5000);
  await app.type(input, text);
  await app.waitFor(
    () =>
      app.exec(
        (wanted) =>
          (document.querySelector('[data-screen="command-palette"] [role="option"][aria-selected="true"]')?.textContent ?? "")
            .toLowerCase()
            .includes(wanted.toLowerCase()),
        text,
      ),
    5000,
    { message: `palette entry "${text}" selected` },
  );
  await app.press("Enter");
}

const textOf = (app, selector) =>
  app.exec((wanted) => document.querySelector(wanted)?.innerText.replace(/\s+/g, " ").trim() ?? null, selector);
const rowSelector = (name) => `${VIEW} [data-cleanup-row="${name}"]`;
/** The groups in screen order, each with its rows: `[["safe", [...]], ["review", [...]], …]`. */
const groups = (app) =>
  app.exec(
    (view) =>
      [...document.querySelectorAll(`${view} [data-cleanup-group]`)].map((group) => [
        group.getAttribute("data-cleanup-group"),
        [...group.querySelectorAll("[data-cleanup-row]")].map((row) => row.getAttribute("data-cleanup-row")),
      ]),
    VIEW,
  );
const checkedState = (app, name) =>
  app.exec(
    (selector) => document.querySelector(`${selector} [data-cleanup-check]`)?.getAttribute("aria-checked") ?? null,
    rowSelector(name),
  );
const toasts = (app) =>
  app.exec(() =>
    [...document.querySelectorAll("[data-toast]")].map((item) => ({
      tone: item.getAttribute("data-toast"),
      text: item.innerText.replace(/\s+/g, " ").trim(),
    })),
  );
const waitToast = (app, test, message) =>
  app
    .waitFor(async () => (await toasts(app)).some(test), 20_000, { message })
    .catch(async (error) => {
      throw new Error(`${error.message}; toasts: ${JSON.stringify(await toasts(app))}`);
    });

/** Waits for the view with its list loaded (the counter shows). */
async function waitList(app) {
  await app.waitFor(`${VIEW} [data-cleanup-counter]`, 20_000);
  await app.settle();
}
async function openFromPalette(app, title = "Clean up branches") {
  await palette(app, title);
  await waitList(app);
}
const waitCounter = (app, wanted) =>
  app.waitFor(async () => (await textOf(app, `${VIEW} [data-cleanup-counter]`)) === wanted, 10_000, { message: `counter "${wanted}"` });

/** Ticks "Also delete on …" unless it is ticked already. */
async function tickRemote(app) {
  const box = `${VIEW} [data-cleanup-remote] [role="checkbox"]`;
  await app.waitFor(box, 10_000);
  if ((await app.exec((selector) => document.querySelector(selector).getAttribute("data-state"), box)) !== "checked") await app.click(box);
  await app.waitFor(
    async () => (await app.exec((selector) => document.querySelector(selector)?.getAttribute("data-state"), box)) === "checked",
    5000,
    {
      message: "remote option ticked",
    },
  );
}

/** Right-click on an element; returns the labels of the menu entries. */
async function contextMenu(app, selector) {
  const element = await app.waitFor(selector, 10_000);
  await app.exec((el) => {
    const box = el.getBoundingClientRect();
    el.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        buttons: 2,
        clientX: box.left + 20,
        clientY: box.top + box.height / 2,
      }),
    );
  }, element);
  return app.waitFor(
    async () => {
      const items = await app.exec(() =>
        [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((item) => item.textContent.replace(/\s+/g, " ").trim()),
      );
      return items.length ? items : null;
    },
    5000,
    { message: "context menu open" },
  );
}

// =============================================================================================
// Scenarios
// =============================================================================================

scenario(
  "palette opens the list; safe branches are preselected; one click deletes; Undo in the toast brings all back",
  "main",
  async (t) => {
    const fx = makeCleanRepoWithRemote({ name: "messnetz" });
    try {
      const shas = addBranches(fx);
      const app = await t.launch(LAUNCH);
      await app.openRepo(fx.path);
      await openFromPalette(app);
      assertEqual(
        await groups(app),
        [
          ["safe", ["erledigt/ä", "fertig"]],
          ["review", ["alt"]],
          ["blocked", ["release/2026.1"]],
        ],
        "groups as Git says: in main, own commit, protected",
      );
      assertEqual(await textOf(app, `${rowSelector("alt")} [data-reason="stale"]`), "stale", "alt: stale chip");
      assertEqual(await textOf(app, `${rowSelector("alt")} [data-reason="unmerged"]`), "1 not merged", "alt: one commit not merged");
      assertEqual(
        await textOf(app, `${rowSelector("alt")} [data-cleanup-lost]`),
        "1 commit will be lost (undo possible)",
        "alt: what gets lost",
      );
      assertEqual(await textOf(app, `${rowSelector("fertig")} [data-reason="merged"]`), "merged", "fertig: merged chip");
      assertEqual(await textOf(app, `${rowSelector("release/2026.1")} [data-reason="protected"]`), "protected", "release: protected chip");
      assertEqual(await checkedState(app, "fertig"), "true", "safe branch preselected");
      assertEqual(await checkedState(app, "erledigt/ä"), "true", "safe branch with umlaut preselected");
      assertEqual(await checkedState(app, "alt"), "false", "check-first branch not preselected");
      await waitCounter(app, "2 of 3 selected");

      // Protected: never selectable, not even by clicking it.
      await app.click(`${rowSelector("release/2026.1")} [data-cleanup-check]`);
      assertEqual(await checkedState(app, "release/2026.1"), "false", "protected branch can't be ticked");
      assertEqual(
        await app.exec(
          (selector) => document.querySelector(`${selector} [data-cleanup-check]`)?.getAttribute("aria-disabled"),
          rowSelector("release/2026.1"),
        ),
        "true",
        "protected branch announced as disabled",
      );
      await waitCounter(app, "2 of 3 selected");
      await t.shot("list");

      assertEqual(await textOf(app, `${VIEW} [data-cleanup-delete]`), "Delete 2", "delete button names the count");
      await app.click(`${VIEW} [data-cleanup-delete]`);
      await waitToast(app, (toast) => toast.tone === "success" && toast.text.includes("2 branches deleted"), "toast “2 branches deleted”");
      assertEqual(localBranches(fx).sort(), ["alt", "main", "release/2026.1"], "git for-each-ref: both safe branches are gone");

      const undo = await app.waitFor(
        () =>
          app.exec(
            () =>
              [...document.querySelectorAll("[data-toast]")]
                .find((toast) => toast.innerText.includes("2 branches deleted"))
                ?.querySelector('[data-toast-action="primary"]') ?? null,
          ),
        5000,
        { message: "Undo in the toast" },
      );
      assertEqual(await app.exec((button) => button.textContent.trim(), undo), "Undo", "toast action says Undo");
      await app.click(undo);
      await app.waitFor(() => localBranches(fx).includes("fertig") && localBranches(fx).includes("erledigt/ä"), 20_000, {
        message: "both branches back after one Undo",
      });
      assertEqual(git(fx, "rev-parse", "fertig"), shas.fertig, "git rev-parse fertig: same commit as before");
      assertEqual(git(fx, "rev-parse", "erledigt/ä"), shas["erledigt/ä"], "git rev-parse erledigt/ä: same commit as before");
      assertEqual(git(fx, "rev-parse", "alt"), shas.alt, "alt untouched");
      await app.waitFor(async () => (await groups(app))[0]?.[1].length === 2, 10_000, { message: "list shows the restored branches" });
      await t.noConsoleErrors(app);
    } finally {
      fx.cleanup();
    }
  },
);

scenario("a list that no longer matches the repository is refused as a whole and reloaded", "edge", async (t) => {
  const fx = makeCleanRepoWithRemote({ name: "messnetz" });
  try {
    const shas = addBranches(fx);
    const app = await t.launch(LAUNCH);
    const { repoId } = await app.openRepo(fx.path);
    await openFromPalette(app);
    // The list the user sees says `fertig` is at another commit (as if it had moved since loading;
    // moving it in Git would make the file watcher reload the list before the click).
    await app.exec(
      (id, other) =>
        window.__gc.queryClient.setQueryData(["repo", id, "branchCleanup"], (data) => ({
          ...data,
          candidates: data.candidates.map((candidate) => (candidate.name === "fertig" ? { ...candidate, sha: other } : candidate)),
        })),
      repoId,
      shas["erledigt/ä"],
    );
    await waitCounter(app, "2 of 3 selected");
    await app.click(`${VIEW} [data-cleanup-delete]`);
    await waitToast(app, (toast) => toast.tone === "danger", "error message for the refused deletion");
    assertEqual(localBranches(fx).sort(), ["alt", "erledigt/ä", "fertig", "main", "release/2026.1"], "nothing deleted: all or none");
    await app.waitFor(
      () =>
        app
          .exec(
            (id) => window.__gc.queryClient.getQueryData(["repo", id, "branchCleanup"])?.candidates.find((c) => c.name === "fertig")?.sha,
            repoId,
          )
          .then((sha) => sha === shas.fertig),
      10_000,
      { message: "list reloaded with the commit Git has" },
    );
    await waitCounter(app, "2 of 3 selected");
    await app.settle();
    await app.click(`${VIEW} [data-cleanup-delete]`);
    await waitToast(app, (toast) => toast.tone === "success" && toast.text.includes("2 branches deleted"), "second try deletes");
    assertEqual(localBranches(fx).sort(), ["alt", "main", "release/2026.1"], "git for-each-ref after the second try");
  } finally {
    fx.cleanup();
  }
});

scenario("also on the remote: own confirmation with the list, then each remote branch is deleted", "edge", async (t) => {
  const fx = makeCleanRepoWithRemote({ name: "messnetz" });
  try {
    git(fx, "branch", "-D", "feature/export");
    git(fx, "branch", "fertig", "main~1");
    git(fx, "push", "-q", "-u", "origin", "fertig");
    const app = await t.launch(LAUNCH);
    await app.openRepo(fx.path);
    await openFromPalette(app);
    await waitCounter(app, "1 of 1 selected");
    assertEqual(
      await textOf(app, `${VIEW} [data-cleanup-remote] label`),
      "Also delete on origin Affects everyone using the remote and can’t be undone.",
    );
    await tickRemote(app);
    await app.click(`${VIEW} [data-cleanup-delete]`);
    const confirmText = await app.waitFor(
      async () => {
        const text = await textOf(app, '[role="alertdialog"], [role="dialog"]');
        return text?.includes("origin/fertig") ? text : null;
      },
      10_000,
      { message: "confirmation listing origin/fertig" },
    );
    assertMatch(confirmText, /Delete the remote branch\?/, "singular title");
    assertEqual(localBranches(fx).sort(), ["fertig", "main"], "nothing deleted before confirming");
    await t.shot("remote-confirm");
    await app.click(
      await app.waitFor(() => app.byText("Delete 1 on the remote", { within: '[role="alertdialog"], [role="dialog"]' }), 5000),
    );
    await waitToast(app, (toast) => toast.text.includes("1 remote branch deleted"), "toast “1 remote branch deleted”");
    assertEqual(remoteHeads(fx, "fertig"), "", "git ls-remote: fertig gone on the remote");
    assertEqual(localBranches(fx), ["main"], "fertig gone locally");

    // Second run: the remote branch is deleted behind the app's back; the local one still tracks it.
    git(fx, "branch", "erledigt/ä", "main~2");
    git(fx, "push", "-q", "-u", "origin", "erledigt/ä");
    gitIn(fx, fx.remotePath, ["update-ref", "-d", "refs/heads/erledigt/ä"]);
    await app.waitFor(rowSelector("erledigt/ä"), 20_000);
    await waitCounter(app, "1 of 1 selected");
    await tickRemote(app);
    await app.click(`${VIEW} [data-cleanup-delete]`);
    await app.click(
      await app.waitFor(() => app.byText("Delete 1 on the remote", { within: '[role="alertdialog"], [role="dialog"]' }), 10_000),
    );
    await waitToast(
      app,
      (toast) => toast.tone === "info" && toast.text.includes("“origin/erledigt/ä” was already gone on the server"),
      "already-gone info",
    );
    assertEqual(localBranches(fx), ["main"], "the local deletion stays");
    assertEqual(git(fx, "for-each-ref", "refs/remotes/origin/erledigt/ä"), "", "stale remote branch removed here");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario("the Local section menu and the Clean up repository dialog open it", "edge", async (t) => {
  const fx = makeCleanRepoWithRemote({ name: "messnetz" });
  try {
    addBranches(fx);
    const app = await t.launch(LAUNCH);
    await app.openRepo(fx.path);
    const labels = await contextMenu(app, '[data-section="local"] [data-section-header]');
    assertEqual(labels[0], "Clean up branches …", `first entry of the Local menu: ${JSON.stringify(labels)}`);
    await app.click(await app.byText("Clean up branches …", { within: '[role="menu"]' }));
    await waitList(app);
    await waitCounter(app, "2 of 3 selected");
    await app.click(`${VIEW} [data-back]`);
    await app.waitFor(async () => !(await app.$(VIEW)), 10_000, { message: "view closed" });

    await palette(app, "Clean up repository");
    await app.click(await app.waitFor('[role="dialog"] [data-action="cleanup-branches"]', 20_000));
    await waitList(app);
    await app.waitFor(async () => (await app.exec(() => document.querySelectorAll('[role="dialog"]').length)) === 0, 5000, {
      message: "clean-up dialog closed",
    });
    await waitCounter(app, "2 of 3 selected");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});

scenario("a GitHub remote without an account shows that PR data is missing", "edge", async (t) => {
  const fx = makeCleanRepoWithRemote({ name: "messnetz" });
  try {
    addBranches(fx);
    // No account and no network needed: the list is built from Git alone.
    git(fx, "remote", "set-url", "origin", "https://github.com/octo/demo.git");
    const app = await t.launch(LAUNCH);
    await app.openRepo(fx.path);
    await openFromPalette(app);
    assertEqual(await textOf(app, `${VIEW} [data-cleanup-pr-missing]`), "PR data missing – no connection to GitHub", "PR data notice");
    assertEqual(await app.exec((view) => document.querySelectorAll(`${view} [data-reason="noPr"]`).length, VIEW), 0, "no “no PR” chips");
    await waitCounter(app, "2 of 3 selected");
    await t.shot("pr-missing");
  } finally {
    fx.cleanup();
  }
});

scenario("German texts", "edge", async (t) => {
  const fx = makeCleanRepoWithRemote({ name: "messnetz" });
  try {
    addBranches(fx);
    const app = await t.launch({ ...LAUNCH, lang: "de" });
    await app.openRepo(fx.path);
    await openFromPalette(app, "Branches aufräumen");
    const text = await textOf(app, VIEW);
    for (const wanted of [
      /Branches aufräumen/,
      /Sicher löschbar/,
      /Erst prüfen/,
      /Nicht löschbar/,
      /1 Commit geht verloren \(Undo möglich\)/,
    ]) {
      assertMatch(text, wanted, `German: ${wanted}`);
    }
    await waitCounter(app, "2 von 3 markiert");
    assertEqual(await textOf(app, `${VIEW} [data-cleanup-delete]`), "2 löschen", "German delete button");
    await app.click(`${VIEW} [data-cleanup-delete]`);
    await waitToast(app, (toast) => toast.tone === "success" && toast.text.includes("2 Branches gelöscht"), "German toast");
    assertEqual(localBranches(fx).sort(), ["alt", "main", "release/2026.1"], "git for-each-ref after deleting");
    await t.shot("deutsch");
    await t.noConsoleErrors(app);
  } finally {
    fx.cleanup();
  }
});
