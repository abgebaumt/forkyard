//! Managing remotes: list, add, edit, remove.
//!
//! Everything is read from the Git configuration (`remote.<name>.url` / `.pushurl`), never from
//! the human-readable output of `git remote -v`. Credentials in URLs only reach the UI masked
//! (`display_url`); the write commands recognize a masked URL that was sent back unchanged and
//! then keep the real value.

use serde_json::json;

use crate::app::Core;
use crate::error::{CoreError, CoreResult};
use crate::model::{Head, Remote, RemoteHost, RepoChange};
use crate::undo::{self, UndoAction, UndoRecord};
use crate::util;

/// Placeholder for masked credentials in a displayed URL.
pub const MASK: &str = "***";

/// Protocols accepted as a remote URL. FTP and FTPS are not among them: Git only lists this
/// transport as deprecated, and writing over it does not work at all.
const SCHEMES: [&str; 7] = ["http", "https", "ssh", "git", "file", "git+ssh", "ssh+git"];

/// A remote as it is in the Git configuration (URLs unmasked).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawRemote {
    pub name: String,
    /// First `remote.<name>.url`; empty if none is set.
    pub fetch_url: String,
    /// First `remote.<name>.pushurl`, if set.
    pub push_url: Option<String>,
}

impl RawRemote {
    /// For the UI: credentials masked, `push_url` only if it differs.
    pub fn to_model(&self) -> Remote {
        let push_url = self.push_url.as_ref().filter(|p| **p != self.fetch_url).map(|p| display_url(p));
        Remote { name: self.name.clone(), fetch_url: display_url(&self.fetch_url), push_url, host: detect_host(&self.fetch_url) }
    }
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/// Splits `scheme://[userinfo@]rest` into (scheme with `://`, userinfo, rest).
fn split_userinfo(url: &str) -> Option<(&str, &str, &str)> {
    let scheme_end = url.find("://")? + 3;
    let after = &url[scheme_end..];
    let authority_end = after.find('/').unwrap_or(after.len());
    let at = after[..authority_end].rfind('@')?;
    Some((&url[..scheme_end], &after[..at], &after[at + 1..]))
}

fn is_http(scheme: &str) -> bool {
    let s = scheme.trim_end_matches("://").to_ascii_lowercase();
    s == "http" || s == "https"
}

/// URL for display: passwords and tokens are replaced by `***`.
/// For HTTP(S) the whole part before the `@` counts as secret (tokens are often given as the
/// user name); for other protocols the user name (`git@…`) stays.
pub fn display_url(url: &str) -> String {
    match split_userinfo(url) {
        Some((scheme, info, rest)) if is_http(scheme) && !info.is_empty() => format!("{scheme}{MASK}@{rest}"),
        Some((scheme, info, rest)) => match info.split_once(':') {
            Some((user, _)) => format!("{scheme}{user}:{MASK}@{rest}"),
            None => url.to_string(),
        },
        None => url.to_string(),
    }
}

/// URL without secrets but still usable (for the undo entry): for HTTP(S) without the user
/// part, otherwise without the password.
pub fn strip_credentials(url: &str) -> String {
    match split_userinfo(url) {
        Some((scheme, info, rest)) if is_http(scheme) && !info.is_empty() => format!("{scheme}{rest}"),
        Some((scheme, info, rest)) => match info.split_once(':') {
            Some((user, _)) => format!("{scheme}{user}@{rest}"),
            None => url.to_string(),
        },
        None => url.to_string(),
    }
}

/// Puts the real credentials back into a URL sent back by the UI if it still carries the
/// masking of the previous URL.
fn unmask_url(submitted: &str, current: Option<&str>) -> CoreResult<String> {
    let submitted = submitted.trim();
    let Some((scheme, info, rest)) = split_userinfo(submitted) else {
        return Ok(submitted.to_string());
    };
    if info != MASK && !info.ends_with(&format!(":{MASK}")) {
        return Ok(submitted.to_string());
    }
    // Only if the masking matches the previous URL (same form, same user).
    if let Some(cur) = current {
        let shown = display_url(cur);
        if let (Some((_, cur_info, _)), Some((_, shown_info, _))) = (split_userinfo(cur), split_userinfo(&shown)) {
            if shown_info == info {
                return Ok(format!("{scheme}{cur_info}@{rest}"));
            }
        }
    }
    Err(CoreError::not_allowed(
        "The URL contains redacted credentials (“***”). Enter the credentials again or remove them from the URL.",
    ))
}

/// Rough check of a remote or clone URL. Allowed are `scheme://…` with a known protocol, the
/// scp-like form `[user@]host:path` and local paths.
pub fn check_url(url: &str) -> CoreResult<()> {
    let u = url.trim();
    if u.is_empty() {
        return Err(CoreError::not_allowed("The URL must not be empty."));
    }
    if u.chars().any(|c| c.is_control()) {
        return Err(CoreError::not_allowed("The URL contains invalid control characters."));
    }
    if u.starts_with('-') {
        return Err(CoreError::not_allowed("The URL must not start with “-”."));
    }
    if let Some((scheme, rest)) = u.split_once("://") {
        let scheme = scheme.to_ascii_lowercase();
        if !SCHEMES.contains(&scheme.as_str()) {
            return Err(CoreError::not_allowed(format!(
                "The protocol “{scheme}” is not supported. Supported are HTTPS, SSH, git and file."
            )));
        }
        if u.chars().any(char::is_whitespace) && scheme != "file" {
            return Err(CoreError::not_allowed("The URL must not contain spaces."));
        }
        if scheme != "file" && url_host(u).is_none() {
            return Err(CoreError::not_allowed("The URL is missing the server name."));
        }
        if rest.is_empty() {
            return Err(CoreError::not_allowed("The URL is incomplete."));
        }
        return Ok(());
    }
    // Transport helpers like "ext::" can start arbitrary programs.
    if let Some((helper, _)) = u.split_once("::") {
        if !helper.is_empty() && helper.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.')) {
            return Err(CoreError::not_allowed(format!("The transport “{helper}::” is not supported.")));
        }
    }
    Ok(())
}

/// Host name of a URL in lower case; `None` for local paths and `file://`.
pub fn url_host(url: &str) -> Option<String> {
    let url = url.trim();
    let authority = if let Some((scheme, rest)) = url.split_once("://") {
        if scheme.eq_ignore_ascii_case("file") {
            return None;
        }
        &rest[..rest.find('/').unwrap_or(rest.len())]
    } else {
        // scp-like: [user@]host:path – no slash before the colon, no drive letter.
        let colon = url.find(':')?;
        let before = &url[..colon];
        if before.contains(['/', '\\']) || before.chars().any(char::is_whitespace) {
            return None;
        }
        if before.len() == 1 && before.chars().all(|c| c.is_ascii_alphabetic()) {
            return None;
        }
        before
    };
    let host = authority.rsplit('@').next().unwrap_or(authority);
    let host = if let Some(v6) = host.strip_prefix('[') {
        v6.split(']').next().unwrap_or(v6)
    } else {
        match host.rsplit_once(':') {
            Some((h, port)) if port.chars().all(|c| c.is_ascii_digit()) => h,
            _ => host,
        }
    };
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    (!host.is_empty()).then_some(host)
}

/// Recognizes the host by the server name (also self-hosted instances like `gitlab.company.com`).
pub fn detect_host(url: &str) -> RemoteHost {
    let Some(host) = url_host(url) else {
        return RemoteHost::Other;
    };
    let has_label = |name: &str| host.split('.').any(|label| label == name);
    if host == "dev.azure.com" || host.ends_with(".dev.azure.com") || host.ends_with(".visualstudio.com") {
        RemoteHost::Azure
    } else if has_label("github") {
        RemoteHost::Github
    } else if has_label("gitlab") {
        RemoteHost::Gitlab
    } else if has_label("bitbucket") {
        RemoteHost::Bitbucket
    } else {
        RemoteHost::Other
    }
}

/// Checks a remote name (`invalid_name` with the reason).
pub fn check_remote_name(name: &str) -> CoreResult<()> {
    util::check_ref_name(name).map_err(|reason| CoreError::invalid_name(format!("Invalid remote name: {reason}")))
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/// Parses the output of `git config -z --get-regexp ^remote\.`: per entry `key\nvalue\0`.
pub fn parse_remote_config(stdout: &[u8]) -> Vec<RawRemote> {
    let mut remotes: Vec<RawRemote> = Vec::new();
    for record in util::split_z(stdout) {
        let text = util::decode_lossy(record);
        let (key, value) = text.split_once('\n').unwrap_or((text.as_str(), ""));
        let Some(rest) = key.strip_prefix("remote.") else { continue };
        // The name may contain dots; the variable is the part after the last dot.
        let Some((name, var)) = rest.rsplit_once('.') else { continue };
        if name.is_empty() {
            continue;
        }
        let index = match remotes.iter().position(|r| r.name == name) {
            Some(i) => i,
            None => {
                remotes.push(RawRemote { name: name.to_string(), fetch_url: String::new(), push_url: None });
                remotes.len() - 1
            }
        };
        let remote = &mut remotes[index];
        match var.to_ascii_lowercase().as_str() {
            "url" if remote.fetch_url.is_empty() => remote.fetch_url = value.to_string(),
            "pushurl" if remote.push_url.is_none() => remote.push_url = Some(value.to_string()),
            _ => {}
        }
    }
    remotes.sort_by(|a, b| a.name.cmp(&b.name));
    remotes
}

/// All remotes from the Git configuration, sorted by name, URLs unmasked.
/// Pure read command; may run inside the write lock.
pub async fn read_remotes(core: &Core, repo_id: &str) -> CoreResult<Vec<RawRemote>> {
    let out = core
        .git_for(repo_id)?
        .args(["config", "-z", "--get-regexp", r"^remote\..*\.(url|pushurl|fetch)$"])
        .read_only()
        .run_raw()
        .await?;
    match out.code {
        Some(0) => Ok(parse_remote_config(&out.stdout)),
        // Exit 1: no entry matches.
        Some(1) => Ok(Vec::new()),
        _ => Err(crate::git::errors::classify("config", out.code, &out.stdout, &out.stderr)),
    }
}

/// Names of all remotes.
pub async fn remote_names(core: &Core, repo_id: &str) -> CoreResult<Vec<String>> {
    Ok(read_remotes(core, repo_id).await?.into_iter().map(|r| r.name).collect())
}

fn missing_remote(name: &str) -> CoreError {
    CoreError::not_found(format!("The remote “{name}” does not exist (anymore)."))
}

fn to_models(remotes: &[RawRemote]) -> Vec<Remote> {
    remotes.iter().map(RawRemote::to_model).collect()
}

/// All remotes with fetch and push URL.
pub async fn remote_list(core: &Core, repo_id: String) -> CoreResult<Vec<Remote>> {
    Ok(to_models(&read_remotes(core, &repo_id).await?))
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/// Push URL that should actually be set: `None` if empty or equal to the fetch URL.
fn wanted_push_url(push_url: Option<String>, fetch_url: &str) -> Option<String> {
    util::non_empty(push_url).map(|p| p.trim().to_string()).filter(|p| p != fetch_url)
}

async fn unset_push_url(core: &Core, repo_id: &str, name: &str) -> CoreResult<()> {
    let key = format!("remote.{name}.pushurl");
    let out = core.git_for(repo_id)?.args(["config", "--unset-all", &key]).run_raw().await?;
    match out.code {
        // Exit 5: the entry was not set.
        Some(0) | Some(5) => Ok(()),
        _ => Err(crate::git::errors::classify("config", out.code, &out.stdout, &out.stderr)),
    }
}

/// Adds a remote.
pub async fn remote_add(core: &Core, repo_id: String, name: String, fetch_url: String, push_url: Option<String>) -> CoreResult<Vec<Remote>> {
    let name = name.trim().to_string();
    check_remote_name(&name)?;
    let fetch_url = unmask_url(&fetch_url, None)?;
    check_url(&fetch_url)?;
    let push_url = match wanted_push_url(push_url, &fetch_url) {
        Some(p) => {
            let p = unmask_url(&p, None)?;
            check_url(&p)?;
            Some(p)
        }
        None => None,
    };
    core.with_write_lock(&repo_id, &[RepoChange::Config], async {
        let existing = read_remotes(core, &repo_id).await?;
        if existing.iter().any(|r| r.name == name) {
            return Err(CoreError::name_exists(format!("A remote named “{name}” already exists.")));
        }
        core.git_for(&repo_id)?.args(["remote", "add", "--", &name, &fetch_url]).run().await?;
        if let Some(push) = &push_url {
            core.git_for(&repo_id)?.args(["remote", "set-url", "--push", "--", &name, push]).run().await?;
        }
        Ok(to_models(&read_remotes(core, &repo_id).await?))
    })
    .await
}

/// Renames a remote and changes its URLs. `push_url: None` (or equal to the fetch URL) removes a
/// separate push URL.
pub async fn remote_edit(core: &Core, repo_id: String, name: String, new_name: String, fetch_url: String, push_url: Option<String>) -> CoreResult<Vec<Remote>> {
    let new_name = new_name.trim().to_string();
    let renamed = new_name != name;
    if renamed {
        check_remote_name(&new_name)?;
    }
    core.with_write_lock(&repo_id, &[RepoChange::Config, RepoChange::Refs], async {
        let existing = read_remotes(core, &repo_id).await?;
        let current = existing.iter().find(|r| r.name == name).ok_or_else(|| missing_remote(&name))?;
        if renamed && existing.iter().any(|r| r.name == new_name) {
            return Err(CoreError::name_exists(format!("A remote named “{new_name}” already exists.")));
        }
        // Check everything before the first thing is changed.
        let fetch = unmask_url(&fetch_url, Some(&current.fetch_url))?;
        if fetch != current.fetch_url {
            check_url(&fetch)?;
        }
        let push = match util::non_empty(push_url) {
            Some(p) => {
                let p = unmask_url(&p, current.push_url.as_deref().or(Some(&current.fetch_url)))?;
                if p == fetch {
                    None
                } else {
                    check_url(&p)?;
                    Some(p)
                }
            }
            None => None,
        };

        if renamed {
            core.git_for(&repo_id)?.args(["remote", "rename", "--", &name, &new_name]).run().await?;
        }
        if fetch != current.fetch_url {
            core.git_for(&repo_id)?.args(["remote", "set-url", "--", &new_name, &fetch]).run().await?;
        }
        match &push {
            Some(p) if current.push_url.as_ref() != Some(p) => {
                core.git_for(&repo_id)?.args(["remote", "set-url", "--push", "--", &new_name, p]).run().await?;
            }
            None if current.push_url.is_some() => unset_push_url(core, &repo_id, &new_name).await?,
            _ => {}
        }
        Ok(to_models(&read_remotes(core, &repo_id).await?))
    })
    .await
}

/// Removes a remote. Creates an undo entry `remove_remote`; the remote branches are kept via
/// backup refs until the entry expires.
pub async fn remote_remove(core: &Core, repo_id: String, name: String) -> CoreResult<Vec<Remote>> {
    core.with_write_lock(&repo_id, &[RepoChange::Config, RepoChange::Refs], async {
        let existing = read_remotes(core, &repo_id).await?;
        let current = existing.iter().find(|r| r.name == name).cloned().ok_or_else(|| missing_remote(&name))?;
        let head = head_marker(&crate::commands::refs::read_head(core, &repo_id).await?);

        // What disappears with the remote: its remote branches and the upstream entries of local branches.
        let prefix = format!("refs/remotes/{name}/");
        let out = core
            .git_for(&repo_id)?
            .args(["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)", &prefix])
            .read_only()
            .run()
            .await?;
        let mut tracking: Vec<(String, String)> = Vec::new();
        for line in out.stdout_lines() {
            let mut parts = line.split(|&b| b == 0);
            let (Some(refname), Some(sha), symref) = (parts.next(), parts.next(), parts.next()) else { continue };
            if symref.is_some_and(|s| !s.is_empty()) {
                continue;
            }
            tracking.push((util::decode_lossy(refname), util::decode_lossy(sha)));
        }
        let upstreams = branch_upstreams(core, &repo_id, &name).await?;

        let id = undo::new_id();
        if !tracking.is_empty() {
            let mut script = String::new();
            for (refname, sha) in &tracking {
                let short = refname.strip_prefix("refs/").unwrap_or(refname);
                script.push_str(&format!("update {} {sha}\n", undo::backup_ref_name(&id, short)));
            }
            core.git_for(&repo_id)?.args(["update-ref", "--stdin"]).stdin(script).run().await?;
        }

        if let Err(e) = core.git_for(&repo_id)?.args(["remote", "remove", "--", &name]).run().await {
            let _ = undo::delete_backup_refs(core, &repo_id, &id).await;
            return Err(e);
        }

        undo::record(
            core,
            UndoRecord {
                id,
                repo_id: repo_id.clone(),
                worktree_path: String::new(),
                action: UndoAction::RemoveRemote,
                label: format!("Undo removing remote ‘{name}’"),
                ref_name: None,
                ref_before: None,
                ref_after: None,
                head_before: head.clone(),
                head_after: Some(head),
                payload: json!({
                    "remote": {
                        "name": current.name,
                        "fetchUrl": strip_credentials(&current.fetch_url),
                        "pushUrl": current.push_url.as_deref().filter(|p| *p != current.fetch_url).map(strip_credentials),
                    },
                    // Addition beyond the convention: so that undo can restore everything without a network.
                    "refs": tracking.iter().map(|(name, sha)| json!({ "name": name, "sha": sha })).collect::<Vec<_>>(),
                    "upstreams": upstreams.iter().map(|(branch, merge)| json!({ "branch": branch, "merge": merge })).collect::<Vec<_>>(),
                }),
            },
        )
        .await?;
        Ok(to_models(&read_remotes(core, &repo_id).await?))
    })
    .await
}

/// HEAD for undo entries: `refs/heads/<branch>` or the SHA.
pub fn head_marker(head: &Head) -> String {
    match head {
        Head::Branch { branch, .. } | Head::Unborn { branch } => format!("refs/heads/{branch}"),
        Head::Detached { sha } => sha.clone(),
    }
}

/// Local branches whose upstream is on `remote`: (branch, `branch.<x>.merge`).
async fn branch_upstreams(core: &Core, repo_id: &str, remote: &str) -> CoreResult<Vec<(String, String)>> {
    let out = core
        .git_for(repo_id)?
        .args(["config", "-z", "--get-regexp", r"^branch\..*\.(remote|merge)$"])
        .read_only()
        .run_raw()
        .await?;
    if out.code != Some(0) {
        return Ok(Vec::new());
    }
    let mut remotes: Vec<(String, String)> = Vec::new();
    let mut merges: Vec<(String, String)> = Vec::new();
    for record in out.stdout_z() {
        let text = util::decode_lossy(record);
        let (key, value) = text.split_once('\n').unwrap_or((text.as_str(), ""));
        let Some(rest) = key.strip_prefix("branch.") else { continue };
        let Some((branch, var)) = rest.rsplit_once('.') else { continue };
        match var.to_ascii_lowercase().as_str() {
            "remote" => remotes.push((branch.to_string(), value.to_string())),
            "merge" => merges.push((branch.to_string(), value.to_string())),
            _ => {}
        }
    }
    Ok(remotes
        .into_iter()
        .filter(|(_, r)| r == remote)
        .filter_map(|(branch, _)| merges.iter().find(|(b, _)| *b == branch).map(|(_, m)| (branch, m.clone())))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use crate::events::names;
    use crate::testkit::{TestCore, TestRepo};

    #[test]
    fn hosts_are_detected_in_all_url_forms() {
        let cases = [
            ("https://github.com/a/b.git", RemoteHost::Github),
            ("https://user:token@github.com/a/b.git", RemoteHost::Github),
            ("git@github.com:a/b.git", RemoteHost::Github),
            ("ssh://git@github.com:22/a/b.git", RemoteHost::Github),
            ("https://github.firma.de/a/b", RemoteHost::Github),
            ("https://gitlab.com/gruppe/unter/projekt.git", RemoteHost::Gitlab),
            ("git@gitlab.firma.de:team/projekt.git", RemoteHost::Gitlab),
            ("https://bitbucket.org/team/repo.git", RemoteHost::Bitbucket),
            ("git@bitbucket.org:team/repo.git", RemoteHost::Bitbucket),
            ("https://dev.azure.com/org/projekt/_git/repo", RemoteHost::Azure),
            ("git@ssh.dev.azure.com:v3/org/projekt/repo", RemoteHost::Azure),
            ("https://org.visualstudio.com/projekt/_git/repo", RemoteHost::Azure),
            ("https://example.com/github/gitlab.git", RemoteHost::Other),
            ("git://[2001:db8::1]:9418/r.git", RemoteHost::Other),
            ("C:/Projekte/github.com/repo.git", RemoteHost::Other),
            (r"C:\Projekte\repo", RemoteHost::Other),
            ("/srv/git/gitlab/repo.git", RemoteHost::Other),
            ("file:///srv/github.com/repo.git", RemoteHost::Other),
            ("../nachbar", RemoteHost::Other),
        ];
        for (url, host) in cases {
            assert_eq!(detect_host(url), host, "{url}");
        }
        assert_eq!(url_host("ssh://git@Example.COM:2222/x").as_deref(), Some("example.com"));
        assert_eq!(url_host("git://[2001:db8::1]:9418/r.git").as_deref(), Some("2001:db8::1"));
    }

    #[test]
    fn credentials_are_masked_for_display_and_dropped_for_undo() {
        assert_eq!(display_url("https://anna:geheim@example.com/r.git"), "https://***@example.com/r.git");
        assert_eq!(display_url("https://ghp_token@github.com/a/b"), "https://***@github.com/a/b");
        assert_eq!(display_url("ssh://git@example.com/r.git"), "ssh://git@example.com/r.git");
        assert_eq!(display_url("ssh://anna:geheim@example.com/r.git"), "ssh://anna:***@example.com/r.git");
        assert_eq!(display_url("git@github.com:a/b.git"), "git@github.com:a/b.git");
        assert_eq!(display_url("https://example.com/a@b/r.git"), "https://example.com/a@b/r.git");
        assert_eq!(display_url("C:/a/b"), "C:/a/b");

        assert_eq!(strip_credentials("https://anna:geheim@example.com/r.git"), "https://example.com/r.git");
        assert_eq!(strip_credentials("ssh://anna:geheim@example.com/r.git"), "ssh://anna@example.com/r.git");
        assert_eq!(strip_credentials("ssh://git@example.com/r.git"), "ssh://git@example.com/r.git");
    }

    #[test]
    fn masked_urls_get_their_credentials_back() {
        let current = "https://anna:geheim@example.com/alt.git";
        // Sent back unchanged, or only the path changed.
        assert_eq!(unmask_url("https://***@example.com/alt.git", Some(current)).unwrap(), current);
        assert_eq!(unmask_url("https://***@example.com/neu.git", Some(current)).unwrap(), "https://anna:geheim@example.com/neu.git");
        // New credentials replace the old ones.
        assert_eq!(unmask_url("https://bob:neu@example.com/alt.git", Some(current)).unwrap(), "https://bob:neu@example.com/alt.git");
        // Masking without a matching original: better reject than store "***".
        assert_eq!(unmask_url("https://***@example.com/r.git", None).unwrap_err().code, ErrorCode::NotAllowed);
        assert_eq!(unmask_url("https://***@example.com/r.git", Some("https://example.com/r.git")).unwrap_err().code, ErrorCode::NotAllowed);
        let ssh = "ssh://anna:geheim@example.com/r.git";
        assert_eq!(unmask_url("ssh://anna:***@example.com/r.git", Some(ssh)).unwrap(), ssh);
        assert_eq!(unmask_url("ssh://bob:***@example.com/r.git", Some(ssh)).unwrap_err().code, ErrorCode::NotAllowed);
    }

    #[test]
    fn urls_are_checked_roughly() {
        for good in [
            "https://github.com/a/b.git",
            "ssh://git@host:22/r.git",
            "git@github.com:a/b.git",
            "C:/Projekte/mit leerzeichen/repo.git",
            "/srv/git/repo.git",
            "file:///C:/Projekte/mit leerzeichen/repo.git",
            "../nachbar",
        ] {
            assert!(check_url(good).is_ok(), "{good}");
        }
        for bad in [
            "",
            "   ",
            "-oProxyCommand=x",
            "htp://x/y",
            "https://",
            "https:///pfad",
            "https://host/mit leer",
            "ext::sh -c boese",
            "a\nb",
            "ftp://server.example/projekt.git",
            "FTPS://server.example/projekt.git",
            "svn://server.example/projekt",
        ] {
            assert_eq!(check_url(bad).unwrap_err().code, ErrorCode::NotAllowed, "{bad:?}");
        }
        let message = check_url("ftp://server.example/projekt.git").unwrap_err().message;
        assert!(message.contains("“ftp”") && message.contains("HTTPS, SSH, git and file"), "{message}");
    }

    #[test]
    fn config_output_is_parsed() {
        let out = b"remote.origin.url\nhttps://example.com/a.git\0remote.origin.fetch\n+refs/heads/*:refs/remotes/origin/*\0\
remote.mit.punkt.url\ngit@host:x.git\0remote.mit.punkt.pushurl\ngit@host:y.git\0remote.nurfetch.fetch\n+refs/*:refs/*\0";
        let remotes = parse_remote_config(out);
        assert_eq!(remotes.len(), 3);
        assert_eq!(remotes[0], RawRemote { name: "mit.punkt".into(), fetch_url: "git@host:x.git".into(), push_url: Some("git@host:y.git".into()) });
        assert_eq!(remotes[1].name, "nurfetch");
        assert_eq!(remotes[1].fetch_url, "");
        assert_eq!(remotes[2].name, "origin");
    }

    #[tokio::test]
    async fn list_add_edit_remove() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let id = tc.open(&repo).await.repo.id;
        assert!(remote_list(&tc, id.clone()).await.unwrap().is_empty());

        tc.events.clear();
        let list = remote_add(&tc, id.clone(), "origin".into(), "https://github.com/a/b.git".into(), None).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0], Remote { name: "origin".into(), fetch_url: "https://github.com/a/b.git".into(), push_url: None, host: RemoteHost::Github });
        let changed = tc.events.named(names::REPO_CHANGED);
        assert_eq!(changed.len(), 1);
        assert_eq!(changed[0]["what"], serde_json::json!(["config"]));

        // Second remote with a separate push URL; a push URL equal to the fetch URL does not count.
        let list = remote_add(&tc, id.clone(), "fork".into(), "git@gitlab.com:ich/b.git".into(), Some("git@gitlab.com:ich/push.git".into())).await.unwrap();
        assert_eq!(list.iter().map(|r| r.name.as_str()).collect::<Vec<_>>(), vec!["fork", "origin"]);
        assert_eq!(list[0].push_url.as_deref(), Some("git@gitlab.com:ich/push.git"));
        assert_eq!(list[0].host, RemoteHost::Gitlab);
        assert_eq!(repo.git(&["remote", "get-url", "--push", "fork"]), "git@gitlab.com:ich/push.git");
        let list = remote_add(&tc, id.clone(), "gleich".into(), "https://example.com/x.git".into(), Some("https://example.com/x.git".into())).await.unwrap();
        assert_eq!(list.iter().find(|r| r.name == "gleich").unwrap().push_url, None);
        assert!(!repo.git_output(&["config", "--get", "remote.gleich.pushurl"]).status.success());

        // Rename, change fetch URL, remove push URL.
        let list = remote_edit(&tc, id.clone(), "fork".into(), "mein-fork".into(), "git@gitlab.com:ich/neu.git".into(), None).await.unwrap();
        let fork = list.iter().find(|r| r.name == "mein-fork").unwrap();
        assert_eq!(fork.fetch_url, "git@gitlab.com:ich/neu.git");
        assert_eq!(fork.push_url, None);
        assert!(!list.iter().any(|r| r.name == "fork"));
        assert_eq!(repo.git(&["remote", "get-url", "--push", "mein-fork"]), "git@gitlab.com:ich/neu.git");
        // Set the push URL again without renaming.
        let list = remote_edit(&tc, id.clone(), "mein-fork".into(), "mein-fork".into(), "git@gitlab.com:ich/neu.git".into(), Some("git@gitlab.com:ich/p.git".into())).await.unwrap();
        assert_eq!(list.iter().find(|r| r.name == "mein-fork").unwrap().push_url.as_deref(), Some("git@gitlab.com:ich/p.git"));

        // Error cases
        let err = remote_add(&tc, id.clone(), "origin".into(), "https://x/y".into(), None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NameExists);
        let err = remote_add(&tc, id.clone(), "mit leer".into(), "https://x/y".into(), None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidName);
        let err = remote_add(&tc, id.clone(), "neu".into(), "htp://x/y".into(), None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
        // The core rejects FTP, as the message says – when adding and when editing, also as a push URL.
        let err = remote_add(&tc, id.clone(), "neu".into(), "ftp://server.example/projekt.git".into(), None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
        let err = remote_add(&tc, id.clone(), "neu".into(), "https://x/y".into(), Some("ftps://server.example/p.git".into())).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
        let err = remote_edit(&tc, id.clone(), "origin".into(), "origin".into(), "ftp://server.example/projekt.git".into(), None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
        assert!(!remote_list(&tc, id.clone()).await.unwrap().iter().any(|r| r.name == "neu"));
        let err = remote_edit(&tc, id.clone(), "origin".into(), "mein-fork".into(), "https://github.com/a/b.git".into(), None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NameExists);
        let err = remote_edit(&tc, id.clone(), "weg".into(), "weg".into(), "https://x/y".into(), None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        let err = remote_edit(&tc, id.clone(), "origin".into(), "a..b".into(), "https://x/y".into(), None).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidName);
        let err = remote_remove(&tc, id.clone(), "weg".into()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
        // After the errors nothing is half changed.
        assert_eq!(repo.git(&["remote", "get-url", "origin"]), "https://github.com/a/b.git");
    }

    #[tokio::test]
    async fn credentials_in_urls_are_masked_and_survive_an_edit() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let id = tc.open(&repo).await.repo.id;
        let secret = "https://anna:supergeheim@example.com/team/repo.git";
        let list = remote_add(&tc, id.clone(), "origin".into(), secret.into(), None).await.unwrap();
        assert_eq!(list[0].fetch_url, "https://***@example.com/team/repo.git");
        assert_eq!(repo.git(&["remote", "get-url", "origin"]), secret);

        // The UI sends the masked URL back unchanged and only renames.
        let list = remote_edit(&tc, id.clone(), "origin".into(), "haupt".into(), list[0].fetch_url.clone(), None).await.unwrap();
        assert_eq!(list[0].name, "haupt");
        assert_eq!(repo.git(&["remote", "get-url", "haupt"]), secret);

        // None of it ends up in the log or in events.
        let all = format!("{:?}", tc.events.all());
        assert!(!all.contains("supergeheim"), "{all}");

        // The undo entry contains the URL without the secret.
        remote_remove(&tc, id.clone(), "haupt".into()).await.unwrap();
        let entry = undo::next_undo(&tc, &id, "").unwrap().unwrap();
        assert_eq!(entry.payload["remote"]["fetchUrl"], "https://example.com/team/repo.git");
        assert!(!entry.payload.to_string().contains("supergeheim"));
    }

    #[tokio::test]
    async fn remove_records_undo_and_keeps_remote_branches_alive() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let remote = repo.add_remote();
        let id = tc.open(&repo).await.repo.id;
        // A commit that is only reachable via the remote branch.
        repo.checkout_new("nur-remote");
        let lonely = repo.commit_file("x.txt", "x\n", "Nur auf dem Remote");
        repo.git(&["push", "-q", "origin", "nur-remote"]);
        repo.checkout("main");
        repo.git(&["branch", "-D", "nur-remote"]);
        repo.git(&["remote", "set-url", "--push", "origin", "C:/anderswo/push.git"]);

        tc.events.clear();
        let list = remote_remove(&tc, id.clone(), "origin".into()).await.unwrap();
        assert!(list.is_empty());
        assert!(!repo.git_output(&["rev-parse", "--verify", "-q", "refs/remotes/origin/main"]).status.success());
        let changed = tc.events.named(names::REPO_CHANGED);
        assert_eq!(changed[0]["what"], serde_json::json!(["refs", "config"]));

        let entry = undo::next_undo(&tc, &id, "").unwrap().unwrap();
        assert_eq!(entry.action, "remove_remote");
        assert_eq!(entry.label, "Undo removing remote ‘origin’");
        assert_eq!(entry.head_before, "refs/heads/main");
        assert_eq!(entry.payload["remote"]["name"], "origin");
        assert_eq!(entry.payload["remote"]["fetchUrl"], remote.url());
        assert_eq!(entry.payload["remote"]["pushUrl"], "C:/anderswo/push.git");
        assert_eq!(entry.payload["upstreams"], serde_json::json!([{ "branch": "main", "merge": "refs/heads/main" }]));
        let refs = entry.payload["refs"].as_array().unwrap();
        assert_eq!(refs.len(), 2);
        assert!(refs.iter().any(|r| r["name"] == "refs/remotes/origin/nur-remote" && r["sha"] == lonely.as_str()));
        // The backup ref keeps the commit.
        let backup = undo::backup_ref_name(&entry.id, "remotes/origin/nur-remote");
        assert_eq!(repo.git(&["rev-parse", &backup]), lonely);
    }

    #[tokio::test]
    async fn works_in_empty_repo_and_on_detached_head() {
        let tc = TestCore::new().await;
        let empty = TestRepo::new();
        let id = tc.open(&empty).await.repo.id;
        remote_add(&tc, id.clone(), "origin".into(), "git@bitbucket.org:t/r.git".into(), None).await.unwrap();
        remote_remove(&tc, id.clone(), "origin".into()).await.unwrap();
        assert_eq!(undo::next_undo(&tc, &id, "").unwrap().unwrap().head_before, "refs/heads/main");

        let repo = TestRepo::with_commit();
        let sha = repo.head();
        repo.git(&["checkout", "-q", "--detach"]);
        let id = tc.open(&repo).await.repo.id;
        remote_add(&tc, id.clone(), "origin".into(), "https://dev.azure.com/o/p/_git/r".into(), None).await.unwrap();
        assert_eq!(remote_list(&tc, id.clone()).await.unwrap()[0].host, RemoteHost::Azure);
        remote_remove(&tc, id.clone(), "origin".into()).await.unwrap();
        assert_eq!(undo::next_undo(&tc, &id, "").unwrap().unwrap().head_before, sha);
    }
}
