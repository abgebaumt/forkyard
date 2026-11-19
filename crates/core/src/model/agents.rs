//! Coding agents (cockpit)

use super::*;

/// A coding-agent template of the user's own. Placeholders in `args`, `unattended_args` and
/// `resume_args`: `${task}`, `${taskFile}`, `${worktree}`, `${branch}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "agents.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AgentTemplate {
    /// `custom:<id>`.
    pub id: String,
    pub name: String,
    /// Program name (looked up on PATH) or full path.
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Extra arguments for “without prompts”; `None` = the switch is not available for this template.
    #[serde(default)]
    pub unattended_args: Option<Vec<String>>,
    /// Arguments for “Resume” (instead of `args`); `None` = no resume.
    #[serde(default)]
    pub resume_args: Option<Vec<String>>,
    /// The program reports “waiting”/“done” itself through `$FORKYARD_AGENT_HELPER`.
    #[serde(default)]
    pub status_hook: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "agents.ts"))]
#[serde(rename_all = "snake_case")]
pub enum AgentTemplateKind {
    Claude,
    Codex,
    Opencode,
    Custom,
}

/// A template as the start dialog and the settings show it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "agents.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AgentTemplateInfo {
    /// `claude`, `codex`, `opencode` or `custom:<id>`.
    pub id: String,
    pub kind: AgentTemplateKind,
    pub name: String,
    pub program: String,
    /// Where the program was found; `None` = not found (the template can't be started).
    pub path: Option<String>,
    pub version: Option<String>,
    /// Why “without prompts” is not available; `None` = available.
    pub unattended_blocked: Option<String>,
    /// What “without prompts” does not cover on this system (Windows: Claude Code still asks before commands).
    pub unattended_note: Option<String>,
    pub can_resume: bool,
    /// Status comes from the agent itself (“according to Claude Code”), not only from guessing.
    pub status_hook: bool,
    /// Sign-in of a found built-in tool; `None` for own programs and tools not found.
    pub login: Option<AiLoginState>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "agents.ts"))]
#[serde(rename_all = "snake_case")]
pub enum AgentStatus {
    #[default]
    Starting,
    Running,
    Waiting,
    Done,
    Failed,
    Stopped,
    /// Branch or worktree no longer exist.
    Orphaned,
}

/// Where the status comes from: the agent reported it (hook, terminal signal) or the core guesses
/// it (no screen change for a while).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "agents.ts"))]
#[serde(rename_all = "snake_case")]
pub enum AgentStatusSource {
    Agent,
    #[default]
    Guess,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "agents.ts"))]
#[serde(rename_all = "snake_case")]
pub enum AgentTestState {
    Running,
    Passed,
    Failed,
}

/// Last run of the repository's test command in the agent's worktree.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "agents.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AgentTestResult {
    pub state: AgentTestState,
    pub exit_code: Option<i32>,
    /// The last 4 KiB of stdout and stderr, redacted.
    pub output: String,
    pub started_at: IsoTime,
    pub finished_at: Option<IsoTime>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "agents.ts"))]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: String,
    /// The repository the agent was started from (undo, cleanup and the cockpit live there).
    pub repo_id: String,
    /// Repository row of the agent's worktree (status, diff, watcher); `None` once the folder is gone.
    pub worktree_repo_id: Option<String>,
    pub short_name: String,
    pub template_id: String,
    pub template_name: String,
    pub task: String,
    pub branch: String,
    pub worktree_path: String,
    /// What the user chose as the base (branch name or SHA) and the commit it resolved to.
    pub base: String,
    pub base_sha: String,
    pub unattended: bool,
    pub status: AgentStatus,
    pub status_source: AgentStatusSource,
    /// Terminal of the running session; `None` when no session runs.
    pub terminal_id: Option<String>,
    pub started_at: IsoTime,
    pub ended_at: Option<IsoTime>,
    pub exit_code: Option<i32>,
    /// Last non-empty screen line after a failure (redacted).
    pub last_line: Option<String>,
    pub changed_files: u32,
    /// Commits on the agent's branch that the base does not have.
    pub commits_ahead: u32,
    pub test: Option<AgentTestResult>,
}

/// Defaults for the start dialog, checked live.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "agents.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AgentSuggestion {
    pub short_name: String,
    pub branch: String,
    /// Why the branch can't be used (invalid name, already exists); `None` = fine.
    pub branch_problem: Option<String>,
    /// Folder the worktree will get.
    pub path: String,
    pub base_sha: String,
    /// Agent configurations in the base commit (`.claude/`, `.codex/`, `opencode.json`).
    pub configs: Vec<String>,
    /// Agents of this repository with a running session.
    pub running: u32,
}

/// What “Stop agent and clean up” would destroy.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "agents.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AgentCleanupPreview {
    /// Commits of the branch that are on no remote branch and not in the base.
    pub unpushed_commits: u32,
    pub changed_files: u32,
    pub running: bool,
    /// The worktree is locked (`git worktree lock`); cleaning up is refused.
    pub locked: bool,
}

/// Payload of `agents:changed`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "ts", derive(ts_rs::TS), ts(export, export_to = "agents.ts"))]
#[serde(rename_all = "camelCase")]
pub struct AgentsChangedEvent {
    /// The repository whose agents changed (status, start, end, cleanup).
    pub repo_id: String,
    /// Agents with a running session in all repositories (for the prompt when quitting).
    pub running: u32,
}

#[cfg(test)]
mod agent_json_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn agent_types_are_camel_case_and_template_options_default() {
        let template: AgentTemplate =
            serde_json::from_value(json!({ "id": "custom:1", "name": "Mein Agent", "program": "mein-agent" })).unwrap();
        assert_eq!(
            template,
            AgentTemplate {
                id: "custom:1".into(),
                name: "Mein Agent".into(),
                program: "mein-agent".into(),
                args: vec![],
                unattended_args: None,
                resume_args: None,
                status_hook: false
            }
        );
        let full =
            serde_json::to_value(AgentTemplate { unattended_args: Some(vec!["--yes".into()]), status_hook: true, ..template }).unwrap();
        assert_eq!(full["unattendedArgs"], json!(["--yes"]));
        assert_eq!(full["resumeArgs"], json!(null));
        assert_eq!(full["statusHook"], json!(true));

        let agent = Agent { status: AgentStatus::Waiting, status_source: AgentStatusSource::Agent, ..Agent::default() };
        let v = serde_json::to_value(&agent).unwrap();
        assert_eq!((v["status"].clone(), v["statusSource"].clone()), (json!("waiting"), json!("agent")));
        for key in ["worktreeRepoId", "terminalId", "endedAt", "exitCode", "lastLine", "test"] {
            assert!(v[key].is_null(), "{key}");
        }
        assert_eq!((v["changedFiles"].clone(), v["commitsAhead"].clone(), v["unattended"].clone()), (json!(0), json!(0), json!(false)));
        let back: Agent = serde_json::from_value(v).unwrap();
        assert_eq!(back, agent);
        assert_eq!(Agent::default().status, AgentStatus::Starting);
        assert_eq!(Agent::default().status_source, AgentStatusSource::Guess);

        let all = [
            AgentStatus::Starting,
            AgentStatus::Running,
            AgentStatus::Waiting,
            AgentStatus::Done,
            AgentStatus::Failed,
            AgentStatus::Stopped,
            AgentStatus::Orphaned,
        ];
        let names: Vec<serde_json::Value> = all.iter().map(|s| serde_json::to_value(s).unwrap()).collect();
        assert_eq!(
            names,
            vec![
                json!("starting"),
                json!("running"),
                json!("waiting"),
                json!("done"),
                json!("failed"),
                json!("stopped"),
                json!("orphaned")
            ]
        );
        assert_eq!(serde_json::to_value(AgentTemplateKind::Opencode).unwrap(), json!("opencode"));
        assert_eq!(serde_json::to_value(SectionId::Agents).unwrap(), json!("agents"));
        let test = AgentTestResult {
            state: AgentTestState::Passed,
            exit_code: Some(0),
            output: "ok".into(),
            started_at: "2026-10-16T08:00:00.000Z".into(),
            finished_at: None,
        };
        assert_eq!(serde_json::to_value(&test).unwrap()["startedAt"], json!("2026-10-16T08:00:00.000Z"));
        assert_eq!(
            serde_json::to_value(AgentsChangedEvent { repo_id: "r".into(), running: 2 }).unwrap(),
            json!({ "repoId": "r", "running": 2 })
        );

        // Old stored settings (without the field) still load; the default is an empty list.
        assert_eq!(serde_json::to_value(Settings::default()).unwrap()["agentTemplates"], json!([]));
        assert_eq!(serde_json::to_value(RepoSettings::default()).unwrap()["testCommand"], json!(null));
    }
}
