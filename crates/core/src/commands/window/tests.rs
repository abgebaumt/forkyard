use std::future::Future;

use crate::commands::repos::{repo_open, tab_activate, tab_close, tab_open, tabs_list};
use crate::commands::settings::settings_set;
use crate::db;
use crate::error::ErrorCode;
use crate::model::{Tab, TabKind};
use crate::testkit::{TestCore, TestRepo};
use crate::watcher::{is_watching, set_enabled};
use crate::windowing;

const W: &str = "w-0123456789abcdef0123456789abcdef";

/// Runs `fut` as a call from window `label`.
async fn in_w<F: Future>(label: &str, fut: F) -> F::Output {
    windowing::scoped(label.to_string(), fut).await
}

fn add_window(tc: &TestCore) {
    tc.db
        .tx(|tx| {
            let profile_id = db::profiles::active_id(tx)?;
            db::windows::insert(tx, &profile_id, W, None)
        })
        .unwrap();
}

fn repo_tabs(tabs: &[Tab]) -> usize {
    tabs.iter().filter(|t| t.kind == TabKind::Repo).count()
}

fn path(repo: &TestRepo) -> String {
    repo.path().to_string_lossy().into_owned()
}

#[tokio::test]
async fn reopening_reuses_a_tab_only_in_the_same_window() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let t1 = tc.open(&repo).await.tab;
    add_window(&tc);
    let t2 = in_w(W, repo_open(&tc, path(&repo))).await.unwrap().tab;
    assert_ne!(t2.id, t1.id);
    assert_eq!(t2.window, W);
    let again = repo_open(&tc, path(&repo)).await.unwrap().tab;
    assert_eq!(again.id, t1.id);
    assert_eq!(repo_tabs(&tabs_list(&tc).await.unwrap()), 1);
    assert_eq!(repo_tabs(&in_w(W, tabs_list(&tc)).await.unwrap()), 1);
}

#[tokio::test]
async fn each_window_has_its_own_active_tab() {
    let tc = TestCore::new().await;
    let (r, s) = (TestRepo::with_commit(), TestRepo::with_commit());
    let r_id = tc.open(&r).await.repo.id;
    let s_id = tc.open(&s).await.repo.id;
    add_window(&tc);
    let mgmt = tab_open(&tc, None).await.unwrap().into_iter().find(|t| t.is_active).unwrap();
    assert_eq!(mgmt.kind, TabKind::Management);
    tab_open(&tc, Some(r_id.clone())).await.unwrap();
    let in_w_tabs = in_w(W, tab_open(&tc, Some(s_id.clone()))).await.unwrap();
    let w_active = in_w_tabs.iter().find(|t| t.is_active).unwrap().clone();
    assert_eq!(w_active.repo_id.as_deref(), Some(s_id.as_str()));

    let main = tab_activate(&tc, mgmt.id.clone()).await.unwrap();
    assert_eq!(main.iter().filter(|t| t.is_active).map(|t| t.id.as_str()).collect::<Vec<_>>(), vec![mgmt.id.as_str()]);
    let w_tabs = in_w(W, tabs_list(&tc)).await.unwrap();
    assert_eq!(w_tabs.iter().filter(|t| t.is_active).map(|t| t.id.as_str()).collect::<Vec<_>>(), vec![w_active.id.as_str()]);
}

#[tokio::test]
async fn tab_commands_do_not_reach_into_other_windows() {
    let tc = TestCore::new().await;
    tabs_list(&tc).await.unwrap();
    add_window(&tc);
    let w_tab = in_w(W, tabs_list(&tc)).await.unwrap().remove(0);
    assert_eq!(w_tab.window, W);
    assert_eq!(tab_close(&tc, w_tab.id.clone()).await.unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(tab_activate(&tc, w_tab.id.clone()).await.unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(crate::commands::repos::tab_move(&tc, w_tab.id.clone(), 0).await.unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(in_w(W, tabs_list(&tc)).await.unwrap(), vec![w_tab]);
}

#[tokio::test]
async fn watching_stops_only_when_no_window_shows_the_repo() {
    let tc = TestCore::new().await;
    set_enabled(&tc, true);
    let repo = TestRepo::with_commit();
    let opened = tc.open(&repo).await;
    add_window(&tc);
    let w_tab = in_w(W, repo_open(&tc, path(&repo))).await.unwrap().tab;
    assert!(is_watching(&tc, &opened.repo.id));
    tab_close(&tc, opened.tab.id).await.unwrap();
    assert!(is_watching(&tc, &opened.repo.id), "W still shows the repository");
    in_w(W, tab_close(&tc, w_tab.id)).await.unwrap();
    assert!(!is_watching(&tc, &opened.repo.id));
}

#[tokio::test]
async fn without_remember_tabs_only_main_survives_a_restart() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    tc.open(&repo).await;
    add_window(&tc);
    in_w(W, repo_open(&tc, path(&repo))).await.unwrap();
    settings_set(&tc, serde_json::json!({"rememberTabs": false})).await.unwrap();
    let tc = tc.restart().await;
    let (windows, tabs) = tc
        .db
        .with(|c| {
            let profile_id = db::profiles::active_id(c)?;
            Ok((db::windows::list(c, &profile_id)?, db::tabs::list_all(c, &profile_id)?))
        })
        .unwrap();
    assert_eq!(windows.into_iter().map(|w| w.label).collect::<Vec<_>>(), vec!["main"]);
    assert_eq!(
        tabs.iter().map(|t| (t.kind, t.window.as_str(), t.is_active)).collect::<Vec<_>>(),
        vec![(TabKind::Management, "main", true)]
    );
}
