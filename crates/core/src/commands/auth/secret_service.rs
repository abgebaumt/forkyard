//! Secret Service (Linux) for `keyring` with ONE connection and ONE session for the whole
//! process. `keyring`'s own backend connects and opens a new session for every call (a write that
//! is read back takes three), and gnome-keyring-daemon 50.0 aborts now and then when clients keep
//! opening sessions (`plain_negotiate: assertion 'session' failed`); a user's daemon that comes
//! back after that has the login keyring locked. Entries look exactly like `keyring`'s (same
//! attributes and label, `keyring::secret_service`'s helpers), so entries stored before stay
//! readable and vice versa.
//!
//! The connection is made on first use and replaced once when a call fails (the daemon was
//! restarted: the old session is gone).

use std::any::Any;
use std::sync::{Mutex, Once};

use dbus_secret_service::{EncryptionType, Item, SecretService};
use keyring::credential::{Credential, CredentialApi, CredentialBuilderApi};
use keyring::secret_service::{create_collection, decode_error, delete_item, get_collection, get_item_secret, set_item_secret, SsCredential};
use keyring::{Error, Result};

/// The connection of this process; `None` until first use or after a failed call.
static CONNECTION: Mutex<Option<SecretService>> = Mutex::new(None);

/// Makes every `keyring::Entry` of this process use the shared connection.
pub fn install() {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| keyring::set_default_credential_builder(Box::new(SharedBuilder)));
}

fn platform_failure(err: dbus_secret_service::Error) -> Error {
    Error::PlatformFailure(Box::new(err))
}

/// Runs `work` on the shared connection. When it fails other than with "no entry", the
/// connection is dropped and `work` runs once more on a new one; every operation here may run
/// twice (a write replaces, a delete of a deleted entry finds nothing).
fn with_service<T>(work: impl Fn(&SecretService) -> Result<T>) -> Result<T> {
    let mut slot = CONNECTION.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut attempt = 0;
    loop {
        attempt += 1;
        if slot.is_none() {
            *slot = Some(SecretService::connect(EncryptionType::Plain).map_err(platform_failure)?);
        }
        let Some(service) = slot.as_ref() else { unreachable!("connected above") };
        match work(service) {
            Err(Error::PlatformFailure(err)) => {
                *slot = None;
                if attempt >= 2 {
                    return Err(Error::PlatformFailure(err));
                }
            }
            other => return other,
        }
    }
}

#[derive(Debug)]
struct SharedBuilder;

impl CredentialBuilderApi for SharedBuilder {
    fn build(&self, target: Option<&str>, service: &str, user: &str) -> Result<Box<Credential>> {
        Ok(Box::new(SharedCredential(SsCredential::new_with_target(target, service, user)?)))
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

/// `keyring`'s credential (attributes, label, target), stored over the shared connection.
#[derive(Debug)]
struct SharedCredential(SsCredential);

impl SharedCredential {
    fn target(&self) -> &str {
        self.0.attributes.get("target").map(String::as_str).unwrap_or("default")
    }

    /// Like `SsCredential::map_matching_items(f, true)`: exactly one matching item (else
    /// `NoEntry` / `Ambiguous`); without a match under the target, items of the default
    /// collection without a target (older `keyring` versions) count too. Locked items are
    /// unlocked first.
    fn with_unique_item<T>(&self, service: &SecretService, f: &impl Fn(&Item) -> Result<T>) -> Result<T> {
        let attrs = &self.0.attributes;
        let mut search = std::collections::HashMap::from([("service", attrs["service"].as_str()), ("username", attrs["username"].as_str())]);
        search.insert("target", self.target());
        let found = service.search_items(search.clone()).map_err(decode_error)?;
        let (unlocked, locked) = (found.unlocked, found.locked);
        let items: Vec<(&Item, bool)> = unlocked.iter().map(|item| (item, false)).chain(locked.iter().map(|item| (item, true))).collect();
        if items.is_empty() && self.target() == "default" {
            search.remove("target");
            let collection = service.get_default_collection().map_err(decode_error)?;
            let legacy = collection.search_items(search).map_err(decode_error)?;
            return match legacy.as_slice() {
                [] => Err(Error::NoEntry),
                [item] => f(item),
                more => Err(ambiguous(more.iter())),
            };
        }
        match items.as_slice() {
            [] => Err(Error::NoEntry),
            [(item, is_locked)] => {
                if *is_locked {
                    item.unlock().map_err(decode_error)?;
                }
                f(item)
            }
            more => Err(ambiguous(more.iter().map(|(item, _)| *item))),
        }
    }
}

fn ambiguous<'a>(items: impl Iterator<Item = &'a Item<'a>>) -> Error {
    let mut creds: Vec<Box<Credential>> = Vec::new();
    for item in items {
        match SsCredential::new_from_item(item) {
            Ok(cred) => creds.push(Box::new(cred)),
            Err(err) => return err,
        }
    }
    Error::Ambiguous(creds)
}

impl CredentialApi for SharedCredential {
    fn set_secret(&self, secret: &[u8]) -> Result<()> {
        with_service(|service| match self.with_unique_item(service, &|item| set_item_secret(item, secret)) {
            Err(Error::NoEntry) => {
                let collection = get_collection(service, self.target()).or_else(|_| create_collection(service, self.target()))?;
                let attributes = self.0.attributes.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
                collection.create_item(&self.0.label, attributes, secret, true, "text/plain").map_err(decode_error)?;
                Ok(())
            }
            other => other,
        })
    }

    fn get_secret(&self) -> Result<Vec<u8>> {
        with_service(|service| self.with_unique_item(service, &get_item_secret))
    }

    fn delete_credential(&self) -> Result<()> {
        with_service(|service| self.with_unique_item(service, &delete_item))
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}
