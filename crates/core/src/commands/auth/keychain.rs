//! The operating system's keychain (Windows Credential Manager, Secret Service, macOS
//! Keychain) via `keyring`. The calls block and therefore run on the blocking pool. Error
//! texts never name the content of an entry.
//!
//! All accesses of this process run one after another (`LOCK`), and every write is confirmed
//! by reading it back: in testing, the Windows Credential Manager occasionally returned stale
//! states under concurrent access from several threads (a deleted entry was back, a new value
//! not yet visible).

use std::sync::Mutex;

use crate::error::{CoreError, CoreResult};

/// Service name of the app in the keychain.
pub const DEFAULT_SERVICE: &str = "forkyard";
/// Service name before the rename to Forkyard; entries there are adopted on first read.
const LEGACY_SERVICE: &str = "git-client";
/// Account used to check availability (never created).
const PROBE_ACCOUNT: &str = "__probe__";
/// How often a write is repeated when reading it back shows something else.
const WRITE_ATTEMPTS: usize = 3;

static LOCK: Mutex<()> = Mutex::new(());

fn unavailable() -> CoreError {
    CoreError::io("The operating system's keychain is not available.")
}

fn entry(service: &str, account: &str) -> CoreResult<keyring::Entry> {
    keyring::Entry::new(service, account).map_err(|_| unavailable())
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> CoreResult<T> + Send + 'static) -> CoreResult<T> {
    tokio::task::spawn_blocking(move || {
        // A poisoned mutex protects no data here; just keep using it.
        let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        work()
    })
    .await
    .map_err(|_| unavailable())?
}

fn read(service: &str, account: &str) -> CoreResult<Option<String>> {
    match entry(service, account)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(unavailable()),
    }
}

/// Whether the keychain answers (Linux without Secret Service: no).
pub async fn probe(service: &str) -> bool {
    let service = service.to_string();
    blocking(move || read(&service, PROBE_ACCOUNT).map(|_| ())).await.is_ok()
}

/// Reads a secret; `None` if the entry does not exist.
pub async fn get(service: &str, account: &str) -> CoreResult<Option<String>> {
    let (service, account) = (service.to_string(), account.to_string());
    blocking(move || {
        let found = read(&service, &account)?;
        if found.is_some() || service != DEFAULT_SERVICE {
            return Ok(found);
        }
        // One-time adoption from the old service name.
        let Some(old) = read(LEGACY_SERVICE, &account)? else { return Ok(None) };
        if entry(&service, &account)?.set_password(&old).is_ok() {
            let _ = entry(LEGACY_SERVICE, &account)?.delete_credential();
        }
        Ok(Some(old))
    })
    .await
}

/// Creates an entry or overwrites it.
pub async fn set(service: &str, account: &str, secret: &str) -> CoreResult<()> {
    let (service, account, secret) = (service.to_string(), account.to_string(), secret.to_string());
    blocking(move || {
        let failed = || CoreError::io("The entry could not be saved in the keychain.");
        for _ in 0..WRITE_ATTEMPTS {
            entry(&service, &account)?.set_password(&secret).map_err(|_| failed())?;
            if read(&service, &account)?.as_deref() == Some(secret.as_str()) {
                return Ok(());
            }
        }
        Err(failed())
    })
    .await
}

/// Deletes an entry; `false` if it did not exist.
pub async fn delete(service: &str, account: &str) -> CoreResult<bool> {
    let (service, account) = (service.to_string(), account.to_string());
    blocking(move || {
        let mut existed = false;
        for _ in 0..WRITE_ATTEMPTS {
            match entry(&service, &account)?.delete_credential() {
                Ok(()) => existed = true,
                Err(keyring::Error::NoEntry) => {}
                Err(_) => return Err(unavailable()),
            }
            if read(&service, &account)?.is_none() {
                return Ok(existed);
            }
        }
        Err(CoreError::io("The entry could not be deleted from the keychain."))
    })
    .await
}

/// Prefix of the service names that tests use in the keychain.
#[cfg(any(test, feature = "testkit"))]
pub const TEST_SERVICE_PREFIX: &str = "forkyard-test-";

/// Tests only: whether the keychain under the test service `service` accepts a write. A
/// keychain can answer reads and still refuse every write (a locked Secret Service collection
/// with nobody there to unlock it), and tests that store secrets have to be skipped then.
/// Writes, reads back and deletes a probe entry; only touches services with the test prefix.
#[cfg(any(test, feature = "testkit"))]
pub async fn probe_writable(service: &str) -> bool {
    if !service.starts_with(TEST_SERVICE_PREFIX) || !probe(service).await {
        return false;
    }
    let service = service.to_string();
    blocking(move || {
        let probe = entry(&service, PROBE_ACCOUNT)?;
        let stored = probe.set_password("probe").is_ok() && read(&service, PROBE_ACCOUNT)?.as_deref() == Some("probe");
        let _ = probe.delete_credential();
        Ok(stored)
    })
    .await
    .unwrap_or(false)
}

/// Tests only: deletes all entries recorded in this core's database from the keychain service
/// `service`, synchronously so that it can run in a `Drop` and a test leaves nothing behind even
/// when it fails halfway. Only touches services with the test prefix. Returns the number of
/// deleted entries.
#[cfg(any(test, feature = "testkit"))]
pub fn remove_test_entries(core: &crate::app::Core, service: &str) -> usize {
    if !service.starts_with(TEST_SERVICE_PREFIX) {
        return 0;
    }
    let accounts: Vec<String> = core
        .db
        .with(|c| {
            let mut all = Vec::new();
            for profile in crate::db::profiles::list(c)? {
                all.extend(crate::db::host_accounts::list(c, &profile.id)?.into_iter().map(|row| row.keychain_ref));
            }
            Ok(all)
        })
        .unwrap_or_default();
    let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    accounts
        .iter()
        .filter(|account| keyring::Entry::new(service, account).is_ok_and(|entry| entry.delete_credential().is_ok()))
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn writable_probe_never_touches_real_services_and_leaves_nothing_behind() {
        assert!(!probe_writable(DEFAULT_SERVICE).await, "only test services are probed by writing");
        let service = format!("{TEST_SERVICE_PREFIX}{}", crate::util::new_id());
        if probe_writable(&service).await {
            assert_eq!(get(&service, PROBE_ACCOUNT).await.unwrap(), None, "the probe entry is removed again");
            set(&service, "account", "value").await.expect("a writable keychain takes a real write");
            assert!(delete(&service, "account").await.unwrap());
        }
    }
}
