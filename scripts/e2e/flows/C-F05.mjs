/**
 * F05 – create and switch branches: the test cases no other script covered yet. In the real app,
 * against real Git repositories; checks look at the repository itself.
 *
 *   node scripts/e2e/flows/C-F05.mjs                 everything
 *   node scripts/e2e/flows/C-F05.mjs --only F05-E6   only sections whose title or case id contains the text
 *   node scripts/e2e/flows/C-F05.mjs --show          visible window
 *
 * Covered elsewhere: Ctrl+B keyboard only (screens/keyboard.mjs), "Create branch here …" in the graph
 * (screens/mustfix-sync.mjs), double-click checkout, blocking changes and checking out a remote branch
 * (screens/sidebar.mjs, screens/interaction.mjs).
 *
 * Red sections marked "BUG C-xx" show a reported bug and stay red until it is fixed.
 */
import fs from "node:fs";
import path from "node:path";
import { makeCleanRepoWithRemote } from "../fixtures.mjs";
import { branches, createFlow, currentBranch, gitRaw, head, holdCore, make, porcelain, readFile, removeHook, sleep, stashList, writeHook } from "./C-lib.mjs";

const t = createFlow("C-F05");
const { check, equal, eventually, section } = t;

try {
  const app = await t.launch();
  const { page } = app;
  const repo = await t.open(t.made(make(() => makeCleanRepoWithRemote({ name: "zweige" }))));
  const mainHead = repo.info.head;

  const openBranchDialog = async () => {
    await t.toolButton("Branch").click();
    return t.waitDialog(/^New branch$/);
  };
  const nameField = (dialog) => dialog.getByLabel("Name");
  const createButton = (dialog) => dialog.getByRole("button", { name: "Create branch" });
  /** Back to main without using the app (between sections). */
  const backToMain = async () => {
    if (currentBranch(repo) !== "main") gitRaw(repo, ["checkout", "-q", "main"]);
    await t.refresh(repo.repoId);
  };

  // ---------------------------------------------------------------------------------------------
  await section(["F05-H1"], "Toolbar \"Branch\" with the mouse: type a name, \"Create branch\" – created, checked out, visible everywhere", async () => {
    const dialog = await openBranchDialog();
    check((await dialog.innerText()).includes("The branch starts at the current commit."), "the dialog says where the branch starts");
    equal((await t.focused()).label, "Name", "the focus is in the name field");
    await page.keyboard.type("thema/erster zweig");
    equal(await nameField(dialog).inputValue(), "thema/erster-zweig", "spaces become \"-\" while typing");
    await eventually(() => createButton(dialog).isDisabled(), false, "with a valid name \"Create branch\" is enabled");
    await createButton(dialog).click();
    await t.waitToast(/Branch “thema\/erster-zweig” created and checked out/, "success");
    await t.noDialog();
    equal(currentBranch(repo), "thema/erster-zweig", "git: the new branch is checked out");
    equal(gitRaw(repo, ["rev-parse", "thema/erster-zweig"]), mainHead, "git: it points to the commit main was on");
    equal(porcelain(repo), [], "git: the working directory is untouched");
    await eventually(() => t.leftRow("refs/heads/thema/erster-zweig").getAttribute("aria-current"), "true", "left panel: the new branch is listed and marked as checked out");
    await eventually(() => t.leftRow("refs/heads/main").getAttribute("aria-current"), null, "left panel: main is no longer marked");
    await eventually(t.footer, (text) => text.startsWith("thema/erster-zweig"), "status bar: shows the new branch");
    await eventually(() => t.graphRowText(mainHead), (text) => text.includes("thema/erster-zweig"), "graph: the label is on the commit");
    await t.noErrorToast("no error toast");
    const focus = await t.focused();
    check(focus.tag !== "BODY", `after the dialog the focus is on an element again (${focus.tag} "${focus.label ?? focus.text}")`);
    await t.closeToasts();
    await backToMain();
  });

  // ---------------------------------------------------------------------------------------------
  await section(["F05-E5"], "Empty input: an empty field and spaces only create nothing", async () => {
    const before = branches(repo);
    const dialog = await openBranchDialog();
    equal(await createButton(dialog).isDisabled(), true, "empty field: \"Create branch\" is disabled");
    await page.keyboard.press("Enter");
    await sleep(500);
    equal(await t.dialogTitle(), "New branch", "Enter in the empty field does not close the dialog");
    equal(await dialog.getByRole("alert").count(), 0, "an empty field is not an error yet");
    await page.keyboard.type("   ");
    await eventually(() => dialog.getByRole("alert").count(), 1, "spaces only: the reason is shown at the field");
    check((await dialog.getByRole("alert").innerText()).length > 10, `the reason is a sentence: ${await dialog.getByRole("alert").innerText()}`);
    equal(await createButton(dialog).isDisabled(), true, "spaces only: disabled");
    await page.keyboard.press("Enter");
    await sleep(500);
    equal(await t.dialogTitle(), "New branch", "Enter does not close the dialog");
    await page.keyboard.press("Escape");
    await t.noDialog();
    equal(branches(repo), before, "git: no branch created");
    await t.noErrorToast("no error toast");
  });

  // ---------------------------------------------------------------------------------------------
  await section(["F05-E2"], "Invalid names by Git's rules: reason at the field, Enter creates nothing", async () => {
    const before = branches(repo);
    const dialog = await openBranchDialog();
    const cases = ["feature..x", "a~1", "a^b", "a:b", "a?b", "a*b", "a[b", "a\\b", "x.lock", ".versteckt", "ende.", "-start", "HEAD", "@", "a//b", "/a", "a/", "a@{b"];
    const reasons = new Set();
    for (const name of cases) {
      await nameField(dialog).fill(name);
      // Validation runs slightly delayed; while it runs, the button stays enabled and the old reason is still shown.
      await sleep(250);
      await eventually(() => createButton(dialog).isDisabled(), true, `"${name}": "Create branch" gets disabled`, 6000);
      const shown = await t.until(() => dialog.getByRole("alert").innerText(), (text) => typeof text === "string" && text.length > 8 && !text.startsWith("Error:"), 5000);
      check(shown.ok, `"${name}": the reason is shown at the field (${JSON.stringify(shown.actual)})`);
      reasons.add(shown.actual);
      equal(await nameField(dialog).getAttribute("aria-invalid"), "true", `"${name}": the field is marked invalid`);
      equal(await createButton(dialog).isDisabled(), true, `"${name}": "Create branch" is disabled`);
      await nameField(dialog).press("Enter");
      await sleep(250);
      equal(await t.dialogTitle(), "New branch", `"${name}": Enter does not close the dialog`);
    }
    check(reasons.size >= 8, `the reasons differ per rule (${reasons.size} different texts)`);
    // Names that collide with existing ones: folder ↔ branch.
    for (const [name, pattern] of [["feature", /feature\/export/], ["main/unter", /main/]]) {
      await nameField(dialog).fill(name);
      const shown = await t.until(() => dialog.getByRole("alert").innerText(), (text) => typeof text === "string" && pattern.test(text), 5000);
      check(shown.ok, `"${name}" collides with an existing branch; the reason names it (${JSON.stringify(shown.actual)})`);
    }
    await page.keyboard.press("Escape");
    await t.noDialog();
    equal(branches(repo), before, "git: no branch created");
    await t.noErrorToast("no error toast");
  });

  // ---------------------------------------------------------------------------------------------
  // BUG C-02: A name that differs only in the upper/lower case of a FOLDER ("Feature/neu" next to
  // "feature/export") is accepted. On Windows it ends up in the same folder: HEAD points to
  // refs/heads/Feature/neu, Git lists the branch as feature/neu.
  await section(
    ["F05-E17"],
    "Upper/lower case: \"MAIN\" next to \"main\" and \"Feature/neu\" next to \"feature/export\"",
    async () => {
      const dialog = await openBranchDialog();
      await nameField(dialog).fill("MAIN");
      const shown = await t.until(() => dialog.getByRole("alert").innerText(), (text) => typeof text === "string" && /upper\/lower case/.test(text), 5000);
      check(shown.ok, `"MAIN" is rejected, with a reason (${JSON.stringify(shown.actual)})`);
      await nameField(dialog).fill("Feature/neu");
      await sleep(900);
      const rejected = (await dialog.getByRole("alert").count()) > 0;
      if (rejected) {
        check(/upper\/lower case|feature/.test(await dialog.getByRole("alert").innerText()), "\"Feature/neu\" is rejected, with a reason");
        await page.keyboard.press("Escape");
        await t.noDialog();
        return;
      }
      // Not rejected: then the state afterwards must at least be consistent.
      await nameField(dialog).press("Enter");
      await t.noDialog();
      await t.maybeToast(/created/, "success", 20_000);
      const headRef = gitRaw(repo, ["symbolic-ref", "--short", "HEAD"]);
      const listed = branches(repo);
      await t.shot(`target/e2e/bugs/C-02.png`);
      check(listed.includes(headRef), `git: the checked-out branch "${headRef}" is also in the branch list (${JSON.stringify(listed)}) – otherwise Git knows two spellings of the same branch`);
      const current = await t.leftPanel().locator('[data-row-id^="refs/heads/"][aria-current="true"]').evaluateAll((list) => list.map((item) => item.getAttribute("data-row-id")));
      equal(current.length, 1, `left panel: exactly one local branch is marked as checked out (${JSON.stringify(current)})`);
    },
    { bug: "C-02" },
  );
  // Clean up after the case above, whatever was created.
  gitRaw(repo, ["checkout", "-q", "main"], { allowFail: true });
  for (const name of ["Feature/neu", "feature/neu"]) gitRaw(repo, ["branch", "-D", name], { allowFail: true });
  await t.refresh(repo.repoId);

  // ---------------------------------------------------------------------------------------------
  await section(["F05-E6a"], "Long name (74 characters): created, toast and left panel truncate, nothing overflows", async () => {
    const long = `thema/${"sehr-langer-name-".repeat(4)}`;
    equal(long.length, 74, "the name has 74 characters");
    const dialog = await openBranchDialog();
    await nameField(dialog).fill(long);
    await eventually(() => createButton(dialog).isDisabled(), false, "the long name is valid");
    check(await t.inViewport(dialog), "the dialog stays inside the window");
    equal(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth), true, "the dialog does not overflow");
    await nameField(dialog).press("Enter");
    const toast = await t.waitToast(/created and checked out/, "success");
    equal(currentBranch(repo), long, "git: the branch with the full name is checked out");
    const box = await page.locator('[data-toast="success"]').first().boundingBox();
    check(box && box.width <= 360, `the toast stays narrow (${Math.round(box?.width ?? 0)} px): ${toast?.text.slice(0, 60)}`);
    await eventually(() => t.leftRow(`refs/heads/${long}`).count(), 1, "left panel: the row is there");
    check((await t.leftRow(`refs/heads/${long}`).getAttribute("aria-label")).includes(long), "left panel: the full name is in the row's accessible name (for screen readers)");
    equal(await t.overflow(), { x: 0, y: 0 }, "no page overflow");
    await t.closeToasts();
    await backToMain();
  });

  // ---------------------------------------------------------------------------------------------
  // BUG C-01: A name the file system cannot hold (250 or 500 characters) is accepted by the field;
  // after "Create branch" the error claims a file is locked and advises deleting .git/index.lock.
  // Expected: the reason is the length of the name.
  await section(
    ["F05-E6b"],
    "Very long names (250 and 500 characters): nothing is created, and the message names the length as the reason",
    async () => {
      const before = branches(repo);
      for (const length of [250, 500]) {
        const name = `lang/${"x".repeat(length - 5)}`;
        const dialog = await openBranchDialog();
        await nameField(dialog).fill(name);
        await sleep(900);
        const atField = (await dialog.getByRole("alert").count()) > 0 ? await dialog.getByRole("alert").innerText() : null;
        if (atField) {
          check(/long|length|characters/i.test(atField), `${length} characters: the field names the length as the reason (${atField})`);
          await page.keyboard.press("Escape");
          await t.noDialog();
          continue;
        }
        await nameField(dialog).press("Enter");
        const failed = await t.waitToast(/Create branch failed/, "danger", 20_000);
        if (length === 250) await t.shot("target/e2e/bugs/C-01.png");
        check(/too long|length|characters/i.test(failed?.text ?? ""), `${length} characters: the message names the length of the name as the reason: ${failed?.text}`);
        check(!/index\.lock/.test(failed?.text ?? ""), `${length} characters: the message does NOT advise deleting .git/index.lock (there is no lock)`);
        check(!fs.existsSync(path.join(repo.path, ".git", "index.lock")), "there really is no lock file");
        if ((await t.dialogTitle()) !== null) await page.keyboard.press("Escape");
        await t.closeToasts();
      }
      equal(currentBranch(repo), "main", "git: still on main");
      equal(branches(repo), before, "git: no branch created");
    },
    { bug: "C-01" },
  );
  await backToMain();

  // ---------------------------------------------------------------------------------------------
  await section(["F05-E7"], "Umlauts and emoji in the name: created, checked out, shown correctly", async () => {
    const name = "thema/größe-🌧️-prüfen";
    const dialog = await openBranchDialog();
    await nameField(dialog).fill(name);
    await eventually(() => createButton(dialog).isDisabled(), false, "the name is valid");
    await nameField(dialog).press("Enter");
    await t.waitToast(/Branch “thema\/größe-🌧️-prüfen” created and checked out/, "success");
    equal(currentBranch(repo), name, "git: the branch has exactly this name (rev-parse --abbrev-ref HEAD)");
    check(branches(repo).includes(name), "git: for-each-ref lists it with umlauts and emoji");
    await eventually(() => t.leftRow(`refs/heads/${name}`).getAttribute("aria-current"), "true", "left panel: row with the name, checked out");
    equal((await t.leftRow(`refs/heads/${name}`).innerText()).trim(), "größe-🌧️-prüfen", "left panel: the name reads unaltered");
    await eventually(t.footer, (text) => text.startsWith(name), "status bar: unaltered");
    // Away and back: double-click checkout copes with the name.
    await t.closeToasts();
    await t.leftRow("refs/heads/main").dblclick();
    await eventually(() => currentBranch(repo), "main", "double-click on main switches back");
    await t.waitToast(/“main” checked out/, "success");
    await app.settle();
    await t.closeToasts();
    await t.leftRow(`refs/heads/${name}`).dblclick();
    await eventually(() => currentBranch(repo), name, "double-click on the branch with emoji checks it out");
    await t.noErrorToast("no error toast");
    await t.closeToasts();
    await backToMain();
  });

  // ---------------------------------------------------------------------------------------------
  await section(["F05-E10"], "Double Enter and double click on \"Create branch\": exactly one branch, no error, no second dialog", async () => {
    const before = branches(repo).length;
    let dialog = await openBranchDialog();
    await nameField(dialog).fill("doppelt/enter");
    await eventually(() => createButton(dialog).isDisabled(), false, "name valid");
    await nameField(dialog).focus();
    await Promise.all([page.keyboard.press("Enter"), page.keyboard.press("Enter")]);
    await eventually(() => currentBranch(repo), "doppelt/enter", "git: the branch is created and checked out");
    await sleep(1200);
    equal(await t.dialogTitle(), null, "after the double Enter no dialog is open (any more or again)");
    await t.noErrorToast("the second Enter produces no error toast (\"already exists\")");
    equal(branches(repo).length, before + 1, "git: exactly one more branch");
    await t.closeToasts();
    await backToMain();

    dialog = await openBranchDialog();
    await nameField(dialog).fill("doppelt/klick");
    await eventually(() => createButton(dialog).isDisabled(), false, "name valid");
    await createButton(dialog).dblclick();
    await eventually(() => currentBranch(repo), "doppelt/klick", "git: the branch is created and checked out");
    await sleep(1200);
    equal(await t.dialogTitle(), null, "after the double click no dialog is open");
    await t.noErrorToast("the second click produces no error toast");
    equal(branches(repo).length, before + 2, "git: exactly one further branch");
    equal(porcelain(repo), [], "git: working directory clean");
    await t.closeToasts();
    await backToMain();
  });

  // ---------------------------------------------------------------------------------------------
  await section(["F05-E11"], "Cancel midway: \"Cancel\", × and a click outside the dialog create nothing", async () => {
    const before = branches(repo);
    for (const way of ["Cancel", "Close", "outside"]) {
      const dialog = await openBranchDialog();
      await nameField(dialog).fill(`doch-nicht/${way.toLowerCase()}`);
      await eventually(() => createButton(dialog).isDisabled(), false, "name valid");
      if (way === "outside") await page.mouse.click(40, 500);
      else await dialog.getByRole("button", { name: way }).click();
      await t.noDialog(`"${way}" closes the dialog`);
      await sleep(300);
      equal(branches(repo), before, `"${way}": git: no branch created`);
      equal(await t.toasts(), [], `"${way}": no toast`);
    }
    equal(currentBranch(repo), "main", "git: still on main");
    // The next dialog starts empty – nothing of the cancelled attempt sticks.
    const dialog = await openBranchDialog();
    equal(await nameField(dialog).inputValue(), "", "a new dialog starts with an empty field");
    await page.keyboard.press("Escape");
    await t.noDialog();
  });

  // ---------------------------------------------------------------------------------------------
  await section(["F05-E9"], "Changed from outside while the app is open: new branch, checkout and delete via git show up by themselves", async () => {
    gitRaw(repo, ["branch", "aussen/neu"]);
    await eventually(() => t.leftRow("refs/heads/aussen/neu").count(), 1, "a branch created outside shows up in the left panel by itself", 25_000);
    gitRaw(repo, ["checkout", "-q", "feature/export"]);
    await eventually(() => t.leftRow("refs/heads/feature/export").getAttribute("aria-current"), "true", "a checkout in the terminal: the left panel marks the new branch", 25_000);
    await eventually(t.footer, (text) => text.startsWith("feature/export"), "… and the status bar shows it", 25_000);
    await eventually(() => t.toolHint("Branch"), (hint) => hint.length > 0, "the toolbar stays usable");
    gitRaw(repo, ["checkout", "-q", "main"]);
    gitRaw(repo, ["branch", "-D", "aussen/neu"]);
    await eventually(() => t.leftRow("refs/heads/aussen/neu").count(), 0, "a branch deleted outside disappears by itself", 25_000);
    await eventually(() => t.leftRow("refs/heads/main").getAttribute("aria-current"), "true", "main is marked again", 25_000);
    await t.noErrorToast("no error toast");
  });

  // ---------------------------------------------------------------------------------------------
  await section(["F05-N3"], "Deleted ref: double click on a branch that no longer exists outside – clear message, nothing happens", async () => {
    gitRaw(repo, ["branch", "aussen/weg"]);
    await t.refresh(repo.repoId);
    await eventually(() => t.leftRow("refs/heads/aussen/weg").count(), 1, "the branch is in the left panel");
    // The list stays on the old state while the branch disappears outside.
    const held = await holdCore(page, "refsList");
    gitRaw(repo, ["branch", "-D", "aussen/weg"]);
    await t.leftRow("refs/heads/aussen/weg").dblclick();
    const failed = await t.waitToast(/Checkout failed|was not checked out|doesn’t exist/, null, 20_000);
    check(/aussen\/weg|doesn’t exist|not found|does not exist/i.test(failed?.text ?? ""), `the message says the branch doesn't exist (any more): ${failed?.text}`);
    check(!/[Ee]xit code|fatal:|pathspec/.test(failed?.text ?? ""), `… in its own words, not as raw Git output: ${failed?.text}`);
    equal(currentBranch(repo), "main", "git: still on main");
    equal(porcelain(repo), [], "git: nothing changed");
    await held.release();
    await t.refresh(repo.repoId);
    await eventually(() => t.leftRow("refs/heads/aussen/weg").count(), 0, "after reloading the row is gone");
    await t.closeToasts();
  });

  // ---------------------------------------------------------------------------------------------
  await section(["F05-E16"], "Same repository in two windows: branch created in the first – the second shows it and the switch by itself", async () => {
    const second = await t.launch({ attach: false });
    try {
      await second.openRepo(repo.path);
      const other = second.page;
      await other.locator('[data-screen="sidebar"] [data-row-id="refs/heads/main"]').waitFor();
      const dialog = await openBranchDialog();
      await nameField(dialog).fill("fenster/eins");
      await nameField(dialog).press("Enter");
      await t.waitToast(/Branch “fenster\/eins” created and checked out/, "success");
      equal(currentBranch(repo), "fenster/eins", "git: created and checked out in the first window");
      const row = other.locator('[data-screen="sidebar"] [data-row-id="refs/heads/fenster/eins"]');
      await eventually(() => row.count(), 1, "second window: the branch shows up by itself", 30_000);
      await eventually(() => row.getAttribute("aria-current"), "true", "second window: it is marked as checked out", 30_000);
      await eventually(() => other.locator("footer").innerText().then((text) => text.replace(/\s+/g, " ").trim().startsWith("fenster/eins")), true, "second window: the status bar shows it", 30_000);
      // And back: checkout in the second window, the first one follows.
      await other.locator('[data-screen="sidebar"] [data-row-id="refs/heads/main"]').dblclick();
      await eventually(() => currentBranch(repo), "main", "git: double click in the second window checks out main");
      await eventually(() => t.leftRow("refs/heads/main").getAttribute("aria-current"), "true", "first window: main is marked again by itself", 30_000);
      await eventually(t.footer, (text) => text.startsWith("main"), "first window: status bar shows main", 30_000);
      equal(second.consoleErrors, [], "second window: no console errors");
    } finally {
      await second.close().catch(() => undefined);
    }
    await t.closeToasts();
    await backToMain();
  });

  // ---------------------------------------------------------------------------------------------
  // BUG C-03: When the post-checkout hook fails, Git has switched the branch anyway.
  // The app reports "Checkout failed … exit code 1" though – and names neither the hook nor its output.
  await section(
    ["F05-N1"],
    "Hook declines: post-checkout fails – the switch happened, the message says so and names the hook",
    async () => {
      writeHook(repo, "post-checkout", 'echo "post-checkout: Umgebung nicht bereit" >&2\nexit 1');
      try {
        await t.leftRow("refs/heads/feature/export").dblclick();
        await eventually(() => currentBranch(repo), "feature/export", "git: the branch has switched (the hook only runs afterwards)", 20_000);
        await eventually(() => t.toasts().then((list) => list.length > 0), true, "the app reports something");
        await sleep(600);
        const shown = await t.toasts();
        await t.shot("target/e2e/bugs/C-03.png");
        check(!shown.some((toast) => /Checkout failed/.test(toast.text)), `the app does not claim the checkout failed (the branch DID switch): ${JSON.stringify(shown)}`);
        check(shown.some((toast) => /post-checkout/.test(toast.text)), `a toast names the hook "post-checkout": ${JSON.stringify(shown)}`);
        check(shown.some((toast) => /Umgebung nicht bereit/.test(toast.text)), "… and shows what it printed");
        await eventually(() => t.leftRow("refs/heads/feature/export").getAttribute("aria-current"), "true", "left panel: the switched-to branch is marked");
        await eventually(t.footer, (text) => text.startsWith("feature/export"), "status bar: shows the switched-to branch");
      } finally {
        removeHook(repo, "post-checkout");
      }
    },
    { bug: "C-03" },
  );
  await backToMain();

  // ---------------------------------------------------------------------------------------------
  await section(["F05-N2"], "Lock in the file system (.git/index.lock): checkout fails clearly, nothing changed; afterwards it works", async () => {
    const lock = path.join(repo.path, ".git", "index.lock");
    fs.writeFileSync(lock, "");
    try {
      await t.leftRow("refs/heads/feature/export").dblclick();
      const failed = await t.waitToast(/Checkout failed/, "danger", 30_000);
      check(/Another Git program|lock file|locked/.test(failed?.text ?? ""), `the message explains the lock: ${failed?.text}`);
      check(/index\.lock/.test(failed?.text ?? ""), "… and names the file");
      equal(gitRaw(repo, ["symbolic-ref", "--short", "HEAD"]), "main", "git: still on main");
      await eventually(() => t.leftRow("refs/heads/main").getAttribute("aria-current"), "true", "left panel: main stays marked");
    } finally {
      fs.rmSync(lock, { force: true });
    }
    await t.closeToasts();
    await t.leftRow("refs/heads/feature/export").dblclick();
    await eventually(() => currentBranch(repo), "feature/export", "without the lock the same double click works");
    await t.closeToasts();
    await backToMain();
  });

  // ---------------------------------------------------------------------------------------------
  await section(["F05-E15"], "Detached HEAD: check out a commit from the graph context menu, then \"Create branch here\" from the toast", async () => {
    const second = gitRaw(repo, ["rev-parse", "main~1"]);
    await t.rightClickPick(t.graphRow(second), /^Check out commit/);
    await eventually(() => currentBranch(repo), "HEAD", "git: HEAD is detached");
    equal(head(repo), second, "git: the chosen commit is checked out");
    const detached = await t.waitToast(/HEAD detached at/, "info");
    check(Boolean(detached), "the toast explains the state");
    await page.locator("[data-toast]").getByRole("button", { name: "Create branch here" }).click();
    const dialog = await t.waitDialog(/^New branch$/);
    await nameField(dialog).fill("rettung/von-hier");
    await nameField(dialog).press("Enter");
    await t.waitToast(/Branch “rettung\/von-hier” created and checked out/, "success");
    equal(currentBranch(repo), "rettung/von-hier", "git: the branch is checked out – HEAD is no longer detached");
    equal(gitRaw(repo, ["rev-parse", "rettung/von-hier"]), second, "git: it points to the checked-out commit");
    await eventually(t.footer, (text) => text.startsWith("rettung/von-hier"), "status bar: shows the branch instead of \"HEAD detached\"");
    await t.closeToasts();
    await backToMain();
  });

  // ---------------------------------------------------------------------------------------------
  await section(["F05-E13"], "Minimum window 960×600: dialog with a long name and error text stays fully inside the window", async () => {
    await app.setSize(960, 600);
    try {
      const dialog = await openBranchDialog();
      await nameField(dialog).fill(`feature/${"ein-sehr-langer-name-der-nicht-passt-".repeat(3)}..`);
      await eventually(() => dialog.getByRole("alert").count(), 1, "the reason is shown at the field");
      check(await t.inViewport(dialog), "the dialog is fully inside the window");
      check(await t.inViewport(dialog.getByRole("alert")), "the error text is visible");
      check(await t.inViewport(createButton(dialog)), "the buttons are visible");
      equal(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth), true, "the dialog does not overflow");
      equal(await t.overflow(), { x: 0, y: 0 }, "no page overflow");
      await page.keyboard.press("Escape");
      await t.noDialog();
      check(await t.inViewport(t.toolButton("Branch")), "the toolbar button \"Branch\" is visible at 960 px");
    } finally {
      await app.setSize(1440, 900);
    }
  });

  // ---------------------------------------------------------------------------------------------
  await section(["F05-E14"], "Screen reader: roles, names and errors of the branch dialog; focus visible; axe without violations", async () => {
    await page.evaluate((tabId) => window.__gc.store.getState().selectWip(tabId), repo.tabId);
    const button = t.toolButton("Branch");
    check((await t.toolHint("Branch")).length > 10, `the toolbar button has a description (aria-describedby): ${await t.toolHint("Branch")}`);
    await button.focus();
    await page.keyboard.press("Enter");
    const dialog = await t.waitDialog(/^New branch$/);
    equal(await dialog.getAttribute("role"), "dialog", "role dialog");
    const named = await dialog.evaluate((node) => ({
      name: document.getElementById(node.getAttribute("aria-labelledby") ?? "")?.textContent ?? null,
      description: document.getElementById(node.getAttribute("aria-describedby") ?? "")?.textContent ?? null,
    }));
    equal(named, { name: "New branch", description: "The branch starts at the current commit." }, "the dialog has a name and a description");
    const focus = await t.focused();
    check(focus.label === "Name" && focus.visible, `the focus is visibly in the "Name" field (${JSON.stringify(focus)})`);
    equal(await page.getByRole("textbox", { name: "Name" }).count(), 1, "the field can be found by role and name");
    await page.keyboard.type("a..b");
    await eventually(() => dialog.getByRole("alert").count(), 1, "the error is a role=alert (gets announced)");
    const wired = await nameField(dialog).evaluate((input) => {
      const ids = `${input.getAttribute("aria-describedby") ?? ""} ${input.getAttribute("aria-errormessage") ?? ""}`.split(/\s+/).filter(Boolean);
      return { invalid: input.getAttribute("aria-invalid"), text: ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ") };
    });
    equal(wired.invalid, "true", "aria-invalid on the field");
    check(/\.\./.test(wired.text), `the error text is wired to the field (aria-describedby / aria-errormessage): ${JSON.stringify(wired.text)}`);
    equal(await dialog.getByRole("button", { name: "Close" }).count(), 1, "the × button has a name");
    equal(await t.axe('[role="dialog"]'), [], "axe: no violations in the dialog");
    // Tab stays in the dialog (focus trap), Esc returns the focus to the trigger.
    for (let step = 0; step < 6; step++) {
      await page.keyboard.press("Tab");
      check((await t.focused()).inDialog, `Tab ${step + 1}: the focus stays in the dialog`);
    }
    await page.keyboard.press("Escape");
    await t.noDialog();
    await eventually(async () => (await t.focused()).text.startsWith("Branch"), true, "Esc returns the focus to the \"Branch\" button");
    check((await t.focused()).visible, "… and it is visible there");
  });

  // ---------------------------------------------------------------------------------------------
  await section(["F05-E12"], "Restart the app midway: prompt \"changes are blocking the switch\" open – afterwards nothing is half done", async () => {
    const dataDir = t.tempDataDir();
    const fresh = t.made(make(() => makeCleanRepoWithRemote({ name: "neustart" })));
    const main = t.app;
    let first = null;
    let again = null;
    try {
      first = await t.launch({ dataDir });
      await t.open(fresh);
      // feature/export has src/export.py; an untracked file of the same name on main blocks the switch.
      fresh.write("src/export.py", "# lokal angelegt, steht dem Wechsel im Weg\n");
      await t.refresh(fresh.repoId);
      await t.leftRow("refs/heads/feature/export").dblclick();
      await t.waitDialog(/^Uncommitted changes are blocking the switch$/);
      await first.close(); // midway: the dialog is open
      again = await t.launch({ dataDir });
      const tabs = await again.invoke("tabs_list");
      const restored = tabs.find((tab) => tab.kind === "repo");
      check(Boolean(restored), `after the restart the repository's tab is back (${JSON.stringify(tabs.map((tab) => tab.kind))})`);
      if (restored && !restored.isActive) await again.invoke("tab_activate", { tabId: restored.id });
      await again.page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "tabs"] }));
      await eventually(t.footer, (text) => text.startsWith("main"), "the status bar shows main – the switch did not happen", 30_000);
      equal(await t.dialogTitle(), null, "no dialog is open");
      equal(currentBranch(fresh), "main", "git: main is checked out");
      equal(stashList(fresh), [], "git: no stash was created");
      equal(readFile(fresh, "src/export.py"), "# lokal angelegt, steht dem Wechsel im Weg\n", "the local file is intact");
      check(!fs.existsSync(path.join(fresh.path, ".git", "index.lock")), "no lock file is left behind");
      // The same step works as usual after the restart.
      await t.leftRow("refs/heads/feature/export").dblclick();
      const dialog = await t.waitDialog(/^Uncommitted changes are blocking the switch$/);
      await dialog.getByRole("button", { name: /Stash changes and switch/ }).click();
      await eventually(() => currentBranch(fresh), "feature/export", "\"Stash changes and switch\" works after the restart");
      equal(stashList(fresh).length, 1, "git: exactly one stash");
    } finally {
      await first?.close().catch(() => undefined);
      await again?.close().catch(() => undefined);
      t.attach(main);
    }
  });
} catch (error) {
  t.check(false, `Aborted outside a section: ${error?.stack ?? error}`);
  t.results.push({ ids: ["F05"], title: "Aborted outside a section", ok: false, bug: null, seconds: "0" });
}
await t.end();
