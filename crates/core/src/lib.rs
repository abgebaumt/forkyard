//! gitcore – the core of Forkyard, without Tauri.
//!
//! The UI talks to `commands::*` via Tauri commands; every command is
//! `pub async fn name(core: &Core, <parameters>) -> CoreResult<T>`. Git is only called
//! through the Git runner (`git::GitRunner`, `Core::git_for`).

pub mod ai;
pub mod app;
pub mod autofetch;
pub mod commands;
pub mod crash;
pub mod db;
pub mod error;
pub mod events;
pub mod git;
pub mod host;
pub mod http;
pub mod jobs;
pub mod model;
pub mod proc;
pub mod secrets;
pub mod secret_scan;
pub mod tools;
pub mod undo;
pub mod util;
pub mod watcher;

#[cfg(any(test, feature = "testkit"))]
pub mod testkit;

#[cfg(test)]
mod security_tests;

pub use app::{Core, CoreConfig, WriteGuard};
pub use error::{CoreError, CoreResult, ErrorCode};
pub use events::{EventCollector, EventSink, NullSink};
