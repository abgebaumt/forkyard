//! Reflog of HEAD or of a branch (`reflog_list`): where the ref has pointed, newest first.
//!
//! Read straight from the reflog file Git keeps (`git rev-parse --git-path logs/<ref>`): `git log -g`
//! silently skips entries whose commit is gone, but those must stay visible here (`exists: false`).
//! A repository with the reftable backend has no such file; there `git log -g` is the source and only
//! lists entries whose commit still exists. Only reads: no lock, no event, no log entry.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use crate::app::Core;
use crate::commands::graph::{display_text, is_full_sha, read_cmd, LOG_SAFE};
use crate::error::{CoreError, CoreResult};
use crate::git::redact;
use crate::model::{ReflogAction, ReflogEntry, ReflogPage};
use crate::util;

/// Largest page; a call never returns more.
pub const MAX_REFLOG_PAGE: u32 = 5_000;

/// One reflog line, before the page is cut out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RawEntry {
    pub sha: String,
    /// Seconds since 1970; 0 if the line has no readable time.
    pub time: i64,
    pub action: ReflogAction,
    /// Already redacted.
    pub message: String,
}

/// `ref_name`: `HEAD` (also when missing), `refs/heads/<name>` or `refs/remotes/<name>`.
pub async fn reflog_list(core: &Core, repo_id: String, ref_name: Option<String>, cursor: Option<String>, limit: u32) -> CoreResult<ReflogPage> {
    let path = core.repo_path(&repo_id)?;
    let name = checked_ref(ref_name.as_deref())?;
    let limit = limit.clamp(1, MAX_REFLOG_PAGE) as usize;
    let all = read_entries(core, &path, &repo_id, &name).await?;
    let offset = match cursor.as_deref() {
        Some(text) => resume_at(text, all.len())?,
        None => 0,
    };
    let page: Vec<&RawEntry> = all.iter().skip(offset).take(limit).collect();
    let shas: Vec<&str> = page.iter().map(|e| e.sha.as_str()).collect();
    let present = existing_commits(core, &path, &repo_id, &shas).await?;
    let label = selector_name(&name);
    let entries = page
        .iter()
        .enumerate()
        .map(|(i, e)| ReflogEntry {
            sha: e.sha.clone(),
            selector: format!("{label}@{{{}}}", offset + i),
            action: e.action,
            message: e.message.clone(),
            time: util::unix_to_iso(e.time),
            exists: present.contains(&e.sha),
        })
        .collect();
    let next = offset + page.len();
    let next_cursor = (next < all.len()).then(|| format!("{next}.{}", all.len()));
    Ok(ReflogPage { entries, next_cursor })
}

/// Only HEAD and branches have a reflog worth showing; everything else is refused before Git sees it.
fn checked_ref(name: Option<&str>) -> CoreResult<String> {
    let name = name.map(str::trim).filter(|n| !n.is_empty()).unwrap_or("HEAD");
    if name == "HEAD" {
        return Ok(name.to_string());
    }
    let short = name.strip_prefix("refs/heads/").or_else(|| name.strip_prefix("refs/remotes/"));
    match short {
        Some(short) if util::check_ref_name(short).is_ok() => Ok(name.to_string()),
        _ => {
            let shown: String = name.chars().filter(|c| !c.is_control()).take(80).collect();
            Err(CoreError::not_allowed(format!("The reflog can only be shown for HEAD or a branch, not for “{shown}”.")))
        }
    }
}

/// How Git names the entries: `HEAD@{n}`, `main@{n}`, `origin/main@{n}`.
fn selector_name(name: &str) -> &str {
    name.strip_prefix("refs/heads/").or_else(|| name.strip_prefix("refs/remotes/")).unwrap_or(name)
}

/// The cursor is `"<offset>.<entries at that time>"`. New entries since then push the old ones
/// down – the offset moves along, so the next page continues seamlessly. Fewer entries than before
/// (expired, branch recreated): the loaded pages no longer fit, `stale_state`.
pub(crate) fn resume_at(cursor: &str, total: usize) -> CoreResult<usize> {
    let (offset, then) = cursor.trim().split_once('.').ok_or_else(CoreError::stale_state)?;
    let offset: usize = offset.parse().map_err(|_| CoreError::stale_state())?;
    let then: usize = then.parse().map_err(|_| CoreError::stale_state())?;
    if total < then || offset > then {
        return Err(CoreError::stale_state());
    }
    Ok(offset + (total - then))
}

async fn read_entries(core: &Core, path: &Path, repo_id: &str, name: &str) -> CoreResult<Vec<RawEntry>> {
    match std::fs::read(log_file(core, path, repo_id, name).await?) {
        Ok(bytes) => return Ok(parse_reflog(&bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    if uses_reftable(core, path, repo_id).await {
        return walk_reflog(core, path, repo_id, name).await;
    }
    if name != "HEAD" && !ref_exists(core, path, repo_id, name).await {
        return Err(CoreError::not_found(format!("The branch “{}” doesn’t exist (any more).", selector_name(name))));
    }
    // Reflog switched off (`core.logAllRefUpdates=false`) or nothing recorded yet.
    Ok(Vec::new())
}

/// Path of the reflog file; Git knows where it lives (also in worktrees).
async fn log_file(core: &Core, path: &Path, repo_id: &str, name: &str) -> CoreResult<PathBuf> {
    let out = read_cmd(core, path, repo_id).args(["rev-parse", "--git-path"]).arg(format!("logs/{name}")).run().await?;
    let raw = out.stdout.strip_suffix(b"\n").unwrap_or(&out.stdout);
    let file = util::bytes_to_path(raw);
    Ok(if file.is_absolute() { file } else { path.join(file) })
}

async fn uses_reftable(core: &Core, path: &Path, repo_id: &str) -> bool {
    let out = read_cmd(core, path, repo_id).args(["config", "--get", "extensions.refStorage"]).run_raw().await;
    matches!(out, Ok(out) if out.success() && out.stdout_text().trim().eq_ignore_ascii_case("reftable"))
}

async fn ref_exists(core: &Core, path: &Path, repo_id: &str, name: &str) -> bool {
    let out = read_cmd(core, path, repo_id).args(["rev-parse", "-q", "--verify", "--end-of-options", name]).run_raw().await;
    matches!(out, Ok(out) if out.success())
}

/// Reftable: `git log -g` (newest first; entries of missing commits are absent there).
async fn walk_reflog(core: &Core, path: &Path, repo_id: &str, name: &str) -> CoreResult<Vec<RawEntry>> {
    let out = read_cmd(core, path, repo_id)
        .args(["log", "-g", "--date=unix"])
        .args(LOG_SAFE)
        .args(["-z", "--format=%H%x00%gd%x00%gs"])
        .arg(name)
        .arg("--")
        .run_raw()
        .await?;
    if !out.success() {
        return Ok(Vec::new());
    }
    let fields = out.stdout_z();
    Ok(fields
        .chunks(3)
        .filter(|c| c.len() == 3)
        .map(|c| {
            let text = display_text(c[2]);
            RawEntry { sha: util::decode_lossy(c[0]), time: selector_time(&util::decode_lossy(c[1])), action: reflog_action(&text), message: redact::redact(&text) }
        })
        .collect())
}

/// `HEAD@{1767225600}` (with `--date=unix`) → 1767225600.
fn selector_time(selector: &str) -> i64 {
    selector.rsplit_once("@{").and_then(|(_, rest)| rest.strip_suffix('}')).and_then(|t| t.parse().ok()).unwrap_or(0)
}

/// The reflog file: one line per change, oldest first –
/// `<old> <new> <name> <<email>> <seconds> <zone>\t<message>`. Returned newest first.
pub(crate) fn parse_reflog(bytes: &[u8]) -> Vec<RawEntry> {
    let mut out: Vec<RawEntry> = bytes
        .split(|&b| b == b'\n')
        .filter(|line| !line.is_empty())
        .filter_map(|line| {
            let (head, message) = match line.iter().position(|&b| b == b'\t') {
                Some(tab) => (&line[..tab], &line[tab + 1..]),
                None => (line, &line[line.len()..]),
            };
            let mut parts = head.splitn(3, |&b| b == b' ');
            let (_old, new, who) = (parts.next()?, parts.next()?, parts.next()?);
            let sha = util::decode_lossy(new);
            if !is_full_sha(&sha) {
                return None;
            }
            let time = who
                .iter()
                .rposition(|&b| b == b'>')
                .and_then(|gt| std::str::from_utf8(&who[gt + 1..]).ok())
                .and_then(|rest| rest.split_whitespace().next()?.parse::<i64>().ok())
                .unwrap_or(0);
            let text = display_text(message);
            Some(RawEntry { sha, time, action: reflog_action(&text), message: redact::redact(&text) })
        })
        .collect();
    out.reverse();
    out
}

/// What happened, from the start of the message Git writes (`commit (amend): …`, `checkout: …`).
pub(crate) fn reflog_action(message: &str) -> ReflogAction {
    let prefix = message.split(':').next().unwrap_or_default().trim();
    let word = prefix.split([' ', '(']).next().unwrap_or_default();
    match word {
        "commit" if prefix.contains("(amend)") => ReflogAction::Amend,
        "commit" if prefix.contains("(merge)") => ReflogAction::Merge,
        "commit" if prefix.contains("(cherry-pick)") => ReflogAction::CherryPick,
        "commit" => ReflogAction::Commit,
        "checkout" => ReflogAction::Checkout,
        "reset" => ReflogAction::Reset,
        "rebase" => ReflogAction::Rebase,
        "merge" => ReflogAction::Merge,
        "pull" => ReflogAction::Pull,
        "cherry-pick" => ReflogAction::CherryPick,
        _ => ReflogAction::Other,
    }
}

/// The SHAs among `shas` whose commit still exists.
async fn existing_commits(core: &Core, path: &Path, repo_id: &str, shas: &[&str]) -> CoreResult<HashSet<String>> {
    if shas.is_empty() {
        return Ok(HashSet::new());
    }
    let mut stdin = String::with_capacity(shas.len() * 41);
    for sha in shas {
        stdin.push_str(sha);
        stdin.push('\n');
    }
    let out = read_cmd(core, path, repo_id).args(["cat-file", "--batch-check=%(objectname) %(objecttype)"]).stdin(stdin).run().await?;
    Ok(out
        .stdout_lines()
        .into_iter()
        .filter_map(|line| {
            let text = util::decode_lossy(line);
            let (sha, kind) = text.split_once(' ')?;
            (kind == "commit").then(|| sha.to_string())
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use crate::events::names;
    use crate::testkit::{TestCore, TestRepo};

    #[test]
    fn parses_reflog_lines_newest_first() {
        let a = "a".repeat(40);
        let b = "b".repeat(40);
        let zero = "0".repeat(40);
        let text = format!(
            "{zero} {a} Test Person <t@example.com> 1767225600 +0000\tcommit (initial): Erster\n\
             {a} {b} Test Person <t@example.com> 1767225660 +0100\tcheckout: moving from main to x\n\
             {b} {a} Test Person <t@example.com> 1767225720 +0000\n\
             kaputt\n"
        );
        let entries = parse_reflog(text.as_bytes());
        assert_eq!(entries.len(), 3);
        assert_eq!((entries[0].sha.as_str(), entries[0].time, entries[0].action, entries[0].message.as_str()), (a.as_str(), 1_767_225_720, ReflogAction::Other, ""));
        assert_eq!((entries[1].sha.as_str(), entries[1].action), (b.as_str(), ReflogAction::Checkout));
        assert_eq!((entries[2].time, entries[2].action, entries[2].message.as_str()), (1_767_225_600, ReflogAction::Commit, "commit (initial): Erster"));
    }

    #[test]
    fn the_action_comes_from_the_start_of_the_message() {
        let cases = [
            ("commit: Text", ReflogAction::Commit),
            ("commit (initial): Erster", ReflogAction::Commit),
            ("commit (amend): Text", ReflogAction::Amend),
            ("commit (merge): Merge branch 'x'", ReflogAction::Merge),
            ("commit (cherry-pick): Text", ReflogAction::CherryPick),
            ("checkout: moving from a to b", ReflogAction::Checkout),
            ("reset: moving to HEAD~1", ReflogAction::Reset),
            ("rebase (finish): returning to refs/heads/x", ReflogAction::Rebase),
            ("rebase -i (start): checkout main", ReflogAction::Rebase),
            ("merge feature: Fast-forward", ReflogAction::Merge),
            ("pull --rebase (finish): refs/heads/main onto 1234", ReflogAction::Pull),
            ("pull https://example.com/r.git: Fast-forward", ReflogAction::Pull),
            ("cherry-pick: Text", ReflogAction::CherryPick),
            ("branch: Created from HEAD", ReflogAction::Other),
            ("", ReflogAction::Other),
        ];
        for (message, action) in cases {
            assert_eq!(reflog_action(message), action, "{message}");
        }
    }

    #[test]
    fn the_cursor_moves_with_new_entries() {
        assert_eq!(resume_at("2.5", 5).unwrap(), 2);
        assert_eq!(resume_at("2.5", 7).unwrap(), 4);
        for bad in ["", "2", "x.5", "2.x", "6.5"] {
            assert_eq!(resume_at(bad, 5).unwrap_err().code, ErrorCode::StaleState, "{bad}");
        }
        assert_eq!(resume_at("2.5", 4).unwrap_err().code, ErrorCode::StaleState, "fewer entries than before");
    }

    #[tokio::test]
    async fn head_reflog_lists_newest_first_with_selectors_and_actions() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let second = repo.commit_file("a.txt", "1\n", "Zweiter");
        repo.checkout_new("seite");
        repo.git(&["commit", "-q", "--amend", "-m", "Zweiter, geändert"]);
        let amended = repo.head();
        repo.checkout("main");
        repo.git(&["reset", "-q", "--hard", "HEAD~1"]);
        let id = tc.open(&repo).await.repo.id;
        tc.events.clear();

        let page = reflog_list(&tc, id.clone(), None, None, 100).await.unwrap();
        let actions: Vec<ReflogAction> = page.entries.iter().map(|e| e.action).collect();
        use ReflogAction::*;
        assert_eq!(actions, vec![Reset, Checkout, Amend, Checkout, Commit, Commit]);
        assert_eq!((page.entries[0].selector.as_str(), page.entries[5].selector.as_str()), ("HEAD@{0}", "HEAD@{5}"));
        assert_eq!(page.entries[2].sha, amended);
        assert_eq!(page.entries[4].sha, second);
        assert!(page.entries[0].message.starts_with("reset: moving to HEAD~1"), "{}", page.entries[0].message);
        assert!(page.entries[5].time.starts_with("2026-01-01T") && page.entries[5].time.ends_with('Z'), "{}", page.entries[5].time);
        assert!(page.entries.iter().all(|e| e.exists));
        assert_eq!(page.next_cursor, None);
        // Pure read command: no event, no log entry.
        assert!(tc.events.all().is_empty(), "{:?}", tc.events.all());
        assert_eq!(tc.events.count(names::LOG_APPENDED), 0);
    }

    #[tokio::test]
    async fn pages_continue_seamlessly_even_when_new_entries_arrive() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        for i in 0..4 {
            repo.commit_file("a.txt", format!("{i}\n"), &format!("Runde {i}"));
        }
        let id = tc.open(&repo).await.repo.id;
        let all = reflog_list(&tc, id.clone(), None, None, 100).await.unwrap().entries;
        assert_eq!(all.len(), 5);

        let first = reflog_list(&tc, id.clone(), None, None, 2).await.unwrap();
        assert_eq!(first.entries, all[..2].to_vec());
        repo.commit_file("b.txt", "neu\n", "Kommt zwischen den Seiten");
        let second = reflog_list(&tc, id.clone(), None, first.next_cursor.clone(), 2).await.unwrap();
        let shas = |entries: &[ReflogEntry]| entries.iter().map(|e| e.sha.clone()).collect::<Vec<_>>();
        assert_eq!(shas(&second.entries), shas(&all[2..4]));
        assert_eq!(second.entries[0].selector, "HEAD@{3}", "the selector counts the new entry");
        let third = reflog_list(&tc, id.clone(), None, second.next_cursor.clone(), 2).await.unwrap();
        assert_eq!(shas(&third.entries), shas(&all[4..]));
        assert_eq!(third.next_cursor, None);

        for bad in ["", "x", "3", "1.x", "9.2"] {
            let err = reflog_list(&tc, id.clone(), None, Some(bad.into()), 2).await.unwrap_err();
            assert_eq!(err.code, ErrorCode::StaleState, "{bad}");
        }
    }

    #[tokio::test]
    async fn entries_whose_commit_is_gone_stay_visible() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        repo.checkout_new("weg");
        let gone = repo.commit_file("weg.txt", "x\n", "Verschwindet");
        repo.checkout("main");
        repo.git(&["branch", "-D", "weg"]);
        std::fs::remove_file(repo.path().join(".git").join("objects").join(&gone[..2]).join(&gone[2..])).unwrap();
        let id = tc.open(&repo).await.repo.id;

        let page = reflog_list(&tc, id.clone(), None, None, 100).await.unwrap();
        let entry = page.entries.iter().find(|e| e.sha == gone).expect("entry of the removed commit");
        assert!(!entry.exists);
        assert_eq!(entry.action, ReflogAction::Commit);
        assert!(page.entries.iter().filter(|e| e.sha != gone).all(|e| e.exists));
    }

    #[tokio::test]
    async fn a_branch_has_its_own_reflog_and_other_names_are_refused() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        repo.checkout_new("feature/x");
        let tip = repo.commit_file("x.txt", "x\n", "Auf dem Branch");
        repo.checkout("main");
        let id = tc.open(&repo).await.repo.id;

        let page = reflog_list(&tc, id.clone(), Some("refs/heads/feature/x".into()), None, 100).await.unwrap();
        assert_eq!(page.entries.len(), 2);
        assert_eq!((page.entries[0].sha.as_str(), page.entries[0].action, page.entries[0].selector.as_str()), (tip.as_str(), ReflogAction::Commit, "feature/x@{0}"));
        assert_eq!(page.entries[1].action, ReflogAction::Other, "branch: Created from HEAD");

        for bad in ["refs/heads/../config", "refs/tags/v1", "--output=x", "main", "refs/heads/"] {
            let err = reflog_list(&tc, id.clone(), Some(bad.into()), None, 10).await.unwrap_err();
            assert_eq!(err.code, ErrorCode::NotAllowed, "{bad}");
        }
        repo.git(&["branch", "-D", "feature/x"]);
        let err = reflog_list(&tc, id.clone(), Some("refs/heads/feature/x".into()), None, 10).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn a_switched_off_reflog_is_simply_empty() {
        let tc = TestCore::new().await;
        let repo = TestRepo::new();
        repo.git(&["config", "core.logAllRefUpdates", "false"]);
        repo.commit_file("a.txt", "a\n", "Ohne Reflog");
        let id = tc.open(&repo).await.repo.id;
        let page = reflog_list(&tc, id, None, None, 100).await.unwrap();
        assert!(page.entries.is_empty());
        assert_eq!(page.next_cursor, None);
    }

    #[tokio::test]
    async fn reflog_messages_are_redacted() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let head = repo.head();
        let tree = format!("{head}^{{tree}}");
        let next = repo.git(&["commit-tree", "-p", &head, "-m", "Über das Netz", &tree]);
        repo.git(&["update-ref", "-m", "pull https://anna:geheim123@example.com/r.git: Fast-forward", "refs/heads/main", &next]);
        let id = tc.open(&repo).await.repo.id;

        let page = reflog_list(&tc, id, Some("refs/heads/main".into()), None, 10).await.unwrap();
        let entry = &page.entries[0];
        assert_eq!(entry.action, ReflogAction::Pull);
        assert!(entry.message.starts_with("pull https://"), "{}", entry.message);
        assert!(!entry.message.contains("geheim123"), "{}", entry.message);
    }

    #[tokio::test]
    async fn reftable_repositories_fall_back_to_git_log_g() {
        let repo = TestRepo::with_commit();
        let migrated = repo.git_output(&["refs", "migrate", "--ref-format=reftable"]);
        if !migrated.status.success() {
            eprintln!("skipped: this Git cannot migrate to reftable ({})", String::from_utf8_lossy(&migrated.stderr).trim());
            return;
        }
        let after = repo.commit_file("a.txt", "a\n", "Nach der Umstellung");
        let tc = TestCore::new().await;
        let id = tc.open(&repo).await.repo.id;
        let page = reflog_list(&tc, id, None, None, 100).await.unwrap();
        assert_eq!((page.entries[0].sha.as_str(), page.entries[0].action), (after.as_str(), ReflogAction::Commit));
        assert!(page.entries[0].time.starts_with("2026-01-01T"), "{}", page.entries[0].time);
        assert!(page.entries.iter().all(|e| e.exists));
    }
}
