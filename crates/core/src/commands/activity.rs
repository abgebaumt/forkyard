//! Activity log.

use crate::app::Core;
use crate::db;
use crate::error::CoreResult;
use crate::model::{ActivityPage, ActivityScope};

/// Paged, newest first. `cursor` comes from `ActivityPage.next_cursor` of the previous page.
/// With `scope: Repo`, `repo_id` filters to one repository (without it: all repositories).
pub async fn activity_list(
    core: &Core,
    scope: ActivityScope,
    repo_id: Option<String>,
    cursor: Option<String>,
    limit: u32,
) -> CoreResult<ActivityPage> {
    let repo_filter = match scope {
        ActivityScope::App => None,
        ActivityScope::Repo => repo_id.as_deref(),
    };
    core.db.with(|c| db::activity::page(c, scope, repo_filter, cursor.as_deref(), limit))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorCode;
    use crate::testkit::{TestCore, TestRepo};

    #[tokio::test]
    async fn pages_by_scope_and_cursor() {
        let tc = TestCore::new().await;
        let repo = TestRepo::with_commit();
        let id = tc.open(&repo).await.repo.id;
        // repo_open logs rev-parse in the app log (the repo was not registered yet).
        let app = activity_list(&tc, ActivityScope::App, None, None, 50).await.unwrap();
        assert!(app.entries.iter().any(|e| e.command.starts_with("git rev-parse")), "{:?}", app.entries);
        assert!(app.entries.iter().all(|e| e.repo_id.is_none() && e.scope == ActivityScope::App));

        for i in 0..5 {
            tc.git_for(&id).unwrap().args(["rev-parse", "HEAD"]).read_only().run().await.unwrap();
            let _ = i;
        }
        let _ = tc.git_for(&id).unwrap().args(["rev-parse", "--verify", "gibt-es-nicht"]).run().await;

        let first = activity_list(&tc, ActivityScope::Repo, Some(id.clone()), None, 4).await.unwrap();
        assert_eq!(first.entries.len(), 4);
        assert!(first.entries[0].exit_code.unwrap_or(0) != 0, "newest entry first");
        assert!(first.entries[0].output.contains("gibt-es-nicht") || !first.entries[0].output.is_empty());
        assert_eq!(first.entries[1].exit_code, Some(0));
        assert!(first.entries.iter().all(|e| e.repo_id.as_deref() == Some(id.as_str())));
        let cursor = first.next_cursor.clone().unwrap();
        let second = activity_list(&tc, ActivityScope::Repo, Some(id.clone()), Some(cursor), 4).await.unwrap();
        assert_eq!(second.entries.len(), 2);
        assert!(second.next_cursor.is_none());
        let ids: Vec<i64> = first.entries.iter().chain(second.entries.iter()).map(|e| e.id.parse().unwrap()).collect();
        assert!(ids.windows(2).all(|w| w[0] > w[1]));

        let err = activity_list(&tc, ActivityScope::Repo, None, Some("kaputt".into()), 10).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed);
    }

    #[tokio::test]
    async fn cleanup_removes_old_entries() {
        let tc = TestCore::new().await;
        tc.db
            .with(|c| {
                c.execute(
                    "insert into activity_log (scope, description, command, started_at) values ('application', 'alt', 'git alt', '2000-01-01T00:00:00.000Z')",
                    [],
                )?;
                Ok(())
            })
            .unwrap();
        tc.startup_cleanup().await.unwrap();
        let page = activity_list(&tc, ActivityScope::App, None, None, 100).await.unwrap();
        assert!(page.entries.iter().all(|e| e.command != "git alt"));
    }
}
