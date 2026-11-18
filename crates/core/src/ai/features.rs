//! One module per AI function; the shared pipeline is `ai::run` (`ask` → build → `Frame::send`).

pub mod archaeology;
pub mod bisect;
pub mod commit_message;
pub mod conflict;
pub mod plan;
pub mod plan_check;
pub mod plan_commands;
pub mod plan_run;
pub mod pr;
pub mod release_notes;
pub mod review;
pub mod semantic;
pub mod stack;
