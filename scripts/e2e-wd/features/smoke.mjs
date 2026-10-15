/**
 * Smoke test of the real app over WebDriver: start -> shell -> open a fixture repository ->
 * the commit graph renders (rows + canvas with pixels) -> no console errors.
 *
 *   node scripts/e2e-wd/features/smoke.mjs
 */
import { makeRichRepo } from "../../e2e/fixtures.mjs";
import { assert, assertEqual, scenario } from "../lib.mjs";

scenario("app starts and shows the commit graph of a repository", "main", async (t) => {
  const repo = makeRichRepo();
  try {
    const app = await t.launch({ width: 1440, height: 900 });
    t.step(`app started in ${app.startupMs} ms on ${app.display ?? "the desktop"}`);
    assertEqual(await app.waitForShell(), "app", "shell state");
    assertEqual(await app.size().then(({ width, height }) => [width, height]), [1440, 900], "window size");
    await t.noConsoleErrors(app);

    await app.openRepo(repo.path);
    t.step("repository opened");
    const rows = await app.waitFor(async () => {
      const found = await app.$$('[data-row-kind="commit"]');
      return found.length >= 5 ? found : null;
    }, 20_000, { message: "at least 5 commit rows" });
    t.step(`${rows.length} commit rows`);

    // The canvas draws the lanes: it must exist, have a size and contain non-transparent pixels.
    const painted = await app.waitFor(
      () =>
        app.exec(() => {
          const canvas = document.querySelector("canvas[data-graph-canvas]");
          if (!canvas || canvas.width === 0 || canvas.height === 0) return false;
          const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, Math.min(canvas.height, 400)).data;
          for (let index = 3; index < data.length; index += 4) if (data[index] !== 0) return true;
          return false;
        }),
      10_000,
      { message: "graph canvas painted" },
    );
    assert(painted, "graph canvas is empty");
    const labelled = await app.exec(
      (branch) => [...document.querySelectorAll('[data-row-kind="commit"]')].some((row) => row.innerText.split(/\s+/).includes(branch)),
      repo.info.branch,
    );
    assert(labelled, `no commit row carries the branch label "${repo.info.branch}"`);
    await t.shot("graph");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});
