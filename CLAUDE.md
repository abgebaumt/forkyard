# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Forkyard is a local desktop Git client: **Tauri 2 + a Rust core + React 19/TypeScript**. No server, no
accounts, no telemetry. Main targets are Windows and Linux; macOS builds but is less tested.

Linux system packages (Ubuntu): `libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev libxdo-dev libdbus-1-dev`. The core itself already needs `libdbus-1-dev` (keychain via Secret Service).

The UI is English by default with German selectable (i18n, see below). Code, comments and docs are
English; German appears only as test data and in `src/i18n/locales/de`.

## Commands

```bash
npm install
npm run app                  # tauri dev: Vite on 127.0.0.1:1420 (HMR) + debug app
npm run build                # tokens + tsc + vite build (UI only)
npm run tauri build          # release bundle. NOT `cargo build --release` – such a binary does not start
npm run typecheck            # tsc --noEmit
npm test                     # vitest run (UI logic, *.test.ts next to the code)
npx vitest run src/screens/ConflictTool/model.test.ts   # single test file
npm run tokens               # design/tokens.json -> src/styles/tokens.css, theme.css
npm run check:contrast       # WCAG check of the colour pairs in design/tokens.json
npm run check:commands       # contract api.ts <-> src-tauri <-> crates/core
node scripts/find-german.mjs src/screens/Foo   # leftover German UI strings (heuristic)

cargo build                                  # target/debug/forkyard (needed by E2E and screenshots)
cargo test --workspace                       # Rust tests against real temp repositories
cargo test -p gitcore <testname>             # single Rust test
cargo clippy --workspace --all-targets       # expect 0 warnings
```

README screenshots (Linux, needs Xvfb, ImageMagick and ffmpeg): `cargo build && node scripts/screenshots/shoot.mjs` and `node scripts/screenshots/record-gif.mjs`.
The demo repository comes from `scripts/screenshots/demo-repo.mjs`, the views from `src/screens/Showcase/scenario.ts`.

### E2E (Windows only)

`scripts/e2e/driver.mjs` starts the **built debug app** (`cargo build` first) and drives WebView2 over
CDP with Playwright, using its own Vite server from port 1421 without HMR. On Linux/macOS it aborts (no CDP).

```bash
node scripts/e2e/screens/CommitPanel.mjs              # one script
node scripts/e2e/screens/CommitPanel.mjs --only hook  # only sections whose title contains "hook"
node scripts/e2e/run-all.mjs --set screens            # sets: base | screens | flows | all
node scripts/e2e/driver.mjs --status | --stop-vite
```

At most three scripts run at the same time. Logs go to `target/e2e/run-logs/`, screenshots to
`target/e2e/shots/`. If a test turns red under load, fix the cause (wait for the concrete condition),
never just raise timeouts.

## Architecture

```
React UI --invoke--> src-tauri (thin binding) --> crates/core (gitcore) --process--> git
     ^                                              |--> SQLite (app state)
     +---------------- events (repo:changed, job:*, …) ---+--> OS keychain (secrets)
```

Workspace crates:
- `crates/core` (`gitcore`): all logic, no Tauri. `commands/*.rs` has one function per command. Plus `git/` (runner, errors, redaction in `redact.rs`), `db/` (SQLite, schema in `db/schema.sql`, migrations), `secrets.rs`, `http.rs` (ureq/rustls for GitHub/GitLab), `watcher.rs`, `autofetch.rs`, `undo.rs`. Feature `testkit` provides `TestCore`/`TestRepo`. `bin/forkyard-editor.rs` is the sequence editor for interactive rebase.
- `crates/askpass`: helper for `GIT_ASKPASS`/`SSH_ASKPASS`. Forwards prompts over a local channel (127.0.0.1, one-time token) as `credential:request` to the UI. std only; `src-tauri/build.rs` compiles it with rustc as a sidecar into `src-tauri/binaries/`.
- `src-tauri`: exactly one `#[tauri::command]` per command in `commands.rs` that only delegates to `gitcore::commands`, registered in `generate_handler![…]` in `lib.rs`.

### The command contract (most important seam)

`src/core/api.ts` (`CoreCommands`) is authoritative. A new or changed command always touches **four
places**: `src/core/api.ts` (+ types in `src/core/types.ts`), `crates/core/src/commands/<area>.rs`,
`src-tauri/src/commands.rs` and `src-tauri/src/lib.rs`. Then run `npm run check:commands`. camelCase in
TS maps to snake_case in Rust. Errors always arrive as `{ code, message, gitOutput }` (`CoreError`). The
UI talks to the core only through `src/core/index.ts`.

### Hard rules

1. **Git is the source of truth.** Commits, refs, stashes and remotes are never mirrored into SQLite. SQLite holds app state only (profiles, tabs, settings, undo, activity …).
2. **One write operation per repository at a time** (queue in the core). Reads run in parallel. Background reads use `GIT_OPTIONAL_LOCKS=0`. A foreign `index.lock` is never deleted.
3. **The UI never runs Git and never builds command lines.**
4. Git runs with `LC_ALL=C`, fixed `--format` strings and `-z`. Paths and contents stay bytes / `OsString`, never lossy UTF-8 – especially for line staging (CRLF, missing final newline, Latin-1).
5. Before every write, check the expected state (HEAD, blob). If it does not match, abort and reload.
6. Destructive actions first create backups under `refs/forkyard/undo/`. Force push only as `--force-with-lease`.
7. Running merges, rebases and cherry-picks are always read from `.git`, never from memory.

### Security

- Secrets live **only in the OS keychain** (`secrets.rs`, service `forkyard`), never in SQLite, logs, events or the UI (at most the last four characters). Everything that goes to the log, errors or events passes through `git/redact.rs` or `secrets::scrub`.
- **Repository trust:** a repo whose config or hooks start programs stays locked (`repo_untrusted`) until the user agrees (`commands/trust.rs`, block list in `trust::config_reason`).
- Inputs are validated in the core: paths via `normalize_rel_path` / `util::join_from_git`, refs without a leading `-`, `--` before paths.
- Strict CSP in `src-tauri/tauri.conf.json`. Markdown from repositories goes through DOMPurify. Dev and test switches (`FORKYARD_*`, `window.__gcTest*`) only work in debug builds; the variables are listed in `.env.example`.
- Tests never call real services. They use local mocks: `testkit/mock_http.rs`, `host/tests/mocks.rs`, `scripts/e2e/host-mock.mjs`.

### Database

The complete current schema is `crates/core/src/db/schema.sql`; new databases are created from it.
Existing ones are migrated step by step through `UPGRADES` in `crates/core/src/db/mod.rs`
(`pragma user_version`). A schema change touches **both** places; the test
`existing_databases_are_upgraded_step_by_step` checks they agree.

Settings have three levels: **global** (`app_settings`; which `Settings` fields are global is defined by
`db::app_settings::GLOBAL_KEYS`), **per profile** (`settings`) and **per repository** (`repo_settings` or
`.git/config`). `settingsSet` routes the fields itself. Each profile has its own repo list
(`profile_repositories`: last opened, favourite, group); path, alias, colour and trust live in
`repositories`. `repo_open` reports `repo_other_profile` when only other profiles list the repo.

Data from before the rename (data dir `dev.gitclient.desktop`, `gitclient.db`, keychain service
`git-client`) is adopted once on first start.

### UI (`src/`)

- `src/screens/<Name>/`: one folder per screen.
- `src/app/`: shell, state (`store.ts`, Zustand), reads via TanStack Query (`queries.ts`, keys `qk`; refetch on `repo:changed`), write queue (`writeQueue.ts`), error display (`run.ts`), focus and Escape guards.
- **Command registry:** every file `src/app/commands/*.ts` exporting `export const commands: AppCommand[]` is collected automatically via `import.meta.glob` (command palette, shortcuts, menus). Action logic lives in `src/app/actions/`.
- `src/ui/`: primitives on top of Radix. `src/components/graph`: canvas commit graph; the lane layout is computed by the core (`graph_page`), the UI only draws.
- **i18n:** `src/i18n` (i18next). Every visible string is `t("<area>.<key>")` with the text in `src/i18n/locales/en/<area>.json` and `de/<area>.json` (same keys; `src/i18n/i18n.test.ts` checks this and that every literal key exists). `t()` works at module level; changing the language reloads the window. Use `locale()` for `Intl` formats. Messages from the Rust core are English.
- **Design tokens only**, no raw hex or pixel values in components. Source is `design/tokens.json`; `src/styles/tokens.css` and `theme.css` are generated (`npm run tokens`), never edited by hand.
- Focus handling is a frequent source of bugs: views must not take focus while a dialog, menu or overlay is open (`src/app/viewFocus.ts`).
- `?scenario=<Folder>.<name>` runs a scenario from `src/screens/<Folder>/scenario.ts` after start (screenshots, tests).
