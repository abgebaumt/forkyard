/**
 * F15 – Find out who changed a line (blame, file history): cases not covered by other scripts –
 * above all time zones, daylight saving time and relative dates, names with umlauts and emoji,
 * changes from outside.
 *
 *   node scripts/e2e/flows/D-F15.mjs                    everything
 *   node scripts/e2e/flows/D-F15.mjs --only F15-E3      only sections whose ID or title contains this (comma separates several)
 *   node scripts/e2e/flows/D-F15.mjs --show             visible window
 *
 * At the end there is the list of green and red sections. A red section with "BUG D-xx" is the test
 * that the reported bug is fixed against.
 */
import fs from "node:fs";
import path from "node:path";
import { makeCleanRepoWithRemote } from "../fixtures.mjs";
import { commit, commitAt, createFlow, gitRaw, head, lines, sleep } from "./D-lib.mjs";

const t = createFlow("D-F15");
const { check, equal, eventually } = t;

const JONAS = { name: "Jonas Albrecht", email: "jonas.albrecht@wetterstation.example" };
const MATS = { name: "Mats Öztürk", email: "mats.oeztuerk@wetterstation.example" };
const pad = (n) => String(n).padStart(2, "0");
/** Local time of this machine as "YYYY-MM-DD HH:mm" (how the app shows the "ISO" date format). */
const isoLocal = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
/** Like isoLocal, but with an explicit offset – as a date for git. */
const gitLocal = (d) => {
  const offset = -d.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
};
const enDateTime = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" });

/** Commits with different time zones, around midnight and around the DST switch (Europe/Berlin 2026-03-29 and 2025-10-26). */
const ZONES = [
  { key: "repeated hour, summer time", date: "2025-10-26T02:30:00+02:00", zone: "UTC+02:00", clock: "02:30" },
  { key: "repeated hour, winter time", date: "2025-10-26T02:30:00+01:00", zone: "UTC+01:00", clock: "02:30" },
  { key: "just before midnight", date: "2026-03-28T23:59:30+01:00", zone: "UTC+01:00", clock: "23:59" },
  { key: "just after midnight", date: "2026-03-29T00:00:30+01:00", zone: "UTC+01:00", clock: "00:00" },
  { key: "minute before the switch", date: "2026-03-29T01:59:00+01:00", zone: "UTC+01:00", clock: "01:59" },
  { key: "right after the switch", date: "2026-03-29T03:00:30+02:00", zone: "UTC+02:00", clock: "03:00" },
  { key: "Tokyo", date: "2026-03-30T08:15:00+09:00", zone: "UTC+09:00", clock: "08:15" },
  { key: "Pacific (already the next day here)", date: "2026-03-29T18:30:00-08:00", zone: "UTC−08:00", clock: "18:30" },
  { key: "Nepal (+05:45)", date: "2026-03-30T10:00:00+05:45", zone: "UTC+05:45", clock: "10:00" },
  { key: "Newfoundland (−03:30)", date: "2026-03-30T10:00:00-03:30", zone: "UTC−03:30", clock: "10:00" },
];

await t.launch();
const page = t.page;
const press = (key) => page.keyboard.press(key);
const fileHistoryScreen = () => page.locator('[data-screen="file-history"]');
const blameScreen = () => page.locator('[data-screen="blame"]');
const historyRows = () =>
  fileHistoryScreen()
    .locator('[data-history-list] [role="option"]')
    .evaluateAll((items) => items.map((item) => ({ sha: item.dataset.sha, path: item.dataset.path, label: item.getAttribute("aria-label") ?? "", text: item.innerText.replace(/\s+/g, " ").trim(), titles: Array.from(item.querySelectorAll("[title]")).map((part) => part.getAttribute("title")) })));
const historyReady = async (file) => {
  await page.waitForFunction((label) => document.querySelector('[data-screen="file-history"]')?.getAttribute("aria-label") === label && !document.querySelector('[data-screen="file-history"] [data-loading]'), `History of ${file}`, { timeout: 30_000 });
  await t.app.settle();
};
const openHistory = async (repo, file) => {
  await t.store("openHistory", repo.tabId, file);
  await historyReady(file);
};
const blameReady = async (file) => {
  await page.waitForFunction(
    (label) => {
      const root = document.querySelector('[data-screen="blame"]');
      return root?.getAttribute("aria-label") === label && !root.querySelector("[data-loading]") && Boolean(root.querySelector(".cm-content, [data-notice]"));
    },
    `Blame of ${file}`,
    { timeout: 30_000 },
  );
  await t.app.settle();
};
const openBlame = async (repo, file) => {
  await t.store("openBlame", repo.tabId, file, null);
  await blameReady(file);
};
const blameBlocks = () => blameScreen().locator(".gc-blame-cell[data-start]").evaluateAll((cells) => cells.map((cell) => ({ sha: cell.dataset.sha, uncommitted: cell.hasAttribute("data-uncommitted"), date: cell.querySelector(".gc-blame-date")?.textContent ?? "", summary: cell.querySelector(".gc-blame-summary")?.textContent ?? "" })));
/** git blame --porcelain: SHA per line. */
const blameShas = (repo, file) => lines(gitRaw(repo, ["blame", "--porcelain", "--", file])).filter((line) => /^[0-9a-f]{40} \d+ \d+/.test(line)).map((line) => line.slice(0, 40));
const blocksOf = (shas) => shas.filter((sha, index) => index === 0 || shas[index - 1] !== sha);
const followLog = (repo, file) => lines(gitRaw(repo, ["-c", "core.quotepath=false", "log", "--follow", "--format=%H", "--", file]));

// ---------------------------------------------------------------------------------------------
await t.section("F15-E3", "Time zones and DST: commit details, history and graph show local time correctly and give the author's time with time zone", async () => {
  const repo = t.made(makeCleanRepoWithRemote({ name: "f15-e3" }));
  let text = "";
  for (const zone of ZONES) {
    text += `${zone.key}\n`;
    zone.sha = commitAt(repo, "zeiten.txt", text, `Time probe: ${zone.key}`, zone.date);
    zone.instant = Date.parse(zone.date);
    equal(Number(gitRaw(repo, ["log", "-1", "--format=%at", zone.sha])) * 1000, Math.floor(zone.instant / 1000) * 1000, `git: the instant of "${zone.key}" is stored as given`);
  }
  await t.open(repo);
  equal(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone), Intl.DateTimeFormat().resolvedOptions().timeZone, "the app computes in this machine's time zone");
  console.log(`    (machine time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone})`);
  await t.app.invoke("settings_set", { patch: { dateFormat: "iso" } });
  await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "settings"] }));
  try {
    const time = page.locator("time[data-original]").first();
    for (const zone of ZONES) {
      await t.store("selectCommits", repo.tabId, [zone.sha]);
      const ok = await eventually(async () => Date.parse((await time.getAttribute("datetime")) ?? ""), Math.floor(zone.instant / 1000) * 1000, `${zone.key}: the details give the commit instant`);
      if (!ok) continue;
      await eventually(() => time.innerText(), isoLocal(zone.instant), `${zone.key}: local time in ISO format`);
      const original = (await time.getAttribute("data-original")) ?? "";
      check(original.endsWith(`(${zone.zone})`) && original.includes(zone.clock), `${zone.key}: the tooltip gives the author's time "${zone.clock}" with "${zone.zone}" (got "${original}")`);
      // Graph: the row's date column shows the same local time, its tooltip the long form.
      const row = await t.graphRow(zone.sha).evaluate((element) => ({ text: element.innerText.replace(/\s+/g, " "), titles: Array.from(element.querySelectorAll("[title]")).map((part) => part.getAttribute("title")) }));
      check(row.text.includes(isoLocal(zone.instant)), `${zone.key}: the graph shows the local time (${row.text})`);
      check(row.titles.some((title) => (title ?? "").startsWith(enDateTime.format(new Date(zone.instant)))), `${zone.key}: the graph tooltip gives "${enDateTime.format(new Date(zone.instant))}" (${JSON.stringify(row.titles)})`);
    }
    // The repeated hour: "02:30" twice on the author's clock, but one hour apart.
    const [summer, winter] = ZONES;
    equal(winter.instant - summer.instant, 3_600_000, "the two commits of the repeated hour are one hour apart");
    // Order in the graph: by instant, not by the author's clock time.
    const order = await page.locator('[data-screen="commit-graph"] [data-row-id]').evaluateAll((rows) => rows.map((row) => row.getAttribute("data-row-id")));
    const shown = order.filter((sha) => ZONES.some((zone) => zone.sha === sha));
    equal(shown, [...ZONES].reverse().map((zone) => zone.sha), "the graph orders the commits like git (newest on top)");

    // History: the same commits, tooltip with local time.
    await openHistory(repo, "zeiten.txt");
    const rows = await historyRows();
    equal(rows.map((row) => row.sha), followLog(repo, "zeiten.txt"), "history: commits and order as in git log --follow");
    for (const zone of ZONES) {
      const row = rows.find((item) => item.sha === zone.sha);
      const expected = enDateTime.format(new Date(zone.instant));
      check(Boolean(row) && row.titles.includes(expected), `history, ${zone.key}: the tooltip gives the local time "${expected}" (${JSON.stringify(row?.titles)})`);
    }
  } finally {
    await t.app.invoke("settings_set", { patch: { dateFormat: "relative" } });
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries({ queryKey: ["app", "settings"] }));
    await t.store("closeCenter", repo.tabId).catch(() => undefined);
  }
});

// ---------------------------------------------------------------------------------------------
/** Repository with commits whose age is fixed at run time (for relative dates). */
function relativeRepo(name) {
  const repo = t.made(makeCleanRepoWithRemote({ name }));
  const now = new Date();
  const at = (ms) => gitLocal(new Date(ms));
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  repo.cases = {
    vorgestern: { date: at(dayStart - 24 * 3600_000 - 5 * 60_000) }, // day before yesterday 23:55
    gestern: { date: at(dayStart - 24 * 3600_000 + 5 * 60_000) }, // yesterday 00:05
    stunden: { date: at(now.getTime() - 3 * 3600_000) },
    minuten: { date: at(now.getTime() - 5 * 60_000) },
    zukunft: { date: at(now.getTime() + 2 * 3600_000) },
  };
  let text = "";
  for (const [key, entry] of Object.entries(repo.cases)) {
    text += `${key}\n`;
    entry.sha = commitAt(repo, "relativ.txt", text, `Relativ: ${key}`, entry.date);
  }
  repo.now = now;
  return repo;
}
const relativeOf = (rows, sha) => rows.find((row) => row.sha === sha)?.label ?? "";

await t.section("F15-E3b", "Relative dates: minutes, hours and a commit dated in the future (author's clock runs fast)", async () => {
  const repo = await t.open(relativeRepo("f15-e3b"));
  await openHistory(repo, "relativ.txt");
  const rows = await historyRows();
  equal(rows.length, 5, "five commits in the history");
  check(/[567] minutes ago/.test(relativeOf(rows, repo.cases.minuten.sha)), `five minutes old: "5 minutes ago" (${relativeOf(rows, repo.cases.minuten.sha)})`);
  check(/3 hours ago/.test(relativeOf(rows, repo.cases.stunden.sha)), `three hours old: "3 hours ago" (${relativeOf(rows, repo.cases.stunden.sha)})`);
  const future = relativeOf(rows, repo.cases.zukunft.sha);
  check(/in 2 hours|in 1 hour|in \d+ minutes/.test(future) && !/ ago/.test(future.split(",").slice(-2).join(",")), `two hours in the future: recognisable as future, not as "… ago" (${future})`);
  // Blame of the same file: every line carries the relative date of its commit.
  await openBlame(repo, "relativ.txt");
  const blocks = await blameBlocks();
  equal(blocks.map((block) => block.sha), Object.values(repo.cases).map((entry) => entry.sha), "blame: the right commit per line");
  check(/3 hours ago/.test(blocks[2]?.date ?? ""), `blame: the line of the three-hour-old commit shows "3 hours ago" (${blocks[2]?.date})`);
  await t.store("closeCenter", repo.tabId);
});

// BUG D-07: "yesterday" and "2 days ago" follow the number of elapsed hours (rounded to days), not the
// calendar day: a commit from yesterday 00:05 is called "2 days ago" in the afternoon, one from the day
// before yesterday 23:55 is called "yesterday" in the morning.
await t.section(
  "F15-E3c",
  "Relative dates follow the calendar day: yesterday 00:05 is \"yesterday\", the day before yesterday 23:55 is \"2 days ago\"",
  async () => {
    const repo = await t.open(relativeRepo("f15-e3c"));
    await openHistory(repo, "relativ.txt");
    const rows = await historyRows();
    const yesterday = relativeOf(rows, repo.cases.gestern.sha);
    const before = relativeOf(rows, repo.cases.vorgestern.sha);
    console.log(`    (now ${isoLocal(repo.now.getTime())}; commit from yesterday 00:05 → "${yesterday}"; commit from the day before yesterday 23:55 → "${before}")`);
    const okYesterday = /, yesterday,/.test(yesterday);
    const okBefore = /, 2 days ago,/.test(before);
    if (!okYesterday || !okBefore) await t.bugShot("D-07");
    check(okYesterday, `the commit from yesterday 00:05 (${repo.cases.gestern.date}) is called "yesterday" (got: ${yesterday})`);
    check(okBefore, `the commit from the day before yesterday 23:55 (${repo.cases.vorgestern.date}) is called "2 days ago" (got: ${before})`);
    await t.store("closeCenter", repo.tabId);
  },
  { bug: "D-07" },
);

// ---------------------------------------------------------------------------------------------
const ODD_OLD = "docs/Maße alt.md";
const ODD_FILE = "docs/Größen & Maße 🚀 Übersicht.md";
await t.section("F15-E4", "Umlauts, spaces, & and emoji in the file name (with rename): history and blame as in git", async () => {
  const repo = t.made(makeCleanRepoWithRemote({ name: "f15-e4" }));
  commitAt(repo, ODD_OLD, "# Maße\n\nTemperatur in °C\nRegen in mm\n", "Maße notiert", "2026-04-01T10:00:00+02:00", JONAS);
  commitAt(repo, ODD_OLD, "# Maße\n\nTemperatur in °C\nRegen in mm\nWind in km/h\n", "Maße: Wind ergänzt", "2026-04-02T10:00:00+02:00", MATS);
  gitRaw(repo, ["mv", ODD_OLD, ODD_FILE]);
  commitAt(repo, ODD_FILE, "# Größen & Maße 🚀\n\nTemperatur in °C\nRegen in mm\nWind in km/h\n", "Umbenannt: Größen & Maße 🚀 Übersicht", "2026-04-03T10:00:00+02:00");
  commitAt(repo, ODD_FILE, "# Größen & Maße 🚀\n\nTemperatur in °C\nRegen in mm\nWind in km/h\nLuftdruck in hPa 🌡️\n", "Luftdruck ergänzt 🌡️", "2026-04-04T10:00:00+02:00", JONAS);
  await t.open(repo);
  await openHistory(repo, ODD_FILE);
  const log = followLog(repo, ODD_FILE);
  equal(log.length, 4, "initial state: git log --follow reaches across the rename");
  const rows = await historyRows();
  equal(rows.map((row) => row.sha), log, "history: all four commits, including those under the old name");
  equal(rows.map((row) => row.path), [ODD_FILE, ODD_FILE, ODD_OLD, ODD_OLD], "every row knows the path in its commit");
  check(rows[1].text.includes(`renamed from ${ODD_OLD}`), `the rename row names the old name (${rows[1].text})`);
  check(rows[0].text.includes("Luftdruck ergänzt 🌡️") && rows[0].text.includes("Jonas Albrecht"), `emoji in the message and the author are shown (${rows[0].text})`);
  check(rows[2].text.includes("Mats Öztürk"), "author with umlauts is shown");
  equal(await t.overflow().then((value) => value.x), 0, "no horizontal overflow");
  // The diff of an older commit uses the old path.
  await fileHistoryScreen().locator('[data-history-list] [role="option"]').nth(2).click();
  await eventually(async () => (await fileHistoryScreen().locator('[data-screen="diff"]').innerText()).includes("Wind in km/h"), true, "the diff of the commit under the old name is shown");

  await openBlame(repo, ODD_FILE);
  const expected = blocksOf(blameShas(repo, ODD_FILE));
  equal((await blameBlocks()).map((block) => block.sha), expected, "blame: blocks as in git blame (across the rename)");
  check(new Set(expected).size >= 3, "blame: the lines come from at least three commits");
  equal(await t.overflow().then((value) => value.x), 0, "blame: no horizontal overflow");
  await t.store("closeCenter", repo.tabId);
});

// ---------------------------------------------------------------------------------------------
await t.section("F15-E5", "Changed from outside: commit and uncommitted change in the terminal while history and blame are open", async () => {
  const repo = t.made(makeCleanRepoWithRemote({ name: "f15-e5" }));
  commit(repo, "live.txt", "eins\nzwei\ndrei\n", "Live-Datei angelegt");
  await t.open(repo);
  await openHistory(repo, "live.txt");
  equal((await historyRows()).length, 1, "initial state: one commit");
  const second = commitAt(repo, "live.txt", "eins\nzwei geändert\ndrei\n", "Im Terminal geändert", gitLocal(new Date()), JONAS);
  await eventually(
    async () => {
      await t.comeBack();
      return (await historyRows()).map((row) => row.sha);
    },
    followLog(repo, "live.txt"),
    "the history shows the commit from the terminal",
    30_000,
  );
  check((await historyRows())[0].text.includes("Jonas Albrecht"), "with its author");

  await openBlame(repo, "live.txt");
  equal((await blameBlocks()).map((block) => block.sha), blocksOf(blameShas(repo, "live.txt")), "blame: blocks as in git blame");
  check((await blameBlocks()).some((block) => block.sha === second), "blame: the changed line belongs to the new commit");
  // Uncommitted change from outside.
  fs.writeFileSync(path.join(repo.path, "live.txt"), "eins\nzwei geändert\ndrei\nvier, noch nicht committet\n");
  await eventually(
    async () => {
      await t.comeBack();
      return (await blameBlocks()).some((block) => block.uncommitted);
    },
    true,
    "blame shows the uncommitted line as \"Not committed yet\"",
    30_000,
  );
  const third = commitAt(repo, "live.txt", "eins\nzwei geändert\ndrei\nvier, noch nicht committet\n", "Vierte Zeile", gitLocal(new Date()), MATS);
  await eventually(
    async () => {
      await t.comeBack();
      return (await blameBlocks()).map((block) => block.sha);
    },
    blocksOf(blameShas(repo, "live.txt")),
    "after the commit in the terminal: blame as in git blame, without \"Not committed yet\"",
    30_000,
  );
  check((await blameBlocks()).some((block) => block.sha === third), "the fourth line belongs to the new commit");
  equal(await t.dangerToasts(), [], "no error toast");
  await t.store("closeCenter", repo.tabId);
});

// ---------------------------------------------------------------------------------------------
await t.section("F15-E7", "Screen reader: roles and names in history and blame, focus visible", async () => {
  const repo = t.made(makeCleanRepoWithRemote({ name: "f15-e7" }));
  commitAt(repo, "stationen.csv", "kürzel;name;höhe_m\nN;Schule Nord;41\nS;Schule Süd;37\nH;Hafen;4\n", "Hafen: Höhe korrigiert", "2026-04-02T10:00:00+02:00", JONAS);
  await t.open(repo);
  await openHistory(repo, "stationen.csv");
  equal(await fileHistoryScreen().getAttribute("aria-label"), "History of stationen.csv", "the history has the file name in its name");
  const list = fileHistoryScreen().getByRole("listbox");
  equal(await list.count(), 1, "the commits are in a list (listbox)");
  check(((await list.getAttribute("aria-label")) ?? "").length > 3, `the list has a name (${await list.getAttribute("aria-label")})`);
  const rows = await historyRows();
  check(/^Hafen: Höhe korrigiert, Jonas Albrecht, \d+ months ago, /.test(rows[0].label), `every row names message, author, age and kind of change (${rows[0].label})`);
  equal(await t.unnamedControls('[data-screen="file-history"]'), [], "history: every control has an accessible name");
  await list.focus();
  await press("ArrowDown");
  await press("ArrowUp");
  check((await t.focused()).visible, `history: the focus in the list is visible with keyboard use (${JSON.stringify(await t.focused())})`);
  equal(await fileHistoryScreen().locator('[role="option"][aria-selected="true"]').count(), 1, "exactly one row is marked as selected (aria-selected)");

  await openBlame(repo, "stationen.csv");
  equal(await blameScreen().getAttribute("aria-label"), "Blame of stationen.csv", "blame has the file name in its name");
  equal(await t.unnamedControls('[data-screen="blame"]'), [], "blame: every control has an accessible name");
  // The per-line info also exists as text for screen readers (in the bar at the bottom), not only as colour.
  await blameScreen().locator(".cm-content").click();
  await press("Control+Home");
  await eventually(async () => (await blameScreen().locator("[data-blame-info]").innerText()).replace(/\s+/g, " "), (text) => /Lena Hartmann|Jonas Albrecht|Aylin Demir/.test(text) && / ago/.test(text), "the bar gives author and age of the current line as text");
  await t.store("closeCenter", repo.tabId);
});

// ---------------------------------------------------------------------------------------------
await t.section("F15-N1", "Deleted commit: the newest commit of the file disappears (reset and gc in the terminal) while the history is open", async () => {
  const repo = t.made(makeCleanRepoWithRemote({ name: "f15-n1" }));
  commit(repo, "protokoll.txt", "eins\n", "Protokoll angelegt");
  commit(repo, "protokoll.txt", "eins\nzwei\n", "Protokoll fortgeführt");
  const gone = commit(repo, "protokoll.txt", "eins\nzwei\ndrei\n", "Wird gleich verschwinden");
  await t.open(repo);
  await openHistory(repo, "protokoll.txt");
  equal((await historyRows())[0].sha, gone, "initial state: the newest commit is on top and selected");
  repo.git("reset", "-q", "--hard", "HEAD~1");
  repo.git("reflog", "expire", "--expire=now", "--all");
  repo.git("gc", "-q", "--prune=now");
  await eventually(
    async () => {
      await t.comeBack();
      return (await historyRows()).map((row) => row.sha);
    },
    followLog(repo, "protokoll.txt"),
    "the history only shows the two commits that exist",
    30_000,
  );
  equal(await fileHistoryScreen().locator('[role="option"][aria-selected="true"]').count(), 1, "afterwards a row is selected again");
  await eventually(async () => (await fileHistoryScreen().locator('[data-screen="diff"]').innerText().catch(() => "")).includes("zwei"), true, "and the diff shows an existing commit");
  equal(await t.dangerToasts(), [], "no error toast");
  await t.store("closeCenter", repo.tabId);
});

// ---------------------------------------------------------------------------------------------
await t.section("F15-N2", "Deleted file: the file is deleted in the terminal while blame is open – notice instead of crash; the history stays reachable", async () => {
  const repo = t.made(makeCleanRepoWithRemote({ name: "f15-n2" }));
  commit(repo, "weg.txt", "eins\nzwei\n", "Datei, die gleich gelöscht wird");
  await t.open(repo);
  await openBlame(repo, "weg.txt");
  equal((await blameBlocks()).length, 1, "initial state: blame shows the file");
  fs.rmSync(path.join(repo.path, "weg.txt"));
  await t.comeBack();
  await sleep(1500);
  await t.comeBack();
  const state = await blameScreen().evaluate((root) => ({ label: root.getAttribute("aria-label"), notice: root.querySelector("[data-notice]")?.textContent?.replace(/\s+/g, " ").trim() ?? null, hasText: Boolean(root.querySelector(".cm-content")) }));
  check(state.label === "Blame of weg.txt" && (state.notice !== null || state.hasText), `blame is still there – with a notice or the last state (${JSON.stringify(state)})`);
  if (state.notice) check(state.notice.length > 10, `the notice explains something (${state.notice})`);
  equal(await t.dangerToasts(), [], "no error toast");
  // The history of the deleted file is still there.
  await openHistory(repo, "weg.txt");
  equal((await historyRows()).map((row) => row.sha), followLog(repo, "weg.txt"), "history of the file deleted in the working tree as in git log");
  // And after committing the deletion it shows that too.
  repo.git("add", "-A");
  repo.git("commit", "-q", "-m", "Datei entfernt");
  await eventually(
    async () => {
      await t.comeBack();
      return (await historyRows()).map((row) => row.sha);
    },
    followLog(repo, "weg.txt"),
    "after committing the deletion: history up to the deletion",
    30_000,
  );
  equal(head(repo), (await historyRows())[0].sha, "the deletion commit is on top");
  await t.store("closeCenter", repo.tabId);
});

await t.finish();
