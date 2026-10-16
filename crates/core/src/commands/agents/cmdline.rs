//! Command lines of the agent templates. The UI only passes the template and the task; program,
//! arguments and environment are built here (rule 3). Only switches that bind writing to the
//! worktree are ever set; every result is checked against the bypass list once more.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

use super::templates::{self, TemplateDef};
use crate::error::{CoreError, CoreResult};
use crate::model::AgentTemplateKind;

pub const PORT_ENV: &str = "FORKYARD_AGENT_PORT";
pub const TOKEN_ENV: &str = "FORKYARD_AGENT_TOKEN";
/// Path of the status helper (the askpass helper in its `--agent-status` mode), for own templates.
pub const HELPER_ENV: &str = "FORKYARD_AGENT_HELPER";
pub const STATUS_FLAG: &str = "--agent-status";
pub const OPENCODE_CONFIG_ENV: &str = "OPENCODE_CONFIG_CONTENT";
pub const OPENCODE_UNATTENDED_CONFIG: &str = r#"{"permission":{"external_directory":"deny"}}"#;

/// Where status reports go: the channel's port and the agent's token, and the helper that the
/// CLIs' hooks start (`None` if it is missing next to the app).
pub struct StatusLink<'a> {
    pub port: u16,
    pub token: &'a str,
    pub helper: Option<&'a Path>,
}

pub struct LaunchInput<'a> {
    /// The program as found (full path).
    pub program: &'a Path,
    pub worktree: &'a Path,
    pub branch: &'a str,
    pub task: &'a str,
    pub task_file: &'a Path,
    pub settings_file: &'a Path,
    /// `None`: no status channel (helper missing) – the status is guessed.
    pub status: Option<StatusLink<'a>>,
    pub windows: bool,
    pub unattended: bool,
    pub resume: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    pub program: PathBuf,
    pub args: Vec<OsString>,
    pub env: Vec<(OsString, OsString)>,
    /// Content for `settings_file` (Claude Code `--settings`); `None` = no file.
    pub settings_json: Option<String>,
    /// The task is typed into the terminal after the start (bracketed paste + Enter).
    pub types_task: bool,
    /// The task is written to `task_file` before the start (`${taskFile}`).
    pub writes_task_file: bool,
}

/// `"<helper>" --agent-status <state>` for hooks that a shell runs. `None` if the path contains
/// something a shell would interpret (quotes, `$`, backticks, `%`, line breaks) or is not UTF-8.
pub fn hook_command(helper: &Path, state: &str) -> Option<String> {
    let path = helper.to_str()?;
    if path.chars().any(|c| matches!(c, '"' | '$' | '`' | '%' | '\n' | '\r')) {
        return None;
    }
    Some(format!("\"{path}\" {STATUS_FLAG} {state}"))
}

/// A TOML basic string (for `codex -c key=value`).
pub fn toml_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            c if c.is_control() => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn claude_settings(helper: Option<&Path>, sandbox: bool) -> Option<Value> {
    let mut settings = Map::new();
    if let Some(helper) = helper {
        let hook = |state: &str| hook_command(helper, state).map(|command| json!([{ "hooks": [{ "type": "command", "command": command }] }]));
        if let (Some(waiting), Some(done), Some(running)) = (hook("waiting"), hook("done"), hook("running")) {
            settings.insert("hooks".into(), json!({ "Notification": waiting, "Stop": done, "UserPromptSubmit": running }));
        }
    }
    if sandbox {
        settings.insert("sandbox".into(), json!({ "enabled": true, "autoAllowBashIfSandboxed": true }));
    }
    (!settings.is_empty()).then_some(Value::Object(settings))
}

fn codex_notify(helper: &Path) -> Option<String> {
    let path = helper.to_str()?;
    Some(format!("notify=[{},{},{}]", toml_string(path), toml_string(STATUS_FLAG), toml_string("done")))
}

fn is_batch(program: &Path) -> bool {
    program.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
}

/// Replaces the placeholders in one pass: a placeholder inside the task stays text.
fn substitute(arg: &str, input: &LaunchInput) -> String {
    let worktree = input.worktree.to_string_lossy();
    let task_file = input.task_file.to_string_lossy();
    let mut out = String::with_capacity(arg.len());
    let mut rest = arg;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        let replaced = [("${taskFile}", task_file.as_ref()), ("${task}", input.task), ("${worktree}", worktree.as_ref()), ("${branch}", input.branch)]
            .into_iter()
            .find(|(name, _)| tail.starts_with(name));
        match replaced {
            Some((name, value)) => {
                out.push_str(value);
                rest = &tail[name.len()..];
            }
            None => {
                out.push_str("${");
                rest = &tail[2..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Program, arguments and environment for a start (or a resume) of `def` in the worktree.
pub fn build(def: &TemplateDef, input: &LaunchInput) -> CoreResult<Launch> {
    let mut env: Vec<(OsString, OsString)> = Vec::new();
    if let Some(link) = &input.status {
        env.push((PORT_ENV.into(), link.port.to_string().into()));
        env.push((TOKEN_ENV.into(), link.token.into()));
        if let Some(helper) = link.helper {
            env.push((HELPER_ENV.into(), helper.as_os_str().to_os_string()));
        }
    }
    let helper = input.status.as_ref().and_then(|link| link.helper);
    let mut args: Vec<OsString> = Vec::new();
    let mut settings_json = None;
    let mut types_task = !input.resume;
    let mut writes_task_file = false;
    match def.kind {
        AgentTemplateKind::Claude => {
            if input.resume {
                args.push("--continue".into());
            }
            if let Some(settings) = claude_settings(helper, input.unattended && !input.windows) {
                args.push("--settings".into());
                args.push(input.settings_file.as_os_str().to_os_string());
                settings_json = Some(settings.to_string());
            }
            if input.unattended {
                args.extend(["--permission-mode", "acceptEdits"].map(OsString::from));
            }
        }
        AgentTemplateKind::Codex => {
            if input.resume {
                args.extend(["resume", "--last"].map(OsString::from));
            }
            args.push("-C".into());
            args.push(input.worktree.as_os_str().to_os_string());
            if let Some(notify) = helper.and_then(codex_notify) {
                args.push("-c".into());
                args.push(notify.into());
            }
            if input.unattended {
                args.extend(["--sandbox", "workspace-write", "--ask-for-approval", "never"].map(OsString::from));
            }
        }
        AgentTemplateKind::Opencode => {
            if input.resume {
                args.push("--continue".into());
            }
            if input.unattended {
                args.push("--auto".into());
                env.push((OPENCODE_CONFIG_ENV.into(), OPENCODE_UNATTENDED_CONFIG.into()));
            }
        }
        AgentTemplateKind::Custom => {
            let mut list = if input.resume {
                def.resume_args.clone().ok_or_else(|| CoreError::not_allowed(format!("The template “{}” has no arguments for “Resume”.", def.name)))?
            } else {
                def.args.clone()
            };
            if input.unattended {
                let extra = def
                    .unattended_args
                    .clone()
                    .ok_or_else(|| CoreError::not_allowed(format!("The template “{}” has no arguments for “without prompts”.", def.name)))?;
                list.extend(extra);
            }
            let inline_task = list.iter().any(|a| a.contains("${task}"));
            if inline_task && is_batch(input.program) {
                return Err(CoreError::not_allowed(format!(
                    "“{}” is a batch file; it can't get the task as an argument. Use ${{taskFile}} in the template instead.",
                    def.program
                )));
            }
            writes_task_file = list.iter().any(|a| a.contains("${taskFile}"));
            types_task = !input.resume && !inline_task && !writes_task_file;
            args.extend(list.iter().map(|arg| OsString::from(substitute(arg, input))));
        }
    }
    let shown: Vec<String> = args.iter().map(|a| a.to_string_lossy().into_owned()).chain(settings_json.clone()).collect();
    if let Some(flag) = templates::has_bypass(&shown) {
        return Err(CoreError::not_allowed(format!("The command line would contain “{flag}”; Forkyard does not start it.")));
    }
    Ok(Launch { program: input.program.to_path_buf(), args, env, settings_json, types_task, writes_task_file })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::agents::templates::{find, from_custom};
    use crate::model::AgentTemplate;
    use serde_json::{json, Value};

    const WT: &str = "/home/anna/Mein Projekt.agents/fix-login";
    const HELPER: &str = "/opt/Forkyard/forkyard-askpass";
    const SETTINGS: &str = "/data/agents/a1/claude-settings.json";
    const TASK_FILE: &str = "/data/agents/a1/task.md";
    const TASK: &str = "Fix \"login\" in ${worktree}\nand `$HOME`";

    fn input(unattended: bool, resume: bool, windows: bool, with_status: bool, program: &'static str) -> LaunchInput<'static> {
        LaunchInput {
            program: Path::new(program),
            worktree: Path::new(WT),
            branch: "agent/fix-login",
            task: TASK,
            task_file: Path::new(TASK_FILE),
            settings_file: Path::new(SETTINGS),
            status: with_status.then(|| StatusLink { port: 40123, token: "tok3n", helper: Some(Path::new(HELPER)) }),
            windows,
            unattended,
            resume,
        }
    }

    fn strings(launch: &Launch) -> Vec<String> {
        launch.args.iter().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    fn settings(launch: &Launch) -> Value {
        serde_json::from_str(launch.settings_json.as_deref().expect("settings file")).unwrap()
    }

    #[test]
    fn claude_code_gets_hooks_and_only_worktree_bound_switches() {
        let claude = find(&[], "claude").unwrap();
        let ask = build(&claude, &input(false, false, false, true, "/usr/bin/claude")).unwrap();
        assert_eq!(strings(&ask), vec!["--settings", SETTINGS]);
        let s = settings(&ask);
        assert_eq!(s["hooks"]["Notification"][0]["hooks"][0], json!({ "type": "command", "command": "\"/opt/Forkyard/forkyard-askpass\" --agent-status waiting" }));
        assert_eq!(s["hooks"]["Stop"][0]["hooks"][0]["command"], json!("\"/opt/Forkyard/forkyard-askpass\" --agent-status done"));
        assert_eq!(s["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"], json!("\"/opt/Forkyard/forkyard-askpass\" --agent-status running"));
        assert!(s.get("sandbox").is_none(), "the prompting mode sets no sandbox");
        assert!(ask.types_task && !ask.writes_task_file);
        let env: Vec<(String, String)> = ask.env.iter().map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned())).collect();
        assert_eq!(env, vec![("FORKYARD_AGENT_PORT".into(), "40123".into()), ("FORKYARD_AGENT_TOKEN".into(), "tok3n".into()), ("FORKYARD_AGENT_HELPER".into(), HELPER.into())]);

        let free = build(&claude, &input(true, false, false, true, "/usr/bin/claude")).unwrap();
        assert_eq!(strings(&free), vec!["--settings", SETTINGS, "--permission-mode", "acceptEdits"]);
        assert_eq!(settings(&free)["sandbox"], json!({ "enabled": true, "autoAllowBashIfSandboxed": true }));
        // Windows: only acceptEdits, no sandbox.
        let windows = build(&claude, &input(true, false, true, true, r"C:\Users\Jörg\.local\bin\claude.exe")).unwrap();
        assert_eq!(strings(&windows), vec!["--settings", SETTINGS, "--permission-mode", "acceptEdits"]);
        assert!(settings(&windows).get("sandbox").is_none());
        // Resume: same switches, `--continue`, nothing typed.
        let resume = build(&claude, &input(true, true, false, true, "/usr/bin/claude")).unwrap();
        assert_eq!(strings(&resume), vec!["--continue", "--settings", SETTINGS, "--permission-mode", "acceptEdits"]);
        assert!(!resume.types_task);
        // Without the helper: no hooks; nothing to put into a settings file in the prompting mode.
        let bare = build(&claude, &input(false, false, false, false, "/usr/bin/claude")).unwrap();
        assert!(strings(&bare).is_empty() && bare.settings_json.is_none() && bare.env.is_empty());
    }

    #[test]
    fn codex_gets_notify_and_the_workspace_sandbox() {
        let codex = find(&[], "codex").unwrap();
        let notify = "notify=[\"/opt/Forkyard/forkyard-askpass\",\"--agent-status\",\"done\"]";
        let ask = build(&codex, &input(false, false, false, true, "/usr/bin/codex")).unwrap();
        assert_eq!(strings(&ask), vec!["-C", WT, "-c", notify]);
        let free = build(&codex, &input(true, false, false, true, "/usr/bin/codex")).unwrap();
        assert_eq!(strings(&free), vec!["-C", WT, "-c", notify, "--sandbox", "workspace-write", "--ask-for-approval", "never"]);
        let resume = build(&codex, &input(true, true, false, true, "/usr/bin/codex")).unwrap();
        assert_eq!(strings(&resume)[..2], ["resume".to_string(), "--last".to_string()]);
        assert!(resume.settings_json.is_none());
        // A Windows helper path is a valid TOML string (backslashes escaped).
        assert_eq!(toml_string(r"C:\Program Files\Forkyard\forkyard-askpass.exe"), r#""C:\\Program Files\\Forkyard\\forkyard-askpass.exe""#);
        assert_eq!(toml_string("a\"b\u{7}"), r#""a\"b\u0007""#);
    }

    #[test]
    fn opencode_runs_auto_only_with_the_external_directory_rule() {
        let opencode = find(&[], "opencode").unwrap();
        let ask = build(&opencode, &input(false, false, false, true, "/usr/bin/opencode")).unwrap();
        assert!(strings(&ask).is_empty(), "no positional argument: it would be the project path");
        assert!(ask.env.iter().all(|(k, _)| k != OPENCODE_CONFIG_ENV));
        let free = build(&opencode, &input(true, false, false, true, "/usr/bin/opencode")).unwrap();
        assert_eq!(strings(&free), vec!["--auto"]);
        let config = free.env.iter().find(|(k, _)| k == OPENCODE_CONFIG_ENV).map(|(_, v)| v.to_string_lossy().into_owned()).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&config).unwrap(), json!({ "permission": { "external_directory": "deny" } }));
        assert_eq!(strings(&build(&opencode, &input(false, true, false, true, "/usr/bin/opencode")).unwrap()), vec!["--continue"]);
    }

    #[test]
    fn own_templates_substitute_placeholders_in_one_pass() {
        let template = AgentTemplate {
            id: "custom:aider".into(),
            name: "Aider".into(),
            program: "aider".into(),
            args: vec!["--message-file".into(), "${taskFile}".into(), "--cwd=${worktree}".into(), "--branch".into(), "${branch}".into()],
            unattended_args: Some(vec!["--yes-always".into()]),
            resume_args: Some(vec!["--restore-chat-history".into()]),
            status_hook: false,
        };
        let def = from_custom(&template);
        let ask = build(&def, &input(false, false, false, true, "/usr/bin/aider")).unwrap();
        assert_eq!(strings(&ask), vec!["--message-file", TASK_FILE, &format!("--cwd={WT}"), "--branch", "agent/fix-login"]);
        assert!(ask.writes_task_file && !ask.types_task, "the task goes through the file");
        let free = build(&def, &input(true, false, false, true, "/usr/bin/aider")).unwrap();
        assert_eq!(strings(&free).last().map(String::as_str), Some("--yes-always"));
        assert_eq!(strings(&build(&def, &input(false, true, false, true, "/usr/bin/aider")).unwrap()), vec!["--restore-chat-history"]);

        // `${task}` is one argument, byte for byte; placeholders inside the task stay text.
        let inline = from_custom(&AgentTemplate { args: vec!["--prompt".into(), "${task}".into()], ..template.clone() });
        let launch = build(&inline, &input(false, false, false, true, "/usr/bin/aider")).unwrap();
        assert_eq!(strings(&launch), vec!["--prompt", TASK]);
        assert!(!launch.types_task && !launch.writes_task_file);
        // Batch files get no user text as an argument (cmd.exe would interpret it).
        let err = build(&inline, &input(false, false, true, true, r"C:\tools\agent.CMD")).unwrap_err();
        assert_eq!(err.code, crate::ErrorCode::NotAllowed);
        assert!(err.message.contains("${taskFile}"), "{}", err.message);
        // Without own arguments the template types the task; without resume/unattended arguments both are refused.
        let plain = from_custom(&AgentTemplate { args: vec![], unattended_args: None, resume_args: None, ..template });
        assert!(build(&plain, &input(false, false, false, true, "/usr/bin/aider")).unwrap().types_task);
        assert_eq!(build(&plain, &input(true, false, false, true, "/usr/bin/aider")).unwrap_err().code, crate::ErrorCode::NotAllowed);
        assert_eq!(build(&plain, &input(false, true, false, true, "/usr/bin/aider")).unwrap_err().code, crate::ErrorCode::NotAllowed);
    }

    #[test]
    fn no_combination_ever_contains_a_bypass_switch() {
        for id in ["claude", "codex", "opencode"] {
            let def = find(&[], id).unwrap();
            for unattended in [false, true] {
                for resume in [false, true] {
                    for windows in [false, true] {
                        let launch = build(&def, &input(unattended, resume, windows, true, "/usr/bin/x")).unwrap();
                        let mut all = strings(&launch);
                        all.extend(launch.settings_json.clone());
                        all.extend(launch.env.iter().map(|(_, v)| v.to_string_lossy().into_owned()));
                        assert_eq!(crate::commands::agents::templates::has_bypass(&all), None, "{id} {unattended} {resume} {windows}: {all:?}");
                        assert!(!all.iter().any(|a| a.to_lowercase().contains("bypass") || a.contains("dangerously")), "{all:?}");
                    }
                }
            }
        }
        // A helper path a shell would interpret gets no hook (status is guessed instead).
        assert_eq!(hook_command(Path::new("/opt/$(rm)/helper"), "done"), None);
        assert_eq!(hook_command(Path::new("/opt/a\"b/helper"), "done"), None);
        assert_eq!(hook_command(Path::new("/opt/Forkyard Ä/helper"), "done").as_deref(), Some("\"/opt/Forkyard Ä/helper\" --agent-status done"));
    }
}
