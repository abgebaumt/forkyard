//! Free space on the disk that holds a folder (`statvfs` / `GetDiskFreeSpaceExW`). `None` if the
//! system does not say – the dialog then shows “unknown”.

use std::path::Path;

/// Bytes available to this user on the disk of `path`.
#[cfg(unix)]
pub(super) fn free_bytes(path: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let name = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: an all-zero `statvfs` is a valid value of this plain C struct.
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `name` is NUL-terminated and outlives the call; `stat` is a valid out pointer.
    let rc = unsafe { libc::statvfs(name.as_ptr(), &mut stat) };
    if rc != 0 {
        return None;
    }
    // The field types differ between Linux (u64) and macOS (u32 blocks).
    #[allow(clippy::unnecessary_cast)]
    let bytes = (stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64);
    Some(bytes)
}

/// Bytes available to this user on the disk of `path`.
#[cfg(windows)]
pub(super) fn free_bytes(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut available: u64 = 0;
    // SAFETY: `wide` is NUL-terminated and outlives the call; the two other out pointers may be null.
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, std::ptr::null_mut(), std::ptr::null_mut()) };
    (ok != 0).then_some(available)
}
