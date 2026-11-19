# Conventions

Where code goes and how to add things. The big picture and the hard rules are in
[ARCHITECTURE.md](ARCHITECTURE.md).

Code, comments and docs are English. German appears only as test data and in
`src/i18n/locales/de`.

## Rust modules

- A module with submodules is `x.rs` plus a folder `x/` (for example `crates/core/src/undo.rs` +
  `crates/core/src/undo/`). There are no `mod.rs` files.
- Tests:
  - a small set: inline `#[cfg(test)] mod tests` at the end of the file;
  - otherwise in the module folder: `x/tests.rs`, or one file per topic (`x/<topic>_tests.rs`,
    for example `crates/core/src/commands/stash/partial_tests.rs`);
  - tests that need crate-private items across modules: `crates/core/src/tests/`
    (`crates/core/src/tests/security.rs`);
  - tests that only use the public API: `crates/core/tests/` (for example `crates/core/tests/contract.rs`).
- No `#[path]` attributes.
- Rust tests run against real temporary repositories (`TestRepo`, `TestCore` from feature
  `testkit`), never against real services.

## Where helpers live (crates/core/src)

Use these before writing a new helper:

| Need | Place |
| --- | --- |
| Run Git (`GitCmd`, `.read()` for background reads, `.literal_paths()`; `spawn_records` → `GitRecordStream`, a pull stream that kills Git on drop) | `git/runner.rs` |
| Resolve revisions, `is_ancestor`, `is_sha`, `short`, the ref argument check `is_rev_arg` | `git/rev.rs` |
| `git log` flags (`LOG_SAFE`), the commit header format (`HEADER`), the streaming log/numstat parser | `git/log.rs` |
| `git blame --porcelain` parser (`BlameParser`), `--incremental` parser (`IncrementalParser`) | `git/blame.rs` |
| HEAD, running operations and other state read from `.git` | `git/repo.rs` |
| Temporary index (`TempIndex`), empty tree, unmerged entries | `git/index.rs` |
| Whitespace-neutral `git apply` (`GIT_APPLY`) | `git.rs` |
| Line-replacement patches, hunk headers | `commands/diff/patch.rs` |
| Paths (`normalize_rel_path`, `join_from_git`, `raw_path`) | `util/path.rs` |
| Text and encodings (`decode_text`, `shorten`, `nul_join`, `compiled` regex cache) | `util/text.rs` |
| Atomic and private files | `util/fs.rs` |
| Timestamps | `util/time.rs` |
| Loopback listeners with a token (`bind_loopback`, `serve_loopback`) | `util/net.rs` |
| Non-Git processes, process trees | `proc.rs` |
| Finding programs on PATH | `tools/locate.rs` |
| Credentials, keychain, SSH keys | `auth/` |
| Backups and undo entries (`Pending`, `snapshot`) | `undo/pending.rs`, `undo/snapshot.rs` |
| Per-repository write lock | `Core::with_write_lock` in `app.rs` |
| Settings reads | `db::app_settings::get`, `db::repo_settings::get`, `Core::repo_settings` |

## Adding a command

1. Add the core function to `crates/core/src/commands/<area>.rs` (or a file in its folder). Check
   the expected state before writing, take the write lock, back up before destructive steps.
2. Put new parameter, result and event types in `crates/core/src/model/<area>.rs` with the
   `#[cfg_attr(feature = "ts", …)]` derive line the other types use.
3. Add one line to the `commands! { … }` table in `src-tauri/src/commands.rs`. Write a
   `#[tauri::command]` by hand below the table only if the body is more than a delegation, and add
   its name to `hand_written:`.
4. Add the signature to `CoreCommands` in `src/core/api.ts`.
5. Run `npm run gen:types` and commit `src/core/generated/`.
6. Run `npm run check:commands`. It also checks the error codes: a new `ErrorCode` needs its entry in
   `src/app/errors.ts` and a text in `src/i18n/locales/en/errors.json` and `src/i18n/locales/de/errors.json`.

A new event also goes into `CoreEvents` in `src/core/types.ts` (written by hand). A schema change
touches `crates/core/src/db/schema.sql` and `UPGRADES` in `crates/core/src/db.rs`.

## UI layers (src)

- `src/ui/`: primitives on top of Radix. Imports nothing from `app`, `components` or `screens`.
- `src/components/`: shared building blocks (graph, markdown, `VirtualList`, `LoadError`, …). Does
  not import `screens`.
- `src/app/`: shell, state, queries, actions, command registry, menus, AI hooks.
- `src/screens/<Name>/`: one folder per screen.
- `src/core/`: the only way to the core (`src/core/index.ts`).
- `src/dev/scenarios/`: dev-only scenarios (`?scenario=<Folder>.<name>`), loaded by dynamic import.

A helper used by several screens goes into `components/` or `app/`, not into one of the screens.

## Screen convention

A screen folder `src/screens/<Name>/` has:

- `index.tsx`: the view.
- `model.ts`: pure logic, tested in `model.test.ts`. Logic goes here, not into `.tsx` files.
- `actions.ts`: calls into the core.
- further parts as their own `.tsx` files, or `parts.tsx` for small ones.
- tests as `*.test.ts` next to the code (vitest, no React rendering needed for `model.ts`).

Every screen folder has at least one test file.

## UI rules

- Reads go through TanStack Query with keys from `qk` in `src/app/queries.ts`. Refetch on core
  events lives in `src/app/coreSync.ts`. Do not invalidate keys the core already announces with
  `app:changed` or `repo:changed`.
- Core actions run through `runAction` in `src/app/run.ts` (error display, busy state). Busy keys
  come only from `busyKeys` in `src/app/actions/keys.ts`. Changes to settings, profiles and
  signing go through `src/app/writeQueue.ts`, so they run one after another.
- Commands: every file `src/app/commands/*.ts` exports `commands: AppCommand[]` and is picked up
  automatically (palette, shortcuts, menus). Action logic lives in `src/app/actions/`. Menus take
  shortcuts from the registry by command id (`commandShortcut` in `src/app/registry.ts`).
- Focus: views must not take focus while a dialog, menu or overlay is open. View key handlers start
  with `keyBelongsToView(event)` from `src/app/viewFocus.ts`.
- AI views use `useAiJob` with `askAi` as the send gate and show errors with `AiErrorNotice`
  (`src/app/ai/`). Call `checkProvider` before an AI request.
- Shared small helpers: `src/app/format.ts` (`shortSha`, `formatBytes`), `src/app/paths.ts`
  (`splitPath`, `baseName`, `refNameIssue`), `writeClipboard`/`copyText` in
  `src/app/actions/clipboard.ts`, `Centered`/`Notice`/`SkeletonRows` in `src/ui/Feedback.tsx`.
- Markdown from repositories is rendered with `src/components/markdown/` only.

## i18n

- Every visible string is `t("<area>.<key>")`. The text lives in `src/i18n/locales/en/<area>.json`
  and `src/i18n/locales/de/<area>.json` with the same keys. `src/i18n/i18n.test.ts` checks this and
  that every literal key exists.
- Short texts that are the same in every place (up to three words, such as "Retry", "Cancel",
  "Close") use the shared `ui.*` keys in `src/i18n/locales/en/ui.json`. Reuse one before adding a
  new key.
- `t()` works at module level; changing the language reloads the window. Use `locale()` for `Intl`
  formats. Messages from the Rust core are English.
- `node scripts/find-german.mjs src/screens/Foo` finds leftover German UI strings (a heuristic).

## Design tokens

- No raw hex or pixel values in components. Use the tokens.
- The source is `design/tokens.json`. `npm run tokens` generates `src/styles/tokens.css` and
  `src/styles/theme.css`; never edit those two by hand. CI fails when they drift.
- `npm run check:contrast` checks the WCAG contrast of the colour pairs.

## Formatting and checks

- Rust: `cargo fmt --all` (`rustfmt.toml`, max width 140) and
  `cargo clippy --workspace --all-targets -- -D warnings` with 0 warnings.
- TypeScript and scripts: biome (`biome.json`, line width 140). `npm run format` fixes formatting,
  `npm run lint` checks it.
- `npm run check` runs typecheck, vitest, the script tests, `check:commands`, `check:case`
  (file names that differ only in case), `check:contrast` and lint.
- Before a pull request also run `cargo test --workspace`. CI runs the same checks, plus
  `npm run gen:types` and `npm run tokens` with a drift check.
