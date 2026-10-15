//! Commit signing: read and set what Git has in its configuration for it.
//!
//! Git itself does the signing: `commit_create` runs `git commit` without `--no-gpg-sign`,
//! so `commit.gpgSign` works as in the terminal (OpenPGP, SSH or X.509). The app's own
//! backup commits are never signed.

use crate::app::Core;
use crate::error::{CoreError, CoreResult};
use crate::git::GitCmd;
use crate::model::{RepoChange, SigningFormat, SigningStatus};

/// Git invocation for the configuration: in the repository (effective values) or global only.
fn config_cmd(core: &Core, repo_id: Option<&str>) -> CoreResult<GitCmd> {
    Ok(match repo_id {
        Some(id) => core.git_for(id)?.arg("config"),
        None => core.git_at(core.data_dir()).args(["config", "--global"]),
    })
}

async fn get(core: &Core, repo_id: Option<&str>, key: &str, kind: Option<&str>) -> CoreResult<Option<String>> {
    let mut cmd = config_cmd(core, repo_id)?.read_only().no_log();
    if let Some(kind) = kind {
        cmd = cmd.arg(format!("--type={kind}"));
    }
    let out = cmd.args(["--get", key]).run_raw().await?;
    Ok(out.success().then(|| out.stdout_text()).filter(|value| !value.trim().is_empty()))
}

fn parse_format(text: &str) -> Option<SigningFormat> {
    match text.trim().to_ascii_lowercase().as_str() {
        "openpgp" => Some(SigningFormat::Openpgp),
        "ssh" => Some(SigningFormat::Ssh),
        "x509" => Some(SigningFormat::X509),
        _ => None,
    }
}

fn format_name(format: SigningFormat) -> &'static str {
    match format {
        SigningFormat::Openpgp => "openpgp",
        SigningFormat::Ssh => "ssh",
        SigningFormat::X509 => "x509",
    }
}

async fn status(core: &Core, repo_id: Option<&str>) -> CoreResult<SigningStatus> {
    let enabled = get(core, repo_id, "commit.gpgsign", Some("bool")).await?.is_some_and(|value| value.trim() == "true");
    let format = get(core, repo_id, "gpg.format", None).await?.as_deref().and_then(parse_format);
    let key = get(core, repo_id, "user.signingkey", None).await?;
    // The program depends on the format; `gpg.program` applies to OpenPGP (also when no format is set).
    let mut program = get(core, repo_id, program_key(format), None).await?;
    if program.is_none() && format == Some(SigningFormat::Openpgp) {
        program = get(core, repo_id, "gpg.openpgp.program", None).await?;
    }
    let allowed_signers_file = get(core, repo_id, "gpg.ssh.allowedsignersfile", None).await?;
    Ok(SigningStatus { enabled, format, key, program, allowed_signers_file })
}

/// Git key of the signing program for the format (`gpg.program` applies to OpenPGP).
fn program_key(format: Option<SigningFormat>) -> &'static str {
    match format {
        Some(SigningFormat::Ssh) => "gpg.ssh.program",
        Some(SigningFormat::X509) => "gpg.x509.program",
        Some(SigningFormat::Openpgp) | None => "gpg.program",
    }
}

fn clean_value(value: Option<String>, what: &str) -> CoreResult<Option<String>> {
    let value = value.map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
    if value.as_deref().is_some_and(|v| v.contains(['\n', '\r', '\0'])) {
        return Err(CoreError::not_allowed(format!("{what} must not contain a line break.")));
    }
    Ok(value)
}

/// What Git has configured for signing: with `repo_id` the values effective in the repository
/// (local before global), without it those of the global configuration.
/// `format: None` means: not set (Git then uses OpenPGP).
pub async fn signing_status(core: &Core, repo_id: Option<String>) -> CoreResult<SigningStatus> {
    if let Some(id) = &repo_id {
        core.repo_path(id)?;
    }
    status(core, repo_id.as_deref()).await
}

/// Writes `commit.gpgSign`, `gpg.format` and `user.signingKey` – with `repo_id` into the
/// repository's configuration, without it into the global one. `enabled`/`format`/`key` `None` removes
/// the entry at that place (in the repository the global value then applies again).
/// `key`: for OpenPGP the key ID, for SSH the path of the public key or
/// `key::ssh-ed25519 …`, for X.509 the certificate ID.
///
/// `program` and `allowed_signers_file` are three-valued: `None` = leave untouched,
/// `Some(None)` = remove the entry, `Some(Some(..))` = set. The program is stored under the
/// key for this call's format (`gpg.program`, `gpg.ssh.program`, `gpg.x509.program`);
/// `allowed_signers_file` is `gpg.ssh.allowedSignersFile` (for verifying SSH signatures).
pub async fn signing_set(
    core: &Core,
    repo_id: Option<String>,
    enabled: Option<bool>,
    format: Option<SigningFormat>,
    key: Option<String>,
    program: Option<Option<String>>,
    allowed_signers_file: Option<Option<String>>,
) -> CoreResult<SigningStatus> {
    let key = clean_value(key, "The key")?;
    let program = match program {
        Some(value) => Some(clean_value(value, "The program path")?),
        None => None,
    };
    let allowed_signers_file = match allowed_signers_file {
        Some(value) => Some(clean_value(value, "The file path")?),
        None => None,
    };
    let repo = repo_id.as_deref();
    if let Some(id) = repo {
        core.repo_path(id)?;
    }
    let write = async {
        let scope: &[&str] = if repo.is_some() { &["--local"] } else { &[] };
        let mut entries: Vec<(&str, Option<String>)> = vec![
            ("commit.gpgsign", enabled.map(|on| if on { "true" } else { "false" }.to_string())),
            ("gpg.format", format.map(|f| format_name(f).to_string())),
            ("user.signingkey", key.clone()),
        ];
        if let Some(program) = program.clone() {
            entries.push((program_key(format), program));
        }
        if let Some(file) = allowed_signers_file.clone() {
            entries.push(("gpg.ssh.allowedsignersfile", file));
        }
        for (name, value) in entries {
            let cmd = config_cmd(core, repo)?.args(scope);
            match value {
                Some(value) => {
                    cmd.args([name, value.as_str()]).run().await?;
                }
                None => {
                    // Exit 5 = the key was not set; that is fine here.
                    let out = cmd.args(["--unset-all", name]).run_raw().await?;
                    if !out.success() && out.code != Some(5) {
                        return Err(crate::git::errors::classify("config", out.code, &out.stdout, &out.stderr));
                    }
                }
            }
        }
        Ok(())
    };
    match repo {
        Some(id) => core.with_write_lock(id, &[RepoChange::Config], write).await?,
        None => write.await?,
    }
    status(core, repo).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use crate::events::names;
    use crate::testkit::{TestCore, TestRepo};

    #[tokio::test]
    async fn status_reads_local_before_global_and_set_writes_the_right_file() {
        let tc = TestCore::with_global_config("[user]\n\tsigningkey = GLOBAL1234\n[gpg]\n\tprogram = C:/gpg/gpg.exe\n").await;
        let repo = TestRepo::with_commit();
        // TestRepo explicitly turns signing off locally.
        let id = tc.open(&repo).await.repo.id;

        let global = signing_status(&tc, None).await.unwrap();
        assert_eq!(global, SigningStatus { enabled: false, format: None, key: Some("GLOBAL1234".into()), program: Some("C:/gpg/gpg.exe".into()), allowed_signers_file: None });
        let local = signing_status(&tc, Some(id.clone())).await.unwrap();
        assert_eq!(local, global, "the repository uses the global values as long as it has none of its own");

        // Set in the repository: only its configuration changes.
        tc.events.clear();
        let set = signing_set(&tc, Some(id.clone()), Some(true), Some(SigningFormat::Ssh), Some("  ~/.ssh/id_ed25519.pub ".into()), None, None).await.unwrap();
        assert_eq!(set, SigningStatus { enabled: true, format: Some(SigningFormat::Ssh), key: Some("~/.ssh/id_ed25519.pub".into()), program: None, allowed_signers_file: None });
        assert_eq!(repo.git(&["config", "--local", "--get", "commit.gpgsign"]), "true");
        assert_eq!(repo.git(&["config", "--local", "--get", "gpg.format"]), "ssh");
        assert_eq!(tc.events.named(names::REPO_CHANGED)[0]["what"], serde_json::json!(["config"]));
        assert_eq!(signing_status(&tc, None).await.unwrap(), global);
        repo.git(&["config", "gpg.ssh.program", "C:/ssh/ssh-keygen.exe"]);
        assert_eq!(signing_status(&tc, Some(id.clone())).await.unwrap().program.as_deref(), Some("C:/ssh/ssh-keygen.exe"));

        // Remove format and key in the repository: the global ones apply again.
        let cleared = signing_set(&tc, Some(id.clone()), Some(false), None, None, None, None).await.unwrap();
        assert_eq!(cleared, SigningStatus { enabled: false, format: None, key: Some("GLOBAL1234".into()), program: Some("C:/gpg/gpg.exe".into()), allowed_signers_file: None });
        assert!(!repo.git_output(&["config", "--local", "--get", "gpg.format"]).status.success());
        // Nothing set, remove again: no error.
        signing_set(&tc, Some(id.clone()), Some(false), None, None, None, None).await.unwrap();

        // Set globally: no event for the repository, in the global file.
        tc.events.clear();
        let set = signing_set(&tc, None, Some(true), Some(SigningFormat::X509), Some("ZERT-1".into()), None, None).await.unwrap();
        assert_eq!((set.enabled, set.format, set.key.as_deref()), (true, Some(SigningFormat::X509), Some("ZERT-1")));
        assert_eq!(tc.events.count(names::REPO_CHANGED), 0);
        let text = std::fs::read_to_string(tc.global_config_path()).unwrap();
        assert!(text.contains("x509") && text.contains("ZERT-1"), "{text}");
        // The repository has `commit.gpgsign=false` locally – that takes precedence.
        let effective = signing_status(&tc, Some(id.clone())).await.unwrap();
        assert_eq!((effective.enabled, effective.format, effective.key.as_deref()), (false, Some(SigningFormat::X509), Some("ZERT-1")));

        assert_eq!(signing_set(&tc, Some(id.clone()), Some(true), None, Some("a\nb".into()), None, None).await.unwrap_err().code, ErrorCode::NotAllowed);
        assert_eq!(signing_status(&tc, Some("unbekannt".into())).await.unwrap_err().code, ErrorCode::NotFound);
        assert_eq!(signing_set(&tc, Some("unbekannt".into()), Some(true), None, None, None, None).await.unwrap_err().code, ErrorCode::NotFound);
    }

    /// A signing key that is gone is a signing problem, not "changed outside the app".
    #[tokio::test]
    async fn commit_with_a_missing_signing_key_reports_a_signing_error() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let id = tc.open(&repo).await.repo.id;
        let missing = repo.temp_dir().join("fehlt").join("id_weg.pub").to_string_lossy().replace('\\', "/");
        signing_set(&tc, Some(id.clone()), Some(true), Some(SigningFormat::Ssh), Some(missing.clone()), None, None).await.unwrap();
        let before = repo.head();
        repo.write_file("a.txt", "kann nicht signiert werden\n");
        let error = crate::commands::commit::commit_create(&tc, id.clone(), "op-ohne-schluessel".into(), "Ohne Schlüssel".into(), String::new(), false, false, false, true, None)
            .await
            .unwrap_err();
        assert_eq!(error.code, ErrorCode::SigningFailed, "{error:?}");
        assert!(error.message.contains("sign") && error.message.contains("id_weg.pub"), "{}", error.message);
        assert_eq!(repo.head(), before, "no commit was created");
    }

    /// `commit_create` signs when `commit.gpgSign` is on – here with an SSH key.
    #[tokio::test]
    async fn commits_are_signed_when_signing_is_enabled() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let id = tc.open(&repo).await.repo.id;
        let config = crate::commands::auth::broker::AuthConfig::default();
        let Ok(keygen) = crate::commands::auth::ssh::find_ssh_keygen(&config, tc.git_found().as_ref()) else {
            eprintln!("ssh-keygen not found – test skipped.");
            return;
        };
        let keys = tempfile::tempdir().unwrap();
        let key = keys.path().join("signier-schlüssel");
        let made = std::process::Command::new(&keygen).args(["-q", "-t", "ed25519", "-N", "", "-C", "test", "-f"]).arg(&key).output().unwrap();
        assert!(made.status.success(), "{}", String::from_utf8_lossy(&made.stderr));
        let public = format!("{}.pub", key.to_string_lossy().replace('\\', "/"));
        repo.git(&["config", "gpg.ssh.program", &keygen.to_string_lossy().replace('\\', "/")]);

        signing_set(&tc, Some(id.clone()), Some(true), Some(SigningFormat::Ssh), Some(public), None, None).await.unwrap();
        repo.write_file("a.txt", "signiert\n");
        let result = crate::commands::commit::commit_create(&tc, id.clone(), "op-signiert".into(), "Signierter Commit".into(), String::new(), false, false, false, true, None)
            .await
            .unwrap();
        let raw = repo.git(&["cat-file", "commit", &result.sha]);
        assert!(raw.contains("gpgsig -----BEGIN SSH SIGNATURE-----"), "{raw}");

        // Turned off: the next commit has no signature. The app's backup commits never do.
        signing_set(&tc, Some(id.clone()), Some(false), Some(SigningFormat::Ssh), None, None, None).await.unwrap();
        repo.write_file("a.txt", "unsigniert\n");
        let result = crate::commands::commit::commit_create(&tc, id.clone(), "op-unsigniert".into(), "Ohne Signatur".into(), String::new(), false, false, false, true, None)
            .await
            .unwrap();
        assert!(!repo.git(&["cat-file", "commit", &result.sha]).contains("gpgsig"));
    }
}
