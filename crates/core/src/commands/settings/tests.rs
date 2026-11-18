use super::*;
use crate::commands::profiles::{profile_activate, profile_save};
use crate::error::ErrorCode;
use crate::events::names;
use crate::model::{AiCliPaths, AiFeature, AiProviderKind};
use crate::model::{PullMode, Theme};
use crate::testkit::{TestCore, TestRepo};
use serde_json::json;

#[tokio::test]
async fn own_agent_templates_with_a_bypass_flag_are_refused_and_nothing_is_stored() {
    let tc = TestCore::new().await;
    let bad = serde_json::json!({ "agentTemplates": [{ "id": "custom:x", "name": "X", "program": "x", "unattendedArgs": ["--dangerously-skip-permissions"] }] });
    let err = settings_set(&tc, bad).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    assert!(load_settings(&tc).unwrap().agent_templates.is_empty());
    let good = serde_json::json!({ "agentTemplates": [{ "id": "custom:x", "name": " X ", "program": "x", "unattendedArgs": ["--yes"] }] });
    assert_eq!(settings_set(&tc, good).await.unwrap().agent_templates[0].name, "X");
}

#[tokio::test]
async fn global_settings_are_shared_and_profile_settings_are_not() {
    let tc = TestCore::new().await;
    settings_set(&tc, json!({"theme": "light", "autoFetchMinutes": 7})).await.unwrap();
    let list = profile_save(&tc, None, "Privat".into(), "".into(), "".into(), false, None).await.unwrap();
    let other = list.iter().find(|p| p.name == "Privat").unwrap().id.clone();
    profile_activate(&tc, other).await.unwrap();
    let s = settings_get(&tc).await.unwrap();
    assert_eq!(s.theme, Theme::Light, "theme is global");
    assert_eq!(s.auto_fetch_minutes, Settings::default().auto_fetch_minutes, "auto-fetch is per profile");
}

#[tokio::test]
async fn mixed_patch_lands_on_both_levels() {
    let tc = TestCore::new().await;
    settings_set(&tc, json!({"zoom": 1.2, "pushAfterCommit": true})).await.unwrap();
    let (global, profile) = tc
        .db
        .with(|c| {
            let pid = db::profiles::active_id(c)?;
            Ok((db::app_settings::get_all(c)?, db::settings::get_all(c, &pid)?))
        })
        .unwrap();
    assert!(global.iter().any(|(k, _)| k == "zoom"));
    assert!(!global.iter().any(|(k, _)| k == "pushAfterCommit"));
    assert!(profile.iter().any(|(k, _)| k == "pushAfterCommit"));
    assert!(!profile.iter().any(|(k, _)| k == "zoom"));
}

#[test]
fn every_global_key_is_a_settings_field() {
    let fields = serde_json::to_value(Settings::default()).unwrap();
    for key in db::app_settings::GLOBAL_KEYS {
        assert!(fields.get(key).is_some(), "{key} is not a Settings field");
    }
    assert!(!db::app_settings::is_global("proxyUrl"));
}

#[tokio::test]
async fn ai_settings_are_global_tidied_and_checked() {
    let tc = TestCore::new().await;
    let s = settings_get(&tc).await.unwrap();
    assert_eq!(s.ai_enabled, None, "not set up: neither on nor off");
    assert_eq!(s.ai_confirm_cost_usd, 0.10, "ask above 0.10 USD by default");
    let s = settings_set(
        &tc,
        json!({
            "aiEnabled": true,
            "aiProvider": "openai_compatible",
            "aiBaseUrl": " https://llm.firma.example/v1/ ",
            "aiModel": "  mistral-large-latest ",
            "aiConfirmCostUsd": -3,
            "aiMonthlyLimitUsd": 25.5,
            "aiExclude": [" *.sql ", "", "*.sql", "geheim/**"],
            "aiFeaturesOff": ["plan", "compose", "plan"],
            "aiPrices": [
                {"model": " mistral-large-latest ", "inputUsdPerMtok": 2, "outputUsdPerMtok": 6},
                {"model": "", "inputUsdPerMtok": 1, "outputUsdPerMtok": 1},
                {"model": "x", "inputUsdPerMtok": -1, "outputUsdPerMtok": 1}
            ]
        }),
    )
    .await
    .unwrap();
    assert_eq!(s.ai_base_url.as_deref(), Some("https://llm.firma.example/v1"));
    assert_eq!(s.ai_model.as_deref(), Some("mistral-large-latest"));
    assert_eq!(s.ai_confirm_cost_usd, 0.0);
    assert_eq!(s.ai_monthly_limit_usd, Some(25.5));
    assert_eq!(s.ai_exclude, vec!["*.sql".to_string(), "geheim/**".to_string()]);
    assert_eq!(s.ai_features_off, vec![AiFeature::Compose, AiFeature::Plan]);
    assert_eq!(s.ai_prices.len(), 1);
    assert_eq!(
        (s.ai_prices[0].model.as_str(), s.ai_prices[0].input_usd_per_mtok, s.ai_prices[0].output_usd_per_mtok),
        ("mistral-large-latest", 2.0, 6.0)
    );
    let ai_events = tc
        .events
        .all()
        .into_iter()
        .filter(|(name, payload)| {
            name == names::APP_CHANGED && payload["what"].as_array().is_some_and(|what| what.iter().any(|w| w == "ai"))
        })
        .count();
    assert_eq!(ai_events, 1, "an AI change also reports app:changed with ai");

    // Global: another profile sees the same values.
    let list = profile_save(&tc, None, "Privat".into(), "".into(), "".into(), false, None).await.unwrap();
    let other = list.iter().find(|p| p.name == "Privat").unwrap().id.clone();
    profile_activate(&tc, other).await.unwrap();
    let s = settings_get(&tc).await.unwrap();
    assert_eq!((s.ai_enabled, s.ai_provider), (Some(true), Some(AiProviderKind::OpenaiCompatible)));

    // Unencrypted only to this computer.
    let err = settings_set(&tc, json!({"aiBaseUrl": "http://llm.firma.example/v1"})).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    assert!(err.message.contains("https://"), "{}", err.message);
    let err = settings_set(&tc, json!({"aiBaseUrl": "https://user:pass@llm.firma.example/v1"})).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed, "no credentials in the address");
    assert!(!err.message.contains("pass@"), "{}", err.message);
    let s = settings_set(&tc, json!({"aiBaseUrl": "http://127.0.0.1:11435"})).await.unwrap();
    assert_eq!(s.ai_base_url.as_deref(), Some("http://127.0.0.1:11435"));
    let s = settings_set(&tc, json!({"aiEnabled": false})).await.unwrap();
    assert_eq!(s.ai_enabled, Some(false), "off on purpose is kept apart from unset");
}

#[tokio::test]
async fn ai_off_is_a_repository_setting_outside_the_git_config() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    assert!(!repo_settings_get(&tc, id.clone()).await.unwrap().ai_off);
    let s = repo_settings_set(&tc, id.clone(), json!({"aiOff": true})).await.unwrap();
    assert!(s.ai_off);
    let config = String::from_utf8_lossy(&repo.read_file(".git/config")).to_lowercase();
    assert!(!config.contains("aioff"), "stored in the app database, not in .git/config: {config}");
    let tc = tc.restart().await;
    assert!(repo_settings_get(&tc, id).await.unwrap().ai_off, "kept across a restart");
}

#[tokio::test]
async fn search_embedding_settings_are_global_and_local_only() {
    let tc = TestCore::new().await;
    let s = settings_get(&tc).await.unwrap();
    assert_eq!(
        (s.ai_search_embed_provider, s.ai_search_embed_model.as_deref(), s.ai_search_embed_base_url.as_deref()),
        (None, None, None),
        "by default the main provider's embeddings"
    );
    let s = settings_set(
        &tc,
        json!({"aiSearchEmbedProvider": "lmstudio", "aiSearchEmbedModel": "  text-embedding-nomic-embed-text-v1.5 ", "aiSearchEmbedBaseUrl": " http://localhost:1235/v1/ "}),
    )
    .await
    .unwrap();
    assert_eq!(s.ai_search_embed_provider, Some(AiProviderKind::Lmstudio));
    assert_eq!(s.ai_search_embed_model.as_deref(), Some("text-embedding-nomic-embed-text-v1.5"));
    assert_eq!(s.ai_search_embed_base_url.as_deref(), Some("http://localhost:1235/v1"));
    let ai_events = tc
        .events
        .all()
        .into_iter()
        .filter(|(name, payload)| {
            name == names::APP_CHANGED && payload["what"].as_array().is_some_and(|what| what.iter().any(|w| w == "ai"))
        })
        .count();
    assert!(ai_events >= 1, "a change of the search embedder reports app:changed with ai");

    // the extra provider of the search is a local one.
    for kind in ["openai", "anthropic", "gemini", "openai_compatible"] {
        let err = settings_set(&tc, json!({"aiSearchEmbedProvider": kind})).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed, "{kind}");
    }
    for url in ["https://embed.firma.example/v1", "http://192.168.1.20:11434"] {
        let err = settings_set(&tc, json!({"aiSearchEmbedBaseUrl": url})).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed, "{url}");
        assert!(err.message.contains("this computer"), "{}", err.message);
    }
    assert_eq!(
        settings_get(&tc).await.unwrap().ai_search_embed_base_url.as_deref(),
        Some("http://localhost:1235/v1"),
        "a refused value changes nothing"
    );

    // Global: another profile sees the same embedder.
    let list = profile_save(&tc, None, "Privat".into(), "".into(), "".into(), false, None).await.unwrap();
    let other = list.iter().find(|p| p.name == "Privat").unwrap().id.clone();
    profile_activate(&tc, other).await.unwrap();
    assert_eq!(settings_get(&tc).await.unwrap().ai_search_embed_provider, Some(AiProviderKind::Lmstudio));
}

#[tokio::test]
async fn the_own_commit_instruction_is_a_trimmed_repository_setting_with_a_limit() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    assert_eq!(repo_settings_get(&tc, id.clone()).await.unwrap().ai_commit_instruction, None);
    let s = repo_settings_set(&tc, id.clone(), json!({"aiCommitInstruction": "  Betreff endet mit dem Ticket-Schlüssel („AB-123“).\n"}))
        .await
        .unwrap();
    assert_eq!(s.ai_commit_instruction.as_deref(), Some("Betreff endet mit dem Ticket-Schlüssel („AB-123“)."));
    let config = String::from_utf8_lossy(&repo.read_file(".git/config")).to_lowercase();
    assert!(!config.contains("aicommitinstruction") && !config.contains("ticket"), "stored in the app database: {config}");

    let s = repo_settings_set(&tc, id.clone(), json!({"aiCommitInstruction": "   \n"})).await.unwrap();
    assert_eq!(s.ai_commit_instruction, None, "blank means none");
    let stored = tc.db.with(|c| db::repo_settings::get_all(c, &id)).unwrap();
    assert!(stored.iter().all(|(key, _)| key != "aiCommitInstruction"), "and nothing is kept");

    let err = repo_settings_set(&tc, id.clone(), json!({"aiCommitInstruction": "ä".repeat(2001)})).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    assert!(err.message.contains("2000"), "{}", err.message);
    let exact = "ä".repeat(2000);
    let s = repo_settings_set(&tc, id.clone(), json!({"aiCommitInstruction": exact.clone()})).await.unwrap();
    assert_eq!(s.ai_commit_instruction, Some(exact), "2000 characters – not bytes – are allowed");

    let tc = tc.restart().await;
    assert_eq!(
        repo_settings_get(&tc, id).await.unwrap().ai_commit_instruction.map(|text| text.chars().count()),
        Some(2000),
        "kept across a restart"
    );
}

#[tokio::test]
async fn cli_paths_are_global_tidied_and_must_be_absolute() {
    let tc = TestCore::new().await;
    assert_eq!(settings_get(&tc).await.unwrap().ai_cli_paths, AiCliPaths::default(), "found automatically by default");
    let own = std::env::temp_dir().join("Programme mit Leerzeichen").join("Grüße").join("claude");
    tc.events.clear();
    let s = settings_set(&tc, json!({"aiCliPaths": {"claudeCode": format!("  {}  ", own.display()), "codex": "   ", "opencode": null}}))
        .await
        .unwrap();
    assert_eq!(s.ai_cli_paths.claude_code.as_deref(), Some(own.to_str().unwrap()), "trimmed, spaces and umlauts inside kept");
    assert_eq!((s.ai_cli_paths.codex.clone(), s.ai_cli_paths.opencode.clone()), (None, None), "blank = found automatically");
    let ai_events = tc
        .events
        .all()
        .into_iter()
        .filter(|(name, payload)| {
            name == names::APP_CHANGED && payload["what"].as_array().is_some_and(|what| what.iter().any(|w| w == "ai"))
        })
        .count();
    assert_eq!(ai_events, 1, "a path change is an AI change");

    for relative in ["bin/claude", "claude", "-claude"] {
        let err = settings_set(&tc, json!({"aiCliPaths": {"claudeCode": null, "codex": relative, "opencode": null}})).await.unwrap_err();
        assert_eq!(err.code, ErrorCode::NotAllowed, "{relative}");
        assert!(err.message.contains("full path") && err.message.contains("Codex"), "{}", err.message);
    }
    assert_eq!(
        settings_get(&tc).await.unwrap().ai_cli_paths.claude_code.as_deref(),
        Some(own.to_str().unwrap()),
        "a refused change keeps the old value"
    );

    // Global like every AI setting.
    let list = profile_save(&tc, None, "Privat".into(), "".into(), "".into(), false, None).await.unwrap();
    let other = list.iter().find(|p| p.name == "Privat").unwrap().id.clone();
    profile_activate(&tc, other).await.unwrap();
    assert_eq!(settings_get(&tc).await.unwrap().ai_cli_paths.claude_code.as_deref(), Some(own.to_str().unwrap()));
}

#[tokio::test]
async fn agent_templates_are_global_and_the_test_command_is_per_repository() {
    let tc = TestCore::new().await;
    assert!(db::app_settings::is_global("agentTemplates"));
    let template =
        serde_json::json!([{ "id": "custom:a", "name": "Eigener Agent", "program": "eigen", "args": ["--task", "${taskFile}"] }]);
    let saved = settings_set(&tc, serde_json::json!({ "agentTemplates": template })).await.unwrap();
    assert_eq!(saved.agent_templates.len(), 1);
    let stored: i64 =
        tc.db.with(|c| Ok(c.query_row("select count(*) from app_settings where key = 'agentTemplates'", [], |r| r.get(0))?)).unwrap();
    assert_eq!(stored, 1, "global table");
    let in_profile: i64 =
        tc.db.with(|c| Ok(c.query_row("select count(*) from settings where key = 'agentTemplates'", [], |r| r.get(0))?)).unwrap();
    assert_eq!(in_profile, 0);

    let repo = crate::testkit::TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    assert_eq!(repo_settings_get(&tc, id.clone()).await.unwrap().test_command, None);
    let next = repo_settings_set(&tc, id.clone(), serde_json::json!({ "testCommand": "cargo test --workspace" })).await.unwrap();
    assert_eq!(next.test_command.as_deref(), Some("cargo test --workspace"));
    let cleared = repo_settings_set(&tc, id.clone(), serde_json::json!({ "testCommand": null })).await.unwrap();
    assert_eq!(cleared.test_command, None);
    let rows: i64 =
        tc.db.with(|c| Ok(c.query_row("select count(*) from repo_settings where key = 'testCommand'", [], |r| r.get(0))?)).unwrap();
    assert_eq!(rows, 0, "a cleared value leaves no row");
}

#[tokio::test]
async fn defaults_and_patch_with_clamping() {
    let tc = TestCore::new().await;
    let s = settings_get(&tc).await.unwrap();
    assert_eq!(s, Settings::default());

    let s = settings_set(&tc, json!({"theme": "light", "zoom": 3.0, "initialCommits": 10, "autoFetchMinutes": 99, "externalEditor": "  "}))
        .await
        .unwrap();
    assert_eq!(s.theme, Theme::Light);
    assert_eq!(s.zoom, 2.0);
    assert_eq!(s.initial_commits, 500);
    assert_eq!(s.auto_fetch_minutes, 60);
    assert_eq!(s.external_editor, None);
    assert_eq!(tc.events.count(names::APP_CHANGED), 1);

    // Stored and still there after a restart.
    let tc = tc.restart().await;
    let s = settings_get(&tc).await.unwrap();
    assert_eq!(s.theme, Theme::Light);
    assert_eq!(s.zoom, 2.0);
    assert_eq!(s.default_pull_mode, PullMode::Ff);

    let err = settings_set(&tc, json!({"gibtsNicht": true})).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    let err = settings_set(&tc, json!({"theme": "lila"})).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    let err = settings_set(&tc, json!({"defaultBranchName": "a..b"})).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidName);
    let s = settings_set(&tc, json!({"defaultBranchName": " trunk ", "externalEditor": "code {path}"})).await.unwrap();
    assert_eq!(s.default_branch_name, "trunk");
    assert_eq!(s.external_editor.as_deref(), Some("code {path}"));
    let s = settings_set(&tc, json!({"externalEditor": null})).await.unwrap();
    assert_eq!(s.external_editor, None);
}

#[tokio::test]
async fn repo_settings_db_and_git_config() {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;

    let s = repo_settings_get(&tc, id.clone()).await.unwrap();
    assert_eq!(s.encoding, "utf-8");
    assert!(s.auto_fetch);
    // TestRepo sets user.name/user.email locally.
    assert_eq!(s.author_name.as_deref(), Some("Test Person"));
    assert_eq!(s.hooks_path, None);

    tc.events.clear();
    let s = repo_settings_set(
        &tc,
        id.clone(),
        json!({"encoding": "windows-1252", "autoFetch": false, "defaultPullMode": "rebase", "hooksPath": ".githooks", "authorName": null}),
    )
    .await
    .unwrap();
    assert_eq!(s.encoding, "windows-1252");
    assert!(!s.auto_fetch);
    assert_eq!(s.default_pull_mode, Some(PullMode::Rebase));
    assert_eq!(s.hooks_path.as_deref(), Some(".githooks"));
    assert_eq!(s.author_name, None);
    assert_eq!(repo.git(&["config", "--local", "core.hooksPath"]), ".githooks");
    assert!(!repo.git_output(&["config", "--local", "user.name"]).status.success());
    let changed = tc.events.named(names::REPO_CHANGED);
    assert_eq!(changed.len(), 1);
    assert_eq!(changed[0]["what"], json!(["config"]));

    let err = repo_settings_set(&tc, id.clone(), json!({"encoding": "klingonisch"})).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    let err = repo_settings_set(&tc, id.clone(), json!({"authorEmail": "kein-at"})).await.unwrap_err();
    assert_eq!(err.code, ErrorCode::NotAllowed);
    // Removing a key that is not set is not an error.
    repo_settings_set(&tc, id.clone(), json!({"commitTemplate": null})).await.unwrap();
}

/// The template usually lives outside the repository (`~/.gitmessage`): the core returns
/// its content as well, because the UI cannot read there.
#[tokio::test]
async fn commit_template_text_follows_the_effective_template() {
    let outside = tempfile::tempdir().unwrap();
    let template = outside.path().join("vorlage mit leer.txt");
    std::fs::write(&template, "Betreff\n\n# Kommentar\nGrüße\n").unwrap();
    let global = format!("[commit]\n\ttemplate = {}\n", template.to_string_lossy().replace('\\', "/"));
    let tc = TestCore::with_global_config(&global).await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;

    // Set globally: the repository's raw value stays empty, the text is there.
    let s = repo_settings_get(&tc, id.clone()).await.unwrap();
    assert_eq!(s.commit_template, None);
    assert_eq!(s.commit_template_text.as_deref(), Some("Betreff\n\n# Kommentar\nGrüße\n"));

    // Set locally (relative to the repository) takes precedence; windows-1252 is detected.
    repo.write_file("vorlagen/lokal.txt", b"Gr\xfc\xdfe lokal\r\n");
    let s = repo_settings_set(&tc, id.clone(), json!({"commitTemplate": "vorlagen/lokal.txt"})).await.unwrap();
    assert_eq!(s.commit_template.as_deref(), Some("vorlagen/lokal.txt"));
    assert_eq!(s.commit_template_text.as_deref(), Some("Grüße lokal\r\n"));

    // The field is read-only: a patch with it changes nothing and stores nothing.
    let s = repo_settings_set(&tc, id.clone(), json!({"commitTemplateText": "untergeschoben", "autoFetch": false})).await.unwrap();
    assert_eq!(s.commit_template_text.as_deref(), Some("Grüße lokal\r\n"));
    assert!(!s.auto_fetch);
    let stored = tc.db.with(|c| db::repo_settings::get_all(c, &id)).unwrap();
    assert!(!stored.iter().any(|(key, _)| key == "commitTemplateText"), "{stored:?}");

    // File missing, binary or a directory: no text, no error.
    for (value, content) in [("vorlagen/fehlt.txt", None), ("vorlagen/binaer.bin", Some(&b"a\0b"[..])), ("vorlagen", None)] {
        if let Some(content) = content {
            repo.write_file(value, content);
        }
        let s = repo_settings_set(&tc, id.clone(), json!({"commitTemplate": value})).await.unwrap();
        assert_eq!(s.commit_template_text, None, "{value}");
    }
    // Without a local value the global one applies again.
    let s = repo_settings_set(&tc, id.clone(), json!({"commitTemplate": null})).await.unwrap();
    assert_eq!(s.commit_template_text.as_deref(), Some("Betreff\n\n# Kommentar\nGrüße\n"));
}

/// Git resolves `~/…` against the home directory.
#[tokio::test]
async fn commit_template_text_resolves_the_home_directory() {
    let home = tempfile::tempdir().unwrap();
    std::fs::write(home.path().join(".gitmessage"), "Aus dem Heimatverzeichnis\n").unwrap();
    let dir = tempfile::tempdir().unwrap();
    let global = dir.path().join("gitconfig");
    std::fs::write(&global, "[commit]\n\ttemplate = ~/.gitmessage\n").unwrap();
    let events = std::sync::Arc::new(crate::events::EventCollector::new());
    let mut config = crate::app::CoreConfig::new(dir.path().join("data"), "0.0.0-test", events);
    config.git_env = crate::testkit::git_isolation_env(&global);
    config.git_env.push(("HOME".into(), home.path().as_os_str().to_os_string()));
    config.git_env.push(("USERPROFILE".into(), home.path().as_os_str().to_os_string()));
    let core = Core::open(config).await.unwrap();
    let repo = TestRepo::with_commit();
    let id = crate::commands::repos::repo_open(&core, repo.path().to_string_lossy().into_owned()).await.unwrap().repo.id;

    let s = repo_settings_get(&core, id.clone()).await.unwrap();
    assert_eq!(s.commit_template_text.as_deref(), Some("Aus dem Heimatverzeichnis\n"));
    // Locally with a tilde as well.
    std::fs::write(home.path().join("lokal.txt"), "Lokal mit Tilde\n").unwrap();
    let s = repo_settings_set(&core, id, json!({"commitTemplate": "~/lokal.txt"})).await.unwrap();
    assert_eq!(s.commit_template.as_deref(), Some("~/lokal.txt"));
    assert_eq!(s.commit_template_text.as_deref(), Some("Lokal mit Tilde\n"));
}
