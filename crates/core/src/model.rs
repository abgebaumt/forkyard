//! Data types between UI and core – mirror of src/core/types.ts.
//!
//! Rules: structs with `rename_all = "camelCase"`; enums with snake_case values;
//! unions as internally tagged enums with the field `kind` (results: `status`).
//! `Option<T>` is written as `null`, like `T | null` in TypeScript.
//! Whoever changes something here changes types.ts in the same step.

use serde::{Deserialize, Serialize};

use crate::error::CoreError;

pub type Id = String;
pub type Sha = String;
/// UTC, ISO-8601 with `Z`.
pub type IsoTime = String;

mod agent_collisions;
mod agent_review;
mod agents;
mod ai;
mod app;
mod cleanup;
mod commits;
mod compose;
mod conflicts;
mod crash;
mod credentials;
mod custom_commands;
mod diff;
mod events;
mod explain;
mod gitflow;
mod graph;
mod history;
mod hosts;
mod log;
mod refs;
mod results;
mod small_io;
mod stacks;
mod stats;
mod status;
mod view;
mod worktrees;

pub use agent_collisions::*;
pub use agent_review::*;
pub use agents::*;
pub use ai::*;
pub use app::*;
pub use cleanup::*;
pub use commits::*;
pub use compose::*;
pub use conflicts::*;
pub use crash::*;
pub use credentials::*;
pub use custom_commands::*;
pub use diff::*;
pub use events::*;
pub use explain::*;
pub use gitflow::*;
pub use graph::*;
pub use history::*;
pub use hosts::*;
pub use log::*;
pub use refs::*;
pub use results::*;
pub use small_io::*;
pub use stacks::*;
pub use stats::*;
pub use status::*;
pub use view::*;
pub use worktrees::*;
