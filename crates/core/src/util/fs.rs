//! File system helpers: private files and folders, atomic writes, index copies.

use std::path::Path;

use super::new_id;

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
}
