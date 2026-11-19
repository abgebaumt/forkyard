# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Forkyard is a local desktop Git client: **Tauri 2 + a Rust core + React 19/TypeScript**. No server, no
accounts, no telemetry. Main targets are Windows and Linux; macOS builds but is less tested.

Linux system packages (Ubuntu): `libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev libxdo-dev libdbus-1-dev`. The core itself already needs `libdbus-1-dev` (keychain via Secret Service).

The UI is English by default with German selectable. Code, comments and docs are English; German
appears only as test data and in `src/i18n/locales/de`.

Read before touching code:
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): crates, the command contract, hard rules, security, database, undo, AI, E2E.
- [docs/CONVENTIONS.md](docs/CONVENTIONS.md): module and test layout, where helpers live, adding a command, screen convention, UI rules, i18n, tokens, checks.

## Commands

```bash
npm install
npm run app                  # tauri dev: Vite on 127.0.0.1:1420 (HMR) + debug app
npm run build                # tokens + tsc + vite build (UI only)
npm run tauri build          # release bundle. NOT `cargo build --release` – such a binary does not start
npm run check                # typecheck + test + test:scripts + check:commands + check:case + check:contrast + lint
npm run lint                 # biome check (format + lint); npm run format fixes formatting
npm run typecheck            # tsc --noEmit
npm test                     # vitest run (UI logic, *.test.ts next to the code)
npx vitest run src/screens/ConflictTool/model.test.ts   # single test file
npm run tokens               # design/tokens.json -> src/styles/tokens.css, theme.css
npm run check:contrast       # WCAG check of the colour pairs in design/tokens.json
npm run check:commands       # contract api.ts <-> src-tauri <-> crates/core
npm run gen:types            # Rust contract types -> src/core/generated/ (ts-rs), commit the result
node scripts/find-german.mjs src/screens/Foo   # leftover German UI strings (heuristic)

cargo build                                  # target/debug/forkyard (needed by E2E and screenshots)
cargo test --workspace                       # Rust tests against real temp repositories
cargo test -p gitcore <testname>             # single Rust test
cargo fmt --all                              # rustfmt.toml: max_width 140
cargo clippy --workspace --all-targets -- -D warnings   # expect 0 warnings
```

README screenshots (Linux, needs Xvfb, ImageMagick and ffmpeg): `cargo build && node scripts/screenshots/shoot.mjs` and `node scripts/screenshots/record-gif.mjs`.
The demo repository comes from `scripts/screenshots/demo-repo.mjs`, the views from `src/dev/scenarios/Showcase/scenario.ts`.

### E2E

`e2e/` drives the real debug app over WebDriver (Linux; details in `e2e/README.md`).

```bash
npm run e2e:wd:prepare                    # cargo build + copy to target/e2e-wd/bin/<mtime>/
npm run e2e:wd                            # all features, 4 at a time; results in target/e2e-wd/results/
node e2e/run.mjs smoke                    # features whose name contains "smoke"
E2E_WD_ONLY="undo" node e2e/features/dataloss.mjs   # one feature, only scenarios whose name contains "undo"
```

If a test turns red under load, fix the cause (wait for the concrete condition), never just raise
timeouts.

## Must know

Hard rules (details in docs/ARCHITECTURE.md):
1. Git is the source of truth; SQLite holds app state only.
2. One write operation per repository at a time; reads run in parallel; never delete a foreign `index.lock`.
3. The UI never runs Git and never builds command lines.
4. `LC_ALL=C`, fixed `--format`, `-z`; paths and contents stay bytes, never lossy UTF-8.
5. Check the expected state (HEAD, blob) before every write; abort and reload on mismatch.
6. Back up under `refs/forkyard/undo/` before destructive steps (`Pending`); force push only as `--force-with-lease`.
7. Read running merges, rebases and cherry-picks from `.git`, never from memory.

Also:
- Secrets only in the OS keychain; logs, errors and events go through `git/redact.rs` or `secrets::scrub`. Untrusted repositories stay locked.
- A command lives in `src/core/api.ts`, `crates/core/src/commands/<area>.rs` and one line of the `commands! { … }` table in `src-tauri/src/commands.rs`. Types live in Rust (`crates/core/src/model/`); run `npm run gen:types` and `npm run check:commands`.
- A schema change touches `crates/core/src/db/schema.sql` and `UPGRADES` in `crates/core/src/db.rs`.
- Every visible string is `t("<area>.<key>")` in both `src/i18n/locales/en` and `de`. Design tokens only; `src/styles/tokens.css` and `theme.css` are generated.
- Views must not take focus while a dialog, menu or overlay is open (`src/app/viewFocus.ts`).
- `?scenario=<Folder>.<name>` runs a scenario from `src/dev/scenarios/<Folder>/scenario.ts` (dev builds only).
