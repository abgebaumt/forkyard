//! Trust per repository.
//!
//! Git runs whatever a repository's configuration says: `core.fsmonitor` runs on every
//! `git status`, hooks on commit, checkout and push, filters when reading files, and a configured
//! proxy sees the user's credentials. If the `.git` directory comes from someone else (extracted
//! archive, copied folder, USB stick), merely opening it is enough.
//!
//! That is why the core checks every repository that newly enters the list **before** it calls
//! anything else in it:
//!
//! - The check only reads (`git config --list`, the hooks folder) and runs guarded
//!   (`GitCmd::guarded`).
//! - If it finds nothing, the repository counts as trusted – as does one the app cloned or
//!   created itself, and a worktree of a trusted repository.
//! - If it finds something, the repository stays locked: `Core::repo_path` (and with it every
//!   command, file watching, auto-fetch, terminal) answers with `repo_untrusted` until the
//!   user agrees via `repo_trust_set`. `repo_trust_get` lists the findings.
//!
//! The list of keys is a block list: it names what Git, according to its documentation, starts
//! as a program or uses to redirect connections and certificate checks. A key that a future
//! Git version introduces only appears there once it has been added.

use std::path::{Path, PathBuf};

use crate::app::Core;
use crate::db;
use crate::error::CoreResult;
use crate::git::redact;
use crate::model::{AppChange, RepoTrust, TrustFinding, TrustFindingKind};
use crate::util;

/// At most this many characters of a value go to the UI.
const MAX_VALUE_CHARS: usize = 200;
/// Findings beyond this many are not listed individually.
const MAX_FINDINGS: usize = 60;

/// Commands that `git lfs install --local` configures: they only call `git-lfs` from the search path.
const LFS_FILTER_VALUES: [&str; 5] =
    ["git-lfs clean -- %f", "git-lfs smudge -- %f", "git-lfs smudge --skip -- %f", "git-lfs filter-process", "git-lfs filter-process --skip"];

fn is_false(value: &str) -> bool {
    matches!(value.trim().to_ascii_lowercase().as_str(), "false" | "no" | "off" | "0")
}

fn is_bool(value: &str) -> bool {
    matches!(value.trim().to_ascii_lowercase().as_str(), "" | "true" | "yes" | "on" | "1") || is_false(value)
}

/// Why a configuration entry stands out; `None` = harmless. `key` is lowercase except for the
/// middle part (`remote.<name>.url`), which Git leaves unchanged.
fn config_reason(key: &str, value: &str, git_is_directory: bool) -> Option<&'static str> {
    let lower = key.to_ascii_lowercase();
    let (section, name) = match (lower.find('.'), lower.rfind('.')) {
        (Some(first), Some(last)) => (&lower[..first], &lower[last + 1..]),
        _ => return None,
    };
    let has_middle = lower.matches('.').count() >= 2;
    match (section, name) {
        ("core", "fsmonitor") if !is_bool(value) => Some("Git runs this program every time it checks the status."),
        ("core", "sshcommand") => Some("Git runs this program for every SSH connection."),
        ("core", "gitproxy") => Some("Git runs this program for connections over the git protocol."),
        ("core", "hookspath") => Some("Hooks from this folder run on commit, checkout, merge and push."),
        ("core", "askpass") => Some("Git runs this program when it needs credentials."),
        ("core", "alternaterefscommand") => Some("Git runs this program on fetch and push."),
        ("core", "virtualfilesystem") => Some("Git runs this program when reading the index."),
        ("core", "worktree") if git_is_directory => Some("The working directory is in a different location – actions would affect files outside this folder."),
        ("credential", "helper") if !value.trim().is_empty() => Some("This program receives the credentials for the remotes."),
        ("remote", "uploadpack") | ("remote", "receivepack") => Some("Git runs this program on fetch or push."),
        ("remote", "vcs") => Some("Git runs a helper program of this name for the remote."),
        ("remote", "proxy") | ("http", "proxy") => Some("Connections go through this proxy; it sees what is transferred."),
        ("http", "sslverify") if is_false(value) => Some("Certificate verification is turned off – anyone who redirects the connection gets the credentials."),
        ("http", "sslcainfo" | "sslcapath" | "sslcert" | "sslkey" | "proxysslcainfo" | "proxysslcert" | "proxysslkey") => {
            Some("Changes which certificates Git trusts for HTTPS.")
        }
        ("http", "cookiefile" | "curloptresolve") => Some("Redirects HTTPS connections or sends stored cookies."),
        ("protocol", "allow") if value.trim().eq_ignore_ascii_case("always") && (!has_middle || lower.starts_with("protocol.ext.")) => {
            Some("Allows transports that can run arbitrary programs.")
        }
        ("protocol", "allow") if lower.starts_with("protocol.ext.") && !value.trim().eq_ignore_ascii_case("never") => {
            Some("Allows transports that can run arbitrary programs.")
        }
        ("filter", "clean" | "smudge" | "process") if !LFS_FILTER_VALUES.contains(&value.trim()) => {
            Some("Git runs this program when reading and writing files – even for the status.")
        }
        ("diff", "textconv" | "command") if has_middle => Some("Git runs this program to convert files for a diff."),
        ("diff", "external") => Some("Git runs this program for every diff."),
        ("merge", "driver") if has_middle => Some("Git runs this program when merging files."),
        ("mergetool" | "difftool", "cmd" | "path") => Some("This program runs when Git's diff or merge tool is opened."),
        ("gpg", "program" | "defaultkeycommand") => Some("Git runs this program to sign and verify commits."),
        ("include" | "includeif", "path") => Some("Includes another configuration file; its content can change with every pull."),
        ("submodule", "update") if value.trim_start().starts_with('!') => Some("Git runs this program when updating the submodule."),
        ("trailer", "command" | "cmd") => Some("Git runs this program when committing."),
        ("interactive", "difffilter") => Some("Git runs this program for partial staging."),
        ("lfs", "path" | "args") if lower.starts_with("lfs.customtransfer.") => Some("Git LFS runs this program for transfers."),
        ("lfs", "clean" | "smudge") if lower.starts_with("lfs.extension.") => Some("Git LFS runs this program for every LFS file."),
        _ => None,
    }
}

fn shorten(value: &str) -> String {
    let clean: String = redact::redact(value).chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let mut short: String = clean.chars().take(MAX_VALUE_CHARS).collect();
    if clean.chars().count() > MAX_VALUE_CHARS {
        short.push('…');
    }
    short
}

/// Parses the output of `git config --list --show-scope -z` and returns the entries from the
/// repository's configuration (`local`, `worktree`) – not those of the user or the system.
fn local_entries(output: &[u8]) -> Vec<(String, String)> {
    let tokens: Vec<&[u8]> = output.split(|b| *b == 0).collect();
    let mut entries = Vec::new();
    for pair in tokens.chunks(2) {
        let [scope, entry] = pair else { continue };
        if !matches!(*scope, b"local" | b"worktree") {
            continue;
        }
        let text = util::decode_lossy(entry);
        // A key without a value (`[core] bare`) appears without a line break.
        let (key, value) = text.split_once('\n').unwrap_or((text.as_str(), ""));
        entries.push((key.to_string(), value.to_string()));
    }
    entries
}

fn config_findings(entries: &[(String, String)], git_is_directory: bool) -> Vec<TrustFinding> {
    entries
        .iter()
        .filter_map(|(key, value)| {
            config_reason(key, value, git_is_directory).map(|reason| TrustFinding {
                kind: TrustFindingKind::Config,
                name: key.clone(),
                value: Some(shorten(value)),
                reason: reason.to_string(),
            })
        })
        .collect()
}

/// The common Git directory (for worktrees the one of the main repository), as a full path.
async fn common_dir(core: &Core, root: &Path) -> Option<PathBuf> {
    let out = core.git.cmd(root).args(["rev-parse", "--git-common-dir"]).read_only().no_log().guarded().run_raw().await.ok()?;
    if !out.success() {
        return None;
    }
    let raw = out.stdout.strip_suffix(b"\n").unwrap_or(&out.stdout);
    let raw = raw.strip_suffix(b"\r").unwrap_or(raw);
    if raw.is_empty() {
        return None;
    }
    let listed = util::native_path(&util::bytes_to_path(raw));
    Some(if listed.is_absolute() { listed } else { root.join(listed) })
}

/// What in this folder would run or redirect connections without the user doing anything.
/// Runs none of it itself.
pub(crate) async fn scan(core: &Core, root: &Path) -> Vec<TrustFinding> {
    let mut findings = Vec::new();
    let listed = core.git.cmd(root).args(["config", "--list", "--show-scope", "--includes", "-z"]).read_only().no_log().guarded().run_raw().await;
    match listed {
        Ok(out) if out.success() => {
            let git_is_directory = root.join(".git").is_dir();
            findings.extend(config_findings(&local_entries(&out.stdout), git_is_directory));
        }
        Ok(out) => {
            let first_line = out.stderr_text().lines().next().unwrap_or("").to_string();
            findings.push(TrustFinding {
                kind: TrustFindingKind::Unreadable,
                name: ".git/config".to_string(),
                value: Some(shorten(&first_line)),
                reason: "The repository's configuration could not be read – its contents are unchecked.".to_string(),
            });
        }
        Err(e) => findings.push(TrustFinding {
            kind: TrustFindingKind::Unreadable,
            name: ".git/config".to_string(),
            value: Some(shorten(&e.message)),
            reason: "The repository's configuration could not be read – its contents are unchecked.".to_string(),
        }),
    }
    if let Some(common) = common_dir(core, root).await {
        for hook in crate::commands::commit::hook_files(&common.join("hooks")) {
            findings.push(TrustFinding {
                kind: TrustFindingKind::Hook,
                name: hook,
                value: None,
                reason: "This script from the repository runs on the Git action of the same name.".to_string(),
            });
        }
    }
    findings.truncate(MAX_FINDINGS);
    findings
}

/// Whether `root` is a worktree of a repository that is already trusted: both share
/// configuration and hooks, so the consent already applies.
async fn shares_a_trusted_repository(core: &Core, root: &Path) -> bool {
    let Some(common) = common_dir(core, root).await else { return false };
    if !common.file_name().is_some_and(|name| name == ".git") {
        return false;
    }
    let Some(main) = common.parent() else { return false };
    if util::path_key(main) == util::path_key(root) {
        return false;
    }
    core.db.with(|c| db::repos::find_by_path(c, main)).ok().flatten().is_some_and(|row| row.trusted)
}

/// On open: checks a repository that is not trusted yet and records the trust if nothing
/// speaks against it. Returns whether it counts as trusted afterwards.
pub(crate) async fn settle_on_open(core: &Core, repo_id: &str, root: &Path) -> CoreResult<bool> {
    if core.repo_row(repo_id)?.trusted {
        return Ok(true);
    }
    let trusted = shares_a_trusted_repository(core, root).await || scan(core, root).await.is_empty();
    if trusted {
        core.db.with(|c| db::repos::set_trusted(c, repo_id, true))?;
    }
    Ok(trusted)
}

/// Opens a repository the app has just created or cloned itself. Its configuration was made on
/// this machine; if the check still finds something (hooks from the user's own template, Git
/// LFS hooks after cloning), it counts as trusted without a prompt. It always goes into the
/// active profile's list, even if another profile already knows the folder.
pub(crate) async fn open_created(core: &Core, root: &Path) -> CoreResult<crate::model::OpenedRepo> {
    let mut opened = crate::commands::repos::repo_open_with(core, root.to_string_lossy().into_owned(), true).await?;
    if !opened.repo.trusted {
        core.db.with(|c| db::repos::set_trusted(c, &opened.repo.id, true))?;
        opened.repo.trusted = true;
        crate::commands::repos::start_background(core, &opened.repo.id);
        core.emit_app_changed(&[AppChange::Repos, AppChange::Tabs]);
    }
    Ok(opened)
}

/// Trust state and what the check currently finds.
pub async fn repo_trust_get(core: &Core, repo_id: String) -> CoreResult<RepoTrust> {
    let row = core.repo_row(&repo_id)?;
    let root = PathBuf::from(&row.path);
    let findings = if root.is_dir() { scan(core, &root).await } else { Vec::new() };
    Ok(RepoTrust { repo_id, trusted: row.trusted, findings })
}

/// The user agrees (`trusted: true`) or withdraws consent. With consent, file watching and
/// auto-fetch start if the repository has a tab.
pub async fn repo_trust_set(core: &Core, repo_id: String, trusted: bool) -> CoreResult<RepoTrust> {
    core.db.tx(|tx| {
        db::repos::require(tx, &repo_id)?;
        db::repos::set_trusted(tx, &repo_id, trusted)
    })?;
    if trusted {
        let has_tab = core
            .db
            .with(|c| {
                let profile_id = db::profiles::active_id(c)?;
                Ok(db::tabs::find_by_repo(c, &profile_id, &repo_id)?.is_some())
            })
            .unwrap_or(false);
        if has_tab {
            crate::commands::repos::start_background(core, &repo_id);
        }
    } else {
        let _ = crate::watcher::stop_watching(core, &repo_id);
        let _ = crate::autofetch::stop(core, &repo_id);
    }
    core.emit_app_changed(&[AppChange::Repos, AppChange::Tabs]);
    repo_trust_get(core, repo_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::repos::repo_open;
    use crate::commands::status::status_get;
    use crate::error::ErrorCode;
    use crate::testkit::{TestCore, TestRepo};

    fn reason(key: &str, value: &str) -> bool {
        config_reason(key, value, true).is_some()
    }

    #[test]
    fn dangerous_keys_are_named_and_ordinary_ones_are_not() {
        for (key, value) in [
            ("core.fsmonitor", "touch x;:"),
            ("core.fsMonitor", ".git/hooks/query-watchman"),
            ("core.sshCommand", "ssh -o ProxyCommand=x"),
            ("core.gitProxy", "proxy-skript"),
            ("core.hooksPath", ".husky"),
            ("core.askPass", "x"),
            ("core.worktree", "C:/Users/anna/Dokumente"),
            ("credential.helper", "!f() { cat > /tmp/x; }; f"),
            ("credential.https://github.com.helper", "store --file=x"),
            ("remote.origin.uploadpack", "sh -c x"),
            ("remote.origin.receivepack", "x"),
            ("remote.origin.proxy", "http://boese.example:8080"),
            ("remote.origin.vcs", "x"),
            ("http.proxy", "http://boese.example:8080"),
            ("http.https://github.com/.proxy", "http://boese.example:8080"),
            ("http.sslVerify", "false"),
            ("http.https://github.com/.sslverify", "0"),
            ("http.sslCAInfo", "ca.pem"),
            ("http.curloptResolve", "github.com:443:1.2.3.4"),
            ("protocol.ext.allow", "always"),
            ("protocol.ext.allow", "user"),
            ("protocol.allow", "always"),
            ("filter.x.clean", "sh evil"),
            ("filter.lfs.smudge", "git-lfs smudge -- %f; evil"),
            ("filter.x.process", "x"),
            ("diff.bild.textconv", "exiftool"),
            ("diff.external", "x"),
            ("merge.eigen.driver", "x %O %A %B"),
            ("mergetool.x.cmd", "x"),
            ("difftool.x.path", "x"),
            ("gpg.program", "x"),
            ("gpg.ssh.program", "x"),
            ("gpg.ssh.defaultKeyCommand", "x"),
            ("include.path", "../.gitconfig"),
            ("includeIf.gitdir:/x/.path", "y"),
            ("submodule.lib.update", "!sh evil"),
            ("trailer.sign.command", "x"),
            ("interactive.diffFilter", "x"),
            ("lfs.customtransfer.x.path", "x"),
            ("lfs.extension.x.smudge", "x"),
        ] {
            assert!(reason(key, value), "{key}={value}");
        }
        for (key, value) in [
            ("core.repositoryformatversion", "0"),
            ("core.fsmonitor", "true"),
            ("core.fsmonitor", "false"),
            ("core.autocrlf", "false"),
            ("core.editor", "vim"),
            ("user.name", "Anna"),
            ("user.email", "anna@example.com"),
            ("remote.origin.url", "https://github.com/a/b.git"),
            ("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"),
            ("branch.main.remote", "origin"),
            ("branch.main.merge", "refs/heads/main"),
            ("http.sslVerify", "true"),
            ("http.https://git.example.com/.extraheader", "AUTHORIZATION: basic x"),
            ("http.postBuffer", "524288000"),
            ("protocol.file.allow", "always"),
            ("protocol.ext.allow", "never"),
            ("filter.lfs.clean", "git-lfs clean -- %f"),
            ("filter.lfs.smudge", "git-lfs smudge -- %f"),
            ("filter.lfs.process", "git-lfs filter-process"),
            ("filter.lfs.required", "true"),
            ("lfs.repositoryformatversion", "0"),
            ("lfs.https://github.com/a/b.git/info/lfs.access", "basic"),
            ("diff.algorithm", "histogram"),
            ("merge.ff", "false"),
            ("merge.conflictstyle", "zdiff3"),
            ("credential.helper", ""),
            ("credential.username", "anna"),
            ("submodule.lib.url", "https://github.com/a/lib.git"),
            ("submodule.lib.update", "rebase"),
            ("commit.gpgsign", "true"),
            ("gpg.format", "ssh"),
            ("user.signingkey", "~/.ssh/id_ed25519.pub"),
            ("gitflow.branch.master", "main"),
            ("pull.rebase", "true"),
        ] {
            assert!(!reason(key, value), "{key}={value}");
        }
        // core.worktree is normal for submodules and worktrees (there .git is a file).
        assert!(config_reason("core.worktree", "../../../lib", false).is_none());
    }

    #[test]
    fn only_entries_of_the_repository_are_read() {
        let output = b"system\0core.fsmonitor\nevil-system\0global\0credential.helper\nmanager\0local\0core.fsmonitor\nevil\0local\0core.bare\0worktree\0core.sshcommand\nx\0command\0core.hookspath\ny\0";
        let entries = local_entries(output);
        assert_eq!(
            entries,
            vec![("core.fsmonitor".to_string(), "evil".to_string()), ("core.bare".to_string(), String::new()), ("core.sshcommand".to_string(), "x".to_string())]
        );
        let findings = config_findings(&entries, true);
        assert_eq!(findings.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["core.fsmonitor", "core.sshcommand"]);
        assert!(local_entries(b"").is_empty());
    }

    #[test]
    fn values_are_shortened_and_never_show_credentials() {
        let shown = shorten("http://anna:geheimes-passwort@proxy.example:8080");
        assert!(!shown.contains("geheimes-passwort"), "{shown}");
        assert_eq!(shorten(&"x".repeat(500)).chars().count(), MAX_VALUE_CHARS + 1);
        assert_eq!(shorten("a\nb\tc"), "a b c");
    }

    fn path_text(repo: &TestRepo) -> String {
        repo.path().to_string_lossy().into_owned()
    }

    /// SEC-01, the whole way: open → locked, nothing runs → read findings → agree → it runs.
    #[tokio::test]
    async fn a_foreign_repository_stays_locked_until_the_user_agrees() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        repo.git(&["config", "core.fsmonitor", "touch FSMONITOR-LIEF;:"]);
        repo.git(&["config", "http.proxy", "http://anna:proxy-geheim-1@boese.example:8080"]);
        repo.git(&["config", "http.sslVerify", "false"]);
        std::fs::create_dir_all(repo.path().join(".git/hooks")).unwrap();
        let hook = repo.path().join(".git/hooks/post-checkout");
        std::fs::write(&hook, "#!/bin/sh\ntouch HOOK-LIEF\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let marker = repo.path().join("FSMONITOR-LIEF");

        let opened = repo_open(&tc, path_text(&repo)).await.unwrap();
        let id = opened.repo.id.clone();
        assert!(!opened.repo.trusted);
        assert!(!marker.exists(), "nothing runs on open and check");
        // Every command is rejected, even read-only ones – and no background task runs.
        assert_eq!(status_get(&tc, id.clone()).await.unwrap_err().code, ErrorCode::RepoUntrusted);
        assert_eq!(crate::commands::graph::graph_page(&tc, id.clone(), None, 10).await.unwrap_err().code, ErrorCode::RepoUntrusted);
        assert_eq!(crate::commands::terminal::terminal_open(&tc, id.clone(), 80, 24).await.unwrap_err().code, ErrorCode::RepoUntrusted);
        assert!(!crate::watcher::is_watching(&tc, &id));
        assert!(!marker.exists());

        let trust = repo_trust_get(&tc, id.clone()).await.unwrap();
        assert!(!trust.trusted);
        let names: Vec<&str> = trust.findings.iter().map(|f| f.name.as_str()).collect();
        assert!(names.contains(&"core.fsmonitor") && names.contains(&"http.proxy") && names.contains(&"http.sslverify"), "{names:?}");
        assert!(trust.findings.iter().any(|f| f.kind == TrustFindingKind::Hook && f.name == "post-checkout"), "{:?}", trust.findings);
        let shown = serde_json::to_string(&trust).unwrap();
        assert!(!shown.contains("proxy-geheim-1"), "a password in the configuration is not shown: {shown}");
        assert!(!marker.exists(), "the check itself runs nothing either");

        // A restart changes nothing about that.
        let tc = tc.restart().await;
        assert_eq!(status_get(&tc, id.clone()).await.unwrap_err().code, ErrorCode::RepoUntrusted);
        assert!(!marker.exists());

        // Only the user's consent unlocks the repository – then Git's normal behaviour applies.
        let trust = repo_trust_set(&tc, id.clone(), true).await.unwrap();
        assert!(trust.trusted);
        status_get(&tc, id.clone()).await.unwrap();
        assert!(marker.exists(), "after consent the configured command runs (proof that the lock held it back)");
        // And consent can be withdrawn.
        let trust = repo_trust_set(&tc, id.clone(), false).await.unwrap();
        assert!(!trust.trusted);
        assert_eq!(status_get(&tc, id).await.unwrap_err().code, ErrorCode::RepoUntrusted);
    }

    /// What the app clones itself counts as trusted – even if the user's template
    /// (`init.templateDir`) puts hooks into it that would stand out in a foreign folder.
    #[tokio::test]
    async fn repositories_cloned_by_the_app_are_trusted_even_with_hooks_from_the_users_template() {
        let template = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(template.path().join("hooks")).unwrap();
        let hook = template.path().join("hooks").join("post-checkout");
        std::fs::write(&hook, "#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let tc = TestCore::with_global_config(&format!("[init]\n\ttemplateDir = {}\n", template.path().to_string_lossy().replace('\\', "/"))).await;
        let source = TestRepo::with_commit();
        let remote = source.add_remote();
        source.git(&["push", "-q", "origin", "main"]);
        let parent = tempfile::tempdir().unwrap();
        let opened = crate::commands::clone_init::repo_clone(
            &tc,
            "job-klon".into(),
            remote.url(),
            parent.path().to_string_lossy().into_owned(),
            "kopie".into(),
            crate::model::CloneOptions::default(),
        )
        .await
        .unwrap();
        assert!(opened.repo.trusted, "a clone made by the app is usable right away");
        assert!(parent.path().join("kopie/.git/hooks/post-checkout").is_file(), "the template put its hook in");
        status_get(&tc, opened.repo.id.clone()).await.unwrap();
        assert_eq!(crate::commands::repos::repo_list(&tc).await.unwrap().len(), 1, "exactly one entry in the list");
        // The same folder, only opened (not cloned) by another core, stands out.
        let other = TestCore::new().await;
        let reopened = repo_open(&other, parent.path().join("kopie").to_string_lossy().into_owned()).await.unwrap();
        assert!(!reopened.repo.trusted);
    }

    #[tokio::test]
    async fn ordinary_repositories_and_worktrees_of_trusted_ones_open_without_a_question() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let opened = repo_open(&tc, path_text(&repo)).await.unwrap();
        assert!(opened.repo.trusted, "nothing suspicious: usable right away");
        status_get(&tc, opened.repo.id.clone()).await.unwrap();

        // The user later sets up a hook themselves: the trust stays.
        repo.git(&["config", "core.hooksPath", ".husky"]);
        let again = repo_open(&tc, path_text(&repo)).await.unwrap();
        assert!(again.repo.trusted);
        // A worktree of this repository shares configuration and hooks – no new prompt.
        let linked = repo.temp_dir().join("zweiter");
        repo.git(&["worktree", "add", "-q", &linked.to_string_lossy(), "-b", "nebenher"]);
        let worktree = repo_open(&tc, linked.to_string_lossy().into_owned()).await.unwrap();
        assert!(worktree.repo.trusted);

        // The same repository, freshly opened in another core, stands out because of the entry.
        let other = TestCore::new().await;
        let opened = repo_open(&other, path_text(&repo)).await.unwrap();
        assert!(!opened.repo.trusted);
        let trust = repo_trust_get(&other, opened.repo.id).await.unwrap();
        assert_eq!(trust.findings.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(), ["core.hookspath"]);
    }

    #[tokio::test]
    async fn a_created_repo_joins_the_active_profile_even_if_another_profile_knows_the_folder() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        tc.open(&repo).await;
        let list = crate::commands::settings::profile_save(&tc, None, "Arbeit".into(), "".into(), "".into(), false, None).await.unwrap();
        let work = list.iter().find(|p| p.name == "Arbeit").unwrap().id.clone();
        crate::commands::settings::profile_activate(&tc, work).await.unwrap();

        let opened = open_created(&tc, repo.path()).await.unwrap();
        assert!(opened.repo.trusted);
        assert_eq!(crate::commands::repos::repo_list(&tc).await.unwrap().len(), 1);
    }
}
