//! Confirmations before sending (Grundregel 4): the first use of every function (globally), more
//! than 100 000 characters, an estimated cost above the threshold, the first content of a
//! repository for an external provider, and the monthly limit (spec 1.5). Local providers skip
//! the first two kinds of "first time". Given confirmations are remembered in `ai_preview_seen`
//! ("first use" and "repository" always, "large"/"cost" only with "Don't ask again", the limit
//! never). Every confirmation also approves exactly this text (prompt fingerprint) for one request
//! within 10 minutes; `require` lets a request through only if all its pending triggers are
//! approved, and uses the approval up.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use parking_lot::Mutex;

use crate::app::Core;
use crate::db;
use crate::error::{CoreError, CoreResult};
use crate::model::{AiAskTrigger, AiFeature, Settings};

pub const LARGE_CHARS: u64 = 100_000;
const APPROVAL_TTL: Duration = Duration::from_secs(600);

/// What a request is about to send.
#[derive(Debug, Clone, Copy)]
pub struct Situation<'a> {
    pub repo_id: Option<&'a str>,
    pub feature: AiFeature,
    pub chars: u64,
    pub estimated_cost_usd: Option<f64>,
    pub local: bool,
    pub limit_reached: bool,
}

fn ask_key(trigger: AiAskTrigger, feature: AiFeature) -> String {
    match trigger {
        AiAskTrigger::FirstUse => format!("first_use:{}", feature.as_str()),
        AiAskTrigger::Large => "large".to_string(),
        AiAskTrigger::Cost => "cost".to_string(),
        AiAskTrigger::RepoFirst => "repo_first".to_string(),
        AiAskTrigger::Limit => "limit".to_string(),
    }
}

/// The triggers that ask for this request, in a fixed order.
pub fn pending(core: &Core, settings: &Settings, situation: &Situation<'_>) -> CoreResult<Vec<AiAskTrigger>> {
    core.db.with(|c| {
        let mut asks = Vec::new();
        if !situation.local && !db::ai::seen(c, None, &ask_key(AiAskTrigger::FirstUse, situation.feature))? {
            asks.push(AiAskTrigger::FirstUse);
        }
        if situation.chars > LARGE_CHARS && !db::ai::seen(c, None, "large")? {
            asks.push(AiAskTrigger::Large);
        }
        if situation.estimated_cost_usd.is_some_and(|cost| cost > settings.ai_confirm_cost_usd) && !db::ai::seen(c, None, "cost")? {
            asks.push(AiAskTrigger::Cost);
        }
        if let (false, Some(repo_id)) = (situation.local, situation.repo_id) {
            if !db::ai::seen(c, Some(repo_id), "repo_first")? {
                asks.push(AiAskTrigger::RepoFirst);
            }
        }
        if situation.limit_reached {
            asks.push(AiAskTrigger::Limit);
        }
        Ok(asks)
    })
}

#[derive(Default)]
struct Approvals {
    map: Mutex<HashMap<String, (Instant, Vec<AiAskTrigger>)>>,
}

/// "Send" in the preview dialog.
pub fn confirm(core: &Core, repo_id: Option<&str>, feature: AiFeature, fingerprint: &str, triggers: &[AiAskTrigger], dont_ask_again: bool) -> CoreResult<()> {
    core.db.tx(|tx| {
        for trigger in triggers {
            match trigger {
                AiAskTrigger::FirstUse => db::ai::mark_seen(tx, None, &ask_key(*trigger, feature))?,
                AiAskTrigger::RepoFirst => {
                    if let Some(repo_id) = repo_id {
                        db::ai::mark_seen(tx, Some(repo_id), "repo_first")?;
                    }
                }
                AiAskTrigger::Large | AiAskTrigger::Cost if dont_ask_again => db::ai::mark_seen(tx, None, &ask_key(*trigger, feature))?,
                _ => {}
            }
        }
        Ok(())
    })?;
    let state = core.state::<Approvals>();
    let mut map = state.map.lock();
    map.retain(|_, (at, _)| at.elapsed() < APPROVAL_TTL);
    map.insert(fingerprint.to_string(), (Instant::now(), triggers.to_vec()));
    Ok(())
}

/// `Ok` if every pending trigger is approved for this text; the limit gives `ai_limit_reached`,
/// everything else `not_allowed`. An approval lets exactly one request through: it is used up
/// here, so "Send this time" (limit) and a "large"/"cost" confirmation without "Don't ask again"
/// ask again before the next request, even for the same text (spec 1.5, Grundregel 4).
pub fn require(core: &Core, fingerprint: &str, pending: &[AiAskTrigger], spent_usd: f64, limit_usd: Option<f64>) -> CoreResult<()> {
    if pending.is_empty() {
        return Ok(());
    }
    let state = core.state::<Approvals>();
    let mut map = state.map.lock();
    let approved: Vec<AiAskTrigger> =
        map.get(fingerprint).filter(|(at, _)| at.elapsed() < APPROVAL_TTL).map(|(_, triggers)| triggers.clone()).unwrap_or_default();
    let missing: Vec<AiAskTrigger> = pending.iter().copied().filter(|trigger| !approved.contains(trigger)).collect();
    if missing.is_empty() {
        map.remove(fingerprint);
        return Ok(());
    }
    drop(map);
    if missing.contains(&AiAskTrigger::Limit) {
        return Err(CoreError::ai_limit_reached(spent_usd, limit_usd.unwrap_or(0.0)));
    }
    Err(CoreError::not_allowed("Before this request goes out, confirm what is sent (“What is sent?”)."))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use crate::model::AiAskTrigger::{Cost, FirstUse, Large, RepoFirst};
    use crate::testkit::TestCore;

    #[tokio::test]
    async fn large_and_cost_are_remembered_only_when_asked_to() {
        let tc = TestCore::new().await;
        let settings = Settings { ai_confirm_cost_usd: 0.05, ..Settings::default() };
        let base = Situation { repo_id: None, feature: AiFeature::Compose, chars: 100, estimated_cost_usd: Some(0.01), local: true, limit_reached: false };
        assert!(pending(&tc, &settings, &base).unwrap().is_empty());
        assert!(pending(&tc, &settings, &Situation { chars: LARGE_CHARS, ..base }).unwrap().is_empty(), "exactly 100 000 characters do not ask");
        assert_eq!(pending(&tc, &settings, &Situation { chars: LARGE_CHARS + 1, ..base }).unwrap(), vec![Large]);
        assert!(pending(&tc, &settings, &Situation { estimated_cost_usd: Some(0.05), ..base }).unwrap().is_empty(), "the threshold itself does not ask");
        assert_eq!(pending(&tc, &settings, &Situation { estimated_cost_usd: Some(0.0501), ..base }).unwrap(), vec![Cost]);
        assert!(pending(&tc, &settings, &Situation { estimated_cost_usd: None, ..base }).unwrap().is_empty(), "unknown price: no cost question");

        let big = Situation { chars: 250_000, estimated_cost_usd: Some(0.2), ..base };
        confirm(&tc, None, AiFeature::Compose, "fp-1", &[Large, Cost], false).unwrap();
        assert_eq!(pending(&tc, &settings, &big).unwrap(), vec![Large, Cost], "without “Don't ask again” it asks next time");
        assert!(require(&tc, "fp-1", &[Large, Cost], 0.0, None).is_ok(), "but exactly this text is approved");
        assert_eq!(require(&tc, "fp-1", &[Large, Cost], 0.0, None).unwrap_err().code, ErrorCode::NotAllowed, "an approval lets one request through, not two");
        assert_eq!(require(&tc, "fp-2", &[Large], 0.0, None).unwrap_err().code, ErrorCode::NotAllowed, "another text is not");
        confirm(&tc, None, AiFeature::Compose, "fp-3", &[Large, Cost], true).unwrap();
        assert!(pending(&tc, &settings, &big).unwrap().is_empty());
        assert_eq!(tc.db.with(crate::db::ai::reset_seen).unwrap(), 2, "“Ask again everywhere”");
        assert_eq!(pending(&tc, &settings, &big).unwrap(), vec![Large, Cost]);
    }

    #[tokio::test]
    async fn first_use_is_per_function_and_repo_first_per_repository() {
        let tc = TestCore::new().await;
        let repo = crate::testkit::TestRepo::with_commit();
        let id = tc.open(&repo).await.repo.id;
        let settings = Settings::default();
        let api = Situation { repo_id: Some(&id), feature: AiFeature::CommitMessage, chars: 100, estimated_cost_usd: Some(0.001), local: false, limit_reached: false };
        assert_eq!(pending(&tc, &settings, &api).unwrap(), vec![FirstUse, RepoFirst]);
        assert!(pending(&tc, &settings, &Situation { local: true, ..api }).unwrap().is_empty(), "local providers skip both (Grundregel 4)");
        confirm(&tc, Some(&id), AiFeature::CommitMessage, "fp", &[FirstUse, RepoFirst], false).unwrap();
        assert!(pending(&tc, &settings, &api).unwrap().is_empty(), "both are remembered once given");
        assert_eq!(pending(&tc, &settings, &Situation { feature: AiFeature::PrDescription, ..api }).unwrap(), vec![FirstUse]);
        assert_eq!(pending(&tc, &settings, &Situation { repo_id: None, ..api }).unwrap(), Vec::<AiAskTrigger>::new());
    }
}
