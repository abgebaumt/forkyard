//! SSH key files: folder, finding and calling ssh-keygen, fingerprint, detecting a
//! passphrase.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use base64::Engine;

use super::broker::{AuthConfig, Broker, SessionMode};
use crate::error::{CoreError, CoreResult, ErrorCode};
use crate::git::GitInfo;
use crate::util;

/// Overrides the SSH folder (otherwise `~/.ssh`).
pub const SSH_DIR_ENV: &str = "FORKYARD_SSH_DIR";
/// Shortest passphrase ssh-keygen accepts.
pub const MIN_PASSPHRASE_LEN: usize = 5;
const KEYGEN_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_PUBLIC_KEY_BYTES: u64 = 64 * 1024;
const MAX_PRIVATE_KEY_BYTES: u64 = 256 * 1024;

/// The user's SSH folder. Never the real one in our own unit tests: there it must be set via
/// `AuthConfig::ssh_dir`.
pub fn ssh_dir(config: &AuthConfig) -> CoreResult<PathBuf> {
    if let Some(dir) = &config.ssh_dir {
        return Ok(dir.clone());
    }
    if cfg!(test) {
        return Err(CoreError::not_allowed("In tests, the SSH folder must be redirected (AuthConfig::ssh_dir)."));
    }
    if let Some(dir) = std::env::var_os(SSH_DIR_ENV).filter(|d| !d.is_empty()) {
        return Ok(PathBuf::from(dir));
    }
    dirs::home_dir()
        .map(|home| home.join(".ssh"))
        .ok_or_else(|| CoreError::io("The home folder was not found, so the SSH folder is unknown."))
}

fn keygen_missing() -> CoreError {
    CoreError::unsupported(
        "ssh-keygen was not found. Install OpenSSH (on Windows it is part of Git for Windows and of the optional Windows feature “OpenSSH Client”).",
    )
}

/// Looks for ssh-keygen: the setting from the configuration, next to Git (Git for Windows ships
/// it), in PATH, and on Windows finally in the system folder.
pub fn find_ssh_keygen(config: &AuthConfig, git: Option<&GitInfo>) -> CoreResult<PathBuf> {
    if let Some(path) = &config.ssh_keygen_path {
        return if path.is_file() { Ok(path.clone()) } else { Err(keygen_missing()) };
    }
    let name = format!("ssh-keygen{}", std::env::consts::EXE_SUFFIX);
    if cfg!(windows) {
        if let Some(git) = git {
            // <Git>\cmd\git.exe or <Git>\mingw64\bin\git.exe → <Git>\usr\bin\ssh-keygen.exe
            for root in git.path.ancestors().skip(1).take(3) {
                let candidate = root.join("usr").join("bin").join(&name);
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
    }
    if let Ok(path) = which::which("ssh-keygen") {
        return Ok(path);
    }
    if cfg!(windows) {
        if let Some(root) = std::env::var_os("SystemRoot") {
            let candidate = Path::new(&root).join("System32").join("OpenSSH").join(&name);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err(keygen_missing())
}

/// Checks a file name for a new key (only a name, no path).
pub fn check_file_name(name: &str) -> CoreResult<String> {
    let name = name.trim();
    let reason = if name.is_empty() {
        Some("The file name must not be empty.")
    } else if name == "." || name == ".." || name.starts_with('-') {
        Some("This file name is not allowed.")
    } else if name.chars().any(|c| c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')) {
        Some("The file name must not contain path separators or special characters such as : * ? \" < > |.")
    } else if name.to_lowercase().ends_with(".pub") {
        Some("The file name must not end in “.pub”; that is the name of the public key file.")
    } else if name.ends_with('.') || name.ends_with(' ') || name.len() > 100 {
        Some("This file name is not allowed.")
    } else {
        None
    };
    match reason {
        Some(reason) => Err(CoreError::invalid_name(reason)),
        None => Ok(name.to_string()),
    }
}

/// Path of the public key file next to the private one (`<name>.pub`).
pub fn public_path_for(private: &Path) -> PathBuf {
    let mut name = private.as_os_str().to_os_string();
    name.push(".pub");
    PathBuf::from(name)
}

struct ToolOutput {
    success: bool,
    stdout: Vec<u8>,
    stderr: String,
}

async fn run_keygen(keygen: &Path, args: &[&std::ffi::OsStr], env: &[(std::ffi::OsString, std::ffi::OsString)]) -> CoreResult<ToolOutput> {
    let mut cmd = tokio::process::Command::new(keygen);
    cmd.args(args)
        .env("LC_ALL", "C")
        .env("LANG", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (key, value) in env {
        cmd.env(key, value);
    }
    #[cfg(windows)]
    cmd.creation_flags(crate::git::runner::CREATE_NO_WINDOW);
    let child = match cmd.spawn() {
        Ok(child) => child,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(keygen_missing()),
        Err(e) => return Err(CoreError::io(format!("ssh-keygen could not be started: {e}"))),
    };
    match tokio::time::timeout(KEYGEN_TIMEOUT, child.wait_with_output()).await {
        Ok(Ok(out)) => {
            Ok(ToolOutput { success: out.status.success(), stdout: out.stdout, stderr: util::decode_lossy(&out.stderr) })
        }
        Ok(Err(e)) => Err(CoreError::io(format!("ssh-keygen was aborted: {e}"))),
        Err(_) => Err(CoreError::new(ErrorCode::Timeout, "ssh-keygen did not respond in time.")),
    }
}

/// Generates an ed25519 pair. The passphrase reaches ssh-keygen through the askpass helper
/// and thus never appears on a command line.
pub async fn generate(
    broker: &Broker,
    keygen: &Path,
    private: &Path,
    comment: &str,
    passphrase: Option<&str>,
) -> CoreResult<()> {
    let mut args: Vec<&std::ffi::OsStr> =
        vec!["-q".as_ref(), "-t".as_ref(), "ed25519".as_ref(), "-f".as_ref(), private.as_os_str(), "-C".as_ref(), comment.as_ref()];
    let session = match passphrase {
        None => {
            args.extend(["-N".as_ref(), "".as_ref()] as [&std::ffi::OsStr; 2]);
            None
        }
        Some(passphrase) => {
            let session = broker.begin(SessionMode::Scripted(passphrase.to_string())).await;
            if !session.is_active() {
                return Err(CoreError::unsupported(
                    "The prompt helper (forkyard-askpass) is missing, so a key with a passphrase can't be created.",
                ));
            }
            Some(session)
        }
    };
    let env = session.as_ref().map(|s| s.env().to_vec()).unwrap_or_default();
    let result = run_keygen(keygen, &args, &env).await;
    drop(session);
    let out = result?;
    if !out.success || !private.is_file() {
        // Do not leave half-written files behind.
        let _ = std::fs::remove_file(private);
        let _ = std::fs::remove_file(public_path_for(private));
        let lower = out.stderr.to_lowercase();
        let reason = if lower.contains("permission denied") || lower.contains("access is denied") || lower.contains("zugriff verweigert") {
            " The SSH key folder is not writable (access denied). Check the folder's permissions."
        } else if lower.contains("no such file or directory") {
            " The SSH key folder does not exist."
        } else {
            ""
        };
        return Err(CoreError::io(format!("ssh-keygen could not create the key.{reason}")).with_git_output(out.stderr));
    }
    if passphrase.is_some() && read_private(private).and_then(|content| encrypted_from_file(&content)) != Some(true) {
        // ssh-keygen did not get the passphrase (it could not start the helper program) and
        // wrote an unprotected key: that must not exist.
        let _ = std::fs::remove_file(private);
        let _ = std::fs::remove_file(public_path_for(private));
        return Err(CoreError::io(
            "ssh-keygen did not accept the passphrase, so no key was created. Create the key without a passphrase or use a different OpenSSH.",
        )
        .with_git_output(out.stderr));
    }
    Ok(())
}

/// Fingerprint (`SHA256:…`) of a public key via `ssh-keygen -lf`.
pub async fn fingerprint(keygen: &Path, public: &Path) -> Option<String> {
    let args: [&std::ffi::OsStr; 4] = ["-l".as_ref(), "-E".as_ref(), "sha256".as_ref(), "-f".as_ref()];
    let mut args = args.to_vec();
    args.push(public.as_os_str());
    let out = run_keygen(keygen, &args, &[]).await.ok()?;
    if !out.success {
        return None;
    }
    // "256 SHA256:abc… comment (ED25519)"
    util::decode_lossy(&out.stdout).split_whitespace().find(|token| token.starts_with("SHA256:")).map(str::to_string)
}

/// Content of the .pub file (one line), empty if it is missing or too large.
pub fn read_public_key(public: &Path) -> String {
    match std::fs::metadata(public) {
        Ok(meta) if meta.is_file() && meta.len() <= MAX_PUBLIC_KEY_BYTES => {
            std::fs::read(public).map(|bytes| util::decode_lossy(&bytes).trim().to_string()).unwrap_or_default()
        }
        _ => String::new(),
    }
}

/// Reads from the key file whether it is encrypted. `None`: format not recognised.
pub fn encrypted_from_file(content: &[u8]) -> Option<bool> {
    let text = String::from_utf8_lossy(content);
    const OPENSSH_BEGIN: &str = "-----BEGIN OPENSSH PRIVATE KEY-----";
    const OPENSSH_END: &str = "-----END OPENSSH PRIVATE KEY-----";
    if let Some(start) = text.find(OPENSSH_BEGIN) {
        let body = &text[start + OPENSSH_BEGIN.len()..];
        let body = &body[..body.find(OPENSSH_END)?];
        let compact: String = body.chars().filter(|c| !c.is_whitespace()).collect();
        let blob = base64::engine::general_purpose::STANDARD.decode(compact).ok()?;
        // "openssh-key-v1\0", then the cipher name as a length-prefixed string.
        let rest = blob.strip_prefix(b"openssh-key-v1\0")?;
        let len = usize::try_from(u32::from_be_bytes(rest.get(..4)?.try_into().ok()?)).ok()?;
        let cipher = rest.get(4..4 + len)?;
        return Some(cipher != b"none");
    }
    if text.contains("-----BEGIN ENCRYPTED PRIVATE KEY-----") || text.contains("Proc-Type: 4,ENCRYPTED") {
        return Some(true);
    }
    if text.contains("PRIVATE KEY-----") {
        return Some(false);
    }
    None
}

/// Whether the file looks like a private key (PEM or OpenSSH format).
pub fn looks_like_private_key(private: &Path) -> bool {
    read_private(private).is_some_and(|content| String::from_utf8_lossy(&content).contains("PRIVATE KEY-----"))
}

fn read_private(private: &Path) -> Option<Vec<u8>> {
    let meta = std::fs::metadata(private).ok()?;
    if !meta.is_file() || meta.len() > MAX_PRIVATE_KEY_BYTES {
        return None;
    }
    std::fs::read(private).ok()
}

/// Whether the private key has a passphrase: read from the file format; for an unknown format
/// `ssh-keygen -y -P ""` decides (fails → passphrase).
pub async fn has_passphrase(keygen: Option<&Path>, private: &Path) -> bool {
    let Some(content) = read_private(private) else {
        return false;
    };
    if let Some(encrypted) = encrypted_from_file(&content) {
        return encrypted;
    }
    match keygen {
        Some(keygen) => !loads_without_passphrase(keygen, private).await,
        None => false,
    }
}

/// `ssh-keygen -y -P "" -f <key>`: succeeds only without a passphrase.
pub async fn loads_without_passphrase(keygen: &Path, private: &Path) -> bool {
    let args: [&std::ffi::OsStr; 5] = ["-y".as_ref(), "-P".as_ref(), "".as_ref(), "-f".as_ref(), private.as_os_str()];
    matches!(run_keygen(keygen, &args, &[]).await, Ok(out) if out.success)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_names() {
        for good in ["id_ed25519", "arbeit-2026", "Schlüssel für GitHub", "id.key"] {
            assert_eq!(check_file_name(good).unwrap(), good, "{good}");
        }
        assert_eq!(check_file_name("  id_ed25519  ").unwrap(), "id_ed25519");
        for bad in ["", "  ", ".", "..", "../id", "a/b", "a\\b", "C:key", "-f", "id.pub", "ID.PUB", "a\nb", "a?", "ende.", "x\0y"] {
            let err = check_file_name(bad).unwrap_err();
            assert_eq!(err.code, ErrorCode::InvalidName, "{bad:?}");
        }
    }

    #[test]
    fn public_path_is_private_plus_pub() {
        assert_eq!(public_path_for(Path::new("/h/.ssh/id_ed25519")), PathBuf::from("/h/.ssh/id_ed25519.pub"));
        assert_eq!(public_path_for(Path::new("/h/.ssh/schlüssel.key")), PathBuf::from("/h/.ssh/schlüssel.key.pub"));
    }

    #[test]
    fn encryption_is_read_from_the_file_format() {
        // Header of an OpenSSH key file: magic, cipher, KDF.
        fn openssh(cipher: &str) -> Vec<u8> {
            let mut blob = b"openssh-key-v1\0".to_vec();
            blob.extend((cipher.len() as u32).to_be_bytes());
            blob.extend(cipher.as_bytes());
            blob.extend([0u8; 40]);
            let b64 = base64::engine::general_purpose::STANDARD.encode(blob);
            let lines: Vec<&str> = b64.as_bytes().chunks(70).map(|c| std::str::from_utf8(c).unwrap()).collect();
            format!("-----BEGIN OPENSSH PRIVATE KEY-----\r\n{}\r\n-----END OPENSSH PRIVATE KEY-----\r\n", lines.join("\r\n")).into_bytes()
        }
        assert_eq!(encrypted_from_file(&openssh("none")), Some(false));
        assert_eq!(encrypted_from_file(&openssh("aes256-ctr")), Some(true));
        assert_eq!(
            encrypted_from_file(b"-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,00\n\nAAAA\n-----END RSA PRIVATE KEY-----\n"),
            Some(true)
        );
        assert_eq!(encrypted_from_file(b"-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n"), Some(false));
        assert_eq!(encrypted_from_file(b"-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----\n"), Some(true));
        assert_eq!(encrypted_from_file(b"ssh-ed25519 AAAA kommentar\n"), None);
        assert_eq!(encrypted_from_file(b"-----BEGIN OPENSSH PRIVATE KEY-----\n!!!\n-----END OPENSSH PRIVATE KEY-----\n"), None);
        assert_eq!(encrypted_from_file(b""), None);
    }
}
