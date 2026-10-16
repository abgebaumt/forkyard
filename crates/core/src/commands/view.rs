//! View state per repository and commit drafts (F01, F03).

use serde_json::Value;

use crate::app::Core;
use crate::commands::graph::is_full_sha;
use crate::db;
use crate::error::{CoreError, CoreResult};
use crate::model::{CommitDraft, RepoViewState};
use crate::util;

/// Upper limit for `collapsedMerges` ("collapse all" over many loaded pages stays well below).
const MAX_COLLAPSED_MERGES: usize = 50_000;

pub async fn view_state_get(core: &Core, repo_id: String) -> CoreResult<RepoViewState> {
    core.db.with(|c| {
        db::repos::require(c, &repo_id)?;
        db::view_state::get(c, &repo_id)
    })
}

/// Changes only the fields passed in (`Partial<RepoViewState>`).
pub async fn view_state_set(core: &Core, repo_id: String, patch: Value) -> CoreResult<RepoViewState> {
    core.db.tx(|tx| {
        db::repos::require(tx, &repo_id)?;
        let current = db::view_state::get(tx, &repo_id)?;
        let (mut next, _) = util::apply_patch(&current, &patch, "View")?;
        dedup(&mut next.hidden_refs);
        dedup(&mut next.solo_refs);
        dedup(&mut next.pinned_refs);
        dedup(&mut next.collapsed_folders);
        dedup(&mut next.collapsed_merges);
        check_collapsed(&next.collapsed_merges)?;
        db::view_state::set(tx, &repo_id, &next)?;
        Ok(next)
    })
}

/// Only full commit SHAs: the graph compares them with the SHAs of its rows.
fn check_collapsed(list: &[String]) -> CoreResult<()> {
    if list.len() > MAX_COLLAPSED_MERGES {
        return Err(CoreError::not_allowed(format!("View: at most {MAX_COLLAPSED_MERGES} collapsed merges.")));
    }
    match list.iter().find(|sha| !is_full_sha(sha)) {
        Some(bad) => {
            let shown: String = bad.chars().filter(|c| !c.is_control()).take(80).collect();
            Err(CoreError::not_allowed(format!("View: “{shown}” is not a full commit SHA.")))
        }
        None => Ok(()),
    }
}

fn dedup(list: &mut Vec<String>) {
    let mut seen = std::collections::HashSet::new();
    list.retain(|s| seen.insert(s.clone()));
}

/// Draft of the main working directory (empty if none is saved).
pub async fn draft_get(core: &Core, repo_id: String) -> CoreResult<CommitDraft> {
    core.db.with(|c| {
        db::repos::require(c, &repo_id)?;
        db::drafts::get(c, &repo_id, "")
    })
}

pub async fn draft_set(core: &Core, repo_id: String, draft: CommitDraft) -> CoreResult<()> {
    core.db.with(|c| {
        db::repos::require(c, &repo_id)?;
        db::drafts::set(c, &repo_id, "", &draft)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use crate::model::{GraphColumnId, SectionId};
    use crate::testkit::{TestCore, TestRepo};
    use serde_json::json;

    #[tokio::test]
    async fn view_state_defaults_and_patch() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let id = tc.open(&repo).await.repo.id;

        let state = view_state_get(&tc, id.clone()).await.unwrap();
        assert_eq!(state, RepoViewState::default());
        assert_eq!(state.columns.len(), 6);
        let ids: Vec<SectionId> = state.sections.iter().map(|s| s.id).collect();
        assert_eq!(ids, vec![SectionId::Local, SectionId::Remote, SectionId::Tags, SectionId::Stashes, SectionId::Worktrees, SectionId::Submodules, SectionId::Agents]);

        let next = view_state_set(&tc, id.clone(), json!({"hiddenRefs": ["refs/heads/a", "refs/heads/a"], "soloRefs": ["refs/heads/main"]}))
            .await
            .unwrap();
        assert_eq!(next.hidden_refs, vec!["refs/heads/a"]);
        assert_eq!(next.solo_refs, vec!["refs/heads/main"]);
        assert_eq!(next.columns, RepoViewState::default().columns);

        let cols = json!([{"id":"sha","visible":true,"width":80},{"id":"graph","visible":true,"width":null}]);
        let next = view_state_set(&tc, id.clone(), json!({"columns": cols, "sections": [{"id":"tags","collapsed":true,"hidden":false}]}))
            .await
            .unwrap();
        assert_eq!(next.columns[0].id, GraphColumnId::Sha);
        assert_eq!(next.columns[0].width, Some(80));
        assert_eq!(next.sections[0].id, SectionId::Tags);
        assert_eq!(next.hidden_refs, vec!["refs/heads/a"]);

        // Persists after reading.
        assert_eq!(view_state_get(&tc, id.clone()).await.unwrap(), next);

        let err = view_state_set(&tc, id.clone(), json!({"unbekannt": 1})).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
        let err = view_state_set(&tc, id.clone(), json!({"hiddenRefs": "kein Array"})).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
        let err = view_state_get(&tc, "unbekannt".into()).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn drafts_roundtrip() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let id = tc.open(&repo).await.repo.id;
        assert_eq!(draft_get(&tc, id.clone()).await.unwrap(), CommitDraft::default());
        let draft = CommitDraft { summary: "Fix: Umlaute äöü".into(), description: "Zeile 1\nZeile 2".into(), amend: true };
        draft_set(&tc, id.clone(), draft.clone()).await.unwrap();
        assert_eq!(draft_get(&tc, id.clone()).await.unwrap(), draft);
        draft_set(&tc, id.clone(), CommitDraft::default()).await.unwrap();
        assert_eq!(draft_get(&tc, id.clone()).await.unwrap(), CommitDraft::default());
        let err = draft_set(&tc, "unbekannt".into(), draft).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotFound);
    }

    #[tokio::test]
    async fn collapsed_merges_are_stored_deduplicated_and_validated() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let sha = repo.head();
        let id = tc.open(&repo).await.repo.id;

        let state = view_state_get(&tc, id.clone()).await.unwrap();
        assert!(state.collapsed_merges.is_empty());
        assert!(!state.collapse_all_merges);

        let next = view_state_set(&tc, id.clone(), json!({"collapsedMerges": [&sha, &sha], "collapseAllMerges": true})).await.unwrap();
        assert_eq!(next.collapsed_merges, vec![sha.clone()]);
        assert!(next.collapse_all_merges);
        assert_eq!(view_state_get(&tc, id.clone()).await.unwrap(), next);

        let err = view_state_set(&tc, id.clone(), json!({"collapsedMerges": ["main"]})).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
        let err = view_state_set(&tc, id.clone(), json!({"collapseAllMerges": "ja"})).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
        // A rejected patch changes nothing.
        assert_eq!(view_state_get(&tc, id.clone()).await.unwrap(), next);
    }
}
