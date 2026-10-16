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
