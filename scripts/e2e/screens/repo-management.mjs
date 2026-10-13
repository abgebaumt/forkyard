/**
 * repo-management – repository management in the real app, against real repositories.
 *
 *   node scripts/e2e/screens/repo-management.mjs            everything, with screenshots in target/e2e/shots/
 *   node scripts/e2e/screens/repo-management.mjs --show     visible window
 *
 * Checks: empty start, opening (keyboard only), folder without repository → offer → init,
 * missing folder, list sections, favorite/alias/color/group/remove (keyboard only, cross-checked
 * in the core and after a restart), moved folder, README preview including a malicious README
 * (nothing is executed or loaded), 200 entries with filter, long names, list loading and error,
 * both window sizes, both themes. Console errors fail the run.
 *
 * Only two things are simulated (not triggered for real): the loading and error state of the list
 * (core.repoList is delayed or fails in the page) and opening a README link in the system browser
 * (the confirmed link ends up in window.__gcTestOpened, no browser starts).
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { makeCleanRepoWithRemote, makeNotARepo, makeRichRepo } from "../fixtures.mjs";
import {
  addRepo,
  ageRepos,
  closeToasts,
  copyRepos,
  createChecks,
  dialogTitle,
  findRepo,
  finish,
  makeWorkspace,
  overflow,
  refreshRepos,
  repoList,
  showManagement,
  tabUntil,
  toasts,
} from "./repo-entry-lib.mjs";

const show = process.argv.includes("--show");
const { failures, check, equal, eventually, section } = createChecks();
const SHOTS = "target/e2e/shots";

const rich = makeRichRepo();
const clean = makeCleanRepoWithRemote();
const plain = makeNotARepo();
const ws = makeWorkspace("s01");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gc-s01-data-"));

// Counts every request: the malicious README only points here, none may ever arrive.
const hits = [];
const server = http.createServer((request, response) => {
  hits.push(request.url);
  response.end("x");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const evil = `http://127.0.0.1:${server.address().port}`;

const EVIL_README = `# Prüfstand

Absatz mit **fett** und \`code\`.

<script>window.__pwned = "script";</script>
<img src="x" onerror="window.__pwned = 'onerror'">
<img src="${evil}/roh.png" alt="Zähler">

![Diagramm](${evil}/markdown.png)
![Lokal](docs/bild.png)

[Skript-Link](javascript:window.__pwned='js-link')
<a href="javascript:window.__pwned='js-roh'">roh</a>
<a href="https://example.org/handbuch" target="_blank" onclick="window.__pwned='onclick'">Handbuch</a>
[Relativ](docs/aufbau.md)

<iframe src="${evil}/frame"></iframe>
<style>[data-screen] { display: none !important; }</style>
<link rel="stylesheet" href="${evil}/style.css">
<base href="${evil}/">
<meta http-equiv="refresh" content="0;url=${evil}/refresh">
<form action="${evil}/form"><input name="a" value="b"><button>Senden</button></form>
<svg onload="window.__pwned='svg'"><script>window.__pwned='svg-script'</script></svg>
<math><mtext><img src="${evil}/math.png"></mtext></math>
<video src="${evil}/film.mp4" autoplay onerror="window.__pwned='video'"></video>
<audio src="${evil}/ton.mp3" autoplay></audio>
<object data="${evil}/objekt"></object>
<embed src="${evil}/embed">
<details open ontoggle="window.__pwned='toggle'"><summary>Mehr</summary>Text im Detail</details>
<div style="background:url(${evil}/bg.png)" onmouseover="window.__pwned='mouse'">Kasten</div>
<table background="${evil}/tabelle.png"><tr><td>Zelle</td></tr></table>
<picture><source srcset="${evil}/quelle.png"><img src="${evil}/picture.png"></picture>

- [x] erledigt
- [ ] offen

| Spalte | Wert |
| --- | --- |
| a | 1 |
`;

let app = null;
let step = "start";

/** List rows as they are in the DOM. */
const rows = (page) =>
  page.locator('[data-screen="repo-management"] [role="option"]').evaluateAll((list) =>
    list.map((row) => ({
      id: row.getAttribute("data-repo-id"),
      label: row.getAttribute("aria-label"),
      selected: row.getAttribute("aria-selected") === "true",
      favorite: row.hasAttribute("data-favorite"),
      missing: row.hasAttribute("data-missing"),
      color: row.querySelector("[data-color]")?.getAttribute("data-color") ?? null,
    })),
  );
const sections = (page) => page.locator("[data-repo-section]").evaluateAll((list) => list.map((item) => item.textContent.trim()));
const rowOf = (page, id) => page.locator(`[data-repo-id="${id}"]`);
const focusedRepo = (page) => page.evaluate(() => document.activeElement?.getAttribute("data-repo-id") ?? null);
const activeTab = (page) => page.evaluate(() => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? null);
const press = async (page, keys) => {
  await page.keyboard.press(keys);
  await page.waitForTimeout(80);
};
const noErrors = (where) => check(app.consoleErrors.length === 0, `Console errors (${where}):\n${app.consoleErrors.join("\n")}`);

try {
  // =========================================================================
  // Part 1: flows
  // =========================================================================
  app = await launchApp({ show, dataDir });
  let { page } = app;

  await section("Empty start: three entry points, nothing else", async () => {
    step = "empty";
    await page.locator('[data-screen="repo-management"][data-state="empty"]').waitFor();
    equal(await page.locator('[data-screen="repo-management"] button').allInnerTexts(), ["Open …", "Clone …", "Create new …"], "the three entry points");
    check((await page.getByText("No repository yet").count()) === 1, "heading of the empty state");
    equal(await overflow(page), { x: 0, y: 0 }, "no overflow");
    await app.screenshot(`${SHOTS}/repo-management-empty.png`);
    noErrors("empty start");
  });

  await section("Open with the keyboard only: Tab to 'Open …', Enter", async () => {
    step = "open";
    await app.pick(rich.path);
    const steps = await tabUntil(page, () => document.activeElement?.textContent?.trim() === "Open …");
    check(steps >= 0, "'Open …' is reachable with Tab");
    await press(page, "Enter");
    await page.getByRole("tab", { name: /wetterstation/ }).waitFor();
    await eventually(() => activeTab(page).then((text) => /^wetterstation/.test(text ?? "")), true, "the 'wetterstation' tab is active");
    const entry = await findRepo(app, rich.path);
    check(entry !== null && entry.lastOpenedAt !== null, "the core lists the repository, with a timestamp");
    equal(await toasts(page), [], "no toast");
  });

  await section("Folder without repository → offer → init dialog", async () => {
    step = "no repository";
    await press(page, "Control+t");
    await page.locator('[data-screen="repo-management"]').waitFor();
    await app.settle();

    // 1. Non-empty folder: the offer appears, but the core refuses to create a repository there (path_exists).
    await app.pick(plain.path);
    await page.locator('[data-screen="repo-management"]').getByRole("button", { name: "Open …" }).click();
    const notice = page.locator('[data-notice="not_a_repo"]');
    await notice.waitFor();
    check((await notice.innerText()).includes("“kein-repository” is not a Git repository"), `notice names the folder: ${await notice.innerText()}`);
    check((await notice.innerText()).includes(plain.path), "notice shows the full path");
    equal(await toasts(page), [], "no extra toast");
    await app.screenshot(`${SHOTS}/repo-management-error.png`);
    await notice.getByRole("button", { name: "Create a repository here" }).click();
    const init = page.locator('[data-screen="init"]');
    await init.waitFor();
    equal(await init.getByLabel("Name", { exact: true }).inputValue(), "kein-repository", "name is prefilled");
    equal(await init.getByLabel("Location", { exact: true }).inputValue(), plain.root, "location is prefilled");
    await page.getByRole("button", { name: "Create repository" }).click();
    await eventually(() => init.getByLabel("Name", { exact: true }).getAttribute("aria-invalid"), "true", "a non-empty folder is rejected at the name field");
    check(/non-empty folder/.test(await init.innerText()), "the message explains that the folder is not empty");
    check(!fs.existsSync(path.join(plain.path, ".git")), "no .git was created in the folder");
    check(fs.existsSync(path.join(plain.path, "einkaufsliste.txt")), "the existing files are untouched");
    await press(page, "Escape");
    await init.waitFor({ state: "detached" });

    // 2. Empty folder: offer → init → the repository is created exactly there and opens.
    const empty = ws.dir("neues-vorhaben");
    await app.pick(empty);
    await page.locator('[data-screen="repo-management"]').getByRole("button", { name: "Open …" }).click();
    await page.locator('[data-notice="not_a_repo"]').getByRole("button", { name: "Create a repository here" }).click();
    await init.waitFor();
    equal(await init.getByLabel("Name", { exact: true }).inputValue(), "neues-vorhaben", "name of the empty folder");
    await press(page, "Enter");
    await page.getByRole("tab", { name: /neues-vorhaben/ }).waitFor();
    check(fs.existsSync(path.join(empty, ".git")), ".git is in the chosen folder");
    equal(ws.git(empty, "rev-list", "--count", "HEAD"), "1", "one first commit");
    equal(ws.git(empty, "log", "-1", "--format=%s"), "Initial commit", "message of the first commit");
    equal(ws.git(empty, "ls-files"), "README.md", "README.md is committed");
    await closeToasts(page);
  });

  await section("Folder that does not exist", async () => {
    step = "path missing";
    await press(page, "Control+t");
    await page.locator('[data-screen="repo-management"]').waitFor();
    const missing = ws.at("gibt-es-nicht");
    await app.pick(missing);
    await page.locator('[data-screen="repo-management"]').getByRole("button", { name: "Open …" }).click();
    const notice = page.locator('[data-notice="path_not_found"]');
    await notice.waitFor();
    check((await notice.innerText()).includes(missing), "notice names the path");
    check((await notice.getByRole("button", { name: "Choose another folder …" }).count()) === 1, "offer 'Choose another folder …'");
    await notice.getByRole("button", { name: "Dismiss notice" }).click();
    await notice.waitFor({ state: "detached" });
    equal(await toasts(page), [], "no toast");
  });

  // More entries through the core (as if they had been opened earlier).
  const tiny = ws.repo("vorlage", { "README.md": "# Vorlage\n\nKleines Repository zum Kopieren.\n" });
  const [garten, archiv, firmware, wegzug, ohneReadme] = copyRepos(tiny, ws.dir("Projekte"), ["schulgarten-bewässerung", "notizen-archiv-2025", "sensor-firmware", "klassenfahrt-planung", "ohne-readme"]);
  fs.rmSync(path.join(ohneReadme, "README.md"));
  const evilRepo = ws.repo("pruefstand", { "README.md": EVIL_README });
  const ids = {};

  await section("List: sections, order, row content", async () => {
    step = "list";
    ids.clean = (await addRepo(app, clean.path)).id;
    ids.garten = (await addRepo(app, garten)).id;
    ids.archiv = (await addRepo(app, archiv)).id;
    ids.firmware = (await addRepo(app, firmware)).id;
    ids.wegzug = (await addRepo(app, wegzug)).id;
    ids.ohneReadme = (await addRepo(app, ohneReadme)).id;
    ids.evil = (await addRepo(app, evilRepo)).id;
    ids.rich = (await findRepo(app, rich.path)).id;
    await ageRepos(app, [
      [rich.path, 5],
      [clean.path, 60 * 26],
      [garten, 60 * 3],
      [archiv, 60 * 24 * 4],
      [firmware, 60 * 24 * 40],
      [wegzug, 60 * 24 * 9],
      [ohneReadme, 60 * 24 * 2],
      [evilRepo, 60 * 24 * 3],
      [ws.at("neues-vorhaben"), 60 * 24 * 400],
    ]);
    await showManagement(app);
    await refreshRepos(app);
    equal(await sections(page), ["Recently opened9"], "one section, nine entries");
    const list = await rows(page);
    equal(list.map((row) => row.id).slice(0, 3), [ids.rich, ids.garten, ids.clean], "most recently opened first");
    check(list.filter((row) => row.selected).length === 1, "exactly one entry is selected");
    const first = rowOf(page, ids.rich);
    check((await first.innerText()).includes("5 minutes ago"), `relative date in the row: ${(await first.innerText()).replaceAll("\n", " | ")}`);
    check((await first.locator("[title]").evaluateAll((list, wanted) => list.some((item) => item.getAttribute("title") === wanted), rich.path)), "the full path is in the tooltip");
    check((await page.getByLabel("Filter repositories").count()) === 1, "from 8 entries on there is a filter field");
    equal(await page.locator("[data-repo-count]").innerText(), "9 repositories", "counter");
  });

  await section("Keyboard only: favorite, alias, color, remove, open", async () => {
    step = "keyboard";
    await closeToasts(page);
    // Focus back to the start of the page, then keys only.
    await page.evaluate(() => document.activeElement?.blur());
    const steps = await tabUntil(page, () => document.activeElement?.getAttribute("role") === "option");
    check(steps >= 0, "the list is reachable with Tab");
    equal(await focusedRepo(page), (await rows(page)).find((row) => row.selected)?.id, "focus is on the selected entry");
    await press(page, "Home");
    equal(await focusedRepo(page), ids.rich, "Home jumps to the first entry");
    check((await page.locator('[data-screen="repo-management"] [role="option"][tabindex="0"]').count()) === 1, "exactly one entry is reachable with Tab (roving tabindex)");

    await press(page, "ArrowDown");
    equal(await focusedRepo(page), ids.garten, "Arrow down moves to the next entry");
    await press(page, "End");
    equal((await rows(page)).at(-1).id, await focusedRepo(page), "End jumps to the last entry");
    await press(page, "Home");
    await press(page, "ArrowDown");
    await press(page, "ArrowDown");
    equal(await focusedRepo(page), ids.clean, "Home, Arrow down twice: third entry");

    // Favorite
    await press(page, "f");
    await eventually(async () => (await findRepo(app, clean.path)).isFavorite, true, "F sets the favorite in the core");
    await eventually(() => sections(page), ["Favorites1", "Recently opened8"], "the 'Favorites' section appears");
    equal(await focusedRepo(page), ids.clean, "focus stays on the entry");
    equal((await rows(page))[0].id, ids.clean, "the favorite is at the top");

    // Alias
    await press(page, "F2");
    await eventually(() => dialogTitle(page), "Set alias for “messnetz”", "F2 opens the alias dialog");
    await page.keyboard.type("Messnetz (Schulen)");
    await press(page, "Enter");
    await eventually(async () => (await findRepo(app, clean.path)).alias, "Messnetz (Schulen)", "the alias is in the core");
    await eventually(async () => (await rowOf(page, ids.clean).innerText()).includes("Messnetz (Schulen)"), true, "the row shows the alias");
    check((await rowOf(page, ids.clean).innerText()).includes("messnetz"), "the folder name stays visible next to it");
    await eventually(() => focusedRepo(page), ids.clean, "after the dialog focus is back on the entry");

    // Color via the context menu (Shift+F10)
    await press(page, "Shift+F10");
    let menuOpen = await page.locator('[role="menu"]').count();
    if (!menuOpen) {
      // Over CDP the shortcut does not fire a contextmenu event in every WebView2 version.
      await page.evaluate(() => document.activeElement.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 200, clientY: 300 })));
      menuOpen = await page.locator('[role="menu"]').count();
      console.log("  (note: Shift+F10 did not arrive over CDP; contextmenu was dispatched directly)");
    }
    await page.locator('[role="menu"]').waitFor();
    const items = await page.locator('[role="menu"] [role="menuitem"]').allInnerTexts();
    for (const wanted of ["Open", "Open in new tab", "Remove from favorites", "Change alias …", "Remove alias", "Assign group …", "Blue", "Olive", "Show in Explorer", "Remove from list"]) {
      check(items.some((item) => item.replace(/\n.*/s, "").trim() === wanted), `context menu contains '${wanted}' (${items.map((item) => item.split("\n")[0]).join(", ")})`);
    }
    await page.keyboard.type("Vio");
    // Typeahead moves the focus a moment later.
    await eventually(() => page.evaluate(() => document.activeElement?.textContent?.trim()), "Violet", "typeahead jumps to 'Violet'");
    await press(page, "Enter");
    await eventually(async () => (await findRepo(app, clean.path)).color, 5, "the color 'Violet' (5) is in the core");
    await eventually(async () => (await rows(page)).find((row) => row.id === ids.clean)?.color, "5", "the row carries the color mark");

    await eventually(() => focusedRepo(page), ids.clean, "after the menu focus is back on the entry");

    // Remove with confirmation: focus on 'Cancel', Enter cancels
    for (let count = 0; count < 3; count++) await press(page, "ArrowDown");
    equal(await focusedRepo(page), ids.ohneReadme, "Arrow down three times: 'ohne-readme'");
    await press(page, "Delete");
    await eventually(() => dialogTitle(page), "Remove “ohne-readme” from the list?", "Del asks for confirmation");
    check(/stays unchanged on disk/.test(await page.locator('[role="dialog"]').innerText()), "the confirmation says nothing is deleted on disk");
    equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Cancel", "focus is on 'Cancel'");
    await press(page, "Enter");
    await eventually(() => dialogTitle(page), null, "Enter closes the confirmation");
    check((await findRepo(app, ohneReadme)) !== null, "Enter on 'Cancel' removes nothing");
    await eventually(() => focusedRepo(page), ids.ohneReadme, "focus is back on the entry");
    // now for real
    await press(page, "Delete");
    await eventually(() => dialogTitle(page), "Remove “ohne-readme” from the list?", "Del asks again");
    await press(page, "Tab");
    equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Remove from list", "Tab moves to the confirm button");
    await press(page, "Enter");
    await eventually(async () => (await findRepo(app, ohneReadme)) === null, true, "the entry is gone from the core");
    check(fs.existsSync(path.join(ohneReadme, ".git")), "the folder is unchanged on disk");
    await eventually(async () => (await rows(page)).some((row) => row.id === ids.ohneReadme), false, "the row is gone");
    await eventually(async () => (await focusedRepo(page)) !== null, true, "focus is on a neighbour, not lost");

    // Open with Enter
    await press(page, "ArrowUp");
    equal(await focusedRepo(page), ids.garten, "Arrow up: 'schulgarten-bewässerung'");
    await press(page, "Enter");
    await page.getByRole("tab", { name: /schulgarten-bewässerung/ }).waitFor();
    await eventually(() => activeTab(page).then((text) => /^schulgarten/.test(text ?? "")), true, "Enter opens the repository in the tab");
    equal(await page.locator('[data-screen="repo-management"]').count(), 0, "the management tab has become the repo tab");
    noErrors("keyboard");
  });

  await section("Open in new tab (Ctrl+Enter), groups", async () => {
    step = "groups";
    await press(page, "Control+t");
    await page.locator('[data-screen="repo-management"]').waitFor();
    await app.settle();
    const before = await page.locator('[role="tab"]').count();
    await rowOf(page, ids.archiv).focus();
    await press(page, "Control+Enter");
    await page.getByRole("tab", { name: /notizen-archiv-2025/ }).waitFor();
    equal(await page.locator('[role="tab"]').count(), before + 1, "Ctrl+Enter opens another tab; management stays");
    await showManagement(app);

    // Assign a group via the context menu (mouse)
    await rowOf(page, ids.firmware).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Assign group …" }).click();
    await eventually(() => dialogTitle(page), "Group for “sensor-firmware”", "group dialog");
    await page.keyboard.type("Technik");
    await press(page, "Enter");
    await eventually(async () => (await findRepo(app, firmware)).groupName, "Technik", "the group is in the core");
    await app.invoke("repo_update", { repoId: ids.garten, groupName: "Schule" });
    await app.invoke("repo_update", { repoId: ids.wegzug, groupName: "Schule" });
    await refreshRepos(app);
    const toggle = page.locator('[aria-label="List arrangement"]');
    await toggle.waitFor();
    check((await rowOf(page, ids.firmware).innerText()).includes("Technik"), "the group is shown as a badge on the row");
    await toggle.getByText("Groups", { exact: true }).click();
    await eventually(() => sections(page), ["Favorites1", "Schule2", "Technik1", "No group4"], "arranged by groups");
    check(!(await rowOf(page, ids.firmware).innerText()).includes("Technik"), "in the group view the group is only in the heading");
    await toggle.getByText("Recent", { exact: true }).click();
    await eventually(() => sections(page), ["Favorites1", "Recently opened7"], "back to arrangement by date");
  });

  await section("Folder moved: marker on the row, new location", async () => {
    step = "moved";
    const moved = ws.at("Projekte", "klassenfahrt-2026");
    fs.renameSync(wegzug, moved);
    await app.invoke("repo_update", { repoId: ids.wegzug, alias: "Klassenfahrt", color: 3 });
    await refreshRepos(app);
    const row = rowOf(page, ids.wegzug);
    await eventually(() => row.getAttribute("data-missing"), "true", "the row is marked as missing");
    check((await row.innerText()).includes("Folder not found"), "'Folder not found' is shown as text, not just as color");
    for (const name of ["Choose new location …", "Remove from list"]) check((await row.getByRole("button", { name }).count()) === 1, `action '${name}' on the row`);
    await app.screenshot(`${SHOTS}/repo-management-missing.png`);

    // Enter asks what to do; the first choice is 'Choose new location …'
    await row.focus();
    await press(page, "Enter");
    await eventually(() => dialogTitle(page), "The folder of “Klassenfahrt” was not found", "Enter on the missing entry asks");
    await app.pick(moved);
    await press(page, "Enter");
    await page.getByRole("tab", { name: /Klassenfahrt/ }).waitFor();
    const relocated = await findRepo(app, moved);
    check(relocated !== null, "the entry points to the new location");
    equal([relocated?.alias, relocated?.color, relocated?.groupName, relocated?.missing], ["Klassenfahrt", 3, "Schule", false], "alias, color and group came along");
    check((await findRepo(app, wegzug)) === null, "the old entry is gone");
    await closeToasts(page);
    await showManagement(app);
  });

  await section("README preview: content, no README, external link", async () => {
    step = "README";
    const preview = page.getByRole("complementary", { name: "README preview" });
    await rowOf(page, ids.rich).focus();
    await eventually(() => preview.getByRole("heading", { level: 2 }).first().innerText(), "README – wetterstation", "preview header");
    await preview.locator("[data-readme] h1").first().waitFor();
    equal(await preview.locator("[data-readme] h1").first().innerText(), "Wetterstation-Auswertung", "the README is rendered with a heading");
    check((await preview.locator("[data-readme] code").count()) > 0, "code is set as code");

    // A repository without a README
    const bare = ws.repo("ohne-liesmich", { "notiz.txt": "nur eine Notiz\n" });
    const entry = await addRepo(app, bare);
    await refreshRepos(app);
    await rowOf(page, entry.id).focus();
    await preview.locator("[data-readme-none]").waitFor();
    check((await preview.innerText()).includes("No README"), "calm notice when there is no README");
    await app.screenshot(`${SHOTS}/repo-management-no-readme.png`);
  });

  await section("Malicious README: nothing is executed or loaded", async () => {
    step = "malicious";
    const preview = page.getByRole("complementary", { name: "README preview" });
    const requests = [];
    const onRequest = (request) => {
      if (request.url().startsWith(evil) || /example\.org/.test(request.url())) requests.push(request.url());
    };
    page.on("request", onRequest);
    const urlBefore = page.url();
    await rowOf(page, ids.evil).focus();
    await preview.locator("[data-readme] h1").filter({ hasText: "Prüfstand" }).waitFor();
    await page.waitForTimeout(800);
    await app.screenshot(`${SHOTS}/repo-management-readme-untrusted.png`);

    const facts = await preview.locator("[data-readme]").evaluate((root) => ({
      pwned: window.__pwned ?? null,
      forbidden: Array.from(root.querySelectorAll("script,iframe,frame,style,link,base,meta,form,input,button,svg,math,video,audio,object,embed,source,picture")).map((node) => node.tagName),
      images: Array.from(root.querySelectorAll("img")).map((node) => node.getAttribute("src")),
      handlers: Array.from(root.querySelectorAll("*")).flatMap((node) => Array.from(node.attributes).filter((attribute) => /^on/i.test(attribute.name) || attribute.name === "style" || attribute.name === "background").map((attribute) => `${node.tagName}.${attribute.name}`)),
      hrefs: Array.from(root.querySelectorAll("[href],[src],[srcset],[action]")).map((node) => node.outerHTML.slice(0, 80)),
      placeholders: Array.from(root.querySelectorAll("[data-readme-image]")).map((node) => `${node.getAttribute("data-readme-image")}:${node.textContent}`),
      links: Array.from(root.querySelectorAll("a")).map((node) => ({ text: node.textContent, target: node.getAttribute("data-href"), inert: node.hasAttribute("data-inert") })),
      tasks: Array.from(root.querySelectorAll("[data-readme-task]")).map((node) => node.getAttribute("data-readme-task")),
      screenVisible: document.querySelector('[data-screen="repo-management"]').getBoundingClientRect().width > 0,
      text: root.textContent,
    }));
    equal(facts.pwned, null, "no script and no event attribute ran");
    equal(facts.forbidden, [], "no scripts, frames, styles, forms, media in the DOM");
    equal(facts.images, [], "no <img> with a foreign source in the DOM");
    equal(facts.handlers, [], "no on*, style or background attributes");
    equal(facts.hrefs, [], "no element with href, src, srcset or action");
    check(facts.placeholders.includes("remote:Image: Zähler") && facts.placeholders.includes("remote:Image: Diagramm") && facts.placeholders.includes("local:Image: Lokal"), `images are placeholders: ${JSON.stringify(facts.placeholders)}`);
    equal(
      facts.links.map((link) => [link.text, link.target, link.inert]),
      [
        ["Skript-Link", null, true],
        ["roh", null, true],
        ["Handbuch", "https://example.org/handbuch", false],
        ["Relativ", null, true],
      ],
      "only the https link has a target; javascript: links are dead",
    );
    equal(facts.tasks, ["done", "open"], "task list as symbols, not as form fields");
    check(facts.screenVisible, "the injected <style> did not hide the page");
    check(!/__pwned/.test(facts.text), "script text does not appear as text in the preview");
    check((await preview.locator("[data-readme-note]").innerText()).includes("images not loaded"), "the preview says that images were not loaded");

    // Click on the dead link: nothing happens.
    await preview.locator("[data-readme] a", { hasText: "Skript-Link" }).click();
    await page.waitForTimeout(200);
    equal(await dialogTitle(page), null, "a javascript: link opens nothing");

    // The https link asks first; in the test it ends up in window.__gcTestOpened instead of the system browser.
    await page.evaluate(() => {
      window.__gcTestOpened = [];
    });
    await preview.locator("[data-readme] a", { hasText: "Handbuch" }).click();
    await eventually(() => dialogTitle(page), "Open link outside the app?", "the link asks first");
    check((await page.locator('[role="dialog"]').innerText()).includes("https://example.org/handbuch"), "the confirmation shows the target");
    await press(page, "Enter");
    await eventually(() => dialogTitle(page), null, "Enter cancels (focus on 'Cancel')");
    equal(await page.evaluate(() => window.__gcTestOpened.length), 0, "nothing opens without confirmation");
    // by keyboard: focus the link, Enter, confirm
    await preview.locator("[data-readme] a", { hasText: "Handbuch" }).focus();
    await press(page, "Enter");
    await eventually(() => dialogTitle(page), "Open link outside the app?", "Enter on the link asks first");
    await page.getByRole("button", { name: "Open link" }).click();
    await eventually(() => page.evaluate(() => window.__gcTestOpened), ["https://example.org/handbuch"], "after confirmation exactly this link is handed to the system");
    await page.evaluate(() => {
      delete window.__gcTestOpened;
    });

    equal(page.url(), urlBefore, "the app did not navigate");
    equal(requests, [], "the page requested nothing from the foreign addresses");
    equal(hits, [], "not a single request reached the probe server");
    page.off("request", onRequest);
    noErrors("malicious README");
  });

  await section("Restart: favorite, alias, color, group and removal are saved", async () => {
    step = "restart";
    await app.close();
    app = await launchApp({ show, dataDir });
    page = app.page;
    await showManagement(app);
    const list = await repoList(app);
    const messnetz = list.find((repo) => repo.path.toLowerCase() === clean.path.toLowerCase());
    equal([messnetz?.isFavorite, messnetz?.alias, messnetz?.color], [true, "Messnetz (Schulen)", 5], "favorite, alias and color after the restart");
    equal(list.find((repo) => repo.path.toLowerCase() === firmware.toLowerCase())?.groupName, "Technik", "group after the restart");
    check(!list.some((repo) => repo.path.toLowerCase() === ohneReadme.toLowerCase()), "the removed entry stays removed");
    await page.locator(`[data-repo-id="${messnetz.id}"]`).waitFor();
    const row = (await rows(page)).find((item) => item.id === messnetz.id);
    equal([row?.favorite, row?.color], [true, "5"], "the row shows star and color");
    check((await page.locator(`[data-repo-id="${messnetz.id}"]`).innerText()).includes("Messnetz (Schulen)"), "the row shows the alias");
  });

  await section("Many entries (200+): virtualized, filter, long names", async () => {
    step = "many";
    const longName = "messreihen-archiv-der-wetterstation-nord-mit-allen-rohdaten2"; // 60 characters
    equal(longName.length, 60, "length of the long name");
    const deep = ws.dir("Ablage", "Schule und Verein", "Arbeitsgemeinschaft Wetter und Klima 2025-2026", "Auswertungen der Messstationen");
    const names = Array.from({ length: 200 }, (_, index) => `station-${String(index + 1).padStart(3, "0")}`);
    const paths = copyRepos(tiny, ws.dir("Viele"), names);
    const [longRepo] = copyRepos(tiny, deep, [longName]);
    const started = Date.now();
    const all = [...paths, longRepo];
    for (let offset = 0; offset < all.length; offset += 8) await Promise.all(all.slice(offset, offset + 8).map((repoPath) => addRepo(app, repoPath)));
    console.log(`  (201 repositories added through the core in ${Date.now() - started} ms)`);
    await ageRepos(app, [...paths.map((repoPath, index) => [repoPath, 60 * (index + 2)]), [longRepo, 30]]);
    await showManagement(app);
    await refreshRepos(app);
    const total = (await repoList(app)).length;
    check(total >= 208, `the core lists ${total} entries`);
    equal(await page.locator("[data-repo-count]").innerText(), `${total} repositories`, "counter");
    const rendered = await page.locator('[data-screen="repo-management"] [role="option"]').count();
    check(rendered > 5 && rendered < 60, `only a slice is in the DOM (${rendered} of ${total} rows)`);
    equal(await overflow(page), { x: 0, y: 0 }, "no page overflow");
    await app.screenshot(`${SHOTS}/repo-management-many.png`);

    // End: last entry, focus stays in the list
    await page.locator('[data-screen="repo-management"] [role="option"][tabindex="0"]').focus();
    await press(page, "End");
    await eventually(async () => (await page.evaluate(() => document.activeElement?.getAttribute("aria-posinset"))) === String(total), true, "End jumps to the last entry");
    await press(page, "Home");
    await eventually(() => page.evaluate(() => document.activeElement?.getAttribute("aria-posinset")), "1", "Home jumps to the first");
    await press(page, "PageDown");
    check(Number(await page.evaluate(() => document.activeElement?.getAttribute("aria-posinset"))) > 5, "PgDn pages down");

    // A long name and a long path break nothing
    const longEntry = await findRepo(app, longRepo);
    await page.getByLabel("Filter repositories").fill("rohdaten");
    await page.locator(`[data-repo-id="${longEntry.id}"]`).waitFor();
    equal(await page.locator("[data-repo-count]").innerText(), `1 of ${total}`, "counter while filtering");
    const fit = await page.locator(`[data-repo-id="${longEntry.id}"]`).evaluate((row) => ({
      overflow: row.scrollWidth - row.clientWidth,
      inside: row.getBoundingClientRect().right <= row.closest("[data-repo-scroll]").getBoundingClientRect().right + 1,
      height: row.getBoundingClientRect().height,
      titles: Array.from(row.querySelectorAll("[title]")).map((node) => node.getAttribute("title")),
    }));
    equal([fit.overflow <= 0, fit.inside, fit.height], [true, true, 44], "the row with a 60-character name keeps its width and height");
    check(fit.titles.includes(longName) && fit.titles.includes(longRepo), "full name and full path are in the tooltip");
    await app.screenshot(`${SHOTS}/repo-management-long.png`);

    // Filter: several words, no match, Esc clears, Arrow down moves into the list, Enter opens
    await page.getByLabel("Filter repositories").fill("VIELE station-19");
    await eventually(() => page.locator("[data-repo-count]").innerText(), `10 of ${total}`, "two words narrow it down, case-insensitive (station-190 … 199)");
    await page.getByLabel("Filter repositories").fill("gibt es bestimmt nicht");
    await page.locator("[data-list-nomatch]").waitFor();
    check((await page.locator("[data-list-nomatch]").innerText()).includes("No match"), "empty state 'No match'");
    await app.screenshot(`${SHOTS}/repo-management-no-match.png`);
    await press(page, "Escape");
    await eventually(() => page.getByLabel("Filter repositories").inputValue(), "", "Esc clears the filter");
    equal(await page.locator("[data-repo-count]").innerText(), `${total} repositories`, "all entries back");
    await page.getByLabel("Filter repositories").fill("station-137");
    await press(page, "ArrowDown");
    await eventually(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label")?.startsWith("station-137")), true, "Arrow down in the filter moves into the list");
    await press(page, "Enter");
    await page.getByRole("tab", { name: /station-137/ }).waitFor();
    await showManagement(app);
    noErrors("many entries");
  });

  await section("List loading and error (simulated in the window)", async () => {
    step = "loading/error";
    // window.__TAURI_INTERNALS__.invoke is read-only; core.repoList can be overridden instead.
    await page.evaluate(() => {
      const core = window.__gc.core;
      const real = core.repoList;
      window.__listMode = "slow";
      core.repoList = async () => {
        if (window.__listMode === "fail") throw Object.assign(new Error("The app database couldn't be read."), { code: "io", gitOutput: null });
        if (window.__listMode === "slow") await new Promise((resolve) => setTimeout(resolve, 2500));
        return real();
      };
      window.__restoreRepoList = () => {
        delete core.repoList;
      };
      void window.__gc.queryClient.resetQueries({ queryKey: ["app", "repos"] });
    });
    await page.locator('[data-screen="repo-management"][data-state="loading"]').waitFor();
    check((await page.getByRole("status", { name: "Loading repositories" }).count()) === 1, "skeleton rows instead of a spinner");
    check((await page.locator('[data-screen="repo-management"]').getByRole("button", { name: "Open …" }).isEnabled()), "the entry points stay usable while loading");
    await app.screenshot(`${SHOTS}/repo-management-loading.png`);
    await page.locator('[data-screen="repo-management"][data-state="ready"]').waitFor();

    await page.evaluate(() => {
      window.__listMode = "fail";
      void window.__gc.queryClient.resetQueries({ queryKey: ["app", "repos"] });
    });
    const error = page.locator("[data-list-error]");
    await error.waitFor();
    check((await error.innerText()).includes("The list couldn't be loaded"), "error state with heading");
    check((await error.innerText()).includes("The app database couldn't be read."), "the reason is shown");
    await app.screenshot(`${SHOTS}/repo-management-list-error.png`);
    await page.evaluate(() => {
      window.__listMode = "ok";
    });
    await error.getByRole("button", { name: "Try again" }).click();
    await page.locator('[data-screen="repo-management"][data-state="ready"]').waitFor();
    check((await page.locator('[data-screen="repo-management"] [role="option"]').count()) > 5, "'Try again' loads the list");
    await page.evaluate(() => window.__restoreRepoList());
    // The simulated error is a rejected promise inside the query, not a console error.
    noErrors("loading/error");
  });

  await section("Narrow window 960×600", async () => {
    step = "960";
    await app.setSize(960, 600);
    await page.waitForTimeout(250);
    equal(await overflow(page), { x: 0, y: 0 }, "no overflow");
    check(!(await page.getByRole("complementary", { name: "README preview" }).isVisible()), "the README preview gives way");
    const buttons = await page.locator('[data-screen="repo-management"] header button').evaluateAll((list) => list.map((button) => button.getBoundingClientRect()).every((rect) => rect.left >= 0 && rect.right <= window.innerWidth));
    check(buttons, "the three entry points fit");
    check((await page.locator('[data-screen="repo-management"] [role="option"]').count()) > 3, "the list is visible");
    await app.setSize(1440, 900);
    await page.waitForTimeout(200);
    check(await page.getByRole("complementary", { name: "README preview" }).isVisible(), "at 1440×900 the preview is back");
  });

  noErrors("part 1");
  await app.close();
  app = null;

  // =========================================================================
  // Part 2: screenshots of the main state (tidy list, believable data)
  // =========================================================================
  await section("Screenshots: dark, light, 960×600", async () => {
    step = "screenshots";
    app = await launchApp({ show, width: 1440, height: 900, theme: "dark" });
    page = app.page;
    const [a, b, c, d, e, f] = copyRepos(tiny, ws.dir("Bilder"), ["schulgarten-bewässerung", "notizen-archiv-2025", "sensor-firmware", "klassenfahrt-planung", "homepage-der-ag", "logger-auslesen"]);
    await addRepo(app, rich.path, { isFavorite: true, color: 1 });
    await addRepo(app, clean.path, { isFavorite: true, alias: "Messnetz (Schulen)", color: 2 });
    await addRepo(app, a, { groupName: "Schule", color: 3 });
    await addRepo(app, b);
    await addRepo(app, c, { groupName: "Technik", color: 7 });
    await addRepo(app, d, { groupName: "Schule" });
    await addRepo(app, e, { groupName: "Schule", color: 5 });
    await addRepo(app, f, { groupName: "Technik" });
    fs.renameSync(d, `${d}-verschoben`);
    await showManagement(app);
    await ageRepos(app, [
      [rich.path, 12],
      [clean.path, 60 * 26],
      [a, 60 * 3],
      [b, 60 * 24 * 4],
      [c, 60 * 24 * 40],
      [d, 60 * 24 * 9],
      [e, 60 * 24 * 2],
      [f, 60 * 24 * 70],
    ]);
    const first = (await rows(page))[0];
    await rowOf(page, first.id).focus();
    await page.locator("[data-readme] h1").first().waitFor();
    await page.waitForTimeout(300);
    equal(await overflow(page), { x: 0, y: 0 }, "no overflow (dark)");
    await app.screenshot(`${SHOTS}/repo-management.png`);
    await app.setTheme("light");
    await page.waitForTimeout(250);
    await app.screenshot(`${SHOTS}/repo-management-light.png`);
    await app.setTheme("dark");
    await app.setSize(960, 600);
    await page.waitForTimeout(250);
    equal(await overflow(page), { x: 0, y: 0 }, "no overflow (960×600)");
    await app.screenshot(`${SHOTS}/repo-management-min.png`);
    await app.setSize(1440, 900);
    // Context menu for the screenshot
    await rowOf(page, first.id).click({ button: "right" });
    await page.locator('[role="menu"]').waitFor();
    await page.waitForTimeout(200);
    await app.screenshot(`${SHOTS}/repo-management-menu.png`);
    await press(page, "Escape");
    noErrors("screenshots");
  });
} catch (error) {
  failures.push(`Aborted at '${step}': ${error?.stack ?? error}`);
  console.error(error?.stack ?? error);
} finally {
  if (failures.length && app) await app.screenshot("target/e2e/repo-management-failure.png").catch(() => undefined);
  await app?.close();
  server.close();
  rich.cleanup();
  clean.cleanup();
  plain.cleanup();
  ws.cleanup();
  fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}
finish("repo-management", failures, "target/e2e/repo-management-failure.png");
