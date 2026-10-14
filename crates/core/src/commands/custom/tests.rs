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

use crate::model::CustomCommandChangeKind;
use crate::testkit::TestRepo;

const FILE_V1: &str = r#"{"version":1,"commands":[{"id":"hallo","title":"Hallo","kind":"url","run":"https://example.com/hallo/${sha}"}]}"#;
const FILE_V2: &str = r#"{"version":1,"commands":[{"id":"hallo","title":"Hallo","kind":"url","run":"https://example.com/anders/${sha}"},{"id":"neu","title":"Neu","kind":"git","run":"log -1"}]}"#;

#[tokio::test]
async fn repo_commands_need_their_own_approval_bound_to_the_file_hash() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    custom_commands_save(&tc, vec![def("eigen", CustomCommandKind::Git, "status")]).await.unwrap();

    // Without a file: only the user's own commands.
    let list = custom_commands_list(&tc, Some(id.clone())).await.unwrap();
    assert_eq!(list.repo.as_ref().map(|r| r.state), Some(RepoCommandsState::Missing));
    assert_eq!(list.commands.len(), 1);

    repo.write_file(".forkyard/commands.json", FILE_V1);
    let list = custom_commands_list(&tc, Some(id.clone())).await.unwrap();
    let info = list.repo.clone().unwrap();
    assert_eq!(info.state, RepoCommandsState::Untrusted);
    assert_eq!(info.path, ".forkyard/commands.json");
    assert_eq!(info.hash.as_deref(), Some(definition::file_hash(FILE_V1.as_bytes()).as_str()));
    assert_eq!(list.commands.iter().map(|e| (e.key.as_str(), e.runnable)).collect::<Vec<_>>(), [("global:eigen", true), ("repo:hallo", false)]);

    // An approval for another version of the file is refused.
    assert_eq!(custom_commands_trust(&tc, id.clone(), Some("0".repeat(64))).await.unwrap_err().code, ErrorCode::StaleState);
    tc.events.clear();
    let list = custom_commands_trust(&tc, id.clone(), info.hash.clone()).await.unwrap();
    assert_eq!(list.repo.as_ref().unwrap().state, RepoCommandsState::Trusted);
    assert!(list.commands.iter().all(|e| e.runnable));
    assert!(!tc.events.named(names::APP_CHANGED).is_empty());

    // Every change needs a new approval – and the list says what changed.
    repo.write_file(".forkyard/commands.json", FILE_V2);
    let list = custom_commands_list(&tc, Some(id.clone())).await.unwrap();
    let info = list.repo.clone().unwrap();
    assert_eq!(info.state, RepoCommandsState::Changed);
    assert_eq!(
        info.changes.iter().map(|c| (c.id.as_str(), c.change)).collect::<Vec<_>>(),
        [("hallo", CustomCommandChangeKind::Changed), ("neu", CustomCommandChangeKind::Added)]
    );
    assert_eq!(info.changes[0].before.as_deref(), Some("https://example.com/hallo/${sha}"));
    assert_eq!(info.changes[0].after.as_deref(), Some("https://example.com/anders/${sha}"));
    assert!(list.commands.iter().filter(|e| e.source == CustomCommandSource::Repo).all(|e| !e.runnable));

    // The approval survives a restart and can be withdrawn.
    custom_commands_trust(&tc, id.clone(), info.hash.clone()).await.unwrap();
    let tc = tc.restart().await;
    assert_eq!(custom_commands_list(&tc, Some(id.clone())).await.unwrap().repo.unwrap().state, RepoCommandsState::Trusted);
    let list = custom_commands_trust(&tc, id.clone(), None).await.unwrap();
    assert_eq!(list.repo.unwrap().state, RepoCommandsState::Untrusted);
    // The internal key does not disturb the repository settings.
    crate::commands::settings::repo_settings_get(&tc, id).await.unwrap();
}

#[tokio::test]
async fn a_repository_file_cannot_switch_on_a_shell_or_reach_outside() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    repo.write_file(
        ".forkyard/commands.json",
        r#"{"version":1,"commands":[
            {"id":"boese","title":"Böse","kind":"shell","shell":true,"run":"touch BOESE"},
            {"id":"gut","title":"Gut","kind":"url","run":"https://example.com/${sha}"}]}"#,
    );
    let list = custom_commands_list(&tc, Some(id.clone())).await.unwrap();
    assert_eq!(list.commands.iter().map(|e| e.key.as_str()).collect::<Vec<_>>(), ["repo:gut"]);
    let problems = list.repo.unwrap().problems;
    assert!(problems.iter().any(|p| p.contains("“boese”") && p.contains("shell: true")), "{problems:?}");

    #[cfg(unix)]
    {
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("commands.json");
        std::fs::write(&target, r#"{"version":1,"commands":[]}"#).unwrap();
        repo.remove_file(".forkyard/commands.json");
        std::os::unix::fs::symlink(&target, repo.path().join(".forkyard/commands.json")).unwrap();
        let info = custom_commands_list(&tc, Some(id.clone())).await.unwrap().repo.unwrap();
        assert_eq!((info.state, info.hash.clone()), (RepoCommandsState::Untrusted, None));
        assert!(info.problems[0].contains("not a regular file"), "{:?}", info.problems);
        let hash = definition::file_hash(br#"{"version":1,"commands":[]}"#);
        assert_eq!(custom_commands_trust(&tc, id, Some(hash)).await.unwrap_err().code, ErrorCode::NotFound);
    }
}

#[tokio::test]
async fn a_locked_repository_lists_and_approves_nothing() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    repo.git(&["config", "core.hooksPath", ".husky"]);
    let opened = crate::commands::repos::repo_open(&tc, repo.path().to_string_lossy().into_owned()).await.unwrap();
    assert!(!opened.repo.trusted);
    assert_eq!(custom_commands_list(&tc, Some(opened.repo.id.clone())).await.unwrap_err().code, ErrorCode::RepoUntrusted);
    assert_eq!(custom_commands_trust(&tc, opened.repo.id, None).await.unwrap_err().code, ErrorCode::RepoUntrusted);
}
