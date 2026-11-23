//! The Git part of the digest: which remote branches and tags have news from the last 24 hours,
//! their commits, the files of yours other people's commits touch, and how far the current branch is
//! behind. A pure read: no lock.

use std::collections::{BTreeMap, HashSet};

use chrono::{DateTime, Utc};

use crate::app::Core;
use crate::commands::{branch_cleanup, refs, status};
use crate::error::CoreResult;
use crate::git::log::LOG_SAFE;
use crate::host;
use crate::model::{Digest, DigestBehind, DigestCommit, DigestFile, DigestRef, Head, HostKind, RefKind, RefsSnapshot};
use crate::util;

use super::{prs, seen};

/// Commits read per ref; also the limit for "your files".
const MAX_COMMITS: &str = "--max-count=500";
/// Subjects listed per ref.
const LISTED: usize = 20;
const NOREPLY: &str = "@users.noreply.github.com";

struct LogCommit {
    sha: String,
    author: String,
    email: String,
    subject: String,
    paths: Vec<String>,
}

/// The digest for everything since `since`.
pub(crate) async fn compose(core: &Core, repo_id: &str, since: DateTime<Utc>) -> CoreResult<Digest> {
    let (current, snapshot, status, own, pr, ref_times) = tokio::join!(
        seen::current_refs(core, repo_id),
        refs::read_refs(core, repo_id),
        status::read_status(core, repo_id),
        own_emails(core, repo_id),
        prs::pr_part(core, repo_id, since),
        ref_times(core, repo_id),
    );
    let (current, snapshot, status, ref_times) = (current?, snapshot?, status?, ref_times?);
    let default = branch_cleanup::default_branch(core, repo_id, &snapshot.locals).await;
    let base = default.as_deref().and_then(|name| base_of(&snapshot, name));

    // The base branch first: a commit on both it and a feature branch is listed under the base.
    // shortcut: the rest by name, not by who contains whom; fine while a shared commit is rare in 24 hours.
    let base_ref = base.as_ref().map(|b| format!("refs/remotes/{b}"));
    // A tip older than the window has no commit in it: one `git log` less per idle branch.
    // shortcut: trusts the tip's committer date; a commit with a date from the future would hide older ones below it.
    let mut branches: Vec<&String> = current
        .keys()
        .filter(|name| name.starts_with("refs/remotes/") && ref_times.get(*name).is_some_and(|time| *time > since.timestamp()))
        .collect();
    branches.sort_by_key(|name| (Some(*name) != base_ref.as_ref(), *name));

    let mut digest_refs = Vec::new();
    let mut listed: HashSet<String> = HashSet::new();
    // shortcut: across refs the first ref wins, not the newest commit by date; fine while one ref brings a file.
    let mut touched: BTreeMap<String, String> = BTreeMap::new();
    for name in branches {
        let commits: Vec<LogCommit> = log(core, repo_id, name, since).await?.into_iter().filter(|c| listed.insert(c.sha.clone())).collect();
        if commits.is_empty() {
            continue;
        }
        for commit in commits.iter().filter(|c| !is_own(&c.email, &own)) {
            for path in &commit.paths {
                touched.entry(path.clone()).or_insert_with(|| commit.sha.clone());
            }
        }
        digest_refs.push(DigestRef {
            name: name.trim_start_matches("refs/remotes/").to_string(),
            kind: RefKind::Remote,
            new_sha: current.get(name).cloned(),
            new_commits: commits.len() as u32,
            commits: commits.into_iter().take(LISTED).map(|c| DigestCommit { sha: c.sha, subject: c.subject, author: c.author }).collect(),
        });
    }
    let mut tags: Vec<DigestRef> = snapshot
        .tags
        .iter()
        .filter(|t| ref_times.get(&t.full_name).is_some_and(|time| *time > since.timestamp()))
        .map(|t| DigestRef { name: t.name.clone(), kind: RefKind::Tag, new_sha: Some(t.sha.clone()), new_commits: 0, commits: Vec::new() })
        .collect();
    tags.sort_by(|a, b| a.name.cmp(&b.name));
    digest_refs.extend(tags);

    let your_files = if touched.is_empty() {
        Vec::new()
    } else {
        let local: HashSet<&str> =
            status.unstaged.iter().chain(&status.staged).chain(&status.conflicted).map(|f| f.path.as_str()).collect();
        let on_branch = match (&base, status.head.sha()) {
            (Some(base), Some(_)) => branch_paths(core, repo_id, base).await?,
            _ => HashSet::new(),
        };
        touched
            .into_iter()
            .filter_map(|(path, sha)| {
                let (local, on_branch) = (local.contains(path.as_str()), on_branch.contains(&path));
                (local || on_branch).then_some(DigestFile { path, sha, local, on_branch })
            })
            .collect()
    };
    let behind = match (&status.head, &base) {
        (Head::Branch { branch, .. }, Some(base)) if default.as_ref() != Some(branch) => behind_of(core, repo_id, branch, base).await?,
        _ => None,
    };
    let is_empty = digest_refs.is_empty() && !pr.prs.as_ref().is_some_and(|p| !p.changed.is_empty() || !p.comments.is_empty());
    Ok(Digest {
        since: since.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
        refs: digest_refs,
        new_commits: listed.len() as u32,
        your_files,
        behind,
        prs: pr.prs,
        pr_data_missing: pr.missing,
        is_empty,
    })
}

/// Time (Unix seconds) per full ref name of the remote branches and tags: the committer date of a branch tip, the
/// tagger date of an annotated tag, the commit date of a lightweight one. One Git call.
async fn ref_times(core: &Core, repo_id: &str) -> CoreResult<BTreeMap<String, i64>> {
    let path = core.repo_path(repo_id)?;
    let options = ["--format=%(refname)%00%(creatordate:unix)".to_string()];
    let out = refs::for_each_ref(core, &path, repo_id, &options, &["refs/remotes", "refs/tags"]).await?;
    Ok(out
        .stdout_lines()
        .into_iter()
        .filter_map(|line| {
            let mut parts = line.split(|&b| b == 0);
            let (name, time) = (parts.next()?, parts.next()?);
            Some((util::decode_lossy(name), util::decode_lossy(time).trim().parse().ok()?))
        })
        .collect())
}

/// The user's e-mail addresses, lowercase: the effective `user.email`, and for a connected GitHub
/// account `<login>@users.noreply.github.com` (`<digits>+<login>@…` matches it too, see `is_own`).
pub(crate) async fn own_emails(core: &Core, repo_id: &str) -> Vec<String> {
    let mut emails = Vec::new();
    if let Ok(git) = core.git_for(repo_id) {
        if let Ok(out) = git.read().args(["config", "--get", "user.email"]).run_raw().await {
            let email = out.stdout_text().trim().to_lowercase();
            if out.success() && !email.is_empty() {
                emails.push(email);
            }
        }
    }
    if let Ok(Some(found)) = host::resolve(core, repo_id, None).await {
        let login = found.detected.account.and_then(|a| a.login).filter(|l| !l.is_empty());
        if let (HostKind::Github, Some(login)) = (found.detected.kind, login) {
            emails.push(format!("{login}{NOREPLY}").to_lowercase());
        }
    }
    emails
}

fn is_own(email: &str, own: &[String]) -> bool {
    let email = email.to_lowercase();
    own.iter().any(|o| {
        *o == email
            || (o.ends_with(NOREPLY)
                && email
                    .strip_suffix(o.as_str())
                    .and_then(|p| p.strip_suffix('+'))
                    .is_some_and(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit())))
    })
}

/// `git log <tip> --since=<since>`, newest first, with the paths each commit changed.
async fn log(core: &Core, repo_id: &str, tip: &str, since: DateTime<Utc>) -> CoreResult<Vec<LogCommit>> {
    let out = core
        .git_for(repo_id)?
        .read()
        .args(["log", "-z", "--no-renames", "--name-only", MAX_COMMITS, "--format=%x1e%H%x00%an%x00%ae%x00%s"])
        .arg(format!("--since={}", since.timestamp()))
        .args(LOG_SAFE)
        .args([tip, "--"])
        .run()
        .await?;
    Ok(util::split_records(&out.stdout, 0x1e)
        .filter_map(|record| {
            let mut fields = record.split(|&b| b == 0);
            let mut text = || fields.next().map(util::decode_lossy);
            let (sha, author, email, subject) = (text()?, text()?, text()?, text()?);
            let paths = fields.map(|p| p.strip_prefix(b"\n").unwrap_or(p)).filter(|p| !p.is_empty()).map(util::decode_lossy).collect();
            Some(LogCommit { sha, author, email, subject, paths })
        })
        .collect())
}

/// Upstream of the default branch, else the default branch itself (short name).
fn base_of(snapshot: &RefsSnapshot, default: &str) -> Option<String> {
    let local = snapshot.locals.iter().find(|r| r.name == default)?;
    Some(local.upstream.clone().filter(|_| !local.upstream_gone).unwrap_or_else(|| default.to_string()))
}

/// Paths the current branch changed since its merge base with `base`.
async fn branch_paths(core: &Core, repo_id: &str, base: &str) -> CoreResult<HashSet<String>> {
    let range = format!("{base}...HEAD");
    let out =
        core.git_for(repo_id)?.read().args(["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", &range, "--"]).run().await?;
    Ok(util::split_records(&out.stdout, 0).filter(|p| !p.is_empty()).map(util::decode_lossy).collect())
}

async fn behind_of(core: &Core, repo_id: &str, branch: &str, base: &str) -> CoreResult<Option<DigestBehind>> {
    let range = format!("HEAD...{base}");
    let out = core.git_for(repo_id)?.read().args(["rev-list", "--left-right", "--count", &range, "--"]).run().await?;
    let text = out.stdout_text();
    let mut counts = text.split_whitespace().map(|n| n.parse::<u32>().unwrap_or(0));
    let (ahead, behind) = (counts.next().unwrap_or(0), counts.next().unwrap_or(0));
    Ok((behind > 0).then(|| DigestBehind { branch: branch.to_string(), base: base.to_string(), behind, ahead }))
}
