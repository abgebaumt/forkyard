/**
 * F14 – Create and push a tag: the cases no other script covered yet. In the real app, through the
 * real context menus (right-click or Shift+F10), against real Git repositories with a bare “origin”;
 * checked with git in the repository and in the remote.
 *
 *   node scripts/e2e/flows/C-F14.mjs                 everything
 *   node scripts/e2e/flows/C-F14.mjs --only F14-E5   only sections whose title or case ID contains the text
 *   node scripts/e2e/flows/C-F14.mjs --show          visible window
 *
 * Already covered elsewhere: create tag (lightweight, annotated), existing name, push, delete locally
 * and on the remote – through the app's menu functions (screens/interaction.mjs); pre-push hook rejects
 * the tag push (screens/shell.mjs); long tag names and annotation tooltip in the left panel (screens/sidebar.mjs).
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { makeCleanRepoWithRemote, makeEmptyRepo } from "../fixtures.mjs";
import { createFlow, gitRaw, head, holdCore, lines, make, remoteGit, sleep, tags } from "./C-lib.mjs";

const t = createFlow("C-F14");
const { check, equal, eventually, section } = t;

const closedPort = await new Promise((resolve) => {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});

try {
  const app = await t.launch();
  const { page } = app;
  const repo = await t.open(t.made(make(() => makeCleanRepoWithRemote({ name: "marken" }))));
  const mainHead = repo.info.head;
  const second = gitRaw(repo, ["rev-parse", "main~1"]);
  const root = gitRaw(repo, ["rev-list", "--max-parents=0", "main"]);

  const remoteTags = () => lines(remoteGit(repo, "for-each-ref", "--format=%(refname:short)", "refs/tags"));
  const remoteTagTarget = (name) => remoteGit(repo, "rev-parse", `refs/tags/${name}^{commit}`);
  const tagTarget = (name) => gitRaw(repo, ["rev-parse", `refs/tags/${name}^{commit}`]);
  const tagRow = (name) => t.leftRow(`refs/tags/${name}`);
  const nameField = (dialog) => dialog.getByLabel("Name");
  const createButton = (dialog) => dialog.getByRole("button", { name: "Create tag" });
  const openTagDialog = async () => {
    await t.runCommand("tag.create");
    return t.waitDialog(/^Create tag$/);
  };
  /** Remove all tags, locally and on the remote. */
  const reset = async () => {
    for (const name of tags(repo)) gitRaw(repo, ["tag", "-d", name], { allowFail: true });
    for (const name of remoteTags()) remoteGit(repo, "update-ref", "-d", `refs/tags/${name}`);
    await t.refresh(repo.repoId);
  };

  // ---------------------------------------------------------------------------------------------
  await section(["F14-H1"], "Happy path with the mouse through the real context menus: right-click commit → “Create tag here …” → name; right-click tag → push", async () => {
    await t.graphRow(second).click({ button: "right" });
    await t.menu().waitFor();
    check((await t.menuEntries()).some((item) => /^Create tag here/.test(item.text) && !item.disabled), "the commit menu offers “Create tag here …”");
    await t.menu().getByRole("menuitem", { name: /^Create tag here/ }).click();
    const dialog = await t.waitDialog(/^Create tag$/);
    check((await dialog.innerText()).includes(`The tag points to ${second.slice(0, 7)}.`), "the dialog names the commit the tag points to");
    equal((await t.focused()).label, "Name", "the focus is in the name field");
    await page.keyboard.type("v1.0.0");
    check(/lightweight tag/.test(await dialog.innerText()), "without annotation: hint about the lightweight tag");
    await page.keyboard.press("Enter");
    await t.waitToast(/Tag “v1\.0\.0” created/, "success");
    equal(tagTarget("v1.0.0"), second, "git: the tag points to the chosen commit (not to HEAD)");
    equal(gitRaw(repo, ["cat-file", "-t", "v1.0.0"]), "commit", "git: lightweight tag");
    equal(head(repo), mainHead, "git: HEAD is untouched");
    await eventually(() => tagRow("v1.0.0").count(), 1, "left panel: the tag is listed under “Tags”");
    await eventually(() => t.graphRowText(second), (text) => text.includes("v1.0.0"), "graph: the tag label is on the commit");
    await t.closeToasts();
    equal(remoteTags(), [], "git (bare): before the push the remote does not know the tag");
    await tagRow("v1.0.0").click({ button: "right" });
    await t.menu().waitFor();
    equal(
      (await t.menuEntries()).map((item) => item.text.replace(/ no branch is checked out afterwards.*$/, "")).slice(0, 6),
      ["Check out", "Create branch here …", "Push to origin", "Copy name", "Delete locally …", "Also delete on the remote …"],
      "entries of the tag menu (real right-click in the left panel; hide and solo follow)",
    );
    await t.menu().getByRole("menuitem", { name: /^Push to origin/ }).click();
    await t.waitToast(/Tag “v1\.0\.0” pushed to origin/, "success", 60_000);
    equal(remoteTags(), ["v1.0.0"], "git (bare): the tag is on the remote");
    equal(remoteTagTarget("v1.0.0"), second, "git (bare): and points to the same commit there");
    await t.closeToasts();
    // Push again: not an error but a notice.
    await t.rightClickPick(tagRow("v1.0.0"), /^Push to origin/);
    const again = await t.waitToast(/Tag “v1\.0\.0”/, null, 60_000);
    check(again?.tone === "info" && /is already on origin/.test(again.text), `a second push is not an error: ${JSON.stringify(again)}`);
    await t.closeToasts();
  });
  await reset();

  // ---------------------------------------------------------------------------------------------
  await section(["F14-H2"], "Happy path with the keyboard only: go to the commit in the graph, Shift+F10, annotated tag, push in the left panel and delete locally+remotely", async () => {
    await t.focusGraphRowByKeyboard(root);
    check((await t.focused()).visible, "the focus on the graph row is visible");
    await page.keyboard.press("Shift+F10");
    await t.menuChooseByKeyboard(/^Create tag here/);
    const dialog = await t.waitDialog(/^Create tag$/);
    await page.keyboard.type("anfang 2026");
    equal(await nameField(dialog).inputValue(), "anfang-2026", "spaces in the name become “-”");
    await page.keyboard.press("Tab");
    equal((await t.focused()).tag, "TEXTAREA", "Tab goes into the annotation");
    await page.keyboard.type("Erster Stand des Messnetzes");
    await eventually(() => dialog.innerText().then((text) => /Annotated tag/.test(text)), true, "with text: hint about the annotated tag");
    await page.keyboard.press("Control+Enter");
    await t.waitToast(/Annotated tag “anfang-2026” created/, "success");
    equal(gitRaw(repo, ["cat-file", "-t", "anfang-2026"]), "tag", "git: annotated tag");
    equal(tagTarget("anfang-2026"), root, "git: it points to the commit chosen with the keyboard");
    equal(gitRaw(repo, ["tag", "-l", "--format=%(contents)", "anfang-2026"]).trim(), "Erster Stand des Messnetzes", "git: the annotation is in the tag");
    await eventually(async () => (await t.focused()).tag !== "BODY", true, "after the dialog the focus is not lost");
    await t.closeToasts();
    await t.focusLeftRowByKeyboard("refs/tags/anfang-2026");
    await page.keyboard.press("Shift+F10");
    await t.menuChooseByKeyboard(/^Push to origin/);
    await t.waitToast(/Tag “anfang-2026” pushed to origin/, "success", 60_000);
    equal(remoteTags(), ["anfang-2026"], "git (bare): the tag is on the remote");
    equal(remoteGit(repo, "cat-file", "-t", "refs/tags/anfang-2026"), "tag", "git (bare): as an annotated tag");
    await t.closeToasts();
    await t.focusLeftRowByKeyboard("refs/tags/anfang-2026");
    await page.keyboard.press("Shift+F10");
    await t.menuChooseByKeyboard(/^Also delete on the remote/);
    await t.waitDialog(/^Delete tag “anfang-2026” locally and on origin\?$/);
    equal((await t.focused()).text, "Cancel", "in the confirmation the focus is on “Cancel”");
    await page.keyboard.press("Tab");
    equal((await t.focused()).text, "Delete locally and on remote", "Tab goes to the dangerous button");
    await page.keyboard.press("Enter");
    await t.waitToast(/deleted locally and on origin/, "success", 60_000);
    equal(tags(repo), [], "git: locally the tag no longer exists");
    equal(remoteTags(), [], "git (bare): nor on the remote");
    await eventually(async () => (await t.focused()).tag !== "BODY", true, "the focus is not lost afterwards");
    await t.closeToasts();
  });
  await reset();

  // ---------------------------------------------------------------------------------------------
  await section(["F14-E3", "F14-E6"], "Empty input and invalid names: disabled with a reason at the field; the annotated tag requires a text", async () => {
    gitRaw(repo, ["tag", "vorhanden"]);
    await t.refresh(repo.repoId);
    const dialog = await openTagDialog();
    equal(await createButton(dialog).isDisabled(), true, "empty field: “Create tag” is disabled");
    await page.keyboard.press("Enter");
    await sleep(400);
    equal(await t.dialogTitle(), "Create tag", "Enter in the empty field does not close the dialog");
    for (const name of ["   ", "v1..0", "v1~0", "v 1:0", "ende.", "x.lock", "-start", "a//b", "vorhanden"]) {
      await nameField(dialog).fill(name);
      await sleep(250);
      await eventually(() => createButton(dialog).isDisabled(), true, `“${name}”: “Create tag” becomes disabled`, 6000);
      const shown = await t.until(() => dialog.getByRole("alert").innerText(), (text) => typeof text === "string" && text.length > 8 && !text.startsWith("Error:"), 5000);
      check(shown.ok, `“${name}”: the reason is shown at the field (${JSON.stringify(shown.actual)})`);
      await nameField(dialog).press("Enter");
      await sleep(200);
      equal(await t.dialogTitle(), "Create tag", `“${name}”: Enter does not close the dialog`);
    }
    await page.keyboard.press("Escape");
    await t.noDialog();
    equal(tags(repo), ["vorhanden"], "git: no tag was created");
    // “Create annotated tag”: disabled without text.
    await t.runCommand("tag.createAnnotated");
    const annotated = await t.waitDialog(/^Create annotated tag$/);
    await nameField(annotated).fill("v2.0.0");
    await sleep(500);
    equal(await createButton(annotated).isDisabled(), true, "annotated tag without text: disabled");
    check(/needs a text/.test(await annotated.innerText()), "… with a reason");
    await nameField(annotated).press("Enter");
    await sleep(400);
    equal(await t.dialogTitle(), "Create annotated tag", "Enter without text creates nothing");
    await annotated.getByLabel("Annotation").fill("   ");
    equal(await createButton(annotated).isDisabled(), true, "only spaces as text: disabled");
    await page.keyboard.press("Escape");
    await t.noDialog();
    equal(tags(repo), ["vorhanden"], "git: still only the one tag");
    await t.noErrorToast("no error message");
  });
  await reset();

  // ---------------------------------------------------------------------------------------------
  await section(["F14-E5"], "Umlauts, emoji and multi-line annotation: name and text reach the repository and the remote unaltered", async () => {
    const name = "auslieferung/größe-🌧️-märz";
    const text = "Auslieferung März 🌧️\n\nEnthält die Größen aller Stationen.\n- Nord: geprüft\n- Süd: „offen“";
    const dialog = await openTagDialog();
    await nameField(dialog).fill("auslieferung/größe 🌧️ märz");
    equal(await nameField(dialog).inputValue(), name, "spaces become “-”, umlauts and emoji stay");
    await dialog.getByLabel(/Annotation/).fill(text);
    await eventually(() => createButton(dialog).isDisabled(), false, "the name is valid");
    await createButton(dialog).click();
    await t.waitToast(/Annotated tag “auslieferung\/größe-🌧️-märz” created/, "success");
    equal(tags(repo), [name], "git: the tag has exactly this name");
    equal(gitRaw(repo, ["tag", "-l", "--format=%(contents)", name]).trimEnd(), text, "git: the annotation is in the tag line by line");
    equal(gitRaw(repo, ["tag", "-l", "--format=%(taggername) <%(taggeremail:trim)>", name]), "Lena Hartmann <lena.hartmann@wetterstation.example>", "git: the tagger is the app's identity");
    await eventually(() => tagRow(name).count(), 1, "left panel: row present");
    const label = await tagRow(name).getAttribute("aria-label");
    check(label.includes(name) && label.includes("Auslieferung März 🌧️"), `left panel: name and first line of the annotation unaltered in the row's name (${label})`);
    await t.closeToasts();
    await t.rightClickPick(tagRow(name), /^Push to origin/);
    await t.waitToast(/pushed to origin/, "success", 60_000);
    equal(remoteTags(), [name], "git (bare): the tag is on the remote with umlauts and emoji");
    equal(remoteGit(repo, "tag", "-l", "--format=%(contents)", name).trimEnd(), text, "git (bare): including the annotation");
    equal(await t.overflow(), { x: 0, y: 0 }, "no page overflow");
    await t.closeToasts();
  });
  await reset();

  // ---------------------------------------------------------------------------------------------
  await section(["F14-E4a"], "Long name (100 characters): created; left panel, graph and message shorten it, nothing overflows", async () => {
    const name = `auslieferung-${"wetterstation-schuldach-".repeat(4)}`.slice(0, 100).replace(/-$/, "x");
    equal(name.length, 100, "the name has 100 characters");
    const dialog = await openTagDialog();
    await nameField(dialog).fill(name);
    await eventually(() => createButton(dialog).isDisabled(), false, "valid");
    check(await t.inViewport(dialog), "the dialog stays inside the window");
    await nameField(dialog).press("Enter");
    await t.waitToast(/created/, "success");
    equal(tags(repo), [name], "git: the tag has the full name");
    await eventually(() => tagRow(name).count(), 1, "left panel: row present");
    const box = await tagRow(name).boundingBox();
    const panel = await t.leftPanel().boundingBox();
    check(box.x + box.width <= panel.x + panel.width + 1, "left panel: the row stays inside the panel");
    equal(await t.overflow(), { x: 0, y: 0 }, "no page overflow");
    await t.closeToasts();
  });
  await reset();

  // ---------------------------------------------------------------------------------------------
  // BUG C-01 (same bug as for branches): a name the file system cannot hold is accepted by the
  // field; the error message then claims a lock and advises deleting .git/index.lock.
  await section(
    ["F14-E4b"],
    "Very long names (250 and 500 characters): nothing is created, and the message names the length as the reason",
    async () => {
      for (const length of [250, 500]) {
        const name = `lang-${"x".repeat(length - 5)}`;
        const dialog = await openTagDialog();
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
        const failed = await t.waitToast(/Create tag failed/, "danger", 20_000);
        check(/too long|length|characters/i.test(failed?.text ?? ""), `${length} characters: the message names the length of the name as the reason: ${failed?.text}`);
        check(!/index\.lock/.test(failed?.text ?? ""), `${length} characters: the message does NOT advise deleting .git/index.lock (there is no lock)`);
        if ((await t.dialogTitle()) !== null) await page.keyboard.press("Escape");
        await t.closeToasts();
      }
      equal(tags(repo), [], "git: no tag created");
    },
    { bug: "C-01" },
  );
  await reset();

  // ---------------------------------------------------------------------------------------------
  await section(["F14-E8", "F14-E9"], "Double Enter, double click and cancel: exactly one tag or none; Esc in “Delete?” keeps the tag", async () => {
    let dialog = await openTagDialog();
    await nameField(dialog).fill("doppelt-enter");
    await eventually(() => createButton(dialog).isDisabled(), false, "valid");
    await nameField(dialog).focus();
    await Promise.all([page.keyboard.press("Enter"), page.keyboard.press("Enter")]);
    await eventually(() => tags(repo), ["doppelt-enter"], "git: exactly one tag after double Enter");
    await sleep(1200);
    equal(await t.dialogTitle(), null, "no dialog open (any more or again)");
    await t.noErrorToast("the second Enter produces no error message (“already exists”)");
    await t.closeToasts();
    dialog = await openTagDialog();
    await nameField(dialog).fill("doppelt-klick");
    await eventually(() => createButton(dialog).isDisabled(), false, "valid");
    await createButton(dialog).dblclick();
    await eventually(() => tags(repo), ["doppelt-enter", "doppelt-klick"], "git: exactly one more tag after the double click");
    await sleep(1200);
    equal(await t.dialogTitle(), null, "no dialog open");
    await t.noErrorToast("the second click produces no error message");
    await t.closeToasts();
    // Cancel in three ways.
    for (const way of ["Escape", "Cancel", "Close"]) {
      dialog = await openTagDialog();
      await nameField(dialog).fill(`doch-nicht-${way.toLowerCase()}`);
      await dialog.getByLabel(/Annotation/).fill("wird verworfen");
      if (way === "Escape") await page.keyboard.press("Escape");
      else await dialog.getByRole("button", { name: way }).click();
      await t.noDialog(`“${way}” closes the dialog`);
    }
    await sleep(300);
    equal(tags(repo), ["doppelt-enter", "doppelt-klick"], "git: cancel creates no tag");
    equal(await t.toasts(), [], "cancel produces no message");
    dialog = await openTagDialog();
    equal([await nameField(dialog).inputValue(), await dialog.getByLabel(/Annotation/).inputValue()], ["", ""], "a new dialog starts empty");
    await page.keyboard.press("Escape");
    await t.noDialog();
    // Cancel deleting.
    await t.rightClickPick(tagRow("doppelt-klick"), /^Delete locally/);
    await t.waitDialog(/^Delete tag “doppelt-klick”\?$/);
    await page.keyboard.press("Escape");
    await t.noDialog();
    await sleep(300);
    equal(tags(repo), ["doppelt-enter", "doppelt-klick"], "git: Esc in the confirmation keeps the tag");
  });
  await reset();

  // ---------------------------------------------------------------------------------------------
  await section(["F14-E7"], "Changed from outside: a tag from the terminal appears on its own in the left panel and graph; deleted outside, it disappears", async () => {
    gitRaw(repo, ["tag", "-a", "aussen-1", "-m", "Im Terminal angelegt", second]);
    await eventually(() => tagRow("aussen-1").count(), 1, "the tag from the terminal appears in the left panel without any action", 25_000);
    await eventually(() => t.graphRowText(second), (text) => text.includes("aussen-1"), "… and as a label in the graph", 25_000);
    gitRaw(repo, ["tag", "-d", "aussen-1"]);
    await eventually(() => tagRow("aussen-1").count(), 0, "deleted outside: the row disappears on its own", 25_000);
    await eventually(() => t.graphRowText(second), (text) => !text.includes("aussen-1"), "… and the label in the graph too", 25_000);
    await t.noErrorToast("no error message");
  });
  await reset();

  // ---------------------------------------------------------------------------------------------
  await section(["F14-N3"], "Deleted ref: “push” on a tag that no longer exists outside – understandable message, the remote stays untouched", async () => {
    gitRaw(repo, ["tag", "gleich-weg"]);
    await t.refresh(repo.repoId);
    await eventually(() => tagRow("gleich-weg").count(), 1, "the tag is in the left panel");
    const held = await holdCore(page, "refsList");
    try {
      gitRaw(repo, ["tag", "-d", "gleich-weg"]);
      await t.rightClickPick(tagRow("gleich-weg"), /^Push to origin/);
      const failed = await t.waitToast(/tag|push/i, null, 60_000);
      check(failed?.tone === "danger" || failed?.tone === "warning", `the push reports that it failed (${failed?.tone}): ${failed?.text}`);
      check(/gleich-weg|doesn’t exist|does not exist|not found/i.test(failed?.text ?? ""), `the message says that the tag does not exist (anymore): ${failed?.text}`);
      check(!/fatal:|exit code|src refspec/i.test(failed?.text ?? ""), `… in its own words, not as raw Git output: ${failed?.text}`);
      equal(remoteTags(), [], "git (bare): nothing was created on the remote");
    } finally {
      await held.release();
    }
    await t.refresh(repo.repoId);
    await t.closeToasts();
  });
  await reset();

  // ---------------------------------------------------------------------------------------------
  await section(["F14-N1"], "Remote rejects: the remote already has the tag with a different target – understandable message, the remote's tag stays as it is", async () => {
    remoteGit(repo, "update-ref", "refs/tags/v3.0.0", root);
    const dialog = await openTagDialog();
    await nameField(dialog).fill("v3.0.0");
    await eventually(() => createButton(dialog).isDisabled(), false, "locally the name is free");
    await nameField(dialog).press("Enter");
    await t.waitToast(/Tag “v3\.0\.0” created/, "success");
    await t.closeToasts();
    await t.rightClickPick(tagRow("v3.0.0"), /^Push to origin/);
    const refused = await t.waitToast(/Tag/, "danger", 60_000);
    check(/rejected|already has|already exists/i.test(refused?.text ?? ""), `the message says that the remote rejected the tag: ${refused?.text}`);
    check(!/fatal:|exit code/i.test(refused?.text ?? ""), "… in its own words");
    equal(remoteTagTarget("v3.0.0"), root, "git (bare): the remote's tag still points to ITS commit – nothing was overwritten");
    equal(tagTarget("v3.0.0"), mainHead, "git: the local tag is unchanged");
    await t.closeToasts();
  });
  await reset();

  // ---------------------------------------------------------------------------------------------
  await section(["F14-N2"], "“Also delete on the remote” for a tag that was never pushed: deleted locally, no alarming error message", async () => {
    gitRaw(repo, ["tag", "nur-lokal"]);
    await t.refresh(repo.repoId);
    await t.rightClickPick(tagRow("nur-lokal"), /^Also delete on the remote/);
    const confirm = await t.waitDialog(/^Delete tag “nur-lokal” locally and on origin\?$/);
    await confirm.getByRole("button", { name: "Delete locally and on remote" }).click();
    await eventually(() => tags(repo), [], "git: the local tag is deleted", 60_000);
    await sleep(1500);
    const shown = await t.toasts();
    equal(shown.filter((toast) => toast.tone === "danger"), [], `no error message, although there was nothing to delete on the remote: ${JSON.stringify(shown)}`);
    check(shown.some((toast) => /deleted/.test(toast.text)), `the app confirms the deletion: ${JSON.stringify(shown)}`);
    equal(remoteTags(), [], "git (bare): the remote is untouched");
    await t.closeToasts();
  });
  await reset();

  // ---------------------------------------------------------------------------------------------
  await section(["F14-E10", "F14-E11"], "Slow network and offline during the tag push: progress visible or an understandable error; the local tag stays", async () => {
    gitRaw(repo, ["tag", "ueber-die-leitung"]);
    await t.refresh(repo.repoId);
    gitRaw(repo, ["config", "remote.origin.receivepack", "sleep 4; git-receive-pack"]);
    try {
      const started = Date.now();
      await t.rightClickPick(tagRow("ueber-die-leitung"), /^Push to origin/);
      await eventually(() => page.locator('footer [role="progressbar"]').count(), 1, "slow: the status bar shows the running tag push");
      equal(remoteTags(), [], "while the push is running, the tag is not on the remote yet");
      await t.waitToast(/pushed to origin/, "success", 60_000);
      check(Date.now() - started >= 3500, `the push really waited (${Date.now() - started} ms)`);
      equal(remoteTags(), ["ueber-die-leitung"], "git (bare): the tag has arrived");
      await eventually(() => page.locator('footer [role="progressbar"]').count(), 0, "the job has disappeared from the status bar");
    } finally {
      gitRaw(repo, ["config", "--unset", "remote.origin.receivepack"], { allowFail: true });
    }
    await t.closeToasts();
    gitRaw(repo, ["tag", "ins-funkloch"]);
    const good = gitRaw(repo, ["remote", "get-url", "origin"]);
    gitRaw(repo, ["remote", "set-url", "origin", `http://127.0.0.1:${closedPort}/marken.git`]);
    await t.refresh(repo.repoId);
    try {
      await t.rightClickPick(tagRow("ins-funkloch"), /^Push to origin/);
      const failed = await t.waitToast(/Push tag failed/, "danger", 90_000);
      check(/can’t be reached|cannot be reached|connection|network/i.test(failed?.text ?? ""), `offline: the message explains that the remote cannot be reached: ${failed?.text}`);
      check(tags(repo).includes("ins-funkloch"), "git: the local tag is intact");
      equal(await page.locator('footer [role="progressbar"]').count(), 0, "no job stays stuck");
    } finally {
      gitRaw(repo, ["remote", "set-url", "origin", good]);
    }
    await t.closeToasts();
    await t.refresh(repo.repoId);
  });
  await reset();

  // ---------------------------------------------------------------------------------------------
  await section(["F14-E16"], "No remote and several remotes: without a remote a hint with “Add remote”; with two the app asks where to", async () => {
    const lonely = t.made(make(() => makeEmptyRepo({ name: "ohne-remote-tags" })));
    gitRaw(lonely, ["add", "-A"]);
    lonely.git("commit", "-q", "-m", "Erster Commit");
    gitRaw(lonely, ["tag", "allein"]);
    await t.open(lonely);
    await tagRow("allein").click({ button: "right" });
    await t.menu().waitFor();
    const entries = await t.menuEntries();
    const pushEntry = entries.find((item) => /Push/.test(item.text));
    check(pushEntry?.disabled === true && /no remote set up/i.test(pushEntry.text), `without a remote “push” is disabled, with a reason: ${JSON.stringify(pushEntry)}`);
    const deleteRemote = entries.find((item) => /Also delete on the remote/.test(item.text));
    check(deleteRemote?.disabled === true, `… and so is “Also delete on the remote”: ${JSON.stringify(deleteRemote)}`);
    check(entries.some((item) => /^Delete locally/.test(item.text) && !item.disabled), "“Delete locally” stays possible");
    await t.closeMenu();
    equal(tags(lonely), ["allein"], "git: nothing changed");

    await t.open(repo);
    const mirror = path.join(repo.root, "spiegel.git");
    if (!fs.existsSync(mirror)) gitRaw(repo, ["clone", "-q", "--bare", repo.remotePath, mirror], { cwd: repo.root });
    gitRaw(repo, ["remote", "add", "spiegel", mirror]);
    gitRaw(repo, ["tag", "zwei-ziele"]);
    await t.refresh(repo.repoId);
    await tagRow("zwei-ziele").click({ button: "right" });
    await t.menu().waitFor();
    await t.menu().getByRole("menuitem", { name: /Push/ }).first().click();
    const choose = await t.waitDialog(/^Push to which remote\?$/);
    check((await choose.innerText()).includes("origin") && (await choose.innerText()).includes("spiegel"), "both remotes are offered");
    await choose.getByRole("button", { name: /^spiegel/ }).click();
    await t.waitToast(/Tag “zwei-ziele” pushed to spiegel/, "success", 60_000);
    equal(gitRaw(repo, ["--git-dir", mirror, "tag", "-l"]), "zwei-ziele", "git (bare, spiegel): the tag is on the chosen remote");
    equal(remoteTags(), [], "git (bare, origin): not on origin");
    await t.closeToasts();
    gitRaw(repo, ["remote", "remove", "spiegel"]);
    await page.evaluate((id) => window.__gc.queryClient.invalidateQueries({ queryKey: ["repo", id, "remotes"] }), repo.repoId);
  });
  await reset();

  // ---------------------------------------------------------------------------------------------
  await section(["F14-E13", "F14-E14"], "Minimum window 960×600 and screen reader: the tag dialog fits the window; roles, names, errors and hints are attached to the fields; axe without violations", async () => {
    await t.open(repo);
    await app.setSize(960, 600);
    try {
      await t.runCommand("tag.createAnnotated");
      const dialog = await t.waitDialog(/^Create annotated tag$/);
      const named = await dialog.evaluate((node) => ({ role: node.getAttribute("role"), name: document.getElementById(node.getAttribute("aria-labelledby") ?? "")?.textContent ?? null, described: Boolean(document.getElementById(node.getAttribute("aria-describedby") ?? "")?.textContent) }));
      equal(named, { role: "dialog", name: "Create annotated tag", described: true }, "the dialog has a role, name and description");
      equal(await page.getByRole("textbox", { name: "Name" }).count(), 1, "the “Name” field can be found by role and name");
      equal(await page.getByRole("textbox", { name: "Annotation" }).count(), 1, "the “Annotation” field too");
      const focus = await t.focused();
      check(focus.label === "Name", `the focus is in the “Name” field (${JSON.stringify(focus)})`);
      await page.keyboard.type(`auslieferung/${"sehr-langer-name-".repeat(5)}..`);
      await eventually(() => dialog.getByRole("alert").count(), 1, "the error is a role=alert");
      check((await t.focused()).visible, "the focus in the field is visible");
      const wired = await nameField(dialog).evaluate((input) => ({
        invalid: input.getAttribute("aria-invalid"),
        text: `${input.getAttribute("aria-describedby") ?? ""} ${input.getAttribute("aria-errormessage") ?? ""}`.split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? "").join(" "),
      }));
      equal(wired.invalid, "true", "aria-invalid on the name field");
      check(/\.\./.test(wired.text), `the error text is attached to the field: ${JSON.stringify(wired.text)}`);
      const hint = await dialog.getByLabel("Annotation").evaluate((area) => (area.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? "").join(" "));
      check(/needs a text/.test(hint), `the hint “needs a text” is attached to the annotation (aria-describedby): ${JSON.stringify(hint)}`);
      check(await t.inViewport(dialog), "960×600: the dialog lies fully inside the window");
      check(await t.inViewport(createButton(dialog)), "960×600: the buttons are visible");
      equal(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth), true, "960×600: the dialog does not overflow");
      equal(await t.overflow(), { x: 0, y: 0 }, "960×600: no page overflow");
      equal(await t.axe('[role="dialog"]'), [], "axe: no violations in the dialog");
      await page.keyboard.press("Escape");
      await t.noDialog();
    } finally {
      await app.setSize(1440, 900);
    }
    gitRaw(repo, ["tag", "-a", "v9", "-m", "Für den Screenreader"]);
    await t.refresh(repo.repoId);
    equal(await tagRow("v9").getAttribute("role"), "treeitem", "left panel: the tag row is a treeitem");
    equal(await tagRow("v9").getAttribute("aria-label"), "Tag v9, Für den Screenreader", "… with kind, name and annotation in its name");
    check(/Tags/.test((await t.leftPanel().locator('[data-section="tags"] [role="tree"]').getAttribute("aria-label")) ?? ""), "the tags tree has a name");
  });
  await reset();

  // ---------------------------------------------------------------------------------------------
  await section(["F14-E15"], "Restart the app mid-flow: open tag dialog and running tag push – afterwards no half tag, no lock, the push works", async () => {
    const dataDir = t.tempDataDir();
    const fresh = t.made(make(() => makeCleanRepoWithRemote({ name: "neustart-tags" })));
    const freshRemoteTags = () => lines(remoteGit(fresh, "for-each-ref", "--format=%(refname:short)", "refs/tags"));
    const main = t.app;
    let first = null;
    let again = null;
    const reopen = async () => {
      const started = await t.launch({ dataDir });
      const tab = (await started.invoke("tabs_list")).find((item) => item.kind === "repo");
      check(Boolean(tab), "after the restart the repository tab is back");
      if (tab && !tab.isActive) await started.invoke("tab_activate", { tabId: tab.id });
      await started.page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "tabs"] }));
      await started.settle().catch(() => undefined);
      return started;
    };
    try {
      first = await t.launch({ dataDir });
      await t.open(fresh);
      await t.runCommand("tag.create");
      const dialog = await t.waitDialog(/^Create tag$/);
      await dialog.getByLabel("Name").fill("halb-fertig");
      await first.close(); // the dialog is open with the name filled in
      again = await reopen();
      equal(tags(fresh), [], "git: the open dialog created no tag");
      equal(await t.dialogTitle(), null, "after the restart no dialog is open");
      // Create a tag and start a push that would take 40 seconds – then quit the app.
      gitRaw(fresh, ["tag", "-a", "v1", "-m", "Vor dem Neustart"]);
      await t.refresh((await again.invoke("tabs_list")).find((item) => item.kind === "repo").repoId);
      gitRaw(fresh, ["config", "remote.origin.receivepack", "sleep 40; git-receive-pack"]);
      await t.rightClickPick(t.leftRow("refs/tags/v1"), /^Push to origin/);
      await eventually(() => again.page.locator('footer [role="progressbar"]').count(), 1, "the tag push is running");
      await again.close();
      gitRaw(fresh, ["config", "--unset", "remote.origin.receivepack"]);
      again = await reopen();
      equal(tags(fresh), ["v1"], "git: the local tag is intact");
      equal(await again.page.locator('footer [role="progressbar"]').count(), 0, "after the restart no job is stuck in the status bar");
      await eventually(() => t.leftRow("refs/tags/v1").count(), 1, "the tag is in the left panel", 30_000);
      await t.rightClickPick(t.leftRow("refs/tags/v1"), /^Push to origin/);
      const done = await t.waitToast(/Tag “v1”/, null, 90_000);
      check(done?.tone === "success" || done?.tone === "info", `the push after the restart succeeds (or reports that the tag is already there): ${JSON.stringify(done)}`);
      equal(freshRemoteTags(), ["v1"], "git (bare): the tag is on the remote");
    } finally {
      await first?.close().catch(() => undefined);
      await again?.close().catch(() => undefined);
      t.attach(main);
    }
  });
} catch (error) {
  t.check(false, `Aborted outside a section: ${error?.stack ?? error}`);
  t.results.push({ ids: ["F14"], title: "Aborted outside a section",
 ok: false, bug: null, seconds: "0" });
}
await t.end();
