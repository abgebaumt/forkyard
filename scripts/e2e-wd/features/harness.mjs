/**
 * Checks the harness itself (driver API): error hook, window size, theme/lang parameters, exec,
 * invoke errors, $, waitFor, click, type, press, byText. Keeps the API honest for feature authors.
 *
 *   node scripts/e2e-wd/features/harness.mjs
 */
import { makeRichRepo } from "../../e2e/fixtures.mjs";
import { assert, assertEqual, assertIncludes, scenario } from "../lib.mjs";

scenario("page errors are recorded from the error hook", "edge", async (t) => {
  const app = await t.launch({ width: 1200, height: 800, lang: "en", theme: "light" });
  assertEqual(await app.size().then(({ width, height }) => [width, height]), [1200, 800], "window size");
  assertEqual(await app.exec(() => [document.documentElement.dataset.theme, document.documentElement.lang]), ["light", "en"], "theme and language");
  await app.exec(() => {
    console.error("harness-console");
    setTimeout(() => {
      throw new Error("harness-throw");
    }, 0);
    Promise.reject(new Error("harness-rejection"));
  });
  const errors = await app.waitFor(async () => {
    const all = await app.errors();
    return all.length >= 3 ? all : null;
  }, 5000, { message: "three recorded errors" });
  for (const needle of ["harness-console", "harness-throw", "harness-rejection"]) assert(errors.some((text) => text.includes(needle)), `${needle} not recorded: ${errors.join(" | ")}`);
  // These were provoked on purpose: forget them so the result file stays clean.
  app.consoleErrors.length = 0;
});

scenario("exec, invoke, waitFor, click, type, press and byText work", "edge", async (t) => {
  const repo = makeRichRepo();
  try {
    const app = await t.launch({ lang: "en" });
    assertEqual(await app.exec((a, b) => a + b, 2, 3), 5, "exec with arguments");
    assertEqual(await app.exec("return typeof document.title"), "string", "exec with a body string");
    let code = null;
    try {
      await app.invoke("repo_open", { path: "/does/not/exist/forkyard-e2e" });
    } catch (error) {
      code = error.code;
    }
    assertEqual(code, "path_not_found", "CoreError code from invoke");

    assert(await app.byText("Open", { exact: false }), "byText finds the open button");
    await app.openRepo(repo.path);
    const input = await app.waitFor("input");
    await app.click(input);
    await app.type(input, "abc");
    assertEqual(await input.prop("value"), "abc", "typed text");
    await app.press("Control+a", "Backspace");
    assertEqual(await input.prop("value"), "", "Ctrl+A, Backspace cleared the input");
    await app.click({ text: "Fetch" });
    await app.settle();
    assertIncludes(await app.exec(() => document.body.innerText), "wetterstation", "repository tab");
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});
