//! Everything around calling Git: locating, running, interpreting errors, redacting credentials.

pub mod errors;
pub mod locate;
pub mod netconfig;
pub mod redact;
pub mod runner;

#[cfg(test)]
mod tests;

pub use locate::{GitInfo, MIN_VERSION, MIN_VERSION_TEXT};
pub use runner::{compose_ssh_command, parse_progress, GitCmd, GitOutput, GitRunner, LineFn, RecordFn, NETWORK_IDLE_TIMEOUT, NETWORK_TIMEOUT};
