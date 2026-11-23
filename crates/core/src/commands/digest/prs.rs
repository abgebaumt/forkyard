//! The pull request part of the digest: pull requests active, merged or closed in the window, and
//! new comments by others on the user's own open pull requests. Never an error: without a
//! connection the digest names the host instead.

use chrono::{DateTime, Utc};

use crate::app::Core;
use crate::commands::host as host_cmd;
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
}

/// The pull requests since `since`.
pub(crate) async fn pr_part(core: &Core, repo_id: &str, since: DateTime<Utc>) -> PrPart {
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
        match host_cmd::pr_list_lean(core, repo_id, PrListState::All, page, &found.remote).await {
            Ok(list) => {
                // Sorted by update except on Azure: a page ending before the window ends the list.
                let past = kind != HostKind::AzureDevops && list.items.last().is_some_and(|pr| !after(&pr.updated_at, since));
                prs.extend(list.items);
                if list.next_page.is_none() || past {
                    break;
                }
            }
            Err(e) => {
                log::info!("Digest without PR data: {}", e.message);
                return missing(kind);
            }
        }
    }

    let mut changed: Vec<DigestPr> = prs
        .iter()
        .filter_map(|pr| {
            // `updated_at` also moves with a later comment, so an open PR can only be "active".
            if !after(&pr.updated_at, since) {
                return None;
            }
            let change = match pr.state {
                PrState::Open => DigestPrChange::Updated,
                PrState::Merged => DigestPrChange::Merged,
                PrState::Closed => DigestPrChange::Closed,
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
    changed.sort_by_key(|pr| (pr.change != DigestPrChange::Updated, std::cmp::Reverse(pr.number)));

    let mut comments = Vec::new();
    if let Some(login) = account.login.as_deref() {
        let is_me = |author: Option<&str>| author.is_some_and(|a| a.eq_ignore_ascii_case(login));
        let own = prs
            .iter()
            .filter(|pr| pr.state == PrState::Open && is_me(pr.author.as_ref().map(|a| a.login.as_str())) && after(&pr.updated_at, since))
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
                .filter(|c| after(&c.created_at, since) && !is_me(c.author.as_ref().map(|a| a.login.as_str())))
                .count() as u32;
            if count > 0 {
                comments.push(DigestPrComments { number: pr.number, title: pr.title.clone(), count });
            }
        }
        comments.sort_by_key(|c| c.number);
    }
    PrPart { prs: Some(DigestPrs { changed, comments }), missing: None }
}

/// `at` is later than `since`; an unreadable time is not.
fn after(at: &str, since: DateTime<Utc>) -> bool {
    DateTime::parse_from_rfc3339(at).is_ok_and(|at| at > since)
}
