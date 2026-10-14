//! Custom commands (api.ts: `customCommands*`, `customCommandRun`).
//!
//! Two sources: the user's own commands (global, stored as JSON in `app_settings`) and the
//! repository file `.forkyard/commands.json`. A repository command only runs after the user has
//! approved exactly this version of the file (SHA-256 of its bytes, stored in `repo_settings`);
//! every change needs a new approval.
//!
//! Nothing is ever put together into a shell string: `shell` commands are split into program and
//! arguments first and every placeholder becomes part of exactly one argument (`expand`); with
//! `shell: true` (global only) the values travel as environment variables. `git` commands go
//! through the Git runner and the write queue, and no value may become an option of Git. `url`
//! commands only produce an encoded http(s) address that the UI opens in the browser.

pub mod definition;
pub mod expand;
