/**
 * The stack view starts fresh for every branch (v1.2, Paket 8.1). The view stays mounted when the
 * centre switches from one branch's stack view to another's, through the branch menu entry or the
 * palette command. Cuts and names from the first branch must not reach the second branch's plan.
 *
 * Both scenarios visit the target branch's view once first: with its stack status cached, the switch
 * renders the planner directly, without a loading state that would unmount it in between.
 *
 * - edge: branch menu path (setCenter, as the menu entry does). Branch A has four commits and a cut
 *   after the third, part 1 has a name. Switching to B, which has two commits, shows B as one part
 *   with an empty name and no error;
 * - edge: palette path. A cut in B after the first commit "fits" A, so the old cuts would be accepted.
 *   After checking out A and running "pr.stack", A is still one part without B's name.
 *
 *   node scripts/e2e-wd/features/stack-branch-switch.mjs
 */
import { makeEmptyReflogRepo } from "../fixtures/reflog.mjs";
import { assertEqual, scenario } from "../lib.mjs";

const VIEW = '[data-screen="stack"]';
const LAUNCH = { lang: "en", theme: "light", width: 1440, height: 900 };

/** main with one commit; "thema/lang" with four commits and "thema/kurz" with two, both from main. */
function makeRepo() {
  const repo = makeEmptyReflogRepo("stapel");
  repo.write("README.md", "# Stapel\n");
  repo.commit("Grundgerüst");
  repo.git("checkout", "-q", "-b", "thema/lang", "main");
  for (const [file, subject] of [
    ["a.txt", "Messwerte einlesen"],
    ["b.txt", "Messwerte prüfen"],
    ["c.txt", "Monatsmittel berechnen"],
    ["d.txt", "Diagramm zeichnen"],
  ]) {
    repo.write(file, `${subject}\n`);
    repo.commit(subject);
  }
  repo.git("checkout", "-q", "-b", "thema/kurz", "main");
  for (const [file, subject] of [
    ["x.txt", "Station anlegen"],
    ["y.txt", "Station löschen"],
  ]) {
    repo.write(file, `${subject}\n`);
    repo.commit(subject);
  }
  return repo;
}

/** What the planner shows: commit subjects, number of parts, the part 1 name, the error state. */
const planner = (app) =>
  app.exec((view) => {
    const root = document.querySelector(view);
    if (!root) return null;
    const name = root.querySelector('[data-stack-name="1"]');
    return {
      title: root.querySelector("h2")?.textContent ?? "",
      commits: [...root.querySelectorAll("[data-commit] span:first-child")].map((el) => el.textContent),
      parts: root.querySelectorAll("li[data-stack-part]").length,
      name: name ? (name.value ?? name.querySelector("input")?.value ?? "") : null,
      error: Boolean(root.querySelector("[data-stack-list]")) ? null : root.innerText.replace(/\s+/g, " ").trim(),
    };
  }, VIEW);

async function waitPlanner(app, branch, count) {
  return app.waitFor(
    async () => {
      const state = await planner(app);
      return state && state.title.includes(branch) && state.commits.length === count && state.error === null ? state : null;
    },
    20_000,
    { message: `planner of ${branch} with ${count} commits (last: ${JSON.stringify(await planner(app).catch(() => null))})` },
  );
}

/** Selects commit `n` (1-based), cuts after it and names part 1. */
async function cutAndName(app, n, name) {
  await app.click(`${VIEW} [data-commit="${n}"]`);
  await app.click(`${VIEW} [data-stack-split]`);
  await app.waitFor(async () => (await planner(app))?.parts === 2, 10_000, { message: "two parts" });
  const field = await app.waitFor(`${VIEW} [data-stack-name="1"]`);
  const input = (await app.exec((el) => el.tagName, field)) === "INPUT" ? field : await app.waitFor(`${VIEW} [data-stack-name="1"] input`);
  await app.type(input, name);
  await app.waitFor(async () => (await planner(app))?.name === name, 5000, { message: "name typed" });
}

/** Runs a command through the palette (Ctrl+P, ">text", click on the entry with that id). */
async function runCommand(app, text, id) {
  await app.exec(() => document.activeElement?.blur());
  await app.press("Control+p");
  const input = await app.waitFor('[data-screen="command-palette"] input[role="combobox"]', 10_000);
  await app.type(input, `>${text}`);
  const find = () => app.waitFor(() => app.exec((key) => document.querySelector(`[data-screen="command-palette"] [role="option"][data-key="command:${key}"]`), id), 10_000, { message: `palette entry ${id}` });
  for (let attempt = 0; ; attempt++) {
    try {
      await app.click(await find());
      break;
    } catch (error) {
      if (attempt >= 3 || !/stale element/i.test(String(error.message))) throw error;
      await app.settle(200);
    }
  }
  await app.waitFor(() => app.exec(() => !document.querySelector('[data-screen="command-palette"]')), 5000, { message: "palette closed" });
}

const setCenter = (app, tabId, branch) => app.exec((id, name) => window.__gc.store.getState().setCenter(id, { kind: "stack", branch: name }), tabId, branch);

scenario("switching from a longer branch to a shorter one starts the plan fresh", "edge", async (t) => {
  const repo = makeRepo();
  try {
    const app = await t.launch(LAUNCH);
    const { tabId } = await app.openRepo(repo.path);

    // thema/kurz's stack status is cached from here on, so the later switch back to it shows the
    // planner at once instead of a loading state in between.
    t.step("stack view of thema/kurz, then of thema/lang: cut after commit 3, name part 1");
    await setCenter(app, tabId, "thema/kurz");
    await waitPlanner(app, "thema/kurz", 2);
    await setCenter(app, tabId, "thema/lang");
    await waitPlanner(app, "thema/lang", 4);
    await cutAndName(app, 3, "einlesen");

    t.step("stack view of thema/kurz while the view is open");
    await setCenter(app, tabId, "thema/kurz");
    const state = await waitPlanner(app, "thema/kurz", 2);
    assertEqual(state.commits, ["Station anlegen", "Station löschen"], "thema/kurz's commits, oldest first (git log --reverse)");
    assertEqual(state.parts, 1, "one part: no cut from thema/lang");
    assertEqual(state.name, "", "no name from thema/lang");
    await t.shot("stack-switched-to-short");
    await t.noConsoleErrors();
  } finally {
    repo.cleanup();
  }
});

scenario("palette: cuts and names of the previous branch do not carry over even when they fit", "edge", async (t) => {
  const repo = makeRepo();
  try {
    repo.git("checkout", "-q", "thema/lang");
    const app = await t.launch(LAUNCH);
    const { repoId } = await app.openRepo(repo.path);
    // The watcher reloads the status; the palette reads the checked-out branch from it.
    const checkOut = async (branch) => {
      repo.git("checkout", "-q", branch);
      await app.waitFor(
        () => app.exec((id, name) => window.__gc.queryClient.getQueryData(["repo", id, "status"])?.head?.branch === name, repoId, branch),
        20_000,
        { message: `status shows ${branch} checked out` },
      );
      await app.settle();
    };

    t.step("palette on thema/lang (its stack status is cached from here on)");
    await runCommand(app, "stacked pull requests", "pr.stack");
    await waitPlanner(app, "thema/lang", 4);

    t.step("check out thema/kurz outside the app, palette: cut after commit 1, name part 1");
    await checkOut("thema/kurz");
    await runCommand(app, "stacked pull requests", "pr.stack");
    await waitPlanner(app, "thema/kurz", 2);
    await cutAndName(app, 1, "anlegen");

    t.step("check out thema/lang again, palette");
    await checkOut("thema/lang");
    await runCommand(app, "stacked pull requests", "pr.stack");
    const state = await waitPlanner(app, "thema/lang", 4);
    assertEqual(state.commits, ["Messwerte einlesen", "Messwerte prüfen", "Monatsmittel berechnen", "Diagramm zeichnen"], "thema/lang's commits, oldest first");
    assertEqual(state.parts, 1, "one part: no cut from thema/kurz");
    assertEqual(state.name, "", "no name from thema/kurz");
    await t.noConsoleErrors();
  } finally {
    repo.cleanup();
  }
});
