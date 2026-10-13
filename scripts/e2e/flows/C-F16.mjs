/**
 * F16 – Search commits: the cases no other script covered yet – plus the date displays (time zones,
 * daylight saving time, midnight, relative dates) shown on the matches, in the graph and in the commit
 * details. In the real app, against real Git repositories; the matches are compared with `git log` in
 * the same repository.
 *
 *   node scripts/e2e/flows/C-F16.mjs                 everything
 *   node scripts/e2e/flows/C-F16.mjs --only F16-E9   only sections whose title or case ID contains the text
 *   node scripts/e2e/flows/C-F16.mjs --show          visible window
 *
 * Already covered elsewhere: the whole flow with the keyboard only, message / author / SHA prefix,
 * umlauts, special characters, no matches, errors, “loading”, Esc, 960×600, more than 200 matches, matches
 * far back in history (screens/commit-search.mjs, screens/keyboard.mjs).
 */
import fs from "node:fs";
import path from "node:path";
import { makeCleanRepoWithRemote, makeEmptyRepo, makeLargeRepo } from "../fixtures.mjs";
import { commit, createFlow, gitRaw, head, lines, make, sleep } from "./C-lib.mjs";

const t = createFlow("C-F16");
const { check, equal, eventually, section } = t;
const BAR = '[data-screen="commit-search"]';
const clean = (text) => String(text ?? "").replace(/[  ]/g, " ");

try {
  const app = await t.launch();
  const { page } = app;
  const repo = await t.open(t.made(make(() => makeCleanRepoWithRemote({ name: "suche" }))));

  const bar = page.locator(BAR);
  const input = page.getByRole("combobox", { name: "Search commits" });
  const options = bar.locator('[role="option"]');
  const hitShas = () => options.evaluateAll((rows) => rows.map((row) => row.dataset.sha));
  const counter = () => bar.locator('[data-testid="search-counter"]').innerText();
  const searchState = (tabId = repo.tabId) => page.evaluate((id) => window.__gc.store.getState().views[id]?.search ?? null, tabId);
  const searchOpen = (tabId = repo.tabId) => page.evaluate((id) => window.__gc.store.getState().views[id]?.searchOpen ?? false, tabId);
  const openSearch = async () => {
    await t.blur();
    await page.keyboard.press("Control+f");
    await input.waitFor();
    await eventually(() => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? null), "Search commits", "Ctrl+F: the focus is in the search field");
  };
  const closeSearch = async () => {
    if ((await bar.count()) > 0) {
      await input.focus();
      await page.keyboard.press("Escape");
      await eventually(() => bar.count(), 0, "Esc closes the search");
    }
  };
  /** Types a new search text (replaces the old one). */
  const search = async (text) => {
    await input.focus();
    await page.keyboard.press("Control+a");
    if (text) await page.keyboard.insertText(text);
    else await page.keyboard.press("Delete");
  };
  /** What git finds: message or author across all branches, remote branches, tags and HEAD. */
  const gitSearch = (text) => {
    const scope = ["--branches", "--remotes", "--tags", "HEAD"];
    const byMessage = lines(gitRaw(repo, ["log", "--format=%H", "-i", "-F", `--grep=${text}`, ...scope]));
    const byAuthor = lines(gitRaw(repo, ["log", "--format=%H", "-i", "-F", `--author=${text}`, ...scope]));
    return [...new Set([...byMessage, ...byAuthor])].sort();
  };

  // Commits for the search: emoji, umlauts, an author with special characters.
  const emojiSha = commit(repo, "regen.txt", "1\n", "Regenmesser 🌧️ neu geeicht (Größe der Öffnung geprüft)");
  const zoeSha = commit(repo, "zoe.txt", "1\n", "Übergabe an die Nachmittagsgruppe", { name: "Zoë Müller-Lüdenscheidt", email: "zoe.mueller@wetterstation.example" });
  await t.refresh(repo.repoId);

  // ---------------------------------------------------------------------------------------------
  await section(["F16-E2", "F16-E3"], "Empty input, only spaces and 500 characters: no error, no overflow, the search stays usable", async () => {
    await openSearch();
    equal(await bar.locator('[data-testid="search-hint"]').count(), 1, "empty: the hint is shown");
    const before = await t.selection(repo.tabId);
    await page.keyboard.press("Enter");
    await sleep(300);
    equal(await t.selection(repo.tabId), before, "Enter in the empty field does nothing");
    await search("     ");
    await sleep(900);
    equal(await options.count(), 0, "only spaces: no match rows");
    equal((await bar.getByRole("alert").count()) + (await t.dangerToasts()).length, 0, "only spaces: no error");
    check((await bar.locator('[data-testid="search-hint"]').count()) === 1 || /No matches/.test(await counter()), "only spaces counts as an empty search (hint) or gives “No matches”");
    const long = `Auswertung ${"der Messreihen aller Stationen im ersten Quartal ".repeat(11)}`.slice(0, 500);
    equal(long.length, 500, "the search text has 500 characters");
    await search(long);
    await bar.locator('[data-testid="search-empty"]').waitFor({ timeout: 15_000 });
    equal(await counter(), "No matches", "500 characters: “No matches”");
    equal(await input.inputValue(), long, "the field holds all 500 characters");
    const overflowing = await page.evaluate((css) => {
      const element = document.querySelector(css);
      return { page: document.documentElement.scrollWidth - document.documentElement.clientWidth, bar: element.scrollWidth - element.clientWidth };
    }, BAR);
    equal(overflowing, { page: 0, bar: 0 }, "500 characters: neither the page nor the bar overflows");
    check(await t.inViewport(bar), "the bar lies fully inside the window");
    await t.noErrorToast("no error toast");
    await search("Stationen");
    await options.first().waitFor();
    equal((await hitShas()).sort(), gitSearch("Stationen"), "afterwards a normal search again finds what git finds");
    await closeSearch();
  });

  // ---------------------------------------------------------------------------------------------
  await section(["F16-E4"], "Emoji and umlauts – in message and author, also in different case", async () => {
    await openSearch();
    await search("🌧️");
    await eventually(hitShas, [emojiSha], "an emoji as search text finds the commit");
    check((await options.first().innerText()).includes("🌧️"), "the match row shows the emoji");
    await search("größe der öffnung");
    await eventually(hitShas, [emojiSha], "lower-case umlauts find “Größe der Öffnung”");
    await search("Zoë");
    await eventually(hitShas, [zoeSha], "author with ë");
    await search("müller-lüdenscheidt");
    await eventually(hitShas, [zoeSha], "author in lower case with umlauts");
    await search("ÜBERGABE");
    await eventually(hitShas, [zoeSha], "UPPER case: “ÜBERGABE” finds “Übergabe” (case does not matter, not even for umlauts)");
    await t.noErrorToast("no error toast");
    await closeSearch();
  });

  // ---------------------------------------------------------------------------------------------
  await section(["F16-E12"], "Full SHA, email address, choosing a match: Enter shows the commit in the graph and in the details", async () => {
    await openSearch();
    await search(zoeSha);
    await eventually(hitShas, [zoeSha], "the full SHA (40 characters) finds exactly the commit");
    await search(`  ${zoeSha.slice(0, 12).toUpperCase()}  `);
    await eventually(hitShas, [zoeSha], "so does an upper-case SHA prefix surrounded by spaces");
    await search("zoe.mueller@wetterstation.example");
    await eventually(hitShas, [zoeSha], "the author's email address finds their commit");
    await page.keyboard.press("Enter");
    await eventually(() => t.selection(repo.tabId), { kind: "commits", shas: [zoeSha] }, "Enter selects the match");
    equal(await t.graphRow(zoeSha).getAttribute("aria-selected"), "true", "graph: the match's row is selected");
    check(await t.inViewport(t.graphRow(zoeSha)), "graph: the row is visible");
    await page.locator(`[data-screen="commit-details"] code[title="${zoeSha}"]`).waitFor({ timeout: 8000 });
    check((await page.locator('[data-screen="commit-details"]').innerText()).includes("Zoë Müller-Lüdenscheidt"), "details: the author is shown unaltered");
    await closeSearch();
  });

  // ---------------------------------------------------------------------------------------------
  await section(["F16-E13"], "Search text that looks like a Git option: searched literally – no file is created, no error", async () => {
    const pwn = path.join(repo.path, "gc-pwn.txt");
    await openSearch();
    for (const text of ["--output=gc-pwn.txt", "--all", "-n1", "--exec=notepad", "$(whoami)", "`whoami`", "a\\b", '"quote"', "%H%n"]) {
      await search(text);
      await bar.locator('[data-testid="search-empty"]').waitFor({ timeout: 15_000 });
      equal(await counter(), "No matches", `“${text}”: searched literally, no matches`);
    }
    check(!fs.existsSync(pwn), "no file gc-pwn.txt was created");
    equal(gitRaw(repo, ["status", "--porcelain"]), "", "git: the working directory is untouched");
    equal((await bar.getByRole("alert").count()) + (await t.dangerToasts()).length, 0, "no error");
    await closeSearch();
  });

  // ---------------------------------------------------------------------------------------------
  await section(["F16-E5"], "Changed from outside: a commit from the terminal appears in the open search on its own", async () => {
    await openSearch();
    await search("Wolkenhöhe");
    await bar.locator('[data-testid="search-empty"]').waitFor({ timeout: 15_000 });
    const sha = commit(repo, "wolken.txt", "1\n", "Wolkenhöhe aus dem Terminal nachgetragen");
    await eventually(hitShas, [sha], "the new commit appears in the match list without any action", 25_000);
    equal(await counter(), "1 match", "the counter follows");
    gitRaw(repo, ["reset", "-q", "--hard", "HEAD~1"]);
    await eventually(() => options.count(), 0, "after a reset in the terminal the match disappears on its own", 25_000);
    await t.noErrorToast("no error");
    await closeSearch();
  });

  // ---------------------------------------------------------------------------------------------
  await section(["F16-E15"], "Match on a branch hidden in the graph: is found; Enter shows the details instead of jumping into nowhere", async () => {
    const hiddenSha = gitRaw(repo, ["rev-parse", "feature/export"]);
    await t.rightClickPick(t.leftRow("refs/heads/feature/export"), /Hide in graph/i);
    // The remote branch also points to the commit: hide both so the row really drops out of the graph.
    await t.rightClickPick(t.leftRow("refs/remotes/origin/feature/export"), /Hide in graph/i);
    await eventually(() => t.graphRow(hiddenSha).count(), 0, "the commit of the hidden branch is no longer in the graph");
    await openSearch();
    await search("CSV-Export");
    await eventually(hitShas, [hiddenSha], "the search still finds the commit");
    await page.keyboard.press("Enter");
    await eventually(() => t.selection(repo.tabId), { kind: "commits", shas: [hiddenSha] }, "Enter selects it");
    await page.locator(`[data-screen="commit-details"] code[title="${hiddenSha}"]`).waitFor({ timeout: 8000 });
    check(true, "the details show the commit");
    await t.noErrorToast("no error");
    const said = `${await bar.innerText()} ${JSON.stringify(await t.toasts())} ${await t.graph().innerText().catch(() => "")}`;
    console.log(`    hint about the hidden branch: ${/hidden/i.test(said) ? "yes" : "no"}`);
    await closeSearch();
    await t.rightClickPick(t.leftRow("refs/heads/feature/export"), /Show in graph/i);
    await t.rightClickPick(t.leftRow("refs/remotes/origin/feature/export"), /Show in graph/i);
    await eventually(() => t.graphRow(hiddenSha).count(), 1, "shown again");
  });

  // ---------------------------------------------------------------------------------------------
  await section(["F16-E17"], "Two tabs: the search belongs to the tab – search text and matches of one do not appear in the other", async () => {
    const other = t.made(make(() => makeEmptyRepo({ name: "suche-leer" })));
    await openSearch();
    await search("Stationen");
    await options.first().waitFor();
    const hits = await hitShas();
    const opened = await app.openRepo(other.path);
    equal(await bar.count(), 0, "no search is open in the second tab");
    equal(await searchOpen(opened.tabId), false, "store: searchOpen of the second tab is off");
    // Empty repository: open the search, type – no error.
    await t.blur();
    await page.keyboard.press("Control+f");
    const appeared = await t.until(() => bar.count(), 1, 4000);
    if (appeared.ok) {
      await page.keyboard.insertText("irgendwas");
      await bar.locator('[data-testid="search-empty"]').waitFor({ timeout: 15_000 });
      equal(await counter(), "No matches", "empty repository: “No matches” instead of an error");
      equal((await bar.getByRole("alert").count()) + (await t.dangerToasts()).length, 0, "empty repository: no error");
      await page.keyboard.press("Escape");
    } else {
      check((await t.toolState("Search")).disabled, "empty repository: the search is disabled (with a reason on the button)");
    }
    await app.invoke("tab_activate", { tabId: repo.tabId });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "tabs"] }));
    await page.getByRole("tab", { name: /^suche(?!-leer)/, selected: true }).waitFor();
    await eventually(searchOpen, true, "back in the first tab the search is still open");
    await input.waitFor();
    equal(await input.inputValue(), "Stationen", "the search text is still there");
    await eventually(hitShas, hits, "and the same matches");
    await closeSearch();
    await app.invoke("tab_close", { tabId: opened.tabId });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "tabs"] }));
    await app.settle();
  });

  // ---------------------------------------------------------------------------------------------
  await section(["F16-E11"], "Screen reader: search field as a combobox with list, active match and announced counter; buttons with names; axe without violations", async () => {
    await openSearch();
    await search("Stationen");
    await options.first().waitFor();
    const field = await input.evaluate((element) => ({
      role: element.getAttribute("role"),
      expanded: element.getAttribute("aria-expanded"),
      controls: Boolean(document.getElementById(element.getAttribute("aria-controls") ?? "")),
      listRole: document.getElementById(element.getAttribute("aria-controls") ?? "")?.getAttribute("role") ?? null,
      autocomplete: element.getAttribute("aria-autocomplete"),
    }));
    equal({ role: field.role, expanded: field.expanded, controls: field.controls, listRole: field.listRole }, { role: "combobox", expanded: "true", controls: true, listRole: "listbox" }, "combobox with aria-expanded and aria-controls pointing to a listbox");
    await page.keyboard.press("ArrowDown");
    const active = await input.evaluate((element) => {
      const option = document.getElementById(element.getAttribute("aria-activedescendant") ?? "");
      return option ? { role: option.getAttribute("role"), selected: option.getAttribute("aria-selected"), named: (option.getAttribute("aria-label") ?? option.textContent ?? "").trim().length > 10 } : null;
    });
    equal(active, { role: "option", selected: "true", named: true }, "arrow down: aria-activedescendant points to the highlighted option");
    const live = await bar.locator('[data-testid="search-counter"]').evaluate((element) => element.getAttribute("aria-live") ?? element.closest("[aria-live]")?.getAttribute("aria-live") ?? element.getAttribute("role") ?? element.closest('[role="status"]')?.getAttribute("role") ?? null);
    check(live === "polite" || live === "status" || live === "assertive", `the counter (“2 matches”) is announced (aria-live / role=status): ${live}`);
    for (const name of ["Previous match", "Next match", "Close search"]) equal(await bar.getByRole("button", { name }).count(), 1, `button “${name}” has a name`);
    check((await t.focused()).visible, "the focus in the search field is visible");
    equal(await t.axe(BAR), [], "axe: no violations in the search bar");
    await search("gibtesnichtxyz");
    await bar.locator('[data-testid="search-empty"]').waitFor();
    equal(await t.axe(BAR), [], "axe: no violations in the “No matches” state");
    await closeSearch();
  });

  // ---------------------------------------------------------------------------------------------
  // Dates: the app shows times in the machine's time zone. Expected is what the machine itself
  // outputs for the same instant (Intl in the test process, same time zone and locale as the app).
  const local = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });
  const iso = (date) => {
    const pad = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  const dateCell = (sha) => t.graphRow(sha).locator('[data-cell="date"]');
  const setDateFormat = async (format) => {
    await app.invoke("settings_set", { patch: { dateFormat: format } });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "settings"] }));
    await app.settle();
  };

  await section(["F16-E9a"], "Date in graph, match list and details: other time zones, DST change, just before and after midnight – always the machine's time, the author's time in the tooltip", async () => {
    const stamps = [
      ["Tokyo late evening", "2026-06-15T23:30:00+09:00"],
      ["Los Angeles evening", "2026-01-10T20:15:00-08:00"],
      ["Just before summer time", "2026-03-29T01:30:00+01:00"],
      ["Just after summer time", "2026-03-29T03:30:00+02:00"],
      ["Repeated hour, summer time", "2026-10-25T02:30:00+02:00"],
      ["Repeated hour, winter time", "2026-10-25T02:30:00+01:00"],
      ["Just before midnight", "2026-08-31T23:59:30+02:00"],
      ["Just after midnight", "2026-09-01T00:00:30+02:00"],
      ["India, half hour", "2026-07-04T12:00:00+05:30"],
    ];
    const made = stamps.map(([title, date], index) => ({ title, date, when: new Date(date), sha: commit(repo, `zeit-${index}.txt`, `${index}\n`, `Time probe: ${title}`, { date }) }));
    await t.refresh(repo.repoId);
    await setDateFormat("local");
    for (const item of made) {
      await eventually(() => dateCell(item.sha).innerText().then(clean), clean(local.format(item.when)), `graph, format “local” – ${item.title} (${item.date}): the machine's time`);
      const title = clean(await dateCell(item.sha).getAttribute("title"));
      // The instant in UTC is shown readably (“Jun 15, 2026, 2:30 PM UTC”), no longer as a raw ISO timestamp (BUG-089).
      const utc = `${clean(new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(item.when))} UTC`;
      check(title.includes(utc), `graph tooltip – ${item.title}: names the instant in UTC (“${utc}” in “${title}”)`);
    }
    // The two commits of the repeated hour have the same local time but are one hour apart: the tooltip tells them apart.
    const [summer, winter] = [made[4], made[5]];
    check(clean(await dateCell(summer.sha).getAttribute("title")) !== clean(await dateCell(winter.sha).getAttribute("title")), "repeated hour on Oct 25: the tooltips of the two commits differ (UTC time)");
    await setDateFormat("iso");
    for (const item of made) await eventually(() => dateCell(item.sha).innerText().then(clean), iso(item.when), `graph, format “ISO” – ${item.title}: ${iso(item.when)}`);
    // Match list and details.
    await openSearch();
    await search("Time probe: Los Angeles");
    await eventually(hitShas, [made[1].sha], "the search finds the commit from Los Angeles");
    check(clean(await options.first().getAttribute("title")).includes(clean(local.format(made[1].when))), `match list: the tooltip names the machine's time (${clean(await options.first().getAttribute("title"))})`);
    await page.keyboard.press("Enter");
    const time = page.locator('[data-screen="commit-details"] time').first();
    await time.waitFor({ timeout: 8000 });
    equal(Date.parse((await time.getAttribute("datetime")) ?? ""), made[1].when.getTime(), `details: <time datetime> carries exactly this instant (${await time.getAttribute("datetime")})`);
    check(/8:15\s?PM/.test((await time.getAttribute("data-original")) ?? "") && /Jan 10/.test((await time.getAttribute("data-original")) ?? ""), `details: the author's time (Jan 10, 8:15 PM in their zone) is in the tooltip: ${await time.getAttribute("data-original")}`);
    await closeSearch();
    await setDateFormat("relative");
    // Order in the graph: by instant, not by the author's local time.
    equal(head(repo), made.at(-1).sha, "git: the last commit is HEAD");
  });

  // ---------------------------------------------------------------------------------------------
  // BUG C-09: relative dates count in 24-hour blocks instead of calendar days: a commit from
  // today 00:20 is called “yesterday” at 23:30, one from yesterday 01:00 is called “2 days ago”.
  await section(
    ["F16-E9b"],
    "Relative dates around midnight (app clock fixed at 23:30): “yesterday” and “2 days ago” mean calendar days",
    async () => {
      const at = (day, hour, minute) => new Date(2026, 9, day, hour, minute, 0);
      const now = at(12, 23, 30);
      const stamp = (date) => `${Math.floor(date.getTime() / 1000)} +0000`;
      const probes = [
        { title: "20 minutes ago", when: at(12, 23, 10), expected: /^20 minutes ago$/ },
        { title: "today 00:20 (23 hours ago, same calendar day)", when: at(12, 0, 20), expected: /^(today|23 hours ago)$/ },
        { title: "yesterday 23:50 (23 hours 40 minutes ago)", when: at(11, 23, 50), expected: /^(yesterday|24 hours ago)$/ },
        { title: "yesterday 01:00 (46 hours ago)", when: at(11, 1, 0), expected: /^yesterday$/ },
        { title: "2 days ago 23:00", when: at(10, 23, 0), expected: /^2 days ago$/ },
      ];
      for (const [index, probe] of probes.entries()) probe.sha = commit(repo, `relativ-${index}.txt`, `${index}\n`, `Relative: ${probe.title}`, { date: stamp(probe.when) });
      await page.clock.setFixedTime(now);
      try {
        await app.reload();
        await app.settle();
        await eventually(() => page.evaluate(() => new Date().getHours() * 100 + new Date().getMinutes()), 2330, "the app clock is at 23:30");
        await t.graphRow(probes[0].sha).waitFor({ timeout: 20_000 });
        const shown = {};
        for (const probe of probes) shown[probe.title] = clean(await dateCell(probe.sha).innerText());
        console.log(`    shown at 23:30: ${JSON.stringify(shown)}`);
        await t.shot("target/e2e/bugs/C-09.png");
        for (const probe of probes) check(probe.expected.test(shown[probe.title]), `${probe.title}: expected ${probe.expected}, shown “${shown[probe.title]}”`);
      } finally {
        await page.clock.resume().catch(() => undefined);
        await page.clock.setSystemTime(new Date()).catch(() => undefined);
      }
    },
    { bug: "C-09" },
  );

  // ---------------------------------------------------------------------------------------------
  await section(["F16-E8"], "Restart the app with the search open: starts without errors; the search can be used again right away", async () => {
    const dataDir = t.tempDataDir();
    const fresh = t.made(make(() => makeCleanRepoWithRemote({ name: "neustart-suche" })));
    const main = t.app;
    let first = null;
    let again = null;
    try {
      first = await t.launch({ dataDir });
      await t.open(fresh);
      await first.page.keyboard.press("Control+f");
      await first.page.getByRole("combobox", { name: "Search commits" }).waitFor();
      await first.page.keyboard.insertText("Stationen");
      await first.page.locator(`${BAR} [role="option"]`).first().waitFor();
      await first.page.keyboard.press("Enter");
      await first.close();
      again = await t.launch({ dataDir });
      const tab = (await again.invoke("tabs_list")).find((item) => item.kind === "repo");
      check(Boolean(tab), "after the restart the repository tab is back");
      if (tab && !tab.isActive) await again.invoke("tab_activate", { tabId: tab.id });
      await again.page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "tabs"] }));
      await again.settle();
      equal(again.consoleErrors, [], "no console errors at startup");
      await again.page.locator("[data-graph-scroller] [role=row]").first().waitFor({ timeout: 20_000 });
      await t.blur();
      await again.page.keyboard.press("Control+f");
      const field = again.page.getByRole("combobox", { name: "Search commits" });
      await field.waitFor();
      await again.page.keyboard.press("Control+a");
      await again.page.keyboard.insertText("Vergleich");
      await again.page.locator(`${BAR} [role="option"]`).first().waitFor({ timeout: 15_000 });
      const want = lines(gitRaw(fresh, ["log", "--format=%H", "-i", "-F", "--grep=Vergleich", "--branches", "--remotes", "--tags", "HEAD"])).sort();
      equal((await again.page.locator(`${BAR} [role="option"]`).evaluateAll((rows) => rows.map((row) => row.dataset.sha))).sort(), want, "the search after the restart finds what git finds");
    } finally {
      await first?.close().catch(() => undefined);
      await again?.close().catch(() => undefined);
      t.attach(main);
    }
  });

  // ---------------------------------------------------------------------------------------------
  await section(["F16-E1"], "Commit beyond the loaded limit (50,000 commits): Enter on the match loads more of the graph – via “Keep searching” if needed – and shows the row", async () => {
    const large = t.made(make(() => makeLargeRepo()));
    const opened = await app.openRepo(large.path);
    await page.locator("[data-graph-scroller] [role=row]").nth(3).waitFor({ timeout: 60_000 });
    // Messages disappear on their own after a few seconds: record every one that appears.
    await page.evaluate(() => {
      window.__cToasts = [];
      new MutationObserver(() => {
        for (const element of document.querySelectorAll("[data-toast]")) {
          const text = element.innerText.replace(/\s+/g, " ").trim();
          if (!window.__cToasts.includes(text)) window.__cToasts.push(text);
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    const loaded = () => page.evaluate((id) => window.__gc.queryClient.getQueryData(["repo", id, "graph"])?.pages?.reduce((sum, item) => sum + item.rows.length, 0) ?? null, opened.repoId);
    await t.blur();
    await page.keyboard.press("Control+f");
    await input.waitFor();
    console.log(`    loaded graph rows before the search: ${await loaded()}`);
    // One match just past the limit and one at the very beginning of history.
    for (const [label, text] of [["just past the limit", "(#47000)"], ["at the beginning of history", "(#17)"]]) {
      const expected = lines(gitRaw(large, ["log", "--format=%H", "-F", `--grep=${text}`, "--all"]));
      equal(expected.length, 1, `git knows exactly one commit with “${text}”`);
      const position = Number(gitRaw(large, ["rev-list", "--count", `${expected[0]}..main`]));
      check(position > 2000, `${label}: the commit lies beyond the loaded limit (${position} commits from the tip)`);
      await search(text);
      await eventually(hitShas, expected, `${label}: the search finds it across the whole history`, 60_000);
      const row = page.locator(`[data-graph-scroller] [role="row"][data-row-id="${expected[0]}"]`);
      equal(await row.count(), 0, `${label}: before the jump its row is not in the graph (not loaded)`);
      await page.keyboard.press("Enter");
      await eventually(() => t.selection(opened.tabId), { kind: "commits", shas: expected }, `${label}: Enter selects it`);
      await page.locator(`[data-screen="commit-details"] code[title="${expected[0]}"]`).waitFor({ timeout: 8000 });
      // The graph loads in stages; after each stage a message offers “Keep searching”.
      let rounds = 0;
      const deadline = Date.now() + 150_000;
      while ((await row.count()) === 0 && Date.now() < deadline) {
        const more = page.locator("[data-toast]").getByRole("button", { name: "Keep searching" });
        if ((await more.count()) > 0) {
          rounds += 1;
          await more.first().click({ timeout: 3000 }).catch(() => undefined);
        }
        await sleep(150);
      }
      const seen = await page.evaluate(() => window.__cToasts.slice());
      console.log(`    ${label}: match ${position} rows deep, loaded: ${await loaded()} rows, “Keep searching” ${rounds > 0 ? "used" : "not needed"}`);
      check((await row.count()) === 1, `${label}: the graph loaded up to the match and shows its row (messages on the way: ${JSON.stringify(seen.slice(-3))})`);
      if (rounds > 0) check(seen.some((entry) => /is further back/.test(entry) && /isn’t among the .* loaded commits/.test(entry)), "the message between the stages explains why the commit is not visible yet");
      if ((await row.count()) === 1) {
        await eventually(() => t.inViewport(row), true, `${label}: the row lies in the visible area`);
        equal(await row.getAttribute("aria-selected"), "true", `${label}: and is selected`);
      }
      await t.closeToasts();
    }
    await page.keyboard.press("Escape");
  });
} catch (error) {
  t.check(false, `Aborted outside a section: ${error?.stack ?? error}`);
  t.results.push({ ids: ["F16"], title: "Aborted outside a section",
 ok: false, bug: null, seconds: "0" });
}
await t.end();
