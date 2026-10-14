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

/// 150 valid commands with long command lines exceed the file limit together: saving them is
/// refused instead of storing a list that reads back as empty.
#[tokio::test]
async fn a_list_larger_than_the_file_limit_is_not_saved() {
    let tc = TestCore::new().await;
    let kept = def("bleibt", CustomCommandKind::Git, "status");
    custom_commands_save(&tc, vec![kept.clone()]).await.unwrap();
    let long = format!("log {}", "x".repeat(1990));
    let many: Vec<CustomCommandDef> = (0..150).map(|n| def(&format!("lang-{n}"), CustomCommandKind::Git, &long)).collect();
    let error = custom_commands_save(&tc, many).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::NotAllowed);
    assert!(error.message.contains("KiB"), "{}", error.message);
    let listed: Vec<CustomCommandDef> = custom_commands_list(&tc, None).await.unwrap().commands.into_iter().map(|entry| entry.command).collect();
    assert_eq!(listed, vec![kept], "what was there stays");
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

use std::time::Duration;

use crate::model::ActivityScope;

async fn run(tc: &TestCore, repo_id: &str, key: &str, context: CustomCommandContext, inputs: &[(&str, &str)]) -> CoreResult<CustomCommandResult> {
    let inputs: BTreeMap<String, String> = inputs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
    custom_command_run(tc, repo_id.to_string(), key.to_string(), context, inputs, util::new_id(), true).await
}

fn finished(result: CustomCommandResult) -> (Option<i32>, String) {
    match result {
        CustomCommandResult::Finished { exit_code, output } => (exit_code, output),
        other => panic!("expected a finished run, got {other:?}"),
    }
}

#[tokio::test]
async fn url_commands_encode_values_and_stay_http() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    let head = repo.head();
    let mut ci = def("ci", CustomCommandKind::Url, "https://ci.example.com/build?branch=${branch}&sha=${sha}&q=${input:q}");
    ci.inputs = vec![text_input("q")];
    custom_commands_save(&tc, vec![ci]).await.unwrap();
    tc.events.clear();
    let context = CustomCommandContext { branch: Some("feature/äpfel+birnen".into()), ..Default::default() };
    let result = run(&tc, &id, "global:ci", context, &[("q", "a&b=c d")]).await.unwrap();
    assert_eq!(result, CustomCommandResult::OpenUrl { url: format!("https://ci.example.com/build?branch=feature%2F%C3%A4pfel%2Bbirnen&sha={head}&q=a%26b%3Dc%20d") });
    // Without a context: HEAD and the current branch.
    let result = run(&tc, &id, "global:ci", CustomCommandContext::default(), &[("q", "")]).await.unwrap();
    assert_eq!(result, CustomCommandResult::OpenUrl { url: format!("https://ci.example.com/build?branch=main&sha={head}&q=") });
    assert!(tc.events.named(names::JOB_DONE).is_empty(), "opening an address is not a job");
}

#[tokio::test]
async fn repo_commands_run_only_while_their_approval_matches() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    let head = repo.head();
    repo.write_file(".forkyard/commands.json", FILE_V1);
    assert_eq!(run(&tc, &id, "repo:hallo", Default::default(), &[]).await.unwrap_err().code, ErrorCode::CommandUntrusted);
    let hash = custom_commands_list(&tc, Some(id.clone())).await.unwrap().repo.unwrap().hash;
    custom_commands_trust(&tc, id.clone(), hash).await.unwrap();
    assert_eq!(run(&tc, &id, "repo:hallo", Default::default(), &[]).await.unwrap(), CustomCommandResult::OpenUrl { url: format!("https://example.com/hallo/{head}") });
    repo.write_file(".forkyard/commands.json", FILE_V2);
    assert_eq!(run(&tc, &id, "repo:hallo", Default::default(), &[]).await.unwrap_err().code, ErrorCode::CommandUntrusted);
    assert_eq!(run(&tc, &id, "repo:fehlt", Default::default(), &[]).await.unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(run(&tc, &id, "anders:hallo", Default::default(), &[]).await.unwrap_err().code, ErrorCode::NotFound);
    // A global command with the same ID is a different command.
    custom_commands_save(&tc, vec![def("hallo", CustomCommandKind::Url, "https://example.com/eigen")]).await.unwrap();
    assert_eq!(run(&tc, &id, "global:hallo", Default::default(), &[]).await.unwrap(), CustomCommandResult::OpenUrl { url: "https://example.com/eigen".into() });
}

#[tokio::test]
async fn the_context_is_checked_before_anything_runs() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    custom_commands_save(&tc, vec![def("ci", CustomCommandKind::Url, "https://ci.example.com/${file}?r=${remote}")]).await.unwrap();
    let ctx = |sha: Option<&str>, branch: Option<&str>, file: Option<&str>, remote: Option<&str>| CustomCommandContext {
        sha: sha.map(Into::into),
        branch: branch.map(Into::into),
        file: file.map(Into::into),
        remote: remote.map(Into::into),
    };
    let code = |result: CoreResult<CustomCommandResult>| result.unwrap_err().code;
    assert_eq!(code(run(&tc, &id, "global:ci", ctx(Some("HEAD; rm -rf /"), None, Some("a"), None), &[]).await), ErrorCode::NotAllowed);
    assert_eq!(code(run(&tc, &id, "global:ci", ctx(None, Some("-x"), Some("a"), None), &[]).await), ErrorCode::InvalidName);
    assert_eq!(code(run(&tc, &id, "global:ci", ctx(None, None, Some("../ausserhalb"), None), &[]).await), ErrorCode::NotAllowed);
    assert_eq!(code(run(&tc, &id, "global:ci", ctx(None, None, Some("a"), Some("nirgendwo")), &[]).await), ErrorCode::NotFound);
    // Without any remote the placeholder has nothing to stand for.
    let error = run(&tc, &id, "global:ci", ctx(None, None, Some("docs/a b.md"), None), &[]).await.unwrap_err();
    assert!(error.message.contains("remote"), "{}", error.message);
    // With exactly one remote it is taken.
    let _remote = repo.add_remote();
    assert_eq!(
        run(&tc, &id, "global:ci", ctx(None, None, Some("docs/a b.md"), None), &[]).await.unwrap(),
        CustomCommandResult::OpenUrl { url: "https://ci.example.com/docs%2Fa%20b.md?r=origin".into() }
    );
}

#[tokio::test]
async fn confirm_returns_the_finished_command_and_runs_nothing() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    let mut quote = def("vorsicht", CustomCommandKind::Shell, "git rev-parse --sq-quote ${input:text}");
    quote.confirm = true;
    quote.inputs = vec![text_input("text")];
    let mut ci = def("ci", CustomCommandKind::Url, "https://ci.example.com/${sha}");
    ci.confirm = true;
    let mut main_tree = def("haupt", CustomCommandKind::Shell, "git status");
    main_tree.confirm = true;
    main_tree.cwd = CustomCommandCwd::Repo;
    custom_commands_save(&tc, vec![quote, ci, main_tree]).await.unwrap();
    tc.events.clear();

    let inputs: BTreeMap<String, String> = [("text".to_string(), "zwei Wörter".to_string())].into();
    let result = custom_command_run(&tc, id.clone(), "global:vorsicht".into(), Default::default(), inputs, "job-vorsicht".into(), false).await.unwrap();
    let CustomCommandResult::Confirm { display, cwd } = result else { panic!("{result:?}") };
    assert_eq!(display, "git rev-parse --sq-quote \"zwei Wörter\"");
    assert_eq!(std::fs::canonicalize(&cwd).unwrap(), std::fs::canonicalize(repo.path()).unwrap());
    assert!(tc.events.named(names::JOB_DONE).is_empty() && !tc.jobs.is_running("job-vorsicht"), "nothing ran");

    let head = repo.head();
    let result = custom_command_run(&tc, id.clone(), "global:ci".into(), Default::default(), BTreeMap::new(), util::new_id(), false).await.unwrap();
    assert_eq!(result, CustomCommandResult::Confirm { display: format!("https://ci.example.com/{head}"), cwd: util::display_path(&tc.repo_path(&id).unwrap()) });

    // `cwd: repo` in a linked worktree: the main working tree.
    let linked = repo.temp_dir().join("zweiter");
    repo.git(&["worktree", "add", "-q", &linked.to_string_lossy(), "-b", "nebenher"]);
    let worktree = crate::commands::repos::repo_open(&tc, linked.to_string_lossy().into_owned()).await.unwrap();
    let result = custom_command_run(&tc, worktree.repo.id, "global:haupt".into(), Default::default(), BTreeMap::new(), util::new_id(), false).await.unwrap();
    let CustomCommandResult::Confirm { cwd, .. } = result else { panic!("{result:?}") };
    assert_eq!(std::fs::canonicalize(&cwd).unwrap(), std::fs::canonicalize(repo.path()).unwrap());
}

#[tokio::test]
async fn shell_values_stay_single_arguments_and_nothing_is_interpreted() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    let mut quote = def("quote", CustomCommandKind::Shell, "git rev-parse --sq-quote ${input:text} ${branch}");
    quote.inputs = vec![text_input("text")];
    let failing = def("fehler", CustomCommandKind::Shell, "git rev-parse --verify --quiet gibt-es-nicht");
    let missing = def("weg", CustomCommandKind::Shell, "forkyard-gibt-es-nicht-4711 --x");
    custom_commands_save(&tc, vec![quote, failing, missing]).await.unwrap();

    let hostile = "a b; touch PWNED && echo $(touch PWNED2) `touch PWNED3` | x > y";
    let (exit_code, output) = finished(run(&tc, &id, "global:quote", CustomCommandContext::default(), &[("text", hostile)]).await.unwrap());
    assert_eq!(exit_code, Some(0), "{output}");
    assert_eq!(output.trim(), format!("'{hostile}' 'main'"), "one argument for the value, one for the branch");
    for marker in ["PWNED", "PWNED2", "PWNED3", "y"] {
        assert!(!repo.path().join(marker).exists(), "{marker} must not exist");
    }
    // A failing program is a result with its exit code, not an error.
    assert_eq!(finished(run(&tc, &id, "global:fehler", Default::default(), &[]).await.unwrap()).0, Some(1));
    let error = run(&tc, &id, "global:weg", Default::default(), &[]).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::NotFound);
    assert!(error.message.contains("forkyard-gibt-es-nicht-4711"), "{}", error.message);
}

#[cfg(unix)]
#[tokio::test]
async fn with_shell_true_values_arrive_as_environment_variables() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    let mut pipe = def("pipe", CustomCommandKind::Shell, "printf '%s' ${input:text} > ausgabe.txt");
    pipe.shell = true;
    pipe.inputs = vec![text_input("text")];
    custom_commands_save(&tc, vec![pipe]).await.unwrap();
    let hostile = "$(touch PWNED) `touch PWNED2`; touch PWNED3";
    assert_eq!(finished(run(&tc, &id, "global:pipe", Default::default(), &[("text", hostile)]).await.unwrap()).0, Some(0));
    assert_eq!(std::fs::read_to_string(repo.path().join("ausgabe.txt")).unwrap(), hostile);
    for marker in ["PWNED", "PWNED2", "PWNED3"] {
        assert!(!repo.path().join(marker).exists(), "{marker} must not exist");
    }
}

#[cfg(windows)]
#[tokio::test]
async fn with_shell_true_values_arrive_as_environment_variables() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    let mut pipe = def("pipe", CustomCommandKind::Shell, "Set-Content -NoNewline -Path ausgabe.txt -Value ${input:text}");
    pipe.shell = true;
    pipe.inputs = vec![text_input("text")];
    custom_commands_save(&tc, vec![pipe]).await.unwrap();
    let hostile = "$(New-Item PWNED); New-Item PWNED2";
    assert_eq!(finished(run(&tc, &id, "global:pipe", Default::default(), &[("text", hostile)]).await.unwrap()).0, Some(0));
    assert_eq!(std::fs::read_to_string(repo.path().join("ausgabe.txt")).unwrap(), hostile);
    assert!(!repo.path().join("PWNED").exists() && !repo.path().join("PWNED2").exists());
}

#[tokio::test]
async fn shell_output_is_redacted_in_result_progress_and_log() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    let secret = "geheim-12345";
    custom_commands_save(&tc, vec![def("leak", CustomCommandKind::Shell, &format!("git rev-parse --sq-quote https://anna:{secret}@example.invalid/x.git"))]).await.unwrap();
    tc.events.clear();
    let (exit_code, output) = finished(run(&tc, &id, "global:leak", Default::default(), &[]).await.unwrap());
    assert_eq!(exit_code, Some(0));
    assert!(output.contains("example.invalid") && !output.contains(secret), "{output}");
    let events = serde_json::to_string(&tc.events.all()).unwrap();
    assert!(!events.contains(secret), "{events}");
    assert!(tc.events.named(names::REPO_CHANGED).iter().any(|e| e["repoId"] == id.as_str()), "a program may have changed the repository");
    let page = crate::commands::activity::activity_list(&tc, ActivityScope::Repo, Some(id.clone()), None, 50).await.unwrap();
    let logged = page.entries.iter().find(|e| e.command.starts_with("git rev-parse --sq-quote")).expect("the run is in the activity log");
    assert_eq!(logged.exit_code, Some(0));
    assert!(logged.output.contains("example.invalid"));
    assert!(page.entries.iter().all(|e| !e.command.contains(secret) && !e.output.contains(secret)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_running_program_can_be_cancelled() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    #[cfg(unix)]
    let wait = "sleep 30";
    #[cfg(windows)]
    let wait = "ping -n 30 127.0.0.1";
    custom_commands_save(&tc, vec![def("warten", CustomCommandKind::Shell, wait)]).await.unwrap();
    let (core, repo_id) = (tc.core.clone(), id.clone());
    let started = std::time::Instant::now();
    let task = tokio::spawn(async move { custom_command_run(&core, repo_id, "global:warten".into(), Default::default(), BTreeMap::new(), "job-warten".into(), true).await });
    for _ in 0..500 {
        if tc.jobs.is_running("job-warten") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(tc.jobs.is_running("job-warten"), "the run is a job");
    crate::commands::sync::job_cancel(&tc, "job-warten".into()).await.unwrap();
    let result = tokio::time::timeout(Duration::from_secs(10), task).await.expect("ends after cancelling").unwrap();
    assert_eq!(result.unwrap_err().code, ErrorCode::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(25));
    assert!(tc.events.named(names::JOB_DONE).iter().any(|e| e["jobId"] == "job-warten" && e["cancelled"] == true));
}

#[tokio::test]
async fn git_commands_run_in_the_queue_and_values_never_become_options() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    let head = repo.head();
    let mut tag = def("markieren", CustomCommandKind::Git, "tag ${input:name} ${sha}");
    tag.inputs = vec![text_input("name")];
    let mut log = def("liste", CustomCommandKind::Git, "log ${input:format} -1");
    log.inputs = vec![CustomCommandInput { id: "format".into(), label: "Format".into(), input_type: CustomInputType::Choice, default: None, options: vec!["--oneline".into(), "--stat".into()] }];
    custom_commands_save(&tc, vec![tag, log]).await.unwrap();
    tc.events.clear();

    assert_eq!(run(&tc, &id, "global:markieren", Default::default(), &[("name", "v-eins")]).await.unwrap(), CustomCommandResult::Finished { exit_code: Some(0), output: String::new() });
    assert_eq!(repo.git(&["tag", "--list"]), "v-eins");
    assert_eq!(repo.git(&["rev-parse", "v-eins"]), head);
    assert!(tc.events.named(names::REPO_CHANGED).iter().any(|e| e["repoId"] == id.as_str()));
    let page = crate::commands::activity::activity_list(&tc, ActivityScope::Repo, Some(id.clone()), None, 50).await.unwrap();
    assert!(page.entries.iter().any(|e| e.command == format!("git tag v-eins {head}")), "{:?}", page.entries.iter().map(|e| &e.command).collect::<Vec<_>>());

    // A value from a text field never becomes an option: nothing is deleted.
    let error = run(&tc, &id, "global:markieren", Default::default(), &[("name", "--delete")]).await.unwrap_err();
    assert_eq!(error.code, ErrorCode::NotAllowed);
    assert_eq!(repo.git(&["tag", "--list"]), "v-eins");
    // A choice from the definition may be an option – but only one of its own.
    let (exit_code, output) = finished(run(&tc, &id, "global:liste", Default::default(), &[("format", "--oneline")]).await.unwrap());
    assert_eq!(exit_code, Some(0));
    assert!(output.contains("Erster Commit"), "{output}");
    assert_eq!(run(&tc, &id, "global:liste", Default::default(), &[("format", "--exec=x")]).await.unwrap_err().code, ErrorCode::NotAllowed);
    // A failing Git command is a result with its exit code.
    let (exit_code, output) = finished(run(&tc, &id, "global:markieren", Default::default(), &[("name", "v-eins")]).await.unwrap());
    assert_ne!(exit_code, Some(0));
    assert!(output.contains("already exists"), "{output}");

    // The command waits for the repository's write queue.
    let guard = tc.write_lock(&id).await;
    let (core, repo_id) = (tc.core.clone(), id.clone());
    let task = tokio::spawn(async move {
        let inputs: BTreeMap<String, String> = [("name".to_string(), "v-zwei".to_string())].into();
        custom_command_run(&core, repo_id, "global:markieren".into(), Default::default(), inputs, util::new_id(), true).await
    });
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!task.is_finished(), "waits while another write runs");
    assert_eq!(repo.git(&["tag", "--list"]), "v-eins");
    drop(guard);
    task.await.unwrap().unwrap();
    assert_eq!(repo.git(&["tag", "--list"]), "v-eins\nv-zwei");
}
