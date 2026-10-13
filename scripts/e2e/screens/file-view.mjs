/**
 * file-view – file view and editor in the real app, against a real Git repository.
 *
 *   node scripts/e2e/screens/file-view.mjs                  everything (checks and screenshots)
 *   node scripts/e2e/screens/file-view.mjs --only latin     only sections whose title contains "latin" (comma separates several)
 *   node scripts/e2e/screens/file-view.mjs --show           visible window
 *
 * Every save is verified in the repository: the file byte-exact (line endings, encoding),
 * "Save and stage" via git diff --cached and the blob in the index. The "keyboard only" section
 * never uses the mouse. At the end the script fails on console errors.
 */
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "../driver.mjs";
import { EVIL_MD, FILES, SHOTS, closeToasts, editorText, finish, formatMeasure, makeChecks, makeDriver, makeFilesRepo, measureScroll } from "./files-lib.mjs";

const show = process.argv.includes("--show");
const checks = makeChecks("file-view");
const { check, equal, eventually, until, section, measurements, state } = checks;
state.only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : null;

const fx = makeFilesRepo();
const { git, gitRaw, read, write, shas } = fx;
const exists = (file) => fs.existsSync(path.join(fx.repo.path, file));
const SCREEN = '[data-screen="file-view"]';
const TOO_LARGE = "daten/riesig.log";
const NEW_FILE = "notizen/neu.md";
const LATIN1_ORIGINAL = Buffer.from("Größe;Einheit\nTemperatur;°C\nNiederschlag;mm\n", "latin1");
const CRLF_ORIGINAL = "erste Zeile\r\nzweite Zeile\r\ndritte Zeile\r\n";
const MIXED_ORIGINAL = "unix\nwindows\r\nunix\nwindows\r\nwindows\r\n";

let app = null;
try {
  app = await launchApp({ show });
  state.app = app;
  const { page } = app;
  const { repoId, tabId } = await app.openRepo(fx.repo.path);
  const ui = makeDriver(app, tabId, checks);
  const screen = page.locator(SCREEN);
  const attr = (name) => screen.getAttribute(name, { timeout: 2000 }).catch(() => null);
  const text = () => editorText(page, SCREEN);
  const footer = (kind) => screen.locator(`[data-footer-menu="${kind}"]`).innerText();
  const shot = async (name) => {
    await app.settle();
    await page.waitForTimeout(250);
    await app.screenshot(`${SHOTS}/${name}.png`);
  };
  /** Waits until the file is fully loaded. */
  const ready = async (file) => {
    await page.waitForFunction(
      (label) => {
        const root = document.querySelector('[data-screen="file-view"]');
        return root?.getAttribute("aria-label") === label && !root.querySelector("[data-loading]");
      },
      `File ${file}`,
      { timeout: 30_000 },
    );
    await app.settle();
  };
  const open = async (file, sha = null, mode = "view") => {
    await ui.store("openFile", tabId, file, sha, mode);
    await ready(file);
  };
  /** Click into the text, jump to the end, type. */
  const typeAtEnd = async (input) => {
    await screen.locator(".cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(input);
  };
  const save = async () => {
    await page.keyboard.press("Control+s");
    await eventually(() => attr("data-dirty-state"), "clean", "after Ctrl+S nothing is unsaved");
    await app.settle();
  };
  /** Picks an entry in the footer menu (encoding or line endings). */
  const pickFooter = async (kind, label) => {
    await screen.locator(`[data-footer-menu="${kind}"]`).click();
    await ui.menuItem(label).click();
    await eventually(() => page.locator('[role="menu"]').count(), 0, "the menu is closed again");
  };
  state.resetView = async () => {
    await ui.reset();
    if ((await ui.dialogs()).length) await page.keyboard.press("Escape");
  };

  // -------------------------------------------------------------------------------------------
  await section("View: header, state, footer, read-only", async () => {
    // Loading: the skeleton stays until the core has answered.
    const sawSkeleton = await page.evaluate(
      async ([tab, file]) => {
        window.__gc.store.getState().openFile(tab, file, null, "view");
        for (let frame = 0; frame < 30; frame++) {
          await new Promise((resolve) => requestAnimationFrame(resolve));
          const root = document.querySelector('[data-screen="file-view"]');
          if (root?.querySelector('[data-loading][role="status"]')) return true;
          if (root?.querySelector(".cm-content")) return false;
        }
        return false;
      },
      [tabId, FILES.station],
    );
    check(sawSkeleton, "while the file loads, a skeleton is shown (role=status)");
    await ready(FILES.station);
    equal(await attr("data-mode"), "view", "mode: view");
    equal(await screen.locator("[data-file-title]").innerText().then((value) => value.replace(/\s+/g, " ").trim()), "station.py src/", "the header shows file name and folder");
    equal(await screen.locator("[data-stand]").innerText(), "Working directory", "state: working directory");
    equal(await screen.locator("[data-editable]").count(), 0, "no \"editable\" badge when viewing");
    equal(await text(), read(FILES.station).toString("utf8"), "the text matches the file");
    equal(await footer("encoding"), "UTF-8", "footer: encoding");
    equal(await footer("eol"), "LF", "footer: line endings");
    check((await screen.locator("[data-file-footer]").innerText()).includes("19 lines"), "footer: line count (18 text lines and the empty last one, like the line numbers)");
    for (const name of ["File history", "Blame", "Open in external editor"]) equal(await screen.getByRole("button", { name, exact: true }).count(), 1, `button "${name}"`);
    equal(await screen.getByRole("button", { name: "Save", exact: true }).count(), 0, "no \"Save\" when viewing");
    check((await screen.locator(".cm-content .gc-tok-keyword, .cm-content [class*='tok-']").count()) > 0, "syntax highlighting for Python");

    await screen.locator(".cm-content").click();
    await page.keyboard.type("darf nicht ankommen");
    equal(await text(), read(FILES.station).toString("utf8"), "typing changes nothing when viewing");
    equal(await attr("data-dirty-state"), "clean", "nothing unsaved");
    await shot("file-view-view");

    // Esc closes the view.
    await page.keyboard.press("Escape");
    await eventually(async () => (await ui.center())?.kind, "graph", "Esc closes the file view");
  });

  // -------------------------------------------------------------------------------------------
  await section("Edit, save, save and stage – keyboard only", async () => {
    const before = read(FILES.station).toString("utf8");
    await ui.runCommand("edit file", "file.edit");
    await page.getByRole("dialog", { name: "Edit file" }).waitFor();
    await page.keyboard.type("src/station.py");
    await page.keyboard.press("Enter");
    await ready(FILES.station);
    equal(await attr("data-mode"), "edit", "the file is in edit mode");
    equal(await screen.locator("[data-editable]").innerText(), "editable", "\"editable\" badge");
    await until(async () => (await ui.focused())?.inEditor, "focus is in the text");

    await page.keyboard.press("Control+End");
    await page.keyboard.type("# geprüft: Böen über 20 m/s");
    await page.keyboard.press("Enter");
    await eventually(() => attr("data-dirty-state"), "dirty", "after typing: unsaved");
    equal(await screen.locator("[data-dirty]").count(), 1, "the unsaved dot is in the header");
    equal(read(FILES.station).toString("utf8"), before, "before saving the file is unchanged");
    await shot("file-view");

    await page.keyboard.press("Control+s");
    const afterSave = `${before}# geprüft: Böen über 20 m/s\n`;
    await eventually(() => read(FILES.station).toString("utf8"), afterSave, "Ctrl+S writes the file (UTF-8, LF, byte-exact)");
    check(read(FILES.station).equals(Buffer.from(afterSave, "utf8")), "bytes match exactly");
    await eventually(() => attr("data-dirty-state"), "clean", "afterwards nothing unsaved");
    await until(async () => (await ui.toasts()).some((line) => line.includes("saved")), "\"saved\" message");
    equal(git("status", "--porcelain", "--", FILES.station), "M src/station.py", "git status: modified, not staged");
    equal(git("diff", "--cached", "--name-only"), "", "nothing staged");

    // Keep typing, then Shift+Tab to the "Save and stage" button.
    await until(async () => (await ui.focused())?.inEditor, "focus is still in the text after saving");
    await page.keyboard.type("# zweite Zeile");
    await page.keyboard.press("Enter");
    await eventually(() => attr("data-dirty-state"), "dirty", "unsaved again");
    await ui.tabTo((now) => now.label === "Save and stage", "Shift+Tab reaches \"Save and stage\"", { back: true, max: 8 });
    await page.keyboard.press("Enter");
    const afterStage = `${afterSave}# zweite Zeile\n`;
    await eventually(() => read(FILES.station).toString("utf8"), afterStage, "the file is saved");
    await eventually(() => git("diff", "--cached", "--name-only"), FILES.station, "git diff --cached lists the file");
    const cached = git("diff", "--cached", "--no-color", "--", FILES.station);
    check(cached.includes("+# geprüft: Böen über 20 m/s") && cached.includes("+# zweite Zeile"), "git diff --cached contains both new lines");
    check(gitRaw(["cat-file", "blob", `:${FILES.station}`]).equals(Buffer.from(afterStage, "utf8")), "the blob in the index matches the file byte-exact");
    equal(git("diff", "--name-only"), "", "nothing unstaged anymore");
    await until(async () => (await ui.toasts()).some((line) => line.includes("saved and staged")), "\"saved and staged\" message");

    // The button is now disabled (nothing unsaved). The focus guard therefore moves focus back
    // into the text – after saving you just keep typing.
    await until(async () => (await ui.focused())?.inEditor, "after \"Save and stage\" focus is back in the text");
    // In the text, Esc belongs to the editor: the view stays open.
    await page.keyboard.press("Escape");
    await app.settle();
    equal((await ui.center())?.kind, "file", "Esc in the text does not close the view");
    // Esc outside the text closes (nothing unsaved → no confirmation) – with a single press,
    // even while the focused button shows its tooltip.
    await ui.tabTo((now) => !now.inEditor && now.tag === "BUTTON", "Shift+Tab leaves the text to a button in the header", { back: true, max: 4 });
    await until(async () => (await page.locator('[role="tooltip"]').count()) > 0, "the button shows its tooltip on keyboard focus");
    await page.keyboard.press("Escape");
    await eventually(async () => (await ui.center())?.kind, "graph", "Esc closes");
    equal(await ui.dialogs(), [], "no confirmation");
  });

  // -------------------------------------------------------------------------------------------
  await section("CRLF stays CRLF", async () => {
    await open(FILES.crlf, null, "edit");
    equal(await footer("eol"), "CRLF", "footer shows CRLF");
    equal(await text(), "erste Zeile\nzweite Zeile\ndritte Zeile\n", "text without visible carriage returns");
    equal(await attr("data-dirty-state"), "clean", "freshly opened: nothing unsaved");
    await typeAtEnd("vierte Zeile");
    await page.keyboard.press("Enter");
    await save();
    const bytes = read(FILES.crlf);
    check(bytes.equals(Buffer.from(`${CRLF_ORIGINAL}vierte Zeile\r\n`, "utf8")), `file byte-exact with CRLF (is ${JSON.stringify(bytes.toString("utf8"))})`);
    check(!/[^\r]\n/.test(bytes.toString("latin1")), "no lone LF in the file");
    equal(await footer("eol"), "CRLF", "still CRLF after saving");

    // Switching to LF counts as a change; saving writes LF.
    await pickFooter("eol", "LF (Linux, macOS)");
    equal(await attr("data-dirty-state"), "dirty", "switching line endings counts as unsaved");
    await save();
    check(read(FILES.crlf).equals(Buffer.from("erste Zeile\nzweite Zeile\ndritte Zeile\nvierte Zeile\n", "utf8")), "after switching, LF everywhere");
    equal(await footer("eol"), "LF", "footer shows LF");
  });

  // -------------------------------------------------------------------------------------------
  await section("Latin-1 stays Latin-1; change encoding; characters that do not fit", async () => {
    check(read(FILES.latin1).equals(LATIN1_ORIGINAL), "precondition: Latin-1 file");
    await open(FILES.latin1, null, "edit");
    equal(await footer("encoding"), "WINDOWS-1252", "footer: detected encoding");
    equal(await text(), "Größe;Einheit\nTemperatur;°C\nNiederschlag;mm\n", "umlauts and degree sign are read correctly");
    await typeAtEnd("Böe;m/s");
    await page.keyboard.press("Enter");
    await save();
    const expected = Buffer.concat([LATIN1_ORIGINAL, Buffer.from("Böe;m/s\n", "latin1")]);
    check(read(FILES.latin1).equals(expected), `file byte-exact in Latin-1 (is ${read(FILES.latin1).toString("hex")})`);
    check(!read(FILES.latin1).includes(Buffer.from("ö", "utf8")), "no UTF-8 \"ö\" in the file");
    await shot("file-view-latin1");

    // A character Windows-1252 does not know: saving fails, the file stays.
    await typeAtEnd("日本;x");
    await page.keyboard.press("Control+s");
    await until(async () => (await page.locator('[data-toast="danger"]').count()) > 0, "error message on save");
    check(read(FILES.latin1).equals(expected), "the file is unchanged");
    equal(await attr("data-dirty-state"), "dirty", "the text stays unsaved in the editor");
    await closeToasts(page);

    // Switch to UTF-8: note in the footer, saving writes UTF-8.
    await pickFooter("encoding", "UTF-8");
    equal(await footer("encoding"), "UTF-8", "footer shows the chosen encoding");
    check((await screen.locator("[data-encoding-pending]").innerText()).includes("UTF-8"), "note: becomes UTF-8 on save");
    await save();
    check(read(FILES.latin1).equals(Buffer.from("Größe;Einheit\nTemperatur;°C\nNiederschlag;mm\nBöe;m/s\n日本;x", "utf8")), "file now byte-exact in UTF-8");
    equal(await screen.locator("[data-encoding-pending]").count(), 0, "the note is gone");

    // Back to Latin-1 for the following sections.
    write(FILES.latin1, LATIN1_ORIGINAL);
  });

  // -------------------------------------------------------------------------------------------
  await section("Reread in another encoding", async () => {
    write(FILES.latin1, LATIN1_ORIGINAL);
    await open(FILES.latin1, null, "view");
    await eventually(() => footer("encoding"), "WINDOWS-1252", "read as Windows-1252");
    await screen.locator('[data-footer-menu="encoding"]').click();
    await ui.menuItem("Reread as").hover();
    await ui.menuItem("Reread as").press("ArrowRight");
    await page.locator('[role="menu"]').last().getByRole("menuitem", { name: "Cyrillic (Windows-1251)" }).click();
    await eventually(() => footer("encoding"), "WINDOWS-1251", "the footer names the new encoding");
    await eventually(text, "GrцЯe;Einheit\nTemperatur;°C\nNiederschlag;mm\n", "the same bytes, read as Cyrillic");
    equal((await app.invoke("repo_settings_get", { repoId })).encoding, "windows-1251", "the repository default is changed");
    equal(await attr("data-dirty-state"), "clean", "rereading makes nothing unsaved");
    check(read(FILES.latin1).equals(LATIN1_ORIGINAL), "the file itself is unchanged");
    await closeToasts(page);

    // UTF-8 with umlauts is unambiguous: "Reread as" is disabled and says why.
    await open(FILES.evil, null, "edit");
    await screen.locator('[data-footer-menu="encoding"]').click();
    const item = ui.menuItem("Reread as");
    equal(await item.getAttribute("aria-disabled"), "true", "disabled for valid UTF-8");
    check((await item.innerText()).includes("clearly UTF-8"), "with a reason");
    await page.keyboard.press("Escape");

    await app.invoke("repo_settings_set", { repoId, patch: { encoding: "utf-8" } });
    await page.evaluate((id) => window.__gc.queryClient.invalidateQueries({ queryKey: ["repo", id] }), repoId);
    await app.settle();
  });

  // -------------------------------------------------------------------------------------------
  await section("Mixed line endings", async () => {
    await open(FILES.mixed, null, "edit");
    check((await footer("eol")).startsWith("Mixed"), `footer says "Mixed" (is ${await footer("eol")})`);
    equal(await attr("data-dirty-state"), "clean", "opened unchanged: nothing unsaved");
    check(read(FILES.mixed).equals(Buffer.from(MIXED_ORIGINAL)), "opening alone does not change the file");
    await shot("file-view-mixed-eol");
    await typeAtEnd("neu");
    await page.keyboard.press("Enter");
    await save();
    check(read(FILES.mixed).equals(Buffer.from("unix\r\nwindows\r\nunix\r\nwindows\r\nwindows\r\nneu\r\n")), `saving unifies to the more common kind, CRLF (is ${JSON.stringify(read(FILES.mixed).toString())})`);
    await eventually(() => footer("eol"), "CRLF", "afterwards uniformly CRLF");
  });

  // -------------------------------------------------------------------------------------------
  await section("Unsaved: closing asks", async () => {
    const before = read(FILES.renamed).toString("utf8");
    await open(FILES.renamed, null, "edit");
    await typeAtEnd("- Sonne");
    await eventually(() => attr("data-dirty-state"), "dirty", "unsaved");

    // In the text, Esc belongs to the editor.
    await page.keyboard.press("Escape");
    equal((await ui.center())?.kind, "file", "Esc in the text does not close");
    equal(await ui.dialogs(), [], "and asks nothing");

    await screen.locator("[data-back]").click();
    const dialog = page.getByRole("dialog", { name: /Save changes to “messkonzept.md”/ });
    await dialog.waitFor();
    await shot("file-view-confirm-close");
    await page.keyboard.press("Escape");
    await eventually(() => dialog.count(), 0, "Esc cancels the confirmation");
    equal((await ui.center())?.kind, "file", "the file stays open");
    equal(await attr("data-dirty-state"), "dirty", "the text stays unsaved");

    await screen.locator("[data-back]").click();
    await dialog.waitFor();
    await dialog.getByRole("button", { name: /Don’t save/ }).click();
    await eventually(async () => (await ui.center())?.kind, "graph", "\"Don’t save\" closes");
    equal(read(FILES.renamed).toString("utf8"), before, "the file is unchanged");
    await open(FILES.renamed, null, "edit");
    equal(await text(), before, "on the next open the version on disk is shown again");
    equal(await attr("data-dirty-state"), "clean", "no draft left");

    // "Save" in the confirmation saves and closes.
    await typeAtEnd("- Sonne");
    await screen.locator("[data-back]").click();
    await dialog.waitFor();
    await dialog.getByRole("button", { name: /^Save/ }).click();
    await eventually(async () => (await ui.center())?.kind, "graph", "\"Save\" closes");
    equal(read(FILES.renamed).toString("utf8"), `${before}- Sonne`, "and the file is saved");
    gitRaw(["checkout", "--", FILES.renamed]);
  });

  // -------------------------------------------------------------------------------------------
  await section("Draft survives switching to another view", async () => {
    const before = read(FILES.readme).toString("utf8");
    await open(FILES.readme, null, "edit");
    await typeAtEnd("Entwurf, noch nicht gespeichert");
    await eventually(() => attr("data-dirty-state"), "dirty", "unsaved");
    await ui.store("openHistory", tabId, FILES.readme);
    await page.locator('[data-screen="file-history"]').waitFor();
    equal(read(FILES.readme).toString("utf8"), before, "switching saves nothing");
    await open(FILES.readme, null, "edit");
    check((await text()).endsWith("Entwurf, noch nicht gespeichert"), "the draft is back in the editor");
    equal(await attr("data-dirty-state"), "dirty", "still marked as unsaved");
    check((await screen.innerText()).includes("Unsaved changes from earlier"), "note about the restored draft");
    await shot("file-view-draft");
    await screen.getByRole("button", { name: "Discard", exact: true }).click();
    await eventually(() => attr("data-dirty-state"), "clean", "\"Discard\" drops the draft");
    equal(await text(), before, "the text matches the file again");
  });

  // -------------------------------------------------------------------------------------------
  await section("Changed outside", async () => {
    write(FILES.crlf, CRLF_ORIGINAL);
    await open(FILES.crlf, null, "edit");
    await eventually(text, "erste Zeile\nzweite Zeile\ndritte Zeile\n", "precondition");

    // Without own changes it reloads silently.
    const refresh = async (isThere, what) => {
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline && !(await isThere())) await page.waitForTimeout(100);
      if (await isThere()) return "by itself (window focus or file watcher)";
      await page.evaluate((id) => window.__gc.queryClient.invalidateQueries({ queryKey: ["repo", id, "file"] }), repoId);
      await until(isThere, what);
      return "only after forcing the query to reload";
    };
    write(FILES.crlf, "von außen\r\nersetzt\r\n");
    const silent = await refresh(async () => (await text()) === "von außen\nersetzt\n", "the view shows the new content");
    measurements.push(`file changed outside, nothing unsaved: reloaded ${silent}`);
    equal(await attr("data-dirty-state"), "clean", "still nothing unsaved");

    // With own changes: notice and choice.
    await typeAtEnd("meins");
    write(FILES.crlf, "zweites Mal von außen\r\n");
    const banner = () => screen.getByText("The file was changed outside the app").count().then(Boolean);
    const loud = await refresh(banner, "\"changed outside\" notice");
    measurements.push(`file changed outside, unsaved text: notice ${loud}`);
    check((await text()).endsWith("meins"), "own text is still there");
    await shot("file-view-external");
    await screen.getByRole("button", { name: "Reload", exact: true }).click();
    await eventually(text, "zweites Mal von außen\n", "\"Reload\" shows the version on disk");
    equal(await attr("data-dirty-state"), "clean", "nothing unsaved anymore");

    await typeAtEnd("meins");
    write(FILES.crlf, "drittes Mal von außen\r\n");
    await refresh(banner, "notice the second time");
    await screen.getByRole("button", { name: "Keep mine", exact: true }).click();
    equal(await banner(), false, "the note is gone");
    await save();
    check(read(FILES.crlf).equals(Buffer.from("zweites Mal von außen\r\nmeins")), `"Keep mine" overwrites on save (is ${JSON.stringify(read(FILES.crlf).toString())})`);
    write(FILES.crlf, CRLF_ORIGINAL);
  });

  // -------------------------------------------------------------------------------------------
  await section("Markdown: preview with malicious content", async () => {
    write(FILES.evil, EVIL_MD);
    await page.evaluate(() => {
      window.__evil = undefined;
      window.__gcTestOpened = [];
    });
    await open(FILES.evil, null, "view");
    const article = screen.locator("article[data-md-preview]");
    await article.waitFor();
    equal(await screen.locator('[aria-label="Markdown"] [data-state="on"]').innerText(), "Preview", "Markdown opens in preview when viewing");
    const found = await article.evaluate((root) => ({
      scripts: root.querySelectorAll("script").length,
      frames: root.querySelectorAll("iframe, object, embed, form").length,
      images: root.querySelectorAll("img").length,
      styled: root.querySelectorAll("[style]").length,
      handlers: Array.from(root.querySelectorAll("*")).filter((element) => Array.from(element.attributes).some((attribute) => attribute.name.startsWith("on"))).length,
      hrefs: root.querySelectorAll("[href], [src]").length,
      placeholders: Array.from(root.querySelectorAll("[data-readme-image]")).map((element) => element.getAttribute("data-readme-image")),
      heading: root.querySelector("h1")?.textContent,
      tasks: Array.from(root.querySelectorAll("[data-readme-task]")).map((element) => element.getAttribute("data-readme-task")),
      evil: window.__evil ?? null,
    }));
    equal(found, { scripts: 0, frames: 0, images: 0, styled: 0, handlers: 0, hrefs: 0, placeholders: ["local", "remote"], heading: "Messbericht", tasks: ["done", "open"], evil: null }, "sanitized: no scripts, frames, images, styles, event attributes, targets");
    check((await screen.locator("[data-md-note]").innerText()).includes("2 images not loaded"), "note about images not loaded");
    check(!(await article.innerText()).includes("window.__evil"), "the script text does not appear");
    await shot("file-view-markdown");

    // Link: only after confirmation, and then outside the app – via keyboard.
    const link = article.locator('[data-href="https://example.org/projekt"]');
    await link.focus();
    await page.keyboard.press("Enter");
    const ask = page.getByRole("dialog", { name: "Open link outside the app?" });
    await ask.waitFor();
    check((await ask.innerText()).includes("https://example.org/projekt"), "the confirmation names the target");
    equal(await page.evaluate(() => window.__gcTestOpened), [], "nothing opens before confirming");
    await ask.getByRole("button", { name: "Open link" }).click();
    await eventually(() => page.evaluate(() => window.__gcTestOpened), ["https://example.org/projekt"], "after confirming exactly this link goes to the system");
    const url = page.url();
    await article.locator("[data-inert]").first().click();
    await article.locator('[data-href="https://example.org/klick"]').click();
    await ask.waitFor();
    await page.keyboard.press("Escape");
    await eventually(() => ask.count(), 0, "Esc cancels");
    equal(await page.evaluate(() => [window.__gcTestOpened.length, window.__evil ?? null]), [1, null], "javascript: link and onclick do nothing");
    equal(page.url(), url, "the app did not navigate");

    // Toggle via keyboard: arrow left picks "Source".
    await screen.locator('[aria-label="Markdown"] [data-state="on"]').focus();
    await page.keyboard.press("ArrowLeft");
    await screen.locator(".cm-content").waitFor();
    check((await text()).includes("<script>window.__evil"), "the source shows the file unchanged");
    equal(await screen.locator("article[data-md-preview]").count(), 0, "no preview anymore");

    // When editing, the preview shows the unsaved text.
    await open(FILES.evil, null, "edit");
    equal(await screen.locator('[aria-label="Markdown"] [data-state="on"]').innerText(), "Source", "editing opens in source");
    await typeAtEnd("## Nachtrag");
    await screen.locator('[aria-label="Markdown"] [data-value="preview"]').click();
    await eventually(() => article.locator("h2").allInnerTexts(), ["Nachtrag"], "the preview shows the unsaved addendum");
    equal(await attr("data-dirty-state"), "dirty", "still unsaved");
    await screen.locator("[data-back]").click();
    await page.getByRole("dialog").getByRole("button", { name: /Don’t save/ }).click();
    await eventually(async () => (await ui.center())?.kind, "graph", "closed without saving");
    equal(read(FILES.evil).toString("utf8"), EVIL_MD, "the file is unchanged");
    equal(await page.evaluate(() => window.__evil ?? null), null, "no script ran up to the end");
  });

  // -------------------------------------------------------------------------------------------
  await section("Version from a commit", async () => {
    await open(FILES.station, shas.stationFirst, "view");
    equal(await screen.locator("[data-stand]").innerText(), `Commit ${shas.stationFirst.slice(0, 7)}`, "state: short SHA");
    equal(await text(), git("show", `${shas.stationFirst}:${FILES.station}`).concat("\n"), "the text matches git show");
    equal(await attr("data-mode"), "view", "read-only");
    equal(await screen.locator('[aria-label="Mode"]').count(), 0, "no view/edit toggle");
    equal(await screen.getByRole("button", { name: "Save", exact: true }).count(), 0, "no \"Save\"");
    equal(await screen.getByRole("button", { name: "Open in external editor" }).isDisabled(), true, "\"Open in external editor\" is only for the working directory");
    equal(await screen.locator('[data-footer-menu="encoding"]').isDisabled(), true, "encoding cannot be changed");
    await shot("file-view-commit");
    await screen.getByRole("button", { name: /^edit/i }).click();
    await ready(FILES.station);
    equal([await attr("data-mode"), await screen.locator("[data-stand]").innerText()], ["edit", "Working directory"], "\"Edit in working directory\" switches to the file on disk");

    // The file does not exist (anymore) in this commit.
    await open(FILES.deleted, shas.exportDeleted, "view");
    await screen.locator('[data-notice="gone"]').waitFor();
    check((await screen.locator('[data-notice="gone"]').innerText()).includes(shas.exportDeleted.slice(0, 7)), "the notice names the commit");
    await open(FILES.deleted, shas.exportChanged, "view");
    equal(await text(), "datum;wert\n2026-01-01;1,5\n2026-01-02;2,0\n", "the version before the deletion can be viewed");
  });

  // -------------------------------------------------------------------------------------------
  await section("Binary file, image, too large, missing", async () => {
    await open(FILES.binary, null, "view");
    await screen.locator('[data-notice="binary"]').waitFor();
    check((await screen.locator('[data-notice="binary"]').innerText()).includes("isn’t text"), "binary file: clear notice");
    equal(await screen.locator("[data-file-footer]").count(), 0, "no footer with encoding");
    equal(await screen.getByRole("button", { name: "Blame", exact: true }).isDisabled(), true, "blame is disabled for binary files");
    await shot("file-view-binary");

    await open(FILES.image, null, "view");
    const image = screen.locator("[data-image-preview] img");
    await image.waitFor();
    await eventually(() => image.evaluate((element) => [element.naturalWidth, element.naturalHeight, element.src.startsWith("data:image/png")]), [96, 64, true], "the image is shown as an image (data: URL, 96 × 64)");
    await until(async () => (await screen.locator("[data-image-preview] figcaption").innerText()).includes("96 × 64 px"), "the dimensions are shown below");
    await shot("file-view-image");

    write(TOO_LARGE, "Messwert 0000000: 12,5 °C\n".repeat(230_000));
    await open(TOO_LARGE, null, "view");
    await screen.locator('[data-notice="too-large"]').waitFor();
    check((await screen.locator('[data-notice="too-large"]').innerText()).includes("5 MB"), "too large: the notice names the limit");
    await shot("file-view-too-large");
    fs.rmSync(path.join(fx.repo.path, TOO_LARGE));

    await open("gibt/es/nicht.txt", null, "view");
    const gone = screen.locator('[data-notice="gone"]');
    await gone.waitFor();
    check((await gone.innerText()).includes("exist in the working directory"), "missing file: clear notice");
    await shot("file-view-missing");
    await gone.getByRole("button", { name: "Show history" }).click();
    await page.locator('[data-screen="file-history"]').waitFor();
    await page.keyboard.press("Escape");
    await eventually(async () => (await ui.center())?.kind, "file", "Esc in the history returns to the file view");
  });

  // -------------------------------------------------------------------------------------------
  await section("Create new file", async () => {
    await ui.runCommand("new file", "file.new");
    const dialog = page.getByRole("dialog", { name: "Create new file" });
    await dialog.waitFor();
    await page.keyboard.type("src/station.py");
    await until(async () => (await dialog.innerText()).includes("This file already exists"), "an existing path is rejected");
    await page.keyboard.press("Control+a");
    await page.keyboard.type("../draussen.txt");
    await until(async () => (await dialog.innerText()).includes("not allowed"), "\"..\" is rejected");
    await shot("file-view-new-file");
    await page.keyboard.press("Control+a");
    await page.keyboard.type(NEW_FILE);
    await until(async () => !(await dialog.getByRole("button", { name: "Create" }).isDisabled()), "valid path: \"Create\" is enabled");
    await page.keyboard.press("Enter");
    await ready(NEW_FILE);
    check(exists(NEW_FILE) && read(NEW_FILE).length === 0, "the file exists empty in the working directory (folder created)");
    equal(await attr("data-mode"), "edit", "it opens in the editor");
    equal(git("status", "--porcelain", "--untracked-files=all", "--", "notizen"), "?? notizen/neu.md", "git status: new file");
    await until(async () => (await ui.focused())?.inEditor, "focus is in the empty text");
    await page.keyboard.type("# Notizen");
    await page.keyboard.press("Control+s");
    await eventually(() => read(NEW_FILE).toString("utf8"), "# Notizen", "typing and Ctrl+S write the new file");
    await eventually(() => attr("data-dirty-state"), "clean", "saved");
    await page.keyboard.press("Shift+Tab");
    check(!(await ui.focused())?.inEditor, "Shift+Tab leaves the text");
    await page.keyboard.press("Escape");
    await eventually(async () => (await ui.center())?.kind, "graph", "a single Esc on a button (even with an open tooltip) closes the view");
    equal(await ui.dialogs(), [], "without confirmation");

    // From the commit panel: file context menu → "Create new file …" with the folder in the field.
    const row = page.locator(`[data-row-key=${JSON.stringify(NEW_FILE)}]`).first();
    await row.waitFor();
    await row.click({ button: "right" });
    await ui.menuItem("Create new file …").click();
    await dialog.waitFor();
    equal(await dialog.locator("input").inputValue(), "notizen/", "the folder of the chosen file is already in the field");
    await page.keyboard.press("Escape");
    await eventually(() => dialog.count(), 0, "Esc cancels");
    equal(fs.readdirSync(path.join(fx.repo.path, "notizen")), ["neu.md"], "cancelling creates nothing");
  });

  // -------------------------------------------------------------------------------------------
  await section("Delete file: from the commit panel and as a command, with undo", async () => {
    // If the built debug app does not know the core command file_delete yet, only check that
    // nothing is lost – and the script says clearly that the rest is unchecked.
    const probe = await app.invoke("file_delete", { repoId, path: "gibt/es/nicht.txt" }).then(
      () => "ok",
      (error) => `${error.code}: ${error.message}`,
    );
    if (/Command file_delete not found/.test(probe)) {
      if (!exists(NEW_FILE)) write(NEW_FILE, "# Notizen");
      await open(NEW_FILE, null, "view");
      await ui.runCommand("delete file", "file.delete");
      await page.getByRole("dialog", { name: "Delete “neu.md”?" }).getByRole("button", { name: "Delete", exact: true }).click();
      await until(async () => (await page.locator('[data-toast="danger"]').count()) > 0, "without the core command the app reports an error");
      check(exists(NEW_FILE), "and the file stays");
      await closeToasts(page);
      measurements.push("NOT CHECKED: delete file – the built debug app does not know file_delete yet (command is in the source, app not rebuilt)");
      console.log("  ! delete file not checkable: debug app without file_delete");
      return;
    }
    check(probe.startsWith("not_found"), `precondition: file_delete reports a missing file as not_found (${probe})`);
    if (!exists(NEW_FILE)) write(NEW_FILE, "# Notizen");
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    const undoFromToast = () => page.locator("[data-toast]").getByRole("button", { name: "Undo" }).first().click();
    const ask = (name) => page.getByRole("dialog", { name: `Delete “${name}”?` });

    // New (untracked) file via the context menu in the commit panel.
    const row = page.locator(`[data-row-key=${JSON.stringify(NEW_FILE)}]`).first();
    await row.waitFor();
    await row.click({ button: "right" });
    await ui.menuItem("Delete file …").click();
    await ask("neu.md").waitFor();
    check((await ask("neu.md").innerText()).includes(NEW_FILE), "the confirmation names the path");
    await shot("file-view-confirm-delete");
    await page.keyboard.press("Escape");
    await eventually(() => ask("neu.md").count(), 0, "Esc cancels");
    check(exists(NEW_FILE), "after cancelling the file is still there");
    await row.click({ button: "right" });
    await ui.menuItem("Delete file …").click();
    await ask("neu.md").getByRole("button", { name: "Delete", exact: true }).click();
    await eventually(() => exists(NEW_FILE), false, "after confirming the file is deleted");
    await until(async () => (await ui.toasts()).some((line) => line.includes("deleted")), "message with undo");
    await undoFromToast();
    await eventually(() => exists(NEW_FILE) && read(NEW_FILE).toString("utf8"), "# Notizen", "undo brings the file back with its content");
    await closeToasts(page);

    // Tracked file, open in the editor: command via the palette (keyboard only up to the confirmation).
    const before = read(FILES.crlf);
    await open(FILES.crlf, null, "view");
    await ui.runCommand("delete file", "file.delete");
    await ask("crlf.txt").waitFor();
    await ui.tabTo((now) => now.text === "Delete", "Tab reaches \"Delete\"", { max: 4 });
    await page.keyboard.press("Enter");
    await eventually(() => exists(FILES.crlf), false, "the file is removed from the working directory");
    equal(gitRaw(["status", "--porcelain", "--", FILES.crlf]).toString("utf8"), " D text/crlf.txt\n", "git status: deleted, not staged (the index stays)");
    await eventually(async () => (await ui.center())?.kind, "graph", "the view of the deleted file closes");
    await undoFromToast();
    await eventually(() => exists(FILES.crlf) && read(FILES.crlf).equals(before), true, "undo brings the file back byte-exact");
    await eventually(() => git("status", "--porcelain", "--", FILES.crlf), "", "git status: clean again");
  });

  // -------------------------------------------------------------------------------------------
  await section("Very long file: 20,000 lines", async () => {
    const started = Date.now();
    await open(FILES.big, null, "view");
    await screen.locator(".cm-content").waitFor();
    measurements.push(`opening 20,000 lines: ${Date.now() - started} ms`);
    check((await screen.locator("[data-file-footer]").innerText()).includes("20,001 lines"), "footer: line count with thousands separator");
    const result = await measureScroll(page, `${SCREEN} .cm-scroller`);
    measurements.push(`scrolling 20,000 lines: ${formatMeasure(result)}`);
    check(result.avg < 34 && result.p95 < 67, `scrolls smoothly – ${formatMeasure(result)}`);
    check(result.maxRows < 400 && !result.blank, `CodeMirror draws only the visible part (${result.maxRows} rows), never blank`);

    // Very long line: wrapping on and off.
    write("text/lange-zeile.txt", `${"Die Station misst Temperatur, Luftfeuchte, Regen und Wind. ".repeat(60)}\nkurz\n`);
    await open("text/lange-zeile.txt", null, "view");
    const scroller = screen.locator(".cm-scroller");
    check(await scroller.evaluate((element) => element.scrollWidth > element.clientWidth + 100), "without wrapping the long line scrolls horizontally");
    await screen.getByRole("button", { name: "Wrap long lines" }).click();
    await until(() => scroller.evaluate((element) => element.scrollWidth <= element.clientWidth + 2), "with wrapping everything fits the width");
    await shot("file-view-long-line");
    await screen.getByRole("button", { name: "Wrap long lines" }).click();
    fs.rmSync(path.join(fx.repo.path, "text/lange-zeile.txt"));
  });

  // -------------------------------------------------------------------------------------------
  await section("Minimum size and light theme", async () => {
    await open(FILES.station, null, "edit");
    await typeAtEnd("# ungespeichert");
    await app.setSize(960, 600);
    await page.waitForTimeout(300);
    const fits = await screen.evaluate((root) => {
      const header = root.querySelector("[data-file-header]");
      return { overflow: header.scrollWidth - header.clientWidth, buttons: Array.from(header.querySelectorAll("button")).every((button) => button.getBoundingClientRect().right <= root.getBoundingClientRect().right + 1) };
    });
    equal(fits, { overflow: 0, buttons: true }, "at 960×600 the header fits, no button sticks out");
    equal(await screen.getByRole("button", { name: "Save", exact: true }).isVisible(), true, "\"Save\" stays visible");
    await shot("file-view-min");
    await app.setTheme("light");
    await shot("file-view-min-light");
    await app.setSize(1440, 900);
    await shot("file-view-light");
    await app.setTheme("dark");
    await screen.locator("[data-back]").click();
    await page.getByRole("dialog").getByRole("button", { name: /Don’t save/ }).click();
    await eventually(async () => (await ui.center())?.kind, "graph", "closed");
  });

  // -------------------------------------------------------------------------------------------
  await section("Console", async () => {
    equal(app.consoleErrors, [], "console errors");
  });
} catch (error) {
  checks.failures.push(`Aborted: ${error?.stack ?? error}`);
} finally {
  await finish("file-view", checks, app, () => fx.repo.cleanup());
}
