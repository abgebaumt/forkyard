//! The UI's commands (api.ts). Each file belongs to one area; every command is
//! `pub async fn name(core: &Core, <keys of the input object in snake_case>)`.

pub mod ai;
pub mod ai_search;
pub mod activity;
pub mod agents;
pub mod app;
pub mod archaeology;
pub mod auth;
pub mod avatars;
pub mod bisect;
pub mod branches;
pub mod cleanup;
pub mod cli;
pub mod clone_init;
pub mod crash;
pub mod custom;
pub mod commit;
pub mod compose;
pub mod diff;
pub mod external;
pub mod gitflow;
pub mod graph;
pub mod history;
pub mod host;
pub mod launch;
pub mod lfs;
pub mod links;
pub mod merge;
pub mod patch;
pub mod plan;
pub mod range_apply;
pub mod preview;
pub mod rebase;
pub mod review_fix;
pub mod reflog;
pub mod release_notes;
pub mod refs;
pub mod remotes;
pub mod repos;
pub mod settings;
pub mod signing;
pub mod stack;
pub mod stage;
pub mod stash;
pub mod stats;
pub mod status;
pub mod submodule;
pub mod sync;
pub mod tags;
pub mod terminal;
pub mod trust;
pub mod undo;
pub mod update;
pub mod view;
pub mod workspace;
pub mod worktree;

#[cfg(test)]
mod rewrite_hook_tests;
#[cfg(test)]
mod stale_index_tests;
