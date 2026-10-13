/**
 * Shared helpers for the E2E scripts of settings (settings), remote-dialog (remote dialog) and activity-log (activity log):
 * failure counter, waiting for states, keyboard navigation with a check of where the focus is.
 */
import { execFileSync } from "node:child_process";

export function createChecks() {
  const failures = [];
  let current = "";
  const check = (condition, message) => {
    if (!condition) {
      failures.push(`${current}: ${message}`);
      console.log(`  ✗ ${message}`);
    }
    return Boolean(condition);
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const equal = (actual, expected, message) => check(same(actual, expected), `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  /** Like `equal`, but waits until the value matches – the UI answers asynchronously, slowly under load. */
  const eventually = async (read, expected, message, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    let actual = await read();
    while (!same(actual, expected) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      actual = await read();
    }
    return equal(actual, expected, message);
  };
  /** Waits until `read()` returns something truthy. */
  const until = async (read, message, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    let value = await read();
    while (!value && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      value = await read();
    }
    check(value, message);
    return value;
  };
  const section = async (name, run) => {
    current = name;
    const before = failures.length;
    const started = Date.now();
    try {
      await run();
    } catch (error) {
      check(false, `aborted: ${error?.stack ?? error}`);
    }
    console.log(`${failures.length === before ? "✓" : "✗"} ${name} (${Date.now() - started} ms)`);
  };
  return { failures, check, equal, eventually, until, section, setCurrent: (name) => (current = name) };
}

/** Helpers bound to a running instance. */
export function pageHelpers(app) {
  const { page } = app;

  /** Accessible name of the focused element (aria-label, aria-labelledby, <label for>, else its text). */
  const focusedName = () =>
    page.evaluate(() => {
      const element = document.activeElement;
      if (!element || element === document.body) return null;
      const aria = element.getAttribute("aria-label");
      if (aria) return aria.trim();
      const ids = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
      const labelled = ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim();
      if (labelled) return labelled;
      const label = element.id ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`) : null;
      if (label?.textContent) return label.textContent.trim();
      return (element.textContent ?? "").trim().replace(/\s+/g, " ");
    });

  const matches = (name, wanted) => (name === null ? false : wanted instanceof RegExp ? wanted.test(name) : name === wanted);

  /**
   * Presses Tab (or Shift+Tab) until the element with this name has focus – the way a person
   * without a mouse would get there. Throws if it is not reachable within `max` steps.
   */
  const tabTo = async (wanted, { back = false, max = 60 } = {}) => {
    const seen = [];
    for (let step = 0; step <= max; step++) {
      const name = await focusedName();
      if (step > 0 && matches(name, wanted)) return name;
      seen.push(name);
      await page.keyboard.press(back ? "Shift+Tab" : "Tab");
    }
    throw new Error(`Not reachable by Tab: ${wanted}. Visited: ${seen.join(" → ")}`);
  };

  /** Clear the field and refill it, keyboard only. */
  const retype = async (text) => {
    await page.keyboard.press("Control+a");
    if (text === "") await page.keyboard.press("Delete");
    else await page.keyboard.type(text);
  };

  const toasts = () => page.locator("[data-toast]").allInnerTexts();
  /** Closes all toasts. Via script click: under a modal dialog the rest of the page takes no pointer events. */
  const closeToasts = async () => {
    for (let round = 0; round < 12; round++) {
      const closed = await page.evaluate(() => {
        const button = document.querySelector('[data-toast] button[aria-label="Close message"]');
        button?.click();
        return Boolean(button);
      });
      if (!closed) break;
      await page.waitForTimeout(60);
    }
  };
  const waitToast = async (pattern, timeoutMs = 10_000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const texts = await toasts();
      const hit = texts.find((text) => pattern.test(text));
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error(`No toast matching ${pattern}. Visible: ${JSON.stringify(texts)}`);
      await page.waitForTimeout(80);
    }
  };

  /** Titles of all open dialogs, bottom one first. */
  const dialogs = () =>
    page.locator('[role="dialog"]').evaluateAll((list) => list.map((dialog) => dialog.getAttribute("aria-label") ?? dialog.querySelector("h2")?.textContent ?? ""));

  /**
   * Does anything break the layout? Returns texts of elements sticking out sideways from the box, and of
   * areas inside it that would have to scroll horizontally (too-wide content would be hidden there).
   * Empty list = everything fits.
   */
  const escaping = (selector) =>
    page.evaluate((target) => {
      const root = document.querySelector(target);
      const box = root?.getBoundingClientRect();
      if (!root || !box) return ["box missing"];
      const out = [];
      if (document.documentElement.scrollWidth > document.documentElement.clientWidth) out.push("the page scrolls horizontally");
      for (const element of [root, ...root.querySelectorAll("*")]) {
        const overflow = getComputedStyle(element).overflowX;
        if ((overflow === "auto" || overflow === "scroll") && element.scrollWidth > element.clientWidth + 1) {
          out.push(`scrolls horizontally: ${(element.getAttribute("aria-label") ?? element.textContent ?? element.tagName).trim().slice(0, 40)}`);
        }
      }
      for (const element of root.querySelectorAll("*")) {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        // Anything inside a scrolling or clipping ancestor is not visibly outside.
        let clipped = false;
        for (let parent = element.parentElement; parent && !parent.matches(target); parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          if (style.overflowX !== "visible" || style.overflowY !== "visible") {
            clipped = true;
            break;
          }
        }
        if (!clipped && (rect.right > box.right + 1 || rect.left < box.left - 1)) out.push((element.textContent ?? element.tagName).trim().slice(0, 40));
      }
      return out;
    }, selector);

  const store = (run, arg) => page.evaluate(([code, value]) => new Function("store", "value", `return (${code})(store, value)`)(window.__gc.store.getState(), value), [run.toString(), arg]);

  /**
   * Loading and error state of a query, which the real core cannot produce – simulated at the core
   * boundary: the command `method` (e.g. "remotesList") hangs, the view loads; `fail()` makes it really
   * fail, `restore()` puts the real command back.
   *
   * Just switching the query state by hand (query.setState) does not hold: every core event reloads the
   * query and the error disappears by itself – sometimes right between "button found" and "button
   * pressed" (remote-dialog and activity-log ran into a timeout that way). This way every reload fails too, until the test
   * restores the command.
   */
  const breakQuery = async (method, queryKey, message) => {
    await page.evaluate(
      ([name, key, text]) => {
        const core = window.__gc.core;
        const failure = () => Object.assign(new Error(text), { code: "io", gitOutput: null });
        const hanging = [];
        core[name] = () => new Promise((_resolve, reject) => hanging.push(reject));
        window.__gcBroken = {
          fail() {
            core[name] = async () => {
              throw failure();
            };
            for (const reject of hanging.splice(0)) reject(failure());
          },
          restore() {
            delete core[name];
          },
        };
        void window.__gc.queryClient.resetQueries({ queryKey: key });
      },
      [method, queryKey, message],
    );
    return {
      fail: () => page.evaluate(() => window.__gcBroken.fail()),
      restore: () => page.evaluate(() => window.__gcBroken.restore()),
      /**
       * Presses the button `label` under `root` – and restores the real command exactly with this
       * click. Until then every reload triggered by a core event fails too: the error stays until the
       * button is pressed. (Restoring first, then clicking went wrong: if an event came in between, the
       * query reloaded by itself and the button was gone.)
       */
      restoreAndPress: async (root, label) => {
        await page.evaluate(
          ([scope, text]) => {
            const onClick = (event) => {
              const button = event.target instanceof Element ? event.target.closest("button") : null;
              if (!button || !button.closest(scope) || (button.textContent ?? "").replace(/\s+/g, " ").trim() !== text) return;
              document.removeEventListener("click", onClick, true);
              window.__gcBroken.restore();
            };
            document.addEventListener("click", onClick, true);
          },
          [root, label],
        );
        await page.locator(root).getByRole("button", { name: label, exact: true }).first().click();
        return true;
      },
    };
  };

  return { focusedName, tabTo, retype, toasts, closeToasts, waitToast, dialogs, escaping, store, breakQuery };
}

/** Run git with a specific global config (e.g. the app's) – returns stdout without trailing newline, "" on exit ≠ 0. */
export function gitWithGlobal(globalConfigPath, args, cwd = process.cwd()) {
  try {
    return execFileSync("git", args, {
      cwd,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: globalConfigPath, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
      .toString("utf8")
      .replace(/\r?\n$/, "");
  } catch {
    return "";
  }
}

/** git in a repository without advancing the fixture clock; "" on exit ≠ 0 (e.g. key not set). */
export function gitIn(repoPath, args) {
  try {
    return execFileSync("git", args, { cwd: repoPath, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
      .toString("utf8")
      .replace(/\r?\n$/, "");
  } catch {
    return "";
  }
}

export function finish(name, failures) {
  console.log(failures.length ? `\n${name}: ${failures.length} failures.\n${failures.map((line) => `  - ${line}`).join("\n")}` : `\n${name}: green.`);
  process.exit(failures.length ? 1 : 0);
}
