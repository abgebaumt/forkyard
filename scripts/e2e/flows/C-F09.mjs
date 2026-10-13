/**
 * F09 – stash and bring back: the test cases no other script covered yet. In the real app, against
 * real Git repositories; checks use `git stash list`, the stash's content and the working directory.
 *
 *   node scripts/e2e/flows/C-F09.mjs                 everything
 *   node scripts/e2e/flows/C-F09.mjs --only F09-E7   only sections whose title or case id contains the text
 *   node scripts/e2e/flows/C-F09.mjs --show          visible window
 *
 * Covered elsewhere: toolbar Stash/Pop, Alt+S/Alt+P keyboard only, rename, apply, delete, pop with
 * conflict, untracked files, partial stash of single files, stash form with a name
 * (screens/interaction.mjs, keyboard.mjs, stash-form.mjs, stash-files.mjs).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { makeCleanRepoWithRemote } from "../fixtures.mjs";
import { commit, createFlow, exists, gitRaw, head, holdCore, lines, make, porcelain, readFile, sleep, stashList } from "./C-lib.mjs";

const t = createFlow("C-F09");
const { check, equal, eventually, section } = t;

try {
  const app = await t.launch();
  const { page } = app;
  const repo = await t.open(t.made(make(() => makeCleanRepoWithRemote({ name: "ablage" }))));

  const stashShas = () => lines(gitRaw(repo, ["stash", "list", "--format=%H"], { allowFail: true }) ?? "");
  const stashRow = (sha) => t.leftRow(`stash:${sha}`);
  const stashRows = () => t.leftPanel().locator('[data-row-id^="stash:"]').evaluateAll((list) => list.map((item) => item.getAttribute("data-row-id").slice(6)));
  const stashOutside = (message, { date = null } = {}) => {
    gitRaw(repo, ["stash", "push", "-q", "--include-untracked", "-m", message], date ? { env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } } : {});
    return stashShas()[0];
  };
  /** Everything gone: no stashes, clean working directory, main. */
  const reset = async () => {
    gitRaw(repo, ["merge", "--abort"], { allowFail: true });
    gitRaw(repo, ["reset", "-q", "--hard"], { allowFail: true });
    gitRaw(repo, ["clean", "-q", "-fd"], { allowFail: true });
    gitRaw(repo, ["stash", "clear"], { allowFail: true });
    await t.refresh(repo.repoId);
  };
  const openStashForm = async () => {
    await page.getByRole("radio", { name: "Stash" }).click();
    await page.locator('[data-screen="stash-form"]').waitFor({ timeout: 8000 });
    return { name: page.getByRole("textbox", { name: "Stash name" }), button: page.locator('button[data-action="stash"]') };
  };

  // ---------------------------------------------------------------------------------------------
  await section(["F09-E6"], "Umlauts, emoji and spaces in stash names and file paths: stash, bring back – everything unaltered", async () => {
    const name = "Zwischenstand 🌧️ Größe prüfen";
    const file = "notizen/Übersicht März 🌧️.txt";
    const content = "Im März fehlen die Tage 12 bis 14 (Stromausfall) 🌧️.\n";
    repo.write(file, content);
    repo.write("stationen.csv", `${readFile(repo, "stationen.csv")}W;Wetterhütte Süd-Ost;88\n`);
    await t.refresh(repo.repoId);
    const form = await openStashForm();
    await form.name.fill(name);
    await form.name.press("Enter");
    await t.waitToast(/stashed/, "success");
    equal(stashList(repo), [`On main: ${name}`], "git: the stash carries the name with umlauts, emoji and spaces");
    equal(porcelain(repo), [], "git: the working directory is clean – the untracked file is in the stash too");
    equal(lines(gitRaw(repo, ["-c", "core.quotepath=false", "show", "--name-only", "--format=", "stash@{0}^3"])), [file], "git: the file with umlaut, spaces and emoji is in the stash");
    const sha = stashShas()[0];
    await eventually(() => stashRow(sha).count(), 1, "left panel: the stash's row is there");
    check((await stashRow(sha).getAttribute("aria-label")).includes(name), `left panel: the name is unaltered (${await stashRow(sha).getAttribute("aria-label")})`);
    check((await t.toolHint("Pop")).includes(name), `toolbar: the hint on "Pop" names the stash: ${await t.toolHint("Pop")}`);
    await t.closeToasts();
    await t.toolButton("Pop").click();
    await t.waitToast(/Stash pop complete/, "success");
    equal(stashList(repo), [], "git: Pop removed the stash");
    equal(readFile(repo, file), content, "the file with umlaut and emoji in its name is back byte for byte");
    check(readFile(repo, "stationen.csv").includes("Wetterhütte Süd-Ost"), "the change to the tracked file is back");
    await t.noErrorToast("no error toast");
    await t.closeToasts();
  });
  await reset();

  // ---------------------------------------------------------------------------------------------
  await section(["F09-E5"], "Very long name (500 characters): the stash carries it in full; toast, left panel and toolbar truncate, nothing overflows", async () => {
    const name = `Zwischenstand ${"der Umstellung auf die neue Logger-Fassung ".repeat(12)}`.slice(0, 500).trim();
    check(name.length >= 495, `the name has ${name.length} characters`);
    repo.write("README.md", `${readFile(repo, "README.md")}\nHalbfertig.\n`);
    await t.refresh(repo.repoId);
    const form = await openStashForm();
    await form.name.fill(name);
    equal(await t.overflow(), { x: 0, y: 0 }, "the form does not overflow with 500 characters");
    await form.button.click();
    await t.waitToast(/stashed/, "success");
    equal(stashList(repo), [`On main: ${name}`], "git: the whole name is in the stash");
    const sha = stashShas()[0];
    await eventually(() => stashRow(sha).count(), 1, "left panel: row there");
    const box = await stashRow(sha).boundingBox();
    const panel = await t.leftPanel().boundingBox();
    check(box && panel && box.x + box.width <= panel.x + panel.width + 1 && box.height <= 60, `left panel: the row stays inside the panel (${Math.round(box?.width ?? 0)}×${Math.round(box?.height ?? 0)} px)`);
    equal(await t.overflow(), { x: 0, y: 0 }, "no page overflow");
    await t.closeToasts();
    // Delete: the confirmation truncates the name and keeps its width.
    await t.rightClickPick(stashRow(sha), /^Delete/);
    const confirm = await t.waitDialog(/^Delete stash “.*”\?$/);
    check(await t.inViewport(confirm), "the confirmation is fully inside the window");
    equal(await confirm.evaluate((node) => node.scrollWidth <= node.clientWidth), true, "the confirmation does not overflow");
    await confirm.getByRole("button", { name: "Delete stash" }).click();
    await eventually(() => stashList(repo), [], "git: the stash is deleted");
    await t.closeToasts();
  });
  await reset();

  // ---------------------------------------------------------------------------------------------
  await section(["F09-E4", "F09-E9"], "Empty input and cancel: renaming with empty text is not possible; Esc in \"Rename\" and in \"Delete?\" changes nothing", async () => {
    repo.write("README.md", `${readFile(repo, "README.md")}\nFür den Stash.\n`);
    const sha = stashOutside("Bleibt, wie er ist");
    await t.refresh(repo.repoId);
    await t.rightClickPick(stashRow(sha), /^Rename/);
    const rename = await t.waitDialog(/^Rename stash$/);
    const field = rename.getByLabel("Description");
    equal(await field.inputValue(), "Bleibt, wie er ist", "the old name is prefilled");
    await field.fill("");
    equal(await rename.getByRole("button", { name: "Rename" }).isDisabled(), true, "empty text: \"Rename\" is disabled");
    await field.press("Enter");
    await sleep(400);
    equal(await t.dialogTitle(), "Rename stash", "Enter with empty text does not close the dialog");
    await field.fill("   ");
    equal(await rename.getByRole("button", { name: "Rename" }).isDisabled(), true, "spaces only: disabled");
    await field.fill("Doch ein anderer Name");
    await page.keyboard.press("Escape");
    await t.noDialog();
    equal(stashList(repo), ["On main: Bleibt, wie er ist"], "git: Esc in rename changes nothing");
    await t.rightClickPick(stashRow(sha), /^Delete/);
    await t.waitDialog(/^Delete stash “Bleibt, wie er ist”\?$/);
    equal((await t.focused()).text, "Cancel", "in the confirmation the focus is on \"Cancel\"");
    await page.keyboard.press("Escape");
    await t.noDialog();
    await sleep(300);
    equal(stashShas(), [sha], "git: Esc in the confirmation keeps the stash");
    equal(await t.toasts(), [], "cancelling produces no toast");
  });
  await reset();

  // ---------------------------------------------------------------------------------------------
  await section(["F09-E7a"], "Changed from outside: a stash from the terminal shows up by itself, Pop becomes enabled; deleted outside it disappears", async () => {
    equal((await t.toolState("Pop")).disabled, true, "starting point: no stash, Pop disabled");
    repo.write("README.md", `${readFile(repo, "README.md")}\nAus dem Terminal gestasht.\n`);
    const sha = stashOutside("Aus dem Terminal");
    await eventually(() => stashRow(sha).count(), 1, "the stash from the terminal shows up in the left panel by itself", 25_000);
    await eventually(async () => (await t.toolState("Pop")).disabled, false, "Pop becomes enabled by itself", 25_000);
    check((await t.toolHint("Pop")).includes("Aus dem Terminal"), "the hint on \"Pop\" names the new stash");
    gitRaw(repo, ["stash", "drop", "-q"]);
    await eventually(() => stashRow(sha).count(), 0, "deleted outside: the row disappears by itself", 25_000);
    await eventually(async () => (await t.toolState("Pop")).disabled, true, "Pop is disabled again", 25_000);
    await t.noErrorToast("no error toast");
  });
  await reset();

  // ---------------------------------------------------------------------------------------------
  await section(["F09-E7b"], "List shifted: a newer stash is added outside – \"Delete\" on the old row still hits the intended stash", async () => {
    repo.write("README.md", `${readFile(repo, "README.md")}\nÄlterer Stand.\n`);
    const older = stashOutside("Der ältere – soll weg");
    await t.refresh(repo.repoId);
    await eventually(() => stashRow(older).count(), 1, "the app knows the older stash");
    // From now on the stash list answers delayed: the UI still shows the old state while a stash is added outside.
    const slow = await holdCore(page, "stashList", { delayMs: 3500 });
    try {
      repo.write("stationen.csv", `${readFile(repo, "stationen.csv")}X;Neuerer Stand;1\n`);
      const newer = stashOutside("Der neuere – muss bleiben");
      equal(stashShas(), [newer, older], "git: the newer one is now at position 0, the intended one at position 1");
      await t.rightClickPick(stashRow(older), /^Delete/);
      const confirm = await t.waitDialog(/^Delete stash “Der ältere – soll weg”\?$/);
      await confirm.getByRole("button", { name: "Delete stash" }).click();
      await eventually(() => stashShas().length, 1, "git: exactly one stash was deleted", 20_000);
      equal(stashShas(), [newer], "git: the intended (older) stash was deleted – the newer one the UI did not know yet is intact");
      equal(stashList(repo), ["On main: Der neuere – muss bleiben"], "git: name of the remaining stash");
    } finally {
      await slow.release();
    }
    await t.refresh(repo.repoId);
    await t.closeToasts();
  });
  await reset();

  // ---------------------------------------------------------------------------------------------
  await section(["F09-N4"], "Deleted stash: \"Apply\" on a row whose stash is already gone outside – clear message, nothing is applied", async () => {
    repo.write("README.md", `${readFile(repo, "README.md")}\nWird außen gelöscht.\n`);
    const gone = stashOutside("Gleich weg");
    repo.write("stationen.csv", `${readFile(repo, "stationen.csv")}Y;Bleibt;2\n`);
    const stays = stashOutside("Bleibt liegen");
    await t.refresh(repo.repoId);
    const slow = await holdCore(page, "stashList", { delayMs: 3500 });
    try {
      gitRaw(repo, ["stash", "drop", "-q", "stash@{1}"]);
      equal(stashShas(), [stays], "git: the older stash was deleted outside");
      await t.rightClickPick(stashRow(gone), /^Apply/);
      const warned = await t.waitToast(/That stash no longer exists/, "warning", 20_000);
      check(/applied or deleted/.test(warned?.text ?? ""), `the message explains what happened: ${warned?.text}`);
      equal(porcelain(repo), [], "git: nothing was applied – in particular not the other stash now at the same position");
      equal(stashShas(), [stays], "git: the other stash is intact");
    } finally {
      await slow.release();
    }
    await t.refresh(repo.repoId);
    await eventually(() => stashRow(gone).count(), 0, "the stale row is gone after reloading");
    await t.closeToasts();
  });
  await reset();

  // ---------------------------------------------------------------------------------------------
  await section(["F09-E8"], "Double click on \"Stash\" and on \"Pop\": exactly one stash is created, exactly one is brought back", async () => {
    repo.write("README.md", `${readFile(repo, "README.md")}\nErste Änderung.\n`);
    stashOutside("Liegt schon da");
    repo.write("stationen.csv", `${readFile(repo, "stationen.csv")}Z;Doppelklick;3\n`);
    await t.refresh(repo.repoId);
    await t.toolButton("Stash").dblclick();
    await t.waitToast(/Changes stashed/, "success");
    await sleep(1500);
    equal(stashShas().length, 2, "git: the double click on \"Stash\" creates exactly one stash (there are two now)");
    equal(porcelain(repo), [], "git: working directory clean");
    await t.noErrorToast("the second click produces no error toast");
    equal((await t.toasts()).filter((toast) => /stashed/.test(toast.text)).length, 1, "exactly one success toast");
    await t.closeToasts();
    await app.settle();
    await eventually(async () => (await t.toolState("Pop")).disabled, false, "Pop is enabled");
    const [newest, older] = stashShas();
    await t.toolButton("Pop").dblclick();
    await t.waitToast(/Stash pop complete/, "success");
    await sleep(2000);
    equal(stashShas(), [older], "git: the double click on \"Pop\" brings back exactly ONE stash (the newest); the older one stays");
    check(readFile(repo, "stationen.csv").includes("Doppelklick") && !readFile(repo, "README.md").includes("Erste Änderung"), "only the newest stash's change is in the working directory");
    await t.noErrorToast("the second click produces no error toast");
    void newest;
    await t.closeToasts();
  });
  await reset();

  // ---------------------------------------------------------------------------------------------
  // BUG C-05: When a changed file is in the way of the pop, the message does not name it (only from
  // four files on a second message lists them); the name is only behind "Show output".
  await section(
    ["F09-N1a"],
    "Pop with a changed file in the way: nothing is applied, the stash stays – and the message names the file",
    async () => {
      repo.write("README.md", "# Messnetz (aus dem Stash)\n\nGemeinsame Auswertung.\n");
      const first = stashOutside("Titel ändern");
      repo.write("README.md", `${readFile(repo, "README.md")}\nLokale, uncommittete Zeile.\n`);
      await t.refresh(repo.repoId);
      const localBefore = readFile(repo, "README.md");
      await t.toolButton("Pop").click();
      const blocked = await t.waitToast(/Stash pop/, null, 30_000);
      check(blocked?.tone === "danger" || blocked?.tone === "warning", `the pop reports that it did not work (${blocked?.tone}): ${blocked?.text}`);
      check(!/fatal:|[Ee]xit code/.test(blocked?.text ?? ""), "… in its own words");
      equal(stashShas(), [first], "git: the stash is still there");
      equal(readFile(repo, "README.md"), localBefore, "the local change is intact");
      await t.shot("target/e2e/bugs/C-05.png");
      check(/README\.md/.test(JSON.stringify(await t.toasts())), `the message names the file that is in the way: ${JSON.stringify(await t.toasts())}`);
    },
    { bug: "C-05" },
  );
  await reset();

  await section(["F09-N1b"], "Pop with an untracked file of the same name in the way: nothing is overwritten, the stash stays, the message names the file", async () => {
    // Untracked file in the stash, a file of the same name is already there.
    repo.write("notiz.txt", "aus dem Stash\n");
    const second = stashOutside("Mit Notiz");
    repo.write("notiz.txt", "liegt schon hier – darf nicht überschrieben werden\n");
    await t.refresh(repo.repoId);
    await t.toolButton("Pop").click();
    const untracked = await t.waitToast(/Stash pop/, null, 30_000);
    check(untracked?.tone === "danger" || untracked?.tone === "warning", `untracked file in the way: the pop reports it (${untracked?.tone}): ${untracked?.text}`);
    check(/notiz\.txt/.test(JSON.stringify(await t.toasts())), `the message names notiz.txt: ${JSON.stringify(await t.toasts())}`);
    equal(readFile(repo, "notiz.txt"), "liegt schon hier – darf nicht überschrieben werden\n", "the existing file is NOT overwritten");
    equal(stashShas(), [second], "git: the stash is still there – nothing is lost");
    await t.closeToasts();
  });
  await reset();

  // ---------------------------------------------------------------------------------------------
  // BUG C-06: When another program holds a changed file open, Git creates the stash but cannot reset the
  // file. The app only reports "Git command “git stash” failed (exit code 1)" – without naming the file
  // and without saying that the stash was created anyway.
  await section(["F09-N2"], "File locked by another program: no change is lost, and the message names the file and the created stash", async () => {
    const lockedFile = path.join(repo.path, "stationen.csv");
    repo.write("stationen.csv", `${readFile(repo, "stationen.csv")}Q;Gesperrt;9\n`);
    repo.write("README.md", `${readFile(repo, "README.md")}\nNicht gesperrt.\n`);
    await t.refresh(repo.repoId);
    const changedLocked = readFile(repo, "stationen.csv");
    const changedFree = readFile(repo, "README.md");
    const marker = path.join(repo.root, "sperre-steht.txt");
    // Another program holds the file open and allows reading only (like an editor or virus scanner on Windows).
    const holder = spawn(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", `$f=[System.IO.File]::Open('${lockedFile.replaceAll("'", "''")}','Open','Read','Read'); Set-Content -Path '${marker.replaceAll("'", "''")}' -Value 'x'; Start-Sleep -Seconds 12; $f.Close()`],
      { stdio: "ignore", windowsHide: true },
    );
    try {
      await eventually(() => fs.existsSync(marker), true, "the lock is in place", 30_000);
      await t.toolButton("Stash").click();
      const seen = await t.until(async () => (await t.toasts()).filter((toast) => /Stash|stashed/.test(toast.text)), (list) => list.length > 0, 40_000);
      const toast = seen.actual[0];
      const stashes = stashShas();
      const inStash = stashes.length ? lines(gitRaw(repo, ["stash", "show", "--name-only", "stash@{0}"])) : [];
      console.log(`    Behaviour with locked file: ${toast?.tone} "${toast?.text.slice(0, 160)}", stashes: ${stashes.length}, in stash: ${JSON.stringify(inStash)}, status: ${JSON.stringify(porcelain(repo))}`);
      // Every change is either still in the working directory or in the stash.
      const lockedSafe = readFile(repo, "stationen.csv") === changedLocked || inStash.includes("stationen.csv");
      const freeSafe = readFile(repo, "README.md") === changedFree || inStash.includes("README.md");
      check(lockedSafe, "the change to the locked file is still there (in the working directory or in the stash)");
      check(freeSafe, "the change to the other file is still there (in the working directory or in the stash)");
      if (toast?.tone === "success") {
        equal(stashes.length, 1, "with a success toast the stash really exists");
        equal(porcelain(repo), [], "… and the working directory really is clean – otherwise the success toast would be wrong");
      } else {
        await t.shot("target/e2e/bugs/C-06.png");
        check(/stationen\.csv/.test(toast?.text ?? ""), `the error names the file another program holds open: ${toast?.text}`);
        check(!/[Ee]xit code/.test(toast?.text ?? ""), "… in its own words instead of \"exit code 1\"");
        if (stashes.length) check(/[Ss]tash/.test((toast?.text ?? "").replace(/Stash failed/g, "")), "… and says that the stash was created anyway (otherwise one stashes a second time)");
      }
      // What the app shows matches the repository.
      await eventually(stashRows, stashes, "left panel: shows exactly the stashes that exist", 20_000);
    } finally {
      holder.kill();
      await sleep(600);
    }
    await t.closeToasts();
  }, { bug: "C-06" });
  await reset();

  // ---------------------------------------------------------------------------------------------
  await section(["F09-E11"], "Date: relative time on the stash (just now, hours ago, yesterday, days ago) – independent of the time zone it was created in", async () => {
    const now = Math.floor(Date.now() / 1000);
    const at = (secondsAgo, zone) => `${now - secondsAgo} ${zone}`;
    repo.write("a.txt", "a\n");
    const threeDays = stashOutside("Vor drei Tagen (Tokio)", { date: at(3 * 86400 + 600, "+0900") });
    repo.write("b.txt", "b\n");
    const yesterday = stashOutside("Vor 30 Stunden (Los Angeles)", { date: at(30 * 3600, "-0800") });
    repo.write("c.txt", "c\n");
    const hours = stashOutside("Vor fünf Stunden (UTC)", { date: at(5 * 3600 + 60, "+0000") });
    repo.write("d.txt", "d\n");
    const justNow = stashOutside("Gerade eben", { date: at(10, "+0200") });
    await t.refresh(repo.repoId);
    const label = (sha) => stashRow(sha).getAttribute("aria-label");
    await eventually(() => label(justNow), (text) => /just now/.test(text ?? ""), "10 seconds old: \"just now\"");
    check(/5 hours ago/.test(await label(hours)), `5 hours old, created in UTC: "5 hours ago" (${await label(hours)})`);
    check(/yesterday/.test(await label(yesterday)), `30 hours old, created with offset -08:00: "yesterday" (${await label(yesterday)})`);
    check(/3 days ago/.test(await label(threeDays)), `3 days old, created with offset +09:00: "3 days ago" (${await label(threeDays)})`);
    equal(await stashRows(), [justNow, hours, yesterday, threeDays], "order: the newest stash on top");
  });
  await reset();

  // ---------------------------------------------------------------------------------------------
  await section(["F09-H3", "F09-E14"], "Keyboard and screen reader only: reach the stash in the left panel, apply and delete it via Shift+F10; roles and names are right", async () => {
    repo.write("README.md", `${readFile(repo, "README.md")}\nPer Tastatur zurückgeholt.\n`);
    const sha = stashOutside("Für die Tastatur");
    await t.refresh(repo.repoId);
    equal(await stashRow(sha).getAttribute("role"), "treeitem", "the stash row is a treeitem");
    check(/^Stash Für die Tastatur, on main, /.test(await stashRow(sha).getAttribute("aria-label")), `its name gives kind, description, branch and age: ${await stashRow(sha).getAttribute("aria-label")}`);
    check(/Stash/.test((await t.leftPanel().locator('[data-section="stashes"] [role="tree"]').getAttribute("aria-label")) ?? ""), "the stash tree has a name");
    await t.focusLeftRowByKeyboard(`stash:${sha}`);
    check((await t.focused()).visible, "the focus on the stash row is visible");
    await page.keyboard.press("Shift+F10");
    await t.menuChooseByKeyboard(/^Apply/);
    await t.waitToast(/Apply stash complete/, "success");
    check(readFile(repo, "README.md").includes("Per Tastatur zurückgeholt"), "apply via the keyboard brings the change back");
    equal(stashShas(), [sha], "git: \"Apply\" keeps the stash");
    await eventually(async () => (await t.focused()).rowId, `stash:${sha}`, "after the menu the focus is on the stash row again");
    await page.keyboard.press("Shift+F10");
    await t.menuChooseByKeyboard(/^Delete/);
    const confirm = await t.waitDialog(/^Delete stash “Für die Tastatur”\?$/);
    check(["dialog", "alertdialog"].includes(await confirm.getAttribute("role")), "the confirmation before deleting is a dialog");
    check(Boolean(await confirm.evaluate((node) => document.getElementById(node.getAttribute("aria-describedby") ?? "")?.textContent)), "its text is attached to the dialog as its description (gets announced)");
    equal(await t.axe('[role="dialog"], [role="alertdialog"]'), [], "axe: no violations in the confirmation");
    equal((await t.focused()).text, "Cancel", "focus on \"Cancel\"");
    await page.keyboard.press("Tab");
    equal((await t.focused()).text, "Delete stash", "Tab goes to the \"Delete stash\" button");
    await page.keyboard.press("Enter");
    await eventually(stashShas, [], "git: the stash is deleted");
    await t.waitToast(/Stash deleted/, "success");
    await eventually(async () => (await t.focused()).tag !== "BODY", true, "the focus is not lost afterwards");
    check(/No stash available/.test(await t.toolHint("Pop")) && (await t.toolState("Pop")).disabled, "toolbar: Pop is disabled and gives the reason as its description");
    await t.closeToasts();
  });
  await reset();

  // ---------------------------------------------------------------------------------------------
  await section(["F09-E12"], "Minimum window 960×600: Stash and Pop are visible; the context menu of a stash at the bottom of the left panel stays inside the window", async () => {
    repo.write("README.md", `${readFile(repo, "README.md")}\nKlein.\n`);
    const sha = stashOutside("Im kleinen Fenster");
    repo.write("README.md", `${readFile(repo, "README.md")}\nNoch eine Änderung.\n`);
    await t.refresh(repo.repoId);
    await app.setSize(960, 600);
    try {
      for (const name of ["Stash", "Pop"]) check(await t.inViewport(t.toolButton(name)), `${name} is visible at 960 px`);
      // Below 1100 px the left panel collapses by itself; Ctrl+Alt+F brings it back.
      await page.keyboard.press("Control+Alt+f");
      await eventually(() => stashRow(sha).count(), 1, "Ctrl+Alt+F brings the left panel back; the stash row is there");
      await stashRow(sha).scrollIntoViewIfNeeded();
      await stashRow(sha).click({ button: "right" });
      await t.menu().waitFor();
      check(await t.inViewport(t.menu()), "the context menu is fully inside the window");
      equal((await t.menuEntries()).map((item) => item.text.replace(/ (the|Alt).*$/, "")), ["Apply", "Pop", "Rename …", "Create patch …", "Delete …"], "entries of the stash menu (real right click)");
      await t.closeMenu();
      equal(await t.overflow(), { x: 0, y: 0 }, "no page overflow");
    } finally {
      await app.setSize(1440, 900);
    }
  });
  await reset();

  // ---------------------------------------------------------------------------------------------
  await section(["F09-E10"], "Restart the app midway: stash and pop conflict survive the restart – nothing is lost", async () => {
    const dataDir = t.tempDataDir();
    const fresh = t.made(make(() => makeCleanRepoWithRemote({ name: "neustart-stash" })));
    const freshShas = () => lines(gitRaw(fresh, ["stash", "list", "--format=%H"], { allowFail: true }) ?? "");
    const main = t.app;
    let first = null;
    let again = null;
    try {
      first = await t.launch({ dataDir });
      await t.open(fresh);
      fresh.write("README.md", "# Messnetz (aus dem Stash)\n\nGemeinsame Auswertung.\n");
      fresh.write("neu.txt", "nicht verfolgt\n");
      await t.refresh(fresh.repoId);
      await t.toolButton("Stash").click();
      await t.waitToast(/Changes stashed/, "success");
      const sha = freshShas()[0];
      // Meanwhile the same spot is committed differently: the pop will end in a conflict.
      commit(fresh, "README.md", "# Messnetz (inzwischen committet)\n\nGemeinsame Auswertung.\n", "Titel anders geändert");
      await first.close();

      again = await t.launch({ dataDir });
      const tab = (await again.invoke("tabs_list")).find((item) => item.kind === "repo");
      check(Boolean(tab), "after the restart the repository's tab is back");
      if (tab && !tab.isActive) await again.invoke("tab_activate", { tabId: tab.id });
      await again.page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "tabs"] }));
      await eventually(() => t.leftRow(`stash:${sha}`).count(), 1, "after the restart the stash is in the left panel", 30_000);
      await eventually(async () => (await t.toolState("Pop")).disabled, false, "Pop is enabled");
      await t.toolButton("Pop").click();
      const conflict = await t.waitToast(/Stash pop: conflict in one file/, "warning", 30_000);
      check(/The stash is kept/.test(conflict?.text ?? ""), `the message says the stash stays: ${conflict?.text}`);
      equal(freshShas(), [sha], "git: the stash is still there");
      check(porcelain(fresh).includes("UU README.md"), "git: README.md is in conflict");
      await again.close();

      again = await t.launch({ dataDir });
      const tabAgain = (await again.invoke("tabs_list")).find((item) => item.kind === "repo");
      if (tabAgain && !tabAgain.isActive) await again.invoke("tab_activate", { tabId: tabAgain.id });
      await again.page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "tabs"] }));
      await eventually(() => t.leftRow(`stash:${sha}`).count(), 1, "second restart: the stash is still in the left panel", 30_000);
      const status = await t.until(() => t.cached(tabAgain.repoId, "status"), (value) => value && Array.isArray(value.conflicted), 30_000);
      equal(status.actual?.conflicted?.map((file) => file.path), ["README.md"], "the app still shows README.md as a conflicted file");
      equal(freshShas(), [sha], "git: the stash is intact after both restarts");
      check(exists(fresh, "neu.txt") || lines(gitRaw(fresh, ["show", "--name-only", "--format=", "stash@{0}^3"])).includes("neu.txt"), "the untracked file is there (in the working directory or still in the stash)");
      void head;
    } finally {
      await first?.close().catch(() => undefined);
      await again?.close().catch(() => undefined);
      t.attach(main);
    }
  });
} catch (error) {
  t.check(false, `Aborted outside a section: ${error?.stack ?? error}`);
  t.results.push({ ids: ["F09"], title: "Aborted outside a section", ok: false, bug: null, seconds: "0" });
}
await t.end();
