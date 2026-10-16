//! "Git in plain language" (spec Paket 5): the request the provider gets and the answer it gives.
//!
//! The user's sentence is the only instruction; it goes into the system text. Everything about the
//! repository (state, branches, remotes, tags, recent commits) is data between the delimiters of
//! `ai::prompt`, filtered by `redact_for_ai`, because branch names and commit messages can carry text
//! that tries to steer the model (Grundregel 3). The answer is only data: `parse_steps` turns it into
//! `PlanStep`s, and nothing runs before `plan_check` and the user's confirmation.

use serde_json::Value;

use crate::ai::plan_check::{MAX_STEPS, PLAN_TOO_LONG};
use crate::ai::prompt::{self, Prompt, Section};
use crate::ai::{context, plan_commands};
use crate::app::Core;
use crate::commands::{remotes, status};
use crate::error::{CoreError, CoreResult};
use crate::model::{Head, PlanCommand, PlanStep};
use crate::{undo, util};

pub const MAX_REQUEST_CHARS: usize = 500;
const MAX_WHY_CHARS: usize = 300;
const MAX_NOTE_CHARS: usize = 500;
const MAX_LINE_CHARS: usize = 200;
const BRANCHES: usize = 50;
const REMOTE_BRANCHES: usize = 50;
const TAGS: usize = 20;
const COMMITS: usize = 15;

/// One line, at most `MAX_REQUEST_CHARS` characters; empty or longer → `not_allowed`.
pub fn clean_request(text: &str) -> CoreResult<String> {
    let spaced: String = text.chars().map(|c| if c.is_control() || c.is_whitespace() { ' ' } else { c }).collect();
    let cleaned = spaced.split(' ').filter(|word| !word.is_empty()).collect::<Vec<_>>().join(" ");
    if cleaned.is_empty() {
        return Err(CoreError::not_allowed("Describe what Git should do."));
    }
    if cleaned.chars().count() > MAX_REQUEST_CHARS {
        return Err(CoreError::not_allowed(format!("The request is longer than {MAX_REQUEST_CHARS} characters. Ask for less at once.")));
    }
    Ok(cleaned)
}

pub fn instruction(request: &str) -> String {
    format!(
        "Turn the user's request into a plan of Forkyard steps.\n\
         Use only these commands, each with exactly its arguments; set every argument a command does not have to null:\n{commands}\n\
         Rules: at most {MAX_STEPS} steps, in the order they must run. Use only branch, tag, remote and commit names that appear \
         in the repository data, unless a step creates them; name commits by the short SHAs shown. A push with force always uses \
         a lease; never plan a force push the user did not ask for. If the request needs anything else (settings, repository \
         trust, custom commands, the terminal, coding agents, cleaning up the repository, gc or prune), return no steps and say \
         why in note. For every step, why says in one short sentence why it is needed.\n\
         The user's request, in their own words (the only instruction to follow): «{request}»",
        commands = plan_commands::prompt_reference(),
    )
}

fn short(sha: &str) -> &str {
    &sha[..sha.len().min(7)]
}

async fn refs_lines(core: &Core, repo_id: &str, prefix: &str, count: usize, format: &str) -> CoreResult<Vec<String>> {
    let sort = if prefix == "refs/tags" { "--sort=-creatordate" } else { "--sort=-committerdate" };
    let out = core
        .git_for(repo_id)?
        .args(["for-each-ref", "--sort=refname", sort, &format!("--count={count}"), &format!("--format={format}"), prefix])
        .read_only()
        .no_log()
        .run()
        .await?;
    let remote = prefix == "refs/remotes";
    Ok(out
        .stdout_lines()
        .into_iter()
        .filter_map(|line| {
            let fields: Vec<String> = line.split(|b| *b == 0).map(util::decode_lossy).collect();
            // `origin/HEAD` is a symbolic ref: its third field names the target.
            if remote && fields.get(2).is_some_and(|symref| !symref.is_empty()) {
                return None;
            }
            let shown: Vec<&str> = fields.iter().take(if remote { 2 } else { 3 }).map(String::as_str).filter(|field| !field.is_empty()).collect();
            (!shown.is_empty()).then(|| shown.join(" "))
        })
        .collect())
}

async fn recent_commits(core: &Core, repo_id: &str) -> CoreResult<Vec<String>> {
    let out = core.git_for(repo_id)?.args(["log", "-z", "--no-color", &format!("-n{COMMITS}"), "--format=%h %s", "HEAD", "--"]).read_only().no_log().run().await?;
    Ok(util::split_z(&out.stdout).map(util::decode_lossy).filter(|line| !line.is_empty()).collect())
}

/// What the model learns about the repository – names, not file contents. Redacted.
pub async fn sections(core: &Core, repo_id: &str, secrets: &[String]) -> CoreResult<Vec<Section>> {
    let current = status::read_status(core, repo_id).await?;
    let mut state = vec![match &current.head {
        Head::Branch { branch, sha } => format!("HEAD: branch {branch} at {}", short(sha)),
        Head::Detached { sha } => format!("HEAD: detached at {}", short(sha)),
        Head::Unborn { branch } => format!("HEAD: branch {branch}, no commit yet"),
    }];
    if let Some(upstream) = &current.upstream {
        let gone = if upstream.gone { ", gone on the remote" } else { "" };
        state.push(format!("Upstream: {} ({} ahead, {} behind{gone})", upstream.name, upstream.ahead, upstream.behind));
    }
    state.push(format!("Changes: {} staged, {} not staged, {} conflicted", current.staged.len(), current.unstaged.len(), current.conflicted.len()));
    if let Some(operation) = &current.operation {
        state.push(format!("Operation in progress: {}", format!("{:?}", operation.kind).to_lowercase()));
    }
    let local = refs_lines(core, repo_id, "refs/heads", BRANCHES, "%(refname:short)%00%(objectname:short)%00%(upstream:short)").await?;
    let remote = refs_lines(core, repo_id, "refs/remotes", REMOTE_BRANCHES, "%(refname:short)%00%(objectname:short)%00%(symref)").await?;
    let tags = refs_lines(core, repo_id, "refs/tags", TAGS, "%(refname:short)%00%(objectname:short)").await?;
    let names = remotes::remote_names(core, repo_id).await?;
    let commits = if matches!(current.head, Head::Unborn { .. }) { Vec::new() } else { recent_commits(core, repo_id).await? };
    let body = |lines: Vec<String>| -> String {
        let text = if lines.is_empty() { "(none)".to_string() } else { lines.iter().map(|line| undo::shorten(line, MAX_LINE_CHARS)).collect::<Vec<_>>().join("\n") };
        context::redact_for_ai(&text, secrets)
    };
    Ok(vec![
        Section { title: "Repository state".into(), body: body(state) },
        Section { title: "Local branches (name, commit, upstream; newest first)".into(), body: body(local) },
        Section { title: "Remotes".into(), body: body(names) },
        Section { title: "Remote branches (name, commit; newest first)".into(), body: body(remote) },
        Section { title: "Tags (name, commit; newest first)".into(), body: body(tags) },
        Section { title: "Recent commits on HEAD (short SHA, subject)".into(), body: body(commits) },
    ])
}

/// Drops the last line of the longest section until everything fits.
fn fit(sections: &mut [Section], max_chars: usize) {
    loop {
        let total: usize = sections.iter().map(|section| section.body.chars().count()).sum();
        if total <= max_chars {
            return;
        }
        let Some(longest) = sections.iter_mut().filter(|section| section.body.contains('\n')).max_by_key(|section| section.body.chars().count()) else {
            return;
        };
        if let Some(cut) = longest.body.rfind('\n') {
            longest.body.truncate(cut);
        }
    }
}

/// The prompt of `AiInput::Plan` (`ai_preview`) and of `ai_plan` – both pass the budget and the
/// known secrets of Paket 3.1's `request_frame`, so the texts match (1a's gate is bound to them).
pub async fn build_prompt(core: &Core, repo_id: &str, text: &str, locale: &str, secrets: &[String], budget_tokens: u64) -> CoreResult<Prompt> {
    let request = context::redact_for_ai(&clean_request(text)?, secrets);
    let instruction = instruction(&request);
    let mut sections = sections(core, repo_id, secrets).await?;
    let budget_chars = (budget_tokens as f64 * context::CHARS_PER_TOKEN) as usize;
    fit(&mut sections, budget_chars.saturating_sub(instruction.chars().count() + 600));
    Ok(prompt::build(&instruction, locale, &sections))
}

fn one_line(text: &str, max: usize) -> String {
    let flat: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    undo::shorten(flat.trim(), max)
}

/// The steps of a schema-checked answer. Null arguments of other commands are dropped; non-null
/// ones stay, so the check marks the step invalid ("unknown argument").
pub fn parse_steps(value: &Value) -> CoreResult<(Vec<PlanStep>, Option<String>)> {
    let items = value.get("steps").and_then(Value::as_array).ok_or_else(|| CoreError::ai_invalid_answer("the answer has no steps"))?;
    if items.len() > MAX_STEPS {
        return Err(CoreError::ai_invalid_answer(PLAN_TOO_LONG));
    }
    let mut steps = Vec::with_capacity(items.len());
    for item in items {
        let command: PlanCommand = serde_json::from_value(item.get("command").cloned().unwrap_or(Value::Null))
            .map_err(|_| CoreError::ai_invalid_answer("a step names a command outside the allow list"))?;
        let own = command.fields();
        let args = item
            .get("args")
            .and_then(Value::as_object)
            .map(|args| args.iter().filter(|(name, value)| own.iter().any(|f| f.name == name.as_str()) || !value.is_null()).map(|(name, value)| (name.clone(), value.clone())).collect())
            .unwrap_or_default();
        let why = one_line(item.get("why").and_then(Value::as_str).unwrap_or(""), MAX_WHY_CHARS);
        steps.push(PlanStep { command, args, why });
    }
    let note = value.get("note").and_then(Value::as_str).map(|note| one_line(note, MAX_NOTE_CHARS)).filter(|note| !note.is_empty());
    Ok((steps, note))
}
