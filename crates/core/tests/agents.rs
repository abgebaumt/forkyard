//! Coding agents end to end in the core: start in an own worktree with the fake agent as an own
//! template, the task typed by bracketed paste, status from the agent's report and from its end,
//! the overview list. Expected values come from Git (`worktree list`, `rev-parse`, `status`) and
//! from the fake agent's log, never from the core's own helpers.
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use gitcore::commands::agents::{agent_list, agent_start};
use gitcore::model::{Agent, AgentStatus, AgentStatusSource};
use gitcore::testkit::{TestCore, TestRepo};
use gitcore::ErrorCode;

const FAKE: &str = env!("CARGO_BIN_EXE_forkyard-fake-agent");
const WAIT: Duration = Duration::from_secs(60);

pub struct Fixture {
    pub tc: TestCore,
    pub repo: TestRepo,
    pub id: String,
    pub log: PathBuf,
}

pub async fn fixture(extra: &[&str]) -> Fixture {
    let tc = TestCore::new().await;
    let repo = TestRepo::with_commit();
    let id = tc.open(&repo).await.repo.id;
    let log = repo.temp_dir().join("fake agent.log");
    let mut args = vec!["--log".to_string(), log.to_string_lossy().into_owned()];
    args.extend(extra.iter().map(|a| a.to_string()));
    let templates = serde_json::json!({ "agentTemplates": [
        { "id": "custom:fake", "name": "Fake", "program": FAKE, "args": args, "statusHook": true, "resumeArgs": ["--log", log.to_string_lossy()] },
    ] });
    gitcore::commands::settings::settings_set(&tc, templates).await.unwrap();
    Fixture { tc, repo, id, log }
}

pub fn log_text(f: &Fixture) -> String {
    std::fs::read_to_string(&f.log).unwrap_or_default()
}

pub async fn wait_for(what: &str, mut check: impl FnMut() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !check() {
        assert!(Instant::now() < deadline, "timeout: {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

pub async fn wait_status(f: &Fixture, agent: &str, wanted: AgentStatus) -> Agent {
    let deadline = Instant::now() + WAIT;
    loop {
        let list = agent_list(&f.tc, f.id.clone()).await.unwrap();
        let found = list.into_iter().find(|a| a.id == agent).expect("agent listed");
        if found.status == wanted {
            return found;
        }
        assert!(Instant::now() < deadline, "timeout waiting for {wanted:?}, last {:?}", found.status);
        tokio::time::sleep(Duration::from_millis(80)).await;
    }
}

fn same(a: &str, b: &Path) -> bool {
    gitcore::util::path_key(Path::new(a)) == gitcore::util::path_key(b)
}

#[tokio::test]
async fn an_agent_starts_in_its_own_worktree_gets_its_task_and_reports_waiting() {
    let f = fixture(&[]).await;
    let task = "Größe der Übersicht anpassen\nZweite Zeile mit \"Anführung\" und ${worktree}";
    let agent = agent_start(&f.tc, f.id.clone(), "custom:fake".into(), task.into(), "agent/groesse".into(), "main".into(), false, 120, 40).await.unwrap();
    let folder = f.repo.temp_dir().join("repo.agents").join("groesse");
    assert!(same(&agent.worktree_path, &folder), "{}", agent.worktree_path);
    assert_eq!((agent.short_name.as_str(), agent.branch.as_str(), agent.base.as_str()), ("groesse", "agent/groesse", "main"));
    assert_eq!(agent.base_sha, f.repo.head());
    // Git knows the worktree with the new branch at the base.
    let listed = f.repo.git(&["worktree", "list", "--porcelain"]);
    assert!(listed.contains(&format!("worktree {}", folder.display())), "{listed}");
    assert!(listed.contains("branch refs/heads/agent/groesse"), "{listed}");
    assert_eq!(f.repo.git(&["rev-parse", "agent/groesse"]), f.repo.head());
    // The worktree has its own trusted repository row, but is not in the repository list.
    let repos = gitcore::commands::repos::repo_list(&f.tc).await.unwrap();
    assert!(repos.iter().all(|r| !same(&r.path, &folder)), "{repos:?}");
    let row = f.tc.db.with(|c| gitcore::db::repos::find_by_path(c, &folder)).unwrap().expect("own row");
    assert!(row.trusted);
    assert_eq!(agent.worktree_repo_id.as_deref(), Some(row.id.as_str()));

    // The fake agent ran in the worktree, got the status environment and the task byte for byte.
    wait_for("the typed task", || log_text(&f).contains("task: ")).await;
    let log = log_text(&f);
    assert!(log.contains(&format!("cwd: {}", folder.display())), "{log}");
    assert!(log.contains("env FORKYARD_AGENT_PORT: set") && log.contains("env FORKYARD_AGENT_TOKEN: set"), "{log}");
    assert!(log.contains("task: Größe der Übersicht anpassen\\nZweite Zeile mit \"Anführung\" und ${worktree}"), "{log}");
    assert_eq!(std::fs::read(folder.join("AGENT_RESULT.md")).unwrap(), task.as_bytes());

    // Its report makes it "waiting for you", according to the agent.
    let waiting = wait_status(&f, &agent.id, AgentStatus::Waiting).await;
    assert_eq!(waiting.status_source, AgentStatusSource::Agent);
    let porcelain = std::process::Command::new("git").args(["status", "--porcelain", "--untracked-files=all"]).current_dir(&folder).output().unwrap();
    let expected = String::from_utf8_lossy(&porcelain.stdout).lines().count() as u32;
    assert_eq!((waiting.changed_files, expected), (1, 1));
    assert!(waiting.terminal_id.is_some());
    assert!(!f.tc.events.named("agents:changed").is_empty());
    assert_eq!(f.tc.events.named("agents:changed").last().unwrap()["repoId"], serde_json::json!(f.id));

    // "exit 3": failed with exit code and the last screen line.
    gitcore::commands::terminal::terminal_write(&f.tc, waiting.terminal_id.clone().unwrap(), "exit 3\r".into()).await.unwrap();
    let failed = wait_status(&f, &agent.id, AgentStatus::Failed).await;
    assert_eq!((failed.exit_code, failed.terminal_id.as_deref()), (Some(3), None));
    assert_eq!(failed.last_line.as_deref(), Some("last words before exit"));
    let stored = f.tc.db.with(|c| gitcore::db::agents::require(c, &agent.id)).unwrap();
    assert_eq!((stored.exit_code, stored.end_reason), (Some(3), Some(gitcore::db::agents::EndReason::Exited)));
    assert!(stored.ended_at.is_some());
}

#[tokio::test]
async fn an_agent_that_ends_with_zero_is_done() {
    let f = fixture(&["--exit-after-task", "0"]).await;
    let agent = agent_start(&f.tc, f.id.clone(), "custom:fake".into(), "Kurz".into(), "agent/kurz".into(), "main".into(), false, 80, 24).await.unwrap();
    // The agent's own "done" report comes just before its exit (a soft "done" while the program
    // still runs); the final status is the one after the program has ended.
    let deadline = Instant::now() + WAIT;
    let done = loop {
        let found = wait_status(&f, &agent.id, AgentStatus::Done).await;
        if found.terminal_id.is_none() {
            break found;
        }
        assert!(Instant::now() < deadline, "timeout waiting for the program to end");
        tokio::time::sleep(Duration::from_millis(80)).await;
    };
    assert_eq!((done.exit_code, done.terminal_id), (Some(0), None));
    assert_eq!(f.tc.state::<gitcore::commands::agents::registry::AgentRegistry>().running_total(), 0);
}

#[tokio::test]
async fn start_refuses_bad_input_and_leaves_nothing_behind() {
    let f = fixture(&[]).await;
    let start = |template: &str, branch: &str, base: &str| {
        agent_start(&f.tc, f.id.clone(), template.to_string(), "Etwas tun".into(), branch.to_string(), base.to_string(), false, 80, 24)
    };
    assert_eq!(start("custom:gibt-es-nicht", "agent/a", "main").await.unwrap_err().code, ErrorCode::NotAllowed);
    assert_eq!(start("custom:fake", "agent/mit leer", "main").await.unwrap_err().code, ErrorCode::InvalidName);
    assert_eq!(start("custom:fake", "-x", "main").await.unwrap_err().code, ErrorCode::InvalidName);
    assert_eq!(start("custom:fake", "main", "main").await.unwrap_err().code, ErrorCode::NameExists);
    assert_eq!(start("custom:fake", "agent/b", "--all").await.unwrap_err().code, ErrorCode::NotFound);
    let empty = agent_start(&f.tc, f.id.clone(), "custom:fake".into(), "   ".into(), "agent/c".into(), "main".into(), false, 80, 24).await.unwrap_err();
    assert_eq!(empty.code, ErrorCode::NotAllowed);
    // A template whose program is missing: refused before anything is created.
    let missing = serde_json::json!({ "agentTemplates": [{ "id": "custom:weg", "name": "Weg", "program": "/gibt/es/nicht/agent", "args": [] }] });
    gitcore::commands::settings::settings_set(&f.tc, missing).await.unwrap();
    assert_eq!(start("custom:weg", "agent/d", "main").await.unwrap_err().code, ErrorCode::NotAllowed);
    // "Without prompts" for a template without unattended arguments.
    let unattended = agent_start(&f.tc, f.id.clone(), "custom:weg".into(), "x".into(), "agent/e".into(), "main".into(), true, 80, 24).await.unwrap_err();
    assert_eq!(unattended.code, ErrorCode::NotAllowed);
    assert!(!f.repo.temp_dir().join("repo.agents").join("d").exists());
    assert_eq!(f.repo.git(&["branch", "--list", "agent/*"]), "");
    assert_eq!(f.repo.git(&["worktree", "list", "--porcelain"]).matches("worktree ").count(), 1);
    assert!(agent_list(&f.tc, f.id.clone()).await.unwrap().is_empty());
    // An untrusted repository: repo_untrusted, nothing created.
    f.tc.db.with(|c| gitcore::db::repos::set_trusted(c, &f.id, false)).unwrap();
    assert_eq!(start("custom:fake", "agent/f", "main").await.unwrap_err().code, ErrorCode::RepoUntrusted);
}
