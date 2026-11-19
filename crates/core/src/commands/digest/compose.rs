//! The Git part of the digest: which remote branches and tags changed since the seen state, their
//! foreign commits, the files of yours they touch, and how far the current branch is behind.
//! A pure read: no lock.

use std::collections::{BTreeMap, BTreeSet, HashSet};

use crate::app::Core;
use crate::commands::{branch_cleanup, refs, status};
use crate::db::repo_seen::SeenRow;
use crate::error::CoreResult;
use crate::git::log::LOG_SAFE;
use crate::git::rev;
use crate::host;
use crate::model::{Digest, DigestBehind, DigestCommit, DigestFile, DigestRef, DigestRefChange, Head, HostKind, RefKind, RefsSnapshot};
use crate::util;

use super::seen;

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

/// The digest against `seen`, without pull requests.
pub(crate) async fn compose_at(core: &Core, repo_id: &str, seen: &SeenRow) -> CoreResult<Digest> {
    let (current, snapshot, status, own) = tokio::join!(
        seen::current_refs(core, repo_id),
        refs::read_refs(core, repo_id),
        status::read_status(core, repo_id),
        own_emails(core, repo_id),
    );
    let (current, snapshot, status) = (current?, snapshot?, status?);
    let names: BTreeSet<&String> = seen.refs.keys().chain(current.keys()).collect();
    // Seen SHAs that are gone from the object database (pruned, gc) would make `git log` fail.
    let known = existing(core, repo_id, seen.refs.values()).await?;
    let all_seen: Vec<String> = seen.refs.values().filter(|sha| known.contains(*sha)).cloned().collect();

    let mut digest_refs = Vec::new();
    let mut foreign: HashSet<String> = HashSet::new();
    // shortcut: across refs the first ref by name wins, not the newest commit by date; fine while one ref brings a file.
    let mut touched: BTreeMap<String, String> = BTreeMap::new();
    for name in names {
        let (old, new) = (seen.refs.get(name), current.get(name));
        if old == new {
            continue;
        }
        let (kind, short) = match (name.strip_prefix("refs/remotes/"), name.strip_prefix("refs/tags/")) {
            (Some(short), _) => (RefKind::Remote, short),
            (None, Some(short)) => (RefKind::Tag, short),
            _ => continue,
        };
        let change = match (old, new) {
            (None, _) => DigestRefChange::New,
            (_, None) => DigestRefChange::Deleted,
            (Some(o), Some(n)) if kind == RefKind::Remote && !rev::is_ancestor(core, repo_id, o, n).await? => DigestRefChange::Rewritten,
            _ => DigestRefChange::Updated,
        };
        let mut commits = Vec::new();
        if let (RefKind::Remote, Some(new)) = (kind, new) {
            let not = match old.filter(|o| known.contains(*o)) {
                Some(o) => std::slice::from_ref(o),
                None => all_seen.as_slice(),
            };
            commits = log(core, repo_id, new, not).await?.into_iter().filter(|c| !is_own(&c.email, &own)).collect();
            // Only own commits: the user pushed it elsewhere, nothing new.
            if change == DigestRefChange::Updated && commits.is_empty() {
                continue;
            }
        }
        for commit in &commits {
            foreign.insert(commit.sha.clone());
            for path in &commit.paths {
                touched.entry(path.clone()).or_insert_with(|| commit.sha.clone());
            }
        }
        let new_sha = match kind {
            RefKind::Tag => snapshot.tags.iter().find(|t| &t.full_name == name).map(|t| t.sha.clone()).or_else(|| new.cloned()),
            _ => new.cloned(),
        };
        digest_refs.push(DigestRef {
            name: short.to_string(),
            kind,
            change,
            old_sha: old.cloned(),
            new_sha,
            new_commits: commits.len() as u32,
            commits: commits.into_iter().take(LISTED).map(|c| DigestCommit { sha: c.sha, subject: c.subject, author: c.author }).collect(),
        });
    }

    let default = branch_cleanup::default_branch(core, repo_id, &snapshot.locals).await;
    let base = default.as_deref().and_then(|name| base_of(&snapshot, name));
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
    let is_empty = digest_refs.is_empty();
    Ok(Digest {
        seen_at: seen.seen_at.clone(),
        refs: digest_refs,
        new_commits: foreign.len() as u32,
        your_files,
        behind,
        prs: None,
        pr_data_missing: None,
        pr_max_number: seen.pr_max_number,
        is_empty,
    })
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

/// Which of `shas` are commits or tags in the object database.
async fn existing<'a>(core: &Core, repo_id: &str, shas: impl Iterator<Item = &'a String>) -> CoreResult<HashSet<String>> {
    let query: String = shas.map(|sha| format!("{sha}\n")).collect();
    if query.is_empty() {
        return Ok(HashSet::new());
    }
    let out = core.git_for(repo_id)?.read().args(["cat-file", "--batch-check=%(objectname) %(objecttype)"]).stdin(query).run().await?;
    Ok(out
        .stdout_lines()
        .into_iter()
        .map(util::decode_lossy)
        .filter_map(|line| match line.split_once(' ') {
            Some((sha, "commit" | "tag")) => Some(sha.to_string()),
            _ => None,
        })
        .collect())
}

/// `git log <tip> --not <not…>`, newest first, with the paths each commit changed. The revisions go
/// through stdin: a seen state with thousands of tags would not fit on a Windows command line.
async fn log(core: &Core, repo_id: &str, tip: &str, not: &[String]) -> CoreResult<Vec<LogCommit>> {
    let revs: String = std::iter::once(format!("{tip}\n")).chain(not.iter().map(|sha| format!("^{sha}\n"))).collect();
    let out = core
        .git_for(repo_id)?
        .read()
        .args(["log", "--stdin", "-z", "--no-renames", "--name-only", MAX_COMMITS, "--format=%x1e%H%x00%an%x00%ae%x00%s"])
        .args(LOG_SAFE)
        .stdin(revs)
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
