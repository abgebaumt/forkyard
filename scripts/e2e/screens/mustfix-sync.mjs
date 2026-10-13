/**
 * Checks in the real app, against real Git:
 * - "Branch from HEAD or from any commit": context menu in the graph ("Create branch here …") and
 *   Ctrl+B with a selected commit (keyboard only), name validation.
 * - "Fast-forward a branch": checked-out branch behind its upstream; branch that is not checked out
 *   without checking it out (only the ref moves, keyboard only), undo/redo; a branch with own commits is refused.
 * - "Pull mode per repository": own default in the repository's settings, applies only there.
 * - "Pull with fast-forward, fast-forward only or rebase and a saved default": split menu in the toolbar.
 * - "Fetch all remotes" with an unreachable remote: the toast names it, the others are fetched.
 * - "Auto-fetch": interval set to 1 minute in the settings, the remote gets a commit, the app shows
 *   "1 commit to pull" on its own; a repository without network and one without credentials stay quiet.
 *
 *   node scripts/e2e/screens/mustfix-sync.mjs [--show] [--no-shots] [--only <part>]
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { makeCleanRepoWithRemote } from "../fixtures.mjs";
import { startGitHttpServer } from "../git-http-server.mjs";
import { createRun, sleep } from "./mustfix-lib.mjs";
import { makeWorkspace } from "./repo-entry-lib.mjs";

const argv = process.argv.slice(2);
const show = argv.includes("--show");
const t = createRun("mustfix-sync", { argv });
const { check, equal, eventually, section, waitDialog, waitToast, noErrorToast, shot } = t;

const ws = makeWorkspace("sync");
const repo = makeCleanRepoWithRemote(); // "messnetz": main and feature/export, both pushed
const offline = makeCleanRepoWithRemote({ name: "funkloch" });
const locked = makeCleanRepoWithRemote({ name: "tresor" });
const server = await startGitHttpServer({ users: { lena: "geheim" } });
server.createBare("tresor.git", { from: locked.path });

const closedPort = await new Promise((resolve) => {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const short = (sha) => sha.slice(0, 7);
// The label of the split button next to Pull.
const PULL_OPTIONS = /^Pull: options$/i;

let app = null;
let page = null;

try {
  app = await launchApp({ show, width: 1440, height: 900, theme: "dark" });
  page = app.page;
  t.attach(app);
  // Auto-fetch is only tested in the last section; until then it must not interfere.
  await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
  await page.evaluate(() => {
    window.__mfRequests = 0;
    window.__gc.core.on("credential:request", () => {
      window.__mfRequests += 1;
    });
    // Record every toast, even if it disappears again after five seconds.
    window.__mfToasts = [];
    new MutationObserver(() => {
      for (const element of document.querySelectorAll("[data-toast]")) {
        const text = `${element.getAttribute("data-toast")}: ${element.innerText.replace(/\s+/g, " ").trim()}`;
        if (!window.__mfToasts.includes(text)) window.__mfToasts.push(text);
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  const seenToasts = () => page.evaluate(() => window.__mfToasts.slice());
  const forgetToasts = () => page.evaluate(() => void (window.__mfToasts.length = 0));

  const { repoId, tabId } = await app.openRepo(repo.path);
  const graph = page.locator("[data-graph-scroller]");
  const graphRow = (summary) => graph.locator('[role="row"]').filter({ hasText: summary }).first();
  const leftRow = (id) => page.locator(`[data-screen="sidebar"] [data-row-id="${id}"]`);
  const menu = () => page.getByRole("menu").last();
  const menuEntries = () =>
    menu()
      .locator('[role="menuitem"]')
      .evaluateAll((list) =>
        list.map((item) => ({
          text: (item.innerText ?? "").replace(/\s+/g, " ").trim(),
          disabled: item.hasAttribute("data-disabled"),
          current: item.getAttribute("aria-current") === "true",
        })),
      );
  const selection = () => page.evaluate((id) => window.__gc.store.getState().views[id]?.selection ?? null, tabId);
  const head = () => repo.git("rev-parse", "HEAD");
  const branchOfHead = () => repo.git("symbolic-ref", "--short", "HEAD");
  const settings = () => app.invoke("settings_get");
  const blur = () => page.evaluate(() => document.activeElement?.blur?.());
  const toolHint = (label) => t.toolButton(label).evaluate((button) => document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent ?? "");
  const checkoutMain = async () => {
    await app.invoke("branch_checkout", { repoId, target: "main" });
    await t.refresh(repoId);
  };
  const localCommit = (file, message) => {
    repo.write(file, `${message}\n`);
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", message);
    return head();
  };
  /** Opens the pull menu with the keyboard and picks the entry with arrow keys and Enter. */
  const pickPullMode = async (label) => {
    // A menu that was just closed is still fading out: wait until it is gone.
    await eventually(() => page.getByRole("menu").count(), 0, "no menu open any more");
    // Only open once pull is available again. Right after a pull with rebase the app briefly still
    // shows the status from the middle of it (detached HEAD, "rebase in progress") until the core's
    // event reloads it. During that time the three pull entries are disabled, the highlight lands
    // on "Fetch (all remotes)" – the last entry – when opening, and arrow down leads nowhere from
    // there (measured: status with operation "rebase" and three entries aria-disabled in 3 of 6 runs;
    // this comment used to blame load for it).
    await eventually(async () => (await t.toolState("Pull")).disabled, false, "pull is available: the status after the last action is loaded");
    await page.getByRole("button", { name: PULL_OPTIONS }).focus();
    await page.keyboard.press("Enter");
    await menu().waitFor();
    const highlightedText = () => page.evaluate(() => (document.querySelector('[role="menuitem"][data-highlighted]')?.textContent ?? "").trim());
    await eventually(highlightedText, "Pull (fast-forward if possible)", "opened with the keyboard, the highlight is on the first entry");
    for (let step = 0; step < 4; step++) {
      const highlighted = await highlightedText();
      if (highlighted.startsWith(label)) break;
      await page.keyboard.press("ArrowDown");
      await eventually(highlightedText, (text) => text !== "" && text !== highlighted, "the highlight moves to the next entry", 3000);
    }
    equal(await page.evaluate(() => (document.querySelector('[role="menuitem"][data-highlighted]')?.textContent ?? "").trim()), label, `"${label}" is reached with the arrow keys`);
    await page.keyboard.press("Enter");
  };

  const mainStart = repo.info.head;
  const second = repo.git("rev-parse", "main~1"); // "Liste der Stationen"
  const root = repo.git("rev-list", "--max-parents=0", "main"); // "Projekt für das Messnetz angelegt"

  await section("Branch from any commit: context menu in the graph \"Create branch here …\"", async () => {
    await graphRow("Liste der Stationen").click({ button: "right" });
    await menu().waitFor();
    const entries = await menuEntries();
    check(entries[0]?.text.startsWith("Create branch here") && !entries[0].disabled, `the first entry of the commit menu is "Create branch here …": ${JSON.stringify(entries.slice(0, 3))}`);
    await shot("mustfix-sync-commit-menu");
    await menu().getByRole("menuitem", { name: /^Create branch here/ }).click();
    const dialog = await waitDialog(/^New branch$/);
    const text = (await dialog.innerText()).replace(/\s+/g, " ");
    check(text.includes(short(second)) && text.includes("Liste der Stationen"), `the dialog names the start point (${short(second)}, summary): ${text.slice(0, 200)}`);
    equal((await t.focused()).label, "Name", "focus is in the name field");
    // Name validation: a name that is taken is refused while typing.
    await page.keyboard.type("main");
    await dialog.getByRole("alert").waitFor();
    check(/already exists/i.test(await dialog.getByRole("alert").innerText()), `name taken: ${await dialog.getByRole("alert").innerText()}`);
    await shot("mustfix-sync-branch-name-taken");
    await page.keyboard.press("Control+a");
    await page.keyboard.type("analyse stationen");
    equal(await dialog.getByLabel("Name").inputValue(), "analyse-stationen", "spaces become \"-\" while typing");
    await eventually(() => dialog.getByRole("alert").count(), 0, "the new name is valid");
    await shot("mustfix-sync-branch-here");
    await page.keyboard.press("Enter");
    await waitToast(/Branch “analyse-stationen” created and checked out/, "success");
    equal(repo.git("rev-parse", "analyse-stationen"), second, "the branch points to the selected commit (git rev-parse)");
    equal(branchOfHead(), "analyse-stationen", "it is checked out (git symbolic-ref)");
    equal(repo.git("rev-parse", "main"), mainStart, "main is untouched");
    await eventually(async () => (await graphRow("Liste der Stationen").innerText()).includes("analyse-stationen"), true, "the graph shows the label on the commit");
    await eventually(() => page.locator("footer").getByText("analyse-stationen", { exact: true }).count(), 1, "the status bar shows the new branch");
  });

  await section("Ctrl+B with a selected commit, keyboard only", async () => {
    await blur();
    // Alt+2 moves focus into the graph; arrow down walks to the first commit of the history.
    await page.keyboard.press("Alt+2");
    await eventually(() => page.evaluate(() => Boolean(document.activeElement?.closest("[data-graph-scroller]"))), true, "Alt+2 moves focus into the graph");
    for (let step = 0; step < 12; step++) {
      const now = await selection();
      if (now?.kind === "commits" && now.shas.length === 1 && now.shas[0] === root) break;
      await page.keyboard.press("ArrowDown");
      await sleep(60);
    }
    equal(await selection(), { kind: "commits", shas: [root] }, "with arrow down the first commit of the history is selected");
    check((await toolHint("Branch")).includes(`at the selected commit ${short(root)}`), `the branch button's tooltip names the selected commit: ${await toolHint("Branch")}`);
    await page.keyboard.press("Control+b");
    const dialog = await waitDialog(/^New branch$/);
    const text = (await dialog.innerText()).replace(/\s+/g, " ");
    check(text.includes(short(root)) && text.includes("Projekt für das Messnetz angelegt"), `the dialog names the selected commit: ${text.slice(0, 200)}`);
    await page.keyboard.type("archiv/anfang");
    await shot("mustfix-sync-ctrl-b");
    await page.keyboard.press("Enter");
    await waitToast(/Branch “archiv\/anfang” created and checked out/, "success");
    equal(repo.git("rev-parse", "archiv/anfang"), root, "the branch points to the selected commit (git rev-parse)");
    equal(branchOfHead(), "archiv/anfang", "it is checked out");
    await t.closeToasts();

    // Without a selected commit (WIP row): Ctrl+B starts at the current commit.
    await page.evaluate((id) => window.__gc.store.getState().selectWip(id), tabId);
    await blur();
    await page.keyboard.press("Control+b");
    const plain = await waitDialog(/^New branch$/);
    check((await plain.innerText()).includes("at the current commit"), "without a selection the branch starts at the current commit");
    await page.keyboard.type("von-head");
    await page.keyboard.press("Enter");
    await waitToast(/Branch “von-head” created and checked out/, "success");
    equal(repo.git("rev-parse", "von-head"), root, "the branch starts at HEAD (that was archiv/anfang)");
    // Cancel creates nothing.
    await blur();
    await page.keyboard.press("Control+b");
    await waitDialog(/^New branch$/);
    await page.keyboard.type("doch-nicht");
    await page.keyboard.press("Escape");
    await eventually(t.dialogTitle, null, "Esc closes the dialog");
    check(!repo.git("branch", "--list", "doch-nicht"), "cancel creates no branch");
    await checkoutMain();
  });

  await section("Fast-forward: checked-out branch behind its upstream", async () => {
    const remoteSha = repo.commitOnRemote({ message: "Kalibrierung nachgetragen", file: "docs/kalibrierung.md" });
    await t.toolButton("Fetch").click();
    await waitToast(/Fetch complete/, "success", 60_000);
    await t.closeToasts();
    await eventually(() => t.toolState("Pull").then((state) => state.label), "Pull, 1 commit to pull", "after the fetch, pull shows ↓1");
    await leftRow("refs/heads/main").click({ button: "right" });
    await menu().waitFor();
    const entry = (await menuEntries()).find((item) => item.text.startsWith("Fast-forward to"));
    check(Boolean(entry) && !entry.disabled && entry.text.includes("origin/main") && entry.text.includes("1 commit"), `entry "Fast-forward to origin/main" with "1 commit": ${JSON.stringify(entry)}`);
    await shot("mustfix-sync-ff-menu");
    await menu().getByRole("menuitem", { name: /^Fast-forward to/ }).click();
    const done = await waitToast(/Fast-forward/, "success");
    check(Boolean(done), "toast for the fast-forward");
    equal(head(), remoteSha, "main is at the state of origin/main (git rev-parse)");
    equal(branchOfHead(), "main", "main stays checked out");
    equal(repo.git("rev-list", "--count", "--merges", `${mainStart}..HEAD`), "0", "without a merge commit");
    check(fs.existsSync(path.join(repo.path, "docs", "kalibrierung.md")), "the file from the remote is in the working directory");
    await eventually(() => t.toolState("Pull").then((state) => state.label), null, "the counter on the pull button is gone");
    // When up to date, the entry is disabled and says why.
    await t.closeToasts();
    await leftRow("refs/heads/main").click({ button: "right" });
    await menu().waitFor();
    const same = (await menuEntries()).find((item) => item.text.startsWith("Fast-forward to"));
    check(same?.disabled === true && same.text.includes("already up to date"), `disabled when up to date, with a reason: ${JSON.stringify(same)}`);
    await page.keyboard.press("Escape");
  });

  await section("Fast-forward: branch that is not checked out behind its upstream", async () => {
    const before = repo.git("rev-parse", "feature/export");
    const remoteSha = repo.commitOnRemote({ branch: "feature/export", message: "Export: Kopfzeile", file: "src/kopf.py" });
    await t.toolButton("Fetch").click();
    await waitToast(/Fetch complete/, "success", 60_000);
    await t.closeToasts();
    await eventually(async () => (await leftRow("refs/heads/feature/export").innerText()).replace(/\s+/g, " "), (text) => /1/.test(text), "the left panel shows that feature/export is 1 commit behind");
    await leftRow("refs/heads/feature/export").click({ button: "right" });
    await menu().waitFor();
    const entry = (await menuEntries()).find((item) => item.text.startsWith("Fast-forward to"));
    await shot("mustfix-sync-ff-other-branch");
    check(Boolean(entry) && !entry.disabled && entry.text.includes("origin/feature/export") && entry.text.includes("1 commit"), `enabled for a branch that is not checked out, with target and count: ${JSON.stringify(entry)}`);
    await page.keyboard.press("Escape");
    equal(repo.git("rev-parse", "feature/export"), before, "so far the branch is unchanged");
    const mainBefore = head();

    // Keyboard only: Alt+1 into the left panel, arrow keys to the branch, Shift+F10, pick the entry, Enter.
    await blur();
    await page.keyboard.press("Alt+1");
    await eventually(() => page.evaluate(() => Boolean(document.activeElement?.closest('[data-screen="sidebar"]'))), true, "Alt+1 moves focus into the left panel");
    const focusedRow = () => page.evaluate(() => document.activeElement?.closest("[data-row-id]")?.getAttribute("data-row-id") ?? null);
    for (let step = 0; step < 30 && (await focusedRow()) !== "refs/heads/feature/export"; step++) {
      await page.keyboard.press(step === 0 ? "Home" : "ArrowDown");
      await sleep(40);
    }
    equal(await focusedRow(), "refs/heads/feature/export", "the arrow keys reach feature/export");
    await page.keyboard.press("Shift+F10");
    await menu().waitFor();
    for (let step = 0; step < 20; step++) {
      const highlighted = await page.evaluate(() => document.querySelector('[role="menuitem"][data-highlighted]')?.textContent ?? "");
      if (highlighted.startsWith("Fast-forward to")) break;
      await page.keyboard.press("ArrowDown");
      await sleep(40);
    }
    await page.keyboard.press("Enter");
    const done = await waitToast(/Fast-forward complete/, "success");
    check(/Fast-forwarded feature\/export to origin\/feature\/export \(1 commit\)/.test(done?.text ?? ""), `the toast names branch, target and count: ${done?.text}`);
    check(/Undo/.test(done?.text ?? ""), "and offers \"Undo\"");
    await shot("mustfix-sync-ff-other-done");
    equal(repo.git("rev-parse", "feature/export"), remoteSha, "feature/export is at origin/feature/export (git rev-parse)");
    equal(branchOfHead(), "main", "main stays checked out (git symbolic-ref)");
    equal(head(), mainBefore, "HEAD is unchanged");
    equal(repo.git("status", "--porcelain"), "", "the working directory is untouched (git status)");
    check(!fs.existsSync(path.join(repo.path, "src", "kopf.py")), "the file from the remote commit is not in the working directory – nothing was checked out");
    equal(repo.git("rev-list", "--count", "--merges", `${before}..feature/export`), "0", "without a merge commit");
    await eventually(async () => (await leftRow("refs/heads/feature/export").innerText()).replace(/\s+/g, " ").trim(), (text) => !/\d/.test(text), "the left panel no longer shows the branch behind");

    // Up to date: disabled with a reason.
    await t.closeToasts();
    await leftRow("refs/heads/feature/export").click({ button: "right" });
    await menu().waitFor();
    const same = (await menuEntries()).find((item) => item.text.startsWith("Fast-forward to"));
    check(same?.disabled === true && same.text.includes("already up to date"), `disabled afterwards, with a reason: ${JSON.stringify(same)}`);
    await page.keyboard.press("Escape");

    // Undo (Ctrl+Z) only moves the ref back; Redo (toolbar) moves it forward again.
    await blur();
    await eventually(() => t.toolState("Undo").then((state) => state.disabled), false, "Undo is available");
    // The button was already available before (older step); its hint changes once the new undo entry is loaded.
    await eventually(() => toolHint("Undo").then((hint) => hint.includes("fast-forward of")), true, `the Undo tooltip names the step (last: ${await toolHint("Undo")})`);
    await page.keyboard.press("Control+z");
    await waitToast(/Undone/, "success");
    await eventually(() => repo.git("rev-parse", "feature/export"), before, "undo: feature/export is back on the old commit (git rev-parse)");
    equal(branchOfHead(), "main", "main stays checked out");
    equal(repo.git("rev-parse", "origin/feature/export"), remoteSha, "the remote state stays");
    await t.closeToasts();
    await t.toolButton("Redo").click();
    await waitToast(/Redone/, "success");
    await eventually(() => repo.git("rev-parse", "feature/export"), remoteSha, "redo: feature/export is ahead again");
    await t.closeToasts();
    // And back once more via the button in the fast-forward's own toast.
    await page.keyboard.press("Control+z");
    await waitToast(/Undone/, "success");
    await eventually(() => repo.git("rev-parse", "feature/export"), before, "back to the old state");
    await t.closeToasts();
    await t.refresh(repoId);
    await leftRow("refs/heads/feature/export").click({ button: "right" });
    await menu().waitFor();
    await menu().getByRole("menuitem", { name: /^Fast-forward to/ }).click();
    const again = await waitToast(/Fast-forward complete/, "success");
    check(Boolean(again), "fast-forward a second time");
    await page.locator('[data-toast="success"]').getByRole("button", { name: "Undo" }).click();
    await waitToast(/Undone/, "success");
    await eventually(() => repo.git("rev-parse", "feature/export"), before, "\"Undo\" in the toast reverts the fast-forward");
    await t.closeToasts();
    // For the following sections: the branch ends up ahead.
    await page.keyboard.press("Control+y");
    await eventually(() => repo.git("rev-parse", "feature/export"), remoteSha, "Ctrl+Y moves it forward again");
    await t.closeToasts();
  });

  await section("Fast-forward: a branch with own commits is refused clearly", async () => {
    // feature/export gets an own commit locally (as in the terminal), the remote a different one.
    repo.git("checkout", "-q", "feature/export");
    const own = localCommit("notizen/export-lokal.md", "Export: lokale Notiz");
    repo.git("checkout", "-q", "main");
    const remoteSha = repo.commitOnRemote({ branch: "feature/export", message: "Export: Fußzeile", file: "src/fuss.py" });
    await t.toolButton("Fetch").click();
    await waitToast(/Fetch complete/, "success", 60_000);
    await t.closeToasts();
    await t.refresh(repoId);
    equal(repo.git("rev-list", "--left-right", "--count", "feature/export...origin/feature/export"), "1\t1", "git: feature/export is 1 ahead and 1 behind");

    // In the menu: disabled, the reason names the own commits and the way out.
    await leftRow("refs/heads/feature/export").click({ button: "right" });
    await menu().waitFor();
    const entry = (await menuEntries()).find((item) => item.text.startsWith("Fast-forward to"));
    check(entry?.disabled === true && /1 own commit in the way/.test(entry.text) && /pull or rebase/.test(entry.text), `disabled with reason and way out: ${JSON.stringify(entry)}`);
    await shot("mustfix-sync-ff-own-commits");
    await page.keyboard.press("Escape");

    // The core refuses it even if the UI had a stale state (menu with an old counter).
    await page.evaluate(
      ([id, tab]) => {
        const refs = window.__gc.queryClient.getQueryData(["repo", id, "refs"]);
        const ref = refs.locals.find((item) => item.name === "feature/export");
        window.__gcUi.openMenuAt({ x: 320, y: 220 }, window.__gcUi.menus.branchMenu({ repoId: id, tabId: tab, ref: { ...ref, ahead: 0 } }), "E2E");
      },
      [repoId, tabId],
    );
    await menu().waitFor();
    await menu().getByRole("menuitem", { name: /^Fast-forward to/ }).click();
    const refused = await waitToast(/Fast-forward failed/, "danger");
    check(/has a commit of its own/.test(refused?.text ?? "") && /a fast-forward isn’t possible/.test(refused?.text ?? "") && /Check out the branch and pull/.test(refused?.text ?? ""), `the refusal says why – and what to do instead: ${refused?.text}`);
    await shot("mustfix-sync-ff-refused");
    equal(repo.git("rev-parse", "feature/export"), own, "the branch is unchanged (git rev-parse)");
    equal(repo.git("rev-parse", "origin/feature/export"), remoteSha, "so is the remote state");
    equal(branchOfHead(), "main", "main stays checked out");
    await t.closeToasts();
    // Clean up: the local commit disappears again, the branch is at the remote state.
    repo.git("branch", "-f", "feature/export", "origin/feature/export");
    await t.refresh(repoId);
  });

  await section("Pull: fast-forward only from the split menu becomes the default", async () => {
    equal((await settings()).defaultPullMode, "ff", "default: fast-forward if possible");
    const remoteSha = repo.commitOnRemote({ message: "Station Hafen: neue Höhe", file: "docs/hafen.md" });
    await page.getByRole("button", { name: PULL_OPTIONS }).focus();
    await page.keyboard.press("Enter");
    await menu().waitFor();
    const entries = await menuEntries();
    equal(
      entries.map((item) => item.text.replace(/\s*Ctrl.*$/, "")),
      ["Pull (fast-forward if possible)", "Pull (fast-forward only)", "Pull (rebase)", "Fetch (all remotes)"],
      "entries of the pull menu",
    );
    equal(entries.filter((item) => item.current).map((item) => item.text), ["Pull (fast-forward if possible)"], "the default is marked");
    check((await menu().innerText()).includes("Pull mode (becomes the default)"), "the heading says the choice becomes the default");
    await shot("mustfix-sync-pull-menu");
    await page.keyboard.press("Escape");
    await blur();
    await pickPullMode("Pull (fast-forward only)");
    await waitToast(/Pull/, "success", 60_000);
    equal(head(), remoteSha, "HEAD = remote state (git rev-parse)");
    equal(repo.git("rev-list", "--count", "--merges", `${mainStart}..HEAD`), "0", "without a merge commit");
    await eventually(async () => (await settings()).defaultPullMode, "ff_only", "the chosen mode is saved as the default (settings_get)");
    await eventually(() => toolHint("Pull"), (hint) => hint.includes("fast-forward only"), "the pull button's tooltip names the new default");
    await t.closeToasts();
    await page.getByRole("button", { name: PULL_OPTIONS }).click();
    await menu().waitFor();
    equal((await menuEntries()).filter((item) => item.current).map((item) => item.text), ["Pull (fast-forward only)"], "the menu now marks \"fast-forward only\"");
    await page.keyboard.press("Escape");
  });

  await section("Pull: fast-forward only fails clearly when own commits are in the way", async () => {
    const local = localCommit("notizen/lokal-1.md", "Lokale Notiz 1");
    const remoteSha = repo.commitOnRemote({ message: "Station Nord: Sensor getauscht", file: "docs/nord.md" });
    await t.refresh(repoId);
    await t.toolButton("Pull").click(); // the button uses the saved default: fast-forward only
    const failed = await waitToast(/Pull failed/, "danger", 60_000);
    check(/fast-forward/i.test(failed?.text ?? ""), `the toast explains that no fast-forward is possible: ${failed?.text}`);
    equal(head(), local, "HEAD is unchanged");
    equal(repo.git("rev-parse", "origin/main"), remoteSha, "the remote state was fetched anyway");
    check(!fs.existsSync(path.join(repo.path, ".git", "MERGE_HEAD")), "no half-done merge is left behind");
    await shot("mustfix-sync-ff-only-failed");
    await t.closeToasts();
  });

  await section("Pull: rebase from the split menu becomes the default", async () => {
    const remoteSha = repo.git("rev-parse", "origin/main");
    await pickPullMode("Pull (rebase)");
    await waitToast(/Pull/, "success", 60_000);
    equal(repo.git("rev-parse", "HEAD~1"), remoteSha, "the own commit now sits on the remote state (git rev-parse HEAD~1)");
    equal(repo.git("log", "-1", "--format=%s"), "Lokale Notiz 1", "it is the same commit, rebased");
    equal(repo.git("rev-list", "--count", "--merges", `${mainStart}..HEAD`), "0", "without a merge commit");
    await eventually(async () => (await settings()).defaultPullMode, "rebase", "rebase is saved as the default");
    await eventually(() => t.toolState("Push").then((state) => state.label), "Push, 1 commit to push", "afterwards: 1 commit ahead");
    await t.closeToasts();
  });

  await section("Pull: fast-forward if possible – otherwise a merge commit", async () => {
    const local = localCommit("notizen/lokal-2.md", "Lokale Notiz 2");
    const remoteSha = repo.commitOnRemote({ message: "Station Süd: Dach erneuert", file: "docs/sued.md" });
    await t.refresh(repoId);
    await pickPullMode("Pull (fast-forward if possible)");
    await waitToast(/Pull/, "success", 60_000);
    const parents = repo.git("rev-list", "--parents", "-n", "1", "HEAD").split(" ").slice(1);
    equal(parents.length, 2, "a merge commit was created (two parents)");
    check(parents.includes(local) && parents.includes(remoteSha), "its parents are the local commit and the remote state");
    await eventually(async () => (await settings()).defaultPullMode, "ff", "the default is \"fast-forward if possible\" again");
    await noErrorToast("no error");
    await t.closeToasts();
    // Clean up: push everything so that local and remote are in sync again.
    await t.toolButton("Push").click();
    await waitToast(/Pushed to origin\/main/, "success", 60_000);
    await t.closeToasts();
  });

  await section("Pull mode per repository: an own default applies only there, the split menu changes it", async () => {
    const repoSettings = () => app.invoke("repo_settings_get", { repoId });
    equal((await settings()).defaultPullMode, "ff", "globally \"fast-forward if possible\" applies");
    equal((await repoSettings()).defaultPullMode, null, "the repository has no own default yet");

    // Settings → this repository → pull mode: rebase – with the keyboard in the select.
    await blur();
    await page.keyboard.press("Control+Comma");
    const prefs = page.locator('[data-screen="settings"]');
    await prefs.waitFor();
    await prefs.getByRole("tab", { name: "Pull and fetch" }).click();
    // Without an own value the row shows what it inherits from the profile; only "Override" brings the select.
    await prefs.getByRole("button", { name: "Pull mode: override" }).click();
    const combo = prefs.locator('[data-setting="Pull mode"]').getByRole("combobox");
    await combo.waitFor();
    check(/Fast-forwards if possible; otherwise a merge commit is created/.test(await prefs.locator('[data-setting="Pull mode"]').innerText()), "after overriding, the row describes the inherited mode (fast-forward if possible)");
    await combo.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("listbox").waitFor();
    for (let step = 0; step < 6; step++) {
      if ((await page.evaluate(() => document.activeElement?.textContent?.trim())) === "Rebase") break;
      await page.keyboard.press("ArrowDown");
      await sleep(60);
    }
    await page.keyboard.press("Enter");
    await eventually(async () => (await repoSettings()).defaultPullMode, "rebase", "the repository's default is rebase (repo_settings_get)");
    equal((await settings()).defaultPullMode, "ff", "the global default stays as it was (settings_get)");
    await shot("mustfix-sync-pull-repo-setting");
    await page.keyboard.press("Escape");
    await prefs.waitFor({ state: "detached" });
    await blur();

    // The toolbar follows: tooltip and check mark in the menu.
    await eventually(() => toolHint("Pull"), (hint) => hint.includes("Pull (rebase)"), "the pull button names this repository's mode");
    await page.getByRole("button", { name: PULL_OPTIONS }).click();
    await menu().waitFor();
    equal((await menuEntries()).filter((item) => item.current).map((item) => item.text), ["Pull (rebase)"], "the menu marks rebase");
    await page.keyboard.press("Escape");

    // Another repository keeps the global default.
    const other = await app.openRepo(offline.path);
    await eventually(() => toolHint("Pull"), (hint) => hint.includes("fast-forward if possible"), "another repository still follows the global default");
    await app.invoke("tab_close", { tabId: other.tabId });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "tabs"] }));
    await page.getByRole("tab", { name: /^messnetz/, selected: true }).waitFor();
    await app.settle();

    // The pull button pulls with rebase: the own commit then sits on the remote state, no merge commit.
    const startSha = head();
    localCommit("notizen/lokal-3.md", "Lokale Notiz 3");
    const remoteSha = repo.commitOnRemote({ message: "Station West: neu im Netz", file: "docs/west.md" });
    await t.refresh(repoId);
    await t.toolButton("Pull").click();
    await waitToast(/Pull/, "success", 60_000);
    equal(repo.git("rev-parse", "HEAD~1"), remoteSha, "the own commit sits on the remote state (git rev-parse HEAD~1)");
    equal(repo.git("rev-list", "--count", "--merges", `${startSha}..HEAD`), "0", "without a merge commit – it was a rebase");
    await t.closeToasts();

    // The choice in the split menu changes THIS repository's default, not the global one.
    await pickPullMode("Pull (fast-forward only)");
    await eventually(async () => (await repoSettings()).defaultPullMode, "ff_only", "the choice in the menu ends up in the repository's settings");
    equal((await settings()).defaultPullMode, "ff", "globally it stays \"fast-forward if possible\"");
    await eventually(() => toolHint("Pull"), (hint) => hint.includes("fast-forward only"), "the tooltip follows");
    await eventually(() => page.locator("[data-toast]").count(), (count) => count > 0, "the pull reports back");
    await t.closeToasts();

    // "As global" removes the own default.
    await app.invoke("repo_settings_set", { repoId, patch: { defaultPullMode: null } });
    await page.evaluate((id) => window.__gc.queryClient.invalidateQueries({ queryKey: ["repo", id, "repoSettings"] }), repoId);
    await eventually(() => toolHint("Pull"), (hint) => hint.includes("fast-forward if possible"), "without an own default the global one applies again");
    await t.toolButton("Push").click();
    await waitToast(/Pushed to origin\/main/, "success", 60_000);
    await t.closeToasts();
  });

  await section("Fetch all remotes: one is unreachable, the others are fetched", async () => {
    const mirror = ws.at("spiegel.git");
    ws.git(ws.root, "clone", "-q", "--bare", repo.remotePath, mirror);
    ws.git(mirror, "branch", "nur-im-spiegel", "main");
    repo.git("remote", "add", "abseits", `http://127.0.0.1:${closedPort}/nichts.git`);
    repo.git("remote", "add", "spiegel", mirror);
    const remoteSha = repo.commitOnRemote({ message: "Nachtrag vor dem Fetch aller Remotes", file: "docs/nachtrag.md" });
    await page.evaluate((id) => window.__gc.queryClient.invalidateQueries({ queryKey: ["repo", id, "remotes"] }), repoId);
    await t.refresh(repoId);
    await eventually(() => page.evaluate((id) => window.__gc.queryClient.getQueryData(["repo", id, "remotes"])?.length ?? 0, repoId), 3, "the app knows three remotes");
    await t.toolButton("Fetch").click();
    const partial = await waitToast(/Fetch from “abseits” failed/, "warning", 90_000);
    check(/abseits: .*can’t be reached/.test(partial?.text ?? ""), `the toast names the remote and the reason: ${partial?.text}`);
    check(/The other 2 remotes were fetched/.test(partial?.text ?? ""), "and says that the others were fetched");
    equal(repo.git("rev-parse", "origin/main"), remoteSha, "origin was fetched (git rev-parse origin/main)");
    equal(repo.git("rev-parse", "spiegel/nur-im-spiegel"), ws.git(mirror, "rev-parse", "nur-im-spiegel"), "spiegel was fetched (git rev-parse spiegel/nur-im-spiegel)");
    await eventually(() => t.toolState("Pull").then((state) => state.label), "Pull, 1 commit to pull", "the toolbar shows ↓1");
    await shot("mustfix-sync-fetch-partial");
    await app.setTheme("light");
    await shot("mustfix-sync-fetch-partial-light");
    await app.setTheme("dark");
    await app.setSize(960, 600);
    await shot("mustfix-sync-fetch-partial-min");
    equal(await t.overflow(), { x: 0, y: 0 }, "960×600: no overflow");
    await app.setSize(1440, 900);
    await t.closeToasts();
    repo.git("remote", "remove", "abseits");
    repo.git("remote", "remove", "spiegel");
    repo.git("merge", "-q", "--ff-only", "origin/main");
    await page.evaluate((id) => window.__gc.queryClient.invalidateQueries({ queryKey: ["repo", id, "remotes"] }), repoId);
    await t.refresh(repoId);
  });

  await section("Auto-fetch: interval 1 minute, ↓1 on its own; quiet without network and without credentials", async () => {
    // Two more repositories in tabs: one with an unreachable remote, one whose server requires sign-in.
    offline.git("remote", "set-url", "origin", `http://127.0.0.1:${closedPort}/funkloch.git`);
    locked.git("remote", "set-url", "origin", server.url("tresor.git"));
    const off = await app.openRepo(offline.path);
    const lock = await app.openRepo(locked.path);
    await app.invoke("tab_activate", { tabId });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "tabs"] }));
    await page.getByRole("tab", { name: /^messnetz/, selected: true }).waitFor();
    await app.settle();

    // Set the interval in the settings to 1 minute with the keyboard.
    await blur();
    await page.keyboard.press("Control+Comma");
    const prefs = page.locator('[data-screen="settings"]');
    await prefs.waitFor();
    const interval = prefs.getByRole("spinbutton", { name: "Auto-fetch" });
    await interval.waitFor();
    equal(await interval.inputValue(), "0", "the interval is 0 (off)");
    await interval.focus();
    await page.keyboard.press("ArrowUp");
    await eventually(async () => (await settings()).autoFetchMinutes, 1, "arrow up sets 1 minute (settings_get)");
    await shot("mustfix-sync-autofetch-setting");
    await t.closeToasts();
    await page.keyboard.press("Escape");
    await prefs.waitFor({ state: "detached" });
    await blur();
    await page.mouse.move(700, 500);

    // Someone else pushes; from here on the test no longer touches the app.
    const remoteSha = repo.commitOnRemote({ message: "Während du Kaffee holst", file: "docs/kaffee.md" });
    const requestsBefore = await page.evaluate(() => window.__mfRequests);
    await forgetToasts();
    equal((await t.toolState("Pull")).label, null, "before: nothing to pull");
    const started = Date.now();
    await eventually(() => t.toolState("Pull").then((state) => state.label), "Pull, 1 commit to pull", "the toolbar shows \"1 commit to pull\" on its own", 100_000);
    const elapsed = Math.round((Date.now() - started) / 1000);
    console.log(`  auto-fetch after ${elapsed} s`);
    check(elapsed <= 80, `within about 70 seconds (was ${elapsed} s)`);
    equal(repo.git("rev-parse", "origin/main"), remoteSha, "origin/main is current (git rev-parse)");
    equal(head() !== remoteSha, true, "nothing was changed locally (HEAD is still before it)");
    await eventually(() => page.locator("footer").getByLabel("1 commit behind").count(), 1, "the status bar shows ↓1");
    await eventually(async () => (await graphRow("Während du Kaffee holst").count()) > 0, true, "the graph shows the new commit from origin/main");
    await shot("mustfix-sync-autofetch");

    // The two others: their auto-fetch fails – it shows up in the activity log, nowhere else.
    const logOf = async (id) => (await app.invoke("activity_list", { scope: "repo", repoId: id, cursor: null, limit: 50 })).entries ?? [];
    const autoEntry = async (id) => (await logOf(id)).find((entry) => /Auto-fetch/.test(entry.output) || /Auto-fetch/.test(entry.description ?? "")) ?? null;
    await eventually(async () => (await autoEntry(off.repoId))?.output.split("\n")[0] ?? null, (line) => /^Auto-fetch failed: The server can’t be reached/.test(line ?? ""), "without network: entry in the activity log", 60_000);
    await eventually(async () => (await autoEntry(lock.repoId))?.output.split("\n")[0] ?? null, (line) => /^Auto-fetch failed: Signing in to the server failed/.test(line ?? ""), "without credentials: entry in the activity log", 60_000);
    equal(await page.evaluate(() => window.__mfRequests), requestsBefore, "auto-fetch never asked for credentials");
    equal(await t.dialogTitle(), null, "no dialog opened");
    equal(await seenToasts(), [], "not a single toast appeared the whole time (notification on fetch results is off, missing network and missing sign-in stay quiet)");
    check(server.requests.some((entry) => entry.status === 401), "the server with sign-in was asked and refused (401)");
    equal(app.consoleErrors, [], "console errors");

    // When fetching by hand, the app does ask in the same repository.
    await app.invoke("settings_set", { patch: { autoFetchMinutes: 0 } });
    await app.invoke("tab_activate", { tabId: lock.tabId });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "tabs"] }));
    await page.getByRole("tab", { name: /^tresor/, selected: true }).waitFor();
    await app.settle();
    await t.toolButton("Fetch").click();
    await waitDialog(/^Username for the remote$/, 60_000);
    await page.keyboard.press("Escape");
    await eventually(() => page.locator('footer [role="progressbar"]').count(), 0, "cancel ends the fetch");
  });
} catch (error) {
  t.check(false, `aborted: ${error?.stack ?? error}`);
} finally {
  if (app) {
    await app.invoke("credentials_forget_all").catch(() => undefined);
    await app.close();
  }
  await server.close();
  repo.cleanup();
  offline.cleanup();
  locked.cleanup();
  ws.cleanup();
}
t.finish();
