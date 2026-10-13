//! The app's secrets: tokens of host accounts, proxy passwords.
//!
//! They live exclusively in the operating system's keychain (via `auth::keychain`,
//! under the same service name as the remembered Git credentials) – never in SQLite, never in
//! the log, never in error messages, and they never go back to the UI (there only
//! "present" or the last four characters, see `hint`).
//!
//! If the keychain is not reachable (Linux without Secret Service), saving fails
//! with a clear message instead of falling back to a file.
//!
//! Tests get an in-memory replacement via `CoreConfig::memory_secrets` so that
//! they do not touch the machine's real keychain.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::Mutex;

use crate::app::Core;
use crate::commands::auth::keychain;
use crate::error::{CoreError, CoreResult};

/// In-memory replacement for the keychain (tests).
#[derive(Default)]
pub struct MemorySecrets {
    entries: Mutex<HashMap<String, String>>,
}

impl MemorySecrets {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// All entries (account, secret) – only for checks in tests.
    pub fn snapshot(&self) -> Vec<(String, String)> {
        let mut all: Vec<(String, String)> = self.entries.lock().iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        all.sort();
        all
    }
}

fn unavailable() -> CoreError {
    CoreError::io(
        "The operating system’s keychain can’t be reached. Without it, Forkyard doesn’t store any tokens, keys or passwords.",
    )
}

fn service(core: &Core) -> String {
    core.git.broker().config().keyring_service.unwrap_or_else(|| keychain::DEFAULT_SERVICE.to_string())
}

/// Whether secrets can be stored.
pub async fn available(core: &Core) -> bool {
    core.memory_secrets().is_some() || core.git.broker().keyring_available().await
}

/// Reads a secret; `None` if the entry does not exist.
pub async fn get(core: &Core, account: &str) -> CoreResult<Option<String>> {
    if let Some(memory) = core.memory_secrets() {
        return Ok(memory.entries.lock().get(account).cloned());
    }
    if !core.git.broker().keyring_available().await {
        return Err(unavailable());
    }
    keychain::get(&service(core), account).await
}

/// Creates an entry or overwrites it.
pub async fn set(core: &Core, account: &str, secret: &str) -> CoreResult<()> {
    if let Some(memory) = core.memory_secrets() {
        memory.entries.lock().insert(account.to_string(), secret.to_string());
        return Ok(());
    }
    if !core.git.broker().keyring_available().await {
        return Err(unavailable());
    }
    keychain::set(&service(core), account, secret).await
}

/// Deletes an entry; no error if it did not exist.
pub async fn delete(core: &Core, account: &str) -> CoreResult<()> {
    if let Some(memory) = core.memory_secrets() {
        memory.entries.lock().remove(account);
        return Ok(());
    }
    if !core.git.broker().keyring_available().await {
        // Without a keychain there is nothing to delete there either.
        return Ok(());
    }
    keychain::delete(&service(core), account).await.map(|_| ())
}

/// What the UI may see of a secret: `…` and the last four characters.
/// Short secrets (up to eight characters) show nothing of themselves.
pub fn hint(secret: &str) -> String {
    let chars: Vec<char> = secret.chars().collect();
    if chars.len() <= 8 {
        return "…".to_string();
    }
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("…{tail}")
}

/// Replaces every occurrence of the given secrets in `text` with `***`.
/// For everything that goes to the log, into errors or to the UI.
pub fn scrub(text: &str, secrets: &[String]) -> String {
    let mut out = text.to_string();
    for secret in secrets {
        if secret.len() >= 4 && out.contains(secret.as_str()) {
            out = out.replace(secret.as_str(), "***");
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hints_show_at_most_four_characters() {
        assert_eq!(hint("ghp_abcdefghijklmnop1234"), "…1234");
        assert_eq!(hint("kurz"), "…");
        assert_eq!(hint("12345678"), "…");
        assert_eq!(hint("äöüßäöüßx"), "…öüßx", "counted in characters, not bytes");
    }

    #[test]
    fn scrub_removes_every_occurrence() {
        let secrets = vec!["glpat-geheim123".to_string(), "abc".to_string()];
        assert_eq!(scrub("a glpat-geheim123 b glpat-geheim123", &secrets), "a *** b ***");
        // Very short values are not replaced (they would hit arbitrary text).
        assert_eq!(scrub("abc", &secrets), "abc");
    }

    #[tokio::test]
    async fn memory_store_roundtrip() {
        let tc = crate::testkit::TestCore::new().await;
        assert!(available(&tc).await);
        assert_eq!(get(&tc, "x").await.unwrap(), None);
        set(&tc, "x", "eins").await.unwrap();
        set(&tc, "x", "zwei").await.unwrap();
        assert_eq!(get(&tc, "x").await.unwrap().as_deref(), Some("zwei"));
        delete(&tc, "x").await.unwrap();
        delete(&tc, "x").await.unwrap();
        assert_eq!(get(&tc, "x").await.unwrap(), None);
    }
}
