# Contributing to Forkyard

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Before you start

- **Bugs:** open an issue with the bug template. Steps to reproduce, your OS and your Git version help most.
- **Bigger changes:** open an issue first so we can agree on the approach before you invest time.
- **Security problems:** please do not open a public issue. See [SECURITY.md](SECURITY.md).

## Development setup

You need Node.js 22, a current stable Rust toolchain and Git. On Linux, install the WebKitGTK
dependencies first (Ubuntu/Debian):

```bash
sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev \
  librsvg2-dev libayatana-appindicator3-dev libxdo-dev libdbus-1-dev
```

Then:

```bash
npm install
npm run app          # starts the app with hot reload
```

## Checks

Run these before you open a pull request. CI runs the same.

```bash
npm run typecheck
npm test
npm run check:commands                    # frontend ↔ Rust command contract
cargo clippy --workspace --all-targets    # expect 0 warnings
cargo test --workspace
```

## How the code is organised

- `crates/core` – the Rust core (`gitcore`): every command, Git process handling, SQLite state, keychain access.
- `src-tauri` – a thin Tauri binding; one `#[tauri::command]` per core command.
- `src` – the React UI. It never runs Git itself; it calls the core through `src/core`.

A new or changed command touches four places: `src/core/api.ts`, `crates/core/src/commands/<area>.rs`,
`src-tauri/src/commands.rs` and `src-tauri/src/lib.rs`. `npm run check:commands` verifies they match.

A few rules the code relies on:

- Git is the source of truth. Commits, refs and stashes are never mirrored into the database.
- One write operation per repository at a time; reads run in parallel.
- Destructive operations create a backup ref first, so Undo works.
- Secrets live only in the OS keychain – never in the database, logs or events.
- UI colours and sizes come from design tokens (`design/tokens.json`, then `npm run tokens`).
- UI text goes through i18n (`src/i18n`). Add every new string to both `locales/en` and `locales/de`.

## Pull requests

- Keep a pull request focused on one change.
- Add or update tests for behaviour you change. Rust tests run against real temporary repositories.
- Describe what changed and why; screenshots help for UI changes.

By contributing you agree that your contribution is licensed under the [GPL-3.0](LICENSE).
