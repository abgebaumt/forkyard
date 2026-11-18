//! Credentials and SSH plumbing shared by the Git runner, `secrets` and the commands.
//!
//! - `broker`: relays prompts from Git and SSH (helper program ↔ UI),
//!   hooked into the Git runner via `.network()`.
//! - `prompt`: recognises the kind of a prompt.
//! - `keychain`: the operating system's keychain.
//! - `ssh`: key files and ssh-keygen.

pub mod broker;
pub mod keychain;
pub mod prompt;
#[cfg(target_os = "linux")]
mod secret_service;
pub mod ssh;

pub use broker::{AuthConfig, Broker, Session, SessionMode};
