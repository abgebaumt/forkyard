//! In-app update: the updater plugin checks, downloads and verifies the signature; what is decided
//! (installable package, same version as the notice) lives in `gitcore::commands::update`.

use gitcore::commands::update::{check_reported, ensure_installable};
use gitcore::windowing::scoped;
use gitcore::{Core, CoreError, ErrorCode};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tauri_plugin_updater::{Update, UpdaterExt};

type R<T> = Result<T, CoreError>;

/// Downloaded and signature-checked update, waiting for "Restart now".
#[derive(Default)]
pub struct Pending(tokio::sync::Mutex<Option<(Update, Vec<u8>)>>);

/// Development build only: installs without restarting the app (E2E).
const NO_RESTART_ENV: &str = "FORKYARD_UPDATER_NO_RESTART";

/// Plugin error → CoreError with the codes the UI knows.
pub(crate) fn core_error(error: &tauri_plugin_updater::Error) -> CoreError {
    use tauri_plugin_updater::Error as E;
    let code = match error {
        E::Minisign(_) | E::SignedVersionMismatch { .. } | E::MissingSignedVersion => ErrorCode::UpdateSignatureInvalid,
        E::Reqwest(e) if e.is_timeout() => ErrorCode::Timeout,
        E::Network(_) | E::Reqwest(_) => ErrorCode::Offline,
        E::ReleaseNotFound | E::TargetNotFound(_) | E::TargetsNotFound(_) => ErrorCode::NotFound,
        E::InvalidUpdaterFormat | E::UnsupportedOs | E::UnsupportedArch => ErrorCode::UpdateUnavailableForPackage,
        _ => return CoreError::unknown(gitcore::secrets::scrub(&error.to_string(), &[])),
    };
    CoreError::new(code, gitcore::secrets::scrub(&error.to_string(), &[]))
}

/// Debug builds: the `plugins.updater` value from the switches, `None` without `FORKYARD_UPDATER_URL`.
pub(crate) fn dev_config(url: Option<String>, pubkey: Option<String>) -> Option<serde_json::Value> {
    let url = url?;
    Some(serde_json::json!({ "pubkey": pubkey.unwrap_or_default(), "endpoints": [url], "dangerousInsecureTransportProtocol": true }))
}

#[tauri::command]
pub async fn update_download(core: State<'_, Core>, app: AppHandle, window: WebviewWindow, job_id: String, version: String) -> R<()> {
    ensure_installable(&core)?;
    let handle = app.clone();
    // Windows: the plugin ends the process with `exit(0)` after starting the installer, so `RunEvent::Exit`
    // never runs; without `finish_exit` the next start reports a crash. No-op on other platforms (E2E cannot cover it).
    let updater = app.updater_builder().on_before_exit(move || {
        handle.cleanup_before_exit();
        crate::finish_exit(&handle);
    });
    let update = updater.build().map_err(|e| core_error(&e))?.check().await.map_err(|e| core_error(&e))?;
    let update = update.ok_or_else(|| CoreError::not_found("No update found for this system in the latest release."))?;
    check_reported(&version, &update.version)?;
    let job = core.start_job(&job_id, None)?;
    let result = scoped(window.label().to_string(), async {
        let mut received = 0u64;
        let download = update.download(
            |chunk, total| {
                received += chunk as u64;
                job.progress("download", total.filter(|t| *t > 0).map(|t| (received * 100 / t).min(100) as u32), "");
            },
            || {},
        );
        tokio::select! {
            bytes = download => bytes.map_err(|e| core_error(&e)),
            () = job.token().cancelled() => Err(CoreError::cancelled()),
        }
    })
    .await;
    job.finish(&result);
    *app.state::<Pending>().0.lock().await = Some((update, result?));
    Ok(())
}

#[tauri::command]
pub async fn update_install(core: State<'_, Core>, app: AppHandle, window: WebviewWindow) -> R<()> {
    let state = app.state::<Pending>();
    let mut pending = state.0.lock().await;
    let (update, bytes) = pending.as_ref().ok_or_else(|| CoreError::not_allowed("Download the update first."))?;
    scoped(window.label().to_string(), gitcore::commands::app::app_quit(&core)).await?;
    if let Err(e) = update.install(bytes) {
        // The app keeps running: guard back on, the verified bytes stay in `Pending` for a retry.
        // Cancelled jobs stay cancelled.
        gitcore::commands::app::resume_after_failed_quit(&core);
        // Windows: `on_before_exit` may already have hidden the windows (and run `finish_exit`).
        #[cfg(windows)]
        for w in app.webview_windows().values() {
            let _ = w.show();
        }
        return Err(core_error(&e));
    }
    pending.take();
    if crate::dev_env_value(NO_RESTART_ENV).is_none() {
        app.restart();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn plugin_errors_get_forkyard_codes() {
        use tauri_plugin_updater::Error as E;
        assert_eq!(core_error(&E::ReleaseNotFound).code, ErrorCode::NotFound);
        assert_eq!(core_error(&E::TargetNotFound("linux-x86_64".into())).code, ErrorCode::NotFound);
        assert_eq!(core_error(&E::InvalidUpdaterFormat).code, ErrorCode::UpdateUnavailableForPackage);
        assert_eq!(core_error(&E::EmptyEndpoints).code, ErrorCode::Unknown);
    }

    #[test]
    fn the_release_config_points_at_the_latest_release_download() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            conf["plugins"]["updater"]["endpoints"],
            json!(["https://github.com/abgebaumt/forkyard/releases/latest/download/latest.json"])
        );
        assert!(conf["bundle"].get("createUpdaterArtifacts").is_none(), "only through tauri.updater.conf.json");
        let extra: serde_json::Value = serde_json::from_str(include_str!("../tauri.updater.conf.json")).unwrap();
        assert_eq!(extra, json!({ "bundle": { "createUpdaterArtifacts": true } }));
    }

    #[test]
    fn dev_switches_build_an_insecure_local_updater_config() {
        assert_eq!(dev_config(None, Some("k".into())), None);
        assert_eq!(
            dev_config(Some("http://127.0.0.1:4711/latest.json".into()), Some("k".into())),
            Some(json!({ "pubkey": "k", "endpoints": ["http://127.0.0.1:4711/latest.json"], "dangerousInsecureTransportProtocol": true }))
        );
    }
}
