//! Paths: bytes from Git, OS notation, display and comparison keys.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use crate::error::{CoreError, CoreResult};

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

/// Checks a path from the UI and brings it into Git's form: relative to the
/// repository, with `/`, without `.` parts. Absolute, `..` or empty → `not_allowed`.
pub fn normalize_rel_path(path: &str) -> CoreResult<String> {
    let outside = || CoreError::not_allowed(format!("The path “{path}” is outside the repository."));
    if path.contains('\0') {
        return Err(CoreError::not_allowed("The path contains an invalid character."));
    }
    let unified = if cfg!(windows) { path.replace('\\', "/") } else { path.to_string() };
    let bytes = unified.as_bytes();
    let has_drive = cfg!(windows) && bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic();
    if unified.starts_with('/') || has_drive || Path::new(&unified).is_absolute() {
        return Err(outside());
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in unified.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err(outside()),
            other => parts.push(other),
        }
    }
    if parts.is_empty() {
        return Err(CoreError::not_allowed("No file path was given."));
    }
    Ok(parts.join("/"))
}

/// Whether a path component means the Git directory (also in the spellings Windows treats as equal).
fn is_git_component(part: &str) -> bool {
    let mut name = part.to_lowercase();
    if cfg!(windows) {
        name = name.trim_end_matches(['.', ' ']).to_string();
        if name == "git~1" {
            return true;
        }
    }
    name == ".git"
}

/// Whether the (already normalised) path points into a `.git` directory.
pub fn is_inside_git_dir(rel: &str) -> bool {
    rel.split('/').any(is_git_component)
}

pub(crate) fn join_rel(root: &Path, rel: &str) -> PathBuf {
    let mut path = root.to_path_buf();
    for part in rel.split('/') {
        path.push(part);
    }
    path
}

/// Absolute path for reading. If a symlink leads out of the repository: `not_allowed`.
pub(crate) fn resolve_for_read(root: &Path, rel: &str) -> CoreResult<PathBuf> {
    let target = join_rel(root, rel);
    if let (Ok(real_root), Ok(real)) = (root.canonicalize(), target.canonicalize()) {
        if !real.starts_with(&real_root) {
            return Err(CoreError::not_allowed(format!("“{rel}” points to a file outside the repository.")));
        }
    }
    Ok(target)
}

/// Absolute path for writing. Follows symlinks as far as the path already exists, and
/// rejects everything that would then lie outside the repository or in `.git`.
pub(crate) fn resolve_for_write(root: &Path, rel: &str) -> CoreResult<PathBuf> {
    let git_error = || CoreError::not_allowed("Writing to the Git directory (.git) is not allowed.");
    if is_inside_git_dir(rel) {
        return Err(git_error());
    }
    let real_root = root.canonicalize()?;
    let target = join_rel(root, rel);
    // Deepest part of the path that already exists.
    let mut existing = target.clone();
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    while existing.symlink_metadata().is_err() {
        match (existing.file_name().map(|n| n.to_os_string()), existing.parent().map(Path::to_path_buf)) {
            (Some(name), Some(parent)) => {
                rest.push(name);
                existing = parent;
            }
            _ => break,
        }
    }
    let real = existing.canonicalize()?;
    let inside = real
        .strip_prefix(&real_root)
        .map_err(|_| CoreError::not_allowed(format!("“{rel}” points to a location outside the repository.")))?;
    if inside.components().any(|c| is_git_component(&c.as_os_str().to_string_lossy())) {
        return Err(git_error());
    }
    let mut resolved = real;
    for name in rest.iter().rev() {
        resolved.push(name);
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;

    #[test]
    fn path_rules() {
        assert_eq!(normalize_rel_path("a/b.txt").unwrap(), "a/b.txt");
        assert_eq!(normalize_rel_path("./a//b/./c").unwrap(), "a/b/c");
        assert_eq!(normalize_rel_path("Über uns/ä ö.txt").unwrap(), "Über uns/ä ö.txt");
        assert_eq!(normalize_rel_path("..a/b..").unwrap(), "..a/b..");
        for bad in ["", "/", "..", "a/..", "/a", "a\0b", "./.."] {
            assert_eq!(normalize_rel_path(bad).unwrap_err().code, ErrorCode::NotAllowed, "{bad:?}");
        }
        assert!(is_inside_git_dir(".git/config") && is_inside_git_dir("a/.GIT/x") && is_inside_git_dir(".git"));
        assert!(!is_inside_git_dir(".gitignore") && !is_inside_git_dir("a/.github/x") && !is_inside_git_dir("x.git/y"));
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
}
