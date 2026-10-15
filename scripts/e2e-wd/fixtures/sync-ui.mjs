/**
 * Helpers for the sync feature (scripts/e2e-wd/features/sync.mjs): toolbar buttons, toasts (recorded,
 * even after they vanished), dialogs, checkboxes, the command palette, the preferences, a counter of
 * credential prompts and git in temp repositories without locks.
 *
 *   const ui = syncUi(app);
 *   await ui.install();                       // toast recorder + credential counter (after every launch/reload)
 *   await ui.clickTool("Fetch");
 *   await ui.waitToast(/Fetch complete/, "success");
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Environment for git calls of the test itself: no machine config, no locks, no prompts. */
export function plainGitEnv() {
  return { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
}

/** git in `cwd` (synchronous; never against a server that runs in this process). */
export function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: plainGitEnv(), stdio: ["ignore", "pipe", "pipe"] }).toString("utf8").trim();
}

/** git in `cwd`, asynchronous – for calls against the HTTP/SSH servers of this process. */
export async function gitAsync(cwd, ...args) {
  const { stdout } = await execFileAsync("git", args, { cwd, env: plainGitEnv() });
  return stdout.toString().trim();
}

/** `git rev-parse` that yields null instead of throwing. */
export function revParse(cwd, ref) {
  try {
    return git(cwd, "rev-parse", "--verify", "-q", ref);
  } catch {
    return null;
  }
}

/** A port nobody listens on right now. */
export function closedPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Appends to the global gitconfig the app runs with. */
export function appendAppGitConfig(app, text) {
  fs.appendFileSync(app.gitConfigPath, text);
}

export const slash = (file) => path.resolve(file).replaceAll("\\", "/");

/** Proxy variables of the machine must not reach the app. */
export const NO_PROXY_ENV = Object.fromEntries(["NO_PROXY", "no_proxy", "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"].map((name) => [name, ""]));

export function syncUi(app) {
  const exec = (...args) => app.exec(...args);

  const install = () =>
    exec(() => {
      if (window.__syncInstalled) return true;
      window.__syncInstalled = true;
      window.__syncToasts = [];
      window.__syncCredentials = [];
      window.__gc.core.on("credential:request", (request) => window.__syncCredentials.push({ kind: request.kind, host: request.host ?? null, prompt: request.prompt ?? null, canRemember: request.canRemember ?? null }));
      const record = () => {
        for (const element of document.querySelectorAll("[data-toast]")) {
          const text = `${element.getAttribute("data-toast")}|${element.innerText.replace(/\s+/g, " ").trim()}`;
          if (!window.__syncToasts.includes(text)) window.__syncToasts.push(text);
        }
      };
      new MutationObserver(record).observe(document.body, { childList: true, subtree: true, characterData: true });
      record();
      return true;
    });

  const seenToasts = async () => (await exec(() => window.__syncToasts?.slice() ?? [])).map((line) => ({ tone: line.slice(0, line.indexOf("|")), text: line.slice(line.indexOf("|") + 1) }));
  const forgetToasts = () => exec(() => void (window.__syncToasts.length = 0));
  const toasts = () =>
    exec(() => [...document.querySelectorAll("[data-toast]")].map((item) => ({ tone: item.getAttribute("data-toast"), text: item.innerText.replace(/\s+/g, " ").trim() })));

  /** Waits for a toast (also one that already disappeared) and returns it. */
  const waitToast = async (pattern, tone = null, timeout = 30_000) => {
    try {
      return await app.waitFor(async () => (await seenToasts()).find((toast) => pattern.test(toast.text) && (!tone || toast.tone === tone)) ?? null, timeout, { interval: 100 });
    } catch {
      throw new Error(`toast ${pattern}${tone ? ` (${tone})` : ""} missing; seen: ${JSON.stringify(await seenToasts())}`);
    }
  };
  const dangerToasts = async () => (await seenToasts()).filter((toast) => toast.tone === "danger");

  const closeToasts = async () => {
    for (let round = 0; round < 12; round++) {
      const closed = await exec(() => {
        const button = [...document.querySelectorAll("[data-toast] button")].find((item) => item.getAttribute("aria-label") === "Close message");
        if (!button) return false;
        button.click();
        return true;
      });
      if (!closed) return;
      await sleep(80);
    }
  };

  /** Toolbar button of the repository toolbar by its visible label ("Fetch", "Pull", "Push" …). */
  const toolButton = (label) =>
    exec((wanted) => {
      const bar = [...document.querySelectorAll('[role="toolbar"]')].find((item) => item.getAttribute("aria-label") === "Repository actions");
      const named = (button) => {
        const aria = button.getAttribute("aria-label");
        if (aria) return aria === wanted || aria.startsWith(`${wanted},`);
        // Label first; with a badge the count comes before it ("1\nPush\n…").
        const lines = (button.innerText ?? "").split("\n").map((line) => line.trim());
        return lines[0] === wanted || (/^\d+$/.test(lines[0]) && lines[1] === wanted);
      };
      return [...(bar?.querySelectorAll("button") ?? [])].find(named) ?? null;
    }, label);
  const toolState = (label) =>
    exec((wanted) => {
      const bar = [...document.querySelectorAll('[role="toolbar"]')].find((item) => item.getAttribute("aria-label") === "Repository actions");
      const named = (item) => {
        const aria = item.getAttribute("aria-label");
        if (aria) return aria === wanted || aria.startsWith(`${wanted},`);
        const lines = (item.innerText ?? "").split("\n").map((line) => line.trim());
        return lines[0] === wanted || (/^\d+$/.test(lines[0]) && lines[1] === wanted);
      };
      const button = [...(bar?.querySelectorAll("button") ?? [])].find(named);
      if (!button) return null;
      const hint = document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent ?? "";
      return { disabled: button.getAttribute("aria-disabled") === "true", busy: button.getAttribute("aria-busy") === "true", label: button.getAttribute("aria-label"), hint };
    }, label);
  const clickTool = async (label) => {
    const button = await app.waitFor(() => toolButton(label), 15_000, { message: `toolbar button ${label}` });
    await button.click();
  };
  /** Waits until a toolbar button is enabled (status after the last action is loaded). */
  const waitToolEnabled = (label, timeout = 20_000) => app.waitFor(async () => (await toolState(label))?.disabled === false, timeout, { message: `${label} is enabled` });

  /** Topmost open dialog: { title, text } or null. */
  const dialog = () =>
    exec(() => {
      const list = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')];
      const top = list.at(-1);
      if (!top) return null;
      // Radix registers a new modal layer a frame after it took focus; until then it is not the top
      // layer (no pointer-events: auto) and Esc or Enter go to whatever lies beneath.
      return { title: top.querySelector("h2")?.textContent?.trim() ?? "", text: top.innerText.replace(/\s+/g, " ").trim(), onTop: top.style.pointerEvents === "auto" };
    });
  const waitDialog = async (pattern, timeout = 20_000) => {
    try {
      return await app.waitFor(async () => {
        const top = await dialog();
        return top && top.onTop && pattern.test(top.title) ? top : null;
      }, timeout, { interval: 100 });
    } catch {
      throw new Error(`dialog ${pattern} missing; open: ${JSON.stringify(await dialog())}; toasts: ${JSON.stringify(await seenToasts())}`);
    }
  };
  const waitNoDialog = (timeout = 15_000) => app.waitFor(async () => (await dialog()) === null, timeout, { message: "all dialogs closed" });
  /** Button of the topmost dialog by its text (exact, trimmed) or aria-label. */
  const dialogButton = (text) =>
    exec((wanted) => {
      const top = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].at(-1);
      const buttons = [...(top?.querySelectorAll("button") ?? [])];
      return (
        buttons.find((button) => (button.innerText ?? "").trim() === wanted || button.getAttribute("aria-label") === wanted) ??
        buttons.find((button) => (button.innerText ?? "").trim().split("\n")[0] === wanted) ??
        null
      );
    }, text);
  const clickDialogButton = async (text) => {
    const button = await app.waitFor(() => dialogButton(text), 15_000, { message: `dialog button "${text}"` });
    await button.click();
  };
  /** Field of the topmost dialog (or `within`) by its label text. */
  const field = (label, within = null) =>
    exec(
      (wanted, scope) => {
        const root = scope ? document.querySelector(scope) : [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].at(-1) ?? document;
        const labels = [...(root?.querySelectorAll("label") ?? [])];
        const match = labels.find((item) => (item.childNodes[0]?.textContent ?? item.textContent ?? "").trim() === wanted);
        if (!match) return null;
        return (match.htmlFor && document.getElementById(match.htmlFor)) || match.querySelector("input, textarea, button") || null;
      },
      label,
      within,
    );
  const waitField = (label, within = null) => app.waitFor(() => field(label, within), 15_000, { message: `field "${label}"` });
  /** Clears an input (React-controlled) and types new text with real key strokes. */
  const retype = async (element, text) => {
    await element.click();
    await app.press("Control+a", "Backspace");
    if (text) await element.type(text);
  };
  const checked = (element) => element.attr("data-state").then((state) => state === "checked");

  /** Active element: { tag, text, label, role }. */
  const focused = () =>
    exec(() => {
      const element = document.activeElement;
      return { tag: element?.tagName ?? null, text: (element?.textContent ?? "").trim(), label: element?.getAttribute("aria-label") ?? element?.labels?.[0]?.childNodes[0]?.textContent?.trim() ?? null, role: element?.getAttribute("role") ?? null };
    });

  /** Runs a command through the command palette (Ctrl+P, ">" + text, arrow keys, Enter). */
  const runCommand = async (text, commandId) => {
    await exec(() => document.activeElement?.blur?.());
    await app.press("Control+p");
    const input = await app.waitFor('[data-screen="command-palette"] input[role="combobox"]', 10_000);
    await input.type(`>${text}`);
    const keys = () => exec(() => [...document.querySelectorAll('[data-screen="command-palette"] [role="option"]')].map((row) => row.dataset.key));
    await app.waitFor(async () => (await keys()).includes(`command:${commandId}`), 10_000, { message: `the palette finds "${text}" (${commandId})` });
    const index = (await keys()).indexOf(`command:${commandId}`);
    for (let step = 0; step < index; step++) await app.press("ArrowDown");
    await app.press("Enter");
    await app.waitFor(async () => !(await app.$('[data-screen="command-palette"]')), 10_000, { message: "palette closed" });
  };

  /** Opens the preferences (Ctrl+,) on a section tab. */
  const openPrefs = async (tab) => {
    await exec(() => document.activeElement?.blur?.());
    await app.press("Control+,");
    await app.waitFor('[data-screen="settings"]', 10_000);
    const button = await app.waitFor(
      () => exec((name) => [...document.querySelectorAll('[data-screen="settings"] [role="tab"]')].find((item) => item.textContent.trim() === name) ?? null, tab),
      10_000,
      { message: `preferences tab ${tab}` },
    );
    await button.click();
    await app.waitFor(() => exec((name) => document.querySelector('[data-screen="settings"] [role="tab"][aria-selected="true"]')?.textContent.trim() === name, tab), 10_000, { message: `tab ${tab} selected` });
    await app.settle();
  };
  const closePrefs = async () => {
    await closeToasts();
    await app.press("Escape");
    await app.waitFor(async () => !(await app.$('[data-screen="settings"]')), 10_000, { message: "preferences closed" });
  };

  const credentialRequests = () => exec(() => window.__syncCredentials?.slice() ?? []);

  /** Reloads status, refs, remotes and graph of a repository (as after a repo:changed event). */
  const refresh = async () => {
    await exec(() => window.__gc.queryClient.invalidateQueries());
    await app.settle();
  };

  /** Text of the whole page (normalised spaces). */
  const pageText = () => exec(() => document.body.innerText.replace(/\s+/g, " "));

  return {
    install,
    seenToasts,
    forgetToasts,
    toasts,
    waitToast,
    dangerToasts,
    closeToasts,
    toolButton,
    toolState,
    clickTool,
    waitToolEnabled,
    dialog,
    waitDialog,
    waitNoDialog,
    dialogButton,
    clickDialogButton,
    field,
    waitField,
    retype,
    checked,
    focused,
    runCommand,
    openPrefs,
    closePrefs,
    credentialRequests,
    refresh,
    pageText,
  };
}
