//! Avatars of commit authors from GitHub. For a `…@users.noreply.github.com` address with an
//! account number the image is available directly; otherwise GitHub looks up the account for the
//! email address. If GitHub does not know the address, a fixed placeholder comes back; the UI
//! then keeps showing the initials. Images (and "none") are kept for a week in the data folder so
//! that not every start queries the same addresses again. Can be turned off via "Initials instead
//! of avatars".

use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use base64::Engine;
use parking_lot::Mutex;

use crate::app::Core;
use crate::error::CoreResult;
use crate::http::{self, Request};

const DEFAULT_BASE: &str = "https://avatars.githubusercontent.com";
/// ETag of the placeholder GitHub returns for unknown addresses.
const PLACEHOLDER_ETAG: &str = "1506265dd79492985d428bf3ac115e873c30eedde97749ace57dff5a0020a0a2";
const SIZE: u32 = 64;
const MAX_AGE: Duration = Duration::from_secs(7 * 24 * 3600);
const CACHE_DIR: &str = "avatars";

#[derive(Default)]
struct AvatarState {
    /// Another address instead of GitHub (tests, E2E); `Some("")` turns the lookup off.
    base: Mutex<Option<String>>,
}

/// Sets the address of the avatar service (tests, development build).
pub fn configure(core: &Core, base: Option<String>) {
    *core.state::<AvatarState>().base.lock() = base;
}

/// The image for the email address as a data URL, or `None` if GitHub knows none or cannot be
/// reached.
pub async fn avatar_get(core: &Core, email: String) -> CoreResult<Option<String>> {
    let email = email.trim().to_ascii_lowercase();
    if !email.contains('@') || email.len() > 254 {
        return Ok(None);
    }
    let base = core.state::<AvatarState>().base.lock().clone().unwrap_or_else(|| DEFAULT_BASE.to_string());
    if base.is_empty() {
        return Ok(None);
    }
    let file = cache_file(core, &email);
    if let Some(cached) = read_cache(&file) {
        return Ok(cached);
    }
    let url = match noreply_id(&email) {
        Some(id) => format!("{base}/u/{id}?s={SIZE}"),
        None => format!("{base}/u/e?email={}&s={SIZE}", encode(&email)),
    };
    let found = match http::send(core, Request::get(url, "GitHub avatars")).await {
        Ok(response) if response.is_success() && response.header("etag").map(|tag| tag.trim_matches('"')) != Some(PLACEHOLDER_ETAG) => {
            let kind = response.header("content-type").unwrap_or("image/png").split(';').next().unwrap_or("image/png").trim().to_string();
            if !kind.starts_with("image/") {
                return Ok(None);
            }
            Some(format!("data:{kind};base64,{}", base64::engine::general_purpose::STANDARD.encode(&response.body)))
        }
        Ok(response) if response.is_success() || response.status == 404 => None,
        // No network or an error at the service: do not remember, try again next time.
        _ => return Ok(None),
    };
    write_cache(&file, found.as_deref());
    Ok(found)
}

/// `12345+name@users.noreply.github.com` → `12345`.
fn noreply_id(email: &str) -> Option<&str> {
    let local = email.strip_suffix("@users.noreply.github.com")?;
    let (id, _) = local.split_once('+')?;
    (!id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())).then_some(id)
}

fn encode(text: &str) -> String {
    text.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-._~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

/// File name from the address (FNV-1a, 64 bit): the address itself does not appear in the file name.
fn cache_file(core: &Core, email: &str) -> PathBuf {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in email.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    core.data_dir().join(CACHE_DIR).join(format!("{hash:016x}"))
}

/// `Some(None)`: remembered that there is no image. `None`: nothing (fresh) remembered.
fn read_cache(file: &PathBuf) -> Option<Option<String>> {
    let modified = std::fs::metadata(file).and_then(|meta| meta.modified()).ok()?;
    if SystemTime::now().duration_since(modified).unwrap_or_default() > MAX_AGE {
        return None;
    }
    let text = std::fs::read_to_string(file).ok()?;
    Some((!text.is_empty()).then_some(text))
}

fn write_cache(file: &PathBuf, value: Option<&str>) {
    if let Some(dir) = file.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Err(e) = std::fs::write(file, value.unwrap_or("")) {
        log::debug!("Avatar not cached: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testkit::mock_http::{MockResponse, MockServer};
    use crate::testkit::TestCore;

    fn server() -> MockServer {
        MockServer::start(|request| match (request.path(), request.query("email").as_deref()) {
            ("/u/e", Some("lena@example.com")) => MockResponse::bytes(200, "image/png", b"PNG".to_vec()),
            ("/u/e", _) => MockResponse::bytes(200, "image/png", b"default".to_vec()).header("etag", format!("\"{PLACEHOLDER_ETAG}\"")),
            ("/u/583231", _) => MockResponse::bytes(200, "image/jpeg", b"JPG".to_vec()),
            _ => MockResponse::empty(404),
        })
    }

    #[tokio::test]
    async fn known_addresses_get_an_image_and_unknown_ones_none() {
        let tc = TestCore::new().await;
        let mock = server();
        configure(&tc, Some(mock.url()));
        assert_eq!(avatar_get(&tc, "Lena@Example.com".into()).await.unwrap().as_deref(), Some("data:image/png;base64,UE5H"));
        assert_eq!(avatar_get(&tc, "583231+octo@users.noreply.github.com".into()).await.unwrap().as_deref(), Some("data:image/jpeg;base64,SlBH"));
        assert_eq!(avatar_get(&tc, "niemand@example.com".into()).await.unwrap(), None, "the placeholder does not count");
        assert_eq!(avatar_get(&tc, "kein-at".into()).await.unwrap(), None);
    }

    #[tokio::test]
    async fn answers_are_cached_on_disk() {
        let tc = TestCore::new().await;
        let mock = server();
        configure(&tc, Some(mock.url()));
        avatar_get(&tc, "lena@example.com".into()).await.unwrap();
        avatar_get(&tc, "niemand@example.com".into()).await.unwrap();
        avatar_get(&tc, "lena@example.com".into()).await.unwrap();
        avatar_get(&tc, "niemand@example.com".into()).await.unwrap();
        assert_eq!(mock.requests().len(), 2, "only one request per address");
    }

    #[tokio::test]
    async fn an_empty_base_turns_the_lookup_off() {
        let tc = TestCore::new().await;
        configure(&tc, Some(String::new()));
        assert_eq!(avatar_get(&tc, "lena@example.com".into()).await.unwrap(), None);
    }
}
