/**
 * Shared code for the E2E scripts file-view (file view), file-history (history) and blame (blame):
 * check helpers and a repository with everything these views need.
 *
 * On top of the rich "wetterstation" repository (clean) this adds:
 *   src/station.py          history across four authors, blame with several blocks
 *   docs/messkonzept.md     formerly docs/messplan.md (rename with changes)
 *   daten/alt-export.csv    created, changed, deleted
 *   text/crlf.txt           CRLF line endings
 *   text/gemischt.txt       mixed line endings
 *   text/latin1.txt         Windows-1252 / Latin-1
 *   docs/boese.md           Markdown with scripts, event attributes, remote images, javascript: links
 *   daten/gross.txt         20,000 lines from three commits (blame performance)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { gitIsolationEnv, makeRichRepo } from "../fixtures.mjs";

process.env.GIT_OPTIONAL_LOCKS = "0";

export const SHOTS = "target/e2e/shots";

export const PEOPLE = {
  lena: { name: "Lena Hartmann", email: "lena.hartmann@wetterstation.example" },
  jonas: { name: "Jonas Albrecht", email: "jonas.albrecht@wetterstation.example" },
  aylin: { name: "Aylin Demir", email: "aylin.demir@wetterstation.example" },
  mats: { name: "Mats Öztürk", email: "mats.oeztuerk@wetterstation.example" },
};

// ---------------------------------------------------------------------------
// Check helpers
// ---------------------------------------------------------------------------

export function makeChecks(screenId) {
  const failures = [];
  const measurements = [];
  const state = { current: "", app: null, only: null, resetView: null };
  const check = (condition, message) => {
    if (!condition) {
      failures.push(`${state.current}: ${message}`);
      console.log(`  ✗ ${message}`);
    }
    return Boolean(condition);
  };
  const equal = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected), `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const attempt = async (read) => {
    try {
      return await read();
    } catch (error) {
      return `Error: ${String(error?.message ?? error).split("\n")[0]}`;
    }
  };
  /** Waits until `read()` returns the expected value (the UI answers asynchronously). */
  const eventually = async (read, expected, message, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    const matches = (value) => (typeof expected === "function" ? expected(value) : JSON.stringify(value) === JSON.stringify(expected));
    let actual = await attempt(read);
    while (!matches(actual) && Date.now() < deadline) {
      await sleep(80);
      actual = await attempt(read);
    }
    if (matches(actual)) return true;
    return check(false, `${message}: ${typeof expected === "function" ? "condition not met" : `expected ${JSON.stringify(expected)}`}, got ${JSON.stringify(actual)}`);
  };
  const until = (read, message, timeoutMs) => eventually(read, (value) => Boolean(value) && !String(value).startsWith("Error:"), message, timeoutMs);
  const section = async (title, run) => {
    if (state.only && !state.only.some((part) => title.toLowerCase().includes(part.toLowerCase()))) return;
    state.current = title;
    const before = failures.length;
    const started = Date.now();
    try {
      await state.resetView?.();
      await run();
    } catch (error) {
      check(false, `aborted: ${error?.stack ?? error}`);
      if (state.app) await state.app.screenshot(`target/e2e/${screenId}-error-${title.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 40)}.png`).catch(() => undefined);
    }
    console.log(`${failures.length === before ? "✓" : "✗"} ${title} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  };
  return { failures, measurements, state, check, equal, eventually, until, section, sleep };
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export const FILES = {
  station: "src/station.py",
  renamed: "docs/messkonzept.md",
  renamedOld: "docs/messplan.md",
  deleted: "daten/alt-export.csv",
  crlf: "text/crlf.txt",
  mixed: "text/gemischt.txt",
  latin1: "text/latin1.txt",
  evil: "docs/boese.md",
  big: "daten/gross.txt",
  image: "docs/station.png",
  binary: "daten/kalibrierung.bin",
  readme: "README.md",
};

export const EVIL_MD = [
  "# Messbericht",
  "",
  "Normaler **Text** mit [Projektseite](https://example.org/projekt) und [Skript-Link](javascript:alert(1)).",
  "",
  "<script>window.__evil = (window.__evil || 0) + 1</script>",
  "<img src=x onerror=\"window.__evil = (window.__evil || 0) + 1\">",
  "",
  "![Radarbild](https://example.org/radar.png)",
  "",
  "<iframe src=\"https://example.org\"></iframe>",
  "<a href=\"https://example.org/klick\" onclick=\"window.__evil = 99\">Klick</a>",
  "<div style=\"position:fixed;inset:0;background:red\">Überdeckung</div>",
  "",
  "- [x] Sensor geprüft",
  "- [ ] Bericht verschickt",
  "",
].join("\n");

const STATION_V1 = [
  '"""Steuerung der Wetterstation."""',
  "",
  "INTERVALL_MINUTEN = 10",
  "",
  "",
  "def messen(sensor):",
  '    """Liest einen Wert vom Sensor."""',
  "    return sensor.lesen()",
  "",
  "",
  "def speichern(werte, pfad):",
  '    with open(pfad, "a", encoding="utf-8") as datei:',
  "        for wert in werte:",
  '            datei.write(f"{wert}\\n")',
  "",
];

/**
 * Builds the repository. Returns `{ repo, git, gitRaw, read, write, shas }`; `shas` holds the
 * commits of the additional history.
 */
export function makeFilesRepo() {
  const repo = makeRichRepo({ dirty: false });
  const gitEnv = { ...process.env, ...gitIsolationEnv(path.join(repo.root, "gitconfig")) };
  const gitRaw = (args, { person = PEOPLE.lena, date = null, input } = {}) =>
    execFileSync("git", args, {
      cwd: repo.path,
      input,
      env: {
        ...gitEnv,
        GIT_AUTHOR_NAME: person.name,
        GIT_AUTHOR_EMAIL: person.email,
        GIT_COMMITTER_NAME: person.name,
        GIT_COMMITTER_EMAIL: person.email,
        ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
    });
  const git = (...args) => gitRaw(args).toString("utf8").trim();
  const write = (file, content) => {
    const target = path.join(repo.path, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  const read = (file) => fs.readFileSync(path.join(repo.path, file));
  let day = 0;
  const commit = (message, person) => {
    day++;
    const date = `2026-04-${String(day).padStart(2, "0")}T10:${String(day).padStart(2, "0")}:00+02:00`;
    gitRaw(["add", "-A"], { person, date });
    gitRaw(["commit", "-q", "-m", message], { person, date });
    return git("rev-parse", "HEAD");
  };
  const shas = {};

  // --- src/station.py: four authors ------------------------------------------------------------
  write(FILES.station, `${STATION_V1.join("\n")}`);
  shas.stationFirst = commit("Steuerung der Station angelegt", PEOPLE.lena);
  const v2 = [...STATION_V1];
  v2[2] = "INTERVALL_MINUTEN = 5";
  write(FILES.station, v2.join("\n"));
  shas.stationInterval = commit("Messintervall auf fünf Minuten", PEOPLE.jonas);
  const v3 = [...v2];
  v3.splice(8, 0, "", "def pruefen(wert):", '    """Verwirft Ausfallwerte des Loggers."""', "    return wert is not None and wert > -999");
  write(FILES.station, v3.join("\n"));
  shas.stationCheck = commit("Ausfallwerte beim Messen verwerfen", PEOPLE.aylin);
  const v4 = [...v3];
  v4[v4.length - 2] = '            datei.write(f"{wert:.1f}\\n")';
  write(FILES.station, v4.join("\n"));
  shas.stationFormat = commit("Werte mit einer Nachkommastelle speichern", PEOPLE.mats);

  // --- Rename with changes ---------------------------------------------------------------------
  write(FILES.renamedOld, "# Messplan\n\nDie Station misst alle zehn Minuten.\n\n## Sensoren\n\n- Temperatur\n- Luftfeuchte\n");
  shas.planCreated = commit("Messplan entworfen", PEOPLE.aylin);
  write(FILES.renamedOld, "# Messplan\n\nDie Station misst alle fünf Minuten.\n\n## Sensoren\n\n- Temperatur\n- Luftfeuchte\n- Regen\n");
  shas.planChanged = commit("Messplan: Regen und neues Intervall", PEOPLE.jonas);
  gitRaw(["mv", FILES.renamedOld, FILES.renamed]);
  write(FILES.renamed, "# Messkonzept\n\nDie Station misst alle fünf Minuten.\n\n## Sensoren\n\n- Temperatur\n- Luftfeuchte\n- Regen\n");
  shas.planRenamed = commit("Messplan heißt jetzt Messkonzept", PEOPLE.lena);
  write(FILES.renamed, "# Messkonzept\n\nDie Station misst alle fünf Minuten.\n\n## Sensoren\n\n- Temperatur\n- Luftfeuchte\n- Regen\n- Wind\n");
  shas.planAfter = commit("Messkonzept: Wind ergänzt", PEOPLE.mats);

  // --- Deleted file    -------------------------------------------------------------------------
  write(FILES.deleted, "datum;wert\n2026-01-01;1,5\n");
  shas.exportCreated = commit("Alter Export der Messwerte", PEOPLE.jonas);
  write(FILES.deleted, "datum;wert\n2026-01-01;1,5\n2026-01-02;2,0\n");
  shas.exportChanged = commit("Alter Export: zweiter Tag", PEOPLE.jonas);
  gitRaw(["rm", "-q", FILES.deleted]);
  shas.exportDeleted = commit("Alten Export entfernt", PEOPLE.aylin);

  // --- Line endings and encoding ---------------------------------------------------------------
  write(FILES.crlf, "erste Zeile\r\nzweite Zeile\r\ndritte Zeile\r\n");
  write(FILES.mixed, "unix\nwindows\r\nunix\nwindows\r\nwindows\r\n");
  write(FILES.latin1, Buffer.from("Größe;Einheit\nTemperatur;°C\nNiederschlag;mm\n", "latin1"));
  write(FILES.evil, EVIL_MD);
  shas.textFiles = commit("Testdateien: Zeilenenden, Latin-1, Markdown", PEOPLE.lena);

  // --- Big file from three commits  ------------------------------------------------------------
  const big = Array.from({ length: 20_000 }, (_, index) => `Messwert ${String(index + 1).padStart(5, "0")}: ${(index * 0.37).toFixed(2)} °C`);
  write(FILES.big, `${big.join("\n")}\n`);
  shas.bigFirst = commit("Große Messreihe abgelegt", PEOPLE.lena);
  for (let index = 5000; index < 10_000; index++) big[index] = `${big[index]} korrigiert`;
  write(FILES.big, `${big.join("\n")}\n`);
  shas.bigSecond = commit("Messreihe: zweites Viertel korrigiert", PEOPLE.jonas);
  for (let index = 15_000; index < 15_500; index++) big[index] = `${big[index]} (Ausreißer)`;
  write(FILES.big, `${big.join("\n")}\n`);
  shas.bigThird = commit("Messreihe: Ausreißer markiert", PEOPLE.aylin);

  return { repo, git, gitRaw, read, write, shas };
}

/**
 * Creates `count` more commits that all change `file` (via git fast-import – one process instead
 * of many) and brings index and working tree up to date. Returns the SHAs, oldest first.
 */
export function addManyCommits(fx, file, count) {
  const people = Object.values(PEOPLE);
  const parts = [];
  const start = Math.floor(Date.parse("2026-05-01T08:00:00Z") / 1000);
  for (let index = 0; index < count; index++) {
    const person = people[index % people.length];
    const stamp = `${start + index * 3600} +0200`;
    const message = `Messlauf ${String(index + 1).padStart(3, "0")} eingetragen\n`;
    const content = `${Array.from({ length: index + 1 }, (_, line) => `Lauf ${String(line + 1).padStart(3, "0")}`).join("\n")}\n`;
    parts.push(
      "commit refs/heads/main\n",
      `mark :${index + 1}\n`,
      `author ${person.name} <${person.email}> ${stamp}\n`,
      `committer ${person.name} <${person.email}> ${stamp}\n`,
      `data ${Buffer.byteLength(message)}\n${message}`,
      index === 0 ? `from ${fx.git("rev-parse", "HEAD")}\n` : `from :${index}\n`,
      `M 100644 inline ${file}\n`,
      `data ${Buffer.byteLength(content)}\n${content}\n`,
    );
  }
  fx.gitRaw(["fast-import", "--quiet", "--force"], { input: parts.join("") });
  fx.gitRaw(["reset", "-q", "--hard", "HEAD"]);
  return fx.git("log", "--reverse", "--format=%H", `-${count}`, "--", file).split("\n");
}

/** Closes all toasts (they would otherwise cover parts of the screenshots). */
export async function closeToasts(page) {
  for (let round = 0; round < 10 && (await page.locator("[data-toast]").count()) > 0; round++) {
    await page.getByRole("button", { name: "Close message" }).first().click().catch(() => undefined);
    await page.waitForTimeout(120);
  }
}

/** Center view of the tab from the store (debug build only). */
export const centerOf = (page, tabId) => page.evaluate((tab) => window.__gc.store.getState().views[tab]?.center ?? null, tabId);

/** Scroll measurement as in diff: 240 steps of 400 px, time per frame. */
export const measureScroll = (page, selector) =>
  page.evaluate(async (target) => {
    const element = document.querySelector(target);
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    element.scrollTop = 0;
    await frame();
    const times = [];
    let last = performance.now();
    let maxRows = 0;
    let blank = false;
    for (let step = 0; step < 240; step++) {
      element.scrollTop += 400;
      await frame();
      const now = performance.now();
      times.push(now - last);
      last = now;
      const rows = element.querySelectorAll(".cm-line").length;
      maxRows = Math.max(maxRows, rows);
      if (rows === 0) blank = true;
    }
    const sorted = [...times].sort((a, b) => a - b);
    return { avg: times.reduce((sum, value) => sum + value, 0) / times.length, p95: sorted[Math.floor(sorted.length * 0.95)], max: sorted[sorted.length - 1], maxRows, scrolled: element.scrollTop, blank };
  }, selector);

export const formatMeasure = (result) => `avg ${result.avg.toFixed(1)} ms, p95 ${result.p95.toFixed(1)} ms, max ${result.max.toFixed(1)} ms per frame, at most ${result.maxRows} lines in the DOM`;

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Helpers around a running app: store calls, focus, palette, dialogs, menus.
 * `checks` comes from makeChecks.
 */
export function makeDriver(app, tabId, checks) {
  const { page } = app;
  const { eventually, until, check } = checks;
  const store = (method, ...args) => page.evaluate(([name, list]) => window.__gc.store.getState()[name](...list), [method, args]);
  const focused = () =>
    page.evaluate(() => {
      const element = document.activeElement;
      if (!element) return null;
      return {
        tag: element.tagName,
        role: element.getAttribute("role"),
        label: element.getAttribute("aria-label"),
        text: (element.textContent ?? "").trim().slice(0, 60),
        inEditor: Boolean(element.closest(".cm-editor")),
        screen: element.closest("[data-screen]")?.getAttribute("data-screen") ?? null,
      };
    });
  const dialogs = () => page.locator('[role="dialog"], [role="alertdialog"]').evaluateAll((list) => list.map((dialog) => dialog.querySelector("h2")?.textContent ?? dialog.getAttribute("aria-label") ?? ""));
  const toasts = () => page.locator("[data-toast]").allInnerTexts();
  const center = () => centerOf(page, tabId);
  /** Closes dialogs, menus and the center view (for the start of a section). */
  const reset = async () => {
    for (let round = 0; round < 4 && (await page.locator('[role="dialog"], [role="alertdialog"], [role="menu"]').count()) > 0; round++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
    }
    await store("closeCenter", tabId);
    await closeToasts(page);
    await app.settle();
  };
  /** Runs a command through the palette – keyboard only. */
  const runCommand = async (text, commandId) => {
    await page.keyboard.press("Control+p");
    const input = page.locator('[data-screen="command-palette"] input[role="combobox"]');
    await input.waitFor({ timeout: 10_000 });
    await page.keyboard.type(`>${text}`, { delay: 5 });
    const keys = () => page.locator('[data-screen="command-palette"] [role="option"]').evaluateAll((rows) => rows.map((row) => row.dataset.key));
    await until(async () => (await keys()).includes(`command:${commandId}`), `the palette finds "${text}"`);
    const index = (await keys()).indexOf(`command:${commandId}`);
    for (let step = 0; step < index; step++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await eventually(() => page.locator('[data-screen="command-palette"]').count(), 0, "the palette is closed again");
  };
  /** Presses Tab or Shift+Tab until `matches(focused)` holds. */
  const tabTo = async (matches, message, { back = false, max = 25 } = {}) => {
    for (let step = 0; step < max; step++) {
      const now = await focused();
      if (now && matches(now)) return true;
      await page.keyboard.press(back ? "Shift+Tab" : "Tab");
    }
    const now = await focused();
    return check(Boolean(now && matches(now)), `${message} (focus is on ${JSON.stringify(now)})`);
  };
  /** Entry in the open menu (exact label text). */
  const menuItem = (label) =>
    page
      .locator('[role="menu"] [role="menuitem"]')
      .filter({ has: page.locator("span", { hasText: new RegExp(`^${escapeRegExp(label)}$`) }) })
      .first();
  return { page, store, focused, dialogs, toasts, center, reset, runCommand, tabTo, menuItem };
}

/** Text of a CodeMirror editor (the rendered part – the whole text for small files). */
export const editorText = (page, scope) =>
  page.evaluate((selector) => {
    const content = document.querySelector(`${selector} .cm-content`);
    if (!content) return null;
    return Array.from(content.querySelectorAll(".cm-line"))
      .map((line) => line.textContent ?? "")
      .join("\n");
  }, scope);

/** End of the script: close the app, remove the fixture, print the result, set the exit code. */
export async function finish(screenId, checks, app, cleanup) {
  const { failures, measurements } = checks;
  const errors = app?.consoleErrors ?? [];
  if (app) await app.close().catch(() => undefined);
  cleanup();
  if (measurements.length) console.log(`\nMeasurements\n${measurements.map((line) => `- ${line}`).join("\n")}`);
  if (errors.length && !failures.some((line) => /console error|Konsolenfehler/i.test(line))) failures.push(`Console errors: ${errors.join(" | ")}`);
  console.log(failures.length ? `\n${screenId}: ${failures.length} failures\n${failures.map((line) => `- ${line}`).join("\n")}` : `\n${screenId}: green.`);
  process.exit(failures.length ? 1 : 0);
}
