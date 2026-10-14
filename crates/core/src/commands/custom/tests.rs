//! Custom commands against real repositories (the pure parts are tested in `definition` and `expand`).

use super::*;
use crate::error::ErrorCode;
use crate::events::names;
use crate::model::{CustomCommandCwd, CustomCommandInput, CustomCommandKind, CustomCommandScope, CustomInputType};
use crate::testkit::TestCore;

fn def(id: &str, kind: CustomCommandKind, run: &str) -> CustomCommandDef {
    CustomCommandDef {
        id: id.into(),
        title: format!("Befehl {id}"),
        kind,
        run: run.into(),
        cwd: CustomCommandCwd::Worktree,
        confirm: false,
        shell: false,
        inputs: vec![],
        scope: vec![CustomCommandScope::Repo],
    }
}

fn text_input(id: &str) -> CustomCommandInput {
    CustomCommandInput { id: id.into(), label: format!("Feld {id}"), input_type: CustomInputType::Text, default: None, options: vec![] }
}

#[tokio::test]
async fn global_commands_are_checked_saved_and_listed() {
    let tc = TestCore::new().await;
    assert!(custom_commands_list(&tc, None).await.unwrap().commands.is_empty());
    let mut build = def("bauen", CustomCommandKind::Shell, "make ${input:ziel}");
    build.inputs = vec![text_input("ziel")];
    let log = def("log", CustomCommandKind::Git, "log --oneline -5");
    tc.events.clear();
    let saved = custom_commands_save(&tc, vec![build.clone(), log.clone()]).await.unwrap();
    assert_eq!(saved, vec![build, log.clone()]);
    let changed = tc.events.named(names::APP_CHANGED);
    assert!(changed.iter().any(|e| e["what"].as_array().is_some_and(|what| what.contains(&serde_json::json!("custom_commands")))), "{changed:?}");
    let list = custom_commands_list(&tc, None).await.unwrap();
    assert_eq!(list.commands.iter().map(|e| (e.key.as_str(), e.runnable)).collect::<Vec<_>>(), [("global:bauen", true), ("global:log", true)]);
    assert_eq!(list.repo, None);

    // Nothing invalid is stored – and what was there stays.
    let mut twice = log.clone();
    twice.title = "Noch einmal".into();
    for bad in [vec![log.clone(), twice], vec![def("x", CustomCommandKind::Git, "push --force")], vec![def("y", CustomCommandKind::Shell, "echo ${user}")]] {
        assert_eq!(custom_commands_save(&tc, bad).await.unwrap_err().code, ErrorCode::NotAllowed);
    }
    assert_eq!(custom_commands_list(&tc, None).await.unwrap().commands.len(), 2);
    // The extra key in app_settings does not disturb the settings.
    crate::commands::settings::settings_get(&tc).await.unwrap();
    // The commands survive a restart.
    let tc = tc.restart().await;
    assert_eq!(custom_commands_list(&tc, None).await.unwrap().commands.len(), 2);
}

#[tokio::test]
async fn commands_are_exported_and_imported_as_json() {
    let tc = TestCore::new().await;
    let dir = tempfile::tempdir().unwrap();
    let mut open = def("ci", CustomCommandKind::Url, "https://ci.example.com/${branch}");
    open.scope = vec![CustomCommandScope::Branch];
    custom_commands_save(&tc, vec![open.clone()]).await.unwrap();
    let file = dir.path().join("befehle.json");
    let file_text = file.to_string_lossy().into_owned();
    custom_commands_export(&tc, file_text.clone()).await.unwrap();
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(text.contains("\"version\": 1"), "{text}");
    assert_eq!(custom_commands_import(&tc, file_text.clone()).await.unwrap(), vec![open]);

    // All or nothing: one broken command rejects the file and names it.
    std::fs::write(&file, r#"{"version":1,"commands":[{"id":"gut","title":"Gut","kind":"git","run":"log"},{"id":"boese","title":"Böse","kind":"git","run":"push -f"}]}"#).unwrap();
    let error = custom_commands_import(&tc, file_text).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::NotAllowed);
    assert!(error.message.contains("“boese”"), "{}", error.message);
    assert_eq!(custom_commands_import(&tc, "relativ.json".into()).await.unwrap_err().code, ErrorCode::NotAllowed);
    let missing_folder = dir.path().join("fehlt").join("x.json").to_string_lossy().into_owned();
    assert_eq!(custom_commands_export(&tc, missing_folder).await.unwrap_err().code, ErrorCode::NotFound);
}
