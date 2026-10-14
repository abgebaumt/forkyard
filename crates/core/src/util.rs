//! Small helpers: time, IDs, bytes and paths, encoding, ref names.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Now in UTC as ISO-8601 with milliseconds and `Z`.
pub fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// Point in time `days` days ago, in the same format as `now_iso`.
pub fn iso_days_ago(days: i64) -> String {
    (chrono::Utc::now() - chrono::Duration::days(days)).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// Unix seconds (as from `git log --format=%at`) to ISO-8601 UTC.
///
/// Years outside 0000–9999 (a commit with a nonsensical date) are written in the extended
/// notation with sign and six digits (`+010000-01-01T…`): only that is understood by
/// `new Date()` in the UI – "+10000-…", as chrono writes it, is invalid there.
pub fn unix_to_iso(secs: i64) -> String {
    use chrono::Datelike;
    let time = chrono::DateTime::from_timestamp(secs, 0).unwrap_or_default();
    let year = time.year();
    if (0..=9999).contains(&year) {
        return time.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
    }
    let sign = if year < 0 { '-' } else { '+' };
    format!("{sign}{:06}-{}", year.unsigned_abs(), time.format("%m-%dT%H:%M:%S%.3fZ"))
}

/// New UUID v4 as text.
pub fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Decode bytes for display; invalid UTF-8 is replaced.
pub fn decode_lossy(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Decode text for display and guess the encoding:
/// UTF-8 (also with BOM), UTF-16 with BOM, otherwise windows-1252.
/// Returns the text and the name of the encoding ("utf-8", "windows-1252", …).
pub fn decode_text(bytes: &[u8]) -> (String, &'static str) {
    if let Some((enc, bom_len)) = encoding_rs::Encoding::for_bom(bytes) {
        let (text, _) = enc.decode_without_bom_handling(&bytes[bom_len..]);
        let name = if enc == encoding_rs::UTF_8 { "utf-8" } else if enc == encoding_rs::UTF_16LE { "utf-16le" } else { "utf-16be" };
        return (text.into_owned(), name);
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => (s.to_string(), "utf-8"),
        Err(_) => {
            let (text, _, _) = encoding_rs::WINDOWS_1252.decode(bytes);
            (text.into_owned(), "windows-1252")
        }
    }
}

/// Write text back into a named encoding (for write actions).
/// Unknown names fall back to UTF-8.
pub fn encode_text(text: &str, encoding: &str) -> Vec<u8> {
    match encoding_rs::Encoding::for_label(encoding.as_bytes()) {
        Some(enc) if enc != encoding_rs::UTF_8 && enc != encoding_rs::UTF_16LE && enc != encoding_rs::UTF_16BE => {
            enc.encode(text).0.into_owned()
        }
        _ => text.as_bytes().to_vec(),
    }
}

/// Heuristic for binary files as in Git: a NUL byte in the first 8000 bytes.
pub fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8000).any(|&b| b == 0)
}

/// Shortens a text to at most `max` bytes (at a character boundary) and marks the cut.
pub fn truncate_str(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… (truncated)", &text[..end])
}

/// Splits `-z` output at NUL bytes; a trailing NUL does not produce an empty entry.
pub fn split_z(bytes: &[u8]) -> impl Iterator<Item = &[u8]> {
    split_records(bytes, 0)
}

/// Splits bytes at a separator byte; an empty remainder at the end is left out.
pub fn split_records(bytes: &[u8], sep: u8) -> impl Iterator<Item = &[u8]> {
    let trimmed = if bytes.last() == Some(&sep) { &bytes[..bytes.len() - 1] } else { bytes };
    let empty = trimmed.is_empty();
    trimmed.split(move |&b| b == sep).filter(move |_| !empty)
}

/// Path bytes from Git to an OS path. Byte-exact on Unix;
/// on Windows Git delivers UTF-8, slashes become backslashes.
pub fn bytes_to_path(bytes: &[u8]) -> PathBuf {
    PathBuf::from(bytes_to_os(bytes))
}

/// Whether a relative path stays inside the folder it is appended to: no `..`, no
/// drive, not absolute. On Windows `\` separates too – a name from a Git tree like
/// `x\..\..\raus.bat` therefore fails.
pub fn is_plain_relative(path: &Path) -> bool {
    let mut any = false;
    for component in path.components() {
        match component {
            std::path::Component::Normal(_) => any = true,
            std::path::Component::CurDir => {}
            _ => return false,
        }
    }
    any
}

/// Appends a path from Git output to `root`. Git only checks paths on checkout;
/// trees (and therefore diffs between commits) can contain names that lead out of the
/// folder. Such names yield a path here that cannot exist on any system
/// (it contains a NUL character): reading finds nothing, writing and deleting fail.
pub fn join_from_git(root: &Path, rel: &[u8]) -> PathBuf {
    let rel = bytes_to_path(rel);
    if is_plain_relative(&rel) {
        root.join(rel)
    } else {
        root.join("\0ungültiger-pfad")
    }
}

/// Unix: folder or file only for the own user (0700 / 0600). On Windows the data lives
/// under %APPDATA% with the user's permissions; nothing to do there.
pub fn restrict_to_owner(path: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let meta = std::fs::metadata(path)?;
        let mode = if meta.is_dir() { 0o700 } else { 0o600 };
        if meta.permissions().mode() & 0o777 != mode {
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))?;
        }
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Creates an empty file if it is missing; on Unix directly with 0600 (not only afterwards).
pub fn create_private_file(path: &Path) -> std::io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(path) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(e),
    }
}

/// Creates a folder including missing parents; on Unix only for the own user.
pub fn create_private_dir(path: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

/// Compares two passwords without the duration revealing where they differ.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Bytes from Git as `OsString` (byte-exact on Unix for arguments to Git).
pub fn bytes_to_os(bytes: &[u8]) -> OsString {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        OsString::from_vec(bytes.to_vec())
    }
    #[cfg(not(unix))]
    {
        OsString::from(String::from_utf8_lossy(bytes).into_owned())
    }
}

/// Path as bytes, as Git expects it (Unix: raw; Windows: UTF-8).
pub fn path_to_bytes(path: &Path) -> Vec<u8> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        path.as_os_str().as_bytes().to_vec()
    }
    #[cfg(not(unix))]
    {
        path.to_string_lossy().into_owned().into_bytes()
    }
}

/// Path in the system's notation (Windows: backslashes).
pub fn native_path(path: &Path) -> PathBuf {
    if cfg!(windows) {
        PathBuf::from(path.to_string_lossy().replace('/', "\\"))
    } else {
        path.to_path_buf()
    }
}

/// Path for display (lossy).
pub fn display_path(path: &Path) -> String {
    native_path(path).to_string_lossy().into_owned()
}

/// Normalized key for comparing repository paths for uniqueness:
/// forward slashes, without a trailing separator, lowercase on Windows and macOS.
pub fn path_key(path: &Path) -> String {
    let mut s = path.to_string_lossy().replace('\\', "/");
    if let Some(rest) = s.strip_prefix("//?/") {
        s = rest.to_string();
    }
    while s.len() > 1 && s.ends_with('/') && !s.ends_with(":/") {
        s.pop();
    }
    if cfg!(any(windows, target_os = "macos")) {
        s.to_lowercase()
    } else {
        s
    }
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
    let value: T = serde_json::from_value(base)
        .map_err(|e| CoreError::not_allowed(format!("{what}: invalid value ({e}).")))?;
    Ok((value, changed))
}

/// How long a write attempt is retried that another program blocks briefly.
pub const WRITE_RETRY_WINDOW: std::time::Duration = std::time::Duration::from_millis(1500);
const WRITE_RETRY_PAUSE: std::time::Duration = std::time::Duration::from_millis(40);

/// Errors that go away on Windows as soon as the other program (virus scanner, a
/// concurrently reading Git, an editor) lets go of the file: access denied (5),
/// sharing violation (32), lock violation (33), file is memory-mapped (1224).
fn is_transient_write_error(error: &std::io::Error) -> bool {
    cfg!(windows) && matches!(error.raw_os_error(), Some(5 | 32 | 33 | 1224))
}

/// Writes a file robustly: into a temp file in the same folder, then renamed over it.
/// The permissions of an existing file are kept; missing folders are created. If
/// another program holds the file briefly, it is retried for up to `WRITE_RETRY_WINDOW`.
/// On an error the target stays untouched and the temp file disappears.
///
/// Blocks (also while waiting): call from `async` code via `tokio::task::spawn_blocking`.
pub fn write_file_atomic(target: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let dir = target.parent().ok_or_else(|| std::io::Error::other("The target folder is missing."))?;
    std::fs::create_dir_all(dir)?;
    let name = target.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let temp = dir.join(format!(".{name}.{}.tmp", &new_id()[..8]));
    let deadline = std::time::Instant::now() + WRITE_RETRY_WINDOW;
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        if let Ok(meta) = std::fs::metadata(target) {
            std::fs::set_permissions(&temp, meta.permissions())?;
        }
        loop {
            match std::fs::rename(&temp, target) {
                Ok(()) => return Ok(()),
                Err(e) if is_transient_write_error(&e) && std::time::Instant::now() < deadline => std::thread::sleep(WRITE_RETRY_PAUSE),
                Err(e) => return Err(e),
            }
        }
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
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

/// Copies the index to `to` for use as `GIT_INDEX_FILE` and keeps its modification time. Git
/// compares entries by content that are not older than the index file ("racily clean"); a copy
/// with a fresh timestamp would hide a same-size rewrite within that tick and take the old content.
pub fn copy_index_file(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::copy(from, to)?;
    let modified = std::fs::metadata(from)?.modified()?;
    std::fs::File::options().write(true).open(to)?.set_modified(modified)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_index_copy_keeps_the_timestamp_of_the_real_index() {
        let dir = tempfile::tempdir().unwrap();
        let real = dir.path().join("index");
        std::fs::write(&real, b"DIRC").unwrap();
        let when = std::time::SystemTime::now() - std::time::Duration::from_secs(3600);
        std::fs::File::options().write(true).open(&real).unwrap().set_modified(when).unwrap();
        let copy = dir.path().join("copy");
        copy_index_file(&real, &copy).unwrap();
        assert_eq!(std::fs::read(&copy).unwrap(), b"DIRC");
        assert_eq!(std::fs::metadata(&copy).unwrap().modified().unwrap(), when);
    }

    /// Years beyond 9999 in the notation that `new Date()` understands.
    #[test]
    fn unix_to_iso_writes_years_beyond_9999_in_the_expanded_form() {
        assert_eq!(unix_to_iso(1_772_434_800), "2026-03-02T07:00:00.000Z");
        assert_eq!(unix_to_iso(253_402_300_799), "9999-12-31T23:59:59.000Z");
        assert_eq!(unix_to_iso(253_402_300_800), "+010000-01-01T00:00:00.000Z");
        assert_eq!(unix_to_iso(-62_167_219_201), "-000001-12-31T23:59:59.000Z");
        // Absurdly large values: the start of the epoch, as before.
        assert_eq!(unix_to_iso(i64::MAX), "1970-01-01T00:00:00.000Z");
    }

    #[test]
    fn split_z_works() {
        let v: Vec<&[u8]> = split_z(b"a\0b\0").collect();
        assert_eq!(v, vec![b"a".as_slice(), b"b".as_slice()]);
        assert_eq!(split_z(b"").count(), 0);
        assert_eq!(split_z(b"\0").count(), 0);
        let v: Vec<&[u8]> = split_z(b"a\0\0b").collect();
        assert_eq!(v.len(), 3);
    }

    #[test]
    fn decode_guesses() {
        assert_eq!(decode_text("Grüße".as_bytes()), ("Grüße".to_string(), "utf-8"));
        assert_eq!(decode_text(b"Gr\xfc\xdfe"), ("Grüße".to_string(), "windows-1252"));
        assert_eq!(decode_text(b"\xef\xbb\xbfhi").1, "utf-8");
        assert_eq!(encode_text("Grüße", "windows-1252"), b"Gr\xfc\xdfe".to_vec());
        assert!(looks_binary(b"ab\0c"));
    }

    #[test]
    fn ref_names() {
        assert!(check_ref_name("feature/neu-1").is_ok());
        for bad in ["", "a b", "-x", "a..b", "a~1", "a/", ".a", "a.lock", "a//b", "HEAD", "a:b", "x."] {
            assert!(check_ref_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn path_keys() {
        let k = path_key(Path::new("/tmp/Repo/"));
        assert!(k.ends_with("/tmp/repo") || k.ends_with("/tmp/Repo"));
        if cfg!(windows) {
            assert_eq!(path_key(Path::new(r"C:\Users\X\Repo\")), "c:/users/x/repo");
            assert_eq!(path_key(Path::new("C:/Users/x/repo")), "c:/users/x/repo");
        }
    }

    #[test]
    fn atomic_write_creates_replaces_and_leaves_no_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("unter").join("datei.txt");
        write_file_atomic(&target, b"eins").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"eins");
        write_file_atomic(&target, b"zwei").unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"zwei");
        let names: Vec<_> = std::fs::read_dir(target.parent().unwrap()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names.len(), 1, "{names:?}");
        // A folder as target fails without leaving anything behind.
        let folder = dir.path().join("ordner");
        std::fs::create_dir_all(folder.join("innen")).unwrap();
        assert!(write_file_atomic(&folder, b"x").is_err());
        assert!(folder.join("innen").is_dir());
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    /// Another program briefly holds the file open without sharing (like a virus scanner or
    /// a concurrently reading Git): the write attempt waits instead of failing.
    #[cfg(windows)]
    #[test]
    fn atomic_write_waits_for_a_briefly_locked_file() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("gesperrt.txt");
        std::fs::write(&target, b"alt").unwrap();
        let held = std::fs::OpenOptions::new().read(true).share_mode(0).open(&target).unwrap();
        let direct = std::fs::write(&target, b"direkt").unwrap_err();
        assert!(is_transient_write_error(&direct), "{direct:?}");
        let release = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(300));
            drop(held);
        });
        let started = std::time::Instant::now();
        write_file_atomic(&target, b"neu").unwrap();
        assert!(started.elapsed() >= std::time::Duration::from_millis(200), "waited: {:?}", started.elapsed());
        release.join().unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"neu");

        // If the lock stays, the error comes after the time window – the target is unchanged.
        let held = std::fs::OpenOptions::new().read(true).share_mode(0).open(&target).unwrap();
        let started = std::time::Instant::now();
        assert!(write_file_atomic(&target, b"nie").is_err());
        assert!(started.elapsed() >= WRITE_RETRY_WINDOW);
        drop(held);
        assert_eq!(std::fs::read(&target).unwrap(), b"neu");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1, "keine Temp-Datei bleibt liegen");
    }

    #[test]
    fn truncation() {
        assert_eq!(truncate_str("abc", 10), "abc");
        assert!(truncate_str("äöü", 3).starts_with('ä'));
    }
}
