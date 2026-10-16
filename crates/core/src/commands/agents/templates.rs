//! Coding-agent templates: the built-in ones (Claude Code, Codex, opencode) and the user's own
//! (Settings › Coding agents, global). Own templates are checked on saving: known placeholders
//! only, never one of the bypass switches – not in the arguments, not for “without prompts”,
//! not for “Resume”.

use crate::error::{CoreError, CoreResult};
use crate::model::{AgentTemplate, AgentTemplateKind};

pub const CLAUDE: &str = "claude";
pub const CODEX: &str = "codex";
pub const OPENCODE: &str = "opencode";
pub const CUSTOM_PREFIX: &str = "custom:";
pub const MAX_CUSTOM_TEMPLATES: usize = 20;
const MAX_ARG_CHARS: usize = 4096;
const MAX_NAME_CHARS: usize = 60;

/// Switches that lift the CLIs' safety limits. Forkyard never sets them, and own templates must
/// not carry them (compared case-insensitively, also inside a longer argument).
pub const FORBIDDEN_FLAGS: [&str; 4] = [
    "--dangerously-skip-permissions",
    "bypassPermissions",
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
];

pub const PLACEHOLDERS: [&str; 4] = ["${task}", "${taskFile}", "${worktree}", "${branch}"];

/// opencode knows `permission.external_directory` (keeps “without prompts” inside the worktree)
/// from this version on; checked with 1.17.15.
pub const OPENCODE_MIN_UNATTENDED: (u64, u64, u64) = (1, 17, 0);

/// A template as the core starts it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TemplateDef {
    pub id: String,
    pub kind: AgentTemplateKind,
    pub name: String,
    pub program: String,
    /// Own templates only; the built-in ones get their arguments in `cmdline`.
    pub args: Vec<String>,
    pub unattended_args: Option<Vec<String>>,
    pub resume_args: Option<Vec<String>>,
    pub status_hook: bool,
}

fn builtin(id: &str, kind: AgentTemplateKind, name: &str, status_hook: bool) -> TemplateDef {
    TemplateDef { id: id.into(), kind, name: name.into(), program: id.into(), args: Vec::new(), unattended_args: None, resume_args: None, status_hook }
}

pub fn builtins() -> Vec<TemplateDef> {
    vec![
        builtin(CLAUDE, AgentTemplateKind::Claude, "Claude Code", true),
        builtin(CODEX, AgentTemplateKind::Codex, "Codex", true),
        builtin(OPENCODE, AgentTemplateKind::Opencode, "opencode", false),
    ]
}

pub fn from_custom(template: &AgentTemplate) -> TemplateDef {
    TemplateDef {
        id: template.id.clone(),
        kind: AgentTemplateKind::Custom,
        name: template.name.clone(),
        program: template.program.clone(),
        args: template.args.clone(),
        unattended_args: template.unattended_args.clone(),
        resume_args: template.resume_args.clone(),
        status_hook: template.status_hook,
    }
}

/// Built-in templates first, then the user's own in their order.
pub fn all(custom: &[AgentTemplate]) -> Vec<TemplateDef> {
    builtins().into_iter().chain(custom.iter().map(from_custom)).collect()
}

pub fn find(custom: &[AgentTemplate], id: &str) -> CoreResult<TemplateDef> {
    all(custom)
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| CoreError::not_allowed("This agent template was not found. Choose another one or add it under Settings › Coding agents."))
}

/// The first bypass switch an argument list contains.
pub fn has_bypass(args: &[String]) -> Option<&'static str> {
    args.iter().find_map(|arg| {
        let lower = arg.to_lowercase();
        FORBIDDEN_FLAGS.into_iter().find(|flag| lower.contains(&flag.to_lowercase()))
    })
}

fn check_args(name: &str, args: &[String]) -> CoreResult<()> {
    if let Some(flag) = has_bypass(args) {
        return Err(CoreError::not_allowed(format!("The template “{name}” contains “{flag}”. Forkyard never starts agents with switches that lift their safety limits.")));
    }
    for arg in args {
        if arg.contains('\0') || arg.chars().count() > MAX_ARG_CHARS {
            return Err(CoreError::not_allowed(format!("An argument of the template “{name}” is invalid (NUL character or longer than {MAX_ARG_CHARS} characters).")));
        }
        let mut rest = arg.as_str();
        while let Some(start) = rest.find("${") {
            let tail = &rest[start..];
            let end = tail.find('}').map(|i| i + 1).unwrap_or(tail.len());
            let placeholder = &tail[..end];
            if !PLACEHOLDERS.contains(&placeholder) {
                return Err(CoreError::not_allowed(format!(
                    "The template “{name}” uses the unknown placeholder “{placeholder}”. Known: {}.",
                    PLACEHOLDERS.join(", ")
                )));
            }
            rest = &tail[end..];
        }
    }
    Ok(())
}

/// Checks the user's own templates and returns them trimmed. Errors: `not_allowed` with the reason.
pub fn validate_custom(templates: &[AgentTemplate]) -> CoreResult<Vec<AgentTemplate>> {
    if templates.len() > MAX_CUSTOM_TEMPLATES {
        return Err(CoreError::not_allowed(format!("At most {MAX_CUSTOM_TEMPLATES} own agent templates are possible.")));
    }
    let mut out: Vec<AgentTemplate> = Vec::with_capacity(templates.len());
    for template in templates {
        let mut t = template.clone();
        t.name = t.name.trim().to_string();
        t.program = t.program.trim().to_string();
        if !t.id.starts_with(CUSTOM_PREFIX) || t.id.len() == CUSTOM_PREFIX.len() || t.id.chars().any(char::is_whitespace) {
            return Err(CoreError::not_allowed("The ID of an own agent template must start with “custom:”."));
        }
        if out.iter().any(|other| other.id == t.id) {
            return Err(CoreError::not_allowed(format!("Two agent templates have the ID “{}”.", t.id)));
        }
        if t.name.is_empty() || t.name.chars().count() > MAX_NAME_CHARS {
            return Err(CoreError::not_allowed(format!("Give the agent template a name (at most {MAX_NAME_CHARS} characters).")));
        }
        if t.program.is_empty() || t.program.starts_with('-') || t.program.chars().any(char::is_control) {
            return Err(CoreError::not_allowed(format!("The template “{}” needs a program: a name on the PATH or a full path.", t.name)));
        }
        check_args(&t.name, &t.args)?;
        check_args(&t.name, t.unattended_args.as_deref().unwrap_or_default())?;
        check_args(&t.name, t.resume_args.as_deref().unwrap_or_default())?;
        out.push(t);
    }
    Ok(out)
}

/// First `x.y.z` in a version text (`codex-cli 0.162.0`, `2.1.301 (Claude Code)`).
pub fn parse_version(text: &str) -> Option<semver::Version> {
    text.split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .filter(|part| part.matches('.').count() >= 2)
        .find_map(|part| {
            let mut numbers = part.split('.').filter(|n| !n.is_empty()).map(|n| n.parse::<u64>().ok());
            let (major, minor, patch) = (numbers.next()??, numbers.next()??, numbers.next()??);
            Some(semver::Version::new(major, minor, patch))
        })
}

/// Why “without prompts” is not available for this template; `None` = available.
pub fn unattended_blocked(def: &TemplateDef, version: Option<&str>) -> Option<String> {
    match def.kind {
        AgentTemplateKind::Claude | AgentTemplateKind::Codex => None,
        AgentTemplateKind::Opencode => {
            let (major, minor, patch) = OPENCODE_MIN_UNATTENDED;
            let needed = semver::Version::new(major, minor, patch);
            match version.and_then(parse_version) {
                Some(found) if found >= needed => None,
                _ => Some(format!(
                    "This opencode version doesn't know the setting that keeps the agent inside its worktree (needs {major}.{minor} or newer)."
                )),
            }
        }
        AgentTemplateKind::Custom => match &def.unattended_args {
            Some(_) => None,
            None => Some("This template has no arguments for “without prompts” (Settings › Coding agents).".into()),
        },
    }
}

/// What “without prompts” does not cover on this system.
pub fn unattended_note(def: &TemplateDef, windows: bool) -> Option<String> {
    (def.kind == AgentTemplateKind::Claude && windows)
        .then(|| "On Windows, Claude Code still asks before running commands; only file edits are accepted without asking.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn custom(id: &str, name: &str, program: &str, args: &[&str]) -> AgentTemplate {
        AgentTemplate {
            id: id.into(),
            name: name.into(),
            program: program.into(),
            args: args.iter().map(|a| a.to_string()).collect(),
            unattended_args: None,
            resume_args: None,
            status_hook: false,
        }
    }

    #[test]
    fn built_in_templates_and_lookup() {
        let ids: Vec<String> = builtins().into_iter().map(|t| t.id).collect();
        assert_eq!(ids, vec!["claude", "codex", "opencode"]);
        let programs: Vec<String> = builtins().into_iter().map(|t| t.program).collect();
        assert_eq!(programs, vec!["claude", "codex", "opencode"]);
        // Claude Code and Codex report their status through the hook; opencode is guessed.
        let hooks: Vec<bool> = builtins().into_iter().map(|t| t.status_hook).collect();
        assert_eq!(hooks, vec![true, true, false]);
        let mine = vec![custom("custom:1", "Aider", "aider", &["--message-file", "${taskFile}"])];
        let all_ids: Vec<String> = all(&mine).into_iter().map(|t| t.id).collect();
        assert_eq!(all_ids, vec!["claude", "codex", "opencode", "custom:1"]);
        assert_eq!(find(&mine, "custom:1").unwrap().kind, AgentTemplateKind::Custom);
        assert_eq!(find(&mine, "codex").unwrap().kind, AgentTemplateKind::Codex);
        let err = find(&mine, "custom:2").unwrap_err();
        assert_eq!(err.code, crate::ErrorCode::NotAllowed);
        assert!(err.message.contains("template"), "{}", err.message);
    }

    #[test]
    fn own_templates_are_checked_and_never_carry_bypass_flags() {
        let ok = validate_custom(&[custom("custom:a", "  Mein Agent ", " mein-agent ", &["--task", "${taskFile}", "--cwd=${worktree}"])]).unwrap();
        assert_eq!((ok[0].name.as_str(), ok[0].program.as_str()), ("Mein Agent", "mein-agent"), "trimmed");

        let refused = |list: Vec<AgentTemplate>| validate_custom(&list).unwrap_err();
        for flag in FORBIDDEN_FLAGS {
            let mut bad = custom("custom:a", "A", "a", &[]);
            bad.unattended_args = Some(vec![flag.to_string()]);
            let err = refused(vec![bad]);
            assert_eq!(err.code, crate::ErrorCode::NotAllowed);
            assert!(err.message.contains(flag), "{flag}: {}", err.message);
            // Also inside a longer argument, in args and resume arguments, in any letter case.
            let err = refused(vec![custom("custom:a", "A", "a", &[&format!("--permission-mode={}", flag.to_uppercase())])]);
            assert!(err.message.contains(flag), "{}", err.message);
            let mut resume = custom("custom:a", "A", "a", &[]);
            resume.resume_args = Some(vec!["--continue".into(), flag.into()]);
            assert_eq!(refused(vec![resume]).code, crate::ErrorCode::NotAllowed);
        }
        assert!(refused(vec![custom("custom:a", "A", "a", &["${home}"])]).message.contains("${home}"));
        assert_eq!(refused(vec![custom("claude", "A", "a", &[])]).code, crate::ErrorCode::NotAllowed, "ids of own templates start with custom:");
        assert_eq!(refused(vec![custom("custom:a", "A", "a", &[]), custom("custom:a", "B", "b", &[])]).code, crate::ErrorCode::NotAllowed);
        assert_eq!(refused(vec![custom("custom:a", "   ", "a", &[])]).code, crate::ErrorCode::NotAllowed);
        assert_eq!(refused(vec![custom("custom:a", "A", "", &[])]).code, crate::ErrorCode::NotAllowed);
        assert_eq!(refused(vec![custom("custom:a", "A", "--evil", &[])]).code, crate::ErrorCode::NotAllowed);
        assert_eq!(refused(vec![custom("custom:a", "A", "a\nb", &[])]).code, crate::ErrorCode::NotAllowed);
        assert_eq!(refused(vec![custom("custom:a", "A", "a", &["mit\0null"])]).code, crate::ErrorCode::NotAllowed);
        let many: Vec<AgentTemplate> = (0..=MAX_CUSTOM_TEMPLATES).map(|n| custom(&format!("custom:{n}"), "A", "a", &[])).collect();
        assert_eq!(refused(many).code, crate::ErrorCode::NotAllowed);
        assert_eq!(has_bypass(&["--model".into(), "x".into()]), None);
    }

    #[test]
    fn without_prompts_needs_a_safe_switch() {
        let claude = find(&[], CLAUDE).unwrap();
        let codex = find(&[], CODEX).unwrap();
        let opencode = find(&[], OPENCODE).unwrap();
        assert_eq!(unattended_blocked(&claude, Some("2.1.301")), None);
        assert_eq!(unattended_blocked(&codex, None), None);
        assert_eq!(unattended_blocked(&opencode, Some("1.17.15")), None);
        assert_eq!(unattended_blocked(&opencode, Some("opencode v1.18.0")), None);
        assert!(unattended_blocked(&opencode, Some("1.16.9")).unwrap().contains("1.17"));
        assert!(unattended_blocked(&opencode, None).is_some(), "unknown version: switch off");
        let plain = TemplateDef { unattended_args: None, ..from_custom(&custom("custom:a", "A", "a", &[])) };
        assert!(unattended_blocked(&plain, None).is_some());
        let with_args = TemplateDef { unattended_args: Some(vec!["--yes".into()]), ..plain };
        assert_eq!(unattended_blocked(&with_args, None), None);
        assert!(unattended_note(&claude, true).unwrap().contains("Windows"));
        assert_eq!(unattended_note(&claude, false), None);
        assert_eq!(unattended_note(&codex, true), None);
        assert_eq!(parse_version("codex-cli 0.162.0").map(|v| v.to_string()), Some("0.162.0".into()));
        assert_eq!(parse_version("2.1.301 (Claude Code)").map(|v| v.to_string()), Some("2.1.301".into()));
        assert_eq!(parse_version("unbekannt"), None);
    }
}
