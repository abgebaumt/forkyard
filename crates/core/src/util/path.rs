//! Paths: bytes from Git, OS notation, display and comparison keys.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_keys() {
        let k = path_key(Path::new("/tmp/Repo/"));
        assert!(k.ends_with("/tmp/repo") || k.ends_with("/tmp/Repo"));
        if cfg!(windows) {
            assert_eq!(path_key(Path::new(r"C:\Users\X\Repo\")), "c:/users/x/repo");
            assert_eq!(path_key(Path::new("C:/Users/x/repo")), "c:/users/x/repo");
        }
    }
}
