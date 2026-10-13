/**
 * F10 – Undo the last action (undo/redo): the cases no other script covered yet.
 * In the real app, against real Git repositories; checked with git (HEAD, refs, stash list, file contents).
 *
 *   node scripts/e2e/flows/C-F10.mjs                 everything
 *   node scripts/e2e/flows/C-F10.mjs --only F10-E2   only sections whose title or case ID contains the text
 *   node scripts/e2e/flows/C-F10.mjs --show          visible window
 *
 * Already covered elsewhere: Ctrl+Z / Ctrl+Y after a commit with the keyboard only
 * (screens/keyboard.mjs), undo after deleting a branch, discard, hard reset (screens/interaction.mjs),
 * fast-forward (screens/mustfix-sync.mjs), remove remote (screens/remote-dialog.mjs), empty state with reason.
 */
import { makeCleanRepoWithRemote } from "../fixtures.mjs";
import { branches, commit, createFlow, currentBranch, exists, gitRaw, head, lines, make, porcelain, readFile, remoteGit, sleep, stashList } from "./C-lib.mjs";

const t = createFlow("C-F10");
const { check, equal, eventually, section } = t;

try {
  const app = await t.launch();
  const { page } = app;
  let repo = await t.open(t.made(make(() => makeCleanRepoWithRemote({ name: "zurueck" }))));

  const undoState = () => t.toolState("Undo");
  const redoState = () => t.toolState("Redo");
  const undoHint = () => t.toolHint("Undo");
  const redoHint = () => t.toolHint("Redo");
  /** What the app knows as the next undo/redo step (from its cache, without reloading). */
  const peek = (target = repo) => t.cached(target.repoId, "undo");
  /** Commit through the UI (only this creates an undo entry): write the file, enter the message, stage everything and commit. */
  const appCommit = async (file, content, summary, description = null, target = repo) => {
    target.write(file, content);
    await t.refresh(target.repoId);
    await page.evaluate((tabId) => window.__gc.store.getState().selectWip(tabId), target.tabId);
    await page.locator("[data-commit-summary]").fill(summary);
    if (description !== null) await page.getByRole("textbox", { name: "Description" }).fill(description);
    await page.locator("[data-commit-summary]").focus();
    await page.keyboard.press("Control+Shift+Enter");
    await eventually(() => gitRaw(target, ["log", "-1", "--format=%s"]), summary.split("\n")[0], `commit “${summary.slice(0, 40)}” created through the app`, 25_000);
    await t.waitToast(/Commit created/, "success");
    await t.closeToasts();
    await app.settle();
    await t.blur();
    return head(target);
  };
  const pressUndo = async () => {
    await t.blur();
    await page.keyboard.press("Control+z");
  };
  const pressRedo = async () => {
    await t.blur();
    await page.keyboard.press("Control+y");
  };
  /** Fresh repository for the next section (so the undo entries of the old one no longer interfere). */
  const freshRepo = async (name) => {
    repo = await t.open(t.made(make(() => makeCleanRepoWithRemote({ name }))));
    return repo;
  };

  // ---------------------------------------------------------------------------------------------
  await section(["F10-H1", "F10-E13"], "Toolbar with the mouse: undo and redo a commit with umlauts, emoji and 500 characters – message and SHA unchanged", async () => {
    equal((await undoState()).disabled, true, "initial state: Undo is disabled");
    check(/Nothing to undo/.test(await undoHint()), "… with a reason");
    const summary = `Größen prüfen 🌧️ – ${"sehr ausführliche Zusammenfassung der Änderung ".repeat(11)}`.slice(0, 500).trim();
    const body = "Zeile mit Umlauten: äöüß ÄÖÜ.\n\nZweiter Absatz mit Emoji 🌧️🌡️ und „Anführungszeichen“.\n- Punkt eins\n- Punkt zwei";
    check(summary.length >= 495, `the summary has ${summary.length} characters`);
    const parent = head(repo);
    const sha = await appCommit("größen.txt", "Körpergröße 🌡️\n", summary, body);
    const message = gitRaw(repo, ["log", "-1", "--format=%B"]);
    equal(message.trim(), `${summary}\n\n${body}`, "git: the message is complete and unaltered in the commit");
    await eventually(async () => (await undoState()).disabled, false, "Undo is enabled");
    const hint = await undoHint();
    check(/Größen prüfen 🌧️/.test(hint), `the hint on “Undo” names the commit: ${hint.slice(0, 120)}`);
    check(hint.length <= 200, `… shortened, not with all 500 characters (${hint.length} characters)`);
    await t.toolButton("Undo").hover();
    const tip = page.getByRole("tooltip").first();
    await tip.waitFor({ timeout: 5000 });
    check(await t.inViewport(tip), "the tooltip with the long text stays inside the window");
    await t.toolButton("Undo").click();
    await t.waitToast(/Undone/, "success");
    await eventually(() => head(repo), parent, "git: HEAD is back on the commit before");
    equal(readFile(repo, "größen.txt"), "Körpergröße 🌡️\n", "the change of the commit is back in the working directory – nothing is lost");
    equal((await t.toasts()).some((toast) => toast.tone === "danger"), false, "no error message");
    const toastBox = await page.locator('[data-toast="success"]').first().boundingBox();
    check(toastBox && toastBox.width <= 360 && toastBox.height <= 240, `the message stays small despite the long commit message (${Math.round(toastBox?.width ?? 0)}×${Math.round(toastBox?.height ?? 0)} px)`);
    await t.closeToasts();
    await eventually(async () => (await redoState()).disabled, false, "Redo is enabled");
    check(/Redo: /.test(await redoHint()), `the hint on “Redo” names the action: ${(await redoHint()).slice(0, 100)}`);
    await t.toolButton("Redo").click();
    await t.waitToast(/Redone/, "success");
    await eventually(() => head(repo), sha, "git: Redo restores the same commit (same SHA)");
    equal(gitRaw(repo, ["log", "-1", "--format=%B"]), message, "git: the message is byte for byte the same");
    equal(porcelain(repo), [], "git: working directory clean");
    equal(await t.overflow(), { x: 0, y: 0 }, "no page overflow");
    await t.closeToasts();
  });

  // ---------------------------------------------------------------------------------------------
  // BUG C-07: after the push, “Undo” only says “Nothing to undo”. Nowhere does it say that the commit is already
  // on the remote (and that revert would be the way) – the app has the text for this, but it never appears.
  await section(["F10-E2"], "Already pushed: a commit that is already on the remote cannot be undone locally – and the app says it is because of the push", async () => {
    await freshRepo("gepusht");
    const sha = await appCommit("gepusht.txt", "x\n", "Commit, der gleich gepusht wird");
    await eventually(async () => (await undoState()).disabled, false, "before the push: Undo is enabled");
    await t.toolButton("Push").click();
    await t.waitToast(/Pushed to origin\/main/, "success", 60_000);
    equal(remoteGit(repo, "rev-parse", "refs/heads/main"), sha, "git (bare): the commit is on the remote");
    await t.closeToasts();
    await app.settle();
    const state = await t.until(undoState, (value) => value.disabled === true, 10_000);
    const hint = await undoHint();
    console.log(`    after the push: Undo ${state.actual.disabled ? "disabled" : "enabled"}, hint: “${hint}”`);
    await pressUndo();
    await sleep(2500);
    const shown = await t.toasts();
    equal(head(repo), sha, "git: Ctrl+Z does NOT undo the pushed commit");
    equal(remoteGit(repo, "rev-parse", "refs/heads/main"), sha, "git (bare): the remote is untouched");
    equal(porcelain(repo), [], "git: working directory unchanged");
    equal(shown.filter((toast) => toast.tone === "danger"), [], "no raw error message");
    if (state.actual.disabled) {
      check(hint.length > 10, `the disabled button gives a reason: “${hint}”`);
      await t.shot("target/e2e/bugs/C-07.png");
      check(/pushed|remote|revert/i.test(`${hint} ${shown.map((toast) => toast.text).join(" ")}`), `button or message say THAT it is because of the push (otherwise Undo just looks broken): hint “${hint}”, messages ${JSON.stringify(shown)}`);
    } else {
      check(shown.some((toast) => /remote|pushed|revert/i.test(toast.text)), `the message explains that the commit is already on the remote: ${JSON.stringify(shown)}`);
    }
    await t.closeToasts();
  }, { bug: "C-07" });

  // ---------------------------------------------------------------------------------------------
  await section(["F10-E1"], "Irreversible action: after “Create tag” and “Delete tag”, Undo offers nothing wrong", async () => {
    await freshRepo("nicht-umkehrbar");
    await t.runCommand("tag.create");
    const create = await t.waitDialog(/^Create tag$/);
    await create.getByLabel("Name").fill("v-test");
    await create.getByLabel("Name").press("Enter");
    await t.waitToast(/Tag “v-test” created/, "success");
    await t.closeToasts();
    await app.settle();
    equal((await undoState()).disabled, true, "after “Create tag” (irreversible) Undo stays disabled");
    check(/Nothing to undo/.test(await undoHint()), `… with a reason: ${await undoHint()}`);
    await pressUndo();
    const nothing = await t.maybeToast(/Nothing to undo/, null, 4000);
    equal(lines(gitRaw(repo, ["tag", "-l"])), ["v-test"], "git: Ctrl+Z changes nothing about the tag");
    void nothing;
    await t.closeToasts();
    // A reversible action, then an irreversible one: the hint still names what would really be undone.
    const parent = head(repo);
    await appCommit("vor-dem-tag.txt", "x\n", "Commit vor dem Aufräumen");
    await t.runCommand("tag.delete");
    const seen = await t.until(t.dialogTitle, (title) => title !== null, 10_000);
    if (/select|choose|Delete tag …|Which/.test(seen.actual ?? "") || (await page.getByRole("dialog").getByRole("option").count()) > 0) {
      await page.keyboard.type("v-test");
      await page.keyboard.press("Enter");
    }
    const confirm = await t.waitDialog(/^Delete tag “v-test”\?$/);
    check(/Undo does not restore the tag/.test(await confirm.innerText()), "the dialog says beforehand that Undo does not bring the tag back");
    await confirm.getByRole("button", { name: "Delete tag" }).click();
    await eventually(() => gitRaw(repo, ["tag", "-l"]), "", "git: the tag is deleted");
    await t.closeToasts();
    await app.settle();
    const hint = await undoHint();
    check(!/\btag\b/i.test(hint), `the hint on “Undo” does not promise to bring the tag back: “${hint}”`);
    check(/Commit vor dem Aufräumen/.test(hint), `it names the action that is really undone (the commit): “${hint}”`);
    await pressUndo();
    await t.waitToast(/Undone/, "success");
    await eventually(() => head(repo), parent, "git: the commit was undone");
    equal(gitRaw(repo, ["tag", "-l"]), "", "git: the tag stays deleted (as announced)");
    await t.closeToasts();
  });

  // ---------------------------------------------------------------------------------------------
  await section(["F10-E3"], "Changed from outside: after a commit in the terminal, Undo undoes nothing wrong", async () => {
    await freshRepo("aussen");
    const first = await appCommit("eins.txt", "eins\n", "Commit aus der App");
    await eventually(async () => (await undoState()).disabled, false, "Undo is enabled");
    const outside = commit(repo, "zwei.txt", "zwei\n", "Commit aus dem Terminal");
    // The app catches up on its own: the hint must no longer offer the old step as “works right away”.
    await eventually(() => peek().then((state) => state?.undo?.label ?? null), (label) => label === null || !/Commit aus der App/.test(label), "the app notices on its own that its last step no longer fits", 25_000);
    await pressUndo();
    await sleep(2500);
    equal(head(repo), outside, "git: Ctrl+Z does NOT undo the commit from the terminal");
    check(exists(repo, "zwei.txt") && exists(repo, "eins.txt"), "both files are there");
    equal(gitRaw(repo, ["rev-parse", "HEAD~1"]), first, "git: the history is unchanged");
    equal((await t.toasts()).filter((toast) => toast.tone === "danger"), [], "no raw error message");
    const shown = await t.toasts();
    check(shown.length === 0 || shown.some((toast) => /Nothing to undo|no longer|does not fit/.test(toast.text)), `if the app reports something, it is understandable: ${JSON.stringify(shown)}`);
    await t.closeToasts();
  });

  // ---------------------------------------------------------------------------------------------
  // BUG C-08: “Stash and undo” creates the stash – and then undoes exactly this stash
  // (it is now the last reversible action). The checkout stays, yet the message says “Undone”.
  await section(["F10-E4"], "Uncommitted changes in the way: undoing a checkout overwrites nothing – “Stash and undo” then really undoes the checkout", async () => {
    await freshRepo("im-weg");
    await t.leftRow("refs/heads/feature/export").dblclick();
    await eventually(() => currentBranch(repo), "feature/export", "checkout through the app");
    await t.waitToast(/“feature\/export” checked out/, "success");
    await t.closeToasts();
    await app.settle();
    // src/export.py only exists on feature/export; an uncommitted change to it blocks the way back.
    const changed = `${readFile(repo, "src/export.py")}\n# lokal weitergeschrieben\n`;
    repo.write("src/export.py", changed);
    await t.refresh(repo.repoId);
    check(/checkout|feature\/export|main/i.test(await undoHint()), `the hint names the checkout: ${await undoHint()}`);
    await pressUndo();
    const blocked = await t.waitToast(/Clean up first, then undo/, "warning", 20_000);
    check(/uncommitted changes/.test(blocked?.text ?? ""), `the message explains what is in the way: ${blocked?.text}`);
    equal(currentBranch(repo), "feature/export", "git: nothing has happened yet");
    equal(readFile(repo, "src/export.py"), changed, "the local change is intact");
    await page.locator("[data-toast]").getByRole("button", { name: "Stash and undo" }).click();
    const done = await t.maybeToast(/Undone/, "success", 20_000);
    await sleep(1500);
    await t.shot("target/e2e/bugs/C-08.png");
    const inStash = stashList(repo).length === 1 && (gitRaw(repo, ["stash", "show", "-p", "stash@{0}"], { allowFail: true }) ?? "").includes("lokal weitergeschrieben");
    check(inStash || readFile(repo, "src/export.py") === changed, "the local change is not lost (in the stash or in the working directory)");
    equal(currentBranch(repo), "main", `after “Stash and undo”, main is checked out again (app message: ${done?.text ?? "none"})`);
    equal(stashList(repo).length, 1, "git: the change is in exactly one stash");
    check(inStash, "git: the stash contains the local change");
    await t.closeToasts();
  }, { bug: "C-08" });

  // ---------------------------------------------------------------------------------------------
  await section(["F10-E5"], "Double Ctrl+Z: two quick key presses undo one after the other – nothing is lost, Ctrl+Y brings everything back", async () => {
    await freshRepo("doppelt");
    const base = head(repo);
    const first = await appCommit("a.txt", "a\n", "Erster Commit");
    const second = await appCommit("b.txt", "b\n", "Zweiter Commit");
    await eventually(async () => (await undoState()).disabled, false, "Undo is enabled");
    await t.blur();
    await Promise.all([page.keyboard.press("Control+z"), page.keyboard.press("Control+z")]);
    await sleep(3500);
    await app.settle();
    const now = head(repo);
    check([first, base].includes(now), `git: after two quick Ctrl+Z, HEAD is on the first commit or the base (is ${now.slice(0, 7)})`);
    check(exists(repo, "a.txt") && exists(repo, "b.txt"), "both files are still there – as a commit or in the working directory");
    equal((await t.toasts()).filter((toast) => toast.tone === "danger"), [], "no error message");
    const undone = now === base ? 2 : 1;
    console.log(`    two quick Ctrl+Z undid ${undone} step(s)`);
    await t.closeToasts();
    for (let step = 0; step < undone; step++) {
      await eventually(async () => (await redoState()).disabled, false, "Redo is enabled");
      await pressRedo();
      await t.waitToast(/Redone/, "success");
      await t.closeToasts();
      await app.settle();
    }
    equal(head(repo), second, "git: Ctrl+Y restores the last commit (same SHA)");
    equal(porcelain(repo), [], "git: working directory clean");
  });

  // ---------------------------------------------------------------------------------------------
  await section(["F10-E11"], "Redo expires: after Undo and a new action, “Redo” is disabled", async () => {
    await freshRepo("verfaellt");
    const base = head(repo);
    await appCommit("alt.txt", "alt\n", "Wird zurückgenommen");
    await pressUndo();
    await t.waitToast(/Undone/, "success");
    await eventually(() => head(repo), base, "git: undone");
    await t.closeToasts();
    await eventually(async () => (await redoState()).disabled, false, "Redo is enabled");
    const newer = await appCommit("neu.txt", "neu\n", "Neue Aktion statt Wiederholen");
    await eventually(async () => (await redoState()).disabled, true, "after the new action Redo is disabled");
    check(/Nothing to redo/.test(await redoHint()), `… with a reason: ${await redoHint()}`);
    await pressRedo();
    await sleep(1500);
    equal(head(repo), newer, "git: Ctrl+Y changes nothing");
    equal((await t.toasts()).filter((toast) => toast.tone === "danger"), [], "no error message");
    await t.closeToasts();
  });

  // ---------------------------------------------------------------------------------------------
  await section(["F10-E14"], "Undo across action types: checkout, stash and pop – each back and forward again", async () => {
    await freshRepo("arten");
    // Checkout
    await t.leftRow("refs/heads/feature/export").dblclick();
    await eventually(() => currentBranch(repo), "feature/export", "checkout through the app");
    await t.closeToasts();
    await app.settle();
    await pressUndo();
    await eventually(() => currentBranch(repo), "main", "Undo: main again");
    await t.closeToasts();
    await app.settle();
    await pressRedo();
    await eventually(() => currentBranch(repo), "feature/export", "Redo: feature/export again");
    await t.closeToasts();
    gitRaw(repo, ["checkout", "-q", "main"]);
    // Stash
    repo.write("README.md", `${readFile(repo, "README.md")}\nFür den Stash.\n`);
    repo.write("neu.txt", "nicht verfolgt\n");
    await t.refresh(repo.repoId);
    await t.toolButton("Stash").click();
    await t.waitToast(/Changes stashed/, "success");
    equal(porcelain(repo), [], "git: stashed, clean");
    await t.closeToasts();
    await app.settle();
    check(/stash/i.test(await undoHint()), `the hint names the stash: ${await undoHint()}`);
    await pressUndo();
    await t.waitToast(/Undone/, "success");
    await eventually(() => stashList(repo), [], "Undo: the stash is gone again");
    equal(porcelain(repo), [" M README.md", "?? neu.txt"], "… and the changes are back in the working directory, including the untracked file");
    await t.closeToasts();
    await app.settle();
    await pressRedo();
    await t.waitToast(/Redone/, "success");
    await eventually(() => stashList(repo).length, 1, "Redo: the stash is back");
    equal(porcelain(repo), [], "… and the working directory clean");
    await t.closeToasts();
    await app.settle();
    // Pop
    await t.toolButton("Pop").click();
    await t.waitToast(/Stash pop complete/, "success");
    equal(stashList(repo), [], "git: pop removed the stash");
    await t.closeToasts();
    await app.settle();
    await pressUndo();
    await t.waitToast(/Undone/, "success");
    await eventually(() => stashList(repo).length, 1, "Undo after pop: the stash is back");
    equal(porcelain(repo), [], "… and the working directory clean again");
    check(gitRaw(repo, ["stash", "show", "--name-only", "--include-untracked", "stash@{0}"]).includes("neu.txt"), "git: the restored stash also contains the untracked file");
    await t.closeToasts();
  });

  // ---------------------------------------------------------------------------------------------
  await section(["F10-E8"], "Operation in progress: in the middle of a merge with a conflict Undo is disabled; Ctrl+Z changes nothing", async () => {
    await freshRepo("mittendrin");
    const sha = await appCommit("stationen.csv", "kürzel;name;höhe_m\nN;Schule Nord (main);41\n", "Stationen auf main geändert");
    gitRaw(repo, ["checkout", "-q", "-b", "thema/konflikt", "HEAD~1"]);
    commit(repo, "stationen.csv", "kürzel;name;höhe_m\nN;Schule Nord (Thema);41\n", "Stationen im Thema geändert");
    gitRaw(repo, ["checkout", "-q", "main"]);
    gitRaw(repo, ["merge", "thema/konflikt"], { allowFail: true });
    check(porcelain(repo).includes("UU stationen.csv"), "git: the merge has a conflict");
    await t.refresh(repo.repoId);
    await eventually(t.footer, (text) => /Merge in progress/.test(text), "the app shows the running merge");
    await eventually(async () => (await undoState()).disabled, true, "Undo is disabled during the merge");
    check((await undoHint()).length > 10, `… with a reason: ${await undoHint()}`);
    await pressUndo();
    await sleep(2000);
    equal(head(repo), sha, "git: HEAD unchanged");
    check(porcelain(repo).includes("UU stationen.csv"), "git: the conflict is still there unchanged");
    equal((await t.toasts()).filter((toast) => toast.tone === "danger"), [], "no raw error message");
    await t.closeToasts();
    gitRaw(repo, ["merge", "--abort"]);
  });

  // ---------------------------------------------------------------------------------------------
  await section(["F10-N1"], "Ref deleted and recreated from outside: Undo does not overwrite the new branch", async () => {
    await freshRepo("ref-weg");
    gitRaw(repo, ["branch", "thema/alt", "main~1"]);
    await t.refresh(repo.repoId);
    const oldSha = gitRaw(repo, ["rev-parse", "thema/alt"]);
    await t.rightClickPick(t.leftRow("refs/heads/thema/alt"), /^Delete .+ …$/);
    const confirm = await t.waitDialog(/^Delete .*\?$/);
    await confirm.getByRole("button", { name: /^Delete (branch|anyway)$/ }).click();
    await eventually(() => branches(repo).includes("thema/alt"), false, "branch deleted through the app");
    await t.closeToasts();
    await app.settle();
    await eventually(undoHint, (hint) => /thema\/alt/.test(hint), "the hint on “Undo” names the deleted branch");
    // From outside, a branch with the same name appears at a different place.
    gitRaw(repo, ["branch", "thema/alt", "main"]);
    const newSha = gitRaw(repo, ["rev-parse", "thema/alt"]);
    check(newSha !== oldSha, "the new branch points somewhere else");
    await eventually(() => peek().then((state) => state?.undo?.label ?? null), (label) => label === null || !/thema\/alt/.test(label), "the app notices on its own that the step no longer fits", 25_000);
    await pressUndo();
    await sleep(2500);
    equal(gitRaw(repo, ["rev-parse", "thema/alt"]), newSha, "git: the branch created from outside still points to ITS commit – Undo did not overwrite it");
    equal((await t.toasts()).filter((toast) => toast.tone === "danger"), [], "no raw error message");
    await t.closeToasts();
  });

  // ---------------------------------------------------------------------------------------------
  await section(["F10-H3", "F10-E10"], "Keyboard and screen reader only: Undo via focus and Enter; state and reason as text; axe without violations", async () => {
    await freshRepo("vorlesen");
    equal(await t.toolButton("Undo").getAttribute("aria-disabled"), "true", "empty: aria-disabled (the button stays focusable and can read out its reason)");
    check(/Nothing to undo/.test(await undoHint()), "the reason is attached to the button as a description (aria-describedby)");
    const parent = head(repo);
    const sha = await appCommit("vorlesen.txt", "x\n", "Commit für den Screenreader");
    await eventually(() => t.toolButton("Undo").getAttribute("aria-disabled"), null, "after the commit the button is no longer disabled");
    check(/^Undo: /.test(await undoHint()) && /Commit für den Screenreader/.test(await undoHint()), `the description names what is undone: ${await undoHint()}`);
    equal(await t.axe('[role="toolbar"][aria-label="Repository actions"]', { disable: ["color-contrast", "label-content-name-mismatch"] }), [], "axe: no violations in the toolbar");
    // Keyboard: into the toolbar, with arrow/Tab to the button, Enter.
    await page.evaluate(() => {
      window.__cLive = [];
      new MutationObserver(() => {
        for (const element of document.querySelectorAll('[aria-live]:not([aria-live="off"]), [role="status"], [role="alert"]')) {
          const text = (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
          if (text && !window.__cLive.includes(text)) window.__cLive.push(text);
        }
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    await t.toolButton("Undo").focus();
    // Back and forth with the keyboard so the focus counts as keyboard focus.
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await eventually(async () => (await t.focused()).text.startsWith("Undo"), true, "Tab reaches the “Undo” button");
    check((await t.focused()).visible, "the focus on “Undo” is visible");
    await page.keyboard.press("Enter");
    await t.waitToast(/Undone/, "success");
    await eventually(() => head(repo), parent, "Enter on the button undoes the commit");
    await eventually(async () => (await t.focused()).tag !== "BODY", true, "the focus is not lost afterwards");
    await eventually(() => page.evaluate(() => window.__cLive.some((text) => /Undone/.test(text))), true, "the message “Undone” goes through a live region (is read out)", 5000);
    await t.closeToasts();
    await t.toolButton("Redo").focus();
    await page.keyboard.press("Space");
    await t.waitToast(/Redone/, "success");
    await eventually(() => head(repo), sha, "Space on “Redo” restores it");
    await t.closeToasts();
  });

  // ---------------------------------------------------------------------------------------------
  await section(["F10-E9"], "Minimum window 960×600: Undo and Redo are visible and usable", async () => {
    await app.setSize(960, 600);
    try {
      for (const name of ["Undo", "Redo"]) check(await t.inViewport(t.toolButton(name)), `${name} is visible at 960 px`);
      const before = head(repo);
      await eventually(async () => (await undoState()).disabled, false, "Undo is enabled");
      await t.toolButton("Undo").hover();
      const tip = page.getByRole("tooltip").first();
      await tip.waitFor({ timeout: 5000 });
      check(await t.inViewport(tip), "the tooltip lies fully inside the window");
      await t.toolButton("Undo").click();
      const toast = await t.waitToast(/Undone/, "success");
      check(Boolean(toast) && head(repo) !== before, "Undo also works in the small window");
      check(await t.inViewport(page.locator("[data-toast]").first()), "the message lies fully inside the window");
      equal(await t.overflow(), { x: 0, y: 0 }, "no page overflow");
    } finally {
      await app.setSize(1440, 900);
    }
    await t.closeToasts();
  });

  // ---------------------------------------------------------------------------------------------
  await section(["F10-E7"], "Restart the app: the last step can still be undone afterwards", async () => {
    const dataDir = t.tempDataDir();
    const fresh = t.made(make(() => makeCleanRepoWithRemote({ name: "neustart-undo" })));
    const main = t.app;
    let first = null;
    let again = null;
    try {
      first = await t.launch({ dataDir });
      await t.open(fresh);
      const parent = head(fresh);
      fresh.write("vor-dem-neustart.txt", "x\n");
      await t.refresh(fresh.repoId);
      await first.page.locator("[data-commit-summary]").fill("Commit vor dem Neustart");
      await first.page.locator("[data-commit-summary]").focus();
      await first.page.keyboard.press("Control+Shift+Enter");
      await eventually(() => gitRaw(fresh, ["log", "-1", "--format=%s"]), "Commit vor dem Neustart", "commit through the app", 25_000);
      const sha = head(fresh);
      await first.settle();
      await first.close();

      again = await t.launch({ dataDir });
      const tab = (await again.invoke("tabs_list")).find((item) => item.kind === "repo");
      check(Boolean(tab), "after the restart the repository tab is back");
      if (tab && !tab.isActive) await again.invoke("tab_activate", { tabId: tab.id });
      await again.page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "tabs"] }));
      await eventually(async () => (await undoState()).disabled, false, "after the restart Undo is enabled", 30_000);
      await eventually(undoHint, (hint) => /Commit vor dem Neustart/.test(hint), "the hint names the commit from before the restart", 20_000);
      await t.blur();
      await again.page.keyboard.press("Control+z");
      await t.waitToast(/Undone/, "success");
      await eventually(() => head(fresh), parent, "git: Ctrl+Z after the restart undoes the commit");
      check(exists(fresh, "vor-dem-neustart.txt"), "the file is back in the working directory");
      await t.closeToasts();
      await again.settle();
      await t.blur();
      await again.page.keyboard.press("Control+y");
      await eventually(() => head(fresh), sha, "git: Ctrl+Y restores it");
    } finally {
      await first?.close().catch(() => undefined);
      await again?.close().catch(() => undefined);
      t.attach(main);
    }
  });
} catch (error) {
  t.check(false, `Aborted outside a section: ${error?.stack ?? error}`);
  t.results.push({ ids: ["F10"], title: "Aborted outside a section", ok: false, bug: null, seconds: "0" });
}
await t.end();
