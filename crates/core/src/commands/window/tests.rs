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

// --- Window commands and lifecycle -------------------------------------------

use super::*;
use crate::commands::app::{app_close_guard, app_quit, CloseGuard};
use crate::events::names;
use crate::model::{ScreenPoint, ScreenRect, StripReport, WindowFrameInput};

fn profile_id(tc: &TestCore) -> String {
    tc.db.with(db::profiles::active_id).unwrap()
}

fn window_labels(tc: &TestCore) -> Vec<String> {
    let profile_id = profile_id(tc);
    tc.db.with(|c| db::windows::list(c, &profile_id)).unwrap().into_iter().map(|w| w.label).collect()
}

fn synced_labels(tc: &TestCore) -> (Vec<String>, bool) {
    let (windows, place_existing) = tc.events.window_syncs().last().cloned().expect("a sync");
    (windows.into_iter().map(|w| w.label).collect(), place_existing)
}

fn app_changed_has(tc: &TestCore, what: &str) -> bool {
    tc.events.named(names::APP_CHANGED).iter().any(|v| v["what"].as_array().unwrap().iter().any(|w| w == what))
}

#[tokio::test]
async fn moving_a_tab_activates_it_in_the_target_and_closes_an_empty_source() {
    let tc = TestCore::new().await;
    let a = tabs_list(&tc).await.unwrap().remove(0);
    add_window(&tc);
    let b = in_w(W, tabs_list(&tc)).await.unwrap().remove(0);
    assert_eq!(tab_move_to_window(&tc, a.id.clone(), "w-gone".into(), 0).await.unwrap_err().code, ErrorCode::NotFound);
    tc.events.clear();

    let left = tab_move_to_window(&tc, a.id.clone(), W.into(), 0).await.unwrap();
    assert_eq!(left, vec![]);
    let w_tabs = in_w(W, tabs_list(&tc)).await.unwrap();
    assert_eq!(
        w_tabs.iter().map(|t| (t.id.as_str(), t.is_active)).collect::<Vec<_>>(),
        vec![(a.id.as_str(), true), (b.id.as_str(), false)]
    );
    assert_eq!(window_labels(&tc), vec![W]);
    assert_eq!(synced_labels(&tc).0, vec![W]);
    assert_eq!(tc.events.targeted(names::APP_FOCUS_REQUEST)[0].0, W);
    assert!(app_changed_has(&tc, "windows") && app_changed_has(&tc, "tabs"));
}

#[tokio::test]
async fn moving_within_the_own_window_reorders() {
    let tc = TestCore::new().await;
    let a = tabs_list(&tc).await.unwrap().remove(0);
    let b = tab_open(&tc, None).await.unwrap().remove(1);
    let tabs = tab_move_to_window(&tc, b.id.clone(), "main".into(), 0).await.unwrap();
    assert_eq!(tabs.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec![b.id.as_str(), a.id.as_str()]);
    assert!(tc.events.window_syncs().is_empty());
}

#[tokio::test]
async fn moving_the_active_tab_out_activates_its_right_neighbour() {
    let tc = TestCore::new().await;
    tabs_list(&tc).await.unwrap();
    tab_open(&tc, None).await.unwrap();
    let tabs = tab_open(&tc, None).await.unwrap();
    let [a, b, c] = [&tabs[0], &tabs[1], &tabs[2]].map(|t| t.id.clone());
    tab_activate(&tc, b.clone()).await.unwrap();
    add_window(&tc);
    let left = tab_move_to_window(&tc, b, W.into(), 9).await.unwrap();
    assert_eq!(left.iter().map(|t| (t.id.clone(), t.is_active)).collect::<Vec<_>>(), vec![(a, false), (c, true)]);
}

#[tokio::test]
async fn the_only_tab_cannot_be_torn_out() {
    let tc = TestCore::new().await;
    let a = tabs_list(&tc).await.unwrap().remove(0);
    assert_eq!(tab_move_to_new_window(&tc, a.id, None).await.unwrap_err().code, ErrorCode::NotAllowed);
    assert_eq!(window_labels(&tc), vec!["main"]);
}

#[tokio::test]
async fn tearing_out_creates_a_window_at_the_point() {
    let tc = TestCore::new().await;
    tabs_list(&tc).await.unwrap();
    let b = tab_open(&tc, None).await.unwrap().remove(1);
    let label = tab_move_to_new_window(&tc, b.id.clone(), Some(ScreenPoint { x: -1600.0, y: 40.0 })).await.unwrap();
    assert!(windowing::is_label(&label) && label != "main");
    let profile_id = profile_id(&tc);
    let rows = tc.db.with(|c| db::windows::list(c, &profile_id)).unwrap();
    let g = rows.iter().find(|w| w.label == label).unwrap().geometry.unwrap();
    assert_eq!((g.x, g.y, g.width, g.height, g.maximized), (-1600.0, 40.0, 1440.0, 900.0, false));
    let moved = tc.db.with(|c| db::tabs::require(c, &profile_id, &b.id)).unwrap();
    assert_eq!((moved.window.as_str(), moved.is_active), (label.as_str(), true));
    assert_eq!(synced_labels(&tc), (vec!["main".to_string(), label], false));
}

#[tokio::test]
async fn a_torn_out_window_takes_the_remembered_size() {
    let tc = TestCore::new().await;
    tabs_list(&tc).await.unwrap();
    let b = tab_open(&tc, None).await.unwrap().remove(1);
    note_geometry(&tc, "main", WindowGeometry { x: 10.0, y: 20.0, width: 1000.0, height: 700.0, maximized: true });
    let label = tab_move_to_new_window(&tc, b.id, None).await.unwrap();
    let profile_id = profile_id(&tc);
    let rows = tc.db.with(|c| db::windows::list(c, &profile_id)).unwrap();
    let g = rows.iter().find(|w| w.label == label).unwrap().geometry.unwrap();
    assert_eq!((g.width, g.height, g.maximized), (1000.0, 700.0, false));
    assert_eq!(rows[0].geometry, None, "note_geometry alone does not write");
    save_geometry(&tc, "main");
    let rows = tc.db.with(|c| db::windows::list(c, &profile_id)).unwrap();
    assert_eq!(rows[0].geometry.map(|g| (g.x, g.y)), Some((10.0, 20.0)));
}

#[tokio::test]
async fn a_handoff_is_taken_once_and_limited() {
    let tc = TestCore::new().await;
    let t = tabs_list(&tc).await.unwrap().remove(0);
    tab_handoff_put(&tc, t.id.clone(), "{\"old\":1}".into(), vec![]).await.unwrap();
    tab_handoff_put(&tc, t.id.clone(), "{\"view\":1}".into(), vec![]).await.unwrap();
    assert_eq!(tab_handoff_take(&tc, t.id.clone()).await.unwrap().as_deref(), Some("{\"view\":1}"));
    assert_eq!(tab_handoff_take(&tc, t.id.clone()).await.unwrap(), None);
    let err = tab_handoff_put(&tc, t.id.clone(), "x".repeat(4 * 1024 * 1024 + 1), vec![]).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    assert_eq!(tab_handoff_take(&tc, t.id).await.unwrap(), None);
}

#[tokio::test]
async fn layout_moves_strips_into_screen_coordinates_and_ranks_by_focus() {
    let tc = TestCore::new().await;
    add_window(&tc);
    let report = StripReport { strip: ScreenRect { x: 0.0, y: 0.0, width: 800.0, height: 36.0 }, tab_mids: vec![50.0, 150.0] };
    window_strip_report(&tc, Some(report.clone())).await.unwrap();
    in_w(W, window_strip_report(&tc, Some(report))).await.unwrap();
    note_focus(&tc, W);
    note_focus(&tc, "main");
    let frames = vec![
        WindowFrameInput { label: "main".into(), inner: Some(ScreenRect { x: 100.0, y: 200.0, width: 1000.0, height: 700.0 }) },
        WindowFrameInput { label: W.into(), inner: Some(ScreenRect { x: -1600.0, y: 0.0, width: 900.0, height: 600.0 }) },
        WindowFrameInput { label: "w-ffffffffffffffffffffffffffffffff".into(), inner: None },
    ];
    let layout = window_layout(&tc, frames, Some(ScreenPoint { x: -1500.0, y: 10.0 })).await.unwrap();
    assert!(layout.positions_known, "the frame without a row does not count");
    assert_eq!(layout.cursor, Some(ScreenPoint { x: -1500.0, y: 10.0 }));
    let got: Vec<_> = layout.frames.iter().map(|f| (f.label.as_str(), f.strip, f.tab_mids.clone(), f.focus_rank)).collect();
    assert_eq!(
        got,
        vec![
            ("main", Some(ScreenRect { x: 100.0, y: 200.0, width: 800.0, height: 36.0 }), vec![150.0, 250.0], 0),
            (W, Some(ScreenRect { x: -1600.0, y: 0.0, width: 800.0, height: 36.0 }), vec![-1550.0, -1450.0], 1),
        ]
    );

    window_strip_report(&tc, None).await.unwrap();
    let frames = vec![WindowFrameInput { label: "main".into(), inner: None }];
    let layout = window_layout(&tc, frames, None).await.unwrap();
    assert!(!layout.positions_known);
    assert_eq!((layout.frames[0].strip, layout.frames[0].tab_mids.len()), (None, 0));
}

#[tokio::test]
async fn window_list_and_window_new() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let opened = tc.open(&repo).await;
    let label = window_new(&tc).await.unwrap();
    assert!(windowing::is_label(&label) && label != "main");
    assert_eq!(synced_labels(&tc), (vec!["main".to_string(), label.clone()], false));
    note_focus(&tc, &label);
    let list = window_list(&tc).await.unwrap();
    let title = opened.tab.title.clone();
    assert_eq!(
        list,
        vec![
            WindowInfo { label: "main".into(), title, tabs: 1, focused: false },
            WindowInfo { label: label.clone(), title: String::new(), tabs: 1, focused: true },
        ]
    );
}

#[tokio::test]
async fn windows_closed_while_quitting_are_restored() {
    let tc = TestCore::new().await;
    tabs_list(&tc).await.unwrap();
    add_window(&tc);
    in_w(W, tabs_list(&tc)).await.unwrap();
    app_quit(&tc).await.unwrap();
    window_closed(&tc, W);
    window_closed(&tc, "main");
    assert_eq!(window_labels(&tc), vec!["main", W]);
    assert_eq!(restore(&tc).unwrap().len(), 2);
}

#[tokio::test]
async fn closing_a_window_drops_its_tabs_but_not_the_last_window() {
    let tc = TestCore::new().await;
    set_enabled(&tc, true);
    let repo = TestRepo::with_commit();
    let main_tab = tabs_list(&tc).await.unwrap().remove(0);
    add_window(&tc);
    let opened = in_w(W, repo_open(&tc, path(&repo))).await.unwrap();
    crate::commands::trust::repo_trust_set(&tc, opened.repo.id.clone(), true).await.unwrap();
    assert!(is_watching(&tc, &opened.repo.id));
    tc.events.clear();

    window_closed(&tc, W);
    assert_eq!(window_labels(&tc), vec!["main"]);
    let profile_id = profile_id(&tc);
    let all = tc.db.with(|c| db::tabs::list_all(c, &profile_id)).unwrap();
    assert_eq!(all.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec![main_tab.id.as_str()]);
    assert!(app_changed_has(&tc, "windows"));
    assert!(!is_watching(&tc, &opened.repo.id), "no window shows the repository any more");

    window_closed(&tc, "main");
    assert_eq!(window_labels(&tc), vec!["main"]);
    assert_eq!(tc.db.with(|c| db::tabs::list_all(c, &profile_id)).unwrap().len(), 1);
}

#[tokio::test]
async fn switching_profiles_swaps_the_windows() {
    use crate::commands::profiles::{profile_activate, profile_save};
    let tc = TestCore::new().await;
    let p1 = profile_id(&tc);
    tabs_list(&tc).await.unwrap();
    add_window(&tc);
    let list = profile_save(&tc, None, "Arbeit".into(), "".into(), "".into(), false, None).await.unwrap();
    let p2 = list.iter().find(|p| p.id != p1).unwrap().id.clone();

    profile_activate(&tc, p2).await.unwrap();
    assert_eq!(synced_labels(&tc), (vec!["main".to_string()], true));
    assert!(app_changed_has(&tc, "windows"));
    let p1_rows: Vec<String> = tc.db.with(|c| db::windows::list(c, &p1)).unwrap().into_iter().map(|w| w.label).collect();
    assert_eq!(p1_rows, vec!["main", W]);

    profile_activate(&tc, p1).await.unwrap();
    assert_eq!(synced_labels(&tc), (vec!["main".to_string(), W.to_string()], true));
}

#[tokio::test]
async fn repo_changes_reach_every_window() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    add_window(&tc);
    repo.write_file("neu.txt", "Inhalt");
    tc.events.clear();
    in_w(W, crate::commands::commit::commit_create(&tc, id, "op-w".into(), "Aus W".into(), String::new(), false, false, false, true, None))
        .await
        .unwrap();
    assert!(tc.events.targeted(names::REPO_CHANGED).is_empty());
    assert!(!tc.events.named(names::REPO_CHANGED).is_empty());
}

/// `main` closed while W stays: rows [W].
fn close_main(tc: &TestCore) {
    window_closed(tc, "main");
    assert_eq!(window_labels(tc), vec![W]);
}

#[tokio::test]
async fn a_start_without_main_and_without_remembered_tabs_keeps_one_window() {
    let tc = TestCore::new().await;
    tabs_list(&tc).await.unwrap();
    add_window(&tc);
    in_w(W, tabs_list(&tc)).await.unwrap();
    close_main(&tc);
    settings_set(&tc, serde_json::json!({"rememberTabs": false})).await.unwrap();
    let tc = tc.restart().await;
    assert_eq!(window_labels(&tc), vec!["main"]);
    assert_eq!(tabs_list(&tc).await.unwrap().len(), 1);
}

#[tokio::test]
async fn a_start_without_main_makes_the_first_window_main() {
    let tc = TestCore::new().await;
    tabs_list(&tc).await.unwrap();
    add_window(&tc);
    let w_tab = in_w(W, tabs_list(&tc)).await.unwrap().remove(0);
    close_main(&tc);
    let tc = tc.restart().await;
    assert_eq!(window_labels(&tc), vec!["main"]);
    assert_eq!(tabs_list(&tc).await.unwrap(), vec![Tab { window: "main".into(), ..w_tab }]);
}

#[tokio::test]
async fn forgetting_a_repository_does_not_rename_open_windows() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let opened = tc.open(&repo).await;
    add_window(&tc);
    let w_tab = in_w(W, tabs_list(&tc)).await.unwrap().remove(0);
    close_main(&tc);
    tc.db
        .tx(|tx| {
            let profile_id = db::profiles::active_id(tx)?;
            db::windows::insert(tx, &profile_id, "w-ffffffffffffffffffffffffffffffff", None)
        })
        .unwrap();
    in_w(W, crate::commands::repos::repo_forget(&tc, opened.repo.id)).await.unwrap();
    assert_eq!(window_labels(&tc), vec![W, "w-ffffffffffffffffffffffffffffffff"]);
    let w_tabs = in_w(W, tabs_list(&tc)).await.unwrap();
    assert_eq!(w_tabs.iter().map(|t| (t.id.as_str(), t.window.as_str())).collect::<Vec<_>>(), vec![(w_tab.id.as_str(), W)]);
}

#[tokio::test]
async fn calls_without_a_window_act_in_the_last_focused_one() {
    let tc = TestCore::new().await;
    tabs_list(&tc).await.unwrap();
    add_window(&tc);
    in_w(W, tabs_list(&tc)).await.unwrap();
    close_main(&tc);
    let tabs = tab_open(&tc, None).await.unwrap();
    assert!(tabs.iter().all(|t| t.window == W) && tabs.len() == 2, "no tab under a window without a row");
    note_focus(&tc, W);
    assert_eq!(calling_window(&tc), W);
    let later = "w-ffffffffffffffffffffffffffffffff";
    tc.db.tx(|tx| db::windows::insert(tx, &db::profiles::active_id(tx)?, later, None)).unwrap();
    assert_eq!(calling_window(&tc), W);
    note_focus(&tc, later);
    assert_eq!(calling_window(&tc), later, "focus beats position");
}

/// A job started from `label` (`None`: in the background) that ends once it is cancelled, as a real one does.
async fn job_in(tc: &TestCore, label: Option<&str>, id: &str) -> tokio::task::JoinHandle<()> {
    let job = match label {
        Some(label) => in_w(label, async { tc.start_job(id, None) }).await,
        None => tc.start_job(id, None),
    }
    .unwrap();
    tokio::spawn(async move {
        job.token().cancelled().await;
        job.finish::<()>(&Err(crate::error::CoreError::cancelled()));
    })
}

#[tokio::test]
async fn closing_a_window_cancels_only_the_jobs_it_started() {
    let tc = TestCore::new().await;
    add_window(&tc);
    let a = job_in(&tc, Some("main"), "a").await;
    let background = job_in(&tc, None, "bg").await;
    let b = job_in(&tc, Some(W), "b").await;
    in_w("main", app_close_guard(&tc, true)).await.unwrap();
    in_w(W, app_close_guard(&tc, true)).await.unwrap();

    assert!(!in_w(W, window_close(&tc)).await.unwrap());
    assert!(!tc.jobs.is_running("b"), "W's job stopped before the window closes");
    assert!(tc.jobs.is_running("a") && tc.jobs.is_running("bg"));
    b.await.unwrap();
    let guard = tc.state::<CloseGuard>();
    assert!(guard.closing(W) && !guard.intercept(W), "W closes without asking again");
    assert!(!guard.closing("main") && guard.intercept("main") && !guard.quitting());
    tc.jobs.cancel_all();
    a.await.unwrap();
    background.await.unwrap();
}

#[tokio::test]
async fn closing_the_last_window_quits() {
    let tc = TestCore::new().await;
    let a = job_in(&tc, Some("main"), "a").await;
    let background = job_in(&tc, None, "bg").await;
    assert!(in_w("main", window_close(&tc)).await.unwrap());
    assert_eq!(tc.jobs.running(), 0);
    a.await.unwrap();
    background.await.unwrap();
    assert!(tc.state::<CloseGuard>().quitting());
}

#[tokio::test]
async fn a_closing_window_is_no_target() {
    let tc = TestCore::new().await;
    let a = tabs_list(&tc).await.unwrap().remove(0);
    add_window(&tc);
    in_w(W, tabs_list(&tc)).await.unwrap();
    assert!(!in_w(W, window_close(&tc)).await.unwrap());

    assert_eq!(window_list(&tc).await.unwrap().iter().map(|w| w.label.as_str()).collect::<Vec<_>>(), vec!["main"]);
    let rect = Some(ScreenRect { x: 0.0, y: 0.0, width: 800.0, height: 600.0 });
    let frames = vec![WindowFrameInput { label: "main".into(), inner: rect }, WindowFrameInput { label: W.into(), inner: rect }];
    let layout = window_layout(&tc, frames, None).await.unwrap();
    assert_eq!(layout.frames.iter().map(|f| f.label.as_str()).collect::<Vec<_>>(), vec!["main"]);
    assert_eq!(tab_move_to_window(&tc, a.id.clone(), W.into(), 0).await.unwrap_err().code, ErrorCode::NotAllowed);
    assert_eq!(tabs_list(&tc).await.unwrap().iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec![a.id.as_str()]);
}

#[tokio::test]
async fn switching_profiles_is_refused_while_another_window_has_unsaved_work() {
    use crate::commands::profiles::{profile_activate, profile_save};
    let tc = TestCore::new().await;
    let p1 = profile_id(&tc);
    tabs_list(&tc).await.unwrap();
    add_window(&tc);
    let list = profile_save(&tc, None, "Arbeit".into(), "".into(), "".into(), false, None).await.unwrap();
    let p2 = list.iter().find(|p| p.id != p1).unwrap().id.clone();

    in_w(W, app_close_guard(&tc, true)).await.unwrap();
    let err = in_w("main", profile_activate(&tc, p2.clone())).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    assert_eq!(profile_id(&tc), p1, "still the old profile");
    assert_eq!(window_labels(&tc), vec!["main", W]);

    // The calling window's own unsaved work is the UI's to ask about.
    in_w(W, app_close_guard(&tc, false)).await.unwrap();
    in_w("main", app_close_guard(&tc, true)).await.unwrap();
    in_w("main", profile_activate(&tc, p2.clone())).await.unwrap();
    assert_eq!(profile_id(&tc), p2);
}

#[tokio::test]
async fn a_window_closing_in_the_background_does_not_count_as_the_one_that_stays() {
    let tc = TestCore::new().await;
    tabs_list(&tc).await.unwrap();
    add_window(&tc);
    in_w(W, tabs_list(&tc)).await.unwrap();
    let guard = tc.state::<CloseGuard>();

    // W hides while its jobs stop; then main closes: main is the window to restore, not W.
    guard.set_closing(W);
    window_closed(&tc, "main");
    window_closed(&tc, W);
    assert_eq!(window_labels(&tc), vec!["main"]);

    // The same while quitting: main closing as the only window counted quits the app.
    add_window(&tc);
    in_w(W, tabs_list(&tc)).await.unwrap();
    guard.set_closing(W);
    assert!(in_w("main", window_close(&tc)).await.unwrap(), "main counts as the only window");
    window_closed(&tc, W);
    window_closed(&tc, "main");
    assert_eq!(window_labels(&tc), vec!["main"]);
}
