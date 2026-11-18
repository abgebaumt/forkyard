use super::*;
use crate::error::ErrorCode;
use crate::events::names;

use crate::commands::settings::{settings_get, settings_set};
use crate::model::Theme;
use crate::testkit::{TestCore, TestRepo};
use crate::util;
use serde_json::json;

#[tokio::test]
async fn profile_colour_is_stored_and_checked() {
    let tc = TestCore::new().await;
    let list = profile_save(&tc, None, "Arbeit".into(), "".into(), "".into(), false, Some(3)).await.unwrap();
    let work = list.iter().find(|p| p.name == "Arbeit").unwrap().clone();
    assert_eq!(work.color, Some(3));
    let list = profile_save(&tc, Some(work.id.clone()), "Arbeit".into(), "".into(), "".into(), false, None).await.unwrap();
    assert_eq!(list.iter().find(|p| p.id == work.id).unwrap().color, None);
    let err = profile_save(&tc, None, "X".into(), "".into(), "".into(), false, Some(9)).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    let err = profile_save(&tc, None, "Y".into(), "".into(), "".into(), false, Some(0)).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
}

#[tokio::test]
async fn default_profile_from_global_config() {
    let tc = TestCore::with_global_config("[user]\n\tname = Erika Muster\n\temail = erika@example.com\n").await;
    let profiles = profile_list(&tc).await.unwrap();
    assert_eq!(profiles.len(), 1);
    assert_eq!(profiles[0].name, "Default");
    assert_eq!(profiles[0].author_name, "Erika Muster");
    assert_eq!(profiles[0].author_email, "erika@example.com");
    assert!(profiles[0].is_active);

    let tc2 = TestCore::new().await;
    let profiles = profile_list(&tc2).await.unwrap();
    assert_eq!(profiles[0].author_name, "");
}

#[tokio::test]
async fn deleting_a_profile_forgets_repos_only_it_had() {
    let tc = TestCore::new().await;
    let default_id = profile_list(&tc).await.unwrap()[0].id.clone();
    let shared = TestRepo::with_commit();
    let own = TestRepo::with_commit();
    let shared_id = tc.open(&shared).await.repo.id;
    let list = profile_save(&tc, None, "Arbeit".into(), "".into(), "".into(), false, None).await.unwrap();
    let work = list.iter().find(|p| p.name == "Arbeit").unwrap().id.clone();
    profile_activate(&tc, work.clone()).await.unwrap();
    let own_id = tc.open(&own).await.repo.id;
    crate::commands::repos::repo_open_with(&tc, shared.path().to_string_lossy().into_owned(), true).await.unwrap();
    profile_activate(&tc, default_id).await.unwrap();
    // An agent's worktree is registered without any profile listing it.
    let worktree = shared.path().with_extension("agent-wt");
    let worktree_id = tc.db.with(|c| db::repos::upsert(c, &worktree)).unwrap().id;
    let agent = db::agents::AgentRow {
        id: "agent-1".into(),
        repo_id: shared_id.clone(),
        short_name: "a1".into(),
        template_id: "claude".into(),
        task: String::new(),
        branch: "agent/a1".into(),
        worktree_path: worktree.to_string_lossy().into_owned(),
        base: "main".into(),
        base_sha: "0".repeat(40),
        unattended: false,
        started_at: util::now_iso(),
        ended_at: None,
        exit_code: None,
        end_reason: None,
    };
    tc.db.with(|c| db::agents::insert(c, &agent)).unwrap();

    profile_delete(&tc, work).await.unwrap();

    assert!(tc.db.with(|c| db::repos::get(c, &own_id)).unwrap().is_none(), "listed only in the deleted profile");
    assert!(tc.db.with(|c| db::repos::get(c, &shared_id)).unwrap().is_some(), "the other profile keeps listing it");
    assert!(tc.db.with(|c| db::repos::get(c, &worktree_id)).unwrap().is_some(), "the agent's worktree stays registered");
}

#[tokio::test]
async fn profiles_save_activate_delete() {
    let tc = TestCore::new().await;
    let default_id = profile_list(&tc).await.unwrap()[0].id.clone();

    let list = profile_save(&tc, None, "Arbeit".into(), "Max Muster".into(), "max@firma.de".into(), true, None).await.unwrap();
    assert_eq!(list.len(), 2);
    let work = list.iter().find(|p| p.name == "Arbeit").unwrap().clone();
    assert!(!work.is_active);
    // Not active → global config untouched.
    let global = std::fs::read_to_string(tc.global_config_path()).unwrap();
    assert!(!global.contains("Max Muster"));

    let err = profile_save(&tc, None, "arbeit".into(), "".into(), "".into(), false, None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NameExists);
    let err = profile_save(&tc, None, "  ".into(), "".into(), "".into(), false, None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidName);
    let err = profile_save(&tc, None, "X".into(), "".into(), "falsch".into(), false, None).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);

    // Each profile has its own tabs; the theme is global.
    settings_set(&tc, json!({"theme": "light"})).await.unwrap();
    let repo = TestRepo::with_commit();
    tc.open(&repo).await;
    let list = profile_activate(&tc, work.id.clone()).await.unwrap();
    assert!(list.iter().find(|p| p.id == work.id).unwrap().is_active);
    assert_eq!(settings_get(&tc).await.unwrap().theme, Theme::Light);
    let tabs = crate::commands::repos::tabs_list(&tc).await.unwrap();
    assert_eq!(tabs.len(), 1);
    assert_eq!(tabs[0].kind, crate::model::TabKind::Management);
    let global = std::fs::read_to_string(tc.global_config_path()).unwrap();
    assert!(global.contains("Max Muster"), "{global}");
    assert!(global.contains("max@firma.de"));

    let err = profile_delete(&tc, work.id.clone()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    let list = profile_delete(&tc, default_id.clone()).await.unwrap();
    assert_eq!(list.len(), 1);
    let err = profile_delete(&tc, work.id.clone()).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    let err = profile_activate(&tc, default_id).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotFound);

    // Renaming the active profile with sync writes the new identity.
    profile_save(&tc, Some(work.id.clone()), "Arbeit".into(), "Max M.".into(), "mm@firma.de".into(), true, None).await.unwrap();
    let global = std::fs::read_to_string(tc.global_config_path()).unwrap();
    assert!(global.contains("Max M."));
}

fn break_global_gitconfig(tc: &TestCore) {
    let path = tc.global_config_path();
    let _ = std::fs::remove_file(&path);
    std::fs::create_dir_all(&path).unwrap();
}

fn announced_profiles(tc: &TestCore) -> bool {
    tc.events.named(names::APP_CHANGED).iter().any(|p| p["what"].as_array().is_some_and(|w| w.iter().any(|x| x == "profiles")))
}

#[tokio::test]
async fn switching_reports_the_new_profile_even_when_gitconfig_is_not_writable() {
    let tc = TestCore::new().await;
    let list = profile_save(&tc, None, "Arbeit".into(), "Max Muster".into(), "max@firma.de".into(), true, None).await.unwrap();
    let work = list.iter().find(|p| p.name == "Arbeit").unwrap().id.clone();
    break_global_gitconfig(&tc);
    tc.events.clear();
    let err = profile_activate(&tc, work.clone()).await.unwrap_err();
    assert!(err.message.starts_with("Switched to “Arbeit”, but the global Git identity couldn't be written"), "{}", err.message);
    assert_eq!(tc.db.with(db::profiles::active_id).unwrap(), work);
    assert!(announced_profiles(&tc));
}

#[tokio::test]
async fn saving_reports_the_new_state_even_when_gitconfig_is_not_writable() {
    let tc = TestCore::new().await;
    let active = profile_list(&tc).await.unwrap()[0].id.clone();
    break_global_gitconfig(&tc);
    tc.events.clear();
    let err = profile_save(&tc, Some(active.clone()), "Neu".into(), "Max".into(), "m@x.de".into(), true, None).await.unwrap_err();
    assert!(err.message.starts_with("Saved “Neu”, but the global Git identity couldn't be written"), "{}", err.message);
    assert_eq!(profile_list(&tc).await.unwrap()[0].name, "Neu");
    assert!(announced_profiles(&tc));
}
