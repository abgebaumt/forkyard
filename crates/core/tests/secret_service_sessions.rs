//! gnome-keyring-daemon 50.0 aborts now and then when clients keep opening new Secret Service
//! sessions (`plain_negotiate: assertion 'session' failed`, seen a few hundred sessions in), and a
//! user's daemon that comes back after such an abort has its login keyring locked. The keychain
//! calls of one process therefore share one connection and one session.
//!
//! Its own test binary: it points the process at a private D-Bus session bus with its own
//! unlocked gnome-keyring-daemon in a temp folder, never at the user's keychain. Skipped when
//! dbus-daemon, gnome-keyring-daemon or gdbus are missing.
#![cfg(target_os = "linux")]

use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use gitcore::commands::auth::keychain;

fn on_path(name: &str) -> bool {
    Command::new("sh").args(["-c", &format!("command -v {name}")]).stdout(Stdio::null()).status().is_ok_and(|s| s.success())
}

struct PrivateKeyring {
    /// Bus first, then the keyring daemon.
    children: Vec<Child>,
    address: String,
    dir: tempfile::TempDir,
}

impl PrivateKeyring {
    /// Ends the keyring daemon and starts a new one on the same bus and keyring folder (like a
    /// user's daemon that crashed and was started again).
    fn restart_daemon(&mut self) {
        let mut old = self.children.pop().unwrap();
        let _ = old.kill();
        let _ = old.wait();
        self.children.push(spawn_daemon(&self.address, self.dir.path()));
        wait_for(|| unlocked(&self.address));
        assert!(unlocked(&self.address), "the restarted keyring is unlocked");
    }
}

impl Drop for PrivateKeyring {
    fn drop(&mut self) {
        for child in &mut self.children {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn gdbus(address: &str, args: &[&str]) -> Option<String> {
    let out = Command::new("gdbus").env("DBUS_SESSION_BUS_ADDRESS", address).args(["call", "--session", "--timeout", "10", "--dest", "org.freedesktop.secrets"]).args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn start_keyring() -> Option<PrivateKeyring> {
    if !(on_path("dbus-daemon") && on_path("gnome-keyring-daemon") && on_path("gdbus")) {
        eprintln!("skipped: dbus-daemon, gnome-keyring-daemon or gdbus missing");
        return None;
    }
    let dir = tempfile::tempdir().unwrap();
    let path = |name: &str| dir.path().join(name);
    std::fs::create_dir_all(path("run")).unwrap();
    std::fs::create_dir_all(path("data")).unwrap();
    // A bus without service files: nothing on it is D-Bus-activated behind the test's back.
    let bus = path("bus");
    std::fs::write(
        path("bus.conf"),
        format!(
            "<!DOCTYPE busconfig PUBLIC \"-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN\" \"http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd\">\n<busconfig><type>session</type><listen>unix:path={}</listen><auth>EXTERNAL</auth><policy context=\"default\"><allow send_destination=\"*\" eavesdrop=\"true\"/><allow eavesdrop=\"true\"/><allow own=\"*\"/></policy></busconfig>\n",
            bus.display()
        ),
    )
    .unwrap();
    let address = format!("unix:path={}", bus.display());
    let mut children = vec![Command::new("dbus-daemon").arg("--config-file").arg(path("bus.conf")).arg("--nofork").stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap()];
    wait_for(|| bus.exists());
    children.push(spawn_daemon(&address, dir.path()));
    let keyring = PrivateKeyring { children, address, dir };
    wait_for(|| unlocked(&keyring.address));
    assert!(unlocked(&keyring.address), "the private keyring came up unlocked");
    Some(keyring)
}

/// gnome-keyring-daemon on the private bus, its keyring in `dir/data`, unlocked with a fixed password.
fn spawn_daemon(address: &str, dir: &Path) -> Child {
    let mut daemon = Command::new("gnome-keyring-daemon")
        .args(["--foreground", "--unlock", "--components=secrets"])
        .arg(format!("--control-directory={}", dir.join("run").display()))
        .env("DBUS_SESSION_BUS_ADDRESS", address)
        .env("XDG_RUNTIME_DIR", dir.join("run"))
        .env("XDG_DATA_HOME", dir.join("data"))
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    {
        use std::io::Write;
        let mut stdin = daemon.stdin.take().unwrap();
        stdin.write_all(b"forkyard-test\n").unwrap();
    }
    daemon
}

fn unlocked(address: &str) -> bool {
    gdbus(address, &["--object-path", "/org/freedesktop/secrets/aliases/default", "--method", "org.freedesktop.DBus.Properties.Get", "org.freedesktop.Secret.Collection", "Locked"]).is_some_and(|s| s.contains("false"))
}

fn wait_for(mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !ready() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Number of the session the daemon hands out next ("/org/freedesktop/secrets/session/s7" → 7):
/// it counts every session opened so far, also those of clients that are gone.
fn next_session_number(address: &str) -> u32 {
    let out = gdbus(address, &["--object-path", "/org/freedesktop/secrets", "--method", "org.freedesktop.Secret.Service.OpenSession", "plain", "<''>"]).expect("OpenSession answers");
    let tail = out.rsplit("/session/s").next().unwrap();
    tail.trim_end_matches(|c: char| !c.is_ascii_digit()).parse().unwrap_or_else(|_| panic!("session path in {out}"))
}

#[tokio::test(flavor = "multi_thread")]
async fn keychain_calls_share_one_secret_service_session() {
    let Some(mut keyring) = start_keyring() else { return };
    // The whole test binary talks to the private bus only.
    std::env::set_var("DBUS_SESSION_BUS_ADDRESS", &keyring.address);
    let before = next_session_number(&keyring.address);

    let service = format!("{}{}", keychain::TEST_SERVICE_PREFIX, "sessions");
    assert!(keychain::probe(&service).await, "the private keychain answers");
    for round in 0..10 {
        let account = format!("konto-{round}");
        let secret = format!("geheim-ä-{round}");
        keychain::set(&service, &account, &secret).await.unwrap();
        assert_eq!(keychain::get(&service, &account).await.unwrap().as_deref(), Some(secret.as_str()));
        assert!(keychain::delete(&service, &account).await.unwrap());
        assert_eq!(keychain::get(&service, &account).await.unwrap(), None);
    }

    // 1 probe + 10 × (set with read back, get, delete with read back, get): one session for all of them.
    let opened = next_session_number(&keyring.address) - before - 1;
    assert!(opened <= 1, "the keychain calls opened {opened} Secret Service sessions");

    // Same entries as before the shared connection: keyring's own backend (a connection per
    // call) reads what the keychain wrote, and the keychain reads what it wrote.
    use keyring::credential::CredentialApi;
    let own = |user: &str| keyring::secret_service::SsCredential::new_with_target(None, &service, user).unwrap();
    keychain::set(&service, "lena", "Sonnen-Sensor-42").await.unwrap();
    assert_eq!(own("lena").get_password().unwrap(), "Sonnen-Sensor-42");
    own("jonas").set_password("grün\u{e4}").unwrap();
    assert_eq!(keychain::get(&service, "jonas").await.unwrap().as_deref(), Some("grün\u{e4}"));
    // An entry of an older keyring version without a target is still found in the default collection.
    {
        let ss = dbus_secret_service::SecretService::connect(dbus_secret_service::EncryptionType::Plain).unwrap();
        let attributes = std::collections::HashMap::from([("service", service.as_str()), ("username", "alt")]);
        ss.get_default_collection().unwrap().create_item("alt", attributes, "von früher".as_bytes(), true, "text/plain").unwrap();
    }
    assert_eq!(keychain::get(&service, "alt").await.unwrap().as_deref(), Some("von früher"));

    // The daemon is started again (its old session is gone): the next call connects anew.
    keyring.restart_daemon();
    assert_eq!(keychain::get(&service, "lena").await.unwrap().as_deref(), Some("Sonnen-Sensor-42"), "read after the restart");
    keychain::set(&service, "lena", "neu").await.unwrap();
    assert_eq!(own("lena").get_password().unwrap(), "neu");
}
