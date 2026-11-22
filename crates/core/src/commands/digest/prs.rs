//! The pull request part of the digest: opened, merged and closed pull requests since the seen
//! state, and new comments by others on the user's own open pull requests. Never an error: without
//! a connection the digest names the host instead.

use crate::app::Core;
use crate::commands::host as host_cmd;
use crate::db::repo_seen::SeenRow;
use crate::host;
use crate::model::{DigestPr, DigestPrChange, DigestPrComments, DigestPrs, HostKind, PrListState, PrState, PrSummary};

/// Pages of 100 read from the PR list.
const PAGES: u32 = 2;
/// Own open pull requests whose comments are read.
const OWN_PRS: usize = 10;

/// What the host adds to a digest.
#[derive(Default)]
pub(crate) struct PrPart {
    pub prs: Option<DigestPrs>,
    /// The host whose data is missing.
    pub missing: Option<HostKind>,
    /// Highest PR number read.
    pub max: Option<u64>,
    /// Numbers of the open PRs read, ascending; `None` without PR data.
    pub open: Option<Vec<u64>>,
}

/// The pull requests since `seen`.
pub(crate) async fn pr_part(core: &Core, repo_id: &str, seen: &SeenRow) -> PrPart {
    let missing = |kind| PrPart { missing: Some(kind), ..PrPart::default() };
    let found = match host::resolve(core, repo_id, None).await {
        Ok(Some(found)) => found,
        Ok(None) => return PrPart::default(),
        Err(e) => {
            log::info!("Digest without PR data: {}", e.message);
            return PrPart::default();
        }
    };
    let kind = found.detected.kind;
    let Some(account) = &found.detected.account else {
        return missing(kind);
    };
    let remote = Some(found.remote.clone());
    let mut prs: Vec<PrSummary> = Vec::new();
    for page in 1..=PAGES {
        match host_cmd::pr_list(core, repo_id.to_string(), PrListState::All, Some(page), Some(100), remote.clone()).await {
            Ok(list) => {
                prs.extend(list.items);
                if list.next_page.is_none() {
                    break;
                }
            }
            Err(e) => {
                log::info!("Digest without PR data: {}", e.message);
                return missing(kind);
            }
        }
    }
    let max = prs.iter().map(|pr| pr.number).max();

    let mut changed: Vec<DigestPr> = prs
        .iter()
        .filter_map(|pr| {
            // PR numbers rise on every host; `PrSummary` has no creation date. `updated_at` moves
            // with every later comment, so only a PR open at the last look can have ended since.
            let new = seen.pr_max_number.is_some_and(|m| pr.number > m);
            if !new && !seen.pr_open.contains(&pr.number) {
                return None;
            }
            let change = match pr.state {
                PrState::Open if new => DigestPrChange::Opened,
                PrState::Merged => DigestPrChange::Merged,
                PrState::Closed => DigestPrChange::Closed,
                _ => return None,
            };
            Some(DigestPr {
                number: pr.number,
                title: pr.title.clone(),
                change,
                author: pr.author.as_ref().map(|a| a.login.clone()),
                web_url: pr.web_url.clone(),
            })
        })
        .collect();
    changed.sort_by_key(|pr| (pr.change != DigestPrChange::Opened, std::cmp::Reverse(pr.number)));

    let mut comments = Vec::new();
    if let Some(login) = account.login.as_deref() {
        let is_me = |author: Option<&str>| author.is_some_and(|a| a.eq_ignore_ascii_case(login));
        let own = prs
            .iter()
            .filter(|pr| {
                pr.state == PrState::Open && is_me(pr.author.as_ref().map(|a| a.login.as_str())) && after(&pr.updated_at, &seen.seen_at)
            })
            .take(OWN_PRS);
        for pr in own {
            let details = match host_cmd::pr_get(core, repo_id.to_string(), pr.number, remote.clone()).await {
                Ok(details) => details,
                Err(e) => {
                    log::info!("Digest without PR data: {}", e.message);
                    return missing(kind);
                }
            };
            let count = details
                .comments
                .iter()
                .filter(|c| after(&c.created_at, &seen.seen_at) && !is_me(c.author.as_ref().map(|a| a.login.as_str())))
                .count() as u32;
            if count > 0 {
                comments.push(DigestPrComments { number: pr.number, title: pr.title.clone(), count });
            }
        }
        comments.sort_by_key(|c| c.number);
    }
    // Open ones beyond the pages read stay as they were: unknown is not ended.
    let unread = seen.pr_open.iter().copied().filter(|n| !prs.iter().any(|pr| pr.number == *n));
    let mut open: Vec<u64> = prs.iter().filter(|pr| pr.state == PrState::Open).map(|pr| pr.number).chain(unread).collect();
    open.sort_unstable();
    PrPart { prs: Some(DigestPrs { changed, comments }), missing: None, max, open: Some(open) }
}

/// `at` is later than `since`; an unreadable time is not.
fn after(at: &str, since: &str) -> bool {
    let parse = chrono::DateTime::parse_from_rfc3339;
    matches!((parse(at), parse(since)), (Ok(at), Ok(since)) if at > since)
}
