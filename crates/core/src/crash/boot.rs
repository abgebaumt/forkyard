//! Which boot of the computer this process runs in – to tell a run that ended with the computer
//! (power cut, frozen system, hard reset) from one that crashed.
//!
//! - **Linux:** the kernel's random ID of this boot (`/proc/sys/kernel/random/boot_id`).
//! - **Windows:** the time the computer started (now minus `GetTickCount64`, which keeps counting
//!   through sleep and hibernation), as `t:<ms>`. It moves a little with clock corrections, so two
//!   such values within `SAME_BOOT_TOLERANCE_MS` count as the same boot.
//! - Elsewhere: unknown (`None`) – every run without a clean exit is reported as before.

/// Two start times of the computer this close together are the same boot (clock corrections).
const SAME_BOOT_TOLERANCE_MS: i64 = 60_000;

const TIME_PREFIX: &str = "t:";

/// The boot this process runs in, `None` if it cannot be told.
pub(super) fn current() -> Option<String> {
    platform::current()
}

/// `a` and `b` (values of `current`) name the same boot.
pub(super) fn same(a: &str, b: &str) -> bool {
    match (start_ms(a), start_ms(b)) {
        (Some(a), Some(b)) => (a - b).abs() <= SAME_BOOT_TOLERANCE_MS,
        (None, None) => a == b,
        // One from a start time, one from an ID: another way of telling (a different
        // platform build on the same data directory); nothing is known.
        _ => true,
    }
}

fn start_ms(value: &str) -> Option<i64> {
    value.strip_prefix(TIME_PREFIX)?.parse().ok()
}

#[cfg(target_os = "linux")]
mod platform {
    pub(super) fn current() -> Option<String> {
        let id = std::fs::read_to_string("/proc/sys/kernel/random/boot_id").ok()?;
        let id = id.trim();
        (!id.is_empty()).then(|| id.to_string())
    }
}

#[cfg(windows)]
mod platform {
    pub(super) fn current() -> Option<String> {
        // SAFETY: no arguments; returns the milliseconds since the computer started.
        let up_ms = unsafe { windows_sys::Win32::System::SystemInformation::GetTickCount64() };
        let started = chrono::Utc::now().timestamp_millis() - i64::try_from(up_ms).ok()?;
        Some(format!("{}{started}", super::TIME_PREFIX))
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
mod platform {
    pub(super) fn current() -> Option<String> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boot_ids_compare_as_text() {
        assert!(same("6f1c-aa", "6f1c-aa"));
        assert!(!same("6f1c-aa", "6f1c-ab"));
    }

    #[test]
    fn start_times_compare_with_a_tolerance() {
        assert!(same("t:1000000", "t:1030000"), "a clock correction is the same boot");
        assert!(!same("t:1000000", "t:1100000"), "a later start is another boot");
    }

    #[test]
    fn mixed_kinds_tell_nothing() {
        assert!(same("t:1000000", "6f1c-aa"));
    }

    #[cfg(any(target_os = "linux", windows))]
    #[test]
    fn this_boot_is_known_and_stays_the_same() {
        let first = current().expect("the boot can be told on this platform");
        assert!(same(&first, &current().unwrap()));
    }
}
