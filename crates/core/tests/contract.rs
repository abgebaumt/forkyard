//! Integration test from the outside: checks that the feature `testkit` is enabled for tests
//! under tests/, and that commands return futures that are `Send` (a requirement of Tauri).

use gitcore::commands;
use gitcore::model::{ActivityScope, TabKind};
use gitcore::testkit::{TestCore, TestRepo};

fn assert_send<T: Send>(value: T) -> T {
    value
}

#[tokio::test]
async fn open_repo_through_public_api() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let opened = assert_send(commands::repos::repo_open(&tc, repo.path().to_string_lossy().into_owned())).await.unwrap();
    assert_eq!(opened.tab.kind, TabKind::Repo);
    let tabs = assert_send(commands::repos::tabs_list(&tc)).await.unwrap();
    assert_eq!(tabs.len(), 1);
    let page = assert_send(commands::activity::activity_list(&tc, ActivityScope::App, None, None, 10)).await.unwrap();
    assert!(!page.entries.is_empty());
    let settings = assert_send(commands::settings::settings_get(&tc)).await.unwrap();
    assert_eq!(settings.default_branch_name, "main");
    let status = assert_send(commands::status::status_get(&tc, opened.repo.id.clone())).await.unwrap();
    assert!(status.unstaged.is_empty() && status.staged.is_empty());
    let refs = assert_send(commands::refs::refs_list(&tc, opened.repo.id.clone())).await.unwrap();
    assert_eq!(refs.locals.len(), 1);
    assert_eq!(refs.head, status.head);
}
