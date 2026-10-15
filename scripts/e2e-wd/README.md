# WebDriver E2E harness

End-to-end tests against the **real desktop app** (debug build) over W3C WebDriver. Works on
Linux today; Windows is prepared but untested. It complements the CDP driver in `scripts/e2e/`,
which only runs on Windows.

```
feature script ──HTTP──> tauri-driver ──> WebKitWebDriver (Linux) / msedgedriver (Windows)
                                              └── starts target/e2e-wd/bin/<mtime>/forkyard
                                                    └── loads the UI from the harness Vite server (port 1431+)
```

## Quick start

```bash
npm run e2e:wd:prepare          # cargo build, copy the app to target/e2e-wd/bin/<mtime>/, start Vite
npm run e2e:wd                  # run every feature, 4 at a time
node scripts/e2e-wd/run.mjs smoke              # features whose file name contains "smoke"
node scripts/e2e-wd/run.mjs --only "graph"     # only scenarios whose name contains "graph"
node scripts/e2e-wd/run.mjs --repeat 4 smoke   # 4 copies at once (isolation check)
node scripts/e2e-wd/run.mjs --jobs 2           # other parallelism
node scripts/e2e-wd/features/smoke.mjs         # one feature directly
node scripts/e2e-wd/driver.mjs --status | --start-vite | --stop-vite
```

Output:

| What | Where |
| --- | --- |
| Result per feature (JSON) | `target/e2e-wd/results/<feature>.json` |
| Screenshots (incl. `FAIL-<scenario>.png`) | `target/e2e-wd/shots/<feature>/` |
| Log per feature (run.mjs) | `target/e2e-wd/logs/<feature>.log` |
| Vite server state and log | `target/e2e-wd/vite.json`, `target/e2e-wd/vite.log` |

`run.mjs` exits with 1 if any feature fails or writes no results.

## Requirements

**Linux:** `tauri-driver` (`cargo install tauri-driver --locked`), `WebKitWebDriver`
(`apt install webkit2gtk-driver`) and `Xvfb` (`apt install xvfb`), plus the usual Tauri build
dependencies. Without root, unpack the packages into a folder and point `E2E_TOOLS_ROOT` at it
(default `target/e2e-tools/root`, layout `usr/bin/Xvfb`, `usr/bin/WebKitWebDriver`,
`usr/lib/x86_64-linux-gnu/…`); the driver then sets `LD_LIBRARY_PATH` for them. Tools on PATH win.
Explicit paths: `E2E_TAURI_DRIVER`, `E2E_NATIVE_DRIVER`, `E2E_XVFB`.

**Windows (untested):** `tauri-driver` plus `msedgedriver` matching the installed WebView2 version
(on PATH or `E2E_NATIVE_DRIVER`). No Xvfb: the window opens on the desktop. Everything else
(ports, data dir, keychain service, Vite) works the same way.

**macOS:** not supported (no WebDriver for WKWebView).

## Isolation

Every `launchApp()` gets:

- its own **Xvfb display** (Xvfb picks a free number itself, `-displayfd`), screen slightly larger
  than the window, scale 1, `GDK_BACKEND=x11`;
- its own **tauri-driver port and native port** (free ports, retried if taken);
- its own temp folder `$TMPDIR/fy-e2e-wd-*` with the **data directory** (`FORKYARD_DATA_DIR`), a
  **global gitconfig** (`GIT_CONFIG_GLOBAL`, `GIT_CONFIG_NOSYSTEM=1`, test identity from
  `scripts/e2e/fixtures.mjs`) and **XDG folders** (WebKit storage and caches);
- a unique **keychain service** (`FORKYARD_KEYRING_SERVICE=forkyard-test-wd-<hash>`); on close the
  entries are cleared with `secret-tool` when it is installed;
- `FORKYARD_WINDOW_SIZE`, `FORKYARD_AVATAR_URL=off`, `FORKYARD_E2E_WINDOW=visible` (the window
  lives on the private display).

The app runs from a **copy** of `target/debug/forkyard` (with `forkyard-askpass` and
`forkyard-editor` next to it, where the core looks for them). A `cargo build` during a run does not
affect running sessions. `run.mjs` resolves the copy once and passes it as `E2E_WD_APP`; the three
newest copies are kept.

The **Vite server** is shared by all launches of this checkout: ports 1431 to 1460, no HMR, own
dependency cache (`node_modules/.vite-e2e-wd`). It identifies itself under `/__gc_root`
(`root`, `hmr: false`, `errorHook: true`), so a server of another checkout or the CDP driver's server
is never taken. With `FORKYARD_E2E_ERROR_HOOK=1` it serves `/__gc_e2e_hook.js` in front of the app:
it records `console.error`, uncaught errors, unhandled rejections and failed resource loads in
`window.__gcE2E.errors` from the very first moment.

If a feature process is killed hard, the next launch reaps its Xvfb/tauri-driver process groups
(after checking the PID still runs that program) and removes its temp folder.

## Driver API (`driver.mjs`)

```js
import { launchApp, openApps, ensureDevServer, stopDevServer, ensureAppCopy, findTools, ROOT } from "./driver.mjs";
const app = await launchApp(options);
```

`launchApp(options)` options (all optional):

| Option | Default | Meaning |
| --- | --- | --- |
| `width`, `height` | `1440`, `900` | inner window size in CSS pixels; checked after start |
| `theme` | – | `"dark"` / `"light"` (URL `?theme=`) |
| `lang` | app default (system locale) | `"en"` / `"de"` (URL `?lang=`); pass `"en"` when asserting on English texts |
| `params` | `{}` | more URL parameters, e.g. `{ scenario: "Folder.name" }` |
| `env` | `{}` | extra environment variables for the app |
| `dataDir` | fresh temp folder | data directory (for restart tests) |
| `gitIdentity` | test identity | `user.name`/`user.email` of the global gitconfig; `null` = none |
| `trustOpened` | `true` | `openRepo`/`invoke("repo_open")` trust the repository at once |
| `ignoreErrors` | `[]` | RegExps of page errors that are not counted |
| `waitForShell` | `true` | wait until `[data-shell]` is `app` or `fullpage` |
| `timeoutMs` | `90000` | start timeout |

The returned `app`:

| Member | Description |
| --- | --- |
| `openRepo(path)` → `{ repoId, tabId }` | `repo_open` via the core, waits for the active tab and settled queries |
| `$(css)` → element \| null, `$$(css)` → element[] | CSS lookup |
| `byText(text, { exact = true, regex = false, within = css })` → element \| null | innermost visible element whose text, `aria-label` or `title` matches |
| `click(target)`, `type(target, text)` | target = element, CSS selector (waited for) or `{ text, exact?, within? }` |
| `press(...combos)` | W3C key actions: `press("Enter")`, `press("Control+k")`, `press("Shift+Tab", "Escape")` |
| `waitFor(selector \| asyncFn, timeout = 15000, { interval, message })` | returns the element / the first truthy value; throws on timeout |
| `exec(fn \| bodyString, ...args)` | runs in the page (async allowed), elements pass both ways; throws with `.code`/`.gitOutput` |
| `invoke(command, args)` | core command through `__TAURI_INTERNALS__`; CoreError → Error with `.code`, `.gitOutput` |
| `errors()` → string[] | collects page errors and returns all so far (also updates `consoleErrors`) |
| `consoleErrors` | errors collected so far (filled by `errors()`, `screenshot()`, `waitFor` timeouts) |
| `screenshot(file)` → absolute path | PNG of the page, folders are created |
| `settle(maxMs)` | waits until no query/mutation runs, then two frames |
| `waitForShell()` → `"app"` \| `"fullpage"` | |
| `reload(params)` | navigates again with other URL parameters |
| `pick(...paths)` | answers for the next system file/folder dialog (`window.__gcTestPicks`) |
| `setTheme(theme)`, `size()` → `{ width, height, scale }` | |
| `webdriver(method, route, body)` | raw W3C call relative to the session |
| `close()` | ends the session, kills tauri-driver and Xvfb, removes the temp folder |
| `dataDir`, `logPath`, `gitConfigPath`, `keyringService`, `display`, `port`, `nativePort`, `binary`, `devUrl`, `startupMs` | info |

Element objects: `{ id, click(), type(text), text(), attr(name), prop(name), rect(), visible(), $(css), $$(css) }`.

## Test framework (`lib.mjs`)

```js
import { scenario, assert, assertEqual, assertIncludes, assertMatch } from "../lib.mjs";
import { makeRichRepo } from "../../e2e/fixtures.mjs";

scenario("graph renders", "main", async (t) => {
  const repo = makeRichRepo();
  try {
    const app = await t.launch({ lang: "en" });   // closed automatically after the scenario
    await app.openRepo(repo.path);
    t.step("repository opened");                 // timed step in the result JSON
    await t.shot("graph");                       // shots/<feature>/graph.png
    await t.noConsoleErrors(app);
  } finally {
    repo.cleanup();
  }
});
```

- `scenario(name, kind, fn)`: `kind` is `"main"` (main path) or `"edge"` (edge case). Scenarios of
  a file run one after another in declaration order.
- `t`: `launch(options)` → app, `app` (last launched), `step(text)`, `shot(name, app?)`,
  `noConsoleErrors(app?)`, `shotsDir`, `feature`.
- On failure every app still open in the process is screenshotted (`FAIL-<scenario>.png`).
- Assertions: `assert(cond, msg)`, `assertEqual(actual, expected, msg)` (JSON comparison),
  `assertIncludes(stringOrArray, needle, msg)`, `assertMatch(text, regexp, msg)`.
- When the process runs dry, `target/e2e-wd/results/<feature>.json` is written:
  `{ feature, declared, ran, passed, failed, ms, scenarios: [{ name, kind, status, ms, startupMs, steps, shots, consoleErrors, error }] }`
  and the exit code is 1 if a scenario failed or none ran.
- `E2E_WD_ONLY=<text>` (`run.mjs --only`) runs only matching scenarios.

Files in `features/` starting with `_` are skipped by `run.mjs` (scratch scripts).

Fixtures: reuse `scripts/e2e/fixtures.mjs` (`makeRichRepo`, `makeConflictRepo`, …), the host mock
`scripts/e2e/host-mock.mjs` and the local Git servers `scripts/e2e/git-http-server.mjs` /
`git-ssh-server.mjs`. Tests never call real services.

## Notes

- A start takes about 3 to 4 s with a warm Vite server, about 10 s when Vite starts first.
- The window is a real GTK window on Xvfb: keys go through WebKit's input path, so app shortcuts
  work; WebKitWebDriver has no CDP-style page hooks, hence the error hook in the Vite server.
- If a test turns red under load, wait for the concrete condition with `waitFor`; do not just raise
  timeouts.
