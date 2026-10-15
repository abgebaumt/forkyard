/**
 * Bisect in the real app (1.1): start from the commit graph (one commit + branch/tag, or two
 * selected commits), mark good / bad / skip from the bar, the context menu and the palette, the
 * result with "Show details" and "End bisect", and a bisect started on the command line. Every
 * step is checked in the UI and in the Git directory of the temp repository (refs/bisect/*,
 * BISECT_START, BISECT_LOG, HEAD).
 *
 *   node scripts/e2e-wd/features/bisect.mjs
 *   E2E_WD_ONLY="extern" node scripts/e2e-wd/features/bisect.mjs
 */
import { assert, assertEqual, assertIncludes, assertMatch, scenario } from "../lib.mjs";
import { gitBisect, hasBug, makeBisectRepo } from "../fixtures/bisect.mjs";
import { closeToasts, nudge, parkMouse, rightClick, selection, waitToast } from "../fixtures/rebase.mjs";

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";
const CONTROL = "";
const short = (sha) => sha.slice(0, 7);

const launch = (t, options = {}) => t.launch({ width: 1440, height: 900, lang: "en", theme: "light", ...options });

async function openGraph(app, repo) {
  const ids = await app.openRepo(repo.path);
  await app.waitFor('[data-screen="commit-graph"][data-state="ready"]', 30_000);
  await app.settle();
  return ids;
}

const rowSelector = (sha) => `[data-row-id="${sha}"] [data-cell="message"]`;
const row = (app, sha) => app.waitFor(rowSelector(sha), 15_000);

/** Click with Control held – real W3C input. */
async function modClick(app, target) {
  const element = typeof target === "string" ? await app.waitFor(target) : target;
  await app.webdriver("POST", "/actions", {
    actions: [
      { type: "key", id: "keyboard", actions: [{ type: "keyDown", value: CONTROL }, { type: "pause", duration: 0 }, { type: "pause", duration: 0 }, { type: "pause", duration: 0 }, { type: "keyUp", value: CONTROL }] },
      {
        type: "pointer",
        id: "mouse",
        parameters: { pointerType: "mouse" },
        actions: [{ type: "pause", duration: 0 }, { type: "pointerMove", origin: { [ELEMENT_KEY]: element.id }, x: 0, y: 0 }, { type: "pointerDown", button: 0 }, { type: "pointerUp", button: 0 }, { type: "pause", duration: 0 }],
      },
    ],
  });
  await app.webdriver("DELETE", "/actions").catch(() => undefined);
}

/** The menu item (role=menuitem) whose text starts with `label`. */
const menuItem = (app, label) =>
  app.waitFor(() => app.exec((wanted) => [...document.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent.trim().startsWith(wanted)) ?? null, label), 8000, { message: `menu item "${label}"` });
const menuLabels = (app) => app.exec(() => [...document.querySelectorAll('[role="menuitem"]')].map((node) => node.textContent.replace(/\s+/g, " ").trim()));
async function closeMenu(app) {
  await app.press("Escape");
  await app.waitFor(() => app.exec(() => !document.querySelector('[role="menu"]')), 5000, { message: "menu closed" });
}

/** Opens the context menu of a commit row and clicks the entry. */
async function fromMenu(app, sha, label) {
  await rightClick(app, await row(app, sha));
  await app.click(await menuItem(app, label));
}

/** The open dialog whose title starts with `title`. */
const dialog = (app, title) =>
  app.waitFor(
    () =>
      app.exec((wanted) => [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].find((node) => {
        const label = node.getAttribute("aria-labelledby");
        const name = (label ? document.getElementById(label)?.textContent : node.getAttribute("aria-label")) ?? "";
        return name.trim().startsWith(wanted);
      }) ?? null, title),
    10_000,
    { message: `dialog "${title}"` },
  );
const noDialog = (app) => app.waitFor(() => app.exec(() => !document.querySelector('[role="dialog"], [role="alertdialog"]')), 8000, { message: "dialog closed" });
const buttonIn = (app, root, text) =>
  app.waitFor(() => app.exec((scope, wanted) => [...scope.querySelectorAll("button")].find((node) => node.textContent.trim() === wanted) ?? null, root, text), 8000, { message: `button "${text}"` });
const textOf = (app, element) => app.exec((node) => node.innerText.replace(/\s+/g, " ").trim(), element);

/** Bisect state as the UI holds it (query cache). */
const uiBisect = (app, repoId) => app.exec((id) => window.__gc.queryClient.getQueryData(["repo", id, "bisect"]) ?? null, repoId);

/** The bar: { kind, text } or null when hidden. */
const bar = (app) =>
  app.exec(() => {
    const node = document.querySelector("[data-graph-bisect]");
    return node ? { kind: node.dataset.graphBisect, text: node.innerText.replace(/\s+/g, " ").trim() } : null;
  });
async function waitBar(app, kind, timeout = 20_000) {
  return app.waitFor(async () => {
    const now = await bar(app);
    return kind === null ? (now === null ? { kind: null } : null) : now?.kind === kind ? now : null;
  }, timeout, { message: `bisect bar ${kind ?? "hidden"}` }).catch(async (error) => {
    throw new Error(`${error.message}; is ${JSON.stringify(await bar(app))}`);
  });
}
const barButton = (app, text) => app.waitFor(() => app.exec((wanted) => [...(document.querySelector("[data-graph-bisect]")?.querySelectorAll("button") ?? [])].find((node) => node.textContent.trim() === wanted) ?? null, text), 8000, { message: `bar button "${text}"` });

/** Graph chip of a commit ("good", "bad", "skip") or null. */
const chip = (app, sha) => app.exec((id) => document.querySelector(`[data-row-id="${id}"] [data-bisect]`)?.dataset.bisect ?? null, sha);
const waitChip = (app, sha, mark) => app.waitFor(async () => (await chip(app, sha)) === mark, 10_000, { message: `chip ${mark} on ${sha.slice(0, 7)}` });

/** Waits until the UI has taken over `stepsDone` marks (or a result). */
async function waitSteps(app, repoId, steps) {
  return app.waitFor(async () => {
    const status = await uiBisect(app, repoId);
    return status && status.stepsDone >= steps ? status : null;
  }, 20_000, { message: `bisect steps ${steps}` });
}

/** Runs a palette command by id (Ctrl+P, ">text", click the entry). */
async function runCommand(app, text, id) {
  await app.exec(() => document.activeElement?.blur());
  await app.press("Control+p");
  const input = await app.waitFor('[data-screen="command-palette"] input[role="combobox"]', 10_000);
  await app.type(input, `>${text}`);
  const find = () => app.waitFor(() => app.exec((key) => document.querySelector(`[data-screen="command-palette"] [role="option"][data-key="command:${key}"]`), id), 10_000, { message: `palette entry ${id}` });
  // The result list re-renders while the filter settles: an entry found a moment ago can be
  // replaced by an identical node. Look it up again instead of failing on the stale reference.
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

/** Start from the context menu of `sha` with a branch/tag as good commit. */
async function startWithRef(app, sha, refName) {
  await fromMenu(app, sha, "Start bisect");
  const box = await dialog(app, "Start bisect");
  const option = await app.waitFor(() => app.exec((scope, name) => [...scope.querySelectorAll('[role="option"]')].find((node) => node.querySelector("span")?.textContent.trim() === name) ?? null, box, refName), 8000, { message: `option ${refName}` });
  await app.click(option);
  await app.click(await buttonIn(app, box, "Start bisect"));
  await noDialog(app);
}

/** Marks the commit under test according to the oracle until the result is there; returns the marked shas. */
async function bisectToEnd(app, repoId, repo, { onStep } = {}) {
  const marked = [];
  for (let round = 0; round < 20; round++) {
    const status = await uiBisect(app, repoId);
    if (status.result) return marked;
    assert(status.current, "a commit under test");
    assertEqual(repo.tip("HEAD"), status.current, "Git HEAD = commit under test");
    const verdict = hasBug(repo, status.current) ? "bad" : "good";
    await onStep?.(status, verdict);
    await app.click(`[data-graph-bisect] [data-bisect-verdict="${verdict}"]`);
    await waitSteps(app, repoId, status.stepsDone + 1);
    marked.push({ sha: status.current, verdict });
  }
  throw new Error("bisect did not end after 20 marks");
}

// ---------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------

scenario("start: from the context menu of the bad commit with a tag as good commit", "main", async (t) => {
  const { repo, good, head, shas } = makeBisectRepo({ name: "bisect-start" });
  try {
    const app = await launch(t);
    const { repoId, tabId } = await openGraph(app, repo);
    assertEqual(await bar(app), null, "no bar before the start");

    await rightClick(app, await row(app, head));
    await menuItem(app, "Start bisect");
    await app.click(await menuItem(app, "Start bisect"));
    const box = await dialog(app, "Start bisect");
    assertIncludes(await textOf(app, box), `${short(head)} is the bad commit`, "dialog names the bad commit");
    const options = await app.exec((scope) => [...scope.querySelectorAll('[role="option"]')].map((node) => node.innerText.replace(/\s+/g, " ").trim()), box);
    assertEqual(options, [`v1.0 ${short(good)}`], "only refs on other commits are offered (main = HEAD is left out)");
    await app.click(await buttonIn(app, box, "Start bisect"));
    await noDialog(app);

    const shown = await waitBar(app, "running");
    const status = await uiBisect(app, repoId);
    const git = gitBisect(repo);
    assert(git.active, "Git: BISECT_START exists");
    assertEqual(git.bad, head, "Git: refs/bisect/bad = selected commit");
    assertEqual(git.good, [good], "Git: refs/bisect/good-* = v1.0");
    assertEqual(git.branch, null, "Git: HEAD detached");
    assertEqual(status.current, git.head, "UI commit under test = Git HEAD");
    assert(shas.slice(1, -1).includes(git.head), "commit under test lies between good and bad");
    assertMatch(shown.text, new RegExp(`^Bisect · Step 1 of ~\\d+ · testing ${short(git.head)}`), "bar text");
    await waitChip(app, head, "bad");
    await waitChip(app, good, "good");
    assertEqual(await app.exec(() => [...document.querySelectorAll("[data-graph-bisect] [data-bisect-verdict]")].map((node) => node.dataset.bisectVerdict)), ["good", "bad", "skip"], "bar buttons");
    const selected = await selection(app, tabId);
    assertEqual([selected.kind, selected.shas], ["commits", [git.head]], "graph jumps to the commit under test");
    await parkMouse(app);
    await closeToasts(app);
    await t.shot("start-from-context-menu");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("start: two selected commits, order confirmed in the dialog", "edge", async (t) => {
  const { repo, shas } = makeBisectRepo({ name: "bisect-zwei" });
  try {
    const app = await launch(t);
    await openGraph(app, repo);
    const older = shas[2];
    const newer = shas[10];
    await app.click(rowSelector(newer));
    await modClick(app, rowSelector(older));
    await app.waitFor('[data-screen="commit-details"][data-selection="2"]', 10_000);
    await rightClick(app, await row(app, older));
    await app.click(await menuItem(app, "Start bisect"));
    const box = await dialog(app, "Start bisect");
    const labels = await app.exec((scope) => [...scope.querySelectorAll('[role="group"] button')].map((node) => node.innerText.replace(/\s+/g, " ").trim()), box);
    assertEqual(labels, [`Bad: ${short(newer)} · Good: ${short(older)}`, `Bad: ${short(older)} · Good: ${short(newer)}`], "both orders offered, selection order first");
    await app.click(await app.waitFor(() => app.exec((scope, wanted) => [...scope.querySelectorAll('[role="group"] button')].find((node) => node.innerText.includes(wanted)) ?? null, box, `Bad: ${short(newer)}`), 5000));
    await noDialog(app);
    await waitBar(app, "running");
    const git = gitBisect(repo);
    assertEqual([git.bad, git.good], [newer, [older]], "Git: bad/good as chosen");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("start: wrong order (good is newer than bad) is refused and leaves no half bisect", "edge", async (t) => {
  const { repo, shas } = makeBisectRepo({ name: "bisect-falschrum" });
  try {
    const app = await launch(t);
    await openGraph(app, repo);
    const older = shas[2];
    const newer = shas[10];
    await app.click(rowSelector(newer));
    await modClick(app, rowSelector(older));
    await app.waitFor('[data-screen="commit-details"][data-selection="2"]', 10_000);
    await rightClick(app, await row(app, older));
    await app.click(await menuItem(app, "Start bisect"));
    const box = await dialog(app, "Start bisect");
    await app.click(await app.waitFor(() => app.exec((scope, wanted) => [...scope.querySelectorAll('[role="group"] button')].find((node) => node.innerText.includes(wanted)) ?? null, box, `Bad: ${short(older)}`), 5000));
    await noDialog(app);
    const toast = await waitToast(app, /bisect|ancestor|merge base/i);
    t.step(`toast: ${toast.text}`);
    await app.settle();
    assertEqual(await bar(app), null, "no bar");
    const git = gitBisect(repo);
    assertEqual([git.active, Object.keys(git.refs).length, git.branch], [false, 0, "main"], "Git: no bisect left, still on main");
    await app.errors();
  } finally {
    repo.cleanup();
  }
});

scenario("start: uncommitted changes are refused with a hint to stash", "edge", async (t) => {
  const { repo, good, head } = makeBisectRepo({ name: "bisect-dreckig" });
  try {
    repo.write("messwerte.csv", `${repo.read("messwerte.csv")}2026-05-01;99.9\n`);
    const app = await launch(t);
    await openGraph(app, repo);
    await startWithRef(app, head, "v1.0");
    const toast = await waitToast(app, /working directory must be clean/i);
    assertIncludes(toast.text, "stash", "toast mentions stash");
    assertEqual(await bar(app), null, "no bar");
    assertEqual(gitBisect(repo).active, false, "Git: no bisect");
    assertEqual(repo.tip("HEAD"), head, "Git: HEAD unchanged");
    assertIncludes(repo.git("status", "--porcelain"), "messwerte.csv", "the change is still there");
    assert(good, "fixture");
    await app.errors();
  } finally {
    repo.cleanup();
  }
});

scenario("start: cancel the dialog; no other branch or tag shows an empty list", "edge", async (t) => {
  const { repo, head } = makeBisectRepo({ name: "bisect-leer" });
  try {
    repo.git("tag", "-d", "v1.0");
    const app = await launch(t);
    await openGraph(app, repo);
    await fromMenu(app, head, "Start bisect");
    const box = await dialog(app, "Start bisect");
    assertIncludes(await textOf(app, box), "No other branch or tag – select two commits in the graph instead.", "empty state");
    assertEqual(await app.exec((scope) => [...scope.querySelectorAll("button")].find((node) => node.textContent.trim() === "Start bisect")?.disabled ?? null, box), true, "confirm disabled");
    await app.press("Escape");
    await noDialog(app);
    await app.settle();
    assertEqual(await bar(app), null, "no bar after cancel");
    assertEqual(gitBisect(repo).active, false, "Git: no bisect after cancel");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("start: while a bisect runs the menu offers marks instead of a second start", "edge", async (t) => {
  const { repo, head, shas } = makeBisectRepo({ name: "bisect-zweimal" });
  try {
    const app = await launch(t);
    await openGraph(app, repo);
    await startWithRef(app, head, "v1.0");
    await waitBar(app, "running");
    await rightClick(app, await row(app, shas[3]));
    await menuItem(app, "Bisect: mark as good");
    const labels = await menuLabels(app);
    assert(!labels.some((label) => label.startsWith("Start bisect")), `no start entry: ${JSON.stringify(labels)}`);
    for (const label of ["Bisect: mark as good", "Bisect: mark as bad", "Bisect: skip this commit"]) assert(labels.includes(label), `entry ${label}`);
    await closeMenu(app);
    // Two selected commits: the start entry is there but blocked with the reason.
    await app.click(rowSelector(shas[2]));
    await modClick(app, rowSelector(shas[4]));
    await app.waitFor('[data-screen="commit-details"][data-selection="2"]', 10_000);
    await rightClick(app, await row(app, shas[4]));
    const entry = await menuItem(app, "Start bisect");
    assertEqual(await entry.attr("aria-disabled"), "true", "start entry disabled");
    assertIncludes(await textOf(app, entry), "A bisect is already running", "reason shown");
    await closeMenu(app);
    assertEqual(gitBisect(repo).good.length, 1, "Git: unchanged");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Good / bad / skip
// ---------------------------------------------------------------------------------------------

scenario("marks: good and bad from the bar until the first bad commit is found", "main", async (t) => {
  const { repo, head, bug } = makeBisectRepo({ name: "bisect-markieren" });
  try {
    const app = await launch(t);
    const { repoId } = await openGraph(app, repo);
    await startWithRef(app, head, "v1.0");
    await waitBar(app, "running");
    let shotTaken = false;
    const marked = await bisectToEnd(app, repoId, repo, {
      onStep: async (status) => {
        const shown = await bar(app);
        assertMatch(shown.text, new RegExp(`Step ${status.stepsDone + 1} of ~${status.stepsDone + 1 + (status.remainingSteps ?? 0)} · testing ${short(status.current)}`), "bar step text");
        if (status.stepsDone === 1 && !shotTaken) {
          shotTaken = true;
          await parkMouse(app);
          await closeToasts(app);
          await t.shot("marks-step-two");
        }
      },
    });
    t.step(`marks: ${marked.map((m) => `${short(m.sha)}=${m.verdict}`).join(", ")}`);
    const status = await uiBisect(app, repoId);
    assertEqual(status.result, bug, "UI result = commit with the bug");
    const git = gitBisect(repo);
    for (const { sha, verdict } of marked) {
      assertMatch(git.log, new RegExp(`git bisect ${verdict} ${sha}`), `Git log: ${verdict} ${short(sha)}`);
      if (verdict === "good") assert(git.good.includes(sha), `Git: good-${short(sha)}`);
    }
    assertEqual(git.bad, bug, "Git: refs/bisect/bad = bug commit");
    assertIncludes(git.log, `# first bad commit: [${bug}]`, "Git log: first bad commit");
    for (const { sha, verdict } of marked.filter((m) => m.verdict === "good")) if (await app.$(`[data-row-id="${sha}"]`)) assertEqual(await chip(app, sha), "good", `chip good ${short(sha)}`);
    await waitChip(app, bug, "bad");
    await waitBar(app, "found");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("marks: skip from the bar, mark a chosen commit from the context menu, mark through the palette", "edge", async (t) => {
  const { repo, head, shas, bug } = makeBisectRepo({ name: "bisect-skip" });
  try {
    const app = await launch(t);
    const { repoId } = await openGraph(app, repo);
    await startWithRef(app, head, "v1.0");
    await waitBar(app, "running");

    const first = await uiBisect(app, repoId);
    await app.click(await barButton(app, "Skip"));
    const afterSkip = await waitSteps(app, repoId, 1);
    let git = gitBisect(repo);
    assertEqual(git.skipped, [first.current], "Git: refs/bisect/skip-<commit under test>");
    assert(afterSkip.current && afterSkip.current !== first.current, "a different commit to test");
    assertEqual(git.head, afterSkip.current, "Git HEAD moved on");
    await waitChip(app, first.current, "skip");
    assertEqual(await app.exec((sha) => document.querySelector(`[data-row-id="${sha}"] [data-bisect]`)?.textContent.trim(), first.current), "skipped", "chip text");

    // Context menu on a commit that is not under test: shas[2] is before the bug, so "good".
    const chosen = shas[2];
    assert(!hasBug(repo, chosen) && chosen !== afterSkip.current, "fixture: chosen commit is good and not under test");
    await fromMenu(app, chosen, "Bisect: mark as good");
    await waitSteps(app, repoId, 2);
    git = gitBisect(repo);
    assert(git.good.includes(chosen), "Git: good-<chosen commit>");
    assertMatch(git.log, new RegExp(`git bisect good ${chosen}`), "Git log names the chosen commit");
    await waitChip(app, chosen, "good");

    // Palette: the verdict for the commit under test.
    const now = await uiBisect(app, repoId);
    const verdict = hasBug(repo, now.current) ? "bad" : "good";
    await runCommand(app, `Bisect: mark the commit under test as ${verdict}`, `bisect.${verdict}`);
    await waitSteps(app, repoId, 3);
    assertMatch(gitBisect(repo).log, new RegExp(`git bisect ${verdict} ${now.current}`), "Git log: palette mark");
    await bisectToEnd(app, repoId, repo);
    assertEqual((await uiBisect(app, repoId)).result, bug, "result still the bug commit despite the skip");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("marks: only skipped commits left between good and bad", "edge", async (t) => {
  // v1.0 (good), one commit with the bug, one more: skipping the only candidate leaves Git undecided.
  const { repo, good, head, bug } = makeBisectRepo({ name: "bisect-nur-skip", total: 3, bugAt: 1 });
  try {
    const app = await launch(t);
    const { repoId } = await openGraph(app, repo);
    await startWithRef(app, head, "v1.0");
    await waitBar(app, "running");
    assertEqual((await uiBisect(app, repoId)).current, bug, "the one candidate is under test");
    await app.click(await barButton(app, "Skip"));
    const shown = await waitBar(app, "only_skipped");
    assertIncludes(shown.text, "Only skipped commits are left – the first bad commit is one of them", "bar text");
    assertEqual(await app.exec(() => document.querySelectorAll("[data-graph-bisect] [data-bisect-verdict]").length), 0, "no mark buttons");
    const git = gitBisect(repo);
    assertEqual([git.active, git.skipped, git.good, git.bad], [true, [bug], [good], head], "Git: skip ref, bisect still active");
    await app.click(await barButton(app, "End bisect"));
    await waitBar(app, null);
    assertEqual(gitBisect(repo).branch, "main", "Git: back on main");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------------------------

scenario("result: bar shows the first bad commit, details open, end returns to the branch", "main", async (t) => {
  const { repo, head, bug } = makeBisectRepo({ name: "bisect-ergebnis", total: 9, bugAt: 5 });
  try {
    const app = await launch(t);
    const { repoId, tabId } = await openGraph(app, repo);
    await startWithRef(app, head, "v1.0");
    await waitBar(app, "running");
    await bisectToEnd(app, repoId, repo);
    const found = await waitBar(app, "found");
    assertEqual(found.text, `Bisect · First bad commit: ${short(bug)} Show details End bisect`, "bar text with buttons");
    assertEqual(await app.exec(() => document.querySelectorAll("[data-graph-bisect] [data-bisect-verdict]").length), 0, "no mark buttons after the result");

    // Select something else first so "Show details" visibly jumps back.
    await app.click(rowSelector(head));
    await app.waitFor(async () => (await selection(app, tabId)).shas?.[0] === head, 5000, { message: "head selected" });
    await app.click(await barButton(app, "Show details"));
    await app.waitFor(async () => {
      const selected = await selection(app, tabId);
      return selected.kind === "commits" && JSON.stringify(selected.shas) === JSON.stringify([bug]);
    }, 8000, { message: "bug commit selected" });
    const details = await app.waitFor('[data-screen="commit-details"][data-selection="1"]', 8000);
    await app.waitFor(async () => (await textOf(app, details)).includes("Umrechnung vereinfacht"), 8000, { message: "details of the bug commit" });
    await parkMouse(app);
    await closeToasts(app);
    await t.shot("result-found");

    await app.click(await barButton(app, "End bisect"));
    await waitBar(app, null);
    const git = gitBisect(repo);
    assertEqual([git.active, Object.keys(git.refs).length, git.branch, git.head], [false, 0, "main", head], "Git: bisect reset, back on main at the old tip");
    assertEqual(await chip(app, bug), null, "no chips after the end");
    assertEqual((await selection(app, tabId)).kind, "wip", "selection back on the working copy");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("result: end a running bisect midway through the palette", "edge", async (t) => {
  const { repo, head } = makeBisectRepo({ name: "bisect-abbruch" });
  try {
    const app = await launch(t);
    const { repoId } = await openGraph(app, repo);
    await startWithRef(app, head, "v1.0");
    await waitBar(app, "running");
    await app.click(await barButton(app, "Good"));
    await waitSteps(app, repoId, 1);
    await runCommand(app, "End bisect", "bisect.end");
    await waitBar(app, null);
    const git = gitBisect(repo);
    assertEqual([git.active, git.branch, git.head], [false, "main", head], "Git: reset to main");
    // The commands are gone again once nothing runs.
    await app.press("Control+p");
    const input = await app.waitFor('[data-screen="command-palette"] input[role="combobox"]', 10_000);
    await app.type(input, ">Bisect");
    await app.settle(500);
    const entries = await app.exec(() => [...document.querySelectorAll('[data-screen="command-palette"] [role="option"][data-key^="command:bisect."]')].map((node) => ({ key: node.dataset.key, disabled: node.getAttribute("aria-disabled"), text: node.innerText.replace(/\s+/g, " ").trim() })));
    assertEqual(entries.length, 4, "the four bisect commands are listed");
    for (const entry of entries) {
      assertEqual(entry.disabled, "true", `${entry.key} disabled`);
      assertIncludes(entry.text, "No bisect is running", `${entry.key} names the reason`);
    }
    await app.press("Escape");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Started outside the app
// ---------------------------------------------------------------------------------------------

scenario("extern: bisect started on the command line is picked up on open and continued in the app", "main", async (t) => {
  const { repo, good, head, bug } = makeBisectRepo({ name: "bisect-extern" });
  try {
    repo.git("bisect", "start", head, good);
    repo.git("bisect", hasBug(repo, repo.tip()) ? "bad" : "good");
    const before = gitBisect(repo);
    const app = await launch(t);
    const { repoId } = await openGraph(app, repo);
    const shown = await waitBar(app, "running");
    const status = await uiBisect(app, repoId);
    assertEqual(status.current, before.head, "UI commit under test = Git HEAD");
    assertEqual(status.stepsDone, 1, "the terminal mark counts as a step");
    assertMatch(shown.text, new RegExp(`Step 2 of ~\\d+ · testing ${short(before.head)}`), "bar text");
    await waitChip(app, head, "bad");
    // The graph does not also show its detached-HEAD bar (the bisect bar explains the state).
    assertEqual(await app.exec(() => document.querySelector('[data-screen="commit-graph"]').innerText.toLowerCase().includes("detached")), false, "no detached-HEAD bar above the graph");
    await parkMouse(app);
    await t.shot("extern-picked-up");
    await bisectToEnd(app, repoId, repo);
    assertEqual((await uiBisect(app, repoId)).result, bug, "result");
    assertEqual(repo.git("bisect", "log").split("\n").filter((line) => /^git bisect (good|bad|skip)/.test(line)).length >= 2, true, "Git log has terminal and app marks");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("extern: started and reset in the terminal while the app is open", "edge", async (t) => {
  const { repo, good, head } = makeBisectRepo({ name: "bisect-live" });
  try {
    const app = await launch(t);
    const { repoId } = await openGraph(app, repo);
    assertEqual(await bar(app), null, "no bar");
    repo.git("bisect", "start", head, good);
    await nudge(app);
    const running = await waitBar(app, "running");
    assertEqual((await uiBisect(app, repoId)).current, repo.tip("HEAD"), "UI follows the checkout of the terminal");
    assertIncludes(running.text, `testing ${short(repo.tip("HEAD"))}`, "bar text");
    await waitChip(app, head, "bad");
    repo.git("bisect", "reset");
    await nudge(app);
    await waitBar(app, null);
    assertEqual(gitBisect(repo).branch, "main", "Git: back on main");
    assertEqual(await chip(app, head), null, "chips gone");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("extern: waiting state on open – only a bad commit marked in the terminal", "edge", async (t) => {
  const { repo, good, head } = makeBisectRepo({ name: "bisect-wartet" });
  try {
    // On open: deterministic, read from .git.
    repo.git("bisect", "start");
    repo.git("bisect", "bad", head);
    const app = await launch(t);
    await openGraph(app, repo);
    const waiting = await waitBar(app, "waiting");
    assertEqual(waiting.text, "Bisect · Mark a good commit to begin Good Bad Skip End bisect", "bar asks for a good commit");
    await waitChip(app, head, "bad");
    // Marking a good commit from the context menu completes the range.
    await fromMenu(app, good, "Bisect: mark as good");
    await waitBar(app, "running");
    assertEqual(gitBisect(repo).good, [good], "Git: good ref from the context menu");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

// Documents an app bug (see the bisect report): the watcher intermittently misses the first
// ref written into a freshly created .git/refs/bisect folder, so the bar never appears.
scenario("extern: waiting state while open – start and bad in the terminal create refs/bisect", "edge", async (t) => {
  const { repo, good, head } = makeBisectRepo({ name: "bisect-wartet" });
  const other = makeBisectRepo({ name: "bisect-wartet-live" });
  try {
    // Same sequence as the original report: a first repository with a bisect run from the app.
    repo.git("bisect", "start");
    repo.git("bisect", "bad", head);
    const app = await launch(t);
    await openGraph(app, repo);
    await waitBar(app, "waiting");
    await fromMenu(app, good, "Bisect: mark as good");
    await waitBar(app, "running");

    // While open: `git bisect start` + `git bisect bad` in the terminal only create refs/bisect/bad
    // (a new folder, no checkout). The bar has to appear all the same.
    const second = await app.openRepo(other.repo.path);
    await app.waitFor('[data-screen="commit-graph"][data-state="ready"]', 30_000);
    await app.settle();
    assertEqual(await bar(app), null, "no bar in the second repository");
    other.repo.git("bisect", "start");
    other.repo.git("bisect", "bad", other.head);
    assert(gitBisect(other.repo).active && gitBisect(other.repo).bad === other.head, "Git: bisect with only a bad commit");
    await nudge(app);
    await waitBar(app, "waiting").catch(async (error) => {
      const cached = await uiBisect(app, second.repoId);
      const core = await app.invoke("bisect_status", { repoId: second.repoId });
      await t.shot("FAIL-waiting-live-stale-bar");
      // Cross-check: rewriting the ref inside the now-watched refs/bisect folder must reach the UI.
      other.repo.git("update-ref", "refs/bisect/bad", other.head);
      const late = await waitBar(app, "waiting", 8000).then(() => "appeared", () => "still missing");
      // Second cross-check: a new tag (refs/tags exists since the fixture) is a plain refs change.
      other.repo.git("tag", "kontrolle");
      const tagged = await app.waitFor(() => app.exec(() => !!document.querySelector('[data-screen="commit-graph"]')?.innerText.includes("kontrolle")), 8000).then(() => "shown", () => "not shown");
      const afterTag = await waitBar(app, "waiting", 5000).then(() => "appeared", () => "still missing");
      const active = await app.exec(() => window.__gc.store.getState().activeTabId ?? null).catch(() => null);
      throw new Error(
        `${error.message}; UI cache active=${cached?.active}, core says active=${core.active} bad=${core.bad?.slice(0, 7)}; ` +
          `after rewriting refs/bisect/bad in the existing folder the bar ${late}; new tag ${tagged} in the graph, bar then ${afterTag}; ` +
          `active tab ${active} (second repo tab ${second.tabId})`,
      );
    });
    await t.shot("extern-waiting-live");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
    other.repo.cleanup();
  }
});

scenario("extern: bisect with own terms (old/new) is marked with those terms", "edge", async (t) => {
  const { repo, good, head, bug } = makeBisectRepo({ name: "bisect-terms" });
  try {
    repo.git("bisect", "start", "--term-old=alt", "--term-new=neu", head, good);
    const app = await launch(t);
    const { repoId } = await openGraph(app, repo);
    await waitBar(app, "running");
    let status = await uiBisect(app, repoId);
    assertEqual([status.bad, status.good], [head, [good]], "UI reads refs/bisect/neu and alt-*");
    const marked = await bisectToEnd(app, repoId, repo);
    const git = gitBisect(repo);
    for (const { sha, verdict } of marked) assertMatch(git.log, new RegExp(`git bisect ${verdict === "good" ? "alt" : "neu"} ${sha}`), `Git log uses the own term for ${short(sha)}`);
    status = await uiBisect(app, repoId);
    assertEqual(status.result, bug, "result with own terms");
    assertEqual(git.refs["refs/bisect/neu"], bug, "Git: refs/bisect/neu = bug commit");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});

scenario("extern: bisect --no-checkout tests BISECT_HEAD, the working tree stays", "edge", async (t) => {
  const { repo, good, head, bug } = makeBisectRepo({ name: "bisect-nocheckout" });
  try {
    repo.git("bisect", "start", "--no-checkout", head, good);
    const app = await launch(t);
    const { repoId } = await openGraph(app, repo);
    await waitBar(app, "running");
    const status = await uiBisect(app, repoId);
    assertEqual(status.current, repo.tip("BISECT_HEAD"), "commit under test = BISECT_HEAD");
    assertEqual(repo.tip("HEAD"), head, "HEAD stays");
    const verdict = hasBug(repo, status.current) ? "bad" : "good";
    await app.click(await barButton(app, verdict === "bad" ? "Bad" : "Good"));
    const next = await waitSteps(app, repoId, 1);
    assertMatch(gitBisect(repo).log, new RegExp(`git bisect ${verdict} ${status.current}`), "Git log: mark of BISECT_HEAD");
    assertEqual(next.current, next.result ?? repo.tip("BISECT_HEAD"), "next commit = BISECT_HEAD");
    assertEqual(repo.tip("HEAD"), head, "HEAD still unchanged");
    assert(bug, "fixture");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});
