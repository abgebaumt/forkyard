# Architecture

Forkyard is a local desktop Git client: Tauri 2, a Rust core and a React 19/TypeScript UI. There is
no server, no account and no telemetry. Main targets are Windows and Linux; macOS builds but is less
tested.

For where code goes and how to add things, see [CONVENTIONS.md](CONVENTIONS.md).

## Overview

```
React UI --invoke--> src-tauri (thin binding) --> crates/core (gitcore) --process--> git
     ^                                              |--> SQLite (app state)
     +---------------- events (repo:changed, job:*, …) ---+--> OS keychain (secrets)
```

The UI calls typed commands. The core runs the real `git` binary as a process, keeps app state in
SQLite and secrets in the OS keychain. The core tells the UI about changes through events
(`repo:changed`, `app:changed`, `job:progress`, `job:done`, `credential:request`, …; the full list
is `CoreEvents` in `src/core/types.ts`).

## Crates

- `crates/core` (crate `gitcore`): all logic, no Tauri.
  - `commands/*.rs`: one async function per command. Larger areas have a folder next to the file
    (`commands/merge.rs` + `commands/merge/`).
  - `git/`: the process runner (`runner.rs`), errors, redaction (`redact.rs`), repository state read
    from `.git` (`repo.rs`), temporary index (`index.rs`), revisions (`rev.rs`), log and blame parsers
    (`log.rs`, `blame.rs`).
  - `auth/`: credential broker, keychain, prompts, SSH keys.
  - `undo.rs` + `undo/`: undo log, snapshots, `Pending` (see [Undo](#undo)).
  - `ai.rs` + `ai/`: AI pipeline and providers (see [AI](#ai)).
  - `host.rs` + `host/`: GitHub, GitLab, Gitea/Forgejo, Bitbucket and Azure DevOps APIs.
  - `db.rs` + `db/`: SQLite (see [Database](#database)).
  - `model.rs` + `model/<area>.rs`: every type that crosses the contract.
  - `util/` (time, text, path, fs, net), `proc.rs` (non-Git processes, process trees),
    `secrets.rs`, `http.rs` (ureq/rustls), `watcher.rs`, `autofetch.rs`, `jobs.rs`, `events.rs`.
  - Feature `testkit` provides `TestCore` and `TestRepo` (`testkit.rs`).
  - Feature `ts` derives the TypeScript types (ts-rs), see [The command contract](#the-command-contract).
  - `bin/forkyard-editor.rs` is the sequence editor for interactive rebase; `bin/forkyard-bench.rs`
    measures graph pages and blame on a large repository.
  - Graph walkers (`commands/graph/walker.rs`) are long-lived background `git log` processes. Code that
    deletes or relocates a repository or worktree folder, runs `gc`, or untrusts a repository calls
    `commands::graph::release_graph_walkers` first.
- `crates/askpass`: helper for `GIT_ASKPASS`/`SSH_ASKPASS`. It forwards prompts over a local channel
  (127.0.0.1, one-time token) to the core, which sends `credential:request` to the UI. std only;
  `src-tauri/build.rs` compiles it with rustc as a sidecar into `src-tauri/binaries/`.
- `src-tauri`: the thin Tauri binding. `src-tauri/src/commands.rs` has one `#[tauri::command]` per
  command, and each one only delegates to `gitcore::commands`.

## The command contract

This is the most important seam. `src/core/api.ts` (`CoreCommands`) is authoritative.

A command lives in three places:

1. `src/core/api.ts`: the TypeScript signature.
2. `crates/core/src/commands/<area>.rs`: the core function.
3. `src-tauri/src/commands.rs`: one line in the `commands! { … }` table,
   `name => area::core_fn(param: Type, …) -> Ret;`. The macro writes the `#[tauri::command]` wrapper
   and `handler()` (= `generate_handler![…]`), which `src-tauri/src/lib.rs` registers. The few
   commands with a special body are written by hand below the table and listed in its
   `hand_written:` line.

`npm run check:commands` (`scripts/check-commands.mjs`) checks that the three places agree.
camelCase in TS maps to snake_case in Rust.

Types live in Rust only: `crates/core/src/model/<area>.rs` and `crates/core/src/error.rs`. Each
type carries `#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "<area>.ts"))]`.
`npm run gen:types` (`scripts/gen-types.mjs`) writes them, plus `Settings::default()` as
`settingsDefaults.json`, to `src/core/generated/`. The generated files are committed and CI fails
when they drift. `src/core/types.ts` re-exports them next to the few TS-only types. Never change
the wire shape just for TS; use `#[ts(...)]` attributes instead (for example
`optional = nullable` for input fields the UI may omit).

Errors always arrive as `{ code, message, gitOutput }` (`CoreError`). The UI talks to the core only
through `src/core/index.ts`.

### Windows

Windows are labelled `main` (the first one at start) or `w-<32 hex>` (`gitcore::windowing`). The
`commands!` macro runs every command inside `windowing::scoped(<label>, …)`, a task-local caller, so
the core knows the calling window without a parameter: `commands::window::calling_window` returns it,
or outside a scope (spawned tasks, start-up) the most recently focused window. Any window may be gone
mid-session, `main` included, so code never assumes `main` exists. Events either go to all windows
(`Core::emit`, e.g. `app:changed`, `repo:changed`, jobs) or to one (`Core::emit_to`, e.g.
`credential:request`, `app:close_requested`); the UI hears the first with `core.on`, the second with
`core.onWindow`, which listens under its own label. `core.on` is label-scoped as well: it does not see
events targeted at another window. After a change to the stored windows the core calls
`sync_windows`, and `src-tauri/src/windows.rs` (`reconcile`) builds, places and destroys the Tauri
windows to match. Closing is guarded per window (`commands::app::CloseGuard`): closing one window stops
only the jobs it started, closing the last one quits. A window hidden while it closes counts as gone.
"Quit Forkyard" (`app_quit`) keeps every window's row for the next start; a window closed on its own
loses its row and tabs. Jobs have an origin window (`Jobs::cancel_from`); terminals have an owner window,
set at `terminal_open`, handed to the target by a tab move (`tab_handoff_put` names them) and taken by
the window that resizes them; closing the owner ends them (`terminal::close_owned_by`). Coding agents'
terminals have no owner in the core; a window showing one ends it when it closes (its close prompt
names them), otherwise they end when the app quits. A profile switch is refused while another window
reports something to lose, since the switch destroys those windows without their close guard.

## Hard rules

1. **Git is the source of truth.** Commits, refs, stashes and remotes are never mirrored into SQLite.
   SQLite holds app state only (profiles, tabs, settings, undo, activity …).
2. **One write operation per repository at a time** (lock in the core: `Core::with_write_lock`,
   `with_lock_cancellable`, `with_network_lock` in `crates/core/src/app.rs`). Reads run in parallel.
   Background reads use `GIT_OPTIONAL_LOCKS=0`. A foreign `index.lock` is never deleted.
3. **The UI never runs Git and never builds command lines.**
4. Git runs with `LC_ALL=C`, fixed `--format` strings and `-z`. Paths and contents stay bytes /
   `OsString`, never lossy UTF-8, especially for line staging (CRLF, missing final newline, Latin-1).
5. Before every write, check the expected state (HEAD, blob). If it does not match, abort and reload.
6. Destructive actions first create backups under `refs/forkyard/undo/`. Force push only as
   `--force-with-lease`.
7. Running merges, rebases and cherry-picks are always read from `.git`, never from memory.

## Security

- Secrets live **only in the OS keychain** (`secrets.rs`, service `forkyard`). They never go into
  SQLite, logs, events or the UI (at most the last four characters). Everything that goes to the
  log, errors or events passes through `git/redact.rs` or `secrets::scrub`.
- **Repository trust:** a repository whose config or hooks start programs stays locked
  (`repo_untrusted`) until the user agrees (`commands/trust.rs`, block list in
  `trust::config_reason`).
- Inputs are validated in the core: paths via `normalize_rel_path` / `util::join_from_git`, refs
  without a leading `-` (`git::rev::is_rev_arg`), `--` before paths.
- Strict CSP in `src-tauri/tauri.conf.json`. Markdown from repositories goes through DOMPurify
  (`src/components/markdown/render.ts`; `MarkdownHtml` only accepts its `SanitisedHtml`).
- Dev and test switches (`FORKYARD_*`, `window.__gcTest*`) only work in debug builds. The variables
  are listed in `.env.example`.
- Tests never call real services. They use local mocks: `crates/core/src/testkit/mock_http.rs`,
  `crates/core/src/host/tests/mocks.rs`, `e2e/fixtures/host-mock.mjs`.

## Database

The complete current schema is `crates/core/src/db/schema.sql`; new databases are created from it.
Existing databases are migrated step by step through `UPGRADES` in `crates/core/src/db.rs`
(`pragma user_version`). A schema change touches **both** places. The test
`existing_databases_are_upgraded_step_by_step` checks that they agree.

Settings have three levels:

- **global**: table `app_settings`. Which `Settings` fields are global is defined by
  `db::app_settings::GLOBAL_KEYS`.
- **per profile**: table `settings`.
- **per repository**: table `repo_settings` or `.git/config`.

`settingsSet` routes each field to its level. Each profile has its own repository list
(`profile_repositories`: last opened, favourite, group). Path, alias, colour and trust live in
`repositories`. `repo_open` reports `repo_other_profile` when only other profiles list the
repository.

## Undo

Every reversible action goes through one pipeline in `crates/core/src/undo.rs` and `undo/`:

- `undo/snapshot.rs`: the one backup of working directory and index. It copies the real index into
  a temporary index (`git::index::TempIndex`), adds the working directory, writes a tree and a commit
  with a fixed identity (`BACKUP_IDENTITY`, `commit_tree`, always `--no-gpg-sign`). Variants:
  `snapshot`, `snapshot_paths` (raw byte paths), `snapshot_before_reset`, `snapshot_at` (a worktree).
- `undo/pending.rs`: `Pending`, an undo entry in the making. New id, then backup refs under
  `refs/forkyard/undo/<entry_id>/<name>`, then the step, then the entry is recorded or forgotten.
  `Pending::around` does backup, step and entry in one call.
- `undo/log.rs`: storing entries, the undo/redo stacks, labels, cleanup, group entries.
- Executing undo and redo lives in `commands/undo.rs`.

The failure policy (documented at the top of `undo/pending.rs`):

- A backup or an entry that fails **before** the destructive step aborts the step and leaves no
  backup refs behind (`back_up`, `keep`, `record_before`).
- After a step that succeeded, a failing entry is only logged (`record`). The backup refs stay;
  cleanup lists them as backups without an entry.
- A step that did not happen removes its backup again (`forget`, `Recorded::cancel`).

## AI

AI is optional and off by default. Every AI function uses the same pipeline in
`crates/core/src/ai/run.rs`:

1. `ai::run::ask(core, repo_id, feature)` checks that AI is allowed (`ensure_allowed`: AI on, the
   function on, repository trusted and not set to "AI off") and returns a `Frame` (settings,
   budget, known secrets; this reads the keychain). Functions that must validate their input before the keychain is read call
   `ensure_allowed`, validate, and then `ai::run::frame`.
2. The function builds its prompt with the frame. `ai_preview` uses the same builder, so "What is
   sent?" shows the exact request.
3. `Frame::send` (or `send_checked`) runs the request: the confirmations of `ai/gate.rs` for exactly
   this prompt, a cancellable job, at most one retry with a larger output limit and one schema
   repair, then usage (numbers only) and one activity entry without contents.

Layout:

- `ai/features/`: one module per function (commit message, PR description, push review, conflict
  intent, release notes, archaeology, bisect, stack split, review fix, plan, semantic search).
- `ai/` itself: infrastructure (`run`, `gate`, `context`, `ignore`, `prompt`, `schema`, `pricing`,
  `provider`, `providers/` for HTTP APIs, `cli/` for local AI command-line tools).
- Commands: `commands/ai.rs` (setup, status, keys, models, preview, usage) and
  `commands/ai_features.rs` (the request commands).
- UI: `src/app/ai/` (`useAiJob`, `askAi` in `gate.ts`, `checkProvider`, `AiErrorNotice`).

## E2E tests

`e2e/` drives the real debug app over W3C WebDriver (`tauri-driver` + WebKitWebDriver on Linux;
Windows is prepared but untested; macOS has no WebDriver). Each launch gets its own Xvfb display,
ports, data dir, gitconfig and keychain service. The UI comes from its own Vite server from port
1431 (no HMR, page error hook).

- `e2e/features/*.mjs`: one file per feature, scenarios via `scenario(name, "main"|"edge", fn)` from
  `e2e/lib.mjs`.
- `e2e/fixtures/`: shared repositories, the host mock and local Git servers.
- `e2e/run.mjs` runs features in parallel, `e2e/prepare.mjs` builds and copies the app.

Details and the API: [e2e/README.md](../e2e/README.md).
