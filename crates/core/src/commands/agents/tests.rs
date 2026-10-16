//! Tests of the coding-agent commands against real temp repositories.

use std::path::{Path, PathBuf};
use std::process::Command;

use super::*;
use crate::error::ErrorCode;
use crate::testkit::{git_isolation_env, TestCore, TestRepo};

pub(super) async fn setup() -> (TestCore, TestRepo, String) {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    (tc, repo, id)
}

/// `<temp>/repo.agents/<name>` written out from Entscheidung 3 – not from `names::agents_dir`.
pub(super) fn expected_folder(repo: &TestRepo, name: &str) -> PathBuf {
    repo.temp_dir().join("repo.agents").join(name)
}

fn same(a: &str, b: &Path) -> bool {
    crate::util::path_key(Path::new(a)) == crate::util::path_key(b)
}

#[tokio::test]
async fn the_suggestion_avoids_taken_folders_branches_and_names() {
    let (tc, repo, id) = setup().await;
    let task = "Fix the login".to_string();
    let first = agent_suggest(&tc, id.clone(), task.clone(), None, None).await.unwrap();
    assert_eq!((first.short_name.as_str(), first.branch.as_str(), first.branch_problem.as_deref()), ("fix-the-login", "agent/fix-the-login", None));
    assert!(same(&first.path, &expected_folder(&repo, "fix-the-login")), "{}", first.path);
    assert_eq!(first.base_sha, repo.head());
    assert_eq!((first.configs.len(), first.running), (0, 0));

    // A folder of that name exists already → -2; then the branch agent/fix-the-login-2 exists → -3.
    std::fs::create_dir_all(expected_folder(&repo, "fix-the-login")).unwrap();
    let second = agent_suggest(&tc, id.clone(), task.clone(), None, None).await.unwrap();
    assert_eq!(second.short_name, "fix-the-login-2");
    repo.branch("agent/fix-the-login-2");
    let third = agent_suggest(&tc, id.clone(), task.clone(), None, None).await.unwrap();
    assert_eq!((third.short_name.as_str(), third.branch.as_str()), ("fix-the-login-3", "agent/fix-the-login-3"));
    assert!(same(&third.path, &expected_folder(&repo, "fix-the-login-3")));

    // An edited branch is checked live: invalid, existing, leading "-".
    let edited = agent_suggest(&tc, id.clone(), task.clone(), Some("agent/fix-the-login-2".into()), None).await.unwrap();
    assert_eq!(edited.branch_problem.as_deref(), Some("A branch “agent/fix-the-login-2” already exists."));
    let invalid = agent_suggest(&tc, id.clone(), task.clone(), Some("agent/mit leer".into()), None).await.unwrap();
    assert_eq!(invalid.branch_problem.as_deref(), Some("The name must not contain spaces."));
    let dash = agent_suggest(&tc, id.clone(), task.clone(), Some("-x".into()), None).await.unwrap();
    assert_eq!(dash.branch_problem.as_deref(), Some("The name must not start with “-”."));
    let free = agent_suggest(&tc, id.clone(), task.clone(), Some("feature/Größe".into()), None).await.unwrap();
    assert_eq!((free.short_name.as_str(), free.branch_problem.as_deref()), ("feature-groesse", None));
    // An unknown base and one starting with "-" are refused.
    assert_eq!(agent_suggest(&tc, id.clone(), task.clone(), None, Some("gibt-es-nicht".into())).await.unwrap_err().code, ErrorCode::NotFound);
    assert_eq!(agent_suggest(&tc, id.clone(), task, None, Some("--all".into())).await.unwrap_err().code, ErrorCode::NotFound);
}

#[tokio::test]
async fn agent_configurations_are_read_from_the_base_commit() {
    let (tc, repo, id) = setup().await;
    repo.write_file(".claude/settings.json", "{}\n");
    repo.write_file("opencode.json", "{}\n");
    repo.commit("Agent-Konfiguration");
    repo.checkout_new("mit-codex");
    repo.write_file(".codex/config.toml", "model = \"x\"\n");
    repo.commit("Codex");
    repo.checkout("main");
    // Untracked in the main folder: not in the base commit, so the agent's worktree won't have it.
    std::fs::create_dir_all(repo.path().join(".codex")).unwrap();
    let on_main = agent_suggest(&tc, id.clone(), "x".into(), None, None).await.unwrap();
    assert_eq!(on_main.configs, vec![".claude/".to_string(), "opencode.json".to_string()]);
    let on_branch = agent_suggest(&tc, id.clone(), "x".into(), None, Some("mit-codex".into())).await.unwrap();
    assert_eq!(on_branch.configs, vec![".claude/".to_string(), ".codex/".to_string(), "opencode.json".to_string()]);
    assert_eq!(on_branch.base_sha, repo.git(&["rev-parse", "mit-codex"]));
}

#[tokio::test]
async fn the_agents_folder_follows_the_main_worktree_even_with_spaces_and_umlauts() {
    let tc = TestCore::new().await;
    let origin = TestRepo::with_commit();
    let parent = origin.temp_dir().join("Mein Projekt Ä");
    std::fs::create_dir_all(&parent).unwrap();
    let clone = parent.join("web app");
    let global = origin.temp_dir().join("gitconfig");
    let mut cmd = Command::new("git");
    cmd.arg("clone").arg("-q").arg(origin.path()).arg(&clone);
    for (key, value) in git_isolation_env(&global) {
        cmd.env(key, value);
    }
    assert!(cmd.status().unwrap().success());
    let opened = crate::commands::repos::repo_open(&tc, clone.to_string_lossy().into_owned()).await.unwrap();
    crate::commands::trust::repo_trust_set(&tc, opened.repo.id.clone(), true).await.unwrap();
    let suggestion = agent_suggest(&tc, opened.repo.id.clone(), "Größe anpassen".into(), None, None).await.unwrap();
    assert!(same(&suggestion.path, &parent.join("web app.agents").join("groesse-anpassen")), "{}", suggestion.path);

    // Opened from a linked worktree, the folder still sits next to the main worktree.
    let (tc2, repo, _) = setup().await;
    let linked = repo.temp_dir().join("neben");
    repo.git(&["worktree", "add", "-q", &linked.to_string_lossy(), "-b", "neben"]);
    let from_linked = crate::commands::repos::repo_open(&tc2, linked.to_string_lossy().into_owned()).await.unwrap();
    let s = agent_suggest(&tc2, from_linked.repo.id, "Neben".into(), None, None).await.unwrap();
    assert!(same(&s.path, &expected_folder(&repo, "neben")), "{}", s.path);
}
#[test]
fn porcelain_v2_entries_are_counted_once_each() {
    // Written by hand: one modified file, one rename (its original path is an extra NUL field),
    // one conflict, two untracked – a path with a space, an umlaut and a leading "-".
    let out = "1 .M N... 100644 100644 100644 a a src/a.rs\x002 R. N... 100644 100644 100644 b b R100 neu name.txt\x00alt name.txt\x00u UU N... 100644 100644 100644 100644 c c c konflikt.txt\x00? -Größe.md\x00? ordner/datei mit leer.txt\x00".as_bytes();
    assert_eq!(count_status_entries(out), 5);
    assert_eq!(count_status_entries(b""), 0);
    assert_eq!(count_status_entries(b"# branch.oid abc\x00? x\x00"), 1, "header lines are no entries");
}

#[tokio::test]
async fn templates_list_built_ins_first_and_find_own_programs_by_path() {
    let (tc, repo, _) = setup().await;
    let program = repo.temp_dir().join("Mein Agent.sh");
    std::fs::write(&program, "#!/bin/sh\n").unwrap();
    let missing = repo.temp_dir().join("fehlt").join("agent");
    let mine = serde_json::json!({ "agentTemplates": [
        { "id": "custom:da", "name": "Da", "program": program.to_string_lossy(), "args": [], "resumeArgs": ["--weiter"] },
        { "id": "custom:weg", "name": "Weg", "program": missing.to_string_lossy(), "args": [], "unattendedArgs": ["--ja"] },
    ] });
    crate::commands::settings::settings_set(&tc, mine).await.unwrap();
    let list = agent_templates(&tc).await.unwrap();
    let ids: Vec<&str> = list.iter().map(|t| t.id.as_str()).collect();
    assert_eq!(ids, vec!["claude", "codex", "opencode", "custom:da", "custom:weg"]);
    let da = &list[3];
    assert!(same(da.path.as_deref().unwrap(), &program), "{:?}", da.path);
    assert_eq!((da.version.as_deref(), da.can_resume, da.status_hook), (None, true, false), "the script prints no version");
    assert!(da.unattended_blocked.is_some(), "no unattended arguments");
    let weg = &list[4];
    assert_eq!((weg.path.as_deref(), weg.can_resume, weg.unattended_blocked.as_deref()), (None, false, None));
    assert!(list[0].status_hook && list[1].status_hook && !list[2].status_hook);
}

#[tokio::test]
async fn after_a_restart_unfinished_sessions_count_as_closed_by_the_app() {
    let (tc, repo, id) = setup().await;
    let folder = expected_folder(&repo, "alt");
    std::fs::create_dir_all(folder.parent().unwrap()).unwrap();
    repo.git(&["worktree", "add", "-q", "-b", "agent/alt", &folder.to_string_lossy()]);
    let row = db::agents::AgentRow {
        id: "a-alt".into(),
        repo_id: id.clone(),
        short_name: "alt".into(),
        template_id: "claude".into(),
        task: "Alt".into(),
        branch: "agent/alt".into(),
        worktree_path: folder.to_string_lossy().into_owned(),
        base: "main".into(),
        base_sha: repo.head(),
        unattended: true,
        started_at: "2026-10-15T20:00:00.000Z".into(),
        ended_at: None,
        exit_code: None,
        end_reason: None,
    };
    tc.db.with(|c| db::agents::insert(c, &row)).unwrap();
    let tc = tc.restart().await;
    tc.startup_cleanup().await.unwrap();
    let stored = tc.db.with(|c| db::agents::require(c, "a-alt")).unwrap();
    assert_eq!(stored.end_reason, Some(db::agents::EndReason::AppClosed));
    assert!(stored.ended_at.is_some());
    let listed = agent_list(&tc, id.clone()).await.unwrap();
    assert_eq!((listed[0].status, listed[0].unattended, listed[0].terminal_id.as_deref()), (AgentStatus::Stopped, true, None));
    assert_eq!(reconcile_on_start(&tc).unwrap(), 0, "nothing left to reconcile");
}
