//! Small helpers: IDs, ref names, patches, dev switches. Time, text, paths and files live in
//! the submodules and are re-exported here (`util::now_iso`, `util::decode_lossy`, …).

mod fs;
mod net;
mod path;
mod text;
mod time;

use std::ffi::OsString;

pub use fs::*;
pub use net::*;
pub use path::*;
pub use text::*;
pub use time::*;

/// New UUID v4 as text.
pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Compares two passwords without the duration revealing where they differ.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Checks a branch or tag name against the rules of `git check-ref-format`.
/// Returns a reason if the name is invalid.
pub fn check_ref_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("The name must not be empty.".into());
    }
    if name != name.trim() || name.chars().any(|c| c.is_whitespace()) {
        return Err("The name must not contain spaces.".into());
    }
    if name.starts_with('-') {
        return Err("The name must not start with “-”.".into());
    }
    if name == "@" {
        return Err("“@” on its own is not a valid name.".into());
    }
    if name == "HEAD" {
        return Err("“HEAD” is reserved.".into());
    }
    if name.contains("..") {
        return Err("The name must not contain “..”.".into());
    }
    if name.contains("@{") {
        return Err("The name must not contain “@{”.".into());
    }
    if name.contains("//") {
        return Err("The name must not contain “//”.".into());
    }
    if name.starts_with('/') || name.ends_with('/') {
        return Err("The name must not start or end with “/”.".into());
    }
    if name.ends_with('.') {
        return Err("The name must not end with “.”.".into());
    }
    for c in ['~', '^', ':', '?', '*', '[', '\\'] {
        if name.contains(c) {
            return Err(format!("The character “{c}” is not allowed."));
        }
    }
    if name.chars().any(|c| c.is_control()) {
        return Err("Control characters are not allowed.".into());
    }
    for part in name.split('/') {
        if part.starts_with('.') {
            return Err("No part of the name may start with “.”.".into());
        }
        if part.ends_with(".lock") {
            return Err("No part of the name may end with “.lock”.".into());
        }
    }
    Ok(())
}

/// Applies a partial object (`Partial<T>` of the UI) to `current`.
/// Unknown keys and wrong types yield `not_allowed`. `null` in the
/// patch sets a field to `null` (only for fields that allow it).
/// Returns the new value and the changed keys.
pub fn apply_patch<T>(current: &T, patch: &serde_json::Value, what: &str) -> crate::CoreResult<(T, Vec<String>)>
where
    T: serde::Serialize + serde::de::DeserializeOwned,
{
    use crate::CoreError;
    let serde_json::Value::Object(patch) = patch else {
        return Err(CoreError::not_allowed(format!("{what}: expected an object with the fields to change.")));
    };
    let mut base = serde_json::to_value(current)?;
    let serde_json::Value::Object(map) = &mut base else {
        return Err(CoreError::unknown(format!("{what}: internal state is not an object.")));
    };
    let mut changed = Vec::new();
    for (key, value) in patch {
        if !map.contains_key(key) {
            return Err(CoreError::not_allowed(format!("{what}: unknown field “{key}”.")));
        }
        map.insert(key.clone(), value.clone());
        changed.push(key.clone());
    }
    let value: T = serde_json::from_value(base).map_err(|e| CoreError::not_allowed(format!("{what}: invalid value ({e}).")))?;
    Ok((value, changed))
}

/// Empty or whitespace-only text becomes `None`.
pub fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.trim().is_empty())
}

/// Environment variable that only tests and development builds are meant to redirect (helper
/// programs, test servers). A shipped program (release build) ignores it.
pub fn dev_env(name: &str) -> Option<OsString> {
    if !cfg!(debug_assertions) {
        return None;
    }
    std::env::var_os(name).filter(|value| !value.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ref_names() {
        assert!(check_ref_name("feature/neu-1").is_ok());
        for bad in ["", "a b", "-x", "a..b", "a~1", "a/", ".a", "a.lock", "a//b", "HEAD", "a:b", "x."] {
            assert!(check_ref_name(bad).is_err(), "{bad}");
        }
    }
}
