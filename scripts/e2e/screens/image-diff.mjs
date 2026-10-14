/**
 * Image diff in the real app against a real repository: a changed PNG side by side, swipe with the
 * divider on the keyboard, onion skin, the pixel difference with its count, the size note for images
 * of different sizes, a new image that has nothing to lay on top, light and dark.
 *
 *   node scripts/e2e/screens/image-diff.mjs                  everything (checks and screenshots)
 *   node scripts/e2e/screens/image-diff.mjs --only swipe     only sections whose title contains "swipe"
 *   node scripts/e2e/screens/image-diff.mjs --show           visible window
 */
import { launchApp } from "../driver.mjs";
import { makePng, makeRichRepo } from "../fixtures.mjs";
import { createRun } from "./mustfix-lib.mjs";

const show = process.argv.includes("--show");
const t = createRun("image-diff");
const { check, equal, eventually, section } = t;

const IMAGE = "docs/station.png";
const NEW_IMAGE = "docs/neu.png";
const fx = makeRichRepo({ dirty: false, name: "bild-demo" });
// Same size as in the repository (96 × 64), other colours.
fx.write(IMAGE, makePng(96, 64, 3));

let app = null;
try {
  app = await launchApp({ show });
  t.attach(app);
  const { page } = app;
  const { tabId } = await app.openRepo(fx.path);
  const screen = () => page.locator('[data-screen="diff"]');
  const image = () => screen().locator('[data-diff-kind="image"]');
  const mode = () => image().getAttribute("data-image-mode").catch(() => null);
  const modeButton = (name) => image().getByRole("radio", { name });
  /** Opens the diff of `file` (working directory) and waits until it is loaded. */
  const open = async (file) => {
    await page.evaluate(([tab, target]) => window.__gc.store.getState().openDiff(tab, target, { kind: "unstaged" }), [tabId, file]);
    await page.waitForFunction(
      (label) => {
        const root = document.querySelector('[data-screen="diff"]');
        return root?.getAttribute("aria-label") === label && !root.querySelector("[data-diff-loading]");
      },
      `Diff of ${file}`,
      { timeout: 30_000 },
    );
    await eventually(() => image().count(), 1, `${file} is shown as an image diff`);
  };

  // -------------------------------------------------------------------------------------------
  await section("Side by side: before and after", async () => {
    await open(IMAGE);
    await modeButton("Side by side").click();
    await eventually(mode, "side", "side by side");
    equal(await image().locator("[data-image-pane]").count(), 2, "two panes");
    await eventually(() => image().locator("img").evaluateAll((list) => list.every((img) => img.complete && img.naturalWidth === 96)), true, "both versions are loaded (96 px wide)");
    await t.shot("image-diff-side");
  });

  // -------------------------------------------------------------------------------------------
  await section("Swipe: the divider moves with the keyboard", async () => {
    await modeButton("Swipe").click();
    await eventually(mode, "swipe", "swipe");
    equal(await image().locator('[data-image-stack="swipe"]').count(), 1, "the versions lie on top of each other");
    const slider = image().getByRole("slider", { name: "Position of the divider" });
    const before = Number(await slider.getAttribute("aria-valuenow"));
    await slider.focus();
    await page.keyboard.press("ArrowRight");
    await eventually(async () => Number(await slider.getAttribute("aria-valuenow")) > before, true, "ArrowRight moves the divider");
    equal(await image().locator("[data-image-size-note]").count(), 0, "same size: no note");
    await t.shot("image-diff-swipe");
  });

  // -------------------------------------------------------------------------------------------
  await section("Onion skin and the pixel difference", async () => {
    await modeButton("Onion skin").click();
    await eventually(mode, "onion", "onion skin");
    equal(await image().getByRole("slider", { name: "Opacity of the new version" }).count(), 1, "opacity slider");
    await modeButton("Difference").click();
    await eventually(mode, "difference", "difference");
    await eventually(() => image().locator("[data-image-difference]").getAttribute("data-image-difference"), "ready", "the pixels are compared");
    check(/pixels? changed/.test(await image().locator("[data-image-difference]").innerText()), "the number of changed pixels is shown");
    await app.setTheme("dark");
    await t.shot("image-diff-difference-dark");
    await app.setTheme("light");
  });

  // -------------------------------------------------------------------------------------------
  await section("Different sizes get a note", async () => {
    fx.write(IMAGE, makePng(120, 80, 1));
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries());
    await open(IMAGE);
    await modeButton("Swipe").click();
    await eventually(mode, "swipe", "swipe");
    await eventually(() => image().locator("[data-image-size-note]").count(), 1, "the size note is there");
    check((await image().locator("[data-image-size-note]").innerText()).includes("120 × 80 px"), "it names the new size");
  });

  // -------------------------------------------------------------------------------------------
  await section("A new image has nothing to lay on top", async () => {
    fx.write(NEW_IMAGE, makePng(48, 48, 7));
    await page.evaluate(() => window.__gc.queryClient.invalidateQueries());
    await open(NEW_IMAGE);
    equal(await mode(), "side", "only one version: side by side");
    for (const name of ["Swipe", "Onion skin", "Difference"]) check(await modeButton(name).isDisabled(), `${name} is not offered`);
    await t.noErrorToast("no error toast");
  });

  equal(app.consoleErrors, [], "console errors");
} catch (error) {
  t.failures.push(`Aborted: ${error?.stack ?? error}`);
  console.error(error?.stack ?? error);
} finally {
  if (app) await app.close().catch(() => undefined);
  fx.cleanup();
}
t.finish();
